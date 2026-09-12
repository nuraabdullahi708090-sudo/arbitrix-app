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
  await store.add({
    jti: decoded.jti,
    userId: (decoded.id === undefined || decoded.id === null) ? null : decoded.id,
    expiresAt: expiresAtFromDecoded(decoded),
  });
  return { revoked: true, jti: decoded.jti };
}

async function isTokenRevoked(store, jti) {
  if (!store || !jti) return false;
  return !!(await store.has(jti));
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
    _size() { return entries.size; },
  };
}

module.exports = {
  TABLE,
  DEFAULT_TTL_MS,
  generateJti,
  isJtiRevocable,
  expiresAtFromDecoded,
  revokeToken,
  isTokenRevoked,
  createSupabaseStore,
  createMemoryStore,
};
