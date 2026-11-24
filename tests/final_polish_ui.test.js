'use strict';
/**
 * Final UI polish guards (design/kalderix-ui-redesign, PR #204).
 *
 * Three visible defects were fixed without touching the design direction:
 *  1. the first-paint sync scrim could linger over the equity chart;
 *  2. the floating support launcher could sit on the chart, figures or controls;
 *  3. the bot pill said "Offline" for a startable bot and the metric hint
 *     described the toggle ("Running or stopped") instead of the state.
 *
 * These are source-level pins: the behaviour itself is exercised in the browser
 * audit recorded in docs/design/VISUAL_REVIEW_2026-11.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function fnSource(name) {
  const at = INDEX.indexOf('function ' + name);
  assert.ok(at > 0, name + ' exists');
  return INDEX.slice(at, INDEX.indexOf('\n}', at) + 2);
}

/* ---------------------------------------------------------------- 1. overlay */
test('the first-paint scrim is dismissed by one helper, three ways', () => {
  const helper = fnSource('dismissWalletSyncLoader');
  assert.match(helper, /getElementById\('walletSyncLoader'\)/, 'the helper owns the scrim');
  assert.match(helper, /pointerEvents = 'none'/, 'a fading scrim cannot swallow clicks');
  assert.match(helper, /style\.opacity = '0'/, 'it fades instead of vanishing');
  assert.match(helper, /setTimeout\(function \(\) \{\s*if \(el\.style\.opacity === '0'\) el\.style\.display = 'none';/,
    'it is removed from the layer tree after the fade');

  const initAt = INDEX.indexOf('async function initApp()');
  const init = INDEX.slice(initAt, INDEX.indexOf('\n}', INDEX.indexOf('anchorLiveChartToServerBalance();', initAt)));
  assert.match(init, /dismissWalletSyncLoader\('synced'\)/, 'the sync resolution dismisses it');
  assert.match(init, /setTimeout\(function \(\) \{ dismissWalletSyncLoader\('cap'\); \}, 1200\)/,
    'a slow session cannot leave it up past 1200ms');
  assert.match(INDEX, /addEventListener\('error', function \(\) \{ try \{ dismissWalletSyncLoader\('window-error'\)/,
    'an uncaught error dismisses it too');
  assert.ok(!/addEventListener\('pagehide'/.test(INDEX),
    'no pagehide hook (the activity rotator deliberately has none)');
});

test('the scrim is lighter than a black plate and cannot be read as a box', () => {
  const at = INDEX.indexOf('id="walletSyncLoader"');
  const tag = INDEX.slice(at, INDEX.indexOf('>', at));
  assert.match(tag, /background:rgba\(7,11,20,0\.82\)/, 'translucent, not opaque');
  assert.match(tag, /transition:opacity 0\.18s/, 'it fades');
  assert.match(tag, /z-index:9999/, 'it still covers the first paint');
});

/* ------------------------------------------------------------------ 2. bot */
test('botUiState reaches ready on this single-mode build', () => {
  const src = fnSource('botUiState');
  assert.ok(!/if \(APP\.mode/.test(src), 'no state depends on the removed APP.mode');
  assert.match(src, /return 'ready';/, 'a stopped bot is ready to start');
  assert.match(src, /if \(APP\.botRunning\) return 'running';/);
  assert.match(src, /if \(APP\.botPaused === true\) return 'paused';/);
  assert.match(src, /if \(APP\.botError\) return 'error';/);
});

test('each bot state carries its own sentence and metric hint', () => {
  const render = fnSource('renderBotState');
  ['ready', 'running', 'paused', 'error', 'offline'].forEach((state) => {
    assert.match(render, new RegExp(state + ": 'bot\\.[a-zA-Z]+Msg'"), state + ' has a message key');
  });
  ['ready', 'running', 'paused', 'error'].forEach((state) => {
    assert.match(render, new RegExp(state + ": 'hint\\.botStatus\\." + state + "'"), state + ' has a hint key');
  });
  assert.match(render, /getEl\('botStatusHint'\)/, 'the metric hint is re-rendered with the state');
  assert.match(INDEX, /id="botStatusHint"/, 'the hint element is addressable');
});

test('the generic "Running or stopped" description is gone from every locale', () => {
  const dict = INDEX.slice(INDEX.indexOf('const TRANSLATIONS'), INDEX.indexOf('function t('));
  assert.ok(!/Running or stopped/.test(dict), 'no locale still describes the toggle');
  assert.ok(!/En ejecución o detenido/.test(dict), 'nor the Spanish variant');
});

/* -------------------------------------------------------------- 3. launcher */
test('the launcher is content-aware, modal-aware and safe-area aware', () => {
  assert.match(INDEX, /\.support-widget\.kx-fab-away\{opacity:0;pointer-events:none;transform:translateY\(10px\);\}/,
    'an away state exists and cannot intercept a tap');
  const fab = fnSource('kxFabAvoidOverlap');
  assert.match(fab, /elementsFromPoint/, 'it hit-tests what sits beneath it');
  assert.match(fab, /#pnlChart, \.chart-period-tab, \.wallet-tab, \.btn, \.kx-kpi-value, \.chart-stat-value/,
    'it yields to the chart, controls and financial figures');
  assert.match(INDEX, /addEventListener\('scroll', kxFabSchedule, \{ passive: true \}\)/, 'it follows scrolling');
  assert.match(INDEX, /addEventListener\('resize', kxFabSchedule\)/, 'and resizing');

  assert.match(INDEX, /body:has\(#depositModal\.open\) \.support-widget\{display:none;\}/, 'deposit dialog hides it');
  assert.match(INDEX, /body:has\(\.deposit-modal\.open\) \.support-widget\{display:none;\}/, 'every dialog does');
  assert.match(INDEX, /body:has\(\.modal-overlay\.open\) \.support-widget\{display:none;\}/, 'so do the overlays');
  assert.match(INDEX, /body:has\(#supportModal\.open\) \.support-widget\{display:none;\}/, 'and the support centre');

  assert.match(INDEX, /@media \(max-width: ?640px\)\s*\{[\s\S]{0,600}?\.support-toggle-btn\{width:44px;height:44px/,
    'phones get a 44px target');
  assert.match(INDEX, /\.support-widget\{right:12px;bottom:calc\(12px \+ env\(safe-area-inset-bottom, 0px\)\);\}/,
    'and it respects the home-indicator inset');
});

/* --------------------------------------------------------------- 4. spacing */
test('the dashboard rhythm block exists and is scoped', () => {
  assert.match(INDEX, /\.kx-hero\{margin-bottom:10px;\}\s*\n\.kx-cockpit\{margin-bottom:10px;\}/,
    'account card and cockpit sit on the same 10px rhythm');
  assert.match(INDEX, /\.main-content\{padding-bottom:calc\(88px \+ env\(safe-area-inset-bottom, 0px\)\);\}/,
    'the last card never ends under the launcher (desktop)');
  assert.match(INDEX, /\.main-content\{padding-bottom:calc\(76px \+ env\(safe-area-inset-bottom, 0px\)\);\}/,
    'and on phones');
  assert.match(INDEX, /#startHereCard\{margin-bottom:12px !important;/, 'Getting Started is one step quieter');
  assert.match(INDEX, /#startHereCard #startHereStepsLive\{gap:6px;\}/, 'its steps are tighter');
});

/* ------------------------------------------------------------ 5. i18n parity */
test('all six locales keep identical key sets with no empties', () => {
  // Evaluate ONLY the dictionary literal (the code after it touches localStorage).
  const start = INDEX.indexOf('const TRANSLATIONS = {');
  assert.ok(start > 0, 'the dictionary literal exists');
  let depth = 0, end = -1;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, 'the literal is balanced');
  const vm = require('node:vm');
  const sandbox = {};
  vm.runInNewContext('this.__T = ' + INDEX.slice(INDEX.indexOf('{', start), end) + ';', sandbox);
  const T = sandbox.__T;
  const langs = Object.keys(T);
  assert.deepStrictEqual(langs.sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
  const base = Object.keys(T.en).sort();
  langs.forEach((l) => {
    assert.deepStrictEqual(Object.keys(T[l]).sort(), base, l + ' key set');
    const empty = base.filter((k) => !String(T[l][k] || '').trim());
    assert.deepStrictEqual(empty, [], l + ' has no empty value');
  });
  ['bot.readyMsg', 'bot.offlineMsg', 'bot.pausedMsg', 'bot.errorMsg',
    'hint.botStatus.ready', 'hint.botStatus.running', 'hint.botStatus.paused', 'hint.botStatus.error']
    .forEach((k) => langs.forEach((l) => assert.ok(T[l][k], l + ' ' + k)));
  assert.ok(!INDEX.includes('\ufffd'), 'no replacement characters');
});

/* ------------------------------------------------------------- 6. scope guard */
test('the polish is display-only: no money, auth or network code in the new paths', () => {
  const fab = fnSource('kxFabAvoidOverlap') + fnSource('kxFabSchedule');
  assert.ok(!/fetch\(|XMLHttpRequest|\/api\//.test(fab), 'the launcher never calls the API');
  const helper = fnSource('dismissWalletSyncLoader');
  assert.ok(!/fetch\(|XMLHttpRequest|\/api\//.test(helper), 'the scrim helper never calls the API');
  // The bot state machine still reads only display flags.
  const state = fnSource('botUiState');
  assert.ok(!/fetch\(|record_trade|\/api\//.test(state), 'the state machine cannot place a trade');
});
