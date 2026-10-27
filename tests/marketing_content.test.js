'use strict';

/**
 * Content layer for the Telegram partner-marketing publisher.
 *
 * These tests pin the promises the product makes publicly:
 *   - the approved templates exist in en / pt / ar and contain only configured
 *     business facts (min deposit 100, one-time 20% referral, no recurring
 *     commission, no withdrawal minimum),
 *   - every template passes the safety guard as publishable,
 *   - the guard BLOCKS the claims that would create legal/support exposure,
 *   - the guard only ASKS FOR APPROVAL for unverifiable claims, so a human can
 *     still release them deliberately.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { render, LOCALES, WEEKLY_THEMES, KINDS } = require('../services/MarketingContent');
const { checkContent, matchIndex, extractedAmounts, extractedPercents, findPrivateData } = require('../services/ContentGuard');
const { resolveMarketingConfig, validateDestination, telegramProfileUrl } = require('../services/TelegramBroadcast');

const ROOT = path.join(__dirname, '..');
const FACTS = { minDeposit: 100, referralPercent: 20 };
const CTX = {
  registerUrl: 'https://arbitrix.pro/?action=create-account',
  howItWorksUrl: 'https://arbitrix.pro/how-it-works',
  supportUrl: 'https://t.me/ArbitrixSupportBot',
  partnerSupportUrl: 'https://t.me/Arbitrix_CSA1',
  announcementUrl: 'https://t.me/ArbitrixChannel',
  minDeposit: 100,
  referralPercent: 20
};

const ALL = [];
for (const locale of LOCALES) {
  for (const kind of KINDS) ALL.push({ locale, kind, theme: null });
  for (const theme of WEEKLY_THEMES) ALL.push({ locale, kind: 'weekly', theme });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

test('every approved template exists in all three languages', () => {
  assert.deepStrictEqual(LOCALES, ['en', 'pt', 'ar']);
  assert.strictEqual(KINDS.length, 3);
  assert.strictEqual(WEEKLY_THEMES.length, 7);
  for (const { locale, kind, theme } of ALL) {
    const out = render(kind, locale, Object.assign({ theme }, CTX));
    assert.ok(out.text.length > 200, `${locale}/${kind}/${theme} is too short`);
    assert.ok(out.text.length <= 4000, `${locale}/${kind}/${theme} exceeds the Telegram limit`);
    assert.ok(!/\{\{\w+\}\}/.test(out.text), `${locale}/${kind}/${theme} left a placeholder`);
  }
});

test('every approved template passes the content guard as publishable', () => {
  for (const { locale, kind, theme } of ALL) {
    const out = render(kind, locale, Object.assign({ theme }, CTX));
    const guard = checkContent(out.text, Object.assign({ locale }, FACTS));
    assert.strictEqual(guard.blocked, false, `${locale}/${kind}/${theme} blocked: ${JSON.stringify(guard.violations)}`);
    assert.strictEqual(guard.requiresApproval, false, `${locale}/${kind}/${theme} needs approval: ${JSON.stringify(guard.violations)}`);
    assert.strictEqual(guard.ok, true);
  }
});

test('templates never advertise a recurring, lifetime or passive commission', () => {
  const retired = /recurring commission|lifetime commission|passive income|comissão vitalícia|comissão recorrente|عمولة مدى الحياة|عمولة متكررة/i;
  const negation = /not a recurring|no recurring|one-time|paid once|never (promise|describe|mention|claim)|do not (promise|describe|mention|claim)|uma única vez|não existe|nunca|não (prometa|diga|mencione|fale)|não (é )?uma comissão|não existe comissão|ليست|لا توجد|لا نعد|لا تقل|ولا تذكر|مرة واحدة/i;
  for (const { locale, kind, theme } of ALL) {
    const text = render(kind, locale, Object.assign({ theme }, CTX)).text;
    for (const line of text.split('\n')) {
      if (retired.test(line)) {
        assert.match(line, negation, `${locale}/${kind} states the retired model: ${line}`);
      }
      if (/double your|multiply your|guaranteed return|guaranteed profit/i.test(line)) {
        assert.match(line, negation, `${locale}/${kind} contains a promise: ${line}`);
      }
    }
  }
});

test('templates never disclose the withdrawal minimum', () => {
  for (const { locale, kind, theme } of ALL) {
    const text = render(kind, locale, Object.assign({ theme }, CTX)).text;
    assert.ok(!/\$\s?700\b/.test(text), `${locale}/${kind} leaks the withdrawal minimum`);
    assert.ok(!/\b700\b/.test(text), `${locale}/${kind} contains 700`);
  }
});

test('templates use only the configured business facts', () => {
  for (const { locale, kind, theme } of ALL) {
    const text = render(kind, locale, Object.assign({ theme }, CTX)).text;
    for (const amount of extractedAmounts(text)) {
      assert.ok([100, 50].includes(amount), `${locale}/${kind} invents $${amount}`);
    }
    for (const percent of extractedPercents(text)) {
      assert.strictEqual(percent, 20, `${locale}/${kind} invents ${percent}%`);
    }
  }
});

test('the minimum deposit and referral percentage come from the call site', () => {
  const text = render('welcome', 'en', Object.assign({}, CTX, { minDeposit: 250, referralPercent: 15 })).text;
  assert.match(text, /15%/);
  assert.match(text, /\$250/);
  assert.ok(!/\$100/.test(text), 'the template must not hardcode 100');
});

test('links and buttons are omitted, never invented, when configuration is missing', () => {
  const bare = render('welcome', 'en', { minDeposit: 100, referralPercent: 20 });
  assert.ok(!/https?:\/\//.test(bare.text), 'no URL may appear without configuration');
  assert.strictEqual(bare.buttons.length, 0);
  assert.strictEqual(bare.replyMarkup, null);

  const full = render('welcome', 'en', CTX);
  assert.strictEqual(full.buttons.length, 4);
  assert.deepStrictEqual(full.replyMarkup.inline_keyboard.map((row) => row.length), [2, 2]);
  for (const button of full.buttons) {
    assert.match(button.url, /^https:\/\/t\.me\/|^https:\/\/arbitrix\.pro\//);
  }
});

test('the partner welcome and Start Here use the four approved buttons in two rows', () => {
  const expected = [
    ['\u{1F680} Create Account', 'https://arbitrix.pro/?action=create-account'],
    ['\u{1F393} How It Works', 'https://arbitrix.pro/how-it-works'],
    ['\u{1F4AC} Customer Support', 'https://t.me/ArbitrixSupportBot'],
    ['\u{1F4B3} Partner Payment Support', 'https://t.me/Arbitrix_CSA1']
  ];
  for (const kind of ['welcome', 'startHere']) {
    const out = render(kind, 'en', CTX);
    const rows = out.replyMarkup.inline_keyboard;
    assert.strictEqual(rows.length, 2, `${kind} must render two rows`);
    assert.deepStrictEqual(rows.map((row) => row.length), [2, 2], `${kind} must render 2x2`);
    assert.deepStrictEqual(rows[0].map((b) => [b.text, b.url]), [expected[0], expected[1]]);
    assert.deepStrictEqual(rows[1].map((b) => [b.text, b.url]), [expected[2], expected[3]]);
  }
});

test('a missing URL drops only its own button, never the row layout', () => {
  const partial = render('welcome', 'en', Object.assign({}, CTX, { howItWorksUrl: '' }));
  assert.strictEqual(partial.buttons.length, 3);
  assert.deepStrictEqual(partial.replyMarkup.inline_keyboard.map((row) => row.length), [1, 2]);
  assert.ok(!partial.buttons.some((b) => /how-it-works/.test(b.url)));
});

test('the welcome opens with the approved community greeting, personalised when a name is supplied', () => {
  const named = {
    en: '\u{1F44B} Welcome to the Arbitrix Partners Community, Ana!',
    pt: '\u{1F44B} Boas-vindas \u00e0 Comunidade de Parceiros Arbitrix, Ana!',
    ar: '\u{1F44B} \u0645\u0631\u062d\u0628\u064b\u0627 \u0628\u0643 \u0641\u064a \u0645\u062c\u062a\u0645\u0639 \u0634\u0631\u0643\u0627\u0621 Arbitrix\u060c Ana!'
  };
  const generic = {
    en: '\u{1F44B} Welcome to the Arbitrix Partners Community!',
    pt: '\u{1F44B} Boas-vindas \u00e0 Comunidade de Parceiros Arbitrix!',
    ar: '\u{1F44B} \u0645\u0631\u062d\u0628\u064b\u0627 \u0628\u0643 \u0641\u064a \u0645\u062c\u062a\u0645\u0639 \u0634\u0631\u0643\u0627\u0621 Arbitrix!'
  };
  for (const lang of LOCALES) {
    assert.strictEqual(
      render('welcome', lang, Object.assign({ name: 'Ana' }, CTX)).text.split('\n')[0],
      named[lang], lang + ' must greet the member by first name'
    );
    assert.strictEqual(
      render('welcome', lang, CTX).text.split('\n')[0],
      generic[lang], lang + ' must fall back to the generic greeting'
    );
  }
});

test('an unknown locale or kind falls back safely instead of throwing at render time', () => {
  assert.strictEqual(render('welcome', 'zz', CTX).locale, 'en');
  assert.throws(() => render('nope', 'en', CTX), /unknown marketing content kind/);
});

// ---------------------------------------------------------------------------
// Guard: hard blocks
// ---------------------------------------------------------------------------

const BLOCKED = [
  ['guaranteed profit', 'Trade with us for guaranteed profit every week.'],
  ['risk-free', 'This is a completely risk-free way to earn.'],
  ['lifetime commission', 'You will receive a lifetime commission on every referral.'],
  ['recurring commission', 'Earn a recurring commission every month from your network.'],
  ['passive income', 'Build passive income with our referral programme.'],
  ['matching bonus', 'Deposit today and get a 10% matching bonus.'],
  ['flash bonus', 'Flash bonus: deposit in the next hour.'],
  ['cashback', 'We pay cashback on every deposit.'],
  ['fake urgency', 'Only 14 spots left, today only.'],
  ['withdrawal minimum', 'The minimum withdrawal is $700.'],
  ['live signal', 'Live arbitrage signals every 15 minutes.'],
  ['credential request', 'Send your password to our support agent to verify.'],
  ['email leak', 'Contact the winner at trader@example.com'],
  ['wallet leak', 'Send USDT to TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7'],
  ['phone leak', 'Call +31612345678 to claim.']
];

for (const [label, text] of BLOCKED) {
  test(`guard blocks: ${label}`, () => {
    const guard = checkContent(text, FACTS);
    assert.strictEqual(guard.blocked, true, `${label} was not blocked`);
    assert.strictEqual(guard.ok, false);
    assert.ok(guard.violations.some((v) => v.severity === 'block'));
  });
}

test('a blocked post can never be queued as publishable', () => {
  const blocked = checkContent('Guaranteed profit, risk-free.', FACTS);
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.requiresApproval, false, 'blocked is stronger than requires-approval');
});

// ---------------------------------------------------------------------------
// Guard: requires approval (not blocked)
// ---------------------------------------------------------------------------

const REVIEW = [
  ['earnings figure', 'One of our users earned $4,210 last week.'],
  ['win rate', 'Our bot has a 92% win rate.'],
  ['user count', 'Join 14,205 active traders on the platform.'],
  ['testimonial', 'Read this testimonial from a happy customer.'],
  ['unknown amount', 'Deposit $500 and start today.']
];

for (const [label, text] of REVIEW) {
  test(`guard requires approval: ${label}`, () => {
    const guard = checkContent(text, FACTS);
    assert.strictEqual(guard.blocked, false, `${label} should not be blocked outright`);
    assert.strictEqual(guard.requiresApproval, true, `${label} was published autonomously`);
    assert.strictEqual(guard.ok, false);
  });
}

test('approved business facts never require approval', () => {
  const text = 'Deposit at least $100. The referral reward is 20% of the first qualifying deposit, paid once.';
  assert.strictEqual(checkContent(text, FACTS).ok, true);
});

test('disclaimers are not treated as violations (negation-aware)', () => {
  const disclaimers = [
    'Never promise guaranteed profit.',
    'Do not describe trading as risk-free.',
    'This is not a recurring commission.',
    'Profits are not guaranteed and losses are possible.',
    'Nunca prometa lucro garantido.',
    'Não existe comissão recorrente ou vitalícia.',
    'لا تعد أبدًا بأرباح مضمونة.',
    'لا توجد عمولة متكررة.'
  ];
  for (const text of disclaimers) {
    const guard = checkContent(text, FACTS);
    assert.strictEqual(guard.blocked, false, `disclaimer blocked: ${text}`);
  }
});

test('the negation helper only whitelists, it never invents a match', () => {
  assert.strictEqual(matchIndex('hello world', /guaranteed/, 'en'), -1);
  assert.strictEqual(matchIndex('guaranteed profit', /guaranteed/, 'en'), 0);
  assert.strictEqual(matchIndex('never guaranteed', /guaranteed/, 'en'), -1);
});

test('empty content is blocked, never published', () => {
  assert.strictEqual(checkContent('', FACTS).blocked, true);
  assert.strictEqual(checkContent('   ', FACTS).blocked, true);
});

test('private data detection covers email, wallet and phone', () => {
  assert.deepStrictEqual(findPrivateData('a@b.co'), ['email']);
  assert.ok(findPrivateData('TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7').includes('wallet-address'));
  assert.ok(findPrivateData('+31612345678').includes('phone-number'));
  assert.deepStrictEqual(findPrivateData('no private data here'), []);
});

test('guard reports its fact basis for audit', () => {
  const guard = checkContent('Deposit $100.', { locale: 'pt', minDeposit: 100, referralPercent: 20 });
  assert.deepStrictEqual(guard.facts, { locale: 'pt', minDeposit: 100, referralPercent: 20 });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('configuration is inert by default', () => {
  const cfg = resolveMarketingConfig({});
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.dryRun, true, 'dry run must default to true');
  assert.strictEqual(cfg.groupChatId, '');
  assert.strictEqual(cfg.channelChatId, '');
  assert.strictEqual(cfg.locale, 'en');
});

test('chat ids are canonicalized and destinations are strictly validated', () => {
  const cfg = resolveMarketingConfig({
    TELEGRAM_MARKETING_CHAT_ID: ' -1001234567890 ',
    TELEGRAM_ANNOUNCEMENT_CHAT_ID: '-1009876543210'
  });
  assert.strictEqual(cfg.groupChatId, '-1001234567890');
  assert.strictEqual(cfg.channelChatId, '-1009876543210');
  assert.strictEqual(validateDestination('-1001234567890', cfg).ok, true);
  assert.strictEqual(validateDestination('-1009876543210', cfg).ok, true);
  assert.strictEqual(validateDestination('-1000000000001', cfg).reason, 'chat-not-configured');
  assert.strictEqual(validateDestination('12345', cfg).reason, 'malformed-chat-id');
  assert.strictEqual(validateDestination('', cfg).reason, 'missing-chat-id');
  assert.strictEqual(validateDestination('-1001234567890', resolveMarketingConfig({})).reason, 'no-destination-configured');
});

test('a non-Telegram URL is rejected instead of being published as support', () => {
  assert.strictEqual(telegramProfileUrl('https://evil.example/support'), '');
  assert.strictEqual(telegramProfileUrl('@ArbitrixSupportBot'), 'https://t.me/ArbitrixSupportBot');
  assert.strictEqual(telegramProfileUrl('https://t.me/ArbitrixSupportBot'), 'https://t.me/ArbitrixSupportBot');
  assert.strictEqual(telegramProfileUrl('not a handle!'), '');
});

test('the register URL is derived from BASE_URL and can be overridden', () => {
  assert.strictEqual(
    resolveMarketingConfig({ BASE_URL: 'https://arbitrix.pro' }).registerUrl,
    'https://arbitrix.pro/?action=create-account'
  );
  assert.strictEqual(
    resolveMarketingConfig({ TELEGRAM_MARKETING_REGISTER_URL: 'https://arbitrix.pro/join' }).registerUrl,
    'https://arbitrix.pro/join'
  );
});

// ---------------------------------------------------------------------------
// Source-level safety pins
// ---------------------------------------------------------------------------

test('the templates and guard contain no secret or credential', () => {
  const files = ['services/MarketingContent.js', 'services/ContentGuard.js', 'services/TelegramBroadcast.js'];
  for (const file of files) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!/TELEGRAM_BOT_TOKEN\s*[:=]\s*['"][^'"]+['"]/.test(src), file + ' contains a token');
    assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(src), file + ' contains an API key');
  }
});

test('no marketing module can move money', () => {
  const files = ['services/MarketingContent.js', 'services/ContentGuard.js', 'services/MarketingWorker.js'];
  for (const file of files) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!/record_trade_safe|credit_payment_safe|charge_subscription_safe|from\(['"]wallets|from\(['"]trades|from\(['"]deposits|from\(['"]withdrawals/.test(src),
      file + ' references a money path');
    assert.ok(!/sandbox_/.test(src), file + ' references a sandbox table');
  }
});
