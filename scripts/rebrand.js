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
 * copy, the knowledge base, and server-authored strings.
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
 *   - After a --write the script asserts that no protected identifier was
 *     renamed; if one was, it tells you the file and line so it can be fixed.
 *   - Documentation (AGENTS.md, docs/) and migrations are excluded by default,
 *     because they are records of past state and of applied database changes.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const TARGETS = [
  'server.js',
  'public/index.html',
  'public/partners.html',
  'public/deposit-tutorials.html',
  'public/reset-password.html',
  'public/business-registration.html',
  'public/how-it-works.html',
  'services/telegram-i18n.js',
  'services/MarketingContent.js',
  'services/support/ConversationEngine.js',
  'services/support/arbitrix-knowledge.json',
  'services/TelegramSupportService.js',
  'services/MarketingOnboarding.js'
];

const DOC_TARGETS = ['AGENTS.md'];

// (a) never rewrite when the token is part of a domain, handle, path or email
const PREV = '(?<![@\\w./-])';
// (b) never rewrite these suffixes: domains, handles, the legal entity name
const NEXT = '(?!\\.(?:pro|ai|org|com|io|app)|SupportBot|_CSA1|Announcements| Trading)';
const TOKEN = new RegExp(PREV + 'Arbitrix' + NEXT, 'g');

// Anything in this list appearing as <NewName><suffix> after a write is a bug.
const PROTECTED = [
  /Kalderix(?:SupportBot|_CSA1|Announcements)/,
  /Kalderix(?:\.pro|\.ai|\.org|\.com|\.io|\.app)/,
  /Kalderix Trading/
];

function rebrand(text, to) {
  return text.replace(TOKEN, to);
}

function main() {
  const args = process.argv.slice(2);
  const toIdx = args.indexOf('--to');
  const to = toIdx >= 0 ? args[toIdx + 1] : null;
  const write = args.includes('--write');
  const includeDocs = args.includes('--include-docs');

  if (!to || !/^[A-Z][A-Za-z0-9]{2,23}$/.test(to)) {
    console.error('Usage: node scripts/rebrand.js --to <ProductName> [--write] [--include-docs]');
    console.error('  <ProductName> must start with a capital letter and be 3-24 characters.');
    console.error('  Dry run is the default; pass --write to apply.');
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
    const after = rebrand(before, to);
    const hits = (before.match(TOKEN) || []).length;
    const changedLines = before.split('\n').length !== after.split('\n').length;
    if (changedLines) problems.push(rel + ': line count changed (refusing)');
    totalHits += hits;
    if (hits > 0) totalFiles++;
    console.log('  ' + String(hits).padStart(4) + '  ' + (write ? 'WRITE' : 'would ') + '  ' + rel);

    for (const p of PROTECTED) {
      const m = after.match(p);
      if (m) problems.push(rel + ': protected identifier renamed -> ' + m[0]);
    }

    if (write && hits > 0 && !changedLines) fs.writeFileSync(abs, after);
  }

  console.log('');
  console.log('Token hits: ' + totalHits + ' across ' + totalFiles + ' file(s).');
  if (!write) {
    console.log('DRY RUN - nothing written. Re-run with --write to apply.');
  } else {
    console.log('Applied. Now: update BRAND.name in services/brand.js and public/index.html,');
    console.log('then re-run `npm test` (the brand contract tests will list anything left).');
  }
  if (problems.length) {
    console.error('');
    console.error('PROBLEMS:');
    problems.forEach((p) => console.error('  - ' + p));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { rebrand, TOKEN, PROTECTED };
