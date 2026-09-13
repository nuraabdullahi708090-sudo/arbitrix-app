'use strict';

/**
 * PRODUCTION DEPOSIT UX — Demo-mode deposit flow tests.
 *
 * Requirement: a Demo-mode user must be able to OPEN the deposit modal (instead
 * of only being told to switch modes), see a clear virtual-funds notice with the
 * deposit requirements and a "Switch to Live & Continue" CTA, and then create
 * the real payment invoice after switching — all without reopening the tab.
 *
 * Pins (frontend-only, public/index.html):
 *   1. Demo user CAN open the deposit modal (production).
 *   2. Demo user CANNOT create a payment invoice until they switch to Live.
 *   3. Switching to Live from inside the modal keeps the modal open and the
 *      deposit flow (invoice creation) continues.
 *   4. Opening the modal or switching modes credits NOTHING and makes no
 *      payment/sync request.
 *   5. MARKETING_SANDBOX behavior is unchanged (Demo -> toast, no modal).
 *   6. UI distinguishes demo/virtual balance, live/real balance, deposited
 *      funds and the promotional credit.
 *   7. Production provider safeguards are untouched.
 *   8. i18n parity across all 6 locales (including the new keys).
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

const NEW_KEYS = [
    'deposit.demoNotice.title',
    'deposit.demoNotice.body',
    'deposit.demoNotice.realNote',
    'deposit.demoNotice.balancesTitle',
    'deposit.demoNotice.demoBalance',
    'deposit.demoNotice.liveBalance',
    'deposit.demoNotice.depositedFunds',
    'deposit.demoNotice.depositedYes',
    'deposit.demoNotice.depositedNo',
    'deposit.demoNotice.promoCredit',
    'deposit.demoNotice.promoActive',
    'deposit.demoNotice.promoNone',
    'deposit.demoNotice.requirementsTitle',
    'deposit.demoNotice.req',
    'deposit.demoNotice.switchCta',
    'deposit.liveNotice.title',
    'deposit.liveNotice.body',
];

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

// Extract a top-level function body by brace matching. Preserves an `async `
// prefix (requestDepositAddress is async) so the extracted source stays valid.
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

/**
 * Build a vm sandbox with the REAL deposit/mode functions and a mock DOM.
 * All side effects (fetch, toast) are recorded so the tests can assert that
 * nothing was credited and no request was made.
 */
function buildSandbox({ mode = 'demo', environment = 'PRODUCTION', botRunning = false } = {}) {
    const els = {};
    const fetchCalls = [];
    const toasts = [];
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
        mode,
        environment,
        botRunning,
        currentWallet: mode === 'demo' ? 'demo' : 'live',
        demoData: { balance: 1000 },
        liveData: { balance: 50, hasRealDeposit: false, promoCreditFunded: true },
        bonusData: { balance: 0 },
        MIN_DEPOSIT: 100,
        MTA: 200,
        txViewExpanded: false,
    };

    const sandbox = {
        APP, els, fetchCalls, toasts, el,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        window: {},
        localStorage: { getItem: () => 'test-token', setItem: () => {}, removeItem: () => {} },
        clearInterval: () => {},
        setInterval: () => {},
        document: { getElementById: el, querySelectorAll: () => [] },
        getEl: el,
        t: (k) => k,
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
    };
    vm.createContext(sandbox);

    const src = [
        'let paymentPollingInterval = null; let countdownInterval = null; let currentInvoiceId = null; let currentCurrency = "USDT"; let currentNetwork = "TRC20";',
        extractFunction('setMode'),
        extractFunction('updateDepositMinNotice'),
        extractFunction('refreshDepositModeNotice'),
        extractFunction('resetDepositModal'),
        extractFunction('openDepositModal'),
        extractFunction('switchToLiveAndContinueDeposit'),
        extractFunction('requestDepositAddress'),
    ].join('\n');
    vm.runInContext(src, sandbox);
    return sandbox;
}

async function run(sandbox, code) {
    const p = vm.runInContext(code, sandbox);
    if (p && typeof p.then === 'function') await p;
    return p;
}

test('Demo user CAN open the deposit modal (production)', async () => {
    const sb = buildSandbox({ mode: 'demo', environment: 'PRODUCTION' });
    await run(sb, 'openDepositModal()');

    assert.ok(sb.els.depositModal.classList.contains('open'), 'deposit modal must be open in Demo mode');
    assert.strictEqual(sb.els.depositDemoNotice.style.display, 'block', 'demo notice must be visible');
    assert.strictEqual(sb.els.depositLiveNotice.style.display, 'none', 'live notice must be hidden in Demo');
    assert.strictEqual(sb.els.getAddressBtn.style.display, 'none', 'invoice button hidden while in Demo');
    assert.strictEqual(sb.toasts.length, 0, 'opening the modal must NOT show the "switch to LIVE" toast');
    assert.strictEqual(sb.fetchCalls.length, 0, 'opening the modal must not make any request');
});

test('Demo notice explains virtual funds, requirements, and shows a Switch CTA', async () => {
    const sb = buildSandbox({ mode: 'demo', environment: 'PRODUCTION' });
    await run(sb, 'openDepositModal()');

    // Balance breakdown populated from APP (demo/virtual vs live/real).
    assert.strictEqual(sb.els.depositDemoBalance.textContent, '$1000.00');
    assert.strictEqual(sb.els.depositLiveBalance.textContent, '$50.00');
    // Deposited funds + promotional credit are distinguished (booleans, no invented amounts).
    assert.strictEqual(sb.els.depositFundedStatus.textContent, 'deposit.demoNotice.depositedNo');
    assert.strictEqual(sb.els.depositPromoStatus.textContent, 'deposit.demoNotice.promoActive');
    // Requirements text rendered with the dynamic minimum.
    assert.strictEqual(sb.els.depositDemoReqText.textContent, 'deposit.demoNotice.req');
    // Source-level: the copy actually mentions the min placeholder and the CTA.
    assert.ok(INDEX.includes('onclick="switchToLiveAndContinueDeposit()"'), 'Switch CTA must be wired');
    assert.ok(/data-i18n="deposit\.demoNotice\.req"/.test(INDEX) === false, 'req is rendered dynamically (min interpolation)');
    assert.ok(INDEX.includes('id="depositDemoReqText"'), 'req text element must exist');
});

test('Demo user CANNOT create an invoice until switching to Live', async () => {
    const sb = buildSandbox({ mode: 'demo', environment: 'PRODUCTION' });
    sb.el('liveDepositAmount').value = '150';
    await run(sb, 'openDepositModal()');

    // Attempt while still in Demo -> blocked, no request.
    await run(sb, 'requestDepositAddress()');
    assert.strictEqual(sb.fetchCalls.length, 0, 'no invoice request may be made from Demo mode');
    assert.strictEqual(sb.toasts.at(-1)[0], 'deposit.switchToLive', 'Demo attempt must inform the user to switch');

    // Switch to Live, then the same action creates the real invoice.
    await run(sb, 'switchToLiveAndContinueDeposit()');
    assert.strictEqual(sb.APP.mode, 'live');
    await run(sb, 'requestDepositAddress()');
    assert.strictEqual(sb.fetchCalls.length, 1, 'exactly one invoice request after switching');
    assert.ok(sb.fetchCalls[0].includes('/api/payment/create-invoice'), 'must use the existing provider invoice endpoint');
});

test('Switching to Live from the modal preserves the deposit flow (modal stays open)', async () => {
    const sb = buildSandbox({ mode: 'demo', environment: 'PRODUCTION' });
    sb.el('liveDepositAmount').value = '250';
    await run(sb, 'openDepositModal()');
    assert.ok(sb.els.depositModal.classList.contains('open'));

    await run(sb, 'switchToLiveAndContinueDeposit()');

    assert.strictEqual(sb.APP.mode, 'live', 'session switched to LIVE');
    assert.strictEqual(sb.APP.currentWallet, 'live', 'live wallet selected');
    assert.ok(sb.els.depositModal.classList.contains('open'), 'modal must remain open after switching');
    assert.strictEqual(sb.els.depositDemoNotice.style.display, 'none', 'demo notice hidden after switching');
    assert.strictEqual(sb.els.depositLiveNotice.style.display, 'block', 'live notice shown after switching');
    assert.strictEqual(sb.els.getAddressBtn.style.display, 'block', 'invoice button enabled after switching');
    assert.strictEqual(sb.els.liveDepositAmount.value, '250', 'entered amount is preserved across the switch');
    // Deposit flow continues without reopening the modal.
    await run(sb, 'requestDepositAddress()');
    assert.strictEqual(sb.fetchCalls.length, 1, 'invoice can be created right after switching');
});

test('Opening the modal or switching modes credits NOTHING', async () => {
    const sb = buildSandbox({ mode: 'demo', environment: 'PRODUCTION' });
    const before = {
        demo: sb.APP.demoData.balance,
        live: sb.APP.liveData.balance,
        bonus: sb.APP.bonusData.balance,
    };
    await run(sb, 'openDepositModal()');
    await run(sb, 'switchToLiveAndContinueDeposit()');

    assert.strictEqual(sb.APP.demoData.balance, before.demo, 'demo balance must not change');
    assert.strictEqual(sb.APP.liveData.balance, before.live, 'live balance must not change');
    assert.strictEqual(sb.APP.bonusData.balance, before.bonus, 'bonus balance must not change');
    assert.strictEqual(sb.fetchCalls.length, 0, 'no deposit/credit request may fire on open or switch');
    // Source: the switch helper performs no balance mutation.
    const sw = extractFunction('switchToLiveAndContinueDeposit');
    assert.ok(!/balance\s*\+?=|updateWallet|credit/i.test(sw), 'switch helper must not credit/mutate balances');
});

test('MARKETING_SANDBOX behavior is unchanged (Demo -> toast, no modal)', async () => {
    const sb = buildSandbox({ mode: 'demo', environment: 'MARKETING_SANDBOX' });
    await run(sb, 'openDepositModal()');

    assert.ok(!sb.el('depositModal').classList.contains('open'), 'sandbox demo must NOT open the modal');
    assert.strictEqual(sb.toasts.at(-1)[0], 'deposit.switchToLive', 'sandbox demo keeps the existing toast');
    assert.strictEqual(sb.fetchCalls.length, 0, 'sandbox demo makes no request');

    const fn = extractFunction('openDepositModal');
    assert.ok(/APP\.environment === 'MARKETING_SANDBOX' && APP\.mode === 'demo'/.test(fn),
        'sandbox must be short-circuited before the new demo-modal behavior');
    // The sandbox recordRequest branch in the server is untouched.
    assert.ok(SERVER.includes('handleSandboxInvoiceCreate'), 'sandbox invoice branch must remain wired');
});

test('UI copy distinguishes demo/virtual, live/real, deposited funds and promo credit', () => {
    const T = loadTranslations();
    const en = T.en;
    assert.ok(/Demo \/ virtual balance/i.test(en['deposit.demoNotice.demoBalance']));
    assert.ok(/Live \/ real balance/i.test(en['deposit.demoNotice.liveBalance']));
    assert.ok(/Deposited funds/i.test(en['deposit.demoNotice.depositedFunds']));
    assert.ok(/Promotional credit/i.test(en['deposit.demoNotice.promoCredit']));
    assert.ok(/virtual\/demo/i.test(en['deposit.demoNotice.body']));
    assert.ok(/LIVE/i.test(en['deposit.demoNotice.realNote']));
});

test('production provider safeguards are unchanged', () => {
    // Minimum deposit + the single-source platform minimum are untouched.
    assert.ok(/const PLATFORM_MIN_DEPOSIT_USD = 100;/.test(SERVER), 'platform minimum must stay $100');
    assert.ok(/MIN_DEPOSIT: 100/.test(INDEX), 'frontend minimum must stay 100');
    // Invoice creation still goes through the provider service.
    assert.ok(SERVER.includes("paymentService.createInvoice("), 'provider invoice creation must remain');
    // The new guard is display-only and comes BEFORE the amount read in the UI.
    const fn = extractFunction('requestDepositAddress');
    const guardIdx = fn.indexOf("if (APP.mode === 'demo')");
    const amountIdx = fn.indexOf('liveDepositAmount');
    assert.ok(guardIdx >= 0 && guardIdx < amountIdx, 'demo guard must run before any amount/invoice work');
});

test('i18n parity: new keys exist and key sets are identical across 6 locales', () => {
    const T = loadTranslations();
    const enKeys = Object.keys(T.en);
    assert.strictEqual(enKeys.length, 1391, 'expected 1391 keys per locale');
    for (const [lang, dict] of Object.entries(T)) {
        assert.deepStrictEqual(new Set(Object.keys(dict)), new Set(enKeys), `${lang} key set differs`);
        for (const k of enKeys) assert.ok(String(dict[k]).length > 0, `${lang}.${k} empty`);
        for (const k of NEW_KEYS) assert.ok(dict[k], `${lang}.${k} missing`);
        assert.ok(dict['deposit.demoNotice.req'].includes('{{min}}'), `${lang} req must keep the {{min}} placeholder`);
    }
});
