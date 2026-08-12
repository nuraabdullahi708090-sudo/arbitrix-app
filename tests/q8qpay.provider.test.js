'use strict';

/**
 * Q8QPay provider unit tests.
 *
 * Covers the transaction-hash resolution security invariant and the webhook
 * payload parsing/mapping that the q8qpay integration depends on. Uses Node's
 * built-in test runner (`node:test`) so no new dependencies are required.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { Q8QPayProvider, Q8QPAY_STATUS } = require('../services/providers/q8qpay');

const SECRET = 'test-webhook-secret';

function makeProvider({ apiKey = 'live_prodkey', sandbox = false } = {}) {
    const p = new Q8QPayProvider();
    p.initialize({ apiKey, webhookSecret: SECRET, sandbox });
    return p;
}

// HMAC-SHA256 hex of the raw body, matching Q8QPayProvider.verifyWebhook.
function sign(rawBody) {
    return crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
}

// ---------------------------------------------------------------------------
// resolveTransactionHash — the production-safety invariant
// ---------------------------------------------------------------------------

test('resolveTransactionHash: prefers webhook tx hash over verify and fallback', () => {
    const p = makeProvider({ apiKey: 'test_key', sandbox: true });
    const hash = p.resolveTransactionHash({
        webhookTxHash: '0xwebhook',
        verifyTxHash: '0xverify',
        verifyIsTest: true,
        providerInvoiceId: 'inv-1'
    });
    assert.strictEqual(hash, '0xwebhook');
});

test('resolveTransactionHash: falls back to verify tx hash when webhook omits it', () => {
    const p = makeProvider();
    const hash = p.resolveTransactionHash({
        webhookTxHash: null,
        verifyTxHash: '0xverify',
        verifyIsTest: false,
        providerInvoiceId: 'inv-2'
    });
    assert.strictEqual(hash, '0xverify');
});

test('resolveTransactionHash: SANDBOX fallback fires only when sandbox + test key + isTest', () => {
    const p = makeProvider({ apiKey: 'test_key', sandbox: true });
    const hash = p.resolveTransactionHash({
        webhookTxHash: null,
        verifyTxHash: null,
        verifyIsTest: true,
        providerInvoiceId: 'inv-3'
    });
    assert.strictEqual(hash, 'q8qpay_sandbox_inv-3');
});

test('resolveTransactionHash: sandbox fallback is deterministic per invoice (idempotency)', () => {
    const p = makeProvider({ apiKey: 'test_key', sandbox: true });
    const a = p.resolveTransactionHash({ webhookTxHash: null, verifyTxHash: null, verifyIsTest: true, providerInvoiceId: 'inv-3' });
    const b = p.resolveTransactionHash({ webhookTxHash: null, verifyTxHash: null, verifyIsTest: true, providerInvoiceId: 'inv-3' });
    assert.strictEqual(a, b, 'same invoice must resolve to the same fallback hash');
});

test('resolveTransactionHash: distinct invoices get distinct sandbox fallbacks', () => {
    const p = makeProvider({ apiKey: 'test_key', sandbox: true });
    const a = p.resolveTransactionHash({ webhookTxHash: null, verifyTxHash: null, verifyIsTest: true, providerInvoiceId: 'inv-A' });
    const b = p.resolveTransactionHash({ webhookTxHash: null, verifyTxHash: null, verifyIsTest: true, providerInvoiceId: 'inv-B' });
    assert.notStrictEqual(a, b);
});

// PRODUCTION SAFETY: a fake/test hash must NEVER be produced for a live payment.
test('resolveTransactionHash: PRODUCTION (live key) never produces a fake hash (hashless -> null)', () => {
    const p = makeProvider({ apiKey: 'live_prodkey', sandbox: false });
    // Even if q8qpay erroneously flagged a live invoice as isTest, the live key
    // blocks the sandbox fallback.
    const hash = p.resolveTransactionHash({
        webhookTxHash: null,
        verifyTxHash: null,
        verifyIsTest: true,
        providerInvoiceId: 'inv-live'
    });
    assert.strictEqual(hash, null);
});

test('resolveTransactionHash: misconfig (live key + sandbox=true) still cannot fallback', () => {
    const p = makeProvider({ apiKey: 'live_prodkey', sandbox: true });
    const hash = p.resolveTransactionHash({
        webhookTxHash: null,
        verifyTxHash: null,
        verifyIsTest: true,
        providerInvoiceId: 'inv-misconfig'
    });
    assert.strictEqual(hash, null, 'test_ key is required for the sandbox fallback');
});

test('resolveTransactionHash: misconfig (test key + sandbox=false) still cannot fallback', () => {
    const p = makeProvider({ apiKey: 'test_key', sandbox: false });
    const hash = p.resolveTransactionHash({
        webhookTxHash: null,
        verifyTxHash: null,
        verifyIsTest: true,
        providerInvoiceId: 'inv-misconfig2'
    });
    assert.strictEqual(hash, null, 'Q8QPAY_SANDBOX=true is required for the sandbox fallback');
});

test('resolveTransactionHash: sandbox config but isTest=false -> null (isTest not trusted alone)', () => {
    const p = makeProvider({ apiKey: 'test_key', sandbox: true });
    const hash = p.resolveTransactionHash({
        webhookTxHash: null,
        verifyTxHash: null,
        verifyIsTest: false,
        providerInvoiceId: 'inv-notest'
    });
    assert.strictEqual(hash, null);
});

test('resolveTransactionHash: empty-string tx hashes are treated as absent', () => {
    const p = makeProvider({ apiKey: 'live_prodkey', sandbox: false });
    const hash = p.resolveTransactionHash({
        webhookTxHash: '',
        verifyTxHash: '',
        verifyIsTest: false,
        providerInvoiceId: 'inv-empty'
    });
    assert.strictEqual(hash, null);
});

// ---------------------------------------------------------------------------
// parsePaymentData — tx_hash / txHash mapping
// ---------------------------------------------------------------------------

test('parsePaymentData: maps snake_case tx_hash from the webhook payload', () => {
    const p = makeProvider();
    const data = p.parsePaymentData({
        invoice_id: 'q8q-uuid',
        invoice_reference: 'ARB-REF-1',
        status: 'confirmed',
        asset_code: 'USDT_TRC20',
        payout_address: 'TXyz123',
        amount_usdt_exact: '150.0000',
        tx_hash: '0xabc123',
        paid_at: '2024-01-15T14:32:00Z',
        type: 'invoice.confirmed',
        metadata: { arbitrixUserId: 'u1' }
    });
    assert.strictEqual(data.invoiceId, 'ARB-REF-1');
    assert.strictEqual(data.providerInvoiceId, 'q8q-uuid');
    assert.strictEqual(data.walletAddress, 'TXyz123');
    assert.strictEqual(data.amount, '150.0000');
    assert.strictEqual(data.transactionHash, '0xabc123');
    assert.strictEqual(data.status, 'confirmed');
    assert.strictEqual(data.type, 'invoice.confirmed');
    assert.deepStrictEqual(data.metadata, { arbitrixUserId: 'u1' });
});

test('parsePaymentData: maps camelCase txHash (q8qpay simulate/verify response field)', () => {
    const p = makeProvider();
    const data = p.parsePaymentData({
        invoice_id: 'q8q-uuid',
        invoice_reference: 'ARB-REF-2',
        status: 'confirmed',
        asset_code: 'USDT_TRC20',
        payout_address: 'TXyz456',
        amount_usdt_exact: '50.0020',
        txHash: 'sandbox_tx_abc123',
        paid_at: '2024-01-15T14:32:00Z',
        type: 'invoice.confirmed'
    });
    assert.strictEqual(data.transactionHash, 'sandbox_tx_abc123');
});

test('parsePaymentData: missing transaction hash yields undefined (not a fake value)', () => {
    const p = makeProvider();
    const data = p.parsePaymentData({
        invoice_id: 'q8q-uuid',
        invoice_reference: 'ARB-REF-3',
        status: 'confirmed',
        asset_code: 'USDT_TRC20',
        payout_address: 'TXyz789',
        amount_usdt_exact: '50.0000'
    });
    assert.strictEqual(data.transactionHash, undefined);
});

test('parsePaymentData: tx_hash takes precedence over txHash', () => {
    const p = makeProvider();
    const data = p.parsePaymentData({
        invoice_reference: 'ARB-REF-4',
        status: 'confirmed',
        tx_hash: '0xsnake',
        txHash: '0xcamel'
    });
    assert.strictEqual(data.transactionHash, '0xsnake');
});

// ---------------------------------------------------------------------------
// parseWebhookEvent — status -> internal event mapping
// ---------------------------------------------------------------------------

test('parseWebhookEvent: confirmed -> payment_confirmed', () => {
    const p = makeProvider();
    assert.strictEqual(p.parseWebhookEvent({ status: 'confirmed', type: 'invoice.confirmed' }), 'payment_confirmed');
});

test('parseWebhookEvent: pending -> payment_pending', () => {
    const p = makeProvider();
    assert.strictEqual(p.parseWebhookEvent({ status: 'pending' }), 'payment_pending');
});

test('parseWebhookEvent: expired -> invoice_expired', () => {
    const p = makeProvider();
    assert.strictEqual(p.parseWebhookEvent({ status: 'expired', type: 'invoice.expired' }), 'invoice_expired');
});

test('parseWebhookEvent: cancelled -> payment_cancelled', () => {
    const p = makeProvider();
    assert.strictEqual(p.parseWebhookEvent({ status: 'cancelled' }), 'payment_cancelled');
});

test('parseWebhookEvent: unknown status -> unknown_status_*', () => {
    const p = makeProvider();
    assert.strictEqual(p.parseWebhookEvent({ status: 'something_else' }), 'unknown_status_something_else');
});

// ---------------------------------------------------------------------------
// verifyWebhook — HMAC-SHA256 signature verification
// ---------------------------------------------------------------------------

test('verifyWebhook: accepts a correctly signed raw body', async () => {
    const p = makeProvider();
    const raw = JSON.stringify({ invoice_reference: 'ARB-1', status: 'confirmed', tx_hash: '0x1' });
    assert.strictEqual(await p.verifyWebhook(raw, sign(raw)), true);
});

test('verifyWebhook: rejects an invalid signature (401 path)', async () => {
    const p = makeProvider();
    const raw = JSON.stringify({ invoice_reference: 'ARB-1', status: 'confirmed' });
    assert.strictEqual(await p.verifyWebhook(raw, 'deadbeef'.repeat(8)), false);
});

test('verifyWebhook: rejects a missing signature', async () => {
    const p = makeProvider();
    const raw = JSON.stringify({ invoice_reference: 'ARB-1', status: 'confirmed' });
    assert.strictEqual(await p.verifyWebhook(raw, undefined), false);
});

test('verifyWebhook: rejects everything when no webhook secret is configured', async () => {
    const p = new Q8QPayProvider();
    p.initialize({ apiKey: 'live_key', webhookSecret: '', sandbox: false });
    const raw = JSON.stringify({ status: 'confirmed' });
    assert.strictEqual(await p.verifyWebhook(raw, sign(raw)), false);
});

test('verifyWebhook: signature is over the RAW bytes (whitespace changes break it)', async () => {
    const p = makeProvider();
    const signed = JSON.stringify({ status: 'confirmed', tx_hash: '0x1' });
    // Same JSON, different formatting -> different raw bytes -> must fail.
    const reformatted = '{\n  "status": "confirmed",\n  "tx_hash": "0x1"\n}';
    assert.strictEqual(await p.verifyWebhook(reformatted, sign(signed)), false);
});

test('verifyWebhook: accepts a Buffer raw body', async () => {
    const p = makeProvider();
    const raw = JSON.stringify({ status: 'confirmed', tx_hash: '0x1' });
    assert.strictEqual(await p.verifyWebhook(Buffer.from(raw, 'utf8'), sign(raw)), true);
});

// ---------------------------------------------------------------------------
// Idempotency invariant (DB-side): the resolved hash feeds UNIQUE(transaction_hash)
// ---------------------------------------------------------------------------

test('idempotency: duplicate sandbox webhook resolves to the SAME hash (dedupable)', () => {
    const p = makeProvider({ apiKey: 'test_key', sandbox: true });
    const first = p.resolveTransactionHash({ webhookTxHash: null, verifyTxHash: null, verifyIsTest: true, providerInvoiceId: 'inv-dup' });
    const second = p.resolveTransactionHash({ webhookTxHash: null, verifyTxHash: null, verifyIsTest: true, providerInvoiceId: 'inv-dup' });
    assert.strictEqual(first, second);
    // A real duplicate webhook for an already-credited invoice is rejected by
    // credit_payment_safe's credited-flag + UNIQUE(transaction_hash) checks;
    // the provider never re-credits.
    assert.ok(first && first.startsWith('q8qpay_sandbox_'));
});

test('Q8QPAY_STATUS exposes the four documented q8qpay statuses', () => {
    assert.strictEqual(Q8QPAY_STATUS.PENDING, 'pending');
    assert.strictEqual(Q8QPAY_STATUS.CONFIRMED, 'confirmed');
    assert.strictEqual(Q8QPAY_STATUS.EXPIRED, 'expired');
    assert.strictEqual(Q8QPAY_STATUS.CANCELLED, 'cancelled');
});
