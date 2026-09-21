'use strict';

/**
 * Generic HTTP LLM provider factory.
 *
 * No provider is enabled until an API key is supplied through the environment,
 * so Stage 1 ships with zero external calls. This module never logs or returns
 * the API key, and scrubs it out of any error message it surfaces.
 *
 * The provider receives ONLY the retrieved approved knowledge plus the support
 * instructions - it is never given account data, and its answer is filtered by
 * SupportGuidelines.assertSafeAnswer before it can reach a customer.
 */

const NO_ANSWER_SENTINEL = 'NO_ANSWER';

class ProviderUnavailableError extends Error {
  constructor(name) {
    super('support AI provider "' + name + '" is not available (missing API key or fetch)');
    this.name = 'ProviderUnavailableError';
    this.provider = name;
  }
}

class ProviderRequestError extends Error {
  constructor(name, message) {
    super('support AI provider "' + name + '" request failed: ' + message);
    this.name = 'ProviderRequestError';
    this.provider = name;
  }
}

/** Build the user prompt from the retrieved approved entries. */
function buildKnowledgePrompt(question, hits) {
  const lines = ['Approved knowledge:'];
  (Array.isArray(hits) ? hits : []).forEach((hit) => {
    lines.push('- Q: ' + hit.question);
    lines.push('  A: ' + hit.answer);
  });
  lines.push('');
  lines.push('Customer question: ' + String(question || ''));
  lines.push('');
  lines.push('Answer in 2-4 short, beginner-friendly sentences using ONLY the approved knowledge above.');
  lines.push('Do not add amounts, times, or policies that are not in the approved knowledge.');
  lines.push('If the approved knowledge does not answer the question, reply with exactly ' + NO_ANSWER_SENTINEL + '.');
  return lines.join('\n');
}

function createHttpLLMProvider(options = {}) {
  const name = options.name || 'http';
  const apiKey = options.apiKey || null;
  const model = options.model || null;
  const endpoint = options.endpoint || null;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
  const buildRequest = options.buildRequest;
  const parseAnswer = options.parseAnswer;
  const fetchImpl = options.fetchImpl === undefined
    ? (typeof fetch === 'function' ? fetch : null)
    : options.fetchImpl;

  const scrub = (message) => String(message === null || message === undefined ? '' : message)
    .split(String(apiKey || '\u0000')).join('***');

  const available = Boolean(apiKey && endpoint && typeof buildRequest === 'function'
    && typeof parseAnswer === 'function' && typeof fetchImpl === 'function');

  async function generate({ question, hits, instructions } = {}) {
    if (!available) throw new ProviderUnavailableError(name);

    const prompt = buildKnowledgePrompt(question, hits);
    const request = buildRequest({ model, prompt, instructions: instructions || '' });

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(request.url, Object.assign({}, request.init, controller ? { signal: controller.signal } : {}));
    } catch (error) {
      if (timer) clearTimeout(timer);
      throw new ProviderRequestError(name, scrub(error && error.message ? error.message : error));
    }
    if (timer) clearTimeout(timer);

    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      body = null;
    }

    if (!response.ok) {
      const detail = body && (body.error && (body.error.message || body.error) || body.message);
      throw new ProviderRequestError(name, scrub(detail || ('HTTP ' + response.status)));
    }

    let text = null;
    try {
      text = parseAnswer(body);
    } catch (error) {
      throw new ProviderRequestError(name, scrub(error && error.message ? error.message : error));
    }

    if (typeof text !== 'string' || text.trim().length === 0) {
      return { text: null, noAnswer: true, provider: name, model };
    }
    const trimmed = text.trim();
    if (trimmed === NO_ANSWER_SENTINEL || trimmed.toUpperCase() === NO_ANSWER_SENTINEL) {
      return { text: null, noAnswer: true, provider: name, model };
    }
    return { text: trimmed, noAnswer: false, provider: name, model };
  }

  return { name, kind: 'http', requiresApiKey: true, available, generate, model };
}

module.exports = {
  NO_ANSWER_SENTINEL,
  ProviderUnavailableError,
  ProviderRequestError,
  buildKnowledgePrompt,
  createHttpLLMProvider
};
