'use strict';

/**
 * Referral Partner payout audit fix: a payout may NOT be marked PAID without a
 * non-empty payment transaction reference.
 *
 * Enforced at THREE layers and pinned here:
 *   1. ADMIN UI  (public/index.html recordReferralPayoutPayment +
 *      updateReferralPayout) - trim + reject empty/whitespace with a clear,
 *      localized message.
 *   2. SERVER    (server.js PUT /api/admin/referral/payouts/:id) - independently
 *      rejects null/undefined/''/whitespace for a PAID transition, trims before
 *      storing, accepts any non-empty format.
 *   3. DATABASE  (migration 037, re-creating update_referral_payout_safe) - the
 *      row-locked RPC refuses a PAID transition without a reference
 *      ('tx_reference_required'), so the invariant holds even if the API is
 *      bypassed.
 *
 * Static/source pins plus pure-logic mirrors of the route + RPC. No network,
 * no database.
 *
 * Business rules are NOT changed and are re-pinned at the bottom.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const MIG034 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '034_referral_payouts.sql'), 'utf8');
const MIG037 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '037_referral_payout_paid_requires_reference.sql'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function sliceBetween(text, a, b) {
    const i = text.indexOf(a);
    assert.ok(i > 0, 'start marker not found: ' + a);
    const j = text.indexOf(b, i);
    assert.ok(j > i, 'end marker not found: ' + b);
    return text.slice(i, j);
}

function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx);
    let depth = 0, end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

const T = loadTranslations();
const PARTNER_API = sliceBetween(SERVER, '// REFERRAL PARTNER PROGRAM', '// EMAIL 2FA');
const routeSrc = sliceBetween(PARTNER_API, "app.put('/api/admin/referral/payouts/:id'", '// ============================================================');

// ===========================================================================
// 1. SERVER: the admin route rejects PAID without a reference
// ===========================================================================
test('server route: PAID requires a non-empty (trimmed) tx reference', () => {
    // trims the incoming value
    assert.match(routeSrc, /const txReference = \(body\.txReference === undefined \|\| body\.txReference === null\)/);
    assert.match(routeSrc, /String\(body\.txReference\)\.trim\(\)/);
    // rejects a PAID transition with an empty reference
    assert.match(routeSrc, /if \(status === 'PAID' && !txReference\)/);
    assert.match(routeSrc, /TX_REFERENCE_REQUIRED/);
    assert.match(routeSrc, /Transaction reference is required to mark a payout paid/);
    assert.match(routeSrc, /res\.status\(400\)/);
    // forwards the trimmed value (or null for non-PAID transitions)
    assert.match(routeSrc, /p_tx_reference: txReference \|\| null/);
    // the validation runs BEFORE the RPC call
    assert.ok(routeSrc.indexOf("status === 'PAID' && !txReference") < routeSrc.indexOf(".rpc('update_referral_payout_safe'"),
        'the guard must run before the RPC');
});

test('server route: the RPC tx_reference_required error maps to HTTP 400', () => {
    assert.match(routeSrc, /tx_reference_required:\s*400/);
});

test('server route: auth/authorization + manager identity are unchanged', () => {
    assert.match(routeSrc, /authMiddleware, adminMiddleware/);
    assert.match(routeSrc, /PAYOUT_STATUSES\.includes\(status\)/);
    assert.match(routeSrc, /p_manager_id: req\.user\.id/);
    assert.ok(!/p_manager_id:\s*req\.body/.test(routeSrc), 'manager must not come from the client body');
});

// ---------------------------------------------------------------------------
// Pure-logic mirror of the route's decision (matches the added server code).
// ---------------------------------------------------------------------------
function routeDecision(status, txReference) {
    const s = String(status || '').toUpperCase();
    const tx = (txReference === undefined || txReference === null) ? null : String(txReference).trim();
    if (s === 'PAID' && !tx) return { ok: false, status: 400, error: 'TX_REFERENCE_REQUIRED' };
    return { ok: true, forwardedTxReference: tx || null };
}

test('route mirror: null / undefined / empty / whitespace PAID references are rejected', () => {
    for (const bad of [null, undefined, '', ' ', '   ', '\t', '\n', ' \t\n ']) {
        const d = routeDecision('PAID', bad);
        assert.strictEqual(d.ok, false, JSON.stringify(bad) + ' must be rejected');
        assert.strictEqual(d.error, 'TX_REFERENCE_REQUIRED');
        assert.strictEqual(d.status, 400);
    }
});

test('route mirror: any non-empty reference is accepted and forwarded trimmed', () => {
    const cases = [
        ['TRON-TX-ABC123', 'TRON-TX-ABC123'],
        ['  0xdeadbeef  ', '0xdeadbeef'],
        ['manual-2025-001', 'manual-2025-001'],
        ['bank-ref 42', 'bank-ref 42'],
        ['x', 'x']
    ];
    for (const [input, expected] of cases) {
        const d = routeDecision('PAID', input);
        assert.strictEqual(d.ok, true, input + ' must be accepted');
        assert.strictEqual(d.forwardedTxReference, expected);
    }
});

test('route mirror: the reference is optional for non-PAID transitions (workflow preserved)', () => {
    for (const s of ['UNDER_REVIEW', 'REJECTED', 'PENDING']) {
        const d = routeDecision(s, '');
        assert.strictEqual(d.ok, true, s + ' must not require a reference');
        assert.strictEqual(d.forwardedTxReference, null);
    }
});

// ===========================================================================
// 2. DATABASE: migration 037 re-creates the RPC with the PAID guard
// ===========================================================================
test('037 re-creates update_referral_payout_safe with a PAID tx-reference guard', () => {
    assert.match(MIG037, /CREATE OR REPLACE FUNCTION public\.update_referral_payout_safe/);
    assert.match(MIG037, /IF v_status = 'PAID' AND NULLIF\(btrim\(COALESCE\(p_tx_reference, ''\)\), ''\) IS NULL THEN/);
    assert.match(MIG037, /'tx_reference_required'/);
    // the guard is AFTER the terminal-state checks and BEFORE the write
    const guard = MIG037.indexOf("v_status = 'PAID' AND NULLIF");
    assert.ok(MIG037.indexOf("already_paid") < guard, 'already_paid guard runs first');
    assert.ok(MIG037.indexOf("already_rejected") < guard, 'already_rejected guard runs first');
    assert.ok(guard < MIG037.indexOf('UPDATE public.referral_payouts'), 'guard runs before the write');
});

test('037 preserves every existing RPC guarantee (lock, terminal states, refund, manager)', () => {
    assert.match(MIG037, /FROM public\.referral_payouts WHERE id = p_payout_id FOR UPDATE/);
    assert.match(MIG037, /already_paid/);
    assert.match(MIG037, /already_rejected/);
    assert.match(MIG037, /IF v_status = 'REJECTED' THEN[\s\S]*bonus_balance = ROUND\(COALESCE\(bonus_balance, 0\) \+ v_refund/);
    assert.match(MIG037, /manager_id = COALESCE\(p_manager_id, manager_id\)/);
    assert.match(MIG037, /paid_at = CASE WHEN v_status = 'PAID' THEN NOW\(\)/);
    assert.match(MIG037, /reviewed_at = CASE WHEN v_status IN \('UNDER_REVIEW', 'REJECTED'\)/);
    assert.match(MIG037, /tx_reference = COALESCE\(NULLIF\(btrim\(COALESCE\(p_tx_reference, ''\)\), ''\), tx_reference\)/);
});

test('037 is additive, idempotent and self-checking', () => {
    assert.ok(!/\bDROP TABLE\b/i.test(MIG037), 'must not drop tables');
    assert.ok(!/\bCREATE TABLE\b/i.test(MIG037), 'must not create tables');
    assert.ok(!/\bALTER TABLE public\.(wallets|referrals|users|deposits|withdrawals|transactions|referral_payouts)\b/i.test(MIG037),
        'must not alter existing tables');
    assert.match(MIG037, /RAISE EXCEPTION/);
    assert.match(MIG037, /pg_get_functiondef/);
    assert.match(MIG037, /tx_reference_required/);
});

test('037 keeps the RPC service_role-only', () => {
    const fn = 'update_referral_payout_safe\\(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT\\)';
    assert.match(MIG037, new RegExp('REVOKE EXECUTE ON FUNCTION public\\.' + fn + ' FROM PUBLIC'));
    assert.match(MIG037, new RegExp('REVOKE EXECUTE ON FUNCTION public\\.' + fn + ' FROM anon'));
    assert.match(MIG037, new RegExp('REVOKE EXECUTE ON FUNCTION public\\.' + fn + ' FROM authenticated'));
    assert.match(MIG037, new RegExp('GRANT EXECUTE ON FUNCTION public\\.' + fn + ' TO service_role'));
    assert.ok(!/sendTransaction|transferUsdt|axios|fetch\(|https?:\/\//i.test(MIG037), 'manual process only');
});

test('037 is a new overlay: 034 still defines the base function (unchanged)', () => {
    assert.match(MIG034, /CREATE OR REPLACE FUNCTION public\.update_referral_payout_safe/);
    assert.ok(MIG034 !== MIG037);
});

// ---------------------------------------------------------------------------
// Pure-logic mirror of the migration-037 RPC (row-locked manager lifecycle).
// ---------------------------------------------------------------------------
function round2(n) { return Math.round(n * 100) / 100; }
function updatePayout(p, { status, paidAmount, txReference }) {
    const s = String(status || '').toUpperCase();
    if (!['PENDING', 'UNDER_REVIEW', 'PAID', 'REJECTED'].includes(s)) return { success: false, error: 'invalid_status' };
    if (p.status === 'PAID') return { success: false, error: 'already_paid' };
    if (p.status === 'REJECTED') return { success: false, error: 'already_rejected' };
    const ref = (txReference === undefined || txReference === null) ? '' : String(txReference).trim();
    if (s === 'PAID' && !ref) return { success: false, error: 'tx_reference_required' };
    if (s === 'PAID') {
        p.status = 'PAID';
        p.paid_amount = (paidAmount === undefined || paidAmount === null) ? p.amount : round2(paidAmount);
        p.tx_reference = ref;
        p.paid_at = 'NOW';
    } else {
        p.status = s;
    }
    return { success: true, payout_id: p.id, status: p.status, paid_amount: p.paid_amount, tx_reference: p.tx_reference };
}

test('RPC mirror: empty / whitespace references are rejected and nothing changes', () => {
    for (const bad of [null, undefined, '', '   ', '\t\n']) {
        const p = { id: 1, amount: 20, status: 'UNDER_REVIEW', paid_amount: null, tx_reference: null, paid_at: null };
        const r = updatePayout(p, { status: 'PAID', paidAmount: 20, txReference: bad });
        assert.strictEqual(r.success, false, JSON.stringify(bad) + ' must be rejected');
        assert.strictEqual(r.error, 'tx_reference_required');
        assert.strictEqual(p.status, 'UNDER_REVIEW', 'status must be untouched');
        assert.strictEqual(p.paid_at, null, 'paid_at must not be set');
        assert.strictEqual(p.tx_reference, null, 'no reference must be stored');
    }
});

test('RPC mirror: a valid reference is accepted and stored (trimmed) with the PAID payout', () => {
    const p = { id: 2, amount: 20, status: 'UNDER_REVIEW', paid_amount: null, tx_reference: null, paid_at: null };
    const r = updatePayout(p, { status: 'PAID', paidAmount: 20, txReference: '  TRON-TX-ABC  ' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(p.status, 'PAID');
    assert.strictEqual(p.paid_at, 'NOW');
    assert.strictEqual(p.tx_reference, 'TRON-TX-ABC', 'stored trimmed');
    assert.strictEqual(r.tx_reference, 'TRON-TX-ABC');
    assert.strictEqual(p.paid_amount, 20);
});

test('RPC mirror: an already-PAID payout cannot be paid again (even with a reference)', () => {
    const p = { id: 3, amount: 20, status: 'PAID', paid_amount: 20, tx_reference: 'TX-1', paid_at: 'T' };
    const r = updatePayout(p, { status: 'PAID', paidAmount: 20, txReference: 'TX-2' });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.error, 'already_paid');
    assert.strictEqual(p.tx_reference, 'TX-1', 'the original reference is not overwritten');
});

test('RPC mirror: a REJECTED payout is terminal (no re-pay, no double refund)', () => {
    const p = { id: 4, amount: 20, status: 'REJECTED', paid_amount: null, tx_reference: null, paid_at: null };
    const r = updatePayout(p, { status: 'PAID', paidAmount: 20, txReference: 'TX-3' });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.error, 'already_rejected');
});

// ===========================================================================
// 3. ADMIN UI: the "Mark Paid" action requires a reference
// ===========================================================================
test('admin UI: recordReferralPayoutPayment trims and rejects an empty reference', () => {
    const fn = sliceBetween(INDEX, 'function recordReferralPayoutPayment', 'function rejectReferralPayout');
    assert.match(fn, /admin\.referral\.txRefPrompt/);
    assert.match(fn, /const txReference = String\(tx\)\.trim\(\)/);
    assert.match(fn, /if \(!txReference\) \{ showToast\(t\('admin\.referral\.txRefRequired'\), 'error'\); return; \}/);
    // the payment is only dispatched with the trimmed, non-empty reference
    assert.match(fn, /updateReferralPayout\(id, 'PAID', \{ txReference: txReference, paidAmount: paidAmount \}\)/);
    // a cancelled prompt (null) still returns before validation (workflow preserved)
    assert.match(fn, /if \(tx === null\) return;/);
});

test('admin UI: updateReferralPayout independently guards PAID and sends the trimmed value', () => {
    const fn = sliceBetween(INDEX, 'async function updateReferralPayout', 'function recordReferralPayoutPayment');
    assert.match(fn, /String\(status\)\.toUpperCase\(\) === 'PAID' && !txReference/);
    assert.match(fn, /showToast\(t\('admin\.referral\.txRefRequired'\), 'error'\)/);
    assert.match(fn, /txReference: txReference \|\| null/);
});

test('admin UI: the validation message is defined and non-empty in all 6 locales', () => {
    for (const l of LANGS) {
        assert.ok(T[l] && typeof T[l]['admin.referral.txRefRequired'] === 'string' && T[l]['admin.referral.txRefRequired'].trim().length > 0,
            l + ' missing admin.referral.txRefRequired');
    }
    // identical key sets across locales (the new key is present in all)
    const base = Object.keys(T.en).sort().join(',');
    for (const l of LANGS) assert.strictEqual(Object.keys(T[l]).sort().join(','), base, l + ' key set differs');
});

test('admin UI: the server sentence is mapped for localization (BACKEND_MESSAGE_MAP)', () => {
    assert.match(INDEX, /'Transaction reference is required to mark a payout paid': 'admin\.referral\.txRefRequired'/);
});

// ---------------------------------------------------------------------------
// Functional: run the REAL recordReferralPayoutPayment + updateReferralPayout
// against a stubbed fetch/prompt (no network).
// ---------------------------------------------------------------------------
function runPaymentUI(opts) {
    opts = opts || {};
    const fnSrc = sliceBetween(INDEX, 'async function updateReferralPayout', 'function rejectReferralPayout');
    const prompts = [String(opts.amount == null ? 20 : opts.amount), opts.tx];
    const calls = [];
    const toasts = [];
    const sandbox = {
        localStorage: { getItem: () => 'jwt' },
        prompt: () => (prompts.length ? prompts.shift() : null),
        showToast: (m, ty) => toasts.push({ m: m, ty: ty }),
        t: (k) => k,
        translateBackendMessage: (e, f) => f,
        loadReferralPayouts: () => {},
        Math: Math, JSON: JSON, Number: Number, isFinite: isFinite, String: String,
        console: console, setTimeout: setTimeout,
        fetch: async (url, init) => {
            calls.push({ url: url, body: JSON.parse(init.body) });
            return { ok: true, json: async () => ({ success: true }) };
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + ';globalThis.__rec = recordReferralPayoutPayment; globalThis.__upd = updateReferralPayout;', sandbox);
    return {
        calls: calls, toasts: toasts,
        run: async () => {
            if (opts.direct) { await sandbox.__upd.apply(null, opts.direct); }
            else { sandbox.__rec(5, 20); await new Promise((r) => setTimeout(r, 20)); }
        },
    };
}

test('functional UI: an empty reference blocks the PAID request (no fetch)', async () => {
    const h = runPaymentUI({ amount: 20, tx: '' });
    await h.run();
    assert.strictEqual(h.calls.length, 0, 'must not send a PAID update without a reference');
    assert.ok(h.toasts.some((x) => x.m === 'admin.referral.txRefRequired' && x.ty === 'error'), 'shows the validation message');
});

test('functional UI: a whitespace-only reference blocks the PAID request', async () => {
    const h = runPaymentUI({ amount: 20, tx: '   \t  ' });
    await h.run();
    assert.strictEqual(h.calls.length, 0);
    assert.ok(h.toasts.some((x) => x.m === 'admin.referral.txRefRequired'));
});

test('functional UI: a valid reference is sent trimmed with the PAID transition', async () => {
    const h = runPaymentUI({ amount: 20, tx: '  TRON-TX-9  ' });
    await h.run();
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(h.calls[0].url, '/api/admin/referral/payouts/5');
    assert.strictEqual(h.calls[0].body.status, 'PAID');
    assert.strictEqual(h.calls[0].body.txReference, 'TRON-TX-9', 'trimmed before send');
    assert.strictEqual(h.calls[0].body.paidAmount, 20);
});

test('functional UI: updateReferralPayout independently guards a PAID transition', async () => {
    const h = runPaymentUI({ direct: [5, 'PAID', { paidAmount: 20 }] });
    await h.run();
    assert.strictEqual(h.calls.length, 0, 'defense-in-depth guard must block it');
    assert.ok(h.toasts.some((x) => x.m === 'admin.referral.txRefRequired'));
});

test('functional UI: non-PAID transitions still work without a reference', async () => {
    const h = runPaymentUI({ direct: [5, 'UNDER_REVIEW', {}] });
    await h.run();
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(h.calls[0].body.status, 'UNDER_REVIEW');
    assert.strictEqual(h.calls[0].body.txReference, null);
});

// ===========================================================================
// 4. Business rules unchanged
// ===========================================================================
test('business rules are unchanged by this fix', () => {
    assert.match(SERVER, /const REFERRAL_REWARD_PERCENT_DEFAULT = 20;/);
    assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 100;/);
    assert.match(SERVER, /const MIN_WITHDRAWAL_USD = 700;/);
    assert.ok(!/REFERRAL_REWARD_AMOUNT_DEFAULT|referral_reward_amount/.test(SERVER), 'no flat reward');
    assert.ok(!/REFERRAL_PROFIT_COMMISSION_RATE|credit_referral_commission_safe/.test(SERVER), 'no commission');
    assert.match(SERVER, /const PAYOUT_ASSETS = \[[\s\S]*?USDT[\s\S]*?TRC20[\s\S]*?\]/);
    assert.ok(!/sendTransaction|transferUsdt|blockchain/i.test(PARTNER_API), 'manual payout process only');
});
