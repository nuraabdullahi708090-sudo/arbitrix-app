'use strict';

/**
 * Provider registry for the support AI layer.
 *
 * Stage 1 ships the offline `knowledge` provider as the default. The `openai`
 * and `anthropic` adapters exist so the provider can be selected later purely
 * through environment variables - but both stay UNAVAILABLE until an API key is
 * supplied (and an injected/real fetch exists), so nothing calls out by default.
 */

const { createKnowledgeProvider } = require('./KnowledgeProvider');
const { createHttpLLMProvider } = require('./HttpLLMProvider');

const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-haiku-20241022';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 8000;

const SUPPORTED_PROVIDERS = Object.freeze(['knowledge', 'openai', 'anthropic', 'deepseek']);

/** Parse an OpenAI-compatible chat-completions response. */
function parseOpenAICompatibleAnswer(body) {
  return body && body.choices && body.choices[0] && body.choices[0].message
    ? body.choices[0].message.content
    : null;
}

/**
 * Normalize an optional base URL override. Returns null for anything that is not
 * a plain http(s) URL, so a malformed value falls back to the provider default
 * instead of producing a broken endpoint.
 */
function normalizeBaseUrl(raw) {
  const value = String(raw === null || raw === undefined ? '' : raw).trim().replace(/\/+$/, '');
  if (!value) return null;
  if (!/^https?:\/\/[^\s]+$/i.test(value)) return null;
  return value;
}

function buildOpenAIProvider({ apiKey, model, timeoutMs, fetchImpl, buildPrompt }) {
  return createHttpLLMProvider({
    name: 'openai',
    apiKey,
    model: model || DEFAULT_OPENAI_MODEL,
    timeoutMs,
    fetchImpl,
    buildPrompt,
    endpoint: 'https://api.openai.com/v1/chat/completions',
    buildRequest: ({ model: m, prompt, instructions }) => ({
      url: 'https://api.openai.com/v1/chat/completions',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify({
          model: m,
          temperature: 0,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: prompt }
          ]
        })
      }
    }),
    parseAnswer: parseOpenAICompatibleAnswer
  });
}

/**
 * DeepSeek provider.
 *
 * DeepSeek exposes an OpenAI-compatible chat-completions API, so it shares the
 * same request parsing and the same safety pipeline as the other HTTP providers:
 * the model only ever receives the retrieved APPROVED knowledge plus the support
 * instructions, and its answer is filtered by SupportGuidelines.assertSafeAnswer
 * before a customer can see it. The approved knowledge base remains the source of
 * truth - the model is explicitly told it must not add amounts, times or policies
 * that are not in it, and a NO_ANSWER reply falls back to the approved text.
 *
 * The base URL is overridable for a proxy/self-hosted gateway; it must be a plain
 * http(s) URL. The API key is never logged or returned.
 */
function buildDeepSeekProvider({ apiKey, model, timeoutMs, fetchImpl, baseUrl, buildPrompt }) {
  const base = normalizeBaseUrl(baseUrl) || DEFAULT_DEEPSEEK_BASE_URL;
  const endpoint = base + '/chat/completions';
  return createHttpLLMProvider({
    name: 'deepseek',
    apiKey,
    model: model || DEFAULT_DEEPSEEK_MODEL,
    timeoutMs,
    fetchImpl,
    buildPrompt,
    endpoint,
    buildRequest: ({ model: m, prompt, instructions }) => ({
      url: endpoint,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify({
          model: m,
          temperature: 0,
          stream: false,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: prompt }
          ]
        })
      }
    }),
    parseAnswer: parseOpenAICompatibleAnswer
  });
}

function buildAnthropicProvider({ apiKey, model, timeoutMs, fetchImpl, buildPrompt }) {
  return createHttpLLMProvider({
    name: 'anthropic',
    apiKey,
    model: model || DEFAULT_ANTHROPIC_MODEL,
    timeoutMs,
    fetchImpl,
    buildPrompt,
    endpoint: 'https://api.anthropic.com/v1/messages',
    buildRequest: ({ model: m, prompt, instructions }) => ({
      url: 'https://api.anthropic.com/v1/messages',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: m,
          max_tokens: 512,
          system: instructions,
          messages: [{ role: 'user', content: prompt }]
        })
      }
    }),
    parseAnswer: (body) => body && Array.isArray(body.content) && body.content[0]
      ? body.content[0].text : null
  });
}

/**
 * Build the configured provider. Unknown names fall back to `knowledge` so a
 * typo can never accidentally enable an external provider.
 */
function createProvider(name, options = {}) {
  const providerName = String(name || 'knowledge').trim().toLowerCase();
  const buildPrompt = options.buildPrompt;
  const opts = {
    apiKey: options.apiKey || null,
    model: options.model || null,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl || null
  };

  switch (providerName) {
    case 'openai':
      return buildOpenAIProvider(opts);
    case 'anthropic':
      return buildAnthropicProvider(opts);
    case 'deepseek':
      return buildDeepSeekProvider(opts);
    case 'knowledge':
    default:
      return createKnowledgeProvider();
  }
}

function listProviders() {
  return SUPPORTED_PROVIDERS.slice();
}

module.exports = {
  SUPPORTED_PROVIDERS,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  createProvider,
  listProviders,
  normalizeBaseUrl,
  parseOpenAICompatibleAnswer,
  buildOpenAIProvider,
  buildAnthropicProvider,
  buildDeepSeekProvider
};
