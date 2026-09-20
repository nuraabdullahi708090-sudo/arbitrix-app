'use strict';

/**
 * Shared configuration for the server-side trading worker and the web service's
 * single-engine guard.
 *
 * WHY THIS FILE EXISTS
 *   The worker decides "this session's heartbeat is too old to have an executor
 *   behind it" (DEFAULT_LIMITS.staleHeartbeatMs, used by isStaleHeartbeat() and
 *   reconcileStaleSessions() in services/TradingWorker.js), while the web
 *   service decides "is a server-side worker still driving this session?"
 *   (WORKER_STALE_HEARTBEAT_MS, used by isWorkerOwnedSession() and the admin
 *   worker-status view in server.js). Those two decisions MUST agree:
 *     * if the web guard's window were LONGER than the worker's, a browser tab
 *       would be refused for a session the worker had already reconciled away;
 *     * if it were SHORTER, a browser tab could trade while the worker still
 *       considered itself the executor - i.e. double execution.
 *   Two independent literals could drift apart silently, so both processes
 *   resolve the threshold here: one default, one env var, one parse.
 *
 * The module is PURE (no dependencies, reads only the env object it is given),
 * so the Express app and the standalone worker process can both require it.
 */

/** The one and only default for the executor-staleness window (milliseconds). */
const DEFAULT_STALE_HEARTBEAT_MS = 60000;

/**
 * The single env var that may override the default. It is read by BOTH
 * processes through this module, so it must be set on BOTH (or neither) - see
 * .env.example. An unset/blank/non-positive value falls back to the default.
 */
const STALE_HEARTBEAT_ENV = 'TRADING_STALE_HEARTBEAT_MS';

/** Resolve the executor-staleness window (ms) from env, else the default. */
function resolveStaleHeartbeatMs(env = process.env, fallback = DEFAULT_STALE_HEARTBEAT_MS) {
  const raw = env ? env[STALE_HEARTBEAT_ENV] : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = {
  DEFAULT_STALE_HEARTBEAT_MS,
  STALE_HEARTBEAT_ENV,
  resolveStaleHeartbeatMs,
};
