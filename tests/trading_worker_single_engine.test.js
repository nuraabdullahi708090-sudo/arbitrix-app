/**
 * Single-engine guard: /api/trade must refuse browser-originated trades for a
 * session that a server-side worker is executing, so the browser loop and the
 * worker can never both trade the same session during (and after) cutover.
 *
 * The guard is FAIL-OPEN by design: it must never be able to stop trading on its
 * own (e.g. before migration 027 is applied, every read errors).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'services/TradingWorker.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf('async function ' + name);
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
  vm.runInContext(extractFunction(SERVER, 'isWorkerOwnedSession'), sandbox);
  return { isWorkerOwnedSession: sandbox.isWorkerOwnedSession, logged };
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
  assert.match(body.slice(guardAt, guardAt + 400), /WORKER_OWNED_SESSION/);
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

test('server and worker agree on the staleness window', () => {
  const serverMs = Number((SERVER.match(/const WORKER_STALE_HEARTBEAT_MS = (\d+);/) || [])[1]);
  assert.ok(serverMs > 0, 'server staleness window missing');
  assert.match(WORKER_SRC, /staleHeartbeatMs/);
  assert.ok(/staleHeartbeatMs:\s*\d+/.test(WORKER_SRC), 'worker default must exist');
});
