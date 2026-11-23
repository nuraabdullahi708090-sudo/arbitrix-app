'use strict';
/**
 * "Start Here" card - single-mode contract.
 *
 * Demo Mode was retired, so the card no longer switches between a demo
 * checklist and a live checklist: it always describes the Live path and only
 * ever renders requirements the product actually enforces.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
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
    children: [],
    classes: new Set(),
    classList: {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
      contains: (c) => el.classes.has(c),
      toggle: (c, on) => { if (on) el.classes.add(c); else el.classes.delete(c); },
    },
    appendChild: (child) => { el.children.push(child); return child; },
    setAttribute() {},
    addEventListener() {},
  };
  return el;
}

function buildSandbox({ environment = 'PRODUCTION', liveData = {}, dismissed = false, activationRequired = false, liveActivated = true } = {}) {
  const els = {};
  const el = (id) => els[id] || (els[id] = makeEl(id));
  ['startHereCard', 'startHereSubtitle', 'startHereStepsLive', 'startHereStepsLiveReady'].forEach(el);
  const store = {};
  if (dismissed) store['arbi_starthere_42'] = '1';
  const sandbox = {
    els,
    APP: { environment, liveData, activationRequired, liveActivated, user: { id: 42 } },
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: {
      getElementById: el,
      createElement: () => makeEl('created'),
      querySelectorAll: () => [],
    },
    t: (k, vars) => {
      let v = T.en[k] || k;
      if (vars) Object.keys(vars).forEach((n) => { v = v.replace('{{' + n + '}}', vars[n]); });
      return v;
    },
    formatCurrency: (n) => '$' + Number(n || 0).toFixed(2),
    currentCachedUser: () => ({ id: 42 }),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction('startHereKey'),
    extractFunction('activationPending'),
    extractFunction('startHereLiveSteps'),
    extractFunction('startHereLiveComplete'),
    extractFunction('renderStartHereLiveSteps'),
    extractFunction('updateStartHere'),
  ].join('\n'), sandbox);
  return sandbox;
}

// ---------------------------------------------------------------------------
// 1. Markup: one card, one header, no demo variant
// ---------------------------------------------------------------------------
test('1. the card ships a single Live header and one steps container', () => {
  const at = INDEX.indexOf('id="startHereCard"');
  assert.ok(at > 0, 'the checklist card must exist');
  const card = INDEX.slice(at, INDEX.indexOf('id="withdrawModal"', at));
  assert.ok(/id="startHereHeadLive"/.test(card), 'the Live header exists');
  assert.ok(/data-i18n="startHere\.live\.title"/.test(card), 'the title is translated');
  assert.ok(/id="startHereStepsLive"/.test(card), 'the steps container exists');
  assert.ok(/id="startHereStepsLiveReady"/.test(card), 'the completion line exists');
  assert.ok(/onclick="dismissStartHere\(\)"/.test(card), 'it is dismissible');
  assert.ok(!/startHereHeadDemo|startHereStepsDemo/.test(card), 'no demo header or container survives');
});

// ---------------------------------------------------------------------------
// 2. The checklist lists only the requirements the platform actually enforces
// ---------------------------------------------------------------------------
test('2. the activation step appears ONLY while the platform requires one', () => {
  const withActivation = vm.runInNewContext(
    extractFunction('activationPending') + extractFunction('startHereLiveSteps') + ';startHereLiveSteps()',
    { APP: { activationRequired: true, liveActivated: false } });
  assert.strictEqual(withActivation.length, 2, 'activation outstanding: two steps');
  assert.strictEqual(JSON.stringify(withActivation.map((s) => s.key)),
    JSON.stringify(['startHere.live.step0', 'startHere.live.step3']));

  // Requirement OFF (the default deployment): the customer must never be told to
  // buy an activation the platform does not apply.
  const noActivation = vm.runInNewContext(
    extractFunction('activationPending') + extractFunction('startHereLiveSteps') + ';startHereLiveSteps()',
    { APP: { activationRequired: false, liveActivated: true } });
  assert.strictEqual(noActivation.length, 1, 'no activation requirement: one step');
  assert.strictEqual(JSON.stringify(noActivation.map((s) => s.key)), JSON.stringify(['startHere.live.step3']));

  for (const s of withActivation.concat(noActivation)) {
    const value = T.en[s.key];
    assert.ok(value && value.trim().length > 0, s.key + ' must be non-empty');
    assert.ok(!/demo|virtual/i.test(value), s.key + ' must not mention demo funds');
  }
  assert.match(T.en['startHere.live.step0'], /activation/i);
  assert.match(T.en['startHere.live.step3'], /trade/i);
  // The subtitle follows the step count, so it can never promise "two steps"
  // to an account that has one.
  assert.ok(T.en['startHere.live.subtitle'] && T.en['startHere.live.subtitleNext']);
  assert.match(T.en['startHere.live.subtitle'], /two steps/i);
});

// ---------------------------------------------------------------------------
// 3. It renders, and it never performs a financial action
// ---------------------------------------------------------------------------
test('3. updateStartHere renders the steps without touching money', () => {
  const sb = buildSandbox({});
  sb.updateStartHere();
  assert.strictEqual(sb.els.startHereCard.style.display, 'block');
  assert.strictEqual((sb.els.startHereStepsLive.innerHTML.match(/sh-num/g) || []).length, 1, 'the single step rendered');
  assert.strictEqual(sb.els.startHereStepsLive.style.display, 'flex');
  assert.strictEqual(sb.els.startHereStepsLiveReady.style.display, 'none');
  assert.strictEqual(sb.els.startHereSubtitle.textContent, T.en['startHere.live.subtitleNext']);
  const body = extractFunction('updateStartHere') + extractFunction('renderStartHereLiveSteps');
  assert.ok(!/fetch\(|requestDepositAddress|create-invoice|\/api\/|liveData\.balance\s*=/i.test(body),
    'display only: no request and no balance write');
});

test('3b. with the activation requirement ON the card shows both steps and their subtitle', () => {
  const sb = buildSandbox({ activationRequired: true, liveActivated: false });
  sb.updateStartHere();
  assert.strictEqual((sb.els.startHereStepsLive.innerHTML.match(/sh-num/g) || []).length, 2);
  assert.ok(sb.els.startHereStepsLive.innerHTML.includes('activation'), 'the activation step is rendered');
  assert.strictEqual(sb.els.startHereSubtitle.textContent, T.en['startHere.live.subtitle']);
  // An unactivated account is never reported as complete.
  assert.strictEqual(sb.els.startHereStepsLiveReady.style.display, 'none');
  const done = buildSandbox({ activationRequired: true, liveActivated: true, liveData: { hasTradingActivity: true } });
  done.updateStartHere();
  assert.strictEqual(done.els.startHereStepsLiveReady.style.display, 'block', 'traded + activated: complete');
});

// ---------------------------------------------------------------------------
// 4. Dismissal and sandbox exclusion
// ---------------------------------------------------------------------------
test('4. dismissal is per account and the sandbox never sees the card', () => {
  const dismissed = buildSandbox({ dismissed: true });
  dismissed.updateStartHere();
  assert.strictEqual(dismissed.els.startHereCard.style.display, 'none', 'dismissal hides the card');

  const sandbox = buildSandbox({ environment: 'MARKETING_SANDBOX' });
  sandbox.updateStartHere();
  assert.strictEqual(sandbox.els.startHereCard.style.display, 'none', 'sandbox hides the card');
  assert.strictEqual(sandbox.els.startHereStepsLive.innerHTML, '', 'nothing is rendered for the sandbox');

  assert.match(extractFunction('startHereKey'), /arbi_starthere_/, 'the dismissal key is per account');
});

// ---------------------------------------------------------------------------
// 5. Completion state
// ---------------------------------------------------------------------------
test('5. a funded, traded account sees the compact completion line', () => {
  const done = buildSandbox({ liveData: { hasRealDeposit: true, hasTradingActivity: true } });
  done.updateStartHere();
  assert.strictEqual(done.els.startHereStepsLive.style.display, 'none', 'steps are replaced');
  assert.strictEqual(done.els.startHereStepsLiveReady.style.display, 'block');

  const partial = buildSandbox({ liveData: { hasRealDeposit: true } });
  partial.updateStartHere();
  assert.strictEqual(partial.els.startHereStepsLiveReady.style.display, 'none', 'one flag is not enough');
});

// ---------------------------------------------------------------------------
// 6. Language switch re-renders the steps
// ---------------------------------------------------------------------------
test('6. a language switch rebuilds the checklist', () => {
  const dyn = INDEX.slice(INDEX.indexOf('function updateDynamicTranslations'));
  assert.ok(/updateStartHere\(\)/.test(dyn.slice(0, 6000)), 'updateDynamicTranslations must re-render it');
  const render = extractFunction('renderStartHereLiveSteps');
  assert.ok(/t\(/.test(render), 'the steps come from the dictionary, so they follow the locale');
});

// ---------------------------------------------------------------------------
// 7. i18n parity
// ---------------------------------------------------------------------------
test('7. every startHere key exists in all six locales, with no demo wording', () => {
  const keys = ['startHere.dismiss', 'startHere.live.title', 'startHere.live.subtitle',
    'startHere.live.step0', 'startHere.live.step3', 'startHere.live.ready'];
  for (const lang of LANGS) {
    assert.deepStrictEqual(Object.keys(T[lang]).sort(), Object.keys(T.en).sort(), lang + ' key set differs');
    for (const k of keys) {
      assert.ok(String(T[lang][k] || '').trim().length > 0, lang + '.' + k + ' is empty');
    }
  }
  const demoWords = { en: /demo/i, es: /demostraci/i, pt: /demonstra/i, fr: /d[ée]mo/i, ar: /تجريب/, zh: /演示/ };
  for (const lang of LANGS) {
    for (const k of keys) {
      assert.ok(!demoWords[lang].test(String(T[lang][k])), lang + '.' + k + ' mentions demo: ' + T[lang][k]);
    }
  }
});

// ---------------------------------------------------------------------------
// 8. No second checklist / dead demo containers
// ---------------------------------------------------------------------------
test('8. there is exactly one checklist and no dead demo container', () => {
  assert.strictEqual((INDEX.match(/id="startHereCard"/g) || []).length, 1);
  assert.strictEqual((INDEX.match(/id="startHereStepsLive"/g) || []).length, 1);
  assert.ok(!INDEX.includes('id="startHereStepsDemo"'));
  assert.ok(!INDEX.includes('id="startHereHeadDemo"'));
  assert.ok(!/'startHere\.step[0-9]'/.test(INDEX), 'the retired demo step keys are gone');
});
