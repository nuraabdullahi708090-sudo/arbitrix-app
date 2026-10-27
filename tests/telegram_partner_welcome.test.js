'use strict';

/**
 * Partner welcome message and Start Here guide - final approved content.
 *
 * Pins the three things that can silently regress:
 *   1. the approved COPY (structure, referral wording, and the claims that must
 *      NOT appear: recurring commission, invented bonuses, guaranteed income,
 *      a direct referral URL, or the risk-disclaimer paragraph),
 *   2. the four CONFIRMED destinations and the two-rows-of-two mobile layout,
 *      in all three supported languages,
 *   3. that reachability stays correct: the Start Here guide is only ever
 *      PINNED by an explicit admin action, never as a side effect of queueing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { render, LOCALES, LABELS, groupButtons } = require('../services/MarketingContent');
const { createOnboarding, buildStartHereRow } = require('../services/MarketingOnboarding');
const { resolveMarketingConfig } = require('../services/TelegramBroadcast');
const { checkContent } = require('../services/ContentGuard');

const ROOT = path.join(__dirname, '..');

const DESTINATIONS = {
  register: 'https://arbitrix.pro/?action=create-account',
  howItWorks: 'https://arbitrix.pro/how-it-works',
  support: 'https://t.me/ArbitrixSupportBot',
  partnerSupport: 'https://t.me/Arbitrix_CSA1'
};

const FACTS = { minDeposit: 100, referralPercent: 20 };

/** The production configuration with only BASE_URL supplied. */
const CONFIG = Object.assign(
  resolveMarketingConfig({ BASE_URL: 'https://arbitrix.pro' }),
  { facts: FACTS, groupChatId: '-1001234567890', enabled: true, dryRun: false }
);

const CTX = Object.assign({}, CONFIG, FACTS);

// ---------------------------------------------------------------------------
// 1. Approved English copy
// ---------------------------------------------------------------------------

test('the English welcome carries the approved copy', () => {
  const text = render('welcome', 'en', CTX).text;
  const required = [
    '\u{1F44B} Welcome to the Arbitrix Partners Community!',
    "We're happy to have you here!",
    'automated multi-asset arbitrage platform',
    'identify price differences for the same instruments across different trading venues',
    "Whether you're here to explore the platform, learn how it works, or grow through referrals",
    '\u{1F680} YOUR NEXT STEPS',
    '1\uFE0F\u20E3 EXPLORE ARBITRIX',
    'explore Demo Mode using virtual funds before funding a live account',
    '\u{1F393} Learn how it works:',
    '2\uFE0F\u20E3 CREATE YOUR ACCOUNT',
    'Ready to get started? Create your account here:',
    '3\uFE0F\u20E3 DISCOVER THE PARTNER PROGRAMME',
    'Want to introduce others to Arbitrix?',
    'Your personal referral link lives inside your account:',
    '\u2022 Log in to your Arbitrix account.',
    '\u2022 Open your account dashboard.',
    '\u2022 Scroll down to the Referral section.',
    "\u2022 There you'll find your personal referral link and your referral code.",
    '\u2022 Copy the link and share it with the people you invite.',
    "Can't find your referral link? Scroll down your account dashboard to locate the Referral section.",
    '\u{1F381} REFERRAL REWARD',
    'Earn a one-time reward equal to 20% of a referred user',
    'first qualifying deposit of $100 or more',
    '\u{1F4AC} NEED HELP?',
    'Choose the appropriate support option below whenever you need assistance.',
    '\u{1F447} Choose an option below to get started!'
  ];
  for (const line of required) {
    assert.ok(text.includes(line), 'missing approved copy: ' + line);
  }
});

test('the English welcome states the confirmed destinations as text, not as invented links', () => {
  const text = render('welcome', 'en', CTX).text;
  assert.ok(text.includes(DESTINATIONS.howItWorks), 'the how-it-works destination is inline');
  assert.ok(text.includes(DESTINATIONS.register), 'the registration destination is inline');
});

test('the referral reward is described once, as a one-time percentage of the first qualifying deposit', () => {
  for (const locale of LOCALES) {
    const text = render('welcome', locale, CTX).text;
    assert.strictEqual((text.match(new RegExp(FACTS.referralPercent + '%', 'g')) || []).length, 1,
      locale + ' mentions the referral percentage exactly once');
    assert.ok(text.includes('$' + FACTS.minDeposit), locale + ' states the qualifying deposit');
  }
});

test('the welcome never claims a recurring, lifetime or passive commission', () => {
  const forbidden = new RegExp([
    'recurring commission', 'lifetime commission', 'monthly commission',
    'passive income', 'residual income', 'recurring income',
    'comiss[a\u00e3]o recorrente', 'comiss[a\u00e3]o vital[ií]cia', 'renda passiva',
    '\u0639\u0645\u0648\u0644\u0629 \u0645\u062a\u0643\u0631\u0631\u0629',
    '\u0639\u0645\u0648\u0644\u0629 \u0645\u062f\u0649 \u0627\u0644\u062d\u064a\u0627\u0629'
  ].join('|'), 'i');
  for (const locale of LOCALES) {
    assert.ok(!forbidden.test(render('welcome', locale, CTX).text), locale + ' implies a recurring reward');
    assert.ok(!forbidden.test(render('startHere', locale, CTX).text), locale + ' Start Here implies a recurring reward');
  }
});

test('the welcome invents no bonus, no guaranteed profit and no income promise', () => {
  const forbidden = new RegExp([
    'guaranteed', 'risk-free', 'risk free', 'guaranteed income', 'guaranteed return',
    'passive income', 'matching bonus', 'deposit bonus', 'cashback', 'profit every',
    'garantido', 'sem risco', 'lucro garantido', 'b[oô]nus',
    '\u0645\u0636\u0645\u0648\u0646', '\u0628\u062f\u0648\u0646 \u0645\u062e\u0627\u0637\u0631',
    '\u0645\u0643\u0627\u0641\u0623\u0629 \\u0627\u0644\u0625\u064a\u062f\u0627\u0639'
  ].join('|'), 'i');
  for (const locale of LOCALES) {
    assert.ok(!forbidden.test(render('welcome', locale, CTX).text), locale + ' promises a return or a bonus');
  }
});

test('the welcome carries no risk-disclaimer paragraph (approved: not in this message)', () => {
  const forbidden = /trading involves risk|profits are not guaranteed|investir envolve risco|lucros n[a\u00e3]o s[a\u00e3]o garantidos|\u064a\u0646\u0637\u0648\u064a \u0639\u0644\u0649 \u0645\u062e\u0627\u0637\u0631/i;
  for (const locale of LOCALES) {
    assert.ok(!forbidden.test(render('welcome', locale, CTX).text), locale + ' carries the risk paragraph');
  }
});

test('no personal referral URL is invented: the copy points at the Referral page', () => {
  const directLink = /(referral|ref|r)=|t\.me\/\w+\?start=/i;
  for (const locale of LOCALES) {
    const text = render('welcome', locale, CTX).text;
    assert.ok(!directLink.test(text), locale + ' fabricates a personal referral URL');
    assert.ok(/referral/i.test(text) || /\u0627\u0644\u0625\u062d\u0627\u0644\u0627\u062a/.test(text) || /indica/i.test(text),
      locale + ' never tells the member where to find the link');
  }
});

// ---------------------------------------------------------------------------
// 2. Inline buttons
// ---------------------------------------------------------------------------

test('the welcome keyboard is two rows of two buttons, in the approved order', () => {
  for (const locale of LOCALES) {
    const keyboard = render('welcome', locale, CTX).replyMarkup.inline_keyboard;
    assert.strictEqual(keyboard.length, 2, locale + ' must render two rows');
    assert.deepStrictEqual(keyboard.map((row) => row.length), [2, 2], locale + ' must render 2x2');
    assert.deepStrictEqual(keyboard[0].map((b) => b.url), [DESTINATIONS.register, DESTINATIONS.howItWorks]);
    assert.deepStrictEqual(keyboard[1].map((b) => b.url), [DESTINATIONS.support, DESTINATIONS.partnerSupport]);
  }
});

test('the Start Here keyboard carries the same four destinations', () => {
  for (const locale of LOCALES) {
    const keyboard = render('startHere', locale, CTX).replyMarkup.inline_keyboard;
    assert.deepStrictEqual(keyboard.map((row) => row.map((b) => b.url)), [
      [DESTINATIONS.register, DESTINATIONS.howItWorks],
      [DESTINATIONS.support, DESTINATIONS.partnerSupport]
    ]);
  }
});

test('button labels are localized, carry an icon and never reuse the English label', () => {
  const buttons = {
    en: ['\u{1F680} Create Account', '\u{1F393} How It Works', '\u{1F4AC} Customer Support', '\u{1F4B3} Partner Payment Support'],
    pt: ['\u{1F680} Criar conta', '\u{1F393} Como funciona', '\u{1F4AC} Suporte ao cliente', '\u{1F4B3} Suporte de pagamentos a parceiros'],
    ar: ['\u{1F680} \u0625\u0646\u0634\u0627\u0621 \u062d\u0633\u0627\u0628', '\u{1F393} \u0643\u064a\u0641 \u064a\u0639\u0645\u0644',
      '\u{1F4AC} \u062f\u0639\u0645 \u0627\u0644\u0639\u0645\u0644\u0627\u0621', '\u{1F4B3} \u062f\u0639\u0645 \u0645\u062f\u0641\u0648\u0639\u0627\u062a \u0627\u0644\u0634\u0631\u0643\u0627\u0621']
  };
  for (const locale of LOCALES) {
    const texts = render('welcome', locale, CTX).buttons.map((b) => b.text);
    assert.deepStrictEqual(texts, buttons[locale], locale + ' button labels');
    for (const text of texts) {
      assert.match(text, /^\p{Extended_Pictographic}\s/u, locale + ' button is missing an icon');
    }
  }
  assert.notStrictEqual(LABELS.pt.buttons.support, LABELS.en.buttons.support);
  assert.notStrictEqual(LABELS.ar.buttons.register, LABELS.en.buttons.register);
});

test('the row layout survives the queue round trip used by the publisher', () => {
  const built = buildStartHereRow({ config: CONFIG, scheduledFor: '2026-10-28T09:00:00Z' });
  const stored = JSON.parse(JSON.stringify(built.content.buttons));
  assert.deepStrictEqual(groupButtons(stored).map((row) => row.map((b) => b.url)), [
    [DESTINATIONS.register, DESTINATIONS.howItWorks],
    [DESTINATIONS.support, DESTINATIONS.partnerSupport]
  ]);
});

// ---------------------------------------------------------------------------
// 3. Localizations
// ---------------------------------------------------------------------------

test('every supported language has its own welcome and Start Here copy', () => {
  const english = render('welcome', 'en', CTX).text;
  const englishStart = render('startHere', 'en', CTX).text;
  assert.notStrictEqual(render('welcome', 'pt', CTX).text, english);
  assert.notStrictEqual(render('welcome', 'ar', CTX).text, english);
  assert.notStrictEqual(render('startHere', 'pt', CTX).text, englishStart);
  assert.notStrictEqual(render('startHere', 'ar', CTX).text, englishStart);

  assert.ok(render('welcome', 'pt', CTX).text.includes('Comunidade de Parceiros Arbitrix'));
  assert.ok(render('startHere', 'pt', CTX).text.includes('COMECE AQUI'));
  assert.ok(render('welcome', 'ar', CTX).text.includes('\u0645\u062c\u062a\u0645\u0639 \u0634\u0631\u0643\u0627\u0621 Arbitrix'));
  assert.ok(render('startHere', 'ar', CTX).text.includes('\u0627\u0628\u062f\u0623 \u0645\u0646 \u0647\u0646\u0627'));
});

test('the localized messages keep the Referral page instruction and the one-time reward', () => {
  const referralPage = {
    pt: /se\u00e7\u00e3o Indica\u00e7\u00f5es/,
    ar: /\u0642\u0633\u0645 \u0627\u0644\u0625\u062d\u0627\u0644\u0627\u062a/
  };
  const once = {
    pt: /\u00fanica/,
    ar: /\u0645\u0631\u0629 \u0648\u0627\u062d\u062f\u0629/
  };
  for (const [locale, pattern] of Object.entries(referralPage)) {
    assert.match(render('welcome', locale, CTX).text, pattern, locale + ' welcome: Referral section');
    assert.match(render('startHere', locale, CTX).text, pattern, locale + ' Start Here: Referral section');
  }
  for (const [locale, pattern] of Object.entries(once)) {
    assert.match(render('welcome', locale, CTX).text, pattern, locale + ' welcome: one-time reward');
    assert.match(render('startHere', locale, CTX).text, pattern, locale + ' Start Here: one-time reward');
  }
});

test('the URLs stay unchanged in every language', () => {
  for (const locale of LOCALES) {
    for (const kind of ['welcome', 'startHere']) {
      const out = render(kind, locale, CTX);
      for (const url of Object.values(DESTINATIONS)) {
        const inText = out.text.includes(url);
        const inButton = out.buttons.some((b) => b.url === url);
        assert.ok(inText || inButton, locale + '/' + kind + ' is missing ' + url);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Configuration + delivery
// ---------------------------------------------------------------------------

test('the confirmed destinations are the defaults when the environment is empty', () => {
  const cfg = resolveMarketingConfig({});
  assert.strictEqual(cfg.registerUrl, DESTINATIONS.register);
  assert.strictEqual(cfg.howItWorksUrl, DESTINATIONS.howItWorks);
  assert.strictEqual(cfg.supportUrl, DESTINATIONS.support);
  assert.strictEqual(cfg.partnerSupportUrl, DESTINATIONS.partnerSupport);
});

test('a configured value still wins over the default destination', () => {
  const cfg = resolveMarketingConfig({
    BASE_URL: 'https://arbitrix.pro',
    TELEGRAM_SUPPORT_USERNAME: '@ArbitrixHelp',
    TELEGRAM_MARKETING_HOW_IT_WORKS_URL: 'https://arbitrix.pro/walkthrough'
  });
  assert.strictEqual(cfg.howItWorksUrl, 'https://arbitrix.pro/walkthrough');
  assert.strictEqual(cfg.supportUrl, 'https://t.me/ArbitrixHelp');
});

test('a new member receives the approved welcome and the working keyboard end to end', async () => {
  const sent = [];
  const onboarding = createOnboarding({
    config: CONFIG,
    transport: {
      async sendMessage(chatId, text, options) {
        sent.push({ chatId, text, options });
        return { message_id: 4242 };
      }
    },
    store: { async recordSend() { return { ok: true }; } },
    logger: { log() {}, warn() {}, error() {} }
  });
  const result = await onboarding.handleNewMembers({
    chatId: CONFIG.groupChatId,
    members: [{ id: '777', name: 'Ana', isBot: false }],
    messageId: '9'
  });
  assert.strictEqual(result.sent, true);
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].text.includes('Welcome to the Arbitrix Partners Community!'));
  const keyboard = sent[0].options.reply_markup.inline_keyboard;
  assert.deepStrictEqual(keyboard.map((row) => row.map((b) => b.url)), [
    [DESTINATIONS.register, DESTINATIONS.howItWorks],
    [DESTINATIONS.support, DESTINATIONS.partnerSupport]
  ]);
});

test('the welcome and Start Here remain publishable by the content guard', () => {
  for (const locale of LOCALES) {
    for (const kind of ['welcome', 'startHere']) {
      const guard = checkContent(render(kind, locale, CTX).text, Object.assign({ locale }, FACTS));
      assert.strictEqual(guard.blocked, false, locale + '/' + kind + ' blocked');
      assert.strictEqual(guard.requiresApproval, false, locale + '/' + kind + ' needs approval');
    }
  }
});

test('the pinned Start Here guide keeps the responsible-promotion guidance', () => {
  const heading = {
    en: '\u{1F91D} PROMOTE RESPONSIBLY',
    pt: '\u{1F91D} DIVULGUE COM RESPONSABILIDADE',
    ar: '\u{1F91D} \u0631\u064e\u0648\u0651\u062c \u0628\u0645\u0633\u0624\u0648\u0644\u064a\u0629'
  };
  const body = {
    en: /never promise profits/i,
    pt: /nunca prometa lucros/i,
    ar: /\u0644\u0627 \u062a\u0639\u062f \u0628\u0623\u0631\u0628\u0627\u062d/
  };
  for (const locale of LOCALES) {
    const text = render('startHere', locale, CTX).text;
    assert.ok(text.includes(heading[locale]), locale + ' lost the promotion guidance heading');
    assert.match(text, body[locale], locale + ' lost the no-profit-promise instruction');
    // The guidance follows the reward and precedes the support block.
    assert.ok(text.indexOf(heading[locale]) > text.indexOf('$' + FACTS.minDeposit),
      locale + ' promotion guidance must come after the reward');
    // ...and it stays out of the welcome, which follows the approved copy exactly.
    assert.ok(!render('welcome', locale, CTX).text.includes(heading[locale]),
      locale + ' welcome must not carry the partner-only guidance');
  }
});

test('the Start Here guide is never pinned as a side effect of queueing it', () => {
  const onboarding = fs.readFileSync(path.join(ROOT, 'services', 'MarketingOnboarding.js'), 'utf8');
  assert.ok(!/pinChatMessage/.test(onboarding), 'the onboarding module must not pin anything');
  assert.ok(!/pinChatMessage/.test(fs.readFileSync(path.join(ROOT, 'services', 'MarketingContent.js'), 'utf8')));
  assert.ok(!/autoPin|pin:\s*true/i.test(onboarding), 'no automatic pin flag may exist');

  const built = buildStartHereRow({ config: CONFIG, scheduledFor: '2026-10-28T09:00:00Z' });
  assert.strictEqual(built.row.audience, 'group');
  assert.strictEqual(built.row.status, 'scheduled');
  assert.strictEqual(built.row.chat_id, null, 'a destination is never stored on the row');

  // Pinning stays an explicit, admin-only action guarded by an existing message.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const pinRoute = server.slice(server.indexOf("app.post('/api/admin/marketing/pin'"));
  const routeBody = pinRoute.slice(0, pinRoute.indexOf('app.post(', 10));
  assert.match(routeBody, /authMiddleware, adminMiddleware/);
  assert.match(routeBody, /A published message id is required/);
});

test('the keyboard is valid for the Telegram Bot API on every client', () => {
  for (const locale of LOCALES) {
    const keyboard = render('welcome', locale, CTX).replyMarkup.inline_keyboard;
    assert.ok(keyboard.length <= 8, 'Telegram allows at most 8 rows');
    for (const row of keyboard) {
      assert.ok(row.length <= 8, 'Telegram allows at most 8 buttons per row');
      for (const button of row) {
        assert.ok(button.text.length > 0 && button.text.length <= 64,
          locale + ' button label must fit Telegram\'s 64-character limit');
        assert.match(button.url, /^https:\/\/\S+$/, locale + ' button URL must be absolute https');
        assert.ok(!/\s/.test(button.url), 'a URL with whitespace is rejected by Telegram');
      }
    }
  }
});

test('the welcome templates contain no secret and no money-moving reference', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'MarketingContent.js'), 'utf8');
  assert.ok(!/record_trade_safe|credit_payment_safe|charge_subscription_safe/.test(source));
  assert.ok(!/TELEGRAM_BOT_TOKEN\s*[:=]\s*['"][^'"]+['"]/.test(source));
  assert.ok(!/https:\/\/t\.me\/[A-Za-z0-9_]+s$/m.test(source), 'no invented handle');
});
