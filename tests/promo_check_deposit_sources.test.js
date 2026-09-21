'use strict';

/**
 * PromoCheck.hasConfirmedDeposit() — deposit-source parity with server.js and
 * migration 026.
 *
 * CONTRACT (unchanged, now matched by the worker):
 *   hasConfirmedDeposit = a confirmed row in public.deposits
 *                      OR  a confirmed row in public.payment_invoices
 *
 * WHY: the worker's classifier (services/PromoCheck.js) previously read ONLY
 * `public.deposits`, so a provider-credited user (confirmed `payment_invoices`,
 * no legacy `deposits` row - e.g. user 68 with 2 x $50) was misclassified as
 * promotional-credit funded and could be stopped with `stopped_reason='promo_cap'`
 * once their realized Live profit reached $20. server.js hasConfirmedDeposit()
 * and migration 026 already OR the two tables; this file pins that the worker
 * does too.
 *
 * BOUNDARIES ASSERTED (management brief):
 *   - the $20 promo profit cap is unchanged;
 *   - the $100 qualifying-deposit / referral rule is unchanged;
 *   - transactions.type='Deposit' is NOT an eligibility source;
 *   - no deposit/payment records are written (read-only gate).
 *
 * These tests EXECUTE the real createPromoCheck() against a minimal fake
 * Supabase client (no network, no express import needed).
 *
 * Run: npm test (or: node --test tests/promo_check_deposit_sources.test.js)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  PROMO_PROFIT_CAP_USD,
  isPromoProfitCapReached,
  createPromoCheck,
} = require('../services/PromoCheck');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PROMO_CHECK = read('services/PromoCheck.js');
const SERVER = read('server.js');
const MIGRATION_026 = read('supabase/migrations/026_promo_trading_cap.sql');

// ---------------------------------------------------------------------------
// Minimal fake Supabase client for the exact chains PromoCheck uses.
// ---------------------------------------------------------------------------
function makeAdmin(cfg = {}) {
  const {
    deposits = 0,               // confirmed count in public.deposits
    invoices = 0,               // confirmed count in public.payment_invoices
    env = 'PRODUCTION',
    ledgerRows = [],            // [] => no referral conversion (readable)
    ledgerError = null,
    ledgerThrows = false,
    bonusWithdrawalCount = 0,   // fallback 'Bonus Withdrawal' marker count
    txError = null,
    txThrows = false,
    depositError = null,
    invoiceError = null,
    depositThrows = false,
    invoiceThrows = false,
  } = cfg;

  const seen = [];

  function countChain(table, count, error, throws) {
    const chain = {
      select() { return chain; },
      eq() { return chain; },
      then(resolve, reject) {
        seen.push({ kind: 'count', table });
        if (throws) { reject(new Error(table + ' query exploded')); return; }
        resolve(error ? { count: null, error } : { count, error: null });
      },
    };
    return chain;
  }

  return {
    seen,
    from(table) {
      if (table === 'deposits') return countChain(table, deposits, depositError, depositThrows);
      if (table === 'payment_invoices') return countChain(table, invoices, invoiceError, invoiceThrows);
      if (table === 'users') {
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          single() { seen.push({ kind: 'env', table }); return Promise.resolve({ data: { environment: env }, error: null }); },
        };
        return chain;
      }
      if (table === 'referral_earning_conversions') {
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          limit() {
            seen.push({ kind: 'ledger', table });
            if (ledgerThrows) return Promise.reject(new Error('ledger exploded'));
            return Promise.resolve(ledgerError ? { data: null, error: ledgerError } : { data: ledgerRows, error: null });
          },
        };
        return chain;
      }
      if (table === 'transactions') {
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          then(resolve, reject) {
            seen.push({ kind: 'tx', table });
            if (txThrows) { reject(new Error('transactions query exploded')); return; }
            resolve(txError ? { count: null, error: txError } : { count: bonusWithdrawalCount, error: null });
          },
        };
        return chain;
      }
      throw new Error('unexpected table read by PromoCheck: ' + table);
    },
  };
}

const promoWith = (cfg) => createPromoCheck({ admin: makeAdmin(cfg), log: () => {} });

// ---------------------------------------------------------------------------
// 1. BEHAVIOR — the four required cases
// ---------------------------------------------------------------------------
test('confirmed legacy deposit (deposits) -> funded, never promo-funded', async () => {
  const admin = makeAdmin({ deposits: 1, invoices: 0 });
  const promo = createPromoCheck({ admin, log: () => {} });
  assert.equal(await promo.hasConfirmedDeposit(1), true);
  assert.equal(await promo.isPromoCreditFunded(1, await promo.hasConfirmedDeposit(1)), false);
  // BOTH sources are consulted (a 0 in one must not short-circuit the other).
  const tables = admin.seen.filter((s) => s.kind === 'count').map((s) => s.table);
  assert.ok(tables.includes('deposits') && tables.includes('payment_invoices'));
});

test('confirmed provider invoice (payment_invoices only) -> funded, never promo-funded', async () => {
  const admin = makeAdmin({ deposits: 0, invoices: 1 });
  const promo = createPromoCheck({ admin, log: () => {} });
  assert.equal(await promo.hasConfirmedDeposit(1), true);
  assert.equal(await promo.isPromoCreditFunded(1, await promo.hasConfirmedDeposit(1)), false);
});

test('user 68 scenario: 2 confirmed payment_invoices, empty deposits -> funded', async () => {
  const promo = promoWith({ deposits: 0, invoices: 2 });
  assert.equal(await promo.hasConfirmedDeposit(68), true, 'provider flow is a deposit');
  assert.equal(await promo.isPromoCreditFunded(68, await promo.hasConfirmedDeposit(68)), false, 'not promo-funded');
});

test('both sources confirmed -> funded (boolean OR, no double-count concern)', async () => {
  const promo = promoWith({ deposits: 3, invoices: 5 });
  assert.equal(await promo.hasConfirmedDeposit(1), true);
});

test('neither source confirmed -> not a depositor -> promo-funded', async () => {
  // No deposit anywhere, no referral conversion -> the non-deposited Live
  // capital IS the $50 promotional credit.
  const promo = promoWith({ deposits: 0, invoices: 0, ledgerRows: [] });
  assert.equal(await promo.hasConfirmedDeposit(1), false);
  assert.equal(await promo.isPromoCreditFunded(1, false), true);
});

test('referral-funded user (no deposit, converted earnings) -> exempt from promo classification', async () => {
  const promo = promoWith({ deposits: 0, invoices: 0, ledgerRows: [{ id: 1 }] });
  assert.equal(await promo.isPromoCreditFunded(1, false), false);
});

test('MARKETING_SANDBOX -> exempt from promo classification regardless of deposits', async () => {
  const promo = promoWith({ deposits: 0, invoices: 0, env: 'MARKETING_SANDBOX' });
  assert.equal(await promo.isPromoCreditFunded(1, false), false);
});

// ---------------------------------------------------------------------------
// 2. UNKNOWN / ERROR — existing fail-open behavior preserved
// ---------------------------------------------------------------------------
test('a throwing deposits query -> hasConfirmedDeposit false (never throws)', async () => {
  const promo = promoWith({ depositThrows: true, invoices: 1 });
  assert.equal(await promo.hasConfirmedDeposit(1), false);
});

test('a throwing payment_invoices query -> hasConfirmedDeposit false (never throws)', async () => {
  const promo = promoWith({ invoiceThrows: true, deposits: 1 });
  assert.equal(await promo.hasConfirmedDeposit(1), false);
});

test('an error result from either query -> hasConfirmedDeposit false (fail-closed, matching server.js)', async () => {
  assert.equal(await promoWith({ depositError: { message: 'down' }, invoices: 1 }).hasConfirmedDeposit(1), false);
  assert.equal(await promoWith({ invoiceError: { message: 'down' }, deposits: 1 }).hasConfirmedDeposit(1), false);
});

test('unreadable conversion state -> isPromoCreditFunded null (fail-open, unchanged)', async () => {
  // Both the ledger AND the transactions fallback fail -> unknown, never capped.
  const promo = promoWith({ deposits: 0, invoices: 0, ledgerError: { message: 'down' }, txError: { message: 'down' } });
  assert.equal(await promo.hasConvertedReferralEarnings(1), null);
  assert.equal(await promo.isPromoCreditFunded(1, false), null);
});

// ---------------------------------------------------------------------------
// 3. $20 CAP — unchanged
// ---------------------------------------------------------------------------
test('the $20 promo profit cap is unchanged (inclusive, deposited users never capped)', () => {
  assert.equal(PROMO_PROFIT_CAP_USD, 20);
  assert.equal(isPromoProfitCapReached(false, 1000), false, 'non-promo users are never capped');
  assert.equal(isPromoProfitCapReached(true, 19.99), false);
  assert.equal(isPromoProfitCapReached(true, 20), true, 'exactly $20 blocks');
  assert.match(PROMO_CHECK, /const PROMO_PROFIT_CAP_USD = 20;/);
  assert.match(PROMO_CHECK, /Number\(promoProfit\) >= PROMO_PROFIT_CAP_USD/);
});

// ---------------------------------------------------------------------------
// 4. SOURCE CONTRACT — matches server.js + migration 026, read-only, no ledger
// ---------------------------------------------------------------------------
test('PromoCheck.hasConfirmedDeposit reads BOTH tables with status=confirmed, mirroring server.js', () => {
  const start = PROMO_CHECK.indexOf('async function hasConfirmedDeposit(');
  const end = PROMO_CHECK.indexOf('\n  /**', start + 1);
  const body = PROMO_CHECK.slice(start, end < 0 ? undefined : end);
  assert.ok(body.includes("from('deposits')"), 'legacy deposits query present');
  assert.ok(body.includes("from('payment_invoices')"), 'provider payment_invoices query present');
  assert.ok((body.match(/\.eq\('status', 'confirmed'\)/g) || []).length === 2, 'exactly two confirmed filters');
  assert.ok(body.includes('Promise.all(['), 'parallel head-count reads');
  assert.ok(body.includes('count:'), 'uses head counts, reads no row data');
});

test('PromoCheck and server.js agree on the two sources', () => {
  assert.ok(SERVER.includes("from('deposits')") && SERVER.includes("from('payment_invoices')"));
  assert.ok(PROMO_CHECK.includes("from('payment_invoices')"), 'worker must match the server contract');
});

test('migration 026 still exempts a confirmed deposit from either table', () => {
  assert.ok(MIGRATION_026.includes('FROM public.deposits'), 'legacy deposits exempt');
  assert.ok(MIGRATION_026.includes('FROM public.payment_invoices'), 'provider invoices exempt');
});

test("transactions.type='Deposit' is NOT an eligibility source in PromoCheck", () => {
  // The classifier may read `transactions` ONLY for the 'Bonus Withdrawal'
  // conversion marker - never 'Deposit'.
  assert.ok(!/'Deposit'/.test(PROMO_CHECK), "PromoCheck must not reference a 'Deposit' transaction type");
  assert.ok(PROMO_CHECK.includes("'Bonus Withdrawal'"), 'the only transactions read is the conversion marker');
});

test('hasConfirmedDeposit is read-only (writes nothing)', () => {
  const start = PROMO_CHECK.indexOf('async function hasConfirmedDeposit(');
  const end = PROMO_CHECK.indexOf('\n  /**', start + 1);
  const body = PROMO_CHECK.slice(start, end < 0 ? undefined : end);
  for (const op of ['.update(', '.insert(', '.upsert(', '.delete(', '.rpc(']) {
    assert.ok(!body.includes(op), 'no ' + op + ' in the gate');
  }
});

// ---------------------------------------------------------------------------
// 5. The $100 qualifying-deposit / referral rule is unchanged
// ---------------------------------------------------------------------------
test('the $100 platform minimum qualifying deposit is unchanged', () => {
  assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 100;/);
  assert.match(SERVER, /minimum_qualifying_deposit/);
});
