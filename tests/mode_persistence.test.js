'use strict';

/**
 * Per-account Demo/Live MODE PERSISTENCE — regression tests.
 *
 * WHY THIS EXISTS
 *   Mode used to be pure in-memory state (APP.mode defaulted to 'demo') that was
 *   reset on logout, and initApp() only auto-switched to Live for a funded
 *   account (hasRealDeposit). A promo-only user (no qualifying deposit, $50
 *   promotional credit) therefore always returned in DEMO, so
 *   adoptServerBotState() - which returns early unless APP.mode === 'live' -
 *   never discovered the already-running server-side worker session.
 *
 *   The fix persists the user's EXPLICIT Demo/Live choice per account
 *   (arbi_mode_<userId>, following the arbi_onboarding_<userId> convention) and
 *   restores it in initApp(); the funding-based default is used ONLY when there
 *   is no stored choice. Restoring a mode NEVER starts a bot.
 *
 * These tests execute the REAL helpers and the REAL initApp mode-decision block
 * in a vm sandbox. No worker, promo-rule, deposit-gate, withdrawal or logout
 * behaviour is changed or asserted as changed.
 *
 * Run: npm test (or: node --test tests/mode_persistence.test.js)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const WORKER = fs.readFileSync(path.join(ROOT, 'services', 'TradingWorker.js'), 'utf8');
const WORKER_ENTRY = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// --- brace-matching extractor (same approach as the existing suites) ---
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

// The exact initApp mode-decision block (persisted choice -> funding default).
function extractInitModeBlock() {
    const start = INDEX.indexOf('const persistedMode = (typeof getPersistedMode');
    const end = INDEX.indexOf('// BACKGROUND TRADING:', start);
    assert.ok(start > 0 && end > start, 'initApp mode-decision block should exist');
    return INDEX.slice(start, end);
}

// --------------------------------------------------------------------------
// Sandbox: REAL persistence helpers + REAL setMode (collaborators stubbed).
// --------------------------------------------------------------------------
function makeHelpers(store, user) {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; },
        },
        JSON, String,
    };
    sandbox.currentCachedUser = () => user;
    vm.createContext(sandbox);
    vm.runInContext(
        [
            extractFunction('currentCachedUser').replace(
                /function currentCachedUser\(\) \{[\s\S]*?\n\}/,
                'function currentCachedUser(){ return globalThis.__user; }'
            ),
            extractFunction('modePreferenceKey'),
            extractFunction('getPersistedMode'),
            extractFunction('setPersistedMode'),
        ].join('\n'),
        sandbox
    );
    sandbox.__user = user;
    return sandbox;
}

// --------------------------------------------------------------------------
// 1. PROMO MODE PERSISTENCE — persisted "live" restores Live with no deposit
// --------------------------------------------------------------------------
test('1. promo-only user with persisted mode="live" restores APP.mode="live"', () => {
    const store = { arbi_user: JSON.stringify({ id: 7 }), arbi_mode_7: 'live' };
    const sandbox = makeHelpers(store, { id: 7 });
    const APP = { mode: 'demo' };
    const calls = { setMode: [], updateUI: 0, startDemo: 0 };
    sandbox.APP = APP;
    sandbox.syncResult = { ok: true, funded: false }; // promo-only: hasRealDeposit=false
    sandbox.setMode = (m) => { calls.setMode.push(m); APP.mode = m; };
    sandbox.updateUI = () => { calls.updateUI++; };
    sandbox.trackMetaConversion = () => { calls.startDemo++; };
    vm.runInContext(extractInitModeBlock(), sandbox);

    assert.strictEqual(APP.mode, 'live', 'persisted Live must be restored for a promo-only user');
    assert.deepStrictEqual(calls.setMode, ['live'], 'the mode is applied through setMode');
    assert.strictEqual(calls.startDemo, 0, 'no StartDemo event when the resolved mode is Live');
});

// --------------------------------------------------------------------------
// 2. PROMO WORKER ADOPTION — restored Live + running worker -> adopt
// --------------------------------------------------------------------------
test('2. with restored Live, adoptServerBotState() polls /api/bot/status and adopts a running worker session', async () => {
    const store = { arbi_user: JSON.stringify({ id: 7 }), arbi_mode_7: 'live' };
    const sandbox = makeHelpers(store, { id: 7 });
    const calls = { status: 0, adopt: 0 };
    sandbox.APP = { mode: 'live', environment: 'PRODUCTION' };
    sandbox.fetchBotExecutionStatus = async () => { calls.status++; return { isRunning: true, executedBy: 'worker' }; };
    sandbox.adoptWorkerOwnership = () => { calls.adopt++; };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction('adoptServerBotState'), sandbox);

    await Promise.resolve(sandbox.adoptServerBotState());
    assert.strictEqual(calls.status, 1, 'status must be queried once the mode is Live');
    assert.strictEqual(calls.adopt, 1, 'a running worker session must be adopted');
});

// --------------------------------------------------------------------------
// 3. PROMO NO-RUNNING-SESSION — Live restored but bot stays stopped; no start
// --------------------------------------------------------------------------
test('3. persisted Live with no server session: mode stays Live, bot NOT auto-started', async () => {
    const store = { arbi_user: JSON.stringify({ id: 7 }), arbi_mode_7: 'live' };
    const sandbox = makeHelpers(store, { id: 7 });
    const calls = { status: 0, adopt: 0, startBot: 0 };
    sandbox.APP = { mode: 'live', environment: 'PRODUCTION' };
    sandbox.fetchBotExecutionStatus = async () => { calls.status++; return { isRunning: false, executedBy: 'browser' }; };
    sandbox.adoptWorkerOwnership = () => { calls.adopt++; };
    sandbox.startBot = () => { calls.startBot++; };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction('adoptServerBotState'), sandbox);

    await Promise.resolve(sandbox.adoptServerBotState());
    assert.strictEqual(calls.adopt, 0, 'no session -> nothing adopted');
    assert.strictEqual(calls.startBot, 0, 'adoption must never start a bot');
    // The mode-decision block itself must not start the bot either.
    assert.ok(!extractInitModeBlock().includes('startBot'), 'restoring a mode must not call startBot()');
});

// --------------------------------------------------------------------------
// 4. EXPLICIT DEMO CHOICE — a funded user is NOT forced back to Live
// --------------------------------------------------------------------------
test('4. funded user with persisted mode="demo" stays Demo (hasRealDeposit must not override)', () => {
    const store = { arbi_user: JSON.stringify({ id: 3 }), arbi_mode_3: 'demo' };
    const sandbox = makeHelpers(store, { id: 3 });
    const APP = { mode: 'demo' };
    const calls = { setMode: [], updateUI: 0 };
    sandbox.APP = APP;
    sandbox.syncResult = { ok: true, funded: true }; // funded user
    sandbox.setMode = (m) => { calls.setMode.push(m); APP.mode = m; };
    sandbox.updateUI = () => { calls.updateUI++; };
    sandbox.trackMetaConversion = () => {};
    vm.runInContext(extractInitModeBlock(), sandbox);

    assert.strictEqual(APP.mode, 'demo', 'explicit Demo must win over funded auto-Live');
    assert.deepStrictEqual(calls.setMode, [], 'the funded auto-Live switch must not run');
    assert.strictEqual(calls.updateUI, 1, 'the dashboard is still rendered');
});

// --------------------------------------------------------------------------
// 5. DEFAULT BEHAVIOR — no stored choice keeps the existing funding default
// --------------------------------------------------------------------------
test('5a. no persisted mode + funded -> existing automatic Live behavior', () => {
    const sandbox = makeHelpers({ arbi_user: JSON.stringify({ id: 4 }) }, { id: 4 });
    const APP = { mode: 'demo' };
    const calls = { setMode: [] };
    sandbox.APP = APP;
    sandbox.syncResult = { ok: true, funded: true };
    sandbox.setMode = (m) => { calls.setMode.push(m); APP.mode = m; };
    sandbox.updateUI = () => {};
    sandbox.trackMetaConversion = () => {};
    vm.runInContext(extractInitModeBlock(), sandbox);
    assert.strictEqual(APP.mode, 'live', 'funded + no stored choice still auto-switches to Live');
    assert.deepStrictEqual(calls.setMode, ['live']);
});

test('5b. no persisted mode + promo-only -> existing Demo default', () => {
    const sandbox = makeHelpers({ arbi_user: JSON.stringify({ id: 5 }) }, { id: 5 });
    const APP = { mode: 'demo' };
    const calls = { setMode: [], startDemo: 0 };
    sandbox.APP = APP;
    sandbox.syncResult = { ok: true, funded: false };
    sandbox.setMode = (m) => { calls.setMode.push(m); APP.mode = m; };
    sandbox.updateUI = () => {};
    sandbox.trackMetaConversion = () => { calls.startDemo++; };
    vm.runInContext(extractInitModeBlock(), sandbox);
    assert.strictEqual(APP.mode, 'demo', 'promo-only with no stored choice stays Demo (unchanged)');
    assert.deepStrictEqual(calls.setMode, [], 'no auto-Live for a promo-only user');
    assert.strictEqual(calls.startDemo, 1, 'the existing StartDemo event still fires on the Demo default');
});

// --------------------------------------------------------------------------
// 6. MODE SWITCH PERSISTENCE — the REAL setMode stores the choice
// --------------------------------------------------------------------------
function makeSetModeSandbox(store, user, startMode) {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        APP: { mode: startMode || 'demo', botRunning: false, currentWallet: 'demo' },
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; },
        },
        document: { getElementById: () => null },
        getEl: () => ({ classList: { toggle() {} } }),
        stopBot: () => {},
        updateUI: () => {},
        switchChartWallet: () => {},
        trackMetaConversion: () => {},
        JSON, String,
    };
    sandbox.__user = user;
    vm.createContext(sandbox);
    vm.runInContext(
        [
            'function currentCachedUser(){ return globalThis.__user; }',
            extractFunction('modePreferenceKey'),
            extractFunction('getPersistedMode'),
            extractFunction('setPersistedMode'),
            extractFunction('setMode'),
        ].join('\n'),
        sandbox
    );
    return sandbox;
}

test('6. Demo -> Live persists "live"; Live -> Demo persists "demo" (real setMode)', () => {
    const store = { arbi_user: JSON.stringify({ id: 9 }) };
    const sandbox = makeSetModeSandbox(store, { id: 9 }, 'demo');
    vm.runInContext("setMode('live')", sandbox);
    assert.strictEqual(store['arbi_mode_9'], 'live', 'Demo -> Live must persist "live"');
    vm.runInContext("setMode('demo')", sandbox);
    assert.strictEqual(store['arbi_mode_9'], 'demo', 'Live -> Demo must persist "demo"');
});

test('6b. only valid modes are ever stored; invalid/corrupt values are ignored on read', () => {
    const store = { arbi_user: JSON.stringify({ id: 9 }), arbi_mode_9: 'banana' };
    const sandbox = makeHelpers(store, { id: 9 });
    assert.strictEqual(sandbox.getPersistedMode(), null, 'an invalid stored value is treated as no choice');
    sandbox.setPersistedMode('nonsense');
    assert.strictEqual(store['arbi_mode_9'], 'banana', 'an invalid mode is never written');
    sandbox.setPersistedMode('live');
    assert.strictEqual(store['arbi_mode_9'], 'live');
});

// --------------------------------------------------------------------------
// 7. USER ISOLATION — one account's choice never affects another
// --------------------------------------------------------------------------
test('7. per-account isolation: User A mode never leaks to User B', () => {
    const store = { arbi_user: JSON.stringify({ id: 1 }) };
    const fa = makeHelpers(store, { id: 1 });
    fa.setPersistedMode('live');
    assert.strictEqual(store['arbi_mode_1'], 'live');

    const fb = makeHelpers(store, { id: 2 });
    assert.strictEqual(fb.getPersistedMode(), null, 'User B has no stored choice');
    fb.setPersistedMode('demo');
    assert.strictEqual(store['arbi_mode_2'], 'demo');
    assert.strictEqual(store['arbi_mode_1'], 'live', "User A's choice is untouched");

    // An unauthenticated visitor never writes an 'anon' key.
    const fnull = makeHelpers(store, null);
    assert.strictEqual(fnull.modePreferenceKey(), null, 'no key without an authenticated user');
    fnull.setPersistedMode('live');
    assert.ok(!('arbi_mode_anon' in store), 'no anonymous mode key is ever written');
});

// --------------------------------------------------------------------------
// 8. LOGOUT — existing stop behavior intact; login never restarts the bot
// --------------------------------------------------------------------------
test('8. logout still stops the server session and does not wipe the stored mode', () => {
    const after = INDEX.indexOf("'/api/auth/logout'");
    const stopAt = INDEX.indexOf("syncBotSessionWithServer('stop');", after);
    assert.ok(stopAt > 0, 'logout must still end the server session');
    const clearAt = INDEX.indexOf("localStorage.removeItem('jwt_token')", after);
    assert.ok(stopAt < clearAt, 'the stop is sent while the token still exists');
    // The persisted mode key is NOT among the cleared keys (may remain per account).
    const clearBlock = INDEX.slice(clearAt, clearAt + 900);
    assert.ok(!/arbi_mode_/.test(clearBlock), 'logout must not clear the persisted mode key');
    // And no auto-start anywhere in the mode-restore path.
    assert.ok(!extractInitModeBlock().includes('startBot'), 'restoring mode never starts the bot');
    assert.ok(!extractFunction('adoptServerBotState').includes('startBot'), 'adoption never starts the bot');
});

// --------------------------------------------------------------------------
// 9. TAB/BROWSER CLOSE — no unload handler may send /api/bot/stop
// --------------------------------------------------------------------------
test('9. no beforeunload/pagehide/visibilitychange/unload handler was added', () => {
    for (const ev of ['beforeunload', 'pagehide', 'visibilitychange']) {
        assert.ok(!INDEX.includes(ev), 'no ' + ev + ' handler may exist');
    }
    assert.ok(!/addEventListener\(\s*['"]unload['"]/.test(INDEX), 'no window unload handler may exist');
    assert.ok(!/addEventListener\(\s*['"]beforeunload['"]/.test(INDEX));
});

// --------------------------------------------------------------------------
// GUARDS — worker/promo/deposit/logout untouched; no customer copy changed
// --------------------------------------------------------------------------
test('guard: the worker and its claim/stop lifecycle are untouched by this change', () => {
    assert.ok(!/arbi_mode|setPersistedMode|getPersistedMode|modePreferenceKey/.test(WORKER), 'TradingWorker.js must not reference mode persistence');
    assert.ok(!/arbi_mode|setPersistedMode|getPersistedMode/.test(WORKER_ENTRY), 'worker.js must not reference mode persistence');
    // The worker still claims by is_running only (no funding filter introduced).
    assert.match(WORKER, /from\('bot_sessions'\)\.select\('\*'\)\.eq\('is_running', 1\)/);
    assert.match(SERVER, /const sessionState = \{\s*user_id: userId,\s*is_running: 1,/);
});

test('guard: the $20 promo cap and the deposit rule are unchanged', () => {
    assert.match(SERVER, /const PROMO_PROFIT_CAP_USD = 20;/);
    assert.match(SERVER, /Number\(promoProfit\) >= PROMO_PROFIT_CAP_USD/);
    // No deposit gate was added to bot start (promo-only users may still start).
    const start = SERVER.slice(SERVER.indexOf("app.post('/api/bot/start'"), SERVER.indexOf("app.post('/api/bot/stop'"));
    assert.ok(!/hasConfirmedDeposit[\s\S]{0,200}\b(res\.status\(40|return res\.status\(40)/.test(start),
        'bot start must not gain a deposit requirement');
});

test('guard: setMode is the single persistence point; initApp is the single restore point', () => {
    assert.match(extractFunction('setMode'), /setPersistedMode\(mode\)/);
    assert.match(extractInitModeBlock(), /getPersistedMode\(\)/);
    // No other write site for arbi_mode.
    const writes = INDEX.match(/setPersistedMode\(/g) || [];
    assert.strictEqual(writes.length, 2, 'one definition + one setMode call site');
});
