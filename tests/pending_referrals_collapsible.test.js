'use strict';

/**
 * Pending Referrals panel - collapsible presentation (Stage 19D).
 *
 * The Referral Program page used to render every pending referral inline. It is
 * now a collapsible panel that is COLLAPSED by default, shows a compact summary
 * row (dynamic count + "Awaiting first deposit" + "Tap to view"), expands on
 * tap (same header collapses again) and shows a compact non-expandable note
 * when there are no pending referrals.
 *
 * Presentation only: referral data, eligibility/status rules, the 20% reward
 * logic, deposit thresholds and every backend API are untouched. These tests
 * run the REAL functions against a DOM stub and pin the i18n + a11y contract.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
const NEW_KEYS = [
    'referral.pending.titleCount', 'referral.pending.subtitle', 'referral.pending.tapToView',
    'referral.pending.tapToHide', 'referral.pending.empty',
    'referral.pending.a11y.expand', 'referral.pending.a11y.collapse',
];
const OLD_KEY = 'referral.pendingAwaiting';

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' must exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
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

function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

const T = loadTranslations();

/* ------------------------------------------------------------------ *
 * Runs the REAL panel functions against a DOM stub.
 * ------------------------------------------------------------------ */
function runPanel(opts) {
    const o = opts || {};
    const ids = ['pendingReferralsSection', 'pendingReferralsToggle', 'pendingReferralsList',
        'pendingReferralsEmpty', 'pendingReferralsTitle', 'pendingRefTapHint', 'pendingRefA11yState'];
    const els = {};
    ids.forEach((id) => {
        els[id] = {
            id, innerHTML: '', textContent: '', hidden: false, style: { display: '' }, attrs: {},
            setAttribute(k, v) { this.attrs[k] = String(v); },
            getAttribute(k) { return (k in this.attrs) ? this.attrs[k] : null; },
        };
    });
    // Shipped markup defaults.
    els.pendingReferralsSection.style.display = 'none';
    els.pendingReferralsToggle.style.display = 'flex';
    els.pendingReferralsToggle.attrs['aria-expanded'] = 'false';
    els.pendingReferralsList.hidden = true;
    els.pendingReferralsEmpty.style.display = 'none';

    const sandbox = {
        els,
        console: { log() {}, warn() {}, error() {} },
        document: { getElementById: (id) => els[id] || null },
        TRANSLATIONS: T,
        currentLang: o.lang || 'en',
        APP: { referralStats: { pendingReferralsList: o.pending || [] } },
    };
    if (o.open === true) sandbox.APP.referralPendingOpen = true;
    vm.createContext(sandbox);
    vm.runInContext([
        'var TRANSLATIONS = globalThis.TRANSLATIONS;',
        'const getEl = function (id) { return document.getElementById(id); };',
        extractFunction('t'),
        extractFunction('appLocale'),
        extractFunction('pendingReferralsOpen'),
        extractFunction('renderPendingReferralsList'),
        extractFunction('setPendingReferralsExpanded'),
        extractFunction('togglePendingReferrals'),
        extractFunction('updatePendingReferralsList'),
        'globalThis.__upd = updatePendingReferralsList;',
        'globalThis.__toggle = togglePendingReferrals;',
        'globalThis.__setLang = function (l) { currentLang = l; };',
    ].join('\n'), sandbox);
    return { el: (id) => els[id], els, sandbox };
}

const PENDING = [
    { name: 'Alice', joinedAt: '2026-09-01T10:00:00Z' },
    { name: 'Bob', joinedAt: '2026-09-02T10:00:00Z' },
];

/* ------------------------------------------------------------------ *
 * 1. Markup + accessibility contract
 * ------------------------------------------------------------------ */
test('markup: the summary row is a real button with aria-expanded/aria-controls', () => {
    assert.ok(/<button[^>]*id="pendingReferralsToggle"/.test(INDEX), 'summary row must be a <button>');
    assert.ok(INDEX.includes('aria-expanded="false"'), 'shipped collapsed');
    assert.ok(INDEX.includes('aria-controls="pendingReferralsList"'), 'controls the list');
    assert.ok(INDEX.includes('aria-label="keep"') === false, 'no unrelated aria-label');
    assert.ok(INDEX.includes('onclick="togglePendingReferrals()"'), 'tap/click wired to the toggle');
});

test('markup: the list is hidden by default and there is a compact empty note', () => {
    assert.ok(/id="pendingReferralsList"[^>]*hidden/.test(INDEX), 'list starts hidden');
    assert.ok(INDEX.includes('id="pendingReferralsEmpty"'), 'empty state element exists');
    assert.ok(/<div id="pendingReferralsEmpty"[^>]*data-i18n="referral\.pending\.empty"/.test(INDEX),
        'empty note is localized');
});

test('a11y: dynamic elements are not data-i18n targets (so translations cannot clobber them)', () => {
    ['pendingReferralsTitle', 'pendingRefTapHint', 'pendingRefA11yState'].forEach((id) => {
        const re = new RegExp('id="' + id + '"[^>]*data-i18n');
        assert.ok(!re.test(INDEX), id + ' must be JS-owned, not data-i18n');
    });
    assert.ok(INDEX.includes('aria-hidden="true"') && /pending-ref-chevron[^>]*aria-hidden|aria-hidden[^>]*pending-ref-chevron/.test(INDEX),
        'chevron is decorative for screen readers');
});

/* ------------------------------------------------------------------ *
 * 2. Default state / expand / collapse
 * ------------------------------------------------------------------ */
test('collapsed by default with pending referrals, showing the dynamic count', () => {
    const p = runPanel({ pending: PENDING });
    p.sandbox.__upd();
    assert.strictEqual(p.el('pendingReferralsToggle').attrs['aria-expanded'], 'false', 'collapsed on load');
    assert.strictEqual(p.el('pendingReferralsList').hidden, true, 'names hidden on load');
    assert.strictEqual(p.el('pendingReferralsTitle').textContent, 'Pending Referrals (2)', 'dynamic count');
    assert.strictEqual(p.el('pendingRefTapHint').textContent, 'Tap to view');
    assert.strictEqual(p.el('pendingRefA11yState').textContent, 'Expand pending referrals');
    assert.strictEqual(p.el('pendingReferralsSection').style.display, 'block');
    assert.ok(p.el('pendingReferralsList').innerHTML.includes('Alice') && p.el('pendingReferralsList').innerHTML.includes('Bob'),
        'names are rendered (hidden)');
    assert.ok(p.el('pendingReferralsList').innerHTML.includes(T.en['referral.awaitingDeposit']), 'awaiting-deposit status kept');
});

test('tapping the header expands the names', () => {
    const p = runPanel({ pending: PENDING });
    p.sandbox.__upd();
    p.sandbox.__toggle();
    assert.strictEqual(p.el('pendingReferralsToggle').attrs['aria-expanded'], 'true');
    assert.strictEqual(p.el('pendingReferralsList').hidden, false, 'names shown');
    assert.strictEqual(p.el('pendingRefTapHint').textContent, 'Tap to hide');
    assert.strictEqual(p.el('pendingRefA11yState').textContent, 'Collapse pending referrals');
});

test('tapping the same header again collapses the names', () => {
    const p = runPanel({ pending: PENDING });
    p.sandbox.__upd();
    p.sandbox.__toggle();
    p.sandbox.__toggle();
    assert.strictEqual(p.el('pendingReferralsToggle').attrs['aria-expanded'], 'false');
    assert.strictEqual(p.el('pendingReferralsList').hidden, true);
    assert.strictEqual(p.el('pendingRefTapHint').textContent, 'Tap to view');
});

test('the count is dynamic (0, 1, 3) and never hardcoded', () => {
    [[0, 'Pending Referrals (0)'], [1, 'Pending Referrals (1)'], [3, 'Pending Referrals (3)']].forEach(([n, expected]) => {
        const p = runPanel({ pending: new Array(n).fill({ name: 'X' }) });
        p.sandbox.__upd();
        assert.strictEqual(p.el('pendingReferralsTitle').textContent, expected);
    });
    assert.ok(!/\bPending Referrals \(2\)/.test(INDEX.replace(/style="[^"]*"/g, '')), 'the literal count 2 is not hardcoded in markup');
});

/* ------------------------------------------------------------------ *
 * 3. Empty state
 * ------------------------------------------------------------------ */
test('with no pending referrals the panel is compact and non-expandable', () => {
    const p = runPanel({ pending: [] });
    p.sandbox.__upd();
    assert.strictEqual(p.el('pendingReferralsToggle').style.display, 'none', 'no summary row to expand');
    assert.strictEqual(p.el('pendingReferralsToggle').attrs['aria-expanded'], 'false');
    assert.strictEqual(p.el('pendingReferralsList').hidden, true);
    assert.strictEqual(p.el('pendingReferralsList').innerHTML, '', 'no rows rendered');
    assert.strictEqual(p.el('pendingReferralsEmpty').style.display, 'block', 'compact message shown');
    assert.strictEqual(p.el('pendingReferralsTitle').textContent, 'Pending Referrals (0)');
});

test('the empty state does not create an expandable panel', () => {
    const p = runPanel({ pending: [] });
    p.sandbox.__upd();
    p.sandbox.__toggle(); // nothing to expand
    assert.strictEqual(p.el('pendingReferralsList').hidden, true, 'still no list');
    assert.strictEqual(p.el('pendingReferralsToggle').style.display, 'none');
});

/* ------------------------------------------------------------------ *
 * 4. Re-render / refresh / language switch must not expand it
 * ------------------------------------------------------------------ */
test('a data refresh does not expand the panel (stays collapsed by default)', () => {
    const p = runPanel({ pending: PENDING });
    p.sandbox.__upd();
    p.sandbox.__upd(); // refresh with the same data
    p.sandbox.__upd();
    assert.strictEqual(p.el('pendingReferralsToggle').attrs['aria-expanded'], 'false');
    assert.strictEqual(p.el('pendingReferralsList').hidden, true);
});

test('a refresh preserves the users choice (expanded stays expanded, never forced either way)', () => {
    const p = runPanel({ pending: PENDING });
    p.sandbox.__upd();
    p.sandbox.__toggle();
    p.sandbox.__upd();
    assert.strictEqual(p.el('pendingReferralsToggle').attrs['aria-expanded'], 'true', 'no forced collapse');
    assert.strictEqual(p.el('pendingReferralsList').hidden, false);
});

test('a language switch translates the labels without changing the collapsed state', () => {
    const p = runPanel({ pending: PENDING, lang: 'en' });
    p.sandbox.__upd();
    p.sandbox.__setLang('es');
    p.sandbox.__upd(); // what the updateDynamicTranslations hook does
    assert.strictEqual(p.el('pendingReferralsTitle').textContent, 'Referidos pendientes (2)');
    assert.strictEqual(p.el('pendingRefTapHint').textContent, 'Toca para ver');
    assert.strictEqual(p.el('pendingReferralsToggle').attrs['aria-expanded'], 'false', 'still collapsed');
    assert.strictEqual(p.el('pendingReferralsList').hidden, true, 'names still hidden');
});

test('a language switch keeps an expanded panel expanded and re-translates the hint', () => {
    const p = runPanel({ pending: PENDING, lang: 'en' });
    p.sandbox.__upd();
    p.sandbox.__toggle();
    p.sandbox.__setLang('ar');
    p.sandbox.__upd();
    assert.strictEqual(p.el('pendingReferralsToggle').attrs['aria-expanded'], 'true');
    assert.strictEqual(p.el('pendingRefTapHint').textContent, T.ar['referral.pending.tapToHide']);
    assert.strictEqual(p.el('pendingRefA11yState').textContent, T.ar['referral.pending.a11y.collapse']);
});

test('every locale renders the panel with no raw keys', () => {
    LANGS.forEach((lang) => {
        const p = runPanel({ pending: PENDING, lang });
        p.sandbox.__upd();
        p.sandbox.__toggle();
        const texts = [p.el('pendingReferralsTitle').textContent, p.el('pendingRefTapHint').textContent, p.el('pendingRefA11yState').textContent].join(' ');
        assert.ok(!/referral\.pending/.test(texts), lang + ' must not show a raw key');
        assert.ok(p.el('pendingReferralsTitle').textContent.includes('2'), lang + ' count rendered');
        assert.strictEqual(p.el('pendingReferralsList').innerHTML.length > 0, true);
    });
});

/* ------------------------------------------------------------------ *
 * 5. i18n contract
 * ------------------------------------------------------------------ */
test('the new keys exist and are non-empty in all 6 locales (identical key sets)', () => {
    assert.strictEqual(new Set(LANGS.map((l) => Object.keys(T[l]).sort().join('|'))).size, 1, 'key sets identical');
    assert.strictEqual(Object.keys(T.en).length, 1403, 'dictionary size pinned');
    LANGS.forEach((l) => NEW_KEYS.forEach((k) => assert.ok(typeof T[l][k] === 'string' && T[l][k].trim(), l + '.' + k + ' must be non-empty')));
    LANGS.forEach((l) => assert.ok(!(OLD_KEY in T[l]), 'the obsolete header key is gone from ' + l));
});

test('placeholder parity for the count label', () => {
    LANGS.forEach((l) => assert.strictEqual(T[l]['referral.pending.titleCount'].includes('{{count}}'), true,
        l + ' must keep the {{count}} placeholder'));
    assert.strictEqual(T.en['referral.pending.titleCount'], 'Pending Referrals ({{count}})');
});

test('the summary labels are the requested copy (EN)', () => {
    assert.strictEqual(T.en['referral.pending.titleCount'], 'Pending Referrals ({{count}})');
    assert.strictEqual(T.en['referral.pending.subtitle'], 'Awaiting first deposit');
    assert.strictEqual(T.en['referral.pending.tapToView'], 'Tap to view');
    assert.strictEqual(T.en['referral.pending.empty'], 'No pending referrals awaiting deposit.');
    assert.ok(/expand/i.test(T.en['referral.pending.a11y.expand']) && /collapse/i.test(T.en['referral.pending.a11y.collapse']));
});

/* ------------------------------------------------------------------ *
 * 6. Preserved behaviour + untouched referral logic
 * ------------------------------------------------------------------ */
test('the rest of the referral program is preserved (active, earned, copy/share)', () => {
    ['refActiveCount', 'refPendingCount', 'refTotalEarned', 'referralCodeDisplay', 'referralLinkDisplay',
        'copyReferralBtn', 'copyReferralLinkBtn', 'shareReferralBtn'].forEach((id) => {
        assert.ok(INDEX.includes('id="' + id + '"'), id + ' must still exist');
    });
    assert.ok(INDEX.includes("'referral.awaitingDeposit'"), 'awaiting-deposit label kept');
});

test('the panel is presentation only: it never mutates referral data or calls an API', () => {
    const fn = extractFunction('updatePendingReferralsList') + extractFunction('togglePendingReferrals') + extractFunction('renderPendingReferralsList');
    assert.ok(!/referralStats\s*\.\s*pendingReferralsList\s*=/.test(fn), 'must not write referral data');
    assert.ok(!/fetch\(|await\s/.test(fn), 'no API access in the presentation layer');
    assert.ok(!/status|reward|deposit\s*[<>=]/i.test(fn.replace(/\/\/[^\n]*/g, '')), 'no eligibility/reward logic');
    assert.ok(INDEX.includes('pendingReferralsList: (data.referrals || [])'), 'the API mapping is unchanged');
});

test('the open/closed state lives in APP, so a re-render cannot lose or force it', () => {
    assert.ok(INDEX.includes('function pendingReferralsOpen() { return APP.referralPendingOpen === true; }'),
        'single source of the open state, defaulting to collapsed');
    assert.ok(INDEX.includes('APP.referralPendingOpen = !pendingReferralsOpen();'), 'only the tap flips it');
});

test('the panel is refreshed on language switch (hooked after the static i18n pass)', () => {
    assert.ok(INDEX.includes("if (typeof updatePendingReferralsList === 'function') updatePendingReferralsList();"),
        'updateDynamicTranslations must re-render the dynamic labels');
    const hookIdx = INDEX.indexOf("typeof updatePendingReferralsList === 'function'");
    const startIdx = INDEX.indexOf("if (typeof updateStartHere === 'function') updateStartHere();");
    assert.ok(startIdx > 0 && hookIdx > startIdx, 'hook sits with the other dynamic re-render hooks');
});

/* ------------------------------------------------------------------ *
 * 7. CSS / mobile
 * ------------------------------------------------------------------ */
test('CSS gives the row a large tap target, a chevron state and overflow safety', () => {
    assert.ok(/\.pending-ref-toggle\{[^}]*min-height:56px/.test(INDEX), 'large tap target');
    assert.ok(/\.pending-ref-toggle\{[^}]*width:100%/.test(INDEX), 'full-width row (easy tapping)');
    assert.ok(/\.pending-ref-toggle\[aria-expanded="true"\] \.pending-ref-chevron\{transform:rotate\(180deg\);?\}/.test(INDEX),
        'chevron shows expanded/collapsed');
    assert.ok(/\.pending-ref-title\{[^}]*overflow-wrap:anywhere/.test(INDEX), 'long names/labels cannot overflow');
    assert.ok(/\.pending-ref-toggle:focus-visible\{/.test(INDEX), 'visible keyboard focus');
    assert.ok(/\.pending-ref-a11y\{[^}]*clip:rect/.test(INDEX), 'screen-reader-only label utility exists');
});
