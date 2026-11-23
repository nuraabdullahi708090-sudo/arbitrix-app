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
function escapeLikePattern(value) {
  // PostgREST passes the pattern to PostgreSQL LIKE/ILIKE, where backslash is the
  // default escape character. Without this a local part containing "_" or "%"
  // would match unrelated addresses.
  return String(value).replace(/[\\%_]/g, '\\$&');
}

/**
 * Find an account by email, tolerating case differences.
 *
 * Account identity is case-insensitive (migration 056 enforces one row per
 * lower(email)), but an address is stored exactly as the customer typed it, so an
 * exact query alone misses any case variant. The exact match is tried first - it
 * is indexed and it is what every caller did before - and only then a
 * case-insensitive query, whose rows are compared on the NORMALISED address
 * because a LIKE pattern cannot prove equality.
 *
 * `ambiguous` reports the one case that must never be resolved silently: two or
 * more rows whose addresses differ only in case. That can only exist before the
 * uniqueness index is applied, and picking one would sign a customer into the
 * wrong account, so callers treat it as "no account".
 *
 * @param {object} admin - Supabase client (service role)
 * @param {string} email
 * @param {{columns?: string}} [options]
 * @returns {Promise<{ok: true, account: object|null, ambiguous?: boolean} | {ok: false, reason: string}>}
 */
function rowsOf(result) {
  if (!result) return [];
  const data = result.data;
  if (Array.isArray(data)) return data;
  // A `.maybeSingle()` / `.single()` response carries the row as an object.
  if (data && typeof data === 'object') return [data];
  return [];
}

async function findAccountByEmail(admin, email, options) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: true, account: null };
  const columns = (options && options.columns) || 'id, email';

  try {
    const exactBuilder = admin.from('users').select(columns).eq('email', email);
    // Use whichever single-row form the client offers; the array form is the
    // documented default, and some callers/stubs expose only one of them.
    let exactQuery = exactBuilder;
    if (exactBuilder && typeof exactBuilder.maybeSingle === 'function') exactQuery = exactBuilder.maybeSingle();
    else if (exactBuilder && typeof exactBuilder.limit === 'function') exactQuery = exactBuilder.limit(1);
    const exact = await exactQuery;
    if (exact && exact.error) return { ok: false, reason: 'lookup-failed' };
    const exactRows = rowsOf(exact);
    if (exactRows.length > 0) return { ok: true, account: exactRows[0] };
  } catch (e) {
    return { ok: false, reason: 'lookup-failed' };
  }

  try {
    const builder = admin.from('users').select(columns);
    // A client without `ilike` cannot express a case-insensitive query (some test
    // doubles). Treat it as "no further match" rather than failing the look-up.
    if (!builder || typeof builder.ilike !== 'function') return { ok: true, account: null };
    const pattern = escapeLikePattern(String(email).trim());
    let query = builder.ilike('email', pattern);
    if (query && typeof query.limit === 'function') query = query.limit(5);
    const result = await query;
    if (result && result.error) return { ok: false, reason: 'lookup-failed' };

    const rows = rowsOf(result).filter(function (row) {
      return row && normalizeEmail(row.email) === normalized;
    });
    if (rows.length === 0) return { ok: true, account: null };
    if (rows.length > 1) return { ok: true, account: null, ambiguous: true };
    return { ok: true, account: rows[0] };
  } catch (e) {
    return { ok: false, reason: 'lookup-failed' };
  }
}

/**
 * The id/email-only form used by admin provisioning.
 *
 * @returns {Promise<{ok: true, account: object|null} | {ok: false, reason: string}>}
 */
async function findExistingAccount(admin, email) {
  return findAccountByEmail(admin, email, { columns: 'id, email' });
}

async function createZeroWallet(admin, userId) {
  const insert = await admin.from('wallets').insert({
    user_id: userId,
    demo_balance: 0,
    live_balance: 0,
    bonus_balance: 0
  });
  return !(insert && insert.error);
}

/**
 * Create the configured administrator, once, without ever touching an existing
 * account.
 *
 * Result states:
 *   disabled / incomplete / invalid-email / weak-password - configuration
 *   exists    - an account already uses that address (nothing was changed)
 *   created   - account AND zeroed wallet exist
 *   partial   - the account was created but its wallet could not be; the caller
 *               must treat this as a failure, not a success
 *   error     - nothing was created (reason names the failing step)
 *
 * @param {object} opts
 * @param {object} opts.admin - Supabase client (service role)
 * @param {object} opts.env
 * @param {function} opts.hashPassword - (plain) => hash, injected by the caller
 * @param {function} opts.generateReferralCode - async () => unique code
 * @returns {Promise<{status: string, userId?: number, reason?: string, walletCreated?: boolean, walletReady?: boolean}>}
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

  const lookup = await findExistingAccount(admin, cfg.email);
  if (!lookup.ok) return { status: 'error', reason: lookup.reason };

  // Never modify an existing account - not even to "fix" its password or role.
  if (lookup.account) return { status: 'exists' };

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

    if (insert && insert.error && insert.error.code === '23505') {
      // A concurrent instance won the race. Nothing was created here; report it
      // exactly like the "already exists" case instead of a failure.
      const raced = await findExistingAccount(admin, cfg.email);
      if (raced.ok && raced.account) return { status: 'exists' };
      return { status: 'error', reason: 'insert-conflict' };
    }
    if (!insert || insert.error || !insert.data) {
      return { status: 'error', reason: 'insert-failed' };
    }
    created = insert.data;
  } catch (e) {
    return { status: 'error', reason: 'insert-failed' };
  }

  // An operator account must not receive the new-user promotional balance, so the
  // wallet is created explicitly at zero before anything can lazily seed it. A
  // single retry covers a transient database error; if it still fails the result
  // is PARTIAL, never "created", so a missing wallet cannot pass as success.
  let walletCreated = false;
  for (let attempt = 0; attempt < 2 && !walletCreated; attempt += 1) {
    try {
      walletCreated = await createZeroWallet(admin, created.id);
    } catch (e) {
      walletCreated = false;
    }
  }

  if (!walletCreated) {
    return {
      status: 'partial',
      userId: created.id,
      reason: 'wallet-create-failed',
      walletCreated: false,
      walletReady: false
    };
  }

  return { status: 'created', userId: created.id, walletCreated: true, walletReady: true };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const DEFAULT_RATE_LIMITS = {
  // Every login attempt from one IP.
  loginIpMax: 60,
  loginIpWindowMs: 15 * 60 * 1000,
  // Failed logins against one submitted account that are tolerated with no delay.
  // The Nth failure inside the window starts a cooldown; each further failure
  // doubles it up to loginCooldownMaxMs. A successful login clears everything.
  loginAccountMax: 10,
  loginAccountWindowMs: 15 * 60 * 1000,
  loginCooldownBaseMs: 15 * 1000,
  loginCooldownMaxMs: 2 * 60 * 1000,
  // New accounts from one IP.
  registerIpMax: 20,
  registerIpWindowMs: 60 * 60 * 1000,
  // Bound on stored keys per bucket, so a flood cannot grow memory without end.
  maxEntries: 20000,
  // A full sweep of a bucket runs at most this often. Per-request correctness
  // never depends on it: an individual record is always treated as expired by
  // its own window check.
  sweepIntervalMs: 60 * 1000
};

/**
 * Budgets used when the client address is NOT attributable to a single client.
 *
 * When no proxy is trusted (`TRUST_PROXY` / `TRUST_PROXY_HOPS` unset) the server
 * sees the edge proxy's address for every visitor, so a per-address budget of
 * "60 logins per 15 minutes" would be a GLOBAL budget: one busy hour would lock
 * every customer out, and 20 registrations per hour for the whole platform would
 * stop signups entirely. Using the per-client defaults in that situation is a
 * self-inflicted outage, not a security control.
 *
 * The shared budgets below are therefore deliberately generous: they exist only
 * to bound a crude flood, while the per-account login limiter - which does not
 * depend on the address - keeps its normal strength. An explicit
 * AUTH_RATE_LIMIT_* value always wins over these defaults, and they are never
 * used once a proxy trust setting makes the address attributable.
 */
const SHARED_IP_DEFAULTS = {
  loginIpMax: 5000,
  // A password-reset request for one address is already limited per email; this
  // is only the flood guard for the whole platform.
  passwordResetIpMax: 200,
  registerIpMax: 200
};

function parseCount(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseMinutes(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseSeconds(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Names of the limits that are DISABLED (resolved to 0) in this configuration.
 *
 * A maximum of 0 means "unlimited", which is a legitimate emergency lever and is
 * what the local rehearsal env file uses - but shipping it to production removes
 * brute-force protection silently. The server logs this list at startup in
 * production; this function only classifies, so it stays side-effect free.
 *
 * @param {{loginIpMax?:number, loginAccountMax?:number, registerIpMax?:number, forgotPasswordIpMax?:number}} limits
 * @returns {string[]} the configuration names that are disabled
 */
function findDisabledLimits(limits) {
  const value = limits || {};
  const map = [
    ['AUTH_RATE_LIMIT_LOGIN_IP_MAX', value.loginIpMax],
    ['AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX', value.loginAccountMax],
    ['AUTH_RATE_LIMIT_REGISTER_IP_MAX', value.registerIpMax],
    ['RATE_LIMIT_IP_MAX', value.forgotPasswordIpMax]
  ];
  // Only an explicit zero counts. `Number(null)` and `Number('')` are 0, but
  // those mean "not configured", and reporting them as disabled would be a false
  // alarm on every deployment that leaves the variable unset.
  function isDisabled(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string' && value.trim() === '') return false;
    const n = Number(value);
    return Number.isFinite(n) && n === 0;
  }
  return map.filter(function (entry) { return isDisabled(entry[1]); })
    .map(function (entry) { return entry[0]; });
}

/**
 * Read the auth rate-limit configuration, with safe defaults. A maximum of 0
 * disables that bucket (useful for controlled local rehearsal runs only).
 *
 * `options.ipAttributable === false` means the server cannot see the real client
 * address (no proxy trust configured), so a per-address budget would act as a
 * platform-wide budget. The per-IP buckets then fall back to SHARED_IP_DEFAULTS
 * unless the operator set an explicit value - see that constant for why.
 */
function resolveAuthRateLimits(env, options) {
  const source = env || {};
  const attributable = !(options && options.ipAttributable === false);
  const sharedLoginIp = attributable ? DEFAULT_RATE_LIMITS.loginIpMax : SHARED_IP_DEFAULTS.loginIpMax;
  const sharedRegisterIp = attributable ? DEFAULT_RATE_LIMITS.registerIpMax : SHARED_IP_DEFAULTS.registerIpMax;
  return {
    loginIpMax: parseCount(source.AUTH_RATE_LIMIT_LOGIN_IP_MAX, sharedLoginIp),
    loginIpWindowMs: parseMinutes(source.AUTH_RATE_LIMIT_LOGIN_IP_WINDOW_MIN, 15) * 60 * 1000,
    loginAccountMax: parseCount(source.AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX, DEFAULT_RATE_LIMITS.loginAccountMax),
    loginAccountWindowMs: parseMinutes(source.AUTH_RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_MIN, 15) * 60 * 1000,
    loginCooldownMaxMs: parseSeconds(source.AUTH_RATE_LIMIT_LOGIN_COOLDOWN_MAX_SEC, 120) * 1000,
    registerIpMax: parseCount(source.AUTH_RATE_LIMIT_REGISTER_IP_MAX, sharedRegisterIp),
    registerIpWindowMs: parseMinutes(source.AUTH_RATE_LIMIT_REGISTER_IP_WINDOW_MIN, 60) * 60 * 1000,
    ipAttributable: attributable,
    maxEntries: DEFAULT_RATE_LIMITS.maxEntries,
    sweepIntervalMs: DEFAULT_RATE_LIMITS.sweepIntervalMs
  };
}

/**
 * Build a rate limiter. `now` is injectable so window behaviour is testable
 * without sleeping.
 *
 * Two properties matter for cost:
 *   - Correctness never requires walking the maps: an individual record is
 *     judged against its own window, so a full sweep is only housekeeping.
 *   - A full sweep therefore runs at most once per `sweepIntervalMs`, and an
 *     over-capacity bucket evicts a BATCH (down to 90% of the cap) instead of one
 *     key per request. Churning keys cannot turn every request into an O(n) walk.
 */
function createAuthRateLimiter(options) {
  const cfg = Object.assign({}, DEFAULT_RATE_LIMITS, options || {});
  const clock = typeof cfg.now === 'function' ? cfg.now : Date.now;

  // { entries: Map, lastSweepAt: number }
  const loginIp = { entries: new Map(), lastSweepAt: 0 };
  const loginAccount = { entries: new Map(), lastSweepAt: 0 };
  const registerIp = { entries: new Map(), lastSweepAt: 0 };
  const counters = { sweeps: 0, evictions: 0 };

  function accountIsExpired(state, t, windowMs) {
    if (!state) return true;
    if (state.lockedUntil && t < state.lockedUntil) return false;
    const failures = state.failures || [];
    if (failures.length === 0) return true;
    return t - failures[failures.length - 1] >= windowMs;
  }

  /**
   * How much a bucket entry is worth keeping when the bucket is full.
   *
   * 2 = actively protecting an account (a live lockout) - evicting it would let
   *     the attacker who filled the bucket continue guessing that password;
   * 1 = has recent failures, so it is still counting toward a cooldown;
   * 0 = inert (a single successful attempt, or a window that has expired).
   *
   * An attacker can create unlimited DISTINCT account keys (one per attempted
   * address), so plain oldest-first eviction let a flood push a victim's lockout
   * out of the bucket. Ranking keeps the entries that carry protection and
   * spends the eviction budget on the attacker's own inert keys instead.
   */
  function evictionRank(state, t) {
    if (!state) return 0;
    if (state.lockedUntil && t < state.lockedUntil) return 2;
    if (state.failures && state.failures.length > 0) return 1;
    return 0;
  }

  function sweep(bucket, isExpired) {
    const t = clock();
    const entries = bucket.entries;
    counters.sweeps += 1;

    for (const entry of entries) {
      if (isExpired(entry[1], t)) entries.delete(entry[0]);
    }

    if (entries.size > cfg.maxEntries) {
      // Evict in a batch so the next requests do not each re-trigger this path.
      const target = Math.floor(cfg.maxEntries * 0.9);
      const candidates = [];
      for (const entry of entries) {
        candidates.push([entry[0], evictionRank(entry[1], t)]);
      }
      // Stable sort: equal ranks keep insertion order, so the oldest inert entry
      // goes first. This only runs while the bucket is over capacity, and the
      // request rate that can create keys is itself rate limited.
      candidates.sort(function (a, b) { return a[1] - b[1]; });
      for (const candidate of candidates) {
        if (entries.size <= target) break;
        entries.delete(candidate[0]);
        counters.evictions += 1;
      }
    }
    bucket.lastSweepAt = t;
  }

  // Housekeeping only: called from the hot paths, but a full walk is rate
  // limited by time and by capacity, never by request count.
  function maybeSweep(bucket, isExpired) {
    const t = clock();
    const overCapacity = bucket.entries.size > cfg.maxEntries;
    const dueByTime = t - bucket.lastSweepAt >= cfg.sweepIntervalMs;
    if (!overCapacity && !dueByTime) return;
    sweep(bucket, isExpired);
  }

  function windowIsExpired(record, t, windowMs) {
    return !record || t - record.start >= windowMs;
  }

  function bump(bucket, key, max, windowMs) {
    if (!(max > 0)) return { allowed: true, remaining: 0, disabled: true };
    if (!key) return { allowed: true, remaining: max };

    maybeSweep(bucket, function (record, t) { return windowIsExpired(record, t, windowMs); });

    const t = clock();
    const map = bucket.entries;
    let record = map.get(key);
    if (windowIsExpired(record, t, windowMs)) {
      record = { count: 0, start: t };
      // Re-insert at the tail so eviction order approximates recency.
      map.delete(key);
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
    // The insert may have taken the bucket past its ceiling (a new key, a
    // flood); trim immediately so the size never exceeds maxEntries between
    // requests.
    if (map.size > cfg.maxEntries) {
      maybeSweep(bucket, function (rec, t) { return windowIsExpired(rec, t, windowMs); });
    }
    return { allowed: true, remaining: Math.max(0, max - record.count) };
  }

  function pruneFailures(state, t) {
    const cutoff = t - cfg.loginAccountWindowMs;
    state.failures = (state.failures || []).filter(function (at) { return at > cutoff; });
  }

  function peekAccount(key) {
    if (!(cfg.loginAccountMax > 0)) return { allowed: true, remaining: 0, disabled: true };
    if (!key) return { allowed: true, remaining: cfg.loginAccountMax };

    const t = clock();
    const state = loginAccount.entries.get(key);
    if (!state) return { allowed: true, remaining: cfg.loginAccountMax };

    pruneFailures(state, t);
    if (state.lockedUntil && t < state.lockedUntil) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((state.lockedUntil - t) / 1000))
      };
    }
    return { allowed: true, remaining: Math.max(0, cfg.loginAccountMax - state.failures.length) };
  }

  return {
    /**
     * Count one login attempt and report whether it may proceed. The IP bucket
     * counts every attempt; the account bucket counts only recorded failures.
     */
    checkLogin: function (ip, accountKey) {
      const byIp = bump(loginIp, ip, cfg.loginIpMax, cfg.loginIpWindowMs);
      if (!byIp.allowed) return byIp;
      const byAccount = peekAccount(accountKey);
      if (!byAccount.allowed) return byAccount;
      return { allowed: true };
    },

    /**
     * Record a failed password check for an account and apply a bounded,
     * progressive cooldown. The window is rolling: once the recorded failures
     * fall out of it, the account returns to the no-delay state on its own, so a
     * targeted attack can delay a sign-in but never lock an account out for good.
     */
    recordLoginFailure: function (accountKey) {
      if (!(cfg.loginAccountMax > 0) || !accountKey) {
        return { allowed: true, remaining: cfg.loginAccountMax };
      }

      maybeSweep(loginAccount, function (state, t) {
        return accountIsExpired(state, t, cfg.loginAccountWindowMs);
      });

      const t = clock();
      const map = loginAccount.entries;
      let state = map.get(accountKey);
      if (!state) {
        state = { failures: [], lockedUntil: 0 };
        map.set(accountKey, state);
      }

      pruneFailures(state, t);
      state.failures.push(t);
      // Bound the per-entry history. The cooldown doubles per failure above the
      // threshold but is clamped by loginCooldownMaxMs, so a handful beyond the
      // threshold carries all the state that matters; an unauthenticated caller
      // cannot inflate one entry into an unbounded array this way.
      const maxSamples = cfg.loginAccountMax + 4;
      if (state.failures.length > maxSamples) {
        state.failures = state.failures.slice(-maxSamples);
      }
      if (map.size > cfg.maxEntries) {
        maybeSweep(loginAccount, function (st, t) { return accountIsExpired(st, t, cfg.loginAccountWindowMs); });
      }

      let cooldownMs = 0;
      if (state.failures.length >= cfg.loginAccountMax) {
        const step = state.failures.length - cfg.loginAccountMax;
        cooldownMs = Math.min(cfg.loginCooldownBaseMs * Math.pow(2, step), cfg.loginCooldownMaxMs);
        state.lockedUntil = t + cooldownMs;
      }

      return {
        allowed: cooldownMs === 0,
        remaining: Math.max(0, cfg.loginAccountMax - state.failures.length),
        cooldownMs: cooldownMs,
        retryAfter: cooldownMs > 0 ? Math.max(1, Math.ceil(cooldownMs / 1000)) : 0
      };
    },

    clearLoginFailures: function (accountKey) {
      if (accountKey) loginAccount.entries.delete(accountKey);
    },

    checkRegister: function (ip) {
      return bump(registerIp, ip, cfg.registerIpMax, cfg.registerIpWindowMs);
    },

    stats: function () {
      return {
        loginIp: loginIp.entries.size,
        loginAccount: loginAccount.entries.size,
        registerIp: registerIp.entries.size,
        maxEntries: cfg.maxEntries,
        sweeps: counters.sweeps,
        evictions: counters.evictions
      };
    },

    reset: function () {
      loginIp.entries.clear();
      loginAccount.entries.clear();
      registerIp.entries.clear();
      loginIp.lastSweepAt = 0;
      loginAccount.lastSweepAt = 0;
      registerIp.lastSweepAt = 0;
    },

    config: cfg,

    // Test hooks: observe internal state without exposing the maps themselves.
    _accountState: function (accountKey) {
      const state = loginAccount.entries.get(accountKey);
      if (!state) return null;
      return {
        failures: (state.failures || []).length,
        lockedUntil: state.lockedUntil || 0
      };
    }
  };
}

module.exports = {
  EMAIL_RE: EMAIL_RE,
  MIN_ADMIN_PASSWORD_LENGTH: MIN_ADMIN_PASSWORD_LENGTH,
  MAX_ADMIN_PASSWORD_BYTES: MAX_ADMIN_PASSWORD_BYTES,
  WEAK_ADMIN_PASSWORDS: WEAK_ADMIN_PASSWORDS,
  DEFAULT_RATE_LIMITS: DEFAULT_RATE_LIMITS,
  SHARED_IP_DEFAULTS: SHARED_IP_DEFAULTS,
  normalizeEmail: normalizeEmail,
  escapeLikePattern: escapeLikePattern,
  findAccountByEmail: findAccountByEmail,
  validateAdminPassword: validateAdminPassword,
  resolveAdminProvisioning: resolveAdminProvisioning,
  provisionAdmin: provisionAdmin,
  resolveAuthRateLimits: resolveAuthRateLimits,
  findDisabledLimits: findDisabledLimits,
  createAuthRateLimiter: createAuthRateLimiter
};
