"use strict";

/**
 * Optional deposit-tutorial delivery.
 *
 * The gate TELEGRAM_DEPOSIT_TUTORIAL_URL must keep every reply exactly as it is
 * today while it is unset, and add ONE video after the text answer only for a
 * deposit question when it is set. These tests drive the REAL bot with fakes for
 * transport/store/AI; no Telegram request is ever made.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const ENV_EXAMPLE = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

const {
  createTelegramSupportBot,
  resolveDepositTutorialUrl,
  isDepositAnswer
} = require('../services/TelegramSupportService');
const { t, TELEGRAM_LANGUAGES } = require('../services/telegram-i18n');
const getCustomerString = (language, key) => t(language, key);

const USER_CHAT_ID = '555000111';
const TOKEN = '123456:TEST-BOT-TOKEN';
const TUTORIAL_URL = 'https://arbitrix.pro/video/arbitrix-deposit-tutorial-en.mp4';

function createFakeStore() {
  const state = { conversations: [], messages: [], nextConversationId: 1, nextMessageId: 1 };
  const find = (chatId) => state.conversations.find((c) => String(c.telegram_chat_id) === String(chatId)) || null;
  return {
    state,
    async getConversationByChatId(chatId) { return find(chatId); },
    async getConversationById(id) { return state.conversations.find((c) => c.id === Number(id)) || null; },
    async upsertConversation({ chatId, telegramUserId, username, displayName }) {
      const existing = find(chatId);
      if (existing) return { conversation: existing, created: false };
      const conversation = {
        id: state.nextConversationId++,
        telegram_chat_id: Number(chatId),
        telegram_user_id: telegramUserId,
        username,
        display_name: displayName,
        mode: 'support',
        status: 'open',
        language: 'en',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      state.conversations.push(conversation);
      return { conversation, created: true };
    },
    async insertMessage({ conversationId, direction, body }) {
      const row = { id: state.nextMessageId++, conversation_id: Number(conversationId), direction, body };
      state.messages.push(row);
      return row;
    },
    async getLatestMessageByConversation(conversationId) {
      const rows = state.messages.filter((m) => m.conversation_id === Number(conversationId));
      return rows.length ? rows[rows.length - 1] : null;
    },
    async setConversationStatus(conversationId, status) {
      const c = state.conversations.find((x) => x.id === Number(conversationId));
      if (c) c.status = status;
      return c || null;
    },
    async setConversationLanguage() { return null; },
    async createEscalation({ conversationId }) {
      return { id: 1, conversation_id: Number(conversationId), created_at: new Date().toISOString() };
    }
  };
}

function createFakeTransport({ failVideo = false, withVideo = true } = {}) {
  const calls = [];
  let nextId = 900;
  const transport = {
    calls,
    async sendMessage(chatId, text, options) {
      const messageId = nextId++;
      calls.push({ method: 'sendMessage', chatId: String(chatId), text, options: options || null, messageId });
      return { message_id: messageId };
    },
    async setWebhook() { return true; },
    async getWebhookInfo() { return { url: '', pending_update_count: 0 }; }
  };
  if (withVideo) {
    transport.sendVideo = async (chatId, video, options) => {
      if (failVideo) throw new Error('Telegram sendVideo failed: simulated 400');
      const messageId = nextId++;
      calls.push({ method: 'sendVideo', chatId: String(chatId), video, options: options || null, messageId });
      return { message_id: messageId };
    };
  }
  return transport;
}

function createFakeAI(outcome) {
  return {
    isEnabled: () => true,
    async ask() { return outcome; }
  };
}

function createBot({ depositTutorialUrl, ai, transport } = {}) {
  const store = createFakeStore();
  const tx = transport || createFakeTransport();
  const bot = createTelegramSupportBot({
    config: { token: TOKEN, adminIds: [], supportChatId: '', notifyTarget: 'admins' },
    store,
    transport: tx,
    logger: { log() {}, warn() {}, error() {} },
    supportAI: ai,
    depositTutorialUrl
  });
  return { bot, store, transport: tx };
}

let seq = 5000;
function update(text = 'How do I deposit?') {
  return {
    update_id: seq++,
    message: {
      message_id: 1,
      chat: { id: Number(USER_CHAT_ID), type: 'private' },
      from: { id: Number(USER_CHAT_ID), first_name: 'Alice' },
      text
    }
  };
}

const DEPOSIT_ANSWER = {
  answer: 'The minimum deposit is $100. Open the deposit window and generate a payment address.',
  needsHuman: false,
  modelGenerated: false,
  entryId: 'deposits.minimum',
  category: 'deposits'
};

const WITHDRAWAL_ANSWER = {
  answer: 'Reply to this message and a support agent will check your withdrawal.',
  needsHuman: false,
  modelGenerated: false,
  entryId: 'withdrawals.timing',
  category: 'withdrawals'
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('the tutorial URL gate is disabled by default and rejects anything but https', () => {
  assert.deepStrictEqual(
    resolveDepositTutorialUrl(undefined),
    { url: null, enabled: false, reason: 'unset' }
  );
  assert.strictEqual(resolveDepositTutorialUrl('').enabled, false);
  assert.strictEqual(resolveDepositTutorialUrl('   ').enabled, false);
  assert.strictEqual(resolveDepositTutorialUrl('/video/arbitrix-deposit-tutorial-en.mp4').reason, 'invalid-url');
  assert.strictEqual(resolveDepositTutorialUrl('http://arbitrix.pro/video/x.mp4').reason, 'not-https');
  assert.strictEqual(resolveDepositTutorialUrl('javascript:alert(1)').enabled, false);
  assert.deepStrictEqual(
    resolveDepositTutorialUrl(TUTORIAL_URL),
    { url: TUTORIAL_URL, enabled: true, reason: null }
  );
});

test('only a deposit answer is recognised as deposit intent', () => {
  assert.strictEqual(isDepositAnswer(DEPOSIT_ANSWER), true);
  assert.strictEqual(isDepositAnswer({ entryId: 'deposits.how_to' }), true);
  assert.strictEqual(isDepositAnswer(WITHDRAWAL_ANSWER), false);
  assert.strictEqual(isDepositAnswer({ text: 'hi', confident: false }), false);
  assert.strictEqual(isDepositAnswer(null), false);
});

test('the environment variable is the only switch and it is absent from the example env', () => {
  assert.match(SERVER, /depositTutorialUrl: process\.env\.TELEGRAM_DEPOSIT_TUTORIAL_URL \|\| ''/);
  assert.match(ENV_EXAMPLE, /# TELEGRAM_DEPOSIT_TUTORIAL_URL=/, 'documented as a comment, not enabled');
});

// ---------------------------------------------------------------------------
// Disabled: behaviour identical to today
// ---------------------------------------------------------------------------

test('with the gate unset a deposit question gets the text answer and NO video', async () => {
  const { bot, transport } = createBot({ ai: createFakeAI(DEPOSIT_ANSWER) });
  await bot.handleUpdate(update());
  assert.strictEqual(transport.calls.filter((c) => c.method === 'sendVideo').length, 0);
  const texts = transport.calls.filter((c) => c.method === 'sendMessage');
  assert.strictEqual(texts.length, 1, 'exactly one text reply');
  assert.strictEqual(texts[0].text, DEPOSIT_ANSWER.answer);
});

test('the disabled reply is byte-identical to a bot with no tutorial option at all', async () => {
  const withUnset = createBot({ ai: createFakeAI(DEPOSIT_ANSWER), depositTutorialUrl: '' });
  const withoutOption = createBot({ ai: createFakeAI(DEPOSIT_ANSWER) });
  await withUnset.bot.handleUpdate(update('How do I deposit?'));
  await withoutOption.bot.handleUpdate(update('How do I deposit?'));
  const a = withUnset.transport.calls.map((c) => [c.method, c.text]);
  const b = withoutOption.transport.calls.map((c) => [c.method, c.text]);
  assert.deepStrictEqual(a, b);
});

test('a non-https value is treated as disabled, not as a broken send', async () => {
  const { bot, transport } = createBot({
    ai: createFakeAI(DEPOSIT_ANSWER),
    depositTutorialUrl: 'http://arbitrix.pro/video/draft.mp4'
  });
  await bot.handleUpdate(update());
  assert.strictEqual(transport.calls.filter((c) => c.method === 'sendVideo').length, 0);
  assert.strictEqual(transport.calls.filter((c) => c.method === 'sendMessage').length, 1);
});

// ---------------------------------------------------------------------------
// Enabled: text first, then exactly one video, only for deposits
// ---------------------------------------------------------------------------

test('an enabled tutorial adds ONE video AFTER the text answer for a deposit question', async () => {
  const { bot, transport } = createBot({
    ai: createFakeAI(DEPOSIT_ANSWER),
    depositTutorialUrl: TUTORIAL_URL
  });
  await bot.handleUpdate(update('What is the minimum deposit?'));

  const methods = transport.calls.map((c) => c.method);
  assert.deepStrictEqual(methods, ['sendMessage', 'sendVideo'], 'text first, then the video');

  const text = transport.calls[0];
  assert.strictEqual(text.text, DEPOSIT_ANSWER.answer, 'the existing text guidance is preserved verbatim');

  const video = transport.calls[1];
  assert.strictEqual(video.chatId, USER_CHAT_ID);
  assert.strictEqual(video.video, TUTORIAL_URL);
  assert.strictEqual(video.options.caption, getCustomerString('en', 'tutorialCaption'));
});

test('a non-deposit question never receives the video', async () => {
  const { bot, transport } = createBot({
    ai: createFakeAI(WITHDRAWAL_ANSWER),
    depositTutorialUrl: TUTORIAL_URL
  });
  await bot.handleUpdate(update('How long does a withdrawal take?'));
  assert.strictEqual(transport.calls.filter((c) => c.method === 'sendVideo').length, 0);
  assert.strictEqual(transport.calls.filter((c) => c.method === 'sendMessage').length, 1);
});

test('a deposit question is answered once: no duplicate video on a redelivered update', async () => {
  const { bot, transport } = createBot({
    ai: createFakeAI(DEPOSIT_ANSWER),
    depositTutorialUrl: TUTORIAL_URL
  });
  const duplicated = update('How do I deposit?');
  duplicated.update_id = 777001;
  await bot.handleUpdate(duplicated);
  await bot.handleUpdate(duplicated);
  assert.strictEqual(transport.calls.filter((c) => c.method === 'sendVideo').length, 1);
  assert.strictEqual(transport.calls.filter((c) => c.method === 'sendMessage').length, 1);
});

test('a failing video does not fail the update and does not resend the text', async () => {
  const transport = createFakeTransport({ failVideo: true });
  const { bot } = createBot({
    ai: createFakeAI(DEPOSIT_ANSWER),
    depositTutorialUrl: TUTORIAL_URL,
    transport
  });
  const result = await bot.handleUpdate(update());
  assert.ok(result && result.handled, 'the update is still handled');
  assert.strictEqual(transport.calls.filter((c) => c.method === 'sendMessage').length, 1);
  assert.strictEqual(transport.calls.filter((c) => c.method === 'sendVideo').length, 0);
});

test('a transport without sendVideo is tolerated', async () => {
  const transport = createFakeTransport({ withVideo: false });
  const { bot } = createBot({
    ai: createFakeAI(DEPOSIT_ANSWER),
    depositTutorialUrl: TUTORIAL_URL,
    transport
  });
  const result = await bot.handleUpdate(update());
  assert.ok(result && result.handled);
  assert.strictEqual(transport.calls.filter((c) => c.method === 'sendMessage').length, 1);
});

test('with AI off the standard acknowledgement is unchanged and no video is sent', async () => {
  const disabledAI = { isEnabled: () => false, ask: async () => { throw new Error('should not be called'); } };
  const { bot, transport } = createBot({
    ai: disabledAI,
    depositTutorialUrl: TUTORIAL_URL
  });
  await bot.handleUpdate(update('How do I deposit?'));
  assert.strictEqual(transport.calls.filter((c) => c.method === 'sendVideo').length, 0);
  assert.strictEqual(transport.calls.filter((c) => c.method === 'sendMessage').length, 1);
});

test('the draft video is not published and no production URL is configured', () => {
  const publicVideo = path.join(ROOT, 'public', 'video');
  const assets = fs.readdirSync(publicVideo);
  assert.strictEqual(
    assets.filter((f) => f.indexOf('deposit-tutorial') !== -1).length, 0,
    'the draft must not be copied into public/video'
  );
  assert.ok(!/TELEGRAM_DEPOSIT_TUTORIAL_URL\s*=\s*\S/.test(ENV_EXAMPLE.replace(/^#.*$/gm, '')),
    'the example env must not enable the gate');
});

test('the localized caption exists in every supported language and makes no claims', () => {
  for (const language of TELEGRAM_LANGUAGES) {
    const caption = getCustomerString(language, 'tutorialCaption');
    assert.ok(caption && caption.length > 10, 'caption for ' + language);
    assert.ok(!/\$\s?700|\b700\b/.test(caption), 'no withdrawal minimum');
    assert.ok(!/guarantee|profit|risk-free|risk free/i.test(caption), 'no marketing claim');
  }
  const ptCaption = getCustomerString('pt', 'tutorialCaption');
  assert.notStrictEqual(ptCaption, getCustomerString('en', 'tutorialCaption'), 'Portuguese is localized');
  assert.ok(ptCaption.indexOf('dep\u00f3sito') !== -1, 'Portuguese uses its own wording');
  assert.notStrictEqual(getCustomerString('ar', 'tutorialCaption'), getCustomerString('en', 'tutorialCaption'));
});
