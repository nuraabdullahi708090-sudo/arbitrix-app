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
  'Tone: warm, calm and encouraging. Most people you talk to are beginners deciding whether to give Arbitrix a try, so answer their actual question directly and naturally, sound confident about how the platform works, and leave them feeling informed rather than warned.',
  '',
  'Risk wording - follow this exactly:',
  '- Do NOT add risk, loss, or "you can lose money" remarks to ordinary informational answers. This covers how the platform works, the minimum deposit, how to deposit, how withdrawals work, referrals, subscriptions, verification and Demo Mode. Answer the question that was asked and stop.',
  '- Mention trading risk ONLY when the customer directly raises it: guaranteed or assured profits, expected returns or earnings, whether trading is safe, whether they can lose money, or a request for investment or trading advice.',
  '- When it IS relevant, be reassuring rather than alarming: say once, plainly, that returns are not guaranteed and results can vary, and never repeat the warning or pile on worst-case wording.',
  '',
  'Hard rules - never break these:',
  '1. Never promise profits, returns, or guaranteed outcomes, and never imply that an outcome is certain.',
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
 *
 * LANGUAGE AWARENESS (additive): pass `{ language: 'pt' | 'ar' }` to also apply
 * the multilingual denylist for the same hard rules. Called with no options (the
 * pre-existing signature) the behaviour is byte-identical to before, which is
 * what keeps the English pipeline unchanged.
 */
function assertSafeAnswer(text, options) {
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

  const language = baseLanguage(options && options.language);
  if (language !== 'en') {
    const rules = MULTILINGUAL_FORBIDDEN_PATTERNS[language] || [];
    rules.forEach((rule) => {
      if (multilingualMatchIndex(s, rule, language) !== -1) {
        violations.push(language + ':' + rule.name);
      }
    });
  }

  return violations;
}

// ===========================================================================
// Multilingual support (en / pt / ar)
// ===========================================================================

/** Reduce any language tag ("pt-BR", " AR ") to its base code; default 'en'. */
function baseLanguage(language) {
  const value = String(language === null || language === undefined ? '' : language)
    .trim().toLowerCase().split(/[-_]/)[0];
  return value || 'en';
}

/**
 * Names used ONLY inside model prompts (the AI layer stays transport- and
 * locale-agnostic: it never imports the Telegram dictionary).
 */
const LANGUAGE_NAMES = Object.freeze({
  en: 'English',
  pt: 'Brazilian Portuguese',
  ar: 'Modern Standard Arabic'
});

/**
 * True when a negation marker sits shortly BEFORE the match.
 *
 * A denial ("we never ask for your password", "não podemos garantir lucros")
 * is a disclaimer, not a violation - the same intent as the English
 * `isNegatedAt` helper, kept deliberately narrow so it can only ever WHITELIST
 * a statement, never manufacture a violation.
 */
function negativeContextBefore(text, index, language) {
  const window = text.slice(Math.max(0, index - 34), index).toLowerCase();
  return language === 'pt'
    ? /(\bn[ãa]o\b|\bnunca\b|\bjamais\b|\bsem\b)/.test(window)
    : /(لا|لن|ليس|بدون|بلا|دون)/.test(window);
}

/**
 * Supplementary denylist for the SAME hard rules the English patterns enforce
 * (no promised profits, no risk-free claims, no credential requests, no
 * unverifiable payment claims), expressed as POSITIVE assertions.
 *
 * Deliberately a denylist and not a classifier: it catches the phrasings the
 * model is most likely to produce, fails CLOSED (a match withholds the text),
 * and is documented as a supplement to - not a parity replacement for - the
 * English NLU checks. See the limitations note in the delivery report.
 */
const MULTILINGUAL_FORBIDDEN_PATTERNS = Object.freeze({
  pt: Object.freeze([
    { name: 'guarantee', re: /\b(lucros?|retornos?|ganhos?)\s+(garantid|assegurad)\w*/i },
    { name: 'guarantee', re: /\bgarantid\w*\s+(lucros?|retornos?|ganhos?)/i },
    { name: 'risk-free', re: /\b(sem|zero)\s+riscos?\b/i },
    { name: 'no-loss', re: /\bnunca\s+(vai\s+)?perder\b/i },
    {
      name: 'credential-request',
      re: /\b(envie|enviar|mande|mandar|informe|informar|digite|digitar|compartilhe|compartilhar|forne[çc]a|fornecer|confirme|confirmar|passe|passar)\b[^.!?]{0,40}\b(senhas?|chaves? privadas?|frase de recupera[çc][ãa]o|frases? seed|c[óo]digos? de (uso [úu]nico|verifica[çc][ãa]o|seguran[çc]a|2fa))\b/i
    },
    {
      name: 'payment-claim',
      // ENGLISH PARITY with the rule above, which requires a determiner/possessive,
      // the money noun, an auxiliary/perfect marker and a participle ("your deposit
      // has been credited"). This rule used to match the GENERAL present-tense form
      // too - and that is exactly how a faithful translation of an approved
      // knowledge answer reads:
      //   "Os depósitos são creditados ao seu saldo Live."  (deposits.minimum)
      //   "Os saques são processados em 15-30 minutos."     (withdrawals.timing)
      // Both were withheld from Portuguese customers as 'pt:payment-claim', so the
      // approved answers could never reach them. The claim this rule exists to catch
      // - the bot telling a customer that THEIR payment already happened - still
      // matches: "Seu depósito foi creditado", "O saque foi processado",
      // "Seu pagamento está confirmado", "A transferência já foi concluída".
      //
      // NOTE the `(?!\w)` after the auxiliary/marker group instead of `\b`: an
      // alternative ending in an accented vowel ("está", "já", "será") is not a \w
      // character, so `\b` never matches after it and those phrasings would slip
      // through. `(?!\w)` gives the same "end of word" guarantee for both.
      re: /\b(?:o|a|os|as|do|da|dos|das|seu|sua|seus|suas|meu|minha|meus|minhas|este|esta|esse|essa|deste|desta)\s+(?:pagamentos?|dep[óo]sitos?|saques?|transa[çc][õo]es?|transfer[êe]ncias?)\b[^.!?]{0,20}\b(?:foi|foram|est[áa]|est[ãa]o|tem|t[êe]m|j[áa]|acabou|acabaram|havia|tinha|tinham|ser[áa]|ser[ãa]o)(?!\w)[^.!?]{0,30}\b(?:confirmad\w*|creditad\w*|processad\w*|conclu[íi]d\w*|aprovad\w*|recebid\w*|enviad\w*)/i
    }
  ]),
  ar: Object.freeze([
    { name: 'guarantee', re: /(ربح|أرباح|عوائد|مكاسب)\s*(مضمون|مضمونة)/ },
    { name: 'guarantee', re: /(مضمون|مضمونة)\s*(الربح|الأرباح|العوائد|المكاسب)/ },
    { name: 'risk-free', re: /(بدون|بلا|دون)\s*(مخاطر|خطر)/ },
    { name: 'no-loss', re: /لن\s*(تخسر|تخسري|يخسر)/ },
    {
      name: 'credential-request',
      re: /(شارك|أرسل|ارسل|أدخل|ادخل|قدم|زود|أكد|اكد|اكتب)[^.!؟?]{0,40}(كلمة المرور|كلمات المرور|المفتاح الخاص|المفاتيح الخاصة|عبارة الاسترداد|عبارات الاسترداد|رمز التحقق|رمز 2fa)/
    },
    {
      name: 'payment-claim',
      re: /(الإيداع|إيداع|السحب|الدفع|المبلغ)[^.!؟?]{0,30}(تم تأكيده|تمت إضافته|تمت معالجته|مكتمل|تم إتمامه)/
    }
  ])
});

/** First NON-negated match index for a multilingual rule, or -1. */
function multilingualMatchIndex(text, rule, language) {
  const flags = rule.re.flags.indexOf('g') === -1 ? rule.re.flags + 'g' : rule.re.flags;
  const g = new RegExp(rule.re.source, flags);
  let match;
  let guard = 0;
  while ((match = g.exec(text)) !== null && guard < 50) {
    guard += 1;
    if (!negativeContextBefore(text, match.index, language)) return match.index;
    if (g.lastIndex === match.index) g.lastIndex += 1;
  }
  return -1;
}

/** True when the text contains Arabic script (used as a hard language check). */
function isArabicScript(text) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/
    .test(String(text === null || text === undefined ? '' : text));
}

/**
 * Verify the output actually looks like the requested language.
 *
 * For Arabic this is a HARD, deterministic check (the script is unambiguous), so
 * a model that ignores the language directive is caught instead of being sent to
 * the customer. Portuguese cannot be distinguished from English reliably without
 * a dependency, so it is NOT guessed here - see the limitations note.
 */
function hasExpectedScript(text, language) {
  const value = String(text === null || text === undefined ? '' : text);
  if (!value.trim()) return false;
  if (baseLanguage(language) === 'ar') return isArabicScript(value);
  return true;
}

/**
 * Resolve a REQUESTED answer language to one this layer actually supports.
 *
 * Anything missing, malformed or not yet supported resolves to English, so a
 * caller can never make the model answer in a language the platform does not
 * support (and `outcome.language` can never report an unsupported code).
 */
function normalizeAnswerLanguage(language) {
  const code = baseLanguage(language);
  return Object.prototype.hasOwnProperty.call(LANGUAGE_NAMES, code) ? code : 'en';
}

/**
 * The language directive. HIGH PRIORITY: it is appended as its own labelled
 * block so the model cannot treat it as one more style preference, and it states
 * that the selected language is authoritative.
 */
function languageInstruction(language) {
  const code = normalizeAnswerLanguage(language);
  const name = LANGUAGE_NAMES[code];
  return [
    'LANGUAGE RULE (highest priority - overrides every other writing-style rule):',
    '- Write your ENTIRE answer in ' + name + '.',
    '- The customer selected ' + name + ' for this conversation. That selection is authoritative and does not change until the customer changes it with /language.',
    '- Do NOT switch language just because the customer message contains words in another language, an English product term or command, a ticker such as USDT, or a number.',
    '- Keep every number, amount, currency, percentage, duration, ticker, link and command name EXACTLY as approved: translate the words around them, never the values themselves.',
    '- Keep the product name "Arbitrix" and the commands (/language, /escalate, /chatid) untranslated.',
    '- If you cannot say something in ' + name + ', say that in ' + name + ' and offer a human - never fall back to English.'
  ].join('\n');
}

/** The full instruction set sent to a provider for a given customer language. */
function instructionsFor(language) {
  return SUPPORT_INSTRUCTIONS + '\n\n' + languageInstruction(language);
}

/**
 * System instructions for the TRANSLATION layer.
 *
 * The translation layer is a separate concern from answering: it must move text
 * between languages without adding, removing or softening anything. It is told
 * to return the NO_ANSWER sentinel when it cannot comply, which the caller
 * treats as "translation unavailable".
 */
const TRANSLATION_INSTRUCTIONS = [
  'You are a professional translator working for Arbitrix customer support.',
  '',
  'You translate a single message between English, Brazilian Portuguese and Modern Standard Arabic.',
  '',
  'Hard rules - never break these:',
  '1. Output ONLY the translation. No preamble, no explanation, no notes, no surrounding quotes.',
  '2. Translate the meaning faithfully. Never add, remove, soften or strengthen anything.',
  '3. Keep every number, amount, currency symbol, percentage, date, duration and ticker EXACTLY as written.',
  '4. Keep product names (Arbitrix), network names (TRON, TRC20, USDT) and commands (/language, /escalate, /reply, /chatid) unchanged.',
  '5. Never introduce promises, guarantees, returns, financial advice, policies, or any request for passwords, private keys, seed phrases, one-time codes or other credentials.',
  '6. If you cannot translate the message faithfully, reply with exactly NO_ANSWER.'
].join('\n');

/** Build the user prompt for one translation. */
function buildTranslationPrompt(fromLanguage, toLanguage, text) {
  const from = LANGUAGE_NAMES[normalizeAnswerLanguage(fromLanguage)];
  const to = LANGUAGE_NAMES[normalizeAnswerLanguage(toLanguage)];
  return [
    'Translate the message below from ' + from + ' into ' + to + '.',
    'Reply with the translation only, or with exactly NO_ANSWER if you cannot translate it faithfully.',
    '',
    'Message:',
    String(text === null || text === undefined ? '' : text)
  ].join('\n');
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

// ===========================================================================
// Translation fidelity (approved English answer -> pt/ar)
// ===========================================================================

/**
 * The tokens a FAITHFUL translation must carry across unchanged.
 *
 * Same idea as CLAIM_TOKEN_PATTERNS: the details a customer acts on. Money,
 * percentages, quantities of two or more digits and URLs are compared between the
 * approved English source and the translated text in BOTH directions, so a
 * translation can neither lose a value ("$100" -> "100") nor invent one
 * ("15-30 minutes" -> "2-4 minutes"). Single-digit bare numbers are ignored on
 * purpose: enumerations ("1) ...") and product terms ("2FA") may legitimately be
 * written out in another language.
 */
function extractFidelityTokens(text) {
  const value = String(text === null || text === undefined ? '' : text);
  const numbers = [];
  const push = (raw) => {
    const digits = String(raw).replace(/[^\d]/g, '');
    if (digits) numbers.push(digits);
  };
  (value.match(/\$\s?\d[\d.,]*/g) || []).forEach(push);
  (value.match(/\b\d[\d.,]*\s?(?:usdt|usdc|usd|eur|gbp|brl)\b/gi) || []).forEach(push);
  (value.match(/\b\d[\d.,]*\s?%/g) || []).forEach(push);
  (value.match(/\d[\d.,]*/g) || []).forEach((m) => {
    if (m.replace(/[^\d]/g, '').length >= 2) push(m);
  });
  const urls = (value.match(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi) || [])
    .map((u) => u.replace(/[.,;:)\]]+$/, '').toLowerCase());
  return { numbers, urls };
}

/**
 * Compare a translation's tokens with its source. An EMPTY result means every
 * number, amount, percentage and URL survived the translation unchanged.
 */
function checkTranslationFidelity(source, translation) {
  const left = extractFidelityTokens(source);
  const right = extractFidelityTokens(translation);
  const diff = (from, against) => {
    const pool = against.slice();
    const missing = [];
    from.forEach((token) => {
      const index = pool.indexOf(token);
      if (index === -1) missing.push(token);
      else pool.splice(index, 1);
    });
    return missing;
  };
  return {
    missingNumbers: diff(left.numbers, right.numbers),
    addedNumbers: diff(right.numbers, left.numbers),
    missingUrls: diff(left.urls, right.urls),
    addedUrls: diff(right.urls, left.urls)
  };
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
  extractFidelityTokens,
  checkTranslationFidelity,
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
  assertSafeAnswer,
  LANGUAGE_NAMES,
  baseLanguage,
  normalizeAnswerLanguage,
  languageInstruction,
  instructionsFor,
  TRANSLATION_INSTRUCTIONS,
  buildTranslationPrompt,
  MULTILINGUAL_FORBIDDEN_PATTERNS,
  isArabicScript,
  hasExpectedScript
};
