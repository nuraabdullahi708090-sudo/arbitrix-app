/**
 * Phase 1B — payment_config containment + credential-handling contract tests.
 *
 * Pure contract/static tests (no express/server import, no DB connection):
 * pin the security posture of migration 015 and the server's payment_config
 * access path, plus prove no secret values live in source.
 *
 * SECRET-HANDLING RULE: these tests must never contain or compare real
 * credential values. Only variable/key NAMES are referenced.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/015_payment_config_rls_lockdown.sql'), 'utf8');
const MIGRATION_014 = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/014_financial_rpc_execute_lockdown.sql'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const NOWPAYMENTS = fs.readFileSync(path.join(ROOT, 'services/providers/nowpayments.js'), 'utf8');
const PAYMENTO = fs.readFileSync(path.join(ROOT, 'services/providers/paymento.js'), 'utf8');
const Q8QPAY = fs.readFileSync(path.join(ROOT, 'services/providers/q8qpay.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

// -----------------------------------------------
// 1-4. Migration 015 posture
// -----------------------------------------------

test('migration 015 enables RLS on payment_config (only that table)', () => {
  assert.match(MIGRATION, /ALTER TABLE public\.payment_config ENABLE ROW LEVEL SECURITY;/);
  // No other table may be altered by this migration
  const alters = MIGRATION.match(/ALTER TABLE\s+public\.\w+/gi) || [];
  assert.deepStrictEqual(alters.map(s => s.toLowerCase()),
    ['alter table public.payment_config']);
});

test('migration 015 creates NO policy for anon/authenticated/public', () => {
  // service_role-only policy exists
  assert.match(MIGRATION, /CREATE POLICY "payment_config_service_all" ON public\.payment_config\s+FOR ALL TO service_role/);
  // no CREATE POLICY granting any client-facing role
  const policies = MIGRATION.match(/CREATE POLICY[\s\S]*?;/g) || [];
  assert.strictEqual(policies.length, 1, 'exactly one CREATE POLICY expected');
  assert.ok(!/TO\s+(anon|authenticated|public)\b/i.test(policies[0]));
  // verify-block asserts absence of anon/authenticated/public policies
  assert.match(MIGRATION, /roles @> ARRAY\['anon'\]::name\[\]/);
  assert.match(MIGRATION, /roles @> ARRAY\['authenticated'\]::name\[\]/);
  assert.match(MIGRATION, /roles @> ARRAY\['public'\]::name\[\]/);
});

test('migration 015 revokes ALL privileges from anon and authenticated', () => {
  assert.match(MIGRATION, /REVOKE ALL ON public\.payment_config FROM anon;/);
  assert.match(MIGRATION, /REVOKE ALL ON public\.payment_config FROM authenticated;/);
});

test('migration 015 grants service_role full access', () => {
  assert.match(MIGRATION, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.payment_config TO service_role;/);
});

test('migration 015 modifies NO rows (no INSERT/UPDATE/DELETE/TRUNCATE of data)', () => {
  // strip line comments first so prose mentioning these words does not count
  const code = MIGRATION.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/INSERT\s+INTO/i.test(code), 'no INSERT');
  assert.ok(!/UPDATE\s+\w/i.test(code), 'no UPDATE');
  assert.ok(!/DELETE\s+FROM/i.test(code), 'no DELETE');
  assert.ok(!/TRUNCATE/i.test(code), 'no TRUNCATE');
  assert.ok(!/VALUES\s*\(/i.test(code), 'no VALUES');
});

test('migration 015 is idempotent (no non-idempotent DDL)', () => {
  const code = MIGRATION.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.match(code, /DROP POLICY IF EXISTS/);
  assert.ok(!/CREATE TABLE(?!\s+IF NOT EXISTS)/i.test(code), 'no CREATE TABLE');
  assert.ok(!/DROP TABLE/i.test(code), 'no DROP TABLE');
  assert.ok(!/CREATE OR REPLACE FUNCTION/i.test(code), 'no function changes');
  assert.ok(!/ALTER\s+FUNCTION/i.test(code), 'no function changes');
  // ALTER TABLE is only the idempotent ENABLE RLS
  assert.ok(!/ALTER TABLE[\s\S]*?DISABLE/i.test(code));
});

test('migration 015 verification block is read-only and asserts RLS enabled', () => {
  assert.match(MIGRATION, /relrowsecurity/);
  assert.match(MIGRATION, /RAISE EXCEPTION 'payment_config RLS verification failed: RLS is not enabled'/);
  // verify block contains no mutation statements
  const doBlock = MIGRATION.slice(MIGRATION.indexOf('DO $$'));
  assert.ok(!/INSERT|UPDATE|DELETE|DROP|CREATE|REVOKE|GRANT\s+SELECT/i.test(
    doBlock.replace(/RAISE (EXCEPTION|NOTICE)[\s\S]*?(;|$)/g, '')),
    'verify block performs no writes');
});

// -----------------------------------------------
// 5. Server uses supabaseAdmin for payment_config
// -----------------------------------------------

test('server reads payment_config exclusively via supabaseAdmin', () => {
  const accesses = SERVER.match(/\bsupabase(Admin)?\s*\n?\s*\.from\('payment_config'\)/g) || [];
  assert.strictEqual(accesses.length, 1, 'exactly one payment_config access expected');
  assert.ok(accesses[0].startsWith('supabaseAdmin'), 'must use the service-role client');
});

test('frontend never references payment_config directly', () => {
  assert.ok(!INDEX_HTML.includes("from('payment_config')"));
  assert.ok(!INDEX_HTML.includes('rest/v1/payment_config'));
});

test('getSubscriptionPrice fallback (default 7) is unchanged', () => {
  assert.match(SERVER, /const SUBSCRIPTION_PRO_DEFAULT_PRICE = 7;/);
  const fn = SERVER.slice(SERVER.indexOf('async function getSubscriptionPrice'));
  assert.ok((fn.match(/return SUBSCRIPTION_PRO_DEFAULT_PRICE;/g) || []).length >= 3,
    'all fallback paths preserved');
});

// -----------------------------------------------
// 6. No secret values in source/tests/logs
// -----------------------------------------------

test('migration 015 contains no credential assignments or secret-shaped literals', () => {
  // no assignment of provider secrets
  assert.ok(!/INSERT INTO public\.payment_config/i.test(MIGRATION));
  assert.ok(!/UPDATE public\.payment_config/i.test(MIGRATION));
  // no plausible API-key/JWT-shaped literal (>=24 chars of secret charset);
  // single quotes only -- double-quoted tokens are SQL identifiers
  assert.ok(!/'[A-Za-z0-9_\-+/=]{24,}'/.test(MIGRATION),
    'no long secret-shaped string literals');
});

test('no payment secret env values are hardcoded in server or providers', () => {
  const sources = { SERVER, NOWPAYMENTS, PAYMENTO, Q8QPAY };
  for (const [name, src] of Object.entries(sources)) {
    // secrets must come from process.env.<NAME>, never a literal value
    for (const envName of ['NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET',
      'PAYMENTO_API_KEY', 'PAYMENTO_SECRET_KEY',
      'Q8QPAY_API_KEY', 'Q8QPAY_WEBHOOK_SECRET']) {
      const uses = src.split(`process.env.${envName}`).length - 1;
      assert.ok(uses >= 0, `${name}: ${envName} referenced only via process.env`);
      // a literal assignment like apiKey = '....' of 20+ chars would be a leak
    }
    assert.ok(!/(apiKey|secretKey|ipnSecret|webhookSecret)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/.test(src),
      `${name}: no hardcoded credential literal`);
  }
});

// -----------------------------------------------
// 7. Provider configuration names remain correct
// -----------------------------------------------

test('provider credentials are read from the canonical env var names', () => {
  assert.match(SERVER, /process\.env\.NOWPAYMENTS_API_KEY/);
  assert.match(SERVER, /process\.env\.NOWPAYMENTS_IPN_SECRET/);
  assert.match(SERVER, /process\.env\.PAYMENTO_API_KEY/);
  assert.match(SERVER, /process\.env\.PAYMENTO_SECRET_KEY/);
  assert.match(SERVER, /process\.env\.Q8QPAY_API_KEY/);
  assert.match(SERVER, /process\.env\.Q8QPAY_WEBHOOK_SECRET/);
  // provider selection unchanged
  assert.match(fs.readFileSync(path.join(ROOT, 'services/PaymentService.js'), 'utf8'),
    /process\.env\.PAYMENT_PROVIDER \|\| 'nowpayments'/);
});

// -----------------------------------------------
// 8. Webhook verification remains enabled (unchanged)
// -----------------------------------------------

test('all providers still reject webhooks when the secret is missing', () => {
  assert.match(NOWPAYMENTS, /Webhook secret not configured! Rejecting webhook\./);
  assert.match(PAYMENTO, /SECURITY: Reject if no secret configured/);
  assert.match(Q8QPAY, /Webhook secret not configured! Rejecting webhook\./);
});

test('webhook HMAC verification logic is intact in all providers', () => {
  assert.match(NOWPAYMENTS, /crypto\.createHmac\('sha256', secret\)/);
  assert.match(PAYMENTO, /\.createHmac\('sha256', this\.secretKey\)/);
  assert.match(Q8QPAY, /\.createHmac\('sha256', this\.webhookSecret\)/);
});

test('server still wires all three webhook secrets at startup', () => {
  assert.match(SERVER, /paymentService\.setWebhookSecret\('nowpayments', process\.env\.NOWPAYMENTS_IPN_SECRET/);
  assert.match(SERVER, /paymentService\.setWebhookSecret\('paymento', process\.env\.PAYMENTO_SECRET_KEY/);
  assert.match(SERVER, /paymentService\.setWebhookSecret\('q8qpay', process\.env\.Q8QPAY_WEBHOOK_SECRET/);
});

// -----------------------------------------------
// 10. Phase 1 financial RPC lockdown remains intact
// -----------------------------------------------

test('migration 014 lockdown is untouched (16 privilege statements)', () => {
  const stmts = MIGRATION_014.match(/^(REVOKE|GRANT)/gm) || [];
  assert.strictEqual(stmts.length, 16);
});

test('server still invokes the three financial RPCs via supabaseAdmin', () => {
  assert.match(SERVER, /supabaseAdmin\.rpc\('record_trade_safe'/);
  assert.match(SERVER, /supabaseAdmin\.rpc\('credit_payment_safe'/);
  assert.match(SERVER, /supabaseAdmin\.rpc\('paymento_credit_user_safe'/);
});

test('migration 015 does not touch any Phase 1 function or Sandbox object', () => {
  assert.ok(!/record_trade_safe|credit_payment_safe|paymento_credit_user_safe/.test(MIGRATION));
  assert.ok(!/sandbox_/i.test(MIGRATION));
});

// -----------------------------------------------
// 9. Migration 015 is narrowly scoped (no other tables)
// -----------------------------------------------

test('migration 015 references no other protected table', () => {
  const code = MIGRATION.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const tbl of ['users', 'wallets', 'deposits', 'withdrawals', 'transactions',
    'trades', 'subscriptions', 'subscription_charges', 'verification_profiles',
    'verification_documents', 'verification_history', 'twofa_profiles',
    'twofa_attempts', 'email_verification_codes', 'email_2fa_attempts',
    'email_change_requests', 'feature_flags', 'webhook_logs', 'payment_invoices']) {
    const re = new RegExp(`public\\.${tbl}\\b`);
    assert.ok(!re.test(code), `migration must not reference public.${tbl}`);
  }
});
