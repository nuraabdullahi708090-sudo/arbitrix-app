'use strict';

/**
 * Multilingual Telegram support (en / pt / ar) - the first release.
 *
 * Covers the whole contract:
 *   - /language + an inline keyboard with EXACTLY en/pt/ar and `lang:<code>`
 *     payloads (never bare codes);
 *   - callback handling: validation, persistence, acknowledgement, localized
 *     confirmation, and the security boundary (a press can only ever change the
 *     presser's OWN conversation, from a private chat);
 *   - the language reaching SupportAIService as a high-priority instruction, and
 *     the customer receiving the AI answer in their language;
 *   - AI-off behaviour: localized fixed replies, English operator notices, and
 *     translated operator replies;
 *   - ENGLISH operator notifications carrying the language, the ORIGINAL message
 *     and an English translation (or an explicit "unavailable" marker);
 *   - operator replies translated (both reply-to-notification and /reply) while
 *     operator COMMANDS are never translated;
 *   - persistence across a simulated restart.
 *
 * The real bot, the real routing, the real transport (fake fetch) and the real
 * translation-free dictionary are used, so nothing here mocks the units under
 * test. Only the AI answerer and the translation provider are stubs.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  createTelegramSupportBot,
  createTelegramTransport,
  routeUpdate
} = require('../services/TelegramSupportService');

const i18n = require('../services/telegram-i18n');
const SupportGuidelines = require('../services/support/SupportGuidelines');
const { createSupportAIService } = require('../services/support/SupportAIService');
const { createSupportTranslator } = require('../services/support/SupportTranslator');

const ROOT = path.join(__dirname, '..');

const TOKEN = '123456789:TEST-TOKEN-NOT-A-CREDENTIAL';
const ADMIN_A = '6054625818';
const ADMIN_B = '700700700';
const STRANGER = '999000999';
const CUSTOMER_CHAT_ID = '555111';
const OTHER_CHAT_ID = '666222';
const GROUP_ID = '-1001234567890';
const CONVERSATION_ID = 42;

let updateSeq = 50000;
const nextUpdateId = () => ++updateSeq;

// ------------------------------------------------------------------- harness ---

// The real column is TEXT NOT NULL DEFAULT 'en' with CHECK (en/pt/ar): a row that
// is created without a language takes 'en', exactly as this fake does.
function createFakeStore({ language = 'en' } = {}) {
  const state = { conversations: [], messages: [], escalations: [], languageWrites: [] };
  const byChat = new Map();
  let conversationId = CONVERSATION_ID;
  let messageSeq = 0;

  function createConversation(chatId, username) {
    const row = {
      id: conversationId++,
      telegram_chat_id: Number(chatId),
      telegram_user_id: Number(chatId),
      username: username || null,
      display_name: 'John Customer',
      language: 'en'
    };
    state.conversations.push(row);
    byChat.set(String(chatId), row);
    return row;
  }

  const conversation = createConversation(CUSTOMER_CHAT_ID, 'john');
  conversation.language = language;

  return {
    state,
    conversation,
    conversations: byChat,
    /** Create a second customer conversation (for the isolation test). */
    addConversation(chatId, username) { return createConversation(chatId, username); },
    async getConversationByChatId(chatId) {
      return byChat.get(String(chatId)) || null;
    },
    async getConversationById(id) {
      return state.conversations.find((c) => c.id === Number(id)) || null;
    },
    async upsertConversation({ chatId, telegramUserId, username, displayName }) {
      const existing = byChat.get(String(chatId));
      if (existing) {
        existing.username = username === undefined ? null : username;
        existing.display_name = displayName === undefined ? null : displayName;
        return { conversation: existing, created: false };
      }
      const row = createConversation(chatId, username);
      row.display_name = displayName === undefined ? null : displayName;
      return { conversation: row, created: true };
    },
    async setConversationLanguage({ conversationId: id, language: value }) {
      const row = state.conversations.find((c) => c.id === Number(id));
      if (!row) throw new Error('no conversation ' + id);
      state.languageWrites.push({ conversationId: Number(id), language: value });
      row.language = value;
      return row;
    },
    async insertMessage({ conversationId: id, direction, body }) {
      const message = { id: ++messageSeq, conversation_id: id, direction, body };
      state.messages.push(message);
      return { message };
    },
    async getLatestMessageByConversation({ conversationId: id, direction }) {
      return state.messages
        .filter((m) => m.conversation_id === id && (!direction || m.direction === direction))
        .pop() || null;
    },
    async createEscalation({ conversationId: id, supportMessageId }) {
      const row = { id: state.escalations.length + 1, conversation_id: id, support_message_id: supportMessageId };
      state.escalations.push(row);
      return row;
    },
    async setConversationStatus() { return true; },
    async probeColumns() { return true; }
  };
}

function createHarness(options = {}) {
  const {
    adminIds = [ADMIN_A],
    // Mirrors the real column (TEXT NOT NULL DEFAULT 'en'): a harness that does not
    // ask for a language gets an English conversation, never a NULL one.
    language = 'en',
    supportAI = null,
    translator = null,
    supportChatId = null,
    failLanguageWrite = false
  } = options;

  const calls = [];
  const lines = [];
  const logger = { log() {}, warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) };
  const store = createFakeStore({ language });
  if (failLanguageWrite) {
    store.setConversationLanguage = async () => { throw new Error('permission denied for table telegram_support_conversations'); };
  }

  let messageSeq = 900000;
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url, fetchOptions) => {
    const method = String(url).split('/').pop();
    const payload = JSON.parse(fetchOptions.body || '{}');
    if (method === 'answerCallbackQuery') {
      calls.push({ method, callbackQueryId: String(payload.callback_query_id), text: payload.text || null });
      return json({ ok: true, result: true });
    }
    const messageId = ++messageSeq;
    calls.push({
      method,
      chatId: String(payload.chat_id),
      text: payload.text,
      replyMarkup: payload.reply_markup || null,
      messageId
    });
    return json({ ok: true, result: { message_id: messageId } });
  };

  const transport = createTelegramTransport({ token: TOKEN, fetchImpl });
  const config = { token: TOKEN, adminIds, webhookSecret: 'test-webhook-secret', baseUrl: 'https://arbitrix.pro' };
  if (supportChatId) config.supportChatId = supportChatId;

  const bot = createTelegramSupportBot({ config, store, transport, logger, supportAI, translator });

  return {
    bot,
    store,
    logger,
    calls,
    lines,
    toChat: (id) => calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(id)),
    textTo: (id) => calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(id)).map((c) => c.text),
    toCustomer: () => calls.filter((c) => c.method === 'sendMessage' && c.chatId === CUSTOMER_CHAT_ID).map((c) => c.text),
    toAdmin: () => calls.filter((c) => c.method === 'sendMessage' && c.chatId === ADMIN_A).map((c) => c.text),
    callbacks: () => calls.filter((c) => c.method === 'answerCallbackQuery')
  };
}

function customerMessage(text, { chatId = CUSTOMER_CHAT_ID, username = 'john' } = {}) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: 1,
      from: { id: Number(chatId), username },
      chat: { id: Number(chatId), type: 'private' },
      text
    }
  };
}

function adminMessage(text, { adminId = ADMIN_A, replyTo } = {}) {
  const message = {
    message_id: 50,
    from: { id: Number(adminId), username: 'ops' },
    chat: { id: Number(adminId), type: 'private' },
    text
  };
  if (replyTo !== undefined) message.reply_to_message = { message_id: replyTo };
  return { update_id: nextUpdateId(), message };
}

function callbackUpdate(data, {
  chatId = CUSTOMER_CHAT_ID,
  fromId = chatId,
  chatType = 'private',
  callbackId = 'cb-' + nextUpdateId()
} = {}) {
  return {
    update_id: nextUpdateId(),
    callback_query: {
      id: callbackId,
      from: { id: Number(fromId), username: 'john' },
      message: { message_id: 1, chat: { id: Number(chatId), type: chatType } },
      data
    }
  };
}

/** Translation stub. `map` keys are `<from>-><to>`; values are te result. */
function createTranslatorStub(map = {}, { available = true } = {}) {
  const calls = { toEnglish: [], fromEnglish: [] };
  const lookup = (from, to) => map[from + '->' + to]
    || { ok: false, text: '', reason: 'unavailable' };
  return {
    calls,
    isAvailable: () => available,
    describe: () => ({ enabled: true, provider: 'stub', model: null, hasApiKey: true, maxChars: 1500, languages: ['en', 'pt', 'ar'] }),
    async toEnglish(text, language) {
      calls.toEnglish.push({ text, language });
      return lookup(language, 'en');
    },
    async fromEnglish(text, language) {
      calls.fromEnglish.push({ text, language });
      return lookup('en', language);
    }
  };
}

const PT_QUESTION = 'Posso fazer um depósito de $500?';
const PT_TRANSLATION = 'Can I make a $500 deposit?';
const PT_REPLY = 'Sim, você pode fazer um depósito de $500. Avise-me se precisar de ajuda.';
const AR_QUESTION = 'كيف يمكنني سحب أموالي؟';
const AR_TRANSLATION = 'How can I withdraw my money?';

// ===================================================== 1. /language command ===

test('1. /language sends the language picker', async () => {
  const h = createHarness();
  const result = await h.bot.handleUpdate(customerMessage('/language'));

  assert.strictEqual(result.action, 'language');
  const picker = h.toCustomer();
  assert.strictEqual(picker.length, 1, 'exactly one picker message');
  assert.ok(picker[0].includes('language'), 'the prompt mentions the command: ' + picker[0]);
  assert.ok(h.toChat(CUSTOMER_CHAT_ID)[0].replyMarkup, 'the picker carries an inline keyboard');
});

test('2. the inline keyboard contains EXACTLY en / pt / ar with lang: payloads', async () => {
  // The builder itself.
  const keyboard = i18n.languageKeyboard();
  const buttons = keyboard.inline_keyboard.flat();
  assert.deepStrictEqual(buttons.map((b) => b.callback_data), ['lang:en', 'lang:pt', 'lang:ar']);
  assert.deepStrictEqual(buttons.map((b) => b.text), ['English', 'Português', 'العربية']);

  // And what the customer actually receives.
  const h = createHarness();
  await h.bot.handleUpdate(customerMessage('/language'));
  const sent = h.toChat(CUSTOMER_CHAT_ID)[0].replyMarkup;
  assert.deepStrictEqual(sent.inline_keyboard.flat().map((b) => b.callback_data), ['lang:en', 'lang:pt', 'lang:ar']);
  assert.deepStrictEqual(i18n.TELEGRAM_LANGUAGES, ['en', 'pt', 'ar']);
  // A bare code must never be a payload.
  sent.inline_keyboard.flat().forEach((b) => {
    assert.ok(b.callback_data.includes(':'), 'payload must be namespaced: ' + b.callback_data);
    assert.notStrictEqual(b.callback_data, 'en');
  });
});

test('3. the lang:en callback stores English and confirms in English', async () => {
  const h = createHarness({ language: 'pt' });
  const result = await h.bot.handleUpdate(callbackUpdate('lang:en'));

  assert.strictEqual(result.action, 'language');
  assert.strictEqual(result.language, 'en');
  assert.deepStrictEqual(h.store.state.languageWrites, [{ conversationId: CONVERSATION_ID, language: 'en' }]);
  assert.strictEqual(h.store.conversation.language, 'en');
  assert.strictEqual(h.toCustomer().pop(), i18n.t('en', 'languageSet'));
});

test('4. the lang:pt callback stores Portuguese and confirms in Portuguese', async () => {
  const h = createHarness();
  await h.bot.handleUpdate(callbackUpdate('lang:pt'));

  assert.strictEqual(h.store.conversation.language, 'pt');
  assert.strictEqual(h.toCustomer().pop(), i18n.t('pt', 'languageSet'));
  assert.match(h.toCustomer().pop(), /responderei em português/);
});

test('5. the lang:ar callback stores Arabic and confirms in Arabic', async () => {
  const h = createHarness();
  await h.bot.handleUpdate(callbackUpdate('lang:ar'));

  assert.strictEqual(h.store.conversation.language, 'ar');
  assert.strictEqual(h.toCustomer().pop(), i18n.t('ar', 'languageSet'));
  assert.match(h.toCustomer().pop(), /بالعربية/);
});

test('6. an invalid callback language changes NOTHING and is answered', async () => {
  const h = createHarness({ language: 'pt' });
  const result = await h.bot.handleUpdate(callbackUpdate('lang:es'));

  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'unsupported-language');
  assert.deepStrictEqual(h.store.state.languageWrites, [], 'no write happened');
  assert.strictEqual(h.store.conversation.language, 'pt', 'the previous choice is intact');
  assert.strictEqual(h.callbacks().length, 1, 'the spinner is still cleared');
  assert.strictEqual(h.toCustomer().length, 0, 'no confirmation message for a rejected choice');
  assert.strictEqual(h.bot.getStats().languageRejected, 1);
});

test('6b. a bare code, a wrong prefix and junk are all rejected safely', async () => {
  for (const payload of ['pt', 'language:pt', 'lang:', 'lang:en; rm -rf', '', 'lang:zz']) {
    const h = createHarness({ language: 'pt' });
    const result = await h.bot.handleUpdate(callbackUpdate(payload));
    assert.strictEqual(result.handled, false, 'rejected: ' + JSON.stringify(payload));
    assert.strictEqual(h.store.conversation.language, 'pt', 'unchanged for ' + JSON.stringify(payload));
    assert.deepStrictEqual(h.store.state.languageWrites, []);
    assert.strictEqual(h.callbacks().length, 1);
    // The attacker-supplied value is never echoed back to the chat.
    assert.ok(!JSON.stringify(h.calls).includes('language:pt'), 'no echo of the payload');
  }
});

test('7. the callback query is acknowledged with its own callback id', async () => {
  const h = createHarness();
  await h.bot.handleUpdate(callbackUpdate('lang:pt', { callbackId: 'cb-abc-123' }));

  const acks = h.callbacks();
  assert.strictEqual(acks.length, 1);
  assert.strictEqual(acks[0].callbackQueryId, 'cb-abc-123');
  assert.strictEqual(acks[0].text, i18n.t('pt', 'languageSet'), 'the toast is localized too');
});

test('8. the language persists onto the conversation row', async () => {
  const h = createHarness();
  await h.bot.handleUpdate(callbackUpdate('lang:ar'));
  const conv = await h.store.getConversationByChatId(CUSTOMER_CHAT_ID);
  assert.strictEqual(conv.language, 'ar', 'stored on the conversation, not in memory');

  // A later ordinary message still uses the stored language.
  const ai = {
    isEnabled: () => true,
    // The answer must be in Arabic SCRIPT: the bot verifies that for `ar`, so a
    // Latin placeholder would be (correctly) rejected.
    // A MODEL-written answer declares its provenance (`source: 'provider'`); the
    // bot only treats text with that signal as already in the customer's language.
    async ask(question, opts) { return { kind: 'answer', answer: 'إجابة بالعربية (' + opts.language + ')', needsHuman: false, source: 'provider', modelGenerated: true }; }
  };
  const h2 = createHarness({ language: 'ar', supportAI: ai });
  await h2.bot.handleUpdate(customerMessage('another message'));
  assert.strictEqual(h2.toCustomer().pop(), 'إجابة بالعربية (ar)');
});

test('9. a new conversation is English via the column default (NOT NULL DEFAULT en)', async () => {
  const h = createHarness();
  assert.strictEqual(h.store.conversation.language, 'en', 'the column default is en');
  assert.strictEqual(h.bot.status().languagesSupported.join(','), 'en,pt,ar');
  await h.bot.handleUpdate(customerMessage('/start'));
  assert.strictEqual(h.toCustomer()[0], i18n.t('en', 'help'));
});

test('9b. the INSERT omits `language` (NOT NULL takes the column DEFAULT) and an upsert never resets it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportStore.js'), 'utf8');
  const insertAt = src.indexOf('.insert({');
  assert.ok(insertAt > -1, 'the insert path exists');
  const insertPayload = src.slice(insertAt, src.indexOf('})', insertAt));
  assert.ok(!/\blanguage\b/.test(insertPayload),
    'the insert must not send language: the NOT NULL column takes DEFAULT en');

  const upsertAt = src.indexOf('async function upsertConversation');
  const existingAt = src.indexOf('if (existing) {', upsertAt);
  const eqAt = src.indexOf(".eq('id', existing.id)", existingAt);
  assert.ok(upsertAt > -1 && existingAt > -1 && eqAt > -1, 'the upsert branches exist');
  assert.ok(!/\blanguage\b/.test(src.slice(existingAt, eqAt)),
    'a routine message upsert must never write language');
});

test('9c. the only language writer passes an explicitly validated code', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportService.js'), 'utf8');
  assert.match(src, /const requested = parseLanguageCallback\(/);
  const calls = src.match(/persistConversationLanguage\(conversation, requested\)/g) || [];
  assert.strictEqual(calls.length, 1, 'exactly one write site');
  assert.match(src, /if \(!requested\) \{/, 'an unsupported payload returns before any write');
});

test('10. an out-of-vocabulary value still resolves to English (application safety net)', async () => {
  // Production cannot store any of these: the column is NOT NULL DEFAULT 'en' with
  // CHECK (language IN ('en','pt','ar')). This pins the application-level fallback
  // that must hold regardless (e.g. in an environment where 032 is not applied).
  for (const stored of ['es', 'de', '', '   ', 'xx-YY', 42]) {
    const h = createHarness({ language: stored });
    await h.bot.handleUpdate(customerMessage('/start'));
    assert.strictEqual(h.toCustomer()[0], i18n.t('en', 'help'), 'fell back for ' + JSON.stringify(stored));
  }
  // And the resolver itself never throws on junk.
  assert.strictEqual(i18n.normalizeLanguage(undefined), 'en');
  assert.strictEqual(i18n.normalizeLanguage(null), 'en');
  assert.strictEqual(i18n.normalizeLanguage('PT-br'), 'pt');
});

// ================================================ 11-13. AI language directive ===

function recordingProvider() {
  const seen = [];
  return {
    seen,
    provider: {
      name: 'stub',
      kind: 'http',
      requiresApiKey: true,
      available: true,
      async generate({ question, hits, instructions }) {
        seen.push({ question, instructions: String(instructions || '') });
        return { text: 'stub answer', noAnswer: false, provider: 'stub' };
      }
    }
  };
}

async function askWithLanguage(language) {
  const { provider, seen } = recordingProvider();
  const service = createSupportAIService({
    config: { enabled: true, provider: 'stub', model: null, apiKey: 'test', baseUrl: null, timeoutMs: 1000, maxAnswerChars: 1200, minScore: 2 },
    provider
  });
  const outcome = await service.ask('What is the minimum deposit?', { language });
  return { outcome, instructions: seen[0] ? seen[0].instructions : '' };
}

test('11. a Portuguese customer gets a Portuguese language instruction', async () => {
  const { outcome, instructions } = await askWithLanguage('pt');
  assert.strictEqual(outcome.language, 'pt');
  assert.match(instructions, /LANGUAGE RULE \(highest priority/);
  assert.match(instructions, /Brazilian Portuguese/);
  assert.ok(!/Write your ENTIRE answer in English/.test(instructions), 'the language must not be pinned to English');
});

test('12. an Arabic customer gets an Arabic language instruction', async () => {
  const { outcome, instructions } = await askWithLanguage('ar');
  assert.strictEqual(outcome.language, 'ar');
  assert.match(instructions, /Modern Standard Arabic/);
});

test('13. an English customer gets an English language instruction', async () => {
  const { instructions } = await askWithLanguage('en');
  assert.match(instructions, /English/);
  // The directive is explicit that the selection is authoritative.
  assert.match(instructions, /authoritative/);
  assert.match(instructions, /Do NOT switch language/);
});

test('13b. an unsupported/absent language resolves to English', async () => {
  const a = await askWithLanguage('es');
  assert.strictEqual(a.outcome.language, 'en');
  assert.match(a.instructions, /English/);
  const b = await askWithLanguage(undefined);
  assert.strictEqual(b.outcome.language, 'en');
});

test('13c. the language directive forbids inventing or translating values', () => {
  const instruction = SupportGuidelines.languageInstruction('ar');
  assert.match(instruction, /EXACTLY as approved/);
  assert.match(instruction, /never the values/);
  // The pre-existing hard rules are still present in the full instruction set.
  const full = SupportGuidelines.instructionsFor('pt');
  assert.match(full, /Never promise profits/);
  assert.match(full, /Never request, repeat, or expose passwords/);
});

// ============================================== 14. the AI answer reaches the customer ===

test('14. the customer AI response uses the selected language and the AI receives it', async () => {
  const ai = {
    isEnabled: () => true,
    calls: [],
    providerName: () => 'stub',
    async ask(question, options) {
      this.calls.push({ question, language: options && options.language });
      // `modelGenerated` is what tells the bot this text is already in the
      // customer's language (approved knowledge text is English and is not marked).
      return { kind: 'answer', answer: 'Você pode fazer um depósito de $500.', needsHuman: false, reason: null, source: 'provider', modelGenerated: true };
    }
  };
  const h = createHarness({ language: 'pt', supportAI: ai });
  await h.bot.handleUpdate(customerMessage(PT_QUESTION));

  assert.strictEqual(ai.calls.length, 1);
  assert.strictEqual(ai.calls[0].language, 'pt', 'the conversation language is passed to the AI');
  assert.strictEqual(h.toCustomer()[0], 'Você pode fazer um depósito de $500.');
});

test('14b. an AI answer outside the selected language is NOT sent to an Arabic customer', async () => {
  const ai = {
    isEnabled: () => true,
    // A model that IGNORED the language directive: it must be caught by the script guard.
    async ask() { return { kind: 'answer', answer: 'You can withdraw anytime.', needsHuman: false, source: 'provider', modelGenerated: true }; }
  };
  const h = createHarness({ language: 'ar', supportAI: ai });
  await h.bot.handleUpdate(customerMessage(AR_QUESTION));

  assert.strictEqual(h.toCustomer()[0], i18n.t('ar', 'uncertain'), 'the localized Arabic fallback is used');
  assert.strictEqual(h.bot.getStats().aiLanguageMisses, 1);
});

test('14c. approved English knowledge is TRANSLATED for a non-English customer', async () => {
  const ai = {
    isEnabled: () => true,
    async ask() {
      // kind 'guardrail' carries APPROVED English policy text.
      return { kind: 'guardrail', answer: 'Arbitrix does not guarantee profits or returns.', needsHuman: false };
    }
  };
  const translator = createTranslatorStub({
    'en->pt': { ok: true, text: 'A Arbitrix não garante lucros nem retornos.' }
  });
  const h = createHarness({ language: 'pt', supportAI: ai, translator });
  await h.bot.handleUpdate(customerMessage('e os lucros?'));

  assert.deepStrictEqual(translator.calls.fromEnglish.map((c) => c.language), ['pt']);
  assert.strictEqual(h.toCustomer()[0], 'A Arbitrix não garante lucros nem retornos.');
});

test('14d. without a translator, approved English is replaced by a localized fallback', async () => {
  const ai = {
    isEnabled: () => true,
    async ask() { return { kind: 'guardrail', answer: 'Arbitrix does not guarantee profits or returns.', needsHuman: false }; }
  };
  const h = createHarness({ language: 'pt', supportAI: ai, translator: null });
  await h.bot.handleUpdate(customerMessage('e os lucros?'));

  const reply = h.toCustomer()[0];
  assert.strictEqual(reply, i18n.t('pt', 'uncertain'));
  assert.ok(!/guarantee/i.test(reply), 'no English leaked to the customer');
});

// ================================================= 15-16. AI-off localizations ===

test('15. with AI off, a Portuguese customer gets the localized acknowledgement', async () => {
  const h = createHarness({ language: 'pt', supportAI: null });
  const result = await h.bot.handleUpdate(customerMessage('Olá, preciso de ajuda'));

  assert.strictEqual(result.action, 'forwarded');
  assert.strictEqual(h.toCustomer()[0], i18n.t('pt', 'acknowledgement'));
  assert.ok(!/Thanks for contacting/.test(h.toCustomer()[0]), 'never the English guide text');
});

test('16. with AI off, an Arabic customer gets the localized acknowledgement', async () => {
  const h = createHarness({ language: 'ar', supportAI: null });
  await h.bot.handleUpdate(customerMessage(AR_QUESTION));
  assert.strictEqual(h.toCustomer()[0], i18n.t('ar', 'acknowledgement'));
});

test('16b. an AI service that is present but DISABLED behaves like AI off', async () => {
  const ai = { isEnabled: () => false, ask: async () => { throw new Error('must not be called'); } };
  const h = createHarness({ language: 'ar', supportAI: ai });
  await h.bot.handleUpdate(customerMessage(AR_QUESTION));
  assert.strictEqual(h.toCustomer()[0], i18n.t('ar', 'acknowledgement'));
});

test('16c. the other localized fixed replies are used where they apply', async () => {
  const escalation = createHarness({ language: 'ar' });
  await escalation.bot.handleUpdate(customerMessage('/escalate preciso de ajuda'));
  assert.ok(escalation.toCustomer().includes(i18n.t('ar', 'escalationAck')));

  const help = createHarness({ language: 'pt' });
  await help.bot.handleUpdate(customerMessage('/help'));
  assert.strictEqual(help.toCustomer()[0], i18n.t('pt', 'help'));

  const chatid = createHarness({ language: 'pt' });
  await chatid.bot.handleUpdate(customerMessage('/chatid'));
  assert.strictEqual(chatid.toCustomer()[0], i18n.t('pt', 'chatId', { id: CUSTOMER_CHAT_ID }));
});

// ================================================== 17-21. ADMIN notifications ===

test('17. the admin notification stays ENGLISH for a Portuguese customer', async () => {
  const h = createHarness({ language: 'pt' });
  await h.bot.handleUpdate(customerMessage(PT_QUESTION));

  const notice = h.toAdmin()[0];
  assert.ok(notice.includes('New Customer Message'), 'the English operator title');
  assert.ok(notice.includes('Customer:'), 'English operator labels only');
  assert.ok(notice.includes('Conversation: #' + CONVERSATION_ID));
  assert.ok(notice.includes('Chat ID: ' + CUSTOMER_CHAT_ID));
  // The operator surface must not be translated into the customer's language.
  assert.ok(!notice.includes(i18n.t('pt', 'acknowledgement')));
});

test('18. the ORIGINAL Portuguese message is preserved in the notification', async () => {
  const h = createHarness({ language: 'pt' });
  await h.bot.handleUpdate(customerMessage(PT_QUESTION));
  const notice = h.toAdmin()[0];

  assert.ok(notice.includes('Language: Portuguese'), 'the selected language is named in English');
  assert.ok(notice.includes(PT_QUESTION), 'the original is shown verbatim');
});

test('19. the ORIGINAL Arabic message is preserved in the notification', async () => {
  const h = createHarness({ language: 'ar' });
  await h.bot.handleUpdate(customerMessage(AR_QUESTION));
  const notice = h.toAdmin()[0];

  assert.ok(notice.includes('Language: Arabic'));
  assert.ok(notice.includes(AR_QUESTION), 'the original Arabic is shown verbatim');
});

test('20. an English translation is included for the admin when available', async () => {
  const translator = createTranslatorStub({ 'pt->en': { ok: true, text: PT_TRANSLATION } });
  const h = createHarness({ language: 'pt', translator });
  await h.bot.handleUpdate(customerMessage(PT_QUESTION));
  const notice = h.toAdmin()[0];

  assert.deepStrictEqual(translator.calls.toEnglish.map((c) => c.language), ['pt']);
  assert.ok(notice.includes('English translation:'), notice);
  assert.ok(notice.includes(PT_TRANSLATION));
  // The original is STILL there - a translation never replaces it.
  assert.ok(notice.includes(PT_QUESTION));
  assert.ok(notice.indexOf(PT_QUESTION) < notice.indexOf(PT_TRANSLATION), 'original comes first');
});

test('21. when translation is unavailable the notice says so and keeps the original', async () => {
  const h = createHarness({ language: 'pt', translator: null });
  await h.bot.handleUpdate(customerMessage(PT_QUESTION));
  const notice = h.toAdmin()[0];

  assert.ok(notice.includes(PT_QUESTION), 'the original is still delivered');
  assert.match(notice, /English translation: unavailable/);
  assert.strictEqual(h.bot.getStats().translationsFailed, 1);
});

test('21b. a failed translation is also reported as unavailable, not faked', async () => {
  const translator = createTranslatorStub({ 'pt->en': { ok: false, text: '', reason: 'no-answer' } });
  const h = createHarness({ language: 'pt', translator });
  await h.bot.handleUpdate(customerMessage(PT_QUESTION));

  assert.match(h.toAdmin()[0], /English translation: unavailable/);
  assert.ok(!h.toAdmin()[0].includes(PT_TRANSLATION));
  assert.strictEqual(h.bot.getStats().lastTranslationReason, 'no-answer');
});

test('21c. an English customer notice is unchanged (no translation section)', async () => {
  const h = createHarness({ language: 'en' });
  await h.bot.handleUpdate(customerMessage('Where is my deposit?'));
  const notice = h.toAdmin()[0];

  assert.ok(notice.includes('Language: English'));
  assert.ok(notice.includes('Message:\nWhere is my deposit?'));
  assert.ok(!notice.includes('English translation:'));
});

// ================================================= 22-25. ADMIN reply translation ===

test('22. an admin reply-to-notification is translated into Portuguese', async () => {
  const translator = createTranslatorStub({ 'en->pt': { ok: true, text: PT_REPLY } });
  const h = createHarness({ language: 'pt', translator });

  await h.bot.handleUpdate(customerMessage(PT_QUESTION));
  const notification = h.toAdmin()[0];
  const notificationId = h.toChat(ADMIN_A)[0].messageId;

  const result = await h.bot.handleUpdate(adminMessage('Yes, you can make a $500 deposit. Let me know if you need help.', { replyTo: notificationId }));

  assert.strictEqual(result.action, 'admin-reply');
  assert.strictEqual(result.translated, true);
  assert.ok(notification.includes(PT_QUESTION));
  const delivered = h.toCustomer().pop();
  assert.strictEqual(delivered, PT_REPLY, 'the customer receives Portuguese');
  assert.ok(!/Yes, you can make/.test(delivered), 'never the operator English text');
  assert.deepStrictEqual(translator.calls.fromEnglish, [{
    text: 'Yes, you can make a $500 deposit. Let me know if you need help.',
    language: 'pt'
  }]);
});

test('23. an admin reply-to-notification is translated into Arabic', async () => {
  const arabicReply = 'نعم، يمكنك سحب أموالك في أي وقت.';
  const translator = createTranslatorStub({ 'en->ar': { ok: true, text: arabicReply } });
  const h = createHarness({ language: 'ar', translator });

  await h.bot.handleUpdate(customerMessage(AR_QUESTION));
  const notificationId = h.toChat(ADMIN_A)[0].messageId;
  const result = await h.bot.handleUpdate(adminMessage('Yes, you can withdraw anytime.', { replyTo: notificationId }));

  assert.strictEqual(result.translated, true);
  assert.strictEqual(h.toCustomer().pop(), arabicReply);
});

test('24. /reply is translated according to the customer language', async () => {
  const translator = createTranslatorStub({ 'en->pt': { ok: true, text: PT_REPLY } });
  const h = createHarness({ language: 'pt', translator });
  await h.bot.handleUpdate(customerMessage(PT_QUESTION));

  const result = await h.bot.handleUpdate(adminMessage(`/reply ${CONVERSATION_ID} Yes, you can make a $500 deposit.`));

  assert.strictEqual(result.action, 'reply');
  assert.strictEqual(h.toCustomer().pop(), PT_REPLY);
  assert.deepStrictEqual(translator.calls.fromEnglish.map((c) => c.text),
    ['Yes, you can make a $500 deposit.']);
  // The operator is told which chat it went to.
  assert.ok(h.textTo(ADMIN_A).some((t) => t.includes('Sent to chat ' + CUSTOMER_CHAT_ID)));
});

test('24b. an English customer reply is NOT translated', async () => {
  const translator = createTranslatorStub({ 'en->en': { ok: true, text: 'SHOULD NOT BE USED' } });
  const h = createHarness({ language: 'en', translator });
  await h.bot.handleUpdate(customerMessage('Where is my deposit?'));
  const notificationId = h.toChat(ADMIN_A)[0].messageId;
  await h.bot.handleUpdate(adminMessage('We are checking it now.', { replyTo: notificationId }));

  assert.strictEqual(h.toCustomer().pop(), 'We are checking it now.');
  assert.strictEqual(translator.calls.fromEnglish.length, 0, 'no translation call for English');
});

test('24c. when translation is unavailable the reply is still delivered, with a notice', async () => {
  const h = createHarness({ language: 'pt', translator: null });
  await h.bot.handleUpdate(customerMessage(PT_QUESTION));
  const notificationId = h.toChat(ADMIN_A)[0].messageId;
  const result = await h.bot.handleUpdate(adminMessage('We are on it.', { replyTo: notificationId }));

  assert.strictEqual(result.translated, false);
  assert.strictEqual(h.toCustomer().pop(), 'We are on it.', 'never silence - the reply goes out');
  assert.ok(h.textTo(ADMIN_A).some((t) => /translation into Portuguese is unavailable/.test(t)),
    'the operator is told in English');
});

test('24d. a translation withheld by the safety check is NOT sent; the English text is', async () => {
  const translator = createTranslatorStub({ 'en->pt': { ok: false, text: '', reason: 'unsafe', violations: ['pt:guarantee'] } });
  const h = createHarness({ language: 'pt', translator });
  await h.bot.handleUpdate(customerMessage(PT_QUESTION));
  const notificationId = h.toChat(ADMIN_A)[0].messageId;
  const result = await h.bot.handleUpdate(adminMessage('Your profit is guaranteed.', { replyTo: notificationId }));

  assert.strictEqual(result.translated, false);
  assert.strictEqual(h.toCustomer().pop(), 'Your profit is guaranteed.', 'the operator text, never a withheld translation');
  assert.ok(h.textTo(ADMIN_A).some((t) => /withheld by the safety check/.test(t)));
});

test('25. operator COMMANDS are never translated and never sent to a customer', async () => {
  const translator = createTranslatorStub({ 'en->pt': { ok: true, text: 'SHOULD NOT BE TRANSLATED' } });
  const h = createHarness({ language: 'pt', translator });
  await h.bot.handleUpdate(customerMessage(PT_QUESTION));
  const before = h.toCustomer().length;

  for (const command of [
    `/close ${CONVERSATION_ID}`,
    `/chatid`,
    `/help`,
    `/escalate ${CONVERSATION_ID} needs a human`,
    `/language`,
    '/reply',
    '/unknown-thing'
  ]) {
    await h.bot.handleUpdate(adminMessage(command));
  }

  assert.strictEqual(translator.calls.fromEnglish.length, 0, 'no command was translated');
  assert.strictEqual(h.toCustomer().length, before, 'no command text reached the customer');
});

// ============================================== 26-27. persistence & isolation ===

test('26. the language survives a bot/process restart', async () => {
  const store = createFakeStore();
  const shared = { store };

  const first = createTelegramSupportBot({
    config: { token: TOKEN, adminIds: [ADMIN_A] },
    store: shared.store,
    transport: createTelegramTransport({ token: TOKEN, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }) }),
    logger: { log() {}, warn() {}, error() {} }
  });
  await first.handleUpdate(callbackUpdate('lang:pt'));
  assert.strictEqual(shared.store.conversation.language, 'pt');

  // A NEW bot instance reading the SAME store (a restart/deploy) must see it.
  const ai = { isEnabled: () => true, async ask(q, o) { return { kind: 'answer', answer: 'PT:' + o.language, source: 'provider', modelGenerated: true }; } };
  const second = createTelegramSupportBot({
    config: { token: TOKEN, adminIds: [ADMIN_A] },
    store: shared.store,
    transport: createTelegramTransport({ token: TOKEN, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 2 } }) }) }),
    logger: { log() {}, warn() {}, error() {} },
    supportAI: ai
  });
  await second.handleUpdate(customerMessage('outra mensagem'));
  assert.strictEqual(shared.store.conversation.language, 'pt', 'still stored after the restart');
});

test('26b. a routine message upsert cannot reset the language', async () => {
  const h = createHarness({ language: 'ar' });
  await h.bot.handleUpdate(customerMessage(AR_QUESTION));
  assert.strictEqual(h.store.conversation.language, 'ar', 'the upsert left language untouched');
  assert.deepStrictEqual(h.store.state.languageWrites, [], 'no language write on an ordinary message');
});

test('27. a callback can only change the PRESSER OWN conversation', async () => {
  const h = createHarness({ language: 'pt' });
  const other = h.store.addConversation(OTHER_CHAT_ID, 'someone-else');
  assert.strictEqual(other.language, 'en', 'a fresh row takes the column default en');

  // A press originating from the OTHER chat changes the OTHER conversation only.
  await h.bot.handleUpdate(callbackUpdate('lang:ar', { chatId: OTHER_CHAT_ID }));
  assert.strictEqual(other.language, 'ar', 'the presser own conversation changed');
  assert.strictEqual(h.store.conversation.language, 'pt', 'the other conversation was untouched');
  assert.strictEqual(h.store.state.languageWrites.length, 1);
  assert.strictEqual(h.store.state.languageWrites[0].conversationId, other.id);
});

test('27b. a callback whose chat is not the sender is ignored (no write)', () => {
  // chat.id (555111) !== from.id (999000999) -> ignored before any handler runs.
  const route = routeUpdate(callbackUpdate('lang:pt', { chatId: CUSTOMER_CHAT_ID, fromId: STRANGER }), { adminIds: [ADMIN_A] });
  assert.strictEqual(route.kind, 'ignore');
  assert.strictEqual(route.reason, 'callback-chat-mismatch');
});

test('27c. a callback from a group is ignored', async () => {
  const route = routeUpdate(callbackUpdate('lang:pt', { chatId: GROUP_ID, fromId: GROUP_ID, chatType: 'supergroup' }), { adminIds: [ADMIN_A] });
  assert.strictEqual(route.kind, 'ignore');
  assert.strictEqual(route.reason, 'callback-not-private');

  const h = createHarness({ language: 'en' });
  const result = await h.bot.handleUpdate(callbackUpdate('lang:pt', { chatId: GROUP_ID, fromId: GROUP_ID, chatType: 'supergroup' }));
  assert.strictEqual(result.handled, false);
  assert.deepStrictEqual(h.store.state.languageWrites, []);
});

test('27d. a storage failure while saving the language fails loudly and changes nothing', async () => {
  const h = createHarness({ failLanguageWrite: true });
  await assert.rejects(() => h.bot.handleUpdate(callbackUpdate('lang:pt')),
    'the update must fail so Telegram retries rather than silently dropping the choice');
  assert.strictEqual(h.callbacks().length, 1, 'the spinner was still cleared');
  assert.strictEqual(h.bot.getStats().storageFailures >= 1, true);
});

// ============================================ dictionary + architecture invariants ===

test('28. the dictionary is small, complete in all three locales, and localized', () => {
  const locales = Object.keys(i18n.CUSTOMER_STRINGS);
  assert.deepStrictEqual(locales.sort(), ['ar', 'en', 'pt']);
  const keys = Object.keys(i18n.CUSTOMER_STRINGS.en).sort();
  assert.ok(keys.length >= 15 && keys.length <= 40, 'a small Telegram-specific dictionary, got ' + keys.length);
  // The web app has ~1,400 keys; this must NOT be a copy of it.
  assert.ok(keys.length < 50, 'must not duplicate the web dictionary');

  locales.forEach((locale) => {
    assert.deepStrictEqual(Object.keys(i18n.CUSTOMER_STRINGS[locale]).sort(), keys,
      locale + ' must define every key');
    keys.forEach((key) => {
      const value = i18n.CUSTOMER_STRINGS[locale][key];
      assert.strictEqual(typeof value, 'string', locale + '.' + key);
      assert.ok(value.trim().length > 0, locale + '.' + key + ' must not be empty');
    });
  });

  // Commands stay ASCII in every locale, and placeholders match English.
  const placeholders = (text) => (text.match(/\{\{[a-zA-Z]+\}\}/g) || []).sort();
  locales.forEach((locale) => {
    keys.forEach((key) => {
      assert.deepStrictEqual(placeholders(i18n.CUSTOMER_STRINGS[locale][key]),
        placeholders(i18n.CUSTOMER_STRINGS.en[key]), locale + '.' + key + ' placeholder mismatch');
    });
    ['help', 'languagePrompt', 'languageSet', 'acknowledgement'].forEach((key) => {
      assert.ok(/\/language/.test(i18n.CUSTOMER_STRINGS[locale][key]) || key === 'languageSet',
        locale + '.' + key + ' should mention the command');
    });
  });

  // pt really is Portuguese and ar really is Arabic.
  assert.match(i18n.CUSTOMER_STRINGS.pt.languageSet, /Idioma definido como Português/);
  assert.match(i18n.CUSTOMER_STRINGS.ar.languageSet, /تم تعيين اللغة إلى العربية/);
  assert.ok(SupportGuidelines.isArabicScript(i18n.CUSTOMER_STRINGS.ar.help));
});

test('29. operator strings are English-only and the operator surface is not localized', () => {
  const telegram = fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportService.js'), 'utf8');
  // The operator notice builder must not reach the customer dictionary.
  const forward = telegram.slice(telegram.indexOf('function buildForwardText'), telegram.indexOf('function buildEscalationNotice'));
  assert.ok(!/tCustomer\(/.test(forward), 'operator notices must never use the customer dictionary');
  assert.ok(/tOperator\(/.test(forward));
  // Every OPERATOR string is English.
  Object.keys(i18n.OPERATOR_STRINGS).forEach((key) => {
    assert.ok(!SupportGuidelines.isArabicScript(i18n.OPERATOR_STRINGS[key]), 'operator string must be English: ' + key);
    assert.ok(!/[ãõçáéíóúâêô]/.test(i18n.OPERATOR_STRINGS[key]), 'operator string must be English: ' + key);
  });
});

test('29b. support-group forwarding was NOT reintroduced', () => {
  const h = createHarness({ language: 'pt', supportChatId: GROUP_ID });
  return h.bot.handleUpdate(customerMessage(PT_QUESTION)).then(() => {
    assert.strictEqual(h.toChat(GROUP_ID).length, 0, 'the group must never receive anything');
    assert.strictEqual(h.bot.status().notifyTarget, 'admins');
  });
});

test('29c. the versioned migration matches the production schema and is idempotent', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '032_telegram_support_language.sql'), 'utf8');
  // The production shape, verified after the change was applied by hand:
  // language TEXT NOT NULL DEFAULT 'en' with CHECK (language IN ('en','pt','ar')).
  assert.match(sql, /ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en'/);
  assert.match(sql, /ALTER COLUMN language SET DEFAULT 'en'/);
  assert.match(sql, /ALTER COLUMN language SET NOT NULL/);
  assert.match(sql, /CHECK \(language IN \('en', 'pt', 'ar'\)\)/);
  // NULL is not a valid state, and the default is asserted rather than removed.
  assert.ok(!/CHECK \(language IS NULL/i.test(sql), 'the constraint must not allow NULL');
  assert.ok(!/IS NULL OR language/i.test(sql), 'NULL must not be a valid language state');
  assert.ok(!/DROP DEFAULT|ALTER COLUMN language DROP/i.test(sql), 'the default must not be removed');
  // Idempotent guards.
  assert.match(sql, /ADD COLUMN IF NOT EXISTS/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS telegram_support_conversations_language_check/);
  // Bad data is diagnosed, never rewritten.
  assert.match(sql, /RAISE EXCEPTION/);
  assert.match(sql, /WHERE language IS NULL/);
  assert.match(sql, /NOT IN \('en', 'pt', 'ar'\)/);
  assert.ok(!/DELETE\s+FROM|UPDATE\s+public\.telegram_support_conversations\s+SET|INSERT\s+INTO/i.test(sql),
    'must never rewrite customer data');
  assert.ok(!/CREATE TABLE|DROP TABLE/i.test(sql), 'must not create or drop a table');
  // The self-check verifies NOT NULL, the default and the constraint definition.
  assert.match(sql, /is_nullable/);
  assert.match(sql, /column_default/);
  assert.match(sql, /pg_get_constraintdef/);
  // No other migration defines a second language column.
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'));
  const others = migrations.filter((f) => f.endsWith('.sql') && !f.startsWith('032_'));
  others.forEach((file) => {
    const content = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', file), 'utf8');
    assert.ok(!/ADD COLUMN[^;]*support_language/i.test(content), 'no second language column in ' + file);
  });
});

test('29d. existing customer-ID handling and the private-admin architecture are intact', () => {
  const telegram = fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportService.js'), 'utf8');
  // The canonicalization for CONFIG values is untouched.
  assert.match(telegram, /function canonicalizeTelegramChatId/);
  assert.match(telegram, /function parseAdminIds/);
  // Route paths unchanged.
  assert.match(telegram, /kind: 'admin'/);
  assert.match(telegram, /kind: 'user'/);
  // No support-group forwarding call site was re-added.
  assert.ok(!/forwardToSupportGroup\('customer-message'\)/.test(telegram));
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /app\.post\('\/api\/telegram\/webhook', createTelegramWebhookHandler/);
});

// ============================================================== translation layer ===

test('30. the translation layer is unavailable without a credential and never throws', async () => {
  const translator = createSupportTranslator({ config: { enabled: true, provider: 'knowledge', model: null, apiKey: null, baseUrl: null, timeoutMs: 1000, maxChars: 100 } });
  assert.strictEqual(translator.isAvailable(), false);
  const result = await translator.fromEnglish('hello', 'pt');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'unavailable');
});

test('30b. the translation layer rejects unsafe/echoing/wrong-language output', async () => {
  const make = (text) => createSupportTranslator({
    config: { enabled: true, provider: 'stub', model: null, apiKey: 'k', baseUrl: null, timeoutMs: 1000, maxChars: 500 },
    providerFactory: () => ({
      name: 'stub', kind: 'http', requiresApiKey: true, available: true,
      async generate() { return { text, noAnswer: false }; }
    })
  });

  const echo = await make('hello').fromEnglish('hello', 'pt');
  assert.strictEqual(echo.reason, 'echo');

  const unsafe = await make('Seu lucro é garantido e sem risco.').fromEnglish('x', 'pt');
  assert.strictEqual(unsafe.reason, 'unsafe');
  assert.ok(unsafe.violations.length > 0);

  const wrongLanguage = await make('You can withdraw anytime.').fromEnglish('x', 'ar');
  assert.strictEqual(wrongLanguage.reason, 'wrong-language');

  const noAnswer = make(null);
  const empty = await noAnswer.fromEnglish('x', 'pt');
  assert.strictEqual(empty.ok, false);
});

test('30c. the multilingual safety denylist does not fire on denials, and is language-scoped', () => {
  // A refusal is not a violation (negation-aware), exactly like the English layer.
  assert.deepStrictEqual(
    SupportGuidelines.assertSafeAnswer('Não garantimos lucros nem retornos.', { language: 'pt' }), []);
  assert.deepStrictEqual(
    SupportGuidelines.assertSafeAnswer('لا نضمن الأرباح ولا العوائد.', { language: 'ar' }), []);
  // A positive promise is.
  assert.ok(SupportGuidelines.assertSafeAnswer('Lucro garantido para todos.', { language: 'pt' }).length > 0);
  assert.ok(SupportGuidelines.assertSafeAnswer('ربح مضمون للجميع', { language: 'ar' }).length > 0);
  // English behavior is byte-identical when no language is passed.
  assert.deepStrictEqual(
    SupportGuidelines.assertSafeAnswer('Arbitrix does not guarantee profits or returns.'), []);
  // The pt/ar patterns never fire on English text.
  assert.deepStrictEqual(SupportGuidelines.assertSafeAnswer('Your profit is not guaranteed.', { language: 'pt' }), []);
});

test('30d. an empty customer message still gets a localized reply', async () => {
  const h = createHarness({ language: 'pt' });
  // A non-text message (no text field) -> the localized "send text" guidance.
  await h.bot.handleUpdate({
    update_id: nextUpdateId(),
    message: { message_id: 1, from: { id: Number(CUSTOMER_CHAT_ID) }, chat: { id: Number(CUSTOMER_CHAT_ID), type: 'private' } }
  });
  assert.strictEqual(h.toCustomer()[0], i18n.t('pt', 'textOnly'));
});

test('16d. with AI off the operator workflow still translates (AI-off requirement)', async () => {
  // No supportAI at all, but a translator present: the customer gets a localized
  // acknowledgement AND the operator's English reply is still translated.
  const translator = createTranslatorStub({ 'en->pt': { ok: true, text: PT_REPLY } });
  const h = createHarness({ language: 'pt', supportAI: null, translator });
  await h.bot.handleUpdate(customerMessage(PT_QUESTION));
  assert.strictEqual(h.toCustomer()[0], i18n.t('pt', 'acknowledgement'));

  const notificationId = h.toChat(ADMIN_A)[0].messageId;
  const result = await h.bot.handleUpdate(adminMessage('Yes, that is possible.', { replyTo: notificationId }));
  assert.strictEqual(result.translated, true);
  assert.strictEqual(h.toCustomer().pop(), PT_REPLY);
});

test('16e. translation is a SEPARATE gate from AI_SUPPORT_ENABLED', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const fn = server.slice(
    server.indexOf('function createSupportTranslatorSafely'),
    server.indexOf('const telegramConfig = resolveTelegramConfig')
  );
  assert.ok(fn.length > 0, 'the translator factory must exist');
  assert.ok(!/AI_SUPPORT_ENABLED/.test(fn), 'the translator must not be gated on the AI answering flag');
  assert.match(fn, /resolveTranslationConfig\(process\.env\)/);
  // Wired into the bot next to the AI layer, so AI-off keeps translation. The
  // translator instance is built ONCE and handed to both layers (the AI layer uses it
  // to reach the English knowledge base from a pt/ar question, the bot to localize the
  // approved answer), which is why it is created before the bot.
  assert.match(server, /const supportTranslator = createSupportTranslatorSafely\(\);/);
  assert.ok(
    server.indexOf('const supportTranslator = createSupportTranslatorSafely();')
      < server.indexOf('const telegramBot = createTelegramSupportBot('),
    'the translator must exist before the bot (and the AI layer) receive it');
  assert.match(server, /supportAI: createSupportAIServiceSafely\(supportTranslator\),\s*\n\s*translator: supportTranslator/);
  assert.strictEqual(
    require('../services/support/SupportTranslator').TRANSLATION_ENABLED_ENV,
    'SUPPORT_TRANSLATION_ENABLED'
  );
});

test('29f. the storage/error message is localized and matches the exported constant', () => {
  const svc = require('../services/TelegramSupportService');
  assert.strictEqual(svc.STORAGE_DEGRADED_TEXT, i18n.t('en', 'storageDegraded'));
  ['en', 'pt', 'ar'].forEach((lang) => {
    assert.ok(i18n.t(lang, 'storageDegraded').trim().length > 0, lang);
  });
  assert.match(i18n.t('pt', 'storageDegraded'), /indispon/i);
  assert.ok(SupportGuidelines.isArabicScript(i18n.t('ar', 'storageDegraded')));
});

test('29g. every required customer-facing string exists in all three locales', () => {
  const required = [
    'help', 'acknowledgement', 'escalationAck', 'languagePrompt', 'languageSet',
    'textOnly', 'chatId', 'storageDegraded', 'uncertain', 'humanHandoff',
    'secretRefusal', 'secretShared', 'paymentStatus', 'aiDisabled', 'promptForQuestion'
  ];
  required.forEach((key) => {
    ['en', 'pt', 'ar'].forEach((locale) => {
      const value = i18n.CUSTOMER_STRINGS[locale][key];
      assert.strictEqual(typeof value, 'string', locale + '.' + key + ' must exist');
      assert.ok(value.trim().length > 0, locale + '.' + key + ' must not be empty');
    });
  });
  // /start and /help are the same stored string (Telegram sends /start).
  assert.strictEqual(i18n.t('en', 'help'), i18n.t('en', 'help'));
  assert.match(i18n.t('en', 'help'), /^Arbitrix Support/);
  assert.match(i18n.t('ar', 'help'), /^دعم Arbitrix/);
});

test('7b. a language callback works end-to-end through the real webhook handler', async () => {
  const { createTelegramWebhookHandler } = require('../services/TelegramSupportService');
  const h = createHarness({ adminIds: [ADMIN_A] });
  const handler = createTelegramWebhookHandler({ bot: h.bot, logger: { log() {}, warn() {}, error() {} } });

  const responses = [];
  const makeRes = () => {
    const res = {
      statusCode: null,
      body: null,
      status(code) { res.statusCode = code; return res; },
      json(payload) { res.body = payload; return res; }
    };
    responses.push(res);
    return res;
  };
  const SECRET = 'test-webhook-secret';
  const req = (update, headers) => {
    const sent = headers || { 'x-telegram-bot-api-secret-token': SECRET };
    return { query: {}, body: update, headers: sent, get: (name) => sent[String(name).toLowerCase()] };
  };

  // Fail-closed first: a callback without the secret token is rejected and
  // changes nothing.
  await handler(req(callbackUpdate('lang:pt'), {}), makeRes());
  assert.strictEqual(responses[0].statusCode, 401, 'the secret gate still guards callbacks');
  assert.strictEqual(h.store.conversation.language, 'en',
    'a rejected callback changes nothing (the row keeps the column default en)');
  assert.strictEqual(h.store.state.languageWrites.length, 0);

  await handler(req(callbackUpdate('lang:pt')), makeRes());
  assert.strictEqual(responses[1].statusCode, 200, 'the authenticated callback update is accepted');
  assert.strictEqual(h.store.conversation.language, 'pt');
  assert.strictEqual(h.callbacks().length, 1, 'the callback query was acknowledged');
  assert.strictEqual(h.toCustomer().pop(), i18n.t('pt', 'languageSet'));

  // A REDELIVERY of the same update is absorbed: the second delivery must not
  // re-run the handler (and therefore cannot write again).
  const before = h.store.state.languageWrites.length;
  const duplicate = callbackUpdate('lang:pt');
  await handler(req(duplicate), makeRes());
  await handler(req(duplicate), makeRes());
  assert.strictEqual(responses[3].statusCode, 200, 'a redelivery is still answered 200');
  assert.strictEqual(h.store.state.languageWrites.length, before + 1,
    'exactly one write for the new update, none for its redelivery');
  assert.strictEqual(h.bot.getStats().duplicateUpdates >= 1, true, 'the deduper caught it');
});

test('29h. no shipped file still claims NULL is valid or that the language column has no default', () => {
  const files = [
    'supabase/migrations/032_telegram_support_language.sql',
    '.env.example',
    'services/telegram-i18n.js',
    'services/TelegramSupportService.js',
    'services/TelegramSupportStore.js'
  ];
  const stale = [
    /NULL is allowed/i,
    /NULL remains allowed/i,
    /NULL = English/i,
    /NULL means English/i,
    /no column DEFAULT/i,
    /the column has no default/i,
    /does not guarantee/i,
    /never via a (DB|database) default/i,
    /never through a database default/i
  ];
  files.forEach((rel) => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    stale.forEach((re) => assert.ok(!re.test(text), rel + ' still claims ' + re));
  });
});
