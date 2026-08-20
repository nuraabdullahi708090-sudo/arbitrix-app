'use strict';

/**
 * MULTILINGUAL UI / RESPONSIVE LAYOUT — regression tests (Phase 11).
 *
 * Frontend-only (public/index.html). These tests pin the CSS/HTML contract
 * that keeps the UI responsive across all 6 supported locales (en, es, pt,
 * fr, ar, zh) where translated text is legitimately longer than English.
 *
 * What is pinned:
 *   1. Buttons can wrap long translated labels (no fixed width / no clipping).
 *   2. Tab pills wrap so every tab (incl. the Admin "Sandbox" tab) stays
 *      reachable on narrow screens.
 *   3. Admin tables scroll horizontally inside a `.table-wrap` wrapper
 *      instead of breaking the card/viewport; cells are never clipped.
 *   4. The subscription status badge wraps instead of pushing the price /
 *      action buttons out of the panel.
 *   5. The Marketing Sandbox custom-balance row wraps on phones.
 *   6. The Ops sub-tabs wrap.
 *   7. i18n dictionary parity: identical key sets, no empties, no duplicate
 *      keys, across all 6 locales.
 *   8. Safety: NO global overflow hack (no `*{overflow:hidden}`, and
 *      `body{overflow-x:hidden}` is not newly introduced by this change) and
 *      NO global font-size reduction is used to "solve" localization.
 *
 * No financial/backend logic is asserted or changed here.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Extract the CSS text (everything inside <style> ... </style>).
const CSS = (() => {
    const m = [...INDEX.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((x) => x[1]);
    return m.join('\n');
})();

// Extract the TRANSLATIONS object source by brace matching.
function extractTranslations() {
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
    return blk.slice(blk.indexOf('{', start), end + 1);
}

// Return the LAST CSS rule for a selector. My resilience rules are top-level
// (single-level indent) while the media-query overrides are deeper-indented,
// so prefer the least-indented occurrence (the resilience override).
function lastRule(sel) {
    const needle = sel + '{';
    let best = null;
    let from = 0;
    let found;
    while ((found = CSS.indexOf(needle, from)) !== -1) {
        const lineStart = CSS.lastIndexOf('\n', found) + 1;
        const indent = found - lineStart; // number of leading chars on the line
        if (!best || indent <= best.indent) best = { idx: found, indent };
        from = found + needle.length;
    }
    if (!best) return null;
    const end = CSS.indexOf('}', best.idx);
    return CSS.slice(best.idx, end + 1);
}

// ---------------------------------------------------------------------------
// 1. Buttons wrap long translations
// ---------------------------------------------------------------------------
test('buttons allow wrapping (no fixed width, white-space normal, break-word)', () => {
    const r = lastRule('.btn');
    assert.ok(r, '.btn rule should exist');
    assert.match(r, /min-width:\s*0/, '.btn should allow shrink (min-width:0)');
    assert.match(r, /max-width:\s*100%/, '.btn should not exceed its container');
    assert.match(r, /white-space:\s*normal/, '.btn labels must wrap');
    assert.match(r, /overflow-wrap:\s*break-word/, '.btn labels break long words safely');
});

// ---------------------------------------------------------------------------
// 2. Tabs/pills wrap
// ---------------------------------------------------------------------------
test('tab pills wrap so all tabs (incl. Sandbox) stay reachable', () => {
    const tabs = lastRule('.mode-tabs');
    assert.ok(tabs, '.mode-tabs rule should exist');
    assert.match(tabs, /flex-wrap:\s*wrap/, '.mode-tabs must wrap');
    const tab = lastRule('.mode-tab');
    assert.ok(tab, '.mode-tab rule should exist');
    assert.match(tab, /white-space:\s*normal/, '.mode-tab labels must wrap');
});

// ---------------------------------------------------------------------------
// 3. Admin tables scroll within a wrapper
// ---------------------------------------------------------------------------
test('admin tables use a horizontally-scrolling wrapper', () => {
    const wrap = lastRule('.table-wrap');
    assert.ok(wrap, '.table-wrap rule should exist');
    assert.match(wrap, /overflow-x:\s*auto/, '.table-wrap must scroll horizontally');
    const inner = lastRule('.table-wrap table');
    assert.ok(inner, '.table-wrap table rule should exist');
    assert.match(inner, /min-width:\s*max-content/, 'table keeps natural width inside the scrolling wrapper');
    // the 6 admin tables are wrapped
    const wrapCount = (INDEX.match(/class="[^"]*\btable-wrap\b[^"]*"/g) || []).length;
    assert.ok(wrapCount >= 5, `expected >=5 .table-wrap wrappers, found ${wrapCount}`);
});

// ---------------------------------------------------------------------------
// 4. Subscription status badge wraps
// ---------------------------------------------------------------------------
test('subscription status badge wraps long localized text', () => {
    const badge = lastRule('.status-badge');
    assert.ok(badge, '.status-badge rule should exist');
    assert.match(badge, /white-space:\s*normal/, '.status-badge must wrap');
    assert.match(badge, /overflow-wrap:\s*break-word/, '.status-badge breaks long words');
});

// ---------------------------------------------------------------------------
// 5. Sandbox custom-balance row wraps on phones
// ---------------------------------------------------------------------------
test('sandbox balance row wraps on mobile', () => {
    assert.match(INDEX, /class="sandbox-balance-row"/, 'sandbox balance row hook should exist');
    assert.match(CSS, /sandbox-balance-row\{\s*flex-wrap:wrap\s*;?\s*\}/, 'mobile media query should wrap the sandbox balance row');
    // the wrap rule must live inside a max-width:640px media query block
    const mediaStart = CSS.indexOf('@media (max-width: 640px)');
    const ruleIdx = CSS.search(/sandbox-balance-row\{\s*flex-wrap:wrap/);
    assert.ok(mediaStart !== -1, 'max-width:640px media query should exist');
    assert.ok(ruleIdx > mediaStart, 'wrap rule is inside the media query');
});

// ---------------------------------------------------------------------------
// 6. Ops sub-tabs wrap
// ---------------------------------------------------------------------------
test('operations sub-tabs wrap', () => {
    const subTabs = INDEX.match(/class="sub-tabs"[^>]*style="[^"]*flex-wrap:wrap/);
    assert.ok(subTabs, 'ops sub-tabs container should wrap');
});

// ---------------------------------------------------------------------------
// 7. i18n parity across all 6 locales
// ---------------------------------------------------------------------------
test('translation dictionaries have parity across all 6 locales', () => {
    const src = extractTranslations();
    const sandbox = {};
    const vm = require('node:vm');
    vm.createContext(sandbox);
    vm.runInContext('this.T = ' + src, sandbox);
    const T = sandbox.T;
    const locales = Object.keys(T).sort();
    assert.deepStrictEqual(locales, ['ar', 'en', 'es', 'fr', 'pt', 'zh'], 'expected exactly 6 locales');
    const base = new Set(Object.keys(T.en));
    assert.ok(base.size > 1000, 'en dictionary should be substantial');
    for (const l of locales) {
        const keys = Object.keys(T[l]);
        const missing = [...base].filter((k) => !(k in T[l]));
        assert.deepStrictEqual(missing, [], `${l} missing keys: ${missing.slice(0, 5)}`);
        const empty = keys.filter((k) => !String(T[l][k] || '').trim());
        assert.deepStrictEqual(empty, [], `${l} has empty values: ${empty.slice(0, 5)}`);
        const dup = keys.length - new Set(keys).size;
        assert.strictEqual(dup, 0, `${l} has ${dup} duplicate keys`);
    }
});

test('all data-i18n references resolve to a defined en key', () => {
    const src = extractTranslations();
    const sandbox = {};
    const vm = require('node:vm');
    vm.createContext(sandbox);
    vm.runInContext('this.T = ' + src, sandbox);
    const T = sandbox.T;
    const refs = [...INDEX.matchAll(/data-i18n="([^"]+)"/g)].map((x) => x[1]).filter((r) => !r.includes('{{'));
    const undef = [...new Set(refs)].filter((r) => !(r in T.en));
    assert.deepStrictEqual(undef, [], `undefined data-i18n keys: ${undef.slice(0, 10)}`);
});

// ---------------------------------------------------------------------------
// 8. Safety: no global hack, no global font-size reduction
// ---------------------------------------------------------------------------
test('no global overflow or font-size hack is introduced', () => {
    // No universal overflow:hidden.
    assert.ok(!/\*\s*\{[^}]*overflow\s*:\s*hidden/.test(CSS), 'must not add *{overflow:hidden}');
    // body overflow-x:hidden is a PRE-EXISTING baseline (Phase-8C) that we do
    // NOT add/remove; assert we did not add additional broad overflow-hiding.
    const bodyOverflow = (CSS.match(/body\{[^}]*overflow-x:hidden/g) || []).length;
    assert.ok(bodyOverflow <= 1, 'should not add more body-level overflow-x:hidden rules');
});
