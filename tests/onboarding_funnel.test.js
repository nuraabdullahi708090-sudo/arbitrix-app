'use strict';

/**
 * POST-REGISTRATION ONBOARDING FUNNEL — tests.
 *
 * Business goal: Demo is an optional product preview; the primary onboarding
 * path guides users to their first real deposit. Pins:
 *   - a new user sees two choices: primary "Make My First Deposit" and
 *     secondary "Explore Demo";
 *   - "Make My First Deposit" opens the deposit flow (demo notice + switch);
 *   - "Explore Demo" enters Demo mode (never forced to deposit);
 *   - no invoice is created and no balance is credited by showing/choosing the
 *     onboarding or switching modes;
 *   - returning users (and sandbox accounts) are never re-onboarded;
 *   - demo / promotional / real deposited balances stay clearly separated.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function loadTranslations() {
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
    return sandbox.T;
}

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, name + ' should be brace-matchable');
    return INDEX.slice(start, end + 1);
}

const ONBOARDING_FNS = [
    'currentCachedUser', 'onboardingKey', 'getOnboardingChoice', 'setOnboardingChoice',
    'onboardingNeeded', 'showOnboarding', 'maybeShowOnboardingForCurrentUser',
    'chooseOnboarding', 'updateDemoFirstDepositCta', 'dismissDemoDepositCta',
    'updateDepositMinNotice', 'refreshDepositModeNotice', 'resetDepositModal',
    'openDepositModal', 'switchToLiveAndContinueDeposit', 'requestDepositAddress',
];

function buildSandbox({ mode = 'demo', environment = 'PRODUCTION', funded = false } = {}) {
    const els = {};
    const fetchCalls = [];
    const toasts = [];
    const goToAppCalls = [];
    const setModeCalls = [];
    const store = {};
    function makeEl(id) {
        const node = {
            id, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
            disabled: false, classes: new Set(), focus: () => {}, dispatchEvent: () => {},
        };
        node.classList = {
            add: (c) => node.classes.add(c),
            remove: (c) => node.classes.delete(c),
            contains: (c) => node.classes.has(c),
            toggle: (c, force) => {
                const on = (force === undefined) ? !node.classes.has(c) : !!force;
                if (on) node.classes.add(c); else node.classes.delete(c);
            },
        };
        return node;
    }
    const el = (id) => (els[id] || (els[id] = makeEl(id)));

    const APP = {
        mode, environment,
        demoData: { balance: 1000 },
        liveData: { balance: 50, hasRealDeposit: funded, promoCreditFunded: true },
        bonusData: { balance: 0 },
        MIN_DEPOSIT: 100, MTA: 200,
    };

    const sandbox = {
        APP, els, fetchCalls, toasts, goToAppCalls, setModeCalls, store, el,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        window: {},
        localStorage: {
            getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; },
        },
        clearInterval: () => {},
        setInterval: () => {},
        document: { getElementById: el, querySelectorAll: () => [] },
        getEl: el,
        // Interpolating t() mock so {{min}} substitution can be asserted.
        t: (k, vars) => {
            let s = k;
            if (vars) for (const [kk, vv] of Object.entries(vars)) s += ':' + kk + '=' + vv;
            return s;
        },
        formatCurrency: (n) => '$' + Number(n || 0).toFixed(2),
        showToast: (...a) => toasts.push(a),
        translateBackendMessage: (m, fb) => fb || m,
        updatePaymentProgress: () => {},
        updateCurrentStatus: () => {},
        showPaymentSection: () => {},
        updateUI: () => {},
        switchChartWallet: () => {},
        trackMetaConversion: () => {},
        stopBot: () => {},
        fetch: async (url) => {
            fetchCalls.push(String(url));
            return { ok: true, json: async () => ({ success: true, invoice: { id: 'inv_test' } }) };
        },
        setButtonLoading: () => {},
        goToApp: (src) => { goToAppCalls.push(src); },
        setMode: (m) => { setModeCalls.push(m); APP.mode = m; },
    };
    vm.createContext(sandbox);

    const src = [
        'var pendingOnboardingDeposit = false; var demoDepositCtaDismissed = false; var demoCtaLastShownAt = 0;',
        'var DEMO_CTA_MIN_TRADES = 3; var DEMO_CTA_REMINDER_INTERVAL_MS = 10 * 60 * 1000;',
        'let paymentPollingInterval = null; let countdownInterval = null; let currentInvoiceId = null; let currentCurrency = "USDT"; let currentNetwork = "TRC20";',
        ...ONBOARDING_FNS.map(extractFunction),
    ].join('\n');
    vm.runInContext(src, sandbox);
    return sandbox;
}

test('New user sees the two onboarding choices (primary demo + secondary live)', () => {
    // Static wiring: both CTAs exist and the safe (no real money) choice is
    // visually primary so a beginner is never pushed straight into depositing.
    const primaryIdx = INDEX.indexOf('onclick="chooseOnboarding(\'demo\')"');
    const secondaryIdx = INDEX.indexOf('onclick="chooseOnboarding(\'live\')"');
    assert.ok(primaryIdx > 0, 'primary demo CTA must exist');
    assert.ok(secondaryIdx > 0, 'secondary live CTA must exist');
    assert.ok(primaryIdx < secondaryIdx, 'the demo CTA must come first (primary position)');
    const primaryBtn = INDEX.slice(INDEX.lastIndexOf('<button', primaryIdx), INDEX.indexOf('>', primaryIdx) + 1);
    const secondaryBtn = INDEX.slice(INDEX.lastIndexOf('<button', secondaryIdx), INDEX.indexOf('>', secondaryIdx) + 1);
    assert.ok(/btn-primary/.test(primaryBtn), 'Explore Demo Mode must be a primary button');
    assert.ok(/btn-secondary/.test(secondaryBtn), 'Review Live Mode must be a secondary button');

    // The modal explains the platform in plain language before the choice.
    const at = INDEX.indexOf('id="onboardingModal"');
    const block = INDEX.slice(at, INDEX.indexOf('id="withdrawModal"', at));
    assert.ok(/onboarding\.explainer/.test(block), 'onboarding must explain the platform');
    assert.ok(/data-i18n="onboarding\.primaryDesc"/.test(block), 'primary outcome text is a localized span');

    // Behavioral: showOnboarding opens the modal and makes no request.
    const sb = buildSandbox();
    const shown = vm.runInContext('showOnboarding({ id: 1, name: "A" })', sb);
    assert.strictEqual(shown, true);
    assert.ok(sb.el('onboardingModal').classList.contains('open'), 'onboarding modal must open');
    assert.strictEqual(sb.fetchCalls.length, 0, 'showing onboarding must not make any request');
});

test('"Review Live Mode" enters Live mode without depositing or creating an invoice', () => {
    const sb = buildSandbox({ mode: 'demo' });
    sb.store['arbi_user'] = JSON.stringify({ id: 12 });
    vm.runInContext('chooseOnboarding("live")', sb);
    assert.strictEqual(sb.store['arbi_onboarding_12'], 'live', 'live choice persisted per account');
    assert.deepStrictEqual(sb.goToAppCalls, ['onboarding_live'], 'live path enters the app');
    assert.strictEqual(sb.APP.mode, 'live', 'user is switched to Live for review');
    assert.strictEqual(sb.pendingOnboardingDeposit, false, 'live preview never queues a deposit');
    assert.strictEqual(sb.fetchCalls.length, 0, 'live preview makes no request');
    assert.ok(!sb.el('onboardingModal').classList.contains('open'), 'onboarding closes after choosing');
});

test('"Make My First Deposit" opens the deposit flow (no invoice yet)', () => {
    const sb = buildSandbox();
    sb.store['arbi_user'] = JSON.stringify({ id: 7, name: 'A' });
    vm.runInContext('showOnboarding({ id: 7 })', sb);
    vm.runInContext('chooseOnboarding("deposit")', sb);

    assert.strictEqual(sb.store['arbi_onboarding_7'], 'deposit', 'choice must be persisted per account');
    assert.ok(!sb.el('onboardingModal').classList.contains('open'), 'onboarding closes after choosing');
    assert.deepStrictEqual(sb.goToAppCalls, ['onboarding_deposit'], 'deposit path enters the app');
    assert.strictEqual(sb.pendingOnboardingDeposit, true, 'initApp consumes the pending deposit flag');

    // Simulate initApp's consumption (mode settled, then open the deposit flow).
    vm.runInContext('if (pendingOnboardingDeposit) { pendingOnboardingDeposit = false; openDepositModal(); }', sb);
    assert.ok(sb.el('depositModal').classList.contains('open'), 'deposit modal opens immediately');
    assert.strictEqual(sb.els.depositDemoNotice.style.display, 'block', 'demo funds -> notice shown');
    assert.strictEqual(sb.fetchCalls.length, 0, 'no invoice created before the user confirms');
    assert.strictEqual(sb.pendingOnboardingDeposit, false, 'flag consumed');
    // Source: initApp really consumes the flag and re-checks returning users.
    const init = extractFunction('initApp');
    assert.ok(init.includes('if (pendingOnboardingDeposit)'), 'initApp must consume the pending deposit flag');
    assert.ok(init.includes('maybeShowOnboardingForCurrentUser();'), 'initApp must check returning-user onboarding');
});

test('"Explore Demo" enters Demo mode without forcing a deposit', () => {
    const sb = buildSandbox();
    sb.store['arbi_user'] = JSON.stringify({ id: 8, name: 'B' });
    vm.runInContext('showOnboarding({ id: 8 })', sb);
    const before = { demo: sb.APP.demoData.balance, live: sb.APP.liveData.balance };
    vm.runInContext('chooseOnboarding("demo")', sb);

    assert.strictEqual(sb.store['arbi_onboarding_8'], 'demo');
    assert.deepStrictEqual(sb.goToAppCalls, ['onboarding_demo']);
    assert.strictEqual(sb.APP.mode, 'demo', 'user stays in Demo');
    assert.strictEqual(sb.pendingOnboardingDeposit, false, 'demo path never queues a deposit');
    assert.strictEqual(sb.fetchCalls.length, 0, 'demo path makes no request');
    assert.strictEqual(sb.APP.demoData.balance, before.demo, 'demo balance unchanged');
    assert.strictEqual(sb.APP.liveData.balance, before.live, 'live balance unchanged');
    // The in-Demo CTA is deliberately restrained: it is withheld until the user
    // has meaningful demo activity, so it is not raised on entering Demo.
    assert.ok(sb.els.demoFirstDepositCta.classList.contains('hidden'), 'in-demo CTA withheld until meaningful demo activity');
    sb.APP.demoData.trades = 3;
    vm.runInContext('updateDemoFirstDepositCta()', sb);
    assert.ok(!sb.els.demoFirstDepositCta.classList.contains('hidden'), 'in-demo CTA appears after meaningful demo activity');
    assert.strictEqual(sb.fetchCalls.length, 0, 'showing the CTA makes no request');
    vm.runInContext('dismissDemoDepositCta()', sb);
    assert.ok(sb.els.demoFirstDepositCta.classList.contains('hidden'), 'in-demo CTA can be dismissed');
    // Clicking it opens the deposit flow (demo notice + switch), never an invoice.
    vm.runInContext('openDepositModal()', sb);
    assert.ok(sb.el('depositModal').classList.contains('open'));
    assert.strictEqual(sb.fetchCalls.length, 0);
});

test('Switching to Live from the onboarding deposit flow preserves the deposit', async () => {
    const sb = buildSandbox();
    sb.store['arbi_user'] = JSON.stringify({ id: 9 });
    vm.runInContext('chooseOnboarding("deposit")', sb);
    vm.runInContext('if (pendingOnboardingDeposit) { pendingOnboardingDeposit = false; openDepositModal(); }', sb);
    assert.ok(sb.el('depositModal').classList.contains('open'));

    vm.runInContext('switchToLiveAndContinueDeposit()', sb);
    assert.strictEqual(sb.APP.mode, 'live');
    assert.ok(sb.el('depositModal').classList.contains('open'), 'modal stays open after switching');
    assert.strictEqual(sb.els.depositDemoNotice.style.display, 'none');
    assert.strictEqual(sb.els.getAddressBtn.style.display, 'block', 'invoice button enabled after switching');
    assert.strictEqual(sb.fetchCalls.length, 0, 'switching alone creates no invoice');

    // Only the explicit generate action creates the invoice.
    sb.els.liveDepositAmount.value = '150';
    const p = vm.runInContext('requestDepositAddress()', sb);
    if (p && typeof p.then === 'function') await p;
    assert.strictEqual(sb.fetchCalls.length, 1, 'invoice created only after user confirms');
});

test('Returning users are not repeatedly shown onboarding', () => {
    // A stored choice suppresses onboarding for that account.
    const sb = buildSandbox();
    sb.store['arbi_user'] = JSON.stringify({ id: 42 });
    sb.store['arbi_onboarding_42'] = 'demo';
    assert.strictEqual(vm.runInContext('showOnboarding({ id: 42 })', sb), false);
    assert.ok(!sb.el('onboardingModal').classList.contains('open'), 'returning user must not see onboarding');
    vm.runInContext('maybeShowOnboardingForCurrentUser()', sb);
    assert.ok(!sb.el('onboardingModal').classList.contains('open'));

    // Even a "shown but not chosen" marker prevents an every-login nag.
    const sb2 = buildSandbox();
    sb2.store['arbi_user'] = JSON.stringify({ id: 43 });
    sb2.store['arbi_onboarding_43'] = 'shown';
    vm.runInContext('maybeShowOnboardingForCurrentUser()', sb2);
    assert.ok(!sb2.el('onboardingModal').classList.contains('open'), 'shown marker must suppress re-show');

    // A funded account is never prompted, even with no marker.
    const sb3 = buildSandbox({ funded: true });
    sb3.store['arbi_user'] = JSON.stringify({ id: 44 });
    vm.runInContext('maybeShowOnboardingForCurrentUser()', sb3);
    assert.ok(!sb3.el('onboardingModal').classList.contains('open'), 'funded users are never prompted');

    // First-time, unfunded account IS prompted once.
    const sb4 = buildSandbox();
    sb4.store['arbi_user'] = JSON.stringify({ id: 45 });
    vm.runInContext('maybeShowOnboardingForCurrentUser()', sb4);
    assert.ok(sb4.el('onboardingModal').classList.contains('open'), 'new unfunded user is prompted');
    assert.strictEqual(sb4.store['arbi_onboarding_45'], 'shown', 'shown marker stored immediately');

    // Signup shows it explicitly.
    assert.ok(/showOnboarding\(data\.user\)/.test(extractFunction('handleSignup')), 'signup must show onboarding');
});

test('MARKETING_SANDBOX behavior is unchanged', () => {
    const sb = buildSandbox({ environment: 'MARKETING_SANDBOX' });
    sb.store['arbi_user'] = JSON.stringify({ id: 77 });
    assert.strictEqual(vm.runInContext('showOnboarding({ id: 77 })', sb), false, 'sandbox is never onboarded');
    vm.runInContext('maybeShowOnboardingForCurrentUser()', sb);
    assert.ok(!sb.el('onboardingModal').classList.contains('open'));
    assert.strictEqual(sb.store['arbi_onboarding_77'], undefined, 'no onboarding marker written for sandbox');

    const sb2 = buildSandbox({ mode: 'demo', environment: 'MARKETING_SANDBOX' });
    vm.runInContext('openDepositModal()', sb2);
    assert.ok(!sb2.el('depositModal').classList.contains('open'), 'sandbox demo keeps the old toast, no modal');
    assert.strictEqual(sb2.toasts.at(-1)[0], 'deposit.switchToLive');

    // The sandbox server branch + provider safeguards are untouched.
    assert.ok(SERVER.includes('handleSandboxInvoiceCreate'));
    assert.ok(/const PLATFORM_MIN_DEPOSIT_USD = 100;/.test(SERVER));
});

test('Demo, promotional and real deposited balances stay clearly separated', () => {
    const T = loadTranslations();
    const en = T.en;
    assert.ok(/virtual/i.test(en['onboarding.virtualNote']), 'demo label must say virtual');
    assert.ok(/real trading/i.test(en['onboarding.realNote']), 'live label must say real trading');
    assert.ok(/\$50/.test(en['onboarding.promoNote']) && /separate/i.test(en['onboarding.promoNote']),
        'promo must be labelled separate from deposits');
    assert.ok(/virtual/i.test(en['demoCta.body']) && /cannot be withdrawn/i.test(en['demoCta.body']),
        'demo CTA must explain virtual funds cannot be withdrawn');
    assert.ok(/real/i.test(en['wallet.liveReal']) && /separate/i.test(en['wallet.liveReal']),
        'live wallet label must say real + separate');
    // Existing demo label retained.
    assert.ok(en['demo.virtualOnly'], 'existing demo virtual-only label retained');
    // No misleading earnings / guarantee claims in the new copy.
    const suspicious = /guarantee|guaranteed|risk-?free|earn \$|profit guaranteed/i;
    for (const k of ['onboarding.primaryDesc', 'onboarding.secondaryDesc', 'onboarding.virtualNote',
        'onboarding.realNote', 'onboarding.promoNote', 'demoCta.body', 'wallet.liveReal']) {
        assert.ok(!suspicious.test(en[k]), `misleading claim in ${k}`);
    }
});

test('Onboarding never credits a balance and creates no invoice', () => {
    const sb = buildSandbox();
    sb.store['arbi_user'] = JSON.stringify({ id: 100 });
    const before = { demo: sb.APP.demoData.balance, live: sb.APP.liveData.balance, bonus: sb.APP.bonusData.balance };
    vm.runInContext('showOnboarding({ id: 100 })', sb);
    vm.runInContext('chooseOnboarding("deposit")', sb);
    vm.runInContext('openDepositModal()', sb);
    vm.runInContext('switchToLiveAndContinueDeposit()', sb);
    assert.strictEqual(sb.APP.demoData.balance, before.demo);
    assert.strictEqual(sb.APP.liveData.balance, before.live);
    assert.strictEqual(sb.APP.bonusData.balance, before.bonus);
    assert.strictEqual(sb.fetchCalls.length, 0, 'no request at all during onboarding/modal/switch');
});

test('i18n parity across 6 locales for the onboarding keys', () => {
    const T = loadTranslations();
    const keys = ['onboarding.title', 'onboarding.subtitle', 'onboarding.primary', 'onboarding.primaryDesc',
        'onboarding.secondary', 'onboarding.secondaryDesc', 'onboarding.explainer', 'onboarding.virtualNote',
        'onboarding.realNote', 'onboarding.promoNote', 'onboarding.noObligation', 'demoCta.title', 'demoCta.body',
        'demoCta.button', 'demoCta.later', 'wallet.liveReal'];
    const enKeys = Object.keys(T.en);
    assert.strictEqual(enKeys.length, 1391, 'expected 1391 keys per locale');
    for (const [lang, dict] of Object.entries(T)) {
        assert.deepStrictEqual(new Set(Object.keys(dict)), new Set(enKeys), `${lang} key set differs`);
        for (const k of keys) {
            assert.ok(dict[k], `${lang}.${k} missing`);
            assert.ok(String(dict[k]).length > 0, `${lang}.${k} empty`);
        }
    }
});

test('the support / KYC-hide change does not touch the onboarding funnel', () => {
    // Onboarding + deposit-entry functions must remain unrelated to the new
    // support UI and to the (hidden) standalone KYC form.
    for (const name of ['showOnboarding', 'chooseOnboarding', 'openDepositModal', 'switchToLiveAndContinueDeposit']) {
        const src = extractFunction(name);
        assert.ok(!/openSupportModal|supportModal|openVerificationModal/.test(src),
            `${name} must not reference support or KYC UI`);
    }
    // The onboarding modal still offers exactly the two choices and no KYC step.
    const at = INDEX.indexOf('id="onboardingModal"');
    assert.ok(at > 0, 'onboarding modal should exist');
    const boundary = INDEX.indexOf('id="withdrawModal"', at);
    const block = INDEX.slice(at, boundary > at ? boundary : at + 900);
    assert.ok(/onboarding\.primary/.test(block) && /onboarding\.secondary/.test(block),
        'primary deposit + secondary demo choices preserved');
    assert.ok(!/verification|kyc/i.test(block), 'no standalone verification step in onboarding');
});

