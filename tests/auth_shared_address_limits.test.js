'use strict';

/**
 * Shared-address (untrusted proxy) behaviour of the auth rate limits, plus the
 * missing-body validation on the authentication entry points.
 *
 * WHY THIS EXISTS
 *   When no proxy is trusted, `req.ip` is the edge proxy for EVERY visitor. A
 *   per-address budget then becomes a platform-wide budget:
 *
 *     - login:      60 attempts / 15 min for the whole platform
 *     - register:   20 signups  / hour     for the whole platform
 *     - forgot password: 5 requests / 15 min for the whole platform
 *
 *   Shipping that would have locked every customer out of the product after a
 *   busy hour. The shared-address budgets in AuthEntry.SHARED_IP_DEFAULTS exist
 *   so the default (safe) proxy setting cannot cause an outage, while the
 *   per-account limiter - which needs no address - keeps its full strength.
 *
 *   Both directions are asserted here: the shared budget must not throttle a
 *   normal burst, and a *configured* trusted proxy must restore per-address
 *   enforcement (so this change cannot hide a regression in the limiter).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const AuthEntry = require('../services/AuthEntry');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-auth.js');

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

async function bootServer(extraEnv) {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const scenarioFile = path.join(os.tmpdir(), 'shared-ip-' + process.pid + '-' + port + '.json');
  fs.writeFileSync(scenarioFile, JSON.stringify({}));

  const env = Object.assign({}, process.env, {
    NODE_ENV: 'test',
    PORT: String(port),
    JWT_SECRET: 'shared-address-test-secret',
    BASE_URL: base,
    SUPABASE_URL: 'http://127.0.0.1:1',
    SUPABASE_ANON_KEY: 'shared-address-anon',
    SUPABASE_SERVICE_KEY: 'shared-address-service',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_SUPPORT_CHAT_ID: '',
    TELEGRAM_ADMIN_IDS: '',
    PAYHIP_ENABLED: 'false',
    AUTH_SCENARIO_FILE: scenarioFile,
    NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD)
  }, extraEnv || {});

  // The parent environment may already carry proxy settings; a test that asserts
  // the "no proxy trusted" default must not inherit them.
  delete env.TRUST_PROXY;
  delete env.TRUST_PROXY_HOPS;
  Object.assign(env, extraEnv || {});

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', function (d) { output += d.toString(); });
  child.stderr.on('data', function (d) { output += d.toString(); });

  const deadline = Date.now() + 25000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('server exited early (' + child.exitCode + ')\n' + output);
    }
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) { healthy = true; break; }
    } catch (e) { /* not listening yet */ }
    await sleep(120);
  }
  if (!healthy) throw new Error('server did not become healthy\n' + output);

  return {
    base: base,
    output: function () { return output; },
    post: async function (route, body, headers) {
      const options = {
        method: 'POST',
        headers: Object.assign({}, body === undefined ? {} : { 'Content-Type': 'application/json' }, headers || {})
      };
      if (body !== undefined) options.body = JSON.stringify(body);
      const res = await fetch(base + route, options);
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { json = { _raw: text.slice(0, 200) }; }
      return { status: res.status, json: json, headers: res.headers };
    },
    stop: async function () {
      if (child.exitCode === null) {
        try { child.kill('SIGTERM'); } catch (e) { /* already gone */ }
        await Promise.race([once(child, 'exit'), sleep(4000)]);
      }
      try { fs.unlinkSync(scenarioFile); } catch (e) { /* best effort */ }
    }
  };
}

// ---------------------------------------------------------------------------
// Unit: the resolved configuration follows the attributability of the address
// ---------------------------------------------------------------------------

test('without a trusted proxy the per-IP buckets use the shared budgets', function () {
  const limits = AuthEntry.resolveAuthRateLimits({}, { ipAttributable: false });

  assert.strictEqual(limits.ipAttributable, false);
  assert.strictEqual(limits.loginIpMax, AuthEntry.SHARED_IP_DEFAULTS.loginIpMax);
  assert.strictEqual(limits.registerIpMax, AuthEntry.SHARED_IP_DEFAULTS.registerIpMax);
  // Sanity: the shared budgets are materially wider than the per-client ones,
  // otherwise the outage this guards against would still happen.
  assert.ok(limits.loginIpMax > AuthEntry.DEFAULT_RATE_LIMITS.loginIpMax);
  assert.ok(limits.registerIpMax > AuthEntry.DEFAULT_RATE_LIMITS.registerIpMax);
  // The account bucket does not depend on the address, so it never changes.
  assert.strictEqual(limits.loginAccountMax, AuthEntry.DEFAULT_RATE_LIMITS.loginAccountMax);
});

test('with a trusted proxy the per-client budgets apply', function () {
  const limits = AuthEntry.resolveAuthRateLimits({}, { ipAttributable: true });

  assert.strictEqual(limits.ipAttributable, true);
  assert.strictEqual(limits.loginIpMax, AuthEntry.DEFAULT_RATE_LIMITS.loginIpMax);
  assert.strictEqual(limits.registerIpMax, AuthEntry.DEFAULT_RATE_LIMITS.registerIpMax);
});

test('an explicit AUTH_RATE_LIMIT_* value always wins, shared mode included', function () {
  const limits = AuthEntry.resolveAuthRateLimits({
    AUTH_RATE_LIMIT_LOGIN_IP_MAX: '7',
    AUTH_RATE_LIMIT_REGISTER_IP_MAX: '3'
  }, { ipAttributable: false });

  assert.strictEqual(limits.loginIpMax, 7);
  assert.strictEqual(limits.registerIpMax, 3);
});

test('the default (no options) stays per-client, so existing callers are unaffected', function () {
  const limits = AuthEntry.resolveAuthRateLimits({});
  assert.strictEqual(limits.ipAttributable, true);
  assert.strictEqual(limits.loginIpMax, AuthEntry.DEFAULT_RATE_LIMITS.loginIpMax);
});

// ---------------------------------------------------------------------------
// End to end: a burst of password resets from one apparent address
// ---------------------------------------------------------------------------

test('shared-address mode: a normal burst of password resets is not throttled', async function () {
  const server = await bootServer();
  try {
    // 10 distinct addresses, which the per-email bucket (3/hour) cannot mask.
    // With the per-client budget of 5/15min the 6th request would be a 429; the
    // shared budget must accept all of them.
    for (let i = 1; i <= 10; i += 1) {
      const res = await server.post('/api/auth/forgot-password', { email: 'burst' + i + '@example.test' });
      assert.strictEqual(res.status, 200, 'request ' + i + ' should be accepted, got ' + res.status);
      assert.strictEqual(res.json.success, true);
    }
  } finally {
    await server.stop();
  }
});

test('shared-address mode is announced at startup (operator can see it)', async function () {
  const server = await bootServer();
  try {
    const log = server.output();
    assert.ok(
      log.indexOf('SHARED-ADDRESS mode') !== -1,
      'expected the shared-address warning, saw:\n' + log.slice(0, 2000)
    );
    assert.ok(log.indexOf('[proxy] client IP trust: none') !== -1);
  } finally {
    await server.stop();
  }
});

test('a trusted proxy restores per-address enforcement', async function () {
  // One trusted hop + the per-client password-reset budget of 5 per 15 minutes.
  const server = await bootServer({ TRUST_PROXY_HOPS: '1', RATE_LIMIT_IP_MAX: '5' });
  try {
    const statuses = [];
    for (let i = 1; i <= 6; i += 1) {
      const res = await server.post('/api/auth/forgot-password', { email: 'trusted' + i + '@example.test' });
      statuses.push(res.status);
    }

    assert.deepStrictEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.strictEqual(statuses[5], 429, 'the sixth request must be throttled, got ' + statuses[5]);

    // The trusted boot must not advertise the shared-address fallback.
    assert.strictEqual(server.output().indexOf('SHARED-ADDRESS mode'), -1);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Missing request bodies are a client error, never a 500 with internals
// ---------------------------------------------------------------------------

test('authentication entry points answer 400 (not 500) when no body is sent', async function () {
  const server = await bootServer();
  try {
    const cases = [
      ['/api/auth/register', 'All fields required'],
      ['/api/auth/login', 'Email and password required'],
      ['/api/auth/forgot-password', 'Valid email address is required'],
      ['/api/auth/reset-password', 'Email, token, and new password are required'],
      ['/api/2fa/login-verify', 'Missing partial token']
    ];

    for (const [route, expected] of cases) {
      const res = await server.post(route, undefined);
      assert.strictEqual(res.status, 400, route + ' should answer 400, got ' + res.status + ' ' + JSON.stringify(res.json));
      assert.strictEqual(res.json.error, expected);
      assert.strictEqual(res.json.stack, undefined, route + ' must not expose a stack');
      assert.ok(
        String(res.json.error).indexOf('Cannot destructure') === -1,
        route + ' must not expose an internal TypeError message'
      );
    }
  } finally {
    await server.stop();
  }
});

test('a JSON body of the wrong shape is still a client error', async function () {
  const server = await bootServer();
  try {
    // A JSON array is parsed successfully by express.json but has no fields.
    const res = await server.post('/api/auth/register', ['not', 'an', 'object']);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error, 'All fields required');
  } finally {
    await server.stop();
  }
});
