'use strict';

/**
 * ONE support launcher at a time.
 *
 * The legacy floating assistant is rendered by CSS from first paint; the messenger
 * launcher is created and shown by JS once the server feature flag is known. Before
 * this contract existed the two were controlled independently, so a slow / failed
 * /api/auth/me left the legacy launcher on screen (tap it and you got the assistant,
 * where a human reply can never appear) and any path that cleared `ns-enabled` while
 * the messenger was mounted could show BOTH.
 *
 * The fix is a single decision - NativeSupport.sync() writes
 * `<body data-support-surface>` - plus one stylesheet rule per surface. These tests
 * run the REAL widget in a vm and pin the decision, the watchdog fallback and the
 * duplicate-include guard, plus the host page's wiring points.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WIDGET = fs.readFileSync(path.join(ROOT, 'public', 'native-support.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const flush = () => new Promise((r) => setImmediate(r));

// --------------------------------------------------------------------- DOM
function makeEl(tag) {
    const classes = new Set();
    const node = {
        tagName: String(tag).toUpperCase(),
        children: [], parentNode: null, textContent: '', style: {}, dataset: {}, attrs: {},
        listeners: {}, disabled: false, value: '', placeholder: '', maxLength: 0, type: '',
        scrollTop: 0, scrollHeight: 0,
        classList: {
            add(c) { classes.add(c); },
            remove(c) { classes.delete(c); },
            contains(c) { return classes.has(c); },
            toggle(c, on) {
                if (on === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
                else if (on) classes.add(c); else classes.delete(c);
            }
        },
        set innerHTML(v) { node.children.forEach((c) => { c.parentNode = null; }); node.children.length = 0; },
        get innerHTML() { return ''; },
        get className() { return Array.from(classes).join(' '); },
        set className(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
        appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
        removeChild(child) { const i = node.children.indexOf(child); if (i >= 0) node.children.splice(i, 1); child.parentNode = null; },
        setAttribute(k, v) { node.attrs[k] = String(v); },
        getAttribute(k) { return node.attrs[k]; },
        addEventListener(ev, fn) { (node.listeners[ev] = node.listeners[ev] || []).push(fn); },
        removeEventListener() {},
        querySelector(sel) {
            const want = String(sel).replace(/^\./, '');
            const walk = (parent) => {
                for (const c of parent.children) {
                    if (String(c.className || '').split(/\s+/).includes(want)) return c;
                    const found = walk(c);
                    if (found) return found;
                }
                return null;
            };
            return walk(node);
        },
        querySelectorAll() { return []; }
    };
    return node;
}

// ---------------------------------------------------------------- harness
function boot(config) {
    const cfg = config || {};
    const body = makeEl('body');
    const winListeners = {};
    const timers = [];
    const intervals = [];
    const tokens = { value: cfg.token === undefined ? 'token-a' : cfg.token };
    const state = { conversations: [], messages: [] };

    function jsonRes(payload, status) {
        return { ok: (status || 200) < 400, status: status || 200, json: () => Promise.resolve(payload) };
    }

    function fetchImpl(url, opts) {
        const u = String(url);
        const method = (opts && opts.method) || 'GET';
        if (u === '/api/support/conversations' && method === 'GET') {
            return Promise.resolve(jsonRes({ ok: true, conversations: state.conversations }));
        }
        if (u === '/api/support/conversations' && method === 'POST') {
            const conv = { id: 900, status: 'open', unread_for_customer: 0 };
            state.conversations = [conv];
            return Promise.resolve(jsonRes({ ok: true, conversation: conv }, 201));
        }
        if (/\/messages$/.test(u) && method === 'GET') {
            return Promise.resolve(jsonRes({ ok: true, conversation: { id: 900 }, messages: state.messages.slice() }));
        }
        return Promise.resolve(jsonRes({ ok: true }));
    }

    const sandbox = {
        console, JSON, Math, Date, Object, Array, Number, String,
        // Timers are recorded, not executed: the pending watchdog must be
        // observable and fireable from the test.
        setTimeout: (fn, ms) => { timers.push({ id: timers.length + 1, fn, ms }); return timers.length; },
        clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
        setInterval: (fn) => { intervals.push(fn); return intervals.length; },
        clearInterval: () => {},
        fetch: fetchImpl,
        localStorage: { getItem: () => tokens.value, setItem() {}, removeItem() {} },
        document: {
            body,
            createElement: (tag) => makeEl(tag),
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => []
        },
        APP: Object.assign({}, cfg.app),
        t: (key) => key
    };
    sandbox.window = {
        addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
        NativeSupport: undefined
    };
    const controller = { calls: [] };
    if (cfg.controller === true) {
        // A stand-in for public/index.html's KxSupportSurface: records the decision
        // and applies it exactly like the real controller does.
        sandbox.window.KxSupportSurface = {
            set(value) {
                controller.calls.push(value);
                body.dataset.supportSurface = value;
                body.classList.toggle('ns-enabled', value === 'native');
            }
        };
    }
    vm.createContext(sandbox);
    vm.runInContext(WIDGET, sandbox, { filename: 'native-support.js' });

    return {
        body,
        sandbox,
        timers,
        intervals,
        tokens,
        state,
        fireLoad() { (winListeners.load || []).forEach((fn) => fn()); },
        widget: () => sandbox.window.NativeSupport,
        launchers: () => body.children.filter((c) => String(c.className).split(/\s+/).includes('ns-launcher')),
        shownLaunchers: () => body.children.filter((c) => String(c.className).split(/\s+/).includes('ns-launcher') && c.classList.contains('show')),
        panels: () => body.children.filter((c) => String(c.className).split(/\s+/).includes('ns-panel')),
        surfaceAttr() { return body.dataset.supportSurface; },
        controller,
        fireTimer() { const t = timers.pop(); if (t) t.fn(); },
        timerCount() { return timers.length; }
    };
}

// ------------------------------------------------------------------ tests
test('S1 an unresolved session draws NEITHER launcher', () => {
    const h = boot({ app: {} });          // APP exists, no flag, not known yet
    h.widget().sync();

    assert.strictEqual(h.widget().surface(), 'pending', 'the surface is pending');
    assert.strictEqual(h.surfaceAttr(), 'pending', 'body carries the pending surface');
    assert.strictEqual(h.shownLaunchers().length, 0, 'no messenger launcher is drawn');
    assert.strictEqual(h.launchers().length, 0, 'the messenger does not even mount while pending');
    assert.strictEqual(h.body.classList.contains('ns-enabled'), false, 'the pending surface does not claim "native"');
});

test('S2 a slow / failed resolution falls back to the legacy launcher (and never to two)', () => {
    const h = boot({ app: {} });
    h.widget().sync();
    assert.strictEqual(h.timerCount(), 1, 'a watchdog is armed');
    assert.strictEqual(h.timers[0].ms, 8000, 'sized to outlast a slow mobile session check');

    h.fireTimer();                        // the flag never arrived
    assert.strictEqual(h.widget().surface(), 'legacy', 'support access is restored, not hidden forever');
    assert.strictEqual(h.surfaceAttr(), 'legacy');
    assert.strictEqual(h.shownLaunchers().length, 0, 'the messenger stays out of the way');
    assert.strictEqual(h.timerCount(), 0, 'the watchdog does not re-arm');
});

test('S3 a late server answer still upgrades to the messenger', () => {
    const h = boot({ app: {} });
    h.widget().sync();                    // pending
    h.fireTimer();                        // watchdog -> legacy
    assert.strictEqual(h.widget().surface(), 'legacy');

    h.sandbox.APP.nativeSupport = true;   // /api/auth/me finally answered
    h.sandbox.APP.nativeSupportKnown = true;
    h.widget().sync();

    assert.strictEqual(h.widget().surface(), 'native');
    assert.strictEqual(h.surfaceAttr(), 'native');
    assert.strictEqual(h.shownLaunchers().length, 1, 'exactly one messenger launcher');
    assert.strictEqual(h.body.classList.contains('ns-enabled'), true);
});

test('S4 a resolved "off" answer shows the legacy launcher and no messenger', () => {
    const h = boot({ app: { nativeSupport: false } });
    h.widget().sync();

    assert.strictEqual(h.widget().surface(), 'legacy');
    assert.strictEqual(h.surfaceAttr(), 'legacy');
    assert.strictEqual(h.shownLaunchers().length, 0);
    assert.strictEqual(h.body.classList.contains('ns-enabled'), false, 'the legacy launcher rule applies');
});

test('S5 a response without the field still resolves (it means "off")', () => {
    const h = boot({ app: {} });
    h.widget().sync();
    assert.strictEqual(h.widget().surface(), 'pending');

    // What syncWalletFromServer() does when /api/auth/me omits nativeSupport.
    h.sandbox.APP.nativeSupportKnown = true;
    h.widget().sync();

    assert.strictEqual(h.widget().surface(), 'legacy', 'known-but-absent is an answer, not "keep waiting"');
    assert.strictEqual(h.timerCount(), 0, 'the watchdog is cancelled by a real answer');
});

test('S6 logout removes the messenger launcher and hands the surface back', () => {
    const h = boot({ app: { nativeSupport: true, nativeSupportKnown: true } });
    h.widget().sync();
    assert.strictEqual(h.shownLaunchers().length, 1, 'one messenger launcher while the panel is closed');
    assert.strictEqual(h.surfaceAttr(), 'native');
    h.widget().open();                     // opening hides the launcher and shows the panel

    // The logout handler: flag off, answer known, sync.
    h.sandbox.APP.nativeSupport = false;
    h.sandbox.APP.nativeSupportKnown = true;
    h.widget().sync();

    assert.strictEqual(h.widget().surface(), 'legacy');
    assert.strictEqual(h.surfaceAttr(), 'legacy', 'the legacy launcher rule applies again');
    assert.strictEqual(h.body.classList.contains('ns-enabled'), false);
    assert.strictEqual(h.shownLaunchers().length, 0, 'no messenger launcher survives the logout');
});

test('S7 switching accounts does not leak the previous transcript', async () => {
    const h = boot({ app: { nativeSupport: true, nativeSupportKnown: true } });
    h.widget().sync();
    h.widget().open();
    await flush(); await flush();
    h.state.messages.push({ id: 501, sender_type: 'agent', body: 'reply for account A', created_at: new Date().toISOString() });
    h.widget().refresh();
    await flush(); await flush();

    const panelBody = () => {
        const panel = h.panels()[0];
        const b = panel ? panel.children.find((c) => String(c.className) === 'ns-body') : null;
        return b ? b.children.filter((c) => String(c.className).includes('ns-msg')) : [];
    };
    assert.ok(panelBody().length > 0, 'account A has a rendered thread');

    h.tokens.value = 'token-b';           // a different account in the same tab
    h.widget().sync();
    await flush();

    assert.strictEqual(h.widget().surface(), 'native', 'still the messenger for the new account');
    const texts = panelBody().map((n) => String(n.textContent || ''));
    assert.ok(!texts.join(' ').includes('reply for account A'), "account A's transcript is gone");
    assert.strictEqual(h.widget().unread, 0, 'no unread count carried over from account A');
});

test('S8 a duplicate include cannot mount a second launcher or panel', () => {
    const h = boot({ app: { nativeSupport: true, nativeSupportKnown: true } });
    h.widget().sync();
    assert.strictEqual(h.launchers().length, 1, 'one launcher after a normal mount');
    assert.strictEqual(h.panels().length, 1, 'one panel');

    const first = h.widget();
    vm.runInContext(WIDGET, h.sandbox, { filename: 'native-support.js (duplicate)' });
    h.sandbox.APP.nativeSupportKnown = true;
    h.widget().sync();

    assert.strictEqual(h.widget(), first, 'the original instance is still the exported one');
    assert.strictEqual(h.launchers().length, 1, 'still ONE launcher in the document');
    assert.strictEqual(h.panels().length, 1, 'still ONE panel');
    assert.strictEqual(h.shownLaunchers().length, 1);
    assert.strictEqual(h.widget().__mounted, true);
});

test('S9 the surface is the ONLY thing that decides launcher visibility', () => {
    // One writer in the widget, one host helper that delegates to sync().
    const writers = WIDGET.split('dataset.supportSurface').length - 1;
    assert.strictEqual(writers, 1, 'exactly one place writes the surface attribute');
    assert.match(WIDGET, /body\.classList\.toggle\('ns-enabled', value === 'native'\)/,
        'the legacy `ns-enabled` marker is DERIVED from the surface, never set independently');

    // The host page must not poke the visibility of either launcher directly.
    assert.doesNotMatch(INDEX, /supportWidget\.style\.display\s*=/,
        'no inline style on the legacy widget');
    assert.doesNotMatch(INDEX, /classList\.(add|remove)\('ns-enabled'\)/,
        'the host never toggles the native marker itself');

    // And the stylesheet must cover the union: each surface hides the other one.
    const rules = INDEX.slice(INDEX.indexOf('body[data-support-surface="native"]'),
        INDEX.indexOf('body.ns-enabled .support-widget{display:none}'));
    assert.match(rules, /body\[data-support-surface="native"\] \.support-widget,/,
        'native hides the legacy assistant');
    assert.match(rules, /body\[data-support-surface="pending"\] \.support-widget\{display:none\}/,
        'pending hides the legacy assistant too');
    assert.match(rules, /body\[data-support-surface="legacy"\] \.ns-launcher,/,
        'legacy hides the messenger launcher');
    assert.match(rules, /body\[data-support-surface="pending"\] \.ns-launcher\{display:none\}/,
        'pending hides the messenger launcher');
    // The STATIC default is `pending`: nothing is painted before the first startup
    // pass decides, so the legacy launcher cannot flash on a session load. The
    // anonymous path resolves to `legacy` in that same pass.
    assert.match(INDEX, /<body data-support-surface="pending">/);
});

test('S10 the host page starts pending for a session and legacy for anonymous visitors', () => {
    const routing = INDEX.slice(INDEX.indexOf('(function startupRouting()'), INDEX.indexOf('// Meta Pixel init'));
    assert.ok(routing.length > 500, 'startupRouting found');

    assert.match(routing, /function supportSurface\(state\)/, 'one helper owns the decision');
    assert.match(routing, /if \(state === 'pending'\) \{ APP\.nativeSupportKnown = false; \}/,
        'pending means "the flag is not known yet"');
    assert.match(routing, /if \(window\.KxSupportSurface\) KxSupportSurface\.set\(state\);/,
        'the decision is applied through the controller, which exists before the deferred module');
    assert.match(routing, /else \{ APP\.nativeSupportKnown = true; APP\.nativeSupport = false; \}/,
        'every other path is an explicit legacy answer');

    const pendingIdx = routing.indexOf("supportSurface('pending')");
    const validateIdx = routing.indexOf('validateStartupSession(startupToken)');
    assert.ok(pendingIdx > 0 && pendingIdx < validateIdx,
        'a token-holding load hides both launchers BEFORE the session is validated');
    assert.strictEqual(routing.split("supportSurface('legacy')").length - 1, 3,
        'anonymous, deep-link and rejected-session paths all resolve to legacy');
});

test('S11 every place that learns the flag marks the answer final', () => {
    // registration
    const reg = INDEX.slice(INDEX.indexOf('APP.nativeSupport = data.nativeSupport === true;'));
    assert.match(reg.slice(0, 400), /APP\.nativeSupportKnown = true;/,
        'the registration payload is a final answer');
    // /api/auth/me
    assert.match(INDEX, /APP\.nativeSupportKnown = true;\s*\n\s*try \{\s*\n\s*if \(window\.NativeSupport && typeof NativeSupport\.sync === 'function'\) NativeSupport\.sync\(\);/,
        'the session sync marks the answer final and re-syncs');
    // logout
    const logout = INDEX.slice(INDEX.indexOf('APP.nativeSupport = false;'));
    assert.match(logout.slice(0, 200), /APP\.nativeSupportKnown = true;/,
        'logout states the legacy answer instead of leaving it unknown');
});

test('S12 the account-switch and sandbox paths keep their existing identity rules', () => {
    // Identity is the credential, not the cached profile (PR #218 lesson).
    assert.match(WIDGET, /function accountIdentity\(\) \{[\s\S]{0,200}localStorage\.getItem\('jwt_token'\)/);
    // Sandbox is display-classified by APP.environment; the support surface follows
    // the same server flag for sandbox and production (requirement: unchanged
    // feature-flag semantics).
    assert.match(WIDGET, /typeof APP !== 'undefined' && APP && APP\.nativeSupportKnown === true/);
    assert.doesNotMatch(WIDGET, /MARKETING_SANDBOX/,
        'the support surface never special-cases the sandbox: it follows the flag');
});

test('S13 the controller is the single writer, and both sides go through it', () => {
    // Host: one controller, one write of the attribute, one watchdog.
    assert.match(INDEX, /var KxSupportSurface = \{/);
    assert.match(INDEX, /document\.body\.dataset\.supportSurface = value;/);
    assert.match(INDEX, /PENDING_TIMEOUT_MS: 8000,/);
    assert.match(INDEX, /if \(window\.NativeSupport && typeof NativeSupport\.hideLauncher === 'function'\) NativeSupport\.hideLauncher\(\);/,
        'the fallback also takes the messenger launcher away');

    // Widget: delegates when the controller exists (so production has ONE writer)...
    assert.match(WIDGET, /if \(window\.KxSupportSurface && typeof window\.KxSupportSurface\.set === 'function'\) \{\s*\n\s*window\.KxSupportSurface\.set\(value\);\s*\n\s*return;/);
    // ...and only falls back to writing the attribute itself when it does not.
    const fallbackIdx = WIDGET.indexOf("// Standalone load (tests, embedded harness): the same rule, applied here.");
    const writeIdx = WIDGET.indexOf('dataset.supportSurface = value;');
    assert.ok(fallbackIdx > 0 && writeIdx > fallbackIdx, 'the widget only writes the attribute in the standalone fallback');
    assert.match(WIDGET, /hideLauncher: hideLauncher,/, 'the watchdog can hide the messenger launcher through the module');

    // Runtime proof with a controller present: the widget's sync() must not touch
    // the attribute itself, it must call set().
    const h = boot({ app: { nativeSupport: true, nativeSupportKnown: true }, controller: true });
    h.widget().sync();
    assert.deepStrictEqual(h.controller.calls, ['native'], 'sync() delegated the decision');
    assert.strictEqual(h.surfaceAttr(), 'native', 'the controller applied it');
    h.sandbox.APP.nativeSupport = false;
    h.widget().sync();
    assert.deepStrictEqual(h.controller.calls, ['native', 'legacy']);
});
