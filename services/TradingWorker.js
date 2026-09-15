'use strict';

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
  tickMs: 8000,
  maxTradePctOfBalance: 0.5, // % of live balance that bounds one trade's size
  maxAbsTradeUsd: 50, // hard ceiling on one trade's magnitude
  dailyLossLimitUsd: 100, // stop a session for the rest of the UTC day
  maxTradesPerDay: 288, // ~ one per 5 minutes
  maxConsecutiveFailures: 5, // auto-stop the session past this many
  staleHeartbeatMs: 60000, // a heartbeat older than this means "no executor"
  maxRetryAttempts: 4,
  retryBaseMs: 250,
};

/** Assets the bot may pick from (mirrors the UI list; display metadata only). */
const ASSETS = [
  { symbol: 'BTC/USDT', detail: 'Binance->Bybit' },
  { symbol: 'ETH/USDT', detail: 'Binance->Coinbase' },
  { symbol: 'EUR/USD', detail: 'OANDA->FXCM' },
  { symbol: 'AAPL', detail: 'NYSE->NASDAQ' },
  { symbol: 'XAU/USD', detail: 'Spot->Futures' },
];

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** Tick bucket: all attempted trades inside one bucket share an idempotency key. */
function tickBucket(nowMs, tickMs) {
  return Math.floor(Number(nowMs) / Number(tickMs));
}

/** Server-derived idempotency key. The client NEVER supplies this. */
function buildTickIdempotencyKey(userId, mode, bucket) {
  return `bot_${userId}_${mode}_${bucket}`;
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

/** Bounded, server-generated trade size. Never derives from client input. */
function computeTradeAmount(balance, limits = DEFAULT_LIMITS, rng = Math.random) {
  const bal = Number(balance) || 0;
  if (bal <= 0) return 0;
  const pct = Number(limits.maxTradePctOfBalance) / 100;
  const raw = bal * pct * (rng() * 2.4);
  const magnitude = Math.min(raw, Number(limits.maxAbsTradeUsd));
  const signed = (rng() > 0.35 ? 1 : -1) * magnitude;
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
}) {
  if (!admin) throw new Error('createTradingWorker requires a service-role Supabase client');
  const cfg = { ...DEFAULT_LIMITS, ...limits };
  const rpc = callRpc || ((name, args) => admin.rpc(name, args));
  let timer = null;
  let started = false;
  const stats = { ticks: 0, trades: 0, duplicates: 0, blocked: 0, stopped: 0, errors: 0 };

  const log = (event, payload = {}) => {
    try {
      logger.log(JSON.stringify({ event, component: 'TradingWorker', version: workerVersion, ...payload }));
    } catch (e) {
      /* logging must never break trading */
    }
  };

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

  async function stopSession(userId, stoppedReason) {
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
    log('session_stopped', { userId, stoppedReason });
    return true;
  }

  async function stopAllSessions(stoppedReason) {
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

    const amount = computeTradeAmount(inputs.balance, cfg, rng);
    const bucket = tickBucket(clock(), cfg.tickMs);
    const idempotencyKey = buildTickIdempotencyKey(userId, mode, bucket);
    const asset = ASSETS[Math.floor(rng() * ASSETS.length)];

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
    const sessions = await listRunningSessions();
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
    log('worker_started', { tickMs: cfg.tickMs, reconciled, enabled });
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
    log('worker_stopped', { ...stats });
  }

  return {
    cfg,
    stats,
    readControl,
    engageEmergencyStop,
    clearEmergencyStop,
    listRunningSessions,
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
  backoffDelay,
  isStaleHeartbeat,
  computeTradeAmount,
  evaluateRisk,
  withRetry,
  createTradingWorker,
};
