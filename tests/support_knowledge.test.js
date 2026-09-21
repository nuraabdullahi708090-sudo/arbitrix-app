'use strict';

/**
 * Support knowledge base - structure, provenance, retrieval and conflict flags.
 *
 * The knowledge file is the ONLY thing the support AI layer is allowed to answer
 * from, so these tests pin its shape and the way questions map onto it. They also
 * assert that the business conflicts found in the repository are RECORDED rather
 * than silently resolved.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const S = require('../services/support/SupportKnowledge');

const kb = S.readKnowledge();
const problems = S.validateKnowledge(kb);
const retriever = S.createRetriever(kb);

const REQUIRED_CATEGORIES = [
  'what_is_arbitrix',
  'demo_mode',
  'live_mode',
  'getting_started',
  'deposits',
  'trading_bot',
  'withdrawals',
  'kyc_security',
  'promotional_credit',
  'referrals',
  'subscription',
  'supported_countries',
  'troubleshooting',
  'contact_human'
];

test('the knowledge file is valid, versioned and dated', () => {
  assert.deepStrictEqual(problems, [], 'knowledge validation problems: ' + problems.join('; '));
  assert.match(kb.version, /^\d+\.\d+\.\d+$/);
  assert.match(kb.lastUpdated, /^\d{4}-\d{2}-\d{2}$/);
});

test('every required customer-support category exists', () => {
  const ids = kb.categories.map((c) => c.id);
  REQUIRED_CATEGORIES.forEach((id) => {
    assert.ok(ids.includes(id), 'missing knowledge category: ' + id);
  });
});

test('entry ids are unique and every entry cites its source', () => {
  const entries = S.flattenEntries(kb);
  const seen = new Set();
  entries.forEach((entry) => {
    assert.ok(!seen.has(entry.id), 'duplicate entry id: ' + entry.id);
    seen.add(entry.id);
    assert.ok(entry.source && entry.source.length > 5, 'entry ' + entry.id + ' must cite a source');
    assert.ok(entry.answer.length > 40, 'entry ' + entry.id + ' answer looks too short to be useful');
  });
  assert.ok(entries.length >= 30, 'expected a meaningful knowledge base, got ' + entries.length);
});

test('management decisions and still-open conflicts are both recorded', () => {
  assert.ok(Array.isArray(kb.conflicts) && kb.conflicts.length >= 4, 'expected conflicts to be recorded');
  const byId = {};
  kb.conflicts.forEach((c) => { byId[c.id] = c; });

  // Settled: management decisions, plus the production-verified worker.
  ['withdrawal_minimum', 'withdrawal_processing_time', 'kyc_requirement', 'bot_offline_behavior'].forEach((id) => {
    assert.ok(byId[id], 'expected a record for: ' + id);
    assert.ok(byId[id].status.startsWith('RESOLVED'), id + ' must record that it is settled');
  });

  // Still open - the bot must hand these off rather than answer.
  ['fourteen_day_free_period', 'deposit_asset_list'].forEach((id) => {
    assert.ok(byId[id], 'expected a record for: ' + id);
    assert.ok(byId[id].status.startsWith('UNRESOLVED'), id + ' has no decision yet and must stay flagged');
  });

  kb.conflicts.forEach((conflict) => {
    assert.ok(conflict.summary, 'conflict ' + conflict.id + ' needs a summary');
    assert.ok(Array.isArray(conflict.values) && conflict.values.length > 0, 'conflict ' + conflict.id + ' needs values');
    assert.ok(conflict.status, 'conflict ' + conflict.id + ' needs a status');
  });
});

test('the decided rules are answered from the knowledge base', () => {
  const cases = [
    ['What is the minimum withdrawal?', /no minimum withdrawal/i],
    ['How long does withdrawal take?', /15-30 minutes/i],
    ['Do I need to verify my identity?', /does not require identity verification/i]
  ];
  cases.forEach(([question, expected]) => {
    const hits = retriever.retrieve(question);
    assert.ok(hits.length > 0, 'no hit for: ' + question);
    assert.ok(expected.test(hits[0].answer), question + ' -> ' + hits[0].answer);
    assert.strictEqual(hits[0].kind, 'info', question + ' should be answered, not handed off');
  });
});

test('the bot is described with the approved non-promissory wording', () => {
  const bot = S.flattenEntries(kb).find((e) => e.id === 'trading_bot.how_it_works');
  const overview = S.flattenEntries(kb).find((e) => e.id === 'what_is_arbitrix.overview');
  // Both entries must still describe the same product truth: automated arbitrage
  // seeking across the supported markets.
  [bot, overview].forEach((entry) => {
    assert.ok(entry, 'entry must exist');
    assert.match(entry.answer, /arbitrage opportunit/i, entry.id + ' must describe seeking arbitrage opportunities');
    assert.match(entry.answer, /automatically/i, entry.id + ' must describe automation');
  });
  // and they must stay non-promissory
  assert.deepStrictEqual(S.findPromiseViolations(bot.answer), []);
  assert.deepStrictEqual(S.findPromiseViolations(overview.answer), []);
  // the overview was reworded to the approved beginner-friendly version and no
  // longer carries the alarming loss phrasing (see support_tone_risk_wording.test.js)
  assert.ok(!/you can gain or lose/i.test(overview.answer), 'the objective is answered without a loss warning');
});

test('offline trading is answered from production-verified facts, while the 14-day period still hands off', () => {
  const offline = retriever.retrieve('Does the bot keep trading if I close the app?');
  assert.strictEqual(offline[0].id, 'trading_bot.offline');
  assert.strictEqual(offline[0].kind, 'info', 'offline trading is settled for production and must be answered');
  assert.match(offline[0].answer, /continues/i);
  assert.match(offline[0].answer, /server/i);

  // Explicitly unchanged: the free-period question remains unresolved.
  const trial = retriever.retrieve('Do I get 14 days free?');
  assert.strictEqual(trial[0].id, 'subscription.free_period');
  assert.strictEqual(trial[0].kind, 'handoff', 'the 14-day free period must keep handing off to a human');
});

test('no approved answer promises profits, returns or safety from loss', () => {
  S.flattenEntries(kb).forEach((entry) => {
    const found = S.findPromiseViolations(entry.answer);
    assert.deepStrictEqual(found, [],
      'entry ' + entry.id + ' contains a forbidden promise phrase: ' + found.join(', '));
  });
});

test('retrieval maps the required beginner questions to the approved entries', () => {
  const cases = [
    ['How does Arbitrix work?', 'what_is_arbitrix.overview'],
    ['How do I get started?', 'getting_started.steps'],
    ['What is the minimum deposit?', 'deposits.minimum'],
    ['Can I use Demo Mode?', 'demo_mode.can_i_use'],
    ['How do withdrawals work?', 'withdrawals.requirements'],
    ['What is the minimum withdrawal?', 'withdrawals.minimum'],
    ['How long does withdrawal take?', 'withdrawals.timing'],
    ['What is the referral program?', 'referrals.program'],
    ['What is the $50 promotional credit?', 'promotional_credit.what_is_it'],
    ['How much is the subscription?', 'subscription.price'],
    ['Do I need to verify my identity?', 'kyc_security.required'],
    ['How do I contact a human?', 'contact_human.how']
  ];
  cases.forEach(([question, expectedId]) => {
    const hits = retriever.retrieve(question);
    assert.ok(hits.length > 0, 'no knowledge hit for: ' + question);
    assert.strictEqual(hits[0].id, expectedId, 'wrong entry for "' + question + '" -> ' + hits[0].id);
  });
});

test('retrieval returns nothing for questions the knowledge base does not cover', () => {
  ['what is the weather in paris tomorrow', 'tell me a joke about penguins'].forEach((question) => {
    assert.deepStrictEqual(retriever.retrieve(question), [], 'unexpected hit for: ' + question);
  });
});

test('topics with unresolved conflicts resolve to a human hand-off entry', () => {
  const conflicted = [
    'Do I get 14 days free?',
    'Which countries can use Arbitrix?'
  ];
  conflicted.forEach((question) => {
    const hits = retriever.retrieve(question);
    assert.ok(hits.length > 0, 'no hit for ' + question);
    assert.strictEqual(hits[0].kind, 'handoff', question + ' must hand off while the conflict is unresolved');
  });
});

test('retrieval is deterministic and keyword-driven', () => {
  const a = retriever.retrieve('What is the minimum deposit?');
  const b = retriever.retrieve('What is the minimum deposit?');
  assert.deepStrictEqual(a.map((h) => [h.id, h.score]), b.map((h) => [h.id, h.score]));
});

test('normalize/tokenize drop stopwords and punctuation', () => {
  assert.strictEqual(S.normalize('How does Arbitrix work?'), 'how does arbitrix work');
  assert.deepStrictEqual(S.tokenize('How does Arbitrix work?'), ['arbitrix', 'work']);
  assert.deepStrictEqual(S.tokenize('What is the $50 promotional credit?'), ['50', 'promotional', 'credit']);
});

test('validation rejects a malformed knowledge base', () => {
  const bad = JSON.parse(JSON.stringify(kb));
  bad.categories[0].entries[0].keywords = [];
  bad.categories[0].entries[1].kind = 'magic';
  delete bad.categories[1].entries[0].source;
  const found = S.validateKnowledge(bad);
  assert.ok(found.some((p) => /keywords/.test(p)));
  assert.ok(found.some((p) => /kind/.test(p)));
  assert.ok(found.some((p) => /source/.test(p)));
});

test('validation rejects an answer that promises returns', () => {
  const bad = JSON.parse(JSON.stringify(kb));
  bad.categories[0].entries[0].answer = 'You are guaranteed profit every single day.';
  const found = S.validateKnowledge(bad);
  assert.ok(found.some((p) => /forbidden promise phrase/.test(p)));
});
