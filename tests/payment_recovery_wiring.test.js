'use strict';

/**
 * The deposit modal reads `GET /api/payment/invoice/:id`, which reports only what
 * the WEBHOOK already wrote. When a delivery never arrives - a mis-registered
 * callback URL, a provider outage, a lost retry - the modal sat on "Waiting for
 * payment..." while the money was on chain, and nothing in the UI could trigger a
 * re-check: `POST /api/payment/check/:id` existed but had no caller.
 *
 * These tests execute the REAL helpers from public/index.html and assert the wiring,
 * so "the customer can recover" is a property of the shipped page, not of the route.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = path.resolve(__dirname, '..', 'public', 'index.html');
const HTML = fs.readFileSync(INDEX, 'utf8');

function slice(src, startMarker, endMarker) {
    const from = src.indexOf(startMarker);
    assert.notStrictEqual(from, -1, 'missing marker: ' + startMarker);
    const to = src.indexOf(endMarker, from);
    assert.notStrictEqual(to, -1, 'missing end marker: ' + endMarker);
    return src.slice(from, to);
}

const BLOCK = slice(HTML, 'const PAYMENT_RECOVERY_INTERVAL_MS', 'function startPollingForPayment(');
const POLL = slice(HTML, 'function startPollingForPayment(', 'function forceCheckPayment(');

function harness({ environment = 'PRODUCTION', token = 'jwt-abc', response } = {}) {
    const calls = [];
    const context = {
        APP: { environment },
        localStorage: { getItem: (k) => (k === 'jwt_token' ? token : null) },
        encodeURIComponent,
        Date,
        fetch: async (url, init) => {
            calls.push({ url, init });
            if (response instanceof Error) throw response;
            return response;
        },
        console
    };
    vm.createContext(context);
    vm.runInContext(BLOCK, context);
    return { context, calls };
}

function ok(body) {
    return { ok: true, status: 200, json: async () => body };
}

// ---------------------------------------------------------------------------
// What counts as "still unsettled"
// ---------------------------------------------------------------------------

test('an unsettled invoice includes expired: money can arrive after our clock gives up', () => {
    const { context } = harness();
    for (const s of ['pending', 'detected', 'confirming', 'expired']) {
        assert.strictEqual(context.isUnsettledInvoiceStatus(s), true, s);
    }
    for (const s of ['confirmed', 'credited', 'cancelled', 'failed', undefined, null]) {
        assert.strictEqual(context.isUnsettledInvoiceStatus(s), false, String(s));
    }
});

// ---------------------------------------------------------------------------
// Throttling and scope
// ---------------------------------------------------------------------------

test('the first attempt is immediate, repeats are throttled, a new invoice is not', async () => {
    const { context } = harness({ response: ok({ credited: false }) });
    assert.strictEqual(context.shouldAttemptPaymentRecovery('ARB_1'), true,
        'nothing has been attempted for this invoice yet');

    await context.attemptPaymentRecovery('ARB_1');

    const now = Date.now();
    assert.strictEqual(context.shouldAttemptPaymentRecovery('ARB_1', now), false,
        'a poll every few seconds must not call the provider every tick');
    assert.strictEqual(context.shouldAttemptPaymentRecovery('ARB_1', now + 20000), true,
        'after the interval it tries again');
    assert.strictEqual(context.shouldAttemptPaymentRecovery('ARB_2', now), true,
        'a different invoice gets its own attempt');
});

test('the marketing sandbox is never asked to recover (its route simulates its own lifecycle)', () => {
    const { context } = harness({ environment: 'MARKETING_SANDBOX' });
    assert.strictEqual(context.shouldAttemptPaymentRecovery('ARB_1', 1), false);
    assert.strictEqual(context.shouldAttemptPaymentRecovery('ARB_1', 999999), false);
});

test('no invoice id means no request', () => {
    const { context } = harness();
    assert.strictEqual(context.shouldAttemptPaymentRecovery(null, 1), false);
    assert.strictEqual(context.shouldAttemptPaymentRecovery('', 1), false);
});

// ---------------------------------------------------------------------------
// The request itself
// ---------------------------------------------------------------------------

test('recovery POSTs to /api/payment/check/<invoice> with the customer bearer token', async () => {
    const { context, calls } = harness({ response: ok({ success: true, credited: false, status: 'pending' }) });
    const result = await context.attemptPaymentRecovery('ARB_REF_9');
    assert.strictEqual(result, null, 'nothing recovered yet');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, '/api/payment/check/ARB_REF_9');
    assert.strictEqual(calls[0].init.method, 'POST');
    assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer jwt-abc');
});

test('recovery sends no body: the invoice and the identity come from the URL and the JWT', async () => {
    const { context, calls } = harness({ response: ok({ credited: false }) });
    await context.attemptPaymentRecovery('ARB_REF_9');
    assert.strictEqual(calls[0].init.body, undefined,
        'a client must not be able to name a user, an amount or a hash');
});

test('a credited answer is adopted; an uncredited answer is ignored', async () => {
    const credited = harness({ response: ok({ success: true, credited: true, status: 'confirmed' }) });
    const recovered = await credited.context.attemptPaymentRecovery('ARB_1');
    assert.strictEqual(recovered.status, 'confirmed');
    assert.strictEqual(recovered.credited, true);

    const underReview = harness({ response: ok({ success: true, credited: false, status: 'under_review' }) });
    assert.strictEqual(await underReview.context.attemptPaymentRecovery('ARB_1'), null);
});

test('a 5xx, a garbage body or a thrown network error never breaks the poll', async () => {
    const bad = harness({ response: { ok: false, status: 500, json: async () => ({}) } });
    assert.strictEqual(await bad.context.attemptPaymentRecovery('ARB_1'), null);

    const garbage = harness({ response: { ok: true, status: 200, json: async () => { throw new Error('bad json'); } } });
    assert.strictEqual(await garbage.context.attemptPaymentRecovery('ARB_1'), null);

    const offline = harness({ response: new Error('network down') });
    assert.strictEqual(await offline.context.attemptPaymentRecovery('ARB_1'), null);
});

test('without a session token there is no request at all', async () => {
    const { context, calls } = harness({ token: null });
    assert.strictEqual(await context.attemptPaymentRecovery('ARB_1'), null);
    assert.strictEqual(calls.length, 0);
});

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

test('the polling loop calls recovery while the invoice is unsettled', () => {
    assert.match(POLL, /isUnsettledInvoiceStatus\(result\.status\)/);
    assert.match(POLL, /shouldAttemptPaymentRecovery\(invoiceId\)/);
    assert.match(POLL, /await attemptPaymentRecovery\(invoiceId\)/);
    assert.ok(POLL.indexOf('attemptPaymentRecovery') < POLL.indexOf("result.status === 'confirmed'"),
        'recovery must run BEFORE the terminal status check, so a recovered payment is rendered this tick');
});

test('the Refresh Status button really re-checks: it restarts the polling loop', () => {
    const force = slice(HTML, 'function forceCheckPayment(', 'async function cancelCurrentInvoice(');
    assert.match(force, /startPollingForPayment\(currentInvoiceId\)/,
        'the button the customer sees must reach the recovery path, not just a DB read');
});

test('the modal still reads the stored row first (recovery is an addition, not a replacement)', () => {
    assert.match(POLL, /\/api\/payment\/invoice\//);
});
