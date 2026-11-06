/**
 * Referral partner landing page (/partners) - application CTA.
 *
 * PR #164 replaced the application CTA with a Telegram-community CTA. This suite
 * pins the restored behaviour: every primary CTA on the page applies to become a
 * partner through the EXISTING account-creation deep link, and the Telegram
 * community button is gone from the page.
 *
 * What this suite pins:
 *   1. the exact destination on all three primary CTAs (topbar + hero + final)
 *   2. the exact CTA text ("Apply to Become a Partner" / final "Apply Now")
 *   3. the original translation key partners.cta.apply, restored in all six locales
 *   4. a real language switch re-renders the CTA (runtime, not just the dictionary)
 *   5. the Telegram-community CTA and its supporting copy are fully removed
 *   6. the page carries no external anchor and keeps Sign In / how-it-works / demo
 *   7. the partner-funnel attribution markers are still armed by a CTA click
 *   8. no primary CTA is hidden or clipped by CSS
 *   9. referral/commission rules and the registration flow are untouched
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

// The ORIGINAL application destination, unchanged since the page was created.
const APPLY_URL = '/?action=create-account&src=partners';
const APPLY_LABEL = 'Apply to Become a Partner';
const APPLY_NOW_LABEL = 'Apply Now';
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
 * Run the REAL inline script against a fake DOM whose two CTA nodes are the
 * elements applyTranslations() would rewrite, then read them back.
 */
function renderCta(lang) {
    const nodes = [
        { key: 'partners.cta.apply', innerHTML: APPLY_LABEL },
        { key: 'partners.cta.applyNow', innerHTML: APPLY_NOW_LABEL }
    ];
    const sandbox = {};
    sandbox.navigator = { languages: [lang === 'en' ? 'en-US' : lang], language: lang === 'en' ? 'en-US' : lang };
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
    return { lang: sandbox.__lang, apply: nodes[0].innerHTML, applyNow: nodes[1].innerHTML };
}

/* ==================================================================== *
 * 1. Destination
 * ==================================================================== */
test('1. all three primary CTAs use the existing account-creation deep link', () => {
    const ctas = PAGE.match(/<a class="btn btn-primary js-apply-cta"[^>]*>/g) || [];
    assert.strictEqual(ctas.length, 3, 'topbar + hero + final CTA');
    ctas.forEach((a) => {
        assert.ok(a.indexOf('href="' + APPLY_URL + '"') !== -1,
            'exact application destination expected: ' + a);
        assert.ok(!/target="_blank"/.test(a), 'the application CTA must stay in the same tab');
        assert.ok(!/rel="noopener/.test(a), 'no external-link rel is needed for an in-app destination');
        assert.ok(!/js-community-cta/.test(a), 'the community CTA class must be gone');
    });
    // The app shell still owns registration: no route or handler was added here.
    assert.match(INDEX, /action=create-account/, 'the app shell must still handle create-account');
    assert.match(SERVER, /app\.get\(\['\/partners', '\/partners\/'\]/, 'the /partners route must still exist');
});

/* ==================================================================== *
 * 2. Text
 * ==================================================================== */
test('2. the CTA text is "Apply to Become a Partner" and the final CTA is "Apply Now"', () => {
    assert.strictEqual(
        (PAGE.match(/data-i18n="partners\.cta\.apply"/g) || []).length, 2,
        'the topbar and hero CTAs use the original key');
    assert.strictEqual(PAGE.split('<span data-i18n="partners.cta.apply">' + APPLY_LABEL + '</span>').length - 1, 1,
        'the hero CTA carries the original label');
    assert.strictEqual(PAGE.split('>' + APPLY_LABEL + '</a>').length - 1, 1,
        'the topbar CTA carries the original label as its visible text');
    assert.strictEqual(PAGE.split('<span data-i18n="partners.cta.applyNow">' + APPLY_NOW_LABEL + '</span>').length - 1, 1,
        'the final CTA reads "Apply Now"');
    assert.strictEqual(T.en['partners.cta.apply'], APPLY_LABEL);
    assert.strictEqual(T.en['partners.cta.applyNow'], APPLY_NOW_LABEL);
});

/* ==================================================================== *
 * 3. Translations
 * ==================================================================== */
test('3. both CTA keys exist in all six locales and are translated', () => {
    assert.deepStrictEqual(Object.keys(T).sort(), LANGS.slice().sort(), 'the six locales must exist');

    const keySets = LANGS.map((l) => Object.keys(T[l]).sort().join('|'));
    assert.strictEqual(new Set(keySets).size, 1, 'identical key sets across locales');

    LANGS.forEach((lang) => {
        ['partners.cta.apply', 'partners.cta.applyNow'].forEach((key) => {
            const value = T[lang][key];
            assert.ok(typeof value === 'string' && value.trim(), lang + ' needs ' + key);
            if (lang !== 'en') {
                assert.notStrictEqual(value, T.en[key], lang + '/' + key + ' must be translated');
            }
        });
        assert.ok(Object.keys(T[lang]).every((k) => k.indexOf('partners.') === 0),
            lang + ' may only carry partners.* keys');
    });

    assert.ok(/[\u0600-\u06FF]/.test(T.ar['partners.cta.apply']), 'Arabic CTA must be in Arabic script');
    assert.ok(/[\u0600-\u06FF]/.test(T.ar['partners.cta.applyNow']), 'Arabic final CTA must be in Arabic script');
    assert.ok(/[\u4e00-\u9FFF]/.test(T.zh['partners.cta.apply']), 'Chinese CTA must be in Chinese script');
    assert.ok(/[\u4e00-\u9FFF]/.test(T.zh['partners.cta.applyNow']), 'Chinese final CTA must be in Chinese script');
});

test('4. a real language switch re-renders the CTA text', () => {
    LANGS.forEach((lang) => {
        const out = renderCta(lang);
        assert.strictEqual(out.lang, lang, 'currentLang must resolve to ' + lang);
        assert.strictEqual(out.apply, T[lang]['partners.cta.apply'],
            lang + ' must render its own apply label');
        assert.strictEqual(out.applyNow, T[lang]['partners.cta.applyNow'],
            lang + ' must render its own final label');
    });
    // An unsupported stored language falls back to English.
    const fallback = renderCta('de');
    assert.strictEqual(fallback.lang, 'en', 'an unsupported language must fall back to English');
    assert.strictEqual(fallback.apply, APPLY_LABEL);
});

/* ==================================================================== *
 * 4. The Telegram community CTA is gone
 * ==================================================================== */
test('5. the Telegram-community CTA and its supporting copy are removed', () => {
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
test('6. the page carries no external anchor and keeps the secondary CTAs', () => {
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

test('7. the partner-funnel attribution markers are still armed by a CTA click', () => {
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
test('8. no primary CTA is hidden, clipped or pinned to an external layout', () => {
    assert.ok(!/\.js-apply-cta[^{]*\{[^}]*display:\s*none/.test(PAGE),
        'the primary CTA must never be hidden by CSS');
    assert.ok(!/\.btn-primary[^{]*\{[^}]*visibility:\s*hidden/.test(PAGE),
        'no primary button may be hidden');
    assert.match(PAGE, /\.top-actions \.btn \{ flex: 1 1 45%; \}/,
        'the mobile topbar still lets the CTAs share the row');
    assert.match(PAGE, /\.hero-actions, \.bottom-cta \{ display: flex; flex-wrap: wrap;/,
        'the CTA rows still wrap on small screens');
});

test('9. the referral/commission terms and the registration flow are unchanged', () => {
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
