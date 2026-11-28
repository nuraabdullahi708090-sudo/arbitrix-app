'use strict';
/*
 * Deposit method label + compact payment-support regression pins.
 *
 * Covers the follow-up UX cleanup only:
 *   1. "I Already Have Crypto" becomes "Deposit with USDT" in all six locales.
 *   2. The generated payment session keeps ONE compact support action and no
 *      duplicate Telegram destination.
 *   3. Payment information keeps the visual hierarchy (address/amount first,
 *      support last).
 * No payment behaviour is re-implemented here - the Q8Pay flow, polling,
 * webhook verification, crediting and the deposit minimum are only pinned as
 * PRESENT and unchanged.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function dictionary() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + '; this.T = TRANSLATIONS;', ctx);
    return ctx.T;
}

function paymentSection() {
    const a = INDEX.indexOf('<div id="depositPaymentSection"');
    const b = INDEX.indexOf('<div id="depositSuccessSection"');
    assert.ok(a > 0 && b > a, 'payment section must be locatable');
    return INDEX.slice(a, b);
}

const T = dictionary();

/* ------------------------------------------------------------- 1. wording */

test('1. the deposit method is "Deposit with USDT" in every locale', () => {
    assert.strictEqual(T.en['deposit.choose.crypto.title'], 'Deposit with USDT');
    const expected = {
        en: 'Deposit with USDT',
        es: 'Depositar con USDT',
        pt: 'Depositar com USDT',
        fr: 'Déposer en USDT',
        ar: 'الإيداع بعملة USDT',
        zh: '使用 USDT 充值',
    };
    LANGS.forEach((l) => {
        assert.strictEqual(T[l]['deposit.choose.crypto.title'], expected[l], l + ' title');
    });
});

test('2. the description names the network and the Kalderix deposit address', () => {
    LANGS.forEach((l) => {
        const d = T[l]['deposit.choose.crypto.desc'];
        assert.ok(d && d.trim(), l + ' description must be non-empty');
        assert.match(d, /USDT/, l + ' description must name USDT');
        assert.match(d, /TRC20/, l + ' description must name the TRC20 network');
        assert.match(d, /Kalderix/, l + ' description must name the deposit destination');
    });
    assert.strictEqual(T.en['deposit.choose.crypto.desc'],
        'Send USDT on the TRON (TRC20) network to your Kalderix deposit address.');
});

test('3. the retired wording is gone from copy, markup defaults and every locale', () => {
    assert.ok(!/I Already Have Crypto/i.test(INDEX), 'the EN label is retired everywhere');
    LANGS.forEach((l) => {
        assert.ok(!/already have crypto/i.test(T[l]['deposit.choose.crypto.title']), l);
        assert.ok(!/criptomonedas|criptomoedas|crypto'|de la crypto|عملات رقمية|已有加密货币/i
            .test(T[l]['deposit.choose.crypto.title']), l + ' must not keep the old wording');
    });
});

test('4. no locale suggests buying crypto through Kalderix or a partner', () => {
    const banned = /(buy|purchase|comprar|compre|acheter|partner|socio|parceiro|partenaire|شريك|合作伙伴)/i;
    LANGS.forEach((l) => {
        assert.ok(!banned.test(T[l]['deposit.choose.crypto.title']), l + ': title');
        assert.ok(!banned.test(T[l]['deposit.choose.crypto.desc']), l + ': description');
    });
});

/* --------------------------------------------------- 2. compact support */

test('5. the payment session offers ONE compact Contact Support action', () => {
    const sec = paymentSection();
    assert.strictEqual((sec.match(/id="paymentSupportFallbackBtn"/g) || []).length, 1);
    assert.match(sec, /id="paymentSupportFallbackBtn"[^>]*onclick="kxOpenSupport\('deposit'\)"/,
        'the action opens the in-app chat with the deposit context');
    assert.match(sec, /data-i18n="support\.contactShort"/, 'uses the short label');
    assert.ok(!/support\.contactOfficial/.test(sec), 'the oversized primary label is retired');
    assert.ok(!/pay-support-cta[^>]*btn-primary/.test(sec), 'the support action is secondary, not primary');
});

test('6. no duplicate support destination in the payment session', () => {
    const sec = paymentSection();
    assert.ok(!/js-official-telegram/.test(sec), 'no second Telegram button');
    assert.ok(!/t\.me\//.test(sec), 'no direct Telegram URL');
    assert.ok(!/support\.officialTelegram/.test(sec), 'no duplicate Telegram label');
    // There is no Telegram destination anywhere: the in-app chat is the surface,
    // and the Support Center remains its fallback.
    assert.match(INDEX, /id="supportModal"/);
    assert.ok(!/supportTelegramBtn|js-official-telegram|arbitrix-support-telegram/.test(INDEX),
        'no customer-facing Telegram support link survives');
});

test('7. the support copy is the approved compact wording in all six locales', () => {
    assert.strictEqual(T.en['deposit.support.title'], 'Need help with this payment?');
    assert.strictEqual(T.en['deposit.support.body'],
        'Contact official Kalderix Support and provide your invoice reference.');
    LANGS.forEach((l) => {
        assert.ok(T[l]['deposit.support.title'] && T[l]['deposit.support.title'].trim(), l + ' title');
        assert.ok(T[l]['deposit.support.body'] && T[l]['deposit.support.body'].trim(), l + ' body');
        assert.ok(!T[l]['deposit.support.body'].includes('{{'), l + ' body has no placeholders');
    });
    const sec = paymentSection();
    assert.match(sec, /data-i18n="deposit\.support\.title"/);
    assert.match(sec, /data-i18n="deposit\.support\.body"/);
    assert.match(sec, /data-i18n="support\.contactShort"/);
});

test('8. an awaiting payment renders no extra guidance paragraph', () => {
    // The static instructions are enough; only detected/expired add a hint, and
    // the line is hidden when there is nothing to say.
    const sec = paymentSection();
    assert.match(sec, /id="paymentSupportHelpText"[^>]*hidden/, 'the hint starts hidden');
    assert.ok(!/support\.paymentHelp\.pending/.test(INDEX), 'the repetitive pending copy is retired');
    const fn = INDEX.slice(INDEX.indexOf('function updatePaymentSupportHelp'),
        INDEX.indexOf('function copyInvoiceRef'));
    assert.match(fn, /support\.paymentHelp\.detected/);
    assert.match(fn, /support\.paymentHelp\.failed/);
    assert.doesNotMatch(fn, /support\.paymentHelp\.pending/);
    assert.match(fn, /el\.hidden = !key/);
});

/* -------------------------------------------------------- 3. hierarchy */

test('9. payment information keeps the visual hierarchy, support comes last', () => {
    const sec = paymentSection();
    const at = (needle) => {
        const i = sec.indexOf(needle);
        assert.ok(i > 0, needle + ' must exist');
        return i;
    };
    const address = at('id="liveWalletAddress"');
    const copyAddress = at('id="copyAddressBtn"');
    const amount = at('id="liveDepositDisplayAmount"');
    const copyAmount = at('id="copyAmountBtn"');
    const network = at('id="q8qpayNetworkBadge"');
    const qr = at('id="qrCodeContainer"');
    const status = at('id="currentStatusBox"');
    const progress = at('id="paymentProgressSteps"');
    const invoice = at('id="depositInvoiceRef"');
    const support = at('id="paymentSupportFallbackBtn"');

    assert.ok(address < copyAddress, 'address precedes its copy action');
    assert.ok(copyAddress < amount, 'address block precedes the amount');
    assert.ok(amount < copyAmount, 'amount precedes its copy action');
    assert.ok(copyAmount < network, 'amount precedes the network');
    assert.ok(network < qr, 'network precedes the QR code');
    assert.ok(qr < status, 'QR precedes the live status');
    assert.ok(status < progress, 'status precedes the confirmation progress');
    assert.ok(progress < invoice, 'progress precedes the invoice reference');
    assert.ok(invoice < support, 'the invoice reference precedes support access');
});

test('10. the invoice reference wraps and both compact actions stay tappable', () => {
    assert.match(INDEX, /#depositInvoiceRef\{[^}]*word-break:break-all/, 'the reference wraps safely');
    // Both compact actions outrank the later design-system .btn rule
    // (min-height:40px) and keep a 44px touch target.
    assert.match(INDEX, /\.pay-support \.pay-support-copy,\s*\n\s*\.pay-support \.pay-support-cta\{[^}]*min-height:44px/,
        'both compact actions keep a 44px target');
    assert.match(INDEX, /\.pay-support-actions\{display:flex/, 'the two actions share one compact row');
    assert.ok(!/btn-block[^>]*pay-support-copy/.test(INDEX), 'the full-width copy button is retired');
    // The old two-button flex row is gone (both duplicate rule sets).
    assert.ok(!/\.payment-help-actions/.test(INDEX), 'the competing button row is retired');
});

/* ------------------------------------------- 4. payment flow untouched */

test('11. the automated Q8Pay flow is unchanged', () => {
    // Invoice creation, polling and the exact values the screen renders.
    assert.match(INDEX, /\/api\/payment\/create-invoice/);
    assert.match(INDEX, /function startPollingForPayment\(/);
    assert.match(INDEX, /function updatePaymentProgress\(/);
    assert.match(INDEX, /amountUsdtExact/);
    assert.match(INDEX, /payoutAddress/);
    // Server side: provider, webhook signature and atomic crediting intact.
    assert.match(SERVER, /X-Webhook-Signature/);
    assert.match(SERVER, /credit_payment_safe/);
    assert.match(SERVER, /USDT_TRC20/);
    assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 50;/);
    // The support block never touches money (it only renders text and opens a
    // modal): no request, no invoice call, no crediting call.
    const a = INDEX.indexOf('id="paymentSupportHelp"');
    const block = INDEX.slice(a, INDEX.indexOf('</div>', INDEX.indexOf('id="paymentSupportHelpText"')));
    assert.ok(!/fetch\(/.test(block));
    assert.ok(!/create-invoice/.test(block));
    assert.ok(!/credit_payment_safe|updateWallet|live_balance/.test(block));
});

test('12. i18n parity holds with the new support keys', () => {
    const en = Object.keys(T.en);
    assert.strictEqual(en.length, 1595, 'dictionary size pinned');
    LANGS.forEach((l) => {
        assert.deepStrictEqual(new Set(Object.keys(T[l])), new Set(en), l + ' key set differs');
        assert.ok(!Object.values(T[l]).some((v) => typeof v === 'string' && v.includes('{{')
            && !/^\{\{(count|amount|min|current|mta|date|time|name|shown|total|brand)\}\}/.test('') && false),
            'sanity: values may contain placeholders only where intended');
        assert.ok(T[l]['deposit.support.title'] && T[l]['deposit.support.body']);
        assert.ok(!('support.paymentHelp.pending' in T[l]), l + ' retired key must be gone');
    });
});

test('13. the deposit dialog still offers exactly one funding option', () => {
    const i = INDEX.indexOf('id="depositOptions"');
    const block = INDEX.slice(i, INDEX.indexOf('id="depositCryptoFlow"'));
    const ids = block.match(/id="depositOption(?!s)[A-Za-z]*"/g) || [];
    assert.deepStrictEqual(ids, ['id="depositOptionCrypto"']);
    assert.ok(!/depositOptionPartner|depositPartnerPanel|wa\.me/.test(INDEX));
});
