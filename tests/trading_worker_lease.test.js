/**
 * STAGE A (code-only, non-production) - server-side trading worker:
 *   * EXECUTOR LEASE (migration 029): at most ONE worker instance executes a
 *     session at a time; acquisition / renewal / release / expiry.
 *   * GENERATION FENCING: a stale executor is rejected BEFORE any money-moving
 *     write.
 *   * DRY-RUN / SHADOW MODE: observe and log intended actions, write NOTHING.
 *
 * These tests use the REAL services/TradingWorker.js against a fake Supabase
 * client whose lease RPCs mirror the semantics of migration 029. No database, no
 * network, no money. Nothing here enables the worker: TRADING_WORKER_ENABLED is
 * untouched and migration 029 is not applied.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_LIMITS,
  buildTickIdempotencyKey,
  leaseExpiresAtMs,
  evaluateFence,
  createTradingWorker,
} = require('../services/TradingWorker');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SERVICE_SRC = read('services/TradingWorker.js');
const WORKER_ENTRY = read('worker.js');
const SERVER = read('server.js');
const INDEX = read('public/index.html');
const MIGRATION_029 = read('supabase/migrations/029_bot_session_lease.sql');

// --------------------------------------------------------------------------
// Fake Supabase client: query-builder surface the worker uses + lease RPCs that
// behave like migration 029 (including the fence code order).
// --------------------------------------------------------------------------
const iso = (ms) => new Date(ms).toISOString();

function makeDb(overrides = {}) {
  return {
    serverNowMs: overrides.serverNowMs || 1_700_000_000_000,
    control: { id: 1, emergency_stop: false, reason: null, engaged_by: null, engaged_at: null },
    sessions: overrides.sessions || [
      {
        user_id: 1, is_running: 1, mode: 'live', generation: 0,
        claimed_by: null, lease_expires_at: null, consecutive_failures: 0, tick_count: 0,
      },
    ],
    wallets: overrides.wallets || { 1: 1000 },
    tradesByUser: overrides.tradesByUser || {},
    calls: { claim: 0, renew: 0, release: 0, trade: 0, updates: [], upserts: [], rpcs: [], tradeKeys: [] },
  };
}

function makeAdmin(db, opts = {}) {
  const leaseRpcUnavailable = opts.leaseRpcUnavailable === true;
  const tradeResults = opts.tradeResults || null; // optional queue of trade RPC responses
  const matches = (row, filters) => filters.every(([c, op, v]) => (op === '=' ? row[c] === v : true));
  const firstVal = (filters, col) => {
    const f = filters.find((x) => x[0] === col);
    return f ? f[2] : undefined;
  };

  function sessionById(id) {
    return db.sessions.find((s) => String(s.user_id) === String(id));
  }

  function rpc(name, args) {
    db.calls.rpcs.push({ name, args });

    if (name === 'claim_bot_sessions') {
      if (leaseRpcUnavailable) {
        // Exactly what PostgREST returns when the function does not exist.
        return Promise.resolve({
          data: null,
          error: {
            code: 'PGRST202',
            message: 'Could not find the function public.claim_bot_sessions(p_worker_id, p_lease_ms, p_limit) in the schema cache',
          },
        });
      }
      db.calls.claim++;
      const now = db.serverNowMs;
      const claimed = [];
      for (const s of db.sessions) {
        if (claimed.length >= (args.p_limit || 10)) break;
        if (Number(s.is_running) !== 1) continue;
        const free = !s.claimed_by || !s.lease_expires_at || Date.parse(s.lease_expires_at) <= now;
        if (!free) continue;
        s.claimed_by = args.p_worker_id;
        s.lease_expires_at = iso(now + args.p_lease_ms);
        claimed.push({
          user_id: s.user_id, is_running: 1, generation: s.generation || 0,
          claimed_by: s.claimed_by, lease_expires_at: s.lease_expires_at,
          consecutive_failures: s.consecutive_failures || 0, tick_count: s.tick_count || 0,
        });
      }
      return Promise.resolve({ data: { success: true, server_now: iso(now), claimed }, error: null });
    }

    if (name === 'renew_bot_session_lease') {
      db.calls.renew++;
      const now = db.serverNowMs;
      const s = sessionById(args.p_user_id);
      const base = {
        success: true, server_now: iso(now), is_running: s ? s.is_running : null,
        generation: s ? s.generation || 0 : null, claimed_by: s ? s.claimed_by : null,
      };
      if (!s) return Promise.resolve({ data: { ...base, renewed: false, code: 'SESSION_NOT_FOUND' }, error: null });
      if (Number(s.is_running) !== 1) return Promise.resolve({ data: { ...base, renewed: false, code: 'SESSION_NOT_RUNNING' }, error: null });
      if (Number(s.generation || 0) !== Number(args.p_generation || 0)) {
        return Promise.resolve({ data: { ...base, renewed: false, code: 'GENERATION_MISMATCH' }, error: null });
      }
      if (!s.claimed_by) return Promise.resolve({ data: { ...base, renewed: false, code: 'LEASE_UNCLAIMED' }, error: null });
      if (s.claimed_by !== args.p_worker_id) return Promise.resolve({ data: { ...base, renewed: false, code: 'LEASE_NOT_OWNED' }, error: null });
      if (!s.lease_expires_at || Date.parse(s.lease_expires_at) <= now) {
        return Promise.resolve({ data: { ...base, renewed: false, code: 'LEASE_EXPIRED' }, error: null });
      }
      s.lease_expires_at = iso(now + args.p_lease_ms);
      return Promise.resolve({
        data: { ...base, renewed: true, code: null, lease_expires_at: s.lease_expires_at, claimed_by: args.p_worker_id },
        error: null,
      });
    }

    if (name === 'release_bot_session_lease') {
      db.calls.release++;
      const s = sessionById(args.p_user_id);
      let released = false;
      if (s && s.claimed_by === args.p_worker_id
          && (args.p_generation === undefined || Number(s.generation || 0) === Number(args.p_generation))) {
        s.claimed_by = null;
        s.lease_expires_at = null;
        released = true;
      }
      return Promise.resolve({ data: { success: true, released, server_now: iso(db.serverNowMs) }, error: null });
    }

    if (name === 'record_trade_safe') {
      db.calls.trade++;
      db.calls.tradeKeys.push(args.p_idempotency_key);
      if (tradeResults && tradeResults.length) return Promise.resolve(tradeResults.shift());
      return Promise.resolve({
        data: { success: true, applied_amount: args.p_amount, new_balance: 1000 + (Number(args.p_amount) || 0) },
        error: null,
      });
    }

    return Promise.resolve({ data: { success: true }, error: null });
  }

  function builder(table) {
    const ctx = { table, filters: [], op: 'select', payload: null, head: false };
    const chain = {
      select() { ctx.op = 'select'; return chain; },
      update(payload) { ctx.op = 'update'; ctx.payload = payload; return chain; },
      upsert(payload) { ctx.op = 'upsert'; ctx.payload = payload; return chain; },
      insert(payload) { ctx.op = 'insert'; ctx.payload = payload; return chain; },
      eq(c, v) { ctx.filters.push([c, '=', v]); return chain; },
      gte() { return chain; },
      in() { return chain; },
      limit() { return chain; },
      single() { return resolve(true); },
      then(onOk, onErr) { return resolve(false).then(onOk, onErr); },
    };

    function resolve(single) {
      if (ctx.op === 'update' || ctx.op === 'upsert' || ctx.op === 'insert') {
        const entry = { table, payload: ctx.payload, filters: ctx.filters.slice() };
        if (ctx.op === 'update') {
          db.calls.updates.push(entry);
          if (table === 'bot_sessions') {
            for (const s of db.sessions) if (matches(s, ctx.filters)) Object.assign(s, ctx.payload);
          }
        } else {
          db.calls.upserts.push(entry);
          if (table === 'bot_worker_control') Object.assign(db.control, ctx.payload);
        }
        return Promise.resolve({ data: null, error: null });
      }
      if (table === 'bot_worker_control') {
        return Promise.resolve({ data: single ? db.control : [db.control], error: null });
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
        const rows = (db.tradesByUser[uid] || []).map((amount) => ({ amount }));
        if (ctx.head) return Promise.resolve({ data: null, count: rows.length, error: null });
        return Promise.resolve({ data: rows, error: null });
      }
      return Promise.resolve({ data: [], error: null });
    }

    return chain;
  }

  return { from: (t) => builder(t), rpc, _db: db, _calls: db.calls };
}

function collect() {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
}

function makeWorker(opts = {}) {
  const db = opts.db || makeDb(opts.dbOverrides || {});
  const admin = opts.admin || makeAdmin(db, opts.adminOpts || {});
  const logger = opts.logger || { log: () => {} };
  const worker = createTradingWorker({
    admin,
    promo: null,
    limits: opts.limits || DEFAULT_LIMITS,
    logger,
    clock: opts.clock || (() => db.serverNowMs),
    rng: opts.rng || (() => 0.5),
    sleep: async () => {},
    workerId: opts.workerId || 'worker-A',
    requireLease: opts.requireLease === undefined ? true : opts.requireLease,
    dryRun: opts.dryRun === true,
  });
  return { worker, admin, db, logger };
}

// ==========================================================================
// 1. Lease acquisition / isolation / expiry
// ==========================================================================
test('lease: one worker claims a session with a DB-timestamped lease, then trades', async () => {
  const { worker, db } = makeWorker({ workerId: 'worker-A' });

  const result = await worker.runOnce();

  const claim = db.calls.rpcs.find((c) => c.name === 'claim_bot_sessions');
  assert.ok(claim, 'the worker must claim work through claim_bot_sessions');
  assert.strictEqual(claim.args.p_worker_id, 'worker-A');
  assert.strictEqual(claim.args.p_lease_ms, DEFAULT_LIMITS.leaseMs);
  assert.strictEqual(db.calls.claim, 1);
  assert.strictEqual(worker.stats.claimed, 1, 'one session claimed');
  assert.strictEqual(db.sessions[0].claimed_by, 'worker-A');
  assert.ok(Date.parse(db.sessions[0].lease_expires_at) > db.serverNowMs, 'lease must be in the future');
  assert.strictEqual(db.calls.trade, 1, 'the claimed session traded exactly once');
  assert.deepStrictEqual(worker.heldLeases(), [{ userId: 1, generation: 0 }]);
  assert.strictEqual(result.results[0].action, 'traded');

  // The lease is renewed (the fence) BEFORE the trade RPC.
  const order = db.calls.rpcs.map((c) => c.name);
  assert.ok(order.indexOf('renew_bot_session_lease') < order.indexOf('record_trade_safe'),
    'the fence must run before the money-moving RPC');
});

test('lease: a second worker cannot claim or trade while the first lease is valid', async () => {
  const db = makeDb();
  const a = makeWorker({ db, workerId: 'worker-A' });
  const b = makeWorker({ db, workerId: 'worker-B' });

  await a.worker.runOnce();
  const tradesAfterA = db.calls.trade;

  await b.worker.runOnce();

  assert.strictEqual(b.worker.stats.claimed, 0, 'B must claim nothing while A holds the lease');
  assert.strictEqual(db.calls.trade, tradesAfterA, 'B must not trade');
  assert.strictEqual(db.sessions[0].claimed_by, 'worker-A', 'ownership must not move');
});

test('lease: a session is reclaimable once the lease expires', async () => {
  const db = makeDb();
  const a = makeWorker({ db, workerId: 'worker-A' });
  await a.worker.runOnce();
  assert.strictEqual(db.sessions[0].claimed_by, 'worker-A');

  // Advance the DATABASE clock past the lease (30s) - the holder is gone.
  db.serverNowMs += DEFAULT_LIMITS.leaseMs + 1;

  const b = makeWorker({ db, workerId: 'worker-B' });
  await b.worker.runOnce();

  assert.strictEqual(b.worker.stats.claimed, 1, 'the expired lease must be reclaimable');
  assert.strictEqual(db.sessions[0].claimed_by, 'worker-B');
  assert.ok(db.calls.trade >= 2, 'the new owner trades');

  // The stale holder can no longer renew: it is now someone else's session.
  const stale = await a.worker.renewLease({ user_id: 1, generation: 0 });
  assert.strictEqual(stale.renewed, false);
  assert.strictEqual(stale.code, 'LEASE_NOT_OWNED');
});

test('lease: a session held from an earlier tick keeps trading without being re-claimed', async () => {
  const { worker, db } = makeWorker({ workerId: 'worker-A' });

  await worker.runOnce(); // tick 1: claim + trade
  const claimsAfter1 = db.calls.claim;
  const tradesAfter1 = db.calls.trade;
  assert.strictEqual(claimsAfter1, 1);
  assert.strictEqual(tradesAfter1, 1);

  await worker.runOnce(); // tick 2: the session is leased, so the claim returns nothing

  assert.strictEqual(db.calls.claim, claimsAfter1 + 1, 'each tick attempts a claim');
  assert.strictEqual(db.calls.trade, tradesAfter1 + 1,
    'a session we still hold MUST keep its 8s cadence (otherwise every session beyond maxClaimsPerTick would go idle until its lease expired)');
  assert.strictEqual(worker.stats.claimed, 1, 'it was claimed exactly once, not re-claimed');
});

test('lease: release hands the lease back immediately', async () => {
  const { worker, db } = makeWorker();
  await worker.runOnce();
  assert.strictEqual(db.sessions[0].claimed_by, 'worker-A');

  const released = await worker.releaseLease(1, 0);
  assert.strictEqual(released, true);
  assert.strictEqual(db.calls.release, 1);
  assert.strictEqual(db.sessions[0].claimed_by, null);
  assert.deepStrictEqual(worker.heldLeases(), []);
});

test('lease: graceful shutdown releases every held lease', async () => {
  const { worker, db } = makeWorker();
  await worker.runOnce();
  assert.strictEqual(db.sessions[0].claimed_by, 'worker-A');

  await worker.stop();

  assert.strictEqual(db.calls.release, 1, 'shutdown must hand the lease back');
  assert.strictEqual(db.sessions[0].claimed_by, null);
});

// ==========================================================================
// 2. Fencing - pure, deterministic, ordered
// ==========================================================================
test('fence: generation mismatch is rejected with a stable code', () => {
  const verdict = evaluateFence({
    workerId: 'w1',
    claimedBy: 'w1',
    leaseExpiresAtMs: 1000,
    serverNowMs: 500,
    expectedGeneration: 2,
    observedGeneration: 3,
    isRunning: 1,
  });
  assert.deepStrictEqual(verdict, { allow: false, code: 'GENERATION_MISMATCH' });
});

test('fence: accept/deny matrix is deterministic and first-failure-ordered', () => {
  const base = {
    workerId: 'w1', claimedBy: 'w1', leaseExpiresAtMs: 1000, serverNowMs: 500,
    expectedGeneration: 0, observedGeneration: 0, isRunning: 1,
  };
  assert.deepStrictEqual(evaluateFence(base), { allow: true, code: null });
  assert.strictEqual(evaluateFence({ ...base, isRunning: 0 }).code, 'SESSION_NOT_RUNNING');
  assert.strictEqual(evaluateFence({ ...base, observedGeneration: 1 }).code, 'GENERATION_MISMATCH');
  assert.strictEqual(evaluateFence({ ...base, claimedBy: null }).code, 'LEASE_UNCLAIMED');
  assert.strictEqual(evaluateFence({ ...base, claimedBy: 'w2' }).code, 'LEASE_NOT_OWNED');
  assert.strictEqual(evaluateFence({ ...base, leaseExpiresAtMs: 400 }).code, 'LEASE_EXPIRED');
  assert.strictEqual(evaluateFence({ ...base, leaseExpiresAtMs: 500 }).code, 'LEASE_EXPIRED', 'boundary: expiry is inclusive');
  // no host clock / client input can make it allow: only the passed DB state
  assert.strictEqual(evaluateFence({ ...base, serverNowMs: NaN }).code, 'LEASE_EXPIRED');
  assert.strictEqual(evaluateFence({ ...base, leaseExpiresAtMs: undefined }).code, 'LEASE_EXPIRED');
  // deterministic: same input, same verdict
  assert.deepStrictEqual(evaluateFence(base), evaluateFence({ ...base }));
});

test('fence: a STOPPED session is rejected before any trade write', async () => {
  const { worker, db } = makeWorker();
  await worker.runOnce();
  const tradesAfterFirst = db.calls.trade;

  // The user stops the bot: is_running flips to 0 between claim and trade.
  db.sessions[0].is_running = 0;
  const out = await worker.tickSession({ user_id: 1, generation: 0 });

  assert.strictEqual(out.action, 'fenced');
  assert.strictEqual(out.code, 'SESSION_NOT_RUNNING');
  assert.strictEqual(worker.stats.fenceRejections, 1);
  assert.strictEqual(db.calls.trade, tradesAfterFirst, 'a stopped session must not trade');
});

test('fence: a GENERATION BUMP (stop/restart/reassignment) is rejected before any trade write', async () => {
  const { worker, db } = makeWorker();
  await worker.runOnce();
  const tradesAfterFirst = db.calls.trade;

  // Stop + restart elsewhere bumps the generation (migration 029 stop RPC).
  db.sessions[0].generation = 1;

  const out = await worker.tickSession({ user_id: 1, generation: 0 });
  assert.strictEqual(out.action, 'fenced');
  assert.strictEqual(out.code, 'GENERATION_MISMATCH');
  assert.strictEqual(db.calls.trade, tradesAfterFirst, 'a stale generation must not trade');

  // The NEW generation may trade again in the same tick bucket (key includes it).
  const ok = await worker.tickSession({ user_id: 1, generation: 1 });
  assert.strictEqual(ok.action, 'traded');
  assert.strictEqual(db.calls.trade, tradesAfterFirst + 1);
  assert.match(db.calls.tradeKeys[db.calls.tradeKeys.length - 1], /^bot_1_live_1_\d+$/);
});

test('fence: requires a fresh claim - an unclaimed/foreign session is rejected', async () => {
  const { worker, db } = makeWorker();

  const unclaimed = await worker.tickSession({ user_id: 1, generation: 0 });
  assert.strictEqual(unclaimed.code, 'LEASE_UNCLAIMED');
  assert.strictEqual(db.calls.trade, 0);

  db.sessions[0].claimed_by = 'somebody-else';
  db.sessions[0].lease_expires_at = iso(db.serverNowMs + 30000);
  const foreign = await worker.tickSession({ user_id: 1, generation: 0 });
  assert.strictEqual(foreign.code, 'LEASE_NOT_OWNED');
  assert.strictEqual(db.calls.trade, 0);
});

test('fence: fails CLOSED when the lease RPC is unavailable (migration 029 absent)', async () => {
  const { worker, db } = makeWorker({ adminOpts: { leaseRpcUnavailable: true } });

  await worker.runOnce();

  assert.strictEqual(db.calls.trade, 0, 'without a lease RPC the worker must execute NOTHING');
  assert.ok(worker.stats.leaseErrors >= 1);
  assert.strictEqual(worker.stats.claimed, 0);
});

// ==========================================================================
// 3. Dry run / shadow mode - provably write-free
// ==========================================================================
test('dry run: writes NOTHING - no trades, no lease RPCs, no session mutations', async () => {
  const db = makeDb({
    sessions: [
      { user_id: 1, is_running: 1, mode: 'live', generation: 0, claimed_by: null, lease_expires_at: null, consecutive_failures: 0, tick_count: 0 },
      { user_id: 2, is_running: 1, mode: 'live', generation: 0, claimed_by: null, lease_expires_at: null, consecutive_failures: 0, tick_count: 0 },
    ],
    wallets: { 1: 1000, 2: 500 },
  });
  const logger = collect();
  const { worker } = makeWorker({ db, logger, dryRun: true });

  await worker.runOnce();
  await worker.runOnce();

  assert.strictEqual(db.calls.trade, 0, 'dry run must never reach the trade RPC');
  assert.strictEqual(db.calls.rpcs.length, 0, 'dry run must not perform ANY rpc (including lease RPCs)');
  assert.strictEqual(db.calls.updates.length, 0, 'dry run must not update sessions (no heartbeat/claim)');
  assert.strictEqual(db.calls.upserts.length, 0);
  assert.strictEqual(db.sessions[0].claimed_by, null, 'dry run must not take a lease');
  assert.strictEqual(db.sessions[0].lease_expires_at, null);
  assert.strictEqual(worker.stats.dryRunTrades, 4, '2 sessions x 2 ticks observed');
  assert.strictEqual(worker.stats.trades, 0);

  const observed = logger.lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'dry_run_trade');
  assert.strictEqual(observed.length, 4);
  assert.strictEqual(observed[0].wouldWrite.rpc, 'record_trade_safe');
  assert.strictEqual(observed[0].wouldWrite.p_mode, 'live');
  assert.ok(Number.isFinite(observed[0].wouldWrite.p_amount));
  assert.match(observed[0].wouldWrite.p_idempotency_key, /^bot_\d+_live_\d+_\d+$/);
});

test('dry run: reconciliation reports what it WOULD stop without writing', async () => {
  const db = makeDb({
    sessions: [{
      user_id: 1, is_running: 1, mode: 'live', generation: 0,
      claimed_by: null, lease_expires_at: null, consecutive_failures: 0, tick_count: 0,
      heartbeat_at: iso(1_699_999_000_000), // stale
    }],
  });
  const logger = collect();
  const { worker } = makeWorker({ db, logger, dryRun: true, limits: { ...DEFAULT_LIMITS, tickMs: 100000 } });

  await worker.start();
  await worker.stop();

  const skipped = logger.lines.map((l) => JSON.parse(l)).find((l) => l.event === 'dry_run_reconcile_skipped');
  assert.ok(skipped, 'dry run must log the reconciliation it skipped');
  assert.deepStrictEqual(skipped.wouldStop, [1]);
  assert.strictEqual(db.calls.updates.length, 0, 'nothing may be written');
  assert.strictEqual(db.sessions[0].is_running, 1, 'the session must be untouched');
});

test('dry run: is OFF by default and cannot run without the master switch', () => {
  assert.strictEqual(DEFAULT_LIMITS.leaseMs > 0, true);
  assert.match(WORKER_ENTRY, /const dryRun = envFlag\('TRADING_WORKER_DRY_RUN'\)/);
  // the master switch is checked BEFORE anything can happen
  const enabledAt = WORKER_ENTRY.indexOf("envFlag('TRADING_WORKER_ENABLED')");
  const dryRunAt = WORKER_ENTRY.indexOf("envFlag('TRADING_WORKER_DRY_RUN')");
  assert.ok(enabledAt >= 0 && dryRunAt > enabledAt);
  assert.match(WORKER_ENTRY, /if \(!enabled\)[\s\S]{0,600}return 0;/);
  // dry run is required to be inert in the engine too
  assert.match(SERVICE_SRC, /if \(dryRun\) {\n      stats\.dryRunTrades\+\+;/);
  assert.match(SERVICE_SRC, /function refuseWrite\(op, extra = \{\}\)/);
});

// ==========================================================================
// 4. Configuration / identity / idempotency
// ==========================================================================
test('lease: requireLease defaults to TRUE and needs a server-configured identity', () => {
  const admin = makeAdmin(makeDb());
  assert.throws(
    () => createTradingWorker({ admin, sleep: async () => {} }),
    /requireLease needs a workerId/,
    'the production-safe default must require the lease AND an identity'
  );
  assert.throws(
    () => createTradingWorker({ admin, workerId: null, sleep: async () => {} }),
    /requireLease needs a workerId/
  );
  assert.doesNotThrow(() => createTradingWorker({ admin, workerId: 'w1', sleep: async () => {} }));
  // and the entrypoint uses the safe posture
  assert.match(WORKER_ENTRY, /requireLease: true,/);
  assert.match(WORKER_ENTRY, /workerId,/);
  assert.match(WORKER_ENTRY, /dryRun,/);
  assert.match(WORKER_ENTRY, /TRADING_WORKER_LEASE_MS/);
});

test('lease identity is server-configured only - no client-controlled ownership', () => {
  // The engine never reads a request, a header, a cookie or any env var itself.
  assert.ok(!/\breq\./.test(SERVICE_SRC), 'the worker must not touch request objects');
  assert.ok(!/headers/i.test(SERVICE_SRC), 'the worker must not read headers');
  assert.ok(!/process\.env/.test(SERVICE_SRC), 'config comes from the entrypoint, not the engine');
  assert.ok(!/localStorage|document\./.test(SERVICE_SRC));

  // Ownership is always the configured identity, never a parameter.
  assert.match(SERVICE_SRC, /p_worker_id: workerId/);
  assert.ok(!/p_worker_id:\s*(body|req|params|query)/.test(SERVICE_SRC));

  // The identity itself is server-side only.
  assert.match(WORKER_ENTRY, /TRADING_WORKER_ID/);
  assert.match(WORKER_ENTRY, /RENDER_INSTANCE_ID/);
  assert.ok(!/req\.(body|headers|query)/.test(WORKER_ENTRY));

  // The web API and the browser cannot claim a lease: nothing exposes these RPCs.
  assert.ok(!/claim_bot_sessions|renew_bot_session_lease|release_bot_session_lease/.test(SERVER),
    'server.js must not expose the lease RPCs');
  assert.ok(!/claim_bot_session/.test(INDEX), 'the frontend must not reference lease claiming');
});

test('idempotency: the generation is part of the key and a retried trade reuses ONE key', async () => {
  assert.strictEqual(buildTickIdempotencyKey(42, 'live', 7), 'bot_42_live_0_7');
  assert.strictEqual(buildTickIdempotencyKey(42, 'live', 7, 3), 'bot_42_live_3_7');
  assert.notStrictEqual(
    buildTickIdempotencyKey(42, 'live', 7, 0),
    buildTickIdempotencyKey(42, 'live', 7, 1),
    'a new generation must not be deduped against the previous executor'
  );

  // A retried/replayed tick keeps the same key, so record_trade_safe dedupes it.
  const db = makeDb();
  const admin = makeAdmin(db, {
    tradeResults: [
      { data: null, error: { message: 'transient' } }, // attempt 1 fails
      { data: { success: true, applied_amount: 0.5, new_balance: 1000.5 }, error: null }, // retry
    ],
  });
  const { worker } = makeWorker({ db, admin });
  await worker.runOnce();

  assert.strictEqual(db.calls.trade, 2, 'the failed attempt is retried once');
  assert.strictEqual(new Set(db.calls.tradeKeys).size, 1, 'the retry must reuse the same idempotency key');
  assert.strictEqual(worker.stats.trades, 1, 'exactly one trade counted');
});

test('lease config: timestamps come from the database clock, not the worker host', () => {
  // Pure helper: expiry is derived from the passed server time + duration.
  assert.strictEqual(leaseExpiresAtMs(1000, 30000), 31000);
  assert.ok(Number.isNaN(leaseExpiresAtMs(1000, 0)), 'a zero/negative lease is invalid');
  assert.ok(Number.isNaN(leaseExpiresAtMs(NaN, 30000)));
  // The engine records the SERVER timestamp returned by the RPC.
  assert.match(SERVICE_SRC, /Date\.parse\(payload\.server_now\)/);
  assert.match(SERVICE_SRC, /serverNowMs/);
  // and the lease RPC calls carry no timestamp at all - the DB owns time.
  assert.ok(!/p_now|p_timestamp|p_server_time/.test(SERVICE_SRC));
});

// ==========================================================================
// 5. Migration 029 - unapplied, guarded, idempotent, service-role only
// ==========================================================================
test('migration 029: exists, is additive/idempotent, and is NOT applied by app code', () => {
  assert.match(MIGRATION_029, /^BEGIN;/m);
  assert.match(MIGRATION_029, /^COMMIT;/m);
  // idempotent constructs
  assert.strictEqual((MIGRATION_029.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 4);
  assert.match(MIGRATION_029, /CREATE INDEX IF NOT EXISTS idx_bot_sessions_claimable/);
  assert.strictEqual((MIGRATION_029.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 4);
  // never creates the table it depends on
  assert.ok(!/CREATE TABLE (IF NOT EXISTS )?public\.bot_sessions/.test(MIGRATION_029));
  // touches nothing money-related and nothing sandbox-related (ignoring comments,
  // which deliberately NAME the non-goals)
  const executableSql = MIGRATION_029
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');
  assert.ok(!/record_trade_safe|wallets|deposits|withdrawals|sandbox_/i.test(executableSql));
  // no application code applies it
  assert.ok(!/029_bot_session_lease/.test(SERVER));
  assert.ok(!/029_bot_session_lease/.test(WORKER_ENTRY));
});

test('migration 029: preconditions are guarded and assumptions are documented', () => {
  assert.match(MIGRATION_029, /to_regclass\('public\.bot_sessions'\) IS NULL/);
  assert.match(MIGRATION_029, /RAISE EXCEPTION 'Migration 029 requires public\.bot_sessions/);
  assert.match(MIGRATION_029, /to_regclass\('public\.bot_worker_control'\) IS NULL/);
  assert.match(MIGRATION_029, /is_running/);
  assert.match(MIGRATION_029, /ASSUMPTIONS ABOUT THE EXISTING bot_sessions SCHEMA/);
  assert.match(MIGRATION_029, /NON-GOALS/);
  assert.match(MIGRATION_029, /ROLLBACK/);
  // last-chance self-check
  assert.match(MIGRATION_029, /self-check failed/);
});

test('migration 029: claim uses SKIP LOCKED, DB time, and the fence code order', () => {
  assert.match(MIGRATION_029, /FOR UPDATE SKIP LOCKED/);
  assert.match(MIGRATION_029, /TIMESTAMPTZ := now\(\)/);
  assert.match(MIGRATION_029, /'server_now', v_now/);
  for (const fn of ['claim_bot_sessions', 'renew_bot_session_lease', 'release_bot_session_lease', 'stop_bot_session_fenced']) {
    assert.match(MIGRATION_029, new RegExp('CREATE OR REPLACE FUNCTION public\\.' + fn));
  }
  // the fence codes match the engine's pure helper, in the same order
  const order = ['SESSION_NOT_RUNNING', 'GENERATION_MISMATCH', 'LEASE_UNCLAIMED', 'LEASE_NOT_OWNED', 'LEASE_EXPIRED']
    .map((c) => MIGRATION_029.indexOf("'" + c + "'"));
  assert.ok(order.every((i) => i > 0), 'every fence code must be present');
  assert.deepStrictEqual(order.slice().sort((a, b) => a - b), order, 'codes must appear in fence order');
});

test('migration 029: service_role only - anon/authenticated cannot touch the lease', () => {
  for (const fn of [
    'claim_bot_sessions\\(TEXT, INTEGER, INTEGER\\)',
    'renew_bot_session_lease\\(BIGINT, TEXT, BIGINT, INTEGER\\)',
    'release_bot_session_lease\\(BIGINT, TEXT, BIGINT\\)',
    'stop_bot_session_fenced\\(BIGINT, TEXT, TEXT\\)',
  ]) {
    assert.match(MIGRATION_029, new RegExp('REVOKE EXECUTE ON FUNCTION public\\.' + fn + ' FROM PUBLIC;'));
    assert.match(MIGRATION_029, new RegExp('REVOKE EXECUTE ON FUNCTION public\\.' + fn + ' FROM anon;'));
    assert.match(MIGRATION_029, new RegExp('GRANT  EXECUTE ON FUNCTION public\\.' + fn + ' TO service_role;'));
  }
  assert.ok(!/GRANT[^;]*TO (anon|authenticated)/.test(MIGRATION_029), 'never grant the lease to a client role');
});

test('contract: lease RPC call sites match migration 029 parameter names', () => {
  // supabase-js sends RPC arguments BY NAME, so a renamed parameter is not a type
  // error - it is a runtime failure the fake client in these tests cannot see.
  // Verified against a real PostgreSQL 17 instance (throwaway cluster) where the
  // migration was applied and these exact calls were exercised.
  const sqlParams = (fn) => {
    const at = MIGRATION_029.indexOf('CREATE OR REPLACE FUNCTION public.' + fn + '(');
    assert.ok(at > -1, fn + ' must be defined by migration 029');
    const head = MIGRATION_029.slice(at, MIGRATION_029.indexOf('RETURNS', at));
    return [...head.matchAll(/^\s*(p_[a-z_]+)\s+(TEXT|INTEGER|BIGINT)/gm)].map((m) => m[1]).sort();
  };
  const callArgs = (fn) => {
    const at = SERVICE_SRC.indexOf("rpc('" + fn + "', {");
    assert.ok(at > -1, fn + ' must be called by the worker');
    const body = SERVICE_SRC.slice(at, SERVICE_SRC.indexOf('})', at));
    return [...body.matchAll(/(p_[a-z_]+)\s*:/g)].map((m) => m[1]).sort();
  };
  for (const fn of ['claim_bot_sessions', 'renew_bot_session_lease', 'release_bot_session_lease']) {
    assert.deepStrictEqual(callArgs(fn), sqlParams(fn),
      fn + ': the named arguments the worker sends must be the SQL parameters');
  }
  // The fenced stop exists but is deliberately NOT wired into any runtime stop
  // path yet, so an explicit stop does not bump the generation today. Verify this
  // before assuming generation fencing covers a partitioned worker at cutover.
  assert.ok(!/stop_bot_session_fenced/.test(SERVICE_SRC), 'the worker does not call the fenced stop yet');
  assert.ok(!/stop_bot_session_fenced/.test(SERVER), 'the server does not call the fenced stop yet');
  assert.deepStrictEqual(sqlParams('stop_bot_session_fenced'), ['p_reason', 'p_requested_by', 'p_user_id']);
});

test('worker entrypoint: no stale migration reference and no secret exposure', () => {
  assert.ok(!/migration 027|027_/.test(WORKER_ENTRY), 'the worker migration is 028 (+029), never 027');
  assert.match(WORKER_ENTRY, /migration 028 must be applied/);
  assert.match(WORKER_ENTRY, /is migration 028 applied\?/);
  // The service key value is only ever READ, presence-checked, or handed to the
  // client constructor. Anything logged is a boolean presence flag.
  assert.match(WORKER_ENTRY, /serviceKeyPresent: false/);
  assert.ok(!/serviceKeyPresent:\s*serviceKey/.test(WORKER_ENTRY));
  const valueUses = WORKER_ENTRY
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /serviceKey/.test(l) && !/serviceKeyPresent/.test(l));
  assert.deepStrictEqual(valueUses, [
    'const serviceKey = process.env.SUPABASE_SERVICE_KEY;',
    "if (!serviceKey || serviceKey.trim() === '') {",
    'const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });',
  ]);
  assert.ok(!/console\.log\([^)]*serviceKey/.test(WORKER_ENTRY));
});
