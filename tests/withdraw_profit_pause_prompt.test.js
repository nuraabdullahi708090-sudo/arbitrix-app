'use strict';

/**
 * Withdraw click while under the $400 profit pause.
 *
 * BUG: a paused account that clicked Withdraw and was below the internal
 * withdrawal minimum saw the withdrawal-minimum prompt. It must instead see the
 * actionable profit-pause prompt ("your bot is paused until a new deposit").
 *
 * SCOPE (display only): the server-side withdrawal rules are UNCHANGED, and a
 * paused account that is otherwise eligible (>= the internal minimum) still
 * reaches the withdrawal form exactly as before. Only the message shown at the
 * minimum gate changes, and only for a paused account.
 *
 * Run: npm test
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
    assert.ok(start >= 0, name + ' must exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, name + ' must be brace-matchable');
    return INDEX.slice(start, end + 1);
}

/* ------------------------------------------------------------------ *
 * Integration: run the REAL openWithdrawModal + REAL pause helpers
 * ------------------------------------------------------------------ */
async function runOpen(opts) {
    const o = opts || {};
    const toasts = [];
    const els = {};
    function makeEl(id) {
        if (!els[id]) {
            const set = new Set();
            els[id] = { id, style: {}, textContent: '', classList: {
                add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) } };
        }
        return els[id];
    }
    const balance = o.balance === undefined ? 500 : o.balance;

    const sandbox = {
        APP: {
            mode: 'live',
            environment: 'PRODUCTION',
            liveData: { balance, hasRealDeposit: true, hasTradingActivity: true },
            bonusData: { balance: 0 },
            MIN_WITHDRAWAL: 700,
            profitPauseNoticeShown: false,
            profitPauseThreshold: null,
        },
        localStorage: { getItem: (k) => (k === 'jwt_token' ? 'tok' : null) },
        getEl: makeEl,
        document: { getElementById: makeEl },
        t: (key, vars) => {
            if (key === 'profitPause.body') {
                return 'PAUSE:' + ((vars && vars.amount !== undefined) ? vars.amount : '');
            }
            return key;
        },
        showToast: (msg) => toasts.push(msg),
        formatCurrency: (n) => '$' + Number(n).toFixed(2),
        syncSandboxWithdrawHistory: () => {},
        fetch: async (url) => {
            if (url.indexOf('/api/kyc/can-withdraw') >= 0) {
                return { ok: true, json: async () => ({ canWithdraw: true }) };
            }
            if (url.indexOf('/api/bot/status') >= 0) {
                if (o.statusThrows) throw new Error('offline');
                if (o.statusNotOk) return { ok: false, json: async () => ({}) };
                return { ok: true, json: async () => ({ profitPaused: o.profitPaused === true, profitPauseThreshold: 400 }) };
            }
            return { ok: false, json: async () => ({}) };
        },
    };
    vm.createContext(sandbox);
    const src = [
        extractFunction('getWithdrawableTotal'),
        extractFunction('openWithdrawModal'),
        extractFunction('isProfitPausedNow'),
        extractFunction('showProfitPauseOnWithdraw'),
        extractFunction('openProfitPauseModal'),
        extractFunction('closeProfitPauseModal'),
        extractFunction('renderProfitPauseBody'),
        extractFunction('rememberProfitPauseThreshold'),
        'globalThis.__p = openWithdrawModal();',
    ].join('\n');
    vm.runInContext(src, sandbox);
    await sandbox.__p;
    return {
        toasts,
        els,
        pauseOpen: makeEl('profitPauseModal').classList.contains('open'),
        formShown: makeEl('withdrawForm').style.display === 'block',
        noticeShown: sandbox.APP.profitPauseNoticeShown,
        threshold: sandbox.APP.profitPauseThreshold,
    };
}

test('paused + below the minimum -> pause prompt, NEVER the minimum message', async () => {
    const r = await runOpen({ profitPaused: true, balance: 500 });
    assert.deepStrictEqual(r.toasts, [], 'no withdrawal-minimum toast may appear');
    assert.strictEqual(r.pauseOpen, true, 'the profit-pause prompt is shown');
    assert.strictEqual(r.formShown, false, 'no withdrawal form is shown');
    assert.strictEqual(r.noticeShown, true, 'the notice guard is set for the page load');
    assert.strictEqual(r.threshold, 400, 'the server threshold is adopted (never hard-coded)');
});

test('not paused + below the minimum -> the existing (neutral) minimum message', async () => {
    const r = await runOpen({ profitPaused: false, balance: 500 });
    assert.strictEqual(r.toasts.length, 1, 'exactly one message');
    assert.strictEqual(r.toasts[0], 'withdraw.minWithdrawal', 'the minimum gate message is unchanged');
    assert.strictEqual(r.pauseOpen, false, 'no pause prompt');
});

test('paused but otherwise eligible -> the withdrawal form (withdrawals unchanged)', async () => {
    const r = await runOpen({ profitPaused: true, balance: 800 });
    assert.deepStrictEqual(r.toasts, [], 'no message at all');
    assert.strictEqual(r.pauseOpen, false, 'no pause prompt hijacks an eligible withdrawal');
    assert.strictEqual(r.formShown, true, 'the eligible user reaches the form as before');
});

test('status check offline -> fail-open: the minimum message, never a false pause', async () => {
    const r = await runOpen({ statusThrows: true, balance: 500 });
    assert.strictEqual(r.toasts.length, 1);
    assert.strictEqual(r.toasts[0], 'withdraw.minWithdrawal');
    assert.strictEqual(r.pauseOpen, false);
});

test('status check non-ok -> fail-open: the minimum message', async () => {
    const r = await runOpen({ statusNotOk: true, balance: 500 });
    assert.strictEqual(r.toasts[0], 'withdraw.minWithdrawal');
    assert.strictEqual(r.pauseOpen, false);
});

/* ------------------------------------------------------------------ *
 * isProfitPausedNow unit behaviour
 * ------------------------------------------------------------------ */
async function runCheck(fetchImpl) {
    const sandbox = {
        APP: { profitPauseThreshold: null },
        localStorage: { getItem: () => 'tok' },
        fetch: fetchImpl,
        rememberProfitPauseThreshold: (b) => { sandbox.APP.profitPauseThreshold = b.profitPauseThreshold; },
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction('isProfitPausedNow') + ';globalThis.__p = isProfitPausedNow();', sandbox);
    return sandbox.__p;
}

test('isProfitPausedNow: true only for a strict profitPaused===true payload', async () => {
    assert.strictEqual(await runCheck(async () => ({ ok: true, json: async () => ({ profitPaused: true }) })), true);
    assert.strictEqual(await runCheck(async () => ({ ok: true, json: async () => ({ profitPaused: false }) })), false);
    assert.strictEqual(await runCheck(async () => ({ ok: true, json: async () => ({ profitPaused: 'true' }) })), false);
    assert.strictEqual(await runCheck(async () => ({ ok: true, json: async () => ({}) })), false);
});

test('isProfitPausedNow: FAIL-OPEN on any error or non-ok response', async () => {
    assert.strictEqual(await runCheck(async () => { throw new Error('network'); }), false);
    assert.strictEqual(await runCheck(async () => ({ ok: false, json: async () => ({}) })), false);
    assert.strictEqual(await runCheck(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })), false);
});

/* ------------------------------------------------------------------ *
 * Source-level ordering + safety
 * ------------------------------------------------------------------ */
test('the pause check runs BEFORE the minimum message inside the minimum gate', () => {
    const open = extractFunction('openWithdrawModal');
    const iPause = open.indexOf('if (await isProfitPausedNow()) { showProfitPauseOnWithdraw(); return; }');
    const iMinToast = open.indexOf("t('withdraw.minWithdrawal', {min: APP.MIN_WITHDRAWAL, current:");
    assert.ok(iPause > 0, 'the pause branch must exist');
    assert.ok(iMinToast > iPause, 'the pause branch must precede the minimum toast');
    assert.ok(open.indexOf('totalWithdrawable < APP.MIN_WITHDRAWAL') < iPause, 'it stays inside the minimum gate');
});

test('the server-side withdrawal logic is unchanged (display-only fix)', () => {
    const route = SERVER.slice(SERVER.indexOf("app.post('/api/withdraw/request'"), SERVER.indexOf("app.post('/api/withdraw/request'") + 6000);
    assert.ok(/const MIN_WITHDRAWAL_USD = 700;/.test(SERVER), 'minimum unchanged');
    assert.ok(/amount < MIN_WITHDRAWAL_USD/.test(route), 'minimum enforced server-side');
    assert.ok(!/profitPause|isProfitPaused/.test(route), 'the pause must NOT gate withdrawals server-side');
});

test('the pause prompt is the only surface and reveals no $700', () => {
    const body = INDEX.match(/'profitPause\.body':\s*'([^']*)'/);
    assert.ok(body && !/\$?700/.test(body[1]), 'pause copy must not mention 700');
    assert.ok(!/\$700/.test(INDEX.split('const TRANSLATIONS')[1].split('};')[0]), 'no $700 in user-facing strings');
});
