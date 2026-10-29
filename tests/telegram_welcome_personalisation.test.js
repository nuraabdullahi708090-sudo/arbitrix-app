'use strict';

/**
 * Personalised partner welcome + referral-link instructions.
 *
 * These tests drive the REAL path a join takes - TelegramSupportService
 * routeUpdate -> MarketingOnboarding.handleNewMembers -> MarketingContent
 * render -> transport.sendMessage - with only the HTTP transport faked, so a
 * regression in any layer (wrong name source, unsanitised name, lost greeting,
 * drifted referral copy) fails here.
 *
 * The dashboard instructions are pinned against public/index.html: the copy
 * tells members to scroll their dashboard to the Referral section, so that
 * section has to exist there with a code, a link and copy buttons.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createOnboarding } = require('../services/MarketingOnboarding');
const { render, sanitizeGreetingName, GREETING_NAME_MAX, LOCALES, LABELS } = require('../services/MarketingContent');
const { resolveMarketingConfig } = require('../services/TelegramBroadcast');
const { routeUpdate } = require('../services/TelegramSupportService');
const { checkContent } = require('../services/ContentGuard');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const GROUP_ID = '-1001234567890';
const BOT_NAME = 'ArbitrixSupportBot';
const ADMIN_FIRST_NAME = 'Operations';

const FACTS = { minDeposit: 100, referralPercent: 20 };
const CONFIG = Object.assign(resolveMarketingConfig({ BASE_URL: 'https://arbitrix.pro' }), {
  facts: FACTS,
  groupChatId: GROUP_ID,
  enabled: true,
  dryRun: false
});
const CTX = Object.assign({}, CONFIG, FACTS);

/**
 * Run one real join update through routing + onboarding and return what would
 * have been sent to Telegram.
 */
async function runJoin({ members, locale = 'en', messageId = '900' }) {
  const sent = [];

  const onboarding = createOnboarding({
    config: Object.assign({}, CONFIG, { locale }),
    transport: {
      async sendMessage(chatId, text, options) {
        sent.push({ chatId, text, options });
        return { message_id: 4242 };
      }
    },
    store: { async recordSend() { return { ok: true }; } },
    logger: { log() {}, warn() {}, error() {} }
  });

  const route = routeUpdate({
    update_id: 1,
    message: {
      message_id: Number(messageId),
      chat: { id: Number(GROUP_ID), type: 'supergroup', title: 'Arbitrix Partners' },
      from: { id: 42, first_name: ADMIN_FIRST_NAME, is_bot: false },
      new_chat_members: members
    }
  }, { adminIds: ['42'], supportChatId: GROUP_ID, notifyTarget: 'admins' });

  assert.strictEqual(route.kind, 'join', 'routing must classify the update as a join');
  const result = await onboarding.handleNewMembers(route);
  return { route, result, sent };
}

const human = (over) => Object.assign({ id: 777, first_name: 'Ana', is_bot: false }, over || {});

// ---------------------------------------------------------------------------
// A. Personalisation
// ---------------------------------------------------------------------------

test('the joining member\'s own Telegram first name appears in the welcome', async () => {
  const { route, sent } = await runJoin({ members: [human({ id: 777, first_name: 'Ana', last_name: 'Silva' })] });

  // The member's raw first_name is carried on the join event (no last name, no
  // @username, no synthetic "user <id>").
  assert.strictEqual(route.members[0].firstName, 'Ana');
  assert.strictEqual(route.members[0].name, 'Ana Silva');

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text.split('\n')[0], '\u{1F44B} Welcome to the Arbitrix Partners Community, Ana!');
  assert.ok(!sent[0].text.includes('Silva'), 'only the first name is used');
});

test('the bot name and the administrator name are never used for the greeting', async () => {
  const { sent } = await runJoin({ members: [human({ id: 777, first_name: 'Ana' })] });
  const text = sent[0].text;
  assert.ok(!text.includes(BOT_NAME), 'the bot name must not appear in the greeting');
  assert.ok(!text.startsWith('\u{1F44B} Welcome to the Arbitrix Partners Community, ' + ADMIN_FIRST_NAME),
    'the admin who triggered the service message must not be greeted');
  assert.ok(text.startsWith('\u{1F44B} Welcome to the Arbitrix Partners Community, Ana!'));
});

test('a bot joining the group is never welcomed in the member\'s place', async () => {
  const { sent, result } = await runJoin({
    members: [{ id: 999, first_name: 'SomeBot', is_bot: true }]
  });
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.skipped, 'no-human-members');
  assert.strictEqual(sent.length, 0);
});

test('a member with no usable first name gets the friendly generic greeting', async () => {
  const variants = [
    undefined,
    null,
    '',
    '   ',
    '\u200B\u200B',
    'undefined',
    'NULL',
    '<b></b>'
  ];
  for (const firstName of variants) {
    const { sent } = await runJoin({ members: [human({ id: 778, first_name: firstName })] });
    const firstLine = sent[0].text.split('\n')[0];
    assert.strictEqual(firstLine, '\u{1F44B} Welcome to the Arbitrix Partners Community!',
      'generic greeting expected for ' + JSON.stringify(firstName));
    assert.ok(!/undefined|null|NaN|,\s*!/.test(firstLine), 'no placeholder artifacts');
  }
});

test('several people joining in one service message get the generic greeting', async () => {
  const { sent, result } = await runJoin({
    members: [human({ id: 801, first_name: 'Ana' }), human({ id: 802, first_name: 'Ben' })]
  });
  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.text.split('\n')[0], '\u{1F44B} Welcome to the Arbitrix Partners Community!');
  assert.strictEqual(sent.length, 1, 'one welcome for the service message');
});

// ---------------------------------------------------------------------------
// Safe name handling (the transport sends PLAIN TEXT - no parse_mode)
// ---------------------------------------------------------------------------

test('the transport sends plain text, so names are sanitised rather than HTML-escaped', async () => {
  const { sent } = await runJoin({ members: [human({ id: 803, first_name: 'A&B <b>x</b>' })] });
  const options = sent[0].options || {};
  assert.ok(!('parse_mode' in options), 'no parse_mode is set: escaping would be wrong here');
  const line = sent[0].text.split('\n')[0];
  assert.ok(line.includes('A&B'), 'an ampersand survives intact (no &amp; escaping)');
  assert.ok(!line.includes('<'), 'markup characters are removed');
  assert.ok(!line.includes('>'), 'markup characters are removed');
});

test('sanitizeGreetingName neutralises hostile and unusable names', () => {
  assert.strictEqual(sanitizeGreetingName('Ana'), 'Ana');
  assert.strictEqual(sanitizeGreetingName('  Ana  Maria '), 'Ana Maria');
  assert.strictEqual(sanitizeGreetingName('Ana\nMaria'), 'Ana Maria', 'no line breaks');
  assert.strictEqual(sanitizeGreetingName('Ana\u0000Maria'), 'Ana Maria');
  assert.strictEqual(sanitizeGreetingName('Ana\u202Eevil'), 'Anaevil', 'bidi override removed');
  assert.strictEqual(sanitizeGreetingName('Ana\u200B\u200F'), 'Ana', 'zero-width removed');
  assert.strictEqual(sanitizeGreetingName('<script>x</script>Ana'), 'xAna');
  assert.strictEqual(sanitizeGreetingName('*bold*_x_'), '*bold*_x_', 'markdown chars are inert in plain text');
  assert.strictEqual(sanitizeGreetingName('Дима'), 'Дима', 'unicode names preserved');
  assert.strictEqual(sanitizeGreetingName('محمد'), 'محمد', 'arabic names preserved');
  assert.strictEqual(sanitizeGreetingName('Jo\u00e3o'), 'Jo\u00e3o', 'accented names preserved');

  const long = 'x'.repeat(200);
  assert.strictEqual(sanitizeGreetingName(long).length, GREETING_NAME_MAX, 'capped to the Telegram limit');

  for (const bad of [null, undefined, '', '   ', 'null', 'undefined', 'N/A', '<b></b>']) {
    assert.strictEqual(sanitizeGreetingName(bad), null, 'unusable: ' + JSON.stringify(bad));
  }
});

test('legitimate names in many scripts are accepted unchanged', () => {
  const legit = [
    'Ana', "O'Brien", 'Jean-Luc', 'Ana Mar\u00eda', 'Mar\u00eda de los \u00c1ngeles',
    'Ana-Maria von Habsburg', 'Zo\u00eb', '\u00d1u\u00f1o', 'Bj\u00f6rk', 'S\u00f8ren',
    'Ng\u00f4', 'Ayaan', 'Priya', 'Kwame', '\u041c\u0430\u0440\u0456\u044f', '\u041b\u0430\u0434\u0430',
    '\u0645\u062d\u0645\u062f', '\u0639\u0628\u062f \u0627\u0644\u0644\u0647', '\u674e'
  ];
  for (const name of legit) {
    assert.strictEqual(sanitizeGreetingName(name), name, 'must not mangle ' + name);
  }
});

test('names that read like an instruction, a handle or a link are refused', () => {
  const refused = [
    'DM me @scam',
    'Send your seed phrase',
    'CLICK HERE',
    'Join t.me/scam',
    'https://evil.example',
    'Buy bonus now',
    'a/b',
    'x:y'
  ];
  for (const name of refused) {
    assert.strictEqual(sanitizeGreetingName(name), null, 'must refuse ' + name);
  }
});

test('a name can never break the message layout or inject markup', async () => {
  const hostile = [
    'Ana\u202E',
    '<a href="https://evil.example">Ana</a>',
    'Ana\n\nReply with your password',
    '\u0007Ana\u0007'
  ];
  for (const firstName of hostile) {
    const { sent } = await runJoin({ members: [human({ id: 809, first_name: firstName })] });
    const text = sent[0].text;
    const firstLine = text.split('\n')[0];
    assert.ok(firstLine.startsWith('\u{1F44B} Welcome'), 'the greeting stays the first line');
    assert.ok(!/<\/?[a-z]/i.test(firstLine), 'no markup in the greeting line');
    assert.strictEqual(text.split('\n')[1], '', 'the name cannot add an extra line');
    assert.ok(!/password/i.test(firstLine));
  }
});

// ---------------------------------------------------------------------------
// B. Referral instructions
// ---------------------------------------------------------------------------

test('the welcome points at the Referral page in one sentence; the guide walks through it', () => {
  // Approved final copy: the WELCOME carries the single instruction, and the
  // pinned Start Here guide carries the full walkthrough. Neither may imply that
  // a personal link is sent to the member automatically.
  const intro = "After registering, log into your account and open the Referral page. "
    + "There, you'll find your personal referral link and code.";
  const steps = [
    'Log in to your Arbitrix account.',
    'Open your account dashboard.',
    'Scroll down to the Referral section.',
    'Copy the link and share it with the people you invite.'
  ];
  const reminder = "Can't find your referral link? Scroll down your account dashboard to locate the Referral section.";

  const welcome = render('welcome', 'en', CTX).text;
  assert.ok(welcome.includes(intro), 'the welcome is missing the approved referral sentence');
  for (const step of steps) {
    assert.ok(!welcome.includes('\u2022 ' + step), 'the welcome must not carry the guide walkthrough: ' + step);
  }

  const guide = render('startHere', 'en', CTX).text;
  assert.ok(guide.includes(intro), 'the guide is missing the approved referral sentence');
  for (const step of steps) {
    assert.ok(guide.includes('\u2022 ' + step), 'the guide is missing step: ' + step);
  }
  assert.ok(guide.includes(reminder), 'the guide is missing the reminder');
  // Order inside the guide: the sentence, then the steps in sequence, then the reminder.
  const positions = steps.map((s) => guide.indexOf(s));
  assert.deepStrictEqual(positions.slice().sort((a, b) => a - b), positions, 'guide steps out of order');
});

test('the referral copy never invents a personal link or a referral URL', () => {
  for (const locale of LOCALES) {
    for (const kind of ['welcome', 'startHere']) {
      const text = render(kind, locale, CTX).text;
      assert.ok(!/[?&]ref=/i.test(text), locale + '/' + kind + ' fabricates a referral query parameter');
      assert.ok(!/\?start=|t\.me\/[^/\s]+\?start/i.test(text), locale + '/' + kind + ' fabricates a t.me referral link');
      assert.ok(!/arbitrix\.pro\/(r|ref|referral)\//i.test(text), locale + '/' + kind + ' fabricates a referral path');
      // The only URLs are the four approved destinations.
      const urls = text.match(/https?:\/\/\S+/g) || [];
      for (const url of urls) {
        assert.ok([
          'https://arbitrix.pro/?action=create-account',
          'https://arbitrix.pro/how-it-works',
          'https://t.me/ArbitrixSupportBot',
          'https://t.me/AlexArbitrix',
          'https://t.me/OliviaArbitrix'
        ].includes(url.replace(/[.,]$/, '')), locale + '/' + kind + ' contains an unapproved URL: ' + url);
      }
    }
  }
});

test('the step list and reminder are translated, not copied from English', () => {
  const en = render('startHere', 'en', CTX).text;
  for (const locale of ['pt', 'ar']) {
    const text = render('startHere', locale, CTX).text;
    assert.notStrictEqual(text, en);
    // No English sentence from the walkthrough survives in the translation.
    for (const line of LABELS.en.referralSteps) {
      assert.ok(!text.includes(line), locale + ' leaked the English step: ' + line);
    }
    assert.ok(!text.includes(LABELS.en.referralReminder), locale + ' leaked the English reminder');
    assert.ok(!text.includes(LABELS.en.referralIntro), locale + ' leaked the English lead-in');
    // ...and the localized walkthrough is actually present and bulleted.
    assert.ok(text.includes('\u2022 ' + LABELS[locale].referralSteps[0]));
    assert.ok(text.includes(LABELS[locale].referralReminder));
  }
  // Arabic keeps the Referral section in Arabic script, in both messages.
  for (const kind of ['welcome', 'startHere']) {
    assert.ok(render(kind, 'ar', CTX).text.includes('\u0642\u0633\u0645 \u0627\u0644\u0625\u062d\u0627\u0644\u0627\u062a'), kind);
  }
});

test('the instructions match the real dashboard, which is where the Referral card lives', () => {
  // The Referral card sits inside #mainContent (the dashboard the copy names) and
  // carries the code, the link and a copy button for each.
  const mainContentAt = INDEX.indexOf('id="mainContent"');
  const referralAt = INDEX.indexOf('<!-- REFERRAL SECTION -->');
  assert.ok(mainContentAt > -1 && referralAt > mainContentAt, 'the Referral card is on the dashboard page');
  assert.ok(INDEX.includes('id="referralCodeDisplay"'), 'the dashboard shows the referral code');
  assert.ok(INDEX.includes('id="referralLinkDisplay"'), 'the dashboard shows the referral link');
  assert.ok(INDEX.includes('id="copyReferralBtn"') && INDEX.includes('id="copyReferralLinkBtn"'),
    'the dashboard offers copy buttons, as the copy instructs');
  // ...and the sidebar shortcut that also reaches it stays in place.
  assert.ok(/data-section="referral"/.test(INDEX), 'the sidebar still links to the Referral section');
});

// ---------------------------------------------------------------------------
// C. Preserved behaviour
// ---------------------------------------------------------------------------

test('localisation covers all three languages for the greeting and the walkthrough', async () => {
  const expected = {
    en: 'Welcome to the Arbitrix Partners Community, Ana!',
    pt: 'Boas-vindas \u00e0 Comunidade de Parceiros Arbitrix, Ana!',
    ar: '\u0645\u0631\u062d\u0628\u064b\u0627 \u0628\u0643 \u0641\u064a \u0645\u062c\u062a\u0645\u0639 \u0634\u0631\u0643\u0627\u0621 Arbitrix\u060c Ana!'
  };
  for (const locale of LOCALES) {
    const { sent } = await runJoin({ members: [human({ id: 900 + LOCALES.indexOf(locale), first_name: 'Ana' })], locale });
    assert.ok(sent[0].text.includes(expected[locale]), locale + ' greeting');
    // The join message carries the approved Referral-page sentence, localized.
    assert.ok(sent[0].text.includes(LABELS[locale].referralIntro), locale + ' referral instruction');
  }
});

test('the personalised welcome keeps official support and both partners', async () => {
  const URLs = [
    ['https://arbitrix.pro/?action=create-account', 'https://arbitrix.pro/how-it-works'],
    ['https://t.me/ArbitrixSupportBot', 'https://t.me/AlexArbitrix'],
    ['https://t.me/OliviaArbitrix']
  ];
  const enLabels = [
    ['\u{1F680} Create Account', '\u{1F393} How It Works'],
    ['\u{1F4AC} Customer Support', '\u{1F4B3} Contact Alex'],
    ['\u{1F4B3} Contact Olivia']
  ];
  for (const locale of LOCALES) {
    const { sent } = await runJoin({ members: [human({ id: 950 + LOCALES.indexOf(locale), first_name: 'Ana' })], locale });
    const rows = sent[0].options.reply_markup.inline_keyboard;
    assert.strictEqual(rows.length, 3, locale + ' must have three rows');
    assert.deepStrictEqual(rows.map((r) => r.length), [2, 2, 1], locale + ' must be 2x2 + 1');
    assert.deepStrictEqual(rows.map((r) => r.map((b) => b.url)), URLs, locale + ' URLs');
    if (locale === 'en') {
      assert.deepStrictEqual(rows.map((r) => r.map((b) => b.text)), enLabels);
    }
    // Localized labels still fit Telegram's 64-character button limit.
    for (const button of rows.flat()) {
      assert.ok(button.text.length > 0 && button.text.length <= 64, locale + ' label length');
    }
  }
});

test('the business facts are unchanged and still interpolated', () => {
  const text = render('welcome', 'en', CTX).text;
  assert.ok(text.includes('one-time reward equal to 20% of a referred user'));
  assert.ok(text.includes('first qualifying deposit of $100 or more'));
  assert.ok(!/recurring|lifetime|passive income/i.test(text));
  const guard = checkContent(text, Object.assign({ locale: 'en' }, FACTS));
  assert.strictEqual(guard.blocked, false);
  assert.strictEqual(guard.requiresApproval, false);

  // The personalised variant must pass the same send-time guard.
  for (const locale of LOCALES) {
    const personalised = render('welcome', locale, Object.assign({ name: 'Ana' }, CTX)).text;
    const checked = checkContent(personalised, Object.assign({ locale }, FACTS));
    assert.strictEqual(checked.blocked, false, locale + ' personalised welcome blocked');
    assert.strictEqual(checked.requiresApproval, false, locale + ' personalised welcome needs approval');
  }
});

test('the Start Here guide is still queue-only (no automatic pin)', () => {
  const onboarding = fs.readFileSync(path.join(ROOT, 'services', 'MarketingOnboarding.js'), 'utf8');
  assert.ok(!/pinChatMessage/.test(onboarding));
  const content = fs.readFileSync(path.join(ROOT, 'services', 'MarketingContent.js'), 'utf8');
  assert.ok(!/pinChatMessage/.test(content));
});
