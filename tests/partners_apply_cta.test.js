/**
 * Referral partner landing page (/partners) - application CTA.
 *
 * PR #164 replaced the application CTA with a Telegram-community CTA. This suite
 * pins the historical behaviour that was restored afterwards: all three primary
 * CTAs (topbar + hero + final block) apply to become a partner through the
 * EXISTING account-creation deep link, under the original partners.cta.apply key.
 *
 * What this suite pins:
 *   1. the exact destination on all three primary CTAs, with no invisible
 *      characters (zero-width spaces, joiners, NBSP, BOM, control codes)
 *   2. the exact text - "Apply to Become a Partner" in every placement
 *   3. the original translation key partners.cta.apply, present in all six locales
 *   4. a real language switch re-renders the CTA (runtime, not just the dictionary)
 *   5. the superseded partners.cta.applyNow key is gone
 *   6. the Telegram-community CTA and its supporting copy are gone
 *   7. the page carries no external anchor and keeps Sign In / how-it-works / demo
 *   8. the partner-funnel attribution markers are still armed by a CTA click
 *   9. no primary CTA is hidden or clipped by CSS
 *  10. referral/commission rules and the registration flow are untouched
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PAGE = read('public/partners.html');
const INDEX = read('public/index.html');
const SERVER = read('server.js');

// The ORIGINAL application destination and label, unchanged since the page existed.
const APPLY_URL = '/?action=create-account&src=partners';
const APPLY_LABEL = 'Apply to Become a Partner';
const RETIRED_COMMUNITY_URL = 'https://t.me/+CF9kWr61sqs1MTY0';
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

/** Every anchor that leaves the site. */
function externalAnchors(html) {
    const out = [];
    const re = /<a\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const href = /\bhref\s*=\s*"([^"]*)"/i.exec(m[1]);
        if (href && /^https?:/i.test(href[1])) out.push(href[1]);
    }
    return out;
}

/** Anchor destinations exactly as written in the markup. */
function anchorHrefs(html) {
    const out = [];
    const re = /<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) out.push(m[1]);
    return out;
}

/**
 * Characters that must never appear inside a destination: C0/C1 controls, plus
 * the invisible/format code points that can hide inside a URL.
 */
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

/** The page's inline translation dictionary, evaluated from the real source. */
function loadTranslations() {
    const tIdx = PAGE.indexOf('const TRANSLATIONS');
    assert.ok(tIdx >= 0, 'the page must define const TRANSLATIONS');
    let i = PAGE.indexOf('{', tIdx);
    let depth = 0;
    let end = -1;
    for (; i < PAGE.length; i++) {
        if (PAGE[i] === '{') depth++;
        else if (PAGE[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    assert.ok(end > tIdx, 'the TRANSLATIONS object must be a plain object literal');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(PAGE.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

const T = loadTranslations();

function extractScript(html) {
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'the page must carry one inline script');
    return m[1];
}

/**
 * Run the REAL inline script against a fake DOM whose three CTA nodes are the
 * elements applyTranslations() would rewrite, then read them back.
 */
function renderCta(lang) {
    const nodes = [0, 1, 2].map(() => ({ key: 'partners.cta.apply', innerHTML: APPLY_LABEL }));
    const sandbox = {};
    const browserLang = lang === 'en' ? 'en-US' : lang;
    sandbox.navigator = { languages: [browserLang], language: browserLang };
    sandbox.localStorage = { getItem: () => lang, setItem: () => {} };
    sandbox.sessionStorage = { setItem: () => {} };
    sandbox.console = { log: () => {}, error: () => {}, warn: () => {} };
    sandbox.document = {
        documentElement: {},
        title: '',
        querySelectorAll: (sel) => (sel === '[data-i18n]'
            ? nodes.map((n) => ({
                getAttribute: (a) => (a === 'data-i18n' ? n.key : null),
                get innerHTML() { return n.innerHTML; },
                set innerHTML(v) { n.innerHTML = v; }
            }))
            : []),
        querySelector: () => null,
        createElement: () => ({ appendChild: () => {}, setAttribute: () => {}, classList: { add: () => {} } }),
        getElementById: () => null
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(extractScript(PAGE) + ';globalThis.__lang = currentLang;', sandbox);
    return { lang: sandbox.__lang, labels: nodes.map((n) => n.innerHTML) };
}

/* ==================================================================== *
 * 1. Destination
 * ==================================================================== */
test('1. all three primary CTAs use the existing account-creation deep link', () => {
    const ctas = PAGE.match(/<a class="btn btn-primary js-apply-cta"[^>]*>/g) || [];
    assert.strictEqual(ctas.length, 3, 'topbar + hero + final CTA');
    ctas.forEach((a) => {
        const href = /href="([^"]*)"/.exec(a);
        assert.ok(href, 'every primary CTA needs an href: ' + a);
        assert.strictEqual(href[1], APPLY_URL, 'exact application destination expected: ' + a);
        assert.ok(!INVISIBLE.test(href[1]),
            'the destination must not carry zero-width/invisible characters: ' + a);
        assert.strictEqual(href[1].length, APPLY_URL.length,
            'the destination must match byte-for-byte: ' + a);
        assert.ok(!/target="_blank"/.test(a), 'the application CTA must stay in the same tab');
        assert.ok(!/rel="noopener/.test(a), 'no external-link rel is needed for an in-app destination');
        assert.ok(!/js-community-cta/.test(a), 'the community CTA class must be gone');
    });
    // The app shell still owns registration: no route or handler was added here.
    assert.match(INDEX, /action=create-account/, 'the app shell must still handle create-account');
    assert.match(SERVER, /app\.get\(\['\/partners', '\/partners\/'\]/, 'the /partners route must still exist');
});

test('1b. no anchor destination on the page hides an invisible character', () => {
    const hrefs = anchorHrefs(PAGE);
    assert.ok(hrefs.length > 0, 'the page must carry anchors');
    hrefs.forEach((h) => {
        assert.ok(!INVISIBLE.test(h), 'invisible character in href: ' + JSON.stringify(h));
        assert.strictEqual(h, h.trim(), 'no leading/trailing whitespace in href: ' + JSON.stringify(h));
    });
    // The application destination appears exactly three times, identically.
    const applies = hrefs.filter((h) => h.indexOf('action=create-account') !== -1);
    assert.strictEqual(applies.length, 3, 'three application links');
    assert.strictEqual(new Set(applies).size, 1, 'all three application links are identical');
    assert.strictEqual(applies[0], APPLY_URL);
});

/* ==================================================================== *
 * 2. Text
 * ==================================================================== */
test('2. every primary CTA reads "Apply to Become a Partner"', () => {
    // All three CTAs are driven by the one original key.
    assert.strictEqual((PAGE.match(/data-i18n="partners\.cta\.apply"/g) || []).length, 3,
        'all three CTAs use the original apply key');
    // The hero and final CTAs wrap their label in a span; the topbar labels the anchor.
    assert.strictEqual(
        PAGE.split('<span data-i18n="partners.cta.apply">' + APPLY_LABEL + '</span>').length - 1, 2,
        'the hero and final CTAs carry the label in a span');
    assert.strictEqual(PAGE.split('data-i18n="partners.cta.apply">' + APPLY_LABEL + '</a>').length - 1, 1,
        'the topbar CTA carries the label as its visible text');
    assert.strictEqual(T.en['partners.cta.apply'], APPLY_LABEL);
});

/* ==================================================================== *
 * 3. Translations
 * ==================================================================== */
test('3. partners.cta.apply exists in all six locales and is translated', () => {
    assert.deepStrictEqual(Object.keys(T).sort(), LANGS.slice().sort(), 'the six locales must exist');

    const keySets = LANGS.map((l) => Object.keys(T[l]).sort().join('|'));
    assert.strictEqual(new Set(keySets).size, 1, 'identical key sets across locales');

    LANGS.forEach((lang) => {
        const value = T[lang]['partners.cta.apply'];
        assert.ok(typeof value === 'string' && value.trim(), lang + ' needs partners.cta.apply');
        if (lang !== 'en') {
            assert.notStrictEqual(value, T.en['partners.cta.apply'],
                lang + ' must translate the CTA');
        }
        assert.ok(Object.keys(T[lang]).every((k) => k.indexOf('partners.') === 0),
            lang + ' may only carry partners.* keys');
    });

    assert.ok(/[\u0600-\u06FF]/.test(T.ar['partners.cta.apply']), 'Arabic CTA must be in Arabic script');
    assert.ok(/[\u4e00-\u9FFF]/.test(T.zh['partners.cta.apply']), 'Chinese CTA must be in Chinese script');
});

test('4. a real language switch re-renders every CTA text', () => {
    LANGS.forEach((lang) => {
        const out = renderCta(lang);
        assert.strictEqual(out.lang, lang, 'currentLang must resolve to ' + lang);
        assert.strictEqual(out.labels.length, 3, 'three CTAs are rendered');
        out.labels.forEach((label, i) => assert.strictEqual(label, T[lang]['partners.cta.apply'],
            lang + ' CTA ' + (i + 1) + ' must render its own apply label'));
    });
    // An unsupported stored language falls back to English.
    const fallback = renderCta('de');
    assert.strictEqual(fallback.lang, 'en', 'an unsupported language must fall back to English');
    assert.deepStrictEqual(fallback.labels, [APPLY_LABEL, APPLY_LABEL, APPLY_LABEL]);
});

/* ==================================================================== *
 * 4. Superseded / retired keys and CTAs
 * ==================================================================== */
test('5. the superseded partners.cta.applyNow key is fully removed', () => {
    assert.strictEqual(PAGE.indexOf('partners.cta.applyNow'), -1, 'the key must not remain in the page');
    assert.strictEqual(PAGE.indexOf('Apply Now'), -1, 'the "Apply Now" label must not remain');
    LANGS.forEach((lang) => {
        assert.strictEqual(T[lang]['partners.cta.applyNow'], undefined,
            lang + ' must not define partners.cta.applyNow');
    });
    // Every locale carries exactly the same key set, so the removal is symmetric.
    const counts = new Set(LANGS.map((l) => Object.keys(T[l]).length));
    assert.strictEqual(counts.size, 1, 'all locales keep the same key count');
});

test('6. the Telegram-community CTA and its supporting copy are removed', () => {
    assert.strictEqual(PAGE.indexOf('js-community-cta'), -1, 'no community CTA class may remain');
    assert.strictEqual(PAGE.indexOf(RETIRED_COMMUNITY_URL), -1, 'the group invite must not remain');
    assert.strictEqual(PAGE.indexOf('data-partner-entry'), -1, 'the community entry marker must be gone');
    ['partners.cta.joinCommunity', 'partners.cta.communityNote', 'partners.cta.registerNote']
        .forEach((key) => {
            assert.strictEqual(PAGE.indexOf(key), -1, key + ' must be retired');
            LANGS.forEach((lang) => {
                assert.strictEqual(T[lang][key], undefined, lang + ' must not define ' + key);
            });
        });
    assert.strictEqual(PAGE.indexOf('class="cta-register"'), -1, 'the secondary registration link must be gone');
    assert.strictEqual(PAGE.indexOf('class="cta-note"'), -1, 'the community note must be gone');
    assert.ok(!/\.cta-register|\.cta-note/.test(PAGE), 'their CSS must be gone too');
    assert.strictEqual(PAGE.indexOf('<i class="fab fa-telegram"'), -1,
        'no Telegram glyph remains in the CTA markup');
    assert.strictEqual(PAGE.split('fab fa-telegram').length - 1, 1,
        'the only remaining glyph is the runtime partner-support icon builder');
});

/* ==================================================================== *
 * 5. Everything else is preserved
 * ==================================================================== */
test('7. the page carries no external anchor and keeps the secondary CTAs', () => {
    assert.deepStrictEqual(externalAnchors(PAGE), [],
        'every CTA is the existing in-app deep link');

    assert.match(PAGE, /href="\/\?action=sign-in"[^>]*data-i18n="partners\.signIn"/,
        'Sign In must keep using the existing deep link');
    assert.strictEqual((PAGE.match(/href="\/how-it-works"/g) || []).length, 2,
        'the how-it-works CTA stays in the topbar and the final block');
    assert.match(PAGE, /<a class="btn btn-secondary" href="#demo"><i[^>]*><\/i><span data-i18n="partners\.cta\.demo">/,
        'the hero secondary CTA still anchors to the payout demo');

    // Partner support stays meta-driven (built at runtime, never a hardcoded anchor).
    assert.strictEqual(PAGE.split('@AlexArbitrix').length - 1, 1, 'the support handle stays single-source');
    assert.match(PAGE, /arbitrix-partner-support-telegram/, 'the support meta must remain');
});

test('8. the partner-funnel attribution markers are still armed by a CTA click', () => {
    const from = PAGE.indexOf('function markPartnerEntry()');
    assert.ok(from !== -1, 'the attribution helper must remain');
    const src = PAGE.slice(from, PAGE.indexOf('applyTranslations();', from));

    const makeStorage = () => {
        const data = {};
        return {
            getItem: (k) => (k in data ? data[k] : null),
            setItem: (k, v) => { data[k] = String(v); },
            removeItem: (k) => { delete data[k]; },
            dump: () => Object.assign({}, data)
        };
    };
    const sessionStorage = makeStorage();
    const localStorage = makeStorage();
    const bound = [];
    const sandbox = {
        console: { log: () => {}, error: () => {} },
        sessionStorage,
        localStorage,
        document: {
            querySelectorAll: (sel) => (sel === '.js-apply-cta'
                ? [0, 1, 2].map(() => ({ addEventListener: (t, fn) => { if (t === 'click') bound.push(fn); } }))
                : [])
        },
        window: { location: { search: '?utm_source=facebook' } }
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);

    assert.strictEqual(bound.length, 3, 'all three application CTAs must be armed');
    assert.deepStrictEqual(sessionStorage.dump(), {}, 'loading the page arms nothing');
    assert.deepStrictEqual(localStorage.dump(), {}, 'loading the page arms nothing');

    bound[0]();
    assert.strictEqual(sessionStorage.dump().arbi_partner_entry, '1', 'a click arms the session marker');
    const ts = Number(localStorage.dump().arbi_partner_entry);
    assert.ok(Number.isFinite(ts) && Math.abs(Date.now() - ts) < 60000,
        'a click arms the timestamped cross-tab marker');
});

/* ==================================================================== *
 * 6. Layout + business rules untouched
 * ==================================================================== */
test('9. no primary CTA is hidden, clipped or pinned to an external layout', () => {
    assert.ok(!/\.js-apply-cta[^{]*\{[^}]*display:\s*none/.test(PAGE),
        'the primary CTA must never be hidden by CSS');
    assert.ok(!/\.btn-primary[^{]*\{[^}]*visibility:\s*hidden/.test(PAGE),
        'no primary button may be hidden');
    assert.match(PAGE, /\.top-actions \.btn \{ flex: 1 1 45%; \}/,
        'the mobile topbar still lets the CTAs share the row');
    assert.match(PAGE, /\.hero-actions, \.bottom-cta \{ display: flex; flex-wrap: wrap;/,
        'the CTA rows still wrap on small screens');
});

test('10. the referral/commission terms and the registration flow are unchanged', () => {
    // Published business rules (one-time 20% of the first $100+ deposit).
    assert.match(PAGE, /20% of their first qualifying deposit of \$100 or more/,
        'the reward statement must stay exact');
    assert.strictEqual(T.en['partners.chip.reward'], '20% of first qualifying deposit');
    assert.strictEqual(T.en['partners.chip.noTrading'], 'No trading required');
    assert.strictEqual(T.en['partners.chip.noMinimum'], 'No minimum payout');
    assert.ok(!/(lifetime|recurring|passive)\s+(commission|income|earnings)/i.test(PAGE),
        'no recurring-commission language may appear');

    // The page must not implement registration, auth or commission logic itself.
    assert.ok(!/signup\s*\(|login\s*\(|\/api\/auth|\/api\/referral/i.test(PAGE),
        'no bespoke auth or referral API logic on the page');
    assert.match(INDEX, /action=create-account/, 'registration stays in the app shell');
    assert.match(INDEX, /action=sign-in/, 'sign-in stays in the app shell');
});
