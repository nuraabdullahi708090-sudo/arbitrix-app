'use strict';

/**
 * Phase 6B - grandfathering for pre-launch funded customers (migration 054).
 *
 * The mechanism must be reviewable without touching production:
 *   - a complimentary grant is an ENTITLEMENT with an explicit source, never a
 *     fake payhip_purchases row (no revenue, no 'paid' record, no licence key)
 *   - eligibility is the resolver's own deposit rule (GREATEST of legacy
 *     deposits and provider invoices >= 100), never live_balance, never
 *     trading history, never account age
 *   - the eligible set is FROZEN into a table at cutover, so a later deposit
 *     cannot join it, and one grant per account is enforced by a partial
 *     unique index plus ON CONFLICT DO NOTHING
 *   - a Payhip refund cannot revoke a grant; ending one needs the dedicated
 *     admin function
 *
 * These tests pin the SQL contract, the resolver wiring and the operator
 * script's safety rules. The behavioural half was executed against a real
 * PostgreSQL (see the PR description); nothing here connects to a database.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MIGRATION = read('supabase/migrations/054_grandfather_activation.sql');
// SQL with `--` comments removed, so prose in the header cannot satisfy a
// regex that is meant to look at the executable body.
const stripComments = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const MIGRATION_SQL = stripComments(MIGRATION);
const M050 = read('supabase/migrations/050_payhip_live_activation.sql');
const ENTITLEMENTS = read('services/PayhipEntitlements.js');
const ACTIVATION = read('services/PayhipActivation.js');
const WORKER = read('services/TradingWorker.js');
const SCRIPT = read('scripts/grandfather-activation.js');

const mod = require('../scripts/grandfather-activation.js');

// ------------------------------------------------------------------ schema

// The footer marker. The header carries a DIFFERENT sentence that also starts
// with "-- ROLLBACK" ("-- ROLLBACK (see the end of the file): ..."), so a bare
// split on '-- ROLLBACK' truncates the slice at line ~46 and the destructive
// statement assertions below then pass vacuously. Split on the footer form only.
const ROLLBACK_SPLIT = '\n-- ROLLBACK (in this order';

test('054 is an additive, transactional migration', () => {
  assert.match(MIGRATION, /^-- 054_grandfather_activation\.sql/m);
  assert.match(MIGRATION, /\nBEGIN;/);
  assert.match(MIGRATION, /\nCOMMIT;/);

  const body = MIGRATION.split(ROLLBACK_SPLIT)[0];

  // Prove the slice really IS the executable body. Without this the negative
  // assertions below would pass against a truncated stub - the original defect.
  assert.ok(body.split('\n').length > 400,
    'body slice looks truncated: ' + body.split('\n').length + ' lines');
  assert.match(body, /\nBEGIN;/);
  assert.match(body, /CREATE TABLE IF NOT EXISTS public\.activation_grandfather_snapshots/);
  assert.match(body, /CREATE OR REPLACE FUNCTION public\.revoke_grandfathered_entitlement_safe/);
  assert.doesNotMatch(body, /DROP FUNCTION IF EXISTS/i);

  // Additive only: no table or column is removed in the executable body.
  assert.doesNotMatch(body, /DROP TABLE/i);
  assert.doesNotMatch(body, /DROP COLUMN/i);
});

test('the rollback delimiter matches the footer only, never the header', () => {
  // Exactly one footer marker.
  assert.strictEqual(MIGRATION.split(ROLLBACK_SPLIT).length, 2);
  // The header's different sentence must not be a split point.
  assert.match(MIGRATION, /-- ROLLBACK \(see the end of the file\)/);
  const headerSpan = MIGRATION.split('\n-- ROLLBACK (see the end')[0];
  assert.ok(!headerSpan.includes('COMMIT;'), 'the header mention must precede COMMIT;');
  // The destructive clean-up lives in the rollback block and must stay outside
  // the body slice.
  const rollback = MIGRATION.split(ROLLBACK_SPLIT)[1] || '';
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.revoke_grandfathered_entitlement_safe/);
  assert.match(rollback, /DROP TABLE IF EXISTS public\.activation_grandfather_candidates/);
});

test('the entitlement table gains an explicit source, not a parallel mechanism', () => {
  assert.match(MIGRATION, /ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'payhip'/);
  assert.match(MIGRATION, /source IN \('payhip', 'grandfathered_funded_customer'\)/);
  // A grant carries its own audit trail.
  for (const col of ['granted_at', 'grant_snapshot_id', 'grant_reason']) {
    assert.match(MIGRATION, new RegExp('ADD COLUMN IF NOT EXISTS ' + col));
  }
});

test('a Payhip row keeps its strict shape; a grant is explicitly shapeless-free', () => {
  assert.match(MIGRATION, /ALTER COLUMN purchase_id\s+DROP NOT NULL/);
  assert.match(MIGRATION, /ALTER COLUMN licence_key_hash DROP NOT NULL/);
  assert.match(MIGRATION, /CONSTRAINT payhip_entitlement_source_shape CHECK/);
  // payhip branch: both columns required. grant branch: both must be absent.
  assert.match(MIGRATION, /source = 'payhip'\s*\n\s*AND purchase_id IS NOT NULL\s*\n\s*AND licence_key_hash IS NOT NULL/);
  assert.match(MIGRATION, /source <> 'payhip'\s*\n\s*AND purchase_id IS NULL\s*\n\s*AND licence_key_hash IS NULL\s*\n\s*AND claimed_at IS NOT NULL\s*\n\s*AND user_id IS NOT NULL/);
});

test('one grant per account, forever, is enforced by a partial unique index', () => {
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS payhip_entitlements_one_grant_per_user/);
  assert.match(MIGRATION, /ON public\.payhip_entitlements \(user_id, source\)\s*\n\s*WHERE source <> 'payhip'/);
  // ... and every insert path tolerates a replay.
  assert.match(MIGRATION, /ON CONFLICT DO NOTHING/);
});

test('NO fake payment record: the migration never writes payhip_purchases', () => {
  assert.doesNotMatch(MIGRATION, /INSERT INTO (public\.)?payhip_purchases/i);
  assert.doesNotMatch(MIGRATION, /UPDATE (public\.)?payhip_purchases/i);
  // A paid STATUS may be READ (the resolver compares against it) but never written.
  assert.doesNotMatch(MIGRATION_SQL, /INSERT INTO[\s\S]{0,200}'paid'/);
  assert.doesNotMatch(MIGRATION_SQL, /SET\s+status\s*=\s*'paid'/i);
});

test('no money moves: no wallet, deposit, trade or invoice write in the migration', () => {
  assert.doesNotMatch(MIGRATION, /UPDATE (public\.)?wallets/i);
  assert.doesNotMatch(MIGRATION, /INSERT INTO (public\.)?wallets/i);
  assert.doesNotMatch(MIGRATION, /(INSERT INTO|UPDATE|DELETE FROM) (public\.)?deposits/i);
  assert.doesNotMatch(MIGRATION, /(INSERT INTO|UPDATE|DELETE FROM) (public\.)?payment_invoices/i);
  assert.doesNotMatch(MIGRATION, /(INSERT INTO|UPDATE|DELETE FROM) (public\.)?trades/i);
});

// ---------------------------------------------------------------- eligibility

test('eligibility is the resolver rule: GREATEST(legacy, provider) >= 100', () => {
  assert.match(MIGRATION, /SUM\(CASE WHEN status = 'confirmed' THEN COALESCE\(amount, 0\) ELSE 0 END\)/);
  assert.match(MIGRATION, /SUM\(CASE WHEN status = 'confirmed' THEN COALESCE\(amount_usd, 0\) ELSE 0 END\)/);
  assert.match(MIGRATION, /GREATEST\(COALESCE\(dep\.total, 0\), COALESCE\(inv\.total, 0\)\)/);
  assert.match(MIGRATION_SQL, /min_deposit\s+NUMERIC NOT NULL DEFAULT 100/);
});

test('wallet balance is never an eligibility input', () => {
  assert.doesNotMatch(MIGRATION_SQL, /live_balance/);
  assert.doesNotMatch(MIGRATION_SQL, /demo_balance|bonus_balance/);
});

test('sandbox accounts and already-licensed accounts are excluded', () => {
  assert.match(MIGRATION, /per\.env <> 'MARKETING_SANDBOX'/);
  assert.match(MIGRATION, /'sandbox_excluded'/);
  assert.match(MIGRATION, /'already_licensed'/);
  assert.match(MIGRATION, /WHEN per\.already_licensed\s+THEN 'already_licensed'/);
});

test('a non-qualifying account gets an auditable reason, not silence', () => {
  for (const reason of ['sandbox_excluded', 'already_licensed', 'eligible', 'below_minimum_deposit', 'no_confirmed_deposit']) {
    assert.match(MIGRATION, new RegExp("'" + reason + "'"));
  }
});

// ------------------------------------------------------------------ snapshot

test('the snapshot is frozen: membership is materialised, never recomputed', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS public\.activation_grandfather_candidates/);
  assert.match(MIGRATION, /PRIMARY KEY \(snapshot_id, user_id\)/);
  assert.match(MIGRATION_SQL, /INSERT INTO activation_grandfather_candidates[\s\S]*?ON CONFLICT \(snapshot_id, user_id\) DO NOTHING/);
  // Idempotent on the cutover key.
  assert.match(MIGRATION, /snapshot_key\s+TEXT NOT NULL UNIQUE/);
  assert.match(MIGRATION, /'duplicate', true/);
});

test('apply is idempotent and skips candidates that are already granted', () => {
  assert.match(MIGRATION, /AND c\.granted_at IS NULL/);
  assert.match(MIGRATION, /UPDATE activation_grandfather_candidates\s+SET granted_at = NOW\(\)/);
  assert.match(MIGRATION, /FOR UPDATE OF c SKIP LOCKED/);
});

test('the snapshot records the cutover, the criteria version and the evidence', () => {
  assert.match(MIGRATION, /cutover_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(MIGRATION, /criteria_version TEXT NOT NULL DEFAULT 'funded-v1'/);
  assert.match(MIGRATION, /legacy_total\s+NUMERIC NOT NULL DEFAULT 0/);
  assert.match(MIGRATION, /provider_total\s+NUMERIC NOT NULL DEFAULT 0/);
  // No PII beyond the account id.
  assert.doesNotMatch(MIGRATION_SQL, /email\s+(TEXT|VARCHAR)/i);
});

// ------------------------------------------------------------------ resolver

test('the resolver keeps the paid branch and adds the grant branch', () => {
  assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.payhip_has_live_activation/);
  assert.match(MIGRATION, /LEFT JOIN payhip_purchases p ON p\.id = e\.purchase_id/);
  assert.match(MIGRATION, /\(e\.source = 'payhip' AND p\.status = 'paid'\)/);
  assert.match(MIGRATION, /OR \(e\.source <> 'payhip'\)/);
  // Revocation still ends activation for BOTH sources.
  assert.match(MIGRATION, /e\.claimed_at IS NOT NULL\s*\n\s*AND e\.revoked_at IS NULL/);
});

test('resolver failures still fail closed for callers (JS unchanged)', () => {
  // hasActivation is the single path the web routes and the worker use.
  assert.match(ENTITLEMENTS, /rpc\('payhip_has_live_activation', \{ p_user_id: userId \}\)/);
  assert.match(ENTITLEMENTS, /if \(error\) return null; \/\/ UNKNOWN/);
});

test('a Payhip refund cannot revoke a grant (it matches by purchase_id)', () => {
  assert.match(M050, /UPDATE payhip_entitlements\s+SET revoked_at[\s\S]{0,120}WHERE purchase_id = v_purchase_id/);
  // A grant has purchase_id NULL, and NULL never equals a sale's id.
  assert.match(MIGRATION, /source <> 'payhip'\s*\n\s*AND purchase_id IS NULL/);
});

test('a grant has no licence key, so redemption can never consume one', () => {
  assert.match(M050, /WHERE licence_key_hash = p_licence_hash\s*\n\s*FOR UPDATE/);
  assert.match(MIGRATION, /AND licence_key_hash IS NULL/);
});

test('grant revocation is explicit, admin-only and scoped to grant rows', () => {
  assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.revoke_grandfathered_entitlement_safe/);
  assert.match(MIGRATION, /WHERE user_id = p_user_id\s*\n\s*AND source <> 'payhip'\s*\n\s*AND revoked_at IS NULL/);
});

// ---------------------------------------------------------------- security

test('every new function is SECURITY DEFINER with a pinned search_path', () => {
  const fns = MIGRATION.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g) || [];
  assert.strictEqual(fns.length, 6, 'expected six functions');
  fns.forEach((f) => {
    assert.match(f, /SECURITY DEFINER/);
    assert.match(f, /SET search_path = public, pg_temp/);
  });
});

test('new tables are RLS-locked to service_role, like the rest of Payhip', () => {
  assert.match(MIGRATION, /ALTER TABLE public\.activation_grandfather_snapshots\s+ENABLE ROW LEVEL SECURITY/);
  assert.match(MIGRATION, /ALTER TABLE public\.activation_grandfather_candidates ENABLE ROW LEVEL SECURITY/);
  assert.match(MIGRATION, /FOR ALL TO service_role USING \(true\) WITH CHECK \(true\)/);
  assert.match(MIGRATION, /REVOKE ALL ON public\.%I FROM PUBLIC, anon, authenticated/);
});

test('EXECUTE is service_role only for all six functions', () => {
  const grants = MIGRATION.split('Grants: service_role only')[1] || '';
  for (const fn of ['payhip_has_live_activation(bigint)', 'grandfather_activation_preview(numeric)',
    'grandfather_activation_snapshot(text,text)', 'grandfather_activation_apply(bigint,integer)',
    'grandfather_activation_report()', 'revoke_grandfathered_entitlement_safe(bigint,text)']) {
    assert.ok(grants.includes('public.' + fn), 'missing grant list entry ' + fn);
  }
  assert.match(grants, /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION %s TO service_role/);
});

test('the migration self-checks and documents its rollback', () => {
  assert.match(MIGRATION, /054 self-check failed/);
  assert.match(MIGRATION, /WHERE n\.nspname='public' AND p\.proname='payhip_has_live_activation'/);
  assert.match(MIGRATION, /\n-- ROLLBACK/);
  assert.match(MIGRATION, /DELETE FROM public\.payhip_entitlements WHERE source <> 'payhip';/);
});

// ------------------------------------------------------------------ worker

test('the worker gate is intact and unchanged by this migration', () => {
  assert.match(ACTIVATION, /rpc\('payhip_has_live_activation'/);
  assert.match(WORKER, /LIVE MODE ACTIVATION GATE/);
  // Ordering: kill switch -> lease fence -> activation -> wallet read -> risk.
  const order = ['readControl()', 'renewLease(session)', 'LIVE MODE ACTIVATION GATE',
    'const inputs = await loadSessionInputs(userId)', 'const verdict = evaluateRisk({'];
  const positions = order.map((needle) => WORKER.indexOf(needle));
  positions.forEach((p, i) => assert.ok(p > 0, 'missing ' + order[i]));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i - 1] < positions[i], order[i] + ' must come after ' + order[i - 1]);
  }
});

test('activation still defaults OFF and is untouched by 054', () => {
  assert.match(ENTITLEMENTS, /activationRequired: get\('PAYHIP_ACTIVATION_REQUIRED', ''\)\.toLowerCase\(\) === 'true'/);
  assert.doesNotMatch(MIGRATION, /PAYHIP_ACTIVATION_REQUIRED/);
  assert.doesNotMatch(MIGRATION, /ALTER (SYSTEM|DATABASE)/i);
});

// ------------------------------------------------------------------ script

test('the operator script is read-only by default', () => {
  const plan = mod.checkMode(mod.parseArgs([]));
  assert.deepStrictEqual(plan, { ok: true, write: false });
  assert.strictEqual(mod.parseArgs(['--report']).mode, 'report');
  assert.strictEqual(mod.parseArgs(['--report']).showIds, false);
});

test('write modes refuse without their own confirmation flag', () => {
  const snap = mod.checkMode(mod.parseArgs(['--snapshot', '--key=cut-1']));
  assert.strictEqual(snap.ok, false);
  assert.match(snap.reason, /--confirm-snapshot/);

  const apply = mod.checkMode(mod.parseArgs(['--apply', '--snapshot-id=1']));
  assert.strictEqual(apply.ok, false);
  assert.match(apply.reason, /--confirm-apply/);

  const noKey = mod.checkMode(mod.parseArgs(['--snapshot', '--confirm-snapshot']));
  assert.strictEqual(noKey.ok, false);
  assert.match(noKey.reason, /--key/);

  const noId = mod.checkMode(mod.parseArgs(['--apply', '--confirm-apply']));
  assert.strictEqual(noId.ok, false);
  assert.match(noId.reason, /--snapshot-id/);
});

test('confirmed write modes target only the 054 functions', () => {
  const snap = mod.checkMode(mod.parseArgs(['--snapshot', '--key=cut-1', '--confirm-snapshot', '--note=launch']));
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.rpc, 'grandfather_activation_snapshot');
  assert.deepStrictEqual(snap.params, { p_snapshot_key: 'cut-1', p_note: 'launch' });

  const apply = mod.checkMode(mod.parseArgs(['--apply', '--snapshot-id=7', '--confirm-apply']));
  assert.strictEqual(apply.ok, true);
  assert.strictEqual(apply.rpc, 'grandfather_activation_apply');
  assert.deepStrictEqual(apply.params, { p_snapshot_id: 7 });
});

test('reports hide account ids unless explicitly asked', () => {
  const report = { activeGrants: 1, snapshots: [{ id: 3, key: 'cut-1', cutoverAt: 'x', eligibleCount: 3, appliedCount: 3 }],
    grants: [{ userId: 4242, snapshotId: 3, grantedAt: 'x', revokedAt: null, reason: 'funded' }] };
  const hidden = mod.printReport(report, false);
  assert.ok(!hidden.includes('4242'));
  assert.match(hidden, /--show-ids/);
  const shown = mod.printReport(report, true);
  assert.ok(shown.includes('4242'));
});

test('the script never prints a credential', () => {
  // The value may only reach the client constructor and the presence check.
  const uses = (SCRIPT.match(/args\.key_secret/g) || []).length;
  assert.strictEqual(uses, 2, 'key_secret should be read exactly twice (presence check + client)');
  assert.doesNotMatch(SCRIPT, /console\.(log|error)\([^)]*args\.key_secret/);
  assert.doesNotMatch(SCRIPT, /console\.(log|error)\([^)]*key_secret\)/);
  assert.match(SCRIPT, /hostOf\(args\.url\)/);
});
