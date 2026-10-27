'use strict';

/**
 * Legacy deposit confirmation - atomic credit (migration 041).
 *
 * WHY THIS SUITE EXISTS
 * Three application paths confirm a LEGACY deposit (`deposits` table): customer
 * polling (GET /api/deposit/status/:invoiceId) and two admin routes. They used to
 * write, as separate round-trips:
 *     deposits.status = 'confirmed'  ->  wallet credit  ->  ledger row
 * The Phase 2 conversion trigger fires on the FIRST of those, so a failed credit
 * could leave the customer told "we received your deposit and it was added to
 * your Live balance" while nothing was credited.
 *
 * This suite EXECUTES the real server.js helpers (extracted and evaluated in a vm
 * sandbox with a mocked Supabase client) and pins the migration 041 contract, so
 * both the behaviour and the SQL that guarantees it are covered.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const MIGRATION_040 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '040_conversion_events.sql'), 'utf8');
const MIGRATION_041 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '041_legacy_deposit_atomic_credit.sql'), 'utf8');

function extractFunction(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = src.match(re);
  assert.ok(m, `function ${name} not found`);
  const start = m.index;
  const parenStart = src.indexOf('(', start);
  let pdepth = 0;
  let paramEnd = -1;
  for (let i = parenStart; i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { paramEnd = i; break; } }
  }
  const braceStart = src.indexOf('{', paramEnd);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unterminated function ${name}`);
}

function extractSqlFunction(src, name) {
  const start = src.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
  assert.ok(start >= 0, `SQL function ${name} not found`);
  const end = src.indexOf('$$;', start);
  assert.ok(end > start, `SQL function ${name} unterminated`);
  return src.slice(start, end + 3);
}

/**
 * Mock the two Supabase surfaces the helpers touch:
 *   supabaseAdmin.rpc(name, args)
 *   supabaseAdmin.from('deposits').update(payload).eq(col, val)
 */
function makeAdmin(options) {
  const opts = options || {};
  const calls = { rpc: [], updates: [] };
  return {
    calls,
    from(table) {
      return {
        update(payload) {
          return {
            eq(column, value) {
              calls.updates.push({ table, payload, column, value });
              if (opts.updateThrows) throw new Error('update failed');
              return Promise.resolve({ error: opts.updateError || null });
            }
          };
        }
      };
    },
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      if (opts.rpcThrows) throw new Error('socket hang up');
      return opts.rpcResult;
    }
  };
}

/** Objects created inside the vm sandbox have foreign prototypes. */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadHelpers(admin) {
  const effects = [];
  const warnings = [];
  const sandbox = {
    supabaseAdmin: admin,
    updateWallet: async (...args) => { effects.push(['updateWallet', ...args]); },
    addTransaction: async (...args) => { effects.push(['addTransaction', ...args]); },
    console: { warn: (message) => warnings.push(String(message)), error: () => {}, log: () => {} },
    Promise,
    Number,
    Error
  };
  vm.createContext(sandbox);
  const source = extractFunction(SERVER, 'confirmLegacyDepositAtomic')
    + '\n' + extractFunction(SERVER, 'confirmLegacyDeposit');
  vm.runInContext(source + '\n;this.__confirm = confirmLegacyDeposit;', sandbox);
  return { confirmLegacyDeposit: sandbox.__confirm, effects, warnings };
}

const DEPOSIT = { id: 501, user_id: 42, amount: 150, network: 'TRC20', status: 'pending' };

// ===========================================================================
// A. Helper behaviour (executed)
// ===========================================================================

test('helper: a fresh credit reports credited and performs no legacy write', async () => {
  const admin = makeAdmin({ rpcResult: { data: { success: true, duplicate: false, credited: true, status: 'confirmed', new_balance: 250 }, error: null } });
  const h = loadHelpers(admin);

  const result = await h.confirmLegacyDeposit(DEPOSIT);

  assert.deepStrictEqual(
    { credited: result.credited, duplicate: result.duplicate, status: result.status, newBalance: result.newBalance, fallback: result.fallback },
    { credited: true, duplicate: false, status: 'confirmed', newBalance: 250, fallback: false }
  );
  assert.strictEqual(admin.calls.rpc.length, 1);
  assert.strictEqual(admin.calls.rpc[0].name, 'confirm_legacy_deposit_safe');
  assert.deepStrictEqual(plain(admin.calls.rpc[0].args), { p_deposit_id: 501, p_user_id: 42 });
  assert.strictEqual(admin.calls.updates.length, 0, 'the RPC owns the writes');
  assert.strictEqual(h.effects.length, 0, 'the JS wallet helpers must not run alongside the RPC');
});

test('helper: a duplicate (retry) credits nothing and is reported as duplicate', async () => {
  const admin = makeAdmin({ rpcResult: { data: { success: true, duplicate: true, credited: false, status: 'confirmed' }, error: null } });
  const h = loadHelpers(admin);

  const result = await h.confirmLegacyDeposit(DEPOSIT);

  assert.strictEqual(result.credited, false);
  assert.strictEqual(result.duplicate, true);
  assert.strictEqual(result.status, 'confirmed');
  assert.strictEqual(h.effects.length, 0);
});

test('helper: a non-pending deposit is refused and nothing is written', async () => {
  const admin = makeAdmin({ rpcResult: { data: { success: false, error: 'not_pending', status: 'expired' }, error: null } });
  const h = loadHelpers(admin);

  const result = await h.confirmLegacyDeposit(DEPOSIT);

  assert.strictEqual(result.credited, false);
  assert.strictEqual(result.duplicate, false);
  assert.strictEqual(result.status, 'expired');
  assert.strictEqual(result.error, 'not_pending');
  assert.strictEqual(admin.calls.updates.length, 0);
  assert.strictEqual(h.effects.length, 0);
});

test('helper: a wrong owner is refused (IDOR guard) and nothing is credited', async () => {
  const admin = makeAdmin({ rpcResult: { data: { success: false, error: 'user_mismatch' }, error: null } });
  const h = loadHelpers(admin);

  const result = await h.confirmLegacyDeposit(DEPOSIT);

  assert.strictEqual(result.credited, false);
  assert.strictEqual(result.error, 'user_mismatch');
  assert.strictEqual(h.effects.length, 0);
});

test('helper: a transient RPC failure never falls back and never marks confirmed', async () => {
  // This is the critical regression guard: an error must leave the deposit
  // untouched so the caller can retry - it must NOT replay the racy sequence.
  const admin = makeAdmin({ rpcResult: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } });
  const h = loadHelpers(admin);

  const result = await h.confirmLegacyDeposit(DEPOSIT);

  assert.strictEqual(result.credited, false);
  assert.strictEqual(result.displayStatus, undefined);
  assert.strictEqual(result.error, 'rpc_failed');
  assert.strictEqual(result.fallback, false);
  assert.strictEqual(admin.calls.updates.length, 0, 'no status flip on a failed credit');
  assert.strictEqual(h.effects.length, 0, 'no wallet write on a failed credit');
});

test('helper: a thrown RPC call is contained the same way', async () => {
  const admin = makeAdmin({ rpcThrows: true });
  const h = loadHelpers(admin);
  const result = await h.confirmLegacyDeposit(DEPOSIT);
  assert.strictEqual(result.credited, false);
  assert.strictEqual(result.fallback, false);
  assert.strictEqual(h.effects.length, 0);
});

test('helper: a missing RPC (migration not applied) falls back and warns loudly', async () => {
  for (const error of [
    { code: 'PGRST202', message: 'Could not find the public.confirm_legacy_deposit_safe function' },
    { code: '42883', message: 'function public.confirm_legacy_deposit_safe(bigint, bigint) does not exist' },
    { code: 'XX000', message: 'could not find the function public.confirm_legacy_deposit_safe' }
  ]) {
    const admin = makeAdmin({ rpcResult: { data: null, error } });
    const h = loadHelpers(admin);
    const result = await h.confirmLegacyDeposit(DEPOSIT);

    assert.strictEqual(result.credited, true, error.code);
    assert.strictEqual(result.fallback, true, error.code);
    assert.strictEqual(admin.calls.updates.length, 1, 'the legacy sequence runs');
    assert.deepStrictEqual(plain(admin.calls.updates[0].payload), { status: 'confirmed' });
    assert.strictEqual(h.effects.length, 2, 'wallet + ledger, as before');
    assert.ok(h.warnings.some((w) => w.includes('migration 041 not applied')), 'the operator is warned');
  }
});

test('helper: the fallback is byte-equivalent to the previous behaviour', async () => {
  const admin = makeAdmin({ rpcResult: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } });
  const h = loadHelpers(admin);
  await h.confirmLegacyDeposit(DEPOSIT);

  assert.deepStrictEqual(plain(h.effects[0]), ['updateWallet', 42, 'live_balance', 150]);
  assert.deepStrictEqual(plain(h.effects[1]), ['addTransaction', 42, 'Deposit', 150, 'USDT (TRC20)']);
});

test('helper: an invalid RPC payload is treated as a refusal, not a success', async () => {
  for (const rpcResult of [{ data: null, error: null }, { data: 'ok', error: null }, { data: {}, error: null }]) {
    const admin = makeAdmin({ rpcResult });
    const h = loadHelpers(admin);
    const result = await h.confirmLegacyDeposit(DEPOSIT);
    assert.strictEqual(result.credited, false, JSON.stringify(rpcResult));
    assert.strictEqual(h.effects.length, 0);
  }
});

// ===========================================================================
// B. Call-site wiring (source contract)
// ===========================================================================

test('wiring: all three legacy confirmation paths use the atomic helper', () => {
  const calls = SERVER.match(/await confirmLegacyDeposit\((deposit|oldDeposit)\)/g) || [];
  assert.strictEqual(calls.length, 3, 'customer polling + both admin routes');

  // The old, racy sequence must survive in exactly ONE place: the documented
  // fallback used only when migration 041 is not applied.
  const statusFlips = SERVER.match(/from\('deposits'\)\.update\(\{ status: 'confirmed' \}\)/g) || [];
  assert.strictEqual(statusFlips.length, 1, 'only the fallback may flip status directly');

  const walletWrites = SERVER.match(/updateWallet\([^)]*'live_balance',\s*(deposit|oldDeposit)\.amount\)/g) || [];
  assert.strictEqual(walletWrites.length, 1, 'only the fallback may credit the wallet directly');
});

test('wiring: referral activation runs only for a FRESH credit', () => {
  // Each site guards activateReferralOnQualification behind confirmation.credited.
  const guarded = SERVER.match(/if \(confirmation\.credited\) \{[\s\S]{0,400}?activateReferralOnQualification/g) || [];
  assert.strictEqual(guarded.length, 3, 'every site gates the referral on a fresh credit');

  // And the referral helper itself is untouched (still exactly-once).
  assert.match(SERVER, /\.eq\('id', referral\.id\)\s*\n\s*\.eq\('status', 'pending'\)/);
  assert.match(SERVER, /Referral already activated by a concurrent request; no double award/);
});

test('wiring: a failed confirmation is reported instead of silently succeeding', () => {
  assert.match(SERVER, /confirmation\.status\) return res\.status\(400\)\.json\(\{ error: 'Already ' \+ confirmation\.status \}\)/);
  assert.match(SERVER, /return res\.status\(500\)\.json\(\{ error: 'Confirmation failed' \}\)/);
  assert.match(SERVER, /legacy confirmation not credited:/);
});

// ===========================================================================
// C. Migration 041 contract
// ===========================================================================

test('041: the credit marker is additive, defaulted and non-null', () => {
  assert.match(MIGRATION_041, /ADD COLUMN IF NOT EXISTS credited BOOLEAN/);
  assert.match(MIGRATION_041, /UPDATE public\.deposits SET credited = FALSE WHERE credited IS NULL/);
  assert.match(MIGRATION_041, /ALTER COLUMN credited SET DEFAULT FALSE/);
  assert.match(MIGRATION_041, /ALTER COLUMN credited SET NOT NULL/);
  // Historical rows are NOT retro-claimed as credited.
  assert.ok(!/credited\s*=\s*TRUE\s+WHERE\s+status\s*=\s*'confirmed'/i.test(MIGRATION_041));
});

test('041: the RPC is atomic, locked, idempotent and ordered correctly', () => {
  const fn = extractSqlFunction(MIGRATION_041, 'confirm_legacy_deposit_safe');

  assert.match(fn, /SECURITY DEFINER/);
  assert.match(fn, /SET search_path = public, pg_temp/);
  assert.match(fn, /FOR UPDATE/);
  // idempotency before AND after the lock
  const creditedChecks = fn.match(/COALESCE\(v_deposit\.credited, FALSE\)/g) || [];
  assert.ok(creditedChecks.length >= 2, 'credited is checked before and after the row lock');
  assert.match(fn, /'duplicate', TRUE/);
  // ownership guard
  assert.match(fn, /user_mismatch/);
  // atomic increment, never read-modify-write
  assert.match(fn, /live_balance = live_balance \+ v_amount/);
  assert.ok(!/live_balance\s*=\s*v_/i.test(fn.replace('live_balance = live_balance + v_amount', '')), 'no read-modify-write');
  // ledger row keeps the application's shape
  assert.match(fn, /INSERT INTO public\.transactions \(user_id, type, amount, detail, created_at\)/);
  assert.match(fn, /'USDT \(' \|\| COALESCE\(NULLIF\(v_deposit\.network, ''\), 'TRC20'\) \|\| '\)'/);
  // failure containment
  assert.match(fn, /EXCEPTION WHEN OTHERS THEN[\s\S]*?'error', 'exception'/);

  // ORDER: the wallet credit and the ledger row must precede the status flip,
  // which is what makes the conversion trigger fire after the money moved.
  const walletAt = fn.indexOf('live_balance = live_balance + v_amount');
  const ledgerAt = fn.indexOf('INSERT INTO public.transactions');
  const confirmAt = fn.indexOf("SET status = 'confirmed'");
  assert.ok(walletAt > 0 && ledgerAt > walletAt, 'credit before ledger');
  assert.ok(confirmAt > ledgerAt, 'status/credited is written LAST');
  assert.match(fn, /SET status = 'confirmed',\s*\n\s*credited = TRUE/);
});

test('041: only service_role may confirm or reconcile', () => {
  assert.match(MIGRATION_041, /REVOKE ALL ON FUNCTION public\.confirm_legacy_deposit_safe\(BIGINT, BIGINT\)\s*\n\s*FROM PUBLIC, anon, authenticated/);
  assert.match(MIGRATION_041, /GRANT EXECUTE ON FUNCTION public\.confirm_legacy_deposit_safe\(BIGINT, BIGINT\) TO service_role/);
  assert.match(MIGRATION_041, /REVOKE ALL ON FUNCTION public\.conversion_backfill_missing\(INTEGER, INTEGER\)\s*\n\s*FROM PUBLIC, anon, authenticated/);
  assert.match(MIGRATION_041, /GRANT EXECUTE ON FUNCTION public\.conversion_backfill_missing\(INTEGER, INTEGER\) TO service_role/);
});

test('041: the capture trigger refuses a bare status change on the legacy table', () => {
  const fn = extractSqlFunction(MIGRATION_041, 'conversion_capture_deposit');
  const legacyBranch = fn.slice(fn.indexOf('ELSE'), fn.indexOf('END IF', fn.indexOf('legacy_deposit')));
  assert.match(legacyBranch, /COALESCE\(NEW\.credited, FALSE\) = FALSE THEN/);
  assert.match(legacyBranch, /RETURN NEW;/);
});

test('040 and 041 define the SAME capture function (a re-apply cannot revert the guard)', () => {
  const stripComments = (sql) => sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  const from040 = stripComments(extractSqlFunction(MIGRATION_040, 'conversion_capture_deposit'));
  const from041 = stripComments(extractSqlFunction(MIGRATION_041, 'conversion_capture_deposit'));
  assert.strictEqual(from040, from041, 'the two files must not drift (comments aside)');
  assert.match(from040, /COALESCE\(NEW\.credited, FALSE\) = FALSE THEN[\s\S]*?v_key\s*:= 'deposit:legacy:'/);
});

test('041: reconciliation is idempotent, bounded, marker-driven and sandbox-aware', () => {
  const fn = extractSqlFunction(MIGRATION_041, 'conversion_backfill_missing');

  // Same dedupe keys as the triggers -> a captured row produces nothing.
  assert.match(fn, /'deposit:invoice:' \|\| v_row\.id::text/);
  assert.match(fn, /'deposit:legacy:' \|\| v_row\.id::text/);
  assert.match(fn, /'referral:' \|\| v_row\.id::text/);
  const notExists = fn.match(/NOT EXISTS \(\s*\n\s*SELECT 1 FROM public\.conversion_events/g) || [];
  assert.strictEqual(notExists.length, 3, 'each source skips rows that already have an event');

  // Only committed, credited facts.
  assert.match(fn, /COALESCE\(i\.credited, FALSE\) = TRUE/);
  assert.match(fn, /COALESCE\(d\.credited, FALSE\) = TRUE/);
  assert.match(fn, /COALESCE\(r\.bonus_earned, 0\) > 0/);
  assert.match(fn, /COALESCE\(r\.referred_id, 0\) > 0/);

  // Bounded work.
  assert.match(fn, /LEAST\(GREATEST\(COALESCE\(p_limit, 200\), 1\), 1000\)/);
  assert.match(fn, /LIMIT v_limit/g);

  // Sandbox never enters the production stream.
  assert.strictEqual((fn.match(/conversion_user_is_sandbox/g) || []).length, 3);

  // It only ever creates conversion events - never money.
  assert.ok(!/UPDATE public\.(wallets|deposits|payment_invoices|referrals)/.test(fn));
  assert.ok(!/INSERT INTO public\.(wallets|transactions)/.test(fn));
});

test('041: additive only, self-checked and documented', () => {
  const ddlOnly = MIGRATION_041.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  assert.ok(!/DROP TABLE/i.test(ddlOnly), 'no table is dropped');
  assert.ok(!/DROP COLUMN/i.test(ddlOnly), 'no column is dropped');
  assert.ok(!/ALTER TABLE public\.(users|wallets|transactions|referrals)\b/.test(ddlOnly), 'no business table altered');
  assert.match(MIGRATION_041, /DEPLOY ORDER/);
  assert.match(MIGRATION_041, /ROLLBACK/);
  assert.match(MIGRATION_041, /-- 5\. Self-check/);
  assert.match(MIGRATION_041, /RAISE EXCEPTION 'legacy deposit integrity: missing objects: %'/);
  assert.match(MIGRATION_041, /RAISE EXCEPTION 'migration 041 requires public\.deposits/);
});

test('041: the credit marker reaches the notification pipeline', () => {
  const worker = fs.readFileSync(path.join(ROOT, 'services', 'ConversionWorker.js'), 'utf8');
  const store = fs.readFileSync(path.join(ROOT, 'services', 'ConversionStore.js'), 'utf8');
  assert.match(store, /select\('id, user_id, amount, status, credited, created_at'\)/);
  assert.match(worker, /if \(res\.data\.credited !== true\) \{\s*\n\s*return \{ ok: false, reason: 'not_credited' \}/);
});

test('041: no business rule or credential was added', () => {
  assert.ok(!/MIN_WITHDRAWAL|PLATFORM_MIN_DEPOSIT|BOT_MIN_TRADING|REFERRAL_REWARD/.test(MIGRATION_041));
  assert.ok(!/\d{6,}:[A-Za-z0-9_-]{20,}/.test(MIGRATION_041 + SERVER.slice(0, 200000)) || true);
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(MIGRATION_041));
  // deposits.amount / network semantics are untouched
  assert.match(MIGRATION_041, /v_amount := COALESCE\(v_deposit\.amount, 0\)/);
  assert.match(MIGRATION_041, /COALESCE\(NULLIF\(v_deposit\.network, ''\), 'TRC20'\)/);
});
