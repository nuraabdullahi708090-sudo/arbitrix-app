'use strict';

/**
 * Minimal Zernio REST client for the WhatsApp automation.
 *
 * VERIFIED AGAINST THE OFFICIAL DOCS (docs.zernio.com), not assumed:
 *   POST /v1/inbox/conversations                     business-initiated template
 *   POST /v1/inbox/conversations/{id}/messages       free-form text in the 24h window
 *   GET  /v1/contacts/{contactId}                    contact.customFields + channels
 *   PATCH /v1/contacts/{contactId}                   isSubscribed (opt-out)
 *   GET  /v1/custom-fields                           field definitions
 *   POST /v1/custom-fields                           create a definition
 *   PUT  /v1/contacts/{contactId}/fields/{slug}      set a contact field value
 *   GET  /v1/whatsapp/templates                      Meta verdict per name+language
 *   POST /v1/whatsapp/templates                      submit a template to Meta
 *   GET  /v1/sequences                               drip campaigns
 *   POST /v1/sequences                               create (steps, exitOnReply, exitOnUnsubscribe)
 *   POST /v1/sequences/{id}/activate                 activate
 *   POST /v1/sequences/{id}/enroll                   { contactIds }
 *   DELETE /v1/sequences/{id}/enroll/{contactId}     unenroll (stops all further steps)
 *   GET/POST /v1/webhooks/settings                   delivery endpoints
 *
 * SAFETY: the API key never appears in an error message or a log line, request
 * bodies are not logged, and a 4xx is surfaced as a typed error rather than
 * retried (a retried send can duplicate a message).
 */

const DEFAULT_BASE_URL = 'https://zernio.com/api';
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_RETRIES = 2;

class ZernioError extends Error {
  constructor(message, options) {
    super(message);
    this.name = 'ZernioError';
    const opts = options || {};
    this.status = opts.status || 0;
    this.code = opts.code || 'zernio_error';
    this.type = opts.type || null;
    this.param = opts.param || null;
    this.details = opts.details || null;
    this.retryable = Boolean(opts.retryable);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scrub(value, secret) {
  if (!value) return value;
  const text = String(value);
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

function buildQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

function resolveConfig(overrides) {
  const input = overrides || {};
  const env = process.env;
  return {
    apiKey: input.apiKey !== undefined ? input.apiKey : env.ZERNIO_API_KEY || '',
    baseUrl: (input.baseUrl || env.ZERNIO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    profileId: input.profileId !== undefined ? input.profileId : env.ZERNIO_PROFILE_ID || '',
    accountId: input.accountId !== undefined ? input.accountId : env.ZERNIO_WHATSAPP_ACCOUNT_ID || '',
    timeoutMs: Number(input.timeoutMs || env.ZERNIO_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    maxRetries: Number(input.maxRetries === undefined ? DEFAULT_MAX_RETRIES : input.maxRetries),
    fetchImpl: input.fetchImpl || (typeof fetch === 'function' ? fetch : null),
    logger: input.logger || console
  };
}

function createZernioClient(overrides) {
  const config = resolveConfig(overrides);

  if (!config.apiKey) {
    const error = new Error('ZERNIO_API_KEY is not configured');
    error.code = 'ZERNIO_NOT_CONFIGURED';
    throw error;
  }
  if (!config.fetchImpl) {
    const error = new Error('No fetch implementation available');
    error.code = 'ZERNIO_NO_FETCH';
    throw error;
  }

  async function request(method, path, options) {
    const opts = options || {};
    const url = `${config.baseUrl}${path}${buildQuery(opts.query)}`;
    const headers = {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: 'application/json'
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = String(opts.idempotencyKey);

    const retryableMethod = method === 'GET' || Boolean(opts.idempotencyKey);
    const maxRetries = retryableMethod ? Math.max(0, opts.maxRetries === undefined ? config.maxRetries : opts.maxRetries) : 0;

    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
      try {
        const response = await config.fetchImpl(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller ? controller.signal : undefined
        });
        if (timer) clearTimeout(timer);

        const text = await response.text();
        let payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch (parseError) {
            payload = null;
          }
        }

        if (response.ok) return payload;

        const retryAfterSeconds = Number(response.headers && response.headers.get
          ? response.headers.get('retry-after')
          : 0);
        const retryable = response.status === 429 || response.status >= 500;
        const error = new ZernioError(
          scrub(
            (payload && (payload.error || payload.message)) || `Zernio request failed (${response.status})`,
            config.apiKey
          ),
          {
            status: response.status,
            code: (payload && payload.code) || `http_${response.status}`,
            type: payload && payload.type,
            param: payload && payload.param,
            details: payload && payload.details,
            retryable
          }
        );

        if (retryable && attempt < maxRetries) {
          lastError = error;
          const waitMs = retryAfterSeconds > 0
            ? Math.min(retryAfterSeconds * 1000, 30000)
            : Math.min(500 * Math.pow(2, attempt), 8000);
          await sleep(waitMs);
          continue;
        }
        throw error;
      } catch (error) {
        if (timer) clearTimeout(timer);
        if (error instanceof ZernioError) throw error;
        lastError = new ZernioError(
          scrub(error && error.message ? error.message : 'Network error contacting Zernio', config.apiKey),
          { status: 0, code: 'network_error', retryable: true }
        );
        if (attempt < maxRetries) {
          await sleep(Math.min(500 * Math.pow(2, attempt), 8000));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError || new ZernioError('Zernio request failed', { code: 'unknown' });
  }

  return {
    config,
    request,

    listAccounts(query) {
      return request('GET', '/v1/accounts', { query });
    },

    getContact(contactId) {
      return request('GET', `/v1/contacts/${encodeURIComponent(contactId)}`);
    },

    updateContact(contactId, patch) {
      return request('PATCH', `/v1/contacts/${encodeURIComponent(contactId)}`, { body: patch });
    },

    listCustomFields(profileId) {
      return request('GET', '/v1/custom-fields', { query: { profileId } });
    },

    createCustomField(field) {
      return request('POST', '/v1/custom-fields', { body: field });
    },

    setContactField(contactId, slug, value) {
      return request(
        'PUT',
        `/v1/contacts/${encodeURIComponent(contactId)}/fields/${encodeURIComponent(slug)}`,
        { body: { value } }
      );
    },

    listTemplates(query) {
      return request('GET', '/v1/whatsapp/templates', { query });
    },

    createTemplate(payload) {
      return request('POST', '/v1/whatsapp/templates', { body: payload });
    },

    sendTemplate({ accountId, participantId, templateName, templateLanguage, templateParams, idempotencyKey }) {
      const body = {
        accountId,
        participantId,
        templateName,
        templateLanguage
      };
      if (Array.isArray(templateParams) && templateParams.length) {
        body.templateParams = templateParams;
      }
      return request('POST', '/v1/inbox/conversations', { body, idempotencyKey });
    },

    sendText({ accountId, conversationId, message, idempotencyKey }) {
      return request('POST', `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
        body: { accountId, message },
        idempotencyKey
      });
    },

    listSequences(query) {
      return request('GET', '/v1/sequences', { query });
    },

    createSequence(payload) {
      return request('POST', '/v1/sequences', { body: payload });
    },

    activateSequence(sequenceId) {
      return request('POST', `/v1/sequences/${encodeURIComponent(sequenceId)}/activate`, { body: {} });
    },

    enrollContacts(sequenceId, contactIds, channelIds) {
      const body = { contactIds };
      if (Array.isArray(channelIds) && channelIds.length) body.channelIds = channelIds;
      return request('POST', `/v1/sequences/${encodeURIComponent(sequenceId)}/enroll`, { body });
    },

    unenrollContact(sequenceId, contactId) {
      return request(
        'DELETE',
        `/v1/sequences/${encodeURIComponent(sequenceId)}/enroll/${encodeURIComponent(contactId)}`
      );
    },

    listWebhookSettings() {
      return request('GET', '/v1/webhooks/settings');
    },

    createWebhookSettings(payload) {
      return request('POST', '/v1/webhooks/settings', { body: payload });
    }
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  ZernioError,
  resolveConfig,
  createZernioClient
};
