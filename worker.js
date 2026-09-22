#!/usr/bin/env node
'use strict';

/**
 * Server-side trading worker entrypoint.
 *
 * RUN AS A SEPARATE PROCESS (e.g. a Render Background Worker):
 *     node worker.js
 *
 * THIS PROCESS IS INERT UNTIL EXPLICITLY ENABLED. It requires BOTH:
 *   * TRADING_WORKER_ENABLED=true   (feature switch; default OFF)
 *   * a readable `bot_worker_control` row with emergency_stop = FALSE
 *     (migration 028 must be applied; the worker fails CLOSED without it)
 *
 * It never listens on a port, never imports server.js, and never touches the
 * sandbox: it only reconciles `bot_sessions` and writes money through the
 * existing `record_trade_safe` RPC.
 *
 * EXIT CODES
 *   0  disabled by configuration, or clean shutdown
 *   1  enabled but misconfigured (missing service key / unreadable control row)
 *   2  unexpected fatal error
 */

const { createClient } = require('@supabase/supabase-js');
const os = require('os');
const { createTradingWorker, DEFAULT_LIMITS } = require('./services/TradingWorker');
const { createPromoCheck } = require('./services/PromoCheck');
const { resolveProfitPauseUsd, createProfitPauseCheck } = require('./services/ProfitPause');
const { resolveStaleHeartbeatMs } = require('./services/WorkerConfig');

const WORKER_VERSION = 'trading-worker/1';

function envFlag(name) {
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}
function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Structured logger. Never prints secrets, credentials or tokens. */
function makeLogger() {
  const min = envFlag('TRADING_WORKER_DEBUG') ? 'debug' : 'info';
  return {
    log: (line) => {
      try {
        const parsed = JSON.parse(line);
        if (min === 'debug' || parsed.event !== 'tick_complete') console.log(line);
      } catch (e) {
        console.log(line);
      }
    },
  };
}

async function main() {
  const logger = makeLogger();
  const enabled = envFlag('TRADING_WORKER_ENABLED');
  const envEmergencyStop = envFlag('TRADING_EMERGENCY_STOP');
  // SHADOW MODE (default OFF): observe + log intended actions, write NOTHING.
  // It additionally requires TRADING_WORKER_ENABLED, so this flag alone can
  // never start a process that does anything.
  const dryRun = envFlag('TRADING_WORKER_DRY_RUN');
  // EXECUTOR IDENTITY - server-configured only. It is never read from a request,
  // a header or any other client-controlled input; a client therefore cannot
  // claim someone else's lease. RENDER_INSTANCE_ID distinguishes instances.
  const workerId =
    String(process.env.TRADING_WORKER_ID || process.env.RENDER_INSTANCE_ID || '').trim() ||
    `${os.hostname()}-${process.pid}`;

  if (!enabled) {
    logger.log(
      JSON.stringify({
        event: 'worker_disabled',
        component: 'TradingWorker',
        version: WORKER_VERSION,
        message:
          'TRADING_WORKER_ENABLED is not true, so no trading will be executed by this process. The browser-side engine (if still present) remains the only executor.',
      })
    );
    return 0;
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://gabqgewycepcyyzqkvvt.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey || serviceKey.trim() === '') {
    logger.log(
      JSON.stringify({
        event: 'worker_misconfigured',
        component: 'TradingWorker',
        version: WORKER_VERSION,
        reason: 'missing_SUPABASE_SERVICE_KEY',
        // presence only - never the value
        serviceKeyPresent: false,
      })
    );
    return 1;
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const promo = createPromoCheck({ admin, log: (e) => logger.log(JSON.stringify(e)) });
  // TEMPORARY management test: platform-wide profit pause. Threshold comes from
  // BOT_PROFIT_PAUSE_USD (default 400; 0 disables). Fails OPEN when the state
  // table is unreadable, so this can never strand a trader.
  const profitPause = createProfitPauseCheck({
    admin,
    threshold: resolveProfitPauseUsd(),
    log: (e) => logger.log(JSON.stringify(e)),
  });

  const worker = createTradingWorker({
    admin,
    promo,
    profitPause,
    logger,
    enabled: true,
    envEmergencyStop,
    workerVersion: WORKER_VERSION,
    // EXECUTOR LEASE (migration 029) is REQUIRED here: without a working lease
    // RPC the worker executes NOTHING (fail closed) rather than risking two
    // executors on one session. There is deliberately no env switch to weaken it.
    requireLease: true,
    workerId,
    dryRun,
    limits: {
      ...DEFAULT_LIMITS,
      tickMs: envNumber('TRADING_WORKER_TICK_MS', DEFAULT_LIMITS.tickMs),
      leaseMs: envNumber('TRADING_WORKER_LEASE_MS', DEFAULT_LIMITS.leaseMs),
      maxTradePctOfBalance: envNumber('TRADING_MAX_TRADE_PCT', DEFAULT_LIMITS.maxTradePctOfBalance),
      maxAbsTradeUsd: envNumber('TRADING_MAX_TRADE_USD', DEFAULT_LIMITS.maxAbsTradeUsd),
      dailyLossLimitUsd: envNumber('TRADING_DAILY_LOSS_LIMIT_USD', DEFAULT_LIMITS.dailyLossLimitUsd),
      maxTradesPerDay: envNumber('TRADING_MAX_TRADES_PER_DAY', DEFAULT_LIMITS.maxTradesPerDay),
      maxConsecutiveFailures: envNumber('TRADING_MAX_CONSECUTIVE_FAILURES', DEFAULT_LIMITS.maxConsecutiveFailures),
      // SINGLE SOURCE OF TRUTH: the same services/WorkerConfig.js resolver the
      // web guard uses, so the two can never silently disagree (see .env.example:
      // set TRADING_STALE_HEARTBEAT_MS on BOTH services, or on neither).
      staleHeartbeatMs: resolveStaleHeartbeatMs(),
    },
  });

  // Fail fast, and fail CLOSED: no trading unless we can prove the stop is clear.
  const control = await worker.readControl();
  if (control.source === 'fail_closed') {
    logger.log(
      JSON.stringify({
        event: 'worker_refused',
        component: 'TradingWorker',
        version: WORKER_VERSION,
        reason: 'control_unreadable',
        detail: 'bot_worker_control is unreadable (is migration 028 applied?). No trading was executed.',
      })
    );
    return 1;
  }

  await worker.start();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(JSON.stringify({ event: 'worker_shutdown', signal, component: 'TradingWorker' }));
    await worker.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => {
    logger.log(
      JSON.stringify({
        event: 'unhandled_rejection',
        component: 'TradingWorker',
        message: (e && e.message) || String(e),
      })
    );
  });

  return null; // long-running
}

if (require.main === module) {
  main()
    .then((code) => {
      if (typeof code === 'number') process.exit(code);
    })
    .catch((e) => {
      console.error(
        JSON.stringify({
          event: 'worker_fatal',
          component: 'TradingWorker',
          message: (e && e.message) || String(e),
        })
      );
      process.exit(2);
    });
}

module.exports = { main, WORKER_VERSION, envFlag, envNumber, makeLogger };
