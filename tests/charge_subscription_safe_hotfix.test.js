'use strict';

/**
 * M2 - public.charge_subscription_safe privilege exposure.
 *
 * These are source-level guarantees around the prepared fix; the BEHAVIOUR was
 * rehearsed against a disposable PostgreSQL 16.16 (see
 * docs/security/PRODUCTION-M2-SECURITY-AUDIT.md, section G): as `anon` the RPC
 * debited a victim wallet before the fix, and was refused with
 * "permission denied for function charge_subscription_safe" after it.
 *
 * What must never regress:
 *   - the hotfix revokes PUBLIC/anon/authenticated and grants ONLY service_role;
 *   - it pins search_path with ALTER (so the function BODY is untouched);
 *   - it contains no DDL/DML against tables, and no other function is named;
 *   - migration 052 carries the identical correction, so repository history and
 *     the database cannot drift;
 *   - the verification script stays read-only and never calls the function;
 *   - the only legitimate caller is the service-role client in server.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HOTFIX = path.join(ROOT, 'docs', 'security', 'hotfix-charge-subscription-safe.sql');
const VERIFY = path.join(ROOT, 'docs', 'security', 'verify-charge-subscription-safe.sql');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '052_charge_subscription_safe_privileges.sql');
const AUDIT = path.join(ROOT, 'docs', 'security', 'PRODUCTION-M2-SECURITY-AUDIT.md');

const read = (p) => fs.readFileSync(p, 'utf8');
/** Strip SQL line comments so assertions only see executable text. */
const code = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
/**
 * Blanks out single-quoted string literals (error messages contain English
 * words such as "function is missing" or "EXECUTE grant" that must not be
 * mistaken for SQL statements).
 */
const statements = (sql) => code(sql).replace(/'(?:[^']|'')*'/g, "''");
/** True when a DDL/DML statement keyword starts a line. */
const hasStatement = (sql, words) =>
  new RegExp('^\\s*(?:' + words + ')\\b', 'im').test(statements(sql));

const SIG = 'public.charge_subscription_safe(bigint, numeric, text, text, text)';

test('the hotfix file exists and carries the exact production signature', () => {
  assert.ok(fs.existsSync(HOTFIX), 'docs/security/hotfix-charge-subscription-safe.sql must exist');
  const sql = code(read(HOTFIX));
  assert.ok(sql.includes('to_regprocedure(\'public.charge_subscription_safe(bigint,numeric,text,text,text)\')'),
    'the precondition must target the exact signature');
  for (const statement of [
    'alter function ' + SIG + '\n    set search_path = public, pg_temp;',
    'revoke all on function ' + SIG + ' from public;',
    'revoke all on function ' + SIG + ' from anon;',
    'revoke all on function ' + SIG + ' from authenticated;',
    'grant execute on function ' + SIG + ' to service_role;'
  ]) {
    assert.ok(sql.includes(statement), 'missing statement: ' + statement);
  }
});

test('the hotfix pins search_path with ALTER, never by recreating the function', () => {
  const sql = code(read(HOTFIX));
  assert.ok(/alter\s+function[\s\S]{0,200}set\s+search_path\s*=\s*public,\s*pg_temp/i.test(sql),
    'search_path must be pinned');
  assert.ok(!/create\s+(or\s+replace\s+)?function/i.test(sql),
    'the body must NOT be recreated - ALTER keeps the business logic byte-identical');
  assert.ok(!/\bdrop\s+function\b/i.test(sql), 'the hotfix must never drop the function');
});

test('the hotfix touches no table and no other function', () => {
  const sql = code(read(HOTFIX));
  const body = statements(sql).replace(/create\s+temporary\s+table[\s\S]*?;/i, '');
  for (const word of ['insert', 'update', 'delete', 'truncate', 'create', 'drop']) {
    assert.ok(!hasStatement(body, word), 'the hotfix must not start a ' + word.toUpperCase() + ' statement');
  }
  assert.ok(!/alter\s+table/i.test(body), 'no table DDL');
  // Functions explicitly named in statements (ALTER/REVOKE/GRANT ... ON FUNCTION).
  const named = [...body.matchAll(/(?:on\s+function|alter\s+function)\s+(?:public\.)?([a-z0-9_]+)/gi)]
    .map((m) => m[1].toLowerCase());
  const others = [...new Set(named)].filter((n) => n !== 'charge_subscription_safe');
  assert.deepStrictEqual(others, [], 'no other function may be named: ' + others.join(', '));
  assert.ok(named.length >= 4, 'the ACL statements must name the function explicitly');
});

test('the hotfix fails safely and verifies itself', () => {
  const sql = code(read(HOTFIX));
  assert.match(sql, /HOTFIX ABORTED: public\.charge_subscription_safe\(bigint,numeric,text,text,text\) does not exist/);
  assert.match(sql, /HOTFIX OK:/);
  for (const check of [
    'HOTFIX FAILED: the function BODY changed',
    'HOTFIX FAILED: anon can still EXECUTE',
    'HOTFIX FAILED: authenticated can still EXECUTE',
    'HOTFIX FAILED: service_role lost EXECUTE',
    'HOTFIX FAILED: search_path is not pinned'
  ]) {
    assert.ok(sql.includes(check), 'missing self-check: ' + check);
  }
  assert.match(sql, /^\s*begin;/im, 'transaction boundary required');
  assert.match(sql, /^\s*commit;/im, 'transaction boundary required');
});

test('the hotfix sweeps unexpected overloads without granting them', () => {
  const sql = code(read(HOTFIX));
  assert.match(sql, /p\.proname = 'charge_subscription_safe'/);
  assert.match(sql, /p\.oid <> v_expected/);
  assert.match(sql, /unexpected overload .* NOT granted to service_role/);
  // The grant must be unconditional only for the exact signature, never inside the sweep.
  const sweep = sql.slice(sql.indexOf('$overloads$'), sql.indexOf('$overloads$', sql.indexOf('$overloads$') + 1));
  assert.ok(!/grant\s+execute/i.test(sweep), 'the overload sweep must never GRANT');
});

test('migration 052 is the versioned twin of the hotfix and cannot drift', () => {
  assert.ok(fs.existsSync(MIGRATION), 'migration 052 must exist');
  const hot = code(read(HOTFIX));
  const mig = code(read(MIGRATION));
  for (const statement of [
    'alter function ' + SIG + '\n    set search_path = public, pg_temp;',
    'revoke all on function ' + SIG + ' from public;',
    'revoke all on function ' + SIG + ' from anon;',
    'revoke all on function ' + SIG + ' from authenticated;',
    'grant execute on function ' + SIG + ' to service_role;'
  ]) {
    assert.ok(mig.includes(statement), '052 is missing: ' + statement);
  }
  assert.match(mig, /^\s*begin;/im);
  assert.match(mig, /^\s*commit;/im);
  assert.match(mig, /052 ABORTED/, '052 must fail safely without 011');
  assert.match(mig, /052 OK/);
  assert.ok(!/create\s+(or\s+replace\s+)?function/i.test(mig), '052 must not recreate the body either');
});

test('the verification script is read-only and never calls the function', () => {
  assert.ok(fs.existsSync(VERIFY), 'the verification script must exist');
  const sql = statements(read(VERIFY));
  for (const word of ['insert', 'update', 'delete', 'truncate', 'create', 'alter', 'drop', 'grant', 'revoke', 'call']) {
    assert.ok(!hasStatement(sql, word), 'the verification must not start a ' + word.toUpperCase() + ' statement');
  }
  assert.ok(!/select\s+charge_subscription_safe\s*\(/i.test(sql), 'it must never execute the financial function');
  assert.ok(/^\s*(with|select)\b/im.test(sql), 'it must be a read-only query');
});

test('the verification script checks every fact an operator needs', () => {
  const sql = read(VERIFY);
  for (const needle of [
    'to_regprocedure',
    'has_function_privilege(\'anon\'',
    'has_function_privilege(\'authenticated\'',
    'has_function_privilege(\'service_role\'',
    'aclexplode',
    'prosecdef',
    'proconfig',
    'proowner',
    'unexpected overloads'
  ]) {
    assert.ok(sql.includes(needle), 'verification must inspect: ' + needle);
  }
  assert.match(sql, /PASS/, 'it must print a machine-readable status');
  assert.match(sql, /FAIL/, 'it must print a machine-readable status');
});

test('the only legitimate caller is the service-role client', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const calls = [...server.matchAll(/(\w+)\s*\.\s*rpc\(\s*'charge_subscription_safe'/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, 'the activation and billing paths both charge');
  assert.deepStrictEqual([...new Set(calls)], ['supabaseAdmin'],
    'the RPC must only ever be called through the service-role client, never the anon client');
  // No frontend code may call it (the browser only holds the publishable key).
  for (const rel of ['public/index.html', 'public/partners.html']) {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!html.includes('charge_subscription_safe'), rel + ' must not reference the billing RPC');
  }
});

test('the billing client is the service-role client in production (never the anon key)', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  // supabaseAdmin must be built from the service key ...
  assert.match(server, /const supabaseAdmin = createClient\(supabaseUrl, supabaseServiceKey\)/);
  // ... and production must refuse to start without it, so billing can never
  // silently run as anon once anon/authenticated lose EXECUTE.
  const guard = server.slice(server.indexOf('let supabaseServiceKey'), server.indexOf('const supabaseAdmin'));
  assert.match(guard, /process\.env\.NODE_ENV === 'production'/);
  assert.match(guard, /process\.exit\(1\)/);
  assert.match(guard, /SUPABASE_SERVICE_KEY is required in production/);
});

test('nothing in the application applies the hotfix or the migration automatically', () => {
  for (const rel of ['server.js', 'worker.js', 'conversion-worker.js', 'marketing-worker.js']) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    assert.ok(!src.includes('hotfix-charge-subscription-safe'), rel + ' must not run the hotfix');
    assert.ok(!src.includes('052_charge_subscription_safe_privileges'), rel + ' must not apply 052');
  }
});

test('the audit document records the operator-applied correction and the historical verdict', () => {
  assert.ok(fs.existsSync(AUDIT), 'docs/security/PRODUCTION-M2-SECURITY-AUDIT.md must exist');
  const doc = read(AUDIT);

  // Current production status: the operator applied the correction manually.
  assert.match(doc, /A\.1 Production status: `CLOSED - CORRECTION VERIFIED`/,
    'the verified production status must be recorded');
  for (const fact of [
    'BEFORE, `anon` could EXECUTE',
    'AFTER, `anon` can EXECUTE | **false**',
    'AFTER, `authenticated` can EXECUTE | **false**',
    'AFTER, `PUBLIC` can EXECUTE | **false**',
    'AFTER, `service_role` can EXECUTE | **true**',
    'AFTER, `search_path` | `public, pg_temp`',
    'Function signature unchanged',
    'Function owner unchanged',
    'production SQL Editor'
  ]) {
    assert.ok(doc.includes(fact), 'the production record must state: ' + fact);
  }

  // Verified vs inferred vs unknown must stay separated.
  assert.match(doc, /\*\*VERIFIED\*\* \(operator\)/, 'operator facts must be marked VERIFIED');
  assert.match(doc, /\*\*INFERRED\*\*/, 'inferences must be marked INFERRED');
  assert.match(doc, /Was the exposure ever exploited\? \| unknown/,
    'the exploitation history must stay UNKNOWN - no claim either way');
  assert.match(doc, /no claim is made either way/, 'the document must refuse to claim exploitation');

  // The historical assessment stays on the record.
  assert.match(doc, /A\.2 Historical assessment/);
  assert.match(doc, /INCONCLUSIVE - ACCESS OR EVIDENCE UNAVAILABLE/);

  // And the authoring agent still never touched production.
  assert.match(doc, /executed \*\*no\*\* production SQL/,
    'the document must record that the agent executed no production SQL');
  assert.match(doc, /migration 011/, 'it must discuss the migration state');
  assert.match(doc, /rehears/i, 'it must record the rehearsal');
});
