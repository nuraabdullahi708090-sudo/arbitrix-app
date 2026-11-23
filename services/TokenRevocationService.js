'use strict';

/**
 * Server-side JWT session revocation (jti denylist).
 *
 * DESIGN
 *   - Every full session token is signed with a unique `jti` (see
 *     `generateJti`). `POST /api/auth/logout` stores that `jti` in the
 *     revocation store; `authMiddleware` rejects any token whose `jti` is
 *     present, so a replayed token returns 401 even though its signature and
 *     `exp` are still valid.
 *   - Nothing here logs or returns token material. Only opaque jti ids, a
 *     user id and an expiry are stored.
 *   - The store is pluggable: production uses the Supabase-backed store
 *     (table `revoked_tokens`, migration 025, service-role only under RLS);
 *     tests use the in-memory store.
 *
 * WHY A DENYLIST (not short-lived access + refresh)
 *   It revokes the exact session on logout without adding a refresh round trip
 *   or changing the login response shape. Rows are bounded by the token's own
 *   `exp`, so a row can never outlive the token it revokes and the table cannot
 *   grow without limit (prune expired rows periodically).
 */

const crypto = require('crypto');

const TABLE = 'revoked_tokens';
// Matches the session TTL used at signing time (`expiresIn: '7d'`).
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function generateJti() {
  return crypto.randomUUID();
}

function isJtiRevocable(decoded) {
  return !!(decoded && typeof decoded.jti === 'string' && decoded.jti.length > 0);
}

// JWT `exp` is seconds since the epoch. Clamp each row to the token's real
// expiry; fall back to a bounded default so a missing/absurd `exp` can never
// create a row that outlives every session.
function expiresAtFromDecoded(decoded, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const exp = decoded ? Number(decoded.exp) : NaN;
  const ms = (Number.isFinite(exp) && exp > 0) ? exp * 1000 : now + DEFAULT_TTL_MS;
  return new Date(ms);
}

async function revokeToken(store, decoded) {
  if (!store) return { revoked: false, reason: 'no_store' };
  if (!isJtiRevocable(decoded)) return { revoked: false, reason: 'no_jti' };
  const result = await store.add({
    jti: decoded.jti,
    userId: (decoded.id === undefined || decoded.id === null) ? null : decoded.id,
    expiresAt: expiresAtFromDecoded(decoded),
  });
  // `durable:false` means the resilient store enforced the revocation locally
  // and queued the durable write (the store was unreachable). Callers treat the
  // logout as successful either way - the session IS ended - but can log it.
  return {
    revoked: true,
    jti: decoded.jti,
    durable: !(result && result.durable === false),
  };
}

async function isTokenRevoked(store, jti) {
  if (!store || !jti) return false;
  return !!(await store.has(jti));
}

/**
 * Delete revocation records whose token has already expired.
 *
 * Never throws: callers run this unattended, and a missing RPC / transient
 * database error must not affect request handling. `{ok:false, reason}` tells the
 * caller whether to warn (once) instead of retrying loudly.
 */
async function pruneExpired(store, nowMs) {
  if (!store) return { ok: false, reason: 'no_store' };
  if (typeof store.prune !== 'function') return { ok: false, reason: 'unsupported_store' };
  try {
    const deleted = await store.prune(nowMs);
    return { ok: true, deleted: Number.isFinite(Number(deleted)) ? Number(deleted) : 0 };
  } catch (e) {
    return { ok: false, reason: 'prune_failed', error: (e && e.message) || 'unknown' };
  }
}

// Supabase (production) store. Uses the service-role client; migration 025
// restricts `revoked_tokens` to service_role, so the anon/authenticated roles
// can never read or write it. Upsert keeps a double logout idempotent.
function createSupabaseStore(supabaseAdmin, table = TABLE) {
  if (!supabaseAdmin) throw new Error('createSupabaseStore requires a Supabase client');
  return {
    async add({ jti, userId, expiresAt }) {
      const { error } = await supabaseAdmin
        .from(table)
        .upsert(
          { jti, user_id: userId, expires_at: expiresAt.toISOString() },
          { onConflict: 'jti', ignoreDuplicates: true }
        );
      if (error) throw error;
    },
    async has(jti) {
      const { data, error } = await supabaseAdmin
        .from(table)
        .select('jti')
        .eq('jti', jti)
        .gt('expires_at', new Date().toISOString())
        .limit(1);
      if (error) throw error;
      return Array.isArray(data) && data.length > 0;
    },
    // Delegates to the SECURITY DEFINER function created by migration 025.
    // Returns the number of rows removed (0 when the function is absent -> error).
    async prune() {
      const { data, error } = await supabaseAdmin.rpc('prune_revoked_tokens');
      if (error) throw error;
      const deleted = Number(data);
      return Number.isFinite(deleted) ? deleted : 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Resilient wrapper: local state + bounded caching + a circuit breaker.
//
// WHY THIS EXISTS
//   `authMiddleware` looks every session up in the store. The first version
//   simply swallowed a store error and let the request through ("fail open"), so
//   during a database outage a token that HAD been revoked (logout) was accepted
//   again until the store recovered. Worse, a logout that happened during the
//   outage also failed to persist, so the session stayed valid afterwards with no
//   record anywhere. At the same time, failing closed would log every customer
//   out of a working product because Supabase had a bad minute.
//
// WHAT IT DOES
//   1. LOCAL REVOCATION IS AUTHORITATIVE. Every logout handled by this process
//      records the jti locally FIRST, so a replay is rejected immediately - even
//      if the durable write fails and even while the store is unreachable.
//   2. DURABLE WRITES ARE RETRIED. A revocation that could not be persisted is
//      queued (bounded) and flushed on the next successful store call, so a
//      transient outage does not silently lose a revocation.
//   3. VERIFIED-NOT-REVOKED IS CACHED for a few seconds (bounded, configurable).
//      This is what makes the store outage survivable without a per-request
//      timeout penalty; a logout on another instance is still observed within
//      the TTL.
//   4. A CIRCUIT BREAKER stops hammering a failing store: after a few
//      consecutive failures the store is skipped for a short cooldown, so a
//      request cannot hang for the full timeout on every call.
//   5. OPT-IN STRICT MODE (`requireStore`): when the store cannot be consulted
//      and the token is not already known locally, the caller is told to answer
//      503 (retryable) instead of allowing the request. It is OFF by default
//      because a platform-wide lockout during a transient outage is worse than a
//      short window in which a replayed token may still work; enabling it is a
//      deliberate posture choice for high-assurance deployments.
//
// RESIDUAL RISK (documented, not hidden): with strict mode off, during an outage
// a token revoked by a DIFFERENT instance - and not yet observed here - can still
// be used until the store recovers. Local revocations and anything already seen
// as revoked are always enforced.
// ---------------------------------------------------------------------------

const RESILIENT_DEFAULTS = {
  timeoutMs: 2000,
  verifiedTtlMs: 10000,
  maxRevoked: 20000,
  maxVerified: 20000,
  maxPending: 500,
  failureThreshold: 3,
  cooldownMs: 10000,
  requireStore: false,
  flushBatch: 25,
};

function revocationUnavailableError(reason) {
  const err = new Error('revocation store unavailable' + (reason ? ': ' + reason : ''));
  err.code = 'REVOCATION_UNAVAILABLE';
  err.reason = reason || 'unavailable';
  return err;
}

// Reject (never resolve) after `ms`. The timer is unref'd and always cleared so
// a slow store can neither hang the request nor keep the process alive.
function withTimeout(promise, ms) {
  if (!(Number(ms) > 0)) return Promise.resolve(promise);
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      reject(revocationUnavailableError('timeout'));
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      function (value) { clearTimeout(timer); resolve(value); },
      function (err) { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Read the resilience knobs from the environment.
 *
 *   AUTH_REVOCATION_TIMEOUT_MS        per-call store timeout (default 2000)
 *   AUTH_REVOCATION_CACHE_MS          how long a "not revoked" answer is trusted
 *                                     (default 10000; 0 disables the cache)
 *   AUTH_REVOCATION_REQUIRE_STORE     "true" = 503 instead of allowing a request
 *                                     whose revocation state cannot be verified
 *                                     (default false; see the trade-off above)
 *
 * Invalid, negative or empty values fall back to the default; `0` is honoured
 * and disables the cache (every request asks the store, as before).
 */
function resolveResilientOptions(env, extra) {
  const source = env || {};
  const opts = Object.assign({}, extra || {});

  const timeout = Number(String(source.AUTH_REVOCATION_TIMEOUT_MS == null ? '' : source.AUTH_REVOCATION_TIMEOUT_MS).trim());
  opts.timeoutMs = (Number.isFinite(timeout) && timeout > 0) ? Math.min(timeout, 10000) : RESILIENT_DEFAULTS.timeoutMs;

  const cacheRaw = String(source.AUTH_REVOCATION_CACHE_MS == null ? '' : source.AUTH_REVOCATION_CACHE_MS).trim();
  if (cacheRaw !== '') {
    const cache = Number(cacheRaw);
    opts.verifiedTtlMs = (Number.isFinite(cache) && cache >= 0) ? Math.min(cache, 300000) : RESILIENT_DEFAULTS.verifiedTtlMs;
  }

  const strict = String(source.AUTH_REVOCATION_REQUIRE_STORE == null ? '' : source.AUTH_REVOCATION_REQUIRE_STORE).trim().toLowerCase();
  opts.requireStore = strict === 'true' || strict === '1' || strict === 'yes';

  return opts;
}

/**
 * Wrap a revocation store with local revocation, caching, retries and a circuit
 * breaker. The returned object is itself a store (`add` / `has` / `prune`), so
 * callers keep using the same functions.
 *
 * `add` NEVER throws: a durable write failure is queued for retry and reported
 * as `durable:false` (a logout must not fail because the database is down).
 * `has` throws only in strict mode when the store is unreachable; otherwise an
 * unreachable store resolves to `false` (allow) exactly as before.
 */
function createResilientStore(inner, options) {
  const cfg = Object.assign({}, RESILIENT_DEFAULTS, options || {});
  const clock = typeof cfg.now === 'function' ? cfg.now : Date.now;
  const emit = typeof cfg.onEvent === 'function' ? cfg.onEvent : function () {};

  const revoked = new Map();      // jti -> expiryMs  (authoritative "revoked")
  const verified = new Map();     // jti -> verifiedAt (known-not-revoked, short TTL)
  const pending = new Map();      // jti -> { userId, expiresAt }  (durable retry)
  let consecutiveFailures = 0;
  let openUntil = 0;
  let lastFailure = null;
  const counters = {
    checks: 0, localHits: 0, cacheHits: 0, storeChecks: 0,
    storeFailures: 0, circuitOpens: 0, unavailable: 0,
    pendingQueued: 0, pendingFlushed: 0, pendingDropped: 0,
  };

  function pruneExpiredLocal(now) {
    for (const entry of revoked) {
      if (entry[1] <= now) revoked.delete(entry[0]);
    }
    for (const entry of verified) {
      if (entry[1] <= now) verified.delete(entry[0]);
    }
  }

  function evictOldest(map, max) {
    while (map.size > max) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }

  function rememberRevoked(jti, expiresAtMs) {
    revoked.set(jti, expiresAtMs);
    // A brand-new revocation invalidates any "verified" opinion of that jti.
    verified.delete(jti);
    if (revoked.size > cfg.maxRevoked) {
      pruneExpiredLocal(clock());
      evictOldest(revoked, cfg.maxRevoked);
    }
    pending.delete(jti);
  }

  function queuePending(jti, entry) {
    pending.set(jti, entry);
    counters.pendingQueued += 1;
    if (pending.size > cfg.maxPending) {
      const oldest = pending.keys().next();
      if (!oldest.done) {
        pending.delete(oldest.value);
        counters.pendingDropped += 1;
        emit('pending_dropped', { size: pending.size });
      }
    }
  }

  async function flushPending() {
    if (pending.size === 0) return 0;
    let flushed = 0;
    let attempts = 0;
    for (const entry of Array.from(pending.entries())) {
      if (attempts >= cfg.flushBatch) break;
      attempts += 1;
      const jti = entry[0];
      const value = entry[1];
      try {
        await withTimeout(inner.add({ jti, userId: value.userId, expiresAt: new Date(value.expiresAtMs) }), cfg.timeoutMs);
        pending.delete(jti);
        counters.pendingFlushed += 1;
        flushed += 1;
      } catch (e) {
        break; // still down; keep the rest for the next opportunity
      }
    }
    if (flushed > 0) emit('pending_flushed', { count: flushed, remaining: pending.size });
    return flushed;
  }

  function noteFailure(stage, err) {
    counters.storeFailures += 1;
    lastFailure = { stage: stage, reason: (err && (err.code || err.message)) || 'error', at: clock() };
    consecutiveFailures += 1;
    if (consecutiveFailures >= cfg.failureThreshold && clock() >= openUntil) {
      openUntil = clock() + cfg.cooldownMs;
      counters.circuitOpens += 1;
      emit('store_open', { failureThreshold: cfg.failureThreshold, cooldownMs: cfg.cooldownMs });
    }
  }

  function noteSuccess() {
    if (consecutiveFailures > 0) {
      consecutiveFailures = 0;
      emit('store_recovered', {});
    }
    openUntil = 0;
  }

  return {
    async add(entry) {
      const jti = entry && entry.jti;
      if (!jti) return { durable: false, local: false, reason: 'no_jti' };
      const expiresAtMs = entry.expiresAt instanceof Date
        ? entry.expiresAt.getTime()
        : Number(entry.expiresAt) || (clock() + DEFAULT_TTL_MS);
      // 1. Local first: the revocation takes effect on this process immediately.
      rememberRevoked(jti, expiresAtMs);
      // 2. Then try to persist it.
      try {
        await withTimeout(inner.add({ jti: jti, userId: entry.userId, expiresAt: new Date(expiresAtMs) }), cfg.timeoutMs);
        noteSuccess();
        // Opportunistic: the store is reachable, so drain anything queued earlier.
        flushPending().catch(function () { /* never fatal */ });
        return { durable: true, local: true };
      } catch (err) {
        noteFailure('add', err);
        queuePending(jti, { userId: entry.userId === undefined ? null : entry.userId, expiresAtMs: expiresAtMs });
        return { durable: false, local: true, reason: (err && err.code) || 'store_error' };
      }
    },

    async has(jti) {
      if (!jti) return false;
      counters.checks += 1;
      const now = clock();

      // 1. Locally known revoked -> reject, whatever the store says.
      const revokedUntil = revoked.get(jti);
      if (revokedUntil !== undefined) {
        if (revokedUntil > now) { counters.localHits += 1; return true; }
        revoked.delete(jti);
      }

      // 2. Known-not-revoked recently -> allow without touching the store.
      const verifiedAt = verified.get(jti);
      if (verifiedAt !== undefined) {
        if (now - verifiedAt < cfg.verifiedTtlMs) { counters.cacheHits += 1; return false; }
        verified.delete(jti);
      }

      // 3. Circuit open -> the store is known to be failing; do not wait on it.
      if (openUntil > now) {
        counters.unavailable += 1;
        if (cfg.requireStore) throw revocationUnavailableError('circuit-open');
        return false;
      }

      // 4. Ask the store.
      counters.storeChecks += 1;
      try {
        const isRevoked = await withTimeout(inner.has(jti), cfg.timeoutMs);
        noteSuccess();
        if (isRevoked) {
          // Cache the positive answer so it survives an outage.
          rememberRevoked(jti, now + DEFAULT_TTL_MS);
          return true;
        }
        verified.set(jti, now);
        if (verified.size > cfg.maxVerified) {
          pruneExpiredLocal(now);
          evictOldest(verified, cfg.maxVerified);
        }
        flushPending().catch(function () { /* never fatal */ });
        return false;
      } catch (err) {
        noteFailure('has', err);
        counters.unavailable += 1;
        if (cfg.requireStore) throw revocationUnavailableError((err && err.code) || 'store_error');
        return false;
      }
    },

    async prune(nowMs) {
      const now = Number.isFinite(nowMs) ? nowMs : clock();
      const before = revoked.size + verified.size;
      pruneExpiredLocal(now);
      const removedLocally = before - (revoked.size + verified.size);
      let removedRemotely = 0;
      if (typeof inner.prune === 'function') {
        try {
          removedRemotely = await withTimeout(inner.prune(now), cfg.timeoutMs);
          noteSuccess();
          flushPending().catch(function () { /* never fatal */ });
        } catch (err) {
          noteFailure('prune', err);
          // Housekeeping must never fail the caller; `pruneExpired` in the
          // service converts a throw into {ok:false}.
          throw err;
        }
      }
      return (Number(removedLocally) || 0) + (Number(removedRemotely) || 0);
    },

    stats() {
      return Object.assign({}, counters, {
        revokedSize: revoked.size,
        verifiedSize: verified.size,
        pendingSize: pending.size,
        circuitOpen: openUntil > clock(),
        consecutiveFailures: consecutiveFailures,
        lastFailure: lastFailure,
      });
    },

    // Test hooks (never used by production code).
    _pendingKeys() { return Array.from(pending.keys()); },
    _forget(jti) { revoked.delete(jti); verified.delete(jti); },
  };
}

// In-memory store (tests, or a single-process fallback). Prunes an entry once
// its token expiry passes, so it cannot grow without bound within a process.
function createMemoryStore(now = () => Date.now()) {
  const entries = new Map();
  return {
    async add({ jti, userId, expiresAt }) {
      entries.set(jti, { userId: userId === undefined ? null : userId, expiresAt: expiresAt.getTime() });
    },
    async has(jti) {
      const entry = entries.get(jti);
      if (!entry) return false;
      if (entry.expiresAt <= now()) { entries.delete(jti); return false; }
      return true;
    },
    async prune() {
      const t = now();
      let deleted = 0;
      for (const entry of entries) {
        if (entry[1].expiresAt <= t) { entries.delete(entry[0]); deleted += 1; }
      }
      return deleted;
    },
    _size() { return entries.size; },
  };
}

module.exports = {
  TABLE,
  DEFAULT_TTL_MS,
  RESILIENT_DEFAULTS,
  resolveResilientOptions,
  createResilientStore,
  revocationUnavailableError,
  generateJti,
  isJtiRevocable,
  expiresAtFromDecoded,
  revokeToken,
  isTokenRevoked,
  pruneExpired,
  createSupabaseStore,
  createMemoryStore,
};
