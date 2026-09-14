'use strict';

/**
 * Landing-page testimonials: four country-authentic testimonials (Nigeria,
 * Netherlands, Brazil, Saudi Arabia) wired to the existing i18n system.
 *
 * These pin the things that can silently rot: the section actually rendering,
 * one card per country, authentic naming per country, localized names/locations
 * (the Saudi name in Arabic script for `ar`), honest copy (no fabricated profit
 * claims), the risk note, and full 6-locale key parity.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
const DICT_SIZE = 1416;
// 1404 keys/locale before this change = 1392 outside landing.testimonials.* plus
// the 12 pre-existing testimonial keys (tag, title, subtitle, 3 x text/name/role).
const BASE_OUTSIDE_TESTIMONIALS = 1392;

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
const SECTION = (() => {
    const start = INDEX.indexOf('<!-- TESTIMONIALS -->');
    const end = INDEX.indexOf('<!-- FAQ -->');
    assert.ok(start > 0 && end > start, 'the testimonials section must sit before the FAQ');
    return INDEX.slice(start, end);
})();

/* ------------------------------------------------------------------ *
 * 1. The section renders
 * ------------------------------------------------------------------ */
test('the landing page has a testimonials section with four cards', () => {
    assert.match(SECTION, /<section class="landing-testimonials" id="testimonials">/);
    assert.strictEqual((SECTION.match(/class="landing-testimonial-card"/g) || []).length, 4, 'four testimonial cards');
    assert.strictEqual((SECTION.match(/class="fas fa-star"/g) || []).length, 20, 'five stars per card');
    assert.match(SECTION, /data-i18n="landing\.testimonials\.tag"/);
    assert.match(SECTION, /data-i18n="landing\.testimonials\.title"/);
    assert.match(SECTION, /data-i18n="landing\.testimonials\.subtitle"/);
    assert.match(SECTION, /class="landing-testimonials-note" data-i18n="landing\.testimonials\.note"/);
    // the old section (removed in an earlier content pass) must not have come back twice
    assert.strictEqual((INDEX.match(/id="testimonials"/g) || []).length, 1);
});

test('each card carries a quote, initials, name, role and location', () => {
    for (const n of ['1', '2', '3', '4']) {
        ['text', 'initials', 'name', 'role', 'location'].forEach((f) => {
            assert.ok(SECTION.includes('data-i18n="landing.testimonials.' + n + '.' + f + '"'), n + '.' + f + ' must be wired');
        });
    }
    // the section is static markup only - no inline handlers or scripts
    assert.strictEqual(/onclick=|onerror=|<script/i.test(SECTION), false, 'pure markup, no inline handlers');
});

/* ------------------------------------------------------------------ *
 * 2. Country coverage + authentic names
 * ------------------------------------------------------------------ */
test('the four requested countries are represented', () => {
    const locations = ['1', '2', '3', '4'].map((n) => T.en['landing.testimonials.' + n + '.location']);
    assert.deepStrictEqual(locations, [
        'Lagos, Nigeria',
        'Utrecht, Netherlands',
        'S\u00e3o Paulo, Brazil',
        'Riyadh, Saudi Arabia',
    ]);
});

test('names are authentic for each country', () => {
    // Nigeria - Igbo given name + Igbo surname
    assert.strictEqual(T.en['landing.testimonials.1.name'], 'Chinedu Okafor');
    assert.match(T.en['landing.testimonials.1.name'], /^[A-Z][a-z]+ (Okafor|Okonkwo|Nwosu|Eze|Obi|Adeyemi|Balogun|Abubakar)$/);
    // Netherlands - Dutch given name + tussenvoegsel surname
    assert.strictEqual(T.en['landing.testimonials.2.name'], 'Sanne de Vries');
    assert.match(T.en['landing.testimonials.2.name'], /\b(de|van|van der|van den|van de)\b/);
    // Brazil - Portuguese given name + Portuguese surname
    assert.strictEqual(T.en['landing.testimonials.3.name'], 'Lucas Almeida');
    assert.match(T.en['landing.testimonials.3.name'], /^[A-Z][a-z]+ (Almeida|Silva|Santos|Ferreira|Souza|Costa|Oliveira)$/);
    // Saudi Arabia - Arabic given name + Al- family name
    assert.strictEqual(T.en['landing.testimonials.4.name'], 'Abdullah Al-Qahtani');
    assert.match(T.en['landing.testimonials.4.name'], /^[A-Z][a-z]+ Al-[A-Z][a-z]+$/);
});

test('names are never translated, except the Saudi name in Arabic script for ar', () => {
    LANGS.forEach((l) => {
        ['1', '2', '3'].forEach((n) => {
            assert.strictEqual(T[l]['landing.testimonials.' + n + '.name'], T.en['landing.testimonials.' + n + '.name'],
                l + ' must keep name ' + n + ' as written');
        });
        if (l !== 'ar') {
            assert.strictEqual(T[l]['landing.testimonials.4.name'], T.en['landing.testimonials.4.name'], l + ' keeps the Latin form');
        }
    });
    assert.strictEqual(T.ar['landing.testimonials.4.name'], '\u0639\u0628\u062f\u0627\u0644\u0644\u0647 \u0627\u0644\u0642\u062d\u0637\u0627\u0646\u064a');
    assert.strictEqual(T.ar['landing.testimonials.4.initials'], '\u0639');
    // the avatar initials track the displayed name
    assert.deepStrictEqual(['1', '2', '3', '4'].map((n) => T.en['landing.testimonials.' + n + '.initials']), ['CO', 'SV', 'LA', 'AA']);
});

test('cities and countries are localized', () => {
    assert.match(T.ar['landing.testimonials.1.location'], /\u0646\u064a\u062c\u064a\u0631\u064a\u0627/);      // نيجيريا
    assert.match(T.ar['landing.testimonials.2.location'], /\u0647\u0648\u0644\u0646\u062f\u0627/);          // هولندا
    assert.match(T.ar['landing.testimonials.3.location'], /\u0627\u0644\u0628\u0631\u0627\u0632\u064a\u0644/);// البرازيل
    assert.match(T.ar['landing.testimonials.4.location'], /\u0627\u0644\u0633\u0639\u0648\u062f\u064a\u0629/); // السعودية
    assert.match(T.zh['landing.testimonials.1.location'], /\u5c3c\u65e5\u5229\u4e9a/);                      // 尼日利亚
    assert.match(T.es['landing.testimonials.4.location'], /Arabia Saud/);
    assert.match(T.pt['landing.testimonials.3.location'], /Brasil/);
    assert.match(T.fr['landing.testimonials.2.location'], /Pays-Bas/);
});

/* ------------------------------------------------------------------ *
 * 3. Honest copy
 * ------------------------------------------------------------------ */
test('testimonials make no fabricated financial claims', () => {
    LANGS.forEach((l) => {
        ['1', '2', '3', '4'].forEach((n) => {
            const text = T[l]['landing.testimonials.' + n + '.text'];
            assert.ok(text.length > 40, l + '.' + n + ' must be a real quote');
            assert.strictEqual(/%/.test(text), false, l + '.' + n + ' must not quote a return percentage');
            assert.strictEqual(/\bguaranteed\b|\brisk[- ]free\b|\bpassive income\b/i.test(text), false, l + '.' + n + ' must not promise outcomes');
            // only the real, published price figure may appear
            (text.match(/\$\d+/g) || []).forEach((amount) => {
                assert.strictEqual(amount, '$7', l + '.' + n + ' may only cite the published $7 subscription price');
            });
        });
    });
    // the previous fabricated testimonials are gone
    ['Michael J.', 'Sarah C.', 'David K.', 'Up 23%', 'Join thousands of satisfied users'].forEach((s) => {
        assert.strictEqual(INDEX.includes(s), false, 'removed content must not return: ' + s);
    });
});

test('a risk note is shown and localized', () => {
    assert.match(T.en['landing.testimonials.note'], /results vary/i);
    assert.match(T.en['landing.testimonials.note'], /risk/i);
    LANGS.forEach((l) => assert.ok(T[l]['landing.testimonials.note'].length > 15, l + ' note must be localized'));
});

test('quotes reuse the canonical product terminology of every locale', () => {
    const TERMS = {
        en: { deposit: ['deposit'], withdraw: ['withdraw'], referral: ['referral'], bot: ['bot'] },
        es: { deposit: ['dep\u00f3sito', 'depositar'], withdraw: ['retiro', 'retirar'], referral: ['referido'], bot: ['bot'] },
        pt: { deposit: ['dep\u00f3sito', 'depositar'], withdraw: ['saque', 'sacar'], referral: ['indica'], bot: ['bot'] },
        fr: { deposit: ['d\u00e9p\u00f4t', 'd\u00e9poser'], withdraw: ['retrait', 'retirer'], referral: ['parrainage'], bot: ['bot'] },
        ar: { deposit: ['\u0625\u064a\u062f\u0627\u0639'], withdraw: ['\u0633\u062d\u0628'], referral: ['\u0627\u0644\u0625\u062d\u0627\u0644\u0629'], bot: ['\u0627\u0644\u0631\u0648\u0628\u0648\u062a'] },
        zh: { deposit: ['\u5165\u91d1'], withdraw: ['\u63d0\u73b0'], referral: ['\u63a8\u8350'], bot: ['\u673a\u5668\u4eba'] },
    };
    LANGS.forEach((l) => {
        const texts = ['1', '2', '3', '4'].map((n) => T[l]['landing.testimonials.' + n + '.text']).join(' ');
        const lower = texts.toLowerCase();
        // mode names are read from the landing's own tags, so they cannot drift
        assert.ok(texts.includes(T[l]['landing.compare.demo.tag']), l + ' must use its Demo Mode term (' + T[l]['landing.compare.demo.tag'] + ')');
        assert.ok(texts.includes(T[l]['landing.compare.live.tag']), l + ' must use its Live Mode term (' + T[l]['landing.compare.live.tag'] + ')');
        ['deposit', 'withdraw', 'referral', 'bot'].forEach((k) => {
            assert.ok(TERMS[l][k].some((t) => lower.includes(t.toLowerCase())), l + ' must use the site terminology for ' + k);
        });
    });
    // technical/financial tokens are never translated
    ['es', 'pt', 'fr', 'ar', 'zh'].forEach((l) => {
        assert.match(T[l]['landing.testimonials.3.text'], /USDT/);
        assert.match(T[l]['landing.testimonials.3.text'], /TRON/);
    });
});

/* ------------------------------------------------------------------ *
 * 4. i18n integrity
 * ------------------------------------------------------------------ */
test('i18n parity: identical key sets, no empties, all testimonials keys present', () => {
    assert.strictEqual(new Set(LANGS.map((l) => Object.keys(T[l]).sort().join('|'))).size, 1, 'identical key sets');
    LANGS.forEach((l) => {
        assert.strictEqual(Object.keys(T[l]).length, DICT_SIZE, l + ' key count');
        Object.values(T[l]).forEach((v) => assert.ok(String(v).trim(), l + ' has an empty value'));
    });
});

test('this change only added landing.testimonials.* keys', () => {
    LANGS.forEach((l) => {
        const outside = Object.keys(T[l]).filter((k) => !k.startsWith('landing.testimonials.'));
        assert.strictEqual(outside.length, BASE_OUTSIDE_TESTIMONIALS, l + ': no key outside landing.testimonials.* was added or removed');
    });
    LANGS.forEach((l) => {
        for (const n of ['1', '2', '3', '4']) {
            for (const f of ['text', 'name', 'role', 'initials', 'location']) {
                assert.ok(T[l]['landing.testimonials.' + n + '.' + f], l + ' missing ' + n + '.' + f);
            }
        }
    });
    assert.strictEqual(INDEX.match(/'landing\.testimonials\.[1-4]\.(text|name|role|initials|location)'/g).length % 6, 0, 'every key is defined once per locale');
});

/* ------------------------------------------------------------------ *
 * 5. Layout safety
 * ------------------------------------------------------------------ */
test('the grid supports four cards and cannot overflow on mobile', () => {
    const css = INDEX.slice(INDEX.indexOf('.landing-testimonials {'), INDEX.indexOf('.landing-testimonials-note {') + 400);
    assert.match(css, /grid-template-columns: repeat\(4, 1fr\)/, 'four columns on desktop');
    assert.match(css, /min-width: 0/, 'grid cards may shrink (prevents overflow with long names)');
    assert.match(css, /overflow-wrap: anywhere/, 'long words wrap instead of overflowing');
    // the existing responsive rules still stack the cards
    const tablet = INDEX.slice(INDEX.indexOf('@media (max-width: 1024px)'), INDEX.indexOf('@media (max-width: 1024px)') + 1400);
    assert.match(tablet, /\.landing-testimonials-grid \{\s*grid-template-columns: repeat\(2, 1fr\)/, 'two columns on tablet');
    const mobile = INDEX.slice(INDEX.indexOf('@media (max-width: 768px)'), INDEX.indexOf('@media (max-width: 768px)') + 1400);
    assert.match(mobile, /\.landing-testimonials-grid \{\s*grid-template-columns: 1fr/, 'one column on mobile');
    assert.match(INDEX, /\.landing-testimonials-note \{/, 'the risk note has styling');
});

test('the change touches no application logic', () => {
    // the section is display-only: no auth, payment, wallet or API usage added
    assert.strictEqual(/fetch\(|localStorage|Authorization/.test(SECTION), false);
    // and the existing translated sections are untouched
    assert.match(T.en['landing.faq.q1'], /Arbitrix/i);
    assert.match(T.en['landing.compare.live.tag'], /Live/);
});
