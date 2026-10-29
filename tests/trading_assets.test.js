/**
 * EXPANDED MULTI-ASSET UNIVERSE.
 *
 * Management asked for a significantly larger and more varied set of tradeable
 * instruments - precious metals, FX majors, equities/indices, digital assets and
 * energy/commodities - while the arbitrage engine logic and every existing
 * safeguard stay exactly as they are.
 *
 * These tests pin:
 *   1. the universe really is broad and covers every requested asset class;
 *   2. it is internally consistent (no duplicate symbols, valid metadata);
 *   3. the engine is UNCHANGED: same formula, same draw order, same cadence;
 *   4. the browser list, the worker list and the ticker stay in sync;
 *   5. the asset surface is display-only - no money path, cap or pause changed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const {
  ASSET_CATEGORIES,
  TRADING_ASSETS,
  ENGINE_ASSETS,
  TICKER_SYMBOLS,
  pickAsset,
} = require('../services/tradingAssets');
const { ASSETS } = require('../services/TradingWorker');

const INDEX = read('public/index.html');
const SERVICE = read('services/TradingWorker.js');
const SERVER = read('server.js');

// ==========================================================================
// 1. COVERAGE - every requested asset class is present
// ==========================================================================
test('universe covers all requested asset classes', () => {
  const ids = ASSET_CATEGORIES.map((c) => c.id);
  for (const id of ['precious_metals', 'foreign_exchange', 'equities_indices', 'crypto', 'energy_commodities']) {
    assert.ok(ids.includes(id), 'missing category ' + id);
  }
});

test('precious metals: gold, silver, platinum and palladium', () => {
  const metals = ASSET_CATEGORIES.find((c) => c.id === 'precious_metals');
  const symbols = metals.assets.map((a) => a.symbol);
  for (const s of ['XAU/USD', 'XAG/USD', 'XPT/USD', 'XPD/USD']) assert.ok(symbols.includes(s), 'missing ' + s);
});

test('foreign exchange: EUR/USD, GBP/USD, USD/JPY, AUD/USD and more majors', () => {
  const fx = ASSET_CATEGORIES.find((c) => c.id === 'foreign_exchange');
  const symbols = fx.assets.map((a) => a.symbol);
  for (const s of ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD']) assert.ok(symbols.includes(s), 'missing ' + s);
  assert.ok(symbols.length >= 8, 'expected several additional major pairs, got ' + symbols.length);
});

test('digital assets: BTC, ETH, SOL, XRP and LTC plus additional pairs', () => {
  const crypto = ASSET_CATEGORIES.find((c) => c.id === 'crypto');
  const symbols = crypto.assets.map((a) => a.symbol);
  for (const s of ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'LTC/USDT']) {
    assert.ok(symbols.includes(s), 'missing ' + s);
  }
  assert.ok(symbols.length >= 10, 'expected additional crypto pairs, got ' + symbols.length);
});

test('equities and indices: shares and index instruments', () => {
  const eq = ASSET_CATEGORIES.find((c) => c.id === 'equities_indices');
  const symbols = eq.assets.map((a) => a.symbol);
  for (const s of ['AAPL', 'TSLA']) assert.ok(symbols.includes(s), 'missing share ' + s);
  for (const s of ['SPX500', 'NAS100', 'US30']) assert.ok(symbols.includes(s), 'missing index ' + s);
});

test('energy and commodities: crude oil, natural gas and agricultural products', () => {
  const en = ASSET_CATEGORIES.find((c) => c.id === 'energy_commodities');
  const symbols = en.assets.map((a) => a.symbol);
  for (const s of ['WTI/USD', 'BRENT/USD', 'NATGAS/USD']) assert.ok(symbols.includes(s), 'missing ' + s);
  for (const s of ['CORN/USD', 'WHEAT/USD', 'SOYBEAN/USD']) assert.ok(symbols.includes(s), 'missing ' + s);
});

test('the universe is significantly larger than the original five', () => {
  assert.ok(TRADING_ASSETS.length >= 40, 'expected a significant expansion, got ' + TRADING_ASSETS.length);
  // the original five instruments are all still present (history labels keep rendering)
  const symbols = new Set(TRADING_ASSETS.map((a) => a.symbol));
  for (const s of ['BTC/USDT', 'ETH/USDT', 'EUR/USD', 'AAPL', 'XAU/USD']) assert.ok(symbols.has(s), 'dropped ' + s);
});

// ==========================================================================
// 2. CONSISTENCY - valid, duplicate-free metadata
// ==========================================================================
test('metadata is well formed: unique symbols, detail with an exchange route', () => {
  const seen = new Set();
  for (const a of TRADING_ASSETS) {
    assert.ok(a.symbol && typeof a.symbol === 'string', 'symbol required');
    assert.ok(a.detail && typeof a.detail === 'string', 'detail required for ' + a.symbol);
    assert.ok(a.category, 'category required for ' + a.symbol);
    assert.ok(a.detail.includes('\u2192'), 'detail must describe a venue route: ' + a.detail);
    assert.ok(!seen.has(a.symbol), 'duplicate symbol ' + a.symbol);
    seen.add(a.symbol);
  }
  assert.strictEqual(TRADING_ASSETS.length, seen.size);
});

test('ENGINE_ASSETS is TRADING_ASSETS stripped to symbol+detail in the same order', () => {
  assert.deepStrictEqual(
    ENGINE_ASSETS,
    TRADING_ASSETS.map((a) => ({ symbol: a.symbol, detail: a.detail }))
  );
});

test('the module source is ASCII-only (repo encoding rule)', () => {
  const src = read('services/tradingAssets.js');
  assert.ok(!/[\u0080-\uffff]/.test(src), 'tradingAssets.js must contain no non-ASCII characters');
});

test('pickAsset is uniform and returns a real instrument', () => {
  for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
    const a = pickAsset(() => r);
    assert.ok(ENGINE_ASSETS.includes(a), 'pick must return a member of the universe');
  }
  assert.strictEqual(pickAsset(() => 0).symbol, ENGINE_ASSETS[0].symbol);
  assert.strictEqual(pickAsset(() => 0.999999).symbol, ENGINE_ASSETS[ENGINE_ASSETS.length - 1].symbol);
});

// ==========================================================================
// 3. ENGINE LOGIC UNCHANGED
// ==========================================================================
test('the worker draws from the canonical list, asset first', () => {
  assert.deepStrictEqual(ASSETS, ENGINE_ASSETS, 'the worker must use the canonical ENGINE_ASSETS');
  const at = SERVICE.indexOf('// Draw order mirrors the browser engine EXACTLY');
  assert.ok(at > 0, 'the draw-order comment must exist');
  const body = SERVICE.slice(at, at + 900);
  assert.match(body, /const asset = ASSETS\[Math\.floor\(rng\(\) \* ASSETS\.length\)\];/);
  assert.ok(body.indexOf('const asset = ASSETS') < body.indexOf('const amount = computeTradeAmount'),
    'the asset is drawn BEFORE the amount');
});

test('the browser engine formula, draw order and cadence are untouched', () => {
  assert.match(INDEX, /const profit = data\.balance \* 0\.5 \* \(Math\.random\(\)\*2\.4\/100\) \* \(Math\.random\(\)>0\.35 \? 1 : -0\.5\);/);
  assert.match(INDEX, /setInterval\(executeBotTrade, 8000\)/);
  const at = INDEX.indexOf('function executeBotTrade()');
  const body = INDEX.slice(at, at + 4000);
  assert.ok(body.indexOf('const asset = assets[Math.floor(Math.random()*assets.length)];') > 0,
    'the browser still draws one asset per trade');
  assert.ok(body.indexOf('const asset = assets') < body.indexOf('const profit ='),
    'the browser draws the asset before computing profit');
});

test('no asset index is hard-coded anywhere in the engine', () => {
  // Parity for any draw is guaranteed structurally: both sides index the SAME list.
  assert.match(SERVICE, /const asset = ASSETS\[Math\.floor\(rng\(\) \* ASSETS\.length\)\];/);
  assert.match(INDEX, /const asset = assets\[Math\.floor\(Math\.random\(\)\*assets\.length\)\];/);
});

// ==========================================================================
// 4. BROWSER / WORKER / TICKER STAY IN SYNC
// ==========================================================================
test('the browser list is character-identical to the canonical universe', () => {
  const ui = [...INDEX.matchAll(/\{symbol:'([^']+)',detail:'([^']+)'\}/g)]
    .map((m) => [m[1], JSON.parse('"' + m[2] + '"')]);
  assert.deepStrictEqual(ui, TRADING_ASSETS.map((a) => [a.symbol, a.detail]));
});

test('the ticker quotes only supported instruments and includes the requested ones', () => {
  const supported = new Set(TRADING_ASSETS.map((a) => a.symbol));
  assert.ok(TICKER_SYMBOLS.length >= 8);
  for (const s of TICKER_SYMBOLS) assert.ok(supported.has(s), 'ticker symbol not supported: ' + s);
  for (const s of ['BTC/USDT', 'ETH/USDT', 'EUR/USD', 'XAU/USD']) assert.ok(TICKER_SYMBOLS.includes(s));
  // the inline browser list must match the module's TICKER_SYMBOLS
  const inline = [...INDEX.matchAll(/\{symbol:'([^']+)'\}/g)].map((m) => m[1]);
  const tickerLine = (INDEX.match(/const TICKER_ASSETS = \[(.*?)\];/) || [])[1] || '';
  const inlineTicker = [...tickerLine.matchAll(/\{symbol:'([^']+)'\}/g)].map((m) => m[1]);
  assert.deepStrictEqual(inlineTicker, TICKER_SYMBOLS, 'inline ticker list must match the registry');
  assert.ok(inline.length >= inlineTicker.length);
});

test('the sandbox demo-trade generator uses the canonical universe', () => {
  assert.match(SERVER, /const \{ ENGINE_ASSETS: TRADING_ASSETS \} = require\('\.\/services\/tradingAssets'\);/);
  assert.match(SERVER, /: TRADING_ASSETS;/, 'the sandbox generator must draw from the canonical list');
});

// ==========================================================================
// 5. SAFEGUARDS / MONEY PATHS UNCHANGED
// ==========================================================================
test('the asset is display-only: record_trade_safe still accepts any label', () => {
  const mig = read('supabase/migrations/009_trades_persistence.sql');
  // no allow-list / asset validation was introduced in the ledger RPC
  assert.match(mig, /p_asset TEXT DEFAULT NULL/);
  assert.match(mig, /p_detail TEXT DEFAULT NULL/);
  assert.ok(!/asset\s+IN\s*\(/.test(mig), 'no asset allow-list may be introduced');
});

test('the money-path RPCs and their migrations are untouched', () => {
  assert.match(SERVER, /supabaseAdmin\.rpc\('record_trade_safe', \{/);
  assert.match(SERVER, /p_amount: amount2dp,/);
  assert.match(SERVER, /p_asset: asset \|\| null,/);
  assert.match(SERVER, /p_detail: detail \|\| null,/);
});

test('no new environment variable or migration was added for assets', () => {
  assert.ok(!/TRADING_ASSETS?_ENV|ASSET_(LIST|UNIVERSE)/.test(SERVER), 'assets must not be env-gated');
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'));
  // 001..037 existed before the asset-universe change; 038 is the separately
  // approved Telegram marketing queue, 039 the Telegram account-link table,
  // 040 the conversion-events outbox and 041 the atomic legacy deposit credit.
  // 042 records the deposit-credit audit marker and 043 adds the marketing
  // claim lease (see docs/TELEGRAM_RECOVERY_AUDIT.md, sections 17 and 19).
  // 044 adds the marketing worker heartbeat columns and 045 the deposit partner
  // directory. The asset universe itself is display metadata and needs no
  // schema change, which the next assertions still prove.
  assert.strictEqual(migrations.length, 45, 'only approved migrations may be added');
  assert.ok(migrations.includes('038_marketing_broadcast.sql'), '038 is the marketing queue');
  assert.ok(migrations.includes('039_telegram_account_links.sql'), '039 is the account-link table');
  assert.ok(migrations.includes('040_conversion_events.sql'), '040 is the conversion outbox');
  assert.ok(migrations.includes('041_legacy_deposit_atomic_credit.sql'), '041 is the legacy credit fix');
  assert.ok(migrations.includes('042_confirm_payment_credit_marker.sql'), '042 is the credit-marker fix');
  assert.ok(migrations.includes('043_marketing_claim_lease.sql'), '043 is the marketing claim lease');
  assert.ok(migrations.includes('044_marketing_worker_heartbeat.sql'), '044 is the worker heartbeat');
  assert.ok(migrations.includes('045_deposit_partners.sql'), '045 is the deposit partner directory');
  assert.ok(!migrations.some((f) => /trading.?assets?/i.test(f)), 'no asset-allow-list migration should exist');
});

test('the promotional cap, profit pause and worker-inert defaults are intact', () => {
  assert.match(SERVICE, /DEFAULT_LIMITS/);
  assert.match(SERVICE, /maxTradePctOfBalance: 0\.5/);
  assert.match(SERVICE, /lossScaleFactor: 0\.5/);
  assert.match(SERVER, /PROMO_LIMIT_CODE/);
  assert.match(SERVER, /PROFIT_PAUSE_CODE/);
  const workerEntry = read('worker.js');
  assert.match(workerEntry, /TRADING_WORKER_ENABLED/);
});
