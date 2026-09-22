'use strict';

/**
 * Withdrawal minimum message scoping ($500) + MTA removal.
 *
 * The "$500 minimum withdrawal" message is DISCLOSED AT THE WITHDRAWAL STAGE
 * rather than advertised everywhere. Concretely:
 *
 *   - the always-visible sidebar status NEVER states the amount; below the
 *     minimum (but otherwise eligible) it shows a neutral prompt instead
 *   - the withdraw MODAL info box (seen only once the user reaches withdrawal)
 *     states the $500 minimum explicitly
 *   - the submit path / toast states the $500 minimum explicitly
 *   - a user missing an earlier requirement keeps that requirement's message:
 *       no deposit            -> first-deposit prompt
 *       deposited, no trade   -> completed-trade prompt
 *       >= $500               -> ready
 *
 * The MTA (minimum trading balance) no longer exists, so it is not a gate and
 * must not appear in any withdrawal message. Display gating only: the server
 * keeps enforcing KYC (flag-gated), the $500 minimum, balance, address,
 * first-deposit and completed-trade rules.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
const NEUTRAL_KEY = 'live.withdrawStatus.belowMinimum';

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' must exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    return INDEX.slice(start, end + 1);
}

function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

const T = loadTranslations();

/* ------------------------------------------------------------------ *
 * 1. Gate ordering inside openWithdrawModal (no MTA gate)
 * ------------------------------------------------------------------ */
test('openWithdrawModal enforces no MTA gate and keeps every real gate in order', () => {
    const open = extractFunction('openWithdrawModal');
    const iFirstDepositPriority = open.indexOf("showToast(t('withdraw.firstDeposit'),'error',6000)");
    const iDepositGate = open.indexOf("if(!APP.liveData.hasRealDeposit && !canFundFromReferral) { showToast(t('withdraw.firstDeposit'),'error'); return; }");
    const iTradeGate = open.indexOf("if(!APP.liveData.hasTradingActivity && !canFundFromReferral) { showToast(t('withdraw.needTrade'),'error'); return; }");
    const iMinGate = open.indexOf("t('withdraw.minWithdrawal', {min: APP.MIN_WITHDRAWAL, current:");

    [iFirstDepositPriority, iDepositGate, iTradeGate, iMinGate].forEach((idx, n) => {
        assert.ok(idx > 0, 'gate marker ' + n + ' must exist');
    });
    assert.ok(iFirstDepositPriority < iDepositGate, 'first-deposit priority stays first');
    assert.ok(iDepositGate < iTradeGate, 'deposit requirement is evaluated before the trade requirement');
    assert.ok(iTradeGate < iMinGate, 'the $500 minimum is the LAST eligibility message');
    assert.ok(!open.includes('APP.MTA'), 'no MTA gate may remain in the withdrawal modal');
});

test('no withdrawal rule was removed: the min/trade/deposit checks all still exist', () => {
    const open = extractFunction('openWithdrawModal');
    assert.ok(open.includes('totalWithdrawable < APP.MIN_WITHDRAWAL'), '$500 minimum still enforced');
    assert.ok(open.includes('hasTradingActivity'), 'trade requirement still enforced');
    assert.ok(open.includes('hasRealDeposit'), 'deposit requirement still enforced');
    assert.ok(open.indexOf('const isSandbox = APP.environment') < open.indexOf('if(!APP.liveData.hasRealDeposit'),
        'the sandbox short-circuit still precedes every production gate');
    assert.ok(open.includes('if (!isSandbox) {'), 'the gate block stays production-only');
});

/* ------------------------------------------------------------------ *
 * 2. Real behaviour of updateLiveWithdrawStatus
 * ------------------------------------------------------------------ */
function runStatus(environment, liveData, opts) {
    const o = opts || {};
    const fnSrc = extractFunction('updateLiveWithdrawStatus');
    const els = {
        liveWithdrawStatus: { textContent: '', style: {} },
        withdrawInfoText: { textContent: '', style: {} },
    };
    const sandbox = {
        APP: {
            environment,
            liveData,
            bonusData: { balance: o.bonus || 0 },
            MIN_WITHDRAWAL: 500,
        },
        document: { getElementById: (id) => els[id] || null },
        t: (key) => key,
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + '; updateLiveWithdrawStatus();', sandbox);
    return els;
}

const funded = { hasRealDeposit: true, hasTradingActivity: true };

test('no deposit -> first-deposit wording, never the $500 minimum', () => {
    const els = runStatus('PRODUCTION', { hasRealDeposit: false, hasTradingActivity: false, balance: 0 });
    assert.strictEqual(els.liveWithdrawStatus.textContent, 'live.withdrawStatus.notDeposited');
    assert.strictEqual(els.withdrawInfoText.textContent, 'live.withdrawStatus.notDeposited');
});

test('deposited but no trade -> trade wording, never the $500 minimum', () => {
    [50, 300, 490].forEach((balance) => {
        const els = runStatus('PRODUCTION', { hasRealDeposit: true, hasTradingActivity: false, balance });
        assert.strictEqual(els.liveWithdrawStatus.textContent, 'live.withdrawStatus.noTrades', 'balance ' + balance);
        assert.strictEqual(els.withdrawInfoText.textContent, 'live.withdrawStatus.noTrades');
    });
});

test('eligible but below $500 -> neutral sidebar prompt, explicit $500 in the modal info box', () => {
    [0, 19.99, 200, 499.99].forEach((balance) => {
        const els = runStatus('PRODUCTION', Object.assign({ balance }, funded));
        assert.strictEqual(els.liveWithdrawStatus.textContent, NEUTRAL_KEY,
            'the sidebar must not advertise the amount (balance ' + balance + ')');
        assert.strictEqual(els.withdrawInfoText.textContent, 'live.withdrawStatus.needMinimum',
            'the modal info box states the minimum');
    });
});

test('eligible and >= $500 -> ready', () => {
    [500, 5000].forEach((balance) => {
        const els = runStatus('PRODUCTION', Object.assign({ balance }, funded));
        assert.strictEqual(els.liveWithdrawStatus.textContent, 'live.withdrawStatus.ready', 'balance ' + balance);
        assert.strictEqual(els.withdrawInfoText.textContent, 'withdraw.info');
    });
});

test('a referral-earnings-funded withdrawal keeps its exemption and stays ready', () => {
    const els = runStatus('PRODUCTION', { hasRealDeposit: false, hasTradingActivity: false, balance: 0 }, { bonus: 500 });
    assert.strictEqual(els.liveWithdrawStatus.textContent, 'live.withdrawStatus.ready');
});

test('MARKETING_SANDBOX is unaffected (no production wording, no minimum)', () => {
    const ready = runStatus('MARKETING_SANDBOX', Object.assign({ balance: 20 }, funded));
    assert.strictEqual(ready.liveWithdrawStatus.textContent, 'live.withdrawStatus.readySandbox');
    assert.strictEqual(ready.withdrawInfoText.textContent, 'withdraw.infoSandbox');
    const empty = runStatus('MARKETING_SANDBOX', { hasRealDeposit: false, hasTradingActivity: false, balance: 0 });
    assert.strictEqual(empty.liveWithdrawStatus.textContent, 'live.withdrawStatus.sandboxEmpty');
});

/* ------------------------------------------------------------------ *
 * 3. Thresholds and existing copy
 * ------------------------------------------------------------------ */
test('thresholds: $500 minimum front and back; the MTA is gone', () => {
    assert.ok(/MIN_WITHDRAWAL:\s*500/.test(INDEX), 'APP.MIN_WITHDRAWAL is 500');
    assert.ok(/MIN_WITHDRAWAL_USD\s*=\s*500/.test(SERVER), 'the server constant is 500');
    assert.ok(SERVER.includes('amount < MIN_WITHDRAWAL_USD'), 'the server minimum is enforced');
    assert.ok(!INDEX.includes('APP.MTA'), 'no frontend MTA remains');
    // Comments may explain the removal; executable code must not carry it.
    const code = SERVER.split('\n').map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n');
    assert.ok(!code.includes('BOT_MIN_TRADING_BALANCE'), 'no server MTA remains');
});

test('the minimum-withdrawal copy is correct', () => {
    [
        ['withdraw.minWithdrawal', 'Minimum withdrawal is ${{min}}. Current: ${{current}}'],
        ['withdraw.minAmount', 'Minimum withdrawal is $500'],
        ['live.withdrawStatus.needMinimum', '\u{1F4C8} Reach the ${{min}} minimum to withdraw'],
    ].forEach(([k, v]) => assert.strictEqual(T.en[k], v, k + ' must keep its wording'));
    assert.strictEqual(T.en['withdraw.min700'], undefined, 'the obsolete $700 key is removed');
});

test('the neutral sidebar prompt quotes no threshold and needs no interpolation', () => {
    LANGS.forEach((l) => {
        const v = T[l][NEUTRAL_KEY];
        assert.ok(typeof v === 'string' && v.trim(), l + ' must define the key');
        assert.ok(!/500|{{min}}/.test(v), l + ' must not restate a withdrawal threshold');
        assert.ok(!/\{\{/.test(v), l + ' must not carry an unresolved placeholder');
        assert.ok(!/\d/.test(v), l + ' must stay threshold-free');
    });
});

/* ------------------------------------------------------------------ *
 * 4. i18n contract
 * ------------------------------------------------------------------ */
test('the neutral key is localized in all 6 locales (no interpolation needed)', () => {
    assert.strictEqual(new Set(LANGS.map((l) => Object.keys(T[l]).sort().join('|'))).size, 1, 'identical key sets');
    assert.strictEqual(Object.keys(T.en).length, 1402, 'dictionary size pinned');
    assert.strictEqual(T.en[NEUTRAL_KEY], '\u{1F4C8} Keep trading to grow your eligible balance');
    LANGS.forEach((l) => {
        assert.ok(typeof T[l][NEUTRAL_KEY] === 'string' && T[l][NEUTRAL_KEY].trim(), l + ' must define the key');
        assert.ok(!T[l][NEUTRAL_KEY].includes('{{'), l + ' must not require interpolation');
    });
    assert.strictEqual(new Set(LANGS.map((l) => T[l][NEUTRAL_KEY])).size, LANGS.length, 'each locale has its own wording');
});

test('the status helper renders the neutral key through t() and keeps the modal disclosure', () => {
    const fn = extractFunction('updateLiveWithdrawStatus');
    assert.ok(fn.includes("t('live.withdrawStatus.belowMinimum')"), 'renders the neutral key through t()');
    assert.ok(!fn.includes('APP.MTA'), 'no MTA reference may remain in the status helper');
    assert.ok(fn.includes("t('live.withdrawStatus.needMinimum', { min: APP.MIN_WITHDRAWAL })"),
        'the modal info box still discloses the minimum');
});
