'use strict';

/**
 * Customer -> support-group forwarding.
 *
 * One deliverable is pinned here: a customer message and an escalation each
 * produce exactly ONE direct Telegram Bot API sendMessage to the CONFIGURED
 * support group, carrying the conversation/customer/message information, while
 * the customer experience (AI reply, storage, /reply, /escalate) is untouched.
 *
 * The failure modes that made this hard to diagnose in production are pinned
 * too: a Telegram rejection must log the REAL reason, a missing group
 * configuration must be LOUD instead of a silent no-op, and neither may ever
 * break the customer's reply.
 *
 * The real bot, the real routing and the real notification text are exercised
 * with a fake store and a fake transport, so nothing touches Telegram or a DB.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createTelegramSupportBot,
  createTelegramTransport,
  buildForwardText,
  CUSTOMER_GUIDE_TEXT,
  DIRECTION_CUSTOMER,
  DIRECTION_BOT,
  DIRECTION_AGENT
} = require('../services/TelegramSupportService');

const TOKEN = '123456789:TEST-TOKEN-NOT-A-CREDENTIAL';
// Synthetic ids - production values are never embedded in a test file.
const GROUP_ID = '-1001234567890';
const OTHER_GROUP_ID = '-1007777777777';
const CUSTOMER_CHAT_ID = '555111';
const CONVERSATION_ID = 42;

let updateSeq = 7000;
const nextUpdateId = () => ++updateSeq;

// --------------------------------------------------------------------- harness ---

function createFakeStore({ username = 'john' } = {}) {
  const state = { conversations: [], messages: [], escalations: [] };
  const conversation = {
    id: CONVERSATION_ID,
    telegram_chat_id: Number(CUSTOMER_CHAT_ID),
    telegram_user_id: Number(CUSTOMER_CHAT_ID),
    username,
    display_name: username ? 'John Customer' : null
  };
  state.conversations.push(conversation);
  let messageSeq = 0;

  return {
    state,
    conversation,
    async getConversationByChatId(chatId) {
      return String(chatId) === String(conversation.telegram_chat_id) ? conversation : null;
    },
    async getConversationById(id) {
      return Number(id) === conversation.id ? conversation : null;
    },
    async upsertConversation() {
      return { conversation, created: false };
    },
    async insertMessage({ conversationId, direction, body }) {
      if (![DIRECTION_CUSTOMER, DIRECTION_BOT, DIRECTION_AGENT].includes(direction)) {
        throw new Error('bad direction ' + direction);
      }
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

/**
 * Real transport where possible; `failGroupSend` makes the GROUP send fail the
 * way Telegram does (a 400 with its own description) while customer sends keep
 * working - the production symptom.
 */
function createHarness({ groupId = GROUP_ID, failGroupSend = false, failSendMessage = false, lastCall = null } = {}) {
  const calls = [];
  const lines = [];
  const logger = { log() {}, warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) };
  const store = createFakeStore();

  let messageSeq = 500000;
  const fetchImpl = async (url, options) => {
    const method = String(url).split('/').pop();
    const payload = JSON.parse(options.body || '{}');
    const isGroup = String(payload.chat_id) === String(groupId);

    if (failSendMessage || (failGroupSend && isGroup)) {
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
  if (lastCall) transport.getLastCall = () => lastCall;

  const bot = createTelegramSupportBot({
    config: {
      token: TOKEN,
      supportChatId: groupId,
      // Pinned to the LEGACY target: this suite pins support-group forwarding.
      notifyTarget: 'group',
      adminIds: ['900001'],
      webhookSecret: 'test-webhook-secret',
      baseUrl: 'https://arbitrix.pro'
    },
    store,
    transport,
    logger
  });

  return {
    bot,
    store,
    logger,
    lines,
    calls,
    toGroup: () => calls.filter((c) => c.chatId === String(groupId)),
    toCustomer: () => calls.filter((c) => c.chatId === CUSTOMER_CHAT_ID)
  };
}

const customerMessage = (text, { username = 'john' } = {}) => ({
  update_id: nextUpdateId(),
  message: {
    message_id: nextUpdateId(),
    date: 1700000000,
    text,
    chat: { id: Number(CUSTOMER_CHAT_ID), type: 'private' },
    from: Object.assign(
      { id: Number(CUSTOMER_CHAT_ID), first_name: 'John' },
      username ? { username } : {}
    )
  }
});

const groupCommand = (text) => ({
  update_id: nextUpdateId(),
  message: {
    message_id: nextUpdateId(),
    date: 1700000000,
    text,
    chat: { id: Number(GROUP_ID), type: 'supergroup', title: 'Arbitrix Support' },
    from: { id: 900001, first_name: 'Agent' }
  }
});

// ------------------------------------------------- the forwarding happy path ---

test('a customer message is delivered to the configured support group', async () => {
  const h = createHarness({ bot: undefined });

  const result = await h.bot.handleUpdate(customerMessage('Hello, I need help with Arbitrix.'));

  assert.strictEqual(result.action, 'forwarded');
  const group = h.toGroup();
  assert.strictEqual(group.length, 1, 'exactly ONE message into the group');
  assert.match(group[0].text, /Hello, I need help with Arbitrix\./);
});

test('the group notification uses the CONFIGURED chat id, never the customer chat', async () => {
  const h = createHarness({ groupId: OTHER_GROUP_ID });
  await h.bot.handleUpdate(customerMessage('where is my deposit?'));

  const group = h.calls.filter((c) => c.chatId === OTHER_GROUP_ID);
  assert.strictEqual(group.length, 1, 'the configured group id is the target');
  assert.strictEqual(h.calls.filter((c) => c.chatId === GROUP_ID).length, 0,
    'no hardcoded/other group id is ever used');
  // the customer chat receives only the customer-facing reply
  h.toCustomer().forEach((c) => {
    assert.ok(!/New Customer Message/.test(c.text), 'the internal notification is never sent to the customer');
  });
});

test('the notification carries the conversation, the customer and the message', async () => {
  const h = createHarness();
  await h.bot.handleUpdate(customerMessage('Hello, I need help with Arbitrix.'));

  const text = h.toGroup()[0].text;
  assert.match(text, /🔔 New Customer Message/);
  assert.match(text, /Customer: @john/, 'the @username is shown when Telegram provides one');
  assert.match(text, new RegExp('Conversation: #' + CONVERSATION_ID));
  assert.match(text, new RegExp('Chat ID: ' + CUSTOMER_CHAT_ID), 'the raw chat id is shown for /reply');
  assert.match(text, /Message:\nHello, I need help with Arbitrix\./);
  assert.match(text, new RegExp('/reply ' + CONVERSATION_ID + ' <message>'));
});

test('a missing username falls back to the Telegram display name', async () => {
  // No @username anywhere -> the stored display name is used.
  const text = buildForwardText({ id: 7 }, CUSTOMER_CHAT_ID, 'John Customer', 'hi');
  assert.match(text, /Customer: John Customer/);

  const h = createHarness();
  h.store.conversation.username = null;
  h.store.conversation.display_name = 'John Customer';
  await h.bot.handleUpdate(customerMessage('hi there', { username: null }));
  assert.match(h.toGroup()[0].text, /Customer: John Customer/);
  assert.ok(!/@john/.test(h.toGroup()[0].text), 'no username is invented');
});

test('a live @username is preferred over a stale stored one', async () => {
  const h = createHarness();
  h.store.conversation.username = 'old_handle';
  h.store.conversation.display_name = 'Stale Name';
  await h.bot.handleUpdate(customerMessage('fresh handle', { username: 'john' }));
  assert.match(h.toGroup()[0].text, /Customer: @john/);
});

test('the customer reply is sent BEFORE the group notification', async () => {
  const h = createHarness();
  await h.bot.handleUpdate(customerMessage('ordering check'));

  const order = h.calls.map((c) => (c.chatId === String(GROUP_ID) ? 'group' : 'customer'));
  assert.deepStrictEqual(order, ['customer', 'group'],
    'the customer is answered first so the group can never delay or block it');
});

test('storage is preserved: the customer message and its reply are persisted', async () => {
  const h = createHarness();
  await h.bot.handleUpdate(customerMessage('persist me'));

  const customerRows = h.store.state.messages.filter((m) => m.direction === DIRECTION_CUSTOMER);
  const botRows = h.store.state.messages.filter((m) => m.direction === DIRECTION_BOT);
  assert.strictEqual(customerRows.length, 1);
  assert.strictEqual(customerRows[0].body, 'persist me');
  assert.strictEqual(customerRows[0].conversation_id, CONVERSATION_ID);
  assert.ok(botRows.length >= 1, 'the outbound reply is stored too');
});

test('the AI reply is untouched and reaches the customer while the group is notified', async () => {
  const store = createFakeStore();
  const calls = [];
  const logger = { log() {}, warn() {}, error() {} };
  const transport = createTelegramTransport({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body || '{}');
      const id = calls.length + 1;
      calls.push({ chatId: String(payload.chat_id), text: payload.text, messageId: id });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: id } }) };
    }
  });
  const bot = createTelegramSupportBot({
    config: { token: TOKEN, supportChatId: GROUP_ID, adminIds: [], notifyTarget: 'group', webhookSecret: 's', baseUrl: 'b' },
    store,
    transport,
    logger,
    supportAI: { isEnabled: () => true, providerName: () => 'stub', ask: async () => ({ answer: 'The minimum deposit is $100.' }) }
  });

  const result = await bot.handleUpdate(customerMessage('what is the minimum deposit?'));

  assert.strictEqual(result.action, 'forwarded');
  const toCustomer = calls.find((c) => c.chatId === CUSTOMER_CHAT_ID);
  assert.strictEqual(toCustomer.text, 'The minimum deposit is $100.', 'the AI answer is delivered verbatim');
  const toGroup = calls.filter((c) => c.chatId === GROUP_ID);
  assert.strictEqual(toGroup.length, 1);
  assert.match(toGroup[0].text, /what is the minimum deposit\?/);
  assert.strictEqual(bot.getStats().aiReplies, 1);
});

// ------------------------------------------------------ failure is contained ---

test('a Telegram rejection never breaks the customer response', async () => {
  const h = createHarness({ failGroupSend: true });

  const result = await h.bot.handleUpdate(customerMessage('group is broken'));

  assert.strictEqual(result.action, 'forward-failed');
  const toCustomer = h.toCustomer();
  assert.strictEqual(toCustomer.length, 1, 'the customer still receives exactly one reply');
  assert.strictEqual(toCustomer[0].text, CUSTOMER_GUIDE_TEXT);
  assert.strictEqual(h.store.state.messages.filter((m) => m.direction === DIRECTION_CUSTOMER).length, 1,
    'the customer message is still stored');
});

test('a group failure logs Telegram\'s real reason and records it for operators', async () => {
  const h = createHarness({ failGroupSend: true });
  await h.bot.handleUpdate(customerMessage('log the reason'));

  const failure = h.lines.filter((l) => l.includes('support group notification (customer-message) FAILED'));
  assert.strictEqual(failure.length, 1, 'logged exactly once');
  assert.ok(failure[0].includes('Bad Request: chat not found'), 'Telegram\'s own description is logged');
  assert.ok(failure[0].includes('http 400'), 'the HTTP status is logged');
  assert.ok(failure[0].includes(`conversation ${CONVERSATION_ID}`));

  const notify = h.bot.status().lastNotify;
  assert.strictEqual(notify.kind, 'customer-message');
  assert.strictEqual(notify.sent, false);
  assert.strictEqual(notify.skipped, false);
  assert.strictEqual(notify.error, 'Bad Request: chat not found');
  assert.strictEqual(notify.httpStatus, 400);
  assert.strictEqual(notify.errorCode, 400);
  assert.ok(h.bot.getStats().notificationsFailed >= 1);
});

test('an escalation failure logs the reason too (it used to log none)', async () => {
  const h = createHarness({ failGroupSend: true });
  await h.bot.handleUpdate(customerMessage('/escalate please help'));

  const failure = h.lines.filter((l) => l.includes('support group notification (escalation) FAILED'));
  assert.strictEqual(failure.length, 1);
  assert.ok(failure[0].includes('Bad Request: chat not found'), 'the escalation reason is now diagnosable');
  assert.strictEqual(h.bot.status().lastNotify.kind, 'escalation');
  assert.strictEqual(h.bot.status().lastNotify.sent, false);
});

test('a transport without getLastCall still reports a real reason', async () => {
  const store = createFakeStore();
  const logger = { log() {}, warn(m) { lines.push(m); }, error() {} };
  const lines = [];
  const transport = {
    async sendMessage(chatId) {
      if (String(chatId) === GROUP_ID) throw new Error('network ECONNRESET to telegram');
      return { message_id: 1 };
    }
    // deliberately no getLastCall
  };
  const bot = createTelegramSupportBot({
    config: { token: TOKEN, supportChatId: GROUP_ID, adminIds: [], notifyTarget: 'group', webhookSecret: 's', baseUrl: 'b' },
    store, transport, logger
  });

  const result = await bot.handleUpdate(customerMessage('no lastCall transport'));
  assert.strictEqual(result.action, 'forward-failed');
  assert.ok(lines.some((l) => l.includes('network ECONNRESET')), 'the thrown reason is logged');
  assert.strictEqual(bot.status().lastNotify.sent, false);
});

test('an unconfigured group is loud, never a silent no-op', async () => {
  const h = createHarness({ groupId: null });

  const result = await h.bot.handleUpdate(customerMessage('is anyone there?'));

  assert.strictEqual(result.action, 'stored-without-group');
  assert.strictEqual(h.calls.length, 1, 'no group send is even attempted');
  assert.strictEqual(h.toCustomer().length, 1, 'the customer is still answered');
  const skipped = h.lines.filter((l) => l.includes('SKIPPED'));
  assert.strictEqual(skipped.length, 1, 'the skip is logged');
  assert.ok(skipped[0].includes('TELEGRAM_SUPPORT_CHAT_ID'), 'it names the variable');
  assert.ok(/restart/i.test(skipped[0]), 'it says a restart is required');
  const notify = h.bot.status().lastNotify;
  assert.strictEqual(notify.skipped, true);
  assert.strictEqual(notify.sent, false);
  assert.strictEqual(h.bot.getStats().notificationsSkipped, 1);
});

// ------------------------------------------------------------ reply / escalate ---

test('/reply <conversation number> reaches the correct customer', async () => {
  const h = createHarness();
  await h.bot.handleUpdate(customerMessage('Hello, I need help with Arbitrix.'));

  const result = await h.bot.handleUpdate(groupCommand(
    `/reply ${CONVERSATION_ID} The minimum deposit is $100. Let me know if you need help with the deposit process.`
  ));

  assert.strictEqual(result.action, 'reply');
  const toCustomer = h.toCustomer().filter((c) => /minimum deposit is \$100/.test(c.text));
  assert.strictEqual(toCustomer.length, 1, 'the agent reply reached the customer');
  const stored = h.store.state.messages.filter((m) => /minimum deposit is \$100/.test(m.body));
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].direction, DIRECTION_AGENT, 'recorded as a human agent, never the bot');
});

test('/reply <chat id> still works exactly as before', async () => {
  const h = createHarness();
  await h.bot.handleUpdate(customerMessage('hello'));
  const result = await h.bot.handleUpdate(groupCommand(`/reply ${CUSTOMER_CHAT_ID} handled by chat id`));
  assert.strictEqual(result.action, 'reply');
  assert.strictEqual(h.toCustomer().filter((c) => /handled by chat id/.test(c.text)).length, 1);
});

test('/reply to an unknown target still reports instead of sending', async () => {
  const h = createHarness();
  const result = await h.bot.handleUpdate(groupCommand('/reply 999999 nobody here'));
  assert.strictEqual(result.action, 'reply-missing');
  assert.ok(h.toGroup().some((c) => /No conversation found/.test(c.text)));
  assert.strictEqual(h.toCustomer().length, 0, 'nothing is sent to a customer');
});

test('/escalate still stores the escalation, notifies the group and acks the customer', async () => {
  const h = createHarness();
  await h.bot.handleUpdate(customerMessage('/escalate deposit is stuck'));

  assert.strictEqual(h.store.state.escalations.length, 1, 'the escalation row is written');
  assert.ok(h.store.state.escalations[0].support_message_id, 'it references the stored message');
  const group = h.toGroup();
  assert.strictEqual(group.length, 1, 'the group is notified once');
  assert.match(group[0].text, /Escalation requested/);
  assert.match(group[0].text, /deposit is stuck/);
  assert.ok(h.toCustomer().some((c) => /human agent|support team/i.test(c.text)), 'the customer is acknowledged');
});

test('/close still works by conversation number', async () => {
  const h = createHarness();
  await h.bot.handleUpdate(customerMessage('closing soon'));
  const result = await h.bot.handleUpdate(groupCommand(`/close ${CONVERSATION_ID}`));
  assert.strictEqual(result.action, 'close');
  assert.ok(h.toGroup().some((c) => new RegExp(`Conversation #${CONVERSATION_ID} closed`).test(c.text)));
});

// -------------------------------------------------------- anti-duplication ---

test('one customer message produces exactly one group notification', async () => {
  const h = createHarness();
  await h.bot.handleUpdate(customerMessage('only once please'));
  await h.bot.handleUpdate(groupCommand(`/reply ${CONVERSATION_ID} thanks`));
  await h.bot.handleUpdate(groupCommand(`/close ${CONVERSATION_ID}`));

  const notifications = h.toGroup().filter((c) => /New Customer Message/.test(c.text));
  assert.strictEqual(notifications.length, 1, 'replies and closes must not re-notify the group');
});

test('a redelivered update is deduplicated (no second group notification)', async () => {
  const h = createHarness();
  const update = customerMessage('redelivered');
  await h.bot.handleUpdate(update);
  const again = await h.bot.handleUpdate(update);

  // handled:true keeps Telegram's retry harmless (it answers 200) - the action
  // is what records that nothing was processed twice.
  assert.strictEqual(again.action, 'duplicate');
  assert.strictEqual(h.toGroup().filter((c) => /New Customer Message/.test(c.text)).length, 1);
});

test('a failed group notification is not retried (no duplicate into the group)', async () => {
  const h = createHarness({ failGroupSend: true });
  await h.bot.handleUpdate(customerMessage('do not retry'));

  const attempts = h.calls.filter((c) => c.chatId === String(GROUP_ID));
  assert.strictEqual(attempts.length, 0, 'the failed attempt is not recorded as a call');
  assert.ok(h.bot.getStats().notificationsFailed >= 1);
  assert.strictEqual(h.bot.getStats().notificationsSent, 0);
});

// ------------------------------------------------------------ authorization ---

test('group commands stay admin-only', async () => {
  const h = createHarness();
  const stranger = {
    update_id: nextUpdateId(),
    message: {
      message_id: nextUpdateId(),
      date: 1700000000,
      text: `/reply ${CONVERSATION_ID} hello`,
      chat: { id: Number(GROUP_ID), type: 'supergroup', title: 'Arbitrix Support' },
      from: { id: 424242, first_name: 'Stranger' }
    }
  };
  const result = await h.bot.handleUpdate(stranger);
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'non-admin-group-message');
  assert.strictEqual(h.calls.length, 0, 'a non-admin can neither read nor send');
});

test('the internal notification never reaches the customer on any path', async () => {
  const h = createHarness();
  await h.bot.handleUpdate(customerMessage('escalation path'));
  await h.bot.handleUpdate(customerMessage('/escalate now'));
  await h.bot.handleUpdate(groupCommand(`/reply ${CONVERSATION_ID} agent reply`));

  h.toCustomer().forEach((c) => {
    assert.ok(!/New Customer Message/.test(c.text), c.text);
    assert.ok(!/Escalation requested/.test(c.text), c.text);
    assert.ok(!/Conversation: #/.test(c.text), c.text);
  });
});
