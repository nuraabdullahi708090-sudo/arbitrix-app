'use strict';

/**
 * Button fit contract.
 *
 * Measured defect: the Demo Funds amount field (width:100% padding-left:44px)
 * shared an unstyled flex row with the Add button, so the button was crushed
 * and its label split mid-word ("Ad"/"d") in every locale. The cause was two
 * fold: the row had no sizing rules, and .btn declared overflow-wrap:anywhere,
 * which also shrinks a button's intrinsic minimum to one character.
 *
 * These tests pin the layout pattern, not a screenshot: the reusable
 * .input-action-row, the base .btn wrap policy, the narrow-screen tiers for the
 * Available card actions, and the hit areas of the small link/dismiss controls.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = Array.from(INDEX.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)).map((m) => m[1]).join('\n');

// Innermost declaration blocks only: `[^{}]` can never span a nested rule, so
// a match is exactly one selector and its body, media queries included.
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const RULES = [...CSS_NO_COMMENTS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, sel, body]) => ({ selectors: sel.split(',').map((x) => x.trim()), body }))
  .filter((r) => r.selectors.every((x) => x && !x.startsWith('@')));
const lastRule = (selector) => {
  const hits = RULES.filter((r) => r.selectors.includes(selector));
  return hits.length ? hits[hits.length - 1].body : null;
};
const rulesFor = (needle) => RULES.filter((r) => r.selectors.some((x) => x.includes(needle)));
// Cascade-aware readers: the base rule plus every later override of the same
// selector, and the first (base) rule on its own.
const mergedRule = (selector) => RULES.filter((r) => r.selectors.includes(selector)).map((r) => r.body).join('\n');
const baseRule = (selector) => {
  const hit = RULES.find((r) => r.selectors.includes(selector));
  return hit ? hit.body : null;
};
const mediaBlock = (query) => {
  const start = CSS.indexOf(query);
  if (start < 0) return '';
  let depth = 0, i = CSS.indexOf('{', start);
  const from = i;
  for (; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) break;
  }
  return CSS.slice(from, i + 1);
};

/* ------------------------------------------------------- base .btn policy */

test('the base .btn breaks at spaces, not inside words', () => {
  const rule = mergedRule('.btn');
  assert.ok(rule, '.btn rule exists');
  assert.match(rule, /overflow-wrap:\s*break-word/, 'break-word, not anywhere');
  assert.ok(!/overflow-wrap:\s*anywhere/.test(rule), 'anywhere is what shrank the intrinsic minimum');
  assert.match(rule, /white-space:\s*normal/, 'long labels may still wrap');
  assert.match(rule, /min-width:\s*0/, 'a button may still shrink inside a row');
  assert.match(rule, /max-width:\s*100%/, 'and never exceeds its container');
});

test('no global nowrap rule was introduced to hide overflow', () => {
  // Only the short action label inside an input row is allowed to stay on one
  // line; a blanket nowrap on .btn would clip translated labels.
  const offenders = RULES.filter((r) => /white-space:\s*nowrap/.test(r.body))
    .flatMap((r) => r.selectors)
    .filter((sel) => sel === '.btn' || sel === '.stat-deposit-btn');
  assert.deepStrictEqual(offenders, [], 'no bare button class forces nowrap');
  assert.match(CSS, /\.input-action-row > button\{[^}]*white-space:nowrap/,
    'the scoped action label may stay on one line');
});

/* -------------------------------------------------- reusable input + action */

test('the reusable input/action row is gone with the demo funds card', () => {
  // The Demo Funds card was retired with Demo Mode, so the row it used must not
  // linger as dead markup or dead CSS.
  assert.ok(!INDEX.includes('id="depositAmount"'), 'the demo amount field is gone');
  assert.ok(!INDEX.includes('id="depositBtn"'), 'the demo add button is gone');
});

test('the Available actions stay readable on a narrow phone', () => {
  const compact = mediaBlock('@media(max-width:430px)');
  assert.match(compact, /\.stat-actions \.stat-deposit-btn\{font-size:11px;padding:8px 6px/, 'the old 3px padding that clipped labels is gone');
  assert.ok(!/padding:8px 3px/.test(compact), 'no hairline horizontal padding');
  assert.match(compact, /white-space:normal/, 'a longer translation may wrap inside the button');

  const narrow = mediaBlock('@media(max-width:360px)');
  assert.match(narrow, /\.stat-actions\{flex-wrap:wrap/, 'the row may wrap');
  assert.match(narrow, /\.stat-actions \.stat-deposit-btn\{flex:1 1 100%/, 'each action gets the full card width');
});

test('the tablet stack and the desktop row are preserved', () => {
  const tablet = mediaBlock('@media(min-width:768px) and (max-width:1023px)');
  assert.match(tablet, /\.stat-actions\{flex-wrap:wrap/, 'tablet keeps the stacked layout');
  assert.match(tablet, /\.stat-actions \.stat-deposit-btn\{flex:1 1 100%/, 'full width at tablet widths');
  const row = baseRule('.stat-actions');
  assert.match(row, /display:\s*flex/, 'the desktop row is still a flex row');
});

/* ------------------------------------------------------- small hit targets */

test('the inline support link is a real tap target', () => {
  const rule = lastRule('.kx-support-link');
  assert.ok(rule, '.kx-support-link exists');
  assert.match(rule, /min-height:\s*32px/);
  assert.match(rule, /min-width:\s*44px/);
  assert.match(rule, /display:\s*inline-flex/);
  const uses = (INDEX.match(/class="kx-support-link/g) || []).length;
  assert.ok(uses >= 3, 'the modal links use it (' + uses + ')');
  assert.ok(!/color:var\(--brand\);font-size:10px;cursor:pointer;text-decoration:underline;/.test(INDEX),
    'no bare 10px support link is left');
});

test('the Start Here dismiss control is not clipped or hairline-tall', () => {
  const tag = (INDEX.match(/<button[^>]*data-i18n="startHere\.dismiss"[^>]*>/) || [])[0] || '';
  assert.match(tag, /min-height:36px/, 'a usable height');
  assert.match(tag, /min-width:44px/, 'a usable width');
  assert.ok(!/white-space:nowrap/.test(tag), 'a longer translation may wrap');
});

/* ------------------------------------------------------ referral share grid */

test('the referral share buttons never crush a translated label', () => {
  const rule = baseRule('.ref-share-actions');
  assert.match(rule, /repeat\(auto-fit, minmax\(150px, 1fr\)\)/, 'auto-fit with a minimum column');
  assert.ok(!/grid-template-columns:1fr 1fr/.test(rule), 'no fixed half-and-half split');
});

/* ------------------------------------------------------------------ scope */

test('this change is layout only: no money or engine code moved', () => {
  const forbidden = [
    /record_trade_safe/,
    /credit_payment_safe/,
    /MIN_WITHDRAWAL_USD\s*=/,
    /PLATFORM_MIN_DEPOSIT_USD\s*=/,
  ];
  // The CSS block itself must not mention any of them.
  for (const re of forbidden) assert.ok(!re.test(CSS), 'CSS touches no financial constant: ' + re);
});
