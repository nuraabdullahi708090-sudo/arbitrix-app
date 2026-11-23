'use strict';

/**
 * Kalderix UI redesign - structural contracts.
 *
 * These tests pin the parts of the redesign that other suites do not cover:
 * the design-token layer, the account-summary hero, the grouped sidebar and the
 * view router that replaced the single long scroll. They are deliberately
 * STRUCTURAL (static source + a vm run of the real router) so they cannot pass
 * on a page whose layout silently regressed.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/* ------------------------------------------------------------------ *
 * 1. Design tokens
 * ------------------------------------------------------------------ */
test('the design-system layer defines the token set it consumes', () => {
  const tokens = [
    '--kx-bg', '--kx-surface', '--kx-surface-2', '--kx-elevated', '--kx-line', '--kx-line-strong',
    '--kx-text', '--kx-text-2', '--kx-text-3', '--kx-r-1', '--kx-r-2', '--kx-r-3', '--kx-r-4',
    '--kx-s-1', '--kx-s-4', '--kx-t-1', '--kx-t-5', '--kx-t-8', '--kx-e3', '--kx-ease',
    '--kx-nav-w', '--kx-content', '--kx-tap',
  ];
  for (const t of tokens) assert.match(INDEX, new RegExp(t + '\\s*:'), t + ' must be defined');
  // The accent is NOT redefined: the redesign kept the shipped palette.
  assert.match(INDEX, /--kx-accent:\s*#0ECB81|--brand:\s*#5EA0FF/);
  assert.ok(!/--kx-brand:\s*#/.test(INDEX), 'no second brand colour is introduced');
});

test('financial figures use tabular numerals', () => {
  assert.match(INDEX, /\.kx-kpi-value[^{]*\{[^}]*font-variant-numeric:tabular-nums|font-variant-numeric:tabular-nums/);
  assert.match(INDEX, /#totalEquity,#balanceValue,#pnlValue/, 'the KPI ids join the numeral rule');
});

/* ------------------------------------------------------------------ *
 * 2. Account summary hero
 * ------------------------------------------------------------------ */
test('the hero keeps every KPI id and both primary actions', () => {
  const heroStart = INDEX.indexOf('<div class="kx-hero"');
  const hero = INDEX.slice(heroStart, INDEX.indexOf('id="liveModeCard"', heroStart));
  assert.ok(hero.length > 500, 'hero block extracted');
  for (const id of ['totalEquity', 'balanceValue', 'pnlValue', 'botStatus']) {
    assert.match(hero, new RegExp('id="' + id + '"'), id + ' lives in the hero');
  }
  assert.match(hero, /id="availableDepositBtn"[^>]*onclick="openDepositModal\(\)"/, 'deposit action preserved');
  assert.match(hero, /id="availableWithdrawBtn"[^>]*onclick="openWithdrawModal\(\)"/, 'withdraw action preserved');
  assert.match(hero, /id="availableStatCard"/, 'the Available card keeps its id');
  // The four KPIs are ordered: equity, available, P&L, bot state.
  const order = ['kx-hero-eq', 'kx-hero-av', 'kx-hero-pnl', 'kx-hero-bot'].map((c) => hero.indexOf(c));
  assert.ok(order.every((v) => v >= 0), 'all four hero slots exist');
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'hero slots keep their order');
  assert.match(hero, /class="stat-value fin-zero"/, 'P&L still starts neutral');
});

test('the cockpit groups the chart with the trading statistics', () => {
  assert.match(INDEX, /<div class="kx-cockpit" id="kxCockpit">/);
  assert.match(INDEX, /<div class="chart-card" id="chartCard">/);
  assert.match(INDEX, /<div class="trading-stats-card" id="tradingStatsCard">/);
  const cockpit = INDEX.slice(INDEX.indexOf('id="kxCockpit"'), INDEX.indexOf('id="walletTabsWrapper"'));
  assert.ok(cockpit.indexOf('id="chartCard"') < cockpit.indexOf('id="tradingStatsCard"'), 'chart precedes the stats');
});

/* ------------------------------------------------------------------ *
 * 3. Grouped navigation
 * ------------------------------------------------------------------ */
test('the sidebar is grouped and every label is localized in all 6 locales', () => {
  const groups = [...INDEX.matchAll(/data-i18n="nav\.([a-z]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(groups, ['overview', 'money', 'trading', 'grow', 'account']);

  const start = INDEX.indexOf('const TRANSLATIONS');
  const open = INDEX.indexOf('{', start);
  let depth = 0;
  let i = open;
  for (; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (!depth) { i++; break; } }
  }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(INDEX.slice(start, i).replace('const TRANSLATIONS', 'var TRANSLATIONS'), ctx);
  const T = ctx.TRANSLATIONS;
  const langs = Object.keys(T);
  assert.strictEqual(langs.length, 6);
  for (const lang of langs) {
    for (const g of groups) {
      const v = T[lang]['nav.' + g];
      assert.ok(typeof v === 'string' && v.trim(), lang + ' missing nav.' + g);
      assert.ok(!/^nav\./.test(v), lang + ' nav.' + g + ' is not translated');
    }
  }
  // Identical key sets across locales.
  const size = Object.keys(T.en).length;
  langs.forEach((l) => assert.strictEqual(Object.keys(T[l]).length, size, l + ' key count'));
});

test('every sidebar link keeps its id, handler or section', () => {
  const required = ['depositSidebarLink', 'withdrawSidebarLink', 'verificationSidebarLink', 'supportSidebarLink',
    'subscriptionSidebarLink', 'adminSidebarLink', 'twofaLink', 'profileLink', 'pwaInstallSidebarLink', 'logoutLink'];
  for (const id of required) assert.match(INDEX, new RegExp('id="' + id + '"'), id + ' must stay');
  assert.match(INDEX, /data-section="mainContent"/);
  assert.match(INDEX, /data-section="markets"/);
  assert.match(INDEX, /data-section="history"/);
  assert.match(INDEX, /data-section="referral"/);
});

/* ------------------------------------------------------------------ *
 * 4. View router
 * ------------------------------------------------------------------ */
test('the router is top-level (not trapped inside initApp) and precedes its consumer', () => {
  const initApp = INDEX.indexOf('async function initApp()');
  const showView = INDEX.indexOf('function showView(name, opts)');
  const admin = INDEX.indexOf('function navigateToAdmin(e)');
  assert.ok(initApp > 0 && showView > 0 && admin > 0);
  assert.ok(showView > initApp, 'the definitions still live after initApp in source order');
  const between = INDEX.slice(initApp, showView);
  // Balanced braces between initApp and the router mean initApp has closed.
  const open = (between.match(/\{/g) || []).length;
  const close = (between.match(/\}/g) || []).length;
  assert.strictEqual(open, close, 'initApp is closed before the router is declared (module scope)');
  assert.ok(showView < admin, 'navigateToAdmin can call showView');
});

test('navigateToAdmin delegates to the router instead of hiding cards', () => {
  const start = INDEX.indexOf('function navigateToAdmin(e) {');
  const end = INDEX.indexOf('function showAdminTab');
  const src = INDEX.slice(start, end);
  assert.match(src, /showView\('admin'\)/);
  assert.ok(!/querySelectorAll\('\.card, \.wallet-section'\)/.test(src), 'the hide-everything loop is gone');
  assert.ok(!/style\.display\s*=\s*'none'/.test(src), 'no card is hidden with an inline style');
});

test('the router switches views, title, hash and active link (real code, fake DOM)', () => {
  const start = INDEX.indexOf('// ============ VIEW ROUTER (Kalderix shell) ============');
  const end = INDEX.indexOf('function navigateToAdmin(e) {', start);
  assert.ok(start > 0 && end > start);
  const src = INDEX.slice(start, end);

  const mk = (id) => ({
    id, hidden: false, style: {},
    classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    textContent: '',
  });
  const els = { kxViewOverview: mk('kxViewOverview'), markets: mk('markets'), history: mk('history'), referral: mk('referral'), adminPanel: mk('adminPanel'), kxViewTitle: mk('kxViewTitle') };
  const active = mk('activeLink');
  const sandbox = {
    APP: {},
    t: (k) => 'T:' + k,
    document: {
      body: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
      getElementById: (id) => els[id] || null,
      querySelectorAll: () => [active],
      querySelector: () => active,
    },
    history: { replaced: null, replaceState(a, b, url) { this.replaced = url; } },
    window: { scrolled: 0, scrollTo() { this.scrolled++; } },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  assert.strictEqual(vm.runInContext("showView('markets')", sandbox), 'markets');
  assert.strictEqual(els.kxViewOverview.hidden, true);
  assert.strictEqual(els.markets.style.display, '');
  assert.strictEqual(els.history.style.display, 'none');
  assert.strictEqual(els.kxViewTitle.textContent, 'T:sidebar.markets');
  assert.strictEqual(sandbox.history.replaced, '#markets');
  assert.strictEqual(sandbox.document.body.attrs['data-kx-view'], 'markets');
  assert.ok(active.classList.contains('active'), 'the matching nav link is marked active');

  // Unknown names fall back to the dashboard, never to a blank screen.
  assert.strictEqual(vm.runInContext("showView('nope')", sandbox), 'overview');
  assert.strictEqual(els.kxViewOverview.hidden, false);
  // Admin is a view too.
  assert.strictEqual(vm.runInContext("showView('admin')", sandbox), 'admin');
  assert.strictEqual(els.adminPanel.style.display, 'block');
  assert.ok(!els.adminPanel.classList.contains('hidden'), 'the hidden class is lifted');
  // A deep link resolves through the hash helper.
  assert.strictEqual(vm.runInContext("kxNormalizeView('activity')", sandbox), 'activity');
});

test('the nav wiring calls the router and keeps the drawer cleanup', () => {
  assert.match(INDEX, /showView\(KX_SECTION_TO_VIEW\[link\.dataset\.section\] \|\| 'overview'/, 'links route through the router');
  assert.match(INDEX, /getEl\('sidebar'\)\.classList\.remove\('open'\)/, 'the drawer still closes on navigation');
  assert.match(INDEX, /hashchange/, 'deep links are honoured');
});

/* ------------------------------------------------------------------ *
 * 5. Layout + accessibility contract
 * ------------------------------------------------------------------ */
test('the cockpit and hero respond at the documented breakpoints', () => {
  assert.match(INDEX, /\.kx-cockpit\{display:grid;grid-template-columns:minmax\(0,1fr\);/, 'mobile first: one column');
  assert.match(INDEX, /@media\(min-width:1100px\)\{[\s\S]{0,400}\.kx-cockpit\{grid-template-columns:minmax\(0,1\.9fr\) minmax\(0,1fr\);\}/, 'desktop: chart + stats');
  assert.match(INDEX, /@media\(min-width:641px\) and \(max-width:1099px\)\{[\s\S]{0,300}grid-template-areas:"eq av" "pnl bot"/, 'tablet: 2x2 hero');
  assert.match(INDEX, /@media\(max-width:640px\)\{[\s\S]{0,600}\.kx-cockpit\{grid-template-columns:minmax\(0,1fr\);\}/, 'mobile stays stacked');
});

test('the mobile header override cannot cancel the hamburger clearance', () => {
  // The base rule reserves 44px at the top for the fixed menu button. A `padding`
  // shorthand in the mobile block silently resets padding-top, which put the header
  // underneath the hamburger (caught by measurement, pinned here).
  const layer = INDEX.slice(INDEX.indexOf('KALDERIX DESIGN SYSTEM v2'));
  const mobile = layer.slice(layer.indexOf('@media(max-width:640px){'));
  const rule = mobile.slice(mobile.indexOf('.app-header{'), mobile.indexOf('}', mobile.indexOf('.app-header{')));
  assert.match(layer, /\.app-header\{[\s\S]{0,400}padding-top:44px;/, 'the base rule reserves the clearance');
  assert.ok(!/(^|;)padding:/.test(rule), 'the mobile rule must not use the padding shorthand: ' + rule);
  assert.match(rule, /padding-(left|right):/, 'it adjusts the sides only');
});

test('accessibility: visible focus ring and reduced-motion support', () => {
  assert.match(INDEX, /:focus-visible\{[\s\S]{0,120}outline:2px solid var\(--brand\)/);
  assert.match(INDEX, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(INDEX, /\.kx-view\[hidden\]\{display:none;\}/, 'views hide without !important');
});

test('the layer never hides a control with !important', () => {
  const layer = INDEX.slice(INDEX.indexOf('KALDERIX DESIGN SYSTEM v2'));
  const hits = [...layer.matchAll(/display:\s*none\s*!important/g)];
  assert.deepStrictEqual(hits.map((h) => h[0]), [], 'no !important display:none in the design layer');
});

/* ------------------------------------------------------------------ *
 * 6. Preservation
 * ------------------------------------------------------------------ */
test('pre-existing behaviour surfaces are untouched by the redesign', () => {
  // The wallet tabs, history card, referral card and modals keep their ids.
  for (const id of ['liveWalletSection', 'bonusWalletSection', 'walletTabsWrapper', 'history', 'markets',
    'referral', 'depositModal', 'withdrawModal', 'profileModal', 'supportModal', 'verificationModal']) {
    assert.match(INDEX, new RegExp('id="' + id + '"'), id + ' must stay');
  }
  // Money rules are not restyled into different semantics.
  assert.match(INDEX, /const TX_RESULT_TYPES = \{ 'Trade Executed': true \};/);
  assert.match(INDEX, /MIN_WITHDRAWAL: 700/);
  assert.match(INDEX, /MIN_DEPOSIT: 100/);
});
