'use strict';

/**
 * Bot-response status on private-admin notifications.
 *
 * A notification must tell the operator, at a glance, what the bot ACTUALLY did:
 *
 *   BOT REPLIED        - an awaited, successful customer sendMessage carried a
 *                        CONFIDENT answer (approved KB text, or a model answer in
 *                        the customer's language).
 *   HUMAN NEEDED       - the customer was answered, but only with a fallback /
 *                        uncertain / handoff text, or the approved answer could not
 *                        be delivered (translation unavailable). An operator should
 *                        take over.
 *   HUMAN REQUESTED    - the customer explicitly asked for a human (/escalate).
 *   HUMAN CONVERSATION - the most recent reply in the thread came from a human
 *                        agent, so a colleague is already handling it.
 *
 * The status is derived from the reply pipeline's own result (the AI layer's
 * `needsHuman` flag) and the real Telegram send result - never from what the AI
 * merely attempted. A failed customer send must never be reported as "BOT REPLIED".
 *
 * The real bot, routing, notification builders and transport (fake fetch) are
 * exercised; the AI/translator are tiny stubs so every branch is deterministic,
 * and two integration tests use the REAL SupportAIService + knowledge base.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createTelegramSupportBot,
  createTelegramTransport,
  NOTIFICATION_STATUS,
  buildForwardText,
  buildEscalationNotice,
  CUSTOMER_GUIDE_TEXT,
  DIRECTION_AGENT
} = require('../services/TelegramSupportService');
const i18n = require('../services/telegram-i18n');
const { createSupportAIService, resolveSupportAIConfig } = require('../services/support/SupportAIService');

const TOKEN = '123456789:TEST-TOKEN-NOT-A-CREDENTIAL';
const ADMIN = '6054625818';
const CUSTOMER = '555111';
const CONVERSATION_ID = 42;

// What the knowledge base actually returns for the documented example.
const KB_ANSWER_EN = 'The minimum deposit is $100.';
const PT_ANSWER = 'O dep\u00f3sito m\u00ednimo \u00e9 $100.';
const AR_ANSWER = '\u0627\u0644\u062d\u062f \u0627\u0644\u0623\u062f\u0646\u0649 \u0644\u0644\u0625\u064a\u062f\u0627\u0639 \u0647\u0648 100 \u062f\u0648\u0644\u0627\u0631.';
const UNCERTAIN_EN = i18n.t('en', 'uncertain');
const UNCERTAIN_PT = i18n.t('pt', 'uncertain');

// --------------------------------------------------------------------- harness ---

function createFakeStore({ language = 'en' } = {}) {
  const state = { conversations: [], messages: [], escalations: [] };
  const conversation = {
    id: CONVERSATION_ID,
    telegram_chat_id: Number(CUSTOMER),
    telegram_user_id: Number(CUSTOMER),
    username: 'ana',
    display_name: 'Ana Customer',
    language
  };
  state.conversations.push(conversation);
  let messageSeq = 0;

  return {
    state,
    conversation,
    async getConversationByChatId(chatId) {
      return String(chatId) === String(conversation.telegram_chat_id) ? conversation : null;
    },
    async getConversationById(id) { return Number(id) === conversation.id ? conversation : null; },
    async upsertConversation() { return { conversation, created: false }; },
    async insertMessage({ conversationId, direction, body }) {
      const message = { id: ++messageSeq, conversation_id: conversationId, direction, body };
      state.messages.push(message);
      return { message };
    },
    async getLatestMessageByConversation({ conversationId, direction }) {
      return state.messages
        .filter((m) => m.conversation_id === conversationId && (!direction || m.direction === direction))
        .pop() || null;
    },
    async createEscalation({ conversationId, supportMessageId }) {
      const row = { id: state.escalations.length + 1, conversation_id: conversationId, support_message_id: supportMessageId };
      state.escalations.push(row);
      return row;
    },
    async setConversationStatus() { return true; },
    async probeColumns() { return true; }
  };
}

/** A programmable AI answerer: `ask` returns whatever the test dictates. */
function stubAI(outcomes) {
  return {
    isEnabled: () => true,
    async ask(question, options) {
      const lang = (options && options.language) || 'en';
      const value = typeof outcomes === 'function' ? outcomes(question, lang) : outcomes[lang];
      return value === undefined ? null : value;
    }
  };
}

function approvedAnswer(answer) {
  return { kind: 'answer', answer, needsHuman: false, modelGenerated: false, source: 'knowledge' };
}
function modelAnswer(answer) {
  return { kind: 'answer', answer, needsHuman: false, modelGenerated: true, source: 'provider' };
}

function createHarness({ language = 'en', ai = null, translator = null, failCustomerSend = false } = {}) {
  const calls = [];
  const lines = [];
  const store = createFakeStore({ language });
  const logger = { log() {}, warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) };

  let messageSeq = 900000;
  const fetchImpl = async (url, options) => {
    const method = String(url).split('/').pop();
    const payload = JSON.parse((options && options.body) || '{}');
    if (failCustomerSend && String(payload.chat_id) === CUSTOMER) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' })
      };
    }
    const messageId = ++messageSeq;
    calls.push({ method, chatId: String(payload.chat_id), text: payload.text, messageId });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: messageId } }) };
  };

  const transport = createTelegramTransport({ token: TOKEN, fetchImpl });
  const bot = createTelegramSupportBot({
    config: { token: TOKEN, adminIds: [ADMIN], webhookSecret: 'test-webhook-secret', baseUrl: 'https://arbitrix.pro' },
    store,
    transport,
    logger,
    supportAI: ai,
    translator
  });

  const adminCalls = () => calls.filter((c) => c.chatId === ADMIN);
  // Both notice kinds: a customer message ("New Customer Message") and an
  // escalation ("Escalation requested").
  const notifications = () => adminCalls().filter((c) => /New Customer Message|Escalation requested/.test(c.text));
  return {
    bot,
    store,
    lines,
    toCustomer: () => calls.filter((c) => c.chatId === CUSTOMER),
    adminText: () => adminCalls().map((c) => c.text).join('\n'),
    notificationText: () => notifications().map((c) => c.text).join('\n'),
    lastNotificationText: () => {
      const all = notifications();
      return all.length ? all[all.length - 1].text : '';
    },
    notificationCount: () => notifications().length,
    lastNotify: () => bot.status().lastNotify
  };
}

let updateSeq = 50000;
const nextUpdateId = () => ++updateSeq;

function customerMessage(text) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: 1,
      from: { id: Number(CUSTOMER), username: 'ana' },
      chat: { id: Number(CUSTOMER), type: 'private' },
      text
    }
  };
}

function adminMessage(text) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: 50,
      from: { id: Number(ADMIN), username: 'ops' },
      chat: { id: Number(ADMIN), type: 'private' },
      text
    }
  };
}

// ------------------------------------------------------------- builder (unit) ---

test('unit: every status renders its operator block, an unknown status renders none', () => {
  const base = { id: CONVERSATION_ID };
  const bot = buildForwardText(base, CUSTOMER, 'Ana', 'hi', { language: 'en', status: NOTIFICATION_STATUS.BOT_REPLIED, answer: KB_ANSWER_EN });
  assert.ok(bot.includes('\u{1F916} BOT REPLIED'));
  assert.ok(bot.includes('The customer has already received an automatic response.'));
  assert.ok(bot.includes('Customer answer:'));
  assert.ok(bot.includes(KB_ANSWER_EN));

  const needed = buildForwardText(base, CUSTOMER, 'Ana', 'hi', { language: 'en', status: NOTIFICATION_STATUS.HUMAN_NEEDED, answer: KB_ANSWER_EN });
  assert.ok(needed.includes('\u26a0\ufe0f HUMAN NEEDED'));
  assert.ok(needed.includes('The bot could not provide a confident answer.'));
  assert.ok(!needed.includes('Customer answer:'), 'a fallback never quotes an answer it did not deliver');
  assert.ok(!needed.includes(KB_ANSWER_EN));

  const requested = buildForwardText(base, CUSTOMER, 'Ana', 'hi', { language: 'en', status: NOTIFICATION_STATUS.HUMAN_REQUESTED });
  assert.ok(requested.includes('\u{1F468}\u200d\u{1F4BC} HUMAN REQUESTED'));
  assert.ok(requested.includes('Please respond to the customer.'));

  const conversation = buildForwardText(base, CUSTOMER, 'Ana', 'hi', { language: 'en', status: NOTIFICATION_STATUS.HUMAN_CONVERSATION });
  assert.ok(conversation.includes('\u{1F4AC} HUMAN CONVERSATION'));
  assert.ok(conversation.includes('A human is already handling this conversation.'));

  const none = buildForwardText(base, CUSTOMER, 'Ana', 'hi', { language: 'en' });
  assert.ok(!/BOT REPLIED|HUMAN NEEDED|HUMAN REQUESTED|HUMAN CONVERSATION/.test(none));
});

test('unit: the escalation notice defaults to HUMAN REQUESTED', () => {
  const notice = buildEscalationNotice({ id: CONVERSATION_ID }, { chatId: CUSTOMER }, 'please help', { language: 'en' });
  assert.ok(notice.includes('\u{1F468}\u200d\u{1F4BC} HUMAN REQUESTED'));
  assert.ok(notice.includes('Please respond to the customer.'));
  assert.ok(notice.includes('Escalation requested'));
});

test('unit: a long customer answer is bounded so the /reply hint survives', () => {
  const long = 'x'.repeat(2000);
  const text = buildForwardText({ id: 7 }, CUSTOMER, 'Ana', 'hi', { language: 'en', status: NOTIFICATION_STATUS.BOT_REPLIED, answer: long });
  assert.ok(text.includes('Customer answer:'));
  assert.ok(text.length < 1200, 'the quoted answer is bounded');
  assert.ok(text.includes('/reply 7 <message>'), 'the operator can still reply');
});

// ----------------------------------------------- automated bot reply -> status ---

test('English: a confident approved answer sends BOT REPLIED and quotes it', async () => {
  const h = createHarness({ language: 'en', ai: stubAI({ en: approvedAnswer(KB_ANSWER_EN) }) });
  const result = await h.bot.handleUpdate(customerMessage('What is the minimum deposit?'));

  assert.strictEqual(result.action, 'forwarded');
  assert.strictEqual(h.toCustomer()[0].text, KB_ANSWER_EN, 'the customer got the answer');
  const admin = h.notificationText();
  assert.ok(admin.includes('\u{1F916} BOT REPLIED'));
  assert.ok(admin.includes('Customer answer:'));
  assert.ok(admin.includes(KB_ANSWER_EN));
  assert.strictEqual(h.lastNotify().status, NOTIFICATION_STATUS.BOT_REPLIED);
});

test('Portuguese: a confident model answer sends BOT REPLIED in the customer language', async () => {
  const h = createHarness({ language: 'pt', ai: stubAI({ pt: modelAnswer(PT_ANSWER) }) });
  await h.bot.handleUpdate(customerMessage('Qual e o deposito minimo?'));

  assert.strictEqual(h.toCustomer()[0].text, PT_ANSWER, 'the customer got the Portuguese answer');
  assert.ok(h.notificationText().includes('\u{1F916} BOT REPLIED'));
  assert.ok(h.notificationText().includes(PT_ANSWER));
  assert.strictEqual(h.lastNotify().status, NOTIFICATION_STATUS.BOT_REPLIED);
});

test('Arabic: a confident model answer sends BOT REPLIED in Arabic', async () => {
  const h = createHarness({ language: 'ar', ai: stubAI({ ar: modelAnswer(AR_ANSWER) }) });
  await h.bot.handleUpdate(customerMessage('\u0645\u0627 \u0647\u0648 \u0627\u0644\u062d\u062f \u0627\u0644\u0623\u062f\u0646\u0649 \u0644\u0644\u0625\u064a\u062f\u0627\u0639\u061f'));

  assert.strictEqual(h.toCustomer()[0].text, AR_ANSWER);
  assert.ok(h.notificationText().includes('\u{1F916} BOT REPLIED'));
  assert.ok(h.notificationText().includes(AR_ANSWER));
  assert.strictEqual(h.lastNotify().status, NOTIFICATION_STATUS.BOT_REPLIED);
});

// --------------------------------------------- fallbacks / uncertain -> human ---

test('no-answer / uncertain outcome sends HUMAN NEEDED and never quotes an answer', async () => {
  const h = createHarness({
    language: 'en',
    ai: stubAI({ en: { kind: 'unknown', answer: UNCERTAIN_EN, needsHuman: true, modelGenerated: false, source: 'knowledge', reason: 'no-knowledge' } })
  });
  await h.bot.handleUpdate(customerMessage('Something I made up entirely'));

  assert.strictEqual(h.toCustomer()[0].text, UNCERTAIN_EN, 'the customer gets the safe uncertain text');
  const admin = h.notificationText();
  assert.ok(admin.includes('\u26a0\ufe0f HUMAN NEEDED'));
  assert.ok(!admin.includes('\u{1F916} BOT REPLIED'));
  assert.ok(!admin.includes('Customer answer:'));
  assert.strictEqual(h.lastNotify().status, NOTIFICATION_STATUS.HUMAN_NEEDED);
});

test('a localized fallback (translation unavailable) sends HUMAN NEEDED, not BOT REPLIED', async () => {
  const failingTranslator = {
    async fromEnglish() { return { ok: false, text: null, reason: 'unavailable' }; }
  };
  const h = createHarness({ language: 'pt', ai: stubAI({ pt: approvedAnswer(KB_ANSWER_EN) }), translator: failingTranslator });
  await h.bot.handleUpdate(customerMessage('Qual e o deposito minimo?'));

  assert.strictEqual(h.toCustomer()[0].text, UNCERTAIN_PT, 'the customer gets the localized safe fallback');
  const admin = h.notificationText();
  assert.ok(admin.includes('\u26a0\ufe0f HUMAN NEEDED'));
  assert.ok(!admin.includes(KB_ANSWER_EN), 'the approved English answer is never claimed as delivered');
  assert.strictEqual(h.lastNotify().status, NOTIFICATION_STATUS.HUMAN_NEEDED);
});

test('with no translator at all, a pt question with an approved answer is HUMAN NEEDED', async () => {
  const h = createHarness({ language: 'pt', ai: stubAI({ pt: approvedAnswer(KB_ANSWER_EN) }) });
  await h.bot.handleUpdate(customerMessage('Qual e o deposito minimo?'));

  assert.strictEqual(h.toCustomer()[0].text, UNCERTAIN_PT);
  assert.ok(h.notificationText().includes('\u26a0\ufe0f HUMAN NEEDED'));
  assert.strictEqual(h.lastNotify().status, NOTIFICATION_STATUS.HUMAN_NEEDED);
});

test('with AI off the standard acknowledgement is HUMAN NEEDED, not BOT REPLIED', async () => {
  const h = createHarness({ language: 'en' });
  await h.bot.handleUpdate(customerMessage('hello there'));

  assert.strictEqual(h.toCustomer()[0].text, CUSTOMER_GUIDE_TEXT);
  assert.ok(h.notificationText().includes('\u26a0\ufe0f HUMAN NEEDED'));
  assert.strictEqual(h.lastNotify().status, NOTIFICATION_STATUS.HUMAN_NEEDED);
});

// --------------------------------------------------- explicit /escalate -> human ---

test('an explicit /escalate sends HUMAN REQUESTED', async () => {
  const h = createHarness({ language: 'en' });
  const result = await h.bot.handleUpdate(customerMessage('/escalate'));

  assert.strictEqual(result.action, 'escalate');
  assert.strictEqual(h.notificationCount(), 1);
  const admin = h.notificationText();
  assert.ok(admin.includes('Escalation requested'));
  assert.ok(admin.includes('\u{1F468}\u200d\u{1F4BC} HUMAN REQUESTED'));
  assert.ok(admin.includes('Please respond to the customer.'));
  assert.strictEqual(h.lastNotify().status, NOTIFICATION_STATUS.HUMAN_REQUESTED);
});

test('a customer-authored escalation reason keeps HUMAN REQUESTED and shows the reason', async () => {
  const translator = {
    async toEnglish() { return { ok: true, text: 'I need to talk to a person.', reason: null }; },
    async fromEnglish() { return { ok: false, text: null, reason: 'unavailable' }; }
  };
  const h = createHarness({ language: 'pt', translator });
  const reason = 'Preciso falar com uma pessoa.';
  const result = await h.bot.handleUpdate(customerMessage('/escalate ' + reason));

  assert.strictEqual(result.action, 'escalate');
  const admin = h.notificationText();
  assert.ok(admin.includes('\u{1F468}\u200d\u{1F4BC} HUMAN REQUESTED'));
  assert.ok(admin.includes(reason), 'the customer words are preserved as the original');
  assert.ok(admin.includes('I need to talk to a person.'), 'the English translation is additive');
  assert.strictEqual(h.lastNotify().status, NOTIFICATION_STATUS.HUMAN_REQUESTED);
});

// ------------------------------------------------ human handling -> conversation ---

test('after an admin replies, the next customer message is HUMAN CONVERSATION', async () => {
  const h = createHarness({ language: 'en', ai: stubAI({ en: approvedAnswer(KB_ANSWER_EN) }) });

  // 1) first message: the bot answers confidently.
  await h.bot.handleUpdate(customerMessage('What is the minimum deposit?'));
  assert.ok(h.notificationText().includes('\u{1F916} BOT REPLIED'));

  // 2) a human replies.
  const reply = await h.bot.handleUpdate(adminMessage(`/reply ${CONVERSATION_ID} We are on it.`));
  assert.strictEqual(reply.action, 'reply');
  assert.strictEqual(h.store.state.messages.filter((m) => m.direction === DIRECTION_AGENT).length, 1);

  // 3) the customer writes again: a human is already handling it.
  await h.bot.handleUpdate(customerMessage('Any update?'));
  const last = h.lastNotificationText();
  assert.ok(last.includes('\u{1F4AC} HUMAN CONVERSATION'), 'the newest notice says a human is handling it');
  assert.ok(!last.includes('\u{1F916} BOT REPLIED'), 'the newest notice does not claim the bot is the handler');
  assert.ok(!last.includes('\u26a0\ufe0f HUMAN NEEDED'));
  assert.strictEqual(h.lastNotify().status, NOTIFICATION_STATUS.HUMAN_CONVERSATION);
});

test('the bot still answers the customer while a human is handling (behaviour unchanged)', async () => {
  const h = createHarness({ language: 'en', ai: stubAI({ en: approvedAnswer(KB_ANSWER_EN) }) });
  await h.bot.handleUpdate(customerMessage('first'));
  await h.bot.handleUpdate(adminMessage(`/reply ${CONVERSATION_ID} on it`));
  await h.bot.handleUpdate(customerMessage('second'));

  // The customer chat also received the human reply, so count the BOT answers.
  const botAnswers = h.toCustomer().filter((c) => c.text === KB_ANSWER_EN);
  assert.strictEqual(botAnswers.length, 2, 'the customer reply path is untouched');
});

// ------------------------------------------------------ Telegram send failure ---

test('a failed customer send never produces a BOT REPLIED notification', async () => {
  const h = createHarness({ language: 'en', ai: stubAI({ en: approvedAnswer(KB_ANSWER_EN) }), failCustomerSend: true });

  await assert.rejects(h.bot.handleUpdate(customerMessage('What is the minimum deposit?')));

  assert.strictEqual(h.notificationCount(), 0, 'no notification exists to claim a reply');
  assert.notStrictEqual(h.lastNotify() && h.lastNotify().status, NOTIFICATION_STATUS.BOT_REPLIED);
});

// ------------------------------------------------- security / integrity guards ---

test('the notification status block carries no token and no chat-id secret', async () => {
  const h = createHarness({ language: 'en', ai: stubAI({ en: approvedAnswer(KB_ANSWER_EN) }) });
  await h.bot.handleUpdate(customerMessage('What is the minimum deposit?'));
  assert.ok(!h.adminText().includes(TOKEN));
  assert.ok(!JSON.stringify(h.lastNotify()).includes(TOKEN));
});

test('one customer message produces exactly one admin notification (no second system)', async () => {
  const h = createHarness({ language: 'en', ai: stubAI({ en: approvedAnswer(KB_ANSWER_EN) }) });
  await h.bot.handleUpdate(customerMessage('What is the minimum deposit?'));
  assert.strictEqual(h.notificationCount(), 1);
});

// ------------------------------------- integration: the REAL AI + knowledge base ---

test('integration: the real knowledge base yields BOT REPLIED for an approved answer', async () => {
  const ai = createSupportAIService({ config: resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true' }) });
  const h = createHarness({ language: 'en', ai });
  await h.bot.handleUpdate(customerMessage('What is the minimum deposit?'));

  assert.ok(h.notificationText().includes('\u{1F916} BOT REPLIED'));
  assert.strictEqual(h.lastNotify().status, NOTIFICATION_STATUS.BOT_REPLIED);
  assert.ok(h.toCustomer()[0].text.includes('minimum deposit'));
});

test('integration: the real knowledge base yields HUMAN NEEDED when the entry asks for a human', async () => {
  const ai = createSupportAIService({ config: resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true' }) });
  const h = createHarness({ language: 'en', ai });
  await h.bot.handleUpdate(customerMessage('How long do withdrawals take?'));

  assert.ok(h.notificationText().includes('\u26a0\ufe0f HUMAN NEEDED'));
  assert.strictEqual(h.lastNotify().status, NOTIFICATION_STATUS.HUMAN_NEEDED);
});

test('integration: pt/ar approved answers are translated, then reported BOT REPLIED', async () => {
  const translator = {
    async toEnglish() { return { ok: true, text: 'What is the minimum deposit?', reason: null }; },
    async fromEnglish(text, lang) {
      return { ok: true, text: lang === 'ar' ? AR_ANSWER : PT_ANSWER, reason: null };
    }
  };
  // The SAME translator is wired into the AI layer (so retrieval/classification
  // see the English wording) and into the bot (so the approved answer is localized).
  const ai = createSupportAIService({ config: resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true' }), translator });

  const pt = createHarness({ language: 'pt', ai, translator });
  await pt.bot.handleUpdate(customerMessage('Qual e o deposito minimo?'));
  assert.strictEqual(pt.toCustomer()[0].text, PT_ANSWER);
  assert.strictEqual(pt.lastNotify().status, NOTIFICATION_STATUS.BOT_REPLIED);

  const ar = createHarness({ language: 'ar', ai, translator });
  await ar.bot.handleUpdate(customerMessage('\u0645\u0627 \u0647\u0648 \u0627\u0644\u062d\u062f \u0627\u0644\u0623\u062f\u0646\u0649 \u0644\u0644\u0625\u064a\u062f\u0627\u0639\u061f'));
  assert.strictEqual(ar.toCustomer()[0].text, AR_ANSWER);
  assert.strictEqual(ar.lastNotify().status, NOTIFICATION_STATUS.BOT_REPLIED);
});
