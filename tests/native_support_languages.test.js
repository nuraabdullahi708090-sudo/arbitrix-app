'use strict';

/**
 * Native messenger: knowledge answers in every supported language.
 *
 * The production bug: composeAiReply() accepted an AI answer only when
 * `outcome.modelGenerated === true || language === 'en'`. The offline `knowledge`
 * provider returns approved ENGLISH text with `modelGenerated: false`, so a valid
 * answer was discarded for any non-English conversation and the customer received
 * the localized `aiUnavailable` message.
 *
 * These tests drive the REAL services/NativeSupport.js (the exported
 * composeAiReply, i.e. the same function sendCustomerMessage calls), the REAL
 * ConversationEngine, the REAL SupportAIService with the `knowledge` provider,
 * and the REAL route module. Only the persistence layer and the translating
 * model are doubles.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const NS = require('../services/NativeSupport');
const Engine = require('../services/support/ConversationEngine');
const i18n = require('../services/telegram-i18n');
const S = require('../services/support/SupportKnowledge');
const {
    createSupportAIService,
    resolveSupportAIConfig
} = require('../services/support/SupportAIService');
const { registerNativeSupportRoutes } = require('../services/nativeSupportRoutes');

const ROOT = path.join(__dirname, '..');
const NATIVE = fs.readFileSync(path.join(ROOT, 'services', 'NativeSupport.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const KB = S.readKnowledge();

// An approved question that the deterministic engine does NOT answer, so the AI
// layer is the only possible source of the reply (asserted below, not assumed).
const QUESTION = 'How do I keep my account safe?';
const ENTRY = 'kyc_security.account_safety';
const UNKNOWN = 'what is the capital of france';

const LANGUAGES = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

// The native service owns its customer copy (FALLBACK_COPY), which is NOT the
// Telegram dictionary, so each language's fallback is identified by its wording.
const UNAVAILABLE = {
    en: /Thanks for your message/i,
    es: /Gracias por tu mensaje/i,
    pt: /Obrigado pela sua mensagem/i,
    fr: /Merci pour votre message/i,
    // The Arabic fallback opens with "shukran li-risalatik"; the script range alone
    // would also match a translated Arabic ANSWER.
    ar: /\u0634\u0643\u0631\u0627/ ,
    zh: /\u611f\u8c22\u60a8\u7684\u7559\u8a00/
};

const ARABIC_PREFIX = '\u0645\u0631\u062d\u0628\u0627 '; // "hello " - keeps the script check satisfied
// Simplified Chinese is script-checked too (Han characters), so the zh double needs a
// Chinese sentence rather than a Latin marker.
const ZH_PREFIX = '\u8fd9\u662f\u7ffb\u8bd1\u540e\u7684\u56de\u7b54\u3002'; // "this is the translated answer."
const PREFIX_BY_LANGUAGE = { ar: ARABIC_PREFIX, zh: ZH_PREFIX };

/** The text this double returns for `language`, so assertions stay exact. */
function translated(text, language) {
    const prefix = PREFIX_BY_LANGUAGE[language] || ('[' + language + '] ');
    return prefix + text;
}

function knowledgeAnswer() {
    return S.flattenEntries(KB).find((e) => e.id === ENTRY).answer;
}

/** Deterministic translation double: the same interface SupportTranslator exposes. */
function makeTranslator(mode) {
    const calls = [];
    return {
        calls,
        isAvailable: () => mode !== 'unavailable',
        fromEnglish: async (text, language) => {
            calls.push({ text: String(text), language });
            if (mode === 'fail') return { ok: false, text: '', reason: 'provider-error' };
            if (mode === 'empty') return { ok: true, text: '   ', reason: null };
            if (mode === 'throw') throw new Error('translator exploded');
            if (mode === 'unavailable') return { ok: false, text: '', reason: 'unavailable' };
            return { ok: true, text: translated(text, language), reason: null };
        }
    };
}

function service(options) {
    const opts = options || {};
    const config = resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'knowledge' });
    const ai = Object.prototype.hasOwnProperty.call(opts, 'ai')
        ? opts.ai
        : createSupportAIService({ config });
    return NS.createNativeSupportService({
        ai,
        engine: Engine,
        i18n,
        translator: opts.translator || null,
        now: () => new Date('2026-01-01T00:00:00Z')
    });
}

function conversation(language) {
    return { id: 1, user_id: 7, language, context: {}, status: 'open', ai_paused: false };
}

// ------------------------------------------------------------------ premise ---

test('premise: the question is routed to the AI layer, not the dialogue engine', () => {
    const plan = Engine.planTurn({ text: QUESTION, state: {} });
    assert.strictEqual(plan.handled, false, 'the engine must not answer it, or these tests prove nothing');
    const hits = S.createRetriever(KB).retrieve(QUESTION);
    assert.strictEqual(hits[0].id, ENTRY);
    assert.strictEqual(hits[0].kind, 'info');
});

// ------------------------------------------------------------- A. English ---

test('A. an English knowledge answer is delivered verbatim, with no translation', async () => {
    const translator = makeTranslator('prefix');
    const reply = await service({ translator }).composeAiReply(conversation('en'), QUESTION);

    assert.strictEqual(reply.text, knowledgeAnswer());
    assert.strictEqual(reply.needsHuman, false);
    assert.strictEqual(reply.confident, true);
    assert.deepStrictEqual(translator.calls, [], 'English must never be sent to the translator');
});

// --------------------------------------------------- B. six supported languages ---

test('B. a knowledge answer reaches the customer in all six supported languages', async () => {
    for (const language of LANGUAGES) {
        const translator = makeTranslator('prefix');
        const reply = await service({ translator }).composeAiReply(conversation(language), QUESTION);

        assert.ok(reply.text && reply.text.trim(), language + ' produced an empty reply');
        assert.doesNotMatch(reply.text, UNAVAILABLE[language],
            language + ' fell back to the aiUnavailable copy');
        assert.strictEqual(reply.needsHuman, false, language + ' must not escalate an answered question');
        assert.ok(!/support agent will reply/i.test(reply.text), language + ' escalated');

        if (language === 'en') {
            assert.strictEqual(reply.text, knowledgeAnswer());
            assert.deepStrictEqual(translator.calls, []);
        } else {
            assert.strictEqual(translator.calls.length, 1, language + ' must be translated exactly once');
            assert.strictEqual(translator.calls[0].language, language);
            assert.strictEqual(translator.calls[0].text, knowledgeAnswer(),
                'the APPROVED English text is the translation source');
            assert.notStrictEqual(reply.text, knowledgeAnswer(),
                language + ' must not receive the raw English answer');
            if (language === 'ar') {
                assert.match(reply.text, /[\u0600-\u06FF]/, 'Arabic answer must be in Arabic script');
            } else {
                assert.strictEqual(reply.text, translated(knowledgeAnswer(), language));
            }
        }
    }
});

test('B. the localized fallback is used per language when nothing can be answered', async () => {
    // Same path as B but for a language whose copy differs visibly per locale,
    // proving the fallback text is the customer's, not English.
    const translator = makeTranslator('fail');
    const pt = await service({ translator }).composeAiReply(conversation('pt'), QUESTION);
    const es = await service({ translator }).composeAiReply(conversation('es'), QUESTION);
    assert.match(pt.text, /Obrigado/, 'Portuguese customer must get the Portuguese fallback');
    assert.match(es.text, /Gracias/, 'Spanish customer must get the Spanish fallback');
    assert.notStrictEqual(pt.text, es.text);
});

// ------------------------------------------------------ C. translation failure ---

test('C. a failed translation never ships English text as if it were localized', async () => {
    const modes = ['fail', 'empty', 'throw', 'unavailable'];
    for (const mode of modes) {
        const translator = makeTranslator(mode);
        const reply = await service({ translator }).composeAiReply(conversation('pt'), QUESTION);

        assert.notStrictEqual(reply.text, knowledgeAnswer(), mode + ' leaked the English answer');
        assert.ok(!new RegExp(knowledgeAnswer().slice(0, 25).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(reply.text),
            mode + ' leaked part of the English answer');
        assert.match(reply.text, UNAVAILABLE.pt, mode + ' must use the Portuguese fallback');
        assert.strictEqual(reply.needsHuman, true, mode + ' must hand off to a human');
        assert.strictEqual(reply.confident, false);
    }
});

test('C. with no translator at all a non-English customer gets the honest fallback', async () => {
    const reply = await service({ translator: null }).composeAiReply(conversation('pt'), QUESTION);
    assert.match(reply.text, UNAVAILABLE.pt);
    assert.doesNotMatch(reply.text, /account safe/i);
    assert.strictEqual(reply.needsHuman, true);
});

// ------------------------------------------------------------ D. unknown question ---

test('D. an unanswerable question still hands off to a human', async () => {
    const en = await service({ translator: makeTranslator('prefix') })
        .composeAiReply(conversation('en'), UNKNOWN);
    assert.strictEqual(en.needsHuman, true, 'English handoff preserved');
    assert.match(en.text, /do n?ot have an approved answer|support/i);

    const translator = makeTranslator('prefix');
    const pt = await service({ translator }).composeAiReply(conversation('pt'), UNKNOWN);
    assert.strictEqual(pt.needsHuman, true, 'the handoff survives translation');
    assert.doesNotMatch(pt.text, UNAVAILABLE.pt,
        'the approved "no answer" text is translated for the customer');
    assert.match(pt.text, /^\[pt\] /);
});

// ------------------------------------------------------ E. model-generated answers ---

test('E. a model-generated answer is delivered as-is and never translated twice', async () => {
    const translator = makeTranslator('prefix');
    const ai = { ask: async () => ({ answer: 'Resposta do modelo', modelGenerated: true, needsHuman: false }) };
    const reply = await service({ ai, translator }).composeAiReply(conversation('pt'), QUESTION);

    assert.strictEqual(reply.text, 'Resposta do modelo');
    assert.strictEqual(reply.needsHuman, false);
    assert.deepStrictEqual(translator.calls, [], 'provider text is already in the customer language');

    // Its handoff flag is preserved too.
    const flagging = { ask: async () => ({ answer: 'Preciso de um humano', modelGenerated: true, needsHuman: true }) };
    const flagged = await service({ ai: flagging, translator: makeTranslator('prefix') })
        .composeAiReply(conversation('pt'), QUESTION);
    assert.strictEqual(flagged.needsHuman, true);
    assert.strictEqual(flagged.confident, false);
});

// ------------------------------------------------------- F. AI service unavailable ---

test('F. with no AI service knowledge answers, and an uncovered question hands off', async () => {
    // UPDATED for the intentional change: `ai: null` (AI_SUPPORT_ENABLED off, the
    // production default) now answers from the approved knowledge base through the
    // offline provider, instead of dead-ending every question. An uncovered
    // question still receives the localized human handoff - never an invention.
    for (const language of LANGUAGES) {
        const svc = service({ ai: null, translator: makeTranslator('prefix') });

        const covered = await svc.composeAiReply(conversation(language), QUESTION);
        // English is the knowledge text itself; every other language must be the
        // TRANSLATED approved answer (never the English original).
        const expected = language === 'en' ? knowledgeAnswer() : translated(knowledgeAnswer(), language);
        assert.strictEqual(covered.text, expected, language + ' gets the approved answer in its own language');
        assert.strictEqual(covered.needsHuman, false);
        assert.strictEqual(covered.confident, true);

        const unknown = await svc.composeAiReply(conversation(language), UNKNOWN);
        // The handoff is the knowledge layer's approved wording ("I do not have an
        // approved answer..."), localized for a non-English customer.
        assert.match(unknown.text, /do not have an approved answer/i, language + ' handoff when nothing is approved');
        if (language !== 'en') {
            const prefix = PREFIX_BY_LANGUAGE[language] || ('[' + language + '] ');
            assert.strictEqual(unknown.text.indexOf(prefix), 0, language + ' handoff went through the translator');
        }
        assert.strictEqual(unknown.needsHuman, true);
        assert.strictEqual(unknown.confident, false);
    }
});

// ------------------------------------------------------------- G. HTTP integration ---

test('G. the HTTP route returns the localized knowledge answer, not aiUnavailable', async () => {
    const translator = makeTranslator('prefix');
    const support = service({ translator });
    const sent = [];

    const stub = {
        // Real composition; only persistence is stubbed (covered by native_support.test.js).
        sendCustomerMessage: async (input) => {
            const composed = await support.composeAiReply(conversation('pt'), String(input.body));
            sent.push(composed);
            return {
                ok: true,
                conversationId: input.conversationId,
                message: { id: 10, body: input.body },
                reply: { id: 11, body: composed.text, sender: 'ai' }
            };
        }
    };

    const app = express();
    app.use(express.json());
    registerNativeSupportRoutes(app, {
        support: stub,
        authMiddleware: (req, res, next) => { req.user = { id: 7 }; next(); },
        adminMiddleware: (req, res, next) => { req.user = { id: 1, is_admin: true }; next(); },
        supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [] }) }) }) }) },
        isEnabled: () => true
    });

    const server = app.listen(0);
    try {
        const port = server.address().port;
        const res = await fetch('http://127.0.0.1:' + port + '/api/support/conversations/1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: QUESTION })
        });
        assert.strictEqual(res.status, 201);
        const payload = await res.json();
        assert.strictEqual(payload.ok, true);
        assert.strictEqual(payload.reply.body, '[pt] ' + knowledgeAnswer());
        assert.doesNotMatch(payload.reply.body, UNAVAILABLE.pt);
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].needsHuman, false);
    } finally {
        server.close();
    }
});

// ---------------------------------------------------- boot factory / wiring pins ---

test('H. the flag parser accepts only the literal true (unset/1/quoted-variant are off)', () => {
    const cases = [
        [undefined, false], ['', false], ['true', true], ['TRUE', true], [' True ', true],
        ['"true"', false], ['1', false], ['yes', false]
    ];
    for (const [value, expected] of cases) {
        const env = value === undefined ? {} : { AI_SUPPORT_ENABLED: value };
        assert.strictEqual(resolveSupportAIConfig(env).enabled, expected, 'AI_SUPPORT_ENABLED=' + String(value));
    }
});

test('H. a construction failure is a throw that the boot factory converts to null', () => {
    const config = resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'knowledge' });
    assert.throws(() => createSupportAIService({ config, knowledge: { version: 'x', categories: [] } }),
        /invalid knowledge base/);
    // server.js is the only place that swallows it, and it does so loudly.
    assert.match(SERVER, /catch \(error\) \{[\s\S]{0,240}\[SupportAI\] initialisation failed/);
    assert.match(SERVER, /translator: supportTranslator,/,
        'the native messenger must receive the shared translator');
});

test('H. no second translation architecture was introduced', () => {
    assert.match(NATIVE, /const SupportGuidelines = require\('\.\/support\/SupportGuidelines'\);/);
    assert.match(NATIVE, /translator\.fromEnglish\(String\(text\), language\)/);
    assert.match(NATIVE, /SupportGuidelines\.hasExpectedScript\(result\.text, language\)/);
    // The old, language-blind acceptance condition is gone.
    assert.ok(!/modelGenerated === true \|\| language === 'en'/.test(NATIVE),
        'the knowledge answer must no longer be rejected for non-English conversations');
    // The Telegram translator remains the single implementation.
    assert.match(fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportService.js'), 'utf8'),
        /translate\.fromEnglish\(text, language\)/);
});
