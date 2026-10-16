'use strict';

/**
 * CANONICAL MULTI-ASSET UNIVERSE for the Arbitrix arbitrage engine.
 *
 * WHY THIS IS SAFE TO EXPAND
 *   The engine is asset-AGNOSTIC. `executeBotTrade` (public/index.html) and the
 *   server-side TradingWorker each draw ONE asset label per trade and then
 *   compute the P&L from the wallet balance plus the RNG:
 *
 *     profit = balance * 0.5 * (rng * 2.4/100) * (rng > 0.35 ? 1 : -0.5)
 *
 *   The asset is DISPLAY METADATA: `record_trade_safe(p_asset, p_detail)` stores
 *   whatever label it is handed and validates nothing about it. Expanding the
 *   universe therefore changes ONLY which labels can be drawn. It does NOT touch
 *   the engine formula, the draw ORDER (asset -> magnitude -> sign), idempotency,
 *   risk limits, the promotional-credit cap, the profit pause, or any wallet /
 *   deposit / withdrawal / referral / subscription path.
 *
 * SINGLE SOURCE OF TRUTH (server side)
 *   This module is the server-side source for the engine list, the ticker
 *   symbols and the category grouping. The BROWSER cannot require a Node module,
 *   so `executeBotTrade` carries an inline copy of the same ENGINE_ASSETS list;
 *   tests/background_trading_parity.test.js pins the two to be character-identical
 *   so they can never drift.
 *
 * The source is ASCII-only; the exchange route arrow is the \u2192 escape.
 */

const ARROW = '\u2192';

/**
 * Grouped universe. The FLAT engine draw order is the concatenation of these
 * categories, in this order. Keeping the original five instruments present means
 * existing history labels keep rendering; the draw is uniform across the whole
 * expanded list, exactly as it was uniform across the original five.
 */
const ASSET_CATEGORIES = [
  {
    id: 'precious_metals',
    label: 'Precious Metals',
    assets: [
      { symbol: 'XAU/USD', name: 'Gold', detail: 'Spot' + ARROW + 'Futures' },
      { symbol: 'XAG/USD', name: 'Silver', detail: 'Spot' + ARROW + 'Futures' },
      { symbol: 'XPT/USD', name: 'Platinum', detail: 'Spot' + ARROW + 'Futures' },
      { symbol: 'XPD/USD', name: 'Palladium', detail: 'Spot' + ARROW + 'Futures' },
    ],
  },
  {
    id: 'foreign_exchange',
    label: 'Foreign Exchange',
    assets: [
      { symbol: 'EUR/USD', name: 'Euro / US Dollar', detail: 'OANDA' + ARROW + 'FXCM' },
      { symbol: 'GBP/USD', name: 'British Pound / US Dollar', detail: 'OANDA' + ARROW + 'FXCM' },
      { symbol: 'USD/JPY', name: 'US Dollar / Japanese Yen', detail: 'OANDA' + ARROW + 'FXCM' },
      { symbol: 'AUD/USD', name: 'Australian Dollar / US Dollar', detail: 'OANDA' + ARROW + 'FXCM' },
      { symbol: 'USD/CHF', name: 'US Dollar / Swiss Franc', detail: 'OANDA' + ARROW + 'FXCM' },
      { symbol: 'USD/CAD', name: 'US Dollar / Canadian Dollar', detail: 'OANDA' + ARROW + 'FXCM' },
      { symbol: 'NZD/USD', name: 'New Zealand Dollar / US Dollar', detail: 'OANDA' + ARROW + 'FXCM' },
      { symbol: 'EUR/GBP', name: 'Euro / British Pound', detail: 'OANDA' + ARROW + 'FXCM' },
      { symbol: 'EUR/JPY', name: 'Euro / Japanese Yen', detail: 'OANDA' + ARROW + 'FXCM' },
      { symbol: 'GBP/JPY', name: 'British Pound / Japanese Yen', detail: 'OANDA' + ARROW + 'FXCM' },
    ],
  },
  {
    id: 'equities_indices',
    label: 'Equities & Indices',
    assets: [
      { symbol: 'AAPL', name: 'Apple', detail: 'NYSE' + ARROW + 'NASDAQ' },
      { symbol: 'TSLA', name: 'Tesla', detail: 'NYSE' + ARROW + 'NASDAQ' },
      { symbol: 'MSFT', name: 'Microsoft', detail: 'NYSE' + ARROW + 'NASDAQ' },
      { symbol: 'NVDA', name: 'NVIDIA', detail: 'NYSE' + ARROW + 'NASDAQ' },
      { symbol: 'AMZN', name: 'Amazon', detail: 'NYSE' + ARROW + 'NASDAQ' },
      { symbol: 'GOOGL', name: 'Alphabet', detail: 'NYSE' + ARROW + 'NASDAQ' },
      { symbol: 'META', name: 'Meta Platforms', detail: 'NYSE' + ARROW + 'NASDAQ' },
      { symbol: 'SPX500', name: 'S&P 500', detail: 'CME' + ARROW + 'ICE' },
      { symbol: 'NAS100', name: 'Nasdaq 100', detail: 'CME' + ARROW + 'ICE' },
      { symbol: 'US30', name: 'Dow Jones 30', detail: 'CME' + ARROW + 'ICE' },
      { symbol: 'DAX40', name: 'DAX 40', detail: 'Eurex' + ARROW + 'ICE' },
      { symbol: 'UK100', name: 'FTSE 100', detail: 'ICE' + ARROW + 'Eurex' },
      { symbol: 'JP225', name: 'Nikkei 225', detail: 'OSE' + ARROW + 'CME' },
    ],
  },
  {
    id: 'crypto',
    label: 'Digital Assets',
    assets: [
      { symbol: 'BTC/USDT', name: 'Bitcoin', detail: 'Binance' + ARROW + 'Bybit' },
      { symbol: 'ETH/USDT', name: 'Ethereum', detail: 'Binance' + ARROW + 'Coinbase' },
      { symbol: 'SOL/USDT', name: 'Solana', detail: 'Kraken' + ARROW + 'OKX' },
      { symbol: 'XRP/USDT', name: 'XRP', detail: 'Coinbase' + ARROW + 'Bitstamp' },
      { symbol: 'LTC/USDT', name: 'Litecoin', detail: 'Binance' + ARROW + 'Kraken' },
      { symbol: 'BNB/USDT', name: 'BNB', detail: 'Binance' + ARROW + 'OKX' },
      { symbol: 'ADA/USDT', name: 'Cardano', detail: 'Kraken' + ARROW + 'Bybit' },
      { symbol: 'DOGE/USDT', name: 'Dogecoin', detail: 'Binance' + ARROW + 'OKX' },
      { symbol: 'AVAX/USDT', name: 'Avalanche', detail: 'Coinbase' + ARROW + 'Kraken' },
      { symbol: 'DOT/USDT', name: 'Polkadot', detail: 'Binance' + ARROW + 'Bybit' },
      { symbol: 'LINK/USDT', name: 'Chainlink', detail: 'Coinbase' + ARROW + 'OKX' },
      { symbol: 'MATIC/USDT', name: 'Polygon', detail: 'Binance' + ARROW + 'Kraken' },
    ],
  },
  {
    id: 'energy_commodities',
    label: 'Energy & Commodities',
    assets: [
      { symbol: 'WTI/USD', name: 'Crude Oil (WTI)', detail: 'NYMEX' + ARROW + 'ICE' },
      { symbol: 'BRENT/USD', name: 'Brent Crude', detail: 'ICE' + ARROW + 'NYMEX' },
      { symbol: 'NATGAS/USD', name: 'Natural Gas', detail: 'NYMEX' + ARROW + 'ICE' },
      { symbol: 'CORN/USD', name: 'Corn', detail: 'CBOT' + ARROW + 'ICE' },
      { symbol: 'WHEAT/USD', name: 'Wheat', detail: 'CBOT' + ARROW + 'ICE' },
      { symbol: 'SOYBEAN/USD', name: 'Soybean', detail: 'CBOT' + ARROW + 'ICE' },
      { symbol: 'COFFEE/USD', name: 'Coffee', detail: 'ICE' + ARROW + 'NYMEX' },
      { symbol: 'SUGAR/USD', name: 'Sugar', detail: 'ICE' + ARROW + 'NYMEX' },
    ],
  },
];

/** Flat list in ENGINE DRAW ORDER: { symbol, name, detail, category }. */
const TRADING_ASSETS = ASSET_CATEGORIES.reduce((acc, category) => {
  for (const a of category.assets) {
    acc.push({ symbol: a.symbol, name: a.name, detail: a.detail, category: category.id });
  }
  return acc;
}, []);

/** The engine's draw list: { symbol, detail } in the SAME order as TRADING_ASSETS. */
const ENGINE_ASSETS = TRADING_ASSETS.map((a) => ({ symbol: a.symbol, detail: a.detail }));

/** Symbols the activity ticker may quote (display only). */
const TICKER_SYMBOLS = TRADING_ASSETS.map((a) => a.symbol);

/** Draw one asset uniformly at random, mirroring the engine's selection. */
function pickAsset(rng = Math.random) {
  return ENGINE_ASSETS[Math.floor(rng() * ENGINE_ASSETS.length)];
}

module.exports = {
  ASSET_CATEGORIES,
  TRADING_ASSETS,
  ENGINE_ASSETS,
  TICKER_SYMBOLS,
  pickAsset,
};
