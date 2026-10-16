'use strict';

/**
 * SIMULATED arbitrage opportunities for the landing-page notification card.
 *
 * DISPLAY METADATA ONLY. This module never touches money: no wallet, no ledger,
 * no SECURITY DEFINER RPC, no order, no payment provider, no exchange call. It
 * exists purely to give the landing page a short, honest rotation of example
 * opportunities.
 *
 * SINGLE SOURCE OF TRUTH: every instrument, venue pair and category is derived
 * from the CANONICAL registry (services/tradingAssets.js), so the landing page
 * never carries a second hardcoded catalogue of supported assets. The venue pair
 * is parsed from the registry's own `detail` field (e.g. "Binance\u2192Bybit").
 */

const { TRADING_ASSETS } = require('./tradingAssets');

const ARROW = '\u2192';

const DEFAULT_COUNT = 10;
const MAX_COUNT = 24;

// Bands for the simulated numbers. `netPct` is ALWAYS below `spreadPct`.
const SPREAD_MIN = 0.08;
const SPREAD_MAX = 0.95;
const COST_MIN = 0.03; // estimated routing fee + slippage, in percentage points
const COST_MAX = 0.2;
const NET_FLOOR = 0.01;

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** Split "SOURCE<arrow>DESTINATION" into venues. Returns nulls when absent. */
function venuesFor(detail) {
  const parts = String(detail || '')
    .split(ARROW)
    .map((s) => s.trim())
    .filter(Boolean);
  return { source: parts[0] || null, destination: parts[1] || null };
}

/**
 * Build one simulated opportunity from a registry entry.
 * @param {object} asset registry entry ({ symbol, name, detail, category })
 * @param {() => number} rng
 */
function opportunityFor(asset, rng = Math.random) {
  const { source, destination } = venuesFor(asset.detail);
  const spreadPct = round2(SPREAD_MIN + rng() * (SPREAD_MAX - SPREAD_MIN));
  const costPct = round2(COST_MIN + rng() * (COST_MAX - COST_MIN));
  const netSpreadPct = Math.max(NET_FLOOR, round2(spreadPct - costPct));
  return {
    symbol: asset.symbol,
    name: asset.name || asset.symbol,
    category: asset.category,
    source,
    destination,
    spreadPct,
    netSpreadPct,
  };
}

/**
 * Build a distinct pool of simulated opportunities drawn from the canonical
 * registry. Order is shuffled so consecutive rotations do not repeat a venue
 * pair or an asset class back to back.
 *
 * @param {{count?: number, rng?: () => number}} [opts]
 */
function buildOpportunities(opts = {}) {
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const requested = Number.parseInt(opts.count, 10);
  const count = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_COUNT, 1), MAX_COUNT);

  const pool = TRADING_ASSETS.slice();
  // Fisher-Yates shuffle (unbiased) using the injected rng.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }

  const seen = new Set();
  const out = [];
  for (const asset of pool) {
    if (seen.has(asset.symbol)) continue;
    seen.add(asset.symbol);
    out.push(opportunityFor(asset, rng));
    if (out.length >= count) break;
  }
  return out;
}

module.exports = {
  DEFAULT_COUNT,
  MAX_COUNT,
  venuesFor,
  opportunityFor,
  buildOpportunities,
};
