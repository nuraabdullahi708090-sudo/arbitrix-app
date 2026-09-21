'use strict';

/**
 * Support policy: the instructions and guardrails the AI customer-support layer
 * must obey, plus the detectors used to enforce them.
 *
 * Kept in one place so the rules are testable and cannot drift between the
 * prompt, the answer filter and the refusal messages.
 */

const { FORBIDDEN_PROMISE_PHRASES, isNegatedAt } = require('./SupportKnowledge');

/**
 * System prompt for a future LLM provider. The default (knowledge) provider
 * needs no LLM, but any provider that is configured later receives this as its
 * system instruction, so the rules travel with the code.
 */
const SUPPORT_INSTRUCTIONS = [
  'You are the Arbitrix customer-support assistant. You help beginners understand how Arbitrix works.',
  '',
  'Answer ONLY from the approved Arbitrix knowledge you are given. If the answer is not in that knowledge, say you do not have that information and offer human support. Never invent a policy, amount, fee, limit, time, or process.',
  '',
  'Hard rules - never break these:',
  '1. Never promise profits, returns, or guaranteed outcomes. Trading involves risk and users can lose money.',
  '2. Never give personalized financial or trading advice (for example, how much to invest or which asset to choose).',
  '3. Never request, repeat, or expose passwords, private keys, seed phrases, API keys, one-time codes (OTP/2FA), recovery codes, or any other secret.',
  '4. Never claim a payment, deposit, or withdrawal has been completed or credited unless the platform has authoritative evidence. You do not have account access.',
  '5. Hand off to a human for payment disputes, account-access problems, unusual or missing withdrawals, missing funds, and anything you are unsure about.',
  '6. If information is uncertain or unavailable, say so plainly and offer human support. It is always correct to say "I do not know" and escalate.',
  '7. Keep answers short, plain, and beginner-friendly. Do not use jargon without explaining it.',
  '8. Never ask the user to move the conversation off official channels.'
].join('\n');

/** Shown when the AI support layer is disabled (the default). */
const AI_DISABLED_TEXT =
  'Automated answers are currently turned off. I have saved your message and a member of our support team will help you here.';

/** Shown for an empty/unusable question. */
const PROMPT_FOR_QUESTION_TEXT =
  'Please send your question as a normal message and a support agent will assist you here.';

/** Shown when the knowledge base has no approved answer. */
const UNCERTAIN_TEXT =
  'I do not have an approved answer for that, so I do not want to guess. I have flagged this for our support team - a human can help you with it here.';

/** Shown for topics that must always be handled by a person. */
const HUMAN_HANDOFF_TEXT =
  'This is best handled by our support team, so I have passed it to a human. Please keep an eye on this chat and a member of the team will assist you.';

/** Shown when the user appears to be asking for a secret we must never reveal. */
const SECRET_REFUSAL_TEXT =
  'I cannot share or confirm passwords, private keys, seed phrases, or one-time codes, and Arbitrix support will never ask you for them. Never share these with anyone. If you have an account-access problem, please use "Forgot password" or ask for a human here.';

/** Shown when the user appears to have sent a secret in the chat. */
const SECRET_SHARED_TEXT =
  'Please do not share passwords, private keys, seed phrases, or one-time codes here. For your safety I have not repeated it. If you shared a credential, change it immediately and ask for a human if you need help securing your account.';

/** Shown when a question is about a payment/withdrawal status we cannot verify. */
const PAYMENT_STATUS_TEXT =
  'I do not have access to your account or payment details, so I cannot confirm the status of a deposit or withdrawal from here. I have passed this to our support team, who can check it for you using your transaction reference.';

/** Phrases that must never appear in a generated answer. */
const FORBIDDEN_ANSWER_PATTERNS = Object.freeze([
  ...FORBIDDEN_PROMISE_PHRASES,
  'you will make', 'you will earn', 'you will profit'
]);

/** Phrases where the assistant would be soliciting a secret from the user. */
const CREDENTIAL_REQUEST_PATTERNS = Object.freeze([
  /\b(send|share|give|provide|enter|type|confirm|tell)\b[^.]{0,30}\b(your|the)\b[^.]{0,20}\b(password|passphrase|private key|secret key|seed phrase|mnemonic|api key|otp|one[- ]time code|2fa code|recovery code|recovery phrase)\b/i,
  /\bwhat('s| is)\b[^.]{0,25}\b(your|the|my)\b[^.]{0,20}\b(password|private key|seed phrase|api key|otp|recovery code)\b/i
]);

/** Claims that a money movement already happened (needs authoritative evidence). */
const PAYMENT_CLAIM_PATTERNS = Object.freeze([
  /\b(your|the)\s+(payment|deposit|withdrawal|transaction|transfer)\s+(has|have|is|was|were)\s+(been\s+)?(completed|credited|processed|approved|confirmed|sent|paid)\b/i
]);

// ---- secret / credential detection -------------------------------------

const SECRET_VALUE_PATTERNS = Object.freeze([
  { name: 'private_key', re: /\b0x[a-f0-9]{64}\b/i },
  { name: 'raw_private_key', re: /\b[a-f0-9]{64}\b/i },
  { name: 'telegram_bot_token', re: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/ },
  { name: 'seed_phrase', re: /\b(?:[a-z]{3,}\s+){11,}[a-z]{3,}\b/ },
  { name: 'api_key_value', re: /\b(?:sk|pk|rk|api|key)[-_][A-Za-z0-9]{16,}\b/i },
  { name: 'assigned_secret', re: /\b(password|passphrase|private key|secret key|seed phrase|mnemonic|api key|otp|one[- ]time code|2fa code|recovery code|recovery phrase)\b\s*(?:is|=|:)\s*\S{4,}/i }
]);

const SECRET_WORDS =
  /\b(password|passphrase|private key|secret key|seed phrase|mnemonic|api key|apikey|otp|one[- ]time code|2fa code|authenticator code|recovery code|recovery phrase)\b/i;

const REVEAL_VERBS =
  /\b(what('s| is)|tell me|show|share|give|send|reveal|read out|type|enter|provide|confirm|recover)\b/i;

/** True when the text appears to CONTAIN a secret value. */
function containsLikelySecret(text) {
  const s = String(text === null || text === undefined ? '' : text);
  if (!s) return false;
  return SECRET_VALUE_PATTERNS.some((p) => p.re.test(s));
}

/** True when the message appears to ask us to reveal a secret. */
function asksForSecrets(text) {
  const s = String(text === null || text === undefined ? '' : text);
  if (!s) return false;
  return SECRET_WORDS.test(s) && REVEAL_VERBS.test(s);
}

/** Replace anything secret-shaped with a placeholder (for logs/telemetry). */
function redactSecrets(text) {
  let s = String(text === null || text === undefined ? '' : text);
  if (!s) return '';
  SECRET_VALUE_PATTERNS.forEach((p) => { s = s.replace(new RegExp(p.re.source, 'gi'), '[redacted]'); });
  return s;
}

/** Index of the first occurrence of a phrase that is not inside a negated clause. */
function indexOfUnnegatedPhrase(s, phrase) {
  const lower = s.toLowerCase();
  const p = String(phrase).toLowerCase();
  if (!p) return -1;
  let from = 0;
  for (;;) {
    const at = lower.indexOf(p, from);
    if (at === -1) return -1;
    if (!isNegatedAt(s, at)) return at;
    from = at + p.length;
  }
}

/** Index of the first regex match that is not inside a negated clause. */
function firstUnnegatedMatchIndex(s, re) {
  const flags = re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags;
  const g = new RegExp(re.source, flags);
  let match;
  let guard = 0;
  while ((match = g.exec(s)) !== null && guard < 100) {
    guard += 1;
    if (!isNegatedAt(s, match.index)) return match.index;
    if (g.lastIndex === match.index) g.lastIndex += 1;
  }
  return -1;
}

/** True when the text asks the customer for a credential (not a "never share" warning). */
function isCredentialRequest(text) {
  const s = String(text === null || text === undefined ? '' : text);
  if (!s) return false;
  return CREDENTIAL_REQUEST_PATTERNS.some((re) => firstUnnegatedMatchIndex(s, re) !== -1);
}

/**
 * Last-line answer filter. Returns the list of policy violations found in a
 * candidate answer (empty = safe to send).
 *
 * Negation-aware: "we never ask for your password" and "does not guarantee
 * profits" are disclaimers and must not be reported as violations.
 */
function assertSafeAnswer(text) {
  const s = String(text === null || text === undefined ? '' : text);
  const violations = [];
  if (!s) return ['answer is empty'];
  FORBIDDEN_ANSWER_PATTERNS.forEach((phrase) => {
    if (indexOfUnnegatedPhrase(s, phrase) !== -1) violations.push('promise:' + phrase);
  });
  CREDENTIAL_REQUEST_PATTERNS.forEach((re, i) => {
    if (firstUnnegatedMatchIndex(s, re) !== -1) violations.push('credential-request:' + i);
  });
  PAYMENT_CLAIM_PATTERNS.forEach((re, i) => {
    if (firstUnnegatedMatchIndex(s, re) !== -1) violations.push('payment-claim:' + i);
  });
  return violations;
}

/**
 * Claim tokens an answer must be able to point at in the approved knowledge:
 * money amounts, percentages and durations. These are the details a customer
 * acts on, and the ones an external model is most likely to invent.
 */
const CLAIM_TOKEN_PATTERNS = Object.freeze([
  /\$\s?\d[\d,]*(?:\.\d+)?/g,
  /\b\d[\d,]*(?:\.\d+)?\s?(?:usdt|usdc|usd|eur|gbp)\b/gi,
  /\b\d[\d,]*(?:\.\d+)?\s?%/g,
  /\b\d[\d,]*(?:\s?[-\u2013]\s?\d[\d,]*)?\s?(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\b/gi
]);

const normalizeClaimText = (value) => String(value === null || value === undefined ? '' : value)
  .toLowerCase()
  .replace(/[\u2013\u2014]/g, '-')
  .replace(/\$\s+/g, '$')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * True when `token` appears in `haystack` as a whole figure - i.e. not embedded
 * inside a larger number ("$50" must not match "$500"). Punctuation around the
 * token (sentence periods, commas, parentheses) is irrelevant.
 */
function containsClaimToken(haystack, token) {
  if (!token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\d])' + escaped + '($|[^\\d])', 'i').test(haystack);
}

/**
 * Groundedness check for a GENERATED answer.
 *
 * `assertSafeAnswer` covers policy violations (promises, credential requests,
 * payment claims) but is deliberately knowledge-blind, so on its own it cannot
 * stop an external model inventing a plausible-looking amount, fee, limit or
 * time - e.g. "the minimum deposit is $500". Every money amount, percentage and
 * duration stated in a generated answer must therefore also appear in the
 * approved knowledge retrieved for that question.
 *
 * Returns the list of unsupported figures (empty = grounded).
 */
function findUnsupportedClaims(answer, hits) {
  const text = String(answer === null || answer === undefined ? '' : answer);
  if (!text) return [];
  const approved = normalizeClaimText((Array.isArray(hits) ? hits : [])
    .map((hit) => [hit && hit.question, hit && hit.answer].join(' '))
    .join(' '));
  if (!approved) return [];
  const unsupported = new Set();
  CLAIM_TOKEN_PATTERNS.forEach((pattern) => {
    const matches = text.match(pattern) || [];
    matches.forEach((match) => {
      const token = normalizeClaimText(match);
      if (token && !containsClaimToken(approved, token)) unsupported.add(token);
    });
  });
  return Array.from(unsupported);
}

module.exports = {
  SUPPORT_INSTRUCTIONS,
  AI_DISABLED_TEXT,
  PROMPT_FOR_QUESTION_TEXT,
  UNCERTAIN_TEXT,
  HUMAN_HANDOFF_TEXT,
  SECRET_REFUSAL_TEXT,
  SECRET_SHARED_TEXT,
  PAYMENT_STATUS_TEXT,
  FORBIDDEN_ANSWER_PATTERNS,
  CREDENTIAL_REQUEST_PATTERNS,
  PAYMENT_CLAIM_PATTERNS,
  CLAIM_TOKEN_PATTERNS,
  SECRET_VALUE_PATTERNS,
  SECRET_WORDS,
  REVEAL_VERBS,
  containsLikelySecret,
  asksForSecrets,
  redactSecrets,
  isCredentialRequest,
  indexOfUnnegatedPhrase,
  firstUnnegatedMatchIndex,
  findUnsupportedClaims,
  assertSafeAnswer
};
