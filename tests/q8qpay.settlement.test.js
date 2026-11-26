'use strict';

/**
 * The q8qpay settlement pipeline, unit level.
 *
 * The route that calls it is covered end to end in
 * tests/q8qpay.webhook.e2e.test.js (real server, real signature, real ack). This
 * file pins the CONTRACT of services/q8qpaySettlement.js and the provider helpers
 * it leans on, so a future change to either has to be deliberate:
 *
 *   - the provider is the only authority on "confirmed";
 *   - an amount is compared to 4 decimals and never "approximately";
 *   - the credit is called exactly once with a hash that came from the provider;
 *   - every outcome carries an explicit retry / review policy.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { Q8QPayProvider } = require('../services/providers/q8qpay');
const {
    createQ8qpaySettlement,
    OUTCOMES,
    sameExactAmount
} = require('../services/q8qpaySettlement');

const SECRET = 'unit-secret';
const HASH = 'b'.repeat(64);

const INVOICE = {
    id: 11,
    invoice_id: 'ARB_UNIT_1',
    user_id: 3,
    amount_usd: 50,
    amount_crypto: '50.0020',
    wallet_address: 'TPayout',
    provider_invoice_ref: 'q8q-unit-1',
    status: 'pending',
    credited: false
};

function makeProvider(overrides = {}) {
    const p = new Q8QPayProvider();
    p.initialize({ apiKey: 'live_unit', webhookSecret: SECRET, sandbox: false });
    p.getInvoiceStatus = async () => Object.assign({
        success: true,
        providerInvoiceId: 'q8q-unit-1',
        reference: 'ARB_UNIT_1',
        status: 'confirmed',
        assetCode: 'USDT_TRC20',
        payoutAddress: 'TPayout',
        amountUsdtExact: '50.0020',
        tx_hash: HASH,
        isTest: false
    }, overrides);
    return p;
}

function makeDb({ credit = { success: true, new_balance: 50.002, is_first_deposit: true }, rpcThrows = null } = {}) {
    const calls = { rpcs: [], updates: [] };
    return {
        calls,
        from(table) {
            return {
                update(data) {
                    return {
                        eq(col, val) {
                            calls.updates.push({ table, data, col, val });
                            return Promise.resolve({ data: null, error: null });
                        }
                    };
                }
            };
        },
        async rpc(fn, params) {
            calls.rpcs.push({ fn, params });
            if (rpcThrows) throw new Error(rpcThrows);
            return { data: credit, error: null };
        }
    };
}

function pipeline(overrides = {}) {
    const db = makeDb(overrides.db);
    const provider = overrides.provider || makeProvider(overrides.providerOverrides);
    const engine = createQ8qpaySettlement({ db, provider });
    return { db, provider, engine };
}

// ---------------------------------------------------------------------------
// Happy path contract
// ---------------------------------------------------------------------------

test('a provider-confirmed payment credits once, with the provider hash', async () => {
    const { db, engine } = pipeline();
    const { outcome, details } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'credited');
    assert.strictEqual(details.txHash, HASH);
    assert.strictEqual(db.calls.rpcs.length, 1);
    assert.deepStrictEqual(db.calls.rpcs[0].params, {
        p_invoice_id: 11,
        p_user_id: 3,
        p_amount_usd: 50,
        p_transaction_hash: HASH,
        p_provider_invoice_id: 'q8q-unit-1',
        p_provider_name: 'q8qpay'
    });
    // Audit fields are written BEFORE the credit so a race cannot lose them.
    assert.strictEqual(db.calls.updates.length, 1);
    assert.strictEqual(db.calls.updates[0].data.provider_tx_hash, HASH);
});

// ---------------------------------------------------------------------------
// Transaction hash: which value reaches credit_payment_safe (security review).
//
// The hash is the credit's idempotency key AND the ledger's audit link, so the value
// that lands in the database has to be the one the PROVIDER vouches for. A webhook
// hash is second-hand: signature-verified, but still a copy of what the provider
// said in one message rather than what its invoice record says now.
// ---------------------------------------------------------------------------

test('1. matching hashes: the provider-verified hash is credited, and labelled as such', async () => {
    const { db, engine } = pipeline();
    const { outcome, details } = await engine.settle({
        invoice: INVOICE, providerInvoiceId: 'q8q-unit-1',
        webhookTxHash: HASH, webhookAttested: true
    });
    assert.strictEqual(outcome.code, 'credited');
    assert.strictEqual(details.txHash, HASH);
    assert.strictEqual(details.hashSource, 'provider', 'the provider source wins the credit record');
    assert.strictEqual(db.calls.rpcs[0].params.p_transaction_hash, HASH);
});

test('2. DISAGREEING hashes: nothing is credited and both values are recorded for review', async () => {
    const { db, engine } = pipeline();
    const { outcome, details } = await engine.settle({
        invoice: INVOICE, providerInvoiceId: 'q8q-unit-1',
        webhookTxHash: 'c'.repeat(64), webhookAttested: true
    });
    assert.strictEqual(outcome.code, 'tx_hash_mismatch');
    assert.strictEqual(outcome.needsReview, true);
    assert.strictEqual(outcome.transient, false, 'replaying the delivery cannot resolve a disagreement');
    assert.strictEqual(outcome.httpStatus, 200);
    assert.strictEqual(db.calls.rpcs.length, 0, 'no credit');
    assert.strictEqual(details.providerTxHash, HASH);
    assert.strictEqual(details.webhookTxHash, 'c'.repeat(64));
    assert.strictEqual(details.reason, 'webhook-hash-differs-from-provider-hash');
});

test('3. webhook hash only, UNATTESTED: refused (no unsafe fallback to an unverified value)', async () => {
    const { db, engine } = pipeline({ providerOverrides: { tx_hash: null } });
    const { outcome } = await engine.settle({
        invoice: INVOICE, providerInvoiceId: 'q8q-unit-1',
        webhookTxHash: 'c'.repeat(64), webhookAttested: false
    });
    assert.strictEqual(outcome.code, 'missing_tx_hash');
    assert.strictEqual(outcome.transient, true);
    assert.strictEqual(db.calls.rpcs.length, 0);
});

test('3b. webhook hash only, ATTESTED (HMAC-verified delivery): accepted and labelled', async () => {
    const { db, engine } = pipeline({ providerOverrides: { tx_hash: null } });
    const { outcome, details } = await engine.settle({
        invoice: INVOICE, providerInvoiceId: 'q8q-unit-1',
        webhookTxHash: 'c'.repeat(64), webhookAttested: true
    });
    assert.strictEqual(outcome.code, 'credited');
    assert.strictEqual(details.txHash, 'c'.repeat(64));
    assert.strictEqual(details.hashSource, 'webhook-attested',
        'a reviewer must be able to tell this hash did not come from the provider API');
    assert.strictEqual(db.calls.rpcs[0].params.p_transaction_hash, 'c'.repeat(64));
});

test('4. provider hash only (no webhook hash): the provider hash is credited', async () => {
    const { db, engine } = pipeline();
    const { outcome, details } = await engine.settle({
        invoice: INVOICE, providerInvoiceId: 'q8q-unit-1', webhookTxHash: null, webhookAttested: true
    });
    assert.strictEqual(outcome.code, 'credited');
    assert.strictEqual(details.txHash, HASH);
    assert.strictEqual(details.hashSource, 'provider');
    assert.strictEqual(db.calls.rpcs[0].params.p_transaction_hash, HASH);
});

test('4b. the same hash written differently is NOT a disagreement (case, 0x, whitespace)', async () => {
    const { db, engine } = pipeline({ providerOverrides: { tx_hash: HASH.toUpperCase() } });
    const { outcome, details } = await engine.settle({
        invoice: INVOICE, providerInvoiceId: 'q8q-unit-1',
        webhookTxHash: '  0x' + HASH + '\n', webhookAttested: true
    });
    assert.strictEqual(outcome.code, 'credited', 'presentation differences must not block a real payment');
    assert.strictEqual(details.hashSource, 'provider');
    assert.strictEqual(db.calls.rpcs[0].params.p_transaction_hash, HASH.toUpperCase(),
        'the provider value is what gets recorded');
});

test('4c. hash comparison is identity-only: a one-character difference is a mismatch', async () => {
    const mutated = HASH.slice(0, -1) + (HASH.endsWith('b') ? 'c' : 'b');
    const { db, engine } = pipeline();
    const { outcome } = await engine.settle({
        invoice: INVOICE, providerInvoiceId: 'q8q-unit-1',
        webhookTxHash: mutated, webhookAttested: true
    });
    assert.strictEqual(outcome.code, 'tx_hash_mismatch');
    assert.strictEqual(db.calls.rpcs.length, 0);
});

test('4d. the mismatch guard runs before the credit, never after', async () => {
    const { db, engine } = pipeline();
    await engine.settle({
        invoice: INVOICE, providerInvoiceId: 'q8q-unit-1',
        webhookTxHash: 'd'.repeat(64), webhookAttested: true
    });
    assert.strictEqual(db.calls.updates.length, 0, 'not even the audit pre-write happened');
    assert.strictEqual(db.calls.rpcs.length, 0);
});

test('an already-credited invoice short-circuits without a provider call or a credit', async () => {
    let providerCalls = 0;
    const provider = makeProvider();
    provider.getInvoiceStatus = async () => { providerCalls += 1; return { status: 'confirmed' }; };
    const db = makeDb();
    const engine = createQ8qpaySettlement({ db, provider });
    const { outcome } = await engine.settle({ invoice: Object.assign({}, INVOICE, { credited: true }), providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'already_credited');
    assert.strictEqual(providerCalls, 0);
    assert.strictEqual(db.calls.rpcs.length, 0);
});

test('a duplicate RPC result is reported as duplicate, not as a failure', async () => {
    const { engine } = pipeline({ db: { credit: { duplicate: true } } });
    const { outcome } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'duplicate');
    assert.strictEqual(outcome.httpStatus, 200);
});

// ---------------------------------------------------------------------------
// The provider is the only authority
// ---------------------------------------------------------------------------

test('our own status column cannot authorise a credit (provider says pending)', async () => {
    const { db, engine } = pipeline({ providerOverrides: { status: 'pending' } });
    const { outcome } = await engine.settle({
        invoice: Object.assign({}, INVOICE, { status: 'confirmed' }),
        providerInvoiceId: 'q8q-unit-1'
    });
    assert.strictEqual(outcome.code, 'provider_not_confirmed');
    assert.strictEqual(outcome.httpStatus, 500, 'retryable: the provider may confirm moments later');
    assert.strictEqual(db.calls.rpcs.length, 0);
});

test('a malformed provider response is not treated as confirmed', async () => {
    const provider = makeProvider();
    provider.getInvoiceStatus = async () => null;
    const db = makeDb();
    const engine = createQ8qpaySettlement({ db, provider });
    const { outcome } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'provider_not_confirmed');
    assert.strictEqual(db.calls.rpcs.length, 0);
});

test('a provider lookup that throws is retryable and records the cause', async () => {
    const provider = makeProvider();
    provider.getInvoiceStatus = async () => { throw new Error('ETIMEDOUT'); };
    const db = makeDb();
    const engine = createQ8qpaySettlement({ db, provider });
    const { outcome, details } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'verify_failed');
    assert.strictEqual(outcome.transient, true);
    assert.match(details.error, /ETIMEDOUT/);
    assert.strictEqual(db.calls.rpcs.length, 0);
});

// ---------------------------------------------------------------------------
// Identity, asset, amount, address, hash
// ---------------------------------------------------------------------------

test('a stored provider reference that disagrees with the provider is refused', async () => {
    const { db, engine } = pipeline({ providerOverrides: { providerInvoiceId: 'OTHER' } });
    const { outcome } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'reference_mismatch');
    assert.strictEqual(db.calls.rpcs.length, 0);
});

test('the provider reference must be OUR invoice id', async () => {
    const { engine } = pipeline({ providerOverrides: { reference: 'SOMEONE_ELSE' } });
    const { outcome } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'reference_mismatch');
});

test('when the stored provider ref is missing the provider id must still be the requested one', async () => {
    const { engine } = pipeline({ providerOverrides: { providerInvoiceId: 'OTHER' } });
    const invoice = Object.assign({}, INVOICE, { provider_invoice_ref: null });
    const { outcome } = await engine.settle({ invoice, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'reference_mismatch');
});

test('only USDT_TRC20 is a Kalderix deposit asset', async () => {
    const { engine } = pipeline({ providerOverrides: { assetCode: 'USDT_ERC20' } });
    const { outcome } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'asset_mismatch');
});

test('the amount is compared to 4 decimals - never approximately', async () => {
    assert.strictEqual(sameExactAmount('50.0020', '50.002'), true);
    assert.strictEqual(sameExactAmount(50.002, '50.0020'), true);
    assert.strictEqual(sameExactAmount('50.0020', '50.0021'), false);
    assert.strictEqual(sameExactAmount('50.0020', '50.0000'), false);
    assert.strictEqual(sameExactAmount('50.0020', null), false);
    assert.strictEqual(sameExactAmount(undefined, '50.0000'), false);

    // A one-hundredth-of-a-cent difference is still a mismatch.
    const { db, engine } = pipeline({ providerOverrides: { amountUsdtExact: '50.0021' } });
    const { outcome, details } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'amount_mismatch');
    assert.strictEqual(details.storedAmountCrypto, '50.0020');
    assert.strictEqual(details.providerAmountUsdtExact, '50.0021');
    assert.strictEqual(db.calls.rpcs.length, 0);
});

test('the payout address must match when both sides have one', async () => {
    const { engine } = pipeline({ providerOverrides: { payoutAddress: 'TElsewhere' } });
    const { outcome } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'address_mismatch');
});

test('an invoice with no stored address still settles on amount + reference', async () => {
    const { engine } = pipeline();
    const invoice = Object.assign({}, INVOICE, { wallet_address: null });
    const { outcome } = await engine.settle({ invoice, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'credited');
});

test('no hash means no credit, ever', async () => {
    const { db, engine } = pipeline({ providerOverrides: { tx_hash: null } });
    const { outcome } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'missing_tx_hash');
    assert.strictEqual(outcome.transient, true);
    assert.strictEqual(db.calls.rpcs.length, 0);
});

test('a live invoice can never be credited with the sandbox hash', async () => {
    // Q8QPAY_SANDBOX=false + a live_ key: the sandbox fallback must not fire even
    // when the provider claims the invoice is a test invoice.
    const { db, engine } = pipeline({
        providerOverrides: { tx_hash: null, isTest: true }
    });
    const { outcome, details } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'missing_tx_hash');
    assert.strictEqual(details.txHash, undefined);
    assert.strictEqual(db.calls.rpcs.length, 0);
});

test('a sandbox invoice produces a deterministic sandbox hash (test mode only)', async () => {
    const provider = new Q8QPayProvider();
    provider.initialize({ apiKey: 'test_unit', webhookSecret: SECRET, sandbox: true });
    provider.getInvoiceStatus = async () => ({
        providerInvoiceId: 'q8q-unit-1',
        reference: 'ARB_UNIT_1',
        status: 'confirmed',
        assetCode: 'USDT_TRC20',
        payoutAddress: 'TPayout',
        amountUsdtExact: '50.0020',
        tx_hash: null,
        isTest: true
    });
    const db = makeDb();
    const engine = createQ8qpaySettlement({ db, provider });
    const { outcome, details } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'credited');
    assert.strictEqual(details.txHash, 'q8qpay_sandbox_q8q-unit-1');
});

// ---------------------------------------------------------------------------
// Failure containment
// ---------------------------------------------------------------------------

test('an RPC that throws is a retryable credit failure, not an exception', async () => {
    const { engine } = pipeline({ db: { rpcThrows: 'connection reset' } });
    const { outcome, details } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'credit_failed');
    assert.strictEqual(outcome.transient, true);
    assert.match(details.error, /connection reset/);
});

test('an RPC that returns success:false is a retryable credit failure', async () => {
    const { engine } = pipeline({ db: { credit: { success: false, error: 'invoice already credited' } } });
    const { outcome } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'credit_failed');
});

test('an audit write that THROWS does not block the credit but is reported', async () => {
    const db = makeDb();
    db.from = () => ({ update: () => ({ eq: () => { throw new Error('audit write failed'); } }) });
    const engine = createQ8qpaySettlement({ db, provider: makeProvider() });
    const { outcome, details } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'credited', 'the money still moves through the atomic RPC');
    assert.strictEqual(db.calls.rpcs.length, 1);
    assert.match(details.auditError, /audit write failed/, 'the loss is carried, never hidden');
});

test('an audit write that RESOLVES with { error } is also reported (supabase-js does not throw)', async () => {
    const db = makeDb();
    db.from = () => ({
        update: () => ({
            eq: () => Promise.resolve({ data: null, error: { message: 'permission denied for table payment_invoices' } })
        })
    });
    const engine = createQ8qpaySettlement({ db, provider: makeProvider() });
    const { outcome, details } = await engine.settle({ invoice: INVOICE, providerInvoiceId: 'q8q-unit-1' });
    assert.strictEqual(outcome.code, 'credited', 'audit loss must not block a confirmed payment');
    assert.strictEqual(db.calls.rpcs.length, 1);
    assert.match(details.auditError, /permission denied/, 'a resolved { error } is not silently swallowed');
});

test('an invoice without a provider id cannot be verified', async () => {
    const { db, engine } = pipeline();
    const { outcome } = await engine.settle({
        invoice: Object.assign({}, INVOICE, { provider_invoice_ref: null }),
        providerInvoiceId: null
    });
    assert.strictEqual(outcome.code, 'unverifiable');
    assert.strictEqual(outcome.needsReview, true);
    assert.strictEqual(db.calls.rpcs.length, 0);
});

test('the outcome table classifies every state as retryable or finished', () => {
    for (const [name, outcome] of Object.entries(OUTCOMES)) {
        assert.ok(typeof outcome.httpStatus === 'number', name + ' has a status');
        assert.ok(typeof outcome.needsReview === 'boolean', name + ' declares review');
        assert.ok(typeof outcome.transient === 'boolean', name + ' declares retryability');
        // 2xx may only be used when a retry could not change anything.
        if (outcome.httpStatus === 200) assert.strictEqual(outcome.transient, false, name);
        if (outcome.transient) assert.strictEqual(outcome.httpStatus, 500, name);
        // Anything needing a human must be durable, i.e. an outcome we record.
        if (outcome.needsReview) assert.notStrictEqual(outcome.code, 'credited', name);
    }
});

// ---------------------------------------------------------------------------
// Which invoices still need attention
// ---------------------------------------------------------------------------

test('isUnsettled covers pending and our-own-expired invoices, never credited ones', () => {
    const { engine } = pipeline();
    assert.strictEqual(engine.isUnsettled({ status: 'pending', credited: false }), true);
    assert.strictEqual(engine.isUnsettled({ status: 'expired', credited: false }), true);
    assert.strictEqual(engine.isUnsettled({ status: 'pending', credited: true }), false);
    assert.strictEqual(engine.isUnsettled({ status: 'confirmed', credited: true }), false);
    assert.strictEqual(engine.isUnsettled({ status: 'cancelled', credited: false }), false);
    assert.strictEqual(engine.isUnsettled(null), false);
});

// ---------------------------------------------------------------------------
// Provider helpers used by the pipeline
// ---------------------------------------------------------------------------

function providerForSignature(opts = {}) {
    const p = new Q8QPayProvider();
    p.initialize({ apiKey: 'live_unit', webhookSecret: opts.secret === undefined ? SECRET : opts.secret, sandbox: false });
    return p;
}

function hmac(secret, value) {
    return crypto.createHmac('sha256', secret).update(Buffer.from(value, 'utf8')).digest('hex');
}

test('verifyWebhook accepts the raw-byte digest', async () => {
    const raw = JSON.stringify({ a: 1, b: 'x' });
    assert.strictEqual(await providerForSignature().verifyWebhook(Buffer.from(raw), hmac(SECRET, raw)), true);
});

test('verifyWebhook accepts the canonical-JSON digest q8qpay documents', async () => {
    // Wire bytes differ from JSON.stringify(parsed) - what their docs sign.
    const wire = '{ "a" : 1, "b" : "x" }';
    const parsed = JSON.parse(wire);
    const signature = hmac(SECRET, JSON.stringify(parsed));
    assert.strictEqual(await providerForSignature().verifyWebhook(Buffer.from(wire), signature, parsed), true);
});

test('verifyWebhook tolerates presentation noise in the header (prefix, case, spaces)', async () => {
    const raw = JSON.stringify({ invoice_id: 'x' });
    const digest = hmac(SECRET, raw);
    const p = providerForSignature();
    assert.strictEqual(await p.verifyWebhook(Buffer.from(raw), 'sha256=' + digest), true);
    assert.strictEqual(await p.verifyWebhook(Buffer.from(raw), digest.toUpperCase()), true);
    assert.strictEqual(await p.verifyWebhook(Buffer.from(raw), '  ' + digest + '\n'), true);
});

test('verifyWebhook rejects a wrong secret, a missing secret and an empty body', async () => {
    const raw = JSON.stringify({ a: 1 });
    assert.strictEqual(await providerForSignature().verifyWebhook(Buffer.from(raw), hmac('other', raw)), false);
    assert.strictEqual(await providerForSignature({ secret: null }).verifyWebhook(Buffer.from(raw), hmac(SECRET, raw)), false);
    assert.strictEqual(await providerForSignature().verifyWebhook(Buffer.alloc(0), hmac(SECRET, '')), false);
    assert.strictEqual(await providerForSignature().verifyWebhook(Buffer.from(raw), ''), false);
});

test('verifyWebhook never accepts a digest computed over a DIFFERENT body', async () => {
    const raw = JSON.stringify({ amount_usdt_exact: '50.0000' });
    const tampered = JSON.stringify({ amount_usdt_exact: '5000.0000' });
    const signature = hmac(SECRET, raw);
    assert.strictEqual(
        await providerForSignature().verifyWebhook(Buffer.from(tampered), signature, JSON.parse(tampered)),
        false
    );
});

test('parsePaymentData reads the documented snake_case payload', () => {
    const p = providerForSignature();
    const data = p.parsePaymentData({
        invoice_id: 'uuid-1',
        invoice_reference: 'ARB_REF',
        status: 'confirmed',
        asset_code: 'USDT_TRC20',
        payout_address: 'TAddr',
        amount_usdt_exact: '50.0020',
        tx_hash: 'hash-1',
        type: 'invoice.confirmed',
        metadata: { arbitrixDepositRef: 'ARB_REF' }
    });
    assert.strictEqual(data.invoiceId, 'ARB_REF');
    assert.strictEqual(data.providerInvoiceId, 'uuid-1');
    assert.strictEqual(data.walletAddress, 'TAddr');
    assert.strictEqual(data.amount, '50.0020');
    assert.strictEqual(data.assetCode, 'USDT_TRC20');
    assert.strictEqual(data.transactionHash, 'hash-1');
    assert.strictEqual(data.status, 'confirmed');
});

test('parsePaymentData falls back to camelCase aliases and to our own metadata', () => {
    const p = providerForSignature();
    const camel = p.parsePaymentData({
        invoiceId: 'uuid-2',
        reference: 'ARB_REF_2',
        status: 'confirmed',
        assetCode: 'USDT_TRC20',
        payoutAddress: 'TAddr2',
        amountUsdtExact: '10.0000',
        txHash: 'hash-2'
    });
    assert.strictEqual(camel.invoiceId, 'ARB_REF_2');
    assert.strictEqual(camel.providerInvoiceId, 'uuid-2');
    assert.strictEqual(camel.walletAddress, 'TAddr2');
    assert.strictEqual(camel.amount, '10.0000');
    assert.strictEqual(camel.transactionHash, 'hash-2');

    const fromMetadata = p.parsePaymentData({
        invoice_id: 'uuid-3',
        status: 'confirmed',
        metadata: { arbitrixDepositRef: 'ARB_FROM_META' }
    });
    assert.strictEqual(fromMetadata.invoiceId, 'ARB_FROM_META');
});

test('parsePaymentData tolerates an empty or malformed payload', () => {
    const p = providerForSignature();
    const empty = p.parsePaymentData({});
    assert.strictEqual(empty.invoiceId, null);
    assert.strictEqual(empty.providerInvoiceId, null);
    assert.strictEqual(empty.metadata && typeof empty.metadata, 'object');
    const noArg = p.parsePaymentData();
    assert.strictEqual(noArg.invoiceId, null);
});
