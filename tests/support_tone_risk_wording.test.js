'use strict';

/**
 * Support tone: ordinary answers must not be fear-inducing.
 *
 * Live testing showed the assistant repeatedly adding loss wording such as
 * "you can gain or lose" / "you can lose money" to plain informational answers,
 * which is technically safe but alarming for beginners. Two information entries
 * carried that wording verbatim, and the system prompt itself stated the risk
 * sentence unconditionally, inviting the model to echo it every time.
 *
 * This pins the corrected behaviour:
 *   - ordinary informational answers contain no loss/risk wording and answer the
 *     question that was asked;
 *   - risk wording is kept EXACTLY where it is directly relevant (guaranteed
 *     profit, expected returns, is it safe, can I lose, advice);
 *   - no financial-safety guardrail is weakened (promises are still refused and
 *     the guardrail entries are untouched).
 */

const test = require('node:test');
const assert = require('node:assert');

const S = require('../services/support/SupportKnowledge');
const G = require('../services/support/SupportGuidelines');
const { createSupportAIService } = require('../services/support/SupportAIService');

const kb = S.readKnowledge();
const entry = (id) => S.createRetriever(kb, { minScore: 2 }).getEntry(id);

const PREFERRED_ARBITRIX_ANSWER =
  'Arbitrix is an automated arbitrage platform. It looks for arbitrage opportunities across supported markets ' +
  'and places trades for you automatically. You can start with Demo Mode using virtual funds, then switch to ' +
  "Live Mode when you're ready.";

/** Loss/risk wording that must not appear in an ordinary informational answer. */
const LOSS_WORDING = /\b(lose|loses|losing|loss|losses|risk|risky)\b/i;

/** Wider check for the neutral questions the brief calls out by name. */
const ANY_RISK_WORDING = /\b(lose|loses|losing|loss|losses|risk|risky|guarantee|guaranteed|assured)\b/i;

function service(over) {
  return createSupportAIService({
    config: Object.assign({
      enabled: true, provider: 'knowledge', model: null, apiKey: null,
      timeoutMs: 8000, maxAnswerChars: 1200, minScore: 2
    }, over || {}),
    knowledge: kb
  });
}

// ------------------------------------------------- ordinary answers stay calm ---

test('the neutral questions named in the brief get clean, direct answers', () => {
  // These are the exact questions the brief lists as "neutral".
  ['How does Arbitrix work?', 'What is the minimum deposit?', 'How do I deposit?',
    'How do withdrawals work?', 'How do referrals work?']
    .forEach((q) => {
      const hits = S.createRetriever(kb, { minScore: 2 }).retrieve(q);
      assert.ok(hits.length > 0, 'must have an approved answer: ' + q);
      assert.ok(!ANY_RISK_WORDING.test(hits[0].answer), 'no risk/loss wording for: ' + q + ' -> ' + hits[0].answer);
    });
});

test('no ordinary informational answer carries loss wording', async () => {
  const ai = service();
  const ordinary = [
    'How does Arbitrix work?', 'What is the minimum deposit?', 'How do I deposit?',
    'How do withdrawals work?', 'How do referrals work?', 'What is the minimum withdrawal?',
    'How long does a withdrawal take?', 'How do I use my referral earnings?',
    'What network do I use to deposit USDT?', 'What is the promotional credit?',
    'How does Live Mode work?', 'How does Demo Mode work?', 'What is the subscription price?',
    'Can I cancel my subscription?', 'Do I need KYC to withdraw?', 'How do I get started?'
  ];
  for (const q of ordinary) {
    const result = await ai.ask(q);
    assert.ok(!LOSS_WORDING.test(result.answer), 'loss wording leaked into "' + q + '": ' + result.answer);
    assert.ok(!/you can gain or lose/i.test(result.answer), 'the reported phrase reappeared: ' + q);
  }
});

test('"How does Arbitrix work?" returns the preferred, encouraging answer', async () => {
  const result = await service().ask('How does Arbitrix work?');
  assert.strictEqual(result.answer, PREFERRED_ARBITRIX_ANSWER);
  assert.strictEqual(result.entryId, 'what_is_arbitrix.overview');
  assert.strictEqual(result.answered, true);
});

test('"How does Live Mode work?" no longer ends with a loss warning', async () => {
  const result = await service().ask('How does Live Mode work?');
  assert.ok(!LOSS_WORDING.test(result.answer), result.answer);
  assert.match(result.answer, /minimum \$100/, 'the factual deposit minimum is preserved');
  assert.match(result.answer, /real funds/i, 'the Live/Demo distinction is preserved');
});

// --------------------------------------------- risk wording still where it counts ---

test('risk wording is preserved for the questions that directly raise it', async () => {
  const ai = service();

  const risky = await ai.ask('Is trading risky?');
  assert.strictEqual(risky.entryId, 'trading_bot.risk');
  assert.match(risky.answer, /risk/i);
  assert.match(risky.answer, /you can lose money as well as gain/i);

  const profit = await ai.ask('Can I make guaranteed profit?');
  assert.strictEqual(profit.entryId, 'guardrails.no_guarantee');
  assert.match(profit.answer, /does not guarantee profits or returns/i);

  const advice = await ai.ask('Should I invest more?');
  assert.strictEqual(advice.entryId, 'guardrails.no_advice');

  const safe = await ai.ask('Is my money safe?');
  assert.ok(/risk/i.test(safe.answer), 'a safety question must still mention risk');
});

test('the loss wording now lives ONLY in the risk-relevant entries', () => {
  const phrases = [/you can gain or lose/i, /you can lose money/i];
  const allowed = new Set(['trading_bot.risk', 'guardrails.no_guarantee']);
  S.flattenEntries(kb).forEach((e) => {
    phrases.forEach((re) => {
      if (re.test(e.answer)) {
        assert.ok(allowed.has(e.id), 'loss wording belongs only to a risk-relevant entry, found in ' + e.id);
      }
    });
  });
  // and both risk-relevant entries still have it
  assert.match(entry('trading_bot.risk').answer, /you can lose money/i);
  assert.match(entry('guardrails.no_guarantee').answer, /you can lose money/i);
});

test('the operational wrong-network warning keeps its loss-of-funds wording', () => {
  // Directly relevant to the action the customer is taking - not a trading-risk
  // lecture, so it is deliberately kept.
  assert.match(entry('troubleshooting.wrong_address').answer, /loss of funds/i);
});

// ------------------------------------------------- guardrails are NOT weakened ---

test('the guardrail entries are untouched', () => {
  assert.strictEqual(entry('guardrails.no_guarantee').kind, 'guardrail');
  assert.strictEqual(entry('guardrails.no_advice').kind, 'guardrail');
  assert.match(entry('guardrails.no_guarantee').answer, /does not guarantee profits or returns/i);
  assert.match(entry('guardrails.no_guarantee').answer, /not financial advice/i);
});

test('the answer filter still refuses promises (unchanged)', () => {
  assert.ok(G.assertSafeAnswer('You will earn guaranteed returns every week.').length > 0);
  assert.ok(G.assertSafeAnswer('Your profit is guaranteed.').length > 0);
  assert.ok(G.assertSafeAnswer('This is a risk-free way to grow your money.').length > 0);
});

test('a model that still invents a promise is replaced by the approved answer', async () => {
  const provider = {
    name: 'stub', kind: 'local', requiresApiKey: false, available: true,
    async generate() { return { text: 'You will earn guaranteed returns of 20% every week.' }; }
  };
  const ai = createSupportAIService({
    config: {
      enabled: true, provider: 'stub', model: null, apiKey: null,
      timeoutMs: 8000, maxAnswerChars: 1200, minScore: 2
    },
    knowledge: kb,
    provider
  });
  const result = await ai.ask('How does Arbitrix work?');
  assert.strictEqual(result.filtered, true, 'the promise must be filtered');
  assert.strictEqual(result.answer, PREFERRED_ARBITRIX_ANSWER, 'falls back to the approved, calm answer');
  assert.ok(!/guaranteed returns/i.test(result.answer));
});

// ------------------------------------------------------- the instruction change ---

test('the instructions tell the model not to add risk to ordinary answers', () => {
  const text = G.SUPPORT_INSTRUCTIONS;
  assert.match(text, /Do NOT add risk, loss, or "you can lose money" remarks to ordinary informational answers/);
  assert.match(text, /Mention trading risk ONLY when the customer directly raises it/);
  assert.match(text, /reassuring rather than alarming/);
  assert.match(text, /never repeat the warning/i);
  assert.match(text, /Tone: warm, calm and encouraging/);
});

test('the instruction change did not drop a hard rule', () => {
  const text = G.SUPPORT_INSTRUCTIONS.toLowerCase();
  assert.ok(text.indexOf('never promise profits') !== -1, 'no-profit rule');
  assert.ok(text.indexOf('never give personalized financial') !== -1, 'no-advice rule');
  assert.ok(text.indexOf('never request, repeat, or expose passwords, private keys, seed phrases, api keys') !== -1,
    'no-secrets rule');
  assert.ok(text.indexOf('never claim a payment, deposit, or withdrawal has been completed') !== -1,
    'payment-status rule');
  assert.ok(text.indexOf('hand off to a human') !== -1, 'human hand-off rule');
  assert.ok(text.indexOf('if information is uncertain or unavailable') !== -1, 'uncertainty rule');
  assert.ok(text.indexOf('only from the approved arbitrix knowledge') !== -1, 'no-invention rule');
});

test('the instructions no longer state the risk sentence unconditionally', () => {
  // The old rule 1 read "... Never promise profits, returns, or guaranteed outcomes.
  // Trading involves risk and users can lose money." - that unconditional sentence
  // is what invited a loss warning on every answer.
  assert.ok(!/Trading involves risk and users can lose money/.test(G.SUPPORT_INSTRUCTIONS));
  assert.ok(!/you can lose money\.\s*$/m.test(G.SUPPORT_INSTRUCTIONS));
});

test('the knowledge base still validates after the copy changes', () => {
  assert.deepStrictEqual(S.validateKnowledge(kb), []);
});
