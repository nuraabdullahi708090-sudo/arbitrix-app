'use strict';

/**
 * Session-revocation resilience: a revoked token must stay revoked when the
 * durable store is unavailable, without logging every customer out.
 *
 * Three layers:
 *  1. Unit tests of `createResilientStore` (local revocation, retry queue,
 *     caching, circuit breaker, timeout, strict mode, bounded memory).
 *  2. Real HTTP: the REAL server boots against a Supabase double whose
 *     `revoked_tokens` table always fails, so logout must still revoke locally
 *     and a replay must still be refused - and strict mode must answer 503.
 *  3. Source pins for the wiring and the documented environment knobs.
 *
 * No real database, secret or production traffic is involved.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const bcrypt = require('bcryptjs');

const TokenRevocation = require('../services/TokenRevocationService');

const ROOT = path.resolve(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-auth.js');

/* ------------------------------------------------------------------ helpers */

function memoryInner() {
  const base = TokenRevocation.createMemoryStore();
  const calls = { add: 0, has: 0, prune: 0 };
  return {
    calls,
    async add(entry) { calls.add += 1; return base.add(entry); },
    async has(jti) { calls.has += 1; return base.has(jti); },
    async prune(now) { calls.prune += 1; return base.prune(now); },
    _size: base._size,
  };
}

function brokenInner() {
  const calls = { add: 0, has: 0, prune: 0 };
  const fail = function () { return { message: 'connection refused' }; };
  return {
    calls,
    async add() { calls.add += 1; throw fail(); },
    async has() { calls.has += 1; throw fail(); },
    async prune() { calls.prune += 1; throw fail(); },
  };
}

function futureDate(ms) {
  return new Date(Date.now() + (ms || 60_000));
}

/* ------------------------------------------------------- local revocation */

test('a revoked token is rejected locally even when the durable write fails', async () => {
  const inner = brokenInner();
  const store = TokenRevocation.createResilientStore(inner, { timeoutMs: 200, verifiedTtlMs: 0 });

  const result = await store.add({ jti: 'j-1', userId: 7, expiresAt: futureDate() });
  assert.deepStrictEqual(result, { durable: false, local: true, reason: 'store_error' });

  // No store call needed: the local record answers.
  assert.strictEqual(await store.has('j-1'), true);
  assert.strictEqual(store.stats().localHits, 1);
});

test('the queued revocation is persisted once the store recovers', async () => {
  let down = true;
  const durable = TokenRevocation.createMemoryStore();
  const inner = {
    async add(entry) { if (down) throw new Error('down'); return durable.add(entry); },
    async has(jti) { if (down) throw new Error('down'); return durable.has(jti); },
    async prune() { if (down) throw new Error('down'); return durable.prune(); },
  };
  const store = TokenRevocation.createResilientStore(inner, {
    timeoutMs: 100, verifiedTtlMs: 0, failureThreshold: 1, cooldownMs: 0,
  });

  await store.add({ jti: 'j-2', userId: 1, expiresAt: futureDate() });
  assert.deepStrictEqual(store._pendingKeys(), ['j-2'], 'the failed write is queued');

  down = false;
  assert.strictEqual(await store.has('probe'), false, 'a successful call flushes the queue');
  await new Promise((r) => setTimeout(r, 20)); // flush is detached
  assert.deepStrictEqual(store._pendingKeys(), [], 'the queue drained');
  assert.strictEqual(await durable.has('j-2'), true, 'the revocation reached the store');

  // Another instance over the same durable store now enforces it.
  const fresh = TokenRevocation.createResilientStore(durable, { verifiedTtlMs: 0 });
  assert.strictEqual(await fresh.has('j-2'), true);
});

test('a revocation that expires locally is no longer enforced (the token expired too)', async () => {
  let now = 1_000_000;
  const inner = brokenInner();
  const store = TokenRevocation.createResilientStore(inner, {
    timeoutMs: 50, verifiedTtlMs: 0, now: () => now,
  });
  await store.add({ jti: 'j-3', userId: 1, expiresAt: new Date(now + 1000) });
  assert.strictEqual(await store.has('j-3'), true);
  now += 5000;
  assert.strictEqual(await store.has('j-3'), false, 'expired revocation rows are ignored');
});

/* ---------------------------------------------------------------- caching */

test('a "not revoked" answer is cached for the configured window', async () => {
  let now = 1_000_000;
  const inner = memoryInner();
  const store = TokenRevocation.createResilientStore(inner, {
    verifiedTtlMs: 10_000, now: () => now,
  });

  assert.strictEqual(await store.has('j-4'), false);
  assert.strictEqual(inner.calls.has, 1);
  now += 5000;
  assert.strictEqual(await store.has('j-4'), false);
  assert.strictEqual(inner.calls.has, 1, 'served from cache inside the TTL');
  now += 6000; // past the TTL
  assert.strictEqual(await store.has('j-4'), false);
  assert.strictEqual(inner.calls.has, 2, 're-checked after the TTL');
});

test('AUTH_REVOCATION_CACHE_MS=0 disables the cache (one store call per check)', async () => {
  const inner = memoryInner();
  const store = TokenRevocation.createResilientStore(inner, { verifiedTtlMs: 0 });
  await store.has('j-5');
  await store.has('j-5');
  assert.strictEqual(inner.calls.has, 2);
});

test('a local revocation invalidates a cached "not revoked" opinion', async () => {
  const inner = memoryInner();
  const store = TokenRevocation.createResilientStore(inner, { verifiedTtlMs: 60000 });
  assert.strictEqual(await store.has('j-6'), false);   // cached as fine
  await store.add({ jti: 'j-6', userId: 1, expiresAt: futureDate() });
  assert.strictEqual(await store.has('j-6'), true, 'the fresh revocation wins over the cache');
});

/* -------------------------------------------------------- circuit breaker */

test('a failing store is skipped for a cooldown instead of stalling every request', async () => {
  let now = 1_000_000;
  const inner = brokenInner();
  const store = TokenRevocation.createResilientStore(inner, {
    timeoutMs: 50, verifiedTtlMs: 0, failureThreshold: 3, cooldownMs: 10_000, now: () => now,
  });

  for (let i = 0; i < 3; i++) await store.has('k' + i);
  assert.strictEqual(inner.calls.has, 3);
  assert.strictEqual(store.stats().circuitOpen, true, 'the circuit opened after the threshold');

  await store.has('k-after');
  assert.strictEqual(inner.calls.has, 3, 'no store call while the circuit is open');

  now += 10_001; // cooldown elapsed -> try again (half-open)
  await store.has('k-half-open');
  assert.strictEqual(inner.calls.has, 4, 'the store is retried after the cooldown');
});

test('recovery closes the circuit and is reported once', async () => {
  let down = true;
  const events = [];
  const durable = TokenRevocation.createMemoryStore();
  const inner = {
    async add(e) { if (down) throw new Error('down'); return durable.add(e); },
    async has(j) { if (down) throw new Error('down'); return durable.has(j); },
    async prune() { return 0; },
  };
  const store = TokenRevocation.createResilientStore(inner, {
    timeoutMs: 50, verifiedTtlMs: 0, failureThreshold: 2, cooldownMs: 0,
    onEvent: (name) => events.push(name),
  });

  await store.has('a');
  await store.has('b');
  assert.deepStrictEqual(events.filter((e) => e === 'store_open').length, 1);
  down = false;
  await store.has('c');
  assert.deepStrictEqual(events.filter((e) => e === 'store_recovered').length, 1);
  assert.strictEqual(store.stats().circuitOpen, false);
});

/* -------------------------------------------------------- timeouts/limits */

test('a hanging store cannot hang the request: the check resolves within the timeout', async () => {
  const inner = { async add() {}, async has() { return new Promise(function () { /* never */ }); }, async prune() { return 0; } };
  const store = TokenRevocation.createResilientStore(inner, { timeoutMs: 60, verifiedTtlMs: 0 });
  const started = Date.now();
  assert.strictEqual(await store.has('slow'), false, 'fail open on a hung store');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, 'resolved promptly (took ' + elapsed + 'ms)');
  assert.strictEqual(store.stats().storeFailures, 1);
});

test('strict mode turns an unverifiable check into a typed, retryable error', async () => {
  const inner = brokenInner();
  const store = TokenRevocation.createResilientStore(inner, {
    timeoutMs: 50, verifiedTtlMs: 0, requireStore: true,
  });
  await assert.rejects(() => store.has('x'), (e) => {
    assert.strictEqual(e.code, 'REVOCATION_UNAVAILABLE');
    return true;
  });
});

test('strict mode still serves a locally known revocation without the store', async () => {
  const inner = brokenInner();
  const store = TokenRevocation.createResilientStore(inner, {
    timeoutMs: 50, verifiedTtlMs: 0, requireStore: true,
  });
  await store.add({ jti: 'y', userId: 1, expiresAt: futureDate() });
  assert.strictEqual(await store.has('y'), true, 'a revoked session is never allowed through');
});

test('the retry queue and the caches are bounded', async () => {
  const inner = brokenInner();
  const store = TokenRevocation.createResilientStore(inner, {
    timeoutMs: 20, verifiedTtlMs: 0, maxPending: 3, failureThreshold: 100,
  });
  for (let i = 0; i < 10; i++) {
    await store.add({ jti: 'p' + i, userId: 1, expiresAt: futureDate() });
  }
  const stats = store.stats();
  assert.strictEqual(stats.pendingSize, 3, 'the retry queue cannot grow without bound');
  assert.strictEqual(stats.pendingDropped, 7);
  // Every dropped entry is still enforced locally.
  assert.strictEqual(await store.has('p0'), true);
});

test('the verified cache is bounded as well', async () => {
  const inner = memoryInner();
  const store = TokenRevocation.createResilientStore(inner, {
    verifiedTtlMs: 60000, maxVerified: 5,
  });
  for (let i = 0; i < 50; i++) await store.has('v' + i);
  assert.ok(store.stats().verifiedSize <= 5, 'verified cache capped, got ' + store.stats().verifiedSize);
});

/* ------------------------------------------------------- environment knobs */

test('resolveResilientOptions reads and bounds the environment', () => {
  assert.deepStrictEqual(
    (() => { const o = TokenRevocation.resolveResilientOptions({}); delete o.onEvent; return o; })(),
    { timeoutMs: 2000, requireStore: false });

  const configured = TokenRevocation.resolveResilientOptions({
    AUTH_REVOCATION_TIMEOUT_MS: '750',
    AUTH_REVOCATION_CACHE_MS: '0',
    AUTH_REVOCATION_REQUIRE_STORE: 'TRUE',
  });
  assert.strictEqual(configured.timeoutMs, 750);
  assert.strictEqual(configured.verifiedTtlMs, 0);
  assert.strictEqual(configured.requireStore, true);

  const junk = TokenRevocation.resolveResilientOptions({
    AUTH_REVOCATION_TIMEOUT_MS: 'abc',
    AUTH_REVOCATION_CACHE_MS: '-1',
    AUTH_REVOCATION_REQUIRE_STORE: 'maybe',
  });
  assert.strictEqual(junk.timeoutMs, 2000);
  assert.strictEqual(junk.verifiedTtlMs, 10000);
  assert.strictEqual(junk.requireStore, false);

  // A long timeout is clamped so one slow call cannot hold a request forever.
  assert.strictEqual(TokenRevocation.resolveResilientOptions({ AUTH_REVOCATION_TIMEOUT_MS: '999999' }).timeoutMs, 10000);
});

/* ------------------------------------------------------------------ wiring */

test('server.js wraps the durable store and documents the knobs', () => {
  assert.ok(SERVER.includes('TokenRevocation.createResilientStore('), 'the resilient store is wired');
  assert.ok(SERVER.includes('TokenRevocation.resolveResilientOptions(process.env'), 'options come from the environment');
  assert.ok(SERVER.includes("require('./services/TokenRevocationService')"));
  // Strict mode answers 503 with Retry-After, never 401.
  const idx = SERVER.indexOf("e.code === 'REVOCATION_UNAVAILABLE'");
  assert.ok(idx > -1, 'the middleware branches on the typed error');
  const slice = SERVER.slice(idx, idx + 320);
  assert.ok(slice.includes("res.set('Retry-After', '5')"), 'retryable response');
  assert.ok(slice.includes('503'), '503 rather than 401');
  // Logout tolerates a non-durable revocation.
  assert.ok(SERVER.includes('result.durable === false'), 'logout reports a non-durable revocation');
});

/* --------------------------------------------------------------- over HTTP */

const SCENARIO_FILE = path.join(os.tmpdir(), 'auth-revocation-' + process.pid + '.json');
const JWT_SECRET = 'revocation-resilience-test-secret';
const PASSWORD = 'CorrectHorseBattery9!';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

function freePort() {
  return new Promise(function (resolve) {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      server.close(function () { resolve(port); });
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function bootServer(extraEnv) {
  const scenario = {
    twofaType: 'none',
    user: {
      id: 4242, name: 'Revocation', email: 'rev@example.test', password_hash: PASSWORD_HASH,
      referral_code: 'ARBI-REV001', is_admin: 0, environment: 'PRODUCTION',
    },
    revokedTokensError: true,
  };
  fs.writeFileSync(SCENARIO_FILE, JSON.stringify(scenario));

  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test', PORT: String(port), JWT_SECRET: JWT_SECRET, BASE_URL: base,
      SUPABASE_URL: 'http://127.0.0.1:1',
      SUPABASE_ANON_KEY: 'rev-anon', SUPABASE_SERVICE_KEY: 'rev-service',
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_SUPPORT_CHAT_ID: '', TELEGRAM_ADMIN_IDS: '',
      PAYHIP_ENABLED: 'false',
      AUTH_SCENARIO_FILE: SCENARIO_FILE,
      AUTH_RATE_LIMIT_LOGIN_IP_MAX: '1000',
      AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX: '1000',
      AUTH_REVOCATION_CACHE_MS: '0',
      NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD),
    }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited early: ' + output);
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) return { base, child, output: () => output };
    } catch (e) { /* not up yet */ }
    await sleep(120);
  }
  throw new Error('server did not become healthy\n' + output);
}

async function stopServer(server) {
  if (server.child && server.child.exitCode === null) {
    try { server.child.kill('SIGTERM'); } catch (e) { /* gone */ }
    await Promise.race([once(server.child, 'exit'), sleep(3000)]);
  }
}

async function call(base, route, token, method) {
  const res = await fetch(base + route, {
    method: method || 'GET',
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
}

test('HTTP: logout still revokes when the revocation store is down', async () => {
  const server = await bootServer({});
  try {
    const login = await fetch(server.base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'rev@example.test', password: PASSWORD }),
    });
    const body = await login.json();
    assert.strictEqual(login.status, 200, JSON.stringify(body));
    const token = body.token;
    assert.ok(token, 'a session token is issued');

    // The token works before logout (the failing store fails open here).
    assert.strictEqual((await call(server.base, '/api/auth/me', token)).status, 200);

    const logout = await call(server.base, '/api/auth/logout', token, 'POST');
    assert.strictEqual(logout.status, 200, 'logout must not fail because the store is down');
    assert.strictEqual(logout.body.revoked, true);

    const replay = await call(server.base, '/api/auth/me', token);
    assert.strictEqual(replay.status, 401, 'the replayed token must be refused');
    assert.strictEqual(replay.body.error, 'Session revoked', 'enforced locally, without the store');
  } finally {
    await stopServer(server);
  }
});

test('HTTP: strict mode answers 503 (retryable), never 401, while the store is down', async () => {
  const server = await bootServer({ AUTH_REVOCATION_REQUIRE_STORE: 'true' });
  try {
    const login = await fetch(server.base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'rev@example.test', password: PASSWORD }),
    });
    const body = await login.json();
    assert.strictEqual(login.status, 200, JSON.stringify(body));
    const token = body.token;

    const me = await call(server.base, '/api/auth/me', token);
    assert.strictEqual(me.status, 503, 'unverifiable session -> retryable 503');
    assert.strictEqual(me.body.error, 'Session verification unavailable');
    assert.strictEqual(me.body.retryable, true);
    assert.strictEqual(me.retryAfter, '5');
  } finally {
    await stopServer(server);
  }
});
