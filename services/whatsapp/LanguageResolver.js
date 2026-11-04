'use strict';

/**
 * Central language resolver for the Zernio WhatsApp automation.
 *
 * PRIORITY (highest first), as required by the business spec:
 *   1. explicit customer selection        -> source 'explicit'
 *   2. persisted customer preference      -> source 'persisted'
 *   3. reliable detection from the message-> source 'detected'
 *   4. known campaign language            -> source 'campaign'
 *   5. English                            -> source 'default'
 *
 * TWO RULES THAT MATTER MORE THAN THE SCORING:
 *   - A short/ambiguous message never changes the language. `classifyContent()`
 *     recognises affirmations, negations, gratitude, emoji, punctuation and
 *     bare numbers and stops detection before it runs.
 *   - A persisted preference is never overwritten by an unreliable detection:
 *     the resolver returns 'persisted' before detection is even attempted, and
 *     the automation only writes a DETECTED value when the confidence clears
 *     the threshold AND no preference exists.
 *
 * Spanish is scored so that a Spanish message is recognised as Spanish and the
 * customer is asked which language they prefer, instead of silently receiving
 * Portuguese (the two languages share enough vocabulary to fool a binary
 * Portuguese-vs-English scorer). `es` is not yet active.
 */

const {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  normalizeLanguage,
  isActiveLanguage
} = require('./Languages');

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const MIN_EVIDENCE = 1.4;

// Only used when the WHOLE message is one alphabetic token. Bare affirmations
// and negations are excluded by classifyContent() before this is consulted.
const STRONG_SINGLE_TOKEN = Object.freeze({
  oi: 'pt-BR',
  'olá': 'pt-BR',
  ola: 'pt-BR',
  obrigado: 'pt-BR',
  obrigada: 'pt-BR',
  'você': 'pt-BR',
  voce: 'pt-BR',
  'vocês': 'pt-BR',
  voces: 'pt-BR',
  'depósito': 'pt-BR',
  deposito: 'pt-BR',
  saque: 'pt-BR',
  pix: 'pt-BR',
  cadastro: 'pt-BR',
  'endereço': 'pt-BR',
  endereco: 'pt-BR',
  'comissão': 'pt-BR',
  comissao: 'pt-BR'
});

const COURTESY = new Set([
  'yes', 'y', 'yeah', 'yep', 'yup', 'no', 'nope', 'nah', 'ok', 'okey', 'okay',
  'sure', 'alright', 'right', 'fine', 'good', 'great', 'nice', 'perfect',
  'cool', 'awesome', 'thanks', 'thank', 'thx', 'ty', 'cheers',
  'sim', 'nao', 'não', 'beleza', 'certo', 'ta', 'tá', 'valeu', 'blz',
  'perfeito', 'legal', 'otimo', 'ótimo', 'maravilha', 'obg'
]);

const GREETING = new Set([
  'hi', 'hello', 'hey', 'oi', 'ola', 'olá', 'bom', 'boa', 'hola'
]);

const PT_WORDS = new Set([
  'não', 'nao', 'você', 'voce', 'vocês', 'voces', 'obrigado', 'obrigada',
  'olá', 'ola', 'oi', 'quero', 'preciso', 'depósito', 'deposito', 'saque',
  'saques', 'dinheiro', 'ajuda', 'bom', 'boa', 'tarde', 'noite', 'tudo',
  'bem', 'como', 'quanto', 'onde', 'qual', 'quais', 'favor', 'sim', 'eu',
  'meu', 'minha', 'meus', 'minhas', 'estou', 'tenho', 'pra', 'isso', 'isto',
  'aqui', 'mais', 'muito', 'também', 'tambem', 'mas', 'já', 'ja', 'pix',
  'cartão', 'cartao', 'investimento', 'investir', 'ganhar', 'ganho', 'taxa',
  'mínimo', 'minimo', 'transferência', 'transferencia', 'endereço',
  'endereco', 'cadastro', 'cadastrar', 'plataforma', 'comissão', 'comissao',
  'risco', 'lucro', 'negociação', 'negociacao', 'abrir', 'fechar', 'enviar',
  'receber', 'chegou', 'caiu', 'funciona', 'trabalha', 'conta', 'corretora',
  'fundos', 'simular', 'simulado', 'simulados', 'conseguir', 'consigo',
  'falar', 'obrigada', 'queria', 'gostaria', 'tem', 'ter', 'foi', 'sou',
  'está', 'esta', 'são', 'sao', 'nunca', 'sempre', 'depois', 'antes'
]);

const EN_WORDS = new Set([
  'the', 'and', 'you', 'your', 'yours', 'how', 'what', 'when', 'where', 'why',
  'which', 'who', 'can', 'could', 'should', 'would', 'will', 'my', 'me',
  'is', 'are', 'was', 'were', 'do', 'does', 'did', 'of', 'in', 'on', 'at',
  'to', 'for', 'with', 'about', 'from', 'please', 'help', 'needed', 'need',
  'want', 'have', 'has', 'had', 'start', 'started', 'open', 'close', 'send',
  'sent', 'receive', 'received', 'arrived', 'works', 'working', 'account',
  'money', 'bank', 'card', 'fee', 'fees', 'minimum', 'risk', 'profit',
  'profits', 'guarantee', 'guaranteed', 'lose', 'loss', 'losses', 'referral',
  'commission', 'withdraw', 'withdrawal', 'problem', 'issue', 'support',
  'explain', 'explanation', 'information', 'question', 'thanks', 'hello',
  'there', 'this', 'that', 'these', 'those', 'it', 'its', 'if', 'or', 'not',
  'am', 'be', 'been', 'being', 'get', 'got', 'make', 'made', 'know', 'tell',
  'show', 'time', 'today', 'now', 'later', 'first', 'next'
]);

const PT_PHRASES = Object.freeze([
  'bom dia', 'boa tarde', 'boa noite', 'tudo bem', 'como faço', 'como faco',
  'como funciona', 'quanto custa', 'não sei', 'nao sei', 'eu quero',
  'eu preciso', 'por favor', 'muito obrigado', 'muito obrigada',
  'preciso de ajuda', 'quero saber', 'você pode', 'voce pode', 'o que é',
  'o que e', 'tem como', 'estou tentando', 'não consigo', 'nao consigo',
  'meu depósito', 'meu deposito', 'meu saque', 'falar português',
  'falar portugues', 'em português', 'em portugues', 'de ajuda'
]);

const EN_PHRASES = Object.freeze([
  'how do i', 'how much', 'how can i', 'how does', 'thank you', 'i want',
  'i need', 'what is', 'what are', 'where is', 'can you', 'could you',
  'good morning', 'good afternoon', 'good evening', 'does it', 'is it',
  'do i', 'my account', 'sign up', 'log in', 'minimum deposit',
  'trading involves risk', 'i have a problem', 'help me', 'i would like'
]);

const ES_WORDS = new Set([
  'hola', 'gracias', 'quiero', 'necesito', 'cuenta', 'dinero', 'ayuda',
  'cómo', 'como', 'cuánto', 'cuanto', 'dónde', 'donde', 'porque', 'también',
  'tambien', 'muy', 'pero', 'para', 'con', 'una', 'unos', 'unas', 'los',
  'las', 'del', 'que', 'es', 'está', 'esta', 'puedo', 'tengo', 'hacer',
  'retiro', 'retirar', 'depositar', 'depósito', 'deposito', 'mínimo',
  'minimo', 'comisión', 'comision', 'riesgo', 'ganancia', 'pérdida',
  'perdida', 'negociación', 'negociacion', 'plataforma', 'cuenta'
]);

const ES_PHRASES = Object.freeze([
  'cómo funciona', 'como funciona', 'cuánto cuesta', 'cuanto cuesta',
  'necesito ayuda', 'quiero saber', 'por favor', 'muchas gracias',
  'mi cuenta', 'depósito mínimo', 'deposito minimo', 'hola buenas'
]);

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return normalizeText(text)
    .replace(/[^a-zà-ÿ0-9'\s]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function stripEmojiAndSymbols(text) {
  return String(text || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when the message carries no language evidence at all: empty, media
 * caption absent, emoji only, punctuation only, digits only, or one to three
 * courtesy words ("yes", "no", "ok", "obrigado", "thanks").
 */
function classifyContent(text) {
  const stripped = stripEmojiAndSymbols(text);
  if (!stripped) return { contentFree: true, reason: 'empty-or-symbols' };

  const letters = stripped.replace(/[^a-zà-ÿ]/gi, '');
  if (!letters) return { contentFree: true, reason: 'no-letters' };

  const tokens = stripped.split(/\s+/).filter(Boolean);
  if (tokens.length <= 3) {
    const allCourtesy = tokens.every((token) => {
      const clean = token.replace(/[^a-zà-ÿ']/gi, '');
      return !clean || COURTESY.has(clean);
    });
    if (allCourtesy) return { contentFree: true, reason: 'courtesy-only' };
  }

  // A one-word greeting is evidence ("olá" is Portuguese) but a bare "hi" is
  // not enough to overrule a stored preference; detection decides.
  if (tokens.length === 1 && GREETING.has(tokens[0])) {
    return { contentFree: false, reason: 'greeting' };
  }

  return { contentFree: false, reason: null };
}

function countPhrases(text, phrases) {
  let score = 0;
  for (const phrase of phrases) {
    if (text.indexOf(phrase) !== -1) score += 2.2;
  }
  return score;
}

function countWords(tokens, words) {
  let score = 0;
  for (const token of tokens) {
    if (words.has(token)) score += 1;
  }
  return score;
}

function scorePortuguese(text, tokens) {
  let score = countWords(tokens, PT_WORDS) + countPhrases(text, PT_PHRASES);
  const diacritics = (text.match(/[ãõçáéíóúâêôà]/g) || []).length;
  score += Math.min(diacritics, 4) * 0.8;
  if (/\b[a-zà-ÿ]+(?:ção|ções|mente)\b/.test(text)) score += 0.8;
  return score;
}

function scoreEnglish(text, tokens) {
  return countWords(tokens, EN_WORDS) + countPhrases(text, EN_PHRASES);
}

function scoreSpanish(text, tokens) {
  let score = countWords(tokens, ES_WORDS) + countPhrases(text, ES_PHRASES);
  const diacritics = (text.match(/[ñ¿¡]/g) || []).length;
  score += Math.min(diacritics, 4) * 0.9;
  return score;
}

function clampThreshold(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CONFIDENCE_THRESHOLD;
  return Math.min(1, Math.max(0, number));
}

/**
 * Language detection with an explicit confidence and an explicit "ambiguous"
 * outcome. Never returns a language when the evidence is weak.
 */
function detectLanguage(text, options) {
  const opts = options || {};
  const threshold = clampThreshold(opts.confidenceThreshold);
  const raw = String(text === undefined || text === null ? '' : text).trim();

  const content = classifyContent(raw);
  if (content.contentFree) {
    return {
      language: null,
      confidence: 0,
      ambiguous: true,
      unsupported: false,
      reason: content.reason,
      scores: { pt: 0, en: 0, es: 0 }
    };
  }

  const normalized = normalizeText(raw);
  const tokens = tokenize(raw);
  const scores = {
    pt: scorePortuguese(normalized, tokens),
    en: scoreEnglish(normalized, tokens),
    es: scoreSpanish(normalized, tokens)
  };

  // A single, unambiguous Portuguese token is enough evidence. English is the
  // fallback, so the reverse is not needed and would over-trigger.
  if (tokens.length === 1 && STRONG_SINGLE_TOKEN[tokens[0]]) {
    return {
      language: STRONG_SINGLE_TOKEN[tokens[0]],
      confidence: 0.9,
      ambiguous: false,
      unsupported: false,
      reason: 'strong-token',
      scores
    };
  }

  const ranked = Object.keys(scores)
    .map((code) => ({ code, score: scores[code] }))
    .sort((a, b) => b.score - a.score);
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const total = scores.pt + scores.en + scores.es;

  if (!winner || winner.score < MIN_EVIDENCE || total <= 0) {
    return {
      language: null,
      confidence: 0,
      ambiguous: true,
      unsupported: false,
      reason: 'insufficient-signal',
      scores
    };
  }

  const confidence = winner.score / total;
  const margin = (winner.score - (runnerUp ? runnerUp.score : 0)) / total;

  if (confidence < threshold || margin < 0.2) {
    return {
      language: null,
      confidence: Number(confidence.toFixed(3)),
      ambiguous: true,
      unsupported: false,
      reason: 'low-confidence',
      scores
    };
  }

  const canonical = winner.code === 'es' ? 'es' : winner.code === 'pt' ? 'pt-BR' : 'en';
  const supported = isActiveLanguage(canonical);

  return {
    language: canonical,
    confidence: Number(confidence.toFixed(3)),
    ambiguous: !supported,
    unsupported: !supported,
    reason: supported ? 'detected' : 'unsupported-language',
    scores
  };
}

const LANGUAGE_MENU_PATTERN = /^(?:\/?(?:language|idioma|lang|l[ií]ngua|lengua)|change language|mudar (?:o )?idioma|trocar (?:o )?idioma|alterar (?:o )?idioma)$/i;

function isLanguageMenuRequest(text) {
  return LANGUAGE_MENU_PATTERN.test(normalizeText(text).replace(/[.!?]+$/, '').trim());
}

const SELECTION_VERB = /\b(?:speak|talk|continue|reply|respond|write|prefer|want|falar|continuar|responder|prefiro|prefere|quero|gostaria)\b/i;

/**
 * Recognises an explicit language choice. A bare language name counts, as does
 * a clear "I want to speak X" sentence. A sentence that merely MENTIONS a
 * language ("my friend speaks English") does not, so a customer cannot be
 * switched by accident.
 */
function matchExplicitLanguage(text) {
  const normalized = normalizeText(text).replace(/[.!?]+$/g, '').trim();
  if (!normalized) return null;

  const direct = normalizeLanguage(normalized);
  if (direct) return direct;

  // "português (Brasil)" / "pt-br" / "english please"
  const withoutPoliteness = normalized
    .replace(/\b(?:please|por favor)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const politeDirect = normalizeLanguage(withoutPoliteness);
  if (politeDirect) return politeDirect;

  if (!SELECTION_VERB.test(normalized)) return null;

  const candidates = [
    ['pt-BR', /\b(?:portugu[eê]s|portuguese|pt-br|pt_br|brasil|brazilian)\b/i],
    ['en', /\b(?:english|ingl[eê]s|en-us|en-gb)\b/i],
    ['es', /\b(?:spanish|espa[nñ]ol|espanhol|espanhola|castellano|es-es|es-mx)\b/i]
  ];
  for (const [code, pattern] of candidates) {
    if (pattern.test(normalized)) return code;
  }
  return null;
}

/**
 * Full resolution. See the priority list at the top of the file.
 *
 * @returns {{
 *   language: string, source: string, confidence: number,
 *   confident: boolean, ambiguous: boolean, unsupported: boolean,
 *   shouldAsk: boolean, reason: string, detection: object
 * }}
 */
function resolveLanguage(input) {
  const options = input || {};
  const threshold = clampThreshold(options.confidenceThreshold);

  const explicitRaw = normalizeLanguage(options.explicitLanguage);
  if (explicitRaw && isActiveLanguage(explicitRaw)) {
    return {
      language: explicitRaw,
      source: 'explicit',
      confidence: 1,
      confident: true,
      ambiguous: false,
      unsupported: false,
      shouldAsk: false,
      reason: 'explicit-selection',
      detection: null
    };
  }
  if (explicitRaw && LANGUAGES[explicitRaw] && !LANGUAGES[explicitRaw].active) {
    return {
      language: DEFAULT_LANGUAGE,
      source: 'default',
      confidence: 0,
      confident: false,
      ambiguous: true,
      unsupported: true,
      shouldAsk: true,
      reason: 'explicit-unsupported',
      detection: null
    };
  }

  const persistedRaw = normalizeLanguage(options.persistedLanguage);
  if (persistedRaw && isActiveLanguage(persistedRaw)) {
    return {
      language: persistedRaw,
      source: 'persisted',
      confidence: 1,
      confident: true,
      ambiguous: false,
      unsupported: false,
      shouldAsk: false,
      reason: 'persisted-preference',
      detection: null
    };
  }

  const detection = options.detect === false
    ? { language: null, confidence: 0, ambiguous: true, unsupported: false, reason: 'detection-disabled', scores: {} }
    : detectLanguage(options.text, { confidenceThreshold: threshold });

  if (!detection.ambiguous && detection.language && isActiveLanguage(detection.language)) {
    return {
      language: detection.language,
      source: 'detected',
      confidence: detection.confidence,
      confident: true,
      ambiguous: false,
      unsupported: false,
      shouldAsk: false,
      reason: 'detected',
      detection
    };
  }

  const campaignRaw = normalizeLanguage(options.campaignLanguage);
  if (campaignRaw && isActiveLanguage(campaignRaw)) {
    return {
      language: campaignRaw,
      source: 'campaign',
      confidence: 0,
      confident: false,
      ambiguous: detection.ambiguous,
      unsupported: detection.unsupported,
      shouldAsk: true,
      reason: 'campaign-language',
      detection
    };
  }

  return {
    language: DEFAULT_LANGUAGE,
    source: 'default',
    confidence: 0,
    confident: false,
    ambiguous: true,
    unsupported: Boolean(detection.unsupported),
    shouldAsk: true,
    reason: detection.reason || 'default',
    detection
  };
}

module.exports = {
  DEFAULT_CONFIDENCE_THRESHOLD,
  MIN_EVIDENCE,
  classifyContent,
  detectLanguage,
  resolveLanguage,
  isLanguageMenuRequest,
  matchExplicitLanguage,
  normalizeText,
  tokenize
};
