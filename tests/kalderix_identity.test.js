'use strict';

/**
 * Kalderix identity - the candidate rebrand, its tooling and its guard rails.
 *
 * The rebrand is PREPARED, not applied: the shipped build still presents the
 * current name and the candidate is recorded as data. These tests pin three
 * things that would otherwise only be discovered during an approval:
 *
 *   1. the switch is genuinely one command, and a dry run writes nothing;
 *   2. protected identifiers (domains, handles, legal entity, credentials) can
 *      never be rewritten by that command;
 *   3. the pieces that do NOT follow a rename - applied migrations and the
 *      database-written transaction detail - are handled deliberately rather
 *      than forgotten.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const { BRAND, activeIdentity } = require('../services/brand');
const { rebrand } = require('../scripts/rebrand');
const { assets } = require('../scripts/build-brand-assets');
const { setField, PROTECTED_PATTERNS } = require('../scripts/relaunch-brand');
const { buildMap } = require('../scripts/retheme');

const ID = BRAND.candidateIdentity;

test('1. the candidate is recorded but not applied', () => {
  assert.strictEqual(ID.name, 'Kalderix');
  assert.strictEqual(ID.mark, 'K');
  assert.strictEqual(BRAND.name, BRAND.source,
    'the shipped build still presents the name in `source`');
  assert.strictEqual(activeIdentity().applied, false, 'no candidate palette is in force');
});

test('2. the identity assets are complete, self-contained and use the candidate palette', () => {
  const list = assets();
  assert.deepStrictEqual(list.map((a) => a[0]).sort(), [
    'kalderix-favicon.svg', 'kalderix-mark.svg', 'kalderix-social.svg', 'kalderix-wordmark.svg'
  ]);
  for (const [file, svg] of list) {
    const onDisk = fs.readFileSync(path.join(ROOT, 'public', 'brand', file), 'utf8');
    assert.strictEqual(onDisk.trim(), svg.trim(), file + ' on disk must match the generator');
    assert.ok(svg.startsWith('<svg'), file + ' is an SVG');
    assert.ok(svg.includes(ID.palette.accent), file + ' uses the identity accent');
    assert.ok(!/Arbitrix/.test(svg), file + ' must not carry the old name');
    // No external references, no embedded fonts, no raster data: an icon that
    // needs a network fetch renders blank in an e-mail or an offline browser.
    assert.strictEqual(/href=|xlink:|@font-face|base64/i.test(svg), false, file + ' is self-contained');
  }
  assert.ok(assets().every(([f, s]) => fs.readFileSync(path.join(ROOT, 'public', 'brand', f), 'utf8').trim() === s.trim()),
    'the generator is deterministic (re-running it changes nothing)');
});

test('3. the stylesheet override is inert until the candidate attribute is present', () => {
  const block = INDEX.slice(INDEX.indexOf('KALDERIX IDENTITY OVERRIDE'));
  const css = block.slice(0, block.indexOf('</style>'));
  assert.ok(/html\[data-brand="kalderix"\]\{/.test(css), 'the override is scoped to the attribute');
  assert.ok(css.includes('--brand:' + ID.palette.accent), 'the override carries the candidate accent');
  assert.ok(css.includes('--brand-rgb:124,92,255'), 'the translucency triplet follows');
  // Nothing may set the attribute unconditionally, or the shipped build would
  // silently render the candidate palette.
  const rootTag = INDEX.slice(INDEX.indexOf('<html'), INDEX.indexOf('>', INDEX.indexOf('<html')) + 1);
  assert.ok(!/data-brand=/.test(rootTag), 'the attribute is not in the static root tag');
  const fn = INDEX.slice(INDEX.indexOf('function applyBrandAssets()'));
  const fnBody = fn.slice(0, fn.indexOf('\napplyBrandAssets();'));
  assert.ok(/if \(BRAND\.name === BRAND\.candidate\)/.test(fnBody),
    'the attribute is only set when the candidate name is in force');
});

test('4. applyBrandAssets is a no-op for the shipped identity', () => {
  const fn = INDEX.slice(INDEX.indexOf('function applyBrandAssets()'));
  const fnBody = fn.slice(0, fn.indexOf('\napplyBrandAssets();'));
  assert.ok(/if \(BRAND\.name === BRAND\.source\) return;/.test(fnBody),
    'the function returns before touching anything while the name is unchanged');

  // Run it for real against a fake document: nothing may be mutated.
  const writes = [];
  const el = (sel) => ({ setAttribute: (k, v) => writes.push(sel + ' ' + k + '=' + v) });
  const ctx = {
    BRAND: Object.assign({}, BRAND),
    document: {
      title: 'unchanged',
      documentElement: { setAttribute: (...a) => writes.push('html ' + a.join('=')) },
      querySelector: el
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fnBody + ';applyBrandAssets();', ctx);
  assert.deepStrictEqual(writes, [], 'no attribute is written while the name is unchanged');
  assert.strictEqual(ctx.document.title, 'unchanged');
});

test('5. approving the name updates the title, the social card and the icons from BRAND', () => {
  const fn = INDEX.slice(INDEX.indexOf('function applyBrandAssets()'));
  const fnBody = fn.slice(0, fn.indexOf('\napplyBrandAssets();'));
  assert.ok(/BRAND\.tagline/.test(fnBody), 'the social card uses the tagline');
  assert.ok(/BRAND\.mark/.test(fnBody), 'the icons use the monogram');
  assert.ok(/BRAND\.accent/.test(fnBody), 'the icons use the accent');
  assert.ok(/data-brand/.test(fnBody), 'the palette attribute is applied');

  // The PWA manifest and the icon are built from BRAND, so a rename cannot
  // leave an old letter on the home screen.
  const manifest = INDEX.slice(INDEX.indexOf('const manifest = {'), INDEX.indexOf('const blob = new Blob'));
  assert.ok(manifest.includes('name: BRAND.appName'), 'manifest name follows BRAND');
  assert.ok(INDEX.includes("' + BRAND.mark + '</text>"), 'the icon letter follows BRAND');
});

test('6. the approval command refuses identifiers it must never rewrite', () => {
  const cases = [
    ['Arbitrix Trading', 'Arbitrix Trading'],
    ['KVK 72923513', 'KVK 72923513'],
    ['https://arbitrix.pro/partners', 'https://arbitrix.pro/partners'],
    ['noreply@arbitrix.ai', 'noreply@arbitrix.ai'],
    ['admin@arbitrix.ai', 'admin@arbitrix.ai'],
    ['@ArbitrixSupportBot', '@ArbitrixSupportBot'],
    ['@Arbitrix_CSA1', '@Arbitrix_CSA1'],
    ['t.me/ArbitrixAnnouncements/17', 't.me/ArbitrixAnnouncements/17'],
    ['@AlexArbitrix', '@AlexArbitrix'],
    ['@OliviaArbitrix', '@OliviaArbitrix'],
    ['arbitrix-knowledge.json', 'arbitrix-knowledge.json'],
    ['name="arbitrix-support-telegram"', 'name="arbitrix-support-telegram"']
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(rebrand(input, 'Kalderix', 'K'), expected, 'must not rewrite: ' + input);
  }
  // And the protection list is real, not decorative.
  for (const p of PROTECTED_PATTERNS) {
    assert.ok(p instanceof RegExp);
  }
  const hit = PROTECTED_PATTERNS.map((p) => ('Arbitrix Trading / @ArbitrixSupportBot / arbitrix.pro').match(p));
  assert.ok(hit.filter(Boolean).length >= 3, 'the guard list matches the real identifiers');
});

test('7. setField edits only inside the BRAND object', () => {
  const text = "const A = {\n  name: 'Old',\n};\nconst BRAND = {\n  name: 'Old',\n  mark: 'A'\n};\nconst B = {\n  name: 'Old'\n};";
  const out = setField(text, 'const BRAND = {', 'name', 'New');
  assert.ok(out.includes("const A = {\n  name: 'Old'"), 'a sibling object is untouched');
  assert.ok(out.includes("const B = {\n  name: 'Old'"), 'a later object is untouched');
  assert.ok(out.includes("const BRAND = {\n  name: 'New'"), 'the brand object is edited');
  assert.strictEqual(setField('no brand here', 'const BRAND = {', 'name', 'New'), null,
    'a missing object returns null instead of guessing');
});

test('8. the retheme map comes from the identity and refuses unknown names', () => {
  const map = buildMap('kalderix');
  assert.ok(Array.isArray(map), 'the candidate has a map');
  const pairs = Object.fromEntries(map);
  assert.strictEqual(pairs['#F0B90B'], ID.palette.accent);
  assert.strictEqual(pairs['#FCD535'], ID.palette.accentHover);
  assert.strictEqual(pairs['%23F0B90B'], '%23' + ID.palette.accent.slice(1),
    'the URL-encoded form (favicon / social card) is covered too');
  assert.strictEqual(buildMap('nosuchbrand'), null, 'an unknown identity is refused');
});

test('9. the database-written subscription detail is rebrand-safe in the UI', () => {
  const start = INDEX.indexOf('const TX_DETAIL_LABELS');
  const end = INDEX.indexOf('function updateTransactionLog', start);
  const ctx = { t: (k) => k, console };
  vm.createContext(ctx);
  vm.runInContext(INDEX.slice(start, end) + ';globalThis.f = txDetailLabel;', ctx);

  assert.strictEqual(ctx.f('Arbitrix Pro Subscription'), 'tx.detail.subscription',
    'a charge written before the rename reads as the localized label, not the old name');
  assert.strictEqual(ctx.f('Kalderix Pro Subscription'), 'tx.detail.subscription',
    'a charge written after the rename reads the same');
  assert.strictEqual(ctx.f('Arbitrix Pro Subscription - 2026-11'),
    'tx.detail.subscription - 2026-11', 'the period suffix (a date) is preserved');
  assert.strictEqual(ctx.f('Demo Funds'), 'tx.detail.demoFunds', 'existing mappings still work');
  assert.strictEqual(ctx.f('Some custom detail'), 'Some custom detail', 'unknown details pass through');
  assert.strictEqual(ctx.f(''), '', 'empty stays empty');
});

test('10. migration 051 changes exactly one literal and no money behaviour', () => {
  const mig = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '051_rebrand_subscription_detail.sql'), 'utf8');
  const orig = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '011_subscription_pro.sql'), 'utf8');

  // Extract the function definition from each and diff them line by line.
  const fnOf = (text) => {
    const s = text.indexOf('CREATE OR REPLACE FUNCTION public.charge_subscription_safe(');
    const e = text.indexOf('\n$$;', s) + 4;
    return text.slice(s, e).split('\n');
  };
  const a = fnOf(orig);
  const b = fnOf(mig);
  assert.strictEqual(a.length, b.length, 'same number of lines (no statement added or removed)');
  const diffs = a.map((line, i) => [i, line, b[i]]).filter(([, x, y]) => x !== y);
  assert.strictEqual(diffs.length, 1, 'exactly one line differs');
  assert.ok(/Arbitrix Pro Subscription/.test(diffs[0][1]) && /Kalderix Pro Subscription/.test(diffs[0][2]),
    'the one difference is the brand literal');

  // The money guards must survive verbatim.
  for (const guard of ['idempotency_key', 'FOR UPDATE', 'live_balance <', 'v_new_balance']) {
    assert.ok(mig.includes(guard), 'migration 051 lost the guard: ' + guard);
  }
  assert.ok(/EXCEPTION\s+WHEN OTHERS THEN/.test(mig), 'migration 051 lost the exception handler');
  assert.ok(!/GRANT|REVOKE/.test(mig.replace(/--[^\n]*/g, '')),
    'no ACL change: CREATE OR REPLACE preserves the lockdown from migration 014');
  assert.ok(/RAISE EXCEPTION 'migration 011/.test(mig), 'it refuses to run without 011');
  assert.ok(/Kalderix Pro Subscription' IN v_src/.test(mig), 'it verifies its own effect');
});

test('11. the shipped build presents one name consistently', () => {
  // The dictionaries keep the source literal (t() swaps it at render time) and
  // the static markup was rebranded at the last rename, so both must agree.
  assert.strictEqual(BRAND.name, BRAND.source,
    'a half-applied rename would render two names on the same page');
  const title = INDEX.match(/<title>([^<]*)<\/title>/)[1];
  assert.ok(title.includes(BRAND.name), 'the page title names the product');
  const og = INDEX.match(/<meta property="og:site_name" content="([^"]*)"/)[1];
  assert.ok(og.includes(BRAND.name), 'the social card names the product');
  // And the tagline used for metadata is the one in the constant.
  assert.ok(INDEX.includes(BRAND.tagline), 'the tagline in the markup matches BRAND.tagline');
});
