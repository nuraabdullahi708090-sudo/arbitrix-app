'use strict';

/**
 * Rate-limiter policy and cost guarantees.
 *
 * Two properties are pinned here:
 *   1. An account under repeated attack is delayed progressively but NEVER
 *      locked out for good: the cooldown is bounded, failures age out of a
 *      rolling window, and a successful login clears the record.
 *   2. Cleanup cannot be turned into per-request CPU work: a full sweep of a
 *      bucket is amortised (at most once per interval, plus a batch eviction when
 *      capacity is exceeded), so key churn has a bounded cost and bounded memory.
 */

const test = require('node:test');
const assert = require('node:assert');

const AuthEntry = require('../services/AuthEntry');

function makeLimiter(options) {
  const clock = { now: 1000 };
  const limiter = AuthEntry.createAuthRateLimiter(Object.assign({
    now: function () { return clock.now; }
  }, options || {}));
  return { limiter: limiter, clock: clock };
}

// ---------------------------------------------------------------------------
// 1. Progressive, bounded cooldowns
// ---------------------------------------------------------------------------

test('failures below the limit apply no delay', () => {
  const h = makeLimiter({ loginAccountMax: 10, loginCooldownBaseMs: 15000, loginCooldownMaxMs: 120000 });
  for (let i = 0; i < 9; i += 1) {
    const result = h.limiter.recordLoginFailure('user@example.test');
    assert.strictEqual(result.allowed, true, 'failure ' + (i + 1) + ' is within the budget');
    assert.strictEqual(result.cooldownMs, 0);
  }
  assert.strictEqual(h.limiter.checkLogin('1.1.1.1', 'user@example.test').allowed, true);
});

test('the cooldown doubles per failure and stops at the configured cap', () => {
  const h = makeLimiter({ loginAccountMax: 10, loginCooldownBaseMs: 15000, loginCooldownMaxMs: 120000 });

  let tenth = null;
  for (let i = 1; i <= 10; i += 1) tenth = h.limiter.recordLoginFailure('user@example.test');
  assert.strictEqual(tenth.cooldownMs, 15000, 'the 10th failure starts the first cooldown');

  const expected = [30000, 60000, 120000, 120000, 120000];
  expected.forEach(function (cooldown, index) {
    const result = h.limiter.recordLoginFailure('user@example.test');
    assert.strictEqual(result.cooldownMs, cooldown,
      'failure ' + (11 + index) + ' cooldown');
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.retryAfter, Math.ceil(cooldown / 1000));
  });
});

test('the account is blocked only until the cooldown expires', () => {
  const h = makeLimiter({ loginAccountMax: 2, loginCooldownBaseMs: 15000, loginCooldownMaxMs: 120000 });

  h.limiter.recordLoginFailure('user@example.test');
  h.limiter.recordLoginFailure('user@example.test');

  const blocked = h.limiter.checkLogin('1.1.1.1', 'user@example.test');
  assert.strictEqual(blocked.allowed, false);
  assert.strictEqual(blocked.retryAfter, 15);

  h.clock.now += 15001;
  assert.strictEqual(h.limiter.checkLogin('1.1.1.1', 'user@example.test').allowed, true,
    'the delay is a cooldown, not a lockout');
});

test('a successful login clears the record even mid-cooldown', () => {
  const h = makeLimiter({ loginAccountMax: 2 });
  h.limiter.recordLoginFailure('user@example.test');
  h.limiter.recordLoginFailure('user@example.test');
  assert.strictEqual(h.limiter.checkLogin('1.1.1.1', 'user@example.test').allowed, false);

  h.limiter.clearLoginFailures('user@example.test');
  assert.strictEqual(h.limiter.checkLogin('1.1.1.1', 'user@example.test').allowed, true);
  const firstAfterReset = h.limiter.recordLoginFailure('user@example.test');
  assert.strictEqual(firstAfterReset.remaining, 1, 'the budget is fully restored (2 -> 1)');
  assert.strictEqual(firstAfterReset.cooldownMs, 0, 'and the first failure is free again');
});

test('failures age out of the rolling window, so nothing is permanent', () => {
  const h = makeLimiter({
    loginAccountMax: 2,
    loginAccountWindowMs: 60000,
    loginCooldownBaseMs: 15000,
    loginCooldownMaxMs: 120000
  });

  h.limiter.recordLoginFailure('user@example.test');
  h.limiter.recordLoginFailure('user@example.test');
  assert.strictEqual(h.limiter.checkLogin('1.1.1.1', 'user@example.test').allowed, false);

  // No new failures for longer than the window: both records are forgotten.
  h.clock.now += 60001;
  assert.strictEqual(h.limiter.checkLogin('1.1.1.1', 'user@example.test').allowed, true);

  const afterGap = h.limiter.recordLoginFailure('user@example.test');
  assert.strictEqual(afterGap.cooldownMs, 0, 'the first failure after the window is not punished');
  assert.strictEqual(afterGap.remaining, 1);
});

test('one account never affects another', () => {
  const h = makeLimiter({ loginAccountMax: 1 });
  h.limiter.recordLoginFailure('victim@example.test');
  assert.strictEqual(h.limiter.checkLogin('1.1.1.1', 'victim@example.test').allowed, false);
  assert.strictEqual(h.limiter.checkLogin('1.1.1.1', 'other@example.test').allowed, true);
});

test('the cooldown cap is configurable and parsed safely', () => {
  const defaults = AuthEntry.resolveAuthRateLimits({});
  assert.strictEqual(defaults.loginAccountMax, 10);
  assert.strictEqual(defaults.loginCooldownMaxMs, 120000);

  const custom = AuthEntry.resolveAuthRateLimits({ AUTH_RATE_LIMIT_LOGIN_COOLDOWN_MAX_SEC: '45' });
  assert.strictEqual(custom.loginCooldownMaxMs, 45000);

  const invalid = AuthEntry.resolveAuthRateLimits({ AUTH_RATE_LIMIT_LOGIN_COOLDOWN_MAX_SEC: 'abc' });
  assert.strictEqual(invalid.loginCooldownMaxMs, 120000, 'invalid input falls back to the default');
});

// ---------------------------------------------------------------------------
// 2. Cleanup cost and memory bounds
// ---------------------------------------------------------------------------

test('key churn runs a bounded number of sweeps, not one per request', () => {
  const h = makeLimiter({ maxEntries: 100, sweepIntervalMs: 1000, loginIpWindowMs: 60000 });
  const requests = 2000;

  for (let i = 0; i < requests; i += 1) {
    h.limiter.checkLogin('10.0.' + Math.floor(i / 250) + '.' + (i % 250), 'user' + i + '@example.test');
  }

  const stats = h.limiter.stats();
  assert.ok(stats.loginIp <= 100, 'memory stays bounded (size ' + stats.loginIp + ')');
  assert.ok(stats.sweeps < requests / 5, 'sweeps are amortised (sweeps ' + stats.sweeps + ')');
  assert.ok(stats.evictions > 0, 'eviction happened');
});

test('expired entries are cleaned up when the sweep interval elapses', () => {
  const h = makeLimiter({ loginIpWindowMs: 5000, sweepIntervalMs: 1000, maxEntries: 20000 });

  for (let i = 0; i < 50; i += 1) {
    h.limiter.checkLogin('198.51.100.' + i, 'a' + i + '@example.test');
  }
  assert.strictEqual(h.limiter.stats().loginIp, 50);

  h.clock.now += 1001;           // interval elapsed
  h.clock.now += 5000;           // records are now outside their window
  h.limiter.checkLogin('203.0.113.1', 'fresh@example.test');

  assert.strictEqual(h.limiter.stats().loginIp, 1, 'only the live entry remains');
});

test('expiry is judged per record even before a sweep runs', () => {
  const h = makeLimiter({ loginIpMax: 1, loginIpWindowMs: 5000, sweepIntervalMs: 600000 });

  assert.strictEqual(h.limiter.checkLogin('198.51.100.7', 'a@example.test').allowed, true);
  assert.strictEqual(h.limiter.checkLogin('198.51.100.7', 'a@example.test').allowed, false);

  h.clock.now += 5001; // no sweep is due, but the record is expired
  assert.strictEqual(h.limiter.checkLogin('198.51.100.7', 'a@example.test').allowed, true,
    'correctness never depends on the sweep');
});

test('the limiter still enforces its limit while churning other keys', () => {
  const h = makeLimiter({ loginIpMax: 2, loginIpWindowMs: 60000, maxEntries: 500 });

  assert.strictEqual(h.limiter.checkLogin('203.0.113.99', 'a@example.test').allowed, true);
  // Churn unrelated keys (as an attacker would to inflate the map).
  for (let i = 0; i < 400; i += 1) {
    h.limiter.checkLogin('10.1.0.' + (i % 250), 'noise' + i + '@example.test');
  }
  assert.strictEqual(h.limiter.checkLogin('203.0.113.99', 'a@example.test').allowed, true);
  assert.strictEqual(h.limiter.checkLogin('203.0.113.99', 'a@example.test').allowed, false,
    'the tracked key still hits its limit');
});

test('reset clears state and counters', () => {
  const h = makeLimiter({ loginIpMax: 1 });
  h.limiter.checkLogin('198.51.100.4', 'a@example.test');
  h.limiter.checkLogin('198.51.100.4', 'a@example.test');
  assert.strictEqual(h.limiter.checkLogin('198.51.100.4', 'a@example.test').allowed, false);

  h.limiter.reset();
  assert.strictEqual(h.limiter.checkLogin('198.51.100.4', 'a@example.test').allowed, true);
  assert.deepStrictEqual(h.limiter.stats(), {
    loginIp: 1, loginAccount: 0, registerIp: 0, sweeps: 0, evictions: 0
  });
});
