'use strict';

/**
 * FIRST-DEPOSIT REMINDER ("Ready for real trading?") - tests.
 *
 * The card is the dashboard's nudge toward funding. It must be useful to a new
 * customer and must never nag or interrupt.
 *
 * Contract pinned here:
 *   - production accounts only (never MARKETING_SANDBOX), never once funded;
 *   - DEMO MODE ONLY: the card's copy talks about exploring with virtual funds,
 *     which is only true there. A Live-but-unfunded account is prompted by its
 *     own wallet card (balance, Deposit Funds, activation notice);
 *   - NO demo-trading prerequisite: requiring trades hid the funding path from
 *     exactly the customers who never trade first;
 *   - never while the bot is trading, and never while the deposit flow is
 *     active (dialog open or an invoice already generated);
 *   - a per-account dismissal recorded by an earlier build is still honoured, so
 *     nobody who already dismissed the card sees it again;
 *   - a hidden reminder is rate limited before it can reappear;
 *   - the card is a passive banner, never a modal, and by itself it starts no
 *     deposit, invoice, trade or mode change;
 *   - ONE paragraph of copy and ONE action (the deposit CTA).
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

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

function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx), depth = 0, end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

function buildSandbox({ mode = 'demo', environment = 'PRODUCTION', funded = false, trades = 0,
    botRunning = false, dismissed = false, storedDismissed = false, modalOpen = false, invoiceId = null } = {}) {
    const els = {};
    const toasts = [];
    const setModeCalls = [];
    const fetchCalls = [];
    const store = {};
    if (storedDismissed) store['arbi_firstdeposit_dismissed_4242'] = '1';
    function makeEl(id) {
        const node = { id, style: {}, dataset: {}, textContent: '', innerHTML: '', classes: new Set() };
        node.classList = {
            add: (c) => node.classes.add(c),
            remove: (c) => node.classes.delete(c),
            contains: (c) => node.classes.has(c),
            toggle: (c, force) => { const on = force === undefined ? !node.classes.has(c) : !!force; if (on) node.classes.add(c); else node.classes.delete(c); },
        };
        return node;
    }
    const el = (id) => els[id] || (els[id] = makeEl(id));
    el('demoFirstDepositCta').classes.add('hidden'); // matches the shipped markup (class="hidden")
    if (modalOpen) el('depositModal').classes.add('open');

    const APP = {
        mode, environment, botRunning,
        demoData: { trades },
        liveData: { hasRealDeposit: funded },
    };
    const sandbox = {
        APP, els, el, toasts, setModeCalls, fetchCalls, store,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        document: { getElementById: el, querySelectorAll: () => [] },
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; },
        },
        currentCachedUser: () => ({ id: 4242, name: 'Dev' }),
        t: (k) => k,
        showToast: (...a) => toasts.push(a),
        fetch: async (u) => { fetchCalls.push(String(u)); return { ok: true, json: async () => ({}) }; },
        setMode: (m) => { setModeCalls.push(m); APP.mode = m; },
        openDepositModal: () => { throw new Error('reminder must not open the deposit flow by itself'); },
    };
    vm.createContext(sandbox);
    vm.runInContext([
        'var demoDepositCtaDismissed = ' + (dismissed ? 'true' : 'false') + ';',
        'var demoCtaLastShownAt = 0;',
        'var firstDepositCtaSuppressed = false;',
        'var currentInvoiceId = ' + (invoiceId ? JSON.stringify(invoiceId) : 'null') + ';',
        'var DEMO_CTA_REMINDER_INTERVAL_MS = 10 * 60 * 1000;',
        'var FIRST_DEPOSIT_DISMISS_PREFIX = "arbi_firstdeposit_dismissed_";',
        extractFunction('firstDepositDismissKey'),
        extractFunction('isFirstDepositCtaDismissed'),
        extractFunction('updateAvailableDepositButton'),
        extractFunction('updateFirstDepositCta'),
        extractFunction('updateDemoFirstDepositCta'),
        extractFunction('dismissDemoDepositCta'),
    ].join('\n'), sandbox);
    return sandbox;
}

const visible = (sb) => !sb.els.demoFirstDepositCta.classes.has('hidden');

/** The card's own markup, bounded by the next dashboard section. */
function carCard() {
    const at = INDEX.indexOf('id="demoFirstDepositCta"');
    assert.ok(at > 0, 'the card must exist');
    // The card is immediately followed by the equity chart section.
    const end = INDEX.indexOf('class="chart-card"', at);
    assert.ok(end > at, 'the card slice must be bounded');
    return INDEX.slice(at, end);
}

function extractFunctionSafely(name) {
    const at = INDEX.indexOf('function ' + name + '(');
    return at < 0 ? undefined : INDEX.slice(at, at + 200);
}

test('the reminder appears for an unfunded PRODUCTION account in DEMO mode', () => {
    const demo = buildSandbox({ mode: 'demo' });
    vm.runInContext('updateFirstDepositCta()', demo);
    assert.ok(visible(demo), 'shown in Demo (no trading prerequisite)');

    // Demo-only by design: the copy is about virtual funds. Live keeps its own
    // wallet-card prompt, which this card must not duplicate.
    const live = buildSandbox({ mode: 'live' });
    vm.runInContext('updateFirstDepositCta()', live);
    assert.ok(!visible(live), 'not shown in Live Mode');

    const sandbox = buildSandbox({ environment: 'MARKETING_SANDBOX' });
    vm.runInContext('updateFirstDepositCta()', sandbox);
    assert.ok(!visible(sandbox), 'never shown to a marketing sandbox account');
});

test('the reminder is withheld once the account is funded', () => {
    const sb = buildSandbox({ mode: 'demo', funded: true, trades: 25 });
    vm.runInContext('updateFirstDepositCta()', sb);
    assert.ok(!visible(sb), 'no reminder needed after a confirmed deposit');
});

test('no demo-trading prerequisite: a brand new account sees it immediately', () => {
    // The old gate required >= 3 demo trades (DEMO_CTA_MIN_TRADES), which hid
    // the funding path from a customer who never traded. That prerequisite is
    // gone on purpose.
    const sb = buildSandbox({ trades: 0 });
    vm.runInContext('updateFirstDepositCta()', sb);
    assert.ok(visible(sb), 'shown with zero demo activity');

    for (const n of [1, 2, 3, 40]) {
        sb.APP.demoData.trades = n;
        vm.runInContext('updateFirstDepositCta()', sb);
        assert.ok(visible(sb), 'still shown with ' + n + ' demo trades');
    }
    assert.ok(!/DEMO_CTA_MIN_TRADES/.test(INDEX), 'the trade threshold is retired, not just bypassed');
});

test('the reminder stays away while the bot is trading', () => {
    const sb = buildSandbox({ trades: 10, botRunning: true });
    vm.runInContext('updateFirstDepositCta()', sb);
    assert.ok(!visible(sb), 'never interrupt an active session');
});

test('the reminder never competes with an in-progress deposit', () => {
    // Dialog open.
    const open = buildSandbox({ modalOpen: true });
    vm.runInContext('updateFirstDepositCta()', open);
    assert.ok(!visible(open), 'hidden while the deposit dialog is open');

    // Closing the dialog brings it back (the customer may still be unfunded).
    open.els.depositModal.classes.delete('open');
    vm.runInContext('updateFirstDepositCta()', open);
    assert.ok(visible(open), 'returns after closing without a deposit');

    // Invoice already generated -> suppressed for the session.
    const invoiced = buildSandbox({ invoiceId: 'inv_123' });
    vm.runInContext('updateFirstDepositCta()', invoiced);
    assert.ok(!visible(invoiced), 'hidden while an invoice is active');

    const suppressed = buildSandbox({});
    vm.runInContext('firstDepositCtaSuppressed = true; updateFirstDepositCta();', suppressed);
    assert.ok(!visible(suppressed), 'suppressed once the customer entered the flow');
});

test('a dismissal recorded earlier is still honoured, and stays per account', () => {
    // The card no longer offers a dismiss control (product decision), but the
    // flag it used to write must keep hiding the card for anyone who dismissed
    // it under an earlier build - otherwise the change would nag them again.
    const reloaded = buildSandbox({ storedDismissed: true });
    vm.runInContext('updateFirstDepositCta()', reloaded);
    assert.ok(!visible(reloaded), 'a previously dismissed reminder stays dismissed');

    const fresh = buildSandbox({});
    vm.runInContext('updateFirstDepositCta()', fresh);
    assert.ok(visible(fresh), 'an account with no stored flag still sees it');

    // The key is scoped to the account id.
    const other = buildSandbox({});
    vm.runInContext('currentCachedUser = () => ({ id: 9999 }); updateFirstDepositCta();', other);
    assert.ok(visible(other), 'another account is unaffected by someone else\'s dismissal');
    assert.strictEqual(other.store['arbi_firstdeposit_dismissed_4242'], undefined, 'nothing written for them');
});

test('a hidden reminder is rate limited before it can reappear', () => {
    const sb = buildSandbox({ trades: 10 });
    vm.runInContext('updateFirstDepositCta()', sb);
    assert.ok(visible(sb), 'precondition: first display');

    // The bot starts, which hides the banner.
    sb.APP.botRunning = true;
    vm.runInContext('updateFirstDepositCta()', sb);
    assert.ok(!visible(sb), 'hidden while the bot runs');

    // Immediately after the bot stops, it must NOT pop straight back.
    sb.APP.botRunning = false;
    vm.runInContext('updateFirstDepositCta()', sb);
    assert.ok(!visible(sb), 'rate limited immediately after being hidden');

    // Once the interval has elapsed it may be shown again.
    vm.runInContext('demoCtaLastShownAt = Date.now() - (11 * 60 * 1000);', sb);
    vm.runInContext('updateFirstDepositCta()', sb);
    assert.ok(visible(sb), 'may reappear after the interval elapses');
    assert.strictEqual(vm.runInContext('DEMO_CTA_REMINDER_INTERVAL_MS', sb), 600000, 'interval is 10 minutes');
});

test('the copy is one paragraph, states no condition, and is localised', () => {
    const T = loadTranslations();
    const locales = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
    assert.strictEqual(T.en['demoCta.body'],
        'You are exploring with virtual funds. Activate live trading to start with real funds.');
    for (const l of locales) {
        const body = String(T[l]['demoCta.body'] || '');
        assert.ok(body.trim().length > 0, 'demoCta.body missing for ' + l);
        assert.ok(!/guarantee|risk-free/i.test(body), 'no profit promise for ' + l);
        // The removed second paragraph and the mode-swapped variant are retired.
        assert.strictEqual(T[l]['demoCta.liveBody'], undefined, 'demoCta.liveBody must be retired for ' + l);
        assert.strictEqual(T[l]['demoCta.activationNote'], undefined, 'demoCta.activationNote must be retired for ' + l);
    }
    // No amount, condition or requirement is stated on the card any more.
    assert.ok(!/\$\d/.test(T.en['demoCta.body']), 'the body quotes no amount');
});

test('the reminder is a passive banner with one action and never acts on its own', () => {
    const sb = buildSandbox({ trades: 10 });
    vm.runInContext('updateFirstDepositCta()', sb);
    assert.strictEqual(sb.fetchCalls.length, 0, 'rendering makes no request');
    assert.strictEqual(sb.setModeCalls.length, 0, 'rendering never switches mode');
    assert.strictEqual(sb.toasts.length, 0, 'rendering never toasts');

    // It is a banner element, not a modal overlay.
    const at = INDEX.indexOf('id="demoFirstDepositCta"');
    const tag = INDEX.slice(INDEX.lastIndexOf('<', at), INDEX.indexOf('>', at) + 1);
    assert.ok(/^<div\b/.test(tag), 'must be a plain div banner');
    assert.ok(/class="hidden"/.test(tag), 'starts hidden');
    assert.ok(!/modal-overlay/.test(tag), 'must not be a blocking modal');

    // The card carries ONE paragraph and ONE action.
    const block = carCard();
    assert.ok(!/data-i18n="demoCta\.risk"/.test(block), 'removed risk paragraph must not return');
    assert.ok(!/data-i18n="demoCta\.liveBody"/.test(block), 'the mode-swapped paragraph is gone');
    assert.ok(!/data-i18n="demoCta\.activationNote"/.test(block), 'the activation note is gone');
    assert.ok(/data-i18n="demoCta\.body"/.test(block), 'the single explanation is present');
    assert.ok(/data-i18n="demoCta\.title"/.test(block), 'heading present');
    assert.ok(/data-i18n="demoCta\.button"/.test(block), 'primary deposit action present');
    // The two secondary buttons were removed by product decision.
    assert.ok(!/data-i18n="demoCta\.reviewLive"/.test(block), 'no Review Live Requirements button');
    assert.ok(!/data-i18n="demoCta\.later"/.test(block), 'no Maybe later button');
    assert.strictEqual((block.match(/<button\b/g) || []).length, 1, 'exactly one button remains');
});

test('the primary action opens the EXISTING deposit flow', () => {
    const block = carCard();
    assert.ok(/onclick="openDepositModal\(\)"/.test(block), 'reuses openDepositModal()');
    assert.ok(!/requestDepositAddress|create-invoice/.test(block), 'never creates an invoice directly');
});

test('removed risk paragraph is retired in all 6 locales; card copy intact', () => {
    const T = loadTranslations();
    const locales = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
    // The approved UI change deleted the second paragraph from the card, so its
    // copy must not linger in any dictionary - a stale key would invite it back.
    for (const l of locales) {
        assert.ok(T[l], 'missing locale ' + l);
        assert.strictEqual(T[l]['demoCta.risk'], undefined, 'demoCta.risk must be retired for ' + l);
    }
    // The retained copy still says the funds are virtual (the withdrawal rule is
    // stated in the promotional-credit notice, not repeated here).
    assert.ok(/virtual/i.test(T.en['demoCta.body']), 'EN body must clarify the funds are virtual');
    for (const l of locales) {
        for (const k of ['demoCta.title', 'demoCta.body', 'demoCta.button']) {
            assert.ok(String(T[l][k] || '').trim().length > 0, k + ' missing for ' + l);
        }
        // Retired with their buttons; a stale key would invite them back.
        for (const k of ['demoCta.reviewLive', 'demoCta.reviewLiveToast', 'demoCta.later',
                         'demoCta.liveBody', 'demoCta.activationNote']) {
            assert.strictEqual(T[l][k], undefined, k + ' must be retired for ' + l);
        }
    }
    assert.strictEqual(typeof extractFunctionSafely('reviewLiveRequirements'), 'undefined',
        'the review-only handler is retired with its button');
});
