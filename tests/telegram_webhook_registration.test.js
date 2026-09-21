'use strict';

/**
 * Telegram delivery repair: webhook-registration reconciliation, config
 * de-quoting and secret-free telemetry.
 *
 * Regression context: `setWebhook` and `getMe` can both report success while
 * @ArbitrixSupportBot stays silent, because a webhook registered without the
 * CURRENT `secret_token` (or against a stale URL/path) makes Telegram refuse
 * every delivery. These tests pin
 *   - the pure decision that says "re-assert the registration",
 *   - the bot-level reconciliation that carries it out,
 *   - the config normalization that stops a pasted/quoted value from silently
 *     disabling support-group routing, and
 *   - the rule that no token/secret ever leaves the helper or the logs.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseAdminIds,
  normalizeTelegramId,
  resolveTelegramConfig,
  planWebhookRegistration,
  routeUpdate,
  createTelegramSupportBot,
  createTelegramWebhookHandler,
  TELEGRAM_ALLOWED_UPDATES
} = require('../services/TelegramSupportService');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const TOKEN = '123456:TEST-BOT-TOKEN';
const SECRET = 'test-webhook-secret';
const SUPPORT_CHAT_ID = '-1001234567890';
const ADMIN_ID = '6054625818';
const EXPECTED_URL = 'https://arbitrix.pro/api/telegram/webhook';

function makeTransport({ webhookInfo = null, failWebhookInfo = false, failSetWebhook = false } = {}) {
  const calls = [];
  return {
    calls,
    async sendMessage(chatId, text) {
      calls.push({ method: 'sendMessage', chatId: String(chatId), text });
      return { message_id: 1 };
    },
    async setWebhook(params) {
      calls.push({ method: 'setWebhook', params });
      if (failSetWebhook) throw new Error('Telegram setWebhook failed: simulated');
      return true;
    },
    async getWebhookInfo() {
      calls.push({ method: 'getWebhookInfo' });
      if (failWebhookInfo) throw new Error('Telegram getWebhookInfo failed: simulated');
      return webhookInfo === null ? { url: EXPECTED_URL, pending_update_count: 0 } : webhookInfo;
    }
  };
}

function makeStore() {
  return {
    async upsertConversation() {
      return { conversation: { id: 1, telegram_chat_id: 555000111, display_name: 'Alice' }, created: true };
    },
    async getConversationByChatId() { return null; },
    async insertMessage() { return { message: { id: 1 } }; },
    async setConversationStatus() { return true; },
    async createEscalation() { return { id: 1 }; }
  };
}

function makeBot(transport, configOverrides = {}) {
  return createTelegramSupportBot({
    config: Object.assign({
      token: TOKEN,
      supportChatId: SUPPORT_CHAT_ID,
      adminIds: [ADMIN_ID],
      // Legacy target, so this suite keeps pinning the support-group path.
      notifyTarget: 'group',
      webhookSecret: SECRET,
      baseUrl: 'https://arbitrix.pro'
    }, configOverrides),
    store: makeStore(),
    transport,
    logger: { log() {}, warn() {}, error() {} }
  });
}

// ---------------------------------------------------------------------------
// planWebhookRegistration - pure decision logic
// ---------------------------------------------------------------------------

test('plan: re-registers when no webhook is registered at all', () => {
  const plan = planWebhookRegistration({ url: '', lastErrorMessage: null }, EXPECTED_URL);
  assert.strictEqual(plan.needsRegistration, true);
  assert.strictEqual(plan.reason, 'no-webhook-registered');
});

test('plan: re-registers when the registered URL is not ours', () => {
  const plan = planWebhookRegistration({ url: 'https://example.invalid/hook' }, EXPECTED_URL);
  assert.strictEqual(plan.needsRegistration, true);
  assert.strictEqual(plan.reason, 'url-mismatch');
});

test('plan: re-registers after ANY recorded delivery error (a rejected secret looks exactly like this)', () => {
  const plan = planWebhookRegistration(
    { url: EXPECTED_URL, lastErrorMessage: 'Wrong response from the webhook: 401 Unauthorized' },
    EXPECTED_URL
  );
  assert.strictEqual(plan.needsRegistration, true);
  assert.strictEqual(plan.reason, 'telegram-last-error');
  assert.ok(plan.lastError.includes('401'));
});

test('plan: no-op when the registration is healthy', () => {
  const plan = planWebhookRegistration({ url: EXPECTED_URL, lastErrorMessage: null }, EXPECTED_URL);
  assert.strictEqual(plan.needsRegistration, false);
  assert.strictEqual(plan.reason, 'up-to-date');
});

test('plan: tolerates an unusable getWebhookInfo result', () => {
  assert.strictEqual(planWebhookRegistration(null, EXPECTED_URL).needsRegistration, true);
  assert.strictEqual(planWebhookRegistration(undefined, EXPECTED_URL).reason, 'no-webhook-registered');
});

// ---------------------------------------------------------------------------
// ensureWebhookRegistration - the bot-level reconciliation
// ---------------------------------------------------------------------------

test('reconcile: leaves a healthy registration untouched when not forced', async () => {
  const transport = makeTransport({ webhookInfo: { url: EXPECTED_URL, pending_update_count: 0 } });
  const result = await makeBot(transport).ensureWebhookRegistration();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reRegistered, false);
  assert.strictEqual(result.reason, 'up-to-date');
  assert.strictEqual(transport.calls.filter((c) => c.method === 'setWebhook').length, 0);
});

test('reconcile: force re-asserts the URL and secret even when the state looks healthy (boot path)', async () => {
  const transport = makeTransport({ webhookInfo: { url: EXPECTED_URL, pending_update_count: 0 } });
  const result = await makeBot(transport).ensureWebhookRegistration({ force: true });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reRegistered, true);
  assert.strictEqual(result.reason, 'forced-reassert');
  const set = transport.calls.find((c) => c.method === 'setWebhook');
  assert.strictEqual(set.params.url, EXPECTED_URL);
  assert.strictEqual(set.params.secret_token, SECRET);
  assert.deepStrictEqual(set.params.allowed_updates, TELEGRAM_ALLOWED_UPDATES);
});

test('reconcile: re-asserts the URL AND the secret after a delivery error', async () => {
  const transport = makeTransport({
    webhookInfo: {
      url: EXPECTED_URL,
      pending_update_count: 7,
      last_error_date: 1700000000,
      last_error_message: 'Wrong response from the webhook: 401 Unauthorized'
    }
  });
  const result = await makeBot(transport).ensureWebhookRegistration();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reRegistered, true);
  assert.strictEqual(result.reason, 'telegram-last-error');
  const set = transport.calls.find((c) => c.method === 'setWebhook');
  assert.strictEqual(set.params.url, EXPECTED_URL);
  assert.strictEqual(set.params.secret_token, SECRET, 'the current secret is re-asserted');
  assert.deepStrictEqual(set.params.allowed_updates, TELEGRAM_ALLOWED_UPDATES);
});

test('reconcile: repairs a webhook registered at the wrong path', async () => {
  const transport = makeTransport({ webhookInfo: { url: 'https://arbitrix.pro/api/webhook/telegram' } });
  const result = await makeBot(transport).ensureWebhookRegistration();

  assert.strictEqual(result.reRegistered, true);
  assert.strictEqual(result.reason, 'url-mismatch');
  assert.strictEqual(transport.calls.find((c) => c.method === 'setWebhook').params.url, EXPECTED_URL);
});

test('reconcile: re-asserts when getWebhookInfo itself fails', async () => {
  const transport = makeTransport({ failWebhookInfo: true });
  const result = await makeBot(transport).ensureWebhookRegistration();

  assert.strictEqual(result.reRegistered, true);
  assert.strictEqual(result.reason, 'probe-failed-reasserted');
  assert.ok(result.probeError && result.probeError.includes('getWebhookInfo'));
});

test('reconcile: is inert when configuration is incomplete', async () => {
  for (const overrides of [{ token: '' }, { webhookSecret: '' }, { baseUrl: '' }]) {
    const transport = makeTransport();
    const result = await makeBot(transport, overrides).ensureWebhookRegistration();
    assert.strictEqual(result.ok, false, JSON.stringify(overrides));
    assert.strictEqual(result.reason, 'not-configured');
    assert.strictEqual(transport.calls.length, 0);
  }
});

test('reconcile: a failing setWebhook is reported without leaking the token or secret', async () => {
  const transport = makeTransport({
    webhookInfo: { url: 'https://wrong.example/hook' },
    failSetWebhook: true
  });
  const result = await makeBot(transport).ensureWebhookRegistration();

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'set-webhook-failed');
  assert.ok(result.error.includes('setWebhook'));
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(TOKEN), 'token never returned');
  assert.ok(!serialized.includes(SECRET), 'secret never returned');
});

// ---------------------------------------------------------------------------
// Config normalization - a quoted value must not silently disable routing
// ---------------------------------------------------------------------------

test('id normalization strips surrounding quotes and whitespace', () => {
  assert.strictEqual(normalizeTelegramId('"-1001234567890"'), SUPPORT_CHAT_ID);
  assert.strictEqual(normalizeTelegramId("'6054625818'"), ADMIN_ID);
  assert.strictEqual(normalizeTelegramId('  -1001234567890  '), SUPPORT_CHAT_ID);
  assert.strictEqual(normalizeTelegramId(''), '');
});

test('parseAdminIds strips quotes per entry and drops empties', () => {
  assert.deepStrictEqual(parseAdminIds('"6054625818", 999'), [ADMIN_ID, '999']);
  assert.deepStrictEqual(parseAdminIds('"6054625818"'), [ADMIN_ID]);
  assert.deepStrictEqual(parseAdminIds(' , 6054625818 , '), [ADMIN_ID]);
  assert.deepStrictEqual(parseAdminIds(''), []);
});

test('resolveTelegramConfig de-quotes every Telegram env value', () => {
  const cfg = resolveTelegramConfig({
    TELEGRAM_BOT_TOKEN: '"' + TOKEN + '"',
    TELEGRAM_WEBHOOK_SECRET: '"' + SECRET + '"',
    TELEGRAM_SUPPORT_CHAT_ID: '"' + SUPPORT_CHAT_ID + '"',
    TELEGRAM_ADMIN_IDS: '"' + ADMIN_ID + '"',
    BASE_URL: 'https://arbitrix.pro/'
  });

  assert.strictEqual(cfg.token, TOKEN);
  assert.strictEqual(cfg.webhookSecret, SECRET);
  assert.strictEqual(cfg.supportChatId, SUPPORT_CHAT_ID);
  assert.deepStrictEqual(cfg.adminIds, [ADMIN_ID]);
  assert.strictEqual(cfg.baseUrl, 'https://arbitrix.pro');
});

test('a quoted support chat id no longer makes the support group unrecognizable', () => {
  const cfg = resolveTelegramConfig({
    TELEGRAM_SUPPORT_CHAT_ID: '"' + SUPPORT_CHAT_ID + '"',
    TELEGRAM_ADMIN_IDS: '"' + ADMIN_ID + '"'
  });

  const route = routeUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: Number(SUPPORT_CHAT_ID), type: 'supergroup', title: 'Arbitrix Support' },
      from: { id: Number(ADMIN_ID), first_name: 'Agent' },
      text: '/chatid'
    }
  }, cfg);

  assert.strictEqual(route.kind, 'group', 'the configured group is accepted');
  assert.strictEqual(route.isAdmin, true, 'the quoted admin id still matches');
});

// ---------------------------------------------------------------------------
// Webhook handler telemetry
// ---------------------------------------------------------------------------

test('handler: a missing secret header is counted and explained, and the secret is never logged', async () => {
  const transport = makeTransport();
  const bot = makeBot(transport);
  const lines = [];
  const handler = createTelegramWebhookHandler({
    bot,
    logger: { log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }
  });

  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ get: () => undefined, headers: {}, body: { update_id: 1 } }, res);

  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(bot.getStats().secretRejected, 1);
  assert.ok(lines.join('\n').includes('secret_token'), 'logs an actionable hint');
  assert.ok(!lines.join('\n').includes(SECRET), 'the secret value is never logged');
});

test('handler: a correctly signed update is processed and counted', async () => {
  const transport = makeTransport();
  const bot = makeBot(transport);
  const handler = createTelegramWebhookHandler({ bot, logger: { log() {}, warn() {}, error() {} } });

  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const req = {
    get: (name) => (name.toLowerCase() === 'x-telegram-bot-api-secret-token' ? SECRET : undefined),
    headers: {},
    body: {
      update_id: 2,
      message: {
        message_id: 1,
        chat: { id: 555000111, type: 'private' },
        from: { id: 555000111, first_name: 'Alice' },
        text: '/start'
      }
    }
  };
  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.handled, true);
  const stats = bot.getStats();
  assert.strictEqual(stats.updatesReceived, 1);
  assert.strictEqual(stats.processed, 1);
  assert.strictEqual(stats.repliesSent, 1);
});

// ---------------------------------------------------------------------------
// server.js wiring
// ---------------------------------------------------------------------------

test('server.js reconciles the Telegram webhook on boot, gated on a complete config', () => {
  assert.ok(SERVER.includes('ensureWebhookRegistration({ force: true })'), 'boot reconciliation is wired and forces a re-assert');
  assert.ok(SERVER.includes('[Telegram] Webhook reconciliation:'));
  assert.ok(
    SERVER.includes('telegramConfig.token && telegramConfig.webhookSecret && telegramConfig.baseUrl'),
    'only runs when token+secret+BASE_URL are all present'
  );
  assert.ok(SERVER.includes('TELEGRAM_WEBHOOK_AUTO_REGISTER'), 'has an opt-out');
});

test('the reconciliation log reports only non-secret fields and scrubs the token', () => {
  const start = SERVER.indexOf('const telegramAutoRegister');
  const block = SERVER.slice(start, SERVER.indexOf('}, 2000);', start));
  assert.ok(block.includes('scrub('), 'values are scrubbed before logging');

  // Inspect only the log payload: the guard above it legitimately reads the
  // configured secret/token to decide whether to run.
  const logStart = block.indexOf("console.log('[Telegram] Webhook reconciliation");
  assert.ok(logStart > -1, 'the reconciliation logs its outcome');
  const logBlock = block.slice(logStart);

  assert.ok(!/webhookSecret/.test(logBlock), 'the webhook secret is never logged');
  assert.ok(!/telegramConfig\.token\b/.test(logBlock), 'the raw token is never logged');
  assert.ok(!/process\.env/.test(logBlock), 'no raw environment value is logged');
  assert.ok(logBlock.includes("expectedPath: '/api/telegram/webhook'"));
});

test('server.js runs a secret-free Telegram storage preflight after startup', () => {
  assert.ok(SERVER.includes('telegramBot.checkStorage()'), 'storage is probed at boot');
  assert.ok(SERVER.includes('[Telegram] Storage preflight:'), 'the result is logged');
  const start = SERVER.indexOf('Telegram storage preflight');
  const block = SERVER.slice(start, SERVER.indexOf('}, 3000);', start));
  assert.ok(block.includes('scrub('), 'the error is scrubbed');
  assert.ok(!/webhookSecret/.test(block), 'the webhook secret is never logged');
  assert.ok(!/process\.env/.test(block), 'no raw environment value is logged');
});

test('this change does not enable the trading worker', () => {
  // server.js only READS the flag (a status report); nothing assigns or forces it.
  assert.ok(!/process\.env\.TRADING_WORKER_ENABLED\s*=/.test(SERVER));
  assert.ok(!/TRADING_WORKER_ENABLED['"]?\]?\s*=\s*['"]true['"]/.test(SERVER));
});
