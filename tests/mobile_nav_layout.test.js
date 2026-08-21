'use strict';

/**
 * MOBILE NAVIGATION + HEADER/DASHBOARD LAYOUT — regression tests (Phase 12).
 *
 * Frontend-only (public/index.html). These tests pin the CSS/HTML contract
 * for the mobile navigation drawer, the app header density, and the
 * MARKETING DEMO badge across Production and MARKETING_SANDBOX (both share
 * the same app shell) in all 6 locales.
 *
 * What is pinned:
 *   1. The drawer width is viewport-capped (260px base + max-width:78vw) so
 *      it never covers almost the whole viewport on small phones, stays
 *      scrollable (overflow-y:auto), fixed, and above the overlay.
 *   2. Drawer-open state locks background scroll and hides the hamburger
 *      (which otherwise renders on top of the open drawer) via :has() rules
 *      that cannot go stale.
 *   3. The MARKETING DEMO badge remains present/wired in all 6 locales and
 *      is mirrored to the physical left in RTL so it cannot overlap the
 *      hamburger.
 *   4. Mobile header/ticker spacing is compacted in a max-width:640px block
 *      that comes AFTER the base rules (cascade), and .app-header has NO
 *      fixed height.
 *   5. Desktop layout rules (>=640px / >=1024px sidebar) are intact.
 *   6. i18n parity: identical key sets, no empties, no duplicate keys across
 *      all 6 locales.
 *   7. Safety: no global overflow hack; no financial/backend logic touched.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const CSS = (() => {
    const m = [...INDEX.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((x) => x[1]);
    return m.join('\n');
})();

// Return the LAST top-level (least-indented) CSS rule for a selector.
function lastRule(sel) {
    const needle = sel + '{';
    let best = null;
    let from = 0;
    let found;
    while ((found = CSS.indexOf(needle, from)) !== -1) {
        const lineStart = CSS.lastIndexOf('\n', found) + 1;
        const indent = found - lineStart;
        if (!best || indent <= best.indent) best = { idx: found, indent };
        from = found + needle.length;
    }
    if (!best) return null;
    const end = CSS.indexOf('}', best.idx);
    return CSS.slice(best.idx, end + 1);
}

// Extract and eval the TRANSLATIONS object (trusted local source).
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
    const src = blk.slice(blk.indexOf('{', start), end + 1);
    // eslint-disable-next-line no-eval
    return eval('(' + src + ')');
}

// ---------------------------------------------------------------------------
// 1. Drawer width / positioning / scrollability
// ---------------------------------------------------------------------------
test('drawer is viewport-capped, fixed, scrollable, above the overlay', () => {
    const r = lastRule('.sidebar');
    assert.ok(r, '.sidebar rule should exist');
    assert.match(r, /position:\s*fixed/, 'drawer is fixed');
    assert.match(r, /width:\s*260px/, 'drawer base width stays 260px');
    assert.match(r, /max-width:\s*78vw/, 'drawer width is capped to 78vw so a share of the dashboard stays visible on small phones');
    assert.match(r, /overflow-y:\s*auto/, 'drawer scrolls internally');
    assert.match(r, /z-index:\s*1000/, 'drawer sits above the overlay (999)');
    const overlay = lastRule('.sidebar-overlay');
    assert.ok(overlay, '.sidebar-overlay rule should exist');
    assert.match(overlay, /z-index:\s*999/, 'overlay z-index below the drawer');
    assert.match(overlay, /rgba\(0,0,0,0\.6\)/, 'overlay dims the background');
});

test('closed drawer does not create page horizontal overflow (off-canvas transform only)', () => {
    const r = lastRule('.sidebar');
    assert.match(r, /transform:\s*translateX\(-100%\)/, 'closed drawer is translated off-canvas (no layout overflow)');
    const open = lastRule('.sidebar.open');
    assert.ok(open, '.sidebar.open rule should exist');
    assert.match(open, /transform:\s*translateX\(0\)/, 'open drawer slides to 0');
});

// ---------------------------------------------------------------------------
// 2. Drawer-open state: scroll lock + hamburger hidden
// ---------------------------------------------------------------------------
test('open drawer locks background scroll via :has() (cannot go stale)', () => {
    assert.match(CSS, /body:has\(\.sidebar\.open\)\{overflow:\s*hidden/, 'body scroll lock rule missing');
});

test('hamburger is hidden while the drawer is open (no overlap with drawer brand)', () => {
    assert.match(CSS, /body:has\(\.sidebar\.open\)\s+\.mobile-menu-btn\{opacity:\s*0;pointer-events:\s*none/, 'hamburger hide-while-open rule missing');
    const btn = lastRule('.mobile-menu-btn');
    assert.ok(btn, '.mobile-menu-btn rule should exist');
    assert.match(btn, /min-width:\s*44px/, 'hamburger keeps a 44px touch target');
    assert.match(btn, /min-height:\s*44px/, 'hamburger keeps a 44px touch target');
});

// ---------------------------------------------------------------------------
// 3. MARKETING DEMO badge: present in all locales + RTL-safe
// ---------------------------------------------------------------------------
test('sandbox badge element + i18n wiring are intact (badge must remain visible)', () => {
    assert.match(INDEX, /id="sandboxBadge"/, 'badge element must exist');
    assert.match(INDEX, /t\('sandbox\.badge'\)/, 'badge text must come from t(\'sandbox.badge\')');
    assert.match(INDEX, /APP\.environment === 'MARKETING_SANDBOX' && !APP\.sandboxBadgeHidden/, 'badge visibility logic unchanged');
});

test('badge is mirrored to the physical left in RTL (no hamburger overlap)', () => {
    assert.match(CSS, /html\[dir="rtl"\] #sandboxBadge\{right:\s*auto !important;left:\s*12px !important;/, 'RTL badge override missing');
});

test('sandbox.badge key exists + non-empty in all 6 locales', () => {
    const T = loadTranslations();
    for (const lang of ['en', 'es', 'pt', 'fr', 'ar', 'zh']) {
        assert.ok(T[lang], `locale ${lang} exists`);
        assert.ok(typeof T[lang]['sandbox.badge'] === 'string' && T[lang]['sandbox.badge'].length > 0, `sandbox.badge non-empty in ${lang}`);
    }
});

// ---------------------------------------------------------------------------
// 4. Header density: compaction block after base rules; no fixed height
// ---------------------------------------------------------------------------
test('.app-header has NO fixed height (content-driven, wraps safely)', () => {
    const r = lastRule('.app-header');
    assert.ok(r, '.app-header rule should exist');
    assert.doesNotMatch(r, /(^|[;{])\s*height\s*:/, '.app-header must not use a fixed height');
    assert.match(r, /flex-wrap:\s*wrap/, 'header may wrap on narrow screens');
});

test('mobile header/ticker compaction exists and is placed after the base rules', () => {
    const blockRe = /@media \(max-width: 640px\) \{\s*\.app-header\{gap:8px;margin-bottom:12px;\}\s*\.ticker-wrapper\{margin-bottom:10px;\}\s*\}/;
    const m = CSS.match(blockRe);
    assert.ok(m, 'compaction media block missing or values changed');
    const baseIdx = CSS.indexOf('.app-header{display:flex');
    assert.ok(baseIdx !== -1, 'base .app-header rule exists');
    assert.ok(m.index > baseIdx, 'compaction block must come AFTER the base .app-header rule (cascade)');
    // desktop breakpoint still resets header padding
    assert.match(CSS, /@media\(min-width:640px\)\{[\s\S]*?\.app-header\{padding-top:0;\}/, 'desktop header reset intact');
});

test('mobile header keeps hamburger clearance (padding-top) instead of a fixed height', () => {
    const r = lastRule('.app-header');
    assert.match(r, /padding-top:\s*44px/, 'header clears the fixed 44px hamburger on mobile');
});

// ---------------------------------------------------------------------------
// 5. Desktop layout intact
// ---------------------------------------------------------------------------
test('desktop sidebar + main-content offsets are unchanged', () => {
    assert.match(CSS, /@media\(min-width:640px\)\{[\s\S]*?\.sidebar\{transform:translateX\(0\);width:220px;\}/, '>=640px sidebar rule intact');
    assert.match(CSS, /@media\(min-width:640px\)\{[\s\S]*?\.main-content\{margin-left:220px/, '>=640px main-content offset intact');
    assert.match(CSS, /@media\(min-width:1024px\)\{[\s\S]*?\.sidebar\{width:240px;\}/, '>=1024px sidebar rule intact');
    assert.match(CSS, /@media\(min-width:1024px\)\{[\s\S]*?\.main-content\{margin-left:240px/, '>=1024px main-content offset intact');
    // hamburger hidden on desktop
    assert.match(CSS, /@media\(min-width:640px\)\{[\s\S]*?\.mobile-menu-btn\{display:none;\}/, 'hamburger hidden on desktop');
});

// ---------------------------------------------------------------------------
// 6. i18n parity across all 6 locales
// ---------------------------------------------------------------------------
test('i18n dictionaries: identical key sets, no empties, no duplicate keys', () => {
    const T = loadTranslations();
    const langs = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
    const enKeys = Object.keys(T.en).sort();
    for (const lang of langs) {
        const keys = Object.keys(T[lang]).sort();
        assert.deepStrictEqual(keys, enKeys, `${lang} key set must match en`);
        for (const k of keys) {
            assert.ok(typeof T[lang][k] === 'string' && T[lang][k].length > 0, `${lang}.${k} must be non-empty`);
        }
    }
    // duplicate keys would be silently overwritten by eval; detect on raw text
    const blocks = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const blk = blocks.find((b) => b.includes('const TRANSLATIONS'));
    // Bound detection to the TRANSLATIONS object span (the last locale's segment
    // must not run past the object into e.g. BACKEND_MESSAGE_MAP).
    let objEnd = blk.length;
    {
        let i = blk.indexOf('{', blk.indexOf('const TRANSLATIONS'));
        let depth = 0;
        for (; i < blk.length; i++) {
            if (blk[i] === '{') depth++;
            else if (blk[i] === '}') { depth--; if (depth === 0) { objEnd = i; break; } }
        }
    }
    for (const lang of langs) {
        const langStart = blk.indexOf(`    ${lang}: {`);
        assert.ok(langStart !== -1, `${lang} dict exists`);
        let next = objEnd;
        for (const other of langs) {
            if (other === lang) continue;
            const idx = blk.indexOf(`    ${other}: {`, langStart + 1);
            if (idx !== -1 && idx < next) next = idx;
        }
        const seg = blk.slice(langStart, next);
        const rawKeys = [...seg.matchAll(/^\s*'([^']+)':/gm)].map((x) => x[1]);
        const seen = new Set();
        const dups = rawKeys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
        // Known PRE-EXISTING baseline duplicates (landing.howItWorks.* and
        // landing.faq.tag/title, identical across the baseline; documented in
        // AGENTS.md). Assert no NEW duplicates appear beyond that documented set.
        const KNOWN_BASELINE_DUP_PREFIXES = ['landing.howItWorks.', 'landing.faq.tag', 'landing.faq.title'];
        const newDups = dups.filter((k) => !KNOWN_BASELINE_DUP_PREFIXES.some((p) => k.startsWith(p)));
        assert.deepStrictEqual(newDups, [], `${lang} must have no NEW duplicate keys: ${newDups.slice(0, 5).join(',')}`);
    }
});

// ---------------------------------------------------------------------------
// 7. Safety: no global overflow hack; drawer never display:none'd by these rules
// ---------------------------------------------------------------------------
test('no global overflow hack and drawer content never hidden', () => {
    assert.doesNotMatch(CSS, /\*\s*\{[^}]*overflow:\s*hidden/, 'no universal overflow:hidden hack');
    const r = lastRule('.sidebar');
    assert.doesNotMatch(r, /display:\s*none/, 'drawer must not be display:none');
});

test('sidebar navigation structure intact (links + overlay + toggle wiring)', () => {
    const linkCount = (INDEX.match(/class="sidebar-link/g) || []).length;
    assert.ok(linkCount >= 10, `expected >=10 sidebar links, found ${linkCount}`);
    assert.match(INDEX, /id="sidebarOverlay"/, 'overlay element exists');
    assert.match(INDEX, /sidebar\.classList\.toggle\('open'\)/, 'hamburger toggle wiring intact');
    assert.match(INDEX, /sidebarOverlay\.addEventListener\('click'/, 'overlay-click close wiring intact');
});
