'use strict';

/**
 * HUMAN-ONLY SUPPORT - the in-app SURFACE contract.
 *
 * WHAT WAS WRONG IN PRODUCTION (investigated, reproduced in a harness)
 *   The customer used the legacy floating assistant (`#supportPanel`), not the
 *   native messenger. Three symptoms, one cause:
 *     1. its send path posted the message to the shared inbox and, because
 *        human-only support returns no automated answer, rendered
 *        `support.reply.default` ("I'm not able to answer that accurately...")
 *        with an "Open Support Center" button - a legacy automated fallback
 *        pointing at a different surface;
 *     2. that panel has no history, so after the agent replied from Telegram the
 *        customer reopened it and saw only its static welcome - the reply was
 *        stored and visible in the messenger, just not there;
 *     3. its header read "Automated".
 *
 * WHAT THIS PINS
 *   A. No surface may describe the in-app chat as automated (6 locales), and the
 *      stored-message path never renders the legacy fallback.
 *   B. A message that is already stored is handed to the messenger that shows the
 *      thread; if that cannot open, the customer gets a SYSTEM acknowledgement.
 *   C. The floating launcher opens the messenger while the feature is enabled.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function extractFunction(name) {
    const start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start !== -1, 'function ' + name + ' must exist');
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) return INDEX.slice(start, i + 1); }
    }
    throw new Error('unbalanced ' + name);
}

function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx);
    let depth = 0;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) break; }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(INDEX.slice(tIdx, i + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

const T = loadTranslations();
const HANDOVER = extractFunction('handOverToHumanSupport');
const QUEUED = extractFunction('appendSupportQueuedReply');
const SEND = extractFunction('sendSupportMessage');
const TOGGLE = extractFunction('toggleSupport');

// The legacy fallback that production showed. It must not be reachable for a
// message that was stored in the shared inbox.
const LEGACY_FALLBACK = "I'm not able to answer that accurately";

// --------------------------------------------------------------------- DOM
function makeEl(tag) {
    const classes = new Set();
    const node = {
        tagName: String(tag).toUpperCase(), children: [], parentNode: null, textContent: '',
        className: '', attrs: {}, handlers: {}, scrollTop: 0, scrollHeight: 0,
        classList: {
            add(c) { classes.add(c); },
            remove(c) { classes.delete(c); },
            contains(c) { return classes.has(c); },
            toggle(c, on) { if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else if (on) classes.add(c); else classes.delete(c); }
        },
        appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
        setAttribute(k, v) { node.attrs[k] = String(v); },
        getAttribute(k) { return node.attrs[k]; },
        addEventListener(ev, fn) { (node.handlers[ev] = node.handlers[ev] || []).push(fn); },
        get firstChild() { return node.children[0] || null; }
    };
    Object.defineProperty(node, 'className', {
        get() { return Array.from(classes).join(' '); },
        set(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); }
    });
    return node;
}

function textOf(n) {
    if (!n) return '';
    if (n.nodeType === 3) return n.text;
    return (n.children || []).map(textOf).join('');
}

// Runs the REAL helpers against a minimal DOM.
function runHandover(options) {
    const opts = options || {};
    const chat = makeEl('div');
    const legacyPanel = makeEl('div');
    legacyPanel.classList.add('open');
    let messengerOpens = 0;
    const sandbox = {
        console,
        getEl: (id) => (id === 'chatMessages' ? chat : null),
        document: {
            createElement: makeEl,
            createTextNode: (s) => ({ nodeType: 3, text: String(s) }),
            getElementById: (id) => (id === 'supportPanel' ? legacyPanel : null)
        },
        t: (key) => T.en[key] || key,
        setTimeout: (fn) => { fn(); }
    };
    if (opts.messenger !== false) {
        sandbox.NativeSupport = { open: () => { messengerOpens += 1; } };
    }
    vm.createContext(sandbox);
    vm.runInContext(HANDOVER + '\n' + QUEUED + '\nhandOverToHumanSupport();', sandbox);
    return { chat, legacyPanel, messengerOpens };
}

/* ------------------------------------------------- A. no automated label */

test('A1. the in-app support header states HUMAN support in every locale', () => {
    assert.strictEqual(T.en['support.assistant.status'], 'Human support');
    for (const l of LANGS) {
        const status = T[l]['support.assistant.status'];
        assert.ok(status && status.trim(), l + ' must define the support status');
        assert.ok(!/automat/i.test(status), l + ' must not call support automated');
        assert.ok(status.indexOf('\u0622\u0644\u064a') === -1, l + ' must not call support automated (ar)');
        assert.ok(status.indexOf('\u81ea\u52a8') === -1, l + ' must not call support automated (zh)');
    }
});

test('A2. the Support Center explanation describes a human team, not an assistant', () => {
    // Renamed from `support.assistant.automated`: the key name must not survive a
    // human-only product, and neither must its "replies instantly" claim.
    assert.strictEqual(Object.prototype.hasOwnProperty.call(T.en, 'support.assistant.automated'), false,
        'the automated explanation key is retired');
    for (const l of LANGS) {
        const copy = T[l]['support.assistant.human'];
        assert.ok(copy && copy.trim(), l + ' must define the human-support explanation');
        assert.ok(!/instant|instant\u00e2neo|sofort|automat/i.test(copy), l + ' must not promise instant automated replies');
    }
    assert.match(INDEX, /data-i18n="support\.assistant\.human"/, 'the markup uses the human key');
});

test('A3. the queued acknowledgement exists in all six locales', () => {
    for (const l of LANGS) {
        const copy = T[l]['support.reply.queued'];
        assert.ok(copy && copy.trim().length > 30, l + ' must define the queued acknowledgement');
        assert.strictEqual(copy.indexOf('{{'), -1, l + ' needs no interpolation');
        assert.ok(!/undestood|answer that accurately/i.test(copy), l + ' must not reuse the legacy fallback');
    }
});

/* ------------------------------- B. a stored message is never auto-answered */

test('B1. the stored-message branch hands over instead of rendering the fallback', () => {
    const start = SEND.indexOf('if (answered && answered.human)');
    const branch = SEND.slice(start, SEND.indexOf('handOverToHumanSupport();', start) + 32);
    assert.match(branch, /handOverToHumanSupport\(\)/, 'the human case hands the customer to the messenger');
    assert.ok(branch.indexOf('appendSupportFallbackReply') === -1, 'the legacy fallback renderer is not called');
    assert.ok(branch.indexOf('support.reply.default') === -1, 'the legacy fallback text is not referenced');
    assert.ok(branch.indexOf('openSupportModal') === -1, 'no redirect to another support channel');
});

test('B2. the fallback copy is still only used when NOTHING was stored', () => {
    // The offline / feature-disabled path keeps its honest notice (no request was
    // made, so no human has the message). That branch must stay separate from the
    // stored-message branch pinned above.
    const offline = SEND.slice(SEND.indexOf('if (reply)'), SEND.indexOf('chat.scrollTop = chat.scrollHeight;', SEND.indexOf('if (reply)')));
    assert.ok(offline.indexOf('appendSupportFallbackReply') !== -1, 'the offline branch keeps the notice');
    assert.ok(SEND.indexOf('const canUseBackend') !== -1, 'the offline branch is the no-session/no-transport case');
});

test('B3. the handover opens the messenger that shows the thread', () => {
    const out = runHandover();
    assert.strictEqual(out.messengerOpens, 1, 'the messenger is opened');
    assert.ok(!out.legacyPanel.classList.contains('open'), 'the legacy panel is closed');
    assert.strictEqual(out.chat.children.length, 0, 'nothing is appended to the legacy transcript');
});

test('B4. when the messenger cannot open, a SYSTEM acknowledgement is shown', () => {
    const out = runHandover({ messenger: false });
    assert.strictEqual(out.chat.children.length, 1, 'exactly one notice');
    const notice = out.chat.children[0];
    assert.strictEqual(notice.className, 'chat-message system', 'it is a system notice, never an assistant answer');
    const text = textOf(notice);
    assert.ok(text.indexOf(T.en['support.reply.queued']) !== -1, 'the customer is told the message reached the team');
    assert.ok(text.indexOf(LEGACY_FALLBACK) === -1, 'the legacy fallback is never rendered');
    const buttons = (notice.children || []).filter((n) => (n.children || []).some((c) => String(c.className).indexOf('support-human-action') !== -1));
    assert.strictEqual(buttons.length, 0, 'no "Open Support Center" redirect is offered');
});

/* --------------------------------------- C. one launcher, one conversation */

test('C1. the floating launcher opens the messenger while the feature is enabled', () => {
    let opened = 0;
    const legacyPanel = makeEl('div');
    legacyPanel.classList.add('open');
    const sandbox = {
        APP: { nativeSupport: true },
        NativeSupport: { open: () => { opened += 1; } },
        document: { getElementById: (id) => (id === 'supportPanel' ? legacyPanel : null) }
    };
    vm.createContext(sandbox);
    vm.runInContext(TOGGLE + '\ntoggleSupport();', sandbox);
    assert.strictEqual(opened, 1, 'the real conversation is opened');
    assert.ok(!legacyPanel.classList.contains('open'), 'the legacy panel is not shown');
});

test('C2. with the feature disabled the legacy panel behaves exactly as before', () => {
    const legacyPanel = makeEl('div');
    const sandbox = {
        APP: {},
        document: { getElementById: (id) => (id === 'supportPanel' ? legacyPanel : null) }
    };
    vm.createContext(sandbox);
    vm.runInContext(TOGGLE + '\ntoggleSupport();', sandbox);
    assert.ok(legacyPanel.classList.contains('open'), 'the legacy panel still toggles');
});

/* ------------------------- D. the flag is adopted on every session sync */

test('D1. /api/auth/me is enough to enable the messenger (the regression)', () => {
    // ROOT CAUSE of all three production symptoms: `APP.nativeSupport` was only
    // assigned in the REGISTRATION handler. A returning customer (login, refresh,
    // restored session) therefore kept it undefined, `body.ns-enabled` was never
    // applied, and the legacy floating assistant stayed the support surface - where
    // the automated fallback was rendered and a human reply could never appear.
    const fn = extractFunction('syncWalletFromServer');
    assert.ok(/async function syncWalletFromServer/.test(INDEX), 'the session sync exists');
    assert.ok(fn.indexOf('APP.nativeSupport = meData.nativeSupport === true') !== -1,
        'the sync adopts the server flag');
    assert.ok(/NativeSupport\.sync\(\)/.test(fn), 'and activates the messenger immediately');
    assert.ok(fn.indexOf("typeof meData.nativeSupport === 'boolean'") !== -1,
        'only an explicit server value is adopted (sandbox sends false)');

    // The signup path keeps its own adoption, so registering and logging in behave
    // the same way.
    const assignments = INDEX.split('APP.nativeSupport =').length - 1;
    assert.ok(assignments >= 3, 'signup, session sync and logout all set the flag (found ' + assignments + ')');
});

test('D2. a sandbox account keeps the legacy surface (nativeSupport: false)', () => {
    // The server reports false for MARKETING_SANDBOX; the client must not enable
    // the messenger there, or the marketing recorder would show a different widget.
    const fn = extractFunction('syncWalletFromServer');
    assert.ok(fn.indexOf('meData.nativeSupport === true') !== -1, 'strict comparison, no truthiness');
});
