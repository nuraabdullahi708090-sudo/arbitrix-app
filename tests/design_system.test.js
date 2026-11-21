'use strict';

/**
 * DESIGN SYSTEM — regression pins for the Kalderix redesign.
 *
 * Frontend-only. These tests protect the design system itself and the two
 * structural defects the redesign fixed, so neither can silently come back:
 *
 *   1. Every <style> block is brace-balanced. An unclosed rule swallows the
 *      rest of its stylesheet: `.landing-hero-promo {` was missing its closing
 *      brace, which silently disabled the landing page's mobile rules and the
 *      hamburger navigation.
 *   2. The design-system layer exists, is loaded last, and keeps the accent
 *      colour and its RGB triplet in sync (the triplet was gold while the
 *      accent was violet, so every translucent brand surface had the wrong hue).
 *   3. A readable type floor: no visible label in the app shell renders below
 *      11px, and the legacy 9/10px inline sizes are lifted to 12px.
 *   4. One control geometry: buttons and inputs are at least 44px tall, with a
 *      single small-button exception (36px) for dense rows.
 *   5. The referral page keeps its required hierarchy and every id that the
 *      scripts and the existing tests depend on.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const styles = [...INDEX.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)].map((m) => ({
    attrs: m[1] || '',
    css: m[2],
}));
const DS = styles.find((s) => s.attrs.includes('kx-design-system'));
const ALL = styles.map((s) => s.css).join('\n');

test('1. every stylesheet is brace-balanced (an unclosed rule dark-renders the rest)', () => {
    styles.forEach((sheet, i) => {
        const opens = (sheet.css.match(/{/g) || []).length;
        const closes = (sheet.css.match(/}/g) || []).length;
        assert.strictEqual(opens, closes, `style block #${i + 1} is unbalanced (${opens} { vs ${closes} })`);
    });
    // The specific rule whose missing brace disabled the landing responsive CSS.
    assert.ok(/\.landing-hero-promo \{[\s\S]*?overflow-wrap: anywhere;\s*\}/.test(ALL),
        '.landing-hero-promo is closed (its rules must not swallow the sheet)');
});

test('2. the landing hamburger + mobile rules are reachable (768px block intact)', () => {
    const block = ALL.slice(ALL.indexOf('@media (max-width: 768px) {'));
    assert.ok(/\.landing-mobile-menu-btn \{\s*display: block;/.test(block),
        'the hamburger is shown below 768px');
    assert.ok(/\.landing-nav-actions \{\s*display: none;/.test(block),
        'the desktop nav actions collapse into the menu');
});

test('3. the design system loads after the page sheets and defines the token set', () => {
    assert.ok(DS, 'a <style id="kx-design-system"> block exists');
    assert.ok(INDEX.indexOf('kx-design-system') > INDEX.indexOf('.landing-hero-promo'),
        'the design system is the last sheet, so it wins the cascade');
    ['--kx-bg', '--kx-surface', '--kx-surface-2', '--kx-border', '--kx-accent', '--kx-text',
        '--kx-text-2', '--kx-text-3', '--kx-success', '--kx-warning', '--kx-danger',
        '--kx-r', '--kx-r-lg', '--kx-fs-base', '--kx-shadow', '--kx-ring'].forEach((token) => {
        assert.ok(DS.css.includes(token + ':'), `token ${token} is defined`);
    });
});

test('4. the accent and its RGB triplet stay in sync', () => {
    const root = INDEX.slice(INDEX.indexOf(':root{'), INDEX.indexOf('}', INDEX.indexOf(':root{')));
    const hex = (root.match(/--brand:(#[0-9A-Fa-f]{6})/) || [])[1];
    const rgb = (root.match(/--brand-rgb:(\d+),(\d+),(\d+)/) || []).slice(1, 4).map(Number);
    assert.ok(hex && rgb.length === 3, 'both the accent and its triplet are declared');
    const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    assert.deepStrictEqual(rgb, want, `--brand-rgb must match ${hex}`);
});

test('5. a readable type floor replaces the legacy 9/10px labels', () => {
    assert.ok(/#mainContent \[style\*="font-size:9px"\][^{]*\{[^}]*font-size:12px !important/.test(DS.css),
        '4-digit legacy sizes are lifted to 12px');
    assert.ok(/--kx-fs-caption:11px/.test(DS.css), 'the caption step is 11px, the smallest allowed');
    assert.ok(/\.stat-label \{\s*font-size:var\(--kx-fs-caption\)/.test(DS.css),
        'labels use the caption step instead of an arbitrary size');
});

test('6. one control geometry: 44px targets, one 36px dense variant', () => {
    assert.ok(/\.btn \{[\s\S]*?min-height:44px/.test(DS.css), 'buttons are 44px tall');
    assert.ok(/\.btn-sm \{ min-height:36px/.test(DS.css), 'the dense button variant is 36px');
    assert.ok(/\.input-field, input\[type="text"\][\s\S]*?min-height:44px/.test(DS.css),
        'text inputs are 44px tall');
    assert.ok(/\.btn \{[\s\S]*?white-space:normal/.test(DS.css), 'long labels wrap instead of clipping');
    assert.ok(/\.btn \{[\s\S]*?max-width:100%/.test(DS.css), 'buttons cannot exceed their container');
});

test('7. accessibility: focus rings, semantic badges and reduced motion', () => {
    assert.ok(/:focus-visible \{\s*outline:2px solid var\(--kx-accent\)/.test(DS.css), 'visible keyboard focus');
    assert.ok(/\.input-field:focus[\s\S]*?box-shadow:0 0 0 3px/.test(DS.css), 'inputs show a focus ring');
    assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(DS.css), 'reduced motion is respected');
    assert.ok(/\.status-badge \{\s*display:inline-flex/.test(DS.css), 'status badges are semantic pills');
});

test('8. the referral page keeps its hierarchy and every scripted id', () => {
    const ref = INDEX.slice(INDEX.indexOf('<div class="card ref-page" id="referral">'));
    const block = ref.slice(0, ref.indexOf('REFERRAL PARTNER PAYOUT REQUEST MODAL'));
    // Order of the sections the redesign introduced.
    const order = ['ref-intro', 'ref-metrics', 'ref-section', 'ref-sharekit', 'ref-explainer', 'ref-pending'];
    let cursor = -1;
    order.forEach((cls) => {
        const at = block.indexOf(cls);
        assert.ok(at > cursor, `${cls} appears in the intended order`);
        cursor = at;
    });
    // Every id the scripts and the legacy tests address must survive the rewrite.
    ['refActiveCount', 'refPendingCount', 'refTotalEarned', 'refRewardPercent', 'refRewardPercent2',
        'refMinDeposit', 'refStep3Destination', 'referralCodeDisplay', 'referralLinkDisplay',
        'copyReferralBtn', 'copyReferralLinkBtn', 'shareReferralBtn', 'nativeShareBtn',
        'referralPartnerPanel', 'refTotalReferrals', 'refQualifiedReferrals', 'refQualifyingVolume',
        'refAvailableEarnings', 'requestPayoutBtn', 'partnerSupportBtn', 'referralPayoutOpenNote',
        'referralPendingPayoutsWrap', 'referralPayoutHistory', 'pendingReferralsSection',
        'pendingReferralsToggle', 'pendingReferralsList', 'pendingReferralsEmpty'].forEach((id) => {
        assert.ok(block.includes(`id="${id}"`), `#${id} is preserved`);
    });
    assert.ok(/id="refStep3Destination" data-i18n="referral\.bonusWallet"/.test(block),
        'the step-3 destination keeps its i18n contract');
});

test('9. the referral layout is mobile-first, not shrunken desktop', () => {
    assert.ok(/\.ref-metrics \{ display:grid; grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/.test(DS.css),
        'three equal metric tiles that cannot overflow');
    assert.ok(/\.ref-link \{[\s\S]*?overflow-wrap:anywhere/.test(DS.css), 'long links wrap safely');
    assert.ok(/\.ref-code \{[\s\S]*?overflow-wrap:anywhere/.test(DS.css), 'codes never overflow');
    assert.ok(/@media \(max-width:380px\)[\s\S]*?\.ref-share-actions \{ grid-template-columns:1fr/.test(DS.css),
        'share actions stack on the smallest phones');
    assert.ok(/@media \(min-width:720px\)[\s\S]*?\.ref-partner-grid \{ grid-template-columns:repeat\(4/.test(DS.css),
        'the desktop layout widens deliberately');
});

test('10. no business logic, backend or financial surface is touched by the layer', () => {
    assert.ok(!/#mainContent[^{]*\{[^}]*display:\s*none/.test(DS.css), 'the shell is never hidden by CSS');
    assert.ok(!/body\s*\{[^}]*overflow-x:\s*hidden/.test(DS.css), 'no global overflow hiding hack is added');
    assert.ok(!/\.ref-page[^{]*\{[^}]*pointer-events:\s*none/.test(DS.css), 'no control is disabled by CSS');
    assert.strictEqual((DS.css.match(/!important/g) || []).length <= 12, true,
        'the layer stays specific-first, not !important-first');
});
