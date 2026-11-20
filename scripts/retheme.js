#!/usr/bin/env node
'use strict';

/**
 * Retheme the accent colour across the STATIC surfaces.
 *
 * The accent is a token (--brand / --brand-rgb / --gold*) wherever it matters,
 * but roughly 120 declarations predate the token system and are written as
 * literal hex or as a URL-encoded hex inside data-URI images. This script
 * rewrites those literals so a new identity is consistent everywhere, and
 * reports exactly what it changed.
 *
 * USAGE
 *   node scripts/retheme.js --to kalderix              # dry run (default)
 *   node scripts/retheme.js --to kalderix --write      # apply
 *
 * SOURCE OF TRUTH
 *   The palette comes from BRAND.candidateIdentity in services/brand.js. Nothing
 *   here invents a colour, so the stylesheet, the icons and the social card can
 *   never disagree with the documented identity.
 *
 * SAFETY
 *   - Dry run by default; --write is required.
 *   - Only the accent literals are touched. The semantic green/red profit
 *     colours, the surfaces and every size/typography value are left alone:
 *     retheming must never change what a number means.
 *   - The encoded form (%23F0B90B) is rewritten too. It carries the favicon and
 *     the social preview, which is the one place a "renamed" product most
 *     visibly keeps the old colour.
 */

const fs = require('fs');
const path = require('path');
const { BRAND } = require('../services/brand');

const ROOT = path.join(__dirname, '..');

const TARGETS = [
  'public/index.html',
  'public/partners.html',
  'public/deposit-tutorials.html',
  'public/reset-password.html',
  'public/business-registration.html',
  'public/how-it-works.html',
  'public/privacy-policy.html',
  'public/terms-of-service.html',
  'server.js'
];

/** The current identity's accent literals -> the requested identity's. */
const CURRENT = {
  accent: '#F0B90B',
  accentHover: '#FCD535'
};

function buildMap(identityName) {
  const name = String(identityName || '').toLowerCase();
  if (name !== String(BRAND.candidateIdentity.name).toLowerCase()) {
    return null;
  }
  const p = BRAND.candidateIdentity.palette;
  return [
    [CURRENT.accent, p.accent],
    [CURRENT.accentHover, p.accentHover],
    // URL-encoded inside data-URI images.
    ['%23' + CURRENT.accent.slice(1), '%23' + p.accent.slice(1)],
    ['%23' + CURRENT.accentHover.slice(1), '%23' + p.accentHover.slice(1)]
  ];
}

function retheme(text, map) {
  let out = text;
  let hits = 0;
  for (const [from, to] of map) {
    const parts = out.split(from);
    hits += parts.length - 1;
    out = parts.join(to);
  }
  return { text: out, hits };
}

function main() {
  const args = process.argv.slice(2);
  const toIdx = args.indexOf('--to');
  const to = toIdx >= 0 ? args[toIdx + 1] : null;
  const write = args.includes('--write');

  if (!to) {
    console.error('Usage: node scripts/retheme.js --to <identity> [--write]');
    process.exit(2);
  }
  const map = buildMap(to);
  if (!map) {
    console.error('Unknown identity "' + to + '". Known: ' + BRAND.candidateIdentity.name);
    process.exit(2);
  }

  let total = 0;
  for (const rel of TARGETS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { console.log('  skip (absent)  ' + rel); continue; }
    const before = fs.readFileSync(abs, 'utf8');
    const result = retheme(before, map);
    total += result.hits;
    console.log('  ' + String(result.hits).padStart(4) + '  ' + (write ? 'WRITE' : 'would ') + '  ' + rel);
    if (write && result.hits > 0) fs.writeFileSync(abs, result.text);
  }

  console.log('');
  console.log('Accent literals: ' + total + ' in ' + TARGETS.length + ' candidate file(s).');
  console.log(write
    ? 'Applied. The stylesheet override in public/index.html is now redundant;'
      + ' remove it (or leave it, the values are identical).'
    : 'DRY RUN - nothing written. Re-run with --write to apply.');
}

if (require.main === module) main();

module.exports = { retheme, buildMap, TARGETS };
