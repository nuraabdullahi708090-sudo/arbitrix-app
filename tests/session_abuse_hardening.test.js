'use strict';

/**
 * Session and request-abuse hardening.
 *
 * Covers the three follow-ups that were previously documented as open:
 *
 *   1. /api/auth/forgot-password answered only AFTER the address-dependent work
 *      (lookup + token writes + mail provider call). The body was uniform but the
 *      DURATION was not, which is an account-enumeration side channel. The route
 *      now answers first and runs that work detached.
 *   2. `revoked_tokens` rows were ignored once expired but never deleted, so the
 *      table could only grow. `TokenRevocation.pruneExpired` + a daily schedule
 *      delete them (the RPC already exists in migration 025).
 *   3. `users.email` had no uniqueness constraint in the tracked schema, so the
 *      one-account-per-address assumption behind registration, provisioning and
 *      password reset was not enforced by the database. Migration 056 adds a
 *      guarded case-insensitive unique index.
 *
 * The HTTP cases boot the REAL server against the stubbed Supabase helper; no
 * database, mailer or production traffic is involved.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const TokenRevocation = require('../services/TokenRevocationService');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-auth.js');
const SCENARIO_FILE = path.join(os.tmpdir(), 'session-abuse-' + process.pid + '.json');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function freePort() {
  return new Promise(function (resolve) {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      server.close(function () { resolve(port); });
    });
  });
}

async function startServer(scenarioDocument) {
  fs.writeFileSync(SCENARIO_FILE, JSON.stringify(scenarioDocument || {}));

  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  let output = '';

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      PORT: String(port),
      JWT_SECRET: 'session-abuse-test-secret',
      BASE_URL: base,
      SUPABASE_URL: 'http://127.0.0.1:1',
      SUPABASE_ANON_KEY: 'abuse-anon',
      SUPABASE_SERVICE_KEY: 'abuse-service',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_SUPPORT_CHAT_ID: '',
      TELEGRAM_ADMIN_IDS: '',
      PAYHIP_ENABLED: 'false',
      AUTH_SCENARIO_FILE: SCENARIO_FILE,
      NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD)
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', function (d) { output += d.toString(); });
  child.stderr.on('data', function (d) { output += d.toString(); });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited early:\n' + output);
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) break;
    } catch (e) { /* not listening yet */ }
    await sleep(120);
  }

  return {
    base: base,
    output: function () { return output; },
    post: async function (route, body) {
      const res = await fetch(base + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { json = { _raw: text.slice(0, 200) }; }
      return { status: res.status, json: json };
    },
    close: async function () {
      if (child.exitCode === null) {
        try { child.kill('SIGTERM'); } catch (e) { /* already gone */ }
        await Promise.race([once(child, 'exit'), sleep(4000)]);
      }
    }
  };
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}

const EXISTING = {
  id: 77,
  name: 'Reset Target',
  email: 'reset.target@example.test',
  password_hash: 'x',
  referral_code: 'RT77',
  is_admin: 0,
  environment: 'PRODUCTION'
};

// ---------------------------------------------------------------------------
// 1. Forgot-password: the response no longer waits for the account work
// ---------------------------------------------------------------------------

test('forgot-password answers before the address-dependent work finishes', async () => {
  const server = await startServer({
    user: EXISTING,
    twofaEnabled: false,
    // Every token-table write stalls for 600ms. Before the fix the response
    // waited for it, which is what made an existing address slower.
    delays: { password_reset_tokens: 600 }
  });
  try {
    const started = Date.now();
    const res = await server.post('/api/auth/forgot-password', { email: EXISTING.email });
    const elapsed = Date.now() - started;

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.success, true);
    assert.ok(elapsed < 300, 'the answer must not wait for the token write (took ' + elapsed + 'ms)');

    // ...and the work still happens, just after the response.
    const ran = await waitFor(function () {
      return server.output().indexOf('password_reset_tokens') !== -1;
    }, 5000);
    assert.ok(ran, 'the reset-token work must still run in the background');
  } finally {
    await server.close();
  }
});

test('the response body is identical for an existing and an unknown address', async () => {
  const server = await startServer({ user: EXISTING, twofaEnabled: false, delays: { password_reset_tokens: 300 } });
  try {
    const known = await server.post('/api/auth/forgot-password', { email: EXISTING.email });
    const unknown = await server.post('/api/auth/forgot-password', { email: 'nobody@example.test' });

    assert.deepStrictEqual(known.json, unknown.json);
    assert.strictEqual(known.status, unknown.status);
    assert.strictEqual(known.json.success, true);

    // The uniform copy must not claim that an account exists.
    assert.match(known.json.message, /if an account with that email exists/i);
  } finally {
    await server.close();
  }
});

test('a backend failure in the detached work cannot change the answer', async () => {
  // The users lookup itself fails. Before the change the catch returned the same
  // 200; now the failure happens after the response, and it must still be caught
  // (logged, never rethrown) so the process stays healthy.
  const server = await startServer({ user: null, usersError: true, twofaEnabled: false });
  try {
    const res = await server.post('/api/auth/forgot-password', { email: 'anyone@example.test' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.success, true);

    await sleep(400);

    assert.strictEqual(server.output().indexOf('UnhandledPromiseRejection'), -1,
      'nothing escapes as an unhandled rejection');
    const health = await fetch(server.base + '/api/health');
    assert.strictEqual(health.status, 200, 'the server is still serving after the failure');
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Revocation pruning
// ---------------------------------------------------------------------------

test('the in-memory revocation store deletes only expired records', async () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const store = TokenRevocation.createMemoryStore(function () { return now; });

  await store.add({ jti: 'a', userId: 1, expiresAt: new Date(now - 1000) }); // already expired
  await store.add({ jti: 'b', userId: 1, expiresAt: new Date(now + 60000) }); // live

  const removed = await store.prune();
  assert.strictEqual(removed, 1);
  assert.strictEqual(store._size(), 1);
  assert.strictEqual(await store.has('b'), true);
  assert.strictEqual(await store.has('a'), false);
});

test('pruneExpired reports a successful prune with the count', async () => {
  const calls = [];
  const store = { prune: async function () { calls.push('prune'); return 7; } };
  const result = await TokenRevocation.pruneExpired(store);
  assert.deepStrictEqual(result, { ok: true, deleted: 7 });
  assert.deepStrictEqual(calls, ['prune']);
});

test('pruneExpired fails soft on a missing store, a legacy store or a database error', async () => {
  assert.deepStrictEqual(await TokenRevocation.pruneExpired(null), { ok: false, reason: 'no_store' });
  assert.deepStrictEqual(await TokenRevocation.pruneExpired({}), { ok: false, reason: 'unsupported_store' });

  const broken = { prune: async function () { throw new Error('function public.prune_revoked_tokens() does not exist'); } };
  const result = await TokenRevocation.pruneExpired(broken);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'prune_failed');
  assert.match(result.error, /does not exist/);
});

test('the Supabase store prunes through the migration-025 RPC', async () => {
  const rpcCalls = [];
  const client = {
    rpc: async function (name) {
      rpcCalls.push(name);
      return { data: 3, error: null };
    }
  };
  const store = TokenRevocation.createSupabaseStore(client);
  assert.strictEqual(await store.prune(), 3);
  assert.deepStrictEqual(rpcCalls, ['prune_revoked_tokens']);

  const failing = {
    rpc: async function () { return { data: null, error: { message: 'permission denied' } }; }
  };
  const failingStore = TokenRevocation.createSupabaseStore(failing);
  let thrown = null;
  try {
    await failingStore.prune();
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'a database error must not be swallowed by the store');
  assert.strictEqual(thrown.message, 'permission denied');
});

test('the server schedules the prune without blocking startup or the event loop', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(source.indexOf('setTimeout(pruneRevokedTokens, 60 * 1000).unref();') !== -1,
    'a first pass is scheduled shortly after boot and does not hold the loop');
  assert.ok(source.indexOf('setInterval(pruneRevokedTokens, REVOKED_TOKEN_PRUNE_INTERVAL_MS).unref();') !== -1,
    'a daily interval is scheduled and unref\'d');
  assert.ok(source.indexOf('TokenRevocation.pruneExpired(sessionRevocationStore)') !== -1,
    'the schedule uses the service helper');
});

// ---------------------------------------------------------------------------
// 3. Source contract: the response precedes the work
// ---------------------------------------------------------------------------

test('the forgot-password route answers before it starts the account work', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const routeStart = source.indexOf("app.post('/api/auth/forgot-password'");
  assert.ok(routeStart !== -1);

  const routeEnd = source.indexOf('\n});', routeStart);
  assert.ok(routeEnd > routeStart, 'the route has a terminator');
  const routeBody = source.slice(routeStart, routeEnd);
  const respond = routeBody.indexOf('res.json({');
  const dispatch = routeBody.indexOf('setImmediate(function () {');

  assert.ok(respond !== -1, 'the route answers');
  assert.ok(dispatch !== -1, 'the work is dispatched');
  assert.ok(respond < dispatch, 'the answer must be written before the work starts');
  assert.strictEqual(routeBody.indexOf('await processPasswordResetRequest'), -1,
    'the route must not await the account work');
  assert.strictEqual(routeBody.indexOf('await getUserByEmail'), -1,
    'the lookup must not happen before the answer');
});

test('the detached work swallows its own failures', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = source.indexOf('async function processPasswordResetRequest');
  assert.ok(start !== -1);
  const nextRoute = source.indexOf("app.post('/api/auth/reset-password'", start);
  assert.ok(nextRoute > start, 'the helper is followed by the reset-password route');
  const body = source.slice(start, nextRoute);
  assert.ok(body.indexOf('try {') !== -1 && body.indexOf('catch (e)') !== -1);
  assert.ok(/console\.error\('Forgot password error:'/.test(body));
  assert.strictEqual(body.indexOf('res.'), -1, 'the helper never touches the response');
});

// ---------------------------------------------------------------------------
// 4. Migration 056 - case-insensitive uniqueness of users.email
//
// The pre-flight MUST cover exactly the scope of the index. The first revision
// filtered out `btrim(email) <> ''`, so two empty (or two identical
// whitespace-only) addresses passed the guard and CREATE UNIQUE INDEX then failed
// with a raw duplicate-key error. These tests pin the aligned rule.
// ---------------------------------------------------------------------------

function migrationSql() {
  return fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '056_users_email_unique.sql'), 'utf8');
}

function preflightBlock(sql) {
  return sql.slice(sql.indexOf('-- 1. PRE-FLIGHT'), sql.indexOf('-- 2. THE CONSTRAINT'));
}

/**
 * The rule the SQL implements, as a mirror so the semantics can be tested:
 * NULL never participates; every other value is keyed by its lowercased string.
 */
function duplicateKeys(emails) {
  const counts = new Map();
  for (const email of emails) {
    if (email === null || email === undefined) continue;
    const key = String(email).toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const duplicates = [];
  for (const [key, count] of counts) if (count > 1) duplicates.push(key);
  return duplicates;
}

test('the pre-flight scans exactly the scope of the index (every non-NULL email)', () => {
  const preflight = preflightBlock(migrationSql());

  // The old exclusion must never come back: it is what let a duplicate blank pair
  // through to the index and produced a raw error instead of this guard.
  assert.strictEqual(
    /WHERE email IS NOT NULL\s*AND\s*btrim\(email\)\s*<>\s*''/i.test(preflight), false,
    'the blank-email exclusion must not be reintroduced');

  // Both duplicate queries must jump straight from `WHERE email IS NOT NULL` to the
  // GROUP BY, i.e. no extra predicate may narrow the index scope.
  const scopedQueries = preflight.match(/WHERE email IS NOT NULL\s*\n\s*GROUP BY lower\(email\)/g) || [];
  assert.strictEqual(scopedQueries.length, 2, 'both duplicate queries scan every non-NULL row');

  // Blank values may appear only in the reporting filters, never as a filter on
  // the duplicate queries themselves.
  const withoutFilters = preflight.replace(/count\(\*\) FILTER \(WHERE[^)]*\)/g, '');
  assert.strictEqual(/btrim/i.test(withoutFilters.split('GROUP BY')[0]), false,
    'the WHERE clause must not narrow the index scope');

  assert.strictEqual((preflight.match(/GROUP BY lower\(email\)/g) || []).length, 2,
    'duplicates are grouped by the indexed expression');
  assert.strictEqual((preflight.match(/HAVING count\(\*\) > 1/g) || []).length, 2,
    'a group of two or more is a duplicate');
});

test('the pre-flight names blank duplicates and counts NULL rows explicitly', () => {
  const preflight = preflightBlock(migrationSql());

  assert.match(preflight, /HAVING count\(\*\) > 1 AND btrim\(lower\(email\)\) = ''/,
    'blank duplicate groups are counted separately so the message is legible');
  assert.match(preflight, /FILTER \(WHERE email IS NULL\)/, 'NULL rows are counted');
  assert.match(preflight, /FILTER \(WHERE email IS NOT NULL\)/, 'checked rows are counted');
  assert.match(preflight, /FILTER \(WHERE email IS NOT NULL AND btrim\(email\) = ''\)/,
    'blank values are counted');

  assert.match(preflight, /of which % are empty or whitespace-only/, 'the message explains the blank case');
  assert.match(preflight, /No row was changed/, 'the message states that nothing was modified');
  assert.match(preflight, /docs\/security\/AUTH_SESSION_HARDENING\.md/, 'the operator is pointed at the probe');
  assert.match(preflight, /% are NULL \(allowed any number of times\)/,
    'the success notice states that NULL values are unrestricted');
});

test('the pre-flight rule refuses every duplicate the index would reject', () => {
  // Mirrors the 14 cases executed against real PostgreSQL (scripts/verify-migration-056.js).
  assert.deepStrictEqual(duplicateKeys(['', '']), [''], 'two empty strings collide');
  assert.deepStrictEqual(duplicateKeys(['', '', '']), [''], 'three empty strings collide');
  assert.deepStrictEqual(duplicateKeys(['   ', '   ']), ['   '], 'identical whitespace collides');
  assert.deepStrictEqual(duplicateKeys([' A@x.test ', ' A@x.test ']), [' a@x.test '], 'identical padded values collide');
  assert.deepStrictEqual(duplicateKeys(['A@x.test', 'a@x.test']), ['a@x.test'], 'case-only duplicates collide');
  assert.deepStrictEqual(duplicateKeys(['', '', 'A@x.test', 'a@x.test']).sort(), ['', 'a@x.test'],
    'blank and address duplicates are both found');

  // ...and it stays aligned where the index allows coexistence.
  assert.deepStrictEqual(duplicateKeys([null, null]), [], 'NULLs never conflict');
  assert.deepStrictEqual(duplicateKeys(['', '   ']), [], "'' and '   ' are different strings");
  assert.deepStrictEqual(duplicateKeys(['a@x.test', ' a@x.test']), [], 'padding changes the key');
  assert.deepStrictEqual(duplicateKeys(['', null, 'a@x.test']), [], 'a single blank is allowed, as the index allows');
  assert.deepStrictEqual(duplicateKeys(['a@x.test', 'b@x.test']), [], 'distinct addresses do not conflict');
});

test('migration 056 is additive, non-destructive and idempotent', () => {
  const sql = migrationSql();
  const preflight = preflightBlock(sql);

  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique\s+ON public\.users \(lower\(email\)\)/,
    'the unique expression index is created idempotently');
  assert.match(sql, /indisunique/, 'the self-check verifies uniqueness');
  assert.match(sql, /lower%email%/, 'the self-check verifies the expression index');
  assert.match(sql, /CONCURRENTLY/, 'the large-table alternative is documented');

  assert.strictEqual(/DROP\s+TABLE/i.test(sql), false);
  assert.strictEqual(/\bDELETE\s+FROM/i.test(sql), false, 'the migration never deletes rows');
  assert.strictEqual(/\bUPDATE\s+public\.users/i.test(sql), false, 'the migration never rewrites accounts');
  assert.strictEqual(/\bINSERT\s+INTO/i.test(sql), false, 'the migration never inserts rows');
  assert.strictEqual(/\bSET\s+email\s*=/i.test(sql), false, 'no column is rewritten');
  assert.strictEqual(/\bTRIM\s*\(\s*email\s*\)/i.test(sql), false, 'no value is normalised');
});

test('the optional verification tool exercises the blank and NULL cases without a new dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const declared = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}));
  assert.strictEqual(declared.some(function (name) { return /pglite/i.test(name); }), false,
    'the verification engine must not become a project dependency');

  const tool = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-migration-056.js'), 'utf8');
  ['two empty-string addresses',
    'three empty-string addresses',
    'two identical whitespace-only addresses',
    'two NULL addresses (never conflict)',
    'apply twice (idempotency)'
  ].forEach(function (name) {
    assert.ok(tool.indexOf(name) !== -1, 'the tool covers: ' + name);
  });
  assert.ok(tool.indexOf("require('@electric-sql/pglite')") !== -1, 'it uses the WASM PostgreSQL engine');
  assert.ok(tool.indexOf('npm install --no-save') !== -1, 'it documents the out-of-tree install');
});
