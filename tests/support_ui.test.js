'use strict';

/**
 * OFFICIAL CUSTOMER SUPPORT — tests.
 *
 * Pins the support experience:
 *   - a visible Support entry in the sidebar, account/settings, the deposit UI,
 *     the payment pending/failed states, the withdrawal area, and the existing
 *     support widget;
 *   - the official Telegram link is CONFIGURABLE (window override / meta tag)
 *     and no personal/staff account is hardcoded;
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
    'support.telegramShort', 'support.modal.title', 'support.modal.subtitle',
    'support.officialTelegram', 'support.notConfigured', 'support.security.title',
    'support.security.password', 'support.security.otp', 'support.security.privateKey',
    'support.security.seedPhrase', 'support.security.recoveryPhrase',
    'support.security.cardDetails', 'support.security.recoveryCodes',
    'support.paymentHelp.title', 'support.paymentHelp.body', 'support.safeInfo.invoice',
    'support.safeInfo.amount', 'support.safeInfo.network', 'support.safeInfo.txHash',
    'support.safeInfo.screenshot', 'support.faq.title', 'support.faq.depositPending.q',
    'support.faq.depositPending.a', 'support.faq.depositFailed.q',
    'support.faq.depositFailed.a', 'support.faq.withdrawal.q', 'support.faq.withdrawal.a',
    'support.faq.security.q', 'support.faq.security.a', 'support.needHelpDeposit',
    'support.needHelpWithdraw', 'support.contactOfficial', 'support.contactShort',
    'support.openCenter', 'support.verificationNotRequired', 'support.paymentHelp.pending',
    'support.paymentHelp.detected', 'support.paymentHelp.failed',
];

test('support entry is rendered in the main navigation', () => {
    const link = INDEX.match(/<a class="sidebar-link" id="supportSidebarLink"[^>]*>[\s\S]*?<\/a>/);
    assert.ok(link, 'sidebar support link should exist');
    assert.ok(/openSupportModal\(\)/.test(link[0]), 'sidebar support link should open the support modal');
    assert.ok(/data-i18n="sidebar\.support"/.test(link[0]), 'sidebar support link should be localized');
});

test('support modal contains the Telegram button, security warning, payment guidance and FAQ', () => {
    const win = supportModalBlock();
    assert.ok(/id="supportTelegramBtn"/.test(win), 'official Telegram button');
    assert.ok(/js-official-telegram/.test(win), 'configurable Telegram class');
    assert.ok(/support\.security\.title/.test(win), 'security warning title');
    assert.ok(/support\.security\.password/.test(win), 'security warning password item');
    assert.ok(/support\.paymentHelp\.title/.test(win), 'payment help section');
    assert.ok(/support\.safeInfo\.invoice/.test(win), 'safe-info invoice item');
    assert.ok(/support\.faq\.depositPending\.q/.test(win), 'FAQ deposit item');
    assert.ok(/id="supportNotConfigured"/.test(win), 'unconfigured notice');
});

const OFFICIAL_TELEGRAM_URL = 'https://t.me/ArbitrixSupportBot';

test('official Telegram URL is configured once via the meta tag (single source of truth)', () => {
    const fn = extractFunction('getOfficialSupportTelegramUrl');
    assert.ok(/ARBITRIX_SUPPORT_TELEGRAM_URL/.test(fn), 'window override supported');
    assert.ok(/arbitrix-support-telegram/.test(fn), 'meta tag config supported');

    // The official URL is HTTPS on the official t.me domain.
    assert.ok(/^https:\/\/t\.me\//.test(OFFICIAL_TELEGRAM_URL), 'HTTPS + official t.me domain');

    // It is defined EXACTLY ONCE in the document, in the meta configuration.
    const occurrences = INDEX.match(/https?:\/\/t\.me\/[A-Za-z0-9_]+/g) || [];
    assert.deepStrictEqual(occurrences, [OFFICIAL_TELEGRAM_URL],
        'the official URL must appear exactly once (the meta config, not in anchors)');
    const meta = INDEX.match(/<meta name="arbitrix-support-telegram" content="([^"]*)">/);
    assert.ok(meta, 'meta config element must exist');
    assert.strictEqual(meta[1], OFFICIAL_TELEGRAM_URL, 'meta config must hold the official URL');

    // No anchor/button hardcodes a destination; all share one class + safe attrs.
    const anchors = [...INDEX.matchAll(/<a[^>]*js-official-telegram[^>]*>/g)].map((m) => m[0]);
    assert.ok(anchors.length >= 3, 'all official Telegram anchors present');
    for (const a of anchors) {
        assert.ok(/href="#"/.test(a), 'anchors must not hardcode a destination');
        assert.ok(/target="_blank"/.test(a) && /rel="noopener noreferrer"/.test(a), 'safe new-tab attributes');
    }
    assert.ok(/querySelectorAll\('\.js-official-telegram'\)/.test(extractFunction('updateSupportLinks')),
        'resolution is centralized through the shared class');
});

test('every official Telegram entry point resolves to the same configured URL', () => {
    const official = (INDEX.match(/<meta name="arbitrix-support-telegram" content="([^"]*)">/) || [])[1];
    assert.strictEqual(official, OFFICIAL_TELEGRAM_URL);

    const anchors = [{ attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; } },
        { attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; } },
        { attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; } }];
    const els = {};
    const sandbox = {
        console,
        window: {},
        document: {
            querySelectorAll: () => anchors,
            querySelector: (sel) => (String(sel).includes('arbitrix-support-telegram') ? { content: official } : null),
            getElementById: (id) => (els[id] = els[id] || { style: {}, textContent: '' }),
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction('getOfficialSupportTelegramUrl') + '\n' +
        extractFunction('updateSupportLinks') + '\n updateSupportLinks();', sandbox);

    for (const a of anchors) {
        assert.strictEqual(a.attrs.href, OFFICIAL_TELEGRAM_URL, 'every anchor resolves to the official URL');
        assert.strictEqual(a.style.display, '', 'every anchor is visible');
    }
    assert.strictEqual(els.supportNotConfigured.style.display, 'none',
        'the "not configured" fallback disappears when the URL is present');
});

test('updateSupportLinks applies the configured URL and degrades safely when unset', () => {
    function run(url) {
        const anchors = [{ style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }];
        const els = {};
        function makeEl() { return { style: {}, textContent: '', innerHTML: '', classList: { add() {}, remove() {} } }; }
        const sandbox = {
            console,
            window: { ARBITRIX_SUPPORT_TELEGRAM_URL: url },
            document: {
                querySelectorAll: () => anchors,
                getElementById: (id) => (els[id] = els[id] || makeEl()),
                querySelector: () => null,
            },
        };
        vm.createContext(sandbox);
        vm.runInContext(extractFunction('getOfficialSupportTelegramUrl') + '\n' +
            extractFunction('updateSupportLinks') + '\n updateSupportLinks();', sandbox);
        return { anchors, els };
    }

    const configured = run(OFFICIAL_TELEGRAM_URL);
    assert.strictEqual(configured.anchors[0].attrs.href, OFFICIAL_TELEGRAM_URL);
    assert.strictEqual(configured.anchors[0].style.display, '');
    assert.strictEqual(configured.els.supportNotConfigured.style.display, 'none');

    const unset = run('');
    assert.strictEqual(unset.anchors[0].attrs.href, '#');
    assert.strictEqual(unset.anchors[0].style.display, 'none');
    assert.strictEqual(unset.els.supportNotConfigured.style.display, 'block');
});

test('support is available from the deposit modal (instructions area)', () => {
    const win = elementWindow('safetyWarning', 1800);
    assert.ok(/openSupportModal\(\)/.test(win), 'deposit instructions should link to support');
    assert.ok(/support\.needHelpDeposit/.test(win), 'localized deposit-help wording');
});

test('support is available from the payment pending/failed state with invoice reference', () => {
    // Window must fit the whole 'support.contactOfficial' occurrence, so it needs
    // to reach at least its offset + its length (currently 1594 + 23 = 1617).
    // It stays inside the block, which ends at the next top-level comment (~1965).
    // The window grew only because Stage 1 swapped inline hex colours in this
    // block for token references (e.g. #8896B5 -> var(--text-secondary) and the
    // brand/red alpha values for var(--brand-*) / var(--on-brand)); the markup
    // and every assertion are unchanged.
    const win = elementWindow('paymentSupportHelp', 1900);
    assert.ok(/openSupportModal\(\)/.test(win), 'payment help should link to support');
    assert.ok(/id="depositInvoiceRef"/.test(win), 'invoice reference is displayed');
    assert.ok(/copyInvoiceRef\(\)/.test(win), 'copy-invoice-reference action exists');
    assert.ok(/support\.contactOfficial/.test(win), 'official support CTA');

    // The status-driven guidance maps the observed status to the right key.
    const fn = extractFunction('updatePaymentSupportHelp');
    assert.ok(/support\.paymentHelp\.pending/.test(fn));
    assert.ok(/support\.paymentHelp\.detected/.test(fn) && /'confirming'/.test(fn));
    assert.ok(/support\.paymentHelp\.failed/.test(fn) && /'expired'/.test(fn) && /'cancelled'/.test(fn));

    // startPollingForPayment still routes pending/detected/expired through the
    // guidance + keeps the existing confirmation path intact.
    const poll = extractFunction('startPollingForPayment');
    assert.ok(/support\.paymentHelp|updatePaymentSupportHelp/.test(poll), 'polling updates the guidance');
    assert.ok(/\/api\/auth\/me/.test(poll), 'confirmation still re-syncs the authoritative balance');
    assert.ok(/showSuccessSection\(/.test(poll), 'confirmation still shows the success section');
});

test('support is available from the account/settings area', () => {
    const profile = elementWindow('profileModal', 9000);
    assert.ok(/openSupportModal\(\)/.test(profile), 'profile modal should link to support');
    assert.ok(/profile\.contactSupport/.test(profile), 'localized contact-support label');
});

test('support is available from the withdrawal area', () => {
    const withdraw = elementWindow('withdrawModal', 12000);
    assert.ok(/support\.needHelpWithdraw/.test(withdraw), 'withdrawal help wording');
    assert.ok(/>\s*openSupportModal\(\)|\bonclick="openSupportModal\(\)"/.test(withdraw), 'withdrawal support link');
});

test('support is available from the existing support widget', () => {
    const widget = elementWindow('supportPanel', 2500);
    assert.ok(/openSupportModal\(\)/.test(widget), 'support widget links to the support center');
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
    const fns = ['openSupportModal', 'closeSupportModal', 'updateSupportLinks',
        'getOfficialSupportTelegramUrl', 'updatePaymentSupportHelp', 'copyInvoiceRef'];
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
    assert.strictEqual(run('pending'), 'T:support.paymentHelp.pending');
    assert.strictEqual(run('detected'), 'T:support.paymentHelp.detected');
    assert.strictEqual(run('confirming'), 'T:support.paymentHelp.detected');
    assert.strictEqual(run('expired'), 'T:support.paymentHelp.failed');
    assert.strictEqual(run('cancelled'), 'T:support.paymentHelp.failed');
    assert.strictEqual(run(null), 'T:support.paymentHelp.pending');
});

test('invoice reference is display-only: no confirmation or crediting in the payment UI', () => {
    const depositWin = elementWindow('depositPaymentSection', 12000);
    assert.ok(/id="depositInvoiceRef"/.test(depositWin), 'invoice ref shown inside the payment section');
    const copy = extractFunction('copyInvoiceRef');
    assert.ok(/navigator\.clipboard\.writeText/.test(copy), 'uses the existing safe clipboard pattern');
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
