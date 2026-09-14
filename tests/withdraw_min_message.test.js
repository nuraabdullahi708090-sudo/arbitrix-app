'use strict';

/**
 * Withdrawal minimum message scoping.
 *
 * The "$700 minimum withdrawal" message must only be shown for an account that
 * has (a) made a real deposit, (b) completed a trade AND (c) reached the
 * minimum trading balance (MTA). Everyone else gets the message about the
 * requirement they are actually missing:
 *
 *   no deposit            -> first-deposit prompt
 *   deposited, no trade   -> completed-trade prompt
 *   deposited + traded,
 *   below the MTA         -> minimum-trading-balance prompt (NOT $700)
 *   at/above the MTA,
 *   below $700            -> the $700 minimum prompt   <-- only here
 *   >= $700               -> ready
 *
 * Display gating only: no threshold, no server rule and no other withdrawal
 * protection changes. A balance below the MTA can never satisfy the $700
 * minimum (MTA 200 < MIN_WITHDRAWAL 700), so nothing valid is blocked.
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
const NEW_KEY = 'live.withdrawStatus.belowTradingBalance';

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
 * 1. Gate ordering inside openWithdrawModal
 * ------------------------------------------------------------------ */
test('the $700 minimum check runs only after deposit, trade AND minimum-trading-balance', () => {
    const open = extractFunction('openWithdrawModal');
    const iFirstDepositPriority = open.indexOf("showToast(t('withdraw.firstDeposit'),'error',6000)");
    const iDepositGate = open.indexOf("if(!APP.liveData.hasRealDeposit && !canFundFromReferral) { showToast(t('withdraw.firstDeposit'),'error'); return; }");
    const iTradeGate = open.indexOf("if(!APP.liveData.hasTradingActivity && !canFundFromReferral) { showToast(t('withdraw.needTrade'),'error'); return; }");
    const iMtaGate = open.indexOf("t('live.withdrawStatus.belowTradingBalance'");
    const iMinGate = open.indexOf("t('withdraw.minWithdrawal', {min: APP.MIN_WITHDRAWAL, current:");

    [iFirstDepositPriority, iDepositGate, iTradeGate, iMtaGate, iMinGate].forEach((idx, n) => {
        assert.ok(idx > 0, 'gate marker ' + n + ' must exist');
    });
    assert.ok(iFirstDepositPriority < iDepositGate, 'first-deposit priority stays first');
    assert.ok(iDepositGate < iTradeGate, 'deposit requirement is evaluated before the trade requirement');
    assert.ok(iTradeGate < iMtaGate, 'trade requirement is evaluated before the trading-balance requirement');
    assert.ok(iMtaGate < iMinGate, 'the $700 minimum is the LAST eligibility message (never reached below the MTA)');
});

test('the trading-balance gate fails open when the MTA is unknown/zero', () => {
    const open = extractFunction('openWithdrawModal');
    assert.ok(open.includes('if(totalWithdrawable < (Number(APP.MTA) || 0)) {'),
        'an unknown MTA must not block a valid withdrawal');
    assert.ok(open.includes("showToast(t('live.withdrawStatus.belowTradingBalance'),'error'); return; }"),
        'the trading-balance prompt replaces the $700 prompt below the MTA');
});

test('no withdrawal rule was removed: the min/trade/deposit checks all still exist', () => {
    const open = extractFunction('openWithdrawModal');
    assert.ok(open.includes('totalWithdrawable < APP.MIN_WITHDRAWAL'), '$700 minimum still enforced');
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
            MTA: o.MTA === undefined ? 200 : o.MTA,
            MIN_WITHDRAWAL: 700,
        },
        document: { getElementById: (id) => els[id] || null },
        t: (key) => key,
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + '; updateLiveWithdrawStatus();', sandbox);
    return els;
}

const funded = { hasRealDeposit: true, hasTradingActivity: true };

test('no deposit -> first-deposit wording, never the $700 minimum', () => {
    const els = runStatus('PRODUCTION', { hasRealDeposit: false, hasTradingActivity: false, balance: 0 });
    assert.strictEqual(els.liveWithdrawStatus.textContent, 'live.withdrawStatus.notDeposited');
    assert.strictEqual(els.withdrawInfoText.textContent, 'live.withdrawStatus.notDeposited');
});

test('deposited but no trade -> trade wording, never the $700 minimum', () => {
    [50, 300, 690].forEach((balance) => {
        const els = runStatus('PRODUCTION', { hasRealDeposit: true, hasTradingActivity: false, balance });
        assert.strictEqual(els.liveWithdrawStatus.textContent, 'live.withdrawStatus.noTrades', 'balance ' + balance);
        assert.strictEqual(els.withdrawInfoText.textContent, 'live.withdrawStatus.noTrades');
    });
});

test('deposited + traded but below the minimum trading balance -> trading-balance wording', () => {
    [0, 19.99, 199.99].forEach((balance) => {
        const els = runStatus('PRODUCTION', Object.assign({ balance }, funded));
        assert.strictEqual(els.liveWithdrawStatus.textContent, 'live.withdrawStatus.belowTradingBalance', 'balance ' + balance);
        assert.strictEqual(els.withdrawInfoText.textContent, 'live.withdrawStatus.belowTradingBalance');
    });
});

test('deposited + traded + at/above the MTA but below $700 -> the $700 minimum (the only case)', () => {
    [200, 200.01, 699.99].forEach((balance) => {
        const els = runStatus('PRODUCTION', Object.assign({ balance }, funded));
        assert.strictEqual(els.liveWithdrawStatus.textContent, 'live.withdrawStatus.needMinimum', 'balance ' + balance);
        assert.strictEqual(els.withdrawInfoText.textContent, 'live.withdrawStatus.needMinimum');
    });
});

test('deposited + traded + >= $700 -> ready', () => {
    [700, 5000].forEach((balance) => {
        const els = runStatus('PRODUCTION', Object.assign({ balance }, funded));
        assert.strictEqual(els.liveWithdrawStatus.textContent, 'live.withdrawStatus.ready', 'balance ' + balance);
        assert.strictEqual(els.withdrawInfoText.textContent, 'withdraw.info');
    });
});

test('a referral-earnings-funded withdrawal keeps its exemption and stays ready', () => {
    const els = runStatus('PRODUCTION', { hasRealDeposit: false, hasTradingActivity: false, balance: 0 }, { bonus: 700 });
    assert.strictEqual(els.liveWithdrawStatus.textContent, 'live.withdrawStatus.ready');
});

test('MARKETING_SANDBOX is unaffected (no production wording, no $700)', () => {
    const ready = runStatus('MARKETING_SANDBOX', Object.assign({ balance: 20 }, funded));
    assert.strictEqual(ready.liveWithdrawStatus.textContent, 'live.withdrawStatus.readySandbox');
    assert.strictEqual(ready.withdrawInfoText.textContent, 'withdraw.infoSandbox');
    const empty = runStatus('MARKETING_SANDBOX', { hasRealDeposit: false, hasTradingActivity: false, balance: 0 });
    assert.strictEqual(empty.liveWithdrawStatus.textContent, 'live.withdrawStatus.sandboxEmpty');
});

test('an unknown MTA (0/undefined) never blocks the $700 message for an otherwise eligible account', () => {
    const zero = runStatus('PRODUCTION', Object.assign({ balance: 300 }, funded), { MTA: 0 });
    assert.strictEqual(zero.liveWithdrawStatus.textContent, 'live.withdrawStatus.needMinimum');
    const undef = runStatus('PRODUCTION', Object.assign({ balance: 300 }, funded), { MTA: undefined });
    assert.strictEqual(undef.liveWithdrawStatus.textContent, 'live.withdrawStatus.needMinimum');
});

/* ------------------------------------------------------------------ *
 * 3. Thresholds and existing copy unchanged
 * ------------------------------------------------------------------ */
test('thresholds are unchanged ($700 minimum, $200 production MTA, no 143)', () => {
    assert.ok(/MIN_WITHDRAWAL:\s*700/.test(INDEX), 'APP.MIN_WITHDRAWAL stays 700');
    assert.ok(/BOT_MIN_TRADING_BALANCE\s*=\s*200/.test(SERVER), 'production MTA stays 200');
    assert.ok(!/\b143\b/.test(INDEX.replace(/[\s\S]{0,0}/, '')), 'no stray 143 in the frontend');
    assert.ok(SERVER.includes('amount < 700'), 'the server minimum is untouched');
});

test('the $700 copy itself is unchanged', () => {
    [
        ["withdraw.minWithdrawal", 'Minimum withdrawal is ${{min}}. Current: ${{current}}'],
        ['withdraw.min700', 'Minimum withdrawal is $700'],
        ['live.withdrawStatus.needMinimum', '\u{1F4C8} Reach the ${{min}} minimum to withdraw'],
    ].forEach(([k, v]) => assert.strictEqual(T.en[k], v, k + ' must keep its wording'));
});

test('the new trading-balance message quotes no threshold and needs no interpolation', () => {
    LANGS.forEach((l) => {
        const v = T[l][NEW_KEY];
        assert.ok(typeof v === 'string' && v.trim(), l + ' must define the key');
        assert.ok(!/700|200|{{min}}/.test(v), l + ' must not restate a withdrawal threshold');
        assert.ok(!/\{\{/.test(v), l + ' must not carry an unresolved placeholder');
        assert.ok(!/\d/.test(v), l + ' must stay threshold-free');
    });
});

/* ------------------------------------------------------------------ *
 * 4. i18n contract
 * ------------------------------------------------------------------ */
test('the new key is localized in all 6 locales (no interpolation needed)', () => {
    assert.strictEqual(new Set(LANGS.map((l) => Object.keys(T[l]).sort().join('|'))).size, 1, 'identical key sets');
    assert.strictEqual(Object.keys(T.en).length, 1403, 'dictionary size pinned');
    assert.strictEqual(T.en[NEW_KEY], '\u{1F4C8} Keep trading to reach the minimum withdrawal balance.');
    LANGS.forEach((l) => {
        assert.ok(typeof T[l][NEW_KEY] === 'string' && T[l][NEW_KEY].trim(), l + ' must define the key');
        assert.ok(!T[l][NEW_KEY].includes('{{'), l + ' must not require interpolation');
    });
    assert.strictEqual(new Set(LANGS.map((l) => T[l][NEW_KEY])).size, LANGS.length, 'each locale has its own wording');
});

test('the status helper renders the key through t() (localized, no interpolation)', () => {
    const fn = extractFunction('updateLiveWithdrawStatus');
    assert.ok(fn.includes("t('live.withdrawStatus.belowTradingBalance')"), 'renders through t()');
    assert.ok(!fn.includes("belowTradingBalance', {"), 'no {mta} argument is needed any more');
    assert.ok(fn.indexOf('belowTradingBalance') < fn.indexOf("t('live.withdrawStatus.needMinimum'"), 'checked before the $700 wording');
    const open = extractFunction('openWithdrawModal');
    assert.ok(open.indexOf('belowTradingBalance') < open.indexOf("t('withdraw.minWithdrawal'"), 'toast ordering matches');
});
