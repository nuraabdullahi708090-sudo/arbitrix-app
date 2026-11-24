'use strict';

/**
 * Final dashboard UX corrections (2026-11).
 *
 * 1. The bot-start refusal names the REAL missing step. An ordinary unfunded
 *    account is told to make a qualifying deposit (or that its deposit is being
 *    confirmed); "contact support" is reserved for a genuine account
 *    restriction. Promotional credit alone is never presented as fundable.
 * 2. The yellow promotional-credit banner no longer advertises the profit cap.
 * 3. The Referral Commission Wallet is not a dashboard wallet: its balance and
 *    conversion live in the Referral section, and the referral feature is
 *    otherwise untouched.
 * 4. The bot toggle is an arbitrage switch: "Enable Arbitrage" / "Arbitrage
 *    Enabled" in all six locales, same handler, same behaviour.
 * 5. The bot notice states the background behaviour and the obsolete
 *    "keep this tab open" warning is gone.
 *
 * The refusal handler is executed for real in a VM sandbox (real dictionary,
 * real interpolation). The server half of the contract is asserted over HTTP in
 * tests/live_mode_eligibility.test.js, which boots the real server.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readLf } = require('./helpers/text');

const ROOT = path.resolve(__dirname, '..');
const INDEX = readLf(path.join(ROOT, 'public', 'index.html'));
const SERVER = readLf(path.join(ROOT, 'server.js'));
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function dictionary() {
  const at = INDEX.indexOf('const TRANSLATIONS');
  assert.ok(at > 0, 'TRANSLATIONS must exist');
  let i = INDEX.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (; i < INDEX.length; i += 1) {
    if (INDEX[i] === '{') depth += 1;
    else if (INDEX[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(INDEX.slice(at, end + 1) + ';globalThis.T = TRANSLATIONS;', sandbox);
  return sandbox.T;
}

function extractFunction(name) {
  const start = INDEX.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'function ' + name + ' must exist');
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i += 1) {
    if (INDEX[i] === '{') depth += 1;
    else if (INDEX[i] === '}') {
      depth -= 1;
      if (depth === 0) return INDEX.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced function ' + name);
}

/** t() with the real dictionary + {{var}} interpolation. */
function makeT(T, lang) {
  return function t(key, vars) {
    const table = T[lang] || {};
    let s = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : (T.en[key] || key);
    if (vars) {
      Object.keys(vars).forEach((k) => {
        s = s.split('{{' + k + '}}').join(String(vars[k]));
      });
    }
    return s;
  };
}

function runHandler(T, lang, body) {
  const toasts = [];
  const calls = { deposit: 0, support: 0, stopped: 0 };
  const sandbox = {
    APP: { botInterval: null, botRunning: true, MIN_DEPOSIT: 50 },
    t: makeT(T, lang),
    showToast: (message, kind) => toasts.push({ message, kind }),
    openDepositModal: () => { calls.deposit += 1; },
    openSupportModal: () => { calls.support += 1; },
    updateStatus: () => {},
    stopWorkerSyncLoop: () => { calls.stopped += 1; },
    clearInterval: () => {}
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extractFunction('isLiveAccessRefusal') + '\n' + extractFunction('handleLiveAccessRefusal'),
    sandbox
  );
  const recognised = sandbox.isLiveAccessRefusal(body);
  sandbox.handleLiveAccessRefusal(body);
  return { toasts, calls, recognised, app: sandbox.APP };
}

/* ------------------------------------------------------------------ *
 * 1. The refusal names the real missing step
 * ------------------------------------------------------------------ */

test('1. an unfunded account is told to deposit - never to contact support', () => {
  const T = dictionary();
  const body = {
    code: 'LIVE_DEPOSIT_REQUIRED', depositRequired: true, depositSatisfied: false,
    depositPending: false, minDeposit: 50
  };
  const out = runHandler(T, 'en', body);
  assert.strictEqual(out.recognised, true, 'the refusal code is recognised');
  assert.strictEqual(out.toasts.length, 1, 'exactly one message');
  assert.strictEqual(out.toasts[0].message, T.en['liveDeposit.blockedToast'].replace('{{min}}', '50'));
  assert.match(out.toasts[0].message, /at least \$50/, 'the minimum is named');
  assert.ok(!/support/i.test(out.toasts[0].message), 'no support escalation for an ordinary case');
  assert.notStrictEqual(out.toasts[0].message, T.en['liveAccess.notAvailable'], 'not the generic message');
  assert.strictEqual(out.calls.deposit, 1, 'the deposit dialog opens');
  assert.strictEqual(out.calls.support, 0, 'support is not offered');
  assert.strictEqual(out.app.botRunning, false, 'the bot status is reset');
});

test('2. the same message is localized in all six locales', () => {
  const T = dictionary();
  const body = { code: 'LIVE_DEPOSIT_REQUIRED', depositSatisfied: false, depositPending: false, minDeposit: 50 };
  LANGS.forEach((l) => {
    const out = runHandler(T, l, body);
    assert.strictEqual(out.toasts.length, 1, l + ' one message');
    assert.strictEqual(out.toasts[0].message, T[l]['liveDeposit.blockedToast'].replace('{{min}}', '50'),
      l + ' renders its own deposit sentence');
    assert.strictEqual(out.calls.deposit, 1, l + ' opens the deposit dialog');
    assert.strictEqual(out.calls.support, 0, l + ' never routes to support');
  });
});

test('3. a deposit already in flight is reported as pending, with no dialog and no support', () => {
  const T = dictionary();
  const out = runHandler(T, 'en', { code: 'LIVE_DEPOSIT_REQUIRED', depositSatisfied: false, depositPending: true, minDeposit: 50 });
  assert.strictEqual(out.toasts.length, 1);
  assert.strictEqual(out.toasts[0].message, T.en['liveDeposit.pendingToast']);
  assert.match(out.toasts[0].message, /being confirmed/i);
  assert.strictEqual(out.calls.deposit, 0, 'no second deposit is suggested');
  assert.strictEqual(out.calls.support, 0, 'no support escalation');
  LANGS.forEach((l) => {
    const o = runHandler(T, l, { code: 'LIVE_DEPOSIT_REQUIRED', depositSatisfied: false, depositPending: true });
    assert.strictEqual(o.toasts[0].message, T[l]['liveDeposit.pendingToast'], l + ' localized pending copy');
  });
});

test('4. a genuine restriction still routes to support, and offers no purchase', () => {
  const T = dictionary();
  const out = runHandler(T, 'en', { code: 'LIVE_ACTIVATION_REQUIRED', depositSatisfied: true, minDeposit: 50 });
  assert.strictEqual(out.toasts.length, 1);
  assert.strictEqual(out.toasts[0].message, T.en['liveAccess.notAvailable']);
  assert.strictEqual(out.calls.support, 1, 'a human route is offered');
  assert.strictEqual(out.calls.deposit, 0, 'the deposit dialog is not the answer here');
  assert.ok(!/buy|purchase/i.test(out.toasts[0].message), 'never a purchase prompt');
});

test('5. promotional credit alone is not fundable capital (deposit path, not support)', () => {
  const T = dictionary();
  // The server refuses a zero-balance live start with LIVE_FUNDING_REQUIRED and
  // reports the deposit facts; with no qualifying deposit the customer is sent
  // to the deposit flow.
  const out = runHandler(T, 'en', { code: 'LIVE_FUNDING_REQUIRED', depositSatisfied: false, depositPending: false, minDeposit: 50 });
  assert.strictEqual(out.toasts[0].message, T.en['liveDeposit.blockedToast'].replace('{{min}}', '50'));
  assert.strictEqual(out.calls.support, 0);
  // A funded-but-refused account (restriction) keeps the support route.
  const funded = runHandler(T, 'en', { code: 'LIVE_FUNDING_REQUIRED', depositSatisfied: true, minDeposit: 50 });
  assert.strictEqual(funded.toasts[0].message, T.en['liveAccess.fundingRequired']);
  assert.strictEqual(funded.calls.deposit, 1);
  // The server side really treats the $50 promotional credit as tradable capital
  // but never as a qualifying deposit.
  assert.match(SERVER, /liveBalance <= 0/, 'the funding gate is a presence check');
  assert.match(SERVER, /code: 'LIVE_FUNDING_REQUIRED'/);
  assert.match(SERVER, /code: 'LIVE_DEPOSIT_REQUIRED'/);
});

test('6. a retryable status check says so instead of blaming the account', () => {
  const T = dictionary();
  const out = runHandler(T, 'en', { code: 'LIVE_DEPOSIT_CHECK_UNAVAILABLE', retryable: true });
  assert.strictEqual(out.toasts[0].message, T.en['liveAccess.retryLater']);
  assert.strictEqual(out.calls.support, 0);
  assert.strictEqual(out.calls.deposit, 0);
});

/* ------------------------------------------------------------------ *
 * 2. The banner carries no profit-cap wording
 * ------------------------------------------------------------------ */

test('7. the yellow banner states the two restrictions and no profit-cap figure', () => {
  const T = dictionary();
  assert.strictEqual(
    T.en['promo.tradableNotice'],
    'Your promotional credit is tradable. Make a qualifying deposit and complete your first trade to withdraw.'
  );
  LANGS.forEach((l) => {
    const value = T[l]['promo.tradableNotice'];
    assert.ok(value && value.trim(), l + ' banner copy exists');
    assert.ok(!/\$?\s?30\b/.test(value), l + ' banner must not quote the cap');
    const card = T[l]['promo.creditExplainTradable'];
    assert.ok(card.includes('{{amount}}'), l + ' the card keeps the amount placeholder');
    assert.ok(!/\$?\s?30\b/.test(card), l + ' the card must not quote the cap');
  });
  // Removing the COPY must not remove the RULE.
  assert.match(SERVER, /PROMO_PROFIT_CAP_USD/, 'the enforced cap still exists');
  assert.match(SERVER, /isPromoProfitCapReached\(/, 'the cap is still evaluated');
});

/* ------------------------------------------------------------------ *
 * 3. The Referral Commission Wallet is not a dashboard wallet
 * ------------------------------------------------------------------ */

test('8. the Referral Commission Wallet is not a dashboard tab, and referrals still work', () => {
  assert.ok(!/data-wallet="bonus"/.test(INDEX), 'no bonus wallet tab');
  assert.ok(!INDEX.includes('id="bonusWalletSection"'), 'no dashboard panel');

  // Visible in the Referral section, with the same ids and handler.
  const blockAt = INDEX.indexOf('id="referralCommissionWalletBlock"');
  assert.ok(blockAt > 0, 'the block exists');
  const referralAt = INDEX.indexOf('id="referral"');
  assert.ok(referralAt > 0 && blockAt > referralAt, 'it lives inside the Referral section');
  assert.ok(INDEX.includes('id="bonusBalanceDisplay"'), 'the balance id is preserved');
  assert.match(INDEX, /id="bonusWithdrawBtn"[^>]*onclick="withdrawBonusToLive\(\)"/, 'the conversion handler is preserved');
  assert.ok(!INDEX.includes("currentWallet === 'bonus'"), 'the dashboard can no longer select the bonus wallet');

  // The referral feature itself is untouched: nav entry, API, conversion route.
  assert.match(INDEX, /data-section="referral"/);
  assert.match(SERVER, /app\.get\('\/api\/referral\/stats'/);
  assert.match(SERVER, /bonus_balance/, 'the earnings bucket still exists');
});

/* ------------------------------------------------------------------ *
 * 4. Enable Arbitrage
 * ------------------------------------------------------------------ */

test('9. the bot toggle is an arbitrage switch, localized in all six locales', () => {
  const T = dictionary();
  assert.strictEqual(T.en['bot.enableArbitrage'], 'Enable Arbitrage');
  assert.strictEqual(T.en['bot.arbitrageEnabled'], 'Arbitrage Enabled');
  LANGS.forEach((l) => {
    assert.ok(T[l]['bot.enableArbitrage'] && T[l]['bot.enableArbitrage'].trim(), l + ' enable label');
    assert.ok(T[l]['bot.arbitrageEnabled'] && T[l]['bot.arbitrageEnabled'].trim(), l + ' enabled label');
    assert.notStrictEqual(T[l]['bot.enableArbitrage'], T[l]['bot.arbitrageEnabled'], l + ' the two states differ');
  });
  assert.ok(!INDEX.includes('bot.enableScanner'), 'the old scanner key is gone');
  assert.ok(!/Enable Scanner/.test(INDEX), 'the old scanner label is gone');
  assert.ok(T.en['hint.arbitrage'] && !T.en['hint.scanner'], 'the hint key was renamed');
  assert.match(INDEX, /id="botToggleLiveLabel"[^>]*data-i18n="bot.enableArbitrage"/, 'the label is wired');
});

test('10. the toggle still calls the same handler and its label follows the real state', () => {
  // Behaviour unchanged: the same element, event and function.
  assert.match(INDEX, /botToggleLive = getEl\('botToggleLive'\);/);
  assert.match(INDEX, /botToggleLive\.addEventListener\('change', toggleBot\)/);
  const el = { textContent: '' };
  const sandbox = {
    APP: { botRunning: false },
    t: (k) => '[' + k + ']',
    document: { getElementById: () => el }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('updateBotToggleLabel'), sandbox);
  sandbox.updateBotToggleLabel();
  assert.strictEqual(el.textContent, '[bot.enableArbitrage]', 'idle state says Enable');
  sandbox.APP.botRunning = true;
  sandbox.updateBotToggleLabel();
  assert.strictEqual(el.textContent, '[bot.arbitrageEnabled]', 'running state says Enabled');
});

/* ------------------------------------------------------------------ *
 * 5. The bot notice
 * ------------------------------------------------------------------ */

test('11. the notice states the background behaviour and the tab warning is gone', () => {
  const T = dictionary();
  assert.strictEqual(
    T.en['bot.engineNoticeWorker'],
    'Your bot runs automatically in the background, even when you close this page or switch to another app. Return anytime to monitor your trading activity.'
  );
  assert.ok(!INDEX.includes('Keep this tab open'), 'the obsolete warning is gone from the document');
  LANGS.forEach((l) => {
    assert.ok(T[l]['bot.engineNoticeWorker'] && T[l]['bot.engineNoticeWorker'].trim(), l + ' notice copy');
    assert.ok(!/Keep this tab open/i.test(T[l]['bot.engineNotice']), l + ' no tab warning in any locale');
  });

  const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, textContent: '' };
  const sandbox = {
    APP: { botExecutedBy: 'unknown' },
    t: (k) => k,
    document: { getElementById: () => el }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('updateBotEngineNotice'), sandbox);
  sandbox.updateBotEngineNotice('worker');
  assert.strictEqual(el.textContent, 'bot.engineNoticeWorker', 'server-owned session gets the background copy');
  sandbox.updateBotEngineNotice('browser');
  assert.strictEqual(el.textContent, 'bot.engineNotice', 'a tab-executed session gets the neutral copy');
  sandbox.updateBotEngineNotice('unknown');
  assert.strictEqual(el.textContent, 'bot.engineNoticeUnknown', 'unknown status says so');
});

/* ------------------------------------------------------------------ *
 * i18n parity
 * ------------------------------------------------------------------ */

test('12. i18n parity: identical key sets, no empties, count pinned', () => {
  const T = dictionary();
  const base = Object.keys(T.en).sort();
  assert.strictEqual(base.length, 1594, 'dictionary size pinned');
  const enKeys = base.join('|');
  LANGS.forEach((l) => {
    assert.strictEqual(Object.keys(T[l]).sort().join('|'), enKeys, l + ' identical key set');
    Object.entries(T[l]).forEach(([k, v]) => {
      assert.ok(typeof v === 'string' && v.trim(), l + ':' + k + ' must not be empty');
    });
    assert.ok(T[l]['liveDeposit.pendingToast'], l + ' pending copy');
    assert.ok(T[l]['liveAccess.fundingRequired'], l + ' funding copy');
    assert.ok(T[l]['bot.arbitrageEnabled'], l + ' enabled label');
  });
});
