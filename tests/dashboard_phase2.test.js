'use strict';
/**
 * PHASE 2 — the mobile dashboard consolidation, pinned.
 *
 * The owner reviewed the rendered mobile UI and rejected the layout: a 98px
 * header, four stacked KPI cards that repeated the same balance, a 663px wallet
 * section, a checklist that stayed card-sized when already complete, a bot card
 * labelled "ready to trade" while stopped, and drawer/support controls that
 * competed for the same corner. These tests pin the FIXES - and, where the
 * reasoning was wrong in the original code, the reason it was wrong.
 *
 * Everything here is markup/CSS/copy plus the presentation functions. No money
 * path, no server, no schema.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const CSS = INDEX;

function translations() {
  // Brace-match the real object (the literal is far larger than a fixed window).
  const block = Array.from(INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g))
    .map((m) => m[1]).find((b) => b.includes('const TRANSLATIONS'));
  assert.ok(block, 'the TRANSLATIONS block exists');
  const open = block.indexOf('{', block.indexOf('const TRANSLATIONS'));
  let depth = 0, close = -1;
  for (let i = open; i < block.length; i++) {
    if (block[i] === '{') depth++;
    else if (block[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
  }
  assert.ok(close > open, 'the object is brace-matchable');
  // eslint-disable-next-line no-eval
  return eval('(' + block.slice(open, close + 1) + ')');
}
const T = translations();
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

/* ------------------------------------------------------------------ *
 * 1. Toolbar: one compact row; the hamburger no longer floats
 * ------------------------------------------------------------------ */
test('the mobile toolbar is one compact row, not a 98px stack', () => {
  // The measured cause: 44px of clearance for a position:fixed hamburger plus a
  // two-row grid ("burger brand right" / "sub sub sub").
  assert.match(INDEX, /\.app-header \.mobile-menu-btn \{[^}]*position:static/, 'the hamburger is a grid item');
  assert.doesNotMatch(INDEX, /\.app-header\{[^}]*padding-top:44px/, 'no 44px clearance rule remains');
  assert.match(INDEX, /#appToolbar\{flex-wrap:nowrap;padding:8px 12px !important;gap:10px;min-height:56px;\}/,
    'the tablet toolbar is forced onto one row');
  assert.match(INDEX, /\.app-header\{\s*padding:6px 10px !important;/, 'the phone toolbar padding is compact');
  // A floor, never a fixed height: a long translation may still grow the row.
  assert.match(INDEX, /\.app-header\{[\s\S]{0,200}min-height:56px;/, 'the toolbar sets a floor');
  const block = INDEX.slice(INDEX.indexOf('.app-header{\n        padding:6px 10px'), INDEX.indexOf('.app-header{\n        padding:6px 10px') + 600);
  assert.doesNotMatch(block, /(^|[;{\s])height:\s*\d+px/, 'never a fixed height');
});

test('the 320px toolbar drops the view title instead of the controls', () => {
  const m = INDEX.match(/@media \(max-width:360px\)\{([\s\S]*?)\n\}/);
  assert.ok(m, 'the 360px block exists');
  assert.match(m[1], /\.kx-toolbar-sub\{display:none;\}/, 'the secondary title yields first');
  assert.match(m[1], /#appToolbar\{grid-template-columns:auto minmax\(0,1fr\) auto/, 'brand + controls keep one row');
  assert.doesNotMatch(m[1], /display:none !important/, 'hiding never needs !important in this layer');
});

/* ------------------------------------------------------------------ *
 * 2. One account card instead of four KPI cards
 * ------------------------------------------------------------------ */
test('the account card renders each figure once and keeps both actions', () => {
  const hero = INDEX.slice(INDEX.indexOf('<div class="kx-hero" id="kxHero">'), INDEX.indexOf('id="startHereCard"'));
  for (const id of ['totalEquity', 'balanceValue', 'pnlValue', 'botStatus']) {
    assert.strictEqual((hero.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, id + ' appears once');
  }
  assert.match(hero, /id="availableDepositBtn"[^>]*onclick="openDepositModal\(\)"/);
  assert.match(hero, /id="availableWithdrawBtn"[^>]*onclick="openWithdrawModal\(\)"/);
  // the Available id is preserved for the discoverability tests, and it now owns
  // the two actions (availability + what you can do with it)
  const available = hero.slice(hero.indexOf('id="availableStatCard"'), hero.indexOf('kx-acct-metrics'));
  assert.match(available, /availableDepositBtn/, 'deposit is grouped with availability');
  assert.match(available, /availableWithdrawBtn/, 'withdraw is grouped with availability');
  // every figure still explains itself in plain language
  for (const hint of ['hint.equity', 'hint.available', 'hint.pnl', 'hint.botStatus']) {
    assert.match(hero, new RegExp('data-i18n="' + hint + '"'), hint + ' is present');
  }
});

test('the desktop account card is a horizontal band (no 3-row stack)', () => {
  assert.match(INDEX, /@media \(min-width:1200px\)\{\s*\.kx-account \.card-body\{/, 'the desktop band exists');
  const block = INDEX.slice(INDEX.indexOf('@media (min-width:1200px){'), INDEX.indexOf('@media (min-width:1200px){') + 700);
  assert.match(block, /grid-template-columns:minmax\(0,1\.05fr\) minmax\(0,1fr\) minmax\(0,1fr\)/, 'three columns');
  assert.match(block, /\.kx-acct-row\{grid-column:2;border-top:0;padding-top:0/, 'the middle column loses its divider');
});

/* ------------------------------------------------------------------ *
 * 3. A completed checklist is one line
 * ------------------------------------------------------------------ */
test('the completion state lives in the same row as Dismiss and is compact', () => {
  const card = INDEX.slice(INDEX.indexOf('id="startHereCard"'), INDEX.indexOf('id="liveModeCard"'));
  const rowStart = card.indexOf('class="kx-starthere-row"');
  const row = card.slice(rowStart, card.indexOf('id="startHereStepsLive"'));
  assert.ok(rowStart > 0, 'the header row exists');
  assert.match(row, /id="startHereStepsLiveReady"/, 'the ready line sits inside the header row');
  assert.match(row, /onclick="dismissStartHere\(\)"/, 'Dismiss stays in that row');
  assert.match(INDEX, /\.kx-ready \.card-body\{padding:8px 12px;\}/, 'ready padding is trimmed');
  assert.match(INDEX, /\.kx-ready \.btn\{min-height:30px;padding:0 9px;font-size:10\.5px;\}/, 'the dismiss control shrinks, still tappable');
  assert.match(INDEX, /\.kx-ready #startHereStepsLiveReady > div\{font-size:11\.5px/, 'one small line of text');
});

/* ------------------------------------------------------------------ *
 * 4. ONE bot state machine
 * ------------------------------------------------------------------ */
test('the bot state machine has one source of truth and no invented state', () => {
  const fn = INDEX.slice(INDEX.indexOf('function botUiState'), INDEX.indexOf('function updateStatus'));
  assert.match(fn, /if \(APP\.botRunning\) return 'running';/, 'running only from the live flag');
  assert.match(fn, /if \(APP\.botPaused === true\) return 'paused';/, 'a server pause is paused');
  assert.match(fn, /APP\.liveData\.promoLimitReached\) return 'paused';/, 'the promo cap is paused, not running');
  assert.match(fn, /if \(APP\.botError\) return 'error';/, 'a failed start is an error');
  // 'ready' used to be gated on APP.mode === 'live', a variable nothing assigns
  // in this single-mode build, so the pill sat on "Offline" while Start worked.
  assert.ok(!/if \(APP\.mode/.test(fn), 'no state depends on the removed APP.mode');
  assert.match(fn, /return 'ready';/, 'a stopped bot on this single-mode build is ready');
});

test('the pill, the account metric and the card message come from that state', () => {
  const fn = INDEX.slice(INDEX.indexOf('function renderBotState'), INDEX.indexOf('function updateStatus'));
  assert.match(fn, /pill\.dataset\.state = state/, 'the pill reads the state');
  assert.match(fn, /getEl\('botStatus'\)/, 'the account metric reads the same state');
  assert.match(fn, /getEl\('botStatusMsgLive'\)/, 'the card message reads the same state');
  assert.match(fn, /t\(labelKey\)/, 'labels are translated');
  assert.match(fn, /t\(msgKey\)/, 'the message is translated');
});

test('the stopped bot never says "ready to trade"', () => {
  // The old copy told a STOPPED bot it was "ready to trade".
  const fn = INDEX.slice(INDEX.indexOf('function renderBotState'), INDEX.indexOf('function updateStatus'));
  const msg = fn.slice(fn.indexOf('const msgKey'), fn.indexOf('const pill'));
  assert.ok(!/readyToTrade/.test(msg), 'no "ready to trade" in the stopped-state messages');
  assert.match(msg, /paused: 'bot\.pausedMsg'/, 'the paused state explains why it is not trading');
  assert.match(msg, /running: 'bot\.runningMsg'/, 'running explains what it is doing');
  assert.match(msg, /ready: 'bot\.readyMsg'/, 'ready explains how to start it');
  assert.match(msg, /error: 'bot\.errorMsg'/, 'error explains the retry path');
  assert.match(CSS, /'bot\.readyMsg':/, 'every state has its own sentence');
  assert.match(CSS, /'hint\.botStatus\.running':/, 'the metric hint follows the state');
  assert.match(CSS, /'hint\.botStatus\.ready':/, 'idle is described as idle, not "running or stopped"');
  assert.ok(!/'hint\.botStatus': 'Running or stopped'/.test(CSS), 'the generic toggle description is gone');
  // and the updateUI block that used to force the message is gone
  assert.ok(!/botMsgLive\.textContent = t\('bot\.readyToTrade'\)/.test(INDEX), 'no leftover forced message');
});

test('a refused start cannot leave a lying pill', () => {
  assert.match(INDEX, /APP\.botPaused = true;\s*\n\s*if \(typeof renderBotState === 'function'\) renderBotState\(\);/, 'a pause refusal repaints');
  assert.match(INDEX, /\.catch\(function \(\) \{[\s\S]{0,240}APP\.botError = true;/, 'a failed start request paints an error');
  assert.match(INDEX, /function beginBotRun\(\)[\s\S]{0,200}APP\.botError = false;/, 'a successful start clears the error');
});

test('the bot labels are rebuilt on a language switch', () => {
  const start = INDEX.indexOf('function updateDynamicTranslations');
  const fn = INDEX.slice(start, INDEX.indexOf('\n}', start));
  assert.match(fn, /renderBotState/, 'the state machine is re-run after a language change');
  assert.match(fn, /renderRecentTrades/, 'the recent list is re-run too');
});

/* ------------------------------------------------------------------ *
 * 5. Trading activity is visible on the dashboard, from real rows
 * ------------------------------------------------------------------ */
test('the statistics card carries the latest executed trades', () => {
  const card = INDEX.slice(INDEX.indexOf('id="tradingStatsCard"'), INDEX.indexOf('id="history"'));
  assert.match(card, /id="kxStatsRecent"/, 'the recent list lives in the stats card');
  const fn = INDEX.slice(INDEX.indexOf('function renderRecentTrades'), INDEX.indexOf('function renderRecentTrades') + 1600);
  assert.match(fn, /e\.type === 'Trade Executed'/, 'only executed trades are listed');
  assert.match(fn, /\.slice\(0, 3\)/, 'three rows at most');
  assert.match(fn, /onclick="showView\(\\'activity\\'\)"/, 'the "all activity" link opens the ledger view');
  assert.match(fn, /escapeHtml/, 'the asset label is escaped');
  assert.match(fn, /fin-positive|fin-negative/, 'the amount is coloured by sign');
  assert.match(fn, /host\.hidden = true/, 'it hides itself when there is nothing to show');
});

/* ------------------------------------------------------------------ *
 * 6. Copy honesty
 * ------------------------------------------------------------------ */
test('the tab-bound bot notice states its real limitation in all 6 locales', () => {
  for (const l of LANGS) {
    const v = T[l]['bot.engineNotice'];
    assert.ok(v && v.length > 20, l + ' has the notice');
    assert.ok(!/offline/i.test(v), l + ' does not claim offline trading for a tab-bound bot');
  }
  assert.strictEqual(
    T.en['bot.engineNotice'],
    '\u{1F916} Trading runs from this page while the bot is running. Keep this tab open \u2014 closing or refreshing it stops the bot until you start it again.'
  );
  // Neutral variant for "the server has not told us which engine is trading".
  for (const l of LANGS) {
    assert.ok(T[l]['bot.engineNoticeUnknown'] && T[l]['bot.engineNoticeUnknown'].length > 20, l + ' has the neutral notice');
  }
  // the worker variant is the only one allowed to promise background trading
  assert.match(T.en['bot.engineNoticeWorker'], /keeps running even when you close this page/i);
  // the markup default (pre-hydration, before applyTranslations) matches EN
  // (string comparison, not a regex: `\u{...}` needs the /u flag)
  // The element ships with the NEUTRAL variant: until the server says which engine
  // owns the session, the page must not claim the tab is what stops trading.
  assert.ok(INDEX.includes('data-i18n="bot.engineNoticeUnknown">\u{1F916} The bot\'s current status is shown above.'),
    'the pre-hydration markup default is the neutral copy');
});

/* ------------------------------------------------------------------ *
 * 7. Drawer + support coordination
 * ------------------------------------------------------------------ */
test('the drawer close control is real and the base contract is untouched', () => {
  assert.match(INDEX, /id="drawerCloseBtn"/, 'the close button exists');
  assert.match(INDEX, /\.kx-drawer-close\{[\s\S]{0,200}width:36px;height:36px/, 'it is a 36px target');
  assert.match(INDEX, /\.kx-drawer-close\{display:inline-flex;\}/, 'it only shows in the mobile block');
  // the pinned base rule (.sidebar fixed/260px/78vw) stays authoritative: the
  // compact overrides are scoped to the element id
  assert.match(INDEX, /#sidebar\{width:min\(272px,74vw\);padding:12px 0 8px;\}/, 'the width cap is scoped to #sidebar');
  assert.doesNotMatch(INDEX, /\.sidebar\{width:min\(272px/, 'no unscoped .sidebar width override');
});

test('the support launcher and the panel never compete for the corner', () => {
  assert.match(INDEX, /body:has\(#depositModal\.open\) \.support-widget\{display:none;\}/, 'the FAB yields to a dialog');
  assert.match(INDEX, /\.support-widget:has\(\.support-panel\.open\) \.support-toggle-btn\{display:none;\}/, 'the FAB yields to its own panel');
  assert.match(INDEX, /\.support-panel button\{min-height:36px;\}/, 'panel controls are tappable');
  assert.match(INDEX, /\.toast-close\{min-width:32px;min-height:32px/, 'the toast close is tappable');
});

/* ------------------------------------------------------------------ *
 * 8. i18n parity for the new keys
 * ------------------------------------------------------------------ */
test('every new key exists, translated, in all six locales', () => {
  const keys = ['bot.readyToStart', 'bot.pausedShort', 'bot.errorState', 'bot.runningMsg', 'trading.recent'];
  for (const l of LANGS) {
    for (const k of keys) {
      const v = T[l][k];
      assert.ok(typeof v === 'string' && v.trim().length > 0, l + ' missing ' + k);
    }
  }
  assert.strictEqual(T.en['trading.recent'], 'Recent trades');
  assert.strictEqual(T.en['bot.readyToStart'], 'Ready to start');
  assert.strictEqual(T.en['bot.pausedShort'], 'Paused');
  // identical key sets across locales
  const en = Object.keys(T.en).sort().join(',');
  for (const l of LANGS) assert.strictEqual(Object.keys(T[l]).sort().join(','), en, l + ' key set matches EN');
});

/* ------------------------------------------------------------------ *
 * 9. Nothing financial moved
 * ------------------------------------------------------------------ */
test('the presentation layer never touches money', () => {
  const fns = ['function botUiState', 'function renderBotState', 'function renderRecentTrades'].map((a) => {
    const i = INDEX.indexOf(a);
    return INDEX.slice(i, i + 1800);
  }).join('\n');
  for (const forbidden of ['updateWallet', "rpc(", '/api/', 'record_trade', 'live_balance', 'bonus_balance', 'saveData(']) {
    assert.ok(!fns.includes(forbidden), 'no ' + forbidden + ' in the presentation helpers');
  }
  // the balance the card shows still comes from the server-synced wallet
  assert.match(INDEX, /function syncWalletFromServer/, 'wallet sync untouched');
});

/* ------------------------------------------------------------------ *
 * 10. No dead-end guidance in the Live Mode card
 * ------------------------------------------------------------------ */
test('every "make your deposit" state also offers the deposit action', () => {
  // AUDIT FINDING (onboarding/activation pass): `funding_required` rendered the
  // sentence "Make a deposit to fund your Live balance" while the deposit button
  // was toggled ONLY for `deposit_required` - a message with no action.
  const start = INDEX.indexOf('function renderLiveModeCard');
  const fn = INDEX.slice(start, start + 4000);
  assert.match(fn, /const needsDeposit = status === 'deposit_required' \|\| status === 'funding_required'/,
    'every deposit state offers the action');
  assert.match(fn, /\|\| status === 'activation_required';/, 'the legacy server state is treated as a deposit state');
  assert.match(fn, /if \(depBtn\) depBtn\.classList\.toggle\('hidden', !needsDeposit\);/, 'the button follows that decision');
  // The paid-activation control no longer exists at all.
  assert.ok(!INDEX.includes('liveModeActivateBtn'), 'no activation button remains');
});

test('the paid-activation dialog is gone from the customer journey', () => {
  // Removed by management decision: Live Mode is funded by a deposit, so there
  // is no purchase dialog to keep reachable. A legacy LIVE_ACTIVATION_REQUIRED
  // refusal is answered with a neutral message and a support route instead.
  assert.ok(!INDEX.includes('id="liveActivationModal"'), 'no activation dialog');
  assert.ok(!INDEX.includes('liveActivation.'), 'no activation keys');
  const refusal = INDEX.slice(INDEX.indexOf('function handleLiveAccessRefusal'), INDEX.indexOf('function isProfitPausePayload'));
  assert.match(refusal, /liveAccess\.notAvailable/, 'a neutral explanation');
  assert.match(refusal, /openSupportModal\(\)/, 'a human route');
});
