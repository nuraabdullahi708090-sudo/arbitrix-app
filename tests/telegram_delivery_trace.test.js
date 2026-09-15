'use strict';

/**
 * Delivery-trace tests.
 *
 * These pin the temporary, secret-free telemetry that locates the exact failing
 * stage of a Telegram delivery. They exercise the REAL transport and the REAL
 * webhook handler - not mocks of them - with a fake fetch so nothing touches the
 * network.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  createTelegramTransport,
  createTelegramSupportBot,
  createTelegramWebhookHandler
} = require('../services/TelegramSupportService');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const TOKEN = '998877:TRACE-TOKEN';
const WEBHOOK_SECRET = 'trace-webhook-secret';
const CHAT_ID = '424242';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function makeStore({ fail = false } = {}) {
  const state = { conversations: [], messages: [] };
  const boom = () => Promise.reject(new Error('storage down'));
  if (fail) {
    return {
      state,
      getConversationByChatId: boom,
      upsertConversation: boom,
      insertMessage: boom,
      setConversationStatus: boom,
      createEscalation: boom
    };
  }
  return {
    state,
    async getConversationByChatId() { return null; },
    async upsertConversation({ chatId }) {
      const existing = state.conversations.find((c) => String(c.telegram_chat_id) === String(chatId));
      if (existing) return { conversation: existing, created: false };
      const conversation = { id: state.conversations.length + 1, telegram_chat_id: Number(chatId), display_name: 'User' };
      state.conversations.push(conversation);
      return { conversation, created: true };
    },
    async insertMessage({ conversationId, direction, body }) {
      const message = { id: state.messages.length + 1, conversation_id: conversationId, direction, body };
      state.messages.push(message);
      return { message };
    },
    async setConversationStatus() { return true; },
    async createEscalation() { return { id: 1 }; }
  };
}

function makeTransport({ sendMessageResponse } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const method = String(url).split('/').pop();
    const payload = JSON.parse(options.body || '{}');
    calls.push({ method, payload });
    if (method === 'sendMessage') {
      if (sendMessageResponse) return sendMessageResponse;
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    }
    return jsonResponse({ ok: true, result: {} });
  };
  return { transport: createTelegramTransport({ token: TOKEN, fetchImpl }), calls };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; }
  };
}

const req = (body, { secret = WEBHOOK_SECRET } = {}) => ({
  headers: secret === undefined ? {} : { 'x-telegram-bot-api-secret-token': secret },
  get(name) { return this.headers[String(name).toLowerCase()]; },
  body
});

const userUpdate = (text, updateId = 1) => ({
  update_id: updateId,
  message: {
    message_id: 10,
    date: 1700000000,
    text,
    chat: { id: Number(CHAT_ID), type: 'private' },
    from: { id: Number(CHAT_ID), first_name: 'Customer', username: 'customer' }
  }
});

function makeBot({ storeFail = false, sendMessageResponse } = {}) {
  const { transport, calls } = makeTransport({ sendMessageResponse });
  const bot = createTelegramSupportBot({
    config: { token: TOKEN, supportChatId: null, adminIds: [], webhookSecret: WEBHOOK_SECRET, baseUrl: 'https://arbitrix.pro' },
    store: makeStore({ fail: storeFail }),
    transport,
    logger: { log() {}, warn() {}, error() {} }
  });
  return { bot, calls };
}

// ---------------------------------------------------------------------------
// Transport-level: last sendMessage status + Telegram's own description
// ---------------------------------------------------------------------------

test('the transport records the last sendMessage HTTP status and Telegram description', async () => {
  const { transport } = makeTransport({
    sendMessageResponse: jsonResponse(
      { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
      { ok: false, status: 400 }
    )
  });

  await assert.rejects(() => transport.sendMessage(1, 'hello'));

  const last = transport.getLastCall();
  assert.strictEqual(last.method, 'sendMessage');
  assert.strictEqual(last.httpStatus, 400);
  assert.strictEqual(last.ok, false);
  assert.strictEqual(last.errorCode, 400);
  assert.match(last.description, /chat not found/);
});

test('the transport records a successful sendMessage', async () => {
  const { transport } = makeTransport();
  await transport.sendMessage(1, 'hello');
  const last = transport.getLastCall();
  assert.strictEqual(last.method, 'sendMessage');
  assert.strictEqual(last.httpStatus, 200);
  assert.strictEqual(last.ok, true);
  assert.strictEqual(last.description, null);
});

test('the transport scrubs the token out of any recorded description', async () => {
  const { transport } = makeTransport({
    sendMessageResponse: jsonResponse(
      { ok: false, error_code: 401, description: `Unauthorized bot${TOKEN} rejected` },
      { ok: false, status: 401 }
    )
  });
  await assert.rejects(() => transport.sendMessage(1, 'hello'));
  assert.ok(!transport.getLastCall().description.includes(TOKEN), 'token must be scrubbed');
});

test('the transport records a network failure with a null http status', async () => {
  const transport = createTelegramTransport({
    token: TOKEN,
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.telegram.org'); }
  });
  await assert.rejects(() => transport.sendMessage(1, 'hello'));
  const last = transport.getLastCall();
  assert.strictEqual(last.httpStatus, null);
  assert.strictEqual(last.ok, false);
  assert.match(last.description, /ENOTFOUND/);
});

// ---------------------------------------------------------------------------
// Trace items 1-6 and 8: request/secret/stage/status/pending accounting
// ---------------------------------------------------------------------------

test('the trace counts requests, secret outcomes and the last response status', async () => {
  const { bot } = makeBot();
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });

  await handler(req(userUpdate('/start', 1), { secret: 'wrong' }), makeRes());
  await handler(req(userUpdate('/start', 2)), makeRes());

  const s = bot.getStats();
  assert.strictEqual(s.requestsReceived, 2, 'both POSTs were counted before validation');
  assert.strictEqual(s.secretRejected, 1);
  assert.strictEqual(s.secretPassed, 1);
  assert.strictEqual(s.lastResponseStatus, 200);
  assert.ok(s.lastResponseAt, 'the response time is recorded');
});

test('the trace records the last routing action, stage and update id', async () => {
  const { bot } = makeBot();
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });
  await handler(req(userUpdate('/start', 77)), makeRes());

  const s = bot.getStats();
  assert.strictEqual(s.lastUpdateId, 77);
  assert.ok(s.lastUpdateAt, 'timestamp recorded');
  assert.strictEqual(s.lastAction, 'help');
  assert.strictEqual(s.lastStage, 'done:help');
  assert.strictEqual(s.repliesSent, 1);
});

test('the trace records the routing decision for a non-private chat it ignores', async () => {
  const { bot } = makeBot();
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });
  await handler(req({
    update_id: 5,
    message: { message_id: 1, chat: { id: -100999, type: 'channel' }, from: { id: 5 }, text: 'hi' }
  }), makeRes());

  const s = bot.getStats();
  assert.strictEqual(s.lastAction, 'ignored');
  assert.strictEqual(s.ignored, 1);
  assert.match(s.lastStage, /^ignored:/);
});

test('the trace states what our answer means for the Telegram pending queue', async () => {
  const { bot } = makeBot();
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });

  await handler(req(userUpdate('/start', 1), { secret: 'nope' }), makeRes());
  assert.match(bot.getStats().lastPendingResult, /rejected 401/);

  await handler(req(userUpdate('/start', 2)), makeRes());
  assert.match(bot.getStats().lastPendingResult, /acknowledged 2xx/);

  const broken = makeBot({ storeFail: true });
  const brokenHandler = createTelegramWebhookHandler({ bot: broken.bot, logger: { log() {}, warn() {}, error() {} } });
  await brokenHandler(req(userUpdate('my deposit is missing', 3)), makeRes());
  assert.match(broken.bot.getStats().lastPendingResult, /retry 5xx/);
});

test('the trace exposes the last sendMessage outcome when sending fails', async () => {
  const { bot } = makeBot({
    sendMessageResponse: jsonResponse(
      { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      { ok: false, status: 403 }
    )
  });
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });
  const res = makeRes();
  await handler(req(userUpdate('/start', 9)), res);

  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.stage, 'sendMessage', 'the exact failing stage is reported');

  const status = bot.status();
  assert.strictEqual(status.lastApiCall.method, 'sendMessage');
  assert.strictEqual(status.lastApiCall.httpStatus, 403);
  assert.match(status.lastApiCall.description, /bot was blocked/);
});

test('the trace records the storage stage when the store is down', async () => {
  const { bot } = makeBot({ storeFail: true });
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });
  const res = makeRes();
  await handler(req(userUpdate('hello support', 11)), res);

  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.stage, 'storage:upsert-conversation');
  assert.strictEqual(bot.getStats().lastErrorStage, 'storage:upsert-conversation');
  assert.strictEqual(bot.getStats().storageFailures, 1);
});

test('the last webhook registration outcome is recorded for the trace', async () => {
  const { bot } = makeBot();
  const result = await bot.ensureWebhookRegistration({ force: true });
  assert.strictEqual(result.ok, true);
  const recorded = bot.getStats().lastRegistration;
  assert.ok(recorded, 'registration outcome recorded');
  assert.strictEqual(recorded.ok, true);
  assert.strictEqual(recorded.reRegistered, true);
  assert.ok(recorded.at);
});

// ---------------------------------------------------------------------------
// The evidence line and secret hygiene
// ---------------------------------------------------------------------------

test('every response logs one secret-free evidence line with the trace', async () => {
  const lines = [];
  const logger = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  const { bot } = makeBot();
  const handler = createTelegramWebhookHandler({ bot, logger });

  await handler(req(userUpdate('/start', 1)), makeRes());

  const evidence = lines.find((l) => l.includes('requests='));
  assert.ok(evidence, 'an evidence line is logged');
  for (const field of ['status=', 'requests=', 'secretPassed=', 'secretRejected=', 'updates=',
    'lastUpdateAt=', 'lastAction=', 'lastStage=', 'repliesSent=', 'lastSendMessage=', 'pendingResult=']) {
    assert.ok(evidence.includes(field), `evidence carries ${field}`);
  }

  const joined = lines.join('\n');
  assert.ok(!joined.includes(TOKEN), 'the bot token is never logged');
  assert.ok(!joined.includes(WEBHOOK_SECRET), 'the webhook secret is never logged');
});

test('a rejected secret never logs the header value', async () => {
  const lines = [];
  const logger = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  const { bot } = makeBot();
  const handler = createTelegramWebhookHandler({ bot, logger });

  await handler(req(userUpdate('/start', 1), { secret: 'attacker-supplied-value' }), makeRes());

  const joined = lines.join('\n');
  assert.ok(!joined.includes('attacker-supplied-value'), 'the supplied header value is never logged');
  assert.ok(joined.includes('secretRejected=1'));
});

// ---------------------------------------------------------------------------
// The admin-gated trace surface
// ---------------------------------------------------------------------------

test('the admin status route exposes all eight trace items', () => {
  const start = SERVER.indexOf("app.get('/api/telegram/status'");
  assert.ok(start > -1);
  const route = SERVER.slice(start, SERVER.indexOf("app.post('/api/telegram/set-webhook'", start));

  assert.ok(route.includes('authMiddleware, adminMiddleware'), 'the trace surface is admin-gated');
  assert.ok(route.includes('webhookRequestsReceived'));
  assert.ok(route.includes('secretValidation'));
  assert.ok(route.includes('lastUpdate'));
  assert.ok(route.includes('lastRoutingAction'));
  assert.ok(route.includes('lastProcessingStage'));
  assert.ok(route.includes('lastResponseSentByServer'));
  assert.ok(route.includes('lastSendMessage'));
  assert.ok(route.includes('pendingUpdateHandling'));
  assert.ok(!/token\s*:/.test(route), 'never returns the token');
  assert.ok(!/webhookSecret\s*:/.test(route), 'never returns the webhook secret');
});

test('the trace never carries customer message text', async () => {
  const { bot } = makeBot();
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });
  await handler(req(userUpdate('my secret account phrase 12345', 3)), makeRes());
  const dumped = JSON.stringify(bot.status());
  assert.ok(!dumped.includes('my secret account phrase'), 'no message body in the trace');
});
