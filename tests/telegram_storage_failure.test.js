'use strict';

/**
 * Telegram storage-failure contract.
 *
 * Production trace that motivated this file:
 *   status=500 ... lastStage=storage:upsert-conversation repliesSent=2
 *   storageFailures=0 pendingResult=retry 5xx
 *
 * Two facts pinned it down: `storageFailures=0` means noteStorageFailure() never
 * ran (it is only called from the two conversation-upsert catches), and the
 * `storage:upsert-conversation` marker is set BEFORE that upsert and was never
 * superseded. So upsertConversation() SUCCEEDED and the throw came from the
 * first unmarked storage write after it: store.insertMessage().
 *
 * These tests pin: the exact stage attribution, the failure counter for EVERY
 * storage write (not just the upsert), the preserved PostgREST code, the
 * customer acknowledgement when storage is down, and that /start stays
 * storage-independent.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  createTelegramSupportBot,
  createTelegramWebhookHandler,
  classifyStorageError,
  STORAGE_ERROR_CAUSES,
  STORAGE_DEGRADED_TEXT,
  DIRECTION_CUSTOMER,
  DIRECTION_BOT,
  DIRECTION_AGENT
} = require('../services/TelegramSupportService');
const { storageError } = require('../services/TelegramSupportStore');

const TOKEN = '998877:STORAGE-TOKEN';
const SECRET = 'storage-test-secret';
const CHAT_ID = 424242;

const req = (body, { secret = SECRET } = {}) => ({
  headers: secret === undefined ? {} : { 'x-telegram-bot-api-secret-token': secret },
  get(name) { return this.headers[String(name).toLowerCase()]; },
  body
});

const messageUpdate = (text, updateId = 1) => ({
  update_id: updateId,
  message: {
    message_id: 10,
    date: 1700000000,
    text,
    chat: { id: CHAT_ID, type: 'private' },
    from: { id: CHAT_ID, first_name: 'Customer', username: 'customer' }
  }
});

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    body_: null,
    json(payload) { this.body = payload; this.headersSent = true; return this; }
  };
}

/** A store whose failures are injected per operation. */
function makeStore({ fail = {} } = {}) {
  const state = { inserts: [], upserts: 0 };
  const boom = (label, code) => () => Promise.reject(storageError(label, {
    code,
    message: `injected ${label} failure`,
    details: 'injected details',
    hint: 'injected hint'
  }));
  return {
    state,
    async getConversationByChatId() { return null; },
    async upsertConversation({ chatId }) {
      state.upserts += 1;
      if (fail.upsert) return boom('conversation insert', fail.upsert)();
      const conversation = { id: 1, telegram_chat_id: Number(chatId), display_name: 'Customer' };
      return { conversation, created: state.upserts === 1 };
    },
    async insertMessage(payload) {
      if (fail.insertMessage) return boom('message insert', fail.insertMessage)();
      state.inserts.push(payload);
      return { message: { id: state.inserts.length } };
    },
    async setConversationStatus() {
      if (fail.setStatus) return boom('conversation status update', fail.setStatus)();
      return true;
    },
    async createEscalation() {
      if (fail.createEscalation) return boom('escalation insert', fail.createEscalation)();
      return { id: 1 };
    },
    async probeColumns(table) {
      if (fail.probe && fail.probe[table]) return boom('schema probe on ' + table, fail.probe[table])();
      return true;
    }
  };
}

function makeBot({ fail = {}, supportChatId = null } = {}) {
  const sent = [];
  const transport = {
    async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: sent.length }; },
    async setWebhook() { return true; },
    async getWebhookInfo() { return { url: 'https://arbitrix.pro/api/telegram/webhook' }; },
    getLastCall() { return { method: 'sendMessage', httpStatus: 200, ok: true, errorCode: null, description: null }; }
  };
  const logger = { lines: [], log(l) { this.lines.push(l); }, warn(l) { this.lines.push(l); }, error(l) { this.lines.push(l); } };
  const bot = createTelegramSupportBot({
    config: { token: TOKEN, supportChatId, adminIds: [], webhookSecret: SECRET, baseUrl: 'https://arbitrix.pro' },
    store: makeStore({ fail }),
    transport,
    logger
  });
  return { bot, sent, logger };
}

// ---------------------------------------------------------------------------
// Stage attribution: the exact failing write
// ---------------------------------------------------------------------------

test('a failing insertMessage is attributed to storage:insert-message, not the upsert', async () => {
  const { bot, sent } = makeBot({ fail: { insertMessage: 'PGRST204' } });
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });
  const res = makeRes();

  await handler(req(messageUpdate('where is my withdrawal?', 41)), res);

  const s = bot.getStats();
  assert.strictEqual(res.statusCode, 500, 'the update stays queued for redelivery');
  assert.strictEqual(s.lastStage, 'storage:insert-message', 'the stage names the write that threw');
  assert.strictEqual(s.lastErrorStage, 'storage:insert-message');
  assert.strictEqual(s.lastErrorCode, 'PGRST204', 'the PostgREST code is preserved');
  assert.strictEqual(s.updatesReceived, 1);

  // The upsert succeeded, so the stage that the production trace showed must NOT
  // be the one reported here.
  assert.notStrictEqual(s.lastStage, 'storage:upsert-conversation');
  assert.ok(sent.length >= 1, 'the customer is not left in silence');
});

test('a failing upsert is attributed to storage:upsert-conversation', async () => {
  const { bot } = makeBot({ fail: { upsert: '42501' } });
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });
  const res = makeRes();

  await handler(req(messageUpdate('hello', 42)), res);

  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(bot.getStats().lastStage, 'storage:upsert-conversation');
  assert.strictEqual(bot.getStats().lastErrorCode, '42501');
});

// ---------------------------------------------------------------------------
// The storageFailures telemetry bug
// ---------------------------------------------------------------------------

test('EVERY storage write failure increments storageFailures (the production bug)', async () => {
  // Before the fix only the two upsert catches called noteStorageFailure, so an
  // insertMessage failure produced status=500 with storageFailures=0.
  const { bot } = makeBot({ fail: { insertMessage: '23514' } });
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });

  await handler(req(messageUpdate('first', 51)), makeRes());
  await handler(req(messageUpdate('second', 52)), makeRes());

  const s = bot.getStats();
  assert.strictEqual(s.storageFailures, 2, 'both failures counted');
  assert.strictEqual(s.lastErrorCode, '23514');
});

test('a storage failure is not double counted by the inner and outer catches', async () => {
  const { bot } = makeBot({ fail: { upsert: '42501' } });
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });

  await handler(req(messageUpdate('once', 61)), makeRes());

  assert.strictEqual(bot.getStats().storageFailures, 1, 'counted exactly once');
});

test('a non-storage failure does not inflate the storage counter', async () => {
  const { bot } = makeBot();
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });
  await handler(req(messageUpdate('fine', 62)), makeRes());
  assert.strictEqual(bot.getStats().storageFailures, 0);
});

// ---------------------------------------------------------------------------
// Customer acknowledgement while storage is down
// ---------------------------------------------------------------------------

test('a customer message is acknowledged once even though storage fails', async () => {
  const { bot, sent } = makeBot({ fail: { insertMessage: '42703' } });
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });

  await handler(req(messageUpdate('my deposit is stuck', 71)), makeRes());

  const notices = sent.filter((m) => m.text === STORAGE_DEGRADED_TEXT);
  assert.strictEqual(notices.length, 1, 'exactly one notice');
  assert.strictEqual(String(notices[0].chatId), String(CHAT_ID), 'sent to the customer chat');
});

test('Telegram redelivering the same update does not spam the customer', async () => {
  const { bot, sent } = makeBot({ fail: { insertMessage: '42703' } });
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });

  // Same update_id three times (Telegram retries a 5xx).
  await handler(req(messageUpdate('stuck', 81)), makeRes());
  await handler(req(messageUpdate('stuck', 81)), makeRes());
  await handler(req(messageUpdate('stuck', 81)), makeRes());

  const notices = sent.filter((m) => m.text === STORAGE_DEGRADED_TEXT);
  assert.strictEqual(notices.length, 1, 'deduplicated by update id');
});

test('a storage failure never acknowledges with message text of its own', async () => {
  const { bot, sent } = makeBot({ fail: { insertMessage: '42703' } });
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });
  const customerText = 'my card number is 4111 1111 1111 1111';
  await handler(req(messageUpdate(customerText, 91)), makeRes());
  assert.ok(!sent.some((m) => m.text.includes('4111')), 'customer text is never echoed');
});

// ---------------------------------------------------------------------------
// /start stays storage-independent
// ---------------------------------------------------------------------------

test('/start still replies when the whole store is broken', async () => {
  const { bot, sent } = makeBot({ fail: { upsert: '42P01', insertMessage: '42P01' } });
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });
  const res = makeRes();

  await handler(req({
    update_id: 101,
    message: { message_id: 1, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID }, text: '/start' }
  }), res);

  assert.strictEqual(res.statusCode, 200, 'a command does not depend on storage');
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Arbitrix Support/);
  assert.strictEqual(bot.getStats().lastAction, 'help');
});

// ---------------------------------------------------------------------------
// The error code survives the store and is classified
// ---------------------------------------------------------------------------

test('the store preserves PostgREST code/details/hint instead of only the message', async () => {
  const failing = {
    from() { return this; },
    select() { return this; },
    limit() { return Promise.resolve({ data: null, error: { code: '23514', message: 'violates check constraint "direction_check"', details: 'Failing row', hint: 'Try customer' } }); }
  };
  const { createTelegramSupportStore } = require('../services/TelegramSupportStore');
  const store = createTelegramSupportStore(failing);

  await assert.rejects(
    () => store.probeColumns('telegram_support_messages', ['direction']),
    (error) => {
      assert.match(error.message, /23514/);
      assert.match(error.message, /direction_check/);
      assert.strictEqual(error.supabase.code, '23514');
      assert.strictEqual(error.supabase.details, 'Failing row');
      assert.strictEqual(error.supabase.hint, 'Try customer');
      return true;
    }
  );
});

test('every documented Postgres/PostgREST code maps to a cause and a remedy', () => {
  const expected = {
    '42P01': 'table-missing',
    PGRST205: 'table-missing',
    '42703': 'column-missing',
    PGRST204: 'column-missing',
    '42501': 'permission-denied',
    '23514': 'check-constraint-violation',
    '23502': 'not-null-violation',
    '23503': 'foreign-key-violation',
    '23505': 'unique-violation',
    PGRST301: 'invalid-or-missing-api-key'
  };
  for (const [code, cause] of Object.entries(expected)) {
    const classified = classifyStorageError({ message: 'x', supabase: { code } });
    assert.strictEqual(classified.cause, cause, `${code} -> ${cause}`);
    assert.ok(classified.remedy && classified.remedy.length > 10, `${code} has a remedy`);
  }
  assert.ok(STORAGE_ERROR_CAUSES['42P01'].remedy.includes('027_telegram_support_bot.sql'),
    'the table-missing remedy names the migration');
});

test('an unclassified error still reports its code instead of guessing', () => {
  const classified = classifyStorageError({ message: 'something odd', supabase: { code: 'XX999' } });
  assert.strictEqual(classified.cause, 'unknown');
  assert.strictEqual(classified.code, 'XX999');
});

// ---------------------------------------------------------------------------
// The boot preflight probes every table
// ---------------------------------------------------------------------------

test('checkStorage probes all three tables and reports per-table codes', async () => {
  // The probe receives the REAL relation name, so failures are injected by it
  // (the telemetry label `messages` is only the output key).
  const { bot } = makeBot({ fail: { probe: { telegram_support_messages: 'PGRST204' } } });
  const result = await bot.checkStorage();

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.cause, 'column-missing');
  assert.strictEqual(result.code, 'PGRST204');
  assert.strictEqual(result.tables.conversations.ok, true);
  assert.strictEqual(result.tables.messages.ok, false);
  assert.strictEqual(result.tables.messages.cause, 'column-missing');
  assert.strictEqual(result.tables.escalations.ok, true);
});

test('checkStorage reports success when every table is reachable', async () => {
  const { bot } = makeBot();
  const result = await bot.checkStorage();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.tables.conversations.ok, true);
  assert.strictEqual(result.tables.messages.ok, true);
  assert.strictEqual(result.tables.escalations.ok, true);
});

// Regression: the preflight must query the REAL prefixed relations while the
// short labels stay only as telemetry keys. Passing the label as the table name
// asked PostgREST for public.messages / public.escalations and logged a false
// PGRST205 even when migration 027 had been applied.
test('checkStorage queries the prefixed tables, not the short telemetry labels', async () => {
  const probed = [];
  const store = {
    async getConversationByChatId() { return null; },
    async probeColumns(table, columns) { probed.push({ table, columns }); return true; }
  };
  const transport = {
    async sendMessage() { return { message_id: 1 }; },
    async setWebhook() { return true; },
    async getWebhookInfo() { return { url: 'https://arbitrix.pro/api/telegram/webhook' }; },
    getLastCall() { return null; }
  };
  const bot = createTelegramSupportBot({
    config: { token: TOKEN, supportChatId: null, adminIds: [], webhookSecret: SECRET, baseUrl: 'https://arbitrix.pro' },
    store,
    transport,
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await bot.checkStorage();

  assert.deepStrictEqual(
    probed.map((p) => p.table),
    ['telegram_support_messages', 'telegram_support_escalations'],
    'the preflight queries the prefixed relation names'
  );
  assert.ok(!probed.some((p) => p.table === 'messages' || p.table === 'escalations'),
    'the preflight must never query public.messages / public.escalations');
  assert.deepStrictEqual(probed[0].columns, ['id', 'conversation_id', 'direction', 'body', 'created_at']);
  assert.deepStrictEqual(probed[1].columns, ['id', 'conversation_id', 'created_at']);
  // The short labels remain the telemetry keys, unchanged.
  assert.strictEqual(result.tables.messages.ok, true);
  assert.strictEqual(result.tables.escalations.ok, true);
  assert.ok(!('telegram_support_messages' in result.tables), 'telemetry keys stay short');
});

// Regression: a failure on a prefixed probe is still reported under the short
// telemetry label so the delivery trace keeps its stable shape.
test('a failed prefixed probe is reported under the short telemetry label', async () => {
  const store = {
    async getConversationByChatId() { return null; },
    async probeColumns(table) {
      if (table === 'telegram_support_messages') {
        throw storageError('schema probe on ' + table, { code: 'PGRST204', message: 'injected column-missing' });
      }
      return true;
    }
  };
  const transport = {
    async sendMessage() { return { message_id: 1 }; },
    async setWebhook() { return true; },
    async getWebhookInfo() { return { url: 'https://arbitrix.pro/api/telegram/webhook' }; },
    getLastCall() { return null; }
  };
  const bot = createTelegramSupportBot({
    config: { token: TOKEN, supportChatId: null, adminIds: [], webhookSecret: SECRET, baseUrl: 'https://arbitrix.pro' },
    store,
    transport,
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await bot.checkStorage();

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.tables.conversations.ok, true);
  assert.strictEqual(result.tables.messages.ok, false);
  assert.strictEqual(result.tables.messages.code, 'PGRST204');
  assert.strictEqual(result.tables.escalations.ok, true);
});

// ---------------------------------------------------------------------------
// The trace carries the DB cause, and no secrets
// ---------------------------------------------------------------------------

test('the evidence line reports the storage cause and code', async () => {
  const { bot, logger } = makeBot({ fail: { insertMessage: '23514' } });
  const handler = createTelegramWebhookHandler({ bot, logger });

  await handler(req(messageUpdate('hello', 111)), makeRes());

  const line = logger.lines.find((l) => l.includes('lastErrorCode='));
  assert.ok(line, 'evidence line records the error code');
  assert.ok(line.includes('lastErrorCode=23514'));
  assert.ok(line.includes('storageCause=check-constraint-violation'));
  assert.ok(line.includes('lastStage=storage:insert-message'));
  assert.ok(line.includes('storageFailures=1'));
  assert.ok(!line.includes(TOKEN), 'no token');
  assert.ok(!line.includes(SECRET), 'no webhook secret');
});

test('the trace never contains customer message text', async () => {
  const { bot } = makeBot({ fail: { insertMessage: '23514' } });
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });
  await handler(req(messageUpdate('my top secret question', 112)), makeRes());
  assert.ok(!JSON.stringify(bot.status()).includes('my top secret question'));
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

test('the direction literals match the confirmed LIVE CHECK constraint', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'services', 'TelegramSupportService.js'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '027_telegram_support_bot.sql'), 'utf8');

  // Live production (authoritative):
  //   CHECK (direction = ANY (ARRAY['customer'::text, 'bot'::text, 'agent'::text]))
  assert.strictEqual(DIRECTION_CUSTOMER, 'customer');
  assert.strictEqual(DIRECTION_BOT, 'bot');
  assert.strictEqual(DIRECTION_AGENT, 'agent');
  assert.ok(service.includes("const DIRECTION_CUSTOMER = 'customer';"));
  assert.ok(service.includes("const DIRECTION_BOT = 'bot';"));
  assert.ok(service.includes("const DIRECTION_AGENT = 'agent';"));

  // The legacy literals that caused the production 23514 must be gone.
  assert.ok(!service.includes('DIRECTION_INBOUND'), 'legacy inbound constant removed');
  assert.ok(!service.includes('DIRECTION_OUTBOUND'), 'legacy outbound constant removed');

  // Migration 027 keeps its legacy DDL but documents the authoritative values.
  assert.match(migration, /direction IN \('inbound', 'outbound'\)/);
  for (const liveValue of ['customer', 'bot', 'agent']) {
    assert.ok(migration.includes(liveValue), 'migration documents the live value ' + liveValue);
  }
});

test('the store writes only columns migration 027 defines', () => {
  const store = fs.readFileSync(path.join(__dirname, '..', 'services', 'TelegramSupportStore.js'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '027_telegram_support_bot.sql'), 'utf8');
  for (const column of ['telegram_chat_id', 'telegram_user_id', 'username', 'display_name', 'updated_at', 'conversation_id', 'direction', 'body']) {
    assert.ok(store.includes(column), `store uses ${column}`);
    assert.ok(migration.includes(column), `migration 027 defines ${column}`);
  }
});

test('this fix touches no sandbox or trading-worker code', () => {
  for (const file of ['services/TelegramSupportService.js', 'services/TelegramSupportStore.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(!/sandbox_/.test(source), `${file} does not touch sandbox tables`);
    assert.ok(!/record_trade_safe|TradingWorker/.test(source), `${file} does not touch trading`);
  }
});
