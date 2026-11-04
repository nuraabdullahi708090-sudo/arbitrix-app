'use strict';

/**
 * Composition root for the Zernio WhatsApp integration.
 *
 * Everything is optional at boot: with no ZERNIO_API_KEY the factory returns
 * null and the web server starts exactly as before. This matters because the
 * repository is also deployed to environments that do not run WhatsApp, and a
 * missing credential must never crash the process or block a deploy.
 */

const { ACTIVE_LANGUAGES, DEFAULT_LANGUAGE, LANGUAGES } = require('./Languages');
const { createZernioClient } = require('./ZernioClient');
const { createContactPreferences } = require('./ContactPreferences');
const { createWhatsAppAutomation, resolveAutomationConfig } = require('./WhatsAppAutomation');
const { createZernioWebhookHandler, createEventDeduper } = require('./ZernioWebhook');
const { requiredTemplates, TEMPLATE_DEFINITIONS, templateName } = require('./WhatsAppTemplates');
const { FOLLOW_UP_STAGES } = require('./FollowUpRouter');

/**
 * Secret-free description of the configuration, safe for an admin endpoint and
 * for logs. Booleans and counts only - never a key or a secret value.
 */
function describeWhatsAppConfig(overrides) {
  const input = overrides || {};
  const env = process.env;
  const config = resolveAutomationConfig(input.config);

  return {
    enabled: config.enabled,
    apiKeyConfigured: Boolean(input.apiKey !== undefined ? input.apiKey : env.ZERNIO_API_KEY),
    webhookSecretConfigured: Boolean(
      input.webhookSecret !== undefined ? input.webhookSecret : env.ZERNIO_WEBHOOK_SECRET
    ),
    accountIdConfigured: Boolean(config.accountId),
    profileIdConfigured: Boolean(config.profileId),
    baseUrl: (env.ZERNIO_BASE_URL || 'https://zernio.com/api').replace(/\/+$/, ''),
    languages: ACTIVE_LANGUAGES.map((code) => ({
      code,
      label: LANGUAGES[code].label,
      metaLocale: LANGUAGES[code].metaLocale
    })),
    plannedLanguages: Object.keys(LANGUAGES).filter((code) => !LANGUAGES[code].active),
    confidenceThreshold: config.confidenceThreshold,
    campaignLanguage: config.campaignLanguage || null,
    sendWelcome: config.sendWelcome !== false,
    promptTtlHours: Math.round(config.promptTtlMs / (60 * 60 * 1000)),
    sequences: Object.keys(config.sequenceIds || {}).reduce((accumulator, language) => {
      accumulator[language] = Boolean(config.sequenceIds[language]);
      return accumulator;
    }, {}),
    templates: (() => {
      const list = [];
      for (const language of ACTIVE_LANGUAGES) {
        for (const definition of TEMPLATE_DEFINITIONS) {
          list.push({ language, name: templateName(definition, language) });
        }
      }
      return list;
    })(),
    followUps: FOLLOW_UP_STAGES.map((entry) => ({
      stage: entry.stage,
      dueOffsetMinutes: entry.dueOffsetMinutes
    })),
    defaultLanguage: DEFAULT_LANGUAGE
  };
}

function createWhatsAppIntegration(options) {
  const opts = options || {};
  const env = process.env;
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : env.ZERNIO_API_KEY;
  if (!apiKey) return null;

  const client = createZernioClient({
    apiKey,
    baseUrl: opts.baseUrl,
    accountId: opts.accountId,
    profileId: opts.profileId,
    fetchImpl: opts.fetchImpl,
    logger: opts.logger,
    maxRetries: opts.maxRetries,
    timeoutMs: opts.timeoutMs
  });

  const preferences = createContactPreferences({
    client,
    logger: opts.logger,
    ttlMs: opts.cacheTtlMs,
    maxEntries: opts.cacheMaxEntries,
    clock: opts.clock
  });

  const baseConfig = resolveAutomationConfig(opts.config);
  const config = {
    ...baseConfig,
    ...(opts.config || {}),
    sequenceIds: { ...baseConfig.sequenceIds, ...((opts.config && opts.config.sequenceIds) || {}) }
  };

  const automation = createWhatsAppAutomation({
    client,
    preferences,
    logger: opts.logger,
    clock: opts.clock,
    config,
    approvalLookup: opts.approvalLookup
  });

  const webhook = createZernioWebhookHandler({
    automation,
    logger: opts.logger,
    secret: opts.webhookSecret !== undefined ? opts.webhookSecret : env.ZERNIO_WEBHOOK_SECRET,
    enabled: opts.enabled === undefined ? config.enabled : opts.enabled,
    deduper: opts.deduper || createEventDeduper({ clock: opts.clock })
  });

  return {
    client,
    preferences,
    automation,
    webhook,
    config,
    describe: () => describeWhatsAppConfig({ config, apiKey, webhookSecret: opts.webhookSecret })
  };
}

/**
 * Never throws, never blocks startup. Returns null when the integration cannot
 * be built; the reason is logged once with no secret in it.
 */
function createWhatsAppIntegrationSafely(options) {
  const opts = options || {};
  const logger = opts.logger || console;
  try {
    const integration = createWhatsAppIntegration(opts);
    if (!integration) {
      logger.log('[WhatsApp] Zernio integration not configured (ZERNIO_API_KEY absent)');
      return null;
    }
    if (!integration.describe().webhookSecretConfigured) {
      logger.warn('[WhatsApp] ZERNIO_WEBHOOK_SECRET is not set; webhook deliveries will be refused');
    }
    if (!integration.config.enabled) {
      logger.log('[WhatsApp] Automation is disabled (WHATSAPP_AUTOMATION_ENABLED=false)');
    }
    return integration;
  } catch (error) {
    logger.error('[WhatsApp] Integration could not be initialised', {
      event: 'whatsapp_init_failed',
      code: error && error.code,
      message: error && error.message
    });
    return null;
  }
}

module.exports = {
  createWhatsAppIntegration,
  createWhatsAppIntegrationSafely,
  describeWhatsAppConfig,
  requiredTemplates,
  ACTIVE_LANGUAGES,
  DEFAULT_LANGUAGE
};
