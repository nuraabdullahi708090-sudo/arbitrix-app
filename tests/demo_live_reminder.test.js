'use strict';

/**
 * DEMO -> LIVE REMINDER — tests.
 *
 * The in-Demo "Ready for real trading?" card exists to remind a user exploring
 * Demo that Live Mode is available. It must never nag or interrupt: it waits for
 * meaningful demo activity, stays away while the bot is trading, respects a
 * dismissal for the session and is rate limited.
 *
 * Pins:
 *   - only production accounts, only in Demo, only without a confirmed deposit;
 *   - only after meaningful demo activity (>= DEMO_CTA_MIN_TRADES);
 *   - never while the bot is running, and never re-raised on every trade;
 *   - dismissal is respected for the rest of the session;
 *   - the reminder is a dismissible banner, never a modal, and by itself it
 *     starts no deposit, invoice, trade or mode change;
 *   - it states that demo funds are virtual and cannot be withdrawn (the
 *     second "Live Mode uses real funds..." paragraph was removed by an
 *     approved UI change, so it must stay gone).
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

function buildSandbox({ mode = 'demo', environment = 'PRODUCTION', funded = false, trades = 0, botRunning = false, dismissed = false } = {}) {
    const els = {};
    const toasts = [];
    const setModeCalls = [];
    const fetchCalls = [];
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
    el('depositModal');

    const APP = {
        mode, environment, botRunning,
        demoData: { trades },
        liveData: { hasRealDeposit: funded },
    };
    const sandbox = {
        APP, els, el, toasts, setModeCalls, fetchCalls,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        document: { getElementById: el, querySelectorAll: () => [] },
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
        'var DEMO_CTA_MIN_TRADES = 3;',
        'var DEMO_CTA_REMINDER_INTERVAL_MS = 10 * 60 * 1000;',
        extractFunction('updateDemoFirstDepositCta'),
        extractFunction('dismissDemoDepositCta'),
        extractFunction('reviewLiveRequirements'),
    ].join('\n'), sandbox);
    return sandbox;
}

const visible = (sb) => !sb.els.demoFirstDepositCta.classes.has('hidden');

test('the reminder only appears in production Demo mode', () => {
    const live = buildSandbox({ mode: 'live', trades: 25 });
    vm.runInContext('updateDemoFirstDepositCta()', live);
    assert.ok(!visible(live), 'never shown in Live mode');

    const sandbox = buildSandbox({ environment: 'MARKETING_SANDBOX', trades: 25 });
    vm.runInContext('updateDemoFirstDepositCta()', sandbox);
    assert.ok(!visible(sandbox), 'never shown to a marketing sandbox account');
});

test('the reminder is withheld once the account is funded', () => {
    const sb = buildSandbox({ funded: true, trades: 25 });
    vm.runInContext('updateDemoFirstDepositCta()', sb);
    assert.ok(!visible(sb), 'no reminder needed after a confirmed deposit');
});

test('the reminder waits for meaningful demo activity (never "every trade")', () => {
    const sb = buildSandbox({ trades: 0 });
    vm.runInContext('updateDemoFirstDepositCta()', sb);
    assert.ok(!visible(sb), 'not shown on entering Demo with no activity');

    sb.APP.demoData.trades = 1;
    vm.runInContext('updateDemoFirstDepositCta()', sb);
    assert.ok(!visible(sb), 'not shown after a single demo trade');

    sb.APP.demoData.trades = 2;
    vm.runInContext('updateDemoFirstDepositCta()', sb);
    assert.ok(!visible(sb), 'not shown after two demo trades');

    sb.APP.demoData.trades = 3;
    vm.runInContext('updateDemoFirstDepositCta()', sb);
    assert.ok(visible(sb), 'shown once the user has meaningful demo activity');

    assert.strictEqual(vm.runInContext('DEMO_CTA_MIN_TRADES', sb), 3, 'threshold is documented');
});

test('the reminder stays away while the bot is trading', () => {
    const sb = buildSandbox({ trades: 10, botRunning: true });
    vm.runInContext('updateDemoFirstDepositCta()', sb);
    assert.ok(!visible(sb), 'never interrupt an active demo session');
});

test('dismissal is respected for the rest of the session', () => {
    const sb = buildSandbox({ trades: 10 });
    vm.runInContext('updateDemoFirstDepositCta()', sb);
    assert.ok(visible(sb), 'precondition: visible');

    vm.runInContext('dismissDemoDepositCta()', sb);
    assert.ok(!visible(sb), 'dismiss hides it');

    sb.APP.demoData.trades = 40;
    vm.runInContext('updateDemoFirstDepositCta()', sb);
    assert.ok(!visible(sb), 'more activity must not re-raise a dismissed reminder');
});

test('a hidden reminder is rate limited before it can reappear', () => {
    const sb = buildSandbox({ trades: 10 });
    vm.runInContext('updateDemoFirstDepositCta()', sb);
    assert.ok(visible(sb), 'precondition: first display');

    // The bot starts, which hides the banner.
    sb.APP.botRunning = true;
    vm.runInContext('updateDemoFirstDepositCta()', sb);
    assert.ok(!visible(sb), 'hidden while the bot runs');

    // Immediately after the bot stops, it must NOT pop straight back.
    sb.APP.botRunning = false;
    vm.runInContext('updateDemoFirstDepositCta()', sb);
    assert.ok(!visible(sb), 'rate limited immediately after being hidden');

    // Once the interval has elapsed it may be shown again.
    vm.runInContext('demoCtaLastShownAt = Date.now() - (11 * 60 * 1000);', sb);
    vm.runInContext('updateDemoFirstDepositCta()', sb);
    assert.ok(visible(sb), 'may reappear after the interval elapses');
    assert.strictEqual(vm.runInContext('DEMO_CTA_REMINDER_INTERVAL_MS', sb), 600000, 'interval is 10 minutes');
});

test('the reminder is a dismissible banner and never acts on its own', () => {
    const sb = buildSandbox({ trades: 10 });
    vm.runInContext('updateDemoFirstDepositCta()', sb);
    assert.strictEqual(sb.fetchCalls.length, 0, 'rendering makes no request');
    assert.strictEqual(sb.setModeCalls.length, 0, 'rendering never switches mode');
    assert.strictEqual(sb.toasts.length, 0, 'rendering never toasts');

    // It is a banner element, not a modal overlay.
    const at = INDEX.indexOf('id="demoFirstDepositCta"');
    const tag = INDEX.slice(INDEX.lastIndexOf('<', at), INDEX.indexOf('>', at) + 1);
    assert.ok(/^<div\b/.test(tag), 'must be a plain div banner');
    assert.ok(/class="hidden"/.test(tag), 'starts hidden');
    assert.ok(!/modal-overlay/.test(tag), 'must not be a blocking modal');

    // The banner explains demo funds are virtual and cannot be withdrawn.
    // The former second paragraph ("Live Mode uses real funds...") was removed
    // by an approved UI change and must not come back.
    const block = INDEX.slice(at, INDEX.indexOf('</div>', INDEX.indexOf('demoCta.later', at)));
    assert.ok(!/data-i18n="demoCta\.risk"/.test(block), 'removed risk paragraph must not return');
    assert.ok(/data-i18n="demoCta\.body"/.test(block), 'virtual-funds paragraph present');
    assert.ok(/data-i18n="demoCta\.title"/.test(block), 'heading present');
    assert.ok(/data-i18n="demoCta\.button"/.test(block), 'primary deposit action present');
    assert.ok(/data-i18n="demoCta\.reviewLive"/.test(block), 'review action present');
    assert.ok(/onclick="dismissDemoDepositCta\(\)"/.test(block), 'dismiss action present');
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
    // The retained copy still tells the beginner what demo funds are.
    assert.ok(/virtual/i.test(T.en['demoCta.body']), 'EN body must clarify demo funds are virtual');
    assert.ok(/cannot be withdrawn/i.test(T.en['demoCta.body']), 'EN body must say demo funds cannot be withdrawn');
    for (const l of locales) {
        for (const k of ['demoCta.title', 'demoCta.body', 'demoCta.button', 'demoCta.reviewLive', 'demoCta.reviewLiveToast', 'demoCta.later']) {
            assert.ok(String(T[l][k] || '').trim().length > 0, k + ' missing for ' + l);
        }
    }
});

test('"Review Live Requirements" only shows the Live view - no deposit, no invoice', () => {
    const sb = buildSandbox({ trades: 10 });
    vm.runInContext('reviewLiveRequirements()', sb);
    assert.deepStrictEqual(sb.setModeCalls, ['live'], 'reuses the existing review-only Live entry');
    assert.strictEqual(sb.fetchCalls.length, 0, 'makes no request');
    assert.strictEqual(sb.toasts.length, 1, 'explains what happened');
    assert.strictEqual(sb.toasts[0][0], 'demoCta.reviewLiveToast');

    const fn = extractFunction('reviewLiveRequirements');
    assert.ok(!/openDepositModal|requestDepositAddress|submitWithdraw/.test(fn), 'must not start a money flow');
    assert.ok(!/\bAPP\.(liveData|demoData)\b/.test(fn), 'must not touch balances');
});
