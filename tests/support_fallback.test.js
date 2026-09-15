'use strict';

/**
 * Stage 20A - human-support fallback for unanswered assistant questions.
 *
 * The automated Support Assistant answers a fixed set of supported topics. Any
 * other message must NOT claim that a human already received it ("our team will
 * get back to you shortly"); it must say plainly that the assistant cannot
 * answer accurately and offer the app's existing Support Center action.
 *
 * These tests run the REAL sendSupportMessage() / appendSupportFallbackReply()
 * source in a vm sandbox with a tiny fake DOM, so behavior (not just markup) is
 * covered.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' must exist');
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    return INDEX.slice(start, end + 1);
}

function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

const T = loadTranslations();
const SEND = extractFunction('sendSupportMessage');
const FALLBACK = extractFunction('appendSupportFallbackReply');

/* Runs the real assistant code for one message and returns what it rendered. */
function ask(message, lang, mta) {
    const chat = { innerHTML: '', scrollTop: 0, children: [], appendChild(n) { this.children.push(n); return n; } };
    const input = { value: message };
    const makeEl = (tag) => ({
        tag, className: '', textContent: '', attrs: {}, handlers: {}, children: [],
        appendChild(n) { this.children.push(n); return n; },
        setAttribute(k, v) { this.attrs[k] = v; },
        addEventListener(ev, fn) { this.handlers[ev] = fn; },
    });
    let modalOpens = 0;
    const sandbox = {
        getEl: (id) => (id === 'chatMessages' ? chat : id === 'supportInput' ? input : null),
        document: { createElement: makeEl, createTextNode: (s) => ({ nodeType: 3, text: s }) },
        APP: { MTA: mta === undefined ? 200 : mta },
        setTimeout: (fn) => { fn(); },
        openSupportModal: () => { modalOpens += 1; },
        t: (key, vars) => {
            let v = (T[lang] && T[lang][key]) || T.en[key] || key;
            if (vars) Object.keys(vars).forEach((k) => { v = v.split('{{' + k + '}}').join(String(vars[k])); });
            return v;
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(SEND + '\n' + FALLBACK + '\nsendSupportMessage();', sandbox);
    // The reply is appended either as HTML (supported answers) or as nodes
    // (fallback). Expose both shapes.
    const nodes = chat.children.length ? chat.children[chat.children.length - 1] : null;
    const bubble = nodes ? nodes.children[0] : null;
    const action = bubble ? bubble.children.find((c) => c.tag === 'button') || null : null;
    const messageNode = bubble ? bubble.children.find((c) => c.nodeType === 3) : null;
    return {
        html: chat.innerHTML,
        usedFallback: chat.children.length > 0,
        bubble,
        action,
        text: messageNode ? messageNode.text : '',
        openModal: () => { if (action && action.handlers.click) action.handlers.click(); return modalOpens; },
    };
}

/* ------------------------------------------------------------------ *
 * 1. Supported questions keep their normal answers
 * ------------------------------------------------------------------ */
test('supported questions still receive their normal answers', () => {
    const cases = [
        ['How do I start the arbitrage bot?', 'support.reply.bot'],
        ['I need help with my deposit.', 'support.reply.deposit'],
        ['When can I withdraw my funds?', 'support.reply.withdraw'],
        ['Tell me about the referral bonus', 'support.reply.bonus'],
        ['How do I change the sound volume?', 'support.reply.sound'],
        ['Can I change the language?', 'support.reply.language'],
        ['hello', 'support.reply.hello'],
        ['Hi there', 'support.reply.hello'],
    ];
    cases.forEach(([msg, key]) => {
        const r = ask(msg, 'en');
        assert.strictEqual(r.usedFallback, false, msg + ' must NOT use the human-support fallback');
        assert.ok(r.html.includes(T.en[key]), msg + ' must answer with ' + key);
        assert.ok(!r.html.includes(T.en['support.reply.default']), msg + ' must not show the fallback text');
    });
});

test('the bot answer no longer mentions an MTA (removed) and DEMO/LIVE topics work', () => {
    const r = ask('how do I start the bot in demo mode', 'en');
    assert.ok(!r.html.includes('{{mta}}'), 'no literal {{mta}} placeholder may be rendered');
    assert.ok(!/minimum trading balance/i.test(r.html), 'the bot answer must not claim a minimum trading balance');
    assert.ok(r.html.includes(T.en['support.reply.bot']), 'the bot answer matches the dictionary');
});

/* ------------------------------------------------------------------ *
 * 2. Unsupported questions trigger the fallback
 * ------------------------------------------------------------------ */
test('unsupported questions trigger the human-support fallback', () => {
    [
        'Can I pay with a credit card?',
        'How do I change my password?',
        'What is your company address?',
        'Do you have a mobile app for Android?',
        'Is my money insured by a bank?',
    ].forEach((msg) => {
        const r = ask(msg, 'en');
        assert.strictEqual(r.usedFallback, true, msg + ' must use the fallback');
        assert.strictEqual(r.text, T.en['support.reply.default'], msg + ' must show the fallback message');
        assert.ok(r.action, msg + ' must offer the human-support action');
        assert.ok(r.html.includes('chat-message user'), msg + " must still echo the user's message");
        assert.ok(!r.html.includes('chat-message agent'), msg + ' must not render a keyword answer');
    });
});

test('keyword detection no longer misfires on substrings (so these reach the fallback)', () => {
    // "history" contains "hi", "both" contains "bot" - both are unsupported
    // questions and must not receive the greeting/bot answer.
    ['What is my transaction history?', 'Can I use both wallets?', 'Show me the third option'].forEach((msg) => {
        const r = ask(msg, 'en');
        assert.strictEqual(r.usedFallback, true, msg + ' must reach the fallback');
        assert.ok(!r.html.includes(T.en['support.reply.hello']), msg + ' must not be treated as a greeting');
        assert.ok(!r.html.includes(T.en['support.reply.bot']), msg + ' must not be treated as a bot question');
    });
});

/* ------------------------------------------------------------------ *
 * 3. The fallback makes no false claim
 * ------------------------------------------------------------------ */
test('the fallback never claims a human was contacted, a ticket exists or a reply is coming', () => {
    const claims = {
        en: /get back to you|shortly|ticket|has been created|been created|assigned to|an agent|our team will/i,
        es: /en contacto|en breve|pronto|ticket|creado|asignado/i,
        pt: /em contato|em breve|pronto|ticket|criado|atribu/i,
        fr: /sous peu|bient[oô]t|ticket|cr[ée]{2}|assign/i,
        ar: /\u0642\u0631\u064a\u0628\u064b\u0627|\u062a\u0630\u0643\u0631\u0629|\u062a\u0645 \u0625\u0646\u0634\u0627\u0621/,
        zh: /\u5c3d\u5feb|\u5de5\u5355|\u5df2\u521b\u5efa/,
    };
    LANGS.forEach((l) => {
        const msg = T[l]['support.reply.default'];
        assert.ok(msg, l + ' must define the fallback message');
        assert.ok(!claims[l].test(msg), l + ' fallback must not claim a handoff: ' + msg);
    });
});

test('the previous misleading wording is gone from every locale', () => {
    const old = [
        'Thanks for your message! Our team will get back to you shortly.',
        '\u00a1Gracias por tu mensaje! Nuestro equipo se pondr\u00e1 en contacto contigo pronto.',
        'Obrigado pela sua mensagem! Nossa equipe entrar\u00e1 em contato em breve.',
        'Merci pour votre message ! Notre \u00e9quipe vous r\u00e9pondra sous peu.',
        '\u0634\u0643\u0631\u064b\u0627 \u0644\u0631\u0633\u0627\u0644\u062a\u0643! \u0633\u064a\u062a\u0648\u0627\u0635\u0644 \u0645\u0639\u0643 \u0641\u0631\u064a\u0642\u0646\u0627 \u0642\u0631\u064a\u0628\u064b\u0627.',
        '\u611f\u8c22\u60a8\u7684\u7559\u8a00\uff01\u6211\u4eec\u7684\u56e2\u961f\u5c06\u5c3d\u5feb\u4e0e\u60a8\u8054\u7cfb\u3002',
    ];
    const all = LANGS.map((l) => Object.values(T[l]).join('\n')).join('\n');
    old.forEach((s) => assert.ok(!all.includes(s), 'old wording must be removed: ' + s.slice(0, 40)));
});

test('the fallback says the assistant cannot answer accurately', () => {
    assert.match(T.en['support.reply.default'], /not able to answer that accurately/i);
    assert.match(T.en['support.reply.default'], /Support Center/i);
    LANGS.forEach((l) => {
        // every locale must carry the "cannot answer accurately" intent, not a
        // bare redirect with no explanation
        assert.ok(T[l]['support.reply.default'].length > 25, l + ' fallback must be a full sentence');
    });
});

/* ------------------------------------------------------------------ *
 * 4/5. The action is displayed and points at the existing destination
 * ------------------------------------------------------------------ */
test('the fallback displays the official Support Center action', () => {
    const r = ask('Something the assistant does not know', 'en');
    assert.ok(r.action, 'an action button must be rendered');
    assert.strictEqual(r.action.tag, 'button');
    assert.strictEqual(r.action.attrs.type || r.action.type, 'button');
    assert.strictEqual(r.action.textContent, T.en['support.openCenter'], 'visible label reuses the existing key');
    assert.strictEqual(r.action.attrs['aria-label'], T.en['support.fallback.actionAria'], 'accessible label present');
});

test('the action opens the existing Support Center (no invented destination)', () => {
    const r = ask('Something the assistant does not know', 'en');
    assert.strictEqual(r.openModal(), 1, 'clicking must call openSupportModal()');
    // the Support Center modal is the existing official destination
    assert.ok(/id="supportModal"/.test(INDEX), 'the existing Support Center modal must remain');
    assert.ok(/function openSupportModal\(/.test(INDEX), 'the existing opener must remain');
    assert.ok(/\.js-official-telegram/.test(INDEX), 'the configured official support link mechanism must remain');
    // nothing invented and nothing leaked into the chat
    const assistantSrc = SEND + FALLBACK;
    assert.ok(!/https?:\/\/|t\.me|mailto:|@[a-z0-9_.-]+\.(com|net|org|io)/i.test(assistantSrc), 'no URL/email/handle may be embedded');
    const body = INDEX.slice(INDEX.indexOf('function appendSupportFallbackReply('));
    assert.ok(!/https?:\/\//.test(body.slice(0, 900)), 'the fallback renders no link/route');
});

test('the fallback performs no network or handoff side effect', () => {
    const src = SEND + FALLBACK;
    assert.ok(!/fetch\(|XMLHttpRequest|axios|localStorage\.setItem/.test(src), 'display-only: no API/persistence call');
    assert.ok(!/ticket|createTicket|handoff|assignAgent/i.test(src), 'no fake ticketing/handoff system');
    assert.ok(!/support\//.test(FALLBACK), 'no internal route is exposed');
});

/* ------------------------------------------------------------------ *
 * 6. All supported locales
 * ------------------------------------------------------------------ */
test('the fallback works in every supported locale', () => {
    LANGS.forEach((l) => {
        const r = ask('Something unsupported entirely', l);
        assert.strictEqual(r.usedFallback, true, l + ' must use the fallback');
        assert.strictEqual(r.text, T[l]['support.reply.default'], l + ' fallback text must be localized');
        assert.strictEqual(r.action.textContent, T[l]['support.openCenter'], l + ' action label must be localized');
        assert.strictEqual(r.action.attrs['aria-label'], T[l]['support.fallback.actionAria'], l + ' aria label must be localized');
        // the accessible name must contain the visible label (WCAG 2.5.3)
        assert.ok(T[l]['support.fallback.actionAria'].includes(T[l]['support.openCenter']), l + ' aria must contain the visible label');
    });
});

test('i18n stays consistent: identical key sets, no empties, count pinned', () => {
    const sets = LANGS.map((l) => Object.keys(T[l]).sort().join('|'));
    assert.strictEqual(new Set(sets).size, 1, 'identical key sets across locales');
    LANGS.forEach((l) => assert.strictEqual(Object.keys(T[l]).length, 1398, l + ' key count'));
    LANGS.forEach((l) => Object.values(T[l]).forEach((v) => assert.ok(String(v).trim(), l + ' has an empty value')));
});

/* ------------------------------------------------------------------ *
 * 7. Existing quick actions still work
 * ------------------------------------------------------------------ */
test('existing quick-action buttons keep working and never hit the fallback', () => {
    const quickRe = /<button type="button" class="quick-reply-btn" data-msg="([^"]+)" data-i18n="([^"]+)"/g;
    const found = [...INDEX.matchAll(quickRe)];
    assert.strictEqual(found.length, 3, 'the three quick actions must remain');
    found.forEach(([, msg, key]) => {
        assert.ok(T.en[key], key + ' must still be translated');
        const r = ask(msg, 'en');
        assert.strictEqual(r.usedFallback, false, 'quick action "' + key + '" must keep its supported answer');
    });
    // the wiring (input prefill + send) must remain
    assert.ok(/querySelectorAll\('\.quick-reply-btn'\)/.test(INDEX), 'quick replies must stay wired');
    assert.ok(/getEl\('supportInput'\)\.value = this\.dataset\.msg;/.test(INDEX), 'quick replies must still prefill the input');
    // and the widget still exposes the Support Center entry point
    assert.ok(/onclick="openSupportModal\(\)"/.test(INDEX), 'the widget Support Center button must remain');
});

/* ------------------------------------------------------------------ *
 * 8. Mobile / accessibility contract (behavioural check is in the browser run)
 * ------------------------------------------------------------------ */
test('the fallback action is mobile-tappable and keyboard accessible', () => {
    const css = INDEX.slice(INDEX.indexOf('.support-human-action{'), INDEX.indexOf('.support-human-action{') + 900);
    assert.match(css, /min-height:44px/, '>=44px tap target');
    assert.match(css, /width:100%/, 'full-width tap target');
    assert.match(css, /\.support-human-action:focus-visible\{outline:2px solid var\(--gold\)/, 'visible keyboard focus ring');
    assert.match(css, /overflow-wrap:anywhere/, 'long words cannot overflow');
    assert.match(INDEX, /\.chat-message\.agent \.msg-bubble\.support-fallback\{max-width:92%/, 'fallback bubble is readable');
    assert.ok(/aria-label/.test(FALLBACK), 'the button carries an accessible name');
    assert.ok(!/onclick=/.test(FALLBACK), 'the generated action is wired with addEventListener, not inline HTML');
});

/* ------------------------------------------------------------------ *
 * 9. No unrelated logic touched
 * ------------------------------------------------------------------ */
test('no financial, account or backend logic is involved', () => {
    assert.strictEqual(SERVER.includes('appendSupportFallbackReply'), false, 'this feature is frontend-only');
    assert.strictEqual(SERVER.includes('support.reply'), false, 'no server-side assistant replies were added');
    assert.ok(/MIN_WITHDRAWAL:\s*500/.test(INDEX), 'the $500 withdrawal minimum is intact');
    const serverCode = SERVER.split('\n').map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n');
    assert.ok(!serverCode.includes('BOT_MIN_TRADING_BALANCE'), 'the MTA is fully removed (management decision)');
    // the supported answer copy itself is unchanged
    assert.match(T.en['support.reply.deposit'], /USDT on the TRON \(TRC20\)/);
    assert.match(T.en['support.reply.withdraw'], /at least 1 trade/);
    assert.match(T.en['support.reply.bonus'], /20%/);
});
