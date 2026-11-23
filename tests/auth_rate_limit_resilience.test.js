'use strict';

/**
 * Rate-limit resilience: flooding must not buy a bypass, and no bucket may grow
 * without bound.
 *
 * The account bucket is keyed on a caller-supplied address, so an attacker can
 * mint unlimited distinct keys. Before this change, eviction was pure
 * oldest-first: a flood could push a victim's live lockout out of the bucket and
 * continue guessing that password. The per-entry failure list also grew with
 * every attempt inside the window, and the password-reset limiter in server.js
 * had no ceiling at all between its 5-minute sweeps.
 *
 * Cases: flood vs. lockout, eviction ordering, bounded per-entry history,
 * bounded bucket size, legitimate traffic, window expiry, bypass attempts, and
 * the real-HTTP behaviour of case variants.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const bcrypt = require('bcryptjs');

const AuthEntry = require('../services/AuthEntry');

const ROOT = path.resolve(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-auth.js');

/* ---------------------------------------------------------------- harness */

function makeLimiter(overrides) {
  let now = 1_000_000;
  const limiter = AuthEntry.createAuthRateLimiter(Object.assign({
    loginIpMax: 1_000_000,
    loginAccountMax: 5,
    loginAccountWindowMs: 15 * 60 * 1000,
    registerIpMax: 1_000_000,
    maxEntries: 20,
    sweepIntervalMs: 60 * 1000,
    now: () => now,
  }, overrides || {}));
  return {
    limiter,
    advance(ms) { now += ms; },
    now: () => now,
  };
}

/* ---------------------------------------------------- flood vs. lockout */

test('a flood of distinct keys cannot evict a live account lockout', () => {
  const { limiter } = makeLimiter({ maxEntries: 20 });

  // The victim is locked out first (5 tolerated failures, then cooldown).
  for (let i = 0; i < 6; i++) limiter.recordLoginFailure('victim@example.test');
  assert.strictEqual(limiter.checkLogin('198.51.100.1', 'victim@example.test').allowed, false,
    'the victim is throttled before the flood');

  // The attacker mints far more distinct keys than the bucket can hold.
  for (let i = 0; i < 500; i++) limiter.recordLoginFailure('flood' + i + '@example.test');

  assert.ok(limiter.stats().loginAccount <= limiter.stats().maxEntries,
    'the bucket stayed within its ceiling');
  assert.strictEqual(limiter.checkLogin('198.51.100.1', 'victim@example.test').allowed, false,
    'the victim lockout survived the flood');
  assert.ok(limiter._accountState('victim@example.test').lockedUntil > 0);
});

test('eviction spends the budget on inert entries before protecting ones', () => {
  const { limiter } = makeLimiter({ maxEntries: 10, loginAccountMax: 3 });

  // Two protecting entries (locked), a few counting entries, then a flood.
  limiter.recordLoginFailure('locked-a@example.test');
  limiter.recordLoginFailure('locked-a@example.test');
  limiter.recordLoginFailure('locked-a@example.test');
  limiter.recordLoginFailure('locked-a@example.test');
  limiter.recordLoginFailure('counting@example.test');

  for (let i = 0; i < 40; i++) limiter.recordLoginFailure('junk' + i + '@example.test');

  assert.ok(limiter._accountState('locked-a@example.test'), 'the locked entry was kept');
  assert.ok(limiter._accountState('locked-a@example.test').lockedUntil > 0);
  assert.ok(!limiter._accountState('junk0@example.test'), 'the attacker’s oldest inert key was evicted');
  assert.ok(limiter.stats().evictions > 0, 'eviction actually happened');
});

/* ------------------------------------------------------- bounded memory */

test('one account cannot inflate its failure history without bound', () => {
  const { limiter } = makeLimiter({ loginAccountMax: 5, loginAccountWindowMs: 60 * 60 * 1000 });
  for (let i = 0; i < 300; i++) limiter.recordLoginFailure('hot@example.test');
  const state = limiter._accountState('hot@example.test');
  assert.ok(state.failures <= 5 + 4, 'history is capped, got ' + state.failures);
  // Capping the history cannot weaken the cooldown: it is already at its maximum.
  const check = limiter.checkLogin('198.51.100.2', 'hot@example.test');
  assert.strictEqual(check.allowed, false);
  assert.ok(check.retryAfter <= Math.ceil(limiter.config.loginCooldownMaxMs / 1000));
});

test('the buckets stay within their ceiling under a long flood', () => {
  const { limiter } = makeLimiter({ maxEntries: 25 });
  for (let i = 0; i < 2000; i++) {
    limiter.checkLogin('203.0.113.' + (i % 250) + ':p' + i, 'acct' + i + '@example.test');
    limiter.recordLoginFailure('acct' + i + '@example.test');
  }
  const stats = limiter.stats();
  assert.ok(stats.loginAccount <= stats.maxEntries, 'account bucket bounded: ' + stats.loginAccount);
  assert.ok(stats.loginIp <= stats.maxEntries, 'ip bucket bounded: ' + stats.loginIp);
  assert.ok(stats.sweeps > 0);
});

/* --------------------------------------------------- legitimate traffic */

test('a legitimate burst is not throttled, and success clears a cooldown', () => {
  const { limiter } = makeLimiter({ loginAccountMax: 5 });
  for (let i = 0; i < 4; i++) {
    assert.strictEqual(limiter.checkLogin('198.51.100.9', 'user@example.test').allowed, true);
    limiter.recordLoginFailure('user@example.test'); // 4 failures: still tolerated
  }
  assert.strictEqual(limiter.checkLogin('198.51.100.9', 'user@example.test').allowed, true,
    'under the threshold a customer can still sign in');
  limiter.clearLoginFailures('user@example.test');
  assert.strictEqual(limiter.checkLogin('198.51.100.9', 'user@example.test').allowed, true);
  assert.strictEqual(limiter._accountState('user@example.test'), null, 'state removed on success');
});

test('the cooldown expires on its own (no permanent lockout)', () => {
  const { limiter, advance } = makeLimiter({ loginAccountMax: 5 });
  for (let i = 0; i < 6; i++) limiter.recordLoginFailure('late@example.test');
  assert.strictEqual(limiter.checkLogin('198.51.100.3', 'late@example.test').allowed, false);
  advance(3 * 60 * 1000); // past the maximum cooldown
  assert.strictEqual(limiter.checkLogin('198.51.100.3', 'late@example.test').allowed, true);
});

test('the IP bucket still throttles a single source independently of the account bucket', () => {
  const { limiter } = makeLimiter({ loginIpMax: 3, loginAccountMax: 1000 });
  assert.strictEqual(limiter.checkLogin('198.51.100.4', 'a@example.test').allowed, true);
  assert.strictEqual(limiter.checkLogin('198.51.100.4', 'b@example.test').allowed, true);
  assert.strictEqual(limiter.checkLogin('198.51.100.4', 'c@example.test').allowed, true);
  const blocked = limiter.checkLogin('198.51.100.4', 'd@example.test');
  assert.strictEqual(blocked.allowed, false, 'account rotation does not bypass the IP budget');
  assert.strictEqual(limiter.checkLogin('198.51.100.5', 'd@example.test').allowed, true,
    'a different address is unaffected');
});

/* -------------------------------------------- password-reset store bounds */

function loadServerHelpers() {
  // The two bounds helpers are top-level functions in server.js; extract and run
  // them exactly as production does.
  function extract(name) {
    const re = new RegExp('function\\s+' + name + '\\s*\\(');
    const m = SERVER.match(re);
    assert.ok(m, name + ' not found in server.js');
    const start = m.index;
    const braceStart = SERVER.indexOf('{', SERVER.indexOf('(', start));
    let depth = 0;
    for (let i = braceStart; i < SERVER.length; i++) {
      if (SERVER[i] === '{') depth++;
      else if (SERVER[i] === '}') { depth--; if (depth === 0) return SERVER.slice(start, i + 1); }
    }
    throw new Error('unterminated ' + name);
  }
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext([extract('sweepExpiredRateLimits'), extract('evictToRateLimitCeiling')].join('\n'), ctx);
  return ctx;
}

test('the password-reset maps have a hard ceiling that evicts the oldest keys', () => {
  const ctx = loadServerHelpers();
  const map = new Map();
  for (let i = 0; i < 50; i++) map.set('k' + i, { count: 1, windowStart: 1000 });
  const removed = ctx.evictToRateLimitCeiling(map, 10);
  assert.ok(removed > 0);
  assert.ok(map.size <= 10, 'trimmed to the ceiling, got ' + map.size);
  assert.ok(!map.has('k0'), 'oldest keys go first');
  assert.ok(map.has('k49'), 'recent keys are kept');
});

test('the expiry sweep uses each bucket’s own window (never "delete everything")', () => {
  const ctx = loadServerHelpers();
  const now = 10_000_000;
  const map = new Map([
    ['fresh', { count: 1, windowStart: now - 1000 }],
    ['old', { count: 1, windowStart: now - 20 * 60 * 1000 }],
  ]);
  // 15-minute window: only the 20-minute-old entry is expired.
  ctx.sweepExpiredRateLimits(map, now, 15 * 60 * 1000);
  assert.ok(map.has('fresh'), 'a live window survives the sweep');
  assert.ok(!map.has('old'), 'an expired window is removed');

  // Regression pin for the mistake this test was written after: passing a 0ms
  // window would have wiped the whole map on every tick and silently disabled
  // the limiter.
  const all = new Map([['a', { count: 1, windowStart: now - 1 }]]);
  ctx.sweepExpiredRateLimits(all, now, 0);
  assert.strictEqual(all.size, 0);
  const source = SERVER.slice(SERVER.indexOf('setInterval(() => {'), SERVER.indexOf('}, 5 * 60 * 1000).unref();'));
  assert.ok(source.includes('RATE_LIMIT_CONFIG.ip.windowMs'), 'the timer uses the IP window');
  assert.ok(source.includes('RATE_LIMIT_CONFIG.email.windowMs'), 'the timer uses the email window');
  assert.ok(!/sweepExpiredRateLimits\([^)]*,\s*now,\s*0\)/.test(source), 'never a zero window');
});

test('the reset limiter applies its ceiling on insert and at sweep time', () => {
  assert.ok(SERVER.includes('const RATE_LIMIT_MAX_ENTRIES = 20000'));
  const fn = SERVER.slice(SERVER.indexOf('function checkForgotPasswordRateLimit'), SERVER.indexOf('// AUTH ENTRY-POINT RATE LIMITING'));
  assert.ok(fn.includes('evictToRateLimitCeiling(rateLimitStore.ip'), 'bounded on insert (ip)');
  assert.ok(fn.includes('evictToRateLimitCeiling(rateLimitStore.email'), 'bounded on insert (email)');
});

/* -------------------------------------------------- identity key handling */

test('the login bucket key is normalised, so case/whitespace cannot mint buckets', () => {
  const idx = SERVER.indexOf('const accountKey = AuthEntry.normalizeEmail(email);');
  assert.ok(idx > -1, 'the limiter key comes from normalizeEmail');
  assert.strictEqual(AuthEntry.normalizeEmail('  Victim@Example.TEST '), 'victim@example.test');
});

/* --------------------------------------------------------------- over HTTP */

const SCENARIO_FILE = path.join(os.tmpdir(), 'rate-limit-' + process.pid + '.json');

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

async function bootServer(env) {
  fs.writeFileSync(SCENARIO_FILE, JSON.stringify({
    twofaType: 'none',
    user: {
      id: 5150, name: 'Limit', email: 'limit@example.test',
      password_hash: bcrypt.hashSync('CorrectHorseBattery9!', 4),
      referral_code: 'ARBI-LIM001', is_admin: 0, environment: 'PRODUCTION',
    },
  }));
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'rate-limit-test-secret', BASE_URL: base,
      SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 'rl-anon', SUPABASE_SERVICE_KEY: 'rl-service',
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_SUPPORT_CHAT_ID: '', TELEGRAM_ADMIN_IDS: '',
      PAYHIP_ENABLED: 'false', AUTH_SCENARIO_FILE: SCENARIO_FILE,
      AUTH_RATE_LIMIT_LOGIN_IP_MAX: '1000',
      AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX: '5',
      AUTH_RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_MIN: '15',
      NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD),
    }, env || {}),
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

async function login(base, email, password) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('HTTP: case variants of one address share a single failure budget', async () => {
  const server = await bootServer({});
  try {
    const variants = ['limit@example.test', 'Limit@Example.test', 'LIMIT@example.test',
      '  limit@example.test ', 'lImIt@example.TEST', 'limit@EXAMPLE.TEST'];
    let throttledAt = null;
    for (let i = 0; i < variants.length; i++) {
      const res = await login(server.base, variants[i], 'wrong-password');
      if (res.status === 429) { throttledAt = i; break; }
    }
    assert.strictEqual(throttledAt, 5, 'the 6th attempt (5 tolerated) is throttled regardless of case');

    // The real password is still refused while the cooldown is active - the
    // limiter is a lockout, not a per-input counter.
    const still = await login(server.base, 'LIMIT@example.TEST', 'CorrectHorseBattery9!');
    assert.strictEqual(still.status, 429);
  } finally {
    if (server.child.exitCode === null) {
      try { server.child.kill('SIGTERM'); } catch (e) { /* gone */ }
      await Promise.race([once(server.child, 'exit'), sleep(4000)]);
    }
  }
});

test('HTTP: an unthrottled account still signs in normally', async () => {
  const server = await bootServer({});
  try {
    const ok = await login(server.base, 'limit@example.test', 'CorrectHorseBattery9!');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.token, 'a session token is issued');
  } finally {
    if (server.child.exitCode === null) {
      try { server.child.kill('SIGTERM'); } catch (e) { /* gone */ }
      await Promise.race([once(server.child, 'exit'), sleep(4000)]);
    }
  }
});
