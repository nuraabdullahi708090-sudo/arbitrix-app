'use strict';

/**
 * Migration-level pins for the two release blockers that live in SQL:
 *
 *   H2 - 049 must ASSERT the approved $100 minimum (platform AND referral) and
 *        must never write 50. The superseded 049_min_deposit_50.sql is gone.
 *   M2 - 051 re-creates charge_subscription_safe, a SECURITY DEFINER function
 *        that debits wallets.live_balance. It must pin search_path and confine
 *        EXECUTE to service_role, because migration 014 (the financial RPC
 *        lockdown) never covered it and PostgreSQL's default grant leaves it
 *        callable by anon/authenticated.
 *
 * The behaviour was ALSO executed against a throwaway PostgreSQL 16 instance
 * during the review (see docs/relaunch/H1-H4-RELEASE-BLOCKERS-REPORT.md): before
 * the fix anon=TRUE/authenticated=TRUE/search_path=NONE, after it
 * anon=FALSE/authenticated=FALSE/service_role=TRUE/search_path=public,pg_temp.
 * These assertions keep that state from regressing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const read = (f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');

const M049 = '049_min_deposit_100.sql';
const M051 = '051_rebrand_subscription_detail.sql';

test('H2: the superseded $50 migration is gone', () => {
  assert.ok(fs.existsSync(path.join(MIGRATIONS, M049)), M049 + ' must exist');
  assert.ok(!fs.existsSync(path.join(MIGRATIONS, '049_min_deposit_50.sql')),
    'the 100 -> 50 migration must not exist on the branch');
});

test('H2: 049 targets $100 and never writes 50', () => {
  const sql = read(M049);
  assert.match(sql, /v_target\s+CONSTANT TEXT := '100'/, 'the target value is 100');
  // No INSERT or UPDATE may write the literal 50 as the value.
  assert.ok(!/INSERT INTO public\.referral_config[\s\S]{0,200}'50'/.test(sql), 'no $50 insert');
  assert.ok(!/\bSET\s+%I\s*=\s*'50'/.test(sql), 'no update writes the literal 50');
  // Every remaining '50' is a GUARD or a NOTICE, never a write target.
  const lines = sql.split('\n').filter((l) => l.includes("'50'"));
  assert.ok(lines.length > 0, 'the 50 guard exists');
  for (const line of lines) {
    const isGuard = /trim\(v_value\) = '50'/.test(line);
    const isNotice = /NOTICE/.test(line) || /'-'|50 -> %/.test(line) || /migration did not/.test(line) || /is still 50/.test(line);
    const isComment = /^\s*--/.test(line);
    assert.ok(isGuard || isNotice || isComment, 'a 50 literal is used as a write: ' + line.trim());
  }
});

test('H2: 049 treats a correct 100 as success, not an error', () => {
  const sql = read(M049);
  assert.match(sql, /already % - no change/, 'an existing 100 must be a no-op, not a failure');
  assert.ok(!/RAISE EXCEPTION[^;]*still 100[^;]*;/.test(sql), 'a correct value must never raise');
  assert.match(sql, /operator value/, 'a customised value is preserved, not rewritten');
});

test('H2: 049 is idempotent and self-checking', () => {
  const sql = read(M049);
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /^COMMIT;/m);
  assert.match(sql, /IF v_count <> 1 THEN/, 'exactly one row is asserted');
  assert.match(sql, /below the platform floor/, 'a nonsense value is rejected');
  assert.match(sql, /still 50/, 'a leftover 50 is rejected at the end of the run');
});

test('M2: 051 pins search_path on the SECURITY DEFINER function', () => {
  const sql = read(M051);
  assert.match(sql, /SECURITY DEFINER\s*\nSET search_path = public, pg_temp/, 'search_path must be pinned');
});

test('M2: 051 confines EXECUTE to service_role', () => {
  const sql = read(M051);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.charge_subscription_safe\(BIGINT, DECIMAL, TEXT, TEXT, TEXT\) FROM PUBLIC;/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.charge_subscription_safe\(BIGINT, DECIMAL, TEXT, TEXT, TEXT\) FROM anon;/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.charge_subscription_safe\(BIGINT, DECIMAL, TEXT, TEXT, TEXT\) FROM authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.charge_subscription_safe\(BIGINT, DECIMAL, TEXT, TEXT, TEXT\) TO service_role;/);
});

test('M2: 051 self-checks the privilege state and the search_path it claims', () => {
  const sql = read(M051);
  assert.match(sql, /has_function_privilege\('anon'/, 'anon must be verified, not assumed');
  assert.match(sql, /has_function_privilege\('authenticated'/);
  assert.match(sql, /service_role lost EXECUTE/, 'the server path must keep working');
  assert.match(sql, /does not pin search_path/);
});

test('M2: 051 still changes exactly one customer-visible string and no money logic', () => {
  const sql = read(M051);
  // The detail WRITTEN into transactions is the new brand ...
  assert.match(sql, /detail[\s\S]{0,120}'Kalderix Pro Subscription/);
  // ... and the old string survives only as a self-check guard, never as a write.
  const oldMentions = sql.split('\n').filter((l) => l.includes("'Arbitrix Pro Subscription'"));
  assert.ok(oldMentions.length > 0, 'the self-check names the old string');
  for (const line of oldMentions) {
    assert.ok(/position\(|RAISE EXCEPTION|^\s*--/.test(line),
      'the old detail must only appear in a guard or comment: ' + line.trim());
  }
  // The money guards survive the replace.
  assert.match(sql, /idempotency_key/);
  assert.match(sql, /live_balance </);
});

test('M2: 051 runs in ONE transaction, so a failure cannot half-apply', () => {
  const sql = read(M051).replace(/--[^\n]*/g, '');
  const begin = sql.search(/(^|\n)\s*begin\s*;/i);
  const commit = sql.search(/(^|\n)\s*commit\s*;/i);
  assert.ok(begin >= 0, 'the migration must open a transaction');
  assert.ok(commit > begin, 'the migration must commit after it opens');
  // begin must precede the first statement, commit must follow the last one.
  assert.ok(begin < sql.search(/DO \$pre\$/), 'begin must come before the precondition block');
  assert.ok(commit > sql.search(/END \$check\$;/), 'commit must come after the self-check');
});

test('M2: migration 011 itself never locked the function down (the defect premise)', () => {
  const sql = read('011_subscription_pro.sql');
  assert.ok(!/REVOKE EXECUTE ON FUNCTION public\.charge_subscription_safe/.test(sql),
    'if 011 ever starts revoking it, this finding is stale and the report must be updated');
});

test('M2: the Payhip RPCs added by 050 are already service_role-only', () => {
  const sql = read('050_payhip_live_activation.sql');
  assert.match(sql, /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION %s TO service_role/);
});
