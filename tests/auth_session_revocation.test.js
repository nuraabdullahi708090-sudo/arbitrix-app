'use strict';

/**
 * F1 — Server-side session revocation (logout) contract + behavior tests.
 *
 * Two layers, matching the repo's existing conventions:
 *  1. Static contracts: server.js wires jti signing / logout / the revocation
 *     check; the migration locks the table to service_role; the frontend calls
 *     the logout endpoint.
 *  2. REAL behavior: the actual `signSessionToken`, `authMiddleware` and
 *     `adminMiddleware` sources are extracted from server.js and executed in a
 *     vm against the real jsonwebtoken + the real TokenRevocationService (with
 *     an in-memory store). No server is booted and no port is bound.
 *
 * SECRET RULE: only throwaway test secrets are used. No real token/secret is
 * read, written, or asserted anywhere in this file.
 *
 * Run: npm test
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/025_revoked_tokens.sql'), 'utf8');

const TokenRevocation = require('../services/TokenRevocationService');

// Extract a top-level function (handles `function` and `async function`) by
// brace matching. The extracted functions contain no braces inside strings or
// comments, so depth counting is exact.
function extractFunction(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = src.match(re);
  assert.ok(m, `function ${name} not found in server.js`);
  const start = m.index;
  // Skip the parameter list first: a destructured parameter (e.g.
  // `signSessionToken({ id, ... })`) contains braces that would otherwise be
  // mistaken for the function body.
  const parenStart = src.indexOf('(', start);
  let pdepth = 0;
  let paramEnd = -1;
  for (let i = parenStart; i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { paramEnd = i; break; } }
  }
  const braceStart = src.indexOf('{', paramEnd);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unterminated function ${name}`);
}

const SECRET = 'test-only-secret-not-a-real-key';
const TTL_MATCH = SERVER.match(/const SESSION_TTL = '([^']+)'/);

function makeVm() {
  const ctx = {
    jwt,
    JWT_SECRET: SECRET,
    SESSION_TTL: TTL_MATCH ? TTL_MATCH[1] : '7d',
    TokenRevocation,
    sessionRevocationStore: TokenRevocation.createMemoryStore(),
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(
    [extractFunction(SERVER, 'signSessionToken'),
     extractFunction(SERVER, 'authMiddleware'),
     extractFunction(SERVER, 'adminMiddleware')].join('\n'),
    ctx);
  return ctx;
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function callAuth(ctx, token) {
  const req = { headers: token ? { authorization: 'Bearer ' + token } : {} };
  const res = mockRes();
  let nextCalled = false;
  await ctx.authMiddleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

// ===========================================================================
// 1. Static wiring contracts
// ===========================================================================

test('server.js signs every full session through signSessionToken (jti source)', () => {
  assert.ok(SERVER.includes("require('./services/TokenRevocationService')"), 'service required');
  assert.match(SERVER, /function signSessionToken\(\{ id, email, isAdmin \}\)/);
  assert.match(SERVER, /jti: TokenRevocation\.generateJti\(\)/, 'signSessionToken must add a jti');
  assert.match(SERVER, /\{ expiresIn: SESSION_TTL \}/, 'signSessionToken must use the shared TTL');
  // Exactly the five full-session issuers use the helper; no full 7d jwt.sign
  // statement may remain (partial 2FA tokens stay 5m and are unaffected).
  const fullSigns = SERVER.match(/signSessionToken\(/g) || [];
  assert.strictEqual(fullSigns.length, 6, 'expected 1 definition + 5 call sites');
  assert.ok(!/jwt\.sign\(\s*\{[^}]*\}\s*,\s*JWT_SECRET\s*,\s*\{\s*expiresIn:\s*'7d'/.test(SERVER),
    'no full-session jwt.sign may bypass signSessionToken');
});

test('logout route exists behind authMiddleware and revokes the presented token', () => {
  assert.match(SERVER, /app\.post\('\/api\/auth\/logout',\s*authMiddleware/);
  const idx = SERVER.indexOf("app.post('/api/auth/logout'");
  const slice = SERVER.slice(idx, idx + 600);
  assert.ok(slice.includes('TokenRevocation.revokeToken(sessionRevocationStore, req.user)'),
    'logout must revoke the presented token (req.user)');
});

test('authMiddleware rejects revoked jti tokens and 2FA partial tokens', () => {
  const src = extractFunction(SERVER, 'authMiddleware');
  assert.ok(src.includes('TokenRevocation.isTokenRevoked(sessionRevocationStore, decoded.jti)'),
    'authMiddleware must consult the revocation store');
  assert.ok(src.includes('Session revoked'), 'revoked tokens must return 401');
  assert.ok(src.includes('decoded._2fa_pending'), 'partial 2FA tokens must not be full sessions');
});

test('adminMiddleware still gates admin-only routes on req.user.isAdmin', () => {
  const src = extractFunction(SERVER, 'adminMiddleware');
  assert.ok(src.includes('req.user.isAdmin'), 'admin gate intact');
  assert.ok(src.includes("'Admin required'"), 'admin 403 message intact');
});

test('frontend logout revokes the session server-side before clearing the token', () => {
  const listenerIdx = INDEX.indexOf("logoutLink.addEventListener('click'");
  const clearIdx = INDEX.indexOf("localStorage.removeItem('jwt_token')");
  assert.ok(listenerIdx > -1 && clearIdx > listenerIdx, 'logout handler region located');
  const handler = INDEX.slice(listenerIdx, clearIdx);
  assert.ok(handler.includes("fetch('/api/auth/logout'"), 'logout handler must call the endpoint');
  assert.ok(handler.includes("localStorage.getItem('jwt_token')"), 'must send the current token');
  assert.ok(handler.includes('await fetch('), 'revocation must complete before clearing locally');
});

// ===========================================================================
// 2. Migration posture (service_role only)
// ===========================================================================

test('migration 025 enables RLS and locks revoked_tokens to service_role', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS public\.revoked_tokens/);
  assert.match(MIGRATION, /ALTER TABLE public\.revoked_tokens ENABLE ROW LEVEL SECURITY/);
  const policy = MIGRATION.match(/CREATE POLICY "revoked_tokens_service_all"[\s\S]*?;/);
  assert.ok(policy && /TO service_role/.test(policy[0]), 'service-role-only policy required');
  assert.match(MIGRATION, /REVOKE ALL ON public\.revoked_tokens FROM anon, authenticated/);
});

test('revocation rows cannot outlive the token (bounded by exp)', () => {
  const now = 1_700_000_000_000;
  const expSec = Math.floor(now / 1000) + 120; // 2 minutes
  const d = TokenRevocation.expiresAtFromDecoded({ exp: expSec }, now);
  assert.strictEqual(d.getTime(), expSec * 1000, 'row expires exactly when the token does');

  // Missing/absurd exp falls back to a bounded default (never unbounded).
  const fallback = TokenRevocation.expiresAtFromDecoded({}, now);
  assert.strictEqual(fallback.getTime(), now + TokenRevocation.DEFAULT_TTL_MS);
  const negative = TokenRevocation.expiresAtFromDecoded({ exp: -1 }, now);
  assert.strictEqual(negative.getTime(), now + TokenRevocation.DEFAULT_TTL_MS);
});

// ===========================================================================
// 3. Behavior: login -> authenticated request -> logout -> replay
// ===========================================================================

test('login issues a verifiable session token carrying a unique jti', () => {
  const ctx = makeVm();
  const t1 = ctx.signSessionToken({ id: 7, email: 'a@example.com', isAdmin: false });
  const t2 = ctx.signSessionToken({ id: 7, email: 'a@example.com', isAdmin: false });
  const d1 = jwt.verify(t1, SECRET);
  assert.strictEqual(d1.id, 7);
  assert.strictEqual(d1.email, 'a@example.com');
  assert.strictEqual(d1.isAdmin, false);
  assert.ok(typeof d1.jti === 'string' && d1.jti.length > 0, 'jti present');
  assert.notStrictEqual(jwt.verify(t2, SECRET).jti, d1.jti, 'jti is unique per session');
});

test('authenticated request: a fresh token passes authMiddleware', async () => {
  const ctx = makeVm();
  const token = ctx.signSessionToken({ id: 42, email: 'u@example.com', isAdmin: false });
  const { req, res, nextCalled } = await callAuth(ctx, token);
  assert.strictEqual(nextCalled, true, 'next() must run for a valid token');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(req.user.id, 42);
});

test('logout revokes the session; replaying the old token returns 401', async () => {
  const ctx = makeVm();
  const token = ctx.signSessionToken({ id: 100, email: 'sandbox@example.com', isAdmin: false });
  const decoded = jwt.verify(token, SECRET);

  // Pre-logout the token works.
  assert.strictEqual((await callAuth(ctx, token)).nextCalled, true);

  // Logout route behavior: revoke the presented token's jti.
  const result = await TokenRevocation.revokeToken(ctx.sessionRevocationStore, decoded);
  assert.strictEqual(result.revoked, true);

  // Replay: still a valid signature/exp, but rejected server-side.
  const replay = await callAuth(ctx, token);
  assert.strictEqual(replay.nextCalled, false, 'replayed token must not pass');
  assert.strictEqual(replay.res.statusCode, 401);
  assert.strictEqual(replay.res.body.error, 'Session revoked');
});

test('logout is idempotent (double logout is not an error)', async () => {
  const ctx = makeVm();
  const decoded = jwt.verify(ctx.signSessionToken({ id: 5, email: 'x@example.com' }), SECRET);
  assert.strictEqual((await TokenRevocation.revokeToken(ctx.sessionRevocationStore, decoded)).revoked, true);
  assert.strictEqual((await TokenRevocation.revokeToken(ctx.sessionRevocationStore, decoded)).revoked, true);
});

test('expired token is rejected (401 Invalid token)', async () => {
  const ctx = makeVm();
  const expired = jwt.sign(
    { id: 9, email: 'e@example.com', isAdmin: false, jti: TokenRevocation.generateJti(), exp: Math.floor(Date.now() / 1000) - 60 },
    SECRET);
  const { res, nextCalled } = await callAuth(ctx, expired);
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.error, 'Invalid token');
});

test('a 2FA partial token cannot be used as a full session', async () => {
  const ctx = makeVm();
  const partial = jwt.sign(
    { id: 3, email: 'p@example.com', isAdmin: false, _2fa_pending: true, _2fa_type: 'email' },
    SECRET, { expiresIn: '5m' });
  const { res, nextCalled } = await callAuth(ctx, partial);
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
});

test('missing/garbage Authorization is rejected', async () => {
  const ctx = makeVm();
  const noHeader = await callAuth(ctx, null);
  assert.strictEqual(noHeader.res.statusCode, 401);
  const bogus = await callAuth(ctx, 'not-a-jwt');
  assert.strictEqual(bogus.res.statusCode, 401);
});

// ===========================================================================
// 4. Sandbox + admin access control
// ===========================================================================

test('session tokens never carry client-controlled environment (sandbox can not be spoofed)', () => {
  const ctx = makeVm();
  const decoded = jwt.verify(ctx.signSessionToken({ id: 100, email: 's@example.com', isAdmin: false }), SECRET);
  assert.ok(!('environment' in decoded), 'environment must not be a token claim');
  // Sandbox classification stays server-derived (DB read), not token-derived.
  assert.ok(SERVER.includes("ENV_MARKETING_SANDBOX") || SERVER.includes('MARKETING_SANDBOX'),
    'server-side sandbox classification intact');
  assert.ok(/user\.environment === ENV_MARKETING_SANDBOX/.test(SERVER), 'sandbox branch reads DB environment');
});

test('sandbox account token authenticates like any session; sandbox token is not admin', async () => {
  const ctx = makeVm();
  const sandboxToken = ctx.signSessionToken({ id: 100, email: 'marketing-demo@sandbox.arbitrix.invalid', isAdmin: false });
  const { nextCalled, req } = await callAuth(ctx, sandboxToken);
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(req.user.id, 100);

  const res = mockRes();
  let adminNext = false;
  ctx.adminMiddleware(req, res, () => { adminNext = true; });
  assert.strictEqual(adminNext, false, 'non-admin sandbox user must be blocked');
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.error, 'Admin required');
});

test('admin access control: only isAdmin tokens pass adminMiddleware', async () => {
  const ctx = makeVm();
  const adminToken = ctx.signSessionToken({ id: 1, email: 'admin@example.com', isAdmin: true });
  const { req } = await callAuth(ctx, adminToken);
  assert.strictEqual(req.user.isAdmin, true);

  const res = mockRes();
  let adminNext = false;
  ctx.adminMiddleware(req, res, () => { adminNext = true; });
  assert.strictEqual(adminNext, true, 'admin token must pass');

  const res2 = mockRes();
  let denied = false;
  ctx.adminMiddleware({ user: undefined }, res2, () => { denied = true; });
  assert.strictEqual(denied, false);
  assert.strictEqual(res2.statusCode, 403);
});

// ===========================================================================
// 5. Store adapters
// ===========================================================================

test('revocation store rejects a token after revoke and forgets it after expiry', async () => {
  let now = 1_000_000;
  const store = TokenRevocation.createMemoryStore(() => now);
  const jti = TokenRevocation.generateJti();
  await store.add({ jti, userId: 1, expiresAt: new Date(now + 1000) });
  assert.strictEqual(await TokenRevocation.isTokenRevoked(store, jti), true);
  assert.strictEqual(await TokenRevocation.isTokenRevoked(store, 'other-jti'), false);
  now += 2000; // past the token expiry
  assert.strictEqual(await TokenRevocation.isTokenRevoked(store, jti), false, 'expired revocation is ignored');
});

test('legacy tokens without a jti are not revocable and never falsely revoked', async () => {
  const store = TokenRevocation.createMemoryStore();
  const r = await TokenRevocation.revokeToken(store, { id: 1, email: 'a@example.com' });
  assert.deepStrictEqual(r, { revoked: false, reason: 'no_jti' });
  assert.strictEqual(await TokenRevocation.isTokenRevoked(store, undefined), false);
});

test('no store => revocation is a safe no-op (never throws)', async () => {
  const r = await TokenRevocation.revokeToken(null, { jti: 'x' });
  assert.strictEqual(r.revoked, false);
  assert.strictEqual(await TokenRevocation.isTokenRevoked(null, 'x'), false);
});

test('Supabase store builds service-role queries and propagates errors (no real DB)', async () => {
  const calls = [];
  let nextResult = { error: null };
  const fake = {
    from(table) {
      calls.push(['from', table]);
      return {
        upsert(payload, opts) { calls.push(['upsert', payload, opts]); return Promise.resolve(nextResult); },
        select(cols) { calls.push(['select', cols]); return this; },
        eq(c, v) { calls.push(['eq', c, v]); return this; },
        gt(c, v) { calls.push(['gt', c, v]); return this; },
        limit(n) { calls.push(['limit', n]); return Promise.resolve(nextResult); },
      };
    },
  };
  const store = TokenRevocation.createSupabaseStore(fake);
  const expiresAt = new Date(Date.now() + 60000);
  await store.add({ jti: 'j-1', userId: 7, expiresAt });
  const upsert = calls.find((c) => c[0] === 'upsert');
  assert.strictEqual(upsert[1].jti, 'j-1');
  assert.strictEqual(upsert[1].user_id, 7);
  assert.strictEqual(upsert[1].expires_at, expiresAt.toISOString());
  assert.strictEqual(upsert[2].onConflict, 'jti');

  nextResult = { data: [{ jti: 'j-1' }], error: null };
  assert.strictEqual(await store.has('j-1'), true);
  nextResult = { data: [], error: null };
  assert.strictEqual(await store.has('j-1'), false);

  nextResult = { data: null, error: { message: 'permission denied' } };
  await assert.rejects(() => store.has('j-1'), (e) => e && e.message === 'permission denied');
});
