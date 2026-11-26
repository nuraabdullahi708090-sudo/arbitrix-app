'use strict';

/**
 * The in-app support chat is the platform's ONE customer support surface.
 *
 * These tests pin the consolidation, so a future change cannot quietly bring a
 * Telegram hand-off (or a second support destination) back:
 *
 *   - every "contact support" control in the app goes through kxOpenSupport();
 *   - the messenger is tried first and the Support Center is only its fallback;
 *   - the reason the customer arrived travels as a context (deposit,
 *     withdrawal, trading, account) and is applied to the conversation;
 *   - the ?support= deep link used by the static pages is honoured once the
 *     messenger is actually available, then removed from the URL;
 *   - no customer-facing page publishes a Telegram support destination (the
 *     bot remains an INTERNAL agent interface on the server).
 *
 * The functions are the REAL ones, executed in a vm against the real markup, so
 * the assertions cannot drift from the shipped page.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const INDEX = read('public/index.html');
const WIDGET = read('public/native-support.js');
const PARTNERS = read('public/partners.html');
const TERMS = read('public/terms-of-service.html');
const PRIVACY = read('public/privacy-policy.html');

const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

/* ------------------------------------------------------------------ helpers */

/** Extract a top-level `function name(...) { ... }` body from a source file. */
function extractFunction(source, name) {
    const start = source.indexOf('function ' + name + '(');
    assert.notStrictEqual(start, -1, 'function ' + name + ' must exist');
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced function ' + name);
}

/** The real dictionary, evaluated the way the browser evaluates it. */
function dictionary() {
    const start = INDEX.indexOf('const TRANSLATIONS = {');
    assert.ok(start > 0, 'TRANSLATIONS must exist');
    let depth = 0;
    for (let i = INDEX.indexOf('{', start); i < INDEX.length; i += 1) {
        if (INDEX[i] === '{') depth += 1;
        else if (INDEX[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                const literal = INDEX.slice(INDEX.indexOf('{', start), i + 1);
                const T = vm.runInNewContext('(' + literal + ')');
                // The page merges the messenger dictionary over the main one at
                // run time; mirror that here so ns.* keys are visible.
                const nsStart = INDEX.indexOf('const NS_TRANSLATIONS = ');
                if (nsStart > 0) {
                    const nsLiteral = INDEX.slice(INDEX.indexOf('{', nsStart),
                        INDEX.indexOf('};', nsStart) + 1);
                    const NS = vm.runInNewContext('(' + nsLiteral + ')');
                    Object.keys(NS).forEach((lang) => {
                        if (!T[lang]) T[lang] = {};
                        Object.keys(NS[lang]).forEach((key) => { T[lang][key] = NS[lang][key]; });
                    });
                }
                return T;
            }
        }
    }
    throw new Error('unbalanced TRANSLATIONS');
}

/** The real module-scope declaration the entry-point functions read. */
function contextDeclaration() {
    const line = INDEX.split('\n').find((l) => l.indexOf('var KX_SUPPORT_CONTEXTS = {') === 0);
    assert.ok(line, 'KX_SUPPORT_CONTEXTS must be declared at module scope');
    return line.trim();
}

/** A sandbox that runs the real entry-point functions. */
function supportSandbox(opts) {
    const o = opts || {};
    const calls = { native: [], modal: 0, closed: 0 };
    const sandbox = {
        APP: { nativeSupport: o.nativeSupport === true, supportContext: null },
        location: o.location || { search: '', hash: '', href: 'https://arbitrix.pro/' },
        history: { replaceState: (...args) => calls.replace = args },
        URL: URL,
        URLSearchParams: URLSearchParams,
        String: String,
        Object: Object
    };
    if (o.nativeSupport === true) {
        sandbox.NativeSupport = {
            open: (arg) => {
                calls.native.push(arg);
                return o.nativeReturns === false ? false : true;
            }
        };
    }
    sandbox.closeSupportModal = () => { calls.closed += 1; };
    sandbox.openSupportModal = () => { calls.modal += 1; };
    vm.createContext(sandbox);
    vm.runInContext(
        contextDeclaration() + '\n' +
        extractFunction(INDEX, 'kxSupportContext') + '\n' +
        extractFunction(INDEX, 'kxNativeSupportReady') + '\n' +
        extractFunction(INDEX, 'kxOpenSupport'),
        sandbox
    );
    return { sandbox, calls };
}

/** The deep-link half of the entry point (needs the module-scope pending flag). */
function deepLinkSandbox(o) {
    const opts = o || {};
    const calls = { opened: [], stripped: 0 };
    const sandbox = {
        APP: { nativeSupport: opts.nativeSupport === true, supportContext: null },
        location: opts.location || { search: '', hash: '', href: 'https://arbitrix.pro/' },
        history: { replaceState: () => { calls.stripped += 1; } },
        URL: URL,
        URLSearchParams: URLSearchParams,
        String: String,
        Object: Object,
        console
    };
    if (opts.nativeSupport === true) {
        sandbox.NativeSupport = { open: (arg) => { calls.opened.push(arg); return true; } };
    }
    sandbox.closeSupportModal = () => {};
    sandbox.openSupportModal = () => { calls.opened.push({ fallback: true }); };
    vm.createContext(sandbox);
    vm.runInContext(
        contextDeclaration() + '\n' +
        extractFunction(INDEX, 'kxSupportContext') + '\n' +
        extractFunction(INDEX, 'kxNativeSupportReady') + '\n' +
        extractFunction(INDEX, 'kxOpenSupport') + '\n' +
        extractFunction(INDEX, 'kxSupportDeepLink') + '\n' +
        'var kxSupportDeepLinkPending = !!kxSupportDeepLink();\n' +
        extractFunction(INDEX, 'kxStripSupportDeepLink') + '\n' +
        extractFunction(INDEX, 'kxMaybeOpenSupportDeepLink').replace(
            'var link = kxSupportDeepLink()',
            'var link = kxSupportDeepLink()'
        ),
        sandbox
    );
    return { sandbox, calls };
}

/** The retry table must stay a handful of attempts, not a de-facto poller. */
function KX_RETRY_DELAYS_BOUNDED() {
    const line = INDEX.split('\n').find((l) => l.indexOf('var KX_SUPPORT_DEEP_LINK_RETRY_MS = [') === 0);
    if (!line) return false;
    const values = line.slice(line.indexOf('[') + 1, line.indexOf(']')).split(',')
        .map((v) => Number(v.trim())).filter((n) => Number.isFinite(n));
    return values.length > 0 && values.length <= 10 && values.every((n) => n > 0);
}

/* --------------------------------------------------------------------- DOM */
function makeEl(tag) {
    const classes = new Set();
    const node = {
        tagName: String(tag).toUpperCase(),
        children: [], parentNode: null, textContent: '', hidden: false,
        style: {}, dataset: {}, attrs: {}, listeners: {}, disabled: false, value: '',
        placeholder: '', maxLength: 0, type: '', scrollTop: 0, scrollHeight: 0,
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
        set className(v) {
            classes.clear();
            String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
        },
        appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
        removeChild(child) {
            const i = node.children.indexOf(child);
            if (i >= 0) node.children.splice(i, 1);
            child.parentNode = null;
        },
        insertBefore(child) { child.parentNode = node; node.children.unshift(child); return child; },
        setAttribute(k, v) { node.attrs[k] = String(v); },
        getAttribute(k) { return node.attrs[k]; },
        removeAttribute(k) { delete node.attrs[k]; },
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
            return walk(node);
        },
        querySelectorAll() { return []; }
    };
    return node;
}

const flush = () => new Promise((r) => setImmediate(r));

/**
 * Boot the REAL widget against a minimal DOM. The fetch double returns the
 * server's real payload shapes (conversation + messages, with `via`), which is
 * what the context/category assertions need.
 */
function bootWidget(opts) {
    const o = opts || {};
    const body = makeEl('body');
    const calls = [];
    const intervals = [];
    const state = { conversations: [], messages: [], nextId: 100 };

    const json = (payload, status) => ({
        ok: (status || 200) < 400, status: status || 200, json: () => Promise.resolve(payload)
    });

    function fetchImpl(url, opt) {
        const request = opt || {};
        const method = request.method || 'GET';
        const parsed = request.body ? JSON.parse(request.body) : null;
        const u = String(url);
        calls.push({ method, url: u, body: parsed });
        if (u === '/api/support/conversations' && method === 'GET') {
            return Promise.resolve(json({ ok: true, conversations: state.conversations }));
        }
        if (u === '/api/support/conversations' && method === 'POST') {
            const conversation = { id: 900, status: 'open', unread_for_customer: 0 };
            state.conversations = [conversation];
            return Promise.resolve(json({ ok: true, conversation }, 201));
        }
        if (/\/messages\?after=\d+$/.test(u)) {
            const after = Number(u.split('after=')[1]);
            return Promise.resolve(json({
                ok: true, conversation: { id: 900 }, messages: state.messages.filter((m) => m.id > after)
            }));
        }
        if (/\/messages$/.test(u) && method === 'GET') {
            return Promise.resolve(json({ ok: true, conversation: { id: 900 }, messages: state.messages.slice() }));
        }
        if (/\/messages$/.test(u) && method === 'POST') {
            const row = {
                id: ++state.nextId, conversation_id: 900, sender_type: 'customer',
                body: parsed.body, client_message_id: parsed.clientMessageId,
                via: 'customer', created_at: new Date().toISOString()
            };
            state.messages.push(row);
            const ack = {
                id: ++state.nextId, conversation_id: 900, sender_type: 'system', via: 'system',
                body: o.ack || 'Acknowledgement', created_at: new Date().toISOString()
            };
            state.messages.push(ack);
            return Promise.resolve(json({ ok: true, conversationId: 900, message: row, reply: ack }, 201));
        }
        if (/\/read$/.test(u)) return Promise.resolve(json({ ok: true }));
        return Promise.resolve(json({ ok: true }));
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
    sandbox.window = { addEventListener: () => {}, NativeSupport: undefined };
    vm.createContext(sandbox);
    vm.runInContext(WIDGET, sandbox, { filename: 'native-support.js' });

    return {
        body, sandbox, calls, state,
        widget: () => sandbox.window.NativeSupport,
        panels: () => body.children.filter((c) => String(c.className).split(/\s+/).includes('ns-panel'))
    };
}

function panelPart(h, className) {
    const panel = h.panels()[0];
    return panel ? panel.children.find((c) => String(c.className) === className) : null;
}

/* ==================================================================== *
 * 1. One entry point
 * ==================================================================== */

test('1. the app has exactly one support entry point and no direct modal wiring', () => {
    assert.strictEqual((INDEX.match(/function kxOpenSupport\(/g) || []).length, 1,
        'kxOpenSupport is defined once');
    assert.ok(/function openSupportModal\(/.test(INDEX),
        'the Support Center modal remains as the messenger\'s fallback');

    // No control may bypass the entry point: a direct openSupportModal() onclick
    // would skip the in-app chat entirely.
    assert.strictEqual((INDEX.match(/onclick="openSupportModal\(\)"/g) || []).length, 0,
        'no control opens the Support Center directly');

    const entry = INDEX.match(/onclick="kxOpenSupport\([^)]*\)"/g) || [];
    assert.ok(entry.length >= 8, 'every support control routes through it (' + entry.length + ' found)');
});

test('2. each entry point carries the reason the customer arrived', () => {
    const expected = [
        ["kxOpenSupport()", 'sidebar / generic'],
        ["kxOpenSupport('deposit')", 'deposit journey'],
        ["kxOpenSupport('account')", 'profile / referral / refusal'],
        ["kxOpenSupport('withdrawal')", 'withdrawal journey']
    ];
    for (const [call, label] of expected) {
        assert.ok(INDEX.indexOf('onclick="' + call + '"') !== -1, label + ' uses ' + call);
    }
    // The four categories are the conversation categories the service stores.
    const contexts = extractFunction(INDEX, 'kxSupportContext');
    assert.ok(/deposit: 1, withdrawal: 1, trading: 1, account: 1/.test(INDEX),
        'the allowed contexts are exactly the four stored categories');
    assert.ok(/hasOwnProperty/.test(contexts), 'and an unknown context is rejected, not passed through');
});

test('3. the messenger wins, the Support Center is only a fallback', () => {
    const ready = supportSandbox({ nativeSupport: true });
    assert.strictEqual(ready.sandbox.kxOpenSupport('deposit'), true);
    assert.strictEqual(JSON.stringify(ready.calls.native), '[{"context":"deposit"}]',
        'the in-app chat is opened with the context');
    assert.strictEqual(ready.calls.modal, 0, 'the modal is not opened as well');
    assert.strictEqual(ready.calls.closed, 1, 'and the other surface is closed (one surface at a time)');
    assert.strictEqual(ready.sandbox.APP.supportContext, 'deposit', 'the context is remembered');

    const closed = supportSandbox({ nativeSupport: false });
    assert.strictEqual(closed.sandbox.kxOpenSupport('deposit'), false);
    assert.strictEqual(closed.calls.modal, 1, 'with no messenger the Support Center opens');
    assert.strictEqual(closed.calls.native.length, 0, 'the messenger is not touched');

    const refused = supportSandbox({ nativeSupport: true, nativeReturns: false });
    assert.strictEqual(refused.sandbox.kxOpenSupport(), false);
    assert.strictEqual(refused.calls.modal, 1, 'a refused open also falls back to the modal');
});

test('3b. a click before the widget resolved still opens the chat (surface race)', () => {
    // The widget script loads after the session sync, so the first click can land
    // while the surface is still `pending`. kxOpenSupport() must ask the widget to
    // resolve instead of falling through to the Support Center.
    const sandbox = {
        APP: { nativeSupport: true, supportContext: null },
        document: { body: { dataset: { supportSurface: 'pending' } } },
        URL: URL, URLSearchParams: URLSearchParams, String: String, Object: Object
    };
    const calls = { modals: 0, syncs: 0, opened: 0, closed: 0 };
    sandbox.closeSupportModal = () => { calls.closed += 1; };
    sandbox.openSupportModal = () => { calls.modals += 1; };
    sandbox.NativeSupport = {
        sync: () => { calls.syncs += 1; sandbox.document.body.dataset.supportSurface = 'native'; },
        open: () => { calls.opened += 1; return sandbox.document.body.dataset.supportSurface === 'native'; }
    };
    vm.createContext(sandbox);
    vm.runInContext(
        contextDeclaration() + '\n' +
        extractFunction(INDEX, 'kxSupportContext') + '\n' +
        extractFunction(INDEX, 'kxNativeSupportReady') + '\n' +
        extractFunction(INDEX, 'kxOpenSupport'),
        sandbox
    );
    assert.strictEqual(sandbox.kxOpenSupport('deposit'), true, 'the chat opens');
    assert.strictEqual(calls.syncs, 1, 'the widget was asked to resolve the surface once');
    assert.strictEqual(calls.modals, 0, 'and the fallback modal is not used');

    // Already resolved: no redundant sync.
    sandbox.document.body.dataset.supportSurface = 'native';
    calls.syncs = 0;
    assert.strictEqual(sandbox.kxOpenSupport(), true);
    assert.strictEqual(calls.syncs, 0, 'a resolved surface performs no extra work');
});

test('4. an unknown context is dropped rather than guessed', () => {
    const { sandbox, calls } = supportSandbox({ nativeSupport: true });
    sandbox.kxOpenSupport('teamviewer');
    assert.strictEqual(JSON.stringify(calls.native), '[{"context":null}]', 'no invented category is stored');
    assert.strictEqual(sandbox.APP.supportContext, null);
    assert.strictEqual(sandbox.kxSupportContext('  DEPOSIT '), 'deposit', 'case and padding are tolerated');
    assert.strictEqual(sandbox.kxSupportContext(undefined), null);
});

/* ==================================================================== *
 * 2. The ?support= deep link
 * ==================================================================== */

test('5. the deep link parses a context and refuses junk', () => {
    const cases = [
        [{ search: '?support=1', hash: '', href: 'https://arbitrix.pro/?support=1' }, null],
        [{ search: '?support=deposit', hash: '', href: 'https://arbitrix.pro/?support=deposit' }, 'deposit'],
        [{ search: '?support=withdrawal', hash: '', href: 'https://arbitrix.pro/?support=withdrawal' }, 'withdrawal'],
        [{ search: '?support=bogus', hash: '', href: 'https://arbitrix.pro/?support=bogus' }, null],
        [{ search: '?support=', hash: '', href: 'https://arbitrix.pro/?support=' }, null],
        [{ search: '', hash: '#support', href: 'https://arbitrix.pro/#support' }, null],
        [{ search: '', hash: '#support=trading', href: 'https://arbitrix.pro/#support=trading' }, 'trading'],
        [{ search: '?ref=ABC', hash: '', href: 'https://arbitrix.pro/?ref=ABC' }, 'none']
    ];
    for (const [location, want] of cases) {
        const { sandbox } = deepLinkSandbox({ location });
        const link = sandbox.kxSupportDeepLink();
        if (want === 'none') assert.strictEqual(link, null, 'an unrelated query is not a support link');
        else {
            assert.ok(link && typeof link === 'object', JSON.stringify(location) + ' is a support link');
            assert.strictEqual(link.context, want, JSON.stringify(location));
        }
    }
});

test('6. the link is consumed only once the chat can really open', () => {
    // Signed out (or the messenger not resolved yet): nothing is consumed, so the
    // request survives the sign-in and still opens the chat afterwards.
    const waiting = deepLinkSandbox({
        location: { search: '?support=1', hash: '', href: 'https://arbitrix.pro/?support=1' },
        nativeSupport: false
    });
    assert.strictEqual(waiting.sandbox.kxSupportDeepLinkPending, true, 'the request is remembered');
    assert.strictEqual(waiting.sandbox.kxMaybeOpenSupportDeepLink(), false);
    assert.strictEqual(waiting.calls.stripped, 0, 'the URL is left untouched');
    assert.strictEqual(waiting.sandbox.kxSupportDeepLinkPending, true, 'and it stays pending');

    // Session resolved: the chat opens with the requested context, once.
    const ready = deepLinkSandbox({
        location: { search: '?support=deposit', hash: '', href: 'https://arbitrix.pro/?support=deposit' },
        nativeSupport: true
    });
    assert.strictEqual(ready.sandbox.kxMaybeOpenSupportDeepLink(), true);
    assert.strictEqual(JSON.stringify(ready.calls.opened), '[{"context":"deposit"}]');
    assert.strictEqual(ready.calls.stripped, 1, 'the support parameter is removed from the URL');
    assert.strictEqual(ready.sandbox.kxSupportDeepLinkPending, false);
    assert.strictEqual(ready.sandbox.kxMaybeOpenSupportDeepLink(), false, 'a second pass does nothing');
    assert.strictEqual(ready.calls.opened.length, 1, 'and cannot open it twice');
});

test('7. the deep link is honoured after login and after signup, never as a redirect', () => {
    // initApp: after the session sync, before the dashboard work.
    const initAt = INDEX.lastIndexOf('try { kxConsumeSupportDeepLink(); } catch (e) {}');
    assert.ok(initAt > 0, 'initApp consumes the deep link');
    const syncAt = INDEX.lastIndexOf('await syncWalletFromServer();', initAt);
    assert.ok(syncAt > 0 && initAt > syncAt, 'it runs after the session resolved');

    // A cold load can resolve the messenger a few seconds after the session sync,
    // so the attempt is retried a BOUNDED number of times and stops as soon as the
    // chat opens. Nothing is consumed while it cannot open.
    const retry = extractFunction(INDEX, 'kxConsumeSupportDeepLink');
    assert.match(retry, /KX_SUPPORT_DEEP_LINK_RETRY_MS/);
    assert.match(retry, /kxSupportDeepLinkTries >= KX_SUPPORT_DEEP_LINK_RETRY_MS\.length/,
        'the retries are bounded');
    assert.match(retry, /setTimeout\(/, 'the retry is scheduled, not a loop');
    assert.ok(!/setInterval/.test(retry), 'never a polling interval');
    assert.ok(KX_RETRY_DELAYS_BOUNDED(), 'the backoff table is a handful of attempts');

    // signup: the funnel is skipped when the visitor came from a support link.
    const branch = INDEX.slice(INDEX.indexOf('if (kxSupportDeepLinkPending) {'),
        INDEX.indexOf('if (kxSupportDeepLinkPending) {') + 600);
    assert.ok(/kxConsumeSupportDeepLink\(\)/.test(branch), 'signup opens the chat');
    assert.ok(/} else \{\s*showOnboarding\(data\.user\);/.test(branch),
        'and only otherwise shows the onboarding tour');

    // There is no redirect-based hand-off anywhere.
    assert.ok(!/location\.(href|assign|replace)\s*=\s*['"][^'"]*support/i.test(INDEX),
        'no redirect to a support page or bot');
});

/* ==================================================================== *
 * 3. No customer-facing Telegram support destination
 * ==================================================================== */

test('8. static pages send customers to the in-app chat', () => {
    for (const [name, page] of [['partners.html', PARTNERS], ['terms-of-service.html', TERMS], ['privacy-policy.html', PRIVACY]]) {
        assert.ok(page.indexOf('?support=1') !== -1, name + ' links to the in-app chat');
    }
    assert.ok(!/t\.me\//.test(PARTNERS), 'the partner page publishes no Telegram destination');
    assert.ok(!/ArbitrixSupportBot/.test(PARTNERS), 'and no bot handle');
    for (const [name, page] of [['terms', TERMS], ['privacy', PRIVACY]]) {
        assert.ok(!/t\.me\/ArbitrixSupportBot/.test(page), name + ' no longer links the support bot');
    }
});

test('9. the app publishes no support destination at all', () => {
    assert.ok(!/js-official-telegram/.test(INDEX), 'no Telegram support link is rendered');
    assert.ok(!/arbitrix-support-telegram/.test(INDEX), 'and no Telegram support meta is configured');
    assert.ok(!/getOfficialSupportTelegramUrl/.test(INDEX), 'the link builder is gone');

    // The only t.me links left are the withdrawal walkthrough (announcement content).
    const links = INDEX.match(/https?:\/\/t\.me\/[A-Za-z0-9_\/]+/g) || [];
    assert.deepStrictEqual(links, ['https://t.me/ArbitrixAnnouncements/19'],
        'tutorial content is not a support destination');
});

test('10. the Support Center can no longer fall back to Telegram', () => {
    const modal = INDEX.slice(INDEX.indexOf('<div class="deposit-modal" id="supportModal">'),
        INDEX.indexOf('id="supportModal"') + 20000);
    assert.ok(!/t\.me\//.test(modal), 'the modal carries no Telegram link');
    assert.ok(!/js-official-telegram/.test(modal), 'nor a Telegram anchor');
    // It offers the chat, which is the only escalation path left.
    assert.match(modal, /id="supportChatCta"[^>]*onclick="kxOpenSupport\(APP\.supportContext\)"/,
        'the modal hands the customer to the in-app chat, keeping the reason they arrived');
    // When the messenger cannot open, the CTA is hidden rather than pointing at a
    // dead destination - and the modal itself remains the support surface.
    assert.ok(/chatCta\.style\.display = ready \? '' : 'none'/.test(INDEX),
        'the chat action is only offered when it can really open');
    assert.ok(/chatHint\.style\.display = ready \? '' : 'none'/.test(INDEX));
});

/* ==================================================================== *
 * 4. The widget: context, and no second support surface
 * ==================================================================== */

test('11. the widget shows the reason the customer arrived', async () => {
    const T = dictionary();
    for (const lang of LANGS) {
        for (const topic of ['deposit', 'withdrawal', 'trading', 'account']) {
            const label = T[lang]['ns.context.' + topic];
            assert.ok(typeof label === 'string' && label.trim().length > 3,
                lang + ' must label the ' + topic + ' context');
            assert.notStrictEqual(label, 'ns.context.' + topic, lang + '/' + topic + ' is translated');
        }
    }

    const h = bootWidget();
    h.sandbox.APP.nativeSupport = true;
    h.widget().sync();
    h.widget().open({ context: 'deposit' });
    await flush();
    await flush();

    const chip = panelPart(h, 'ns-context');
    assert.ok(chip, 'the panel has a context chip');
    assert.strictEqual(chip.hidden, false, 'the chip is visible for a context open');
    assert.strictEqual(chip.textContent.length > 0, true, 'and it is labelled');

    // The reason travels with the FIRST message as the conversation category.
    const row = panelPart(h, 'ns-foot').querySelector('.ns-row');
    const input = row.children[0];
    input.value = 'Where do I send the USDT?';
    row.querySelector('.ns-send').dispatch('click');
    await flush();
    await flush();

    const post = h.calls.filter((c) => c.method === 'POST' && /\/api\/support\/conversations$/.test(c.url))[0];
    assert.ok(post, 'the conversation was created on the first message');
    assert.strictEqual(post.body.category, 'deposit', 'the context is the conversation category');
});

test('12. a contextless open shows no chip, and reset clears it', async () => {
    const h = bootWidget();
    h.sandbox.APP.nativeSupport = true;
    h.widget().sync();
    h.widget().open();
    await flush();
    await flush();
    const chip = panelPart(h, 'ns-context');
    assert.ok(chip);
    assert.strictEqual(chip.hidden, true, 'no chip without a context');

    h.widget().open({ context: 'withdrawal' });
    await flush();
    assert.strictEqual(panelPart(h, 'ns-context').hidden, false);

    // A new account must not inherit the previous reason.
    h.sandbox.APP.nativeSupport = false;
    h.widget().sync();
    h.sandbox.APP.nativeSupport = true;
    h.widget().sync();
    h.widget().open();
    await flush();
    assert.strictEqual(panelPart(h, 'ns-context').hidden, true, 'the context is cleared with the account');
});

test('13. the widget has no automated answering path left', () => {
    // Human-only support: the messenger stores the message and shows the static
    // acknowledgement that comes back with the POST. Nothing generates an answer.
    assert.ok(!/composeAiReply|runAiTurn|SupportAIService|knowledgeResponder/.test(WIDGET),
        'the widget never asks an AI layer');
    assert.ok(!/\/api\/support\/ai/.test(WIDGET), 'and never calls an AI endpoint');
    const service = read('services/NativeSupport.js');
    assert.ok(!/SupportAIService|composeAiReply/.test(service), 'the service has no AI collaborator');
});

/* ==================================================================== *
 * 5. The architecture is preserved
 * ==================================================================== */

test('14. Telegram stays an INTERNAL agent channel and the bridge is untouched', () => {
    const server = read('server.js');
    assert.ok(/SupportInboxBridge|supportInboxBridge/.test(server), 'the inbox bridge is wired');
    assert.ok(/\/api\/telegram\/webhook/.test(server), 'the webhook route exists');
    assert.ok(/@ArbitrixSupportBot/.test(server), 'the bot identity is server-side only');
    assert.ok(/function createTelegramSupportBot|createTelegramSupportBot\(/.test(server));

    // The shared conversation is the single source of truth for both surfaces.
    const routes = read('services/nativeSupportRoutes.js');
    assert.ok(/registerNativeSupportRoutes/.test(server), 'the routes are registered by the server');
    assert.ok(/app\.(get|post)\('\/api\/support\/conversations'/.test(routes), 'the customer routes exist');
    assert.ok(/app\.(get|post)\('\/api\/admin\/support\//.test(routes), 'the admin inbox routes exist');
    assert.ok(/authMiddleware/.test(routes), 'and every one of them is authenticated');

    // No new migration: 061 is the newest one.
    const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql'));
    assert.deepStrictEqual(migrations.filter((f) => /^062/.test(f)), [], 'no migration 062 exists');
    assert.ok(migrations.some((f) => /^061_human_only_support/.test(f)), 'migration 061 is the human-only contract');
});

test('15. no customer message is created by any of this plumbing', () => {
    // Opening support is a display action: the entry point itself must not call
    // the network, and the deep link must not post anything.
    const open = extractFunction(INDEX, 'kxOpenSupport');
    assert.ok(!/fetch\s*\(|XMLHttpRequest/.test(open), 'the entry point performs no request');
    const deep = extractFunction(INDEX, 'kxMaybeOpenSupportDeepLink');
    assert.ok(!/fetch\s*\(|XMLHttpRequest/.test(deep), 'the deep link performs no request');
    const strip = extractFunction(INDEX, 'kxStripSupportDeepLink');
    assert.ok(!/fetch\s*\(/.test(strip));
});
