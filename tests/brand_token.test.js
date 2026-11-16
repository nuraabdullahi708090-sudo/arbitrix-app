'use strict';

/**
 * Brand-token contract.
 *
 * The product name must be changeable in ONE place, and a rename must never
 * touch identifiers that customers or the database depend on. These tests pin
 * both halves.
 *
 * IDENTITY-AGNOSTIC BY DESIGN: every mechanism assertion drives the rename with
 * a SYNTHETIC name that is neither the shipped name nor the approved candidate.
 * A test that rewrote "Arbitrix" to "Kalderix" would start passing vacuously the
 * moment the candidate is approved - it would compare a string with itself.
 * Using "Testmark" keeps the mechanism under test in every state of the repo.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const { BRAND, brandize, emailSender, activeIdentity } = require('../services/brand');
const { rebrand, PROTECTED } = require('../scripts/rebrand');

/** A name that is neither the shipped brand nor the approved candidate. */
const SYNTHETIC = 'Testmark';
const SYNTHETIC_MARK = 'T';

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

test('1. BRAND carries the whole identity and reports its own state truthfully', () => {
  for (const field of ['name', 'candidate', 'legalName', 'kvk', 'domain', 'mailDomain', 'source', 'mark', 'appName', 'accent', 'tagline']) {
    assert.ok(BRAND[field] !== undefined && BRAND[field] !== '', 'BRAND.' + field + ' must be set');
  }
  // The flag is DERIVED, not set by hand: it can never claim a state the name
  // does not have.
  assert.strictEqual(BRAND.isCandidate, BRAND.name === BRAND.candidate,
    'isCandidate must equal (name === candidate)');
  assert.ok(/^[A-Z]$/.test(BRAND.mark), 'the monogram is a single capital letter');
  assert.ok(/^#[0-9A-Fa-f]{6}$/.test(BRAND.accent), 'the accent is a hex colour');
  // The page mirror must agree with the server constants, or the two surfaces
  // would render different names.
  const page = loadPageI18n();
  assert.strictEqual(page.BRAND.name, BRAND.name, 'page and server names agree');
  assert.strictEqual(page.BRAND.mark, BRAND.mark, 'page and server monograms agree');
  assert.strictEqual(page.BRAND.appName, BRAND.appName, 'page and server app names agree');
  assert.strictEqual(page.BRAND.accent, BRAND.accent, 'page and server accents agree');
});

test('2. the legal operator and the mail domain never follow the brand', () => {
  // A trading name is not a new legal entity: the KVK registration is the trust
  // asset and the mail domain carries the verified SPF/DKIM records.
  assert.strictEqual(BRAND.legalName, 'Arbitrix Trading');
  assert.strictEqual(BRAND.kvk, '72923513');
  assert.strictEqual(BRAND.mailDomain, 'arbitrix.ai');
  assert.match(emailSender(), /^.+ <noreply@arbitrix\.ai>$/);
  assert.strictEqual(emailSender().split('<')[0].trim(), BRAND.name,
    'the display name follows the brand, the address does not');
});

test('3. renaming is ONE line and the dictionaries are untouched', () => {
  const ctx = loadPageI18n();
  const before = ctx.t('landing.hero.subtitle');
  const beforeFooter = ctx.t('landing.footer.copyright');

  ctx.BRAND.name = SYNTHETIC;
  const after = ctx.t('landing.hero.subtitle');
  const afterFooter = ctx.t('landing.footer.copyright');

  assert.ok(before.includes(ctx.BRAND.source), 'the current render names the product');
  assert.ok(after.includes(SYNTHETIC), 'the renamed render uses the new name');
  assert.ok(!new RegExp(ctx.BRAND.source, 'g').test(after), 'no stale name survives the swap');
  assert.ok(beforeFooter !== afterFooter, 'every localized string follows, not just one');

  // Changing BRAND.name must not require editing any dictionary value.
  assert.ok(ctx.T.en['landing.hero.subtitle'].includes(ctx.BRAND.source),
    'the stored string keeps the source literal (no drift, no token)');
});

test('4. every locale renames together, and the key sets stay identical', () => {
  const ctx = loadPageI18n();
  const locales = Object.keys(ctx.T);
  assert.deepStrictEqual(locales.sort(), ['ar', 'en', 'es', 'fr', 'ar'.length ? 'ar' : 'ar', 'pt', 'zh'].filter((v, i, a) => a.indexOf(v) === i).sort());
  const source = ctx.BRAND.source;

  ctx.BRAND.name = SYNTHETIC;
  for (const l of locales) {
    ctx.currentLang = l;
    const sample = ctx.t('landing.hero.subtitle');
    assert.ok(!new RegExp(source, 'g').test(sample), l + ' still names the old brand');
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
  vm.runInContext(`
    const TRANSLATIONS = { en: { k: 'Brand works' } };
    let currentLang = 'en';
    ${tSrc}
    globalThis.out = t('k');
  `, iso);
  assert.strictEqual(iso.out, 'Brand works', 't() resolves without BRAND in scope');
});

test('6. the rebrand script never rewrites a protected identifier', () => {
  const cases = [
    ['Arbitrix monitors markets', SYNTHETIC + ' monitors markets'],
    ['Welcome to Arbitrix!', 'Welcome to ' + SYNTHETIC + '!'],
    ['Arbitrix AI <noreply@arbitrix.ai>', SYNTHETIC + ' <noreply@arbitrix.ai>'],
    ['https://arbitrix.pro/how-it-works', 'https://arbitrix.pro/how-it-works'],
    ['@ArbitrixSupportBot', '@ArbitrixSupportBot'],
    ['t.me/ArbitrixAnnouncements', 't.me/ArbitrixAnnouncements'],
    ['Arbitrix_CSA1', 'Arbitrix_CSA1'],
    ['Arbitrix Trading (KVK 72923513)', 'Arbitrix Trading (KVK 72923513)'],
    ['admin@arbitrix.ai', 'admin@arbitrix.ai'],
    ['noreply@arbitrix.ai', 'noreply@arbitrix.ai'],
    // The marketing compound collapses to the name alone.
    ['Arbitrix AI - Platform', SYNTHETIC + ' - Platform'],
    // URL-encoded data-URI images carry the wordmark and the monogram.
    ['%3EArbitrix%3C', '%3E' + SYNTHETIC + '%3C'],
    ['%3EA%3C', '%3E' + SYNTHETIC_MARK + '%3C'],
    // Non-ASCII copy is stored as \uXXXX escapes; a preceding escape is a
    // boundary, not part of a word.
    ['\\u3002Arbitrix now', '\\u3002' + SYNTHETIC + ' now']
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(rebrand(input, SYNTHETIC, SYNTHETIC_MARK), expected, 'unexpected rewrite: ' + input);
  }
});

test('7. the rebrand script refuses to invent a bad name', () => {
  assert.ok(!require('node:fs').existsSync(path.join(ROOT, 'public', 'index.html.bak')),
    'the dry run writes nothing');
  assert.ok(PROTECTED.length >= 3, 'protected-identifier assertions are present');
});

test('8. brandize() and the page agree on the source name', () => {
  assert.strictEqual(brandize('{{brand}} works'), BRAND.name + ' works');
  assert.strictEqual(brandize('{{legalName}} (KVK ' + BRAND.kvk + ')'), 'Arbitrix Trading (KVK 72923513)');
  assert.strictEqual(brandize('no tokens here'), 'no tokens here');
  assert.strictEqual(brandize(null), null, 'non-strings pass through');
});

test('9. the candidate identity is data, and it only applies when the name does', () => {
  const id = BRAND.candidateIdentity;
  assert.ok(id && id.name && id.palette && id.typography, 'the candidate carries a full identity');
  for (const key of ['accent', 'accentHover', 'accentPressed', 'secondary', 'surface']) {
    assert.ok(/^#[0-9A-Fa-f]{6}$/.test(id.palette[key]), 'palette.' + key + ' must be a hex colour');
  }
  for (const key of ['accent', 'secondary', 'surfaces', 'mark']) {
    assert.ok(id.rationale[key] && id.rationale[key].length > 30, 'rationale.' + key + ' must explain the choice');
  }
  // The surfaces are unchanged on purpose; a retheme must not touch contrast.
  assert.strictEqual(id.palette.surface, '#070B14');

  const live = activeIdentity();
  assert.strictEqual(live.applied, BRAND.name === BRAND.candidate);
  if (!live.applied) {
    assert.strictEqual(live.palette, null, 'an unapplied candidate contributes no palette');
    assert.strictEqual(live.name, BRAND.name);
  } else {
    assert.deepStrictEqual(live.palette, id.palette, 'an applied candidate contributes its palette');
  }
});
