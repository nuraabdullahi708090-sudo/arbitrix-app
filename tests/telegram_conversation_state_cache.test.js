'use strict';
/**
 * Regression tests for the two state findings of the final branch review:
 *
 *   M1 - the in-process conversation cache used to be authoritative forever, so a
 *        second process (a rolling deploy, a second replica) never saw a human
 *        handoff resolved by the first one and kept the customer silent.
 *
 *   L1 - two updates for the same conversation can be handled concurrently, and a
 *        slower EARLIER update finishing last could overwrite the newer state
 *        (losing the chosen deposit method and rewinding `lastUpdateId`).
 *
 * The harness models a SHARED database with two independent bot instances: each
 * instance has its own store object and its own cache, exactly like two processes.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createTelegramSupportBot } = require('../services/TelegramSupportService');
const i18n = require('../services/telegram-i18n');

const silent = { log() {}, warn() {}, error() {}, info() {} };
const CUSTOMER = '7701';
const OPERATOR = '9101';

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * One "database" plus a factory for independent instances over it.
 *
 * `stateCacheTtlMs` is per instance, so a test can make one instance trust its
 * cache and another re-read the row.
 */
function createWorld() {
  const conversations = new Map();
  const messages = [];
  const sent = [];
  let nextConversationId = 1;

  const world = {
    conversations,
    messages,
    sent,
    calls: { conversationReads: 0 },
    failConversationRead: false,
    contextColumnExists: true,
    // Per-save delay, so a test can decide which concurrent save finishes last.
    saveDelayFor: () => 0,
    // Per-message delay, so a test can decide which concurrent update reaches its
    // save first (the delay holds that request BEFORE it plans or saves).
    insertDelayFor: () => 0,
    rowFor(chatId) {
      return conversations.get(String(chatId)) || null;
    },
    /** Overwrite the stored state directly (another process writing the row). */
    setStoredContext(chatId, context) {
      const row = conversations.get(String(chatId));
      if (row) row.context = clone(context);
    },
    /** Append an agent (human) message, as if an operator had replied. */
    addAgentMessage(conversationId, body) {
      const message = {
        id: messages.length + 1,
        conversation_id: conversationId,
        direction: 'agent',
        body,
        created_at: new Date().toISOString()
      };
      messages.push(message);
      return message;
    },
    customerReplies() {
      return sent.filter((m) => m.chatId === CUSTOMER).map((m) => m.text);
    },
    operatorNotices() {
      return sent.filter((m) => m.chatId === OPERATOR).map((m) => m.text);
    },
    botOn({ stateCacheTtlMs } = {}) {
      const store = {
        async upsertConversation({ chatId, telegramUserId }) {
          const key = String(chatId);
          if (!conversations.has(key)) {
            conversations.set(key, {
              id: nextConversationId++,
              telegram_chat_id: Number(chatId),
              telegram_user_id: Number(telegramUserId),
              language: 'en',
              context: world.contextColumnExists ? {} : undefined,
              created_at: new Date().toISOString()
            });
          }
          return { conversation: clone(conversations.get(key)), created: false };
        },
        async getConversationByChatId(chatId) {
          world.calls.conversationReads += 1;
          if (world.failConversationRead) throw new Error('supabase read timeout');
          return clone(world.rowFor(chatId));
        },
        async getConversationById(id) {
          return clone([...conversations.values()].find((c) => c.id === id) || null);
        },
        async insertMessage({ conversationId, direction, body }) {
          const delay = world.insertDelayFor(body, direction);
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
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
          const delay = world.saveDelayFor(context);
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          if (!world.contextColumnExists) {
            throw new Error('column "context" does not exist');
          }
          const row = [...conversations.values()].find((c) => c.id === conversationId);
          if (!row) throw new Error('no conversation row');
          row.context = clone(context);
          return { id: row.id, context: row.context };
        },
        async setConversationLanguage() {
          return { conversation: null };
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
        logger: silent,
        stateCacheTtlMs
      });
    }
  };

  return world;
}

let updateSequence = 3000;

function updateFor(chatId, text, updateId) {
  updateSequence += 1;
  const id = updateId === undefined ? updateSequence : updateId;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      text,
      chat: { id: Number(chatId), type: 'private' },
      from: { id: Number(chatId), first_name: 'Customer' }
    }
  };
}

const sayAs = (bot, chatId, text, updateId) => bot.handleUpdate(updateFor(chatId, text, updateId));

/** Run a body against a controllable clock, so TTL expiry is deterministic. */
async function withClock(startAt, body) {
  const realNow = Date.now;
  let now = startAt;
  Date.now = () => now;
  try {
    return await body({ advance: (ms) => { now += ms; } });
  } finally {
    Date.now = realNow;
  }
}

/** A handoff that a human has replied to and then closed on instance A. */
async function handoffThenClose(world, botA) {
  await sayAs(botA, CUSTOMER, 'hello');
  await sayAs(botA, CUSTOMER, 'I need a human');
  await sayAs(botA, OPERATOR, '/reply 1 I am looking into it');
  await sayAs(botA, OPERATOR, '/close 1');
}

// ===========================================================================
// M1 - state cache TTL
// ===========================================================================

test('M1: a fresh cache entry is used without re-reading the conversation row', async () => {
  await withClock(1_000_000, async () => {
    const world = createWorld();
    const bot = world.botOn(); // default TTL (45s)

    await sayAs(bot, CUSTOMER, 'hello');
    const readsAfterFirst = world.calls.conversationReads;
    assert.ok(readsAfterFirst >= 1, 'the first message reads the durable row');

    await sayAs(bot, CUSTOMER, 'I want to deposit');
    await sayAs(bot, CUSTOMER, 'No');
    assert.strictEqual(world.calls.conversationReads, readsAfterFirst,
      'within the TTL the cache serves the state and no extra read happens');

    const replies = world.customerReplies();
    assert.match(replies[replies.length - 1], /managed|tutorial|third-party|buy/i,
      'the cached state still drives the conversation');
  });
});

test('M1: after the TTL the shared row wins over the cached state', async () => {
  await withClock(2_000_000, async ({ advance }) => {
    const world = createWorld();
    const bot = world.botOn({ stateCacheTtlMs: 45000 });

    // This instance is in the middle of the deposit flow (pending: has crypto?).
    await sayAs(bot, CUSTOMER, 'I want to deposit');
    const cached = clone(world.rowFor(CUSTOMER).context);
    assert.strictEqual(cached.pending, 'deposit.has_crypto');

    // Inside the TTL the cache answers: "done" is treated as an acknowledgement of
    // an unknown step, not as the completion of the transfer.
    await sayAs(bot, CUSTOMER, 'done');
    const staleReply = world.customerReplies().slice(-1)[0];
    assert.match(staleReply, /What would you like help with/i, 'the cached state is used within the TTL');

    // ANOTHER process then advances the same conversation and writes the row.
    world.setStoredContext(CUSTOMER, Object.assign({}, cached, {
      stage: 'deposit.tutorial_followup',
      pending: 'deposit.tutorial_followup',
      method: 'paybis'
    }));

    // After the TTL the row is re-read and the conversation continues from it.
    advance(46000);
    await sayAs(bot, CUSTOMER, 'done');
    const freshReply = world.customerReplies().slice(-1)[0];
    assert.match(freshReply, /successfully transferred the funds/i,
      'after the TTL the durable state is used');
    assert.ok(bot.getStats().stateRefreshes >= 1, 'the refresh is counted');
  });
});

test('M1: after the TTL a second instance answers a handoff closed by the first', async () => {
  await withClock(3_000_000, async ({ advance }) => {
    const world = createWorld();
    const botB = world.botOn({ stateCacheTtlMs: 45000 });

    // B builds its own cache, so it will be genuinely stale below.
    await sayAs(botB, CUSTOMER, 'thanks');
    const conversationId = world.rowFor(CUSTOMER).id;

    // A human replies, and instance A closes the handoff in the shared row.
    const agent = world.addAgentMessage(conversationId, 'I am looking into it');
    world.setStoredContext(CUSTOMER, Object.assign({}, world.rowFor(CUSTOMER).context, {
      handoffResolvedAt: new Date().toISOString(),
      handoffResolvedMessageId: agent.id
    }));

    // BEFORE the TTL: B trusts its cache, which knows nothing about the closure.
    const before = world.customerReplies().length;
    await sayAs(botB, CUSTOMER, 'any update before the ttl?');
    assert.strictEqual(world.customerReplies().length, before,
      'a stale instance keeps respecting the handoff it knows about');

    // A human replies again and the operator closes again in the shared row.
    const agent2 = world.addAgentMessage(conversationId, 'update: still working');
    world.setStoredContext(CUSTOMER, Object.assign({}, world.rowFor(CUSTOMER).context, {
      handoffResolvedAt: new Date().toISOString(),
      handoffResolvedMessageId: agent2.id
    }));

    // AFTER the TTL: B re-reads the row and answers again.
    advance(46000);
    const after = world.customerReplies().length;
    await sayAs(botB, CUSTOMER, 'any update after the ttl?');
    assert.ok(world.customerReplies().length > after,
      'after the cache expires the second instance resumes the conversation');
    assert.ok(botB.getStats().stateRefreshes >= 1, 'the refresh is counted');
  });
});

test('M1: a failed durable read keeps the valid cached state', async () => {
  await withClock(4_000_000, async ({ advance }) => {
    const world = createWorld();
    const bot = world.botOn({ stateCacheTtlMs: 45000 });

    await sayAs(bot, CUSTOMER, 'I want to deposit');
    const expected = i18n.t('en', 'depositNeedCrypto');

    advance(46000);                    // cache is now expired
    world.failConversationRead = true; // and the database read fails

    await sayAs(bot, CUSTOMER, 'No');
    const reply = world.customerReplies().slice(-1)[0];
    assert.match(reply, /buy USDT|third-party|tutorial/i,
      'the cached pending question is still answered, not reset to a generic reply');
    assert.notStrictEqual(reply, i18n.t('en', 'clarifyTopic'),
      'a storage blip must not turn a known question into a clarifying question');
    assert.ok(expected.length > 0);
  });
});

test('M1: without the context column (migration 047 absent) the cache still drives the conversation', async () => {
  await withClock(5_000_000, async ({ advance }) => {
    const world = createWorld();
    world.contextColumnExists = false; // the write throws, the row has no context
    const bot = world.botOn({ stateCacheTtlMs: 45000 });

    await sayAs(bot, CUSTOMER, 'I want to deposit');
    advance(46000);
    await sayAs(bot, CUSTOMER, 'No');

    const reply = world.customerReplies().slice(-1)[0];
    assert.match(reply, /buy USDT|third-party|tutorial/i,
      'the conversation continues from the in-process state');
    assert.strictEqual(bot.getStats().conversationStatePersisted, false,
      'the degraded mode is reported');
  });
});

test('M1: a normal short reply still works with the default TTL (no regression)', async () => {
  await withClock(7_000_000, async () => {
    const world = createWorld();
    const bot = world.botOn();

    await sayAs(bot, CUSTOMER, 'I want to deposit');
    await sayAs(bot, CUSTOMER, 'Yes');
    const reply = world.customerReplies().slice(-1)[0];
    assert.match(reply, /Deposit|amount|USDT/i, '"Yes" continues the deposit flow');
    assert.notStrictEqual(reply, i18n.t('en', 'clarifyTopic'));
  });
});

// ===========================================================================
// L1 - monotonic conversation-state saves
// ===========================================================================

test('L1: an older update completing after a newer one is skipped (deterministic)', async () => {
  await withClock(8_000_000, async () => {
    const world = createWorld();
    const bot = world.botOn();

    await sayAs(bot, CUSTOMER, 'I want to deposit', 2001);

    // Hold the EARLIER update ("No", id 2002) before it plans or saves, so the
    // later update (2003) is fully applied first. When 2002 finally saves, it is
    // an older snapshot and must be dropped.
    world.insertDelayFor = (body, direction) => (direction === 'customer' && body === 'No' ? 60 : 0);

    await Promise.all([
      sayAs(bot, CUSTOMER, 'No', 2002),
      sayAs(bot, CUSTOMER, 'Paybis', 2003)
    ]);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const stored = world.rowFor(CUSTOMER).context;
    assert.strictEqual(stored.method, 'paybis', 'the newer state survives');
    assert.strictEqual(stored.lastUpdateId, 2003, 'lastUpdateId does not move backwards');
    assert.notStrictEqual(stored.pending, 'deposit.method', 'the flow is not rewound');
    assert.strictEqual(bot.getStats().staleStateWritesSkipped, 1, 'exactly one stale write was skipped');
  });
});

test('L1: a slow older save cannot land after a newer one (serialized writes)', async () => {
  await withClock(8_500_000, async () => {
    const world = createWorld();
    const bot = world.botOn();

    await sayAs(bot, CUSTOMER, 'I want to deposit', 2051);

    // Both updates plan from the same state; the EARLIER one's database write is
    // much slower. Serialization means it is decided and written in order, so it
    // can never land after the newer snapshot.
    world.saveDelayFor = (context) => (context && context.lastUpdateId === 2052 ? 80 : 5);

    await Promise.all([
      sayAs(bot, CUSTOMER, 'No', 2052),
      sayAs(bot, CUSTOMER, 'Paybis', 2053)
    ]);
    await new Promise((resolve) => setTimeout(resolve, 140));

    const stored = world.rowFor(CUSTOMER).context;
    assert.strictEqual(stored.lastUpdateId, 2053, 'the newest snapshot is the one stored');
    assert.strictEqual(stored.method, 'paybis', 'the newer choice is not lost');
  });
});

test('L1: both concurrent messages are still answered', async () => {
  await withClock(9_000_000, async () => {
    const world = createWorld();
    const bot = world.botOn();

    await sayAs(bot, CUSTOMER, 'I want to deposit', 2101);
    world.saveDelayFor = (context) => (context && context.lastUpdateId === 2102 ? 60 : 5);

    const before = world.customerReplies().length;
    await Promise.all([
      sayAs(bot, CUSTOMER, 'No', 2102),
      sayAs(bot, CUSTOMER, 'Paybis', 2103)
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(world.customerReplies().length - before, 2,
      'each customer message gets exactly one reply');
  });
});

test('L1: equal update ids are still written (the /close idempotent path)', async () => {
  await withClock(10_000_000, async () => {
    const world = createWorld();
    const bot = world.botOn();

    await sayAs(bot, CUSTOMER, 'I need a human', 2201);
    await sayAs(bot, OPERATOR, '/reply 1 on it');
    const idBeforeClose = world.rowFor(CUSTOMER).context.lastUpdateId;

    await sayAs(bot, OPERATOR, '/close 1');
    const stored = world.rowFor(CUSTOMER).context;
    assert.ok(stored.handoffResolvedAt, 'the resolution is persisted even though no new update id exists');
    assert.strictEqual(stored.lastUpdateId, idBeforeClose, 'the update id is unchanged, not rejected');
    assert.strictEqual(bot.getStats().staleStateWritesSkipped || 0, 0, 'an equal id is never treated as stale');
  });
});

test('L1: a message without an update id still advances and persists the state', async () => {
  await withClock(11_000_000, async () => {
    const world = createWorld();
    const bot = world.botOn();

    await sayAs(bot, CUSTOMER, 'I want to deposit', 2301);
    const before = clone(world.rowFor(CUSTOMER).context);

    // No update_id at all (an unusual payload): the state must still be written.
    await bot.handleUpdate({
      message: {
        message_id: 2302,
        date: 0,
        text: 'No',
        chat: { id: Number(CUSTOMER), type: 'private' },
        from: { id: Number(CUSTOMER), first_name: 'Customer' }
      }
    });

    const after = world.rowFor(CUSTOMER).context;
    assert.notStrictEqual(after.pending, before.pending, 'the flow advanced');
    assert.strictEqual(after.lastUpdateId, before.lastUpdateId, 'the previous id is preserved');
    assert.ok(after.turns > before.turns, 'the turn counter advanced');
    assert.strictEqual(bot.getStats().staleStateWritesSkipped || 0, 0, 'nothing was rejected');
  });
});

test('L1: sequential turns still advance normally (no regression)', async () => {
  await withClock(12_000_000, async () => {
    const world = createWorld();
    const bot = world.botOn();

    await sayAs(bot, CUSTOMER, 'I want to deposit');
    await sayAs(bot, CUSTOMER, 'No');
    await sayAs(bot, CUSTOMER, 'Paybis');
    await sayAs(bot, CUSTOMER, 'okay');

    const stored = world.rowFor(CUSTOMER).context;
    assert.strictEqual(stored.method, 'paybis');
    // "okay" after the tutorial follow-up means "understood", so the flow moves
    // to the transfer step - the point is that it advanced, never rewound.
    assert.strictEqual(stored.pending, 'deposit.transfer_done');
    assert.strictEqual(bot.getStats().staleStateWritesSkipped, 0);
    assert.ok(world.customerReplies().length >= 4, 'every message was answered');
  });
});

test('L1: the handoff resume path still works after the guard was added', async () => {
  await withClock(13_000_000, async () => {
    const world = createWorld();
    const bot = world.botOn();

    await sayAs(bot, CUSTOMER, 'I need a human');
    await sayAs(bot, OPERATOR, '/reply 1 on it');
    await sayAs(bot, OPERATOR, '/close 1');

    const before = world.customerReplies().length;
    await sayAs(bot, CUSTOMER, 'how do I withdraw?');
    assert.ok(world.customerReplies().length > before, 'automation resumed after the close');
  });
});
