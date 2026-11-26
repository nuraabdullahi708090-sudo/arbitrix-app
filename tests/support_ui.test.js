'use strict';

/**
 * OFFICIAL CUSTOMER SUPPORT — tests.
 *
 * Pins the support experience:
 *   - a visible Support entry in the sidebar, account/settings, the deposit UI,
 *     the payment pending/failed states, the withdrawal area, and the existing
 *     support widget;
 *   - EVERY one of those controls opens the in-app messenger through the single
 *     kxOpenSupport() helper, with the Support Center as the fallback when the
 *     messenger cannot open. There is NO customer-facing Telegram destination:
 *     Telegram is the internal agent channel (announcement tutorials keep their
 *     own links, which are content, not support);
 *   - a security warning covering password / OTP / private key / seed phrase /
 *     recovery phrase / card details / recovery codes;
 *   - safe payment-problem guidance (invoice reference, amount, network, tx
 *     hash, screenshot) + an invoice reference display and copy action;
 *   - no secret-collecting input and no private user data on support surfaces;
 *   - the support code never confirms payments, credits balances, or calls the
 *     payment-provider APIs (display-only).
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const LOCALES = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function loadTranslations() {
    const blocks = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const blk = blocks.find((b) => b.includes('const TRANSLATIONS'));
    assert.ok(blk, 'TRANSLATIONS block should exist');
    const start = blk.indexOf('const TRANSLATIONS');
    let i = blk.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < blk.length; i++) {
        if (blk[i] === '{') depth++;
        else if (blk[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, 'TRANSLATIONS object should be brace-matchable');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext('this.T = ' + blk.slice(blk.indexOf('{', start), end + 1), sandbox);
    return sandbox.T;
}

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
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

// Slice a single element block by id (from its opening tag to the first matching
// close of that tag is hard; a bounded character window is enough for "does this
// UI region contain X" assertions).
function elementWindow(id, size = 9000) {
    const at = INDEX.indexOf('id="' + id + '"');
    assert.ok(at >= 0, `#${id} should exist`);
    return INDEX.slice(at, at + size);
}

const T = loadTranslations();

// Exact support-modal block: bounded by the next top-level comment so that
// "absence" assertions cannot accidentally read into unrelated markup.
function supportModalBlock() {
    const at = INDEX.indexOf('id="supportModal"');
    assert.ok(at >= 0, '#supportModal should exist');
    const endMarker = INDEX.indexOf('<!-- Image Viewer Modal -->', at);
    return INDEX.slice(at, endMarker > 0 ? endMarker : at + 9000);
}

const SUPPORT_KEYS = [
    'support.modal.title', 'support.modal.subtitle',
    'support.startChat', 'support.chatHint', 'support.security.title',
    'support.security.password', 'support.security.otp', 'support.security.privateKey',
    'support.security.seedPhrase', 'support.security.recoveryPhrase',
    'support.security.cardDetails', 'support.security.recoveryCodes',
    'support.paymentHelp.title', 'support.paymentHelp.body', 'support.safeInfo.invoice',
    'support.safeInfo.amount', 'support.safeInfo.network', 'support.safeInfo.txHash',
    'support.safeInfo.screenshot', 'support.faq.title', 'support.faq.depositPending.q',
    'support.faq.depositPending.a', 'support.faq.depositFailed.q',
    'support.faq.depositFailed.a', 'support.faq.withdrawal.q', 'support.faq.withdrawal.a',
    'support.faq.security.q', 'support.faq.security.a',
    'support.needHelpWithdraw', 'support.contactShort',
    'support.openCenter', 'support.verificationNotRequired',
    'support.paymentHelp.detected', 'support.paymentHelp.failed',
];

test('support entry is rendered in the main navigation', () => {
    const link = INDEX.match(/<a class="sidebar-link" id="supportSidebarLink"[^>]*>[\s\S]*?<\/a>/);
    assert.ok(link, 'sidebar support link should exist');
    assert.ok(/kxOpenSupport\(/.test(link[0]), 'sidebar support link opens the in-app messenger helper');
    assert.ok(/data-i18n="sidebar\.support"/.test(link[0]), 'sidebar support link should be localized');
});

test('support modal offers the in-app chat, security warning, payment guidance and FAQ', () => {
    const win = supportModalBlock();
    assert.ok(/id="supportChatCta"/.test(win), 'the primary action is the in-app chat');
    assert.ok(/onclick="kxOpenSupport\(APP\.supportContext\)"/.test(win), 'and it goes through the one helper');
    assert.ok(/support\.startChat/.test(win), 'localized chat label');
    assert.ok(/support\.chatHint/.test(win), 'the hint explains that the reply arrives in-app');
    // No customer-facing Telegram destination anywhere in the modal.
    assert.ok(!/t\.me\//.test(win), 'no Telegram destination in the support modal');
    assert.ok(!/supportTelegramBtn|js-official-telegram/.test(win), 'the Telegram button is retired');
    assert.ok(/support\.security\.title/.test(win), 'security warning title');
    assert.ok(/support\.security\.password/.test(win), 'security warning password item');
    assert.ok(/support\.paymentHelp\.title/.test(win), 'payment help section');
    assert.ok(/support\.safeInfo\.invoice/.test(win), 'safe-info invoice item');
    assert.ok(/support\.faq\.depositPending\.q/.test(win), 'FAQ deposit item');
});

const SUPPORT_CHAT_TARGETS = ['deposit', 'withdrawal', 'trading', 'account'];

test('there is no customer-facing Telegram support destination', () => {
    // Telegram is the INTERNAL agent channel: notifications go to the admins and
    // replies come back through the same conversation. The website must never
    // send a customer there, so the configurable support-bot link, its meta tag
    // and the shared resolver are all retired.
    assert.ok(!/arbitrix-support-telegram/.test(INDEX), 'the support-bot meta config is retired');
    assert.ok(!/ArbitrixSupportBot/.test(INDEX), 'the support bot handle is not published to customers');
    assert.ok(!/js-official-telegram/.test(INDEX), 'no configurable Telegram support anchors remain');
    assert.ok(!/getOfficialSupportTelegramUrl|updateSupportLinks/.test(INDEX),
        'the Telegram link resolver is retired');
    assert.ok(!/support\.(telegramShort|officialTelegram|notConfigured|human\.title)/.test(INDEX),
        'its translations are retired too');

    // The only t.me links left in the app are the withdrawal TUTORIAL (announcement
    // channel content) - a different purpose, deliberately preserved.
    const links = (INDEX.match(/https?:\/\/t\.me\/[A-Za-z0-9_\/]+/g) || []);
    assert.deepStrictEqual(links, ['https://t.me/ArbitrixAnnouncements/19'],
        'only the withdrawal tutorial link remains, and it is not a support destination');
});

test('every support control routes through the single kxOpenSupport helper', () => {
    assert.strictEqual((INDEX.match(/function kxOpenSupport\(/g) || []).length, 1,
        'the helper is defined exactly once');
    const calls = [...INDEX.matchAll(/kxOpenSupport\(([^)]*)\)/g)].map((m) => m[1].trim());
    const withContext = calls.filter((c) => SUPPORT_CHAT_TARGETS.includes(c.replace(/'/g, '')));
    assert.ok(withContext.length >= 6, 'the app entry points pass their area as context');
    for (const ctx of ['deposit', 'withdrawal', 'account']) {
        assert.ok(calls.some((c) => c === "'" + ctx + "'"), 'the ' + ctx + ' area passes its context');
    }
    // No control may still call the modal directly: the modal IS the fallback.
    const direct = [...INDEX.matchAll(/onclick="openSupportModal\(\)"/g)];
    assert.deepStrictEqual(direct, [], 'no control bypasses the helper');
});

test('kxOpenSupport prefers the messenger and keeps the Support Center as the fallback', () => {
    function run(opts) {
        const calls = { opened: [], modal: 0, native: [] };
        const sandbox = {
            console,
            APP: opts.app || { nativeSupport: true },
            NativeSupport: opts.native === false ? undefined : {
                open: (o) => { calls.native.push(o); return opts.openResult === undefined ? true : opts.openResult; },
            },
            openSupportModal: () => { calls.modal++; },
            closeSupportModal: () => {},
            kxSupportContext: (v) => (SUPPORT_CHAT_TARGETS.includes(String(v)) ? String(v) : null),
        };
        vm.createContext(sandbox);
        vm.runInContext(
            'var KX_SUPPORT_CONTEXTS = { deposit: 1, withdrawal: 1, trading: 1, account: 1 };\n' +
            extractFunction('kxSupportContext') + '\n' +
            extractFunction('kxNativeSupportReady') + '\n' +
            extractFunction('kxOpenSupport') + '\n' +
            'this.result = kxOpenSupport(' + JSON.stringify(opts.context || null) + ');', sandbox);
        return { result: sandbox.result, calls, app: sandbox.APP };
    }

    const native = run({ context: 'deposit' });
    assert.strictEqual(native.result, true, 'the messenger opened');
    // Cross-realm objects from the vm sandbox have a different prototype, so
    // compare their serialised shape rather than identity.
    assert.strictEqual(JSON.stringify(native.calls.native), JSON.stringify([{ context: 'deposit' }]),
        'the context reaches the panel');
    assert.strictEqual(native.calls.modal, 0, 'the modal is not opened when the messenger works');
    assert.strictEqual(native.app.supportContext, 'deposit', 'the context is remembered for the fallback');

    const fallback = run({ context: 'withdrawal', app: { nativeSupport: false } });
    assert.strictEqual(fallback.result, false, 'the fallback ran');
    assert.strictEqual(fallback.calls.modal, 1, 'the existing Support Center opens instead');
    assert.strictEqual(fallback.calls.native.length, 0, 'the messenger is not called when unavailable');

    const unknown = run({ context: 'not-a-context' });
    assert.strictEqual(JSON.stringify(unknown.calls.native), JSON.stringify([{ context: null }]),
        'an unknown context is dropped, never passed through');
});

test('the deposit modal carries no individual payment-partner contact', () => {
    // The verified-partner funding route was removed: the deposit journey is the
    // automated USDT (TRC20) flow, and official support is reached from the
    // Support Center. Pin the absence so no partner contact can creep back.
    for (const id of ['depositCryptoPartnerContacts', 'depositCryptoPartnerHelp',
        'depositPartnerContacts', 'depositPartnerPanel', 'depositOptionPartner']) {
        assert.ok(!INDEX.includes(`id="${id}"`), `${id} must not exist`);
    }
    assert.ok(!/wa\.me\/17828027841/.test(INDEX), 'no WhatsApp partner destination');
    assert.ok(!/deposit\.partner\.(oliviaBtn|alexBtn|alexNote)/.test(INDEX), 'no partner contact copy');
    assert.ok(!/support\.needHelpDeposit/.test(INDEX), 'the old support link is retired');
    assert.ok(/onclick="kxOpenSupport\('deposit'\)"/.test(INDEX), 'support is still reachable from the deposit flow');
});

test('support is available from the payment pending/failed state with invoice reference', () => {
    // Window must fit the whole 'support.contactOfficial' occurrence, so it needs
    // to reach at least its offset + its length (the card grew again in the
    // promotional-credit phase, so widen the window rather than guess a size).
    // It stays inside the block, which ends at the next top-level comment (~1965).
    // The window grew only because Stage 1 swapped inline hex colours in this
    // block for token references (e.g. #8896B5 -> var(--text-secondary) and the
    // brand/red alpha values for var(--brand-*) / var(--on-brand)); the markup
    // and every assertion are unchanged.
    // The window grew because the card now offers TWO contacts: the payment
    // partner (deposit questions) and the official support action (everything
    // else). Both live inside this block.
    const win = elementWindow('paymentSupportHelp', 2800);
    assert.ok(/kxOpenSupport\('deposit'\)/.test(win), 'payment help opens the chat with deposit context');
    assert.ok(/id="depositInvoiceRef"/.test(win), 'invoice reference is displayed');
    assert.ok(/copyInvoiceRef\(\)/.test(win), 'copy-invoice-reference action exists');
    assert.ok(/support\.contactShort/.test(win), 'one compact Contact Support action');
    assert.ok(!/support\.contactOfficial/.test(win), 'the oversized primary label is retired');
    // The generated payment session offers NO individual payment partners:
    // official support is the only assistance surface there.
    assert.ok(!/id="paymentPartnerContacts"/.test(win), 'no payment-partner contacts in the payment session');
    // ONE support destination: the Support Center. No duplicate Telegram button
    // competing with it (Telegram stays reachable inside the Support Center).
    assert.ok(!/js-official-telegram/.test(win), 'no duplicate Telegram button in the payment session');
    assert.ok((win.match(/id="paymentSupportFallbackBtn"/g) || []).length === 1, 'exactly one support button');
    assert.ok(/deposit\.support\.title/.test(win), 'compact support heading present');
    assert.ok(/deposit\.support\.body/.test(win), 'compact support instructions present');

    // The status-driven guidance keeps only the exceptions that need a hint:
    // an awaiting payment deliberately renders nothing, so the generic
    // "need help" paragraph never repeats the static instructions above.
    const fn = extractFunction('updatePaymentSupportHelp');
    assert.ok(!/support\.paymentHelp\.pending/.test(fn), 'awaiting payment renders no extra paragraph');
    assert.ok(/support\.paymentHelp\.detected/.test(fn) && /'confirming'/.test(fn));
    assert.ok(/support\.paymentHelp\.failed/.test(fn) && /'expired'/.test(fn) && /'cancelled'/.test(fn));
    assert.ok(/el\.hidden = !key/.test(fn), 'the hint is hidden when there is nothing to say');

    // startPollingForPayment still routes pending/detected/expired through the
    // guidance + keeps the existing confirmation path intact.
    const poll = extractFunction('startPollingForPayment');
    assert.ok(/support\.paymentHelp|updatePaymentSupportHelp/.test(poll), 'polling updates the guidance');
    assert.ok(/\/api\/auth\/me/.test(poll), 'confirmation still re-syncs the authoritative balance');
    assert.ok(/showSuccessSection\(/.test(poll), 'confirmation still shows the success section');
});

test('support is available from the account/settings area', () => {
    // 14000: the profile modal gained the Telegram-linking card (Phase 1) between
    // the subscription summary and the account-help block.
    const profile = elementWindow('profileModal', 14000);
    assert.ok(/kxOpenSupport\('account'\)/.test(profile), 'profile modal opens the chat with account context');
    assert.ok(/profile\.contactSupport/.test(profile), 'localized contact-support label');
});

test('support is available from the withdrawal area', () => {
    const withdraw = elementWindow('withdrawModal', 12000);
    assert.ok(/support\.needHelpWithdraw/.test(withdraw), 'withdrawal help wording');
    assert.ok(/onclick="kxOpenSupport\('withdrawal'\)"/.test(withdraw), 'withdrawal support link opens the chat');
});

test('support is available from the existing support widget', () => {
    const widget = elementWindow('supportPanel', 2500);
    assert.ok(/kxOpenSupport\(\)/.test(widget), 'the legacy assistant opens the messenger (or the Support Center)');
    assert.ok(/support\.openCenter/.test(widget), 'localized support-center label');
});

test('security warning covers every protected secret in all six locales', () => {
    const needed = ['support.security.password', 'support.security.otp', 'support.security.privateKey',
        'support.security.seedPhrase', 'support.security.recoveryPhrase',
        'support.security.cardDetails', 'support.security.recoveryCodes'];
    for (const loc of LOCALES) {
        for (const k of needed) {
            assert.ok(T[loc] && typeof T[loc][k] === 'string' && T[loc][k].trim(),
                `${loc}: ${k} should be present and non-empty`);
        }
    }
});

test('safe payment information is limited to non-secret fields', () => {
    const win = supportModalBlock();
    for (const k of ['support.safeInfo.invoice', 'support.safeInfo.amount', 'support.safeInfo.network',
        'support.safeInfo.txHash', 'support.safeInfo.screenshot']) {
        assert.ok(win.includes(k), `support modal should list ${k}`);
    }
});

test('no password/OTP/private-key/seed input is introduced', () => {
    const win = supportModalBlock();
    assert.ok(!/<input/i.test(win), 'support modal must not collect any input');
    assert.ok(!/type="password"/i.test(win), 'no password field');
    assert.ok(!/<textarea/i.test(win), 'no free-text secret field');
});

test('support surfaces expose no private user data and make no requests', () => {
    const fns = ['openSupportModal', 'closeSupportModal', 'kxOpenSupport', 'kxSupportContext',
        'kxNativeSupportReady', 'updatePaymentSupportHelp', 'copyInvoiceRef'];
    for (const name of fns) {
        const src = extractFunction(name);
        assert.ok(!/\bfetch\s*\(/.test(src), `${name} must not call fetch`);
        assert.ok(!/jwt_token|localStorage\.getItem/.test(src), `${name} must not read credentials/tokens`);
        assert.ok(!/balance/i.test(src), `${name} must not touch balances`);
        assert.ok(!/PaymentService|payment\/|invoice\//.test(src), `${name} must not call payment APIs`);
    }
    // The support modal does not render user-identifying data.
    const win = supportModalBlock();
    assert.ok(!/\$\{.*email|user\.email|localStorage/.test(win), 'no private user data in the support modal');
});

test('updatePaymentSupportHelp maps the observed status to the right guidance key', () => {
    function run(status) {
        const el = { textContent: '' };
        const sandbox = {
            console,
            lastPaymentStatus: status,
            t: (k) => 'T:' + k,
            document: { getElementById: (id) => (id === 'paymentSupportHelpText' ? el : null) },
        };
        vm.createContext(sandbox);
        vm.runInContext('let lastPaymentStatus = ' + JSON.stringify(status) + ';\n' +
            extractFunction('updatePaymentSupportHelp') + '\n updatePaymentSupportHelp();', sandbox);
        return el.textContent;
    }
    // While the invoice is simply awaiting payment there is nothing to add: the
    // static instructions above the button already cover it, so the line stays
    // empty (and hidden) instead of repeating a paragraph.
    assert.strictEqual(run('pending'), '');
    assert.strictEqual(run(null), '');
    // A detected or an expired/cancelled payment still gets its specific hint.
    assert.strictEqual(run('detected'), 'T:support.paymentHelp.detected');
    assert.strictEqual(run('confirming'), 'T:support.paymentHelp.detected');
    assert.strictEqual(run('expired'), 'T:support.paymentHelp.failed');
    assert.strictEqual(run('cancelled'), 'T:support.paymentHelp.failed');
});

test('invoice reference is display-only: no confirmation or crediting in the payment UI', () => {
    const depositWin = elementWindow('depositPaymentSection', 12000);
    assert.ok(/id="depositInvoiceRef"/.test(depositWin), 'invoice ref shown inside the payment section');
    const copy = extractFunction('copyInvoiceRef');
    // The copy now goes through the shared helper, which is the single place that
    // touches the clipboard API (and awaits it).
    assert.ok(/copyTextToClipboard\(/.test(copy), 'uses the shared clipboard helper');
    const helper = extractFunction('copyTextToClipboard');
    assert.ok(/navigator\.clipboard\.writeText/.test(helper), 'the helper still uses the standard clipboard API');
    assert.ok(/execCommand/.test(extractFunction('legacyCopyText')), 'and keeps the legacy fallback');
    assert.ok(/t\(ok \? .* : .*\)/.test(copy) || /ok \?/.test(copy), 'feedback reflects the real copy result');
    assert.ok(!/fetch\s*\(/.test(copy), 'copy performs no network call');
    const show = extractFunction('showPaymentSection');
    assert.ok(/invoice\.id \|\| currentInvoiceId/.test(show), 'reference derives from the current invoice id');
});

test('i18n: support keys exist, are non-empty, and have identical sets in all 6 locales', () => {
    const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
    const enKeys = Object.keys(T.en);
    for (const loc of LOCALES) {
        assert.ok(T[loc], `locale ${loc} should exist`);
        assert.deepStrictEqual(new Set(Object.keys(T[loc])), new Set(enKeys), `${loc} key set differs`);
        for (const k of SUPPORT_KEYS) {
            assert.ok(nonEmpty(T[loc][k]), `${loc}: ${k} should be non-empty`);
        }
    }
});
