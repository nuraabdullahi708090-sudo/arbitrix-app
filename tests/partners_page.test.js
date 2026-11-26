'use strict';

/**
 * REFERRAL PARTNER acquisition page (/partners) tests.
 *
 * A standalone, unlisted marketing landing page for the Kalderix Referral
 * Partner program, reached from a Meta ad. Scope guards pinned here:
 *   - the route /partners (+ /partners/) serves the page and is registered
 *     BEFORE the SPA fallback (so it never resolves to the app shell);
 *   - the CTAs reuse the EXISTING ?action=create-account / ?action=sign-in
 *     deep links (no bespoke registration); the topbar/bottom secondary CTA uses
 *     the existing /how-it-works page while the HERO secondary CTA anchors
 *     in-page to the payout demo section (id="demo");
 *   - all six locales (en/es/pt/fr/ar/zh) have identical, complete key sets
 *     (no empty / duplicate keys) and Arabic is RTL;
 *   - the page is mobile-first / responsive with no horizontal overflow;
 *   - the copy is compliance-clean (no guaranteed earnings, no licence /
 *     regulatory claim, no CAC/Nigeria, no advice authorization);
 *   - the demo section is COMPACT: heading + the real partner-payout walkthrough
 *     recording (whose own captions explain the referral flow) + a VISIBLE
 *     simulated-demo disclosure, with NO separate explanatory copy above it;
 *   - NO fabricated screenshots / transactions / earnings / customer data and
 *     NO video element is shipped before the real recording exists;
 *   - partner support is the IN-APP chat (a deep link into the app's messenger):
 *     the page carries no Telegram handle, no Telegram URL and no contact card;
 *   - public/index.html (the customer funnel) is byte-for-byte unchanged BY THIS
 *     FEATURE and the page is not linked from the homepage navigation. (The
 *     baseline hash is re-pinned when a separately-approved change edits the
 *     homepage, e.g. the landing-video repoint.)
 *
 * Static source checks only: no network, no database, no server boot.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const PAGE_PATH = path.join(ROOT, 'public', 'partners.html');
const PAGE = fs.readFileSync(PAGE_PATH, 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
// 84: the Telegram contact model was retired (partners.supportHandleLabel,
// partners.contactAlex, partners.partnerRole = -3 per locale), and the copy now
// names only the in-app chat.
const EXPECTED_KEYS = 84;

// The application destination every primary CTA uses: the EXISTING account
// creation deep link. No bespoke registration and no external redirect.
const APPLY_URL = '/?action=create-account&src=partners';

// Tamper pin for the ANONYMOUS FUNNEL ONLY: everything from the landing page
// markup up to the app shell (`<div id="landingPage">` .. `id="mainApp"`).
//
// This used to hash all of public/index.html, which meant every approved
// homepage edit - ten of them, listed below - forced a re-pin, and the pin's
// real question ("did /partners work touch the funnel?") was buried in noise.
// Scoping it to the funnel keeps the signal: a /partners change that alters the
// landing page, the auth screen or the loader still fails here, while a change
// elsewhere in the app does not.
//
// Re-pin ONLY when an approved change edits this slice. The /partners feature
// itself never has.
const FUNNEL_START = '<div id="landingPage"';
const FUNNEL_END = 'id="mainApp"';
function funnelSlice() {
    const a = INDEX.indexOf(FUNNEL_START);
    const b = INDEX.indexOf(FUNNEL_END, a);
    assert.ok(a > 0 && b > a, 'the funnel slice must be locatable');
    return INDEX.slice(a, b);
}
// Re-pinned 2026-11-24 for the APPROVED single-mode landing (Demo Mode removed
// from the hero, onboarding and navigation; promotional-credit narrative).
// Previous pin: 542d49d9...6de94.
// Originally re-pinned 2026-11-21 for the APPROVED visual overhaul of the landing/auth
// funnel: the institutional azure accent + slate navy surface tokens
// (--brand, --brand-rgb, --gold-* aliases), the mode-switch labels, the dialog
// elevation layer and the shared component layer.
// The /partners feature itself still touches no homepage markup; this pin keeps
// protecting it, so any future homepage edit must be re-pinned deliberately.
// Re-pinned 2026-11-26 for the APPROVED in-app-support consolidation: the footer
// Contact column now opens the in-app chat instead of the Telegram bot, and the
// landing page keeps no customer-facing Telegram support destination.
// Previous pin: 06274563...20a643.
const FUNNEL_SHA256 = '81dc1a622cdf85baa234066bc373f40a8444d301de7cff706725fb28860944fe';
const PARTNER_HANDLE = '@AlexArbitrix';
const PARTNER_HANDLE_2 = '@OliviaArbitrix';
const OFFICIAL_SUPPORT = '@ArbitrixSupportBot';
const META_1 = 'arbitrix-partner-support-telegram';
const META_2 = 'arbitrix-partner-support-telegram-2';
const DEMO_FLOW_STEPS = [
    'Partner', 'Referral', '$100 qualifying deposit', '$20 reward', 'Request payout',
    'USDT / TRC20', 'Under review', 'Admin processing', 'Paid', 'Payout history'
];

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
function loadTranslations(html) {
    const tIdx = html.indexOf('const TRANSLATIONS');
    assert.ok(tIdx >= 0, 'the page must define const TRANSLATIONS');
    let i = html.indexOf('{', tIdx), depth = 0, end = -1;
    for (; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(html.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

/** Anchor hrefs only (font/CDN <link> tags are not customer-facing links). */
function anchorHrefs(html) {
    const out = [];
    const re = /<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) out.push(m[1]);
    return out;
}

/** Body copy only: drop <style>, <script> and HTML comments. */
function visibleText(html) {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ');
}

function extractScript(html) {
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    return m ? m[1] : '';
}

/**
 * The smallest DOM element the page touches: class/attributes/text and children.
 * Assigning textContent = '' clears the children, which is what the renderer does
 * when it rebuilds the contact list.
 */
function fakeEl(tag) {
    const el = {
        tagName: tag,
        children: [],
        attrs: {},
        _text: '',
        set textContent(v) { this._text = String(v); if (this._text === '') this.children.length = 0; },
        get textContent() { return this._text; },
        appendChild(child) { this.children.push(child); return child; },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
        removeAttribute(k) { delete this.attrs[k]; }
    };
    return el;
}

/** Read one rendered partner card into a plain object. */
function readCard(card) {
    const byClass = (cls) => card.children.find((c) => c.className === cls);
    const link = byClass('btn btn-secondary js-partner-support');
    const label = link && link.children.find((c) => c.tagName === 'span');
    const icon = link && link.children.find((c) => c.tagName === 'i');
    const handle = byClass('support-handle');
    const handleValue = handle && handle.children.find((c) => c.className === 'support-handle-value');
    return {
        partner: card.getAttribute('data-partner'),
        name: (byClass('partner-name') || {}).textContent,
        role: (byClass('partner-role') || {}).textContent,
        href: link && link.getAttribute('href'),
        target: link && link.getAttribute('target'),
        rel: link && link.getAttribute('rel'),
        label: label && label.textContent,
        handle: handleValue && handleValue.textContent,
        iconHidden: icon && icon.getAttribute('aria-hidden')
    };
}

function renderedCards(sandbox) {
    return sandbox.__cards.children.map(readCard);
}

/** Run the page's inline script in a vm sandbox with a fake DOM. */
function runPage(opts) {
    opts = opts || {};
    const lang = opts.lang || 'en';
    const script = extractScript(PAGE);
    const sandbox = {};
    sandbox.navigator = { languages: [opts.browserLang || 'en-US'], language: opts.browserLang || 'en-US' };
    sandbox.localStorage = { getItem: () => (opts.storedLang || lang), setItem: () => {} };
    sandbox.sessionStorage = { setItem: () => {} };
    sandbox.console = console;
    sandbox.document = {
        documentElement: {},
        title: '',
        querySelectorAll: () => [],
        querySelector: () => null,
        createElement: (tag) => fakeEl(tag),
        getElementById: () => null
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        script + ';globalThis.__T=TRANSLATIONS;globalThis.__t=t;globalThis.__lang=currentLang;',
        sandbox
    );
    return sandbox;
}

const T = loadTranslations(PAGE);

/* ------------------------------------------------------------------ *
 * 1. Page + route exist, and the route is NOT the SPA fallback
 * ------------------------------------------------------------------ */
test('1. the page exists and /partners + /partners/ are routed to it', () => {
    assert.ok(fs.existsSync(PAGE_PATH), 'public/partners.html must exist');
    assert.match(SERVER, /app\.get\(\[[^\]]*'\/partners'[^\]]*\][\s\S]{0,160}partners\.html/,
        'server.js must serve the page at /partners');
    assert.match(SERVER, /'\/partners\/'/, 'the trailing-slash form must be routed too');
    assert.match(SERVER, /express\.static\(path\.join\(__dirname,\s*'public'\)\)/,
        'the static middleware must still serve public/');
});

test('1b. the /partners route is registered BEFORE the SPA fallback', () => {
    const routeIdx = SERVER.search(/app\.get\(\[[^\]]*'\/partners'[^\]]*\]/);
    const fallbackIdx = SERVER.indexOf('app.use((req, res) =>');
    assert.ok(routeIdx >= 0, 'the /partners route must exist');
    assert.ok(fallbackIdx >= 0, 'the SPA fallback must exist');
    assert.ok(routeIdx < fallbackIdx,
        '/partners must be registered before the SPA fallback so it does not resolve to index.html');
    // And the served file must not be index.html.
    const snippet = SERVER.slice(routeIdx, SERVER.indexOf('});', routeIdx));
    assert.ok(snippet.includes('partners.html'), 'the route must sendFile partners.html, not index.html');
    assert.ok(!snippet.includes('index.html'), 'the /partners route must not serve the app shell');
});

test('1c. the page is complete, self-contained, static HTML', () => {
    assert.match(PAGE, /^<!DOCTYPE html>/i);
    assert.match(PAGE, /<html lang="en"/);
    assert.ok(PAGE.trim().endsWith('</html>'), 'the document must be complete');
    // Static + session-free: no API calls, no forms, no credential collection.
    assert.ok(!PAGE.includes('/api/'), 'the page must not call any API');
    assert.ok(!/<form\b/i.test(PAGE), 'the page must not contain a form');
    assert.ok(!/type\s*=\s*"password"/i.test(PAGE), 'the page must not ask for a password');
    assert.ok(!/\bfetch\s*\(/.test(PAGE), 'the page must not call fetch');
    assert.ok(!/XMLHttpRequest/.test(PAGE), 'the page must not use XHR');
});

/* ------------------------------------------------------------------ *
 * 2. SEO metadata
 * ------------------------------------------------------------------ */
test('2. the page carries SEO + social metadata and a canonical URL', () => {
    assert.match(PAGE, /<meta name="description" content="[^"]{40,}">/);
    assert.match(PAGE, /<link rel="canonical" href="https:\/\/arbitrix\.pro\/partners">/);
    assert.match(PAGE, /<meta property="og:type" content="website">/);
    assert.match(PAGE, /<meta property="og:title" content="[^"]+">/);
    assert.match(PAGE, /<meta property="og:description" content="[^"]+">/);
    assert.match(PAGE, /<meta property="og:url" content="https:\/\/arbitrix\.pro\/partners">/);
    assert.match(PAGE, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(PAGE, /<meta name="twitter:title" content="[^"]+">/);
    assert.match(PAGE, /<meta name="viewport" content="width=device-width, initial-scale=1\.0[^"]*">/);
});

/* ------------------------------------------------------------------ *
 * 3. CTAs reuse the EXISTING flows (no bespoke registration)
 * ------------------------------------------------------------------ */
test('3. the primary CTA applies to become a partner via the existing signup link', () => {
    const ctas = PAGE.match(/<a class="btn btn-primary js-apply-cta"[^>]*>/g) || [];
    assert.strictEqual(ctas.length, 3, 'topbar + hero + bottom share the one primary CTA');
    ctas.forEach((a) => {
        assert.ok(a.indexOf('href="' + APPLY_URL + '"') !== -1, 'exact signup destination: ' + a);
        assert.ok(!/target="_blank"/.test(a), 'the application CTA must stay in the same tab: ' + a);
        assert.ok(!/js-community-cta/.test(a), 'the Telegram community CTA must be gone: ' + a);
    });
    // Original label everywhere: all three CTAs use the original partners.cta.apply
    // key and read "Apply to Become a Partner" (the exact pre-#164 implementation).
    assert.strictEqual((PAGE.match(/data-i18n="partners\.cta\.apply"/g) || []).length, 3,
        'all three CTAs use the original apply key');
    assert.strictEqual(PAGE.split('<span data-i18n="partners.cta.apply">Apply to Become a Partner</span>').length - 1, 2,
        'the hero and final CTAs read "Apply to Become a Partner"');
    assert.strictEqual(T.en['partners.cta.apply'], 'Apply to Become a Partner');
    assert.strictEqual(PAGE.indexOf('partners.cta.applyNow'), -1, 'the superseded key must be gone');
    // The retired Telegram-community CTA and its supporting copy are gone.
    assert.ok(!/js-community-cta/.test(PAGE), 'no community CTA may remain');
    assert.ok(!/partners\.cta\.joinCommunity/.test(PAGE), 'the community key must be retired');
    assert.ok(!/class="cta-register"/.test(PAGE), 'the community-era registration link must be gone');
    assert.ok(!/class="cta-note"/.test(PAGE), 'the community-era supporting note must be gone');
    // The app still performs registration and sign-in exactly as before.
    assert.match(INDEX, /action=create-account/, 'the app shell must still handle the create-account action');
    assert.match(INDEX, /action=sign-in/, 'the app shell must still handle the sign-in action');
});

test('3b. the topbar/bottom secondary CTA still uses the existing /how-it-works page', () => {
    const how = (PAGE.match(/href="\/how-it-works"/g) || []).length;
    assert.strictEqual(how, 2, 'the how-it-works CTA must remain in the topbar and bottom CTA (got ' + how + ')');
    assert.match(PAGE, /data-i18n="partners\.cta\.how"/, 'the secondary CTA must be localized');
    assert.match(SERVER, /app\.get\('\/how-it-works'/, 'the /how-it-works route must still exist');
});

test('3e. the HERO secondary CTA anchors in-page to the payout demo (not /how-it-works)', () => {
    const hero = PAGE.match(/<div class="hero-actions">[\s\S]*?<\/div>/);
    assert.ok(hero, 'the hero actions block must exist');
    assert.ok(!/how-it-works/.test(hero[0]), 'the hero CTA must NOT link to the customer /how-it-works page');
    assert.match(hero[0], /href="#demo"/, 'the hero CTA must anchor to the demo section');
    assert.match(hero[0], /data-i18n="partners\.cta\.demo"/, 'the hero CTA must use its own localized key');
    // Real anchor target + a keyboard-native <a> whose visible text is the accessible name.
    assert.match(PAGE, /<section class="section" id="demo"/, 'the #demo section must exist as the anchor target');
    assert.match(PAGE,
        /<a class="btn btn-secondary" href="#demo"><i[^>]*aria-hidden="true"><\/i><span data-i18n="partners\.cta\.demo">Watch Partner Payout Demo<\/span><\/a>/,
        'the CTA must be an <a> with a meaningful visible/accessible name');
    // Anchored scrolling must not hide the section behind a sticky header, and must
    // respect reduced-motion preferences.
    assert.match(PAGE, /html \{ scroll-behavior: smooth; \}/, 'smooth anchor scrolling');
    assert.match(PAGE, /prefers-reduced-motion: reduce[\s\S]{0,60}scroll-behavior: auto/, 'reduced-motion fallback');
    assert.match(PAGE, /#demo \{ scroll-margin-top: 16px; \}/, 'the anchor target needs scroll-margin');
});

test('3c. the Sign In link uses the existing /?action=sign-in deep link', () => {
    assert.match(PAGE, /href="\/\?action=sign-in"[^>]*data-i18n="partners\.signIn"/,
        'Sign In must use the existing deep link');
    assert.match(INDEX, /action=sign-in/, 'the app shell must still handle the sign-in action');
});

test('3d. no bespoke auth system and no external destination is introduced', () => {
    const hrefs = anchorHrefs(PAGE);
    const authLinks = hrefs.filter((h) => h.includes('action='));
    assert.deepStrictEqual(authLinks.slice().sort(), [
        '/?action=create-account&src=partners',
        '/?action=create-account&src=partners',
        '/?action=create-account&src=partners',
        '/?action=sign-in'
    ], 'the three application CTAs plus the Sign In link, nothing else');
    const external = hrefs.filter((h) => /^https?:/i.test(h));
    assert.deepStrictEqual(external, [],
        'the page carries no external anchor: every CTA is the existing signup deep link');
    hrefs.forEach((h) => {
        // Same-page fragments (#demo) and root-relative links cannot leave the site.
        assert.ok(h.startsWith('/') || h.startsWith('#'), 'unexpected anchor ' + h);
    });
    assert.ok(!/signup\s*\(|login\s*\(|\/api\/auth/i.test(PAGE), 'no bespoke auth logic on the page');
});

/* ------------------------------------------------------------------ *
 * 4. Six locales: identical, complete key sets; Arabic RTL
 * ------------------------------------------------------------------ */
test('4. all six locales exist with identical, complete key sets', () => {
    assert.deepStrictEqual(Object.keys(T).sort(), LANGS.slice().sort(), 'the six locales must be present');
    const keyStr = (l) => Object.keys(T[l]).sort().join('|');
    assert.strictEqual(new Set(LANGS.map((l) => keyStr(l))).size, 1, 'identical key sets across locales');
    LANGS.forEach((l) => {
        assert.strictEqual(Object.keys(T[l]).length, EXPECTED_KEYS, l + ' must have ' + EXPECTED_KEYS + ' keys');
        Object.keys(T[l]).forEach((k) => {
            assert.ok(k.startsWith('partners.'), l + ' has a non-partners key: ' + k);
            assert.ok(typeof T[l][k] === 'string' && T[l][k].trim(), l + '/' + k + ' must be a non-empty string');
        });
    });
});

test('4b. no empty and no duplicate i18n keys', () => {
    LANGS.forEach((l) => {
        const keys = [];
        const re = /"([^"]+)"\s*:/g;
        // Parse the raw per-locale block for a duplicate check.
        const start = PAGE.indexOf(l === 'en' ? '{' : '');
        void start;
        Object.keys(T[l]).forEach((k) => {
            keys.push(k);
            assert.ok(T[l][k].trim() !== '', l + '/' + k + ' must not be empty');
        });
        assert.strictEqual(new Set(keys).size, keys.length, l + ' must not have duplicate keys');
    });
    // Raw duplicate check on the emitted keys (each locale block once).
    const rawKeyMatches = PAGE.match(/^\s*"(partners\.[^"]+)":/gm) || [];
    const counts = {};
    rawKeyMatches.forEach((line) => {
        const k = line.match(/"(partners\.[^"]+)"/)[1];
        counts[k] = (counts[k] || 0) + 1;
    });
    const dupes = Object.keys(counts).filter((k) => counts[k] !== LANGS.length);
    assert.deepStrictEqual(dupes, [],
        'every translation key must appear exactly once per locale (bad counts: ' + dupes.join(', ') + ')');
    assert.strictEqual(rawKeyMatches.length, EXPECTED_KEYS * LANGS.length, 'total translation lines must match');
});

test('4c. every data-i18n key used in the markup is defined in all locales', () => {
    const used = new Set();
    const re = /data-i18n="([^"]+)"/g;
    let m;
    while ((m = re.exec(PAGE)) !== null) used.add(m[1]);
    assert.ok(used.size >= 50, 'the page must wire a substantial number of data-i18n keys');
    LANGS.forEach((l) => {
        used.forEach((k) => assert.ok(Object.prototype.hasOwnProperty.call(T[l], k),
            l + ' is missing the markup key ' + k));
    });
});

test('4d. Arabic is RTL and the locale wiring is intact', () => {
    assert.match(PAGE, /document\.documentElement\.dir\s*=\s*\(currentLang === 'ar'\) \? 'rtl' : 'ltr'/,
        'the page must switch to RTL for Arabic');
    assert.match(PAGE, /html\[dir="rtl"\]/, 'an RTL stylesheet rule must exist');
    assert.match(PAGE, /localStorage\.getItem\('arbi_lang'\)/, 'the page must reuse the shared arbi_lang key');
    assert.match(PAGE, /localStorage\.setItem\('arbi_lang'/, 'detected language must persist to arbi_lang');
    assert.ok(T.ar['partners.cta.apply'] !== T.en['partners.cta.apply'], 'Arabic must be translated');
});

test('4e. the runtime resolves each locale correctly', () => {
    const cases = { en: 'partners.cta.apply', es: 'partners.cta.apply', pt: 'partners.cta.apply', fr: 'partners.cta.apply', ar: 'partners.cta.apply', zh: 'partners.cta.apply' };
    Object.keys(cases).forEach((lang) => {
        const sb = runPage({ lang: lang, storedLang: lang });
        assert.strictEqual(sb.__lang, lang, 'currentLang must resolve to ' + lang);
        assert.strictEqual(sb.__t('partners.cta.apply'), T[lang]['partners.cta.apply'],
            'the ' + lang + ' string must be used');
    });
    // Unknown/unsupported locale falls back to English.
    const fallback = runPage({ storedLang: 'de' });
    assert.strictEqual(fallback.__lang, 'en', 'an unsupported stored language must fall back to English');
    // Unknown key returns the key itself (no crash).
    const known = runPage({ lang: 'en', storedLang: 'en' });
    assert.strictEqual(known.__t('partners.does.not.exist'), 'partners.does.not.exist');
});

/* ------------------------------------------------------------------ *
 * 5. Responsiveness / no horizontal overflow (CSS contract)
 * ------------------------------------------------------------------ */
test('5. the page is mobile-first and stacks cleanly on small screens', () => {
    assert.match(PAGE, /@media \(max-width: 640px\)/, 'a mobile breakpoint must exist');
    assert.match(PAGE, /@media \(min-width: 900px\)/, 'a desktop breakpoint must exist');
    assert.match(PAGE, /\.steps\s*\{\s*grid-template-columns:\s*1fr;/, 'the steps grid must stack on mobile');
    assert.match(PAGE, /\.features\s*\{\s*grid-template-columns:\s*1fr;/, 'the features grid must stack on mobile');
    assert.match(PAGE, /min-height:\s*46px/, 'touch targets must meet the 44px+ minimum');
});

test('5b. the layout cannot overflow horizontally', () => {
    assert.match(PAGE, /body\s*\{[^}]*overflow-x:\s*hidden/, 'body must clip horizontal overflow');
    assert.match(PAGE, /overflow-wrap:\s*anywhere/, 'long localized strings must wrap');
    assert.match(PAGE, /min-width:\s*0/, 'flex/grid children must be allowed to shrink');
    assert.match(PAGE, /flex-wrap:\s*wrap/, 'flex rows must wrap');
    // Every grid container sets min-width:0 on its children via the shared rules.
    assert.match(PAGE, /\.chip\s*\{[^}]*max-width:\s*100%/, 'chips must cap at the container width');
});

/* ------------------------------------------------------------------ *
 * 6. Compliance hygiene
 * ------------------------------------------------------------------ */
test('6. the copy makes no guaranteed-earnings / risk-free claim', () => {
    const vt = visibleText(PAGE);
    ['guaranteed profit', 'guaranteed return', 'guaranteed income', 'assured profit',
        'profit guarantee', 'risk-free', 'risk free', 'no risk', 'get rich', 'passive income'].forEach((p) => {
        assert.ok(!vt.toLowerCase().includes(p), 'the page must not claim: ' + p);
    });
    // Any occurrence of "guaranteed" must be a negation ("not guaranteed earnings").
    const all = (vt.match(/guaranteed/gi) || []).length;
    const negated = (vt.match(/not guaranteed/gi) || []).length;
    assert.strictEqual(all, negated, 'every "guaranteed" mention must be negated');
    assert.ok(/not guaranteed earnings/i.test(vt), 'the earnings disclaimer must be present');
    assert.ok(/examples only/i.test(vt), 'the examples must be labelled as examples');
});

test('6b. no licence / regulatory claim and no CAC/Nigeria reference', () => {
    const vt = visibleText(PAGE).toLowerCase();
    ['licence', 'license', 'licensed', 'regulatory', 'regulator', 'supervised by', 'approved by',
        'government', 'ministry', 'cac', 'nigeria', 'nigerian', 'corporate affairs commission'].forEach((w) => {
        assert.ok(!vt.includes(w), 'the page must not claim/mention: ' + w);
    });
});

test('6c. partners are explicitly NOT authorized to give investment/trading advice', () => {
    const vt = visibleText(PAGE);
    assert.ok(/not authorized to provide investment or trading advice/i.test(vt),
        'the disclosure must state partners are not authorized to give advice');
    // No positive advice-authorization claim.
    assert.ok(!/authorized to provide/i.test(vt.replace(/not\s+authorized to provide/gi, '')),
        'there must be no positive advice-authorization claim');
    assert.ok(!/we (?:provide|give|offer) (?:investment|trading|financial) advice/i.test(vt));
});

test('6d. only the approved figures appear; no fabricated numbers', () => {
    const vt = visibleText(PAGE);
    const dollars = new Set(vt.match(/\$[0-9][0-9,]*/g) || []);
    assert.deepStrictEqual([...dollars].sort(),
        ['$1,000', '$100', '$20', '$200', '$250', '$50', '$500'].sort(),
        'only the approved reward-example figures may appear');
    const percents = new Set(vt.match(/[0-9]+%/g) || []);
    assert.deepStrictEqual([...percents].sort(), ['20%'], 'the only percentage may be the 20% reward');
});

test('6e. no fabricated customer data, transactions or hashes', () => {
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(PAGE), 'no email addresses');
    assert.ok(!/0x[a-fA-F0-9]{6,}/.test(PAGE), 'no wallet/transaction hashes');
    assert.ok(!/\b[a-fA-F0-9]{32,}\b/.test(PAGE), 'no long hex identifiers');
    // Phone-number check runs on the rendered body only (the head holds data-URI
    // image metadata that is not customer-facing).
    const body = PAGE.slice(PAGE.indexOf('<body>'), PAGE.indexOf('</body>'));
    const bodyText = body.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
    assert.ok(!/\+?\d[\d\s().-]{7,}\d/.test(bodyText), 'no phone numbers');
});

/* ------------------------------------------------------------------ *
 * 7. Demo section: stage / placeholder / visible disclosure / no video yet
 * ------------------------------------------------------------------ */
test('7. the demo section has a .demo-stage with the real video mount point', () => {
    assert.match(PAGE, /class="demo-stage"/, 'a .demo-stage must exist');
    assert.match(PAGE, /<video class="demo-video" id="demoVideo"/, 'the real video element must exist');
    // The video must live INSIDE the demo-stage element.
    const stageStart = PAGE.indexOf('class="demo-stage"');
    const stageEnd = PAGE.indexOf('</section>', stageStart);
    const videoIdx = PAGE.indexOf('id="demoVideo"');
    assert.ok(videoIdx > stageStart && videoIdx < stageEnd, 'the video must be nested inside .demo-stage');
});

test('7b. the recording is a real public asset with the expected attributes', () => {
    assert.match(PAGE, /<video[^>]*\bcontrols\b/, 'controls required');
    assert.match(PAGE, /<video[^>]*\bplaysinline\b/, 'playsinline required (iOS)');
    assert.match(PAGE, /<video[^>]*\bpreload="metadata"/, 'preload=metadata required');
    assert.match(PAGE, /poster="\/video\/arbitrix-partner-payout-poster\.jpg"/, 'poster required');
    assert.match(PAGE, /<source src="\/video\/arbitrix-partner-payout-demo\.mp4" type="video\/mp4">/, 'the MP4 source is required');
    assert.ok(!/coming soon/i.test(PAGE), 'the placeholder copy must be gone');
});

test('7c. the verified workflow is displayed textually', () => {
    DEMO_FLOW_STEPS.forEach((step) => {
        assert.ok(PAGE.includes(step), 'the workflow step must appear: ' + step);
    });
    assert.ok(PAGE.includes('&rarr;'), 'the workflow must use arrows between steps');
});

test('7d. a VISIBLE simulated-demo disclosure sits inside the demo stage', () => {
    assert.match(PAGE, /class="demo-disclosure"/, 'a .demo-disclosure must exist');
    const stageStart = PAGE.indexOf('class="demo-stage"');
    const stageEnd = PAGE.indexOf('</section>', stageStart);
    const disc = PAGE.indexOf('class="demo-disclosure"');
    assert.ok(disc > stageStart && disc < stageEnd, 'the disclosure must be inside .demo-stage');
    assert.match(PAGE, /data-i18n="partners\.demoDisclosureTitle"/, 'the disclosure title must be localized');
    assert.match(PAGE, /data-i18n="partners\.demoDisclosureBody"/, 'the disclosure body must be localized');
    assert.ok(/simulated/i.test(PAGE), 'the disclosure must say the demo is simulated');
    // The disclosure must NOT be inside the video element, so it survives the
    // recording insert/removal and always stays visible beside it.
    const vStart = PAGE.indexOf('id="demoVideo"');
    const vEnd = PAGE.indexOf('</video>', vStart);
    assert.ok(vEnd > -1, 'the video element must be closed');
    assert.ok(!(disc > vStart && disc < vEnd), 'the disclosure must not be inside the video element');
});

test('7e. the shipped recording exists, the placeholder is gone, disclosure kept', () => {
    assert.strictEqual((PAGE.match(/<video\b/gi) || []).length, 1, 'exactly one <video> element');
    assert.strictEqual((PAGE.match(/<source\b/gi) || []).length, 1, 'exactly one <source> element');
    assert.ok(!PAGE.includes('demo-placeholder'), 'the placeholder must be gone');
    assert.ok(!PAGE.includes('demoPlaceholder'), 'the placeholder markup/keys must be gone');
    // Both assets really exist on disk and are non-trivial.
    for (const rel of ['public/video/arbitrix-partner-payout-demo.mp4',
                       'public/video/arbitrix-partner-payout-poster.jpg']) {
        const full = path.join(ROOT, rel);
        assert.ok(fs.existsSync(full), rel + ' must exist');
        assert.ok(fs.statSync(full).size > 10000, rel + ' must be a real asset');
    }
});

test('7f. the demo section is compact: the above-video explainer/callout is removed', () => {
    // The long explanatory copy and the highlighted "$100 is the referred user's
    // deposit" callout were removed; the recording's own captions now explain the
    // full referral flow, so the section stays heading -> video -> flow ->
    // disclosure with nothing interleaved.
    assert.ok(!PAGE.includes('partners.demoSubtitle'), 'the demo subtitle key must be gone');
    assert.ok(!PAGE.includes('partners.demoIntro'), 'the demo intro key must be gone');
    assert.ok(!PAGE.includes('partners.demoDepositNote'), 'the demo deposit-note key must be gone');
    assert.ok(!PAGE.includes('demo-intro'), 'the demo-intro CSS hook must be gone');
    assert.ok(!PAGE.includes('demo-deposit-note'), 'the demo-deposit-note CSS hook must be gone');
    assert.ok(!/See how a referral becomes a payout\./.test(PAGE), 'the removed headline must not return');
    assert.ok(!/The deposit shown in this demo is made by the user you referred\./.test(PAGE),
        'the removed explanation must not return');
    assert.ok(!/Important: The \$100 deposit shown is the referred user's deposit/.test(PAGE),
        'the removed callout must not return');
    // Heading + anchor kept; the video now follows the heading directly.
    assert.match(PAGE, /<section class="section" id="demo"/, 'the anchor target is unchanged');
    const h = PAGE.indexOf('id="demoHeading"');
    const v = PAGE.indexOf('id="demoVideo"');
    assert.ok(h > -1 && v > -1 && h < v, 'the heading must precede the video');
    const between = PAGE.slice(PAGE.indexOf('</h2>', h), v);
    assert.ok(!/<p\b/.test(between), 'no paragraph may sit between the heading and the video');
    // The existing simulated-demo disclosure is untouched (truthfulness) and stays
    // OUTSIDE the video element so it is always visible.
    assert.match(PAGE, /data-i18n="partners\.demoDisclosureBody"/, 'the disclosure must stay');
    const disc = PAGE.indexOf('partners.demoDisclosureBody');
    const vStart = v;
    const vEnd = PAGE.indexOf('</video>', vStart);
    assert.ok(disc > vEnd, 'the disclosure must sit below the video, not inside it');
    // The video asset is unchanged in role: still the real recording.
    assert.match(PAGE, /<source src="\/video\/arbitrix-partner-payout-demo\.mp4" type="video\/mp4">/);
});

test('7g. the removed explainer keys are absent from every locale; kept demo copy is intact', () => {
    const REMOVED = ['partners.demoSubtitle', 'partners.demoIntro', 'partners.demoDepositNote'];
    LANGS.forEach((l) => {
        REMOVED.forEach((k) => {
            assert.ok(!(k in T[l]), l + ' must not define the removed key ' + k);
        });
        assert.ok(T[l]['partners.cta.demo'].trim() !== '', l + ' needs partners.cta.demo');
        assert.ok(T[l]['partners.demoTitle'].trim() !== '', l + ' needs partners.demoTitle');
        assert.ok(T[l]['partners.demoDisclosureBody'].trim().length > 40,
            l + '/partners.demoDisclosureBody must stay a full sentence');
        assert.ok(!/^partners\./.test(T[l]['partners.demoDisclosureBody']), l + ' the disclosure must be translated');
    });
    assert.strictEqual(T.en['partners.cta.demo'], 'Watch Partner Payout Demo', 'EN hero CTA copy');
    assert.strictEqual(T.en['partners.demoTitle'], 'Partner Payout Walkthrough', 'EN demo heading');
});

test('7h. no internal sandbox wording on the partner page', () => {
    // The two internal/sandbox strings must never appear on the partner-facing page.
    assert.ok(!/Simulated demo data/i.test(PAGE), 'the sandbox note must not appear');
    assert.ok(!/no real money or payouts/i.test(PAGE), 'the sandbox "no real money" copy must not appear');
    assert.ok(!/Sandbox referral rewards/i.test(PAGE), 'the sandbox referral-reward copy must not appear');
    assert.ok(!/simulated Live balance/i.test(PAGE), 'the sandbox Live-balance copy must not appear');
    assert.ok(!/not the Bonus Wallet/i.test(PAGE), 'the sandbox Bonus-Wallet copy must not appear');
    assert.ok(!/sandbox/i.test(PAGE), 'the word "sandbox" must not appear on the partner page at all');
    // Truthfulness: the page must not claim the walkthrough was a real transaction.
    ['real payout', 'live transaction', 'already paid'].forEach((claim) => {
        assert.ok(!new RegExp(claim, 'i').test(PAGE), 'no fabricated claim: "' + claim + '"');
    });
    // The legitimate disclosures stay.
    assert.match(PAGE, /data-i18n="partners\.disclosureTitle"/, 'Referral Partner Disclosure must stay');
    assert.match(PAGE, /data-i18n="partners\.disclosureBody"/, 'the partner disclosure body must stay');
    assert.match(PAGE, /data-i18n="partners\.demoDisclosureBody"/, 'the walkthrough disclosure must stay');
});

/* ------------------------------------------------------------------ *
 * 8. Support: the in-app chat, with no Telegram contact
 * ------------------------------------------------------------------ */
test('8. the page sends partner questions to the in-app chat and configures no contact', () => {
    // No per-partner Telegram handle any more: the in-app messenger is the support
    // channel for partners too - the same conversation the agents answer from.
    for (const meta of [META_1, META_2]) {
        assert.ok(!PAGE.includes('name="' + meta + '"'), 'no Telegram contact meta: ' + meta);
    }
    // CSS at-rules (@media, @keyframes, ...) are not handles; a Telegram username is.
    const handles = PAGE.match(/(^|[\s>"'(])@(?!media\b|keyframes\b|font-face\b|supports\b|import\b)[A-Za-z0-9_]{4,}/g) || [];
    assert.deepStrictEqual(handles, [], 'no @handle of any kind is printed on the page');

    // The CTA is a real link to the app's support deep link: it works before JS
    // loads and for a signed-out visitor (the chat opens when the session resolves).
    const cta = PAGE.match(/<a[^>]*js-partner-support[^>]*>[\s\S]*?<\/a>/);
    assert.ok(cta, 'the support CTA must exist');
    assert.match(cta[0], /href="\/\?support=1"/, 'deep link into the app');
    assert.match(cta[0], /data-i18n="partners\.supportCta"/, 'localized label');
    assert.match(cta[0], /fa-comments/, 'a chat icon, not a Telegram glyph');
    assert.ok(!/target="_blank"/.test(cta[0]), 'the chat opens in the same tab');

    // The app keeps no partner contact either.
    assert.strictEqual(INDEX.split('@AlexArbitrix').length - 1, 0, 'no Alex handle in the app');
    assert.strictEqual(INDEX.split('@OliviaArbitrix').length - 1, 0, 'no Olivia handle in the app');
});

test('8d. the support section is a single, labelled, accessible CTA', () => {
    const section = PAGE.slice(PAGE.indexOf('id="supportHeading"'), PAGE.indexOf('id="faqHeading"'));
    assert.strictEqual((section.match(/js-partner-support/g) || []).length, 1, 'exactly one support action');
    assert.match(PAGE, /aria-labelledby="supportHeading"/, 'the section is labelled by its heading');
    assert.match(section, /partners\.supportDesc/, 'and explains what the chat is for');
    assert.match(section, /partners\.supportFallback/, 'with a hint, never a contact address');
    assert.strictEqual((section.match(/<a /g) || []).length, 1, 'one anchor, no contact list');
});

test('8e. the support copy is localized in all six languages and never names Telegram', () => {
    for (const k of ['partners.supportTitle', 'partners.supportDesc',
        'partners.supportCta', 'partners.supportFallback']) {
        LANGS.forEach((l) => {
            assert.ok(T[l][k] && T[l][k].trim(), l + ' must define ' + k);
            assert.ok(!/@|t\.me|Telegram/i.test(T[l][k]), l + '/' + k + ' must not name a Telegram destination');
        });
        assert.notStrictEqual(T.ar[k], T.en[k], 'ar must be translated for ' + k);
    }
    LANGS.filter((l) => l !== 'en').forEach((l) => {
        assert.notStrictEqual(T[l]['partners.supportCta'], T.en['partners.supportCta'],
            l + ' must translate the CTA');
    });
});

test('8f. nothing can invent a contact: no builder, no card, no fallback element', () => {
    for (const gone of ['partnerSupportContacts', 'id="partnerSupportFallback"', 'applyPartnerSupport',
        'buildPartnerCard', 'getPartnerSupportContacts', 'partnerSupportRaw', 'telegramUrlFromRaw',
        'getPartnerSupportTelegramUrl', 'support-cards', 'support-card']) {
        assert.ok(!PAGE.includes(gone), 'must be gone: ' + gone);
    }
});

test('8g. no partner or customer-support Telegram destination is presented', () => {
    assert.ok(!PAGE.includes('@Arbitrix_CSA1'), 'the retired partner handle must not appear');
    assert.ok(!PAGE.includes('Olivia'), 'no individual is presented as a partner contact');
    assert.ok(!/https?:\/\/t\.me\//.test(PAGE), 'no Telegram destination of any kind');
    assert.ok(!PAGE.includes('ArbitrixSupportBot'), 'not the customer support bot either');
    // The app's single support entry point is untouched by this page.
    assert.ok(INDEX.includes('function kxOpenSupport('), 'the app still has its one support entry point');
});

test('8h. the CTA is responsive with a comfortable tap target', () => {
    assert.match(PAGE, /\.support-cta\s*\{[^}]*display:\s*flex/, 'the CTA is centred by a flex row');
    assert.match(PAGE, /\.support-cta \.btn\s*\{[^}]*min-height:\s*44px/, 'at least a 44px tap target');
    assert.match(PAGE, /\.support-cta \.btn\s*\{[^}]*max-width:\s*100%/, 'cannot overflow a narrow screen');
    assert.match(PAGE, /\.support-fallback\s*\{[^}]*overflow-wrap:\s*anywhere/, 'long translations wrap');
});

test('8b. the page adds no Telegram destination of its own', () => {
    assert.strictEqual((PAGE.match(/t\.me\//g) || []).length, 0, 'no t.me destination anywhere');
    assert.strictEqual((PAGE.match(/t\.me\/\+/g) || []).length, 0, 'no community invite');
    assert.ok(!/joinchat/i.test(PAGE), 'no joinchat link');
});

test('8c. no runtime Telegram URL builder remains', () => {
    assert.ok(!/getPartnerSupportTelegramUrl|telegramUrlFromRaw|PARTNER_SUPPORT_META/.test(PAGE),
        'the handle-to-URL builder is retired with the contact model');
    assert.ok(!/ARBITRIX_PARTNER_SUPPORT_TELEGRAM_URL/.test(PAGE),
        'and so is its window override');
});

test('8i. the app offers no partner contact anywhere in the deposit journey', () => {
    // Management removed the customer-facing "Buy from a Verified Partner" route:
    // the deposit journey is the automated USDT (TRC20) flow, and the in-app
    // support chat is the only assistance offered there.
    for (const gone of ['id="depositPartnerContacts"', 'id="paymentPartnerContacts"',
        'id="depositCryptoPartnerContacts"', 'renderPaymentPartnerContacts',
        'renderDepositPartnerAssistance', 'https://wa.me/17828027841',
        '<meta name="arbitrix-partner-support-telegram-2"']) {
        assert.ok(!INDEX.includes(gone), 'must be gone from the app: ' + gone);
    }
    // The referral card keeps a support action, routed through the one helper.
    assert.match(INDEX, /id="partnerSupportBtn"[^>]*onclick="kxOpenSupport\('account'\)"/);
    assert.ok(INDEX.includes('data-i18n="referral.partner.contactSupport"'),
        'the referral support button is still present');
});

test('8j. no other recruitment surface points at a payment partner', () => {
    const outreach = ['partners.html'];
    outreach.forEach((file) => {
        const html = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
        assert.ok(!html.includes('@OliviaArbitrix'), file + ' must not offer Olivia as a recruitment contact');
        assert.ok(!html.includes('@AlexArbitrix'), file + ' must not offer Alex as a recruitment contact');
    });
});

/* ------------------------------------------------------------------ *
 * 9. Unlisted: the homepage funnel is untouched
 * ------------------------------------------------------------------ */
test('9. the homepage funnel is unchanged', () => {
    const sha = crypto.createHash('sha256').update(funnelSlice(), 'utf8').digest('hex');
    assert.strictEqual(sha, FUNNEL_SHA256,
        'the landing/auth funnel must match the approved baseline (the /partners feature must not modify it)');
    // and the slice really is the funnel, not an empty string
    const slice = funnelSlice();
    assert.match(slice, /id="authPage"/, 'the auth screen is inside the pinned slice');
    assert.ok(slice.length > 50000, 'the slice covers the real landing + auth markup');
});

test('9b. the page is not added to the homepage navigation', () => {
    assert.ok(!INDEX.includes('/partners'), 'index.html must not link to /partners');
    assert.ok(!INDEX.includes('partners.html'), 'index.html must not reference partners.html');
    // The landing nav / CTA structure is intact.
    assert.match(INDEX, /id="landingPage"/, 'the landing page must be intact');
    assert.match(INDEX, /openAuthScreen\('signup'\)|landing\.hero\.ctaPrimary/, 'the landing CTA wiring must be intact');
});

test('9c. no other public page links to /partners', () => {
    fs.readdirSync(path.join(ROOT, 'public')).forEach((file) => {
        if (!file.endsWith('.html') || file === 'partners.html') return;
        const html = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
        assert.ok(!html.includes('/partners'), file + ' must not link to /partners (unlisted)');
        assert.ok(!html.includes('partners.html'), file + ' must not reference partners.html');
    });
});

test('9d. the customer funnel behaviour is unchanged (no partner logic in index.html)', () => {
    // The feature is additive: it must not have injected partner-page logic into
    // the app shell.
    assert.ok(!/referralPartnerPage|partnersPage|openPartnersPage/i.test(INDEX),
        'no partner-page hooks may be added to the app shell');
    // Existing referral + payout endpoints are untouched by this change.
    assert.match(SERVER, /app\.get\('\/api\/referral\/partner'/, 'the existing partner dashboard endpoint must remain');
});
