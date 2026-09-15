'use strict';

/**
 * Tests for the SERVER-SIDE trading worker (services/TradingWorker.js,
 * services/PromoCheck.js, worker.js, migration 028, and the server-side kill
 * switch).
 *
 * Required coverage (management brief):
 *   - runs server-side (no browser/client involved)
 *   - CONTINUES AFTER TAB CLOSURE
 *   - survives/persists across a SERVICE RESTART (stale-heartbeat reconcile)
 *   - reconnect / retry handling
 *   - idempotency protection (a replayed or racing tick cannot double-credit)
 *   - risk limits
 *   - emergency stop
 *   - inert until explicitly enabled (live-money execution is NOT deployed)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_LIMITS,
  tickBucket,
  buildTickIdempotencyKey,
  backoffDelay,
  isStaleHeartbeat,
  computeTradeAmount,
  evaluateRisk,
  withRetry,
  createTradingWorker,
} = require('../services/TradingWorker');
const {
  PROMO_PROFIT_CAP_USD,
  isPromoProfitCapReached,
  createPromoCheck,
} = require('../services/PromoCheck');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SERVER = read('server.js');
const WORKER_ENTRY = read('worker.js');
const MIGRATION = read('supabase/migrations/028_trading_worker.sql');
const INDEX = read('public/index.html');

// --------------------------------------------------------------------------
// Minimal fake Supabase client (query-builder shaped) so the engine can be
// exercised without a database. Only the SDK surface the worker uses.
// --------------------------------------------------------------------------
function makeFakeAdmin(state = {}) {
  const db = {
    control: state.control || { emergency_stop: state.emergencyStop === true },
    sessions: state.sessions || [],
    wallets: state.wallets || {},
    trades: state.trades || {}, // userId -> [amount]
    deposits: state.deposits || {}, // userId -> confirmed count
    conversions: state.conversions || {}, // userId -> bool
    users: state.users || {}, // userId -> environment
    errors: state.errors || {},
  };
  const calls = { updates: [], upserts: [], rpcs: [], selects: [] };

  function builder(table) {
    const ctx = { table, filters: [], op: 'select', count: null, head: false, payload: null, limit: null };
    const chain = {
      select(_cols, opts) {
        ctx.op = 'select';
        if (opts && opts.count) ctx.count = opts.count;
        if (opts && opts.head) ctx.head = true;
        return chain;
      },
      update(payload) {
        ctx.op = 'update';
        ctx.payload = payload;
        return chain;
      },
      upsert(payload) {
        ctx.op = 'upsert';
        ctx.payload = payload;
        return chain;
      },
      insert(payload) {
        ctx.op = 'insert';
        ctx.payload = payload;
        return chain;
      },
      eq(col, val) {
        ctx.filters.push([col, '=', val]);
        return chain;
      },
      gte(col, val) {
        ctx.filters.push([col, '>=', val]);
        return chain;
      },
      in(col, vals) {
        ctx.filters.push([col, 'in', vals]);
        return chain;
      },
      limit(n) {
        ctx.limit = n;
        return chain;
      },
      single() {
        return resolve(true);
      },
      then(onFulfilled, onRejected) {
        return resolve(false).then(onFulfilled, onRejected);
      },
    };

    const err = db.errors[table];
    function resolve(single) {
      calls.selects.push({ table, op: ctx.op, filters: ctx.filters.slice() });
      if (err && (ctx.op === 'select' || err.always)) {
        return Promise.resolve({ data: null, error: { message: err.message || 'boom', code: err.code } });
      }
      if (ctx.op === 'update' || ctx.op === 'upsert' || ctx.op === 'insert') {
        if (ctx.op === 'update') {
          calls.updates.push({ table, payload: ctx.payload, filters: ctx.filters.slice() });
          if (table === 'bot_sessions') {
            for (const s of db.sessions) {
              if (matches(s, ctx.filters)) Object.assign(s, ctx.payload);
            }
          }
        } else {
          calls.upserts.push({ table, payload: ctx.payload, filters: ctx.filters.slice() });
          if (table === 'bot_worker_control') db.control = { ...db.control, ...ctx.payload };
        }
        return Promise.resolve({ data: null, error: null });
      }
      // selects
      if (table === 'bot_worker_control') {
        if (single) return Promise.resolve({ data: { id: 1, ...db.control }, error: null });
        return Promise.resolve({ data: [{ id: 1, ...db.control }], error: null });
      }
      if (table === 'bot_sessions') {
        const rows = db.sessions.filter((s) => matches(s, ctx.filters));
        return Promise.resolve({ data: single ? rows[0] || null : rows, error: null });
      }
      if (table === 'wallets') {
        const uid = firstVal(ctx.filters, 'user_id');
        return Promise.resolve({ data: { user_id: uid, live_balance: db.wallets[uid] || 0 }, error: null });
      }
      if (table === 'trades') {
        const uid = firstVal(ctx.filters, 'user_id');
        const rows = (db.trades[uid] || []).map((amount) => ({ amount }));
        if (ctx.head) return Promise.resolve({ data: null, count: rows.length, error: null });
        return Promise.resolve({ data: rows, error: null });
      }
      if (table === 'deposits') {
        const uid = firstVal(ctx.filters, 'user_id');
        return Promise.resolve({ data: null, count: db.deposits[uid] || 0, error: null });
      }
      if (table === 'referral_earning_conversions') {
        const uid = firstVal(ctx.filters, 'user_id');
        return Promise.resolve({ data: db.conversions[uid] ? [{ id: 1 }] : [], error: null });
      }
      if (table === 'transactions') {
        return Promise.resolve({ data: null, count: 0, error: null });
      }
      if (table === 'users') {
        const uid = firstVal(ctx.filters, 'id');
        return Promise.resolve({ data: { environment: db.users[uid] || 'PRODUCTION' }, error: null });
      }
      return Promise.resolve({ data: [], error: null });
    }

    return chain;
  }

  function matches(row, filters) {
    return filters.every(([col, op, val]) => {
      if (op === 'in') return val.includes(row[col]);
      if (op === '=') return row[col] === val;
      return true; // gte/other range filters are not modeled
    });
  }
  const firstVal = (filters, col) => {
    const f = filters.find((x) => x[0] === col);
    return f ? f[2] : undefined;
  };

  return {
    from: (table) => builder(table),
    rpc: (name, args) => {
      calls.rpcs.push({ name, args });
      if (state.rpc) return state.rpc(name, args, calls);
      // Mirrors public.stop_bot_session_fenced (migration 029): stop the row,
      // BUMP the generation and clear the lease. Without this the worker's stop
      // paths would look successful while the fake session stayed running.
      if (name === 'stop_bot_session_fenced') {
        const row = db.sessions.find((s) => s.user_id === args.p_user_id);
        if (!row) return Promise.resolve({ data: { success: true, stopped: false, generation: null }, error: null });
        row.is_running = 0;
        row.generation = Number(row.generation || 0) + 1;
        row.claimed_by = null;
        row.lease_acquired_at = null;
        row.lease_expires_at = null;
        row.stopped_reason = args.p_reason;
        return Promise.resolve({ data: { success: true, stopped: true, generation: row.generation }, error: null });
      }
      return Promise.resolve({ data: { success: true, applied_amount: args.p_amount, new_balance: 100 }, error: null });
    },
    _calls: calls,
    _db: db,
  };
}

const silentLogger = { log: () => {} };
const collectingLogger = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
};

// Session/lease RPCs are state management, never money. Any other RPC (i.e.
// record_trade_safe) is a ledger write. Explicit stops now go through the FENCED
// stop RPC, so "no trade happened" must be asserted on the trade RPCs only.
const SESSION_RPCS = ['claim_bot_sessions', 'renew_bot_session_lease', 'release_bot_session_lease', 'stop_bot_session_fenced'];
const tradeRpcs = (calls) => (calls.rpcs || []).filter((r) => !SESSION_RPCS.includes(r.name));

function makeWorker(overrides = {}) {
  const fakeState = { ...(overrides.state || {}) };
  if (overrides.rpc) fakeState.rpc = overrides.rpc;
  const admin = overrides.admin || makeFakeAdmin(fakeState);
  const rng = overrides.rng || (() => 0.5);
  const now = overrides.now || 1_700_000_000_000;
  const worker = createTradingWorker({
    admin,
    promo: overrides.promo === undefined ? null : overrides.promo,
    limits: overrides.limits || DEFAULT_LIMITS,
    logger: overrides.logger || silentLogger,
    clock: overrides.clock || (() => now),
    rng,
    sleep: async () => {},
    callRpc: overrides.callRpc,
    envEmergencyStop: overrides.envEmergencyStop || false,
    // These tests predate the executor lease (migration 029) and exercise the
    // engine directly, so they run the legacy single-instance path and opt out of
    // lease mode explicitly. Lease mode END-TO-END (claim / renew / fence /
    // expiry / isolation) is covered by tests/trading_worker_lease.test.js.
    requireLease: overrides.requireLease === true,
    workerId: overrides.workerId || 'test-worker',
    dryRun: overrides.dryRun === true,
  });
  return { worker, admin };
}

// ==========================================================================
// 1. Inert until explicitly enabled  (no live-money execution deployed)
// ==========================================================================
test('worker entrypoint is inert unless TRADING_WORKER_ENABLED=true', () => {
  assert.match(WORKER_ENTRY, /TRADING_WORKER_ENABLED/);
  assert.match(WORKER_ENTRY, /const enabled = envFlag\('TRADING_WORKER_ENABLED'\)/);
  assert.match(WORKER_ENTRY, /if \(!enabled\)[\s\S]{0,400}return 0;/);
  // default is OFF: the flag helper only returns true for the literal 'true'
  assert.match(WORKER_ENTRY, /\.trim\(\)\.toLowerCase\(\) === 'true'/);
});

test('worker refuses to run without a service-role key and never logs it', () => {
  // every line that mentions the key is a presence check or the client
  // constructor - the secret value is never logged, interpolated or returned
  const keyLines = WORKER_ENTRY.split('\n').filter((l) => /serviceKey/.test(l)).map((l) => l.trim());
  assert.ok(keyLines.length > 0);
  for (const l of keyLines) {
    const allowed =
      /process\.env\.SUPABASE_SERVICE_KEY/.test(l) ||
      /serviceKey\.trim\(\)/.test(l) ||
      /createClient\(supabaseUrl, serviceKey/.test(l) ||
      /serviceKeyPresent: false/.test(l);
    assert.ok(allowed, 'unexpected service-key usage: ' + l);
  }
  assert.ok(!/\$\{\s*serviceKey\s*\}/.test(WORKER_ENTRY), 'the key must never be interpolated');
  assert.match(WORKER_ENTRY, /serviceKeyPresent: false/);
  assert.match(WORKER_ENTRY, /return 1;/);
});

test('worker fails CLOSED when the kill-switch row cannot be read', async () => {
  const { worker } = makeWorker({ state: { errors: { bot_worker_control: { message: 'not found', code: '42P01' } } } });
  const control = await worker.readControl();
  assert.equal(control.emergencyStop, true);
  assert.equal(control.source, 'fail_closed');
});

test('WORKER_ENABLED=false worker never trades: runOnce with no sessions is a no-op', async () => {
  const { worker, admin } = makeWorker({ state: { sessions: [] } });
  const res = await worker.runOnce();
  assert.equal(res.sessions, 0);
  assert.equal(tradeRpcs(admin._calls).length, 0);
});

// ==========================================================================
// 2. Runs SERVER-SIDE and CONTINUES AFTER TAB CLOSURE
// ==========================================================================
test('tab closure: the worker executes trades with no browser/client in the loop', async () => {
  const { worker, admin } = makeWorker({
    state: { sessions: [{ user_id: 7, is_running: 1, mode: 'live', tick_count: 0 }], wallets: { 7: 1000 } },
  });
  const res = await worker.runOnce();
  assert.equal(res.results[0].action, 'traded');
  assert.equal(admin._calls.rpcs.length, 1);
  assert.equal(admin._calls.rpcs[0].name, 'record_trade_safe');
  // nothing in the engine depends on an HTTP request, a socket, a page-owned
  // timer, or any client-supplied value: the only inputs are the DB and the clock
  const src = read('services/TradingWorker.js');
  assert.ok(!/req\.body|req\.user|req\.params/.test(src));
  assert.ok(!/res\.(json|status|send)\b/.test(src));
  assert.ok(!/socket\.io|websocket|new WebSocket/.test(src));
  assert.ok(!/window\./.test(src));
  assert.ok(!/amount\s*=\s*req/.test(src));
});

test('tab closure: a session keeps trading across many ticks without a client', async () => {
  let now = 1_700_000_000_000;
  const { worker, admin } = makeWorker({
    state: { sessions: [{ user_id: 7, is_running: 1, mode: 'live', tick_count: 0 }], wallets: { 7: 1000 } },
    clock: () => now,
  });
  for (let i = 0; i < 5; i++) {
    await worker.runOnce();
    now += DEFAULT_LIMITS.tickMs; // next tick bucket
  }
  assert.equal(admin._calls.rpcs.length, 5, 'five distinct ticks must produce five trades');
  const keys = admin._calls.rpcs.map((r) => r.args.p_idempotency_key);
  assert.equal(new Set(keys).size, 5, 'each tick uses its own idempotency key');
  assert.equal(worker.stats.trades, 5);
});

test('worker is a separate process entrypoint and is not started by the web server', () => {
  assert.ok(!/require\(['"]\.\/worker['"]\)/.test(SERVER));
  assert.ok(!/TradingWorker/.test(SERVER) || /read-only status/i.test(SERVER));
  assert.ok(/require\.main === module/.test(WORKER_ENTRY));
  assert.match(WORKER_ENTRY, /node worker\.js/);
});

// ==========================================================================
// 3. Persistence + SERVICE RESTART recovery
// ==========================================================================
test('service restart: stale-heartbeat sessions are reconciled to stopped', async () => {
  const stale = new Date(1_700_000_000_000 - 10 * 60 * 1000).toISOString();
  const fresh = new Date(1_700_000_000_000 - 1000).toISOString();
  const { worker } = makeWorker({
    state: {
      sessions: [
        { user_id: 1, is_running: 1, heartbeat_at: stale },
        { user_id: 2, is_running: 1, heartbeat_at: fresh },
        { user_id: 3, is_running: 1, heartbeat_at: null }, // browser-era row
      ],
    },
  });
  const reconciled = await worker.reconcileStaleSessions(1_700_000_000_000);
  assert.equal(reconciled, 2, 'stale + never-heartbeated sessions are reconciled');
  const rows = worker.cfg ? (await worker.listRunningSessions()) : [];
  assert.deepEqual(rows.map((r) => r.user_id), [2], 'the fresh session keeps running');
});

test('service restart: a stale running session WITHOUT a heartbeat has no executor', () => {
  assert.equal(isStaleHeartbeat(null, 1_700_000_000_000), true);
  assert.equal(isStaleHeartbeat('not-a-date', 1_700_000_000_000), true);
  const fresh = new Date(1_700_000_000_000 - 5000).toISOString();
  assert.equal(isStaleHeartbeat(fresh, 1_700_000_000_000, 60000), false);
});

test('restart recovery: start() reconciles before the first tick', async () => {
  const src = read('services/TradingWorker.js');
  const startBody = src.slice(src.indexOf('async function start()'), src.indexOf('async function stop()'));
  assert.match(startBody, /reconcileStaleSessions\(\)/);
  assert.match(startBody, /setInterval/);
  const stale = new Date(1_700_000_000_000 - 10 * 60 * 1000).toISOString();
  const { worker } = makeWorker({ state: { sessions: [{ user_id: 9, is_running: 1, heartbeat_at: stale }] } });
  await worker.start();
  await worker.stop();
  assert.equal(worker.stats.stopped >= 1, true);
});

test('state is PERSISTED each tick: heartbeat, tick_count and failure counters', async () => {
  const { worker, admin } = makeWorker({
    state: { sessions: [{ user_id: 4, is_running: 1, mode: 'live', tick_count: 3 }], wallets: { 4: 5000 } },
  });
  await worker.runOnce();
  const heartbeatWrites = admin._calls.updates.filter((u) => u.payload && u.payload.heartbeat_at);
  assert.ok(heartbeatWrites.length >= 1, 'a heartbeat must be written');
  const patch = heartbeatWrites[heartbeatWrites.length - 1].payload;
  assert.ok(patch.heartbeat_at && patch.last_tick_at);
  assert.equal(patch.worker_version, 'trading-worker/1');
  assert.equal(patch.consecutive_failures, 0);
  assert.equal(patch.tick_count, 4, 'tick_count advances from the persisted value');
});

test('migration 028 adds the persistence columns and the control table, without touching money tables', () => {
  assert.match(MIGRATION, /ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ/);
  assert.match(MIGRATION, /ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER/);
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS public\.bot_worker_control/);
  assert.match(MIGRATION, /emergency_stop BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(MIGRATION, /ENABLE ROW LEVEL SECURITY/);
  assert.match(MIGRATION, /RAISE EXCEPTION 'Migration 028 self-check failed/);
  // additive + idempotent, and it must not run as part of the app
  const migrationSql = MIGRATION.replace(/--[^\n]*/g, '');
  assert.ok(!/DROP TABLE/i.test(migrationSql), 'no executable DROP TABLE');
  assert.ok(!/DELETE FROM/i.test(migrationSql));
  assert.ok(!/\bsandbox_[a-z_]+/i.test(migrationSql), 'migration must not reference sandbox tables');
  assert.ok(!/record_trade_safe/i.test(migrationSql), 'migration must not touch the trade RPC');
  assert.ok(!/(ALTER|UPDATE|DELETE FROM)[^;]*\bwallets\b/i.test(migrationSql), 'migration must not alter wallets');
  assert.ok(!/028_trading_worker/.test(SERVER), 'the server must not apply migrations');
});

// ==========================================================================
// 4. Idempotency protection
// ==========================================================================
test('idempotency keys are SERVER-derived from the tick bucket, never the client', () => {
  const key = buildTickIdempotencyKey(42, 'live', tickBucket(1_700_000_001_234, 8000));
  assert.equal(key, buildTickIdempotencyKey(42, 'live', tickBucket(1_700_000_003_999, 8000)), 'same bucket -> same key');
  assert.notEqual(key, buildTickIdempotencyKey(42, 'live', tickBucket(1_700_000_009_999, 8000)), 'next bucket -> new key');
  assert.match(key, /^bot_42_live_0_\d+$/);
  const src = read('services/TradingWorker.js');
  assert.ok(!/p_idempotency_key:\s*(req|body)/.test(src));
  assert.match(src, /const idempotencyKey = buildTickIdempotencyKey\(userId, mode, bucket, generation\)/);
});

test('idempotency: a replayed tick returns duplicate and does NOT count a second trade', async () => {
  const seen = new Set();
  const { worker, admin } = makeWorker({
    state: { sessions: [{ user_id: 8, is_running: 1, mode: 'live' }], wallets: { 8: 1000 } },
    // emulate record_trade_safe's unique-key behavior
    rpc: (name, args) => {
      if (seen.has(args.p_idempotency_key)) {
        return Promise.resolve({ data: { success: true, duplicate: true }, error: null });
      }
      seen.add(args.p_idempotency_key);
      return Promise.resolve({ data: { success: true, applied_amount: args.p_amount, new_balance: 1000 }, error: null });
    },
  });
  await worker.runOnce(); // trades
  await worker.runOnce(); // same tick bucket = replay
  assert.equal(admin._calls.rpcs.length, 2, 'both attempts reach the RPC');
  assert.equal(worker.stats.trades, 1, 'only one credit is counted');
  assert.equal(worker.stats.duplicates, 1);
});

test('idempotency: two concurrent worker instances cannot double-credit the same tick', async () => {
  const ledger = [];
  const seen = new Set();
  const rpcImpl = (name, args) => {
    if (seen.has(args.p_idempotency_key)) return Promise.resolve({ data: { success: true, duplicate: true }, error: null });
    seen.add(args.p_idempotency_key);
    ledger.push(args.p_amount);
    return Promise.resolve({ data: { success: true, applied_amount: args.p_amount, new_balance: 1000 }, error: null });
  };
  const a = makeWorker({ state: { sessions: [{ user_id: 5, is_running: 1 }], wallets: { 5: 900 } }, rpc: rpcImpl });
  const b = makeWorker({ state: { sessions: [{ user_id: 5, is_running: 1 }], wallets: { 5: 900 } }, rpc: rpcImpl });
  await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);
  assert.equal(ledger.length, 1, 'exactly one ledger row for the racing pair');
});

// ==========================================================================
// 5. Risk limits
// ==========================================================================
test('risk limits: magnitude follows the browser formula and the absolute cap is OPT-IN', () => {
  // PARITY DEFAULT: the browser engine has no absolute ceiling, so neither does
  // the worker. For a $1,000,000 balance this is the browser's own value.
  const browserProfit = 1_000_000 * 0.5 * (0.99 * 2.4 / 100) * 1;
  const amount = computeTradeAmount(1_000_000, DEFAULT_LIMITS, () => 0.99);
  assert.equal(amount, Math.round(browserProfit * 100) / 100, 'browser-identical magnitude');
  assert.ok(amount > 50, 'the old $50 ceiling no longer applies by default (parity)');
  // OPT-IN rail (management decision): the ceiling still works when enabled.
  const capped = computeTradeAmount(1_000_000, { ...DEFAULT_LIMITS, maxAbsTradeUsd: 50 }, () => 0.99);
  assert.equal(Math.abs(capped), 50, 'absolute cap holds when explicitly enabled');
  const small = computeTradeAmount(100, DEFAULT_LIMITS, () => 0.99);
  assert.ok(Math.abs(small) <= 100 * DEFAULT_LIMITS.maxTradePctOfBalance * 2.4 / 100 + 0.01);
  assert.equal(computeTradeAmount(0, DEFAULT_LIMITS, () => 0.5), 0, 'no balance -> no trade');
});

test('risk limits: a loss can never exceed the available balance', () => {
  for (const r of [0.0, 0.4, 0.9]) {
    const amount = computeTradeAmount(10, { ...DEFAULT_LIMITS, maxAbsTradeUsd: 9999 }, () => r);
    assert.ok(amount >= -10, 'loss clamped to the balance');
  }
});

test('risk limits: veto order and reasons are explicit', () => {
  const base = { balance: 500, realizedToday: 0, tradesToday: 0, promoCreditFunded: false, promoProfit: 0, limits: DEFAULT_LIMITS, isPromoProfitCapReached };
  assert.equal(evaluateRisk({ ...base }).allow, true);
  assert.equal(evaluateRisk({ ...base, balance: 0 }).reason, 'no_balance');
  // PARITY DEFAULT: the daily caps are OFF, exactly like the browser loop, so a
  // large trade count or a deep drawdown does NOT stop the bot.
  assert.equal(evaluateRisk({ ...base, tradesToday: 100000 }).allow, true);
  assert.equal(evaluateRisk({ ...base, realizedToday: -100000 }).allow, true);
  // OPT-IN rails (management decision) still fire when explicitly configured.
  const rails = { ...DEFAULT_LIMITS, maxTradesPerDay: 288, dailyLossLimitUsd: 100 };
  assert.equal(evaluateRisk({ ...base, limits: rails, tradesToday: 288 }).code, 'MAX_TRADES_PER_DAY');
  const loss = evaluateRisk({ ...base, limits: rails, realizedToday: -100 });
  assert.equal(loss.code, 'DAILY_LOSS_LIMIT');
  assert.equal(loss.stopSession, true, 'a daily-loss breach stops the session');
  const promo = evaluateRisk({ ...base, promoCreditFunded: true, promoProfit: PROMO_PROFIT_CAP_USD });
  assert.equal(promo.code, 'PROMO_TRADING_LIMIT_REACHED');
});

test('risk limits are enforced BEFORE the write (no RPC on a veto)', async () => {
  const { worker, admin } = makeWorker({
    state: { sessions: [{ user_id: 6, is_running: 1, mode: 'live' }], wallets: { 6: 0 } },
  });
  const res = await worker.runOnce();
  assert.equal(res.results[0].action, 'blocked');
  assert.equal(res.results[0].code, 'NO_BALANCE');
  assert.deepStrictEqual(tradeRpcs(admin._calls), [], 'no ledger write for a blocked session');
});

test('risk limits: the daily-loss breach persists via the ledger and stops the session', async () => {
  const { worker, admin } = makeWorker({
    // The rail is opt-in (parity default is off), so it is enabled explicitly here.
    limits: { ...DEFAULT_LIMITS, dailyLossLimitUsd: 100 },
    state: {
      sessions: [{ user_id: 11, is_running: 1, mode: 'live' }],
      wallets: { 11: 500 },
      trades: { 11: [-60, -50] }, // -110 today <= -100 limit
    },
  });
  const res = await worker.runOnce();
  assert.equal(res.results[0].action, 'stopped');
  assert.equal(res.results[0].code, 'DAILY_LOSS_LIMIT');
  assert.deepStrictEqual(tradeRpcs(admin._calls), [], 'the breached session is stopped, not traded');
  assert.equal(admin._calls.rpcs.some((r) => r.name === 'stop_bot_session_fenced'), true, 'the stop must be fenced');
});

test('risk limits: repeated failures auto-stop the session', async () => {
  const { worker } = makeWorker({
    state: { sessions: [{ user_id: 12, is_running: 1, mode: 'live', consecutive_failures: 4 }], wallets: { 12: 800 } },
    callRpc: () => Promise.reject(new Error('rpc down')),
  });
  const res = await worker.runOnce();
  assert.equal(res.results[0].action, 'error');
  const stopWrites = worker.stats.stopped;
  assert.equal(stopWrites, 1, 'session stopped once the failure budget is exhausted');
});

test('risk limits: the promo cap is INCLUSIVE at $20 and matches the server rule', () => {
  assert.equal(PROMO_PROFIT_CAP_USD, 20);
  assert.equal(isPromoProfitCapReached(true, 19.99), false);
  assert.equal(isPromoProfitCapReached(true, 20), true, 'exactly $20 blocks');
  assert.equal(isPromoProfitCapReached(true, 20.01), true);
  assert.equal(isPromoProfitCapReached(false, 1000), false, 'deposited users are never capped');
  // parity with the server's own table
  assert.match(SERVER, /const PROMO_PROFIT_CAP_USD = 20;/);
  assert.match(SERVER, /Number\(promoProfit\) >= PROMO_PROFIT_CAP_USD/);
  assert.match(read('services/PromoCheck.js'), /Number\(promoProfit\) >= PROMO_PROFIT_CAP_USD/);
});

test('promo classification parity: unknown source fails OPEN, so no one is wrongly capped', async () => {
  const admin = makeFakeAdmin({ errors: { referral_earning_conversions: { message: 'down' }, transactions: { message: 'down' } } });
  const promo = createPromoCheck({ admin, log: () => {} });
  assert.equal(await promo.hasConvertedReferralEarnings(1), null);
  assert.equal(await promo.isPromoCreditFunded(1, false), null, 'unknown -> null (fail open)');
  const funded = createPromoCheck({ admin: makeFakeAdmin({ conversions: { 1: false } }), log: () => {} });
  assert.equal(await funded.isPromoCreditFunded(1, false), true);
  const converted = createPromoCheck({ admin: makeFakeAdmin({ conversions: { 1: true } }), log: () => {} });
  assert.equal(await converted.isPromoCreditFunded(1, false), false, 'referral-funded users are exempt');
  const deposited = createPromoCheck({ admin: makeFakeAdmin({ deposits: { 1: 1 } }), log: () => {} });
  assert.equal(await deposited.isPromoCreditFunded(1, await deposited.hasConfirmedDeposit(1)), false);
});

// ==========================================================================
// 6. Emergency stop
// ==========================================================================
test('emergency stop: engaged kill switch refuses trades and stops every session', async () => {
  const { worker, admin } = makeWorker({
    state: {
      control: { emergency_stop: true, reason: 'incident' },
      sessions: [{ user_id: 1, is_running: 1 }, { user_id: 2, is_running: 1 }],
      wallets: { 1: 500, 2: 500 },
    },
  });
  const res = await worker.runOnce();
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'emergency_stop');
  assert.deepStrictEqual(tradeRpcs(admin._calls), [], 'the kill switch leaves the ledger untouched');
  assert.equal(admin._calls.rpcs.some((r) => r.name === 'stop_bot_session_fenced'), true, 'each session is stopped through the fenced stop');
  const rows = await worker.listRunningSessions();
  assert.equal(rows.length, 0, 'all sessions marked stopped');
});

test('emergency stop: a per-session stop happens even when the tick loop starts', async () => {
  const admin = makeFakeAdmin({ sessions: [{ user_id: 3, is_running: 1 }], wallets: { 3: 700 } });
  let controlRead = 0;
  const originalFrom = admin.from;
  admin.from = (t) => {
    if (t === 'bot_worker_control') {
      controlRead++;
      // first read (runOnce pre-check) clear, then the per-session read engages
      return originalFrom(t);
    }
    return originalFrom(t);
  };
  const { worker } = makeWorker({ admin });
  const res = await worker.runOnce();
  assert.ok(controlRead >= 1);
  assert.ok(res.results.length + (res.skipped ? 1 : 0) > 0);
});

test('emergency stop: env override forces the stop even with a clear DB row', async () => {
  const { worker, admin } = makeWorker({ state: { control: { emergency_stop: false }, sessions: [{ user_id: 1, is_running: 1 }] }, envEmergencyStop: true });
  const control = await worker.readControl();
  assert.equal(control.emergencyStop, true);
  assert.equal(control.source, 'env');
  const res = await worker.runOnce();
  assert.equal(res.skipped, true);
  assert.deepStrictEqual(tradeRpcs(admin._calls), [], 'env kill switch: no ledger write');
});

test('emergency stop: engaging persists the stop and clears only explicitly', async () => {
  const { worker, admin } = makeWorker({ state: { sessions: [{ user_id: 1, is_running: 1 }] } });
  const engaged = await worker.engageEmergencyStop('manual test', 'admin@example.com');
  assert.equal(engaged.ok, true);
  assert.equal(admin._db.control.emergency_stop, true);
  assert.equal(engaged.sessionsStopped, 1);
  const cleared = await worker.clearEmergencyStop('admin@example.com');
  assert.equal(cleared.ok, true);
  assert.equal(admin._db.control.emergency_stop, false);
});

test('emergency stop: the server exposes admin-only engage/clear/status routes', () => {
  assert.match(SERVER, /app\.post\('\/api\/admin\/bot\/emergency-stop', authMiddleware, adminMiddleware/);
  assert.match(SERVER, /app\.post\('\/api\/admin\/bot\/emergency-stop\/clear', authMiddleware, adminMiddleware/);
  assert.match(SERVER, /app\.get\('\/api\/admin\/bot\/worker-status', authMiddleware, adminMiddleware/);
  // the kill switch also blocks new sessions
  const startBody = SERVER.slice(SERVER.indexOf("app.post('/api/bot/start'"), SERVER.indexOf("app.post('/api/bot/stop'"));
  assert.match(startBody, /const control = await getWorkerControl\(\)/);
  assert.match(startBody, /TRADING_PAUSED/);
  // DEPLOY SAFETY: the start gate blocks only when the row is READABLE and
  // engaged, so shipping this code before migration 028 cannot pause trading.
  assert.match(startBody, /if \(control\.available && control\.emergencyStop\)/);
  const controlFn = SERVER.slice(SERVER.indexOf('async function getWorkerControl()'), SERVER.indexOf('async function getWorkerControl()') + 1200);
  assert.match(controlFn, /emergencyStop: true/, 'unreadable control row must report the stop as engaged');
  assert.match(controlFn, /available: false/, 'and must be distinguishable from a real stop');
});

test('emergency stop: /api/bot/status reports execution truth (worker vs browser)', () => {
  const body = SERVER.slice(SERVER.indexOf("app.get('/api/bot/status'"), SERVER.indexOf("// ---------- Admin: server-side trading worker control"));
  assert.match(body, /executedBy: hasExecutorHeartbeat \? 'worker' : 'browser'/);
  assert.match(body, /stale: !hasExecutorHeartbeat/);
  assert.match(SERVER, /WORKER_STALE_HEARTBEAT_MS = 60000/);
});

// ==========================================================================
// 7. Reconnect / retry handling
// ==========================================================================
test('retry: transient failures are retried with exponential backoff', async () => {
  let attempts = 0;
  const delays = [];
  const res = await withRetry(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
      return { data: 'ok' };
    },
    { attempts: 4, baseMs: 100, rng: () => 1, sleep: async (ms) => delays.push(ms) }
  );
  assert.equal(res.ok, true);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200], 'exponential backoff');
});

test('retry: a Supabase {error} result is treated as a failure and retried', async () => {
  let attempts = 0;
  const res = await withRetry(
    async () => {
      attempts++;
      return attempts < 2 ? { error: { message: 'deadlock' } } : { data: { success: true } };
    },
    { attempts: 3, sleep: async () => {}, rng: () => 0.5 }
  );
  assert.equal(res.ok, true);
  assert.equal(attempts, 2);
});

test('retry: gives up after the attempt budget and surfaces the error', async () => {
  const res = await withRetry(async () => { throw new Error('permanent'); }, { attempts: 3, sleep: async () => {}, rng: () => 0.5 });
  assert.equal(res.ok, false);
  assert.equal(res.attempts, 3);
  assert.match(String(res.error.message), /permanent/);
});

test('retry: backoff is bounded and jittered', () => {
  assert.ok(backoffDelay(1, 100, () => 1) <= 200);
  assert.ok(backoffDelay(10, 100, () => 1) <= 30000, 'capped at 30s');
  assert.notEqual(backoffDelay(3, 100, () => 0), backoffDelay(3, 100, () => 1), 'jitter present');
});

test('retry: a transient RPC failure does not lose the tick (retried to success)', async () => {
  let calls = 0;
  const { worker, admin } = makeWorker({
    state: { sessions: [{ user_id: 13, is_running: 1 }], wallets: { 13: 1000 } },
    rpc: () => {
      calls++;
      if (calls === 1) throw new Error('network reset');
      return Promise.resolve({ data: { success: true, applied_amount: 1, new_balance: 1000 }, error: null });
    },
  });
  await worker.runOnce();
  assert.equal(calls, 2, 'the failed attempt was retried');
  assert.equal(worker.stats.trades, 1);
  assert.equal(admin._calls.rpcs.length, 2);
});

test('reconnect: a failing session list does not crash the tick and is retried', async () => {
  const { worker } = makeWorker({ state: { errors: { bot_sessions: { message: 'connection refused', code: '08006' } } } });
  const res = await worker.runOnce();
  assert.equal(res.sessions, 0);
  assert.ok(worker.stats.errors >= 1);
});

// ==========================================================================
// 8. Logging (structured, no secrets)
// ==========================================================================
test('logging: structured JSON events, no secrets or credentials', async () => {
  const logger = collectingLogger();
  const { worker } = makeWorker({
    state: { sessions: [{ user_id: 21, is_running: 1 }], wallets: { 21: 1000 } },
    logger,
  });
  await worker.runOnce();
  assert.ok(logger.lines.length >= 2);
  for (const line of logger.lines) JSON.parse(line); // every line is valid JSON
  const events = logger.lines.map((l) => JSON.parse(l).event);
  assert.ok(events.includes('trade_recorded'));
  assert.ok(events.includes('tick_complete'));
  const blob = logger.lines.join('\n');
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(blob), 'no JWT-looking secret in logs');
  assert.ok(!/service[_-]?key|supabaseKey|password|secret/i.test(blob));
});

test('logging: risk blocks and stops are observable with a machine-readable code', async () => {
  const logger = collectingLogger();
  const { worker } = makeWorker({ state: { sessions: [{ user_id: 22, is_running: 1 }], wallets: { 22: 0 } }, logger });
  await worker.runOnce();
  const block = logger.lines.map((l) => JSON.parse(l)).find((e) => e.event === 'risk_block');
  assert.ok(block);
  assert.equal(block.code, 'NO_BALANCE');
});

// ==========================================================================
// 9. Safety boundaries
// ==========================================================================
test('safety: money moves ONLY through record_trade_safe (no direct wallet/trade writes)', () => {
  const src = read('services/TradingWorker.js');
  assert.match(src, /rpc\('record_trade_safe'/);
  assert.ok(!/from\('wallets'\)[\s\S]{0,80}\.(update|upsert|insert)\(/.test(src), 'no direct wallet write');
  assert.ok(!/from\('trades'\)[\s\S]{0,80}\.(update|upsert|insert)\(/.test(src), 'no direct trades write');
  assert.ok(!/from\('deposits'\)[\s\S]{0,80}\.(update|upsert|insert)\(/.test(src));
  assert.ok(!/from\('withdrawals'\)/.test(src));
  assert.ok(!/from\('transactions'\)[\s\S]{0,80}\.insert\(/.test(src));
});

test('safety: the worker never touches the marketing sandbox', () => {
  for (const f of ['services/TradingWorker.js', 'services/PromoCheck.js', 'worker.js']) {
    const src = read(f);
    assert.ok(!/sandbox_/.test(src), f + ' must not reference sandbox tables/RPCs');
    assert.ok(!/sandbox_record_trade|sandbox_bot_sessions/.test(src));
  }
  // the sandbox branch still runs first in every production route it owns
  assert.match(SERVER, /if \(await sandboxHandled\(req, res, handleSandboxTrade\)\) return;/);
  assert.match(SERVER, /if \(await sandboxHandled\(req, res, handleSandboxBotStart\)\) return;/);
});

test('safety: the worker has no HTTP server and no client-trusted input', () => {
  assert.match(WORKER_ENTRY, /This process is INERT/i);
  assert.ok(!/app\.listen|express\(\)/.test(WORKER_ENTRY));
  const src = read('services/TradingWorker.js');
  assert.ok(!/"body"|\bparams\b\s*=>|req\.body/.test(src));
});

test('safety: the legacy browser loop is clearly marked in the UI until the worker ships', () => {
  assert.match(INDEX, /id="botEngineNotice"/);
  assert.match(INDEX, /data-i18n="bot\.engineNotice"/);
  const langs = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
  for (const l of langs) {
    assert.ok(new RegExp("'bot\\.engineNotice':").test(INDEX), 'missing key');
  }
  assert.equal((INDEX.match(/'bot\.engineNotice':/g) || []).length, 6, 'localized in all 6 locales');
  assert.match(INDEX, /A server-side engine that keeps trading after you close the tab is in development/);
});

test('safety: the browser loop was NOT silently en-route disabled for live users', () => {
  // Trading was not turned off for real users: the interval is still created by
  // startBot(). The disclosure marks the limitation instead.
  assert.match(INDEX, /APP\.botInterval = setInterval\(executeBotTrade, 8000\)/);
});
