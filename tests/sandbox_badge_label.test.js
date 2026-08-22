'use strict';

/**
 * MARKETING SANDBOX badge label — regression tests.
 *
 * The visible MARKETING_SANDBOX badge text was changed from "MARKETING DEMO"
 * to "PREVIEW" (label-only change). Pins:
 *  - the `sandbox.badge` key renders a PREVIEW-equivalent label in all 6
 *    locales (and no longer says "MARKETING DEMO"-equivalents);
 *  - the badge render path still uses the i18n key (t('sandbox.badge')) —
 *    the label is NOT hardcoded;
 *  - the internal environment classification string 'MARKETING_SANDBOX' is
 *    unchanged everywhere it gates behavior (frontend + server);
 *  - badge styling/positioning hooks (incl. RTL) are unchanged;
 *  - production accounts see NO badge (display gated on MARKETING_SANDBOX).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Extract the real TRANSLATIONS object by brace matching (same approach as
// tests/multilingual_layout.test.js).
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
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext('this.T = ' + blk.slice(blk.indexOf('{', start), end + 1), sandbox);
    return sandbox.T;
}

const EXPECTED = {
    en: 'PREVIEW',
    es: 'VISTA PREVIA',
    pt: 'PRÉ-VISUALIZAÇÃO',
    fr: 'APERÇU',
    ar: 'معاينة',
    zh: '预览',
};

test('sandbox.badge renders the PREVIEW label in all 6 locales', () => {
    const T = loadTranslations();
    for (const [lang, label] of Object.entries(EXPECTED)) {
        assert.ok(T[lang], `locale ${lang} missing`);
        assert.strictEqual(T[lang]['sandbox.badge'], label, `${lang} sandbox.badge`);
        assert.ok(!/MARKETING/i.test(T[lang]['sandbox.badge']), `${lang} badge must not say MARKETING`);
    }
});

test('badge text comes from the i18n key, not a hardcoded string', () => {
    const fn = INDEX.match(/function updateSandboxBadge\(\) \{[\s\S]*?\n    \}/);
    assert.ok(fn, 'updateSandboxBadge missing');
    assert.ok(fn[0].includes("t('sandbox.badge')"), 'badge must render via t(sandbox.badge)');
    assert.ok(fn[0].includes('data-i18n="sandbox.badge"'), 'badge span must carry the i18n key');
});

test('badge visibility is gated on the unchanged MARKETING_SANDBOX classification', () => {
    const fn = INDEX.match(/function updateSandboxBadge\(\) \{[\s\S]*?\n    \}/);
    assert.ok(fn[0].includes("APP.environment === 'MARKETING_SANDBOX'"), 'badge display gate unchanged');
    // production accounts therefore see no badge: display is set to none otherwise
    assert.ok(fn[0].includes("badge.style.display = 'none'"), 'badge hidden for non-sandbox');
});

test('internal MARKETING_SANDBOX classification is unchanged', () => {
    assert.match(SERVER, /const ENV_MARKETING_SANDBOX = 'MARKETING_SANDBOX';/, 'server classification constant unchanged');
    assert.ok(INDEX.includes("environment: 'PRODUCTION'"), 'frontend default environment unchanged');
    // the badge key rename must not touch the environment string anywhere as a value
    assert.ok(!INDEX.includes("environment: 'PREVIEW'"), 'environment classification must not be renamed');
});

test('badge styling + RTL positioning hooks are unchanged', () => {
    const el = INDEX.match(/<div id="sandboxBadge"[^>]*><\/div>/);
    assert.ok(el, 'sandboxBadge element missing');
    assert.ok(el[0].includes('position:fixed'), 'badge stays fixed');
    assert.ok(el[0].includes('right:12px'), 'badge stays right-positioned (LTR)');
    assert.ok(el[0].includes('pointer-events:none'), 'badge stays non-interactive');
    assert.ok(INDEX.includes('html[dir="rtl"] #sandboxBadge{right:auto !important;left:12px !important;}'), 'RTL flip intact');
});

test('no stray old MARKETING DEMO label remains in user-visible strings', () => {
    // i18n values
    assert.ok(!/'sandbox\.badge': '[^']*MARKETING/i.test(INDEX), 'badge value must not say MARKETING DEMO');
    assert.ok(!/'sandbox\.admin\.showBadge': 'Show Marketing Demo Badge'/.test(INDEX), 'admin show-badge label updated');
});

test('translation key parity is preserved (identical key sets, no empty values)', () => {
    const T = loadTranslations();
    const enKeys = Object.keys(T.en).sort();
    for (const lang of ['es', 'pt', 'fr', 'ar', 'zh']) {
        assert.deepStrictEqual(Object.keys(T[lang]).sort(), enKeys, `${lang} key set differs from en`);
        for (const k of enKeys) {
            assert.ok(String(T[lang][k]).length > 0, `${lang}.${k} must not be empty`);
        }
    }
});
