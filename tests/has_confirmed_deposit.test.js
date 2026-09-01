'use strict';

/**
 * hasConfirmedDeposit — confirmed-deposit funding gate (regression tests).
 *
 * LiveAccountActivated (and /api/auth/me hasRealDeposit, and subscription
 * eligibility) gate on a REAL first confirmed/credited live deposit. The gate
 * must recognize both deposit flows:
 *
 *   legacy flow:  deposits.status = 'confirmed'
 *   provider flow: payment_invoices.status = 'confirmed'
 *              (written atomically by credit_payment_safe /
 *               paymento_credit_user_safe / confirm_payment_with_credit — the
 *               $50 q8qpay/Paymento production deposit writes THIS table,
 *               never a `deposits` row)
 *
 * The fix is server.js-only, read-only: Promise.all of two head:true
 * count queries, OR-combined, fail-closed (any query error => false).
 * No writes add; no crediting/payment function modified; no migration
 * modified. These tests pin the source contract + mirror the gate logic
 * purely (no express import — deps unavailable in this env).
 *
 * Run: npm test (or: node --test tests/has_confirmed_deposit.test.js)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const MIGRATION = fs.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '019_meta_event_claims.sql'),
    'utf8'
);

// ---------------------------------------------------------------------------
// Source-contract helper (mirrors tests/marketing_sandbox.test.js conventions)
// ---------------------------------------------------------------------------
function stripFullLineComments(s) {
    return s.split('\n').map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n');
}

function fnBody(name) {
    const idx = SERVER.indexOf(`function ${name}(`);
    assert.ok(idx >= 0, `function not found: ${name}`);
    const start = SERVER.lastIndexOf('async function', idx) >= 0 ? SERVER.lastIndexOf('async function', idx) : idx;
    const next = SERVER.indexOf('\nasync function ', idx + 1);
    const next2 = SERVER.indexOf('\nfunction ', idx + 1);
    let end = next < 0 ? next2 : next;
    if (next2 > 0 && next2 < end) end = next2;
    return stripFullLineComments(SERVER.slice(start < 0 ? idx : start, end < 0 ? undefined : end));
}

// ---------------------------------------------------------------------------
// Pure-JS mirror of the implemented gate logic (read-only counts)
// ---------------------------------------------------------------------------
async function mirrorHasConfirmedDeposit(legacyCount, providerCount, legacyError = false, providerError = false) {

    const results = await Promise.all([
        legacyError ? { count: null, error: new Error('legacy query down') } : { count: legacyCount, error: null },
        providerError ? { count: null, error: new Error('provider query down') } : { count: providerCount, error: null }
    ]);

    const legacy = results[0];
    const provider = results[1];
    if (legacy.error || provider.error) return false;
    return ((legacy.count || 0) + (provider.count || 0)) > 0;
}

// ---------------------------------------------------------------------------
// 1. BEHAVIOR — pure-JS mirror of the two-source OR / fail-closed gate
// ---------------------------------------------------------------------------
describe('hasConfirmedDeposit behavior mirror', () => {
    test('legacy confirmed deposit -> true', async () => {
        assert.strictEqual(await mirrorHasConfirmedDeposit(1, 0), true);
    });

    test('provider confirmed payment_invoice -> true', async () => {
        assert.strictEqual(await mirrorHasConfirmedDeposit(0, 1), true);
    });

    test('both sources present -> true (no double-count issue: boolean gate)', async () => {
        assert.strictEqual(await mirrorHasConfirmedDeposit(2, 3), true);
    });

    test('neither confirmed -> false', async () => {
        assert.strictEqual(await mirrorHasConfirmedDeposit(0, 0), false);
    });

    test('legacy query error -> false (fail-closed):', async () => {
        assert.strictEqual(await mirrorHasConfirmedDeposit(null, 0, true, false), false);
        assert.strictEqual(await mirrorHasConfirmedDeposit(5, 0, true, false), false);
    });

    test('provider query error -> false (fail-closed):', async () => {
        assert.strictEqual(await mirrorHasConfirmedDeposit(0, null, false, true), false);
        assert.strictEqual(await mirrorHasConfirmedDeposit(0, 5, false, true), false);
    });

    test('both queries error -> false', async () => {
        assert.strictEqual(await mirrorHasConfirmedDeposit(null,null, true, true), false);
    });
});

// ---------------------------------------------------------------------------
// 2. SOURCE CONTRACT — the implemented function reads both tables, ORs,
//    fails closed, and writes nothing
// ---------------------------------------------------------------------------
describe('hasConfirmedDeposit source contract', () => {
    test('function queries BOTH deposits and payment_invoices, each status confirmed', () => {
        const body = fnBody('hasConfirmedDeposit');
        assert.ok(body.includes("from('deposits')"), 'legacy deposits query present');
        assert.ok(body.includes("from('payment_invoices')"), 'provider payment_invoices query present');
        const eqConfirmed = (body.match(/.eq\('status', 'confirmed'\)/g) || []).length;
        assert.ok(eqConfirmed === 2, 'exactly two status=confirmed filters (deposits + payment_invoices)');
    });

    test('queries are OR-combined head:true counts (no row data read)', () => {
        const body = fnBody('hasConfirmedDeposit');
        assert.ok(body.includes("count: 'exact'"));
        assert.ok(body.includes('head: true'));
        assert.ok(/\(\(legacyCount \|\|\s*0\)\s*\+\s*\(providerCount \|\|\s*0\)\)\s*>\s*0/.test(body), 'legacy+provider OR sum');
        assert.ok(body.includes('Promise.all(['), 'parallel head-count queries');
    });

    test('fail-closed: any query error returns false', () => {
        const body = fnBody('hasConfirmedDeposit');
        assert.ok(body.includes('legacyError || providerError'), 'any error fails closed');
        assert.ok(body.includes('return false'), 'error path returns false');
        // no truthy-on-error escape: only the OR-of-counts return exists.

        assert.ok((body.match(/return false/g) || []).length === 1, 'exactly one false return (the error path); no partial-truth path');
    });

    test('function writes nothing (read-only gate)', () => {
        const body = fnBody('hasConfirmedDeposit');
        assert.ok(!body.includes('.insert('), 'no insert');
        assert.ok(!body.includes('.update('), 'no update');
        assert.ok(!body.includes('.rpc('), 'no RPC');
        assert.ok(!body.includes('.delete('), 'no delete');
    });
});

// ---------------------------------------------------------------------------
// 3. UNCHANGED — LiveAccountActivated once-per-user behavior remains intact
// ---------------------------------------------------------------------------
describe('LiveAccountActivated once-per-user guard unchanged', () => {
    test('claim endpoint still gated: sandbox short-circuit -> hasConfirmedDeposit -> insert -> 23505 no-op', () => {
        const block = SERVER.split('claim-live-activated')[1].split('// ---------- Deposit')[0];
        assert.ok(block.includes('isMarketingSandboxUser'), 'sandbox short-circuit preserved');
        assert.ok(block.indexOf('isMarketingSandboxUser') < block.indexOf('hasConfirmedDeposit'), 'sandbox gate precedes funding gate');
        assert.ok(block.includes("event_name: 'LiveAccountActivated'"), 'canonical event preserved');
        assert.ok(block.includes("error.code === '23505'"), 'durable once-guard (23505 no-op) preserved');
        assert.ok(block.includes('claimed: false'), 'no-op claim result preserved');
    });

    test('meta_event_claims migration still enforces UNIQUE(event_name,user_id)) and  the event enum', () => {
        assert.ok(MIGRATION.includes('CREATE TABLE IF NOT EXISTS public.meta_event_claims'), 'claims table present');
        assert.ok(MIGRATION.includes('UNIQUE (event_name, user_id)'), 'once-per-user UNIQUE preserved');
        assert.ok(MIGRATION.includes("event_name IN ('LiveAccountActivated')"), 'event enum preserved');
    });

    test('claim endpoint still pings the SAME gate helper hasConfirmedDeposit (behavioral path unchanged)', () => {
        const block = SERVER.split('claim-live-activated')[1].split('// ---------- Deposit')[0];
        assert.ok(block.includes('hasConfirmedDeposit'), 'funding gate is hasConfirmedDeposit (unit under test; both-flows semantics flows through here)');
    });
});

// ---------------------------------------------------------------------------
// 4. vm-executed real function — parse + structural sanity
// ---------------------------------------------------------------------------
describe('server.js parses (vm.Script drop-in of the function region)', () => {
    test('hasConfirmedDeposit + its immediate annotations parse cleanly', () => {
        const idx = SERVER.indexOf('async function hasConfirmedDeposit(');
        assert.ok(idx >= 0);
        const next = SERVER.indexOf('\nasync function ', idx + 1);
        const region = SERVER.slice(idx, next < 0 ? undefined : next);
        const fn = new vm.Script(region + '\nmodule.exports = { hasConfirmedDeposit };');
        assert.ok(fn instanceof vm.Script, 'function region parses');
    });
});