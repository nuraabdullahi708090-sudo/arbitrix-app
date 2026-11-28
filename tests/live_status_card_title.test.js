'use strict';
/**
 * The dashboard used to render a STANDALONE "Promotional Credit" card
 * (`#liveModeCard`) beneath the Live Mode guidance card: a gift icon, the
 * promotional balance, a "Live Mode available" chip and an explanatory
 * sentence. Management asked for that card to be removed (it duplicated the
 * yellow promotional-credit notice, the wallet card and the account card).
 *
 * These tests pin the REMOVAL and, just as importantly, that nothing else
 * moved:
 *   - the upper Live Mode guidance card (`#startHereCard`) is untouched,
 *   - the yellow promotional-credit notice (`#promoCreditBanner`) is still the
 *     one customer-facing disclosure,
 *   - the wallet / Deposit / Withdraw entry points are untouched,
 *   - the promotional RULES (classification, $30 realised-profit cap, first
 *     deposit before withdrawal) are untouched,
 *   - the translations were not reduced.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const vm = require('node:vm');
const { readLf } = require('./helpers/text');

const ROOT = path.join(__dirname, '..');
const INDEX = readLf(path.join(ROOT, 'public', 'index.html'));
const SERVER = readLf(path.join(ROOT, 'server.js'));
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function dictionary() {
  const at = INDEX.indexOf('const TRANSLATIONS');
  let depth = 0;
  let end = -1;
  for (let i = INDEX.indexOf('{', at); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth += 1;
    else if (INDEX[i] === '}') {
      depth -= 1;
      if (!depth) { end = i; break; }
    }
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext('globalThis.T = ' + INDEX.slice(INDEX.indexOf('{', at), end + 1), sandbox);
  return sandbox.T;
}

/** The dashboard's overview markup (between the notice and the wallet block). */
function overviewMarkup() {
  const start = INDEX.indexOf('id="promoCreditBanner"');
  const end = INDEX.indexOf('id="liveWalletSection"');
  assert.ok(start > 0 && end > start, 'the overview block must be locatable');
  return INDEX.slice(start, end);
}

test('1. the standalone promotional-credit card is gone from the markup', () => {
  const overview = overviewMarkup();
  [
    'id="liveModeCard"',
    'id="liveModeCardTitle"',
    'id="liveModeCardIcon"',
    'id="promoCreditAmount"',
    'id="promoCreditAmountRow"',
    'id="liveModeStatusChip"',
    'id="promoCreditExplain"',
    'id="liveModeDepositBtn"',
  ].forEach((id) => {
    assert.strictEqual(INDEX.indexOf(id), -1, 'the removed card must not keep ' + id);
  });
  assert.ok(!/Promotional Credit<\/span>/.test(overview),
    'no dashboard card heading claims "Promotional Credit" any more');
  assert.ok(!/data-i18n="promo\.creditTitle"/.test(INDEX),
    'the card title binding is gone with the card');
  assert.ok(!/data-i18n="promo\.creditBadge"/.test(INDEX),
    'the inline "Promotional Credit" badge binding is gone with the card');
});

test('2. the card renderer and its helpers are gone', () => {
  ['renderLiveModeCard', 'liveModeStatusView', 'promoCreditText'].forEach((fn) => {
    assert.strictEqual(INDEX.indexOf('function ' + fn + '('), -1, fn + ' must be removed');
  });
  assert.strictEqual(INDEX.indexOf('LIVE_MODE_STATUS_VIEW'), -1, 'the dead status map is removed');
});

test('3. no call site can resurrect the card', () => {
  // Registration, the login sync and the language switch all used to re-render
  // it; none of them may reference it now.
  assert.ok(!/renderLiveModeCard/.test(INDEX), 'no re-render hook remains');
  assert.ok(!/liveModeCard/.test(INDEX), 'no CSS rule or id targets the removed card');
  // The server-derived state itself is still adopted (other surfaces and tests
  // rely on it), only the rendering is gone.
  assert.match(INDEX, /APP\.liveMode = data\.liveMode;/);
  assert.match(INDEX, /APP\.liveMode = meData\.liveMode;/);
});

test('4. the upper Live Mode guidance card is untouched', () => {
  const start = INDEX.indexOf('id="startHereCard"');
  assert.ok(start > 0, 'the guidance card still exists');
  const card = INDEX.slice(start, INDEX.indexOf('id="kxCockpit"'));
  assert.ok(/id="startHereHeadLive"/.test(card), 'its header is intact');
  assert.ok(/data-i18n="startHere\.live\.title"/.test(card), 'its title is intact');
  assert.ok(/id="startHereStepsLive"/.test(card), 'its steps container is intact');
  assert.ok(/id="startHereStepsLiveReady"/.test(card), 'its completion line is intact');
  assert.ok(/onclick="dismissStartHere\(\)"/.test(card), 'its Dismiss action is intact');
  assert.ok(/data-i18n="startHere\.live\.ready"/.test(card), 'the ready copy is intact');
  assert.ok(/id="startHereCard" style="margin-bottom:16px;border:1px solid var\(--brand-border\)/.test(INDEX),
    'the guidance card keeps its own styling');
});

test('5. the yellow promotional-credit notice is still the single disclosure', () => {
  const at = INDEX.indexOf('id="promoCreditBanner"');
  const banner = INDEX.slice(at - 120, at + 400);
  assert.ok(/kx-alert kx-alert-warning/.test(banner), 'the notice keeps its warning styling');
  assert.ok(/data-i18n="promo\.tradableNotice"/.test(banner), 'it still carries the approved sentence');
  assert.strictEqual((INDEX.match(/id="promoCreditBanner"/g) || []).length, 1,
    'exactly one promotional-credit notice exists');
  assert.ok(!/\$\{\{/.test(banner), 'the notice carries no un-interpolated amount');
});

test('6. the account card still offers Deposit and Withdraw', () => {
  assert.ok(/id="availableDepositBtn"[^>]*onclick="openDepositModal\(\)"/.test(INDEX),
    'the Deposit action is still on the first screen');
  assert.ok(/id="availableWithdrawBtn"[^>]*onclick="openWithdrawModal\(\)"/.test(INDEX),
    'the Withdraw action is still on the first screen');
  assert.ok(/onclick="toggleBot\(\)"/.test(INDEX), 'the bot control is untouched');
  assert.ok(/id="totalEquity"/.test(INDEX) && /id="balanceValue"/.test(INDEX) && /id="pnlValue"/.test(INDEX),
    'the account figures are untouched');
});

test('7. the promotional RULES are untouched by a presentation change', () => {
  // Server: one cap, one classifier, one refusal code.
  assert.match(SERVER, /const PROMO_PROFIT_CAP_USD = 30;/);
  assert.match(SERVER, /function isPromoProfitCapReached/);
  assert.match(SERVER, /PROMO_TRADING_LIMIT_REACHED/);
  assert.match(SERVER, /async function isPromoCreditFunded/);
  // Client: the server's verdict is still adopted and still stops the bot.
  assert.match(INDEX, /APP\.liveData\.promoLimitReached = meData\.promoLimitReached;/);
  assert.match(INDEX, /if\(APP\.liveData\.promoLimitReached\)/);
  assert.match(INDEX, /showToast\(t\('bot\.promoLimitReached'\)/);
  // The first-deposit-before-withdrawal rule is still the server's decision.
  assert.match(SERVER, /depositRequired: true/);
});

test('8. the removal changed no translation key set', () => {
  const T = dictionary();
  const base = Object.keys(T.en).sort();
  LANGS.forEach((l) => {
    assert.ok(T[l], l + ' dictionary must exist');
    assert.deepStrictEqual(Object.keys(T[l]).sort(), base, l + ' key set must be unchanged');
  });
  LANGS.forEach((l) => {
    assert.ok(T[l]['promo.tradableNotice'], l + ' must keep the promotional-credit notice');
    assert.ok(!/\{\{/.test(T[l]['promo.tradableNotice']), l + ' notice carries no placeholder');
  });
});

test('9. the removal is presentation-only', () => {
  const overview = overviewMarkup();
  assert.ok(!/fetch\(/.test(overview), 'the overview block performs no request');
  assert.ok(!/live_balance\s*=/.test(overview), 'the overview block writes no balance');
  assert.ok(!/liveModeCard/.test(overview), 'nothing references the removed card');
});
