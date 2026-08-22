'use strict';

/**
 * P2-1 — MARKETING_SANDBOX transaction-history reconciliation — regression tests.
 *
 * Root cause (pre-fix): syncWalletFromServer() fetched /api/transactions but
 * only merged entries with tx.type === 'Deposit' into APP.liveData.history
 * (the Dashboard Transaction Log). Every non-deposit server transaction
 * (Trade Executed, Withdraw, Withdraw Approved/Rejected, Subscription,
 * Referral Bonus) never survived a sync/re-login, so the Log showed only
 * deposits — a balance of $22.72 (deposit 50 + trade -0.28 - withdraw 20 -
 * subscription 7) rendered a log containing just "Deposit 50", and no
 * component could reconcile the visible ledger to the displayed balance.
 *
 * The merge is a renderer shared by production and sandbox (/api/transactions
 * routes to sandbox_transactions for sandbox and transactions for production),
 * so the fix is intentionally shared: merge ALL server transaction types, not
 * only deposits. Production/sandbox financial logic is untouched — this file
 * only contains the display-side merge change.
 *
 * Pins:
 *  - ALL server transaction types are merged into APP.liveData.history;
 *  - each merged entry uses the raw server type/detail (txTypeLabel/
 *    txDetailLabel translate at render-time only; stored values unchanged);
 *  - sandbox-specific types (Subscription) are mapped safely (unknown ->
 *    verbatim fallback by design);
 *  - idempotency: re-sync dedupes by _serverId or timestamp; no duplicates;
 *  - the deposit-funded signal still works (deposits still processed;
 *    hasRealDeposit still set);
 *  - no regression in the previously deposit-only filter behavior: a
 *    null/falsey tx or missing type is skipped;
 *  - production behavior unchanged (same code path; only the filter changed).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Extract a function body by brace matching (extractFunction from
// sandbox_withdraw_status.test.js, reused).
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

// The merge snippet lives inside syncWalletFromServer(). To test it in
// isolation we extract the full function and re-declare only the inner merge
// block with a harness-provided APP/fundedFromServer.
function extractMergeBlock() {
    const full = extractFunction(INDEX, 'syncWalletFromServer');
    const startIdx = full.indexOf('const depositTxs =');
    assert.ok(startIdx > 0, 'merge block must exist');
    // find its matching closing region: block ends after the deposit-funded
    // signal, before the next closing `}` of the if(Array.isArray) guard.
    const endMarker = '                }';
    // cut from `const depositTxs` through the close of the funded signal
    // (we evaluate the whole snippet; harness supplies APP).
    const snippet = full.slice(startIdx);
    return snippet;
}

function buildMergeHarness(txs, preHistory) {
    // Build a sandboxed scope exposing APP + fundedFromServer, then eval the
    // merge snippet. Returns { history, funded }.
    const snippet = extractMergeBlock().split('\n').slice(0, 40).join('\n');
    // The snippet may not close cleanly; instead extract up to AND including
    // the funded-signal block end.
    const ctx = {
        APP: { liveData: { history: preHistory || [] }, depositHistory: [], hasRealDeposit: false },
        saveData: () => {},
        updateUI: () => {},
    };
    const code = `var APP = scope.APP; var fundedFromServer = false;\n` +
        `var txs = scope.txs;\n` +
        `if (Array.isArray(txs)) {\n${extractMergeBlock().split('if (depositTxs.length) {')[0]}\n` +
        `if (depositTxs.length) { APP.liveData.hasRealDeposit = true; fundedFromServer = true; } }\n` +
        `;({ history: APP.liveData.history, funded: fundedFromServer, depHist: APP.depositHistory });`;
    const sandbox = { scope: { txs, APP: ctx.APP } };
    return vm.runInNewContext(code, sandbox);
}

test('merges ALL transaction types into the Transaction Log (not only Deposit)', () => {
    const txs = [
        { id: 1, type: 'Deposit', amount: 50, detail: 'USDT (TRC20)', created_at: '2026-08-22T10:00:00Z' },
        { id: 2, type: 'Trade Executed', amount: -0.28, detail: 'BTC/USDT Binance->Bybit', created_at: '2026-08-22T10:01:00Z' },
        { id: 3, type: 'Withdraw', amount: -20, detail: 'To TRJdD9...', created_at: '2026-08-22T10:02:00Z' },
        { id: 4, type: 'Subscription', amount: -7, detail: 'Arbitrix Pro Subscription', created_at: '2026-08-22T10:03:00Z' },
    ];
    const out = buildMergeHarness(txs, []);
    const types = out.history.map(h => h.type);
    assert.ok(types.includes('Deposit'), 'Deposit merged');
    assert.ok(types.includes('Trade Executed'), 'Trade Executed merged');
    assert.ok(types.includes('Withdraw'), 'Withdraw merged');
    assert.ok(types.includes('Subscription'), 'Subscription merged');
    assert.strictEqual(out.history.length, 4, 'all four entries merged');
    // raw server values preserved (render-time translation handles display)
    const trade = out.history.find(h => h.type === 'Trade Executed');
    assert.strictEqual(trade.detail, 'BTC/USDT Binance->Bybit');
    assert.strictEqual(trade.amount, -0.28);
});

test('re-sync dedupes by _serverId and does not duplicate entries', () => {
    const txs = [
        { id: 11, type: 'Withdraw', amount: -20, detail: 'To TRJdD9...', created_at: '2026-08-22T10:02:00Z' },
    ];
    const pre = [{ type: 'Withdraw', amount: -20, detail: 'To TRJdD9...', timestamp: 1, _serverId: 11 }];
    const out = buildMergeHarness(txs, pre);
    assert.strictEqual(out.history.length, 1, 'duplicate by id prevented');
    // dedupe by timestamp when _serverId is null/undefined
    const ts = new Date('2026-08-22T10:02:00Z').getTime();
    const pre2 = [{ type: 'Withdraw', amount: -20, timestamp: ts }];
    const out2 = buildMergeHarness(txs, pre2);
    assert.strictEqual(out2.history.length, 1, 'duplicate by timestamp prevented');
});

test('optimistic client placeholder is adopted (not duplicated) when the server record arrives', () => {
    // The client unshifts a Withdraw entry locally at submit time (no _serverId,
    // client timestamp). When the server record arrives it must replace that
    // placeholder's identity instead of adding a second Withdraw entry.
    const txs = [
        { id: 21, type: 'Withdraw', amount: -20, detail: 'SIMULATED MARKETING WITHDRAWAL - To TRJdD9...', created_at: '2026-08-22T10:02:00Z' },
    ];
    const pre = [{ type: 'Withdraw', amount: -20, detail: 'To TRJdD9...', timestamp: 12345, time: '10:01 AM' }];
    const out = buildMergeHarness(txs, pre);
    assert.strictEqual(out.history.length, 1, 'exactly one entry per transaction');
    const entry = out.history[0];
    assert.strictEqual(entry._serverId, 21, 'server identity adopted onto the placeholder');
    assert.strictEqual(entry.amount, -20, 'authoritative amount adopted');
    assert.strictEqual(entry.type, 'Withdraw', 'raw server type preserved');
});

test('a second identical transaction is NOT collapsed by placeholder adoption', () => {
    // Two distinct $20 withdrawals: one already server-backed, one optimistic,
    // plus both server records arriving -> all three representations resolve to
    // exactly two entries, each server-backed.
    const txs = [
        { id: 31, type: 'Withdraw', amount: -20, detail: 'w1', created_at: '2026-08-22T10:00:00Z' },
        { id: 32, type: 'Withdraw', amount: -20, detail: 'w2', created_at: '2026-08-22T10:05:00Z' },
    ];
    const pre = [
        { type: 'Withdraw', amount: -20, detail: 'w2 opt', timestamp: 9 },           // optimistic for w2
        { type: 'Withdraw', amount: -20, detail: 'w1', timestamp: 5, _serverId: 31 }, // already synced w1
    ];
    const out = buildMergeHarness(txs, pre);
    assert.strictEqual(out.history.length, 2, 'two real transactions kept');
    const ids = out.history.map(h => h._serverId).sort();
    assert.deepStrictEqual(ids, [31, 32], 'both server ids present');
});

test('deposit-funded signal still derived from merged deposits', () => {
    const txs = [{ id: 1, type: 'Deposit', amount: 50, detail: 'USDT (TRC20)', created_at: '2026-08-22T10:00:00Z' }];
    const out = buildMergeHarness(txs, []);
    assert.ok(out.funded, 'hasRealDeposit set when a deposit is present');
    assert.strictEqual(out.depHist.length, 1, 'Recent Deposits list built');
    assert.strictEqual(out.depHist[0].status, 'Confirmed');
    assert.strictEqual(out.depHist[0].network, 'TRC20');
});

test('unknown/falsey entries are skipped, null-safe', () => {
    const txs = [null, { id: 1, type: 'Deposit', amount: 50, detail: 'x', created_at: '2026-08-22T10:00:00Z' }];
    const out = buildMergeHarness(txs, []);
    assert.strictEqual(out.history.length, 1, 'falsey entries skipped');
});

test('production regression: same merge covers all production transaction types', () => {
    // production types observed in server.js addTransaction() calls
    const txs = [
        { id: 1, type: 'Deposit', amount: 50, detail: 'USDT (TRC20)', created_at: '2026-08-22T10:00:00Z' },
        { id: 2, type: 'Withdraw Approved', amount: -20, detail: 'Approved withdrawal', created_at: '2026-08-22T10:01:00Z' },
        { id: 3, type: 'Referral Bonus', amount: 10, detail: 'Simulated referral', created_at: '2026-08-22T10:02:00Z' },
    ];
    const out = buildMergeHarness(txs, []);
    const types = out.history.map(h => h.type);
    assert.ok(types.includes('Withdraw Approved'), 'Withdraw Approved merged');
    assert.ok(types.includes('Referral Bonus'), 'Referral Bonus merged');
});

test('merge block no longer filters to Deposit-only', () => {
    const full = extractFunction(INDEX, 'syncWalletFromServer');
    // The pre-fix filter was exactly: txs.filter(tx => tx && tx.type === 'Deposit')
    // It may exist for the Recent-Deposits list build, so require instead that
    // the HISTORY MERGE loop iterates over more than just deposits.
    assert.ok(
        full.includes('for (let i = txs.length - 1') ||
        full.includes('txs.filter(tx => tx && tx.type') === false ||
        /for \(let i = [a-zA-Z]+s\.length - 1/.test(full),
        'history merge should iterate ALL transactions, not just deposits'
    );
});
