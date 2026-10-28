'use strict';

/**
 * Migration 042: the deposit-credit audit marker.
 *
 * The defect (docs/TELEGRAM_RECOVERY_AUDIT.md, section 17) was that
 * confirm_payment_with_credit() never set payment_invoices.credited, so the
 * migration 040 trigger recorded no deposit_confirmed event and the customer
 * got no Telegram notification, even though the money was credited correctly.
 *
 * These tests pin the SHAPE of the fix:
 *   1. the re-created function differs from migration 021 by exactly one line;
 *   2. that line is the marker, inside the payment_invoices UPDATE;
 *   3. nothing financial, locking, idempotent or referral-related changed;
 *   4. there is no backfill and no second function is touched;
 *   5. grants stay service_role-only.
 *
 * The behavioural counterpart (a real PostgreSQL run proving one event per
 * confirmed invoice and no double credit on replay) was executed against
 * PostgreSQL 16 while authoring the migration; see the audit, section 17.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MIGRATION_021 = path.join(ROOT, 'supabase/migrations/021_provider_referral_award_correctness.sql');
const MIGRATION_042 = path.join(ROOT, 'supabase/migrations/042_confirm_payment_credit_marker.sql');

const SQL_021 = fs.readFileSync(MIGRATION_021, 'utf8');
const SQL_042 = fs.readFileSync(MIGRATION_042, 'utf8');

function extractFunction(sql, name, fromIndex) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(', fromIndex || 0);
  assert.ok(start >= 0, 'function ' + name + ' not found');
  const end = sql.indexOf('$$;', start);
  assert.ok(end > start, 'function ' + name + ' has no closing $$;');
  return sql.slice(start, end + 3);
}

const FN_021 = extractFunction(SQL_021, 'confirm_payment_with_credit');
const FN_042 = extractFunction(SQL_042, 'confirm_payment_with_credit');

test('042 re-creates exactly one function', () => {
  const creates = SQL_042.match(/CREATE OR REPLACE FUNCTION /g) || [];
  assert.equal(creates.length, 1, 'only confirm_payment_with_credit may be re-created');
  const drops = SQL_042.match(/DROP FUNCTION /g) || [];
  assert.equal(drops.length, 0, '042 must not drop anything');
});

test('the body differs from migration 021 by exactly one inserted line', () => {
  const before = FN_021.split('\n');
  const after = FN_042.split('\n');
  assert.equal(after.length, before.length + 1, 'exactly one line was added');

  let i = 0;
  while (i < before.length && before[i] === after[i]) i += 1;
  assert.ok(i > 0 && i < before.length, 'the files are not identical');

  const inserted = after[i];
  assert.equal(inserted.trim(), 'credited = TRUE,', 'the inserted line is the audit marker');

  // Everything after the insertion point must line up again, line for line.
  for (let j = 0; j < before.length - i; j += 1) {
    assert.equal(after[i + 1 + j], before[i + j], 'unexpected divergence at line ' + (i + 1 + j));
  }
});

test('the marker is inside the payment_invoices UPDATE, before the ledger insert', () => {
  const updateAt = FN_042.indexOf('UPDATE payment_invoices');
  const markerAt = FN_042.indexOf('credited = TRUE,', updateAt);
  const ledgerAt = FN_042.indexOf('INSERT INTO transactions', updateAt);
  assert.ok(updateAt > 0, 'the invoice UPDATE is missing');
  assert.ok(markerAt > updateAt, 'the marker is not in the invoice UPDATE');
  assert.ok(ledgerAt > markerAt, 'the marker must be written before the ledger row');

  // It sits in the same statement list as status = 'confirmed'.
  const segment = FN_042.slice(updateAt, ledgerAt);
  assert.match(segment, /SET status = 'confirmed',\s+credited = TRUE,/);
});

test('the marker is assigned exactly once', () => {
  // One assignment statement... (the other textual hit is the migration's own
  // self-check regex, which is asserted separately below).
  const assignments = FN_042.match(/^\s*credited = TRUE,$/gm) || [];
  assert.equal(assignments.length, 1, 'the marker is written exactly once');
  assert.ok(SQL_042.includes("v_src !~ 'status = ''confirmed'',\\s+credited = TRUE,'"),
    'the self-check asserts the marker is present');
});

test('the wallet credit, the ledger row and the return shape are unchanged', () => {
  for (const needle of [
    'live_balance = live_balance + p_amount_usd',
    'INSERT INTO wallets (user_id, live_balance, demo_balance, bonus_balance)',
    "VALUES (p_user_id, 'Deposit', p_amount_usd",
    "'credited', true,",
    "'is_first_deposit', v_is_first_deposit,",
    "'referral_bonus', v_referral_reward"
  ]) {
    assert.ok(FN_021.includes(needle), 'baseline is missing ' + needle);
    assert.ok(FN_042.includes(needle), '042 changed or dropped: ' + needle);
  }
});

test('locking and both idempotency checks are preserved', () => {
  const patterns = [
    [/WHERE id = p_invoice_id AND status = 'pending'\s+FOR UPDATE/, 'invoice row lock'],
    [/WHERE transaction_hash = p_transaction_hash\s+AND status = 'confirmed'/, 'transaction_hash duplicate check'],
    [/FROM wallets\s+WHERE user_id = p_user_id\s+FOR UPDATE/, 'wallet row lock'],
    [/Transaction already processed/, 'duplicate refusal message']
  ];
  for (const [re, label] of patterns) {
    assert.match(FN_021, re, 'baseline is missing: ' + label);
    assert.match(FN_042, re, '042 changed or dropped: ' + label);
  }
  // The marker must never become the idempotency mechanism.
  assert.ok(!/credited\s*=\s*FALSE/.test(FN_042), 'the marker must only ever be set');
});

test('the referral award is still delegated, not re-implemented', () => {
  assert.ok(FN_042.includes('award_referral_qualification_safe(p_user_id, p_amount_usd)'));
  assert.match(FN_042, /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'Referral qualification failed/);
  assert.ok(!/referral_reward_amount/.test(FN_042), 'no retired flat-reward key may reappear');
  assert.ok(!/= 10\b/.test(FN_042), 'no hard-coded reward may reappear');
});

test('the transaction and exception contract is unchanged', () => {
  assert.match(FN_042, /RETURNS JSONB\nLANGUAGE plpgsql\nSECURITY DEFINER/);
  // Both handlers survive: the referral guard (warn + continue) and the
  // function-level handler that turns an error into a JSON result.
  assert.match(FN_042, /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'Referral qualification failed/);
  assert.match(FN_042, /EXCEPTION\s+WHEN OTHERS THEN\s+RETURN jsonb_build_object\('success', false/);
  assert.ok(FN_042.includes("RETURN jsonb_build_object('success', false, 'error', SQLERRM)"));
  assert.ok(!/COMMIT|ROLLBACK/.test(FN_042), 'the function must not manage transactions itself');
});

test('042 does not backfill or emit historical notifications', () => {
  // Everything OUTSIDE the re-created function: the migration wrapper.
  const outside = SQL_042.split(FN_042).join('\n')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert.ok(!/UPDATE\s+public\.payment_invoices/i.test(outside), 'no invoice backfill');
  assert.ok(!/conversion_events/i.test(outside), 'no event insertion');
  assert.ok(!/conversion_record_event|conversion_backfill_missing/.test(outside), 'no conversion helper calls');
  assert.ok(!/INSERT\s+INTO/i.test(outside), 'no data writes outside the function body');
  assert.ok(!/ALTER\s+TABLE/i.test(outside), 'no schema change');
  assert.ok(!/UPDATE\s+public\.(deposits|wallets|transactions|referrals)/i.test(outside), 'no other data writes');
});

test('the legacy deposits table is untouched', () => {
  assert.ok(!/FROM\s+deposits|UPDATE\s+deposits|INTO\s+deposits/i.test(FN_042));
  // Its own marker is set by migration 041, which stays as it is.
  const m041 = fs.readFileSync(path.join(ROOT, 'supabase/migrations/041_legacy_deposit_atomic_credit.sql'), 'utf8');
  assert.match(m041, /UPDATE public\.deposits\s+SET status = 'confirmed',\s+credited = TRUE/);
});

test('grants stay service_role-only', () => {
  assert.ok(SQL_042.includes('REVOKE ALL ON FUNCTION public.confirm_payment_with_credit(BIGINT, BIGINT, DECIMAL, TEXT) FROM PUBLIC'));
  assert.match(SQL_042, /to_regrole\('anon'\)[\s\S]*?FROM anon/);
  assert.match(SQL_042, /to_regrole\('authenticated'\)[\s\S]*?FROM authenticated/);
  assert.ok(SQL_042.includes('GRANT EXECUTE ON FUNCTION public.confirm_payment_with_credit(BIGINT, BIGINT, DECIMAL, TEXT) TO service_role'));
});

test('042 refuses to run without migration 021 (no silent reward upgrade)', () => {
  assert.ok(SQL_042.includes("to_regprocedure('public.award_referral_qualification_safe(bigint, numeric)') IS NULL"));
  assert.ok(SQL_042.includes('migration 042 requires migration 021'));
  assert.ok(SQL_042.includes("column_name = 'credited'"), 'the marker column is a precondition');
});

test('the migration verifies its own result', () => {
  assert.ok(SQL_042.includes('042 self-check: the credited marker is not set in the invoice UPDATE'));
  assert.ok(SQL_042.includes('042 self-check: the row-lock idempotency guard changed'));
  assert.ok(SQL_042.includes('042 self-check: SECURITY DEFINER was lost'));
  assert.ok(SQL_042.includes('RAISE NOTICE'), 'a success notice is expected');
});

test('the application path that calls it is unchanged', () => {
  const paymentService = fs.readFileSync(path.join(ROOT, 'services/PaymentService.js'), 'utf8');
  assert.ok(paymentService.includes("confirm_payment_with_credit"),
    'PaymentService still calls the same RPC');
  assert.ok(!/confirm_payment_with_credit_v2|credit_marker/.test(paymentService));
});
