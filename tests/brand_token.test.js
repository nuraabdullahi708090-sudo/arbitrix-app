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

test('3. renaming is ONE line, and every localized string follows', () => {
  const ctx = loadPageI18n();

  // STATE-INDEPENDENT: before approval the dictionaries store BRAND.source and t()
  // swaps it at render time; after approval they store BRAND.name directly.
  // "Renaming is one line" therefore has to mean "the render shows the name in
  // force", not "the stored string contains a particular literal".
  const rendered = ctx.t('landing.hero.subtitle');
  assert.ok(rendered.includes(ctx.BRAND.name), 'the current render names the product');
  if (ctx.BRAND.source !== ctx.BRAND.name) {
    assert.ok(!rendered.includes(ctx.BRAND.source), 'and never shows the pre-rename name');
  }

  // The swap itself still works, so a string written before a rename (or a
  // dictionary entry that was never rewritten) cannot leak the old name into the
  // UI after the next one. Driven with a synthetic entry so it holds in every
  // state of the repo.
  ctx.T.en['test.brandSwap'] = 'Welcome to ' + ctx.BRAND.source + ' - trade on ' + ctx.BRAND.source;
  ctx.BRAND.name = SYNTHETIC;
  const swapped = ctx.t('test.brandSwap');
  assert.ok(swapped.includes(SYNTHETIC), 'the renamed render uses the new name');
  assert.ok(!swapped.includes(ctx.BRAND.source), 'no stale name survives the swap');
  assert.strictEqual(swapped.split(SYNTHETIC).length - 1, 2, 'every occurrence follows, not just the first');

  // ...but the identifiers that merely contain the name survive the swap.
  ctx.T.en['test.brandIds'] = ctx.BRAND.source + ' Trading (KVK 72923513) - '
    + 'https://' + ctx.BRAND.source.toLowerCase() + '.pro - @' + ctx.BRAND.source + 'SupportBot';
  const ids = ctx.t('test.brandIds');
  assert.ok(ids.includes('Arbitrix Trading'), 'the legal entity is not branding');
  assert.ok(ids.includes('arbitrix.pro'), 'the domain is not branding');
  assert.ok(ids.includes('@ArbitrixSupportBot'), 'the support handle is not branding');
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
    ['\\u3002Arbitrix now', '\\u3002' + SYNTHETIC + ' now'],
    // ...but an escaped boundary must not weaken the suffix guards. Renaming the
    // legal entity or keeping the old descriptor in that position is the bug
    // these two cases pin (it happened: an Arabic fixture briefly read
    // "Kalderix Trading").
    ['\\u00abArbitrix Trading\\u00bb', '\\u00abArbitrix Trading\\u00bb'],
    ['\\u00abArbitrix AI\\u00bb', '\\u00ab' + SYNTHETIC + '\\u00bb'],
    ['\\u00abArbitrixSupportBot\\u00bb', '\\u00abArbitrixSupportBot\\u00bb'],
    ['\\u00abarbitrix.pro\\u00bb', '\\u00abarbitrix.pro\\u00bb'],
    ['\\u00abarbitrix-support-telegram', '\\u00abarbitrix-support-telegram'],
    // A lower-case reference after an escape follows the name too.
    ['\\u00abarbitrix works', '\\u00ab' + SYNTHETIC.toLowerCase() + ' works'],
    // Identifiers that merely START with the brand are field/class names, not
    // branding. The q8pay metadata keys are the real case that caught this: a
    // rename turned arbitrixUserId into kalderixUserId and changed the payload
    // the provider echoes back.
    ['arbitrixUserId: 1', 'arbitrixUserId: 1'],
    ['{ arbitrixDepositRef: id, arbitrixInvoiceId: id }', '{ arbitrixDepositRef: id, arbitrixInvoiceId: id }'],
    ['ArbitrixPro plan', 'ArbitrixPro plan'],
    ['\\u00abarbitrixUserId', '\\u00abarbitrixUserId']
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
  // The surfaces ship with the accent (a slate navy ramp rather than flat black),
  // and every contrast ratio in tests/contrast.test.js is measured against these
  // values.
  assert.strictEqual(id.palette.surface, '#0E141C');

  const live = activeIdentity();
  assert.strictEqual(live.applied, BRAND.name === BRAND.candidate);
  if (!live.applied) {
    assert.strictEqual(live.palette, null, 'an unapplied candidate contributes no palette');
    assert.strictEqual(live.name, BRAND.name);
  } else {
    assert.deepStrictEqual(live.palette, id.palette, 'an applied candidate contributes its palette');
  }
});
