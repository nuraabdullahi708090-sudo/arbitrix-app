'use strict';

/**
 * Payment partners: Alex (@AlexArbitrix) and Olivia (@OliviaArbitrix) are the
 * only two partners, and every deposit entry point offers BOTH of them.
 *
 * The real configuration + renderer are executed in a vm sandbox with a fake
 * DOM, so the assertions follow what the page actually renders.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const ALEX = 'https://t.me/AlexArbitrix';
const OLIVIA = 'https://t.me/OliviaArbitrix';

function dict() {
    const i0 = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', i0), depth = 0, end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(INDEX.slice(i0, end + 1) + '; this.T = TRANSLATIONS;', ctx);
    return ctx.T;
}

function fn(name) {
    const start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist');
    let i = INDEX.indexOf('{', start), depth = 0, end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    return INDEX.slice(start, end + 1);
}

/** Builds the fake DOM the wiring touches and runs the real functions. */
function render(metas, opts = {}) {
    const nodes = {};
    const container = (id) => {
        const n = { id, style: {}, innerHTML: '' };
        nodes[id] = n;
        return n;
    };
    ['depositPartnerContacts', 'depositCryptoPartnerContacts', 'paymentPartnerContacts'].forEach(container);
    nodes.paymentSupportFallbackBtn = { style: {} };
    nodes.depositCryptoPartnerHelp = { style: {} };
    const sandbox = {
        window: opts.window || {},
        document: {
            getElementById: (id) => nodes[id] || null,
            querySelector: (sel) => {
                const m = /name="([^"]+)"/.exec(sel);
                if (!m || !(m[1] in metas)) return null;
                return { content: metas[m[1]] };
            },
        },
        escapeHtml: (v) => String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        t: (k, vars) => {
            const raw = dict().en[k] || k;
            return String(raw).replace(/\{\{(\w+)\}\}/g, (m0, g) => (vars && vars[g] != null ? vars[g] : m0));
        },
        console: { log() {}, warn() {}, error() {} },
    };
    vm.createContext(sandbox);
    vm.runInContext([
        'const PAYMENT_PARTNER_SLOTS = ' + JSON.stringify([
            { id: 'alex', name: 'Alex', meta: 'arbitrix-partner-support-telegram', overrideWindow: true },
            { id: 'olivia', name: 'Olivia', meta: 'arbitrix-partner-support-telegram-2', overrideWindow: false },
        ]) + ';',
        fn('normalisePartnerTelegramUrl'),
        fn('getPaymentPartnerContacts'),
        fn('getPartnerSupportTelegramUrl'),
        fn('renderPaymentPartnerContacts'),
        fn('updatePaymentPartnerLinks'),
        'updatePaymentPartnerLinks();',
        'this.contacts = getPaymentPartnerContacts(); this.primary = getPartnerSupportTelegramUrl();',
    ].join('\n'), sandbox);
    return { nodes, contacts: sandbox.contacts, primary: sandbox.primary };
}

const BOTH = {
    'arbitrix-partner-support-telegram': '@AlexArbitrix',
    'arbitrix-partner-support-telegram-2': '@OliviaArbitrix',
};

// ------------------------------------------------------------------ config

test('exactly two partners are configured, in order, from one meta each', () => {
    assert.strictEqual((INDEX.match(/<meta name="arbitrix-partner-support-telegram" content="([^"]*)">/) || [])[1],
        '@AlexArbitrix');
    assert.strictEqual((INDEX.match(/<meta name="arbitrix-partner-support-telegram-2" content="([^"]*)">/) || [])[1],
        '@OliviaArbitrix');
    const { contacts, primary } = render(BOTH);
    assert.deepStrictEqual(Array.from(contacts, (c) => c.name), ['Alex', 'Olivia']);
    assert.deepStrictEqual(Array.from(contacts, (c) => c.url), [ALEX, OLIVIA]);
    assert.strictEqual(primary, ALEX, 'the single-contact helper returns the first partner');
});

test('a partner value may be a full Telegram URL and junk is ignored', () => {
    assert.strictEqual(render(BOTH).contacts.length, 2);
    const urlsOnly = render({
        'arbitrix-partner-support-telegram': 'https://t.me/AlexArbitrix',
        'arbitrix-partner-support-telegram-2': 'https://evil.example.com/olivia',
    }).contacts;
    assert.deepStrictEqual(Array.from(urlsOnly, (c) => c.url), [ALEX], 'non-Telegram destinations are dropped');
    const junk = render({
        'arbitrix-partner-support-telegram': 'not a username',
        'arbitrix-partner-support-telegram-2': '@OliviaArbitrix',
    }).contacts;
    assert.deepStrictEqual(Array.from(junk, (c) => c.url), [OLIVIA]);
});

test('a window override replaces slot 1 only', () => {
    const { contacts } = render(BOTH, { window: { ARBITRIX_PARTNER_SUPPORT_TELEGRAM_URL: '@AlexBackup' } });
    assert.deepStrictEqual(Array.from(contacts, (c) => c.url), ['https://t.me/AlexBackup', OLIVIA]);
});

// ----------------------------------------------------------------- render

test('both partners are rendered in every deposit entry point', () => {
    const { nodes } = render(BOTH);
    for (const id of ['depositPartnerContacts', 'depositCryptoPartnerContacts', 'paymentPartnerContacts']) {
        const html = nodes[id].innerHTML;
        assert.ok(html.includes('href="' + ALEX + '"'), id + ' links to Alex');
        assert.ok(html.includes('href="' + OLIVIA + '"'), id + ' links to Olivia');
        assert.ok(html.includes('data-partner="alex"') && html.includes('data-partner="olivia"'), id + ' is per-partner');
        assert.ok(html.includes('>Contact Alex<') && html.includes('>Contact Olivia<'), id + ' labelled buttons');
        assert.ok(html.includes('Payment Partner'), id + ' states the role');
        assert.strictEqual(html.split('data-partner=').length - 1, 2, id + ' shows exactly two partners');
        assert.notStrictEqual(nodes[id].style.display, 'none', id + ' visible when configured');
    }
});

test('every partner button opens Telegram in a new tab safely', () => {
    const { nodes } = render(BOTH);
    const html = nodes.depositPartnerContacts.innerHTML;
    assert.strictEqual((html.match(/target="_blank"/g) || []).length, 2);
    assert.strictEqual((html.match(/rel="noopener noreferrer"/g) || []).length, 2);
    assert.ok(html.includes('deposit-payment-partner'), 'shared yellow button styling');
    assert.ok(!/https?:\/\/(?!t\.me\/)/.test(html.replace(/https:\/\/t\.me\/[A-Za-z0-9_]+/g, '')),
        'no non-Telegram URL reaches the markup');
});

test('an unconfigured pair hides the lists and restores official support', () => {
    const { nodes } = render({});
    for (const id of ['depositPartnerContacts', 'depositCryptoPartnerContacts', 'paymentPartnerContacts']) {
        assert.strictEqual(nodes[id].style.display, 'none', id + ' hidden');
        assert.strictEqual(nodes[id].innerHTML, '', id + ' renders nothing');
    }
    assert.strictEqual(nodes.paymentSupportFallbackBtn.style.display, 'inline-flex');
    assert.strictEqual(nodes.depositCryptoPartnerHelp.style.display, 'none');
});

test('one configured partner is enough to show the list', () => {
    const { nodes } = render({ 'arbitrix-partner-support-telegram-2': '@OliviaArbitrix' });
    const html = nodes.depositPartnerContacts.innerHTML;
    assert.ok(html.includes(OLIVIA) && !html.includes(ALEX));
    assert.strictEqual(nodes.paymentSupportFallbackBtn.style.display, 'none');
});

// ------------------------------------------------------------------ copy

test('the section heading and copy are the approved wording', () => {
    const T = dict();
    assert.strictEqual(T.en['deposit.partner.title'], 'Verified Payment Partners');
    assert.strictEqual(T.en['deposit.partner.intro'],
        'Need help obtaining USDT or funding your Arbitrix account? Contact one of our payment partners for assistance.');
    assert.strictEqual(T.en['deposit.partner.contactName'], 'Contact {{name}}');
    assert.strictEqual(T.en['deposit.partner.role'], 'Payment Partner');
    // The single-partner labels are retired.
    assert.ok(!('deposit.partner.contactPaymentPartner' in T.en));
    assert.ok(!('deposit.partner.servicesIntro' in T.en));
});

test('the partnership never claims a manual credit, direct sale or verification', () => {
    const T = dict();
    for (const locale of Object.keys(T)) {
        const copy = ['deposit.partner.intro', 'deposit.partner.refHint', 'deposit.partner.refReady',
            'deposit.crypto.partnerHelp', 'deposit.crypto.partnerNote', 'support.paymentHelp.pending']
            .map((k) => String(T[locale][k] || '')).join(' ');
        assert.ok(copy.trim().length > 100, locale + ' copy missing');
        assert.ok(!/direct sale|sells usdt|guaranteed|will credit|credits instantly|verified identity/i.test(copy),
            locale + ' must not promise a sale, a credit or identity verification');
    }
    // The safeguards are still stated.
    assert.match(T.en['deposit.partner.refHint'], /deposit address/);
    assert.match(T.en['deposit.crypto.partnerNote'], /never credits your account/);
    assert.match(T.en['deposit.crypto.partnerNote'], /only after verifying the transfer/);
});

test('no locale hard-codes a partner handle or the retired account', () => {
    const T = dict();
    for (const locale of Object.keys(T)) {
        for (const key of Object.keys(T[locale])) {
            const value = String(T[locale][key]);
            assert.ok(!/Arbitrix_CSA1/.test(value), locale + ' ' + key + ' must not name the retired account');
            assert.ok(!/t\.me\//.test(value), locale + ' ' + key + ' must not embed a Telegram URL');
        }
    }
    assert.ok(!/Arbitrix_CSA1/.test(INDEX), 'the old partner account is gone from the page');
});

test('all six locales carry the partner keys and keep identical key sets', () => {
    const T = dict();
    assert.deepStrictEqual(Object.keys(T).sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
    const sizes = Object.keys(T).map((l) => Object.keys(T[l]).length);
    assert.strictEqual(new Set(sizes).size, 1, 'identical key counts');
    for (const locale of Object.keys(T)) {
        for (const key of ['deposit.partner.title', 'deposit.partner.intro', 'deposit.partner.contactName',
            'deposit.partner.role', 'deposit.crypto.partnerHelp']) {
            assert.ok(String(T[locale][key] || '').trim(), locale + ' missing ' + key);
            if (locale !== 'en') {
                assert.notStrictEqual(T[locale][key], T.en[key], locale + ' ' + key + ' untranslated');
            }
        }
    }
});

// ------------------------------------------------------- support separation

test('official Arbitrix Support stays separate and unchanged', () => {
    assert.strictEqual((INDEX.match(/<meta name="arbitrix-support-telegram" content="([^"]*)">/) || [])[1],
        'https://t.me/ArbitrixSupportBot');
    assert.ok(INDEX.includes('id="supportModal"'), 'Support Center intact');
    assert.ok(/function openSupportModal/.test(INDEX));
    assert.ok(INDEX.includes('support.contactOfficial'), 'official support CTA kept');
    assert.ok(INDEX.includes('js-official-telegram'), 'official Telegram actions kept');
    assert.ok(!/t\.me\/ArbitrixSupportBot/.test(INDEX.split('id="depositPartnerContacts"')[1] || ''),
        'the partner block never carries the official support destination');
});

test('deposit rules and safeguards are untouched', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /PLATFORM_MIN_DEPOSIT_USD = 100/);
    assert.match(server, /MIN_WITHDRAWAL_USD = 700/);
    assert.match(server, /credit_payment_safe/);
    assert.match(INDEX, /MIN_DEPOSIT:\s*100/);
    assert.match(INDEX, /TRON \(TRC20\)/);
    // The partner UI cannot create a deposit, an invoice or a credit.
    assert.ok(!/create-invoice/.test(fn('renderPaymentPartnerContacts')));
    assert.ok(!/fetch\(/.test(fn('renderPaymentPartnerContacts')));
});
