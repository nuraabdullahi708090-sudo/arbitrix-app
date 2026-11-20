#!/usr/bin/env node
'use strict';

/**
 * ONE command to apply the relaunch identity.
 *
 * Approving a rebrand should be a deliberate action, not a checklist somebody
 * has to remember at 1am. This chains the three steps and then proves the result:
 *
 *   1. scripts/rebrand.js  - every static literal, data-URI image and prompt
 *   2. scripts/retheme.js  - the accent literals (CSS, inline styles, SVG, icons)
 *   3. the BRAND constants - name, monogram, app name, accent
 *
 *   4. a verification pass that greps the customer-facing surfaces for the old
 *      name and reports anything the guards deliberately protected, so the
 *      operator sees exactly what is still old and WHY.
 *
 * USAGE
 *   node scripts/relaunch-brand.js --to kalderix            # dry run
 *   node scripts/relaunch-brand.js --to kalderix --write    # apply
 *
 * WHAT IT NEVER TOUCHES
 *   The legal entity ("Arbitrix Trading", KVK 72923513), the public and mail
 *   domains, the Telegram handles, the seeded admin login, localStorage keys,
 *   database identifiers and applied migrations. Those are identifiers, not
 *   branding, and the guards in rebrand.js refuse them on both sides.
 *
 * BEFORE YOU RUN IT WITH --write
 *   The traffic-bearing assets (domain, handles, mail records) do NOT follow the
 *   name. Read docs/relaunch/12-KALDERIX-IDENTITY.md section "what this cannot
 *   rename" before approving.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BRAND } = require('../services/brand');
const { rebrand, countTokens, TARGETS } = require('./rebrand');
const { retheme } = require('./retheme');

const ROOT = path.join(__dirname, '..');

const FILES = {
  brand: 'services/brand.js',
  page: 'public/index.html'
};

/** Protected references that MUST survive a rename. */
const PROTECTED_PATTERNS = [
  /@?ArbitrixSupportBot/g,
  /@?Arbitrix_CSA1/g,
  /@?ArbitrixAnnouncements/g,
  /AlexArbitrix/g,
  /OliviaArbitrix/g,
  /Arbitrix Trading/g,
  /arbitrix\.(?:pro|ai|org|com|io|app)/g,
  /\w+@arbitrix\.\w+/g
];

const SURFACES = [
  'server.js',
  'public/index.html',
  'public/partners.html',
  'public/deposit-tutorials.html',
  'public/reset-password.html',
  'public/business-registration.html',
  'public/how-it-works.html',
  'public/privacy-policy.html',
  'public/terms-of-service.html',
  'services/telegram-i18n.js',
  'services/MarketingContent.js',
  'services/conversion-i18n.js',
  'services/support/ConversationEngine.js',
  'services/support/SupportGuidelines.js',
  'services/TOTPService.js',
  'services/providers/q8qpay.js'
];

/**
 * Replace one field inside the BRAND object literal only, so a stray
 * `name: 'Arbitrix'` elsewhere in the file cannot be hit by accident.
 */
function setField(text, startMarker, field, value) {
  const start = text.indexOf(startMarker);
  if (start < 0) return null;
  const end = text.indexOf('\n};', start);
  if (end < 0) return null;
  const block = text.slice(start, end);
  const re = new RegExp('(^|\\n)(\\s*)' + field + ":\\s*'[^']*'", 'm');
  if (!re.test(block)) return null;
  const nextBlock = block.replace(re, function (m, lead, indent) {
    return lead + indent + field + ": '" + value + "'";
  });
  return text.slice(0, start) + nextBlock + text.slice(end);
}

function main() {
  const args = process.argv.slice(2);
  const toIdx = args.indexOf('--to');
  const to = toIdx >= 0 ? args[toIdx + 1] : null;
  const write = args.includes('--write');

  if (!to) {
    console.error('Usage: node scripts/relaunch-brand.js --to <identity> [--with-tests] [--write]');
    process.exit(2);
  }
  const identityName = String(to).toLowerCase();
  if (identityName !== String(BRAND.candidateIdentity.name).toLowerCase()) {
    console.error('Unknown identity "' + to + '". Known: ' + BRAND.candidateIdentity.name);
    process.exit(2);
  }
  const identity = BRAND.candidateIdentity;
  const mark = identity.mark;

  // Every static surface the rebrand script knows about, plus the two files whose
  // BRAND constants are edited below.
  const targets = Array.from(new Set(TARGETS.concat([FILES.brand, FILES.page])));
  const edits = [];

  for (const rel of targets) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { console.log('  skip (absent)  ' + rel); continue; }
    let text = fs.readFileSync(abs, 'utf8');

    // 1. static literals. brand.js is excluded by rebrand.js's own target list,
    //    so its `source` literal (what t() swaps FROM) survives on purpose.
    if (TARGETS.indexOf(rel) >= 0) {
      const before = countTokens(text);
      text = rebrand(text, identity.name, mark);
      edits.push({ rel, step: 'rebrand', from: before, to: countTokens(text) });
    }

    // 2. accent literals
    const themed = retheme(text, [
      ['#F0B90B', identity.palette.accent],
      ['#FCD535', identity.palette.accentHover],
      ['%23F0B90B', '%23' + identity.palette.accent.slice(1)],
      ['%23FCD535', '%23' + identity.palette.accentHover.slice(1)]
    ]);
    text = themed.text;
    edits.push({ rel, step: 'retheme', hits: themed.hits });

    // 3. the constants themselves (only the two files that own them)
    if (rel === FILES.brand || rel === FILES.page) {
      const nameText = setField(text, 'const BRAND = {', 'name', identity.name);
      const markText = nameText && setField(nameText, 'const BRAND = {', 'mark', mark);
      if (!nameText || !markText) {
        console.error('Could not locate the BRAND object in ' + rel + ' - aborting.');
        process.exit(1);
      }
      text = markText;
    }

    // `source` is NOT branding: it is the literal the dictionaries were written
    // with, and it is what maps a transaction detail recorded BEFORE this rename
    // ("<source> Pro Subscription") to the localized label. Re-asserting it after
    // the rewrite keeps both eras readable - without this the rebrand pass itself
    // rewrites the page mirror's `source` (public/index.html is a rebrand target),
    // the prefix list collapses to one entry, and every pre-rename subscription
    // row goes back to showing raw English.
    if (rel === FILES.brand || rel === FILES.page) {
      const sourceField = setField(text, 'const BRAND = {', 'source', BRAND.source);
      if (!sourceField) { console.error('source field missing in ' + rel); process.exit(1); }
      text = sourceField;
    }

    // Both mirrors carry appName/accent, and both must move together: the page
    // renders them, the server reports them in the app's own metadata.
    if (rel === FILES.brand || rel === FILES.page) {
      const appName = setField(text, 'const BRAND = {', 'appName', identity.name);
      if (!appName) { console.error('appName field missing in ' + rel); process.exit(1); }
      text = appName;
      const accent = setField(text, 'const BRAND = {', 'accent', identity.palette.accent);
      if (!accent) { console.error('accent field missing in ' + rel); process.exit(1); }
      text = accent;
    }

    if (write) fs.writeFileSync(abs, text);
    console.log('  ' + (write ? 'WRITE' : 'would ') + '  ' + rel);
  }

  console.log('');
  for (const e of edits) {
    if (e.step === 'rebrand') console.log('  rebrand  ' + e.rel + ': ' + e.from + ' tokens rewritten');
    if (e.step === 'retheme') console.log('  retheme  ' + e.rel + ': ' + e.hits + ' accent literals');
  }

  // 4. verification: what is still old, and is each one legitimate?
  console.log('');
  console.log('Verification - remaining old-name references in customer surfaces'
    + (write ? ':' : ' (CURRENT files on disk - a dry run has written nothing):'));
  let unexplained = 0;
  for (const rel of SURFACES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    let scan = text;
    for (const p of PROTECTED_PATTERNS) scan = scan.replace(p, '');
    const left = scan.match(/Arbitrix/g);
    if (left && left.length) {
      unexplained += left.length;
      console.log('  ' + String(left.length).padStart(4) + '  ' + rel + '  <- needs review');
    }
  }
  // The dictionaries legitimately keep `source` (that is what t() swaps FROM).
  const brandFile = fs.readFileSync(path.join(ROOT, FILES.brand), 'utf8');
  const sourceLine = (brandFile.match(/source: '[^']*'/) || [''])[0];
  console.log('  (services/brand.js keeps ' + sourceLine + ' by design: t() swaps it at render time)');

  // 5. the test fixtures assert on customer-visible copy, so they move too.
  if (args.includes('--with-tests')) {
    console.log('');
    console.log('Repointing the test fixtures:');
    const argv = [path.join(__dirname, 'rebrand-tests.js'), '--to', identity.name, '--mark', mark];
    if (write) argv.push('--write');
    execFileSync(process.execPath, argv, { stdio: 'inherit' });
  }

  if (unexplained > 0 && write) {
    console.log('');
    console.log('Review the ' + unexplained + ' remaining reference(s) above before deploying.');
  } else if (unexplained === 0) {
    console.log('  none - every customer-facing reference follows the new identity.');
  }

  console.log('');
  console.log(write
    ? 'Identity applied. Next: npm test (remaining failures should be expectation'
      + ' strings and nothing else), then read docs/relaunch/12-KALDERIX-IDENTITY.md'
      + ' for the assets and the external steps a rename cannot do for you.'
    : 'DRY RUN - nothing written. Re-run with --write --with-tests to apply.');
}

if (require.main === module) main();

module.exports = { setField, PROTECTED_PATTERNS, SURFACES };
