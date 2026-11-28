/**
 * The deposit journey has ONE funding route: the automated USDT (TRC20) flow.
 *
 * Management removed the customer-facing "Buy from a Verified Partner" route
 * (Olivia on WhatsApp / Alex on Telegram). These tests are the guard rail:
 *
 *   - no partner chooser, panel, card, button, meta tag or contact helper is
 *     left anywhere a customer can reach;
 *   - the partner names, the WhatsApp number and the Telegram handles cannot
 *     reappear in the deposit journey;
 *   - general Official Support (Support Center, sidebar entry, payment-session
 *     CTA) is untouched;
 *   - the automated route is unchanged: same endpoint, same provider, same
 *     polling, same server-side webhook + reconciliation;
 *   - the ADMIN partner directory stays available (dormant data) and stays
 *     admin-only, so no customer surface is reintroduced by accident.
 */

const test = require('node:test');
const { readLf } = require('./helpers/text');
const assert = require('node:assert');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = readLf(path.join(ROOT, 'public', 'index.html'));
const SERVER = readLf(path.join(ROOT, 'server.js'));
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function translations() {
    const start = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let j = i; j < INDEX.length; j += 1) {
        if (INDEX[j] === '{') depth += 1;
        else if (INDEX[j] === '}') {
            depth -= 1;
            if (depth === 0) { end = j; break; }
        }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(`${INDEX.slice(start, end + 1)};globalThis.T = TRANSLATIONS;`, sandbox);
    return sandbox.T;
}

// The deposit surfaces only: everything from the deposit modal through the
// payment session. Scoping keeps the assertion precise (the sample-activity
// ticker elsewhere on the page lists common first names, which has nothing to
// do with the removed payment partners).
function depositMarkup() {
    const start = INDEX.indexOf('<div class="deposit-modal" id="depositModal">');
    const end = INDEX.indexOf("<!-- Hidden inputs -->", start);
    assert.ok(start > 0 && end > start, 'deposit modal must be locatable');
    return INDEX.slice(start, end);
}

test('1. exactly one funding route is offered, and it is the automated one', () => {
    const markup = depositMarkup();
    const options = markup.slice(markup.indexOf('id="depositOptions"'),
        markup.indexOf('id="depositCryptoFlow"'));
    const buttons = options.match(/id="depositOption(?!s)[A-Za-z]*"/g) || [];
    assert.deepStrictEqual(buttons, ['id="depositOptionCrypto"'], 'one funding option must remain');
    assert.match(options, /id="depositOptionCrypto"/);
    assert.match(options, /data-i18n="deposit\.choose\.crypto\.title"/);
    assert.ok(!options.includes('depositOptionPartner'), 'partner option must be gone');
});

test('2. no partner panel, container or contact list is left in the journey', () => {
    for (const id of ['depositPartnerPanel', 'depositPartnerContacts', 'depositPartnerList',
        'depositRefValue', 'depositRefHint', 'depositRefCopyBtn']) {
        assert.ok(!INDEX.includes(`id="${id}"`), `${id} must not exist`);
    }
});

test('3. the partner contact helpers and their assets are removed', () => {
    for (const name of ['renderDepositPartnerAssistance', 'renderPaymentPartnerContacts',
        'getPaymentPartnerContacts', 'normalisePartnerTelegramUrl', 'getPartnerSupportTelegramUrl',
        'openPartnerSupport', 'PARTNER_ICON_WHATSAPP', 'PARTNER_ICON_TELEGRAM',
        'PARTNER_PRIMARY_WHATSAPP_URL', 'PAYMENT_PARTNER_SLOTS', 'renderDepositPartners',
        'updateDepositReferenceBox', 'copyDepositReference', 'updatePaymentPartnerLinks']) {
        assert.ok(!INDEX.includes(name), `${name} must be gone`);
    }
    assert.ok(!INDEX.includes('wa.me/17828027841'), 'Olivia\'s WhatsApp number must be gone');
    assert.ok(!INDEX.includes('@AlexArbitrix'), 'Alex\'s handle must be gone');
    assert.ok(!INDEX.includes('@OliviaArbitrix'), 'Olivia\'s handle must be gone');
});

test('4. no partner contact configuration is left in the page', () => {
    assert.ok(!INDEX.includes('arbitrix-partner-support-telegram'),
        'the partner-support meta tags must be removed');
    assert.ok(!INDEX.includes('ARBITRIX_PARTNER_SUPPORT_TELEGRAM_URL'));
    // Support is the in-app chat now, so the page configures NO support destination
    // at all - not a partner handle and not the customer support bot.
    const metas = INDEX.match(/^\s*<meta name="[^"]*support[^"]*"[^>]*>/gm) || [];
    assert.deepStrictEqual(metas, [], 'no support meta tag may remain');
});

test('5. neither partner name survives in any customer-facing deposit copy', () => {
    const T = translations();
    for (const lang of LANGS) {
        for (const [key, value] of Object.entries(T[lang])) {
            if (!/^deposit\./.test(key)) continue;
            if (key.startsWith('deposit.partner.')) continue; // admin directory labels (test 11)
            assert.ok(!/\b(olivia|alex)\b/i.test(value), `${lang}/${key} names a partner`);
            assert.ok(!/whatsapp/i.test(value), `${lang}/${key} mentions WhatsApp`);
        }
    }
});

test('6. no locale advertises a verified or payment partner in the deposit copy', () => {
    const T = translations();
    const banned = [
        /verified partner/i, /parceiro verificado/i, /socio verificado/i,
        /partenaire verifi/i, /شريك موث/i, /认证合作伙伴/,
        /payment partner/i, /parceiro de pagamento/i, /socio de pago/i,
        /partenaire de paiement/i, /شريك دفع/i, /支付伙伴/,
    ];
    for (const lang of LANGS) {
        for (const [key, value] of Object.entries(T[lang])) {
            if (!/^deposit\./.test(key)) continue;
            if (key.startsWith('deposit.partner.')) continue; // admin directory labels (test 11)
            for (const re of banned) {
                assert.ok(!re.test(value), `${lang}/${key} advertises a partner: ${value}`);
            }
        }
    }
    assert.strictEqual(T.en['deposit.choose.partner.title'], undefined);
    assert.strictEqual(T.en['deposit.partner.title'], undefined);
});

test('7. official support is untouched and reachable from the deposit journey', () => {
    assert.match(INDEX, /id="supportSidebarLink"/);
    assert.match(INDEX, /function openSupportModal\(/);
    assert.match(INDEX, /id="supportModal"/);
    assert.match(depositMarkup(), /onclick="kxOpenSupport\('deposit'\)"/,
        'the deposit journey offers the in-app chat (with the Support Center as fallback)');
    assert.ok(INDEX.includes("data-i18n=\"deposit.getHelp\""));
    // The referral card's partner-support button opens the in-app chat instead of an
    // individual Telegram account.
    assert.match(INDEX, /id="partnerSupportBtn"[^>]*onclick="kxOpenSupport\('account'\)"/);
    assert.match(INDEX, /data-i18n="referral\.partner\.contactSupport"/);
});

test('8. the automated route is unchanged: one create-invoice call, same provider', () => {
    assert.match(INDEX, /fetch\('\/api\/payment\/create-invoice'/);
    assert.match(INDEX, /function requestDepositAddress\(/);
    assert.match(INDEX, /function startPollingForPayment\(/);
    assert.match(SERVER, /app\.post\('\/api\/webhook\/q8qpay'/);
    assert.match(SERVER, /credit_payment_safe/);
    assert.match(SERVER, /PLATFORM_MIN_DEPOSIT_USD/);
    assert.strictEqual(INDEX.match(/\/api\/payment\/create-invoice/g).length, 1,
        'exactly one invoice-creation call site');
});

test('9. selecting the route creates nothing and the option loader never renders partners', () => {
    const start = INDEX.indexOf('function selectDepositOption(');
    const body = INDEX.slice(start, INDEX.indexOf('\n}', start));
    assert.ok(!/fetch|invoice|XMLHttpRequest/.test(body),
        'selectDepositOption must stay display-only');
    assert.ok(!/depositOptionState\.partners/.test(INDEX), 'no partner state remains');
    assert.match(INDEX, /function loadDepositOptions\(/, 'the crypto config is still loaded');
});

test('10. opening the deposit modal offers the amount field and Generate Payment', () => {
    const markup = depositMarkup();
    assert.match(markup, /id="liveDepositAmount"/);
    assert.match(markup, /id="getAddressBtn"/);
    assert.match(markup, /data-i18n="deposit\.btn\.generatePayment"/);
});

test('11. the admin partner directory is still present but stays admin-only', () => {
    // Dormant data surface: no customer route uses it, administrators keep the
    // ability to review the records created before the route was removed.
    assert.ok(SERVER.includes("'/api/admin/deposit-partners'"));
    const routeStart = SERVER.indexOf("app.get('/api/deposit/options'");
    assert.ok(routeStart > 0, 'the options endpoint still exists');
    assert.match(SERVER, /app\.(get|post|put|delete)\('\/api\/admin\/deposit-partners[^']*',\s*authMiddleware,\s*adminMiddleware/);
    // ... and no customer-facing helper references it.
    assert.ok(!INDEX.includes('/api/admin/deposit-partners') || INDEX.includes('adminPartnerFetch'),
        'admin endpoints are only used by the admin helpers');
    assert.ok(!depositMarkup().includes('deposit-partners'));
});

test('12. the deposit rules the route must not disturb are unchanged', () => {
    assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 50;/);
    assert.match(SERVER, /const MIN_WITHDRAWAL_USD = 700;/);
    assert.match(SERVER, /REFERRAL_REWARD_PERCENT_DEFAULT/);
    assert.ok(!/deposit_partners/.test(SERVER.split('app.get(\'/api/deposit/options\'')[0]),
        'the money paths do not read the partner directory');
});
