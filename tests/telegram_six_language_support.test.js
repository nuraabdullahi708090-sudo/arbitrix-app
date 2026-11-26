'use strict';

/**
 * Six-language Telegram support (en / es / pt / fr / ar / zh).
 *
 * WHAT THIS PINS
 *   A. The language CHOICE: /language offers all six, a press stores the choice on
 *      the conversation row, and it survives later messages and a restart.
 *   B. The localized FIXED strings: help, acknowledgement, /chatid and the AI
 *      fallbacks come from the customer's own locale (never English).
 *   C. Language UNDERSTANDING: the dialogue engine recognises short replies,
 *      greetings, gratitude, handoff requests and fraud reports written in
 *      Spanish, French and Simplified Chinese - the same way it already did for
 *      English, Portuguese and Arabic.
 *   D. AI ANSWERS ARE TRANSLATED: an approved knowledge answer reaches an
 *      es / fr / zh customer through the SHARED SupportTranslator, and the
 *      customer's question is translated to English first so the (English)
 *      knowledge base stays reachable. The knowledge provider remains the ONLY
 *      answer source: the translator is never asked to answer.
 *   E. VALIDATION: Arabic script and Han characters are verified, and a
 *      partially untranslated es / fr / zh output is withheld (fail closed) so a
 *      half-translated message is never presented as a complete translation.
 *   F. PRESERVATION: English, Portuguese and Arabic behave exactly as before.
 *
 * The REAL service, the REAL engine, the REAL translator and the REAL knowledge
 * base run under test; only the Telegram transport, the conversation store and the
 * translating MODEL are doubles (no network, no database).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  createTelegramSupportBot,
  FIRST_CONTACT_TEXT
} = require('../services/TelegramSupportService');
const i18n = require('../services/telegram-i18n');
const Engine = require('../services/support/ConversationEngine');
const SupportGuidelines = require('../services/support/SupportGuidelines');
const { createSupportTranslator, resolveTranslationConfig } = require('../services/support/SupportTranslator');
const { createSupportAIService, resolveSupportAIConfig } = require('../services/support/SupportAIService');
const SupportKnowledge = require('../services/support/SupportKnowledge');

const KB = SupportKnowledge.readKnowledge();

const ROOT = path.join(__dirname, '..');
const TOKEN = '123456:TEST-BOT-TOKEN-SIX-LANGUAGES';
const SECRET = 'test-webhook-secret-six';
const GROUP_ID = '-100777';
const ADMIN_ID = '6054625818';
const CUSTOMER_CHAT_ID = '4242';
const CUSTOMER_ID = Number(CUSTOMER_CHAT_ID);
const CONVERSATION_ID = 7;

const CUSTOMER_FROM = { id: CUSTOMER_ID, is_bot: false, first_name: 'Ana', username: 'ana' };
const BOT_FROM = { id: 777000, is_bot: true, first_name: 'Kalderix Support', username: 'ArbitrixSupportBot' };

let updateSeq = 9000;
const nextId = () => ++updateSeq;

// ------------------------------------------------------------------ doubles ---

function createMemoryStore({ language = 'en' } = {}) {
  const conversations = language === null ? [] : [{
    id: CONVERSATION_ID,
    telegram_chat_id: CUSTOMER_ID,
    telegram_user_id: CUSTOMER_ID,
    username: 'ana',
    display_name: 'Ana',
    language,
    status: 'open'
  }];
  const languageWrites = [];
  const messages = [];
  let nextConversation = CONVERSATION_ID + 1;

  return {
    conversations,
    languageWrites,
    messages,
    async getConversationByChatId(chatId) {
      return conversations.find((c) => String(c.telegram_chat_id) === String(chatId)) || null;
    },
    async getConversationById(id) {
      return conversations.find((c) => c.id === Number(id)) || null;
    },
    async upsertConversation({ chatId, telegramUserId, username, displayName }) {
      const existing = await this.getConversationByChatId(chatId);
      if (existing) return { conversation: existing, created: false };
      // The production column is TEXT NOT NULL DEFAULT 'en'.
      const row = {
        id: nextConversation++,
        telegram_chat_id: Number(chatId),
        telegram_user_id: Number(telegramUserId),
        username: username === undefined ? null : username,
        display_name: displayName === undefined ? null : displayName,
        language: 'en',
        status: 'open'
      };
      conversations.push(row);
      return { conversation: row, created: true };
    },
    async setConversationLanguage({ conversationId, language }) {
      const row = conversations.find((c) => c.id === Number(conversationId));
      if (!row) throw new Error('no conversation ' + conversationId);
      languageWrites.push({ conversationId: Number(conversationId), language });
      row.language = language;
      return { id: row.id, language: row.language };
    },
    async setConversationContext({ conversationId, context }) {
      const row = conversations.find((c) => c.id === Number(conversationId));
      if (row) row.context = context;
      return true;
    },
    async insertMessage({ conversationId, direction, body }) {
      const message = { id: messages.length + 1, conversation_id: conversationId, direction, body };
      messages.push(message);
      return { message };
    },
    async getLatestMessageByConversation() { return null; },
    async createEscalation() { return { id: 1 }; },
    async setConversationStatus() { return true; },
    async probeColumns() { return true; }
  };
}

function createTransport() {
  const calls = [];
  let seq = 500;
  return {
    calls,
    async sendMessage(chatId, text, options) {
      calls.push({
        method: 'sendMessage',
        chatId: String(chatId),
        text,
        replyMarkup: (options && options.reply_markup) || null
      });
      return { message_id: ++seq };
    },
    async answerCallbackQuery(callbackQueryId, options) {
      calls.push({ method: 'answerCallbackQuery', callbackQueryId, text: (options && options.text) || null });
      return true;
    },
    async getWebhookInfo() { return { url: 'https://arbitrix.pro/api/telegram/webhook', pending_update_count: 0 }; },
    async setWebhook() { return true; }
  };
}

// ------------------------------------------------------- translating double ---

/**
 * The translating MODEL, as a fake provider the REAL SupportTranslator drives.
 *
 * Modes (per direction):
 *   prefix        - a locale-shaped sentence carrying every number/URL of the source
 *   untouched     - the English source back, unchanged (an "echo")
 *   half          - the first sentence translated, the REST still English (the
 *                   partially-translated case the residual-English guard must catch)
 *   latin-zh      - es / fr style Latin output for a zh request (script violation)
 *
 * A stub that simply returns "[es] <english>" would make the residual-English
 * guard look correct for the wrong reason, so the default mode is a realistic
 * translation.
 */
const TRANSLATION_SENTENCE = Object.freeze({
  en: 'This is the English text.',
  es: 'Esta es la respuesta aprobada, traducida al español.',
  pt: 'Esta é a resposta aprovada, traduzida para português.',
  fr: 'Ceci est la réponse approuvée, traduite en français.',
  ar: 'هذه هي الإجابة المعتمدة مترجمة إلى العربية.',
  zh: '这是翻译后的已批准回答。'
});

function valuesOf(text) {
  return String(text).match(/https?:\/\/\S+|\$?\d[\d.,]*%?/g) || [];
}

/**
 * The questions this file asks, in every supported language, with their English
 * form. A real translator produces the English question too - that is exactly how
 * the English knowledge base stays reachable - so the double must as well.
 */
const QUESTION_TO_ENGLISH = Object.freeze({
  '¿Cuál es el depósito mínimo?': 'What is the minimum deposit?',
  'Quel est le dépôt minimum ?': 'What is the minimum deposit?',
  '最低入金是多少？': 'What is the minimum deposit?',
  'Qual é o depósito mínimo?': 'What is the minimum deposit?',
  'ما هو الحد الأدنى للإيداع؟': 'What is the minimum deposit?',
  'What is the minimum deposit?': 'What is the minimum deposit?'
});

function makeTranslatingModel() {
  const calls = [];
  let mode = 'prefix';
  return {
    calls,
    setMode(value) { mode = value; },
    factory(from, to) {
      return {
        name: 'fake-translator',
        kind: 'http',
        requiresApiKey: true,
        available: true,
        model: 'fake',
        async generate({ question } = {}) {
          const source = String(question === null || question === undefined ? '' : question);
          calls.push({ from, to, text: source });
          if (mode === 'untouched') return { text: source, provider: 'fake-translator' };
          // Translating the customer's QUESTION into English: a real translator
          // maps it to the English wording, which is what lets the approved
          // English knowledge base answer it. Unknown questions are passed back
          // unchanged, so the retriever still finds nothing (the F1 case).
          if (to === 'en') {
            return { text: QUESTION_TO_ENGLISH[source] || source, provider: 'fake-translator' };
          }
          if (mode === 'latin-zh') return { text: 'This is English, not Chinese.', provider: 'fake-translator' };
          if (mode === 'half') {
            const firstSentence = source.split(/(?<=[.!?])\s+/)[0] || source;
            const rest = source.slice(firstSentence.length).trim();
            return { text: TRANSLATION_SENTENCE[to] + ' ' + rest, provider: 'fake-translator' };
          }
          const values = valuesOf(source);
          const body = TRANSLATION_SENTENCE[to] || TRANSLATION_SENTENCE.en;
          return { text: values.length ? body + ' ' + values.join(' ') : body, provider: 'fake-translator' };
        }
      };
    }
  };
}

function makeTranslator(model) {
  const config = resolveTranslationConfig({
    SUPPORT_TRANSLATION_ENABLED: 'true',
    AI_SUPPORT_PROVIDER: 'deepseek',
    AI_SUPPORT_API_KEY: 'test-key-not-a-credential'
  });
  return createSupportTranslator({
    config,
    providerFactory: model.factory,
    logger: { warn() {} }
  });
}

function knowledgeAI(translator) {
  return createSupportAIService({
    config: resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'knowledge' }),
    translator
  });
}

// ------------------------------------------------------------------ harness ---

function createHarness({ language = 'en', noConversation = false, translator = null, supportAI = null } = {}) {
  const store = createMemoryStore({ language: noConversation ? null : language });
  const transport = createTransport();
  const bot = createTelegramSupportBot({
    config: {
      token: TOKEN,
      supportChatId: GROUP_ID,
      adminIds: [ADMIN_ID],
      webhookSecret: SECRET,
      baseUrl: 'https://arbitrix.pro'
    },
    store,
    transport,
    translator,
    supportAI,
    logger: { log() {}, warn() {}, error() {} }
  });

  const toCustomer = () => transport.calls
    .filter((c) => c.method === 'sendMessage' && c.chatId === CUSTOMER_CHAT_ID);
  const toAdmin = () => transport.calls
    .filter((c) => c.method === 'sendMessage' && c.chatId === ADMIN_ID)
    .map((c) => c.text);

  const message = (text) => ({
    update_id: nextId(),
    message: {
      message_id: nextId(), date: 1700000000, text,
      chat: { id: CUSTOMER_ID, type: 'private' }, from: CUSTOMER_FROM
    }
  });

  return {
    bot,
    store,
    transport,
    toCustomer,
    toAdmin,
    last: () => { const list = toCustomer(); return list.length ? list[list.length - 1].text : null; },
    allText: () => toCustomer().map((c) => c.text).join('\n'),
    say: (text) => bot.handleUpdate(message(text)),
    command: (text) => bot.handleUpdate(message(text)),
    press: (data) => bot.handleUpdate({
      update_id: nextId(),
      callback_query: {
        id: 'cb-' + nextId(),
        from: CUSTOMER_FROM,
        chat_instance: 'chat-instance',
        data,
        message: {
          message_id: 5150, date: 1700000000,
          chat: { id: CUSTOMER_ID, type: 'private' }, from: BOT_FROM
        }
      }
    })
  };
}

const buttonsOf = (markup) => markup.inline_keyboard.flat();

// ============================================================================
// A. The language choice
// ============================================================================

test('A1. /language offers all six supported languages with namespaced payloads', async () => {
  const h = createHarness({ language: 'en' });
  await h.command('/language');

  const markup = h.toCustomer().pop().replyMarkup;
  assert.deepStrictEqual(buttonsOf(markup).map((b) => b.callback_data),
    ['lang:en', 'lang:es', 'lang:pt', 'lang:fr', 'lang:ar', 'lang:zh']);
  assert.deepStrictEqual(buttonsOf(markup).map((b) => b.text),
    ['English', 'Español', 'Português', 'Français', 'العربية', '简体中文']);
  // A bare code must never be a payload (the parser expects the `lang:` prefix).
  buttonsOf(markup).forEach((b) => assert.ok(b.callback_data.indexOf(':') > 0));
});

test('A2. pressing es / fr / zh stores the choice and confirms in that language', async () => {
  const expected = {
    es: /Idioma establecido en español/,
    fr: /Langue définie sur le français/,
    zh: /语言已设置为简体中文/
  };
  for (const locale of ['es', 'fr', 'zh']) {
    const h = createHarness({ language: 'en' });
    await h.press('lang:' + locale);

    assert.deepStrictEqual(h.store.languageWrites,
      [{ conversationId: CONVERSATION_ID, language: locale }], locale + ' must be persisted');
    assert.strictEqual(h.store.conversations[0].language, locale);
    const confirmation = h.toCustomer().pop().text;
    assert.strictEqual(confirmation, i18n.t(locale, 'languageSet'), locale + ' confirms in its own language');
    assert.match(confirmation, expected[locale], locale + ' confirmation copy');
    // The callback is always acknowledged so the button does not spin.
    assert.strictEqual(h.transport.calls.filter((c) => c.method === 'answerCallbackQuery').length, 1);
  }
});

test('A3. an unsupported language is still rejected: no write, no message, one ack', async () => {
  const h = createHarness({ language: 'pt' });
  const result = await h.press('lang:de');

  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'unsupported-language');
  assert.deepStrictEqual(h.store.languageWrites, []);
  assert.strictEqual(h.store.conversations[0].language, 'pt');
  assert.strictEqual(h.toCustomer().length, 0);
  assert.strictEqual(h.transport.calls.filter((c) => c.method === 'answerCallbackQuery').length, 1);
});

test('A4. a stored es / fr / zh choice survives a restart (it lives in the row, not memory)', async () => {
  for (const locale of ['es', 'fr', 'zh']) {
    const store = createMemoryStore({ language: locale });
    const first = createTelegramSupportBot({
      config: { token: TOKEN, webhookSecret: SECRET, adminIds: [ADMIN_ID] },
      store,
      transport: createTransport(),
      logger: { log() {}, warn() {}, error() {} }
    });
    await first.handleUpdate({
      update_id: nextId(),
      message: {
        message_id: nextId(), date: 1700000000, text: '/help',
        chat: { id: CUSTOMER_ID, type: 'private' }, from: CUSTOMER_FROM
      }
    });

    const transport = createTransport();
    const restarted = createTelegramSupportBot({
      config: { token: TOKEN, webhookSecret: SECRET, adminIds: [ADMIN_ID] },
      store,
      transport,
      logger: { log() {}, warn() {}, error() {} }
    });
    await restarted.handleUpdate({
      update_id: nextId(),
      message: {
        message_id: nextId(), date: 1700000000, text: '/help',
        chat: { id: CUSTOMER_ID, type: 'private' }, from: CUSTOMER_FROM
      }
    });

    const sent = transport.calls.filter((c) => c.method === 'sendMessage' && c.chatId === CUSTOMER_CHAT_ID);
    assert.strictEqual(sent[0].text, i18n.t(locale, 'help'), locale + ' after a restart');
  }
});

test('A5. region tags resolve to the base language and junk still falls back to English', () => {
  assert.strictEqual(i18n.normalizeLanguage('es-MX'), 'es');
  assert.strictEqual(i18n.normalizeLanguage('es_AR'), 'es');
  assert.strictEqual(i18n.normalizeLanguage('fr-CA'), 'fr');
  assert.strictEqual(i18n.normalizeLanguage('zh-Hans'), 'zh');
  assert.strictEqual(i18n.normalizeLanguage('ZH'), 'zh');
  assert.strictEqual(i18n.normalizeLanguage('de'), 'en');
  assert.strictEqual(i18n.normalizeLanguage(''), 'en');
  assert.strictEqual(i18n.normalizeLanguage(null), 'en');
  assert.deepStrictEqual(i18n.TELEGRAM_LANGUAGES, ['en', 'es', 'pt', 'fr', 'ar', 'zh']);
});

test('A6. a new conversation still starts in English via the column default', async () => {
  const h = createHarness({ noConversation: true });
  await h.command('/start');

  assert.strictEqual(h.toCustomer()[0].text, FIRST_CONTACT_TEXT, 'the picker is shown first');
  assert.deepStrictEqual(h.store.languageWrites, [], 'first contact writes no language');
});

// ============================================================================
// B. Localized fixed strings
// ============================================================================

test('B1. help / acknowledgement / chatId are localized in es / fr / zh (never English)', async () => {
  const expectations = {
    es: /Soporte de Kalderix/,
    fr: /Support Kalderix/,
    zh: /Kalderix 客服/
  };
  for (const locale of ['es', 'fr', 'zh']) {
    const h = createHarness({ language: locale });
    await h.command('/help');
    const help = h.toCustomer().pop().text;
    assert.strictEqual(help, i18n.t(locale, 'help'));
    assert.match(help, expectations[locale], locale + ' help copy');
    assert.notStrictEqual(help, i18n.t('en', 'help'), locale + ' must not receive the English help');
    // Commands are never translated.
    ['/language', '/escalate', '/tutorial', '/chatid'].forEach((command) => {
      assert.ok(help.indexOf(command) > -1, locale + ' help must keep ' + command + ' verbatim');
    });

    await h.command('/chatid');
    assert.strictEqual(h.toCustomer().pop().text, i18n.t(locale, 'chatId', { id: CUSTOMER_CHAT_ID }));
    if (locale === 'zh') {
      assert.ok(SupportGuidelines.isCjkScript(i18n.t('zh', 'help')));
    }
    if (locale === 'fr') {
      assert.match(i18n.t('fr', 'acknowledgement'), /[éèêàçûô]/);
    }
  }
});

test('B2. a returning es / fr / zh customer is answered in their language, choice intact', async () => {
  for (const locale of ['es', 'fr', 'zh']) {
    const h = createHarness({ language: locale });
    await h.command('/start');
    const replies = h.toCustomer();
    assert.strictEqual(replies.length, 1, 'a returning customer is not re-prompted');
    assert.strictEqual(replies[0].text, i18n.t(locale, 'help'));
    assert.strictEqual(h.store.languageWrites.length, 0, 'the stored choice is never reset');
  }
});

// ============================================================================
// C. Understanding the new languages (dialogue engine)
// ============================================================================

test('C1. greetings in es / fr / zh are recognised as greetings', () => {
  const cases = [['es', 'hola'], ['es', 'buenos días'], ['fr', 'bonjour'], ['fr', 'salut'], ['zh', '你好'], ['zh', '您好']];
  cases.forEach(([locale, text]) => {
    const plan = Engine.planTurn({ text, state: Engine.emptyState() });
    assert.strictEqual(plan.intent, 'greeting', locale + ' greeting: ' + text);
  });
});

test('C2. courtesies in es / fr / zh never replay the clarification fallback', async () => {
  const courtesy = { es: 'vale', fr: "d'accord", zh: '明白了' };
  for (const locale of ['es', 'fr', 'zh']) {
    const h = createHarness({ language: locale });
    await h.say(courtesy[locale]);
    // The FIRST courtesy is acknowledged; the SAME courtesy again closes politely
    // instead of repeating itself.
    assert.strictEqual(h.last(), i18n.t(locale, 'socialAck'), locale + ' first courtesy');
    await h.say(courtesy[locale]);
    assert.strictEqual(h.last(), i18n.t(locale, 'socialClosing'), locale + ' repeated courtesy');

    // Thanks is acknowledged too, in the customer's own words.
    await h.say({ es: 'gracias', fr: 'merci', zh: '谢谢' }[locale]);
    assert.ok([i18n.t(locale, 'socialThanks'), i18n.t(locale, 'socialThanksBig')].indexOf(h.last()) > -1,
      locale + ' gratitude');
    h.toCustomer().forEach((c) => {
      assert.notStrictEqual(c.text, i18n.t(locale, 'clarifyTopic'),
        locale + ' must not emit the clarification fallback for a courtesy');
    });
  }
});

test('C3. short answers in es / fr / zh are understood only through a pending question', () => {
  // No pending question: never guessed.
  ['sí', 'oui', '是', 'no', 'non', '不'].forEach((text) => {
    const plan = Engine.planTurn({ text, state: Engine.emptyState() });
    assert.strictEqual(plan.intent, 'clarify', 'a bare answer must not be guessed: ' + text);
  });

  // With the deposit follow-up pending ("do you already have USDT?"), the same
  // words are confirmations / denials - exactly like yes/no in English.
  const yes = { es: 'sí', fr: 'oui', zh: '是' };
  const no = { es: 'no', fr: 'non', zh: '不' };
  Object.keys(yes).forEach((locale) => {
    const state = Engine.emptyState();
    state.pending = 'deposit.has_crypto';
    assert.strictEqual(Engine.planTurn({ text: yes[locale], state }).intent, 'has_crypto', locale + ' yes');
    const denial = Engine.emptyState();
    denial.pending = 'deposit.has_crypto';
    assert.strictEqual(Engine.planTurn({ text: no[locale], state: denial }).intent, 'no_crypto', locale + ' no');
  });
});

test('C4. handoff requests in es / fr / zh reach a human, and statements do not', () => {
  const requests = [['es', 'humano'], ['es', 'quiero hablar con un humano'], ['fr', 'humain'],
    ['fr', 'je veux parler à un humain'], ['zh', '人工'], ['zh', '转人工']];
  requests.forEach(([locale, text]) => {
    const plan = Engine.planTurn({ text, state: Engine.emptyState() });
    assert.strictEqual(plan.intent, 'human', locale + ' handoff request: ' + text);
    assert.strictEqual(plan.humanRequested, true);
  });

  const statements = ['el bot no es humano', 'le bot n est pas humain', '这不是真人客服'];
  statements.forEach((text) => {
    const plan = Engine.planTurn({ text, state: Engine.emptyState() });
    assert.notStrictEqual(plan.intent, 'human', 'a statement must not be a handoff: ' + text);
  });
});

test('C5. fraud / lost funds reported in es / fr / zh escalates to a human', () => {
  ['me hackearon la cuenta', 'mon compte a été piraté', '我的账户被盗了'].forEach((text) => {
    const plan = Engine.planTurn({ text, state: Engine.emptyState() });
    assert.strictEqual(plan.intent, 'fraud', 'fraud must reach a human: ' + text);
  });
});

test('C6. a deposit request in es / fr / zh starts the deposit flow (no tutorial link yet)', async () => {
  const requests = [['es', 'quiero depositar'], ['fr', 'je veux déposer'], ['zh', '我想入金']];
  for (const [locale, text] of requests) {
    const h = createHarness({ language: locale });
    await h.say(text);
    const reply = h.allText();
    assert.ok(reply.indexOf(i18n.t(locale, 'depositIntro')) > -1, locale + ' deposit intro');
    assert.ok(!/t\.me\/ArbitrixAnnouncements/.test(reply),
      'no tutorial link before the customer says which method they use');
  }
});

// ============================================================================
// D. AI answers translated through the shared SupportTranslator
// ============================================================================

const MIN_DEPOSIT_QUESTION = {
  es: '¿Cuál es el depósito mínimo?',
  fr: 'Quel est le dépôt minimum ?',
  zh: '最低入金是多少？'
};

test('D1. an approved knowledge answer reaches an es / fr / zh customer, translated', async () => {
  for (const locale of ['es', 'fr', 'zh']) {
    const model = makeTranslatingModel();
    const translator = makeTranslator(model);
    const h = createHarness({ language: locale, translator, supportAI: knowledgeAI(translator) });

    await h.say(MIN_DEPOSIT_QUESTION[locale]);

    const reply = h.last();
    assert.ok(reply, locale + ' was answered');
    // The QUESTION was translated to English so the English knowledge base is reachable.
    assert.ok(model.calls.some((c) => c.from === locale && c.to === 'en'),
      locale + ' question must be translated to English for retrieval');
    // The ANSWER was translated into the customer's language.
    const answerCall = model.calls.find((c) => c.from === 'en' && c.to === locale);
    assert.ok(answerCall, locale + ' answer must be translated from English');
    assert.ok(reply.indexOf(TRANSLATION_SENTENCE[locale]) > -1, locale + ' receives the translated answer');
    // No English answer leaked, and no generic fallback was needed.
    assert.ok(!/The minimum deposit/i.test(reply), locale + ' must not receive the English answer');
    assert.notStrictEqual(reply, i18n.t(locale, 'uncertain'), locale + ' is answered, not escalated');
  }
});

test('D2. the translator is never asked to ANSWER: only to translate', async () => {
  const model = makeTranslatingModel();
  const translator = makeTranslator(model);
  const h = createHarness({ language: 'es', translator, supportAI: knowledgeAI(translator) });

  await h.say(MIN_DEPOSIT_QUESTION.es);

  assert.ok(model.calls.length >= 1);
  model.calls.forEach((call) => {
    assert.ok(String(call.text).trim().length > 0, 'the translator is never called with empty text');
  });

  // Every text handed to the translator for en->es is an APPROVED English answer
  // (or the customer's own question): the translator NEVER authors a fact.
  const allowed = SupportKnowledge.flattenEntries(KB).map((entry) => entry.answer)
    .concat([SupportGuidelines.UNCERTAIN_TEXT, SupportGuidelines.HUMAN_HANDOFF_TEXT]);
  model.calls.filter((c) => c.to === 'es').forEach((call) => {
    assert.ok(allowed.indexOf(call.text) > -1,
      'the translation source must be approved text, got: ' + call.text.slice(0, 60));
  });
});

test('D3. Portuguese and Arabic are unchanged end-to-end', async () => {
  for (const locale of ['pt', 'ar']) {
    const model = makeTranslatingModel();
    const translator = makeTranslator(model);
    const h = createHarness({ language: locale, translator, supportAI: knowledgeAI(translator) });

    await h.say(locale === 'pt' ? 'Qual é o depósito mínimo?' : 'ما هو الحد الأدنى للإيداع؟');

    const reply = h.last();
    assert.ok(reply);
    assert.ok(reply.indexOf(TRANSLATION_SENTENCE[locale]) > -1, locale + ' still receives its translation');
    if (locale === 'ar') {
      assert.ok(SupportGuidelines.isArabicScript(reply), 'Arabic is still delivered in Arabic script');
    }
  }
});

test('D4. with no translation layer a pt / ar / es / fr / zh customer gets the LOCALIZED fallback', async () => {
  for (const locale of ['es', 'fr', 'zh']) {
    const h = createHarness({ language: locale, translator: null, supportAI: knowledgeAI(null) });
    await h.say(MIN_DEPOSIT_QUESTION[locale]);
    assert.strictEqual(h.last(), i18n.t(locale, 'uncertain'),
      locale + ' must receive the localized fallback, never the English answer');
  }
});

// ============================================================================
// E. Validation: a half-translated answer must never look complete
// ============================================================================

test('E1. hasExpectedScript: Arabic and Chinese scripts are verified, Latin languages are not guessed', () => {
  assert.strictEqual(SupportGuidelines.hasExpectedScript('إجابة بالعربية', 'ar'), true);
  assert.strictEqual(SupportGuidelines.hasExpectedScript('This is English', 'ar'), false);
  assert.strictEqual(SupportGuidelines.hasExpectedScript('这是中文回答', 'zh'), true);
  assert.strictEqual(SupportGuidelines.hasExpectedScript('This is English', 'zh'), false);
  ['es', 'fr', 'pt', 'en'].forEach((locale) => {
    assert.strictEqual(SupportGuidelines.hasExpectedScript('cualquier texto', locale), true);
  });
  assert.strictEqual(SupportGuidelines.hasExpectedScript('   ', 'zh'), false);
  assert.strictEqual(SupportGuidelines.hasExpectedScript(null, 'ar'), false);
});

test('E2. findResidualEnglish flags a long verbatim English run for es / fr / zh only', () => {
  const source = 'The minimum deposit is $50 and your funds are credited to your Live balance.';
  assert.ok(SupportGuidelines.findResidualEnglish(source, 'El depósito mínimo es $50. ' + source, 'es'));
  assert.ok(SupportGuidelines.findResidualEnglish(source, 'Le dépôt minimum est de 50 $. ' + source, 'fr'));
  assert.ok(SupportGuidelines.findResidualEnglish(source, '最低入金是 50 美元。 ' + source, 'zh'));
  // A real translation carries no long English run.
  assert.strictEqual(SupportGuidelines.findResidualEnglish(source, 'El depósito mínimo es $50 y tus fondos se acreditan a tu saldo Live.', 'es'), '');
  // Portuguese and Arabic keep their previous behaviour: this rule does not apply.
  assert.strictEqual(SupportGuidelines.findResidualEnglish(source, source, 'pt'), '');
  assert.strictEqual(SupportGuidelines.findResidualEnglish(source, source, 'ar'), '');
  // Short strings are never analysed (no false positives on one-word replies).
  assert.strictEqual(SupportGuidelines.findResidualEnglish('Minimum deposit', 'Minimum deposit', 'es'), '');
});

test('E3. a Latin "Chinese" translation is withheld and the customer gets the zh fallback', async () => {
  const model = makeTranslatingModel();
  model.setMode('latin-zh');
  const translator = makeTranslator(model);
  const h = createHarness({ language: 'zh', translator, supportAI: knowledgeAI(translator) });

  const outcome = await translator.fromEnglish('The minimum deposit is $50.', 'zh');
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'wrong-language');

  await h.say(MIN_DEPOSIT_QUESTION.zh);
  assert.strictEqual(h.last(), i18n.t('zh', 'uncertain'));
  assert.ok(!/This is English/.test(h.allText()), 'no English text reaches the customer');
});

test('E4. a HALF-translated es / fr / zh answer is withheld (fail closed), never presented as complete', async () => {
  for (const locale of ['es', 'fr', 'zh']) {
    const model = makeTranslatingModel();
    model.setMode('half');
    const translator = makeTranslator(model);
    const h = createHarness({ language: locale, translator, supportAI: knowledgeAI(translator) });

    const outcome = await translator.fromEnglish(
      'Your deposit was credited to your Live balance. You can now start trading with the bot.',
      locale
    );
    assert.strictEqual(outcome.ok, false, locale + ' partial translation must be withheld');
    assert.strictEqual(outcome.reason, 'partially-translated');

    await h.say(MIN_DEPOSIT_QUESTION[locale]);
    assert.strictEqual(h.last(), i18n.t(locale, 'uncertain'),
      locale + ' receives the localized fallback instead of a half-translated answer');
    assert.ok(!/You can now start trading/.test(h.allText()), 'no English tail reaches the customer');
  }
});

test('E5. an echoed translation is still rejected for every language (unchanged behaviour)', async () => {
  for (const locale of ['es', 'pt', 'fr', 'ar', 'zh']) {
    const model = makeTranslatingModel();
    model.setMode('untouched');
    const translator = makeTranslator(model);
    const outcome = await translator.fromEnglish('The minimum deposit is $50.', locale);
    assert.strictEqual(outcome.ok, false, locale + ' echo must be withheld');
    assert.strictEqual(outcome.reason, 'echo');
  }
});

test('E6b. the hard safety rules also work in es / fr / zh, and disclaimers still pass', () => {
  const mustFlag = [
    ['es', 'Garantizamos ganancias del 10% cada día.'],
    ['es', 'Envíe su contraseña para verificarla.'],
    ['es', 'Invierte sin riesgos.'],
    ['fr', 'Nous garantissons des profits de 10% par jour.'],
    ['fr', 'Envoyez votre mot de passe.'],
    ['fr', 'Aucun risque, vous ne perdrez jamais.'],
    ['zh', '我们保证盈利 10%。'],
    ['zh', '请发送您的密码。'],
    ['zh', '这项投资没有风险。']
  ];
  mustFlag.forEach(([locale, text]) => {
    assert.ok(SupportGuidelines.assertSafeAnswer(text, { language: locale }).length > 0,
      locale + ' must flag: ' + text);
  });

  // A DISCLAIMER is not a violation (negation-aware), and neither is a faithful
  // translation of an approved answer.
  const mustPass = [
    ['es', 'No garantizamos ganancias.'],
    ['es', 'No podemos garantizar beneficios.'],
    ['es', 'Los retiros se procesan en 15-30 minutos.'],
    ['es', 'El depósito mínimo es $50.'],
    ['es', 'El trading conlleva riesgo de pérdida.'],
    ['fr', 'Nous ne garantissons pas de profits.'],
    ['fr', 'Les retraits sont traités sous 15 à 30 minutes.'],
    ['fr', 'Le trading comporte un risque de perte.'],
    ['zh', '我们不保证盈利。'],
    ['zh', '提现会在 15-30 分钟内处理。'],
    ['zh', '交易存在亏损风险。']
  ];
  mustPass.forEach(([locale, text]) => {
    assert.deepStrictEqual(SupportGuidelines.assertSafeAnswer(text, { language: locale }), [],
      locale + ' must pass: ' + text);
  });

  // Portuguese and Arabic keep their own rules (unchanged by this release).
  assert.ok(SupportGuidelines.assertSafeAnswer('Lucros garantidos de 10% ao dia.', { language: 'pt' }).length > 0);
  assert.ok(SupportGuidelines.assertSafeAnswer('أرباح مضمونة 10% يوميا', { language: 'ar' }).length > 0);
});

test('E6c. a MODEL answer that is really the English text is not presented as a translation', async () => {
  const APPROVED = 'The minimum deposit is $50. Deposits are credited to your Live balance.';
  const modelAI = (language) => createSupportAIService({
    config: { enabled: true, provider: 'openai', apiKey: 'x', model: 'm', maxAnswerChars: 2000, minScore: 2, timeoutMs: 1000 },
    provider: { name: 'openai', generate: async () => ({ text: APPROVED, provider: 'openai' }) }
  });

  for (const locale of ['es', 'fr']) {
    const outcome = await modelAI(locale).ask('What is the minimum deposit?', { language: locale });
    assert.strictEqual(outcome.modelGenerated, false,
      locale + ': an echoed English answer must not keep model-generated provenance');
    assert.strictEqual(outcome.source, 'knowledge',
      locale + ': the approved text is returned instead, so the caller can translate it');
  }

  // Portuguese and Arabic keep their previous behaviour (unchanged by this release).
  const pt = await modelAI('pt').ask('What is the minimum deposit?', { language: 'pt' });
  assert.strictEqual(pt.modelGenerated, true);
  const en = await modelAI('en').ask('What is the minimum deposit?', { language: 'en' });
  assert.strictEqual(en.modelGenerated, true);
});

test('E6. the descriptor reports how each language is verified (observability)', () => {
  const model = makeTranslatingModel();
  const described = makeTranslator(model).describe();
  assert.deepStrictEqual(described.languages, ['en', 'es', 'pt', 'fr', 'ar', 'zh']);
  assert.deepStrictEqual(described.languageChecks.script, ['ar', 'zh']);
  assert.deepStrictEqual(described.languageChecks.residualEnglish, ['es', 'fr', 'zh']);
});

// ============================================================================
// F. The knowledge provider remains the only answer source
// ============================================================================

test('F1. a question with no approved answer escalates instead of inventing one', async () => {
  const QUESTION = 'Quelle est la couleur préférée du fondateur ?';

  // (a) The AI layer itself: nothing approved, nothing invented.
  const ai = createSupportAIService({
    config: resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'knowledge' })
  });
  const outcome = await ai.ask(QUESTION, { language: 'fr' });
  assert.strictEqual(outcome.kind, 'unknown', 'no approved entry exists');
  assert.strictEqual(outcome.answer, SupportGuidelines.UNCERTAIN_TEXT, 'the approved fallback, not an invention');
  assert.strictEqual(outcome.modelGenerated, false, 'nothing was model-generated');

  // (b) Through the bot (AI on, no translation layer): the customer gets a
  // localized French reply, and never an English or invented answer.
  const h = createHarness({ language: 'fr', translator: null, supportAI: ai });
  await h.say(QUESTION);
  const reply = h.last();
  assert.ok(reply && reply.trim().length > 0);
  assert.ok([i18n.t('fr', 'uncertain'), i18n.t('fr', 'clarifyTopic')].indexOf(reply) > -1,
    'a localized fallback or clarifying question, got: ' + reply);
  // The operator is told a human is needed.
  assert.ok(h.toAdmin().some((text) => /HUMAN NEEDED|HUMAN REQUESTED/.test(text)), 'operators are notified');
});

test('F2. the approved English answer is the only translation source (no model-authored facts)', async () => {
  const model = makeTranslatingModel();
  const translator = makeTranslator(model);
  const ai = knowledgeAI(translator);

  const outcome = await ai.ask(MIN_DEPOSIT_QUESTION.es, { language: 'es' });
  assert.strictEqual(outcome.source, 'knowledge', 'the knowledge provider answered');
  assert.strictEqual(outcome.modelGenerated, false);
  assert.strictEqual(outcome.entryId, 'deposits.minimum');
  assert.ok(outcome.answer && outcome.answer.length > 0);
});

// ============================================================================
// G. Preservation: English / Portuguese / Arabic
// ============================================================================

test('G1. English, Portuguese and Arabic keep their payloads, help and script', async () => {
  for (const locale of ['en', 'pt', 'ar']) {
    const h = createHarness({ language: locale });
    await h.command('/help');
    assert.strictEqual(h.toCustomer().pop().text, i18n.t(locale, 'help'));
    assert.ok(i18n.languageKeyboard().inline_keyboard.flat()
      .some((b) => b.callback_data === 'lang:' + locale), locale + ' stays selectable');
  }
  assert.ok(SupportGuidelines.isArabicScript(i18n.t('ar', 'help')));
  assert.ok(!SupportGuidelines.isCjkScript(i18n.t('ar', 'help')));
  assert.ok(!SupportGuidelines.isArabicScript(i18n.t('en', 'help')));
});

test('G2. the six-locale dictionary is complete and small (one source of truth)', () => {
  const locales = Object.keys(i18n.CUSTOMER_STRINGS);
  assert.deepStrictEqual(locales.sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
  const keys = Object.keys(i18n.CUSTOMER_STRINGS.en).sort();
  assert.ok(keys.length >= 15 && keys.length < 150, 'a small Telegram-specific dictionary, got ' + keys.length);

  const placeholders = (text) => (text.match(/\{\{[a-zA-Z]+\}\}/g) || []).sort();
  locales.forEach((locale) => {
    assert.deepStrictEqual(Object.keys(i18n.CUSTOMER_STRINGS[locale]).sort(), keys, locale + ' key set');
    keys.forEach((key) => {
      const value = i18n.CUSTOMER_STRINGS[locale][key];
      assert.strictEqual(typeof value, 'string', locale + '.' + key);
      assert.ok(value.trim().length > 0, locale + '.' + key + ' must not be empty');
      assert.deepStrictEqual(placeholders(value), placeholders(i18n.CUSTOMER_STRINGS.en[key]),
        locale + '.' + key + ' placeholder mismatch');
    });
    // Commands are never translated.
    assert.ok(i18n.CUSTOMER_STRINGS[locale].help.indexOf('/language') > -1, locale + ' help mentions /language');
  });
});

// ============================================================================
// H. Migration 060 (the store must accept the new codes)
// ============================================================================

test('H1. migration 060 widens the vocabulary to six and rewrites no data', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '060_telegram_support_language_six.sql'), 'utf8');
  const body = sql.replace(/^\s*--.*$/gm, '');

  assert.match(sql, /CHECK \(language IN \('en', 'es', 'pt', 'fr', 'ar', 'zh'\)\)/);
  // The three-language vocabulary survives only in the documented ROLLBACK
  // comment, never in executable SQL.
  assert.ok(!/CHECK \(language IN \('en', 'pt', 'ar'\)\)/.test(body), 'the three-language vocabulary is gone');
  // Additive and idempotent.
  assert.ok(/DROP CONSTRAINT IF EXISTS telegram_support_conversations_language_check/.test(sql));
  assert.ok(/ADD CONSTRAINT telegram_support_conversations_language_check/.test(sql));
  // No data rewrite of any kind.
  assert.ok(!/\bUPDATE\s+public\.telegram_support_conversations\b/i.test(body), 'no UPDATE');
  assert.ok(!/\bINSERT\s+INTO\b/i.test(body), 'no INSERT');
  assert.ok(!/\bDELETE\s+FROM\b/i.test(body), 'no DELETE');
  assert.ok(!/\bTRUNCATE\b/i.test(body), 'no TRUNCATE');
  // The column default and NOT NULL are re-asserted, never removed.
  assert.ok(/ALTER COLUMN language SET DEFAULT 'en'/.test(sql));
  assert.ok(/ALTER COLUMN language SET NOT NULL/.test(sql));
  assert.ok(!/DROP DEFAULT/.test(sql));
  assert.ok(!/DROP NOT NULL/.test(sql));
  // A pre-flight refuses unsupported stored values instead of guessing, and the
  // self-check runs inside the transaction.
  assert.ok(/RAISE EXCEPTION/.test(sql));
  assert.ok(/v_bad_count/.test(sql));
  assert.ok(/^BEGIN;/m.test(sql) && /^COMMIT;/m.test(sql));
  // No money object is involved.
  assert.ok(!/\bwallets?\b/i.test(body));
  assert.ok(!/\btransactions?\b/i.test(body));
});

test('H2. migration 032 (which created the column) is untouched and still correct', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '032_telegram_support_language.sql'), 'utf8');
  assert.ok(/language\s+TEXT\s+NOT NULL\s+DEFAULT\s+'en'/i.test(sql), 'the column shape is unchanged');
});
