'use strict';
/**
 * Single-mode onboarding + guidance.
 *
 * Replaces the retired demo-era coverage:
 *   - tests/deposit_demo_ux.test.js    (deposit flow in/out of Demo Mode)
 *   - tests/demo_live_reminder.test.js (demo-activity-triggered Live reminder)
 *   - tests/mode_persistence.test.js   (persisted Demo/Live switch)
 *
 * What those files protected, and where it lives now:
 *   - the customer is told what the $50 credit is and how Live gets funded
 *     -> onboarding (primary = credit, secondary = deposit) + the Start Here card
 *   - guidance is per account and dismissible, never nagging
 *     -> arbi_onboarding_<id> / arbi_starthere_<id>
 *   - opening the deposit flow never creates an invoice by itself
 *     -> both onboarding paths hand off to openDepositModal()
 *   - the sandbox is excluded from customer guidance
 *     -> APP.environment === 'MARKETING_SANDBOX'
 *   - no persisted Memo/Live switching state can resurrect a mode
 *     -> asserted absent here
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
  const start = INDEX.indexOf('const TRANSLATIONS');
  let depth = 0;
  let end = -1;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) { end = i; break; }
  }
  const box = {};
  vm.createContext(box);
  vm.runInContext(INDEX.slice(start, end + 1) + ';globalThis.__T = TRANSLATIONS;', box);
  return box.__T;
}

function fn(name) {
  const at = INDEX.indexOf('function ' + name);
  assert.ok(at > 0, name + ' must exist');
  let depth = 0;
  let started = false;
  for (let i = at; i < INDEX.length; i++) {
    if (INDEX[i] === '{') { depth++; started = true; }
    else if (INDEX[i] === '}' && --depth === 0 && started) return INDEX.slice(at, i + 1);
  }
  throw new Error('unterminated ' + name);
}

const T = loadTranslations();

// ---------------------------------------------------------------------------
// 1. The retired mode machinery is gone, not merely hidden
// ---------------------------------------------------------------------------
test('1. no persisted mode state, no mode switch, no demo wallet', () => {
  assert.ok(!/arbi_mode_/.test(INDEX), 'no per-account mode preference is stored');
  assert.strictEqual(INDEX.indexOf('function setMode('), -1, 'the mode switch is removed');
  assert.ok(!/localStorage\.(get|set)Item\('arbi_demo'/.test(INDEX), 'the demo wallet is not persisted');
  assert.ok(!/APP\.demoData/.test(INDEX), 'the demo wallet object is gone');
  assert.ok(!INDEX.includes("'mode.demo'") && !INDEX.includes("'mode.live'"),
    'the demo/live labels are gone');
});

// ---------------------------------------------------------------------------
// 2. Onboarding keeps its guidance contract
// ---------------------------------------------------------------------------
test('2. onboarding teaches the credit and hands Live funding to the deposit dialog', () => {
  const body = fn('chooseOnboarding');
  assert.ok(/choice === 'deposit'/.test(body), 'the deposit path is explicit');
  assert.ok(/openDepositModal\(\)/.test(body), 'it reuses the existing dialog');
  assert.ok(!/requestDepositAddress|create-invoice|fetch\(/.test(body), 'it never creates an invoice');
  assert.ok(!/demo|live-mode|setMode/i.test(body), 'no mode concept is involved');
  // Per-account, one-shot, and the sandbox is exempt.
  assert.match(fn('onboardingKey'), /arbi_onboarding_/);
  assert.match(fn('onboardingNeeded'), /MARKETING_SANDBOX/);
});

// ---------------------------------------------------------------------------
// 3. The retired reminder cannot come back
// ---------------------------------------------------------------------------
test('3. the demo-activity reminder is fully retired', () => {
  assert.strictEqual(INDEX.indexOf('demoFirstDepositCta'), -1, 'the reminder element is gone');
  assert.strictEqual(INDEX.indexOf('dismissDemoDepositCta'), -1, 'its dismissal handler is gone');
  assert.ok(!INDEX.includes("'demoCta.title'"), 'its copy keys are gone');
  assert.strictEqual(INDEX.indexOf('DEMO_CTA_MIN_TRADES'), -1, 'its trigger constant is gone');
  // Guidance now lives in the Start Here card, which is per account + dismissible.
  assert.match(fn('dismissStartHere'), /localStorage\.setItem\(startHereKey\(\)/);
});

// ---------------------------------------------------------------------------
// 4. Copy: the two funding paths are described honestly
// ---------------------------------------------------------------------------
test('4. the onboarding copy states the credit, its cap, and the deposit path', () => {
  assert.match(T.en['onboarding.primary'], /\$50/);
  assert.match(T.en['onboarding.primaryDesc'], /\$30/);
  assert.match(T.en['onboarding.secondary'], /deposit/i);
  const banned = /guarantee|risk-free|passive income/i;
  for (const lang of LANGS) {
    assert.deepStrictEqual(Object.keys(T[lang]).sort(), Object.keys(T.en).sort(), lang + ' key set differs');
    for (const k of Object.keys(T[lang]).filter((x) => x.startsWith('onboarding.'))) {
      assert.ok(!banned.test(String(T[lang][k])), lang + '.' + k + ' over-promises');
    }
  }
});

// ---------------------------------------------------------------------------
// 5. No customer-facing surface still offers a demo experience
// ---------------------------------------------------------------------------
test('5. no user-facing string offers Demo Mode', () => {
  const DEMO = {
    en: /demo/i, es: /demostraci/i, pt: /demonstra/i, fr: /d[ée]mo/i,
    ar: /تجريب/, zh: /演示/,
  };
  // Customer-facing copy only. Exempt: historical transaction labels (written
  // while the mode existed) and the admin-only sandbox controls, where
  // "demonstration" accurately describes a simulated account.
  const exempt = /^(tx\.(detail|type)\.)|sandbox/i;
  for (const lang of LANGS) {
    for (const [k, v] of Object.entries(T[lang])) {
      if (exempt.test(k)) continue;
      assert.ok(!DEMO[lang].test(String(v)), lang + '.' + k + ' still offers demo: ' + v);
    }
  }
  assert.ok(!INDEX.includes('StartDemo'), 'the demo funnel event is gone');
});
