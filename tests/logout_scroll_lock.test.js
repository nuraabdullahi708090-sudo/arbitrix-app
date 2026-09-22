'use strict';

/**
 * MOBILE AUTH-PAGE SCROLL LOCK AFTER LOGOUT - regression tests.
 *
 * BUG: on a phone, opening the off-canvas navigation drawer adds `.open` to
 * #sidebar. A Phase-12 CSS rule locks background scroll while the drawer is
 * open:  body:has(.sidebar.open){overflow:hidden;}.  Logout hides #mainApp with
 * display:none and reveals #authPage, but it did NOT clear that class. Because
 * the drawer node still exists (inside the now display:none #mainApp) and still
 * carries `.open`, the :has() rule kept matching, so the auth page's body stayed
 * overflow:hidden and vertical touch scrolling was dead. Desktop was unaffected
 * because the drawer is only toggled by the mobile-only hamburger.
 *
 * FIX (frontend-only): a `closeMobileNav()` helper clears `.open` from the
 * drawer + overlay, and logout (plus the app -> auth transition openAuthScreen)
 * calls it and resets `document.body.style.overflow` before showing the auth
 * page. The legitimate drawer/modal scroll-lock CSS is unchanged.
 *
 * These tests run the REAL closeMobileNav() source in a vm sandbox with a tiny
 * fake DOM (behaviour), and pin the wiring/ordering in the real logout handler
 * and the modal lock (contract). Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CSS = [...INDEX.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

function extractFunction(name) {
    const start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' must exist in public/index.html');
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, name + ' must be brace-matchable');
    return INDEX.slice(start, end + 1);
}

// The full logout click handler (from its binding to the next statement).
const LOGOUT_HANDLER = (() => {
    const start = INDEX.indexOf("const logoutLink = getEl('logoutLink');");
    assert.ok(start >= 0, 'logout binding must exist');
    const end = INDEX.indexOf("document.querySelectorAll('.sidebar-link[data-section]')", start);
    assert.ok(end > start, 'logout handler must be delimited');
    return INDEX.slice(start, end);
})();

// A minimal classList-backed element.
function makeEl(id) {
    const set = new Set(['open']);
    return {
        id,
        classList: {
            add: (c) => set.add(c),
            remove: (c) => set.delete(c),
            contains: (c) => set.has(c),
            toggle: (c) => (set.has(c) ? set.delete(c) : set.add(c)),
        },
        _set: set,
    };
}

// Mirror of the CSS rule body:has(.sidebar.open){overflow:hidden;}.
const bodyOverflowLocked = (els) =>
    els.sidebar.classList.contains('open') ? 'hidden' : 'auto';

function runCloseMobileNav(els) {
    const sandbox = {
        document: { getElementById: (id) => els[id] || null },
        console: { log: () => {}, warn: () => {}, error: () => {} },
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction('closeMobileNav') + '\ncloseMobileNav();', sandbox);
    return sandbox;
}

test('the real drawer locks background scroll only while open (baseline intact)', () => {
    const rule = CSS.match(/body:has\(\.sidebar\.open\)\s*\{\s*overflow:hidden;?\s*\}/);
    assert.ok(rule, 'the legitimate drawer scroll-lock rule must be preserved');
    const els = { sidebar: makeEl('sidebar'), sidebarOverlay: makeEl('sidebarOverlay') };
    assert.strictEqual(bodyOverflowLocked(els), 'hidden', 'open drawer locks body scroll');
});

test('closeMobileNav clears .open from the drawer and its overlay', () => {
    const els = { sidebar: makeEl('sidebar'), sidebarOverlay: makeEl('sidebarOverlay') };
    assert.ok(els.sidebar.classList.contains('open'), 'precondition: drawer open');
    assert.ok(els.sidebarOverlay.classList.contains('open'), 'precondition: overlay open');

    runCloseMobileNav(els);

    assert.strictEqual(els.sidebar.classList.contains('open'), false, 'drawer class cleared');
    assert.strictEqual(els.sidebarOverlay.classList.contains('open'), false, 'overlay class cleared');
    assert.strictEqual(bodyOverflowLocked(els), 'auto', 'stale scroll-lock released');
});

test('closeMobileNav is safe when the drawer/overlay are absent', () => {
    const els = {};
    assert.doesNotThrow(() => runCloseMobileNav(els));
});

test('logout closes the drawer BEFORE revealing the auth page', () => {
    const close = LOGOUT_HANDLER.indexOf('closeMobileNav()');
    const showAuth = LOGOUT_HANDLER.indexOf("getEl('authPage').style.display = 'flex';");
    assert.ok(close >= 0, 'logout must close the mobile drawer');
    assert.ok(showAuth >= 0, 'logout must still show the auth page');
    assert.ok(close < showAuth, 'drawer cleanup must run before the auth page is shown');
});

test('logout resets any inline body scroll-lock left by a modal', () => {
    assert.match(
        LOGOUT_HANDLER,
        /document\.body\.style\.overflow\s*=\s*'';/,
        'logout must clear a residual inline overflow lock'
    );
    // It must not blanket-disable body scrolling (only reset the inline value).
    assert.doesNotMatch(LOGOUT_HANDLER, /document\.body\.style\.overflow\s*=\s*'hidden'/);
});

test('the app -> auth transition (openAuthScreen) also releases the drawer lock', () => {
    const openAuth = extractFunction('openAuthScreen');
    assert.match(openAuth, /closeMobileNav\(\);/, 'openAuthScreen must release the drawer lock');
});

test('the auth page remains its own vertically-scrollable surface', () => {
    // .auth-page sets overflow-y:auto so the tall auth card can scroll.
    const authRule = CSS.match(/\.auth-page\s*\{[\s\S]*?\}/);
    assert.ok(authRule, '.auth-page rule must exist');
    assert.match(authRule[0], /overflow-y:\s*auto/, 'auth page must allow vertical scrolling');
    assert.match(authRule[0], /min-height:\s*100vh/, 'auth page fills at least the viewport');
});

test('legitimate modal scroll-lock is untouched and still restores on close', () => {
    const show = extractFunction('showForgotPassword');
    const close = extractFunction('closeForgotPasswordModal');
    assert.match(show, /document\.body\.style\.overflow\s*=\s*'hidden'/, 'modal locks scroll while open');
    assert.match(close, /document\.body\.style\.overflow\s*=\s*''/, 'modal restores scroll on close');
    // Other modal lock rules must remain as well.
    assert.match(CSS, /body:has\(#supportModal\.open\)\s+\.support-widget\s*\{\s*display:none;?\s*\}/);
});

test('the support widget surfaces are not affected by the drawer cleanup', () => {
    const helper = extractFunction('closeMobileNav');
    assert.doesNotMatch(helper, /supportPanel|supportModal|support-widget/);
    for (const fn of ['openSupportModal', 'closeSupportModal', 'toggleSupport']) {
        assert.ok(INDEX.includes('function ' + fn + '('), fn + ' must still exist');
    }
    assert.ok(INDEX.includes("id=\"supportPanel\""), 'support panel markup must remain');
    assert.ok(INDEX.includes('support-widget'), 'support widget CSS must remain');
});

test('the hamburger still opens/closes the drawer (behaviour preserved)', () => {
    const start = INDEX.indexOf("const mobileMenuBtn = getEl('mobileMenuBtn');");
    assert.ok(start >= 0, 'hamburger binding must exist');
    const end = INDEX.indexOf("const depositSidebarLink", start);
    const block = INDEX.slice(start, end);
    assert.match(block, /sidebar\.classList\.toggle\('open'\)/, 'hamburger toggles the drawer');
    assert.match(block, /sidebarOverlay\.classList\.toggle\('open'\)/, 'hamburger toggles the overlay');
    assert.match(block, /sidebar\.classList\.remove\('open'\)/, 'overlay tap still closes the drawer');
});
