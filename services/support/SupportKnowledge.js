'use strict';

/**
 * Customer-support knowledge base: load, validate and retrieve approved Arbitrix
 * answers from arbitrix-knowledge.json.
 *
 * This module is the ONLY source the support AI layer may answer from. It is
 * deliberately dependency-free and side-effect free (no I/O at require time) so
 * it can be unit-tested and reused without a server.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_KNOWLEDGE_PATH = path.join(__dirname, 'arbitrix-knowledge.json');
const VALID_KINDS = Object.freeze(['info', 'handoff', 'guardrail']);

// Words that carry no retrieval signal.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'doing', 'i', 'you', 'your', 'yours', 'my', 'mine',
  'me', 'we', 'us', 'our', 'they', 'them', 'he', 'she', 'it', 'its',
  'to', 'of', 'for', 'and', 'or', 'but', 'in', 'on', 'at', 'by', 'with',
  'from', 'into', 'over', 'under', 'again', 'then', 'so', 'such', 'no', 'not',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  'how', 'what', 'when', 'where', 'why', 'which', 'who', 'whom', 'that', 'this',
  'there', 'here', 'have', 'has', 'had', 'get', 'got', 'getting',
  'need', 'want', 'like', 'just', 'please', 'tell', 'know', 'any', 'some',
  'about', 'if', 'as', 'than', 'too', 'very', 'also'
]);

const FORBIDDEN_PROMISE_PHRASES = Object.freeze([
  'guaranteed profit', 'guaranteed return', 'guaranteed returns',
  'guaranteed income', 'guarantee profit', 'guarantee a profit',
  'guarantee returns', 'risk-free', 'risk free', 'no risk',
  'assured returns', 'assured profit', 'promised returns',
  'double your money', 'cannot lose', 'can not lose', 'you will definitely',
  // Bare forms catch the reversed word order ("your profit is guaranteed").
  // Negation-aware matching keeps disclaimers ("does not guarantee profits",
  // "nothing is guaranteed") from being flagged.
  'guaranteed', 'guarantee'
]);

/** Lowercase, strip punctuation (keeping alphanumerics), collapse whitespace. */
function normalize(text) {
  return String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Significant (non-stopword) tokens for a piece of text. */
function tokenize(text) {
  return normalize(text).split(' ').filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function readKnowledge(filePath = DEFAULT_KNOWLEDGE_PATH) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/** A negation anywhere in the same clause flips a promise phrase to a disclaimer. */
const NEGATION_RE = /\b(not|never|no|none|without|cannot|can't|won't|doesn't|don't|isn't|aren't|wasn't|weren't|nor|nothing)\b/i;

/** True when the clause containing `index` contains a negation. */
function isNegatedAt(text, index) {
  const s = String(text === null || text === undefined ? '' : text);
  let clauseStart = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = s.charAt(i);
    if (ch === '.' || ch === '!' || ch === '?' || ch === ';' || ch === '\n') { clauseStart = i + 1; break; }
  }
  return NEGATION_RE.test(s.slice(clauseStart, index));
}

/**
 * Phrase occurrences that are NOT negated. "does not guarantee profits" and
 * "never share your password" are disclaimers, not promises/requests, so they
 * must not be reported.
 */
function findUnnegatedPhrases(text, phrases) {
  const s = String(text === null || text === undefined ? '' : text);
  const lower = s.toLowerCase();
  const found = [];
  (phrases || []).forEach((phrase) => {
    const p = String(phrase).toLowerCase();
    if (!p) return;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(p, from);
      if (at === -1) break;
      if (!isNegatedAt(s, at)) { found.push(phrase); break; }
      from = at + p.length;
    }
  });
  return found;
}

/** Promise phrases present in `text` as actual claims (negated ones ignored). */
function findPromiseViolations(text) {
  return findUnnegatedPhrases(text, FORBIDDEN_PROMISE_PHRASES);
}

/**
 * Structural validation. Returns a list of human-readable problems (empty =
 * valid). Intentionally strict: a malformed knowledge file must fail loudly
 * rather than let the AI answer from a half-loaded base.
 */
function validateKnowledge(knowledge) {
  const problems = [];
  if (!knowledge || typeof knowledge !== 'object') return ['knowledge must be an object'];
  if (!knowledge.version || typeof knowledge.version !== 'string') problems.push('version is required');
  if (!Array.isArray(knowledge.categories) || knowledge.categories.length === 0) {
    problems.push('categories must be a non-empty array');
    return problems;
  }

  const categoryIds = new Set();
  const entryIds = new Set();

  knowledge.categories.forEach((category, ci) => {
    const at = 'categories[' + ci + ']';
    if (!category || typeof category !== 'object') return problems.push(at + ' must be an object');
    if (!category.id || typeof category.id !== 'string') problems.push(at + '.id is required');
    else if (categoryIds.has(category.id)) problems.push(at + '.id is duplicated: ' + category.id);
    else categoryIds.add(category.id);
    if (!category.title || typeof category.title !== 'string') problems.push(at + '.title is required');
    if (!Array.isArray(category.entries) || category.entries.length === 0) {
      problems.push(at + '.entries must be a non-empty array');
      return;
    }

    category.entries.forEach((entry, ei) => {
      const et = at + '.entries[' + ei + ']';
      if (!entry || typeof entry !== 'object') return problems.push(et + ' must be an object');
      if (!entry.id || typeof entry.id !== 'string') problems.push(et + '.id is required');
      else if (entryIds.has(entry.id)) problems.push(et + '.id is duplicated: ' + entry.id);
      else entryIds.add(entry.id);
      if (!entry.question || typeof entry.question !== 'string') problems.push(et + '.question is required');
      if (!entry.answer || typeof entry.answer !== 'string') problems.push(et + '.answer is required');
      if (!Array.isArray(entry.keywords) || entry.keywords.length === 0) {
        problems.push(et + '.keywords must be a non-empty array');
      } else if (entry.keywords.some((k) => !k || typeof k !== 'string')) {
        problems.push(et + '.keywords must contain only non-empty strings');
      }
      if (VALID_KINDS.indexOf(entry.kind) === -1) {
        problems.push(et + '.kind must be one of ' + VALID_KINDS.join(', '));
      }
      if (!entry.source || typeof entry.source !== 'string') problems.push(et + '.source is required');
      if (entry.offerHuman !== undefined && typeof entry.offerHuman !== 'boolean') {
        problems.push(et + '.offerHuman must be a boolean when present');
      }
      if (typeof entry.answer === 'string') {
        findPromiseViolations(entry.answer).forEach((phrase) => {
          problems.push(et + '.answer contains a forbidden promise phrase: "' + phrase + '"');
        });
      }
    });
  });

  if (knowledge.conflicts !== undefined) {
    if (!Array.isArray(knowledge.conflicts)) {
      problems.push('conflicts must be an array when present');
    } else {
      knowledge.conflicts.forEach((conflict, i) => {
        const ct = 'conflicts[' + i + ']';
        if (!conflict || !conflict.id) problems.push(ct + '.id is required');
        if (!conflict || !conflict.summary) problems.push(ct + '.summary is required');
        if (!conflict || !Array.isArray(conflict.values) || conflict.values.length === 0) {
          problems.push(ct + '.values must be a non-empty array');
        }
        if (!conflict || !conflict.status) problems.push(ct + '.status is required');
      });
    }
  }

  return problems;
}

/** Flatten categories into retrievable entries, each tagged with its category. */
function flattenEntries(knowledge) {
  const entries = [];
  (knowledge.categories || []).forEach((category) => {
    (category.entries || []).forEach((entry) => {
      entries.push(Object.assign({}, entry, { category: category.id, categoryTitle: category.title }));
    });
  });
  return entries;
}

/**
 * Query intents, used for RANKING ONLY.
 *
 * Retrieval is keyword-first and deterministic, but ordering used to fall back to
 * `a.id.localeCompare(b.id)`, so a tie was won alphabetically: `deposits.asset`
 * beat `withdrawals.requirements` on a 2-2 tie even when the customer explicitly
 * asked about withdrawing, and a withdrawal question could therefore be answered
 * with the deposit-network entry.
 *
 * Each intent maps explicit customer language to the category that answers it.
 * A question that matches one or more intents ranks hits from those categories
 * ahead of hits from other categories. Three deliberate limits keep this safe:
 *   - it reorders only entries that ALREADY cleared the score threshold, so it can
 *     never make an unrelated entry retrievable (questions with no keyword match
 *     still return no hits and fall through to a human hand-off);
 *   - guardrail entries never take part in the intent tier, so a topical preference
 *     cannot promote a safety entry above a stronger info entry;
 *   - when the strongest match is itself a guardrail, no topical re-ranking happens
 *     at all, so a leading safety entry is never demoted.
 * A question matching several intents (e.g. "can I deposit and then withdraw")
 * makes all of their categories preferred, so no intent is privileged arbitrarily.
 */
const QUERY_INTENTS = Object.freeze([
  {
    id: 'withdrawal',
    categories: ['withdrawals'],
    pattern: /\bwithdraw\w*\b|\bcash(?:ing)?\s+out\b|\bcash\s+out\b|\btake\s+out\s+(?:funds|money|cash)\b/
  },
  {
    id: 'deposit',
    categories: ['deposits'],
    pattern: /\bdeposit\w*\b|\bmake\s+a\s+deposit\b|\btop\s+up\b|\badd\s+funds\b|\bfund\s+my\s+account\b/
  },
  {
    id: 'referral',
    categories: ['referrals'],
    pattern: /\breferral\w*\b|\brefer(?:red|ring)?\b|\binvit\w*\b/
  },
  {
    id: 'subscription',
    categories: ['subscription'],
    pattern: /\bsubscri\w*\b|\bpro\s+plan\b|\bmonthly\s+(?:fee|price|plan|payment)\b/
  },
  {
    id: 'verification',
    categories: ['kyc_security'],
    pattern: /\bkyc\b|\bverif\w*\b|\bidentity\s+(?:check|verification|document|card)\b|\bpassport\b|\bselfie\b/
  },
  {
    id: 'promotional_credit',
    categories: ['promotional_credit'],
    pattern: /\bpromotional\s+credit\b|\bpromo\s+credit\b|\bbonus\s+credit\b/
  },
  {
    id: 'demo_mode',
    categories: ['demo_mode'],
    pattern: /\bdemo\b|\bvirtual\s+funds\b|\bpractice\s+(?:mode|account)\b/
  },
  {
    id: 'live_mode',
    categories: ['live_mode'],
    pattern: /\blive\b|\bgo\s+live\b/
  },
  {
    id: 'troubleshooting',
    categories: ['troubleshooting'],
    pattern: /\bnot\s+(?:working|starting)\b|\bstuck\b|\bfail(?:ed|ing|s)?\b|\berror\b|\bbroken\b|\bproblem\b|\bissue\b|\bcannot\b|\bcan\s+t\b/
  },
  {
    id: 'contact_human',
    categories: ['contact_human'],
    pattern: /\bhuman\b|\bagent\b|\brepresentative\b|\bsupport\s+team\b|\bescalate\b/
  }
]);

/** Intent ids detected in a question (normalized, so punctuation is irrelevant). */
function detectQueryIntents(question) {
  const text = normalize(question);
  if (text.length === 0) return [];
  return QUERY_INTENTS.filter((intent) => intent.pattern.test(text)).map((intent) => intent.id);
}

/** Categories preferred by the question's intents (ranking only). */
function queryIntentCategories(question) {
  const text = normalize(question);
  const categories = new Set();
  if (text.length === 0) return categories;
  QUERY_INTENTS.forEach((intent) => {
    if (intent.pattern.test(text)) intent.categories.forEach((category) => categories.add(category));
  });
  return categories;
}

/**
 * Build a retriever over the knowledge base.
 *
 * Scoring is keyword-first and deterministic:
 *   - a multi-word keyword phrase present in the question  -> +3
 *   - a single keyword token present in the question       -> +2
 *   - a token shared with the entry's canonical question   -> +1
 * An entry scores only when it shares at least one keyword token, so unrelated
 * questions return no hits (which the service turns into a human hand-off)
 * rather than a random best-effort answer.
 *
 * Ordering is: query intent (see QUERY_INTENTS) -> score -> entry id. The id
 * comparison keeps the order fully deterministic.
 */
function createRetriever(knowledge, { minScore = 2 } = {}) {
  const entries = flattenEntries(knowledge).map((entry) => {
    const phrases = entry.keywords
      .map((k) => ({ raw: k, norm: normalize(k), tokens: tokenize(k) }))
      .filter((k) => k.norm.length > 0);
    return Object.assign({}, entry, {
      _phrases: phrases,
      _questionTokens: new Set(tokenize(entry.question))
    });
  });

  function scoreEntry(entry, questionTokens, normalizedQuestion) {
    const phrases = entry._phrases || [];
    const singleKeywordTokens = new Set();
    let score = 0;

    phrases.forEach((phrase) => {
      if (phrase.tokens.length > 1) {
        if (phrase.norm.length > 0 && normalizedQuestion.indexOf(phrase.norm) !== -1) score += 3;
      } else {
        phrase.tokens.forEach((token) => singleKeywordTokens.add(token));
      }
    });

    singleKeywordTokens.forEach((token) => {
      if (questionTokens.has(token)) score += 2;
    });
    entry._questionTokens.forEach((token) => {
      if (questionTokens.has(token)) score += 1;
    });

    return score;
  }

  // Deterministic score order: score desc, then entry id as the stable tie-break.
  const byScore = (a, b) => (b.score - a.score) || a.id.localeCompare(b.id);

  function retrieve(question, options = {}) {
    const limit = Number.isFinite(options.limit) ? options.limit : 3;
    const threshold = Number.isFinite(options.minScore) ? options.minScore : minScore;
    const questionTokens = new Set(tokenize(question));
    const normalizedQuestion = normalize(question);
    if (questionTokens.size === 0) return [];

    const preferredCategories = queryIntentCategories(question);

    const hits = [];
    // Only count each keyword once (keywordTokens is per-entry above, so a
    // repeated keyword cannot inflate the score more than once).
    entries.forEach((entry) => {
      const score = scoreEntry(entry, questionTokens, normalizedQuestion);
      if (score >= threshold) {
        hits.push({
          id: entry.id,
          category: entry.category,
          categoryTitle: entry.categoryTitle,
          question: entry.question,
          answer: entry.answer,
          kind: entry.kind,
          offerHuman: entry.offerHuman === true,
          source: entry.source,
          score
        });
      }
    });

    // Ranking: query intent first, then score, then id (fully deterministic).
    //
    // The intent tier only reorders entries that already cleared the threshold, so
    // it cannot make an unrelated entry retrievable. Two safety-first limits apply:
    //   - guardrail entries are excluded from the intent tier, so a topical
    //     preference can never PROMOTE a safety entry above a stronger info entry;
    //   - when the strongest match is itself a guardrail, the score order is kept for
    //     the whole question and no topical re-ranking happens at all, so a leading
    //     safety entry can never be DEMOTED.
    // `score` is left untouched (it stays the raw keyword score).
    hits.sort(byScore);
    const leader = hits[0];
    if (leader && leader.kind !== 'guardrail' && preferredCategories.size > 0) {
      hits.sort((a, b) => {
        const aPreferred = preferredCategories.has(a.category) && a.kind !== 'guardrail';
        const bPreferred = preferredCategories.has(b.category) && b.kind !== 'guardrail';
        if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
        return byScore(a, b);
      });
    }
    return hits.slice(0, Math.max(0, limit));
  }

  return {
    retrieve,
    entries,
    count: entries.length,
    getEntry(id) {
      return entries.find((e) => e.id === id) || null;
    }
  };
}

/** Load + validate + build the retriever in one step. */
function loadSupportKnowledge(filePath = DEFAULT_KNOWLEDGE_PATH, options = {}) {
  const knowledge = readKnowledge(filePath);
  const problems = validateKnowledge(knowledge);
  if (problems.length > 0) {
    throw new Error('invalid support knowledge: ' + problems.join('; '));
  }
  return {
    knowledge,
    version: knowledge.version,
    conflicts: knowledge.conflicts || [],
    retriever: createRetriever(knowledge, options)
  };
}

module.exports = {
  DEFAULT_KNOWLEDGE_PATH,
  VALID_KINDS,
  FORBIDDEN_PROMISE_PHRASES,
  NEGATION_RE,
  STOPWORDS,
  QUERY_INTENTS,
  normalize,
  tokenize,
  isNegatedAt,
  findUnnegatedPhrases,
  findPromiseViolations,
  readKnowledge,
  validateKnowledge,
  flattenEntries,
  detectQueryIntents,
  queryIntentCategories,
  createRetriever,
  loadSupportKnowledge
};
