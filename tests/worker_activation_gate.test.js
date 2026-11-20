'use strict';

/**
 * The TRADING WORKER and the Payhip Live Mode activation gate.
 *
 * The browser path is gated by /api/bot/start and /api/trade. The worker calls
 * record_trade_safe directly, so before this change ANY running session kept
 * trading regardless of entitlement - the bypass this suite pins shut.
 *
 * Contract under test:
 *   - flag off (the default)  -> byte-for-byte the old behaviour, check unused
 *   - entitled                -> trades
 *   - not entitled            -> NO trade, session stopped, reason recorded
 *   - revoked mid-session     -> stops on the next tick
 *   - store unreadable/throws -> NO trade, session KEPT, retried next tick
 *   - dry run                 -> writes nothing at all
 *   - emergency stop          -> still wins over everything
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createTradingWorker, DEFAULT_LIMITS } = require('../services/TradingWorker');
const { createActivationCheck, resolveActivationRequired } = require('../services/PayhipActivation');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const WORKER_SRC = read('services/TradingWorker.js');
const ENTRY_SRC = read('worker.js');
const ACTIVATION_SRC = read('services/PayhipActivation.js');
const ENTITLEMENTS_SRC = read('services/PayhipEntitlements.js');
const ENV_EXAMPLE = read('.env.example');

const silentLogger = { log: () => {} };

// ---------------------------------------------------------------------------
// Minimal query-builder fake. Only the surface the worker touches on a tick.
// ---------------------------------------------------------------------------
function makeFakeAdmin(state = {}) {
  const db = {
    control: state.control || { emergency_stop: false },
    sessions: (state.sessions || []).map((s) => ({ ...s })),
    wallets: state.wallets || {},
    trades: state.trades || {},
  };
  const calls = { selects: [], updates: [], rpcs: [] };

  function builder(table) {
    const ctx = { table, filters: [], op: 'select', payload: null };
    const chain = {
      select() { ctx.op = 'select'; return chain; },
      update(payload) { ctx.op = 'update'; ctx.payload = payload; return chain; },
      eq(col, val) { ctx.filters.push([col, val]); return chain; },
      gte() { return chain; },
      limit() { return chain; },
      single() { return resolve(true); },
      then(f, r) { return resolve(false).then(f, r); },
    };
    const first = (col) => {
      const hit = ctx.filters.find(([c]) => c === col);
      return hit ? hit[1] : undefined;
    };

    function resolve(single) {
      calls.selects.push({ table, op: ctx.op });
      if (ctx.op === 'update') {
        calls.updates.push({ table, payload: ctx.payload, filters: ctx.filters.slice() });
        if (table === 'bot_sessions') {
          for (const s of db.sessions) {
            if (ctx.filters.every(([c, v]) => s[c] === v)) Object.assign(s, ctx.payload);
          }
        }
        return Promise.resolve({ data: null, error: null });
      }
      if (table === 'bot_worker_control') {
        return Promise.resolve({ data: { id: 1, ...db.control }, error: null });
      }
      if (table === 'bot_sessions') {
        const rows = db.sessions.filter((s) => ctx.filters.every(([c, v]) => s[c] === v));
        return Promise.resolve({ data: single ? rows[0] || null : rows, error: null });
      }
      if (table === 'wallets') {
        const uid = first('user_id');
        return Promise.resolve({ data: { user_id: uid, live_balance: db.wallets[uid] || 0 }, error: null });
      }
      if (table === 'trades') {
        const uid = first('user_id');
        return Promise.resolve({ data: (db.trades[uid] || []).map((amount) => ({ amount })), error: null });
      }
      return Promise.resolve({ data: [], error: null });
    }

    return chain;
  }

  return {
    from: (table) => builder(table),
    rpc: (name, args) => {
      calls.rpcs.push({ name, args });
      if (state.rpc) {
        const out = state.rpc(name, args, calls);
        if (out !== undefined) return Promise.resolve(out);
      }
      if (name === 'record_trade_safe') {
        return Promise.resolve({
          data: { success: true, applied_amount: args.p_amount, new_balance: 1000 },
          error: null,
        });
      }
      if (name === 'stop_bot_session_fenced') {
        const row = db.sessions.find((s) => s.user_id === args.p_user_id);
        if (row) { row.is_running = 0; row.stopped_reason = args.p_reason; }
        return Promise.resolve({ data: { success: true, stopped: true, generation: 2 }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    _db: db,
    _calls: calls,
  };
}

function makeWorker(admin, overrides = {}) {
  return createTradingWorker({
    admin,
    promo: null,
    profitPause: null,
    activation: overrides.activation === undefined ? null : overrides.activation,
    limits: overrides.limits || DEFAULT_LIMITS,
    logger: overrides.logger || silentLogger,
    clock: () => 1763680000000,
    rng: () => 0.5,
    sleep: async () => {},
    envEmergencyStop: false,
    // Lease mode is exercised by tests/trading_worker_lease*.js; this suite is
    // about the gate, so it runs the direct path.
    requireLease: false,
    dryRun: overrides.dryRun === true,
  });
}

function session(userId, extra = {}) {
  return { user_id: userId, is_running: 1, generation: 1, consecutive_failures: 0, tick_count: 0, ...extra };
}

const tradesRecorded = (calls) => calls.rpcs.filter((r) => r.name === 'record_trade_safe');

// ---------------------------------------------------------------------------
// 1. Default OFF: the gate must be completely inert
// ---------------------------------------------------------------------------
test('default: without an activation collaborator the worker trades exactly as before', async () => {
  const admin = makeFakeAdmin({ sessions: [session(501)], wallets: { 501: 1000 } });
  const worker = makeWorker(admin, { activation: null });
  const res = await worker.runOnce();
  assert.strictEqual(tradesRecorded(admin._calls).length, 1, 'the pre-existing behaviour must be unchanged');
  assert.strictEqual(res.results[0].action, 'traded');
});

test('default: required=false never calls the entitlement check', async () => {
  let checks = 0;
  const activation = { required: false, check: async () => { checks++; return false; } };
  const admin = makeFakeAdmin({ sessions: [session(502)], wallets: { 502: 1000 } });
  const worker = makeWorker(admin, { activation });
  await worker.runOnce();
  assert.strictEqual(checks, 0, 'a disabled requirement must not touch the entitlement store');
  assert.strictEqual(tradesRecorded(admin._calls).length, 1);
});

// ---------------------------------------------------------------------------
// 2. Enabled: entitled trades, unentitled does not
// ---------------------------------------------------------------------------
test('required + entitled: the session trades normally', async () => {
  const activation = { required: true, check: async () => true };
  const admin = makeFakeAdmin({ sessions: [session(503)], wallets: { 503: 1000 } });
  const worker = makeWorker(admin, { activation });
  await worker.runOnce();
  assert.strictEqual(tradesRecorded(admin._calls).length, 1);
});

test('required + NOT entitled: no trade is written and the session is stopped', async () => {
  const activation = { required: true, check: async () => false };
  const admin = makeFakeAdmin({ sessions: [session(504)], wallets: { 504: 1000 } });
  const worker = makeWorker(admin, { activation });
  const res = await worker.runOnce();

  assert.strictEqual(tradesRecorded(admin._calls).length, 0, 'an unlicensed account must never reach record_trade_safe');
  assert.strictEqual(res.results[0].action, 'stopped');
  assert.strictEqual(res.results[0].code, 'ACTIVATION_REQUIRED');
  const stop = admin._calls.rpcs.find((r) => r.name === 'stop_bot_session_fenced');
  assert.ok(stop, 'the session must be fenced-stopped');
  assert.strictEqual(stop.args.p_reason, 'activation_required');
  assert.strictEqual(worker.stats.activationBlocked, 1);
});

test('required + NOT entitled: the session is stopped BEFORE any balance is read', async () => {
  const activation = { required: true, check: async () => false };
  const admin = makeFakeAdmin({ sessions: [session(505)], wallets: { 505: 1000 } });
  const worker = makeWorker(admin, { activation });
  await worker.runOnce();
  const walletReads = admin._calls.selects.filter((s) => s.table === 'wallets');
  assert.strictEqual(walletReads.length, 0, 'no trading inputs should be read for an ineligible account');
});

// ---------------------------------------------------------------------------
// 3. Revocation mid-session
// ---------------------------------------------------------------------------
test('a licence revoked mid-session stops trading on the next tick', async () => {
  let entitled = true;
  const activation = { required: true, check: async () => entitled };
  const admin = makeFakeAdmin({
    sessions: [session(506)],
    wallets: { 506: 1000 },
    rpc: (name, args, calls) => {
      // Keep the session "running" after the tick so a second tick happens.
      if (name === 'stop_bot_session_fenced') return { data: { success: true, stopped: true, generation: 2 }, error: null };
      return undefined;
    },
  });
  const worker = makeWorker(admin, { activation });

  await worker.runOnce();
  assert.strictEqual(tradesRecorded(admin._calls).length, 1, 'tick 1: licensed -> one trade');

  entitled = false; // the customer was refunded
  admin._db.sessions[0].is_running = 1;
  await worker.runOnce();

  assert.strictEqual(tradesRecorded(admin._calls).length, 1, 'tick 2: revoked -> no further ledger row');
  assert.strictEqual(worker.stats.activationBlocked, 1);
});

// ---------------------------------------------------------------------------
// 4. Fail-safe: an unreadable store stops trading but not the customer
// ---------------------------------------------------------------------------
test('required + unreadable store: no trade, session kept, retried next tick', async () => {
  let answer = null; // unknown
  const activation = { required: true, check: async () => answer };
  const admin = makeFakeAdmin({ sessions: [session(507)], wallets: { 507: 1000 } });
  const worker = makeWorker(admin, { activation });

  const first = await worker.runOnce();
  assert.strictEqual(tradesRecorded(admin._calls).length, 0);
  assert.strictEqual(first.results[0].action, 'skipped');
  assert.strictEqual(first.results[0].code, 'ACTIVATION_UNAVAILABLE');
  assert.strictEqual(worker.stats.activationUnknown, 1);
  assert.strictEqual(
    admin._calls.rpcs.filter((r) => r.name === 'stop_bot_session_fenced').length,
    0,
    'a transient read error must NOT kill a legitimate customer\'s session'
  );

  answer = true; // the store recovers
  const second = await worker.runOnce();
  assert.strictEqual(tradesRecorded(admin._calls).length, 1, 'recovery resumes trading');
  assert.strictEqual(second.results[0].action, 'traded');
});

test('required + the check throws: treated as unknown, never as unlicensed', async () => {
  const activation = { required: true, check: async () => { throw new Error('network down'); } };
  const admin = makeFakeAdmin({ sessions: [session(508)], wallets: { 508: 1000 } });
  const worker = makeWorker(admin, { activation });
  const res = await worker.runOnce();
  assert.strictEqual(tradesRecorded(admin._calls).length, 0);
  assert.strictEqual(res.results[0].code, 'ACTIVATION_UNAVAILABLE');
  assert.strictEqual(admin._calls.rpcs.filter((r) => r.name === 'stop_bot_session_fenced').length, 0);
});

// ---------------------------------------------------------------------------
// 5. Dry run and emergency stop still win
// ---------------------------------------------------------------------------
test('dry run with the gate on writes nothing at all', async () => {
  const activation = { required: true, check: async () => false };
  const admin = makeFakeAdmin({ sessions: [session(509)], wallets: { 509: 1000 } });
  const worker = makeWorker(admin, { activation, dryRun: true });
  const res = await worker.runOnce();
  assert.strictEqual(tradesRecorded(admin._calls).length, 0);
  assert.strictEqual(admin._calls.rpcs.filter((r) => r.name === 'stop_bot_session_fenced').length, 0);
  assert.strictEqual(res.results[0].code, 'ACTIVATION_REQUIRED');
});

test('the emergency stop is evaluated before the activation gate', async () => {
  let checks = 0;
  const activation = { required: true, check: async () => { checks++; return true; } };
  const admin = makeFakeAdmin({ sessions: [session(510)], wallets: { 510: 1000 }, control: { emergency_stop: true } });
  const worker = makeWorker(admin, { activation });
  const res = await worker.runOnce();
  assert.strictEqual(res.skipped, true);
  assert.strictEqual(checks, 0, 'a stopped platform must not consult entitlements at all');
  assert.strictEqual(tradesRecorded(admin._calls).length, 0);
});

// ---------------------------------------------------------------------------
// 6. The check module itself
// ---------------------------------------------------------------------------
test('createActivationCheck: tri-state contract', async () => {
  const mk = (rpcImpl) => createActivationCheck({ admin: { rpc: rpcImpl }, required: true });

  assert.strictEqual(await mk(async () => ({ data: true, error: null })).check(1), true);
  assert.strictEqual(await mk(async () => ({ data: false, error: null })).check(1), false);
  assert.strictEqual(await mk(async () => ({ data: null, error: { message: 'boom' } })).check(1), null, 'error is UNKNOWN, not "no"');
  assert.strictEqual(await mk(async () => { throw new Error('offline'); }).check(1), null);
  assert.strictEqual(await mk(async () => ({ data: 'yes', error: null })).check(1), false, 'only a real true is proof');
  assert.strictEqual(await mk(async () => ({ data: true, error: null })).check(null), false);
});

test('createActivationCheck: refuses to be built without a client, and defaults to OFF', () => {
  assert.throws(() => createActivationCheck({}), /service-role Supabase client/);
  const off = createActivationCheck({ admin: { rpc: async () => ({ data: true, error: null }) } });
  assert.strictEqual(off.required, false);
});

test('resolveActivationRequired parses exactly like the web service', () => {
  assert.strictEqual(resolveActivationRequired({}), false);
  assert.strictEqual(resolveActivationRequired({ PAYHIP_ACTIVATION_REQUIRED: '' }), false);
  assert.strictEqual(resolveActivationRequired({ PAYHIP_ACTIVATION_REQUIRED: 'false' }), false);
  assert.strictEqual(resolveActivationRequired({ PAYHIP_ACTIVATION_REQUIRED: '1' }), false);
  assert.strictEqual(resolveActivationRequired({ PAYHIP_ACTIVATION_REQUIRED: ' true ' }), true);
  assert.strictEqual(resolveActivationRequired({ PAYHIP_ACTIVATION_REQUIRED: 'TRUE' }), true);
});

test('the worker check uses the SAME database function as the web resolver', () => {
  assert.match(ACTIVATION_SRC, /admin\.rpc\('payhip_has_live_activation'/);
  assert.match(ENTITLEMENTS_SRC, /admin\.rpc\('payhip_has_live_activation'/);
  // both treat a failed read as unknown rather than as "not licensed"
  assert.match(ACTIVATION_SRC, /if \(error\) return null/);
  assert.match(ENTITLEMENTS_SRC, /if \(error\) return null/);
});

test('the gate sits inside tickSession and before the money-moving RPC', () => {
  const gate = WORKER_SRC.indexOf('LIVE MODE ACTIVATION GATE (Payhip)');
  const rpc = WORKER_SRC.indexOf("rpc('record_trade_safe'");
  const tick = WORKER_SRC.indexOf('async function tickSession');
  assert.ok(gate > tick, 'the gate must live in the tick');
  assert.ok(gate < rpc, 'the gate must precede record_trade_safe');
  assert.match(WORKER_SRC, /if \(activation && activation\.required === true\)/);
  assert.match(WORKER_SRC, /stopSession\(userId, 'activation_required'\)/);
});

test('worker.js wires the gate from env and makes its own view of it visible', () => {
  assert.match(ENTRY_SRC, /createActivationCheck\(\{ admin, required: resolveActivationRequired\(\) \}\)/);
  assert.match(ENTRY_SRC, /^\s+activation,$/m);
  assert.match(ENTRY_SRC, /event: 'worker_activation_gate'/);
  assert.match(ENTRY_SRC, /required: activation\.required/);
});

test('the both-services rule is documented where operators look', () => {
  assert.match(ENV_EXAMPLE, /SET IT ON BOTH SERVICES, OR ON NEITHER/);
});

test('the gate touches no wallet, ledger or sandbox object', () => {
  // Comments explain WHY (they name record_trade_safe); only code counts here.
  const code = ACTIVATION_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/sandbox/i.test(code), 'activation check must never reference the sandbox');
  assert.ok(!/from\('wallets'\)|live_balance|record_trade_safe/.test(code),
    'the check module must be read-only');
});
