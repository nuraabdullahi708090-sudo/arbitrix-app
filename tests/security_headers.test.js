'use strict';

/**
 * Baseline security headers.
 *
 * The application sent none: no clickjacking protection, no MIME-sniffing guard
 * and no referrer policy. These tests boot the REAL server and assert the
 * headers on the surfaces that matter (a page, the API, a 404, a static asset),
 * plus the two properties that make the set safe: HSTS only appears when the
 * request really arrived over TLS, and the CSP restricts nothing except framing.
 */

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-preload.js');
const JWT_SECRET = 'security-headers-test-secret';

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
    stop() { try { child.kill('SIGTERM'); } catch (e) { /* already gone */ } }
  };
}

let app;
test.before(async () => { app = await startApp(); });
test.after(() => { if (app) app.stop(); });

const EXPECT = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin'
};

test('the headers are on the app shell (HTML)', async () => {
  const res = await fetch(app.base + '/');
  assert.strictEqual(res.status, 200);
  for (const [name, value] of Object.entries(EXPECT)) {
    assert.strictEqual(res.headers.get(name), value, name + ' on /');
  }
  assert.strictEqual(res.headers.get('content-security-policy'), "frame-ancestors 'none'");
});

test('the headers are on API responses', async () => {
  const res = await fetch(app.base + '/api/health');
  for (const [name, value] of Object.entries(EXPECT)) {
    assert.strictEqual(res.headers.get(name), value, name + ' on /api/health');
  }
});

test('the headers survive the JSON 404 path and a static asset', async () => {
  const notFound = await fetch(app.base + '/api/nope');
  assert.strictEqual(notFound.status, 404);
  assert.strictEqual(notFound.headers.get('x-frame-options'), 'DENY');

  const asset = await fetch(app.base + '/manifest.json').catch(() => null);
  if (asset && asset.ok) {
    assert.strictEqual(asset.headers.get('x-content-type-options'), 'nosniff', 'nosniff on an asset');
  }
});

test('the CSP restricts framing only: no script/style/img rules to break the app', async () => {
  const res = await fetch(app.base + '/');
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /frame-ancestors 'none'/);
  for (const directive of ["script-src", "style-src", "img-src", "connect-src", "default-src"]) {
    assert.ok(!csp.includes(directive), 'the policy must not set ' + directive);
  }
});

test('HSTS appears only for a TLS-terminated request', async () => {
  const plain = await fetch(app.base + '/api/health');
  assert.strictEqual(plain.headers.get('strict-transport-security'), null,
    'a plain http request must not be pinned to https (local dev stays usable)');

  const tls = await fetch(app.base + '/api/health', { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(String(tls.headers.get('strict-transport-security') || ''), /max-age=\d{6,}/,
    'behind the TLS-terminating proxy the header is sent');
});

test('the middleware is registered before the body parser and the routes', () => {
  const src = require('node:fs').readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const mw = src.indexOf("res.setHeader('X-Frame-Options', 'DENY')");
  assert.ok(mw > 0, 'the middleware exists');
  assert.ok(mw < src.indexOf('app.use(express.json('), 'registered before the body parser');
  assert.ok(mw < src.indexOf("app.post('/api/payhip/webhook'"), 'registered before the routes');
});
