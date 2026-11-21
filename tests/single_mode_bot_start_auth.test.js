'use strict';
/**
 * Behavioural proof that removing Demo Mode did not open the trading gate.
 *
 * Boots the REAL server (offline Supabase stub) and calls /api/bot/start the
 * way an attacker would: no token, a forged token, and an authenticated but
 * fabricated body. A single `isRunning: true` on any of those would mean a
 * request value had bypassed activation/funding.
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-preload.js');
const JWT_SECRET = 'single-mode-guard-secret';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function startApp() {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      PORT: String(port),
      JWT_SECRET,
      BASE_URL: 'http://127.0.0.1:' + port,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_SUPPORT_CHAT_ID: '',
      TELEGRAM_ADMIN_IDS: '',
      NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD)
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('server exited during boot: ' + output.slice(-1200));
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) break;
    } catch (e) { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('server did not become healthy: ' + output.slice(-1200));
    await new Promise((r) => setTimeout(r, 150));
  }
  return { base, stop() { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } } };
}

let app;
test.before(async () => { app = await startApp(); });
test.after(() => { if (app) app.stop(); });

const start = (headers, body) => fetch(app.base + '/api/bot/start', {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, headers),
  body: JSON.stringify(body || {})
});

const tokenFor = (id) => jwt.sign({ id, email: 'guard-' + id + '@example.test', role: 'user' }, JWT_SECRET);

test('1. an unauthenticated start is refused before any gate', async () => {
  const res = await start({}, { mode: 'demo' });
  assert.strictEqual(res.status, 401, '401 without a token');
  const body = await res.json();
  assert.ok(!body.isRunning, 'no session is reported');
});

test('2. a forged bearer token is refused', async () => {
  const forged = jwt.sign({ id: 1, role: 'user' }, 'wrong-secret');
  const res = await start({ authorization: 'Bearer ' + forged }, { mode: 'demo' });
  assert.strictEqual(res.status, 401, 'a bad signature is not a session');
  assert.ok(!(await res.json()).isRunning);
});

test('3. a forged demo mode cannot bypass activation or funding', async () => {
  const res = await start({ authorization: 'Bearer ' + tokenFor(770001) },
    { mode: 'demo', balance: 99999, live_balance: 99999 });
  assert.notStrictEqual(res.status, 200, 'an ineligible account is never started');
  const body = await res.json();
  assert.ok(!body.isRunning, 'no trading session is created');
  // The refusal is actionable, and it is one of the real gates - never a demo grant.
  assert.ok(body.code || body.activationRequired || body.fundingRequired || body.error,
    'the refusal explains itself');
});

test('4. repeated start attempts stay refused (no state is created)', async () => {
  const first = await start({ authorization: 'Bearer ' + tokenFor(770002) }, { mode: 'demo' });
  const second = await start({ authorization: 'Bearer ' + tokenFor(770002) }, { mode: 'demo' });
  assert.strictEqual(first.status, second.status, 'the answer is stable');
  assert.ok(!(await second.json()).isRunning, 'still no session');
});

test('5. the status route never reports a running bot for an ineligible account', async () => {
  const res = await fetch(app.base + '/api/bot/status', {
    headers: { authorization: 'Bearer ' + tokenFor(770003) }
  });
  assert.ok([200, 401, 403, 404, 500].includes(res.status), 'it answers');
  if (res.status === 200) {
    const body = await res.json();
    assert.notStrictEqual(body.isRunning, true, 'nothing is running for this account');
  }
});
