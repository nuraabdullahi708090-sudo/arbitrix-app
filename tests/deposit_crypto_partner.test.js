'use strict';

/**
 * The "I Already Have Crypto" route offers BOTH payment partners (Alex and
 * Olivia) for deposit help, replacing the old general-support link. General
 * account support stays separate and unchanged.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const cryptoFlow = () => INDEX.slice(INDEX.indexOf('id="depositCryptoFlow"'),
    INDEX.indexOf('id="depositPaymentSection"'));

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

/** Runs the real renderer for the direct-crypto container. */
function renderCrypto(metas) {
    const box = { style: {}, innerHTML: '' };
    const sandbox = {
        window: {},
        document: {
            getElementById: (id) => (id === 'depositCryptoPartnerContacts' ? box : null),
            querySelector: (sel) => {
                const m = /name="([^"]+)"/.exec(sel);
                return m && m[1] in metas ? { content: metas[m[1]] } : null;
            },
        },
        escapeHtml: (v) => String(v == null ? '' : v).replace(/"/g, '&quot;').replace(/</g, '&lt;'),
        t: (k, vars) => String(dict().en[k] || k)
            .replace(/\{\{(\w+)\}\}/g, (m0, g) => (vars && vars[g] != null ? vars[g] : m0)),
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
        fn('renderPaymentPartnerContacts'),
        'renderPaymentPartnerContacts();',
    ].join('\n'), sandbox);
    return box;
}

const BOTH = {
    'arbitrix-partner-support-telegram': '@AlexArbitrix',
    'arbitrix-partner-support-telegram-2': '@OliviaArbitrix',
};

test('the direct-crypto route carries both payment partners, not the support link', () => {
    const flow = cryptoFlow();
    assert.match(flow, /id="depositCryptoPartnerContacts" class="payment-partner-list"/, 'contacts list present');
    assert.match(flow, /data-i18n="deposit\.crypto\.partnerHelp"/, 'supporting text present');
    assert.match(flow, /data-i18n="deposit\.crypto\.partnerNote"/, 'no-crediting note present');
    assert.ok(!/support\.needHelpDeposit/.test(INDEX), 'old deposit-help key retired');
    assert.ok(!/onclick="openSupportModal\(\)"/.test(flow.slice(flow.indexOf('id="safetyWarning"'))),
        'the deposit form no longer opens the support modal');
});

test('the rendered buttons point at Alex and Olivia with safe attributes', () => {
    const box = renderCrypto(BOTH);
    const html = box.innerHTML;
    assert.ok(html.includes('https://t.me/AlexArbitrix'), 'Alex link');
    assert.ok(html.includes('https://t.me/OliviaArbitrix'), 'Olivia link');
    assert.ok(html.includes('>Contact Alex<') && html.includes('>Contact Olivia<'), 'labelled buttons');
    assert.strictEqual((html.match(/target="_blank"/g) || []).length, 2, 'new tab');
    assert.strictEqual((html.match(/rel="noopener noreferrer"/g) || []).length, 2, 'safe rel');
    assert.ok(html.includes('deposit-payment-partner'), 'shared yellow styling');
    assert.ok(!/Arbitrix_CSA1/.test(html), 'the retired account is never rendered');
    assert.notStrictEqual(box.style.display, 'none', 'list visible when configured');
});

test('an unconfigured pair renders nothing instead of a broken link', () => {
    const box = renderCrypto({});
    assert.strictEqual(box.innerHTML, '');
    assert.strictEqual(box.style.display, 'none');
});

test('the copy never presents a partner as proof of payment or manual credit', () => {
    const T = dict();
    for (const locale of Object.keys(T)) {
        const help = String(T[locale]['deposit.crypto.partnerHelp']);
        const note = String(T[locale]['deposit.crypto.partnerNote']);
        assert.ok(help.trim() && note.trim(), locale + ' copy missing');
        const all = (help + ' ' + note).toLowerCase();
        assert.ok(!/proof of payment|payment proof|instantly credited|manual credit|we will credit/i.test(all),
            locale + ' must not imply the partner credits the account');
        assert.ok(/verif|v\u00e9rif|\u062a\u062d\u0642\u0642|\u9a8c\u8bc1/i.test(note),
            locale + ' note must state that Arbitrix verifies before crediting');
    }
    assert.match(T.en['deposit.crypto.partnerHelp'], /Contact one of our payment partners/);
    assert.match(T.en['deposit.crypto.partnerNote'], /never credits your account/);
    assert.match(T.en['deposit.crypto.partnerNote'], /only after verifying the transfer/);
});

test('official support keeps its own destination and entry points', () => {
    assert.strictEqual((INDEX.match(/<meta name="arbitrix-support-telegram" content="([^"]*)">/) || [])[1],
        'https://t.me/ArbitrixSupportBot');
    assert.strictEqual((INDEX.match(/<meta name="arbitrix-partner-support-telegram" content="([^"]*)">/) || [])[1],
        '@AlexArbitrix');
    assert.ok(INDEX.includes('id="supportModal"'));
    assert.ok(INDEX.includes('js-official-telegram'), 'official Telegram actions still wired');
    assert.ok(/function openSupportModal/.test(INDEX), 'support modal entry point intact');
});

test('all six locales carry the crypto copy and keep identical key sets', () => {
    const T = dict();
    assert.deepStrictEqual(Object.keys(T).sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
    const sizes = Object.keys(T).map((l) => Object.keys(T[l]).length);
    assert.strictEqual(new Set(sizes).size, 1, 'identical key counts');
    for (const locale of Object.keys(T)) {
        for (const key of ['deposit.crypto.partnerHelp', 'deposit.crypto.partnerNote']) {
            assert.ok(String(T[locale][key] || '').trim(), locale + ' missing ' + key);
            if (locale !== 'en') assert.notStrictEqual(T[locale][key], T.en[key], locale + ' ' + key + ' untranslated');
        }
    }
});

test('the block stays mobile-friendly', () => {
    const flow = cryptoFlow();
    const at = flow.indexOf('id="depositCryptoPartnerHelp"');
    const block = flow.slice(at, at + 1400);
    assert.match(block, /border-radius:10px/, 'card styling');
    assert.match(block, /payment-partner-list/, 'responsive partner grid');
    assert.match(INDEX, /\.payment-partner-card \.deposit-payment-partner\{margin:0;min-height:44px;\}/,
        'tappable buttons');
    assert.match(INDEX, /@media \(min-width:420px\)\{\.payment-partner-list\{grid-template-columns:1fr 1fr;\}\}/,
        'two columns on wider screens');
});

test('deposit rules and safeguards are unchanged', () => {
    const flow = cryptoFlow();
    assert.match(flow, /TRON \(TRC20\)/, 'network unchanged');
    assert.match(INDEX, /MIN_DEPOSIT:\s*100/);
    assert.match(INDEX, /MIN_WITHDRAWAL:\s*700/);
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /PLATFORM_MIN_DEPOSIT_USD = 100/);
    assert.match(server, /credit_payment_safe/);
    assert.ok(!/fetch\(|create-invoice|credit_payment_safe|record_trade|rpc\(/i.test(fn('renderPaymentPartnerContacts')),
        'no network or write path');
});
