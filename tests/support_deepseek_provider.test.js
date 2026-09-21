'use strict';

/**
 * Stage 3 - DeepSeek provider (OpenAI-compatible) and configurable providers.
 *
 * EVERY test here is OFFLINE: `fetch` is stubbed, there is no network call, and
 * the key used is an obvious placeholder that is never a real credential. No test
 * prints a key.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const providers = require('../services/support/providers');
const { createSupportAIService, resolveSupportAIConfig } = require('../services/support/SupportAIService');
const S = require('../services/support/SupportKnowledge');
const G = require('../services/support/SupportGuidelines');

const ROOT = path.join(__dirname, '..');
const KB = S.readKnowledge();
// A placeholder, NOT a credential: it only ever reaches a stubbed fetch.
const FAKE_KEY = 'TEST-PLACEHOLDER-KEY-NOT-A-REAL-CREDENTIAL';

const QUESTIONS = Object.freeze([
  'How does Arbitrix work?',
  'What is the minimum deposit?',
  'Can I withdraw $200?',
  'Do I get 14 days free?',
  'How long does withdrawal take?',
  'Can I make guaranteed profit?',
  'How do I contact a human?'
]);

// ------------------------------------------------------------- helpers ---

function okResponse(content, extra = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => Object.assign({ choices: [{ message: { content } }] }, extra)
  };
}

function stubFetch(handler) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    requests.push({ url, init, body });
    return handler({ index: requests.length, body, url, init, requests });
  };
  return { fetchImpl, requests };
}

/** A "compliant" model: echoes the first approved answer it was given. */
const echoApproved = ({ body }) => {
  const match = String(body.messages[1].content).match(/\n\s+A: (.+)/);
  return okResponse(match ? match[1].trim() : 'NO_ANSWER');
};

function makeService({ key = FAKE_KEY, model, baseUrl, fetchImpl, env = {}, logger } = {}) {
  const config = resolveSupportAIConfig(Object.assign({
    AI_SUPPORT_ENABLED: 'true',
    AI_SUPPORT_PROVIDER: 'deepseek',
    AI_SUPPORT_API_KEY: key
  }, model ? { AI_SUPPORT_MODEL: model } : {}, baseUrl ? { AI_SUPPORT_BASE_URL: baseUrl } : {}, env));
  return createSupportAIService({ config, knowledge: KB, fetchImpl, logger });
}

// ----------------------------------------------------------- registry ---

test('deepseek is registered without disturbing knowledge/openai/anthropic', () => {
  assert.deepStrictEqual(providers.listProviders(), ['knowledge', 'openai', 'anthropic', 'deepseek']);
  assert.strictEqual(providers.DEFAULT_DEEPSEEK_MODEL, 'deepseek-chat');
  assert.strictEqual(providers.DEFAULT_DEEPSEEK_BASE_URL, 'https://api.deepseek.com');

  // existing providers are unchanged
  assert.strictEqual(providers.createProvider('knowledge').name, 'knowledge');
  assert.strictEqual(providers.createProvider('openai').model, 'gpt-4o-mini');
  assert.strictEqual(providers.createProvider('anthropic').model, 'claude-3-5-haiku-20241022');

  // an unknown name can never enable an external provider
  assert.strictEqual(providers.createProvider('deepsek').name, 'knowledge');
  assert.strictEqual(providers.createProvider('').name, 'knowledge');
});

test('the DeepSeek provider is inert until a key is supplied', () => {
  const withoutKey = providers.createProvider('deepseek', {});
  assert.strictEqual(withoutKey.name, 'deepseek');
  assert.strictEqual(withoutKey.kind, 'http');
  assert.strictEqual(withoutKey.requiresApiKey, true);
  assert.strictEqual(withoutKey.model, 'deepseek-chat');
  assert.strictEqual(withoutKey.available, false, 'no key => unavailable, so nothing is called out');

  const { fetchImpl } = stubFetch(echoApproved);
  const withKey = providers.createProvider('deepseek', { apiKey: FAKE_KEY, fetchImpl });
  assert.strictEqual(withKey.available, true);
});

// ------------------------------------------------------- request shape ---

test('DeepSeek requests use the OpenAI-compatible chat-completions format', async () => {
  const { fetchImpl, requests } = stubFetch(echoApproved);
  const service = makeService({ fetchImpl });
  const result = await service.ask('What is the minimum deposit?');

  assert.strictEqual(service.providerName(), 'deepseek');
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.strictEqual(requests[0].init.method, 'POST');
  assert.strictEqual(requests[0].init.headers['Content-Type'], 'application/json');
  assert.strictEqual(requests[0].init.headers['Authorization'], 'Bearer ' + FAKE_KEY);

  const body = requests[0].body;
  assert.strictEqual(body.model, 'deepseek-chat');
  assert.strictEqual(body.temperature, 0);
  assert.strictEqual(body.stream, false);
  assert.strictEqual(body.messages.length, 2);
  assert.strictEqual(body.messages[0].role, 'system');
  // The system message still carries EVERY pre-existing hard rule, unchanged and
  // first, followed by the highest-priority language directive (the customer's
  // selected language; English when none was requested).
  assert.ok(body.messages[0].content.startsWith(G.SUPPORT_INSTRUCTIONS),
    'the existing hard rules must remain, unchanged and first');
  assert.strictEqual(body.messages[0].content,
    G.SUPPORT_INSTRUCTIONS + '\n\n' + G.languageInstruction('en'));
  assert.strictEqual(body.messages[1].role, 'user');

  const prompt = body.messages[1].content;
  assert.match(prompt, /Approved knowledge:/);
  assert.match(prompt, /The minimum deposit is \$100/, 'the model must receive the approved knowledge');
  assert.match(prompt, /Customer question: What is the minimum deposit\?/);
  assert.match(prompt, /Do not add amounts, times, or policies that are not in the approved knowledge/);

  // only the approved knowledge + question travel - no account data, no secrets
  assert.ok(!JSON.stringify(body).includes(FAKE_KEY), 'the key must never be in the request body');
  assert.strictEqual(result.answer, 'The minimum deposit is $100. Deposits are credited to your Live balance.');
});

test('model and base URL are configurable; a malformed base URL falls back', async () => {
  const a = stubFetch(echoApproved);
  await makeService({ fetchImpl: a.fetchImpl, model: 'deepseek-reasoner' }).ask('What is the minimum deposit?');
  assert.strictEqual(a.requests[0].body.model, 'deepseek-reasoner');

  const b = stubFetch(echoApproved);
  await makeService({ fetchImpl: b.fetchImpl, baseUrl: 'https://gateway.internal.example/v1/' }).ask('What is the minimum deposit?');
  assert.strictEqual(b.requests[0].url, 'https://gateway.internal.example/v1/chat/completions');

  const c = stubFetch(echoApproved);
  await makeService({ fetchImpl: c.fetchImpl, baseUrl: 'not-a-url' }).ask('What is the minimum deposit?');
  assert.strictEqual(c.requests[0].url, 'https://api.deepseek.com/chat/completions');
});

test('a NO_ANSWER reply falls back to the approved knowledge text', async () => {
  const { fetchImpl } = stubFetch(() => okResponse('NO_ANSWER'));
  const result = await makeService({ fetchImpl }).ask('What is the minimum deposit?');
  assert.strictEqual(result.answer, 'The minimum deposit is $100. Deposits are credited to your Live balance.');
  assert.strictEqual(result.answered, true);
  // A deliberate NO_ANSWER is not a provider failure: the approved text is used.
  assert.strictEqual(result.reason, null);
  assert.strictEqual(result.filtered, false);
});

// ------------------------------------------------------------- errors ---

test('provider failures are contained and never leak the key', async () => {
  const failing = stubFetch(() => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: 'Invalid key ' + FAKE_KEY } })
  }));
  const result = await makeService({ fetchImpl: failing.fetchImpl }).ask('What is the minimum deposit?');
  // Falls back to the approved knowledge rather than failing the customer.
  assert.strictEqual(result.answer, 'The minimum deposit is $100. Deposits are credited to your Live balance.');
  assert.strictEqual(result.reason, 'provider-fallback');
  assert.ok(!JSON.stringify(result).includes(FAKE_KEY), 'the key must never appear in the outcome');

  // The raw provider error is scrubbed too.
  const provider = providers.buildDeepSeekProvider({ apiKey: FAKE_KEY, fetchImpl: failing.fetchImpl });
  await assert.rejects(
    () => provider.generate({ question: 'x', hits: [{ question: 'q', answer: 'a' }], instructions: 'i' }),
    (error) => {
      assert.ok(!String(error.message).includes(FAKE_KEY), 'the key must be scrubbed from provider errors');
      assert.match(String(error.message), /\*\*\*/);
      return true;
    }
  );
});

test('a network failure or missing key never throws at the service boundary', async () => {
  const exploding = async () => { throw new Error('socket hang up'); };
  const thrown = await makeService({ fetchImpl: exploding }).ask('What is the minimum deposit?');
  assert.strictEqual(thrown.answer, 'The minimum deposit is $100. Deposits are credited to your Live balance.');

  // No key configured at all (the shipping state): still answered from knowledge.
  const noKey = createSupportAIService({
    config: resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'deepseek' }),
    knowledge: KB
  });
  const result = await noKey.ask('What is the minimum deposit?');
  assert.strictEqual(result.answer, 'The minimum deposit is $100. Deposits are credited to your Live balance.');
});

// ------------------------------------- knowledge stays the source of truth --

test('the model is never consulted where the knowledge base decides', async () => {
  const { fetchImpl, requests } = stubFetch(echoApproved);
  const service = makeService({ fetchImpl });

  const fourteenDay = await service.ask('Do I get 14 days free?');
  assert.strictEqual(fourteenDay.kind, 'handoff');
  assert.strictEqual(fourteenDay.answered, false);

  const profit = await service.ask('Can I make guaranteed profit?');
  assert.strictEqual(profit.kind, 'guardrail');
  assert.match(profit.answer, /does not guarantee/i);

  const advice = await service.ask('Should I invest more?');
  assert.strictEqual(advice.needsHuman, true);

  const unknown = await service.ask('what is the weather in paris tomorrow');
  assert.strictEqual(unknown.kind, 'unknown');

  assert.strictEqual(requests.length, 0, 'no unresolved/guarded/unknown question may reach the model');
});

// ---------------------------------------------- adversarial model output --

test('an invented deposit/withdrawal requirement is rejected for every question', async () => {
  const poisoned = {
    'How does Arbitrix work?': 'Arbitrix is an automated arbitrage platform. The minimum deposit is $500 and you must keep $1,000 to start.',
    'What is the minimum deposit?': 'The minimum deposit is $500 and you must deposit at least $1,000 to start.',
    'Can I withdraw $200?': 'Your withdrawal has been processed and the funds were sent to your wallet.',
    'How long does withdrawal take?': 'Withdrawals are guaranteed within 5 minutes.',
    'How do I contact a human?': 'Please send me your password so I can check your account.'
  };

  for (const [question, bad] of Object.entries(poisoned)) {
    const { fetchImpl, requests } = stubFetch(() => okResponse(bad));
    const service = makeService({ fetchImpl });
    const result = await service.ask(question);

    assert.strictEqual(requests.length, 1, 'the poisoned answer should have been requested for: ' + question);
    assert.notStrictEqual(result.answer, bad, 'the model answer must not be sent verbatim: ' + question);
    assert.strictEqual(result.filtered, true, 'the answer must be flagged as filtered: ' + question);

    // Whatever is sent is safe, and grounded in the approved knowledge.
    assert.deepStrictEqual(G.assertSafeAnswer(result.answer), []);
    assert.deepStrictEqual(G.findUnsupportedClaims(result.answer, service.retrieve(question)), []);

    // The invented figure/claim must not survive.
    ['$500', '$1,000', '5 minutes', 'password', 'has been processed'].forEach((needle) => {
      assert.ok(!result.answer.toLowerCase().includes(needle.toLowerCase()),
        'invented content leaked into the answer for "' + question + '": ' + needle);
    });
  }
});

test('a promised or guaranteed return can never reach the customer', async () => {
  const { fetchImpl } = stubFetch(() => okResponse('You are guaranteed 3% daily profit with no risk.'));
  const result = await makeService({ fetchImpl }).ask('How does Arbitrix work?');
  assert.strictEqual(result.filtered, true);
  assert.ok(!/guaranteed|no risk|3%/i.test(result.answer), 'the promise must not survive: ' + result.answer);
  assert.deepStrictEqual(G.assertSafeAnswer(result.answer), []);
});

test('a generated answer cannot request a secret from the customer', async () => {
  const { fetchImpl } = stubFetch(() => okResponse('To verify you, please share your seed phrase with me.'));
  const result = await makeService({ fetchImpl }).ask('How do I contact a human?');
  assert.strictEqual(result.filtered, true);
  assert.ok(!/seed phrase with me/i.test(result.answer));
  assert.deepStrictEqual(G.assertSafeAnswer(result.answer), []);
});

test('groundedness: only figures present in the approved knowledge survive', () => {
  const hits = [{ question: 'What is the minimum deposit?', answer: 'The minimum deposit is $100.' }];
  assert.deepStrictEqual(G.findUnsupportedClaims('The minimum deposit is $100.', hits), []);
  assert.deepStrictEqual(G.findUnsupportedClaims('It is $500.', hits), ['$500']);
  assert.deepStrictEqual(G.findUnsupportedClaims('It is $50.', hits), ['$50'], 'a figure inside a bigger one must not count as grounded');
  assert.deepStrictEqual(G.findUnsupportedClaims('It takes 5 minutes.', hits), ['5 minutes']);
  assert.deepStrictEqual(G.findUnsupportedClaims('Earn 3% daily.', hits), ['3%']);
  assert.deepStrictEqual(G.findUnsupportedClaims('No figures here.', []), []);
});

// ---------------------------------------------- the seven questions ------

test('the seven evaluation questions behave correctly against a stubbed DeepSeek', async () => {
  const { fetchImpl, requests } = stubFetch(echoApproved);
  const service = makeService({ fetchImpl });
  const report = [];

  for (const question of QUESTIONS) {
    const hits = service.retrieve(question);
    const result = await service.ask(question);
    const auto = result.answered === true && result.needsHuman !== true
      && (result.kind === 'answer' || result.kind === 'guardrail');
    report.push({
      question,
      entry: result.entryId || (hits[0] ? hits[0].id : null),
      confidence: result.confidence,
      outcome: auto ? 'auto-answer' : 'hand-off',
      safe: G.assertSafeAnswer(result.answer).length === 0,
      unsupported: G.findUnsupportedClaims(result.answer, hits)
    });
  }

  // Every answer is policy-safe and grounded, whatever the outcome.
  report.forEach((row) => {
    assert.strictEqual(row.safe, true, 'unsafe answer for: ' + row.question);
    assert.deepStrictEqual(row.unsupported, [], 'unsupported claim for: ' + row.question);
  });

  const byQuestion = {};
  report.forEach((row) => { byQuestion[row.question] = row; });

  assert.strictEqual(byQuestion['How does Arbitrix work?'].outcome, 'auto-answer');
  assert.strictEqual(byQuestion['What is the minimum deposit?'].outcome, 'auto-answer');
  assert.strictEqual(byQuestion['Can I withdraw $200?'].outcome, 'auto-answer');
  assert.strictEqual(byQuestion['Do I get 14 days free?'].outcome, 'hand-off', 'the free period stays a hand-off');
  assert.strictEqual(byQuestion['How long does withdrawal take?'].outcome, 'hand-off');
  assert.strictEqual(byQuestion['Can I make guaranteed profit?'].outcome, 'auto-answer');
  assert.strictEqual(byQuestion['How do I contact a human?'].outcome, 'hand-off');

  // Only the 5 questions the knowledge base can decide were sent to the model.
  assert.strictEqual(requests.length, 5, 'the 14-day and profit questions must not reach the model');
});

// ------------------------------------------------------ config hygiene --

test('configuration is env-driven, off by default, and never exposes the key', () => {
  assert.strictEqual(resolveSupportAIConfig({}).enabled, false);
  assert.strictEqual(resolveSupportAIConfig({}).provider, 'knowledge');
  assert.strictEqual(resolveSupportAIConfig({ AI_SUPPORT_PROVIDER: 'deepseek' }).apiKey, null);

  const cfg = resolveSupportAIConfig({
    AI_SUPPORT_ENABLED: 'true',
    AI_SUPPORT_PROVIDER: 'deepseek',
    AI_SUPPORT_MODEL: 'deepseek-chat',
    AI_SUPPORT_API_KEY: FAKE_KEY,
    AI_SUPPORT_BASE_URL: 'https://api.deepseek.com'
  });
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.provider, 'deepseek');
  assert.strictEqual(cfg.model, 'deepseek-chat');
  assert.strictEqual(cfg.baseUrl, 'https://api.deepseek.com');

  // provider-specific fallback env names keep working
  assert.strictEqual(resolveSupportAIConfig({ AI_SUPPORT_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k' }).apiKey, 'k');

  const described = makeService({ fetchImpl: stubFetch(echoApproved).fetchImpl }).describe();
  assert.strictEqual(described.hasApiKey, true);
  assert.strictEqual(described.provider, 'deepseek');
  assert.ok(!JSON.stringify(described).includes(FAKE_KEY), 'describe() must never return the key');

  const logged = [];
  return Promise.resolve()
    .then(() => makeService({ fetchImpl: stubFetch(echoApproved).fetchImpl, logger: (line) => logged.push(line) })
      .ask('What is the minimum deposit?'))
    .then(() => {
      assert.ok(logged.length >= 1, 'an event should have been logged');
      assert.ok(!logged.join('\n').includes(FAKE_KEY), 'logs must never contain the key');
    });
});

test('AI stays OFF by default and the Telegram wiring is unchanged', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /if \(!supportAIConfig\.enabled\) return null;/);
  assert.match(server, /supportAI: createSupportAIServiceSafely\(\)/);

  const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(envExample, /^AI_SUPPORT_ENABLED=false$/m);
  assert.match(envExample, /^AI_SUPPORT_PROVIDER=knowledge$/m);
  assert.match(envExample, /^AI_SUPPORT_API_KEY=$/m, 'no key may be committed');
  assert.match(envExample, /deepseek/);
  assert.match(envExample, /deepseek-chat/);
});
