'use strict';

/**
 * REFERRAL-PARTNER LAUNCH - landing conversion regression tests.
 *
 * Covers the launch-day landing changes ONLY (public/index.html):
 *   - hero shows the $50 promotional credit + new primary/secondary CTAs
 *   - hero title communicates "Automated Arbitrage ... Multiple Markets"
 *   - no competing hero Sign In (Sign In stays in the navigation)
 *   - Demo CTA wording accurately says an account is required
 *   - "START FREE IN 3 STEPS" strip below the hero
 *   - existing explainer video embedded near How It Works
 *   - Referral Partner section copy + disclosure
 *   - claims hygiene: no $700 anywhere, no $200, no MTA, no "Try Demo Mode",
 *     no guaranteed-profit language
 *
 * Read-only: parses public/index.html. No network, no DB. Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function loadTranslations() {
    const start = INDEX.indexOf('const TRANSLATIONS = {');
    assert.ok(start >= 0, 'TRANSLATIONS must exist');
    const open = INDEX.indexOf('{', start);
    let depth = 0, end = -1;
    for (let k = open; k < INDEX.length; k++) {
        const c = INDEX[k];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
    }
    return vm.runInNewContext('(' + INDEX.slice(open, end + 1) + ')');
}

const T = loadTranslations();

const NEW_KEYS = [
    'landing.hero.promo',
    'landing.startFree.tag', 'landing.startFree.title',
    'landing.startFree.step1.title', 'landing.startFree.step1.desc',
    'landing.startFree.step2.title', 'landing.startFree.step2.desc',
    'landing.startFree.step3.title', 'landing.startFree.step3.desc',
    'landing.video.tag', 'landing.video.title', 'landing.video.subtitle', 'landing.video.fallback'
];

// ---------------------------------------------------------------------------
// i18n structure
// ---------------------------------------------------------------------------
test('dictionary: 1470 keys/locale and an identical key set across all 6 locales', () => {
    const base = Object.keys(T.en).sort();
    assert.strictEqual(base.length, 1470, 'expected 1470 keys per locale');
    LANGS.forEach((l) => {
        assert.ok(T[l], l + ' locale must exist');
        assert.deepStrictEqual(Object.keys(T[l]).sort(), base, l + ' key set must match en');
    });
});

test('new landing keys exist and are non-empty in every locale', () => {
    LANGS.forEach((l) => {
        NEW_KEYS.forEach((k) => {
            assert.strictEqual(typeof T[l][k], 'string', l + ' missing ' + k);
            assert.ok(T[l][k].trim().length > 0, l + ' empty ' + k);
        });
    });
});

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------
test('hero title communicates automated arbitrage across multiple markets', () => {
    LANGS.forEach((l) => {
        assert.match(T[l]['landing.hero.title'], /landing-gradient-text/, l + ' keeps the gradient span');
        assert.match(T[l]['landing.hero.title'], /<br>/, l + ' is a two-line title');
        assert.ok(!/Made Simple/i.test(T[l]['landing.hero.title']), l + ' must not use the old title');
    });
    assert.match(T.en['landing.hero.title'], /Automated Arbitrage<br><span class="landing-gradient-text">Across Multiple Markets<\/span>/);
    assert.match(INDEX, /class="landing-hero-title"[\s\S]{0,200}Across Multiple Markets/, 'hero markup fallback updated');
});

test('the $50 promotional credit is visible in the hero', () => {
    assert.match(INDEX, /class="landing-hero-promo"/, 'hero promo pill present');
    assert.match(INDEX, /data-i18n="landing\.hero\.promo"/, 'promo pill is localized');
    LANGS.forEach((l) => assert.match(T[l]['landing.hero.promo'], /\$50/, l + ' promo mentions $50'));
    // Primary CTA also carries the credit and points at account creation.
    assert.match(INDEX, /class="btn btn-primary landing-hero-btn js-landing-auth-cta">[\s\S]{0,160}data-i18n="landing\.hero\.ctaPrimary"/,
        'hero primary CTA present');
    assert.match(INDEX, /onclick="openAuthScreen\('signup'\)"[\s\S]{0,200}landing\.hero\.ctaPrimary/, 'hero primary CTA starts signup');
    LANGS.forEach((l) => assert.match(T[l]['landing.hero.ctaPrimary'], /\$50/, l + ' primary CTA mentions $50'));
});

test('hero CTAs: signup + See How It Works, and no competing hero Sign In', () => {
    const start = INDEX.indexOf('class="landing-hero-cta"');
    const end = INDEX.indexOf('class="landing-hero-trust"', start);
    const hero = INDEX.slice(start, end);
    assert.match(hero, /openAuthScreen\('signup'\)/, 'hero has the signup CTA');
    assert.match(hero, /landing\.hero\.ctaSecondary/, 'hero has the secondary CTA');
    assert.ok(!/openAuthScreen\('signin'\)/.test(hero), 'hero must not have a Sign In CTA');
    assert.ok(!/goToApp\('hero_demo'\)/.test(INDEX), 'hero demo button removed');
    // Sign In stays in the navigation (desktop + mobile).
    assert.match(INDEX, /class="landing-nav-actions"[\s\S]{0,400}openAuthScreen\('signin'\)/, 'nav keeps Sign In');
    const mobileStart = INDEX.indexOf('id="landingMobileMenu"');
    const mobileMenu = INDEX.slice(mobileStart, INDEX.indexOf('</nav>', mobileStart));
    assert.match(mobileMenu, /openAuthScreen\('signin'\)/, 'mobile nav keeps Sign In');
});

// ---------------------------------------------------------------------------
// Demo CTA honesty
// ---------------------------------------------------------------------------
test('demo CTA wording says an account is required (no "Try Demo Mode")', () => {
    LANGS.forEach((l) => {
        assert.ok(!/Try Demo Mode/i.test(T[l]['landing.demo.cta']), l + ' demo.cta must not say Try Demo Mode');
        assert.ok(!/Try Demo Mode/i.test(T[l]['landing.cta.button']), l + ' cta.button must not say Try Demo Mode');
    });
    assert.ok(!/Try Demo Mode/.test(INDEX), 'no raw "Try Demo Mode" string remains in index.html');
    // Anonymous visitors are routed to account creation, so the wording is accurate.
    assert.match(INDEX, /function goToApp\(source\)[\s\S]{0,600}openAuthScreen\('signup'\)/,
        'goToApp must send anonymous visitors to signup');
});

// ---------------------------------------------------------------------------
// 3-step strip
// ---------------------------------------------------------------------------
test('START FREE IN 3 STEPS strip is present below the hero', () => {
    assert.match(INDEX, /id="start-free"/, 'strip section present');
    assert.strictEqual(T.en['landing.startFree.title'], 'START FREE IN 3 STEPS');
    ['step1.title', 'step2.title', 'step3.title'].forEach((s) => {
        assert.match(INDEX, new RegExp('data-i18n="landing\\.startFree\\.' + s.replace('.', '\\.') + '"'), 'wired ' + s);
    });
    // The strip must not promise the credit to everyone.
    assert.match(T.en['landing.startFree.step2.desc'], /where eligible/i, 'step 2 states eligibility');
    LANGS.forEach((l) => assert.ok(T[l]['landing.startFree.title'].trim().length > 0, l + ' title present'));
});

// ---------------------------------------------------------------------------
// Explainer video
// ---------------------------------------------------------------------------
test('the existing explainer video is embedded near How It Works', () => {
    assert.match(INDEX, /<video[^>]*class="landing-video"[^>]*poster="\/video\/arbitrix-poster\.jpg"/, 'video element with poster');
    assert.match(INDEX, /<source src="\/video\/arbitrix-explainer\.mp4" type="video\/mp4">/, 'video source wired');
    const videoAt = INDEX.indexOf('id="explainer"');
    const howAt = INDEX.indexOf('id="how-it-works"');
    assert.ok(videoAt > 0 && howAt > videoAt, 'video section sits before How It Works');
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'video', 'arbitrix-explainer.mp4')), 'video asset exists');
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'video', 'arbitrix-poster.jpg')), 'poster asset exists');
    // No new external dependency was introduced for the video.
    assert.ok(!/<video[\s\S]{0,300}https?:\/\//.test(INDEX), 'video must not load from an external URL');
});

// ---------------------------------------------------------------------------
// Referral Partner section
// ---------------------------------------------------------------------------
test('Referral Partner section: copy, 5-step flow, CTA and disclosure', () => {
    assert.match(INDEX, /id="referral-partner"/, 'partner section present');
    assert.strictEqual(T.en['landing.partner.subtitle'],
        'Introduce new users to Arbitrix and earn a 20% referral reward on their first qualifying deposit of $100 or more.');
    assert.strictEqual(T.en['landing.partner.cta'], 'Become a Referral Partner');
    assert.match(INDEX, /class="landing-partner-actions"[\s\S]{0,240}openAuthScreen\('signup'\)/, 'partner CTA starts signup');
    assert.match(T.en['landing.partner.disclosure'], /misleading promotion/i, 'disclosure covers misleading promotion');
    LANGS.forEach((l) => {
        assert.ok(T[l]['landing.partner.subtitle'].includes('$100'), l + ' partner copy names the $100 minimum');
        assert.ok(T[l]['landing.partner.disclosure'].trim().length > 0, l + ' disclosure present');
    });
});

// ---------------------------------------------------------------------------
// Claims hygiene
// ---------------------------------------------------------------------------
test('no "$700", "$200" or MTA anywhere in user-facing copy', () => {
    LANGS.forEach((l) => {
        const offenders = Object.keys(T[l]).filter((k) => /\$700/.test(String(T[l][k])));
        assert.deepStrictEqual(offenders, [], l + ' advertises $700: ' + offenders.join(','));
        Object.keys(T[l]).forEach((k) => {
            assert.ok(!/\$200/.test(String(T[l][k])), l + '.' + k + ' mentions $200');
            assert.ok(!/\bMTA\b/.test(String(T[l][k])), l + '.' + k + ' mentions MTA');
        });
    });
    // Internal risk control must not be exposed as a landing string.
    assert.ok(!/BOT_PROFIT_PAUSE_USD/.test(INDEX), 'internal risk config is not exposed in the app');
});

test('the new landing copy makes no guaranteed-profit claims', () => {
    const banned = /(guarantee|guaranteed|risk-free|risk free|assured returns|guaranteed profit)/i;
    const keys = ['landing.hero.title', 'landing.hero.ctaPrimary', 'landing.hero.promo', 'landing.partner.subtitle',
        'landing.partner.disclosure'].concat(NEW_KEYS);
    LANGS.forEach((l) => keys.forEach((k) => {
        assert.ok(!banned.test(String(T[l][k])), l + '.' + k + ' contains a guaranteed-profit claim');
    }));
});

// ---------------------------------------------------------------------------
// Payout workflow wiring (light - full coverage in referral_partner_payout.test.js)
// ---------------------------------------------------------------------------
test('the referral-partner payout surfaces are wired', () => {
    assert.match(INDEX, /id="referralPartnerPanel"/, 'partner dashboard present');
    assert.match(INDEX, /id="requestPayoutBtn"/, 'request payout button present');
    assert.match(INDEX, /id="referralPayoutModal"/, 'payout modal present');
    assert.match(INDEX, /id="referralSubTabPayouts"/, 'admin payouts sub-tab present');
});
