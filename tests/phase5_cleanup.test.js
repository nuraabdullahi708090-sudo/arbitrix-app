/**
 * Phase 5 cleanup — low-risk security cleanup contract tests.
 *
 * Pure static/contract tests (no express/server import, no DB connection):
 *
 *   1. The obsolete unauthenticated bootstrap routes
 *      POST /api/setup/reset-tokens-table and POST /api/debug/create-table
 *      are removed from server.js (their required RPCs no longer exist and
 *      they had no callers), together with their dead helper code
 *      (ensureResetTokensTable / createResetTokensTable).
 *   2. GET /api/diagnostic (publicly exposed a real user id + Node/runtime
 *      and Supabase project info) is removed. A full-repo search confirmed
 *      no application/test/documentation dependency, so removal (not
 *      admin-gating) is the chosen remediation.
 *   3. Password-reset functionality itself is untouched: the real routes
 *      (/api/auth/forgot-password, /api/auth/reset-password) and helpers
 *      (generateResetToken/hashToken) remain.
 *   4. No frontend or server code references the removed routes.
 *   5. supabase_rls_policies.sql carries a prominent QUARANTINED header and
 *      its legacy SQL content is byte-identical apart from that header.
 *   6. Migrations 014-018 (and 001) are untouched (sha256 pinned).
 *
 * Run: npm test
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const LEGACY_SQL = fs.readFileSync(path.join(ROOT, 'supabase_rls_policies.sql'), 'utf8');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

// -----------------------------------------------
// 1. Obsolete setup/debug routes removed
// -----------------------------------------------
test('obsolete POST /api/setup/reset-tokens-table route is removed', () => {
  assert.ok(!SERVER.includes('/api/setup/reset-tokens-table'),
    'server.js must not define or reference the obsolete setup route');
});

test('obsolete POST /api/debug/create-table route is removed', () => {
  assert.ok(!SERVER.includes('/api/debug/create-table'),
    'server.js must not define or reference the obsolete debug route');
});

test('dead bootstrap helpers are removed with the routes', () => {
  assert.ok(!SERVER.includes('ensureResetTokensTable'),
    'dead helper ensureResetTokensTable must be removed');
  assert.ok(!SERVER.includes('createResetTokensTable'),
    'dead helper createResetTokensTable must be removed');
  assert.ok(!SERVER.includes('create_password_reset_tokens_table'),
    'call to the non-existent RPC must be gone');
  assert.ok(!SERVER.includes('rpc/exec_sql'),
    'call to the non-existent exec_sql RPC must be gone');
});

// -----------------------------------------------
// 2. /api/diagnostic removed (no longer publicly accessible)
// -----------------------------------------------
test('GET /api/diagnostic is removed (no longer publicly accessible)', () => {
  assert.ok(!SERVER.includes('/api/diagnostic'),
    'server.js must not define or reference /api/diagnostic');
});

// -----------------------------------------------
// 3. Password-reset functionality itself is untouched
// -----------------------------------------------
test('password-reset routes and helpers remain intact', () => {
  assert.match(SERVER, /app\.post\('\/api\/auth\/forgot-password'/);
  assert.match(SERVER, /app\.post\('\/api\/auth\/reset-password'/);
  assert.match(SERVER, /function generateResetToken\(\)/);
  assert.match(SERVER, /function hashToken\(token\)/);
});

// -----------------------------------------------
// 4. No frontend/server/script references to removed routes
// -----------------------------------------------
test('no repository code references the removed endpoints', () => {
  const REMOVED = ['/api/setup/reset-tokens-table', '/api/debug/create-table', '/api/diagnostic'];
  const scanDirs = ['public', 'scripts', 'services'];
  const offenders = [];
  for (const dir of scanDirs) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of listFiles(abs)) {
      if (/node_modules/.test(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      for (const route of REMOVED) {
        if (content.includes(route)) offenders.push(`${file}: ${route}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    'no frontend/script/service code may reference removed routes: ' + offenders.join(', '));
});

// -----------------------------------------------
// 5. Legacy policy file quarantined; SQL content unchanged apart from header
// -----------------------------------------------
test('supabase_rls_policies.sql has a prominent quarantine header', () => {
  const head = LEGACY_SQL.split('\n').slice(0, 30).join('\n');
  assert.match(head, /QUARANTINED/);
  assert.match(head, /DO NOT APPLY TO PRODUCTION/);
  assert.match(head, /HISTORICAL LEGACY/i);
  assert.match(head, /TO anon/);
  assert.match(head, /018/);
  assert.match(head, /MUST NOT BE EXECUTED AGAINST PRODUCTION/);
});

test('quarantine header is comment-only (no SQL added before the original header)', () => {
  const marker = '-- Supabase Row Level Security Policies for Arbitrix App';
  const idx = LEGACY_SQL.indexOf(marker);
  assert.ok(idx > 0, 'original legacy header must still be present');
  const prefix = LEGACY_SQL.slice(0, idx);
  const nonCommentLines = prefix.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('--'));
  assert.deepStrictEqual(nonCommentLines, [],
    'everything added before the original header must be SQL comments only');
});

test('legacy SQL content is byte-identical apart from the quarantine header', () => {
  const marker = '-- ============================================================\n-- Supabase Row Level Security Policies for Arbitrix App';
  const idx = LEGACY_SQL.indexOf(marker);
  assert.ok(idx > 0, 'original legacy header must still be present');
  const body = LEGACY_SQL.slice(idx);
  assert.strictEqual(sha256(body),
    '6e736b2d2b8a2800c78240803a96d79d9c06e2116861f1aaa7f3d65d86514e79',
    'the legacy SQL below the quarantine header must be unchanged');
  // Structural sanity: the 19 legacy permissive anon policies are still there
  // (the file is quarantined, NOT edited).
  const policyCreates = body.match(/CREATE POLICY /g) || [];
  assert.strictEqual(policyCreates.length, 19, '19 legacy CREATE POLICY statements expected');
  const anonTargets = body.match(/TO anon/g) || [];
  assert.strictEqual(anonTargets.length, 19, 'all 19 legacy policies target TO anon');
});

// -----------------------------------------------
// 6. Migrations 014-018 (and 001) untouched — sha256 pinned
// -----------------------------------------------
const PINNED_MIGRATIONS = {
  'supabase/migrations/001_create_password_reset_tokens.sql':
    '6dec207601803e49c98384615a78b420fd13cf463c1dbdf4946a26dfc4ab6b3e',
  'supabase/migrations/014_financial_rpc_execute_lockdown.sql':
    '703b0ca2fc787f591b637ee13686ffe4771ee9424ecad2887f3b32a4cc7f3759',
  'supabase/migrations/015_payment_config_rls_lockdown.sql':
    'ccfaf6c381e6f2e04da131201999f1093587c360d180449a5307b6c7a93fc236',
  'supabase/migrations/016_auth_security_rls_lockdown.sql':
    '182ccfb8f4b22322f0ec0668750a0fd3f551819be3d9d12d339ff0ee54fd51a5',
  'supabase/migrations/017_kyc_privilege_lockdown.sql':
    'a312bc4f4a80aa1cea2580d01dc62ccffe619326fad2bed2be21e6c6af97d262',
  'supabase/migrations/018_financial_tables_rls_lockdown.sql':
    '15dfc7bc67e56f1dbf1098bdf7acab7a1c91bdea0184c72c0744f0230b4adb4b',
  'migrations/001_create_password_reset_tokens.sql':
    '8a02593f98a845708618788b7a5a7b822baa4143e5d20b2d9c6bb35c5b39f859',
};

for (const [file, expected] of Object.entries(PINNED_MIGRATIONS)) {
  test(`migration untouched (sha256 pinned): ${file}`, () => {
    const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.strictEqual(sha256(content), expected,
      `${file} must not be modified by this cleanup`);
  });
}

// -----------------------------------------------
// 7. Guard: no NEW unauthenticated setup/debug/diagnostic-style routes
// -----------------------------------------------
test('no setup/debug/diagnostic routes of any kind remain registered', () => {
  const registrations = SERVER.match(/app\.(get|post|put|delete|patch)\('([^']+)'/g) || [];
  const bad = registrations.filter((r) =>
    /'\/api\/(setup|debug|diagnostic)/.test(r));
  assert.deepStrictEqual(bad, [],
    'no /api/setup*, /api/debug*, or /api/diagnostic* routes may remain: ' + bad.join(', '));
});
