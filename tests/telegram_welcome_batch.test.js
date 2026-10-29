'use strict';

/**
 * Multiple members joining in ONE Telegram service message, including mixed
 * human/bot batches.
 *
 * These tests drive the REAL path - TelegramSupportService.routeUpdate ->
 * MarketingOnboarding.handleNewMembers -> MarketingContent.render ->
 * transport.sendMessage - so a regression in routing, member filtering,
 * greeting choice, delivery or de-duplication fails here rather than in the
 * partner group.
 *
 * Contract under test:
 *   - every member is inspected INDIVIDUALLY: a bot never suppresses the humans
 *     beside it, and a bot-only batch greets nobody;
 *   - ONE welcome per service message: personalised when exactly one human
 *     joined, generic when several did (nobody is named);
 *   - a redelivered service message is not greeted twice, and a send that FAILED
 *     does not consume the member's one welcome.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  routeUpdate,
  createTelegramSupportBot
} = require('../services/TelegramSupportService');
const {
  createOnboarding,
  selectWelcomeTargets,
  pickGreetingName
} = require('../services/MarketingOnboarding');
const { resolveMarketingConfig } = require('../services/TelegramBroadcast');
const { checkContent } = require('../services/ContentGuard');

const GROUP_ID = '-1001234567890';
const OTHER_GROUP = '-1000000000123';
const BOT_NAME = 'ArbitrixSupportBot';
const ADMIN_ID = 42;
const ADMIN_FIRST_NAME = 'Operations';

const BASE_CONFIG = resolveMarketingConfig({ BASE_URL: 'https://arbitrix.pro' });
const FACTS = { minDeposit: 100, referralPercent: 20 };
const CONFIG = Object.assign({}, BASE_CONFIG, {
  facts: FACTS,
  groupChatId: GROUP_ID,
  enabled: true,
  dryRun: false
});

const DESTINATIONS = {
  register: 'https://arbitrix.pro/?action=create-account',
  howItWorks: 'https://arbitrix.pro/how-it-works',
  support: 'https://t.me/ArbitrixSupportBot',
  partnerAlex: 'https://t.me/AlexArbitrix',
  partnerOlivia: 'https://t.me/OliviaArbitrix'
};

const GENERIC_EN = '\u{1F44B} Welcome to the Arbitrix Partners Community!';
const namedEn = (name) => '\u{1F44B} Welcome to the Arbitrix Partners Community, ' + name + '!';

// --- harness ---------------------------------------------------------------

function recordingTransport(options) {
  const o = options || {};
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, opts) {
      if (o.throwOn) throw new Error(o.throwOn);
      sent.push({ chatId, text, options: opts });
      return { message_id: 4000 + sent.length };
    }
  };
}

function onboardingWith(transport, overrides) {
  const audits = [];
  const store = overrides && overrides.store
    ? overrides.store
    : { async recordSend(row) { audits.push(row); return { ok: true }; } };
  const onboarding = createOnboarding({
    config: Object.assign({}, CONFIG, (overrides && overrides.config) || {}),
    transport,
    store,
    logger: { log() {}, warn() {}, error() {} }
  });
  return { onboarding, audits };
}

/** Build a REAL Telegram update as Telegram would deliver it. */
function joinUpdate(members, over) {
  return Object.assign({
    update_id: 500,
    message: {
      message_id: 77,
      chat: { id: Number(GROUP_ID), type: 'supergroup', title: 'Arbitrix Partners' },
      from: { id: ADMIN_ID, first_name: ADMIN_FIRST_NAME, is_bot: false },
      new_chat_members: members
    }
  }, over || {});
}

const human = (id, firstName) => ({ id, first_name: firstName, is_bot: false });
const bot = (id, name) => ({ id, first_name: name || 'SomeBot', is_bot: true });

/** Route the update for real, then run onboarding on the routed join event. */
async function deliver(update, opts) {
  const o = opts || {};
  const transport = o.transport || recordingTransport();
  const built = onboardingWith(transport, o);
  const route = routeUpdate(update, { adminIds: [String(ADMIN_ID)], supportChatId: GROUP_ID, notifyTarget: 'admins' });
  assert.strictEqual(route.kind, 'join', 'routing must classify the update as a join');
  const result = await built.onboarding.handleNewMembers(route);
  return { route, result, transport, onboarding: built.onboarding, audits: built.audits };
}

const firstLine = (text) => String(text || '').split('\n')[0];

// ---------------------------------------------------------------------------
// Pure classification helpers
// ---------------------------------------------------------------------------

// The helper consumes the ROUTED member shape produced by routeUpdate
// ({id, firstName, name, isBot}), which is what the handler receives.
const routed = (id, firstName, isBot) => ({ id: String(id), firstName: firstName === undefined ? null : firstName, isBot: isBot === true });

test('selectWelcomeTargets inspects each member individually', () => {
  const { humans, bots, received } = selectWelcomeTargets([
    routed(1, 'Ana'),
    routed(2, 'SomeBot', true),
    routed(3, 'Ben'),
    routed(4, 'Helper', true),
    null,
    {},
    { id: '5', firstName: 'Cara', isBot: false }
  ]);
  assert.deepStrictEqual(humans.map((m) => m.firstName), ['Ana', 'Ben', 'Cara']);
  assert.deepStrictEqual(bots.map((m) => m.id), ['2', '4']);
  assert.strictEqual(received, 7);
});

test('selectWelcomeTargets de-duplicates ids and tolerates a non-array', () => {
  const dupes = selectWelcomeTargets([routed(1, 'Ana'), routed(1, 'Ana again')]);
  assert.strictEqual(dupes.humans.length, 1);
  assert.strictEqual(dupes.humans[0].firstName, 'Ana');

  for (const bad of [undefined, null, 'nope', 42]) {
    const out = selectWelcomeTargets(bad);
    assert.deepStrictEqual(out.humans, []);
    assert.deepStrictEqual(out.bots, []);
    assert.strictEqual(out.received, 0);
  }
});

test('pickGreetingName names one human and nobody in a group', () => {
  assert.strictEqual(pickGreetingName([{ id: '1', firstName: 'Ana' }]), 'Ana');
  assert.strictEqual(pickGreetingName([{ id: '1', firstName: 'Ana' }, { id: '2', firstName: 'Ben' }]), null);
  assert.strictEqual(pickGreetingName([{ id: '1', firstName: null }]), null);
  assert.strictEqual(pickGreetingName([]), null);
  assert.strictEqual(pickGreetingName(undefined), null);
});

// ---------------------------------------------------------------------------
// 1 + 2 + 3 + 4: the six join shapes
// ---------------------------------------------------------------------------

test('one human joining gets one personalised welcome', async () => {
  const { result, transport } = await deliver(joinUpdate([human(1001, 'Ana')]));
  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.members, 1);
  assert.strictEqual(transport.sent.length, 1);
  assert.strictEqual(firstLine(transport.sent[0].text), namedEn('Ana'));
  assert.strictEqual(result.text, transport.sent[0].text);
});

test('several humans joining get ONE generic welcome with no name', async () => {
  const { result, transport } = await deliver(joinUpdate([human(1001, 'Ana'), human(1002, 'Ben')]));
  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.members, 2);
  assert.strictEqual(transport.sent.length, 1, 'one message for the service message');
  assert.strictEqual(firstLine(transport.sent[0].text), GENERIC_EN);
  for (const name of ['Ana', 'Ben']) {
    assert.ok(!transport.sent[0].text.includes(name), 'must not single out ' + name);
  }
});

test('five humans joining still produce exactly one welcome', async () => {
  const members = [1, 2, 3, 4, 5].map((n) => human(2000 + n, 'Member' + n));
  const { result, transport } = await deliver(joinUpdate(members));
  assert.strictEqual(transport.sent.length, 1);
  assert.strictEqual(result.members, 5);
  assert.strictEqual(firstLine(transport.sent[0].text), GENERIC_EN);
});

test('a single bot joining is never welcomed', async () => {
  const { result, transport } = await deliver(joinUpdate([bot(3001)]));
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.skipped, 'no-human-members');
  assert.strictEqual(result.bots, 1);
  assert.strictEqual(transport.sent.length, 0);
});

test('several bots joining send nothing at all', async () => {
  const { result, transport } = await deliver(joinUpdate([bot(3001, 'Alpha'), bot(3002, 'Beta'), bot(3003, 'Gamma')]));
  assert.strictEqual(result.skipped, 'no-human-members');
  assert.strictEqual(result.bots, 3);
  assert.strictEqual(transport.sent.length, 0);
});

test('a human joining next to a bot is still welcomed, and personally', async () => {
  const { result, transport } = await deliver(joinUpdate([bot(3001), human(1001, 'Ana')]));
  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.members, 1);
  assert.strictEqual(result.bots, 1);
  assert.strictEqual(transport.sent.length, 1);
  assert.strictEqual(firstLine(transport.sent[0].text), namedEn('Ana'));
  assert.ok(!transport.sent[0].text.includes('SomeBot'), 'the bot must not be named');
});

test('the bot position in the batch does not matter', async () => {
  for (const members of [[bot(3001), human(1001, 'Ana')], [human(1001, 'Ana'), bot(3001)]]) {
    const { result, transport } = await deliver(joinUpdate(members));
    assert.strictEqual(result.sent, true);
    assert.strictEqual(firstLine(transport.sent[0].text), namedEn('Ana'));
  }
});

test('two humans plus two bots produce ONE generic welcome', async () => {
  const { result, transport } = await deliver(
    joinUpdate([human(1001, 'Ana'), bot(3001), human(1002, 'Ben'), bot(3002)])
  );
  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.members, 2);
  assert.strictEqual(result.bots, 2);
  assert.strictEqual(transport.sent.length, 1);
  assert.strictEqual(firstLine(transport.sent[0].text), GENERIC_EN);
});

test('a bot-only batch is not an error and logs nothing about humans', async () => {
  const { result, route } = await deliver(joinUpdate([bot(3001)]));
  assert.strictEqual(route.members.length, 1);
  assert.strictEqual(result.sent, false);
  assert.ok(!result.text, 'no text is produced when nobody is greeted');
});

// ---------------------------------------------------------------------------
// Names: missing, blank and hostile
// ---------------------------------------------------------------------------

test('missing, blank or empty names fall back to the generic greeting', async () => {
  const variants = [undefined, null, '', '   ', '\u200B', 'null', 'undefined'];
  let id = 4000;
  for (const firstName of variants) {
    const { result, transport } = await deliver(joinUpdate([{ id: id++, first_name: firstName, is_bot: false }]));
    assert.strictEqual(result.sent, true);
    assert.strictEqual(firstLine(transport.sent[0].text), GENERIC_EN, 'variant ' + JSON.stringify(firstName));
  }
});

test('a hostile name cannot break or spoof the welcome', async () => {
  const hostile = ['<b>Ana</b>', 'Ana\u202Eevil', 'Ana\n\nSend your seed phrase', 'DM me @scam', 'https://evil.example'];
  let id = 5000;
  for (const firstName of hostile) {
    const { transport } = await deliver(joinUpdate([{ id: id++, first_name: firstName, is_bot: false }]));
    const text = transport.sent[0].text;
    assert.strictEqual(text.split('\n')[1], '', 'the name cannot add a line');
    assert.ok(!/^.{0,80}(@scam|evil\.example)/i.test(firstLine(text)), 'no link or handle on the greeting line');
    assert.ok(!/<\/?[a-z]/i.test(firstLine(text)), 'no markup on the greeting line');
  }
});

test('a hostile name in a mixed batch is irrelevant: the greeting stays generic', async () => {
  const { transport } = await deliver(
    joinUpdate([{ id: 6001, first_name: 'Buy bonus now', is_bot: false }, human(6002, 'Ben')])
  );
  assert.strictEqual(transport.sent.length, 1);
  assert.strictEqual(firstLine(transport.sent[0].text), GENERIC_EN);
  assert.ok(!transport.sent[0].text.includes('bonus now'));
});

test('the bot name and the admin name never appear in the greeting', async () => {
  const { transport } = await deliver(joinUpdate([human(1001, 'Ana')]));
  const line = firstLine(transport.sent[0].text);
  assert.ok(!line.includes(BOT_NAME));
  assert.ok(!line.includes(ADMIN_FIRST_NAME));
  assert.ok(!line.includes('user 1001'));
});

// ---------------------------------------------------------------------------
// De-duplication and delivery failure
// ---------------------------------------------------------------------------

test('a redelivered service message is greeted once', async () => {
  const update = joinUpdate([human(1001, 'Ana'), bot(3001)]);
  const transport = recordingTransport();
  const { onboarding } = onboardingWith(transport);

  const route = routeUpdate(update, { adminIds: [String(ADMIN_ID)], supportChatId: GROUP_ID, notifyTarget: 'admins' });
  const first = await onboarding.handleNewMembers(route);
  const second = await onboarding.handleNewMembers(route);

  assert.strictEqual(first.sent, true);
  assert.strictEqual(second.sent, false);
  assert.strictEqual(second.skipped, 'duplicate');
  assert.strictEqual(transport.sent.length, 1);
});

test('two concurrent deliveries of the same update cannot both post', async () => {
  const transport = recordingTransport();
  const { onboarding } = onboardingWith(transport);
  const route = routeUpdate(joinUpdate([human(1001, 'Ana')]), { adminIds: [], supportChatId: GROUP_ID });
  const [a, b] = await Promise.all([
    onboarding.handleNewMembers(route),
    onboarding.handleNewMembers(route)
  ]);
  assert.strictEqual([a, b].filter((r) => r.sent).length, 1, 'exactly one of the two sent');
  assert.strictEqual(transport.sent.length, 1);
});

test('a FAILED send does not consume the welcome: a redelivery then succeeds', async () => {
  // Fails the first sendMessage, succeeds afterwards - the shape of a Telegram
  // 502/429. The reservation must not survive a send that never happened.
  let calls = 0;
  const sent = [];
  const transport = {
    sent,
    async sendMessage(chatId, text, options) {
      calls += 1;
      if (calls === 1) throw new Error('Telegram sendMessage failed: Bad Gateway');
      sent.push({ chatId, text, options });
      return { message_id: 9001 };
    }
  };
  const { onboarding } = onboardingWith(transport);
  const route = routeUpdate(joinUpdate([human(1001, 'Ana')]), { adminIds: [], supportChatId: GROUP_ID });

  const failed = await onboarding.handleNewMembers(route);
  assert.strictEqual(failed.sent, false);
  assert.strictEqual(failed.skipped, 'send-failed');
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(onboarding._seenSize(), 0, 'nothing was delivered, so nothing is remembered');

  const second = await onboarding.handleNewMembers(route);
  assert.strictEqual(second.sent, true, 'the member is still owed a welcome');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(firstLine(sent[0].text), namedEn('Ana'));

  // ...and now it IS remembered, so a third delivery is a duplicate.
  const third = await onboarding.handleNewMembers(route);
  assert.strictEqual(third.skipped, 'duplicate');
  assert.strictEqual(sent.length, 1);
});

test('a successful batch send keeps one reservation per human', async () => {
  const transport = recordingTransport();
  const { onboarding } = onboardingWith(transport);
  const route = routeUpdate(joinUpdate([human(1001, 'Ana'), bot(3001), human(1002, 'Ben')]), {
    adminIds: [], supportChatId: GROUP_ID
  });
  assert.strictEqual(onboarding._seenSize(), 0);
  const result = await onboarding.handleNewMembers(route);
  assert.strictEqual(result.sent, true);
  assert.strictEqual(onboarding._seenSize(), 2, 'one key per human, none for the bot');
});

test('an audit-store failure cannot turn a delivered welcome into a failure', async () => {
  const transport = recordingTransport();
  const { onboarding } = onboardingWith(transport, {
    store: { async recordSend() { throw new Error('database is down'); } }
  });
  const route = routeUpdate(joinUpdate([human(1001, 'Ana')]), { adminIds: [], supportChatId: GROUP_ID });
  const result = await onboarding.handleNewMembers(route);
  assert.strictEqual(result.sent, true, 'the group received the message, so it was sent');
  assert.strictEqual(transport.sent.length, 1);

  // ...and the member stays welcomed, so a redelivery cannot post a second copy.
  const again = await onboarding.handleNewMembers(route);
  assert.strictEqual(again.skipped, 'duplicate');
  assert.strictEqual(transport.sent.length, 1);
});

test('the bot-level update_id deduper also drops a redelivered update', async () => {
  let welcomes = 0;
  const transport = recordingTransport();
  const bot = createTelegramSupportBot({
    config: { adminIds: [String(ADMIN_ID)], supportChatId: GROUP_ID, notifyTarget: 'admins', token: 'x', webhookSecret: 'y' },
    store: fakeSupportStore(),
    transport,
    logger: { log() {}, warn() {}, error() {} },
    onNewMembers: async () => {
      welcomes += 1;
      return { sent: true };
    }
  });

  const update = joinUpdate([human(1001, 'Ana')]);
  const first = await bot.handleUpdate(update);
  const second = await bot.handleUpdate(update);
  assert.strictEqual(first.handled, true);
  assert.strictEqual(second.action, 'duplicate');
  assert.strictEqual(welcomes, 1, 'onboarding must not run twice for one update_id');
});

function fakeSupportStore() {
  return {
    async getConversationByChatId() { return { id: 1, language: 'en' }; },
    async upsertConversation() { return { conversation: { id: 1, language: 'en' }, created: false }; },
    async insertMessage() { return { message: { id: 2 } }; },
    async createEscalation() { return { escalation: { id: 1 } }; },
    async getLatestMessageByConversation() { return { id: 1, direction: 'customer' }; }
  };
}

// ---------------------------------------------------------------------------
// Preserved behaviour: routing limits, localisation, keyboard, guard
// ---------------------------------------------------------------------------

test('a join in another group is ignored even with humans in the batch', async () => {
  const transport = recordingTransport();
  const { onboarding } = onboardingWith(transport);
  const route = routeUpdate({
    update_id: 9,
    message: {
      message_id: 8,
      chat: { id: Number(OTHER_GROUP), type: 'supergroup', title: 'Not ours' },
      from: { id: ADMIN_ID, first_name: ADMIN_FIRST_NAME },
      new_chat_members: [human(1001, 'Ana')]
    }
  }, { adminIds: [], supportChatId: GROUP_ID, notifyTarget: 'admins' });
  const result = await onboarding.handleNewMembers(route);
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.skipped, 'chat-not-configured');
  assert.strictEqual(transport.sent.length, 0);
});

test('every supported language greets a batch with its own generic copy', async () => {
  const expected = {
    en: GENERIC_EN,
    pt: '\u{1F44B} Boas-vindas \u00e0 Comunidade de Parceiros Arbitrix!',
    ar: '\u{1F44B} \u0645\u0631\u062d\u0628\u064b\u0627 \u0628\u0643 \u0641\u064a \u0645\u062c\u062a\u0645\u0639 \u0634\u0631\u0643\u0627\u0621 Arbitrix!'
  };
  for (const [locale, greeting] of Object.entries(expected)) {
    const transport = recordingTransport();
    const { onboarding } = onboardingWith(transport, { config: { locale } });
    await onboarding.handleNewMembers(routeUpdate(
      joinUpdate([human(1001, 'Ana'), human(1002, 'Ben')]),
      { adminIds: [], supportChatId: GROUP_ID }
    ));
    assert.strictEqual(firstLine(transport.sent[0].text), greeting, locale + ' batch greeting');
    // The referral walkthrough and the four destinations travel with it.
    assert.match(transport.sent[0].text, /20%/);
    const urls = transport.sent[0].options.reply_markup.inline_keyboard.map((row) => row.map((b) => b.url));
    assert.deepStrictEqual(urls, [
      [DESTINATIONS.register, DESTINATIONS.howItWorks],
      [DESTINATIONS.support, DESTINATIONS.partnerAlex]
    ], locale + ' keyboard');
    assert.ok(!JSON.stringify(urls).includes(DESTINATIONS.partnerOlivia),
      locale + ' must not offer a payment partner');
  }
});

test('the personalised and batch welcomes both keep the partner keyboard and pass the guard', async () => {
  const cases = [[human(1001, 'Ana')], [human(1001, 'Ana'), human(1002, 'Ben'), bot(3001)]];
  for (const members of cases) {
    const { transport } = await deliver(joinUpdate(members));
    const message = transport.sent[0];
    const rows = message.options.reply_markup.inline_keyboard;
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows.map((r) => r.length), [2, 2]);
    assert.deepStrictEqual(rows.map((r) => r.map((b) => b.url)), [
      [DESTINATIONS.register, DESTINATIONS.howItWorks],
      [DESTINATIONS.support, DESTINATIONS.partnerAlex]
    ]);
    assert.ok(!JSON.stringify(rows).includes(DESTINATIONS.partnerOlivia),
      'a payment partner is never offered as a recruitment contact');
    const guard = checkContent(message.text, Object.assign({ locale: 'en' }, FACTS));
    assert.strictEqual(guard.blocked, false);
    assert.strictEqual(guard.requiresApproval, false);
    // No invented personal referral URL.
    assert.ok(!/[?&]ref=/i.test(message.text));
  }
});
