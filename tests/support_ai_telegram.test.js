'use strict';

/**
 * Stage 2 - the AI support layer wired into the Telegram customer-support flow.
 *
 * These integration tests drive the REAL TelegramSupportService factory with a
 * fake store/transport, so the exact production code path is exercised:
 *
 *   message -> conversation+message persisted -> reply composed (AI or the
 *   standard guide text) -> persisted -> forwarded to the support group.
 *
 * The AI layer is optional and OFF by default: with no `supportAI` the bot's
 * customer-visible behaviour is unchanged, and a disabled or failing AI can only
 * ever degrade to the existing human-support flow.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  createTelegramSupportBot,
  createTelegramWebhookHandler,
  CUSTOMER_GUIDE_TEXT,
  ESCALATION_ACK,
  USER_HELP_TEXT,
  DIRECTION_CUSTOMER,
  DIRECTION_BOT
} = require('../services/TelegramSupportService');

const { createSupportAIService, resolveSupportAIConfig } = require('../services/support/SupportAIService');
const S = require('../services/support/SupportKnowledge');
const G = require('../services/support/SupportGuidelines');

const ROOT = path.join(__dirname, '..');
const KB = S.readKnowledge();

const SUPPORT_CHAT_ID = '-100777';
const CUSTOMER_CHAT_ID = '4242';
const ADMIN_ID = '5';
const WEBHOOK_SECRET = 'stage2-webhook-secret';

const silentLogger = { log() {}, warn() {}, error() {}, info() {} };

// ---------------------------------------------------------------- harness ---

function createHarness({ supportAI = null, supportChatId = SUPPORT_CHAT_ID } = {}) {
  const sent = [];
  const stored = [];
  const escalations = [];
  const conversations = new Map();
  let nextConversationId = 1;

  const store = {
    async upsertConversation({ chatId, telegramUserId, username, displayName }) {
      const key = String(chatId);
      if (!conversations.has(key)) {
        conversations.set(key, {
          id: nextConversationId++,
          telegram_chat_id: key,
          telegram_user_id: telegramUserId,
          username: username || null,
          display_name: displayName || null
        });
        return { conversation: conversations.get(key), created: true };
      }
      return { conversation: conversations.get(key), created: false };
    },
    async insertMessage({ conversationId, direction, body }) {
      const message = { id: stored.length + 1, conversation_id: conversationId, direction, body };
      stored.push(message);
      return { message };
    },
    async getLatestMessageByConversation(conversationId) {
      return stored.filter((m) => m.conversation_id === conversationId).slice(-1)[0] || null;
    },
    async createEscalation({ conversationId, supportMessageId }) {
      const row = { id: escalations.length + 1, conversation_id: conversationId, support_message_id: supportMessageId };
      escalations.push(row);
      return { escalation: row };
    },
    async getConversationByChatId(chatId) {
      return conversations.get(String(chatId)) || null;
    },
    async probeColumns() { return { ok: true }; }
  };

  const transport = {
    async sendMessage(chatId, text) {
      const message_id = sent.length + 1;
      sent.push({ chatId: String(chatId), text, message_id });
      return { message_id };
    },
    getLastCall() { return null; }
  };

  const bot = createTelegramSupportBot({
    config: {
      token: '123456:TEST-TOKEN',
      webhookSecret: WEBHOOK_SECRET,
      baseUrl: 'https://arbitrix.pro',
      supportChatId,
      adminIds: [ADMIN_ID],
      // Legacy target: this suite pins AI behaviour alongside group forwarding.
      notifyTarget: 'group'
    },
    store,
    transport,
    logger: silentLogger,
    supportAI
  });

  return { bot, sent, stored, escalations, conversations };
}

let updateCounter = 5000;
const nextUpdateId = () => (updateCounter += 1);

function customerUpdate({ text, chatId = CUSTOMER_CHAT_ID, fromId = CUSTOMER_CHAT_ID, updateId = nextUpdateId() }) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      text,
      chat: { id: Number(chatId), type: 'private' },
      from: { id: Number(fromId), first_name: 'New', last_name: 'Customer', username: 'newbie' }
    }
  };
}

const repliesToCustomer = (h) => h.sent.filter((m) => m.chatId === CUSTOMER_CHAT_ID).map((m) => m.text);
const forwarded = (h) => h.sent.filter((m) => m.chatId === SUPPORT_CHAT_ID).map((m) => m.text);

function enabledAIService(over) {
  return createSupportAIService({
    config: Object.assign({
      enabled: true, provider: 'knowledge', model: null, apiKey: null,
      timeoutMs: 8000, maxAnswerChars: 1200, minScore: 2
    }, over || {}),
    knowledge: KB
  });
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

const webhookReq = (body, { secret = WEBHOOK_SECRET, includeSecret = true } = {}) => ({
  headers: includeSecret ? { 'x-telegram-bot-api-secret-token': secret } : {},
  get(name) { return this.headers[String(name).toLowerCase()]; },
  body
});

// ------------------------------------------------------- flag / default -----

test('AI answering is OFF by default and never constructed unless enabled', () => {
  assert.strictEqual(resolveSupportAIConfig({}).enabled, false);
  assert.strictEqual(resolveSupportAIConfig({ AI_SUPPORT_ENABLED: '' }).enabled, false);
  assert.strictEqual(resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'false' }).enabled, false);
  assert.strictEqual(resolveSupportAIConfig({ AI_SUPPORT_ENABLED: '1' }).enabled, false);

  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /resolveSupportAIConfig\(process\.env\)/, 'server must read the existing flag');
  assert.match(server, /if \(!supportAIConfig\.enabled\) return null;/, 'server must skip construction when disabled');
  assert.match(server, /supportAI: createSupportAIServiceSafely\(\)/, 'the bot must receive the AI service');
  assert.match(server, /catch \(error\)[\s\S]{0,200}return null;/, 'AI init failure must degrade to the human flow');

  assert.match(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'), /^AI_SUPPORT_ENABLED=false$/m);
});

// --------------------------------------------------- AI disabled: unchanged --

test('AI disabled: ordinary messages keep the exact previous behaviour', async () => {
  const h = createHarness({ supportAI: null });
  const question = 'How does Arbitrix work?';
  const result = await h.bot.handleUpdate(customerUpdate({ text: question }));

  assert.strictEqual(result.action, 'forwarded');
  assert.deepStrictEqual(repliesToCustomer(h), [CUSTOMER_GUIDE_TEXT]);
  assert.ok(h.stored.some((m) => m.direction === DIRECTION_CUSTOMER && m.body === question));
  assert.ok(h.stored.some((m) => m.direction === DIRECTION_BOT && m.body === CUSTOMER_GUIDE_TEXT));
  assert.strictEqual(forwarded(h).length, 1);
  assert.match(forwarded(h)[0], /How does Arbitrix work\?/);
  assert.strictEqual(h.bot.status().supportAIEnabled, false);
});

test('AI disabled: an injected but DISABLED service changes nothing', async () => {
  const disabled = createSupportAIService({
    config: resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'false' }),
    knowledge: KB
  });
  const h = createHarness({ supportAI: disabled });
  await h.bot.handleUpdate(customerUpdate({ text: 'How does Arbitrix work?' }));
  assert.deepStrictEqual(repliesToCustomer(h), [CUSTOMER_GUIDE_TEXT]);
});

// ------------------------------------------------------- AI enabled: known --

test('AI enabled: a known beginner question is answered from approved knowledge', async () => {
  const h = createHarness({ supportAI: enabledAIService() });
  const question = 'What is the minimum deposit?';
  await h.bot.handleUpdate(customerUpdate({ text: question }));

  const replies = repliesToCustomer(h);
  assert.strictEqual(replies.length, 1);
  assert.notStrictEqual(replies[0], CUSTOMER_GUIDE_TEXT);
  assert.match(replies[0], /\$100/);

  // persistence and forwarding are unchanged
  assert.ok(h.stored.some((m) => m.direction === DIRECTION_CUSTOMER && m.body === question));
  assert.ok(h.stored.some((m) => m.direction === DIRECTION_BOT && m.body === replies[0]));
  assert.strictEqual(forwarded(h).length, 1);
  assert.match(forwarded(h)[0], /What is the minimum deposit\?/);

  const stats = h.bot.getStats();
  assert.strictEqual(stats.aiEnabled, true);
  assert.strictEqual(stats.aiReplies, 1);
  assert.strictEqual(h.bot.status().aiProvider, 'knowledge');
});

test('AI enabled: the customer keeps getting a reply when the conversation already exists', async () => {
  const h = createHarness({ supportAI: enabledAIService() });
  await h.bot.handleUpdate(customerUpdate({ text: '/chatid' }));
  await h.bot.handleUpdate(customerUpdate({ text: 'What is the minimum deposit?' }));
  const replies = repliesToCustomer(h);
  assert.strictEqual(replies.length, 2);
  assert.match(replies[1], /\$100/);
});

// ----------------------------------------------------- AI enabled: hand-off --

test('AI enabled: an unknown question hands off to a human instead of guessing', async () => {
  const h = createHarness({ supportAI: enabledAIService() });
  await h.bot.handleUpdate(customerUpdate({ text: 'what is the weather in paris tomorrow' }));

  const reply = repliesToCustomer(h)[0];
  assert.match(reply, /do not have an approved answer|support/i);
  assert.ok(!/\$|\d/.test(reply), 'an unknown answer must not invent figures: ' + reply);
  assert.strictEqual(forwarded(h).length, 1, 'the human team must still receive the message');
  assert.strictEqual(h.bot.getStats().aiHandoffs, 1);
});

test('AI enabled: the unresolved 14-day free period still hands off to a human', async () => {
  const h = createHarness({ supportAI: enabledAIService() });
  await h.bot.handleUpdate(customerUpdate({ text: 'Do I get 14 days free?' }));

  const reply = repliesToCustomer(h)[0];
  assert.match(reply, /contact support/i);
  assert.ok(!/14[- ]day|free trial/i.test(reply), 'must not claim a free period: ' + reply);
  assert.strictEqual(forwarded(h).length, 1);
  assert.match(forwarded(h)[0], /14 days free/);
});

test('withdrawal-time follows the knowledge conflict register (no guessing either way)', async () => {
  const conflict = KB.conflicts.find((c) => c.id === 'withdrawal_processing_time') || {};
  const status = String(conflict.status || '');

  const h = createHarness({ supportAI: enabledAIService() });
  await h.bot.handleUpdate(customerUpdate({ text: 'How long does withdrawal take?' }));
  const reply = repliesToCustomer(h)[0];

  if (status.startsWith('UNRESOLVED')) {
    // Unresolved => the AI must not guess a time; it hands off to a human.
    assert.match(reply, /contact support/i);
    assert.ok(!/15-30|minutes/i.test(reply), 'must not state a processing time while unresolved');
  } else {
    // Management RESOLVED this conflict (15-30 minutes), so the approved
    // knowledge answers it. (The Stage 2 brief listed this topic as unresolved;
    // the register is the source of truth and this test follows it.)
    assert.match(status, /RESOLVED BY MANAGEMENT/);
    assert.match(reply, /15-30 minutes/i);
  }
  assert.strictEqual(forwarded(h).length, 1, 'a human must still see the message');
});

// --------------------------------------------------------- commands intact --

test('/escalate still works exactly as before and never consults the AI', async () => {
  let asked = 0;
  const spyAI = { isEnabled: () => true, providerName: () => 'spy', async ask() { asked += 1; return { answer: 'AI ANSWER' }; } };
  const h = createHarness({ supportAI: spyAI });

  const result = await h.bot.handleUpdate(customerUpdate({ text: '/escalate My deposit has not arrived' }));

  assert.strictEqual(result.action, 'escalate');
  assert.deepStrictEqual(repliesToCustomer(h), [ESCALATION_ACK]);
  assert.strictEqual(h.escalations.length, 1, 'the escalation record must still be created');
  assert.ok(h.stored.some((m) => m.direction === DIRECTION_CUSTOMER && /My deposit has not arrived/.test(m.body)),
    'the escalated customer message must be persisted');
  assert.ok(forwarded(h).some((t) => /Escalation requested/i.test(t)), 'the support group must be notified');
  assert.strictEqual(asked, 0, 'commands must not be handed to the AI');
});

test('/start and /help still work with the AI enabled', async () => {
  const h = createHarness({ supportAI: enabledAIService() });
  const started = await h.bot.handleUpdate(customerUpdate({ text: '/start' }));
  assert.strictEqual(started.action, 'help');
  assert.deepStrictEqual(repliesToCustomer(h), [USER_HELP_TEXT]);
  await h.bot.handleUpdate(customerUpdate({ text: '/help' }));
  assert.deepStrictEqual(repliesToCustomer(h), [USER_HELP_TEXT, USER_HELP_TEXT]);
});

// ------------------------------------------------ failure => human fallback --

test('AI/provider failure falls back to the standard human-support flow', async () => {
  const broken = { isEnabled: () => true, async ask() { throw new Error('provider exploded'); } };
  const h = createHarness({ supportAI: broken });
  const text = 'How does Arbitrix work?';
  await h.bot.handleUpdate(customerUpdate({ text }));

  assert.deepStrictEqual(repliesToCustomer(h), [CUSTOMER_GUIDE_TEXT]);
  assert.ok(h.stored.some((m) => m.direction === DIRECTION_CUSTOMER && m.body === text));
  assert.strictEqual(forwarded(h).length, 1);
  assert.strictEqual(h.bot.getStats().aiFailures, 1);
});

test('an empty AI answer also falls back instead of sending nothing', async () => {
  const empty = { isEnabled: () => true, async ask() { return { answer: '   ' }; } };
  const h = createHarness({ supportAI: empty });
  await h.bot.handleUpdate(customerUpdate({ text: 'How does Arbitrix work?' }));
  assert.deepStrictEqual(repliesToCustomer(h), [CUSTOMER_GUIDE_TEXT]);
  assert.strictEqual(forwarded(h).length, 1);
});

// ------------------------------------------------- reminders: safety -------

test('the AI receives only the message text - no ids, tokens or account data', async () => {
  const received = [];
  const spyAI = {
    isEnabled: () => true,
    providerName: () => 'spy',
    async ask(arg) { received.push(arg); return { answer: 'Hello, happy to help.' }; }
  };
  const h = createHarness({ supportAI: spyAI });
  const text = 'How does Arbitrix work?';
  await h.bot.handleUpdate(customerUpdate({ text }));

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0], text);
  assert.ok(!received[0].includes(CUSTOMER_CHAT_ID));
  assert.ok(!received[0].includes(SUPPORT_CHAT_ID));
  assert.strictEqual(repliesToCustomer(h)[0], 'Hello, happy to help.');
});

test('a message that looks like a secret is never sent to the model and is never echoed', async () => {
  let generateCalls = 0;
  const spyProvider = {
    name: 'spy-llm', kind: 'http', requiresApiKey: true, available: true,
    async generate() { generateCalls += 1; return { text: 'SHOULD NOT BE USED' }; }
  };
  const service = createSupportAIService({
    config: { enabled: true, provider: 'knowledge', model: null, apiKey: null, timeoutMs: 8000, maxAnswerChars: 1200, minScore: 2 },
    knowledge: KB,
    provider: spyProvider
  });
  const h = createHarness({ supportAI: service });
  const secret = 'deadbeef'.repeat(8);
  await h.bot.handleUpdate(customerUpdate({ text: 'my private key is ' + secret }));

  const reply = repliesToCustomer(h)[0];
  assert.strictEqual(generateCalls, 0, 'a secret-containing message must never reach the model');
  assert.ok(!reply.includes(secret), 'the reply must not echo the secret');
  assert.match(reply, /do not share/i);
});

test('the AI API key never appears in anything sent to the customer or the group', async () => {
  const KEY = 'sk-TEST-DO-NOT-LEAK-1234567890';
  const h = createHarness({ supportAI: enabledAIService({ apiKey: KEY }) });
  await h.bot.handleUpdate(customerUpdate({ text: 'What is the minimum deposit?' }));

  repliesToCustomer(h).forEach((t) => assert.ok(!t.includes(KEY)));
  forwarded(h).forEach((t) => assert.ok(!t.includes(KEY)));
  assert.ok(!JSON.stringify(h.bot.status()).includes(KEY));
});

test('the AI cannot claim guaranteed profit or guaranteed income', async () => {
  const h = createHarness({ supportAI: enabledAIService() });
  for (const question of ['Will I make a profit?', 'Is the profit guaranteed?', 'Is this risk free?']) {
    const before = repliesToCustomer(h).length;
    await h.bot.handleUpdate(customerUpdate({ text: question }));
    const reply = repliesToCustomer(h)[before];
    assert.deepStrictEqual(G.assertSafeAnswer(reply), [], 'unsafe answer for: ' + question);
    assert.match(reply, /does not guarantee|risk/i);
  }
});

test('sensitive account topics are handed to a human, never answered as fact', async () => {
  const h = createHarness({ supportAI: enabledAIService() });
  const before = repliesToCustomer(h).length;
  await h.bot.handleUpdate(customerUpdate({ text: 'did my withdrawal go through?' }));
  const reply = repliesToCustomer(h)[before];
  assert.match(reply, /cannot confirm|support team/i);
  assert.ok(h.bot.getStats().aiHandoffs >= 1);
});

// --------------------------------------------------- webhook security ------

test('Telegram webhook authentication is unchanged with the AI enabled', async () => {
  const h = createHarness({ supportAI: enabledAIService() });
  const handler = createTelegramWebhookHandler({ bot: h.bot, logger: silentLogger });

  const missing = makeRes();
  await handler(webhookReq(customerUpdate({ text: 'How does Arbitrix work?' }), { includeSecret: false }), missing);
  assert.strictEqual(missing.statusCode, 401);
  assert.strictEqual(missing.body.error, 'invalid_secret');
  assert.strictEqual(missing.body.secretProvided, false);

  const wrong = makeRes();
  await handler(webhookReq(customerUpdate({ text: 'How does Arbitrix work?' }), { secret: 'nope' }), wrong);
  assert.strictEqual(wrong.statusCode, 401);

  assert.strictEqual(repliesToCustomer(h).length, 0, 'a rejected delivery must not reach the customer');

  const ok = makeRes();
  await handler(webhookReq(customerUpdate({ text: 'What is the minimum deposit?' })), ok);
  assert.strictEqual(ok.statusCode, 200);
  assert.match(repliesToCustomer(h)[0], /\$100/);
});

// ------------------------------------------------- architecture guarantee --

test('the AI layer has no database, trading, withdrawal or account access', () => {
  const files = [
    'SupportAIService.js', 'SupportKnowledge.js', 'SupportGuidelines.js',
    'providers/index.js', 'providers/KnowledgeProvider.js', 'providers/HttpLLMProvider.js'
  ];
  const forbidden = [/supabase/i, /record_trade_safe/i, /charge_subscription_safe/i, /sandbox_/i, /insertMessage/i, /createEscalation/i];
  files.forEach((file) => {
    const source = fs.readFileSync(path.join(ROOT, 'services', 'support', file), 'utf8');
    forbidden.forEach((re) => {
      assert.ok(!re.test(source), file + ' must not reference ' + re);
    });
  });

  // The bot hands the AI a string (plus the selected conversation language) and
  // receives text back - nothing else. Only ask/isEnabled/providerName are ever
  // called on it.
  const telegram = fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportService.js'), 'utf8');
  assert.match(telegram, /const result = await ai\.ask\(question, \{ language: DEFAULT_LANGUAGE \}\);/);
  const allowed = new Set(['ai.ask(', 'ai.isEnabled(', 'ai.providerName(']);
  const aiCalls = telegram.match(/\bai\.[a-zA-Z]+\(/g) || [];
  assert.ok(aiCalls.length >= 2, 'expected the AI to be consulted from the reply path');
  aiCalls.forEach((call) => assert.ok(allowed.has(call), 'the bot must not call ' + call + ' on the AI service'));
});
