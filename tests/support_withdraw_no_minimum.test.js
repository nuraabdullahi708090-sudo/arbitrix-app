'use strict';

/**
 * Regression - "Can I withdraw $200?"
 *
 * Two properties must hold together:
 *   1. the final answer MAY state that there is no minimum withdrawal (the approved
 *      management decision, recorded as the `withdrawal_minimum` knowledge conflict), and
 *   2. the $200 the CUSTOMER typed must not be mistaken for an unsupported claim.
 *
 * Mechanism being pinned: `SupportGuidelines.findUnsupportedClaims()` grounds a
 * generated ANSWER against the APPROVED KNOWLEDGE retrieved for that question. The
 * customer's own message is never part of that grounding corpus, so a figure the
 * customer supplies cannot cause the answer to be discarded as ungrounded.
 *
 * The guard must NOT be weakened to achieve this: an amount the model INVENTED is
 * still rejected, and the last test documents the deliberately conservative case
 * where a model echoes the customer's own figure back as an assertion.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSupportAIService, resolveSupportAIConfig } = require('../services/support/SupportAIService');
const S = require('../services/support/SupportKnowledge');
const G = require('../services/support/SupportGuidelines');

const KB = S.readKnowledge();
const QUESTION = 'Can I withdraw $200?';
const NO_MINIMUM = /no minimum withdrawal/i;
const MIN_SCORE = 2;

// Test-only configuration. AI is enabled IN PROCESS for these assertions; nothing
// in the deployment is touched and AI_SUPPORT_ENABLED stays false in the wild.
const KNOWLEDGE_CONFIG = resolveSupportAIConfig({
  AI_SUPPORT_ENABLED: 'true',
  AI_SUPPORT_PROVIDER: 'knowledge'
});

// Placeholder, never a credential: it only ever reaches a stubbed fetch.
const MODEL_CONFIG = resolveSupportAIConfig({
  AI_SUPPORT_ENABLED: 'true',
  AI_SUPPORT_PROVIDER: 'deepseek',
  AI_SUPPORT_API_KEY: 'PLACEHOLDER-NOT-A-CREDENTIAL'
});

function serviceWith(config, fetchImpl) {
  return createSupportAIService({ config, knowledge: KB, fetchImpl });
}

/** A model that behaves: it echoes the approved answer it was given. */
const echoApproved = async (url, init) => {
  const body = JSON.parse(init.body);
  const match = String(body.messages[1].content).match(/\n\s+A: (.+)/);
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: match ? match[1].trim() : 'NO_ANSWER' } }] })
  };
};

function retrieving() {
  return S.createRetriever(KB, { minScore: MIN_SCORE });
}

// ---------------------------------------------------------- knowledge intact ---

test('the approved knowledge still answers that there is no minimum withdrawal', () => {
  const retriever = retrieving();
  ['withdrawals.minimum', 'withdrawals.requirements'].forEach((id) => {
    const entry = retriever.getEntry(id);
    assert.ok(entry, 'the approved knowledge must still contain ' + id);
    assert.match(entry.answer, NO_MINIMUM, id + ' must still state there is no minimum withdrawal');
  });
});

test('the $200 question retrieves a withdrawal entry rather than falling through', () => {
  const hits = retrieving().retrieve(QUESTION);
  assert.ok(hits.length > 0, 'the question must retrieve approved knowledge');
  assert.strictEqual(hits[0].category, 'withdrawals', 'the top hit should be a withdrawal entry');
  assert.ok(hits[0].score >= MIN_SCORE, 'the match must clear the retrieval threshold');
});

// ------------------------------------------------------- the two requirements ---

test('the default knowledge provider answers "Can I withdraw $200?" with no minimum and no false claim', async () => {
  const service = serviceWith(KNOWLEDGE_CONFIG);
  const hits = service.retrieve(QUESTION);
  const result = await service.ask(QUESTION);

  // 1. the answer may state there is no minimum withdrawal
  assert.match(result.answer, NO_MINIMUM, 'the answer must state there is no minimum withdrawal');

  // ... and the question is still answered, not degraded to a hand-off
  assert.strictEqual(result.answered, true);
  assert.strictEqual(result.needsHuman, false);
  assert.strictEqual(result.kind, 'answer');
  assert.notStrictEqual(result.answer, G.UNCERTAIN_TEXT, 'the answer must not collapse to the uncertain fallback');

  // 2. the customer's $200 is not treated as an unsupported claim
  assert.strictEqual(result.filtered, false, 'the answer must not be replaced by the groundedness guard');
  assert.deepStrictEqual(result.unsupportedClaims, []);
  assert.deepStrictEqual(G.assertSafeAnswer(result.answer), []);
  assert.deepStrictEqual(G.findUnsupportedClaims(result.answer, hits), []);
});

test('the same holds when an external model produces the answer', async () => {
  const service = serviceWith(MODEL_CONFIG, echoApproved);
  const hits = service.retrieve(QUESTION);
  const result = await service.ask(QUESTION);

  assert.match(result.answer, NO_MINIMUM);
  assert.strictEqual(result.answered, true);
  assert.strictEqual(result.filtered, false);
  assert.deepStrictEqual(result.unsupportedClaims, []);
  assert.deepStrictEqual(G.findUnsupportedClaims(result.answer, hits), []);
});

test('the customer\'s figure never enters the grounding corpus', async () => {
  const service = serviceWith(MODEL_CONFIG, echoApproved);
  const hits = service.retrieve(QUESTION);

  // The retrieved approved knowledge carries no $200 - the customer's message is not
  // a source of truth, so it cannot both supply and satisfy a claim.
  assert.ok(!JSON.stringify(hits).includes('$200'), 'the question must not leak into the approved knowledge');

  // Classification is a function of the ANSWER only. "$200" is indeed absent from the
  // approved knowledge, yet the real answer above is not flagged because it never
  // asserts that figure. The question's $200 is therefore never classified at all.
  assert.deepStrictEqual(G.findUnsupportedClaims('$200', hits), ['$200']);
  const result = await service.ask(QUESTION);
  assert.deepStrictEqual(result.unsupportedClaims, []);
});

test('formats of the same question behave identically', async () => {
  const service = serviceWith(KNOWLEDGE_CONFIG);
  for (const variant of ['Can I withdraw $200?', 'can i withdraw $200', 'I want to withdraw 200']) {
    const result = await service.ask(variant);
    assert.match(result.answer, NO_MINIMUM, 'should state no minimum for: ' + variant);
    assert.deepStrictEqual(result.unsupportedClaims, [], 'no false claim for: ' + variant);
  }
});

test('the "200 USDT" variant now reaches the withdrawal entry (ranking fixed)', async () => {
  // Previously this variant tied 2-2 with deposits.asset and lost the tie
  // alphabetically, so it received the deposit-network answer. Intent-aware ranking
  // (QUERY_INTENTS in SupportKnowledge.js) now routes it to the withdrawal entry.
  // The safety and non-classification properties still hold.
  const service = serviceWith(MODEL_CONFIG, echoApproved);
  const result = await service.ask('Can I withdraw 200 USDT?');

  assert.match(result.answer, NO_MINIMUM, 'must now state there is no minimum withdrawal');
  assert.strictEqual(result.entryId, 'withdrawals.requirements');
  assert.strictEqual(result.category, 'withdrawals');
  assert.strictEqual(result.answered, true, 'the variant must still be answered, not handed off');
  assert.deepStrictEqual(G.assertSafeAnswer(result.answer), []);
  assert.deepStrictEqual(result.unsupportedClaims, [], 'the figure in the question must not become a claim');
  assert.strictEqual(result.filtered, false);
});

// ------------------------------------------- the guard must not be weakened ---

test('an INVENTED amount is still rejected and replaced', async () => {
  const invented = 'You must withdraw a minimum of $500 and keep $1,000 in your account.';
  const service = serviceWith(MODEL_CONFIG, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: invented } }] })
  }));

  const result = await service.ask(QUESTION);
  assert.strictEqual(result.filtered, true, 'an invented figure must be filtered');
  assert.ok(!result.answer.includes('$500'), 'the invented amount must not survive');
  assert.ok(!result.answer.includes('$1,000'), 'the invented amount must not survive');
  // The replacement is still a correct, useful answer.
  assert.match(result.answer, NO_MINIMUM);
  assert.deepStrictEqual(G.assertSafeAnswer(result.answer), []);
});

test('a model echoing the customer\'s own $200 back as an assertion is conservatively replaced', async () => {
  // Documented trade-off rather than a bug: asserting "you can withdraw $200" about a
  // specific amount is a claim about the customer's case, so the groundedness guard
  // replaces it. Requirement 1 still holds afterwards.
  const service = serviceWith(MODEL_CONFIG, async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'Yes - you can withdraw $200. There is no minimum withdrawal amount.' } }]
    })
  }));

  const result = await service.ask(QUESTION);
  assert.strictEqual(result.filtered, true);
  assert.ok(result.unsupportedClaims.includes('$200'), 'the echoed figure is detected');
  assert.match(result.answer, NO_MINIMUM, 'the customer still gets the correct no-minimum answer');
  assert.ok(!result.answer.includes('$200'), 'the ungrounded figure is not asserted back to the customer');
  assert.deepStrictEqual(G.assertSafeAnswer(result.answer), []);
});
