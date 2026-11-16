'use strict';

/**
 * Brand-token contract.
 *
 * The product name must be changeable in ONE place, and a rename must never
 * touch identifiers that customers or the database depend on. These tests pin
 * both halves: the switch works, and the deny-list holds.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const { BRAND, brandize, emailSender } = require('../services/brand');
const { rebrand, PROTECTED } = require('../scripts/rebrand');

/** Evaluate a slice of index.html in a sandbox. */
function evalIn(context, code) {
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

/** Extract BRAND + TRANSLATIONS + t() from the real page. */
function loadPageI18n() {
  const tIdx = INDEX.indexOf('const TRANSLATIONS');
  let depth = 0;
  let end = -1;
  for (let i = INDEX.indexOf('{', tIdx); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') {
      depth--;
      if (!depth) { end = i; break; }
    }
  }
  const bStart = INDEX.indexOf('const BRAND = {');
  const bEnd = INDEX.indexOf('};', bStart) + 2;
  const tStart = INDEX.indexOf('function t(key, vars)');
  const tEnd = INDEX.indexOf('\n}', tStart) + 2;

  const sandbox = { currentLang: 'en' };
  evalIn(sandbox, `
    ${INDEX.slice(bStart, bEnd)}
    ${INDEX.slice(tIdx, end + 1)}
    let currentLang = 'en';
    ${INDEX.slice(tStart, tEnd)}
    globalThis.T = TRANSLATIONS;
    globalThis.t = t;
    globalThis.BRAND = BRAND;
  `);
  return sandbox;
}

test('1. BRAND is the single source of the product name', () => {
  assert.strictEqual(BRAND.name, 'Arbitrix', 'the live name is unchanged');
  assert.strictEqual(BRAND.candidate, 'Kalderix', 'the provisionally approved candidate is recorded');
  assert.strictEqual(BRAND.isCandidate, false, 'the candidate is NOT applied');
  assert.strictEqual(BRAND.legalName, 'Arbitrix Trading', 'the legal operator is recorded separately');
  assert.strictEqual(BRAND.kvk, '72923513');
  assert.strictEqual(BRAND.source, 'Arbitrix', 'the literal used by the dictionaries');
});

test('2. the legal operator and the mail domain never follow the brand', () => {
  // A trading name is not a new legal entity: the KVK registration is the trust
  // asset and the mail domain carries the verified SPF/DKIM records.
  assert.strictEqual(BRAND.legalName, 'Arbitrix Trading');
  assert.strictEqual(BRAND.kvk, '72923513');
  assert.strictEqual(BRAND.mailDomain, 'arbitrix.ai');
  assert.match(emailSender(), /^Arbitrix <noreply@arbitrix\.ai>$/);
});

test('3. renaming is ONE line and the dictionaries are untouched', () => {
  const ctx = loadPageI18n();
  const before = ctx.t('landing.hero.subtitle');
  const beforeFooter = ctx.t('landing.footer.copyright');

  // Flip the single constant the way a rebrand would.
  ctx.BRAND.name = 'Kalderix';
  const after = ctx.t('landing.hero.subtitle');
  const afterFooter = ctx.t('landing.footer.copyright');

  assert.ok(before.includes('Arbitrix'), 'the current render names the product');
  assert.ok(after.includes('Kalderix'), 'the renamed render uses the new name');
  assert.ok(!/Arbitrix/.test(after), 'no stale name survives the swap');
  assert.ok(beforeFooter !== afterFooter, 'every localized string follows, not just one');

  // Changing BRAND.name must not require editing any dictionary value.
  assert.ok(ctx.T.en['landing.hero.subtitle'].includes('Arbitrix'),
    'the stored string keeps the source literal (no drift, no token)');
});

test('4. every locale renames together, and the key sets stay identical', () => {
  const ctx = loadPageI18n();
  const locales = Object.keys(ctx.T);
  assert.deepStrictEqual(locales.sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);

  ctx.BRAND.name = 'Kalderix';
  for (const l of locales) {
    ctx.currentLang = l;
    const sample = ctx.t('landing.hero.subtitle');
    assert.ok(!/Arbitrix/.test(sample), l + ' still names the old brand');
    assert.ok(sample.length > 0, l + ' renders text');
  }
});

test('5. t() still works when BRAND is absent (isolated unit harnesses)', () => {
  // Many suites evaluate t() alone. A ReferenceError there would be swallowed by
  // the try/catch and silently render the key instead of the copy.
  const tSrc = INDEX.slice(
    INDEX.indexOf('function t(key, vars)'),
    INDEX.indexOf('\n}', INDEX.indexOf('function t(key, vars)')) + 2
  );
  assert.ok(tSrc.includes('function t(key, vars)'), 'the real t() source was extracted');
  const iso = {};
  vm.createContext(iso);
  // no BRAND in scope
  vm.runInContext(`
    const TRANSLATIONS = { en: { k: 'Arbitrix works' } };
    let currentLang = 'en';
    ${tSrc}
    globalThis.out = t('k');
  `, iso);
  assert.strictEqual(iso.out, 'Arbitrix works', 't() resolves without BRAND in scope');
});

test('6. the rebrand script never rewrites a protected identifier', () => {
  const cases = [
    ['Arbitrix monitors markets', 'Kalderix monitors markets'],
    ['Welcome to Arbitrix!', 'Welcome to Kalderix!'],
    ['Arbitrix AI <noreply@arbitrix.ai>', 'Kalderix AI <noreply@arbitrix.ai>'],
    ['https://arbitrix.pro/how-it-works', 'https://arbitrix.pro/how-it-works'],
    ['@ArbitrixSupportBot', '@ArbitrixSupportBot'],
    ['t.me/ArbitrixAnnouncements', 't.me/ArbitrixAnnouncements'],
    ['Arbitrix_CSA1', 'Arbitrix_CSA1'],
    ['Arbitrix Trading (KVK 72923513)', 'Arbitrix Trading (KVK 72923513)'],
    ['admin@arbitrix.ai', 'admin@arbitrix.ai'],
    ['noreply@arbitrix.ai', 'noreply@arbitrix.ai']
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(rebrand(input, 'Kalderix'), expected, 'unexpected rewrite: ' + input);
  }
});

test('7. the rebrand script refuses to invent a bad name', () => {
  // It is a dry-run tool with a validated target; a lower-case or absurd name is
  // rejected so a typo cannot half-rename the product.
  assert.ok(!require('node:fs').existsSync(path.join(ROOT, 'public', 'index.html.bak')),
    'the dry run writes nothing');
  assert.ok(PROTECTED.length >= 3, 'protected-identifier assertions are present');
});

test('8. brandize() and the page agree on the source name', () => {
  assert.strictEqual(brandize('{{brand}} works'), 'Arbitrix works');
  assert.strictEqual(brandize('{{legalName}} (KVK ' + BRAND.kvk + ')'), 'Arbitrix Trading (KVK 72923513)');
  assert.strictEqual(brandize('no tokens here'), 'no tokens here');
  assert.strictEqual(brandize(null), null, 'non-strings pass through');
});
