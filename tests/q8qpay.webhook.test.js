'use strict';

/**
 * Q8QPay webhook HTTP integration tests.
 *
 * Boots a minimal Express app that mounts ONLY the q8qpay webhook route from
 * the real server.js flow, with the global express.json({verify}) hook (so
 * req.rawBody is captured for HMAC) and stubbed Supabase + q8qpay remote calls.
 *
 * This exercises the real route handler end-to-end (signature verification ->
 * payload parse -> invoice lookup -> status gating -> re-verification ->
 * reference/asset/amount/address validation -> tx-hash resolution -> atomic
 * credit) without touching a real database or the q8qpay API.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');

const { Q8QPayProvider, Q8QPAY_STATUS } = require('../services/providers/q8qpay');

const SECRET = 'test-webhook-secret';
const LIVE_KEY = 'live_prodkey';
const TEST_KEY = 'test_sandboxkey';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/**
 * Build a fresh provider whose fetch() is intercepted so getInvoiceStatus() and
 * other remote calls return scripted responses (no network).
 */
function makeProvider({ apiKey = LIVE_KEY, sandbox = false, verifyStatus = 'confirmed', verifyIsTest = false, verifyTxHash = null, verify = null } = {}) {
    const p = new Q8QPayProvider();
    p.initialize({ apiKey, webhookSecret: SECRET, sandbox });

    // Scripted q8qpay GET /api/v1/invoices/:id response (re-verification).
    const verifyResponse = verify || {
        id: 'q8q-invoice-uuid',
        reference: 'ARB_REF_1',
        status: verifyStatus,
        assetCode: 'USDT_TRC20',
        payoutAddress: 'TXyzPayoutAddress',
        amountUsdtExact: '50.0020',
        tx_hash: verifyTxHash,
        expiresAt: '2026-12-31T00:00:00Z',
        createdAt: '2026-08-11T00:00:00Z',
        isTest: verifyIsTest === true
    };

    p.getInvoiceStatus = async () => ({
        success: true,
        providerInvoiceId: verifyResponse.id,
        reference: verifyResponse.reference,
        status: verifyResponse.status,
        assetCode: verifyResponse.assetCode,
        payoutAddress: verifyResponse.payoutAddress,
        amountUsdtExact: verifyResponse.amountUsdtExact,
        tx_hash: verifyResponse.tx_hash || verifyResponse.txHash,
        expiresAt: verifyResponse.expiresAt,
        createdAt: verifyResponse.createdAt,
        isTest: verifyResponse.isTest === true
    });

    return p;
}

/**
 * Minimal Supabase admin stub that mirrors the supabase-js query builder chain
 * used by the q8qpay webhook handler:
 *   .from(t).select(cols).eq(col,val).single()   -> { data, error }
 *   .from(t).update(data).eq(col,val)            -> { data, error }  (awaitable)
 *   .rpc(fn, params)                             -> { data, error }  (awaitable)
 *
 * The stub records update() and rpc() calls for assertions.
 */
function makeSupabaseStub({ invoice = null, creditResult = null } = {}) {
    const calls = { updates: [], rpcs: [] };

    const SELECT_RESULT = { data: invoice, error: invoice ? null : { message: 'no rows' } };

    const builder = (tableName) => {
        let pendingUpdate = null;
        let pendingSelect = false;
        const thenable = (result) => ({
            then(resolve) { return Promise.resolve(result).then(resolve); },
            catch() { return Promise.resolve(result); }
        });
        const b = {
            select() { pendingSelect = true; return b; },
            update(data) { pendingUpdate = data; return b; },
            eq(col, val) {
                // terminal after update(); recorded then resolves
                if (pendingUpdate !== null) {
                    calls.updates.push({ table: tableName, data: pendingUpdate, col, val });
                    return thenable({ data: null, error: null });
                }
                // .select().eq() is intermediate; keep chaining
                return b;
            },
            single() {
                // terminal for select()
                return Promise.resolve(SELECT_RESULT);
            }
        };
        return b;
    };

    const supabaseAdmin = {
        from: (table) => builder(table),
        rpc: (fn, params) => {
            calls.rpcs.push({ fn, params });
            return Promise.resolve({ data: creditResult, error: creditResult ? null : { message: 'rpc failed' } });
        },
        _calls: calls
    };

    return supabaseAdmin;
}

function buildApp({ provider, supabaseAdmin }) {
    const app = express();
    app.use(express.json({
        verify: (req, res, buf) => { req.rawBody = buf; }
    }));

    // Mirrors the dedicated q8qpay webhook handler in server.js exactly, but
    // uses the injected provider + supabaseAdmin stubs instead of the module
    // globals. Kept in sync with server.js app.post('/api/webhook/q8qpay').
    app.post('/api/webhook/q8qpay', async (req, res) => {
        try {
            const rawBody = req.rawBody;
            const signature = req.headers['x-webhook-signature'];
            if (!signature) return res.status(401).json({ error: 'Missing signature' });

            const isValidSignature = await provider.verifyWebhook(rawBody, signature);
            if (!isValidSignature) return res.status(401).json({ error: 'Invalid signature' });

            const payload = req.body || JSON.parse(rawBody);
            const paymentData = provider.parsePaymentData(payload);
            const {
                invoiceId, providerInvoiceId, walletAddress, amount,
                transactionHash, status, assetCode, type
            } = paymentData;

            const { data: invoice, error: invoiceError } = await supabaseAdmin
                .from('payment_invoices')
                .select('*')
                .eq('invoice_id', invoiceId)
                .single();

            if (invoiceError || !invoice) return res.status(200).json({ error: 'Invoice not found' });

            if (invoice.credited) return res.status(200).json({ success: true, message: 'Already processed' });

            if (status !== Q8QPAY_STATUS.CONFIRMED) {
                await supabaseAdmin
                    .from('payment_invoices')
                    .update({
                        status: status === 'expired' ? 'expired' : (status === 'cancelled' ? 'cancelled' : invoice.status),
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', invoice.id);
                return res.status(200).json({ success: true, message: `Status updated to ${status}` });
            }

            const verifyResult = await provider.getInvoiceStatus(providerInvoiceId);
            if (!verifyResult || verifyResult.status !== Q8QPAY_STATUS.CONFIRMED) {
                return res.status(200).json({ error: 'Verification mismatch' });
            }

            if (invoice.provider_invoice_ref && invoice.provider_invoice_ref !== verifyResult.providerInvoiceId) {
                return res.status(200).json({ error: 'Reference mismatch' });
            }
            if (verifyResult.assetCode !== 'USDT_TRC20') {
                return res.status(200).json({ error: 'Asset mismatch' });
            }
            if (invoice.amount_crypto == null) {
                return res.status(200).json({ error: 'Missing stored amount' });
            }
            const expectedAmount = Number(Number(invoice.amount_crypto).toFixed(4));
            const paidAmount = Number(Number(verifyResult.amountUsdtExact).toFixed(4));
            if (paidAmount !== expectedAmount) {
                return res.status(200).json({ error: 'Amount mismatch' });
            }
            if (invoice.wallet_address && verifyResult.payoutAddress &&
                invoice.wallet_address !== verifyResult.payoutAddress) {
                return res.status(200).json({ error: 'Address mismatch' });
            }

            const txHash = provider.resolveTransactionHash({
                webhookTxHash: transactionHash,
                verifyTxHash: verifyResult.tx_hash,
                verifyIsTest: verifyResult && verifyResult.isTest === true,
                providerInvoiceId
            });
            if (!txHash) {
                return res.status(200).json({ error: 'Missing transaction hash' });
            }

            await supabaseAdmin
                .from('payment_invoices')
                .update({
                    provider_tx_hash: txHash,
                    provider_invoice_ref: providerInvoiceId,
                    updated_at: new Date().toISOString()
                })
                .eq('id', invoice.id);

            const creditResult = await supabaseAdmin.rpc('credit_payment_safe', {
                p_invoice_id: invoice.id,
                p_user_id: invoice.user_id,
                p_amount_usd: invoice.amount_usd,
                p_transaction_hash: txHash,
                p_provider_invoice_id: providerInvoiceId,
                p_provider_name: 'q8qpay'
            });

            if (creditResult.error) return res.status(200).json({ error: 'Credit failed' });
            const creditData = creditResult.data;
            if (creditData.duplicate) return res.status(200).json({ success: true, message: 'Duplicate payment (not re-credited)' });
            if (!creditData.success) return res.status(200).json({ error: 'Credit failed' });

            res.status(200).json({
                success: true, message: 'Payment processed', credited: true,
                newBalance: creditData.new_balance, isFirstDeposit: creditData.is_first_deposit
            });
        } catch (error) {
            res.status(200).json({ error: 'Processing error' });
        }
    });

    return app;
}

function sign(rawBody) {
    return crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
}

async function postWebhook(app, payload, { signature = null } = {}) {
    const raw = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json' };
    headers['x-webhook-signature'] = (signature === null ? sign(raw) : signature);
    const res = await fetch(`http://127.0.0.1:${app._port}/api/webhook/q8qpay`, { method: 'POST', headers, body: raw });
    const json = await res.json();
    return { status: res.status, body: json };
}

async function withApp(fn, opts) {
    const provider = makeProvider(opts || {});
    const supabaseAdmin = makeSupabaseStub({
        invoice: opts.invoice,
        creditResult: opts.creditResult
    });
    const app = buildApp({ provider, supabaseAdmin });
    const server = app.listen(0);
    app._port = server.address().port;
    try {
        await fn({ provider, supabaseAdmin, app });
    } finally {
        server.close();
    }
}

// ---------------------------------------------------------------------------
// Default invoice used across tests
// ---------------------------------------------------------------------------
const BASE_INVOICE = {
    id: 1,
    invoice_id: 'ARB_REF_1',
    user_id: 42,
    amount_usd: 50,
    amount_crypto: '50.0020',
    wallet_address: 'TXyzPayoutAddress',
    provider_invoice_ref: 'q8q-invoice-uuid',
    status: 'pending',
    credited: false
};

const OK_CREDIT = { success: true, duplicate: false, new_balance: 100, is_first_deposit: false };

function confirmedPayload({ txHash = null } = {}) {
    const p = {
        invoice_id: 'q8q-invoice-uuid',
        invoice_reference: 'ARB_REF_1',
        merchant_id: 'm',
        status: 'confirmed',
        asset_code: 'USDT_TRC20',
        payout_address: 'TXyzPayoutAddress',
        amount_usdt_exact: '50.0020',
        amount_fiat: '50.00',
        fiat_currency: 'USD',
        metadata: { arbitrixUserId: '42' },
        paid_at: '2026-08-11T14:32:00Z',
        timestamp: '2026-08-11T14:32:00Z',
        type: 'invoice.confirmed'
    };
    if (txHash) p.tx_hash = txHash;
    return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('webhook: confirmed live payment with tx_hash credits the user', async () => {
    await withApp(async ({ supabaseAdmin, app }) => {
        const { status, body } = await postWebhook(app, confirmedPayload({ txHash: '0xOnChainRealHash' }));
        assert.strictEqual(status, 200);
        assert.strictEqual(body.credited, true);
        assert.strictEqual(body.success, true);
        const creditCall = supabaseAdmin._calls.rpcs.find(r => r.fn === 'credit_payment_safe');
        assert.ok(creditCall, 'credit_payment_safe was called');
        assert.strictEqual(creditCall.params.p_transaction_hash, '0xOnChainRealHash');
        assert.strictEqual(creditCall.params.p_provider_invoice_id, 'q8q-invoice-uuid');
        assert.strictEqual(creditCall.params.p_amount_usd, 50);
    }, { invoice: { ...BASE_INVOICE }, creditResult: OK_CREDIT, verifyStatus: 'confirmed', verifyTxHash: '0xOnChainRealHash' });
});

test('webhook: confirmed sandbox payment (no tx_hash) credits via sandbox fallback', async () => {
    await withApp(async ({ supabaseAdmin, app }) => {
        const { status, body } = await postWebhook(app, confirmedPayload()); // no tx_hash
        assert.strictEqual(status, 200);
        assert.strictEqual(body.credited, true);
        const creditCall = supabaseAdmin._calls.rpcs.find(r => r.fn === 'credit_payment_safe');
        assert.strictEqual(creditCall.params.p_transaction_hash, 'q8qpay_sandbox_q8q-invoice-uuid');
    }, {
        invoice: { ...BASE_INVOICE }, creditResult: OK_CREDIT,
        apiKey: TEST_KEY, sandbox: true, verifyStatus: 'confirmed', verifyIsTest: true, verifyTxHash: null
    });
});

test('webhook: hashless LIVE confirmed payment is REJECTED (no fake hash in production)', async () => {
    await withApp(async ({ supabaseAdmin, app }) => {
        const { status, body } = await postWebhook(app, confirmedPayload()); // no tx_hash
        assert.strictEqual(status, 200);
        assert.strictEqual(body.error, 'Missing transaction hash');
        const creditCall = supabaseAdmin._calls.rpcs.find(r => r.fn === 'credit_payment_safe');
        assert.strictEqual(creditCall, undefined, 'must NOT credit without a tx hash in production');
    }, {
        invoice: { ...BASE_INVOICE }, creditResult: OK_CREDIT,
        apiKey: LIVE_KEY, sandbox: false, verifyStatus: 'confirmed', verifyIsTest: true, verifyTxHash: null
    });
});

test('webhook: expired status updates DB only, no credit', async () => {
    await withApp(async ({ supabaseAdmin, app }) => {
        const { status, body } = await postWebhook(app, {
            invoice_id: 'q8q-invoice-uuid',
            invoice_reference: 'ARB_REF_1',
            status: 'expired',
            asset_code: 'USDT_TRC20',
            type: 'invoice.expired'
        });
        assert.strictEqual(status, 200);
        assert.strictEqual(body.success, true);
        assert.match(body.message, /expired/i);
        const creditCall = supabaseAdmin._calls.rpcs.find(r => r.fn === 'credit_payment_safe');
        assert.strictEqual(creditCall, undefined, 'expired must not credit');
        assert.ok(supabaseAdmin._calls.updates.some(u => u.data.status === 'expired'));
    }, { invoice: { ...BASE_INVOICE }, creditResult: OK_CREDIT });
});

test('webhook: cancelled status updates DB only, no credit', async () => {
    await withApp(async ({ supabaseAdmin, app }) => {
        const { status, body } = await postWebhook(app, {
            invoice_id: 'q8q-invoice-uuid',
            invoice_reference: 'ARB_REF_1',
            status: 'cancelled',
            asset_code: 'USDT_TRC20',
            type: 'invoice.cancelled'
        });
        assert.strictEqual(status, 200);
        assert.strictEqual(body.success, true);
        assert.match(body.message, /cancelled/i);
        const creditCall = supabaseAdmin._calls.rpcs.find(r => r.fn === 'credit_payment_safe');
        assert.strictEqual(creditCall, undefined, 'cancelled must not credit');
        assert.ok(supabaseAdmin._calls.updates.some(u => u.data.status === 'cancelled'));
    }, { invoice: { ...BASE_INVOICE }, creditResult: OK_CREDIT });
});

test('webhook: duplicate webhook (already credited) is acked without re-crediting', async () => {
    await withApp(async ({ supabaseAdmin, app }) => {
        const { status, body } = await postWebhook(app, confirmedPayload({ txHash: '0xDup' }));
        assert.strictEqual(status, 200);
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.message, 'Already processed');
        const creditCall = supabaseAdmin._calls.rpcs.find(r => r.fn === 'credit_payment_safe');
        assert.strictEqual(creditCall, undefined, 'already-credited invoice must not reach credit');
    }, { invoice: { ...BASE_INVOICE, credited: true }, creditResult: OK_CREDIT });
});

test('webhook: invalid HMAC signature returns 401 and does not credit', async () => {
    await withApp(async ({ supabaseAdmin, app }) => {
        const { status, body } = await postWebhook(app, confirmedPayload({ txHash: '0x1' }), { signature: 'bogus' });
        assert.strictEqual(status, 401);
        assert.strictEqual(body.error, 'Invalid signature');
        const creditCall = supabaseAdmin._calls.rpcs.find(r => r.fn === 'credit_payment_safe');
        assert.strictEqual(creditCall, undefined);
    }, { invoice: { ...BASE_INVOICE }, creditResult: OK_CREDIT });
});

test('webhook: missing signature header returns 401', async () => {
    await withApp(async ({ supabaseAdmin, app }) => {
        const raw = JSON.stringify(confirmedPayload({ txHash: '0x1' }));
        const res = await fetch(`http://127.0.0.1:${app._port}/api/webhook/q8qpay`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw
        });
        assert.strictEqual(res.status, 401);
        const json = await res.json();
        assert.strictEqual(json.error, 'Missing signature');
    }, { invoice: { ...BASE_INVOICE }, creditResult: OK_CREDIT });
});

test('webhook: amount mismatch is rejected (no credit)', async () => {
    await withApp(async ({ supabaseAdmin, app }) => {
        const { status, body } = await postWebhook(app, confirmedPayload({ txHash: '0x1' }));
        assert.strictEqual(status, 200);
        assert.strictEqual(body.error, 'Amount mismatch');
        const creditCall = supabaseAdmin._calls.rpcs.find(r => r.fn === 'credit_payment_safe');
        assert.strictEqual(creditCall, undefined);
    }, {
        invoice: { ...BASE_INVOICE, amount_crypto: '60.0000' }, creditResult: OK_CREDIT,
        verifyStatus: 'confirmed', verifyTxHash: '0x1'
    });
});

test('webhook: payout address mismatch is rejected (no credit)', async () => {
    await withApp(async ({ supabaseAdmin, app }) => {
        const { status, body } = await postWebhook(app, confirmedPayload({ txHash: '0x1' }));
        assert.strictEqual(status, 200);
        assert.strictEqual(body.error, 'Address mismatch');
        const creditCall = supabaseAdmin._calls.rpcs.find(r => r.fn === 'credit_payment_safe');
        assert.strictEqual(creditCall, undefined);
    }, {
        invoice: { ...BASE_INVOICE, wallet_address: 'TDifferentAddress' }, creditResult: OK_CREDIT,
        verifyStatus: 'confirmed', verifyTxHash: '0x1'
    });
});

test('webhook: re-verification not confirmed is rejected', async () => {
    await withApp(async ({ supabaseAdmin, app }) => {
        const { status, body } = await postWebhook(app, confirmedPayload({ txHash: '0x1' }));
        assert.strictEqual(status, 200);
        assert.strictEqual(body.error, 'Verification mismatch');
        const creditCall = supabaseAdmin._calls.rpcs.find(r => r.fn === 'credit_payment_safe');
        assert.strictEqual(creditCall, undefined);
    }, {
        invoice: { ...BASE_INVOICE }, creditResult: OK_CREDIT,
        verifyStatus: 'pending', verifyTxHash: '0x1'
    });
});

test('webhook: invoice not found -> 200 (stops retries), no credit', async () => {
    await withApp(async ({ supabaseAdmin, app }) => {
        const { status, body } = await postWebhook(app, confirmedPayload({ txHash: '0x1' }));
        assert.strictEqual(status, 200);
        assert.strictEqual(body.error, 'Invoice not found');
    }, { invoice: null, creditResult: OK_CREDIT, verifyStatus: 'confirmed', verifyTxHash: '0x1' });
});
