'use strict';

/**
 * F5 + F7 — Customer-facing clarity tests (display only).
 *
 *  F5: the deposit modal shows the minimum deposit before submission, rendered
 *      from the single frontend source APP.MIN_DEPOSIT (server validation is
 *      untouched).
 *  F7: sandbox referral/Bonus-Wallet wording makes clear that sandbox referral
 *      rewards are credited to the simulated LIVE balance. The referral
 *      CALCULATION (20% of the first qualifying deposit, $100 minimum) is not
 *      changed and is asserted here.
 *
 * The real functions are extracted from public/index.html and executed in a vm
 * against a minimal fake DOM. No network/DB is touched.
 *
 * Run: npm test
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function extractFunction(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = src.match(re);
  assert.ok(m, `function ${name} not found`);
  const start = m.index;
  // Skip the parameter list first so destructured parameters ({ ... }) are not
  // mistaken for the function body.
  const parenStart = src.indexOf('(', start);
  let pdepth = 0;
  let paramEnd = -1;
  for (let i = parenStart; i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { paramEnd = i; break; } }
  }
  const braceStart = src.indexOf('{', paramEnd);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unterminated function ${name}`);
}

function fakeEl() {
  const classes = new Set(['hidden']);
  return {
    textContent: '',
    innerHTML: '',
    disabled: false,
    style: {},
    classList: {
      _set: classes,
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = (force === undefined) ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
    },
  };
}

function makeCtx(fnSource, els) {
  const ctx = {
    document: { getElementById: (id) => els[id] || null },
    getEl: (id) => els[id] || null,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fnSource, ctx);
  return ctx;
}

// ===========================================================================
// F5 — minimum deposit shown before submission
// ===========================================================================

test('F5: deposit modal shows a minimum-deposit notice above the amount input', () => {
  const noticeIdx = INDEX.indexOf('id="depositMinNotice"');
  const amountIdx = INDEX.indexOf('id="liveDepositAmount"');
  assert.ok(noticeIdx > -1, 'depositMinNotice element exists');
  assert.ok(amountIdx > -1, 'liveDepositAmount input exists');
  assert.ok(noticeIdx < amountIdx, 'notice is rendered above the amount input');
});

test('F5: the notice value comes from APP.MIN_DEPOSIT (single source, no literal 100)', () => {
  const fn = extractFunction(INDEX, 'updateDepositMinNotice');
  assert.ok(/APP\.MIN_DEPOSIT/.test(fn), 'notice must read APP.MIN_DEPOSIT');
  assert.ok(/t\('deposit\.minDeposit'/.test(fn), 'notice must use the localized key');
  assert.ok(!/\b100\b/.test(fn), 'notice must not hard-code the value');

  // The validation path mirrors the same constant instead of its own literal.
  const request = extractFunction(INDEX, 'requestDepositAddress');
  assert.ok(/const MIN_DEPOSIT_AMOUNT = APP\.MIN_DEPOSIT;/.test(request),
    'requestDepositAddress must use APP.MIN_DEPOSIT');
  assert.ok(!/MIN_DEPOSIT_AMOUNT = 100/.test(request), 'no duplicated literal 100');

  assert.ok(/MIN_DEPOSIT:\s*100/.test(INDEX), 'APP.MIN_DEPOSIT stays 100');
});

test('F5: updateDepositMinNotice renders the localized minimum for the configured value', () => {
  const els = { depositMinNotice: fakeEl() };
  const ctx = makeCtx(extractFunction(INDEX, 'updateDepositMinNotice'), els);
  ctx.APP = { MIN_DEPOSIT: 100 };
  ctx.t = (k, vars) => {
    const s = ({ 'deposit.minDeposit': 'Minimum deposit is ${{min}}' })[k] || k;
    return vars ? s.split('{{min}}').join(vars.min) : s;
  };
  ctx.updateDepositMinNotice();
  assert.strictEqual(els.depositMinNotice.textContent, 'Minimum deposit is $100');
});

test('F5: notice re-renders on language switch (hook present)', () => {
  const hook = extractFunction(INDEX, 'updateDynamicTranslations');
  assert.ok(hook.includes('updateDepositMinNotice()'), 'updateDynamicTranslations must refresh the notice');
  const open = extractFunction(INDEX, 'openDepositModal');
  assert.ok(open.includes('updateDepositMinNotice()'), 'opening the modal refreshes the notice');
});

test('F5: server-side minimum-deposit validation is unchanged', () => {
  assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 100;/);
  assert.match(SERVER, /amt < PLATFORM_MIN_DEPOSIT_USD/);
});

// ===========================================================================
// F7 — sandbox referral / bonus wording
// ===========================================================================

test('F7: referral step 3 destination is targetable and a sandbox note exists (hidden by default)', () => {
  assert.ok(INDEX.includes('id="refStep3Destination"'), 'step-3 destination span exists');
  const note = INDEX.match(/<div id="referralSandboxNote"[^>]*>/);
  assert.ok(note, 'sandbox note exists');
  assert.ok(/class="hidden"/.test(note[0]), 'sandbox note hidden by default');
  assert.ok(INDEX.includes('data-i18n="referral.sandboxCreditNote"'), 'sandbox note is localized');
});

test('F7: sandbox wording points rewards at the simulated Live balance; production wording unchanged', () => {
  const src = extractFunction(INDEX, 'updateSandboxReferralWording');

  const sandboxEls = { refStep3Destination: fakeEl(), referralSandboxNote: fakeEl() };
  const sandboxCtx = makeCtx(src, sandboxEls);
  sandboxCtx.APP = { environment: 'MARKETING_SANDBOX' };
  sandboxCtx.t = (k) => ({ 'referral.sandboxWalletTarget': 'Simulated Live balance', 'referral.bonusWallet': 'Bonus Wallet' })[k] || k;
  sandboxCtx.updateSandboxReferralWording();
  assert.strictEqual(sandboxEls.refStep3Destination.textContent, 'Simulated Live balance');
  assert.strictEqual(sandboxEls.referralSandboxNote.classList.contains('hidden'), false, 'note visible for sandbox');

  const prodEls = { refStep3Destination: fakeEl(), referralSandboxNote: fakeEl() };
  const prodCtx = makeCtx(src, prodEls);
  prodCtx.APP = { environment: 'PRODUCTION' };
  prodCtx.t = (k) => ({ 'referral.sandboxWalletTarget': 'Simulated Live balance', 'referral.bonusWallet': 'Bonus Wallet' })[k] || k;
  prodCtx.updateSandboxReferralWording();
  assert.strictEqual(prodEls.refStep3Destination.textContent, 'Bonus Wallet');
  assert.strictEqual(prodEls.referralSandboxNote.classList.contains('hidden'), true, 'note hidden for production');
});

test('F7: Bonus Wallet empty-state explains sandbox crediting for sandbox accounts only', () => {
  const src = extractFunction(INDEX, 'updateBonusWalletUI');

  function run(environment) {
    const els = {
      bonusBalanceDisplay: fakeEl(),
      bonusWithdrawBtn: fakeEl(),
      bonusWithdrawInfo: fakeEl(),
      bonusWithdrawStatus: fakeEl(),
    };
    const ctx = makeCtx(src, els);
    ctx.APP = { environment, bonusData: { balance: 0 } };
    ctx.formatCurrency = (n) => '$' + Number(n).toFixed(2);
    ctx.t = (k) => ({ 'bonus.noEarnings': 'No referral earnings to convert yet.',
                      'bonus.sandboxNoEarnings': 'Sandbox referral rewards are credited to your simulated Live balance.' })[k] || k;
    ctx.updateBonusWalletUI();
    return els;
  }

  assert.ok(run('MARKETING_SANDBOX').bonusWithdrawInfo.innerHTML.includes('simulated Live balance'));
  assert.ok(run('PRODUCTION').bonusWithdrawInfo.innerHTML.includes('No referral earnings'));

  const hook = extractFunction(INDEX, 'updateDynamicTranslations');
  assert.ok(hook.includes('updateSandboxReferralWording()'), 'referral wording refreshes on language switch');
  assert.ok(hook.includes('updateBonusWalletUI()'), 'bonus wallet text refreshes on language switch');
});

test('F7: referral calculation/business rules are unchanged', () => {
  assert.match(SERVER, /SANDBOX_REFERRAL_REWARD_PERCENT_DEFAULT = 20/);
  assert.match(SERVER, /SANDBOX_REFERRAL_MIN_DEPOSIT = PLATFORM_MIN_DEPOSIT_USD/);
  assert.match(SERVER, /REFERRAL_REWARD_PERCENT_DEFAULT = 20/);
  // The sandbox reward RPC/percent logic is untouched by this display change.
  assert.match(SERVER, /sandbox_record_referral|sandbox_apply_referral|reward_percent/);
});

test('F7: the new i18n keys are defined and non-empty in all 6 locales', () => {
  // Locate the TRANSLATIONS object inside a <script> block and brace-match it
  // (the inner per-locale objects make a regex terminator unreliable).
  const blocks = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const blk = blocks.find((b) => b.includes('const TRANSLATIONS'));
  assert.ok(blk, 'TRANSLATIONS block should exist');
  const start = blk.indexOf('const TRANSLATIONS');
  let i = blk.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (; i < blk.length; i++) {
    if (blk[i] === '{') depth++;
    else if (blk[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > 0, 'TRANSLATIONS object should be brace-matchable');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext('this.T = ' + blk.slice(blk.indexOf('{', start), end + 1), sandbox);
  const T = sandbox.T;

  const keys = ['referral.sandboxWalletTarget', 'referral.sandboxCreditNote', 'bonus.sandboxNoEarnings'];
  for (const lang of ['en', 'es', 'pt', 'fr', 'ar', 'zh']) {
    for (const k of keys) {
      assert.ok(T[lang] && typeof T[lang][k] === 'string' && T[lang][k].trim().length > 0,
        `${lang}.${k} must be a non-empty string`);
    }
  }
});
