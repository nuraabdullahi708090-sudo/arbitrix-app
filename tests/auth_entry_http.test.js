'use strict';

/**
 * Authentication entry-point hardening - real HTTP tests.
 *
 * The REAL server is booted and the REAL routes are called; only Supabase is
 * substituted (tests/helpers/fake-supabase-auth.js). No database, no mailer and
 * no production traffic is involved.
 *
 * Proves:
 *   - an account with a second factor enabled cannot obtain a full session from
 *     EITHER login entry point (legacy alias included);
 *   - the existing challenge flow still answers exactly as before;
 *   - an account without a second factor still logs in normally;
 *   - login throttling is enforced per account, is cleared by a success, and
 *     does not affect other accounts;
 *   - registration throttling is enforced;
 *   - throttling answers are 429 + Retry-After and never contain a token.
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

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-auth.js');
const JWT_SECRET = 'auth-entry-hardening-test-secret';
const SCENARIO_FILE = path.join(os.tmpdir(), 'auth-entry-' + process.pid + '.json');

const PASSWORD = 'CorrectHorseBattery9!';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

const ACCOUNT_LIMIT = 3;
const REGISTER_LIMIT = 2;

let child = null;
let base = '';
let output = '';

function scenario(document) {
  fs.writeFileSync(SCENARIO_FILE, JSON.stringify(document || {}));
}

function userFor(email) {
  return {
    id: 42,
    name: 'Auth Test',
    email: email,
    password_hash: PASSWORD_HASH,
    referral_code: 'TEST42',
    is_admin: 0,
    environment: 'PRODUCTION'
  };
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
  return { status: res.status, json: json, headers: res.headers };
}

test.before(async function () {
  scenario({ user: userFor('auth@example.test'), twofaType: 'totp', twofaEnabled: true });

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
      SUPABASE_ANON_KEY: 'auth-entry-anon',
      SUPABASE_SERVICE_KEY: 'auth-entry-service',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_SUPPORT_CHAT_ID: '',
      TELEGRAM_ADMIN_IDS: '',
      PAYHIP_ENABLED: 'false',
      AUTH_SCENARIO_FILE: SCENARIO_FILE,
      // Per-account failures reach the limit quickly; the IP budget stays large
      // so the account behaviour is what is measured.
      AUTH_RATE_LIMIT_LOGIN_IP_MAX: '1000',
      AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX: String(ACCOUNT_LIMIT),
      AUTH_RATE_LIMIT_REGISTER_IP_MAX: String(REGISTER_LIMIT),
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

test('startup creates NO default administrator', function () {
  // The seeder used to run on every boot. It must not have run here: there is
  // no ADMIN_PROVISION_* in the environment, and no provisioning log line.
  assert.strictEqual(output.indexOf('administrator created'), -1, output.slice(0, 500));
  assert.strictEqual(output.indexOf('admin123'), -1);
});

test('a 2FA account cannot get a session token from the legacy login route', async function () {
  scenario({ user: userFor('auth@example.test'), twofaType: 'totp', twofaEnabled: true });

  const res = await post('/api/auth/login', { email: 'auth@example.test', password: PASSWORD });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.requires2FA, true);
  assert.strictEqual(res.json.twoFactorType, 'totp');
  assert.ok(typeof res.json.partialToken === 'string' && res.json.partialToken.length > 20);
  assert.strictEqual(res.json.token, undefined, 'no full session before the second factor');
  assert.strictEqual(res.json.user, undefined);
});

test('the 2FA initiate route behaves identically (one shared flow)', async function () {
  scenario({ user: userFor('auth@example.test'), twofaType: 'totp', twofaEnabled: true });

  const legacy = await post('/api/auth/login', { email: 'auth@example.test', password: PASSWORD });
  const initiate = await post('/api/2fa/login-initiate', { email: 'auth@example.test', password: PASSWORD });

  assert.strictEqual(legacy.status, initiate.status);
  assert.strictEqual(legacy.json.requires2FA, initiate.json.requires2FA);
  assert.strictEqual(legacy.json.twoFactorType, initiate.json.twoFactorType);
  assert.ok(typeof initiate.json.partialToken === 'string');
  assert.strictEqual(initiate.json.token, undefined);
});

test('a partial token is not accepted as a session', async function () {
  scenario({ user: userFor('auth@example.test'), twofaType: 'totp', twofaEnabled: true });
  const res = await post('/api/auth/login', { email: 'auth@example.test', password: PASSWORD });

  const me = await fetch(base + '/api/auth/me', {
    headers: { Authorization: 'Bearer ' + res.json.partialToken }
  });
  assert.strictEqual(me.status, 401, 'the pending 2FA token must not authenticate');
});

test('an account without a second factor still logs in normally', async function () {
  scenario({ user: userFor('plain@example.test'), twofaType: 'totp', twofaEnabled: false });

  const res = await post('/api/auth/login', { email: 'plain@example.test', password: PASSWORD });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.requires2FA, false);
  assert.ok(typeof res.json.token === 'string' && res.json.token.length > 20);
  assert.strictEqual(res.json.user.email, 'plain@example.test');
  assert.strictEqual(res.json.user.environment, 'PRODUCTION');
});

test('wrong credentials are rejected and the account is throttled after the limit', async function () {
  scenario({ user: userFor('lock@example.test'), twofaType: 'totp', twofaEnabled: true });

  for (let i = 0; i < ACCOUNT_LIMIT; i += 1) {
    const bad = await post('/api/auth/login', { email: 'lock@example.test', password: 'wrong-password' });
    assert.strictEqual(bad.status, 401);
  }

  // The gate runs BEFORE credential verification: even the correct password is
  // refused while the account is throttled, and no token is issued.
  const blocked = await post('/api/auth/login', { email: 'lock@example.test', password: PASSWORD });
  assert.strictEqual(blocked.status, 429);
  assert.ok(blocked.json.retryAfter >= 1);
  assert.ok(blocked.headers.get('retry-after'));
  assert.strictEqual(blocked.json.token, undefined);
  assert.strictEqual(blocked.json.partialToken, undefined);
});

test('throttling one account does not block another from the same IP', async function () {
  scenario({ user: userFor('other@example.test'), twofaType: 'totp', twofaEnabled: true });

  const res = await post('/api/auth/login', { email: 'other@example.test', password: 'wrong-password' });
  assert.strictEqual(res.status, 401, 'a fresh account is not caught by another account bucket');
});

test('a successful login clears the accumulated failures', async function () {
  scenario({ user: userFor('reset@example.test'), twofaType: 'totp', twofaEnabled: true });

  for (let i = 0; i < ACCOUNT_LIMIT - 1; i += 1) {
    assert.strictEqual((await post('/api/auth/login', { email: 'reset@example.test', password: 'wrong' })).status, 401);
  }
  const ok = await post('/api/auth/login', { email: 'reset@example.test', password: PASSWORD });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.requires2FA, true);

  // A fresh budget: the same number of failures is allowed again before the
  // limit is reached, which proves the counter was reset by the success.
  for (let i = 0; i < ACCOUNT_LIMIT; i += 1) {
    const res = await post('/api/auth/login', { email: 'reset@example.test', password: 'wrong' });
    assert.strictEqual(res.status, 401);
  }
  const blocked = await post('/api/auth/login', { email: 'reset@example.test', password: PASSWORD });
  assert.strictEqual(blocked.status, 429);
});

test('registration is throttled per IP with a predictable answer', async function () {
  scenario({ user: null, twofaType: 'totp', twofaEnabled: false });

  for (let i = 0; i < REGISTER_LIMIT; i += 1) {
    const res = await post('/api/auth/register', {
      name: 'New User ' + i,
      email: 'new.user.' + i + '@example.test',
      password: 'another-strong-password'
    });
    assert.strictEqual(res.status, 200, 'registration under the limit succeeds: ' + JSON.stringify(res.json));
  }

  const blocked = await post('/api/auth/register', {
    name: 'Blocked User',
    email: 'blocked@example.test',
    password: 'another-strong-password'
  });
  assert.strictEqual(blocked.status, 429);
  assert.ok(blocked.headers.get('retry-after'));
  assert.ok(/registration attempts/i.test(blocked.json.error));
  assert.strictEqual(blocked.json.token, undefined);
});

test('the throttle message never reveals whether an account exists', async function () {
  scenario({ user: null, twofaType: 'totp', twofaEnabled: false });

  // A never-existing address that is already over its account limit gives the
  // same 429 shape as an existing one would.
  for (let i = 0; i < ACCOUNT_LIMIT; i += 1) {
    await post('/api/auth/login', { email: 'ghost@example.test', password: 'wrong' });
  }
  const blocked = await post('/api/auth/login', { email: 'ghost@example.test', password: 'wrong' });
  assert.strictEqual(blocked.status, 429);
  assert.ok(!/not found|no account|unknown|does not exist|email/i.test(blocked.json.error), blocked.json.error);
});

// ---------------------------------------------------------------------------
// Malformed request bodies
//
// A request with no body used to throw inside the shared login handler
// (`Cannot destructure property 'email' of 'req.body'`) and answer 500. A missing
// body is a client error: it must be 400, with no stack and no side effect.
// ---------------------------------------------------------------------------

test('a login request with no body at all answers 400, not 500', async function () {
  const res = await fetch(base + '/api/auth/login', { method: 'POST' });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.match(String(body.error), /required/i);
  assert.strictEqual(body.token, undefined);
  assert.strictEqual(output.indexOf('Cannot destructure'), -1, 'no TypeError is raised');
});

test('an empty JSON body is rejected as a client error', async function () {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: ''
  });
  assert.strictEqual(res.status, 400);
});

test('a JSON object with no credentials is rejected as a client error', async function () {
  const res = await post('/api/auth/login', {});
  assert.strictEqual(res.status, 400);
  assert.match(String(res.json.error), /required/i);
});

test('half the credentials is still a client error, on both entry points', async function () {
  const legacy = await post('/api/auth/login', { email: 'nobody@example.test' });
  assert.strictEqual(legacy.status, 400);

  const initiate = await post('/api/2fa/login-initiate', { password: 'irrelevant' });
  assert.strictEqual(initiate.status, 400);
  assert.strictEqual(initiate.json.token, undefined);
});

test('a non-object JSON body cannot break the handler', async function () {
  for (const payload of ['null', '"a string"', '[]', '42']) {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
    assert.strictEqual(res.status, 400, 'payload ' + payload);
  }
});

test('malformed JSON is a 400 with no server error', async function () {
  const before = output.length;
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"email": '
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(output.slice(before).indexOf('Cannot destructure'), -1);
});

test('the other auth entry points also survive an absent body', async function () {
  for (const route of ['/api/auth/forgot-password', '/api/auth/reset-password']) {
    const res = await fetch(base + route, { method: 'POST' });
    assert.strictEqual(res.status, 400, route);
    assert.strictEqual(output.indexOf('Cannot destructure'), -1, route);
  }
});
