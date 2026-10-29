'use strict';

/**
 * Demo-to-Live deposit journey + external USDT purchase route.
 *
 * These tests drive the REAL functions from public/index.html in a vm sandbox
 * with a mock DOM, so they prove behaviour (what is visible, what is requested)
 * rather than merely grepping strings. No request is ever made and no balance
 * can move: every collaborator is a stub that records calls.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_PATH = path.join(__dirname, '..', 'public', 'index.html');
const INDEX = fs.readFileSync(INDEX_PATH, 'utf8');

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist in public/index.html');
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

function buildSandbox({ mode = 'demo', environment = 'PRODUCTION', providerUrl = '' } = {}) {
    const els = {};
    const fetchCalls = [];
    const toasts = [];

    function makeEl(id) {
        const node = {
            id, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
            disabled: false, classes: new Set(), scrollTop: 0, attrs: {},
            focus: () => {}, dispatchEvent: () => {},
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
        node.setAttribute = (k, v) => { node.attrs[k] = String(v); };
        node.getAttribute = (k) => (k in node.attrs ? node.attrs[k] : null);
        node.removeAttribute = (k) => { delete node.attrs[k]; };
        return node;
    }
    const el = (id) => (els[id] || (els[id] = makeEl(id)));

    const APP = {
        mode,
        environment,
        botRunning: false,
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
        window: { ARBITRIX_BUY_CRYPTO_URL: providerUrl },
        localStorage: { getItem: () => 'test-token', setItem: () => {}, removeItem: () => {} },
        clearInterval: () => {},
        setInterval: () => {},
        document: {
            getElementById: el,
            querySelector: () => null,
            querySelectorAll: () => [],
        },
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
        setButtonLoading: () => {},
        loadDepositOptions: () => {},
        updateFirstDepositCta: () => {},
        updateDepositReferenceBox: () => {},
        startPollingForPayment: () => {},
        fetch: async (url) => {
            fetchCalls.push(String(url));
            return { ok: true, json: async () => ({ success: true, invoice: { id: 'inv_test' } }) };
        },
    };
    vm.createContext(sandbox);

    const src = [
        'let paymentPollingInterval = null; let countdownInterval = null; let currentInvoiceId = null;',
        'let currentCurrency = "USDT"; let currentNetwork = "TRC20";',
        'let depositOptionState = { partners: [], partnersAvailable: true, crypto: null, selected: "crypto" };',
        'function currentCachedUser(){ return null; }',
        'function setMode(m){ APP.mode = m; APP.currentWallet = (m === "demo") ? "demo" : "live"; }',
        extractFunction('refreshDepositModeNotice'),
        extractFunction('applyDepositModeVisibility'),
        extractFunction('selectDepositOption'),
        extractFunction('updateDepositWalletPanel'),
        extractFunction('resolveBuyCryptoUrl'),
        extractFunction('focusWithoutScroll'),
        extractFunction('focusDepositAmount'),
        extractFunction('updateDepositMinNotice'),
        extractFunction('setExactAmountInstruction'),
        extractFunction('resetDepositModal'),
        extractFunction('openDepositModal'),
        extractFunction('switchToLiveAndContinueDeposit'),
    ].join('\n');
    vm.runInContext(src, sandbox);
    return sandbox;
}

const visible = (sb, id) => sb.el(id).style.display !== 'none';

test('Demo mode hides every real-funding control', () => {
    const sb = buildSandbox({ mode: 'demo' });
    vm.runInContext('openDepositModal()', sb);

    // The explanation and the switch action are the ONLY content.
    assert.ok(visible(sb, 'depositDemoNotice'), 'demo notice visible');
    assert.ok(!visible(sb, 'depositLiveNotice'), 'live notice hidden');
    assert.ok(!visible(sb, 'depositOptions'), 'funding-method cards hidden');
    assert.ok(!visible(sb, 'depositCryptoFlow'), 'network details + amount form hidden');
    assert.ok(!visible(sb, 'depositWalletPanel'), 'external purchase panel hidden');
    assert.ok(!visible(sb, 'depositPartnerPanel'), 'partner panel hidden');
    assert.ok(!visible(sb, 'getAddressBtn'), 'deposit generation hidden');
    assert.strictEqual(sb.fetchCalls.length, 0, 'opening the modal must not create an invoice');
    assert.strictEqual(sb.toasts.length, 0, 'no toast replaces the modal');
});

test('Demo mode keeps the amount input and network banner out of the DOM flow', () => {
    const sb = buildSandbox({ mode: 'demo' });
    vm.runInContext('openDepositModal()', sb);
    // Both containers own those controls; hiding them is what keeps a demo user
    // from being told they can fund a demo balance with a real deposit.
    assert.strictEqual(sb.el('depositCryptoFlow').style.display, 'none');
    assert.strictEqual(sb.el('depositOptions').style.display, 'none');
});

test('Switching to Live from the modal reveals the funding methods', () => {
    const sb = buildSandbox({ mode: 'demo' });
    vm.runInContext('openDepositModal()', sb);
    vm.runInContext('switchToLiveAndContinueDeposit()', sb);

    assert.strictEqual(sb.APP.mode, 'live', 'mode switched to Live');
    assert.ok(sb.el('depositModal').classList.contains('open'), 'the dialog stays open');
    assert.ok(visible(sb, 'depositOptions'), 'funding methods revealed');
    assert.ok(visible(sb, 'depositCryptoFlow'), 'deposit form revealed');
    assert.ok(!visible(sb, 'depositDemoNotice'), 'demo notice hidden');
    assert.ok(visible(sb, 'depositLiveNotice'), 'live notice shown');
    assert.strictEqual(sb.el('depositModalContent').scrollTop, 0, 'no scroll jump on switch');
    assert.strictEqual(sb.fetchCalls.length, 0, 'switching alone creates no invoice');
});

test('Reopening in Demo hides the routes again, and reopening in Live restores them', () => {
    const sb = buildSandbox({ mode: 'live' });
    vm.runInContext('openDepositModal()', sb);
    assert.ok(visible(sb, 'depositOptions'));

    sb.APP.mode = 'demo';                       // user switches back
    vm.runInContext('openDepositModal()', sb);  // and reopens
    assert.ok(!visible(sb, 'depositOptions'));
    assert.ok(visible(sb, 'depositDemoNotice'));

    sb.APP.mode = 'live';
    vm.runInContext('openDepositModal()', sb);
    assert.ok(visible(sb, 'depositOptions'));
    assert.ok(visible(sb, 'depositCryptoFlow'));
});

test('the selected route survives a Demo/Live round trip', () => {
    const sb = buildSandbox({ mode: 'live' });
    vm.runInContext('openDepositModal()', sb);
    vm.runInContext("selectDepositOption('partner')", sb);
    assert.ok(visible(sb, 'depositPartnerPanel'));
    assert.ok(!visible(sb, 'depositCryptoFlow'));

    sb.APP.mode = 'demo';
    vm.runInContext('refreshDepositModeNotice()', sb);
    assert.ok(!visible(sb, 'depositPartnerPanel'), 'hidden in demo');

    sb.APP.mode = 'live';
    vm.runInContext('refreshDepositModeNotice()', sb);
    assert.ok(visible(sb, 'depositPartnerPanel'), 'the partner route returns, not crypto');
    assert.ok(!visible(sb, 'depositCryptoFlow'));
});

test('MARKETING_SANDBOX keeps its unchanged simulated flow (no cards)', () => {
    const sb = buildSandbox({ mode: 'live', environment: 'MARKETING_SANDBOX' });
    vm.runInContext('openDepositModal()', sb);
    assert.ok(!visible(sb, 'depositOptions'), 'sandbox shows no funding cards');
    assert.ok(visible(sb, 'depositCryptoFlow'), 'sandbox keeps the simulated deposit form');
});

test('external purchase is a separate pathway from the direct crypto deposit', () => {
    const sb = buildSandbox({ mode: 'live' });
    vm.runInContext('openDepositModal()', sb);
    vm.runInContext("selectDepositOption('wallet')", sb);

    assert.ok(visible(sb, 'depositWalletPanel'), 'purchase panel shown');
    assert.ok(!visible(sb, 'depositCryptoFlow'), 'direct deposit form hidden');
    assert.ok(!visible(sb, 'depositPartnerPanel'), 'partner panel hidden');
    assert.strictEqual(sb.fetchCalls.length, 0, 'selecting the purchase route creates no invoice');

    vm.runInContext("selectDepositOption('crypto')", sb);
    assert.ok(visible(sb, 'depositCryptoFlow'), 'direct deposit form returns');
    assert.ok(!visible(sb, 'depositWalletPanel'));
});

test('an unconfigured provider shows an explicit unavailable state and no link', () => {
    const sb = buildSandbox({ mode: 'live', providerUrl: '' });
    vm.runInContext('openDepositModal()', sb);
    vm.runInContext("selectDepositOption('wallet')", sb);

    assert.ok(visible(sb, 'depositWalletUnavailable'), '"coming soon" state visible');
    assert.ok(!visible(sb, 'depositWalletProviderReady'), 'no ready block');
    const link = sb.el('depositBuyCryptoLink');
    assert.strictEqual(link.style.display, 'none', 'link hidden');
    assert.ok(!('href' in link.attrs), 'no href is ever attached');
    assert.strictEqual(sb.fetchCalls.length, 0, 'never falls back to creating an invoice');
});

test('a configured HTTPS provider is wired into the ready block', () => {
    const url = 'https://pay.example.com/buy?asset=USDT';
    const sb = buildSandbox({ mode: 'live', providerUrl: url });
    vm.runInContext('openDepositModal()', sb);
    vm.runInContext("selectDepositOption('wallet')", sb);

    assert.ok(!visible(sb, 'depositWalletUnavailable'), 'coming-soon hidden');
    assert.ok(visible(sb, 'depositWalletProviderReady'), 'ready block visible');
    const link = sb.el('depositBuyCryptoLink');
    assert.strictEqual(link.attrs.href, url);
    assert.strictEqual(link.style.display, 'block');
    assert.strictEqual(sb.fetchCalls.length, 0, 'the provider is opened, not called server-side');
});

test('non-HTTPS or malformed destinations are treated as unconfigured', () => {
    for (const bad of ['http://pay.example.com/buy', 'javascript:alert(1)', 'pay.example.com', 'ftp://x/y', '   ']) {
        const sb = buildSandbox({ mode: 'live', providerUrl: bad });
        vm.runInContext('openDepositModal()', sb);
        vm.runInContext("selectDepositOption('wallet')", sb);
        assert.ok(visible(sb, 'depositWalletUnavailable'), bad + ' must stay unavailable');
        assert.ok(!('href' in sb.el('depositBuyCryptoLink').attrs), bad + ' must not produce an href');
    }
});

test('the provider destination is configurable in exactly one place', () => {
    const metas = INDEX.match(/<meta name="arbitrix-buy-crypto" content="([^"]*)">/g) || [];
    assert.strictEqual(metas.length, 1, 'a single configurable meta');
    assert.strictEqual((INDEX.match(/<meta name="arbitrix-buy-crypto" content="([^"]*)">/) || [])[1], '',
        'no provider is configured yet (no vendor is approved)');
    assert.match(extractFunction('resolveBuyCryptoUrl'), /ARBITRIX_BUY_CRYPTO_URL/,
        'a runtime override exists for a future approved provider');
    assert.ok(extractFunction('resolveBuyCryptoUrl').includes('^https:'),
        'only an https URL is ever accepted');
});

test('the new copy exists and is translated in all six locales', () => {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx);
    let depth = 0, end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + '; this.T = TRANSLATIONS;', ctx);
    const T = ctx.T;

    const keys = [
        'deposit.demoNotice.afterSwitch',
        'deposit.wallet.unavailable.title',
        'deposit.wallet.unavailable.body',
        'deposit.wallet.destinationTitle',
        'deposit.wallet.destinationBody',
    ];
    const locales = Object.keys(T);
    assert.deepStrictEqual(locales.sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
    for (const locale of locales) {
        for (const key of keys) {
            assert.ok(String(T[locale][key] || '').trim(), locale + ' missing ' + key);
            if (locale !== 'en') {
                assert.notStrictEqual(T[locale][key], T.en[key], locale + ' ' + key + ' is still English');
            }
        }
    }
    // The purchase copy never claims one country or one provider.
    for (const locale of locales) {
        const copy = keys.map((k) => String(T[locale][k])).join(' | ');
        assert.ok(!/nigeria|south africa|naira|rand\b/i.test(copy), locale + ' must stay country-neutral');
        assert.ok(!/trust ?wallet|binance|moonpay|ramp network|mercuryo|banxa|transak|paybis/i.test(copy),
            locale + ' must not name an unapproved provider');
    }
});

test('deposit safeguards are untouched by this change', () => {
    // Minimum deposit, asset and network are unchanged.
    assert.match(INDEX, /MIN_DEPOSIT:\s*100/);
    assert.match(INDEX, /MIN_WITHDRAWAL:\s*700/);
    const cryptoFlow = INDEX.slice(INDEX.indexOf('id="depositCryptoFlow"'),
        INDEX.indexOf('id="depositPaymentSection"'));
    assert.match(cryptoFlow, /USDT/);
    assert.match(cryptoFlow, /TRON \(TRC20\)/);
    // The purchase route can never create an invoice or credit a balance.
    const walletPanel = INDEX.slice(INDEX.indexOf('id="depositWalletPanel"'),
        INDEX.indexOf('THE EXISTING CRYPTO DEPOSIT FLOW'));
    assert.ok(!/requestDepositAddress/.test(walletPanel), 'no invoice creation from the purchase route');
    assert.ok(!/credit_payment|creditPayment|record_trade_safe|updateWallet\(|balance\s*\+=/.test(walletPanel),
        'no crediting path');

    // The server's deposit verification path is not touched by this change.
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /PLATFORM_MIN_DEPOSIT_USD = 100/);
    assert.match(server, /credit_payment_safe/);
    assert.match(server, /paymento_credit_user_safe/);
});
