'use strict';

/**
 * /partners walkthrough-video LOCALIZATION tests.
 *
 * The /partners page stays ONE shared landing page. The partner payout
 * walkthrough recording is chosen by the active locale, and a locale whose
 * localized asset does not exist yet falls back to the English recording, so a
 * not-yet-produced translation can never show a broken player.
 *
 * Why this file exists:
 *   - only the English recording ships today; the other locales are FUTURE asset
 *     paths (no placeholder file may be created);
 *   - the English behaviour must stay byte-identical (no source mutation / no
 *     reload for `en`);
 *   - fallback is a hard requirement, not a nicety;
 *   - the existing language mechanism (the shared 'arbi_lang' localStorage key +
 *     detectBrowserLanguage/applyTranslations) is reused - no second i18n system.
 *
 * Static source checks + a vm run of the REAL inline script against a fake DOM.
 * No network, no database, no server boot.
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
const PAGE_PATH = path.join(ROOT, 'public', 'partners.html');
const PAGE = fs.readFileSync(PAGE_PATH, 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
const EXPECTED_KEYS = 84;

const VIDEO_BASE = '/video/';
const EN_VIDEO = '/video/arbitrix-partner-payout-demo.mp4';
const EN_POSTER = '/video/arbitrix-partner-payout-poster.jpg';

// The English assets are frozen by this change: the task requires the existing
// English recording to remain exactly as it is. (Updating the recording is a
// deliberate, separate decision that must update these pins.)
const EN_VIDEO_SHA256 = '85a3f42fb511934c193b389e3018986e3df00441d2a762b2d4d9fd4c8fd38922';
const EN_VIDEO_SIZE = 3040368;
const EN_POSTER_SHA256 = '800576039903cd616fb8827c7afa4be941a41f8ef951223c12f03347b5673f4d';
const EN_POSTER_SIZE = 85419;

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
function extractScript(html) {
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'the page must ship one inline <script>');
    return m[1];
}

function loadTranslations(html) {
    const script = extractScript(html);
    const tIdx = script.indexOf('const TRANSLATIONS');
    assert.ok(tIdx >= 0, 'the page must define const TRANSLATIONS');
    let i = script.indexOf('{', tIdx), depth = 0, end = -1;
    for (; i < script.length; i++) {
        if (script[i] === '{') depth++;
        else if (script[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(script.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

/** A minimal fake media element tree that records attribute mutations. */
function makeFakeVideo() {
    const sourceEl = {
        attrs: { src: EN_VIDEO },
        listeners: {},
        getAttribute(k) { return this.attrs[k]; },
        setAttribute(k, v) { this.attrs[k] = v; },
        addEventListener(t, f) { this.listeners[t] = f; },
        removeEventListener(t, f) { if (this.listeners[t] === f) delete this.listeners[t]; }
    };
    const video = {
        attrs: { poster: EN_POSTER },
        listeners: {},
        loads: 0,
        getAttribute(k) { return this.attrs[k]; },
        setAttribute(k, v) { this.attrs[k] = v; },
        querySelector(sel) { return sel === 'source' ? sourceEl : null; },
        addEventListener(t, f) { this.listeners[t] = f; },
        removeEventListener(t, f) { if (this.listeners[t] === f) delete this.listeners[t]; },
        load() { this.loads++; }
    };
    return { video, sourceEl };
}

/**
 * Run the page's REAL inline script with the given stored locale and a fake
 * media element. `lang` is what localStorage returns (the resolved locale).
 */
function runPageVideo(lang, opts) {
    opts = opts || {};
    const { video, sourceEl } = makeFakeVideo();
    const stored = {};
    if (opts.storedLang !== undefined) stored['arbi_lang'] = opts.storedLang;

    const sandbox = {};
    sandbox.navigator = { languages: [opts.browserLang || 'en-US'], language: opts.browserLang || 'en-US' };
    sandbox.localStorage = {
        store: stored,
        getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
        setItem(k, v) { this.store[k] = v; }
    };
    sandbox.sessionStorage = { setItem() {} };
    sandbox.console = console;
    sandbox.document = {
        documentElement: {},
        title: '',
        querySelectorAll(sel) {
            // Return nothing for the i18n pass; the media path uses getElementById.
            return [];
        },
        querySelector(sel) {
            if (String(sel).indexOf('arbitrix-partner-support-telegram') !== -1) {
                return { getAttribute: () => '@Arbitrix_CSA1' };
            }
            return null;
        },
        getElementById(id) { return id === 'demoVideo' ? video : null; },
        addEventListener() {}
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        extractScript(PAGE) +
        ';globalThis.__srcFor = partnerVideoSrcForLang;' +
        'globalThis.__posterFor = partnerPosterSrcForLang;' +
        'globalThis.__fallbackSrc = PARTNER_VIDEO_FALLBACK_SRC;' +
        'globalThis.__fallbackPoster = PARTNER_POSTER_FALLBACK_SRC;' +
        'globalThis.__videoMap = PARTNER_VIDEO_FILE_BY_LANG;' +
        'globalThis.__apply = function(){ applyPartnerVideo(); };' +
        'globalThis.__setLanguage = function(l){ setLanguage(l); };' +
        'globalThis.__lang = function(){ return currentLang; };',
        sandbox
    );
    return { sandbox, video, sourceEl };
}

const T = loadTranslations(PAGE);

/* ------------------------------------------------------------------ *
 * 1. English uses the existing English recording, unchanged
 * ------------------------------------------------------------------ */
test('1. the English locale loads the existing English recording', () => {
    assert.strictEqual(runPageVideo('en').sandbox.__srcFor('en'), EN_VIDEO,
        'en must map to the existing English recording');
    assert.strictEqual(runPageVideo('en').sandbox.__posterFor('en'), EN_POSTER,
        'en must map to the existing English poster');
});

test('1b. English leaves the shipped markup untouched (no source mutation, no reload)', () => {
    const { sandbox, video, sourceEl } = runPageVideo('en', { storedLang: 'en' });
    assert.strictEqual(sandbox.__lang(), 'en', 'the English locale must resolve to en');
    assert.strictEqual(sourceEl.attrs.src, EN_VIDEO, 'the English source must not change');
    assert.strictEqual(video.attrs.poster, EN_POSTER, 'the English poster must not change');
    assert.strictEqual(video.loads, 0, 'English must not reload the player');
    assert.strictEqual(video.attrs['data-video-lang'], 'en', 'the applied video locale must be recorded');
});

test('1c. the shipped markup still carries the single English <video>/<source>', () => {
    assert.strictEqual((PAGE.match(/<video\b/gi) || []).length, 1, 'exactly one <video> element');
    assert.strictEqual((PAGE.match(/<source\b/gi) || []).length, 1, 'exactly one <source> element');
    assert.match(PAGE, /<source src="\/video\/arbitrix-partner-payout-demo\.mp4" type="video\/mp4">/);
    assert.match(PAGE, /poster="\/video\/arbitrix-partner-payout-poster\.jpg"/);
});

/* ------------------------------------------------------------------ *
 * 2. Every supported locale has a defined video + poster mapping
 * ------------------------------------------------------------------ */
test('2. every supported locale has a defined video mapping', () => {
    const { sandbox } = runPageVideo('en');
    const seen = new Set();
    LANGS.forEach((l) => {
        const src = sandbox.__srcFor(l);
        assert.ok(typeof src === 'string' && src.length > 0, l + ' must map to a non-empty video path');
        assert.ok(src.startsWith(VIDEO_BASE), l + ' video must live under /video/');
        assert.ok(/\.mp4$/.test(src), l + ' video must be an .mp4');
        assert.strictEqual(seen.has(src), false, l + ' must have its own distinct video path');
        seen.add(src);
    });
    assert.strictEqual(sandbox.__srcFor('en'), EN_VIDEO, 'en maps to the shipped English recording');
});

test('2b. every supported locale has a defined poster mapping', () => {
    const { sandbox } = runPageVideo('en');
    const seen = new Set();
    LANGS.forEach((l) => {
        const poster = sandbox.__posterFor(l);
        assert.ok(typeof poster === 'string' && /^\/video\/.+\.jpg$/.test(poster),
            l + ' must map to a .jpg poster under /video/');
        assert.strictEqual(seen.has(poster), false, l + ' poster path must be distinct');
        seen.add(poster);
    });
    assert.strictEqual(sandbox.__posterFor('en'), EN_POSTER, 'en maps to the shipped English poster');
});

test('2c. the locale map covers all six supported locales exactly', () => {
    const { sandbox } = runPageVideo('en');
    assert.deepStrictEqual(Object.keys(sandbox.__videoMap).sort(), LANGS.slice().sort(),
        'the mapping must define exactly the six supported locales');
});

/* ------------------------------------------------------------------ *
 * 3. The non-English assets are FUTURE paths - no fake files were created
 * ------------------------------------------------------------------ */
test('3. no localized asset file was created (only the English recording exists)', () => {
    const { sandbox } = runPageVideo('en');
    LANGS.forEach((l) => {
        const rel = 'public' + sandbox.__srcFor(l);
        if (l === 'en') {
            assert.ok(fs.existsSync(path.join(ROOT, rel)), 'the English recording must exist');
        } else {
            assert.ok(!fs.existsSync(path.join(ROOT, rel)),
                'the ' + l + ' recording must NOT exist yet (defined as a future path only)');
        }
    });
});

/* ------------------------------------------------------------------ *
 * 4. Fallback: a missing localized asset reverts to English
 * ------------------------------------------------------------------ */
test('4. a missing localized asset falls back to the English recording', () => {
    for (const l of LANGS.filter((x) => x !== 'en')) {
        const { sandbox, video, sourceEl } = runPageVideo(l, { storedLang: l });
        assert.strictEqual(sandbox.__lang(), l, 'the locale must resolve to ' + l);
        // The localized asset is attempted...
        assert.strictEqual(sourceEl.attrs.src, sandbox.__srcFor(l), l + ' must try its localized asset');
        assert.strictEqual(video.loads, 1, l + ' must (re)start the player for its localized asset');
        // ...and when it fails to load, the player reverts to English.
        assert.ok(typeof sourceEl.listeners.error === 'function', l + ' must wire an error fallback');
        sourceEl.listeners.error();
        assert.strictEqual(sourceEl.attrs.src, EN_VIDEO, l + ' must fall back to the English video');
        assert.strictEqual(video.attrs.poster, EN_POSTER, l + ' must fall back to the English poster');
        assert.strictEqual(video.attrs['data-video-lang'], 'en', l + ' must record the English fallback');
        assert.strictEqual(video.loads, 2, l + ' must reload the player with the fallback');
    }
});

test('4b. the fallback asset itself really exists (so the fallback is never broken)', () => {
    const { sandbox } = runPageVideo('en');
    assert.strictEqual(sandbox.__fallbackSrc, EN_VIDEO, 'the fallback source must be the English recording');
    assert.strictEqual(sandbox.__fallbackPoster, EN_POSTER, 'the fallback poster must be the English poster');
    assert.ok(fs.existsSync(path.join(ROOT, 'public', EN_VIDEO)), 'the fallback video must exist on disk');
    assert.ok(fs.statSync(path.join(ROOT, 'public', EN_VIDEO)).size > 10000, 'the fallback video must be real');
});

test('4c. the error fallback is one-shot (no reload loop)', () => {
    const { video, sourceEl } = runPageVideo('es', { storedLang: 'es' });
    sourceEl.listeners.error();
    assert.strictEqual(typeof sourceEl.listeners.error, 'undefined', 'the source error listener must be removed');
    assert.strictEqual(typeof video.listeners.error, 'undefined', 'the element error listener must be removed');
    assert.strictEqual(typeof video.listeners.loadedmetadata, 'undefined', 'the load listener must be removed');
    assert.strictEqual(video.loads, 2, 'the fallback reload happens exactly once');
    // A second late error cannot re-trigger a swap through a stale handler.
    const before = sourceEl.attrs.src;
    if (sourceEl.listeners.error) sourceEl.listeners.error();
    assert.strictEqual(sourceEl.attrs.src, before, 'no further source change may occur');
});

test('4d. a real localized asset is adopted (poster swapped only after it loads)', () => {
    const { sandbox, video, sourceEl } = runPageVideo('es', { storedLang: 'es' });
    // Until the localized asset confirms it exists, the English poster is kept,
    // so the player never shows a blank/broken frame.
    assert.strictEqual(video.attrs.poster, EN_POSTER, 'the English poster is kept while loading');
    assert.strictEqual(sourceEl.attrs.src, sandbox.__srcFor('es'), 'the localized source is attempted');
    assert.ok(typeof video.listeners.loadedmetadata === 'function', 'a successful-load handler must be wired');
    // The localized asset loaded: adopt its localized poster + locale.
    video.listeners.loadedmetadata();
    assert.strictEqual(video.attrs.poster, sandbox.__posterFor('es'), 'the localized poster is adopted on load');
    assert.strictEqual(video.attrs['data-video-lang'], 'es', 'the localized video locale is recorded');
    assert.strictEqual(sourceEl.attrs.src, sandbox.__srcFor('es'), 'the localized source is kept (no fallback)');
    assert.strictEqual(typeof sourceEl.listeners.error, 'undefined', 'the fallback handler is retired after load');
    assert.strictEqual(video.loads, 1, 'no extra reload occurs on a successful load');
});

/* ------------------------------------------------------------------ *
 * 5. No broken video source is emitted for any locale
 * ------------------------------------------------------------------ */
test('5. every locale resolves to a valid, non-empty video source', () => {
    const { sandbox } = runPageVideo('en');
    LANGS.forEach((l) => {
        const src = sandbox.__srcFor(l);
        assert.ok(src && src !== 'undefined' && !/null/.test(src), l + ' must never resolve to a broken source');
        assert.ok(src === EN_VIDEO || /^\/video\/arbitrix-partner-payout-demo-[a-z]{2}\.mp4$/.test(src),
            l + ' must resolve to the English asset or a documented future asset');
    });
    // Unknown locales resolve to the English fallback rather than a broken path.
    ['de', 'it', 'ja', '', undefined, null, 'xx'].forEach((bad) => {
        assert.strictEqual(sandbox.__srcFor(bad), EN_VIDEO, 'an unsupported locale must fall back to English');
    });
});

/* ------------------------------------------------------------------ *
 * 6. Language selection reuses the existing mechanism
 * ------------------------------------------------------------------ */
test('6. the page exposes a language selector with all six locales', () => {
    assert.match(PAGE, /class="language-selector"/, 'a .language-selector must exist');
    assert.match(PAGE, /class="lang-trigger"/, 'the selector must reuse the app .lang-trigger convention');
    assert.strictEqual((PAGE.match(/class="language-option"/g) || []).length, 6,
        'exactly six locale options must be exposed');
    LANGS.forEach((l) => {
        assert.ok(PAGE.includes('data-lang="' + l + '"'), 'the ' + l + ' option must be present');
        assert.ok(PAGE.includes("setLanguage('" + l + "')"), 'the ' + l + ' option must switch via setLanguage');
    });
});

test('6b. locale changes persist through the shared arbi_lang key (no second i18n system)', () => {
    const { sandbox } = runPageVideo('en', { storedLang: 'en' });
    sandbox.__setLanguage('es');
    assert.strictEqual(sandbox.__lang(), 'es', 'setLanguage must update the active locale');
    assert.strictEqual(sandbox.localStorage.store['arbi_lang'], 'es',
        'the choice must persist through the shared arbi_lang key');
    // Index.html uses the same key, so a choice carries across the pages.
    assert.ok(INDEX.includes("'arbi_lang'"), 'the app must still use the same arbi_lang key');
});

test('6c. an unsupported locale request cannot break the page', () => {
    const { sandbox } = runPageVideo('en', { storedLang: 'en' });
    sandbox.__setLanguage('zz');
    assert.strictEqual(sandbox.__lang(), 'en', 'an unsupported locale must resolve to en');
    assert.strictEqual(sandbox.__srcFor(sandbox.__lang()), EN_VIDEO);
});

/* ------------------------------------------------------------------ *
 * 7. Live locale switch updates the video (the page does not reload)
 * ------------------------------------------------------------------ */
test('7. switching locale updates the video source and then falls back when missing', () => {
    const { sandbox, video, sourceEl } = runPageVideo('en', { storedLang: 'en' });
    assert.strictEqual(sourceEl.attrs.src, EN_VIDEO, 'starts on the English recording');
    sandbox.__setLanguage('fr');
    assert.strictEqual(sandbox.__lang(), 'fr', 'the locale switches to French');
    assert.strictEqual(sourceEl.attrs.src, sandbox.__srcFor('fr'), 'the French asset is attempted');
    assert.strictEqual(video.attrs.poster, EN_POSTER, 'the English poster is kept until the French asset loads');
    sourceEl.listeners.error();
    assert.strictEqual(sourceEl.attrs.src, EN_VIDEO, 'the missing French asset falls back to English');
    assert.strictEqual(video.attrs.poster, EN_POSTER, 'the English poster still stands after the fallback');
    // Switching back to English restores the English source exactly.
    sandbox.__setLanguage('en');
    assert.strictEqual(sourceEl.attrs.src, EN_VIDEO, 'switching back to en keeps the English recording');
});

/* ------------------------------------------------------------------ *
 * 8. Existing partner page content + rules are preserved
 * ------------------------------------------------------------------ */
test('8. the six-locale dictionary is unchanged by this feature (no new keys)', () => {
    LANGS.forEach((l) => {
        assert.strictEqual(Object.keys(T[l]).length, EXPECTED_KEYS,
            l + ' must still define ' + EXPECTED_KEYS + ' keys');
    });
    // The language names live in the selector markup (static, like the app),
    // not in the translations dictionary.
    assert.ok(!('partners.language' in T.en), 'the selector must not add dictionary keys');
});

test('8b. the walkthrough disclosure and workflow remain intact', () => {
    assert.match(PAGE, /data-i18n="partners\.demoDisclosureTitle"/);
    assert.match(PAGE, /data-i18n="partners\.demoDisclosureBody"/);
    assert.match(PAGE, /class="demo-disclosure"/);
    ['Partner', 'Referral', '$100 qualifying deposit', '$20 reward', 'Request payout', 'USDT / TRC20']
        .forEach((s) => assert.ok(PAGE.includes(s), 'workflow step preserved: ' + s));
});

test('8c. the partner business rules are untouched in every locale', () => {
    // The wording must still state the approved model (20% / first qualifying
    // deposit / $100 / no trading requirement / no minimum payout / USDT TRC20).
    LANGS.forEach((l) => {
        assert.ok(/20%/.test(T[l]['partners.step3Desc']), l + ' must keep the 20% reward');
        assert.ok(/\$100/.test(T[l]['partners.step3Desc']), l + ' must keep the $100 minimum');
    });
    assert.ok(/no trading required/i.test(T.en['partners.chip.noTrading']), 'EN: no trading required');
    assert.ok(/no minimum payout/i.test(T.en['partners.chip.noMinimum']), 'EN: no minimum payout');
    assert.match(T.en['partners.chip.asset'], /USDT \/ TRC20/, 'EN: USDT / TRC20');
});

/* ------------------------------------------------------------------ *
 * 9. One shared page + the English assets are untouched
 * ------------------------------------------------------------------ */
test('9. there is still exactly one shared /partners page', () => {
    const htmlFiles = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
    assert.deepStrictEqual(htmlFiles.filter((f) => /^partners.*\.html$/.test(f)), ['partners.html'],
        'no per-locale partners page may be added');
    assert.strictEqual((PAGE.match(/<script\b/gi) || []).length, 1, 'the page stays a single self-contained script');
});

test('9b. the shared page never loads per-locale video files eagerly', () => {
    // Only ONE <source> may exist in the markup: the page must not ship one
    // <source> per locale (that would emit broken sources for missing assets).
    assert.strictEqual((PAGE.match(/<source\b/gi) || []).length, 1);
});

test('9c. the English recording and poster are byte-for-byte unchanged', () => {
    const video = fs.readFileSync(path.join(ROOT, 'public', EN_VIDEO));
    const poster = fs.readFileSync(path.join(ROOT, 'public', EN_POSTER));
    assert.strictEqual(crypto.createHash('sha256').update(video).digest('hex'), EN_VIDEO_SHA256,
        'the English recording must not be modified');
    assert.strictEqual(video.length, EN_VIDEO_SIZE, 'the English recording size must not change');
    assert.strictEqual(crypto.createHash('sha256').update(poster).digest('hex'), EN_POSTER_SHA256,
        'the English poster must not be modified');
    assert.strictEqual(poster.length, EN_POSTER_SIZE, 'the English poster size must not change');
});

/* ------------------------------------------------------------------ *
 * 10. Scope guards: no funnel / API / server change
 * ------------------------------------------------------------------ */
test('10. the page stays static and session-free (no API / fetch / form)', () => {
    // The feature is presentation-only: no new network calls or inputs.
    assert.ok(!/\/api\//.test(PAGE), 'the page must not call any API');
    assert.ok(!/\bfetch\s*\(/.test(PAGE), 'the page must not call fetch');
    assert.ok(!/XMLHttpRequest/.test(PAGE), 'the page must not use XHR');
    assert.ok(!/<form\b/i.test(PAGE), 'the page must not contain a form');
});

test('10b. the support single-source handle is untouched', () => {
    assert.strictEqual(PAGE.split('@Arbitrix_CSA1').length - 1, 1,
        'the partner support handle literal must still appear exactly once');
    assert.strictEqual((PAGE.match(/t\.me\//g) || []).length, 1,
        'only the single programmatic t.me builder may exist');
});
