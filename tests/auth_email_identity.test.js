'use strict';

/**
 * Account identity is the ADDRESS, not its capitalisation.
 *
 * Migration 056 enforces one row per lower(email); these tests cover the
 * application half of that contract, which was missing:
 *
 *   - logging in with a different case than the account was registered with;
 *   - registration refusing a case variant (including the unique-index race that
 *     the pre-check cannot see, which used to surface as a 500);
 *   - the password-reset request finding a mixed-case account at all (it used to
 *     lower-case the address and then query exactly, so those customers could
 *     never reset a password);
 *   - never resolving an AMBIGUOUS match (two rows differing only in case, which
 *     can exist only before the index is applied) by picking one.
 *
 * The lookup helper is unit-tested in-process; the routes are exercised over REAL
 * HTTP against the REAL server, with only Supabase substituted.
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

const AuthEntry = require('../services/AuthEntry');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-auth.js');
const JWT_SECRET = 'auth-email-identity-test-secret';
const SCENARIO_FILE = path.join(os.tmpdir(), 'auth-email-identity-' + process.pid + '.json');

const PASSWORD = 'CorrectHorseBattery9!';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const STORED_EMAIL = 'Mixed.Case@Example.test';

let child = null;
let base = '';
let output = '';

function scenario(document) {
  // 2FA off unless a test asks for it: these cases are about identity resolution,
  // and the email-2FA default would answer with a challenge instead of a session.
  const doc = Object.assign({ twofaType: 'none' }, document || {});
  fs.writeFileSync(SCENARIO_FILE, JSON.stringify(doc));
}

function account(email, over) {
  return Object.assign({
    id: 42,
    name: 'Identity Test',
    email,
    password_hash: PASSWORD_HASH,
    referral_code: 'TESTID42',
    is_admin: 0,
    environment: 'PRODUCTION'
  }, over || {});
}

function freePort() {
  return new Promise(function (resolve) {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      server.close(function () { resolve(port); });
    });
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error('server exited early with code ' + child.exitCode + '\n' + output);
    }
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) return;
    } catch (e) { /* not listening yet */ }
    await sleep(120);
  }
  throw new Error('server did not become healthy\n' + output);
}

async function post(route, body) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = { _raw: text.slice(0, 200) }; }
  return { status: res.status, json: json };
}

/* ---------------------------------------------------------------- unit tests */

function stubAdmin(handlers) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.strictEqual(table, 'users', 'the lookup must only query users');
      return {
        select(columns) {
          calls.push({ op: 'select', columns });
          const chain = {
            eq(column, value) {
              calls.push({ op: 'eq', column, value });
              return {
                limit(n) {
                  calls.push({ op: 'limit', n });
                  return handlers.exact();
                }
              };
            },
            ilike(column, pattern) {
              calls.push({ op: 'ilike', column, pattern });
              return {
                limit(n) {
                  calls.push({ op: 'limit', n });
                  return handlers.ilike();
                }
              };
            }
          };
          return chain;
        }
      };
    }
  };
}

test('findAccountByEmail: exact match wins and never runs the case-insensitive query', async () => {
  let ilikeRan = false;
  const admin = stubAdmin({
    exact: async function () { return { data: [{ id: 1, email: STORED_EMAIL }], error: null }; },
    ilike: async function () { ilikeRan = true; return { data: [], error: null }; }
  });
  const result = await AuthEntry.findAccountByEmail(admin, STORED_EMAIL);
  assert.deepStrictEqual(result, { ok: true, account: { id: 1, email: STORED_EMAIL } });
  assert.strictEqual(ilikeRan, false, 'the indexed exact query is the fast path');
});

test('findAccountByEmail: a case variant resolves to the same account', async () => {
  const admin = stubAdmin({
    exact: async function () { return { data: [], error: null }; },
    ilike: async function () { return { data: [{ id: 7, email: STORED_EMAIL }], error: null }; }
  });
  const result = await AuthEntry.findAccountByEmail(admin, 'mixed.case@example.TEST');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.account.id, 7);
  assert.deepStrictEqual(admin.calls.filter(function (c) { return c.op === 'ilike'; }),
    [{ op: 'ilike', column: 'email', pattern: 'mixed.case@example.TEST' }]);
});

test('findAccountByEmail: a near-miss is not a match (the LIKE pattern is not equality)', async () => {
  const admin = stubAdmin({
    exact: async function () { return { data: [], error: null }; },
    // A substring-style hit the normalised comparison must reject.
    ilike: async function () { return { data: [{ id: 9, email: 'not.mixed.case@example.test' }], error: null }; }
  });
  const result = await AuthEntry.findAccountByEmail(admin, 'mixed.case@example.test');
  assert.deepStrictEqual(result, { ok: true, account: null });
});

test('findAccountByEmail: two accounts differing only in case are reported as ambiguous, never chosen', async () => {
  const admin = stubAdmin({
    exact: async function () { return { data: [], error: null }; },
    ilike: async function () {
      return { data: [{ id: 1, email: 'Dup@Example.test' }, { id: 2, email: 'dup@example.test' }], error: null };
    }
  });
  const result = await AuthEntry.findAccountByEmail(admin, 'DUP@example.test');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.account, null, 'no account may be returned when the match is ambiguous');
  assert.strictEqual(result.ambiguous, true);
});

test('findAccountByEmail: a store error is reported, not swallowed as "no account"', async () => {
  const admin = stubAdmin({
    exact: async function () { return { data: null, error: { message: 'boom' } }; },
    ilike: async function () { return { data: [], error: null }; }
  });
  const result = await AuthEntry.findAccountByEmail(admin, 'x@example.test');
  assert.deepStrictEqual(result, { ok: false, reason: 'lookup-failed' });
});

test('findAccountByEmail: an empty address never reaches the database', async () => {
  let called = false;
  const admin = { from: function () { called = true; throw new Error('must not query'); } };
  const result = await AuthEntry.findAccountByEmail(admin, '   ');
  assert.deepStrictEqual(result, { ok: true, account: null });
  assert.strictEqual(called, false);
});

/* ------------------------------------------------------------------ HTTP tests */

test.before(async function () {
  scenario({ user: account(STORED_EMAIL) });

  const port = await freePort();
  base = 'http://127.0.0.1:' + port;

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      PORT: String(port),
      JWT_SECRET: JWT_SECRET,
      BASE_URL: base,
      SUPABASE_URL: 'http://127.0.0.1:1',
      SUPABASE_ANON_KEY: 'identity-anon',
      SUPABASE_SERVICE_KEY: 'identity-service',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_SUPPORT_CHAT_ID: '',
      TELEGRAM_ADMIN_IDS: '',
      PAYHIP_ENABLED: 'false',
      AUTH_SCENARIO_FILE: SCENARIO_FILE,
      AUTH_RATE_LIMIT_LOGIN_IP_MAX: '1000',
      AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX: '1000',
      AUTH_RATE_LIMIT_REGISTER_IP_MAX: '1000',
      NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD)
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', function (d) { output += d.toString(); });
  child.stderr.on('data', function (d) { output += d.toString(); });

  await waitForHealth();
});

test.after(async function () {
  if (child && child.exitCode === null) {
    try { child.kill('SIGTERM'); } catch (e) { /* already gone */ }
    await Promise.race([once(child, 'exit'), sleep(3000)]);
  }
});

test('login accepts the stored address in a different case', async function () {
  scenario({ user: account(STORED_EMAIL) });
  const res = await post('/api/auth/login', { email: 'mixed.case@EXAMPLE.TEST', password: PASSWORD });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json && res.json.token, 'a session token is issued');
  assert.strictEqual(res.json.user.email, STORED_EMAIL, 'the account keeps its stored spelling');
});

test('login still refuses an unknown address and a wrong password', async function () {
  scenario({ user: account(STORED_EMAIL) });
  const unknown = await post('/api/auth/login', { email: 'nobody@example.test', password: PASSWORD });
  assert.strictEqual(unknown.status, 401);
  const wrong = await post('/api/auth/login', { email: 'mixed.case@example.test', password: 'wrong-password' });
  assert.strictEqual(wrong.status, 401);
});

test('login refuses to choose between two accounts that differ only in case', async function () {
  output = '';
  scenario({
    users: [
      account('Dup@Example.test', { id: 1 }),
      account('dup@example.test', { id: 2 })
    ]
  });
  const res = await post('/api/auth/login', { email: 'DUP@example.test', password: PASSWORD });
  assert.strictEqual(res.status, 401, 'an ambiguous match must never sign anyone in');
  await sleep(150);
  assert.match(output, /ambiguous email lookup refused/, 'the ambiguity is logged for the operator');
});

test('registration rejects a case variant of an existing address', async function () {
  scenario({ users: [account(STORED_EMAIL)] });
  const res = await post('/api/auth/register', {
    name: 'Second', email: 'MIXED.CASE@example.test', password: 'another-password'
  });
  assert.strictEqual(res.status, 400, JSON.stringify(res.json));
  assert.strictEqual(res.json.error, 'Email already registered');
});

test('registration maps the unique-index race to the documented duplicate answer', async function () {
  // The pre-check sees no account (a concurrent registration is mid-flight), then
  // the insert hits the lower(email) unique index.
  scenario({ user: null, insertError: { code: '23505', message: 'duplicate key value violates unique constraint' } });
  const res = await post('/api/auth/register', {
    name: 'Racer', email: 'racer@example.test', password: 'another-password'
  });
  assert.strictEqual(res.status, 400, 'a race must not surface as a 500: ' + JSON.stringify(res.json));
  assert.strictEqual(res.json.error, 'Email already registered');
});

test('a password-reset request finds a mixed-case account', async function () {
  scenario({ user: account(STORED_EMAIL) });
  output = '';
  const res = await post('/api/auth/forgot-password', { email: 'mixed.case@example.test' });
  assert.strictEqual(res.status, 200);
  assert.match(res.json.message, /If an account with that email exists/);
  // The token row is written by the detached worker; its presence proves the
  // account was resolved (an unknown address writes nothing).
  await sleep(600);
  assert.match(output, /POST password_reset_tokens/, 'the reset token is stored for the account');
});

test('a password-reset request for an unknown address writes nothing', async function () {
  scenario({ user: account(STORED_EMAIL) });
  output = '';
  const res = await post('/api/auth/forgot-password', { email: 'nobody@example.test' });
  assert.strictEqual(res.status, 200, 'the answer is identical to the found case');
  assert.match(res.json.message, /If an account with that email exists/);
  await sleep(600);
  assert.strictEqual(output.indexOf('POST password_reset_tokens'), -1,
    'no token may be stored for an address that has no account');
});
