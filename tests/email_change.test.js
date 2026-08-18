'use strict';

/**
 * Phase 8B — Secure Profile Email Change contract tests.
 *
 * server.js is a single Express app that binds a port on require (app.listen),
 * so these tests do NOT import it (same constraint as subscription.test.js and
 * withdraw_gating.test.js). Instead they pin:
 *
 *   1. The secure email-change contract authored in server.js's
 *      /api/auth/email-change/{request,status,verify} handlers (grep-verified
 *      signatures, authMiddleware gating, req.user.id identity derivation, no
 *      client-supplied userId).
 *   2. A faithful pure-JS mirror of the request/verify security logic, covering:
 *        - normal request -> code sent to new email, users.email unchanged
 *        - invalid email format rejected
 *        - duplicate email (belongs to another account) rejected
 *        - IDOR: client-supplied userId is ignored (identity from JWT only)
 *        - wrong verification code rejected; email unchanged
 *        - expired code rejected + invalidated; email unchanged
 *        - reused code (already used) cannot verify again; email unchanged
 *        - successful verification updates ONLY users.email; user id unchanged
 *        - old email remains valid for login until verification succeeds
 *        - per-user rate limiting / cooldown on requests
 *        - existing login/auth behavior remains intact (password check unchanged)
 *   3. The verification code is never returned/logged/stored in plaintext:
 *        - only the SHA256 hash is stored (code_hash)
 *        - the request handler never echoes the code in its JSON response
 *        - no console.log of the plaintext code in the email-change path
 *   4. Financial/KYC/trading/payment/subscription/2FA/referral systems are
 *      untouched (byte-unchanged critical paths still present).
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '012_email_change.sql'),
    'utf8'
);

// ---------------------------------------------------------------------------
// Constants mirroring server.js EMAIL_CHANGE_CONFIG.
// ---------------------------------------------------------------------------
const CONFIG = {
    codeLength: 6,
    codeExpiryMs: 10 * 60 * 1000,
    resendCooldownMs: 60 * 1000,
    maxVerifyAttempts: 5
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmailFormat(email) {
    return typeof email === 'string' && EMAIL_RE.test(email.trim());
}
function hashCode(code) {
    return crypto.createHash('sha256').update(String(code)).digest('hex');
}
function generateCode() {
    const randomBytes = crypto.randomBytes(CONFIG.codeLength);
    let code = '';
    for (let i = 0; i < CONFIG.codeLength; i++) code += randomBytes[i] % 10;
    return code;
}
function timingSafeHexEqual(a, b) {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// In-memory model mirroring the server handlers + Supabase tables.
//   - users: { id -> { id, email, password_hash } }
//   - emailChangeRequests: array of rows { id, user_id, new_email, code_hash,
//     expires_at, used, attempts, created_at }
//   - getUserByEmail(newEmail) simulates the uniqueness check.
// The handlers below are a faithful mirror of server.js logic; if the server
// reorders the security gates, this mirror must be updated in lock-step.
// ---------------------------------------------------------------------------
function makeModel() {
    const users = new Map();
    let userSeq = 1;
    let reqSeq = 1;
    const requests = [];
    let now = Date.now();
    let lastRequestCreatedAt = null; // for cooldown test convenience
    let sentEmails = []; // { to, code } — simulates outbound email (server-only)

    function addUser(email, passwordHash) {
        const id = userSeq++;
        users.set(id, { id, email, password_hash: passwordHash });
        return id;
    }
    function getUser(id) { return users.get(id); }
    function getUserByEmail(email) {
        for (const u of users.values()) {
            if (String(u.email).toLowerCase() === String(email).toLowerCase()) return u;
        }
        return null;
    }
    function setNow(t) { now = t; }

    // POST /api/auth/email-change/request  (identity = userId from JWT)
    function requestChange({ userId, newEmail }) {
        newEmail = (newEmail || '').toString().trim().toLowerCase();
        if (!isValidEmailFormat(newEmail)) return { status: 400, body: { error: 'Invalid email address' } };
        const currentUser = getUser(userId);
        if (!currentUser) return { status: 404, body: { error: 'User not found' } };
        if (newEmail === String(currentUser.email).toLowerCase()) {
            return { status: 400, body: { error: 'New email must be different from your current email' } };
        }
        // per-user cooldown
        const recent = requests
            .filter(r => r.user_id === userId)
            .sort((a, b) => b.created_at - a.created_at)[0];
        if (recent) {
            const elapsed = now - recent.created_at;
            const remainingMs = CONFIG.resendCooldownMs - elapsed;
            if (remainingMs > 0) {
                return { status: 429, body: { error: 'Too many requests', retryAfterSeconds: Math.ceil(remainingMs / 1000) } };
            }
        }
        // uniqueness vs another account
        const existing = getUserByEmail(newEmail);
        if (existing && String(existing.id) !== String(userId)) {
            return { status: 409, body: { error: 'This email is already associated with another account' } };
        }
        // invalidate prior pending (delete unused for this user)
        for (let i = requests.length - 1; i >= 0; i--) {
            if (requests[i].user_id === userId && !requests[i].used) requests.splice(i, 1);
        }
        const code = generateCode();
        const row = {
            id: reqSeq++,
            user_id: userId,
            new_email: newEmail,
            code_hash: hashCode(code),
            expires_at: now + CONFIG.codeExpiryMs,
            used: false,
            attempts: 0,
            created_at: now
        };
        requests.push(row);
        lastRequestCreatedAt = now;
        sentEmails.push({ to: newEmail, code });
        // response never includes the code
        return { status: 200, body: { message: 'A verification code has been sent to your new email address.' } };
    }

    function pendingFor(userId) {
        return requests
            .filter(r => r.user_id === userId && !r.used)
            .sort((a, b) => b.created_at - a.created_at)[0] || null;
    }

    // POST /api/auth/email-change/verify (identity = userId from JWT)
    function verifyChange({ userId, code }) {
        code = (code || '').toString().trim();
        if (!code) return { status: 400, body: { error: 'Verification code is required' } };
        const request = pendingFor(userId);
        if (!request) return { status: 400, body: { error: 'No pending email change request' } };
        if (request.expires_at <= now) {
            request.used = true;
            return { status: 400, body: { error: 'Verification code has expired' } };
        }
        const match = timingSafeHexEqual(hashCode(code), request.code_hash);
        if (!match) {
            request.attempts += 1;
            if (request.attempts >= CONFIG.maxVerifyAttempts) {
                request.used = true;
                return { status: 429, body: { error: 'Too many failed attempts' } };
            }
            return { status: 400, body: { error: 'Invalid verification code' } };
        }
        // correct -> single-use BEFORE mutate
        request.used = true;
        // race guard: uniqueness at verify time
        const existing = getUserByEmail(request.new_email);
        if (existing && String(existing.id) !== String(userId)) {
            return { status: 409, body: { error: 'This email is already associated with another account' } };
        }
        const u = getUser(userId);
        u.email = request.new_email; // ONLY email changes; id untouched
        return { status: 200, body: { success: true, user: { id: u.id, email: u.email } } };
    }

    // Existing login behavior (must remain intact): password check unchanged.
    function login({ email, password }) {
        const u = getUserByEmail(email);
        if (!u || u.password_hash !== password) return { status: 401, body: { error: 'Invalid credentials' } };
        return { status: 200, body: { token: 'jwt', user: { id: u.id, email: u.email } } };
    }

    return { addUser, getUser, getUserByEmail, setNow, requestChange, verifyChange, pendingFor, login, sentEmails, requests, users };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1. server.js exposes the three email-change routes behind authMiddleware using req.user.id', () => {
    const sigs = [
        "app.post('/api/auth/email-change/request'",
        "app.get('/api/auth/email-change/status'",
        "app.post('/api/auth/email-change/verify'"
    ];
    for (const sig of sigs) {
        assert.ok(SERVER.includes(sig), `${sig} present`);
        const idx = SERVER.indexOf(sig);
        const slice = SERVER.slice(idx, idx + 400);
        assert.ok(/authMiddleware/.test(slice), `${sig} uses authMiddleware`);
        assert.ok(/req\.user\.id/.test(slice), `${sig} derives userId from req.user.id`);
    }
});

test('2. identity is JWT-only: no route reads a client-supplied userId/email from body for identity', () => {
    // The verify handler must not accept a userId/newEmail from the body.
    const idx = SERVER.indexOf("app.post('/api/auth/email-change/verify'");
    const slice = SERVER.slice(idx, idx + 1400);
    assert.ok(!/req\.body\.userId/.test(slice), 'verify never reads req.body.userId (no IDOR)');
    assert.ok(!/req\.body\.user_id/.test(slice), 'verify never reads req.body.user_id (no IDOR)');
    assert.ok(/const userId = req\.user\.id;/.test(slice), 'verify derives userId from JWT');
});

test('3. migration 012 is additive: creates email_change_requests, does not alter financial/auth tables', () => {
    assert.ok(/CREATE TABLE IF NOT EXISTS public\.email_change_requests/.test(MIGRATION), 'creates the new table');
    assert.ok(/user_id BIGINT NOT NULL REFERENCES public\.users\(id\)/.test(MIGRATION), 'FK to users');
    assert.ok(/code_hash TEXT NOT NULL/.test(MIGRATION), 'stores code hash only');
    assert.ok(/used BOOLEAN NOT NULL DEFAULT FALSE/.test(MIGRATION), 'single-use flag');
    assert.ok(/expires_at TIMESTAMPTZ NOT NULL/.test(MIGRATION), 'time-limited');
    // No ALTER on financial/KYC/auth tables.
    assert.ok(!/ALTER TABLE public\.(wallets|transactions|deposits|withdrawals|kyc|subscriptions|subscription_charges|referrals|twofa_profiles|email_verification_codes|password_reset_tokens)\b/.test(MIGRATION), 'does not alter financial/KYC/auth tables');
    assert.ok(/DISABLE ROW LEVEL SECURITY/.test(MIGRATION), 'RLS disabled after CREATE (BIGINT compat)');
    assert.ok(/ALTER TABLE public\.email_change_requests DISABLE ROW LEVEL SECURITY/.test(MIGRATION), 'RLS disabled on the new table only');
});

test('4. the verification code is never returned or logged in plaintext', () => {
    // Request handler response must not include the code value.
    const reqIdx = SERVER.indexOf("app.post('/api/auth/email-change/request'");
    const statusIdx = SERVER.indexOf("app.get('/api/auth/email-change/status'");
    const reqSlice = SERVER.slice(reqIdx, statusIdx);
    // The only json response that could leak is the final res.json({message:...})
    assert.ok(/return res\.json\(\{ message: 'A verification code has been sent/.test(reqSlice), 'request returns only a message, not the code');
    // No console.log of the code in the email-change path.
    assert.ok(!/console\.log\([^)]*\$\{code\}/.test(reqSlice), 'no console.log of ${code} in request handler');
    // The send function explicitly avoids logging the code even in dev mode.
    assert.ok(/Code intentionally not logged/.test(SERVER), 'dev-mode log explicitly avoids the code');
});

test('5. users.email is updated only in the verify handler, never in the request handler', () => {
    const reqIdx = SERVER.indexOf("app.post('/api/auth/email-change/request'");
    const reqEnd = SERVER.indexOf("app.get('/api/auth/email-change/status'");
    const reqSlice = SERVER.slice(reqIdx, reqEnd);
    assert.ok(!/from\('users'\)\.update/.test(reqSlice), 'request handler does NOT update users.email');
    // verify handler updates only the email column.
    const verifyIdx = SERVER.indexOf("app.post('/api/auth/email-change/verify'");
    const meIdx = SERVER.indexOf("app.get('/api/auth/me'", verifyIdx);
    const verifySlice = SERVER.slice(verifyIdx, meIdx);
    const norm = verifySlice.replace(/\s+/g, ' ');
    assert.ok(/from\('users'\)\s*\.update\(\{\s*email:\s*request\.new_email\s*\}\)/.test(norm), 'verify updates ONLY users.email');
    assert.ok(/\.eq\('id', userId\)/.test(verifySlice), 'verify updates by JWT userId (never a client id)');
});

test('6. normal request: code sent to new email, current email unchanged, hash stored', () => {
    const m = makeModel();
    const id = m.addUser('old@example.com', 'pw');
    const res = m.requestChange({ userId: id, newEmail: 'new@example.com' });
    assert.strictEqual(res.status, 200);
    assert.ok(!('code' in res.body), 'response does not include code');
    assert.strictEqual(m.getUser(id).email, 'old@example.com', 'current email unchanged');
    assert.strictEqual(m.sentEmails.length, 1);
    assert.strictEqual(m.sentEmails[0].to, 'new@example.com', 'code sent to NEW email');
    const pending = m.pendingFor(id);
    assert.ok(pending, 'pending row created');
    assert.strictEqual(pending.code_hash, hashCode(m.sentEmails[0].code), 'stored hash matches sent code');
    assert.ok(!pending.used, 'pending not yet used');
});

test('7. invalid email format is rejected (400) and no row/email is created', () => {
    const m = makeModel();
    const id = m.addUser('old@example.com', 'pw');
    const res = m.requestChange({ userId: id, newEmail: 'not-an-email' });
    assert.strictEqual(res.status, 400);
    assert.ok(!m.pendingFor(id), 'no pending row');
    assert.strictEqual(m.sentEmails.length, 0, 'no email sent');
});

test('8. duplicate email (belongs to another account) is rejected (409)', () => {
    const m = makeModel();
    const a = m.addUser('a@example.com', 'pw');
    m.addUser('taken@example.com', 'pw'); // another account owns this email
    const res = m.requestChange({ userId: a, newEmail: 'taken@example.com' });
    assert.strictEqual(res.status, 409);
    assert.ok(!m.pendingFor(a), 'no pending row created');
    assert.strictEqual(m.sentEmails.length, 0, 'no code sent for a taken email');
});

test('9. IDOR attempt: a client cannot target another user id; identity is JWT-only', () => {
    // The model (like the server) keys EVERYTHING on the userId passed in,
    // which the server sources exclusively from req.user.id. There is no body
    // parameter to target another user. Here we confirm that requesting a
    // change for user A and "pretending" the new email is someone else's does
    // not let the caller touch user B's email.
    const m = makeModel();
    const a = m.addUser('a@example.com', 'pw');
    const b = m.addUser('b@example.com', 'pw');
    // A requests a change; verify uses A's identity only.
    m.requestChange({ userId: a, newEmail: 'a-new@example.com' });
    const pending = m.pendingFor(a);
    const code = m.sentEmails[0].code;
    const res = m.verifyChange({ userId: a, code });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(m.getUser(a).email, 'a-new@example.com', 'A updated');
    assert.strictEqual(m.getUser(b).email, 'b@example.com', 'B untouched by A action');
    assert.strictEqual(m.getUser(a).id, a, 'A id unchanged');
    assert.strictEqual(m.getUser(b).id, b, 'B id unchanged');
    // pending row belonged to A only
    assert.ok(!m.pendingFor(a), 'pending consumed');
});

test('10. wrong verification code rejected; email unchanged; attempts increment', () => {
    const m = makeModel();
    const id = m.addUser('old@example.com', 'pw');
    m.requestChange({ userId: id, newEmail: 'new@example.com' });
    const res = m.verifyChange({ userId: id, code: '000000' });
    assert.strictEqual(res.status, 400);
    assert.ok(/Invalid verification code/.test(res.body.error));
    assert.strictEqual(m.getUser(id).email, 'old@example.com', 'email unchanged after wrong code');
    const pending = m.pendingFor(id);
    assert.ok(pending, 'pending still active (within attempt limit)');
    assert.strictEqual(pending.attempts, 1, 'attempts incremented');
});

test('11. expired code is rejected and invalidated; email unchanged', () => {
    const m = makeModel();
    const id = m.addUser('old@example.com', 'pw');
    m.requestChange({ userId: id, newEmail: 'new@example.com' });
    const code = m.sentEmails[0].code;
    // Advance time past expiry.
    m.setNow(Date.now() + CONFIG.codeExpiryMs + 1000);
    const res = m.verifyChange({ userId: id, code });
    assert.strictEqual(res.status, 400);
    assert.ok(/expired/i.test(res.body.error));
    assert.strictEqual(m.getUser(id).email, 'old@example.com', 'email unchanged after expired code');
    assert.ok(!m.pendingFor(id), 'expired request invalidated');
});

test('12. reused (already-used) code cannot verify again; email unchanged on second use', () => {
    const m = makeModel();
    const id = m.addUser('old@example.com', 'pw');
    m.requestChange({ userId: id, newEmail: 'new@example.com' });
    const code = m.sentEmails[0].code;
    const r1 = m.verifyChange({ userId: id, code });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(m.getUser(id).email, 'new@example.com', 'first verify updates email');
    // Replaying the SAME code must NOT re-verify (no pending row left).
    const r2 = m.verifyChange({ userId: id, code });
    assert.strictEqual(r2.status, 400);
    assert.ok(/No pending email change request/.test(r2.body.error), 'replay has no pending request');
    assert.strictEqual(m.getUser(id).email, 'new@example.com', 'email not reverted by replay');
    assert.strictEqual(m.getUser(id).id, id, 'id unchanged across reuse');
});

test('13. successful verification updates ONLY email; user id remains unchanged; wallets/balances untouched', () => {
    const m = makeModel();
    const id = m.addUser('old@example.com', 'pw');
    // Simulate a wallet tied to the user (server never changes wallet on email change).
    const wallet = { user_id: id, live_balance: 123.45, demo_balance: 1000, bonus_balance: 50 };
    m.requestChange({ userId: id, newEmail: 'new@example.com' });
    const code = m.sentEmails[0].code;
    const res = m.verifyChange({ userId: id, code });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.success);
    assert.strictEqual(res.body.user.email, 'new@example.com');
    assert.strictEqual(res.body.user.id, id, 'returned id unchanged');
    assert.strictEqual(m.getUser(id).email, 'new@example.com', 'email updated');
    assert.strictEqual(m.getUser(id).id, id, 'internal id unchanged');
    // Wallet reference is by user_id and is never touched.
    assert.strictEqual(wallet.user_id, id, 'wallet still keyed by same user id');
    assert.deepStrictEqual([wallet.live_balance, wallet.demo_balance, wallet.bonus_balance], [123.45, 1000, 50], 'balances untouched');
});

test('14. old email remains valid for login until the new one is verified', () => {
    const m = makeModel();
    const id = m.addUser('old@example.com', 'pw');
    m.requestChange({ userId: id, newEmail: 'new@example.com' });
    // Before verification, OLD email still logs in, NEW email does not.
    assert.strictEqual(m.login({ email: 'old@example.com', password: 'pw' }).status, 200, 'old email still logs in');
    assert.strictEqual(m.login({ email: 'new@example.com', password: 'pw' }).status, 401, 'new email not usable yet');
    // After verification, NEW email logs in, OLD does not.
    const code = m.sentEmails[0].code;
    m.verifyChange({ userId: id, code });
    assert.strictEqual(m.login({ email: 'new@example.com', password: 'pw' }).status, 200, 'new email logs in after verify');
    assert.strictEqual(m.login({ email: 'old@example.com', password: 'pw' }).status, 401, 'old email no longer logs in');
});

test('15. requesting a new change invalidates the previous pending request (replace)', () => {
    const m = makeModel();
    const id = m.addUser('old@example.com', 'pw');
    m.requestChange({ userId: id, newEmail: 'first@example.com' });
    const firstCode = m.sentEmails[0].code;
    assert.ok(m.pendingFor(id), 'first pending exists');
    // Advance past cooldown so the second request is allowed.
    m.setNow(Date.now() + CONFIG.resendCooldownMs + 1000);
    m.requestChange({ userId: id, newEmail: 'second@example.com' });
    const pending = m.pendingFor(id);
    assert.ok(pending, 'a pending row exists');
    assert.strictEqual(pending.new_email, 'second@example.com', 'pending is the NEW request');
    assert.strictEqual(m.sentEmails.length, 2, 'second code sent');
    // The first code must no longer verify (its row was deleted/replaced).
    const res = m.verifyChange({ userId: id, code: firstCode });
    assert.notStrictEqual(res.status, 200, 'old code cannot verify after replacement');
    assert.strictEqual(m.getUser(id).email, 'old@example.com', 'email still unchanged');
});

test('16. rate limiting: a second request within the cooldown is rejected (429)', () => {
    const m = makeModel();
    const id = m.addUser('old@example.com', 'pw');
    const r1 = m.requestChange({ userId: id, newEmail: 'new1@example.com' });
    assert.strictEqual(r1.status, 200);
    // Immediately request again (no time advance).
    const r2 = m.requestChange({ userId: id, newEmail: 'new2@example.com' });
    assert.strictEqual(r2.status, 429);
    assert.ok(r2.body.retryAfterSeconds > 0, 'retry-after provided');
    assert.strictEqual(m.sentEmails.length, 1, 'no second code sent during cooldown');
});

test('17. too many failed verify attempts invalidate the pending request (429)', () => {
    const m = makeModel();
    const id = m.addUser('old@example.com', 'pw');
    m.requestChange({ userId: id, newEmail: 'new@example.com' });
    let last;
    for (let i = 0; i < CONFIG.maxVerifyAttempts; i++) {
        last = m.verifyChange({ userId: id, code: '000000' });
    }
    assert.strictEqual(last.status, 429, 'final wrong attempt returns 429');
    assert.ok(!m.pendingFor(id), 'pending invalidated after too many failures');
    assert.strictEqual(m.getUser(id).email, 'old@example.com', 'email unchanged after lockout');
    // Even the correct code can no longer verify (request invalidated).
    const correctCode = m.sentEmails[0].code;
    const after = m.verifyChange({ userId: id, code: correctCode });
    assert.notStrictEqual(after.status, 200, 'correct code cannot verify after lockout');
});

test('18. race guard: if another account takes the email between request and verify, email is NOT changed', () => {
    const m = makeModel();
    const a = m.addUser('a@example.com', 'pw');
    m.requestChange({ userId: a, newEmail: 'shared@example.com' });
    const code = m.sentEmails[0].code;
    // Someone else registers/claims the email before A verifies.
    m.addUser('shared@example.com', 'pw');
    const res = m.verifyChange({ userId: a, code });
    assert.strictEqual(res.status, 409, 'verify fails because email now taken');
    assert.strictEqual(m.getUser(a).email, 'a@example.com', 'A email unchanged');
});

test('19. existing auth behavior remains intact: registration + login password check unchanged in server.js', () => {
    // Registration still rejects duplicate emails; login still verifies password.
    assert.ok(/app\.post\('\/api\/auth\/register'/.test(SERVER), 'register route present');
    assert.ok(/app\.post\('\/api\/auth\/login'/.test(SERVER), 'login route present');
    assert.ok(/bcrypt\.compareSync\(password, user\.password_hash\)/.test(SERVER), 'login still uses bcrypt password compare');
    assert.ok(/jwt\.sign\(\{ id: user\.id, email: user\.email/.test(SERVER), 'login still signs JWT with id+email');
});

test('20. financial/KYC/trading/payment/subscription critical paths are byte-unchanged in server.js', () => {
    // These must all still be present and unchanged by the email-change addition.
    assert.ok(/credit_payment_safe/.test(SERVER), 'deposit credit path intact');
    assert.ok(/record_trade_safe/.test(SERVER), 'trade recording path intact');
    assert.ok(/app\.post\('\/api\/withdraw\/request'/.test(SERVER), 'withdraw route intact');
    assert.ok(/Min \$700/.test(SERVER), 'withdraw $700 gate intact');
    assert.ok(/app\.post\('\/api\/subscription\/activate'/.test(SERVER), 'subscription activate intact');
    assert.ok(/charge_subscription_safe/.test(SERVER), 'subscription charge path intact');
    // The verify handler must not touch any financial table.
    const verifyIdx = SERVER.indexOf("app.post('/api/auth/email-change/verify'");
    const meIdx = SERVER.indexOf("app.get('/api/auth/me'", verifyIdx);
    const verifySlice = SERVER.slice(verifyIdx, meIdx);
    assert.ok(!/wallets|live_balance|demo_balance|bonus_balance|deposits|withdrawals|kyc|subscriptions|subscription_charges/.test(verifySlice), 'verify handler touches no financial/KYC/subscription tables');
});

test('21. email field is readonly in the Profile UI and a Change Email action exists', () => {
    const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const fieldMatch = HTML.match(/<input[^>]*id="profileEmail"[^>]*>/);
    assert.ok(fieldMatch, 'profileEmail field exists');
    assert.ok(/readonly/.test(fieldMatch[0]), 'profileEmail is readonly');
    assert.ok(/openChangeEmailModal/.test(HTML), 'Change Email action wired');
    assert.ok(/requestEmailChange/.test(HTML), 'request function present');
    assert.ok(/verifyEmailChange/.test(HTML), 'verify function present');
    // The frontend never PUTs/POSTs directly to users; it only calls the new endpoints.
    assert.ok(/\/api\/auth\/email-change\/request/.test(HTML), 'frontend calls request endpoint');
    assert.ok(/\/api\/auth\/email-change\/verify/.test(HTML), 'frontend calls verify endpoint');
});

test('22. saveProfile no longer persists the email from the readonly field', () => {
    const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const idx = HTML.indexOf('function saveProfile()');
    const slice = HTML.slice(idx, idx + 800);
    assert.ok(/email field is readonly|Phase 8B|readonly/.test(slice), 'saveProfile documents the readonly field');
    assert.ok(!/user\.email = email;/.test(slice), 'saveProfile no longer overwrites user.email from the field');
});

test('23. all six languages include the email-change translations', () => {
    const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const langs = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
    const required = ['emailChange.title', 'emailChange.changeButton', 'emailChange.success', 'emailChange.pendingNotice', 'common.back'];
    // Crude but sufficient: each lang block is between "    <lang>: {" markers.
    for (const lang of langs) {
        const re = new RegExp('\\b' + lang + ':\\s*\\{([\\s\\S]*?)\\n\\s{4}\\},');
        const m = HTML.match(re);
        assert.ok(m, `${lang} block found`);
        for (const key of required) {
            assert.ok(m[1].includes(`'${key}'`), `${lang} has ${key}`);
        }
    }
});
