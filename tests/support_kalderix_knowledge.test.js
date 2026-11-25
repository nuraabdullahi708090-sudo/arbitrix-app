'use strict';

/**
 * Kalderix support knowledge base: coverage + retrieval + end-to-end answers.
 *
 * Runs the REAL retriever, the REAL SupportAIService (knowledge provider) and the
 * REAL Telegram bot factory, so a regression in any layer fails here:
 *   customer wording -> retrieval -> approved answer -> (bot) chat reply.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../services/support/SupportKnowledge');
const {
    createSupportAIService,
    resolveSupportAIConfig
} = require('../services/support/SupportAIService');
const { createTelegramSupportBot } = require('../services/TelegramSupportService');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'REBRAND_COMPLETION_AUDIT.md'), 'utf8');

const kb = S.readKnowledge();
const loaded = S.loadSupportKnowledge();
const retriever = loaded.retriever;

function ai() {
    const config = resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'knowledge' });
    return createSupportAIService({ config });
}

// The two questions reported from production.
const REPORTED = [
    'What is Kalderix and how does it work?',
    'Tell me about your platform'
];

const COMMON = [
    ['what is this website', 'what_is_arbitrix.overview'],
    ['what is this app', 'what_is_arbitrix.overview'],
    ['who are you', 'what_is_arbitrix.overview'],
    ['tell me about the company', 'what_is_arbitrix.overview'],
    ['what is arbitrage', 'what_is_arbitrix.arbitrage'],
    ['how do i create an account', 'getting_started.account'],
    ['how do i sign up', 'getting_started.account'],
    ['how do i get started', 'getting_started.steps'],
    ['how do i change my email', 'account.email_change'],
    ['how do i make my account more secure', 'getting_started.account_security'],
    ['what languages do you support', 'platform.languages'],
    ['is there a mobile app', 'platform.mobile_app'],
    ['do you have a privacy policy', 'platform.privacy'],
    ['are there any fees', 'fees.overview'],
    ['can i use demo mode', 'demo_mode.can_i_use'],
    ['how do i go live', 'live_mode.overview'],
    ['what is the minimum deposit', 'deposits.minimum'],
    ['how do i make a deposit', 'deposits.how_to'],
    ['do i need a memo', 'deposits.reference'],
    ['my deposit is still pending', 'deposits.pending'],
    ['how do i start the bot', 'trading_bot.how_it_works'],
    ['does the bot keep trading if i close the app', 'trading_bot.offline'],
    ['how do withdrawals work', 'withdrawals.requirements'],
    ['which address can i withdraw to', 'withdrawals.address'],
    ['how long does a withdrawal take', 'withdrawals.timing'],
    ['do i need to verify my identity', 'kyc_security.required'],
    ['is my money safe', 'trading_bot.risk'],
    ['what is the promotional credit', 'promotional_credit.what_is_it'],
    ['can i withdraw the promo credit', 'promotional_credit.what_is_it'],
    ['what is the referral program', 'referrals.program'],
    ['how much is the subscription', 'subscription.price'],
    ['is kalderix legit', 'business_registration.kvk'],
    ['the app is not loading', 'troubleshooting.app_loading'],
    ['how do i contact support', 'contact_human.how']
];

const UNSUPPORTED = [
    'what is the capital of france',
    'do you sell cars',
    'what is the weather today'
];

test('knowledge base is valid and covers the expanded catalogue', () => {
    assert.deepStrictEqual(S.validateKnowledge(kb), []);
    const total = S.flattenEntries(kb).length;
    assert.ok(total >= 49, 'expected the expanded base, got ' + total);
    assert.strictEqual(retriever.count, total);
});

test('the two production questions return the approved platform answer', async () => {
    const service = ai();
    for (const q of REPORTED) {
        const hits = retriever.retrieve(q);
        assert.ok(hits.length > 0, 'no retrieval hit for: ' + q);
        assert.strictEqual(hits[0].id, 'what_is_arbitrix.overview');

        const out = await service.ask(q, { language: 'en' });
        assert.strictEqual(out.kind, 'answer', q + ' => ' + out.kind);
        assert.strictEqual(out.needsHuman, false);
        assert.strictEqual(out.entryId, 'what_is_arbitrix.overview');
        assert.match(out.answer, /Kalderix is an automated arbitrage platform/);
    }
});

test('common customer questions retrieve the right entry', () => {
    COMMON.forEach(([q, expected]) => {
        const hits = retriever.retrieve(q);
        assert.ok(hits.length > 0, 'MISS: ' + q);
        assert.strictEqual(hits[0].id, expected, q + ' -> ' + hits[0].id);
    });
});

test('unsupported questions still hand off to a human', async () => {
    const service = ai();
    for (const q of UNSUPPORTED) {
        assert.strictEqual(retriever.retrieve(q).length, 0, 'unexpected hit: ' + q);
        const out = await service.ask(q, { language: 'en' });
        assert.strictEqual(out.kind, 'unknown', q + ' => ' + out.kind);
        assert.strictEqual(out.needsHuman, true);
    }
});

test('a question made only of stopwords can still match a phrase keyword', () => {
    // Regression: tokenize('who are you') is empty, so retrieval used to return []
    // before scoring and no phrase keyword could ever match.
    assert.strictEqual(S.tokenize('who are you').length, 0);
    const hits = retriever.retrieve('who are you');
    assert.ok(hits.length > 0, 'stopword-only questions must still be scored');
    assert.strictEqual(hits[0].id, 'what_is_arbitrix.overview');
});

test('no approved answer promises profits, and the bot facts stay truthful', () => {
    S.flattenEntries(kb).forEach((entry) => {
        assert.deepStrictEqual(S.findPromiseViolations(entry.answer), [], entry.id);
    });
    const offline = retriever.retrieve('does the bot keep trading if i close the app')[0];
    assert.strictEqual(offline.id, 'trading_bot.offline');
    assert.doesNotMatch(offline.answer, /while the Kalderix app is open|stops/i.test('') ? /x/ : /on our servers|continues/i);
});

// ------------------------------------------------------------ Telegram seam
function fakeBot(supportAI) {
    const sent = [];
    let nextId = 500;
    const conversations = new Map();
    // The service accepts either the row or { conversation } from the store, so the
    // fake returns a row that also exposes itself as `.conversation`.
    function rowFor(key) {
        if (!conversations.has(key)) {
            const row = { id: ++nextId, chatId: key, language: 'en', context: {}, status: 'open', ai_paused: false };
            row.conversation = row;
            conversations.set(key, row);
        }
        return conversations.get(key);
    }
    const store = {
        upsertConversation: async (input) => rowFor(String((input && (input.chatId || input.chat_id)) || '4242')),
        getOrCreateConversation: async (input) => rowFor(String((input && (input.chatId || input.chat_id)) || '4242')),
        getConversationByChatId: async (id) => conversations.get(String(id)) || null,
        insertMessage: async (m) => ({ id: ++nextId, created_at: new Date().toISOString(), ...m }),
        appendMessage: async (m) => ({ id: ++nextId, created_at: new Date().toISOString(), ...m }),
        setConversationContext: async () => ({ ok: true }),
        setConversationLanguage: async () => ({ ok: true }),
        recordSend: async () => ({ ok: true })
    };
    const transport = {
        sendMessage: async (chatId, text, options) => { sent.push({ chatId: String(chatId), text: String(text), options }); return { ok: true, message_id: ++nextId }; },
        answerCallbackQuery: async () => ({ ok: true }),
        getMe: async () => ({ ok: true, result: { username: 'KalderixSupportBot' } })
    };
    const bot = createTelegramSupportBot({
        config: { token: '123456:TEST-TOKEN', webhookSecret: 'test-secret', baseUrl: 'https://arbitrix.pro', supportChatId: '', adminIds: [], notifyTarget: 'group' },
        store,
        transport,
        logger: { log() {}, warn() {}, error() {}, info() {} },
        supportAI
    });
    return { bot, sent };
}

test('the Telegram bot answers from the same shared knowledge provider', async () => {
    const supportAI = ai();
    const { bot, sent } = fakeBot(supportAI);
    await bot.handleUpdate({ update_id: 9001, message: { message_id: 11, date: 1, chat: { id: '4242', type: 'private' }, from: { id: '4242', first_name: 'Ana' }, text: 'are there any fees' } });
    const reply = sent.map((s) => s.text).join('\n');
    assert.match(reply, /Kalderix Pro at \$7 per month/, 'the bot must return the approved fee answer, got: ' + reply.slice(0, 160));

    const { bot: bot2, sent: sent2 } = fakeBot(ai());
    await bot2.handleUpdate({ update_id: 9002, message: { message_id: 12, date: 1, chat: { id: '4243', type: 'private' }, from: { id: '4243', first_name: 'Bo' }, text: 'What is Kalderix and how does it work?' } });
    const reply2 = sent2.map((s) => s.text).join('\n');
    assert.match(reply2, /arbitrage/i);
    assert.doesNotMatch(reply2, /I do not have an approved answer/i, 'must not fall back for this question');
});

// --------------------------------------------------------------- branding
test('support-channel branding is Kalderix Support everywhere it is visible', () => {
    const start = INDEX.indexOf('const NS_TRANSLATIONS = ');
    const ns = JSON.parse(INDEX.slice(INDEX.indexOf('{', start), INDEX.indexOf('};', start) + 1));
    ['en', 'es', 'pt', 'fr', 'ar', 'zh'].forEach((lang) => {
        assert.match(ns[lang]['ns.title'], /Kalderix/, lang + ' title must carry the brand');
        assert.match(ns[lang]['ns.welcome'], /Kalderix/, lang + ' welcome must carry the brand');
        assert.match(ns[lang]['admin.supp.inbox'], /Kalderix/, lang + ' admin inbox must carry the brand');
    });
    assert.strictEqual(ns.en['ns.title'], 'Kalderix Support', 'exact in-app name');
    assert.doesNotMatch(INDEX, /Kalderix Support Assistant/, 'the old insecure label must be gone');
    const legacy = [...INDEX.matchAll(/support\.assistant\.name': '([^']*)'/g)].map((m) => m[1]);
    assert.strictEqual(legacy.length, 6);
    legacy.forEach((v) => assert.match(v, /Kalderix/));
    assert.match(DOC, /Kalderix Telegram Assistant/, 'the BotFather display name is documented');
});
