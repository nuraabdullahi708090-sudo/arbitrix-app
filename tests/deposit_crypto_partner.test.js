'use strict';

/**
 * The "I Already Have Crypto" route offers the PAYMENT PARTNER for deposit
 * help, replacing the old general-support link. Deposit questions go to the
 * partner; official support stays reachable elsewhere and keeps its destination.
 *
 * The link wiring is exercised by running the real updatePaymentPartnerLinks()
 * in a vm sandbox.
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

/** Runs the real link wiring against a fake DOM and returns the nodes. */
function wire(metaContent) {
    const nodes = {};
    const mk = (id, classes) => {
        const n = {
            id, style: {}, attrs: {}, classes,
            classList: { contains: (c) => classes.indexOf(c) >= 0 },
            setAttribute: (k, v) => { n.attrs[k] = String(v); },
            getAttribute: (k) => (k in n.attrs ? n.attrs[k] : null),
            removeAttribute: (k) => { delete n.attrs[k]; },
        };
        nodes[id] = n;
        return n;
    };
    const btn = mk('depositCryptoPartnerBtn', ['js-payment-partner', 'deposit-payment-partner']);
    const panelBtn = mk('depositPaymentPartnerBtn', ['js-payment-partner', 'deposit-payment-partner']);
    const help = mk('depositCryptoPartnerHelp', []);
    mk('paymentSupportFallbackBtn', []);
    const sandbox = {
        document: {
            getElementById: (id) => nodes[id] || null,
            querySelector: (sel) => {
                const m = /name="([^"]+)"/.exec(sel);
                return m && m[1] === 'arbitrix-partner-support-telegram' && metaContent !== undefined
                    ? { content: metaContent } : null;
            },
            querySelectorAll: (sel) => (sel === '.js-payment-partner' ? [btn, panelBtn] : []),
        },
        window: {},
        console: { log() {}, warn() {}, error() {} },
    };
    vm.createContext(sandbox);
    vm.runInContext([
        fn('getPartnerSupportTelegramUrl'),
        fn('updatePaymentPartnerLinks'),
    ].join('\n') + '\nupdatePaymentPartnerLinks();', sandbox);
    return { btn, panelBtn, help };
}

test('the direct-crypto route carries a payment-partner button, not the support link', () => {
    const flow = cryptoFlow();
    assert.match(flow, /id="depositCryptoPartnerBtn"/, 'button present');
    assert.match(flow, /data-i18n="deposit\.crypto\.partnerHelp"/, 'supporting text present');
    assert.match(flow, /data-i18n="deposit\.crypto\.partnerNote"/, 'no-crediting note present');
    assert.match(flow, /<span data-i18n="deposit\.partner\.contactPaymentPartner">Contact Payment Partner</);
    // The old official-support entry point in this route is gone.
    assert.ok(!/support\.needHelpDeposit/.test(INDEX), 'old deposit-help key retired');
    assert.ok(!/onclick="openSupportModal\(\)"/.test(flow.slice(flow.indexOf('id="safetyWarning"'))),
        'the deposit form no longer opens the support modal');
});

test('the button targets the configured partner with safe external attributes', () => {
    const { btn, help } = wire('@Arbitrix_CSA1');
    assert.strictEqual(btn.attrs.href, 'https://t.me/Arbitrix_CSA1');
    assert.notStrictEqual(btn.style.display, 'none', 'visible when configured');
    assert.notStrictEqual(help.style.display, 'none', 'help block visible when configured');
    // Same look as the verified-partner button.
    const tag = INDEX.slice(INDEX.indexOf('id="depositCryptoPartnerBtn"') - 200,
        INDEX.indexOf('id="depositCryptoPartnerBtn"') + 400);
    assert.match(tag, /class="btn btn-primary js-payment-partner deposit-payment-partner"/);
    assert.match(tag, /target="_blank"/, 'opens in a new tab');
    assert.match(tag, /rel="noopener noreferrer"/, 'safe external-link attributes');
    assert.ok(INDEX.indexOf('deposit-payment-partner{') > 0, 'shared partner button styling exists');
});

test('an unconfigured partner hides the whole block instead of breaking', () => {
    const { btn, help } = wire('');
    assert.strictEqual(btn.style.display, 'none');
    assert.strictEqual(help.style.display, 'none');
    assert.ok(!('href' in btn.attrs), 'no href is written when nothing is configured');
});

test('the copy never presents the partner as proof of payment or manual credit', () => {
    const T = dict();
    for (const locale of Object.keys(T)) {
        const help = String(T[locale]['deposit.crypto.partnerHelp']);
        const note = String(T[locale]['deposit.crypto.partnerNote']);
        assert.ok(help.trim() && note.trim(), locale + ' copy missing');
        const all = (help + ' ' + note).toLowerCase();
        assert.ok(!/proof of payment|payment proof|instantly credited|manual credit|we will credit/i.test(all),
            locale + ' must not imply the partner credits the account');
        assert.ok(/verif|v\u00e9rif|\u062a\u062d\u0642\u0642|\u9a8c\u8bc1/i.test(note), locale + ' note must state that Arbitrix verifies before crediting');
    }
    assert.strictEqual(T.en['deposit.crypto.partnerHelp'],
        'Need help with your deposit? Contact our Payment Partner on Telegram.');
    assert.match(T.en['deposit.crypto.partnerNote'], /never credits your account/);
    assert.match(T.en['deposit.crypto.partnerNote'], /only after verifying the transfer/);
});

test('official support keeps its own destination and entry points', () => {
    assert.strictEqual((INDEX.match(/<meta name="arbitrix-support-telegram" content="([^"]*)">/) || [])[1],
        'https://t.me/ArbitrixSupportBot');
    assert.strictEqual((INDEX.match(/<meta name="arbitrix-partner-support-telegram" content="([^"]*)">/) || [])[1],
        '@Arbitrix_CSA1');
    // The Support Center and its buttons are untouched.
    assert.ok(INDEX.includes('id="supportModal"'));
    assert.ok(INDEX.includes('class="js-official-telegram"') || INDEX.includes('js-official-telegram'),
        'official Telegram actions still wired');
    assert.ok(/function openSupportModal/.test(INDEX), 'support modal entry point intact');
});

test('all six locales carry the new copy and keep identical key sets', () => {
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
    const block = flow.slice(at, at + 1200);
    assert.match(block, /border-radius:10px/, 'card styling');
    assert.match(block, /width:100%/, 'full-width button');
    assert.match(block, /padding:11px/, 'tappable padding');
    assert.match(block, /overflow-wrap|word-break|width:100%/, 'text cannot overflow');
});

test('deposit rules and safeguards are unchanged', () => {
    const flow = cryptoFlow();
    assert.match(flow, /TRON \(TRC20\)/, 'network unchanged');
    assert.match(INDEX, /MIN_DEPOSIT:\s*100/);
    assert.match(INDEX, /MIN_WITHDRAWAL:\s*700/);
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /PLATFORM_MIN_DEPOSIT_USD = 100/);
    assert.match(server, /credit_payment_safe/);
    // Display-only: the new block adds no request or write.
    const block = flow.slice(flow.indexOf('id="depositCryptoPartnerHelp"'));
    const card = block.slice(0, block.indexOf('</div>'));
    assert.ok(!/fetch\(|create-invoice|credit_payment_safe|record_trade|rpc\(/i.test(card), 'no network or write path');
});
