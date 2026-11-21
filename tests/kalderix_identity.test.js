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

/**
 * The suite has to hold in BOTH states, because it is the release gate:
 *   APPLIED = false  -> the candidate is recorded and inert
 *   APPLIED = true   -> the candidate is in force and the override is live
 * Anything that is only true in one state is written against `APPLIED` rather
 * than against a name, so approving the rename cannot turn a green gate red.
 */
const APPLIED = BRAND.name === ID.name;

test('1. the candidate is recorded, and applied or not as a pair', () => {
  assert.strictEqual(ID.name, 'Kalderix');
  assert.strictEqual(ID.mark, 'K');
  assert.ok(BRAND.name === BRAND.source || BRAND.name === ID.name,
    'the live name is either the source name or the approved candidate - never a third value');
  assert.strictEqual(activeIdentity().applied, APPLIED,
    'the palette is active exactly when the name is');
  if (APPLIED) {
    assert.strictEqual(activeIdentity().palette.accent, ID.palette.accent,
      'the active palette is the candidate palette');
  } else {
    assert.strictEqual(activeIdentity().palette, null,
      'no palette is active while the name is unchanged');
  }
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
    if (BRAND.source !== ID.name) {
      assert.ok(!svg.includes(BRAND.source), file + ' must not carry the old name');
    }
    assert.ok(svg.includes(ID.name), file + ' names the candidate');
    // No external references, no embedded fonts, no raster data: an icon that
    // needs a network fetch renders blank in an e-mail or an offline browser.
    assert.strictEqual(/href=|xlink:|@font-face|base64/i.test(svg), false, file + ' is self-contained');
  }
  assert.ok(assets().every(([f, s]) => fs.readFileSync(path.join(ROOT, 'public', 'brand', f), 'utf8').trim() === s.trim()),
    'the generator is deterministic (re-running it changes nothing)');
});

test('3. the stylesheet override is scoped to the brand attribute (now enabled statically)', () => {
  const block = INDEX.slice(INDEX.indexOf('KALDERIX IDENTITY OVERRIDE'));
  const css = block.slice(0, block.indexOf('</style>'));
  assert.ok(/html\[data-brand="kalderix"\]\{/.test(css), 'the override is scoped to the attribute');
  assert.ok(css.includes('--brand:' + ID.palette.accent), 'the override carries the candidate accent');
  // The translucency triplet is derived from the palette, not hardcoded, so a
  // future accent change cannot leave rgba() tints on the previous hue.
  const triplet = [1, 3, 5].map((i) => parseInt(ID.palette.accent.slice(i, i + 2), 16)).join(',');
  assert.ok(css.includes('--brand-rgb:' + triplet), 'the translucency triplet follows the accent');
  // Kalderix is the approved identity (BRAND.name === BRAND.candidate), so the
  // attribute is declared statically: applyBrandAssets() sets it at runtime
  // anyway, and declaring it here removes the pre-JS flash of the old palette.
  const rootTag = INDEX.slice(INDEX.indexOf('<html'), INDEX.indexOf('>', INDEX.indexOf('<html')) + 1);
  assert.ok(/data-brand="kalderix"/.test(rootTag), 'the approved identity is declared on the static root tag');
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

  // Run it for real against a fake document.
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
  if (APPLIED) {
    assert.ok(writes.some((w) => w.startsWith('html data-brand=kalderix')), 'the palette attribute is applied');
  } else {
    assert.deepStrictEqual(writes, [], 'no attribute is written while the name is unchanged');
    assert.strictEqual(ctx.document.title, 'unchanged');
  }
});

test('5. approving the name updates the title, the social card and the icons from BRAND', () => {
  const fn = INDEX.slice(INDEX.indexOf('function applyBrandAssets()'));
  const fnBody = fn.slice(0, fn.indexOf('\napplyBrandAssets();'));
  assert.ok(/BRAND\.tagline/.test(fnBody), 'the social card uses the tagline');
  assert.ok(/BRAND\.symbol|BRAND\.accent/.test(fnBody), 'the icons use the brand symbol');
  assert.ok(/BRAND\.accent/.test(fnBody), 'the icons use the accent');
  assert.ok(/data-brand/.test(fnBody), 'the palette attribute is applied');

  // The PWA manifest and the icon are built from BRAND, so a rename cannot
  // leave an old letter on the home screen.
  const manifest = INDEX.slice(INDEX.indexOf('const manifest = {'), INDEX.indexOf('const blob = new Blob'));
  assert.ok(manifest.includes('name: BRAND.appName'), 'manifest name follows BRAND');
  // The icon is a drawn symbol now, not a letterform, but it still follows
  // BRAND: the leg colour is interpolated from BRAND.accent.
  assert.ok(INDEX.includes("stroke=\"' + BRAND.accent + '\""), 'the icon symbol follows BRAND');
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
  const map = buildMap(ID.name);
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
  // Evaluate with the PAGE's own BRAND mirror, not the server module: the two are
  // separate literals, and a rebrand run that rewrites the page's `source` used to
  // collapse the prefix list to one era while this test (which borrowed the
  // module's BRAND) still passed.
  const pageBrandStart = INDEX.indexOf('const BRAND = {');
  const pageBrandEnd = INDEX.indexOf('};', pageBrandStart) + 2;
  const ctx = { t: (k) => k, console };
  vm.createContext(ctx);
  vm.runInContext(INDEX.slice(pageBrandStart, pageBrandEnd)
    + ';globalThis.PAGE_BRAND = BRAND;', ctx);
  vm.runInContext(INDEX.slice(start, end) + ';globalThis.f = txDetailLabel;', ctx);

  assert.strictEqual(ctx.PAGE_BRAND.source, 'Arbitrix',
    'the page mirror keeps the pre-rename literal that historical rows were written with');
  assert.notStrictEqual(ctx.PAGE_BRAND.source, ctx.PAGE_BRAND.name,
    'a rename must not collapse the two eras into one');

  assert.strictEqual(ctx.f(BRAND.source + ' Pro Subscription'), 'tx.detail.subscription',
    'a charge written before the rename reads as the localized label, not the old name');
  assert.strictEqual(ctx.f(BRAND.name + ' Pro Subscription'), 'tx.detail.subscription',
    'a charge written after the rename reads the same');
  assert.strictEqual(ctx.f(BRAND.source + ' Pro Subscription - 2026-11'),
    'tx.detail.subscription - 2026-11', 'the period suffix (a date) is preserved');
  // Both eras must survive ANY rename, so the prefixes are derived at runtime
  // rather than spelled out: a literal list collapses into duplicates the moment
  // the rename rewrites it, and the older era silently stops mapping.
  const block = INDEX.slice(INDEX.indexOf('const SUBSCRIPTION_DETAIL_PREFIXES'));
  const blockEnd = block.indexOf('})();');
  assert.ok(/\[BRAND\.name, BRAND\.source\]/.test(block.slice(0, blockEnd)),
    'the prefix list is built from BRAND.name + BRAND.source');
  assert.ok(!/'[A-Za-z]+ Pro Subscription'/.test(block.slice(0, blockEnd)),
    'no literal brand may appear in the prefix list');
  assert.ok(/if \(typeof BRAND === 'undefined'/.test(block.slice(0, blockEnd)),
    'with no identity it maps nothing instead of falling back to a literal pair');
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

  // The review (M2) added ONE declaration line: the pinned search_path. Remove
  // exactly that line before diffing, so the "one literal changed" guarantee
  // still has to hold for everything else.
  const pathLine = 'SET search_path = public, pg_temp';
  const pathLines = b.filter((l) => l.trim() === pathLine);
  assert.strictEqual(pathLines.length, 1, 'exactly one pinned search_path line');
  const bWithoutPath = b.filter((l) => l.trim() !== pathLine);

  assert.strictEqual(a.length, bWithoutPath.length, 'no statement added or removed besides search_path');
  const diffs = a.map((line, i) => [i, line, bWithoutPath[i]]).filter(([, x, y]) => x !== y);
  assert.strictEqual(diffs.length, 1, 'exactly one line differs');
  assert.ok(diffs[0][1].includes(BRAND.source + ' Pro Subscription'), 'the old literal is what was replaced');
  assert.ok(diffs[0][2].includes(ID.name + ' Pro Subscription'), 'the approved name is what replaced it');

  // The money guards must survive verbatim.
  for (const guard of ['idempotency_key', 'FOR UPDATE', 'live_balance <', 'v_new_balance']) {
    assert.ok(mig.includes(guard), 'migration 051 lost the guard: ' + guard);
  }
  assert.ok(/EXCEPTION\s+WHEN OTHERS THEN/.test(mig), 'migration 051 lost the exception handler');

  // M2: migration 014 never covered this function, so the RECREATED body must
  // carry its own lockdown. The ACL statements are the only privilege change.
  const acl = mig.replace(/--[^\n]*/g, '').split('\n').filter((l) => /\b(GRANT|REVOKE)\b/.test(l));
  assert.strictEqual(acl.length, 4, 'four ACL statements: three REVOKEs and one GRANT');
  assert.ok(acl.every((l) => l.includes('charge_subscription_safe')), 'the ACL targets only this function');
  assert.ok(acl.some((l) => /GRANT EXECUTE .* TO service_role/.test(l)), 'service_role keeps the server path');
  assert.ok(/RAISE EXCEPTION 'migration 011/.test(mig), 'it refuses to run without 011');
  assert.ok(/Kalderix Pro Subscription' IN v_src/.test(mig), 'it verifies its own effect');
});

test('11. the shipped build presents one name consistently', () => {
  // The dictionaries keep the source literal (t() swaps it at render time) and
  // the static markup was rebranded at the last rename, so both must agree.
  assert.ok(APPLIED || BRAND.name === BRAND.source,
    'a half-applied rename would render two names on the same page');
  const title = INDEX.match(/<title>([^<]*)<\/title>/)[1];
  assert.ok(title.includes(BRAND.name), 'the page title names the product');
  const og = INDEX.match(/<meta property="og:site_name" content="([^"]*)"/)[1];
  assert.ok(og.includes(BRAND.name), 'the social card names the product');
  // And the tagline used for metadata is the one in the constant.
  assert.ok(INDEX.includes(BRAND.tagline), 'the tagline in the markup matches BRAND.tagline');
});

test('12. the $100 minimum is documented as one coordinated step', () => {
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const block = env.slice(env.indexOf('MINIMUM DEPOSIT FLOOR'));
  const section = block.slice(0, block.indexOf('PAYHIP LIVE MODE'));
  assert.ok(section.includes('PLATFORM_MIN_DEPOSIT_USD'), 'the knob is documented');
  assert.ok(section.includes('049_min_deposit_100.sql'),
    'the doc names the migration that asserts the matching referral row');
  assert.ok(/referral qualifying deposit/i.test(section),
    'the two halves that must agree are named');
  assert.ok(/approved/i.test(section), 'the approved value is stated');
  assert.ok(fs.existsSync(path.join(ROOT, 'supabase', 'migrations', '049_min_deposit_100.sql')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'supabase', 'migrations', '049_min_deposit_50.sql')),
    'the superseded $50 migration must not come back');
});
