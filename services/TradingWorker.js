'use strict';

const { DEFAULT_STALE_HEARTBEAT_MS } = require('./WorkerConfig');

/**
 * Server-side trading worker.
 *
 * PROBLEM IT SOLVES
 *   The production trading loop lived in the browser
 *   (`setInterval(executeBotTrade, 8000)` in public/index.html). Closing the tab,
 *   sleeping the phone, refreshing, or a browser crash silently stopped trading,
 *   and `bot_sessions.is_running` could stay 1 with no executor behind it.
 *
 * WHAT THIS IS
 *   An independent process (`worker.js`) that owns trade execution:
 *     * executes SERVER-SIDE, so it keeps running with every tab closed,
 *     * PERSISTS state (heartbeat / last tick / tick count / failure count /
 *       stop reason on bot_sessions) so restarts are detectable and recoverable,
 *     * has RECONNECT + RETRY handling (exponential backoff with jitter, retried
 *       writes) and stale-session reconciliation after a restart,
 *     * has IDEMPOTENCY PROTECTION: the per-user-per-tick key is derived
 *       server-side from the tick bucket, so a replayed tick (worker restart,
 *       duplicate delivery, concurrent instances) is deduped by
 *       `record_trade_safe`'s unique key and can never double-credit,
 *     * has RISK LIMITS evaluated BEFORE the write (per-trade size, trades/day,
 *       daily loss, promotional-credit cap, consecutive-failure auto-stop),
 *     * has an EMERGENCY STOP (platform-wide kill switch + env override) that
 *       refuses new trades and stops every running session,
 *     * emits structured JSON logs (no secrets, no credentials, no PII).
 *
 * SAFETY POSTURE
 *   Inert unless explicitly enabled: `worker.js` requires
 *   `TRADING_WORKER_ENABLED=true`. It fails CLOSED whenever it cannot prove the
 *   emergency-stop state is clear. It writes money ONLY through the existing,
 *   already-reviewed `record_trade_safe` RPC — it never writes wallets, trades,
 *   deposits, withdrawals or any sandbox table directly.
 */

const DEFAULT_LIMITS = {
  tickMs: 8000, // SAME cadence as the browser loop: setInterval(executeBotTrade, 8000)
  // ---------------------------------------------------------------------------
  // BUSINESS-LOGIC PARITY (do not change without an explicit management decision)
  //
  // These defaults reproduce the production browser engine EXACTLY, so moving
  // execution from the tab to the server does not change a single user-visible
  // trade. The browser (public/index.html, executeBotTrade) computes:
  //
  //   profit = balance * 0.5 * (Math.random()*2.4/100) * (Math.random()>0.35 ? 1 : -0.5)
  //
  //   * maxTradePctOfBalance 0.5  -> the browser's leading 0.5 factor
  //                                  (effective size ceiling = 0.5 * 2.4% = 1.2% of balance)
  //   * lossScaleFactor      0.5  -> the browser's losing multiplier (-0.5), i.e.
  //                                  losses are HALF the size of wins
  //   * maxAbsTradeUsd       none -> the browser has NO absolute ceiling
  //   * dailyLossLimitUsd    none -> the browser has NO daily loss stop
  //   * maxTradesPerDay      none -> the browser trades every tick, all day
  //
  // The three "rails" below are therefore DISABLED by default. They remain
  // available as env-tunable options (TRADING_MAX_TRADE_USD,
  // TRADING_DAILY_LOSS_LIMIT_USD, TRADING_MAX_TRADES_PER_DAY) for a management
  // decision to enable them later - enabling any of them CHANGES what users
  // experience and is not a worker-internal concern.
  maxTradePctOfBalance: 0.5,
  lossScaleFactor: 0.5,
  maxAbsTradeUsd: Infinity,
  dailyLossLimitUsd: Infinity,
  maxTradesPerDay: Infinity,
  // Operational only (NOT business logic): "failure" means the trade RPC errored
  // repeatedly, never that a trade lost money. A losing trade is a normal trade.
  maxConsecutiveFailures: 5, // auto-stop the session past this many
  // A heartbeat older than this means "no executor behind it". SINGLE SOURCE OF
  // TRUTH: services/WorkerConfig.js, which server.js's isWorkerOwnedSession()
  // also resolves, so the worker's reconcile window and the web guard's
  // worker-owned window can never silently disagree.
  staleHeartbeatMs: DEFAULT_STALE_HEARTBEAT_MS,
  maxRetryAttempts: 4,
  retryBaseMs: 250,
  // Executor lease (migration 029). At most ONE worker instance may execute a
  // given session at a time. The lease is written with the DATABASE clock and
  // expires on its own, so a crashed instance can never hold a session forever.
  leaseMs: 30000,
  maxClaimsPerTick: 25,
};

/** Assets the bot may pick from (mirrors the UI list; display metadata only). */
const ASSETS = [
  // EXACT parity with the browser list in public/index.html (executeBotTrade).
  // The arrow is written as \u2192 so the source stays ASCII while the string sent
  // to record_trade_safe (and therefore shown in the user's history) is
  // character-for-character identical to the browser's.
  { symbol: 'BTC/USDT', detail: 'Binance\u2192Bybit' },
  { symbol: 'ETH/USDT', detail: 'Binance\u2192Coinbase' },
  { symbol: 'EUR/USD', detail: 'OANDA\u2192FXCM' },
  { symbol: 'AAPL', detail: 'NYSE\u2192NASDAQ' },
  { symbol: 'XAU/USD', detail: 'Spot\u2192Futures' },
];

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** Tick bucket: all attempted trades inside one bucket share an idempotency key. */
function tickBucket(nowMs, tickMs) {
  return Math.floor(Number(nowMs) / Number(tickMs));
}

/**
 * Server-derived idempotency key. The client NEVER supplies this.
 *
 * The session GENERATION is part of the key. After a stop or a reassignment the
 * generation is bumped, so the NEW executor can trade inside the same tick
 * bucket without being deduped against the previous executor's tick, while an
 * in-flight tick from the OLD executor carries a different key and is rejected
 * by the fence before it ever reaches this key. Defaults to 0 so callers that
 * predate generations keep a stable key.
 */
function buildTickIdempotencyKey(userId, mode, bucket, generation = 0) {
  return `bot_${userId}_${mode}_${Number(generation) || 0}_${bucket}`;
}

/**
 * Absolute lease expiry from a DATABASE-provided server timestamp plus the lease
 * duration. Lease timing is always derived from the database clock - never from
 * the worker host clock and never from any client-supplied value.
 */
function leaseExpiresAtMs(serverNowMs, leaseMs) {
  const base = Number(serverNowMs);
  const ms = Number(leaseMs);
  if (!Number.isFinite(base) || !Number.isFinite(ms) || ms <= 0) return NaN;
  return base + ms;
}

/**
 * PURE, DETERMINISTIC fence verdict for one session - evaluated BEFORE any
 * money-moving write.
 *
 * It is a function only of the database-observed session state, the generation
 * this tick expects, and the worker's own configured identity. No host clock, no
 * randomness, no client input, so it is exhaustively testable and its `code`
 * matches the `code` returned by the renew RPC in migration 029 (first failing
 * check wins, in this order):
 *   SESSION_NOT_RUNNING -> GENERATION_MISMATCH -> LEASE_UNCLAIMED
 *   -> LEASE_NOT_OWNED -> LEASE_EXPIRED -> allow
 */
function evaluateFence({
  workerId,
  claimedBy,
  leaseExpiresAtMs: leaseExpiry,
  serverNowMs,
  expectedGeneration,
  observedGeneration,
  isRunning,
}) {
  const running = isRunning === true || Number(isRunning) === 1;
  if (!running) return { allow: false, code: 'SESSION_NOT_RUNNING' };

  if (Number(observedGeneration || 0) !== Number(expectedGeneration || 0)) {
    return { allow: false, code: 'GENERATION_MISMATCH' };
  }
  if (claimedBy === null || claimedBy === undefined || claimedBy === '') {
    return { allow: false, code: 'LEASE_UNCLAIMED' };
  }
  if (String(claimedBy) !== String(workerId)) {
    return { allow: false, code: 'LEASE_NOT_OWNED' };
  }

  const now = Number(serverNowMs);
  const expiry = Number(leaseExpiry);
  if (!Number.isFinite(expiry) || !Number.isFinite(now) || expiry <= now) {
    return { allow: false, code: 'LEASE_EXPIRED' };
  }
  return { allow: true, code: null };
}

/** Exponential backoff with jitter (deterministic when `rng` is injected). */
function backoffDelay(attempt, baseMs = DEFAULT_LIMITS.retryBaseMs, rng = Math.random) {
  const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exp, 30000);
  return Math.round(capped * (0.5 + rng() * 0.5));
}

/** A running session with no fresh heartbeat has no executor behind it. */
function isStaleHeartbeat(heartbeatAt, nowMs, staleMs = DEFAULT_LIMITS.staleHeartbeatMs) {
  if (!heartbeatAt) return true;
  const ts = Date.parse(heartbeatAt);
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts > staleMs;
}

/**
 * Trade size - EXACT PARITY with the production browser engine.
 *
 * The browser loop computes (public/index.html, executeBotTrade):
 *
 *   profit = balance * 0.5 * (Math.random()*2.4/100) * (Math.random()>0.35 ? 1 : -0.5)
 *
 * With the shipped defaults this function evaluates the SAME expression in the
 * SAME order, so the amount (and therefore the recorded P&L) is identical for
 * the same draw: the RNG is consumed in the browser's order (caller draws the
 * asset first, then this function draws magnitude, then sign).
 *
 *   magnitude = balance * maxTradePctOfBalance * (rng() * 2.4 / 100)   // 0.5 * 2.4% = 1.2% max
 *   sign      = rng() > 0.35 ? +1 : -lossScaleFactor                   // losses are HALF
 *
 * The optional rails are inert at their parity defaults:
 *   * maxAbsTradeUsd    - null/Infinity/not-finite means "no ceiling" (browser behaviour)
 *   * lossScaleFactor   - 0.5 reproduces the browser's -0.5 losing multiplier
 * Setting either one changes user-visible trade sizes, so it is a management
 * decision, never a side effect of moving execution server-side.
 */
function computeTradeAmount(balance, limits = DEFAULT_LIMITS, rng = Math.random) {
  const bal = Number(balance) || 0;
  if (bal <= 0) return 0;
  const factor = Number(limits.maxTradePctOfBalance);
  const scale = Number.isFinite(factor) ? factor : DEFAULT_LIMITS.maxTradePctOfBalance;
  // Browser-identical expression order (bit-for-bit the same result).
  const raw = bal * scale * (rng() * 2.4 / 100);
  const cap = Number(limits.maxAbsTradeUsd);
  const magnitude = Number.isFinite(cap) ? Math.min(raw, cap) : raw;
  const lossScale = Number(limits.lossScaleFactor);
  const losing = Number.isFinite(lossScale) ? lossScale : DEFAULT_LIMITS.lossScaleFactor;
  const signed = (rng() > 0.35 ? 1 : -losing) * magnitude;
  let amount = round2(signed);
  if (amount < 0) amount = -Math.min(Math.abs(amount), bal); // loss can never exceed balance
  return round2(amount);
}

/**
 * Pure risk gate. Evaluated BEFORE any write; returns the first veto.
 * Order is deliberate: a dead/empty session is reported before trading-state
 * problems, and the promotional cap is reported before generic limits so the
 * user sees the actionable "make your first deposit" reason.
 */
function evaluateRisk({
  balance,
  realizedToday,
  tradesToday,
  promoCreditFunded,
  promoProfit,
  limits = DEFAULT_LIMITS,
  isPromoProfitCapReached,
}) {
  const bal = Number(balance) || 0;
  if (bal <= 0) return { allow: false, code: 'NO_BALANCE', reason: 'no_balance' };
  if (Number(tradesToday) >= Number(limits.maxTradesPerDay)) {
    return { allow: false, code: 'MAX_TRADES_PER_DAY', reason: 'max_trades_per_day' };
  }
  if (Number(realizedToday) <= -Math.abs(Number(limits.dailyLossLimitUsd))) {
    return { allow: false, code: 'DAILY_LOSS_LIMIT', reason: 'daily_loss_limit', stopSession: true };
  }
  if (isPromoProfitCapReached && isPromoProfitCapReached(promoCreditFunded, promoProfit)) {
    return { allow: false, code: 'PROMO_TRADING_LIMIT_REACHED', reason: 'promo_cap', stopSession: true };
  }
  return { allow: true, code: null, reason: null };
}

/** Retry helper with exponential backoff. Retries thrown errors AND {error}. */
async function withRetry(fn, opts = {}) {
  const {
    attempts = DEFAULT_LIMITS.maxRetryAttempts,
    baseMs = DEFAULT_LIMITS.retryBaseMs,
    rng = Math.random,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    onRetry = () => {},
  } = opts;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fn(attempt);
      if (result && result.error) {
        lastError = result.error;
        throw new Error(result.error.message || String(result.error));
      }
      return { ok: true, result, attempts: attempt };
    } catch (e) {
      lastError = e;
      if (attempt === attempts) break;
      const delay = backoffDelay(attempt, baseMs, rng);
      onRetry({ attempt, delay, message: (e && e.message) || String(e) });
      await sleep(delay);
    }
  }
  return { ok: false, error: lastError, attempts };
}

/**
 * Build a worker bound to a service-role Supabase client.
 * All I/O is injected so the engine is testable without a database.
 */
function createTradingWorker({
  admin,
  promo,
  limits = DEFAULT_LIMITS,
  logger = console,
  clock = () => Date.now(),
  rng = Math.random,
  sleep,
  workerVersion = 'trading-worker/1',
  callRpc = null,
  enabled = false,
  envEmergencyStop = false,
  // EXECUTOR LEASE (migration 029). Defaults to the safe production posture:
  // without a working lease RPC the worker executes NOTHING, rather than
  // risking two executors on one session. Callers that deliberately run the
  // legacy single-instance behaviour must opt out explicitly.
  requireLease = true,
  // Executor identity. Server-configured only (env var / hostname); it is never
  // taken from a request, a header or any other client-controlled input.
  workerId = null,
  // SHADOW MODE: observe and log intended actions, write NOTHING AT ALL.
  dryRun = false,
}) {
  if (!admin) throw new Error('createTradingWorker requires a service-role Supabase client');
  if (requireLease && !dryRun && !workerId) {
    throw new Error('createTradingWorker: requireLease needs a workerId (executor identity)');
  }
  const cfg = { ...DEFAULT_LIMITS, ...limits };
  const rpc = callRpc || ((name, args) => admin.rpc(name, args));
  let timer = null;
  let started = false;
  const stats = {
    ticks: 0, trades: 0, duplicates: 0, blocked: 0, stopped: 0, errors: 0,
    claimed: 0, released: 0, fenceRejections: 0, leaseErrors: 0,
    dryRunTrades: 0, dryRunBlockedWrites: 0,
  };
  // Sessions this process currently holds a lease for: userId -> { generation }.
  const held = new Map();

  const log = (event, payload = {}) => {
    try {
      logger.log(JSON.stringify({ event, component: 'TradingWorker', version: workerVersion, ...payload }));
    } catch (e) {
      /* logging must never break trading */
    }
  };

  /**
   * SHADOW MODE must be provably write-free. Every write site in this module
   * funnels through this guard, so a dry-run process cannot move money or mutate
   * session state even if a future edit forgets a branch. Returns false so
   * callers keep a truthful "nothing happened" result.
   */
  function refuseWrite(op, extra = {}) {
    stats.dryRunBlockedWrites++;
    log('dry_run_write_blocked', { op, ...extra });
    return false;
  }

  // ---------------------------------------------------------------- kill switch
  /**
   * Read the platform kill switch. FAILS CLOSED: if the control row cannot be
   * read we behave as if the stop is ENGAGED, because we cannot prove otherwise.
   */
  async function readControl() {
    if (envEmergencyStop) {
      return { emergencyStop: true, reason: 'env_TRADING_EMERGENCY_STOP', source: 'env' };
    }
    try {
      const { data, error } = await admin
        .from('bot_worker_control')
        .select('emergency_stop, reason, engaged_by, engaged_at')
        .eq('id', 1)
        .single();
      if (error) throw error;
      return {
        emergencyStop: !!(data && data.emergency_stop),
        reason: (data && data.reason) || null,
        engagedBy: (data && data.engaged_by) || null,
        source: 'db',
      };
    } catch (e) {
      log('control_unreadable_fail_closed', { message: (e && e.message) || String(e) });
      return { emergencyStop: true, reason: 'control_unreadable', source: 'fail_closed' };
    }
  }

  async function engageEmergencyStop(reason, engagedBy) {
    if (dryRun) {
      refuseWrite('engage_emergency_stop', { reason: reason || 'manual' });
      return { ok: false, dryRun: true, sessionsStopped: 0 };
    }
    const res = await withRetry(
      () =>
        admin
          .from('bot_worker_control')
          .upsert(
            {
              id: 1,
              emergency_stop: true,
              reason: reason || 'manual',
              engaged_by: engagedBy || 'unknown',
              engaged_at: new Date(clock()).toISOString(),
              updated_at: new Date(clock()).toISOString(),
            },
            { onConflict: 'id' }
          ),
      { rng, sleep, onRetry: (r) => log('retry', { op: 'engage_stop', attempt: r.attempt }) }
    );
    log('emergency_stop_engaged', { reason: reason || 'manual', engagedBy: engagedBy || 'unknown', ok: res.ok });
    const stopped = await stopAllSessions('emergency_stop');
    return { ok: res.ok, sessionsStopped: stopped };
  }

  async function clearEmergencyStop(clearedBy) {
    if (dryRun) {
      refuseWrite('clear_emergency_stop', { clearedBy: clearedBy || 'unknown' });
      return { ok: false, dryRun: true };
    }
    const res = await withRetry(
      () =>
        admin
          .from('bot_worker_control')
          .upsert(
            {
              id: 1,
              emergency_stop: false,
              reason: null,
              engaged_by: null,
              engaged_at: null,
              updated_at: new Date(clock()).toISOString(),
            },
            { onConflict: 'id' }
          ),
      { rng, sleep, onRetry: (r) => log('retry', { op: 'clear_stop', attempt: r.attempt }) }
    );
    log('emergency_stop_cleared', { clearedBy: clearedBy || 'unknown', ok: res.ok });
    return { ok: res.ok };
  }

  // ------------------------------------------------------------- sessions
  async function listRunningSessions() {
    const res = await withRetry(
      () => admin.from('bot_sessions').select('*').eq('is_running', 1),
      { rng, sleep, onRetry: (r) => log('retry', { op: 'list_sessions', attempt: r.attempt }) }
    );
    if (!res.ok) {
      stats.errors++;
      log('list_sessions_failed', { message: (res.error && res.error.message) || String(res.error) });
      return [];
    }
    const data = res.result && res.result.data;
    return Array.isArray(data) ? data : [];
  }

  // ------------------------------------------------- executor lease (029)
  /**
   * Claim claimable sessions with a DATABASE-timestamped lease.
   *
   * FAILS CLOSED: if the RPC is unavailable (migration 029 not applied) or
   * errors, this returns [] and the tick executes NOTHING. Falling back to "scan
   * every running session" is precisely the double-execution the lease exists to
   * prevent, so there is deliberately no fallback.
   */
  async function claimSessions() {
    if (!workerId) {
      stats.leaseErrors++;
      log('claim_skipped', { reason: 'no_worker_id' });
      return [];
    }
    const res = await withRetry(
      () => rpc('claim_bot_sessions', {
        p_worker_id: workerId,
        p_lease_ms: cfg.leaseMs,
        p_limit: cfg.maxClaimsPerTick,
      }),
      { rng, sleep, onRetry: (r) => log('retry', { op: 'claim_sessions', attempt: r.attempt }) }
    );
    if (!res.ok) {
      stats.leaseErrors++;
      log('claim_failed_fail_closed', {
        message: (res.error && res.error.message) || String(res.error),
        hint: 'is migration 029 (bot session lease) applied?',
      });
      return [];
    }
    const payload = res.result && typeof res.result === 'object' ? res.result.data : null;
    if (!payload || typeof payload !== 'object' || payload.success === false) {
      stats.leaseErrors++;
      log('claim_rejected_fail_closed', { error: (payload && payload.error) || 'invalid claim response' });
      return [];
    }
    const rows = Array.isArray(payload.claimed) ? payload.claimed : [];
    const serverNowMs = Date.parse(payload.server_now);
    if (!Number.isFinite(serverNowMs)) log('claim_missing_server_clock', { rows: rows.length });
    for (const row of rows) {
      held.set(String(row.user_id), {
        userId: row.user_id,
        generation: Number(row.generation || 0),
        expiresAtMs: Date.parse(row.lease_expires_at),
      });
    }
    stats.claimed += rows.length;
    log('sessions_claimed', { count: rows.length, serverNow: payload.server_now || null, workerId });
    return rows.map((row) => ({ ...row, server_now_ms: serverNowMs }));
  }

  /**
   * Renew + VERIFY our lease for one session. This is the fence: it is called
   * immediately before any money-moving write, and when the database refuses we
   * discard the session without trading. Prefer the database's own `code`;
   * otherwise derive the verdict from the state it returned with the same pure
   * function the unit tests cover.
   */
  async function renewLease(session) {
    const expectedGeneration = Number(session.generation || 0);
    const res = await withRetry(
      () => rpc('renew_bot_session_lease', {
        p_user_id: session.user_id,
        p_worker_id: workerId,
        p_generation: expectedGeneration,
        p_lease_ms: cfg.leaseMs,
      }),
      { rng, sleep, onRetry: (r) => log('retry', { op: 'renew_lease', attempt: r.attempt }) }
    );
    if (!res.ok) {
      stats.leaseErrors++;
      log('lease_renew_failed_fail_closed', {
        userId: session.user_id,
        message: (res.error && res.error.message) || String(res.error),
      });
      held.delete(String(session.user_id));
      return { renewed: false, code: 'LEASE_RPC_ERROR' };
    }
    const payload = (res.result && typeof res.result === 'object' && res.result.data) || {};
    const serverNowMs = Date.parse(payload.server_now);
    const leaseExpiry = Date.parse(payload.lease_expires_at);
    if (payload.renewed === true) {
      held.set(String(session.user_id), {
        userId: session.user_id,
        generation: Number(payload.generation === undefined ? expectedGeneration : payload.generation) || 0,
        expiresAtMs: leaseExpiry,
      });
      return { renewed: true, code: null, serverNowMs, leaseExpiresAtMs: leaseExpiry };
    }
    const verdict = evaluateFence({
      workerId,
      claimedBy: payload.claimed_by,
      leaseExpiresAtMs: leaseExpiry,
      serverNowMs,
      expectedGeneration,
      observedGeneration: payload.generation,
      isRunning: payload.is_running,
    });
    held.delete(String(session.user_id));
    return { renewed: false, code: payload.code || verdict.code || 'LEASE_REJECTED', serverNowMs };
  }

  /** Give a lease back (best effort; expiry would cover it anyway). */
  async function releaseLease(userId, generation) {
    held.delete(String(userId));
    if (!workerId) return false;
    if (dryRun) {
      refuseWrite('release_lease', { userId });
      return false;
    }
    const res = await withRetry(
      () => rpc('release_bot_session_lease', {
        p_user_id: userId,
        p_worker_id: workerId,
        p_generation: Number(generation || 0),
      }),
      { rng, sleep, onRetry: (r) => log('retry', { op: 'release_lease', attempt: r.attempt }) }
    );
    if (!res.ok) {
      stats.leaseErrors++;
      log('lease_release_failed', { userId, message: (res.error && res.error.message) || String(res.error) });
      return false;
    }
    stats.released++;
    return true;
  }

  async function stopSession(userId, stoppedReason) {
    if (dryRun) {
      held.delete(String(userId));
      refuseWrite('stop_session', { userId, stoppedReason });
      return false;
    }
    // FENCED stop (migration 029). Bumping the generation is what provably stops
    // a stale executor: its next renew returns GENERATION_MISMATCH, so it can
    // neither renew nor trade this session again, restart or not. One attempt
    // only - a database without 029 must not pay retry backoff on every stop.
    const fenced = await withRetry(
      () =>
        rpc('stop_bot_session_fenced', {
          p_user_id: userId,
          p_reason: stoppedReason,
          p_requested_by: workerId || 'worker',
        }),
      { attempts: 1, rng, sleep }
    );
    if (fenced.ok) {
      held.delete(String(userId));
      const payload = (fenced.result && typeof fenced.result === 'object' && fenced.result.data) || {};
      stats.stopped++;
      log('session_stopped', {
        userId,
        stoppedReason,
        fenced: true,
        generation: payload.generation === undefined ? null : Number(payload.generation),
      });
      return true;
    }
    // 029 not applied (or the RPC is unavailable): fall back to the unfenced
    // update. is_running=0 still makes the next renew return SESSION_NOT_RUNNING,
    // so the session IS stopped either way - only the generation bump is lost.
    log('fenced_stop_unavailable', {
      userId,
      stoppedReason,
      message: (fenced.error && fenced.error.message) || String(fenced.error),
    });
    // The update result MUST be inspected: supabase-js resolves with { error }
    // instead of throwing, so an unchecked write would log a false success and
    // leave a phantom "running" session behind (the exact bug this worker exists
    // to remove).
    const res = await withRetry(
      () =>
        admin
          .from('bot_sessions')
          .update({
            is_running: 0,
            stopped_reason: stoppedReason,
            updated_at: new Date(clock()).toISOString(),
          })
          .eq('user_id', userId),
      { rng, sleep, onRetry: (r) => log('retry', { op: 'stop_session', attempt: r.attempt }) }
    );
    if (!res.ok) {
      stats.errors++;
      log('session_stop_failed', {
        userId,
        stoppedReason,
        message: (res.error && res.error.message) || String(res.error),
      });
      return false;
    }
    stats.stopped++;
    log('session_stopped', { userId, stoppedReason, fenced: false });
    return true;
  }

  async function stopAllSessions(stoppedReason) {
    if (dryRun) {
      refuseWrite('stop_all_sessions', { stoppedReason, held: held.size });
      return 0;
    }
    const sessions = await listRunningSessions();
    for (const s of sessions) await stopSession(s.user_id, stoppedReason);
    return sessions.length;
  }

  /**
   * Restart/partition recovery: any RUNNING session whose heartbeat is stale (or
   * missing, e.g. rows written by the old browser engine) has no live executor,
   * so it is reconciled to stopped. Returns the number reconciled.
   */
  async function reconcileStaleSessions(nowMs = clock()) {
    const sessions = await listRunningSessions();
    let reconciled = 0;
    if (dryRun) {
      const stale = sessions.filter((s) => isStaleHeartbeat(s.heartbeat_at, nowMs, cfg.staleHeartbeatMs));
      log('dry_run_reconcile_skipped', {
        running: sessions.length,
        wouldStop: stale.map((s) => s.user_id),
      });
      return 0;
    }
    for (const s of sessions) {
      if (!isStaleHeartbeat(s.heartbeat_at, nowMs, cfg.staleHeartbeatMs)) continue;
      await stopSession(s.user_id, 'stale_heartbeat_reconciled');
      reconciled++;
    }
    if (reconciled) log('stale_sessions_reconciled', { reconciled });
    return reconciled;
  }

  // ------------------------------------------------------------- per-tick work
  async function loadSessionInputs(userId) {
    const startOfTodayUtc = new Date(new Date(clock()).toISOString().slice(0, 10) + 'T00:00:00.000Z').toISOString();

    const walletRes = await withRetry(
      () => admin.from('wallets').select('live_balance').eq('user_id', userId).single(),
      { rng, sleep, onRetry: (r) => log('retry', { op: 'load_wallet', attempt: r.attempt }) }
    );
    const balance = walletRes.ok && walletRes.result && walletRes.result.data
      ? Number(walletRes.result.data.live_balance) || 0
      : 0;

    const tradesRes = await withRetry(
      () =>
        admin
          .from('trades')
          .select('amount')
          .eq('user_id', userId)
          .eq('mode', 'live')
          .gte('created_at', startOfTodayUtc),
      { rng, sleep, onRetry: (r) => log('retry', { op: 'load_trades', attempt: r.attempt }) }
    );
    const todayTrades = tradesRes.ok && tradesRes.result && Array.isArray(tradesRes.result.data)
      ? tradesRes.result.data
      : [];
    const realizedToday = round2(todayTrades.reduce((sum, t) => sum + (Number(t && t.amount) || 0), 0));

    let promoCreditFunded = null;
    let promoProfit = 0;
    if (promo) {
      const hasDeposit = await promo.hasConfirmedDeposit(userId);
      promoCreditFunded = await promo.isPromoCreditFunded(userId, hasDeposit);
      if (promoCreditFunded === true) promoProfit = await promo.getRealizedProfit(userId);
    }

    return {
      balance,
      realizedToday,
      tradesToday: todayTrades.length,
      promoCreditFunded,
      promoProfit,
    };
  }

  async function heartbeat(userId, patch = {}) {
    if (dryRun) {
      refuseWrite('heartbeat', { userId });
      return false;
    }
    const nowIso = new Date(clock()).toISOString();
    const res = await withRetry(
      () =>
        admin
          .from('bot_sessions')
          .update({ heartbeat_at: nowIso, last_tick_at: nowIso, worker_version: workerVersion, ...patch })
          .eq('user_id', userId),
      { rng, sleep, onRetry: (r) => log('retry', { op: 'heartbeat', attempt: r.attempt }) }
    );
    return res.ok;
  }

  /**
   * One evaluation of one session. Safe to call concurrently: the idempotency
   * key is a pure function of (user, mode, tick bucket), so two workers racing on
   * the same tick can only ever produce ONE ledger row.
   */
  async function tickSession(session) {
    const userId = session.user_id;
    const mode = 'live';

    const control = await readControl();
    if (control.emergencyStop) {
      stats.blocked++;
      log('risk_block', { userId, code: 'EMERGENCY_STOP', reason: control.reason, source: control.source });
      await stopSession(userId, 'emergency_stop');
      return { userId, action: 'stopped', code: 'EMERGENCY_STOP' };
    }

    // EXECUTOR FENCE (migration 029): renew + verify ownership, generation,
    // running state and lease validity BEFORE we read anything for a trade and
    // long before any money-moving write. A stale generation (session stopped or
    // reassigned) is rejected here, so it can never reach record_trade_safe.
    if (requireLease && !dryRun) {
      const lease = await renewLease(session);
      if (!lease.renewed) {
        stats.fenceRejections++;
        log('fence_rejected', {
          userId,
          code: lease.code,
          expectedGeneration: Number(session.generation || 0),
          claimedBy: session.claimed_by || null,
          workerId,
        });
        return { userId, action: 'fenced', code: lease.code };
      }
    }

    const inputs = await loadSessionInputs(userId);
    const verdict = evaluateRisk({
      ...inputs,
      limits: cfg,
      isPromoProfitCapReached: promo ? promo.isPromoProfitCapReached : undefined,
    });

    if (!verdict.allow) {
      stats.blocked++;
      log('risk_block', { userId, code: verdict.code, reason: verdict.reason, balance: inputs.balance });
      if (verdict.stopSession) {
        await stopSession(userId, verdict.reason);
        return { userId, action: 'stopped', code: verdict.code };
      }
      await heartbeat(userId);
      return { userId, action: 'blocked', code: verdict.code };
    }

    // Draw order mirrors the browser engine EXACTLY: asset first, then the
    // magnitude, then the sign - so for any given RNG stream the server produces
    // the same trade the tab would have produced.
    const asset = ASSETS[Math.floor(rng() * ASSETS.length)];
    const amount = computeTradeAmount(inputs.balance, cfg, rng);
    const bucket = tickBucket(clock(), cfg.tickMs);
    const generation = Number(session.generation || 0);
    const idempotencyKey = buildTickIdempotencyKey(userId, mode, bucket, generation);

    // Parity with the browser's NET EFFECT at a tiny balance: the tab POSTs
    // `amount: profit` and /api/trade rejects exactly 0 (400 "Invalid trade
    // amount"), so a trade rounding to zero leaves NO ledger row and changes no
    // balance. Mirror that: no write at all.
    if (amount === 0) {
      log('tick_skipped', { userId, reason: 'zero_amount', balance: inputs.balance });
      return { userId, action: 'skipped', code: 'ZERO_AMOUNT' };
    }

    // SHADOW / DRY RUN: log exactly what WOULD be written, then write nothing.
    // This branch sits BEFORE the money-moving RPC, so dry-run is structurally
    // incapable of writing a trade.
    if (dryRun) {
      stats.dryRunTrades++;
      log('dry_run_trade', {
        userId,
        mode,
        generation,
        balance: inputs.balance,
        amount,
        asset: asset.symbol,
        idempotencyKey,
        wouldWrite: {
          rpc: 'record_trade_safe',
          p_user_id: userId,
          p_amount: amount,
          p_mode: mode,
          p_asset: asset.symbol,
          p_detail: asset.detail,
          p_idempotency_key: idempotencyKey,
        },
      });
      return { userId, action: 'dry_run', amount };
    }

    let res;
    try {
      res = await withRetry(
        () =>
          rpc('record_trade_safe', {
            p_user_id: userId,
            p_amount: amount,
            p_idempotency_key: idempotencyKey,
            p_mode: mode,
            p_asset: asset.symbol,
            p_detail: asset.detail,
          }),
        { rng, sleep, onRetry: (r) => log('rpc_retry', { userId, op: 'record_trade_safe', attempt: r.attempt }) }
      );
    } catch (e) {
      res = { ok: false, error: e };
    }

    if (!res.ok) {
      stats.errors++;
      const failures = Number(session.consecutive_failures || 0) + 1;
      log('trade_failed', { userId, attempt: res.attempts, message: (res.error && res.error.message) || String(res.error) });
      await heartbeat(userId, { consecutive_failures: failures });
      if (failures >= cfg.maxConsecutiveFailures) await stopSession(userId, 'max_consecutive_failures');
      return { userId, action: 'error' };
    }

    // `supabaseAdmin.rpc()` resolves to { data, error }; the record_trade_safe
    // JSONB result is `data`, so unwrap one level (same as /api/trade does).
    const rpcPayload = res.result && typeof res.result === 'object' ? res.result.data : null;
    const result = rpcPayload && typeof rpcPayload === 'object' ? rpcPayload : {};
    if (result.duplicate) {
      stats.duplicates++;
      log('trade_duplicate', { userId, idempotencyKey, attempts: res.attempts });
      await heartbeat(userId, { consecutive_failures: 0 });
      return { userId, action: 'duplicate', code: result.error || null };
    }
    if (result.success === false) {
      stats.errors++;
      await heartbeat(userId, { consecutive_failures: Number(session.consecutive_failures || 0) + 1 });
      log('trade_rejected', { userId, error: result.error || 'rejected' });
      return { userId, action: 'rejected', code: result.error || null };
    }

    stats.trades++;
    log('trade_recorded', {
      userId,
      amount,
      asset: asset.symbol,
      appliedAmount: result.applied_amount,
      newBalance: result.new_balance,
      idempotencyKey,
      attempts: res.attempts,
    });
    await heartbeat(userId, {
      consecutive_failures: 0,
      tick_count: Number(session.tick_count || 0) + 1,
    });
    return { userId, action: 'traded', amount };
  }

  /** One pass over every running session. Never throws. */
  async function runOnce() {
    stats.ticks++;
    const startedAt = clock();
    const control = await readControl();
    if (control.emergencyStop) {
      const stopped = await stopAllSessions('emergency_stop');
      log('tick_skipped', { reason: 'emergency_stop', source: control.source, stopped });
      return { tick: stats.ticks, skipped: true, reason: 'emergency_stop', results: [] };
    }
    // Lease mode CLAIMS work (DB-timestamped, SKIP LOCKED) so two instances can
    // never execute the same session. Dry-run never claims (it must not write),
    // and a failed claim returns [] so the tick executes nothing.
    const claimed = requireLease && !dryRun ? await claimSessions() : await listRunningSessions();
    // Every session we HOLD a lease for is ticked too, not just the ones claimed
    // in this pass. Otherwise a session leased on an earlier tick would sit idle
    // until its lease expired whenever more than maxClaimsPerTick sessions are
    // running - i.e. the bot would silently slow down at scale. Ticking the held
    // set keeps the 8s cadence identical to the browser loop at any fleet size.
    const claimedIds = new Set(claimed.map((s) => String(s.user_id)));
    const heldOnly = Array.from(held.values())
      .filter((v) => !claimedIds.has(String(v.userId)))
      .map((v) => ({ user_id: v.userId, generation: v.generation }));
    const sessions = claimed.concat(heldOnly);
    const results = [];
    for (const s of sessions) {
      try {
        results.push(await tickSession(s));
      } catch (e) {
        stats.errors++;
        log('tick_session_error', { userId: s && s.user_id, message: (e && e.message) || String(e) });
      }
    }
    log('tick_complete', { tick: stats.ticks, sessions: sessions.length, durationMs: clock() - startedAt });
    return { tick: stats.ticks, skipped: false, sessions: sessions.length, results };
  }

  async function start() {
    if (started) return;
    started = true;
    const reconciled = await reconcileStaleSessions();
    log('worker_started', {
      tickMs: cfg.tickMs,
      // Observable so a misconfigured env var on ONE service is not silent.
      staleHeartbeatMs: cfg.staleHeartbeatMs,
      reconciled,
      enabled,
      dryRun: dryRun === true,
      requireLease: requireLease === true,
      workerId: workerId || null,
    });
    timer = setInterval(() => {
      runOnce().catch((e) => {
        stats.errors++;
        log('tick_error', { message: (e && e.message) || String(e) });
      });
    }, cfg.tickMs);
    // NO unref() here: the interval MUST keep the process alive. Calling unref()
    // let the event loop drain and the worker exited immediately after logging
    // worker_started - i.e. it never traded at all (caught by the staging run,
    // pinned by the "stays alive and keeps ticking" test).
  }

  async function stop() {
    started = false;
    if (timer) clearInterval(timer);
    timer = null;
    // Hand our leases back so another instance (or the next boot) can claim them
    // immediately instead of waiting for expiry.
    for (const [userId, info] of Array.from(held.entries())) {
      await releaseLease(userId, info.generation);
    }
    held.clear();
    log('worker_stopped', { ...stats });
  }

  return {
    cfg,
    stats,
    readControl,
    engageEmergencyStop,
    clearEmergencyStop,
    listRunningSessions,
    claimSessions,
    renewLease,
    releaseLease,
    heldLeases: () => Array.from(held.values()).map((v) => ({ userId: v.userId, generation: v.generation })),
    reconcileStaleSessions,
    stopSession,
    stopAllSessions,
    tickSession,
    runOnce,
    start,
    stop,
    isRunning: () => started,
  };
}

module.exports = {
  DEFAULT_LIMITS,
  ASSETS,
  tickBucket,
  buildTickIdempotencyKey,
  leaseExpiresAtMs,
  evaluateFence,
  backoffDelay,
  isStaleHeartbeat,
  computeTradeAmount,
  evaluateRisk,
  withRetry,
  createTradingWorker,
};
