/**
 * Single-engine guard: /api/trade must refuse browser-originated trades for a
 * session that a server-side worker is executing, so the browser loop and the
 * worker can never both trade the same session during (and after) cutover.
 *
 * The guard is FAIL-OPEN by design: it must never be able to stop trading on its
 * own (e.g. before migration 028 is applied, every read errors).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'services/TradingWorker.js'), 'utf8');
const WORKER_ENTRY = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const WORKER_CONFIG = fs.readFileSync(path.join(ROOT, 'services/WorkerConfig.js'), 'utf8');

function extractFunction(src, name) {
  let start = src.indexOf('async function ' + name);
  if (start < 0) start = src.indexOf('function ' + name);
  assert.ok(start >= 0, name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

function loadGuard(sessionResult) {
  const logged = [];
  const sandbox = {
    console: { log: (l) => logged.push(l) },
    Date,
    isFinite,
    Number,
    WORKER_STALE_HEARTBEAT_MS: 60000,
    supabaseAdmin: {
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve(sessionResult) }) }),
      }),
    },
  };
  vm.createContext(sandbox);
  // isWorkerOwnedSession() delegates the lease decision to hasActiveWorkerLease(),
  // so both must be evaluated - exactly as server.js defines them.
  vm.runInContext(
    extractFunction(SERVER, 'hasActiveWorkerLease') + '\n' +
    extractFunction(SERVER, 'isWorkerOwnedSession'),
    sandbox
  );
  return {
    isWorkerOwnedSession: sandbox.isWorkerOwnedSession,
    hasActiveWorkerLease: sandbox.hasActiveWorkerLease,
    logged,
  };
}

test('worker-owned session (running + fresh heartbeat) => browser trades are refused', async () => {
  const { isWorkerOwnedSession } = loadGuard({ data: { is_running: 1, heartbeat_at: new Date().toISOString() }, error: null });
  assert.strictEqual(await isWorkerOwnedSession(1), true);
});

test('stale heartbeat is NOT worker-owned (a dead worker must not block the user)', async () => {
  const { isWorkerOwnedSession } = loadGuard({ data: { is_running: 1, heartbeat_at: new Date(Date.now() - 120000).toISOString() }, error: null });
  assert.strictEqual(await isWorkerOwnedSession(1), false);
});

test('no heartbeat (browser-driven session, i.e. today) => not worker-owned', async () => {
  const { isWorkerOwnedSession } = loadGuard({ data: { is_running: 1, heartbeat_at: null }, error: null });
  assert.strictEqual(await isWorkerOwnedSession(1), false);
});

test('stopped session => not worker-owned even with a fresh heartbeat', async () => {
  const { isWorkerOwnedSession } = loadGuard({ data: { is_running: 0, heartbeat_at: new Date().toISOString() }, error: null });
  assert.strictEqual(await isWorkerOwnedSession(1), false);
});

test('a read error FAILS OPEN (never stops trading) and logs it', async () => {
  const { isWorkerOwnedSession, logged } = loadGuard({ data: null, error: { message: 'relation does not exist' } });
  assert.strictEqual(await isWorkerOwnedSession(1), false);
  assert.strictEqual(logged.length, 1);
  const entry = JSON.parse(logged[0]);
  assert.strictEqual(entry.event, 'worker_owned_check_failed');
  assert.strictEqual(entry.fallback, 'treat_as_browser_owned');
  assert.ok(!/key|token|secret/i.test(logged[0]), 'log must not carry credentials');
});

test('/api/trade consults the guard BEFORE writing a trade', () => {
  const tradeAt = SERVER.indexOf("app.post('/api/trade'");
  const body = SERVER.slice(tradeAt, tradeAt + 4000);
  const guardAt = body.indexOf('isWorkerOwnedSession');
  const rpcAt = body.indexOf("rpc('record_trade_safe'");
  assert.ok(guardAt >= 0, 'guard missing from /api/trade');
  assert.ok(rpcAt > guardAt, 'guard must run before the money write');
  // The refusal is the SHARED machine-readable body - one definition
  // (WORKER_OWNED_CODE), also used to map migration 031's backstop error.
  assert.match(body.slice(guardAt, guardAt + 400), /workerOwnedBody\(\)/);
  assert.match(SERVER, /const WORKER_OWNED_CODE = 'WORKER_OWNED_SESSION';/);
});

test('the sandbox branch still runs first, so sandbox trades are untouched', () => {
  const tradeAt = SERVER.indexOf("app.post('/api/trade'");
  const body = SERVER.slice(tradeAt, tradeAt + 4000);
  assert.ok(body.indexOf('sandboxHandled') < body.indexOf('isWorkerOwnedSession'), 'sandbox must short-circuit first');
});

test('the guard is server-side only (no client-supplied flag can disable it)', () => {
  const tradeAt = SERVER.indexOf("app.post('/api/trade'");
  const body = SERVER.slice(tradeAt, tradeAt + 4000);
  const guardCall = body.slice(body.indexOf('await isWorkerOwnedSession'), body.indexOf('await isWorkerOwnedSession') + 60);
  assert.match(guardCall, /isWorkerOwnedSession\(userId\)/, 'must key off the authenticated user, not the body');
});

test('the worker writes the heartbeat the guard depends on', () => {
  assert.match(WORKER_SRC, /heartbeat_at: nowIso/);
  assert.ok(/async function heartbeat/.test(WORKER_SRC));
});

test('server and worker resolve the staleness window from ONE source of truth', () => {
  // A bare numeric literal on either side is exactly the drift this prevents: the
  // worker would reconcile at one window while the web guard used another, so a
  // browser tab could either be refused a session the worker had abandoned, or
  // trade alongside a worker that still considered itself the executor.
  assert.match(SERVER, /const WORKER_STALE_HEARTBEAT_MS = resolveStaleHeartbeatMs\(\);/);
  assert.ok(!/const WORKER_STALE_HEARTBEAT_MS = \d+;/.test(SERVER),
    'server must not hard-code the staleness window');
  assert.match(WORKER_SRC, /staleHeartbeatMs: DEFAULT_STALE_HEARTBEAT_MS/);
  assert.ok(!/staleHeartbeatMs:\s*\d+\b/.test(WORKER_SRC),
    'TradingWorker must not hard-code the staleness window');
  // The worker PROCESS resolves it through the shared module, not through its own
  // envNumber() helper (which is what let the two processes diverge before).
  assert.match(WORKER_ENTRY, /staleHeartbeatMs: resolveStaleHeartbeatMs\(\)/);
  assert.ok(!/envNumber\('TRADING_STALE_HEARTBEAT_MS'/.test(WORKER_ENTRY),
    'the worker must not parse the threshold itself');
  // And the module itself carries exactly one default + one env var.
  assert.match(WORKER_CONFIG, /const DEFAULT_STALE_HEARTBEAT_MS = 60000;/);
  assert.match(WORKER_CONFIG, /const STALE_HEARTBEAT_ENV = 'TRADING_STALE_HEARTBEAT_MS';/);
  assert.strictEqual((WORKER_CONFIG.match(/= 60000;/g) || []).length, 1,
    'exactly one default for the window');
});

// ==========================================================================
// Executor lease (migration 029) - the guard must treat a LIVE LEASE as
// ownership for its whole duration, not merely while a heartbeat is fresh.
// ==========================================================================
test('an ACTIVE executor lease blocks browser trades even when the heartbeat is stale', async () => {
  // A worker that holds the lease but has not heartbeated for > window: the old
  // heartbeat-only guard failed OPEN here, letting the tab trade alongside it.
  const { isWorkerOwnedSession } = loadGuard({
    data: {
      is_running: 1,
      heartbeat_at: new Date(Date.now() - 120000).toISOString(),
      claimed_by: 'worker-A',
      lease_expires_at: new Date(Date.now() + 30000).toISOString(),
    },
    error: null,
  });
  assert.strictEqual(await isWorkerOwnedSession(1), true);
});

test('an ACTIVE lease blocks even with NO heartbeat at all (claim-then-first-tick window)', async () => {
  const { isWorkerOwnedSession } = loadGuard({
    data: {
      is_running: 1,
      heartbeat_at: null,
      claimed_by: 'worker-A',
      lease_expires_at: new Date(Date.now() + 30000).toISOString(),
    },
    error: null,
  });
  assert.strictEqual(await isWorkerOwnedSession(1), true);
});

test('an EXPIRED lease with a stale heartbeat is NOT worker-owned (a dead worker must not lock the user out)', async () => {
  const { isWorkerOwnedSession } = loadGuard({
    data: {
      is_running: 1,
      heartbeat_at: new Date(Date.now() - 120000).toISOString(),
      claimed_by: 'worker-A',
      lease_expires_at: new Date(Date.now() - 1000).toISOString(),
    },
    error: null,
  });
  assert.strictEqual(await isWorkerOwnedSession(1), false);
});

test('claimed_by with a NULL/absent expiry is NOT an active lease (matches 029 claimability)', () => {
  const { hasActiveWorkerLease } = loadGuard({ data: null, error: null });
  assert.strictEqual(hasActiveWorkerLease({ claimed_by: 'worker-A', lease_expires_at: null }), false);
  assert.strictEqual(hasActiveWorkerLease({ claimed_by: 'worker-A' }), false);
  assert.strictEqual(hasActiveWorkerLease({ claimed_by: null, lease_expires_at: new Date(Date.now() + 10000).toISOString() }), false);
  assert.strictEqual(hasActiveWorkerLease(null), false);
});

test('a STOPPED session is never worker-owned, even with an active lease', async () => {
  const { isWorkerOwnedSession } = loadGuard({
    data: {
      is_running: 0,
      heartbeat_at: new Date().toISOString(),
      claimed_by: 'worker-A',
      lease_expires_at: new Date(Date.now() + 30000).toISOString(),
    },
    error: null,
  });
  assert.strictEqual(await isWorkerOwnedSession(1), false);
});

test('the guard reads the lease columns it depends on', () => {
  const fn = extractFunction(SERVER, 'isWorkerOwnedSession');
  for (const col of ['claimed_by', 'lease_expires_at', 'heartbeat_at', 'is_running']) {
    assert.ok(fn.includes(col), 'guard SELECT must include ' + col);
  }
  assert.match(fn, /hasActiveWorkerLease\(data\)/);
});
