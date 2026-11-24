'use strict';
/**
 * Activation-dependent copy must be TRUTHFUL in both platform configurations.
 *
 * PAYHIP_ACTIVATION_REQUIRED is an operator switch. When it is OFF (the code
 * default) no activation exists, yet four surfaces used to state or imply that a
 * $50 activation was required:
 *   - the deposit dialog's "this deposit does not activate your account" note,
 *   - the promotional-credit card's "purchase an activation" sentence,
 *   - the dashboard Start Here step "Complete the one-time $50 Live activation",
 *   - the onboarding modal ("run the bot before you deposit anything").
 *
 * These tests pin the state-driven behaviour, plus the server-authoritative
 * completed-trade flag that the withdrawal gate depends on.
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

function makeEl(id) {
  const el = {
    id, style: {}, textContent: '', className: '', attrs: {}, hidden: false,
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} }
  };
  return el;
}

/** Extract the promotional-credit card section and render it for one state. */
function renderCard(app, liveMode) {
  const start = INDEX.indexOf('// ============ PROMOTIONAL CREDIT + LIVE MODE STATUS');
  const end = INDEX.indexOf('// ============ PAYHIP LIVE MODE ACTIVATION');
  const ids = ['liveModeCard', 'promoCreditAmountRow', 'promoCreditAmount',
    'liveModeStatusChip', 'promoCreditExplain', 'liveModeActivateBtn'];
  const nodes = {};
  ids.forEach((id) => { nodes[id] = makeEl(id); });
  const sandbox = {
    document: { getElementById: (id) => nodes[id] || null },
    APP: Object.assign({ liveMode, environment: 'PRODUCTION' }, app || {}),
    t: app.t, Number, isFinite, String
  };
  vm.createContext(sandbox);
  vm.runInContext(INDEX.slice(start, end) + ';globalThis.renderLiveModeCard = renderLiveModeCard;', sandbox);
  sandbox.renderLiveModeCard();
  return nodes;
}

function activationUiSandbox(APP, tFn) {
  const nodes = {};
  ['liveActivationNotice', 'depositActivationNote', 'liveActivationBuyBtn',
    'liveActivationUnavailable', 'onboardingExplainer', 'onboardingPrimaryDesc']
    .forEach((id) => { nodes[id] = makeEl(id); });
  const sandbox = {
    document: { getElementById: (id) => nodes[id] || null },
    APP,
    t: tFn,
    Number, String
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction('activationPending'),
    extractFunction('updateLiveActivationUI'),
    extractFunction('renderOnboardingActivationCopy'),
    'globalThis.updateLiveActivationUI = updateLiveActivationUI;',
    'globalThis.renderOnboardingActivationCopy = renderOnboardingActivationCopy;'
  ].join('\n'), sandbox);
  return { nodes, sandbox };
}

/* ------------------------------------------- 1. the deposit activation note */

test('1. the deposit activation note is hidden by default and shown only when an activation is outstanding', () => {
  // Markup default: hidden. A JS failure must never leave a false claim on screen.
  const markup = INDEX.slice(INDEX.indexOf('id="depositActivationNote"') - 260,
    INDEX.indexOf('id="depositActivationNote"') + 200);
  assert.match(markup, /id="depositActivationNote" style="display:none;/, 'hidden in the markup');

  const off = activationUiSandbox({ activationRequired: false, liveActivated: true, activationStoreUrl: '' });
  off.sandbox.updateLiveActivationUI();
  assert.strictEqual(off.nodes.depositActivationNote.style.display, 'none',
    'activation requirement OFF: the note must stay hidden');

  const on = activationUiSandbox({ activationRequired: true, liveActivated: false, activationStoreUrl: '' });
  on.sandbox.updateLiveActivationUI();
  assert.strictEqual(on.nodes.depositActivationNote.style.display, '', 'activation outstanding: shown');

  const done = activationUiSandbox({ activationRequired: true, liveActivated: true, activationStoreUrl: '' });
  done.sandbox.updateLiveActivationUI();
  assert.strictEqual(done.nodes.depositActivationNote.style.display, 'none', 'already activated: hidden again');
});

/* --------------------------------------------- 2. the promotional-credit card */

test('2. the promo card never instructs a purchase that is not required', () => {
  const i18n = dictionary();
  const pending = renderCard({ activationRequired: true, liveActivated: false, t: i18n.t },
    { status: 'activation_required', promoCredit: 50 });
  assert.match(pending.promoCreditExplain.textContent, /Purchase a Live Mode activation/,
    'an outstanding activation is still named');

  const free = renderCard({ activationRequired: false, liveActivated: true, t: i18n.t },
    { status: 'available', promoCredit: 50 });
  assert.ok(!/activation/i.test(free.promoCreditExplain.textContent),
    'activation-free deployment: no purchase instruction');
  assert.match(free.promoCreditExplain.textContent, /\$50\b/, 'the amount is still interpolated');
  assert.ok(!free.promoCreditExplain.textContent.includes('{{amount}}'), 'no raw placeholder');

  // Also for an ACTIVATED account on a deployment where the requirement is on.
  const activated = renderCard({ activationRequired: true, liveActivated: true, t: i18n.t },
    { status: 'available', promoCredit: 50 });
  assert.ok(!/Purchase a Live Mode activation/.test(activated.promoCreditExplain.textContent),
    'an activated account is not asked to activate again');
});

/* --------------------------------------------------------- 3. the onboarding */

test('3. the onboarding copy states the real prerequisites when activation is required', () => {
  const i18n = dictionary();
  const off = activationUiSandbox({ activationRequired: false, liveActivated: true, MIN_DEPOSIT: 50 }, i18n.t);
  off.sandbox.renderOnboardingActivationCopy();
  assert.strictEqual(off.nodes.onboardingExplainer.textContent, i18n.T.en['onboarding.explainer']);
  assert.strictEqual(off.nodes.onboardingExplainer.getAttribute('data-i18n'), 'onboarding.explainer');
  assert.ok(!/activation/i.test(off.nodes.onboardingExplainer.textContent));

  const on = activationUiSandbox({ activationRequired: true, liveActivated: false, MIN_DEPOSIT: 50 }, i18n.t);
  on.sandbox.renderOnboardingActivationCopy();
  const text = on.nodes.onboardingExplainer.textContent;
  assert.match(text, /one-time activation/i, 'the activation is disclosed');
  assert.match(text, /\$50/, 'the configured minimum deposit is interpolated');
  assert.ok(!text.includes('{{min}}'), 'no raw placeholder');
  assert.ok(/already on your account/i.test(on.nodes.onboardingPrimaryDesc.textContent));
  assert.strictEqual(on.nodes.onboardingExplainer.getAttribute('data-i18n'), 'onboarding.explainerActivation');

  // A language switch re-runs the renderer (updateDynamicTranslations), so the
  // chosen key must follow the active locale.
  i18n.setLang('es');
  const es = activationUiSandbox({ activationRequired: true, liveActivated: false, MIN_DEPOSIT: 250 }, i18n.t);
  es.sandbox.renderOnboardingActivationCopy();
  assert.match(es.nodes.onboardingExplainer.textContent, /\$250/);
  assert.ok(/activaci/i.test(es.nodes.onboardingExplainer.textContent), 'Spanish copy is used');
});

test('4. the onboarding renderer is wired into the language-switch + sync paths', () => {
  const hook = INDEX.slice(INDEX.indexOf('function updateDynamicTranslations()'));
  const body = hook.slice(0, hook.indexOf('\n}') + 2);
  assert.match(body, /updateLiveActivationUI\(\)/);
  const activationUi = extractFunction('updateLiveActivationUI');
  assert.match(activationUi, /renderOnboardingActivationCopy\(\)/, 'refreshed after the server state is known');
  assert.match(extractFunction('showOnboarding'), /renderOnboardingActivationCopy\(\)/,
    'rendered when the modal opens');
});

/* ------------------------------------- 5. the server-authoritative trade flag */

test('5. /api/auth/me reports the completed-trade flag the withdrawal gate uses', () => {
  const helper = sliceFunction(SERVER, 'hasTradingActivity');
  assert.match(helper, /from\('transactions'\)/);
  assert.match(helper, /eq\('type', 'Trade Executed'\)/, 'same definition as the withdrawal route');
  assert.match(helper, /count: 'exact', head: true/, 'a count query, not a row fetch');

  const me = SERVER.slice(SERVER.indexOf("app.get('/api/auth/me'"), SERVER.indexOf('// ---------- Marketing conversion claims'));
  assert.match(me, /hasTradingActivity: !!hasTraded,/, 'the field is returned in production');
  assert.match(me, /hasSandboxTradingActivity/, 'and in the sandbox branch');
  assert.match(me, /hasTradingActivity\(user\.id\)\.catch\(\(\) => false\)/, 'a read failure degrades to false');

  // The withdrawal route must keep the SAME rule, or the two can disagree.
  assert.match(SERVER, /\.eq\('type', 'Trade Executed'\);[\s\S]{0,200}const hasTrade = count >= 1;/);
});

test('6. the frontend adopts the server flag instead of trusting the session', () => {
  assert.match(INDEX, /if \(typeof meData\.hasTradingActivity === 'boolean'\) \{\s*APP\.liveData\.hasTradingActivity = meData\.hasTradingActivity;/);
  // The gate itself is unchanged: it still reads the flag.
  assert.match(INDEX, /if\(!APP\.liveData\.hasTradingActivity && !canFundFromReferral\)/,
    'the completed-trade gate is untouched');
});

/* ------------------------------------------------------------- 7. i18n parity */

test('7. the four new keys exist once per locale, with matching placeholders', () => {
  const i18n = dictionary();
  const keys = ['promo.creditExplainTradable', 'startHere.live.subtitleNext',
    'onboarding.explainerActivation', 'onboarding.primaryDescActivation'];
  LANGS.forEach((l) => {
    keys.forEach((k) => {
      const value = i18n.T[l][k];
      assert.ok(typeof value === 'string' && value.trim(), l + ' is missing ' + k);
    });
    assert.ok(i18n.T[l]['promo.creditExplainTradable'].includes('{{amount}}'), l + ' keeps {{amount}}');
    assert.ok(i18n.T[l]['onboarding.explainerActivation'].includes('{{min}}'), l + ' keeps {{min}}');
    // Identical placeholder sets across locales.
    const placeholders = (s) => (String(s).match(/\{\{\w+\}\}/g) || []).sort().join(',');
    assert.strictEqual(placeholders(i18n.T[l]['promo.creditExplainTradable']), '{{amount}}');
    assert.strictEqual(placeholders(i18n.T[l]['onboarding.explainerActivation']), '{{min}}');
    assert.strictEqual(placeholders(i18n.T[l]['startHere.live.subtitleNext']), '');
    assert.strictEqual(placeholders(i18n.T[l]['onboarding.primaryDescActivation']), '');
  });
  // Every locale defines each key exactly once (no duplicate keys).
  keys.forEach((k) => {
    const n = (INDEX.match(new RegExp("'" + k.replace(/\./g, '\\.') + "':", 'g')) || []).length;
    assert.strictEqual(n, 6, k + ' must be defined once per locale');
  });
  // The activation-free onboarding copy must not promise trading before funding.
  LANGS.forEach((l) => {
    assert.ok(!/guaranteed|risk-free/i.test(i18n.T[l]['onboarding.primaryDescActivation']));
  });
});
