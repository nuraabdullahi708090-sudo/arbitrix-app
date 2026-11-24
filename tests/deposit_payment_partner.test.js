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

// The partner contact icons are module-scope constants: the harnesses below run
// single functions in isolation, so the constants have to travel with them.
const PARTNER_ICONS_SRC = INDEX.slice(INDEX.indexOf('const PARTNER_ICON_WHATSAPP'),
  INDEX.indexOf("';", INDEX.indexOf('const PARTNER_ICON_TELEGRAM')) + 2);
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
      ['depositPartnerContacts', 'paymentPartnerContacts'].forEach(container);
      nodes.paymentSupportFallbackBtn = { style: {} };
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
        PARTNER_ICONS_SRC,
        'const PAYMENT_PARTNER_SLOTS = ' + JSON.stringify([
            { id: 'alex', name: 'Alex', meta: 'arbitrix-partner-support-telegram', overrideWindow: true },
            { id: 'olivia', name: 'Olivia', meta: 'arbitrix-partner-support-telegram-2', overrideWindow: false },
        ]) + ';',
        fn('normalisePartnerTelegramUrl'),
        fn('getPaymentPartnerContacts'),
        fn('getPartnerSupportTelegramUrl'),
        "const PARTNER_PRIMARY_WHATSAPP_URL = '" + (INDEX.match(/const PARTNER_PRIMARY_WHATSAPP_URL = '([^']+)';/) || [])[1] + "';",
        fn('renderPaymentPartnerContacts'),
        fn('renderDepositPartnerAssistance'),
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

  test('the generated payment session renders NO partner cards (official support only)', () => {
      // Once an invoice exists the screen has one job: make the payment. No Alex,
      // no Olivia, no "contact a payment partner" card - official Kalderix
      // support is the only assistance offered there.
      const { nodes } = render(BOTH);
      assert.strictEqual(nodes.paymentPartnerContacts.length ? nodes.paymentPartnerContacts.innerHTML : '', '',
          'no partner markup is produced for the payment session');
      assert.strictEqual(nodes.paymentSupportFallbackBtn.style.display, 'inline-flex',
          'official support is always offered in the payment session');
      assert.ok(!INDEX.includes('id="paymentPartnerContacts"'), 'the payment-session container is gone from the page');
      assert.ok(!/Contact (Alex|Olivia) for (payment )?assistance/i.test(INDEX),
          'no wording instructs the customer to contact a partner for payment help');
  });

  test('the deposit partner section is its own surface: Olivia on WhatsApp, Alex on Telegram', () => {
      const { nodes } = render(BOTH);
      const html = nodes.depositPartnerContacts.innerHTML;
      assert.ok(html.includes('href="https://wa.me/17828027841"'), 'Olivia is reached on WhatsApp');
      assert.match(html, /<svg class="partner-btn-icon"[^>]*viewBox="0 0 24 24"/, 'WhatsApp brand icon');
      assert.ok(html.includes('href="' + ALEX + '"'), 'Alex stays on Telegram');
      assert.ok(html.indexOf('data-partner="olivia"') < html.indexOf('data-partner="alex"'), 'Olivia first');
      assert.ok(!html.includes(OLIVIA), 'Olivia Telegram is never offered in the deposit flow');
  });

  test('the remaining partner surface (pre-invoice funding route) opens safely', () => {
      const { nodes } = render(BOTH);
      const html = nodes.depositPartnerContacts.innerHTML;
    assert.strictEqual((html.match(/target="_blank"/g) || []).length, 2, 'WhatsApp + Telegram both open a new tab');
    assert.strictEqual((html.match(/rel="noopener noreferrer"/g) || []).length, 2);
    assert.ok(!/https?:\/\/(?!t\.me\/|wa\.me\/)/.test(html.replace(/https:\/\/t\.me\/[A-Za-z0-9_]+/g, '')),
        'no unexpected URL reaches the markup');
});

  test('an unconfigured pair leaves no partner list and official support still shows', () => {
      const { nodes } = render({});
      assert.strictEqual(nodes.paymentSupportFallbackBtn.style.display, 'inline-flex', 'official support shown');
      // Olivia is a FIXED contact, not a meta-configured one: a missing meta can
      // never remove the primary, and it must not invent an Alex button either.
      assert.ok(nodes.depositPartnerContacts.innerHTML.includes('https://wa.me/17828027841'));
      assert.ok(!/data-partner="alex"/.test(nodes.depositPartnerContacts.innerHTML),
          'no broken Alex button without a destination');
  });

  test('a configured partner never suppresses official support in the payment session', () => {
      const { nodes } = render({ 'arbitrix-partner-support-telegram-2': '@OliviaArbitrix' });
    assert.strictEqual(nodes.paymentSupportFallbackBtn.style.display, 'inline-flex',
        'the official action is always visible in the payment session');
});

// ------------------------------------------------------------------ copy

test('the section heading and copy are the approved wording', () => {
    const T = dict();
      assert.strictEqual(T.en['deposit.partner.title'], 'Need help getting USDT?');
      assert.strictEqual(T.en['deposit.partner.intro'],
          'Our payment partners can help you obtain USDT and fund your Kalderix account.');
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
              'deposit.partner.alexNote', 'support.paymentHelp.pending']
            .map((k) => String(T[locale][k] || '')).join(' ');
        assert.ok(copy.trim().length > 100, locale + ' copy missing');
        assert.ok(!/direct sale|sells usdt|guaranteed|will credit|credits instantly|verified identity/i.test(copy),
            locale + ' must not promise a sale, a credit or identity verification');
    }
    // The safeguards are still stated.
    assert.match(T.en['deposit.partner.refHint'], /deposit address/);
      // The crypto route carries no partner copy at all any more.
      assert.ok(!('deposit.crypto.partnerNote' in T.en));
      assert.ok(!('deposit.crypto.partnerHelp' in T.en));
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
            'deposit.partner.role', 'deposit.partner.primaryLabel', 'deposit.partner.backupLabel',
            'deposit.partner.oliviaBtn', 'deposit.partner.alexBtn', 'deposit.partner.alexNote']) {
            assert.ok(String(T[locale][key] || '').trim(), locale + ' missing ' + key);
            if (locale !== 'en') {
                assert.notStrictEqual(T[locale][key], T.en[key], locale + ' ' + key + ' untranslated');
            }
        }
    }
});

// ------------------------------------------------------- support separation

test('official Kalderix Support stays separate and unchanged', () => {
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
    assert.match(server, /PLATFORM_MIN_DEPOSIT_USD = 50/);
    assert.match(server, /MIN_WITHDRAWAL_USD = 700/);
    assert.match(server, /credit_payment_safe/);
    assert.match(INDEX, /MIN_DEPOSIT:\s*50/);
    assert.match(INDEX, /TRON \(TRC20\)/);
    // The partner UI cannot create a deposit, an invoice or a credit.
    assert.ok(!/create-invoice/.test(fn('renderPaymentPartnerContacts')));
    assert.ok(!/fetch\(/.test(fn('renderPaymentPartnerContacts')));
});
