'use strict';

/**
 * Content safety guard for the Telegram marketing publisher.
 *
 * PURPOSE
 * Every marketing post (welcome, Start Here, channel intro, scheduled weekly
 * content, or an administrator-composed draft) is checked here before it can be
 * queued for autonomous publishing. The guard is deliberately CONSERVATIVE:
 * anything it cannot verify is marked `requiresApproval`, so it can still be
 * reviewed and released by an administrator but never goes out unattended.
 *
 * WHAT IS REUSED
 * services/support/SupportGuidelines.js already owns the customer-facing
 * denylist (promised returns, risk-free claims, credential requests, payment
 * claims) and its negation handling ("we never ask for your password" and
 * "profits are not guaranteed" are DISCLAIMERS, not violations). Reusing it
 * means the support bot and the publisher cannot drift on the hard rules.
 *
 * THREE OUTCOMES
 *   blocked          - a hard policy violation. Never publishable, not even
 *                      after approval (the text must be rewritten).
 *   requiresApproval - not provably false, but unverified: earnings figures,
 *                      testimonials, promotions, urgency, amounts outside the
 *                      configured business facts.
 *   ok               - may publish autonomously once the queue is resumed.
 *
 * SCOPE
 * Pure text analysis. No network, no database, no secrets. Never throws.
 */

const {
  assertSafeAnswer,
  firstUnnegatedMatchIndex,
  isCredentialRequest
} = require('./support/SupportGuidelines');

// ---------------------------------------------------------------------------
// Hard blocks
// ---------------------------------------------------------------------------

const BLOCK_RULES = [
  {
    code: 'recurring-commission',
    detail: 'Recurring, lifetime or passive commission claims are not part of the referral programme',
    patterns: [
      /\b(lifetime|recurring|residual|passive|permanent|forever)\b[^.\n]{0,40}\b(commission|commissions|income|earning|earnings|payout)\b/i,
      /\b(commission|income|earning|earnings)\b[^.\n]{0,20}\b(for life|forever|every month|monthly|ongoing)\b/i,
      /\bcomiss(ã|a)o\b[^.\n]{0,30}\b(vitalícia|recorrente|mensal|perpétua)\b/i,
      /\b(عمولة|دخل)\b[^.\n]{0,30}\b(مدى الحياة|متكررة|شهرية|دائمة)\b/i
    ]
  },
  {
    code: 'unsupported-bonus',
    detail: 'No deposit-bonus, matching-bonus, cashback or promo-code engine exists',
    patterns: [
      /\b(matching|deposit|welcome|flash|signup|sign-up)\s+bonus\b/i,
      /\bbonus\s+(code|match|matching)\b/i,
      /\bcashback\b/i,
      /\b(bônus|bonus)\s+de\s+dep[óo]sito\b/i,
      /\bمكافأة\s+(إيداع|ترحيبية|مطابقة)\b/i
    ]
  },
  {
    code: 'fake-urgency',
    detail: 'Manufactured scarcity or countdown pressure',
    patterns: [
      /\bonly\s+\d+\s+(spots?|slots?|places?)\s+(left|remaining)\b/i,
      /\b(last chance|today only|now or never|expires in \d+\s*(minutes?|hours?))\b/i,
      /\b(últimas? \d+ (vagas|prazos)|somente hoje|expira em \d+)\b/i,
      /\b(آخر فرصة|اليوم فقط|ينتهي خلال \d+)\b/i
    ]
  },
  {
    code: 'withdrawal-minimum-disclosure',
    detail: 'The withdrawal minimum is disclosed only in the withdrawal flow, never in marketing copy',
    patterns: [/\$\s?700\b/, /\b700\s*(usd|dollars|dólares|دولار)\b/i]
  },
  {
    code: 'simulated-as-live-signal',
    detail: 'Simulated opportunities must never be presented as live executable signals',
    patterns: [
      /\b(live|real[- ]time)\s+(arbitrage\s+)?signals?\b/i,
      /\bexecute\s+(this|the)\s+trade\s+now\b/i,
      /\bsinal\s+(ao vivo|em tempo real)\b/i,
      /\bإشارة\s+(مباشرة|فورية)\b/i
    ]
  },
  {
    code: 'credential-request',
    detail: 'Marketing content must never request credentials',
    patterns: [
      /\b(send|share|provide|enter|confirm)\b[^.\n]{0,30}\b(password|private key|seed phrase|recovery phrase|2fa code|otp)\b/i,
      /\b(enviar|compartilhar|informar)\b[^.\n]{0,30}\b(senha|chave privada|frase de recupera)/i,
      /\b(أرسل|شارك)\b[^.\n]{0,30}\b(كلمة المرور|المفتاح الخاص|عبارة الاسترداد)\b/i
    ]
  }
];

// ---------------------------------------------------------------------------
// Requires-approval heuristics
// ---------------------------------------------------------------------------

const REVIEW_RULES = [
  {
    code: 'social-proof',
    detail: 'Testimonials, screenshots and payment proof require explicit administrator approval',
    patterns: [
      /\b(testimonial|review|screenshot|proof of payment|payment proof|verified payout)\b/i,
      /\b(depoimento|avaliação|captura de tela|comprovante)\b/i,
      /\b(شهادة|رأي المستخدم|لقطة شاشة|إثبات الدفع)\b/i
    ]
  },
  {
    code: 'performance-claim',
    detail: 'Earnings, returns or win-rate statements require explicit administrator approval',
    patterns: [
      /\b(profit(ed)?|earn(ed)?|made|return(ed)?|win rate|roi)\b[^.\n]{0,25}\$\s?\d/i,
      /\b\d+(\.\d+)?\s?%\s*(profit|return|gain|win)/i,
      /\b(lucro|ganho|retorno)\b[^.\n]{0,25}\d/i,
      /\b(ربح|عائد)\b[^.\n]{0,25}\d/i
    ]
  },
  {
    code: 'user-count',
    detail: 'Aggregate user, trader or volume figures require verification against production data',
    patterns: [
      /\b\d{1,3}(,\d{3})+\s*(?:\w+\s+){0,2}(users|traders|members|partners|customers)\b/i,
      /\b(active|total)\s+(users|traders|members|partners)\s*[:=]?\s*\d/i
    ]
  }
];

// Amounts that may appear in autonomous content, because they are real,
// configured business facts. Everything else must be approved by a human.
// The configured values are injected per call, so this list is only a backstop.
const DEFAULT_ALLOWED_AMOUNTS = [7, 50, 100];
const DEFAULT_ALLOWED_PERCENTS = [20];

/** Extract every currency amount in the text. */
function extractedAmounts(text) {
  const out = [];
  const re = /\$\s?(\d[\d,]*(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(Number(String(m[1]).replace(/,/g, '')));
  }
  return out;
}

/** Extract every percentage in the text. */
function extractedPercents(text) {
  const out = [];
  const re = /(\d{1,3}(?:\.\d+)?)\s?%/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(Number(m[1]));
  return out;
}

/** Emails, wallet addresses and phone-like strings are never publishable. */
function findPrivateData(text) {
  const findings = [];
  if (/[\w.+-]+@[\w-]+\.[\w.-]{2,}/.test(text)) findings.push('email');
  // TRON/TRC20 base58 address (34 chars, leading T).
  if (/\bT[1-9A-HJ-NP-Za-km-z]{33}\b/.test(text)) findings.push('wallet-address');
  // International phone numbers written compactly.
  if (/(?<!\d)\+\d{8,15}(?!\d)/.test(text)) findings.push('phone-number');
  return findings;
}

/**
 * Language-aware, negation-aware first-match index.
 *
 * The support guard's English helper only understands English negation, and the
 * marketing copy legitimately CONTAINS the phrases it forbids ("never promise
 * guaranteed profit", "not a recurring commission"). Treating those disclaimers
 * as violations would make the approved onboarding text unpublishable, so this
 * wrapper checks a language-specific negation marker BEFORE (70 chars) and a
 * short negation AFTER (30 chars) each match. It can only WHITELIST a phrase,
 * never invent one.
 */
const NEGATION_BEFORE = {
  en: /\b(not|no|never|cannot|can't|don't|doesn't|isn't|aren't|without|avoid|neither|nor)\b/i,
  pt: /(\bn[ãa]o\b|\bnunca\b|\bjamais\b|\bsem\b|\bevite\b|\bevitar\b|\bnenhum\b|\bnenhuma\b)/i,
  ar: /(لا|لن|ليس|ليست|بدون|بلا|دون|تجنب)/
};

const NEGATION_AFTER = {
  en: /^\s*(is|are|was|were)?\s*(not|never)\b/i,
  pt: /^\s*(n[ãa]o|nunca|jamais)\b/i,
  ar: /^\s*(ليس|ليست|لا|لن)\b/
};

function matchIndex(text, pattern, locale) {
  const lang = ['en', 'pt', 'ar'].includes(locale) ? locale : 'en';
  const source = String(text === null || text === undefined ? '' : text);
  const flags = pattern.flags.indexOf('g') === -1 ? pattern.flags + 'g' : pattern.flags;
  const rx = new RegExp(pattern.source, flags);
  // Union of every supported language: the guard must be able to RECOGNISE a
  // disclaimer even when a post mixes languages or the locale is misconfigured.
  // This can only whitelist a phrase, never create a violation.
  const before = new RegExp([NEGATION_BEFORE.en.source, NEGATION_BEFORE.pt.source, NEGATION_BEFORE.ar.source].join('|'), 'i');
  const after = new RegExp([NEGATION_AFTER.en.source, NEGATION_AFTER.pt.source, NEGATION_AFTER.ar.source].join('|'), 'i');
  let m;
  while ((m = rx.exec(source)) !== null) {
    const leading = source.slice(Math.max(0, m.index - 70), m.index);
    const trailing = source.slice(m.index + m[0].length, m.index + m[0].length + 30);
    if (!before.test(leading) && !after.test(trailing)) return m.index;
    if (rx.lastIndex === m.index) rx.lastIndex += 1;
  }
  return -1;
}

/**
 * Check a candidate marketing post.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.locale]  'en' | 'pt' | 'ar'
 * @param {string} [options.kind]    template kind (informational)
 * @param {number} [options.minDeposit]
 * @param {number} [options.referralPercent]
 * @param {number[]} [options.allowedAmounts]
 * @returns {{ok:boolean,blocked:boolean,requiresApproval:boolean,violations:Array,facts:object}}
 */
function checkContent(text, options) {
  const opts = options || {};
  const raw = text === null || text === undefined ? '' : String(text);
  const locale = ['en', 'pt', 'ar'].includes(opts.locale) ? opts.locale : 'en';
  const violations = [];

  if (!raw.trim()) {
    return {
      ok: false,
      blocked: true,
      requiresApproval: false,
      violations: [{ code: 'empty', severity: 'block', detail: 'content is empty' }],
      facts: {}
    };
  }

  // 1. Hard rules -----------------------------------------------------------
  for (const rule of BLOCK_RULES) {
    for (const pattern of rule.patterns) {
      if (matchIndex(raw, pattern, locale) !== -1) {
        violations.push({ code: rule.code, severity: 'block', detail: rule.detail });
        break;
      }
    }
  }

  // 2. Reuse the support denylist (negation-aware, multilingual) -------------
  let supportViolations = [];
  try {
    supportViolations = assertSafeAnswer(raw, { language: locale }) || [];
  } catch (error) {
    supportViolations = ['guard-unavailable'];
  }
  if (supportViolations.length) {
    violations.push({
      code: 'support-policy',
      severity: 'block',
      detail: supportViolations.slice(0, 5).join('; ')
    });
  }

  // 3. Credential requests are a block even when phrased unusually ----------
  let credential = false;
  try { credential = isCredentialRequest(raw); } catch (error) { credential = false; }
  if (credential && !violations.some((v) => v.code === 'credential-request')) {
    violations.push({
      code: 'credential-request',
      severity: 'block',
      detail: 'Marketing content must never request credentials'
    });
  }

  // 4. Private data ---------------------------------------------------------
  const pii = findPrivateData(raw);
  if (pii.length) {
    violations.push({
      code: 'private-data',
      severity: 'block',
      detail: 'Contains private data: ' + pii.join(', ')
    });
  }

  // 5. Unverified content needs a human -------------------------------------
  for (const rule of REVIEW_RULES) {
    for (const pattern of rule.patterns) {
      if (matchIndex(raw, pattern, locale) !== -1) {
        violations.push({ code: rule.code, severity: 'review', detail: rule.detail });
        break;
      }
    }
  }

  // 6. Business-fact consistency -------------------------------------------
  const minDeposit = Number(opts.minDeposit);
  const referralPercent = Number(opts.referralPercent);
  const allowedAmounts = Array.isArray(opts.allowedAmounts)
    ? opts.allowedAmounts.map(Number).filter(Number.isFinite)
    : DEFAULT_ALLOWED_AMOUNTS.slice();
  if (Number.isFinite(minDeposit)) allowedAmounts.push(minDeposit);
  const allowedPercents = Array.isArray(opts.allowedPercents)
    ? opts.allowedPercents.map(Number).filter(Number.isFinite)
    : DEFAULT_ALLOWED_PERCENTS.slice();
  if (Number.isFinite(referralPercent)) allowedPercents.push(referralPercent);

  const unknownAmounts = extractedAmounts(raw).filter((n) => !allowedAmounts.includes(n));
  if (unknownAmounts.length) {
    violations.push({
      code: 'unverified-amount',
      severity: 'review',
      detail: 'Amount(s) not in the approved business facts: ' +
        Array.from(new Set(unknownAmounts)).join(', ')
    });
  }

  const unknownPercents = extractedPercents(raw).filter((n) => !allowedPercents.includes(n));
  if (unknownPercents.length) {
    violations.push({
      code: 'unverified-percent',
      severity: 'review',
      detail: 'Percentage(s) not in the approved business facts: ' +
        Array.from(new Set(unknownPercents)).join(', ')
    });
  }

  const blocked = violations.some((v) => v.severity === 'block');
  const requiresApproval = !blocked && violations.some((v) => v.severity === 'review');

  return {
    ok: !blocked && !requiresApproval,
    blocked,
    requiresApproval,
    violations,
    facts: {
      locale,
      minDeposit: Number.isFinite(minDeposit) ? minDeposit : null,
      referralPercent: Number.isFinite(referralPercent) ? referralPercent : null
    }
  };
}

/** Convenience: throw when the content is blocked (used before queueing). */
function assertNotBlocked(text, options) {
  const result = checkContent(text, options);
  if (result.blocked) {
    const error = new Error('content blocked: ' + result.violations
      .filter((v) => v.severity === 'block')
      .map((v) => v.code)
      .join(', '));
    error.code = 'CONTENT_BLOCKED';
    error.guard = result;
    throw error;
  }
  return result;
}

module.exports = {
  BLOCK_RULES,
  REVIEW_RULES,
  DEFAULT_ALLOWED_AMOUNTS,
  DEFAULT_ALLOWED_PERCENTS,
  checkContent,
  assertNotBlocked,
  matchIndex,
  extractedAmounts,
  extractedPercents,
  findPrivateData
};
