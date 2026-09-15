'use strict';
/**
 * STAGE 8A - the fenced stop (migration 029's public.stop_bot_session_fenced) is
 * wired into every explicit production stop path.
 *
 * The SQL semantics themselves were verified against a real PostgreSQL 17
 * instance (privileges, claim/SKIP LOCKED, the fence matrix, stop + generation
 * bump, idempotent re-apply). These tests cover the WIRING: that each stop path
 * reaches the RPC, that it addresses exactly one user, and that every RPC
 * outcome is handled without ever claiming a stop that did not happen.
 *
 * The server helpers are executed for real (extracted from server.js into a vm
 * with a stubbed Supabase client), not mirrored - so the behaviour under test is
 * the shipped code.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SERVER = read('server.js');
const INDEX = read('public/index.html');
const MIGRATION_029 = read('supabase/migrations/029_bot_session_lease.sql');

function routeBody(from, to) {
  const start = SERVER.indexOf(from);
  assert.ok(start > -1, 'route not found: ' + from);
  const end = SERVER.indexOf(to, start + 1);
  assert.ok(end > start, 'route end not found after: ' + from);
  return SERVER.slice(start, end);
}

// ---------------------------------------------------------------------------
// The REAL server helpers, executed in a vm with a stubbed supabaseAdmin.
// ---------------------------------------------------------------------------
const HELPERS_START = SERVER.indexOf('function isMissingFunctionError');
const HELPERS_END = SERVER.indexOf('async function stopBotSessionForPromoLimit', HELPERS_START);
assert.ok(HELPERS_START > -1 && HELPERS_END > HELPERS_START, 'the fenced-stop helpers must exist in server.js');
const HELPERS = SERVER.slice(HELPERS_START, HELPERS_END);

function makeStub({ rpcResult = { data: { success: true, stopped: true, generation: 0 }, error: null }, rpcThrows = null, updateError = null, updateThrows = null } = {}) {
  const calls = { rpcs: [], updates: [] };
  const stub = {
    rpc(name, args) {
      calls.rpcs.push({ name, args });
      if (rpcThrows) return Promise.reject(rpcThrows);
      return Promise.resolve(rpcResult);
    },
    from(table) {
      return {
        update(payload) {
          return {
            eq(col, val) {
              calls.updates.push({ table, payload, filter: [col, val] });
              if (updateThrows) return Promise.reject(updateThrows);
              return Promise.resolve({ error: updateError });
            },
          };
        },
      };
    },
    _calls: calls,
  };
  return stub;
}

function loadHelpers(stub) {
  const logs = [];
  const sandbox = { supabaseAdmin: stub, console: { log: (l) => logs.push(String(l)) } };
  vm.createContext(sandbox);
  vm.runInContext(
    HELPERS + '\n;globalThis.__fenced = { stopBotSessionFenced, legacyStopBotSession, isMissingFunctionError };',
    sandbox
  );
  return { api: sandbox.__fenced, sandbox, logs };
}

test('server helper: a successful stop is fenced, reports the generation, and does NOT double-write', async () => {
  const stub = makeStub({ rpcResult: { data: { success: true, stopped: true, generation: 7 }, error: null } });
  const { api, logs } = loadHelpers(stub);

  const res = await api.stopBotSessionFenced(42, 'user_stopped', 'user');

  assert.deepStrictEqual({ ...res }, { stopped: true, generation: 7, fenced: true, error: null });
  assert.strictEqual(stub._calls.rpcs.length, 1);
  assert.strictEqual(stub._calls.rpcs[0].name, 'stop_bot_session_fenced');
  assert.deepStrictEqual({ ...stub._calls.rpcs[0].args }, { p_user_id: 42, p_reason: 'user_stopped', p_requested_by: 'user' });
  assert.strictEqual(stub._calls.updates.length, 0, 'the fenced path must not also run the legacy update');
  assert.strictEqual(logs.length, 0, 'a clean stop needs no warning');
});

test('server helper: "no session row" is not an error and never falls back', async () => {
  const stub = makeStub({ rpcResult: { data: { success: true, stopped: false, generation: null }, error: null } });
  const { api } = loadHelpers(stub);

  const res = await api.stopBotSessionFenced(99, 'user_stopped', 'user');

  assert.strictEqual(res.stopped, false);
  assert.strictEqual(res.fenced, true, 'the fenced path ran; there was simply nothing to stop');
  assert.strictEqual(res.error, null);
  assert.strictEqual(stub._calls.updates.length, 0);
});

test('server helper: a missing 029 (PGRST202) falls back to the unfenced stop, loudly', async () => {
  const stub = makeStub({
    rpcResult: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.stop_bot_session_fenced(p_reason, p_requested_by, p_user_id) in the schema cache' } },
  });
  const { api, logs } = loadHelpers(stub);

  const res = await api.stopBotSessionFenced(42, 'user_stopped', 'user');

  assert.strictEqual(res.stopped, true, 'the session must still be stopped');
  assert.strictEqual(res.fenced, false, 'and the caller is told fencing was unavailable');
  assert.strictEqual(stub._calls.updates.length, 1);
  assert.strictEqual(stub._calls.updates[0].table, 'bot_sessions');
  assert.deepStrictEqual({ ...stub._calls.updates[0].payload }, { is_running: 0, stopped_reason: 'user_stopped' });
  assert.deepStrictEqual(stub._calls.updates[0].filter, ['user_id', 42]);
  const event = JSON.parse(logs.find((l) => l.includes('fenced_stop_unavailable')));
  assert.strictEqual(event.missingFunction, true);
  assert.strictEqual(event.legacyStopped, true);
});

test('server helper: a transient RPC error also falls back, and is logged as NOT a missing function', async () => {
  const stub = makeStub({ rpcResult: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } });
  const { api, logs } = loadHelpers(stub);

  const res = await api.stopBotSessionFenced(42, 'promo_trading_limit', 'system');

  assert.strictEqual(res.stopped, true, 'stopping must always win');
  assert.strictEqual(res.fenced, false);
  const event = JSON.parse(logs.find((l) => l.includes('fenced_stop_unavailable')));
  assert.strictEqual(event.missingFunction, false, 'a timeout must not be misreported as a missing migration');
  assert.strictEqual(event.reason, 'promo_trading_limit');
});

test('server helper: a throwing RPC still stops the session', async () => {
  const stub = makeStub({ rpcThrows: new Error('network down') });
  const { api } = loadHelpers(stub);

  const res = await api.stopBotSessionFenced(42, 'user_stopped', 'user');

  assert.strictEqual(res.stopped, true);
  assert.strictEqual(res.fenced, false);
  assert.match(res.error, /network down/);
  assert.strictEqual(stub._calls.updates.length, 1);
});

test('server helper: if EVEN the fallback fails, it never claims a stop', async () => {
  const stub = makeStub({ rpcThrows: new Error('network down'), updateError: { message: 'permission denied' } });
  const { api } = loadHelpers(stub);

  const res = await api.stopBotSessionFenced(42, 'user_stopped', 'user');

  assert.strictEqual(res.stopped, false, 'a failed stop must never report success');
  assert.strictEqual(res.fenced, false);
});

test('server helper: an invalid user id never reaches the database', async () => {
  for (const bad of [undefined, null, 'abc', NaN]) {
    const stub = makeStub();
    const { api } = loadHelpers(stub);
    const res = await api.stopBotSessionFenced(bad, 'user_stopped', 'user');
    assert.strictEqual(res.stopped, false);
    assert.strictEqual(stub._calls.rpcs.length, 0, 'no RPC for an invalid id');
    assert.strictEqual(stub._calls.updates.length, 0, 'no update for an invalid id');
  }
});

test('server helper: a stop is scoped to exactly one user id, on both paths', async () => {
  for (const rpcResult of [
    { data: { success: true, stopped: true, generation: 1 }, error: null },
    { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
  ]) {
    const stub = makeStub({ rpcResult });
    const { api } = loadHelpers(stub);
    await api.stopBotSessionFenced(4242, 'user_stopped', 'user');
    for (const call of stub._calls.rpcs) assert.strictEqual(call.args.p_user_id, 4242);
    for (const u of stub._calls.updates) assert.deepStrictEqual(u.filter, ['user_id', 4242]);
    assert.ok(!JSON.stringify(stub._calls).includes('4243'), 'no other id may appear');
  }
});

test('server helper: it never passes a worker id or generation to the stop RPC', () => {
  // The RPC's signature is (p_user_id, p_reason, p_requested_by). A stop must not
  // be gated by the executor's identity or generation, or a stale worker could
  // veto the user's stop.
  assert.deepStrictEqual(
    [...HELPERS.matchAll(/(p_[a-z_]+)\s*:/g)].map((m) => m[1]).sort(),
    ['p_reason', 'p_requested_by', 'p_user_id']
  );
  const sqlHead = MIGRATION_029.slice(
    MIGRATION_029.indexOf('CREATE OR REPLACE FUNCTION public.stop_bot_session_fenced'),
    MIGRATION_029.indexOf(') RETURNS', MIGRATION_029.indexOf('CREATE OR REPLACE FUNCTION public.stop_bot_session_fenced'))
  );
  assert.deepStrictEqual(
    [...sqlHead.matchAll(/^\s*(p_[a-z_]+)\s+(TEXT|INTEGER|BIGINT)/gm)].map((m) => m[1]).sort(),
    ['p_reason', 'p_requested_by', 'p_user_id']
  );
});

// ---------------------------------------------------------------------------
// Every explicit server-side stop path is wired
// ---------------------------------------------------------------------------
test('route wiring: /api/bot/stop is sandbox-first, then fenced, and uses the JWT user only', () => {
  const body = routeBody("app.post('/api/bot/stop'", "app.get('/api/bot/status'");
  assert.ok(body.indexOf('handleSandboxBotStop') < body.indexOf('stopBotSessionFenced'), 'the sandbox branch must stay first');
  assert.match(body, /await stopBotSessionFenced\(req\.user\.id, 'user_stopped', 'user'\)/);
  assert.ok(!/req\.body[^)]*user/i.test(body), 'a user id must never come from the request body');
  assert.ok(!/p_worker_id|p_generation/.test(body));
  assert.match(body, /res\.json\(\{ status: 'stopped', stopped: result\.stopped, fenced: result\.fenced, generation: result\.generation \}\)/);
  assert.match(body, /status\(500\)/, 'a failed stop must not answer 200 with a false "stopped"');
});

test('route wiring: the promotional-cap stop is fenced', () => {
  const body = serverFunction('async function stopBotSessionForPromoLimit');
  assert.match(body, /stopBotSessionFenced\(userId, 'promo_trading_limit', 'system'\)/);
  assert.ok(!/from\('bot_sessions'\)\s*\.\s*update/.test(body), 'no unfenced write left behind');
});

test('route wiring: the admin emergency stop fences every running session', () => {
  const body = routeBody("app.post('/api/admin/bot/emergency-stop'", "app.post('/api/admin/bot/emergency-stop/clear'");
  assert.match(body, /for \(const id of ids\)/);
  assert.match(body, /stopBotSessionFenced\(id, 'emergency_stop', engagedBy\)/);
  assert.match(body, /if \(outcome\.stopped\) sessionsStopped\+\+;/);
  assert.match(body, /if \(!outcome\.stopped && outcome\.error\) sessionsStopError = outcome\.error;/);
  assert.ok(!/\.update\(\{ is_running: 0, stopped_reason: 'emergency_stop'/.test(body), 'the bulk unfenced update is gone');
  assert.match(body, /sessionsFenced/);
});

test('route wiring: exactly one shared helper, used by all three stop paths', () => {
  const uses = [...SERVER.matchAll(/stopBotSessionFenced\(/g)].length;
  assert.ok(uses >= 4, 'definition + 3 stop paths, saw ' + uses);
  assert.strictEqual([...SERVER.matchAll(/rpc\('stop_bot_session_fenced'/g)].length, 1, 'the RPC name appears once, in the helper');
  const routes = [...SERVER.matchAll(/app\.(get|post|put|delete)\('(\/api\/bot\/[a-z]+)'/g)].map((m) => m[2]);
  assert.deepStrictEqual([...new Set(routes)].sort(), ['/api/bot/start', '/api/bot/status', '/api/bot/stop'], 'no new bot route');
});

test('route wiring: the worker stop path is fenced too', () => {
  const worker = read('services/TradingWorker.js');
  const stopFn = worker.slice(worker.indexOf('async function stopSession('), worker.indexOf('async function stopAllSessions('));
  assert.match(stopFn, /rpc\('stop_bot_session_fenced'/);
  assert.match(stopFn, /p_user_id: userId/);
  assert.match(stopFn, /p_requested_by: workerId \|\| 'worker'/);
  assert.ok(stopFn.indexOf("rpc('stop_bot_session_fenced'") < stopFn.indexOf("from('bot_sessions')"), 'the RPC must be tried first');
  assert.match(stopFn, /fenced_stop_unavailable/, 'the fallback must be logged, never silent');
  assert.match(stopFn, /attempts: 1/, 'a pre-029 database must not pay retry backoff on every stop');
});

// ---------------------------------------------------------------------------
// Client: explicit stops end the session; a worker takeover must NOT pretend
// ---------------------------------------------------------------------------
test('client: stopBot() ends the server session, and demos/handover are unaffected', () => {
  const fn = indexFunction('function stopBot()');
  assert.match(fn, /syncBotSessionWithServer\('stop'\)/);
  assert.match(fn, /APP\.botRunning = false/);
});

test('client: a worker takeover never claims a stop (no false Paused entry/toast)', () => {
  const fn = indexFunction('function adoptWorkerOwnership()');
  assert.ok(!/syncBotSessionWithServer/.test(fn), 'the yield must not send a stop to the server');
  assert.ok(!/stopBot\(/.test(fn), 'the yield must not run the explicit stop path');
  assert.ok(!/history\.unshift/.test(fn), 'no "Bot Paused" history entry on takeover');
  assert.ok(!/showToast/.test(fn), 'no paused toast on takeover');
  assert.match(fn, /APP\.botRunning = true/);
  assert.match(fn, /APP\.botExecutedBy = 'worker'/);
  assert.match(fn, /updateBotEngineNotice\('worker'\)/);
});

test('client: the 409 handover yields instead of stopping, and logout stops', () => {
  const handover = INDEX.slice(INDEX.indexOf("errBody.code === 'WORKER_OWNED_SESSION'"), INDEX.indexOf("errBody.code === 'WORKER_OWNED_SESSION'") + 1500);
  assert.match(handover, /adoptWorkerOwnership\(\)/);
  assert.ok(!/syncBotSessionWithServer\('stop'\)/.test(handover), 'the handover must not stop the session');

  // Logout lives in initApp()'s click handler for #logoutLink.
  const logout = INDEX.slice(INDEX.indexOf("logoutLink.addEventListener('click'"), INDEX.indexOf("logoutLink.addEventListener('click'") + 3000);
  assert.match(logout, /syncBotSessionWithServer\('stop'\)/, 'logout must end the server session');
  assert.match(logout, /APP\.botRunning = false/);
  assert.ok(logout.indexOf("syncBotSessionWithServer('stop')") < logout.indexOf("removeItem('jwt_token')"),
    'the stop must be sent while the token is still present');
});

// ---------------------------------------------------------------------------
function serverFunction(signature) {
  const start = SERVER.indexOf(signature);
  assert.ok(start > -1, 'server function not found: ' + signature);
  const end = SERVER.indexOf('\n}\n', start);
  return SERVER.slice(start, end === -1 ? start + 600 : end);
}

function indexFunction(signature) {
  const start = INDEX.indexOf(signature);
  assert.ok(start > -1, 'client function not found: ' + signature);
  const end = INDEX.indexOf('\n}', start);
  return INDEX.slice(start, end === -1 ? start + 900 : end);
}
