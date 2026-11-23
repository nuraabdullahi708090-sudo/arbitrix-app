'use strict';

/**
 * Trusted client IP identification - unit and real HTTP tests.
 *
 * Proves:
 *   - proxy trust is explicit, safe by default, and refuses blanket trust;
 *   - a client-supplied X-Forwarded-For cannot influence the identity the server
 *     uses for rate limiting or audit records;
 *   - when a proxy IS declared, Express's rightmost-entry semantics apply, so a
 *     client-prepended value is ignored;
 *   - login, registration and forgot-password limiting all key on that address.
 *
 * The HTTP cases boot the REAL server with a stubbed Supabase; nothing touches a
 * database, a mailer or production.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ClientIp = require('../services/ClientIp');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-auth.js');
const SCENARIO_FILE = path.join(os.tmpdir(), 'trusted-proxy-' + process.pid + '.json');

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

/**
 * Boot the real server and hand back a small client. The caller MUST close it.
 */
async function startServer(env) {
  fs.writeFileSync(SCENARIO_FILE, JSON.stringify({ user: null, twofaType: 'totp', twofaEnabled: false }));

  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  let output = '';

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      PORT: String(port),
      JWT_SECRET: 'trusted-proxy-test-secret',
      BASE_URL: base,
      SUPABASE_URL: 'http://127.0.0.1:1',
      SUPABASE_ANON_KEY: 'proxy-anon',
      SUPABASE_SERVICE_KEY: 'proxy-service',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_SUPPORT_CHAT_ID: '',
      TELEGRAM_ADMIN_IDS: '',
      PAYHIP_ENABLED: 'false',
      AUTH_SCENARIO_FILE: SCENARIO_FILE,
      NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD)
    }, env || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', function (d) { output += d.toString(); });
  child.stderr.on('data', function (d) { output += d.toString(); });

  const deadline = Date.now() + 20000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited early:\n' + output);
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) { healthy = true; break; }
    } catch (e) { /* not listening yet */ }
    await sleep(120);
  }
  if (!healthy) throw new Error('server did not become healthy:\n' + output);

  return {
    base: base,
    output: function () { return output; },
    post: async function (route, body, headers) {
      const res = await fetch(base + route, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(body || {})
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { json = { _raw: text.slice(0, 200) }; }
      return { status: res.status, json: json, headers: res.headers };
    },
    close: async function () {
      if (child.exitCode === null) {
        try { child.kill('SIGTERM'); } catch (e) { /* already gone */ }
        await Promise.race([once(child, 'exit'), sleep(4000)]);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// 1. Proxy trust resolution
// ---------------------------------------------------------------------------

test('proxy trust is off by default: no header can be trusted', () => {
  const resolved = ClientIp.resolveProxyTrust({});
  assert.strictEqual(resolved.mode, 'none');
  assert.strictEqual(resolved.value, false);
  assert.strictEqual(resolved.source, 'default');
});

test('a hop count is accepted only inside the documented range', () => {
  assert.strictEqual(ClientIp.resolveProxyTrust({ TRUST_PROXY_HOPS: '1' }).value, 1);
  assert.strictEqual(ClientIp.resolveProxyTrust({ TRUST_PROXY_HOPS: '2' }).value, 2);
  assert.strictEqual(ClientIp.resolveProxyTrust({ TRUST_PROXY_HOPS: '10' }).value, 10);

  ['0', '11', '-1', 'abc', '2.5', ''].forEach(function (value) {
    const resolved = ClientIp.resolveProxyTrust({ TRUST_PROXY_HOPS: value });
    assert.strictEqual(resolved.mode, 'none', 'TRUST_PROXY_HOPS=' + JSON.stringify(value));
    assert.strictEqual(resolved.value, false);
    if (value !== '') assert.ok(resolved.warning, 'invalid values warn instead of failing silently');
  });
});

test('a CIDR list is accepted and passed to Express verbatim', () => {
  const resolved = ClientIp.resolveProxyTrust({ TRUST_PROXY: 'loopback,10.0.0.0/8, 172.16.0.0/12' });
  assert.strictEqual(resolved.mode, 'list');
  assert.strictEqual(resolved.value, 'loopback, 10.0.0.0/8, 172.16.0.0/12');
});

test('blanket trust is refused: it would accept a client-supplied chain', () => {
  ['true', '*', 'all', '0.0.0.0/0', '::/0', 'loopback,true'].forEach(function (value) {
    const resolved = ClientIp.resolveProxyTrust({ TRUST_PROXY: value });
    assert.strictEqual(resolved.mode, 'none', 'TRUST_PROXY=' + value);
    assert.strictEqual(resolved.value, false);
    assert.ok(/blanket|unsupported/i.test(resolved.warning || ''), 'a warning is produced');
  });
});

test('an unrecognised trust entry disables trust rather than guessing', () => {
  const resolved = ClientIp.resolveProxyTrust({ TRUST_PROXY: 'loopback,not-a-cidr' });
  assert.strictEqual(resolved.mode, 'none');
  assert.match(resolved.warning, /unsupported/i);
});

test('invalid addresses and out-of-range prefixes are refused, not passed to Express', () => {
  // These used to pass the (regex) validator and then make `app.set('trust proxy')`
  // throw while server.js was loading - an operator typo became a crash loop.
  for (const bad of ['999.1.1.1', '1.2.3.4/99', '1.2.3.4/33', '::::', '2001:db8::/129',
    'not-an-ip', '10.0.0.0/8/8', '1.2.3/24']) {
    assert.strictEqual(ClientIp.isTrustToken(bad), false, bad + ' must be refused');
    const resolved = ClientIp.resolveProxyTrust({ TRUST_PROXY: bad });
    assert.strictEqual(resolved.mode, 'none', bad + ' disables trust instead of reaching Express');
    assert.ok(resolved.warning, bad + ' warns');
  }
  // Valid forms, including per-family prefix maxima.
  for (const good of ['loopback', '10.0.0.0/8', '1.2.3.4', '1.2.3.4/32',
    '2001:db8::/32', '::1', 'fd00::/8']) {
    assert.strictEqual(ClientIp.isTrustToken(good), true, good + ' must be accepted');
  }
});

test('an unusually broad trust range is accepted but reported at startup', () => {
  const broad = ClientIp.resolveProxyTrust({ TRUST_PROXY: '0.0.0.0/2' });
  assert.strictEqual(broad.mode, 'list', 'still honoured: it may be a genuine private range');
  assert.match(broad.warning || '', /unusually broad/i);

  const v6 = ClientIp.resolveProxyTrust({ TRUST_PROXY: '2001:db8::/4' });
  assert.match(v6.warning || '', /unusually broad/i);

  // A /8 (IPv4) or /16 (IPv6) is the threshold and does not warn.
  assert.ok(!ClientIp.resolveProxyTrust({ TRUST_PROXY: '10.0.0.0/8' }).warning);
  assert.ok(!ClientIp.resolveProxyTrust({ TRUST_PROXY: '2001:db8::/16' }).warning);
  assert.ok(!ClientIp.resolveProxyTrust({ TRUST_PROXY: '203.0.113.9' }).warning);
});

test('the Cloudflare -> Render chain: two trusted hops resolve to the customer', async () => {
  // Simulates the documented production chain. Render's router appends the
  // Cloudflare edge address, Cloudflare appends the customer, so the app sees
  // "customer, cf-edge" and the socket peer is Render. With two trusted hops
  // req.ip is the customer; a client-prepended value is ignored.
  const server = await startServer({
    TRUST_PROXY_HOPS: '2',
    AUTH_RATE_LIMIT_LOGIN_IP_MAX: '5',
    AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX: '1000'
  });
  try {
    let blockedAt = null;
    for (let i = 1; i <= 12; i += 1) {
      const res = await server.post('/api/auth/login',
        { email: 'cf' + i + '@example.test', password: 'wrong' },
        // Client-controlled prefix, then the REAL customer address, then the edge.
        { 'X-Forwarded-For': '10.9.9.' + i + ', 203.0.113.50, 172.70.1.1' });
      if (res.status === 429) { blockedAt = i; break; }
    }
    assert.strictEqual(blockedAt, 6, 'the two spoofed positions did not create new identities');
    assert.match(server.output(), /\[proxy\] client IP trust: hops \(TRUST_PROXY_HOPS: 2\)/);
  } finally {
    await server.close();
  }
});

test('TRUST_PROXY takes precedence over TRUST_PROXY_HOPS', () => {
  const resolved = ClientIp.resolveProxyTrust({ TRUST_PROXY: 'loopback', TRUST_PROXY_HOPS: '3' });
  assert.strictEqual(resolved.mode, 'list');
  assert.strictEqual(resolved.source, 'TRUST_PROXY');
});

// ---------------------------------------------------------------------------
// 2. Address normalisation and identity selection
// ---------------------------------------------------------------------------

test('addresses are normalised for use as keys and in audit records', () => {
  assert.strictEqual(ClientIp.normalizeIp('::ffff:203.0.113.7'), '203.0.113.7');
  assert.strictEqual(ClientIp.normalizeIp('203.0.113.7:443'), '203.0.113.7');
  assert.strictEqual(ClientIp.normalizeIp('[2001:DB8::1]:443'), '2001:db8::1');
  assert.strictEqual(ClientIp.normalizeIp('  2001:DB8::1  '), '2001:db8::1');
  assert.strictEqual(ClientIp.normalizeIp(''), '');
  assert.strictEqual(ClientIp.normalizeIp(null), '');
});

test('the identity comes from req.ip and never from the forwarded header', () => {
  // A request whose header claims one address and whose socket says another.
  const req = {
    ip: '198.51.100.9',
    headers: { 'x-forwarded-for': '203.0.113.77' },
    socket: { remoteAddress: '198.51.100.9' }
  };
  assert.strictEqual(ClientIp.getClientIp(req), '198.51.100.9');

  // Only the header is present: it is still ignored.
  const headerOnly = { headers: { 'x-forwarded-for': '203.0.113.77' }, socket: { remoteAddress: '192.0.2.5' } };
  assert.strictEqual(ClientIp.getClientIp(headerOnly), '192.0.2.5');

  assert.strictEqual(ClientIp.getClientIp(null), 'unknown');
  assert.strictEqual(ClientIp.getClientIp({}), 'unknown');
});

test('no code reads X-Forwarded-For for identity any more', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const clientIp = fs.readFileSync(path.join(ROOT, 'services', 'ClientIp.js'), 'utf8');

  assert.strictEqual(server.indexOf("headers['x-forwarded-for']"), -1,
    'server.js must not read the raw header');
  assert.strictEqual(clientIp.indexOf('x-forwarded-for'), -1,
    'the IP module must not read the raw header either');
  assert.ok(server.indexOf('ClientIp.getClientIp(req)') !== -1, 'the server delegates to the module');
});

test('trust proxy is configured before any route is registered', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const setIndex = server.indexOf("app.set('trust proxy'");
  assert.ok(setIndex !== -1, 'app.set(\'trust proxy\') is present');
  const firstRoute = server.indexOf("app.get('/api/health'");
  assert.ok(firstRoute !== -1);
  assert.ok(setIndex < firstRoute, 'the setting must exist before requests can arrive');
});

// ---------------------------------------------------------------------------
// 3. Real HTTP: the default configuration ignores a spoofed header
// ---------------------------------------------------------------------------

test('with no proxy configured, rotating X-Forwarded-For does not reset the IP limit', async () => {
  const server = await startServer({
    AUTH_RATE_LIMIT_LOGIN_IP_MAX: '5',
    AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX: '1000',
    AUTH_RATE_LIMIT_LOGIN_COOLDOWN_MAX_SEC: '120'
  });
  try {
    let blockedAt = null;
    for (let i = 1; i <= 12; i += 1) {
      // A different account AND a different claimed address on every attempt: only
      // the socket address can produce a shared bucket.
      const res = await server.post('/api/auth/login',
        { email: 'probe' + i + '@example.test', password: 'wrong' },
        { 'X-Forwarded-For': '198.51.100.' + i });
      if (res.status === 429) { blockedAt = i; break; }
    }
    assert.strictEqual(blockedAt, 6, 'the 6th attempt is throttled (limit 5) despite the header');
    assert.match(server.output(), /\[proxy\] client IP trust: none/);
  } finally {
    await server.close();
  }
});

test('with no proxy configured, the forgot-password limiter also ignores the header', async () => {
  const server = await startServer({ RATE_LIMIT_IP_MAX: '3' });
  try {
    let blockedAt = null;
    for (let i = 1; i <= 8; i += 1) {
      const res = await server.post('/api/auth/forgot-password',
        { email: 'missing' + i + '@example.test' },
        { 'X-Forwarded-For': '203.0.113.' + i });
      if (res.status === 429) { blockedAt = i; break; }
      assert.strictEqual(res.status, 200, 'unknown addresses are answered generically');
    }
    assert.strictEqual(blockedAt, 4, 'the 4th request is throttled (limit 3) despite the header');
  } finally {
    await server.close();
  }
});

test('with no proxy configured, registration is limited per real client', async () => {
  const server = await startServer({ AUTH_RATE_LIMIT_REGISTER_IP_MAX: '3' });
  try {
    let blockedAt = null;
    for (let i = 1; i <= 8; i += 1) {
      const res = await server.post('/api/auth/register',
        { name: 'Probe', email: 'reg' + i + '@example.test', password: 'Password123!' },
        { 'X-Forwarded-For': '192.0.2.' + i });
      if (res.status === 429) { blockedAt = i; break; }
    }
    assert.strictEqual(blockedAt, 4, 'the 4th registration is throttled (limit 3) despite the header');
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Real HTTP: a declared proxy uses the address the proxy appended
// ---------------------------------------------------------------------------

test('with one trusted proxy, a client-prepended address is ignored', async () => {
  const server = await startServer({
    TRUST_PROXY_HOPS: '1',
    AUTH_RATE_LIMIT_LOGIN_IP_MAX: '5',
    AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX: '1000'
  });
  try {
    let blockedAt = null;
    for (let i = 1; i <= 12; i += 1) {
      // The proxy APPENDS the real address; the client controls only the prefix.
      const res = await server.post('/api/auth/login',
        { email: 'trusted' + i + '@example.test', password: 'wrong' },
        { 'X-Forwarded-For': '10.0.0.' + i + ', 203.0.113.7' });
      if (res.status === 429) { blockedAt = i; break; }
    }
    assert.strictEqual(blockedAt, 6, 'all attempts share the address the proxy supplied');
    assert.match(server.output(), /\[proxy\] client IP trust: hops \(TRUST_PROXY_HOPS: 1\)/);
  } finally {
    await server.close();
  }
});

test('a hop count larger than the real chain is a documented caveat, not a safe default', async () => {
  // Documents WHY the default is "trust nothing" and why a hop count must match
  // the real topology: with one trusted hop, the RIGHTMOST entry is the client.
  // A caller who can reach the process directly (no proxy in front) can therefore
  // set that entry itself. This is exactly the configuration mistake the docs warn
  // about; with the default (no trust) the same requests share one bucket.
  const server = await startServer({
    TRUST_PROXY_HOPS: '1',
    AUTH_RATE_LIMIT_LOGIN_IP_MAX: '5',
    AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX: '1000'
  });
  try {
    let blocked = 0;
    for (let i = 1; i <= 10; i += 1) {
      const res = await server.post('/api/auth/login',
        { email: 'direct' + i + '@example.test', password: 'wrong' },
        { 'X-Forwarded-For': '203.0.113.7, 10.0.0.' + i });
      if (res.status === 429) blocked += 1;
    }
    assert.strictEqual(blocked, 0, 'a misconfigured hop count lets a direct caller rotate identity');
  } finally {
    await server.close();
  }
});
