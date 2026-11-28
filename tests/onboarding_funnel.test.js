'use strict';
/**
 * Post-registration onboarding - single-mode contract.
 *
 * Demo Mode was retired, so the funnel no longer asks the customer to pick a
 * mode. It presents the two real funding paths (start on the $50 promotional
 * credit, or deposit) and is shown at most once per account.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function loadTranslations() {
  const tIdx = INDEX.indexOf('const TRANSLATIONS');
  let i = INDEX.indexOf('{', tIdx);
  let depth = 0;
  let end = -1;
  for (; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
  return sandbox.__T;
}

function extractFunction(name) {
  const at = INDEX.indexOf('function ' + name);
  assert.ok(at > 0, name + ' must exist');
  let depth = 0;
  let started = false;
  for (let i = at; i < INDEX.length; i++) {
    if (INDEX[i] === '{') { depth++; started = true; }
    else if (INDEX[i] === '}') {
      depth--;
      if (started && depth === 0) return INDEX.slice(at, i + 1);
    }
  }
  throw new Error('unterminated ' + name);
}

const T = loadTranslations();

function makeEl(id) {
  const el = {
    id,
    style: {},
    textContent: '',
    innerHTML: '',
    classes: new Set(),
    classList: {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
      contains: (c) => el.classes.has(c),
      toggle: (c, on) => { if (on) el.classes.add(c); else el.classes.delete(c); },
    },
    setAttribute() {},
    addEventListener() {},
  };
  return el;
}

function buildSandbox({ environment = 'PRODUCTION', user = { id: 7 }, stored = null, appWasReady = false } = {}) {
  const els = { onboardingModal: makeEl('onboardingModal') };
  const store = {};
  if (stored) store['arbi_onboarding_' + user.id] = stored;
  const calls = { goToApp: [], deposit: 0, fetches: [] };
  const sandbox = {
    els,
    calls,
    APP: { environment, user, liveData: {}, minDeposit: 100 },
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: { getElementById: (id) => els[id] || (els[id] = makeEl(id)), querySelectorAll: () => [] },
    currentCachedUser: () => user,
    goToApp: (src) => calls.goToApp.push(src),
    openDepositModal: () => { calls.deposit += 1; },
    fetch: (...args) => { calls.fetches.push(args); return Promise.resolve({ ok: true, json: async () => ({}) }); },
    appReady: appWasReady,
    pendingOnboardingDeposit: false,
    t: (k) => T.en[k] || k,
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction('onboardingKey'),
    extractFunction('getOnboardingChoice'),
    extractFunction('setOnboardingChoice'),
    extractFunction('onboardingNeeded'),
    extractFunction('chooseOnboarding'),
  ].join('\n'), sandbox);
  return sandbox;
}

// ---------------------------------------------------------------------------
// 1. Markup: two funding paths, no mode choice
// ---------------------------------------------------------------------------
test('1. the modal offers a credit path and a deposit path, with no mode picker', () => {
  const at = INDEX.indexOf('id="onboardingModal"');
  assert.ok(at > 0, 'the onboarding modal must exist');
  const modal = INDEX.slice(at, INDEX.indexOf('id="withdrawModal"', at));
  assert.ok(/id="onboardingPrimaryBtn"[^>]*onclick="chooseOnboarding\('credit'\)"/.test(modal),
    'the primary action starts on the credit');
  assert.ok(/id="onboardingSecondaryBtn"[^>]*onclick="chooseOnboarding\('deposit'\)"/.test(modal),
    'the secondary action opens the deposit flow');
  assert.ok(!/chooseOnboarding\('(demo|live)'\)/.test(modal), 'no mode choice remains');
  for (const k of ['onboarding.title', 'onboarding.subtitle', 'onboarding.explainer',
    'onboarding.primary', 'onboarding.primaryDesc', 'onboarding.secondary',
    'onboarding.secondaryDesc', 'onboarding.realNote', 'onboarding.promoNote']) {
    assert.ok(modal.includes('data-i18n="' + k + '"'), k + ' must be rendered');
  }
  assert.ok(modal.includes('data-i18n="onboarding.realNote"') && modal.includes('data-i18n="onboarding.promoNote"'),
    'deposited funds and the credit are described separately');
});

// ---------------------------------------------------------------------------
// 2. Shown once per account, never for the sandbox
// ---------------------------------------------------------------------------
test('2. onboarding is shown at most once per account and never for the sandbox', () => {
  const first = buildSandbox({});
  assert.strictEqual(first.onboardingNeeded({ id: 7 }), true, 'a new account needs it');

  const seen = buildSandbox({ stored: 'credit' });
  assert.strictEqual(seen.onboardingNeeded({ id: 7 }), false, 'a recorded choice suppresses it');

  const sandbox = buildSandbox({ environment: 'MARKETING_SANDBOX' });
  assert.strictEqual(sandbox.onboardingNeeded({ id: 7 }), false, 'the sandbox never sees it');

  assert.strictEqual(buildSandbox({}).onboardingNeeded(null), false, 'no user, no prompt');
  const scoped = extractFunction('onboardingKey');
  assert.match(scoped, /arbi_onboarding_/, 'the flag is per account');
});

// ---------------------------------------------------------------------------
// 3. The credit path enters the app without creating anything
// ---------------------------------------------------------------------------
test('3. the credit path enters the app and creates no invoice', () => {
  const sb = buildSandbox({});
  sb.chooseOnboarding('credit');
  assert.strictEqual(JSON.stringify(sb.calls.goToApp), JSON.stringify(['onboarding_credit']));
  assert.strictEqual(sb.calls.deposit, 0, 'the deposit dialog is not forced open');
  assert.strictEqual(sb.calls.fetches.length, 0, 'no request is made');
  assert.strictEqual(sb.els.onboardingModal.classList.contains('open'), false, 'the modal closes');
  assert.strictEqual(sb.getOnboardingChoice(7), 'credit', 'the choice is recorded');
});

test('3b. the credit path needs no mode switch - the credit IS the entry state', () => {
  // This build has one funded view: the Live wallet carrying the promotional
  // credit (the wallet tabs are Live + Referral Commission; there is no demo
  // wallet and no setMode()). The funnel entry therefore must not reach for a
  // mode switch that does not exist.
  assert.ok(!/\bsetMode\s*\(/.test(INDEX), 'no mode-switch call exists in this build');
  assert.ok(!/<button[^>]*data-wallet="demo"/.test(INDEX), 'no demo wallet tab');
  assert.ok(/<button[^>]*data-wallet="live"/.test(INDEX), 'the Live wallet tab is the entry view');
  // The standalone promotional-credit card was removed; the yellow notice plus
  // the wallet card now carry that story on the same single view.
  assert.ok(/id="promoCreditBanner"/.test(INDEX), 'the promotional-credit notice is present');
  assert.ok(/id="liveWalletSection"/.test(INDEX), 'the Live wallet is the entry surface');
  assert.ok(INDEX.indexOf('id="liveModeCard"') === -1, 'the removed card is gone');
  const ready = buildSandbox({ appWasReady: true });
  ready.chooseOnboarding('credit');
  assert.deepStrictEqual(ready.calls.goToApp, ['onboarding_credit']);
  assert.strictEqual(ready.calls.fetches.length, 0, 'still no request');
});

// ---------------------------------------------------------------------------
// 4. The deposit path hands off to the EXISTING dialog
// ---------------------------------------------------------------------------
test('4. the deposit path reuses the existing deposit dialog', () => {
  const ready = buildSandbox({ appWasReady: true });
  ready.chooseOnboarding('deposit');
  assert.strictEqual(ready.calls.deposit, 1, 'the existing dialog opens immediately');
  assert.strictEqual(ready.calls.fetches.length, 0, 'opening it creates no invoice');
  assert.strictEqual(ready.getOnboardingChoice(7), 'deposit');

  const cold = buildSandbox({ appWasReady: false });
  cold.chooseOnboarding('deposit');
  assert.strictEqual(cold.pendingOnboardingDeposit, true, 'a cold start defers to initApp');
  assert.strictEqual(cold.calls.deposit, 0);
});

// ---------------------------------------------------------------------------
// 5. It is a funnel prompt, never a gate
// ---------------------------------------------------------------------------
test('5. the funnel is never a gate: the app is reachable without choosing', () => {
  const body = extractFunction('chooseOnboarding');
  assert.ok(!/return\s+false|throw/.test(body), 'no path blocks the app');
  assert.ok(/goToApp\(/.test(body), 'both paths enter the app');
  // No server-side dependency was introduced for the prompt.
  assert.ok(!/\/api\/onboarding/.test(SERVER), 'no onboarding endpoint was added');
});

// ---------------------------------------------------------------------------
// 6. Copy never claims a demo balance or a guaranteed return
// ---------------------------------------------------------------------------
test('6. the copy describes the credit honestly and claims nothing else', () => {
  assert.match(T.en['onboarding.primary'], /\$50/);
  assert.match(T.en['onboarding.primaryDesc'], /\$30/, 'the profit cap is disclosed');
  assert.match(T.en['onboarding.secondary'], /deposit/i);
  assert.match(T.en['onboarding.promoNote'], /separate/i);
  const banned = /guarantee|risk-free|guaranteed (profit|return)|free money/i;
  for (const lang of LANGS) {
    for (const k of Object.keys(T[lang]).filter((x) => x.startsWith('onboarding.'))) {
      assert.ok(!banned.test(String(T[lang][k])), lang + '.' + k + ' makes a guarantee claim');
    }
  }
});

// ---------------------------------------------------------------------------
// 7. i18n parity across the six locales
// ---------------------------------------------------------------------------
test('7. every onboarding key exists in all six locales', () => {
  const keys = Object.keys(T.en).filter((k) => k.startsWith('onboarding.'));
  assert.ok(keys.length >= 10, 'the onboarding copy set exists');
  for (const lang of LANGS) {
    assert.deepStrictEqual(Object.keys(T[lang]).sort(), Object.keys(T.en).sort(), lang + ' key set differs');
    for (const k of keys) {
      assert.ok(String(T[lang][k] || '').trim().length > 0, lang + '.' + k + ' is empty');
    }
  }
});

// ---------------------------------------------------------------------------
// 8. No demo-mode leftovers in the funnel
// ---------------------------------------------------------------------------
test('8. no demo-mode wording or handler survives in the funnel', () => {
  const at = INDEX.indexOf('id="onboardingModal"');
  const modal = INDEX.slice(at, INDEX.indexOf('id="withdrawModal"', at));
  assert.ok(!/demo/i.test(modal.replace(/data-i18n="[^"]*"/g, '')), 'no demo markup');
  assert.ok(!/chooseOnboarding\('demo'\)/.test(INDEX));
  assert.ok(!INDEX.includes("onboarding.primaryDemo"));
  assert.ok(!INDEX.includes("onboarding.secondaryLive"));
});
