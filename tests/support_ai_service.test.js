'use strict';

/**
 * SupportAIService - answering, refusal, feature flag and provider abstraction.
 *
 * Stage 1 behaviour: the service answers beginner questions from the approved
 * knowledge base, refuses to invent when the knowledge does not cover a
 * question, hands sensitive cases to a human, is OFF by default, and is not
 * connected to Telegram in any way.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const S = require('../services/support/SupportKnowledge');
const SupportAIService = require('../services/support/SupportAIService');
const providers = require('../services/support/providers');

const { resolveSupportAIConfig, describeSupportAIConfig, createSupportAIService } = SupportAIService;
const kb = S.readKnowledge();
const ROOT = path.join(__dirname, '..');

function enabledConfig(over) {
  return Object.assign({
    enabled: true,
    provider: 'knowledge',
    model: null,
    apiKey: null,
    timeoutMs: 8000,
    maxAnswerChars: 1200,
    minScore: 2
  }, over || {});
}

function makeService(over, opts) {
  return createSupportAIService(Object.assign({ config: enabledConfig(over), knowledge: kb }, opts || {}));
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test('AI support is OFF by default and only an explicit "true" enables it', () => {
  assert.strictEqual(resolveSupportAIConfig({}).enabled, false);
  assert.strictEqual(resolveSupportAIConfig({ AI_SUPPORT_ENABLED: '' }).enabled, false);
  assert.strictEqual(resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'false' }).enabled, false);
  assert.strictEqual(resolveSupportAIConfig({ AI_SUPPORT_ENABLED: '1' }).enabled, false);
  assert.strictEqual(resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'yes' }).enabled, false);
  assert.strictEqual(resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true' }).enabled, true);

  const off = createSupportAIService({ config: resolveSupportAIConfig({}), knowledge: kb });
  assert.strictEqual(off.isEnabled(), false);
  assert.strictEqual(off.describe().enabled, false);
});

test('a disabled service does not retrieve or generate anything', async () => {
  let generated = 0;
  let retrieved = 0;
  const provider = {
    name: 'spy', kind: 'local', requiresApiKey: false, available: true,
    async generate() { generated += 1; return { text: 'SHOULD NOT BE USED' }; }
  };
  const retriever = S.createRetriever(kb);
  const originalRetrieve = retriever.retrieve.bind(retriever);
  retriever.retrieve = (question, opts) => { retrieved += 1; return originalRetrieve(question, opts); };

  const service = createSupportAIService({
    config: resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'false' }),
    knowledge: kb,
    provider,
    retriever
  });

  const result = await service.ask('How does Arbitrix work?');
  assert.strictEqual(result.enabled, false);
  assert.strictEqual(result.answered, false);
  assert.strictEqual(result.needsHuman, true);
  assert.strictEqual(result.kind, 'disabled');
  assert.strictEqual(result.answer, 'Automated answers are currently turned off. I have saved your message and a member of our support team will help you here.');
  assert.strictEqual(generated, 0, 'a disabled service must not call the provider');
  assert.strictEqual(retrieved, 0, 'a disabled service must not retrieve knowledge');
});

test('known beginner questions are answered from the approved knowledge', async () => {
  const service = makeService();
  const cases = [
    ['How does Arbitrix work?', /arbitrage/i],
    ['How do I get started?', /create your account/i],
    ['What is the minimum deposit?', /\$100/],
    ['Can I use Demo Mode?', /\$1,000/],
    ['How do withdrawals work?', /qualifying first deposit/i],
    ['What is the minimum withdrawal?', /no minimum withdrawal/i],
    ['How long does withdrawal take?', /15-30 minutes/i],
    ['What is the referral program?', /20%/],
    ['What is the $50 promotional credit?', /\$50/],
    ['How much is the subscription?', /\$7/],
    ['Do I need to verify my identity?', /does not require identity verification/i]
  ];
  for (const [question, expected] of cases) {
    const result = await service.ask(question);
    assert.strictEqual(result.answered, true, 'should answer: ' + question);
    assert.ok(expected.test(result.answer), 'answer for "' + question + '" did not match ' + expected + ' -> ' + result.answer);
    assert.ok(result.entryId, 'answer should cite the knowledge entry for: ' + question);
    assert.strictEqual(result.provider, 'knowledge');
  }
});

test('answers never contain stale MTA figures or invented amounts', async () => {
  const service = makeService();
  const questions = [
    'How does Arbitrix work?', 'How do I get started?', 'What is the minimum deposit?',
    'Can I use Demo Mode?', 'How do withdrawals work?', 'What is the minimum withdrawal?',
    'What is the referral program?', 'What is the $50 promotional credit?', 'How much is the subscription?'
  ];
  for (const question of questions) {
    const result = await service.ask(question);
    assert.ok(!/\$143|\$200/.test(result.answer), 'answer mentions a removed MTA figure: ' + result.answer);
  }
});

test('an unknown question refuses to invent and offers a human', async () => {
  const service = makeService();
  const result = await service.ask('what is the weather in paris tomorrow');
  assert.strictEqual(result.answered, false);
  assert.strictEqual(result.needsHuman, true);
  assert.strictEqual(result.kind, 'unknown');
  assert.match(result.answer, /support team|human/i);
  assert.strictEqual(result.entryId, null);
});

test('the default provider needs no API key and makes no network calls', () => {
  const knowledge = providers.createProvider('knowledge', {});
  assert.strictEqual(knowledge.name, 'knowledge');
  assert.strictEqual(knowledge.requiresApiKey, false);
  assert.strictEqual(knowledge.available, true);

  const openaiWithoutKey = providers.createProvider('openai', {});
  assert.strictEqual(openaiWithoutKey.available, false, 'an HTTP provider must be inert without a key');

  const typo = providers.createProvider('opemai', {});
  assert.strictEqual(typo.name, 'knowledge', 'an unknown provider name must fall back to knowledge');
});

test('an HTTP provider is configurable but inert until a key exists, and scrubs its key', async () => {
  const KEY = 'sk-test-DO-NOT-LOG-1234567890';
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse(200, { choices: [{ message: { content: 'Approved answer.' } }] });
  };
  const provider = providers.createProvider('openai', { apiKey: KEY, fetchImpl });
  assert.strictEqual(provider.available, true);

  const hits = S.createRetriever(kb).retrieve('What is the minimum deposit?');
  const out = await provider.generate({ question: 'What is the minimum deposit?', hits, instructions: 'SYS' });
  assert.strictEqual(out.text, 'Approved answer.');
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.strictEqual(requests[0].init.method, 'POST');
  assert.strictEqual(requests[0].init.headers.Authorization, 'Bearer ' + KEY);
  const body = JSON.parse(requests[0].init.body);
  assert.strictEqual(body.model, providers.DEFAULT_OPENAI_MODEL);
  assert.strictEqual(body.messages[0].role, 'system');
  assert.ok(body.messages[1].content.indexOf('minimum deposit') !== -1);

  // A provider failure must never leak the key.
  const failing = providers.createProvider('openai', {
    apiKey: KEY,
    fetchImpl: async () => jsonResponse(401, { error: { message: 'bad key ' + KEY } })
  });
  await assert.rejects(
    () => failing.generate({ question: 'x', hits, instructions: 'SYS' }),
    (error) => {
      assert.ok(error.message.indexOf(KEY) === -1, 'provider error leaked the API key');
      assert.match(error.message, /request failed/);
      return true;
    }
  );
});

test('an unavailable provider falls back to the approved knowledge, never inventing', async () => {
  const broken = {
    name: 'broken', kind: 'http', requiresApiKey: true, available: false,
    async generate() { throw new Error('provider down'); }
  };
  const service = makeService({ provider: 'openai' }, { provider: broken });
  const result = await service.ask('What is the minimum deposit?');
  assert.strictEqual(result.answered, true);
  assert.match(result.answer, /\$100/);
  assert.strictEqual(result.reason, 'provider-fallback');
});

test('provider configuration is env-driven and never exposes the key', () => {
  const KEY = 'sk-live-DO-NOT-LOG-abcdef';
  const cfg = resolveSupportAIConfig({
    AI_SUPPORT_ENABLED: 'true',
    AI_SUPPORT_PROVIDER: 'openai',
    AI_SUPPORT_MODEL: 'my-model',
    AI_SUPPORT_API_KEY: KEY
  });
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.provider, 'openai');
  assert.strictEqual(cfg.model, 'my-model');
  assert.strictEqual(cfg.apiKey, KEY);

  const described = describeSupportAIConfig(cfg);
  assert.strictEqual(described.hasApiKey, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(described, 'apiKey'), false);
  assert.ok(JSON.stringify(described).indexOf(KEY) === -1, 'describe() leaked the API key');

  // Provider-specific fallbacks, and a default of no key at all.
  assert.strictEqual(resolveSupportAIConfig({ AI_SUPPORT_PROVIDER: 'openai', OPENAI_API_KEY: 'k1' }).apiKey, 'k1');
  assert.strictEqual(resolveSupportAIConfig({ AI_SUPPORT_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k2' }).apiKey, 'k2');
  assert.strictEqual(resolveSupportAIConfig({ AI_SUPPORT_PROVIDER: 'knowledge' }).apiKey, null);

  const service = makeService();
  assert.ok(JSON.stringify(service.describe()).indexOf('apiKey') === -1);
  assert.deepStrictEqual(service.describe().supportedProviders, ['knowledge', 'openai', 'anthropic', 'deepseek']);
});

test('generated answers are capped by AI_SUPPORT_MAX_ANSWER_CHARS', async () => {
  const service = makeService({ maxAnswerChars: 60 });
  const result = await service.ask('How does Arbitrix work?');
  assert.ok(result.answer.length <= 60, 'answer exceeded the configured cap: ' + result.answer.length);
  assert.ok(result.answer.endsWith('\u2026'));
});

test('knowledge metadata reports the version, size and unresolved conflicts', () => {
  const service = makeService();
  const meta = service.knowledgeMeta();
  assert.strictEqual(meta.version, kb.version);
  assert.strictEqual(meta.entryCount, S.flattenEntries(kb).length);
  assert.ok(meta.conflicts.some((c) => c.id === 'withdrawal_minimum'));
});

test('the AI support layer is wired ONLY into the support flow, never into trading', () => {
  // Stage 2 connects the AI to the Telegram customer-support flow. Everything
  // else - particularly the trading worker - must stay free of it.
  ['worker.js', 'services/TradingWorker.js', 'services/PromoCheck.js'].forEach((relative) => {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.ok(source.indexOf('SupportAIService') === -1, relative + ' must not import the support AI service');
    assert.ok(source.indexOf('arbitrix-knowledge') === -1, relative + ' must not load the support knowledge base');
    assert.ok(source.indexOf('AI_SUPPORT_ENABLED') === -1, relative + ' must not read the AI feature flag');
  });

  // The Telegram flow consumes it as an OPTIONAL collaborator.
  const telegram = fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportService.js'), 'utf8');
  assert.match(telegram, /supportAI/);

  // The service itself is self-contained: it requires nothing from Telegram,
  // Supabase or the trading stack, and holds no database handle.
  const ai = fs.readFileSync(path.join(ROOT, 'services', 'support', 'SupportAIService.js'), 'utf8');
  assert.ok(!/require\([^)]*telegram/i.test(ai), 'the AI service must not require Telegram code');
  assert.ok(!/require\([^)]*supabase/i.test(ai), 'the AI service must not require Supabase');
  assert.ok(ai.indexOf('createClient') === -1, 'the AI service must not create a database client');
});
