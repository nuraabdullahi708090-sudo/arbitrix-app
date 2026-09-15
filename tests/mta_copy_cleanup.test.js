'use strict';

/**
 * MTA copy cleanup - the "minimum trading balance" claim is gone.
 *
 * Two strings used to tell users they had to reach a minimum trading balance
 * before starting the bot, and the Terms of Service repeated the claim. The MTA
 * was removed, so the onboarding and FAQ copy now say the bot may be started
 * once the Live account is funded and the applicable eligibility requirements
 * are met - with no invented amount and no promise of uninterrupted operation.
 * The $500 withdrawal minimum is a DIFFERENT rule and must stay untouched.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const TOS = fs.readFileSync(path.join(__dirname, '..', 'public', 'terms-of-service.html'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
const KEYS = ['onboarding.secondaryDesc', 'landing.faq.a5'];
const FAQ = 'landing.faq.a5';
const SECONDARY = 'onboarding.secondaryDesc';

/* Stale MTA wording per locale - if any returns, this fails. */
const STALE = {
    en: ["minimum trading balance", "applicable minimum balance"],
    es: ["saldo m\u00ednimo de trading", "saldo m\u00ednimo aplicable"],
    pt: ["saldo m\u00ednimo de negocia\u00e7\u00e3o", "saldo m\u00ednimo aplic\u00e1vel"],
    fr: ["solde de trading minimum", "solde minimum applicable"],
    ar: ["\u0627\u0644\u062d\u062f \u0627\u0644\u0623\u062f\u0646\u0649 \u0644\u0631\u0635\u064a\u062f \u0627\u0644\u062a\u062f\u0627\u0648\u0644", "\u0627\u0644\u062d\u062f \u0627\u0644\u0623\u062f\u0646\u0649 \u0644\u0644\u062a\u0637\u0628\u064a\u0642"],
    zh: ["\u6700\u4f4e\u4ea4\u6613\u4f59\u989d", "\u9002\u7528\u6700\u4f4e\u4f59\u989d"],
};

/* The withdrawn condition-free phrasing (replaced in Stage 3B). */
const CONDITION_FREE = {
    en: "whenever you want",
    es: "cuando quieras",
    pt: "quando quiser",
    fr: "quand vous le souhaitez",
    ar: "\u0639\u0646\u062f\u0645\u0627 \u062a\u0631\u064a\u062f",
    zh: "\u968f\u65f6\u90fd\u53ef\u4ee5\u542f\u52a8\u673a\u5668\u4eba",
};

/* The required funding + eligibility meaning, per locale. */
const FUNDED = {
    en: "once your account is funded and you meet the applicable eligibility requirements",
    es: "una vez que tu cuenta est\u00e9 fondeada y cumplas con los requisitos de elegibilidad aplicables",
    pt: "assim que sua conta estiver financiada e voc\u00ea atender aos requisitos de elegibilidade aplic\u00e1veis",
    fr: "une fois votre compte approvisionn\u00e9 et les conditions d'\u00e9ligibilit\u00e9 applicables remplies",
    ar: "\u0628\u0639\u062f \u062a\u0645\u0648\u064a\u0644 \u062d\u0633\u0627\u0628\u0643 \u0648\u0627\u0633\u062a\u064a\u0641\u0627\u0626\u0643 \u0645\u062a\u0637\u0644\u0628\u0627\u062a \u0627\u0644\u0623\u0647\u0644\u064a\u0629 \u0627\u0644\u0645\u0639\u0645\u0648\u0644 \u0628\u0647\u0627",
    zh: "\u8d26\u6237\u8d44\u91d1\u5230\u4f4d\u5e76\u7b26\u5408\u9002\u7528\u8d44\u683c\u8981\u6c42\u540e\u5373\u53ef\u542f\u52a8\u673a\u5668\u4eba",
};

const NEW_EN_SECONDARY = "See the Live balance and what is required before you fund your account.";
const NEW_EN_FAQ = "Switch to Live Mode in the dashboard, fund your Live account with USDT (TRC20), and start the bot once your account is funded and you meet the applicable eligibility requirements. Arbitrix then automates eligible trades with your real funds.";
const TOS_OLD = "Live trading requires meeting minimum balance requirements";
const TOS_NEW = "Live trading is subject to the platform\u2019s funding and eligibility requirements disclosed in the app.";

function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    assert.ok(tIdx >= 0, 'TRANSLATIONS must exist');
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

function markupDefault(key) {
    const re = new RegExp('data-i18n="' + key.replace('.', '\\.') + '">([^<]*)<');
    const m = INDEX.match(re);
    assert.ok(m, 'markup default for ' + key + ' must exist');
    return m[1];
}

const T = loadTranslations();

test('dictionary parses and keeps an identical key set across the 6 locales', () => {
    const enKeys = Object.keys(T.en).sort();
    assert.ok(enKeys.length > 1000, 'dictionary still loaded in full');
    for (const lang of LANGS) {
        assert.ok(T[lang], lang + ' locale must exist');
        assert.deepStrictEqual(Object.keys(T[lang]).sort(), enKeys, lang + ' key set unchanged');
    }
});

test('both cleaned keys exist and are non-empty in every locale', () => {
    for (const lang of LANGS) {
        for (const key of KEYS) {
            const v = T[lang][key];
            assert.strictEqual(typeof v, 'string', lang + ' / ' + key + ' must be a string');
            assert.ok(v.trim().length > 20, lang + ' / ' + key + ' must stay a real sentence');
        }
    }
});

test('no locale claims a minimum trading balance in either key', () => {
    for (const lang of LANGS) {
        for (const key of KEYS) {
            for (const stale of STALE[lang]) {
                assert.ok(!T[lang][key].includes(stale), lang + ' / ' + key + ' must not contain: ' + stale);
            }
        }
    }
});

test('every locale states the funding + eligibility condition', () => {
    for (const lang of LANGS) {
        assert.ok(T[lang][FAQ].includes(FUNDED[lang]),
            lang + ' faq.a5 must state the funding/eligibility meaning');
    }
});

test('the withdrawn condition-free phrasing is gone from every locale', () => {
    for (const lang of LANGS) {
        assert.ok(!T[lang][FAQ].includes(CONDITION_FREE[lang]),
            lang + ' faq.a5 must no longer say: ' + CONDITION_FREE[lang]);
    }
});

test('no locale invents a replacement minimum amount', () => {
    for (const lang of LANGS) {
        for (const key of KEYS) {
            const v = T[lang][key];
            assert.ok(!v.includes('$') && !v.includes('\u20ac'), lang + ' / ' + key + ' must not quote an amount');
            assert.ok(!/\d/.test(v.split('USDT').join('').split('TRC20').join('')),
                lang + ' / ' + key + ' must not introduce a numeric threshold');
        }
    }
});

test('the guidance still tells the user to review the Live balance', () => {
    for (const lang of LANGS) {
        const v = T[lang][SECONDARY];
        assert.ok(/live/i.test(v), lang + ' secondaryDesc must still reference the Live balance');
    }
});

test('neither key promises continuous/background operation', () => {
    for (const lang of LANGS) {
        const v = T[lang][FAQ];
        assert.ok(!v.includes('24/7'), lang + ' faq.a5 must not claim 24/7 operation');
        assert.ok(!/background/i.test(v), lang + ' faq.a5 must not claim background operation');
    }
});

test('the two hard-coded markup defaults exactly match the EN dictionary', () => {
    assert.strictEqual(markupDefault(SECONDARY), T.en[SECONDARY]);
    assert.strictEqual(markupDefault(FAQ), T.en[FAQ]);
});

test('the reviewed English copy is pinned verbatim', () => {
    assert.strictEqual(T.en[SECONDARY], NEW_EN_SECONDARY);
    assert.strictEqual(T.en[FAQ], NEW_EN_FAQ);
});

test('no user-facing stale phrase remains in index.html (comments only)', () => {
    const lines = INDEX.split('\n');
    for (const lang of LANGS) {
        for (const stale of STALE[lang]) {
            for (const line of lines) {
                if (line.includes(stale)) {
                    assert.ok(line.trim().startsWith('//') || line.indexOf('//') < line.indexOf(stale),
                        'stale phrase outside a comment: ' + line.trim().slice(0, 90));
                }
            }
        }
    }
});

test('the Terms of Service no longer claims a minimum balance requirement', () => {
    assert.ok(!TOS.includes(TOS_OLD), 'the stale ToS minimum-balance claim must be gone');
    assert.ok(TOS.includes(TOS_NEW), 'the ToS must state the funding/eligibility wording');
    assert.ok(TOS.includes('You can start/stop bot operations at any time'), 'neighbour bullet intact');
    assert.ok(TOS.includes('Demo mode is available for practice without real funds'), 'neighbour bullet intact');
});

test('the $500 withdrawal minimum is untouched by this cleanup', () => {
    assert.ok(/const MIN_WITHDRAWAL_USD = 500;/.test(SERVER), 'server minimum stays $500');
    assert.ok(/MIN_WITHDRAWAL: 500/.test(INDEX), 'frontend minimum stays $500');
    assert.ok(!SERVER.includes('$700') && !INDEX.includes('$700'), 'no $700 remnant');
});
