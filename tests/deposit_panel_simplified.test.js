'use strict';

/**
 * Simplified deposit panel: two short intro paragraphs, no empty-partner
 * message, "How to Fund Your Account" guidance, three Stay Safe points, and
 * an unchanged Recent Deposits section.
 *
 * The reference box is exercised by running the real updateDepositReferenceBox()
 * and renderDepositPartners() in a vm sandbox.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const panel = () => INDEX.slice(INDEX.indexOf('id="depositPartnerPanel"'),
    INDEX.indexOf('id="depositCryptoFlow"'));

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

// ------------------------------------------------------------ 1. introduction

test('the heading stays "Verified Partners" with two short paragraphs', () => {
    const T = dict();
    assert.strictEqual(T.en['deposit.partner.title'], 'Verified Partners');
    assert.strictEqual(T.en['deposit.partner.intro'],
        'Contact a partner on Telegram. Partners help you obtain cryptocurrency.');
    assert.strictEqual(T.en['deposit.partner.servicesIntro'],
        'Partners may offer direct USDT sales, guided purchasing assistance, or both.');
    const p = panel();
    const titleAt = p.indexOf('data-i18n="deposit.partner.title"');
    const introAt = p.indexOf('data-i18n="deposit.partner.intro"');
    const servicesAt = p.indexOf('data-i18n="deposit.partner.servicesIntro"');
    const btnAt = p.indexOf('id="depositPaymentPartnerBtn"');
    assert.ok(titleAt > 0 && titleAt < introAt && introAt < servicesAt && servicesAt < btnAt,
        'heading -> paragraph -> paragraph -> button');
    // The other introductory explanations are gone.
    assert.ok(!p.includes('deposit.partner.modelNote'), 'long model paragraph retired');
    assert.ok(!p.includes('depositPaymentPartnerNote'), 'note beside the button retired');
    assert.strictEqual((p.match(/data-i18n="deposit\.partner\.(intro|servicesIntro)"/g) || []).length, 2,
        'exactly two intro paragraphs');
});

test('the payment-partner button and its destination are unchanged', () => {
    assert.match(panel(), /data-i18n="deposit\.partner\.contactPaymentPartner">Contact Payment Partner</);
    assert.strictEqual((INDEX.match(/<meta name="arbitrix-partner-support-telegram" content="([^"]*)">/) || [])[1],
        '@Arbitrix_CSA1');
    assert.strictEqual(dict().en['deposit.partner.contactPaymentPartner'], 'Contact Payment Partner');
});

// -------------------------------------------------------- 2. empty partner msg

test('the empty-partner message and its Contact Support button are gone', () => {
    assert.ok(!INDEX.includes('depositPartnerEmpty'), 'wrapper removed');
    assert.ok(!INDEX.includes('deposit.partner.empty'), 'message key removed');
    assert.ok(!INDEX.includes('deposit.partner.supportCta'), 'button key removed');
    assert.ok(!/No verified partners are listed right now/i.test(INDEX), 'message text removed');
    // The renderer no longer depends on a removed node and stays functional.
    const r = fn('renderDepositPartners');
    assert.ok(!r.includes('depositPartnerEmpty'), 'renderer no longer references the empty node');
    assert.match(r, /const listEl = document\.getElementById\('depositPartnerList'\)/);
    assert.match(r, /deposit-partner-card/, 'cards still render');
    assert.match(r, /deposit\.partner\.verified/, 'verified badge still comes from the directory');
    assert.ok(!/openSupportModal/.test(r), 'no support button reintroduced inside the directory');
});

test('renderDepositPartners renders cards and nothing when the directory is empty', () => {
    function run(partners) {
        const listEl = { innerHTML: '' };
        const sandbox = {
            document: { getElementById: (id) => (id === 'depositPartnerList' ? listEl : null) },
            t: (k) => k,
            escapeHtml: (v) => String(v == null ? '' : v),
            console: { log() {}, warn() {}, error() {} },
        };
        vm.createContext(sandbox);
        vm.runInContext(fn('renderDepositPartners') + '\nrenderDepositPartners(' + JSON.stringify(partners) + ');', sandbox);
        return listEl.innerHTML;
    }
    assert.strictEqual(run([]), '', 'nothing is rendered for an empty directory');
    const html = run([{ displayName: 'CSA', telegramUsername: 'Arbitrix_CSA1',
        telegramUrl: 'https://t.me/Arbitrix_CSA1', directSale: true, servesWorldwide: true }]);
    assert.match(html, /deposit-partner-card/);
    assert.match(html, /https:\/\/t\.me\/Arbitrix_CSA1/);
    assert.match(html, /deposit-partner-badge/);
});

// ------------------------------------------------------ 3. funding guidance

test('the reference box is now "How to Fund Your Account" guidance', () => {
    const T = dict();
    assert.strictEqual(T.en['deposit.partner.refTitle'], 'How to Fund Your Account');
    assert.strictEqual(T.en['deposit.partner.refHint'],
        'Open Deposit Funds and generate your USDT (TRC20) deposit address. Share that address with the Payment Partner if you need help funding your account.');
    assert.ok(!('deposit.partner.refNone' in T.en), 'the "Not created yet" placeholder is retired');
    assert.ok(!/Generate a payment in the deposit form/i.test(INDEX), 'old guidance removed');
    // The partner must send to the customer's own generated address.
    assert.match(T.en['deposit.partner.refHint'], /deposit address/);
    assert.match(T.en['deposit.partner.refReady'], /exact \{\{asset\}\} \(\{\{network\}\}\) address/);
});

test('the reference box shows guidance when empty and the reference when set', () => {
    function run(invoiceId) {
        const nodes = {
            depositRefValue: { textContent: '', style: { display: '' } },
            depositRefHint: { textContent: '', style: { display: '' } },
            depositRefCopyBtn: { style: { display: 'none' } },
        };
        const sandbox = {
            currentInvoiceId: invoiceId,
            depositOptionState: { crypto: { asset: 'USDT', network: 'TRC20' } },
            document: { getElementById: (id) => nodes[id] || null },
            t: (k, v) => k + JSON.stringify(v || {}),
            console: { log() {}, warn() {}, error() {} },
        };
        vm.createContext(sandbox);
        vm.runInContext(fn('updateDepositReferenceBox') + '\nupdateDepositReferenceBox();', sandbox);
        return nodes;
    }
    const empty = run(null);
    assert.strictEqual(empty.depositRefValue.textContent, '', 'no placeholder value');
    assert.strictEqual(empty.depositRefValue.style.display, 'none', 'value line hidden when empty');
    assert.match(empty.depositRefHint.textContent, /^deposit\.partner\.refHint/, 'guidance shown');
    assert.strictEqual(empty.depositRefCopyBtn.style.display, 'none');

    const ready = run('inv_123');
    assert.strictEqual(ready.depositRefValue.textContent, 'inv_123');
    assert.strictEqual(ready.depositRefValue.style.display, '', 'value visible with a reference');
    assert.match(ready.depositRefHint.textContent, /^deposit\.partner\.refReady/);
    assert.strictEqual(ready.depositRefCopyBtn.style.display, 'inline-flex', 'copy preserved');
});

// ------------------------------------------------------------- 4. stay safe

test('the Stay Safe block keeps three points and drops the disclaimer', () => {
    const p = panel();
    for (const n of [1, 2, 3]) assert.ok(p.includes('data-i18n="deposit.partner.safety.' + n + '"'));
    for (const n of [4, 5, 6]) assert.ok(!p.includes('data-i18n="deposit.partner.safety.' + n + '"'),
        'safety.' + n + ' removed');
    assert.ok(!p.includes('deposit-partner-disclaimer'), 'disclaimer removed');
    const T = dict();
    for (const key of ['deposit.partner.safety.4', 'deposit.partner.safety.5',
        'deposit.partner.safety.6', 'deposit.partner.disclaimer']) {
        assert.ok(!(key in T.en), key + ' must be retired');
    }
    assert.strictEqual(T.en['deposit.partner.safety.1'], 'Contact the correct Telegram partner and verify the username.');
    assert.strictEqual(T.en['deposit.partner.safety.2'], 'Never share your password, OTP, or private wallet keys.');
    assert.match(T.en['deposit.partner.safety.3'], /Check the USDT network and address before sending funds/);
    assert.match(T.en['deposit.partner.safety.3'], /credited after Arbitrix verifies the transfer/);
    assert.ok((p.match(/<li /g) || []).length === 3, 'exactly three list items');
});

test('security controls are untouched by the copy change', () => {
    // Server-side verification and crediting are not part of this UI change.
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /credit_payment_safe/);
    assert.match(server, /assertSandboxUser|sandboxHandled/);
    assert.match(server, /MIN_WITHDRAWAL_USD = 700/);
    assert.match(server, /PLATFORM_MIN_DEPOSIT_USD = 100/);
    // The UI still offers no way to credit a balance.
    assert.ok(!/credit your balance|add funds to your account/i.test(panel()));
});

// --------------------------------------------------------- 5. recent deposits

test('Recent Deposits keeps its heading, count, list and empty state', () => {
    const start = INDEX.indexOf('data-i18n="deposit.recentDeposits"');
    assert.ok(start > 0);
    const block = INDEX.slice(start - 400, start + 700);
    assert.match(block, /id="depositHistoryCount"/, 'count badge preserved');
    assert.match(block, /id="depositHistoryList"/, 'history list preserved');
    assert.match(block, /data-i18n="deposit\.noDeposits"/, 'empty state preserved');
    assert.strictEqual(dict().en['deposit.recentDeposits'], 'Recent Deposits');
    // No extra explanatory paragraph was added around the section.
    assert.ok(!/recent deposits.{0,400}<p /is.test(block), 'no added prose');
    assert.match(fn('updateUI'), /depositHistoryList/, 'renderer untouched');
});

// ------------------------------------------------------------------- locales

test('all six locales carry the simplified copy and match key sets', () => {
    const T = dict();
    assert.deepStrictEqual(Object.keys(T).sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
    const keys = ['deposit.partner.title', 'deposit.partner.intro', 'deposit.partner.servicesIntro',
        'deposit.partner.refTitle', 'deposit.partner.refHint', 'deposit.partner.safety.1',
        'deposit.partner.safety.2', 'deposit.partner.safety.3'];
    const sizes = Object.keys(T).map((l) => Object.keys(T[l]).length);
    assert.strictEqual(new Set(sizes).size, 1, 'identical key counts');
    for (const locale of Object.keys(T)) {
        for (const key of keys) {
            assert.ok(String(T[locale][key] || '').trim(), locale + ' missing ' + key);
            if (locale !== 'en') assert.notStrictEqual(T[locale][key], T.en[key], locale + ' ' + key + ' untranslated');
        }
    }
});
