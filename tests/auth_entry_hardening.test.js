'use strict';

/**
 * Authentication entry-point hardening - unit and source contract tests.
 *
 * Covers the three authorised findings:
 *   1. no default administrator / no published password;
 *   2. the legacy login route cannot bypass the second factor;
 *   3. login and registration are rate limited.
 *
 * The behavioural HTTP tests live in auth_entry_http.test.js; this file exercises
 * the pure decisions directly and pins the wiring in server.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AuthEntry = require(path.join(ROOT, 'services', 'AuthEntry.js'));

const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const ENV_EXAMPLE = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const RUNBOOK = fs.readFileSync(path.join(ROOT, 'docs', 'security', 'ADMIN_PROVISIONING.md'), 'utf8');

function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.notStrictEqual(start, -1, 'missing marker: ' + startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notStrictEqual(end, -1, 'missing end marker: ' + endMarker);
  return text.slice(start, end);
}

// ---------------------------------------------------------------------------
// 1. Administrator provisioning
// ---------------------------------------------------------------------------

test('no hard-coded default administrator password remains in application code', () => {
  assert.strictEqual(SERVER.indexOf('admin123'), -1, 'the published default password must be gone');
  assert.strictEqual(SERVER.indexOf('seedAdmin'), -1, 'the unconditional seeder must be gone');
  assert.strictEqual(SERVER.indexOf('Admin created:'), -1, 'the credential-printing log line must be gone');
  assert.strictEqual(SERVER.indexOf('admin@arbitrix.ai'), -1, 'no default admin identity in code');
  // The replacement is wired, not merely present as a module.
  assert.ok(SERVER.includes('AuthEntry.provisionAdmin({'));
  assert.ok(SERVER.includes('initAdminProvisioning'));
});

test('provisioning is disabled unless BOTH values are configured', () => {
  assert.deepStrictEqual(AuthEntry.resolveAdminProvisioning({}), { status: 'disabled' });
  assert.strictEqual(AuthEntry.resolveAdminProvisioning({ ADMIN_PROVISION_EMAIL: 'ops@example.test' }).status, 'incomplete');
  assert.strictEqual(AuthEntry.resolveAdminProvisioning({ ADMIN_PROVISION_PASSWORD: 'CorrectHorseBattery9!' }).status, 'incomplete');
  assert.strictEqual(AuthEntry.resolveAdminProvisioning({ ADMIN_PROVISION_EMAIL: '  ', ADMIN_PROVISION_PASSWORD: 'CorrectHorseBattery9!' }).status, 'incomplete');
});

test('provisioning rejects an invalid email and a weak password', () => {
  assert.strictEqual(AuthEntry.resolveAdminProvisioning({
    ADMIN_PROVISION_EMAIL: 'not-an-email',
    ADMIN_PROVISION_PASSWORD: 'CorrectHorseBattery9!'
  }).status, 'invalid-email');

  const weak = AuthEntry.resolveAdminProvisioning({
    ADMIN_PROVISION_EMAIL: 'ops@example.test',
    ADMIN_PROVISION_PASSWORD: 'admin123'
  });
  assert.strictEqual(weak.status, 'weak-password');
  assert.strictEqual(weak.reason, 'too-short');
});

test('password validation enforces length, classes, the email name and bcrypt limit', () => {
  assert.strictEqual(AuthEntry.validateAdminPassword('short1!A', 'ops@example.test').ok, false);
  assert.strictEqual(AuthEntry.validateAdminPassword('alllowercaseletters', 'ops@example.test').reason, 'too-simple');
  assert.strictEqual(AuthEntry.validateAdminPassword('OpsAdmin-Long-9!', 'opsadmin@example.test').reason, 'contains-email');
  assert.strictEqual(AuthEntry.validateAdminPassword('A1!' + 'x'.repeat(80), 'ops@example.test').reason, 'too-long');
  assert.strictEqual(AuthEntry.validateAdminPassword('admin123', 'ops@example.test').reason, 'too-short');
  assert.strictEqual(AuthEntry.validateAdminPassword('123456789012', 'ops@example.test').reason, 'too-common');
  assert.strictEqual(AuthEntry.validateAdminPassword('CorrectHorseBattery9!', 'ops@example.test').ok, true);
});

test('a ready configuration normalises the email and never changes it', () => {
  const cfg = AuthEntry.resolveAdminProvisioning({
    ADMIN_PROVISION_EMAIL: '  Ops@Example.Test ',
    ADMIN_PROVISION_PASSWORD: 'CorrectHorseBattery9!'
  });
  assert.strictEqual(cfg.status, 'ready');
  assert.strictEqual(cfg.email, 'ops@example.test');
});

function makeAdminClient(options) {
  const opts = options || {};
  const calls = { users: [], wallets: [] };
  return {
    calls: calls,
    from: function (table) {
      if (table === 'users') {
        return {
          select: function () {
            return {
              eq: function (field, value) {
                calls.users.push({ op: 'select', field: field, value: value });
                return {
                  maybeSingle: async function () { return { data: opts.existing || null, error: opts.lookupError || null }; },
                  single: async function () { return { data: opts.existing || null, error: opts.lookupError || null }; }
                };
              }
            };
          },
          insert: function (row) {
            calls.users.push({ op: 'insert', row: row });
            const chain = {
              select: function () { return chain; },
              single: async function () {
                return { data: opts.insertError ? null : { id: 77 }, error: opts.insertError || null };
              }
            };
            return chain;
          }
        };
      }
      if (table === 'wallets') {
        return {
          insert: async function (row) {
            calls.wallets.push({ op: 'insert', row: row });
            return { error: opts.walletError || null };
          }
        };
      }
      throw new Error('unexpected table ' + table);
    }
  };
}

const STRONG = 'CorrectHorseBattery9!';
const READY_ENV = { ADMIN_PROVISION_EMAIL: 'ops@example.test', ADMIN_PROVISION_PASSWORD: STRONG };

test('no configuration performs no database work at all', async () => {
  const admin = makeAdminClient({});
  const result = await AuthEntry.provisionAdmin({
    admin: admin,
    env: {},
    hashPassword: function () { throw new Error('must not hash'); },
    generateReferralCode: async function () { throw new Error('must not generate'); }
  });
  assert.strictEqual(result.status, 'disabled');
  assert.strictEqual(admin.calls.users.length, 0);
  assert.strictEqual(admin.calls.wallets.length, 0);
});

test('an existing account is left completely untouched (no reset, no role change)', async () => {
  const admin = makeAdminClient({ existing: { id: 5 } });
  const result = await AuthEntry.provisionAdmin({
    admin: admin,
    env: READY_ENV,
    hashPassword: function () { throw new Error('must not rehash an existing account'); },
    generateReferralCode: async function () { throw new Error('must not touch an existing account'); }
  });
  assert.strictEqual(result.status, 'exists');
  const writes = admin.calls.users.filter(function (c) { return c.op === 'insert'; });
  assert.strictEqual(writes.length, 0, 'no insert/update for an existing account');
  assert.strictEqual(admin.calls.wallets.length, 0);
});

test('a new administrator is created with the configured password hash and a zeroed wallet', async () => {
  const admin = makeAdminClient({});
  let hashedInput = null;
  const result = await AuthEntry.provisionAdmin({
    admin: admin,
    env: READY_ENV,
    hashPassword: function (plain) { hashedInput = plain; return 'hashed::' + plain; },
    generateReferralCode: async function () { return 'REF-UNIQUE'; }
  });

  assert.strictEqual(result.status, 'created');
  assert.strictEqual(result.userId, 77);
  assert.strictEqual(result.walletCreated, true);
  assert.strictEqual(hashedInput, STRONG, 'the configured password is what gets hashed');

  const insert = admin.calls.users.find(function (c) { return c.op === 'insert'; });
  assert.ok(insert, 'the account is inserted');
  assert.strictEqual(insert.row.email, 'ops@example.test');
  assert.strictEqual(insert.row.is_admin, 1);
  assert.strictEqual(insert.row.referral_code, 'REF-UNIQUE');
  assert.notStrictEqual(insert.row.password_hash, STRONG, 'never store the plain password');
  assert.ok(insert.row.password_hash.indexOf('hashed::') === 0);

  assert.strictEqual(admin.calls.wallets.length, 1, 'the wallet is created explicitly');
  const wallet = admin.calls.wallets[0].row;
  assert.deepStrictEqual(wallet, { user_id: 77, demo_balance: 0, live_balance: 0, bonus_balance: 0 });
});

test('a lookup failure or an insert failure creates nothing and throws nowhere', async () => {
  const lookupFail = makeAdminClient({ lookupError: { code: 'XX000' } });
  const lookupResult = await AuthEntry.provisionAdmin({
    admin: lookupFail,
    env: READY_ENV,
    hashPassword: function () { return 'h'; },
    generateReferralCode: async function () { return 'R'; }
  });
  assert.deepStrictEqual(lookupResult, { status: 'error', reason: 'lookup-failed' });
  assert.strictEqual(lookupFail.calls.wallets.length, 0);

  const insertFail = makeAdminClient({ insertError: { code: '23505' } });
  const insertResult = await AuthEntry.provisionAdmin({
    admin: insertFail,
    env: READY_ENV,
    hashPassword: function () { return 'h'; },
    generateReferralCode: async function () { return 'R'; }
  });
  assert.deepStrictEqual(insertResult, { status: 'error', reason: 'insert-failed' });
  assert.strictEqual(insertFail.calls.wallets.length, 0, 'no wallet for an account that was not created');
});

test('a wallet failure is reported without failing the account creation', async () => {
  const admin = makeAdminClient({ walletError: { code: 'XX000' } });
  const result = await AuthEntry.provisionAdmin({
    admin: admin,
    env: READY_ENV,
    hashPassword: function () { return 'h'; },
    generateReferralCode: async function () { return 'R'; }
  });
  assert.strictEqual(result.status, 'created');
  assert.strictEqual(result.walletCreated, false);
});

test('provisioning never writes to the console (no credential logging)', async () => {
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  let calls = 0;
  console.log = console.warn = console.error = console.info = function () { calls += 1; };
  try {
    await AuthEntry.provisionAdmin({
      admin: makeAdminClient({}),
      env: READY_ENV,
      hashPassword: function () { return 'h'; },
      generateReferralCode: async function () { return 'R'; }
    });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    console.info = original.info;
  }
  assert.strictEqual(calls, 0);
});

test('the operator runbook exists, is read-only in wording, and names the legacy account', () => {
  assert.ok(RUNBOOK.includes('admin@arbitrix.ai'), 'the legacy identity is documented for verification');
  assert.ok(/Procedure A/i.test(RUNBOOK));
  assert.ok(/Procedure B/i.test(RUNBOOK));
  assert.ok(/do not delete|Do not delete/i.test(RUNBOOK));
  assert.ok(/not executed|Nothing here has been run/i.test(RUNBOOK));
});

test('the environment example documents the new variables without setting a password', () => {
  assert.ok(ENV_EXAMPLE.includes('# ADMIN_PROVISION_EMAIL='));
  assert.ok(ENV_EXAMPLE.includes('# ADMIN_PROVISION_PASSWORD='));
  assert.ok(ENV_EXAMPLE.includes('AUTH_RATE_LIMIT_LOGIN_IP_MAX'));
  assert.ok(ENV_EXAMPLE.includes('AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX'));
  assert.ok(ENV_EXAMPLE.includes('AUTH_RATE_LIMIT_REGISTER_IP_MAX'));
  const activePassword = ENV_EXAMPLE.split('\n').find(function (line) {
    return /^ADMIN_PROVISION_PASSWORD=/.test(line.trim());
  });
  assert.strictEqual(activePassword, undefined, 'no active password value may be shipped');
});

// ---------------------------------------------------------------------------
// 2. 2FA bypass
// ---------------------------------------------------------------------------

test('the legacy login route delegates to the shared 2FA-aware handler', () => {
  const route = sliceBetween(SERVER, "app.post('/api/auth/login'", '// Logout');
  assert.ok(route.includes('loginInitiateHandler(req, res)'));
  assert.strictEqual(route.indexOf('signSessionToken'), -1, 'the alias must never mint a session itself');
  assert.strictEqual(route.indexOf('res.json({ token'), -1);
  assert.strictEqual(route.indexOf('getUserByEmail'), -1);
  assert.ok(SERVER.includes("app.post('/api/2fa/login-initiate', loginInitiateHandler);"));
});

test('the shared handler only issues a full token when no second factor is outstanding', () => {
  const handler = sliceBetween(SERVER, 'async function loginInitiateHandler', 'app.post(\'/api/2fa/login-initiate\', loginInitiateHandler);');

  // Both challenge branches exist and return a partial token.
  assert.ok(handler.includes('requires2FA: true'));
  assert.ok(handler.includes('partialToken'));
  assert.ok(handler.includes("_2fa_pending: true"));
  assert.ok(handler.includes("twoFactorType === 'totp' && hasTOTP"));
  assert.ok(handler.includes("twoFactorType === 'email'"));

  // A full session token is minted only twice: the sandbox shortcut and the
  // explicit "No 2FA required" fall-through. Never before the 2FA decision.
  const mintIndex = handler.lastIndexOf('const token = signSessionToken');
  const decisionIndex = handler.indexOf('const twoFactorType = await get2FAType()');
  assert.ok(mintIndex > decisionIndex, 'the no-2FA mint happens after the 2FA decision');
  const sandboxMint = handler.indexOf('signSessionToken', 0);
  assert.ok(sandboxMint !== -1);
  const allMints = handler.split('signSessionToken').length - 1;
  assert.strictEqual(allMints, 2, 'exactly the sandbox shortcut and the no-2FA path mint a session');
});

test('the 2FA decision consults the server-side flag and the user profile', () => {
  const handler = sliceBetween(SERVER, 'async function loginInitiateHandler', 'app.post(\'/api/2fa/login-initiate\', loginInitiateHandler);');
  assert.ok(handler.includes('await get2FAType()'));
  assert.ok(handler.includes('await hasUser2FAEnabled(user.id)'));
  assert.ok(handler.includes('await bcrypt.compare(password, user.password_hash)'));
});

// ---------------------------------------------------------------------------
// 3. Rate limiting
// ---------------------------------------------------------------------------

test('login attempts are limited per IP', () => {
  const limiter = AuthEntry.createAuthRateLimiter({
    loginIpMax: 2, loginIpWindowMs: 1000,
    loginAccountMax: 100, loginAccountWindowMs: 1000
  });

  assert.strictEqual(limiter.checkLogin('1.1.1.1', 'a@example.test').allowed, true);
  assert.strictEqual(limiter.checkLogin('1.1.1.1', 'b@example.test').allowed, true);
  const blocked = limiter.checkLogin('1.1.1.1', 'c@example.test');
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.retryAfter >= 1);
  // A different IP is unaffected.
  assert.strictEqual(limiter.checkLogin('2.2.2.2', 'c@example.test').allowed, true);
});

test('failed logins are limited per account and cleared on success', () => {
  const limiter = AuthEntry.createAuthRateLimiter({
    loginIpMax: 1000, loginIpWindowMs: 60000,
    loginAccountMax: 3, loginAccountWindowMs: 60000
  });

  assert.strictEqual(limiter.checkLogin('1.1.1.1', 'user@example.test').allowed, true);
  limiter.recordLoginFailure('user@example.test');
  limiter.recordLoginFailure('user@example.test');
  assert.strictEqual(limiter.checkLogin('1.1.1.1', 'user@example.test').allowed, true, 'under the limit');

  limiter.recordLoginFailure('user@example.test');
  const blocked = limiter.checkLogin('9.9.9.9', 'user@example.test');
  assert.strictEqual(blocked.allowed, false, 'the account bucket applies across IPs');

  limiter.clearLoginFailures('user@example.test');
  assert.strictEqual(limiter.checkLogin('9.9.9.9', 'user@example.test').allowed, true, 'a successful login resets it');
});

test('a fixed window expires instead of blocking forever', () => {
  let now = 1000;
  const limiter = AuthEntry.createAuthRateLimiter({
    loginIpMax: 1, loginIpWindowMs: 5000,
    loginAccountMax: 100, loginAccountWindowMs: 5000,
    now: function () { return now; }
  });

  assert.strictEqual(limiter.checkLogin('1.1.1.1', 'a@example.test').allowed, true);
  assert.strictEqual(limiter.checkLogin('1.1.1.1', 'a@example.test').allowed, false);
  now += 5001;
  assert.strictEqual(limiter.checkLogin('1.1.1.1', 'a@example.test').allowed, true);
});

test('registration is limited independently from login', () => {
  const limiter = AuthEntry.createAuthRateLimiter({
    loginIpMax: 100, loginIpWindowMs: 60000,
    loginAccountMax: 100, loginAccountWindowMs: 60000,
    registerIpMax: 1, registerIpWindowMs: 60000
  });

  assert.strictEqual(limiter.checkRegister('3.3.3.3').allowed, true);
  assert.strictEqual(limiter.checkRegister('3.3.3.3').allowed, false);
  // The login budget for the same IP is untouched.
  assert.strictEqual(limiter.checkLogin('3.3.3.3', 'x@example.test').allowed, true);
  // Another IP may still register.
  assert.strictEqual(limiter.checkRegister('4.4.4.4').allowed, true);
});

test('a configured maximum of zero disables that bucket only', () => {
  const limiter = AuthEntry.createAuthRateLimiter({
    loginIpMax: 0, loginIpWindowMs: 1000,
    loginAccountMax: 0, loginAccountWindowMs: 1000,
    registerIpMax: 1, registerIpWindowMs: 1000
  });
  for (let i = 0; i < 50; i += 1) {
    assert.strictEqual(limiter.checkLogin('1.1.1.1', 'a@example.test').allowed, true);
  }
  assert.strictEqual(limiter.checkRegister('1.1.1.1').allowed, true);
  assert.strictEqual(limiter.checkRegister('1.1.1.1').allowed, false);
});

test('configuration is read from the environment with safe defaults', () => {
  const defaults = AuthEntry.resolveAuthRateLimits({});
  assert.strictEqual(defaults.loginIpMax, 60);
  assert.strictEqual(defaults.loginAccountMax, 10);
  assert.strictEqual(defaults.registerIpMax, 20);
  assert.strictEqual(defaults.loginIpWindowMs, 15 * 60 * 1000);
  assert.strictEqual(defaults.registerIpWindowMs, 60 * 60 * 1000);

  const custom = AuthEntry.resolveAuthRateLimits({
    AUTH_RATE_LIMIT_LOGIN_IP_MAX: '7',
    AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX: 'abc',
    AUTH_RATE_LIMIT_REGISTER_IP_WINDOW_MIN: '5'
  });
  assert.strictEqual(custom.loginIpMax, 7);
  assert.strictEqual(custom.loginAccountMax, 10, 'invalid input falls back to the default');
  assert.strictEqual(custom.registerIpWindowMs, 5 * 60 * 1000);
});

test('the server wires the limiter into both entry points', () => {
  const register = sliceBetween(SERVER, "app.post('/api/auth/register'", "app.post('/api/auth/login'");
  assert.ok(register.includes('authRateLimiter.checkRegister(getClientIp(req))'));
  assert.ok(register.indexOf('checkRegister') < register.indexOf('getUserByEmail'), 'limited before the lookup');

  const handler = sliceBetween(SERVER, 'async function loginInitiateHandler', 'app.post(\'/api/2fa/login-initiate\', loginInitiateHandler);');
  assert.ok(handler.includes('authRateLimiter.checkLogin(getClientIp(req), accountKey)'));
  assert.ok(handler.includes("authRateLimiter.recordLoginFailure(accountKey)"));
  assert.ok(handler.includes("authRateLimiter.clearLoginFailures(accountKey)"));
  // The 429 carries a predictable body and a Retry-After header.
  assert.ok(SERVER.includes("res.set('Retry-After', String(seconds))"));
  assert.ok(SERVER.includes("res.status(429).json({ error: message, retryAfter: seconds })"));
});

test('throttling answers do not depend on whether the account exists', () => {
  const handler = sliceBetween(SERVER, 'async function loginInitiateHandler', 'app.post(\'/api/2fa/login-initiate\', loginInitiateHandler);');
  const limitBlock = sliceBetween(handler, 'const loginLimit = authRateLimiter.checkLogin', '// Verify credentials');
  const limiterIndex = limitBlock.indexOf('LOGIN_RATE_LIMIT_MESSAGE');
  assert.ok(limiterIndex !== -1);
  // The limiter runs before any user lookup, so the same answer is returned for
  // an unknown address and an existing one.
  assert.ok(handler.indexOf('checkLogin') < handler.indexOf(".from('users')"));
  // No user-existence hint in the throttle message itself.
  assert.ok(!/not found|no account|unknown user|email exists/i.test(SERVER.slice(SERVER.indexOf('LOGIN_RATE_LIMIT_MESSAGE'), SERVER.indexOf('LOGIN_RATE_LIMIT_MESSAGE') + 200)));
});
