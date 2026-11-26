'use strict';

/**
 * Regression tests for the CUSTOMER messenger widget (public/native-support.js).
 *
 * They run the REAL widget in a vm against a minimal DOM, so the behaviours the
 * production investigation found are pinned:
 *   - activation after /api/auth/me (and NOT only at page load),
 *   - deactivation on logout, with no duplicate nodes/listeners on re-sync,
 *   - server-id dedupe when polling,
 *   - reconciliation of the optimistic bubble with its persisted row,
 *   - one in-flight submission at a time.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WIDGET = fs.readFileSync(path.join(ROOT, 'public', 'native-support.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVICE = fs.readFileSync(path.join(ROOT, 'services', 'NativeSupport.js'), 'utf8');

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
        addEventListener(ev, fn) { (node.listeners[ev] = node.listeners[ev] || []).push(fn); },
        dispatch(ev) { (node.listeners[ev] || []).slice().forEach((fn) => fn({ key: ev, preventDefault() {} })); },
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
            return walk(node);              // descendant search, like the real DOM
        },
        querySelectorAll() { return []; }
    };
    return node;
}

const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- harness
function boot(config) {
    const cfg = config || {};
    const body = makeEl('body');
    const winListeners = {};
    const calls = [];
    const intervals = [];
    const pending = { resolve: null };
    const state = {
        conversations: cfg.conversations || [],
        messages: cfg.messages || [],
        nextId: 100,
        ignoreAfter: false,
        rowFor: cfg.rowFor || null
    };

    function jsonRes(payload, status) {
        return { ok: (status || 200) < 400, status: status || 200, json: () => Promise.resolve(payload) };
    }

    function fetchImpl(url, opts) {
        const o = opts || {};
        const method = o.method || 'GET';
        const parsed = o.body ? JSON.parse(o.body) : null;
        const u = String(url);
        calls.push({ method, url: u, body: parsed });

        if (u === '/api/support/conversations' && method === 'GET') {
            return Promise.resolve(jsonRes({ ok: true, conversations: state.conversations }));
        }
        if (u === '/api/support/conversations' && method === 'POST') {
            const conv = { id: 900, status: 'open', unread_for_customer: 0 };
            state.conversations = [conv];
            return Promise.resolve(jsonRes({ ok: true, conversation: conv }, 201));
        }
        if (/\/messages\?after=\d+$/.test(u)) {
            const after = state.ignoreAfter ? 0 : Number(u.split('after=')[1]);
            return Promise.resolve(jsonRes({ ok: true, conversation: { id: 900 }, messages: state.messages.filter((m) => m.id > after) }));
        }
        if (/\/messages$/.test(u) && method === 'POST') {
            const row = state.rowFor
                ? state.rowFor(parsed)
                : { id: ++state.nextId, conversation_id: 900, sender_type: 'customer', body: parsed.body, client_message_id: parsed.clientMessageId, created_at: new Date().toISOString() };
            state.messages.push(row);
            state.lastPost = row;
            // HUMAN-ONLY: the only automatic message is the static acknowledgement.
            const reply = {
                id: ++state.nextId, conversation_id: 900, sender_type: 'system',
                body: "Thank you for contacting Kalderix. We've received your message and our support team will respond as soon as possible.",
                created_at: new Date().toISOString()
            };
            state.messages.push(reply);
            const payload = { ok: true, conversationId: 900, message: row, reply: reply };
            if (cfg.slowPost) {
                return new Promise((resolve) => { pending.resolve = () => resolve(jsonRes(payload, 201)); });
            }
            return Promise.resolve(jsonRes(payload, 201));
        }
        if (/\/read$/.test(u)) return Promise.resolve(jsonRes({ ok: true }));
        return Promise.resolve(jsonRes({ ok: true }));
    }

    const sandbox = {
        console,
        JSON,
        Math,
        Date,
        Object,
        Array,
        Number,
        String,
        setTimeout: (fn) => { fn(); return 0; },     // the widget's load hook runs at once
        clearTimeout: () => {},
        setInterval: (fn) => { intervals.push(fn); return intervals.length; },
        clearInterval: () => {},
        fetch: fetchImpl,
        localStorage: { getItem: () => 'test-token', setItem() {}, removeItem() {} },
        document: {
            body,
            createElement: (tag) => makeEl(tag),
            getElementById: () => null,
            querySelector: () => null
        },
        APP: { nativeSupport: false },
        t: (key) => key
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
        intervals,
        state,
        fireLoad() { (winListeners.load || []).forEach((fn) => fn()); },
        widget: () => sandbox.window.NativeSupport,
        launchers: () => body.children.filter((c) => String(c.className).split(/\s+/).includes('ns-launcher')),
        panels: () => body.children.filter((c) => String(c.className).split(/\s+/).includes('ns-panel')),
        resolvePost() { if (pending.resolve) pending.resolve(); }
    };
}

async function openWithConversation(h) {
    h.sandbox.APP.nativeSupport = true;
    h.widget().sync();
    h.widget().open();
    await flush(); await flush();
}

function composer(h) {
    const panel = h.panels()[0];
    const foot = panel ? panel.children.find((c) => String(c.className) === 'ns-foot') : null;
    const row = foot ? foot.querySelector('.ns-row') : null;
    if (!row) return null;
    return { input: row.children[0], send: row.querySelector('.ns-send') || row.children[1] };
}

function messageNodes(h) {
    const panel = h.panels()[0];
    const body = panel ? panel.children.find((c) => String(c.className) === 'ns-body') : null;
    return body ? body.children.filter((c) => String(c.className).includes('ns-msg')) : [];
}

// ------------------------------------------------------------------ tests
test('1. activation happens on sync(), not only at page load', () => {
    const h = boot();
    h.fireLoad();                                   // the module's own load-time sync()
    assert.strictEqual(h.launchers().filter((l) => l.classList.contains('show')).length, 0,
        'no launcher before APP.nativeSupport is known');
    assert.strictEqual(h.body.classList.contains('ns-enabled'), false, 'legacy widget stays visible');

    h.sandbox.APP.nativeSupport = true;             // what syncWalletFromServer() does
    h.widget().sync();

    assert.strictEqual(h.launchers().filter((l) => l.classList.contains('show')).length, 1, 'launcher shown after login sync');
    assert.strictEqual(h.body.classList.contains('ns-enabled'), true, 'legacy widget hidden (CSS hooks on this class)');
});

test('2. repeated sync() does not duplicate nodes or listeners', () => {
    const h = boot();
    h.sandbox.APP.nativeSupport = true;
    h.widget().sync();
    h.widget().sync();
    h.widget().sync();
    assert.strictEqual(h.launchers().length, 1);
    assert.strictEqual(h.panels().length, 1);
    const launcherListeners = h.launchers()[0].listeners.click.length;
    assert.strictEqual(launcherListeners, 1, 'one click handler, no duplicate');
});

test('3. logout deactivates the widget and keeps it re-activatable', () => {
    const h = boot();
    h.sandbox.APP.nativeSupport = true;
    h.widget().sync();
    assert.strictEqual(h.body.classList.contains('ns-enabled'), true);

    h.sandbox.APP.nativeSupport = false;            // logout
    h.widget().sync();
    assert.strictEqual(h.body.classList.contains('ns-enabled'), false, 'legacy widget returns after logout');
    assert.strictEqual(h.launchers().filter((l) => l.classList.contains('show')).length, 0);
    assert.strictEqual(h.launchers().length, 1, 'the DOM is reused, not rebuilt');

    h.sandbox.APP.nativeSupport = true;             // next login in the same tab
    h.widget().sync();
    assert.strictEqual(h.launchers().filter((l) => l.classList.contains('show')).length, 1);
});

test('4. polling cannot render the same server row twice', async () => {
    const h = boot({ conversations: [{ id: 900, status: 'open', unread_for_customer: 0 }] });
    await openWithConversation(h);
    h.state.messages = [
        { id: 100, sender_type: 'customer', body: 'hello', created_at: new Date().toISOString() },
        { id: 101, sender_type: 'ai', body: 'hi', created_at: new Date().toISOString() }
    ];
    h.state.ignoreAfter = true;                     // the server keeps returning the same page
    await h.widget().refresh();
    const first = messageNodes(h).length;
    await h.widget().refresh();
    await h.widget().refresh();
    assert.strictEqual(first, 2);
    assert.strictEqual(messageNodes(h).length, 2, 'deduped by server id');
});

test('5. the optimistic bubble is adopted by its persisted row (no duplicate)', async () => {
    const h = boot({ conversations: [{ id: 900, status: 'open', unread_for_customer: 0 }], slowPost: true });
    await openWithConversation(h);
    const c = composer(h);
    assert.ok(c, 'composer rendered');
    c.input.value = 'how do I deposit';
    c.send.dispatch('click');

    const customer = () => messageNodes(h).filter((n) => String(n.className).includes('customer'));
    assert.strictEqual(messageNodes(h).length, 1, 'optimistic bubble');
    assert.strictEqual(c.send.disabled, true, 'send disabled while pending');

    // The poll runs while the POST is still in flight and returns the row (and,
    // in this fixture, the AI reply that already exists server-side).
    await h.widget().refresh();
    assert.strictEqual(customer().length, 1, 'poll reconciled instead of appending a copy');
    assert.strictEqual(String(customer()[0].className).includes('pending'), false, 'adopted, not pending');
    assert.strictEqual(messageNodes(h).length, 2, 'customer bubble + reply');

    h.resolvePost();
    await flush(); await flush();
    assert.strictEqual(customer().length, 1, 'the POST response did not add a second bubble');
    assert.strictEqual(messageNodes(h).length, 2, 'and did not duplicate the reply');
    assert.strictEqual(c.send.disabled, false, 'send re-enabled');
});

test('6. a second submission is ignored while the first is pending', async () => {
    const h = boot({ conversations: [{ id: 900, status: 'open', unread_for_customer: 0 }], slowPost: true });
    await openWithConversation(h);
    const c = composer(h);
    c.input.value = 'first';
    c.send.dispatch('click');
    c.input.value = 'second';
    c.send.dispatch('click');
    const posts = h.calls.filter((x) => x.method === 'POST' && /\/messages$/.test(x.url));
    assert.strictEqual(posts.length, 1, 'only one POST while pending');
    assert.strictEqual(posts[0].body.body, 'first');
    h.resolvePost();
    await flush();
    c.input.value = 'third';
    c.send.dispatch('click');
    assert.strictEqual(h.calls.filter((x) => x.method === 'POST' && /\/messages$/.test(x.url)).length, 2,
        'a new message is accepted once the previous one settled');
});

test('7. wiring: activation after /api/auth/me, deactivation on logout, legacy hidden', () => {
    const flagAt = INDEX.indexOf('APP.nativeSupport = data.nativeSupport === true;');
    assert.ok(flagAt > 0, 'the flag is adopted from /api/auth/me');
    const around = INDEX.slice(flagAt, flagAt + 700);
    assert.match(around, /NativeSupport\.sync\(\)/,
        'sync() runs immediately after the flag is adopted (not only at page load)');

    const logoutAt = INDEX.indexOf("localStorage.removeItem('jwt_token');\n            localStorage.removeItem('arbi_user');");
    assert.ok(logoutAt > 0, 'logout block located');
    // The teardown runs with the rest of the session reset (after the token is
    // cleared), so the auth page cannot keep a logged-in support surface open.
    const after = INDEX.slice(logoutAt, logoutAt + 1500);
    assert.match(after, /APP\.nativeSupport = false;/);
    assert.match(after, /NativeSupport\.sync\(\)/);

    assert.match(INDEX, /body\.ns-enabled \.support-widget\{display:none\}/,
        'the legacy floating assistant is hidden while native support is enabled');

    assert.match(SERVICE, /select\('id, conversation_id, sender_type, body, created_at, client_message_id'\)/,
        'the API exposes client_message_id so reconciliation is exact');
});

test('8. opening with no thread shows the static welcome and creates NOTHING yet', async () => {
    const h = boot();
    h.sandbox.APP.nativeSupport = true;
    h.widget().sync();
    h.widget().open();
    await flush(); await flush();

    const nodes = messageNodes(h);
    assert.strictEqual(nodes.length, 1, 'one interface message');
    assert.match(String(nodes[0].children[0].textContent), /Welcome to Kalderix Support/);
    assert.strictEqual(String(nodes[0].className).includes('system'), true, 'never presented as an agent');
    assert.strictEqual(h.calls.filter((x) => x.method === 'POST' && x.url === '/api/support/conversations').length, 0,
        'reading the welcome does not open an empty conversation for the agents');
});

test('9. the first message creates the conversation, then posts, and shows the acknowledgement', async () => {
    const h = boot();
    h.sandbox.APP.nativeSupport = true;
    h.widget().sync();
    h.widget().open();
    await flush();

    const c = composer(h);
    assert.ok(c, 'the composer is available immediately');
    c.input.value = 'Where do I find my deposit address?';
    c.send.dispatch('click');
    await flush(); await flush(); await flush();

    // `markRead` rides along with the create; only the two writes matter here.
    const posts = h.calls.filter((x) => x.method === 'POST' && !/\/read$/.test(x.url)).map((x) => x.url);
    assert.deepStrictEqual(posts, ['/api/support/conversations', '/api/support/conversations/900/messages'],
        'the conversation is created lazily, then the message is posted');

    const nodes = messageNodes(h);
    const customer = nodes.filter((n) => String(n.className).includes('customer'));
    assert.strictEqual(customer.length, 1, 'exactly one customer bubble');
    const ack = nodes.filter((n) => String(n.className).includes('system'));
    assert.ok(ack.length >= 1, 'the acknowledgement is in the transcript');
    assert.ok(nodes.some((n) => /We've received your message/.test(String(n.children[0].textContent))),
        'the customer is told the team has the message');
    assert.strictEqual(nodes.some((n) => String(n.className).includes('ai')), false, 'no automated answer');
});

test('10. reopening a thread renders its history without repeating the welcome', async () => {
    const h = boot({
        conversations: [{ id: 900, status: 'open', unread_for_customer: 0 }],
        messages: [
            { id: 100, sender_type: 'customer', body: 'my deposit is missing', created_at: new Date().toISOString() },
            { id: 101, sender_type: 'system', body: 'We have received your message.', created_at: new Date().toISOString() },
            { id: 102, sender_type: 'agent', body: 'Checking now.', via: 'telegram', created_at: new Date().toISOString() }
        ]
    });
    await openWithConversation(h);
    const nodes = messageNodes(h);
    assert.strictEqual(nodes.length, 3, 'the whole history is rendered');
    assert.ok(!nodes.some((n) => /Welcome to Kalderix Support/.test(String(n.children[0].textContent))),
        'the welcome is only for an empty thread');
    const agent = nodes.find((n) => String(n.className).includes('agent'));
    assert.strictEqual(agent.attrs['data-via'], 'telegram', 'the reply keeps its channel of origin');
});
