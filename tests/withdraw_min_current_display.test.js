'use strict';

/**
 * WITHDRAWAL MINIMUM MESSAGE — the "Current: ${{current}}" placeholder must
 * always render the user's ACTUAL available balance.
 *
 * The key `withdraw.minWithdrawal` is "Minimum withdrawal is ${{min}}. Current:
 * ${{current}}". Two call sites render it:
 *   - the openWithdrawModal eligibility gate (already passed both vars), and
 *   - submitWithdraw (this fix) which passed ONLY {min}, so the toast literally
 *     showed "Current: ${{current}}" instead of the real balance.
 *
 * The $500 minimum, the completed-trade requirement, the KYC/security gate and
 * the withdrawal processing flow are all UNCHANGED — this pins that too.
 *
 * Run: npm test (or: node --test tests/withdraw_min_current_display.test.js)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, name + ' should be brace-matchable');
    return INDEX.slice(start, end + 1);
}

function extractTranslations() {
    const at = INDEX.indexOf('const TRANSLATIONS');
    assert.ok(at > 0, 'TRANSLATIONS should exist');
    let i = INDEX.indexOf('{', at);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    return INDEX.slice(at, end + 1);
}

// ---------------------------------------------------------------------------
// RUNTIME: run the REAL submitWithdraw + REAL t() with a stubbed DOM.
// ---------------------------------------------------------------------------
function runSubmit({ amount, balance = 350.5, mode = 'PRODUCTION' }) {
    const toasts = [];
    const sandbox = {
        APP: { environment: mode, MIN_WITHDRAWAL: 500, liveData: {} },
        localStorage: { getItem: () => 'jwt', setItem() {}, removeItem() {} },
        getEl: (id) => ({
            value: id === 'withdrawAddressInput' ? 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' : String(amount),
        }),
        getWithdrawableTotal: () => balance,
        showToast: (msg) => toasts.push(msg),
        submitWithdrawAPI: () => { throw new Error('must not submit below the minimum'); },
        console: { log() {}, warn() {}, error() {} },
        currentLang: 'en',
    };
    vm.createContext(sandbox);
    vm.runInContext(
        [extractTranslations(), 'let currentLang = "en";', extractFunction('t'), extractFunction('submitWithdraw')].join('\n'),
        sandbox
    );
    sandbox.submitWithdraw();
    return toasts;
}

test('below-minimum submit renders the actual balance, never a raw placeholder', () => {
    const toasts = runSubmit({ amount: 100 });
    assert.strictEqual(toasts.length, 1, 'exactly one message shown');
    assert.ok(!toasts[0].includes('{{'), 'no uninterpolated placeholder: ' + toasts[0]);
    assert.ok(!toasts[0].includes('current}'), 'the literal ${current} bug is gone');
    assert.match(toasts[0], /Minimum withdrawal is \$500/);
    assert.match(toasts[0], /Current: \$350\.50/, 'shows the real available balance');
});

test('an empty/NaN amount still shows the real balance (not a placeholder)', () => {
    const toasts = runSubmit({ amount: '', balance: 42 });
    assert.strictEqual(toasts.length, 1);
    assert.ok(!toasts[0].includes('{{'));
    assert.match(toasts[0], /Current: \$42\.00/);
});

test('both call sites of withdraw.minWithdrawal pass min AND current', () => {
    const open = extractFunction('openWithdrawModal');
    const submit = extractFunction('submitWithdraw');
    assert.ok(/t\('withdraw\.minWithdrawal',\s*\{min: APP\.MIN_WITHDRAWAL, current:/.test(open), 'modal gate passes current');
    assert.ok(/t\('withdraw\.minWithdrawal',\s*\{min: APP\.MIN_WITHDRAWAL, current:/.test(submit), 'submit passes current');
    assert.ok(submit.includes('getWithdrawableTotal().toFixed(2)'), 'current is the real withdrawable balance');
});

// ---------------------------------------------------------------------------
// BUSINESS RULES UNCHANGED
// ---------------------------------------------------------------------------
test('the $500 minimum withdrawal is untouched (frontend and server)', () => {
    assert.match(INDEX, /MIN_WITHDRAWAL:\s*500/);
    assert.match(SERVER, /const MIN_WITHDRAWAL_USD = 500;/);
    assert.match(SERVER, /amount < MIN_WITHDRAWAL_USD/);
});

test('the withdrawal eligibility gates and flow are unchanged', () => {
    const open = extractFunction('openWithdrawModal');
    assert.ok(open.includes("t('withdraw.firstDeposit')"), 'first-deposit gate intact');
    assert.ok(open.includes("'/api/kyc/can-withdraw'"), 'KYC/security capability check intact');
    assert.ok(open.includes("t('withdraw.needTrade')"), 'completed-trade requirement intact');
    assert.ok(open.includes('totalWithdrawable < APP.MIN_WITHDRAWAL'), '$500 minimum gate intact');
    assert.ok(open.includes('if (!isSandbox)'), 'production-only gate block intact');

    const submit = extractFunction('submitWithdraw');
    assert.ok(submit.includes("t('withdraw.enterAddress')"), 'address validation intact');
    assert.ok(submit.includes('amount > getWithdrawableTotal()'), 'balance check intact');
    assert.ok(submit.includes('submitWithdrawAPI('), 'existing submission flow intact');
});

test('the backend withdrawal route and minimum are not modified', () => {
    assert.match(SERVER, /\/api\/withdraw\/request/);
    // The min error string the server returns is built from the constant (no literal drift).
    assert.ok(!/error:\s*'Min \$700'/.test(SERVER), 'no stale $700 literal');
});
