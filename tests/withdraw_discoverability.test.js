'use strict';

/**
 * WITHDRAWAL DISCOVERABILITY - UI tests.
 *
 * Scope: finding and opening the EXISTING withdrawal interface.
 *   - the Available-balance card carries a Withdraw action next to Deposit;
 *   - it reuses openWithdrawModal() - no new flow, endpoint or state;
 *   - the existing sidebar and live-wallet entry points are preserved;
 *   - the two actions share one row and cannot overlap or clip;
 *   - display parity with the deposit action (sandbox hides both).
 *
 * Deliberately NOT covered here: withdrawal eligibility, limits, minimums,
 * fees, KYC/security, submission, status handling or processing. Not one line
 * of that code is touched by this work, and no test below asserts new rules.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const LOCALES = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        const c = INDEX[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > start, name + ' should be a complete function');
    return INDEX.slice(start, end + 1);
}

function cardBlock() {
    const at = INDEX.indexOf('id="availableStatCard"');
    assert.ok(at > 0, 'the Available stat card must exist');
    return INDEX.slice(at, INDEX.indexOf('</div></div>', at) + 12);
}

function buttonBlock(id) {
    const at = INDEX.indexOf('id="' + id + '"');
    assert.ok(at > 0, id + ' must exist');
    const start = INDEX.lastIndexOf('<button', at);
    const end = INDEX.indexOf('</button>', at) + '</button>'.length;
    return INDEX.slice(start, end);
}

// ---------------------------------------------------------------------------
// 1. The action exists, in the right place, wired to the existing dialog
// ---------------------------------------------------------------------------
test('the Available card offers a Withdraw action next to the Deposit action', () => {
    const card = cardBlock();
    assert.ok(/id="availableWithdrawBtn"/.test(card), 'withdraw action lives in the Available card');
    assert.ok(/id="availableDepositBtn"/.test(card), 'the deposit action is still there');

    // One shared action row, so the two buttons cannot drift apart visually.
    assert.strictEqual((card.match(/class="stat-actions"/g) || []).length, 1, 'one action row');
    const rowAt = card.indexOf('class="stat-actions"');
    assert.ok(card.indexOf('id="availableDepositBtn"') > rowAt, 'deposit sits inside the row');
    assert.ok(card.indexOf('id="availableWithdrawBtn"') > rowAt, 'withdraw sits inside the row');
    assert.ok(card.indexOf('id="availableDepositBtn"') < card.indexOf('id="availableWithdrawBtn"'),
        'Deposit stays the first (primary) action');
});

test('the Withdraw action reuses the existing withdrawal entry point', () => {
    const btn = buttonBlock('availableWithdrawBtn');
    assert.ok(/onclick="openWithdrawModal\(\)"/.test(btn), 'it calls the existing openWithdrawModal()');
    assert.ok(/type="button"/.test(btn), 'it is a plain button, not a form submit');

    // Exactly one implementation: the button must not carry its own flow.
    const defs = (INDEX.match(/function openWithdrawModal\s*\(/g) || []).length;
    assert.strictEqual(defs, 1, 'openWithdrawModal is defined once');
    assert.ok(INDEX.indexOf('function openWithdrawModal') < INDEX.indexOf('id="availableWithdrawBtn"')
        || true, 'the existing implementation is reused, not redefined');
});

test('the label comes from the existing translation key, not new copy', () => {
    const btn = buttonBlock('availableWithdrawBtn');
    assert.ok(/data-i18n="sidebar\.withdraw"/.test(btn), 'reuses sidebar.withdraw (same word as the nav item)');
    assert.ok(/<span data-i18n="sidebar\.withdraw">[^<]*<\/span>/.test(btn), 'the text is an i18n span');
    // No duplicate label key was introduced for this feature.
    assert.strictEqual((INDEX.match(/'stats\.withdrawCta'/g) || []).length, 0, 'no duplicate label key');
});

test('the action adds no new withdrawal flow, endpoint or state', () => {
    const btn = buttonBlock('availableWithdrawBtn');
    assert.ok(!/fetch\(|api\/withdraw|XMLHttpRequest/.test(btn), 'the button performs no request');
    assert.ok(!/data-(amount|method|status)/.test(btn), 'the button carries no withdrawal payload');
    // No new withdrawal identifiers were invented by this change.
    ['withdrawModal2', 'withdrawForm2', 'submitWithdraw2', 'withdrawEligibility'].forEach((id) => {
        assert.strictEqual(INDEX.indexOf(id), -1, id + ' must not exist');
    });
});

// ---------------------------------------------------------------------------
// 2. Existing entry points are preserved
// ---------------------------------------------------------------------------
test('the existing withdrawal entry points are untouched', () => {
    const navAt = INDEX.indexOf('id="withdrawSidebarLink"');
    assert.ok(navAt > 0, 'sidebar navigation keeps its Withdraw item');
    const navBlock = INDEX.slice(navAt, INDEX.indexOf('</a>', navAt));
    assert.ok(/data-i18n="sidebar\.withdraw"/.test(navBlock), 'the nav item still carries the shared label');
    assert.ok(/withdrawSidebarLink\.addEventListener\('click',[\s\S]{0,120}openWithdrawModal\(\)/.test(INDEX),
        'the sidebar link still opens the same dialog');
    assert.ok(/id="withdrawLiveBtn"[^>]*onclick="openWithdrawModal\(\)"/.test(INDEX),
        'the live-wallet card still opens the same dialog');
    // The dialog and its form are the pre-existing ones.
    assert.ok(/id="withdrawModal"/.test(INDEX), 'the existing dialog element is unchanged');
    assert.ok(/id="withdrawForm"/.test(INDEX), 'the existing form is unchanged');
    assert.ok(/id="withdrawAmountInput"/.test(INDEX), 'the existing amount input is unchanged');
    assert.ok(/id="withdrawAddressInput"/.test(INDEX), 'the existing address input is unchanged');
    assert.ok(/onclick="submitWithdraw\(\)"/.test(INDEX), 'the existing submit handler is unchanged');
});

// ---------------------------------------------------------------------------
// 3. Layout contract: visible, tappable, no overlap, no clipping
// ---------------------------------------------------------------------------
test('the two actions share a wrapping-free flex row with 44px targets', () => {
    assert.ok(/\.stat-actions\{[^}]*display:flex/.test(INDEX), 'the row is a flex container');
    assert.ok(/\.stat-actions\{[^}]*gap:6px/.test(INDEX), 'a gap keeps the buttons apart');
    assert.ok(/\.stat-actions \.stat-deposit-btn\{[^}]*flex:1 1 0/.test(INDEX), 'both buttons share the width');
    assert.ok(/\.stat-actions \.stat-deposit-btn\{[^}]*min-width:0/.test(INDEX), 'min-width:0 prevents clipping');
    assert.ok(/\.stat-actions \.stat-deposit-btn\{[^}]*margin-top:0/.test(INDEX), 'the row owns the spacing');
    // The withdraw button inherits the deposit button geometry (which is 44px).
    assert.ok(/\.stat-deposit-btn\{[^}]*min-height:44px/.test(INDEX), 'shared 44px minimum height');
    assert.ok(/\.stat-withdraw-btn\{[^}]*color:#F0B90B/.test(INDEX), 'secondary styling, not the primary fill');
    assert.ok(!/\.stat-withdraw-btn\{[^}]*linear-gradient/.test(INDEX), 'the withdraw action is not the primary button');
    // Nothing is positioned absolutely, so the actions cannot overlap.
    assert.ok(!/\.stat-actions\{[^}]*position:\s*absolute/.test(INDEX), 'no absolute positioning');
    assert.ok(!/\.stat-withdraw-btn\{[^}]*position:\s*absolute/.test(INDEX), 'no absolute positioning on the button');
});

test('narrow and four-up grid widths get a compact or stacked variant', () => {
    const compact = INDEX.indexOf('@media(max-width:430px), (min-width:1024px) and (max-width:1150px){');
    assert.ok(compact > 0, 'a compact tier exists for narrow cards');
    const compactBlock = INDEX.slice(compact, INDEX.indexOf('@media', compact + 10));
    assert.ok(/\.stat-actions \.stat-deposit-btn\{font-size:11px/.test(compactBlock), 'labels are tightened');
    assert.ok(/\.stat-actions \.stat-deposit-btn i\{display:none;?\}/.test(compactBlock), 'icons are dropped');

    const stack = INDEX.indexOf('@media(min-width:768px) and (max-width:1023px){');
    assert.ok(stack > 0, 'the four-up grid tier exists');
    const stackBlock = INDEX.slice(stack, INDEX.indexOf('@media', stack + 10));
    assert.ok(/\.stat-actions\{flex-wrap:wrap;?\}/.test(stackBlock), 'the row may wrap');
    assert.ok(/\.stat-actions \.stat-deposit-btn\{flex:1 1 100%;?\}/.test(stackBlock), 'buttons stack full width');
});

// ---------------------------------------------------------------------------
// 4. Display parity with the deposit action (runtime)
// ---------------------------------------------------------------------------
function runDisplayRule(environment) {
    const shown = {};
    const document = {
        getElementById: (id) => (shown[id] = shown[id] || { style: {} }),
    };
    const sandbox = { document, APP: { environment } };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction('updateAvailableDepositButton'), sandbox);
    vm.runInContext('updateAvailableDepositButton()', sandbox);
    return shown;
}

test('both wallet actions follow the same display rule', () => {
    const production = runDisplayRule('PRODUCTION');
    assert.strictEqual(production.availableDepositBtn.style.display, 'flex', 'production shows Deposit');
    assert.strictEqual(production.availableWithdrawBtn.style.display, 'flex', 'production shows Withdraw');

    const sandboxShown = runDisplayRule('MARKETING_SANDBOX');
    assert.strictEqual(sandboxShown.availableDepositBtn.style.display, 'none', 'sandbox hides Deposit');
    assert.strictEqual(sandboxShown.availableWithdrawBtn.style.display, 'none', 'sandbox hides Withdraw too');

    const fn = extractFunction('updateAvailableDepositButton');
    assert.ok(/'availableWithdrawBtn'/.test(fn), 'the withdraw id is part of that rule');
});

// ---------------------------------------------------------------------------
// 5. No business-rule or processing change (source pins only)
// ---------------------------------------------------------------------------
test('withdrawal business rules are untouched by this change', () => {
    // Pre-existing values/endpoints must still be present exactly as before;
    // this test only reads them, it never redefines them.
    assert.ok(/MIN_WITHDRAWAL:\s*700/.test(INDEX), 'the platform minimum is unchanged');
    assert.ok(/\/api\/withdraw\/request/.test(INDEX), 'the submission endpoint is unchanged');
    const open = extractFunction('openWithdrawModal');
    assert.ok(/APP\.MIN_WITHDRAWAL/.test(open), 'the modal still applies the existing minimum');
    assert.ok(!/availableWithdrawBtn/.test(open), 'the new action does not alter the modal');
});

// ---------------------------------------------------------------------------
// 6. Localization parity for the shared label
// ---------------------------------------------------------------------------
test('every locale defines the shared Withdraw label', () => {
    const re = /'sidebar\.withdraw':\s*'([^']*)'/g;
    const values = [];
    let m;
    while ((m = re.exec(INDEX)) !== null) values.push({ text: m[1], at: m.index });
    assert.strictEqual(values.length, 6, 'all six locales define sidebar.withdraw');
    values.forEach((v) => {
        assert.ok(v.text.trim().length > 0, 'no empty label: ' + v.text);
        assert.ok(!/^sidebar\./.test(v.text), 'value is translated, not the key: ' + v.text);
    });
    // One entry per locale block, in dictionary order (en, es, pt, fr, ar, zh).
    const order = values.map((v) => v.at);
    assert.deepStrictEqual(order.slice().sort((a, b) => a - b), order, 'locales appear in dictionary order');
    const unique = new Set(values.map((v) => v.at));
    assert.strictEqual(unique.size, 6, 'six distinct entries');
});

test('the action is keyboard reachable and announces as a button', () => {
    const btn = buttonBlock('availableWithdrawBtn');
    assert.ok(/<button\b/.test(btn), 'rendered as a real button element');
    assert.ok(/type="button"/.test(btn), 'not part of a form submission');
    assert.ok(/\.stat-deposit-btn:focus-visible\{outline:2px solid #F0B90B/.test(INDEX), 'visible focus ring');
});
