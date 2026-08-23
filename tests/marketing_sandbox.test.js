'use strict';

/**
 * MARKETING SANDBOX — production-safety contract tests.
 *
 * server.js binds a port on require, so (per repo convention) these tests do
 * NOT import it. They pin, via source contracts + pure-JS mirrors:
 *
 *   ISOLATION (a MARKETING_SANDBOX account ...):
 *   - cannot execute a real deposit        (route branch before production code)
 *   - cannot execute a real withdrawal     (route branch before KYC/debit)
 *   - cannot call real blockchain execution (no provider/blockchain calls in
 *     sandbox handlers; sandbox invoice never reaches PaymentService)
 *   - cannot call real exchange execution   (sandbox trades use sandbox_record_trade
 *     RPC only; record_trade_safe never invoked)
 *   - cannot use production payment processing (create-invoice/invoice/cancel/
 *     check/history all branch to simulated handlers)
 *   - cannot debit a real wallet            (sandbox charge/deposit/trade/
 *     withdraw RPCs touch sandbox_* tables only + DB backstop triggers)
 *   - cannot affect a normal user           (sandboxOnlyMiddleware blocks
 *     non-sandbox callers from /api/sandbox/*)
 *   - cannot affect an admin account        (requireSandboxTargetUser verifies
 *     the target's users.environment === MARKETING_SANDBOX server-side)
 *   - cannot affect production subscription billing (subscription routes branch;
 *     charge_subscription_safe never invoked for sandbox)
 *   - cannot enter the real withdrawal queue (sandbox withdrawals live in
 *     sandbox_withdrawals; admin queue reads production `withdrawals` only)
 *   - cannot alter real customer balances    (no production UPDATE/INSERT in
 *     sandbox handlers + DB backstop triggers on wallets.live_balance)
 *
 *   REVERSE (a normal LIVE user must be unchanged):
 *   - every production route keeps its existing production statements
 *     byte-identical AFTER the additive sandbox branch.
 *
 *   SCENARIOS (pure-JS mirrors of the sandbox RPC semantics):
 *   - deposit: simulated balance increases; no real transaction
 *   - trade: simulated P&L clamped at 0; idempotent
 *   - withdrawal: debit-at-request, status progression
 *   - subscription: due -> simulated $7 deduction; insufficient -> payment_due
 *   - reset: all sandbox state cleared
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '013_marketing_sandbox.sql'),
    'utf8'
);

// ---------------------------------------------------------------------------
// Helpers: extract a route handler body or function body from server.js source.
// Full-line // comments are stripped so that explanatory prose (which may name
// the production mechanisms being avoided) does not pollute code greps.
// ---------------------------------------------------------------------------
function stripFullLineComments(s) {
    return s.split('\n').map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n');
}

function routeBody(method, routePath) {
    const marker = `app.${method}('${routePath}'`;
    const start = SERVER.indexOf(marker);
    assert.ok(start >= 0, `route not found: ${method.toUpperCase()} ${routePath}`);
    // End at the next top-level route registration or section marker.
    const after = SERVER.indexOf("\napp.", start + marker.length);
    return stripFullLineComments(SERVER.slice(start, after < 0 ? undefined : after));
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

const PROD_TABLE_REFS = [
    "from('wallets')", 'from("wallets")',
    "from('deposits')", "from('withdrawals')",
    "from('transactions')", "from('trades')",
    "from('subscriptions')", "from('subscription_charges')",
    "from('payment_invoices')",
    'credit_payment_safe', 'record_trade_safe', 'charge_subscription_safe',
    'paymentService.',
];

// ---------------------------------------------------------------------------
// 1. Classification: users.environment + immutability + is_simulated columns
// ---------------------------------------------------------------------------
test('migration defines users.environment with MARKETING_SANDBOX classification', () => {
    assert.match(MIGRATION, /ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'PRODUCTION'/);
    assert.match(MIGRATION, /CHECK \(environment IN \('PRODUCTION', 'MARKETING_SANDBOX'\)\)/);
});

test('migration makes users.environment immutable via trigger', () => {
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.users_environment_immutable\(\)/);
    assert.match(MIGRATION, /CREATE TRIGGER trg_users_environment_immutable/);
    assert.match(MIGRATION, /RAISE EXCEPTION 'users\.environment is immutable/);
});

test('sandbox tables all carry is_simulated = true CHECK constraint', () => {
    const tables = [
        'sandbox_wallets', 'sandbox_deposits', 'sandbox_withdrawals', 'sandbox_trades',
        'sandbox_transactions', 'sandbox_subscriptions', 'sandbox_subscription_charges',
        'sandbox_bot_sessions',
    ];
    for (const t of tables) {
        const re = new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t} \\(`);
        assert.match(MIGRATION, re, `missing table ${t}`);
    }
    const simCount = (MIGRATION.match(/is_simulated BOOLEAN NOT NULL DEFAULT true CHECK \(is_simulated\)/g) || []).length;
    assert.strictEqual(simCount, tables.length, `expected ${tables.length} is_simulated constraints, found ${simCount}`);
});

test('sandbox transaction details are explicitly classified SIMULATED', () => {
    assert.match(MIGRATION, /SIMULATED MARKETING DEPOSIT/);
    assert.match(MIGRATION, /SIMULATED MARKETING WITHDRAWAL/);
    assert.match(MIGRATION, /SIMULATED MARKETING SUBSCRIPTION/);
});

// ---------------------------------------------------------------------------
// 2. DB backstops: production financial tables reject sandbox accounts
// ---------------------------------------------------------------------------
test('DB backstop triggers exist on every production financial table', () => {
    const triggers = [
        'trg_wallets_no_sandbox', 'trg_trades_no_sandbox', 'trg_deposits_no_sandbox',
        'trg_withdrawals_no_sandbox', 'trg_subscriptions_no_sandbox',
        'trg_sub_charges_no_sandbox', 'trg_payment_invoices_no_sandbox',
        'trg_transactions_no_sandbox', 'trg_referrals_no_sandbox',
    ];
    for (const tg of triggers) {
        assert.ok(MIGRATION.includes(`CREATE TRIGGER ${tg}`), `missing trigger ${tg}`);
    }
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.assert_user_not_marketing_sandbox\(\)/);
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.assert_wallet_not_marketing_sandbox\(\)/);
});

test('every backstop trigger covers BOTH INSERT and UPDATE (pivot-proof)', () => {
    // Extract every CREATE TRIGGER body and verify the guard tables use
    // INSERT OR UPDATE so an existing production row can never be repointed
    // at a sandbox user (and vice versa).
    const tables = ['wallets', 'trades', 'deposits', 'withdrawals', 'subscriptions',
        'subscription_charges', 'payment_invoices', 'transactions', 'referrals'];
    for (const t of tables) {
        const re = new RegExp(`CREATE TRIGGER trg_[a-z_]+no_sandbox\\s+BEFORE INSERT OR UPDATE ON public\\.${t}\\b`);
        assert.match(MIGRATION, re, `${t} trigger does not cover INSERT OR UPDATE`);
    }
    // The wallet guard must validate whenever user_id pivots, not only when
    // live_balance changes.
    const ws = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.assert_wallet_not_marketing_sandbox');
    const we = MIGRATION.indexOf('$$;', ws);
    const wbody = MIGRATION.slice(ws, we);
    assert.ok(wbody.includes('NEW.user_id IS NOT DISTINCT FROM OLD.user_id'), 'wallet guard skips user_id pivots');
    // The referrals guard checks BOTH referrer_id and referred_id.
    const rs = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.assert_referral_not_marketing_sandbox');
    const re2 = MIGRATION.indexOf('$$;', rs);
    const rbody = MIGRATION.slice(rs, re2);
    assert.ok(rbody.includes('NEW.referrer_id') && rbody.includes('NEW.referred_id'));
});

test('migration self-check block asserts all 10 triggers', () => {
    const names = [
        'trg_users_environment_immutable', 'trg_wallets_no_sandbox', 'trg_trades_no_sandbox',
        'trg_deposits_no_sandbox', 'trg_withdrawals_no_sandbox', 'trg_subscriptions_no_sandbox',
        'trg_sub_charges_no_sandbox', 'trg_payment_invoices_no_sandbox',
        'trg_transactions_no_sandbox', 'trg_referrals_no_sandbox',
    ];
    const doStart = MIGRATION.indexOf('Migration runtime self-check');
    assert.ok(doStart > 0, 'missing migration self-check block');
    const block = MIGRATION.slice(doStart);
    for (const n of names) {
        assert.ok(block.includes(n), `self-check missing ${n}`);
    }
    assert.match(block, /RAISE EXCEPTION/);
});

test('every sandbox RPC asserts the MARKETING_SANDBOX environment', () => {
    const rpcs = [
        'sandbox_ensure_wallet', 'sandbox_set_balance', 'sandbox_credit_deposit',
        'sandbox_record_trade', 'sandbox_charge_subscription', 'sandbox_request_withdrawal',
        'sandbox_set_withdrawal_status', 'sandbox_reset_account',
    ];
    for (const rpc of rpcs) {
        const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${rpc}\\(([^)])*\\)[\\s\\S]*?assert_sandbox_user`, 'm');
        assert.match(MIGRATION, re, `${rpc} does not call assert_sandbox_user`);
    }
});

test('sandbox RPCs only reference sandbox_* tables (never production tables)', () => {
    const prodTables = ['wallets', 'deposits', 'withdrawals', 'trades', 'transactions',
        'subscriptions', 'subscription_charges', 'payment_invoices'];
    // Extract each sandbox function body from the migration and check.
    const fnRe = /CREATE OR REPLACE FUNCTION public\.(sandbox_[a-z_]+)\(([\s\S]*?)\$\$;/g;
    let m; let checked = 0;
    while ((m = fnRe.exec(MIGRATION)) !== null) {
        const body = m[2];
        for (const t of prodTables) {
            const re = new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+public\\.${t}\\b`, 'i');
            // sandbox tables start with sandbox_ so `public.sandbox_x` never matches;
            // but plain `public.wallets` would.
            assert.ok(!re.test(body), `sandbox function ${m[1]} touches production table ${t}`);
        }
        checked++;
    }
    assert.ok(checked >= 8, `expected >= 8 sandbox functions checked, got ${checked}`);
});

// ---------------------------------------------------------------------------
// 3. Route-level isolation: production financial routes branch BEFORE prod code
// ---------------------------------------------------------------------------
const BRANCHED_ROUTES = [
    ['post', '/api/deposit/request', 'handleSandboxDepositRequest'],
    ['get', '/api/deposit/status/:invoiceId', 'handleSandboxDepositStatus'],
    ['post', '/api/payment/create-invoice', 'handleSandboxInvoiceCreate'],
    ['get', '/api/payment/invoice/:invoiceId', 'handleSandboxInvoiceGet'],
    ['post', '/api/payment/cancel/:invoiceId', 'handleSandboxInvoiceCancel'],
    ['post', '/api/payment/check/:invoiceId', 'advanceSandboxDeposit'],
    ['get', '/api/payment/history', 'handleSandboxPaymentHistory'],
    ['post', '/api/withdraw/request', 'handleSandboxWithdrawRequest'],
    ['get', '/api/withdraw/history', 'handleSandboxWithdrawHistory'],
    ['post', '/api/trade', 'handleSandboxTrade'],
    ['get', '/api/transactions', 'handleSandboxTransactions'],
    ['post', '/api/bot/start', 'handleSandboxBotStart'],
    ['post', '/api/bot/stop', 'handleSandboxBotStop'],
    ['get', '/api/bot/status', 'handleSandboxBotStatus'],
    ['get', '/api/subscription', 'handleSandboxSubscriptionGet'],
    ['post', '/api/subscription/activate', 'handleSandboxSubscriptionActivate'],
    ['post', '/api/subscription/cancel', 'handleSandboxSubscriptionCancel'],
];

for (const [method, route, handler] of BRANCHED_ROUTES) {
    test(`sandbox branch is the FIRST statement in ${method.toUpperCase()} ${route}`, () => {
        const body = routeBody(method, route);
        const branchIdx = body.indexOf('sandboxHandled(req, res');
        assert.ok(branchIdx >= 0, `no sandboxHandled branch in ${route}`);
        // The branch must appear before ANY production table/RPC reference in
        // the route body (otherwise production code could run first).
        let firstProd = Infinity;
        for (const ref of PROD_TABLE_REFS) {
            const i = body.indexOf(ref);
            if (i >= 0 && i < firstProd) firstProd = i;
        }
        // Some routes legitimately have no direct prod refs (e.g. history),
        // in which case the branch simply must exist.
        if (firstProd !== Infinity) {
            assert.ok(branchIdx < firstProd,
                `sandbox branch at ${branchIdx} comes after production code at ${firstProd} in ${route}`);
        }
        assert.ok(body.includes(handler), `${route} does not delegate to ${handler}`);
    });
}

test('KYC mutation routes block sandbox accounts', () => {
    for (const route of ['/api/kyc/personal-info', '/api/kyc/upload', '/api/kyc/submit', '/api/kyc/document/:documentId']) {
        const body = routeBody(route === '/api/kyc/document/:documentId' ? 'delete' : 'post', route);
        assert.ok(body.includes('blockSandboxKyc'), `${route} missing blockSandboxKyc guard`);
    }
});

test('can-withdraw special-cases sandbox WITHOUT weakening production KYC', () => {
    const body = routeBody('get', '/api/kyc/can-withdraw');
    assert.ok(body.includes('isMarketingSandboxUser'), 'sandbox special-case missing');
    // Production gate intact:
    assert.ok(body.includes('kycService.getVerificationStatus(userId)'), 'production KYC check removed');
    assert.ok(body.includes('VERIFICATION_STATUS.APPROVED'), 'production APPROVED comparison removed');
});

// ---------------------------------------------------------------------------
// 4. Sandbox handlers never touch production financial infrastructure
// ---------------------------------------------------------------------------
test('sandbox route handlers contain no production table/RPC/provider references', () => {
    const handlers = [
        'handleSandboxDepositRequest', 'handleSandboxInvoiceCreate', 'handleSandboxDepositStatus',
        'handleSandboxInvoiceGet', 'handleSandboxInvoiceCancel', 'handleSandboxPaymentHistory',
        'handleSandboxTrade', 'handleSandboxTransactions', 'handleSandboxBotStart',
        'handleSandboxBotStop', 'handleSandboxBotStatus', 'handleSandboxWithdrawRequest',
        'handleSandboxWithdrawHistory', 'handleSandboxSubscriptionGet',
        'handleSandboxSubscriptionActivate', 'handleSandboxSubscriptionCancel',
    ];
    for (const h of handlers) {
        const body = fnBody(h);
        for (const ref of PROD_TABLE_REFS) {
            assert.ok(!body.includes(ref), `sandbox handler ${h} references production ${ref}`);
        }
        // And it must reference at least one sandbox table/RPC/handler.
        assert.ok(/sandbox/i.test(body), `${h} references no sandbox table/RPC`);
    }
});

test('sandbox invoice creation never reaches PaymentService', () => {
    const body = routeBody('post', '/api/payment/create-invoice');
    const branchIdx = body.indexOf('sandboxHandled(req, res, handleSandboxInvoiceCreate)');
    const svcIdx = body.indexOf('paymentService');
    assert.ok(branchIdx >= 0 && svcIdx > branchIdx, 'sandbox branch does not precede PaymentService');
    assert.ok(!fnBody('handleSandboxInvoiceCreate').includes('paymentService'));
});

test('sandbox subscription never calls charge_subscription_safe', () => {
    const due = fnBody('processDueSandboxSubscription');
    assert.ok(due.includes('sandbox_charge_subscription'), 'due processor does not use sandbox RPC');
    for (const h of ['handleSandboxSubscriptionGet', 'handleSandboxSubscriptionActivate', 'handleSandboxSubscriptionCancel']) {
        assert.ok(!fnBody(h).includes('charge_subscription_safe'), `${h} calls production charge function`);
    }
    assert.ok(!due.includes('charge_subscription_safe'), 'due processor calls production charge function');
});

test('sandbox trade never calls record_trade_safe', () => {
    const body = fnBody('handleSandboxTrade');
    assert.ok(body.includes('sandbox_record_trade'));
    assert.ok(!body.includes('record_trade_safe'));
});

// ---------------------------------------------------------------------------
// 5. Sandbox self-service + admin controls verify environment server-side
// ---------------------------------------------------------------------------
test('/api/sandbox/* routes require auth + sandboxOnlyMiddleware', () => {
    for (const route of ['/api/sandbox/state', '/api/sandbox/reset', '/api/sandbox/balance', '/api/sandbox/intro-day', '/api/sandbox/badge']) {
        const method = route === '/api/sandbox/state' ? 'get' : 'post';
        const body = routeBody(method, route);
        assert.ok(body.includes('sandboxOnlyMiddleware'), `${route} missing sandboxOnlyMiddleware`);
    }
});

test('every /api/admin/sandbox control verifies the target is MARKETING_SANDBOX', () => {
    const re = /app\.(get|post)\('\/api\/admin\/sandbox([^']*)'/g;
    let m; let count = 0;
    while ((m = re.exec(SERVER)) !== null) {
        const full = '/api/admin/sandbox' + m[2];
        const body = routeBody(m[1], full);
        if (full.includes(':userId')) {
            assert.ok(body.includes('requireSandboxTargetUser'), `${full} does not verify target environment`);
        }
        assert.ok(body.includes('adminMiddleware'), `${full} missing adminMiddleware`);
        count++;
    }
    assert.ok(count >= 10, `expected >= 10 admin sandbox routes, got ${count}`);
});

test('requireSandboxTargetUser checks users.environment server-side', () => {
    const body = fnBody('requireSandboxTargetUser');
    assert.ok(body.includes('isMarketingSandboxUser'));
    assert.ok(body.includes('403'), 'missing authorization error');
});

test('sandboxOnlyMiddleware rejects non-sandbox callers with 403', () => {
    const body = fnBody('sandboxOnlyMiddleware');
    assert.ok(body.includes('403'));
    assert.ok(body.includes('isMarketingSandboxUser'));
});

test('public registration cannot create sandbox accounts', () => {
    const body = routeBody('post', '/api/auth/register');
    assert.ok(!body.includes("environment: ENV_MARKETING_SANDBOX"), 'register route can create sandbox accounts');
    assert.ok(body.includes('environment: ENV_PRODUCTION'), 'register must report PRODUCTION environment');
});

test('sandbox account creation is admin-only and sets environment once', () => {
    const body = routeBody('post', '/api/admin/sandbox/accounts');
    assert.ok(body.includes('adminMiddleware'));
    assert.ok(body.includes('environment: ENV_MARKETING_SANDBOX'));
    // Must NOT create a production wallet:
    assert.ok(!body.includes('getWallet('), 'sandbox account creation creates a production wallet');
});

// ---------------------------------------------------------------------------
// 6. Reverse regression: production behavior byte-unchanged
// ---------------------------------------------------------------------------
test('production /api/trade keeps record_trade_safe call unchanged', () => {
    const body = routeBody('post', '/api/trade');
    const afterBranch = body.slice(body.indexOf('handleSandboxTrade)) return;'));
    assert.ok(afterBranch.includes("supabaseAdmin.rpc('record_trade_safe'"), 'production trade RPC call changed');
    assert.ok(afterBranch.includes("p_mode: 'live'"), 'production trade mode changed');
    assert.ok(afterBranch.includes('getTodayRealizedPnl'), 'production PnL re-read removed');
});

test('production withdraw gate order unchanged (KYC first, then $700 min)', () => {
    const body = routeBody('post', '/api/withdraw/request');
    const kycIdx = body.indexOf('kycService.getVerificationStatus');
    const minIdx = body.indexOf('amount < 700');
    assert.ok(kycIdx > 0 && minIdx > kycIdx, 'production withdraw gate order changed');
});

test('production subscription activate still uses charge_subscription_safe', () => {
    const body = routeBody('post', '/api/subscription/activate');
    const afterBranch = body.slice(body.indexOf('handleSandboxSubscriptionActivate)) return;'));
    assert.ok(afterBranch.includes("supabaseAdmin.rpc('charge_subscription_safe'"), 'production subscription charge path changed');
});

test('production deposit status still credits via production deposits table', () => {
    const body = routeBody('get', '/api/deposit/status/:invoiceId');
    const afterBranch = body.slice(body.indexOf('handleSandboxDepositStatus)) return;'));
    assert.ok(afterBranch.includes("from('deposits')"), 'production deposit table read changed');
    assert.ok(afterBranch.includes("updateWallet(req.user.id, 'live_balance', deposit.amount)"), 'production credit changed');
});

test('production admin stats read production tables only (no sandbox contamination)', () => {
    const body = routeBody('get', '/api/admin/stats');
    assert.ok(!body.includes('sandbox'), 'admin stats reference sandbox tables');
});

// ---------------------------------------------------------------------------
// 7. Pure-JS mirrors of sandbox RPC semantics
// ---------------------------------------------------------------------------

// Mirror of sandbox_charge_subscription (sufficient-balance gate + idempotency).
function sandboxCharge(state, { userId, price, idempotencyKey }) {
    if (!state.users[userId] || state.users[userId].environment !== 'MARKETING_SANDBOX') {
        throw new Error('Not a MARKETING_SANDBOX account');
    }
    if (state.charges.has(idempotencyKey)) {
        return { success: true, duplicate: true, new_balance: state.wallet.balance };
    }
    if (state.wallet.balance < price) {
        state.sub.status = 'payment_due';
        return { success: false, reason: 'insufficient_balance', status: 'payment_due', available_balance: state.wallet.balance, price };
    }
    state.wallet.balance = Math.round((state.wallet.balance - price) * 100) / 100;
    state.charges.add(idempotencyKey);
    state.sub.status = 'active';
    return { success: true, duplicate: false, new_balance: state.wallet.balance, price };
}

test('subscription mirror: simulated $7 deduction decreases balance exactly once', () => {
    const state = {
        users: { 7: { environment: 'MARKETING_SANDBOX' } },
        wallet: { balance: 1000 },
        sub: { status: 'inactive' },
        charges: new Set(),
    };
    const r1 = sandboxCharge(state, { userId: 7, price: 7, idempotencyKey: 'k1' });
    assert.deepStrictEqual({ success: r1.success, balance: state.wallet.balance }, { success: true, balance: 993 });
    assert.strictEqual(state.sub.status, 'active');
    // Replay: idempotent, no second debit.
    const r2 = sandboxCharge(state, { userId: 7, price: 7, idempotencyKey: 'k1' });
    assert.ok(r2.duplicate && state.wallet.balance === 993);
    // Different period: charges again.
    const r3 = sandboxCharge(state, { userId: 7, price: 7, idempotencyKey: 'k2' });
    assert.ok(r3.success && !r3.duplicate && state.wallet.balance === 986);
});

test('subscription mirror: insufficient balance marks payment_due, charges $0', () => {
    const state = { users: { 7: { environment: 'MARKETING_SANDBOX' } }, wallet: { balance: 5 }, sub: { status: 'inactive' }, charges: new Set() };
    const r = sandboxCharge(state, { userId: 7, price: 7, idempotencyKey: 'k1' });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.reason, 'insufficient_balance');
    assert.strictEqual(state.wallet.balance, 5);
    assert.strictEqual(state.sub.status, 'payment_due');
});

test('subscription mirror: production user can never be charged via sandbox RPC', () => {
    const state = { users: { 1: { environment: 'PRODUCTION' } }, wallet: { balance: 1000 }, sub: { status: 'inactive' }, charges: new Set() };
    assert.throws(() => sandboxCharge(state, { userId: 1, price: 7, idempotencyKey: 'k1' }), /MARKETING_SANDBOX/);
    assert.strictEqual(state.wallet.balance, 1000);
});

// Mirror of sandbox_record_trade (clamp losses at 0 + idempotency).
function sandboxTrade(state, { amount, key }) {
    if (state.trades.has(key)) return { success: true, duplicate: true, new_balance: state.wallet.balance };
    let applied = amount;
    if (amount < 0 && state.wallet.balance + amount < 0) applied = -state.wallet.balance;
    state.wallet.balance = Math.max(0, Math.round((state.wallet.balance + applied) * 100) / 100);
    state.trades.set(key, applied);
    return { success: true, duplicate: false, applied_amount: applied, new_balance: state.wallet.balance };
}

test('trade mirror: simulated P&L moves balance and clamps losses at 0', () => {
    const state = { wallet: { balance: 100 }, trades: new Map() };
    const win = sandboxTrade(state, { amount: 25.5, key: 'a' });
    assert.strictEqual(win.new_balance, 125.5);
    const dup = sandboxTrade(state, { amount: 25.5, key: 'a' });
    assert.ok(dup.duplicate && state.wallet.balance === 125.5);
    const bigLoss = sandboxTrade(state, { amount: -1000, key: 'b' });
    assert.strictEqual(bigLoss.applied_amount, -125.5);
    assert.strictEqual(state.wallet.balance, 0);
});

// Mirror of sandbox_request_withdrawal (debit-at-request like production).
function sandboxWithdraw(state, { amount, address }) {
    if (amount <= 0) return { success: false, error: 'Amount must be greater than 0' };
    if (!address || address.trim().length < 4) return { success: false, error: 'Valid address required' };
    if (state.wallet.balance < amount) return { success: false, error: 'Insufficient balance' };
    state.wallet.balance = Math.round((state.wallet.balance - amount) * 100) / 100;
    state.withdrawals.push({ amount, status: 'pending' });
    return { success: true, status: 'pending', new_balance: state.wallet.balance };
}

test('withdrawal mirror: simulated debit, no real transfer, status pending', () => {
    const state = { wallet: { balance: 500 }, withdrawals: [] };
    const r = sandboxWithdraw(state, { amount: 200, address: 'TDEMOxyz123' });
    assert.ok(r.success && r.status === 'pending' && state.wallet.balance === 300);
    const tooBig = sandboxWithdraw(state, { amount: 9999, address: 'TDEMOxyz123' });
    assert.ok(!tooBig.success && state.wallet.balance === 300);
    const bad = sandboxWithdraw(state, { amount: 10, address: 'x' });
    assert.ok(!bad.success);
});

// Mirror of sandbox_set_withdrawal_status rejected-refund semantics.
function sandboxSetWithdrawalStatus(state, wid, newStatus) {
    if (!['pending', 'processing', 'completed', 'rejected'].includes(newStatus)) {
        return { success: false, error: 'Invalid status' };
    }
    const w = state.withdrawals.find((x) => x.id === wid);
    if (!w) return { success: false, error: 'Withdrawal not found' };
    if (w.status === 'rejected' && newStatus !== 'rejected') return { success: false, error: 'Rejected withdrawals are final' };
    if (newStatus === 'rejected') {
        if (w.status === 'completed') return { success: false, error: 'Cannot reject a completed withdrawal' };
        if (w.status !== 'rejected') {
            state.wallet.balance = Math.round((state.wallet.balance + w.amount) * 100) / 100;
        }
    }
    w.status = newStatus;
    return { success: true, status: newStatus };
}

test('withdrawal lifecycle mirror: pending->processing->completed debit-at-request, rejected refunds exactly once', () => {
    const state = { wallet: { balance: 1000 }, withdrawals: [] };
    const req = sandboxWithdraw(state, { amount: 250, address: 'TDEMOxyz123' });
    assert.strictEqual(state.wallet.balance, 750); // pending: debited at request
    state.withdrawals[0].id = 1;
    sandboxSetWithdrawalStatus(state, 1, 'processing');
    assert.strictEqual(state.wallet.balance, 750); // processing: no further change
    sandboxSetWithdrawalStatus(state, 1, 'rejected');
    assert.strictEqual(state.wallet.balance, 1000); // rejected: refund once
    const again = sandboxSetWithdrawalStatus(state, 1, 'rejected');
    assert.ok(again.success && state.wallet.balance === 1000); // no double refund
    // Rejected is terminal: cannot flow back to pending/processing/completed.
    const backToPending = sandboxSetWithdrawalStatus(state, 1, 'pending');
    assert.ok(!backToPending.success && state.wallet.balance === 1000);
    // A completed withdrawal cannot be rejected.
    const req2 = sandboxWithdraw(state, { amount: 100, address: 'TDEMOxyz123' });
    state.withdrawals[1].id = 2;
    sandboxSetWithdrawalStatus(state, 2, 'completed');
    const rejectCompleted = sandboxSetWithdrawalStatus(state, 2, 'rejected');
    assert.ok(!rejectCompleted.success && state.wallet.balance === 900);
});

test('set_withdrawal_status RPC supports rejected with one-time refund and locks the row', () => {
    const start = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.sandbox_set_withdrawal_status');
    const end = MIGRATION.indexOf('$$;', start);
    const body = MIGRATION.slice(start, end);
    assert.ok(body.includes("p_status NOT IN ('pending', 'processing', 'completed', 'rejected')"));
    assert.ok(body.includes('FOR UPDATE'), 'missing row lock');
    assert.ok(body.includes("v_withdrawal.status <> 'rejected'"), 'missing one-time refund guard');
    assert.ok(body.includes("v_withdrawal.status = 'completed'"), 'missing completed-is-final guard');
    assert.ok(body.includes('balance + v_withdrawal.amount'), 'missing refund');
    assert.ok(body.includes('SIMULATED MARKETING WITHDRAWAL REJECTED'), 'refund not classified simulated');
});

// Mirror of sandbox_reset_account (clears everything, balance -> 0, day -> 1).
test('reset mirror: all sandbox state cleared', () => {
    const state = { wallet: { balance: 5000, intro_day: 14, badge_hidden: true }, deposits: [1], withdrawals: [1], trades: [1], transactions: [1], subs: [{}], charges: [{}], bot: [{}] };
    // mirror
    state.deposits = []; state.withdrawals = []; state.trades = []; state.transactions = []; state.subs = []; state.charges = []; state.bot = [];
    state.wallet = { balance: 0, intro_day: 1, badge_hidden: false };
    assert.deepStrictEqual(state.wallet, { balance: 0, intro_day: 1, badge_hidden: false });
    assert.ok(state.deposits.length === 0 && state.trades.length === 0 && state.subs.length === 0);
});

test('intro day bounds enforced (1..15)', () => {
    assert.match(SERVER, /day < 1 \|\| day > 15/);
    assert.match(MIGRATION, /intro_day INT NOT NULL DEFAULT 1 CHECK \(intro_day BETWEEN 1 AND 15\)/);
});

test('balance presets/custom must be non-negative', () => {
    assert.match(MIGRATION, /p_amount IS NULL OR p_amount < 0/);
    assert.match(MIGRATION, /balance DECIMAL\(18, 2\) NOT NULL DEFAULT 0 CHECK \(balance >= 0\)/);
});

// ---------------------------------------------------------------------------
// 8. Frontend wiring (display-only; never trusted for isolation)
// ---------------------------------------------------------------------------
test('frontend adopts server environment classification', () => {
    assert.match(INDEX, /meData\.environment === 'MARKETING_SANDBOX'/);
    assert.match(INDEX, /APP\.environment = 'MARKETING_SANDBOX'/);
});

test('frontend shows a marketing demo badge driven by server state', () => {
    assert.match(INDEX, /id="sandboxBadge"/);
    assert.match(INDEX, /function updateSandboxBadge\(\)/);
    assert.match(INDEX, /sandboxBadgeHidden/);
});

test('frontend sandbox gate skips are keyed on APP.environment (display only)', () => {
    // Withdraw gate skip requires the server-issued classification.
    const withdrawSkip = INDEX.indexOf("const isSandbox = APP.environment === 'MARKETING_SANDBOX';\n    if (!isSandbox)");
    assert.ok(withdrawSkip > 0, 'withdraw gate skip not environment-gated');
    assert.match(INDEX, /APP\.liveData\.balance < APP\.MTA && !isSandbox/);
    // The bot-start MTA gate must NOT skip MARKETING_SANDBOX: the sandbox
    // demonstrates the real customer experience, so the $143 MTA applies there
    // too (see tests/bot_mta.test.js).
    assert.match(INDEX, /if\(APP\.mode === 'live' && APP\.liveData\.balance < APP\.MTA\) \{\n        showToast\(t\('bot\.mtaBlocked'\),'error'\);\n        return;/);
    const startBotIdx = INDEX.indexOf('function startBot()');
    const startBotBody = INDEX.slice(startBotIdx, startBotIdx + 1200);
    assert.ok(!startBotBody.includes("APP.environment !== 'MARKETING_SANDBOX'"), 'startBot must not exempt MARKETING_SANDBOX from the MTA gate');
});

test('frontend admin sandbox controls call only /api/admin/sandbox endpoints', () => {
    const start = INDEX.indexOf('// ============ MARKETING SANDBOX ADMIN CONTROLS ============');
    assert.ok(start > 0);
    const end = INDEX.indexOf('async function confirmDeposit', start);
    const section = INDEX.slice(start, end);
    assert.ok(!section.includes("fetch('/api/"), 'admin controls use non-sandbox endpoints');
    assert.ok((section.match(/sandboxAdminFetch\('\/api\/admin\/sandbox/g) || []).length >= 10);
});

test('analytics events carry the environment classification', () => {
    assert.match(INDEX, /environment: \(typeof APP !== 'undefined' && APP\.environment\) \? APP\.environment : 'PRODUCTION'/);
});

test('sandbox admin tab exists and loads sandbox accounts', () => {
    assert.match(INDEX, /id="adminTabSandbox"/);
    assert.match(INDEX, /id="adminTabContentSandbox"/);
    assert.match(INDEX, /loadSandboxAccounts\(\)/);
});

// ---------------------------------------------------------------------------
// 9. Sandbox deposit/trade/withdraw/subscription response shapes
// ---------------------------------------------------------------------------
test('sandbox deposit handlers return legacy-compatible shapes', () => {
    assert.match(SERVER, /creditedAmount: deposit\.status === 'confirmed'/);
    assert.match(SERVER, /newBalance: wallet\.live_balance/);
    assert.match(SERVER, /invoice: \{\s*id: deposit\.invoice_id/);
});

test('sandbox state endpoint returns intro day + subscription + bot state', () => {
    const body = routeBody('get', '/api/sandbox/state');
    assert.ok(body.includes('introDay') && body.includes('subscription') && body.includes('bot'));
    assert.ok(body.includes('simulated: true'));
});

test('admin trade generation uses unique idempotency keys per demo trade', () => {
    const body = routeBody('post', '/api/admin/sandbox/:userId/trades');
    assert.ok(body.includes('sbx_demo_'), 'demo trade keys not namespaced');
    assert.ok(body.includes('sandbox_record_trade'), 'demo trades not recorded via sandbox RPC');
});

// ---------------------------------------------------------------------------
// 10. Sandbox login: skip production email-2FA (fictional emails receive nothing)
// ---------------------------------------------------------------------------
// Executes the REAL /api/2fa/login-initiate source against stubbed supabase/
// bcrypt/jwt/2FA helpers. Sandbox users must get a full token with no email
// code; production users must keep the existing email-2FA flow exactly.
function loginInitiateHandler() {
    const start = SERVER.indexOf("app.post('/api/2fa/login-initiate'");
    const end = SERVER.indexOf('// POST /api/2fa/login-verify');
    assert.ok(start !== -1 && end > start, 'login-initiate source not found');
    return SERVER.slice(start, end);
}

async function runLoginInitiate(user, body, spies) {
    const res = {
        statusCode: 200,
        body: undefined,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; }
    };
    // Phase 2: all server-side table access uses the service-role client
    // (supabaseAdmin); the anon client is stubbed too so the harness fails
    // loudly if a route ever regresses to anon access.
    const supabase = {
        from(t) { spies.tables.push(t); return {
            select: () => ({ eq: () => ({ single: async () =>
                ({ data: user, error: user ? null : { message: 'no rows' } }) }) })
        }; }
    };
    const ctx = {
        supabase,
        supabaseAdmin: supabase,
        bcrypt: { compare: async () => spies.passwordOk },
        jwt: { sign: (payload) => 'signed:' + JSON.stringify(payload) },
        JWT_SECRET: 'test-secret',
        ENV_MARKETING_SANDBOX: 'MARKETING_SANDBOX',
        get2FAType: async () => { spies.get2faCalled++; return 'email'; },
        hasUser2FAEnabled: async () => { spies.totpChecked++; return false; },
        Email2FAService: { checkResendRateLimit: async () => ({ allowed: true }) },
        sendEmailVerificationCode: async (...a) => { spies.emailCodes.push(a); },
        maskEmail: (e) => e,
        console,
    };
    ctx.app = { post: (p, h) => { ctx.__handler = h; } };
    vm.createContext(ctx);
    vm.runInContext(loginInitiateHandler() + '\n__handler;', ctx);
    await ctx.__handler({ body }, res);
    return res;
}

const NO_2FA_USER_KEYS = ['id', 'name', 'email', 'referralCode', 'isAdmin', 'is_admin', 'is_verified'];

test('sandbox user: valid credentials return full JWT, no 2FA, no email code', async () => {
    const user = { id: 42, name: 'Demo', email: 'marketing-demo+x@sandbox.arbitrix.invalid',
        password_hash: 'h', referral_code: 'RC', is_admin: 0, environment: 'MARKETING_SANDBOX' };
    const spies = { passwordOk: true, get2faCalled: 0, totpChecked: 0, emailCodes: [], tables: [] };
    const res = await runLoginInitiate(user, { email: user.email, password: 'pw' }, spies);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.requires2FA, false, 'sandbox must bypass 2FA');
    assert.ok(res.body.token && res.body.token.startsWith('signed:'), 'full JWT expected');
    assert.ok(!res.body.partialToken, 'no pending-2FA partial token');
    assert.deepStrictEqual(Object.keys(res.body.user), NO_2FA_USER_KEYS);
    assert.strictEqual(res.body.user.environment, undefined, 'shape identical to no-2FA path');
    assert.strictEqual(spies.get2faCalled, 0, 'get2FAType must not run for sandbox');
    assert.strictEqual(spies.emailCodes.length, 0, 'no email verification code may be sent');
    assert.ok(!spies.tables.includes('email_verification_codes'), 'no verification-code record');
    assert.deepStrictEqual(spies.tables, ['users'], 'only the users lookup may run');
});

test('production user: email-2FA flow unchanged (partial token + email code)', async () => {
    const user = { id: 7, name: 'Real', email: 'real@example.com',
        password_hash: 'h', referral_code: 'RC', is_admin: 0, environment: 'PRODUCTION' };
    const spies = { passwordOk: true, get2faCalled: 0, totpChecked: 0, emailCodes: [], tables: [] };
    const res = await runLoginInitiate(user, { email: user.email, password: 'pw' }, spies);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.requires2FA, true, 'production must keep 2FA');
    assert.strictEqual(res.body.twoFactorType, 'email');
    assert.ok(res.body.partialToken, 'pending-2FA partial token expected');
    assert.ok(!res.body.token, 'no full token until verify');
    assert.strictEqual(spies.emailCodes.length, 1, 'production email code must still be sent');
});

test('environment is read from the DB record; client cannot override it', async () => {
    const user = { id: 9, name: 'Prod', email: 'prod@example.com',
        password_hash: 'h', referral_code: 'RC', is_admin: 0, environment: 'PRODUCTION' };
    const spies = { passwordOk: true, get2faCalled: 0, totpChecked: 0, emailCodes: [], tables: [] };
    const res = await runLoginInitiate(user,
        { email: user.email, password: 'pw', environment: 'MARKETING_SANDBOX' }, spies);
    assert.strictEqual(res.body.requires2FA, true, 'request-supplied environment must be ignored');
});

test('sandbox branch sits after password validation and before get2FAType', () => {
    const src = loginInitiateHandler();
    const pwIdx = src.indexOf('const passwordValid = await bcrypt.compare');
    const bypassIdx = src.indexOf('if (user.environment === ENV_MARKETING_SANDBOX)');
    const flagIdx = src.indexOf('const twoFactorType = await get2FAType();');
    assert.ok(pwIdx !== -1 && bypassIdx !== -1 && flagIdx !== -1);
    assert.ok(pwIdx < bypassIdx && bypassIdx < flagIdx,
        'sandbox bypass must be positioned after password check, before 2FA branches');
});

test('sandbox user with wrong password still gets 401 (no bypass leak)', async () => {
    const user = { id: 42, name: 'Demo', email: 'm@sandbox.arbitrix.invalid',
        password_hash: 'h', referral_code: 'RC', is_admin: 0, environment: 'MARKETING_SANDBOX' };
    const spies = { passwordOk: false, get2faCalled: 0, totpChecked: 0, emailCodes: [], tables: [] };
    const res = await runLoginInitiate(user, { email: user.email, password: 'bad' }, spies);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.error, 'Invalid credentials');
    assert.strictEqual(spies.emailCodes.length, 0);
});
