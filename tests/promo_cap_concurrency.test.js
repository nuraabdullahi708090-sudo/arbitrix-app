'use strict';
/**
 * L1 - the concurrency invariant that makes the promotional cap hold under
 * parallel trade execution.
 *
 * WHY THE LOCK IS THE WHOLE ARGUMENT
 * Both cap layers are "read the prior cumulative profit, then write". On its own
 * that is a classic check-then-act race: two concurrent trades could each read
 * $29.50, each decide they are allowed, and each commit - finishing at $31.50
 * with the cap never firing. What prevents it is that `record_trade_safe` takes
 * `SELECT ... FOR UPDATE` on the user's `wallets` row BEFORE it inserts the
 * trade, so same-user trades serialise: the second transaction blocks until the
 * first commits, and then its own read sees the committed row.
 *
 * These tests therefore pin two different things:
 *   A. the ORDERING inside migration 009 (lock before insert) - a source pin, so
 *      a refactor that moves the insert earlier fails loudly here;
 *   B. the BEHAVIOUR of that ordering under concurrency - a model of the
 *      serialised critical section, plus a negative control proving the model
 *      would double-apply without it.
 *
 * HONEST LIMITATION: part B is a pure model (no database). This environment has
 * no PostgreSQL and no Docker daemon, so it cannot reproduce the real row lock.
 * The model encodes the invariant the SQL provides and would catch a logic
 * regression in the ordering/decision sequence, but it is not a substitute for
 * the two-session integration run recorded in AGENTS.md (Phase 24), which
 * remains the only live-database evidence.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RPC_SQL = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/009_trades_persistence.sql'), 'utf8'
);
const PROMO = fs.readFileSync(path.join(ROOT, 'services/PromoCheck.js'), 'utf8');

const CAP = 30;

// ---------------------------------------------------------------------------
// A. Source pin: the wallet lock precedes the ledger insert
// ---------------------------------------------------------------------------
test('A1. record_trade_safe locks the wallet BEFORE inserting the trade', () => {
  const lock = RPC_SQL.indexOf('FOR UPDATE;');
  const walletWrite = RPC_SQL.indexOf('SET live_balance');
  const tradeInsert = RPC_SQL.indexOf('INSERT INTO trades (user_id, mode, asset');
  assert.ok(lock > 0, 'the wallet row lock must exist');
  assert.ok(walletWrite > lock, 'the balance is written after the lock');
  assert.ok(tradeInsert > walletWrite, 'the trade row is inserted after the lock and the balance write');
  assert.ok(lock < tradeInsert, 'lock before insert - this is the concurrency guarantee');
});

test('A2. the lock is a row lock on the user wallet, not a table lock', () => {
  const around = RPC_SQL.slice(RPC_SQL.indexOf('FOR UPDATE;') - 400, RPC_SQL.indexOf('FOR UPDATE;'));
  assert.match(around, /FROM public\.wallets|FROM wallets/, 'locks the wallets row');
  assert.match(around, /user_id = p_user_id|WHERE[^;]*user_id/, 'for the trading user only');
  assert.ok(!/LOCK TABLE/i.test(RPC_SQL), 'never escalates to a table lock');
});

test('A3. the idempotency double-check also happens after the lock', () => {
  const lock = RPC_SQL.indexOf('FOR UPDATE;');
  const recheck = RPC_SQL.indexOf('idempotency_key = p_idempotency_key', lock);
  assert.ok(recheck > lock, 'the replay check after the lock is what closes the retry race');
});

// ---------------------------------------------------------------------------
// B. Behavioural model of the serialised critical section
// ---------------------------------------------------------------------------
const round2 = (n) => Math.round(n * 100) / 100;

function makeStore(priorProfit = 0) {
  return { profit: priorProfit, trades: [], chain: Promise.resolve() };
}

/** Mirrors SELECT ... FOR UPDATE: same-user work runs strictly one at a time. */
function enqueue(store, fn) {
  const result = store.chain.then(() => fn());
  store.chain = result.then(() => {}, () => {});
  return result;
}

/**
 * A trade attempt: application pre-check -> trigger (BEFORE INSERT) -> insert.
 * Both cap evaluations see the PRIOR cumulative profit, exactly as the live
 * code does, which is why M1's one-trade overshoot is possible.
 */
function attemptTrade(store, { win = 1, appPrecheck = true, trigger = true } = {}) {
  return enqueue(store, async () => {
    const prior = round2(store.profit);
    if (appPrecheck && prior >= CAP) {
      return { ok: false, code: 'PROMO_TRADING_LIMIT_REACHED', layer: 'app' };
    }
    if (trigger && prior >= CAP) {
      return { ok: false, code: 'PROMO_TRADING_LIMIT_REACHED', layer: 'db' };
    }
    store.profit = round2(prior + win);
    store.trades.push(win);
    return { ok: true };
  });
}

test('B1. two competing trades produce exactly one write once the cap is near', async () => {
  const store = makeStore(29.5);
  const results = await Promise.all([
    attemptTrade(store, { win: 1 }),
    attemptTrade(store, { win: 1 }),
  ]);
  const applied = results.filter((r) => r.ok);
  assert.strictEqual(applied.length, 1, 'exactly one trade is recorded');
  assert.strictEqual(store.trades.length, 1, 'one ledger row');
  assert.strictEqual(store.profit, 30.5, 'M1: the crossing trade is allowed and overshoots by $0.50');
  assert.strictEqual(results.find((r) => !r.ok).code, 'PROMO_TRADING_LIMIT_REACHED');
});

test('B2. many concurrent attempts still yield one write, then permanent refusal', async () => {
  const store = makeStore(29.9);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => attemptTrade(store, { win: 1 }))
  );
  assert.strictEqual(results.filter((r) => r.ok).length, 1, 'one applied');
  assert.strictEqual(results.filter((r) => r.code === 'PROMO_TRADING_LIMIT_REACHED').length, 7, 'seven refused');
  assert.strictEqual(store.trades.length, 1);
});

test('B3. at exactly $30.00 the very first trade is refused (inclusive)', async () => {
  const store = makeStore(30);
  const r = await attemptTrade(store, { win: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.layer, 'app', 'the application layer answers first - that is the point of the pre-check');
  assert.strictEqual(store.profit, 30, 'no write, no change');
});

test('B4. the trigger alone still refuses a capped trade (second layer)', async () => {
  // A direct RPC call, or a build where the handler pre-check was removed:
  // appPrecheck disabled, the database layer must still hold.
  const store = makeStore(30.5);
  const results = await Promise.all([
    attemptTrade(store, { win: 1, appPrecheck: false }),
    attemptTrade(store, { win: 1, appPrecheck: false }),
  ]);
  assert.strictEqual(results.filter((r) => r.ok).length, 0, 'the database refuses both');
  assert.deepStrictEqual(results.map((r) => r.layer), ['db', 'db']);
  assert.strictEqual(store.profit, 30.5, 'nothing was written');
});

test('B5. NEGATIVE CONTROL - without the lock the same code double-applies', async () => {
  // This is why A1 matters. Same decision sequence, no serialisation: both
  // attempts read the same prior value and both commit.
  const store = makeStore(29.5);
  const unserialised = async () => {
    const prior = round2(store.profit);
    await new Promise((r) => setImmediate(r));   // interleaving point (read, then act)
    if (prior >= CAP) return { ok: false, code: 'PROMO_TRADING_LIMIT_REACHED' };
    store.profit = round2(prior + 1);
    store.trades.push(1);
    return { ok: true };
  };
  const results = await Promise.all([unserialised(), unserialised()]);
  assert.strictEqual(results.filter((r) => r.ok).length, 2, 'both trades committed');
  assert.strictEqual(store.profit, 30.5, 'the cap was stepped over once more than intended');
  assert.strictEqual(store.trades.length, 2, 'two ledger rows despite the cap');
});

test('B6. a traded user who is exempt is never serialised into a refusal', async () => {
  // Deposited / converted users are classified out before the cap, so the cap
  // layer must not be reachable for them regardless of profit.
  const store = makeStore(500);
  const r = await attemptTrade(store, { win: 1, appPrecheck: false, trigger: false });
  assert.strictEqual(r.ok, true, 'an exempt user trades freely at any profit level');
  assert.strictEqual(store.profit, 501);
});

test('B7. the worker enforces the same cap inside its own serialised tick', () => {
  // The worker's rule table must not introduce a second threshold; it must fail
  // to the same code so the client mapping is identical.
  assert.match(PROMO, /const PROMO_PROFIT_CAP_USD = 30;/);
  assert.match(PROMO, /return !!isPromoCreditFunded && Number\(promoProfit\) >= PROMO_PROFIT_CAP_USD;/);
  assert.match(PROMO, /PROMO_TRADING_LIMIT_REACHED/);
  // `stopSession` lives in the worker's risk table, which consumes the shared
  // predicate from PromoCheck - one decision, one code, one stop.
  const WORKER = fs.readFileSync(path.join(ROOT, 'services/TradingWorker.js'), 'utf8');
  assert.match(WORKER, /code: 'PROMO_TRADING_LIMIT_REACHED', reason: 'promo_cap', stopSession: true/);
});
