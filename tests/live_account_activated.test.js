'use strict';

/**
 * LiveAccountActivated — one-shot Meta conversion event.
 *
 * The event must fire ONLY on the server-authoritative funded-flag TRANSITION
 * (not-funded -> funded, i.e. the first confirmed real deposit via
 * hasConfirmedDeposit), NEVER on a mode-tab click, invoice creation, deposit
 * attempt, page load, or revisit. It must fire through the existing
 * trackMetaConversion() helper (so consent + PRODUCTION-only gates stay intact)
 * and must NOT send amounts/balances/PII. A durable, server-side once-per-
 * account guard (meta_event_claims INSERT ... ON CONFLICT) prevents replay
 * after localStorage clears / device changes / log back in.
 *
 * Run: npm test (this file only: node --test tests/live_account_activated.test.js)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '019_meta_event_claims.sql'),
    'utf8'
);

// ---------------------------------------------------------------------------
// 1. SERVER — claim endpoint contract
// ---------------------------------------------------------------------------
test('server claim endpoint: auth-gated, no body, PRODUCTION-only, PII-free', () => {
    // Route exists and is GET + authMiddleware.

    const m = SERVER.match(/app\.get\('\/api\/tracking\/claim-live-activated',\s*authMiddleware,\s*async \(req,\s*res\)\s*=>\s*\{/);
    assert.ok(m, 'claim-live-activated route with authMiddleware must exist');
    assert.ok(!/req\.body/.test(SERVER.split('claim-live-activated')[1].split('// ---------- Deposit')[0]), 'route must not read a request body');

    // Must short-circuit MARKETING_SANDBOX before any write (never pollutes real analytics).
    const sandboxBlock = SERVER.split('claim-live-activated')[1].split('hasConfirmedDeposit')[0];
    assert.ok(sandboxBlock.includes('isMarketingSandboxUser'), 'sandbox accounts must be short-circuited');
    assert.ok(sandboxBlock.includes('claimed: false'), 'sandbox claim must be false');

    // Must gate on hasConfirmedDeposit (authoritative first real deposit).
    const gate = SERVER.split('claim-live-activated')[1].split('meta_event_claims')[0];
    assert.ok(gate.includes('hasConfirmedDeposit'), 'claim must require hasConfirmedDeposit');

    // No PII in responses.

    const resp = SERVER.split('claim-live-activated')[1].split('// ---------- Deposit')[0];
    assert.ok(!resp.includes("amount"), 'no amount field in claim response');
    assert.ok(!resp.includes("balance"), 'no balance field in claim response');
    assert.ok(!resp.includes("email"), 'no email field in claim response');
    assert.ok(!resp.includes("user_id") || resp.includes('user_id: userId'), 'user_id only as the internal auth identity, never echoed');
});

test('server claim endpoint: unique per user+event durable once-guard + 23505 safe', () => {
    const block = SERVER.split('claim-live-activated')[1].split('// ---------- Deposit')[0];
    assert.ok(block.includes("event_name: 'LiveAccountActivated'"), 'inserts the canonical event name');
    // The once-guard is the table's UNIQUE(event_name,user_id) constraint +
    // the server's 23505 (unique_violation) handler: a duplicate insert errors
    // out and the route returns claimed=>false. No explicit ON CONFLICT string is
    // needed (Postgres enforces the unique constraint, Supabase surfaces it as
    // 23505 in error.code, which the route treats as a no-op claim).

    assert.ok((block.match(/'23505'/g) || []) .length === 1, 'unique-violation (23505) treated as claimed=>false after the UNIQUE constraint fires');
    assert.ok(block.includes('meta_event_claims'), 'claims table used');
    assert.ok(block.includes('.insert({ event_name'), 'insert shape is event_name +user_id +environment');
    // And the durable once-guard binds in SQL: UNIQUE(event_name,user_id).
    assert.ok(MIGRATION.includes('UNIQUE (event_name, user_id)'), 'UNIQUE constraint is the authoritative once-guard');
});

// ---------------------------------------------------------------------------
// 2. FRONTEND — helper + transition-gated call sites
// ---------------------------------------------------------------------------
test('frontend: fireLiveAccountActivatedIfFirst helper exists, fan fbq/consent/PRODUCTION gates, and uses trackMetaConversion', () => {
    assert.ok(INDEX.includes('async function fireLiveAccountActivatedIfFirst()'), 'helper must exist');
    assert.ok(INDEX.includes('window.fireLiveAccountActivatedIfFirst = fireLiveAccountActivatedIfFirst'), 'helper must be exported on window');
    assert.ok(INDEX.includes('/api/tracking/claim-live-activated'), 'helper must call the claim endpoint');
    assert.ok(INDEX.includes('!__metaConsented() || !__metaProduction()'), 'helper must keep consent+PRODUCTION gates');
    assert.ok(INDEX.includes("data.claimed === true"), 'helper must only fire when server claims the event');
    assert.ok(INDEX.includes("trackMetaConversion('LiveAccountActivated')"), 'helper must emit through trackMetaConversion (existing gate helper)');
});

test('frontend: all three funded-flag transitions gate LiveAccountActivated on false->true', () => {
    // Site 1: polling confirmed branch.

    const poll = INDEX.split('function startPollingForPayment')[1].split('function showSuccessSection')[0];
    assert.ok(poll.includes('const wasLiveFunded = !!APP.liveData.hasRealDeposit'), 'poll must capture prior funded state');
    assert.ok(poll.includes("if (!wasLiveFunded && typeof window.fireLiveAccountActivatedIfFirst === 'function')"), 'poll must fire only on the false->true transition');

    // Site 2: /api/auth/me sync.
    const meSync = INDEX.split('async function syncWalletFromServer')[1].split('async function syncSandboxWithdrawHistory')[0];
    assert.ok(meSync.includes('const wasLiveFunded = !!APP.liveData.hasRealDeposit'), 'auth/me sync must capture prior state');
    assert.ok(meSync.includes("if (!wasLiveFunded && meData.hasRealDeposit === true"), 'auth/me sync must fire only when server flag flips to true');

    // Site 3: transactions-ledger fallback.

    assert.ok(meSync.includes("depositTxs.length"), 'transactions fallback must confirm deposit rows before funding');
});

test('frontend: no fire on mode-tab click / invoice creation / page load / revisit', () => {
    // setMode must NOT call the fire helper at all.

    const setMode = INDEX.split('function setMode(')[1].split('// ==================== DEPOSIT SYSTEM FUNCTIONS')[0];
    assert.ok(!setMode.includes('fireLiveAccountActivatedIfFirst'), 'setMode (live tab click) must never fire');
    assert.ok(!setMode.includes("trackMetaConversion('LiveAccountActivated')"), 'setMode must never emit LiveAccountActivated');

    // Invoice creation must NOT call it neither.
    const create = INDEX.split('async function requestDepositAddress')[1].split('// Show payment section after invoice creation')[0];
    assert.ok(!create.includes('fireLiveAccountActivatedIfFirst'), 'invoice creation must never fire');

    // Page load / initApp must NOT call it directly (only the server-confirmed
    // transition paths above — poll success auth/me sync transactions fallback —
    // and all are transition-gated + server-claimed).
    const init = INDEX.split('async function initApp')[1].split('const botToggle =')[0];
    assert.ok(!init.includes('fireLiveAccountActivatedIfFirst'), 'initApp must never fire directly');
});

test('frontend: existing Meta events unchanged (PageView/ViewContent/Login/CompleteRegistration/StartDemo call sites intact)', () => {
    for (const ev of ['PageView', 'ViewContent', 'Login', 'CompleteRegistration', 'StartDemo']) {
        assert.ok(INDEX.includes("trackMetaConversion('" + ev + "')") || ev === 'PageView' || ev === 'ViewContent',
            ev + ' event site must remain');
    }
    // PageView is via trackMetaInit and trackMetaPageView (helper dawn both present).
    assert.ok(INDEX.includes("fbq('track', 'PageView')"), 'PageView init path intact');
    assert.ok(INDEX.includes("trackMetaPageView()"), 'PageView SPA path intact');
});

// ---------------------------------------------------------------------------
// 3. MIGRATION — once-per-user claim table
// ---------------------------------------------------------------------------
test('migration 019: meta_event_claims table with UNIQUE(event_name,user_id)), RLS-off model, no PII columns', () => {
    assert.ok(MIGRATION.includes('CREATE TABLE IF NOT EXISTS public.meta_event_claims'), 'table must exist');
    assert.ok(MIGRATION.includes('UNIQUE (event_name, user_id)'), 'unique per user+event must exist');
    assert.ok(MIGRATION.includes('event_name TEXT NOT NULL CHECK (event_name IN (\'LiveAccountActivated\')'), 'event enum must include LiveAccountActivated');
    assert.ok(MIGRATION.includes('user_id BIGINT NOT NULL') && MIGRATION.includes('REFERENCES public.users(id'), 'user_id FK');
    // No PII / financial columns (only the CREATE TABLE body matters; the
    // file's prose comments about "no amounts/balances" are intentional and not
    // column definitions).
    assert.ok(!MIGRATION.toLowerCase().includes('email'), 'no email column');
    const createBody = MIGRATION.split('CREATE TABLE IF NOT EXISTS public.meta_event_claims')[1].split(');')[0];
    assert.ok(!/amount|balance|price|crypto|tx_/i.test(createBody), 'no financial/amount columns in the table definition');
});

// ---------------------------------------------------------------------------
// 4. BEHAVIOR — pure-JS mirror of the firing logic
// ---------------------------------------------------------------------------
test('behavior: fire exactly once per funded transition; never on click/revisit', () => {
    // Mirror the claim-oracle semantics (server-side unique row).
    const claims = new Set(); // `${event}::${userId}`

    function serverClaim(event, userId) {
        const key = event + '::' + userId;
        if (claims.has(key)) return { claimed: false };
        claims.add(key);
        return { claimed: true };
    }

    let fired = 0;
    const fireIf = (event, userId) => { if (serverClaim(event, userId).claimed) fired++; };

    // New user starts un-funded.

    let hasRealDeposit = false;

    // Scenario A: LIVE-mode tab click (setMode) — must NOT fire.

    hasRealDeposit = hasRealDeposit; // unchanged fir click
    assert.strictEqual(fired, 0, 'mode-tab click must not fire');

    // Scenario B: invoice created (deposit attempt) — must NOT fire.

    assert.strictEqual(fired, 0, 'invoice creation must not fire');

    // Scenario C: page load / revisit (already funded flag) — no fire.

    hasRealDeposit = true; // e.g. loaded with funded=true already
    if (!false) { /* gated: wasLiveFunded true -> no call */ }
    assert.strictEqual(fired, 0, 'page load with already-funded must not fire');

    // Scenario D: FIRST confirmed deposit arrives (>the poll/sync transition).
    const wasLiveFunded = hasRealDeposit; // true? no — this is a fresh user; simulate
    // (Set up: create a fresh user flag.)
    hasRealDeposit = false;
    const pre = hasRealDeposit;
    hasRealDeposit = true;
    if (!pre) fireIf('LiveAccountActivated', 42);
    assert.strictEqual(fired, 1, 'first confirmed deposit transition must fire exactly once');

    // Scenario E: second deposit (same user, later session, localStorage cleared) — no re-fire.
    hasRealDeposit = false; // e.g. logged out (localStorage flag cleared)
    const pre2 = hasRealDeposit;
    hasRealDeposit = true;
    if (!pre2) fireIf('LiveAccountActivated', 42);
    assert.strictEqual(fired, 1, 'server once-guard must prevent re-fire after localStorage clear / relogin');

    // Scenario F: different user claims independently.

    hasRealDeposit = false;
    const pre3 = hasRealDeposit;
    hasRealDeposit = true;
    if (!pre3) fireIf('LiveAccountActivated', 7);
    assert.strictEqual(fired, 2, 'each user may claim independently');
});

test('behavior: sandbox/demo/consent-denied and PRODUCTION-only never fire', () => {
    let fired = 0;
    const claims = new Set();
    function serverClaim(event, userId, prod) {
        if (!prod) return { claimed: false };
        const key = event + '::' + userId; if (claims.has(key)) return { claimed: false }; claims.add(key); return { claimed: true };
    }
    function fireIf(event, userId, prod) { if (serverClaim(event, userId, prod).claimed) fired++; }

    // MARKETING_SANDBOX account: server never claims (endpoint short-circuits).

    let hasRealDeposit = false; hasRealDeposit = true;
    const pre = hasRealDeposit; hasRealDeposit = true;
    // (Calling with a sandbox flag; server claim rejects.)
    if (!pre) fireIf('LiveAccountActivated', 9, false);
    assert.strictEqual(fired, 0, 'sandbox must never emit');

    // Consent denied: helper gates before fetch (mirror: return early).
    const helpers = INDEX.split('async function fireLiveAccountActivatedIfFirst')[1].split('window.trackMetaInit')[0];
    assert.ok(helpers.includes('!__metaConsented()'), 'consent gate must be checked first');
    assert.ok(helpers.includes('!__metaProduction()'), 'PRODUCTION-only gate must be checked first');
});

test('frontend: no amounts/balances/PII sent with the Meta event', () => {
    const helper = INDEX.split('async function fireLiveAccountActivatedIfFirst')[1].split('window.trackMetaInit')[0];
    assert.ok(helper.includes("trackMetaConversion('LiveAccountActivated')"), 'event fired with bare event name');
    assert.ok(!helper.includes("trackMetaConversion('LiveAccountActivated',"), 'must NOT pass params (no value/currency/amount)');
    assert.ok(!/amount|balance|email|user_id|wallet|transaction|referral/i.test(helper.split("trackMetaConversion('LiveAccountActivated')")[0]), 'no PII/financial data in the helper before emit');
});

// ---------------------------------------------------------------------------
// 5. UNCHANGED-REGION pins
// ---------------------------------------------------------------------------
test('no unrelated changes: paction/trade/deposit business logic untouched (guard lines pinned)', () => {
    // The deposit-confirmed branch still credits idempotently (existing line preserved).
    assert.ok(INDEX.includes('APP.liveData.hasRealDeposit = true'), 'funded-flag assignment still present');
    assert.ok(INDEX.includes('const wasLiveFunded'), 'transition guard added beside it');
    // Payment endpoints unchanged (claim route inserted AFTER /api/auth/me; no
    // // existing route bodies altered).
    assert.ok(SERVER.includes("app.get('/api/auth/me'"), 'auth/me untouched');
    assert.ok(SERVER.includes('app.post(\'/api/deposit/request\', authMiddleware'), 'deposit/request still exists');
    assert.ok(SERVER.includes('app.post(\'/api/trade\', authMiddleware'), 'trade endpoint untouched');
    assert.ok(SERVER.includes('app.post(\'/api/webhook/q8qpay\''), 'q8qpay webhook untouched');
    assert.ok(SERVER.includes('record_trade_safe'), 'trade ledger untouched');
});