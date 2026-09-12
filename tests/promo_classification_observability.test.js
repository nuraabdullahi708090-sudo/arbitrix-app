'use strict';

/**
 * Promotional-credit source-of-funds classification — observability & fail-open
 * behaviour (production-only).
 *
 * These tests EXECUTE the real server.js helpers (extracted source evaluated in
 * a vm sandbox with a mocked Supabase client), so they pin runtime behaviour —
 * not just source contracts:
 *
 *   - an UNDETERMINED conversion state is never silent: exactly one structured
 *     'promo_classification_unknown' JSON log line is emitted;
 *   - the classifier returns null (never true) for an unknown state, so the cap
 *     fails open and a referral-funded user is never wrongly capped;
 *   - a single usable authoritative read (ledger OR transactions marker) avoids
 *     the warning entirely;
 *   - the log payload contains no secrets and truncates long DB messages;
 *   - the frontend never presents an unknown classification as definitively
 *     promotional-credit funded.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function extractFunction(src, name) {
    const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
    const m = src.match(re);
    assert.ok(m, `function ${name} not found`);
    const start = m.index;
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
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error(`unterminated function ${name}`);
}

/**
 * Minimal Supabase-client mock for the exact chains the helper uses:
 *   ledger : .from('referral_earning_conversions').select('id').eq(...).limit(1)
 *   tx     : .from('transactions').select('*', {...}).eq(...).eq(...)
 */
function makeSupa({ ledgerRows = [], txCount = 0, ledgerError = null, txError = null, throwLedger = false, throwTx = false } = {}) {
    const calls = [];
    return {
        calls,
        from(table) {
            if (table === 'transactions') {
                return {
                    select() {
                        return {
                            eq() {
                                return {
                                    eq(col, val) {
                                        calls.push(['transactions', col, val]);
                                        if (throwTx) throw new Error('tx exploded');
                                        return Promise.resolve(txError ? { count: null, error: txError } : { count: txCount, error: null });
                                    }
                                };
                            }
                        };
                    }
                };
            }
            calls.push(['table', table]);
            return {
                select() { return this; },
                eq(col, val) { calls.push(['eq', col, val]); return this; },
                limit() {
                    if (throwLedger) throw new Error('ledger exploded');
                    return Promise.resolve(ledgerError ? { data: null, error: ledgerError } : { data: ledgerRows, error: null });
                }
            };
        }
    };
}

function buildSandbox(supa, warnings, { sandbox = false } = {}) {
    const ctx = {
        console: { warn: (m) => warnings.push(m), log: () => {}, error: () => {} },
        supabaseAdmin: supa,
        isMarketingSandboxUser: async () => sandbox,
    };
    vm.createContext(ctx);
    vm.runInContext(
        extractFunction(SERVER, 'logPromoClassificationUnknown') + '\n' +
        extractFunction(SERVER, 'hasConvertedReferralEarnings') + '\n' +
        extractFunction(SERVER, 'isPromoCreditFunded'),
        ctx);
    return ctx;
}

function structuredWarnings(warnings) {
    return warnings.map((w) => JSON.parse(w));
}

// ---------------------------------------------------------------------------
// hasConvertedReferralEarnings(): authoritative reads
// ---------------------------------------------------------------------------

test('a conversion ledger row => true (converted), no warning, transactions not consulted', async () => {
    const warnings = [];
    const supa = makeSupa({ ledgerRows: [{ id: 7 }] });
    const ctx = buildSandbox(supa, warnings);
    assert.strictEqual(await ctx.hasConvertedReferralEarnings(1), true);
    assert.strictEqual(warnings.length, 0, 'no warning for a successful read');
    assert.ok(!supa.calls.some((c) => c[0] === 'transactions'), 'the fallback marker must not be queried');
});

test('a readable ledger with no row => false, no warning, marker not consulted (ledger is authoritative)', async () => {
    // The append-only ledger is the authoritative record: when it is readable and
    // has no row, the user has not converted. The transactions marker is only a
    // fallback for when the ledger cannot be read (older schema / dropped table).
    const warnings = [];
    const supa = makeSupa({ ledgerRows: [], txCount: 99 });
    const ctx = buildSandbox(supa, warnings);
    assert.strictEqual(await ctx.hasConvertedReferralEarnings(1), false);
    assert.strictEqual(warnings.length, 0);
    assert.ok(!supa.calls.some((c) => c[0] === 'transactions'), 'no extra query when the ledger answered');
});

test('no ledger row and no marker => false (definitively not converted), no warning', async () => {
    const warnings = [];
    const supa = makeSupa({ ledgerRows: [], txCount: 0 });
    const ctx = buildSandbox(supa, warnings);
    assert.strictEqual(await ctx.hasConvertedReferralEarnings(1), false);
    assert.strictEqual(warnings.length, 0);
});

test('ledger read fails but the transactions marker succeeds => boolean, no warning (fallback worked)', async () => {
    const warnings = [];
    const supa = makeSupa({ ledgerError: { code: '42P01', message: 'relation does not exist' }, txCount: 1 });
    const ctx = buildSandbox(supa, warnings);
    assert.strictEqual(await ctx.hasConvertedReferralEarnings(1), true);
    assert.strictEqual(warnings.length, 0, 'a working fallback is not an unknown state');
});

// ---------------------------------------------------------------------------
// Both reads fail => null + ONE structured, non-secret diagnostic
// ---------------------------------------------------------------------------

test('BOTH reads fail (PostgREST errors) => null AND exactly one structured warning', async () => {
    const warnings = [];
    const supa = makeSupa({
        ledgerError: { code: '42P01', message: 'relation "referral_earning_conversions" does not exist' },
        txError: { code: '57014', message: 'canceling statement due to statement timeout' },
    });
    const ctx = buildSandbox(supa, warnings);
    const result = await ctx.hasConvertedReferralEarnings(42);
    assert.strictEqual(result, null, 'an unknown state must be null, never true/false');
    assert.strictEqual(warnings.length, 1, 'exactly one structured log line per unknown state');

    const [payload] = structuredWarnings(warnings);
    assert.strictEqual(payload.event, 'promo_classification_unknown');
    assert.strictEqual(payload.severity, 'warning');
    assert.strictEqual(payload.component, 'hasConvertedReferralEarnings');
    assert.strictEqual(payload.fallback, 'treat_as_not_promo_credit');
    assert.strictEqual(payload.impact, 'production_promo_cap_not_enforced_for_this_request');
    assert.strictEqual(payload.userId, 42);
    assert.strictEqual(payload.ledgerFailed, true);
    assert.strictEqual(payload.transactionsFailed, true);
    assert.strictEqual(payload.ledgerErrorCode, '42P01');
    assert.strictEqual(payload.transactionsErrorCode, '57014');
    assert.match(payload.ledgerErrorMessage, /does not exist/);
});

test('BOTH reads throw exceptions => null AND a structured warning (exception codes)', async () => {
    const warnings = [];
    const supa = makeSupa({ throwLedger: true, throwTx: true });
    const ctx = buildSandbox(supa, warnings);
    assert.strictEqual(await ctx.hasConvertedReferralEarnings(9), null);
    assert.strictEqual(warnings.length, 1);
    const [payload] = structuredWarnings(warnings);
    assert.strictEqual(payload.ledgerErrorCode, 'exception');
    assert.strictEqual(payload.transactionsErrorCode, 'exception');
    assert.match(payload.ledgerErrorMessage, /ledger exploded/);
    assert.match(payload.transactionsErrorMessage, /tx exploded/);
});

test('the structured log never carries secrets/credentials and truncates long messages', async () => {
    const warnings = [];
    const longMessage = 'x'.repeat(5000);
    const supa = makeSupa({
        ledgerError: { code: 'X', message: 'password=hunter2 token=abc' },
        txError: { code: 'Y', message: longMessage },
    });
    const ctx = buildSandbox(supa, warnings);
    await ctx.hasConvertedReferralEarnings(3);
    const raw = warnings[0];
    const payload = JSON.parse(raw);
    // Long DB messages are bounded (defence against log flooding).
    assert.ok(payload.ledgerErrorMessage.length <= 200);
    assert.ok(payload.transactionsErrorMessage.length <= 200);
    // Only the whitelisted fields are emitted.
    const allowed = new Set(['event', 'severity', 'component', 'fallback', 'impact', 'userId',
        'ledgerFailed', 'transactionsFailed', 'ledgerErrorCode', 'ledgerErrorMessage',
        'transactionsErrorCode', 'transactionsErrorMessage']);
    for (const k of Object.keys(payload)) assert.ok(allowed.has(k), `unexpected log field: ${k}`);
    // No credential-shaped fields are ever added by the logger itself.
    assert.ok(!/authorization|cookie|jwt_token|api[_-]?key/i.test(Object.keys(payload).join(',')));
});

// ---------------------------------------------------------------------------
// isPromoCreditFunded(): tri-state
// ---------------------------------------------------------------------------

test('isPromoCreditFunded returns NULL (never true) when the conversion state is unknown', async () => {
    const warnings = [];
    const supa = makeSupa({ throwLedger: true, throwTx: true });
    const ctx = buildSandbox(supa, warnings);
    const result = await ctx.isPromoCreditFunded(5, false);
    assert.strictEqual(result, null, 'unknown must be null so callers fail open');
    assert.notStrictEqual(result, true, 'unknown must never be reported as promo-funded');
    assert.strictEqual(warnings.length, 1);
});

test('isPromoCreditFunded: referral conversion => false; no conversion => true', async () => {
    const w1 = [];
    const converted = buildSandbox(makeSupa({ ledgerRows: [{ id: 1 }] }), w1);
    assert.strictEqual(await converted.isPromoCreditFunded(1, false), false);

    const w2 = [];
    const fresh = buildSandbox(makeSupa({ ledgerRows: [], txCount: 0 }), w2);
    assert.strictEqual(await fresh.isPromoCreditFunded(1, false), true);
});

test('isPromoCreditFunded: a confirmed deposit short-circuits with no reads', async () => {
    const warnings = [];
    const supa = makeSupa({ ledgerRows: [{ id: 1 }] });
    const ctx = buildSandbox(supa, warnings);
    assert.strictEqual(await ctx.isPromoCreditFunded(1, true), false);
    assert.strictEqual(supa.calls.length, 0, 'deposited users must not trigger conversion reads');
});

test('isPromoCreditFunded: sandbox short-circuits with no reads', async () => {
    const warnings = [];
    const supa = makeSupa({ ledgerRows: [{ id: 1 }] });
    const ctx = buildSandbox(supa, warnings, { sandbox: true });
    assert.strictEqual(await ctx.isPromoCreditFunded(1, false), false);
    assert.strictEqual(supa.calls.length, 0, 'sandbox accounts must not trigger conversion reads');
});

// ---------------------------------------------------------------------------
// API surface + frontend: unknown is never presented as promo-funded
// ---------------------------------------------------------------------------

test('/api/auth/me reports the unknown flag and coerces the boolean', () => {
    const marker = "app.get('/api/auth/me'";
    const start = SERVER.indexOf(marker);
    assert.ok(start > 0, 'route not found');
    let end = SERVER.indexOf('\napp.', start + marker.length);
    const body = SERVER.slice(start, end < 0 ? undefined : end);
    assert.match(body, /const promoClassificationUnknown = promoFunding === null/);
    assert.match(body, /promoCreditFunded = promoFunding === true/);
    assert.match(body, /promoCreditFunded,/);
    assert.match(body, /promoClassificationUnknown,/);
    assert.match(body, /promoClassificationUnknown: false/, 'sandbox is definitively exempt');
});

test('/api/trade reports promoClassificationUnknown in its response', () => {
    const start = SERVER.indexOf("app.post('/api/trade'");
    const end = SERVER.indexOf('\napp.', start + 10);
    const body = SERVER.slice(start, end < 0 ? undefined : end);
    assert.match(body, /promoClassificationUnknown: promoCreditFunded === null/);
});

test('frontend: unknown classification is adopted as NOT promo-funded and the notice stays hidden', () => {
    const logicStart = INDEX.indexOf('promoClassificationUnknown === true');
    assert.ok(logicStart > 0, 'unknown-state handling missing from the frontend sync');
    const logic = INDEX.slice(logicStart, logicStart + 500);
    assert.match(logic, /APP\.liveData\.promoCreditFunded = false/, 'unknown must force promoCreditFunded=false');

    const noticeStart = INDEX.indexOf('const showPromoNotice');
    assert.ok(noticeStart > 0, 'promo notice logic missing');
    const notice = INDEX.slice(noticeStart, noticeStart + 400);
    assert.match(notice, /APP\.liveData\.promoCreditFunded === true/, 'only a definitive classification shows the promo notice');
    assert.match(notice, /promoClassificationUnknown !== true/, 'an unknown state must never show the promo notice');

    // Defaults exist so a stale/absent server field can never render as promo.
    assert.match(INDEX, /promoCreditFunded: false, promoClassificationUnknown: false/);
    assert.match(INDEX, /promoCreditFunded:false,promoClassificationUnknown:false\}, JSON\.parse\(live\)\)/);
});
