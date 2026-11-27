'use strict';

/**
 * INVOICE CREATION - END TO END AGAINST THE REAL SERVER.
 *
 * Boots `server.js` itself and drives `POST /api/payment/create-invoice` over
 * HTTP, so the real route, the real PaymentService, the real Q8QPayProvider and
 * the real Supabase calls all run; only the network boundary is replaced
 * (`tests/helpers/fake-q8qpay-preload.js`).
 *
 * What this suite locks down (the production incident):
 *   - 400 is reserved for the customer's own input. A provider refusal is 502 and
 *     an unreachable/timed-out/unauthorised provider is 503, each with a stable
 *     machine-readable code, so the UI stops saying "check the amount".
 *   - A provider rejection marks the local invoice `failed`; a 5xx, a network
 *     failure or a timeout (ambiguous outcomes) never does - the row stays
 *     recoverable so a late webhook can still credit it.
 *   - supabase-js resolves with `{ error }`; that is inspected, and a failed
 *     bookkeeping write never changes the customer's answer.
 *   - $300 and $1,000 are created normally: there is no Kalderix-side cap.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-q8qpay-preload.js');
const JWT_SECRET = 'invoice-errors-e2e-jwt-secret';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-errors-e2e-'));
const STATE_FILE = path.join(TMP, 'state.json');
const EVENTS_FILE = path.join(TMP, 'events.jsonl');

const USER_ID = 7;

let child = null;
let base = '';

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
    const port = await freePort();
    base = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
            NODE_ENV: 'test',
            PORT: String(port),
            JWT_SECRET,
            BASE_URL: base,
            // PaymentService builds its own client from these; the preload answers
            // every /rest/v1/ call, so the values are placeholders that are never dialled.
            SUPABASE_URL: 'http://127.0.0.1:1',
            SUPABASE_ANON_KEY: 'invoice-e2e-anon',
            SUPABASE_SERVICE_KEY: 'invoice-e2e-service',
            // The route rate-limits 10 creations per minute per client address. One
            // trusted proxy hop lets each test present its own address, so the suite
            // is not limited by a shared bucket (and the limiter itself is untouched).
            TRUST_PROXY_HOPS: '1',
            PAYMENT_PROVIDER: 'q8qpay',
            Q8QPAY_API_KEY: 'live_e2e_invoice_key',
            Q8QPAY_WEBHOOK_SECRET: 'invoice-errors-secret',
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

function token(userId) {
    return jwt.sign({ id: userId, email: 'invoice-e2e@example.test', is_admin: false }, JWT_SECRET, { expiresIn: '1h' });
}

let clientIpCounter = 10;

async function createInvoice(body, opts) {
    const options = opts || {};
    const headers = {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.' + (clientIpCounter++)
    };
    if (options.token !== null) headers.authorization = 'Bearer ' + (options.token || token(USER_ID));
    const res = await fetch(base + '/api/payment/create-invoice', {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, headers: res.headers, body: json };
}

const BASE_STATE = {
    invoice: { id: 77, invoice_id: 'PD-E2E', user_id: USER_ID, status: 'pending' },
    provider: { id: 'q8q-uuid-1', status: 'pending', payoutAddress: 'TXyzPayout', amountUsdtExact: '300.0037' },
    credit: { success: true, new_balance: 300 }
};

test.before(async () => { await boot(); });

test.after(async () => {
    if (child) child.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

// ---------------------------------------------------------------------------
// Genuine input errors stay 400
// ---------------------------------------------------------------------------

test('an amount below the platform minimum is a 400 input error and never reaches the provider', async () => {
    writeState(Object.assign({}, BASE_STATE));
    const res = await createInvoice({ amount: 10, currency: 'USDT', network: 'TRC20' });

    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.code, 'PAYMENT_INVALID_AMOUNT');
    assert.strictEqual(res.body.retryable, true);
    assert.strictEqual(eventsOf('provider_create').length, 0, 'no provider call for an invalid amount');
    assert.strictEqual(eventsOf('insert').filter((e) => e.table === 'payment_invoices').length, 0);
});

test('an unknown network is a 400 input error with its own code', async () => {
    writeState(Object.assign({}, BASE_STATE));
    const res = await createInvoice({ amount: 300, currency: 'USDT', network: 'DOGE' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'PAYMENT_INVALID_NETWORK');
    assert.strictEqual(res.body.retryable, false);
    assert.strictEqual(eventsOf('provider_create').length, 0);
});

// ---------------------------------------------------------------------------
// Provider rejection -> 502 + the row is marked failed
// ---------------------------------------------------------------------------

test('a provider 400 refusal is a 502 with a code, and the local invoice is marked failed', async () => {
    writeState(Object.assign({}, BASE_STATE, {
        createInvoice: { status: 400, body: { error: 'insufficient balance for the reserved fee' } }
    }));
    const res = await createInvoice({ amount: 300, currency: 'USDT', network: 'TRC20' });

    assert.strictEqual(res.status, 502, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'PAYMENT_PROVIDER_REJECTED');
    assert.strictEqual(res.body.retryable, false);

    const creates = eventsOf('provider_create');
    assert.strictEqual(creates.length, 1, 'the provider was asked exactly once');
    assert.strictEqual(creates[0].amount, 300);

    const updates = eventsOf('update').filter((e) => e.table === 'payment_invoices');
    const failed = updates.filter((u) => u.data.status === 'failed');
    assert.strictEqual(failed.length, 1, 'the dead invoice row is closed: ' + JSON.stringify(updates));
    assert.ok(failed[0].query.includes('id=eq.77'), 'the row is targeted by id');

    // The local row is inserted BEFORE the provider call, so the failed write must
    // come after it (ordering matters: we only know the outcome afterwards).
    const all = events().filter((e) => e.kind === 'provider_create' || (e.kind === 'update' && e.data.status === 'failed'));
    assert.strictEqual(all[0].kind, 'provider_create');
    assert.strictEqual(all[1].kind, 'update');

    assert.strictEqual(eventsOf('rpc').length, 0, 'nothing is credited');
});

test('a provider 403 (account suspended) is a 503, not retryable, and closes the row', async () => {
    writeState(Object.assign({}, BASE_STATE, {
        createInvoice: { status: 403, body: { message: 'Account suspended' } }
    }));
    const res = await createInvoice({ amount: 300, currency: 'USDT', network: 'TRC20' });

    assert.strictEqual(res.status, 503, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'PAYMENT_PROVIDER_ACCOUNT');
    assert.strictEqual(res.body.retryable, false, 'retrying cannot fix an account state');
    const failed = eventsOf('update').filter((u) => u.data.status === 'failed');
    assert.strictEqual(failed.length, 1, 'a refused request created no invoice, so the row is safe to close');
});

test('a provider 409 duplicate reference is a 502 and the row stays recoverable', async () => {
    writeState(Object.assign({}, BASE_STATE, {
        createInvoice: { status: 409, body: { error: 'Duplicate reference' } }
    }));
    const res = await createInvoice({ amount: 300, currency: 'USDT', network: 'TRC20' });

    assert.strictEqual(res.status, 502, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'PAYMENT_PROVIDER_REJECTED', 'the original code is preserved');
    assert.strictEqual(res.body.retryable, false, 'a retry would create a second payable invoice');

    // 409 means an invoice with OUR reference already exists, so the local row must
    // NOT be declared dead: a `failed` row is invisible to reconciliation and both
    // the admin confirm route and the customer's manual check refuse it.
    const failed = eventsOf('update').filter((u) => u.data.status === 'failed');
    assert.strictEqual(failed.length, 0, 'a 409 must leave the invoice recoverable: ' + JSON.stringify(eventsOf('update')));
});

test('a thrown database error while marking the row failed does not mask the provider error', async () => {
    // supabase-js can THROW (no client, transport failure). That must never replace
    // the provider classification with an internal 500.
    writeState(Object.assign({}, BASE_STATE, {
        createInvoice: { status: 400, body: { error: 'refused' } },
        markFailedThrow: 'connection reset by peer'
    }));
    const res = await createInvoice({ amount: 300, currency: 'USDT', network: 'TRC20' });

    assert.strictEqual(res.status, 502, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'PAYMENT_PROVIDER_REJECTED', 'the provider error survives the bookkeeping failure');
    assert.strictEqual(res.body.retryable, false);
    assert.strictEqual(eventsOf('update').filter((u) => u.data.status === 'failed').length, 1,
        'the write was attempted before it threw');
});

test('a provider 429 rate limit is a retryable 503 with Retry-After, and closes the row', async () => {
    writeState(Object.assign({}, BASE_STATE, {
        createInvoice: { status: 429, body: { error: 'Too Many Requests' } }
    }));
    const res = await createInvoice({ amount: 300, currency: 'USDT', network: 'TRC20' });

    assert.strictEqual(res.status, 503, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'PAYMENT_PROVIDER_UNAVAILABLE');
    assert.strictEqual(res.body.retryable, true);
    assert.strictEqual(res.headers.get('retry-after'), '30');
    assert.strictEqual(eventsOf('update').filter((u) => u.data.status === 'failed').length, 1);
});

test('the provider body is never returned to the client', async () => {
    writeState(Object.assign({}, BASE_STATE, {
        createInvoice: {
            status: 400,
            body: { error: 'insufficient balance for the reserved fee', api_key: 'live_leaked_key_123456' }
        }
    }));
    const res = await createInvoice({ amount: 300, currency: 'USDT', network: 'TRC20' });
    const raw = JSON.stringify(res.body);
    assert.strictEqual(res.status, 502);
    assert.ok(!raw.includes('insufficient balance'), 'no provider text in the response: ' + raw);
    assert.ok(!raw.includes('live_leaked_key_123456'), 'no credential in the response: ' + raw);
});

// ---------------------------------------------------------------------------
// Ambiguous outcomes -> 503 and the row stays recoverable
// ---------------------------------------------------------------------------

test('a provider 500 is a retryable 503 and the invoice row is NOT marked failed', async () => {
    writeState(Object.assign({}, BASE_STATE, {
        createInvoice: { status: 500, body: { error: 'internal error' } }
    }));
    const res = await createInvoice({ amount: 300, currency: 'USDT', network: 'TRC20' });

    assert.strictEqual(res.status, 503, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'PAYMENT_PROVIDER_UNAVAILABLE');
    assert.strictEqual(res.body.retryable, true);

    const failed = eventsOf('update').filter((u) => u.data.status === 'failed');
    assert.strictEqual(failed.length, 0,
        'a 5xx may have created the invoice: the row stays pending so a late webhook can credit it');
    const persist = eventsOf('update').filter((u) => u.data.wallet_address);
    assert.strictEqual(persist.length, 0, 'nothing about the provider invoice is known, so nothing is persisted');
});

test('a network failure is a retryable 503 and the invoice row is NOT marked failed', async () => {
    writeState(Object.assign({}, BASE_STATE, {
        createInvoice: { __throw: 'fetch failed' }
    }));
    const res = await createInvoice({ amount: 300, currency: 'USDT', network: 'TRC20' });

    assert.strictEqual(res.status, 503, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'PAYMENT_PROVIDER_UNAVAILABLE');
    assert.strictEqual(res.body.retryable, true);
    assert.strictEqual(eventsOf('update').filter((u) => u.data.status === 'failed').length, 0);
});

test('a timeout is a retryable 503 (PAYMENT_PROVIDER_TIMEOUT) and the row is NOT marked failed', async () => {
    writeState(Object.assign({}, BASE_STATE, {
        createInvoice: { __abort: true }
    }));
    const res = await createInvoice({ amount: 1000, currency: 'USDT', network: 'TRC20' });

    assert.strictEqual(res.status, 503, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'PAYMENT_PROVIDER_TIMEOUT');
    assert.strictEqual(res.body.retryable, true);
    assert.strictEqual(eventsOf('update').filter((u) => u.data.status === 'failed').length, 0,
        'the provider may hold an invoice for this reference');
});

// ---------------------------------------------------------------------------
// Successful creation (there is no $250 cap on our side)
// ---------------------------------------------------------------------------

for (const amount of [300, 1000]) {
    test(`a $${amount} invoice is created normally and the provider details are persisted`, async () => {
        writeState(Object.assign({}, BASE_STATE));
        const res = await createInvoice({ amount, currency: 'USDT', network: 'TRC20' });

        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.success, true);

        const invoice = res.body.invoice;
        assert.strictEqual(invoice.amountUsd, amount);
        assert.strictEqual(invoice.provider, 'q8qpay');
        assert.strictEqual(invoice.address, 'TXyzPayout');
        assert.strictEqual(invoice.payoutAddress, 'TXyzPayout');
        assert.ok(invoice.amountUsdtExact, 'the exact amount is returned');
        assert.strictEqual(invoice.network, 'TRC20');
        assert.strictEqual(invoice.status, 'pending');

        const creates = eventsOf('provider_create');
        assert.strictEqual(creates.length, 1);
        assert.strictEqual(creates[0].amount, amount, 'the requested amount is sent unchanged');

        const updates = eventsOf('update').filter((e) => e.table === 'payment_invoices');
        assert.strictEqual(updates.length, 1, 'one bookkeeping write: ' + JSON.stringify(updates.map((u) => Object.keys(u.data))));
        assert.strictEqual(updates[0].data.wallet_address, 'TXyzPayout');
        assert.strictEqual(updates[0].data.status, undefined, 'a successful creation never writes a status');
    });
}

test('the response shape for a successful creation is unchanged', async () => {
    writeState(Object.assign({}, BASE_STATE));
    const res = await createInvoice({ amount: 300, currency: 'USDT', network: 'TRC20' });
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['invoice', 'success']);
    for (const key of ['id', 'amountUsd', 'currency', 'network', 'expiresAt', 'status', 'provider',
        'address', 'payoutAddress', 'amountCrypto', 'amountUsdtExact', 'networkLabel',
        'qrCodeUrl', 'qrData', 'providerInvoiceId', 'redirectToGateway']) {
        assert.ok(res.body.invoice[key] !== undefined, 'missing invoice field: ' + key);
    }
    assert.strictEqual(res.body.invoice.redirectToGateway, false);
});

// ---------------------------------------------------------------------------
// Supabase resolves with { error } - the answer must not depend on bookkeeping
// ---------------------------------------------------------------------------

test('a database error while marking the row failed does not change the customer answer', async () => {
    writeState(Object.assign({}, BASE_STATE, {
        createInvoice: { status: 400, body: { error: 'refused' } },
        markFailedError: { status: 400, code: '23514', message: 'new row violates check constraint' }
    }));
    const res = await createInvoice({ amount: 300, currency: 'USDT', network: 'TRC20' });

    assert.strictEqual(res.status, 502, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'PAYMENT_PROVIDER_REJECTED');
    const failed = eventsOf('update').filter((u) => u.data.status === 'failed');
    assert.strictEqual(failed.length, 1, 'the write was attempted (and the error is logged server-side)');
});

test('a database error while persisting provider details still returns the usable invoice', async () => {
    writeState(Object.assign({}, BASE_STATE, {
        updateError: { status: 400, code: '08006', message: 'connection failure' }
    }));
    const res = await createInvoice({ amount: 300, currency: 'USDT', network: 'TRC20' });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.invoice.address, 'TXyzPayout',
        'the provider invoice exists and is payable; a bookkeeping failure must not hide it');
    assert.ok(eventsOf('update').some((u) => u.data.wallet_address), 'the write was attempted');
});

// ---------------------------------------------------------------------------
// Authentication is untouched
// ---------------------------------------------------------------------------

test('invoice creation still requires a session', async () => {
    writeState(Object.assign({}, BASE_STATE));
    const res = await createInvoice({ amount: 300, currency: 'USDT', network: 'TRC20' }, { token: null });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(eventsOf('provider_create').length, 0);
});
