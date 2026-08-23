/**
 * Phase 3A — Authentication/Security tables RLS lockdown contract tests.
 *
 * Pure contract/static tests (no express/server import, no DB connection):
 * pin the security posture of migration 016 and the server's access path to
 * the seven authentication/security tables.
 *
 * SECRET-HANDLING RULE: these tests must never contain, read, or compare
 * real token/code/secret values. Only table/key NAMES are referenced.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/016_auth_security_rls_lockdown.sql'), 'utf8');
const MIGRATION_014 = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/014_financial_rpc_execute_lockdown.sql'), 'utf8');
const MIGRATION_015 = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/015_payment_config_rls_lockdown.sql'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const EMAIL_2FA = fs.readFileSync(path.join(ROOT, 'services/Email2FAService.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

const TABLES = [
  'password_reset_tokens',
  'email_verification_codes',
  'email_change_requests',
  'twofa_profiles',
  'twofa_attempts',
  'email_2fa_attempts',
  'feature_flags',
];

// Tables that must NOT be touched by this phase.
const OFF_LIMITS = [
  'users', 'wallets', 'deposits', 'withdrawals', 'transactions', 'trades',
  'bot_sessions', 'payment_invoices', 'webhook_logs', 'subscriptions',
  'subscription_charges', 'verification_profiles', 'verification_documents',
  'verification_history', 'admin_review_history', 'payment_config',
];

// -----------------------------------------------
// 1. RLS enabled on all seven tables (and only those)
// -----------------------------------------------
test('migration 016 enables RLS on exactly the seven auth/security tables', () => {
  const enables = (MIGRATION.match(/ALTER TABLE\s+public\.\w+\s+ENABLE ROW LEVEL SECURITY/gi) || [])
    .map((s) => s.match(/public\.(\w+)/i)[1].toLowerCase());
  assert.deepStrictEqual([...enables].sort(), [...TABLES].sort());
});

// -----------------------------------------------
// 2-5. anon denied SELECT/INSERT/UPDATE/DELETE
//      (no anon policy + revoke; RLS default-deny covers all operations)
// -----------------------------------------------
test('migration 016 creates NO policy for anon/authenticated/public on any table', () => {
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

test('migration 016 revokes ALL privileges from anon and authenticated on every table', () => {
  for (const t of TABLES) {
    assert.match(MIGRATION, new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM anon;`));
    assert.match(MIGRATION, new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM authenticated;`));
  }
});

// -----------------------------------------------
// 6. authenticated cannot directly access them
// -----------------------------------------------
test('migration 016 grants nothing to the authenticated role', () => {
  assert.ok(!/GRANT\s+[^;]*\sTO\s+authenticated/i.test(MIGRATION),
    'no GRANT to authenticated');
  assert.ok(!/CREATE POLICY[\s\S]*?TO\s+authenticated/i.test(MIGRATION),
    'no policy for authenticated');
});

// -----------------------------------------------
// 7. service_role remains authorized
// -----------------------------------------------
test('migration 016 grants service_role full access on every table', () => {
  for (const t of TABLES) {
    assert.match(MIGRATION,
      new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON public\\.${t}\\s+TO service_role;`));
    assert.match(MIGRATION,
      new RegExp(`CREATE POLICY "${t}_service_all" ON public\\.${t}\\s+FOR ALL TO service_role`));
  }
});

// -----------------------------------------------
// 8. server-side auth paths use supabaseAdmin (never the anon client)
// -----------------------------------------------
test('every server access to the seven tables uses supabaseAdmin', () => {
  const strip = SERVER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const t of TABLES) {
    // anon client may never touch the table: bare `supabase` followed by .from('<t>')
    const anonRe = new RegExp(`(?<![A-Za-z])supabase(\\s*\\n\\s*|\\s*)\\.from\\('${t}'`, 'g');
    assert.ok(!anonRe.test(strip), `anon client must not access ${t}`);
    // the table IS accessed via supabaseAdmin somewhere
    const adminRe = new RegExp(`supabaseAdmin(\\s*\\n\\s*|\\s*)\\.from\\('${t}'`);
    assert.ok(adminRe.test(strip), `expected supabaseAdmin access to ${t}`);
  }
  // Email2FAService rate-limit queries run on the injected service-role client.
  assert.match(EMAIL_2FA, /\.from\('email_2fa_attempts'\)/);
  assert.match(SERVER, /checkResendRateLimit\(supabaseAdmin,/);
  assert.match(SERVER, /checkVerifyRateLimit\(supabaseAdmin,/);
});

// -----------------------------------------------
// 9. no frontend Supabase access exists
// -----------------------------------------------
test('frontend has no direct Supabase access', () => {
  assert.ok(!/supabase/i.test(INDEX_HTML),
    'public/index.html must not reference supabase');
});

// -----------------------------------------------
// 10. no secret values in the migration (names only)
// -----------------------------------------------
test('migration 016 contains no secret-looking values', () => {
  assert.ok(!/(api[_-]?key|secret|token|password|hash)\s*=\s*['"][^'"]{8,}/i.test(MIGRATION),
    'migration must not embed secret values');
  assert.ok(!/BEGIN;\s*INSERT|INSERT INTO/i.test(MIGRATION), 'migration must not insert rows');
});

// -----------------------------------------------
// 11. migration does not alter data
// -----------------------------------------------
test('migration 016 performs no data changes', () => {
  for (const kw of ['INSERT INTO', 'UPDATE public.', 'DELETE FROM', 'TRUNCATE', 'DROP TABLE', 'ALTER TABLE public.password_reset_tokens ADD', 'ALTER TABLE public.twofa_profiles ADD']) {
    assert.ok(!MIGRATION.toUpperCase().includes(kw.toUpperCase()),
      `migration must not contain ${kw}`);
  }
  // No ALTER TABLE other than ENABLE ROW LEVEL SECURITY.
  const alters = MIGRATION.match(/ALTER TABLE\s+public\.\w+\s+\w+(\s+\w+)*/gi) || [];
  for (const a of alters) {
    assert.match(a, /ENABLE ROW LEVEL SECURITY$/i, 'only ENABLE RLS alters allowed: ' + a);
  }
});

// -----------------------------------------------
// 12. migration does not touch financial/Sandbox/KYC tables
// -----------------------------------------------
test('migration 016 touches no financial/Sandbox/KYC/payment tables', () => {
  // Strip comments so scope-exclusion prose doesn't count as a touch.
  const code = MIGRATION.replace(/--[^\n]*/g, '');
  for (const t of OFF_LIMITS) {
    const re = new RegExp(`(ALTER TABLE|CREATE POLICY|DROP POLICY|REVOKE|GRANT)[^;]*\\b${t}\\b`, 'i');
    assert.ok(!re.test(code), `migration must not touch ${t}`);
  }
  assert.ok(!/sandbox_/i.test(code), 'migration must not touch sandbox tables');
});

// -----------------------------------------------
// 13-14. migrations 014 and 015 remain intact
// -----------------------------------------------
test('migration 014 financial RPC lockdown remains intact', () => {
  assert.match(MIGRATION_014, /REVOKE EXECUTE ON FUNCTION public\.record_trade_safe/);
  assert.match(MIGRATION_014, /REVOKE EXECUTE ON FUNCTION public\.credit_payment_safe/);
  assert.match(MIGRATION_014, /REVOKE EXECUTE ON FUNCTION public\.paymento_credit_user_safe/);
  assert.match(MIGRATION_014, /FROM anon/);
  assert.match(MIGRATION_014, /FROM authenticated/);
});

test('migration 015 payment_config lockdown remains intact', () => {
  assert.match(MIGRATION_015, /ALTER TABLE public\.payment_config ENABLE ROW LEVEL SECURITY;/);
  assert.match(MIGRATION_015, /REVOKE ALL ON public\.payment_config FROM anon;/);
  assert.match(MIGRATION_015, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.payment_config TO service_role;/);
});

// -----------------------------------------------
// 15. idempotency + verification block
// -----------------------------------------------
test('migration 016 is idempotent and self-verifying', () => {
  assert.match(MIGRATION, /DROP POLICY IF EXISTS/g);
  assert.match(MIGRATION, /DO \$\$/);
  assert.match(MIGRATION, /RAISE EXCEPTION/);
  assert.match(MIGRATION, /relrowsecurity/);
  // all seven tables enumerated in the verify block
  for (const t of TABLES) {
    assert.ok(MIGRATION.includes(`'${t}'`), `verify block must list ${t}`);
  }
});

// -----------------------------------------------
// 16. feature_flags trigger function is preserved (not dropped)
// -----------------------------------------------
test('migration 016 does not drop the feature_flags trigger or its function', () => {
  assert.ok(!/DROP TRIGGER|DROP FUNCTION/i.test(MIGRATION),
    'update_feature_flags_updated_at trigger/function must be preserved');
});
