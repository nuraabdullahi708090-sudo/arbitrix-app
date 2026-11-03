/**
 * Deposit Funds dialog - mobile full-screen layout.
 *
 * ROOT CAUSE pinned by this suite: the dialog markup closed
 * `#depositModalContent` (and `#depositInputSection`) too early, so
 * `#depositPaymentSection`, `#depositSuccessSection`, `#depositActionButtons`,
 * `.deposit-history` and the two hidden inputs were SIBLINGS of the panel
 * inside the `.deposit-modal` flex container. `.deposit-history` is visible, so
 * it became a flex item ~77px wide: on a 390px viewport the panel was squeezed
 * to ~313px and sat at x=0 with the page showing beside it, and once a payment
 * section was displayed the panel collapsed to a few dozen pixels.
 *
 * These tests lock the fixed structure and the mobile presentation contract in
 * place. They are UI-only: no deposit/payment/wallet/crediting logic is
 * asserted or changed here.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// Slice the deposit dialog markup so structural assertions cannot be satisfied
// by an identically named element elsewhere in the page.
function depositModalMarkup() {
    const start = INDEX.indexOf('<div class="deposit-modal" id="depositModal">');
    assert.ok(start > -1, 'the deposit dialog markup exists');
    const end = INDEX.indexOf('<div class="deposit-modal" id="onboardingModal">', start);
    assert.ok(end > start, 'the deposit dialog is followed by the next dialog');
    return INDEX.slice(start, end);
}

function cssBlock(selector, from = 0) {
    const start = INDEX.indexOf(selector, from);
    assert.ok(start > -1, 'expected CSS rule: ' + selector);
    const open = INDEX.indexOf('{', start);
    const close = INDEX.indexOf('}', open);
    return INDEX.slice(open + 1, close);
}

function mobileDepositBlock() {
    const mediaStart = INDEX.indexOf('@media(max-width:640px){\n            #depositModal{');
    assert.ok(mediaStart > -1, 'the <=640px deposit dialog block exists');
    const end = INDEX.indexOf('\n        }', INDEX.indexOf('#depositModal .deposit-modal-head{', mediaStart));
    assert.ok(end > mediaStart, 'the <=640px deposit dialog block is closed');
    return INDEX.slice(mediaStart, end);
}

/* ------------------------------------------------------------------ *
 * 1. Structure: one panel owns every deposit step
 * ------------------------------------------------------------------ */
test('1. the dialog overlay has the panel as its only child', () => {
    const markup = depositModalMarkup();
    // Everything between the overlay's opening tag and `#depositModalContent`
    // must be whitespace/comments only.
    const panelAt = markup.indexOf('<div class="deposit-modal-content" id="depositModalContent">');
    assert.ok(panelAt > 0);
    const between = markup.slice(markup.indexOf('>') + 1, panelAt).replace(/<!--[\s\S]*?-->/g, '').trim();
    assert.strictEqual(between, '', 'no element may sit between the overlay and the panel');
});

test('2. every deposit step lives inside #depositModalContent', () => {
    const markup = depositModalMarkup();
    const panelAt = markup.indexOf('<div class="deposit-modal-content" id="depositModalContent">');
    const tail = markup.slice(panelAt);
    ['id="depositInputSection"', 'id="depositPaymentSection"', 'id="depositSuccessSection"',
     'id="depositActionButtons"', 'class="deposit-history"', 'id="depositCurrency"', 'id="depositNetwork"']
        .forEach((needle) => {
            assert.ok(tail.includes(needle), needle + ' belongs to the scrolling panel');
        });
});

test('3. the nesting depth proves every step is inside the panel', () => {
    // Strip comments, then walk `<div` / `</div>` to get the depth at each
    // marker. The original bug closed the panel early, so the payment section
    // appeared at depth 1 (a direct child of the overlay) instead of 2.
    const markup = depositModalMarkup().replace(/<!--[\s\S]*?-->/g, '');
    const tokens = [];
    const re = /<div\b|<\/div>/g;
    let m;
    while ((m = re.exec(markup))) tokens.push({ at: m.index, open: m[0] === '<div' });

    const depthAt = (needle) => {
        const at = markup.indexOf(needle);
        assert.ok(at > -1, needle + ' exists');
        return tokens.filter((t) => t.at < at).reduce((d, t) => d + (t.open ? 1 : -1), 0);
    };

    assert.strictEqual(depthAt('<div class="deposit-modal-content" id="depositModalContent">'), 1,
        'the panel is the overlay\'s direct child');
    assert.strictEqual(depthAt('<div id="depositInputSection">'), 2, 'step 1 is inside the panel');
    assert.strictEqual(depthAt('<div id="depositPaymentSection"'), 2, 'step 2 is inside the panel');
    assert.strictEqual(depthAt('<div id="depositSuccessSection"'), 2, 'step 3 is inside the panel');
    assert.strictEqual(depthAt('<div id="depositActionButtons"'), 2, 'the invoice actions are inside the panel');
    assert.strictEqual(depthAt('<div class="deposit-history"'), 2, 'the history block is inside the panel');

    // The dialog closes completely: depth returns to 0 at the end of its markup.
    const finalDepth = tokens.reduce((d, t) => d + (t.open ? 1 : -1), 0);
    assert.strictEqual(finalDepth, 0, 'the dialog markup is balanced');
});

/* ------------------------------------------------------------------ *
 * 2. Mobile presentation contract (CSS only)
 * ------------------------------------------------------------------ */
test('4. the <=640px dialog is full-viewport, not a centred sheet', () => {
    const block = mobileDepositBlock();
    const overlay = block.slice(block.indexOf('#depositModal{'), block.indexOf('#depositModal .deposit-modal-content{'));
    assert.match(overlay, /width:\s*100vw/);
    assert.match(overlay, /max-width:\s*100vw/);
    assert.match(overlay, /height:\s*100dvh/);
    assert.match(overlay, /max-height:\s*100dvh/);
    assert.match(overlay, /align-items:\s*stretch/, 'stretch replaces the desktop flex-end bottom sheet');
    assert.match(overlay, /margin:\s*0/);
    assert.match(overlay, /padding:\s*0/);
    assert.match(overlay, /overflow:\s*hidden/);
});

test('5. the panel fills the dialog and respects safe areas', () => {
    const block = mobileDepositBlock();
    const panel = block.slice(block.indexOf('#depositModal .deposit-modal-content{'));
    assert.match(panel, /width:\s*100%/);
    assert.match(panel, /max-width:\s*100%/);
    assert.match(panel, /height:\s*100%/);
    assert.match(panel, /max-height:\s*100%/);
    assert.match(panel, /overflow-x:\s*hidden/);
    assert.match(panel, /overscroll-behavior:\s*contain/);
    assert.match(panel, /env\(safe-area-inset-bottom/, 'the home indicator must not cover the form');
    assert.match(panel, /env\(safe-area-inset-left/);
    assert.match(panel, /env\(safe-area-inset-right/);
    // A full-screen sheet has no rounded corners against the viewport edges.
    assert.match(panel, /border-radius:\s*0/);
});

test('6. the sticky header keeps the notch clear and the close control reachable', () => {
    const block = mobileDepositBlock();
    const head = block.slice(block.indexOf('#depositModal .deposit-modal-head{'));
    assert.match(head, /padding-top:calc\(20px \+ env\(safe-area-inset-top/);
    assert.match(head, /padding-right:\s*44px/);
    // The base (desktop + shared) rules that make the header sticky are intact.
    const baseHead = cssBlock('#depositModal .deposit-modal-head{');
    assert.match(baseHead, /position:sticky/);
    assert.match(baseHead, /top:0/);
    assert.match(baseHead, /z-index:15/);
});

test('7. an on-screen keyboard cannot cover the panel (visual viewport hook)', () => {
    assert.match(INDEX, /height:var\(--deposit-vh, 100dvh\)/);
    assert.match(INDEX, /max-height:var\(--deposit-vh, 100dvh\)/);
    assert.match(INDEX, /scroll-padding-top:/);
    assert.match(INDEX, /scroll-padding-bottom:/);
});

test('8. background scrolling is locked while the dialog is open and released on close', () => {
    assert.match(INDEX, /body:has\(#depositModal\.open\)\{overflow:hidden;\}/,
        'the lock must be keyed off the dialog open class so it releases itself');
    // Close removes exactly that class.
    const closeFn = INDEX.slice(INDEX.indexOf('function closeDepositModal()'), INDEX.indexOf('function updateDepositMinNotice()'));
    assert.match(closeFn, /classList\.remove\('open'\)/);
    // The lock is scoped to the deposit dialog only.
    assert.match(INDEX, /body:has\(#depositModal\.open\) \.support-widget\{display:none;\}/);
});

/* ------------------------------------------------------------------ *
 * 3. Desktop is preserved
 * ------------------------------------------------------------------ */
test('9. the desktop bottom sheet is unchanged', () => {
    const base = cssBlock('.deposit-modal{');
    assert.match(base, /position:fixed/);
    assert.match(base, /align-items:flex-end/, 'desktop keeps the bottom sheet');
    assert.match(base, /justify-content:center/);
    const basePanel = cssBlock('.deposit-modal-content{');
    assert.match(basePanel, /max-width:500px/);
    assert.match(basePanel, /max-height:92vh/);
    // The mobile block must be scoped, so nothing above 640px is affected.
    assert.match(INDEX, /@media\(max-width:640px\)\{\s*\n\s*#depositModal\{/);
    assert.ok(INDEX.indexOf('@media(max-width:640px){\n            #depositModal{') >
        INDEX.indexOf('body:has(#depositModal.open) .support-widget{display:none;}'),
        'the mobile block must come after the base deposit rules (cascade order)');
});

/* ------------------------------------------------------------------ *
 * 4. Deposit behaviour is untouched
 * ------------------------------------------------------------------ */
test('10. the deposit controls and their handlers are unchanged', () => {
    ['id="liveDepositAmount"', 'id="getAddressBtn"', 'onclick="requestDepositAddress()"',
     'onclick="closeDepositModal()"', 'id="depositPaymentSection"', 'id="qrCodeImage"',
     'id="depositHistoryList"', 'id="depositInvoiceRef"']
        .forEach((needle) => assert.ok(INDEX.includes(needle), needle + ' must still exist'));
    assert.match(INDEX, /function requestDepositAddress\(/);
    assert.match(INDEX, /function closeDepositModal\(/);
    // Financial rules unchanged by a layout task.
    assert.match(INDEX, /MIN_DEPOSIT:\s*100/);
    assert.match(INDEX, /MIN_WITHDRAWAL:\s*700/);
    // The panel keeps its internal scroll and sticky head.
    assert.match(INDEX, /#depositModal \.deposit-modal-content\{display:flex;flex-direction:column;padding:0 20px 24px;max-height:92vh;max-height:92dvh;\}/);
});

/* ------------------------------------------------------------------ *
 * 5. The visual-viewport helper behaves
 * ------------------------------------------------------------------ */
test('11. DepositViewport tracks the visual height only while the dialog is open', () => {
    const start = INDEX.indexOf('const DepositViewport = {');
    const end = INDEX.indexOf('DepositViewport.init();', start) + 'DepositViewport.init();'.length;
    assert.ok(start > -1 && end > start, 'the helper is present');
    const source = INDEX.slice(start, end);

    const makeRoot = () => {
        const props = {};
        return {
            props,
            style: {
                setProperty: (k, v) => { props[k] = v; },
                removeProperty: (k) => { delete props[k]; }
            }
        };
    };
    const makeModal = (open) => ({
        classList: { contains: (c) => open && c === 'open' }
    });

    function run(open, viewportHeight, hasVV = true) {
        const root = makeRoot();
        const listeners = [];
        const sandbox = {
            document: { documentElement: root, getElementById: () => makeModal(open) },
            window: {
                visualViewport: hasVV ? { height: viewportHeight, addEventListener: (n, f) => listeners.push(n) } : undefined,
                addEventListener: () => {}
            },
            console
        };
        sandbox.window.window = sandbox.window;
        vm.createContext(sandbox);
        // `const` bindings are lexical, so call sync() from inside the same
        // script instead of reaching for a global property.
        vm.runInContext(source + '\nDepositViewport.sync();', sandbox);
        return { root, listeners, sandbox };
    }

    const open = run(true, 512);
    assert.strictEqual(open.root.props['--deposit-vh'], '512px');
    assert.deepStrictEqual(open.listeners.sort(), ['resize', 'scroll'], 'resize + scroll are observed');

    const closed = run(false, 512);
    assert.deepStrictEqual(Object.keys(closed.root.props), [], 'a closed dialog carries no height override');

    const noVV = run(true, 512, false);
    assert.deepStrictEqual(Object.keys(noVV.root.props), [], 'no visualViewport hook means no override');
});

test('12. opening and closing the dialog drive the viewport helper', () => {
    const openFn = INDEX.slice(INDEX.indexOf('function openDepositModal()'), INDEX.indexOf('function focusWithoutScroll('));
    const closeFn = INDEX.slice(INDEX.indexOf('function closeDepositModal()'), INDEX.indexOf('function updateDepositMinNotice()'));
    assert.match(openFn, /if \(typeof DepositViewport !== 'undefined'\) DepositViewport\.sync\(\);/);
    assert.match(closeFn, /if \(typeof DepositViewport !== 'undefined'\) DepositViewport\.sync\(\);/);
    // Guarded so the vm-sandboxed UI tests (and any partial script context)
    // keep working without the helper.
    assert.ok(!/^\s*DepositViewport\.sync\(\);/m.test(openFn + closeFn));
});
