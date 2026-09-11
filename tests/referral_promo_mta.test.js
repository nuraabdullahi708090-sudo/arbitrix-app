'use strict';

/**
 * Promotional credit ($50, tradable) + Minimum Trading Amount (MTA).
 *
 * The $50 promotional credit is TRADABLE through the existing trading engine
 * and is therefore exempt from the bot-start MTA gate. It stays non-withdrawable
 * until the user has made a qualifying first deposit AND completed at least one
 * trade; after that the normal withdrawal rules apply (KYC first, $700 minimum,
 * balance, address). The MTA VALUE is unchanged by this feature and lives in a
 * single place.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function fnSource(name) {
    const idx = SERVER.indexOf(`function ${name}(`);
    assert.ok(idx >= 0, `function not found: ${name}`);
    const next = SERVER.indexOf('\nfunction ', idx + 1);
    const next2 = SERVER.indexOf('\nasync function ', idx + 1);
    let end = next < 0 ? next2 : next;
    if (next2 > 0 && (end < 0 || next2 < end)) end = next2;
    return SERVER.slice(idx, end < 0 ? undefined : end);
}

function routeSource(start, end) {
    const a = SERVER.indexOf(start);
    assert.ok(a > 0, 'route not found: ' + start);
    const b = SERVER.indexOf(end, a);
    assert.ok(b > a, 'route end not found: ' + end);
    return SERVER.slice(a, b);
}

const BOT_START = routeSource("app.post('/api/bot/start'", "app.post('/api/bot/stop'");
const WITHDRAW = routeSource("app.post('/api/withdraw/request'", "app.get('/api/withdraw/history'");

// Pure mirror of getEffectiveMta().
function effectiveMta(env, fallback) {
    const raw = env.MTA_AMOUNT;
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return (Number.isFinite(n) && n > 0) ? n : fallback;
}

// Pure mirror of isPromoFundedTrading().
function promoFunded(hasConfirmedDeposit, liveBalance) {
    return !hasConfirmedDeposit && Number(liveBalance) > 0;
}

// Pure mirror of the bot-start gate.
function botStartAllowed(mode, balance, mta, hasConfirmedDeposit) {
    return !(mode === 'live' && balance < mta && !promoFunded(hasConfirmedDeposit, balance));
}

test('promo credit: the $50 seed is a constant, not derived from the minimum deposit', () => {
    assert.match(SERVER, /const SANDBOX_PROMO_CREDIT = 50;/);
    assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 100;/);
    assert.notStrictEqual(50, 100);
});

test('promo credit: tradable via the EXISTING engine and exempt from the bot MTA gate', () => {
    assert.match(SERVER, /function isPromoFundedTrading\(hasConfirmedDeposit, liveBalance\)/);
    const promoFn = fnSource('isPromoFundedTrading');
    assert.match(promoFn, /!hasConfirmedDeposit && Number\(liveBalance\) > 0/);
    // The bot-start route applies the exemption but keeps the MTA value gate.
    assert.match(BOT_START, /isPromoFundedTrading\(await hasConfirmedDeposit\(userId\)/);
    assert.match(BOT_START, /if \(mode === 'live' && balance < mta && !promoFunded\)/);
    assert.match(BOT_START, /getEffectiveMta\(BOT_MIN_TRADING_BALANCE\)/);
});

test('promo credit: NO confirmed deposit + positive balance may start the bot', () => {
    const mta = 200;
    assert.strictEqual(botStartAllowed('live', 50, mta, false), true, 'promo-funded live trading is allowed to start');
    assert.strictEqual(botStartAllowed('live', 0, mta, false), false, 'a zero balance is still gated');
    assert.strictEqual(botStartAllowed('live', 50, mta, true), false, 'a confirmed deposit of only $50 is gated (not promo-funded)');
    assert.strictEqual(botStartAllowed('live', 500, mta, true), true, 'funded above the MTA is allowed');
});

test('promo credit: demo mode is intentionally not gated', () => {
    assert.strictEqual(botStartAllowed('demo', 0, 200, false), true);
    assert.match(BOT_START, /req\.body\.mode === 'demo' \? 'demo' : 'live'/, 'default-deny mode normalisation');
});

test('promo credit: withdrawal requires a qualifying first deposit AND one trade', () => {
    assert.ok(WITHDRAW.includes('A qualifying first deposit is required before you can withdraw your promotional credit'));
    assert.ok(WITHDRAW.includes('depositRequired: true'));
    assert.ok(WITHDRAW.includes('requiresFirstDeposit: true'));
    assert.ok(WITHDRAW.includes("Complete at least 1 trade first"), 'the existing one-trade rule is preserved');
    // Existing gates preserved and ordered before the new requirement.
    assert.ok(WITHDRAW.indexOf('verificationRequired') < WITHDRAW.indexOf('Min $700'), 'KYC remains the first gate');
    assert.ok(WITHDRAW.includes('Min $700'), 'the $700 minimum is unchanged');
    assert.ok(WITHDRAW.includes('Insufficient balance'), 'the balance check is unchanged');
    assert.ok(WITHDRAW.includes('Valid address required'), 'the address check is unchanged');
});

test('promo credit: the requirement is appended in the not-fully-qualified branch only', () => {
    const guardIdx = WITHDRAW.indexOf('if (!requirementsMet && fromBonus === 0)');
    const depositGate = WITHDRAW.indexOf('requiresFirstDeposit');
    const tradeGate = WITHDRAW.indexOf("Complete at least 1 trade first");
    assert.ok(guardIdx > 0 && tradeGate > guardIdx && depositGate > tradeGate,
        'the deposit requirement follows the existing trade requirement inside the same branch');
});

test('MTA: exactly one place defines the value, env-selectable (no hard-coded 200/300 in routes)', () => {
    assert.match(SERVER, /const BOT_MIN_TRADING_BALANCE = \d+;/);
    assert.match(SERVER, /const MTA_ENV_VAR = 'MTA_AMOUNT';/);
    assert.match(SERVER, /function getEffectiveMta\(/);
    // No route may hard-code the MTA literal; all must go through the helper.
    const literalInBot = /balance < \d{3}/.test(BOT_START);
    assert.ok(!literalInBot, 'the bot route must not hard-code the MTA');
    assert.match(BOT_START, /getEffectiveMta/);
});

test('MTA: the env override accepts 200 or 300 and falls back safely', () => {
    const fallback = Number((SERVER.match(/const BOT_MIN_TRADING_BALANCE = (\d+);/) || [])[1]);
    assert.ok(Number.isFinite(fallback) && fallback > 0);
    assert.strictEqual(effectiveMta({ MTA_AMOUNT: '200' }, fallback), 200);
    assert.strictEqual(effectiveMta({ MTA_AMOUNT: '300' }, fallback), 300);
    assert.strictEqual(effectiveMta({}, fallback), fallback, 'missing env -> code default');
    assert.strictEqual(effectiveMta({ MTA_AMOUNT: '' }, fallback), fallback, 'empty env -> code default');
    assert.strictEqual(effectiveMta({ MTA_AMOUNT: 'abc' }, fallback), fallback, 'invalid env -> code default');
    assert.strictEqual(effectiveMta({ MTA_AMOUNT: '-5' }, fallback), fallback, 'non-positive env -> code default');
});

test('MTA: MARKETING_SANDBOX has no MTA gate', () => {
    assert.match(SERVER, /mta: 0/);
    const sandboxBot = fnSource('handleSandboxBotStart');
    assert.ok(!/BOT_MIN_TRADING_BALANCE|getEffectiveMta/.test(sandboxBot), 'sandbox bot start performs no MTA gate');
    assert.match(sandboxBot, /sandbox_bot_sessions/, 'the simulated session is still persisted');
});
