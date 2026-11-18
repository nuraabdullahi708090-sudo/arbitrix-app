'use strict';

/**
 * Migration 053 - EXECUTE lockdown for the remaining financial-adjacent RPCs.
 *
 * Behaviour was rehearsed on PostgreSQL 16.16 (see
 * docs/security/FINAL-SECURITY-CLOSURE-REPORT.md section 3):
 *   before - `set role anon; select paymento_check_duplicate_webhook(null, 4242)`
 *            returned another customer's user_id, amount, settlement address and
 *            tx hash;
 *   after  - "permission denied for function paymento_check_duplicate_webhook",
 *            while service_role kept working and no body changed.
 *
 * Fourteen relevant migrations ran inside one clean transaction and the
 * double-run/absent-function paths are pinned here too.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION = path.join(ROOT, 'supabase/migrations/053_financial_rpc_privilege_lockdown.sql');
const SANDBOX = path.join(ROOT, 'supabase/migrations/013_marketing_sandbox.sql');
const SERVER = path.join(ROOT, 'server.js');

const read = (p) => fs.readFileSync(p, 'utf8');
/** Strip SQL line comments and string literals so assertions see code only. */
const code = (sql) =>
  sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').replace(/'(?:[^']|'')*'/g, "''");

const TARGETS = [
  'public.mark_expired_invoices()',
  'public.paymento_check_duplicate_webhook(text,bigint)',
  'public.sandbox_ensure_wallet(bigint)',
  'public.sandbox_set_balance(bigint,numeric)',
  'public.sandbox_credit_deposit(bigint,text)',
  'public.sandbox_record_trade(bigint,numeric,text,text,text)',
  'public.sandbox_charge_subscription(bigint,numeric,text,text,text)',
  'public.sandbox_request_withdrawal(bigint,numeric,text)',
  'public.sandbox_set_withdrawal_status(bigint,bigint,text)',
  'public.sandbox_reset_account(bigint)'
];

test('migration 053 exists, is transactional and lists every target exactly once', () => {
  assert.ok(fs.existsSync(MIGRATION), '053 must exist');
  const sql = read(MIGRATION);
  assert.match(sql, /^\s*begin;/im);
  assert.match(sql, /^\s*commit;/im);
  // Count inside the INSERT block only: the preconditions and the abort
  // messages quote the same signatures on purpose.
  const start = sql.indexOf('insert into _m53_targets');
  const end = sql.indexOf('create temporary table _m53_before');
  assert.ok(start > 0 && end > start, 'the target list must precede the snapshot');
  const list = sql.slice(start, end);
  for (const sig of TARGETS) {
    const hits = list.split(`'${sig}'`).length - 1;
    assert.strictEqual(hits, 1, `${sig} must appear exactly once in the target list (found ${hits})`);
  }
});

test('053 never recreates a function body', () => {
  const sql = code(read(MIGRATION));
  assert.ok(!/create\s+(or\s+replace\s+)?function/i.test(sql),
    'privileges only - a body change would be an unrehearsed behaviour change');
  assert.ok(!/\bdrop\s+function\b/i.test(sql), 'never drop');
});

test('053 revokes PUBLIC/anon/authenticated and grants only service_role, for every target', () => {
  const sql = read(MIGRATION);
  // The statements are dynamic (one loop), so assert the loop body shape.
  assert.match(sql, /revoke all on function %s from public/);
  assert.match(sql, /revoke all on function %s from anon/);
  assert.match(sql, /revoke all on function %s from authenticated/);
  assert.match(sql, /grant execute on function %s to service_role/);
  // ... and that it iterates the target table, not a hand-built list.
  assert.match(sql, /for t in select sig from _m53_targets order by sig loop/);
});

test('053 pins search_path with ALTER, not by redefining', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /alter function %s set search_path = public, pg_temp/);
});

test('053 touches no table, row or policy', () => {
  const sql = code(read(MIGRATION)).replace(/create\s+temporary\s+table[\s\S]*?;/gi, '');
  for (const word of ['insert into public', 'update public', 'delete from', 'truncate', 'create table', 'alter table', 'drop table', 'create policy', 'alter policy']) {
    assert.ok(!sql.toLowerCase().includes(word), 'must not contain: ' + word);
  }
  // The only INSERT allowed is into the temporary target list.
  const inserts = [...sql.matchAll(/^\s*insert\s+into\s+(\S+)/gim)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(inserts)], ['_m53_targets'],
    'the only write is the temporary target list');
});

test('053 aborts safely when the payment migrations are absent', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /053 ABORTED: public\.mark_expired_invoices\(\) does not exist/);
  assert.match(sql, /053 ABORTED: public\.paymento_check_duplicate_webhook\(text,bigint\) does not exist/);
  assert.match(sql, /Nothing was changed/);
});

test('053 skips absent sandbox functions instead of failing the migration', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /053 SKIP: % does not exist \(migration not applied\) - nothing to lock/);
  assert.match(sql, /053: locked % function\(s\), skipped %/);
  assert.match(sql, /if v_oid is null then/, 'the skip branch must precede the ACL statements');
});

test('053 verifies its own outcome and that nothing else changed', () => {
  const sql = read(MIGRATION);
  for (const check of [
    '053 FAILED: anon can still EXECUTE',
    '053 FAILED: authenticated can still EXECUTE',
    '053 FAILED: service_role lost EXECUTE on',
    '053 FAILED: PUBLIC still holds an explicit EXECUTE grant on',
    '053 FAILED: search_path is not pinned on',
    '053 FAILED: the body of % changed',
    '053 FAILED: the signature or security mode of % changed',
    '053 FAILED: % function(s) outside the target list changed privileges',
    '053 OK:'
  ]) {
    assert.ok(sql.includes(check), 'missing postcondition: ' + check);
  }
});

test('053 does not touch the real-money RPCs that 014/051/052 already locked', () => {
  const sql = read(MIGRATION);
  for (const fn of ['record_trade_safe', 'credit_payment_safe', 'paymento_credit_user_safe',
    'charge_subscription_safe', 'confirm_payment_with_credit', 'confirm_legacy_deposit_safe',
    'award_referral_qualification_safe', 'convert_referral_earnings_safe',
    'request_referral_payout_safe', 'update_referral_payout_safe',
    'record_payhip_purchase_safe', 'redeem_payhip_entitlement_safe']) {
    const body = sql.split('_m53_targets').slice(1).join('_m53_targets');
    // The migration may mention them in comments; the executable target list must not.
    const list = sql.slice(sql.indexOf('insert into _m53_targets'), sql.indexOf('create temporary table _m53_before'));
    assert.ok(!list.includes(fn), `${fn} is already locked and must not be re-targeted`);
  }
});

test('every sandbox money function is guarded by assert_sandbox_user', () => {
  const sql = read(SANDBOX);
  const blocks = sql.split(/(?=CREATE OR REPLACE FUNCTION)/);
  const guarded = {};
  for (const b of blocks) {
    const m = b.match(/CREATE OR REPLACE FUNCTION public\.(sandbox_[a-z0-9_]+)\s*\(/i);
    if (!m) continue;
    guarded[m[1]] = /assert_sandbox_user/.test(b);
  }
  const financial = ['sandbox_ensure_wallet', 'sandbox_set_balance', 'sandbox_credit_deposit',
    'sandbox_record_trade', 'sandbox_charge_subscription', 'sandbox_request_withdrawal',
    'sandbox_set_withdrawal_status', 'sandbox_reset_account'];
  for (const fn of financial) {
    assert.strictEqual(guarded[fn], true, `${fn} must call assert_sandbox_user (production users must be rejected)`);
  }
});

test('the application drives sandbox money only through the service-role client', () => {
  const server = read(SERVER);
  const calls = [...server.matchAll(/(\w+)\s*\.\s*rpc\(\s*'sandbox_/g)].map((m) => m[1]);
  assert.ok(calls.length >= 5, 'the sandbox routes must go through an RPC');
  assert.deepStrictEqual([...new Set(calls)], ['supabaseAdmin'],
    'never the anon client - which is why locking these to service_role is safe');
});

test('the locked payment functions have no application caller to break', () => {
  for (const rel of ['server.js', 'worker.js', 'conversion-worker.js', 'marketing-worker.js']) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    for (const fn of ['paymento_check_duplicate_webhook', 'mark_expired_invoices']) {
      assert.ok(!src.includes(fn), `${rel} must not call ${fn} (it is locked to service_role and unused)`);
    }
  }
});
