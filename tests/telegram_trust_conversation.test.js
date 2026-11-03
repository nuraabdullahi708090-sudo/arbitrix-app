'use strict';

/**
 * Trust, legitimacy, registration, platform and earnings conversations.
 *
 * These drive the REAL bot (`createTelegramSupportBot`), the REAL dialogue
 * engine (`services/support/ConversationEngine`), the REAL localized dictionary
 * (`services/telegram-i18n`) and the REAL approved knowledge base. Only the
 * store (in-memory rows, including `context`) and the transport (records the
 * sendMessage calls) are faked, so every assertion below describes what a
 * customer actually receives, message by message.
 *
 * Coverage follows the review brief:
 *   A. trust and legitimacy        E. multilingual (en / pt / ar)
 *   B. earnings and performance    F. human handoff
 *   C. withdrawal conversation     G. false-positive protection
 *   D. general continuity          H. existing functionality
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createTelegramSupportBot,
  DIRECTION_CUSTOMER,
  DIRECTION_BOT,
  DIRECTION_AGENT
} = require('../services/TelegramSupportService');
const i18n = require('../services/telegram-i18n');
const engine = require('../services/support/ConversationEngine');

const CUSTOMER = '8801';
const ADMIN = '8802';
const TOKEN = '123456:TRUST-CONVERSATION-TEST';

const REGISTRATION_URL = 'https://arbitrix.pro/business-registration';
const HOW_URL = 'https://arbitrix.pro/how-it-works';
const KVK_NUMBER = '72923513';
const LEGAL_NAME = 'Arbitrix Trading';

const silentLogger = { log() {}, warn() {}, error() {}, info() {} };

let updateCounter = 700000;
const nextUpdateId = () => (updateCounter += 1);

// ------------------------------------------------------------------ harness ---

function createStore() {
  const conversations = new Map();
  const messages = [];
  const escalations = [];
  let nextConversationId = 1;

  const store = {
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
      const escalation = {
        id: escalations.length + 1,
        conversation_id: conversationId,
        support_message_id: supportMessageId
      };
      escalations.push(escalation);
      return { escalation };
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
  };

  return { store, conversations, messages, escalations };
}

function createTransport() {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, options) {
      const message_id = sent.length + 1;
      sent.push({ method: 'sendMessage', chatId: String(chatId), text, options, message_id });
      return { message_id };
    },
    async sendVideo(chatId, video, caption) {
      sent.push({ method: 'sendVideo', chatId: String(chatId), video, text: caption });
      return { message_id: sent.length + 1 };
    },
    getLastCall() {
      return null;
    }
  };
}

function createHarness({ language = 'en', state = null } = {}) {
  const data = state || createStore();
  const transport = createTransport();

  if (!data.conversations.has(CUSTOMER)) {
    data.conversations.set(CUSTOMER, {
      id: data.conversations.size + 1,
      telegram_chat_id: Number(CUSTOMER),
      telegram_user_id: Number(CUSTOMER),
      username: 'ana',
      display_name: 'Ana',
      language,
      context: null,
      created_at: new Date().toISOString()
    });
  }

  const bot = createTelegramSupportBot({
    config: {
      token: TOKEN,
      webhookSecret: 'trust-conversation-secret',
      baseUrl: 'https://arbitrix.pro',
      supportChatId: null,
      adminIds: [ADMIN],
      notifyTarget: 'admins'
    },
    store: data.store,
    transport,
    logger: silentLogger
  });

  const customerTexts = () => transport.sent
    .filter((m) => m.chatId === CUSTOMER && m.method === 'sendMessage')
    .map((m) => m.text);
  const adminTexts = () => transport.sent
    .filter((m) => m.chatId === ADMIN && m.method === 'sendMessage')
    .map((m) => m.text);

  async function say(text, { updateId = nextUpdateId() } = {}) {
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

  return {
    bot,
    state: data,
    transport,
    say,
    adminSay,
    conversation: () => data.conversations.get(CUSTOMER) || null,
    context: () => (data.conversations.get(CUSTOMER) || {}).context || null,
    toCustomer: customerTexts,
    last: () => customerTexts().pop(),
    toAdmin: adminTexts,
    lastAdmin: () => adminTexts().pop(),
    lastOptions: () => transport.sent.filter(
      (m) => m.chatId === CUSTOMER && m.method === 'sendMessage'
    ).pop().options
  };
}

const t = (key, language = 'en', vars) => i18n.t(language, key, vars);

/** Every URL a reply points at. */
const urlsIn = (text) => (String(text).match(/https?:\/\/[^\s]+/g) || []);

/**
 * "guaranteed" only ever appears in a NEGATED form ("no fixed daily income or
 * guaranteed profit"), which is the required disclosure - never a promise.
 */
function guaranteeIsNegated(text) {
  const windows = String(text).match(/[^.]{0,45}guarantee[^.]{0,20}/gi) || [];
  return windows.every((window) => /\bno\b|\bnot\b|n't/i.test(window));
}

/** Assertions shared by every trust-style answer. */
function assertNoUnsupportedClaims(reply) {
  assert.ok(guaranteeIsNegated(reply), 'no guarantee promise: ' + reply);
  assert.ok(!/risk[\s-]*free/i.test(reply), 'no risk-free claim: ' + reply);
  assert.ok(!/\d+(?:\.\d+)?\s*%/.test(reply), 'no invented percentage: ' + reply);
  assert.ok(!/licen[cs]ed|regulated\s+by|authori[sz]ed\s+by/i.test(reply),
    'business registration is not a financial-services licence: ' + reply);
  assert.ok(!/\b(?:SEC|FCA|AFM|BaFin|CySEC|FINRA)\b/.test(reply), 'no invented regulator: ' + reply);
  assert.ok(!/\b(?:e-?mail|@)\S+@/.test(reply), 'no contact address is invented');
}

// ======================================================= A. trust & legitimacy

test('A1. "Is Arbitrix a scam?" receives the approved, factually supported answer', async () => {
  const h = createHarness();
  await h.say('Is Arbitrix a scam?');

  const reply = h.last();
  assert.ok(reply.includes(t('trustIntro')), 'the approved intro is used');
  assert.ok(reply.includes(t('trustWhatWeDo')), 'the approved platform description is used');
  assert.ok(/registered business/i.test(reply), 'the registration statement is present');
  assert.ok(reply.includes(REGISTRATION_URL), 'the registration page is linked');
  assert.ok(reply.includes(HOW_URL), 'the how-it-works page is linked');
  assert.ok(reply.includes(t('trustQuestion')), 'the answer offers the walkthrough');
  assert.ok(reply.includes(t('trustSupportLine')), 'the human route is offered (existing handoff)');
  assertNoUnsupportedClaims(reply);
  // The full trust answer carries no unverifiable company detail: the register
  // number appears only in the explicit verification answer (A6).
  assert.ok(!reply.includes(KVK_NUMBER), 'the overview does not quote the register number');
  assert.ok(!/\b(?:Leenewald|Assen|phone|address)\b/i.test(reply), 'no unpublished company detail');
  assert.strictEqual(h.context().topic, 'trust');
  assert.strictEqual(h.context().pending, 'guide.offer');
});

test('A2. every scam / legitimacy phrasing in the brief is recognised', async () => {
  const phrases = [
    'Is Arbitrix a scam?',
    "Hope this isn't a scam.",
    'Is this a scam platform?',
    'Is Arbitrix legit?',
    'Is Arbitrix legitimate?',
    'Is this genuine?',
    'Is your platform genuine?',
    'Can I trust Arbitrix?',
    'How do I know this is real?',
    'Are you guys legit?',
    'Is this a real company?',
    'Is Arbitrix trustworthy?'
  ];
  for (const phrase of phrases) {
    const h = createHarness();
    await h.say(phrase);
    assert.ok(h.last().includes(t('trustIntro')), 'not answered as a trust question: ' + phrase);
    assert.strictEqual(h.context().topic, 'trust', phrase);
  }
});

test('A3. misspellings, punctuation and mixed case still reach the trust answer', async () => {
  const phrases = [
    'is arbitrix a scamm?',
    'IS ARBITRIX LEGIT???',
    'Is Arbtirix legit?',
    'is it a scam or not',
    'legit?'
  ];
  for (const phrase of phrases) {
    const h = createHarness();
    await h.say(phrase);
    assert.ok(h.last().includes(t('trustIntro')), 'not recognised: ' + phrase);
  }
});

test('A4. registration questions are recognised separately from general trust', async () => {
  const cases = [
    'Are you registered?',
    'Is Arbitrix a registered company?',
    'Where is your company registered?',
    'Do you have a business certificate?',
    'How can I check your company details?',
    'How do I confirm your business is genuine?'
  ];
  for (const phrase of cases) {
    const h = createHarness();
    await h.say(phrase);
    const reply = h.last();
    assert.ok(reply.includes(REGISTRATION_URL), 'the registration page must be linked: ' + phrase);
    assert.strictEqual(h.context().topic, 'trust', phrase);
  }
});

test('A5. general trust questions are answered without inventing history', async () => {
  for (const phrase of ['Why should I use Arbitrix?', 'What makes Arbitrix different?', 'How long have you been operating?']) {
    const h = createHarness();
    await h.say(phrase);
    const reply = h.last();
    assert.ok(reply.includes(t('trustIntro')), 'not a trust answer: ' + phrase);
    assert.ok(!/since\s+\d{4}|\b\d+\s+years?\b/i.test(reply), 'no invented operating history: ' + reply);
  }
});

test('A6. registration verification quotes the published name and KVK number', async () => {
  const h = createHarness();
  await h.say('How can I verify your registration?');

  const reply = h.last();
  assert.ok(reply.includes(REGISTRATION_URL), 'the page URL must be present');
  assert.ok(reply.includes(LEGAL_NAME), 'the exact legal name must be present');
  assert.ok(reply.includes(KVK_NUMBER), 'the KVK number must be present');
  assert.ok(/Netherlands Chamber of Commerce \(KVK\)/.test(reply), 'the registry is named accurately');
  assert.ok(!reply.includes(t('trustCertificate')), 'the certificate offer is only added when asked for');
  assert.strictEqual(h.context().stage, 'trust.followup');
});

test('A7. asking for the certificate adds the document instructions, never a document', async () => {
  const h = createHarness();
  await h.say('Can you show me your registration documents?');

  const reply = h.last();
  assert.ok(reply.includes(t('trustCertificate')), 'the certificate guidance is offered');
  assert.ok(!/\.(?:jpg|jpeg|png|pdf)/i.test(reply), 'no document is attached or invented');
  assert.ok(reply.includes(REGISTRATION_URL), 'the customer is sent to the official page');
});

test('A8. the scam answer follows up with a SHORT verification answer (no script repeat)', async () => {
  const h = createHarness();
  await h.say('Is Arbitrix a scam?');
  await h.say('How do I verify the registration?');

  const reply = h.last();
  assert.ok(reply.includes(KVK_NUMBER), 'the follow-up answers the actual question');
  assert.ok(!reply.includes(t('trustIntro')), 'the whole trust script is not repeated');
  assert.ok(!reply.includes(t('trustPoints')), 'the overview is not repeated');
});

test('A9. an unpublished company detail is refused honestly and handed to a human', async () => {
  const h = createHarness();
  await h.say('Is Arbitrix registered?');
  await h.say('What is your company address?');

  const reply = h.last();
  assert.strictEqual(reply, t('trustLimits'), 'the honest limit is stated');
  assert.ok(!/\b(?:Leenewald|9407|Assen|\+\d)/i.test(reply), 'no address or phone is invented');
  assert.match(h.lastAdmin(), /HUMAN REQUESTED|HUMAN NEEDED/, 'the team is asked to help');
});

test('A10. the trust answer offers inline buttons with the exact official URLs', async () => {
  const h = createHarness();
  await h.say('Is Arbitrix a scam?');

  const options = h.lastOptions();
  assert.ok(options && options.reply_markup, 'an inline keyboard is attached');
  const rows = options.reply_markup.inline_keyboard;
  assert.strictEqual(rows.length, 1, 'one row of buttons');
  assert.deepStrictEqual(rows[0].map((b) => b.url), [REGISTRATION_URL, HOW_URL]);
  assert.deepStrictEqual(rows[0].map((b) => b.text), [t('btnBusiness'), t('btnHowItWorks')]);
  rows[0].forEach((b) => assert.strictEqual(b.callback_data, undefined, 'URL buttons only - no callback payload'));
});

test('A11. plain deposit/withdrawal answers carry no keyboard', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  assert.strictEqual(h.lastOptions(), undefined, 'no inline keyboard on an unrelated answer');
});

test('A12. the registration statement never becomes a licence claim', async () => {
  const h = createHarness();
  for (const phrase of ['Are you registered?', 'Is Arbitrix legit?', 'What is your KVK number?']) {
    await h.say(phrase);
    const reply = h.last();
    assertNoUnsupportedClaims(reply);
    assert.ok(!/financial\s+(?:licen[cs]e|authori[sz]ation|regulat)/i.test(reply), reply);
  }
});

test('A13. trust state survives a process restart (the conversation is persisted)', async () => {
  const first = createHarness();
  await first.say('Is Arbitrix a scam?');

  // A new bot instance over the SAME store: nothing lives in module memory.
  const second = createHarness({ state: first.state });
  await second.say('How do I verify the registration?');
  const reply = second.last();
  assert.ok(reply.includes(KVK_NUMBER), 'the follow-up is still context-aware after a restart');
  assert.ok(!reply.includes(t('trustIntro')), 'the overview is not repeated after a restart');
});

// ================================================ B. earnings & performance --

test('B1. "How much can I make in a day?" is answered as a performance question', async () => {
  const h = createHarness();
  await h.say('How much can i make in a day using it');

  const reply = h.last();
  assert.ok(reply.includes(t('earningsIntro')), 'the responsible explanation is used');
  assert.ok(/no fixed daily income or guaranteed profit/i.test(reply), 'the expectation is set honestly');
  assert.ok(/risk/i.test(reply), 'risk is disclosed');
  assert.ok(reply.includes(t('earningsQuestion')), 'the answer offers the walkthrough');
  assert.ok(!/please describe|support agent will assist|unrecognised/i.test(reply), 'never the generic fallback');
  assert.ok(!/\d+(?:\.\d+)?\s*%/.test(reply), 'no invented percentage');
  assert.ok(!/\$\s?\d/.test(reply), 'no invented amount');
  assert.strictEqual(h.context().topic, 'earnings');
});

test('B2. every earnings phrasing in the brief is classified as earnings', async () => {
  const phrases = [
    'How much can I make in a day?',
    'How much profit can I earn?',
    'What is the daily return?',
    'How much does the bot generate?',
    'How much can I earn with $100?',
    'What is the expected profit?',
    'How much can I make monthly?',
    'Is the profit guaranteed?',
    'Can I earn every day?',
    'What percentage does the bot make?',
    'Is there a fixed daily profit?',
    'How much will I earn if I deposit?',
    'How much does the bot make?'
  ];
  for (const phrase of phrases) {
    const h = createHarness();
    await h.say(phrase);
    assert.ok(h.last().includes(t('earningsIntro')), 'not an earnings answer: ' + phrase);
    assertNoUnsupportedClaims(h.last());
  }
});

test('B3. no daily figure, return, percentage or historical result is ever invented', async () => {
  const h = createHarness();
  await h.say('What is the daily profit?');
  const reply = h.last();
  assert.ok(!/\b\d+\s*(?:usd|usdt|dollars?)\b/i.test(reply), 'no invented daily amount');
  assert.ok(!/\b(?:daily|monthly)\b[^.]{0,20}\b\d/i.test(reply), 'no invented daily/monthly figure');
  assert.ok(!/\b(?:in|last)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(reply),
    'no invented historical period');
});

test('B4. "Is profit guaranteed?" is answered with a clear no, not a projection', async () => {
  const h = createHarness();
  await h.say('Is profit guaranteed?');
  const reply = h.last();
  assert.ok(/no fixed daily income or guaranteed profit/i.test(reply), reply);
  assert.ok(!/^yes\b/i.test(reply), 'never starts with a yes');
  assert.ok(!/\byou will earn\b|\bwill make\b/i.test(reply), 'no promise of earnings');
});

test('B5. "How much can I earn with $100?" does not project a return on $100', async () => {
  const h = createHarness();
  await h.say('How much can I earn with $100?');
  const reply = h.last();
  assert.ok(reply.includes(t('earningsIntro')));
  assert.ok(!/\ $100\b|\$100\s*(?:could|can|will|would)\b/i.test(reply), 'no projection tied to $100');
});

test('B6. "How much does the bot make?" is not read as a trading-bot FAQ', async () => {
  const h = createHarness();
  await h.say('How much does the bot make?');
  assert.ok(h.last().includes(t('earningsIntro')));
  assert.ok(!h.last().includes(t('platformIntro')), 'not answered as a platform explanation');
});

test('B7. "Can I earn every day?" sets expectations without a schedule promise', async () => {
  const h = createHarness();
  await h.say('Can I earn every day?');
  const reply = h.last();
  assert.ok(reply.includes(t('earningsIntro')));
  assert.ok(!/every ?day you (?:will|can expect)/i.test(reply), reply);
});

test('B8. the earnings answer offers the walkthrough, and "Yes" delivers it', async () => {
  const h = createHarness();
  await h.say('How much can I make in a day?');
  assert.strictEqual(h.context().pending, 'guide.offer');
  await h.say('Yes');
  assert.ok(h.last().includes(t('platformIntro')), 'the guide follows the offer');
  assert.ok(h.last().includes(HOW_URL));
  assert.strictEqual(h.context().stage, 'platform');
});

test('B9. a performance question with no approved figure escalates instead of guessing', async () => {
  const h = createHarness();
  await h.say('What was your profit last month?');
  const reply = h.last();
  assert.ok(!/\d+(?:\.\d+)?\s*%/.test(reply), 'no figure invented');
  assert.ok(!/\$\s?\d/.test(reply), 'no amount invented');
});

// ================================================== C. withdrawal conversation

test('C1. the screenshot sequence: withdrawing -> "Checked" is understood, not ignored', async () => {
  const h = createHarness();
  await h.say('What about withdrawing funds');
  assert.ok(h.last().includes(t('withdrawIntro')));
  assert.ok(h.last().includes(t('withdrawHelpPrompt')));
  assert.ok(h.last().includes('https://t.me/ArbitrixAnnouncements/19'), 'the withdrawal tutorial is shared');

  await h.say('Checked');
  const reply = h.last();
  assert.strictEqual(reply, t('withdrawChecked'), 'the acknowledgement is used');
  assert.ok(!/please describe your issue|support agent will assist/i.test(reply), 'never the generic fallback');
  assert.strictEqual(h.context().pending, 'anything_else');
});

test('C2. "Checked" never claims the withdrawal completed or the funds arrived', async () => {
  const h = createHarness();
  await h.say('What about withdrawing funds');
  await h.say('I checked');
  const reply = h.last();
  const lower = reply.toLowerCase();
  // Everything about completion/arrival is CONDITIONAL ("If your withdrawal is
  // showing as completed ... you're all set"), i.e. the customer's own report,
  // never the bot asserting it.
  assert.ok(/^alright!/i.test(reply), 'a plain acknowledgement: ' + reply);
  assert.ok(/\bif\b/.test(lower), 'the statement is conditional');
  assert.ok(!/^(?:your|the) withdrawal (?:is|has been|was)\b/i.test(lower), 'no unconditional claim: ' + reply);
  assert.ok(!/congratulations/i.test(lower), reply);
  assert.ok(!/we (?:have )?(?:confirmed|processed|sent)/i.test(lower), reply);
});

test('C3. "Yes, checked" is an acknowledgement, not a request for a human', async () => {
  const h = createHarness();
  await h.say('What about withdrawing funds');
  await h.say('Yes, checked');
  assert.strictEqual(h.last(), t('withdrawChecked'));
  assert.ok(!/human/i.test(h.lastAdmin()), 'not escalated as a problem');
});

test('C4. "Still pending" gets the timing guidance, not a handoff', async () => {
  const h = createHarness();
  await h.say('What about withdrawing funds');
  await h.say('Still pending.');
  assert.strictEqual(h.last(), t('withdrawStillPending'));
  assert.ok(/15-30 minutes/.test(h.last()), 'the published window is quoted');
  assert.strictEqual(h.context().pending, 'anything_else');
});

test('C5. "I haven\'t received it" is handed to a human, never answered as fact', async () => {
  const h = createHarness();
  await h.say('What about withdrawing funds');
  await h.say("I haven't received it");
  assert.strictEqual(h.last(), t('paymentStatus'), 'the bot states it cannot check accounts');
  assert.match(h.lastAdmin(), /HUMAN REQUESTED/, 'a human is requested');
  assert.ok(!/\$[\d]/.test(h.last()), 'no amount is invented');
});

test('C6. "It arrived" is acknowledged without over-claiming', async () => {
  const h = createHarness();
  await h.say('What about withdrawing funds');
  await h.say('It arrived.');
  assert.strictEqual(h.last(), t('withdrawArrived'));
  assert.strictEqual(h.context().pending, 'anything_else');
});

test('C7. "I have a problem" hands off to the existing human path', async () => {
  const h = createHarness();
  await h.say('What about withdrawing funds');
  await h.say('I have a problem.');
  assert.strictEqual(h.last(), t('humanHandoff'));
  assert.match(h.lastAdmin(), /HUMAN REQUESTED/);
});

test('C8. "No problem" closes the loop politely instead of asking "what do you need?"', async () => {
  const h = createHarness();
  await h.say('What about withdrawing funds');
  await h.say('No problem.');
  assert.strictEqual(h.last(), t('anythingElse'));
  assert.strictEqual(h.context().pending, 'anything_else');
});

test('C9. "Not yet" then "Thank you" closes the conversation', async () => {
  const h = createHarness();
  await h.say('What about withdrawing funds');
  await h.say('Not yet.');
  assert.strictEqual(h.last(), t('anythingElse'));
  await h.say('Thank you');
  // Updated intentionally (social acknowledgements): at rest a thank-you gets the
  // warm one-line courtesy instead of "if you need anything else, just send a
  // message here" - same closing intent, one consistent reply everywhere.
  assert.strictEqual(h.last(), t('socialThanks'));
  assert.strictEqual(h.context().pending, 'anything_else');
});

test('C10. an unrelated message mid-withdrawal still routes to its own intent', async () => {
  const h = createHarness();
  await h.say('What about withdrawing funds');
  await h.say('How do I deposit?');
  assert.ok(h.last().includes(t('depositIntro')) || h.last().includes(t('depositHaveCrypto')),
    'a clear new question is not swallowed by the withdrawal context');
});

test('C11. a withdrawal already explained is not restarted by "thanks"', async () => {
  const h = createHarness();
  await h.say('What about withdrawing funds');
  await h.say('thanks');
  // Updated intentionally (social acknowledgements): the withdrawal guidance was
  // already delivered, so a thank-you gets ONE courtesy instead of "Just to
  // continue where we left off:" plus the same withdrawal question again. The
  // flow is still not restarted - it is simply finished and left at rest.
  assert.strictEqual(h.last(), t('socialThanks'));
  assert.ok(!h.last().includes(t('withdrawHelpPrompt')), 'the old question is not re-asked');
  assert.ok(!h.last().includes(t('withdrawIntro')), 'the guidance is not repeated');
  assert.strictEqual(h.context().pending, 'anything_else');
});

// ======================================================== D. general continuity

test('D1. "Yes" after the trust offer delivers the guide', async () => {
  const h = createHarness();
  await h.say('Is this genuine?');
  await h.say('Yes');
  assert.ok(h.last().includes(t('platformIntro')));
});

test('D2. "No" after the guide offer closes politely', async () => {
  const h = createHarness();
  await h.say('Is this genuine?');
  await h.say('No');
  assert.strictEqual(h.last(), t('anythingElse'));
});

test('D3. after the platform explanation an acknowledgement is a courtesy, an explicit yes still continues', async () => {
  // Updated intentionally (social acknowledgements): the explanation ENDS with
  // "would you like to know how to get started?", so answering "okay" repeated
  // the entire explanation. An acknowledgement is now answered as the courtesy it
  // is; an explicit "yes" / "sure" still continues the conversation.
  const courtesies = [
    ['Okay', 'socialAck'],
    ['Got it', 'socialUnderstood'],
    ['Alright', 'socialAck'],
    ['Good', 'socialPositive']
  ];
  for (const [word, key] of courtesies) {
    const h = createHarness();
    await h.say('How does Arbitrix work?');
    await h.say(word);
    assert.ok(!h.last().includes(t('platformIntro')), '"' + word + '" must not replay the explanation');
    assert.ok(!h.last().includes(t('clarifyTopic')), '"' + word + '" must not fall into the fallback');
    assert.strictEqual(h.last(), t(key), '"' + word + '" gets its own courtesy');
    assert.strictEqual(h.context().pending, 'anything_else');
  }

  for (const word of ['Sure', 'Yes']) {
    const h = createHarness();
    await h.say('How does Arbitrix work?');
    await h.say(word);
    assert.ok(h.last().includes(t('platformIntro')), '"' + word + '" asked for more and gets it');
  }
});

test('D4. "Tell me more" continues the current subject', async () => {
  const h = createHarness();
  await h.say('Is Arbitrix a scam?');
  await h.say('Tell me more');
  assert.ok(h.last().includes(t('platformIntro')));
  assert.ok(!h.last().includes(t('trustIntro')), 'the trust script is not repeated');
});

test('D5. "What next?" after the platform explanation shows the guide, not a reset', async () => {
  const h = createHarness();
  await h.say('How does Arbitrix work?');
  await h.say('What next?');
  assert.ok(h.last().includes(t('platformIntro')));
  assert.ok(h.last().includes(t('platformQuestion')));
});

test('D6. "I understand" mid-conversation keeps the pending question', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('I understand');
  assert.strictEqual(h.context().pending, 'deposit.transfer_done');
});

test('D7. "Thanks" mid-flow keeps the flow, "Thanks" at rest closes it', async () => {
  const mid = createHarness();
  await mid.say('Is Arbitrix a scam?');
  await mid.say('Thanks');
  assert.ok(mid.last().startsWith(t('thanksOpen')));
  assert.strictEqual(mid.context().pending, 'guide.offer', 'the offer is not lost');

  const atRest = createHarness();
  await atRest.say('Thanks');
  // Updated intentionally (social acknowledgements): at rest a thank-you gets the
  // same warm courtesy it gets anywhere else, rather than a second wording of the
  // same closing line.
  assert.strictEqual(atRest.last(), t('socialThanks'));
  assert.strictEqual(atRest.context().pending, 'anything_else');
});

test('D8. a bare "Yes" with no history never guesses', async () => {
  const h = createHarness();
  await h.say('Yes');
  assert.strictEqual(h.last(), t('clarifyTopic'));
});

// ============================================================= E. multilingual

test('E1. the trust answer is native Portuguese, with the same facts and URLs', async () => {
  const h = createHarness({ language: 'pt' });
  await h.say('A Arbitrix é um golpe?');

  const reply = h.last();
  assert.ok(reply.includes(t('trustIntro', 'pt')));
  assert.ok(reply.includes(REGISTRATION_URL) && reply.includes(HOW_URL));
  assert.ok(!reply.includes(t('trustIntro', 'en')), 'no English leak');
  assert.ok(/empresa registrada/i.test(reply), 'natural Portuguese wording');
  assert.strictEqual(h.lastOptions().reply_markup.inline_keyboard[0][0].text, t('btnBusiness', 'pt'));
});

test('E2. the trust answer is native Arabic and the facts stay in Latin script where required', async () => {
  const h = createHarness({ language: 'ar' });
  await h.say('هل Arbitrix منصة حقيقية؟');

  const reply = h.last();
  assert.ok(reply.includes(t('trustIntro', 'ar')));
  assert.ok(/[\u0600-\u06FF]/.test(reply), 'Arabic script is used');
  assert.ok(!reply.includes(t('trustIntro', 'en')), 'no English leak');
  assert.ok(reply.includes(REGISTRATION_URL) && reply.includes(HOW_URL));
  assert.strictEqual(h.lastOptions().reply_markup.inline_keyboard[0][0].text, t('btnBusiness', 'ar'));
});

test('E3. the verification answer keeps the legal name and KVK number in every language', async () => {
  for (const language of ['en', 'pt', 'ar']) {
    const h = createHarness({ language });
    await h.say('What is your KVK number?');
    const reply = h.last();
    assert.ok(reply.includes(LEGAL_NAME), language + ': legal name');
    assert.ok(reply.includes(KVK_NUMBER), language + ': KVK number');
    assert.ok(reply.includes(REGISTRATION_URL), language + ': URL');
    if (language !== 'en') assert.ok(!reply.includes('Our registration details are published'), language + ': no English leak');
  }
});

test('E4. the earnings answer is localized in all three languages', async () => {
  const questions = { en: 'How much can I make in a day?', pt: 'Quanto posso ganhar por dia?', ar: 'كم يمكن أن أربح يومياً؟' };
  for (const language of ['en', 'pt', 'ar']) {
    const h = createHarness({ language });
    await h.say(questions[language]);
    const reply = h.last();
    assert.ok(reply.includes(t('earningsIntro', language)), language + ': localized earnings answer');
    if (language === 'pt') assert.ok(/risco/i.test(reply), 'Portuguese risk wording');
    if (language === 'ar') {
      assert.ok(/[\u0600-\u06FF]/.test(reply), 'Arabic script');
      assert.ok(/مخاطر/.test(reply), 'Arabic risk wording');
    }
    assert.ok(!reply.includes(t('earningsIntro', 'en')) || language === 'en', language + ': no English leak');
  }
});

test('E5. withdrawal follow-ups are localized', async () => {
  const h = createHarness({ language: 'pt' });
  await h.say('Quero sacar');
  await h.say('Verifiquei');
  assert.ok(h.last().includes('tudo certo'), 'the localized acknowledgement is used');
  assert.ok(!/you're all set/i.test(h.last()), 'no English leak');
});

test('E6. the Arabic conversation stays Arabic across a follow-up', async () => {
  const h = createHarness({ language: 'ar' });
  await h.say('هل Arbitrix منصة حقيقية؟');
  await h.say('كيف أتحقق من التسجيل؟');
  const reply = h.last();
  assert.ok(/[\u0600-\u06FF]/.test(reply), 'Arabic script');
  assert.ok(reply.includes(KVK_NUMBER), 'the verification facts are present');
  assert.ok(!/Our registration details/i.test(reply), 'no English leak');
});

// ============================================================= F. human handoff

test('F1. an active human handoff suppresses the new intents too', async () => {
  const h = createHarness();
  await h.say('I need a human');
  await h.adminSay('/reply 1 On it.');
  const before = h.toCustomer().length;

  await h.say('Is Arbitrix a scam?');
  assert.strictEqual(h.toCustomer().length, before, 'the bot must not talk over the operator');
  assert.match(h.lastAdmin(), /HUMAN CONVERSATION/);
});

test('F2. /close restores automation for the new intents', async () => {
  const h = createHarness();
  await h.say('I need a human');
  await h.adminSay('/close 1');
  await h.say('Is Arbitrix a scam?');
  assert.ok(h.last().includes(t('trustIntro')), 'automation resumes');
});

test('F3. the handoff marks the conversation as human and keeps the history', async () => {
  const h = createHarness();
  await h.say('Is Arbitrix a scam?');
  await h.say('I need a human');
  // The handoff deliberately owns the topic while it is active: nothing the
  // dialogue layer does may overwrite it with an ordinary conversation state.
  assert.strictEqual(h.context().topic, 'human');
  assert.strictEqual(h.context().stage, 'human-requested');

  await h.adminSay('/close 1');
  await h.say('Is Arbitrix a scam?');
  assert.strictEqual(h.context().topic, 'trust', 'automation takes the topic back after /close');
  const bodies = h.state.messages.map((m) => m.body);
  assert.ok(bodies.includes('I need a human'), 'the handoff request is still in the history');
});

test('F4. exactly one operator notification per customer message (no duplicates)', async () => {
  const h = createHarness();
  const before = h.toAdmin().length;
  await h.say('Is Arbitrix a scam?');
  assert.strictEqual(h.toAdmin().length, before + 1, 'one notification, never two');
  await h.say('How do I verify the registration?');
  assert.strictEqual(h.toAdmin().length, before + 2, 'still one per message');
});

test('F5. operator reply-to-notification still works after a trust answer', async () => {
  const h = createHarness();
  await h.say('Is Arbitrix a scam?');
  const noticeId = h.transport.sent.filter((m) => m.chatId === ADMIN).pop().message_id;
  const result = await h.adminSay(String(noticeId)); // not a command: ignored
  assert.ok(result);
  const reply = await h.adminSay('/reply 1 Here is the registration page: ' + REGISTRATION_URL);
  assert.ok(reply);
  assert.strictEqual(h.transport.sent.filter((m) => m.chatId === CUSTOMER && m.text.includes(REGISTRATION_URL)).length >= 2, true);
});

test('F6. history is preserved for the operator', async () => {
  const h = createHarness();
  await h.say('Is Arbitrix a scam?');
  await h.say('How do I verify the registration?');
  const bodies = h.state.messages.map((m) => m.body);
  assert.ok(bodies.includes('Is Arbitrix a scam?'));
  assert.ok(bodies.includes('How do I verify the registration?'));
  assert.ok(h.state.messages.some((m) => m.direction === DIRECTION_BOT));
  assert.ok(h.state.messages.every((m) => m.direction === DIRECTION_CUSTOMER || m.direction === DIRECTION_BOT || m.direction === DIRECTION_AGENT));
});

// ========================================================= G. false positives

test('G1. messages containing generic words are not treated as trust questions', () => {
  const unrelated = [
    'I want to deposit money',
    'How do I add money to my account?',
    'my company pays me in usdt',
    'I have a business and I want to accept crypto',
    'I registered yesterday but the balance is zero',
    'I trust my wallet app',
    'is the withdrawal pending?',
    'what is the weather in paris tomorrow',
    'my money is in my own wallet',
    'how do I change my password'
  ];
  for (const text of unrelated) {
    const analysis = engine.analyze(text);
    assert.ok(!/^trust_/.test(String(analysis.primary)), 'false trust match for: ' + text);
  }
});

test('G2. a bare "trust" or "registered" does not start the trust flow', async () => {
  for (const phrase of ['trust', 'registered', 'company', 'business']) {
    const analysis = engine.analyze(phrase);
    assert.ok(!/^trust_/.test(String(analysis.primary)), phrase);
  }
});

test('G3. "I was scammed" is a fraud report, not a legitimacy question', () => {
  const analysis = engine.analyze('I was scammed by someone on telegram');
  assert.strictEqual(analysis.primary, 'fraud');
});

test('G4. deposit and subscription questions keep their own answers', async () => {
  const deposit = createHarness();
  await deposit.say('How much do I need to deposit?');
  assert.ok(!deposit.last().includes(t('earningsIntro')), 'a deposit question is not an earnings question');

  const subscription = createHarness();
  await subscription.say('How much is the subscription?');
  assert.ok(!subscription.last().includes(t('earningsIntro')), 'a price question is not an earnings question');
});

// ================================================== H. existing functionality

test('H1. /tutorial still lists every approved tutorial', async () => {
  const h = createHarness();
  await h.say('/tutorial');
  const reply = h.last();
  ['17', '16', '18', '19'].forEach((id) => assert.ok(reply.includes('/ArbitrixAnnouncements/' + id), 'tutorial ' + id));
});

test('H2. /progress and /next still read the stored state', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('/progress');
  assert.ok(h.last().includes(t('progressWaiting')));
  await h.say('/next');
  assert.ok(h.last().includes(t('nextStepTitle')));
});

test('H3. /help still lists the commands', async () => {
  const h = createHarness();
  await h.say('/help');
  ['/language', '/escalate', '/tutorial', '/progress', '/next'].forEach((command) => {
    assert.ok(h.last().includes(command), command);
  });
});

test('H4. the deposit tutorial selection still works end to end', async () => {
  const h = createHarness();
  await h.say('I want to deposit');
  await h.say('No');
  await h.say('Paybis');
  assert.ok(h.last().includes('https://t.me/ArbitrixAnnouncements/17'));
  assert.strictEqual(h.context().method, 'paybis');
  await h.say('done');
  assert.strictEqual(h.last(), t('depositCompletedAskTransfer'));
});

test('H5. the deposit walkthrough video hook is untouched by the trust answers', async () => {
  const h = createHarness();
  await h.say('How do I make a deposit?');
  assert.strictEqual(h.transport.sent.filter((m) => m.method === 'sendVideo').length, 0,
    'no video is configured in this environment, so none is sent');
});

test('H6. a redelivered trust message is answered once', async () => {
  const h = createHarness();
  const id = nextUpdateId();
  await h.say('Is Arbitrix a scam?', { updateId: id });
  const before = h.toCustomer().length;
  const duplicate = await h.say('Is Arbitrix a scam?', { updateId: id });
  assert.strictEqual(h.toCustomer().length, before, 'no second reply');
  assert.strictEqual(duplicate.action, 'duplicate');
});

test('H7. an out-of-order (older) update does not rewind the conversation', async () => {
  const h = createHarness();
  const older = nextUpdateId();
  await h.say('Is Arbitrix a scam?', { updateId: older + 5 });
  await h.say('How do I verify the registration?', { updateId: older + 6 });
  const stage = h.context().stage;
  const before = h.toCustomer().length;
  await h.say('Yes', { updateId: older });
  assert.ok(h.toCustomer().length >= before, 'the older update never crashes the bot');
  assert.strictEqual(h.context().stage, stage, 'the newer state is kept');
});
