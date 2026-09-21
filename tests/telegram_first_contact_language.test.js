'use strict';

/**
 * First-contact language selection on /start.
 *
 * A brand-new Telegram customer must be able to choose a language WITHOUT knowing
 * /language: /start answers with a tri-lingual welcome plus the EXISTING language
 * keyboard, and no English support/AI content is sent before the choice. The
 * selection is persisted by the very same callback handler /language uses, so
 * there is no second language-selection system.
 *
 * A RETURNING customer is untouched: /start does not repeat the picker, never
 * resets the stored language, and keeps answering with the localized help;
 * /language remains available to change it.
 *
 * The real service, the real routing and the real i18n dictionary run under test;
 * only the store and the Telegram transport are doubles (no network).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  createTelegramSupportBot,
  FIRST_CONTACT_TEXT,
  USER_HELP_TEXT
} = require('../services/TelegramSupportService');
const i18n = require('../services/telegram-i18n');

const TOKEN = '123456:TEST-BOT-TOKEN';
const SECRET = 'test-webhook-secret';
const GROUP_ID = '-100777';
const ADMIN_ID = '6054625818';
const CUSTOMER_CHAT_ID = '4242';
const CUSTOMER_ID = Number(CUSTOMER_CHAT_ID);

const CUSTOMER_FROM = { id: CUSTOMER_ID, is_bot: false, first_name: 'Ana', username: 'ana' };
const BOT_FROM = { id: 777000, is_bot: true, first_name: 'Arbitrix Support', username: 'ArbitrixSupportBot' };

let updateSeq = 3000;
const nextUpdateId = () => ++updateSeq;

// ------------------------------------------------------------------ doubles ---

/** Mirrors TelegramSupportStore's contract, `created` included. */
function createMemoryStore({ fail = false } = {}) {
  const conversations = [];
  const languageWrites = [];
  const messages = [];
  let nextId = 1;
  const unavailable = async () => { throw new Error('storage unavailable (simulated)'); };

  if (fail) {
    return {
      conversations, languageWrites, messages,
      getConversationByChatId: unavailable,
      getConversationById: unavailable,
      upsertConversation: unavailable,
      setConversationLanguage: unavailable,
      insertMessage: unavailable,
      getLatestMessageByConversation: unavailable,
      createEscalation: unavailable,
      setConversationStatus: unavailable,
      probeColumns: unavailable
    };
  }

  const store = {
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
      const existing = await store.getConversationByChatId(chatId);
      if (existing) {
        Object.assign(existing, {
          username: username === undefined ? null : username,
          display_name: displayName === undefined ? null : displayName
        });
        return { conversation: existing, created: false };
      }
      // The real column is TEXT NOT NULL DEFAULT 'en' with CHECK (en/pt/ar).
      const row = {
        id: nextId++,
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
  return store;
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

function createHarness({ language = null, failStore = false } = {}) {
  const store = createMemoryStore({ fail: failStore });
  if (language !== null) {
    // A returning customer: the conversation already exists with a stored language.
    store.conversations.push({
      id: 99,
      telegram_chat_id: CUSTOMER_ID,
      telegram_user_id: CUSTOMER_ID,
      username: 'ana',
      display_name: 'Ana',
      language,
      status: 'open'
    });
  }
  const transport = createTransport();
  const lines = [];
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
    logger: { log() {}, warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) }
  });

  const toCustomer = () => transport.calls.filter((c) => c.method === 'sendMessage' && c.chatId === CUSTOMER_CHAT_ID);
  const toAdmin = () => transport.calls
    .filter((c) => c.method === 'sendMessage' && c.chatId === ADMIN_ID)
    .map((c) => c.text);
  const callbackAnswers = () => transport.calls.filter((c) => c.method === 'answerCallbackQuery');

  return {
    bot,
    store,
    transport,
    lines,
    toCustomer,
    toAdmin,
    callbackAnswers,
    lastName: () => (store.conversations[0] ? store.conversations[0].language : null),
    start: () => bot.handleUpdate({
      update_id: nextUpdateId(),
      message: {
        message_id: nextUpdateId(), date: 1700000000, text: '/start',
        chat: { id: CUSTOMER_ID, type: 'private' }, from: CUSTOMER_FROM
      }
    }),
    command: (text) => bot.handleUpdate({
      update_id: nextUpdateId(),
      message: {
        message_id: nextUpdateId(), date: 1700000000, text,
        chat: { id: CUSTOMER_ID, type: 'private' }, from: CUSTOMER_FROM
      }
    }),
    say: (text) => bot.handleUpdate({
      update_id: nextUpdateId(),
      message: {
        message_id: nextUpdateId(), date: 1700000000, text,
        chat: { id: CUSTOMER_ID, type: 'private' }, from: CUSTOMER_FROM
      }
    }),
    press: (data) => bot.handleUpdate({
      update_id: nextUpdateId(),
      callback_query: {
        id: 'cb-' + nextUpdateId(),
        from: CUSTOMER_FROM,
        chat_instance: 'chat-instance',
        data,
        // The keyboard lives on the BOT's own message.
        message: {
          message_id: 5150, date: 1700000000,
          chat: { id: CUSTOMER_ID, type: 'private' }, from: BOT_FROM
        }
      }
    })
  };
}

const buttonsOf = (replyMarkup) => replyMarkup.inline_keyboard.flat();

/** Every NEW-customer flow must begin with the first-contact picker. */
function assertPickerFirst(h) {
  const first = h.toCustomer()[0];
  assert.ok(first, 'the customer was answered');
  assert.strictEqual(first.text, FIRST_CONTACT_TEXT, 'the first-contact picker is shown first');
  assert.deepStrictEqual(first.replyMarkup, i18n.languageKeyboard());
}

// ---------------------------------------------------------------------------
// 1. A new customer: /start shows the picker, and nothing else
// ---------------------------------------------------------------------------

test('new customer /start shows the welcome and the existing language picker', async () => {
  const h = createHarness();

  const result = await h.start();

  assert.strictEqual(result.action, 'start-language-picker');
  const replies = h.toCustomer();
  assert.strictEqual(replies.length, 1, 'exactly one message: the picker, no support/AI content');
  assert.strictEqual(replies[0].text, FIRST_CONTACT_TEXT);
  assert.deepStrictEqual(replies[0].text.split('\n'), [
    'Welcome to Arbitrix Support 👋',
    'Choose your preferred language:',
    'Escolha seu idioma / اختر لغتك'
  ]);
});

test('the picker reuses the ONE existing language keyboard (no second system)', async () => {
  const h = createHarness();

  await h.start();

  const sent = h.toCustomer()[0];
  // Byte-identical to the keyboard /language sends: same builder, same callbacks.
  assert.deepStrictEqual(sent.replyMarkup, i18n.languageKeyboard());
  // The EXISTING labels, unchanged (native names, no flag emojis). Flags would
  // change the shared keyboard and therefore /language as well.
  assert.deepStrictEqual(buttonsOf(sent.replyMarkup).map((b) => b.text), ['English', 'Português', 'العربية']);
  assert.deepStrictEqual(buttonsOf(sent.replyMarkup).map((b) => b.text),
    buttonsOf(i18n.languageKeyboard()).map((b) => b.text));
  assert.deepStrictEqual(buttonsOf(sent.replyMarkup).map((b) => b.callback_data),
    ['lang:en', 'lang:pt', 'lang:ar']);
});

test('new customer /start writes NO language (the choice belongs to the callback)', async () => {
  const h = createHarness();

  await h.start();

  assertPickerFirst(h);
  assert.deepStrictEqual(h.store.languageWrites, [], 'the command never persists a language');
  assert.strictEqual(h.lastName(), 'en', 'the row exists via the column default only');
  assert.strictEqual(h.store.conversations.length, 1, 'the conversation was created for bookkeeping');
});

// ---------------------------------------------------------------------------
// 2-4. Returning customers keep their language (never reset, picker not repeated)
// ---------------------------------------------------------------------------

for (const language of ['en', 'pt', 'ar']) {
  test(`existing ${language} customer /start keeps ${language} and answers in it`, async () => {
    const h = createHarness({ language });

    const result = await h.start();

    assert.strictEqual(result.action, 'help', 'no picker for a returning customer');
    assert.deepStrictEqual(h.store.languageWrites, [], 'the stored language is never reset');
    assert.strictEqual(h.lastName(), language, 'the stored language is unchanged');
    const replies = h.toCustomer();
    assert.strictEqual(replies.length, 1);
    assert.strictEqual(replies[0].text, i18n.t(language, 'help'));
    assert.notStrictEqual(replies[0].text, FIRST_CONTACT_TEXT);
    assert.strictEqual(replies[0].replyMarkup, null, 'no keyboard is re-sent');
  });
}

test('the localized help differs per language (the stored choice is really applied)', () => {
  const en = i18n.t('en', 'help');
  const pt = i18n.t('pt', 'help');
  const ar = i18n.t('ar', 'help');
  assert.strictEqual(en, USER_HELP_TEXT);
  assert.notStrictEqual(pt, en);
  assert.notStrictEqual(ar, en);
  assert.notStrictEqual(ar, pt);
});

// ---------------------------------------------------------------------------
// 5-6. A new customer choosing a language through the picker
// ---------------------------------------------------------------------------

test('new customer selecting Portuguese persists pt and confirms in Portuguese', async () => {
  const h = createHarness();
  await h.start();
  assertPickerFirst(h);

  const result = await h.press('lang:pt');

  assert.strictEqual(result.action, 'language');
  assert.strictEqual(result.language, 'pt');
  assert.deepStrictEqual(h.store.languageWrites, [{ conversationId: 1, language: 'pt' }]);
  assert.strictEqual(h.lastName(), 'pt');
  assert.deepStrictEqual(h.callbackAnswers().map((c) => c.text), [i18n.t('pt', 'languageSet')]);
  assert.deepStrictEqual(h.toCustomer().slice(1).map((c) => c.text), [i18n.t('pt', 'languageSet')]);
});

test('new customer selecting Arabic persists ar and confirms in Arabic', async () => {
  const h = createHarness();
  await h.start();
  assertPickerFirst(h);

  const result = await h.press('lang:ar');

  assert.strictEqual(result.language, 'ar');
  assert.deepStrictEqual(h.store.languageWrites, [{ conversationId: 1, language: 'ar' }]);
  assert.strictEqual(h.lastName(), 'ar');
  assert.deepStrictEqual(h.callbackAnswers().map((c) => c.text), [i18n.t('ar', 'languageSet')]);
});

test('after choosing, support continues in the chosen language (no English answer)', async () => {
  for (const [code, marker] of [['pt', 'Obrigado'], ['ar', 'شكرًا'], ['en', 'Thanks']]) {
    const h = createHarness();
    await h.start();
    assertPickerFirst(h);
    await h.press('lang:' + code);

    await h.say('Olá, precisa de ajuda');

    const last = h.toCustomer().pop();
    assert.strictEqual(last.text, i18n.t(code, 'acknowledgement'));
    assert.match(last.text, new RegExp(marker), `${code}: the reply uses ${code}`);
  }
});

// ---------------------------------------------------------------------------
// 7. /language is unchanged
// ---------------------------------------------------------------------------

test('/language still sends the localized prompt with the same keyboard', async () => {
  const h = createHarness({ language: 'pt' });

  const result = await h.command('/language');

  assert.strictEqual(result.action, 'language');
  assert.deepStrictEqual(h.store.languageWrites, [], 'showing the picker writes nothing');
  const sent = h.toCustomer().pop();
  assert.strictEqual(sent.text, i18n.t('pt', 'languagePrompt'), 'the localized prompt, not the welcome');
  assert.notStrictEqual(sent.text, FIRST_CONTACT_TEXT);
  assert.deepStrictEqual(sent.replyMarkup, i18n.languageKeyboard());
});

test('/language can still change an existing choice (en -> pt -> en)', async () => {
  const h = createHarness({ language: 'en' });

  await h.command('/language');
  await h.press('lang:pt');
  assert.strictEqual(h.lastName(), 'pt');

  await h.command('/language');
  await h.press('lang:en');
  assert.strictEqual(h.lastName(), 'en');
  assert.deepStrictEqual(h.store.languageWrites,
    [{ conversationId: 99, language: 'pt' }, { conversationId: 99, language: 'en' }]);
});

// ---------------------------------------------------------------------------
// 8. Admin notifications are unchanged
// ---------------------------------------------------------------------------

test('admin notification reports the language chosen at first contact', async () => {
  const h = createHarness();
  await h.start();
  assertPickerFirst(h);
  await h.press('lang:pt');

  await h.say('Meu depósito não chegou');

  const notice = h.toAdmin().pop();
  assert.ok(notice, 'the operator was notified');
  assert.ok(notice.includes('Language: Portuguese'), notice);
  assert.ok(!notice.includes('Language: English'));
  assert.ok(notice.includes('Meu depósito não chegou'), 'the original message is preserved');
});

test('admin notification still reports English for a customer who never chose', async () => {
  const h = createHarness();
  await h.start();

  await h.say('Hello support');

  assert.ok(h.toAdmin().pop().includes('Language: English'));
});

// ---------------------------------------------------------------------------
// Boundaries preserved
// ---------------------------------------------------------------------------

test('/help is unchanged (only /start gained the first-contact picker)', async () => {
  const h = createHarness();

  const result = await h.command('/help');

  assert.strictEqual(result.action, 'help');
  assert.strictEqual(h.toCustomer().pop().text, USER_HELP_TEXT);
});

test('a storage failure still answers /start with the help text (never silence)', async () => {
  const h = createHarness({ failStore: true });

  // Cannot know whether the conversation is new, so the pre-existing help reply is
  // the safe degradation - the customer is never left in silence.
  const result = await h.start();

  assert.strictEqual(result.action, 'help');
  assert.strictEqual(h.toCustomer().pop().text, USER_HELP_TEXT);
  assert.strictEqual(h.bot.getStats().storageFailures >= 1, true, 'the failure is recorded');
});

test('the first-contact text lives in the service and is not a per-language string', () => {
  const source = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'services', 'TelegramSupportService.js'), 'utf8');
  assert.match(source, /const FIRST_CONTACT_TEXT = \[/);
  assert.match(source, /Escolha seu idioma \/ اختر لغتك/);
  // No automatic detection was added: the picker is the only selector.
  assert.ok(!/detectLanguage|guessLanguage|navigator\.language/.test(source));
});
