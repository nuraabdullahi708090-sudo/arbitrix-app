#!/usr/bin/env node
'use strict';

/**
 * Rebrand the STATIC surfaces (the runtime-token surfaces are already handled by
 * the BRAND constant).
 *
 * The main app's six locale dictionaries use the {{brand}} placeholder, so the
 * product name there changes with ONE line in public/index.html. This script
 * covers everything else that has to be rewritten as literal text: page titles
 * and meta tags, standalone page dictionaries, Telegram support and marketing
 * copy, the knowledge base, the AI system prompts, transactional notification
 * copy and the operator-visible strings the server sends to a payment provider.
 *
 * USAGE
 *   node scripts/rebrand.js --to Kalderix              # dry run (default)
 *   node scripts/rebrand.js --to Kalderix --write      # apply
 *   node scripts/rebrand.js --to Kalderix --write --include-docs
 *
 * SAFETY
 *   - Dry run by default; --write is required to touch anything.
 *   - Protected identifiers are never rewritten: the public/mail domains, the
 *     Telegram handles, the legal entity name, and the seeded admin credential.
 *     The guard is applied on both sides of the token, so "noreply@arbitrix.ai"
 *     keeps its address while a display name can still change.
 *   - "Arbitrix AI" is treated as a compound and becomes the new name ALONE, so
 *     a title reads "Kalderix | ..." rather than "Kalderix AI | ...". The new
 *     name is the brand; the old descriptor is not carried over.
 *   - URL-encoded occurrences inside data-URI images (the social card and the
 *     favicon letter) are rewritten too. They are invisible to a plain text
 *     search but they are what a customer sees in a shared link preview.
 *   - After a --write the script asserts that no protected identifier was
 *     renamed; if one was, it tells you the file and line so it can be fixed.
 *   - Documentation (AGENTS.md, docs/) and migrations are excluded by default,
 *     because they are records of past state and of applied database changes.
 *     The one customer-visible brand literal that lives inside an APPLIED
 *     function is handled by migration 051 instead.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const TARGETS = [
  // server and customer-facing web surfaces
  'server.js',
  'public/index.html',
  'public/partners.html',
  'public/deposit-tutorials.html',
  'public/reset-password.html',
  'public/business-registration.html',
  'public/how-it-works.html',
  'public/privacy-policy.html',
  'public/terms-of-service.html',
  'public/sw.js',
  'package.json',
  // support bot: dictionaries, copy, prompts and the knowledge base
  'services/telegram-i18n.js',
  'services/MarketingContent.js',
  'services/support/ConversationEngine.js',
  'services/support/arbitrix-knowledge.json',
  'services/support/SupportGuidelines.js',
  'services/support/SupportKnowledge.js',
  'services/support/SupportAIService.js',
  'services/TelegramSupportService.js',
  'services/MarketingOnboarding.js',
  // transactional notifications and provider-visible strings
  'services/conversion-i18n.js',
  'services/TOTPService.js',
  'services/providers/q8qpay.js',
  // comment-only references, included so a post-rename grep comes back clean
  'services/PaymentService.js',
  'services/KYCService.js',
  'services/CardPayments.js',
  'services/DepositPartners.js',
  'services/tradingAssets.js',
  'services/TelegramAccountLinks.js',
  'services/TelegramBroadcast.js',
  'services/providers/nowpayments.js'
];

const DOC_TARGETS = ['AGENTS.md'];

// (a) never rewrite when the token is part of a domain, handle or email.
//     '/' is deliberately NOT excluded: a regex literal (/Arbitrix/) has to be
//     rewritten, and a URL path is protected by the suffix guard in (b) instead
//     (arbitrix.pro, t.me/ArbitrixSupportBot and friends all end in a guarded
//     suffix), so dropping it closes a hole rather than opening one.
const PREV = '(?<![@\\w.-])';
// (b) never rewrite these suffixes: domains, handles, the legal entity name
const NEXT = '(?!\\.(?:pro|ai|org|com|io|app)|SupportBot|_CSA1|Announcements| Trading)';
const TOKEN = new RegExp(PREV + 'Arbitrix' + NEXT, 'g');
// "Arbitrix AI" - the marketing compound - collapses to the new name alone.
const COMPOUND = new RegExp(PREV + 'Arbitrix AI' + NEXT, 'g');
// Lower-case references (normalized query text, cache keys, log strings).
// The guard blocks domains, handles, e-mail and kebab-case file/attribute names
// such as arbitrix-knowledge.json or arbitrix-support-telegram.
const LOWER = /(?<![@\w./-])arbitrix(?![.\-_/@]|[a-z]*\.(?:pro|ai))/g;
// URL-encoded data-URI occurrences.
const ENCODED_NAME = /%3EArbitrix%3C/g;
// Non-ASCII copy is stored as \uXXXX escapes, so the character before the brand
// in those strings is a hex digit and the word-boundary guard above would refuse
// to rewrite it (it cannot tell "。Arbitrix" from "xArbitrix"). A complete
// escape immediately before the name IS a boundary, so handle that case first.
const ESCAPED_BEFORE = /(\\u[0-9a-fA-F]{4})Arbitrix(?![A-Za-z])/g;
const ENCODED_MARK = /%3EA%3C/g;

// Anything in this list appearing as <NewName><suffix> after a write is a bug.
const PROTECTED = [
  /Kalderix(?:SupportBot|_CSA1|Announcements)/,
  /Kalderix(?:\.pro|\.ai|\.org|\.com|\.io|\.app)/,
  /Kalderix Trading/
];

/**
 * Rewrite one string. Order matters: the compound and the encoded forms are
 * handled before the general token so "Arbitrix AI" cannot become
 * "Kalderix AI", and the data-URI letter cannot be left behind.
 */
function rebrand(text, to, mark) {
  const letter = mark || (to ? to.charAt(0).toUpperCase() : 'X');
  return text
    .replace(ESCAPED_BEFORE, '$1' + to)
    .replace(COMPOUND, to)
    .replace(ENCODED_NAME, '%3E' + to + '%3C')
    .replace(ENCODED_MARK, '%3E' + letter + '%3C')
    .replace(TOKEN, to)
    .replace(LOWER, String(to).toLowerCase());
}

/**
 * Count the brand tokens one string still contains after a rewrite. Used by the
 * post-write verification and by the tests.
 */
function countTokens(text) {
  return (text.match(TOKEN) || []).length;
}

function main() {
  const args = process.argv.slice(2);
  const toIdx = args.indexOf('--to');
  const to = toIdx >= 0 ? args[toIdx + 1] : null;
  const markIdx = args.indexOf('--mark');
  const mark = markIdx >= 0 ? args[markIdx + 1] : null;
  const write = args.includes('--write');
  const includeDocs = args.includes('--include-docs');

  if (!to || !/^[A-Z][A-Za-z0-9]{2,23}$/.test(to)) {
    console.error('Usage: node scripts/rebrand.js --to <ProductName> [--mark K] [--write] [--include-docs]');
    console.error('  <ProductName> must start with a capital letter and be 3-24 characters.');
    console.error('  Dry run is the default; pass --write to apply.');
    process.exit(2);
  }
  if (mark && !/^[A-Z]$/.test(mark)) {
    console.error('--mark must be a single capital letter (the monogram).');
    process.exit(2);
  }

  const files = TARGETS.concat(includeDocs ? DOC_TARGETS : []);
  let totalHits = 0;
  let totalFiles = 0;
  const problems = [];

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { console.log('  skip (absent)  ' + rel); continue; }
    const before = fs.readFileSync(abs, 'utf8');
    const after = rebrand(before, to, mark);
    const hits = countTokens(before);
    const changedLines = before.split('\n').length !== after.split('\n').length;
    if (changedLines) problems.push(rel + ': line count changed (refusing)');
    totalHits += hits;
    if (hits > 0 || before !== after) totalFiles++;
    console.log('  ' + String(hits).padStart(4) + '  ' + (write ? 'WRITE' : 'would ') + '  ' + rel);

    for (const p of PROTECTED) {
      const m = after.match(p);
      if (m) problems.push(rel + ': protected identifier renamed -> ' + m[0]);
    }

    if (write && before !== after && !changedLines) fs.writeFileSync(abs, after);
  }

  console.log('');
  console.log('Token hits: ' + totalHits + ' across ' + totalFiles + ' file(s).');
  if (!write) {
    console.log('DRY RUN - nothing written. Re-run with --write to apply.');
  } else {
    console.log('Applied. Now update BRAND.name / BRAND.mark (and appName, accent) in');
    console.log('services/brand.js and public/index.html, then run `node scripts/retheme.js');
    console.log('--write --to kalderix` and `npm test` (the brand tests list anything left).');
  }
  if (problems.length) {
    console.error('');
    console.error('PROBLEMS:');
    problems.forEach((p) => console.error('  - ' + p));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { rebrand, countTokens, TOKEN, COMPOUND, LOWER, PROTECTED, TARGETS };
