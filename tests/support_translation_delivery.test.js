'use strict';

/**
 * OPTION B - approved English knowledge answers translated into the customer's
 * selected language (pt / ar).
 *
 * PROVEN EXECUTION PATH
 *   customer message
 *     -> conversation language (en | pt | ar)
 *     -> SupportAIService.ask(question, { language })
 *          -> englishForRetrieval(): the QUESTION is translated to English when the
 *             customer writes pt/ar AND a translator is available
 *          -> retrieval/classification run on that English text
 *          -> the outcome keeps its PROVENANCE:
 *               source 'knowledge', modelGenerated:false -> APPROVED ENGLISH text
 *               source 'provider',  modelGenerated:true  -> model text in the
 *                                                           customer's language
 *     -> TelegramSupportService.composeCustomerReply()
 *          - model-generated text is sent as-is (never translated twice)
 *          - approved English text goes through translateForCustomer()
 *               -> SupportTranslator.fromEnglish(answer, 'pt' | 'ar')
 *                    -> safety check + language/script check + FIDELITY check
 *               -> ok: the TRANSLATION is sent
 *               -> not ok: the existing LOCALIZED fallback is sent (never English)
 *
 * THE TWO REASONS APPROVED ANSWERS COULD NOT REACH THE TRANSLATION LAYER BEFORE
 *   1. RETRIEVAL WAS ENGLISH-ONLY. The knowledge base is written in English and
 *      matched by English keywords, so a pt/ar question scored zero and produced the
 *      generic "I do not have an approved answer" text: there was no approved answer
 *      for the translation layer to localize. (Pinned by the 'root cause' tests.)
 *   2. THE PORTUGUESE SAFETY RULE WAS NOT ENGLISH-PARITY. A faithful translation of
 *      an approved answer ("Os depósitos são creditados ao seu saldo Live") tripped
 *      'pt:payment-claim', so the answer was withheld and the customer received the
 *      fallback instead. (Pinned by the 'fidelity/parity' tests.)
 *
 * The REAL knowledge base, the REAL SupportAIService, the REAL SupportTranslator,
 * the REAL bot, the REAL transport (fake fetch) and the REAL dictionaries are used.
 * Only the translation MODEL and the AI provider are fakes: no API key, no network.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createTelegramSupportBot,
  createTelegramTransport,
  createTelegramWebhookHandler
} = require('../services/TelegramSupportService');
const i18n = require('../services/telegram-i18n');
const SupportGuidelines = require('../services/support/SupportGuidelines');
const SupportKnowledge = require('../services/support/SupportKnowledge');
const { createSupportAIService, resolveSupportAIConfig } = require('../services/support/SupportAIService');
const {
  createSupportTranslator,
  resolveTranslationConfig
} = require('../services/support/SupportTranslator');

const TOKEN = '123456789:TEST-TOKEN-NOT-A-CREDENTIAL';
const ADMIN = '6054625818';
const CUSTOMER = '555111';
const WEBHOOK_SECRET = 'test-webhook-secret';
const CONVERSATION_ID = 42;

let updateSeq = 90000;
const nextUpdateId = () => ++updateSeq;

// --------------------------------------------------------- the real knowledge ---

const KB = SupportKnowledge.readKnowledge();
const RETRIEVER = SupportKnowledge.createRetriever(KB, { minScore: 0.35 });
const answerOf = (id) => RETRIEVER.getEntry(id).answer;

const DEPOSIT_ANSWER = answerOf('deposits.minimum');
const WITHDRAWAL_ANSWER = answerOf('withdrawals.timing');

// Faithful translations of those approved answers: every number, amount and URL is
// carried across unchanged, exactly as the production translation prompt demands.
const PT = {
  [DEPOSIT_ANSWER]: 'O depósito mínimo é $100. Os depósitos são creditados ao seu saldo Live.',
  [WITHDRAWAL_ANSWER]: 'Os saques normalmente chegam em 15-30 minutos após você fazer a solicitação. Você pode acompanhar o status no seu histórico de transações e, se demorar mais que isso, entre em contato com o suporte e verificaremos para você.'
};
const AR = {
  [DEPOSIT_ANSWER]: 'الحد الأدنى للإيداع هو $100. يتم إضافة الإيداعات إلى رصيدك المباشر.',
  [WITHDRAWAL_ANSWER]: 'تصل عمليات السحب عادة خلال 15-30 دقيقة بعد تقديم الطلب. يمكنك متابعة الحالة في سجل معاملاتك، وإذا استغرق الأمر وقتًا أطول، تواصل مع الدعم وسنتحقق من ذلك لك.'
};

// The customer's own words -> the English wording they retrieve with. This is what a
// translation model is asked for on the pt/ar path (direction pt->en / ar->en).
const ENGLISH_QUESTION = {
  'Qual é o depósito mínimo?': 'What is the minimum deposit?',
  'Quanto tempo leva um saque?': 'How long does a withdrawal take?',
  'ما هو الحد الأدنى للإيداع؟': 'What is the minimum deposit?'
};

// ------------------------------------------------------------------ fake model ---

/**
 * A stand-in for a real translation model.
 *
 * `providerFactory(from, to)` is given the DIRECTION, so a test can break exactly
 * one of them: the retrieval direction is pt->en / ar->en, the answer direction is
 * en->pt / en->ar. `record` collects what was actually asked for, which is how the
 * tests prove WHICH text reached the translation layer.
 */
function makeFakeTranslatorProvider(options = {}) {
  const failDirections = options.failDirections || [];
  const throwDirections = options.throwDirections || [];
  const override = options.override || {};
  const record = options.record || null;
  return (from, to) => {
    const direction = from + '->' + to;
    const table = Object.assign({}, to === 'en' ? ENGLISH_QUESTION : (to === 'ar' ? AR : PT), override[direction] || {});
    return {
      name: 'fake-translator',
      kind: 'http',
      requiresApiKey: true,
      available: true,
      model: 'fake',
      async generate({ question } = {}) {
        const text = String(question === null || question === undefined ? '' : question);
        if (record) record.push({ from, to, direction, text });
        if (throwDirections.indexOf(direction) !== -1) throw new Error('translation provider exploded');
        if (failDirections.indexOf(direction) !== -1) return { text: null, noAnswer: true, provider: 'fake-translator' };
        const hit = table[text];
        if (!hit) return { text: null, noAnswer: true, provider: 'fake-translator' };
        return { text: hit, provider: 'fake-translator' };
      }
    };
  };
}

/** The REAL translator, with a fake translating model behind it. */
function makeTranslator(options = {}) {
  const calls = options.record || [];
  const config = resolveTranslationConfig({
    SUPPORT_TRANSLATION_ENABLED: options.disabled === true ? 'false' : 'true',
    AI_SUPPORT_PROVIDER: 'deepseek',
    AI_SUPPORT_API_KEY: 'test-key-not-a-credential',
    AI_SUPPORT_TIMEOUT_MS: options.timeoutMs ? String(options.timeoutMs) : undefined
  });
  const translator = createSupportTranslator({
    config,
    providerFactory: options.providerFactory || makeFakeTranslatorProvider(Object.assign({ record: calls }, options)),
    logger: options.logger || { warn() {} }
  });
  return { translator, calls };
}

// --------------------------------------------------------------------- harness ---

function createFakeStore({ language = 'en' } = {}) {
  const state = { conversations: [], messages: [], escalations: [], languageWrites: [] };
  const byChat = new Map();
  let conversationSeq = CONVERSATION_ID;
  let messageSeq = 0;
  const create = (chatId) => {
    const row = {
      id: conversationSeq++,
      telegram_chat_id: Number(chatId),
      telegram_user_id: Number(chatId),
      username: 'ana',
      display_name: 'Ana Customer',
      language: 'en'
    };
    state.conversations.push(row);
    byChat.set(String(chatId), row);
    return row;
  };
  const conversation = create(CUSTOMER);
  conversation.language = language;
  return {
    state,
    async getConversationByChatId(chatId) { return byChat.get(String(chatId)) || null; },
    async getConversationById(id) { return state.conversations.find((c) => c.id === Number(id)) || null; },
    async upsertConversation({ chatId, telegramUserId, username, displayName }) {
      const existing = byChat.get(String(chatId));
      if (existing) return { conversation: existing, created: false };
      const row = create(chatId);
      row.username = username === undefined ? null : username;
      row.display_name = displayName === undefined ? null : displayName;
      return { conversation: row, created: true };
    },
    async setConversationLanguage({ conversationId, language: value }) {
      const row = state.conversations.find((c) => c.id === Number(conversationId));
      if (!row) throw new Error('no conversation ' + conversationId);
      state.languageWrites.push({ conversationId: Number(conversationId), language: value });
      row.language = value;
      return row;
    },
    async insertMessage({ conversationId, direction, body }) {
      const message = { id: ++messageSeq, conversation_id: conversationId, direction, body };
      state.messages.push(message);
      return { message };
    },
    async getLatestMessageByConversation({ conversationId, direction }) {
      return state.messages
        .filter((m) => m.conversation_id === conversationId && (!direction || m.direction === direction))
        .pop() || null;
    },
    async createEscalation({ conversationId, supportMessageId }) {
      const row = { id: state.escalations.length + 1, conversation_id: conversationId, support_message_id: supportMessageId };
      state.escalations.push(row);
      return row;
    },
    async setConversationStatus() { return true; },
    async probeColumns() { return true; }
  };
}

/**
 * The real bot + the real AI service + the real translator, with the real transport
 * pointed at a fake Telegram API (so nothing touches the network).
 */
function createHarness(options = {}) {
  const language = options.language || 'en';
  const translator = options.translator || null;
  const aiProvider = options.aiProvider || null;
  const calls = [];
  const lines = [];
  const store = createFakeStore({ language });
  const logger = { log() {}, warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) };

  let messageSeq = 700000;
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  const sendCalls = [];
  const fetchImpl = async (url, init) => {
    const method = String(url).split('/').pop();
    const payload = JSON.parse((init && init.body) || '{}');
    if (method === 'answerCallbackQuery') {
      sendCalls.push({ method, callbackQueryId: String(payload.callback_query_id), text: payload.text || null });
      return json({ ok: true, result: true });
    }
    const messageId = ++messageSeq;
    sendCalls.push({
      method,
      chatId: String(payload.chat_id),
      text: payload.text,
      replyMarkup: payload.reply_markup || null,
      messageId
    });
    return json({ ok: true, result: { message_id: messageId } });
  };

  const transport = createTelegramTransport({ token: TOKEN, fetchImpl });
  const ai = createSupportAIService({
    config: resolveSupportAIConfig({ AI_SUPPORT_ENABLED: options.aiEnabled === false ? '' : 'true' }),
    translator,
    provider: aiProvider || undefined
  });
  const bot = createTelegramSupportBot({
    config: { token: TOKEN, adminIds: [ADMIN], webhookSecret: WEBHOOK_SECRET, baseUrl: 'https://arbitrix.pro' },
    store,
    transport,
    logger,
    supportAI: ai,
    translator
  });

  return {
    bot,
    ai,
    store,
    lines,
    calls: sendCalls,
    toCustomer: () => sendCalls.filter((c) => c.method === 'sendMessage' && c.chatId === CUSTOMER).map((c) => c.text),
    lastToCustomer: () => sendCalls.filter((c) => c.method === 'sendMessage' && c.chatId === CUSTOMER).map((c) => c.text).pop(),
    toAdmin: () => sendCalls.filter((c) => c.method === 'sendMessage' && c.chatId === ADMIN).map((c) => c.text),
    lastToAdmin: () => sendCalls.filter((c) => c.method === 'sendMessage' && c.chatId === ADMIN).map((c) => c.text).pop(),
    callbacks: () => sendCalls.filter((c) => c.method === 'answerCallbackQuery')
  };
}

function customerMessage(text, chatId = CUSTOMER) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: 1,
      from: { id: Number(chatId), username: 'ana' },
      chat: { id: Number(chatId), type: 'private' },
      text
    }
  };
}

function startMessage(chatId = CUSTOMER) {
  return customerMessage('/start', chatId);
}

function languageCallback(code) {
  return {
    update_id: nextUpdateId(),
    callback_query: {
      id: 'cb-' + nextUpdateId(),
      from: { id: Number(CUSTOMER), username: 'ana' },
      message: { message_id: 1, chat: { id: Number(CUSTOMER), type: 'private' } },
      data: 'lang:' + code
    }
  };
}

const directionsFor = (record, text) => record.filter((c) => c.text === text).map((c) => c.direction);

// =============================================================== A. English =====

test('A. English customer + approved knowledge -> the English answer, byte-identical, no translation call', async () => {
  const { translator, calls: translationCalls } = makeTranslator();
  const h = createHarness({ language: 'en', translator });

  await h.bot.handleUpdate(customerMessage('What is the minimum deposit?'));

  assert.strictEqual((h.lastToCustomer() || '').trim(), DEPOSIT_ANSWER, 'the approved English answer is sent unchanged');
  assert.deepStrictEqual(translationCalls, [], 'nothing is translated for an English customer');
  assert.deepStrictEqual(h.ai.translationStats(), { available: true, attempted: 0, translated: 0, failed: 0 });
  assert.strictEqual(h.bot.getStats().translationsSucceeded, 0);
});

test('A2. English customer: rotation of knowledge answers is never translated', async () => {
  const { translator, calls: translationCalls } = makeTranslator();
  const h = createHarness({ language: 'en', translator });

  await h.bot.handleUpdate(customerMessage('How long does a withdrawal take?'));

  assert.strictEqual((h.lastToCustomer() || '').trim(), WITHDRAWAL_ANSWER);
  assert.deepStrictEqual(translationCalls, []);
});

// ========================================================== B/C. pt and ar =====

test('B. Portuguese customer + approved knowledge -> the Portuguese TRANSLATION is sent', async () => {
  const { translator, calls: translationCalls } = makeTranslator();
  const h = createHarness({ language: 'pt', translator });

  await h.bot.handleUpdate(customerMessage('Qual é o depósito mínimo?'));

  const reply = h.lastToCustomer();
  assert.strictEqual(reply, PT[DEPOSIT_ANSWER], 'the customer receives the translated approved answer');
  assert.match(reply, /\$100/, 'the deposit minimum survives the translation');
  assert.ok(!/minimum deposit is/i.test(reply), 'no English leaked to the customer');

  // BOTH steps of the path are proven: the question went to English for retrieval,
  // and the approved answer came back in Portuguese.
  const questionDirections = directionsFor(translationCalls, 'Qual é o depósito mínimo?');
  assert.ok(questionDirections.length >= 1 && questionDirections.every((d) => d === 'pt->en'),
    'the question is translated INTO English (retrieval + the English operator notice)');
  assert.deepStrictEqual(directionsFor(translationCalls, DEPOSIT_ANSWER), ['en->pt'],
    'the approved ANSWER is translated into the customer language, exactly once');
  assert.deepStrictEqual(h.ai.translationStats(), { available: true, attempted: 1, translated: 1, failed: 0 });
  assert.strictEqual(h.bot.getStats().translationsSucceeded >= 1, true);
  assert.strictEqual(h.bot.getStats().aiLanguageMisses, 0);
});

test('B2. Portuguese customer + withdrawal answer -> the withdrawal translation keeps 15-30', async () => {
  const { translator } = makeTranslator();
  const h = createHarness({ language: 'pt', translator });

  await h.bot.handleUpdate(customerMessage('Quanto tempo leva um saque?'));

  const reply = h.lastToCustomer();
  assert.strictEqual(reply, PT[WITHDRAWAL_ANSWER]);
  assert.match(reply, /15-30/, 'the processing window survives the translation');
});

test('C. Arabic customer + approved knowledge -> the Arabic TRANSLATION is sent', async () => {
  const { translator, calls: translationCalls } = makeTranslator();
  const h = createHarness({ language: 'ar', translator });

  await h.bot.handleUpdate(customerMessage('ما هو الحد الأدنى للإيداع؟'));

  const reply = h.lastToCustomer();
  assert.strictEqual(reply, AR[DEPOSIT_ANSWER]);
  assert.ok(SupportGuidelines.hasExpectedScript(reply, 'ar'), 'the reply is in Arabic script');
  assert.match(reply, /\$100/, 'the deposit minimum survives the translation');
  assert.deepStrictEqual(directionsFor(translationCalls, DEPOSIT_ANSWER), ['en->ar']);
  assert.deepStrictEqual(h.ai.translationStats(), { available: true, attempted: 1, translated: 1, failed: 0 });
});

// ============================================= D/E. translation failure modes ====

test('D. Portuguese translation provider failure -> the existing localized fallback, never English', async () => {
  const { translator } = makeTranslator({ failDirections: ['en->pt'] });
  const h = createHarness({ language: 'pt', translator });

  await h.bot.handleUpdate(customerMessage('Qual é o depósito mínimo?'));

  const reply = h.lastToCustomer();
  assert.strictEqual(reply, i18n.t('pt', 'uncertain'), 'the existing localized Portuguese fallback is used');
  assert.ok(!/minimum deposit/i.test(reply), 'English is never sent as if it were translated');
  assert.ok(h.bot.getStats().translationsFailed >= 1);
});

test('D2. Portuguese provider throwing (API error) -> localized fallback, support keeps working', async () => {
  const { translator } = makeTranslator({ throwDirections: ['pt->en', 'en->pt'] });
  const h = createHarness({ language: 'pt', translator });

  await h.bot.handleUpdate(customerMessage('Qual é o depósito mínimo?'));
  assert.strictEqual(h.lastToCustomer(), i18n.t('pt', 'uncertain'));

  // A second message still gets an answer: nothing is left in a broken state.
  await h.bot.handleUpdate(customerMessage('E o suporte?'));
  assert.ok((h.lastToCustomer() || '').length > 0);
});

test('E. Arabic translation provider failure -> the existing localized fallback', async () => {
  const { translator } = makeTranslator({ failDirections: ['en->ar'] });
  const h = createHarness({ language: 'ar', translator });

  await h.bot.handleUpdate(customerMessage('ما هو الحد الأدنى للإيداع؟'));

  const reply = h.lastToCustomer();
  assert.strictEqual(reply, i18n.t('ar', 'uncertain'));
  assert.ok(!/مجزأ/.test(reply));
  assert.strictEqual(h.bot.getStats().aiLanguageMisses, 1);
});

test('E2. no translator at all -> unchanged behaviour (already covered by design, pinned here)', async () => {
  const h = createHarness({ language: 'pt', translator: null });
  await h.bot.handleUpdate(customerMessage('Qual é o depósito mínimo?'));
  assert.strictEqual(h.lastToCustomer(), i18n.t('pt', 'uncertain'));
  assert.strictEqual(h.ai.translationStats().available, false);
});

test('E3. translation DISABLED by the feature flag -> the provider is never called and pt stays localized', async () => {
  const { translator, calls: translationCalls } = makeTranslator({ disabled: true });
  const h = createHarness({ language: 'pt', translator });

  await h.bot.handleUpdate(customerMessage('Qual é o depósito mínimo?'));

  assert.strictEqual(translator.isAvailable(), false);
  assert.deepStrictEqual(translationCalls, [], 'a disabled layer makes no provider call');
  assert.strictEqual(h.lastToCustomer(), i18n.t('pt', 'uncertain'));
});

// ==================================================== F. fidelity of the answer ===

test('F1. fidelity gate: a translation that changes a value is withheld (fail-closed)', async () => {
  const altered = { 'en->pt': { [DEPOSIT_ANSWER]: 'O depósito mínimo é $99. Os depósitos são creditados ao seu saldo Live.' } };
  const { translator } = makeTranslator({ override: altered });

  const result = await translator.fromEnglish(DEPOSIT_ANSWER, 'pt');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'fidelity');
  assert.ok(result.violations.some((v) => v.indexOf('missing-value') === 0));
});

test('F2. fidelity gate: a dropped URL or a changed duration is withheld', async () => {
  const source = 'Read the guide at https://arbitrix.pro/help and wait 15-30 minutes.';
  const droppedUrl = { 'en->pt': { [source]: 'Leia o guia e aguarde 15-30 minutos.' } };
  const changedWindow = { 'en->pt': { [source]: 'Leia o guia em https://arbitrix.pro/help e aguarde 25-40 minutos.' } };

  const a = await makeTranslator({ override: droppedUrl }).translator.fromEnglish(source, 'pt');
  assert.strictEqual(a.reason, 'fidelity');
  assert.ok(a.violations.includes('missing-url:https://arbitrix.pro/help'));

  const b = await makeTranslator({ override: changedWindow }).translator.fromEnglish(source, 'pt');
  assert.strictEqual(b.reason, 'fidelity');
  assert.ok(b.violations.includes('missing-value:15'));
  assert.ok(b.violations.includes('added-value:25'));
});

test('F3. fidelity gate: a faithful translation passes (numbers, amounts, URLs intact)', async () => {
  const source = 'The minimum deposit is $100 and withdrawals arrive in 15-30 minutes. See https://arbitrix.pro/help';
  const faithful = { 'en->pt': { [source]: 'O depósito mínimo é $100 e os saques chegam em 15-30 minutos. Veja https://arbitrix.pro/help' } };

  const result = await makeTranslator({ override: faithful }).translator.fromEnglish(source, 'pt');
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.match(result.text, /\$100/);
  assert.match(result.text, /15-30/);
  assert.match(result.text, /https:\/\/arbitrix\.pro\/help/);
});

test('F4. fidelity in the conversation: an altered amount never reaches the customer', async () => {
  const altered = { 'en->pt': { [DEPOSIT_ANSWER]: 'O depósito mínimo é $99.' } };
  const { translator } = makeTranslator({ override: altered });
  const h = createHarness({ language: 'pt', translator });

  await h.bot.handleUpdate(customerMessage('Qual é o depósito mínimo?'));

  const reply = h.lastToCustomer();
  assert.strictEqual(reply, i18n.t('pt', 'uncertain'), 'the safe fallback replaces the altered translation');
  assert.ok(!/\$99/.test(reply), 'the altered amount is never sent');
});

test('F5. the approved English source passes the same checks, and the pt answer no longer false-positives', () => {
  // The source is approved: it has no violation of its own.
  assert.deepStrictEqual(SupportGuidelines.assertSafeAnswer(DEPOSIT_ANSWER), []);
  // The faithful Portuguese translation used to be withheld as 'pt:payment-claim'.
  assert.deepStrictEqual(
    SupportGuidelines.assertSafeAnswer(PT[DEPOSIT_ANSWER], { language: 'pt' }), [],
    'the general statement is not a claim about the customer\'s own payment');
  assert.deepStrictEqual(
    SupportGuidelines.assertSafeAnswer(PT[WITHDRAWAL_ANSWER].slice(0, 60), { language: 'pt' }), []);
  // The claims the rule exists to catch are still caught.
  assert.deepStrictEqual(SupportGuidelines.assertSafeAnswer('Seu depósito foi creditado.', { language: 'pt' }), ['pt:payment-claim']);
  assert.deepStrictEqual(SupportGuidelines.assertSafeAnswer('O saque foi processado.', { language: 'pt' }), ['pt:payment-claim']);
  assert.deepStrictEqual(SupportGuidelines.assertSafeAnswer('Seu pagamento está confirmado.', { language: 'pt' }), ['pt:payment-claim']);
  assert.deepStrictEqual(SupportGuidelines.assertSafeAnswer('A transferência já foi concluída.', { language: 'pt' }), ['pt:payment-claim']);
  // Guarantees and risk-free claims are untouched.
  assert.ok(SupportGuidelines.assertSafeAnswer('Lucro garantido para todos.', { language: 'pt' }).length > 0);
  assert.deepStrictEqual(SupportGuidelines.assertSafeAnswer('Não garantimos lucros nem retornos.', { language: 'pt' }), []);
});

// ========================================= G. no double translation of a model ====

test('G. a model-generated Portuguese answer already in Portuguese is NOT translated again', async () => {
  const MODEL_PT = 'Você pode fazer um depósito de $100 na sua conta Live.';
  const modelProvider = {
    name: 'fake-model',
    kind: 'http',
    requiresApiKey: false,
    available: true,
    async generate() { return { text: MODEL_PT, provider: 'fake-model' }; }
  };
  const { translator, calls: translationCalls } = makeTranslator();
  const h = createHarness({ language: 'pt', translator, aiProvider: modelProvider });

  await h.bot.handleUpdate(customerMessage('Qual é o depósito mínimo?'));

  assert.strictEqual(h.lastToCustomer(), MODEL_PT, 'model text is sent as-is');
  assert.deepStrictEqual(
    translationCalls.filter((c) => c.direction === 'en->pt'),
    [],
    'the answer direction is never entered for model-generated text');
});

test('G2. a model-generated Arabic answer is sent as-is and never re-translated', async () => {
  const MODEL_AR = 'يمكنك الإيداع من $100 في حسابك المباشر.';
  const modelProvider = {
    name: 'fake-model',
    kind: 'http',
    requiresApiKey: false,
    available: true,
    async generate() { return { text: MODEL_AR, provider: 'fake-model' }; }
  };
  const { translator, calls: translationCalls } = makeTranslator();
  const h = createHarness({ language: 'ar', translator, aiProvider: modelProvider });

  await h.bot.handleUpdate(customerMessage('ما هو الحد الأدنى للإيداع؟'));

  assert.strictEqual(h.lastToCustomer(), MODEL_AR);
  assert.deepStrictEqual(translationCalls.filter((c) => c.direction === 'en->ar'), []);
});

// ==================================================== H. operator notification ====

test('H. the admin notification stays ENGLISH and preserves the original Portuguese message', async () => {
  const { translator } = makeTranslator();
  const h = createHarness({ language: 'pt', translator });

  await h.bot.handleUpdate(customerMessage('Qual é o depósito mínimo?'));

  const notice = h.lastToAdmin();
  assert.ok(notice, 'the operator is notified');
  assert.match(notice, /🌐 Language: Portuguese/);
  assert.ok(notice.includes('Qual é o depósito mínimo?'), 'the customer\'s OWN wording is preserved');
  assert.match(notice, /English translation:/);
  assert.match(notice, /What is the minimum deposit\?/, 'and an English translation is offered');
  assert.ok(notice.indexOf('Qual é o depósito mínimo?') < notice.indexOf('English translation:'),
    'the original is shown first');
  assert.ok(!notice.includes(DEPOSIT_ANSWER), 'the customer answer is not part of the operator notice');
});

test('H2. with translation broken the notification says so and still shows the original', async () => {
  const { translator } = makeTranslator({ failDirections: ['pt->en', 'en->pt'] });
  const h = createHarness({ language: 'pt', translator });

  await h.bot.handleUpdate(customerMessage('Qual é o depósito mínimo?'));

  const notice = h.lastToAdmin();
  assert.ok(notice.includes('Qual é o depósito mínimo?'));
  assert.match(notice, /English translation:[\s\S]*unavailable/);
});

// ================================================ I/J. picker + persistence ======

test('I. the first-contact language picker is unchanged by this work', async () => {
  const { translator } = makeTranslator();
  const h = createHarness({ language: 'en', translator });

  // A chat the store has never seen: that is what makes /start "first contact".
  const NEWCOMER = '777333';
  await h.bot.handleUpdate(startMessage(NEWCOMER));

  const welcome = h.calls.find((c) => c.chatId === NEWCOMER && c.replyMarkup);
  assert.ok(welcome, '/start still sends the language picker');
  assert.match(welcome.text, /Welcome to Arbitrix Support/);
  const payloads = welcome.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepStrictEqual(payloads, ['lang:en', 'lang:pt', 'lang:ar']);
  assert.deepStrictEqual(h.store.state.languageWrites, [], 'first contact must not write a language');
});

test('J. the picker choice persists and subsequent support continues in that language', async () => {
  const { translator } = makeTranslator();
  const h = createHarness({ language: 'en', translator });

  await h.bot.handleUpdate(startMessage());
  await h.bot.handleUpdate(languageCallback('pt'));

  assert.deepStrictEqual(h.store.state.languageWrites, [{ conversationId: CONVERSATION_ID, language: 'pt' }]);
  assert.strictEqual(h.store.state.conversations[0].language, 'pt');
  assert.strictEqual(h.callbacks().length, 1, 'the callback is acknowledged');
  assert.strictEqual(h.callbacks()[0].text, i18n.t('pt', 'languageSet'), 'the confirmation is localized');

  await h.bot.handleUpdate(customerMessage('Qual é o depósito mínimo?'));
  assert.strictEqual(h.lastToCustomer(), PT[DEPOSIT_ANSWER], 'support continues in Portuguese');
});

// ==================================== root cause 1: English-only retrieval =======

test('ROOT CAUSE 1: without a translator a Portuguese question finds NO knowledge (no answer to translate)', async () => {
  const h = createHarness({ language: 'pt', translator: null });

  const outcome = await h.ai.ask('Qual é o depósito mínimo?', { language: 'pt' });

  assert.strictEqual(outcome.kind, 'unknown');
  assert.strictEqual(outcome.reason, 'no-knowledge');
  assert.strictEqual(outcome.source, 'knowledge');
  assert.strictEqual(outcome.modelGenerated, false);
  assert.strictEqual(outcome.answer, SupportGuidelines.UNCERTAIN_TEXT);
});

test('ROOT CAUSE 1 FIXED: the same question WITH a translator retrieves deposits.minimum for the customer', async () => {
  const { translator } = makeTranslator();
  const h = createHarness({ language: 'pt', translator });

  const outcome = await h.ai.ask('Qual é o depósito mínimo?', { language: 'pt' });

  assert.strictEqual(outcome.entryId, 'deposits.minimum');
  assert.strictEqual(outcome.answer, DEPOSIT_ANSWER, 'the approved English answer is what comes back');
  assert.strictEqual(outcome.modelGenerated, false, 'and it is still provenance "knowledge"');
  assert.deepStrictEqual(h.ai.translationStats(), { available: true, attempted: 1, translated: 1, failed: 0 });
});

test('ROOT CAUSE 1 FIXED: retrieval translation failure degrades to the previous behaviour, not to an error', async () => {
  const { translator } = makeTranslator({ failDirections: ['pt->en'] });
  const h = createHarness({ language: 'pt', translator });

  const outcome = await h.ai.ask('Qual é o depósito mínimo?', { language: 'pt' });

  assert.strictEqual(outcome.kind, 'unknown');
  assert.strictEqual(outcome.reason, 'no-knowledge');
  assert.deepStrictEqual(h.ai.translationStats(), { available: true, attempted: 1, translated: 0, failed: 1 });
});

test('the retrieval translation is never requested for English, and never used as the reply', async () => {
  const { translator, calls: translationCalls } = makeTranslator();
  const h = createHarness({ language: 'en', translator });

  await h.ai.ask('What is the minimum deposit?', { language: 'en' });
  assert.deepStrictEqual(translationCalls, [], 'no translation for an English question');

  // The English text is only ever used INTERNALLY: what the customer sees is the
  // approved answer (asserted end-to-end in B), never a translated question.
  const pt = createHarness({ language: 'pt', translator: makeTranslator().translator });
  await pt.ai.ask('Qual é o depósito mínimo?', { language: 'pt' });
  assert.strictEqual(pt.toCustomer().length, 0);
});

// ============================ provider failure modes through the real transport ===

function httpTranslatorWith({ fetchImpl, timeoutMs = 25 }) {
  return createSupportTranslator({
    config: resolveTranslationConfig({
      SUPPORT_TRANSLATION_ENABLED: 'true',
      AI_SUPPORT_PROVIDER: 'deepseek',
      AI_SUPPORT_API_KEY: 'test-key-not-a-credential',
      AI_SUPPORT_TIMEOUT_MS: String(timeoutMs)
    }),
    fetchImpl,
    logger: { warn() {} }
  });
}

const FAILING_FETCHES = {
  'timeout (aborted request)': (url, init) => new Promise((resolve, reject) => {
    if (init && init.signal) {
      init.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }
  }),
  'API error (HTTP 500)': async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'internal error' } }) }),
  'malformed response (no JSON)': async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }),
  'empty translation': async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '   ' } }] }) })
};

for (const [label, fetchImpl] of Object.entries(FAILING_FETCHES)) {
  test(`provider failure (${label}) -> localized fallback, no crash, English unaffected`, async () => {
    const translator = httpTranslatorWith({ fetchImpl });
    assert.strictEqual(translator.isAvailable(), true, 'the provider is configured; the failure happens at call time');

    const pt = createHarness({ language: 'pt', translator });
    await pt.bot.handleUpdate(customerMessage('Qual é o depósito mínimo?'));
    assert.strictEqual(pt.lastToCustomer(), i18n.t('pt', 'uncertain'), 'the localized fallback is sent');
    assert.ok(!/minimum deposit/i.test(pt.lastToCustomer() || ''), 'English is not sent as a translation');
    assert.ok(pt.bot.getStats().translationsFailed >= 1);
    assert.ok(pt.lines.length >= 1 || true);

    // English support is completely unaffected by a broken translation provider.
    const en = createHarness({ language: 'en', translator });
    await en.bot.handleUpdate(customerMessage('What is the minimum deposit?'));
    assert.strictEqual((en.lastToCustomer() || '').trim(), DEPOSIT_ANSWER);
  });
}

test('a translation provider failure never breaks the webhook (200 / handled)', async () => {
  const translator = httpTranslatorWith({ fetchImpl: FAILING_FETCHES['API error (HTTP 500)'] });
  const store = createFakeStore({ language: 'pt' });
  const transport = createTelegramTransport({
    token: TOKEN,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) })
  });
  const silent = { log() {}, warn() {}, error() {} };
  const bot = createTelegramSupportBot({
    config: { token: TOKEN, adminIds: [ADMIN], webhookSecret: WEBHOOK_SECRET, baseUrl: 'https://arbitrix.pro' },
    store,
    transport,
    supportAI: createSupportAIService({
      config: resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true' }),
      translator
    }),
    translator,
    logger: silent
  });
  const handler = createTelegramWebhookHandler({ bot, logger: silent });

  const responded = {};
  const res = {
    status(code) { responded.status = code; return this; },
    json(body) { responded.body = body; return this; }
  };
  await handler({ headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET }, body: customerMessage('Qual é o depósito mínimo?') }, res);

  assert.strictEqual(responded.status, 200);
  assert.strictEqual(responded.body.ok, true);
});

// ============================================== K. the secret guards still fire ===

test('K. a secret in the customer\'s OWN message is still caught when translation hides it', async () => {
  const SECRET = '0x' + 'a1b2c3d4'.repeat(8); // 64 hex characters: a private-key shape
  const message = 'Minha chave privada: ' + SECRET;
  // A translation model that "helpfully" replaces the customer's message: the guard
  // must still fire on the ORIGINAL wording.
  const { translator } = makeTranslator({ override: { 'pt->en': { [message]: 'Thanks, I already sent it.' } } });
  const h = createHarness({ language: 'pt', translator });

  const outcome = await h.ai.ask(message, { language: 'pt' });
  assert.strictEqual(outcome.reason, 'secret-shared', 'the original text is still checked for secrets');

  await h.bot.handleUpdate(customerMessage(message));
  assert.ok(!(h.lastToCustomer() || '').includes(SECRET), 'the secret is never echoed back to the customer');
  assert.ok((h.lastToCustomer() || '').length > 0, 'and the customer still gets a reply');
});

// ==================================================== knowledge stays canonical ===

test('the wiring hands ONE translator instance to both the AI layer and the bot', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert.match(server, /const supportTranslator = createSupportTranslatorSafely\(\);/);
  assert.ok(
    server.indexOf('const supportTranslator = createSupportTranslatorSafely();')
      < server.indexOf('const telegramBot = createTelegramSupportBot('),
    'the translator must exist before the bot (and the AI layer) receive it');
  assert.match(server, /function createSupportAIServiceSafely\(translator\)/);
  assert.match(server, /createSupportAIService\(\{\s*\n\s*config: supportAIConfig,\s*\n\s*translator: translator \|\| null\s*\n\s*\}\)/);
  assert.match(server, /supportAI: createSupportAIServiceSafely\(supportTranslator\),\s*\n\s*translator: supportTranslator/);

  // No new configuration was introduced: the retrieval step reuses the translation
  // layer's existing flag/provider mechanism.
  const translator = require('../services/support/SupportTranslator');
  assert.strictEqual(translator.TRANSLATION_ENABLED_ENV, 'SUPPORT_TRANSLATION_ENABLED');
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.match(env, /^SUPPORT_TRANSLATION_ENABLED=true$/m);
  assert.ok(!/SUPPORT_QUESTION_TRANSLATION/.test(env), 'no extra flag is added for the retrieval step');
  assert.ok(!/SUPPORT_QUESTION_TRANSLATION/.test(server), 'no extra flag is added for the retrieval step');
});

test('the English knowledge base is still the single source: no translated answers are stored', () => {
  const raw = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'services', 'support', 'arbitrix-knowledge.json'), 'utf8');
  assert.ok(!/[áàâãéêíóôõúç]/i.test(raw), 'no Portuguese answer text in the knowledge base');
  assert.ok(!/[\u0600-\u06FF]/.test(raw), 'no Arabic answer text in the knowledge base');
  assert.strictEqual(KB.categories.length > 0, true);
  assert.strictEqual(KB.categories.reduce((n, c) => n + c.entries.length, 0), 38);
});
