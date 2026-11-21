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
const lint = require('./lib/rebrand-lint');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
/** `--expect <Name>`; defaults to the shipped brand. A missing flag used to read
 *  argv[0] (e.g. "--self-test") as the brand name. */
const expectIdx = argv.indexOf('--expect');
const EXPECT = expectIdx >= 0 && argv[expectIdx + 1] ? argv[expectIdx + 1] : 'Kalderix';

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  -  ' + detail : ''));
  if (!ok) failures++;
}
function section(name) { console.log('\n' + name); }

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// ---------------------------------------------------------------------------
// 0. Self-test: prove the DETECTORS still work before trusting the release gate
// ---------------------------------------------------------------------------
// Each fixture is a defect the previous gate missed (or a legitimate string it
// must not flag). If a detector regresses, this fails even on a clean tree.
if (argv.includes('--self-test')) {
  const { runFixtures } = require('./lib/rebrand-fixtures');
  console.log('0. Detector self-test');
  const r = runFixtures(lint, EXPECT);
  for (const x of r.results) console.log((x.ok ? '  PASS  ' : '  FAIL  ') + x.label + '  -  ' + x.detail);
  console.log('');
  if (r.failed) {
    console.log(r.failed + ' FIXTURE(S) MISCLASSIFIED - the gate cannot be trusted.');
    process.exit(1);
  }
  console.log(r.passed + '/' + r.results.length + ' fixtures behaved as expected.');
  process.exit(0);
}

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

// The shared detector covers what the old scan missed: identical KEY SETS (not
// just counts), empty translations, placeholder parity, old-brand spellings in
// ANY script, and article/grammar defects around the new name.
const localeDefects = lint.detectLocaleDefects(T, { brand: EXPECT });
check('locale dictionaries are complete and consistent', localeDefects.length === 0,
  localeDefects.slice(0, 4).map((d) => d.locale + '/' + d.key + ': ' + d.reason).join(' | '));

for (const l of locales) {
  const mentions = Object.values(T[l]).filter((v) => String(v).includes(EXPECT)).length;
  check(l + ': names the product', mentions > 0, mentions + ' strings');
}

// ---------------------------------------------------------------------------
// 2b. Metadata: what a search result and a social card actually show
// ---------------------------------------------------------------------------
section('2b. Page metadata');
const PUBLIC_PAGES = ['public/index.html', 'public/partners.html', 'public/how-it-works.html',
  'public/business-registration.html', 'public/deposit-tutorials.html',
  'public/privacy-policy.html', 'public/terms-of-service.html', 'public/reset-password.html'];
for (const page of PUBLIC_PAGES.filter(exists)) {
  const html = read(page);
  const defects = lint.detectMetadataDefects(html, { brand: EXPECT, requireBrand: page === 'public/index.html' });
  check(page + ': metadata is clean', defects.length === 0,
    defects.slice(0, 3).map((d) => d.tag + '="' + String(d.value).slice(0, 50) + '" ' + d.reason).join(' | '));
}

// ---------------------------------------------------------------------------
// 2c. Service-side customer copy (support bot, marketing, notifications)
// ---------------------------------------------------------------------------
section('2c. Service copy');
const SERVICE_COPY = ['services/telegram-i18n.js', 'services/TelegramSupportService.js',
  'services/MarketingContent.js', 'services/conversion-i18n.js', 'services/support/SupportGuidelines.js'];
for (const file of SERVICE_COPY.filter(exists)) {
  const text = read(file);
  const oldHits = lint.detectOldBrand(text);
  check(file + ': no old brand', oldHits.length === 0,
    oldHits.slice(0, 3).map((h) => h.match + ' @' + h.index).join(', '));
  const article = lint.detectArticleDefects(text, EXPECT);
  check(file + ': no article defect', article.length === 0,
    article.slice(0, 3).map((a) => a.match).join(', '));
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
// The app icon is a drawn symbol now (three converging flows + a node), so the
// check follows the value it must interpolate: the accent, which a rename retints.
const iconBuilder = INDEX.slice(INDEX.indexOf('const iconSvg'), INDEX.indexOf('const iconSvg') + 900);
check('icon derives from BRAND',
  iconBuilder.indexOf("stroke=\"' + BRAND.accent + '\"") > 0
  && iconBuilder.indexOf('M116 388') > 0,
  'accent-coloured symbol paths');

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
/**
 * Two tiers, because a rename has two ways to leak:
 *
 *   PAGES  - shipped HTML. A duplicate of the old name here is a customer-visible
 *            label, a page title or an OG card.
 *   COPY   - the text that is NOT in a page: support-bot replies, partner-group
 *            marketing posts, the support knowledge base, and the tutorial
 *            narration/closing card that a future recording would burn in.
 *
 * The copy tier was missing until 2026-11-16: the gate passed while the partner
 * group was still told "1. EXPLORE ARBITRIX" and the tutorial generator still
 * spoke the old name. Both tiers now run through the same context-aware detector.
 */
const PAGE_GLOBS = ['public/index.html', 'public/partners.html', 'public/how-it-works.html',
  'public/business-registration.html', 'public/deposit-tutorials.html',
  'public/privacy-policy.html', 'public/terms-of-service.html', 'public/reset-password.html'];
const COPY_GLOBS = ['services/telegram-i18n.js', 'services/MarketingContent.js',
  'services/TelegramBroadcast.js', 'services/TelegramSupportService.js',
  'services/support/ConversationEngine.js', 'services/support/SupportKnowledge.js',
  'services/support/arbitrix-knowledge.json', 'scripts/tutorial/scenes.json',
  'scripts/tutorial/build.js', 'scripts/tutorial/record.js'];
const GLOBS = PAGE_GLOBS.concat(COPY_GLOBS);

/**
 * The shared detector classifies by CONTEXT (domains, mailboxes, handles,
 * technical identifiers, the legal operator) and covers the old brand in every
 * script, so a fragment like '...%3EArbitrix%3C...' or an Arabic transliteration
 * is caught here too.
 */
function unexplainedIn(file) {
  return lint.detectOldBrand(read(file)).map((hit) => {
    const line = read(file).slice(hit.index - 40, hit.index + 40).replace(/\s+/g, ' ').trim();
    return file + ': ' + line;
  });
}
const pageLeftovers = PAGE_GLOBS.filter(exists).flatMap(unexplainedIn);
const copyLeftovers = COPY_GLOBS.filter(exists).flatMap(unexplainedIn);
const leftovers = pageLeftovers.concat(copyLeftovers);
check('every remaining reference is a protected identifier', leftovers.length === 0,
  leftovers.slice(0, 4).join(' | '));
check('customer-facing copy modules are covered by the scan', copyLeftovers.length === 0 &&
  COPY_GLOBS.filter(exists).length >= 8, copyLeftovers.slice(0, 3).join(' | '));

// ---------------------------------------------------------------------------
section('7. Transactional email');

/**
 * Email is the one surface a customer reads outside the product, so the name and
 * the palette both have to be right. The templates are inline in server.js; the
 * gold-on-black values were the pre-rename identity and left every OTP and reset
 * message looking like the old brand.
 */
const serverSrc = read('server.js');
const LEGACY_EMAIL_COLOURS = ['#ffd700', '#ffb700', '#0d1117', '#1a2332'];
const legacyColoursFound = LEGACY_EMAIL_COLOURS.filter((c) =>
  serverSrc.toLowerCase().includes(c));
check('email templates carry no legacy gold/black brand colours',
  legacyColoursFound.length === 0, legacyColoursFound.join(', '));
const brandSrc = read('services/brand.js');
check('email sender derives from BRAND (display name) and keeps the verified mail domain',
  /BRAND\.name \+ ' <noreply@' \+ BRAND\.mailDomain/.test(brandSrc),
  'emailSender() in services/brand.js');
check('email subjects derive from BRAND, not a literal',
  serverSrc.includes("subject: 'Password Reset Request - ' + BRAND.name") &&
  serverSrc.includes("subject: 'Your ' + BRAND.name + ' Verification Code'"),
  'reset + verification code subjects');

// ---------------------------------------------------------------------------
console.log('');
if (failures) {
  console.log(failures + ' CHECK(S) FAILED - do not release.');
  process.exit(1);
}
console.log('ALL CHECKS PASSED for "' + EXPECT + '".');
