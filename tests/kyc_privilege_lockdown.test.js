/**
 * Phase 3B — KYC tables privilege lockdown contract tests.
 *
 * Pure contract/static tests (no express/server import, no DB connection):
 * pin the security posture of migration 017 and the server's access path to
 * the four KYC tables.
 *
 * PII RULE: these tests must never contain, read, or compare real PII
 * (legal names, document contents/paths, or any row values). Only table/key
 * NAMES are referenced.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/017_kyc_privilege_lockdown.sql'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const KYC_SERVICE = fs.readFileSync(path.join(ROOT, 'services/KYCService.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

const TABLES = [
  'verification_profiles',
  'verification_documents',
  'verification_history',
  'admin_review_history',
];

// Tables/systems that must NOT be touched by this phase.
const OFF_LIMITS = [
  'users', 'wallets', 'deposits', 'withdrawals', 'transactions', 'trades',
  'bot_sessions', 'payment_invoices', 'webhook_logs', 'subscriptions',
  'subscription_charges', 'payment_config',
  'password_reset_tokens', 'email_verification_codes', 'email_change_requests',
  'twofa_profiles', 'twofa_attempts', 'email_2fa_attempts', 'feature_flags',
];

// -----------------------------------------------
// 1. RLS enabled on all four tables (and only those)
// -----------------------------------------------
test('migration 017 enables RLS on exactly the four KYC tables', () => {
  const enables = (MIGRATION.match(/ALTER TABLE\s+public\.\w+\s+ENABLE ROW LEVEL SECURITY/gi) || [])
    .map((s) => s.match(/public\.(\w+)/i)[1].toLowerCase());
  assert.deepStrictEqual([...enables].sort(), [...TABLES].sort());
});

// -----------------------------------------------
// 2. service_role-only policies re-asserted (idempotent)
// -----------------------------------------------
test('migration 017 re-asserts the four service_role-only policies', () => {
  const expected = {
    verification_profiles: 'kyc_vp_service_all',
    verification_documents: 'kyc_vd_service_all',
    verification_history: 'kyc_vh_service_all',
    admin_review_history: 'kyc_arh_service_all',
  };
  for (const [table, policy] of Object.entries(expected)) {
    assert.match(MIGRATION, new RegExp(`DROP POLICY IF EXISTS "${policy}" ON public\\.${table};`));
    assert.match(MIGRATION,
      new RegExp(`CREATE POLICY "${policy}" ON public\\.${table}\\s+FOR ALL TO service_role`));
  }
});

// -----------------------------------------------
// 3. NO policy for anon/authenticated/public
// -----------------------------------------------
test('migration 017 creates NO policy for anon/authenticated/public', () => {
  const policies = MIGRATION.match(/CREATE POLICY[\s\S]*?;/g) || [];
  assert.strictEqual(policies.length, TABLES.length, 'one service_role policy per table expected');
  for (const p of policies) {
    assert.match(p, /FOR ALL TO service_role/);
    assert.ok(!/TO\s+(anon|authenticated|public)\b/i.test(p),
      'no client-facing role may be granted a policy: ' + p.slice(0, 80));
  }
  // Verification block asserts absence of anon/authenticated/public policies.
  assert.match(MIGRATION, /roles @> ARRAY\['anon'\]::name\[\]/);
  assert.match(MIGRATION, /roles @> ARRAY\['authenticated'\]::name\[\]/);
  assert.match(MIGRATION, /roles @> ARRAY\['public'\]::name\[\]/);
});

// -----------------------------------------------
// 4. THE KEY FIX: privileges revoked from anon/authenticated on every table
// -----------------------------------------------
test('migration 017 revokes ALL privileges from anon and authenticated on every KYC table', () => {
  for (const t of TABLES) {
    assert.match(MIGRATION, new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM anon;`));
    assert.match(MIGRATION, new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM authenticated;`));
  }
});

// -----------------------------------------------
// 5. service_role granted full access on every table
// -----------------------------------------------
test('migration 017 grants service_role full access on every KYC table', () => {
  for (const t of TABLES) {
    assert.match(MIGRATION,
      new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON public\\.${t}\\s+TO service_role;`));
  }
});

// -----------------------------------------------
// 6. verification block checks privileges (not just policies)
// -----------------------------------------------
test('migration 017 verification block checks both policies and table privileges', () => {
  assert.match(MIGRATION, /DO \$\$/);
  assert.match(MIGRATION, /relrowsecurity/);
  assert.match(MIGRATION, /pg_policies/);
  // Unlike 010, the verify block must also check role_table_grants for
  // anon/authenticated (the privilege leak 010 missed).
  assert.match(MIGRATION, /information_schema\.role_table_grants/);
  assert.match(MIGRATION, /grantee IN \('anon', 'authenticated'\)/);
  assert.match(MIGRATION, /RAISE EXCEPTION/);
});

// -----------------------------------------------
// 7. server access path uses supabaseAdmin (never the anon client)
// -----------------------------------------------
test('server accesses KYC tables only via supabaseAdmin / KYCService(admin)', () => {
  const strip = SERVER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const t of TABLES) {
    const anonRe = new RegExp(`(?<![A-Za-z])supabase(\\s*\\n\\s*|\\s*)\\.from\\('${t}'`, 'g');
    assert.ok(!anonRe.test(strip), `anon client must not access ${t} in server.js`);
  }
  // server.js reads verification_profiles via supabaseAdmin
  assert.match(strip, /supabaseAdmin(\s*\n\s*|\s*)\.from\('verification_profiles'/);
  // KYCService (which queries all four tables) is constructed with supabaseAdmin
  assert.match(strip, /new KYCService\(supabaseAdmin, supabaseAdmin\.storage\)/);
  for (const t of ['verification_profiles', 'verification_documents', 'verification_history']) {
    assert.match(KYC_SERVICE, new RegExp(`\\.from\\('${t}'\\)`),
      `KYCService must reference ${t}`);
  }
});

// -----------------------------------------------
// 8. no frontend Supabase access exists
// -----------------------------------------------
test('frontend has no direct Supabase access', () => {
  assert.ok(!/supabase/i.test(INDEX_HTML),
    'public/index.html must not reference supabase');
});

// -----------------------------------------------
// 9. migration performs no data/schema changes
// -----------------------------------------------
test('migration 017 performs no data or schema changes', () => {
  const code = MIGRATION.replace(/--[^\n]*/g, '');
  for (const kw of ['INSERT INTO', 'UPDATE public.', 'DELETE FROM', 'TRUNCATE', 'DROP TABLE', 'ADD COLUMN', 'DROP COLUMN', 'ALTER COLUMN']) {
    assert.ok(!code.toUpperCase().includes(kw.toUpperCase()),
      `migration must not contain ${kw}`);
  }
  // Only ENABLE RLS alters allowed.
  const alters = code.match(/ALTER TABLE\s+public\.\w+\s+\w+(\s+\w+)*/gi) || [];
  for (const a of alters) {
    assert.match(a, /ENABLE ROW LEVEL SECURITY$/i, 'only ENABLE RLS alters allowed: ' + a);
  }
});

// -----------------------------------------------
// 10. migration does not touch financial/auth/payment/Sandbox tables
// -----------------------------------------------
test('migration 017 touches no financial/auth/payment/Sandbox tables', () => {
  const code = MIGRATION.replace(/--[^\n]*/g, '');
  for (const t of OFF_LIMITS) {
    const re = new RegExp(`(ALTER TABLE|CREATE POLICY|DROP POLICY|REVOKE|GRANT)[^;]*\\b${t}\\b`, 'i');
    assert.ok(!re.test(code), `migration must not touch ${t}`);
  }
  assert.ok(!/sandbox_/i.test(code), 'migration must not touch sandbox tables');
  // storage.objects bucket/policies left to migration 010 (not modified here)
  assert.ok(!/storage\.objects/i.test(code), 'migration must not touch storage.objects');
});

// -----------------------------------------------
// 11. migration does not modify migrations 010/014/015/016 files
// -----------------------------------------------
test('migrations 010/014/015/016 files are not modified by this phase', () => {
  // Only the NEW 017 file should exist for this phase; the others are unchanged
  // on disk (we simply assert they still contain their lockdown signatures).
  const m010 = fs.readFileSync(path.join(ROOT, 'supabase/migrations/010_kyc_rls_security.sql'), 'utf8');
  assert.match(m010, /ALTER TABLE public\.verification_profiles ENABLE ROW LEVEL SECURITY/);
  const m016 = fs.readFileSync(path.join(ROOT, 'supabase/migrations/016_auth_security_rls_lockdown.sql'), 'utf8');
  assert.match(m016, /DROP POLICY IF EXISTS "Service role can insert reset tokens"/);
  const m015 = fs.readFileSync(path.join(ROOT, 'supabase/migrations/015_payment_config_rls_lockdown.sql'), 'utf8');
  assert.match(m015, /REVOKE ALL ON public\.payment_config FROM anon;/);
  const m014 = fs.readFileSync(path.join(ROOT, 'supabase/migrations/014_financial_rpc_execute_lockdown.sql'), 'utf8');
  assert.match(m014, /REVOKE EXECUTE ON FUNCTION public\.record_trade_safe/);
});

// -----------------------------------------------
// 12. idempotency
// -----------------------------------------------
test('migration 017 is idempotent', () => {
  assert.match(MIGRATION, /DROP POLICY IF EXISTS/g);
  assert.match(MIGRATION, /RAISE NOTICE/);
  // all four tables enumerated in the verify block
  for (const t of TABLES) {
    assert.ok(MIGRATION.includes(`'${t}'`), `verify block must list ${t}`);
  }
});
