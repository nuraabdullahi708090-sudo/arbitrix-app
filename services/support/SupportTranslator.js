'use strict';

/**
 * SupportTranslator - the translation layer for multilingual Telegram support.
 *
 * WHAT IT IS FOR
 *   1. customer message -> English, so an ENGLISH-speaking operator can read a
 *      Portuguese/Arabic message in the admin notification;
 *   2. English operator reply -> the customer's language, so the same operator
 *      can answer a Portuguese/Arabic customer without translating by hand.
 *
 * SEPARATE FROM THE ANSWERING LAYER
 * Translation is its OWN gate (`SUPPORT_TRANSLATION_ENABLED`). It deliberately
 * does not depend on `AI_SUPPORT_ENABLED`, because the operator workflow must
 * keep working when automated AI answering is switched off.
 *
 * IT NEVER INVENTS
 *   - The prompt forbids adding, removing, softening or strengthening anything,
 *     and requires numbers/amounts/dates/tickers/commands to be copied exactly.
 *   - NO_ANSWER from the model is treated as "translation unavailable", never as
 *     content to pass on.
 *   - A translation that merely echoes the input is rejected (the model refused
 *     or answered in the source language), again as "unavailable".
 *   - Customer-facing output is validated by SupportGuidelines before it is
 *     returned, with the target language's supplementary denylist. A rejection
 *     is reported as `unsafe:<violations>` so the caller can fall back instead of
 *     silently sending unvalidated text.
 *
 * SAFETY LIMITATION (see the delivery report)
 *   The multilingual denylist is a SUPPLEMENT to the English checks, not a
 *   parity replacement, and it fails CLOSED. It is not a substitute for a
 *   human/translation review before enabling external providers for pt/ar.
 *
 * NEVER THROWS: every failure is an `{ ok: false, reason }` result, so a
 * translation failure can never break the customer's reply or an operator's
 * message. The API key is never logged or returned.
 */

const SupportGuidelines = require('./SupportGuidelines');
const { createProvider, DEFAULT_TIMEOUT_MS } = require('./providers');

const TRANSLATION_ENABLED_ENV = 'SUPPORT_TRANSLATION_ENABLED';
const DEFAULT_MAX_TRANSLATION_CHARS = 1500;

/** Languages this layer will translate between (English is the pivot). */
const TRANSLATABLE_LANGUAGES = Object.freeze(['en', 'pt', 'ar']);

function baseLanguage(language) {
  return SupportGuidelines.baseLanguage(language);
}

function isTranslatable(language) {
  return TRANSLATABLE_LANGUAGES.indexOf(baseLanguage(language)) !== -1;
}

/**
 * Read translation configuration from an env-shaped object.
 *
 * Default ENABLED, but that alone does nothing: an HTTP provider also needs an
 * API key, so with no credential configured the layer reports itself
 * unavailable and every caller falls back safely. Setting
 * SUPPORT_TRANSLATION_ENABLED=false disables it explicitly even when a key
 * exists (the data-flow switch: see the privacy note in the delivery report).
 */
function resolveTranslationConfig(env) {
  const e = env || {};
  const provider = String(e.AI_SUPPORT_PROVIDER || 'knowledge').trim().toLowerCase() || 'knowledge';
  const providerKeyEnv = provider === 'openai' ? 'OPENAI_API_KEY'
    : provider === 'anthropic' ? 'ANTHROPIC_API_KEY'
    : provider === 'deepseek' ? 'DEEPSEEK_API_KEY'
    : null;
  const apiKey = String(
    e.AI_SUPPORT_API_KEY || (providerKeyEnv ? e[providerKeyEnv] : '') || ''
  ).trim() || null;
  const maxCharsRaw = Number(e.SUPPORT_TRANSLATION_MAX_CHARS);
  const timeoutRaw = Number(e.AI_SUPPORT_TIMEOUT_MS);

  return {
    enabled: String(e[TRANSLATION_ENABLED_ENV] || 'true').trim().toLowerCase() === 'true',
    provider,
    model: String(e.AI_SUPPORT_MODEL || '').trim() || null,
    apiKey,
    baseUrl: String(e.AI_SUPPORT_BASE_URL || '').trim() || null,
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS,
    maxChars: Number.isFinite(maxCharsRaw) && maxCharsRaw > 0 ? maxCharsRaw : DEFAULT_MAX_TRANSLATION_CHARS
  };
}

/** Secret-free description (never the key value, never the endpoint). */
function describeTranslationConfig(config) {
  const cfg = config || {};
  return {
    enabled: cfg.enabled === true,
    provider: cfg.provider || 'knowledge',
    model: cfg.model || null,
    hasApiKey: Boolean(cfg.apiKey),
    maxChars: cfg.maxChars,
    languages: TRANSLATABLE_LANGUAGES.slice()
  };
}

function createSupportTranslator(options = {}) {
  const config = options.config || resolveTranslationConfig(options.env || process.env || {});
  const logger = options.logger || null;
  const warn = (message) => {
    if (!logger) return;
    const text = '[SupportTranslator] ' + String(message);
    if (typeof logger.warn === 'function') logger.warn(text);
    else if (typeof logger.log === 'function') logger.log(text);
  };

  // One transport per direction, built lazily. `buildPrompt` is what makes this
  // reuse the existing provider machinery (auth, timeout, abort, error scrubbing)
  // without inheriting the "answer from the approved knowledge" prompt.
  const byDirection = new Map();
  const providerFactory = typeof options.providerFactory === 'function'
    ? options.providerFactory
    : (from, to) => createProvider(config.provider, {
      apiKey: config.apiKey,
      model: config.model,
      timeoutMs: config.timeoutMs,
      baseUrl: config.baseUrl,
      fetchImpl: options.fetchImpl,
      buildPrompt: (text) => SupportGuidelines.buildTranslationPrompt(from, to, text)
    });

  function providerFor(from, to) {
    const key = from + '->' + to;
    if (!byDirection.has(key)) byDirection.set(key, providerFactory(from, to));
    return byDirection.get(key);
  }

  /**
   * True only when a translation can actually be attempted: an HTTP-capable
   * provider WITH a credential. The offline `knowledge` provider can never
   * translate, so it is explicitly excluded.
   */
  function isAvailable() {
    if (config.enabled !== true) return false;
    try {
      const provider = providerFor('en', 'pt');
      return Boolean(provider && provider.kind === 'http' && provider.available === true);
    } catch (error) {
      warn('provider could not be constructed: ' + (error && error.message ? error.message : error));
      return false;
    }
  }

  /**
   * Translate `text` from one supported language to another.
   *
   * @returns {Promise<{ok:boolean, text:string, reason:string|null,
   *                    violations?:string[]}>} never throws.
   */
  async function translate(text, from, to, { validate = false } = {}) {
    const source = String(text === null || text === undefined ? '' : text).trim();
    const fromCode = baseLanguage(from);
    const toCode = baseLanguage(to);

    if (!source) return { ok: false, text: '', reason: 'empty' };
    if (fromCode === toCode) return { ok: true, text: source, reason: 'same-language' };
    if (!isTranslatable(fromCode) || !isTranslatable(toCode)) {
      return { ok: false, text: '', reason: 'unsupported-language' };
    }
    // English is the pivot: both supported directions involve it.
    if (fromCode !== 'en' && toCode !== 'en') {
      return { ok: false, text: '', reason: 'unsupported-direction' };
    }
    if (!isAvailable()) return { ok: false, text: '', reason: 'unavailable' };
    // A message that is too long is NOT truncated: a partial translation of a
    // support message is worse than none, so the caller shows the original.
    if (source.length > config.maxChars) return { ok: false, text: '', reason: 'too-long' };

    let output = null;
    try {
      const generated = await providerFor(fromCode, toCode).generate({
        question: source,
        hits: [],
        instructions: SupportGuidelines.TRANSLATION_INSTRUCTIONS
      });
      output = generated && typeof generated.text === 'string' ? generated.text.trim() : null;
    } catch (error) {
      // Never surfaced to a customer; the message itself is not logged.
      warn('translation failed: ' + (error && error.message ? error.message : error));
      return { ok: false, text: '', reason: 'provider-error' };
    }

    if (!output) return { ok: false, text: '', reason: 'no-answer' };
    if (output === source) return { ok: false, text: '', reason: 'echo' };
    if (output.length > config.maxChars * 2) return { ok: false, text: '', reason: 'too-long-output' };

    if (validate) {
      const violations = SupportGuidelines.assertSafeAnswer(output, { language: toCode });
      if (violations.length > 0) {
        warn('translated text withheld by the safety check: ' + violations.join(', '));
        return { ok: false, text: '', reason: 'unsafe', violations };
      }
      if (!SupportGuidelines.hasExpectedScript(output, toCode)) {
        warn('translated text withheld: it is not in the requested language (' + toCode + ')');
        return { ok: false, text: '', reason: 'wrong-language' };
      }
    }

    return { ok: true, text: output, reason: null };
  }

  /** customer language -> English (for the ENGLISH operator notification). */
  function toEnglish(text, sourceLanguage) {
    return translate(text, sourceLanguage, 'en');
  }

  /**
   * English -> the customer's language.
   *
   * `validate` defaults to TRUE because this direction always produces
   * CUSTOMER-FACING text (an operator reply, or approved knowledge restated for
   * the customer), so the language-aware safety check is applied here rather
   * than left to each caller.
   */
  function fromEnglish(text, targetLanguage, options2 = {}) {
    return translate(text, 'en', targetLanguage, { validate: options2.validate !== false });
  }

  return {
    toEnglish,
    fromEnglish,
    translate,
    isAvailable,
    describe: () => describeTranslationConfig(config),
    config,
    languages: () => TRANSLATABLE_LANGUAGES.slice()
  };
}

module.exports = {
  TRANSLATION_ENABLED_ENV,
  DEFAULT_MAX_TRANSLATION_CHARS,
  TRANSLATABLE_LANGUAGES,
  resolveTranslationConfig,
  describeTranslationConfig,
  createSupportTranslator,
  isTranslatable,
  baseLanguage
};
