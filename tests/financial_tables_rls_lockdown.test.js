/**
 * Phase 3C — Production financial/application tables RLS lockdown contract tests.
 *
 * Pure contract/static tests (no express/server import, no DB connection):
 * pin the security posture of migration 018 and the server's access path to
 * the eleven production financial/application tables.
 *
 * SENSITIVE-DATA RULE: these tests must never contain, read, or compare real
 * user/wallet/transaction values. Only table/key NAMES are referenced.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/018_financial_tables_rls_lockdown.sql'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

const TABLES = [
  'users', 'wallets', 'deposits', 'withdrawals', 'transactions', 'trades',
  'bot_sessions', 'payment_invoices', 'webhook_logs', 'referrals', 'subscriptions',
];

// Tables/systems that must NOT be touched by this phase.
const OFF_LIMITS = [
  'payment_config',
  'password_reset_tokens', 'email_verification_codes', 'email_change_requests',
  'twofa_profiles', 'twofa_attempts', 'email_2fa_attempts', 'feature_flags',
  'verification_profiles', 'verification_documents', 'verification_history',
  'admin_review_history',
  'referral_config', 'referral_config_audit_log', 'audit_logs',
];

// The exact 19 legacy "TO anon" policies (confirmed via live pg_policies
// investigation after the first 018 apply attempt failed + rolled back) that
// migration 018 must drop BEFORE creating each table's service-role policy.
// trades / payment_invoices / webhook_logs / subscriptions have ZERO.
const LEGACY_DROPS = {
  users: [
    'Allow anonymous signup on users',
    'Allow anonymous select on users',
    'Allow anonymous update on users',
  ],
  wallets: [
    'Allow wallet insert on wallets',
    'Allow wallet select on wallets',
    'Allow wallet update on wallets',
  ],
  deposits: [
    'Allow deposit insert on deposits',
    'Allow deposit select on deposits',
    'Allow deposit update on deposits',
  ],
  withdrawals: [
    'Allow withdrawal insert on withdrawals',
    'Allow withdrawal select on withdrawals',
    'Allow withdrawal update on withdrawals',
  ],
  transactions: [
    'Allow transaction insert on transactions',
    'Allow transaction select on transactions',
  ],
  bot_sessions: [
    'Allow bot session insert on bot_sessions',
    'Allow bot session select on bot_sessions',
    'Allow bot session update on bot_sessions',
  ],
  referrals: [
    'Allow referral insert on referrals',
    'Allow referral select on referrals',
  ],
};
const LEGACY_DROP_COUNT = Object.values(LEGACY_DROPS).flat().length;
const LEGACY_FREE_TABLES = TABLES.filter((t) => !LEGACY_DROPS[t]);

// -----------------------------------------------
// 1. exact 11-table scope: RLS enabled on exactly these (and only these)
// -----------------------------------------------
test('migration 018 enables RLS on exactly the eleven financial/application tables', () => {
  const enables = (MIGRATION.match(/ALTER TABLE\s+public\.\w+\s+ENABLE ROW LEVEL SECURITY/gi) || [])
    .map((s) => s.match(/public\.(\w+)/i)[1].toLowerCase());
  assert.deepStrictEqual([...enables].sort(), [...TABLES].sort());
});

// -----------------------------------------------
// 2. service-role policy for every table
// -----------------------------------------------
test('migration 018 creates one service-role-only policy per table', () => {
  for (const t of TABLES) {
    assert.match(MIGRATION, new RegExp(`DROP POLICY IF EXISTS "${t}_service_all" ON public\\.${t};`));
    assert.match(MIGRATION,
      new RegExp(`CREATE POLICY "${t}_service_all" ON public\\.${t}\\s+FOR ALL TO service_role\\s+USING \\(true\\)\\s+WITH CHECK \\(true\\);`));
  }
});

// -----------------------------------------------
// 3. no anon/authenticated/public policy
// -----------------------------------------------
test('migration 018 creates NO policy for anon/authenticated/public', () => {
  const policies = MIGRATION.match(/CREATE POLICY[\s\S]*?;/g) || [];
  assert.strictEqual(policies.length, TABLES.length, 'one service_role policy per table expected');
  for (const p of policies) {
    assert.match(p, /FOR ALL TO service_role/);
    assert.ok(!/TO\s+(anon|authenticated|public)\b/i.test(p),
      'no client-facing role may be granted a policy: ' + p.slice(0, 80));
  }
  assert.match(MIGRATION, /roles @> ARRAY\['anon'\]::name\[\]/);
  assert.match(MIGRATION, /roles @> ARRAY\['authenticated'\]::name\[\]/);
  assert.match(MIGRATION, /roles @> ARRAY\['public'\]::name\[\]/);
});

// -----------------------------------------------
// 4-5. anon + authenticated revoke for every table
// -----------------------------------------------
test('migration 018 revokes ALL privileges from anon and authenticated on every table', () => {
  for (const t of TABLES) {
    assert.match(MIGRATION, new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM anon;`));
    assert.match(MIGRATION, new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM authenticated;`));
  }
});

// -----------------------------------------------
// 6. service-role grants
// -----------------------------------------------
test('migration 018 grants service_role full access on every table', () => {
  for (const t of TABLES) {
    assert.match(MIGRATION,
      new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON public\\.${t}\\s+TO service_role;`));
  }
});

// -----------------------------------------------
// 7. verification block checks BOTH policies AND grants (+ service_role)
// -----------------------------------------------
test('migration 018 verification block checks policies and table grants (both directions)', () => {
  assert.match(MIGRATION, /information_schema\.role_table_grants/);
  assert.match(MIGRATION, /pg_policies/);
  assert.match(MIGRATION, /relrowsecurity/);
  // denies anon/authenticated
  assert.match(MIGRATION, /grantee IN \('anon', 'authenticated'\)/);
  // asserts service_role policy + privileges exist
  assert.match(MIGRATION, /service_role'\]::name\[\]/);
  assert.match(MIGRATION, /grantee = 'service_role'/);
  assert.match(MIGRATION, /RAISE EXCEPTION/);
  // all 11 tables enumerated in the verify block
  for (const t of TABLES) {
    assert.ok(MIGRATION.includes(`'${t}'`), `verify block must list ${t}`);
  }
});

// -----------------------------------------------
// 8. idempotency
// -----------------------------------------------
test('migration 018 is idempotent (DROP POLICY IF EXISTS before every CREATE)', () => {
  const creates = MIGRATION.match(/CREATE POLICY/g) || [];
  const idempotentDrops = MIGRATION.match(/DROP POLICY IF EXISTS/g) || [];
  assert.ok(idempotentDrops.length >= creates.length,
    'every CREATE POLICY must be preceded by a DROP POLICY IF EXISTS');
  assert.match(MIGRATION, /RAISE NOTICE/);
});

// -----------------------------------------------
// 9. no data mutation statements
// -----------------------------------------------
test('migration 018 performs no data changes', () => {
  const code = MIGRATION.replace(/--[^\n]*/g, '');
  for (const kw of ['INSERT INTO', 'UPDATE public.', 'DELETE FROM', 'TRUNCATE', 'DROP TABLE']) {
    assert.ok(!code.toUpperCase().includes(kw.toUpperCase()),
      `migration must not contain ${kw}`);
  }
});

// -----------------------------------------------
// 10. no schema/column changes
// -----------------------------------------------
test('migration 018 performs no schema/column changes', () => {
  const code = MIGRATION.replace(/--[^\n]*/g, '')
    .replace(/ALTER TABLE\s+public\.\w+\s+ENABLE ROW LEVEL SECURITY/gi, '');
  for (const kw of ['ADD COLUMN', 'DROP COLUMN', 'ALTER COLUMN', 'CREATE TABLE', 'ADD CONSTRAINT']) {
    assert.ok(!code.toUpperCase().includes(kw.toUpperCase()),
      `migration must not contain ${kw}`);
  }
});

// -----------------------------------------------
// 11. no RPC/function changes
// -----------------------------------------------
test('migration 018 does not touch any function/RPC', () => {
  const code = MIGRATION.replace(/--[^\n]*/g, '');
  for (const kw of ['CREATE FUNCTION', 'ALTER FUNCTION', 'DROP FUNCTION', 'CREATE OR REPLACE FUNCTION', 'GRANT EXECUTE', 'REVOKE EXECUTE']) {
    assert.ok(!code.toUpperCase().includes(kw.toUpperCase()),
      `migration must not touch functions: ${kw}`);
  }
});

// -----------------------------------------------
// 12. off-limits tables untouched
// -----------------------------------------------
test('migration 018 touches no off-limits tables', () => {
  const code = MIGRATION.replace(/--[^\n]*/g, '');
  for (const t of OFF_LIMITS) {
    const re = new RegExp(`(ALTER TABLE|CREATE POLICY|DROP POLICY|REVOKE|GRANT)[^;]*\\b${t}\\b`, 'i');
    assert.ok(!re.test(code), `migration must not touch ${t}`);
  }
  assert.ok(!/sandbox_/i.test(code), 'migration must not touch sandbox tables');
  assert.ok(!/storage\.objects/i.test(code), 'migration must not touch storage.objects');
});

// -----------------------------------------------
// 13. migrations 014-017 untouched (their lockdowns still present on disk)
// -----------------------------------------------
test('migrations 014/015/016/017 are not modified by this phase', () => {
  const m014 = fs.readFileSync(path.join(ROOT, 'supabase/migrations/014_financial_rpc_execute_lockdown.sql'), 'utf8');
  assert.match(m014, /REVOKE EXECUTE ON FUNCTION public\.record_trade_safe/);
  const m015 = fs.readFileSync(path.join(ROOT, 'supabase/migrations/015_payment_config_rls_lockdown.sql'), 'utf8');
  assert.match(m015, /REVOKE ALL ON public\.payment_config FROM anon;/);
  const m016 = fs.readFileSync(path.join(ROOT, 'supabase/migrations/016_auth_security_rls_lockdown.sql'), 'utf8');
  assert.match(m016, /REVOKE ALL ON public\.twofa_profiles\s+FROM anon;/);
  const m017 = fs.readFileSync(path.join(ROOT, 'supabase/migrations/017_kyc_privilege_lockdown.sql'), 'utf8');
  assert.match(m017, /REVOKE ALL ON public\.verification_profiles\s+FROM anon;/);
});

// -----------------------------------------------
// 14. server continues to use supabaseAdmin for these tables
// -----------------------------------------------
test('server accesses the eleven tables only via supabaseAdmin (never bare anon client)', () => {
  const strip = SERVER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const t of TABLES) {
    const anonRe = new RegExp(`(?<![A-Za-z])supabase(\\s*\\n\\s*|\\s*)\\.from\\('${t}'`, 'g');
    assert.ok(!anonRe.test(strip),
      `server.js must not access ${t} via the bare anon client`);
  }
});

// -----------------------------------------------
// 15. frontend contains no direct Supabase access
// -----------------------------------------------
test('frontend has no direct Supabase access', () => {
  assert.ok(!/supabase/i.test(INDEX_HTML),
    'public/index.html must not reference supabase');
});

// -----------------------------------------------
// 16. exactly the 19 confirmed legacy drops, each verbatim + correctly scoped
// -----------------------------------------------
test('migration 018 drops exactly the 19 legacy anon policies, verbatim and scoped to the correct table', () => {
  assert.strictEqual(LEGACY_DROP_COUNT, 19, 'this phase confirmed exactly 19 legacy policies (not 22)');
  for (const [table, names] of Object.entries(LEGACY_DROPS)) {
    for (const name of names) {
      const stmt = `DROP POLICY IF EXISTS "${name}" ON public.${table};`;
      assert.ok(MIGRATION.includes(stmt),
        `missing exact legacy drop: ${stmt}`);
      // each drop is scoped to ONE table only (the table named in the ON clause)
      assert.ok(!new RegExp(`DROP POLICY IF EXISTS "${name}" ON public\\.(?!${table}\\b)`).test(MIGRATION),
        `legacy drop "${name}" must be scoped only to public.${table}`);
    }
  }
});

// -----------------------------------------------
// 17. legacy drops occur BEFORE each table's service-all policy creation
// -----------------------------------------------
test('migration 018 drops legacy policies before creating the service-role policy', () => {
  for (const [table, names] of Object.entries(LEGACY_DROPS)) {
    const createIdx = MIGRATION.indexOf(`CREATE POLICY "${table}_service_all" ON public.${table}`);
    assert.ok(createIdx > -1, `service-role policy must exist for ${table}`);
    for (const name of names) {
      const dropIdx = MIGRATION.indexOf(`DROP POLICY IF EXISTS "${name}" ON public.${table};`);
      assert.ok(dropIdx > -1, `legacy drop missing for "${name}" on ${table}`);
      assert.ok(dropIdx < createIdx,
        `"${name}" must be dropped before ${table}_service_all is created`);
    }
  }
});

// -----------------------------------------------
// 18. no unexpected policy drops (19 legacy + 11 service_all = 30 total)
// -----------------------------------------------
test('migration 018 contains no unexpected policy drops', () => {
  const drops = MIGRATION.match(/DROP POLICY IF EXISTS\s+"[^"]+"\s+ON public\.\w+\s*;/g) || [];
  assert.strictEqual(drops.length, LEGACY_DROP_COUNT + TABLES.length,
    'only the 19 legacy drops + 11 <table>_service_all drops are allowed');
  const allowed = new Set();
  for (const [table, names] of Object.entries(LEGACY_DROPS)) {
    for (const name of names) allowed.add(`DROP POLICY IF EXISTS "${name}" ON public.${table};`);
  }
  for (const t of TABLES) allowed.add(`DROP POLICY IF EXISTS "${t}_service_all" ON public.${t};`);
  for (const d of drops) {
    assert.ok(allowed.has(d.replace(/\s+ON public\./, ' ON public.').trim()),
      `unexpected policy drop: ${d}`);
  }
  // tables confirmed to have ZERO legacy policies must have no legacy drops
  assert.deepStrictEqual(LEGACY_FREE_TABLES, ['trades', 'payment_invoices', 'webhook_logs', 'subscriptions']);
  for (const t of LEGACY_FREE_TABLES) {
    const dropsForTable = drops.filter((d) => d.includes(`public.${t};`));
    assert.ok(!/Allow /.test(dropsForTable.join(' ')),
      `${t} must have no legacy "Allow ..." drops`);
  }
});

// -----------------------------------------------
// 19. legacy root file guard: supabase_rls_policies.sql must never be
// re-applied to production; migration 018 must drop every anon policy it
// creates. The file itself is NOT modified/deleted by this phase.
// -----------------------------------------------
test('legacy root policy file is quarantined: every anon policy it creates is dropped by 018', () => {
  const legacyPath = path.join(ROOT, 'supabase_rls_policies.sql');
  const legacy = fs.readFileSync(legacyPath, 'utf8');
  const anonCreates = legacy.match(/CREATE POLICY\s+"[^"]+"\s+ON\s+public\.\w+\s+FOR\s+\w+\s+TO\s+anon/gi) || [];
  assert.ok(anonCreates.length > 0, 'legacy file should contain anon policies (kept for reference)');
  for (const stmt of anonCreates) {
    const name = stmt.match(/"([^"]+)"/)[1];
    const table = stmt.match(/ON\s+public\.(\w+)/i)[1].toLowerCase();
    const drop = `DROP POLICY IF EXISTS "${name}" ON public.${table};`;
    assert.ok(MIGRATION.includes(drop),
      `migration 018 must drop legacy-file policy "${name}" on ${table} (legacy file must stay non-authoritative)`);
  }
  // the migration header documents the quarantine (no second migration, no deletion)
  assert.match(MIGRATION, /supabase_rls_policies\.sql/);
  assert.match(MIGRATION, /must NEVER be re-applied/);
});

// -----------------------------------------------
// 20. header commentary corrected (no longer claims zero pre-existing
// policies; documents the failed first apply + quarantine warning)
// -----------------------------------------------
test('migration 018 header records the failed-first-apply correction + legacy quarantine', () => {
  assert.match(MIGRATION, /CORRECTION \(Phase 3C follow-up\)/);
  assert.match(MIGRATION, /NINETEEN legacy permissive/);
  assert.match(MIGRATION, /rolled back completely/);
  assert.ok(!/NO\s+existing\s+non-service-role\s+policies/.test(MIGRATION.replace(/--[^\n]*/g, '')),
    'stale "no existing policies" claim must be gone from executable code');
});
