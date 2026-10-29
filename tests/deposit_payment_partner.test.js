'use strict';

/**
 * Deposit interface after the external-purchase removal:
 *   - exactly two funding options (verified partner / existing crypto);
 *   - payment assistance and general customer support are SEPARATE contacts;
 *   - the pending-payment screen keeps its safe invoice-reference guidance.
 *
 * The link wiring is exercised by RUNNING the real functions in a vm sandbox
 * with a fake document, so the assertions are about behaviour, not strings.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist in public/index.html');
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, name + ' should be brace-matchable');
    return INDEX.slice(start, end + 1);
}

function dict() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx);
    let depth = 0, end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + '; this.T = TRANSLATIONS;', ctx);
    return ctx.T;
}

/** Runs the real link-resolution functions against a fake DOM. */
function runLinkWiring(metas = {}) {
    const nodes = {};
    const makeNode = (id, isPartnerCard) => {
        const n = {
            id, style: {}, attrs: {},
            classList: { contains: (c) => (isPartnerCard ? c === 'deposit-payment-partner' : false) },
            setAttribute: (k, v) => { n.attrs[k] = String(v); },
            getAttribute: (k) => (k in n.attrs ? n.attrs[k] : null),
            removeAttribute: (k) => { delete n.attrs[k]; },
        };
        nodes[id] = n;
        return n;
    };
    const partnerBtn = makeNode('paymentPartnerBtn', false);
    const partnerCard = makeNode('depositPaymentPartnerBtn', true);
    const officialLink = makeNode('officialTelegramLink', false);
    const note = makeNode('depositPaymentPartnerNote', false);
    const fallback = makeNode('paymentSupportFallbackBtn', false);

    const sandbox = {
        document: {
            getElementById: (id) => nodes[id] || null,
            querySelector: (sel) => {
                const m = /name="([^"]+)"/.exec(sel);
                const name = m ? m[1] : '';
                return (name in metas) ? { content: metas[name] } : null;
            },
            querySelectorAll: (sel) => {
                if (sel === '.js-payment-partner') return [partnerBtn, partnerCard];
                if (sel === '.js-official-telegram') return [officialLink];
                return [];
            },
        },
        window: {},
        openSupportModal: () => {},
        console: { log() {}, warn() {}, error() {} },
    };
    vm.createContext(sandbox);
    vm.runInContext([
        extractFunction('getPartnerSupportTelegramUrl'),
        extractFunction('getOfficialSupportTelegramUrl'),
        extractFunction('updatePaymentPartnerLinks'),
        extractFunction('updateSupportLinks'),
    ].join('\n'), sandbox);
    vm.runInContext('updatePaymentPartnerLinks(); updateSupportLinks();', sandbox);
    return { nodes, partnerBtn, partnerCard, officialLink, note, fallback };
}

// ------------------------------------------------------------------ two routes

test('the funding menu offers exactly the two intended options', () => {
    const start = INDEX.indexOf('id="depositOptions"');
    const end = INDEX.indexOf('id="depositCryptoFlow"');
    assert.ok(start > 0 && end > start);
    const menu = INDEX.slice(start, end);
    const cards = menu.match(/id="depositOption(?:Partner|Crypto|Card|Wallet)"/g) || [];
    assert.deepStrictEqual(cards, ['id="depositOptionPartner"', 'id="depositOptionCrypto"']);
    assert.match(menu, /data-i18n="deposit\.choose\.partner\.title"/);
    assert.match(menu, /data-i18n="deposit\.choose\.crypto\.title"/);
});

test('the external purchase option is gone from the whole interface', () => {
    for (const gone of [
        'depositOptionWallet', 'depositWalletPanel', 'depositBuyCryptoLink',
        'depositWalletAddress', 'depositWalletGenerateBtn', 'arbitrix-buy-crypto',
        'resolveBuyCryptoUrl', 'updateDepositWalletPanel', 'focusDepositAmount',
    ]) {
        assert.strictEqual(INDEX.indexOf(gone), -1, gone + ' must be fully removed');
    }
    // No customer-facing "coming soon"/external-purchase messages survive either.
    assert.ok(!/External purchase coming soon/i.test(INDEX));
    const T = dict();
    for (const locale of Object.keys(T)) {
        const stale = Object.keys(T[locale]).filter(
            (k) => k.indexOf('deposit.wallet.') === 0 || k.indexOf('deposit.choose.wallet') === 0);
        assert.deepStrictEqual(stale, [], locale + ' must carry no external-purchase copy');
    }
});

// ------------------------------------------------- payment partner vs. support

test('the payment partner button opens the configured t.me/Arbitrix_CSA1 link', () => {
    const wiring = runLinkWiring({ 'arbitrix-partner-support-telegram': '@Arbitrix_CSA1' });
    assert.strictEqual(wiring.partnerBtn.attrs.href, 'https://t.me/Arbitrix_CSA1');
    assert.notStrictEqual(wiring.partnerBtn.style.display, 'none', 'the pending-screen action is visible');
    assert.strictEqual(wiring.partnerCard.attrs.href, 'https://t.me/Arbitrix_CSA1');
    assert.strictEqual(wiring.partnerCard.style.display, 'block', 'the partner-panel action is visible');
    assert.notStrictEqual(wiring.note.style.display, 'none', 'the payment-partner note is shown');
});

test('official customer support stays on its own, unchanged destination', () => {
    const meta = (INDEX.match(/<meta name="arbitrix-support-telegram" content="([^"]*)">/) || [])[1];
    assert.strictEqual(meta, 'https://t.me/ArbitrixSupportBot', 'the official support profile is untouched');
    const wiring = runLinkWiring({
        'arbitrix-support-telegram': meta,
        'arbitrix-partner-support-telegram': '@Arbitrix_CSA1',
    });
    assert.strictEqual(wiring.officialLink.attrs.href, 'https://t.me/ArbitrixSupportBot');
    assert.notStrictEqual(wiring.officialLink.style.display, 'none', 'the official action stays available');
    // The two contacts can never collapse into one another.
    assert.notStrictEqual(wiring.officialLink.attrs.href, wiring.partnerBtn.attrs.href);
});

test('payment assistance is never labelled as official general support', () => {
    const T = dict();
    const partnerLabels = ['deposit.partner.contactPaymentPartner', 'deposit.partner.paymentPartnerNote'];
    for (const locale of Object.keys(T)) {
        for (const key of partnerLabels) {
            const value = String(T[locale][key]);
            assert.ok(value.trim(), locale + ' missing ' + key);
            assert.ok(!/official/i.test(value), locale + ' ' + key + ' must not claim official support status');
        }
    }
    // And the partner is not presented as able to move money.
    const allPartnerCopy = Object.keys(T.en)
        .filter((k) => k.indexOf('deposit.partner.') === 0 && k !== 'deposit.partner.empty')
        .map((k) => String(T.en[k])).join(' | ');
    assert.match(allPartnerCopy, /cannot credit your Arbitrix account|never credits your Arbitrix account/i);
    assert.ok(!/credit your account instantly|we will credit/i.test(allPartnerCopy));
});

test('an unconfigured payment partner hides the actions instead of breaking', () => {
    const wiring = runLinkWiring({ 'arbitrix-partner-support-telegram': '' });
    assert.strictEqual(wiring.partnerBtn.style.display, 'none');
    assert.strictEqual(wiring.partnerCard.style.display, 'none');
    assert.strictEqual(wiring.note.style.display, 'none');
    assert.ok(!('href' in wiring.partnerBtn.attrs), 'no href when nothing is configured');
    assert.notStrictEqual(wiring.fallback.style.display, 'none', 'the official support action remains reachable');
});

test('the configured value is a single source: a full URL or a bare @username', () => {
    const fromHandle = runLinkWiring({ 'arbitrix-partner-support-telegram': '@Arbitrix_CSA1' });
    const fromUrl = runLinkWiring({ 'arbitrix-partner-support-telegram': 'https://t.me/Arbitrix_CSA1' });
    assert.strictEqual(fromHandle.partnerBtn.attrs.href, 'https://t.me/Arbitrix_CSA1');
    assert.strictEqual(fromUrl.partnerBtn.attrs.href, 'https://t.me/Arbitrix_CSA1');
    const meta = (INDEX.match(/<meta name="arbitrix-partner-support-telegram" content="([^"]*)">/g) || []);
    assert.strictEqual(meta.length, 1, 'the destination is configured in exactly one place');
    assert.strictEqual((INDEX.match(/<meta name="arbitrix-partner-support-telegram" content="([^"]*)">/) || [])[1],
        '@Arbitrix_CSA1');
    assert.strictEqual((INDEX.match(/t\.me\/Arbitrix_CSA1/g) || []).length, 0,
        'the handle is never hard-coded as a link anywhere else');
});

test('both actions are rendered in the deposit flows that need them', () => {
    // Partner panel: the payment-partner call to action leads the directory.
    const panel = INDEX.slice(INDEX.indexOf('id="depositPartnerPanel"'), INDEX.indexOf('id="depositCryptoFlow"'));
    assert.ok(panel.includes('class="btn btn-primary js-payment-partner deposit-payment-partner"'));
    assert.ok(panel.indexOf('depositPaymentPartnerBtn') < panel.indexOf('id="depositPartnerList"'),
        'the payment partner is offered before the directory');
    // Pending-payment screen: partner action + the separate official action.
    const pending = INDEX.slice(INDEX.indexOf('id="paymentSupportHelp"'), INDEX.indexOf('id="depositSuccessSection"'));
    assert.match(pending, /id="paymentPartnerBtn"[^>]*js-payment-partner/);
    assert.match(pending, /data-i18n="deposit\.partner\.contactPaymentPartner"/);
    assert.match(pending, /class="btn btn-secondary js-official-telegram"/);
    assert.match(pending, /data-i18n="support\.officialTelegram"/);
    assert.ok(pending.indexOf('paymentPartnerBtn') < pending.indexOf('js-official-telegram'),
        'payment assistance is offered first, official support stays beside it');
});

// ------------------------------------------------------ pending screen safety

test('the pending screen keeps its safe invoice-reference guidance', () => {
    const pending = INDEX.slice(INDEX.indexOf('id="paymentSupportHelp"'), INDEX.indexOf('id="depositSuccessSection"'));
    assert.match(pending, /id="depositInvoiceRef"/, 'invoice reference still shown');
    assert.match(pending, /data-i18n="deposit\.copyInvoiceRef"/, 'copy action still offered');
    assert.match(pending, /data-i18n="deposit\.referenceExplain"/, 'reference explanation kept');
    const T = dict();
    for (const locale of Object.keys(T)) {
        const help = ['support.paymentHelp.pending', 'support.paymentHelp.detected', 'support.paymentHelp.failed']
            .map((k) => String(T[locale][k])).join(' | ');
        assert.ok(help.trim(), locale + ' payment help missing');
        // Facts a customer may share, and the secrets that are never requested.
        assert.match(help, /invoice reference|referência|referencia|facture|فاتورة|发票/i,
            locale + ' must tell the customer to share the invoice reference');
        assert.ok(!/password|otp|private key|seed phrase|recovery phrase|contraseña|carteira|chave privada/i.test(help),
            locale + ' must never ask for credentials');
        assert.ok(!/will credit your account manually|manual credit/i.test(help),
            locale + ' must not promise manual crediting');
    }
    // Nothing in the pending card collects input at all.
    assert.ok(!/<input|<textarea|contenteditable/i.test(pending), 'no secrets can be typed into this card');
});

// --------------------------------------------------------------- i18n + mobile

test('all six locales carry the payment-partner copy', () => {
    const T = dict();
    assert.deepStrictEqual(Object.keys(T).sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
    const keys = ['deposit.partner.contactPaymentPartner', 'deposit.partner.paymentPartnerNote'];
    const sizes = Object.keys(T).map((l) => Object.keys(T[l]).length);
    assert.strictEqual(new Set(sizes).size, 1, 'identical key counts across locales');
    for (const locale of Object.keys(T)) {
        for (const key of keys) {
            assert.ok(String(T[locale][key] || '').trim(), locale + ' missing ' + key);
            if (locale !== 'en') {
                assert.notStrictEqual(T[locale][key], T.en[key], locale + ' ' + key + ' is still English');
            }
        }
    }
});

test('the payment actions stay usable on narrow screens', () => {
    assert.match(INDEX, /\.payment-help-actions\{[^}]*flex-wrap:wrap/);
    assert.match(INDEX, /\.payment-help-actions > \*\{[^}]*min-width:0/);
    assert.match(INDEX, /@media \(max-width:420px\)\{\s*\.payment-help-actions\{flex-direction:column;\}/);
    assert.match(INDEX, /\.deposit-payment-partner\{[^}]*min-height:44px/);
});

// --------------------------------------------------------------- safeguards

test('deposit verification and crediting safeguards are untouched', () => {
    assert.match(INDEX, /MIN_DEPOSIT:\s*100/);
    assert.match(INDEX, /MIN_WITHDRAWAL:\s*700/);
    const cryptoFlow = INDEX.slice(INDEX.indexOf('id="depositCryptoFlow"'),
        INDEX.indexOf('id="depositPaymentSection"'));
    assert.match(cryptoFlow, /TRON \(TRC20\)/, 'the only credited network is unchanged');

    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /PLATFORM_MIN_DEPOSIT_USD = 100/);
    assert.match(server, /credit_payment_safe/);
    assert.match(server, /record_trade_safe/);
    assert.match(server, /MIN_WITHDRAWAL_USD = 700/);

    // The payment contact is contact-only: the new code adds no write path.
    const wiring = extractFunction('updatePaymentPartnerLinks');
    assert.ok(!/fetch\(|credit|record_trade|post\(/i.test(wiring), 'contact wiring performs no writes');
    assert.ok(!/openSupportModal\(\)/.test(wiring), 'the partner link never degrades into a support ticket flow');
});
