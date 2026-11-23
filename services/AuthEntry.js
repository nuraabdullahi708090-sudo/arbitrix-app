'use strict';

/**
 * Authentication entry-point hardening.
 *
 * Two responsibilities, both deliberately dependency-free so they can be
 * exercised without a database, a port or a network:
 *
 *   1. ADMIN PROVISIONING. An administrator is created only when an operator
 *      supplies BOTH `ADMIN_PROVISION_EMAIL` and `ADMIN_PROVISION_PASSWORD`
 *      explicitly. There is no default account, no default password and no
 *      automatic wallet funding. An existing account is NEVER touched.
 *
 *   2. AUTH RATE LIMITING. Fixed-window counters for the login and registration
 *      entry points. Login is limited per client IP (every attempt) and per
 *      submitted account (failed attempts only, cleared on success), so a
 *      password-spray attempt is slowed without punishing a user who types
 *      their password correctly. Registration is limited per client IP.
 *
 * The server owns the side effects (database writes, HTTP responses); this
 * module owns the decisions so they can be unit-tested directly.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MIN_ADMIN_PASSWORD_LENGTH = 12;
// bcrypt only consumes the first 72 bytes; longer input would be silently
// truncated, so an administrator password above that is rejected outright.
const MAX_ADMIN_PASSWORD_BYTES = 72;

// Passwords seen in every credential-stuffing list. This is a floor, not a
// substitute for a real breach corpus.
const WEAK_ADMIN_PASSWORDS = new Set([
  'admin123',
  'admin1234',
  'administrator',
  'password',
  'password1',
  'password123',
  'passw0rd',
  'changeme',
  'changeme123',
  'letmein',
  'welcome',
  'welcome123',
  'qwerty123',
  '123456789012',
  'kalderix',
  'kalderix123'
]);

function normalizeEmail(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/**
 * Validate an explicitly configured administrator password.
 *
 * @param {string} password
 * @param {string} email - used to reject a password containing the account name
 * @returns {{ok: boolean, reason?: string}}
 */
function validateAdminPassword(password, email) {
  const value = String(password == null ? '' : password);

  if (value.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return { ok: false, reason: 'too-short' };
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_ADMIN_PASSWORD_BYTES) {
    return { ok: false, reason: 'too-long' };
  }
  if (WEAK_ADMIN_PASSWORDS.has(value.toLowerCase())) {
    return { ok: false, reason: 'too-common' };
  }
  if (/^(.)\1+$/.test(value)) {
    return { ok: false, reason: 'too-simple' };
  }

  const local = normalizeEmail(email).split('@')[0];
  if (local && local.length >= 4 && value.toLowerCase().indexOf(local) !== -1) {
    return { ok: false, reason: 'contains-email' };
  }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]
    .filter(function (re) { return re.test(value); })
    .length;
  if (classes < 3) {
    return { ok: false, reason: 'too-simple' };
  }

  return { ok: true };
}

/**
 * Decide whether automatic administrator provisioning is configured.
 *
 * Statuses:
 *   disabled       - nothing configured; normal startup does nothing
 *   incomplete     - exactly one of the two values is set
 *   invalid-email  - the configured email is not an address
 *   weak-password  - the configured password fails validation
 *   ready          - a strong, explicit configuration
 *
 * The returned object contains the password. NEVER log it.
 *
 * @param {object} env
 */
function resolveAdminProvisioning(env) {
  const source = env || {};
  const rawEmail = source.ADMIN_PROVISION_EMAIL;
  const rawPassword = source.ADMIN_PROVISION_PASSWORD;

  const emailSet = !!(rawEmail != null && String(rawEmail).trim());
  const passwordSet = !!(rawPassword != null && String(rawPassword).length > 0);

  if (!emailSet && !passwordSet) return { status: 'disabled' };
  if (!emailSet || !passwordSet) return { status: 'incomplete' };

  const email = normalizeEmail(rawEmail);
  if (!EMAIL_RE.test(email)) return { status: 'invalid-email' };

  const password = String(rawPassword);
  const strength = validateAdminPassword(password, email);
  if (!strength.ok) return { status: 'weak-password', reason: strength.reason };

  return { status: 'ready', email: email, password: password };
}

/**
 * Create the configured administrator when (and only when) it does not exist.
 *
 * Guarantees:
 *   - no write of any kind unless the configuration is complete and valid;
 *   - an existing account (by email) is left COMPLETELY untouched - no password
 *     reset, no role change, no wallet change;
 *   - the created account gets an explicitly zeroed wallet, so the generic
 *     promotional seed is not applied to an operator account;
 *   - nothing is logged here (the caller logs status only, never credentials).
 *
 * @param {object} opts
 * @param {object} opts.admin - Supabase client (service role)
 * @param {object} opts.env
 * @param {function} opts.hashPassword - (plain) => hash, injected by the caller
 * @param {function} opts.generateReferralCode - async () => unique code
 * @returns {Promise<{status: string, userId?: number, reason?: string, walletCreated?: boolean}>}
 */
async function provisionAdmin(opts) {
  const options = opts || {};
  const admin = options.admin;
  const cfg = resolveAdminProvisioning(options.env);

  if (cfg.status !== 'ready') return { status: cfg.status, reason: cfg.reason };

  if (!admin || typeof admin.from !== 'function') {
    return { status: 'error', reason: 'no-admin-client' };
  }
  if (typeof options.hashPassword !== 'function') {
    return { status: 'error', reason: 'no-password-hasher' };
  }
  if (typeof options.generateReferralCode !== 'function') {
    return { status: 'error', reason: 'no-referral-code-generator' };
  }

  let existing = null;
  try {
    const lookup = admin.from('users').select('id').eq('email', cfg.email);
    const query = typeof lookup.maybeSingle === 'function' ? lookup.maybeSingle() : lookup;
    const result = await query;
    if (result && result.error) return { status: 'error', reason: 'lookup-failed' };
    existing = result ? result.data : null;
  } catch (e) {
    return { status: 'error', reason: 'lookup-failed' };
  }

  // Never modify an existing account - not even to "fix" its password or role.
  if (existing) return { status: 'exists' };

  let referralCode;
  try {
    referralCode = await options.generateReferralCode();
  } catch (e) {
    return { status: 'error', reason: 'referral-code-failed' };
  }

  let created;
  try {
    const insert = await admin.from('users').insert({
      name: 'Administrator',
      email: cfg.email,
      password_hash: options.hashPassword(cfg.password),
      referral_code: referralCode,
      is_admin: 1
    }).select('id').single();

    if (!insert || insert.error || !insert.data) {
      return { status: 'error', reason: 'insert-failed' };
    }
    created = insert.data;
  } catch (e) {
    return { status: 'error', reason: 'insert-failed' };
  }

  // An operator account must not receive the new-user promotional balance, so
  // the wallet is created explicitly at zero before anything can lazily seed it.
  let walletCreated = false;
  try {
    const wallet = await admin.from('wallets').insert({
      user_id: created.id,
      demo_balance: 0,
      live_balance: 0,
      bonus_balance: 0
    });
    walletCreated = !(wallet && wallet.error);
  } catch (e) {
    walletCreated = false;
  }

  return { status: 'created', userId: created.id, walletCreated: walletCreated };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const DEFAULT_RATE_LIMITS = {
  // Every login attempt from one IP.
  loginIpMax: 60,
  loginIpWindowMs: 15 * 60 * 1000,
  // Failed logins against one submitted account (cleared on success).
  loginAccountMax: 10,
  loginAccountWindowMs: 15 * 60 * 1000,
  // New accounts from one IP.
  registerIpMax: 20,
  registerIpWindowMs: 60 * 60 * 1000,
  // Bound on stored keys per bucket, so a flood cannot grow memory without end.
  maxEntries: 20000
};

function parseCount(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseMinutes(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Read the auth rate-limit configuration, with safe defaults. A maximum of 0
 * disables that bucket (useful for controlled local rehearsal runs only).
 */
function resolveAuthRateLimits(env) {
  const source = env || {};
  return {
    loginIpMax: parseCount(source.AUTH_RATE_LIMIT_LOGIN_IP_MAX, DEFAULT_RATE_LIMITS.loginIpMax),
    loginIpWindowMs: parseMinutes(source.AUTH_RATE_LIMIT_LOGIN_IP_WINDOW_MIN, 15) * 60 * 1000,
    loginAccountMax: parseCount(source.AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX, DEFAULT_RATE_LIMITS.loginAccountMax),
    loginAccountWindowMs: parseMinutes(source.AUTH_RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_MIN, 15) * 60 * 1000,
    registerIpMax: parseCount(source.AUTH_RATE_LIMIT_REGISTER_IP_MAX, DEFAULT_RATE_LIMITS.registerIpMax),
    registerIpWindowMs: parseMinutes(source.AUTH_RATE_LIMIT_REGISTER_IP_WINDOW_MIN, 60) * 60 * 1000,
    maxEntries: DEFAULT_RATE_LIMITS.maxEntries
  };
}

/**
 * Build a rate limiter. `now` is injectable so window behaviour is testable
 * without sleeping.
 */
function createAuthRateLimiter(options) {
  const cfg = Object.assign({}, DEFAULT_RATE_LIMITS, options || {});
  const clock = typeof cfg.now === 'function' ? cfg.now : Date.now;

  const loginIp = new Map();
  const loginAccount = new Map();
  const registerIp = new Map();

  function prune(map, windowMs) {
    const t = clock();
    for (const entry of map) {
      if (t - entry[1].start >= windowMs) map.delete(entry[0]);
    }
    while (map.size > cfg.maxEntries) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }

  function bump(map, key, max, windowMs) {
    if (!(max > 0)) return { allowed: true, remaining: 0, disabled: true };
    if (!key) return { allowed: true, remaining: max };

    prune(map, windowMs);
    const t = clock();
    let record = map.get(key);
    if (!record || t - record.start >= windowMs) {
      record = { count: 0, start: t };
      map.set(key, record);
    }
    if (record.count >= max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((record.start + windowMs - t) / 1000))
      };
    }
    record.count += 1;
    return { allowed: true, remaining: Math.max(0, max - record.count) };
  }

  function peek(map, key, max, windowMs) {
    if (!(max > 0)) return { allowed: true, remaining: 0, disabled: true };
    if (!key) return { allowed: true, remaining: max };

    const t = clock();
    const record = map.get(key);
    if (!record || t - record.start >= windowMs) {
      return { allowed: true, remaining: max };
    }
    if (record.count >= max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((record.start + windowMs - t) / 1000))
      };
    }
    return { allowed: true, remaining: Math.max(0, max - record.count) };
  }

  return {
    /**
     * Count one login attempt and report whether it may proceed. The IP bucket
     * counts every attempt; the account bucket counts only recorded failures.
     */
    checkLogin: function (ip, accountKey) {
      const byIp = bump(loginIp, ip, cfg.loginIpMax, cfg.loginIpWindowMs);
      if (!byIp.allowed) return byIp;
      const byAccount = peek(loginAccount, accountKey, cfg.loginAccountMax, cfg.loginAccountWindowMs);
      if (!byAccount.allowed) return byAccount;
      return { allowed: true };
    },

    recordLoginFailure: function (accountKey) {
      return bump(loginAccount, accountKey, cfg.loginAccountMax, cfg.loginAccountWindowMs);
    },

    clearLoginFailures: function (accountKey) {
      if (accountKey) loginAccount.delete(accountKey);
    },

    checkRegister: function (ip) {
      return bump(registerIp, ip, cfg.registerIpMax, cfg.registerIpWindowMs);
    },

    stats: function () {
      return { loginIp: loginIp.size, loginAccount: loginAccount.size, registerIp: registerIp.size };
    },

    reset: function () {
      loginIp.clear();
      loginAccount.clear();
      registerIp.clear();
    },

    config: cfg
  };
}

module.exports = {
  EMAIL_RE: EMAIL_RE,
  MIN_ADMIN_PASSWORD_LENGTH: MIN_ADMIN_PASSWORD_LENGTH,
  MAX_ADMIN_PASSWORD_BYTES: MAX_ADMIN_PASSWORD_BYTES,
  WEAK_ADMIN_PASSWORDS: WEAK_ADMIN_PASSWORDS,
  DEFAULT_RATE_LIMITS: DEFAULT_RATE_LIMITS,
  normalizeEmail: normalizeEmail,
  validateAdminPassword: validateAdminPassword,
  resolveAdminProvisioning: resolveAdminProvisioning,
  provisionAdmin: provisionAdmin,
  resolveAuthRateLimits: resolveAuthRateLimits,
  createAuthRateLimiter: createAuthRateLimiter
};
