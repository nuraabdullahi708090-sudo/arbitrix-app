'use strict';

/**
 * Answer PROVENANCE: the fix for "customer selected Portugues, bot answered in
 * English".
 *
 * THE BUG
 *   The offline `knowledge` provider returns APPROVED ENGLISH answers in the shape
 *   `{ kind: 'answer', reason: null }`. `composeCustomerReply()` read that shape as
 *   "the model answered in the customer's language already", and the only hard
 *   language verification is the Arabic script check, so Portuguese customers were
 *   sent the English knowledge text verbatim.
 *
 * THE FIX PINNED HERE
 *   `SupportAIService` propagates explicit provenance on every outcome
 *   (`source: 'provider' | 'knowledge'`, `modelGenerated: boolean`) and the bot
 *   switches on `modelGenerated === true`. Only MODEL-written text is treated as
 *   already being in the customer's language; approved knowledge text always goes
 *   through the translation/localization path and falls back to the localized
 *   `uncertain` message when translation is unavailable.
 *
 * The default is the safe one: an outcome that does not explicitly claim provider
 * provenance is approved English.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createTelegramSupportBot } = require('../services/TelegramSupportService');
const i18n = require('../services/telegram-i18n');
const { createSupportAIService } = require('../services/support/SupportAIService');
const S = require('../services/support/SupportKnowledge');

const CUSTOMER_CHAT_ID = '555111';
const OVERVIEW_ID = 'what_is_arbitrix.overview';
const PT_QUESTION = 'Olá, como posso começar a usar a Arbitrix?';

const KB = S.readKnowledge();
const ENTRIES = S.flattenEntries(KB);
const ANSWER_BY_ID = (id) => {
  const entry = ENTRIES.find((e) => e.id === id);
  assert.ok(entry, 'the knowledge base must contain ' + id);
  return entry.answer;
};
// The exact text production leaked to the Portuguese customer.
const OVERVIEW_ANSWER = ANSWER_BY_ID(OVERVIEW_ID);
const GUARANTEE_ENTRY = ENTRIES.find((e) => e.id === 'guardrails.no_guarantee');

let updateSeq = 5000;

// ----------------------------------------------------------------- the harness

function createStore(initialLanguage = 'en') {
  const state = { conversations: [], messages: [], languageWrites: [] };
  const byChat = new Map();
  let id = 1;
  const row = {
    id: id++, telegram_chat_id: Number(CUSTOMER_CHAT_ID), telegram_user_id: Number(CUSTOMER_CHAT_ID),
    username: 'john', display_name: 'John', language: initialLanguage
  };
  state.conversations.push(row);
  byChat.set(CUSTOMER_CHAT_ID, row);
  return {
    state,
    conversation: row,
    async getConversationByChatId(chatId) { return byChat.get(String(chatId)) || null; },
    async getConversationById(v) { return state.conversations.find((c) => c.id === Number(v)) || null; },
    async upsertConversation({ chatId, username, displayName }) {
      const existing = byChat.get(String(chatId));
      if (existing) return { conversation: existing, created: false };
      const created = {
        id: id++, telegram_chat_id: Number(chatId), telegram_user_id: Number(chatId),
        username: username || null, display_name: displayName || null, language: 'en'
      };
      state.conversations.push(created);
      byChat.set(String(chatId), created);
      return { conversation: created, created: true };
    },
    async setConversationLanguage({ conversationId, language }) {
      const target = state.conversations.find((c) => c.id === Number(conversationId));
      if (!target) throw new Error('no conversation ' + conversationId);
      state.languageWrites.push({ conversationId: Number(conversationId), language });
      target.language = language;
      return target;
    },
    async insertMessage({ conversationId, direction, body }) {
      const message = { id: state.messages.length + 1, conversation_id: conversationId, direction, body };
      state.messages.push(message);
      return { message };
    },
    async getLatestMessageByConversation() { return null; },
    async createEscalation() { return { id: 1 }; },
    async setConversationStatus() { return true; },
    async probeColumns() { return true; }
  };
}

function createTransport() {
  const calls = [];
  return {
    calls,
    sentTo(chatId) {
      return calls.filter((c) => c.method === 'sendMessage' && String(c.chatId) === String(chatId)).map((c) => c.text);
    },
    async sendMessage(chatId, text, options) {
      calls.push({ method: 'sendMessage', chatId, text, options });
      return { ok: true, result: { message_id: calls.length } };
    },
    async answerCallbackQuery(id, text) { calls.push({ method: 'answerCallbackQuery', id, text }); return { ok: true, result: true }; },
    async getWebhookInfo() { return { ok: true, result: {} }; },
    async setWebhook() { return { ok: true, result: true }; },
    async getLastCall() { return null; }
  };
}

const from = { id: Number(CUSTOMER_CHAT_ID), is_bot: false, first_name: 'John', username: 'john' };
const chat = { id: Number(CUSTOMER_CHAT_ID), type: 'private', username: 'john' };

function textUpdate(text) {
  return { update_id: ++updateSeq, message: { message_id: ++updateSeq, from, chat, date: 1, text } };
}

function callbackUpdate(data) {
  return {
    update_id: ++updateSeq,
    callback_query: {
      id: String(updateSeq), from, chat_instance: 'x', data,
      message: { message_id: ++updateSeq, from: { id: 777, is_bot: true }, chat, date: 1 }
    }
  };
}

function buildBot({ ai = null, translator = null, language = 'en' } = {}) {
  const store = createStore(language);
  const transport = createTransport();
  const bot = createTelegramSupportBot({
    config: { adminIds: [], notifyTarget: 'admins', supportChatId: null },
    store,
    transport,
    logger: { log() {}, warn() {}, error() {} },
    supportAI: ai,
    translator
  });
  return { bot, store, transport, replies: () => transport.sentTo(CUSTOMER_CHAT_ID) };
}

/** A real SupportAIService with the DEFAULT (offline `knowledge`) provider. */
const knowledgeAI = () => createSupportAIService({ env: { AI_SUPPORT_ENABLED: 'true' } });

/** An injected HTTP-style provider: text it returns is MODEL-written. */
function modelProvider({ text, provider = 'deepseek', fail = false } = {}) {
  return {
    name: provider,
    kind: 'http',
    available: true,
    model: 'stub-model',
    async generate() {
      if (fail) throw new Error('provider unavailable');
      return { text, noAnswer: text === null, provider, model: 'stub-model' };
    }
  };
}

/** A translator that returns text in the target language. */
function translator() {
  return {
    async fromEnglish(text, language) {
      if (language === 'ar') return { ok: true, text: 'ترجمة: ' + text, reason: null };
      return { ok: true, text: 'Tradução: ' + text, reason: null };
    }
  };
}

// =================================================== 1. provenance (unit level)

test('P1. the knowledge provider returns APPROVED ENGLISH but marks it as knowledge', async () => {
  const ai = knowledgeAI();
  const outcome = await ai.ask(PT_QUESTION, { language: 'pt' });

  assert.strictEqual(ai.describe().provider, 'knowledge', 'the offline provider is the default');
  assert.strictEqual(outcome.kind, 'answer', 'it still looks like an answer...');
  assert.strictEqual(outcome.reason, null, '...and carries no provider-failure reason');
  assert.strictEqual(outcome.answer, OVERVIEW_ANSWER, 'the text is the approved English wording');
  assert.strictEqual(outcome.source, 'knowledge', 'provenance: approved knowledge, not a model answer');
  assert.strictEqual(outcome.modelGenerated, false, 'NOT model-generated');
  assert.strictEqual(outcome.language, 'pt', '`language` records what was REQUESTED');
});

test('P2. a model-written answer is marked as provider provenance', async () => {
  const ai = createSupportAIService({
    env: { AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'deepseek' },
    provider: modelProvider({ text: 'Claro! Você pode começar no Modo Demo.' })
  });
  const outcome = await ai.ask(PT_QUESTION, { language: 'pt' });

  assert.strictEqual(outcome.kind, 'answer');
  assert.strictEqual(outcome.reason, null, 'the kind/reason shape is IDENTICAL to the knowledge case');
  assert.strictEqual(outcome.source, 'provider');
  assert.strictEqual(outcome.modelGenerated, true);
});

test('P3. guardrail outcomes are approved knowledge, never model-generated', async () => {
  const ai = knowledgeAI();
  const outcome = await ai.ask('Is the profit guaranteed?', { language: 'pt' });

  assert.strictEqual(outcome.kind, 'guardrail');
  assert.strictEqual(outcome.source, 'knowledge');
  assert.strictEqual(outcome.modelGenerated, false);
});

test('P4. an approved-text fallback after a provider failure is marked as knowledge', async () => {
  const ai = createSupportAIService({
    env: { AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'deepseek' },
    provider: modelProvider({ fail: true })
  });
  const outcome = await ai.ask(PT_QUESTION, { language: 'pt' });

  assert.strictEqual(outcome.reason, 'provider-fallback');
  assert.strictEqual(outcome.answer, OVERVIEW_ANSWER, 'the approved English text is used');
  assert.strictEqual(outcome.source, 'knowledge');
  assert.strictEqual(outcome.modelGenerated, false);
});

test('P5. a policy-filtered model answer reports the provenance of the text actually returned', async () => {
  const ai = createSupportAIService({
    env: { AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'deepseek' },
    // An invented amount the approved knowledge does not contain: the groundedness
    // filter replaces it with approved wording, so the provenance must follow the TEXT.
    provider: modelProvider({ text: 'The minimum deposit is $5,000.' })
  });
  const outcome = await ai.ask('What is the minimum deposit?', { language: 'pt' });

  assert.strictEqual(outcome.filtered, true, 'the provider text was withheld');
  assert.notStrictEqual(outcome.answer, 'The minimum deposit is $5,000.');
  assert.strictEqual(outcome.source, 'knowledge', 'the replacement is approved text');
  assert.strictEqual(outcome.modelGenerated, false);
});

test('P6. provenance defaults are fail-safe and the knowledge provider is named explicitly', () => {
  const service = fs.readFileSync(path.join(ROOT, 'services', 'support', 'SupportAIService.js'), 'utf8');
  const resultHelper = service.slice(service.indexOf('const result = (over) =>'), service.indexOf('function logEvent'));
  assert.match(resultHelper, /source: 'knowledge'/, 'the default provenance is approved text');
  assert.match(resultHelper, /modelGenerated: false/, 'nothing is model-generated unless claimed');
  assert.match(service, /const KNOWLEDGE_PROVIDER_NAME = 'knowledge'/, 'the offline provider is identified ');
  assert.match(service, /!== KNOWLEDGE_PROVIDER_NAME/, 'the provider identity drives the provenance');
});

// ============================================== 2. the production bug (exact)

test('B1. PRODUCTION BUG: pt + knowledge + the what_is_arbitrix.overview answer', async () => {
  const ai = knowledgeAI();
  const h = buildBot({ ai, language: 'en' });

  // The customer selects Portugues, exactly as in production.
  await h.bot.handleUpdate(callbackUpdate('lang:pt'));
  assert.strictEqual(h.store.conversation.language, 'pt', 'the choice is persisted');

  await h.bot.handleUpdate(textUpdate(PT_QUESTION));
  const replies = h.replies();

  assert.match(replies[0], /Português/, 'the language confirmation is (still) localized');
  const answer = replies[replies.length - 1];
  assert.notStrictEqual(answer, OVERVIEW_ANSWER, 'THE BUG: the English knowledge answer must NEVER be sent');
  assert.ok(!answer.includes('Arbitrix is an automated arbitrage platform'), 'no English leak');
  assert.strictEqual(answer, i18n.t('pt', 'uncertain'), 'the localized Portuguese fallback is used');
  assert.strictEqual(h.bot.getStats().aiLanguageMisses, 1, 'the language miss is counted');
  assert.strictEqual(h.bot.getStats().aiReplies, 1, 'the AI layer did answer - it was the language that failed');
});

test('B2. English + a knowledge answer still receives the English answer verbatim', async () => {
  const ai = knowledgeAI();
  const h = buildBot({ ai, language: 'en' });
  await h.bot.handleUpdate(textUpdate(PT_QUESTION));

  assert.strictEqual(h.replies()[0], OVERVIEW_ANSWER, 'English behaviour is unchanged');
});

test('B3. pt + knowledge + NO translator -> the localized Portuguese fallback', async () => {
  const h = buildBot({ ai: knowledgeAI(), language: 'pt' });
  await h.bot.handleUpdate(textUpdate(PT_QUESTION));

  assert.strictEqual(h.replies()[0], i18n.t('pt', 'uncertain'));
  assert.strictEqual(h.bot.getStats().translationsFailed, 1, 'the reason is recorded as a translation miss');
});

test('B4. ar + knowledge + NO translator -> the localized Arabic fallback', async () => {
  const h = buildBot({ ai: knowledgeAI(), language: 'ar' });
  await h.bot.handleUpdate(textUpdate(PT_QUESTION));

  assert.strictEqual(h.replies()[0], i18n.t('ar', 'uncertain'));
});

test('B5. pt + knowledge + a translator -> the TRANSLATED Portuguese answer', async () => {
  const h = buildBot({ ai: knowledgeAI(), language: 'pt', translator: translator() });
  await h.bot.handleUpdate(textUpdate(PT_QUESTION));

  assert.strictEqual(h.replies()[0], 'Tradução: ' + OVERVIEW_ANSWER, 'the approved text was localized');
  assert.strictEqual(h.bot.getStats().translationsSucceeded, 1);
});

test('B6. ar + knowledge + a translator -> the TRANSLATED Arabic answer', async () => {
  const ai = knowledgeAI();
  // The SAME English question retrieves the same approved entry whatever the
  // customer's language is (retrieval is keyword-based), so the expected text is
  // taken from the service itself rather than guessed.
  const approved = (await ai.ask(PT_QUESTION, { language: 'ar' })).answer;
  assert.strictEqual(approved, OVERVIEW_ANSWER);

  const h = buildBot({ ai, language: 'ar', translator: translator() });
  await h.bot.handleUpdate(textUpdate(PT_QUESTION));

  assert.strictEqual(h.replies()[0], 'ترجمة: ' + approved);
});

// ============================================ 3. genuinely model-generated text

test('B7. a genuinely model-generated Portuguese answer is sent as Portuguese', async () => {
  const ai = createSupportAIService({
    env: { AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'deepseek' },
    provider: modelProvider({ text: 'Claro! Você pode começar no Modo Demo, com fundos virtuais.' })
  });
  const h = buildBot({ ai, language: 'pt' });
  await h.bot.handleUpdate(textUpdate(PT_QUESTION));

  assert.strictEqual(h.replies()[0], 'Claro! Você pode começar no Modo Demo, com fundos virtuais.');
  assert.strictEqual(h.bot.getStats().aiLanguageMisses, 0, 'no language miss');
});

test('B8. a genuinely model-generated Arabic answer (Arabic script) is sent as Arabic', async () => {
  const answer = 'يمكنك البدء في وضع العرض التجريبي باستخدام أموال افتراضية.';
  const ai = createSupportAIService({
    env: { AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'deepseek' },
    provider: modelProvider({ text: answer })
  });
  const h = buildBot({ ai, language: 'ar' });
  await h.bot.handleUpdate(textUpdate(PT_QUESTION));

  assert.strictEqual(h.replies()[0], answer);
});

test('B9. the Arabic script verification is KEPT: a model that answers in English is not sent', async () => {
  const ai = createSupportAIService({
    env: { AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'deepseek' },
    provider: modelProvider({ text: 'You can withdraw anytime.' })
  });
  const h = buildBot({ ai, language: 'ar' });
  await h.bot.handleUpdate(textUpdate(PT_QUESTION));

  assert.strictEqual(h.replies()[0], i18n.t('ar', 'uncertain'), 'the localized Arabic fallback is used');
  assert.strictEqual(h.bot.getStats().aiLanguageMisses, 1, 'the script miss is counted');
});

// ================================================= 4. guardrails are unchanged

test('B10. guardrail behaviour is unchanged for both English and Portuguese', async () => {
  const ai = knowledgeAI();
  const en = buildBot({ ai: knowledgeAI(), language: 'en' });
  await en.bot.handleUpdate(textUpdate('Is the profit guaranteed?'));
  assert.strictEqual(en.replies()[0], GUARANTEE_ENTRY.answer, 'English customers still get the approved text');

  const pt = buildBot({ ai, language: 'pt' });
  await pt.bot.handleUpdate(textUpdate('Is the profit guaranteed?'));
  assert.strictEqual(pt.replies()[0], i18n.t('pt', 'uncertain'), 'no English guardrail text leaks');
});

// ======================= 5. no knowledge answer can reach a non-English customer

test('B11. no approved English knowledge answer reaches a pt/ar customer, for any question', async () => {
  const questions = [
    PT_QUESTION,
    'What is the minimum deposit?',
    'How do withdrawals work?',
    'Is identity verification required?',
    'How does the referral program work?',
    'What happens if my deposit is not credited?',
    'How much does the subscription cost?',
    'مرحبا'
  ];
  const englishAnswers = ENTRIES.map((e) => e.answer).filter((a) => typeof a === 'string' && a.length >= 40);

  for (const language of ['pt', 'ar']) {
    const h = buildBot({ ai: knowledgeAI(), language });
    for (const question of questions) await h.bot.handleUpdate(textUpdate(question));
    const replies = h.replies();
    assert.strictEqual(replies.length, questions.length, 'every message was answered');
    replies.forEach((reply, index) => {
      assert.ok(!englishAnswers.some((english) => reply.includes(english)),
        'reply ' + index + ' (' + language + ') leaked English knowledge text: ' + reply.slice(0, 80));
      assert.ok(reply === i18n.t(language, 'uncertain') || reply === i18n.t(language, 'acknowledgement'),
        'reply ' + index + ' (' + language + ') must be one of the localized strings');
    });
  }
});

test('B12. the old kind/reason heuristic is gone and provenance is the switch', () => {
  const service = fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportService.js'), 'utf8');
  const composer = service.slice(service.indexOf('async function composeCustomerReply'), service.indexOf('async function translateForCustomer'));
  assert.match(composer, /outcome\.modelGenerated === true/, 'the switch is explicit provenance');
  assert.ok(!/outcome\.kind === 'answer' && outcome\.reason !== 'provider-fallback'/.test(composer),
    'the old heuristic must not come back');
  assert.match(composer, /hasExpectedScript\(answer, lang\)/, 'the Arabic script check is kept');
  // No heuristic Portuguese-vs-English detection was introduced anywhere.
  const guidelines = fs.readFileSync(path.join(ROOT, 'services', 'support', 'SupportGuidelines.js'), 'utf8');
  assert.ok(!/isPortuguese|hasPortuguese|portugueseMarkers|looksEnglish/i.test(composer + guidelines),
    'no heuristic language detection');
  // The approved-text path must still translate or fall back - never send English.
  assert.match(composer, /const localized = await translateForCustomer\(answer, lang\);/);
  assert.match(composer, /return tCustomer\(lang, 'uncertain'\);/);
});

test('B13. DOCUMENTED LIMITATION: a model that ignores the directive for pt is not detected (no heuristics)', async () => {
  const ai = createSupportAIService({
    env: { AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'deepseek' },
    provider: modelProvider({ text: 'You can withdraw anytime.' })
  });
  const h = buildBot({ ai, language: 'pt' });
  await h.bot.handleUpdate(textUpdate(PT_QUESTION));

  // English and Portuguese cannot be told apart without a dependency, so this is
  // sent as-is. Arabic (below) IS caught. Pinned so the behaviour is a known,
  // reviewed limitation rather than a surprise - configure an LLM/translation
  // provider whose output is in the requested language.
  assert.strictEqual(h.replies()[0], 'You can withdraw anytime.');
});
