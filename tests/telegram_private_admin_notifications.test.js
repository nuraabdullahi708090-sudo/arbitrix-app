'use strict';

/**
 * Private-admin notifications (the DEFAULT notification target).
 *
 * One deliverable is pinned here: a customer message and a customer /escalate
 * each notify every TELEGRAM_ADMIN_IDS entry in a DIRECT PRIVATE CHAT, and
 * TELEGRAM_SUPPORT_CHAT_ID is no longer used for customer notifications.
 *
 * Everything else that makes the feature usable is pinned too:
 *   - a configured admin messaging the bot one-to-one is recognised as an
 *     OPERATOR, so /reply, /close, /escalate, /chatid, /help and replying to a
 *     notification all work in the private chat they are notified in;
 *   - a non-admin private chat is still an ordinary customer conversation;
 *   - the customer experience is untouched: the acknowledgement still goes
 *     BEFORE the notification, storage is unchanged, and a notification failure
 *     can never break the customer's reply;
 *   - one unreachable admin never stops the others;
 *   - TELEGRAM_NOTIFY_TARGET=group restores the legacy path completely.
 *
 * The real bot, the real routing, the real notification text and the real
 * canonicalization are exercised with a fake store and a fake transport, so
 * nothing touches Telegram or a database.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createTelegramSupportBot,
  createTelegramTransport,
  resolveTelegramConfig,
  resolveNotifyTarget,
  routeUpdate,
  buildForwardText,
  CUSTOMER_GUIDE_TEXT,
  DIRECTION_CUSTOMER,
  DIRECTION_AGENT,
  NOTIFY_TARGET_ADMINS,
  NOTIFY_TARGET_GROUP
} = require('../services/TelegramSupportService');

const TOKEN = '123456789:TEST-TOKEN-NOT-A-CREDENTIAL';
// Synthetic ids - production values are never embedded in a test file.
const ADMIN_A = '6054625818';
const ADMIN_B = '700700700';
const ADMIN_C = '700700701';
const STRANGER = '999000999';
const GROUP_ID = '-1001234567890';
const CUSTOMER_CHAT_ID = '555111';
const CONVERSATION_ID = 42;

let updateSeq = 20000;
const nextUpdateId = () => ++updateSeq;

const fullWidthDigits = (value) =>
  String(value).replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d)));

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
 * Real transport on top of a fake fetch. `failChatIds` makes a send to a given
 * chat fail exactly the way Telegram fails for an admin who never started the
 * bot, while other recipients keep working.
 */
function createHarness({
  adminIds = [ADMIN_A],
  supportChatId = null,
  notifyTarget,
  failChatIds = []
} = {}) {
  const calls = [];
  const lines = [];
  const logger = { log() {}, warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) };
  const store = createFakeStore();

  let messageSeq = 900000;
  const fetchImpl = async (url, options) => {
    const method = String(url).split('/').pop();
    const payload = JSON.parse(options.body || '{}');
    if (failChatIds.map(String).includes(String(payload.chat_id))) {
      return {
        ok: false,
        status: 403,
        json: async () => ({
          ok: false,
          error_code: 403,
          description: "Forbidden: bot can't initiate conversation with a user"
        })
      };
    }
    const messageId = ++messageSeq;
    calls.push({ method, chatId: String(payload.chat_id), text: payload.text, messageId });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: messageId } }) };
  };

  const transport = createTelegramTransport({ token: TOKEN, fetchImpl });
  const config = {
    token: TOKEN,
    adminIds,
    webhookSecret: 'test-webhook-secret',
    baseUrl: 'https://arbitrix.pro'
  };
  if (supportChatId !== null) config.supportChatId = supportChatId;
  // Only set when the test asks for it, so "the default target" is really tested.
  if (notifyTarget !== undefined) config.notifyTarget = notifyTarget;

  const bot = createTelegramSupportBot({ config, store, transport, logger });

  return {
    bot,
    store,
    logger,
    calls,
    lines,
    toChat: (id) => calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(id)),
    textTo: (id) => calls.filter((c) => c.chatId === String(id)).map((c) => c.text).join('\n'),
    notifiedChatIds: () => calls
      .filter((c) => c.chatId !== CUSTOMER_CHAT_ID && c.text.includes('New Customer Message'))
      .map((c) => c.chatId)
  };
}

function customerMessage(text, { updateId } = {}) {
  return {
    update_id: updateId === undefined ? nextUpdateId() : updateId,
    message: {
      message_id: 1,
      from: { id: Number(CUSTOMER_CHAT_ID), username: 'john' },
      chat: { id: Number(CUSTOMER_CHAT_ID), type: 'private' },
      text
    }
  };
}

function adminMessage(text, { adminId = ADMIN_A, replyTo, updateId } = {}) {
  const message = {
    message_id: 50,
    from: { id: Number(adminId), username: 'ops' },
    chat: { id: Number(adminId), type: 'private' },
    text
  };
  if (replyTo !== undefined) message.reply_to_message = { message_id: replyTo };
  return { update_id: updateId === undefined ? nextUpdateId() : updateId, message };
}

// ------------------------------------------------------------------ targeting ---

test('the default notification target is the admins, and the group is not used', () => {
  assert.strictEqual(resolveNotifyTarget(undefined), NOTIFY_TARGET_ADMINS);
  assert.strictEqual(resolveNotifyTarget(''), NOTIFY_TARGET_ADMINS);
  assert.strictEqual(resolveNotifyTarget('   '), NOTIFY_TARGET_ADMINS);
  // A typo must never silently re-enable group forwarding.
  assert.strictEqual(resolveNotifyTarget('grup'), NOTIFY_TARGET_ADMINS);
  assert.strictEqual(resolveNotifyTarget('GROUP'), NOTIFY_TARGET_GROUP);
  assert.strictEqual(resolveNotifyTarget(' group '), NOTIFY_TARGET_GROUP);

  // A group configured in the environment does NOT become the target.
  const cfg = resolveTelegramConfig({ TELEGRAM_ADMIN_IDS: ADMIN_A, TELEGRAM_SUPPORT_CHAT_ID: GROUP_ID });
  assert.strictEqual(cfg.notifyTarget, NOTIFY_TARGET_ADMINS);
});

test('a customer message notifies the admins privately and never the support group', async () => {
  const h = createHarness({ adminIds: [ADMIN_A], supportChatId: GROUP_ID });
  const result = await h.bot.handleUpdate(customerMessage('hello there'));

  assert.strictEqual(result.action, 'forwarded');
  assert.strictEqual(h.toChat(ADMIN_A).length, 1, 'the admin is notified exactly once');
  assert.strictEqual(h.toChat(GROUP_ID).length, 0, 'TELEGRAM_SUPPORT_CHAT_ID is no longer used for notifications');

  const text = h.textTo(ADMIN_A);
  assert.ok(text.includes('New Customer Message'));
  assert.ok(text.includes('hello there'));
  assert.ok(text.includes(`Chat ID: ${CUSTOMER_CHAT_ID}`));
  assert.ok(text.includes(`/reply ${CONVERSATION_ID}`));
});

test('the notification no longer tells the admin to reply to a group message', async () => {
  const h = createHarness({ adminIds: [ADMIN_A] });
  await h.bot.handleUpdate(customerMessage('check the wording'));
  const text = h.textTo(ADMIN_A);

  assert.ok(text.includes('here in this chat'), 'the instruction is anchored to the private chat');
  assert.ok(!/support group/i.test(text));
  assert.ok(!/in the group/i.test(text));

  // The builder itself carries the same guarantee.
  const built = buildForwardText({ id: CONVERSATION_ID }, CUSTOMER_CHAT_ID, 'john', 'hi');
  assert.ok(built.includes('here in this chat'));
  assert.ok(!/support group/i.test(built));
});

test('the customer acknowledgement is still sent BEFORE the notification', async () => {
  const h = createHarness({ adminIds: [ADMIN_A], supportChatId: GROUP_ID });
  await h.bot.handleUpdate(customerMessage('ordering matters'));

  const toCustomer = h.toChat(CUSTOMER_CHAT_ID);
  const toAdmin = h.toChat(ADMIN_A);
  assert.strictEqual(toCustomer.length, 1);
  assert.strictEqual(toCustomer[0].text, CUSTOMER_GUIDE_TEXT);
  assert.ok(h.calls.indexOf(toCustomer[0]) < h.calls.indexOf(toAdmin[0]),
    'the customer is answered before any operator notification');

  // storage is untouched: the customer message is still persisted
  assert.strictEqual(
    h.store.state.messages.filter((m) => m.direction === DIRECTION_CUSTOMER).length, 1);
});

test('every configured admin id is notified once, each with its own message id', async () => {
  const h = createHarness({ adminIds: [ADMIN_A, ADMIN_B, ADMIN_C], supportChatId: GROUP_ID });
  const result = await h.bot.handleUpdate(customerMessage('notify all three'));

  assert.strictEqual(result.action, 'forwarded');
  for (const id of [ADMIN_A, ADMIN_B, ADMIN_C]) {
    assert.strictEqual(h.toChat(id).length, 1, `admin ${id} is notified exactly once`);
  }
  assert.deepStrictEqual(h.notifiedChatIds().sort(), [ADMIN_A, ADMIN_B, ADMIN_C].sort());

  const ids = [ADMIN_A, ADMIN_B, ADMIN_C].map((id) => h.toChat(id)[0].messageId);
  assert.strictEqual(new Set(ids).size, 3, 'each admin got a distinct message');

  const notify = h.bot.status().lastNotify;
  assert.strictEqual(notify.recipients, 3);
  assert.strictEqual(notify.sentCount, 3);
  assert.strictEqual(notify.failedCount, 0);
  assert.strictEqual(notify.target, NOTIFY_TARGET_ADMINS);
});

test('with no admins configured nothing is sent anywhere and the skip is loud', async () => {
  const h = createHarness({ adminIds: [], supportChatId: GROUP_ID });
  const result = await h.bot.handleUpdate(customerMessage('anyone there?'));

  // Neither the admins nor the (configured) legacy group receive anything.
  assert.strictEqual(h.notifiedChatIds().length, 0);
  assert.strictEqual(h.toChat(GROUP_ID).length, 0);
  assert.strictEqual(result.action, 'stored-without-group');

  assert.ok(h.lines.some((l) => l.includes('SKIPPED') && l.includes('TELEGRAM_ADMIN_IDS')),
    'the missing recipient list is logged loudly');

  const notify = h.bot.status().lastNotify;
  assert.strictEqual(notify.skipped, true);
  assert.strictEqual(notify.recipients, 0);
  assert.strictEqual(notify.target, NOTIFY_TARGET_ADMINS);
  assert.strictEqual(h.bot.getStats().notificationsSkipped, 1);
});

test('one unreachable admin does not stop the others being notified', async () => {
  const h = createHarness({ adminIds: [ADMIN_A, ADMIN_B], failChatIds: [ADMIN_B] });
  const result = await h.bot.handleUpdate(customerMessage('partial delivery'));

  assert.strictEqual(result.action, 'forwarded', 'a partial success is still a success');
  assert.strictEqual(h.toChat(ADMIN_A).length, 1);
  assert.strictEqual(h.toChat(ADMIN_B).length, 0);

  const notify = h.bot.status().lastNotify;
  assert.strictEqual(notify.recipients, 2);
  assert.strictEqual(notify.sentCount, 1);
  assert.strictEqual(notify.failedCount, 1);
  assert.ok(h.lines.some((l) => l.includes('support admin notification (customer-message) FAILED for 1/2')));

  // The customer still got a reply and the message is still stored.
  assert.strictEqual(h.toChat(CUSTOMER_CHAT_ID).length, 1);
  assert.strictEqual(
    h.store.state.messages.filter((m) => m.direction === DIRECTION_CUSTOMER).length, 1);
});

test('a pasted admin id is canonicalized before it is used as a recipient', async () => {
  const cfg = resolveTelegramConfig({
    TELEGRAM_ADMIN_IDS: `${fullWidthDigits(ADMIN_B)}, "${ADMIN_A}"`
  });
  assert.deepStrictEqual(cfg.adminIds, [ADMIN_B, ADMIN_A]);

  const h = createHarness({ adminIds: cfg.adminIds });
  await h.bot.handleUpdate(customerMessage('canonicalized recipients'));
  assert.strictEqual(h.toChat(ADMIN_B).length, 1);
  assert.strictEqual(h.toChat(ADMIN_A).length, 1);
});

// ----------------------------------------------------------- customer /escalate ---

test('a customer /escalate notifies every admin and keeps the escalation record', async () => {
  const h = createHarness({ adminIds: [ADMIN_A, ADMIN_B], supportChatId: GROUP_ID });
  const result = await h.bot.handleUpdate(customerMessage('/escalate please help me'));

  assert.strictEqual(result.action, 'escalate');
  assert.strictEqual(h.toChat(GROUP_ID).length, 0, 'the group is not used');
  for (const id of [ADMIN_A, ADMIN_B]) {
    assert.strictEqual(h.toChat(id).length, 1);
    assert.ok(h.textTo(id).includes('Escalation requested'));
    assert.ok(h.textTo(id).includes('please help me'), 'the reason reaches the admins');
  }

  // the escalation row is the record and still references the stored message
  assert.strictEqual(h.store.state.escalations.length, 1);
  assert.strictEqual(h.store.state.escalations[0].conversation_id, CONVERSATION_ID);
  assert.strictEqual(h.store.state.escalations[0].support_message_id, 1);

  // and the customer is still acknowledged
  assert.strictEqual(h.toChat(CUSTOMER_CHAT_ID).length, 1);
});

// ------------------------------------------------------- admin private commands ---

test('routing: a private admin is an operator, a private stranger is a customer', () => {
  const adminRoute = routeUpdate(adminMessage('/reply 42 hi'), { adminIds: [ADMIN_A], notifyTarget: NOTIFY_TARGET_ADMINS });
  assert.strictEqual(adminRoute.kind, 'admin');
  assert.strictEqual(adminRoute.isAdmin, true);

  const strangerRoute = routeUpdate(adminMessage('hi', { adminId: STRANGER }), { adminIds: [ADMIN_A], notifyTarget: NOTIFY_TARGET_ADMINS });
  assert.strictEqual(strangerRoute.kind, 'user', 'a non-admin DM stays a customer conversation');

  const legacyRoute = routeUpdate(adminMessage('/reply 42 hi'), { adminIds: [ADMIN_A], notifyTarget: NOTIFY_TARGET_GROUP });
  assert.strictEqual(legacyRoute.kind, 'user', 'legacy mode does not recognise private admins');
});

test('an admin can /reply to a customer from their private chat', async () => {
  const h = createHarness({ adminIds: [ADMIN_A] });
  const result = await h.bot.handleUpdate(adminMessage(`/reply ${CONVERSATION_ID} we are on it`));

  assert.strictEqual(result.action, 'reply');
  const toCustomer = h.toChat(CUSTOMER_CHAT_ID);
  assert.strictEqual(toCustomer.length, 1);
  assert.strictEqual(toCustomer[0].text, 'we are on it');
  assert.ok(h.textTo(ADMIN_A).includes(`Sent to chat ${CUSTOMER_CHAT_ID}`));

  // recorded as an AGENT message, never as the bot
  const agent = h.store.state.messages.filter((m) => m.direction === DIRECTION_AGENT);
  assert.strictEqual(agent.length, 1);
  assert.strictEqual(agent[0].body, 'we are on it');
});

test('a stranger DMing the bot is still handled as a customer conversation', async () => {
  const h = createHarness({ adminIds: [ADMIN_A] });
  const result = await h.bot.handleUpdate(adminMessage('/reply 42 leaked', { adminId: STRANGER }));

  // Not an operator action: it is an ordinary customer message.
  assert.strictEqual(result.action, 'forwarded');
  assert.strictEqual(h.store.state.messages.filter((m) => m.direction === DIRECTION_AGENT).length, 0,
    'a stranger cannot make the bot reply to a customer');
  // The stranger goes through the CUSTOMER path, so they get the standard guide
  // acknowledgement. (The fake store returns one canned conversation, so that
  // reply is delivered to that conversation's chat id.)
  assert.strictEqual(h.toChat(CUSTOMER_CHAT_ID).length, 1);
  assert.strictEqual(h.toChat(CUSTOMER_CHAT_ID)[0].text, CUSTOMER_GUIDE_TEXT);
  assert.strictEqual(h.toChat(ADMIN_A).length, 1, 'the admin is notified about it');
});

test('an admin can /close a conversation from their private chat', async () => {
  const h = createHarness({ adminIds: [ADMIN_A] });
  const result = await h.bot.handleUpdate(adminMessage(`/close ${CONVERSATION_ID}`));

  assert.strictEqual(result.action, 'close');
  assert.ok(h.textTo(ADMIN_A).includes(`Conversation #${CONVERSATION_ID} closed.`));
});

test('an admin can /escalate from their private chat and the row is written', async () => {
  const h = createHarness({ adminIds: [ADMIN_A] });
  // The live table requires support_message_id, so a stored customer message is needed.
  await h.bot.handleUpdate(customerMessage('the customer message being escalated'));

  const result = await h.bot.handleUpdate(adminMessage(`/escalate ${CONVERSATION_ID} needs follow-up`));
  assert.strictEqual(result.action, 'escalate');
  assert.strictEqual(h.store.state.escalations.length, 1);
  assert.ok(h.textTo(ADMIN_A).includes(`Conversation #${CONVERSATION_ID} escalated.`));
});

test('an admin can read their chat id privately, with guidance that matches the mode', async () => {
  const h = createHarness({ adminIds: [ADMIN_A] });
  const result = await h.bot.handleUpdate(adminMessage('/chatid'));

  assert.strictEqual(result.action, 'chatid');
  const reply = h.textTo(ADMIN_A);
  assert.ok(reply.includes(`Chat ID: ${ADMIN_A}`));
  assert.ok(reply.includes('TELEGRAM_ADMIN_IDS'), 'the admin is told which variable matters');
  assert.ok(!reply.includes('Set TELEGRAM_SUPPORT_CHAT_ID'),
    'no group-forwarding instruction while notifications are private');
});

test('an admin private /help describes notifications, not group commands', async () => {
  const h = createHarness({ adminIds: [ADMIN_A] });
  const result = await h.bot.handleUpdate(adminMessage('/help'));

  assert.strictEqual(result.action, 'help');
  const help = h.textTo(ADMIN_A);
  assert.ok(help.includes('Arbitrix support notifications'));
  assert.ok(!/support group commands/i.test(help));
  assert.ok(help.includes('/reply'));
  assert.ok(help.includes('/escalate'));
});

// ------------------------------------------------------ reply-to-notification ---

test('an admin can answer by replying to the notification they received', async () => {
  const h = createHarness({ adminIds: [ADMIN_A] });
  await h.bot.handleUpdate(customerMessage('I need help with my deposit'));

  const notification = h.toChat(ADMIN_A)[0];
  assert.ok(notification, 'the admin was notified first');
  const result = await h.bot.handleUpdate(adminMessage('Your deposit will be credited shortly.', { replyTo: notification.messageId }));

  assert.strictEqual(result.action, 'admin-reply');
  const agent = h.store.state.messages.filter((m) => m.direction === DIRECTION_AGENT);
  assert.strictEqual(agent.length, 1);
  assert.strictEqual(agent[0].body, 'Your deposit will be credited shortly.');

  // delivered to the CUSTOMER, not echoed into the admin chat
  const toCustomer = h.toChat(CUSTOMER_CHAT_ID);
  assert.strictEqual(toCustomer.pop().text, 'Your deposit will be credited shortly.');
});

test('with several admins, a reply from ANY of them reaches the customer', async () => {
  const h = createHarness({ adminIds: [ADMIN_A, ADMIN_B] });
  await h.bot.handleUpdate(customerMessage('multi admin threading'));

  const secondAdminNotification = h.toChat(ADMIN_B)[0];
  assert.ok(secondAdminNotification, 'the second admin was notified too');
  assert.notStrictEqual(secondAdminNotification.messageId, h.toChat(ADMIN_A)[0].messageId);

  const result = await h.bot.handleUpdate(
    adminMessage('answer from the second admin', { adminId: ADMIN_B, replyTo: secondAdminNotification.messageId }));
  assert.strictEqual(result.action, 'admin-reply');
  assert.strictEqual(h.toChat(CUSTOMER_CHAT_ID).pop().text, 'answer from the second admin');
});

test('a reply to an unmapped message is never sent to a customer', async () => {
  const h = createHarness({ adminIds: [ADMIN_A] });
  const result = await h.bot.handleUpdate(adminMessage('random reply', { replyTo: 424242 }));

  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'reply-unmapped');
  assert.strictEqual(h.store.state.messages.filter((m) => m.direction === DIRECTION_AGENT).length, 0);
});

// ------------------------------------------------------------------ revert path ---

test('TELEGRAM_NOTIFY_TARGET=group restores the legacy path completely', async () => {
  const h = createHarness({ adminIds: [ADMIN_A], supportChatId: GROUP_ID, notifyTarget: NOTIFY_TARGET_GROUP });

  const result = await h.bot.handleUpdate(customerMessage('legacy mode'));
  assert.strictEqual(result.action, 'forwarded');
  assert.strictEqual(h.toChat(GROUP_ID).length, 1, 'the group is notified again');
  assert.strictEqual(h.toChat(ADMIN_A).length, 0, 'admins are NOT notified in legacy mode');
  assert.strictEqual(h.bot.status().notifyTarget, NOTIFY_TARGET_GROUP);

  // and a private admin is an ordinary customer again, exactly as before
  const privateResult = await h.bot.handleUpdate(adminMessage('/reply 42 hi'));
  assert.strictEqual(privateResult.action, 'forwarded');
});

// -------------------------------------------------------------- status accuracy ---

test('status reports the active target and the real recipient count', async () => {
  const admins = createHarness({ adminIds: [ADMIN_A, ADMIN_B] });
  assert.strictEqual(admins.bot.status().notifyTarget, NOTIFY_TARGET_ADMINS);
  assert.strictEqual(admins.bot.status().notifyRecipients, 2);

  const group = createHarness({ adminIds: [ADMIN_A], supportChatId: GROUP_ID, notifyTarget: NOTIFY_TARGET_GROUP });
  assert.strictEqual(group.bot.status().notifyTarget, NOTIFY_TARGET_GROUP);
  assert.strictEqual(group.bot.status().notifyRecipients, 1);

  // No admins and no group -> zero recipients, reported honestly.
  const none = createHarness({ adminIds: [] });
  assert.strictEqual(none.bot.status().notifyRecipients, 0);

  // The status payload never leaks a chat id, token or message text.
  await admins.bot.handleUpdate(customerMessage('secret-free status'));
  const notify = admins.bot.status().lastNotify;
  assert.strictEqual(notify.chatId, undefined);
  assert.ok(!JSON.stringify(notify).includes(ADMIN_A));
  assert.ok(!JSON.stringify(notify).includes(TOKEN));
  assert.ok(!JSON.stringify(notify).includes('secret-free status'));
});

test('a notification failure never breaks the customer reply', async () => {
  const h = createHarness({ adminIds: [ADMIN_A, ADMIN_B], failChatIds: [ADMIN_A, ADMIN_B] });
  const result = await h.bot.handleUpdate(customerMessage('all recipients fail'));

  assert.strictEqual(result.action, 'forward-failed');
  assert.strictEqual(h.toChat(CUSTOMER_CHAT_ID).length, 1, 'the customer is still answered');
  assert.strictEqual(h.toChat(CUSTOMER_CHAT_ID)[0].text, CUSTOMER_GUIDE_TEXT);
  assert.strictEqual(
    h.store.state.messages.filter((m) => m.direction === DIRECTION_CUSTOMER).length, 1);
  assert.ok(h.lines.some((l) => l.includes('FAILED for 2/2')));
});
