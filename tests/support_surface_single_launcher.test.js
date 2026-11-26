'use strict';

/**
 * ONE support launcher at a time.
 *
 * The legacy floating assistant is rendered by CSS from first paint; the messenger
 * launcher is created and shown by JS once the server feature flag is known. Before
 * this contract existed the two were controlled independently, so a slow / failed
 * /api/auth/me left the legacy launcher on screen (tap it and you got the assistant,
 * where a human reply can never appear) and any path that cleared the second marker
 * while the messenger was mounted could show BOTH.
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
    assert.strictEqual(h.surfaceAttr(), 'pending', 'the pending surface is stated, not implied by a class');
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
    assert.strictEqual(h.surfaceAttr(), 'native');
});

test('S4 a resolved "off" answer shows the legacy launcher and no messenger', () => {
    const h = boot({ app: { nativeSupport: false } });
    h.widget().sync();

    assert.strictEqual(h.widget().surface(), 'legacy');
    assert.strictEqual(h.surfaceAttr(), 'legacy');
    assert.strictEqual(h.shownLaunchers().length, 0);
    assert.strictEqual(h.surfaceAttr(), 'legacy', 'the legacy launcher rule applies');
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
    assert.strictEqual(h.surfaceAttr(), 'legacy');
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
    assert.doesNotMatch(WIDGET, /classList\.(add|remove|toggle)\('ns-enabled'/,
        'the widget keeps no second marker');
    assert.doesNotMatch(INDEX, /body\.ns-enabled\s+\./,
        'the stylesheet keys on the attribute alone - no class a body.className assignment can wipe');

    // The host page must not poke the visibility of either launcher directly.
    assert.doesNotMatch(INDEX, /supportWidget\.style\.display\s*=/,
        'no inline style on the legacy widget');
    assert.doesNotMatch(INDEX, /classList\.(add|remove|toggle)\('ns-enabled'/,
        'the host never toggles a second marker');

    // And the stylesheet must cover the union: each surface hides the other one.
    const rules = INDEX.slice(INDEX.indexOf('body[data-support-surface="native"]'),
        INDEX.indexOf('.ns-badge{min-width'));
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

// ---------------------------------------------------------------------------
// The two lifecycle fixes from the pre-merge audit (2026-11-26)
// ---------------------------------------------------------------------------

/** Brace-matched slice of a top-level `function name(...) {}` from index.html. */
function sliceFunction(src, name) {
    let start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' must exist');
    if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error(name + ' is not brace-matchable');
}

/** The real KxSupportSurface object literal, evaluated in a fake document. */
function controllerIn(body, panel) {
    const src = INDEX.slice(INDEX.indexOf('var KxSupportSurface = {'),
        INDEX.indexOf('window.KxSupportSurface = KxSupportSurface;'));
    assert.ok(src.length > 400, 'controller found');
    const sandbox = {
        document: { body, getElementById: (id) => (id === 'supportPanel' ? panel : null) },
        window: {},
        // The watchdog is HELD, not fired: a synchronous timer would turn every
        // pending state into legacy immediately and hide what is being asserted.
        setTimeout: () => 1,
        clearTimeout: () => {}
    };
    vm.createContext(sandbox);
    vm.runInContext(src + '\nthis.__c = KxSupportSurface;', sandbox);
    return sandbox.__c;
}

function fakeBody() {
    return { dataset: {}, classList: { _c: new Set(), add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); }, contains(c) { return this._c.has(c); } } };
}
function fakePanel() {
    return { classList: { _c: new Set(['open']), add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); }, contains(c) { return this._c.has(c); } } };
}

test('S14 leaving `legacy` CLOSES an already-open legacy panel (not just hides it)', () => {
    const body = fakeBody();
    const panel = fakePanel();
    const cx = controllerIn(body, panel);
    assert.strictEqual(panel.classList.contains('open'), true, 'precondition: the panel is open');

    cx.set('pending');
    assert.strictEqual(panel.classList.contains('open'), false, 'pending closes it');
    assert.strictEqual(body.dataset.supportSurface, 'pending');

    panel.classList.add('open');                 // reopened by the customer
    cx.set('native');
    assert.strictEqual(panel.classList.contains('open'), false, 'the handover closes it again');
    assert.strictEqual(body.dataset.supportSurface, 'native');

    // A `legacy` value must NOT close anything: that surface owns the panel.
    panel.classList.add('open');
    cx.set('legacy');
    assert.strictEqual(panel.classList.contains('open'), true, 'legacy leaves the assistant alone');
});

test('S15 the controller keeps no class marker, so a body.className assignment cannot desync it', () => {
    const body = fakeBody();
    const cx = controllerIn(body, fakePanel());
    cx.set('native');
    assert.deepStrictEqual(Array.from(body.classList._c), [], 'no class is written');
    // `setMode()` does `document.body.className = 'mode-live'` on every render; the
    // surface lives in the data attribute, which that assignment cannot touch.
    assert.strictEqual(body.dataset.supportSurface, 'native');
    assert.doesNotMatch(INDEX, /document\.body\.classList\.toggle\('ns-enabled'/);
});

test('S16 logout resets the legacy assistant (panel, input, transcript, epoch)', () => {
    const fn = sliceFunction(INDEX, 'resetLegacySupportChat') + '\n' + sliceFunction(INDEX, 'legacySupportEpoch');
    const panel = fakePanel();
    const input = { value: 'PREVIOUS-ACCOUNT-SECRET' };
    const chat = {
        _html: '',
        set innerHTML(v) { this._html = v; this._bubble = null; },
        get innerHTML() { return this._html; },
        querySelector() { this._bubble = this._bubble || { textContent: '' }; return this._bubble; }
    };
    const sandbox = {
        APP: {},
        t: (k) => (k === 'support.welcome' ? 'WELCOME' : k),
        document: { getElementById: (id) => ({ supportPanel: panel, supportInput: input, chatMessages: chat }[id] || null) },
        Number, Object, String
    };
    vm.createContext(sandbox);
    vm.runInContext(fn, sandbox);
    const before = sandbox.APP.legacySupportEpoch || 0;

    sandbox.resetLegacySupportChat();

    assert.strictEqual(panel.classList.contains('open'), false, 'the panel is closed');
    assert.strictEqual(input.value, '', 'the draft is discarded');
    assert.ok(chat.innerHTML.indexOf('PREVIOUS-ACCOUNT-SECRET') === -1, 'the transcript is gone');
    assert.strictEqual(chat.querySelector().textContent, 'WELCOME', 'just the welcome is left');
    assert.strictEqual(sandbox.APP.legacySupportEpoch, before + 1, 'the epoch is bumped');
    // Logout must actually call it.
    const logoutAt = INDEX.indexOf("APP.nativeSupport = false;\n            APP.nativeSupportKnown = true;");
    assert.ok(logoutAt > 0, 'logout block located');
    assert.match(INDEX.slice(logoutAt, logoutAt + 900), /resetLegacySupportChat\(\)/,
        'logout resets the legacy assistant');
});

test('S17 an in-flight legacy reply cannot land in the next session', () => {
    const fn = sliceFunction(INDEX, 'sendSupportMessage');
    assert.match(fn, /const epoch = legacySupportEpoch\(\);/);
    assert.match(fn, /const stale = function\(\) \{ return epoch !== legacySupportEpoch\(\); \};/);
    const guards = (fn.match(/if \(stale\(\)\) return;/g) || []).length;
    assert.strictEqual(guards, 2, 'guarded after the awaited reply AND before the keyword reply');
    // The guard runs before every append that follows the await.
    assert.ok(fn.indexOf('if (stale()) return;') < fn.indexOf("t('support.reply.bot')"),
        'the keyword answers are unreachable for a stale continuation');
});

test('S18 the messenger refuses to open while the legacy assistant owns support', () => {
    // Legacy surface (the flag is off / not resolved): opening the messenger would
    // put a second support surface on screen, so it declines and the caller falls
    // back to the static acknowledgement.
    const h = boot({ app: { nativeSupport: false } });
    h.widget().sync();
    assert.strictEqual(h.widget().surface(), 'legacy');
    assert.strictEqual(h.widget().open(), false, 'open() refuses');
    assert.strictEqual(h.panels().length, 0, 'no messenger panel was even built');

    // On its own surface it opens normally.
    h.sandbox.APP.nativeSupport = true;
    h.widget().sync();
    assert.strictEqual(h.widget().surface(), 'native');
    assert.strictEqual(h.widget().open(), true, 'open() succeeds on the native surface');
    assert.strictEqual(h.panels().length, 1);

    // And the host hands over only when the messenger really opened.
    assert.match(INDEX, /if \(NativeSupport\.open\(\) !== false\) return true;/,
        'handOverToHumanSupport uses the refusal instead of claiming success');
});
