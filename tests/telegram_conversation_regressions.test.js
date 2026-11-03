'use strict';

/**
 * Regression tests for the issues found in the production-readiness review of
 * the conversational Telegram support assistant (T1) and the deposit tutorial
 * centre (T2).
 *
 * Every test drives the REAL bot (`createTelegramSupportBot`), the REAL dialogue
 * engine and the REAL approved knowledge base. Only the store and the transport
 * are faked, so each case asserts what a customer and an operator actually see.
 *
 *   C1  a provider name inside a problem/withdrawal message must NOT be answered
 *       with a deposit tutorial, and must stay a HUMAN NEEDED escalation
 *   H1  no raw translation key may reach a customer or an operator
 *   H2  /close must not claim that automation resumed unless it really did
 *   M1  a courtesy "thanks" mid-flow must not contradict the pending question
 *   M2  "Really?" must not affirm anything unless the bot made a claim
 *   M3  a deposit is never confirmed as credited on the customer's word alone
 *   M4  the risk answer carries no safety guarantee
 *   M5  hacked accounts / missing funds escalate to a human
 *   L7  a generic network error must not trigger the deposit-asset answer
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  createTelegramSupportBot,
  DIRECTION_AGENT
} = require('../services/TelegramSupportService');
const i18n = require('../services/telegram-i18n');
const engine = require('../services/support/ConversationEngine');
const SupportKnowledge = require('../services/support/SupportKnowledge');

const ROOT = path.join(__dirname, '..');
const CUSTOMER = '8001';
const ADMIN = '8002';
const TOKEN = '123456:REGRESSION-TEST';

const TUTORIAL_URL = {
  paybis: 'https://t.me/ArbitrixAnnouncements/17',
  transak: 'https://t.me/ArbitrixAnnouncements/16',
  trustwallet: 'https://t.me/ArbitrixAnnouncements/18',
  withdrawal: 'https://t.me/ArbitrixAnnouncements/19'
};

const silentLogger = { log() {}, warn() {}, error() {}, info() {} };

let updateCounter = 990000;
const nextUpdateId = () => (updateCounter += 1);

// ------------------------------------------------------------------ harness ---

function createStore() {
  const conversations = new Map();
  const messages = [];
  let nextConversationId = 1;

  return {
    conversations,
    messages,
    store: {
      async upsertConversation({ chatId, telegramUserId, username, displayName }) {
        const key = String(chatId);
        if (!conversations.has(key)) {
          conversations.set(key, {
            id: nextConversationId++,
            telegram_chat_id: Number(chatId),
            telegram_user_id: Number(telegramUserId),
            username: username || null,
            display_name: displayName || null,
            language: 'en',
            context: null,
            created_at: new Date().toISOString()
          });
          return { conversation: conversations.get(key), created: true };
        }
        return { conversation: conversations.get(key), created: false };
      },
      async getConversationByChatId(chatId) {
        return conversations.get(String(chatId)) || null;
      },
      async getConversationById(id) {
        return Array.from(conversations.values()).find((c) => c.id === id) || null;
      },
      async insertMessage({ conversationId, direction, body }) {
        const message = {
          id: messages.length + 1,
          conversation_id: conversationId,
          direction,
          body,
          created_at: new Date(Date.now() - (1000 - messages.length)).toISOString()
        };
        messages.push(message);
        return { message };
      },
      async getLatestMessageByConversation(arg) {
        const conversationId = arg && typeof arg === 'object' ? arg.conversationId : arg;
        return messages.filter((m) => m.conversation_id === conversationId).slice(-1)[0] || null;
      },
      async createEscalation({ conversationId, supportMessageId }) {
        return { escalation: { id: messages.length + 1, conversation_id: conversationId, support_message_id: supportMessageId } };
      },
      async setConversationContext({ conversationId, context }) {
        const row = Array.from(conversations.values()).find((c) => c.id === conversationId);
        if (!row) throw new Error('no such conversation');
        row.context = context;
        return { conversation: row };
      },
      async setConversationLanguage({ conversationId, language }) {
        const row = Array.from(conversations.values()).find((c) => c.id === conversationId);
        if (row) row.language = language;
        return { conversation: row || null };
      },
      async probeColumns() {
        return { ok: true };
      }
    }
  };
}

function createHarness({ language = 'en', failingReads = null } = {}) {
  const state = createStore();
  const sent = [];

  // N1: simulate a transient database read failure (the store throws on every
  // getLatestMessageByConversation call while `failingReads.on` is true).
  if (failingReads) {
    const original = state.store.getLatestMessageByConversation;
    state.store.getLatestMessageByConversation = async function (arg) {
      if (failingReads.on) throw new Error('supabase read timeout');
      return original.call(this, arg);
    };
  }

  state.conversations.set(CUSTOMER, {
    id: 1,
    telegram_chat_id: Number(CUSTOMER),
    telegram_user_id: Number(CUSTOMER),
    username: 'ana',
    display_name: 'Ana',
    language,
    context: null,
    created_at: new Date().toISOString()
  });

  const transport = {
    sent,
    async sendMessage(chatId, text, options) {
      sent.push({ method: 'sendMessage', chatId: String(chatId), text, options, message_id: sent.length + 1 });
      return { message_id: sent.length + 1 };
    },
    async sendVideo(chatId, video, caption) {
      sent.push({ method: 'sendVideo', chatId: String(chatId), video, text: caption });
      return { message_id: sent.length + 1 };
    },
    getLastCall() {
      return null;
    }
  };

  const bot = createTelegramSupportBot({
    config: {
      token: TOKEN,
      webhookSecret: 'regression-secret',
      baseUrl: 'https://arbitrix.pro',
      supportChatId: null,
      adminIds: [ADMIN],
      notifyTarget: 'admins'
    },
    store: state.store,
    transport,
    logger: silentLogger
  });

  async function say(text) {
    const updateId = nextUpdateId();
    return bot.handleUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 0,
        text,
        chat: { id: Number(CUSTOMER), type: 'private' },
        from: { id: Number(CUSTOMER), first_name: 'Ana', username: 'ana' }
      }
    });
  }

  async function adminSay(text) {
    return bot.handleUpdate({
      update_id: nextUpdateId(),
      message: {
        message_id: nextUpdateId(),
        date: 0,
        text,
        chat: { id: Number(ADMIN), type: 'private' },
        from: { id: Number(ADMIN), first_name: 'Ops', username: 'ops' }
      }
    });
  }

  const customerMessages = () => sent.filter((m) => m.chatId === CUSTOMER && m.method === 'sendMessage').map((m) => m.text);
  const adminMessages = () => sent.filter((m) => m.chatId === ADMIN && m.method === 'sendMessage').map((m) => m.text);

  return {
    bot,
    state,
    sent,
    say,
    adminSay,
    conversation: () => state.conversations.get(CUSTOMER),
    toCustomer: customerMessages,
    last: () => customerMessages().slice(-1)[0],
    lastAdmin: () => adminMessages().slice(-1)[0],
    /** Rewrite the newest agent message timestamp, simulating a clock offset. */
    skewLastAgentMessage(ms) {
      const agents = state.messages.filter((m) => m.direction === DIRECTION_AGENT);
      const agent = agents[agents.length - 1];
      assert.ok(agent, 'the test needs a stored agent message');
      agent.created_at = new Date(Date.now() + ms).toISOString();
      return agent;
    }
  };
}

const t = (key, language = 'en') => i18n.t(language, key);

/** Start a handoff and leave a stored agent reply, ready for /close. */
async function handoffWithAgentReply(h) {
  await h.say('I need to speak to a human');
  await h.adminSay('/reply 1 Thanks, I am looking into it');
}

// --------------------------------------------------------- C1: provider mentions ---

test('C1: a provider named inside a missing-deposit complaint escalates, never sends a tutorial', async () => {
  const cases = [
    'I sent 100 USDT from trust wallet and it has not been credited',
    'My deposit from Paybis is missing',
    'I deposited but nothing shows',
    'My Trust Wallet is not working',
    'I paid with transak but the balance is still zero'
  ];

  for (const text of cases) {
    const h = createHarness();
    await h.say(text);

    const reply = h.last();
    assert.strictEqual(reply, t('humanHandoff'), 'expected a human handoff for: ' + text);
    assert.ok(!/t\.me\//.test(reply), 'no tutorial link may be sent for: ' + text);
    assert.match(h.lastAdmin(), /HUMAN NEEDED/, 'the operator must be alerted for: ' + text);
    assert.ok(!/BOT REPLIED/.test(h.lastAdmin()), 'must not be reported as answered for: ' + text);
  }
});

test('C1: a withdrawal that mentions a provider is answered as a withdrawal', async () => {
  for (const text of ['I want to withdraw to my Trust Wallet', 'how do I withdraw to trust wallet']) {
    const h = createHarness();
    await h.say(text);
    const reply = h.last();
    assert.match(reply, /withdraw/i, 'expected the withdrawal flow for: ' + text);
    assert.ok(reply.includes(TUTORIAL_URL.withdrawal), 'the withdrawal tutorial is the right one');
    assert.ok(!reply.includes(TUTORIAL_URL.paybis), 'no deposit tutorial may be attached');
    assert.ok(!reply.includes(TUTORIAL_URL.transak));
    assert.ok(!reply.includes(TUTORIAL_URL.trustwallet));
  }
});

test('C1: a withdrawal cancellation request escalates (the bot cannot cancel it)', async () => {
  const h = createHarness();
  await h.say('Can you cancel my withdrawal?');
  assert.strictEqual(h.last(), t('humanHandoff'));
  assert.match(h.lastAdmin(), /HUMAN NEEDED/);
});

test('C1: a trading question that happens to name a provider keeps its real answer', async () => {
  const h = createHarness();
  await h.say('the bot stopped after paybis deposit');
  const reply = h.last();
  assert.ok(!/t\.me\//.test(reply), 'no tutorial for a bot-behaviour question');
  assert.match(reply, /profit|cap|limit|\$20/i, 'the promo-cap answer is preserved');
});

test('C1: a question about a provider is not a method selection', async () => {
  const h = createHarness();
  await h.say('is paybis safe');
  const reply = h.last();
  assert.ok(!reply.includes(TUTORIAL_URL.paybis), 'a safety question must not open the tutorial');
});

test('C1: genuine method selections still send exactly their own tutorial', async () => {
  const cases = [
    ['paybis', TUTORIAL_URL.paybis],
    ['transak', TUTORIAL_URL.transak],
    ['trust wallet', TUTORIAL_URL.trustwallet],
    ['I want to deposit with paybis', TUTORIAL_URL.paybis]
  ];

  for (const [text, expected] of cases) {
    const h = createHarness();
    await h.say(text);
    const reply = h.last();
    assert.ok(reply.includes(expected), 'expected the matching tutorial for: ' + text);
    const others = Object.values(TUTORIAL_URL).filter((url) => url !== expected);
    others.forEach((url) => assert.ok(!reply.includes(url), 'only one tutorial per message'));
    assert.strictEqual(h.sent.filter((m) => m.method === 'sendVideo').length, 0, 'no video is pushed');
  }
});

test('C1: the Paybis flow is unchanged end to end (tutorial, memory, transfer question)', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('No');
  await h.say('Paybis');
  assert.ok(h.last().includes(TUTORIAL_URL.paybis));

  await h.say('okay');
  assert.match(h.last(), /tell me "done"/);
  assert.strictEqual(h.conversation().context.pending, 'deposit.transfer_done');

  await h.say('I have completed it');
  assert.ok(h.last().includes(t('depositCreditedQuestion')), h.last());
  assert.strictEqual(h.conversation().context.pending, 'deposit.credited');
});

test('C1: isMethodSelection only accepts a real selection', () => {
  const yes = ['paybis', 'transak', 'trust wallet', 'I want to deposit with paybis', 'use transak please'];
  const no = [
    'my deposit from paybis is missing',
    'I sent USDT from trust wallet and it has not been credited',
    'my trust wallet is not working',
    'I want to withdraw to my trust wallet',
    'is paybis safe',
    'the bot stopped after paybis deposit'
  ];

  yes.forEach((text) => assert.strictEqual(engine.isMethodSelection(engine.analyze(text)), true, text));
  no.forEach((text) => assert.strictEqual(engine.isMethodSelection(engine.analyze(text)), false, text));
  assert.ok(engine.NON_METHOD_INTENTS.includes('deposit_problem'));
  assert.ok(engine.NON_METHOD_INTENTS.includes('withdrawal'));
});

// ------------------------------------------------------------------- H1: keys ---

test('H1: registration questions answer in words, never with a raw key', async () => {
  const cases = ['how do I get started', 'I want to register', 'sign up', 'create an account'];

  for (const text of cases) {
    const h = createHarness();
    await h.say(text);
    const reply = h.last();
    assert.ok(!/onboardCreateAccount/.test(reply), 'raw key leaked for: ' + text);
    assert.ok(reply.includes(t('onboardCreateAccount')), 'the approved copy is sent for: ' + text);
    // Only key-shaped names (camelCase or dotted) can be a leak; ordinary words
    // such as "help" also occur legitimately in the copy.
    Object.keys(i18n.CUSTOMER_STRINGS.en)
      .filter((key) => /[A-Z]|\./.test(key))
      .forEach((key) => {
        assert.ok(!reply.includes(key), 'a dictionary key name leaked into the reply: ' + key);
      });
    assert.ok(!/onboardCreateAccount/.test(h.lastAdmin()), 'the operator notice is clean too');
  }
});

test('H1: every key the dialogue engine renders exists in every locale', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'support', 'ConversationEngine.js'), 'utf8');
  const keys = new Set();
  for (const match of source.matchAll(/\bline\('([A-Za-z0-9_]+)'\)/g)) keys.add(match[1]);
  assert.ok(keys.size > 20, 'the scan must find the engine strings');

  const locales = Object.keys(i18n.CUSTOMER_STRINGS);
  assert.deepStrictEqual(locales.sort(), ['ar', 'en', 'pt']);
  keys.forEach((key) => {
    locales.forEach((locale) => {
      const value = i18n.CUSTOMER_STRINGS[locale][key];
      assert.ok(typeof value === 'string' && value.trim().length > 0,
        'missing or empty ' + locale + ' translation for line(' + key + ')');
    });
  });
});

test('H1: every key the support service sends exists in every locale', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportService.js'), 'utf8');
  const keys = new Set();
  for (const match of source.matchAll(/tCustomer\([^,]+,\s*'([A-Za-z0-9_]+)'/g)) keys.add(match[1]);
  for (const match of source.matchAll(/t\('[a-z]{2}',\s*'([A-Za-z0-9_]+)'\)/g)) keys.add(match[1]);
  assert.ok(keys.size > 10, 'the scan must find service strings');

  keys.forEach((key) => {
    ['en', 'pt', 'ar'].forEach((locale) => {
      assert.ok(typeof i18n.CUSTOMER_STRINGS[locale][key] === 'string',
        'missing ' + locale + ' translation for ' + key);
    });
  });
});

test('H1: the three locales keep identical key sets', () => {
  const en = Object.keys(i18n.CUSTOMER_STRINGS.en).sort();
  ['pt', 'ar'].forEach((locale) => {
    assert.deepStrictEqual(Object.keys(i18n.CUSTOMER_STRINGS[locale]).sort(), en, locale + ' key set drifted');
  });
});

test('H1: registration copy is localized', async () => {
  for (const language of ['pt', 'ar']) {
    const h = createHarness({ language });
    await h.say('quero criar uma conta');
    const reply = h.last();
    assert.ok(!reply.includes(i18n.CUSTOMER_STRINGS.en.onboardCreateAccount),
      'no English copy is sent to a ' + language + ' customer');
    assert.ok(!/onboardCreateAccount/.test(reply), 'no raw key for ' + language);
  }
});

// ------------------------------------------------------------------- H2: close ---

test('H2: a normal /close resumes automation and says so', async () => {
  const h = createHarness();
  await handoffWithAgentReply(h);

  await h.adminSay('/close 1');
  assert.match(h.lastAdmin(), /closed\. Automated replies are enabled again\./);

  await h.say('My deposit is stuck');
  assert.strictEqual(h.last(), t('humanHandoff'), 'the bot answers again after a close');
});

test('H2: a database timestamp slightly ahead of the app clock still resumes', async () => {
  const h = createHarness();
  await handoffWithAgentReply(h);
  h.skewLastAgentMessage(30000); // DB clock 30s ahead

  await h.adminSay('/close 1');
  assert.match(h.lastAdmin(), /Automated replies are enabled again/);

  const before = h.toCustomer().length;
  await h.say('hello again');
  assert.ok(h.toCustomer().length > before, 'automation resumed despite the clock offset');
});

test('H2: a message timestamp far ahead of the app clock still resumes (ids decide, not clocks)', async () => {
  const h = createHarness();
  await handoffWithAgentReply(h);
  h.skewLastAgentMessage(10 * 60 * 1000); // DB clock 10 minutes ahead

  await h.adminSay('/close 1');
  assert.match(h.lastAdmin(), /Automated replies are enabled again/);

  const before = h.toCustomer().length;
  await h.say('are you there?');
  assert.ok(h.toCustomer().length > before, 'the close is honoured regardless of the clock offset');
});

test('H2: a race with a new agent message makes the close report the truth', async () => {
  const h = createHarness();
  await handoffWithAgentReply(h);

  // Simulate the race: the snapshot taken by /close sees the current thread, but a
  // NEW human reply lands before the verification read.
  const original = h.state.store.getLatestMessageByConversation;
  let calls = 0;
  h.state.store.getLatestMessageByConversation = async function (arg) {
    calls += 1;
    const latest = await original.call(this, arg);
    if (calls >= 2 && latest) return Object.assign({}, latest, { id: Number(latest.id) + 500 });
    return latest;
  };

  await h.adminSay('/close 1');
  assert.ok(!/Automated replies are enabled again/.test(h.lastAdmin()),
    'the operator must not be told automation resumed when a newer reply arrived');
  assert.match(h.lastAdmin(), /keeps automated replies paused/);
});

test('H2: a new agent reply after a close re-applies suppression', async () => {
  const h = createHarness();
  await handoffWithAgentReply(h);
  await h.adminSay('/close 1');

  const afterClose = h.toCustomer().length;
  await h.say('first message after the close');
  assert.ok(h.toCustomer().length > afterClose, 'automation resumed after the close');

  await h.adminSay('/reply 1 One more thing from me');
  const beforeSecond = h.toCustomer().length;
  await h.say('second message');
  assert.strictEqual(h.toCustomer().length, beforeSecond,
    'no automated reply while the newest human message is newer than the close');
});

test('H2: the customer is answered after a handoff is closed', async () => {
  const h = createHarness();
  await h.say('I need a human');
  assert.strictEqual(h.last(), t('humanHandoff'));

  await h.adminSay('/reply 1 I am on it');
  const before = h.toCustomer().length;
  await h.say('any update?');
  assert.strictEqual(h.toCustomer().length, before, 'the bot stays quiet while a human is handling');

  await h.adminSay('/close 1');
  await h.say('thanks, one more question: how do I withdraw?');
  assert.ok(h.toCustomer().length > before, 'the customer is answered after the close');
  assert.match(h.last(), /withdraw/i);
});

// ------------------------------------------------------- M1 / M2 / M3 wording ---

test('M1: a courtesy thanks mid-flow continues instead of asking "anything else"', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('thanks');

  const reply = h.last();
  assert.ok(!/anything else/i.test(reply), 'must not close a conversation that is still open: ' + reply);
  assert.ok(reply.includes(t('depositIntro')), 'the pending question is still asked');
  assert.ok(reply.includes(t('thanksOpen')));
});

test('M2: "Really?" with no claim to confirm asks instead of affirming', async () => {
  const h = createHarness();
  await h.say('Really?');
  const reply = h.last();
  assert.ok(!/That is correct/i.test(reply), 'nothing was asserted, so nothing may be confirmed');
  assert.strictEqual(reply, t('clarifyTopic'));
});

test('M2: "Really?" after a question re-asks it instead of affirming', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('Really?');
  const reply = h.last();
  assert.ok(!/That is correct/i.test(reply), 'a question is not a claim');
  assert.ok(reply.includes(t('depositIntro')), 'the question is repeated');
});

test('M2: "Really?" after an answer may confirm it', async () => {
  const h = createHarness();
  await h.say('What is the minimum deposit?');
  assert.match(h.last(), /100/i);
  await h.say('Really?');
  assert.match(h.last(), /That is correct/i, 'a real answer may be confirmed');
});

test('M3: a deposit is never confirmed as credited on the customer word alone', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('No');
  await h.say('Transak');
  await h.say('okay');
  await h.say('I have completed it');
  await h.say('Yes');

  const reply = h.last();
  assert.ok(!/^Perfect - you are ready/i.test(reply), 'no unconditional "you are ready"');
  assert.match(reply, /If the deposit is showing/i, 'the reply is conditional');
  assert.match(reply, /human/i, 'the customer is told how to get it checked');
});

// ----------------------------------------------------------------- M4 / M5 / L7 ---

test('M4: the risk answer carries no safety guarantee', () => {
  const knowledge = SupportKnowledge.readKnowledge();
  const entries = SupportKnowledge.flattenEntries(knowledge);
  const risk = entries.find((e) => e.id === 'trading_bot.risk');
  assert.ok(risk);
  assert.ok(!/^\s*yes\b/i.test(risk.answer), 'the answer must not open with "Yes": ' + risk.answer);
  assert.match(risk.answer, /involves risk/i);
  assert.match(risk.answer, /you can lose money as well as gain/i);
});

test('M5: hacked accounts and missing funds escalate to a human', async () => {
  const cases = [
    'someone hacked my account',
    'my money is gone',
    'I need my money back',
    'why was my account suspended'
  ];

  for (const text of cases) {
    const h = createHarness();
    await h.say(text);
    assert.strictEqual(h.last(), t('humanHandoff'), 'expected a handoff for: ' + text);
    assert.match(h.lastAdmin(), /HUMAN NEEDED/, 'the operator is alerted for: ' + text);
  }
});

test('L7: a network error about a withdrawal does not trigger the deposit-asset answer', async () => {
  const plan = engine.planTurn({ text: 'network error on my withdrawal', state: engine.emptyState() });
  assert.notStrictEqual(plan.intent, 'deposit_asset');
  assert.strictEqual(plan.intent, 'withdrawal');

  const h = createHarness();
  await h.say('network error on my withdrawal');
  assert.ok(!/cryptocurrency can I deposit/i.test(h.last()), 'wrong knowledge entry: ' + h.last());
});

test('L7: deposit-network questions are still answered', () => {
  ['which network should I use', 'what network do I send USDT on', 'do I use TRC20'].forEach((text) => {
    const plan = engine.planTurn({ text, state: engine.emptyState() });
    assert.strictEqual(plan.intent, 'deposit_asset', 'expected the deposit-asset answer for: ' + text);
  });
});

// --------------------------- N1: transient read failure at /close (review) ---

test('N1: a null resolved id stays null (never becomes id 0)', () => {
  const engineState = engine.normalizeState({
    handoffResolvedAt: '2026-11-03T10:00:00.000Z',
    handoffResolvedMessageId: null
  });
  assert.strictEqual(engineState.handoffResolvedMessageId, null, 'null must not coerce to 0');
  assert.strictEqual(engine.normalizeState({}).handoffResolvedMessageId, null);
  assert.strictEqual(engine.normalizeState({ handoffResolvedMessageId: '' }).handoffResolvedMessageId, null);
  assert.strictEqual(engine.normalizeState({ handoffResolvedMessageId: 'abc' }).handoffResolvedMessageId, null);
  assert.strictEqual(engine.normalizeState({ handoffResolvedMessageId: 0 }).handoffResolvedMessageId, null);
  assert.strictEqual(engine.normalizeState({ handoffResolvedMessageId: -3 }).handoffResolvedMessageId, null);
  // A real id survives, including the string form a JSON round trip may produce.
  assert.strictEqual(engine.normalizeState({ handoffResolvedMessageId: 12 }).handoffResolvedMessageId, 12);
  assert.strictEqual(engine.normalizeState({ handoffResolvedMessageId: '12' }).handoffResolvedMessageId, 12);
});

test('N1: a transient read failure at /close cannot silence the conversation', async () => {
  const failingReads = { on: false };
  const h = createHarness({ failingReads });
  await h.say('I need a human');
  await h.adminSay('/reply 1 investigating');

  failingReads.on = true; // the snapshot read at close time fails
  await h.adminSay('/close 1');

  assert.strictEqual(h.conversation().context.handoffResolvedMessageId, null,
    'no id may be invented when the read failed');
  assert.match(h.lastAdmin(), /Automated replies are enabled again/,
    'the operator is told the truth: the timestamp fallback resumes');

  failingReads.on = false; // the database recovers
  const before = h.toCustomer().length;
  await h.say('any update?');
  assert.ok(h.toCustomer().length > before, 'the customer is answered after recovery');
  assert.notStrictEqual(h.last(), 'investigating', 'the customer got a real reply, not silence');
});

test('N1: a read failure at close followed by a second close still resumes', async () => {
  const failingReads = { on: false };
  const h = createHarness({ failingReads });
  await h.say('I need a human');
  await h.adminSay('/reply 1 investigating');

  failingReads.on = true;
  await h.adminSay('/close 1');
  failingReads.on = false;

  await h.adminSay('/close 1'); // idempotent operator retry
  assert.ok(Number.isFinite(h.conversation().context.handoffResolvedMessageId),
    'the retry records the message id');

  const before = h.toCustomer().length;
  await h.say('hello?');
  assert.ok(h.toCustomer().length > before);
});

test('N1: a close that could read no id still resumes after a customer message', async () => {
  // The snapshot returns a row without an id (a store that does not select it).
  const h = createHarness();
  const original = h.state.store.getLatestMessageByConversation;
  let strip = true;
  h.state.store.getLatestMessageByConversation = async function (arg) {
    const latest = await original.call(this, arg);
    if (strip && latest) { strip = false; return Object.assign({}, latest, { id: undefined }); }
    return latest;
  };

  await h.say('I need a human');
  await h.adminSay('/reply 1 investigating');
  await h.adminSay('/close 1');
  assert.strictEqual(h.conversation().context.handoffResolvedMessageId, null);

  const before = h.toCustomer().length;
  await h.say('any update?');
  assert.ok(h.toCustomer().length > before, 'the timestamp fallback resumes');
});

test('N1: suppression still returns for a human reply newer than the close', async () => {
  const h = createHarness();
  await handoffWithAgentReply(h);
  await h.adminSay('/close 1');
  await h.adminSay('/reply 1 one more thing');

  const before = h.toCustomer().length;
  await h.say('second message');
  assert.strictEqual(h.toCustomer().length, before, 'a newer human reply re-applies suppression');
});

// ------------------------- N2: positive deposit statements are not problems ---

test('N2: a positive "it still shows" statement is not a deposit problem', () => {
  const benign = [
    'I deposited yesterday and it still shows in my balance',
    'I deposited and it shows in my balance',
    'I deposited and it still shows',
    'my deposit arrived and shows in my balance'
  ];
  benign.forEach((text) => {
    const plan = engine.planTurn({ text, state: engine.emptyState() });
    assert.notStrictEqual(plan.intent, 'deposit_problem', 'false escalation for: ' + text);
  });
});

test('N2: genuine deposit problems still escalate', async () => {
  const cases = [
    'I deposited but nothing shows',
    'my deposit is still pending',
    'I sent 100 USDT from trust wallet and it has not been credited',
    'I paid with transak but the balance is still zero',
    'my deposit has not arrived',
    'I deposited and it still shows nothing',
    'my payment failed',
    'the deposit is stuck'
  ];
  cases.forEach((text) => {
    const plan = engine.planTurn({ text, state: engine.emptyState() });
    assert.strictEqual(plan.intent, 'deposit_problem', 'not escalated: ' + text);
  });

  const h = createHarness();
  await h.say('I deposited yesterday and it still shows in my balance');
  assert.notStrictEqual(h.last(), t('humanHandoff'), 'the positive statement is answered, not escalated');
  assert.ok(!/t\.me\//.test(h.last()), 'and no tutorial is attached');
});

// ------------------------------- N3: the handoff instructions are actionable ---

test('N3: every instruction the bot gives is recognised as a handoff', () => {
  const instructions = [
    // Exactly the words the deposit copy tells the customer to use, per locale.
    ['en', 'human'], ['pt', 'humano'], ['ar', 'بشري'],
    // Punctuation and quoting tolerated.
    ['en', 'Human.'], ['en', 'human!'], ['en', '"human"'], ['en', 'human?'],
    ['pt', 'Humano.'], ['pt', 'humano!'], ['ar', 'بشري.'],
    // The other natural short forms.
    ['en', 'human please'], ['en', 'agent'], ['en', 'operator'],
    ['en', 'I need help from a human'], ['en', 'help from a human'],
    ['pt', 'atendente'], ['pt', 'quero falar com um atendente']
  ];

  instructions.forEach(([locale, text]) => {
    const plan = engine.planTurn({ text, state: engine.emptyState() });
    assert.strictEqual(plan.intent, 'human', 'not recognised as a handoff (' + locale + '): ' + text);
    assert.strictEqual(plan.humanRequested, true, 'the handoff flag is set for: ' + text);
  });
});

test('N3: the copy no longer promises a word the bot ignores', () => {
  // The words quoted by the deposit copy must be the words the engine accepts.
  const quoted = {
    en: i18n.CUSTOMER_STRINGS.en.depositCreditedYes.match(/say "([^"]+)"/),
    pt: i18n.CUSTOMER_STRINGS.pt.depositCreditedYes.match(/escreva "([^"]+)"/),
    ar: i18n.CUSTOMER_STRINGS.ar.depositCreditedYes.match(/"([^"]+)"/)
  };
  ['en', 'pt', 'ar'].forEach((locale) => {
    assert.ok(quoted[locale], 'the copy must quote the word to use (' + locale + ')');
    const word = quoted[locale][1];
    const plan = engine.planTurn({ text: word, state: engine.emptyState() });
    assert.strictEqual(plan.intent, 'human', locale + ' copy says "' + word + '" but the bot does not escalate it');
  });
});

test('N3: a statement that merely contains the word "human" is not a handoff', () => {
  ['the bot is not human', 'I am not a human', 'is this a human or a bot'].forEach((text) => {
    const plan = engine.planTurn({ text, state: engine.emptyState() });
    assert.notStrictEqual(plan.intent, 'human', 'false handoff for: ' + text);
  });
});
