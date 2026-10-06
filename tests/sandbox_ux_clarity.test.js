'use strict';

/**
 * F5 + F7 — Customer-facing clarity tests (display only).
 *
 *  F5: the deposit modal shows the minimum deposit before submission, rendered
 *      from the single frontend source APP.MIN_DEPOSIT (server validation is
 *      untouched).
 *  F7: the sandbox-only "no real money / simulated balance" callouts were
 *      removed from the referral area so the demo mirrors production. The
 *      referral CALCULATION (20% of the first qualifying deposit, $100 minimum)
 *      is unchanged and is still asserted here.
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
// F7 - sandbox referral / bonus wording (disclosure callouts removed)
//
// The sandbox-only callouts were removed from the referral area so the demo
// mirrors the production UI. The demo disclosure now lives outside this area
// (the preview badge). The referral CALCULATION is unchanged.
// ===========================================================================

const SANDBOX_KEYS_REMOVED = [
  'referral.partner.simulatedNote',
  'referral.sandboxCreditNote',
  'referral.sandboxWalletTarget',
  'bonus.sandboxNoEarnings',
];

test('F7: the sandbox disclosure callouts are gone from the referral area', () => {
  assert.ok(INDEX.includes('id="refStep3Destination"'), 'step-3 destination span exists');
  assert.ok(/id="refStep3Destination"[^>]*data-i18n="referral\.bonusWallet"/.test(INDEX),
    'step-3 destination uses the production Bonus Wallet label');
  for (const gone of ['referralSandboxNote', 'partnerSimulatedNote', 'updateSandboxReferralWording']) {
    assert.ok(!INDEX.includes(gone), `${gone} must be removed`);
  }
});

test('F7: the Bonus Wallet empty-state copy is neutral for sandbox and production', () => {
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
    ctx.t = (k) => ({ 'bonus.noEarnings': 'No referral earnings to convert yet.' })[k] || k;
    ctx.updateBonusWalletUI();
    return els.bonusWithdrawInfo.innerHTML;
  }

  const sandbox = run('MARKETING_SANDBOX');
  const prod = run('PRODUCTION');
  assert.ok(sandbox.includes('No referral earnings'), 'sandbox uses the neutral production copy');
  assert.ok(prod.includes('No referral earnings'), 'production is unchanged');
  assert.ok(!/simulat|sandbox/i.test(sandbox), 'no demo-speak in the sandbox bonus empty-state');
  assert.ok(!src.includes('MARKETING_SANDBOX'), 'the empty-state no longer branches on environment');

  const hook = extractFunction(INDEX, 'updateDynamicTranslations');
  assert.ok(hook.includes('updateBonusWalletUI()'), 'bonus wallet text refreshes on language switch');
});

test('F7: the removed sandbox-only keys are absent from every locale', () => {
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

  for (const lang of ['en', 'es', 'pt', 'fr', 'ar', 'zh']) {
    for (const k of SANDBOX_KEYS_REMOVED) {
      assert.strictEqual(T[lang][k], undefined, `${lang}.${k} must be removed`);
    }
    assert.strictEqual(Object.keys(T[lang]).length, 1501, `${lang} must have 1501 keys`);
  }
});

test('F7: the demo preview disclosure outside the referral area is preserved', () => {
  assert.ok(INDEX.includes('id="sandboxBadge"'), 'the preview badge still exists');
  assert.match(INDEX, /'sandbox\.badge':/);
  assert.match(INDEX, /APP\.environment === 'MARKETING_SANDBOX'/);
});

test('F7: referral calculation/business rules are unchanged', () => {
  assert.match(SERVER, /SANDBOX_REFERRAL_REWARD_PERCENT_DEFAULT = 20/);
  assert.match(SERVER, /SANDBOX_REFERRAL_MIN_DEPOSIT = PLATFORM_MIN_DEPOSIT_USD/);
  assert.match(SERVER, /REFERRAL_REWARD_PERCENT_DEFAULT = 20/);
  // The sandbox reward RPC/percent logic is untouched by this display change.
  assert.match(SERVER, /sandbox_record_referral|sandbox_apply_referral|reward_percent/);
});
