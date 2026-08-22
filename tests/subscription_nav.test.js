'use strict';

/**
 * SUBSCRIPTION DISCOVERABILITY — regression tests (Phase 14).
 *
 * Frontend-only (public/index.html). Pins the dedicated Subscription entry
 * (sidebar link -> #subscriptionModal) and the compact Profile Settings
 * summary card, WITHOUT changing any subscription eligibility / financial /
 * backend logic (those pins live in subscription_eligibility.test.js and
 * remain untouched).
 *
 * What is pinned:
 *   1. Subscription is reachable directly from the sidebar (no need to open
 *      Profile Settings), via openSubscriptionModal().
 *   2. The single existing subscription panel (#subscriptionPanel) lives in
 *      #subscriptionModal and opens correctly (modal opened, drawer closed,
 *      status reloaded).
 *   3. Profile Settings no longer contains the full panel — only the compact
 *      summary card (#subscriptionProfileCard) with a Manage button.
 *   4. Demo-mode activation still triggers the switch-to-Live toast BEFORE any
 *      network call (unchanged gate order inside activateSubscription).
 *   5. Live-without-deposit still yields the existing deposit-required toast.
 *   6. Sandbox stays simulated: the frontend only ever calls the existing
 *      /api/subscription* endpoints (server-side sandbox branching unchanged).
 *   7. i18n: new keys exist, non-empty, in all 6 locales (identical key sets).
 *   8. The Profile summary badge mirrors the panel badge (single source of
 *      truth: renderSubscriptionPanel updates both).
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

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
    // eslint-disable-next-line no-eval
    return eval('(' + blk.slice(blk.indexOf('{', start), end + 1) + ')');
}

// Extract an element's HTML block by id (from its opening tag to the matching
// close of the container). Good enough for these well-formed modals.
function elementBlock(id, closeTag) {
    const start = INDEX.indexOf('id="' + id + '"');
    assert.ok(start !== -1, `#${id} should exist`);
    // walk back to the opening '<' of the tag carrying the id
    const open = INDEX.lastIndexOf('<', start);
    const end = INDEX.indexOf(closeTag, start);
    assert.ok(end !== -1, `#${id} should terminate`);
    return INDEX.slice(open, end);
}

// ---------------------------------------------------------------------------
// 1. Dedicated, discoverable entry (no Profile Settings detour)
// ---------------------------------------------------------------------------
test('sidebar has a dedicated Subscription entry that opens the subscription modal', () => {
    assert.match(INDEX, /<a class="sidebar-link" id="subscriptionSidebarLink" onclick="openSubscriptionModal\(\)">/, 'sidebar Subscription link missing');
    assert.match(INDEX, /id="subscriptionSidebarLink"[^>]*>[\s\S]*?data-i18n="sidebar\.subscription"/, 'link label must be localized');
    // sits in the primary navigation group (with Referral), not hidden
    const i = INDEX.indexOf('id="subscriptionSidebarLink"');
    const ref = INDEX.indexOf('data-section="referral"');
    assert.ok(ref !== -1 && i > ref && i < INDEX.indexOf('id="adminSidebarLink"'), 'Subscription link should sit between Referral and the divider/Admin');
});

test('openSubscriptionModal closes the drawer, opens the modal, reloads status', () => {
    const m = INDEX.match(/function openSubscriptionModal\(\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'openSubscriptionModal missing');
    const fn = m[0];
    assert.match(fn, /sidebar'\)\.classList\.remove\('open'\)/, 'must close the mobile drawer');
    assert.match(fn, /sidebarOverlay'\)\.classList\.remove\('open'\)/, 'must close the overlay');
    assert.match(fn, /subscriptionModal'\)\.classList\.add\('open'\)/, 'must open #subscriptionModal');
    assert.match(fn, /loadSubscriptionStatus\(\)/, 'must refresh server state');
});

// ---------------------------------------------------------------------------
// 2. The single existing panel is reused (not duplicated)
// ---------------------------------------------------------------------------
test('exactly one #subscriptionPanel exists and it lives inside #subscriptionModal', () => {
    assert.strictEqual((INDEX.match(/id="subscriptionPanel"/g) || []).length, 1, 'panel must not be duplicated');
    const modal = elementBlock('subscriptionModal', '<!-- CHANGE EMAIL MODAL');
    assert.match(modal, /id="subscriptionPanel"/, 'panel must be inside #subscriptionModal');
    for (const id of ['subscriptionPriceLabel', 'subscriptionStatusBadge', 'subscriptionDetails', 'subscriptionActivateBtn', 'subscriptionCancelBtn', 'sandboxIntroChip']) {
        assert.strictEqual((INDEX.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, `#${id} must be unique`);
        assert.ok(modal.includes('id="' + id + '"'), `#${id} must be inside the subscription modal`);
    }
    // the panel keeps its original controls wired to the original handlers
    assert.match(modal, /onclick="activateSubscription\(\)"/, 'activate wiring intact');
    assert.match(modal, /onclick="cancelSubscription\(\)"/, 'cancel wiring intact');
});

// ---------------------------------------------------------------------------
// 3. Profile Settings: compact summary card, no full panel
// ---------------------------------------------------------------------------
test('Profile Settings contains only the compact summary card (no full panel)', () => {
    const profile = elementBlock('profileModal', '<!-- ARBITRIX PRO SUBSCRIPTION MODAL');
    assert.ok(!profile.includes('id="subscriptionPanel"'), 'profile modal must NOT contain the full panel');
    assert.ok(!profile.includes('id="subscriptionActivateBtn"'), 'profile modal must NOT contain the activate button');
    assert.match(profile, /id="subscriptionProfileCard"/, 'compact summary card missing');
    assert.match(profile, /id="subscriptionStatusBadgeProfile"/, 'profile status badge missing');
    assert.match(profile, /onclick="openSubscriptionModal\(\)"/, 'Manage button must open the subscription modal');
    assert.match(profile, /data-i18n="subscription\.manage"/, 'Manage button must be localized');
});

test('profile summary badge mirrors the panel badge (single source of truth)', () => {
    const m = INDEX.match(/function renderSubscriptionPanel\(data\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'renderSubscriptionPanel missing');
    assert.match(m[0], /subscriptionStatusBadgeProfile/, 'renderSubscriptionPanel must mirror the badge to the profile card');
    assert.match(m[0], /badgeProfile\.textContent = badge\.textContent/, 'badge text mirrored');
    assert.match(m[0], /badgeProfile\.className = badge\.className/, 'badge class mirrored');
});

// ---------------------------------------------------------------------------
// 4/5. Eligibility behavior unchanged (frontend pins; backend pinned elsewhere)
// ---------------------------------------------------------------------------
test('demo-mode activation still short-circuits to switch-to-Live BEFORE any fetch', () => {
    const m = INDEX.match(/async function activateSubscription\(\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'activateSubscription missing');
    const fn = m[0];
    assert.ok(fn.indexOf("APP.mode !== 'live'") !== -1, 'demo gate missing');
    assert.ok(fn.indexOf("APP.mode !== 'live'") < fn.indexOf("fetch('/api/subscription/activate'"), 'demo gate must run before the network call');
    assert.ok(fn.includes("t('subscription.switchToLive')"), 'switch-to-Live toast intact');
});

test('live-without-deposit still surfaces the existing deposit-required toast', () => {
    const m = INDEX.match(/async function activateSubscription\(\) \{[\s\S]*?\n\}/);
    assert.ok(m);
    assert.ok(m[0].includes("t('subscription.depositRequired')"), 'deposit-required toast intact');
    assert.ok(m[0].includes("t('subscription.depositMore')"), 'deposit-more toast intact');
    // the client still sends an empty body (server is the authority)
    assert.match(m[0], /body:\s*JSON\.stringify\(\{\}\)/, 'activate must not send an authoritative body');
});

// ---------------------------------------------------------------------------
// 6. Sandbox stays simulated (frontend only talks to the existing endpoints)
// ---------------------------------------------------------------------------
test('no new subscription endpoints are introduced by the UI change', () => {
    const endpoints = [...INDEX.matchAll(/fetch\('(\/api\/subscription[^']*)'/g)].map((x) => x[1]);
    const unique = [...new Set(endpoints)];
    for (const e of unique) {
        assert.ok(['/api/subscription', '/api/subscription/activate', '/api/subscription/cancel'].includes(e), `unexpected subscription endpoint ${e}`);
    }
});

// ---------------------------------------------------------------------------
// 7. i18n parity for the new keys
// ---------------------------------------------------------------------------
test('sidebar.subscription + subscription.manage exist, non-empty, in all 6 locales', () => {
    const T = loadTranslations();
    const langs = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
    const enKeys = Object.keys(T.en).sort();
    for (const lang of langs) {
        assert.ok(T[lang], `locale ${lang} exists`);
        assert.deepStrictEqual(Object.keys(T[lang]).sort(), enKeys, `locale ${lang} key set must match en`);
        for (const key of ['sidebar.subscription', 'subscription.manage']) {
            assert.ok(typeof T[lang][key] === 'string' && T[lang][key].length > 0, `${key} non-empty in ${lang}`);
        }
    }
});

// ---------------------------------------------------------------------------
// 7b. Language-switch re-render is recursion-safe
// ---------------------------------------------------------------------------
test('renderSubscriptionPanel localizes via t() and never calls applyTranslations (no recursion)', () => {
    const m = INDEX.match(/function renderSubscriptionPanel\(data\) \{[\s\S]*?\n\}/);
    assert.ok(m);
    assert.ok(!m[0].includes('applyTranslations'), 'renderSubscriptionPanel must not call applyTranslations (updateDynamicTranslations -> renderSubscriptionPanel would recurse)');
    assert.ok(m[0].includes("t('subscription.nextPayment'"), 'nextPayment localized via t()');
    assert.ok(m[0].includes("t('subscription.inactiveDesc')"), 'inactiveDesc localized via t()');
});

test('updateDynamicTranslations re-renders the subscription panel on language switch', () => {
    const m = INDEX.match(/function updateDynamicTranslations\(\) \{[\s\S]*?\n\}/);
    assert.ok(m);
    assert.match(m[0], /renderSubscriptionPanel\(_subscriptionState\)/, 'must re-render details with the new locale');
    assert.match(m[0], /_subscriptionState !== 'undefined' && _subscriptionState/, 'must be guarded');
});

// ---------------------------------------------------------------------------
// 8. RTL + drawer safety for the new entry
// ---------------------------------------------------------------------------
test('profile card Manage button uses logical inline-start margin (RTL-safe)', () => {
    const card = elementBlock('subscriptionProfileCard', '<div class="modal-actions"');
    assert.match(card, /margin-inline-start:\s*auto/, 'Manage button should use margin-inline-start (RTL-safe)');
});
