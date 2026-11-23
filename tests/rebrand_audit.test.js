/**
 * REBRAND COMPLETION AUDIT.
 *
 * The rename to Kalderix was "done" while four customer-visible surfaces still
 * said Arbitrix, and the release gate reported PASS. These tests pin the defects
 * that were found, the fixes, and - just as important - everything the rename must
 * NOT touch.
 *
 * What went wrong, and what each block below protects:
 *
 *   1. The detector searched case-SENSITIVELY for 'Arbitrix', so 'EXPLORE ARBITRIX'
 *      in the partner-group posts and 'ARBITRIX' in headings were invisible to it.
 *   2. The gate scanned only public/*.html. Support-bot replies, partner marketing
 *      copy, the knowledge base and the tutorial generators were never checked.
 *   3. The transactional email templates still carried the pre-rename gold-on-black
 *      palette, so every OTP and password-reset message looked like the old brand.
 *   4. The tutorial generator burned 'ARBITRIX' into a recording and narrated
 *      "your Arbitrix dashboard".
 *
 * The sections that pin PRESERVED behaviour exist so a future "find and replace"
 * cannot quietly rename the legal entity, the Telegram handles, the mail domain,
 * the localStorage keys or an integration payload field.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const lint = require('../scripts/lib/rebrand-lint');
const { BRAND } = require('../services/brand');

const INDEX = read('public/index.html');
const PARTNERS = read('public/partners.html');
const SERVER = read('server.js');
const MARKETING = read('services/MarketingContent.js');
const TELEGRAM_I18N = read('services/telegram-i18n.js');
const KNOWLEDGE = read('services/support/arbitrix-knowledge.json');
const SCENES = read('scripts/tutorial/scenes.json');
const BUILD = read('scripts/tutorial/build.js');
const RECORD = read('scripts/tutorial/record.js');
const BUSINESS = read('public/business-registration.html');
const GATE = read('scripts/verify-rebrand.js');

// ---------------------------------------------------------------------------
// 1. The detector itself - it has to catch what it missed
// ---------------------------------------------------------------------------

test('the detector catches the ALL-CAPS form that slipped through', () => {
  const hits = lint.detectOldBrand('1. EXPLORE ARBITRIX\nSTAYING SAFE WITH ARBITRIX');
  assert.equal(hits.length, 2, 'both shouting headings must be flagged');
  assert.ok(hits.every((h) => h.match === 'ARBITRIX'));
});

test('the detector still flags the ordinary forms', () => {
  assert.equal(lint.detectOldBrand('Welcome to the Arbitrix referral community.').length, 1);
  const arabic = lint.detectOldBrand('\u0645\u0631\u062d\u0628\u0627 \u0628\u0643 \u0641\u064a \u0623\u0631\u0628\u064a\u062a\u0631\u064a\u0643\u0633');
  assert.equal(arabic.length, 1, 'the Arabic transliteration is still detected');
});

test('the detector never flags a protected identifier', () => {
  const protectedLines = [
    'const host = "https://arbitrix.pro/partners";',
    'const sender = "Kalderix <noreply@arbitrix.ai>";',
    'const handle = "@ArbitrixSupportBot";',
    'const url = "https://t.me/ArbitrixAnnouncements/17";',
    'const BOT = "ArbitrixSupportBot";',
    'window.ARBITRIX_PARTNER_SUPPORT_TELEGRAM_URL = "x";',
    'meta: arbitrix-support-telegram',
    'arbitrixUserId: String(userId)',
    'Kalderix is operated by Arbitrix Trading, registered with the KVK.',
    'source: \'Arbitrix\'',
    'const name = "arbitrix-knowledge.json";'
  ];
  for (const line of protectedLines) {
    assert.equal(lint.detectOldBrand(line).length, 0, 'must not flag: ' + line);
  }
});

test('the release gate scans the customer-facing copy, not just the pages', () => {
  assert.ok(/const COPY_GLOBS = \[[\s\S]*?MarketingContent\.js/.test(GATE));
  assert.ok(/COPY_GLOBS[\s\S]*?telegram-i18n\.js/.test(GATE));
  assert.ok(/COPY_GLOBS[\s\S]*?arbitrix-knowledge\.json/.test(GATE));
  assert.ok(/COPY_GLOBS[\s\S]*?scenes\.json/.test(GATE));
  // every listed file must exist, otherwise the check silently covers nothing
  const block = GATE.slice(GATE.indexOf('const COPY_GLOBS'), GATE.indexOf('const GLOBS'));
  const files = [...block.matchAll(/'([^']+\.(?:js|json))'/g)].map((m) => m[1]);
  assert.ok(files.length >= 8, 'at least 8 copy surfaces, got ' + files.length);
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' is scanned but does not exist');
  }
});

// ---------------------------------------------------------------------------
// 2. Partner-group marketing copy
// ---------------------------------------------------------------------------

test('no partner-group post title still advertises the old name', () => {
  assert.equal(MARKETING.includes('ARBITRIX'), false);
  assert.equal(MARKETING.includes('Arbitrix'), false);
});

test('the approved starter steps name Kalderix', () => {
  assert.ok(MARKETING.includes("1\uFE0F\u20E3 EXPLORE KALDERIX"));
  assert.ok(MARKETING.includes('HOW TO DESCRIBE KALDERIX ACCURATELY'));
  assert.ok(MARKETING.includes('STAYING SAFE WITH KALDERIX'));
  // Portuguese keeps its own grammar
  assert.ok(MARKETING.includes('CONHE\u00c7A A KALDERIX'));
  assert.ok(MARKETING.includes('COMO DESCREVER A KALDERIX COM PRECIS\u00c3O'));
  assert.ok(MARKETING.includes('SEGURAN\u00c7A NA KALDERIX'));
});

test('the renamed copy reads correctly in English (no "an Kalderix")', () => {
  assert.equal(lint.detectArticleDefects(MARKETING, 'Kalderix').length, 0);
});

// ---------------------------------------------------------------------------
// 3. Tutorial generators - the text a future recording would burn in
// ---------------------------------------------------------------------------

test('the tutorial narration says Kalderix', () => {
  assert.equal(/Arbitrix dashboard/.test(SCENES), false);
  assert.ok(SCENES.includes('This is your Kalderix dashboard.'));
  assert.ok(SCENES.includes('Kalderix creates a unique payment address'));
  assert.ok(SCENES.includes('Kalderix watches the blockchain'));
  assert.ok(SCENES.includes('Message the Kalderix support team any time.'));
});

test('the tutorial closing card and the on-screen chip say Kalderix', () => {
  assert.ok(BUILD.includes('How to fund your Kalderix Live balance'));
  assert.ok(RECORD.includes("brand.textContent = 'KALDERIX';"));
  assert.equal(RECORD.includes("brand.textContent = 'ARBITRIX';"), false);
});

test('the tutorial keeps the real destination and the real handle', () => {
  assert.ok(BUILD.includes('https://t.me/ArbitrixSupportBot'));
  assert.ok(BUILD.includes('https://arbitrix.pro/how-it-works'));
  assert.ok(SCENES.includes('official support bot on Telegram'),
    'the narration describes the bot instead of spelling a handle that may change');
});

// ---------------------------------------------------------------------------
// 4. Transactional email
// ---------------------------------------------------------------------------

const LEGACY = ['#ffd700', '#ffb700', '#0d1117', '#1a2332'];

test('email templates no longer carry the legacy gold-on-black palette', () => {
  const found = LEGACY.filter((c) => SERVER.toLowerCase().includes(c));
  assert.deepEqual(found, [], 'legacy brand colours still present: ' + found.join(', '));
});

test('email templates use the approved azure-on-slate identity', () => {
  assert.ok(SERVER.includes('linear-gradient(135deg, #101A26 0%, #1B2A3A 100%)'),
    'header gradient follows the product palette');
  assert.ok(SERVER.includes('color: #5EA0FF;'), 'the wordmark is the brand azure');
  assert.ok(SERVER.includes('linear-gradient(135deg, #8CBBFF 0%, #3F7BE0 100%)'),
    'the reset button uses the azure gradient');
});

test('the reset button keeps AA contrast for its label', () => {
  // dark label on the light azure end of the gradient; the worst case is the
  // DARK end, so that is the one measured.
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  assert.ok(ratio('#0B111A', '#3F7BE0') >= 4.5, 'label on the dark gradient end');
  assert.ok(ratio('#0B111A', '#8CBBFF') >= 4.5, 'label on the light gradient end');
  assert.ok(ratio('#5EA0FF', '#101A26') >= 4.5, 'wordmark on the slate header');
});

test('email subjects, titles and the wordmark derive from BRAND', () => {
  assert.ok(SERVER.includes("subject: 'Password Reset Request - ' + BRAND.name"));
  assert.ok(SERVER.includes("subject: 'Confirm your new email - ' + BRAND.name"));
  assert.ok(SERVER.includes("subject: 'KYC Verification Submitted - ' + BRAND.name"));
  assert.ok(SERVER.includes("subject: 'Your ' + BRAND.name + ' Verification Code'"));
  assert.ok(SERVER.includes('<title>Password Reset - ${BRAND.name}</title>'));
  assert.ok(SERVER.includes('font-weight: 700;">${BRAND.name}</h1>'));
  // the hardcoded wordmark must be gone from the templates
  assert.equal(SERVER.includes('>Kalderix</h1>'), false);
});

test('the rendered email identity is the brand, not a stale literal', () => {
  // Evaluate the real expressions rather than pattern-matching them.
  const subject = new Function('BRAND', "return 'Password Reset Request - ' + BRAND.name");
  assert.equal(subject(BRAND), 'Password Reset Request - Kalderix');
  assert.equal(BRAND.name, 'Kalderix');
});

test('the sender display name follows the brand and keeps the verified mail domain', () => {
  const { emailSender } = require('../services/brand');
  assert.equal(emailSender(), 'Kalderix <noreply@arbitrix.ai>');
  assert.ok(emailSender().includes(BRAND.mailDomain),
    'the domain stays on arbitrix.ai until SPF/DKIM exist for a new one');
});

// ---------------------------------------------------------------------------
// 5. Customer-facing pages
// ---------------------------------------------------------------------------

test('the business-registration download is named for the product', () => {
  assert.ok(BUSINESS.includes('download="kalderix-kvk-business-registration.jpg"'));
  assert.ok(BUSINESS.includes('href="/certificates/kvk-business-registration-page-1.jpg"'),
    'the asset path itself is a published URL and must not move');
});

test('the profile email placeholder is not a mailbox on the old domain', () => {
  assert.equal(INDEX.includes('value="trader@arbitrix.ai"'), false);
  assert.ok(INDEX.includes('value="you@example.com"'));
});

test('the pages credit the legal entity, not the product name', () => {
  assert.ok(BUSINESS.includes('Kalderix is operated by Arbitrix Trading'));
  const tpl = `${read('public/privacy-policy.html')}${read('public/terms-of-service.html')}`;
  assert.ok(tpl.includes('operated by Arbitrix Trading'));
  assert.equal(tpl.includes('operated by Kalderix Trading'), false,
    'the registered entity is never renamed by a product rebrand');
});

// ---------------------------------------------------------------------------
// 6. What the rename must NEVER touch
// ---------------------------------------------------------------------------

test('the operator identity is untouched', () => {
  assert.equal(BRAND.legalName, 'Arbitrix Trading');
  assert.equal(BRAND.kvk, '72923513');
});

test('the public domain and the mail domain are untouched', () => {
  assert.equal(BRAND.domain, 'arbitrix.pro');
  assert.equal(BRAND.mailDomain, 'arbitrix.ai');
  assert.ok(INDEX.includes('https://arbitrix.pro') || INDEX.includes('arbitrix.pro'));
});

test('the Telegram identities are untouched', () => {
  assert.ok(TELEGRAM_I18N.includes('https://arbitrix.pro/business-registration'),
    'customer answers still link the live site');
  assert.ok(read('services/TelegramBroadcast.js').includes('https://t.me/ArbitrixSupportBot'));
  assert.ok(read('services/TelegramBroadcast.js').includes('https://t.me/AlexArbitrix'));
  assert.ok(read('services/TelegramBroadcast.js').includes('https://t.me/OliviaArbitrix'));
  assert.ok(read('services/TelegramAccountLinks.js').includes("'ArbitrixSupportBot'"));
});

test('compatibility identifiers are untouched', () => {
  // localStorage + event names: renaming them logs users out / breaks listeners
  assert.ok(INDEX.includes('arbitrix:mode-changed'));
  assert.ok(read('public/sw.js').includes("'arbitrix-shell-v1'"));
  // configuration hooks that operators may already have set
  assert.ok(INDEX.includes('arbitrix-support-telegram'));
  assert.ok(INDEX.includes('ARBITRIX_PARTNER_SUPPORT_TELEGRAM_URL'));
  // the provider payload field names are reconciliation identifiers
  const q8 = read('services/providers/q8qpay.js');
  assert.ok(q8.includes('arbitrixUserId') && q8.includes('arbitrixDepositRef'));
  // the legacy seeded admin identity: no longer in application code (the
  // unconditional seed was removed), still documented for operator verification
  assert.ok(!SERVER.includes("admin@arbitrix.ai"), 'no default admin credential in code');
  assert.ok(read('docs/security/ADMIN_PROVISIONING.md').includes("admin@arbitrix.ai"));
  // the knowledge base filename is a path other code and tests resolve
  assert.ok(read('services/support/SupportKnowledge.js').includes('arbitrix-knowledge.json'));
});

test('the knowledge base keeps its entry ids and its legal answer', () => {
  assert.ok(KNOWLEDGE.includes('"what_is_arbitrix"'), 'entry ids are retrieval keys');
  assert.ok(KNOWLEDGE.includes('Kalderix is operated by Arbitrix Trading'));
});

// ---------------------------------------------------------------------------
// 7. Nothing financial moved
// ---------------------------------------------------------------------------

test('the financial constants are exactly what they were', () => {
  assert.ok(/PLATFORM_MIN_DEPOSIT_USD\s*=\s*100/.test(SERVER));
  assert.ok(/MIN_WITHDRAWAL_USD\s*=\s*700/.test(SERVER));
  assert.ok(/REFERRAL_REWARD_PERCENT_DEFAULT\s*=\s*20/.test(SERVER));
  assert.ok(/BOT_PROFIT_PAUSE_USD/.test(read('services/ProfitPause.js')));
  assert.ok(/PROMO_PROFIT_CAP_USD\s*=\s*30/.test(SERVER));
});

test('the money-moving routes are still present', () => {
  for (const route of ["'/api/trade'", "'/api/withdraw/request'", "'/api/payment/create-invoice'"]) {
    assert.ok(SERVER.includes(route), route + ' disappeared');
  }
});

test('this audit adds no migration (055 predates it)', () => {
  // 051 was applied BEFORE this audit (a subscription-detail label rename that
  // back-fills existing rows). A product rename must never need new DDL, so the
  // count and the single pre-existing rebrand-named file are pinned here.
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations'));
  assert.equal(migrations.length, 54, 'migration count changed - was a file added?');
  const rebrandNamed = migrations.filter((m) => /rebrand|kalderix/i.test(m));
  assert.deepEqual(rebrandNamed, ['051_rebrand_subscription_detail.sql']);
  // and the pre-existing one rewrites a DISPLAY string, not a balance rule
  const applied = read('supabase/migrations/051_rebrand_subscription_detail.sql');
  assert.ok(applied.includes("'Kalderix Pro Subscription'"), 'the display label');
  assert.ok(/Historical rows keep the text/i.test(applied),
    'past statements are never rewritten by a rename');
});
