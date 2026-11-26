'use strict';

/**
 * FOOTER / CUSTOMER SUPPORT CONTACT - regression tests.
 *
 * The website once published `support@arbitrix.ai` (a mailbox that does not
 * exist) and later the Telegram support bot as the customer's support
 * destination. Neither is correct now: customer support is the IN-APP messenger,
 * the same conversation the Admin Dashboard and the internal Telegram agent
 * channel read and write.
 *
 * This file pins that contract:
 *   - the footer Contact section opens the in-app chat and publishes NO email,
 *     NO Telegram handle and no configurable Telegram link;
 *   - the whole app has ONE support entry point (kxOpenSupport) and no
 *     customer-facing Telegram support destination;
 *   - the legal pages point at the in-app chat too (no version of the old
 *     third-party domain or an unusable mailbox);
 *   - Telegram's INTERNAL role (bot token, admin ids, the shared conversation)
 *     is untouched.
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

test('the footer Contact section opens the in-app support chat', () => {
    const link = (FOOTER.match(/<a[^>]*data-kx-support[^>]*>[\s\S]*?<\/a>/) || [])[0];
    assert.ok(link, 'the Contact column carries the in-app support link');
    assert.match(link, /href="\/\?support=1"/, 'the href is the app support deep link (works without JS)');
    assert.match(link, /data-kx-support="general"/, 'the click handler opens the messenger');
    assert.match(link, /data-i18n="support\.contactShort"/, 'localized label');
    assert.ok(!/Telegram/i.test(FOOTER), 'no Telegram label in the footer Contact section');
    assert.ok(!/@ArbitrixSupportBot/.test(FOOTER), 'no Telegram handle in the footer Contact section');
});

test('the footer Contact section contains no email address', () => {
    assert.ok(!FOOTER.includes(INVALID_SUPPORT_EMAIL), 'invalid support mailbox removed');
    assert.ok(!/mailto:/i.test(FOOTER), 'no mailto link in the footer Contact section');
    assert.ok(!/@arbitrix\.ai/.test(FOOTER), 'no arbitrix.ai mailbox in the footer Contact section');
});

test('the footer support link is a same-app link, so it needs no new-tab attributes', () => {
    const anchors = FOOTER.match(/<a[^>]*js-official-telegram[^>]*>/g) || [];
    assert.strictEqual(anchors.length, 0, 'the configurable Telegram anchors are retired');
    const support = (FOOTER.match(/<a[^>]*data-kx-support[^>]*>[\s\S]*?<\/a>/) || [])[0] || '';
    assert.ok(!/target="_blank"/.test(support), 'the chat opens in the same tab');
    assert.ok(!/t\.me/.test(support), 'no Telegram destination');
});

test('no customer-facing Telegram support destination is configured anywhere', () => {
    assert.ok(!/arbitrix-support-telegram/.test(INDEX), 'the support-bot meta config is retired');
    assert.ok(!/ArbitrixSupportBot/.test(INDEX), 'the support handle is not published in the app');
    // The withdrawal tutorial (announcement channel) is content, not support, and
    // is deliberately preserved.
    const links = (INDEX.match(/https?:\/\/t\.me\/[A-Za-z0-9_\/]+/g) || []);
    assert.deepStrictEqual(links, ['https://t.me/ArbitrixAnnouncements/19'],
        'the only t.me link left is the withdrawal tutorial');
});

test('the footer link opens the messenger instead of loading a new page', () => {
    // One delegated handler serves every [data-kx-support] element, so the footer
    // anchor does not need its own inline script and cannot drift from the rest.
    const handler = extractFunction('kxOpenSupport');
    assert.ok(/NativeSupport\.open/.test(handler), 'the messenger is the primary surface');
    assert.ok(/openSupportModal/.test(handler), 'and the Support Center is the fallback');
    assert.match(INDEX, /closest\('\[data-kx-support\]'\)/,
        'a delegated handler intercepts the footer (and any other) support link');
    assert.match(INDEX, /kxOpenSupport\(el\.getAttribute\('data-kx-support'\)\)/,
        'the element declares which area the customer came from');
});

test('no customer-facing invalid support email remains in the app', () => {
    assert.ok(!INDEX.includes(INVALID_SUPPORT_EMAIL), 'index.html must not contain the invalid mailbox');
    assert.ok(!/mailto:support@/i.test(INDEX), 'no support mailto link anywhere in index.html');
});

test('the retired Telegram fallback cannot return, and no support copy invites email', () => {
    for (const l of LANGS) {
        assert.ok(!T[l]['support.notConfigured'], l + ': the Telegram fallback key is retired');
        assert.ok(!T[l]['support.telegramShort'], l + ': the Telegram label is retired');
        assert.ok(!T[l]['support.officialTelegram'], l + ': the Telegram CTA is retired');
        // The replacement copy explains the in-app chat and never offers an email.
        for (const k of ['support.startChat', 'support.chatHint']) {
            assert.ok(T[l][k] && T[l][k].trim(), l + ': ' + k + ' must be present');
            assert.ok(!/@/.test(T[l][k]), l + ': ' + k + ' must not contain an email address');
        }
    }
});

test('the support label is localized in every locale and no handle is printed', () => {
    for (const l of LANGS) {
        assert.ok(T[l]['support.contactShort'], l + ' must localize the support label');
    }
    assert.strictEqual((FOOTER.match(/@/g) || []).length, 0, 'no handle of any kind in the footer column');
});

test('the footer support link works for an anonymous visitor too', () => {
    // It is a real href (the app support deep link), so it needs no JavaScript to
    // be a valid destination; the delegated handler upgrades the click in-app.
    assert.match(FOOTER, /<a[^>]*href="\/\?support=1"/,
        'a signed-out visitor still gets a working destination');
    assert.match(INDEX, /function kxSupportDeepLink\(/,
        'and the app understands ?support=1 when it loads');
});

test('the legal pages publish the platform domain and official channel only', () => {
    // arbitrix.ai is NOT the platform: https://arbitrix.ai redirects to
    // https://www.arbitrix.ai, which belongs to a different company. No
    // arbitrix.ai reference, and no mailbox on it, may remain in a legal page.
    for (const [name, page] of [['terms-of-service.html', TERMS], ['privacy-policy.html', PRIVACY]]) {
        assert.ok(!/arbitrix\.ai/i.test(page), name + ' must not reference the third-party arbitrix.ai domain');
        assert.ok(!/mailto:[^"]*kalderix\.ai/i.test(page), name + ' must not publish a mailbox on arbitrix.ai');
        assert.match(page, /https:\/\/arbitrix\.pro/, name + ' must publish the platform domain');
        assert.ok(!/t\.me\//.test(page), name + ' must not publish a Telegram support destination');
        assert.match(page, /https:\/\/arbitrix\.pro\/\?support=1/, name + ' must point at the in-app support chat');
        // Requested cleanup: the verbose inline "Operator: ..." line is gone, so
        // the contact block stays minimal (support + website only).
        assert.ok(!/registered with the Netherlands Chamber of Commerce/.test(page),
            name + ' must not carry the removed Operator line');
    }
    // The Privacy Policy (the page that defines "we") still names the operator
    // entity in its opening sentence.
    assert.match(PRIVACY, /Kalderix, operated by Arbitrix Trading/,
        'the Privacy Policy must still name the operator entity');
});

test('the support widget and support modal are untouched by this change', () => {
    for (const needle of ['id="supportPanel"', 'function toggleSupport(', 'id="supportModal"',
        'function openSupportModal(', 'function closeSupportModal(', 'function kxOpenSupport(']) {
        assert.ok(INDEX.includes(needle), 'missing: ' + needle);
    }
});

test('the Telegram bot architecture, admin ids and outbound mailer are unchanged', () => {
    // Private admin routing + bot token env vars remain as before.
    assert.ok(SERVER.includes('TELEGRAM_ADMIN_IDS'), 'private admin ids config preserved');
    assert.ok(SERVER.includes('TELEGRAM_BOT_TOKEN'), 'bot token config preserved');
    assert.ok(SERVER.includes('@ArbitrixSupportBot'), 'official bot handle preserved in the backend');
    // The transactional sender is not a support contact and is intentionally kept.
    // The sender moved into the single BRAND module (the display name follows
    // the brand, the ADDRESS stays on the verified mail domain). Assert the
    // address survives in whichever file owns it now.
    const brandSrc = fs.readFileSync(path.join(ROOT, 'services', 'brand.js'), 'utf8');
    assert.ok(
        SERVER.includes('noreply@arbitrix.ai') || brandSrc.includes("noreply@' + BRAND.mailDomain") || brandSrc.includes('noreply@'),
        'noreply@ sender untouched'
    );
    assert.ok(brandSrc.includes("mailDomain: 'arbitrix.ai'"), 'the mail domain is unchanged');
});
