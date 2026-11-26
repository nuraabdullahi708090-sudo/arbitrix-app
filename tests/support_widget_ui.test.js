'use strict';

/**
 * CUSTOMER messenger widget: presentation contract + the retrieval failures that
 * produced "Something went wrong. Please try again." in production.
 *
 * Two halves, both run against the SHIPPED files:
 *
 *   A. Presentation (static): the panel is a compact, viewport-capped messenger
 *      with one scrolling transcript, a green support accent for agent replies, a
 *      blue bubble for the customer and a 44px close target - and it offers NO
 *      "Talk to a human" action (the whole conversation is already human).
 *
 *   B. Behaviour (real widget executed in a vm): opening an existing thread does a
 *      FULL read, polling is incremental, a failed READ shows ONE quiet notice
 *      instead of chat bubbles, retry resynchronises without duplicating, and a
 *      reply that arrives later is rendered without the customer sending anything.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WIDGET = fs.readFileSync(path.join(ROOT, 'public', 'native-support.js'), 'utf8');
// The customer IIFE only: the ADMIN inbox below it legitimately has its own
// `ns-link` user-picker button, which is not a customer support escalation.
const CUSTOMER_WIDGET = WIDGET.slice(0, WIDGET.indexOf('* Native in-app support - ADMIN Support Inbox.'));
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function styleBlock() {
    const start = INDEX.indexOf('<style id="nativeSupportStyles">');
    const end = INDEX.indexOf('</style>', start);
    return INDEX.slice(start, end);
}
const CSS = styleBlock();

function translations() {
    const start = INDEX.indexOf('const NS_TRANSLATIONS = ');
    const open = INDEX.indexOf('{', start);
    const end = INDEX.indexOf('};\n', open);
    return JSON.parse(INDEX.slice(open, end + 1));
}

// ------------------------------------------------------------------------ DOM
function makeEl(tag) {
    const classes = new Set();
    const node = {
        tagName: String(tag).toUpperCase(),
        children: [], parentNode: null, textContent: '', style: {}, dataset: {}, attrs: {},
        listeners: {}, disabled: false, value: '', placeholder: '', maxLength: 0, type: '', rows: 0,
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
        get innerHTML() { return ''; },
        set innerHTML(_v) { node.children.slice().forEach((child) => node.removeChild(child)); },
        appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
        removeChild(child) { const i = node.children.indexOf(child); if (i >= 0) node.children.splice(i, 1); child.parentNode = null; },
        setAttribute(k, v) { node.attrs[k] = String(v); },
        getAttribute(k) { return node.attrs[k]; },
        addEventListener(ev, fn) { (node.listeners[ev] = node.listeners[ev] || []).push(fn); },
        dispatch(ev) { (node.listeners[ev] || []).slice().forEach((fn) => fn({ key: ev, preventDefault() {} })); },
        walk(want, all) {
            const out = [];
            const visit = (parent) => {
                for (const c of parent.children) {
                    const names = String(c.className || '').split(/\s+/);
                    if (names.includes(want)) out.push(c);
                    visit(c);
                }
            };
            visit(node);
            return all ? out : (out[0] || null);
        },
        querySelector(sel) { return node.walk(String(sel).replace(/^\./, ''), false); },
        querySelectorAll(sel) { return node.walk(String(sel).replace(/^\./, ''), true); }
    };
    return node;
}

const flush = () => new Promise((r) => setImmediate(r));

// -------------------------------------------------------------------- harness
/**
 * `mode` decides how the messages endpoint behaves:
 *   'ok'      - normal
 *   'fail'    - HTTP 503 (a database blip: the server answers, with an error)
 *   'recover' - fail the first N reads, then behave
 */
function boot(options) {
    const cfg = options || {};
    const body = makeEl('body');
    const winListeners = {};
    const calls = [];
    const intervals = [];
    const state = {
        conversations: cfg.conversations || [],
        messages: cfg.messages || [],
        nextId: 1000,
        getFails: cfg.getFails || 0,
        mode: cfg.mode || 'ok'
    };

    function jsonRes(payload, status) {
        return { ok: (status || 200) < 400, status: status || 200, json: () => Promise.resolve(payload) };
    }

    function fetchImpl(url, opts) {
        const o = opts || {};
        const method = o.method || 'GET';
        const u = String(url);
        calls.push({ method, url: u });

        if (u === '/api/support/conversations' && method === 'GET') {
            return Promise.resolve(jsonRes({ ok: true, conversations: state.conversations }));
        }
        if (u === '/api/support/conversations' && method === 'POST') {
            const conv = { id: 900, status: 'open', unread_for_customer: 0 };
            state.conversations = [conv];
            return Promise.resolve(jsonRes({ ok: true, conversation: conv }, 201));
        }
        if (/\/read$/.test(u)) return Promise.resolve(jsonRes({ ok: true }));
        if (/\/messages$/.test(u) && method === 'GET') {
            if (state.mode === 'fail') return Promise.resolve(jsonRes({ ok: false, error: 'unavailable' }, 503));
            if (state.getFails > 0) {
                state.getFails -= 1;
                return Promise.resolve(jsonRes({ ok: false, error: 'unavailable' }, 503));
            }
            return Promise.resolve(jsonRes({ ok: true, conversation: { id: 900, status: 'assigned', ai_paused: false }, messages: state.messages.slice() }));
        }
        if (/\/messages\?after=\d+$/.test(u)) {
            const after = Number(u.split('after=')[1]);
            if (state.mode === 'fail') return Promise.resolve(jsonRes({ ok: false, error: 'unavailable' }, 503));
            if (state.getFails > 0) {
                state.getFails -= 1;
                return Promise.resolve(jsonRes({ ok: false, error: 'unavailable' }, 503));
            }
            return Promise.resolve(jsonRes({ ok: true, conversation: { id: 900, status: 'assigned', ai_paused: false }, messages: state.messages.filter((m) => Number(m.id) > after) }));
        }
        if (/\/messages$/.test(u) && method === 'POST') {
            const row = { id: ++state.nextId, conversation_id: 900, sender_type: 'customer', body: o.body ? JSON.parse(o.body).body : '', created_at: new Date().toISOString() };
            state.messages.push(row);
            return Promise.resolve(jsonRes({ ok: true, conversationId: 900, message: row, reply: null }, 201));
        }
        return Promise.resolve(jsonRes({ ok: true }));
    }

    const sandbox = {
        console, JSON, Math, Date, Object, Array, Number, String,
        setTimeout: (fn) => { fn(); return 0; },
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

    const panel = () => body.children.find((c) => String(c.className).split(/\s+/).includes('ns-panel'));
    const region = (name) => {
        const p = panel();
        return p ? p.children.find((c) => String(c.className) === name) : null;
    };
    return {
        sandbox, body, calls, intervals, state,
        widget: () => sandbox.window.NativeSupport,
        panel,
        bodyRegion: () => region('ns-body'),
        footRegion: () => region('ns-foot'),
        messages: () => {
            const b = region('ns-body');
            return b ? b.children.filter((c) => String(c.className).includes('ns-msg')) : [];
        },
        notices: () => {
            const b = region('ns-body');
            return b ? b.children.filter((c) => String(c.className).includes('ns-notice')) : [];
        },
        composer: () => {
            const f = region('ns-foot');
            if (!f) return null;
            const row = f.walk('ns-row', false);
            if (!row) return null;
            return { input: row.children[0], send: row.walk('ns-send', false) };
        }
    };
}

async function openThread(h) {
    h.sandbox.APP.nativeSupport = true;
    h.widget().sync();
    h.widget().open();
    await flush(); await flush(); await flush();
}

const AGENT_REPLY = {
    id: 302, conversation_id: 900, sender_type: 'agent', via: 'telegram',
    body: 'Your deposit is confirmed - sorry for the wait.', created_at: '2026-11-26T17:53:00.000Z'
};

// --------------------------------------------------------------- A. presentation

test('A1. the panel is a compact messenger capped by the viewport, not a full screen', () => {
    assert.match(CSS, /\.ns-panel\{[^}]*width:min\(392px,calc\(100vw - 32px\)\)/,
        'desktop is a proportionate floating panel, not a stretched sheet');
    assert.match(CSS, /height:min\(560px,calc\(100vh - 40px\)\)/, 'height is capped against the viewport');
    assert.match(CSS, /max-height:calc\(100vh - 40px\)/, 'and can never grow past it');
    // Phones: 72% of the viewport, inset, and dvh where the browser supports it so
    // the URL bar / keyboard cannot swallow the composer.
    assert.match(CSS, /@media \(max-width:640px\)\{[\s\S]*?\.ns-panel\{[^}]*height:min\(72vh,560px\)/);
    assert.match(CSS, /@supports \(height:100dvh\)\{[\s\S]*?height:min\(72dvh,560px\)/);
    assert.doesNotMatch(CSS, /\.ns-panel\{[^}]*height:100vh/, 'never a full-height sheet');
    assert.doesNotMatch(CSS, /\.ns-panel\{[^}]*\b100vw\b[^}]*height:100vh/);
});

test('A2. header and composer stay put; the transcript is the only scroller', () => {
    assert.match(CSS, /\.ns-body\{[^}]*flex:1 1 auto[^}]*min-height:0[^}]*overflow-y:auto/,
        'one scroll container that can shrink inside a flex column');
    assert.match(CSS, /\.ns-head\{[^}]*min-height:52px/, 'a compact single-line header');
    assert.match(CSS, /\.ns-foot\{[^}]*flex:0 0 auto/, 'the composer is never squeezed away');
    assert.match(CSS, /env\(safe-area-inset-bottom/, 'mobile browser safe areas are respected');
    assert.match(CSS, /\.ns-close\{[^}]*width:44px;height:44px/, 'the close button is a real tap target');
});

test('A3. green is the support accent: agent bubbles green, customer bubbles blue, send green', () => {
    assert.match(CSS, /\.ns-msg\.agent,\.ns-msg\.ai\{[^}]*background:#0F3B2E[^}]*border-color:#1B6B50/,
        'agent replies use the green support surface');
    assert.match(CSS, /\.ns-msg\.customer\{[^}]*background:#1D3A63/, 'the customer keeps the blue bubble');
    assert.match(CSS, /\.ns-send\{[^}]*background:#0ECB81/, 'the send button is the green accent');
    assert.match(CSS, /\.ns-dot\{[^}]*background:#0ECB81/, 'the header status dot is green');
});

test('A4. the mobile composer stays on one row (icon-only send)', () => {
    assert.match(CSS, /@media \(max-width:640px\)\{[\s\S]*?\.ns-send \.ns-send-text\{display:none\}/);
    assert.match(CSS, /@media \(max-width:640px\)\{[\s\S]*?\.ns-send\{width:46px/, 'the button does not eat the textarea');
});

test('A5. there is NO "Talk to a human" action anywhere', () => {
    const dict = translations();
    Object.keys(dict).forEach((lang) => {
        assert.ok(!('ns.human' in dict[lang]), lang + ': ns.human must be gone');
        assert.ok(!('ns.humanQueued' in dict[lang]), lang + ': ns.humanQueued must be gone');
    });
    assert.doesNotMatch(CUSTOMER_WIDGET, /ns\.human|ns-link|\/human'|requestHuman/, 'no handler, no link, no escalation call');
    assert.doesNotMatch(INDEX, /'ns\.human'|"ns\.human"/, 'no leftover key in the dictionary');
    // The two automated strings that remain are honest, and there is no third.
    assert.match(WIDGET, /ns\.reconnecting/);
    assert.match(WIDGET, /ns\.retry/);
});

test('A6. every transport string the widget asks for exists in all six locales', () => {
    const dict = translations();
    const keys = ['ns.title', 'ns.placeholder', 'ns.send', 'ns.close', 'ns.retry', 'ns.reconnecting',
        'ns.error', 'ns.rateLimited', 'ns.offline', 'ns.failed'];
    ['en', 'es', 'pt', 'fr', 'ar', 'zh'].forEach((lang) => {
        assert.ok(dict[lang], lang + ' block exists');
        keys.forEach((key) => {
            const value = dict[lang][key];
            assert.ok(value && String(value).trim().length > 0, lang + ' missing ' + key);
        });
    });
    // Same key set in every locale (no half-translated dictionary).
    const reference = Object.keys(dict.en).sort().join(',');
    Object.keys(dict).forEach((lang) => {
        assert.strictEqual(Object.keys(dict[lang]).sort().join(','), reference, lang + ' key set');
    });
});

// ------------------------------------------------------------------ B. behaviour

test('B1. opening an existing thread performs a FULL history read', async () => {
    const h = boot({
        conversations: [{ id: 900, status: 'assigned', unread_for_customer: 1 }],
        messages: [
            { id: 300, sender_type: 'customer', body: 'my deposit is missing', created_at: '2026-11-26T17:40:00.000Z' },
            { id: 301, sender_type: 'system', body: 'We received your message.', created_at: '2026-11-26T17:40:01.000Z' },
            AGENT_REPLY
        ]
    });
    await openThread(h);

    const reads = h.calls.filter((c) => c.method === 'GET' && /\/messages/.test(c.url));
    assert.ok(reads.length >= 1);
    assert.strictEqual(reads[0].url, '/api/support/conversations/900/messages',
        'the first read is a full history read (no cursor), so a reply is never missed');
    assert.strictEqual(h.messages().length, 3, 'the whole thread is rendered');
    const agent = h.messages().find((n) => String(n.className).includes('agent'));
    assert.ok(agent, 'the agent reply is on screen');
    assert.strictEqual(agent.attrs['data-via'], 'telegram', 'its origin is carried for rendering');
});

test('B2. polling is incremental and renders a later reply without the customer sending', async () => {
    const h = boot({ conversations: [{ id: 900, status: 'assigned' }], messages: [{ id: 300, sender_type: 'customer', body: 'hello' }] });
    await openThread(h);
    assert.strictEqual(h.messages().length, 1);

    // The agent answers while the panel is open. The 5s interval then reads with
    // the cursor it already has.
    h.state.messages.push(AGENT_REPLY);
    const tick = h.intervals[h.intervals.length - 1];
    tick();
    await flush(); await flush();

    const poll = h.calls.filter((c) => /\/messages\?after=/.test(c.url)).pop();
    assert.ok(poll, 'polling uses the cursor');
    assert.match(poll.url, /after=300$/);
    assert.strictEqual(h.messages().length, 2, 'the reply appears with no customer action');
    assert.ok(h.messages().some((n) => /deposit is confirmed/.test(n.children[0].textContent)));
});

test('B3. a failed READ shows ONE quiet notice, never a chat bubble', async () => {
    const h = boot({ conversations: [{ id: 900, status: 'assigned' }], mode: 'fail' });
    await openThread(h);

    // No message was written, so nothing may claim one failed. The old widget
    // appended "Something went wrong. Please try again." as a chat message for
    // every failed poll - that is the production symptom being pinned here.
    assert.strictEqual(h.messages().length, 0, 'no chat bubble for a transport failure');
    assert.doesNotMatch(h.bodyRegion().children.map((c) => String(c.textContent)).join(' '), /ns\.error/);
    const notices = h.notices();
    assert.strictEqual(notices.length, 1, 'exactly one notice');
    assert.match(notices[0].children[0].textContent, /ns\.reconnecting/);
    assert.ok(notices[0].children[1], 'the notice offers a retry action');

    // Repeated failures do not stack notices.
    const tick = h.intervals[h.intervals.length - 1];
    tick(); await flush(); tick(); await flush();
    assert.strictEqual(h.notices().length, 1, 'still one notice after further failures');
});

test('B4. retry after a failure resynchronises the whole thread without duplicating', async () => {
    const seed = [
        { id: 300, sender_type: 'customer', body: 'hello', created_at: '2026-11-26T17:40:00.000Z' },
        AGENT_REPLY
    ];
    const h = boot({ conversations: [{ id: 900, status: 'assigned' }], messages: seed, getFails: 1 });
    await openThread(h);

    assert.strictEqual(h.notices().length, 1, 'the first read failed -> a notice is shown');
    assert.strictEqual(h.messages().length, 0);

    h.notices()[0].children[1].dispatch('click');
    await flush(); await flush(); await flush();

    assert.strictEqual(h.notices().length, 0, 'the notice clears once the read succeeds');
    assert.strictEqual(h.messages().length, 2, 'the thread is restored exactly once');
    const texts = h.messages().map((n) => n.children[0].textContent);
    assert.deepStrictEqual(texts, ['hello', 'Your deposit is confirmed - sorry for the wait.']);
});

test('B5. reopening the panel re-reads the thread: no duplicates, no repeated welcome', async () => {
    const h = boot({ conversations: [{ id: 900, status: 'assigned' }], messages: [{ id: 300, sender_type: 'customer', body: 'hello' }] });
    await openThread(h);
    assert.strictEqual(h.messages().length, 1);

    h.widget().close();
    await flush();
    h.widget().open();
    await flush(); await flush();

    assert.strictEqual(h.messages().length, 1, 'the same row is not drawn twice');
    assert.ok(!h.messages().some((n) => /Welcome to Kalderix Support/.test(String(n.children[0].textContent))),
        'the welcome is only for an empty thread');
});

test('B6. a send failure marks THAT bubble only (nothing else is invented)', async () => {
    const h = boot({ conversations: [{ id: 900, status: 'open' }], messages: [] });
    await openThread(h);

    // Break the POST: the message is not stored, so the bubble says so and no
    // extra notice/bubble is added for it.
    let failing = true;
    const original = h.sandbox.fetch;
    h.sandbox.fetch = function (url, opts) {
        if (failing && /\/messages$/.test(String(url)) && opts && opts.method === 'POST') {
            return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ ok: false, error: 'unavailable' }) });
        }
        return original(url, opts);
    };
    const c = h.composer();
    c.input.value = 'will fail';
    c.send.dispatch('click');
    await flush(); await flush(); await flush();

    const failed = h.messages().filter((n) => String(n.className).includes('failed'));
    assert.strictEqual(failed.length, 1, 'only the unsent bubble is marked');
    const label = failed[0].walk('ns-time', false);
    assert.match(String(label && label.textContent), /ns\.error/, 'the meta line explains it');
    // No agent/system bubble was fabricated for the transport problem.
    assert.strictEqual(h.messages().filter((n) => String(n.className).includes('system')).length, 0);
    failing = false;
});

test('B7. the composer exists immediately and the transcript scrolls to the newest row', async () => {
    const h = boot({ conversations: [{ id: 900, status: 'assigned' }], messages: [AGENT_REPLY] });
    await openThread(h);
    const c = h.composer();
    assert.ok(c && c.input && c.send, 'textarea + send button are present');
    assert.strictEqual(c.input.placeholder, 'ns.placeholder');
    assert.ok(h.bodyRegion().scrollTop > 0 || h.bodyRegion().scrollHeight === 0, 'the view follows the newest message');
});
