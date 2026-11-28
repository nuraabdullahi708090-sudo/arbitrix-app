/**
 * Deposit Funds dialog - section order and tail spacing.
 *
 * The funding-help card ("Don't have cryptocurrency yet?" / Paybis / Transak /
 * Trust Wallet) was retired after its tutorial CTA was pulled, so the dialog now
 * ends with Recent Deposits. Reading order:
 *
 *   1 heading        2 funding options        3 supported asset/network
 *   4 method guidance 5 amount + presets      6 Generate Payment
 *   7 network warning 8 step actions          9 Recent Deposits
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

// Markup following the div that starts at `marker` (tag-balance walk, so nested
// divs cannot fool it).
function tailAfterBlock(markup, marker) {
    const start = markup.indexOf(marker);
    assert.ok(start > -1, 'expected block: ' + marker);
    const re = /<div\b|<\/div>/g;
    re.lastIndex = start;
    let depth = 0;
    let opened = false;
    let m;
    while ((m = re.exec(markup))) {
        if (m[0] === '</div>') {
            depth -= 1;
            if (opened && depth === 0) return markup.slice(m.index + 6);
        } else {
            depth += 1;
            opened = true;
        }
    }
    return '';
}

test('1. the dialog follows the approved section order, without the retired card', () => {
    const order = [
        ['heading', '<div class="deposit-modal-head">'],
        ['funding options', '<div id="depositOptions"'],
        ['currently supported asset/network', '<div id="supportedCoinsInfo"'],
        ['payment method guidance', '<details class="deposit-usdt-help" id="depositUsdtHelp">'],
        ['amount input', '<input type="number" id="liveDepositAmount"'],
        ['preset $50', 'onclick="setDepositAmount(50)"'],
        ['preset $250', 'onclick="setDepositAmount(250)"'],
        ['preset $500', 'onclick="setDepositAmount(500)"'],
        ['preset $1,000', 'onclick="setDepositAmount(1000)"'],
        ['Generate Payment', 'id="getAddressBtn"'],
        ['network warning', '<div id="safetyWarning"'],
        ['step actions', '<div id="depositActionButtons"'],
        ['Recent Deposits', '<div class="deposit-history"'],
        ['hidden inputs', '<!-- Hidden inputs -->']
    ];
    let previous = -1;
    order.forEach(([label, marker]) => {
        const position = at(marker);
        assert.ok(position > previous, label + ' must come after the previous section');
        previous = position;
    });
});

test('2. the retired card leaves nothing behind in the dialog', () => {
    [['element', 'id="depositTutorialsCard"'],
        ['icon', 'fa-graduation-cap'],
        ['heading key', 'deposit.tutorials.title'],
        ['explanation key', 'deposit.tutorials.body'],
        ['disclaimer key', 'deposit.tutorials.note'],
        ['CTA id', 'depositTutorialsCta'],
        ['tutorial link', 'deposit-tutorials'],
        ['heading text', "Don't have cryptocurrency yet?"],
        ['services text', 'Paybis, Transak and Trust Wallet']
    ].forEach(([label, marker]) => {
        assert.strictEqual(DIALOG.indexOf(marker), -1, label + ' must be gone from the dialog');
    });
    // ...and from the whole document (the keys were deleted, not orphaned).
    assert.strictEqual(INDEX.indexOf('deposit.tutorials.'), -1, 'no orphaned card key');
});

test('3. Recent Deposits is the last content block, immediately before the hidden inputs', () => {
    const tail = tailAfterBlock(DIALOG, '<div class="deposit-history"');
    const hiddenAt = tail.indexOf('<!-- Hidden inputs -->');
    assert.ok(hiddenAt > -1, 'the hidden inputs follow the history block');
    assert.strictEqual(tail.slice(0, hiddenAt).trim(), '',
        'nothing but whitespace may sit between Recent Deposits and the hidden inputs');
});

test('4. the dialog keeps a balanced bottom edge at both breakpoints', () => {
    // The panel own padding closes the dialog under Recent Deposits (24px desktop,
    // 20px on phones) - that is what keeps the removed card from leaving a gap or
    // a cramped tail.
    assert.match(INDEX, /#depositModal \.deposit-modal-content\{display:flex;flex-direction:column;padding:0 20px 24px;/);
    assert.match(INDEX, /#depositModal \.deposit-modal-content\{padding:0 16px 20px;\}/);
    // Recent Deposits keeps its separation from the step actions above it.
    assert.match(INDEX, /<div class="deposit-history" style="margin-top:20px;padding-top:16px;border-top:1px solid var\(--border-color\);">/);
});

test('5. the deposit mechanics the dialog owns are untouched', () => {
    ['id="liveDepositAmount"', 'id="getAddressBtn"', 'id="safetyWarning"',
        'id="depositHistoryList"', 'id="depositHistoryCount"', 'id="depositActionButtons"',
        'onclick="setDepositAmount(50)"', 'onclick="setDepositAmount(250)"',
        'onclick="setDepositAmount(500)"', 'onclick="setDepositAmount(1000)"'
    ].forEach((marker) => assert.ok(INDEX.includes(marker), 'missing: ' + marker));
    // Generate Payment still calls the one deposit routine, and TRC20 is stated.
    assert.match(INDEX, /id="getAddressBtn"[^>]*onclick="requestDepositAddress\(\)"/);
    assert.ok(DIALOG.includes('TRC20'));
    assert.ok(!/onclick="requestDepositAddress\(\)"/.test(tailAfterBlock(DIALOG, '<div class="deposit-history"')),
        'the history block triggers no deposit');
});

test('6. only the withdrawal tutorial keys remain, in all six locales', () => {
    ['withdraw.tutorial.title', 'withdraw.tutorial.body', 'withdraw.tutorial.cta', 'withdraw.tutorial.note']
        .forEach((key) => {
            const occurrences = (INDEX.match(new RegExp("'" + key.replace(/\./g, '\\.') + "'", 'g')) || []).length;
            assert.ok(occurrences >= 6, key + ' must be defined for all 6 locales (found ' + occurrences + ')');
        });
});
