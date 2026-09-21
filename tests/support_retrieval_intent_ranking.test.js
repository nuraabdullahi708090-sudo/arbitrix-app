'use strict';

/**
 * Regression - intent-aware retrieval ranking.
 *
 * Root cause this pins: `retrieve()` ordered hits by score and then fell back to
 * `a.id.localeCompare(b.id)`, so ties were won ALPHABETICALLY. On the 2-2 tie
 * between `deposits.asset` and `withdrawals.requirements`, "d" < "w" meant a
 * customer asking "Can I withdraw 200 USDT?" was answered with the deposit-network
 * entry. "Withdraw USDT on TRC20?" was worse: deposits.asset scored 4 to the
 * withdrawal entry's 2 and won outright.
 *
 * The fix ranks by query intent first (see QUERY_INTENTS in SupportKnowledge.js).
 * These tests pin: the fixed routing, that the deposit entry is still used for real
 * deposit questions, that the intent tier cannot make an unrelated entry
 * retrievable, and that guardrail entries are neither promoted nor demoted.
 */

const test = require('node:test');
const assert = require('node:assert');

const S = require('../services/support/SupportKnowledge');
const { createSupportAIService, resolveSupportAIConfig } = require('../services/support/SupportAIService');
const G = require('../services/support/SupportGuidelines');

const KB = S.readKnowledge();
const retriever = S.createRetriever(KB, { minScore: 2 });

const KNOWLEDGE_CONFIG = resolveSupportAIConfig({ AI_SUPPORT_ENABLED: 'true', AI_SUPPORT_PROVIDER: 'knowledge' });

function service() {
  return createSupportAIService({ config: KNOWLEDGE_CONFIG, knowledge: KB });
}

const topId = (q) => {
  const hits = retriever.retrieve(q);
  return hits.length ? hits[0].id : null;
};

// ------------------------------------------------- the required regression set ---

test('the required regression set routes to the right entry', () => {
  // the four withdrawal questions must reach a withdrawal entry
  assert.strictEqual(topId('Can I withdraw $200?'), 'withdrawals.requirements');
  assert.strictEqual(topId('Can I withdraw 200 USDT?'), 'withdrawals.requirements');
  assert.strictEqual(topId('What is the minimum withdrawal?'), 'withdrawals.minimum');
  assert.strictEqual(topId('How do I withdraw?'), 'withdrawals.requirements');
  // ...and the deposit question must still reach the deposit-network entry
  assert.strictEqual(topId('What network do I use to deposit USDT?'), 'deposits.asset');

  ['Can I withdraw $200?', 'Can I withdraw 200 USDT?', 'What is the minimum withdrawal?', 'How do I withdraw?']
    .forEach((q) => {
      assert.strictEqual(retriever.retrieve(q)[0].category, 'withdrawals', q + ' must resolve to the withdrawals category');
    });
});

test('"Can I withdraw 200 USDT?" no longer returns the deposit-network answer', () => {
  const depositAnswer = retriever.getEntry('deposits.asset').answer;
  const hits = retriever.retrieve('Can I withdraw 200 USDT?', { limit: 5 });
  assert.strictEqual(hits[0].id, 'withdrawals.requirements');
  assert.notStrictEqual(hits[0].id, 'deposits.asset');
  assert.notStrictEqual(hits[0].answer, depositAnswer);
});

test('the tie was broken by intent, not by score', () => {
  // Both entries genuinely tie on the raw score, so only the intent tier can
  // explain the new order (this is the exact reported case).
  const hits = retriever.retrieve('Can I withdraw 200 USDT?', { limit: 5 });
  const deposits = hits.find((h) => h.id === 'deposits.asset');
  const withdrawals = hits.find((h) => h.id === 'withdrawals.requirements');
  assert.ok(deposits && withdrawals, 'both competing entries must still be retrieved');
  assert.strictEqual(deposits.score, withdrawals.score, 'they still tie on raw score');
  assert.strictEqual(hits[0].id, 'withdrawals.requirements', 'intent decides the tie');
  assert.deepStrictEqual(S.detectQueryIntents('Can I withdraw 200 USDT?'), ['withdrawal']);
});

test('"Can I withdraw 200 USDT?" is answered correctly and safely end to end', async () => {
  const result = await service().ask('Can I withdraw 200 USDT?');
  assert.match(result.answer, /no minimum withdrawal/i);
  assert.strictEqual(result.answered, true);
  assert.strictEqual(result.filtered, false);
  assert.deepStrictEqual(result.unsupportedClaims, []);
  assert.deepStrictEqual(G.assertSafeAnswer(result.answer), []);
  assert.strictEqual(result.entryId, 'withdrawals.requirements');
  assert.strictEqual(result.category, 'withdrawals');
});

// ------------------------------------------------ withdrawal language variants ---

test('explicit withdrawal language prefers withdrawals.* over deposits.*', () => {
  const variants = [
    'Can I withdraw?', 'How does withdrawal work?', 'How do withdrawals work?',
    'Can I withdraw 200 USDT?', 'Withdraw USDT on TRC20?', 'I want to withdraw 200',
    'Can I cash out?', 'How can I take out funds?', 'How can I take out money?',
    'My withdrawal is stuck or has not arrived'
  ];
  variants.forEach((q) => {
    const hits = retriever.retrieve(q);
    assert.ok(hits.length > 0, 'must retrieve something: ' + q);
    assert.strictEqual(hits[0].category, 'withdrawals', 'withdrawal question must lead with withdrawals.*: ' + q);
  });
});

test('withdrawal intent is detected for each listed phrase', () => {
  ['withdraw', 'withdrawal', 'withdraw 200', 'withdraw 200 USDT', 'cash out', 'take out funds']
    .forEach((phrase) => {
      assert.ok(S.detectQueryIntents('Can I ' + phrase + '?').includes('withdrawal'), 'intent for: ' + phrase);
    });
});

// --------------------------------- the deposit entry must survive and still win ---

test('deposits.asset is not deleted and still wins genuine deposit questions', () => {
  const entry = retriever.getEntry('deposits.asset');
  assert.ok(entry, 'deposits.asset must still exist');
  assert.ok(entry.keywords.includes('usdt') && entry.keywords.includes('trc20'), 'its keywords must be intact');
  ['What network do I use to deposit USDT?', 'Which coin can I deposit?', 'Tell me about USDT', 'TRC20', 'What is the deposit network?']
    .forEach((q) => {
      assert.strictEqual(topId(q), 'deposits.asset', 'deposit question must still reach deposits.asset: ' + q);
    });
});

test('bare asset names do not trigger the deposit intent', () => {
  // "Can I withdraw 200 USDT?" contains USDT but must not be treated as a deposit
  // question; the deposit intent requires explicit deposit language.
  assert.ok(!S.detectQueryIntents('Can I withdraw 200 USDT?').includes('deposit'));
  assert.deepStrictEqual(S.detectQueryIntents('TRC20'), []);
  assert.deepStrictEqual(S.detectQueryIntents('Tell me about USDT'), []);
});

// ----------------------------------------------------------- other intents ---

test('the troubleshooting intent routes to the troubleshooting entry', () => {
  assert.strictEqual(topId('The bot is not starting'), 'troubleshooting.bot_start');
  assert.strictEqual(topId('I cannot log in'), 'troubleshooting.login');
  assert.strictEqual(topId('I sent funds to the wrong address or network'), 'troubleshooting.wrong_address');
});

test('the troubleshooting intent does not capture healthy bot questions', () => {
  assert.strictEqual(topId('How does the bot work?'), 'trading_bot.how_it_works');
  assert.strictEqual(topId('Does the bot keep trading if I close the app?'), 'trading_bot.offline');
  assert.strictEqual(topId('Why did my bot stop after making a profit?'), 'promotional_credit.cap');
});

test('a multi-intent question does not privilege one intent arbitrarily', () => {
  // Both deposit and withdrawal are detected, so both categories are preferred and
  // the raw score order stands.
  const intents = S.detectQueryIntents('Can I deposit and then withdraw?');
  assert.ok(intents.includes('deposit') && intents.includes('withdrawal'), 'both intents must be detected');
  assert.strictEqual(topId('Can I deposit and then withdraw?'), 'deposits.how_to');
});

// ----------------------------------------------------------- safety behaviour ---

test('guardrail entries are neither promoted nor demoted', () => {
  // a leading safety entry keeps the top slot
  assert.strictEqual(topId('Should I deposit more?'), 'guardrails.no_advice');
  assert.strictEqual(topId('Can I make guaranteed profit?'), 'guardrails.no_guarantee');
  assert.strictEqual(topId('Is trading risky?'), 'trading_bot.risk');
  // ...and a guardrail is not promoted above a stronger info entry
  assert.strictEqual(topId('How do I keep my account safe?'), 'kyc_security.account_safety');
});

test('guardrails are still resolved by id for advice and profit questions', async () => {
  const advice = await service().ask('Should I deposit more?');
  assert.strictEqual(advice.kind, 'guardrail');
  assert.strictEqual(advice.entryId, 'guardrails.no_advice');
  const profit = await service().ask('Can I make guaranteed profit?');
  assert.strictEqual(profit.kind, 'guardrail');
  assert.strictEqual(profit.entryId, 'guardrails.no_guarantee');
});

// --------------------------------------------------- guarantees are preserved ---

test('the intent tier never makes an unrelated entry retrievable', () => {
  // reorders only entries that already cleared the threshold
  ['Can I withdraw 200 USDT?', 'What network do I use to deposit USDT?', 'The bot is not starting']
    .forEach((q) => {
      const hits = retriever.retrieve(q, { limit: 10 });
      assert.ok(hits.length > 0, q);
      hits.forEach((h) => assert.ok(h.score >= 2, 'every hit must still clear the threshold: ' + h.id + ' for ' + q));
    });
  // questions with no keyword match still return nothing (=> human hand-off)
  ['what is the weather in paris tomorrow', 'hello', 'Something is wrong with my account']
    .forEach((q) => assert.deepStrictEqual(retriever.retrieve(q), [], 'must stay empty: ' + q));
});

test('reranking is deterministic across repeated calls', () => {
  const questions = ['Can I withdraw 200 USDT?', 'What network do I use to deposit USDT?', 'The bot is not starting'];
  questions.forEach((q) => {
    const first = retriever.retrieve(q, { limit: 5 }).map((h) => h.id + ':' + h.score).join(',');
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(retriever.retrieve(q, { limit: 5 }).map((h) => h.id + ':' + h.score).join(','), first, q);
    }
  });
});

test('the raw score and its public shape are unchanged by the ranking', () => {
  // `score` remains the keyword score (it is not inflated by the intent tier), so
  // confidence values and the groundedness check see exactly what they did before.
  const hits = retriever.retrieve('Can I withdraw 200 USDT?', { limit: 5 });
  hits.forEach((h) => {
    assert.deepStrictEqual(Object.keys(h).sort(), [
      'answer', 'category', 'categoryTitle', 'id', 'kind', 'offerHuman', 'question', 'score', 'source'
    ]);
  });
  assert.strictEqual(hits.find((h) => h.id === 'withdrawals.requirements').score, 2);
});

// ------------------------------------------- no unexpected routing changes ---

test('existing routing is unchanged for a representative question set', () => {
  // A snapshot of behaviour that the intent tier must NOT disturb. Any accidental
  // reranking shows up here rather than in production.
  // Two entries were corrected on purpose by the keyword-gap fix (previously
  // deposits.how_to and subscription.price respectively) - see
  // tests/support_knowledge_gaps.test.js.
  const expected = {
    'How does Arbitrix work?': 'what_is_arbitrix.overview',
    'What is the minimum deposit?': 'deposits.minimum',
    'Do I get 14 days free?': 'subscription.free_period',
    'How long does withdrawal take?': 'withdrawals.timing',
    'How do I contact a human?': 'contact_human.how',
    'How do I deposit?': 'deposits.how_to',
    'How do I make a deposit?': 'deposits.how_to',
    'My deposit is still pending': 'deposits.pending',
    'My payment failed or expired': 'deposits.expired',
    'What payment methods are supported?': 'supported_countries.payment',
    'Do I need KYC to withdraw?': 'kyc_security.required',
    'How do I verify my account?': 'kyc_security.required',
    'What documents do I need for verification?': 'kyc_security.documents',
    'What is the promotional credit?': 'promotional_credit.what_is_it',
    'Does Demo Mode use real money?': 'demo_mode.can_i_use',
    'How do I switch between Demo and Live?': 'live_mode.switch',
    'How does live mode work?': 'live_mode.overview',
    'What is the referral program?': 'referrals.program',
    'How do I use my referral earnings?': 'referrals.using_earnings',
    'What is the subscription price?': 'subscription.price',
    'Can I cancel my subscription?': 'subscription.cancel',
    'Is my money safe?': 'trading_bot.risk',
    'Is trading risky?': 'trading_bot.risk',
    'Which countries are supported?': 'supported_countries.availability',
    'How do I get started?': 'getting_started.steps',
    'I cannot log in': 'troubleshooting.login'
  };
  Object.entries(expected).forEach(([q, id]) => {
    assert.strictEqual(topId(q), id, 'routing changed unexpectedly for: ' + q);
  });
});
