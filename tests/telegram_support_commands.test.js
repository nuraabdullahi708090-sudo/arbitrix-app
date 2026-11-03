'use strict';
/**
 * Customer commands that are answered from the STORED conversation state:
 * `/tutorial`, `/progress` and `/next`.
 *
 * They exist because the conversational bot is only useful if a customer can ask
 * "where was I?" mid-conversation. The tests drive the REAL bot (routing, state
 * persistence, dictionary, transport) - only the store is an in-memory fake.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createTelegramSupportBot } = require('../services/TelegramSupportService');
const i18n = require('../services/telegram-i18n');

const silent = { log() {}, warn() {}, error() {}, info() {} };
const CUSTOMER = '6201';
const OPERATOR = '9201';
const TUTORIAL_URLS = [
  'https://t.me/ArbitrixAnnouncements/17',
  'https://t.me/ArbitrixAnnouncements/16',
  'https://t.me/ArbitrixAnnouncements/18',
  'https://t.me/ArbitrixAnnouncements/19'
];

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function createWorld() {
  const conversations = new Map();
  const messages = [];
  const sent = [];
  let nextConversationId = 1;

  const world = {
    conversations,
    sent,
    row() {
      return conversations.get(CUSTOMER) || null;
    },
    customerReplies() {
      return sent.filter((m) => m.chatId === CUSTOMER).map((m) => m.text);
    },
    lastReply() {
      return this.customerReplies().slice(-1)[0] || '';
    },
    bot({ language = 'en' } = {}) {
      const store = {
        async upsertConversation({ chatId, telegramUserId }) {
          const key = String(chatId);
          if (!conversations.has(key)) {
            conversations.set(key, {
              id: nextConversationId++,
              telegram_chat_id: Number(chatId),
              telegram_user_id: Number(telegramUserId),
              language,
              context: {},
              created_at: new Date().toISOString()
            });
          }
          return { conversation: clone(conversations.get(key)), created: false };
        },
        async getConversationByChatId(chatId) {
          return clone(conversations.get(String(chatId)) || null);
        },
        async getConversationById(id) {
          return clone([...conversations.values()].find((c) => c.id === id) || null);
        },
        async insertMessage({ conversationId, direction, body }) {
          const message = {
            id: messages.length + 1,
            conversation_id: conversationId,
            direction,
            body,
            created_at: new Date().toISOString()
          };
          messages.push(message);
          return { message: clone(message) };
        },
        async getLatestMessageByConversation(arg) {
          const conversationId = arg && typeof arg === 'object' ? arg.conversationId : arg;
          return clone(messages.filter((m) => m.conversation_id === conversationId).slice(-1)[0] || null);
        },
        async createEscalation() {
          return { escalation: {} };
        },
        async setConversationContext({ conversationId, context }) {
          const found = [...conversations.values()].find((c) => c.id === conversationId);
          if (found) found.context = clone(context);
          return { id: conversationId, context: context };
        },
        async setConversationLanguage({ conversationId, language: lang }) {
          const found = [...conversations.values()].find((c) => c.id === conversationId);
          if (found) found.language = lang;
          return { conversation: clone(found) };
        },
        async probeColumns() {
          return { ok: true };
        }
      };
      const transport = {
        async sendMessage(chatId, text) {
          sent.push({ chatId: String(chatId), text });
          return { message_id: sent.length };
        },
        async sendVideo() {
          return { message_id: 1 };
        },
        getLastCall() {
          return null;
        }
      };
      return createTelegramSupportBot({
        config: {
          token: '1:x',
          webhookSecret: 's',
          baseUrl: 'https://x',
          supportChatId: null,
          adminIds: [OPERATOR],
          notifyTarget: 'admins'
        },
        store,
        transport,
        logger: silent
      });
    }
  };
  return world;
}

let seq = 4000;
const update = (chatId, text) => {
  seq += 1;
  return {
    update_id: seq,
    message: {
      message_id: seq,
      date: 0,
      text,
      chat: { id: Number(chatId), type: 'private' },
      from: { id: Number(chatId), first_name: 'Customer' }
    }
  };
};

// ===========================================================================
// /tutorial
// ===========================================================================

test('/tutorial lists the four approved tutorials exactly once each', async () => {
  const world = createWorld();
  const bot = world.bot();
  await bot.handleUpdate(update(CUSTOMER, '/tutorial'));

  const reply = world.lastReply();
  for (const url of TUTORIAL_URLS) {
    assert.strictEqual(reply.split(url).length - 1, 1, url + ' appears exactly once');
  }
  assert.match(reply, /approved tutorials/i, 'intro line is present');
  assert.ok(bot.getStats().tutorialLinksSent >= 1, 'the tutorial counter is updated');
});

test('/tutorial is localized for Portuguese and Arabic', async () => {
  for (const language of ['pt', 'ar']) {
    const world = createWorld();
    const bot = world.bot({ language });
    await bot.handleUpdate(update(CUSTOMER, '/tutorial'));
    const reply = world.lastReply();
    assert.ok(reply.includes(i18n.CUSTOMER_STRINGS[language].tutorialMenu),
      language + ': localized intro is used');
    assert.ok(!reply.includes(i18n.CUSTOMER_STRINGS.en.tutorialMenu),
      language + ': no English intro leaks');
    for (const url of TUTORIAL_URLS) assert.ok(reply.includes(url), language + ': ' + url);
  }
});

test('/tutorial does not disturb an in-flight flow', async () => {
  const world = createWorld();
  const bot = world.bot();
  await bot.handleUpdate(update(CUSTOMER, 'I want to deposit'));
  const pendingBefore = world.row().context.pending;
  assert.strictEqual(pendingBefore, 'deposit.has_crypto');

  await bot.handleUpdate(update(CUSTOMER, '/tutorial'));
  assert.strictEqual(world.row().context.pending, pendingBefore, 'the pending question survives');

  await bot.handleUpdate(update(CUSTOMER, 'No'));
  assert.match(world.lastReply(), /buy USDT|third-party|tutorial/i,
    'the next short reply is still interpreted against the pending question');
});

// ===========================================================================
// /progress
// ===========================================================================

test('/progress on a fresh conversation explains there is nothing in progress', async () => {
  const world = createWorld();
  const bot = world.bot();
  await bot.handleUpdate(update(CUSTOMER, '/progress'));
  assert.strictEqual(world.lastReply(), i18n.CUSTOMER_STRINGS.en.progressEmpty);
});

test('/progress mid-flow reports the method and the question the bot is waiting on', async () => {
  const world = createWorld();
  const bot = world.bot();
  await bot.handleUpdate(update(CUSTOMER, 'I want to deposit'));
  await bot.handleUpdate(update(CUSTOMER, 'Paybis'));

  await bot.handleUpdate(update(CUSTOMER, '/progress'));
  const reply = world.lastReply();
  assert.ok(reply.includes(i18n.CUSTOMER_STRINGS.en.progressTitle), 'title');
  assert.ok(reply.includes('Paybis'), 'the chosen method is shown');
  assert.ok(reply.includes(i18n.CUSTOMER_STRINGS.en.progressWaiting), 'waiting label');
  // The question itself is the localized prompt for the pending step.
  assert.ok(reply.includes(i18n.CUSTOMER_STRINGS.en.depositAfterAck), 'the pending question is shown');
});

test('/progress is localized', async () => {
  const world = createWorld();
  const bot = world.bot({ language: 'ar' });
  await bot.handleUpdate(update(CUSTOMER, 'I want to deposit'));
  await bot.handleUpdate(update(CUSTOMER, '/progress'));
  const reply = world.lastReply();
  assert.ok(reply.includes(i18n.CUSTOMER_STRINGS.ar.progressTitle), 'Arabic title');
  assert.ok(!reply.includes(i18n.CUSTOMER_STRINGS.en.progressTitle), 'no English title');
});

// ===========================================================================
// /next
// ===========================================================================

test('/next restates the pending question instead of guessing', async () => {
  const world = createWorld();
  const bot = world.bot();
  await bot.handleUpdate(update(CUSTOMER, 'I want to deposit'));
  await bot.handleUpdate(update(CUSTOMER, '/next'));

  const reply = world.lastReply();
  assert.ok(reply.includes(i18n.CUSTOMER_STRINGS.en.nextStepTitle), 'next-step title');
  assert.ok(reply.includes(i18n.CUSTOMER_STRINGS.en.depositIntro), 'the pending question is repeated');
  assert.strictEqual(world.row().context.pending, 'deposit.has_crypto', 'state unchanged');
});

test('/next with nothing pending offers the main topics', async () => {
  const world = createWorld();
  const bot = world.bot();
  await bot.handleUpdate(update(CUSTOMER, '/next'));
  assert.strictEqual(world.lastReply(), i18n.CUSTOMER_STRINGS.en.nextTopics);
});

// ===========================================================================
// Human handoff interaction
// ===========================================================================

test('commands stay silent while a human is handling the conversation', async () => {
  const world = createWorld();
  const bot = world.bot();
  await bot.handleUpdate(update(CUSTOMER, 'I need a human'));
  await bot.handleUpdate(update(OPERATOR, '/reply 1 I am on it'));

  const before = world.customerReplies().length;
  await bot.handleUpdate(update(CUSTOMER, '/tutorial'));
  await bot.handleUpdate(update(CUSTOMER, '/progress'));
  await bot.handleUpdate(update(CUSTOMER, '/next'));
  assert.strictEqual(world.customerReplies().length, before,
    'no automated reply may interrupt the human');
});

test('commands work again once the handoff is closed', async () => {
  const world = createWorld();
  const bot = world.bot();
  await bot.handleUpdate(update(CUSTOMER, 'I need a human'));
  await bot.handleUpdate(update(OPERATOR, '/reply 1 I am on it'));
  await bot.handleUpdate(update(OPERATOR, '/close 1'));

  const before = world.customerReplies().length;
  await bot.handleUpdate(update(CUSTOMER, '/tutorial'));
  assert.ok(world.customerReplies().length > before, 'automation resumed');
  for (const url of TUTORIAL_URLS) assert.ok(world.lastReply().includes(url));
});

// ===========================================================================
// Discoverability and safety
// ===========================================================================

test('/help advertises the three commands in every supported language', async () => {
  for (const language of ['en', 'pt', 'ar']) {
    const help = i18n.CUSTOMER_STRINGS[language].help;
    for (const cmd of ['/tutorial', '/progress', '/next']) {
      assert.ok(help.includes(cmd), language + ' help mentions ' + cmd);
    }
  }
});

test('the commands persist conversation state (turns advance)', async () => {
  const world = createWorld();
  const bot = world.bot();
  await bot.handleUpdate(update(CUSTOMER, 'I want to deposit'));
  const turnsBefore = world.row().context.turns;
  await bot.handleUpdate(update(CUSTOMER, '/next'));
  assert.ok(world.row().context.turns > turnsBefore, 'the state is saved after a command');
  assert.ok(world.row().context.updatedAt, 'updatedAt is refreshed');
});

test('an unknown command is not swallowed by the new handler', async () => {
  const world = createWorld();
  const bot = world.bot();
  await bot.handleUpdate(update(CUSTOMER, '/definitelynotacommand'));
  assert.ok(world.customerReplies().length >= 1, 'the customer still receives a reply');
});

test('no command touches financial paths or sends operator notifications', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'support', 'ConversationEngine.js'), 'utf8');
  const commandBlock = engineSrc.slice(engineSrc.indexOf('function planCommand'), engineSrc.indexOf('module.exports'));
  for (const banned of ['supabase', 'rpc(', 'wallet', 'balance', 'fetch(', 'record_trade', 'credit_']) {
    assert.ok(!commandBlock.includes(banned), 'planCommand must not reference ' + banned);
  }
  const world = createWorld();
  const bot = world.bot();
  const before = world.sent.filter((m) => m.chatId === OPERATOR).length;
  await bot.handleUpdate(update(CUSTOMER, '/tutorial'));
  assert.strictEqual(world.sent.filter((m) => m.chatId === OPERATOR).length, before,
    'a self-service command does not page the operator');
});

// ===========================================================================
// Human takeover (regression: suppression used to last one message only)
// ===========================================================================

test('a human takeover keeps the bot silent for every customer message until closed', async () => {
  const world = createWorld();
  const bot = world.bot();
  await bot.handleUpdate(update(CUSTOMER, 'I need a human'));
  await bot.handleUpdate(update(OPERATOR, '/reply 1 I am on it here'));

  const afterHumanReply = world.customerReplies().length;
  for (const text of ['hello?', 'are you there', 'I still have a problem', 'please help']) {
    await bot.handleUpdate(update(CUSTOMER, text));
  }
  assert.strictEqual(world.customerReplies().length, afterHumanReply,
    'the bot must not answer any message while the human owns the conversation');
});

test('/close resumes automation for the next customer message', async () => {
  const world = createWorld();
  const bot = world.bot();
  await bot.handleUpdate(update(CUSTOMER, 'I need a human'));
  await bot.handleUpdate(update(OPERATOR, '/reply 1 I am on it here'));
  await bot.handleUpdate(update(CUSTOMER, 'still waiting'));
  await bot.handleUpdate(update(OPERATOR, '/close 1'));

  const before = world.customerReplies().length;
  await bot.handleUpdate(update(CUSTOMER, 'thanks, how do I deposit?'));
  assert.ok(world.customerReplies().length > before, 'automation resumed after the close');
});

test('a new human reply after a close re-suppresses the bot', async () => {
  const world = createWorld();
  const bot = world.bot();
  await bot.handleUpdate(update(CUSTOMER, 'I need a human'));
  await bot.handleUpdate(update(OPERATOR, '/reply 1 first reply'));
  await bot.handleUpdate(update(OPERATOR, '/close 1'));
  await bot.handleUpdate(update(CUSTOMER, 'ok how do I deposit'));
  const resumed = world.customerReplies().length;

  await bot.handleUpdate(update(OPERATOR, '/reply 1 taking over again'));
  // the operator's own reply lands in the chat, so the baseline is taken after it
  const takeover = world.customerReplies().length;
  await bot.handleUpdate(update(CUSTOMER, 'hello?'));
  await bot.handleUpdate(update(CUSTOMER, 'anyone?'));
  assert.strictEqual(world.customerReplies().length, takeover,
    'the second takeover suppresses the bot again');
});

test('the takeover flag is part of the durable conversation state', async () => {
  const world = createWorld();
  const bot = world.bot();
  await bot.handleUpdate(update(CUSTOMER, 'I need a human'));
  await bot.handleUpdate(update(OPERATOR, '/reply 1 I am on it'));
  assert.ok(world.row().context.humanActiveAt, 'the takeover timestamp is persisted');

  await bot.handleUpdate(update(OPERATOR, '/close 1'));
  assert.strictEqual(world.row().context.humanActiveAt, null, 'the close clears it');
  assert.ok(world.row().context.handoffResolvedAt, 'and records the resolution');
});
