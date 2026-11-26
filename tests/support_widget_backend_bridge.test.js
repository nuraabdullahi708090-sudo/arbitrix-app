'use strict';

/**
 * In-app support widget -> support brain bridge.
 *
 * THE BUG THIS PINS
 *   The floating assistant answered ONLY from seven hard-coded keyword groups in
 *   the browser. A customer question such as "What is Kalderix, and how does it
 *   work?" matched none of them, so the widget rendered
 *   support.reply.default ("I'm not able to answer that accurately...") even
 *   though the approved knowledge base answers it
 *   (what_is_arbitrix.overview) and the backend that would serve it was already
 *   deployed and unused by any customer surface.
 *
 * WHAT IS ASSERTED
 *   A. There is still exactly ONE widget and ONE answer path in the page: no
 *      second widget, no duplicated knowledge/retrieval engine in the frontend.
 *   B. The widget now consults the EXISTING native support API with the
 *      customer's session, and renders the backend answer verbatim.
 *   C. Every degraded case (no session, feature disabled -> 404, rate limit,
 *      server error, network failure, empty answer) keeps the previous keyword
 *      behaviour, so nobody is worse off than before the fix.
 *   D. The backend answer for the reported question really is the approved
 *      knowledge entry, with no human hand-off.
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

const { createSupportAIService, resolveSupportAIConfig } = require(path.join(ROOT, 'services', 'support', 'SupportAIService'));
const { createNativeSupportService } = require(path.join(ROOT, 'services', 'NativeSupport'));
const SupportKnowledge = require(path.join(ROOT, 'services', 'support', 'SupportKnowledge'));

const QUESTION = 'What is Kalderix, and how does it work?';

/* ------------------------------------------------------------------ helpers */

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' must exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
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
const REQUEST = extractFunction('requestSupportReply');
const ESCAPE = extractFunction('escapeSupportText');
// The legacy assistant's session epoch: sendSupportMessage() pins an in-flight
// reply to the session that asked for it, so the helper is part of its contract.
const EPOCH = extractFunction('legacySupportEpoch');
const SEND = extractFunction('sendSupportMessage');
const FALLBACK = extractFunction('appendSupportFallbackReply');
const HANDOVER = extractFunction('handOverToHumanSupport');
const QUEUED = extractFunction('appendSupportQueuedReply');

/**
 * Run the REAL widget source with a fake DOM and a programmable transport.
 * `handlers.post` may return a value, throw, or return a rejected promise.
 */
async function ask(message, options) {
    const opts = options || {};
    const chat = { innerHTML: '', scrollTop: 0, children: [], appendChild(n) { this.children.push(n); return n; } };
    const input = { value: message };
    const calls = [];
    let messengerOpened = 0;
    const lang = opts.lang || 'en';
    const makeEl = () => ({
        tag: 'div', className: '', textContent: '', attrs: {}, handlers: {}, children: [],
        appendChild(n) { this.children.push(n); return n; },
        setAttribute(k, v) { this.attrs[k] = v; },
        addEventListener(ev, fn) { this.handlers[ev] = fn; }
    });
    let pending = null;
    const sandbox = {
        getEl: (id) => (id === 'chatMessages' ? chat : id === 'supportInput' ? input : null),
        document: { createElement: makeEl, createTextNode: (s) => ({ nodeType: 3, text: s }), getElementById: () => null },
        APP: { MTA: 200 },
        currentLang: lang,
        setTimeout: (fn) => { pending = fn(); },
        openSupportModal: () => {},
        NativeSupport: opts.messenger === false ? undefined : { open: function () { messengerOpened += 1; } },
        t: (key, vars) => {
            let v = (T[lang] && T[lang][key]) || T.en[key] || key;
            if (vars) Object.keys(vars).forEach((k) => { v = v.split('{{' + k + '}}').join(String(vars[k])); });
            return v;
        }
    };
    if (opts.token !== null) {
        sandbox.localStorage = { getItem: (k) => (k === 'jwt_token' ? (opts.token || 'test-jwt') : null), setItem: () => {} };
    }
    if (opts.fetch !== null) {
        sandbox.fetch = async function (url, init) {
            calls.push({ url: String(url), init: init || {} });
            if (opts.fetch) return opts.fetch(String(url), init, calls);
            if (String(url).indexOf('/messages') !== -1) {
                // Mirrors the real API: `message` is the CUSTOMER's own message,
                // the automated answer travels in `reply`.
                return {
                    ok: true,
                    json: async () => ({
                        ok: true,
                        message: { body: message },
                        reply: opts.reply !== undefined ? opts.reply : { body: opts.answer || 'The approved answer.' }
                    })
                };
            }
            return { ok: true, json: async () => ({ ok: true, conversation: { id: 11 } }) };
        };
    }
    vm.createContext(sandbox);
    vm.runInContext(REQUEST + '\n' + ESCAPE + '\n' + EPOCH + '\n' + SEND + '\n' + FALLBACK + '\n' + HANDOVER + '\n' + QUEUED + '\nsendSupportMessage();', sandbox);
    if (pending) await pending;
    return { html: chat.innerHTML, usedFallback: chat.children.length > 0, calls, messengerOpened, nodes: chat.children };
}

/* ------------------------------------------------- A. one widget, one engine */

test('A1. there is still exactly one assistant widget and one send handler', () => {
    assert.equal(INDEX.split('id="supportPanel"').length - 1, 1, 'a single #supportPanel');
    assert.equal(INDEX.split('function sendSupportMessage(').length - 1, 1, 'a single sendSupportMessage');
    assert.equal(INDEX.split('function appendSupportFallbackReply(').length - 1, 1, 'a single fallback renderer');
    assert.equal(INDEX.split('function requestSupportReply(').length - 1, 1, 'a single backend bridge');
});

test('A2. the widget adds no second answer engine (no knowledge base in the browser)', () => {
    const bridge = REQUEST;
    assert.ok(!/arbitrix-knowledge|what_is_arbitrix|createRetriever|SupportAIService/.test(bridge),
        'the bridge must not embed retrieval/knowledge logic');
    assert.ok(!/knowledge/i.test(bridge), 'the browser never sees the knowledge base');
});

test('A3. the widget calls only the app own native support API, with the session', () => {
    assert.ok(!/https?:\/\//.test(REQUEST), 'relative endpoints only');
    assert.ok(REQUEST.indexOf("'/api/support/conversations'") !== -1);
    assert.ok(REQUEST.indexOf("/api/support/conversations/' + convId + '/messages'") !== -1);
    assert.ok(/Authorization/.test(REQUEST) && /Bearer/.test(REQUEST), 'the request is authenticated');
    assert.ok(/jwt_token/.test(SEND), 'no session means no API call');
});

/* ------------------------------------------ B. the reported case is answered */

test('B1. "What is Kalderix, and how does it work?" renders the approved answer, not the fallback', async () => {
    const approved = 'Kalderix is an automated arbitrage platform.';
    const out = await ask(QUESTION, { answer: approved });
    assert.ok(out.html.indexOf(approved) !== -1, 'the backend answer is rendered');
    assert.ok(out.html.indexOf(T.en['support.reply.default']) === -1, 'the fallback is NOT used');
    assert.equal(out.usedFallback, false, 'no fallback node was created');
});

test('B2. the widget sends the customer message and renders the server reply verbatim', async () => {
    const approved = 'Kalderix is an automated arbitrage platform. It looks for arbitrage opportunities.';
    const out = await ask(QUESTION, { answer: approved });
    assert.equal(out.calls.length, 2, 'one conversation create + one message post');
    assert.ok(/\/api\/support\/conversations$/.test(out.calls[0].url), 'creates/reuses the conversation');
    assert.ok(/\/api\/support\/conversations\/11\/messages$/.test(out.calls[1].url), 'posts to that conversation');
    assert.equal(JSON.parse(out.calls[1].init.body).body, QUESTION, 'the customer question is forwarded');
    assert.ok(out.calls[1].init.body.indexOf('clientMessageId') !== -1, 'idempotency key is supplied');
    assert.ok(out.html.indexOf(approved) !== -1, 'reply rendered as-is');
    // The customer message appears exactly once (as their own bubble), never as
    // an "agent" answer: the API's `message` field is the echo of their input.
    const bubbles = out.html.split('msg-bubble').length - 1;
    assert.equal(bubbles, 2, 'one customer bubble + one agent bubble');
    assert.ok(out.html.indexOf('<div class="chat-message agent"><div class="msg-bubble">' + QUESTION) === -1,
        'the customer question is never echoed back as an agent answer');
});

test('B4. a human-owned thread gets no automated answer and no echo', async () => {
    // ai_paused / duplicate mean a person owns the conversation: the assistant
    // must not answer over them, and must not echo the customer's own text.
    for (const payload of [{ aiPaused: true }, { duplicate: true }, { aiPaused: true, duplicate: true }]) {
        const out = await ask(QUESTION, {
            fetch: async (url) => {
                if (String(url).indexOf('/messages') !== -1) {
                    return { ok: true, json: async () => Object.assign({ ok: true, conversationId: 11, message: { body: QUESTION }, reply: null }, payload) };
                }
                return { ok: true, json: async () => ({ ok: true, conversation: { id: 11 } }) };
            }
        });
        assert.ok(!/chat-message agent/.test(out.html), 'no agent bubble for ' + JSON.stringify(payload));
        assert.equal(out.messengerOpened, 1, 'the stored message is shown in the shared conversation');
    }

    // The messenger cannot open (blocked/cached script): the customer still gets
    // the truth - the message reached the team - and never the legacy fallback.
    const noMessenger = await ask(QUESTION, {
        messenger: false,
        fetch: async (url) => {
            if (String(url).indexOf('/messages') !== -1) {
                return { ok: true, json: async () => ({ ok: true, conversationId: 11, message: { body: QUESTION }, reply: null }) };
            }
            return { ok: true, json: async () => ({ ok: true, conversation: { id: 11 } }) };
        }
    });
    assert.equal(noMessenger.usedFallback, true, 'a static acknowledgement is rendered');
    const textOf = (n) => (n && n.nodeType === 3 ? n.text : (n && n.children ? n.children.map(textOf).join('') : ''));
    const notice = noMessenger.nodes[0];
    assert.equal(notice.className, 'chat-message system', 'it is a system notice, not an assistant answer');
    assert.ok(textOf(notice).indexOf(T.en['support.reply.queued']) !== -1, 'the queued acknowledgement is shown');
    assert.ok(textOf(notice).indexOf(T.en['support.reply.default']) === -1, 'no legacy fallback text');
    assert.ok(!/chat-message agent/.test(noMessenger.html), 'no assistant answer is rendered');
});

test('B5. a plain-string notice reply is rendered', async () => {
    const out = await ask(QUESTION, { reply: 'A support agent has been notified.' });
    assert.ok(out.html.indexOf('A support agent has been notified.') !== -1);
    assert.equal(out.usedFallback, false);
});

test('B3. the conversation is created in the customer language', async () => {
    const out = await ask(QUESTION, { answer: 'Kalderix est une plateforme.', lang: 'fr' });
    const created = JSON.parse(out.calls[0].init.body);
    assert.equal(created.language, 'fr');
    assert.equal(created.category, 'general');
});

/* ------------------------------- C. every degraded case keeps old behaviour */

test('C1. a signed-out visitor makes no API call and keeps the keyword answers', async () => {
    const out = await ask('I need help with my deposit.', { token: null, fetch: null });
    assert.equal(out.calls.length, 0, 'no request without a session');
    assert.ok(out.html.indexOf(T.en['support.reply.deposit']) !== -1, 'keyword answer still works');
});

test('C2. native support disabled (404) falls back to the keyword answers', async () => {
    const out = await ask('I need help with my deposit.', {
        fetch: async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: 'not-found' }) })
    });
    assert.ok(out.html.indexOf(T.en['support.reply.deposit']) !== -1, 'deposit keyword answer preserved');
    assert.equal(out.usedFallback, false, 'no human fallback for a supported topic');
});

test('C3. native support disabled (404) + unknown question still shows the honest fallback', async () => {
    const out = await ask(QUESTION, {
        fetch: async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: 'not-found' }) })
    });
    assert.equal(out.usedFallback, true, 'fallback node rendered');
    assert.ok(out.html.indexOf(T.en['support.reply.default']) === -1);
});

test('C4. a network failure is swallowed and the widget still answers', async () => {
    const out = await ask('When can I withdraw my funds?', {
        fetch: async () => { throw new Error('offline'); }
    });
    assert.ok(out.html.indexOf(T.en['support.reply.withdraw']) !== -1, 'keyword answer still rendered');
});

test('C5. a 500 keeps the keyword behaviour; a 200 with no reply does not invent one', async () => {
    const five = await ask('Tell me about the referral bonus', {
        fetch: async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) })
    });
    assert.ok(five.html.indexOf(T.en['support.reply.bonus']) !== -1, 'server error -> offline keyword answer');

    // The backend accepted the message but produced no automated turn: that is a
    // human/queued case, NOT an invitation to answer from keywords.
    const empty = await ask('Tell me about the referral bonus', { reply: { body: '   ' } });
    assert.equal(empty.messengerOpened, 1, 'blank reply -> the stored message is shown to the customer');
    assert.ok(empty.html.indexOf(T.en['support.reply.bonus']) === -1, 'no keyword answer over the backend');
    assert.ok(empty.html.indexOf(T.en['support.reply.default']) === -1, 'no legacy fallback text');
});

test('C6. a failed conversation create never posts a message', async () => {
    let posts = 0;
    await ask(QUESTION, {
        fetch: async (url) => {
            if (url.indexOf('/messages') !== -1) posts += 1;
            return { ok: false, status: 503, json: async () => ({ ok: false }) };
        }
    });
    assert.equal(posts, 0, 'no message is posted without a conversation');
});

test('C7. the backend answer is HTML-escaped before rendering', async () => {
    const out = await ask(QUESTION, { answer: '<img src=x onerror=alert(1)> minimum & fees' });
    assert.ok(out.html.indexOf('&lt;img') !== -1, 'tags are escaped');
    assert.ok(out.html.indexOf('<img src=x') === -1, 'no raw markup injected');
    assert.ok(out.html.indexOf('&amp;') !== -1, 'ampersands escaped');
});

/* ------------------------------- D. the backend really answers this question */

function knowledgeAI() {
    const env = { AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'knowledge' };
    return createSupportAIService({ config: resolveSupportAIConfig(env) });
}

test('D1. the approved knowledge base retrieves the entry for the reported question', () => {
    const kb = SupportKnowledge.readKnowledge();
    const retriever = SupportKnowledge.createRetriever(kb);
    const list = retriever.retrieve(QUESTION);
    assert.ok(list.length > 0, 'at least one entry is retrieved');
    const top = list[0].entry || list[0];
    assert.equal(top.id, 'what_is_arbitrix.overview', 'the overview entry is the best match');
});

test('D2. SupportAIService answers it from knowledge with no hand-off', async () => {
    const outcome = await knowledgeAI().ask(QUESTION);
    assert.equal(outcome.kind, 'answer');
    assert.equal(outcome.answered, true);
    assert.equal(outcome.entryId, 'what_is_arbitrix.overview');
    assert.equal(outcome.needsHuman, false);
    assert.equal(outcome.source, 'knowledge');
    assert.equal(outcome.modelGenerated, false, 'no external model is required for English');
    assert.ok(/arbitrage/i.test(outcome.answer), 'the approved answer explains the product');
});

test('D3. the widget renders the backend message verbatim and the messenger has no AI entry point', async () => {
    // HUMAN-ONLY. The backend now returns the static acknowledgement instead of a
    // generated answer; the widget's contract is unchanged - it renders whatever
    // the server stored, verbatim and escaped.
    const ACK = "Thank you for contacting Kalderix. We've received your message and our support team will respond as soon as possible.";
    const out = await ask(QUESTION, { answer: ACK });
    assert.ok(out.html.indexOf(ACK) !== -1, 'the widget shows the backend text verbatim');
    assert.equal(out.usedFallback, false);

    // ...and no code path in the in-app messenger can generate an answer.
    const native = createNativeSupportService({ logger: { warn() {} } });
    assert.equal(native.composeAiReply, undefined, 'composeAiReply is gone');
    assert.equal(typeof native.sendChannelReply, 'function', 'the Telegram agent reply path exists');
});
