'use strict';

/**
 * Phase 1 — Emergency Financial RPC EXECUTE lockdown contract tests.
 *
 * Security context: the three financial SECURITY DEFINER functions
 *   - public.record_trade_safe
 *   - public.credit_payment_safe
 *   - public.paymento_credit_user_safe   (5-arg AND 8-arg overloads)
 * were executable by PUBLIC / anon / authenticated via PostgREST. Migration
 * supabase/migrations/014_financial_rpc_execute_lockdown.sql revokes EXECUTE
 * from PUBLIC/anon/authenticated and grants it to service_role only.
 *
 * These tests pin the security contract WITHOUT touching the database:
 *   1. The migration targets the EXACT function signatures defined in the
 *      earlier migrations (006/007/008/009) — no guessed/wildcard signatures.
 *   2. For every exact signature: REVOKE from PUBLIC + anon + authenticated,
 *      GRANT to service_role.
 *   3. The Express server invokes all three RPCs EXCLUSIVELY via the
 *      service-role client (supabaseAdmin) — the lockdown cannot break the
 *      production server path.
 *   4. Containment purity: the migration contains NO CREATE OR REPLACE
 *      FUNCTION (bodies/logic untouched), no table/RLS/policy changes, no
 *      data mutations, and does not touch any sandbox RPC.
 *   5. The migration is idempotent (REVOKE/GRANT + read-only verify block).
 *
 * Run: npm test
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/014_financial_rpc_execute_lockdown.sql'),
  'utf8'
);
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// Strip SQL line comments so comment text cannot satisfy a pattern.
const SQL = MIGRATION.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

// The exact signatures as defined in migrations 006/007/008/009.
// DECIMAL resolves to pg_catalog numeric in pg_get_function_identity_arguments,
// but REVOKE/GRANT accept the declared DECIMAL alias.
const SIGNATURES = [
  ['record_trade_safe', '(BIGINT, DECIMAL, TEXT, TEXT, TEXT, TEXT)'],
  ['credit_payment_safe', '(BIGINT, BIGINT, DECIMAL, TEXT, TEXT, TEXT)'],
  ['paymento_credit_user_safe', '(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER)'],
  ['paymento_credit_user_safe', '(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER, TEXT, TEXT, INTEGER)'],
];

function stmt(fn, args, action, role) {
  // Escape the literal parentheses of the signature for regex use.
  const escapedArgs = args.replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  return new RegExp(
    `${action} EXECUTE ON FUNCTION public\\.${fn}${escapedArgs} ${action === 'REVOKE' ? 'FROM' : 'TO'} ${role}\\b`,
    'i'
  );
}

// ---------- 1. Exact signatures: REVOKE PUBLIC/anon/authenticated ----------

for (const [fn, args] of SIGNATURES) {
  test(`migration revokes EXECUTE from PUBLIC for ${fn}${args}`, () => {
    assert.ok(stmt(fn, args, 'REVOKE', 'PUBLIC').test(SQL), `missing REVOKE ... FROM PUBLIC for ${fn}${args}`);
  });

  test(`migration revokes EXECUTE from anon for ${fn}${args}`, () => {
    assert.ok(stmt(fn, args, 'REVOKE', 'anon').test(SQL), `missing REVOKE ... FROM anon for ${fn}${args}`);
  });

  test(`migration revokes EXECUTE from authenticated for ${fn}${args}`, () => {
    assert.ok(stmt(fn, args, 'REVOKE', 'authenticated').test(SQL), `missing REVOKE ... FROM authenticated for ${fn}${args}`);
  });

  test(`migration grants EXECUTE to service_role for ${fn}${args}`, () => {
    assert.ok(stmt(fn, args, 'GRANT', 'service_role').test(SQL), `missing GRANT ... TO service_role for ${fn}${args}`);
  });
}

// ---------- 2. Signatures match the actual function definitions ----------

test('record_trade_safe signature matches migration 009 definition', () => {
  const def = fs.readFileSync(path.join(ROOT, 'supabase/migrations/009_trades_persistence.sql'), 'utf8');
  const m = def.match(/CREATE OR REPLACE FUNCTION public\.record_trade_safe\(([\s\S]*?)\)/);
  assert.ok(m, 'record_trade_safe definition not found in 009');
  const params = m[1].replace(/\s+/g, ' ');
  for (const t of ['p_user_id BIGINT', 'p_amount DECIMAL', 'p_idempotency_key TEXT', "p_mode TEXT DEFAULT 'live'", 'p_asset TEXT', 'p_detail TEXT']) {
    assert.ok(params.includes(t), `009 definition missing param: ${t}`);
  }
});

test('credit_payment_safe signature matches migration 008 definition', () => {
  const def = fs.readFileSync(path.join(ROOT, 'supabase/migrations/008_q8qpay_support.sql'), 'utf8');
  const m = def.match(/CREATE OR REPLACE FUNCTION public\.credit_payment_safe\(([\s\S]*?)\)/);
  assert.ok(m, 'credit_payment_safe definition not found in 008');
  const params = m[1].replace(/\s+/g, ' ');
  for (const t of ['p_invoice_id BIGINT', 'p_user_id BIGINT', 'p_amount_usd DECIMAL', 'p_transaction_hash TEXT', 'p_provider_invoice_id TEXT', 'p_provider_name TEXT']) {
    assert.ok(params.includes(t), `008 definition missing param: ${t}`);
  }
});

test('paymento_credit_user_safe 5-arg overload matches migration 006 definition', () => {
  const def = fs.readFileSync(path.join(ROOT, 'supabase/migrations/006_paymento_support.sql'), 'utf8');
  const m = def.match(/CREATE OR REPLACE FUNCTION public\.paymento_credit_user_safe\(([\s\S]*?)\)/);
  assert.ok(m, 'paymento_credit_user_safe definition not found in 006');
  const params = m[1].replace(/\s+/g, ' ');
  for (const t of ['p_invoice_id BIGINT', 'p_user_id BIGINT', 'p_amount_usd DECIMAL', 'p_provider_payment_id BIGINT', 'p_provider_status_code INTEGER']) {
    assert.ok(params.includes(t), `006 definition missing param: ${t}`);
  }
  assert.ok(!params.includes('p_settlement_address'), '006 definition unexpectedly has 8-arg params');
});

test('paymento_credit_user_safe 8-arg overload matches migration 007 definition', () => {
  const def = fs.readFileSync(path.join(ROOT, 'supabase/migrations/007_paymento_settlement_audit.sql'), 'utf8');
  const m = def.match(/CREATE OR REPLACE FUNCTION public\.paymento_credit_user_safe\(([\s\S]*?)\)/);
  assert.ok(m, 'paymento_credit_user_safe definition not found in 007');
  const params = m[1].replace(/\s+/g, ' ');
  for (const t of ['p_settlement_address TEXT', 'p_provider_tx_hash TEXT', 'p_provider_confirmations INTEGER']) {
    assert.ok(params.includes(t), `007 definition missing param: ${t}`);
  }
});

// ---------- 3. Server invocation path: service-role only ----------

test('server invokes all 3 financial RPCs exclusively via supabaseAdmin (service-role)', () => {
  for (const fn of ['record_trade_safe', 'credit_payment_safe', 'paymento_credit_user_safe']) {
    assert.ok(SERVER.includes(`supabaseAdmin.rpc('${fn}'`), `server.js must call ${fn} via supabaseAdmin`);
    // No invocation through the anon client (supabase.rpc without the Admin suffix).
    const anonCall = new RegExp(`(?<!Admin)\\.rpc\\('${fn}'`).test(SERVER.replace(/supabaseAdmin\.rpc/g, ''));
    assert.ok(!anonCall, `${fn} must NOT be invoked through the anon client`);
  }
});

test('server passes only the 5-arg params to paymento_credit_user_safe (5-arg overload is the live server path)', () => {
  const idx = SERVER.indexOf("supabaseAdmin.rpc('paymento_credit_user_safe'");
  assert.ok(idx > 0);
  const call = SERVER.slice(idx, idx + 500);
  for (const p of ['p_invoice_id', 'p_user_id', 'p_amount_usd', 'p_provider_payment_id', 'p_provider_status_code']) {
    assert.ok(call.includes(p), `paymento call missing param ${p}`);
  }
  for (const p of ['p_settlement_address', 'p_provider_tx_hash', 'p_provider_confirmations']) {
    assert.ok(!call.includes(p), `paymento call unexpectedly passes ${p}`);
  }
});

// ---------- 4. Containment purity ----------

test('migration does NOT modify any function body (no CREATE OR REPLACE FUNCTION)', () => {
  assert.ok(!/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(SQL), 'migration must not define/replace any function');
  assert.ok(!/ALTER\s+FUNCTION/i.test(SQL), 'migration must not ALTER FUNCTION (attributes/body unchanged)');
});

test('migration does NOT touch tables, RLS, policies, or data', () => {
  for (const forbidden of [
    /CREATE\s+TABLE/i, /DROP\s+TABLE/i, /ALTER\s+TABLE/i,
    /ROW\s+LEVEL\s+SECURITY/i, /CREATE\s+POLICY/i, /DROP\s+POLICY/i,
    /\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i,
  ]) {
    assert.ok(!forbidden.test(SQL), `migration contains forbidden statement: ${forbidden}`);
  }
});

test('migration does NOT touch sandbox RPCs or any non-scoped function', () => {
  // Only actual privilege STATEMENTS (line-initial REVOKE/GRANT) count; the
  // verify block's RAISE NOTICE text names the scoped functions, which is fine.
  const privilegeLines = SQL.split('\n').filter((l) => /^\s*(REVOKE|GRANT)\s+EXECUTE/i.test(l));
  const targets = privilegeLines.map((l) => l.match(/FUNCTION\s+public\.(\w+)/i)[1]);
  const allowed = new Set(['record_trade_safe', 'credit_payment_safe', 'paymento_credit_user_safe']);
  assert.ok(targets.length === 16, `expected exactly 16 privilege statements (4 signatures x 4), got ${targets.length}`);
  for (const t of targets) {
    assert.ok(allowed.has(t), `migration unexpectedly touches function: ${t}`);
  }
  assert.ok(!/sandbox_/i.test(SQL), 'migration must not reference sandbox functions/tables');
});

// ---------- 5. Idempotency & verification block ----------

test('migration uses only idempotent privilege statements plus a read-only verify block', () => {
  // Split off the trailing DO $$ ... $$; verify block (it is one statement
  // whose PL/pgSQL body legitimately contains many semicolons).
  const doIdx = SQL.search(/^\s*DO\s+\$\$/im);
  assert.ok(doIdx > 0, 'migration must end with a DO $$ verify block');
  const privilegePart = SQL.slice(0, doIdx);
  const doBlock = SQL.slice(doIdx);
  // Before the DO block: ONLY REVOKE/GRANT statements, each one line.
  const statements = privilegePart.split(';').map((s) => s.trim()).filter(Boolean);
  assert.ok(statements.length === 16, `expected 16 privilege statements, got ${statements.length}`);
  for (const s of statements) {
    assert.ok(/^(REVOKE|GRANT)\b/i.test(s), `unexpected non-idempotent statement: ${s.slice(0, 80)}`);
    assert.ok(!/\n\s*\S/.test(s.replace(/^\s*(REVOKE|GRANT)[^\n]*\n?/i, '')), 'privilege statements must be single-line');
  }
  // The DO block must be read-only: no writes to any table.
  for (const forbidden of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bREVOKE\b/i, /\bGRANT\s+EXECUTE\b/i]) {
    assert.ok(!forbidden.test(doBlock), `verify block must be read-only, found: ${forbidden}`);
  }
  assert.ok(/END\s+\$\$\s*;\s*$/.test(doBlock), 'DO block must be the final statement');
});

test('verify block asserts PUBLIC/anon/authenticated denied and service_role granted per exact signature', () => {
  assert.ok(/acl\.privilege_type = 'EXECUTE'/.test(SQL), 'verify block must inspect EXECUTE privileges');
  assert.ok(/r\.rolname IN \('anon', 'authenticated'\)/.test(SQL), 'verify block must check anon+authenticated');
  assert.ok(/acl\.grantee = 0\s+-- PUBLIC/.test(SQL) || /acl\.grantee = 0/.test(SQL), 'verify block must check PUBLIC (grantee 0)');
  assert.ok(/r\.rolname = 'service_role'/.test(SQL), 'verify block must require service_role EXECUTE');
  assert.ok(/RAISE EXCEPTION/.test(SQL), 'verify block must fail the migration on drift');
  // All 4 exact identity-argument signatures must be enumerated in the verify block.
  for (const argtypes of [
    'bigint,numeric,text,text,text,text',
    'bigint,bigint,numeric,text,text,text',
    'bigint,bigint,numeric,bigint,integer',
    'bigint,bigint,numeric,bigint,integer,text,text,integer',
  ]) {
    assert.ok(SQL.includes(`'${argtypes}'`), `verify block missing identity args: ${argtypes}`);
  }
});
