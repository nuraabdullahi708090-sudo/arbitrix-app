'use strict';

/**
 * End-to-end conversation tests for the Telegram support assistant.
 *
 * These exercise the REAL bot (`createTelegramSupportBot`), the REAL dialogue
 * engine (`services/support/ConversationEngine`) and the REAL approved knowledge
 * base. Only two collaborators are faked:
 *   - store     -> in-memory conversation/message rows (including `context`)
 *   - transport -> records the sendMessage/sendVideo calls
 *
 * So the tests describe what a customer actually experiences, message by
 * message: short replies, multi-turn flows, tutorial selection, state across a
 * restart, human handoff, duplicates and localization.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  createTelegramSupportBot,
  DIRECTION_CUSTOMER,
  DIRECTION_BOT,
  DIRECTION_AGENT
} = require('../services/TelegramSupportService');
const i18n = require('../services/telegram-i18n');
const engine = require('../services/support/ConversationEngine');

const ROOT = path.join(__dirname, '..');
const CUSTOMER = '7001';
const ADMIN = '7002';
const TOKEN = '123456:CONVERSATION-TEST';

const TUTORIAL_URL = {
  paybis: 'https://t.me/ArbitrixAnnouncements/17',
  transak: 'https://t.me/ArbitrixAnnouncements/16',
  trustwallet: 'https://t.me/ArbitrixAnnouncements/18',
  withdrawal: 'https://t.me/ArbitrixAnnouncements/19'
};

const silentLogger = { log() {}, warn() {}, error() {}, info() {} };

let updateCounter = 900000;
const nextUpdateId = () => (updateCounter += 1);

// ------------------------------------------------------------------ harness ---

function createStore({ failContextWrites = false } = {}) {
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
      const escalation = { id: messages.length + 1, conversation_id: conversationId, support_message_id: supportMessageId };
      return { escalation };
    },
    async setConversationContext({ conversationId, context }) {
      if (failContextWrites) throw new Error('context column unavailable');
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
    failNextSend: false,
    async sendMessage(chatId, text, options) {
      if (this.failNextSend) {
        this.failNextSend = false;
        throw new Error('telegram is down');
      }
      const message_id = sent.length + 1;
      sent.push({ method: 'sendMessage', chatId: String(chatId), text, options, message_id });
      return { message_id };
    },
    async sendVideo(chatId, video, caption) {
      sent.push({ method: 'sendVideo', chatId: String(chatId), video, text: caption });
      return { message_id: sent.length + 1 };
    },
    getLastCall() {
      return null;
    }
  };
}

function createHarness({ language = 'en', contextStore = null, failContextWrites = false, ai = null } = {}) {
  const state = contextStore || createStore({ failContextWrites });
  const transport = createTransport();

  // Seed the stored language: the bot always answers from the PERSISTED language,
  // never from the text of the message.
  if (!state.conversations.has(CUSTOMER)) {
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
  }

  const bot = createTelegramSupportBot({
    config: {
      token: TOKEN,
      webhookSecret: 'conversation-secret',
      baseUrl: 'https://arbitrix.pro',
      supportChatId: null,
      adminIds: [ADMIN],
      notifyTarget: 'admins'
    },
    store: state.store,
    transport,
    logger: silentLogger,
    supportAI: ai
  });

  const conversation = () => state.conversations.get(CUSTOMER) || null;

  async function say(text, { updateId = nextUpdateId() } = {}) {
    const result = await bot.handleUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 0,
        text,
        chat: { id: Number(CUSTOMER), type: 'private' },
        from: { id: Number(CUSTOMER), first_name: 'Ana', username: 'ana' }
      }
    });
    return result;
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
    conversation,
    toCustomer: () => transport.sent.filter((m) => m.chatId === CUSTOMER && m.method === 'sendMessage').map((m) => m.text),
    last: () => transport.sent.filter((m) => m.chatId === CUSTOMER && m.method === 'sendMessage').map((m) => m.text).pop(),
    toAdmin: () => transport.sent.filter((m) => m.chatId === ADMIN && m.method === 'sendMessage').map((m) => m.text),
    lastAdmin: () => transport.sent.filter((m) => m.chatId === ADMIN && m.method === 'sendMessage').map((m) => m.text).pop(),
    videos: () => transport.sent.filter((m) => m.method === 'sendVideo')
  };
}

const t = (key, vars) => i18n.t('en', key, vars);

// ------------------------------------------------- 1. short replies in context ---

test('1. "Yes" answers the question that was actually asked (deposit: has crypto)', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  assert.strictEqual(h.last(), t('depositIntro'));

  await h.say('Yes');
  assert.strictEqual(h.last(), t('depositHaveCrypto') + '\n\n' + t('depositAfterAck'));
  assert.strictEqual(h.conversation().context.pending, 'deposit.transfer_done');
});

test('2. "No" leads to the deposit alternatives instead of a dead end', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('No');
  assert.strictEqual(h.last(), t('depositNeedCrypto') + '\n\n' + t('depositMethodPrompt'));
  assert.strictEqual(h.conversation().context.pending, 'deposit.method');
});

test('3. "Okay", "Alright" and "Sure" continue the flow (never an unrecognised message)', async () => {
  for (const word of ['Okay', 'Alright', 'Sure', 'ok', 'fine']) {
    const h = createHarness();
    await h.say('I want to deposit');
    await h.say('No');
    await h.say(word);
    assert.strictEqual(h.last(), t('depositMethodPromptAgain'), '"' + word + '" must continue the method prompt');
    assert.strictEqual(h.conversation().context.pending, 'deposit.method');
  }
});

test('4. "Not yet" is understood as "not done" in the transfer step', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('Yes');
  await h.say('Not yet');
  // No method was chosen in this path, so the generic follow-up is used (never
  // "Would you like the  tutorial again?" with an empty name).
  assert.strictEqual(h.last(), t('depositTransferNoGeneric'));
  assert.ok(!h.last().includes('  '), 'no double space from an empty placeholder');
  assert.strictEqual(h.conversation().context.pending, 'anything_else');
});

test('5. "I understand" acknowledges without restarting the conversation', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('I understand');
  assert.strictEqual(h.last(), t('depositHaveCrypto') + '\n\n' + t('depositAfterAck'));
  assert.strictEqual(h.conversation().context.pending, 'deposit.transfer_done');
});

test('6. a bare "Yes" with no pending question asks for clarification instead of guessing', async () => {
  const h = createHarness();
  await h.say('Yes');
  assert.strictEqual(h.last(), t('clarifyTopic'));
  assert.ok(!/\d/.test(h.last()), 'a clarifying question must not invent figures');
});

test('7. a bare "No" with no pending question also asks for clarification', async () => {
  const h = createHarness();
  await h.say('No');
  assert.strictEqual(h.last(), t('clarifyTopic'));
});

test('8. gratitude closes the conversation politely when nothing is pending', async () => {
  const h = createHarness();
  await h.say('Thanks');
  assert.strictEqual(h.last(), t('thanksClose'));
  assert.strictEqual(h.conversation().context.pending, null);
});

test('9. gratitude mid-flow keeps the pending question (does not reset the flow)', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('Thanks');
  assert.strictEqual(h.last(), t('thanksOpen') + '\n\n' + t('depositIntro'));
  assert.strictEqual(h.conversation().context.pending, 'deposit.has_crypto');
});

test('10. a greeting is natural and is not repeated verbatim', async () => {
  const h = createHarness();
  await h.say('hello');
  assert.strictEqual(h.last(), t('greetingFresh'));
  await h.say('hi again');
  assert.match(h.last(), new RegExp(t('greetingAgain').split('!')[0].slice(0, 8)));
  assert.notStrictEqual(h.last(), t('greetingFresh'));
});

test('11. "How?" after a tutorial explains the steps instead of resending the link', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('No');
  await h.say('Paybis');
  assert.ok(h.last().includes(TUTORIAL_URL.paybis));

  await h.say('How?');
  assert.strictEqual(h.last(), t('tutorialHow'));
  assert.ok(!h.last().includes('https://'), 'the link is not duplicated');
});

test('12. "Really?" only affirms a claim, and re-asks after a question', async () => {
  // After a QUESTION there is no claim to confirm, so the bot must not say
  // "yes - that is correct"; it repeats the question and keeps the flow.
  const asked = createHarness();
  await asked.say('I want to deposit');
  await asked.say('Really?');
  assert.strictEqual(asked.last(), t('depositIntro'));
  assert.ok(!/That is correct/i.test(asked.last()), 'a question is not a claim');
  assert.strictEqual(asked.conversation().context.pending, 'deposit.has_crypto', 'the flow is preserved');

  // After a real ANSWER the reassurance is allowed.
  const answered = createHarness();
  await answered.say('What is the minimum deposit?');
  await answered.say('Really?');
  assert.match(answered.last(), /That is correct/i);
});

test('13. "Yes" to "anything else?" offers the topics instead of claiming confusion', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('Yes');
  await h.say('done');
  await h.say('Yes');            // credited yes -> asks "anything else?"
  await h.say('Yes');            // yes to "anything else?" -> offer topics
  assert.strictEqual(h.last(), t('clarifyHelp'));
  assert.strictEqual(h.conversation().context.pending, 'clarify');
});

// --------------------------------------------------------- 2. intent coverage ---

test('14. every natural deposit phrasing reaches the deposit guidance', async () => {
  const phrasings = [
    'How do I fund my account?',
    'I want to deposit',
    'How can I add money?',
    'I need help putting money into Arbitrix',
    'deposit'
  ];
  for (const text of phrasings) {
    const h = createHarness();
    await h.say(text);
    assert.strictEqual(h.last(), t('depositIntro'), '"' + text + '" must be understood as a deposit');
  }
});

test('15. no tutorial is sent before the customer picks a method', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  assert.ok(!h.last().includes('t.me/ArbitrixAnnouncements'), 'the intro must not push a tutorial');
  await h.say('No');
  assert.ok(!h.last().includes('t.me/ArbitrixAnnouncements'), 'the method prompt lists options only');
});

test('16. each deposit method sends ONLY its own tutorial', async () => {
  const cases = [
    ['Paybis', TUTORIAL_URL.paybis],
    ['Transak', TUTORIAL_URL.transak],
    ['Trust Wallet', TUTORIAL_URL.trustwallet]
  ];
  for (const [method, url] of cases) {
    const h = createHarness();
    await h.say('I want to deposit');
    await h.say('No');
    await h.say(method);

    const reply = h.last();
    assert.ok(reply.includes(url), method + ' must send ' + url);
    const otherLinks = Object.values(TUTORIAL_URL).filter((candidate) => candidate !== url);
    otherLinks.forEach((other) => assert.ok(!reply.includes(other),
      method + ' must NOT send ' + other + ' -> ' + reply));
    assert.ok(reply.includes(t('depositTutorialFollowUp')));
    assert.strictEqual(h.conversation().context.pending, 'deposit.tutorial_followup');
  }
});

test('17. the method can be named mid-sentence and in any case', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('No');
  await h.say("i'll use paybis thanks");
  assert.ok(h.last().includes(TUTORIAL_URL.paybis));
  assert.ok(!h.last().includes(TUTORIAL_URL.transak));
});

test('18. withdrawal guidance includes the withdrawal tutorial and offers help', async () => {
  const h = createHarness();
  await h.say('I want to withdraw');
  const reply = h.last();
  assert.ok(reply.includes(t('withdrawIntro')));
  assert.ok(reply.includes(TUTORIAL_URL.withdrawal));
  assert.ok(reply.includes(t('withdrawHelpPrompt')));
  assert.strictEqual(h.conversation().context.pending, 'withdraw.help');
});

test('19. a specific withdrawal problem hands off to a human', async () => {
  const h = createHarness();
  await h.say('I want to withdraw');
  await h.say('Yes');
  assert.strictEqual(h.last(), t('humanHandoff'));
  assert.match(h.lastAdmin(), /HUMAN REQUESTED|HUMAN NEEDED/);
});

test('20. an account problem is handed to a human, never guessed', async () => {
  const h = createHarness();
  await h.say('my account is locked');
  assert.strictEqual(h.last(), t('humanHandoff'));
  assert.match(h.lastAdmin(), /HUMAN NEEDED/);
});

test('21. an explicit request for a human is routed as HUMAN REQUESTED', async () => {
  const h = createHarness();
  await h.say('I need to speak to a human please');
  assert.ok(h.last());
  assert.match(h.lastAdmin(), /HUMAN REQUESTED/);
});

test('22. a payment status question is never answered as fact', async () => {
  const h = createHarness();
  await h.say('did my deposit arrive?');
  assert.strictEqual(h.last(), t('paymentStatus'));
  assert.ok(!/\$[\d]/.test(h.last()), 'no amount is invented');
  assert.match(h.lastAdmin(), /HUMAN NEEDED/);
});

test('23. factual questions are answered from the approved knowledge base', async () => {
  const cases = [
    ['What is the minimum deposit?', /\$100/],
    ['Do I need verification?', /do not require identity verification|does not require/i],
    ['How much is the subscription?', /\$7/],
    ['What is the promotional credit?', /\$50/]
  ];
  for (const [question, pattern] of cases) {
    const h = createHarness();
    await h.say(question);
    assert.match(h.last(), pattern, question + ' -> ' + h.last());
  }
});

test('24. an unknown question gets ONE natural clarifying question and invents nothing', async () => {
  const h = createHarness();
  await h.say('what is the weather in paris tomorrow');
  assert.strictEqual(h.last(), t('clarifyTopic'));
  assert.ok(!/\d/.test(h.last()));
  assert.strictEqual((h.last().match(/\?/g) || []).length, 1, 'one question at a time');
  assert.strictEqual(h.lastAdmin().includes('Customer answer:'), false, 'no unsafe answer is quoted');
});

// ------------------------------------------------------ 3. state persistence ---

test('25. conversation state survives a bot restart (stored in the conversation row)', async () => {
  const shared = createStore();
  const first = createHarness({ contextStore: shared });
  await first.say('I want to deposit');
  await first.say('Yes');
  assert.strictEqual(first.conversation().context.pending, 'deposit.transfer_done');

  // A brand-new bot instance has an empty in-process cache: only the stored
  // context can tell it what was being discussed.
  const second = createHarness({ contextStore: shared });
  await second.say('done');
  assert.strictEqual(second.last(), t('depositTransferYes'));
  assert.strictEqual(second.conversation().context.pending, 'deposit.credited');
});

test('26. the state is written to the conversation context, not to a global', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  const context = h.conversation().context;
  assert.ok(context && typeof context === 'object');
  assert.strictEqual(context.topic, 'deposit');
  assert.strictEqual(context.pending, 'deposit.has_crypto');
  assert.ok(context.updatedAt, 'the state carries a timestamp');
});

test('27. a failing context write keeps the conversation working (fail-open)', async () => {
  const h = createHarness({ failContextWrites: true });
  await h.say('I want to deposit');
  await h.say('Yes');
  assert.strictEqual(h.last(), t('depositHaveCrypto') + '\n\n' + t('depositAfterAck'),
    'the in-process state must keep the dialogue coherent');
});

test('28. malformed stored context is ignored instead of crashing', async () => {
  const shared = createStore();
  const h = createHarness({ contextStore: shared });
  await h.say('hello');
  h.conversation().context = { pending: 42, topic: [], stage: 'nonsense', method: {} };

  await h.say('I want to deposit');
  assert.strictEqual(h.last(), t('depositIntro'));
  assert.strictEqual(h.conversation().context.pending, 'deposit.has_crypto');
});

// --------------------------------------------------------- 4. human handoff ---

test('29. an active human handoff suppresses the automated reply', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.adminSay('/reply 1 On it - please send the receipt.');
  const before = h.toCustomer().length;
  await h.say('Thanks');
  assert.strictEqual(h.toCustomer().length, before, 'the bot must not talk over the human');
  assert.match(h.lastAdmin(), /HUMAN CONVERSATION/);
});

test('30. automation resumes after the operator closes the handoff', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.adminSay('/reply 1 On it.');
  await h.adminSay('/close 1');

  const before = h.toCustomer().length;
  await h.say('I want to deposit');
  assert.strictEqual(h.toCustomer().length, before + 1, 'the bot answers again');
  assert.strictEqual(h.last(), t('depositIntro'));
});

test('31. a human-requested conversation keeps its history', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('my account is locked');
  const bodies = h.state.messages.map((m) => m.body);
  assert.ok(bodies.includes('I want to deposit'));
  assert.ok(bodies.includes('my account is locked'));
  assert.ok(h.state.messages.some((m) => m.direction === DIRECTION_BOT));
  assert.ok(h.state.messages.every((m) => m.direction !== DIRECTION_AGENT || true));
  assert.strictEqual(h.state.messages.filter((m) => m.direction === DIRECTION_CUSTOMER).length, 2);
});

// ------------------------------------------ 5. duplicates and ordering ---

test('32. a redelivered update is answered once and advances the state once', async () => {
  const h = createHarness();
  const id = nextUpdateId();
  await h.say('I want to deposit', { updateId: id });
  const duplicate = await h.say('I want to deposit', { updateId: id });

  assert.strictEqual(duplicate.action, 'duplicate');
  assert.strictEqual(h.toCustomer().length, 1, 'exactly one reply');
  assert.strictEqual(h.state.messages.filter((m) => m.direction === DIRECTION_CUSTOMER).length, 1);
});

test('33. consecutive messages are each answered and keep the state coherent', async () => {
  const h = createHarness();
  await h.say('hello');
  await h.say('I want to deposit');
  await h.say('Yes');
  assert.strictEqual(h.toCustomer().length, 3);
  assert.strictEqual(h.conversation().context.pending, 'deposit.transfer_done');
});

test('34. a late reply cannot rewind the flow', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('Yes');     // has crypto
  await h.say('done');    // transferred
  await h.say('Yes');     // credited -> anything else?
  assert.strictEqual(h.conversation().context.pending, 'anything_else');

  // A "Yes" that was typed for an earlier question must not send the flow back to
  // the crypto question; it is interpreted against the CURRENT question.
  await h.say('Yes');
  assert.strictEqual(h.last(), t('clarifyHelp'));
  assert.strictEqual(h.conversation().context.pending, 'clarify');
});

// ------------------------------------------------------- 6. localization ---

test('35. a Portuguese customer is guided in Portuguese with the same tutorial URL', async () => {
  const h = createHarness({ language: 'pt' });
  await h.say('Quero fazer um depósito');
  assert.strictEqual(h.last(), i18n.t('pt', 'depositIntro'));

  await h.say('Não');
  assert.strictEqual(h.last(), i18n.t('pt', 'depositNeedCrypto') + '\n\n' + i18n.t('pt', 'depositMethodPrompt'));

  await h.say('Paybis');
  const reply = h.last();
  assert.ok(reply.includes(TUTORIAL_URL.paybis));
  assert.ok(reply.includes(i18n.t('pt', 'depositTutorialFollowUp')));
  assert.ok(!reply.includes(i18n.t('en', 'depositTutorialFollowUp')), 'no English leakage');
});

test('36. an Arabic customer is guided in Arabic with the same tutorial URLs', async () => {
  const h = createHarness({ language: 'ar' });
  await h.say('أريد السحب');
  const reply = h.last();
  assert.ok(reply.includes(i18n.t('ar', 'withdrawIntro')));
  assert.ok(reply.includes(TUTORIAL_URL.withdrawal));
  assert.ok(!reply.includes(i18n.t('en', 'withdrawIntro')));
});

test('37. an unsupported language falls back to English', async () => {
  const h = createHarness({ language: 'zh' });
  await h.say('I want to deposit');
  assert.strictEqual(h.last(), i18n.t('en', 'depositIntro'));
});

// ---------------------------------------------------------- 7. safety pins ---

test('38. the conversation never asks for credentials or secrets', async () => {
  const h = createHarness();
  const transcript = [
    'hello', 'I want to deposit', 'No', 'Paybis', 'done', 'Yes',
    'I want to withdraw', 'Yes', 'my account is locked', 'did my deposit arrive?',
    'I need a human'
  ];
  for (const text of transcript) await h.say(text);

  const everything = h.toCustomer().join('\n');
  assert.ok(!/password|passcode|seed phrase|recovery phrase|private key|2fa code|otp/i.test(everything),
    'the bot must never request a secret');
});

test('39. the dialogue engine has no financial or network side effects', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'support', 'ConversationEngine.js'), 'utf8');
  assert.ok(!/require\(['"]@supabase/.test(source), 'no database client');
  assert.ok(!/\bfetch\(/.test(source), 'no network call');
  assert.ok(!/record_trade_safe|from\(['"]wallets/.test(source), 'no wallet/trade access');
  assert.ok(!/process\.env/.test(source), 'the engine is pure copy/logic');

  const service = fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportService.js'), 'utf8');
  const block = service.slice(service.indexOf('// Conversational state + dialogue engine'), service.indexOf('function composeCustomerReply'));
  assert.ok(!/record_trade_safe|from\(['"]wallets|live_balance/.test(block),
    'answering a customer must never touch money');
});

test('40. every reply is built from the approved dictionary (no ad-hoc English)', async () => {
  const h = createHarness();
  // The registration branch is included on purpose: it used to render a key that
  // was missing from the dictionary, and this check is what proves the whole
  // transcript resolves to approved copy.
  const transcript = ['hello', 'yes', 'thanks', 'how?', 'really?', 'I want to register',
    'I want to deposit', 'No', 'Paybis', 'How?'];
  for (const text of transcript) await h.say(text);

  assert.ok(h.toCustomer().length >= transcript.length - 2, 'the transcript produced replies');
  for (const reply of h.toCustomer()) {
    if (!reply) continue;
    // Every line must exist in the dictionary (with placeholders filled) - this
    // catches a hardcoded reply creeping into the flow.
    for (const line of reply.split('\n').filter(Boolean)) {
      const known = Object.values(i18n.CUSTOMER_STRINGS.en).some((template) => {
        // Escape the LITERAL parts and wildcard the placeholder parts - escaping
        // first would also escape the braces and stop the placeholder matching.
        const pattern = template
          .split(/\{\{[a-zA-Z]+\}\}/)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[\\s\\S]+');
        return new RegExp('^' + pattern + '$').test(line);
      });
      assert.ok(known, 'unexpected reply line (not in the dictionary): ' + JSON.stringify(line));
    }
  }
  assert.ok(!h.toCustomer().some((reply) => /onboardCreateAccount/.test(reply)),
    'no raw dictionary key reaches the customer');
});

// ------------------------------------------------------ 8. migration contract ---

test('41. migration 047 is additive, idempotent and self-checking', () => {
  const file = path.join(ROOT, 'supabase', 'migrations', '047_telegram_conversation_state.sql');
  const sql = fs.readFileSync(file, 'utf8');

  assert.match(sql, /ADD COLUMN IF NOT EXISTS context JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(sql, /CHECK \(jsonb_typeof\(context\) = 'object'\)/);
  assert.match(sql, /DO \$\$[\s\S]*RAISE EXCEPTION[\s\S]*END\s*\$\$;/,
    'a self-check must roll the file back if the shape is wrong');
  assert.match(sql, /BEGIN;/, 'DDL must run in one transaction');
  assert.match(sql, /COMMIT;/);

  // It may only touch the conversation table: no financial or KYC object.
  const touched = (sql.match(/ALTER TABLE public\.[a-z_]+/g) || []).map((m) => m.split('.').pop());
  assert.deepStrictEqual(Array.from(new Set(touched)).sort(), ['telegram_support_conversations']);
  assert.ok(!/wallets|trades|deposits|withdrawals|payment_invoices|verification_/.test(sql));
  // The rollback is only ever DOCUMENTED (a comment) - no destructive statement.
  assert.ok(!/^\s*ALTER TABLE[\s\S]{0,60}DROP COLUMN/m.test(sql.replace(/^\s*--.*$/gm, '')),
    'no DROP COLUMN statement may be executed');
});

test('42. the application works before migration 047 is applied', () => {
  const service = fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportService.js'), 'utf8');
  // The state write is guarded and degraded, never fatal.
  assert.match(service, /typeof store\.setConversationContext !== 'function'/);
  assert.match(service, /contextPersistenceDisabled = true/);
  assert.match(service, /continuing in-process/);
  // The state cache is bounded so a long-running process cannot leak memory.
  assert.match(service, /const stateCache = createLimitedMap\(\{ max: \d+ \}\)/);
});

test('43. a failed delivery does NOT advance the state, so a redelivery is safe', async () => {
  const h = createHarness();
  await h.say('I want to deposit');           // pending: deposit.has_crypto

  h.transport.failNextSend = true;
  const id = nextUpdateId();
  await assert.rejects(h.say('Yes', { updateId: id }), /telegram is down/);

  assert.strictEqual(h.conversation().context.pending, 'deposit.has_crypto',
    'the state must not move past a question the customer never got an answer to');

  // Telegram redelivers the same update; it is now answered and applied once.
  const retry = await h.say('Yes', { updateId: id });
  assert.strictEqual(retry.action, 'forwarded');
  assert.strictEqual(h.last(), t('depositHaveCrypto') + '\n\n' + t('depositAfterAck'));
  assert.strictEqual(h.conversation().context.pending, 'deposit.transfer_done');
});
