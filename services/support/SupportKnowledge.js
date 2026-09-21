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
 * Build a retriever over the knowledge base.
 *
 * Scoring is keyword-first and deterministic:
 *   - a multi-word keyword phrase present in the question  -> +3
 *   - a single keyword token present in the question       -> +2
 *   - a token shared with the entry's canonical question   -> +1
 * An entry scores only when it shares at least one keyword token, so unrelated
 * questions return no hits (which the service turns into a human hand-off)
 * rather than a random best-effort answer.
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

  function retrieve(question, options = {}) {
    const limit = Number.isFinite(options.limit) ? options.limit : 3;
    const threshold = Number.isFinite(options.minScore) ? options.minScore : minScore;
    const questionTokens = new Set(tokenize(question));
    const normalizedQuestion = normalize(question);
    if (questionTokens.size === 0) return [];

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

    hits.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
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
  normalize,
  tokenize,
  isNegatedAt,
  findUnnegatedPhrases,
  findPromiseViolations,
  readKnowledge,
  validateKnowledge,
  flattenEntries,
  createRetriever,
  loadSupportKnowledge
};
