'use strict';

/**
 * Human-support routing: which variable configures the support group, and what
 * /escalate actually does.
 *
 * Reported symptom: requesting a human did not produce a message in the support
 * team group. Cause: every group notification is gated on
 * `cfg.supportChatId`, which comes from the SINGLE variable
 * TELEGRAM_SUPPORT_CHAT_ID. With that variable unset the bot stored the
 * escalation, acknowledged the customer, and told nobody - "capture mode".
 *
 * These tests pin the variable name (proved by showing plausible alternatives do
 * NOT work), the gating, and the four /escalate properties: the escalation is
 * stored, the group is notified, an operator can reply, and nothing unnecessary
 * is exposed. They run the REAL bot, REAL routing and REAL forwarding text with a
 * fake store and a fake transport, so nothing touches Telegram or the database.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  resolveTelegramConfig,
  routeUpdate,
  createTelegramSupportBot,
  createTelegramTransport,
  buildForwardText,
  describeTelegramToken,
  DIRECTION_CUSTOMER,
  DIRECTION_AGENT
} = require('../services/TelegramSupportService');

const TOKEN = '123456789:TEST-TOKEN-NOT-A-CREDENTIAL';
const GROUP_ID = '-1001234567890';
const CUSTOMER_ID = '555111';
const ADMIN_ID = '777222';
const ADMIN2_ID = '888333';

// --------------------------------------------------------------------- harness ---

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function makeStore() {
  const state = { conversations: [], messages: [], escalations: [], statuses: [] };
  return {
    state,
    async getConversationByChatId(chatId) {
      return state.conversations.find((c) => String(c.telegram_chat_id) === String(chatId)) || null;
    },
    async upsertConversation({ chatId, displayName }) {
      const existing = state.conversations.find((c) => String(c.telegram_chat_id) === String(chatId));
      if (existing) return { conversation: existing, created: false };
      const conversation = {
        id: state.conversations.length + 1,
        telegram_chat_id: Number(chatId),
        display_name: displayName || 'Customer'
      };
      state.conversations.push(conversation);
      return { conversation, created: true };
    },
    async insertMessage({ conversationId, direction, body }) {
      const message = { id: state.messages.length + 1, conversation_id: conversationId, direction, body };
      state.messages.push(message);
      return { message };
    },
    async getLatestMessageByConversation({ conversationId, direction }) {
      const found = state.messages
        .filter((m) => m.conversation_id === conversationId && (!direction || m.direction === direction))
        .pop();
      return found || null;
    },
    async createEscalation({ conversationId, supportMessageId }) {
      const escalation = { id: state.escalations.length + 1, conversation_id: conversationId, support_message_id: supportMessageId };
      state.escalations.push(escalation);
      return escalation;
    },
    async setConversationStatus(...args) { state.statuses.push(args); return true; },
    async probeColumns() { return true; }
  };
}

function makeTransport() {
  const calls = [];
  let messageSeq = 0;
  const fetchImpl = async (url, options) => {
    const method = String(url).split('/').pop();
    const messageId = ++messageSeq;
    calls.push({ method, payload: JSON.parse(options.body || '{}'), messageId });
    return jsonResponse({ ok: true, result: { message_id: messageId } });
  };
  return { transport: createTelegramTransport({ token: TOKEN, fetchImpl }), calls };
}

function makeBot({ supportChatId = null, adminIds = [ADMIN_ID] } = {}) {
  const store = makeStore();
  const { transport, calls } = makeTransport();
  const bot = createTelegramSupportBot({
    config: { token: TOKEN, supportChatId, adminIds, webhookSecret: 'x', baseUrl: 'https://arbitrix.pro' },
    store,
    transport,
    logger: { log() {}, warn() {}, error() {} }
  });
  const sentTo = (chatId) => calls.filter((c) => c.method === 'sendMessage' && String(c.payload.chat_id) === String(chatId));
  return { bot, store, calls, sentTo };
}

let updateSeq = 100;
const privateMessage = (text, fromId = CUSTOMER_ID) => ({
  update_id: ++updateSeq,
  message: {
    message_id: updateSeq,
    date: 1700000000,
    text,
    chat: { id: Number(fromId), type: 'private' },
    from: { id: Number(fromId), first_name: 'Customer', username: 'customer' }
  }
});

const groupMessage = (text, fromId = ADMIN_ID, chatId = GROUP_ID) => ({
  update_id: ++updateSeq,
  message: {
    message_id: updateSeq,
    date: 1700000000,
    text,
    chat: { id: Number(chatId), type: 'supergroup', title: 'Arbitrix Support' },
    from: { id: Number(fromId), first_name: 'Agent' }
  }
});

// ------------------------------------------- the variable name (not a guess) ---

test('the support group chat ID comes from TELEGRAM_SUPPORT_CHAT_ID', () => {
  const cfg = resolveTelegramConfig({ TELEGRAM_SUPPORT_CHAT_ID: GROUP_ID });
  assert.strictEqual(cfg.supportChatId, GROUP_ID);
});

test('plausible alternative variable names do NOT configure the group', () => {
  // Guards against "guess the env var" regressions: only the exact name is read.
  ['TELEGRAM_SUPPORT_GROUP_ID', 'TELEGRAM_GROUP_ID', 'TELEGRAM_SUPPORT_GROUP_CHAT_ID',
    'SUPPORT_CHAT_ID', 'TELEGRAM_CHAT_ID', 'TELEGRAM_SUPPORT_GROUP'].forEach((name) => {
    const cfg = resolveTelegramConfig({ [name]: GROUP_ID });
    assert.strictEqual(cfg.supportChatId, null, name + ' must not be treated as the support group');
    assert.ok(!cfg.adminIds.length, name + ' must not leak into admins');
  });
});

test('the group id and admin ids are normalized (quotes/whitespace) but not rewritten', () => {
  const cfg = resolveTelegramConfig({
    TELEGRAM_SUPPORT_CHAT_ID: ` "${GROUP_ID}" `,
    TELEGRAM_ADMIN_IDS: ` "${ADMIN_ID}", ${ADMIN2_ID} `
  });
  assert.strictEqual(cfg.supportChatId, GROUP_ID);
  assert.deepStrictEqual(cfg.adminIds, [ADMIN_ID, ADMIN2_ID]);
});

test('the admin list variable is TELEGRAM_ADMIN_IDS', () => {
  assert.deepStrictEqual(resolveTelegramConfig({ TELEGRAM_ADMIN_IDS: `${ADMIN_ID},${ADMIN2_ID}` }).adminIds,
    [ADMIN_ID, ADMIN2_ID]);
  assert.deepStrictEqual(resolveTelegramConfig({ TELEGRAM_ADMINS: ADMIN_ID }).adminIds, []);
});

// --------------------------------------------- /escalate with the group UNSET ---

test('without TELEGRAM_SUPPORT_CHAT_ID /escalate stores the escalation but notifies nobody', async () => {
  // This is exactly the reported symptom: the escalation record exists, the
  // customer is acknowledged, and the support group never hears about it.
  const { bot, store, calls, sentTo } = makeBot({ supportChatId: null });

  const result = await bot.handleUpdate(privateMessage('/escalate'));

  assert.strictEqual(result.action, 'escalate');
  assert.strictEqual(store.state.escalations.length, 1, 'the escalation is still stored');
  assert.ok(store.state.escalations[0].support_message_id, 'it references the stored message');
  assert.strictEqual(store.state.messages[0].direction, DIRECTION_CUSTOMER);
  assert.strictEqual(store.state.messages[0].body, '/escalate');
  assert.strictEqual(sentTo(GROUP_ID).length, 0, 'the support group is never notified');
  assert.strictEqual(calls.length, 1, 'the only send is the customer acknowledgement');
  assert.strictEqual(String(calls[0].payload.chat_id), CUSTOMER_ID);
});

// ----------------------------------------------- /escalate with the group SET ---

test('with TELEGRAM_SUPPORT_CHAT_ID set /escalate notifies the support group', async () => {
  const { bot, store, sentTo } = makeBot({ supportChatId: GROUP_ID });

  const result = await bot.handleUpdate(privateMessage('/escalate needs help with a deposit', CUSTOMER_ID));

  assert.strictEqual(result.action, 'escalate');
  assert.strictEqual(store.state.escalations.length, 1, 'stored');
  assert.strictEqual(store.state.escalations[0].support_message_id, store.state.messages[0].id);

  const toGroup = sentTo(GROUP_ID);
  assert.strictEqual(toGroup.length, 1, 'the group is notified exactly once');
  assert.match(toGroup[0].payload.text, /Escalation requested/);
  assert.match(toGroup[0].payload.text, new RegExp('Conversation: #' + store.state.conversations[0].id));
  assert.match(toGroup[0].payload.text, new RegExp(CUSTOMER_ID), 'the operator gets the chat id needed to reply');
});

test('/escalate acknowledges the customer as well as the group', async () => {
  const { bot, sentTo } = makeBot({ supportChatId: GROUP_ID });
  await bot.handleUpdate(privateMessage('/escalate', CUSTOMER_ID));
  const toCustomer = sentTo(CUSTOMER_ID);
  assert.strictEqual(toCustomer.length, 1, 'exactly one customer acknowledgement');
  assert.match(toCustomer[0].payload.text, /human agent/i);
});

test('the escalation notice carries only what an operator needs', async () => {
  const { bot, sentTo } = makeBot({ supportChatId: GROUP_ID });
  await bot.handleUpdate(privateMessage('/escalate please call me', CUSTOMER_ID));
  const notice = sentTo(GROUP_ID)[0].payload.text;

  // useful fields
  assert.match(notice, /Conversation: #/);
  assert.match(notice, /Customer: /);
  assert.match(notice, /Chat ID: |chat -?\d+/);

  // nothing unnecessary: no credentials, no account email, no balances
  assert.ok(!/password|seed phrase|private key|api key|otp|2fa code/i.test(notice), notice);
  assert.ok(!/@[a-z0-9.-]+\.[a-z]{2,}/i.test(notice), 'no email address in the group notice');
  assert.ok(!/balance|kyc|wallet address/i.test(notice), notice);
});

test('a group send failure never silences the customer', async () => {
  const store = makeStore();
  const calls = [];
  const transport = createTelegramTransport({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body || '{}');
      calls.push({ method: String(url).split('/').pop(), payload });
      if (String(payload.chat_id) === String(GROUP_ID)) {
        return { ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) };
      }
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    }
  });
  const bot = createTelegramSupportBot({
    config: { token: TOKEN, supportChatId: GROUP_ID, adminIds: [ADMIN_ID], webhookSecret: 'x', baseUrl: 'b' },
    store, transport, logger: { log() {}, warn() {}, error() {} }
  });

  const result = await bot.handleUpdate(privateMessage('/escalate', CUSTOMER_ID));
  assert.strictEqual(result.action, 'escalate', 'the escalation still succeeds');
  assert.strictEqual(store.state.escalations.length, 1);
  assert.ok(calls.some((c) => String(c.payload.chat_id) === CUSTOMER_ID), 'the customer was still acknowledged');
});

// ------------------------------------------------ ordinary message forwarding ---

test('ordinary messages are forwarded to the group only when it is configured', async () => {
  const withGroup = makeBot({ supportChatId: GROUP_ID });
  const r1 = await withGroup.bot.handleUpdate(privateMessage('how do I deposit?'));
  assert.strictEqual(r1.action, 'forwarded');
  const forward = withGroup.sentTo(GROUP_ID).find((c) => /New Customer Message/.test(c.payload.text));
  assert.ok(forward, 'the group received the message');
  assert.match(forward.payload.text, /how do I deposit\?/);
  assert.match(forward.payload.text, /\/reply /, 'the operator is told how to reply');

  const withoutGroup = makeBot({ supportChatId: null });
  const r2 = await withoutGroup.bot.handleUpdate(privateMessage('how do I deposit?'));
  assert.strictEqual(r2.action, 'stored-without-group');
  assert.strictEqual(withoutGroup.sentTo(GROUP_ID).length, 0, 'nothing is forwarded');
  assert.strictEqual(withoutGroup.store.state.messages.filter((m) => m.direction === DIRECTION_CUSTOMER).length, 1,
    'the customer message is still stored for the record');
  assert.strictEqual(String(withoutGroup.calls[0].payload.chat_id), CUSTOMER_ID, 'the customer is still answered');
});

test('the forward text contains no account or credential detail', () => {
  const text = buildForwardText({ id: 7 }, CUSTOMER_ID, 'Customer Name', 'my deposit is late');
  assert.match(text, /Conversation: #7/);
  assert.match(text, /Chat ID: 555111/);
  assert.match(text, /my deposit is late/);
  assert.ok(!/email|password|seed|private key|api key|balance/i.test(text), text);
});

// --------------------------------------------------------------- admin replies ---

test('a human operator can reply with /reply <chat_id> <message>', async () => {
  const { bot, store, sentTo } = makeBot({ supportChatId: GROUP_ID });
  await bot.handleUpdate(privateMessage('hello', CUSTOMER_ID));

  await bot.handleUpdate(groupMessage(`/reply ${CUSTOMER_ID} Thanks, we are on it.`));

  const toCustomer = sentTo(CUSTOMER_ID).filter((c) => /Thanks, we are on it\./.test(c.payload.text));
  assert.strictEqual(toCustomer.length, 1, 'the reply reached the customer');
  const stored = store.state.messages.filter((m) => m.body === 'Thanks, we are on it.');
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].direction, DIRECTION_AGENT, 'recorded as a human agent, never the bot');
});

test('a human operator can also reply to the forwarded message', async () => {
  const { bot, store, calls, sentTo } = makeBot({ supportChatId: GROUP_ID });
  await bot.handleUpdate(privateMessage('withdrawal question', CUSTOMER_ID));
  const forwarded = sentTo(GROUP_ID).find((c) => /New Customer Message/.test(c.payload.text));

  const replyToForwarded = {
    update_id: ++updateSeq,
    message: {
      message_id: ++updateSeq,
      date: 1700000000,
      text: 'Checking this for you now.',
      chat: { id: Number(GROUP_ID), type: 'supergroup', title: 'Arbitrix Support' },
      from: { id: Number(ADMIN_ID), first_name: 'Agent' },
      // the real id the transport returned for the forwarded message
      reply_to_message: { message_id: forwarded.messageId }
    }
  };
  await bot.handleUpdate(replyToForwarded);

  const delivered = calls.filter((c) => String(c.payload.chat_id) === CUSTOMER_ID && /Checking this for you now/.test(c.payload.text));
  assert.strictEqual(delivered.length, 1, 'the threaded reply reached the customer');
  assert.strictEqual(store.state.messages.filter((m) => m.body === 'Checking this for you now.')[0].direction, DIRECTION_AGENT);
});

test('group commands are refused for a non-admin', async () => {
  const { bot, calls } = makeBot({ supportChatId: GROUP_ID, adminIds: [ADMIN_ID] });
  const result = await bot.handleUpdate(groupMessage(`/reply ${CUSTOMER_ID} hi`, ADMIN2_ID));
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'non-admin-group-message');
  assert.strictEqual(calls.length, 0, 'a non-admin gets no reply and can send nothing');
});

test('admins are required for the operator workflow (TELEGRAM_ADMIN_IDS)', async () => {
  const { bot, calls } = makeBot({ supportChatId: GROUP_ID, adminIds: [] });
  const result = await bot.handleUpdate(groupMessage('/chatid', ADMIN_ID));
  assert.strictEqual(result.handled, false, 'with no admin ids configured nobody can operate the bot');
  assert.strictEqual(calls.length, 0);
});

// ------------------------------------------------------------------ /chatid ---

test('/chatid in the group reports the group id and names the variable to set', async () => {
  const { bot, sentTo } = makeBot({ supportChatId: null });
  const result = await bot.handleUpdate(groupMessage('/chatid'));
  assert.strictEqual(result.action, 'chatid');
  const reply = sentTo(GROUP_ID)[0].payload.text;
  assert.match(reply, new RegExp('Chat ID: ' + GROUP_ID));
  assert.match(reply, /Chat type: supergroup/);
  assert.match(reply, /Your user ID: /);
  assert.match(reply, /Set TELEGRAM_SUPPORT_CHAT_ID to the Chat ID above to enable forwarding\./,
    'the bot tells the operator the exact variable name');
});

test('/chatid works BEFORE the group is configured, so the id can be discovered', async () => {
  const { bot, sentTo } = makeBot({ supportChatId: null, adminIds: [ADMIN_ID] });
  await bot.handleUpdate(groupMessage('/chatid', ADMIN_ID));
  assert.strictEqual(sentTo(GROUP_ID).length, 1);

  // ...but an unknown group is ignored once the group IS configured
  const configured = makeBot({ supportChatId: GROUP_ID });
  const r = await configured.bot.handleUpdate(groupMessage('/chatid', ADMIN_ID, '-1009999999999'));
  assert.strictEqual(r.handled, false);
  assert.strictEqual(r.reason, 'other-group');
});

test('/chatid in a private chat answers the customer with their own chat id', async () => {
  const { bot, sentTo } = makeBot({ supportChatId: GROUP_ID });
  const result = await bot.handleUpdate(privateMessage('/chatid', CUSTOMER_ID));
  assert.strictEqual(result.action, 'chatid');
  assert.match(sentTo(CUSTOMER_ID)[0].payload.text, new RegExp('Your chat ID is: ' + CUSTOMER_ID));
});

// ------------------------------------------------------ routing (pure function) ---

test('routing accepts the configured group, ignores other groups', () => {
  const cfg = { supportChatId: GROUP_ID, adminIds: [ADMIN_ID] };
  assert.strictEqual(routeUpdate(groupMessage('/chatid'), cfg).kind, 'group');
  assert.strictEqual(routeUpdate(groupMessage('/chatid', ADMIN_ID, '-100999'), cfg).reason, 'other-group');
});

test('routing accepts an admin message from any group while unconfigured, but not a stranger', () => {
  const unconfigured = { supportChatId: null, adminIds: [ADMIN_ID] };
  assert.strictEqual(routeUpdate(groupMessage('/chatid', ADMIN_ID, '-100555'), unconfigured).kind, 'group');
  assert.strictEqual(routeUpdate(groupMessage('hi', ADMIN2_ID, '-100555'), unconfigured).reason,
    'unconfigured-group-non-admin');
});

// ------------------------------------------------------------------ reporting ---

test('the group-configuration state is reportable without leaking secrets', () => {
  const cfg = resolveTelegramConfig({
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_SUPPORT_CHAT_ID: GROUP_ID,
    TELEGRAM_ADMIN_IDS: ADMIN_ID
  });
  assert.strictEqual(Boolean(cfg.supportChatId), true);
  assert.strictEqual(cfg.adminIds.length, 1);
  const described = describeTelegramToken(TOKEN);
  const asText = JSON.stringify(described);
  assert.ok(asText.indexOf(TOKEN) === -1, 'the token value must never be included in a description');
  assert.ok(asText.indexOf(TOKEN.split(':')[1]) === -1, 'nor the token secret part');
});
