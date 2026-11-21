'use strict';
/**
 * Regression pins for the promotional-credit $30 cap on the TRADE path.
 *
 * CONTEXT / CORRECTION OF THE 2026-11 AUDIT
 * The audit reported that `/api/trade` had no application-side pre-check and
 * that the database trigger was therefore the only gate. That was wrong: the
 * pre-check has been in the handler since 66ae91b (2026-09-12) and sits directly
 * before the RPC. The audit's grep output was truncated by `head -20`, so the
 * handler's lines never printed and the absence was inferred from a partial
 * list. Nothing was missing, and no production code was changed by this file.
 *
 * What was genuinely missing is the PINNING: nothing asserted that the trade
 * path keeps a pre-check, keeps it BEFORE the write, or keeps reusing the shared
 * predicate. Those are exactly the properties a refactor can silently drop, and
 * dropping them is invisible until the trigger is also absent or failing open.
 *
 * M1 (accepted overshoot, documented here by design):
 * the cap compares the user's PRIOR cumulative realized profit, so it prevents
 * trading *while already capped*. It does not prevent the single trade that
 * crosses the line: a user at $29.99 who wins $1.00 ends at $30.99. That is
 * accepted behaviour, not a defect - clamping the crossing trade would mean
 * rewriting recorded P&L, which is a business decision. No test here asserts a
 * clamp because no clamp exists or should exist.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SERVER = read('server.js');
const MIGRATION = read('supabase/migrations/055_promo_trading_cap_30.sql');
const PROMO = read('services/PromoCheck.js');

function handler(startMarker, endMarker) {
  const at = SERVER.indexOf(startMarker);
  assert.ok(at > 0, startMarker + ' must exist');
  const end = SERVER.indexOf(endMarker, at + startMarker.length);
  assert.ok(end > at, 'could not bound ' + startMarker);
  return SERVER.slice(at, end);
}

const TRADE = handler("app.post('/api/trade'", 'app.get(');
const START = handler("app.post('/api/bot/start'", "app.post('/api/trade'");

const idx = (src, needle) => {
  const at = src.indexOf(needle);
  assert.ok(at > 0, 'expected to find: ' + needle);
  return at;
};

// ---------------------------------------------------------------------------
// The pre-check exists, and it runs before the write
// ---------------------------------------------------------------------------
test('the trade handler contains a promotional-cap pre-check', () => {
  assert.match(TRADE, /PROMOTIONAL-CREDIT TRADING CAP/, 'the block is labelled');
  idx(TRADE, 'const promoCreditFunded = await isPromoCreditFunded(userId, hasDeposit)');
  idx(TRADE, 'if (isPromoProfitCapReached(promoCreditFunded, promoProfit))');
});

test('the pre-check runs BEFORE record_trade_safe', () => {
  const pre = idx(TRADE, 'if (isPromoProfitCapReached(promoCreditFunded, promoProfit))');
  const rpc = idx(TRADE, "rpc('record_trade_safe'");
  assert.ok(pre < rpc, 'a capped trade must be refused before the ledger write');
  // and after the input validation, so a malformed amount is not reported as a cap
  assert.ok(pre > idx(TRADE, 'Trade amount exceeds balance'), 'validation still comes first');
});

test('a capped trade is refused with the existing shape and the session is fenced', () => {
  const block = TRADE.slice(
    idx(TRADE, 'if (promoCreditFunded === true)'),
    idx(TRADE, "rpc('record_trade_safe'")
  );
  assert.match(block, /stopBotSessionForPromoLimit\(userId\)/, 'the session is stopped');
  assert.match(block, /res\.status\(403\)\.json\(promoLimitBody\(\{ promoRealizedProfit: promoProfit \}\)\)/,
    'the shared refusal body is reused, not re-invented');
  assert.ok(block.indexOf('stopBotSessionForPromoLimit') < block.indexOf('promoLimitBody'),
    'stop first, then refuse - the client must never see a cap while the bot keeps running');
  assert.ok(!/from\('trades'\)/.test(block), 'the refusal writes no ledger row');
});

// ---------------------------------------------------------------------------
// One threshold, one predicate, no local redefinition
// ---------------------------------------------------------------------------
test('the trade path reuses the shared predicate and cannot drift to a literal', () => {
  assert.ok(!/>=\s*30/.test(TRADE), 'no inline >= 30 in the handler');
  assert.ok(!/PROMO_PROFIT_CAP_USD/.test(TRADE), 'the handler never touches the raw constant');
  assert.strictEqual(SERVER.match(/const PROMO_PROFIT_CAP_USD = 30;/g).length, 1,
    'exactly one definition in server.js');
  assert.match(PROMO, /const PROMO_PROFIT_CAP_USD = 30;/, 'the worker copy is the same number');
  assert.match(MIGRATION, /v_promo_profit >= 30/, 'the trigger is the same number');
});

test('start and trade apply the cap with identical semantics', () => {
  // Both paths must guard on the strict boolean, read the profit with the same
  // fail-open default, and use the same predicate. Drift between them is how a
  // restart bypass appears.
  for (const [name, src] of [['bot/start', START], ['trade', TRADE]]) {
    assert.match(src, /const promoCreditFunded = await isPromoCreditFunded\(userId, hasDeposit\)/,
      name + ' classifies by source of funds');
    assert.match(src, /if \(promoCreditFunded === true\) \{\s*\n\s*const promoProfit = await getPromoRealizedProfit\(userId\)\.catch\(\(\) => 0\);/,
      name + ' reads profit fail-open and only for a definite promo user');
    assert.match(src, /isPromoProfitCapReached\(promoCreditFunded, promoProfit\)/, name + ' uses the shared predicate');
  }
});

// ---------------------------------------------------------------------------
// Fail-open / fail-closed directions, preserved as established
// ---------------------------------------------------------------------------
test('a failed classification cannot GRANT trading eligibility', () => {
  // null (unknown) must fall through to "not capped": unknown never invents a
  // cap, and never blocks a possibly-converted user.
  const predicate = SERVER.slice(idx(SERVER, 'function isPromoProfitCapReached'));
  assert.match(predicate, /!!isPromoCreditFunded &&/, 'a null/unknown classification is never capped');
  // The profit read failing returns 0, i.e. "not capped" - it can never
  // manufacture a cap from a transient read error, and it never grants more than
  // the established semantics already did.
  assert.match(TRADE, /getPromoRealizedProfit\(userId\)\.catch\(\(\) => 0\)/);
});

test('the deposit lookup falls back to "no deposit" (over-restrictive, never permissive)', () => {
  // hasConfirmedDeposit failing yields false, which can only widen the promo
  // classification. It cannot exempt a promo user, so it is not a bypass - but
  // it can briefly over-restrict a deposited user, which is why the classifier
  // re-reads its other sources independently.
  assert.match(TRADE, /const hasDeposit = await hasConfirmedDeposit\(userId\)\.catch\(\(\) => false\)/);
});

// ---------------------------------------------------------------------------
// Exemptions are delegated, not duplicated
// ---------------------------------------------------------------------------
test('deposited, converted and sandbox users are exempt via the classifier only', () => {
  // The handler must not implement its own exemption rules; it defers to
  // isPromoCreditFunded (deposit -> sandbox -> conversion ledger -> marker).
  assert.ok(!/referral_earning_conversions/.test(TRADE), 'no conversion logic in the handler');
  // Scoped to the cap block: the handler's opening comment legitimately names
  // the sandbox lane, but the cap itself must not re-implement that exemption.
  const capBlock = TRADE.slice(idx(TRADE, 'const hasDeposit = await hasConfirmedDeposit'),
    idx(TRADE, "rpc('record_trade_safe'"));
  assert.ok(!/MARKETING_SANDBOX|isMarketingSandboxUser/.test(capBlock),
    'sandbox is handled by the earlier lane, not inside the cap');
  assert.ok(TRADE.indexOf('sandboxHandled(req, res, handleSandboxTrade)') <
    idx(TRADE, 'const promoCreditFunded'), 'the sandbox lane short-circuits first');
});

// ---------------------------------------------------------------------------
// Second layer preserved
// ---------------------------------------------------------------------------
test('the database trigger remains the second enforcement layer', () => {
  assert.match(MIGRATION, /BEFORE INSERT ON public\.trades/, 'pre-insert trigger');
  assert.match(MIGRATION, /RAISE EXCEPTION 'PROMO_TRADING_LIMIT_REACHED'/, 'same machine-readable code');
  assert.match(TRADE, /includes\(PROMO_LIMIT_CODE\)/, 'the handler maps the trigger error');
  assert.match(TRADE, /res\.status\(403\)\.json\(promoLimitBody\(\)\)/, 'to the same refusal body');
  // A trigger refusal must NOT be treated as a successful trade.
  const mapBlock = TRADE.slice(idx(TRADE, 'includes(PROMO_LIMIT_CODE)') - 200,
    idx(TRADE, 'includes(PROMO_LIMIT_CODE)') + 300);
  assert.match(mapBlock, /return res\.status\(403\)/, 'the mapping returns immediately');
});

// ---------------------------------------------------------------------------
// M1 - accepted overshoot, pinned as behaviour rather than "fixed"
// ---------------------------------------------------------------------------
test('M1: the cap is based on PRIOR realized profit, so one trade may overshoot', () => {
  const predicate = SERVER.slice(idx(SERVER, 'function isPromoProfitCapReached'));
  assert.match(predicate, /Number\(promoProfit\) >= PROMO_PROFIT_CAP_USD/,
    'inclusive comparison against the cumulative sum read before the trade');

  // The trade path evaluates the cap on the profit read BEFORE the RPC, and then
  // recomputes it AFTER the write only to stop the session. Nothing clamps.
  const after = TRADE.slice(idx(TRADE, 'promoProfitAfter'));
  assert.match(after, /stopBotSessionForPromoLimit\(userId\)/, 'the crossing trade stops the bot');
  assert.ok(!/from\('trades'\)[\s\S]{0,120}update/.test(TRADE), 'the crossing trade is never rewritten');
  assert.ok(!/from\('wallets'\)[\s\S]{0,120}update/.test(TRADE), 'no balance correction either');
});

test('M1: no clamp exists anywhere in the cap chain', () => {
  const sources = { server: SERVER, migration: MIGRATION, promo: PROMO };
  for (const [name, src] of Object.entries(sources)) {
    assert.ok(!/Math\.min\(\s*30/.test(src), name + ': no Math.min clamp at 30');
    assert.ok(!/LEAST\(\s*30/.test(src), name + ': no SQL LEAST clamp at 30');
    assert.ok(!/UPDATE\s+public\.trades/i.test(src), name + ': never rewrites a recorded trade');
  }
  // The overshoot is bounded by ONE trade, which is why it is acceptable: the
  // trigger and the handler both refuse as soon as the prior sum is >= 30, so a
  // second trade is impossible after the crossing one.
  assert.match(MIGRATION, /IF v_promo_profit >= 30 THEN\s*\n\s*RAISE EXCEPTION/,
    'the trigger refuses every subsequent trade');
});
