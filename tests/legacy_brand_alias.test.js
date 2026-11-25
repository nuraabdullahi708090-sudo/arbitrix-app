'use strict';

/**
 * Legacy brand name as a QUERY ALIAS.
 *
 * The product was renamed (see services/brand.js). The old name does not
 * disappear from the world on the day of the rename: it is still the public
 * domain customers signed up on, and it is still the legal operator, so
 * customers keep typing it. Before this contract existed, "who is <old name>"
 * returned NO approved answer after the rename while "who is <new name>"
 * answered - a silent regression that no rename grep would ever catch.
 *
 * Both layers fold the legacy name onto the current one on the MATCHING copy
 * only, derived from BRAND rather than spelled out, so a future rename keeps
 * both spellings working without touching a pattern.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const { BRAND } = require('../services/brand');
const S = require('../services/support/SupportKnowledge');
const E = require('../services/support/ConversationEngine');

const LEGACY = String(BRAND.source || '').toLowerCase();
const CURRENT = String(BRAND.name || '').toLowerCase();
const kb = S.readKnowledge();
const retriever = S.createRetriever(kb);

test('1. the alias is derived from BRAND, and only exists while the two differ', () => {
  assert.ok(LEGACY.length > 2 && CURRENT.length > 2, 'both names are present in BRAND');
  if (LEGACY === CURRENT) {
    // Pre-approval tree: there is nothing to alias, and normalisation is a no-op.
    assert.strictEqual(S.normalize('who is ' + LEGACY), 'who is ' + CURRENT);
    return;
  }
  assert.strictEqual(S.normalize('Who is ' + BRAND.source + '?'), 'who is ' + CURRENT,
    'a legacy occurrence normalises to the current name');
  assert.strictEqual(S.normalize('Who is ' + BRAND.name + '?'), 'who is ' + CURRENT,
    'the current name is untouched');
  // A name that merely CONTAINS the legacy spelling must not be rewritten.
  assert.strictEqual(S.normalize('arbitrixsupportbot'), 'arbitrixsupportbot');
});

test('2. an old-name question retrieves the same approved answer as a new-name one', () => {
  const pairs = [
    ['Who is %NAME%?', 'what_is_arbitrix.overview'],
    ['What is %NAME%?', 'what_is_arbitrix.overview'],
    // A legitimacy question is answered by the registered-entity entry (the KVK
    // answer), for BOTH spellings - the alias still guarantees the same entry.
    ['Is %NAME% legit?', 'business_registration.kvk'],
    ['Tell me about %NAME%', 'what_is_arbitrix.overview'],
    ['How does %NAME% work?', 'what_is_arbitrix.overview'],
    ['What does %NAME% do?', 'what_is_arbitrix.overview']
  ];
  for (const [template, expected] of pairs) {
    const legacyHits = retriever.retrieve(template.replace('%NAME%', BRAND.source));
    const currentHits = retriever.retrieve(template.replace('%NAME%', BRAND.name));
    assert.ok(legacyHits.length > 0, 'a legacy-name question still answers: ' + template);
    assert.strictEqual(legacyHits[0].id, expected, 'legacy question maps to the same entry: ' + template);
    assert.strictEqual(currentHits[0].id, expected, 'current question maps to the same entry: ' + template);
    assert.strictEqual(legacyHits[0].score, currentHits[0].score,
      'and scores identically, so ranking cannot drift: ' + template);
  }
});

test('3. the alias does not widen retrieval for unrelated questions', () => {
  const unrelated = [
    ['How do I deposit?', 'deposits.how_to'],
    ['What is the minimum deposit?', 'deposits.minimum'],
    ['How long does a withdrawal take?', 'withdrawals.timing'],
    ['How much is the subscription?', 'subscription.price']
  ];
  for (const [question, expected] of unrelated) {
    const hits = retriever.retrieve(question);
    assert.ok(hits.length > 0, question + ' still answers');
    assert.strictEqual(hits[0].id, expected, question + ' keeps its entry');
  }
  assert.deepStrictEqual(retriever.retrieve('zzz qqq'), [], 'noise still returns nothing');
});

test('4. the approved answers are branded with the CURRENT name only', () => {
  if (LEGACY === CURRENT) return;
  const entries = retriever.entries;
  const leaks = [];
  for (const entry of entries) {
    for (const field of ['answer', 'question']) {
      const text = String(entry[field] || '');
      // The legal entity, the domains and the handles legitimately keep the old
      // spelling; anything else is copy that did not follow the rename.
      const stripped = text
        .replace(new RegExp(BRAND.legalName, 'g'), '')
        .replace(/https?:\/\/[^\s"']*arbitrix\.(?:pro|ai)[^\s"']*/gi, '')
        .replace(/@?[A-Za-z]*arbitrix[A-Za-z0-9_]*/g, '');
      if (new RegExp('\\b' + LEGACY + '\\b', 'i').test(stripped)) {
        leaks.push(entry.id + '.' + field);
      }
    }
  }
  assert.deepStrictEqual(leaks, [], 'no approved answer still names the pre-rename brand');
});

test('5. the dialogue engine understands both spellings identically', () => {
  const questions = [
    'what is %NAME%',
    'what does %NAME% do',
    'how does %NAME% work',
    'tell me about %NAME%'
  ];
  for (const template of questions) {
    const legacy = E.planTurn({ text: template.replace('%NAME%', BRAND.source), state: {} });
    const current = E.planTurn({ text: template.replace('%NAME%', BRAND.name), state: {} });
    assert.strictEqual(legacy.handled, current.handled, 'same handling: ' + template);
    assert.strictEqual(legacy.nextState.lastIntent, current.nextState.lastIntent,
      'same intent: ' + template);
    assert.deepStrictEqual(legacy.lines, current.lines, 'same reply: ' + template);
  }
});

test('6. the Arabic platform phrasing works with both spellings', () => {
  const arabic = '\u0645\u0627\u0630\u0627 \u062a\u0641\u0639\u0644 ';
  for (const name of [BRAND.source, BRAND.name]) {
    const plan = E.planTurn({ text: arabic + name, state: {} });
    assert.strictEqual(plan.nextState.lastIntent, 'platform',
      'Arabic "what does <name> do" is the platform question: ' + name);
  }
});

test('7. aliasing never rewrites what the customer wrote', () => {
  if (LEGACY === CURRENT) return;
  const original = 'hi, is ' + BRAND.source + ' safe?';
  const plan = E.planTurn({ text: original, state: {} });
  // The engine answers; the important part is that no reply echoes the alias
  // rewrite back as if the customer had typed the new name.
  const rendered = JSON.stringify(plan.lines || []);
  assert.ok(!rendered.includes(BRAND.source.toLowerCase() + '?'), 'no mangled echo');
  assert.ok(plan.handled, 'the question is answered');
});
