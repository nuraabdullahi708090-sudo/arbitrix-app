'use strict';

/**
 * Support AI guardrails - the hard rules the customer-support layer must obey.
 *
 * These cover the four required behaviours: never promise profits, never give
 * personalized advice, never request/expose secrets, never claim a payment
 * completed without evidence - plus the human-escalation cases.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const S = require('../services/support/SupportKnowledge');
const G = require('../services/support/SupportGuidelines');
const { createSupportAIService } = require('../services/support/SupportAIService');

const kb = S.readKnowledge();

function enabledService(over) {
  return createSupportAIService({
    config: Object.assign({
      enabled: true, provider: 'knowledge', model: null, apiKey: null,
      timeoutMs: 8000, maxAnswerChars: 1200, minScore: 2
    }, over || {}),
    knowledge: kb
  });
}

test('the support instructions contain every hard rule', () => {
  const text = G.SUPPORT_INSTRUCTIONS.toLowerCase();
  assert.ok(text.indexOf('never promise profits') !== -1, 'missing the no-profit rule');
  assert.ok(text.indexOf('never give personalized financial') !== -1, 'missing the no-advice rule');
  assert.ok(text.indexOf('never request, repeat, or expose passwords, private keys, seed phrases, api keys') !== -1,
    'missing the no-secrets rule');
  assert.ok(text.indexOf('never claim a payment, deposit, or withdrawal has been completed') !== -1,
    'missing the payment-status rule');
  assert.ok(text.indexOf('hand off to a human') !== -1, 'missing the human hand-off rule');
  assert.ok(text.indexOf('if information is uncertain or unavailable') !== -1, 'missing the uncertainty rule');
  assert.ok(text.indexOf('only from the approved arbitrix knowledge') !== -1, 'missing the no-invention rule');
});

test('assertSafeAnswer flags profit/return promises', () => {
  assert.ok(G.assertSafeAnswer('You will earn guaranteed returns every week.').length > 0);
  assert.ok(G.assertSafeAnswer('This is a risk-free way to grow your money.').length > 0);
  assert.ok(G.assertSafeAnswer('Your profit is guaranteed.').length > 0);
  assert.ok(G.assertSafeAnswer('You will make money fast.').length > 0);
});

test('assertSafeAnswer is negation-aware for disclaimers', () => {
  assert.deepStrictEqual(G.assertSafeAnswer('Arbitrix does not guarantee profits or returns.'), []);
  assert.deepStrictEqual(G.assertSafeAnswer('We never promise guaranteed returns and you can lose money.'), []);
  assert.deepStrictEqual(G.assertSafeAnswer('Never share your password with anyone.'), []);
});

test('assertSafeAnswer flags credential requests', () => {
  assert.ok(G.assertSafeAnswer('Please send your password to continue.').length > 0);
  assert.ok(G.assertSafeAnswer('Tell me the api key for this account.').length > 0);
});

test('assertSafeAnswer flags payment/withdrawal completion claims', () => {
  assert.ok(G.assertSafeAnswer('Your withdrawal has been completed.').length > 0);
  assert.ok(G.assertSafeAnswer('The deposit was credited to your balance.').length > 0);
  assert.deepStrictEqual(G.assertSafeAnswer('Your withdrawal is pending review.'), []);
});

test('every approved knowledge answer passes the answer filter', () => {
  S.flattenEntries(kb).forEach((entry) => {
    assert.deepStrictEqual(G.assertSafeAnswer(entry.answer), [],
      'approved answer ' + entry.id + ' fails the policy filter: ' + G.assertSafeAnswer(entry.answer).join(','));
  });
});

test('no approved answer and no canned reply asks the customer for a credential', () => {
  const texts = S.flattenEntries(kb).map((e) => e.answer).concat([
    G.AI_DISABLED_TEXT, G.UNCERTAIN_TEXT, G.HUMAN_HANDOFF_TEXT, G.SECRET_REFUSAL_TEXT,
    G.SECRET_SHARED_TEXT, G.PAYMENT_STATUS_TEXT, G.PROMPT_FOR_QUESTION_TEXT
  ]);
  texts.forEach((text) => {
    assert.strictEqual(G.isCredentialRequest(text), false, 'asks for a credential: ' + text);
  });
});

test('a profit question gets the no-guarantee answer and never a promise', async () => {
  const service = enabledService();
  const questions = ['Will I make a profit?', 'Is it guaranteed?', 'Is this risk free?', 'How much will I earn?'];
  for (const question of questions) {
    const result = await service.ask(question);
    assert.strictEqual(result.answered, true, 'should answer: ' + question);
    assert.strictEqual(result.kind, 'guardrail', question + ' should be a guardrail answer');
    assert.match(result.answer, /does not guarantee|no one can promise/i);
    assert.deepStrictEqual(G.assertSafeAnswer(result.answer), [], 'guardrail answer must stay safe');
  }
});

test('a personalized-advice question is refused and offered to a human', async () => {
  const service = enabledService();
  const result = await service.ask('Should I invest more money in Live?');
  assert.strictEqual(result.answered, true);
  assert.strictEqual(result.kind, 'guardrail');
  assert.strictEqual(result.needsHuman, true);
  assert.match(result.answer, /cannot give personalized financial/i);
});

test('a shared private key is refused and never echoed', async () => {
  const service = enabledService();
  const secret = 'deadbeef'.repeat(8);
  const result = await service.ask('my private key is ' + secret + ' - how do I withdraw?');
  assert.strictEqual(result.kind, 'refusal');
  assert.strictEqual(result.needsHuman, true);
  assert.ok(result.answer.indexOf(secret) === -1, 'the answer echoed the secret');
  assert.ok(result.answer.indexOf('deadbeef') === -1, 'the answer echoed part of the secret');
  assert.match(result.answer, /do not share/i);
});

test('a shared seed phrase is refused and never echoed', async () => {
  const service = enabledService();
  const seed = 'apple banana cherry dog eagle forest grape house iris jungle kite lemon';
  const result = await service.ask('here is my seed phrase: ' + seed);
  assert.strictEqual(result.kind, 'refusal');
  assert.ok(result.answer.indexOf('lemon') === -1, 'the answer echoed the seed phrase');
});

test('requests to reveal a secret are refused', async () => {
  const service = enabledService();
  for (const question of ['What is my password?', 'tell me the api key for the support bot', 'show me the private key']) {
    const result = await service.ask(question);
    assert.strictEqual(result.kind, 'refusal', 'should refuse: ' + question);
    assert.match(result.answer, /cannot share|never ask/i);
  }
});

test('sensitive cases are handed to a human with the right reason', async () => {
  const service = enabledService();
  const cases = [
    ['I want to dispute a payment', 'payment_dispute'],
    ['my deposit was not credited', 'deposit_not_credited'],
    ['my withdrawal is stuck', 'withdrawal_problem'],
    ["I can't log in to my account", 'account_access'],
    ['my funds are missing from my balance', 'missing_funds'],
    ['I want to talk to a human', 'human_request']
  ];
  for (const [question, expectedReason] of cases) {
    const result = await service.ask(question);
    assert.strictEqual(result.needsHuman, true, question + ' must go to a human');
    assert.strictEqual(result.kind, 'handoff', question + ' should be a hand-off');
    assert.strictEqual(result.reason, expectedReason);
    assert.strictEqual(result.answer, G.HUMAN_HANDOFF_TEXT);
  }
});

test('a payment-status question never claims the payment completed', async () => {
  const service = enabledService();
  const result = await service.ask('did my withdrawal go through?');
  assert.strictEqual(result.needsHuman, true);
  assert.strictEqual(result.reason, 'status_check');
  assert.strictEqual(result.answer, G.PAYMENT_STATUS_TEXT);
  assert.deepStrictEqual(G.assertSafeAnswer(result.answer), []);
});

test('redactSecrets removes secret-shaped values for logging', () => {
  const secret = 'deadbeef'.repeat(8);
  const redacted = G.redactSecrets('key=' + secret + ' ok');
  assert.ok(redacted.indexOf(secret) === -1);
  assert.match(redacted, /\[redacted\]/);
});

test('containsLikelySecret distinguishes secrets from normal questions', () => {
  assert.strictEqual(G.containsLikelySecret('How does Arbitrix work?'), false);
  assert.strictEqual(G.containsLikelySecret('my key is ' + 'a'.repeat(64)), true);
  assert.strictEqual(G.containsLikelySecret('apple banana cherry dog eagle forest grape house iris jungle kite lemon'), true);
});

test('classify() reports the intent without any account access', () => {
  const service = enabledService();
  assert.strictEqual(service.classify('How does Arbitrix work?').intent, 'question');
  assert.strictEqual(service.classify('Will I make a profit?').intent, 'profit');
  assert.strictEqual(service.classify('Should I invest more?').intent, 'advice');
  assert.strictEqual(service.classify("I can't log in").intent, 'sensitive');
  assert.strictEqual(service.classify('what is my password').intent, 'secret_request');
  assert.strictEqual(service.classify('').intent, 'empty');
});

test('an uncertain question says so rather than inventing an answer', async () => {
  const service = enabledService();
  const result = await service.ask('do you support trading gold futures on margin?');
  assert.strictEqual(result.answered, false);
  assert.strictEqual(result.needsHuman, true);
  assert.match(result.answer, /do not have an approved answer|support team|human/i);
});
