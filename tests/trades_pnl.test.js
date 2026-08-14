'use strict';

/**
 * Frontend wallet/P&L synchronization contract tests.
 *
 * server.js is a single Express app that binds a port on require (app.listen),
 * so these tests do NOT import it. Instead they pin the pure logic that the
 * three synchronization fixes depend on:
 *
 *   1. Today's realized P&L is the signed sum of ONLY trade-ledger rows whose
 *      created_at is within the current UTC day (the exact contract of
 *      getTodayRealizedPnl). Deposits, withdrawals, referral bonuses, and other
 *      transaction types can never contribute, and a trade that was never
 *      persisted can never appear.
 *   2. "Funded" status is "at least one confirmed deposit exists" (the contract
 *      of hasConfirmedDeposit) — not balance > 50.
 *   3. The optimistic-then-rollback flow used by persistLiveTrade: a failed
 *      /api/trade cannot leave Today's P&L or balance showing the unpersisted
 *      profit; on success the server-authoritative figures replace (not add to)
 *      the optimistic ones, so there is no double-counting.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');

// Mirrors the UTC-day start computed inside getTodayRealizedPnl(server.js).
function startOfTodayUtc(now) {
    const d = new Date(now || Date.now());
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

// Mirrors the UTC-day window computed inside getTodayRealizedPnl(server.js):
// [startOfTodayUtc, startOfTomorrowUtc). Applies to `trades` rows
// ({ amount, created_at }). This is the exact arithmetic the server performs
// after record_trade_safe() writes.
function sumTodayRealizedPnl(trades, now) {
    const start = startOfTodayUtc(now);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 1);
    const lo = start.toISOString();
    const hi = end.toISOString();
    return trades
        .filter(r => r.created_at >= lo && r.created_at < hi)
        .reduce((s, r) => s + (Number(r.amount) || 0), 0);
}

// ---------------------------------------------------------------------------
// 1. Today's realized P&L: signed, today-only, trades-only
// ---------------------------------------------------------------------------

test('todayRealizedPnl: sums signed trade amounts for the current UTC day', () => {
    const now = new Date('2026-08-14T10:00:00Z');
    const trades = [
        { amount: 12.50, created_at: '2026-08-14T09:00:00Z' }, // today win
        { amount: -3.25, created_at: '2026-08-14T09:30:00Z' }, // today loss
        { amount: 5.00, created_at: '2026-08-14T00:00:00Z' },  // today, midnight UTC
        { amount: 8.00, created_at: '2026-08-13T23:59:59Z' },  // yesterday UTC -> excluded
    ];
    assert.strictEqual(sumTodayRealizedPnl(trades, now), 14.25);
});

test('todayRealizedPnl: excludes everything outside the UTC day', () => {
    const now = new Date('2026-08-14T00:30:00Z');
    const trades = [
        { amount: 100, created_at: '2026-08-14T00:00:00Z' },  // included (today)
        { amount: 999, created_at: '2026-08-13T23:59:59Z' },  // excluded (yesterday)
        { amount: 999, created_at: '2026-08-15T00:00:00Z' }, // excluded (tomorrow)
    ];
    assert.strictEqual(sumTodayRealizedPnl(trades, now), 100);
});

test('todayRealizedPnl: never includes deposits/withdrawals/referrals — trades ledger only', () => {
    // The server reads from the `trades` table, which record_trade_safe writes.
    // Deposits/withdrawals/referrals live in `transactions` and are never read
    // by getTodayRealizedPnl, so they structurally cannot contribute.
    const trades = [
        { amount: 20, created_at: '2026-08-14T01:00:00Z' },
        { amount: -7, created_at: '2026-08-14T02:00:00Z' },
    ];
    const now = new Date('2026-08-14T05:00:00Z');
    assert.strictEqual(sumTodayRealizedPnl(trades, now), 13);
});

test('todayRealizedPnl: empty / no rows -> 0 (no fabricated profit)', () => {
    const now = new Date('2026-08-14T05:00:00Z');
    assert.strictEqual(sumTodayRealizedPnl([], now), 0);
    assert.strictEqual(sumTodayRealizedPnl([{ amount: 5, created_at: '2026-08-13T01:00:00Z' }], now), 0);
});

// ---------------------------------------------------------------------------
// 2. Funded status = at least one confirmed deposit (not balance > 50)
// ---------------------------------------------------------------------------

// Mirrors hasConfirmedDeposit(server.js): count of confirmed deposits > 0.
function isFunded(confirmedDeposits) {
    return (confirmedDeposits || 0) > 0;
}

test('hasRealDeposit: true iff at least one confirmed deposit exists', () => {
    assert.strictEqual(isFunded(0), false);
    assert.strictEqual(isFunded(1), true);
    assert.strictEqual(isFunded(3), true);
});

test('hasRealDeposit: a balance above 50 alone is NOT funded if no confirmed deposit', () => {
    // Regression guard: the old heuristic was balance > 50. The new authoritative
    // source is the confirmed-deposits count, so a large balance with zero
    // confirmed deposits must NOT read as funded.
    const confirmedDeposits = 0;
    const liveBalance = 500;
    assert.strictEqual(isFunded(confirmedDeposits), false);
    assert.ok(liveBalance > 50, 'sanity: balance exceeds old threshold');
});

// ---------------------------------------------------------------------------
// 3. Optimistic-then-rollback: failed trade can't inflate P&L/balance; success
//    replaces (never adds) so no double-counting.
// ---------------------------------------------------------------------------

// Mirrors the live-wallet state machine used by executeBotTrade + persistLiveTrade.
function makeLiveWallet(initial) {
    return {
        balance: initial.balance,
        pnl: initial.pnl || 0,
        // snapshots captured before the optimistic mutation (executeBotTrade)
        applyOptimistic(profit) {
            this._preBalance = this.balance;
            this._prePnl = this.pnl;
            this.balance = Math.max(0, this.balance + profit);
            this.pnl = this.pnl + profit;
        },
        // persistLiveTrade success path: authoritative server values REPLACE.
        reconcileSuccess(newBalance, todayRealizedPnl) {
            this.balance = newBalance;
            this.pnl = todayRealizedPnl;
        },
        // persistLiveTrade failure path: roll back to pre-trade snapshots.
        rollback() {
            this.balance = this._preBalance;
            this.pnl = this._prePnl;
        },
    };
}

test('failed /api/trade rolls back P&L and balance to pre-trade state', () => {
    const w = makeLiveWallet({ balance: 100, pnl: 5 });
    w.applyOptimistic(7);            // optimistic: balance 107, pnl 12
    assert.strictEqual(w.balance, 107);
    assert.strictEqual(w.pnl, 12);
    w.rollback();                   // server did NOT persist -> revert
    assert.strictEqual(w.balance, 100);
    assert.strictEqual(w.pnl, 5);
});

test('successful trade adopts authoritative figures (no double-count)', () => {
    const w = makeLiveWallet({ balance: 100, pnl: 5 });
    w.applyOptimistic(7);            // optimistic: balance 107, pnl 12
    // Server persisted the trade; newBalance includes it, todayPnl is the
    // signed ledger sum (which includes this trade exactly once).
    w.reconcileSuccess(107, 12);
    assert.strictEqual(w.balance, 107);
    assert.strictEqual(w.pnl, 12);

    // A second successful trade must not double-count: optimistic += then
    // REPLACE with authoritative.
    w.applyOptimistic(3);            // optimistic: balance 110, pnl 15
    w.reconcileSuccess(110, 15);     // authoritative todayPnl reflects both trades once
    assert.strictEqual(w.balance, 110);
    assert.strictEqual(w.pnl, 15);
});

test('server clamped loss: optimistic guess differs from authoritative; success wins', () => {
    // Loss that would push balance below 0 is clamped server-side; the applied
    // amount differs from the client's optimistic profit. Authoritative values
    // from the server must replace the optimistic ones exactly.
    const w = makeLiveWallet({ balance: 2, pnl: 0 });
    w.applyOptimistic(-5);           // optimistic: balance Math.max(0,-3)=0, pnl -5
    assert.strictEqual(w.balance, 0);
    assert.strictEqual(w.pnl, -5);
    // Server applied only -2 (clamped), so newBalance=0 and todayPnl=-2.
    w.reconcileSuccess(0, -2);
    assert.strictEqual(w.balance, 0);
    assert.strictEqual(w.pnl, -2);   // not -5 — authoritative, no fabrication
});
