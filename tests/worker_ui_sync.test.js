'use strict';

/**
 * LIVE WORKER UI SYNCHRONIZATION (Step 1) — tests.
 *
 * While a LIVE bot session is running (browser- OR worker-owned), the dashboard
 * must reflect the authoritative server state - above all the trades the tab did
 * NOT execute because a server-side worker owns the session. This adds a
 * lightweight 8s sync loop that REUSES syncWalletFromServer() (Live Available
 * Balance, Today's P&L, Trade Log, transaction history) and also polls
 * /api/bot/status so a worker-stopped session flips RUNNING -> OFFLINE.
 *
 * Guarantees pinned here:
 *   - 8s cadence, live + authenticated only;
 *   - reuses syncWalletFromServer() (no duplicated wallet/transaction parsing);
 *   - polls /api/bot/status; worker-owned -> RUNNING + tab loop NOT restarted;
 *   - worker stopped the session -> OFFLINE, with NO /api/bot/stop sent;
 *   - the loop NEVER calls /api/trade and NEVER (re)starts the browser interval;
 *   - overlapping ticks are suppressed (workerSyncInFlight);
 *   - the interval is cleared on stop and on logout.
 *
 * Run: npm test (or: node --test tests/worker_ui_sync.test.js)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

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

// A function body should never restart the browser engine or place a trade.
function assertNoTabEngine(body, label) {
    assert.ok(!/executeBotTrade/.test(body), label + ' must not invoke the browser trade engine');
    assert.ok(!/['"`]\/api\/trade['"`]|fetch\(['"`]\/api\/trade/.test(body), label + ' must not POST /api/trade');
    assert.ok(!/setInterval\s*\(\s*executeBotTrade/.test(body), label + ' must not restart the browser interval');
}

// ---------------------------------------------------------------------------
// Runtime sandbox: the REAL loop functions, stubbed collaborators.
// ---------------------------------------------------------------------------
function buildSandbox(opts = {}) {
    const {
        botRunning = true,
        mode = 'live',
        environment = 'PRODUCTION',
        token = 'jwt',
        status = null,
    } = opts;

    const calls = { sync: 0, adopt: 0, statusFetch: 0, intervals: [], cleared: [], updateStatus: [], profitPauseNotice: 0 };
    const APP = {
        mode, environment, botRunning,
        botInterval: null, workerSyncInterval: null, workerSyncInFlight: false,
        botExecutedBy: 'browser',
    };
    const store = token ? { jwt_token: token } : {};

    const sandbox = {
        APP, calls,
        localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem() {}, removeItem() {} },
        console: { log() {}, warn() {}, error() {} },
        setInterval: (fn, ms) => { const h = { fn, ms, __iv: true }; calls.intervals.push(ms); return h; },
        clearInterval: (h) => { calls.cleared.push(h); },
        fetchBotExecutionStatus: async () => { calls.statusFetch++; return status; },
        syncWalletFromServer: async () => { calls.sync++; return { ok: true, funded: false }; },
        adoptWorkerOwnership: () => { calls.adopt++; },
        updateStatus: (r) => { calls.updateStatus.push(r); },
        updateUI: () => {},
        updateBotEngineNotice: () => {},
        // TEMPORARY (management test): the profit-pause pop-up collaborator.
        maybeShowProfitPauseModal: () => { calls.profitPauseNotice++; },
    };
    vm.createContext(sandbox);
    vm.runInContext(
        [
            'const WORKER_SYNC_INTERVAL_MS = 8000;',
            extractFunction('startWorkerSyncLoop'),
            extractFunction('stopWorkerSyncLoop'),
            extractFunction('runWorkerSyncTick'),
            extractFunction('handleServerSessionEnded'),
        ].join('\n'),
        sandbox
    );
    return sandbox;
}

// ---------------------------------------------------------------------------
// 1. SOURCE CONTRACT — the loop reuses existing sync, never trades
// ---------------------------------------------------------------------------
test('loop cadence is exactly 8s and it reuses syncWalletFromServer()', () => {
    assert.match(INDEX, /const WORKER_SYNC_INTERVAL_MS = 8000;/);
    assert.match(extractFunction('startWorkerSyncLoop'), /setInterval\(runWorkerSyncTick, WORKER_SYNC_INTERVAL_MS\)/);
    const tick = extractFunction('runWorkerSyncTick');
    assert.ok(tick.includes('syncWalletFromServer()'), 'reuses the existing sync helper');
    assert.ok(tick.includes('fetchBotExecutionStatus()'), 'polls /api/bot/status');
    // No duplicated wallet/transaction parsing.
    for (const marker of ['/api/auth/me', '/api/transactions', 'depositHistory', 'liveData.balance', 'todayRealizedPnl']) {
        assert.ok(!tick.includes(marker), 'must not duplicate parsing: ' + marker);
    }
});

test('the sync loop never calls /api/trade and never restarts the browser interval', () => {
    for (const fn of ['startWorkerSyncLoop', 'stopWorkerSyncLoop', 'runWorkerSyncTick', 'handleServerSessionEnded']) {
        assertNoTabEngine(extractFunction(fn), fn);
    }
    // It must not (re-)assign the browser interval anywhere in the loop region.
    const region = INDEX.slice(
        INDEX.indexOf('const WORKER_SYNC_INTERVAL_MS = 8000;'),
        INDEX.indexOf('function adoptServerBotState()')
    );
    assert.ok(!/APP\.botInterval\s*=\s*setInterval/.test(region), 'must not restart the tab loop');
});

test('the loop is wired to start on startBot/adoptWorkerOwnership and stop on stopBot/logout', () => {
    assert.ok(extractFunction('startBot').includes('startWorkerSyncLoop()'), 'startBot starts the sync loop');
    assert.ok(extractFunction('adoptWorkerOwnership').includes('startWorkerSyncLoop()'), 'worker adoption starts the sync loop');
    assert.ok(extractFunction('stopBot').includes('stopWorkerSyncLoop()'), 'stopBot stops the sync loop');
    const logoutIdx = INDEX.indexOf("localStorage.removeItem('jwt_token')");
    assert.ok(logoutIdx > 0);
    assert.ok(INDEX.slice(logoutIdx - 1200, logoutIdx).includes('stopWorkerSyncLoop()'), 'logout clears the sync loop');
});

test('overlap guard and authenticated/live gating are present in source', () => {
    assert.ok(extractFunction('runWorkerSyncTick').includes('APP.workerSyncInFlight'), 'in-flight guard');
    assert.ok(extractFunction('stopWorkerSyncLoop').includes('workerSyncInFlight'), 'stop resets the guard');
    const start = extractFunction('startWorkerSyncLoop');
    assert.ok(start.includes("APP.mode !== 'live'"), 'live-only');
    assert.ok(start.includes("jwt_token"), 'authenticated-only');
    assert.ok(start.includes("MARKETING_SANDBOX"), 'sandbox excluded');
});

test('a server-stopped session is reflected without sending /api/bot/stop', () => {
    const ended = extractFunction('handleServerSessionEnded');
    assert.ok(ended.includes('updateStatus(false)'), 'flips to OFFLINE');
    assert.ok(!/syncBotSessionWithServer/.test(ended), 'must not send a bot stop');
    assert.ok(!/@\/api\/bot\/stop|api\/bot\/stop/.test(ended), 'must not hit /api/bot/stop');
});

// ---------------------------------------------------------------------------
// 2. RUNTIME — start/stop gating
// ---------------------------------------------------------------------------
test('startWorkerSyncLoop: live + authenticated starts an 8s interval', () => {
    const sb = buildSandbox({ mode: 'live', token: 'jwt' });
    sb.startWorkerSyncLoop();
    assert.deepStrictEqual(sb.calls.intervals, [8000]);
    assert.ok(sb.APP.workerSyncInterval, 'interval handle stored');
});

test('startWorkerSyncLoop: demo / sandbox / unauthenticated are no-ops', () => {
    const demo = buildSandbox({ mode: 'demo' });
    demo.startWorkerSyncLoop();
    assert.deepStrictEqual(demo.calls.intervals, []);

    const sandbox = buildSandbox({ environment: 'MARKETING_SANDBOX' });
    sandbox.startWorkerSyncLoop();
    assert.deepStrictEqual(sandbox.calls.intervals, []);

    const anon = buildSandbox({ token: null });
    anon.startWorkerSyncLoop();
    assert.deepStrictEqual(anon.calls.intervals, []);
});

test('startWorkerSyncLoop: never double-starts', () => {
    const sb = buildSandbox();
    sb.APP.workerSyncInterval = { __already: true };
    sb.startWorkerSyncLoop();
    assert.deepStrictEqual(sb.calls.intervals, [], 'no second interval');
});

test('stopWorkerSyncLoop: clears the interval and resets the in-flight guard', () => {
    const sb = buildSandbox();
    const handle = { __iv: true };
    sb.APP.workerSyncInterval = handle;
    sb.APP.workerSyncInFlight = true;
    sb.stopWorkerSyncLoop();
    assert.deepStrictEqual(sb.calls.cleared, [handle]);
    assert.strictEqual(sb.APP.workerSyncInterval, null);
    assert.strictEqual(sb.APP.workerSyncInFlight, false);
});

// ---------------------------------------------------------------------------
// 3. RUNTIME — tick behavior
// ---------------------------------------------------------------------------
test('tick: overlapping syncs are suppressed', async () => {
    const sb = buildSandbox({ status: { isRunning: true, executedBy: 'worker' } });
    sb.APP.workerSyncInFlight = true;
    await sb.runWorkerSyncTick();
    assert.strictEqual(sb.calls.statusFetch, 0, 'no status fetch while a sync is in flight');
    assert.strictEqual(sb.calls.sync, 0, 'no wallet sync while a sync is in flight');
});

test('tick: not running -> the loop stops itself', async () => {
    const sb = buildSandbox({ botRunning: false });
    const handle = { __iv: true };
    sb.APP.workerSyncInterval = handle;
    await sb.runWorkerSyncTick();
    assert.strictEqual(sb.calls.statusFetch, 0, 'no polling once the bot is not running');
    assert.deepStrictEqual(sb.calls.cleared, [handle], 'interval cleared');
    assert.strictEqual(sb.APP.workerSyncInterval, null);
});

test('tick: worker-owned running session -> adopt worker, sync, no tab trade', async () => {
    const sb = buildSandbox({ status: { isRunning: true, executedBy: 'worker' } });
    await sb.runWorkerSyncTick();
    assert.strictEqual(sb.calls.adopt, 1, 'UI adopts worker ownership (RUNNING, tab loop off)');
    assert.strictEqual(sb.calls.sync, 1, 'authoritative state synced');
    assert.strictEqual(sb.APP.botInterval, null, 'browser interval NOT restarted');
    assert.strictEqual(sb.APP.workerSyncInFlight, false, 'guard released');
});

test('tick: browser-owned running session -> no worker adopt, still syncs', async () => {
    const sb = buildSandbox({ status: { isRunning: true, executedBy: 'browser' } });
    await sb.runWorkerSyncTick();
    assert.strictEqual(sb.calls.adopt, 0);
    assert.strictEqual(sb.calls.sync, 1);
});

test('tick: server session ended -> RUNNING becomes OFFLINE and the loop stops', async () => {
    const sb = buildSandbox({ status: { isRunning: false } });
    const handle = { __iv: true };
    sb.APP.workerSyncInterval = handle;
    sb.APP.botExecutedBy = 'worker';
    await sb.runWorkerSyncTick();
    assert.strictEqual(sb.calls.sync, 1, 'refreshes authoritative state once');
    assert.strictEqual(sb.calls.adopt, 0, 'does not adopt ownership');
    assert.strictEqual(sb.APP.botRunning, false, 'UI is now stopped');
    assert.deepStrictEqual(sb.calls.updateStatus, [false], 'status rendered OFFLINE');
    assert.deepStrictEqual(sb.calls.cleared, [handle], 'polling interval cleared');
    assert.strictEqual(sb.APP.workerSyncInterval, null);
    assert.strictEqual(sb.APP.botInterval, null, 'browser interval never started');
});

test('tick: a failed status/sync keeps state and never throws', async () => {
    const sb = buildSandbox();
    sb.fetchBotExecutionStatus = async () => { throw new Error('network down'); };
    await sb.runWorkerSyncTick();
    assert.strictEqual(sb.APP.workerSyncInFlight, false, 'guard released even on error');
    assert.strictEqual(sb.APP.botRunning, true, 'state preserved on failure');
});
