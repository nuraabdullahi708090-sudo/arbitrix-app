'use strict';

/**
 * Compact launcher + unread-message indicator (public/native-support.js).
 *
 * These tests run the REAL widget in a vm against a minimal DOM and a fake
 * transport, so the CONTRACT is pinned rather than the markup:
 *
 *   - the closed launcher is an icon-only circular button with an accessible
 *     name, and the unread count lives in an absolutely-positioned badge (the
 *     button never grows);
 *   - the count comes from the SERVER's per-conversation receipt
 *     (`unread_for_customer`) - never from the rendered rows - so a customer's
 *     own messages can never be "unread";
 *   - the receipt is issued ONLY after a successful read while the panel is
 *     open, so a failed retrieval cannot mark a reply as read, and no background
 *     poll can clear the badge;
 *   - a closed panel keeps a single low-frequency watcher on the same endpoint,
 *     which stops when the panel opens, the account changes, support is disabled
 *     or the tab is hidden.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WIDGET = fs.readFileSync(path.join(ROOT, 'public', 'native-support.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const DICT = {
    'ns.title': 'Kalderix Support',
    'ns.launcher': 'Open support chat',
    'ns.unreadLabel': '{{count}} unread messages',
    'ns.close': 'Close',
    'ns.send': 'Send',
    'ns.placeholder': 'Type your message...',
    'ns.messages': 'Messages',
    'ns.delivered': 'Delivered'
};

function t(key, vars) {
    const raw = DICT[key] || key;
    if (!vars) return raw;
    return raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// ------------------------------------------------------------------ fake DOM
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
                if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
                else if (on) classes.add(c); else classes.delete(c);
            }
        },
        get className() { return Array.from(classes).join(' '); },
        set className(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
        appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
        removeChild(child) { const i = node.children.indexOf(child); if (i >= 0) node.children.splice(i, 1); child.parentNode = null; },
        setAttribute(k, v) { node.attrs[k] = String(v); },
        getAttribute(k) { return node.attrs[k]; },
        removeAttribute(k) { delete node.attrs[k]; },
        addEventListener(ev, fn) { (node.listeners[ev] = node.listeners[ev] || []).push(fn); },
        removeEventListener() {},
        dispatch(ev) { (node.listeners[ev] || []).slice().forEach((fn) => fn({ key: ev, preventDefault() {} })); },
        focus() {}, blur() {}, setSelectionRange() {}, scrollTo() {},
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

const flush = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------------ harness
function boot(config) {
    const cfg = config || {};
    const body = makeEl('body');
    const calls = [];
    const timers = new Map();
    let nextTimer = 1;
    const winListeners = {};
    const docListeners = {};
    const store = { jwt_token: cfg.token === undefined ? 'token-A' : cfg.token };

    const state = {
        conversations: cfg.conversations || [],
        messages: cfg.messages || [],
        failMessages: cfg.failMessages || 0,     // N failed message reads, then succeed
        readCalls: 0,
        listCalls: 0
    };

    function jsonRes(payload, status) {
        return { ok: (status || 200) < 400, status: status || 200, json: () => Promise.resolve(payload) };
    }

    function fetchImpl(url, opts) {
        const o = opts || {};
        const method = o.method || 'GET';
        const u = String(url);
        calls.push({ method, url: u, body: o.body ? JSON.parse(o.body) : null });

        if (/\/read$/.test(u)) { state.readCalls++; return Promise.resolve(jsonRes({ ok: true })); }

        if (u === '/api/support/conversations' && method === 'GET') {
            state.listCalls++;
            return Promise.resolve(jsonRes({ ok: true, conversations: state.conversations }));
        }
        if (/\/messages/.test(u) && method === 'GET') {
            if (state.failMessages > 0) {
                state.failMessages--;
                return Promise.resolve(jsonRes({ error: 'unavailable' }, 503));
            }
            const afterMatch = /after=(\d+)/.exec(u);
            const rows = afterMatch
                ? state.messages.filter((m) => m.id > Number(afterMatch[1]))
                : state.messages.slice();
            return Promise.resolve(jsonRes({ ok: true, conversation: { id: 7 }, messages: rows }));
        }
        return Promise.resolve(jsonRes({ ok: true }));
    }

    const doc = {
        body,
        hidden: !!cfg.hidden,
        createElement: (tag) => makeEl(tag),
        getElementById: () => null,
        querySelector: () => null,
        addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); }
    };

    const sandbox = {
        console,
        JSON,
        Math,
        Date,
        Object,
        Array,
        Number,
        String,
        setTimeout: (fn) => { fn(); return 0; },
        clearTimeout: () => {},
        setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
        clearInterval: (id) => { timers.delete(id); },
        fetch: fetchImpl,
        localStorage: {
            getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; }
        },
        document: doc,
        APP: { nativeSupport: cfg.flag === undefined ? true : cfg.flag, nativeSupportKnown: true },
        t
    };
    sandbox.window = {
        addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
        NativeSupport: undefined
    };
    vm.createContext(sandbox);
    vm.runInContext(WIDGET, sandbox, { filename: 'native-support.js' });

    return {
        body,
        sandbox,
        calls,
        state,
        store,
        doc,
        widget: () => sandbox.window.NativeSupport,
        launcher: () => body.children.find((c) => String(c.className).split(/\s+/).includes('ns-launcher')) || null,
        panel: () => body.children.find((c) => String(c.className).split(/\s+/).includes('ns-panel')) || null,
        badge: () => {
            const l = body.children.find((c) => String(c.className).split(/\s+/).includes('ns-launcher'));
            return l ? l.children.find((c) => String(c.className).split(/\s+/).includes('ns-badge')) : null;
        },
        timers: () => Array.from(timers.entries()),
        fireTimers() { Array.from(timers.values()).forEach((tm) => tm.fn()); },
        setHidden(hidden) { doc.hidden = hidden; (docListeners.visibilitychange || []).forEach((fn) => fn()); },
        setFlag(flag) { sandbox.APP.nativeSupport = flag; },
        setToken(token) { if (token === null) delete store.jwt_token; else store.jwt_token = token; },
        sync() { sandbox.window.NativeSupport.sync(); },
        requests(match) { return calls.filter((c) => String(c.url).includes(match)); },
        resetCalls() { calls.length = 0; }
    };
}

const CONV = (unread) => [{ id: 7, status: 'open', unread_for_customer: unread }];

function agentRow(id, body) {
    return {
        id,
        conversation_id: 7,
        sender_type: 'agent',
        via: 'telegram',
        body: body || 'hello from the agent',
        created_at: new Date().toISOString()
    };
}

// ---------------------------------------------------------------- 1. launcher
test('1. the closed launcher is an icon-only button with an accessible name', async () => {
    const h = boot({ conversations: CONV(0) });
    h.sync();
    await flush();

    const launcher = h.launcher();
    assert.ok(launcher, 'the launcher is built');
    assert.strictEqual(launcher.attrs['aria-label'], 'Open support chat');
    assert.strictEqual(launcher.attrs.title, 'Open support chat');
    // No permanent marketing label: the only children are the icon and the badge.
    const textChildren = launcher.children.filter((c) => String(c.textContent || '').trim());
    assert.deepStrictEqual(textChildren.map((c) => c.textContent), [],
        'no text on the closed launcher (the icon is a glyph, the badge is empty)');
    const classes = launcher.children.map((c) => String(c.className));
    assert.deepStrictEqual(classes, ['fas fa-comments', 'ns-badge']);
    assert.strictEqual(launcher.children[0].attrs['aria-hidden'], 'true', 'the icon is decorative');
    assert.strictEqual(h.badge().attrs['aria-hidden'], 'true', 'the count is spoken via the label');
});

test('2. the launcher is circular, green and 56px (CSS contract)', () => {
    const css = /\.ns-launcher\{([^}]*)\}/.exec(INDEX);
    assert.ok(css, 'the launcher rule exists');
    const rule = css[1];
    // Anchored low in the corner (below the 80..136px toast band, above the home
    // indicator), so a toast can never swallow the support tap.
    assert.match(rule, /bottom:calc\(20px \+ env\(safe-area-inset-bottom/);
    assert.match(rule, /width:56px/);
    assert.match(rule, /height:56px/);
    assert.match(rule, /border-radius:50%/, 'a circle, not a pill');
    assert.match(rule, /background:linear-gradient\(180deg,#17D78D 0%,#0ECB81 100%\)/, 'support green');
    assert.match(rule, /color:#fff/, 'white icon');
    assert.doesNotMatch(rule, /padding:12px 16px/, 'the pill padding is gone');
    assert.match(rule, /box-shadow:[^;]*rgba/, 'a subtle shadow');
    assert.match(rule, /env\(safe-area-inset-bottom/, 'fixed above the home indicator');
    // press / hover feedback and a visible keyboard focus ring
    assert.match(INDEX, /\.ns-launcher:hover\{[^}]*filter:brightness/);
    assert.match(INDEX, /\.ns-launcher:active\{[^}]*transform:scale\(\.94\)/);
    assert.match(INDEX, /\.ns-launcher:focus-visible\{[^}]*outline:2px solid #0ECB81/);
});

test('3. the badge floats (the launcher never resizes) and is capped at 9+', async () => {
    const h = boot({ conversations: CONV(0) });
    h.sync();
    await flush();
    const badge = h.badge();
    const css = /\.ns-badge\{([^}]*)\}/.exec(INDEX)[1];
    assert.match(css, /position:absolute/, 'floating, so the 56px button never grows');
    assert.match(css, /border:2px solid #0B1220/, 'ringed so it reads as a cut-out');

    assert.strictEqual(badge.style.display, 'none', 'hidden with nothing unread');

    const cases = [[1, '1'], [3, '3'], [9, '9'], [12, '9+']];
    for (const [count, text] of cases) {
        h.state.conversations = CONV(count);
        h.widget().close();          // close() refreshes the badge from the server
        await flush();
        assert.strictEqual(badge.textContent, text, count + ' unread renders as ' + text);
        assert.strictEqual(badge.style.display, 'inline-block');
    }
});

test('4. the count is also spoken, uncapped, in the accessible name', async () => {
    const h = boot({ conversations: CONV(4) });
    h.sync();
    await flush();
    assert.strictEqual(h.launcher().attrs['aria-label'], 'Open support chat, 4 unread messages');
    h.state.conversations = CONV(0);
    h.widget().close();
    await flush();
    assert.strictEqual(h.launcher().attrs['aria-label'], 'Open support chat', 'the count leaves the label when read');
});

// ------------------------------------------------------- 2. what counts unread
test('5a. a resolved thread\'s counter is not badged (the badge must stay clearable)', async () => {
    // The panel can only display the newest non-resolved thread, so a resolved
    // thread's counter would raise a badge that opening the chat can never clear.
    const h = boot({
        conversations: [
            { id: 7, status: 'open', unread_for_customer: 2 },
            { id: 3, status: 'resolved', unread_for_customer: 9 }
        ]
    });
    h.sync();
    await flush();
    assert.strictEqual(h.badge().textContent, '2', 'only the displayable thread counts');
});

test('5b. an all-resolved history shows no badge at all', async () => {
    const h = boot({ conversations: [{ id: 3, status: 'resolved', unread_for_customer: 4 }] });
    h.sync();
    await flush();
    assert.strictEqual(h.badge().style.display, 'none');
    assert.strictEqual(h.widget().unread, 0);
});


test('5. only the server receipt counts - the customer\'s own messages never do', async () => {
    const h = boot({ conversations: CONV(0), messages: [] });
    h.sync();
    await flush();
    assert.ok(h.widget().open());
    await flush();
    // A customer message is stored by the server; the list still reports 0 unread.
    h.state.messages.push({ id: 11, conversation_id: 7, sender_type: 'customer', body: 'hi', created_at: new Date().toISOString() });
    h.calls.length = 0;
    h.widget().refresh();
    await flush();
    assert.strictEqual(h.badge().style.display, 'none', 'own message never raises the badge');
    assert.strictEqual(h.widget().unread, 0);

    // The widget must not derive unread from rendered rows at all.
    assert.doesNotMatch(WIDGET, /unread[^\n]{0,40}sender_type/, 'unread is never computed from message rows');
});

test('6. an agent reply while the panel is CLOSED raises the badge (watcher)', async () => {
    const h = boot({ conversations: CONV(0) });
    h.sync();
    await flush();
    assert.strictEqual(h.widget().timers().badge, true, 'the closed panel watches for replies');

    // The agent answers; the next watcher tick sees the new server count.
    h.state.conversations = CONV(2);
    h.resetCalls();
    h.fireTimers();
    await flush();
    assert.strictEqual(h.requests('/api/support/conversations').length, 1, 'the watcher re-reads the list');
    assert.strictEqual(h.badge().textContent, '2');
    assert.strictEqual(h.badge().style.display, 'inline-block');
});

test('7. repeated syncs never create a second watcher or a second poll loop', async () => {
    const h = boot({ conversations: CONV(1) });
    h.sync();
    h.sync();
    h.sync();
    await flush();
    const badgeTimers = h.timers().filter(([, tm]) => tm.ms >= 20000);
    assert.strictEqual(badgeTimers.length, 1, 'exactly one closed-state watcher');
    h.resetCalls();
    h.fireTimers();
    await flush();
    assert.strictEqual(h.requests('/api/support/conversations').length, 1, 'one tick = one request');
    assert.strictEqual(h.widget().timers().badge, true);
});

test('8. opening the panel stops the watcher; closing resumes it', async () => {
    const h = boot({ conversations: CONV(1) });
    h.sync();
    await flush();
    assert.strictEqual(h.widget().timers().badge, true);

    h.widget().open();
    await flush();
    assert.strictEqual(h.widget().timers().badge, false, 'the open panel has its own read loop');
    assert.ok(h.widget().timers().poll, 'and that loop is running');
    assert.doesNotMatch(h.launcher().className, /(^|\s)show(\s|$)/, 'the launcher is out of the way while open');

    h.widget().close();
    await flush();
    assert.strictEqual(h.widget().timers().badge, true, 'closed again, so it watches again');
});

test('9. a hidden tab does not poll', async () => {
    const h = boot({ conversations: CONV(0) });
    h.sync();
    await flush();
    h.setHidden(true);
    h.resetCalls();
    h.fireTimers();
    await flush();
    assert.strictEqual(h.requests('/api/support/conversations').length, 0, 'no traffic while hidden');

    h.resetCalls();          // before the event, so the resume request is observed
    h.setHidden(false);
    await flush();
    assert.ok(h.requests('/api/support/conversations').length >= 1, 'a reply that arrived while hidden is picked up on return');
});

// ------------------------------------------------------- 3. read receipt rules
test('10. opening marks the thread read only AFTER a successful retrieval', async () => {
    const h = boot({ conversations: CONV(2), messages: [agentRow(5), agentRow(6)], failMessages: 1 });
    h.sync();
    await flush();
    assert.strictEqual(h.badge().textContent, '2');

    h.resetCalls();
    h.widget().open();
    await flush();
    assert.strictEqual(h.state.readCalls, 0, 'a FAILED read must not mark anything as read');
    assert.strictEqual(h.badge().style.display, 'inline-block', 'the badge survives the failure');
    assert.strictEqual(h.widget().unread, 2);

    // Recovery: the next read succeeds and only then is the receipt issued.
    h.widget().refresh({ full: true });
    await flush();
    assert.strictEqual(h.state.readCalls, 1, 'one receipt after the rows are on screen');
    assert.strictEqual(h.badge().style.display, 'none', 'and the badge clears');
});

test('11. the read request follows the message read, never precedes it', async () => {
    const h = boot({ conversations: CONV(1), messages: [agentRow(9)] });
    h.sync();
    await flush();
    h.resetCalls();
    h.widget().open();
    await flush();
    const readIdx = h.calls.findIndex((c) => /\/read$/.test(c.url));
    const msgIdx = h.calls.findIndex((c) => /\/messages/.test(c.url) && c.method === 'GET');
    assert.ok(msgIdx !== -1 && readIdx !== -1, 'both calls happened');
    assert.ok(msgIdx < readIdx, 'the receipt is only sent once the thread was fetched');
});

test('12. a reply that arrives while the panel is OPEN is shown, not badged', async () => {
    const h = boot({ conversations: CONV(0), messages: [] });
    h.sync();
    await flush();
    h.widget().open();
    await flush();

    // Agent replies: the server bumps the receipt AND returns the row.
    h.state.conversations = CONV(1);
    h.state.messages.push(agentRow(12));
    h.resetCalls();
    h.widget().refresh();
    await flush();
    assert.strictEqual(h.state.readCalls, 1, 'the visible reply is marked read');
    assert.strictEqual(h.badge().style.display, 'none', 'no badge while the thread is on screen');
    const rendered = h.panel().querySelector('.ns-msg agent');
    assert.ok(rendered || h.panel().children.length, 'the panel rendered the thread');

    // Closing and a NEW reply: the badge appears again.
    h.widget().close();
    await flush();
    h.state.conversations = CONV(2);
    h.widget().close();       // refreshBadge(true) on close
    await flush();
    assert.strictEqual(h.badge().style.display, 'inline-block');
    assert.strictEqual(h.badge().textContent, '2');
});

test('13. a background refresh can never clear the badge (receipt is open-only)', async () => {
    const h = boot({ conversations: CONV(3), messages: [agentRow(1)] });
    h.sync();
    await flush();
    assert.strictEqual(h.badge().textContent, '3');
    h.resetCalls();
    h.widget().refresh({ full: true });   // simulates any read issued while closed
    await flush();
    assert.strictEqual(h.state.readCalls, 0, 'no receipt while the panel is closed');
    assert.strictEqual(h.badge().style.display, 'inline-block');
});

// ------------------------------------------------------------ 4. isolation
test('14. switching account clears the badge and re-scopes the watcher', async () => {
    const h = boot({ conversations: CONV(5) });
    h.sync();
    await flush();
    assert.strictEqual(h.badge().textContent, '5');

    // Another customer signs in on the same device.
    h.setToken('token-B');
    h.state.conversations = CONV(0);
    h.sync();
    await flush();
    assert.strictEqual(h.badge().style.display, 'none', 'A\'s unread count never follows B');
    assert.strictEqual(h.widget().unread, 0);
    assert.strictEqual(h.timers().filter(([, tm]) => tm.ms >= 20000).length, 1, 'still exactly one watcher, for B');
});

test('14b. the new account\'s count is read even inside the 5s rate-limit window', async () => {
    const h = boot({ conversations: CONV(5) });
    h.sync();
    await flush();
    h.widget().close();                 // starts the 5s rate-limit window
    await flush();
    assert.strictEqual(h.badge().textContent, '5');

    h.setToken('token-B');
    h.state.conversations = CONV(1);
    h.sync();
    await flush();
    assert.strictEqual(h.badge().textContent, '1', 'the new account\'s own count is read at once');
    assert.strictEqual(h.launcher().attrs['aria-label'], 'Open support chat, 1 unread messages');
});

test('15. support switched off removes the launcher and stops watching', async () => {
    const h = boot({ conversations: CONV(4) });
    h.sync();
    await flush();
    assert.ok(h.launcher(), 'built while enabled');

    h.setFlag(false);
    h.sync();
    await flush();
    assert.strictEqual(h.widget().timers().badge, false);
    assert.doesNotMatch(h.launcher().className, /(^|\s)show(\s|$)/, 'no launcher when support is off');
    h.resetCalls();
    h.fireTimers();
    await flush();
    assert.strictEqual(h.requests('/api/support/conversations').length, 0);
});

// ------------------------------------------------------------ 5. panel polish
test('16. the phone panel is compact, safe-area aware and never full-screen', () => {
    // Scope the search to the widget stylesheet (the page has other 640px blocks)
    // AND to the block that styles the panel (a later RTL block also uses 640px).
    const from = INDEX.indexOf('.ns-launcher{');
    const sheet = INDEX.slice(from, INDEX.indexOf('</style>', from));
    const blocks = sheet.match(/@media \(max-width:640px\)\{[\s\S]*?\n\}/g) || [];
    const block = { 1: (blocks.filter((b) => /\.ns-panel\{/.test(b))[0] || '') };
    assert.ok(block, 'the phone block exists');
    const css = block[1];
    assert.match(css, /height:min\(68vh,540px\)/, 'smaller than the previous 72vh/560px');
    assert.match(css, /max-height:calc\(100vh - 20px - env\(safe-area-inset-bottom/, 'never taller than the screen');
    assert.match(css, /bottom:calc\(8px \+ env\(safe-area-inset-bottom/, 'lifted off the home indicator');
    assert.doesNotMatch(css, /height:100vh/, 'never a full-screen sheet');
    // the composer keeps its own row and the transcript keeps the scroll
    assert.match(INDEX, /\.ns-body\{[^}]*overflow-y:auto/);
    assert.match(INDEX, /\.ns-foot\{[^}]*flex:0 0 auto/);
    assert.match(INDEX, /\.ns-close\{[^}]*width:44px;height:44px/, 'the close target stays reachable');
});

test('18. the launcher steps aside behind any dialog (it must not eat a modal tap)', () => {
    const from = INDEX.indexOf('.ns-launcher{');
    const sheet = INDEX.slice(from, INDEX.indexOf('</style>', from));
    assert.match(sheet, /body:has\(\.modal-overlay\.open\) \.ns-launcher,/, 'modal-overlay dialogs');
    assert.match(sheet, /body:has\(\.deposit-modal\.open\) \.ns-launcher\{display:none\}/, 'deposit/onboarding/support dialogs');
    assert.match(sheet, /body:has\(#pwaInstallPrompt:not\(\.hidden\)\) \.ns-launcher\{display:none\}/,
        'the one-time install banner owns the bottom strip on a phone');
});

test('18b. the phone override keeps the launcher low and inset from the safe area', () => {
    const from = INDEX.indexOf('.ns-launcher{');
    const sheet = INDEX.slice(from, INDEX.indexOf('</style>', from));
    const blocks = (sheet.match(/@media \(max-width:640px\)\{[\s\S]*?\n\}/g) || [])
        .filter((b) => /\.ns-launcher\{[^}]*right:14px/.test(b));   // not the RTL override
    assert.ok(blocks.length >= 1, 'a phone block styles the launcher');
    const rule = /\.ns-launcher\{([^}]*)\}/.exec(blocks[0])[1];
    assert.match(rule, /right:14px/, 'still the right corner');
    assert.match(rule, /bottom:calc\(18px \+ env\(safe-area-inset-bottom/, 'lower than the 80px toast band');
});

test('19. an account change re-reads the badge immediately (no stale count, no rate-limit wait)', () => {
    // The 5s refresh rate limit belongs to the previous account; a switch must not
    // inherit it, or the new account would see no count until the next tick.
    const sync = WIDGET.slice(WIDGET.indexOf('sync: function'), WIDGET.indexOf('window.NativeSupport = NativeSupport'));
    assert.match(sync, /var accountChanged = shouldResetAccount\(state\.identity, identity\)/);
    assert.match(sync, /refreshBadge\(accountChanged\)/,
        'forced when the identity changed, rate-limited otherwise');
    assert.ok(sync.indexOf('resetAccountState()') < sync.indexOf('refreshBadge(accountChanged)'),
        'the reset happens first, so the count belongs to the new account');
});

test('17. no "Talk to a human" affordance is reintroduced', () => {
    assert.doesNotMatch(WIDGET, /talk to a human/i);
    assert.doesNotMatch(/<section class="ns-panel"[\s\S]{0,4000}/.exec(INDEX) || '', /talk to a human/i);
});
