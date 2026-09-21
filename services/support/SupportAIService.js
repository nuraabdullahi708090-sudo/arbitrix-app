'use strict';

/**
 * SupportAIService - the AI customer-support layer for Arbitrix (Stage 1).
 *
 * Contract:
 *   - receive a customer question
 *   - retrieve relevant APPROVED knowledge (never invent an answer)
 *   - generate a concise, beginner-friendly answer
 *   - refuse / hand off when the knowledge does not contain the answer, or when
 *     the question is sensitive (payment disputes, account access, unusual
 *     withdrawals, missing funds, secret handling)
 *
 * Deliberately decoupled from the transport: it receives a question string and
 * returns text. It holds no database handle, no trading/withdrawal access and no
 * account-control tools, and it is NOT imported by the trading stack. Since
 * Stage 2 it is injected into the Telegram support bot as an OPTIONAL
 * collaborator (see services/TelegramSupportService.js), which is the only
 * consumer, and it is still inactive unless AI_SUPPORT_ENABLED=true.
 *
 * DISABLED BY DEFAULT: `AI_SUPPORT_ENABLED` must be exactly "true" for ask() to
 * do any retrieval or generation. No LLM provider is contacted unless an API key
 * is supplied through the environment, and the default provider is the offline
 * "knowledge" provider (no key, no network).
 */

const SupportKnowledge = require('./SupportKnowledge');
const SupportGuidelines = require('./SupportGuidelines');
const { createProvider, listProviders, DEFAULT_TIMEOUT_MS } = require('./providers');

const DEFAULT_MIN_SCORE = 2;
const DEFAULT_MAX_ANSWER_CHARS = 1200;

/**
 * The offline provider that ECHOES approved knowledge. Text it returns is the
 * approved ENGLISH wording, never a sentence a model wrote for this request, so it
 * must never be mistaken for an answer already in the customer's language. See the
 * `source` / `modelGenerated` provenance fields every outcome carries.
 */
const KNOWLEDGE_PROVIDER_NAME = 'knowledge';

/** Sensitive topics that must always reach a human. Order matters (first wins). */
const HUMAN_ESCALATION_TRIGGERS = Object.freeze([
  {
    name: 'payment_dispute',
    re: /\b(dispute|chargeback|charge ?back|refund|double[-\s]?charg\w*|unauthori[sz]ed\s+(payment|charge|transaction)|fraud\w*|scam\w*|stole\w*)\b/i
  },
  {
    name: 'missing_funds',
    re: /\b(funds?|balance|money)\b[^?]{0,30}\b(missing|gone|disappear\w*|stolen|vanished)\b/i
  },
  {
    name: 'deposit_not_credited',
    re: /\b(deposit|payment)\b[^?]{0,50}\b(not|never|did ?n[o']?t|has ?n[o']?t|still)\b[^?]{0,30}\b(credit\w*|arriv\w*|receiv\w*|show\w*|appear\w*|reflect\w*)\b/i
  },
  {
    name: 'withdrawal_problem',
    re: /\bwithdraw\w*\b[^?]{0,50}\b(stuck|pending|not (arriv\w*|receiv\w*)|did ?n[o']?t|fail\w*|missing|delay\w*|problem|issue|reject\w*|unusual|wrong)\b/i
  },
  {
    name: 'status_check',
    re: /\b(did|has|have|is|was|when)\b[^?]{0,35}\b(my|the)\b[^?]{0,25}\b(deposit|withdrawal|payment|transaction)\b[^?]{0,35}\b(go through|complete\w*|arriv\w*|process\w*|confirm\w*|credit\w*|receiv\w*|sent|reflected)\b/i
  },
  {
    name: 'account_access',
    re: /\b((can ?not|can't|unable to|locked out|forgot)\b[^?]{0,30}\b(log ?in|sign ?in|access|password|account)\b|\b(log ?in|sign ?in|account)\b[^?]{0,25}\b(problem|issue|fail\w*|locked)\b)/i
  },
  {
    name: 'human_request',
    // Deliberately narrow: an explicit request to be CONNECTED to a person.
    // Questions like "how do I contact a human?" are answered from the
    // contact_human knowledge entry instead of being blanket-escalated.
    re: /\b((talk|speak|chat)\s+to\s+(a\s+)?(human|person|agent|someone|representative)|connect me (to|with)[^?]{0,20}(human|agent|support|person)|i (want|need) (a )?(human|agent|real person)|get me a (human|agent))\b/i
  }
]);

const ADVICE_INTENT = /\b(should i (invest|deposit|buy|sell|trade)|how much should i (invest|deposit|buy|trade)|what should i (invest|buy|trade)|is it (a )?good (investment|idea|time)|financial advice|which (asset|coin|token) should)\b/i;

const PROFIT_INTENT = /\b(guarantee\w*|risk[-\s]?free|assured\w*|promise\w*|will i (make|earn|profit)|how much will i (make|earn)|can i (make|earn) money|sure profit|can ?not lose|can't lose)\b/i;

/** Read configuration from an env-shaped object. Never logs any value. */
function resolveSupportAIConfig(env) {
  const e = env || {};
  const provider = String(e.AI_SUPPORT_PROVIDER || 'knowledge').trim().toLowerCase() || 'knowledge';
  const providerKeyEnv = provider === 'openai' ? 'OPENAI_API_KEY'
    : provider === 'anthropic' ? 'ANTHROPIC_API_KEY'
    : provider === 'deepseek' ? 'DEEPSEEK_API_KEY'
    : null;
  const apiKey = String(
    e.AI_SUPPORT_API_KEY || (providerKeyEnv ? e[providerKeyEnv] : '') || ''
  ).trim() || null;

  const timeoutRaw = Number(e.AI_SUPPORT_TIMEOUT_MS);
  const maxCharsRaw = Number(e.AI_SUPPORT_MAX_ANSWER_CHARS);
  const minScoreRaw = Number(e.AI_SUPPORT_MIN_SCORE);

  return {
    enabled: String(e.AI_SUPPORT_ENABLED || '').trim().toLowerCase() === 'true',
    provider,
    model: String(e.AI_SUPPORT_MODEL || '').trim() || null,
    apiKey,
    // Optional endpoint override (currently honoured by the OpenAI-compatible
    // 'deepseek' provider for a proxy/self-hosted gateway). A malformed value is
    // ignored downstream in favour of the provider default.
    baseUrl: String(e.AI_SUPPORT_BASE_URL || '').trim() || null,
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS,
    maxAnswerChars: Number.isFinite(maxCharsRaw) && maxCharsRaw > 0 ? maxCharsRaw : DEFAULT_MAX_ANSWER_CHARS,
    minScore: Number.isFinite(minScoreRaw) && minScoreRaw > 0 ? minScoreRaw : DEFAULT_MIN_SCORE
  };
}

/** Safe, secret-free description of the configuration (never the key value). */
function describeSupportAIConfig(config) {
  const cfg = config || {};
  return {
    enabled: cfg.enabled === true,
    provider: cfg.provider || 'knowledge',
    model: cfg.model || null,
    hasApiKey: Boolean(cfg.apiKey),
    baseUrl: cfg.baseUrl || null,
    timeoutMs: cfg.timeoutMs,
    maxAnswerChars: cfg.maxAnswerChars,
    minScore: cfg.minScore,
    supportedProviders: listProviders()
  };
}

function truncate(text, max) {
  const s = String(text === null || text === undefined ? '' : text);
  if (!Number.isFinite(max) || max <= 0 || s.length <= max) return s;
  return s.slice(0, max - 1).trim() + '\u2026';
}

function createSupportAIService(options = {}) {
  const config = options.config || resolveSupportAIConfig(options.env || process.env || {});
  const logger = options.logger || null;

  const knowledge = options.knowledge
    || SupportKnowledge.readKnowledge(options.knowledgePath || SupportKnowledge.DEFAULT_KNOWLEDGE_PATH);
  const problems = SupportKnowledge.validateKnowledge(knowledge);
  if (problems.length > 0) {
    throw new Error('SupportAIService: invalid knowledge base: ' + problems.join('; '));
  }
  const retriever = options.retriever || SupportKnowledge.createRetriever(knowledge, { minScore: config.minScore });
  const provider = options.provider || createProvider(config.provider, {
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: config.timeoutMs,
    baseUrl: config.baseUrl,
    fetchImpl: options.fetchImpl
  });

  const entryById = (id) => retriever.getEntry(id);

  function classify(question) {
    const text = String(question === null || question === undefined ? '' : question).trim();
    if (!text) return { intent: 'empty', needsHuman: true, reason: 'empty' };
    if (SupportGuidelines.containsLikelySecret(text)) {
      return { intent: 'secret_shared', needsHuman: true, reason: 'secret-shared' };
    }
    if (SupportGuidelines.asksForSecrets(text)) {
      return { intent: 'secret_request', needsHuman: true, reason: 'secret-request' };
    }
    for (const trigger of HUMAN_ESCALATION_TRIGGERS) {
      if (trigger.re.test(text)) return { intent: 'sensitive', needsHuman: true, reason: trigger.name };
    }
    if (ADVICE_INTENT.test(text)) return { intent: 'advice', needsHuman: true, reason: 'personal-advice' };
    if (PROFIT_INTENT.test(text)) return { intent: 'profit', needsHuman: false, reason: 'profit-intent' };
    return { intent: 'question', needsHuman: false, reason: null };
  }

  const result = (over) => Object.assign({
    enabled: config.enabled === true,
    answered: false,
    needsHuman: true,
    kind: 'handoff',
    answer: SupportGuidelines.UNCERTAIN_TEXT,
    entryId: null,
    category: null,
    confidence: 0,
    provider: provider.name,
    // PROVENANCE of `answer` - what the text IS, independent of `kind`/`reason`:
    //   'knowledge' - approved knowledge-base wording. English by construction.
    //   'provider'  - a MODEL wrote it for this request, in the requested language.
    // `modelGenerated` is the boolean a caller must switch on before assuming the
    // text is already in the customer's language. The DEFAULT is the safe one:
    // anything that does not explicitly claim provider provenance (guardrails,
    // handoffs, refusals, approved-text fallbacks, truncation filter results) is
    // approved English, never a customer-language answer.
    source: 'knowledge',
    modelGenerated: false,
    sources: [],
    reason: null,
    filtered: false,
    unsupportedClaims: []
  }, over || {});

  function logEvent(question, outcome) {
    if (typeof logger !== 'function' && (!logger || typeof logger.info !== 'function')) return;
    const line = '[SupportAI] ' + JSON.stringify({
      provider: provider.name,
      intent: outcome.reason || outcome.kind,
      answered: outcome.answered === true,
      needsHuman: outcome.needsHuman === true,
      entryId: outcome.entryId || null,
      question: SupportGuidelines.redactSecrets(String(question || '')).slice(0, 200)
    });
    if (typeof logger === 'function') logger(line);
    else logger.info(line);
  }

  /**
   * Answer a customer question in `language` (en / pt / ar).
   *
   * The language directive is appended to the system instructions as its own
   * highest-priority block, so the model answers in the customer's selected
   * language and does not drift back to English because the question happened to
   * contain an English word. Nothing else about the pipeline changed: retrieval,
   * the guardrails and the groundedness filter are the same.
   */
  async function askInternal(question, language) {

    if (config.enabled !== true) {
      const outcome = result({
        enabled: false,
        kind: 'disabled',
        answer: SupportGuidelines.AI_DISABLED_TEXT,
        reason: 'disabled',
        provider: provider.name
      });
      logEvent(question, outcome);
      return outcome;
    }

    const text = String(question === null || question === undefined ? '' : question).trim();
    const intent = classify(text);

    if (intent.intent === 'empty') {
      const outcome = result({ answer: SupportGuidelines.PROMPT_FOR_QUESTION_TEXT, reason: 'empty' });
      logEvent(text, outcome);
      return outcome;
    }

    if (intent.intent === 'secret_shared') {
      const outcome = result({
        kind: 'refusal',
        answer: SupportGuidelines.SECRET_SHARED_TEXT,
        reason: 'secret-shared'
      });
      logEvent(text, outcome);
      return outcome;
    }

    if (intent.intent === 'secret_request') {
      const outcome = result({
        kind: 'refusal',
        answer: SupportGuidelines.SECRET_REFUSAL_TEXT,
        reason: 'secret-request'
      });
      logEvent(text, outcome);
      return outcome;
    }

    if (intent.intent === 'sensitive') {
      const outcome = result({
        kind: 'handoff',
        answer: intent.reason === 'status_check'
          ? SupportGuidelines.PAYMENT_STATUS_TEXT
          : SupportGuidelines.HUMAN_HANDOFF_TEXT,
        reason: intent.reason
      });
      logEvent(text, outcome);
      return outcome;
    }

    if (intent.intent === 'advice') {
      const entry = entryById('guardrails.no_advice');
      const outcome = result({
        answered: true,
        needsHuman: true,
        kind: 'guardrail',
        answer: entry ? entry.answer : SupportGuidelines.UNCERTAIN_TEXT,
        entryId: entry ? entry.id : null,
        category: entry ? entry.category : null,
        reason: 'personal-advice'
      });
      logEvent(text, outcome);
      return outcome;
    }

    if (intent.intent === 'profit') {
      const entry = entryById('guardrails.no_guarantee');
      const outcome = result({
        answered: true,
        needsHuman: false,
        kind: 'guardrail',
        answer: entry ? entry.answer : SupportGuidelines.UNCERTAIN_TEXT,
        entryId: entry ? entry.id : null,
        category: entry ? entry.category : null,
        reason: 'profit-intent'
      });
      logEvent(text, outcome);
      return outcome;
    }

    const hits = retriever.retrieve(text, { minScore: config.minScore });
    if (hits.length === 0) {
      const outcome = result({ kind: 'unknown', answer: SupportGuidelines.UNCERTAIN_TEXT, reason: 'no-knowledge' });
      logEvent(text, outcome);
      return outcome;
    }

    const top = hits[0];

    // A 'handoff' entry is a known topic that must be handled by a person.
    if (top.kind === 'handoff') {
      const outcome = result({
        kind: 'handoff',
        answer: top.answer,
        entryId: top.id,
        category: top.category,
        confidence: top.score,
        sources: [top.source],
        reason: 'knowledge-handoff'
      });
      logEvent(text, outcome);
      return outcome;
    }

    let generated = null;
    let providerFailed = false;
    try {
      generated = await provider.generate({
        question: text,
        hits,
        instructions: SupportGuidelines.instructionsFor(language)
      });
    } catch (error) {
      // Never invent: fall back to the APPROVED knowledge text, or hand off.
      providerFailed = true;
      generated = { text: null, noAnswer: true };
    }

    let answer = generated && generated.text ? String(generated.text).trim() : null;
    // WHO wrote this text? The offline `knowledge` provider echoes the APPROVED
    // English wording, so reaching us through the provider interface does NOT make
    // it a customer-language answer: only a non-knowledge provider's text is
    // 'provider' (model-generated). Every fallback to approved text below keeps
    // (or restores) the 'knowledge' provenance.
    const wroteText = !!(generated && generated.text
      && ((generated.provider || provider.name) !== KNOWLEDGE_PROVIDER_NAME));
    let source = wroteText ? 'provider' : 'knowledge';

    if (!answer) {
      // Provider had nothing (or was unavailable). If we have an approved
      // answer, use it verbatim; otherwise hand off.
      const approved = hits.find((h) => h.kind === 'info') || top;
      if (approved && approved.answer) {
        answer = approved.answer;
        source = 'knowledge';
      } else {
        const outcome = result({ kind: 'unknown', answer: SupportGuidelines.UNCERTAIN_TEXT, reason: 'no-answer' });
        logEvent(text, outcome);
        return outcome;
      }
    }

    // Last-line filters. `assertSafeAnswer` covers policy violations (promises,
    // credential requests, payment claims). Stage 3 adds a groundedness check:
    // every amount, percentage and duration a GENERATED answer states must also
    // appear in the approved knowledge retrieved for that question, so an
    // external model cannot invent a deposit or withdrawal requirement.
    let filtered = false;
    const unsupportedClaims = SupportGuidelines.findUnsupportedClaims(answer, hits);
    const violations = SupportGuidelines.assertSafeAnswer(answer)
      .concat(unsupportedClaims.map((token) => 'unsupported-claim:' + token));
    if (violations.length > 0) {
      filtered = true;
      const approved = hits.find((h) => h.kind === 'info') || top;
      const fallbackText = approved && approved.answer ? approved.answer : SupportGuidelines.UNCERTAIN_TEXT;
      const fallbackSafe = SupportGuidelines.assertSafeAnswer(fallbackText).length === 0
        && SupportGuidelines.findUnsupportedClaims(fallbackText, hits).length === 0;
      answer = fallbackSafe ? fallbackText : SupportGuidelines.UNCERTAIN_TEXT;
      // Whatever we replaced it with is APPROVED wording, not model-written text
      // for this request - provenance must follow the text, not the provider.
      source = 'knowledge';
    }

    const outcome = result({
      answered: true,
      needsHuman: top.offerHuman === true,
      kind: top.kind === 'guardrail' ? 'guardrail' : 'answer',
      answer: truncate(answer, config.maxAnswerChars),
      entryId: top.id,
      category: top.category,
      confidence: top.score,
      sources: hits.map((h) => h.source).filter(Boolean),
      reason: providerFailed ? 'provider-fallback' : null,
      // Explicit provenance: callers must switch on `modelGenerated`, never infer
      // "already in the customer's language" from `kind`/`reason`.
      source,
      modelGenerated: source === 'provider',
      filtered,
      unsupportedClaims
    });
    logEvent(text, outcome);
    return outcome;
  }

  /**
   * Public entry point. Resolves the requested language defensively (any
   * missing/invalid/unsupported value becomes 'en') and annotates the outcome
   * with it for observability.
   *
   * NOTE for callers: `language` is what was REQUESTED, NOT a statement about the
   * text. Switch on the provenance fields to decide what to do with `answer`:
   *   - `modelGenerated: true` (`source: 'provider'`) - a MODEL wrote the text for
   *     this request, so it is expected to already be in `language`.
   *   - `modelGenerated: false` (`source: 'knowledge'`) - APPROVED knowledge-base
   *     wording, which is ENGLISH by construction (guardrails, handoffs, refusals,
   *     the offline `knowledge` provider and every approved-text fallback). A
   *     caller serving a non-English customer MUST localize it or replace it with
   *     a localized fallback - never send it verbatim.
   * `kind` and `reason` are kept for compatibility and telemetry; they are NOT a
   * reliable language signal.
   */
  async function ask(question, askOptions = {}) {
    const language = SupportGuidelines.normalizeAnswerLanguage(askOptions && askOptions.language);
    const outcome = await askInternal(question, language);
    if (outcome && typeof outcome === 'object') outcome.language = language;
    return outcome;
  }

  function describe() {
    return describeSupportAIConfig(config);
  }

  function knowledgeMeta() {
    return {
      version: knowledge.version,
      entryCount: retriever.count,
      categories: (knowledge.categories || []).length,
      conflicts: (knowledge.conflicts || []).map((c) => ({ id: c.id, status: c.status }))
    };
  }

  return {
    ask,
    classify,
    retrieve: (question, opts) => retriever.retrieve(question, opts),
    isEnabled: () => config.enabled === true,
    describe,
    knowledgeMeta,
    providerName: () => provider.name,
    config
  };
}

module.exports = {
  DEFAULT_MIN_SCORE,
  DEFAULT_MAX_ANSWER_CHARS,
  HUMAN_ESCALATION_TRIGGERS,
  ADVICE_INTENT,
  PROFIT_INTENT,
  resolveSupportAIConfig,
  describeSupportAIConfig,
  createSupportAIService
};
