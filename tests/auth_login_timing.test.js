'use strict';

/**
 * Login timing: an unknown address must cost about as much as a wrong password.
 *
 * The route answered the same 401 for both, but only the KNOWN account ran a
 * bcrypt verify (~75 ms with cost 10) while an unknown address answered after a
 * single failed lookup (~1 ms). The duration therefore answered "does this
 * account exist here?" despite the identical body.
 *
 * The fix compares the submitted password against a throwaway hash when no
 * account matched, so the branch does the same work. The comparison result is
 * ignored, and it can never authenticate anything.
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
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-auth.js');
const SCENARIO_FILE = path.join(os.tmpdir(), 'login-timing-' + process.pid + '.json');

const PASSWORD = 'CorrectHorseBattery9!';

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

async function bootServer() {
  fs.writeFileSync(SCENARIO_FILE, JSON.stringify({
    twofaType: 'none',
    user: {
      id: 9001, name: 'Timing', email: 'timing@example.test',
      password_hash: bcrypt.hashSync(PASSWORD, 10),
      referral_code: 'ARBI-TIM001', is_admin: 0, environment: 'PRODUCTION',
    },
  }));
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'login-timing-test-secret', BASE_URL: base,
      SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 't-anon', SUPABASE_SERVICE_KEY: 't-service',
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_SUPPORT_CHAT_ID: '', TELEGRAM_ADMIN_IDS: '',
      PAYHIP_ENABLED: 'false', AUTH_SCENARIO_FILE: SCENARIO_FILE,
      AUTH_RATE_LIMIT_LOGIN_IP_MAX: '1000',
      AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX: '1000',
      NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD),
    }),
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
      if (res.ok) return { base, child };
    } catch (e) { /* not up */ }
    await sleep(120);
  }
  throw new Error('server not healthy\n' + output);
}

async function attempt(base, email, password) {
  const started = process.hrtime.bigint();
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => null);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { status: res.status, body, ms };
}

test('an unknown address does the same work as a wrong password', async () => {
  const server = await bootServer();
  try {
    // Warm up: the first request pays module/JIT costs.
    await attempt(server.base, 'warmup@example.test', 'wrong');

    const unknown = await attempt(server.base, 'nobody@example.test', 'wrong-password');
    const wrong = await attempt(server.base, 'timing@example.test', 'wrong-password');

    assert.strictEqual(unknown.status, 401);
    assert.strictEqual(wrong.status, 401);
    assert.deepStrictEqual(unknown.body, wrong.body, 'identical body: no enumeration signal from the payload');

    // A bcrypt verify at cost 10 takes tens of milliseconds; a bare failed lookup
    // takes about one. The threshold is deliberately far below the real cost so
    // the test is not sensitive to machine speed, but far above a lookup.
    assert.ok(unknown.ms >= 15, 'the unknown-address branch ran a password hash (took ' + unknown.ms.toFixed(1) + 'ms)');
    assert.ok(wrong.ms >= 15, 'the wrong-password branch runs a password hash (took ' + wrong.ms.toFixed(1) + 'ms)');
    assert.ok(unknown.ms > wrong.ms * 0.4,
      'the two branches are within the same order of magnitude (unknown ' +
      unknown.ms.toFixed(1) + 'ms vs wrong ' + wrong.ms.toFixed(1) + 'ms)');
  } finally {
    if (server.child.exitCode === null) {
      try { server.child.kill('SIGTERM'); } catch (e) { /* gone */ }
      await Promise.race([once(server.child, 'exit'), sleep(4000)]);
    }
  }
});

test('the equaliser hash can never authenticate: a matching input still returns 401', async () => {
  // The constant is public, so pin the property that makes that harmless: a
  // submitted password equal to the dummy plaintext (unknown to us, but even if
  // it were known) cannot log in, because the comparison result is ignored and
  // the branch returns before any session is issued.
  const idx = SERVER.indexOf('const LOGIN_TIMING_EQUALISER_HASH');
  assert.ok(idx > -1, 'the equaliser constant exists');
  const block = SERVER.slice(idx, idx + 2200);
  assert.match(block, /await bcrypt\.compare\(password, LOGIN_TIMING_EQUALISER_HASH\)/);
  assert.ok(!/passwordValid|signSessionToken/.test(block.slice(block.indexOf('if (!user)'), block.indexOf('const passwordValid'))),
    'the equaliser branch cannot reach a session');

  const server = await bootServer();
  try {
    const res = await attempt(server.base, 'nobody@example.test', 'timing-equaliser-not-a-password');
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'Invalid credentials');
  } finally {
    if (server.child.exitCode === null) {
      try { server.child.kill('SIGTERM'); } catch (e) { /* gone */ }
      await Promise.race([once(server.child, 'exit'), sleep(4000)]);
    }
  }
});
