'use strict';

/**
 * `/chatid` and `/id` from a group: answered PRIVATELY to a configured operator.
 *
 * The command was previously answered only inside the configured support group.
 * Any other group was ignored outright, so an operator adding the bot to a new
 * group (e.g. the partner/marketing group) got silence and no way to learn the
 * chat id without detaching the production webhook.
 *
 * Pinned here:
 *   - a configured operator gets the id in a PRIVATE message from any group;
 *   - the id is NEVER posted into the group when delivery succeeds;
 *   - a non-operator in any group is still ignored silently (no oracle);
 *   - only /chatid and /id are accepted from a foreign group - /help, /reply
 *     and everything else stay ignored;
 *   - the configured support group and the no-support-group bootstrap keep
 *     their exact previous behaviour;
 *   - if the operator never started the bot privately (Telegram 403) a short,
 *     ID-FREE notice is posted in the group instead;
 *   - the webhook still fails closed, and routing config is never mutated.
 *
 * The real bot, the real router, the real handler and the real transport are
 * exercised with a fake store and a fake fetch. Nothing touches Telegram or a DB.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createTelegramSupportBot,
  createTelegramTransport,
  createTelegramWebhookHandler,
  routeUpdate
} = require('../services/TelegramSupportService');

const TOKEN = '123456789:TEST-TOKEN-NOT-A-CREDENTIAL';
const WEBHOOK_SECRET = 'test-webhook-secret';
const ADMIN = '6054625818';
const OTHER_ADMIN = '700700700';
const STRANGER = '999000999';
const PARTNER_GROUP = '-1001234567890';
const SUPPORT_GROUP = '-1009999999999';
const CUSTOMER_CHAT_ID = '555111';

let updateSeq = 40000;
const nextUpdateId = () => ++updateSeq;

const silentLogger = { log() {}, warn() {}, error() {} };

function createFakeStore() {
  return {
    async getConversationByChatId() { return null; },
    async getConversationById() { return null; },
    async upsertConversation({ chatId, telegramUserId, username, displayName }) {
      return {
        conversation: {
          id: 1,
          telegram_chat_id: Number(chatId),
          telegram_user_id: Number(telegramUserId),
          username: username || null,
          display_name: displayName || null
        },
        created: true
      };
    },
    async insertMessage({ conversationId, direction, body }) {
      return { message: { id: 1, conversation_id: conversationId, direction, body } };
    },
    async getLatestMessageByConversation() { return null; },
    async createEscalation() { return { id: 1 }; },
    async setConversationStatus() { return true; },
    async probeColumns() { return true; }
  };
}

/**
 * Real transport over a fake fetch. `failChatIds` reproduces Telegram's 403 for
 * a chat the bot has never been allowed to message.
 */
function createHarness({ adminIds = [ADMIN], supportChatId = SUPPORT_GROUP, failChatIds = [] } = {}) {
  const calls = [];
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
    calls.push({ method, chatId: String(payload.chat_id), text: payload.text });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: messageId } }) };
  };

  const transport = createTelegramTransport({ token: TOKEN, fetchImpl });
  const config = { token: TOKEN, adminIds, webhookSecret: WEBHOOK_SECRET, baseUrl: 'https://arbitrix.pro' };
  if (supportChatId !== null) config.supportChatId = supportChatId;

  const bot = createTelegramSupportBot({ config, store: createFakeStore(), transport, logger: silentLogger });

  return {
    bot,
    config,
    calls,
    toChat: (id) => calls.filter((c) => c.chatId === String(id)),
    textTo: (id) => calls.filter((c) => c.chatId === String(id)).map((c) => c.text).join('\n')
  };
}

function groupUpdate({ chatId = PARTNER_GROUP, type = 'supergroup', fromId = ADMIN, text = '/chatid', username = 'operator', title = 'Arbitrix Partners', updateId } = {}) {
  return {
    update_id: updateId === undefined ? nextUpdateId() : updateId,
    message: {
      message_id: 10,
      from: { id: Number(fromId), username, first_name: 'Operator' },
      chat: { id: Number(chatId), type, title },
      text
    }
  };
}

// --------------------------------------------------------------- authorized ---

test('an operator gets the id privately from a group the bot does not serve', async () => {
  const h = createHarness();
  const result = await h.bot.handleUpdate(groupUpdate());

  assert.strictEqual(result.action, 'chatid-private');
  assert.strictEqual(h.calls.length, 1, 'exactly one message, and only to the operator');
  const [dm] = h.toChat(ADMIN);
  assert.ok(dm, 'the operator received a private message');
  assert.match(dm.text, new RegExp(`Chat ID: ${PARTNER_GROUP}`));
  assert.match(dm.text, /Chat type: supergroup/);
  assert.match(dm.text, /Chat title: Arbitrix Partners/);
  assert.match(dm.text, new RegExp(`Your user ID: ${ADMIN}`));
  assert.match(dm.text, /TELEGRAM_MARKETING_CHAT_ID/);
  assert.deepStrictEqual(h.toChat(PARTNER_GROUP), [], 'nothing was posted into the group');
});

test('/id is an alias and the addressed form /chatid@Bot works', async () => {
  for (const text of ['/id', '/chatid@ArbitrixSupportBot', '/ID']) {
    const h = createHarness();
    const result = await h.bot.handleUpdate(groupUpdate({ text }));
    assert.strictEqual(result.action, 'chatid-private', text + ' should be answered');
    assert.match(h.textTo(ADMIN), new RegExp(`Chat ID: ${PARTNER_GROUP}`), text);
    assert.deepStrictEqual(h.toChat(PARTNER_GROUP), [], text + ' must not post into the group');
  }
});

test('every configured operator is authorised, not just the first', async () => {
  const h = createHarness({ adminIds: [ADMIN, OTHER_ADMIN] });
  const result = await h.bot.handleUpdate(groupUpdate({ fromId: OTHER_ADMIN }));
  assert.strictEqual(result.action, 'chatid-private');
  assert.match(h.textTo(OTHER_ADMIN), new RegExp(`Chat ID: ${PARTNER_GROUP}`));
  assert.deepStrictEqual(h.toChat(ADMIN), []);
});

test('the chat id is canonical (negative, numeric) and not a user id', async () => {
  const h = createHarness();
  await h.bot.handleUpdate(groupUpdate());
  const dm = h.textTo(ADMIN);
  const id = dm.match(/Chat ID: (-?\d+)/)[1];
  assert.ok(id.startsWith('-'), 'a group id is negative');
  assert.strictEqual(id, PARTNER_GROUP);
  assert.notStrictEqual(dm.match(/Your user ID: (\d+)/)[1], id, 'the group id and the user id differ');
});

// ------------------------------------------------------------- unauthorized ---

test('a non-operator is ignored in any group, with no reply at all', async () => {
  const h = createHarness();
  const result = await h.bot.handleUpdate(groupUpdate({ fromId: STRANGER }));
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'other-group');
  assert.strictEqual(h.calls.length, 0, 'no oracle: an outsider gets nothing');
  assert.strictEqual(h.bot.getStats().lastAction, 'ignored');
});

test('only /chatid and /id are accepted from a foreign group', async () => {
  for (const text of ['/help', '/reply 42 hello', '/close 42', '/escalate', 'hello there']) {
    const h = createHarness();
    const result = await h.bot.handleUpdate(groupUpdate({ text }));
    assert.strictEqual(h.calls.length, 0, text + ' must not trigger a send');
    assert.strictEqual(result.handled, false, text + ' must stay ignored');
  }
});

test('an operator in a foreign DAILY-group (chat.type group) is also served', async () => {
  const h = createHarness();
  const result = await h.bot.handleUpdate(groupUpdate({ type: 'group' }));
  assert.strictEqual(result.action, 'chatid-private');
  assert.match(h.textTo(ADMIN), /Chat type: group/);
});

// --------------------------------------------------- existing behaviour kept ---

test('the configured support group still answers IN the group (unchanged)', async () => {
  const h = createHarness();
  const result = await h.bot.handleUpdate(groupUpdate({ chatId: SUPPORT_GROUP, title: 'Support' }));
  assert.strictEqual(result.action, 'chatid');
  const [reply] = h.toChat(SUPPORT_GROUP);
  assert.ok(reply, 'the support group reply is preserved');
  assert.match(reply.text, new RegExp(`Chat ID: ${SUPPORT_GROUP}`));
  assert.deepStrictEqual(h.toChat(ADMIN), [], 'no private copy for the support group');
});

test('the no-support-group bootstrap keeps its previous routing', async () => {
  // chatid/id now go private, but every other operator command still uses the
  // group as the console, and a stranger is still refused.
  const h = createHarness({ supportChatId: null });
  const chatid = await h.bot.handleUpdate(groupUpdate({ text: '/chatid' }));
  assert.strictEqual(chatid.action, 'chatid-private');
  assert.match(h.textTo(ADMIN), new RegExp(`Chat ID: ${PARTNER_GROUP}`));

  const help = createHarness({ supportChatId: null });
  const helpResult = await help.bot.handleUpdate(groupUpdate({ text: '/help' }));
  assert.strictEqual(helpResult.action, 'help');
  assert.ok(help.toChat(PARTNER_GROUP).length > 0, 'the bootstrap console still answers in-group');

  const stranger = createHarness({ supportChatId: null });
  const strangerResult = await stranger.bot.handleUpdate(groupUpdate({ fromId: STRANGER }));
  assert.strictEqual(strangerResult.reason, 'unconfigured-group-non-admin');
  assert.strictEqual(stranger.calls.length, 0);
});

test('a private /chatid from a customer is unchanged', async () => {
  const h = createHarness();
  const update = {
    update_id: nextUpdateId(),
    message: {
      message_id: 3,
      from: { id: Number(CUSTOMER_CHAT_ID), username: 'john' },
      chat: { id: Number(CUSTOMER_CHAT_ID), type: 'private' },
      text: '/chatid'
    }
  };
  const result = await h.bot.handleUpdate(update);
  assert.strictEqual(result.action, 'chatid');
  assert.match(h.textTo(CUSTOMER_CHAT_ID), new RegExp(`chat ID is: ${CUSTOMER_CHAT_ID}`, 'i'),
    'the customer-facing wording is unchanged');
});

test('routing config is never mutated by the command', async () => {
  const h = createHarness();
  const before = JSON.stringify(h.config);
  await h.bot.handleUpdate(groupUpdate());
  assert.strictEqual(JSON.stringify(h.config), before);
  assert.strictEqual(h.bot.getConfig().supportChatId, SUPPORT_GROUP);
});

test('a redelivered update is only answered once', async () => {
  const h = createHarness();
  const update = groupUpdate({ updateId: 777001 });
  await h.bot.handleUpdate(update);
  const second = await h.bot.handleUpdate(update);
  assert.strictEqual(second.action, 'duplicate');
  assert.strictEqual(h.toChat(ADMIN).length, 1, 'one DM, not two');
});

// -------------------------------------------------- private delivery failure ---

test('if the operator never started the bot, the group gets an ID-FREE notice', async () => {
  const h = createHarness({ failChatIds: [ADMIN] });
  const result = await h.bot.handleUpdate(groupUpdate());

  assert.strictEqual(result.action, 'chatid-private-failed');
  assert.strictEqual(result.reason, 'dm-failed:403');

  const [notice] = h.toChat(PARTNER_GROUP);
  assert.ok(notice, 'a helpful notice is posted in the group');
  assert.match(notice.text, /private message/i);
  assert.match(notice.text, /\/start/);
  assert.match(notice.text, /\/chatid/);
  assert.ok(!notice.text.includes(PARTNER_GROUP), 'the id is NEVER leaked into the group');
  assert.ok(!/Chat ID:/.test(notice.text), 'no id line in the fallback');
});

test('a failing fallback send does not throw or leak', async () => {
  const h = createHarness({ failChatIds: [ADMIN, PARTNER_GROUP] });
  const result = await h.bot.handleUpdate(groupUpdate());
  assert.strictEqual(result.action, 'chatid-private-failed');
  assert.strictEqual(h.calls.length, 0);
  assert.match(h.bot.getStats().lastReason, /dm-failed/);
});

// ------------------------------------------------------------------ webhook ---

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function webhookReq(update, { secret = WEBHOOK_SECRET, includeSecret = true } = {}) {
  const headers = {};
  if (includeSecret) headers['x-telegram-bot-api-secret-token'] = secret;
  return { headers, body: update };
}

test('the webhook still fails closed before the command can run', async () => {
  const h = createHarness();
  const handler = createTelegramWebhookHandler({ bot: h.bot, logger: silentLogger });

  const missing = makeRes();
  await handler(webhookReq(groupUpdate(), { includeSecret: false }), missing);
  assert.strictEqual(missing.statusCode, 401);
  assert.strictEqual(missing.body.error, 'invalid_secret');

  const wrong = makeRes();
  await handler(webhookReq(groupUpdate(), { secret: 'nope' }), wrong);
  assert.strictEqual(wrong.statusCode, 401);

  assert.strictEqual(h.calls.length, 0, 'a rejected delivery sends nothing');

  const ok = makeRes();
  await handler(webhookReq(groupUpdate()), ok);
  assert.strictEqual(ok.statusCode, 200);
  assert.strictEqual(h.toChat(ADMIN).length, 1);
});

test('router contract: kind chatid only for an operator asking for the id', () => {
  const cfg = { adminIds: [ADMIN], supportChatId: SUPPORT_GROUP };
  assert.strictEqual(routeUpdate(groupUpdate(), cfg).kind, 'chatid');
  assert.strictEqual(routeUpdate(groupUpdate({ text: '/id' }), cfg).kind, 'chatid');
  assert.strictEqual(routeUpdate(groupUpdate({ text: '/help' }), cfg).kind, 'ignore');
  assert.strictEqual(routeUpdate(groupUpdate({ fromId: STRANGER }), cfg).kind, 'ignore');
  assert.strictEqual(routeUpdate(groupUpdate({ chatId: SUPPORT_GROUP }), cfg).kind, 'group');
  assert.strictEqual(routeUpdate(groupUpdate({ chatId: SUPPORT_GROUP, text: '/id' }), cfg).kind, 'group',
    'the support group keeps its in-group path');
});
