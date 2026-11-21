'use strict';
/**
 * Single-mode server guards.
 *
 * Replaces the retired tests/mode_persistence.test.js coverage (no persisted
 * mode, no mode-driven session lifecycle) and pins the security properties of
 * the /api/bot/start change: the route now HARD-CODES Live, so no request value
 * can reach a trading session before the activation, funding, promotional-cap,
 * pause and emergency-stop gates have all passed.
 *
 * Also pins the $30 promotional-credit cap across every enforcement point
 * (server, worker rule table, migration 055 trigger) so they cannot drift.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SERVER = read('server.js');
const INDEX = read('public/index.html');
const PROMO = read('services/PromoCheck.js');
const WORKER = read('services/TradingWorker.js');
const MIGRATION = read('supabase/migrations/055_promo_trading_cap_30.sql');

function block(startMarker, { endMarker = null, max = 12000 } = {}) {
  const at = SERVER.indexOf(startMarker);
  assert.ok(at > 0, startMarker + ' must exist');
  if (endMarker) {
    const end = SERVER.indexOf(endMarker, at + startMarker.length);
    assert.ok(end > at, 'end marker for ' + startMarker);
    return SERVER.slice(at, end);
  }
  return SERVER.slice(at, at + max);
}

function fnIn(src, name) {
  const at = src.indexOf('function ' + name);
  assert.ok(at > 0, name + ' must exist');
  let depth = 0;
  let started = false;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') { depth++; started = true; }
    else if (src[i] === '}' && --depth === 0 && started) return src.slice(at, i + 1);
  }
  throw new Error('unterminated ' + name);
}

const START = block("app.post('/api/bot/start'", { endMarker: 'app.post(' });

// ---------------------------------------------------------------------------
// 1. No request value can produce a trading session
// ---------------------------------------------------------------------------
test('1. the start route is authenticated, sandbox-routed and hard-coded to live', () => {
  assert.match(START, /app\.post\('\/api\/bot\/start', authMiddleware,/, 'authentication is the first argument');
  const sandboxAt = START.indexOf('sandboxHandled(req, res, handleSandboxBotStart)');
  const modeAt = START.indexOf("const mode = 'live';");
  assert.ok(sandboxAt > 0 && modeAt > sandboxAt, 'the sandbox lane is decided before anything else');

  // The removed bypass: nothing on this route may read a mode from the request.
  assert.ok(!/req\.body[^\n]*mode/.test(START), 'req.body.mode must never be read');
  assert.ok(!/req\.query[^\n]*mode/.test(START), 'req.query.mode must never be read');
  assert.ok(!/=== 'demo'/.test(START), 'no demo comparison survives');
  assert.strictEqual(START.match(/const mode = 'live';/g).length, 1, 'one declared mode');
});

test('2. every gate runs before the session write', () => {
  const order = [
    'getLiveModeEligibility(userId)',
    'getWallet(userId)',
    'hasConfirmedDeposit(userId)',
    'isPromoCreditFunded(userId, hasDeposit)',
    'isProfitPausedForUser(userId)',
    'getWorkerControl()',
  ];
  const positions = order.map((needle) => {
    const at = START.indexOf(needle);
    assert.ok(at > 0, needle + ' must gate the start');
    return at;
  });
  positions.forEach((p, i) => {
    if (i > 0) assert.ok(p > positions[i - 1], order[i] + ' must run after ' + order[i - 1]);
  });

  const upsertAt = START.indexOf("from('bot_sessions')");
  assert.ok(upsertAt > positions[positions.length - 1], 'the session is written last');
});

test('3. each refusal is explicit and carries a machine-readable code', () => {
  const refusal = block('function sendLiveModeRefusal', { max: 1200 });
  assert.match(refusal, /activationRequired|liveModeRequired/, 'activation refusals are coded');
  assert.match(START, /code: 'LIVE_FUNDING_REQUIRED'/, 'funding refusal is coded');
  assert.match(START, /promoLimitBody\(\{ promoRealizedProfit/, 'the promo cap reuses its body');
  assert.match(START, /profitPauseBody\(\)/, 'the profit pause reuses its body');
  assert.match(START, /code: 'TRADING_PAUSED'/, 'the emergency stop is coded');
  // Balances are read from the wallet, never from the request.
  assert.ok(!/req\.body[^\n]*balance/i.test(START), 'no balance is accepted from the client');
});

// ---------------------------------------------------------------------------
// 4. The $30 promotional cap is one number everywhere
// ---------------------------------------------------------------------------
test('4. server, worker rule table and migration agree on $30, inclusive', () => {
  assert.match(SERVER, /const PROMO_PROFIT_CAP_USD = 30;/, 'server constant');
  assert.match(PROMO, /const PROMO_PROFIT_CAP_USD = 30;/, 'worker-enforced rule table');
  assert.match(MIGRATION, />=\s*30/, 'the trigger locks at exactly 30.00 or more');

  const predicate = fnIn(SERVER, 'isPromoProfitCapReached');
  assert.match(predicate, />= PROMO_PROFIT_CAP_USD/, 'inclusive comparison');
  const workerPredicate = fnIn(PROMO, 'isPromoProfitCapReached');
  assert.match(workerPredicate, />= PROMO_PROFIT_CAP_USD/, 'worker comparison matches');

  // The cap applies to the promotional-credit classification only.
  const startGate = START.slice(START.indexOf('promoCreditFunded === true'));
  assert.match(startGate, /isPromoProfitCapReached\(promoCreditFunded, promoProfit\)/);
  assert.ok(!/hasConfirmedDeposit\(userId\)[\s\S]{0,80}PROFIT_CAP/.test(START),
    'a deposited user is never capped by the promo rule');
});

test('5. reaching the cap stops the session, so a restart cannot bypass it', () => {
  const gate = START.slice(START.indexOf('promoCreditFunded === true'));
  const stopAt = gate.indexOf('stopBotSessionForPromoLimit(userId)');
  const returnAt = gate.indexOf('promoLimitBody');
  assert.ok(stopAt > 0, 'the session is fenced stopped');
  assert.ok(stopAt < returnAt, 'stop happens before the refusal is returned');
  // And the trade path refuses too, using the same body.
  assert.match(SERVER, /isPromoProfitCapReached\([^)]*\)/, 'the trade path shares the predicate');
});

test('6. migration 055 supersedes 026 without touching money semantics', () => {
  assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.enforce_promo_trade_cap\(\)/);
  assert.match(MIGRATION, /SUM\(t\.amount\)/, 'the realized-P&L basis is unchanged');
  assert.match(MIGRATION, /mode\s*=\s*'live'|mode = ''live''/, 'live trades only');
  assert.match(MIGRATION, /EXCEPTION WHEN OTHERS/, 'still fails open');
  assert.match(MIGRATION, /MARKETING_SANDBOX/, 'the sandbox stays exempt');
  assert.match(MIGRATION, /RAISE EXCEPTION/, 'a stale re-apply of 026 fails loudly');
  assert.ok(!/UPDATE\s+public\.wallets|DELETE\s+FROM|INSERT\s+INTO\s+public\.trades/i.test(MIGRATION),
    'the trigger never writes money');
  // The app must not apply migrations by itself.
  assert.ok(!/055_promo_trading_cap_30/.test(SERVER), 'the server never runs the migration');
});

// ---------------------------------------------------------------------------
// 7. No mode-driven session lifecycle remains
// ---------------------------------------------------------------------------
test('7. sessions are Live-only and the client sends no mode', () => {
  assert.match(START, /mode,/, 'the session row still records the single mode');
  assert.ok(!INDEX.includes("mode: 'demo'"), 'the client never requests a demo session');
  assert.ok(!/api\/bot\/start[\s\S]{0,200}mode/.test(INDEX), 'the client start call sends no mode');
  // The worker only trades live sessions.
  assert.ok(!/mode === 'demo'/.test(WORKER), 'the worker has no demo branch');
});
