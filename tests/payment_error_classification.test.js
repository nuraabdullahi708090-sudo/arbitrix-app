'use strict';

/**
 * PAYMENT ERROR CLASSIFICATION - unit and provider-level.
 *
 * The production incident: every failed invoice creation answered HTTP 400, so the
 * customer read "That amount could not be processed" whatever actually happened
 * (a provider rejection, an exhausted prepaid balance, a suspended key, a rate
 * limit, a 5xx or a timeout). These tests pin the classification the route now
 * depends on, the sanitisation of provider text, and the provider's own behaviour
 * against a stubbed network - including that a $300 and a $1,000 request are sent
 * intact (there is no Kalderix-side cap).
 *
 * Nothing here touches the network: `fetch` is replaced per test.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    PAYMENT_ERROR_CODES: CODES,
    PaymentError,
    sanitizeProviderText,
    classifyProviderResponse,
    classifyProviderThrow,
    classifyUnusableResponse,
    paymentErrorHttpResponse,
    isDefinitiveProviderFailure
} = require('../services/PaymentError');

const { Q8QPayProvider } = require('../services/providers/q8qpay');

// ---------------------------------------------------------------------------
// The classification table
// ---------------------------------------------------------------------------

test('a provider 400/409/422 is a definite refusal: 502, not retryable, not ambiguous', () => {
    for (const status of [400, 409, 422]) {
        const e = classifyProviderResponse(status, '{"error":"bad request"}', 'q8qpay');
        assert.strictEqual(e.code, CODES.PROVIDER_REJECTED, `status ${status}`);
        assert.strictEqual(e.httpStatus, 502);
        assert.strictEqual(e.retryable, false);
        assert.strictEqual(e.ambiguous, false, 'a refused request was not turned into an invoice');
        assert.strictEqual(e.providerStatus, status, 'the provider status is preserved');
    }
});

test('a provider 401/403 is an account problem: 503, not retryable, not ambiguous', () => {
    for (const status of [401, 403]) {
        const e = classifyProviderResponse(status, '{"message":"Account suspended"}', 'q8qpay');
        assert.strictEqual(e.code, CODES.PROVIDER_ACCOUNT);
        assert.strictEqual(e.httpStatus, 503);
        assert.strictEqual(e.retryable, false, 'retrying cannot fix a key or a suspended account');
        assert.strictEqual(e.ambiguous, false);
        assert.strictEqual(e.providerStatus, status);
    }
});

test('a provider 429 is a rate limit: 503, retryable, not ambiguous', () => {
    const e = classifyProviderResponse(429, '{"error":"Too Many Requests"}', 'q8qpay');
    assert.strictEqual(e.code, CODES.PROVIDER_UNAVAILABLE);
    assert.strictEqual(e.httpStatus, 503);
    assert.strictEqual(e.retryable, true);
    assert.strictEqual(e.ambiguous, false);
});

test('a provider 5xx is unavailable AND ambiguous (an invoice may exist)', () => {
    for (const status of [500, 502, 503, 504]) {
        const e = classifyProviderResponse(status, '{"error":"boom"}', 'q8qpay');
        assert.strictEqual(e.code, CODES.PROVIDER_UNAVAILABLE, `status ${status}`);
        assert.strictEqual(e.httpStatus, 503);
        assert.strictEqual(e.retryable, true);
        assert.strictEqual(e.ambiguous, true, `status ${status} may have created an invoice`);
    }
});

test('a provider 408 is a timeout: 503, retryable, ambiguous', () => {
    const e = classifyProviderResponse(408, '', 'q8qpay');
    assert.strictEqual(e.code, CODES.PROVIDER_TIMEOUT);
    assert.strictEqual(e.httpStatus, 503);
    assert.strictEqual(e.retryable, true);
    assert.strictEqual(e.ambiguous, true);
});

test('an unexpected 4xx is treated as a refusal, never as the customer\'s input', () => {
    const e = classifyProviderResponse(404, '{"error":"Not Found"}', 'q8qpay');
    assert.strictEqual(e.code, CODES.PROVIDER_REJECTED);
    assert.strictEqual(e.httpStatus, 502);
    assert.strictEqual(e.ambiguous, false);
});

// ---------------------------------------------------------------------------
// Sanitisation of provider text (logs only)
// ---------------------------------------------------------------------------

test('provider text is stripped of credentials and truncated', () => {
    const raw = [
        'Authorization: Bearer live_pk_abc123456789',
        '{"api_key":"live_9f8e7d6c5b4a","webhook_secret":"s3cr3t-value"}',
        'tx 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    ].join(' ');
    const cleaned = sanitizeProviderText(raw, 120);

    assert.ok(!cleaned.includes('live_pk_abc123456789'), 'the bearer token is gone');
    assert.ok(!cleaned.includes('live_9f8e7d6c5b4a'), 'the api key is gone');
    assert.ok(!cleaned.includes('s3cr3t-value'), 'the webhook secret is gone');
    assert.ok(!cleaned.includes('0123456789abcdef0123456789abcdef'), 'the hex blob is gone');
    assert.ok(cleaned.includes('[redacted]'));
    assert.ok(cleaned.length <= 123, 'truncated with a marker: ' + cleaned.length);
    assert.ok(!/[\r\n]/.test(cleaned), 'single line');
});

test('sanitisation tolerates empty and non-string input', () => {
    assert.strictEqual(sanitizeProviderText(''), '');
    assert.strictEqual(sanitizeProviderText(null), '');
    assert.strictEqual(sanitizeProviderText(undefined), '');
    assert.strictEqual(sanitizeProviderText({}), '[object Object]');
});

test('a provider body never leaks into the message we log or throw', () => {
    const e = classifyProviderResponse(400, '{"error":"insufficient balance","api_key":"live_abcdef123456"}', 'q8qpay');
    assert.ok(!String(e.message).includes('live_abcdef123456'), 'no credential in the message');
    assert.ok(e.message.includes('insufficient balance'), 'the reason survives for diagnosis');
    assert.strictEqual(e.providerMessage.includes('live_abcdef123456'), false);
});

// ---------------------------------------------------------------------------
// Thrown transport failures
// ---------------------------------------------------------------------------

test('an abort/timeout is a retryable 503 and ambiguous', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const e = classifyProviderThrow(abort, 'q8qpay');
    assert.strictEqual(e.code, CODES.PROVIDER_TIMEOUT);
    assert.strictEqual(e.httpStatus, 503);
    assert.strictEqual(e.retryable, true);
    assert.strictEqual(e.ambiguous, true, 'the request may have reached the provider');
});

test('a network failure is a retryable 503 and ambiguous', () => {
    const e = classifyProviderThrow(new TypeError('fetch failed'), 'q8qpay');
    assert.strictEqual(e.code, CODES.PROVIDER_UNAVAILABLE);
    assert.strictEqual(e.httpStatus, 503);
    assert.strictEqual(e.retryable, true);
    assert.strictEqual(e.ambiguous, true);
    assert.ok(e.providerMessage.includes('network error'));
});

test('an already-classified error passes through unchanged', () => {
    const original = classifyProviderResponse(403, '{"message":"Account suspended"}', 'q8qpay');
    assert.strictEqual(classifyProviderThrow(original, 'q8qpay'), original);
});

test('a 2xx with an unusable body is ambiguous: the provider may have created the invoice', () => {
    const e = classifyUnusableResponse('q8qpay', 'missing payoutAddress');
    assert.strictEqual(e.code, CODES.PROVIDER_INVALID_RESPONSE);
    assert.strictEqual(e.httpStatus, 502);
    assert.strictEqual(e.retryable, true);
    assert.strictEqual(e.ambiguous, true);
});

// ---------------------------------------------------------------------------
// HTTP mapping / failed-row safety bit
// ---------------------------------------------------------------------------

test('the HTTP answer carries a stable code, a generic message and no provider text', () => {
    const mapped = paymentErrorHttpResponse(classifyProviderResponse(400, '{"error":"insufficient balance"}', 'q8qpay'));
    assert.strictEqual(mapped.status, 502);
    assert.strictEqual(mapped.body.success, false);
    assert.strictEqual(mapped.body.code, CODES.PROVIDER_REJECTED);
    assert.strictEqual(mapped.body.retryable, false);
    assert.ok(!JSON.stringify(mapped.body).includes('insufficient balance'),
        'the provider body is never returned to the client');
});

test('an unclassified error is a 500 internal, retryable, and never "invalid amount"', () => {
    const mapped = paymentErrorHttpResponse(new Error('some database thing'));
    assert.strictEqual(mapped.status, 500);
    assert.strictEqual(mapped.body.code, CODES.INTERNAL);
    assert.strictEqual(mapped.body.retryable, true);
    assert.ok(!JSON.stringify(mapped.body).includes('database thing'));
});

test('input errors stay 400 with their own codes', () => {
    const amount = paymentErrorHttpResponse(new PaymentError(CODES.INVALID_AMOUNT, { httpStatus: 400, retryable: true }));
    assert.strictEqual(amount.status, 400);
    assert.strictEqual(amount.body.code, CODES.INVALID_AMOUNT);

    const currency = paymentErrorHttpResponse(new PaymentError(CODES.INVALID_CURRENCY, { httpStatus: 400, retryable: false }));
    assert.strictEqual(currency.status, 400);
    assert.strictEqual(currency.body.retryable, false);
});

test('only a definitive provider refusal may mark the invoice failed', () => {
    assert.strictEqual(isDefinitiveProviderFailure(classifyProviderResponse(400, '', 'q8qpay')), true);
    assert.strictEqual(isDefinitiveProviderFailure(classifyProviderResponse(403, '', 'q8qpay')), true);
    assert.strictEqual(isDefinitiveProviderFailure(classifyProviderResponse(429, '', 'q8qpay')), true);
    assert.strictEqual(isDefinitiveProviderFailure(classifyProviderResponse(500, '', 'q8qpay')), false, '5xx is ambiguous');
    assert.strictEqual(isDefinitiveProviderFailure(classifyProviderThrow(new TypeError('fetch failed'), 'q8qpay')), false);
    assert.strictEqual(isDefinitiveProviderFailure(new Error('plain')), false, 'unknown stays recoverable');
    assert.strictEqual(isDefinitiveProviderFailure(null), false);
});

// ---------------------------------------------------------------------------
// The real provider class, with a stubbed network
// ---------------------------------------------------------------------------

function newProvider() {
    const p = new Q8QPayProvider();
    p.initialize({
        apiKey: 'live_unit_test_key',
        webhookSecret: 'unit-secret',
        sandbox: true,
        callbackUrl: 'https://kalderix.test/api/webhook/q8qpay'
    });
    p.baseUrl = 'https://q8qpay.test';
    return p;
}

function stubFetch(handler) {
    const original = global.fetch;
    const calls = [];
    global.fetch = async (url, init) => {
        calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null });
        return handler(url, init, calls.length);
    };
    return { calls, restore: () => { global.fetch = original; } };
}

async function expectPaymentError(promise) {
    try {
        await promise;
    } catch (e) {
        assert.ok(e instanceof PaymentError, 'expected a PaymentError, got: ' + (e && e.stack));
        return e;
    }
    assert.fail('expected the call to reject');
}

const ORDER = { userId: 7, amount: 300, currency: 'USDT', network: 'TRC20', orderId: 'PD-300', ipAddress: '203.0.113.9' };

test('provider: a 400 refusal is preserved as 502/rejected with a sanitised body', async () => {
    const p = newProvider();
    const s = stubFetch(() => ({
        ok: false,
        status: 400,
        text: async () => '{"error":"insufficient balance","api_key":"live_abcdef123456"}'
    }));
    try {
        const e = await expectPaymentError(p.createInvoice(ORDER));
        assert.strictEqual(e.code, CODES.PROVIDER_REJECTED);
        assert.strictEqual(e.httpStatus, 502);
        assert.strictEqual(e.providerStatus, 400);
        assert.strictEqual(e.ambiguous, false);
        assert.ok(!e.message.includes('live_abcdef123456'));
        assert.ok(e.message.includes('insufficient balance'));
    } finally { s.restore(); }
});

test('provider: 403, 429 and 500 are classified per the table', async () => {
    const cases = [
        [403, CODES.PROVIDER_ACCOUNT, 503, false, false],
        [429, CODES.PROVIDER_UNAVAILABLE, 503, true, false],
        [500, CODES.PROVIDER_UNAVAILABLE, 503, true, true]
    ];
    for (const [status, code, httpStatus, retryable, ambiguous] of cases) {
        const p = newProvider();
        const s = stubFetch(() => ({ ok: false, status, text: async () => '{"error":"nope"}' }));
        try {
            const e = await expectPaymentError(p.createInvoice(ORDER));
            assert.strictEqual(e.code, code, `status ${status}`);
            assert.strictEqual(e.httpStatus, httpStatus);
            assert.strictEqual(e.retryable, retryable);
            assert.strictEqual(e.ambiguous, ambiguous);
        } finally { s.restore(); }
    }
});

test('provider: a network failure is a retryable 503 and ambiguous', async () => {
    const p = newProvider();
    const s = stubFetch(() => { throw new TypeError('fetch failed'); });
    try {
        const e = await expectPaymentError(p.createInvoice(ORDER));
        assert.strictEqual(e.code, CODES.PROVIDER_UNAVAILABLE);
        assert.strictEqual(e.httpStatus, 503);
        assert.strictEqual(e.ambiguous, true);
    } finally { s.restore(); }
});

test('provider: our own timeout aborts the request and is classified as a timeout', async () => {
    const p = newProvider();
    p.timeoutMs = 250;
    const s = stubFetch((url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
            const err = new Error('This operation was aborted');
            err.name = 'AbortError';
            reject(err);
        });
    }));
    const started = Date.now();
    try {
        const e = await expectPaymentError(p.createInvoice(ORDER));
        assert.strictEqual(e.code, CODES.PROVIDER_TIMEOUT);
        assert.strictEqual(e.ambiguous, true);
        assert.ok(Date.now() - started < 5000, 'the call did not hang');
    } finally { s.restore(); }
});

test('provider: a 2xx without the white-label fields is ambiguous, not a hard failure', async () => {
    const p = newProvider();
    const s = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ id: 'q8q-x', status: 'pending' }) }));
    try {
        const e = await expectPaymentError(p.createInvoice(ORDER));
        assert.strictEqual(e.code, CODES.PROVIDER_INVALID_RESPONSE);
        assert.strictEqual(e.httpStatus, 502);
        assert.strictEqual(e.ambiguous, true);
    } finally { s.restore(); }
});

test('provider: $250, $300 and $1,000 are sent intact - there is no Kalderix-side cap', async () => {
    for (const amount of [250, 300, 1000]) {
        const p = newProvider();
        const s = stubFetch(() => ({
            ok: true,
            status: 200,
            json: async () => ({
                id: 'q8q-' + amount,
                status: 'pending',
                payoutAddress: 'TXyz5000',
                amountUsdtExact: (amount + 0.0037).toFixed(4),
                expiresAt: '2026-12-31T00:00:00Z',
                createdAt: '2026-11-01T00:00:00Z',
                whiteLabel: { networkLabel: 'Tron (TRC20)', qrData: 'tron:' + amount }
            })
        }));
        try {
            const result = await p.createInvoice(Object.assign({}, ORDER, { amount, orderId: 'PD-' + amount }));
            assert.strictEqual(s.calls.length, 1);
            assert.strictEqual(s.calls[0].body.amountUsdt, amount, 'the requested amount is sent unchanged');
            assert.strictEqual(s.calls[0].body.assetCode, 'USDT_TRC20');
            assert.strictEqual(result.payoutAddress, 'TXyz5000');
            assert.strictEqual(result.amountUsdtExact, (amount + 0.0037).toFixed(4));
            assert.strictEqual(result.network, 'TRC20');
        } finally { s.restore(); }
    }
});

test('provider: the successful response contract is unchanged', async () => {
    const p = newProvider();
    const s = stubFetch(() => ({
        ok: true,
        status: 200,
        json: async () => ({
            id: 'q8q-contract',
            status: 'pending',
            assetCode: 'USDT_TRC20',
            payoutAddress: 'TContract',
            amountUsdtExact: '50.0037',
            expiresAt: '2026-12-31T00:00:00Z',
            createdAt: '2026-11-01T00:00:00Z',
            whiteLabel: { networkLabel: 'Tron (TRC20)', qrData: 'tron:qr' }
        })
    }));
    try {
        const r = await p.createInvoice(Object.assign({}, ORDER, { amount: 50, orderId: 'PD-CONTRACT' }));
        for (const key of ['invoiceId', 'providerInvoiceId', 'payoutAddress', 'amountUsdtExact', 'amount',
            'currency', 'network', 'assetCode', 'expiresAt', 'status', 'qrData', 'networkLabel']) {
            assert.ok(r[key] !== undefined, 'missing field: ' + key);
        }
        assert.strictEqual(r.invoiceId, 'PD-CONTRACT');
        assert.strictEqual(r.currency, 'USDT');
    } finally { s.restore(); }
});
