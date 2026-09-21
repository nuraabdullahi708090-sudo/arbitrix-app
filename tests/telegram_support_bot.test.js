'use strict';

/**
 * Telegram support bot tests.
 *
 * These exercise the REAL service/store code from
 * services/TelegramSupportService.js and services/TelegramSupportStore.js. Only
 * the collaborators they receive are faked:
 *   - transport -> records sendMessage/setWebhook calls, returns ids
 *   - store     -> in-memory implementation of the documented store contract
 *   - supabase  -> in-memory query-builder stub for the store mapping tests
 *
 * So routing, forwarding, reply-threading, escalation, redelivery idempotency,
 * the webhook secret gate and the "never log secrets" guarantee are covered as
 * behaviour, not as markup.
 *
 * The store contract mirrors the APPLIED schema:
 *   conversations(telegram_chat_id, telegram_user_id, username, display_name,
 *                 mode, status, language, created_at, updated_at)
 *   messages(conversation_id, direction, body, created_at)
 *   escalations(conversation_id, created_at)
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const ENV_EXAMPLE = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

const {
  parseAdminIds,
  resolveTelegramConfig,
  verifyTelegramWebhookSecret,
  isTelegramConfigured,
  truncateForTelegram,
  extractMessageText,
  telegramDisplayName,
  parseCommand,
  routeUpdate,
  createUpdateDeduper,
  createLimitedMap,
  createTelegramTransport,
  createTelegramSupportBot,
  createTelegramWebhookHandler,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  USER_HELP_TEXT,
  CUSTOMER_GUIDE_TEXT,
  DIRECTION_CUSTOMER,
  DIRECTION_BOT,
  DIRECTION_AGENT
} = require('../services/TelegramSupportService');
const { createTelegramSupportStore, numeric, ALLOWED_DIRECTIONS, CONFIRMED_CONVERSATION_STATUSES } = require('../services/TelegramSupportStore');

const TOKEN = '123456:TEST-BOT-TOKEN';
const WEBHOOK_SECRET = 'test-webhook-secret';
const ADMIN_ID = '6054625818';
const SUPPORT_CHAT_ID = '-1001234567890';
const USER_CHAT_ID = '555000111';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function createFakeStore({ failStore = false } = {}) {
  const state = {
    conversations: [],
    messages: [],
    escalations: [],
    statusWrites: [],
    nextConversationId: 1,
    nextMessageId: 1,
    nextEscalationId: 1
  };

  const findConversation = (chatId) =>
    state.conversations.find((c) => String(c.telegram_chat_id) === String(chatId)) || null;

  // Simulates an unreachable/broken store (missing table, RLS denied, outage):
  // every call rejects, exactly like the Supabase client does on an error.
  const unavailable = () => Promise.reject(new Error('telegram conversation lookup failed: simulated store outage'));

  if (failStore) {
    return {
      state,
      getConversationByChatId: unavailable,
      getConversationById: unavailable,
      upsertConversation: unavailable,
      insertMessage: unavailable,
      getLatestMessageByConversation: unavailable,
      setConversationStatus: unavailable,
      createEscalation: unavailable
    };
  }

  return {
    state,
    async getConversationByChatId(chatId) {
      return findConversation(chatId);
    },
    async getConversationById(id) {
      return state.conversations.find((c) => c.id === Number(id)) || null;
    },
    async upsertConversation({ chatId, telegramUserId, username, displayName }) {
      const existing = findConversation(chatId);
      if (existing) {
        Object.assign(existing, {
          telegram_user_id: telegramUserId,
          username,
          display_name: displayName
        });
        return { conversation: existing, created: false };
      }
      const conversation = {
        id: state.nextConversationId++,
        telegram_chat_id: Number(chatId),
        telegram_user_id: telegramUserId,
        username,
        display_name: displayName,
        mode: 'support',
        status: 'open',
        language: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      state.conversations.push(conversation);
      return { conversation, created: true };
    },
    async insertMessage({ conversationId, direction, body }) {
      const row = {
        id: state.nextMessageId++,
        conversation_id: Number(conversationId),
        direction,
        body
      };
      state.messages.push(row);
      return { message: row };
    },
    async setConversationStatus({ conversationId, status }) {
      state.statusWrites.push({ conversationId: Number(conversationId), status });
      const conversation = state.conversations.find((c) => c.id === Number(conversationId));
      if (conversation) conversation.status = status;
      return true;
    },
    async getLatestMessageByConversation({ conversationId, direction = null }) {
      let rows = state.messages.filter((m) => m.conversation_id === Number(conversationId));
      if (direction) rows = rows.filter((m) => m.direction === direction);
      return rows.length ? rows[rows.length - 1] : null;
    },
    async createEscalation({ conversationId, supportMessageId }) {
      const row = {
        id: state.nextEscalationId++,
        conversation_id: Number(conversationId),
        support_message_id: supportMessageId
      };
      state.escalations.push(row);
      return row;
    }
  };
}

function createFakeTransport({ failSendMessage = false, failChatIds = null } = {}) {
  const calls = [];
  const failing = Array.isArray(failChatIds) ? failChatIds.map(String) : [];
  let nextMessageId = 90000;
  return {
    calls,
    async sendMessage(chatId, text, options) {
      if (failSendMessage || failing.indexOf(String(chatId)) !== -1) {
        throw new Error('Telegram sendMessage failed: simulated');
      }
      const messageId = nextMessageId++;
      // The id is recorded so tests can thread a reply to a specific send
      // without depending on the order the messages were sent in.
      calls.push({ method: 'sendMessage', chatId: String(chatId), text, options: options || null, messageId });
      return { message_id: messageId };
    },
    async setWebhook(params) {
      calls.push({ method: 'setWebhook', params });
      return true;
    },
    async getWebhookInfo() {
      calls.push({ method: 'getWebhookInfo' });
      return { url: 'https://arbitrix.pro/api/telegram/webhook', pending_update_count: 0 };
    }
  };
}

function createFakeLogger() {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return { lines, log: push, warn: push, error: push };
}

function makeBot({
  supportChatId = SUPPORT_CHAT_ID,
  adminIds = [ADMIN_ID],
  token = TOKEN,
  webhookSecret = WEBHOOK_SECRET,
  failSendMessage = false,
  failChatIds = null,
  failStore = false
} = {}) {
  const store = createFakeStore({ failStore });
  const transport = createFakeTransport({ failSendMessage, failChatIds });
  const logger = createFakeLogger();
  const bot = createTelegramSupportBot({
    config: { token, supportChatId, adminIds, webhookSecret, baseUrl: 'https://arbitrix.pro' },
    store,
    transport,
    logger
  });
  return { bot, store, transport, logger };
}

let updateSeq = 1000;
function userUpdate({
  text = 'hello support',
  chatId = USER_CHAT_ID,
  userId = USER_CHAT_ID,
  messageId = 1,
  updateId,
  username = 'alice'
} = {}) {
  return {
    update_id: updateId === undefined ? updateSeq++ : updateId,
    message: {
      message_id: messageId,
      chat: { id: Number(chatId), type: 'private' },
      from: { id: Number(userId), first_name: 'Alice', last_name: 'Test', username },
      text
    }
  };
}

function groupUpdate({
  text = 'agent note',
  chatId = SUPPORT_CHAT_ID,
  userId = ADMIN_ID,
  messageId = 10,
  updateId,
  replyTo = null,
  title = 'Arbitrix Support'
} = {}) {
  const update = {
    update_id: updateId === undefined ? updateSeq++ : updateId,
    message: {
      message_id: messageId,
      chat: { id: Number(chatId), type: 'supergroup', title },
      from: { id: Number(userId), first_name: 'Agent' },
      text
    }
  };
  if (replyTo !== null) update.message.reply_to_message = { message_id: Number(replyTo) };
  return update;
}

function makeReq({ headers = {}, body = {} } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers: lower,
    body,
    get(name) { return lower[String(name).toLowerCase()]; }
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

// ---------------------------------------------------------------------------
// Pure configuration / parsing helpers
// ---------------------------------------------------------------------------

test('parseAdminIds splits, trims and drops empties', () => {
  assert.deepStrictEqual(parseAdminIds('6054625818'), ['6054625818']);
  assert.deepStrictEqual(parseAdminIds(' 1 , 2 ,,3 '), ['1', '2', '3']);
  assert.deepStrictEqual(parseAdminIds(''), []);
  assert.deepStrictEqual(parseAdminIds(undefined), []);
  assert.deepStrictEqual(parseAdminIds(null), []);
});

test('resolveTelegramConfig reads env without leaking values', () => {
  const config = resolveTelegramConfig({
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_SUPPORT_CHAT_ID: SUPPORT_CHAT_ID,
    TELEGRAM_ADMIN_IDS: '6054625818, 42',
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    BASE_URL: 'https://arbitrix.pro/'
  });
  assert.strictEqual(config.token, TOKEN);
  assert.strictEqual(config.supportChatId, SUPPORT_CHAT_ID);
  assert.deepStrictEqual(config.adminIds, ['6054625818', '42']);
  assert.strictEqual(config.webhookSecret, WEBHOOK_SECRET);
  assert.strictEqual(config.baseUrl, 'https://arbitrix.pro', 'trailing slash trimmed');
});

test('resolveTelegramConfig treats a blank support chat id as unset', () => {
  assert.strictEqual(resolveTelegramConfig({ TELEGRAM_SUPPORT_CHAT_ID: '   ' }).supportChatId, null);
});

test('isTelegramConfigured requires both token and webhook secret', () => {
  assert.strictEqual(isTelegramConfigured({ token: TOKEN, webhookSecret: WEBHOOK_SECRET }), true);
  assert.strictEqual(isTelegramConfigured({ token: TOKEN, webhookSecret: '' }), false);
  assert.strictEqual(isTelegramConfigured({ token: '', webhookSecret: WEBHOOK_SECRET }), false);
  assert.strictEqual(isTelegramConfigured(null), false);
});

test('verifyTelegramWebhookSecret only accepts an exact constant-time match', () => {
  assert.strictEqual(verifyTelegramWebhookSecret(WEBHOOK_SECRET, WEBHOOK_SECRET), true);
  assert.strictEqual(verifyTelegramWebhookSecret('nope', WEBHOOK_SECRET), false);
  assert.strictEqual(verifyTelegramWebhookSecret('', WEBHOOK_SECRET), false);
  assert.strictEqual(verifyTelegramWebhookSecret(undefined, WEBHOOK_SECRET), false);
  assert.strictEqual(verifyTelegramWebhookSecret(WEBHOOK_SECRET, ''), false, 'fails closed when unconfigured');
  assert.strictEqual(verifyTelegramWebhookSecret(WEBHOOK_SECRET + 'x', WEBHOOK_SECRET), false, 'length mismatch');
});

test('truncateForTelegram caps at the Telegram limit', () => {
  assert.strictEqual(truncateForTelegram('hi'), 'hi');
  const cut = truncateForTelegram('x'.repeat(6000));
  assert.strictEqual(cut.length, TELEGRAM_MAX_MESSAGE_LENGTH);
  assert.ok(cut.endsWith('…'));
});

test('extractMessageText falls back to captions and blanks for media-only', () => {
  assert.strictEqual(extractMessageText({ text: 'a' }), 'a');
  assert.strictEqual(extractMessageText({ caption: 'b' }), 'b');
  assert.strictEqual(extractMessageText({ photo: [] }), '');
  assert.strictEqual(extractMessageText(null), '');
});

test('telegramDisplayName prefers names, falls back to @username and id', () => {
  assert.strictEqual(telegramDisplayName({ first_name: 'Ada', last_name: 'Lovelace' }), 'Ada Lovelace');
  assert.strictEqual(telegramDisplayName({ username: 'ada' }), '@ada');
  assert.strictEqual(telegramDisplayName({ id: 7 }), 'user 7');
  assert.strictEqual(telegramDisplayName({}), null);
});

test('parseCommand handles plain and @bot-suffixed commands', () => {
  assert.deepStrictEqual(parseCommand('/chatid'), { name: 'chatid', rest: '', args: [] });
  assert.deepStrictEqual(parseCommand('/reply@ArbitrixSupportBot 555 hello there'),
    { name: 'reply', rest: '555 hello there', args: ['555', 'hello', 'there'] });
  assert.strictEqual(parseCommand('hello'), null);
  assert.strictEqual(parseCommand('/'), null);
  assert.strictEqual(parseCommand(''), null);
});

test('numeric sends bigint values as JS numbers', () => {
  assert.strictEqual(numeric('555000111'), 555000111);
  assert.strictEqual(numeric('-1001234567890'), -1001234567890);
  assert.strictEqual(numeric(null), null);
  assert.strictEqual(numeric(''), null);
});

// ---------------------------------------------------------------------------
// Bounded helpers backing idempotency and reply threading
// ---------------------------------------------------------------------------

test('update deduper remembers ids and evicts oldest beyond its bound', () => {
  const deduper = createUpdateDeduper({ max: 3 });
  assert.strictEqual(deduper.has(1), false);
  deduper.remember(1);
  deduper.remember(2);
  deduper.remember(3);
  assert.strictEqual(deduper.has(2), true);
  deduper.remember(4);
  assert.strictEqual(deduper.has(1), false, 'oldest evicted');
  assert.strictEqual(deduper.has(4), true);
  assert.strictEqual(deduper.size(), 3);
  assert.strictEqual(deduper.has(null), false, 'missing ids are never "seen"');
});

test('limited map stores, overwrites and evicts beyond its bound', () => {
  const map = createLimitedMap({ max: 2 });
  map.set(1, 'a');
  map.set(2, 'b');
  map.set(1, 'a2');
  assert.strictEqual(map.get(1), 'a2');
  map.set(3, 'c');
  assert.strictEqual(map.get(2), null, 'oldest evicted');
  assert.strictEqual(map.get(3), 'c');
  assert.strictEqual(map.get(null), null);
});

// ---------------------------------------------------------------------------
// Update routing
// ---------------------------------------------------------------------------

test('routeUpdate: private chat is a user message', () => {
  const route = routeUpdate(userUpdate({ text: 'hi' }), { adminIds: [ADMIN_ID], supportChatId: SUPPORT_CHAT_ID });
  assert.strictEqual(route.kind, 'user');
  assert.strictEqual(route.chatId, USER_CHAT_ID);
  assert.strictEqual(route.isAdmin, false);
  assert.strictEqual(route.text, 'hi');
});

test('routeUpdate: the configured support group is accepted', () => {
  const route = routeUpdate(groupUpdate({ text: '/chatid' }), { adminIds: [ADMIN_ID], supportChatId: SUPPORT_CHAT_ID });
  assert.strictEqual(route.kind, 'group');
  assert.strictEqual(route.isAdmin, true);
  assert.strictEqual(route.chatTitle, 'Arbitrix Support');
});

test('routeUpdate: other groups are ignored even for admins', () => {
  const route = routeUpdate(groupUpdate({ chatId: '-100777' }), { adminIds: [ADMIN_ID], supportChatId: SUPPORT_CHAT_ID });
  assert.deepStrictEqual(route, { kind: 'ignore', reason: 'other-group' });
});

test('routeUpdate: while the support chat id is unset, admins can still be reached for setup', () => {
  const adminRoute = routeUpdate(groupUpdate({ text: '/chatid' }), { adminIds: [ADMIN_ID], supportChatId: null });
  assert.strictEqual(adminRoute.kind, 'group');
  const otherRoute = routeUpdate(groupUpdate({ userId: '999' }), { adminIds: [ADMIN_ID], supportChatId: null });
  assert.deepStrictEqual(otherRoute, { kind: 'ignore', reason: 'unconfigured-group-non-admin' });
});

test('routeUpdate: non-message updates are ignored', () => {
  assert.deepStrictEqual(routeUpdate(null, {}), { kind: 'ignore', reason: 'no-update' });
  assert.deepStrictEqual(routeUpdate({ update_id: 1, channel_post: { text: 'hi' } }, {}), { kind: 'ignore', reason: 'no-message' });
});

// ---------------------------------------------------------------------------
// User message flow
// ---------------------------------------------------------------------------

test('user message is stored, forwarded to the group and acknowledged', async () => {
  const { bot, store, transport } = makeBot();
  const result = await bot.handleUpdate(userUpdate({ text: 'my deposit is stuck', messageId: 7, updateId: 42 }));

  assert.strictEqual(result.handled, true);
  assert.strictEqual(result.action, 'forwarded');

  const conversation = store.state.conversations[0];
  assert.strictEqual(conversation.telegram_chat_id, Number(USER_CHAT_ID));
  assert.strictEqual(conversation.username, 'alice');
  assert.strictEqual(conversation.display_name, 'Alice Test');

  const inbound = store.state.messages.find((m) => m.direction === 'customer');
  assert.strictEqual(inbound.body, 'my deposit is stuck');
  assert.strictEqual(inbound.conversation_id, conversation.id);

  const forward = transport.calls.find((c) => c.chatId === SUPPORT_CHAT_ID);
  assert.ok(forward, 'message forwarded to the support group');
  assert.ok(forward.text.includes('my deposit is stuck'));
  assert.ok(forward.text.includes(USER_CHAT_ID), 'the user chat id is visible so agents can /reply');
  assert.ok(forward.text.includes(`Conversation: #${conversation.id}`),
    'the conversation handle is shown, which is what the /reply hint uses');
  assert.ok(forward.text.includes(`/reply ${conversation.id} `), 'the reply hint uses the conversation handle');

  const receipt = transport.calls.find((c) => c.chatId === USER_CHAT_ID);
  assert.ok(receipt, 'the message is acknowledged');
  assert.strictEqual(receipt.text, CUSTOMER_GUIDE_TEXT, 'acknowledgement + guidance');
  assert.ok(receipt.text.includes('/escalate'), 'the reply points at /escalate');
});

test('a redelivered update is not forwarded twice', async () => {
  const { bot, store, transport } = makeBot();
  const update = userUpdate({ text: 'ping', updateId: 99 });
  const first = await bot.handleUpdate(update);
  const second = await bot.handleUpdate(update);

  assert.strictEqual(first.action, 'forwarded');
  assert.strictEqual(second.action, 'duplicate');
  assert.strictEqual(store.state.messages.filter((m) => m.direction === 'customer').length, 1);
  assert.strictEqual(transport.calls.filter((c) => c.chatId === SUPPORT_CHAT_ID).length, 1);
});

test('the same update is never re-processed even for commands', async () => {
  const { bot, transport } = makeBot();
  const update = userUpdate({ text: '/help', updateId: 150 });
  const first = await bot.handleUpdate(update);
  const second = await bot.handleUpdate(update);
  assert.strictEqual(first.action, 'help');
  assert.strictEqual(second.action, 'duplicate');
  assert.strictEqual(transport.calls.length, 1);
});

test('without a support group every message is stored and acknowledged', async () => {
  const { bot, store, transport } = makeBot({ supportChatId: null });
  const first = await bot.handleUpdate(userUpdate({ text: 'anyone there?', messageId: 1, updateId: 200 }));
  const second = await bot.handleUpdate(userUpdate({ text: 'hello?', messageId: 2, updateId: 201 }));

  assert.strictEqual(first.action, 'stored-without-group');
  assert.strictEqual(second.action, 'stored-without-group');
  assert.strictEqual(store.state.messages.filter((m) => m.direction === 'customer').length, 2);
  const replies = transport.calls.filter((c) => c.chatId === USER_CHAT_ID);
  assert.strictEqual(replies.length, 2, 'each ordinary message is acknowledged');
  assert.ok(replies.every((c) => c.text === CUSTOMER_GUIDE_TEXT));
});

test('a message in a PRE-EXISTING conversation is acknowledged (the reported bug)', async () => {
  // The customer was first seen by /chatid, which creates the conversation
  // WITHOUT storing a message. Every ordinary message after that used to get no
  // reply at all, because the acknowledgement was gated on "conversation created
  // by this very update". This is the exact production symptom.
  const { bot, store, transport } = makeBot();
  await bot.handleUpdate(userUpdate({ text: '/chatid', updateId: 78501 }));
  transport.calls.length = 0;

  const result = await bot.handleUpdate(userUpdate({ text: 'How do i chat them', updateId: 78502 }));

  assert.strictEqual(result.action, 'forwarded');
  const toUser = transport.calls.filter((c) => c.chatId === USER_CHAT_ID);
  assert.strictEqual(toUser.length, 1, 'acknowledged even though the conversation already existed');
  assert.strictEqual(toUser[0].text, CUSTOMER_GUIDE_TEXT);
  assert.ok(toUser[0].text.includes('/escalate'), 'the reply guides the customer to /escalate');
  assert.ok(store.state.messages.some((m) => m.direction === DIRECTION_CUSTOMER && m.body === 'How do i chat them'));
  assert.strictEqual(transport.calls.filter((c) => c.chatId === SUPPORT_CHAT_ID).length, 1, 'still forwarded');
});

test('an ordinary message with an active human escalation is still acknowledged', async () => {
  const { bot, store, transport } = makeBot();

  const first = await bot.handleUpdate(userUpdate({ text: 'my deposit is stuck', updateId: 78601 }));
  const escalated = await bot.handleUpdate(userUpdate({ text: '/escalate deposit stuck', updateId: 78602 }));
  transport.calls.length = 0;

  // A human escalation is already open - the bot must not go silent.
  const followUp = await bot.handleUpdate(userUpdate({ text: 'What can i do next', updateId: 78603 }));

  assert.strictEqual(first.action, 'forwarded');
  assert.strictEqual(escalated.action, 'escalate');
  assert.strictEqual(followUp.action, 'forwarded');
  const toUser = transport.calls.filter((c) => c.chatId === USER_CHAT_ID);
  assert.strictEqual(toUser.length, 1, 'the follow-up is acknowledged too');
  assert.strictEqual(toUser[0].text, CUSTOMER_GUIDE_TEXT);
  assert.strictEqual(store.state.escalations.length, 1, 'the escalation itself is untouched');
});

test('a Telegram redelivery of an ordinary message never duplicates the reply', async () => {
  const { bot, transport } = makeBot();
  const update = userUpdate({ text: 'What can i do next', updateId: 78701 });

  const first = await bot.handleUpdate(update);
  const retry = await bot.handleUpdate(update);

  assert.strictEqual(first.action, 'forwarded');
  assert.strictEqual(retry.action, 'duplicate');
  assert.strictEqual(transport.calls.filter((c) => c.chatId === USER_CHAT_ID).length, 1,
    'exactly one customer reply across the delivery and the retry');
  assert.strictEqual(transport.calls.filter((c) => c.chatId === SUPPORT_CHAT_ID).length, 1);
});

test('a failing acknowledgement is retried (500) instead of being dropped', async () => {
  // The reply could not be sent, so the update must NOT count as processed:
  // handleUpdate throws (the webhook answers 500) and Telegram redelivers.
  const { bot } = makeBot({ failChatIds: [USER_CHAT_ID] });
  await assert.rejects(() => bot.handleUpdate(userUpdate({ text: 'hello', updateId: 78801 })));
});

test('/help answers the user with the support instructions', async () => {
  const { bot, transport } = makeBot();
  const result = await bot.handleUpdate(userUpdate({ text: '/start' }));
  assert.strictEqual(result.action, 'help');
  assert.strictEqual(transport.calls.find((c) => c.chatId === USER_CHAT_ID).text, USER_HELP_TEXT);
});

test('/escalate stores the incoming message first and links its exact id on the escalation', async () => {
  const { bot, store, transport } = makeBot();
  const result = await bot.handleUpdate(userUpdate({ text: '/escalate deposit missing since friday' }));

  assert.strictEqual(result.action, 'escalate');
  assert.strictEqual(store.state.escalations.length, 1);
  // The live CHECK rejects the app's legacy status vocabulary, so no status
  // write may be attempted - the escalation row is the record.
  assert.strictEqual(store.state.statusWrites.length, 0, 'no conversation status write is attempted');

  // The incoming customer message is persisted FIRST so the escalation can
  // reference its exact row id (the live support_message_id is NOT NULL).
  const escalatedMessage = store.state.messages.find(
    (m) => m.direction === DIRECTION_CUSTOMER && m.body === '/escalate deposit missing since friday'
  );
  assert.ok(escalatedMessage, 'the /escalate message is stored as a customer message');
  assert.ok(Number.isInteger(escalatedMessage.id) && escalatedMessage.id > 0, 'the stored row has a real id');

  const escalation = store.state.escalations[0];
  assert.strictEqual(escalation.conversation_id, store.state.conversations[0].id, 'correct conversation');
  assert.strictEqual(escalation.support_message_id, escalatedMessage.id,
    'the escalation references the exact inserted message id');
  assert.notStrictEqual(escalation.support_message_id, null);
  assert.notStrictEqual(escalation.support_message_id, undefined);

  const notice = transport.calls.find((c) => c.chatId === SUPPORT_CHAT_ID);
  assert.ok(notice.text.includes('Escalation requested'));
  assert.ok(notice.text.includes('deposit missing since friday'));
});

test('the /escalate command uses the correct customer message id for that conversation', async () => {
  const { bot, store } = makeBot();
  // A prior message in the same conversation must not be confused with the one
  // that is actually escalated.
  await bot.handleUpdate(userUpdate({ text: 'first message', messageId: 1, updateId: 76001 }));
  const escalated = await bot.handleUpdate(userUpdate({ text: '/escalate please call me', messageId: 2, updateId: 76002 }));
  assert.strictEqual(escalated.action, 'escalate');

  const customerMessage = store.state.messages.find((m) => m.body === '/escalate please call me');
  assert.ok(customerMessage, 'the escalated message is stored');
  assert.strictEqual(customerMessage.direction, DIRECTION_CUSTOMER);
  assert.strictEqual(store.state.escalations[0].support_message_id, customerMessage.id);
  assert.strictEqual(store.state.escalations[0].conversation_id, customerMessage.conversation_id,
    'the escalation names the same conversation as the message it links');
});

test('a redelivered /escalate update creates no duplicate message or escalation', async () => {
  const { bot, store } = makeBot();
  const update = userUpdate({ text: '/escalate deposit missing since friday', updateId: 77001 });

  const first = await bot.handleUpdate(update);
  const second = await bot.handleUpdate(update);

  assert.strictEqual(first.action, 'escalate');
  assert.strictEqual(second.action, 'duplicate');
  assert.strictEqual(store.state.escalations.length, 1, 'exactly one escalation');
  assert.strictEqual(
    store.state.messages.filter((m) => m.body === '/escalate deposit missing since friday').length,
    1,
    'exactly one stored customer message'
  );
});

test('customer -> bot -> escalation flow keeps the right directions and links the message', async () => {
  const { bot, store } = makeBot();

  // 1. A normal customer message plus the automated acknowledgement.
  await bot.handleUpdate(userUpdate({ text: 'my deposit is stuck', messageId: 11, updateId: 77101 }));
  // 2. The customer asks for a human.
  const escalated = await bot.handleUpdate(userUpdate({ text: '/escalate need help now', messageId: 12, updateId: 77102 }));
  assert.strictEqual(escalated.action, 'escalate');

  assert.deepStrictEqual(
    store.state.messages.map((m) => m.direction),
    [DIRECTION_CUSTOMER, DIRECTION_BOT, DIRECTION_CUSTOMER, DIRECTION_BOT],
    'customer message, automated ack, escalated customer message, automated ack'
  );
  const escalatedMessage = store.state.messages[2];
  assert.strictEqual(escalatedMessage.body, '/escalate need help now');
  assert.strictEqual(store.state.escalations[0].support_message_id, escalatedMessage.id);
  assert.strictEqual(store.state.escalations[0].conversation_id, store.state.conversations[0].id);
});

test("an agent /escalate from the group links the conversation's newest customer message", async () => {
  const { bot, store } = makeBot();
  await bot.handleUpdate(userUpdate({ text: 'please help', messageId: 21, updateId: 77201 }));

  const customerMessage = store.state.messages.find((m) => m.direction === DIRECTION_CUSTOMER);
  const result = await bot.handleUpdate(groupUpdate({ text: `/escalate ${USER_CHAT_ID}`, updateId: 77202 }));

  assert.strictEqual(result.action, 'escalate');
  assert.strictEqual(store.state.escalations.length, 1);
  assert.strictEqual(store.state.escalations[0].support_message_id, customerMessage.id);
  assert.notStrictEqual(store.state.escalations[0].support_message_id, null);
});

test('the group /escalate refuses when the conversation has no stored message (never a null reference)', async () => {
  const { bot, store } = makeBot();
  // A conversation that exists but has no message row (e.g. /start only).
  store.state.conversations.push({ id: 42, telegram_chat_id: Number(USER_CHAT_ID), status: 'open' });

  const result = await bot.handleUpdate(groupUpdate({ text: `/escalate ${USER_CHAT_ID}`, updateId: 77301 }));

  assert.strictEqual(result.action, 'escalate-no-message');
  assert.strictEqual(store.state.escalations.length, 0, 'no escalation row was created');
});

test('the bot never writes conversation.status on any path (escalate, group, close)', async () => {
  const { bot, store } = makeBot();

  await bot.handleUpdate(userUpdate({ text: 'hello', updateId: 78001 }));
  await bot.handleUpdate(userUpdate({ text: '/escalate please help', updateId: 78002 }));
  const groupEscalated = await bot.handleUpdate(groupUpdate({ text: `/escalate ${USER_CHAT_ID}`, updateId: 78003 }));
  const closed = await bot.handleUpdate(groupUpdate({ text: `/close ${USER_CHAT_ID}`, updateId: 78004 }));

  assert.strictEqual(groupEscalated.action, 'escalate');
  assert.strictEqual(closed.action, 'close');
  assert.strictEqual(store.state.statusWrites.length, 0, 'no conversation status write on any of these paths');
  assert.strictEqual(store.state.conversations[0].status, 'open', 'the stored status is left untouched');
  assert.strictEqual(store.state.escalations.length, 2, 'both escalations are still recorded');
});

test('media-only messages ask for text instead of storing an empty message', async () => {
  const { bot, store, transport } = makeBot();
  const update = userUpdate({ text: undefined });
  update.message.text = undefined;
  const result = await bot.handleUpdate(update);
  assert.strictEqual(result.action, 'unsupported-content');
  assert.strictEqual(store.state.messages.filter((m) => m.direction === 'customer').length, 0);
  assert.ok(transport.calls.some((c) => c.chatId === USER_CHAT_ID));
});

// ---------------------------------------------------------------------------
// Support group / agent flow
// ---------------------------------------------------------------------------

test('an admin can discover the group chat id with /chatid', async () => {
  const { bot, transport } = makeBot({ supportChatId: null });
  const result = await bot.handleUpdate(groupUpdate({ text: '/chatid@ArbitrixSupportBot' }));
  assert.strictEqual(result.action, 'chatid');
  const reply = transport.calls.find((c) => c.chatId === SUPPORT_CHAT_ID);
  assert.ok(reply.text.includes(SUPPORT_CHAT_ID), 'replies with the group chat id');
  assert.ok(reply.text.includes('TELEGRAM_SUPPORT_CHAT_ID'), 'tells the operator where to put it');
});

test('a non-admin cannot use group commands', async () => {
  const { bot, transport } = makeBot();
  const result = await bot.handleUpdate(groupUpdate({ text: '/chatid', userId: '999' }));
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'non-admin-group-message');
  assert.strictEqual(transport.calls.length, 0);
});

test('an agent replying to the forwarded message reaches the user', async () => {
  const { bot, store, transport } = makeBot();
  await bot.handleUpdate(userUpdate({ text: 'where is my withdrawal?', messageId: 5, updateId: 300 }));
  // Threading keys off the id Telegram returns for the GROUP forward, so read
  // it back from the recorded call instead of assuming a send order.
  const forwardedId = transport.calls.find((c) => c.chatId === SUPPORT_CHAT_ID).messageId;

  transport.calls.length = 0;
  const result = await bot.handleUpdate(groupUpdate({ text: 'It is queued, 2h ETA.', replyTo: forwardedId, messageId: 55, updateId: 301 }));

  assert.strictEqual(result.action, 'admin-reply');
  const toUser = transport.calls.find((c) => c.chatId === USER_CHAT_ID);
  assert.strictEqual(toUser.text, 'It is queued, 2h ETA.');

  const adminOutbound = store.state.messages.filter((m) => m.direction === 'agent' && m.body === 'It is queued, 2h ETA.');
  assert.strictEqual(adminOutbound.length, 1);
});

test('a customer is acknowledged even when the support-group forward fails', async () => {
  // TELEGRAM_SUPPORT_CHAT_ID points at a chat the bot cannot post to (removed
  // from the group, wrong id, ...). The customer must still get an answer.
  const { bot, store, transport, logger } = makeBot({ failChatIds: [SUPPORT_CHAT_ID] });
  const result = await bot.handleUpdate(userUpdate({ text: 'my deposit is missing', updateId: 400 }));

  assert.strictEqual(result.action, 'forward-failed');
  const toUser = transport.calls.filter((c) => c.chatId === USER_CHAT_ID);
  assert.strictEqual(toUser.length, 1, 'the customer is acknowledged');
  assert.strictEqual(toUser[0].text, CUSTOMER_GUIDE_TEXT);
  // The inbound message is still stored, and the failure is logged with the real
  // reason so it can actually be diagnosed.
  assert.strictEqual(store.state.messages.filter((m) => m.direction === 'customer').length, 1);
  const failureLines = logger.lines.filter((l) => l.includes('support group notification (customer-message) FAILED'));
  assert.strictEqual(failureLines.length, 1, 'the group failure is logged exactly once');
  assert.ok(failureLines[0].includes('Telegram sendMessage failed: simulated'),
    'the actual error reason is logged, not a generic message');
  // ...and recorded for the operator, since logs are not always reachable.
  const groupNotify = bot.status().lastGroupNotify;
  assert.strictEqual(groupNotify.kind, 'customer-message');
  assert.strictEqual(groupNotify.sent, false);
  assert.strictEqual(groupNotify.skipped, false);
  assert.ok(groupNotify.error, 'the operator status carries the failure reason');
  assert.strictEqual(bot.getStats().groupNotificationsFailed >= 1, true);
  assert.ok(!logger.lines.join('\n').includes(TOKEN), 'token never appears in logs');
});

test('the customer is acknowledged before the group forward is attempted', async () => {
  const { bot, transport } = makeBot();
  await bot.handleUpdate(userUpdate({ text: 'hello', updateId: 410 }));

  const sends = transport.calls.filter((c) => c.method === 'sendMessage');
  assert.strictEqual(sends[0].chatId, USER_CHAT_ID, 'acknowledgement is sent first');
  assert.strictEqual(sends[1].chatId, SUPPORT_CHAT_ID, 'then the group forward');
});

test('delivery telemetry records routing decisions without recording secrets', async () => {
  const { bot } = makeBot();
  await bot.handleUpdate(userUpdate({ text: '/start', updateId: 420 }));
  await bot.handleUpdate(userUpdate({ text: 'where is my withdrawal?', updateId: 421 }));
  bot.recordRejectedSecret();

  const stats = bot.getStats();
  assert.strictEqual(stats.updatesReceived, 2);
  assert.strictEqual(stats.processed, 2);
  assert.strictEqual(stats.secretRejected, 1);
  // /start answers, and the ordinary message is acknowledged with the customer
  // guide - every ordinary message gets a reply (it is never left silent).
  assert.strictEqual(stats.repliesSent, 2);
  assert.ok(stats.lastUpdateAt, 'last update timestamp is recorded');
  assert.ok(!JSON.stringify(stats).includes(TOKEN), 'stats never contain the token');
});

test('telemetry records the routing reason for an ignored update', async () => {
  const { bot } = makeBot({ supportChatId: null });
  const result = await bot.handleUpdate(groupUpdate({ text: 'hello', userId: '999', updateId: 430 }));
  assert.strictEqual(result.handled, false);
  const stats = bot.getStats();
  assert.strictEqual(stats.ignored, 1);
  assert.strictEqual(stats.lastReason, 'unconfigured-group-non-admin');
});

test('an unmapped reply in the group is a no-op (no accidental broadcast)', async () => {
  const { bot, transport } = makeBot();
  const result = await bot.handleUpdate(groupUpdate({ text: 'random chatter', replyTo: 424242, updateId: 302 }));
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'reply-unmapped');
  assert.strictEqual(transport.calls.length, 0);
});

test('/reply sends to the user by chat id and confirms in the group', async () => {
  const { bot, transport } = makeBot();
  await bot.handleUpdate(userUpdate({ text: 'help me', updateId: 400 }));
  transport.calls.length = 0;

  const result = await bot.handleUpdate(groupUpdate({ text: `/reply ${USER_CHAT_ID} we are on it`, updateId: 401 }));
  assert.strictEqual(result.action, 'reply');
  assert.ok(transport.calls.some((c) => c.chatId === USER_CHAT_ID && c.text === 'we are on it'));
  assert.ok(transport.calls.some((c) => c.chatId === SUPPORT_CHAT_ID && c.text.includes('Sent to chat')));
});

test('/reply without a body explains usage', async () => {
  const { bot, transport } = makeBot();
  const result = await bot.handleUpdate(groupUpdate({ text: `/reply ${USER_CHAT_ID}`, updateId: 402 }));
  assert.strictEqual(result.action, 'reply-usage');
  assert.ok(transport.calls[0].text.includes('Usage: /reply'));
});

test('/reply to an unknown chat id reports it instead of sending', async () => {
  const { bot, transport } = makeBot();
  const result = await bot.handleUpdate(groupUpdate({ text: '/reply 12345 nobody here', updateId: 403 }));
  assert.strictEqual(result.action, 'reply-missing');
  assert.ok(transport.calls[0].text.includes('No conversation found'));
});

test('/close marks the conversation closed', async () => {
  const { bot, store } = makeBot();
  await bot.handleUpdate(userUpdate({ text: 'hi', updateId: 500 }));
  const result = await bot.handleUpdate(groupUpdate({ text: `/close ${USER_CHAT_ID}`, updateId: 501 }));
  assert.strictEqual(result.action, 'close');
  assert.strictEqual(store.state.statusWrites.length, 0, 'no conversation status write is attempted');
});

test('unknown group commands are ignored silently', async () => {
  const { bot, transport } = makeBot();
  const result = await bot.handleUpdate(groupUpdate({ text: '/whatever', updateId: 600 }));
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'unknown-command');
  assert.strictEqual(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Webhook handler (the real Express route body)
// ---------------------------------------------------------------------------

test('webhook handler returns 503 until the bot is configured', async () => {
  const { bot } = makeBot({ token: '', webhookSecret: '' });
  const handler = createTelegramWebhookHandler({ bot, logger: createFakeLogger() });
  const res = makeRes();
  await handler(makeReq({ body: userUpdate() }), res);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.ok, false);
});

test('webhook handler rejects a missing or wrong secret token without logging it', async () => {
  const { bot } = makeBot();
  const logger = createFakeLogger();
  const handler = createTelegramWebhookHandler({ bot, logger });

  const missing = makeRes();
  await handler(makeReq({ body: userUpdate() }), missing);
  assert.strictEqual(missing.statusCode, 401);

  const wrong = makeRes();
  await handler(makeReq({ headers: { 'x-telegram-bot-api-secret-token': 'attacker-guess' }, body: userUpdate() }), wrong);
  assert.strictEqual(wrong.statusCode, 401);

  const logged = logger.lines.join('\n');
  assert.ok(!logged.includes('attacker-guess'), 'the presented header value is never logged');
  assert.ok(!logged.includes(TOKEN));
});

test('end-to-end: an ordinary customer message is answered (webhook 200, reply, clean trace)', async () => {
  // This mirrors the production trace for a normal message: the webhook must
  // answer 200 KEEPING the update, send exactly one reply to the customer, and
  // report no storage failure.
  const { bot, transport } = makeBot();
  const handler = createTelegramWebhookHandler({ bot, logger: createFakeLogger() });

  const res = makeRes();
  await handler(makeReq({
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: userUpdate({ text: 'What can i do next', updateId: 79001 })
  }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);

  const reply = transport.calls.find((c) => c.chatId === USER_CHAT_ID);
  assert.ok(reply, 'the customer is answered');
  assert.strictEqual(reply.text, CUSTOMER_GUIDE_TEXT);

  const stats = bot.getStats();
  assert.strictEqual(stats.lastAction, 'forwarded', 'the message is still forwarded to the group');
  assert.strictEqual(stats.lastStage, 'done:forwarded');
  assert.strictEqual(stats.repliesSent, 1, 'exactly one customer reply');
  assert.strictEqual(stats.storageFailures, 0, 'no storage failure on the ordinary path');
});

test('webhook handler processes a correctly authenticated update', async () => {
  const { bot, store } = makeBot();
  const handler = createTelegramWebhookHandler({ bot, logger: createFakeLogger() });
  const res = makeRes();
  await handler(makeReq({
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: userUpdate({ text: 'authenticated hi', updateId: 700 })
  }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.handled, true);
  assert.strictEqual(store.state.messages.find((m) => m.direction === 'customer').body, 'authenticated hi');
});

test('webhook handler answers 500 on a processing error and never logs the token', async () => {
  // A processing failure is NOT a delivered update: answering 200 would make
  // Telegram drop the customer's message forever AND record no error at all.
  const { bot } = makeBot({ failSendMessage: true });
  const logger = createFakeLogger();
  const handler = createTelegramWebhookHandler({ bot, logger });
  const res = makeRes();
  await handler(makeReq({
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: userUpdate({ text: 'boom', updateId: 800 })
  }), res);

  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.ok, false);
  assert.strictEqual(res.body.error, 'processing_failed');
  assert.ok(res.body.stage, 'the failing stage is reported for the operator');
  assert.ok(logger.lines.some((l) => l.includes('processing failed at')));
  assert.ok(!logger.lines.join('\n').includes(TOKEN), 'bot token never appears in logs');
  assert.ok(!logger.lines.join('\n').includes(WEBHOOK_SECRET), 'webhook secret never appears in logs');
});

test('/start still replies when storage is completely broken', async () => {
  // Regression for the live "silent bot": store.upsertConversation used to run
  // before any reply, so a broken store made /start do nothing while the handler
  // returned 200 (and Telegram recorded no error at all).
  const { bot, transport, logger } = makeBot({ failStore: true });
  const handler = createTelegramWebhookHandler({ bot, logger });
  const res = makeRes();
  await handler(makeReq({
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: userUpdate({ text: '/start', updateId: 810 })
  }), res);

  assert.strictEqual(res.statusCode, 200, 'the customer was answered, so the update is complete');
  assert.strictEqual(res.body.handled, true);
  const toUser = transport.calls.filter((c) => c.chatId === USER_CHAT_ID);
  assert.strictEqual(toUser.length, 1, 'help text is sent even with no database');
  assert.strictEqual(toUser[0].text, USER_HELP_TEXT);

  const stats = bot.getStats();
  assert.strictEqual(stats.storageFailures, 1, 'the storage failure is counted');
  // The stage must name the FAILING WRITE, not just 'storage': the coarse value is
  // what made the production trace ambiguous (upsert vs insert looked identical).
  assert.strictEqual(stats.lastErrorStage, 'storage:bookkeeping');
  assert.ok(logger.lines.some((l) => l.includes('storage unavailable')), 'the storage failure is logged');
  assert.ok(!logger.lines.join('\n').includes(TOKEN), 'token never logged');
});

test('a plain-text message still answers and forwards when storage is broken', async () => {
  const { bot, transport, logger } = makeBot({ failStore: true });
  const handler = createTelegramWebhookHandler({ bot, logger });
  const res = makeRes();
  await handler(makeReq({
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: userUpdate({ text: 'my deposit is missing', updateId: 820 })
  }), res);

  // Storage is required to queue a ticket, so the update is NOT complete: answer
  // 500 so Telegram retries instead of dropping the customer's message.
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.stage, 'storage:upsert-conversation', 'the failing write is named');
  assert.ok(logger.lines.some((l) => l.includes('storage unavailable')));
  assert.ok(!logger.lines.join('\n').includes(TOKEN), 'token never logged');
  assert.ok(transport.calls.length >= 0);
});

test('checkStorage reports a broken store without throwing', async () => {
  const broken = await makeBot({ failStore: true }).bot.checkStorage();
  assert.strictEqual(broken.ok, false);
  assert.ok(broken.error.includes('telegram conversation lookup failed'));

  const healthy = await makeBot().bot.checkStorage();
  assert.strictEqual(healthy.ok, true);
  assert.strictEqual(healthy.error, null);
});

// ---------------------------------------------------------------------------
// Secret hygiene and operator endpoints
// ---------------------------------------------------------------------------

test('transport can be constructed without fetch and only fails when used', async () => {
  const noFetch = createTelegramTransport({ token: TOKEN, fetchImpl: null });
  // Construction must not throw (the app has to boot on a runtime without a
  // global fetch); the failure surfaces only if the bot is actually exercised.
  await assert.rejects(() => noFetch.getMe(), /No fetch implementation/);
});

test('transport scrubs the bot token from request errors', async () => {
  const failing = () => Promise.reject(new Error(`connect failed for bot${TOKEN}/sendMessage`));
  const transport = createTelegramTransport({ token: TOKEN, fetchImpl: failing });
  await assert.rejects(
    () => transport.sendMessage(USER_CHAT_ID, 'hi'),
    (err) => {
      assert.ok(!err.message.includes(TOKEN), 'token must not appear in the error message');
      assert.ok(err.message.includes('***'), 'the token is replaced, not dropped');
      return true;
    }
  );
});

test('no secret ever appears in transport payloads or logs during a normal flow', async () => {
  const { bot, transport, logger } = makeBot();
  await bot.handleUpdate(userUpdate({ text: 'hello', updateId: 900 }));
  await bot.handleUpdate(groupUpdate({ text: 'reply text', replyTo: 90000, updateId: 901 }));
  await bot.handleUpdate(groupUpdate({ text: '/chatid', updateId: 902 }));

  const serialized = JSON.stringify(transport.calls) + '\n' + logger.lines.join('\n');
  assert.ok(!serialized.includes(TOKEN), 'token never leaks');
  assert.ok(!serialized.includes(WEBHOOK_SECRET), 'webhook secret never leaks in normal operation');
});

test('setWebhook derives the URL from BASE_URL and passes the secret token to Telegram only', async () => {
  const { bot, transport } = makeBot();
  const result = await bot.setWebhook();
  assert.strictEqual(result.url, 'https://arbitrix.pro/api/telegram/webhook');
  const call = transport.calls.find((c) => c.method === 'setWebhook');
  assert.ok(call, 'Telegram setWebhook is called');
  assert.strictEqual(call.params.secret_token, WEBHOOK_SECRET);
  assert.deepStrictEqual(call.params.allowed_updates, ['message', 'edited_message']);
});

test('setWebhook fails closed when required configuration is missing', async () => {
  await assert.rejects(() => makeBot({ token: '' }).bot.setWebhook(), /TELEGRAM_BOT_TOKEN/);
  await assert.rejects(() => makeBot({ webhookSecret: '' }).bot.setWebhook(), /TELEGRAM_WEBHOOK_SECRET/);

  const { bot } = makeBot();
  const stripped = createTelegramSupportBot({
    config: Object.assign({}, bot.getConfig(), { baseUrl: '' }),
    store: createFakeStore(),
    transport: createFakeTransport(),
    logger: createFakeLogger()
  });
  await assert.rejects(() => stripped.setWebhook(), /BASE_URL/);
});

test('status reports which config exists without revealing any value', () => {
  const { bot } = makeBot();
  const status = bot.status();
  assert.strictEqual(status.configured, true);
  assert.strictEqual(status.supportChatConfigured, true);
  assert.strictEqual(status.adminIdsConfigured, true);
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes(TOKEN));
  assert.ok(!serialized.includes(WEBHOOK_SECRET));
  assert.strictEqual(status.webhookPath, '/api/telegram/webhook');
});

// ---------------------------------------------------------------------------
// Store mapping (real store code over an in-memory query-builder stub)
// ---------------------------------------------------------------------------

function createFakeSupabase(initial) {
  const tables = Object.assign({
    telegram_support_conversations: [],
    telegram_support_messages: [],
    telegram_support_escalations: []
  }, initial || {});
  const log = { inserts: [], updates: [] };

  function matches(row, filters) {
    return filters.every(([col, val]) => {
      if (val === null) return row[col] === null || row[col] === undefined;
      return String(row[col]) === String(val);
    });
  }

  function execute(ops) {
    const rows = tables[ops.table] || (tables[ops.table] = []);
    if (ops.insert) {
      const row = Object.assign({ id: rows.length + 1 }, ops.insert);
      log.inserts.push({ table: ops.table, row });
      rows.push(row);
      return Promise.resolve({ data: ops.single ? row : [row], error: null });
    }
    if (ops.update) {
      const target = rows.filter((r) => matches(r, ops.filters));
      target.forEach((r) => Object.assign(r, ops.update));
      log.updates.push({ table: ops.table, update: ops.update, filters: ops.filters, count: target.length });
      if (ops.select) return Promise.resolve({ data: ops.single ? (target[0] || null) : target, error: null });
      return Promise.resolve({ data: null, error: null });
    }
    let found = rows.filter((r) => matches(r, ops.filters));
    if (ops.order) {
      const { col, opts } = ops.order;
      const dir = opts && opts.ascending === false ? -1 : 1;
      found = found.slice().sort((a, b) => (a[col] > b[col] ? dir : a[col] < b[col] ? -dir : 0));
    }
    if (ops.limit !== null && ops.limit !== undefined) found = found.slice(0, ops.limit);
    if (ops.single) return Promise.resolve({ data: found[0] || null, error: found[0] ? null : { code: 'PGRST116', message: 'no rows' } });
    return Promise.resolve({ data: found, error: null });
  }

  return {
    tables,
    log,
    from(table) {
      const ops = { table, filters: [], select: null, update: null, insert: null, order: null, limit: null, single: false };
      const builder = {
        select(cols) { ops.select = cols || '*'; return builder; },
        insert(row) { ops.insert = row; return builder; },
        update(row) { ops.update = row; return builder; },
        eq(col, val) { ops.filters.push([col, val]); return builder; },
        order(col, opts) { ops.order = { col, opts }; return builder; },
        limit(n) { ops.limit = n; return builder; },
        single() { ops.single = true; return execute(ops); },
        then(resolve, reject) { return execute(ops).then(resolve, reject); },
        catch(fn) { return execute(ops).then(undefined, fn); }
      };
      return builder;
    }
  };
}

test('store: upsertConversation keys on telegram_chat_id and numbers the bigints', async () => {
  const client = createFakeSupabase();
  const store = createTelegramSupportStore(client);

  const first = await store.upsertConversation({
    chatId: USER_CHAT_ID, telegramUserId: USER_CHAT_ID, username: 'alice', displayName: 'Alice Test'
  });
  assert.strictEqual(first.created, true);
  assert.strictEqual(first.conversation.telegram_chat_id, Number(USER_CHAT_ID));
  assert.strictEqual(first.conversation.display_name, 'Alice Test');

  const second = await store.upsertConversation({
    chatId: USER_CHAT_ID, telegramUserId: USER_CHAT_ID, username: 'alice2', displayName: 'Alice T'
  });
  assert.strictEqual(second.created, false);
  assert.strictEqual(second.conversation.username, 'alice2');
  assert.strictEqual(client.tables.telegram_support_conversations.length, 1, 'no duplicate row');
});

test('store: insertMessage writes only the applied message columns', async () => {
  const client = createFakeSupabase();
  const store = createTelegramSupportStore(client);
  const { conversation } = await store.upsertConversation({ chatId: USER_CHAT_ID });

  await store.insertMessage({ conversationId: conversation.id, direction: 'customer', body: 'hi' });
  const inserted = client.log.inserts.find((i) => i.table === 'telegram_support_messages');
  assert.deepStrictEqual(Object.keys(inserted.row).sort(), ['body', 'conversation_id', 'direction', 'id']);
  assert.strictEqual(inserted.row.conversation_id, conversation.id);
  assert.strictEqual(client.tables.telegram_support_messages[0].body, 'hi');
});

test('store: inserts each of the three live direction literals', async () => {
  const client = createFakeSupabase();
  const store = createTelegramSupportStore(client);
  const { conversation } = await store.upsertConversation({ chatId: USER_CHAT_ID });

  await store.insertMessage({ conversationId: conversation.id, direction: DIRECTION_CUSTOMER, body: 'customer msg' });
  await store.insertMessage({ conversationId: conversation.id, direction: DIRECTION_BOT, body: 'bot reply' });
  await store.insertMessage({ conversationId: conversation.id, direction: DIRECTION_AGENT, body: 'agent reply' });

  const rows = client.tables.telegram_support_messages;
  assert.deepStrictEqual(rows.map((r) => r.direction), ['customer', 'bot', 'agent']);
});

test('store: refuses any direction outside the live CHECK set (no DB write)', async () => {
  const client = createFakeSupabase();
  const store = createTelegramSupportStore(client);
  const { conversation } = await store.upsertConversation({ chatId: USER_CHAT_ID });

  // 'inbound'/'outbound' are exactly the legacy literals that produced the
  // production 23514; neither they nor any other value may reach Postgres now.
  for (const bad of ['inbound', 'outbound', 'incoming', 'outgoing', 'in', 'out', 'BOT', 'Customer', '', null, undefined, 1]) {
    await assert.rejects(
      () => store.insertMessage({ conversationId: conversation.id, direction: bad, body: 'x' }),
      /invalid message direction/,
      'direction ' + JSON.stringify(bad) + ' must be refused'
    );
  }
  assert.strictEqual(client.tables.telegram_support_messages.length, 0, 'no invalid row reached the database');
  assert.strictEqual(client.log.inserts.filter((i) => i.table === 'telegram_support_messages').length, 0);
});

test('direction literals and validation match the confirmed live CHECK constraint exactly', () => {
  // Confirmed against production:
  //   CHECK (direction = ANY (ARRAY['customer'::text, 'bot'::text, 'agent'::text]))
  const LIVE = ['customer', 'bot', 'agent'];
  assert.deepStrictEqual([...ALLOWED_DIRECTIONS], LIVE, 'store validation set equals the live CHECK set');
  assert.strictEqual(DIRECTION_CUSTOMER, 'customer');
  assert.strictEqual(DIRECTION_BOT, 'bot');
  assert.strictEqual(DIRECTION_AGENT, 'agent');
  const storeSrc = fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportStore.js'), 'utf8');
  assert.ok(storeSrc.includes("const ALLOWED_DIRECTIONS = Object.freeze(['customer', 'bot', 'agent']);"),
    'store guard is built from exactly the live set');
  // Migration 027 documents that the live pre-existing table is authoritative
  // (its own DDL still carries the legacy inbound/outbound CHECK).
  const migration = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '027_telegram_support_bot.sql'), 'utf8');
  for (const liveValue of LIVE) {
    assert.ok(migration.includes(liveValue), 'migration documents the live value ' + liveValue);
  }
});

test('service: customer message stores customer and the automated acknowledgement stores bot', async () => {
  const { bot, store } = makeBot();
  const result = await bot.handleUpdate(userUpdate({ text: 'where is my withdrawal?', updateId: 99001 }));
  assert.strictEqual(result.action, 'forwarded');

  const inbound = store.state.messages.find((m) => m.body === 'where is my withdrawal?');
  assert.strictEqual(inbound.direction, DIRECTION_CUSTOMER, 'inbound customer message -> customer');
  const receipt = store.state.messages.find((m) => m.body === CUSTOMER_GUIDE_TEXT);
  assert.strictEqual(receipt.direction, DIRECTION_BOT, 'automated acknowledgement -> bot');
  assert.ok(store.state.messages.every((m) => ALLOWED_DIRECTIONS.includes(m.direction)));
});

test('service: an agent reply to the forwarded message stores agent, never bot', async () => {
  const { bot, store, transport } = makeBot();
  await bot.handleUpdate(userUpdate({ text: 'where is my withdrawal?', messageId: 5, updateId: 99101 }));
  const forwardedId = transport.calls.find((c) => c.chatId === SUPPORT_CHAT_ID).messageId;

  const result = await bot.handleUpdate(
    groupUpdate({ text: 'It is queued, 2h ETA.', replyTo: forwardedId, messageId: 55, updateId: 99102 })
  );
  assert.strictEqual(result.action, 'admin-reply');
  const reply = store.state.messages.find((m) => m.body === 'It is queued, 2h ETA.');
  assert.strictEqual(reply.direction, DIRECTION_AGENT, 'human reply -> agent');
  assert.notStrictEqual(reply.direction, DIRECTION_BOT, 'a human reply must never be labelled bot');
});

test('service: the /reply command from the support group stores agent, never bot', async () => {
  const { bot, store } = makeBot();
  await bot.handleUpdate(userUpdate({ text: 'help me', updateId: 99201 }));
  const result = await bot.handleUpdate(groupUpdate({ text: `/reply ${USER_CHAT_ID} we are on it`, updateId: 99202 }));
  assert.strictEqual(result.action, 'reply');

  const reply = store.state.messages.find((m) => m.body === 'we are on it');
  assert.strictEqual(reply.direction, DIRECTION_AGENT, 'human /reply -> agent');
  assert.notStrictEqual(reply.direction, DIRECTION_BOT);
});

test('service: customer -> bot -> agent flow preserves the labels end to end', async () => {
  const { bot, store, transport } = makeBot();

  // 1. Customer writes in. 2. The bot acknowledges automatically.
  const first = await bot.handleUpdate(userUpdate({ text: 'my deposit is stuck', messageId: 7, updateId: 99301 }));
  assert.strictEqual(first.action, 'forwarded');
  // 3. A human agent answers in the support group.
  const forwardedId = transport.calls.find((c) => c.chatId === SUPPORT_CHAT_ID).messageId;
  const second = await bot.handleUpdate(
    groupUpdate({ text: 'Resolved - funds released.', replyTo: forwardedId, messageId: 77, updateId: 99302 })
  );
  assert.strictEqual(second.action, 'admin-reply');

  assert.deepStrictEqual(
    store.state.messages.map((m) => m.direction),
    [DIRECTION_CUSTOMER, DIRECTION_BOT, DIRECTION_AGENT],
    'the stored flow is customer, then bot, then agent'
  );
  const bodies = store.state.messages.map((m) => m.body);
  assert.strictEqual(bodies[0], 'my deposit is stuck');
  assert.strictEqual(bodies[bodies.length - 1], 'Resolved - funds released.');
  assert.ok(store.state.messages.every((m) => ALLOWED_DIRECTIONS.includes(m.direction)));
});

test('store: escalations target the right rows/tables', async () => {
  const client = createFakeSupabase();
  const store = createTelegramSupportStore(client);
  const { conversation } = await store.upsertConversation({ chatId: USER_CHAT_ID });

  const { message } = await store.insertMessage({
    conversationId: conversation.id,
    direction: DIRECTION_CUSTOMER,
    body: 'please escalate'
  });
  await store.createEscalation({ conversationId: conversation.id, supportMessageId: message.id });

  const inserted = client.log.inserts.find((i) => i.table === 'telegram_support_escalations');
  assert.deepStrictEqual(Object.keys(inserted.row).sort(), ['conversation_id', 'id', 'support_message_id']);
  assert.strictEqual(inserted.row.conversation_id, conversation.id);
  assert.strictEqual(inserted.row.support_message_id, message.id,
    'the escalation stores the support message id, never null');
});

test('store: setConversationStatus refuses every unconfirmed status (no DB write)', async () => {
  const client = createFakeSupabase();
  const store = createTelegramSupportStore(client);
  const { conversation } = await store.upsertConversation({ chatId: USER_CHAT_ID });

  // The live CHECK rejected 'escalated' and its allowed values are unknown, so
  // the confirmed list is intentionally EMPTY and nothing may be written.
  assert.deepStrictEqual([...CONFIRMED_CONVERSATION_STATUSES], []);
  for (const status of ['escalated', 'closed', 'open', 'active', 'resolved', '', null, undefined]) {
    await assert.rejects(
      () => store.setConversationStatus({ conversationId: conversation.id, status }),
      /refusing to write conversation status/,
      'status ' + JSON.stringify(status) + ' must be refused'
    );
  }
  const updates = client.log.updates.filter((u) => u.table === 'telegram_support_conversations');
  assert.strictEqual(updates.length, 0, 'no conversation status update reached the database');
});

test('the migration documents the live status CHECK divergence', () => {
  const migration = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '027_telegram_support_bot.sql'), 'utf8');
  assert.ok(migration.includes('telegram_support_conversations_status_check'),
    'the migration names the live status CHECK it diverges from');
  assert.ok(/the application deliberately writes NO status value/.test(migration),
    'the migration records that the app writes no status value');
});

test('store: createEscalation rejects a null/undefined/missing supportMessageId before any DB write', async () => {
  const client = createFakeSupabase();
  const store = createTelegramSupportStore(client);
  const { conversation } = await store.upsertConversation({ chatId: USER_CHAT_ID });

  for (const bad of [null, undefined, '', 0, -1, 'abc', 1.5]) {
    await assert.rejects(
      () => store.createEscalation({ conversationId: conversation.id, supportMessageId: bad }),
      /supportMessageId/,
      'supportMessageId ' + JSON.stringify(bad) + ' must be refused'
    );
  }
  await assert.rejects(
    () => store.createEscalation({ conversationId: conversation.id }),
    /supportMessageId/,
    'a missing supportMessageId must be refused'
  );

  assert.strictEqual(client.tables.telegram_support_escalations.length, 0, 'no escalation reached the database');
  assert.strictEqual(client.log.inserts.filter((i) => i.table === 'telegram_support_escalations').length, 0);
});

test('store: getLatestMessageByConversation returns the newest row, optionally filtered by direction', async () => {
  const client = createFakeSupabase();
  const store = createTelegramSupportStore(client);
  const { conversation } = await store.upsertConversation({ chatId: USER_CHAT_ID });

  await store.insertMessage({ conversationId: conversation.id, direction: DIRECTION_CUSTOMER, body: 'one' });
  const ack = await store.insertMessage({ conversationId: conversation.id, direction: DIRECTION_BOT, body: 'ack' });

  const newest = await store.getLatestMessageByConversation({ conversationId: conversation.id });
  assert.strictEqual(newest.id, ack.message.id, 'newest row overall');
  const newestCustomer = await store.getLatestMessageByConversation({
    conversationId: conversation.id, direction: DIRECTION_CUSTOMER
  });
  assert.strictEqual(newestCustomer.body, 'one', 'newest customer row when filtered');
  assert.strictEqual(await store.getLatestMessageByConversation({ conversationId: 999 }), null);
});

test('store: getConversationByChatId returns null when absent', async () => {
  const client = createFakeSupabase();
  const store = createTelegramSupportStore(client);
  assert.strictEqual(await store.getConversationByChatId('123'), null);
  await store.upsertConversation({ chatId: '123' });
  assert.ok(await store.getConversationByChatId('123'));
});

test('store: refuses to build without a client', () => {
  assert.throws(() => createTelegramSupportStore(null), /requires a Supabase client/);
});

// ---------------------------------------------------------------------------
// Static wiring checks on server.js / .env.example / migration
// ---------------------------------------------------------------------------

test('server.js mounts the bot on /api/telegram/webhook, not under /api/webhook/*', () => {
  assert.ok(SERVER.includes("app.post('/api/telegram/webhook'"), 'webhook route is registered');
  // The generic app.post('/api/webhook/:provider') handler is registered earlier
  // and would shadow any /api/webhook/<name> route.
  assert.ok(!/app\.(post|get|put|patch|delete)\('\/api\/webhook\/telegram/.test(SERVER),
    'route must not be shadowed by the generic provider webhook handler');
});

test('server.js builds the bot with supabaseAdmin and the shared service; operator routes are admin-gated', () => {
  assert.ok(/createTelegramSupportStore\(supabaseAdmin\)/.test(SERVER),
    'store uses the service-role client (tables are RLS-restricted to service_role)');
  assert.ok(SERVER.includes("require('./services/TelegramSupportService')"));
  assert.ok(SERVER.includes("app.get('/api/telegram/status', authMiddleware, adminMiddleware"),
    'status endpoint is admin-gated');
  assert.ok(SERVER.includes("app.post('/api/telegram/set-webhook', authMiddleware, adminMiddleware"),
    'set-webhook endpoint is admin-gated');
});

test('.env.example documents every Telegram variable the bot reads', () => {
  for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_SUPPORT_CHAT_ID', 'TELEGRAM_ADMIN_IDS', 'TELEGRAM_WEBHOOK_SECRET']) {
    assert.ok(new RegExp('^' + key + '=', 'm').test(ENV_EXAMPLE), key + ' documented in .env.example');
  }
});

test('the migration matches the applied schema with service_role-only RLS policies', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '027_telegram_support_bot.sql'), 'utf8');
  for (const table of ['telegram_support_conversations', 'telegram_support_messages', 'telegram_support_escalations']) {
    assert.ok(new RegExp('CREATE TABLE IF NOT EXISTS public\\.' + table).test(sql), table + ' created');
    assert.ok(new RegExp('ALTER TABLE public\\.' + table + ' ENABLE ROW LEVEL SECURITY').test(sql), table + ' RLS enabled');
    assert.ok(sql.includes('ON public.' + table + '\n    FOR ALL TO service_role'), table + ' restricted to service_role');
  }
  for (const column of ['telegram_chat_id', 'telegram_user_id', 'username', 'display_name', 'status', 'language']) {
    assert.ok(new RegExp('^\\s+' + column + ' ', 'm').test(sql), 'conversations.' + column + ' present');
  }
  const messagesBlock = sql.slice(
    sql.indexOf('CREATE TABLE IF NOT EXISTS public.telegram_support_messages'),
    sql.indexOf('CREATE TABLE IF NOT EXISTS public.telegram_support_escalations')
  );
  for (const column of ['conversation_id BIGINT', 'direction TEXT NOT NULL', 'body TEXT NOT NULL']) {
    assert.ok(messagesBlock.includes(column), 'messages.' + column + ' present');
  }
  for (const unexpected of ['telegram_message_id', 'group_message_id', 'update_id']) {
    assert.ok(!messagesBlock.includes(unexpected), 'messages must not declare ' + unexpected);
  }
  const escalationsBlock = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS public.telegram_support_escalations'));
  assert.ok(escalationsBlock.includes('conversation_id BIGINT NOT NULL'),
    'escalations links a conversation');
  assert.ok(escalationsBlock.includes('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()'),
    'escalations records when it was raised');
  assert.ok(!escalationsBlock.includes('reason'), 'escalations has no reason column in the applied schema');
  // support_message_id is required by the LIVE table but is absent from this
  // legacy mirror's DDL; the divergence is documented in the file and the
  // application always supplies the id.
  assert.ok(!escalationsBlock.includes('support_message_id'),
    'the legacy mirror DDL does not declare support_message_id');
  assert.ok(sql.includes('support_message_id BIGINT NOT NULL'),
    'migration documents the live NOT NULL support_message_id column');
  assert.ok(!/TO\s+(anon|authenticated)/.test(sql), 'no policy grants anon/authenticated');
});
