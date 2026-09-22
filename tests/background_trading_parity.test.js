/**
 * BACKGROUND TRADING (the user-visible goal) - WITH BUSINESS-LOGIC PARITY.
 *
 * Goal: a LIVE bot keeps trading when the user closes the tab, because execution
 * moves from the browser loop to the durable server-side worker.
 *
 * Hard requirement (management): the move must NOT change what the platform does
 * for users. These tests pin that:
 *   1. the server produces the SAME trade as the browser engine for the same draw
 *      (formula, draw order, asset labels, rounding, cadence);
 *   2. the worker's optional safety rails are INERT by default, because the
 *      browser loop has no such limits (enabling them is a management decision);
 *   3. the tab/server handover can never double-trade and can never silently stop
 *      a user's bot;
 *   4. nothing else in the platform was touched (no new endpoint, no sandbox
 *      change, no payment/withdrawal/KYC change).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_LIMITS,
  computeTradeAmount,
  evaluateRisk,
  createTradingWorker,
} = require('../services/TradingWorker');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SERVICE = read('services/TradingWorker.js');
const INDEX = read('public/index.html');
const SERVER = read('server.js');
const MIGRATION_029 = read('supabase/migrations/029_bot_session_lease.sql');

// ---------------------------------------------------------------------------
// The production browser engine, transcribed from public/index.html
// (executeBotTrade). This is the reference: the worker must equal it.
// ---------------------------------------------------------------------------
const browserProfit = (balance, rMag, rSign) =>
  balance * 0.5 * (rMag * 2.4 / 100) * (rSign > 0.35 ? 1 : -0.5);
const browserRound = (n) => Math.round(n * 100) / 100;
const BALANCES = [1, 7.5, 50, 143, 250, 1000, 4167, 12345.67, 250000, 1000000];
const DRAWS = [
  [0, 0], [0.1, 0.2], [0.25, 0.34], [0.25, 0.36], [0.35, 0.35],
  [0.5, 0.5], [0.75, 0.8], [0.9, 0.1], [0.99, 0.99], [0.6, 0.2],
];

function makeRng(seq) {
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)];
}

// ---------------------------------------------------------------------------
// Minimal fake Supabase client for the legacy (list-running-sessions) path.
// ---------------------------------------------------------------------------
function makeWorker(opts = {}) {
  const state = {
    sessions: opts.sessions || [{ user_id: 1, is_running: 1, mode: 'live' }],
    wallets: opts.wallets || { 1: 1000 },
    trades: opts.trades || [],
    rpcs: [],
    updates: [],
  };
  const builder = (table) => {
    const ctx = { filters: [], op: 'select', payload: null };
    const chain = {
      select() { return chain; },
      update(p) { ctx.op = 'update'; ctx.payload = p; return chain; },
      upsert(p) { ctx.op = 'update'; ctx.payload = p; return chain; },
      insert(p) { ctx.op = 'update'; ctx.payload = p; return chain; },
      eq(c, v) { ctx.filters.push([c, v]); return chain; },
      gte() { return chain; },
      limit() { return chain; },
      single() { return resolve(true); },
      then(ok, err) { return resolve(false).then(ok, err); },
    };
    const match = (r) => ctx.filters.every(([c, v]) => r[c] === v);
    function resolve(single) {
      if (ctx.op === 'update') {
        state.updates.push({ table, payload: ctx.payload });
        if (table === 'bot_sessions') for (const s of state.sessions) if (match(s)) Object.assign(s, ctx.payload);
        return Promise.resolve({ data: null, error: null });
      }
      if (table === 'bot_worker_control') return Promise.resolve({ data: { id: 1, emergency_stop: false }, error: null });
      if (table === 'wallets') {
        const uid = (ctx.filters.find((f) => f[0] === 'user_id') || [])[1];
        return Promise.resolve({ data: { user_id: uid, live_balance: state.wallets[uid] || 0 }, error: null });
      }
      if (table === 'trades') return Promise.resolve({ data: state.trades.map((amount) => ({ amount })), error: null });
      const out = (table === 'bot_sessions' ? state.sessions : []).filter(match);
      return Promise.resolve({ data: single ? out[0] || null : out, error: null });
    }
    return chain;
  };
  const admin = {
    from: (t) => builder(t),
    rpc: (name, args) => {
      state.rpcs.push({ name, args });
      // Mirrors public.stop_bot_session_fenced: stop the row, bump the generation,
      // clear the lease - so a reconciled session is really stopped, and a stale
      // holder of the old generation can never renew it again.
      if (name === 'stop_bot_session_fenced') {
        const row = state.sessions.find((s) => s.user_id === args.p_user_id);
        if (!row) return Promise.resolve({ data: { success: true, stopped: false, generation: null }, error: null });
        row.is_running = 0;
        row.generation = Number(row.generation || 0) + 1;
        row.claimed_by = null;
        row.lease_acquired_at = null;
        row.lease_expires_at = null;
        row.stopped_reason = args.p_reason;
        return Promise.resolve({ data: { success: true, stopped: true, generation: row.generation }, error: null });
      }
      return Promise.resolve({ data: { success: true, applied_amount: args.p_amount, new_balance: 1000 }, error: null });
    },
  };
  const worker = createTradingWorker({
    admin,
    promo: null,
    limits: opts.limits || DEFAULT_LIMITS,
    logger: { log: () => {} },
    clock: opts.clock || (() => 1_700_000_000_000),
    rng: opts.rng || (() => 0.5),
    sleep: async () => {},
    workerId: 'parity-worker',
    requireLease: false, // the legacy path == what the browser loop does today
    dryRun: false,
  });
  return { worker, state };
}

const tradeCall = (state) => state.rpcs.find((r) => r.name === 'record_trade_safe');
const startBotBody = () => {
  const start = INDEX.indexOf('function startBot()');
  return INDEX.slice(start, INDEX.indexOf('function updateBotEngineNotice'));
};
// Code-only view, so negatives ("no stop here") cannot trip over explanatory comments.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// ==========================================================================
// 1. FORMULA PARITY - the same draw must produce the same trade
// ==========================================================================
test('parity: the worker reproduces the browser profit formula for every draw', () => {
  for (const bal of BALANCES) {
    for (const [rMag, rSign] of DRAWS) {
      const rng = makeRng([0.42, rMag, rSign]); // asset draw first, exactly like the tab
      rng();
      const mine = computeTradeAmount(bal, DEFAULT_LIMITS, rng);
      const expected = browserRound(browserProfit(bal, rMag, rSign));
      assert.strictEqual(mine, expected,
        'balance ' + bal + ' draw ' + rMag + '/' + rSign + ' -> worker ' + mine + ' vs browser ' + expected);
    }
  }
});

test('parity: losses are HALF the size of the equivalent win (browser -0.5 factor)', () => {
  for (const bal of [100, 1000, 25000]) {
    for (const rMag of [0.05, 0.3, 0.6, 0.95]) {
      const win = computeTradeAmount(bal, DEFAULT_LIMITS, makeRng([rMag, 0.9]));
      const loss = computeTradeAmount(bal, DEFAULT_LIMITS, makeRng([rMag, 0.1]));
      assert.ok(win > 0, 'win must be positive');
      assert.ok(loss < 0, 'loss must be negative');
      assert.strictEqual(browserRound(Math.abs(loss)), browserRound(Math.abs(win) / 2),
        'loss must be half the win (got ' + loss + ' vs ' + win + ')');
    }
  }
});

test('parity: the browser formula, cadence and draw order are UNCHANGED', () => {
  // The browser engine itself was not touched by this work.
  assert.match(INDEX, /const profit = data\.balance \* 0\.5 \* \(Math\.random\(\)\*2\.4\/100\) \* \(Math\.random\(\)>0\.35 \? 1 : -0\.5\);/);
  assert.match(INDEX, /setInterval\(executeBotTrade, 8000\)/);
  assert.strictEqual(DEFAULT_LIMITS.tickMs, 8000, 'the server ticks at the browser cadence');

  // The tab draws the asset, then the magnitude, then the sign - and so does the
  // worker, so a seeded RNG would replay the identical sequence.
  const at = SERVICE.indexOf('// Draw order mirrors the browser engine EXACTLY');
  assert.ok(at > 0, 'the draw-order comment must exist');
  const tickBody = SERVICE.slice(at, at + 900);
  assert.match(tickBody, /const asset = ASSETS\[Math\.floor\(rng\(\) \* ASSETS\.length\)\];/);
  assert.ok(tickBody.indexOf('const asset = ASSETS') < tickBody.indexOf('const amount = computeTradeAmount'),
    'the asset is drawn BEFORE the amount, exactly like the browser');
});

test('parity: the asset metadata is character-identical to the UI list', () => {
  const uiRaw = [...INDEX.matchAll(/\{symbol:'([^']+)',detail:'([^']+)'\}/g)].map((m) => [m[1], m[2]]);
  const workerRaw = [...SERVICE.matchAll(/\{ symbol: '([^']+)', detail: '([^']*)' \}/g)]
    .map((m) => [m[1], JSON.parse('"' + m[2] + '"')]); // decode the \u2192 escapes
  assert.strictEqual(uiRaw.length, 5, 'the UI list must have 5 assets');
  assert.deepStrictEqual(workerRaw, uiRaw, 'symbols and details must match the UI list exactly');
});

test('parity: the runtime payload carries the browser asset labels and the same RPC fields', async () => {
  const { worker, state } = makeWorker({ rng: makeRng([0.99, 0.5, 0.9]) });
  await worker.runOnce();
  const call = tradeCall(state);
  assert.ok(call, 'the tick must reach the ledger');
  // asset index floor(0.99*5) = 4
  assert.strictEqual(call.args.p_asset, 'XAU/USD');
  assert.strictEqual(call.args.p_detail, 'Spot\u2192Futures');
  assert.strictEqual(call.args.p_mode, 'live');
  // /api/trade posts exactly these fields to the same RPC, so the user's history
  // and P&L render identically whichever engine executed the trade.
  for (const k of ['p_user_id', 'p_amount', 'p_idempotency_key', 'p_mode', 'p_asset', 'p_detail']) {
    assert.ok(Object.prototype.hasOwnProperty.call(call.args, k), 'missing ' + k);
  }
  assert.ok(Math.abs(call.args.p_amount * 100 - Math.round(call.args.p_amount * 100)) < 1e-6, 'amount is 2dp');
  assert.match(SERVER, /p_amount: amount2dp,/);
});

// ==========================================================================
// 2. RAILS INERT BY DEFAULT - no user-visible behaviour change
// ==========================================================================
test('parity: the optional rails are disabled by default (the browser has none)', () => {
  assert.ok(!Number.isFinite(DEFAULT_LIMITS.maxAbsTradeUsd), 'no absolute trade ceiling by default');
  assert.ok(!Number.isFinite(DEFAULT_LIMITS.dailyLossLimitUsd), 'no daily loss stop by default');
  assert.ok(!Number.isFinite(DEFAULT_LIMITS.maxTradesPerDay), 'no trades-per-day cap by default');
  assert.strictEqual(DEFAULT_LIMITS.lossScaleFactor, 0.5, "the browser's -0.5 losing factor");
  assert.strictEqual(DEFAULT_LIMITS.maxTradePctOfBalance, 0.5, "the browser's leading 0.5 factor");
});

test('parity: a very active or very losing day never stops the bot by default', async () => {
  // 1000 recorded trades today, all losses: the browser would keep trading.
  const { worker, state } = makeWorker({
    trades: new Array(1000).fill(-50),
    rng: makeRng([0.5, 0.5, 0.9]),
  });
  const res = await worker.runOnce();
  assert.strictEqual(res.results[0].action, 'traded', 'the bot must keep trading (parity)');
  assert.ok(tradeCall(state), 'the trade must reach the ledger');
  // the rails still exist and still fire when explicitly enabled
  const rails = { ...DEFAULT_LIMITS, dailyLossLimitUsd: 100 };
  const veto = evaluateRisk({
    balance: 1000, realizedToday: -50000, tradesToday: 1, promoCreditFunded: false, promoProfit: 0,
    limits: rails, isPromoProfitCapReached: () => false,
  });
  assert.strictEqual(veto.code, 'DAILY_LOSS_LIMIT');
});

test('parity: the promotional-credit cap is unchanged existing production logic', () => {
  // The worker consumes the SAME rule as the server (injected, not reimplemented).
  assert.match(SERVICE, /isPromoProfitCapReached/);
  assert.match(SERVER, /isPromoProfitCapReached\(promoCreditFunded, promoProfit\)/);
  assert.match(SERVER, /const PROMO_PROFIT_CAP_USD = 20;/);
  assert.match(read('services/PromoCheck.js'), /const PROMO_PROFIT_CAP_USD = 20;/);
});

test('parity: a trade that rounds to zero is skipped, like the rejected tab request', async () => {
  // The browser POSTs amount: 0, /api/trade answers 400 and writes nothing.
  assert.match(SERVER, /amount === 0/);
  const { worker, state } = makeWorker({
    wallets: { 1: 0.1 }, // the magnitude rounds to 0.00
    rng: makeRng([0.5, 0.01, 0.1]),
  });
  const res = await worker.runOnce();
  assert.strictEqual(res.results[0].code, 'ZERO_AMOUNT');
  assert.strictEqual(state.rpcs.length, 0, 'no ledger write for a zero trade');
});

// ==========================================================================
// 3. THE HANDOVER - "close the tab, keep trading" without double-trading
// ==========================================================================
test('handover: starting the bot registers the session server-side (live only)', () => {
  const body = startBotBody();
  assert.match(body, /syncBotSessionWithServer\('start'\)/);
  assert.match(body, /if \(!\(APP\.mode === 'live' && APP\.environment !== 'MARKETING_SANDBOX'\)\)/);
  // DEMO / sandbox has no server-side gate, so it still starts immediately.
  const demo = body.slice(0, body.indexOf("syncBotSessionWithServer('start')"));
  assert.match(demo, /if \(!\(APP\.mode === 'live' && APP\.environment !== 'MARKETING_SANDBOX'\)\) \{\s*beginBotRun\(\);\s*return;/,
    'demo/sandbox starts immediately');
  // ORDERING (deliberate): the LIVE start is validated by the server BEFORE the
  // running state is entered, so a refused start can produce no success state
  // (profit pause). An accepted start still enters the running state before the
  // worker-status handover, and a NULL result (offline / server error) falls
  // through to beginBotRun() - so a slow or failing request never blocks a bot.
  const live = body.slice(body.indexOf("syncBotSessionWithServer('start')"));
  assert.ok(live.indexOf('isProfitPausePayload(res.body)') > 0
    && live.indexOf('isProfitPausePayload(res.body)') < live.indexOf('beginBotRun();'),
    'the pause branch must precede the running state');
  assert.ok(live.indexOf('beginBotRun();') < live.indexOf('fetchBotExecutionStatus'),
    'an accepted start enters the running state before the worker handover');
  assert.match(body, /\.catch\(function \(\) \{\}\);/);
});

test('handover: a worker-owned session keeps the bot RUNNING but drops the tab loop', () => {
  const body = startBotBody();
  const handover = body.slice(body.indexOf("syncBotSessionWithServer('start')"));
  assert.match(handover, /st\.executedBy !== 'worker'/);
  assert.match(handover, /adoptWorkerOwnership\(\)/,
    'the tab loop is dropped (and the bot kept RUNNING) by the shared yield helper');
  assert.ok(!/stopBot\(/.test(stripComments(handover)), 'the handover must not stop the session it just handed over');
});

test('handover: a fresh tab adopts an already-running server session', () => {
  assert.match(INDEX, /function adoptServerBotState\(\)/);
  const helper = INDEX.slice(INDEX.indexOf('function adoptServerBotState'), INDEX.indexOf('function startBot()'));
  assert.match(helper, /if \(!st \|\| !st\.isRunning \|\| st\.executedBy !== 'worker'\) return;/);
  assert.match(helper, /adoptWorkerOwnership\(\)/);
  // The call sits inside initApp AFTER the Demo -> Live decision. A funded
  // account is switched to Live during init, so adopting earlier would silently
  // skip it (a bug the browser harness caught: the UI then showed "stopped"
  // while the server was trading).
  const init = INDEX.slice(INDEX.indexOf('async function initApp()'));
  const adoptAt = init.indexOf('adoptServerBotState();');
  assert.ok(adoptAt > 0, 'initApp must adopt the server-side session state');
  const modeAt = init.indexOf("if (syncResult.funded && APP.mode === 'demo')");
  assert.ok(modeAt > 0 && adoptAt > modeAt, 'adoption must run after the mode is resolved');
  assert.ok(adoptAt > init.indexOf('await syncWalletFromServer()'), 'adoption must run after the wallet sync');
});

test('handover: an explicit Stop ends the server session', () => {
  assert.match(INDEX, /function stopBot\(\)/);
  const stopBody = INDEX.slice(INDEX.indexOf('function stopBot()'), INDEX.indexOf('function toggleBot()'));
  assert.match(stopBody, /syncBotSessionWithServer\('stop'\);/);
  // A stop is a stop: the user-visible "paused" feedback stays (unchanged).
  assert.match(stopBody, /data\.history\.unshift\(\{type:'Bot',detail:'Paused'/);
  assert.match(INDEX, /if\(APP\.botRunning\) stopBot\(\);/); // switching mode stops it for real
});

test('handover: logout ends the server session while the token still exists', () => {
  const after = INDEX.indexOf("'/api/auth/logout'");
  const stopAt = INDEX.indexOf("syncBotSessionWithServer('stop');", after);
  assert.ok(stopAt > 0, 'logout must end the server session');
  const clearAt = INDEX.indexOf('localStorage.removeItem', after);
  assert.ok(clearAt > 0 && stopAt < clearAt, 'the stop call must happen before the token is cleared');
  assert.match(INDEX.slice(stopAt - 300, stopAt + 100), /APP\.botRunning = false;/);
});

test('handover: the 409 yield keeps the session alive so the worker keeps trading', () => {
  const at = INDEX.indexOf("errBody.code === 'WORKER_OWNED_SESSION'");
  assert.ok(at > 0, 'the 409 path must still exist');
  const block = INDEX.slice(at, at + 900);
  assert.match(block, /adoptWorkerOwnership\(\)/);
  assert.ok(!/stopBot\(/.test(stripComments(block)),
    'yielding must not go through stopBot: that would end the server session, write a "Bot Paused" history entry and show a "paused" toast for a bot that is still trading');
  assert.match(SERVER, /const WORKER_OWNED_CODE = 'WORKER_OWNED_SESSION';/);
});

test('handover: the yield helper never implies a stop (no pause entry, no pause toast)', () => {
  const helper = stripComments(INDEX.slice(INDEX.indexOf('function adoptWorkerOwnership()'), INDEX.indexOf('function adoptServerBotState()')));
  assert.match(helper, /clearInterval\(APP\.botInterval\)/);
  assert.match(helper, /APP\.botRunning = true;/, 'the bot is still running - on the server');
  assert.match(helper, /APP\.botExecutedBy = 'worker';/);
  assert.match(helper, /updateBotEngineNotice\('worker'\)/);
  assert.ok(!/Paused/.test(helper), 'no "Bot Paused" history entry on a yield');
  assert.ok(!/bot\.paused/.test(helper), 'no "paused" toast on a yield');
  assert.ok(!/syncBotSessionWithServer/.test(helper), 'a yield never ends the server session');
  assert.ok(!/updateStatus\(false\)/.test(helper));
  assert.ok(!/botStop/.test(helper), 'no stop sound on a yield');
  // ...and all worker-owned transitions use it, so they cannot diverge.
  assert.strictEqual((stripComments(INDEX).match(/adoptWorkerOwnership\(\)/g) || []).length, 5,
    'definition + 409 yield + fresh-tab adoption + startBot handover + sync-loop worker discovery');
});

test('handover: the server guard is heartbeat-based and fails OPEN', () => {
  const at = SERVER.indexOf('async function isWorkerOwnedSession');
  assert.ok(at > 0);
  const guard = SERVER.slice(at, at + 1200);
  assert.match(guard, /heartbeat_at/);
  assert.match(guard, /catch \(e\)/);
  assert.match(guard, /return false;/, 'an unreadable session must never block the browser engine');
  // migration 029 makes the CLAIM announce liveness, closing the window between
  // "a worker owns it" and "the worker has ticked" (no double-trade window).
  assert.match(MIGRATION_029, /heartbeat_at      = v_now,/);
});

// ==========================================================================
// 4. BROWSER-ERA SESSIONS + FAILURE PATHS (read-only review, checkpoint)
// ==========================================================================
test('browser-era sessions are reconciled to a support-visible stopped reason', async () => {
  // Rows written by the old browser engine have NO heartbeat, so they can never
  // have a live executor. The worker marks them stopped at startup.
  const { worker, state } = makeWorker({
    sessions: [
      { user_id: 3, is_running: 1, heartbeat_at: null }, // browser-era row
      { user_id: 4, is_running: 1, heartbeat_at: new Date(1_700_000_000_000 - 1000).toISOString() },
    ],
  });
  const reconciled = await worker.reconcileStaleSessions(1_700_000_000_000);
  assert.strictEqual(reconciled, 1, 'only the never-heartbeated row is reconciled');
  const browserEra = state.sessions.find((s) => s.user_id === 3);
  assert.strictEqual(browserEra.is_running, 0, 'the browser-era session is stopped');
  assert.strictEqual(browserEra.stopped_reason, 'stale_heartbeat_reconciled',
    'the reason is persisted so support can explain it');
  // and it is surfaced by the API the UI reads
  assert.match(SERVER, /stoppedReason: data \? \(data\.stopped_reason \|\| null\) : null/);
  assert.match(SERVICE, /stopSession\(s\.user_id, 'stale_heartbeat_reconciled'\)/);
});

test('a stopped or browser-era session can never be shown as RUNNING', () => {
  // Adoption is gated on BOTH conditions on both paths, so isRunning:false or
  // executedBy:'browser' leaves the UI in its stopped state.
  const adopt = INDEX.slice(INDEX.indexOf('function adoptServerBotState'), INDEX.indexOf('function startBot()'));
  const handover = startBotBody().slice(startBotBody().indexOf("syncBotSessionWithServer('start')"));
  for (const body of [adopt, handover]) {
    assert.match(body, /!st\.isRunning \|\| st\.executedBy !== 'worker'/,
      'adoption requires a RUNNING session with a worker heartbeat');
  }
  // STOPPING clears the UI unconditionally, and the initial state is stopped.
  const stopBody = INDEX.slice(INDEX.indexOf('function stopBot()'), INDEX.indexOf('function toggleBot()'));
  assert.match(stopBody, /APP\.botRunning = false;/);
  assert.match(stopBody, /updateStatus\(false\)/);
  assert.match(INDEX, /mode: 'demo', botRunning: false, botInterval: null,/);
  // the server computes isRunning from the row, so a reconciled row reports false
  assert.match(SERVER, /isRunning: data \? data\.is_running===1 : false/);
});

test('a FAILED status request leaves exactly one engine, whichever one it is', async () => {
  // The status helpers never reject: every failure mode resolves to null.
  assert.match(INDEX, /\.catch\(function \(\) \{ return null; \}\)/);
  // 1) If a worker really owns the session, a failed read can only mean the tab
  //    keeps looping - and the server then REFUSES its trades with 409, which
  //    makes the tab yield. So the worker stays the single executor.
  const at409 = INDEX.indexOf("errBody.code === 'WORKER_OWNED_SESSION'");
  assert.ok(at409 > 0);
  assert.match(INDEX.slice(at409, at409 + 900), /adoptWorkerOwnership\(\)/);
  assert.match(SERVER, /const WORKER_OWNED_CODE = 'WORKER_OWNED_SESSION';/);
  // 2) Only a POSITIVE worker confirmation may drop the tab loop: the guard runs
  //    before the yield helper on both paths.
  for (const body of [
    INDEX.slice(INDEX.indexOf('function adoptServerBotState'), INDEX.indexOf('function startBot()')),
    startBotBody().slice(startBotBody().indexOf("syncBotSessionWithServer('start')")),
  ]) {
    const guardAt = body.indexOf("st.executedBy !== 'worker'");
    const yieldAt = body.indexOf('adoptWorkerOwnership()');
    assert.ok(guardAt >= 0 && yieldAt > guardAt, 'the worker check must precede dropping the tab loop');
  }
  // 3) A failed read also never STOPS anything: the handover paths contain no
  //    stopping call (only the explicit 409 yield and user actions do).
  assert.ok(!/stopBot\(/.test(stripComments(startBotBody().slice(startBotBody().indexOf("syncBotSessionWithServer('start')")))));
  // and with no worker at all the guard fails open, so the tab engine is the one
  // and only executor (verified in the harness: S4/S5/S6).
  const guard = SERVER.slice(SERVER.indexOf('async function isWorkerOwnedSession'), SERVER.indexOf('async function isWorkerOwnedSession') + 1200);
  assert.match(guard, /return false;/);
});

// ==========================================================================
// 5. NOTHING ELSE MOVED
// ==========================================================================
test('scope: no new endpoint was added and the bot API is the only new traffic', () => {
  const routes = [...SERVER.matchAll(/app\.(?:get|post)\('(\/api\/bot\/[a-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(routes, ['/api/bot/start', '/api/bot/status', '/api/bot/stop'],
    'the pre-existing bot API set must be unchanged');
  assert.match(INDEX, /fetch\('\/api\/bot\/status'/);
  assert.match(INDEX, /fetch\('\/api\/bot\/' \+ action/);
});

test('scope: sandbox accounts are never registered or stopped from the UI', () => {
  const helpers = INDEX.slice(INDEX.indexOf('function syncBotSessionWithServer'), INDEX.indexOf('function startBot()'));
  assert.match(helpers, /APP\.environment === 'MARKETING_SANDBOX'/);
  assert.match(startBotBody(), /APP\.environment !== 'MARKETING_SANDBOX'/);
  assert.ok(!/sandbox_/.test(helpers), 'no sandbox table or endpoint is referenced');
});

test('scope: the worker still moves money ONLY through record_trade_safe', () => {
  const rpcs = [...SERVICE.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]);
  const leaseRpcs = ['claim_bot_sessions', 'renew_bot_session_lease', 'release_bot_session_lease', 'stop_bot_session_fenced'];
  assert.deepStrictEqual([...new Set(rpcs.filter((n) => !leaseRpcs.includes(n)))], ['record_trade_safe']);
  assert.ok(!/from\('(wallets|trades|transactions)'\)\s*\.\s*(update|upsert|insert)/.test(SERVICE),
    'the worker must never write a ledger table directly');
});

test('scope: deposits, withdrawals, KYC and the $700 minimum are untouched', () => {
  for (const s of [
    "app.post('/api/withdraw/request'",
    "app.post('/api/deposit/request'",
    "app.post('/api/trade'",
    'record_trade_safe',
  ]) {
    assert.ok(SERVER.includes(s), 'expected ' + s + ' to still exist');
  }
  assert.match(SERVER, /const MIN_WITHDRAWAL_USD = 700;/);
  assert.match(SERVER, /amount < MIN_WITHDRAWAL_USD/);
});
