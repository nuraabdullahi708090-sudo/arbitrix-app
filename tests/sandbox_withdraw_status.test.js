'use strict';

/**
 * MARKETING SANDBOX withdraw-history "Withdrawn" status — regression tests.
 *
 * Before this fix, a sandbox withdrawal wrote a client-side history entry with
 * status 'Processing' that never changed, even though the server simulates the
 * full payout lifecycle (pending -> processing ~20s -> completed ~75s via
 * advanceSandboxWithdrawals() on GET /api/withdraw/history). Pins:
 *  - syncSandboxWithdrawHistory() exists, is sandbox-guarded (no-op for
 *    production accounts), fetches /api/withdraw/history, and maps the raw
 *    server status 'completed' -> display 'Withdrawn';
 *  - it is called from syncWalletFromServer() (survives reload/login), from
 *    openWithdrawModal() (refresh on open), and via delayed re-syncs after a
 *    sandbox withdrawal is submitted (Processing -> Withdrawn without reload);
 *  - production behavior is unchanged: the local 'Processing' unshift is kept,
 *    the delayed re-syncs only fire for MARKETING_SANDBOX, and production
 *    withdraw history stays client-side;
 *  - server-side sandbox lifecycle is unchanged (advanceSandboxWithdrawals
 *    thresholds + handleSandboxWithdrawHistory untouched).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Extract a top-level function body by brace matching (keeps the `async `
// prefix when present so vm-eval of async bodies parses).
function extractFunction(src, name) {
    let start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist');
    if (src.slice(start - 6, start) === 'async ') start -= 6;
    let i = src.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, name + ' should be brace-matchable');
    return src.slice(start, end + 1);
}

test('syncSandboxWithdrawHistory exists and is sandbox-guarded', () => {
    const fn = extractFunction(INDEX, 'syncSandboxWithdrawHistory');
    assert.ok(
        fn.includes("if (APP.environment !== 'MARKETING_SANDBOX') return;"),
        'must no-op for non-sandbox accounts'
    );
    assert.ok(fn.includes("fetch('/api/withdraw/history'"), 'must fetch the withdrawal history endpoint');
    assert.ok(fn.includes('APP.withdrawHistory = rows.map'), 'must rebuild the Recent list from server rows');
});

test('server status completed maps to display Withdrawn', () => {
    const fn = extractFunction(INDEX, 'syncSandboxWithdrawHistory');
    assert.ok(fn.includes("completed: 'Withdrawn'"), 'completed -> Withdrawn');
    assert.ok(fn.includes("processing: 'Processing'"), 'processing -> Processing');
    assert.ok(fn.includes("pending: 'Pending'"), 'pending -> Pending');
    assert.ok(fn.includes("rejected: 'Rejected'"), 'rejected -> Rejected');
});

test('syncSandboxWithdrawHistory functionally maps server rows (vm)', () => {
    const fn = extractFunction(INDEX, 'syncSandboxWithdrawHistory');
    const calls = [];
    const APP = { environment: 'MARKETING_SANDBOX', withdrawHistory: [] };
    const rows = [
        { amount: 25, address: 'TRJdD9x53p6jHGBSb8hUi5yu9xVPkCxicb', status: 'completed', created_at: '2026-08-22T10:00:00Z' },
        { amount: 10, address: 'TAbcdEfgh', status: 'processing', created_at: '2026-08-22T11:00:00Z' },
        { amount: 5, address: 'TXyz', status: 'rejected', created_at: '2026-08-22T12:00:00Z' },
    ];
    const sandbox = {
        APP,
        localStorage: { getItem: () => 'tok' },
        fetch: async (url) => { calls.push(url); return { ok: true, json: async () => rows }; },
        saveData: () => {},
        updateUI: () => {},
        console,
        Number,
        Date,
    };
    vm.createContext(sandbox);
    vm.runInContext(fn + '\nthis.__run = syncSandboxWithdrawHistory;', sandbox);
    return sandbox.__run().then(() => {
        assert.deepStrictEqual(calls, ['/api/withdraw/history']);
        assert.strictEqual(APP.withdrawHistory.length, 3);
        assert.strictEqual(APP.withdrawHistory[0].status, 'Withdrawn');
        assert.strictEqual(APP.withdrawHistory[0].amount, 25);
        assert.strictEqual(APP.withdrawHistory[0].address, 'TRJdD9...');
        assert.strictEqual(APP.withdrawHistory[1].status, 'Processing');
        assert.strictEqual(APP.withdrawHistory[2].status, 'Rejected');
    });
});

test('syncSandboxWithdrawHistory is a no-op for production accounts (vm)', () => {
    const fn = extractFunction(INDEX, 'syncSandboxWithdrawHistory');
    let fetched = 0;
    const APP = { environment: 'PRODUCTION', withdrawHistory: [{ amount: 1, status: 'Processing' }] };
    const sandbox = {
        APP,
        localStorage: { getItem: () => 'tok' },
        fetch: async () => { fetched++; return { ok: true, json: async () => [] }; },
        saveData: () => {},
        updateUI: () => {},
        console,
        Number,
        Date,
    };
    vm.createContext(sandbox);
    vm.runInContext(fn + '\nthis.__run = syncSandboxWithdrawHistory;', sandbox);
    return sandbox.__run().then(() => {
        assert.strictEqual(fetched, 0, 'production accounts must never fetch sandbox history');
        assert.strictEqual(APP.withdrawHistory.length, 1, 'production history untouched');
        assert.strictEqual(APP.withdrawHistory[0].status, 'Processing');
    });
});

test('called from syncWalletFromServer (reload persistence)', () => {
    const fn = extractFunction(INDEX, 'syncWalletFromServer');
    assert.ok(fn.includes('await syncSandboxWithdrawHistory();'), 'syncWalletFromServer must reconcile sandbox withdrawals');
});

test('called from openWithdrawModal (refresh on open)', () => {
    const fn = extractFunction(INDEX, 'openWithdrawModal');
    assert.ok(fn.includes('syncSandboxWithdrawHistory();'), 'openWithdrawModal must refresh sandbox withdrawal statuses');
});

test('submitWithdrawAPI keeps local Processing entry and schedules sandbox-only re-syncs', () => {
    const fn = extractFunction(INDEX, 'submitWithdrawAPI');
    assert.ok(fn.includes("status:'Processing'"), 'local Processing entry preserved');
    assert.ok(
        fn.includes("if (APP.environment === 'MARKETING_SANDBOX')"),
        'delayed re-syncs must be sandbox-only'
    );
    assert.ok(fn.includes('setTimeout(syncSandboxWithdrawHistory, 25000)'), 're-sync after ~20s processing threshold');
    assert.ok(fn.includes('setTimeout(syncSandboxWithdrawHistory, 80000)'), 're-sync after ~75s completion threshold');
});

test('server-side sandbox withdrawal lifecycle is unchanged', () => {
    const advance = extractFunction(SERVER, 'advanceSandboxWithdrawals');
    assert.ok(advance.includes("row.status === 'pending' && elapsed > 20 * 1000"), 'pending -> processing at ~20s unchanged');
    assert.ok(advance.includes("row.status === 'processing' && elapsed > 75 * 1000"), 'processing -> completed at ~75s unchanged');
    assert.ok(advance.includes("update({ status: 'completed' })"), 'completed transition unchanged');
    const history = extractFunction(SERVER, 'handleSandboxWithdrawHistory');
    assert.ok(history.includes('await advanceSandboxWithdrawals(userId);'), 'history endpoint still lazily advances states');
});
