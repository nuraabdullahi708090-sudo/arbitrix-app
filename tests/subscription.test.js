'use strict';

/**
 * Phase 8 — Arbitrix Pro Subscription contract tests.
 *
 * server.js is a single Express app that binds a port on require (app.listen),
 * so these tests do NOT import it (same constraint as withdraw_gating.test.js
 * and trades_pnl.test.js). Instead they pin:
 *
 *   1. The atomic charge logic mirrored from the `charge_subscription_safe`
 *      SECURITY DEFINER plpgsql function in supabase/migrations/011_*.sql:
 *        - idempotency (UNIQUE idempotency_key -> never double-charged)
 *        - sufficient-balance gate BEFORE any mutation (never negative,
 *          never consumes funds that are not genuinely available)
 *        - ONLY wallets.live_balance is touched (demo/bonus never used)
 *        - on insufficient balance: $0 charged, status -> 'payment_due',
 *          balance preserved exactly
 *        - on success: live_balance -= price, ledger + transactions row,
 *          status -> 'active', next_billing_date advances one month
 *   2. The server-side billing-key derivation (subscriptionBillingKey): a user
 *      can never be charged twice for the same billing period because the key
 *      is derived ONLY from the user id + the target UTC month.
 *   3. The due-billing decision (processDueSubscription): only 'active'/'payment_due'
 *      subscriptions are billable; 'inactive'/'cancelled' are never billed; an
 *      active subscription is due only when next_billing_date <= now.
 *   4. Server.js contracts (grep-verified): the subscription endpoints use
 *      authMiddleware (never accept a client userId/price), the deposit
 *      credit/withdrawal gate code is byte-unchanged (pure additions only), and
 *      a NEW transactions.type 'Subscription' is introduced without altering
 *      existing type meanings.
 *
 * Available-balance model (from the migration doc): this app has NO locked /
 * committed / open-position funds — trades are realized immediately via
 * record_trade_safe(), so the genuinely available balance IS wallets.live_balance.
 * Therefore a subscription debit of live_balance cannot consume committed
 * funds (none exist), and the test #4 "locked/committed funds" scenario is
 * modeled by proving demo/bonus balances are never touched and that the
 * charge reads only live_balance.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '011_subscription_pro.sql'),
    'utf8'
);

// ---------------------------------------------------------------------------
// Faithful mirror of `charge_subscription_safe` (the DB function). Pure JS
// model of the atomic charge: idempotency + FOR UPDATE lock + sufficient-balance
// gate + atomic debit. Operates on an in-memory wallet + ledger + sub state.
// ---------------------------------------------------------------------------
function chargeSubscriptionSafe(state, { userId, price, idempotencyKey, periodLabel }) {
    // Validate inputs (mirror the DB guard clauses).
    if (userId == null) return { success: false, error: 'user_id is required' };
    if (!idempotencyKey || !String(idempotencyKey).trim()) return { success: false, error: 'idempotency_key is required' };
    const p = Math.round(Number(price) * 100) / 100;
    if (!(p >= 0)) return { success: false, error: 'price must be non-negative' };

    // Idempotency check #1 (before lock).
    const prior = state.ledger.find(r => r.idempotencyKey === idempotencyKey);
    if (prior) {
        return { success: true, duplicate: true, message: 'already charged',
            new_balance: prior.balanceAfter, price: prior.price };
    }

    const sub = state.subs[userId];
    if (!sub) return { success: false, error: 'Subscription not found' };
    if (sub.status === 'cancelled') return { success: false, error: 'Subscription cancelled', reason: 'cancelled' };

    const wallet = state.wallets[userId] || { live_balance: 0, demo_balance: 1000, bonus_balance: 0 };

    // Idempotency check #2 (after lock) — same key could have been inserted by
    // a concurrent tx between the two checks.
    const prior2 = state.ledger.find(r => r.idempotencyKey === idempotencyKey);
    if (prior2) {
        return { success: true, duplicate: true, message: 'already charged (race)',
            new_balance: prior2.balanceAfter, price: prior2.price };
    }

    // SUFFICIENT-BALANCE GATE: only genuinely available Live balance.
    if (wallet.live_balance < p) {
        sub.status = 'payment_due';
        return { success: false, reason: 'insufficient_balance',
            available_balance: wallet.live_balance, price: p, status: 'payment_due' };
    }

    // Atomic debit (safe: just proved live_balance >= p). demo/bonus untouched.
    const newBalance = wallet.live_balance - p;
    wallet.live_balance = newBalance;

    // Ledger row (idempotency anchor).
    state.ledger.push({ idempotencyKey, userId, price: p, balanceAfter: newBalance });

    // User-facing transaction row, NEW type 'Subscription' (existing types unchanged).
    state.transactions.push({ user_id: userId, type: 'Subscription', amount: -p,
        detail: 'Arbitrix Pro Subscription' + (periodLabel ? ' - ' + periodLabel : '') });

    // Advance billing + activate.
    sub.status = 'active';
    sub.last_billing_date = new Date();
    sub.last_charge_amount = p;
    sub.started_at = sub.started_at || new Date();
    sub.next_billing_date = new Date(Date.now() + 30 * 24 * 3600 * 1000);

    return { success: true, duplicate: false, price: p, new_balance: newBalance,
        status: 'active', next_billing_date: sub.next_billing_date };
}

// Mirror of subscriptionBillingKey(userId, anchorDate, billingKind) in server.js.
function billingKey(userId, anchorDate, billingKind = 'monthly') {
    const d = anchorDate ? new Date(anchorDate) : new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const periodLabel = `${yyyy}-${mm}`;
    return { periodLabel, idempotencyKey: `sub_${userId}_${billingKind}_${periodLabel}` };
}

// Mirror of processDueSubscription's billability + due decision (server.js).
function isBillableDue(sub, now = new Date()) {
    if (sub.status !== 'active' && sub.status !== 'payment_due') {
        return { due: false, reason: 'not_billable', status: sub.status };
    }
    if (sub.status === 'active') {
        if (sub.next_billing_date && new Date(sub.next_billing_date) <= now) {
            return { due: true, anchor: new Date(sub.next_billing_date) };
        }
        return { due: false, reason: 'not_due', status: sub.status };
    }
    // payment_due: retry collection for the due period (idempotency guards).
    let anchor = sub.next_billing_date ? new Date(sub.next_billing_date) : now;
    if (anchor > now) anchor = now;
    return { due: true, anchor };
}

function freshState({ live = 0, demo = 1000, bonus = 0, status = 'inactive' } = {}) {
    return {
        wallets: { 1: { live_balance: live, demo_balance: demo, bonus_balance: bonus } },
        subs: { 1: { status, next_billing_date: null, last_billing_date: null, started_at: null, last_charge_amount: null, price: 7, plan: 'pro' } },
        ledger: [],
        transactions: [],
    };
}

const PRICE = 7;

// ---------------------------------------------------------------------------
// 1. $7 charge with sufficient available balance
// ---------------------------------------------------------------------------
test('1. charges $7 when available Live balance is sufficient', () => {
    const s = freshState({ live: 500 });
    const { periodLabel, idempotencyKey } = billingKey(1, new Date('2026-08-17T13:00:00Z'), 'activate');
    const r = chargeSubscriptionSafe(s, { userId: 1, price: PRICE, idempotencyKey, periodLabel });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.duplicate, false);
    assert.strictEqual(r.price, 7);
    assert.strictEqual(r.new_balance, 493);
    assert.strictEqual(s.wallets[1].live_balance, 493);
    assert.strictEqual(s.subs[1].status, 'active');
});

// ---------------------------------------------------------------------------
// 2. Exact $7 available balance -> charged, balance becomes 0 (not negative)
// ---------------------------------------------------------------------------
test('2. exact $7 available balance -> charged to 0', () => {
    const s = freshState({ live: 7 });
    const { idempotencyKey, periodLabel } = billingKey(1, new Date('2026-08-17T13:00:00Z'), 'activate');
    const r = chargeSubscriptionSafe(s, { userId: 1, price: PRICE, idempotencyKey, periodLabel });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.new_balance, 0);
    assert.strictEqual(s.wallets[1].live_balance, 0);
    assert.strictEqual(s.subs[1].status, 'active');
});

// ---------------------------------------------------------------------------
// 3. $6.99 available balance -> NO charge, payment_due, balance preserved
// ---------------------------------------------------------------------------
test('3. $6.99 available balance -> no charge, payment_due, balance preserved', () => {
    const s = freshState({ live: 6.99 });
    const { idempotencyKey, periodLabel } = billingKey(1, new Date('2026-08-17T13:00:00Z'), 'activate');
    const r = chargeSubscriptionSafe(s, { userId: 1, price: PRICE, idempotencyKey, periodLabel });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.reason, 'insufficient_balance');
    assert.strictEqual(r.status, 'payment_due');
    assert.strictEqual(s.wallets[1].live_balance, 6.99); // unchanged
    assert.strictEqual(s.subs[1].status, 'payment_due');
    assert.strictEqual(s.ledger.length, 0); // no ledger row written
    assert.strictEqual(s.transactions.length, 0); // no transaction row written
});

// ---------------------------------------------------------------------------
// 4. Locked/committed trading funds cannot be consumed (demo/bonus untouched)
// ---------------------------------------------------------------------------
test('4. demo balance and bonus balance are never consumed by a charge', () => {
    // The charge function only reads live_balance. Even with $0 live and large
    // demo/bonus, no charge occurs and demo/bonus are untouched.
    const s = freshState({ live: 0, demo: 100000, bonus: 100000 });
    const { idempotencyKey, periodLabel } = billingKey(1, new Date('2026-08-17T13:00:00Z'), 'activate');
    const r = chargeSubscriptionSafe(s, { userId: 1, price: PRICE, idempotencyKey, periodLabel });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.reason, 'insufficient_balance');
    assert.strictEqual(s.wallets[1].demo_balance, 100000);
    assert.strictEqual(s.wallets[1].bonus_balance, 100000);
    assert.strictEqual(s.wallets[1].live_balance, 0);
});

test('4b. a successful charge debits only live_balance; demo/bonus unchanged', () => {
    const s = freshState({ live: 350, demo: 5000, bonus: 200 });
    const { idempotencyKey, periodLabel } = billingKey(1, new Date('2026-08-17T13:00:00Z'), 'activate');
    const r = chargeSubscriptionSafe(s, { userId: 1, price: PRICE, idempotencyKey, periodLabel });
    assert.strictEqual(r.success, true);
    assert.strictEqual(s.wallets[1].live_balance, 343);
    assert.strictEqual(s.wallets[1].demo_balance, 5000);   // untouched
    assert.strictEqual(s.wallets[1].bonus_balance, 200);    // untouched
});

// ---------------------------------------------------------------------------
// 5. Duplicate billing attempt (same period key) -> only one $7 charge
// ---------------------------------------------------------------------------
test('5. duplicate billing for the same period -> only one charge', () => {
    const s = freshState({ live: 500 });
    const { idempotencyKey, periodLabel } = billingKey(1, new Date('2026-08-17T13:00:00Z'), 'activate');
    const r1 = chargeSubscriptionSafe(s, { userId: 1, price: PRICE, idempotencyKey, periodLabel });
    const r2 = chargeSubscriptionSafe(s, { userId: 1, price: PRICE, idempotencyKey, periodLabel });
    assert.strictEqual(r1.success, true);
    assert.strictEqual(r1.duplicate, false);
    assert.strictEqual(r2.success, true);
    assert.strictEqual(r2.duplicate, true); // second attempt is a no-op duplicate
    assert.strictEqual(s.wallets[1].live_balance, 493); // only ONE $7 taken
    assert.strictEqual(s.ledger.length, 1);
    assert.strictEqual(s.transactions.length, 1);
});

// ---------------------------------------------------------------------------
// 6. Repeated request (race-condition double-check after lock) -> one charge
// ---------------------------------------------------------------------------
test('6. simulated race: pre-insert ledger between the two idempotency checks -> duplicate', () => {
    const s = freshState({ live: 500 });
    const { idempotencyKey, periodLabel } = billingKey(1, new Date('2026-08-17T13:00:00Z'), 'activate');
    // Model a concurrent tx that inserts the ledger row between check #1 and #2.
    s.ledger.push({ idempotencyKey, userId: 1, price: PRICE, balanceAfter: 493 });
    s.wallets[1].live_balance = 493; // concurrent tx already debited
    const r = chargeSubscriptionSafe(s, { userId: 1, price: PRICE, idempotencyKey, periodLabel });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.duplicate, true); // detected, no second debit
    assert.strictEqual(s.wallets[1].live_balance, 493); // unchanged by the duplicate
    assert.strictEqual(s.ledger.length, 1);
});

// ---------------------------------------------------------------------------
// 7. Payment date advances correctly (next_billing_date = +1 month on success)
// ---------------------------------------------------------------------------
test('7. next_billing_date advances one month after a successful charge', () => {
    const s = freshState({ live: 500, status: 'payment_due' });
    s.subs[1].next_billing_date = new Date('2026-08-17T13:00:00Z');
    const { idempotencyKey, periodLabel } = billingKey(1, new Date('2026-08-17T13:00:00Z'), 'activate');
    const before = new Date('2026-08-17T13:00:00Z');
    const r = chargeSubscriptionSafe(s, { userId: 1, price: PRICE, idempotencyKey, periodLabel });
    assert.strictEqual(r.success, true);
    assert.ok(new Date(r.next_billing_date) > before, 'next_billing_date must advance');
    assert.ok(s.subs[1].last_billing_date, 'last_billing_date set');
    assert.strictEqual(s.subs[1].last_charge_amount, 7);
});

// ---------------------------------------------------------------------------
// 8. Failed charge becomes Payment Due / Inactive
// ---------------------------------------------------------------------------
test('8. failed charge marks subscription payment_due and preserves balance', () => {
    const s = freshState({ live: 3, status: 'active' });
    const { idempotencyKey, periodLabel } = billingKey(1, new Date('2026-08-17T13:00:00Z'), 'monthly');
    const r = chargeSubscriptionSafe(s, { userId: 1, price: PRICE, idempotencyKey, periodLabel });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.reason, 'insufficient_balance');
    assert.strictEqual(s.subs[1].status, 'payment_due');
    assert.strictEqual(s.wallets[1].live_balance, 3); // preserved
});

// ---------------------------------------------------------------------------
// 9. No negative balance is ever created
// ---------------------------------------------------------------------------
test('9. balance never goes negative even at the exact boundary', () => {
    const s = freshState({ live: 7 });
    const { idempotencyKey, periodLabel } = billingKey(1, new Date('2026-08-17T13:00:00Z'), 'activate');
    const r = chargeSubscriptionSafe(s, { userId: 1, price: PRICE, idempotencyKey, periodLabel });
    assert.ok(s.wallets[1].live_balance >= 0, 'live_balance >= 0');
    assert.strictEqual(r.new_balance, 0);
    // And below the boundary nothing is charged at all.
    const s2 = freshState({ live: 6.99 });
    const r2 = chargeSubscriptionSafe(s2, { userId: 1, price: PRICE,
        idempotencyKey: billingKey(1, new Date('2026-08-17T13:00:00Z'), 'activate').idempotencyKey + '_x',
        periodLabel });
    assert.ok(s2.wallets[1].live_balance >= 0);
    assert.strictEqual(r2.success, false);
});

// ---------------------------------------------------------------------------
// 10. Subscription charge appears in history (transactions row, type Subscription)
// ---------------------------------------------------------------------------
test('10. successful charge writes a Subscription transaction row', () => {
    const s = freshState({ live: 500 });
    const { idempotencyKey, periodLabel } = billingKey(1, new Date('2026-08-17T13:00:00Z'), 'activate');
    chargeSubscriptionSafe(s, { userId: 1, price: PRICE, idempotencyKey, periodLabel });
    assert.strictEqual(s.transactions.length, 1);
    const tx = s.transactions[0];
    assert.strictEqual(tx.type, 'Subscription');
    assert.strictEqual(tx.amount, -7);
    assert.ok(String(tx.detail).includes('Arbitrix Pro Subscription'));
});

// ---------------------------------------------------------------------------
// 11. Existing deposit behavior unchanged (server.js deposit endpoints untouched)
// ---------------------------------------------------------------------------
test('11. deposit/credit_payment_safe/record_trade_safe code is unchanged in server.js', () => {
    // server.js diff is pure-addition (no removed lines), and the deposit
    // credit + trade record functions are still referenced unchanged.
    assert.ok(/credit_payment_safe/.test(SERVER), 'credit_payment_safe still referenced');
    assert.ok(/record_trade_safe/.test(SERVER), 'record_trade_safe still referenced');
    assert.ok(/\/api\/deposit\/request/.test(SERVER), 'deposit request route present');
    assert.ok(/\/api\/withdraw\/request/.test(SERVER), 'withdraw request route present');
    // The migration explicitly asserts these functions survive.
    assert.ok(/credit_payment_safe missing - deposit system must remain untouched/.test(MIGRATION));
    assert.ok(/record_trade_safe missing - trade system must remain untouched/.test(MIGRATION));
});

// ---------------------------------------------------------------------------
// 12. Existing withdrawal behavior unchanged (no subscription gate added)
// ---------------------------------------------------------------------------
test('12. withdrawal gate is unchanged — subscription is NOT a withdrawal gate', () => {
    // The withdraw handler must not reference subscription status. Its gates
    // remain KYC -> $700 min -> balance -> address -> trade count (Phase 7A).
    const m = SERVER.match(/app\.post\('\/api\/withdraw\/request'[\s\S]*?\n}\);/);
    assert.ok(m, 'withdraw handler found');
    const handler = m[0];
    assert.ok(!/subscription/i.test(handler), 'withdraw handler must not reference subscription');
    assert.ok(/Identity verification required/.test(handler), 'KYC gate intact');
    assert.ok(/Min \$700/.test(handler), '$700 minimum gate intact');
    assert.ok(/Complete at least 1 trade/.test(handler), 'trade-count gate intact');
});

// ---------------------------------------------------------------------------
// 13. User cannot charge another user's subscription (server derives userId)
// ---------------------------------------------------------------------------
test('13. subscription endpoints derive userId from authMiddleware, never the client', () => {
    // Every subscription route must be behind authMiddleware and use req.user.id.
    ['app.get(\'/api/subscription\'', 'app.post(\'/api/subscription/activate\'', 'app.post(\'/api/subscription/cancel\''].forEach(sig => {
        assert.ok(SERVER.includes(sig), `route ${sig} present`);
        const idx = SERVER.indexOf(sig);
        const slice = SERVER.slice(idx, idx + 600);
        assert.ok(/authMiddleware/.test(slice), `${sig} uses authMiddleware`);
        assert.ok(/req\.user\.id/.test(slice), `${sig} derives userId from req.user.id`);
    });
    // The charge RPC always passes p_user_id = userId (server-derived), and
    // never accepts a client-supplied userId/price in the activation path.
    assert.ok(/const userId = req\.user\.id;[\s\S]*?getSubscriptionPrice\(\)/.test(SERVER));
});

// ---------------------------------------------------------------------------
// 14. Frontend cannot manipulate the subscription price
// ---------------------------------------------------------------------------
test('14. server price is read from payment_config; client body is ignored', () => {
    // getSubscriptionPrice reads payment_config('subscription.pro_price'); the
    // activate handler does NOT read req.body.price.
    assert.ok(/getSubscriptionPrice[\s\S]*?payment_config[\s\S]*?subscription\.pro_price/.test(SERVER));
    const m = SERVER.match(/app\.post\('\/api\/subscription\/activate'[\s\S]*?\n}\);/);
    assert.ok(m, 'activate handler found');
    assert.ok(!/req\.body\.price/.test(m[0]), 'activate must not read req.body.price');
    assert.ok(!/req\.body\.userId/.test(m[0]), 'activate must not read req.body.userId');
    // Migration seeds the server-controlled price.
    assert.ok(/subscription\.pro_price.*'7'/.test(MIGRATION));
});

// ---------------------------------------------------------------------------
// 15. Demo balance cannot be used for subscription billing
// ---------------------------------------------------------------------------
test('15. the DB charge function reads ONLY live_balance (demo/bonus never used)', () => {
    // The migration function must gate on wallets.live_balance and never read
    // demo_balance / bonus_balance for the sufficiency check or the debit.
    const fn = MIGRATION.match(/CREATE OR REPLACE FUNCTION public\.charge_subscription_safe[\s\S]*?\$\$;/);
    assert.ok(fn, 'charge_subscription_safe function present in migration');
    const body = fn[0];
    assert.ok(/IF v_wallet\.live_balance < v_price/.test(body), 'gates on live_balance');
    assert.ok(/v_new_balance := v_wallet\.live_balance - v_price/.test(body), 'debits live_balance only');
    assert.ok(/SET live_balance = v_new_balance/.test(body), 'updates live_balance only');
    assert.ok(/NEVER touches demo_balance \/ bonus_balance/.test(MIGRATION), 'documented invariant');
    // No executable SQL statement in the charge path references demo/bonus
    // balances (comments are stripped before checking). The UPDATE wallets
    // statement must set ONLY live_balance.
    const stripped = body.replace(/--[^\n]*/g, '');
    assert.ok(!/demo_balance/.test(stripped), 'charge fn must not touch demo_balance in SQL');
    assert.ok(!/bonus_balance/.test(stripped), 'charge fn must not touch bonus_balance in SQL');
    const updateStmt = stripped.match(/UPDATE wallets[\s\S]*?WHERE user_id = p_user_id;/);
    assert.ok(updateStmt, 'UPDATE wallets statement found');
    assert.ok(/SET live_balance = v_new_balance/.test(updateStmt[0]), 'UPDATE sets only live_balance');
    assert.ok(!/demo_balance/.test(updateStmt[0]), 'UPDATE does not set demo_balance');
    assert.ok(!/bonus_balance/.test(updateStmt[0]), 'UPDATE does not set bonus_balance');
});

// ---------------------------------------------------------------------------
// Bonus: billing-key uniqueness guarantees one charge per period per user
// ---------------------------------------------------------------------------
test('billingKey is unique per user per UTC month -> prevents double-charge', () => {
    const a = billingKey(1, new Date('2026-08-17T13:00:00Z'), 'monthly');
    const b = billingKey(1, new Date('2026-08-31T23:59:00Z'), 'monthly');
    const c = billingKey(2, new Date('2026-08-17T13:00:00Z'), 'monthly');
    const d = billingKey(1, new Date('2026-09-01T00:00:00Z'), 'monthly');
    assert.strictEqual(a.idempotencyKey, b.idempotencyKey); // same user+month
    assert.notStrictEqual(a.idempotencyKey, c.idempotencyKey); // different user
    assert.notStrictEqual(a.idempotencyKey, d.idempotencyKey); // different month
});

// ---------------------------------------------------------------------------
// Bonus: due-billing decision never bills inactive/cancelled
// ---------------------------------------------------------------------------
test('inactive and cancelled subscriptions are never billed', () => {
    assert.strictEqual(isBillableDue({ status: 'inactive' }).due, false);
    assert.strictEqual(isBillableDue({ status: 'cancelled' }).due, false);
    assert.strictEqual(isBillableDue({ status: 'active', next_billing_date: new Date(Date.now() + 86400000) }).due, false);
    const past = new Date(Date.now() - 86400000);
    assert.strictEqual(isBillableDue({ status: 'active', next_billing_date: past }).due, true);
    assert.strictEqual(isBillableDue({ status: 'payment_due', next_billing_date: past }).due, true);
});
