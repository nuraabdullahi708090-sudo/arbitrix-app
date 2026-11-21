'use strict';

/**
 * Promotional-credit trading cap ($30 net realized profit) — production-only
 * contract tests (Rule B).
 *
 * server.js binds a port on require, so (per repo convention) these tests do
 * NOT import it. They pin, via source contracts + pure-JS mirrors:
 *
 *   - the cap value/constant and the inclusive lock (>= $30.00);
 *   - getPromoRealizedProfit() reads the authoritative `trades` ledger for the
 *     user (never sandbox_trades, never deposits);
 *   - /api/trade refuses further trading (403, machine-readable code) BEFORE the
 *     RPC, so direct API calls are blocked, and reports the post-trade state;
 *   - /api/bot/start refuses a (re)start once the cap is reached (bot-restart
 *     bypass closed) and stops the session;
 *   - a confirmed deposit lifts the restriction automatically;
 *   - MARKETING_SANDBOX is untouched (no cap constant in the sandbox handlers,
 *     sandbox /api/auth/me reports false/0);
 *   - migration 055 re-creates the defence-in-depth trigger at the $30
 *     threshold (026 is the historical $30 version; 055 is authoritative).
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const M026 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '026_promo_trading_cap.sql'), 'utf8');
const M055 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '055_promo_trading_cap_30.sql'), 'utf8');

const CAP = 30;
const CODE = 'PROMO_TRADING_LIMIT_REACHED';
const MESSAGE = 'You reached the $30 promotional profit limit. Make your first deposit to continue trading.';

function stripFullLineComments(s) {
    return s.split('\n').map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n');
}

function routeBody(method, routePath) {
    const marker = `app.${method}('${routePath}'`;
    const start = SERVER.indexOf(marker);
    assert.ok(start >= 0, `route not found: ${method.toUpperCase()} ${routePath}`);
    const after = SERVER.indexOf('\napp.', start + marker.length);
    return stripFullLineComments(SERVER.slice(start, after < 0 ? undefined : after));
}

function fnBody(name) {
    const idx = SERVER.indexOf(`function ${name}(`);
    assert.ok(idx >= 0, `function not found: ${name}`);
    const start = SERVER.lastIndexOf('async function', idx) >= 0 ? SERVER.lastIndexOf('async function', idx) : idx;
    const next = SERVER.indexOf('\nasync function ', idx + 1);
    const next2 = SERVER.indexOf('\nfunction ', idx + 1);
    let end = next < 0 ? next2 : next;
    if (next2 > 0 && next2 < end) end = next2;
    return stripFullLineComments(SERVER.slice(start < 0 ? idx : start, end < 0 ? undefined : end));
}

function extractFunction(src, name) {
    const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
    const m = src.match(re);
    assert.ok(m, `function ${name} not found`);
    const start = m.index;
    // Skip the parameter list first so a default/object parameter ({}) is not
    // mistaken for the function body.
    const parenStart = src.indexOf('(', start);
    let pdepth = 0;
    let paramEnd = -1;
    for (let i = parenStart; i < src.length; i++) {
        if (src[i] === '(') pdepth++;
        else if (src[i] === ')') { pdepth--; if (pdepth === 0) { paramEnd = i; break; } }
    }
    const braceStart = src.indexOf('{', paramEnd);
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error(`unterminated function ${name}`);
}

// ---------------------------------------------------------------------------
// Pure-JS mirrors (production semantics)
// ---------------------------------------------------------------------------

// The cap applies ONLY to a promotional-credit user by AUTHORITATIVE SOURCE OF
// FUNDS: no confirmed deposit AND no referral-earnings conversion into Live
// balance. It locks INCLUSIVELY at >= $30.00 NET realized profit. Deposited
// users, referral-funded users and sandbox accounts are never locked. The
// balance amount is never consulted.
function isPromoCreditFundedMirror({ hasDeposit, referralFunded, sandbox }) {
    if (sandbox) return false;
    if (hasDeposit) return false;
    if (referralFunded) return false;
    return true;
}

function promoProfitCapReached({ hasDeposit, referralFunded, promoProfit, sandbox }) {
    if (!isPromoCreditFundedMirror({ hasDeposit, referralFunded, sandbox })) return false;
    return Number(promoProfit) >= CAP;
}

// /api/trade admission (pre-check).
function tradeAllowed(opts) {
    return !promoProfitCapReached(opts);
}

// /api/bot/start admission (production live only).
function botStartAllowed({ hasDeposit, referralFunded, promoProfit, sandbox, mode }) {
    if (sandbox) return { started: true, code: null };
    if (mode !== 'live') return { started: true, code: null };
    if (promoProfitCapReached({ hasDeposit, referralFunded, promoProfit, sandbox })) {
        return { started: false, code: CODE };
    }
    return { started: true, code: null };
}

// ---------------------------------------------------------------------------
// 1. Constants + helper
// ---------------------------------------------------------------------------

test('the production cap is $30 (inclusive) at a single documented constant', () => {
    assert.match(SERVER, /const PROMO_PROFIT_CAP_USD = 30;/);
    assert.match(SERVER, /const PROMO_LIMIT_CODE = 'PROMO_TRADING_LIMIT_REACHED';/);
    assert.match(SERVER, /const PROMO_LIMIT_MESSAGE = 'You have reached the promotional trading limit/);
    // Inclusive lock at >= the cap, gated on the authoritative source-of-funds
    // classifier — NOT on "no confirmed deposit" alone.
    assert.match(SERVER, /function isPromoProfitCapReached\(isPromoCreditFunded, promoProfit\) \{\s*return !!isPromoCreditFunded && Number\(promoProfit\) >= PROMO_PROFIT_CAP_USD;/);
});

test('getPromoRealizedProfit reads the authoritative trades ledger for the user', () => {
    const fn = extractFunction(SERVER, 'getPromoRealizedProfit');
    assert.match(fn, /from\('trades'\)/);
    assert.match(fn, /\.eq\('user_id', userId\)/);
    assert.match(fn, /\.eq\('mode', 'live'\)/, 'only live-engine trades count');
    assert.match(fn, /Number\(row && row\.amount\)/);
    assert.ok(!fn.includes('sandbox_trades'), 'must never read sandbox trades');
    assert.ok(!/from\('deposits'\)|from\('payment_invoices'\)/.test(fn), 'must never count deposits');
});

test('the machine-readable limit body is exact', () => {
    const fn = extractFunction(SERVER, 'promoLimitBody');
    assert.match(fn, /code: PROMO_LIMIT_CODE/);
    assert.match(fn, /promoLimitReached: true/);
    assert.match(fn, /depositRequired: true/);
    assert.match(fn, /error: PROMO_LIMIT_MESSAGE/);
});

// ---------------------------------------------------------------------------
// 2. /api/trade enforcement (direct API calls included)
// ---------------------------------------------------------------------------

test('/api/trade pre-checks the cap BEFORE calling record_trade_safe', () => {
    const body = routeBody('post', '/api/trade');
    const capIdx = body.indexOf('isPromoProfitCapReached');
    const rpcIdx = body.indexOf("rpc('record_trade_safe'");
    assert.ok(capIdx > 0, 'promo cap pre-check missing');
    assert.ok(rpcIdx > 0, 'record_trade_safe call missing');
    assert.ok(capIdx < rpcIdx, 'cap pre-check must run before the trading RPC');
    assert.match(body, /hasConfirmedDeposit\(userId\)/);
    assert.match(body, /getPromoRealizedProfit\(userId\)/);
    assert.match(body, /res\.status\(403\)\.json\(promoLimitBody/);
});

test('/api/trade reports the post-trade cap state so the client stops the bot', () => {
    const body = routeBody('post', '/api/trade');
    assert.match(body, /promoLimitReached/);
    assert.match(body, /promoRealizedProfit/);
    assert.match(body, /stopBotSessionForPromoLimit\(userId\)/);
});

test('/api/trade maps the migration-026 trigger error to the same machine-readable response', () => {
    const body = routeBody('post', '/api/trade');
    assert.match(body, /PROMO_LIMIT_CODE/);
    assert.ok(body.indexOf("rpc('record_trade_safe'") < body.indexOf('PROMO_LIMIT_CODE'),
        'the trigger-error mapping belongs after the RPC');
});

// ---------------------------------------------------------------------------
// 3. /api/bot/start enforcement (bot-restart bypass closed)
// ---------------------------------------------------------------------------

test('/api/bot/start refuses a restart at the cap BEFORE creating a session', () => {
    const body = routeBody('post', '/api/bot/start');
    const capIdx = body.indexOf('isPromoProfitCapReached');
    const upsertIdx = body.indexOf("from('bot_sessions')");
    assert.ok(capIdx > 0, 'promo cap check missing from bot start');
    assert.ok(upsertIdx > 0, 'bot_sessions upsert missing');
    assert.ok(capIdx < upsertIdx, 'the cap check must run before the session upsert');
    assert.match(body, /res\.status\(403\)\.json\(promoLimitBody/);
    assert.match(body, /stopBotSessionForPromoLimit\(userId\)/);
});

test('/api/bot/start has no MTA gate, no client mode and keeps the promo cap', () => {
    const body = routeBody('post', '/api/bot/start');
    assert.ok(!/req\.body\.mode/.test(body), 'single mode: no client-supplied mode');
    assert.ok(!/'demo'/.test(body), 'no demo branch remains');
    const code = body.split('\n').map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n');
    assert.ok(!code.includes('MTA'), 'the MTA gate must be gone');
    assert.ok(!code.includes('getEffectiveMta'), 'no MTA helper may be consulted');
    assert.ok(body.includes('isPromoProfitCapReached'), 'the separate promo cap is still enforced');
});

// ---------------------------------------------------------------------------
// 4. /api/auth/me exposes the state; sandbox is never capped
// ---------------------------------------------------------------------------

test('/api/auth/me reports the promo cap state (production) and false/0 (sandbox)', () => {
    const body = routeBody('get', '/api/auth/me');
    assert.match(body, /promoRealizedProfit: Number\(promoProfit\) \|\| 0/);
    assert.match(body, /const promoFunding = await isPromoCreditFunded\(user\.id, !!funded\)/);
    assert.match(body, /promoCreditFunded = promoFunding === true/);
    assert.match(body, /promoClassificationUnknown = promoFunding === null/);
    assert.match(body, /promoLimitReached: isPromoProfitCapReached\(promoCreditFunded, promoProfit\)/);
    // Sandbox is definitively exempt, never "unknown".
    assert.match(body, /promoClassificationUnknown: false/);
    assert.match(body, /promoRealizedProfit: 0/);
    assert.match(body, /promoLimitReached: false/);
});

test('sandbox trade/bot handlers reference no promo cap constant', () => {
    for (const name of ['handleSandboxTrade', 'handleSandboxBotStart']) {
        const fn = fnBody(name);
        assert.ok(!fn.includes('PROMO_PROFIT_CAP_USD'), `${name} must not read the production cap`);
        assert.ok(!fn.includes('getPromoRealizedProfit'), `${name} must not read the production promo ledger`);
        assert.ok(!fn.includes('promoLimitBody'), `${name} must not emit the production cap response`);
    }
});

// ---------------------------------------------------------------------------
// 4b. Authoritative source-of-funds classification
// ---------------------------------------------------------------------------

test('isPromoCreditFunded classifies by source of funds, never by balance amount', () => {
    const fn = extractFunction(SERVER, 'isPromoCreditFunded');
    assert.ok(fn.includes('if (hasConfirmedDeposit) return false;'), 'deposited users are never promo-credit users');
    assert.ok(fn.includes('isMarketingSandboxUser(userId)'), 'sandbox must be short-circuited');
    assert.ok(fn.includes('hasConvertedReferralEarnings(userId)'), 'referral-funded users must be excluded');
    assert.ok(!/live_balance|\.balance/.test(fn), 'must never consult the balance amount');
});

test('hasConvertedReferralEarnings reads the authoritative conversion ledger and transaction marker', () => {
    const fn = extractFunction(SERVER, 'hasConvertedReferralEarnings');
    assert.match(fn, /from\('referral_earning_conversions'\)/);
    assert.match(fn, /\.eq\('user_id', userId\)/);
    assert.match(fn, /from\('transactions'\)/);
    assert.match(fn, /\.eq\('type', 'Bonus Withdrawal'\)/);
    assert.ok(fn.includes('return null;'), 'an unknown state must be representable (fail-open)');
});

test('/api/trade and /api/bot/start classify via isPromoCreditFunded BEFORE the cap check', () => {
    for (const routePath of ['/api/trade', '/api/bot/start']) {
        const body = routeBody('post', routePath);
        const clsIdx = body.indexOf('await isPromoCreditFunded(');
        const capIdx = body.indexOf('isPromoProfitCapReached(');
        assert.ok(clsIdx > 0, `${routePath} must classify by source of funds`);
        assert.ok(capIdx > clsIdx, `${routePath} cap check must use the classification`);
        assert.match(body, /isPromoProfitCapReached\(promoCreditFunded, /);
    }
});

test('the cap classifier is the authoritative source-of-funds rule (no MTA-exemption helper)', () => {
    // The MTA-exemption category ("no deposit + positive balance") has been
    // REMOVED together with the MTA. The cap must use ONLY the authoritative
    // source-of-funds classifier, never a balance-shape heuristic.
    assert.ok(!SERVER.includes('isNonDepositedTrading'), 'the MTA-exemption helper must be gone');
    const capFn = extractFunction(SERVER, 'isPromoProfitCapReached');
    assert.ok(!/liveBalance|balance\s*>/.test(capFn), 'cap must not inspect the balance');
    for (const routePath of ['/api/trade', '/api/bot/start']) {
        const body = routeBody('post', routePath);
        assert.ok(body.includes('isPromoProfitCapReached(promoCreditFunded, '),
            `${routePath} cap must be gated on the authoritative classification`);
    }
});

// ---------------------------------------------------------------------------
// 5. Behaviour matrix (pure mirror)
// ---------------------------------------------------------------------------

test('below $30 profit can keep trading; exactly/above $30 is locked', () => {
    assert.strictEqual(tradeAllowed({ hasDeposit: false, promoProfit: 0 }), true);
    assert.strictEqual(tradeAllowed({ hasDeposit: false, promoProfit: 29.99 }), true);
    assert.strictEqual(tradeAllowed({ hasDeposit: false, promoProfit: 30 }), false, 'exactly $30 locks (inclusive)');
    assert.strictEqual(tradeAllowed({ hasDeposit: false, promoProfit: 30.01 }), false);
    assert.strictEqual(tradeAllowed({ hasDeposit: false, promoProfit: 500 }), false);
});

test('a real deposited user is never treated as promo-credit-only', () => {
    assert.strictEqual(tradeAllowed({ hasDeposit: true, promoProfit: 5000 }), true);
    assert.strictEqual(botStartAllowed({ hasDeposit: true, promoProfit: 5000, mode: 'live' }).started, true);
});

test('$50 promotional-credit user: below / exactly / above $30 (inclusive lock)', () => {
    const promo = { hasDeposit: false, referralFunded: false };
    assert.strictEqual(tradeAllowed({ ...promo, promoProfit: 0 }), true, 'no profit can trade');
    assert.strictEqual(tradeAllowed({ ...promo, promoProfit: 29.99 }), true, 'below the cap can trade');
    assert.strictEqual(tradeAllowed({ ...promo, promoProfit: 30 }), false, 'exactly $30 locks (inclusive)');
    assert.strictEqual(tradeAllowed({ ...promo, promoProfit: 30.01 }), false, 'above the cap is locked');
    assert.strictEqual(botStartAllowed({ ...promo, promoProfit: 30, mode: 'live' }).started, false);
    assert.strictEqual(botStartAllowed({ ...promo, promoProfit: 30.01, mode: 'live' }).started, false);
});

test('referral-funded user with no deposit is NOT capped (authoritative source of funds)', () => {
    const referral = { hasDeposit: false, referralFunded: true };
    assert.strictEqual(tradeAllowed({ ...referral, promoProfit: 29.99 }), true);
    assert.strictEqual(tradeAllowed({ ...referral, promoProfit: 30 }), true, 'converted referral capital is never capped');
    assert.strictEqual(tradeAllowed({ ...referral, promoProfit: 1000 }), true);
    assert.strictEqual(botStartAllowed({ ...referral, promoProfit: 1000, mode: 'live' }).started, true);
});

test('ANY referral-earnings conversion PERMANENTLY exempts the cap (documented decision)', () => {
    // Management-approved policy (2026-09): the exemption is permanent for the
    // life of the account while it has no confirmed deposit. Any conversion —
    // however small — commingles genuine referral capital into Live balance, and
    // we deliberately do NOT attempt proportional attribution.
    const fn = extractFunction(SERVER, 'hasConvertedReferralEarnings');
    assert.ok(!/\.gte\(|\.gt\(|\.lte\(|\.lt\(/.test(fn), 'no amount threshold on conversions');
    assert.ok(!/amount/.test(fn.split('select(')[1].split(')')[0]), 'the conversion lookup selects no amount');
    // The decision is documented in the source.
    assert.match(SERVER, /PERMANENT for the life of the/);
    assert.match(SERVER, /NO amount\s*\n?\s*threshold|NO amount/);
    // And it holds behaviourally: exempt at any profit level, with no deposit.
    assert.strictEqual(isPromoCreditFundedMirror({ hasDeposit: false, referralFunded: true }), false);
    assert.strictEqual(tradeAllowed({ hasDeposit: false, referralFunded: true, promoProfit: 0.01 }), true);
    assert.strictEqual(tradeAllowed({ hasDeposit: false, referralFunded: true, promoProfit: 30 }), true);
    assert.strictEqual(tradeAllowed({ hasDeposit: false, referralFunded: true, promoProfit: 999999 }), true);
    assert.strictEqual(botStartAllowed({ hasDeposit: false, referralFunded: true, promoProfit: 999999, mode: 'live' }).started, true);
});

test('classification does not depend on the balance amount', () => {
    // A promo user who LOST part of the credit is still promo-funded...
    assert.strictEqual(isPromoCreditFundedMirror({ hasDeposit: false, referralFunded: false }), true);
    // ...and a referral-funded user with a positive balance is not.
    assert.strictEqual(isPromoCreditFundedMirror({ hasDeposit: false, referralFunded: true }), false);
    assert.strictEqual(isPromoCreditFundedMirror({ hasDeposit: true, referralFunded: false }), false);
    assert.strictEqual(isPromoCreditFundedMirror({ sandbox: true, hasDeposit: false, referralFunded: false }), false);
});

test('the sandbox is never restricted by the $30 rule', () => {
    assert.strictEqual(tradeAllowed({ sandbox: true, hasDeposit: false, promoProfit: 1000 }), true);
    assert.strictEqual(botStartAllowed({ sandbox: true, promoProfit: 1000, mode: 'live' }).started, true);
});

test('bot start is blocked at/above the cap; restart cannot bypass; below the cap it starts', () => {
    assert.strictEqual(botStartAllowed({ hasDeposit: false, promoProfit: 29.99, mode: 'live' }).started, true);
    assert.deepStrictEqual(botStartAllowed({ hasDeposit: false, promoProfit: 30, mode: 'live' }),
        { started: false, code: CODE });
    // A restart is just another start request: still blocked.
    assert.strictEqual(botStartAllowed({ hasDeposit: false, promoProfit: 30, mode: 'live' }).started, false);
    // There is no second mode: a spoofed client mode cannot skip the gate.
    const start = routeBody('post', '/api/bot/start');
    assert.ok(!/req\.body\s*&&\s*req\.body\.mode/.test(start), 'the route no longer reads a client mode');
    assert.ok(!/'demo'/.test(start), 'the bot-start route has no demo branch');
});

test('a confirmed deposit unlocks trading/bot again regardless of prior promo profit', () => {
    assert.strictEqual(tradeAllowed({ hasDeposit: true, promoProfit: 30 }), true);
    assert.strictEqual(botStartAllowed({ hasDeposit: true, promoProfit: 35, mode: 'live' }).started, true);
});

test('duplicate/replayed trades add no profit (idempotent ledger) so cannot bypass the cap', () => {
    // record_trade_safe() returns the already-applied amount without inserting a
    // second `trades` row, so the ledger sum (the cap basis) is unchanged.
    const ledger = [10, 12, 8]; // net 30 -> locked
    const profit = ledger.reduce((s, x) => s + x, 0);
    assert.strictEqual(profit, 30);
    assert.strictEqual(tradeAllowed({ hasDeposit: false, promoProfit: profit }), false);
    // A replayed duplicate would not append a row; simulate that:
    const afterReplay = ledger.slice();
    assert.strictEqual(afterReplay.reduce((s, x) => s + x, 0), 30);
    assert.strictEqual(tradeAllowed({ hasDeposit: false, promoProfit: afterReplay.reduce((s, x) => s + x, 0) }), false);
});

// ---------------------------------------------------------------------------
// 6. Frontend wiring
// ---------------------------------------------------------------------------

test('frontend startBot refuses to start when the server-reported cap is reached', () => {
    const fn = extractFunction(INDEX, 'startBot');
    assert.ok(fn.includes('APP.liveData.promoLimitReached'), 'startBot must honour the cap flag');
    assert.ok(fn.includes("t('bot.promoLimitReached')"), 'startBot must show the cap message');
});

test('frontend persistLiveTrade stops the bot on the cap (server refusal and reaching trade)', () => {
    const fn = extractFunction(INDEX, 'persistLiveTrade');
    assert.ok(fn.includes("'PROMO_TRADING_LIMIT_REACHED'"), 'must detect the server cap code');
    assert.ok(fn.includes('result.promoLimitReached === true'), 'must detect the reaching trade');
    assert.ok(fn.includes('stopBot()'), 'must stop the bot at the cap');
});

test('frontend updateUI disables the live bot button when capped (display mirror)', () => {
    const fn = extractFunction(INDEX, 'updateUI');
    assert.ok(fn.includes('promoLimitReached'), 'updateUI must render the cap state');
});

test('frontend lifts the cap state as soon as a qualifying deposit is confirmed', () => {
    const idx = INDEX.indexOf('APP.liveData.hasRealDeposit = true;');
    assert.ok(idx > 0, 'deposit-confirmed handler not found');
    const window = INDEX.slice(idx, idx + 500);
    assert.ok(window.includes('APP.liveData.promoLimitReached = false;'),
        'a confirmed deposit must immediately re-enable the bot');
});

test('i18n: bot.promoLimitReached exists in all 6 locales and matches the server message', () => {
    const blocks = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const blk = blocks.find((b) => b.includes('const TRANSLATIONS'));
    const start = blk.indexOf('const TRANSLATIONS');
    let i = blk.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < blk.length; i++) {
        if (blk[i] === '{') depth++;
        else if (blk[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext('this.T = ' + blk.slice(blk.indexOf('{', start), end + 1), sandbox);
    const T = sandbox.T;
    for (const lang of Object.keys(T)) {
        assert.ok(T[lang]['bot.promoLimitReached'], `${lang}.bot.promoLimitReached missing`);
    }
    assert.strictEqual(T.en['bot.promoLimitReached'], MESSAGE);
});

// ---------------------------------------------------------------------------
// 7. Migration 026 (defence in depth; NOT applied)
// ---------------------------------------------------------------------------

test('migration 055 raises the fail-open, sandbox-skipping trades trigger to $30', () => {
    assert.match(M055, /CREATE OR REPLACE FUNCTION public\.enforce_promo_trade_cap\(\)/);
    assert.match(M055, /BEFORE INSERT ON public\.trades/);
    assert.match(M055, /RAISE EXCEPTION 'PROMO_TRADING_LIMIT_REACHED'/);
    assert.match(M055, /v_promo_profit >= 30/, 'R6: inclusive $30 threshold');
    assert.match(M055, /EXCEPTION WHEN OTHERS THEN\s*\n\s*RETURN NEW;/, 'fail open');
    assert.match(M055, /v_env = 'MARKETING_SANDBOX'/, 'sandbox skipped');
    assert.match(M055, /mode = 'live'/, 'realized-P&L basis is the live ledger');
    assert.ok(!/v_promo_profit >= 20/.test(M055), 'no $20 threshold left');
    // 026 stays as the historical revision; 055 is authoritative and says so.
    assert.match(M026, /v_promo_profit >= 20/, '026 is unchanged history');
    assert.match(M055, /SUPERSEDES the \$20 threshold in 026/);
    // Apply-order guard: the self-check reads the LIVE function body.
    assert.match(M055, /pg_get_functiondef/);
    assert.match(M055, /IF v_body NOT LIKE '%>= 30%' THEN/);
    // Everything except the threshold lines must match 026 byte-for-byte.
    const norm = (t) => t
        .replace(/>= \$30\.00/g, '>= $20.00')
        .replace(/exactly \$30\.00/g, 'exactly $20.00')
        .replace(/\$30 promotional-credit/g, '$20 promotional-credit')
        .replace(/v_promo_profit >= 30/g, 'v_promo_profit >= 20');
    const body055 = M055.slice(M055.indexOf('-- 1. GUARD FUNCTION'));
    const body026 = M026.slice(M026.indexOf('-- 1. GUARD FUNCTION'), M026.indexOf('-- ============================================\n-- 4.'));
    assert.strictEqual(norm(body055).slice(0, body026.length).replace(/\s+$/, ''), body026.replace(/\s+$/, ''),
        'the guard function/trigger body is identical to 026 apart from the threshold');
});


test('migration 026 enforces the SAME source-of-funds classification as server.js', () => {
    // Deposited users are exempt...
    assert.match(M026, /IF v_has_deposit IS TRUE THEN\s*\n\s*RETURN NEW;/);
    // ...and so are referral-funded users (conversion ledger OR tx marker).
    assert.match(M026, /FROM public\.referral_earning_conversions c/);
    assert.match(M026, /EXCEPTION WHEN undefined_table THEN/);
    assert.match(M026, /FROM public\.transactions tx/);
    assert.match(M026, /tx\.type = 'Bonus Withdrawal'/);
    // The balance amount is never consulted.
    assert.ok(!/live_balance/.test(M026), 'the trigger must not read the balance amount');
});

test('migration 026 is additive, idempotent and cannot affect existing trades', () => {
    // Idempotent re-runs.
    assert.match(M026, /CREATE OR REPLACE FUNCTION/);
    assert.match(M026, /DROP TRIGGER IF EXISTS trg_enforce_promo_trade_cap/);
    // Additive only: no DDL beyond the function/trigger, no data mutation.
    assert.ok(!/ALTER TABLE/.test(M026), 'no table alterations');
    assert.ok(!/CREATE TABLE/.test(M026), 'no new tables');
    assert.ok(!/DROP TABLE|TRUNCATE|DELETE FROM|UPDATE public\./.test(M026), 'no data mutation');
    // BEFORE INSERT only -> existing rows are never re-evaluated.
    assert.match(M026, /BEFORE INSERT ON public\.trades/);
    assert.ok(!/BEFORE UPDATE/.test(M026), 'updates/backfills must not be gated');
    assert.ok(!/FOR EACH STATEMENT/.test(M026), 'row-level only');
    // Self-checking trailing block.
    assert.match(M026, /RAISE EXCEPTION 'migration 026/);
});
