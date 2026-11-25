'use strict';

/**
 * Isolated translation provider.
 *
 * Answers keep coming from AI_SUPPORT_PROVIDER (normally the offline `knowledge`
 * provider). SUPPORT_TRANSLATION_PROVIDER names a SEPARATE, HTTP-capable model
 * used only to translate an already-approved answer. These tests drive the REAL
 * support translator, the REAL knowledge provider, the REAL native reply
 * composer and the REAL Telegram bot - only the HTTP boundary and the
 * persistence/transport layers are fakes.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
    resolveTranslationConfig,
    createSupportTranslator
} = require('../services/support/SupportTranslator');
const {
    createSupportAIService,
    resolveSupportAIConfig
} = require('../services/support/SupportAIService');
const { buildTranslationPrompt } = require('../services/support/SupportGuidelines');
const SupportKnowledge = require('../services/support/SupportKnowledge');
const NS = require('../services/NativeSupport');
const Engine = require('../services/support/ConversationEngine');
const i18n = require('../services/telegram-i18n');
const {
    createTelegramSupportBot,
    createTelegramTransport
} = require('../services/TelegramSupportService');
const { readLf } = require('./helpers/text');

const ROOT = path.join(__dirname, '..');
const SERVER = readLf(path.join(ROOT, 'server.js'));
const AI_SERVICE = readLf(path.join(ROOT, 'services/support/SupportAIService.js'));
const KB = SupportKnowledge.readKnowledge();

const QUESTION = 'How do I keep my account safe?';
const ANSWER = SupportKnowledge.flattenEntries(KB).find((e) => e.id === 'kyc_security.account_safety').answer;
const CUSTOMER = 99112233;
const ADMIN = 99887766;
const TOKEN = '123456789:TEST-TOKEN-NOT-A-CREDENTIAL';
const SECRET = 'test-webhook-secret';

// ------------------------------------------------------------------ helpers ---

/** Config as production would have it: knowledge answers + an isolated translator. */
function envWith(overrides) {
    return Object.assign({
        AI_SUPPORT_ENABLED: 'true',
        AI_SUPPORT_PROVIDER: 'knowledge',
        SUPPORT_TRANSLATION_PROVIDER: 'deepseek',
        DEEPSEEK_API_KEY: 'test-key-not-a-credential'
    }, overrides || {});
}

const TARGET = {
    'Brazilian Portuguese': 'pt',
    Spanish: 'es',
    French: 'fr',
    'Modern Standard Arabic': 'ar',
    'Simplified Chinese': 'zh'
};

/**
 * A fake DeepSeek/OpenAI-compatible endpoint that behaves like a real model of
 * that family: it reads the TRANSLATION prompt and returns `marker + source`.
 * `mode` selects the failure shape.
 */
function translationFetch(options) {
    const opts = options || {};
    const seen = [];
    const fetchImpl = async (url, init) => {
        const body = JSON.parse((init && init.body) || '{}');
        const prompt = (body.messages || []).map((m) => String(m.content)).join('\n');
        seen.push({ url: String(url), prompt, model: body.model });
        if (opts.mode === 'http-500') return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
        if (opts.mode === 'throw') throw new Error('network down');
        const target = (prompt.match(/into ([^.]+)\./) || [])[1] || 'English';
        const source = (prompt.split('Message:\n')[1] || '').trim();
        const code = TARGET[target] || 'en';
        let out;
        if (opts.mode === 'empty') out = '';
        else if (opts.mode === 'echo') out = source;
        else if (opts.mode === 'unsafe') out = 'Garantimos lucros de 10% por dia.';
        else if (opts.mode === 'changed-value') out = source.replace('$700', '$7000');
        else if (code === 'ar') out = '\u0645\u0631\u062d\u0628\u0627 ' + source;
        else out = '[' + code + '] ' + source;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: out } }] }) };
    };
    return { fetchImpl, seen };
}

function translatorFor(env) {
    const fake = translationFetch(env.__fetch || {});
    const translator = createSupportTranslator({
        config: resolveTranslationConfig(env),
        fetchImpl: fake.fetchImpl
    });
    return { translator, calls: fake.seen };
}

function knowledgeAI(env) {
    return createSupportAIService({
        config: resolveSupportAIConfig(Object.assign({}, env, { AI_SUPPORT_ENABLED: 'true' }))
    });
}

// ------------------------------------------------------- configuration isolation ---

test('knowledge answers alone leave translation off (behaviour unchanged)', () => {
    const config = resolveTranslationConfig({ AI_SUPPORT_PROVIDER: 'knowledge' });
    assert.strictEqual(config.provider, 'off');
    assert.strictEqual(config.enabled, false);
    assert.strictEqual(config.apiKey, null);
    assert.strictEqual(config.answerProvider, 'knowledge');
});

test('an isolated provider translates without touching the answer provider', () => {
    const config = resolveTranslationConfig(envWith());
    assert.strictEqual(config.provider, 'deepseek');
    assert.strictEqual(config.providerSource, 'explicit');
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.apiKey, 'test-key-not-a-credential');
    assert.strictEqual(config.answerProvider, 'knowledge');
    assert.strictEqual(resolveSupportAIConfig(envWith()).provider, 'knowledge');
});

test('unset provider inherits only an HTTP-capable answer provider (backwards compatible)', () => {
    const inherited = resolveTranslationConfig({ AI_SUPPORT_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k' });
    assert.strictEqual(inherited.provider, 'deepseek');
    assert.strictEqual(inherited.providerSource, 'inherited');
    assert.strictEqual(resolveTranslationConfig({ AI_SUPPORT_PROVIDER: 'knowledge' }).provider, 'off');
});

test('explicit off / none / disabled / knowledge and unknown names never translate', () => {
    for (const value of ['off', 'none', 'disabled', 'false', 'knowledge', 'deepsek']) {
        const config = resolveTranslationConfig(envWith({ SUPPORT_TRANSLATION_PROVIDER: value }));
        assert.strictEqual(config.provider, 'off', value);
        assert.strictEqual(config.enabled, false, value);
        assert.strictEqual(config.apiKey, null, value);
    }
});

test('the operator switch still disables translation, and the provider survives for diagnostics', () => {
    const config = resolveTranslationConfig(envWith({ SUPPORT_TRANSLATION_ENABLED: 'false' }));
    assert.strictEqual(config.enabled, false);
    assert.strictEqual(config.enabledByOperator, false);
    assert.strictEqual(config.provider, 'deepseek');
});

test('credentials are never sent to a different vendor', () => {
    const other = resolveTranslationConfig(envWith({
        SUPPORT_TRANSLATION_PROVIDER: 'openai',
        OPENAI_API_KEY: '',
        AI_SUPPORT_API_KEY: 'answer-layer-only-key'
    }));
    assert.strictEqual(other.provider, 'openai');
    assert.strictEqual(other.apiKey, null, 'AI_SUPPORT_API_KEY must not be sent to OpenAI');

    const same = resolveTranslationConfig({
        AI_SUPPORT_PROVIDER: 'deepseek', AI_SUPPORT_API_KEY: 'shared-key'
    });
    assert.strictEqual(same.apiKey, 'shared-key');

    const tuned = resolveTranslationConfig(envWith({
        SUPPORT_TRANSLATION_MODEL: 'deepseek-chat',
        SUPPORT_TRANSLATION_BASE_URL: 'https://translator.internal',
        AI_SUPPORT_MODEL: 'answer-model'
    }));
    assert.strictEqual(tuned.model, 'deepseek-chat');
    assert.strictEqual(tuned.baseUrl, 'https://translator.internal');
});

test('the translator advertises exactly the six supported languages', () => {
    const { translator } = translatorFor(envWith());
    assert.deepStrictEqual(translator.languages(), ['en', 'es', 'pt', 'fr', 'ar', 'zh']);
    assert.deepStrictEqual(translator.describe().languages, ['en', 'es', 'pt', 'fr', 'ar', 'zh']);
    assert.strictEqual(translator.describe().provider, 'deepseek');
    assert.strictEqual(translator.describe().answerProvider, 'knowledge');
});

// -------------------------------------------------------------- translation ---

test('every non-English language is translated from the approved English answer', async () => {
    const { translator, calls } = translatorFor(envWith());
    assert.strictEqual(translator.isAvailable(), true);

    for (const language of ['es', 'pt', 'fr', 'ar', 'zh']) {
        const result = await translator.fromEnglish(ANSWER, language);
        assert.strictEqual(result.ok, true, language + ': ' + result.reason);
        assert.notStrictEqual(result.text, ANSWER, language + ' must not return the English text');
        if (language === 'ar') assert.match(result.text, /[\u0600-\u06FF]/, 'Arabic script');
        else assert.ok(result.text.startsWith('[' + language + '] '), language + ' marker');
    }
    assert.strictEqual(calls.length, 5);
    for (const call of calls) {
        assert.match(call.prompt, /Translate the message below/);
        assert.ok(!/Approved knowledge:/.test(call.prompt), 'the translator must not be asked to answer');
    }
});

test('English is a no-op: no provider call, no translation', async () => {
    const { translator, calls } = translatorFor(envWith());
    const result = await translator.fromEnglish(ANSWER, 'en');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.reason, 'same-language');
    assert.strictEqual(result.text, ANSWER);
    assert.strictEqual(calls.length, 0);
});

test('the prompt names the target language for every supported language', () => {
    assert.match(buildTranslationPrompt('en', 'zh', 'x'), /into Simplified Chinese\./);
    assert.match(buildTranslationPrompt('en', 'es', 'x'), /into Spanish\./);
    assert.match(buildTranslationPrompt('en', 'fr', 'x'), /into French\./);
    assert.match(buildTranslationPrompt('en', 'ar', 'x'), /into Modern Standard Arabic\./);
});

test('provider failures, empty output, echoes and unsafe or altered text are refused', async () => {
    const cases = [
        ['http-500', /provider-error|no-answer/],
        ['throw', /provider-error/],
        ['empty', /no-answer/],
        ['echo', /echo/],
        ['changed-value', /fidelity/],
        // Whichever guard fires first (an invented figure trips fidelity, the
        // claim itself trips the pt denylist), the answer is withheld.
        ['unsafe', /unsafe|fidelity/]
    ];
    for (const [mode, reason] of cases) {
        const fake = translationFetch({ mode });
        const translator = createSupportTranslator({
            config: resolveTranslationConfig(envWith()),
            fetchImpl: fake.fetchImpl
        });
        const result = await translator.fromEnglish(
            mode === 'changed-value' ? 'The minimum withdrawal is $700.' : ANSWER, 'pt');
        assert.strictEqual(result.ok, false, mode + ' must fail');
        assert.match(String(result.reason), reason, mode + ' reason: ' + result.reason);
        assert.strictEqual(result.text, '');
    }
});

test('a timeout is reported, never a partial or invented answer', async () => {
    const slow = async (url, init) => new Promise((resolve, reject) => {
        if (init && init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const translator = createSupportTranslator({
        config: resolveTranslationConfig(envWith({ AI_SUPPORT_TIMEOUT_MS: '30' })),
        fetchImpl: slow
    });
    const started = Date.now();
    const result = await translator.fromEnglish(ANSWER, 'pt');
    assert.strictEqual(result.ok, false);
    assert.match(String(result.reason), /provider-error/);
    assert.ok(Date.now() - started < 3000, 'the aborted call must return promptly');
});

test('with no translation credential nothing is attempted', () => {
    const translator = createSupportTranslator({
        config: resolveTranslationConfig({ AI_SUPPORT_PROVIDER: 'knowledge', SUPPORT_TRANSLATION_PROVIDER: 'deepseek' })
    });
    assert.strictEqual(translator.isAvailable(), false);
});

// ------------------------------------------------------------ native support ---

function nativeService(env) {
    const { translator } = translatorFor(env);
    return {
        service: NS.createNativeSupportService({
            ai: knowledgeAI(env),
            engine: Engine,
            i18n,
            translator
        }),
        translator
    };
}

test('native: the isolated provider localizes a knowledge answer for es/pt/fr/ar/zh', async () => {
    for (const language of ['es', 'pt', 'fr', 'ar', 'zh']) {
        const { service } = nativeService(envWith());
        const reply = await service.composeAiReply({ id: 1, language, context: {} }, QUESTION);
        assert.notStrictEqual(reply.text, ANSWER, language + ' must not receive English');
        assert.strictEqual(reply.needsHuman, false, language + ' must not escalate');
        assert.strictEqual(reply.confident, true);
        if (language === 'ar') assert.match(reply.text, /[\u0600-\u06FF]/);
        else assert.ok(reply.text.startsWith('[' + language + '] '));
    }
});

test('native: the answer text is unchanged when translation is off (English path)', async () => {
    const withOut = nativeService({ AI_SUPPORT_PROVIDER: 'knowledge' }).service;
    const withTranslation = nativeService(envWith()).service;
    const a = await withOut.composeAiReply({ id: 1, language: 'en', context: {} }, QUESTION);
    const b = await withTranslation.composeAiReply({ id: 1, language: 'en', context: {} }, QUESTION);
    assert.strictEqual(a.text, ANSWER);
    assert.strictEqual(b.text, ANSWER, 'translation configuration must not change the answer');
});

test('native: an unavailable/failing translation keeps the localized fallback and handoff', async () => {
    const variants = [
        { AI_SUPPORT_PROVIDER: 'knowledge' },
        envWith({ __fetch: { mode: 'http-500' } })
    ];
    for (const env of variants) {
        const { service } = nativeService(env);
        const reply = await service.composeAiReply({ id: 1, language: 'pt', context: {} }, QUESTION);
        assert.strictEqual(reply.needsHuman, true);
        assert.strictEqual(reply.confident, false);
        assert.match(reply.text, /Obrigado pela sua mensagem/);
        assert.ok(!reply.text.includes(ANSWER.slice(0, 25)), 'English must never be presented as localized');
    }
});

// ------------------------------------------------------------------- telegram ---

function telegramHarness(options) {
    const language = options.language || 'pt';
    const translator = options.translator || null;
    const sent = [];
    let seq = 100;
    const conversation = {
        id: ++seq,
        telegram_chat_id: CUSTOMER,
        telegram_user_id: CUSTOMER,
        username: 'ana',
        display_name: 'Ana',
        language
    };

    const store = {
        async getConversationByChatId(chatId) {
            return String(chatId) === String(CUSTOMER) ? conversation : null;
        },
        async getConversationById(id) { return Number(id) === conversation.id ? conversation : null; },
        async upsertConversation() { return { conversation, created: false }; },
        async setConversationLanguage() { return conversation; },
        async setConversationContext() { return conversation; },
        async insertMessage({ conversationId, direction, body }) {
            return { message: { id: ++seq, conversation_id: conversationId, direction, body } };
        },
        async getLatestMessageByConversation() { return null; },
        async createEscalation() { return { id: 1 }; },
        async setConversationStatus() { return true; },
        async probeColumns() { return true; }
    };

    const fetchImpl = async (url, init) => {
        const payload = JSON.parse((init && init.body) || '{}');
        sent.push({ method: String(url).split('/').pop(), chatId: payload.chat_id, text: payload.text });
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    };

    const bot = createTelegramSupportBot({
        config: { token: TOKEN, adminIds: [ADMIN], webhookSecret: SECRET, baseUrl: 'https://arbitrix.pro' },
        store,
        transport: createTelegramTransport({ token: TOKEN, fetchImpl }),
        logger: { log() {}, warn() {}, error() {} },
        supportAI: knowledgeAI({ AI_SUPPORT_PROVIDER: 'knowledge' }),
        translator
    });

    return { bot, sent };
}

test('telegram: a Portuguese customer receives the translated approved answer', async () => {
    const { translator } = translatorFor(envWith());
    const { bot, sent } = telegramHarness({ language: 'pt', translator });
    const status = await bot.handleUpdate({
        update_id: 910001,
        message: {
            message_id: 11,
            from: { id: CUSTOMER, first_name: 'Ana' },
            chat: { id: CUSTOMER, type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text: QUESTION
        }
    });
    assert.strictEqual(status.handled, true);
    const text = sent.filter((s) => s.method === 'sendMessage').map((s) => s.text).join('\n');
    assert.ok(text.includes('[pt] ' + ANSWER), 'the translated answer is delivered');
    assert.ok(!text.includes('Obrigado pela sua mensagem'), 'no fallback');
});

test('telegram: turning translation off does not change the English answer', async () => {
    const withoutTranslator = telegramHarness({ language: 'en', translator: null });
    const withTranslator = telegramHarness({ language: 'en', translator: translatorFor(envWith()).translator });
    const update = (id) => ({
        update_id: id,
        message: {
            message_id: 12,
            from: { id: CUSTOMER, first_name: 'Ana' },
            chat: { id: CUSTOMER, type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text: QUESTION
        }
    });
    await withoutTranslator.bot.handleUpdate(update(910002));
    await withTranslator.bot.handleUpdate(update(910003));
    const a = withoutTranslator.sent.filter((s) => s.method === 'sendMessage').map((s) => s.text).join('\n');
    const b = withTranslator.sent.filter((s) => s.method === 'sendMessage').map((s) => s.text).join('\n');
    assert.strictEqual(a, b, 'translation configuration must not alter Telegram answer generation');
    assert.ok(a.includes(ANSWER));
});

// ------------------------------------------------------------- wiring pins ---

test('one translator instance serves Telegram and native support', () => {
    const created = SERVER.match(/const supportTranslator = createSupportTranslatorSafely\(\);/g) || [];
    assert.strictEqual(created.length, 1, 'the translator is built exactly once');
    const injected = SERVER.match(/translator: supportTranslator,/g) || [];
    assert.strictEqual(injected.length, 2, 'injected into the Telegram bot and the native service');
    assert.match(SERVER, /supportAI: createSupportAIServiceSafely\(supportTranslator\)/);
});

test('translation configuration cannot reach the answer layer', () => {
    assert.ok(!/SUPPORT_TRANSLATION_PROVIDER|SUPPORT_TRANSLATION_MODEL|SUPPORT_TRANSLATION_BASE_URL/.test(AI_SERVICE),
        'SupportAIService must not read translation settings');
    assert.ok(!/SUPPORT_TRANSLATION_/.test(readLf(path.join(ROOT, 'services', 'support', 'SupportKnowledge.js'))));
});
