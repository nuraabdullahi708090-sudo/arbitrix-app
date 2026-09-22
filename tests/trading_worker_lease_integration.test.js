// Post-audit integration fixes for the server-side trading worker.
//
// These pin the properties the read-only audit found missing, so a later edit
// cannot silently re-introduce them:
//   1. ONE source of truth for the executor-staleness window (web guard + worker).
//   2. A LIVE migration-029 lease counts as ownership for its whole duration,
//      not merely while a heartbeat is fresh.
//   3. /api/bot/start cannot inherit stale lease/heartbeat state from a previous
//      worker run.
//   4. The residual browser-vs-worker race is closed in the DATABASE, with a
//      fail-open, PRODUCTION-ONLY, sandbox-skipping guard (migration 031).
//   5. public.bot_sessions.user_id uniqueness is recorded in a migration (030).
//   6. Lease observability without leaking any credential.
//
// Migration 031 was ALSO executed against a real PostgreSQL 16.15 server (a
// throwaway Docker container, never staging/production) together with migration
// 030. Observed, with the trigger armed:
//   no session row / running+no lease / running+expired lease / stopped row /
//   lease expiry == now()            -> INSERT allowed
//   running + ACTIVE lease + browser key (`trade_<uid>_...`)
//                                    -> refused: WORKER_OWNED_SESSION
//   running + ACTIVE lease + the worker's own key (`bot_<uid>_live_0_<bucket>`)
//                                    -> allowed
//   running + ACTIVE lease + `bot_<OTHER uid>_...`  -> refused
//   MARKETING_SANDBOX + ACTIVE lease + browser key  -> allowed
//   lease column dropped (029 absent)               -> allowed (fail open)
//   record_trade_safe-shaped txn (wallet UPDATE then trades INSERT) refused
//                                    -> balance UNCHANGED and no ledger row
//   same call once the lease is cleared -> succeeds (no permanent poisoning)
// Migration 030: created bot_sessions_user_id_unique where absent, made the
// ON CONFLICT (user_id) upsert work, was a no-op on re-run, and on a database
// with duplicate user_id rows failed loudly with the row count while changing
// nothing (no index created, no rows deleted).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SERVER = read('server.js');
const WORKER_SRC = read('services/TradingWorker.js');
const WORKER_ENTRY = read('worker.js');
const WORKER_CONFIG = read('services/WorkerConfig.js');
const ENV_EXAMPLE = read('.env.example');
const MIG_028 = read('supabase/migrations/028_trading_worker.sql');
const MIG_029 = read('supabase/migrations/029_bot_session_lease.sql');
const MIG_030 = read('supabase/migrations/030_bot_sessions_unique_user_id.sql');
const MIG_031 = read('supabase/migrations/031_single_executor_trade_guard.sql');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Same helper the other worker tests use: assertions about what the CODE does must
// not be satisfied or broken by a comment (e.g. a comment recording that a
// constant was removed).
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const SERVER_CODE = stripComments(SERVER);

/** Executable SQL only: drop whole-line `--` comments (the files are comment-heavy). */
function stripSql(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .map((line) => line.replace(/\s--.*$/, ''))
    .join('\n');
}

// ==========================================================================
// 0. The already-applied migrations are untouched
// ==========================================================================
test('migrations 028 and 029 are byte-identical to the reviewed/approved versions', () => {
  assert.strictEqual(sha256(MIG_028), 'e711af83e21cbb7dd53495b94685a74b8fe8897a651ff3a47b87f394246ef0dc');
  assert.strictEqual(Buffer.byteLength(MIG_028), 8224);
  assert.strictEqual(MIG_028.split('\n').length, 166); // 165 lines + trailing newline element
  assert.strictEqual(sha256(MIG_029), 'f566fa51a7c0a13ce314ee7fd4af71ae721b516d5c22c3f5658243e22d7ceb8a');
  assert.strictEqual(Buffer.byteLength(MIG_029), 21306);
  assert.strictEqual(MIG_029.split('\n').length, 450);
});

// ==========================================================================
// 1. One source of truth for the executor-staleness window
// ==========================================================================
test('the staleness window is defined once and resolved by both processes', () => {
  assert.match(WORKER_CONFIG, /const DEFAULT_STALE_HEARTBEAT_MS = 60000;/);
  assert.match(WORKER_CONFIG, /function resolveStaleHeartbeatMs\(/);
  assert.strictEqual((WORKER_CONFIG.match(/\b60000\b/g) || []).length, 1,
    'exactly one numeric definition of the window');

  // TradingWorker's own default must not be a second literal.
  assert.match(WORKER_SRC, /require\('\.\/WorkerConfig'\)/);
  assert.match(WORKER_SRC, /staleHeartbeatMs: DEFAULT_STALE_HEARTBEAT_MS/);
  assert.ok(!/staleHeartbeatMs:\s*\d+/.test(WORKER_SRC));

  // The worker process resolves it through the shared module (not envNumber).
  assert.match(WORKER_ENTRY, /require\('\.\/services\/WorkerConfig'\)/);
  assert.match(WORKER_ENTRY, /staleHeartbeatMs: resolveStaleHeartbeatMs\(\)/);
  assert.ok(!/envNumber\('TRADING_STALE_HEARTBEAT_MS'/.test(WORKER_ENTRY));

  // The web service resolves it through the same module.
  assert.match(SERVER, /require\('\.\/services\/WorkerConfig'\)/);
  assert.match(SERVER, /const WORKER_STALE_HEARTBEAT_MS = resolveStaleHeartbeatMs\(\);/);
  assert.ok(!/const WORKER_STALE_HEARTBEAT_MS = \d+;/.test(SERVER));

  // Both report the RESOLVED value at runtime, so a one-sided env var is visible.
  assert.match(WORKER_SRC, /log\('worker_started', \{[\s\S]{0,200}?staleHeartbeatMs: cfg\.staleHeartbeatMs/);
  assert.match(SERVER, /staleHeartbeatMs: WORKER_STALE_HEARTBEAT_MS/);

  // And the operator-facing docs state the both-services-or-neither rule.
  assert.ok(ENV_EXAMPLE.includes('TRADING_STALE_HEARTBEAT_MS'));
  assert.match(ENV_EXAMPLE, /on BOTH services/);
});

// ==========================================================================
// 2. A LIVE lease is ownership (not just a fresh heartbeat)
// ==========================================================================
test('the /api/trade guard treats an ACTIVE lease as ownership', () => {
  const guard = SERVER.slice(SERVER.indexOf('function hasActiveWorkerLease'), SERVER.indexOf('async function getWorkerStatus'));
  assert.match(guard, /if \(!row \|\| !row\.claimed_by\) return false;/);
  assert.match(guard, /row\.lease_expires_at \? Date\.parse\(row\.lease_expires_at\) : NaN/);
  assert.match(guard, /return expiry > now;/);
  // The lease is checked FIRST; the heartbeat is the fallback signal.
  const fn = SERVER.slice(SERVER.indexOf('async function isWorkerOwnedSession'));
  const leaseAt = fn.indexOf('hasActiveWorkerLease(data)');
  const heartbeatAt = fn.indexOf('data.heartbeat_at');
  assert.ok(leaseAt > 0 && heartbeatAt > leaseAt, 'the lease must be checked before the heartbeat');
  assert.match(fn, /\.select\('is_running, heartbeat_at, claimed_by, lease_expires_at'\)/);
  // Still fail-open, and still keyed off the authenticated user only.
  assert.match(fn, /fallback: 'treat_as_browser_owned'/);
  assert.match(fn, /return false;/);
});

test('the SAME lease predicate drives the admin view and the start path (no second definition)', () => {
  const status = SERVER.slice(SERVER.indexOf('async function getWorkerStatus'), SERVER.indexOf('async function getWorkerStatus') + 3200);
  // Exactly ONE definition of "an active lease" in the web service; every
  // consumer calls it instead of testing the columns itself.
  assert.strictEqual((SERVER.match(/function hasActiveWorkerLease\(/g) || []).length, 1);
  assert.match(status, /const leaseActive = hasActiveWorkerLease\(s, now\);/);
  assert.match(SERVER.slice(SERVER.indexOf("app.post('/api/bot/start'")), /hasActiveWorkerLease\(currentSession\)/);
  assert.match(SERVER.slice(SERVER.indexOf('async function isWorkerOwnedSession')), /if \(hasActiveWorkerLease\(data\)\) return true;/);
});

// ==========================================================================
// 3. A restart cannot inherit stale lease/heartbeat state
// ==========================================================================
test('/api/bot/start clears STALE executor state and preserves a LIVE lease', () => {
  const route = SERVER.slice(SERVER.indexOf("app.post('/api/bot/start'"), SERVER.indexOf("app.post('/api/bot/stop'"));
  const start = route.indexOf('let hasLiveWorkerLease = false;');
  assert.ok(start > 0, 'start must not blindly overwrite executor state');
  const block = route.slice(start, route.indexOf("upsert(sessionState, { onConflict: 'user_id' })", start));
  // It reads the current row first and only clears when no LIVE lease exists:
  // clearing an active lease would hand the session to this tab while the worker
  // still considers itself its executor.
  assert.match(block, /\.select\('claimed_by, lease_expires_at'\)/);
  assert.match(block, /hasLiveWorkerLease = hasActiveWorkerLease\(currentSession\);/);
  assert.match(block, /if \(!hasLiveWorkerLease\) \{/);
  const guarded = block.slice(block.indexOf('if (!hasLiveWorkerLease) {'));
  for (const cleared of ['claimed_by = null', 'lease_acquired_at = null', 'lease_expires_at = null', 'heartbeat_at = null']) {
    assert.ok(guarded.includes(cleared), 'stale ' + cleared.replace(' = null', '') + ' must be cleared');
  }
  assert.match(block, /is_running: 1/);
  assert.match(block, /stopped_reason: null/);
  // `generation` is bumped on STOP by migration 029, never rewritten here.
  assert.ok(!/generation/.test(block), 'start must not rewrite the generation');
  // The platform-wide kill switch is still evaluated before the write.
  assert.ok(route.indexOf('getWorkerControl()') < route.indexOf('let hasLiveWorkerLease'),
    'the emergency-stop check must come first');
  assert.match(route, /code: 'TRADING_PAUSED'/);
  // A failed session write must not be silent: the route used to answer
  // "started" while persisting nothing (e.g. 42P10 when the unique index is
  // absent). The response shape stays unchanged; only an error log is added.
  assert.match(route, /if \(sessionError\) \{/);
  assert.match(route, /event: 'bot_session_start_failed'/);
  assert.match(route, /res\.json\(\{ status: 'started', mode \}\);/);
});

// ==========================================================================
// 4. The database backstop (migration 031)
// ==========================================================================
test('031 is a single BEFORE INSERT ROW trigger on public.trades', () => {
  const sql = stripSql(MIG_031);
  assert.match(sql, /CREATE TRIGGER trg_enforce_single_executor_trade\s+BEFORE INSERT ON public\.trades\s+FOR EACH ROW/);
  assert.strictEqual((sql.match(/CREATE TRIGGER/g) || []).length, 1);
  assert.match(sql, /EXECUTE FUNCTION public\.enforce_single_executor_trade\(\)/);
  assert.match(sql, /DROP TRIGGER IF EXISTS trg_enforce_single_executor_trade ON public\.trades;/,
    'idempotent re-run');
  assert.ok(!/CREATE TRIGGER IF NOT EXISTS/.test(sql));
});

test('031 is additive and idempotent: no schema/table change, no data write', () => {
  const sql = stripSql(MIG_031);
  assert.match(sql, /CREATE OR REPLACE FUNCTION/);
  assert.ok(!/\bCREATE TABLE\b/i.test(sql));
  assert.ok(!/\bALTER TABLE\b/i.test(sql));
  assert.ok(!/\bDROP TABLE\b/i.test(sql));
  assert.ok(!/\bDROP COLUMN\b/i.test(sql));
  assert.ok(!/\bINSERT\s+INTO\b/i.test(sql));
  assert.ok(!/\bUPDATE\s+public\./i.test(sql));
  assert.ok(!/\bDELETE\s+FROM\b/i.test(sql));
  assert.ok(!/\bTRUNCATE\b/i.test(sql));
  // The trailing self-check must be present and must be able to fail the apply.
  assert.match(sql, /IF NOT EXISTS \([\s\S]{0,400}?enforce_single_executor_trade[\s\S]{0,600}?RAISE EXCEPTION/);
  assert.match(sql, /tgname = 'trg_enforce_single_executor_trade' AND NOT tgisinternal/);
});

test('031 FAILS OPEN: the refusal is raised OUTSIDE the exception handler', () => {
  const sql = stripSql(MIG_031);
  const handlerAt = sql.indexOf('EXCEPTION WHEN OTHERS THEN');
  const raiseAt = sql.indexOf("RAISE EXCEPTION 'WORKER_OWNED_SESSION'");
  const endAt = sql.indexOf('END;', sql.indexOf('RETURN NEW;   -- fail open'));
  assert.ok(handlerAt > 0 && raiseAt > handlerAt, 'the refusal must not sit inside the handler');
  assert.ok(endAt > 0 && endAt < raiseAt,
    'the RAISE must come after the handler block closes - a RAISE inside it would be swallowed and the guard would silently never fire');
  // The decision is made inside, the raise happens outside (fail-open property).
  assert.match(sql, /v_block\s+BOOLEAN := FALSE;/);
  assert.match(sql, /v_block := TRUE;/);
  assert.match(sql, /IF v_block THEN/);
});

test('031 admits the worker\'s own key and refuses everything else', () => {
  const sql = stripSql(MIG_031);
  // R5 - the worker namespace, matched on the literal `bot_<uid>_` prefix.
  assert.match(sql, /NEW\.idempotency_key LIKE 'bot\\_' \|\| NEW\.user_id::text \|\| '\\_%' ESCAPE '\\'/);

  // The admitted namespace must be exactly what the worker really generates.
  const { buildTickIdempotencyKey } = require('../services/TradingWorker');
  const workerKey = buildTickIdempotencyKey(1, 'live', 7, 1234567);
  assert.match(workerKey, /^bot_1_/, 'worker key namespace drifted from migration 031');

  // ...and the browser/API namespace must NOT be admitted. This is the literal
  // fallback /api/trade uses when the client supplies no key.
  assert.match(SERVER, /`trade_\$\{userId\}_\$\{Date\.now\(\)\}_\$\{Math\.random\(\)/);
  const { buildTickIdempotencyKey: b } = require('../services/TradingWorker');
  // A worker key for a DIFFERENT user must not be admitted either (prefix match,
  // not substring: user 1 must not be satisfied by user 12's key).
  const otherUserKey = b(12, 'live', 7, 1234567);
  const isAdmitted = (uid, key) => new RegExp('^bot_' + uid + '_').test(key);
  assert.strictEqual(isAdmitted(1, workerKey), true);
  assert.strictEqual(isAdmitted(1, 'trade_1_1758200000000_ab12'), false);
  assert.strictEqual(isAdmitted(1, otherUserKey), false);
});

test('031 skips MARKETING_SANDBOX and treats a NULL/expired lease as inactive', () => {
  const sql = stripSql(MIG_031);
  assert.match(sql, /IF v_env = 'MARKETING_SANDBOX' THEN/);
  assert.match(sql, /RETURN NEW;/);
  // R4 must mirror migration 029's own claimability predicate.
  assert.match(sql, /IF v_claimed_by IS NULL OR v_lease_exp IS NULL OR v_lease_exp <= now\(\) THEN/);
  assert.match(sql, /IF COALESCE\(v_is_running, 0\) <> 1 THEN/);
  assert.match(sql, /v_env := 'PRODUCTION';/);
});

test('031 contains NO financial logic (it never reads a balance or an amount)', () => {
  // Scoped to the plpgsql BODY, not the file: the COMMENT ON text below it
  // legitimately *describes* that it reads no balance.
  const bodyStart = MIG_031.indexOf('AS $$');
  const body = MIG_031.slice(bodyStart, MIG_031.indexOf('$$;', bodyStart));
  assert.ok(body.length > 500, 'function body not located');
  for (const forbidden of ['live_balance', 'demo_balance', 'bonus_balance', 'wallets', 'transactions', 'amount']) {
    assert.ok(!body.includes(forbidden), 'the guard must not touch ' + forbidden);
  }
  assert.ok(!/payment|deposit|withdraw|referral|subscription|kyc/i.test(body));
});

test('the app never applies migrations itself (030/031 are operator-applied)', () => {
  for (const file of [SERVER, WORKER_ENTRY, WORKER_SRC]) {
    assert.ok(!file.includes('030_bot_sessions_unique_user_id'));
    assert.ok(!file.includes('031_single_executor_trade_guard'));
  }
});

// ==========================================================================
// 5. public.bot_sessions.user_id uniqueness (migration 030)
// ==========================================================================
test('030 records the unique user_id requirement idempotently and safely', () => {
  const sql = stripSql(MIG_030);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS bot_sessions_user_id_unique\s+ON public\.bot_sessions \(user_id\);/);
  assert.match(sql, /COMMENT ON INDEX public\.bot_sessions_user_id_unique IS/);
  // Additive: it must not create the table, alter it, or touch data.
  assert.ok(!/\bCREATE TABLE\b/i.test(sql));
  assert.ok(!/\bALTER TABLE\b/i.test(sql));
  assert.ok(!/\bDROP TABLE\b/i.test(sql));
  assert.ok(!/\bINSERT\s+INTO\b/i.test(sql));
  assert.ok(!/\bUPDATE\s+public\./i.test(sql));
  assert.ok(!/\bDELETE\s+FROM\b/i.test(sql));
  // Duplicate rows must abort with the count, never be silently deleted.
  assert.match(sql, /HAVING COUNT\(\*\) > 1/);
  assert.match(sql, /RAISE EXCEPTION 'Migration 030 cannot create bot_sessions_user_id_unique: % user_id value\(s\)/);
  assert.ok(!/\bDELETE\b/i.test(sql), '030 must never delete rows');
  // Self-check asserts BOTH existence and uniqueness.
  assert.match(sql, /indexname = 'bot_sessions_user_id_unique'/);
  assert.match(sql, /i\.indisunique IS TRUE/);
});

// ==========================================================================
// 6. Observability, without leaking a credential
// ==========================================================================
test('lease state is observable from /api/bot/status and the admin worker view', () => {
  const status = SERVER.slice(SERVER.indexOf("app.get('/api/bot/status'"), SERVER.indexOf('// ---------- Admin: server-side trading worker control'));
  for (const field of ['claimedBy', 'leaseAcquiredAt', 'leaseExpiresAt', 'generation']) {
    assert.ok(status.includes(field + ':'), '/api/bot/status must expose ' + field);
  }
  assert.ok(/\bleaseActive\b/.test(status), '/api/bot/status must expose leaseActive');
  const admin = SERVER.slice(SERVER.indexOf('async function getWorkerStatus'), SERVER.indexOf('async function getWorkerStatus') + 3200);
  assert.match(admin, /leasedCount: withHeartbeat\.filter\(\(s\) => s\.leaseActive\)\.length/);
  assert.match(admin, /claimedBy: s\.claimed_by \|\| null/);
  assert.match(admin, /generation: Number\(s\.generation \|\| 0\)/);
  // claimed_by is an internal instance id - never a token/secret/email.
  assert.match(SERVER, /internal worker instance id/);
});

// ==========================================================================
// 7. The worker stays disabled, and the shared window did not become a knob
// ==========================================================================
test('the worker is still inert unless explicitly enabled', () => {
  assert.match(WORKER_ENTRY, /const enabled = envFlag\('TRADING_WORKER_ENABLED'\);/);
  assert.match(WORKER_ENTRY, /event: 'worker_disabled'/);
  // Nothing in the repository enables it as a default.
  for (const file of [ENV_EXAMPLE, SERVER]) {
    assert.ok(!/TRADING_WORKER_ENABLED\s*[:=]\s*['"]?true/i.test(file), 'the worker must not be enabled by default');
  }
  assert.match(ENV_EXAMPLE, /#\s*TRADING_WORKER_ENABLED/);
});

test('no business/financial constant drifted while doing this work', () => {
  assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 100;/);
  assert.match(SERVER, /const MIN_WITHDRAWAL_USD = 700;/);
  assert.match(SERVER, /const PROMO_PROFIT_CAP_USD = 20;/);
  assert.match(SERVER, /const PROMO_LIMIT_CODE = 'PROMO_TRADING_LIMIT_REACHED';/);
  assert.match(SERVER, /const REFERRAL_EARNINGS_MIN_CONVERT_USD = 0;/);
  assert.match(SERVER, /const REFERRAL_REWARD_PERCENT_DEFAULT = 20;/);
  // The MTA stays REMOVED: the only remaining mentions are comments recording
  // that (so this checks the executable code).
  assert.ok(!/const BOT_MIN_TRADING_BALANCE/.test(SERVER_CODE));
  assert.ok(!/getEffectiveMta/.test(SERVER_CODE));
  assert.ok(!/MTA_AMOUNT/.test(SERVER_CODE));
});
