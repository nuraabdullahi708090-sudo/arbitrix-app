/**
 * ROTATING ARBITRAGE OPPORTUNITY NOTIFICATIONS (landing page).
 *
 * Management asked for a compact, accessible notification card that rotates
 * example arbitrage opportunities on the landing page. These tests pin:
 *   1. the data comes from the CANONICAL asset registry via a public read-only
 *      endpoint - no second hardcoded catalogue, and no money path;
 *   2. the card is accessible, fixed to the bottom-left, and yields the corner to
 *      the consent banner, install prompt, support panel and any modal;
 *   3. rotation is randomized at ~8-15s with a polite initial delay, respects
 *      reduced motion, and does not repeat the same instrument back to back;
 *   4. the trading engine and every existing safeguard are untouched.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const INDEX = read('public/index.html');
const SERVER = read('server.js');
const OPP_SRC = read('services/MarketOpportunities.js');
const { buildOpportunities, venuesFor, DEFAULT_COUNT, MAX_COUNT } = require('../services/MarketOpportunities');
const { TRADING_ASSETS } = require('../services/tradingAssets');

const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

// ==========================================================================
// 1. DATA - canonical registry, public endpoint, no money
// ==========================================================================
test('venuesFor parses the registry route and tolerates a missing one', () => {
  assert.deepStrictEqual(venuesFor('Binance\u2192Bybit'), { source: 'Binance', destination: 'Bybit' });
  assert.deepStrictEqual(venuesFor('Spot \u2192 Futures'), { source: 'Spot', destination: 'Futures' });
  assert.deepStrictEqual(venuesFor(''), { source: null, destination: null });
  assert.deepStrictEqual(venuesFor(null), { source: null, destination: null });
});

test('the registry names every instrument (name + symbol are both available)', () => {
  assert.strictEqual(TRADING_ASSETS.length, 47);
  for (const a of TRADING_ASSETS) {
    assert.ok(a.name && typeof a.name === 'string', 'missing name for ' + a.symbol);
    assert.ok(a.symbol, 'missing symbol');
    assert.ok(a.detail.includes('\u2192'), 'expected a venue route for ' + a.symbol);
  }
});

test('buildOpportunities draws distinct instruments from the canonical universe', () => {
  const list = buildOpportunities({ count: 10 });
  assert.strictEqual(list.length, 10);
  const symbols = new Set(TRADING_ASSETS.map((a) => a.symbol));
  const seen = new Set();
  for (const o of list) {
    assert.ok(symbols.has(o.symbol), 'unknown instrument ' + o.symbol);
    assert.ok(!seen.has(o.symbol), 'duplicate instrument ' + o.symbol);
    seen.add(o.symbol);
    assert.ok(o.name, 'missing name');
    assert.ok(o.category, 'missing category');
    assert.ok(o.source && o.destination, 'missing venues for ' + o.symbol);
  }
});

test('every opportunity carries the required fields with sane numbers', () => {
  for (let i = 0; i < 40; i++) {
    const [o] = buildOpportunities({ count: 1 });
    assert.deepStrictEqual(Object.keys(o).sort(),
      ['category', 'destination', 'name', 'netSpreadPct', 'source', 'spreadPct', 'symbol'].sort());
    assert.ok(o.spreadPct > 0 && o.spreadPct <= 1, 'observed spread out of band: ' + o.spreadPct);
    assert.ok(o.netSpreadPct > 0, 'net spread must stay positive');
    assert.ok(o.netSpreadPct < o.spreadPct, 'net spread must be below the observed spread');
    assert.strictEqual(Number(o.spreadPct.toFixed(2)), o.spreadPct, 'spread must be 2dp');
    assert.strictEqual(Number(o.netSpreadPct.toFixed(2)), o.netSpreadPct, 'net spread must be 2dp');
  }
});

test('the count is clamped to a safe range', () => {
  assert.strictEqual(buildOpportunities({}).length, DEFAULT_COUNT);
  assert.strictEqual(buildOpportunities({ count: 0 }).length, 1);
  assert.strictEqual(buildOpportunities({ count: 'abc' }).length, DEFAULT_COUNT);
  assert.strictEqual(buildOpportunities({ count: 9999 }).length, MAX_COUNT);
  assert.ok(MAX_COUNT <= TRADING_ASSETS.length);
});

test('generation is deterministic for an injected rng (repeatable tests)', () => {
  const seq = () => { let i = 0; const v = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.05]; return () => v[i++ % v.length]; };
  assert.deepStrictEqual(buildOpportunities({ count: 3, rng: seq() }), buildOpportunities({ count: 3, rng: seq() }));
});

test('the opportunity module never touches money or the database', () => {
  // Scan CODE only - the doc comment legitimately names what it does not use.
  const code = OPP_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const bad of [/supabase/i, /\.rpc\(/, /wallet/i, /ledger/i, /record_trade_safe/, /balance/i, /fetch\(/]) {
    assert.ok(!bad.test(code), 'MarketOpportunities must not reference ' + bad);
  }
  assert.match(OPP_SRC, /require\('\.\/tradingAssets'\)/, 'must derive from the canonical registry');
});

test('the public endpoint is read-only, unauthenticated and before the SPA fallback', () => {
  const routeIdx = SERVER.indexOf("app.get('/api/market/opportunities'");
  assert.ok(routeIdx > 0, 'route missing');
  const nextRoute = SERVER.indexOf('app.get(', routeIdx + 10);
  const routeBlock = SERVER.slice(routeIdx, nextRoute > 0 ? nextRoute : routeIdx + 900);
  assert.ok(!/authMiddleware|adminMiddleware/.test(routeBlock), 'the endpoint must stay public');
  assert.match(routeBlock, /buildMarketOpportunities\(\{ count:/);
  assert.ok(!/supabase|\.rpc\(|wallet|ledger/.test(routeBlock), 'the endpoint must not touch money');
  const fallbackIdx = SERVER.indexOf('// Fallback \u2013 uses app.use');
  assert.ok(routeIdx < fallbackIdx, 'the route must be registered before the SPA fallback');
  assert.match(SERVER, /require\('\.\/services\/MarketOpportunities'\)/);
});

// ==========================================================================
// 2. MARKUP + CSS - accessible, bottom-left, yields the corner
// ==========================================================================
test('the card markup is accessible and lives on the landing page', () => {
  const cardIdx = INDEX.indexOf('id="arbOpportunityCard"');
  const landingIdx = INDEX.indexOf('id="landingPage"');
  const authIdx = INDEX.indexOf('id="authPage"');
  assert.ok(cardIdx > landingIdx && cardIdx < authIdx, 'the card must be inside #landingPage');
  const card = INDEX.slice(cardIdx, INDEX.indexOf('</aside>', cardIdx) + '</aside>'.length);
  assert.match(card, /role="status"/);
  assert.match(card, /aria-live="polite"/);
  assert.match(card, /aria-atomic="true"/);
  assert.match(card, /aria-labelledby="arbOppTitle"/);
  assert.match(card, /id="arbOppDismiss"[^>]*aria-label=/);
  for (const id of ['arbOppSymbol', 'arbOppName', 'arbOppSource', 'arbOppDestination', 'arbOppObserved', 'arbOppNet']) {
    assert.ok(card.includes('id="' + id + '"'), 'missing ' + id);
  }
  // The live region must stay in the a11y tree (visibility, not the hidden attr).
  assert.ok(!/<aside[^>]*id="arbOpportunityCard"[^>]*\shidden/.test(INDEX), 'the card must not use the hidden attribute');
});

test('the removed note line stays removed (management cleanup)', () => {
  // The card used to end with "Illustrative example of a detected spread. Not an
  // offer or a guarantee of execution." Management asked for it to be removed, so
  // the element, its CSS and its key must all stay gone - in EVERY locale.
  const card = INDEX.slice(INDEX.indexOf('id="arbOpportunityCard"'), INDEX.indexOf('</aside>', INDEX.indexOf('id="arbOpportunityCard"')));
  assert.ok(!/arb-opp-note/.test(INDEX), 'the note element/CSS must not return');
  assert.ok(!/arbOppNote/.test(INDEX), 'the note id must not return');
  assert.ok(!/arbOpp\.note/.test(INDEX), 'the arbOpp.note key must not return');
  assert.ok(!/Illustrative example/i.test(card), 'the note copy must not render in the card');
  assert.ok(!/not an offer/i.test(INDEX), 'no locale may re-add the note copy');
});

test('the card carries no hardcoded asset catalogue', () => {
  const card = INDEX.slice(INDEX.indexOf('id="arbOpportunityCard"'), INDEX.indexOf('</aside>'));
  assert.ok(!/symbol:/.test(card), 'the card must be JS-populated from the API');
  assert.ok(!/BTC\/USDT|XAU\/USD|EUR\/USD/.test(card), 'no instrument may be hardcoded in the markup');
});

test('CSS pins the position, hidden default, reveal class and RTL flip', () => {
  const css = (INDEX.match(/\.arb-opp-card\{[^}]*\}/) || [])[0] || '';
  assert.ok(css, 'base card rule missing');
  assert.match(css, /position:fixed/);
  assert.match(css, /left:16px/);
  assert.match(css, /z-index:9990/);
  assert.match(css, /opacity:0/);
  assert.match(css, /visibility:hidden/);
  assert.match(css, /pointer-events:none/);
  const show = (INDEX.match(/\.arb-opp-card\.show\{[^}]*\}/) || [])[0] || '';
  assert.match(show, /opacity:1/);
  assert.match(show, /visibility:visible/);
  assert.match(show, /pointer-events:auto/);
  assert.match(INDEX, /html\[dir="rtl"\] \.arb-opp-card\{left:auto;right:16px;\}/);
  assert.match(INDEX, /@media\(max-width:640px\)\{\.arb-opp-card\{left:12px;right:12px;width:auto;\}html\[dir="rtl"\] \.arb-opp-card\{left:12px;right:12px;\}\}/);
});

test('CSS yields the corner to the consent banner, install prompt, support and modals', () => {
  assert.match(INDEX, /body:has\(#metaConsentBanner\) \.arb-opp-card\{bottom:calc\(150px \+ env\(safe-area-inset-bottom, 0px\)\);\}/);
  for (const sel of ['#pwaInstallPrompt:not(.hidden)', '#supportPanel.open', '#supportModal.open', '.modal-overlay.open', '.deposit-modal.open']) {
    assert.ok(INDEX.includes('body:has(' + sel + ') .arb-opp-card'), 'missing precedence for ' + sel);
  }
  // The card sits below every modal/toast/consent layer.
  assert.match(INDEX, /z-index:9990/);
  assert.match(INDEX, /\.toast\{[^}]*z-index:99999/);
  assert.match(INDEX, /#metaConsentBanner\{[^}]*z-index:99999/);
});

test('CSS reduces motion for visitors who prefer it', () => {
  assert.match(INDEX, /@media\(prefers-reduced-motion:reduce\)\{\.arb-opp-card\{transform:none;transition:opacity 0\.01ms linear;\}\.arb-opp-dot\{animation:none;\}\}/);
});

// ==========================================================================
// 3. JS - cadence, reduced motion, landing-only, dismissal
// ==========================================================================
test('the rotator uses a randomized 8-15s cadence with an initial delay', () => {
  const js = INDEX.slice(INDEX.indexOf('ROTATING ARBITRAGE OPPORTUNITY NOTIFICATIONS'));
  assert.match(js, /gapMinMs:\s*8000/);
  assert.match(js, /gapMaxMs:\s*15000/);
  assert.match(js, /initialMinMs:\s*6000/);
  assert.match(js, /initialMaxMs:\s*10000/);
  assert.match(js, /endpoint:\s*'\/api\/market\/opportunities'/);
  assert.match(js, /setTimeout\(tick, rand\(CONFIG\.gapMinMs, CONFIG\.gapMaxMs\)\)/);
});

test('the rotator skips rotation for reduced motion and stays landing-only', () => {
  const js = INDEX.slice(INDEX.indexOf('ROTATING ARBITRAGE OPPORTUNITY NOTIFICATIONS'));
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(js, /if \(reducedMotion\(\)\) showStaticOnce\(\); else tick\(\);/);
  assert.match(js, /function landingActive\(\)/);
  assert.match(js, /if \(dismissed\(\) \|\| !landingActive\(\)\) \{ arbOppStop\(\); return; \}/);
  assert.match(js, /new MutationObserver/);
  assert.match(js, /attributeFilter: \['style', 'class'\]/);
  // The Phase-31 pin still holds: no tab-lifecycle handler may be registered
  // (tick() uses the document.hidden guard instead).
  for (const ev of ['beforeunload', 'pagehide', 'visibilitychange']) {
    assert.ok(!INDEX.includes(ev), 'no ' + ev + ' handler may exist');
  }
});

test('the rotator avoids repetition and never leaves a stale card behind', () => {
  const js = INDEX.slice(INDEX.indexOf('ROTATING ARBITRAGE OPPORTUNITY NOTIFICATIONS'));
  assert.match(js, /Never repeat the same instrument back to back/);
  assert.match(js, /classList\.remove\('show'\)/);
  assert.match(js, /sessionStorage\.setItem\(CONFIG\.storageKey, '1'\)/);
  assert.match(js, /sessionStorage\.getItem\(CONFIG\.storageKey\) === '1'/);
  // No hardcoded fallback catalogue: a failed fetch simply shows nothing.
  assert.ok(!/BTC\/USDT|XAU\/USD|EUR\/USD/.test(js), 'JS must not hardcode instruments');
});

test('the rotator only calls the public endpoint and touches no app state', () => {
  const js = INDEX.slice(INDEX.indexOf('ROTATING ARBITRAGE OPPORTUNITY NOTIFICATIONS'));
  assert.match(js, /fetch\(CONFIG\.endpoint/);
  assert.ok(!/\/api\/(trade|bot|withdraw|deposit|payment|subscription|auth)/.test(js), 'only the public market endpoint may be called');
  assert.ok(!/APP\.(balance|liveData|mode)\s*=/.test(js), 'the rotator must not mutate app state');
  // Values are rendered as text (no HTML injection surface).
  assert.match(js, /textContent/);
  assert.ok(!/innerHTML/.test(js), 'the rotator must not use innerHTML');
  assert.match(js, /Number\(opp\.spreadPct\)\.toFixed\(2\) \+ '%'/);
  assert.match(js, /Number\(opp\.netSpreadPct\)\.toFixed\(2\) \+ '%'/);
});

test('language switching re-applies the card labels', () => {
  const hook = INDEX.indexOf('if (typeof renderArbOpportunityLabels === \'function\') renderArbOpportunityLabels();');
  const dyn = INDEX.indexOf('function updateDynamicTranslations()');
  assert.ok(hook > dyn && hook < dyn + 6000, 'the label hook must live in updateDynamicTranslations');
});

// ==========================================================================
// 4. I18N
// ==========================================================================
test('all 6 locales define the 4 arbOpp keys with identical key sets', () => {
  const tIdx = INDEX.indexOf('const TRANSLATIONS = {');
  const end = INDEX.indexOf('\n};\n', tIdx);
  const obj = INDEX.slice(tIdx + 'const TRANSLATIONS = '.length, end + 2);
  const vm = require('node:vm');
  const sb = {};
  vm.createContext(sb);
  const T = vm.runInContext('(' + obj + ')', sb);
  const keys = ['arbOpp.title', 'arbOpp.observed', 'arbOpp.net', 'arbOpp.dismiss'];
  for (const l of LANGS) {
    for (const k of keys) {
      assert.ok(T[l][k] && String(T[l][k]).trim(), l + ' missing ' + k);
    }
  }
  assert.strictEqual(T.en['arbOpp.title'], 'Arbitrage opportunity');
  assert.strictEqual(T.en['arbOpp.observed'], 'Observed spread');
  assert.strictEqual(T.en['arbOpp.net'], 'Est. net spread');
  for (const l of LANGS) {
    for (const k of keys) {
      // No money/profit claims baked into the labels (the numbers come from the API).
      assert.ok(!/[$%]/.test(T[l][k]), l + ' ' + k + ' must not contain a figure');
    }
  }
});

// ==========================================================================
// 5. SAFEGUARDS - the trading engine is untouched
// ==========================================================================
test('the trading engine, ticker and registry wiring are unchanged', () => {
  assert.match(INDEX, /const profit = data\.balance \* 0\.5 \* \(Math\.random\(\)\*2\.4\/100\) \* \(Math\.random\(\)>0\.35 \? 1 : -0\.5\);/);
  assert.match(INDEX, /setInterval\(executeBotTrade, 8000\)/);
  assert.match(INDEX, /const asset = assets\[Math\.floor\(Math\.random\(\)\*assets\.length\)\];/);
  const tick = (INDEX.match(/const TICKER_ASSETS = \[(.*?)\];/) || [])[1] || '';
  assert.strictEqual((tick.match(/\{symbol:'/g) || []).length, 47);
});

test('no existing server route, RPC or safeguard was modified', () => {
  assert.match(SERVER, /app.get\('\/api\/health', \(req, res\) => res\.json\(\{ status: 'ok' \}\)\);/);
  assert.match(SERVER, /const MIN_WITHDRAWAL_USD = 700;/);
  assert.match(SERVER, /PLATFORM_MIN_DEPOSIT_USD = 100/);
  assert.match(SERVER, /rpc\('record_trade_safe', \{/);
  // The new endpoint is additive: it appears exactly once.
  assert.strictEqual((SERVER.match(/\/api\/market\/opportunities/g) || []).length, 1);
});
