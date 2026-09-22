'use strict';

/**
 * Regression - withdrawal-minimum retrieval (Telegram support knowledge).
 *
 * Reported in production: "What is the minimum withdrawal amount" fell through to
 * the generic "I do not have an approved answer" hand-off, while
 * "Is there a minimum withdrawal" was answered correctly.
 *
 * ROOT CAUSE (audited): retrieval is keyword-first and the approved
 * `withdrawals.minimum` entry carried only five keyword phrases, all of which
 * depend on an exact substring ("minimum withdrawal", "withdrawal minimum",
 * "least withdrawal", "how much can i withdraw"). Natural phrasings that reorder
 * the words, or interpose another word, matched NO phrase - so the question either
 * returned nothing (=> no-knowledge hand-off) or fell to the generic
 * `withdrawals.requirements` entry (the bare "withdraw" keyword) instead of the
 * withdrawal-MINIMUM answer.
 *
 * FIX (knowledge-only, additive): the `withdrawals.minimum` entry gained precise
 * natural-language keyword phrases. No keyword was removed, no retrieval/ranking/
 * threshold logic changed, no approved answer text changed, and no other knowledge
 * entry was touched (both properties are asserted below). Every listed phrasing now
 * returns the SAME approved answer: there is no minimum withdrawal.
 *
 * Run: npm test (or: node --test tests/support_withdrawal_minimum_retrieval.test.js)
 */

const test = require('node:test');
const assert = require('node:assert');

const S = require('../services/support/SupportKnowledge');
const { createSupportAIService, resolveSupportAIConfig } = require('../services/support/SupportAIService');
const G = require('../services/support/SupportGuidelines');

const KB = S.readKnowledge();
const retriever = S.createRetriever(KB, { minScore: 2 });
const MIN_ID = 'withdrawals.minimum';
const NO_MINIMUM = /no minimum withdrawal/i;

// AI is enabled IN PROCESS for the end-to-end assertions only; nothing in the
// deployment is touched and the default provider is the offline "knowledge" one.
const KNOWLEDGE_CONFIG = resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'knowledge' });
const service = () => createSupportAIService({ config: KNOWLEDGE_CONFIG, knowledge: KB });

const topHit = (q) => {
  const hits = retriever.retrieve(q);
  return hits.length ? hits[0] : null;
};

// The exact questions named in the brief.
const REQUIRED_QUESTIONS = [
  'What is the minimum withdrawal amount?',
  'Is there a minimum withdrawal?',
  "What's the minimum I can withdraw?",
  'How much can I withdraw at minimum?',
  'Is there a minimum amount for withdrawals?',
  'Can I withdraw a small amount?',
  'What is the least I can withdraw?'
];

// Natural equivalent phrasings - all must resolve to the same approved answer.
const EQUIVALENT_QUESTIONS = [
  'What is the minimum withdrawal amount',
  'Is there a withdrawal minimum?',
  'What is the minimum withdrawal?',
  "What's the minimum withdrawal?",
  'What is the min withdrawal?',
  'What is the minimum I can withdraw?',
  'Is there a minimum amount to withdraw?',
  'Is there a minimum amount I can withdraw?',
  'Can I withdraw small amounts?',
  'Is there a small withdrawal?',
  'What is the least amount I can withdraw?',
  'What is the smallest amount I can withdraw?',
  'What is the smallest withdrawal?',
  'How much do I need to withdraw?',
  'Do I need a minimum to withdraw?'
];

// Unrelated questions: the withdrawal-MINIMUM entry must never even be retrieved.
const UNRELATED_QUESTIONS = [
  'What is the minimum deposit?',
  'Is there a minimum deposit?',
  'How much do I need to deposit?',
  'How do I make a deposit?',
  'What network do I use to deposit USDT?',
  'How long does a withdrawal take?',
  'My withdrawal is stuck or has not arrived',
  'Is my money safe?',
  'Is trading risky?',
  'How much is the subscription?',
  'Can I cancel my subscription?',
  'How do I contact a human?',
  'How do referrals work?',
  'How do I switch between Demo and Live?',
  'I cannot log in',
  'what is the weather in paris tomorrow',
  'Something is wrong with my account'
];

/* ------------------------------------------------------------------ *
 * 1. Every required question retrieves the approved minimum answer
 * ------------------------------------------------------------------ */
test('every required withdrawal-minimum question retrieves withdrawals.minimum', () => {
  REQUIRED_QUESTIONS.forEach((q) => {
    const top = topHit(q);
    assert.ok(top, 'must retrieve an approved entry: ' + q);
    assert.strictEqual(top.id, MIN_ID, 'must retrieve the minimum entry: ' + q);
    assert.strictEqual(top.category, 'withdrawals', 'must be a withdrawal entry: ' + q);
    assert.strictEqual(top.kind, 'info', 'must be answerable, not a handoff/guardrail: ' + q);
    assert.ok(top.score >= 2, 'must clear the retrieval threshold: ' + q + ' (score ' + top.score + ')');
    assert.match(top.answer, NO_MINIMUM, 'answer must state there is no minimum withdrawal: ' + q);
  });
});

test('natural equivalent phrasings retrieve the same approved answer', () => {
  EQUIVALENT_QUESTIONS.forEach((q) => {
    const top = topHit(q);
    assert.ok(top, 'must retrieve an approved entry: ' + q);
    assert.strictEqual(top.id, MIN_ID, 'must retrieve the minimum entry: ' + q);
    assert.match(top.answer, NO_MINIMUM, 'answer must state there is no minimum withdrawal: ' + q);
  });
});

test('all phrasings resolve to the identical approved answer text', () => {
  const texts = new Set(
    REQUIRED_QUESTIONS.concat(EQUIVALENT_QUESTIONS).map((q) => topHit(q).answer)
  );
  assert.strictEqual(texts.size, 1, 'every phrasing must return the same approved answer');
  const [only] = [...texts];
  assert.strictEqual(only, retriever.getEntry(MIN_ID).answer, 'the answer must be the approved minimum text');
  assert.match(only, NO_MINIMUM);
});

/* ------------------------------------------------------------------ *
 * 2. End to end: answered, never the "no approved answer" hand-off
 * ------------------------------------------------------------------ */
test('end to end, every required question is answered and never escalated', async () => {
  const ai = service();
  for (const q of REQUIRED_QUESTIONS) {
    const result = await ai.ask(q);
    assert.strictEqual(result.answered, true, 'must be answered: ' + q);
    assert.strictEqual(result.kind, 'answer', 'must be a real answer, not unknown/handoff: ' + q);
    assert.strictEqual(result.needsHuman, false, 'must not escalate: ' + q);
    assert.strictEqual(result.entryId, MIN_ID, 'must answer from the minimum entry: ' + q);
    assert.strictEqual(result.category, 'withdrawals', q);
    assert.notStrictEqual(result.answer, G.UNCERTAIN_TEXT, 'must not be the "no approved answer" text: ' + q);
    assert.match(result.answer, NO_MINIMUM, q);
    assert.deepStrictEqual(G.assertSafeAnswer(result.answer), [], q);
  }
});

/* ------------------------------------------------------------------ *
 * 3. Unrelated questions must not retrieve the withdrawal-minimum answer
 * ------------------------------------------------------------------ */
test('unrelated questions never lead with the withdrawal-minimum entry', () => {
  UNRELATED_QUESTIONS.forEach((q) => {
    const top = topHit(q);
    if (top) {
      assert.notStrictEqual(top.id, MIN_ID, 'must not lead with the minimum entry: ' + q);
    }
  });
});

test('unrelated questions do not retrieve the withdrawal-minimum entry at all', () => {
  UNRELATED_QUESTIONS.forEach((q) => {
    const hits = retriever.retrieve(q, { limit: 10 });
    assert.ok(!hits.some((h) => h.id === MIN_ID), 'must not retrieve the minimum entry: ' + q);
  });
});

test('deposit-minimum questions still lead with the deposit entry', () => {
  ['What is the minimum deposit?', 'Is there a minimum deposit?'].forEach((q) => {
    assert.strictEqual(topHit(q).id, 'deposits.minimum', q);
  });
});

/* ------------------------------------------------------------------ *
 * 4. The change is additive, scoped, and preserves the approved content
 * ------------------------------------------------------------------ */
test('every pre-existing withdrawals.minimum keyword is still present (additive only)', () => {
  const entry = retriever.getEntry(MIN_ID);
  [
    'minimum withdrawal',
    'min withdrawal',
    'withdrawal minimum',
    'least withdrawal',
    'how much can i withdraw'
  ].forEach((k) => assert.ok(entry.keywords.includes(k), MIN_ID + ' must still list "' + k + '"'));
});

test('the new keywords belong to withdrawals.minimum and to no other entry', () => {
  const entry = retriever.getEntry(MIN_ID);
  const added = [
    'minimum withdrawal amount',
    'minimum i can withdraw',
    'minimum to withdraw',
    'minimum amount to withdraw',
    'minimum amount for withdrawal',
    'minimum amount i can withdraw',
    'least i can withdraw',
    'least amount i can withdraw',
    'smallest withdrawal',
    'smallest amount i can withdraw',
    'withdraw a small amount',
    'withdraw small amount',
    'small withdrawal',
    'how much do i need to withdraw'
  ];
  const all = S.flattenEntries(KB);
  added.forEach((k) => {
    assert.ok(entry.keywords.includes(k), MIN_ID + ' must list "' + k + '"');
    const owners = all.filter((e) => e.keywords.includes(k)).map((e) => e.id);
    assert.deepStrictEqual(owners, [MIN_ID], '"' + k + '" must exist only on ' + MIN_ID);
  });
});

test('no other knowledge entry was changed and the entry set is unchanged', () => {
  // The sibling entry most at risk (it shares the withdrawal topic).
  const requirements = retriever.getEntry('withdrawals.requirements');
  assert.deepStrictEqual(requirements.keywords, [
    'how do withdrawals work',
    'withdraw',
    'withdrawal',
    'withdrawal requirements',
    'cash out',
    'cashing out',
    'cashout',
    'take out money',
    'take out funds'
  ], 'withdrawals.requirements keywords must be untouched');
  assert.strictEqual(retriever.count, 39, 'entry count must be unchanged (no entry added or removed)');
});

test('the approved minimum answer and its canonical question are unchanged', () => {
  const entry = retriever.getEntry(MIN_ID);
  assert.strictEqual(entry.question, 'What is the minimum withdrawal?');
  assert.strictEqual(
    entry.answer,
    'No minimum withdrawal is needed - there is no minimum withdrawal amount, and you can withdraw any amount up to your available balance.'
  );
  assert.strictEqual(entry.kind, 'info');
});

test('the knowledge base still validates', () => {
  assert.deepStrictEqual(S.validateKnowledge(KB), []);
  assert.ok(retriever.count >= 30);
});
