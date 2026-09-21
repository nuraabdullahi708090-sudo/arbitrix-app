'use strict';

/**
 * Telegram language persistence: the write is VERIFIED, never assumed.
 *
 * Production incident this file pins down:
 *   a customer selected Portuguese through /language, the bot confirmed it in
 *   Portuguese, and the operator notification still read
 *   "🌐 Language: English" - with the customer's reply in English too.
 *
 * Root cause: setConversationLanguage() could not tell "the row was updated" from
 * "the UPDATE matched no row". PostgREST answers 200 with an EMPTY body when an
 * UPDATE matches nothing (that is not an error), so the store returned null, the
 * caller marked the change applied and told the customer it had been set, while
 * the row kept its previous language and every later reply/notice read it.
 *
 * Covered here:
 *   A  a successful change: confirmation sent, row updated, counter incremented;
 *   B  a zero-row UPDATE: failure, no false confirmation, no in-memory mutation;
 *   C  a stored value that differs from the request: failure;
 *   D  callback identity: the presser, never the bot;
 *   E  English / Portuguese / Arabic still work end to end;
 *   F  the operator notice reports the PERSISTED language;
 *   G  checkStorage() verifies the columns the store writes (`language` included).
 *
 * The REAL service, the REAL store and the REAL transport (fake fetch - no
 * network) run under test. Only the PostgREST boundary is faked, so the exact
 * query the store issues is observable.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createTelegramSupportBot,
  createTelegramTransport,
  routeUpdate,
  telegramDisplayName
} = require('../services/TelegramSupportService');
const { createTelegramSupportStore } = require('../services/TelegramSupportStore');
const i18n = require('../services/telegram-i18n');

const TOKEN = '123456789:TEST-TOKEN-NOT-A-CREDENTIAL';
const ADMIN_ID = '6054625818';
const CUSTOMER_CHAT_ID = '555111';
const CUSTOMER_ID = Number(CUSTOMER_CHAT_ID);
const CONVERSATION_ID = 41;

// The bot, as Telegram reports it on ITS OWN message that carries the keyboard.
const BOT_FROM = { id: 777000, is_bot: true, first_name: 'Arbitrix Support', username: 'ArbitrixSupportBot' };
// The customer, as Telegram reports the person who pressed the button.
const CUSTOMER_FROM = { id: CUSTOMER_ID, is_bot: false, first_name: 'John', username: 'john' };

let updateSeq = 70000;
const nextUpdateId = () => ++updateSeq;

const seedRow = () => ({
  id: CONVERSATION_ID,
  telegram_chat_id: CUSTOMER_ID,
  telegram_user_id: CUSTOMER_ID,
  username: 'john',
  display_name: 'John',
  language: 'en',
  status: 'open',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z'
});

// ---------------------------------------------------------------------------
// A PostgREST-shaped fake the REAL store runs against.
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {'ok'|'no-rows'|'wrong-value'|'error'} [options.languageMode]
 *   'ok'          the UPDATE applies and the written row comes back;
 *   'no-rows'     the UPDATE matches nothing -> 200 with an EMPTY body (no error,
 *                 which is precisely the production trap);
 *   'wrong-value' the UPDATE runs but the returned row still holds the old value;
 *   'error'       PostgREST answers with an error (code preserved).
 * @param {string[]} [options.missingColumns] columns absent from the applied
 *   table: any statement naming one fails with PGRST204, while `select('*')`
 *   still succeeds - exactly why a missing `language` used to be invisible.
 */
function createFakeSupabase({ languageMode = 'ok', missingColumns = [] } = {}) {
  const tables = {
    telegram_support_conversations: [],
    telegram_support_messages: [],
    telegram_support_escalations: []
  };
  const log = { updates: [], inserts: [], selects: [] };

  const names = (list) => (list && list !== '*')
    ? String(list).split(',').map((c) => c.trim()).filter(Boolean)
    : [];
  const project = (row, select) => {
    const cols = names(select);
    if (!cols.length) return row;
    const out = {};
    cols.forEach((c) => { if (row[c] !== undefined) out[c] = row[c]; });
    return out;
  };
  const matches = (row, filters) => filters.every(([col, val]) => String(row[col]) === String(val));
  const pgError = (code, message) => ({ code, message });

  function execute(ops) {
    const rows = tables[ops.table] || (tables[ops.table] = []);
    const named = names(ops.select).concat(ops.update ? Object.keys(ops.update) : []);
    const missing = named.filter((c) => missingColumns.indexOf(c) !== -1);
    if (missing.length) {
      const error = pgError('PGRST204', `Could not find the '${missing[0]}' column of '${ops.table}' in the schema cache`);
      return Promise.resolve({ data: null, error });
    }

    if (ops.insert) {
      const row = Object.assign({ id: rows.length + 1 }, ops.insert);
      log.inserts.push({ table: ops.table, row });
      rows.push(row);
      return Promise.resolve({ data: ops.single ? row : [row], error: null });
    }

    if (ops.update) {
      log.updates.push({ table: ops.table, update: ops.update, select: ops.select || null });
      const target = rows.filter((r) => matches(r, ops.filters));

      if (ops.table === 'telegram_support_conversations' && ops.update.language !== undefined) {
        if (languageMode === 'error') {
          return Promise.resolve({ data: null, error: pgError('42501', 'permission denied for table telegram_support_conversations') });
        }
        if (languageMode === 'no-rows') {
          // 0 rows matched: NOTHING is written and the body is empty. No error.
          return Promise.resolve({ data: ops.single ? null : [], error: null });
        }
        if (languageMode === 'wrong-value') {
          const untouched = target.map((r) => project(r, ops.select));
          return Promise.resolve({ data: ops.single ? (untouched[0] || null) : untouched, error: null });
        }
      }

      target.forEach((r) => Object.assign(r, ops.update));
      if (ops.select) {
        const written = target.map((r) => project(r, ops.select));
        return Promise.resolve({ data: ops.single ? (written[0] || null) : written, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }

    log.selects.push({ table: ops.table, columns: ops.select ? String(ops.select) : null });
    let found = rows.filter((r) => matches(r, ops.filters));
    if (ops.limit !== null && ops.limit !== undefined) found = found.slice(0, ops.limit);
    if (ops.single) {
      return Promise.resolve({
        data: found[0] ? project(found[0], ops.select) : null,
        error: found[0] ? null : pgError('PGRST116', 'no rows')
      });
    }
    return Promise.resolve({ data: found.map((r) => project(r, ops.select)), error: null });
  }

  return {
    tables,
    log,
    from(table) {
      const ops = { table, filters: [], select: null, update: null, insert: null, limit: null, single: false };
      const builder = {
        select(cols) { ops.select = cols || '*'; return builder; },
        insert(row) { ops.insert = row; return builder; },
        update(row) { ops.update = row; return builder; },
        eq(col, val) { ops.filters.push([col, val]); return builder; },
        limit(n) { ops.limit = n; return builder; },
        single() { ops.single = true; return execute(ops); },
        then(resolve, reject) { return execute(ops).then(resolve, reject); },
        catch(fn) { return execute(ops).then(undefined, fn); }
      };
      return builder;
    }
  };
}

/**
 * A store double whose language write result is injected, so the SERVICE's
 * verification can be asserted directly on the conversation object it holds.
 */
function createSpyStore({ languageResult = null } = {}) {
  const conversation = {
    id: CONVERSATION_ID,
    telegram_chat_id: CUSTOMER_ID,
    telegram_user_id: CUSTOMER_ID,
    username: 'john',
    display_name: 'John',
    language: 'en'
  };
  const calls = { upsert: [], language: [] };
  return {
    conversation,
    calls,
    async getConversationByChatId() { return conversation; },
    async getConversationById() { return conversation; },
    async upsertConversation(payload) { calls.upsert.push(payload); return { conversation, created: false }; },
    async setConversationLanguage(payload) { calls.language.push(payload); return languageResult; },
    async insertMessage() { return { message: { id: 1 } }; },
    async getLatestMessageByConversation() { return null; },
    async createEscalation() { return { id: 1 }; },
    async setConversationStatus() { return true; },
    async probeColumns() { return true; }
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function createHarness({ store = null, supabase = null, languageMode = 'ok', missingColumns = [] } = {}) {
  const calls = [];
  const lines = [];
  const logger = { log() {}, warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) };
  const client = supabase || createFakeSupabase({ languageMode, missingColumns });
  if (client.tables.telegram_support_conversations.length === 0) {
    client.tables.telegram_support_conversations.push(seedRow());
  }
  const activeStore = store || createTelegramSupportStore(client);

  let messageSeq = 900000;
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url, options) => {
    const method = String(url).split('/').pop();
    const payload = JSON.parse(options.body || '{}');
    if (method === 'answerCallbackQuery') {
      calls.push({ method, callbackQueryId: String(payload.callback_query_id), text: payload.text || null });
      return json({ ok: true, result: true });
    }
    const messageId = ++messageSeq;
    calls.push({ method, chatId: String(payload.chat_id), text: payload.text, replyMarkup: payload.reply_markup || null, messageId });
    return json({ ok: true, result: { message_id: messageId } });
  };

  const transport = createTelegramTransport({ token: TOKEN, fetchImpl });
  const config = { token: TOKEN, adminIds: [ADMIN_ID], webhookSecret: 'test-webhook-secret', baseUrl: 'https://arbitrix.pro' };
  const bot = createTelegramSupportBot({ config, store: activeStore, transport, logger });

  return {
    bot,
    client,
    store: activeStore,
    calls,
    lines,
    row: () => client.tables.telegram_support_conversations[0],
    toCustomer: () => calls.filter((c) => c.method === 'sendMessage' && c.chatId === CUSTOMER_CHAT_ID).map((c) => c.text),
    toAdmin: () => calls.filter((c) => c.method === 'sendMessage' && c.chatId === ADMIN_ID).map((c) => c.text),
    callbackAnswers: () => calls.filter((c) => c.method === 'answerCallbackQuery'),
    languageCallback: (data = 'lang:pt') => ({
      update_id: nextUpdateId(),
      callback_query: {
        id: 'cb-' + nextUpdateId(),
        from: CUSTOMER_FROM,
        chat_instance: 'chat-instance',
        data,
        // The message the keyboard is attached to was sent BY THE BOT.
        message: {
          message_id: 5150,
          date: 1700000000,
          chat: { id: CUSTOMER_ID, type: 'private' },
          from: BOT_FROM
        }
      }
    }),
    message: (text) => ({
      update_id: nextUpdateId(),
      message: {
        message_id: nextUpdateId(),
        date: 1700000000,
        text,
        chat: { id: CUSTOMER_ID, type: 'private' },
        from: CUSTOMER_FROM
      }
    })
  };
}

// ---------------------------------------------------------------------------
// A. successful language change
// ---------------------------------------------------------------------------

test('A. store: the language update returns the written row and asks only for id, language', async () => {
  const client = createFakeSupabase();
  const store = createTelegramSupportStore(client);
  client.tables.telegram_support_conversations.push(seedRow());

  const row = await store.setConversationLanguage({ conversationId: CONVERSATION_ID, language: 'pt' });

  assert.deepStrictEqual(row, { id: CONVERSATION_ID, language: 'pt' });
  assert.strictEqual(client.log.updates[0].select, 'id, language');
  assert.strictEqual(client.tables.telegram_support_conversations[0].language, 'pt');
});

test('A. a successful language change: confirmation sent, row updated, counter incremented', async () => {
  const h = createHarness();

  const result = await h.bot.handleUpdate(h.languageCallback('lang:pt'));

  assert.strictEqual(result.action, 'language');
  assert.strictEqual(result.language, 'pt');
  assert.strictEqual(h.row().language, 'pt', 'the persisted row must hold the new language');

  const answers = h.callbackAnswers();
  assert.strictEqual(answers.length, 1);
  assert.strictEqual(answers[0].text, i18n.t('pt', 'languageSet'));
  assert.deepStrictEqual(h.toCustomer(), [i18n.t('pt', 'languageSet')], 'the customer is confirmed in Portuguese');

  const stats = h.bot.getStats();
  assert.strictEqual(stats.languageChanges, 1);
  assert.strictEqual(stats.storageFailures, 0);
  assert.strictEqual(stats.lastLanguage, 'pt');
});

// ---------------------------------------------------------------------------
// B. zero-row update
// ---------------------------------------------------------------------------

test('B. store: a zero-row language update is an explicit storage failure, never null', async () => {
  const client = createFakeSupabase({ languageMode: 'no-rows' });
  const store = createTelegramSupportStore(client);
  client.tables.telegram_support_conversations.push(seedRow());

  await assert.rejects(
    () => store.setConversationLanguage({ conversationId: CONVERSATION_ID, language: 'pt' }),
    (error) => {
      assert.match(error.message, /conversation language update/);
      assert.strictEqual(error.supabase.code, 'no-row-returned');
      assert.match(error.supabase.details, /empty body/);
      return true;
    }
  );
  assert.strictEqual(client.tables.telegram_support_conversations[0].language, 'en', 'nothing was written');
});

test('B. a zero-row language update fails the change: no false confirmation, no in-memory mutation', async () => {
  const store = createSpyStore({ languageResult: null });
  const h = createHarness({ store });

  await assert.rejects(() => h.bot.handleUpdate(h.languageCallback('lang:pt')));

  assert.strictEqual(store.conversation.language, 'en', 'the in-memory row must NOT be optimistically changed');
  assert.ok(h.callbackAnswers().every((c) => !c.text), 'no success confirmation is shown');
  assert.deepStrictEqual(h.toCustomer(), [], 'no success confirmation is sent to the chat');

  const stats = h.bot.getStats();
  assert.strictEqual(stats.languageChanges, 0, 'the change is not reported as successful');
  assert.strictEqual(stats.storageFailures, 1, 'the storage failure is recorded');
  assert.strictEqual(stats.lastErrorStage, 'storage:set-language');
  assert.strictEqual(stats.lastLanguage, null);
});

test('B. a zero-row update from the real store also fails the callback (integration)', async () => {
  const h = createHarness({ languageMode: 'no-rows' });

  await assert.rejects(() => h.bot.handleUpdate(h.languageCallback('lang:pt')));

  assert.strictEqual(h.row().language, 'en');
  assert.ok(h.callbackAnswers().every((c) => !c.text));
  assert.deepStrictEqual(h.toCustomer(), []);
  const stats = h.bot.getStats();
  assert.strictEqual(stats.languageChanges, 0);
  assert.strictEqual(stats.storageFailures, 1);
});

// ---------------------------------------------------------------------------
// C. the store reports a different language than the one requested
// ---------------------------------------------------------------------------

test('C. a stored language that differs from the request is treated as a failure', async () => {
  const store = createSpyStore({ languageResult: { id: CONVERSATION_ID, language: 'en' } });
  const h = createHarness({ store });

  await assert.rejects(() => h.bot.handleUpdate(h.languageCallback('lang:pt')), /not persisted/);

  assert.strictEqual(store.conversation.language, 'en');
  assert.ok(h.callbackAnswers().every((c) => !c.text));
  assert.deepStrictEqual(h.toCustomer(), []);
  const stats = h.bot.getStats();
  assert.strictEqual(stats.languageChanges, 0);
  assert.strictEqual(stats.storageFailures, 1);
});

// ---------------------------------------------------------------------------
// D. callback identity
// ---------------------------------------------------------------------------

test('D. routeUpdate exposes the presser (callback_query.from); message.from is the bot', () => {
  const update = {
    update_id: 99,
    callback_query: {
      id: 'cb-99',
      from: CUSTOMER_FROM,
      chat_instance: 'chat-instance',
      data: 'lang:pt',
      message: { message_id: 5150, chat: { id: CUSTOMER_ID, type: 'private' }, from: BOT_FROM }
    }
  };

  const route = routeUpdate(update, { adminIds: [ADMIN_ID], supportChatId: null });

  assert.strictEqual(route.kind, 'callback');
  assert.strictEqual(route.from, CUSTOMER_FROM, 'the route carries the person who pressed');
  assert.strictEqual(route.from.username, 'john');
  assert.strictEqual(route.message.from.username, 'ArbitrixSupportBot', 'the message belongs to the bot');
});

test('D. the stored identity is the customer, never the bot', async () => {
  const h = createHarness();

  await h.bot.handleUpdate(h.languageCallback('lang:pt'));

  const row = h.row();
  assert.strictEqual(row.username, 'john');
  assert.strictEqual(row.display_name, telegramDisplayName(CUSTOMER_FROM));
  assert.notStrictEqual(row.display_name, telegramDisplayName(BOT_FROM));
  assert.ok(!JSON.stringify(row).includes('ArbitrixSupportBot'), 'the bot must never be stored as the customer');

  // Not even transiently: no conversation write may carry the bot's identity.
  h.client.log.updates.filter((u) => u.table === 'telegram_support_conversations').forEach((u) => {
    assert.ok(!JSON.stringify(u.update).includes('ArbitrixSupportBot'), 'a conversation write carried the bot identity');
  });
});

// ---------------------------------------------------------------------------
// E. English / Portuguese / Arabic still work
// ---------------------------------------------------------------------------

test('E. English, Portuguese and Arabic all persist and answer in the selected language', async () => {
  for (const code of ['en', 'pt', 'ar']) {
    const h = createHarness();

    if (code !== 'en') {
      const result = await h.bot.handleUpdate(h.languageCallback('lang:' + code));
      assert.strictEqual(result.language, code);
      assert.strictEqual(h.callbackAnswers()[0].text, i18n.t(code, 'languageSet'));
    }
    assert.strictEqual(h.row().language, code, `${code}: persisted`);

    // The reply language comes from the STORED row, never from the message text.
    await h.bot.handleUpdate(h.message('Ola, como posso comecar a usar a Arbitrix?'));
    const replies = h.toCustomer();
    assert.strictEqual(replies[replies.length - 1], i18n.t(code, 'acknowledgement'), `${code}: answered in ${code}`);
    assert.strictEqual(h.row().language, code, `${code}: still ${code} after a message`);
  }
});

// ---------------------------------------------------------------------------
// F. the operator notification reports the persisted language
// ---------------------------------------------------------------------------

test('F. after a persisted Portuguese selection the notice says Portuguese, not English', async () => {
  const h = createHarness();

  await h.bot.handleUpdate(h.languageCallback('lang:pt'));
  await h.bot.handleUpdate(h.message('Olá, como posso começar a usar a Arbitrix?'));

  const notice = h.toAdmin().pop();
  assert.ok(notice, 'the operator was notified');
  assert.ok(notice.includes('Language: Portuguese'), notice);
  assert.ok(!notice.includes('Language: English'), 'must not report English');
  assert.ok(notice.includes('Olá, como posso começar a usar a Arbitrix?'), 'the original message is preserved');
});

test('F. a customer who never chose is still reported as English', async () => {
  const h = createHarness();

  await h.bot.handleUpdate(h.message('Hello'));

  const notice = h.toAdmin().pop();
  assert.ok(notice.includes('Language: English'), notice);
});

// ---------------------------------------------------------------------------
// G. storage preflight
// ---------------------------------------------------------------------------

test('G. checkStorage verifies the conversation columns the store writes, language included', async () => {
  const h = createHarness();

  const result = await h.bot.checkStorage();

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.tables.conversations, { ok: true });

  const probe = h.client.log.selects.find((s) => s.table === 'telegram_support_conversations' && names(s.columns).includes('language'));
  assert.ok(probe, 'the preflight must probe telegram_support_conversations including language');
  ['id', 'telegram_chat_id', 'telegram_user_id', 'username', 'display_name', 'language', 'updated_at']
    .forEach((column) => assert.ok(names(probe.columns).includes(column), `probe must include ${column}`));
});

test('G. a missing language column is reported instead of a false "conversations ok"', async () => {
  const h = createHarness({ missingColumns: ['language'] });

  const result = await h.bot.checkStorage();

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.tables.conversations.ok, false);
  assert.strictEqual(result.tables.conversations.code, 'PGRST204');
  assert.match(result.tables.conversations.cause, /missing/);
  assert.match(result.tables.conversations.message, /language/);
  assert.ok(!result.tables.conversations.message.includes(TOKEN), 'no secret in the health report');
});

function names(list) {
  return (list && list !== '*') ? String(list).split(',').map((c) => c.trim()) : [];
}
