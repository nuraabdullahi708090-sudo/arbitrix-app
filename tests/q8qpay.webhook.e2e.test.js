'use strict';

/**
 * Q8Q PAY WEBHOOK - END TO END AGAINST THE REAL SERVER.
 *
 * This file boots `server.js` itself (one process for the whole suite) and POSTs
 * real, HMAC-signed webhook bodies at `/api/webhook/q8qpay`. Everything that
 * decides whether a customer is paid for runs for real:
 *
 *   express.json({ verify }) raw-body capture -> the route in server.js ->
 *   Q8QPayProvider.verifyWebhook -> parsePaymentData -> the invoice lookup ->
 *   services/q8qpaySettlement.js (provider re-verification, reference/asset/
 *   amount/address/tx-hash validation) -> the credit_payment_safe RPC ->
 *   the durable webhook_logs record -> the HTTP acknowledgement.
 *
 * Only the network boundary is replaced (tests/helpers/fake-q8qpay-preload.js):
 * the Supabase REST calls and the q8qpay `/api/invoices/:id` GET.
 *
 * The previous suite mirrored the handler inside the test, so it could pass while
 * the real route was broken. This one cannot: it asserts on the HTTP response the
 * provider would receive, on the RPC the server actually issued, and on the row it
 * wrote to webhook_logs.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-q8qpay-preload.js');
const SECRET = 'q8qpay-e2e-webhook-secret';
const JWT_SECRET = 'q8qpay-e2e-jwt-secret';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'q8qpay-e2e-'));
const STATE_FILE = path.join(TMP, 'state.json');
const EVENTS_FILE = path.join(TMP, 'events.jsonl');

const INVOICE = {
    id: 41,
    invoice_id: 'ARB_TEST_REF_1',
    user_id: 7,
    amount_usd: 50,
    amount_crypto: 50.002,
    currency: 'USDT',
    network: 'TRC20',
    status: 'pending',
    credited: false,
    credited_at: null,
    provider: 'q8qpay',
    provider_invoice_ref: 'q8q-uuid-1',
    provider_tx_hash: null,
    wallet_address: 'TXyzPayout',
    expires_at: '2026-11-02T00:00:00Z',
    created_at: '2026-11-01T00:00:00Z'
};

const PROVIDER_OK = {
    id: 'q8q-uuid-1',
    reference: 'ARB_TEST_REF_1',
    status: 'confirmed',
    assetCode: 'USDT_TRC20',
    payoutAddress: 'TXyzPayout',
    amountUsdtExact: '50.0020',
    tx_hash: 'a'.repeat(64),
    isTest: false
};

let child = null;
let base = '';
let port = 0;

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });
}

async function boot() {
    port = await freePort();
    base = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
            NODE_ENV: 'test',
            PORT: String(port),
            JWT_SECRET,
            BASE_URL: base,
            PAYMENT_PROVIDER: 'q8qpay',
            Q8QPAY_API_KEY: 'live_e2e_key',
            Q8QPAY_WEBHOOK_SECRET: SECRET,
            Q8QPAY_SANDBOX: 'false',
            Q8QPAY_CALLBACK_URL: base + '/api/webhook/q8qpay',
            TELEGRAM_BOT_TOKEN: '',
            TELEGRAM_SUPPORT_CHAT_ID: '',
            TELEGRAM_ADMIN_IDS: '',
            Q8_STATE_FILE: STATE_FILE,
            Q8_EVENTS_FILE: EVENTS_FILE,
            NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD)
        }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });

    const deadline = Date.now() + 25000;
    for (;;) {
        if (child.exitCode !== null) throw new Error('server exited during boot: ' + output.slice(-1500));
        try {
            const r = await fetch(base + '/api/health');
            if (r.ok) return;
        } catch (e) { /* not up yet */ }
        if (Date.now() > deadline) throw new Error('server did not boot: ' + output.slice(-1500));
        await new Promise((r) => setTimeout(r, 150));
    }
}

function writeState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    fs.writeFileSync(EVENTS_FILE, '');
}

function events() {
    try {
        return fs.readFileSync(EVENTS_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) { return []; }
}

function eventsOf(kind) { return events().filter((e) => e.kind === kind); }

function signed(body, { secret = SECRET, form = 'raw' } = {}) {
    const raw = JSON.stringify(body);
    const payload = form === 'canonical' ? JSON.stringify(JSON.parse(raw)) : raw;
    const signature = crypto.createHmac('sha256', secret).update(Buffer.from(payload, 'utf8')).digest('hex');
    return { raw, signature };
}

async function postWebhook(body, opts = {}) {
    const { raw, signature } = opts.signature === undefined ? signed(body, opts) : { raw: opts.raw, signature: opts.signature };
    const headers = { 'content-type': 'application/json' };
    if (signature !== null) headers['x-webhook-signature'] = signature;
    const res = await fetch(base + '/api/webhook/q8qpay', { method: 'POST', headers, body: raw });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, body: json };
}

function confirmedPayload(overrides = {}) {
    return Object.assign({
        invoice_id: 'q8q-uuid-1',
        invoice_reference: 'ARB_TEST_REF_1',
        merchant_id: 'merchant-1',
        status: 'confirmed',
        asset_code: 'USDT_TRC20',
        payout_address: 'TXyzPayout',
        amount_usdt_exact: '50.0020',
        amount_fiat: '50.00',
        fiat_currency: 'USD',
        tx_hash: 'a'.repeat(64),
        metadata: { arbitrixDepositRef: 'ARB_TEST_REF_1' },
        paid_at: '2026-11-01T12:00:00Z',
        timestamp: '2026-11-01T12:00:01Z',
        type: 'invoice.confirmed'
    }, overrides);
}

const CREDIT_OK = { success: true, new_balance: 150.002, is_first_deposit: true };

test.before(async () => { await boot(); });

test.after(async () => {
    if (child) child.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

// ---------------------------------------------------------------------------
// The happy path, and idempotency
// ---------------------------------------------------------------------------

test('a correctly signed confirmed webhook credits exactly once and answers 200', async () => {
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, credit: CREDIT_OK });
    const res = await postWebhook(confirmedPayload());
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.credited, true, JSON.stringify(res.body));

    const rpcs = eventsOf('rpc');
    assert.strictEqual(rpcs.length, 1, 'exactly one credit call');
    assert.strictEqual(rpcs[0].params.p_invoice_id, 41);
    assert.strictEqual(rpcs[0].params.p_user_id, 7);
    assert.strictEqual(rpcs[0].params.p_amount_usd, 50);
    assert.strictEqual(rpcs[0].params.p_transaction_hash, 'a'.repeat(64));
    assert.strictEqual(rpcs[0].params.p_provider_name, 'q8qpay');

    const logs = eventsOf('insert').filter((e) => e.table === 'webhook_logs');
    assert.strictEqual(logs.length, 1, 'the settlement is durably recorded');
    assert.strictEqual(logs[0].row.status, 'processed');
    assert.strictEqual(logs[0].row.result.outcome, 'credited');
    assert.strictEqual(logs[0].row.result.needsReview, false);
    assert.strictEqual(logs[0].row.related_invoice_id, 41);
    // No secret is ever stored - only a hash of the signature header.
    assert.notStrictEqual(logs[0].row.signature_hash, undefined);
    assert.ok(!JSON.stringify(logs[0].row).includes(SECRET));
});

test('a redelivered webhook for an already-credited invoice credits nothing', async () => {
    writeState({
        invoice: Object.assign({}, INVOICE, { credited: true, status: 'confirmed' }),
        provider: PROVIDER_OK,
        credit: CREDIT_OK
    });
    const res = await postWebhook(confirmedPayload());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.message, 'Already processed');
    assert.strictEqual(eventsOf('rpc').length, 0, 'no second credit');
    const logs = eventsOf('insert').filter((e) => e.table === 'webhook_logs');
    assert.strictEqual(logs[0].row.status, 'duplicate');
});

test('when the RPC reports a duplicate, the webhook still answers 200 and does not re-credit', async () => {
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, credit: { duplicate: true } });
    const res = await postWebhook(confirmedPayload());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.message, 'Duplicate payment (not re-credited)');
    const logs = eventsOf('insert').filter((e) => e.table === 'webhook_logs');
    assert.strictEqual(logs[0].row.result.outcome, 'duplicate');
});

test('two concurrent deliveries of the same payment produce exactly one credit', async () => {
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, creditOnce: true });
    const payload = confirmedPayload();
    const results = await Promise.all([postWebhook(payload), postWebhook(payload)]);
    const statuses = results.map((r) => r.status);
    assert.deepStrictEqual(statuses, [200, 200], JSON.stringify(results));
    const credited = results.filter((r) => r.body && r.body.credited === true).length;
    assert.strictEqual(credited, 1, 'exactly one delivery is told it credited: ' + JSON.stringify(results));
    // The fake RPC models credit_payment_safe: the second call is a duplicate.
    assert.strictEqual(eventsOf('rpc').length, 2, 'both deliveries reached the atomic RPC');
});

test('a signed webhook whose body was re-serialised (canonical JSON) is still accepted', async () => {
    // q8qpay's own documentation signs JSON.stringify(parsedBody); a delivery
    // whose wire bytes carry different whitespace must not be rejected.
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, credit: CREDIT_OK });
    const payload = confirmedPayload();
    const spaced = JSON.stringify(payload, null, 2);
    const signature = crypto.createHmac('sha256', SECRET)
        .update(Buffer.from(JSON.stringify(JSON.parse(spaced)), 'utf8')).digest('hex');
    const res = await postWebhook(payload, { raw: spaced, signature: signature.toUpperCase() });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.credited, true);
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test('a missing signature is refused with 401 and nothing is persisted', async () => {
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, credit: CREDIT_OK });
    const res = await postWebhook(confirmedPayload(), { signature: null, raw: '{}' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(eventsOf('insert').length, 0);
    assert.strictEqual(eventsOf('rpc').length, 0);
});

test('an invalid signature is refused with 401 and nothing is persisted', async () => {
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, credit: CREDIT_OK });
    const res = await postWebhook(confirmedPayload(), { signature: 'deadbeef', raw: '{}' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(eventsOf('insert').length, 0);
    assert.strictEqual(eventsOf('rpc').length, 0);
});

test('a body signed with the wrong secret is refused', async () => {
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, credit: CREDIT_OK });
    const res = await postWebhook(confirmedPayload(), { secret: 'not-the-secret' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(eventsOf('rpc').length, 0);
});

// ---------------------------------------------------------------------------
// Permanent mismatches: acknowledged, but durably recorded for a human
// ---------------------------------------------------------------------------

async function expectReview(payload, provider, expectedOutcome) {
    writeState({ invoice: INVOICE, provider, credit: CREDIT_OK });
    const res = await postWebhook(payload);
    assert.strictEqual(eventsOf('rpc').length, 0, 'a mismatch must never credit');
    const logs = eventsOf('insert').filter((e) => e.table === 'webhook_logs');
    assert.strictEqual(logs.length, 1, 'the mismatch must be durably recorded');
    assert.strictEqual(logs[0].row.result.outcome, expectedOutcome);
    assert.strictEqual(logs[0].row.result.needsReview, true);
    assert.strictEqual(logs[0].row.status, 'failed');
    return { res, result: logs[0].row.result };
}

test('an unknown invoice reference is recorded (not silently acknowledged)', async () => {
    writeState({ invoice: null, provider: PROVIDER_OK, credit: CREDIT_OK });
    const res = await postWebhook(confirmedPayload({ invoice_reference: 'ARB_UNKNOWN_REF' }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.outcome, 'unknown_invoice');
    const logs = eventsOf('insert').filter((e) => e.table === 'webhook_logs');
    assert.strictEqual(logs[0].row.result.outcome, 'unknown_invoice');
    assert.strictEqual(logs[0].row.result.needsReview, true);
    assert.strictEqual(logs[0].row.result.reference, 'ARB_UNKNOWN_REF');
});

test('a reference present only in metadata still resolves the invoice', async () => {
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, credit: CREDIT_OK });
    const payload = confirmedPayload();
    delete payload.invoice_reference;
    const res = await postWebhook(payload);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.credited, true, JSON.stringify(res.body));
});

test('a provider invoice id that does not match the stored invoice is a review case', async () => {
    const { res, result } = await expectReview(
        confirmedPayload({ invoice_id: 'some-other-uuid' }),
        Object.assign({}, PROVIDER_OK, { id: 'some-other-uuid' }),
        'reference_mismatch'
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(result.reason, 'stored-provider-id-mismatch');
});

test('an invoice whose provider reference does not match ours is a review case', async () => {
    const { result } = await expectReview(
        confirmedPayload(),
        Object.assign({}, PROVIDER_OK, { reference: 'ARB_DIFFERENT' }),
        'reference_mismatch'
    );
    assert.strictEqual(result.reason, 'provider-reference-mismatch');
});

test('a confirmed payment in another asset is a review case', async () => {
    const { result } = await expectReview(
        confirmedPayload(),
        Object.assign({}, PROVIDER_OK, { assetCode: 'USDT_ERC20' }),
        'asset_mismatch'
    );
    assert.strictEqual(result.expectedAmountCrypto, '50.002');
});

test('a confirmed amount that differs from the quoted amount is a review case', async () => {
    const { result } = await expectReview(
        confirmedPayload({ amount_usdt_exact: '50.0000' }),
        Object.assign({}, PROVIDER_OK, { amountUsdtExact: '50.0000' }),
        'amount_mismatch'
    );
    // The operator needs both numbers to adjudicate without guessing.
    assert.strictEqual(result.expectedAmountCrypto, '50.002');
    assert.strictEqual(result.confirmedAmountCrypto, '50.0000');
});

test('a confirmed payment to a different payout address is a review case', async () => {
    await expectReview(
        confirmedPayload(),
        Object.assign({}, PROVIDER_OK, { payoutAddress: 'TDifferentAddress' }),
        'address_mismatch'
    );
});

test('an invoice with no stored exact amount cannot be settled', async () => {
    writeState({
        invoice: Object.assign({}, INVOICE, { amount_crypto: null }),
        provider: PROVIDER_OK,
        credit: CREDIT_OK
    });
    const res = await postWebhook(confirmedPayload());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(eventsOf('rpc').length, 0);
    const logs = eventsOf('insert').filter((e) => e.table === 'webhook_logs');
    assert.strictEqual(logs[0].row.result.outcome, 'missing_stored_amount');
});

// ---------------------------------------------------------------------------
// Transient failures: 5xx so the provider retries
// ---------------------------------------------------------------------------

test('a confirmed webhook the provider does not (yet) confirm answers 500 and credits nothing', async () => {
    writeState({ invoice: INVOICE, provider: Object.assign({}, PROVIDER_OK, { status: 'pending' }), credit: CREDIT_OK });
    const res = await postWebhook(confirmedPayload());
    assert.strictEqual(res.status, 500);
    assert.strictEqual(eventsOf('rpc').length, 0);
    const logs = eventsOf('insert').filter((e) => e.table === 'webhook_logs');
    assert.strictEqual(logs[0].row.result.outcome, 'provider_not_confirmed');
    assert.strictEqual(logs[0].row.result.transient, true);
});

test('the retry after that transient failure settles the payment', async () => {
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, credit: CREDIT_OK });
    const res = await postWebhook(confirmedPayload());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.credited, true);
});

test('a provider lookup failure answers 500 (retryable)', async () => {
    writeState({ invoice: INVOICE, provider: { __error: 'upstream timeout' }, credit: CREDIT_OK });
    const res = await postWebhook(confirmedPayload());
    assert.strictEqual(res.status, 500);
    assert.strictEqual(eventsOf('rpc').length, 0);
    const logs = eventsOf('insert').filter((e) => e.table === 'webhook_logs');
    assert.strictEqual(logs[0].row.result.outcome, 'verify_failed');
});

test('a confirmed live payment with no transaction hash is never credited with a fake one', async () => {
    writeState({
        invoice: INVOICE,
        provider: Object.assign({}, PROVIDER_OK, { tx_hash: null }),
        credit: CREDIT_OK
    });
    const payload = confirmedPayload();
    delete payload.tx_hash;
    const res = await postWebhook(payload);
    assert.strictEqual(res.status, 500);
    assert.strictEqual(eventsOf('rpc').length, 0, 'no hash, no credit');
    const logs = eventsOf('insert').filter((e) => e.table === 'webhook_logs');
    assert.strictEqual(logs[0].row.result.outcome, 'missing_tx_hash');
});

test('an atomic-credit RPC failure answers 500 and is recorded', async () => {
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, credit: { __rpcError: 'connection reset' } });
    const res = await postWebhook(confirmedPayload());
    assert.strictEqual(res.status, 500);
    const logs = eventsOf('insert').filter((e) => e.table === 'webhook_logs');
    assert.strictEqual(logs[0].row.result.outcome, 'credit_failed');
});

test('a credit function that returns success:false answers 500 and is recorded', async () => {
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, credit: { success: false, error: 'invoice already credited' } });
    const res = await postWebhook(confirmedPayload());
    assert.strictEqual(res.status, 500);
    const logs = eventsOf('insert').filter((e) => e.table === 'webhook_logs');
    assert.strictEqual(logs[0].row.result.outcome, 'credit_failed');
});

test('an invoice lookup database error answers 500 instead of "not found"', async () => {
    writeState({ invoice: null, invoiceError: { message: 'connection refused', code: '08006' }, provider: PROVIDER_OK });
    const res = await postWebhook(confirmedPayload());
    assert.strictEqual(res.status, 500);
    const logs = eventsOf('insert').filter((e) => e.table === 'webhook_logs');
    assert.strictEqual(logs.length, 0, 'we never learned which invoice this is - nothing to record');
    assert.strictEqual(eventsOf('rpc').length, 0);
});

// ---------------------------------------------------------------------------
// Status-only deliveries
// ---------------------------------------------------------------------------

test('a pending/expired delivery updates the status and credits nothing', async () => {
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, credit: CREDIT_OK });
    const res = await postWebhook(confirmedPayload({ status: 'expired', type: 'invoice.expired' }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.message, 'Status updated to expired');
    assert.strictEqual(eventsOf('rpc').length, 0);
    const updates = eventsOf('update');
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].data.status, 'expired');
});

test('a confirmed payment for an invoice WE marked expired still credits (the money arrived)', async () => {
    writeState({
        invoice: Object.assign({}, INVOICE, { status: 'expired' }),
        provider: PROVIDER_OK,
        credit: CREDIT_OK
    });
    const res = await postWebhook(confirmedPayload());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.credited, true);
});

// ---------------------------------------------------------------------------
// The customer-initiated check (same pipeline, authenticated, own invoice only)
// ---------------------------------------------------------------------------

const jwt = require('jsonwebtoken');

function userToken(userId) {
    return jwt.sign({ id: userId, email: 'e2e@example.test', is_admin: false }, JWT_SECRET, { expiresIn: '1h' });
}

async function postCheck(invoiceId, token) {
    const res = await fetch(base + '/api/payment/check/' + invoiceId, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: '{}'
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, body: json };
}

test('the customer check recovers a provider-confirmed payment whose webhook never arrived', async () => {
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, credit: CREDIT_OK });
    const res = await postCheck(INVOICE.invoice_id, userToken(INVOICE.user_id));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.status, 'confirmed');
    assert.strictEqual(res.body.credited, true);
    const rpcs = eventsOf('rpc');
    assert.strictEqual(rpcs.length, 1);
    assert.strictEqual(rpcs[0].params.p_transaction_hash, 'a'.repeat(64), 'the hash comes from the provider');
    const logs = eventsOf('insert').filter((e) => e.table === 'webhook_logs');
    assert.strictEqual(logs[0].row.result.source, 'manual-check');
});

test('the customer check does not credit while the provider still reports pending', async () => {
    writeState({ invoice: INVOICE, provider: Object.assign({}, PROVIDER_OK, { status: 'pending' }), credit: CREDIT_OK });
    const res = await postCheck(INVOICE.invoice_id, userToken(INVOICE.user_id));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'pending');
    assert.strictEqual(res.body.credited, false);
    assert.strictEqual(eventsOf('rpc').length, 0);
});

test('the customer check cannot touch another customer\'s invoice', async () => {
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, credit: CREDIT_OK });
    const res = await postCheck(INVOICE.invoice_id, userToken(999));
    assert.strictEqual(res.status, 404);
    assert.strictEqual(eventsOf('rpc').length, 0);
});

// ---------------------------------------------------------------------------
// The admin reconciliation view: read-only, and able to SEE a paid-but-uncredited
// invoice (the case that produced the original customer complaint)
// ---------------------------------------------------------------------------

function adminToken() {
    // adminMiddleware requires the camelCase `isAdmin` claim AND re-checks users.is_admin.
    return jwt.sign({ id: 1, email: 'admin@example.test', isAdmin: true }, JWT_SECRET, { expiresIn: '1h' });
}

async function getReconciliation(query, token) {
    const res = await fetch(base + '/api/admin/deposits/reconciliation' + (query || ''), {
        headers: { authorization: 'Bearer ' + (token || adminToken()) }
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, body: json };
}

const STALE_INVOICE = {
    id: 41,
    invoice_id: 'ARB_TEST_REF_1',
    user_id: 7,
    amount_usd: 50,
    amount_crypto: 50.002,
    currency: 'USDT',
    network: 'TRC20',
    status: 'expired',
    credited: false,
    provider: 'q8qpay',
    provider_invoice_ref: 'q8q-uuid-1',
    provider_tx_hash: null,
    wallet_address: 'TXyzPayout',
    created_at: '2026-11-20T00:00:00Z',
    expires_at: '2026-11-20T01:00:00Z'
};

test('reconciliation is read-only and offers no state change', async () => {
    writeState({ invoiceList: [STALE_INVOICE], deposits: [], webhookLogs: [] });
    const res = await getReconciliation('?hours=720');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.counts.stalePending, 1);
    assert.strictEqual(eventsOf('rpc').length, 0, 'never credits');
    assert.strictEqual(eventsOf('update').length, 0, 'never mutates an invoice');
    const row = res.body.stalePending[0];
    // Everything an operator needs to investigate the payment, without guessing.
    assert.strictEqual(row.invoiceId, 'ARB_TEST_REF_1');
    assert.strictEqual(row.amountCrypto, 50.002);
    assert.strictEqual(row.providerInvoiceId, 'q8q-uuid-1');
    assert.strictEqual(row.payoutAddress, 'TXyzPayout');
});

test('reconciliation does not call the provider unless asked', async () => {
    writeState({ invoiceList: [STALE_INVOICE], deposits: [], webhookLogs: [] });
    const res = await getReconciliation('?hours=720');
    assert.strictEqual(res.body.verified, false);
    assert.deepStrictEqual(res.body.providerChecks, []);
    assert.strictEqual(eventsOf('provider_get').length, 0);
});

test('with ?verify=1 a provider-confirmed, uncredited invoice is diagnosed as paid_but_uncredited', async () => {
    writeState({
        invoiceList: [STALE_INVOICE],
        deposits: [],
        webhookLogs: [],
        provider: Object.assign({}, PROVIDER_OK, { status: 'confirmed' })
    });
    const res = await getReconciliation('?hours=720&verify=1');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.verified, true);
    const check = res.body.providerChecks[0];
    assert.strictEqual(check.diagnosis, 'paid_but_uncredited');
    assert.strictEqual(check.providerStatus, 'confirmed');
    assert.strictEqual(check.providerAmountCrypto, '50.0020');
    assert.strictEqual(check.amountMatches, true);
    assert.strictEqual(res.body.counts.providerConfirmedUncredited, 1);
    // Still read-only: a human decides, the endpoint never credits.
    assert.strictEqual(eventsOf('rpc').length, 0);
    assert.strictEqual(eventsOf('update').length, 0);
});

test('with ?verify=1 an amount mismatch is diagnosed, never "paid"', async () => {
    writeState({
        invoiceList: [STALE_INVOICE],
        deposits: [],
        webhookLogs: [],
        provider: Object.assign({}, PROVIDER_OK, { status: 'confirmed', amountUsdtExact: '50.0000' })
    });
    const res = await getReconciliation('?hours=720&verify=1');
    assert.strictEqual(res.body.providerChecks[0].diagnosis, 'confirmed_amount_mismatch');
    assert.strictEqual(res.body.providerChecks[0].amountMatches, false);
    assert.strictEqual(res.body.counts.providerConfirmedUncredited, 0);
});

test('with ?verify=1 an unpaid invoice is reported as provider_pending, not as lost money', async () => {
    writeState({
        invoiceList: [STALE_INVOICE],
        deposits: [],
        webhookLogs: [],
        provider: Object.assign({}, PROVIDER_OK, { status: 'pending' })
    });
    const res = await getReconciliation('?hours=720&verify=1');
    assert.strictEqual(res.body.providerChecks[0].diagnosis, 'provider_pending');
});

test('a provider lookup failure during reconciliation is reported per invoice', async () => {
    writeState({ invoiceList: [STALE_INVOICE], deposits: [], webhookLogs: [], provider: { __error: 'timeout' } });
    const res = await getReconciliation('?hours=720&verify=1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.providerChecks[0].diagnosis, 'verify_failed');
    assert.strictEqual(res.body.providerChecks[0].ok, false);
});

test('a recorded webhook failure is surfaced with the evidence an operator needs', async () => {
    writeState({
        invoiceList: [],
        deposits: [],
        webhookLogs: [{
            id: 77,
            provider: 'q8qpay',
            event_type: 'invoice.confirmed',
            status: 'failed',
            received_at: '2026-11-25T10:00:00Z',
            related_invoice_id: 41,
            result: {
                outcome: 'amount_mismatch',
                needsReview: true,
                message: 'The confirmed amount differs from the exact amount quoted',
                reference: 'ARB_TEST_REF_1',
                providerInvoiceId: 'q8q-uuid-1',
                expectedAmountCrypto: '50.0020',
                confirmedAmountCrypto: '50.0000',
                providerStatus: 'confirmed',
                providerTxHash: 'a'.repeat(64),
                userId: 7,
                source: 'webhook'
            }
        }]
    });
    const res = await getReconciliation('?hours=720');
    assert.strictEqual(res.body.counts.needsReview, 1);
    const row = res.body.needsReview[0];
    assert.strictEqual(row.logId, 77);
    assert.strictEqual(row.outcome, 'amount_mismatch');
    assert.strictEqual(row.invoiceId, 'ARB_TEST_REF_1');
    assert.strictEqual(row.expectedAmountCrypto, '50.0020');
    assert.strictEqual(row.confirmedAmountCrypto, '50.0000');
    assert.strictEqual(row.providerTxHash, 'a'.repeat(64));
});

test('reconciliation requires an administrator', async () => {
    writeState({ invoiceList: [STALE_INVOICE], deposits: [], webhookLogs: [] });
    const res = await fetch(base + '/api/admin/deposits/reconciliation', { headers: { authorization: 'Bearer ' + userToken(7) } });
    assert.strictEqual(res.status, 403);
    const anon = await fetch(base + '/api/admin/deposits/reconciliation');
    assert.strictEqual(anon.status, 401);
});

test('the customer check requires authentication', async () => {
    writeState({ invoice: INVOICE, provider: PROVIDER_OK, credit: CREDIT_OK });
    const res = await fetch(base + '/api/payment/check/' + INVOICE.invoice_id, { method: 'POST' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(eventsOf('rpc').length, 0);
});
