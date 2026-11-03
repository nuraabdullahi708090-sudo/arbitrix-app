'use strict';

/**
 * UNKNOWN API PATHS MUST ANSWER A JSON 404.
 *
 * The SPA fallback is `app.use(...)`, which catches every method and path, so a
 * missing or mistyped API endpoint used to be answered with index.html and HTTP
 * 200. That hides wiring mistakes from monitoring, from a client's own logging
 * and from whoever is reading the logs while diagnosing an integration - the
 * exact situation that made a reported 404 impossible to pin down.
 *
 * These tests boot the REAL server process (with the offline Supabase stub) so
 * the middleware order is exercised for real: the new guard must sit after every
 * API route and before the SPA fallback.
 */

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-preload.js');
const JWT_SECRET = 'api-404-contract-test-secret';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
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
  return {
    base,
    stop() {
      try { child.kill('SIGTERM'); } catch (e) { /* already gone */ }
    }
  };
}

let app;
test.before(async () => { app = await startApp(); });
test.after(() => { if (app) app.stop(); });

const isJson = (res) => String(res.headers.get('content-type') || '').includes('application/json');

test('an unknown GET /api path answers JSON 404, not the SPA shell', async () => {
  const res = await fetch(app.base + '/api/does-not-exist');
  assert.strictEqual(res.status, 404);
  assert.ok(isJson(res), 'JSON content type');
  const body = await res.json();
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.error, 'Not found');
  assert.strictEqual(body.method, 'GET');
  assert.strictEqual(body.path, '/api/does-not-exist');
});

test('an unknown POST /api path answers JSON 404 and reports the method', async () => {
  const res = await fetch(app.base + '/api/does-not-exist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.strictEqual(res.status, 404);
  const body = await res.json();
  assert.strictEqual(body.method, 'POST');
  assert.strictEqual(body.path, '/api/does-not-exist');
});

test('the removed diagnostic endpoint now reports 404 instead of the app shell', async () => {
  for (const method of ['GET', 'POST']) {
    const res = await fetch(app.base + '/api/telegram/diagnose', { method });
    assert.strictEqual(res.status, 404, method + ' must be 404');
    assert.ok(isJson(res), method + ' must answer JSON');
  }
});

test('the query string is stripped from the reported path', async () => {
  const res = await fetch(app.base + '/api/nope?token=secret&x=1');
  assert.strictEqual(res.status, 404);
  const body = await res.json();
  assert.strictEqual(body.path, '/api/nope', 'no query string is echoed back');
  assert.ok(!JSON.stringify(body).includes('secret'), 'no query values are echoed back');
});

test('the 404 body is small and never contains HTML', async () => {
  const res = await fetch(app.base + '/api/does-not-exist');
  const text = await res.text();
  assert.ok(!/<html/i.test(text), 'no HTML document');
  assert.ok(text.length < 300, 'small body');
});

test('real API routes are untouched (health, webhook auth)', async () => {
  const health = await fetch(app.base + '/api/health');
  assert.strictEqual(health.status, 200);
  assert.deepStrictEqual(await health.json(), { status: 'ok' });

  const webhook = await fetch(app.base + '/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  // With no bot/secret configured in this test env the handler answers 503
  // "not configured"; with a secret configured it answers 401. Both are the
  // fail-closed states - what matters is that it is never 2xx.
  assert.ok([401, 503].includes(webhook.status), 'the webhook still fails closed, got ' + webhook.status);
  const webhookBody = await webhook.json();
  assert.strictEqual(webhookBody.ok, false);
});

test('the SPA fallback still serves the app for non-API paths', async () => {
  for (const p of ['/', '/login', '/dashboard']) {
    const res = await fetch(app.base + p);
    assert.strictEqual(res.status, 200, p + ' still serves the app');
    assert.ok(String(res.headers.get('content-type') || '').includes('text/html'), p + ' is HTML');
  }
});

test('the static tutorial page is still served', async () => {
  const res = await fetch(app.base + '/deposit-tutorials');
  assert.strictEqual(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('t.me/ArbitrixAnnouncements/17'), 'the approved Paybis tutorial is linked');
});

test('the media 404 guard is unchanged', async () => {
  const res = await fetch(app.base + '/video/does-not-exist.mp4');
  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(await res.json(), { success: false, error: 'Not found' });
});

test('the guard is registered after every API route and before the fallback', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const guard = src.indexOf("app.use('/api', (req, res) => {");
  assert.ok(guard > 0, 'the guard exists');
  // The fallback is the LAST place that serves index.html.
  const fallback = src.lastIndexOf("res.sendFile(path.join(__dirname, 'public', 'index.html'))");
  assert.ok(fallback > 0 && guard < fallback, 'the guard is registered before the SPA fallback');
  const videoGuard = src.indexOf("app.use('/video', (req, res) => {");
  assert.ok(videoGuard > 0 && videoGuard < guard, 'the media guard keeps its earlier position');
});
