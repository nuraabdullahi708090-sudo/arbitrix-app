'use strict';

/**
 * A rate-limit bucket configured to 0 is UNLIMITED. That is a legitimate
 * emergency lever (and what the local rehearsal env file uses) so it must never
 * fail the boot - but shipping it to production removes brute-force protection
 * without any visible symptom. `findDisabledLimits` is the pure classifier the
 * server logs from, and this suite pins both the classification and the fact
 * that the warning cannot become a startup failure.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AuthEntry = require('../services/AuthEntry');

const ROOT = path.resolve(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('no disabled limits in a default configuration', () => {
  const limits = AuthEntry.resolveAuthRateLimits({}, { ipAttributable: true });
  assert.deepStrictEqual(AuthEntry.findDisabledLimits({
    loginIpMax: limits.loginIpMax,
    loginAccountMax: limits.loginAccountMax,
    registerIpMax: limits.registerIpMax,
    forgotPasswordIpMax: 5
  }), []);
});

test('each disabled bucket is named individually', () => {
  const cases = [
    [{ loginIpMax: 0 }, 'AUTH_RATE_LIMIT_LOGIN_IP_MAX'],
    [{ loginAccountMax: 0 }, 'AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX'],
    [{ registerIpMax: 0 }, 'AUTH_RATE_LIMIT_REGISTER_IP_MAX'],
    [{ forgotPasswordIpMax: 0 }, 'RATE_LIMIT_IP_MAX'],
  ];
  for (const [input, expected] of cases) {
    assert.deepStrictEqual(AuthEntry.findDisabledLimits(input), [expected], JSON.stringify(input));
  }
});

test('several disabled buckets are all reported, in a stable order', () => {
  assert.deepStrictEqual(
    AuthEntry.findDisabledLimits({ loginIpMax: 0, loginAccountMax: 0, registerIpMax: 0, forgotPasswordIpMax: 0 }),
    ['AUTH_RATE_LIMIT_LOGIN_IP_MAX', 'AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX', 'AUTH_RATE_LIMIT_REGISTER_IP_MAX', 'RATE_LIMIT_IP_MAX']
  );
});

test('a positive, a missing or a malformed value is never reported as disabled', () => {
  assert.deepStrictEqual(AuthEntry.findDisabledLimits({ loginIpMax: 1 }), []);
  assert.deepStrictEqual(AuthEntry.findDisabledLimits({ loginIpMax: undefined }), []);
  assert.deepStrictEqual(AuthEntry.findDisabledLimits({ loginIpMax: null }), []);
  assert.deepStrictEqual(AuthEntry.findDisabledLimits({ loginIpMax: 'abc' }), []);
  assert.deepStrictEqual(AuthEntry.findDisabledLimits({}), []);
  assert.deepStrictEqual(AuthEntry.findDisabledLimits(null), []);
});

test('the rehearsal values resolve to 0 and are therefore reported', () => {
  const limits = AuthEntry.resolveAuthRateLimits(
    { AUTH_RATE_LIMIT_LOGIN_IP_MAX: '0', AUTH_RATE_LIMIT_REGISTER_IP_MAX: '0' },
    { ipAttributable: true }
  );
  assert.strictEqual(limits.loginIpMax, 0);
  assert.strictEqual(limits.registerIpMax, 0);
  assert.deepStrictEqual(
    AuthEntry.findDisabledLimits({ loginIpMax: limits.loginIpMax, registerIpMax: limits.registerIpMax }),
    ['AUTH_RATE_LIMIT_LOGIN_IP_MAX', 'AUTH_RATE_LIMIT_REGISTER_IP_MAX']
  );
});

test('the server warns in production and never exits because of it', () => {
  const at = SERVER.indexOf('const disabledLimits = AuthEntry.findDisabledLimits({');
  assert.ok(at > -1, 'the server classifies the resolved limits');
  const block = SERVER.slice(at, at + 900);
  assert.match(block, /process\.env\.NODE_ENV === 'production'/);
  assert.match(block, /console\.warn\('\[rate-limit\] DISABLED in production/);
  assert.ok(!/process\.exit/.test(block), 'a disabled limit must never stop the boot');
  // The list must come from the RESOLVED configuration, not the raw env, so an
  // unset or malformed value cannot be mistaken for "disabled".
  assert.match(block, /AUTH_RATE_LIMITS\.loginIpMax/);
  assert.match(block, /AUTH_RATE_LIMITS\.loginAccountMax/);
  assert.match(block, /AUTH_RATE_LIMITS\.registerIpMax/);
  assert.match(block, /RATE_LIMIT_CONFIG\.ip\.maxRequests/);
});

test('the warning names the variables an operator has to unset', () => {
  const names = AuthEntry.findDisabledLimits({ loginIpMax: 0, loginAccountMax: 0, registerIpMax: 0, forgotPasswordIpMax: 0 });
  for (const name of names) {
    assert.match(name, /^(AUTH_RATE_LIMIT_[A-Z_]+|RATE_LIMIT_IP_MAX)$/);
  }
});
