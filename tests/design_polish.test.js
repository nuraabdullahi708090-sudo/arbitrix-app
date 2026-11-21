'use strict';

/**
 * Design polish (v2) - the visual/UX contracts added on top of the design
 * system: the emerald accent, the single toolbar, the segmented mode switch,
 * the dismissible ticker, the actionable toast and the language-switch
 * robustness layer.
 *
 * These are frontend-only guarantees. Nothing here asserts financial behaviour;
 * the money paths are pinned by their own suites and are re-checked at the end
 * of this file so a "visual" change cannot quietly reach them.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const { BRAND } = require('../services/brand');

const CSS = (() => {
    const start = INDEX.indexOf('<style id="kx-design-system">');
    const end = INDEX.indexOf('</style>', start);
    return INDEX.slice(start, end);
})();

/** Loads the real TRANSLATIONS object out of the page. */
function translations() {
    const start = INDEX.indexOf('const TRANSLATIONS = {');
    assert.ok(start > 0, 'TRANSLATIONS must exist');
    let depth = 0;
    let i = INDEX.indexOf('{', start);
    const from = i;
    for (; i < INDEX.length; i += 1) {
        if (INDEX[i] === '{') depth += 1;
        else if (INDEX[i] === '}') {
            depth -= 1;
            if (depth === 0) break;
        }
    }
    const src = INDEX.slice(from, i + 1);
    const sandbox = {};
    vm.runInNewContext('this.T = ' + src, sandbox);
    return sandbox.T;
}

const T = translations();
const LANGS = Object.keys(T);

/* ------------------------------------------------------------------ *
 * 1. the emerald identity
 * ------------------------------------------------------------------ */
test('1. the shipped accent is the institutional azure identity, not a stray literal', () => {
    assert.strictEqual(BRAND.accent, '#5EA0FF', 'the server-side accent follows the palette');
    assert.strictEqual(BRAND.candidateIdentity.palette.accent, '#5EA0FF');
    // the identity override lives in its own <style>, so check the whole page
    assert.ok(INDEX.includes('--brand:#5EA0FF'), 'the page carries the same accent');
    assert.ok(INDEX.includes('--brand-rgb:94,160,255'), 'the rgba triplet follows the accent');
    assert.ok(INDEX.includes('--on-brand:#06121F'), 'ink on the fill is the dark token, not black');
    // measured: 7.00:1 on the page, 5.13:1 on the elevated dialog surface
});

test('1c. the accent never doubles as a P&L colour', () => {
    // A green or gold brand accent competes with profit/loss (or warning)
    // semantics; azure is decorative and the semantic tokens keep their hues.
    const tok = (n) => (CSS.match(new RegExp('--kx-' + n + ':(#[0-9A-Fa-f]{6})')) || [])[1];
    assert.strictEqual(tok('accent'), '#5EA0FF');
    assert.strictEqual(tok('success'), '#2EBD85', 'profit stays green');
    assert.strictEqual(tok('danger'), '#E5484D', 'loss stays red');
    assert.notStrictEqual(tok('accent'), tok('success'));
    assert.notStrictEqual(tok('accent'), tok('danger'));
});

test('1d. dialogs sit on their own elevated surface', () => {
    // "The pop-up does not stand out" is the failure this pins: a dialog that
    // reuses the page surface reads as if nothing opened.
    assert.match(CSS, /\.modal-content, \.deposit-modal-content \{\s*background:linear-gradient\(180deg,#2B3A4E/,
        'the dialog uses the elevated gradient surface');
    assert.match(CSS, /border:1px solid rgba\(94,160,255,0\.26\)/, 'an accent hairline marks the edge');
    assert.match(CSS, /box-shadow:0 40px 96px rgba\(0,0,0,0\.80\)/, 'a deep shadow lifts it off the page');
    assert.match(CSS, /\.modal-overlay, \.deposit-modal \{ background:rgba\(4,7,11,0\.82\)/, 'the backdrop dims the page');
    assert.match(CSS, /@keyframes kx-dialog-in/, 'the panel animates in');
    assert.match(CSS, /@media \(prefers-reduced-motion:reduce\) \{[^}]*animation:none/,
        'the entrance respects reduced motion');
});

test('1b. no page still ships the previous violet/navy palette', () => {
    const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
    const legacy = ['#7C5CFF', '#9B85FF', '#6344E8', '#070B14', '#0C1220', '#8896B5', '124,92,255'];
    pages.forEach((file) => {
        const src = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
        legacy.forEach((hex) => {
            assert.ok(!src.includes(hex), file + ' still references ' + hex);
        });
    });
});

/* ------------------------------------------------------------------ *
 * 1e. the promotional-credit restriction is a warning, not fine print
 * ------------------------------------------------------------------ */
test('1e. the promo-credit restriction renders as a single amber notice on the first screen', () => {
    // Reported twice: "the promo credit warning is still not visible". It used
    // to be 10px centred text in the brand tint, inside the Live wallet card,
    // which is not even rendered while a promo-funded account sits in Demo.
    // There is now exactly ONE notice, on the first screen, in the amber
    // restriction skin - red is reserved for errors and destructive states.
    assert.strictEqual((INDEX.match(/id="promoCreditNotice"/g) || []).length, 0,
        'the duplicate notice inside the Live Wallet card is gone');
    const banner = (INDEX.match(/<div id="promoCreditBanner"[^>]*>/g) || [])[0] || '';
    assert.match(banner, /kx-alert kx-alert-warning/, 'the first-screen banner uses the amber variant');
    assert.ok(!/kx-alert-danger/.test(banner), 'a restriction is not painted as an error');
    assert.ok(INDEX.indexOf('id="promoCreditBanner"') < INDEX.indexOf('id="startHereCard"'),
        'the banner sits above the onboarding card, i.e. on the first screen');
    // One decision drives the single banner.
    const start = INDEX.indexOf('const promoBanner = document.getElementById');
    assert.ok(start > 0, 'the visibility decision reads the banner element');
    const fn = INDEX.slice(start, INDEX.indexOf('updateDemoFirstDepositCta', start));
    assert.match(fn, /promoBanner\.classList\.toggle\('hidden', !showPromoNotice\)/);
    // The component itself: body-size text, left aligned, and the amber tokens.
    const rule = CSS.slice(CSS.indexOf('.kx-alert {'), CSS.indexOf('.kx-alert.kx-alert-warning'));
    assert.match(rule, /background:var\(--kx-danger-weak\)/, 'the base skin stays red for errors');
    assert.match(rule, /font-size:12px/, 'body size, not 10px fine print');
    assert.match(rule, /text-align:left/, 'left aligned, so it reads as a notice');
    const warn = CSS.slice(CSS.indexOf('.kx-alert.kx-alert-warning'), CSS.indexOf('.kx-alert.hidden'));
    assert.match(warn, /background:var\(--kx-warning-weak\)/, 'amber background for a restriction');
    assert.match(warn, /border-color:var\(--kx-warning-border\)/, 'amber border');
    assert.match(warn, /color:var\(--kx-warning-text\)/, 'readable amber text');
    assert.match(CSS, /\.kx-alert\.hidden \{ display:none; \}|\.hidden\{display:none!important/, 'it can still be hidden');
});

/* ------------------------------------------------------------------ *
 * 2. one toolbar instead of three wrapped rows
 * ------------------------------------------------------------------ */
test('2. the header is a single grid toolbar with no fixed height', () => {
    assert.match(CSS, /\.app-header \{[^}]*display:grid/, 'the toolbar is a grid');
    assert.match(CSS, /grid-template-areas:"brand sub right"/, 'three named areas on desktop');
    assert.match(CSS, /@media \(max-width:640px\)[\s\S]*?grid-template-areas:"burger brand right" "sub sub sub"/,
        'two rows on phones: brand row + mode/status row');
    // mobile_nav_layout.test.js pins "no fixed height"; this pins the grid form.
    assert.ok(!/\.app-header \{[^}]*height:\s*\d/.test(CSS), 'the toolbar must size to its content');
});

test('2b. the hamburger lives in the toolbar and is declared once', () => {
    const inToolbar = INDEX.slice(INDEX.indexOf('id="appToolbar"'), INDEX.indexOf('</div>', INDEX.indexOf('id="appToolbar"') + 200));
    assert.ok(inToolbar.includes('id="mobileMenuBtn"') || INDEX.indexOf('id="mobileMenuBtn"') > INDEX.indexOf('id="appToolbar"'),
        'the menu button is part of the toolbar');
    assert.strictEqual((INDEX.match(/id="mobileMenuBtn"/g) || []).length, 1, 'exactly one menu button exists');
    assert.match(CSS, /\.app-header \.mobile-menu-btn \{[^}]*position:static/, 'it flows with the toolbar');
    // the drawer must still cover it, and hiding it while open still applies
    assert.match(INDEX, /body:has\(\.sidebar\.open\) \.mobile-menu-btn\{opacity:\s*0/);
});

test('2c. the toolbar sticks on phones only, above the content and below the drawer', () => {
    const mobile = CSS.slice(CSS.indexOf('@media (max-width:640px)'));
    assert.match(mobile, /position:sticky; top:0; z-index:900/, 'sticky at the phone breakpoint');
    assert.ok(!/@media \(max-width:640px\)[\s\S]*?z-index:9[5-9]\d\d[\s\S]*?\n    \}/.test(''),
        'no drawer-level z-index is used by the toolbar');
});

/* ------------------------------------------------------------------ *
 * 3. the mode switch reads as a segmented control
 * ------------------------------------------------------------------ */
test('3. the mode switch is a segmented control, not two emoji labels', () => {
    assert.match(CSS, /\.mode-tabs \{[^}]*border-radius:var\(--kx-r-pill\)/, 'the group is a pill');
    assert.match(CSS, /\.mode-tab \{[^}]*height:28px/, 'each segment is a fixed-height pill');
    assert.match(CSS, /\.mode-tab\.active \{[^}]*background:var\(--kx-accent\); color:var\(--kx-on-accent\)/,
        'the active segment uses the accent fill and readable ink');
    const tabs = INDEX.slice(INDEX.indexOf('id="demoTab"'), INDEX.indexOf('id="liveTab"') + 200);
    assert.ok(!/📘|🔥/.test(tabs), 'no emoji inside the switch');
    LANGS.forEach((l) => {
        assert.ok(!/📘|🔥/.test(T[l]['mode.demo']), l + ': mode.demo must not carry an emoji');
        assert.ok(!/📘|🔥/.test(T[l]['mode.live']), l + ': mode.live must not carry an emoji');
    });
});

/* ------------------------------------------------------------------ *
 * 4. stat cards: two-up on phones, four-up above, tabular figures
 * ------------------------------------------------------------------ */
test('4. the stat grid is two-up on phones and four-up from 1024px', () => {
    assert.match(CSS, /\.stats-grid \{ display:grid; grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
    const mobile = CSS.slice(CSS.indexOf('@media (max-width:640px)'));
    assert.match(mobile, /\.stats-grid \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/, 'two columns on phones');
    assert.match(CSS, /\.stat-value \{[^}]*font-variant-numeric:tabular-nums/, 'figures align in columns');
    assert.match(CSS, /\.stat-actions \{ display:flex; flex-direction:row/, 'deposit/withdraw stay on one row');
    assert.match(CSS, /\.stat-deposit-btn, \.stat-withdraw-btn \{[^}]*min-height:44px/, '44px touch targets');
});

/* ------------------------------------------------------------------ *
 * 5. ticker: compact, and the user can put it away
 * ------------------------------------------------------------------ */
test('5. the activity ticker is compact and dismissible', () => {
    assert.match(INDEX, /id="tickerDismissBtn"[^>]*onclick="dismissTicker\(\)"/, 'a dismiss control exists');
    assert.match(CSS, /body\.kx-ticker-hidden \.ticker-wrapper \{ display:none; \}/, 'dismissing hides it');
    assert.match(CSS, /\.ticker-wrapper \{[^}]*height:34px/, 'single-row height');
    const mobile = CSS.slice(CSS.indexOf('@media (max-width:640px)'));
    assert.match(mobile, /\.ticker-wrapper \{ height:32px/, 'stays one row on phones');
    assert.match(INDEX, /window\.dismissTicker = function/, 'the handler is exposed for the inline call');
    LANGS.forEach((l) => assert.ok(T[l]['ticker.hide'], l + ': ticker.hide must exist'));
});

/* ------------------------------------------------------------------ *
 * 6. toasts can be dismissed and announce their state
 * ------------------------------------------------------------------ */
test('6. toasts carry an icon, a close button and a live region role', () => {
    // showToast now delegates to renderToast (queue), so the slice covers both.
    const fn = INDEX.slice(INDEX.indexOf('const TOAST_ICONS'), INDEX.indexOf('function renderToast') + 1800);
    assert.match(fn, /toast-icon/, 'an icon is rendered');
    assert.match(fn, /toast-close/, 'a close button is rendered');
    assert.match(fn, /role', \(type === 'error' \|\| type === 'warning'\) \? 'alert' : 'status'/,
        'a restriction is announced as an alert, a confirmation as a status');
    assert.match(fn, /clearTimeout\(timer\)/, 'closing cancels the auto-dismiss timer');
    assert.match(CSS, /\.toast-close \{[^}]*width:26px; height:26px/, 'the close target is real');
    assert.match(CSS, /\.toast \{[^}]*left:12px; right:12px/, 'it fits the phone width');
    assert.match(CSS, /\.toast \{[^}]*max-height:38vh; overflow:auto/, 'a long message cannot run off screen');
});

/* ------------------------------------------------------------------ *
 * 6b. every blocked action looks like one
 * ------------------------------------------------------------------ */
test('6b. blocked actions surface as a red toast, not a neutral one', () => {
    // Reported by the owner: pressing Start Bot at the promo limit, or Withdraw
    // without a deposit or a trade, produced a toast that looked like any other
    // message. It now has to be BOTH red and opaque - a translucent panel let the
    // dashboard read through it.
    const block = CSS.slice(CSS.indexOf('.toast-error, .toast-warning {'), CSS.indexOf('.toast .toast-close {'));
    assert.match(block, /background:#33161A/, 'solid red surface');
    assert.match(block, /border-color:#8E3A42/, 'red border');
    assert.match(block, /color:#FFBFC3/, 'readable red text');
    assert.ok(!/background:rgba/.test(block), 'the surface is not translucent');
    const ok = CSS.slice(CSS.indexOf('.toast-success {'), CSS.indexOf('.toast-error, .toast-warning {'));
    assert.match(ok, /background:#0E2A22/, 'success keeps its own solid green surface');
    assert.ok(!/background:rgba/.test(ok), 'success is not translucent either');

    // The call sites that block a customer action must use error/warning.
    const sites = [
        "showToast(t('bot.promoLimitReached'), 'error', 6000)",
        "showToast(t('bot.promoLimitReached'),'error', 6000)",
        "showToast(t('withdraw.firstDeposit'),'error',6000)",
        "showToast(t('withdraw.firstDeposit'),'error')",
        "showToast(t('withdraw.needTrade'),'error')",
        "showToast(t('withdraw.minWithdrawal', {min: APP.MIN_WITHDRAWAL",
        "showToast(t('demo.noFunds'),'warning')",
        "showToast(t('subscription.paymentDue'), 'warning')",
    ];
    sites.forEach((n) => assert.ok(INDEX.includes(n), 'missing: ' + n.slice(0, 62)));

    // Blocking dialogs are red too, not decorated in the brand colour.
    assert.match(CSS, /#profitPauseModal \.kx-block-glyph[^}]*var\(--kx-danger-text\)/,
        'the paused-bot glyph is red');
    assert.match(CSS, /#profitPauseModal \.kx-block-icon[^}]*var\(--kx-danger-weak\)/,
        'the paused-bot badge is red-tinted');
    assert.match(CSS, /#withdrawKycRequired \[data-i18n="withdraw\.kycRequiredTitle"\] \{ color:var\(--kx-danger-text\)/,
        'the verification-required title is red');
});

/* ------------------------------------------------------------------ *
 * 7. language switching cannot silently stop working
 * ------------------------------------------------------------------ */
test('7. a language click always reaches setLanguage()', () => {
    // The inline handler stays, and a delegated listener is the safety net.
    assert.match(INDEX, /document\.addEventListener\('click', function \(e\) \{\s*var opt = e\.target\.closest/,
        'clicks are delegated so a re-rendered option still switches');
    assert.match(INDEX, /if \(lang && lang !== active\) setLanguage\(lang\)/, 'the active language is a no-op');
    // currentLang is script-scoped; comparing with window.currentLang would be
    // undefined and every click would double-apply the switch.
    assert.ok(!/lang !== window\.currentLang/.test(INDEX), 'the guard must not read window.currentLang');
    assert.match(INDEX, /var active = document\.documentElement\.lang;/, 'the guard reads <html lang>');
});

test('7b. a ?lang= deep link is an escape hatch', () => {
    assert.match(INDEX, /\[\?&\]lang=\(\[a-z\]\{2\}\)/, 'the query parameter is parsed');
    assert.match(INDEX, /TRANSLATIONS\[lang\] && lang !== document\.documentElement\.lang/, 'only a shipped locale applies');
    assert.match(INDEX, /function applyLangFromUrl\(\)/, 'it is a named, testable function');
});

test('7c. the dropdown reports its state and cannot leave the viewport', () => {
    assert.match(INDEX, /setAttribute\('aria-expanded', open \? 'true' : 'false'\)/, 'aria-expanded is maintained');
    assert.match(INDEX, /function clampMenu\(el\)/, 'the menu is clamped to the viewport');
    assert.match(CSS, /\.language-dropdown \{[^}]*max-width:calc\(100vw - 24px\)/, 'a CSS backstop exists');
    assert.match(CSS, /\.language-option \{[^}]*min-height:36px/, 'options are tappable');
});

test('7d. aria labels are translatable (icon-only controls)', () => {
    assert.match(INDEX, /querySelectorAll\('\[data-i18n-aria-label\]'\)/, 'applyTranslations handles the attribute');
    assert.match(INDEX, /data-i18n-aria-label="ticker\.hide"/, 'the dismiss button uses it');
    LANGS.forEach((l) => assert.ok(T[l]['ticker.hide'], l + ': aria label key present'));
});

/* ------------------------------------------------------------------ *
 * 8. the mode is visible without relying on colour alone
 * ------------------------------------------------------------------ */
test('8. the account-status chip has a shape indicator and a live state', () => {
    assert.match(CSS, /\.kx-status::before \{[^}]*border-radius:50%/, 'a dot carries the state');
    assert.match(CSS, /\.kx-status\.is-live \.kx-status::before|\.kx-status\.is-live \{/);
    assert.match(INDEX, /id="accountStatus"/, 'the chip exists');
    assert.match(INDEX, /accountStatus\.textContent = APP\.liveData\.hasRealDeposit/, 'it reflects the funded state');
    assert.match(INDEX, /window\.syncToolbarStatus = function/);
});

/* ------------------------------------------------------------------ *
 * 9. reduced motion and no global hacks
 * ------------------------------------------------------------------ */
test('9. motion is opt-out and nothing is achieved with global overrides', () => {
    assert.match(CSS, /@media \(prefers-reduced-motion:reduce\)/, 'a reduced-motion block exists');
    assert.ok(!/html\s*\{[^}]*font-size:\s*8px/.test(CSS), 'no global font shrink');
    assert.ok(!/\.stat-value \{[^}]*!important/.test(CSS), 'figures are not force-sized');
});

/* ------------------------------------------------------------------ *
 * 10. the visual layer did not reach the money paths
 * ------------------------------------------------------------------ */
test('10. financial surfaces are untouched by the visual layer', () => {
    assert.match(INDEX, /MIN_WITHDRAWAL:\s*700/, 'the withdrawal minimum is unchanged');
    assert.match(INDEX, /MIN_DEPOSIT(=|:)\s*100|MIN_DEPOSIT_AMOUNT\s*=\s*100/, 'the deposit minimum is unchanged');
    assert.match(INDEX, /id="availableDepositBtn"[^>]*onclick="openDepositModal\(\)"/);
    assert.match(INDEX, /id="availableWithdrawBtn"[^>]*onclick="openWithdrawModal\(\)"/);
    // the new UI layer performs no requests of its own
    const layer = INDEX.slice(INDEX.indexOf('v2 UI behaviours'));
    assert.ok(!/fetch\(/.test(layer), 'the polish layer must not call an API');
    assert.ok(!/api\//.test(layer), 'the polish layer must not reference an endpoint');
    assert.ok(!/innerHTML/.test(layer), 'the polish layer must not build markup from data');
});
