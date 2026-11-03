'use strict';

/**
 * Ordinary social conversation for the Telegram support assistant.
 *
 * These tests reproduce the reported sequence and then hold the behaviour in
 * place. They drive the REAL bot (`createTelegramSupportBot`), the REAL dialogue
 * engine (`services/support/ConversationEngine`) and the REAL dictionary; only
 * the store (in-memory rows, including `context`) and the transport (records the
 * sends) are faked, so what is asserted is what a customer receives.
 *
 * The bug this file pins:
 *   1. withdrawal guidance -> "Checked"  (contextual acknowledgement)
 *   2. "Ok"      -> the help menu         (an acknowledgement read as "yes")
 *   3. "Good"    -> the generic clarify   (the fallback masked the courtesy)
 *   4. "Thank you" -> "You're welcome! ..." + the SAME clarify fallback again
 *   Leaving a stale prompt in the conversation state is what made (4) replay.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createTelegramSupportBot
} = require('../services/TelegramSupportService');
const i18n = require('../services/telegram-i18n');
const engine = require('../services/support/ConversationEngine');
const SupportGuidelines = require('../services/support/SupportGuidelines');

const CUSTOMER = '7101';
const ADMIN = '7102';
const TOKEN = '123456:SOCIAL-TEST';

let updateCounter = 810000;
const nextUpdateId = () => (updateCounter += 1);

const silentLogger = { log() {}, warn() {}, error() {}, info() {} };

// ------------------------------------------------------------------ harness ---

function createStore() {
  const conversations = new Map();
  const messages = [];
  let nextConversationId = 1;

  const store = {
    async upsertConversation({ chatId, telegramUserId, username, displayName }) {
      const key = String(chatId);
      if (!conversations.has(key)) {
        conversations.set(key, {
          id: nextConversationId++,
          telegram_chat_id: Number(chatId),
          telegram_user_id: Number(telegramUserId),
          username: username || null,
          display_name: displayName || null,
          language: 'en',
          context: null,
          created_at: new Date().toISOString()
        });
        return { conversation: conversations.get(key), created: true };
      }
      return { conversation: conversations.get(key), created: false };
    },
    async getConversationByChatId(chatId) {
      return conversations.get(String(chatId)) || null;
    },
    async getConversationById(id) {
      return Array.from(conversations.values()).find((c) => c.id === id) || null;
    },
    async insertMessage({ conversationId, direction, body }) {
      const message = {
        id: messages.length + 1,
        conversation_id: conversationId,
        direction,
        body,
        created_at: new Date(Date.now() - (1000 - messages.length)).toISOString()
      };
      messages.push(message);
      return { message };
    },
    async getLatestMessageByConversation(arg) {
      const conversationId = arg && typeof arg === 'object' ? arg.conversationId : arg;
      return messages.filter((m) => m.conversation_id === conversationId).slice(-1)[0] || null;
    },
    async createEscalation({ conversationId, supportMessageId }) {
      return { escalation: { id: messages.length + 1, conversation_id: conversationId, support_message_id: supportMessageId } };
    },
    async setConversationContext({ conversationId, context }) {
      const row = Array.from(conversations.values()).find((c) => c.id === conversationId);
      if (!row) throw new Error('no such conversation');
      row.context = context;
      return { conversation: row };
    },
    async setConversationLanguage({ conversationId, language }) {
      const row = Array.from(conversations.values()).find((c) => c.id === conversationId);
      if (row) row.language = language;
      return { conversation: row || null };
    },
    async probeColumns() {
      return { ok: true };
    }
  };

  return { store, conversations, messages };
}

function createTransport() {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, options) {
      const message_id = sent.length + 1;
      sent.push({ method: 'sendMessage', chatId: String(chatId), text, options, message_id });
      return { message_id };
    },
    async sendVideo(chatId, video, caption) {
      sent.push({ method: 'sendVideo', chatId: String(chatId), video, text: caption });
      return { message_id: sent.length + 1 };
    },
    getLastCall() { return null; }
  };
}

function createHarness({ language = 'en' } = {}) {
  const state = createStore();
  const transport = createTransport();

  state.conversations.set(CUSTOMER, {
    id: state.conversations.size + 1,
    telegram_chat_id: Number(CUSTOMER),
    telegram_user_id: Number(CUSTOMER),
    username: 'ana',
    display_name: 'Ana',
    language,
    context: null,
    created_at: new Date().toISOString()
  });

  const bot = createTelegramSupportBot({
    config: {
      token: TOKEN,
      webhookSecret: 'social-secret',
      baseUrl: 'https://arbitrix.pro',
      supportChatId: null,
      adminIds: [ADMIN],
      notifyTarget: 'admins'
    },
    store: state.store,
    transport,
    logger: silentLogger,
    supportAI: null
  });

  const customer = (m) => m.chatId === CUSTOMER && m.method === 'sendMessage';

  async function say(text, { updateId = nextUpdateId() } = {}) {
    return bot.handleUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 0,
        text,
        chat: { id: Number(CUSTOMER), type: 'private' },
        from: { id: Number(CUSTOMER), first_name: 'Ana', username: 'ana' }
      }
    });
  }

  async function adminSay(text) {
    return bot.handleUpdate({
      update_id: nextUpdateId(),
      message: {
        message_id: nextUpdateId(),
        date: 0,
        text,
        chat: { id: Number(ADMIN), type: 'private' },
        from: { id: Number(ADMIN), first_name: 'Ops', username: 'ops' }
      }
    });
  }

  return {
    bot,
    state,
    transport,
    say,
    adminSay,
    conversation: () => state.conversations.get(CUSTOMER) || null,
    context: () => (state.conversations.get(CUSTOMER) || {}).context || {},
    toCustomer: () => transport.sent.filter(customer).map((m) => m.text),
    last: () => transport.sent.filter(customer).map((m) => m.text).pop(),
    lastAdmin: () => transport.sent
      .filter((m) => m.chatId === ADMIN && m.method === 'sendMessage')
      .map((m) => m.text).pop()
  };
}

const t = (key, vars) => i18n.t('en', key, vars);
const tIn = (lang, key, vars) => i18n.t(lang, key, vars);

/** The fallback texts that must never be replayed after a courtesy. */
const FALLBACKS = () => [
  t('clarifyTopic'),
  t('clarifyHelp'),
  t('ackNoQuestion'),
  t('uncertain')
];

function assertNoReplay(reply, label) {
  for (const fallback of FALLBACKS()) {
    assert.ok(!reply.includes(fallback), (label || 'reply') + ' replayed a fallback: ' + reply);
  }
}

// ------------------------------------------- 1. the reported screenshot flow ---

test('A1. the exact screenshot sequence never replays a fallback', async () => {
  const h = createHarness();

  // 1-2. the customer asks about withdrawing and receives the guidance.
  await h.say('How do I withdraw my funds?');
  assert.ok(h.last().includes(t('withdrawIntro')), 'withdrawal guidance');
  assert.strictEqual(h.context().pending, 'withdraw.help');

  // 3-4. "Checked" gets the contextual acknowledgement.
  await h.say('Checked');
  assert.strictEqual(h.last(), t('withdrawChecked'));
  assert.strictEqual(h.context().pending, 'anything_else');

  // 5-6. "Ok" gets a short social acknowledgement - NOT the help menu.
  await h.say('Ok');
  assert.strictEqual(h.last(), t('socialAck'));
  assert.ok(!h.last().includes(t('clarifyHelp')), 'no help menu');

  // 7-8. "Good" gets a natural acknowledgement - NOT the generic clarify.
  await h.say('Good');
  assert.strictEqual(h.last(), t('socialPositive'));
  assert.ok(!h.last().includes(t('clarifyTopic')), 'no clarification fallback');

  // 9-10. "Thank you" gets a simple welcome - NOT "You're welcome! ..." plus the
  // previous fallback.
  await h.say('Thank you');
  assert.strictEqual(h.last(), t('socialThanks'));

  // 11. nothing in the transcript replays a fallback.
  const transcript = h.toCustomer();
  assert.strictEqual(transcript.length, 5, 'one reply per message');
  transcript.slice(2).forEach((reply, index) => assertNoReplay(reply, 'reply ' + (index + 3)));
});

test('A2. the same sequence works when the customer switches language', async () => {
  const h = createHarness();
  await h.say('How do I withdraw my funds?');
  await h.say('Checked');
  await h.say('Ok');
  await h.say('Good');
  await h.say('Thank you');
  assert.deepStrictEqual(h.toCustomer().slice(2), [
    t('socialAck'), t('socialPositive'), t('socialThanks')
  ]);
});

test('A3. a courtesy never re-opens the question the bot just finished', async () => {
  const h = createHarness();
  await h.say('How do I withdraw my funds?');
  await h.say('Checked');
  await h.say('Thank you');
  assert.strictEqual(h.last(), t('socialThanks'));
  assert.ok(!h.last().includes(t('withdrawHelpPrompt')), 'the withdrawal question is not re-asked');
  assert.strictEqual(h.context().pending, 'anything_else');
});

// --------------------------------------------- 2. every acknowledgement form ---

test('B1. all acknowledgement variations are recognised and answered once', async () => {
  const cases = [
    ['Ok', 'socialAck'],
    ['Okay', 'socialAck'],
    ['okay.', 'socialAck'],
    ['OK!', 'socialAck'],
    ['Alright', 'socialAck'],
    ['alright then', 'socialAck'],
    ['Understood', 'socialUnderstood'],
    ['understood.', 'socialUnderstood'],
    ['Got it', 'socialUnderstood'],
    ['got it!', 'socialUnderstood'],
    ['I understand', 'socialUnderstood'],
    ['Good', 'socialPositive'],
    ['good.', 'socialPositive'],
    ["That's good", 'socialPositive'],
    ['Great', 'socialGreat'],
    ['great!', 'socialGreat'],
    ['Nice', 'socialPositive'],
    ['Excellent', 'socialPositive'],
    ['Perfect', 'socialPositive'],
    ['Wonderful', 'socialGreat'],
    ['Thanks', 'socialThanks'],
    ['Thank you', 'socialThanks'],
    ['thank you!', 'socialThanks'],
    ['Thanks a lot', 'socialThanksBig'],
    ['Many thanks', 'socialThanksBig'],
    ['Appreciate it', 'socialThanks'],
    ["You're welcome", 'socialReciprocal'],
    // "No problem" opens with a denial word, so it is answered with the polite
    // close rather than the reciprocal line - see K1.
    ['No problem', 'thanksClose'],
    ['  Ok  ', 'socialAck'],
    ['Ok 👍', 'socialAck']
  ];

  for (const [text, key] of cases) {
    const h = createHarness();
    await h.say('How do I withdraw my funds?');
    await h.say('Checked');
    await h.say(text);
    assert.strictEqual(h.last(), t(key), JSON.stringify(text) + ' => ' + key);
    assertNoReplay(h.last(), JSON.stringify(text));
    assert.ok(!h.last().includes(t('clarifyHelp')), JSON.stringify(text) + ' opened the help menu');
  }
});

test('K1. a denial-shaped courtesy is still answered politely, never with a menu', async () => {
  // "No problem" / "no worries" answer a courtesy question as a DENIAL ("no
  // problem here"), which is why the denial reading takes precedence over the
  // reciprocal one. Either reading must land on a polite close.
  for (const text of ['No problem', 'no worries', 'no problem at all']) {
    const h = createHarness();
    await h.say('How do I withdraw my funds?');
    await h.say('Checked');
    await h.say(text);
    assertNoReplay(h.last(), text);
    assert.ok(t('thanksClose') === h.last() || t('socialReciprocal') === h.last(), text + ': ' + h.last());
  }
});

test('B2. "ok thanks" and "great, thank you" are gratitude, not two replies', async () => {
  for (const text of ['ok thanks', 'great, thank you', 'thanks, ok']) {
    const h = createHarness();
    await h.say('How do I withdraw my funds?');
    await h.say('Checked');
    const before = h.toCustomer().length;
    await h.say(text);
    assert.strictEqual(h.toCustomer().length, before + 1, 'exactly one reply');
    assert.strictEqual(h.last(), t('socialThanks'), text);
  }
});

test('B3. the same courtesy twice closes instead of repeating the identical line', async () => {
  const h = createHarness();
  await h.say('How do I withdraw my funds?');
  await h.say('Checked');
  await h.say('Thank you');
  assert.strictEqual(h.last(), t('socialThanks'));
  await h.say('Thank you');
  assert.strictEqual(h.last(), t('socialClosing'));
  assert.strictEqual(h.context().pending, null, 'the exchange is finished');
});

test('B4. a different courtesy still gets its own reply', async () => {
  const h = createHarness();
  await h.say('How do I withdraw my funds?');
  await h.say('Checked');
  await h.say('Ok');
  await h.say('Good');
  await h.say('Great');
  assert.deepStrictEqual(h.toCustomer().slice(2), [
    t('socialAck'), t('socialPositive'), t('socialGreat')
  ]);
});

// ------------------------------------------ 3. social replies after each topic ---

test('C1. courtesy after a TRUST response', async () => {
  const h = createHarness();
  await h.say('Is Arbitrix a scam?');
  assert.ok(h.last().includes(t('trustIntro')));
  await h.say('No');
  assert.strictEqual(h.last(), t('anythingElse'));
  await h.say('Ok');
  assert.strictEqual(h.last(), t('socialAck'));
  assertNoReplay(h.last(), 'trust + ok');
});

test('C2. courtesy after a PLATFORM explanation', async () => {
  const h = createHarness();
  await h.say('How does Arbitrix work?');
  assert.ok(h.last().includes(t('platformIntro')));
  await h.say('No');
  await h.say('Good');
  assert.strictEqual(h.last(), t('socialPositive'));
  assert.ok(!h.last().includes(t('platformIntro')), 'the explanation is not repeated');
});

test('C3. courtesy after an EARNINGS explanation', async () => {
  const h = createHarness();
  await h.say('How much can I make per day?');
  assert.ok(h.last().includes(t('earningsIntro')));
  await h.say('No');
  await h.say('Understood');
  assert.strictEqual(h.last(), t('socialUnderstood'));
});

test('C4. courtesy after the withdrawal guidance', async () => {
  const h = createHarness();
  await h.say('How do I withdraw my funds?');
  await h.say('Thanks');
  assert.strictEqual(h.last(), t('socialThanks'));
  assert.ok(!h.last().includes(t('withdrawHelpPrompt')), 'not the withdrawal question');
});

// ----------------------------------- 4. a new question always beats a courtesy ---

test('D1. a new question after an acknowledgement starts its own intent', async () => {
  const h = createHarness();
  await h.say('How do I withdraw my funds?');
  await h.say('Checked');
  await h.say('Ok');
  assert.strictEqual(h.last(), t('socialAck'));

  await h.say('How do I deposit?');
  assert.ok(h.last().includes(t('depositIntro')), 'the deposit flow starts');
  assert.strictEqual(h.context().pending, 'deposit.has_crypto');
});

test('D2. "ok so how do I deposit" is a question, not an acknowledgement', async () => {
  const h = createHarness();
  await h.say('How do I withdraw my funds?');
  await h.say('Checked');
  await h.say('ok so how do I deposit');
  assert.ok(h.last().includes(t('depositIntro')), h.last());
  assert.notStrictEqual(h.last(), t('socialAck'));
});

test('D3. words that merely CONTAIN a courtesy are not acknowledgements', async () => {
  const questions = [
    'Is Trust Wallet good?',
    'Is it good to withdraw now?',
    'How good is the bot?',
    'Is the referral program perfect?',
    'Great, but how long does a withdrawal take?'
  ];
  for (const question of questions) {
    const social = engine.classifySocial(question);
    assert.strictEqual(social, null, JSON.stringify(question) + ' must not be a courtesy');
    const h = createHarness();
    await h.say('How do I withdraw my funds?');
    await h.say('Checked');
    await h.say(question);
    assert.notStrictEqual(h.last(), t('socialAck'), JSON.stringify(question));
    assert.notStrictEqual(h.last(), t('socialPositive'), JSON.stringify(question));
  }
});

test('D4. a greeting is still a greeting, not a courtesy', async () => {
  const h = createHarness();
  await h.say('good morning');
  assert.ok(/Hi!/.test(h.last()), h.last());
  assert.notStrictEqual(h.last(), t('socialPositive'));
});

// ------------------------------------------- 5. legitimate pending still works ---

test('E1. inside a real step "ok" is still a confirmation', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  assert.strictEqual(h.context().pending, 'deposit.has_crypto');
  await h.say('Ok');
  assert.strictEqual(h.context().pending, 'deposit.transfer_done', 'the flow advances');
  assert.strictEqual(h.last(), t('depositHaveCrypto') + '\n\n' + t('depositAfterAck'));
});

test('E2. the tutorial workspace keeps working after a courtesy', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('No');
  await h.say('Paybis');
  assert.strictEqual(h.context().pending, 'deposit.tutorial_followup');
  await h.say('okay');
  assert.strictEqual(h.last(), t('depositAfterAck'));
  assert.strictEqual(h.context().pending, 'deposit.transfer_done');
  await h.say('done');
  assert.strictEqual(h.context().pending, 'deposit.credited', 'the deposit flow keeps advancing');
});

test('E3. the trust guide offer keeps accepting "yes" and "no"', async () => {
  const yes = createHarness();
  await yes.say('Is this genuine?');
  await yes.say('Yes');
  assert.ok(yes.last().includes(t('platformIntro')), 'the guide is delivered');

  const no = createHarness();
  await no.say('Is this genuine?');
  await no.say('No');
  assert.strictEqual(no.last(), t('anythingElse'));
});

test('E4. the partner offer keeps working', async () => {
  const h = createHarness();
  await h.say('Tell me about the partner programme');
  assert.strictEqual(h.context().pending, 'partner.interest');
  await h.say('Yes');
  assert.ok(h.last().includes(t('partnerHow')));
});

test('E5. a reported problem still reaches a human', async () => {
  const h = createHarness();
  await h.say('How do I withdraw my funds?');
  await h.say('I have a problem.');
  assert.strictEqual(h.last(), t('humanHandoff'));
  assert.match(h.lastAdmin(), /HUMAN (REQUESTED|NEEDED)/);
});

// --------------------------------------------------------- 6. localization ---

test('F1. English, Portuguese and Arabic each answer in their own language', async () => {
  for (const lang of ['en', 'pt', 'ar']) {
    const h = createHarness({ language: lang });
    await h.say('How do I withdraw my funds?');
    await h.say('Checked');
    await h.say('Ok');
    assert.strictEqual(h.last(), tIn(lang, 'socialAck'), lang + ': acknowledgement');
    await h.say('Thank you');
    assert.strictEqual(h.last(), tIn(lang, 'socialThanks'), lang + ': gratitude');
    if (lang !== 'en') {
      assert.notStrictEqual(h.last(), tIn('en', 'socialThanks'), lang + ': never English');
    }
  }
});

test('F2. Portuguese and Arabic acknowledgements are recognised', async () => {
  const pt = createHarness({ language: 'pt' });
  await pt.say('Como faço para sacar?');
  await pt.say('Ok');
  assert.strictEqual(pt.last(), tIn('pt', 'socialAck'));
  await pt.say('Obrigado');
  assert.strictEqual(pt.last(), tIn('pt', 'socialThanks'));

  const ar = createHarness({ language: 'ar' });
  await ar.say('كيف أسحب الأموال؟');
  await ar.say('تمام');
  assert.strictEqual(ar.last(), tIn('ar', 'socialAck'));
  await ar.say('شكرا');
  assert.strictEqual(ar.last(), tIn('ar', 'socialThanks'));
});

test('F3. the Arabic courtesy strings are Arabic script (RTL safe)', async () => {
  const keys = ['socialAck', 'socialUnderstood', 'socialPositive', 'socialGreat',
    'socialThanks', 'socialThanksBig', 'socialReciprocal', 'socialClosing'];
  for (const key of keys) {
    const value = i18n.CUSTOMER_STRINGS.ar[key];
    assert.ok(typeof value === 'string' && value.length > 0, key + ' is missing');
    assert.ok(SupportGuidelines.isArabicScript(value), key + ' is not Arabic: ' + value);
  }
});

// ------------------------------------------------------ 7. human handoff ---

test('G1. an active human takeover still silences the bot for a courtesy', async () => {
  const h = createHarness();
  await h.say('How do I withdraw my funds?');
  await h.adminSay('/reply 1 On it - please send the receipt.');
  const before = h.toCustomer().length;

  await h.say('Ok');
  assert.strictEqual(h.toCustomer().length, before, 'the bot must not talk over the human');

  await h.say('Thank you');
  assert.strictEqual(h.toCustomer().length, before, 'still silent');
  assert.match(h.lastAdmin(), /HUMAN CONVERSATION/);
});

test('G2. /close restores automation, which then answers a courtesy', async () => {
  const h = createHarness();
  await h.say('How do I withdraw my funds?');
  await h.adminSay('/reply 1 On it.');
  await h.adminSay('/close 1');

  const before = h.toCustomer().length;
  await h.say('Ok');
  assert.strictEqual(h.toCustomer().length, before + 1, 'the bot answers again');
  assert.strictEqual(h.last(), t('socialAck'));
});

// ------------------------------------- 8. duplicates and out-of-order updates ---

test('H1. a redelivered update is answered once', async () => {
  const h = createHarness();
  await h.say('How do I withdraw my funds?');
  await h.say('Checked');
  const updateId = nextUpdateId();
  await h.say('Ok', { updateId });
  const count = h.toCustomer().length;
  await h.say('Ok', { updateId });
  assert.strictEqual(h.toCustomer().length, count, 'no second reply');
});

test('H2. an out-of-order (older) update cannot rewind the state', async () => {
  const h = createHarness();
  await h.say('How do I withdraw my funds?');
  await h.say('Checked');
  const older = nextUpdateId();
  await h.say('Ok', { updateId: older });
  const count = h.toCustomer().length;
  await h.say('Good', { updateId: older - 1 });
  assert.strictEqual(h.toCustomer().length, count, 'a stale update is ignored');
  assert.strictEqual(h.context().pending, 'anything_else');
});

// ------------------------------------------------- 9. commands still work ---

test('I1. /tutorial, /progress, /next and /help still answer', async () => {
  const h = createHarness();
  await h.say('How do I withdraw my funds?');
  await h.say('Checked');

  await h.say('/tutorial');
  assert.ok(h.last().includes('https://t.me/ArbitrixAnnouncements/19'), 'the withdrawal tutorial');

  await h.say('/progress');
  assert.ok(h.last().includes(t('progressTitle')));

  await h.say('/next');
  assert.ok(h.last().includes(t('nextStepTitle')) || h.last().includes(t('nextTopics')));

  await h.say('/help');
  assert.ok(h.last().includes('Arbitrix Support'));
});

test('I2. a courtesy does not disturb an operator notice', async () => {
  const h = createHarness();
  await h.say('How do I withdraw my funds?');
  await h.say('Checked');
  const adminBefore = h.transport.sent.filter((m) => m.chatId === ADMIN).length;
  await h.say('Ok');
  const adminAfter = h.transport.sent.filter((m) => m.chatId === ADMIN).length;
  assert.strictEqual(adminAfter, adminBefore + 1, 'exactly one notice per message');
  assert.match(h.lastAdmin(), /BOT REPLIED/);
});

// ----------------------------------- 5b. the stored state matches what was sent ---

test('L1. a question the bot cannot answer records the fallback it actually sent', async () => {
  const h = createHarness();
  await h.say('anyone there?');
  assert.strictEqual(h.last(), t('clarifyTopic'), 'the fallback is sent once');
  assert.strictEqual(h.context().pending, 'clarify',
    'the stored context matches the message the customer received');

  await h.say('Thank you');
  assert.strictEqual(h.last(), t('socialThanks'));
  assert.ok(!h.last().includes(t('clarifyTopic')), 'the fallback is not replayed');
});

test('L2. a greeting after the fallback does not re-send it', async () => {
  const h = createHarness();
  await h.say('anyone there?');
  assert.strictEqual(h.last(), t('clarifyTopic'));
  await h.say('hello');
  assert.strictEqual(h.last(), t('greetingFresh'));
  assert.ok(!h.last().includes(t('clarifyTopic')), 'the fallback is not re-sent with the greeting');
});

// ----------------------------------------------------------- 10. classifier pins ---
test('J1. classifySocial is full-anchored and never guesses', () => {
  assert.deepStrictEqual(engine.classifySocial('Ok').flavor, engine.SOCIAL_FLAVORS.NEUTRAL);
  assert.deepStrictEqual(engine.classifySocial('Thank you').flavor, engine.SOCIAL_FLAVORS.THANKS);
  assert.deepStrictEqual(engine.classifySocial('Thanks a lot').flavor, engine.SOCIAL_FLAVORS.THANKS_BIG);
  assert.deepStrictEqual(engine.classifySocial('Good').flavor, engine.SOCIAL_FLAVORS.POSITIVE);
  assert.deepStrictEqual(engine.classifySocial('Great').flavor, engine.SOCIAL_FLAVORS.GREAT);
  assert.deepStrictEqual(engine.classifySocial('Understood').flavor, engine.SOCIAL_FLAVORS.UNDERSTOOD);
  assert.deepStrictEqual(engine.classifySocial("You're welcome").flavor, engine.SOCIAL_FLAVORS.RECIPROCAL);

  const notCourtesies = [
    '', '   ', 'yes', 'no', 'how do I deposit', 'Is Trust Wallet good?',
    'what is the minimum deposit', 'my withdrawal is still pending',
    'good morning', 'I have a problem', 'cancel my withdrawal',
    'ok so how do I withdraw'
  ];
  for (const text of notCourtesies) {
    assert.strictEqual(engine.classifySocial(text), null, JSON.stringify(text));
  }
});

test('J2. every social reply key exists in all three locales', () => {
  const keys = ['socialAck', 'socialUnderstood', 'socialPositive', 'socialGreat',
    'socialThanks', 'socialThanksBig', 'socialReciprocal', 'socialClosing'];
  for (const locale of ['en', 'pt', 'ar']) {
    for (const key of keys) {
      const value = i18n.CUSTOMER_STRINGS[locale][key];
      assert.ok(typeof value === 'string' && value.trim().length > 0, locale + '.' + key);
    }
  }
});

test('J3. a courtesy is answered without inventing facts or promising returns', () => {
  const keys = ['socialAck', 'socialUnderstood', 'socialPositive', 'socialGreat',
    'socialThanks', 'socialThanksBig', 'socialReciprocal', 'socialClosing'];
  for (const locale of ['en', 'pt', 'ar']) {
    for (const key of keys) {
      const value = i18n.CUSTOMER_STRINGS[locale][key];
      assert.ok(!/guarantee|guaranteed|lucro garantido|مضمون/i.test(value), locale + '.' + key);
      assert.ok(!/\$\d/.test(value), locale + '.' + key + ' quotes an amount');
      assert.ok(!/https?:\/\//.test(value), locale + '.' + key + ' carries a link');
    }
  }
});

test('J4. the courtesy path never touches money, statuses or the database schema', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../services/support/ConversationEngine'), 'utf8');
  const social = source.slice(source.indexOf('function socialReply('), source.indexOf('function emptyState('));
  assert.ok(social.length > 0);
  assert.ok(!/supabase|wallet|balance|record_trade|rpc\(|insert\(|update\(/i.test(social),
    'the social reply path performs no I/O');
});
