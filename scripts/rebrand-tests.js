#!/usr/bin/env node
'use strict';

/**
 * Repoint the TEST FIXTURES at the new identity.
 *
 * The suite asserts on customer-visible copy, so a rename legitimately makes
 * dozens of expectations stale. This rewrites the brand literal in tests/ with
 * the SAME guarded token the product code uses, then re-pins the byte-hash
 * assertions that exist to detect unintended homepage edits.
 *
 * It refuses to touch anything that would weaken a security assertion:
 * protected identifiers, hashes other than the approved homepage baseline, and
 * the contents of the brand contract tests (which are identity-agnostic and must
 * stay that way).
 *
 * USAGE
 *   node scripts/rebrand-tests.js --to Kalderix            # dry run
 *   node scripts/rebrand-tests.js --to Kalderix --write    # apply
 *
 * REVIEW THE DIFF. A fixture rename is mechanical, but the operator approving a
 * rebrand should see which expectations moved.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rebrand, countTokens } = require('./rebrand');
const { retheme } = require('./retheme');
const { BRAND } = require('../services/brand');

const ROOT = path.join(__dirname, '..');
const TESTS = path.join(ROOT, 'tests');

/**
 * Files that must NOT follow the rename.
 *   brand_token          - verifies the mechanism with a synthetic name.
 *   phase5_cleanup       - pins the QUARANTINED legacy SQL file, whose retained
 *                          header is a historical record and intentionally keeps
 *                          the original name (that is what the pin is for).
 *   marketing_rehearsal  - reads a SQL re-statement file that is not shipped copy
 *   telegram_referral... - reads the operator runbook in docs/, which records the
 *                          message as it was approved at the time.
 */
const SKIP = [
  'brand_token.test.js',
  'phase5_cleanup.test.js',
  'marketing_rehearsal_guard.test.js',
  'telegram_referral_onboarding_doc.test.js'
];

const HASH_PINS = [
  { file: 'partners_page.test.js', constant: 'INDEX_SHA256', target: 'public/index.html' }
];

function sha256(rel) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
}

function main() {
  const args = process.argv.slice(2);
  const toIdx = args.indexOf('--to');
  const to = toIdx >= 0 ? args[toIdx + 1] : null;
  const markIdx = args.indexOf('--mark');
  const mark = markIdx >= 0 ? args[markIdx + 1] : null;
  const write = args.includes('--write');

  if (!to) {
    console.error('Usage: node scripts/rebrand-tests.js --to <ProductName> [--mark K] [--write]');
    process.exit(2);
  }

  const files = fs.readdirSync(TESTS).filter((f) => f.endsWith('.test.js')).sort();
  let changed = 0;
  let total = 0;

  for (const file of files) {
    if (SKIP.indexOf(file) >= 0) { console.log('  keep (mechanism)  tests/' + file); continue; }
    const abs = path.join(TESTS, file);
    const before = fs.readFileSync(abs, 'utf8');
    const hits = countTokens(before);
    // Fixtures assert on CSS too (focus rings, accent borders), so the accent
    // literals move with the identity exactly as they do in the product.
    const themed = retheme(before, [
      ['#F0B90B', BRAND.candidateIdentity.palette.accent],
      ['#FCD535', BRAND.candidateIdentity.palette.accentHover]
    ]);
    const after = rebrand(themed.text, to, mark);
    if (hits === 0 && before === after) continue;
    total += hits;
    changed++;
    console.log('  ' + String(hits).padStart(4) + '  ' + (write ? 'WRITE' : 'would ') + '  tests/' + file);
    if (write && before !== after) fs.writeFileSync(abs, after);
  }

  console.log('');
  console.log('Brand literals in fixtures: ' + total + ' across ' + changed + ' file(s).');

  for (const pin of HASH_PINS) {
    const abs = path.join(TESTS, pin.file);
    if (!fs.existsSync(abs)) continue;
    const want = sha256(pin.target);
    const text = fs.readFileSync(abs, 'utf8');
    const re = new RegExp("(const " + pin.constant + " = ')[0-9a-f]{64}(')");
    const m = text.match(re);
    if (!m) { console.log('  ' + pin.file + ': ' + pin.constant + ' not found (skipped)'); continue; }
    const current = m[1] + want + m[2];
    const changedPin = current !== m[0];
    console.log('  ' + (changedPin ? (write ? 'WRITE' : 'would ') : 'ok    ') + '  ' + pin.file + ': '
      + pin.constant + ' -> ' + want.slice(0, 12) + '...');
    if (write && changedPin) fs.writeFileSync(abs, text.replace(re, current));
  }

  console.log('');
  console.log(write ? 'Applied. Run `npm test` and review the fixture diff.' : 'DRY RUN - nothing written.');
}

if (require.main === module) main();

module.exports = { SKIP, HASH_PINS };
