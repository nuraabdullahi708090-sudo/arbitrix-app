'use strict';

/**
 * REGRESSION - production: the admin notice said "English translation: unavailable".
 *
 * SYMPTOM
 *   A Portuguese/Arabic customer message reached the operator notification with
 *   "English translation: unavailable", even though the provider was configured and
 *   the customer-facing direction appeared to work.
 *
 * ROOT CAUSE (found by tracing the request the provider actually sent)
 *   services/support/providers/index.js read `options.buildPrompt` into a local
 *   variable but never passed it to the provider builders. The translation layer
 *   therefore configured auth/timeout correctly while the PROMPT silently fell back to
 *   HttpLLMProvider's buildKnowledgePrompt, so every translation request was:
 *
 *     system : "Translate ... reply with the translation only ..."  (TRANSLATION_INSTRUCTIONS)
 *     user   : "Approved knowledge:"            (EMPTY - the translator passes hits: [])
 *              "Customer question: <the text to translate>"
 *              "Answer in 2-4 short sentences using ONLY the approved knowledge above."
 *              "If the approved knowledge does not answer the question, reply with
 *               exactly NO_ANSWER."
 *
 *   The model did the documented thing for an unanswerable question with no approved
 *   knowledge: it replied NO_ANSWER. SupportTranslator turns that into
 *   `{ok:false, reason:'no-answer'}` (SupportTranslator.js), translateForOperator
 *   reports the failure, operatorNoticeExtras passes `translation: null`, and
 *   buildForwardText prints tOperator('notifyNoTranslation') =
 *   "English translation: unavailable - the original message is shown above."
 *
 *   The same wrong framing degraded the CUSTOMER direction (it was never a genuine
 *   translation request either), which is why it only "appeared" to work.
 *
 * SECOND, INDEPENDENT DEFECT
 *   A plain `/escalate` uses our own English fallback reason
 *   ('User requested human support') but passed it through the reverse translation with
 *   the customer's language, i.e. it asked for a Portuguese->English translation of an
 *   ENGLISH string. Even with a perfectly working translator the text comes back
 *   unchanged, trips the `output === source` echo guard, and the escalation notice
 *   again claims "unavailable".
 *
 * The provider used below is a FAITHFUL stand-in: it answers the request body it was
 * actually sent (NO_ANSWER for the knowledge framing, the translation for the
 * translation framing). A stubbed translator would have hidden this defect.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  createTelegramSupportBot,
  createTelegramTransport
} = require('../services/TelegramSupportService');
const i18n = require('../services/telegram-i18n');
const SupportGuidelines = require('../services/support/SupportGuidelines');
const providers = require('../services/support/providers');
const {
  createSupportTranslator,
  resolveTranslationConfig
} = require('../services/support/SupportTranslator');

const ROOT = path.join(__dirname, '..');
const KEY = 'test-key-not-a-credential';
const ADMIN = '6054625818';
const CUSTOMER = '42';
const CONVERSATION_ID = 1;
const PT_MESSAGE = 'Qual é o depósito mínimo?';
const ENGLISH = 'What is the minimum deposit?';
const PT_ESCALATION = 'Preciso de ajuda com o meu saque';

// What the model returns for a REAL translation request.
const TRANSLATIONS = {
  [PT_MESSAGE]: ENGLISH,
  [PT_ESCALATION]: 'I need help with my withdrawal'
};

const json = (body) => ({ ok: true, status: 200, json: async () => body });

/**
 * A faithful stand-in for DeepSeek: it answers the framing it was actually given.
 * Requests are recorded so a test can assert what the provider was ASKED to do.
 */
function emulatedDeepSeek(requests) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: init.headers || {}, body });
    // Anthropic puts the system prompt at the top level; the OpenAI-compatible
    // providers (deepseek/openai) put it in the first message.
    const anthropicShape = body.system !== undefined;
    const system = anthropicShape ? body.system : body.messages[0].content;
    const user = anthropicShape ? body.messages[0].content : body.messages[1].content;
    const reply = (text) => (anthropicShape
      ? json({ content: [{ type: 'text', text }] })
      : json({ choices: [{ message: { content: text } }] }));

    if (user === 'CUSTOM-PROMPT-SENTINEL') return reply('CUSTOM-PROMPT-SENTINEL');
    if (/Approved knowledge:/.test(user)) {
      // The documented answer to "use ONLY the approved knowledge above" when nothing
      // was approved. This is the path the production defect took.
      return reply('NO_ANSWER');
    }
    if (/^Translate the message below from .+ into .+\./m.test(user) && /translat/i.test(system)) {
      const marker = '\n\nMessage:\n';
      const source = user.slice(user.indexOf(marker) + marker.length);
      return reply(TRANSLATIONS[source] || ('EN: ' + source));
    }
    return reply('NO_ANSWER');
  };
}

/** The REAL translator, driven by the REAL provider builder - only `fetch` is fake. */
function realTranslator({ requests, env = {}, fetchImpl } = {}) {
  const config = resolveTranslationConfig(Object.assign({
    SUPPORT_TRANSLATION_ENABLED: 'true',
    AI_SUPPORT_PROVIDER: 'deepseek',
    AI_SUPPORT_API_KEY: KEY
  }, env));
  const translator = createSupportTranslator({
    config,
    fetchImpl: fetchImpl || emulatedDeepSeek(requests),
    logger: { warn() {} }
  });
  return translator;
}

// ------------------------------------------------------------------- the harness ---

function createHarness({ language = 'pt', translator = null } = {}) {
  const sent = [];
  const conversation = {
    id: CONVERSATION_ID,
    telegram_chat_id: Number(CUSTOMER),
    telegram_user_id: Number(CUSTOMER),
    username: 'ana',
    display_name: 'Ana Customer',
    language
  };
  const store = {
    async getConversationByChatId() { return conversation; },
    async getConversationById() { return conversation; },
    async upsertConversation() { return { conversation, created: false }; },
    async setConversationLanguage({ language: value }) { conversation.language = value; return conversation; },
    async insertMessage({ conversationId, direction, body }) {
      return { message: { id: 1, conversation_id: conversationId, direction, body } };
    },
    async getLatestMessageByConversation() { return null; },
    async createEscalation() { return { id: 1 }; },
    async setConversationStatus() { return true; },
    async probeColumns() { return true; }
  };
  const transport = createTelegramTransport({
    token: '123456789:TEST-TOKEN-NOT-A-CREDENTIAL',
    fetchImpl: async (url, init) => {
      const payload = JSON.parse(init.body);
      sent.push({ method: String(url).split('/').pop(), chatId: String(payload.chat_id), text: payload.text || null });
      return json({ ok: true, result: { message_id: sent.length } });
    }
  });
  const bot = createTelegramSupportBot({
    config: { token: '123456789:TEST-TOKEN-NOT-A-CREDENTIAL', adminIds: [ADMIN], webhookSecret: 's', baseUrl: 'https://arbitrix.pro' },
    store,
    transport,
    translator,
    logger: { log() {}, warn() {}, error() {} }
  });
  return {
    bot,
    toAdmin: () => sent.filter((m) => m.chatId === ADMIN).map((m) => m.text),
    lastToAdmin: () => sent.filter((m) => m.chatId === ADMIN).map((m) => m.text).pop(),
    providerCalls: () => sent.filter((m) => m.chatId === ADMIN).length
  };
}

let updateSeq = 5000;
function message(text) {
  return {
    update_id: ++updateSeq,
    message: {
      message_id: 1,
      from: { id: Number(CUSTOMER), username: 'ana' },
      chat: { id: Number(CUSTOMER), type: 'private' },
      text
    }
  };
}

// ======================================================= the provider boundary ====

test('createProvider forwards the caller\'s prompt builder to every HTTP provider', async () => {
  for (const name of ['deepseek', 'openai', 'anthropic']) {
    const requests = [];
    const provider = providers.createProvider(name, {
      apiKey: KEY,
      fetchImpl: emulatedDeepSeek(requests),
      buildPrompt: () => 'CUSTOM-PROMPT-SENTINEL'
    });
    await provider.generate({ question: 'ignored', hits: [], instructions: 'sys' });

    assert.strictEqual(requests.length, 1, name + ': one request');
    const body = requests[0].body;
    const user = name === 'anthropic' ? body.messages[0].content : body.messages[1].content;
    assert.strictEqual(user, 'CUSTOM-PROMPT-SENTINEL',
      name + ': the injected prompt builder must be used (this is the regression)');
  }
});

test('without a prompt builder the provider still uses the knowledge prompt (answering path unchanged)', async () => {
  const requests = [];
  const provider = providers.createProvider('deepseek', { apiKey: KEY, fetchImpl: emulatedDeepSeek(requests) });
  await provider.generate({ question: 'What is the minimum deposit?', hits: [], instructions: 'sys' });
  assert.match(requests[0].body.messages[1].content, /^Approved knowledge:/);
});

// ======================================================== the request framing =====

test('the reverse translation request is a TRANSLATION request, not a knowledge request', async () => {
  const requests = [];
  const translator = realTranslator({ requests });

  const result = await translator.toEnglish(PT_MESSAGE, 'pt');

  assert.strictEqual(requests.length, 1, 'the provider was called');
  const [request] = requests;
  const system = request.body.messages[0].content;
  const user = request.body.messages[1].content;

  assert.strictEqual(system, SupportGuidelines.TRANSLATION_INSTRUCTIONS, 'system = translation instructions');
  assert.match(user, /^Translate the message below from .+Portuguese into English\./);
  assert.ok(!/Approved knowledge:/.test(user), 'the knowledge framing must not be used');
  assert.ok(!/Customer question:/.test(user), 'the text must not be presented as a question to answer');
  assert.match(user, /Reply with the translation only/, 'the translation contract is stated');
  assert.ok(user.includes(PT_MESSAGE), 'the text to translate is the message itself');

  assert.strictEqual(result.ok, true, 'toEnglish must succeed: ' + JSON.stringify(result));
  assert.strictEqual(result.text, ENGLISH);
});

test('the customer-facing translation request is a TRANSLATION request too', async () => {
  const requests = [];
  const translator = realTranslator({ requests });

  const result = await translator.fromEnglish(ENGLISH, 'pt');

  const user = requests[0].body.messages[1].content;
  assert.match(user, /^Translate the message below from English into .+Portuguese\./);
  assert.ok(!/Approved knowledge:/.test(user));
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.text, 'EN: ' + ENGLISH);
});

test('the provider is reachable with ONLY the provider-specific key (reverse path has no separate config)', async () => {
  const requests = [];
  const translator = realTranslator({ requests, env: { AI_SUPPORT_API_KEY: '', DEEPSEEK_API_KEY: KEY } });
  assert.strictEqual(translator.isAvailable(), true, 'the reverse path reuses the same provider config');
  const result = await translator.toEnglish(PT_MESSAGE, 'pt');
  assert.strictEqual(result.ok, true, JSON.stringify(result));

  const disabled = realTranslator({ requests: [], env: { SUPPORT_TRANSLATION_ENABLED: 'false' } });
  assert.strictEqual(disabled.isAvailable(), false, 'the single data-flow switch still governs it');
});

test('the API key never leaks into the URL or the prompt', async () => {
  const requests = [];
  await realTranslator({ requests }).toEnglish(PT_MESSAGE, 'pt');
  const [request] = requests;
  assert.ok(!request.url.includes(KEY), 'the key stays out of the URL');
  assert.ok(!request.body.messages.some((m) => String(m.content).includes(KEY)), 'and out of the prompt');
  assert.ok(String(request.headers.Authorization || request.headers['x-api-key'] || '').includes(KEY), 'it is only in the auth header');
});

// ========================================================= the reported symptom ====

test('REGRESSION: a Portuguese message reaches the operator with its English translation', async () => {
  const requests = [];
  const h = createHarness({ language: 'pt', translator: realTranslator({ requests }) });

  await h.bot.handleUpdate(message(PT_MESSAGE));

  const notice = h.lastToAdmin();
  assert.ok(notice, 'the operator is notified');
  assert.ok(notice.includes(PT_MESSAGE), 'the original message is preserved');
  assert.ok(notice.includes(ENGLISH), 'the English translation is present');
  assert.ok(!notice.includes(i18n.t('operator', 'notifyNoTranslation')),
    'the notice must NOT claim the translation is unavailable: ' + JSON.stringify(notice));
  assert.strictEqual(requests.length, 1, 'exactly one translation request');
});

test('REGRESSION: an Arabic message reaches the operator with its English translation', async () => {
  const requests = [];
  const h = createHarness({ language: 'ar', translator: realTranslator({ requests }) });
  await h.bot.handleUpdate(message('ما هو الحد الأدنى للإيداع؟'));
  const notice = h.lastToAdmin();
  assert.ok(notice.includes('EN: ما هو الحد الأدنى للإيداع؟'), 'the translation is shown');
  assert.ok(!notice.includes(i18n.t('operator', 'notifyNoTranslation')));
});

test('REGRESSION: a plain /escalate no longer claims the translation is unavailable', async () => {
  const requests = [];
  const h = createHarness({ language: 'pt', translator: realTranslator({ requests }) });

  await h.bot.handleUpdate(message('/escalate'));

  const notice = h.lastToAdmin();
  assert.ok(notice, 'the escalation notice is sent');
  assert.ok(notice.includes('⚠️ Escalation requested'));
  assert.ok(notice.includes('🌐 Language: Portuguese'), 'the operator still sees the customer language');
  assert.ok(notice.includes('Reason: User requested human support'), 'our own English reason is shown as English');
  assert.ok(!notice.includes(i18n.t('operator', 'notifyNoTranslation')),
    'and is not reported as an unavailable translation: ' + JSON.stringify(notice));
  assert.ok(!notice.includes('Original message (Portuguese)'),
    'an English reason must not be labelled as the customer language');
  assert.strictEqual(requests.length, 0, 'our own English constant is not sent for reverse translation');
});

test('a customer-authored escalation reason is still translated', async () => {
  const requests = [];
  const h = createHarness({ language: 'pt', translator: realTranslator({ requests }) });

  await h.bot.handleUpdate(message('/escalate ' + PT_ESCALATION));

  const notice = h.lastToAdmin();
  assert.ok(notice.includes('Original message (Portuguese)'), 'the customer wording is labelled as such');
  assert.ok(notice.includes(PT_ESCALATION));
  assert.ok(notice.includes('I need help with my withdrawal'), 'and translated for the operator');
  assert.ok(!notice.includes(i18n.t('operator', 'notifyNoTranslation')));
  assert.strictEqual(requests.length, 1);
});

test('an English customer is unchanged: no translation attempt, no notice translation block', async () => {
  const requests = [];
  const h = createHarness({ language: 'en', translator: realTranslator({ requests }) });

  await h.bot.handleUpdate(message('What is the minimum deposit?'));

  const notice = h.lastToAdmin();
  assert.ok(notice.includes('Message:'));
  assert.ok(!notice.includes(i18n.t('operator', 'notifyOriginal').slice(0, 12)));
  assert.strictEqual(requests.length, 0, 'nothing is translated for an English customer');
});

// ==================================================================== pins =========

test('the provider builders still accept the prompt builder (the fix is at the hub)', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'support', 'providers', 'index.js'), 'utf8');
  assert.match(source, /buildPrompt: options\.buildPrompt/, 'createProvider must forward the builder');
  assert.match(source, /function buildDeepSeekProvider\(\{[^}]*buildPrompt[^}]*\}\)/);
  const http = fs.readFileSync(path.join(ROOT, 'services', 'support', 'providers', 'HttpLLMProvider.js'), 'utf8');
  assert.match(http, /typeof options\.buildPrompt === 'function'\s*\n\s*\? options\.buildPrompt\s*\n\s*: buildKnowledgePrompt/);
});

test('the escalation notice distinguishes the reason language from the customer language', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportService.js'), 'utf8');
  assert.match(source, /const reasonLanguage = normalizeLanguage\(e\.reasonLanguage \|\| e\.language\);/);
  assert.match(source, /const reasonLanguage = command\.rest \? escalationLanguage : DEFAULT_LANGUAGE;/);
});
