'use strict';

/**
 * Promotional credit ($50, tradable) after the MTA removal.
 *
 * The $50 promotional credit is TRADABLE through the existing trading engine.
 * It stays non-withdrawable until the user has made a qualifying first deposit
 * AND completed at least one trade; after that the normal withdrawal rules apply
 * (verification when enabled, $700 minimum, balance, address).
 *
 * The Minimum Trading Amount (MTA) has been REMOVED entirely: there is no
 * minimum trading balance, no `MTA_AMOUNT` env override and therefore no
 * exemption helper. The $20 promotional-credit realized-profit cap is a
 * SEPARATE rule and remains the only live-trading stop.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const SERVER_CODE = SERVER.split('\n').map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n');

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

// ---------------------------------------------------------------------------
// Promotional credit
// ---------------------------------------------------------------------------
test('promo credit: the $50 seed is a constant, not derived from the minimum deposit', () => {
    assert.match(SERVER, /const SANDBOX_PROMO_CREDIT = 50;/);
    assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 100;/);
    assert.notStrictEqual(50, 100);
});

test('promo credit: tradable via the EXISTING engine (no separate engine)', () => {
    assert.ok(!SERVER.includes('isNonDepositedTrading'), 'the retired MTA-exemption helper must be gone');
    const trade = SERVER.slice(SERVER.indexOf("app.post('/api/trade'"), SERVER.indexOf("app.post('/api/trade'") + 900);
    assert.match(trade, /record_trade_safe/, 'promo trading uses the same trading engine');
});

test('promo credit: the bot starts with any balance (no trading minimum)', () => {
    const botCode = BOT_START.split('\n').map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n');
    assert.ok(!botCode.includes('MTA'), 'the bot route must not gate on the MTA');
    assert.ok(!/balance\s*<\s*\d/.test(BOT_START), 'no balance threshold may remain');
    assert.match(BOT_START, /req\.body\.mode === 'demo' \? 'demo' : 'live'/, 'default-deny mode normalisation');
    // the separate promo cap remains the only live-trading stop
    assert.match(BOT_START, /isPromoProfitCapReached/);
});

test('promo credit: withdrawal requires a qualifying first deposit AND one trade', () => {
    assert.ok(WITHDRAW.includes('A qualifying first deposit is required before you can withdraw your promotional credit'));
    assert.ok(WITHDRAW.includes('depositRequired: true'));
    assert.ok(WITHDRAW.includes('requiresFirstDeposit: true'));
    assert.ok(WITHDRAW.includes('Complete at least 1 trade first'), 'the existing one-trade rule is preserved');
    // The production first-deposit gate precedes the verification prompt, while
    // verification (when enabled) precedes the $700 minimum.
    assert.ok(WITHDRAW.indexOf('requiresFirstDeposit') < WITHDRAW.indexOf('verificationRequired'), 'first-deposit prompt precedes verification');
    assert.ok(WITHDRAW.indexOf('verificationRequired') < WITHDRAW.indexOf("Min $' + MIN_WITHDRAWAL_USD"), 'verification precedes the $700 minimum');
    assert.ok(WITHDRAW.includes("Min $' + MIN_WITHDRAWAL_USD"), 'the $700 minimum is applied');
    assert.ok(WITHDRAW.includes('Insufficient balance'), 'the balance check is unchanged');
    assert.ok(WITHDRAW.includes('Valid address required'), 'the address check is unchanged');
});

test('promo credit: the deposit requirement is a first-priority gate; the trade rule stays in the not-fully-qualified branch', () => {
    const depositGate = WITHDRAW.indexOf('requiresFirstDeposit');
    const kycGate = WITHDRAW.indexOf('verificationRequired');
    const guardIdx = WITHDRAW.indexOf('if (!requirementsMet && fromBonus === 0)');
    const tradeGate = WITHDRAW.indexOf('Complete at least 1 trade first');
    assert.ok(depositGate > 0 && kycGate > depositGate,
        'the first-deposit requirement must take priority over the verification prompt');
    assert.ok(guardIdx > 0 && tradeGate > guardIdx,
        'the completed-trade requirement remains inside the not-fully-qualified branch');
});

// ---------------------------------------------------------------------------
// MTA removed
// ---------------------------------------------------------------------------
test('MTA: fully removed from production', () => {
    assert.ok(!SERVER_CODE.includes('BOT_MIN_TRADING_BALANCE'), 'no MTA constant');
    assert.ok(!SERVER_CODE.includes('MTA_AMOUNT'), 'no MTA env override');
    assert.ok(!SERVER_CODE.includes('getEffectiveMta'), 'no MTA helper');
    const botCode = BOT_START.split('\n').map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n');
    assert.ok(!/balance < \d{3}/.test(botCode), 'the bot route must not hard-code an MTA');
});

test('MTA: MARKETING_SANDBOX has no MTA gate', () => {
    const sandboxBot = fnSource('handleSandboxBotStart');
    const sandboxCode = sandboxBot.split('\n').map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n');
    assert.ok(!/BOT_MIN_TRADING_BALANCE|getEffectiveMta|MTA\b/.test(sandboxCode), 'sandbox bot start performs no MTA gate');
    assert.match(sandboxBot, /sandbox_bot_sessions/, 'the simulated session is still persisted');
});

test('withdrawal minimum is $700 (unchanged rule, updated value)', () => {
    assert.match(SERVER, /const MIN_WITHDRAWAL_USD = 700;/);
    assert.ok(WITHDRAW.includes('amount < MIN_WITHDRAWAL_USD'));
});
