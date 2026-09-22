'use strict';

/**
 * FOOTER / CUSTOMER SUPPORT CONTACT - regression tests.
 *
 * The website previously published `support@arbitrix.ai` in the footer Contact
 * section, which is not an active support mailbox. Customer support is the
 * official Telegram bot only:
 *
 *     Telegram Support
 *     @ArbitrixSupportBot        ->  https://t.me/ArbitrixSupportBot
 *
 * The footer anchors do NOT hardcode the destination: they use the existing
 * `.js-official-telegram` mechanism, resolved at runtime from the
 * `arbitrix-support-telegram` meta tag (single source of truth). This file pins
 * that contract plus "no invalid support email may remain customer-facing"
 * (including the support modal's not-configured fallback in all 6 locales),
 * while leaving legitimate legal@ / privacy@ addresses untouched.
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
const TERMS = fs.readFileSync(path.join(ROOT, 'public', 'terms-of-service.html'), 'utf8');
const PRIVACY = fs.readFileSync(path.join(ROOT, 'public', 'privacy-policy.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
const OFFICIAL_TELEGRAM_URL = 'https://t.me/ArbitrixSupportBot';
const INVALID_SUPPORT_EMAIL = 'support@arbitrix.ai';

function extractFunction(name) {
    const start = INDEX.indexOf('function ' + name + '(');
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

// The footer "Contact" column (h4 + its links, no nested divs).
function footerContactBlock() {
    const h4 = INDEX.indexOf('data-i18n="landing.footer.contact"');
    assert.ok(h4 >= 0, 'footer Contact heading must exist');
    const open = INDEX.lastIndexOf('<div class="landing-footer-links">', h4);
    assert.ok(open >= 0, 'footer Contact column must exist');
    const close = INDEX.indexOf('</div>', h4);
    assert.ok(close > h4, 'footer Contact column must be closed');
    return INDEX.slice(open, close + '</div>'.length);
}

const FOOTER = footerContactBlock();

test('the footer Contact section presents the Telegram support bot (label + handle)', () => {
    assert.match(FOOTER, /data-i18n="support\.telegramShort"/, 'localized "Telegram Support" label');
    assert.ok(FOOTER.includes('Telegram Support'), 'English fallback label present');
    assert.ok(FOOTER.includes('@ArbitrixSupportBot'), 'the @handle is shown to customers');
});

test('the footer Contact section contains no email address', () => {
    assert.ok(!FOOTER.includes(INVALID_SUPPORT_EMAIL), 'invalid support mailbox removed');
    assert.ok(!/mailto:/i.test(FOOTER), 'no mailto link in the footer Contact section');
    assert.ok(!/@arbitrix\.ai/.test(FOOTER), 'no arbitrix.ai mailbox in the footer Contact section');
});

test('every footer Telegram link uses the shared configurable class with safe attributes', () => {
    const anchors = FOOTER.match(/<a[^>]*js-official-telegram[^>]*>/g) || [];
    assert.strictEqual(anchors.length, 2, 'both the label and the handle are official-Telegram links');
    for (const a of anchors) {
        assert.ok(/href="#"/.test(a), 'anchors must not hardcode a destination');
        assert.ok(/target="_blank"/.test(a), 'opens in a new tab');
        assert.ok(/rel="noopener noreferrer"/.test(a), 'safe new-tab attributes');
        assert.ok(!/t\.me/.test(a), 'no anchor hardcodes the Telegram URL');
    }
});

test('the official Telegram URL is defined exactly once (the meta config)', () => {
    const occurrences = INDEX.match(/https?:\/\/t\.me\/[A-Za-z0-9_]+/g) || [];
    assert.deepStrictEqual(occurrences, [OFFICIAL_TELEGRAM_URL],
        'the URL must appear exactly once, in the meta configuration');
    const meta = INDEX.match(/<meta name="arbitrix-support-telegram" content="([^"]*)">/);
    assert.ok(meta, 'meta config element must exist');
    assert.strictEqual(meta[1], OFFICIAL_TELEGRAM_URL, 'meta config holds the official URL');
});

test('the footer Telegram links resolve to the official URL at runtime', () => {
    const anchors = [{ style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
        { style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }];
    const els = {};
    const sandbox = {
        console,
        window: {},
        document: {
            querySelectorAll: (sel) => (String(sel).includes('js-official-telegram') ? anchors : []),
            querySelector: (sel) => (String(sel).includes('arbitrix-support-telegram') ? { content: OFFICIAL_TELEGRAM_URL } : null),
            getElementById: (id) => (els[id] = els[id] || { style: {}, textContent: '' }),
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction('getOfficialSupportTelegramUrl') + '\n' +
        extractFunction('updateSupportLinks') + '\nupdateSupportLinks();', sandbox);
    for (const a of anchors) {
        assert.strictEqual(a.attrs.href, OFFICIAL_TELEGRAM_URL, 'footer link points exactly at the official bot');
        assert.strictEqual(a.style.display, '', 'footer link is visible');
    }
});

test('no customer-facing invalid support email remains in the app', () => {
    assert.ok(!INDEX.includes(INVALID_SUPPORT_EMAIL), 'index.html must not contain the invalid mailbox');
    assert.ok(!/mailto:support@/i.test(INDEX), 'no support mailto link anywhere in index.html');
});

test('the Telegram not-configured fallback never offers an email (all 6 locales)', () => {
    for (const l of LANGS) {
        const v = T[l]['support.notConfigured'];
        assert.ok(v, l + ' support.notConfigured must exist');
        assert.ok(!/@/.test(v), l + ' fallback must not contain an email address');
        assert.ok(!/mailto/i.test(v), l + ' fallback must not mention mailto');
        assert.ok(!/arbitrix\.ai/i.test(v), l + ' fallback must not contain an arbitrix.ai address');
    }
    // The static default element text must be email-free too.
    const el = INDEX.match(/id="supportNotConfigured"[^>]*data-i18n="support\.notConfigured"[^>]*>([^<]*)</);
    assert.ok(el, 'the static fallback element must exist');
    assert.ok(!/@/.test(el[1]), 'static fallback text must not contain an email address');
});

test('the official Telegram label is localized while the handle stays a fixed handle', () => {
    for (const l of LANGS) {
        assert.ok(T[l]['support.telegramShort'], l + ' must localize the Telegram support label');
    }
    // A Telegram @handle is never translated; it appears verbatim once in the footer column.
    assert.strictEqual((FOOTER.match(/@ArbitrixSupportBot/g) || []).length, 1);
});

test('the official support links are resolved at startup (anonymous landing visitors too)', () => {
    // initApp() only runs after the user enters the app, so the landing footer
    // (visible to anonymous visitors) would keep the Telegram link hidden
    // without a page-ready resolution hook.
    assert.match(INDEX,
        /document\.addEventListener\('DOMContentLoaded',\s*function\s*\(\)\s*\{\s*if\s*\(typeof updateSupportLinks === 'function'\)\s*updateSupportLinks\(\);\s*\}\);/,
        'a DOMContentLoaded hook must apply the configured Telegram link to the page');
});

test('legitimate legal and privacy addresses are deliberately left unchanged', () => {
    assert.match(TERMS, /mailto:legal@arbitrix\.ai/, 'legal@ must remain for legal matters');
    assert.match(PRIVACY, /mailto:privacy@arbitrix\.ai/, 'privacy@ must remain for privacy matters');
});

test('the support widget and support modal are untouched by this change', () => {
    for (const needle of ['id="supportPanel"', 'function toggleSupport(', 'id="supportModal"',
        'function openSupportModal(', 'function closeSupportModal(', "querySelectorAll('.js-official-telegram')"]) {
        assert.ok(INDEX.includes(needle), 'missing: ' + needle);
    }
});

test('the Telegram bot architecture, admin ids and outbound mailer are unchanged', () => {
    // Private admin routing + bot token env vars remain as before.
    assert.ok(SERVER.includes('TELEGRAM_ADMIN_IDS'), 'private admin ids config preserved');
    assert.ok(SERVER.includes('TELEGRAM_BOT_TOKEN'), 'bot token config preserved');
    assert.ok(SERVER.includes('@ArbitrixSupportBot'), 'official bot handle preserved in the backend');
    // The transactional sender is not a support contact and is intentionally kept.
    assert.ok(SERVER.includes('noreply@arbitrix.ai'), 'noreply@ sender untouched');
});
