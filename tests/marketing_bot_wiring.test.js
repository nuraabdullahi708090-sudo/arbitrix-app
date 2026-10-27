'use strict';

/**
 * Wiring: new-member routing, the opt-in subscription commands, and the admin
 * publishing surface.
 *
 * These tests protect the EXISTING support behaviour as much as the new
 * features: a normal customer message must still reach the support flow, the
 * webhook secret gate must stay in place, and no publishing route may be
 * reachable without an admin.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { routeUpdate, createTelegramSupportBot, USER_HELP_TEXT } = require('../services/TelegramSupportService');
const { t } = require('../services/telegram-i18n');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const GROUP = '-1001234567890';

function joinUpdate(over) {
  return Object.assign({
    update_id: 100,
    message: {
      message_id: 9,
      chat: { id: Number(GROUP), type: 'supergroup', title: 'Arbitrix Partners' },
      from: { id: 5, first_name: 'Operator' },
      new_chat_members: [{ id: 777, first_name: 'Ana', is_bot: false }]
    }
  }, over || {});
}

function fakeStore() {
  const calls = { upsert: 0, get: 0 };
  return {
    calls,
    async getConversationByChatId() {
      calls.get += 1;
      return { id: 1, language: 'en', telegram_chat_id: '42' };
    },
    async upsertConversation() {
      calls.upsert += 1;
      return { conversation: { id: 1, language: 'en', telegram_chat_id: '42' }, created: false };
    },
    async insertMessage() {
      return { message: { id: 2 } };
    },
    async createEscalation() {
      return { escalation: { id: 1 } };
    },
    async getLatestMessageByConversation() {
      return { id: 1, direction: 'customer' };
    }
  };
}

function fakeTransport() {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, options) {
      sent.push({ chatId, text, options });
      return { message_id: 1 };
    }
  };
}

function botWith(options) {
  const o = options || {};
  const store = o.store || fakeStore();
  const transport = o.transport || fakeTransport();
  const bot = createTelegramSupportBot({
    config: { adminIds: ['5'], supportChatId: '-1005555555555', notifyTarget: 'admins', token: 'x', webhookSecret: 'y' },
    store,
    transport,
    logger: { log() {}, warn() {}, error() {} },
    onNewMembers: o.onNewMembers,
    marketing: o.marketing
  });
  return { bot, store, transport };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('new_chat_members routes as a join event, before text parsing', () => {
  const route = routeUpdate(joinUpdate(), { adminIds: [], supportChatId: null });
  assert.strictEqual(route.kind, 'join');
  assert.strictEqual(route.chatId, GROUP);
  assert.strictEqual(route.chatTitle, 'Arbitrix Partners');
  assert.strictEqual(route.messageId, '9');
  assert.deepStrictEqual(route.members, [{ id: '777', firstName: 'Ana', name: 'Ana', isBot: false }]);
});

test('a bot joining is flagged so onboarding can ignore it', () => {
  const update = joinUpdate();
  update.message.new_chat_members = [{ id: 42, first_name: 'Helper', is_bot: true }];
  const route = routeUpdate(update, { adminIds: [] });
  assert.strictEqual(route.kind, 'join');
  assert.strictEqual(route.members[0].isBot, true);
});

test('a join event in a private chat is not treated as a group join', () => {
  const update = joinUpdate();
  update.message.chat = { id: 777, type: 'private' };
  assert.notStrictEqual(routeUpdate(update, { adminIds: [] }).kind, 'join');
});

test('ordinary support traffic still routes exactly as before', () => {
  const support = routeUpdate({
    update_id: 1,
    message: {
      message_id: 2,
      chat: { id: -1005555555555, type: 'supergroup', title: 'Support' },
      from: { id: 9, first_name: 'Customer' },
      text: 'hello'
    }
  }, { adminIds: [], supportChatId: '-1005555555555' });
  assert.strictEqual(support.kind, 'group');

  const privateChat = routeUpdate({
    update_id: 2,
    message: { message_id: 3, chat: { id: 9, type: 'private' }, from: { id: 9, first_name: 'C' }, text: 'hi' }
  }, { adminIds: [] });
  assert.strictEqual(privateChat.kind, 'user');
});

test('a message in the marketing group does not open a support ticket', () => {
  const route = routeUpdate({
    update_id: 3,
    message: {
      message_id: 4,
      chat: { id: Number(GROUP), type: 'supergroup', title: 'Partners' },
      from: { id: 9, first_name: 'Partner' },
      text: 'how do I withdraw'
    }
  }, { adminIds: [], supportChatId: null });
  assert.strictEqual(route.kind, 'ignore');
  assert.strictEqual(route.reason, 'unconfigured-group-non-admin');
});

// ---------------------------------------------------------------------------
// Join handler
// ---------------------------------------------------------------------------

test('a join update calls the onboarding handler once', async () => {
  const seen = [];
  const { bot } = botWith({ onNewMembers: async (event) => { seen.push(event); return { sent: true }; } });
  const result = await bot.handleUpdate(joinUpdate());
  assert.strictEqual(result.action, 'welcome-sent');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].chatId, GROUP);
});

test('a join without a configured onboarding handler is acknowledged, not a crash', async () => {
  const { bot } = botWith({});
  const result = await bot.handleUpdate(joinUpdate());
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'onboarding-not-configured');
});

test('an onboarding failure never fails the webhook', async () => {
  const { bot } = botWith({ onNewMembers: async () => { throw new Error('telegram exploded'); } });
  const result = await bot.handleUpdate(joinUpdate());
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'onboarding-error');
});

// ---------------------------------------------------------------------------
// /subscribe and /unsubscribe
// ---------------------------------------------------------------------------

test('the help text advertises the opt-in commands in every language', () => {
  for (const lang of ['en', 'pt', 'ar']) {
    const help = t(lang, 'help');
    assert.ok(help.includes('/subscribe'), lang + ' help lacks /subscribe');
    assert.ok(help.includes('/unsubscribe'), lang + ' help lacks /unsubscribe');
  }
  assert.strictEqual(USER_HELP_TEXT, t('en', 'help'));
});

test('/subscribe persists consent and confirms', async () => {
  const calls = [];
  const { bot, transport } = botWith({
    marketing: {
      async subscribe(args) { calls.push(['subscribe', args]); return { ok: true }; },
      async unsubscribe(args) { calls.push(['unsubscribe', args]); return { ok: true }; }
    }
  });
  const result = await bot.handleUpdate({
    update_id: 200,
    message: { message_id: 21, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Ana' }, text: '/subscribe' }
  });
  assert.strictEqual(result.action, 'subscribe');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], 'subscribe');
  assert.strictEqual(String(calls[0][1].chatId), '42');
  assert.strictEqual(transport.sent.length, 1);
  assert.match(transport.sent[0].text, /subscribed to partner updates/i);
});

test('/unsubscribe revokes consent and confirms', async () => {
  const calls = [];
  const { bot, transport } = botWith({
    marketing: {
      async subscribe() { return { ok: true }; },
      async unsubscribe(args) { calls.push(args); return { ok: true }; }
    }
  });
  const result = await bot.handleUpdate({
    update_id: 201,
    message: { message_id: 22, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Ana' }, text: '/unsubscribe' }
  });
  assert.strictEqual(result.action, 'unsubscribe');
  assert.strictEqual(calls.length, 1);
  assert.match(transport.sent[0].text, /unsubscribed from partner updates/i);
});

test('a storage failure on /subscribe degrades to a clear message and does not throw', async () => {
  const { bot, transport } = botWith({
    marketing: {
      async subscribe() { throw new Error('db down'); },
      async unsubscribe() { return { ok: true }; }
    }
  });
  const result = await bot.handleUpdate({
    update_id: 202,
    message: { message_id: 23, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Ana' }, text: '/subscribe' }
  });
  assert.strictEqual(result.action, 'subscribe-failed');
  assert.strictEqual(transport.sent.length, 1);
  assert.match(transport.sent[0].text, /not available right now/i);
});

test('without a marketing store the command answers instead of failing silently', async () => {
  const { bot, transport } = botWith({});
  const result = await bot.handleUpdate({
    update_id: 203,
    message: { message_id: 24, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Ana' }, text: '/subscribe' }
  });
  assert.strictEqual(result.action, 'subscribe-unavailable');
  assert.strictEqual(transport.sent.length, 1);
});

test('unsubscribing never changes support behaviour', async () => {
  const { bot, transport } = botWith({
    marketing: { async subscribe() { return { ok: true }; }, async unsubscribe() { return { ok: true }; } }
  });
  await bot.handleUpdate({
    update_id: 204,
    message: { message_id: 25, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Ana' }, text: '/unsubscribe' }
  });
  await bot.handleUpdate({
    update_id: 205,
    message: { message_id: 26, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Ana' }, text: 'I need help' }
  });
  // A plain customer message must still receive the support acknowledgement.
  // Operator notifications also travel through the same transport, so only the
  // messages addressed to the customer chat are inspected here.
  const toCustomer = transport.sent.filter((m) => String(m.chatId) === '42');
  assert.ok(toCustomer.length >= 2, 'the support reply must still be sent');
  assert.match(toCustomer[toCustomer.length - 1].text, /Arbitrix Support/i);
});

// ---------------------------------------------------------------------------
// Admin publishing surface
// ---------------------------------------------------------------------------

test('no publishing endpoint is reachable without admin authorisation', () => {
  const registrations = SERVER.match(/app\.(get|post|patch|put)\('\/api\/admin\/marketing\/[^']*'[^)]*\)/g) || [];
  assert.ok(registrations.length >= 9, 'expected the full admin marketing surface');
  for (const line of registrations) {
    assert.match(line, /authMiddleware/, 'missing authMiddleware: ' + line);
    assert.match(line, /adminMiddleware/, 'missing adminMiddleware: ' + line);
  }
  // The pre-existing unauthenticated-looking generic webhook must not have been
  // reused for publishing.
  assert.ok(!/app\.post\('\/api\/marketing\//.test(SERVER), 'no unauthenticated marketing route may exist');
});

test('the publisher never accepts a destination chat id from the client', () => {
  const start = SERVER.indexOf('// TELEGRAM MARKETING PUBLISHER (admin)');
  assert.ok(start > 0);
  const block = SERVER.slice(start, start + 30000);
  assert.ok(!/req\.body\.chat_id|req\.body\.chatId/.test(block), 'a client-supplied chat id must be ignored');
  assert.match(block, /chat_id: null/, 'queue rows keep chat_id null and resolve it at send time');
});

test('custom content is guarded before it can be queued', () => {
  const start = SERVER.indexOf("app.post('/api/admin/marketing/posts'");
  const block = SERVER.slice(start, start + 4000);
  assert.ok(block.indexOf('marketingGuardReport') < block.indexOf('marketingStore.insertPost'),
    'the guard must run before the insert');
  assert.match(block, /if \(guard\.blocked\)/);
  assert.match(block, /awaiting_approval/);
});

test('a blocked post can never be approved into the queue', () => {
  const start = SERVER.indexOf("app.patch('/api/admin/marketing/posts/:id'");
  const block = SERVER.slice(start, start + 4000);
  assert.match(block, /Content is blocked and must be rewritten/);
  assert.ok(block.indexOf('marketingGuardReport') < block.indexOf("status: 'scheduled'"));
});

test('the control route only accepts booleans (no arbitrary patch)', () => {
  const start = SERVER.indexOf("app.post('/api/admin/marketing/control'");
  const block = SERVER.slice(start, start + 1600);
  assert.match(block, /typeof body\.paused !== 'boolean'/);
  assert.match(block, /typeof body\.dryRun !== 'boolean'/);
});

test('pinning is limited to the configured group', () => {
  const start = SERVER.indexOf("app.post('/api/admin/marketing/pin'");
  const block = SERVER.slice(start, start + 1600);
  assert.match(block, /validateDestination\(marketingConfig\.groupChatId, marketingConfig\)/);
  assert.match(block, /pinChatMessage/);
});

test('the bot is constructed with onboarding and the subscription store', () => {
  assert.match(SERVER, /onNewMembers: \(event\) => marketingOnboarding\.handleNewMembers\(event\)/);
  assert.match(SERVER, /marketing: marketingStore/);
  assert.match(SERVER, /createOnboarding\(\{/);
});

test('marketing facts come from the application constants', () => {
  assert.match(SERVER, /minDeposit: PLATFORM_MIN_DEPOSIT_USD/);
  assert.match(SERVER, /referralPercent: REFERRAL_REWARD_PERCENT_DEFAULT/);
});

test('the publishing surface does not call a money RPC', () => {
  const start = SERVER.indexOf('// TELEGRAM MARKETING PUBLISHER (admin)');
  const end = SERVER.indexOf('/api/admin/marketing/control');
  const block = SERVER.slice(start, end + 2000);
  assert.ok(!/record_trade_safe|credit_payment_safe|charge_subscription_safe|convert_referral_earnings_safe/.test(block));
  assert.ok(!/from\('(wallets|trades|deposits|withdrawals)'\)/.test(block));
});

test('the worker entrypoint exits 0 and sends nothing when disabled', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'marketing-worker.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { TELEGRAM_MARKETING_ENABLED: 'false' }),
    encoding: 'utf8',
    timeout: 20000
  });
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /worker_disabled/);
  assert.ok(!/worker_started/.test(result.stdout), 'the worker must not start while disabled');
});

test('the worker refuses to start without the service credential', () => {
  const env = Object.assign({}, process.env, {
    TELEGRAM_MARKETING_ENABLED: 'true',
    TELEGRAM_MARKETING_CHAT_ID: '-1001234567890',
    SUPABASE_URL: '',
    SUPABASE_SERVICE_KEY: ''
  });
  const result = spawnSync(process.execPath, [path.join(ROOT, 'marketing-worker.js')], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 20000
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /worker_misconfigured/);
  assert.ok(!/worker_started/.test(result.stdout));
});

test('the migration file is the only schema change this feature adds', () => {
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'));
  // Scope to the marketing feature's own file: later features add their own
  // migrations (e.g. 039_telegram_account_links.sql) and must not fail this.
  const added = migrations.filter((f) => /^038/.test(f));
  assert.deepStrictEqual(added, ['038_marketing_broadcast.sql']);
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '038_marketing_broadcast.sql'), 'utf8');
  // Content publishing only: no ALTER of a financial table.
  assert.ok(!/ALTER TABLE public\.(wallets|trades|deposits|withdrawals|subscriptions|referrals|users)/.test(sql));
  assert.ok(!/sandbox_/.test(sql));
});
