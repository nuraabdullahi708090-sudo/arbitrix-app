'use strict';

/**
 * REFERRAL PARTNER acquisition page (/partners) tests.
 *
 * A standalone, unlisted marketing landing page for the Arbitrix Referral
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
 *   - the demo section keeps a VISIBLE simulated-demo disclosure and a
 *     .demo-stage > .demo-video (the real partner-payout recording) + the
 *     visible simulated-demo disclosure;
 *   - NO fabricated screenshots / transactions / earnings / customer data and
 *     NO video element is shipped before the real recording exists;
 *   - the partner support handle is the single source of truth (@Arbitrix_CSA1);
 *   - public/index.html (the customer funnel) is byte-for-byte unchanged and the
 *     page is not linked from the homepage navigation.
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
const EXPECTED_KEYS = 87;

// Current approved baseline of public/index.html. The /partners feature itself
// does not modify the homepage funnel; this hash was updated once for the
// separately-approved removal of the sandbox "simulated" callouts from the
// referral area (Option A).
const INDEX_SHA256 = '6084ae0e91ff3cf9143c63edaf13c7c7cf6ab15e69fa8ba09e7fe7b806bc635a';

const PARTNER_HANDLE = '@Arbitrix_CSA1';
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
        querySelector: (sel) => (String(sel).indexOf('arbitrix-partner-support-telegram') !== -1
            ? { getAttribute: () => (opts.metaContent !== undefined ? opts.metaContent : PARTNER_HANDLE) }
            : null),
        getElementById: () => null
    };
    sandbox.window = sandbox;
    if (opts.overrideUrl !== undefined) sandbox.ARBITRIX_PARTNER_SUPPORT_TELEGRAM_URL = opts.overrideUrl;
    vm.createContext(sandbox);
    vm.runInContext(
        script + ';globalThis.__T=TRANSLATIONS;globalThis.__t=t;globalThis.__lang=currentLang;' +
        'globalThis.__url=getPartnerSupportTelegramUrl();',
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
test('3. the primary CTA "Apply to Become a Partner" uses /?action=create-account', () => {
    const apply = (PAGE.match(/href="\/\?action=create-account"/g) || []).length;
    assert.ok(apply >= 3, 'the apply CTA must appear in the topbar, hero and bottom CTA (got ' + apply + ')');
    assert.match(PAGE, /data-i18n="partners\.cta\.apply"/, 'the apply CTA must be localized');
    assert.match(INDEX, /action=create-account/, 'the app shell must still handle the create-account action');
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

test('3d. no new authentication system or external destination is introduced', () => {
    const hrefs = anchorHrefs(PAGE);
    const authLinks = hrefs.filter((h) => h.includes('action='));
    assert.ok(authLinks.length >= 4, 'the page must expose the two auth entry points');
    authLinks.forEach((h) => assert.ok(h === '/?action=create-account' || h === '/?action=sign-in',
        'unexpected auth link ' + h));
    hrefs.forEach((h) => {
        // Same-page fragments (#demo) are allowed: they cannot leave the page.
        assert.ok(h.startsWith('/') || h.startsWith('#'),
            'no external anchor may exist on the page: ' + h);
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

test('7f. the demo section explains the REFERRED USER deposit above the video', () => {
    // Requested headline + explanation, directly above the recording.
    assert.match(PAGE, /data-i18n="partners\.demoSubtitle">See how a referral becomes a payout\.</);
    assert.match(PAGE,
        /data-i18n="partners\.demoIntro">The deposit shown in this demo is made by the user you referred\./);
    assert.match(PAGE, /Once their qualifying deposit is credited, your 20% referral reward is added to your partner balance/,
        'the explanation must credit the reward to the PARTNER balance once the REFERRED user deposit is credited');
    const intro = PAGE.indexOf('partners.demoIntro');
    const video = PAGE.indexOf('id="demoVideo"');
    assert.ok(intro > -1 && video > -1 && intro < video, 'the explanation must sit above the video element');
    // The key clarification sits DIRECTLY above the video, inside the demo stage.
    assert.match(PAGE,
        /<p class="demo-deposit-note" role="note">[\s\S]{0,140}data-i18n="partners\.demoDepositNote">Important: The \$100 deposit shown is the referred user's deposit \u2014 not the partner's\.<\/span><\/p>\s*<video/,
        'the "$100 is the referred user deposit" clarification must sit directly above the video');
    assert.match(PAGE, /<section class="section" id="demo"/, 'the anchor target is unchanged');
    // The existing simulated-demo disclosure is untouched (truthfulness).
    assert.match(PAGE, /data-i18n="partners\.demoDisclosureBody"/, 'the disclosure must stay');
    assert.ok(!/demoIntro[^\n]*demoDisclosureBody/.test(PAGE), 'the disclosure copy must not be merged into the intro');
    // The video asset is unchanged and still the real recording.
    assert.match(PAGE, /<source src="\/video\/arbitrix-partner-payout-demo\.mp4" type="video\/mp4">/);
});

test('7g. the demo copy + deposit note are localized in all six locales', () => {
    LANGS.forEach((l) => {
        assert.strictEqual(T[l]['partners.cta.demo'].trim() !== '', true, l + ' needs partners.cta.demo');
        const intro = T[l]['partners.demoIntro'];
        const note = T[l]['partners.demoDepositNote'];
        assert.ok(intro.trim() !== '', l + ' needs partners.demoIntro');
        assert.ok(/20\s*%/.test(intro), l + '/partners.demoIntro must keep the 20% reward');
        assert.ok(note.trim() !== '', l + ' needs partners.demoDepositNote');
        assert.ok(/100/.test(note), l + '/partners.demoDepositNote must keep the $100 figure');
        assert.ok(note.trim().length >= 20, l + '/partners.demoDepositNote must be a full sentence');
        assert.ok(!/^partners\./.test(note), l + ' the note must be translated, not a raw key');
        if (l !== 'en') assert.notStrictEqual(note, T.en['partners.demoDepositNote'], l + ' the note must be translated');
    });
    assert.strictEqual(T.en['partners.cta.demo'], 'Watch Partner Payout Demo', 'EN hero CTA copy');
    assert.strictEqual(T.en['partners.demoSubtitle'], 'See how a referral becomes a payout.', 'EN demo headline');
    assert.match(T.en['partners.demoIntro'], /^The deposit shown in this demo is made by the user you referred\./);
    assert.match(T.en['partners.demoDepositNote'], /^Important: The \$100 deposit shown is the referred user's deposit/);
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
 * 8. Support: single source of truth handle
 * ------------------------------------------------------------------ */
test('8. the partner support handle is @Arbitrix_CSA1 and matches the app', () => {
    const idxMeta = INDEX.match(/<meta name="arbitrix-partner-support-telegram" content="([^"]*)">/);
    const pageMeta = PAGE.match(/<meta name="arbitrix-partner-support-telegram" content="([^"]*)">/);
    assert.ok(idxMeta, 'the app must define the partner support meta');
    assert.ok(pageMeta, 'the page must define the partner support meta');
    assert.strictEqual(pageMeta[1], PARTNER_HANDLE, 'the page handle must be ' + PARTNER_HANDLE);
    assert.strictEqual(idxMeta[1], pageMeta[1], 'the page handle must MATCH the existing app single source of truth');
    // The handle literal appears exactly once (the meta) - never duplicated.
    assert.strictEqual(PAGE.split(PARTNER_HANDLE).length - 1, 1,
        'the handle literal must appear exactly once (in the meta)');
});

test('8b. the page invents no other Telegram destination or group link', () => {
    assert.ok(!PAGE.includes('t.me/+'), 'no Telegram invite/group link');
    assert.ok(!/joinchat/i.test(PAGE), 'no joinchat link');
    assert.strictEqual((PAGE.match(/t\.me\//g) || []).length, 1,
        'only the single programmatic t.me builder may exist');
    assert.ok(!PAGE.includes('https://t.me/' + PARTNER_HANDLE.replace('@', '')),
        'the full support URL must be built at runtime, not hardcoded');
});

test('8c. the runtime builds the correct https://t.me URL from the meta handle', () => {
    const sb = runPage({ lang: 'en', storedLang: 'en' });
    assert.strictEqual(sb.__url, 'https://t.me/Arbitrix_CSA1', 'the handle must resolve to the official t.me URL');
    // A full URL override is honoured.
    const ovr = runPage({ overrideUrl: 'https://t.me/SomePartner' });
    assert.strictEqual(ovr.__url, 'https://t.me/SomePartner');
    // A bare username (no @) is accepted.
    const bare = runPage({ metaContent: 'AnotherPartner' });
    assert.strictEqual(bare.__url, 'https://t.me/AnotherPartner');
    // Empty config resolves to '' (the caller then leaves the link inert).
    const empty = runPage({ metaContent: '' });
    assert.strictEqual(empty.__url, '');
});

/* ------------------------------------------------------------------ *
 * 9. Unlisted: the homepage funnel is untouched
 * ------------------------------------------------------------------ */
test('9. public/index.html is byte-for-byte unchanged', () => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'public', 'index.html'))).digest('hex');
    assert.strictEqual(sha, INDEX_SHA256,
        'public/index.html must match the approved baseline (the /partners feature must not modify the homepage funnel)');
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
