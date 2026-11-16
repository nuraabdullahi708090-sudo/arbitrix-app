#!/usr/bin/env node
'use strict';

/**
 * Verify a rebranded tree against the release checklist.
 *
 * Run this INSIDE the rehearsal copy, after the rename has been applied:
 *
 *   node scripts/relaunch-brand.js --to kalderix --with-tests --write
 *   node scripts/verify-rebrand.js --expect Kalderix
 *
 * Every check prints PASS or FAIL with the evidence it used, and the process
 * exits non-zero if anything fails. The point is that "we grepped and it looked
 * fine" is not a release gate - this is.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const EXPECT = (argv[argv.indexOf('--expect') + 1] || 'Kalderix');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  -  ' + detail : ''));
  if (!ok) failures++;
}
function section(name) { console.log('\n' + name); }

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const INDEX = read('public/index.html');
const SERVER = read('server.js');
const { BRAND } = require(path.join(ROOT, 'services', 'brand.js'));

// ---------------------------------------------------------------------------
// 1. The identity actually switched
// ---------------------------------------------------------------------------
section('1. Identity');
check('BRAND.name is the approved name', BRAND.name === EXPECT, BRAND.name);
check('the monogram is set', BRAND.mark === 'K', BRAND.mark);
check('the source name is retained for the pre-rename era', BRAND.source === 'Arbitrix', BRAND.source);

// ---------------------------------------------------------------------------
// 2. Six locales, no old name anywhere in any dictionary
// ---------------------------------------------------------------------------
section('2. Locales');
const PROTECTED_IN_COPY = [
  /https?:\/\/(?:[a-z0-9-]+\.)?arbitrix\.(?:pro|ai)[^\s"']*/gi,
  /@?(?:Alex|Olivia)?Arbitrix[A-Za-z0-9_]*/g,
  /arbitrix[-_][a-z-]+/gi,
  /Arbitrix Trading/g
];
function unprotected(text) {
  let rest = text;
  for (const re of PROTECTED_IN_COPY) rest = rest.replace(re, '\u0000');
  return /Arbitrix/.test(rest);
}

const ti = INDEX.indexOf('const TRANSLATIONS');
let depth = 0, end = -1;
for (let k = INDEX.indexOf('{', ti); k < INDEX.length; k++) {
  if (INDEX[k] === '{') depth++;
  else if (INDEX[k] === '}') { depth--; if (!depth) { end = k; break; } }
}
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext('var TRANSLATIONS=' + INDEX.slice(INDEX.indexOf('{', ti), end + 1) + ';globalThis.T=TRANSLATIONS;', sandbox);
const T = sandbox.T;
const locales = Object.keys(T);
check('six locales are present', locales.length === 6, locales.join(', '));
check('every locale has the same key count',
  new Set(locales.map((l) => Object.keys(T[l]).length)).size === 1,
  Object.keys(T[locales[0]]).length + ' keys');

for (const l of locales) {
  const leaks = Object.entries(T[l]).filter(([, v]) => unprotected(String(v)));
  check(l + ': no old-brand copy', leaks.length === 0,
    leaks.slice(0, 3).map(([k, v]) => k + '="' + String(v).slice(0, 40) + '"').join(' | '));
  const mentions = Object.values(T[l]).filter((v) => String(v).includes(EXPECT)).length;
  check(l + ': names the product', mentions > 0, mentions + ' strings');
}

// ---------------------------------------------------------------------------
// 3. Protected identifiers survived intact
// ---------------------------------------------------------------------------
section('3. Protected identifiers');
const PROTECTED = [
  ['server.js', SERVER, [['PLATFORM_MIN_DEPOSIT_USD'], ['arbitrix.pro']]],
  ['index.html', INDEX, [['https://t.me/ArbitrixSupportBot'], ['@AlexArbitrix'], ['@OliviaArbitrix'], ['arbitrix-partner-support-telegram'], ['arbitrix.pro']]],
];
check('the support knowledge file kept its name', exists('services/support/arbitrix-knowledge.json'));
check('the legal entity is unchanged', BRAND.legalName === 'Arbitrix Trading', BRAND.legalName);
check('KVK is unchanged', BRAND.kvk === '72923513', BRAND.kvk);
check('the mail domain is unchanged', BRAND.mailDomain === 'arbitrix.ai', BRAND.mailDomain);
const sender = require(path.join(ROOT, 'services', 'brand.js')).emailSender();
check('the outbound sender keeps its verified address',
  sender === EXPECT + ' <noreply@arbitrix.ai>', sender);
for (const [file, text, needles] of PROTECTED) {
  const missing = needles.filter(([n]) => !text.includes(n)).map(([n]) => n);
  check(file + ': protected identifiers intact', missing.length === 0, missing.join(', '));
}

// ---------------------------------------------------------------------------
// 4. Customer-facing surfaces the rename must reach
// ---------------------------------------------------------------------------
section('4. Named surfaces');
const surface = (label, haystack, needle) => check(label, haystack.includes(needle), needle);

surface('page title', INDEX.slice(INDEX.indexOf('<title>'), INDEX.indexOf('</title>')), EXPECT);
surface('og:site_name', INDEX, '<meta property="og:site_name" content="' + EXPECT);
surface('apple-mobile-web-app-title', INDEX, '<meta name="apple-mobile-web-app-title" content="' + EXPECT);
surface('social card text', INDEX, 'content="' + EXPECT);
surface('manifest derives from BRAND', INDEX.slice(INDEX.indexOf('const manifest = {')), 'name: BRAND.appName');
surface('icon derives from BRAND', INDEX, "' + BRAND.mark + '</text>");

// The TOTP issuer is read at runtime, so assert the value the customer's
// authenticator app will actually display.
const totp = require(path.join(ROOT, 'services', 'TOTPService.js'));
const uri = totp.generateOTPAuthURI('JBSWY3DPEHPK3PXP', 'customer@example.com');
check('TOTP issuer in the provisioning URI', uri.indexOf('/totp/' + encodeURIComponent(EXPECT) + ':') > 0, uri.slice(0, 46));
check('TOTP issuer is not a literal', !/ISSUER:\s*'/.test(read('services/TOTPService.js')));

const q8 = read('services/providers/q8qpay.js');
check('q8pay invoice title follows BRAND', q8.includes('BRAND.name + \' Deposit\''));

const guidelines = read('services/support/SupportGuidelines.js');
check('AI support prompts carry no old name', !/Arbitrix/.test(guidelines));
check('AI support prompts name the product', guidelines.includes(EXPECT));

// ---------------------------------------------------------------------------
// 5. Both transaction eras still render
// ---------------------------------------------------------------------------
section('5. Transaction labels');
const tlStart = INDEX.indexOf('const SUBSCRIPTION_DETAIL_PREFIXES');
const tlEnd = INDEX.indexOf('function updateTransactionLog', tlStart);
const tctx = { t: (k) => k, BRAND, console };
vm.createContext(tctx);
vm.runInContext(INDEX.slice(INDEX.indexOf('const TX_DETAIL_LABELS'), tlEnd) + ';globalThis.f = txDetailLabel;', tctx);
check('pre-rename charges map to the localized label',
  tctx.f(BRAND.source + ' Pro Subscription') === 'tx.detail.subscription',
  tctx.f(BRAND.source + ' Pro Subscription'));
check('post-rename charges map to the same label',
  tctx.f(BRAND.name + ' Pro Subscription') === 'tx.detail.subscription',
  tctx.f(BRAND.name + ' Pro Subscription'));
check('the billing period survives',
  tctx.f(BRAND.source + ' Pro Subscription - 2026-11') === 'tx.detail.subscription - 2026-11');
check('unrelated details are untouched', tctx.f('Demo Funds') === 'tx.detail.demoFunds');

// ---------------------------------------------------------------------------
// 6. No old name left in a customer-facing surface
// ---------------------------------------------------------------------------
section('6. Leftovers');
const GLOBS = ['public/index.html', 'public/partners.html', 'public/how-it-works.html',
  'public/business-registration.html', 'public/deposit-tutorials.html',
  'public/privacy-policy.html', 'public/terms-of-service.html', 'public/reset-password.html'];

/**
 * Classify by CONTEXT, not by token. Slicing a token out of
 * '...%3EArbitrix%3C...' or '\u3002Arbitrix' produces fragments that no regex
 * for the identifier itself would recognise, so the window around the match is
 * what gets tested.
 */
const ALLOW_CONTEXT = [
  [/https?:\/\/(?:[a-z0-9-]+\.)?arbitrix\.(?:pro|ai)/i, 'public domain'],
  [/[a-z0-9._%+-]+@arbitrix\./i, 'mailbox'],
  [/@(?:[A-Za-z]+)?Arbitrix[A-Za-z0-9_]*/, 'Telegram handle'],
  [/t\.me\/(?:[A-Za-z_+0-9]*)?Arbitrix/, 'Telegram destination'],
  [/arbitrix[-_][a-z-]+/i, 'technical identifier (meta name, filename, env var)'],
  [/Arbitrix Trading/, 'legal operator'],
  [/data-brand|brand-|source:/, 'brand configuration']
];
function contextOf(text, index) {
  return text.slice(Math.max(0, index - 40), index + 40);
}
function unexplainedIn(file) {
  const text = read(file);
  const out = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf('Arbitrix', from);
    if (i < 0) break;
    from = i + 1;
    const ctx = contextOf(text, i);
    if (!ALLOW_CONTEXT.some(([re]) => re.test(ctx))) {
      const line = text.slice(text.lastIndexOf('\n', i) + 1, text.indexOf('\n', i));
      out.push(file + ': ' + line.trim().slice(0, 90));
    }
  }
  return out;
}
const leftovers = GLOBS.filter(exists).flatMap(unexplainedIn);
check('every remaining reference is a protected identifier', leftovers.length === 0,
  leftovers.slice(0, 4).join(' | '));

// ---------------------------------------------------------------------------
console.log('');
if (failures) {
  console.log(failures + ' CHECK(S) FAILED - do not release.');
  process.exit(1);
}
console.log('ALL CHECKS PASSED for "' + EXPECT + '".');
