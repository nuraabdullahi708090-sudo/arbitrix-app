'use strict';
/**
 * Equity Performance for the dashboard chart (READ-ONLY, PURE).
 *
 * WHY THIS EXISTS
 *   The dashboard chart used to be built from a client-side sample buffer
 *   (localStorage `arbi_chart`) that appended the displayed balance every few
 *   seconds and kept at most 100 points. That is a display artefact, not an
 *   accounting record: after ~100 samples the oldest points were dropped, so
 *   "Starting" silently became the balance a few minutes ago and the reported
 *   change shrank (a $30 realised gain could show as ~$8 after a refresh).
 *   The buffer was also per browser/locale and could disagree with the wallet.
 *
 * THE BASIS (do not change without re-reading this)
 *   Equity is the LIVE WALLET BALANCE. The series is the persisted realised
 *   ledger (`trades.amount` + `trades.balance_after`, written by
 *   record_trade_safe in the same transaction as the wallet update), so:
 *     starting = the wallet balance immediately BEFORE the window's first trade
 *     current  = the authoritative wallet balance right now
 *     change   = current - starting        (always, by construction)
 *     high     = max equity along the series
 *   Trading P&L is NOT the same figure and is not used here: a deposit, a
 *   withdrawal or a referral conversion moves equity without being a trade, and
 *   the last point is therefore anchored to the live balance so the chart can
 *   never disagree with Total Equity.
 *
 *   The platform has no unrealised P&L (every trade is realised immediately via
 *   record_trade_safe), so the ledger sum is the complete trading component.
 *
 * This module never touches the database, the clock or the wallet: the caller
 * passes rows in. That keeps it unit-testable and makes it impossible for the
 * chart to change an account's money.
 */

/** Default cap on rendered points (the curve, not the accounting). */
const MAX_POINTS = 240;
/** Currency rounding used everywhere on the platform. */
const EPSILON = 0.005;

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function asTimeMs(value) {
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Thin the curve for rendering WITHOUT changing the accounting: the first and
 * last points always survive, and the reported statistics come from the
 * untrimmed series.
 */
function downsample(points, maxPoints) {
  const limit = Number.isFinite(Number(maxPoints)) && Number(maxPoints) >= 2
    ? Math.floor(Number(maxPoints))
    : MAX_POINTS;
  if (points.length <= limit) return points;
  const step = (points.length - 1) / (limit - 1);
  const out = [];
  for (let i = 0; i < limit; i++) {
    const idx = i === limit - 1 ? points.length - 1 : Math.round(i * step);
    out.push(points[idx]);
  }
  return out;
}

/**
 * @param {object} input
 * @param {Array}  input.trades          rows: { amount, balance_after?, created_at }, ascending
 * @param {number} input.currentBalance  authoritative live wallet balance
 * @param {number} [input.nowMs]         clock (injectable for tests)
 * @param {number} [input.maxPoints]     rendering cap
 */
function buildEquityPerformance(input) {
  const opts = input || {};
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const current = round2(opts.currentBalance);
  const rows = (Array.isArray(opts.trades) ? opts.trades : [])
    .filter((r) => r && Number.isFinite(Number(r.amount)))
    .map((r) => ({
      amount: round2(r.amount),
      // `balance_after` is authoritative when present; null means "derive it".
      balanceAfter: Number.isFinite(Number(r.balance_after)) ? round2(r.balance_after) : null,
      atMs: asTimeMs(r.created_at),
    }))
    .filter((r) => r.atMs !== null)
    .sort((a, b) => a.atMs - b.atMs);

  if (!rows.length) {
    // No realised trade in the window: equity is flat at the wallet balance, so
    // the chart still draws a baseline and reconciles exactly (change 0).
    return {
      starting: current,
      current,
      change: 0,
      changePct: 0,
      high: current,
      trades: 0,
      points: [
        { at: new Date(nowMs - 1000).toISOString(), equity: current },
        { at: new Date(nowMs).toISOString(), equity: current },
      ],
    };
  }

  const total = round2(rows.reduce((sum, r) => sum + r.amount, 0));

  // Starting equity: the balance immediately before the first realised trade in
  // the window. Falling back to a cumulative walk keeps partial/legacy rows and
  // the sandbox working when `balance_after` is unavailable.
  let starting = rows[0].balanceAfter !== null
    ? round2(rows[0].balanceAfter - rows[0].amount)
    : round2(current - total);
  if (!Number.isFinite(starting) || starting < 0) starting = Math.max(0, round2(current - total));

  const points = [{ at: new Date(rows[0].atMs - 1).toISOString(), equity: starting }];
  let running = starting;
  for (const row of rows) {
    running = round2(running + row.amount);
    // Re-sync to the persisted post-trade balance when it exists: a deposit made
    // between two trades is reflected in the wallet and must not skew the walk.
    if (row.balanceAfter !== null) running = row.balanceAfter;
    points.push({ at: new Date(row.atMs).toISOString(), equity: running });
  }

  // Anchor the curve to the authoritative wallet balance. Anything that moved
  // equity after the last trade (a deposit, a withdrawal, a conversion) shows up
  // here, which is why change = current - starting and not the trading P&L.
  const lastEquity = points[points.length - 1].equity;
  if (Math.abs(lastEquity - current) >= EPSILON) {
    points.push({ at: new Date(Math.max(nowMs, rows[rows.length - 1].atMs)).toISOString(), equity: current });
  }

  const change = round2(current - starting);
  const changePct = starting > 0 ? Math.round((change / starting) * 10000) / 100 : 0;
  const high = points.reduce((max, p) => (p.equity > max ? p.equity : max), points[0].equity);

  return {
    starting,
    current,
    change,
    changePct,
    high,
    trades: rows.length,
    points: downsample(points, opts.maxPoints),
  };
}

/** Accepted `?period=` values; anything else falls back to the default. */
const EQUITY_PERIODS = Object.freeze({ '30m': 30 * 60 * 1000, '1h': 60 * 60 * 1000, all: null });
const DEFAULT_EQUITY_PERIOD = '30m';

function resolveEquityPeriod(value) {
  const key = String(value == null ? '' : value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(EQUITY_PERIODS, key) ? key : DEFAULT_EQUITY_PERIOD;
}

/** ISO start of the window, or null for "all". */
function equityPeriodStartIso(period, nowMs) {
  const key = resolveEquityPeriod(period);
  const span = EQUITY_PERIODS[key];
  if (!span) return null;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  return new Date(now - span).toISOString();
}

module.exports = {
  MAX_POINTS,
  EQUITY_PERIODS,
  DEFAULT_EQUITY_PERIOD,
  buildEquityPerformance,
  resolveEquityPeriod,
  equityPeriodStartIso,
  downsample,
  round2,
};
