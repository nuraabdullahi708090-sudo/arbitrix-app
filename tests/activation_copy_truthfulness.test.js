'use strict';
/**
 * The customer journey contains NO paid activation step.
 *
 * Management decision: Live Mode is funded by a deposit, not by buying an
 * activation. The previous design gated the copy on PAYHIP_ACTIVATION_REQUIRED,
 * which still left a purchase dialog, an "Activate Live Mode" button and an
 * "Activation required" chip in the product whenever the switch was on.
 *
 * These tests pin the removal itself:
 *   - no activation purchase markup, handler or dialog exists anywhere;
 *   - no locale carries activation wording in the customer journey;
 *   - the promotional-credit card, the Start Here checklist and the refusal path
 *     point at a deposit / support, never at a purchase;
 *   - the Payhip BACKEND (routes, flag, entitlement store, webhook) is intact,
 *     so the capability can be re-activated later without new server work.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readLf } = require('./helpers/text');

const ROOT = path.join(__dirname, '..');
const INDEX = readLf(path.join(ROOT, 'public', 'index.html'));
const SERVER = readLf(path.join(ROOT, 'server.js'));
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

/* ------------------------------------------------------------------ helpers */

function dictionary() {
  const start = INDEX.indexOf('const TRANSLATIONS');
  let depth = 0;
  let end = -1;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth += 1;
    else if (INDEX[i] === '}') { depth -= 1; if (!depth) { end = i; break; } }
  }
  const tStart = INDEX.indexOf('function t(key, vars)');
  const tEnd = INDEX.indexOf('\n}', tStart) + 2;
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${INDEX.slice(start, end + 1)}
    let currentLang = 'en';
    ${INDEX.slice(tStart, tEnd)}
    globalThis.T = TRANSLATIONS;
    globalThis.t = t;
    globalThis.setLang = function (l) { currentLang = l; };`, sandbox);
  return sandbox;
}

function sliceFunction(source, name) {
  const at = source.indexOf('function ' + name + '(');
  if (at < 0) throw new Error(name + ' must exist');
  let depth = 0;
  let started = false;
  for (let i = at; i < source.length; i++) {
    if (source[i] === '{') { depth += 1; started = true; }
    else if (source[i] === '}') {
      depth -= 1;
      if (started && depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error('unterminated ' + name);
}

function extractFunction(name) {
  return sliceFunction(INDEX, name);
}

/* ------------------------------------------------ 1. no purchase UI exists */

test('1. the activation purchase dialog, button and note are gone from the markup', () => {
  [
    'id="liveActivationModal"',
    'id="liveActivationBuyBtn"',
    'id="liveActivationKey"',
    'id="liveActivationSubmitBtn"',
    'id="liveActivationNotice"',
    'id="liveActivationUnavailable"',
    'id="liveModeActivateBtn"',
    'id="depositActivationNote"'
  ].forEach((needle) => {
    assert.ok(!INDEX.includes(needle), needle + ' must not exist');
  });
  ['openLiveActivationModal', 'closeLiveActivationModal', 'submitLiveActivation',
    'updateLiveActivationUI', 'activationPending'].forEach((fn) => {
    assert.ok(!INDEX.includes(fn), fn + ' must not exist');
  });
  assert.ok(!/\/api\/live\/activate/.test(INDEX), 'the redemption UI no longer calls the API');
});

test('2. no locale carries activation wording in the customer journey', () => {
  const i18n = dictionary();
  // Keys owned by unrelated features legitimately use "activate" (2FA, the Pro
  // subscription, admin audit labels, account-status copy).
  const UNRELATED = /^(subscription\.|2fa\.|admin\.|audit\.|kyc\.|bot\.engineNotice|profile\.|live\.withdrawStatus\.notDeposited|bot\.(enableArbitrage|arbitrageEnabled))/;
  const OFFENDERS = /activation|activat(e|ed|ing)\b|\bactivaci|\bativa\u00e7|\baktivier|تفعيل|激活/i;
  LANGS.forEach((l) => {
    Object.entries(i18n.T[l]).forEach(([key, value]) => {
      if (UNRELATED.test(key)) return;
      assert.ok(!OFFENDERS.test(value), l + ':' + key + ' still mentions activation: ' + value);
    });
  });
});

test('3. the dead activation keys were removed from every locale', () => {
  const i18n = dictionary();
  const dead = ['liveActivation.title', 'liveActivation.body', 'liveActivation.buy',
    'liveActivation.keyLabel', 'liveActivation.submit', 'liveActivation.hint',
    'liveActivation.supportCta', 'liveActivation.purchaseUnavailable', 'liveActivation.cta',
    'liveActivation.notice', 'liveActivation.success', 'liveActivation.failed',
    'liveActivation.keyRequired', 'liveActivation.confirming', 'liveActivation.nextStep',
    'liveActivation.retryLater', 'liveActivation.blockedToast', 'liveActivation.depositCta',
    'liveMode.status.activationRequired', 'startHere.live.step0', 'deposit.activationNote',
    'onboarding.explainerActivation', 'onboarding.primaryDescActivation', 'promo.creditExplain'];
  LANGS.forEach((l) => {
    dead.forEach((k) => assert.ok(!(k in i18n.T[l]), l + ' still defines ' + k));
  });
  // The deposit CTA survived under a neutral, feature-accurate key.
  LANGS.forEach((l) => {
    assert.ok(i18n.T[l]['liveMode.depositCta'], l + ' must define liveMode.depositCta');
  });
});

/* --------------------------------------- 2. the promotional-credit disclosure */

test('4. the promotional-credit disclosure asks for a deposit and never for a purchase', () => {
  // The standalone promotional-credit CARD was removed (management decision), so
  // the ONE customer-facing disclosure is the yellow notice. It must still name
  // the real next step (a qualifying deposit) and must never ask for a purchase.
  const i18n = dictionary();
  LANGS.forEach((l) => {
    i18n.setLang(l);
    const text = i18n.T[l]['promo.tradableNotice'];
    assert.ok(text, l + ' must define promo.tradableNotice');
    assert.ok(!/activation|purchase|licence|license|buy/i.test(text),
      l + ' must not mention a purchase: ' + text);
    assert.ok(!/\{\{/.test(text), l + ' must not carry a placeholder');
  });
  // The card that used to render the deposit CTA is gone; the deposit action
  // itself is still on the dashboard (account card).
  assert.strictEqual(INDEX.indexOf('renderLiveModeCard'), -1, 'the card renderer is removed');
  assert.match(INDEX, /id="availableDepositBtn"[^>]*onclick="openDepositModal\(\)"/,
    'the deposit action remains reachable');
});

test('5. no customer-facing string asks the customer to buy anything', () => {
  const i18n = dictionary();
  // Only the journey-bearing keys: the notice, the deposit dialog and the Live
  // Mode guidance. (Payhip keys may still exist server-side; they are not shown.)
  const keys = ['promo.tradableNotice', 'liveMode.fundingNote', 'liveMode.depositNote',
    'deposit.choose.crypto.title', 'deposit.choose.crypto.desc'];
  LANGS.forEach((l) => {
    keys.forEach((key) => {
      const text = i18n.T[l][key];
      if (!text) return;
      assert.ok(!/activation|purchase|licence|license/i.test(text),
        l + '/' + key + ' must not ask for a purchase: ' + text);
    });
  });
});

/* ------------------------------------------------------------ 3. Start Here */

test('6. the Start Here LIVE checklist has no activation step', () => {
  const steps = extractFunction('startHereLiveSteps');
  assert.ok(!/activation/i.test(steps), 'no activation branch');
  assert.ok(!/step0/.test(steps), 'step0 is gone');
  assert.match(steps, /startHere\.live\.step3/);

  const sandbox = { APP: { MIN_DEPOSIT: 50, liveData: { hasRealDeposit: false } } };
  vm.createContext(sandbox);
  vm.runInContext(steps + ';globalThis.f = startHereLiveSteps;', sandbox);
  const list = sandbox.f();
  // The checklist reflects the step actually blocking the account: the deposit
  // comes before the first trade, and the activation step never appears.
  assert.deepStrictEqual(Array.from(list.map((x) => x.key)), ['startHere.live.stepDeposit', 'startHere.live.step3']);
  assert.ok(list.every((x) => !/activation/i.test(x.key)));

  const funded = { APP: { MIN_DEPOSIT: 50, liveData: { hasRealDeposit: true } } };
  vm.createContext(funded);
  vm.runInContext(steps + ';globalThis.g = startHereLiveSteps;', funded);
  assert.deepStrictEqual(Array.from(funded.g().map((x) => x.key)), ['startHere.live.step3']);

  // Completion no longer depends on an activation flag.
  const complete = extractFunction('startHereLiveComplete');
  assert.ok(!/activation/i.test(complete));
  assert.match(complete, /hasTradingActivity/);
});

/* ------------------------------------------------------- 4. refusal path */

test('7. a legacy activation refusal offers support, never a purchase', () => {
  const fn = extractFunction('handleLiveAccessRefusal');
  assert.ok(!/openLiveActivationModal/.test(fn), 'no purchase dialog');
  assert.match(fn, /liveAccess\.notAvailable/, 'neutral localized message');
  assert.match(fn, /kxOpenSupport\('account'\)/, 'a route to a human (the in-app chat)');
  assert.match(fn, /LIVE_DEPOSIT_REQUIRED[\s\S]*openDepositModal\(\)/, 'the deposit step still opens the dialog');

  const i18n = dictionary();
  LANGS.forEach((l) => {
    assert.ok(i18n.T[l]['liveAccess.notAvailable'], l + ' must define the neutral message');
    assert.ok(i18n.T[l]['liveAccess.retryLater'], l + ' must define the retry message');
  });
});

/* --------------------------------------------- 5. the backend is preserved */

test('8. the Payhip backend, its routes and its flag are untouched', () => {
  assert.match(SERVER, /PAYHIP_ACTIVATION_REQUIRED/,
    'the operator switch still exists for a later re-activation');
  assert.match(SERVER, /const PAYHIP_CONFIG = resolvePayhipConfig\(\)/);
  assert.match(SERVER, /createPayhipEntitlements\(/);
  assert.match(SERVER, /app\.get\('\/api\/live\/activation'/);
  assert.match(SERVER, /app\.post\('\/api\/live\/activate'/);
  assert.match(SERVER, /app\.post\('\/api\/payhip\/webhook'/);

  const entitlement = readLf(path.join(ROOT, 'services', 'PayhipEntitlements.js'));
  assert.ok(entitlement.length > 500, 'the entitlement store still ships');
  const migration = path.join(ROOT, 'supabase', 'migrations', '050_payhip_live_activation.sql');
  assert.ok(fs.existsSync(migration), 'the schema migration is still in the repo');
});

test('9. the server gate is inert by default (flag off, deposit is the only requirement)', () => {
  const eligibility = sliceFunction(SERVER, 'getLiveModeEligibility');
  assert.match(eligibility, /activation\.activationRequired !== true/);
  assert.match(eligibility, /reason: 'not-required'/, 'no activation -> eligible');
  assert.match(eligibility, /getConfirmedDepositTotal\(userId\)/, 'the deposit rule remains');
  // The deposit gate still names its own code so the UI can open the dialog.
  assert.match(SERVER, /LIVE_DEPOSIT_REQUIRED/);
});

/* ------------------------------------------------------------- 10. i18n parity */

test('10. i18n stays complete: identical key sets, no empties', () => {
  const i18n = dictionary();
  const base = Object.keys(i18n.T.en).sort();
  LANGS.forEach((l) => {
    assert.deepStrictEqual(Object.keys(i18n.T[l]).sort(), base, l + ' key set differs');
    const empty = Object.entries(i18n.T[l]).filter(([, v]) => typeof v !== 'string' || !v.trim());
    assert.deepStrictEqual(empty, [], l + ' has empty values');
  });
  // Every key is defined exactly once per locale (no duplicate literals).
  ['liveMode.depositCta', 'liveAccess.notAvailable', 'liveAccess.retryLater'].forEach((k) => {
    const n = (INDEX.match(new RegExp("'" + k.replace(/\./g, '\\.') + "':", 'g')) || []).length;
    assert.strictEqual(n, 6, k + ' must be defined once per locale');
  });
});
