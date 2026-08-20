'use strict';

/**
 * MARKETING_SANDBOX deposit-amount regression tests.
 *
 * Root cause pinned here: the sandbox invoice-status response
 * (handleSandboxInvoiceGet) exposed the deposit amount only as snake_case
 * `amount_usd`, while the frontend confirmation computes
 * `result.amountUsd || result.creditedAmount || 0`. Both camelCase fields were
 * undefined for sandbox invoices, so the credited amount rendered as $0.00 in
 * the confirmation UI, Recent Deposits, and the Transaction Log — even though
 * the sandbox wallet was credited correctly (balance comes from /api/auth/me).
 *
 * These tests pin, via source contracts + a pure-JS end-to-end mirror:
 *   - create: deposit record stores the requested amount (2dp rounding)
 *   - credit RPC (migration 013): wallet balance increases by the deposit
 *     record's amount and the SAME amount is written to the sandbox ledger
 *   - invoice GET: response carries the amount as amountUsd AND creditedAmount
 *   - confirmation: the frontend extraction expression resolves to the amount
 *   - recent deposits + transaction history entries carry the amount
 *   - idempotency: a repeated poll never double-credits and keeps the amount
 *   - isolation: sandbox deposit handlers touch no production tables/RPCs and
 *     the production /api/payment/invoice/:id route is unchanged apart from
 *     its first-statement sandbox branch
 *
 * Scenarios covered: $100, $1,000, $5,000 simulated deposits.
 *
 * server.js binds a port on require, so (per repo convention) it is NOT
 * imported; contracts are checked against source text and semantics against a
 * pure-JS mirror.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '013_marketing_sandbox.sql'),
    'utf8'
);

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
// Pure-JS mirrors (mirror the SQL/JS semantics, not the transport)
// ---------------------------------------------------------------------------

// Mirrors the sandbox_deposits insert in handleSandboxDepositRequest /
// handleSandboxInvoiceCreate.
function mirrorCreateSandboxDeposit(state, amount, network) {
    const amt = Number(amount);
    assert.ok(amt && amt >= 10, 'mirror: min $10');
    const invoiceId = 'sbx_inv_' + Date.now() + '_' + state.userId;
    const deposit = {
        user_id: state.userId,
        amount: Math.round(amt * 100) / 100,
        network: network || 'TRC20',
        invoice_id: invoiceId,
        status: 'pending',
        created_at: Date.now(),
    };
    state.deposits.push(deposit);
    return deposit;
}

// Mirrors the sandbox_credit_deposit RPC semantics from migration 013:
// idempotent via deposit status; wallet credit and ledger insert use the SAME
// v_deposit.amount.
function mirrorSandboxCreditDeposit(state, invoiceId) {
    const deposit = state.deposits.find((d) => d.invoice_id === invoiceId && d.user_id === state.userId);
    if (!deposit) return { success: false, error: 'Invoice not found' };
    if (deposit.status === 'confirmed') {
        return { success: true, duplicate: true, new_balance: state.walletBalance, credited_amount: 0, status: 'confirmed' };
    }
    if (deposit.status !== 'pending') {
        return { success: false, error: 'Deposit is not pending', status: deposit.status };
    }
    state.walletBalance = Math.round((state.walletBalance + deposit.amount) * 100) / 100;
    deposit.status = 'confirmed';
    state.transactions.unshift({
        user_id: state.userId,
        type: 'Deposit',
        amount: deposit.amount,
        detail: 'SIMULATED MARKETING DEPOSIT - USDT (' + (deposit.network || 'TRC20') + ')',
    });
    return { success: true, duplicate: false, new_balance: state.walletBalance, credited_amount: deposit.amount, status: 'confirmed' };
}

// Mirrors the (fixed) handleSandboxInvoiceGet response construction.
function mirrorInvoiceGetResponse(deposit) {
    const credited = deposit.status === 'confirmed' ? Number(deposit.amount) : 0;
    return {
        success: true,
        invoice: {
            id: deposit.invoice_id,
            status: deposit.status,
            amountUsd: Number(deposit.amount),
            amount_usd: Number(deposit.amount),
            creditedAmount: credited,
            credited: deposit.status === 'confirmed',
            network: deposit.network,
        },
    };
}

// The EXACT frontend extraction expression, pulled from public/index.html so
// the mirror can never drift from the real UI code.
const FRONTEND_EXTRACT_RE = /const creditedAmount = (result\.amountUsd \|\| result\.creditedAmount \|\| 0);/;
function frontendCreditedAmount(result) {
    const m = INDEX.match(FRONTEND_EXTRACT_RE);
    assert.ok(m, 'frontend creditedAmount extraction expression not found');
    // eslint-disable-next-line no-new-func
    return new Function('result', 'return ' + m[1] + ';')(result);
}

function makeState(userId) {
    return { userId, walletBalance: 0, deposits: [], transactions: [] };
}

function runDepositFlow(amount) {
    const state = makeState(100);
    const deposit = mirrorCreateSandboxDeposit(state, amount, 'TRC20');
    const credit = mirrorSandboxCreditDeposit(state, deposit.invoice_id);
    assert.ok(credit.success && !credit.duplicate);
    const response = mirrorInvoiceGetResponse(deposit);
    const creditedAmount = frontendCreditedAmount(response.invoice);
    return { state, deposit, credit, response, creditedAmount };
}

// ---------------------------------------------------------------------------
// 1. Source contracts: the fix exists in the sandbox invoice GET handler
// ---------------------------------------------------------------------------
test('sandbox invoice GET returns amount in frontend-expected camelCase fields', () => {
    const body = fnBody('handleSandboxInvoiceGet');
    assert.match(body, /amountUsd:\s*Number\(deposit\.amount\)/, 'missing camelCase amountUsd');
    assert.match(body, /creditedAmount:\s*credited/, 'missing creditedAmount');
    assert.match(body, /const credited = deposit\.status === 'confirmed' \? Number\(deposit\.amount\) : 0/);
    // snake_case kept for backwards compatibility
    assert.match(body, /amount_usd:\s*Number\(deposit\.amount\)/);
});

test('sandbox invoice create echoes the amount in camelCase too', () => {
    const body = fnBody('handleSandboxInvoiceCreate');
    assert.match(body, /amountUsd:\s*amt/);
    assert.match(body, /amount_usd:\s*amt/);
});

test('sandbox deposit records store the requested amount rounded to 2dp', () => {
    for (const name of ['handleSandboxDepositRequest', 'handleSandboxInvoiceCreate']) {
        const body = fnBody(name);
        assert.match(body, /amount:\s*Math\.round\(amt \* 100\) \/ 100/, `${name} must insert 2dp amount`);
    }
});

test('legacy sandbox deposit-status endpoint maps creditedAmount from the record', () => {
    const body = fnBody('handleSandboxDepositStatus');
    assert.match(body, /creditedAmount:\s*deposit\.status === 'confirmed' \? Number\(deposit\.amount\) : 0/);
    assert.match(body, /newBalance:\s*wallet\.live_balance/);
});

test('credit RPC credits the wallet and writes the ledger with the SAME deposit amount', () => {
    const start = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.sandbox_credit_deposit');
    assert.ok(start >= 0, 'sandbox_credit_deposit RPC not found in migration 013');
    const end = MIGRATION.indexOf('$$;', start);
    const rpc = MIGRATION.slice(start, end);
    // Wallet credit uses v_deposit.amount
    assert.match(rpc, /v_new_balance := v_wallet\.balance \+ v_deposit\.amount;/);
    // Ledger insert uses the same v_deposit.amount (single authoritative amount)
    assert.match(rpc, /INSERT INTO public\.sandbox_transactions \(user_id, type, amount, detail\)\s*VALUES \(p_user_id, 'Deposit', v_deposit\.amount,/);
    // Response reports the same amount
    assert.match(rpc, /'credited_amount', v_deposit\.amount/);
});

test('frontend confirmation derives ALL displayed amounts from creditedAmount', () => {
    assert.match(INDEX, FRONTEND_EXTRACT_RE);
    // Confirmation success section, recent deposits and tx history all consume it
    assert.match(INDEX, /showSuccessSection\(creditedAmount, invoiceId, newBalance\)/);
    assert.match(INDEX, /APP\.liveData\.history\.unshift\(\{[\s\S]{0,200}?amount: creditedAmount/);
    assert.match(INDEX, /APP\.depositHistory\.unshift\(\{[\s\S]{0,200}?amount: creditedAmount/);
});

// ---------------------------------------------------------------------------
// 2. End-to-end mirror: $100 / $1,000 / $5,000 deposits
// ---------------------------------------------------------------------------
for (const amount of [100, 1000, 5000]) {
    test(`$${amount} simulated deposit: amount is consistent across every surface`, () => {
        const { state, deposit, credit, response, creditedAmount } = runDepositFlow(amount);

        // Deposit record amount
        assert.strictEqual(deposit.amount, amount, 'deposit record amount');

        // Wallet balance increase
        assert.strictEqual(state.walletBalance, amount, 'wallet balance increase');
        assert.strictEqual(credit.new_balance, amount, 'RPC new_balance');
        assert.strictEqual(credit.credited_amount, amount, 'RPC credited_amount');

        // Transaction ledger amount (same authoritative amount that was credited)
        assert.strictEqual(state.transactions.length, 1, 'exactly one ledger entry');
        assert.strictEqual(state.transactions[0].type, 'Deposit');
        assert.strictEqual(state.transactions[0].amount, amount, 'ledger amount');
        assert.strictEqual(state.transactions[0].amount, deposit.amount, 'ledger == deposit record');

        // Confirmation API response amount
        assert.strictEqual(response.invoice.status, 'confirmed');
        assert.strictEqual(response.invoice.amountUsd, amount, 'invoice GET amountUsd');
        assert.strictEqual(response.invoice.amount_usd, amount, 'invoice GET amount_usd');
        assert.strictEqual(response.invoice.creditedAmount, amount, 'invoice GET creditedAmount');

        // Frontend confirmation extraction -> Amount Credited / Recent Deposits /
        // Transaction History all consume this single value
        assert.strictEqual(creditedAmount, amount, 'frontend creditedAmount');

        // Simulate the frontend success/history rendering inputs
        const newBalance = state.walletBalance; // from /api/auth/me server sync
        assert.strictEqual(newBalance, amount, 'New Balance');
        const recentDepositEntry = { amount: creditedAmount, network: 'TRC20', currency: 'USDT', status: 'Confirmed' };
        assert.strictEqual(recentDepositEntry.amount, amount, 'Recent Deposits amount');
        const historyEntry = { type: 'Deposit', amount: creditedAmount };
        assert.strictEqual(historyEntry.amount, amount, 'Transaction History amount');

        // Transaction reference behavior preserved (sbx_inv_<ts>_<userId>)
        assert.match(deposit.invoice_id, /^sbx_inv_\d+_100$/, 'sandbox invoice ref format');
    });
}

test('pending (not yet confirmed) invoice reports creditedAmount 0 but keeps the amount', () => {
    const state = makeState(100);
    const deposit = mirrorCreateSandboxDeposit(state, 1000, 'TRC20');
    const response = mirrorInvoiceGetResponse(deposit);
    assert.strictEqual(response.invoice.status, 'pending');
    assert.strictEqual(response.invoice.creditedAmount, 0, 'not credited yet');
    assert.strictEqual(response.invoice.amountUsd, 1000, 'amount still present');
});

test('repeated poll after confirmation is idempotent (no double credit, amount stable)', () => {
    const { state, deposit } = runDepositFlow(1000);
    const again = mirrorSandboxCreditDeposit(state, deposit.invoice_id);
    assert.ok(again.success && again.duplicate, 'second credit marked duplicate');
    assert.strictEqual(state.walletBalance, 1000, 'balance not double-credited');
    assert.strictEqual(state.transactions.length, 1, 'no duplicate ledger entry');
    const response = mirrorInvoiceGetResponse(deposit);
    assert.strictEqual(frontendCreditedAmount(response.invoice), 1000, 'repeat confirmation still shows $1,000');
});

// ---------------------------------------------------------------------------
// 3. Isolation: sandbox deposit path touches no production tables/mechanisms
// ---------------------------------------------------------------------------
test('sandbox deposit handlers reference no production tables, RPCs or PaymentService', () => {
    const banned = [
        "from('wallets')", "from('deposits')", "from('transactions')",
        "from('payment_invoices')",
        'credit_payment_safe', 'record_trade_safe', 'charge_subscription_safe',
        'paymentService.',
    ];
    for (const name of [
        'handleSandboxDepositRequest', 'handleSandboxInvoiceCreate',
        'handleSandboxDepositStatus', 'handleSandboxInvoiceGet',
        'handleSandboxInvoiceCancel', 'handleSandboxPaymentHistory',
        'advanceSandboxDeposit',
    ]) {
        const body = fnBody(name);
        for (const b of banned) {
            assert.ok(!body.includes(b), `${name} must not reference ${b}`);
        }
    }
});

test('production invoice GET route keeps its production statements unchanged', () => {
    const marker = "app.get('/api/payment/invoice/:invoiceId'";
    const start = SERVER.indexOf(marker);
    assert.ok(start >= 0, 'production invoice GET route not found');
    const after = SERVER.indexOf('\napp.', start + marker.length);
    const body = SERVER.slice(start, after < 0 ? undefined : after);
    // The only sandbox touch is the first-statement branch; production logic
    // (paymentService.getInvoiceStatus) must be intact.
    assert.match(body, /if \(await sandboxHandled\(req, res, handleSandboxInvoiceGet\)\) return;/);
    assert.match(body, /const status = await paymentService\.getInvoiceStatus\(invoiceId, userId\);/);
    // Branch precedes any production statement
    assert.ok(
        body.indexOf('sandboxHandled') < body.indexOf('paymentService.getInvoiceStatus'),
        'sandbox branch must run before production code'
    );
});

test('migration 013 still credits from the deposit record (not a request param)', () => {
    // The RPC signature takes (p_user_id, p_invoice_id) only — the amount can
    // never be supplied/overridden by the client.
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.sandbox_credit_deposit\(p_user_id BIGINT, p_invoice_id TEXT\)/);
    const start = MIGRATION.indexOf('sandbox_credit_deposit');
    const rpc = MIGRATION.slice(start, MIGRATION.indexOf('$$;', start));
    assert.ok(!/p_amount/i.test(rpc), 'credit RPC must not accept a client amount');
});
