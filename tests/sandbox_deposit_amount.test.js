'use strict';

/**
 * MARKETING SANDBOX — deposit amount consistency regression tests.
 *
 * Regression: a simulated $1,000 deposit credited the sandbox wallet correctly
 * (balance $1,000) but the confirmation UI, Recent Deposits and the transaction
 * history showed $0.00. Root cause: handleSandboxInvoiceGet returned the
 * invoice amount as `amount_usd` (snake_case) while the production
 * PaymentService.getInvoiceStatus() shape (which the shared frontend polling
 * code consumes) exposes `amountUsd` (camelCase). The frontend derivation
 * `result.amountUsd || result.creditedAmount || 0` therefore resolved to 0.
 *
 * These tests pin, for $100 / $1,000 / $5,000 simulated deposits:
 *   - wallet balance increase
 *   - deposit record amount
 *   - transaction ledger amount
 *   - confirmation response amount (REAL extracted handler, vm-executed)
 *   - new balance
 *   - recent deposit / transaction history amount (frontend consumption mirror)
 *
 * and pin that production payment code + migration 013 semantics are untouched.
 *
 * server.js binds a port on require (and deps are not installed in CI), so per
 * repo convention these tests use source contracts + vm-extracted real
 * functions + pure-JS mirrors. Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const PAYMENT_SERVICE = fs.readFileSync(path.join(__dirname, '..', 'services', 'PaymentService.js'), 'utf8');
const MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '013_marketing_sandbox.sql'),
    'utf8'
);

// Extract a top-level async function's full source via brace matching.
function extractFn(source, name) {
    const marker = `async function ${name}(`;
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `function not found: ${name}`);
    let depth = 0;
    let end = -1;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) { end = i + 1; break; }
        }
    }
    assert.ok(end > start, `could not brace-match function: ${name}`);
    return source.slice(start, end);
}

// Run the REAL handleSandboxInvoiceGet from server.js against a stubbed
// confirmed sandbox deposit row, and capture the exact res.json payload.
async function runRealSandboxInvoiceGet(depositRow) {
    const ctx = {
        advanceSandboxDeposit: async () => depositRow,
    };
    vm.createContext(ctx);
    const handler = vm.runInContext('(' + extractFn(SERVER, 'handleSandboxInvoiceGet') + ')', ctx);
    return await new Promise((resolve, reject) => {
        const res = {
            status: (code) => ({ json: (p) => resolve({ httpStatus: code, ...p }) }),
            json: (p) => resolve(p),
        };
        Promise.resolve(handler({ user: { id: 7 }, params: { invoiceId: depositRow.invoice_id } }, res))
            .catch(reject);
    });
}

// Pure-JS mirror of the migration-013 sandbox_credit_deposit RPC semantics:
// pending -> confirmed credits wallet and writes the ledger with the SAME
// authoritative deposit amount; a replay is a no-op duplicate.
function sandboxCreditDepositMirror(state) {
    const deposit = state.deposit;
    if (deposit.status === 'confirmed') {
        return { success: true, duplicate: true, new_balance: state.wallet.balance, credited_amount: 0, status: 'confirmed' };
    }
    if (deposit.status !== 'pending') {
        return { success: false, error: 'Deposit is not pending', status: deposit.status };
    }
    state.wallet.balance = Math.round((state.wallet.balance + deposit.amount) * 100) / 100;
    deposit.status = 'confirmed';
    state.transactions.unshift({
        type: 'Deposit',
        amount: deposit.amount,
        detail: 'SIMULATED MARKETING DEPOSIT - USDT (' + (deposit.network || 'TRC20') + ')',
    });
    return { success: true, duplicate: false, new_balance: state.wallet.balance, credited_amount: deposit.amount, status: 'confirmed' };
}

// Pure-JS mirror of handleSandboxInvoiceCreate's amount parsing + record insert.
function sandboxCreateDepositMirror(requestedUsd) {
    const amt = Number(requestedUsd);
    if (!amt || amt < 10) throw new Error('Min $10');
    return {
        user_id: 7,
        amount: Math.round(amt * 100) / 100,
        network: 'TRC20',
        address: 'TSANDBOXDEMO000000000000000000000000',
        invoice_id: 'sbx_inv_test_7',
        status: 'pending',
    };
}

// Pure-JS mirror of the frontend confirmation consumption in
// startPollingForPayment(): derives the credited amount from the invoice
// payload and records the Recent Deposits + Transaction Log entries.
function frontendConfirmationMirror(invoicePayload, serverSyncedBalance) {
    const result = invoicePayload;
    // EXACT frontend expression (public/index.html startPollingForPayment).
    const creditedAmount = result.amountUsd || result.creditedAmount || 0;
    const newBalance = serverSyncedBalance; // /api/auth/me re-sync (authoritative)
    const historyEntry = { type: 'Deposit', detail: 'USDT (TRC20)', amount: creditedAmount };
    const depositHistoryEntry = { amount: creditedAmount, network: 'TRC20', currency: 'USDT', status: 'Confirmed' };
    return { creditedAmount, successAmount: creditedAmount, newBalance, historyEntry, depositHistoryEntry };
}

const AMOUNTS = [100, 1000, 5000];

for (const usd of AMOUNTS) {
    test(`sandbox deposit $${usd}: wallet credit, deposit record, ledger, confirmation, history all show $${usd}`, async () => {
        // 1) Creation: the deposit record stores the requested amount (2dp).
        const deposit = sandboxCreateDepositMirror(usd);
        assert.strictEqual(deposit.amount, usd, 'deposit record amount mismatch');
        assert.strictEqual(deposit.status, 'pending');

        // 2) Confirmation: the RPC credits the wallet and writes the ledger
        //    with the SAME authoritative amount.
        const state = { wallet: { balance: 0 }, deposit, transactions: [] };
        const credit = sandboxCreditDepositMirror(state);
        assert.ok(credit.success && !credit.duplicate);
        assert.strictEqual(state.wallet.balance, usd, 'wallet balance increase mismatch');
        assert.strictEqual(credit.new_balance, usd, 'new balance mismatch');
        assert.strictEqual(credit.credited_amount, usd, 'credited amount mismatch');
        assert.strictEqual(deposit.status, 'confirmed');
        assert.strictEqual(state.transactions.length, 1);
        assert.strictEqual(state.transactions[0].amount, usd, 'transaction ledger amount mismatch');
        assert.strictEqual(state.transactions[0].type, 'Deposit');

        // 3) Confirmation response: the REAL server handler must expose the
        //    amount under the production-shaped `amountUsd` field.
        const payload = await runRealSandboxInvoiceGet({
            invoice_id: deposit.invoice_id,
            status: deposit.status,
            amount: String(deposit.amount), // Postgres DECIMAL arrives as string
            network: deposit.network,
            address: deposit.address,
        });
        assert.ok(payload.success);
        assert.strictEqual(payload.invoice.status, 'confirmed');
        assert.strictEqual(payload.invoice.amountUsd, usd, 'confirmation response amountUsd mismatch');
        assert.strictEqual(payload.invoice.amount_usd, usd, 'backwards-compat amount_usd mismatch');
        assert.strictEqual(payload.invoice.id, deposit.invoice_id, 'transaction reference changed');

        // 4) Frontend consumption: the confirmation amount, Recent Deposits
        //    entry and Transaction Log entry all derive from the response.
        const ui = frontendConfirmationMirror(payload.invoice, credit.new_balance);
        assert.strictEqual(ui.creditedAmount, usd, 'frontend creditedAmount derivation mismatch');
        assert.strictEqual(ui.successAmount, usd, 'success-section amount mismatch');
        assert.strictEqual(ui.newBalance, usd, 'new balance display mismatch');
        assert.strictEqual(ui.depositHistoryEntry.amount, usd, 'Recent Deposits amount mismatch');
        assert.strictEqual(ui.historyEntry.amount, usd, 'Transaction Log amount mismatch');
    });
}

test('sandbox deposit credit is idempotent: replay never double-credits', () => {
    const deposit = sandboxCreateDepositMirror(1000);
    const state = { wallet: { balance: 0 }, deposit, transactions: [] };
    const first = sandboxCreditDepositMirror(state);
    assert.ok(first.success && state.wallet.balance === 1000 && state.transactions.length === 1);
    const replay = sandboxCreditDepositMirror(state);
    assert.ok(replay.success && replay.duplicate);
    assert.strictEqual(replay.credited_amount, 0);
    assert.strictEqual(state.wallet.balance, 1000, 'double credit detected');
    assert.strictEqual(state.transactions.length, 1, 'duplicate ledger entry');
});

test('sandbox invoice GET handler maps the amount with the production camelCase field', () => {
    const body = extractFn(SERVER, 'handleSandboxInvoiceGet');
    assert.ok(body.includes('amountUsd'), 'sandbox invoice GET does not expose amountUsd');
    assert.ok(body.includes('Number(deposit.amount)'), 'sandbox invoice GET does not read deposit.amount');
    assert.ok(body.includes("credited: deposit.status === 'confirmed'"), 'sandbox invoice GET missing credited flag');
});

test('production getInvoiceStatus shape is the camelCase reference (unchanged)', () => {
    assert.ok(PAYMENT_SERVICE.includes('amountUsd: invoice.amount_usd'),
        'production getInvoiceStatus amountUsd mapping changed');
});

test('frontend confirmation derivation reads amountUsd first (unchanged)', () => {
    assert.ok(INDEX.includes('const creditedAmount = result.amountUsd || result.creditedAmount || 0;'),
        'frontend creditedAmount derivation changed');
});

test('migration 013 credits wallet and ledger from the SAME deposit amount', () => {
    const start = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.sandbox_credit_deposit');
    assert.ok(start >= 0);
    const body = MIGRATION.slice(start, MIGRATION.indexOf('$$;', start));
    assert.ok(body.includes('v_new_balance := v_wallet.balance + v_deposit.amount'),
        'wallet credit no longer uses v_deposit.amount');
    assert.ok(body.includes("INSERT INTO public.sandbox_transactions (user_id, type, amount, detail)"),
        'ledger insert missing');
    assert.ok(body.includes("VALUES (p_user_id, 'Deposit', v_deposit.amount,"),
        'ledger amount no longer uses v_deposit.amount');
});

test('sandbox deposit handlers touch only sandbox_* tables and the sandbox RPC', () => {
    for (const name of ['handleSandboxInvoiceCreate', 'handleSandboxInvoiceGet', 'handleSandboxDepositRequest', 'handleSandboxDepositStatus']) {
        const body = extractFn(SERVER, name);
        // handleSandboxInvoiceGet/Status delegate to advanceSandboxDeposit
        // (sandbox-only) instead of touching a sandbox table directly.
        assert.ok(/sandbox_|advanceSandboxDeposit/.test(body), `${name} references no sandbox table/RPC`);
        for (const table of ["'wallets'", "'deposits'", "'transactions'", "'trades'", "'payment_invoices'"]) {
            assert.ok(!body.includes(`.from(${table})`), `${name} touches production table ${table}`);
        }
        assert.ok(!body.includes('paymentService'), `${name} reaches PaymentService`);
    }
});

test('sandbox transaction reference format is preserved (sbx_inv_<ts>_<userId>)', () => {
    const create = extractFn(SERVER, 'handleSandboxInvoiceCreate');
    const legacy = extractFn(SERVER, 'handleSandboxDepositRequest');
    for (const body of [create, legacy]) {
        assert.ok(body.includes("const invoiceId = 'sbx_inv_' + Date.now() + '_' + userId;"),
            'sandbox invoice reference format changed');
    }
});

test('production deposit routes keep their production statements after the sandbox branch', () => {
    const invoiceRoute = SERVER.slice(
        SERVER.indexOf("app.get('/api/payment/invoice/:invoiceId'"),
        SERVER.indexOf("app.post('/api/payment/cancel/:invoiceId'")
    );
    assert.ok(invoiceRoute.indexOf('sandboxHandled(req, res, handleSandboxInvoiceGet)') <
        invoiceRoute.indexOf('paymentService.getInvoiceStatus(invoiceId, userId)'),
        'sandbox branch is not before the production code (or production code changed)');
    const createRoute = SERVER.slice(
        SERVER.indexOf("app.post('/api/payment/create-invoice'"),
        SERVER.indexOf("app.get('/api/payment/invoice/:invoiceId'")
    );
    assert.ok(createRoute.includes('paymentService.createInvoice'),
        'production create-invoice no longer uses PaymentService');
});
