'use strict';

/**
 * BUSINESS REGISTRATION knowledge-base + multilingual support tests.
 *
 * The approved answer is English (canonical, exactly one entry - no duplicated
 * pt/ar entries). Portuguese and Arabic customers receive it through the
 * EXISTING translation layer, whose numbers/URLs fidelity guard is preserved.
 *
 * Scope guards pinned here:
 *   - the exact legal name + KVK number from the certificate are used;
 *   - the answer points to https://arbitrix.pro/business-registration;
 *   - the certificate IMAGE is not embedded in the KB;
 *   - the answer never calls the registration a licence/authorization;
 *   - the listed customer questions all retrieve the entry;
 *   - existing retrieval/answers are unchanged (regression pin);
 *   - the existing multilingual pipeline translates it for pt/ar.
 *
 * Real modules are exercised: SupportKnowledge, SupportAIService (offline
 * knowledge provider), SupportGuidelines and the real Telegram bot. Only the
 * translating MODEL and the Telegram network are faked.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const SupportKnowledge = require('../services/support/SupportKnowledge');
const SupportGuidelines = require('../services/support/SupportGuidelines');
const { createSupportAIService, resolveSupportAIConfig } = require('../services/support/SupportAIService');
const {
    createTelegramSupportBot,
    createTelegramTransport
} = require('../services/TelegramSupportService');

const LEGAL_NAME = 'Arbitrix Trading';
const KVK_NUMBER = '72923513';
const PAGE_URL = 'https://arbitrix.pro/business-registration';
const ENTRY_ID = 'business_registration.kvk';

const knowledge = SupportKnowledge.readKnowledge();
const retriever = SupportKnowledge.createRetriever(knowledge);
const entry = retriever.getEntry(ENTRY_ID);

/* ------------------------------------------------------------------ *
 * 1. The approved entry
 * ------------------------------------------------------------------ */
test('1. exactly one business-registration entry exists, in English', () => {
    const categories = knowledge.categories.filter((c) => c.id === 'business_registration');
    assert.strictEqual(categories.length, 1, 'one business_registration category');
    assert.strictEqual(categories[0].entries.length, 1, 'one entry - no duplicated locales');
    assert.ok(entry, 'the entry must exist');
    assert.strictEqual(entry.kind, 'info', 'a factual info answer, not a handoff');
    // English canonical: no non-ASCII characters in the answer.
    assert.ok(!/[^\x00-\x7F]/.test(entry.answer), 'the canonical answer must be plain English');
    // A knowledge-base answer, not a model hallucination.
    assert.strictEqual(SupportKnowledge.validateKnowledge(knowledge).length, 0, 'the KB must validate');
});

test('2. the answer uses the exact legal name and KVK number from the certificate', () => {
    assert.ok(entry.answer.includes(LEGAL_NAME), 'the exact legal name must appear');
    assert.ok(entry.answer.includes(KVK_NUMBER), 'the exact KVK number must appear');
    assert.match(entry.answer, /Netherlands Chamber of Commerce \(KVK\)/);
});

test('3. the answer directs customers to the business-registration page', () => {
    assert.ok(entry.answer.includes(PAGE_URL), 'the approved page URL must appear');
    assert.strictEqual((entry.answer.match(/https?:\/\//g) || []).length, 1, 'exactly one URL, no external verification links');
    assert.ok(!/kvk\.nl/i.test(entry.answer), 'no external KVK link');
});

test('4. the certificate image is not embedded in the knowledge base', () => {
    assert.ok(!/!\[|<img|\.jpg|\.jpeg|\.png|\/certificates\//i.test(entry.answer), 'text + URL only');
    assert.ok(!/!\[|<img|\.jpg|\.jpeg|\.png/i.test(JSON.stringify(knowledge.categories.filter((c) => c.id === 'business_registration'))), 'no image reference in the entry');
});

test('5. the answer never calls the registration a licence or an authorization', () => {
    const a = entry.answer.toLowerCase();
    ['licence', 'license', 'licensed', 'regulatory', 'authorization', 'authorisation', 'authorized', 'authorised'].forEach((w) => {
        assert.ok(!a.includes(w), 'must not claim: ' + w);
    });
    assert.ok(!/cac|nigeria/i.test(entry.answer), 'no CAC / Nigeria reference');
});

/* ------------------------------------------------------------------ *
 * 6. Retrieval: the listed customer questions reach the answer
 * ------------------------------------------------------------------ */
test('6. every listed customer question retrieves the business-registration answer', () => {
    const questions = [
        'Can I see your licence?',
        'Can I see your registration?',
        'Are you registered?',
        'Show me your business registration.',
        'Can I see your company certificate?',
        'What is your KVK number?',
        'What company operates Arbitrix?'
    ];
    questions.forEach((q) => {
        const hits = retriever.retrieve(q);
        assert.ok(hits.length > 0, 'no hit for: ' + q);
        assert.strictEqual(hits[0].id, ENTRY_ID, 'wrong top hit for: ' + q + ' -> ' + hits[0].id);
        assert.ok(hits[0].answer.includes(PAGE_URL), 'the retrieved answer must carry the URL for: ' + q);
    });
});

test('6b. existing questions are unchanged by the new entry (no hijack)', () => {
    const expected = {
        'What is the minimum deposit?': 'deposits.minimum',
        'How do I make a deposit?': 'deposits.how_to',
        'How long does a withdrawal take?': 'withdrawals.timing',
        'How do withdrawals work?': 'withdrawals.requirements',
        'Do I need to verify my identity?': 'kyc_security.required',
        'What documents do I need for verification?': 'kyc_security.documents',
        'How does the bot work?': 'trading_bot.how_it_works',
        'How do I contact a human?': 'contact_human.how',
        'Can I use Demo Mode?': 'demo_mode.can_i_use',
        'What is the referral program?': 'referrals.program',
        'How much is the subscription?': 'subscription.price',
        'Which countries can use Arbitrix?': 'supported_countries.availability',
        'I cannot log in': 'troubleshooting.login',
        'Will I make a profit?': 'guardrails.no_guarantee',
        'What is arbitrage?': 'what_is_arbitrix.arbitrage',
        'My deposit is still pending': 'deposits.pending'
    };
    Object.entries(expected).forEach(([q, id]) => {
        const top = retriever.retrieve(q)[0];
        assert.ok(top, 'no hit for: ' + q);
        assert.strictEqual(top.id, id, 'retrieval changed for: ' + q);
    });
});

/* ------------------------------------------------------------------ *
 * 7. English end-to-end
 * ------------------------------------------------------------------ */
test('7. an English customer receives the approved answer with the URL', async () => {
    const ai = createSupportAIService({ config: resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true' }) });
    const out = await ai.ask('What is your KVK number?', { language: 'en' });
    assert.strictEqual(out.kind, 'answer');
    assert.strictEqual(out.needsHuman, false);
    assert.strictEqual(out.source, 'knowledge');
    assert.strictEqual(out.answer, entry.answer);
    assert.ok(out.answer.includes(PAGE_URL));
});

/* ------------------------------------------------------------------ *
 * 8/9. Portuguese + Arabic through the EXISTING translation system
 * ------------------------------------------------------------------ */
const PT_ANSWER = 'A Arbitrix \u00e9 operada pela Arbitrix Trading, registada na C\u00e2mara de Com\u00e9rcio dos Pa\u00edses Baixos (KVK) com o n\u00famero KVK 72923513. Pode ver o certificado de registo comercial aqui: ' + PAGE_URL;
const AR_ANSWER = '\u062a\u062f\u0627\u0631 \u0627\u0644\u0627\u0633\u0645 \u00abArbitrix Trading\u00bb \u0645\u0646\u0635\u0629 Arbitrix\u060c \u0648\u0647\u064a \u0645\u0633\u062c\u0644\u0629 \u0644\u062f\u0649 \u063a\u0631\u0641\u0629 \u062a\u062c\u0627\u0631\u0629 \u0647\u0648\u0644\u0646\u062f\u0627 (KVK) \u0628\u0631\u0642\u0645 KVK 72923513. \u064a\u0645\u0643\u0646\u0643 \u0645\u0634\u0627\u0647\u062f\u0629 \u0634\u0647\u0627\u062f\u0629 \u0627\u0644\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062a\u062c\u0627\u0631\u064a \u0647\u0646\u0627: ' + PAGE_URL;

function createFakeStore(language) {
    const conversation = {
        id: 42,
        telegram_chat_id: 555111,
        telegram_user_id: 555111,
        username: 'ana',
        display_name: 'Ana Customer',
        language
    };
    const messages = [];
    let seq = 0;
    return {
        messages,
        async getConversationByChatId(id) { return String(id) === String(conversation.telegram_chat_id) ? conversation : null; },
        async getConversationById(id) { return Number(id) === conversation.id ? conversation : null; },
        async upsertConversation() { return { conversation, created: false }; },
        async insertMessage({ conversationId, direction, body }) {
            const m = { id: ++seq, conversation_id: conversationId, direction, body };
            messages.push(m);
            return { message: m };
        },
        async getLatestMessageByConversation({ conversationId, direction }) {
            return messages.filter((m) => m.conversation_id === conversationId && (!direction || m.direction === direction)).pop() || null;
        },
        async createEscalation() { return {}; },
        async setConversationStatus() { return true; },
        async probeColumns() { return true; }
    };
}

function createHarness(language, translator) {
    const store = createFakeStore(language);
    const sent = [];
    let messageId = 0;
    const transport = createTelegramTransport({
        token: '123456789:TEST-TOKEN-NOT-A-CREDENTIAL',
        fetchImpl: async (url, options) => {
            const payload = JSON.parse((options && options.body) || '{}');
            sent.push({ chatId: String(payload.chat_id), text: payload.text });
            return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: ++messageId } }) };
        }
    });
    const ai = createSupportAIService({ config: resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true' }), translator });
    const bot = createTelegramSupportBot({
        config: { token: '123456789:TEST-TOKEN-NOT-A-CREDENTIAL', adminIds: ['6054625818'], webhookSecret: 's', baseUrl: 'https://arbitrix.pro' },
        store,
        transport,
        logger: { log() {}, warn() {}, error() {} },
        supportAI: ai,
        translator
    });
    return { bot, sent, customerTexts: () => sent.filter((s) => s.chatId === '555111').map((s) => s.text) };
}

function makeTranslator(localized) {
    const calls = { toEnglish: 0, fromEnglish: 0 };
    return {
        calls,
        async toEnglish() { calls.toEnglish += 1; return { ok: true, text: 'What is your KVK number?', reason: null }; },
        async fromEnglish() { calls.fromEnglish += 1; return { ok: true, text: localized, reason: null }; }
    };
}

let updateSeq = 0;
function customerUpdate(text) {
    updateSeq += 1;
    return { update_id: updateSeq, message: { message_id: 1, from: { id: 555111, username: 'ana' }, chat: { id: 555111, type: 'private' }, text } };
}

test('8. a Portuguese customer receives the translated approved answer (URL + number intact)', async () => {
    const translator = makeTranslator(PT_ANSWER);
    const h = createHarness('pt', translator);
    await h.bot.handleUpdate(customerUpdate('Qual \u00e9 o n\u00famero KVK da Arbitrix?'));

    assert.strictEqual(h.customerTexts()[0], PT_ANSWER, 'the customer must receive the translated answer');
    assert.ok(h.customerTexts()[0].includes(PAGE_URL), 'the URL must survive translation');
    assert.ok(h.customerTexts()[0].includes(KVK_NUMBER), 'the KVK number must survive translation');
    assert.strictEqual(translator.calls.fromEnglish, 1, 'the existing translation layer must be used');
    // A confident answer: the full approved content was delivered, not the
    // localized uncertain/handoff fallback.
    assert.ok(!/approved answer/i.test(h.customerTexts()[0]), 'must not be the uncertain fallback');
});

test('9. an Arabic customer receives the translated approved answer (URL + number intact)', async () => {
    const translator = makeTranslator(AR_ANSWER);
    const h = createHarness('ar', translator);
    await h.bot.handleUpdate(customerUpdate('\u0645\u0627 \u0647\u0648 \u0631\u0642\u0645 KVK\u061f'));

    assert.strictEqual(h.customerTexts()[0], AR_ANSWER, 'the customer must receive the translated answer');
    assert.ok(h.customerTexts()[0].includes(PAGE_URL), 'the URL must survive translation');
    assert.ok(h.customerTexts()[0].includes(KVK_NUMBER), 'the KVK number must survive translation');
    assert.strictEqual(translator.calls.fromEnglish, 1);
    assert.ok(!/approved answer/i.test(h.customerTexts()[0]), 'must not be the uncertain fallback');
});

test('9b. translation fidelity: an answer that drops the URL or number is withheld', () => {
    // A faithful translation keeps every number and URL.
    const good = SupportGuidelines.checkTranslationFidelity(entry.answer, PT_ANSWER);
    assert.deepStrictEqual(good.missingUrls, []);
    assert.deepStrictEqual(good.missingNumbers, []);
    assert.deepStrictEqual(good.addedUrls, []);
    assert.deepStrictEqual(good.addedNumbers, []);

    // A translation that alters the number or drops the link is detected.
    const altered = SupportGuidelines.checkTranslationFidelity(entry.answer, PT_ANSWER.replace(KVK_NUMBER, '72923514'));
    assert.ok(altered.missingNumbers.includes(KVK_NUMBER), 'a changed KVK number must be caught');
    const noUrl = SupportGuidelines.checkTranslationFidelity(entry.answer, PT_ANSWER.replace(PAGE_URL, ''));
    assert.deepStrictEqual(noUrl.missingUrls, [PAGE_URL], 'a dropped link must be caught');
});

/* ------------------------------------------------------------------ *
 * 10. Existing Telegram behavior unchanged
 * ------------------------------------------------------------------ */
test('10. an unrelated question still gets its existing answer (no new entry hijack)', async () => {
    const h = createHarness('en', null);
    await h.bot.handleUpdate(customerUpdate('What is the minimum deposit?'));
    assert.ok(h.customerTexts()[0].includes('minimum deposit'), 'the deposit answer must still work');
    assert.ok(!h.customerTexts()[0].includes(PAGE_URL), 'the KVK page must not hijack other questions');
});

test('10b. an unknown question is still handed off, never answered with the KVK page', async () => {
    const h = createHarness('en', null);
    await h.bot.handleUpdate(customerUpdate('asdfghjkl qwertyuiop'));
    const text = h.customerTexts()[0];
    assert.ok(text && text.trim(), 'the customer must still get a reply');
    assert.ok(!text.includes(PAGE_URL), 'the KVK entry must not answer unrelated questions');
    // The AI layer decides the hand-off (needsHuman) that drives the admin status.
    const ai = createSupportAIService({ config: resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true' }) });
    const out = await ai.ask('asdfghjkl qwertyuiop', { language: 'en' });
    assert.strictEqual(out.needsHuman, true, 'an uncertain answer must be flagged for a human');
});
