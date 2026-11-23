'use strict';

/**
 * Optional verification tool for migration 056 (users.email uniqueness).
 *
 * Executes the REAL migration file against PostgreSQL compiled to WebAssembly
 * (PGlite) and checks the pre-flight against the exact scope of the unique index:
 *
 *   - NULL emails never conflict (any number allowed);
 *   - '' and whitespace-only values are ordinary non-NULL keys, so two IDENTICAL
 *     ones must be refused by the pre-flight (not by a raw index error);
 *   - '' and '   ' are different strings and therefore do not conflict;
 *   - case-only differences conflict;
 *   - the migration is idempotent.
 *
 * It does NOT run in CI and adds no dependency: install the engine out of tree
 * when you want to run it:
 *
 *   npm install --no-save @electric-sql/pglite
 *   node scripts/verify-migration-056.js
 *
 * Exit codes: 0 = every case behaved as expected, 1 = a case failed,
 *             2 = the verification engine is not installed.
 *
 * The tool never touches a real database. PGlite creates an in-memory instance
 * per case and closes it.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations', '056_users_email_unique.sql');

/**
 * Each case: [name, emails, expectation].
 * expectation 'ok'     -> the migration applies and the index exists
 * expectation 'refuse' -> the PRE-FLIGHT raises (message mentions no row changed)
 */
const CASES = [
  ['no rows', [], 'ok'],
  ['apply twice (idempotency)', [], 'ok'],
  ['normal distinct addresses', ['a@x.test', 'b@x.test'], 'ok'],
  ['two NULL addresses (never conflict)', [null, null], 'ok'],
  ['empty + NULL + plain', ['', null, 'a@x.test'], 'ok'],
  ['empty vs whitespace (distinct strings)', ['', '   '], 'ok'],
  ['leading-space vs plain (distinct strings)', ['a@x.test', ' a@x.test'], 'ok'],
  ['two empty-string addresses', ['', ''], 'refuse'],
  ['three empty-string addresses', ['', '', ''], 'refuse'],
  ['two identical whitespace-only addresses', ['   ', '   '], 'refuse'],
  ['case-only duplicate', ['A@x.test', 'a@x.test'], 'refuse'],
  ['padded vs plain address (distinct strings)', [' A@x.test ', 'a@x.test'], 'ok'],
  ['two identical padded addresses', [' A@x.test ', ' A@x.test '], 'refuse'],
  ['duplicate blank AND duplicate address', ['', '', 'A@x.test', 'a@x.test'], 'refuse']
];

async function main() {
  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (e) {
    console.error('The verification engine is not installed.');
    console.error('Run: npm install --no-save @electric-sql/pglite');
    console.error('(no package.json / lockfile change is needed or wanted)');
    process.exit(2);
  }

  const fileArgument = process.argv.indexOf('--file');
  const migrationPath = fileArgument !== -1 ? process.argv[fileArgument + 1] : DEFAULT_MIGRATION;
  const sql = fs.readFileSync(migrationPath, 'utf8');

  let failures = 0;
  const width = Math.max.apply(null, CASES.map(function (c) { return c[0].length; })) + 2;

  for (const [name, emails, expectation] of CASES) {
    const db = new PGlite();
    try {
      await db.exec('create table public.users (id bigserial primary key, email text);');
      for (const email of emails) {
        await db.query('insert into public.users (email) values ($1)', [email]);
      }

      let outcome;
      let detail = '';
      try {
        await db.exec(sql);
        // Idempotency is part of the contract: a second run must be a no-op.
        await db.exec(sql);
        const index = await db.query(
          "select indexname from pg_indexes where indexname = 'users_email_lower_unique'"
        );
        const rows = await db.query('select count(*)::int as n from public.users');
        outcome = index.rows.length === 1 ? 'ok' : 'failed';
        detail = index.rows.length === 1
          ? 'index present, ' + rows.rows[0].n + ' row(s) untouched'
          : 'index MISSING';
      } catch (e) {
        const message = String(e.message);
        const guarded = message.indexOf('cannot enforce uniqueness') !== -1 &&
          message.indexOf('No row was changed') !== -1;
        outcome = guarded ? 'refuse' : 'failed';
        detail = guarded ? message.split('\n')[0] : message.split('\n')[0];
      }

      const passed = outcome === expectation;
      if (!passed) failures += 1;
      console.log((passed ? 'PASS ' : 'FAIL ') + name.padEnd(width) + expectation.padEnd(8) + detail);
    } catch (e) {
      failures += 1;
      console.log('FAIL ' + name.padEnd(width) + 'harness error: ' + e.message);
    } finally {
      await db.close();
    }
  }

  console.log('');
  if (failures === 0) {
    console.log('All ' + CASES.length + ' cases behaved as expected.');
    process.exit(0);
  }
  console.log(failures + ' of ' + CASES.length + ' cases FAILED.');
  process.exit(1);
}

main().catch(function (e) {
  console.error('verification failed:', e);
  process.exit(1);
});
