'use strict';

/**
 * Regression protection for the rebrand release gate (L2).
 *
 * The gate previously scanned only the ASCII string "Arbitrix" inside the six
 * dictionaries. Four real, customer-visible defects shipped past it:
 *
 *   1. "Become an Kalderix Referral Partner" in the partners page <title>/OG;
 *   2. "Already have an Kalderix account?" on the login screen;
 *   3. "linked to an Kalderix account" in the support bot replies;
 *   4. the Arabic login/signup subtitles, which kept the OLD brand's Arabic
 *      spelling (أربيتريكس) while every other Arabic string said Kalderix.
 *
 * These tests prove the gate now catches each class, still ignores legitimate
 * references (legal entity, domains, handles, historical transaction text), and
 * passes on the corrected tree.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const lint = require(path.join(ROOT, 'scripts', 'lib', 'rebrand-lint'));
const fixtures = require(path.join(ROOT, 'scripts', 'lib', 'rebrand-fixtures'));
const BRAND = require(path.join(ROOT, 'services', 'brand.js')).BRAND;

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// The detectors themselves
// ---------------------------------------------------------------------------

test('every regression fixture is classified as expected', () => {
  const result = fixtures.runFixtures(lint, BRAND.name);
  const bad = result.results.filter((r) => !r.ok);
  assert.deepStrictEqual(bad, [], 'misclassified fixtures: ' + bad.map((b) => b.label).join(', '));
  assert.ok(result.results.length >= 20, 'the fixture set covers all three detector families');
});

test('the previously-missed English defects are detected', () => {
  const cases = [
    'Become an Kalderix Referral Partner',
    'Already have an Kalderix account? Sign in.',
    'This chat is not linked to an Kalderix account.'
  ];
  for (const text of cases) {
    assert.ok(lint.detectArticleDefects(text, BRAND.name).length > 0, 'not flagged: ' + text);
  }
});

test('the previously-missed Arabic defect is detected', () => {
  const arabic = '\u0647\u0644 \u0644\u062f\u064a\u0643 \u062d\u0633\u0627\u0628 \u0641\u064a \u0623\u0631\u0628\u064a\u062a\u0631\u064a\u0643\u0633 \u0628\u0627\u0644\u0641\u0639\u0644\u061f';
  const hits = lint.detectOldBrand(arabic);
  assert.strictEqual(hits.length, 1, 'the Arabic old-brand spelling must be flagged');
});

test('metadata defects in <title>, og:title and twitter:title are detected', () => {
  const html = [
    '<title>Become an Kalderix Referral Partner | Kalderix</title>',
    '<meta property="og:title" content="Become an Kalderix Referral Partner">',
    '<meta name="twitter:title" content="Become an Kalderix Referral Partner">'
  ].join('\n');
  const defects = lint.detectMetadataDefects(html, { brand: BRAND.name });
  const tags = defects.map((d) => d.tag).sort();
  assert.deepStrictEqual(tags, ['og:title', 'title', 'twitter:title']);
});

test('locale defects: key-set drift, empties and placeholder mismatch are detected', () => {
  const missing = lint.detectLocaleDefects({ en: { a: 'x', b: 'y' }, ar: { a: 'x' } }, { brand: BRAND.name });
  assert.ok(missing.some((d) => d.reason.startsWith('missing key')), 'a missing key must be reported');
  const empties = lint.detectLocaleDefects({ en: { a: 'x' }, ar: { a: '' } }, { brand: BRAND.name });
  assert.ok(empties.some((d) => d.reason === 'empty translation'), 'an empty translation must be reported');
  const ph = lint.detectLocaleDefects({ en: { a: 'Pay ${{min}}' }, ar: { a: 'Pay' } }, { brand: BRAND.name });
  assert.ok(ph.some((d) => d.reason.startsWith('placeholder mismatch')), 'a placeholder mismatch must be reported');
});

test('legitimate references are NOT flagged (no false positives)', () => {
  const allowed = [
    'Arbitrix Trading, registered with the KVK under 72923513.',
    'https://arbitrix.pro/partners',
    'support@arbitrix.ai',
    '@ArbitrixSupportBot',
    '@AlexArbitrix',
    '<meta name="arbitrix-support-telegram" content="">',
    'Kalderix Pro Subscription - 2026-11'
  ];
  for (const text of allowed) {
    assert.deepStrictEqual(lint.detectOldBrand(text), [], 'false positive: ' + text);
    assert.deepStrictEqual(lint.detectArticleDefects(text, BRAND.name), [], 'false positive: ' + text);
  }
});

// ---------------------------------------------------------------------------
// The tree the gate runs against
// ---------------------------------------------------------------------------

test('the live tree is clean: no article defect in any customer-facing file', () => {
  const files = ['public/index.html', 'public/partners.html', 'public/how-it-works.html',
    'public/business-registration.html', 'public/deposit-tutorials.html', 'public/reset-password.html',
    'services/telegram-i18n.js', 'services/TelegramSupportService.js', 'services/MarketingContent.js',
    'services/conversion-i18n.js'];
  const defects = [];
  for (const f of files) {
    for (const d of lint.detectArticleDefects(read(f), BRAND.name)) defects.push(f + ': ' + d.match);
  }
  assert.deepStrictEqual(defects, []);
});

test('the live tree is clean: no old brand in any script', () => {
  const files = ['public/index.html', 'public/partners.html', 'public/how-it-works.html',
    'public/business-registration.html', 'public/deposit-tutorials.html', 'public/privacy-policy.html',
    'public/terms-of-service.html', 'public/reset-password.html', 'services/telegram-i18n.js',
    'services/TelegramSupportService.js', 'services/MarketingContent.js', 'services/conversion-i18n.js',
    'services/support/SupportGuidelines.js'];
  const leaks = [];
  for (const f of files) {
    const text = read(f);
    for (const hit of lint.detectOldBrand(text)) leaks.push(f + ': ' + hit.match);
    // The Arabic alias must not survive anywhere at all.
    assert.ok(!text.includes('\u0623\u0631\u0628\u064a\u062a\u0631\u064a\u0643\u0633'), f + ' still carries the Arabic old brand');
  }
  assert.deepStrictEqual(leaks, []);
});

test('page metadata is clean on every public page', () => {
  const pages = ['public/index.html', 'public/partners.html', 'public/how-it-works.html',
    'public/business-registration.html', 'public/deposit-tutorials.html', 'public/privacy-policy.html',
    'public/terms-of-service.html', 'public/reset-password.html'];
  const defects = [];
  for (const p of pages) {
    if (!fs.existsSync(path.join(ROOT, p))) continue;
    for (const d of lint.detectMetadataDefects(read(p), { brand: BRAND.name })) {
      defects.push(p + ' ' + d.tag + ': ' + d.reason);
    }
  }
  assert.deepStrictEqual(defects, []);
});

test('the dictionary is complete: identical key sets, no empties, placeholder parity', () => {
  const html = read('public/index.html');
  const start = html.indexOf('const TRANSLATIONS');
  let depth = 0, end = -1;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  const vm = require('node:vm');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext('globalThis.T=' + html.slice(html.indexOf('{', start), end + 1), sandbox);
  const defects = lint.detectLocaleDefects(sandbox.T, { brand: BRAND.name });
  assert.deepStrictEqual(defects.slice(0, 5), [], 'locale defects: ' + JSON.stringify(defects.slice(0, 5)));
});

// ---------------------------------------------------------------------------
// The gate as a process
// ---------------------------------------------------------------------------

test('the gate self-test passes as a process (fixtures run inside the gate)', () => {
  const run = spawnSync(process.execPath, ['scripts/verify-rebrand.js', '--self-test'], {
    cwd: ROOT, encoding: 'utf8'
  });
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /fixtures behaved as expected/);
});

test('the gate passes on the corrected tree', () => {
  const run = spawnSync(process.execPath, ['scripts/verify-rebrand.js', '--expect', BRAND.name], {
    cwd: ROOT, encoding: 'utf8'
  });
  assert.strictEqual(run.status, 0, run.stdout.split('\n').filter((l) => l.includes('FAIL')).join('\n') || run.stderr);
  assert.match(run.stdout, /ALL CHECKS PASSED/);
});

test('the gate reports the new sections it did not have before', () => {
  const src = read('scripts/verify-rebrand.js');
  assert.match(src, /lint\.detectLocaleDefects/, 'locale completeness must come from the shared detector');
  assert.match(src, /lint\.detectMetadataDefects/, 'page metadata must be checked');
  assert.match(src, /2c\. Service copy/, 'support/marketing copy must be checked');
  assert.match(src, /--self-test/, 'the gate must be able to prove its own detectors');
});
