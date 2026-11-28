/**
 * Deposit Funds dialog - section order (tutorials moved to the bottom).
 *
 * Requirement: a visitor who already holds crypto must reach the form fast.
 * The "Don't have cryptocurrency yet? / Watch Deposit Tutorials" card used to
 * sit between the funding options and the crypto form, pushing Generate Payment
 * further down. It now lives at the very bottom of the dialog, after Recent
 * Deposits, so the reading order is:
 *
 *   1 heading        2 funding options        3 supported asset/network
 *   4 method guidance 5 amount + presets      6 Generate Payment
 *   7 network warning 8 Recent Deposits       9 tutorials card
 *
 * UI-only: no deposit generation, payment, validation, history, wallet, API or
 * schema change is asserted here beyond "still present and unchanged".
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function depositDialogMarkup() {
    const start = INDEX.indexOf('<div class="deposit-modal" id="depositModal">');
    assert.ok(start > -1, 'deposit dialog markup exists');
    const end = INDEX.indexOf('<div class="deposit-modal" id="onboardingModal">', start);
    assert.ok(end > start, 'the next dialog marks the end of this one');
    return INDEX.slice(start, end);
}

const DIALOG = depositDialogMarkup();
const at = (needle, from = 0) => {
    const i = DIALOG.indexOf(needle, from);
    assert.ok(i > -1, 'expected marker in the dialog: ' + needle);
    return i;
};

/* ------------------------------------------------------------------ *
 * 1. The required reading order
 * ------------------------------------------------------------------ */
test('1. the dialog follows the approved section order', () => {
    const order = [
        ['heading', '<div class="deposit-modal-head">'],
        ['funding options (Already Have Crypto)', '<div id="depositOptions"'],
        ['currently supported asset/network', '<div id="supportedCoinsInfo"'],
        ['payment method guidance', '<details class="deposit-usdt-help" id="depositUsdtHelp">'],
        ['amount input', '<input type="number" id="liveDepositAmount"'],
        ['preset amounts', 'onclick="setDepositAmount(250)"'],
        ['Generate Payment', 'id="getAddressBtn"'],
        ['network warning', '<div id="safetyWarning"'],
        ['Recent Deposits', '<div class="deposit-history"'],
        ['tutorials card', '<div id="depositTutorialsCard"']
    ];
    let previous = -1;
    order.forEach(([label, marker]) => {
        const position = at(marker);
        assert.ok(position > previous, label + ' must come after the previous section');
        previous = position;
    });
});

test('2. Generate Payment now precedes the tutorials card by a wide margin', () => {
    const generate = at('id="getAddressBtn"');
    const card = at('id="depositTutorialsCard"');
    assert.ok(card > generate, 'the card cannot sit above Generate Payment');
    // The card used to sit between the funding options and the crypto flow;
    // it must no longer appear anywhere before the form action.
    assert.strictEqual(DIALOG.indexOf('id="depositTutorialsCard"'), card);
    assert.ok(card - generate > 2000,
        'the whole form (amount, presets, warning) separates Generate Payment from the card');
});

test('3. the tutorials card is the last content block of the panel', () => {
    const card = at('<div id="depositTutorialsCard"');
    const hidden = at('<!-- Hidden inputs -->');
    assert.ok(card < hidden, 'the card precedes the hidden inputs');
    // Nothing but whitespace/comments may follow the card before the hidden inputs.
    const cardOpen = DIALOG.indexOf('<div id="depositTutorialsCard"');
    const between = DIALOG.slice(DIALOG.indexOf('</div>', DIALOG.indexOf('data-i18n="deposit.tutorials.note"')), hidden);
    const afterCard = between.slice(between.lastIndexOf('</div>'));
    assert.ok(cardOpen > 0);
    assert.strictEqual(afterCard.replace(/<\/div>/g, '').trim(), '');
});

test('4. the card left step 1 and now belongs to the panel itself', () => {
    const panel = at('<div class="deposit-modal-content" id="depositModalContent">');
    const card = at('id="depositTutorialsCard"');
    const inputSection = at('<div id="depositInputSection">');
    const inputSectionClose = DIALOG.indexOf('<div id="depositPaymentSection"');
    assert.ok(panel < inputSection && inputSection < inputSectionClose, 'step 1 is intact');
    assert.ok(card > inputSectionClose, 'the card is no longer inside step 1');
    assert.ok(card < at('<!-- Hidden inputs -->'), 'the card is inside the panel');
});

/* ------------------------------------------------------------------ *
 * 2. Nothing was lost from the card
 * ------------------------------------------------------------------ */
test('5. the funding-help content survives, the tutorial CTA does not', () => {
    const card = at('<div id="depositTutorialsCard"');
    const block = DIALOG.slice(card, at('<!-- Hidden inputs -->', card));
    assert.match(block, /data-i18n="deposit\.tutorials\.title"/);
    assert.match(block, /data-i18n="deposit\.tutorials\.body"/);
    assert.match(block, /data-i18n="deposit\.tutorials\.note"/);
    // Temporary removal: the CTA and its broken link are gone, and nothing
    // replaced them with another destination.
    assert.ok(!block.includes('deposit.tutorials.cta'));
    assert.ok(!block.includes('href="/deposit-tutorials"'));
    assert.ok(!/target="_blank"|Watch Deposit Tutorials/.test(block));
    // Display-only: no deposit code, no inputs, no handlers.
    assert.ok(!/onclick=|onchange=/.test(block));
    assert.ok(!/<input|<form|<select|<textarea/i.test(block));
    assert.ok(!/create-invoice|requestDepositAddress|getAddressBtn/.test(block));
});

test('6. the three remaining card translations still exist in every locale', () => {
    ['deposit.tutorials.title', 'deposit.tutorials.body', 'deposit.tutorials.note']
        .forEach((key) => {
            const occurrences = (INDEX.match(new RegExp("'" + key.replace(/\./g, '\\.') + "'", 'g')) || []).length;
            assert.ok(occurrences >= 6, key + ' must be defined for all 6 locales (found ' + occurrences + ')');
        });
});

/* ------------------------------------------------------------------ *
 * 3. Deposit behaviour is untouched
 * ------------------------------------------------------------------ */
test('7. the deposit form, warning and history are unchanged', () => {
    ['id="liveDepositAmount"', 'id="getAddressBtn"', 'onclick="setDepositAmount(50)"',
     'onclick="setDepositAmount(1000)"', 'id="depositMinNotice"', 'id="depositInvoiceError"',
     'id="safetyWarning"', 'id="depositHistoryList"', 'id="depositPaymentSection"',
     'id="depositSuccessSection"', 'id="depositActionButtons"']
        .forEach((marker) => assert.ok(INDEX.includes(marker), marker + ' must still exist'));
    assert.match(INDEX, /function requestDepositAddress\(/);
    assert.match(INDEX, /MIN_DEPOSIT:\s*50/);
    assert.match(INDEX, /MIN_WITHDRAWAL:\s*700/);
});

test('8. the panel markup is still balanced after the move', () => {
    const markup = DIALOG.replace(/<!--[\s\S]*?-->/g, '');
    const re = /<div\b|<\/div>/g;
    let depth = 0;
    let m;
    while ((m = re.exec(markup))) depth += m[0] === '<div' ? 1 : -1;
    assert.strictEqual(depth, 0, 'the dialog closes every div it opens');
});
