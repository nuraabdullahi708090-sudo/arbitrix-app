'use strict';

/**
 * Telegram delivery whitelist: inline-keyboard presses must be deliverable.
 *
 * Production incident this file pins down:
 *   a customer opened /language and tapped "Português"/"العربية". The button only
 *   showed the local pressed state - no toast, no language change, no bot action -
 *   and nothing was recorded anywhere.
 *
 * Root cause: Telegram treats `setWebhook`'s `allowed_updates` as a DELIVERY
 * WHITELIST. The canonical list was `['message', 'edited_message']`, so every
 * `callback_query` update was dropped by Telegram BEFORE reaching the webhook.
 * A filtered type is not an error: `pending_update_count` stayed 0,
 * `last_error_message` stayed blank and every registration looked healthy, while
 * `routeUpdate()`, `handleLanguageCallback()` and the acknowledgement were all
 * perfectly functional - they were simply never given the update.
 *
 * Covered here:
 *   - the canonical list contains `callback_query`;
 *   - BOTH registration paths (boot reconciliation and the admin
 *     POST /api/telegram/set-webhook route) send that same list;
 *   - no other hardcoded whitelist exists that could re-impose messages-only;
 *   - every update kind `routeUpdate()` routes is deliverable (the invariant that
 *     prevents the next "new update type forgotten in the whitelist" outage);
 *   - the /language inline buttons specifically depend on `callback_query`.
 *
 * Read-only structural checks; the bot/transport are doubles, no network.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  TELEGRAM_ALLOWED_UPDATES,
  createTelegramSupportBot,
  routeUpdate
} = require('../services/TelegramSupportService');
const i18n = require('../services/telegram-i18n');

const ROOT = path.join(__dirname, '..');
const SERVICE_PATH = path.join(ROOT, 'services', 'TelegramSupportService.js');
const SERVICE = fs.readFileSync(SERVICE_PATH, 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const EXPECTED = ['message', 'edited_message', 'callback_query'];
const TOKEN = '123456:TEST-BOT-TOKEN';
const SECRET = 'test-webhook-secret';
const ADMIN_ID = '6054625818';
const SUPPORT_CHAT_ID = '-1001234567890';
const EXPECTED_URL = 'https://arbitrix.pro/api/telegram/webhook';

function makeTransport({ webhookInfo = null } = {}) {
  const calls = [];
  return {
    calls,
    async sendMessage(chatId, text) {
      calls.push({ method: 'sendMessage', chatId: String(chatId), text });
      return { message_id: 1 };
    },
    // The params object is recorded BY REFERENCE (as the real transport receives
    // it), so a test can prove both paths hand over the canonical constant itself.
    async setWebhook(params) {
      calls.push({ method: 'setWebhook', params });
      return true;
    },
    async getWebhookInfo() {
      calls.push({ method: 'getWebhookInfo' });
      return webhookInfo === null ? { url: EXPECTED_URL, pending_update_count: 0 } : webhookInfo;
    }
  };
}

function makeBot(transport) {
  return createTelegramSupportBot({
    config: {
      token: TOKEN,
      supportChatId: SUPPORT_CHAT_ID,
      adminIds: [ADMIN_ID],
      webhookSecret: SECRET,
      baseUrl: 'https://arbitrix.pro'
    },
    store: {
      async upsertConversation() {
        return { conversation: { id: 1, telegram_chat_id: 555000111, display_name: 'Alice' }, created: true };
      },
      async getConversationByChatId() { return null; },
      async insertMessage() { return { message: { id: 1 } }; },
      async setConversationStatus() { return true; },
      async createEscalation() { return { id: 1 }; }
    },
    transport,
    logger: { log() {}, warn() {}, error() {} }
  });
}

function makeWebhookInfo(overrides = {}) {
  return Object.assign({ url: EXPECTED_URL, pending_update_count: 0 }, overrides);
}

// ---------------------------------------------------------------------------
// 1. The canonical list
// ---------------------------------------------------------------------------

test('the canonical whitelist includes callback_query', () => {
  assert.deepStrictEqual(TELEGRAM_ALLOWED_UPDATES, EXPECTED);
  assert.ok(TELEGRAM_ALLOWED_UPDATES.includes('callback_query'),
    'without callback_query Telegram never delivers inline-button presses');
  assert.ok(TELEGRAM_ALLOWED_UPDATES.includes('message'));
  assert.ok(TELEGRAM_ALLOWED_UPDATES.includes('edited_message'));
});

test('the whitelist literal in the source file matches the exported constant', () => {
  const match = /const TELEGRAM_ALLOWED_UPDATES = (\[[^\]]*\])/.exec(SERVICE);
  assert.ok(match, 'the canonical list is defined in the service');
  assert.deepStrictEqual(JSON.parse(match[1].replace(/'/g, '"')), EXPECTED);
  // Defined ONCE: a second definition would be a competing source of truth.
  assert.strictEqual((SERVICE.match(/const TELEGRAM_ALLOWED_UPDATES =/g) || []).length, 1);
});

// ---------------------------------------------------------------------------
// 2. Both registration paths carry it
// ---------------------------------------------------------------------------

test('the boot webhook reconciliation whitelists callback_query', async () => {
  const transport = makeTransport({ webhookInfo: makeWebhookInfo() });
  const bot = makeBot(transport);

  const result = await bot.ensureWebhookRegistration({ force: true });

  assert.strictEqual(result.ok, true);
  const set = transport.calls.find((c) => c.method === 'setWebhook');
  assert.ok(set, 'the boot path calls setWebhook');
  assert.deepStrictEqual(set.params.allowed_updates, EXPECTED);
  assert.ok(set.params.allowed_updates.includes('callback_query'));
});

test('the POST /api/telegram/set-webhook route whitelists callback_query', async () => {
  const transport = makeTransport();
  const bot = makeBot(transport);

  const result = await bot.setWebhook();

  assert.strictEqual(result.url, EXPECTED_URL);
  const set = transport.calls.find((c) => c.method === 'setWebhook');
  assert.ok(set, 'the admin route calls setWebhook');
  assert.deepStrictEqual(set.params.allowed_updates, EXPECTED);
  assert.ok(set.params.allowed_updates.includes('callback_query'));
});

test('both registration paths send the SAME list object (one source of truth)', async () => {
  const transport = makeTransport({ webhookInfo: makeWebhookInfo() });
  const bot = makeBot(transport);

  await bot.ensureWebhookRegistration({ force: true });
  await bot.setWebhook();

  const payloads = transport.calls.filter((c) => c.method === 'setWebhook').map((c) => c.params.allowed_updates);
  assert.strictEqual(payloads.length, 2, 'boot reconciliation + admin route');
  // Identity, not just equality: both paths hand over the exported constant, so
  // the two registrations cannot drift apart.
  assert.strictEqual(payloads[0], TELEGRAM_ALLOWED_UPDATES);
  assert.strictEqual(payloads[1], TELEGRAM_ALLOWED_UPDATES);
});

test('server.js keeps the boot reconciliation on the corrected list', () => {
  // The boot path must keep force-re-asserting, otherwise a webhook registered
  // with the OLD messages-only list would survive our next deploy.
  assert.match(SERVER, /telegramBot\.ensureWebhookRegistration\(\{\s*force:\s*true\s*\}\)/);
  // The admin route delegates to the same bot method that sends the canonical list.
  assert.match(SERVER, /telegramBot\.setWebhook\(\)/);
});

// ---------------------------------------------------------------------------
// 3. No competing whitelist can re-impose messages-only
// ---------------------------------------------------------------------------

test('no other hardcoded whitelist exists anywhere in the repository', () => {
  const skip = new Set(['node_modules', '.git', '.agent_tmp', 'coverage']);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(ROOT);

  // The only permitted literal form is the canonical 3-element list.
  // Comment lines are skipped: prose explaining the retired list cannot register a
  // webhook, and the audit stays strict for every line of real code.
  const oldList = /'message'\s*,\s*'edited_message'\s*\]/;
  const isCommentLine = (line) => /^\s*(\*|\/\/|\/\*)/.test(line);
  const offenders = files.filter((file) => fs.readFileSync(file, 'utf8')
    .split('\n')
    .some((line) => !isCommentLine(line) && oldList.test(line)));
  assert.deepStrictEqual(offenders.map((f) => path.relative(ROOT, f)), [],
    'the messages-only whitelist must not remain anywhere (it would ship the outage)');

  // Every registration payload in NON-test code must reference the constant
  // rather than spelling out its own list.
  const sources = files.filter((f) => !f.includes(`${path.sep}tests${path.sep}`));
  const literals = [];
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/allowed_updates\s*:\s*([^\s,;\n}]+)/g)) {
      if (match[1] !== 'TELEGRAM_ALLOWED_UPDATES') literals.push(`${path.relative(ROOT, file)}: ${match[1]}`);
    }
  }
  assert.deepStrictEqual(literals, [],
    'every allowed_updates value must be the canonical TELEGRAM_ALLOWED_UPDATES constant');
});

// ---------------------------------------------------------------------------
// 4. The invariant that prevents the next occurrence of this outage
// ---------------------------------------------------------------------------

test('every update kind routeUpdate() routes is deliverable', () => {
  const chatId = 555000111;
  const adminChatId = Number(ADMIN_ID);
  const cases = [
    {
      type: 'message',
      update: {
        update_id: 1,
        message: { message_id: 1, text: 'hello', chat: { id: chatId, type: 'private' }, from: { id: chatId } }
      }
    },
    {
      type: 'edited_message',
      update: {
        update_id: 2,
        edited_message: { message_id: 1, text: 'hello again', chat: { id: chatId, type: 'private' }, from: { id: chatId } }
      }
    },
    {
      type: 'message',
      update: {
        update_id: 3,
        message: {
          message_id: 2, text: 'group message',
          chat: { id: Number(SUPPORT_CHAT_ID), type: 'supergroup' },
          from: { id: adminChatId }
        }
      }
    },
    {
      type: 'callback_query',
      update: {
        update_id: 4,
        callback_query: {
          id: 'cb-1', from: { id: chatId }, chat_instance: 'ci', data: 'lang:pt',
          message: { message_id: 3, chat: { id: chatId, type: 'private' }, from: { id: 777000, is_bot: true } }
        }
      }
    }
  ];

  const routed = cases.map((c) => Object.assign({}, c, {
    kind: routeUpdate(c.update, { adminIds: [ADMIN_ID], supportChatId: SUPPORT_CHAT_ID }).kind
  }));

  routed.forEach((c) => {
    assert.notStrictEqual(c.kind, 'ignore', `${c.type} must be routed, not ignored`);
    assert.ok(TELEGRAM_ALLOWED_UPDATES.includes(c.type),
      `${c.type} is routed by routeUpdate() but NOT whitelisted -> Telegram would never deliver it`);
  });

  // And the reverse: no whitelisted entry is dead weight (each one is routed).
  TELEGRAM_ALLOWED_UPDATES.forEach((type) => {
    assert.ok(routed.some((c) => c.type === type),
      `${type} is whitelisted but no routing case covers it`);
  });
});

test('the /language inline buttons depend on callback_query being whitelisted', () => {
  const buttons = i18n.languageKeyboard().inline_keyboard.flat();
  assert.deepStrictEqual(buttons.map((b) => b.callback_data), ['lang:en', 'lang:pt', 'lang:ar']);
  // A press produces a callback_query update: whitelisting it is what makes /language work.
  assert.ok(TELEGRAM_ALLOWED_UPDATES.includes('callback_query'));
  assert.strictEqual(i18n.parseLanguageCallback('lang:pt'), 'pt');
});

// ---------------------------------------------------------------------------
// 5. The delivery-level regression itself
// ---------------------------------------------------------------------------

test('a registration built from the corrected list is NOT messages-only', async () => {
  const transport = makeTransport({ webhookInfo: makeWebhookInfo() });
  await makeBot(transport).ensureWebhookRegistration({ force: true });

  const payload = transport.calls.find((c) => c.method === 'setWebhook').params;
  // The outage was a whitelist of messages only: presses were dropped by Telegram.
  // Assert the delivered set explicitly rather than by naming the retired list, so
  // this file stays clean for the repository-wide audit above.
  assert.deepStrictEqual(payload.allowed_updates, EXPECTED);
  assert.strictEqual(payload.allowed_updates.length, 3);
  assert.ok(payload.allowed_updates.includes('callback_query'));
  assert.ok(payload.allowed_updates.includes('message'));
  assert.ok(payload.allowed_updates.includes('edited_message'));
  // Nothing else about the registration changed.
  assert.strictEqual(payload.url, EXPECTED_URL);
  assert.strictEqual(payload.secret_token, SECRET);
});
