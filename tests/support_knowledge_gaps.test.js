'use strict';

/**
 * Regression - the four support-knowledge retrieval gaps.
 *
 * These were coverage gaps, not ranking gaps: the intent tier added earlier can
 * only reorder entries that already matched a keyword, so a question that matched
 * NOTHING still fell through to a human hand-off while an approved answer existed.
 *
 *   "Cashing out"                  -> no hits (the keyword was "cash out", which is
 *                                     not a substring of "cashing out")
 *   "How do referrals work?"       -> no hits (keyword "referral" never matches the
 *                                     plural token "referrals")
 *   "My deposit is still pending"  -> deposits.how_to won the alphabetical tie
 *   "Can I cancel my subscription?"-> subscription.price outscored cancel
 *
 * Fixed by adding precise keywords only: no ranking change, no keyword removed, and
 * no answer/question/customer-facing text touched. These tests pin the four cases,
 * their wording variants, the preserved answers, and the routing that must not move.
 */

const test = require('node:test');
const assert = require('node:assert');

const S = require('../services/support/SupportKnowledge');
const { createSupportAIService, resolveSupportAIConfig } = require('../services/support/SupportAIService');

const KB = S.readKnowledge();
const retriever = S.createRetriever(KB, { minScore: 2 });
const entry = (id) => retriever.getEntry(id);
const topId = (q) => {
  const hits = retriever.retrieve(q);
  return hits.length ? hits[0].id : null;
};

const KNOWLEDGE_CONFIG = resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'knowledge' });
const service = () => createSupportAIService({ config: KNOWLEDGE_CONFIG, knowledge: KB });

// ------------------------------------------------------------ the four cases ---

test('"Cashing out" now reaches withdrawal knowledge instead of a hand-off', () => {
  assert.ok(retriever.retrieve('Cashing out').length > 0, 'must not fall through to a hand-off');
  assert.strictEqual(topId('Cashing out'), 'withdrawals.requirements');
  assert.strictEqual(retriever.retrieve('Cashing out')[0].category, 'withdrawals');
});

test('"How do referrals work?" now reaches referrals knowledge', () => {
  assert.ok(retriever.retrieve('How do referrals work?').length > 0, 'must not fall through to a hand-off');
  assert.strictEqual(topId('How do referrals work?'), 'referrals.program');
  assert.strictEqual(retriever.retrieve('How do referrals work?')[0].category, 'referrals');
});

test('"My deposit is still pending" now reaches deposits.pending', () => {
  assert.strictEqual(topId('My deposit is still pending'), 'deposits.pending');
});

test('"Can I cancel my subscription?" now reaches subscription.cancel', () => {
  assert.strictEqual(topId('Can I cancel my subscription?'), 'subscription.cancel');
});

// --------------------------------------------------------- wording variants ---

test('cash-out variants reach withdrawal knowledge', () => {
  ['Cashing out', 'Can I cash out?', 'How do I cash out?', 'Can I cash out my funds?', 'cashout', 'Cash out my money']
    .forEach((q) => assert.strictEqual(topId(q), 'withdrawals.requirements', q));
});

test('referral variants reach the referral program entry', () => {
  ['How do referrals work?', 'Tell me about referrals', 'What is the referral program?', 'How does the referral program work?', 'Explain referrals']
    .forEach((q) => assert.strictEqual(topId(q), 'referrals.program', q));
});

test('pending-deposit variants reach deposits.pending', () => {
  ['My deposit is still pending', 'My deposits still pending', 'Why is my pending deposit not showing?', 'Deposit stuck']
    .forEach((q) => assert.strictEqual(topId(q), 'deposits.pending', q));
});

test('cancel variants reach subscription.cancel', () => {
  ['Can I cancel my subscription?', 'Cancel my subscription', 'How do I cancel?', 'Can I stop my subscription?', 'Cancelling my subscription', 'I want to unsubscribe']
    .forEach((q) => assert.strictEqual(topId(q), 'subscription.cancel', q));
});

test('the four cases produce an answer, not a hand-off', async () => {
  const ai = service();
  for (const q of ['Cashing out', 'How do referrals work?', 'My deposit is still pending', 'Can I cancel my subscription?']) {
    const result = await ai.ask(q);
    assert.strictEqual(result.answered, true, 'must be answered: ' + q);
    assert.notStrictEqual(result.kind, 'unknown', 'must not be the unknown fallback: ' + q);
    assert.notStrictEqual(result.answer, require('../services/support/SupportGuidelines').UNCERTAIN_TEXT, q);
  }
});

// ------------------------------------- no existing keyword was removed ---------

test('every pre-existing keyword is still present (additive change only)', () => {
  const mustKeep = {
    'withdrawals.requirements': ['how do withdrawals work', 'withdraw', 'withdrawal requirements', 'cash out', 'take out money'],
    'referrals.program': ['referral', 'referral program', 'invite', 'refer', 'referral reward', 'earn from referrals'],
    'deposits.pending': ['deposit pending', 'deposit not arrived', 'deposit missing', 'deposit stuck', 'sent but not credited', 'deposit not showing'],
    'subscription.cancel': ['cancel subscription', 'stop subscription', 'cancel pro', 'unsubscribe']
  };
  Object.entries(mustKeep).forEach(([id, keywords]) => {
    const target = entry(id);
    assert.ok(target, 'entry must exist: ' + id);
    keywords.forEach((k) => assert.ok(target.keywords.includes(k), id + ' must still list "' + k + '"'));
  });
});

test('customer-facing facts in the four entries are unchanged', () => {
  assert.match(entry('withdrawals.requirements').answer, /no minimum withdrawal/i);
  assert.match(entry('referrals.program').answer, /20%/);
  assert.match(entry('referrals.program').answer, /\$100/);
  assert.match(entry('referrals.program').answer, /one-time/i);
  assert.match(entry('deposits.pending').answer, /TRC20/);
  assert.match(entry('subscription.cancel').answer, /not be charged again/i);
  // the canonical questions are untouched
  assert.strictEqual(entry('deposits.pending').question, 'My deposit is still pending');
  assert.strictEqual(entry('subscription.cancel').question, 'Can I cancel my subscription?');
  assert.strictEqual(entry('referrals.program').question, 'What is the referral program?');
});

test('the knowledge base still validates', () => {
  assert.deepStrictEqual(S.validateKnowledge(KB), []);
});

// --------------------------------------- existing routing must remain correct ---

test('withdrawal routing is unchanged', () => {
  ['Can I withdraw $200?', 'Can I withdraw 200 USDT?', 'How do I withdraw?', 'Withdraw USDT on TRC20?',
    'How do withdrawals work?', 'I want to withdraw 200', 'Can I cash out?']
    .forEach((q) => {
      assert.strictEqual(retriever.retrieve(q)[0].category, 'withdrawals', 'withdrawal routing: ' + q);
    });
  assert.strictEqual(topId('What is the minimum withdrawal?'), 'withdrawals.minimum');
  assert.strictEqual(topId('How long does withdrawal take?'), 'withdrawals.timing');
  assert.strictEqual(topId('My withdrawal is stuck or has not arrived'), 'withdrawals.problem');
});

test('deposit routing is unchanged', () => {
  assert.strictEqual(topId('What network do I use to deposit USDT?'), 'deposits.asset');
  assert.strictEqual(topId('What is the minimum deposit?'), 'deposits.minimum');
  assert.strictEqual(topId('How do I make a deposit?'), 'deposits.how_to');
  assert.strictEqual(topId('My payment failed or expired'), 'deposits.expired');
  assert.strictEqual(topId('Tell me about USDT'), 'deposits.asset');
});

test('subscription routing is unchanged', () => {
  assert.strictEqual(topId('What is the subscription price?'), 'subscription.price');
  assert.strictEqual(topId('How much is the subscription?'), 'subscription.price');
  assert.strictEqual(topId('Do I get 14 days free?'), 'subscription.free_period');
});

test('referral routing is unchanged', () => {
  assert.strictEqual(topId('How do I use my referral earnings?'), 'referrals.using_earnings');
  assert.strictEqual(topId('What is the referral program?'), 'referrals.program');
});

test('the new synonyms do not capture questions from another topic', () => {
  // "still pending" must not steal a withdrawal question ...
  assert.strictEqual(topId('My withdrawal is still pending'), 'withdrawals.requirements');
  assert.strictEqual(retriever.retrieve('My withdrawal is still pending')[0].category, 'withdrawals');
  // ... "cancel" must not steal a withdrawal or deposit question ...
  assert.strictEqual(retriever.retrieve('Can I cancel my withdrawal')[0].category, 'withdrawals');
  assert.strictEqual(retriever.retrieve('Cancelling my deposit')[0].category, 'deposits');
  // ... and "stop"/"cancel" must not disturb the promotional-credit cap answer
  assert.strictEqual(topId('Why did my bot stop after making a profit?'), 'promotional_credit.cap');
});

test('guardrails still lead their questions', () => {
  assert.strictEqual(topId('Should I deposit more?'), 'guardrails.no_advice');
  assert.strictEqual(topId('Can I make guaranteed profit?'), 'guardrails.no_guarantee');
});
