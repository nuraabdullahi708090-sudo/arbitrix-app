'use strict';

/**
 * Customer preference persistence on top of Zernio contact custom fields.
 *
 * NO NEW DATABASE. Zernio already owns the contact record that every inbound
 * WhatsApp message is tied to (`message.received` carries
 * `message.sender.contactId` and `conversation.contactId`), and its Custom
 * Fields API is designed for exactly this. The integration therefore stores the
 * language preference and the automation flags there, and keeps only a bounded
 * in-process cache as a latency optimisation. A process restart loses nothing
 * durable.
 *
 * FIELDS (all created by scripts/zernio-setup.js --apply):
 *   arbitrix_language            text     en | pt-BR (future es)
 *   arbitrix_language_source     text     explicit | detected | campaign | default
 *   arbitrix_language_confirmed  boolean  true once the customer chose explicitly
 *   arbitrix_language_prompt_at  text     ISO timestamp of the last language ask
 *   arbitrix_campaign_language   text     en | pt-BR, set by the campaign, never guessed
 *   arbitrix_opt_out             boolean  promotional opt-out
 *   arbitrix_human_handoff       boolean  a human owns the conversation
 *   arbitrix_registered          boolean  account created
 *   arbitrix_deposited           boolean  qualifying deposit confirmed
 *   arbitrix_followup_6h         boolean  six-hour step delivered
 *   arbitrix_followup_1d         boolean  one-day step delivered
 *   arbitrix_followup_3d         boolean  three-day step delivered
 */

const FIELDS = Object.freeze({
  language: { slug: 'arbitrix_language', name: 'Arbitrix Language', type: 'text' },
  languageSource: { slug: 'arbitrix_language_source', name: 'Arbitrix Language Source', type: 'text' },
  languageConfirmed: { slug: 'arbitrix_language_confirmed', name: 'Arbitrix Language Confirmed', type: 'boolean' },
  languagePromptAt: { slug: 'arbitrix_language_prompt_at', name: 'Arbitrix Language Prompt At', type: 'text' },
  campaignLanguage: { slug: 'arbitrix_campaign_language', name: 'Arbitrix Campaign Language', type: 'text' },
  optOut: { slug: 'arbitrix_opt_out', name: 'Arbitrix Opt Out', type: 'boolean' },
  humanHandoff: { slug: 'arbitrix_human_handoff', name: 'Arbitrix Human Handoff', type: 'boolean' },
  registered: { slug: 'arbitrix_registered', name: 'Arbitrix Registered', type: 'boolean' },
  deposited: { slug: 'arbitrix_deposited', name: 'Arbitrix Deposited', type: 'boolean' },
  welcomed: { slug: 'arbitrix_welcomed', name: 'Arbitrix Welcomed', type: 'boolean' },
  sequenceLanguage: { slug: 'arbitrix_sequence_language', name: 'Arbitrix Sequence Language', type: 'text' },
  followup6h: { slug: 'arbitrix_followup_6h', name: 'Arbitrix Followup 6h', type: 'boolean' },
  followup1d: { slug: 'arbitrix_followup_1d', name: 'Arbitrix Followup 1d', type: 'boolean' },
  followup3d: { slug: 'arbitrix_followup_3d', name: 'Arbitrix Followup 3d', type: 'boolean' }
});

const ALL_FIELDS = Object.keys(FIELDS).map((key) => FIELDS[key]);

function toBoolean(value) {
  if (value === true || value === false) return value;
  if (value === undefined || value === null || value === '') return false;
  const text = String(value).trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === 'sim';
}

/**
 * `contact.customFields` is documented as an object keyed by slug. Older
 * payloads and some proxies return an array of { slug, value }; both are
 * accepted so a shape difference cannot silently erase a preference.
 */
function normalizeCustomFields(raw) {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const output = {};
    for (const entry of raw) {
      if (!entry) continue;
      const key = entry.slug || entry.field || entry.key;
      if (key) output[String(key)] = entry.value;
    }
    return output;
  }
  if (typeof raw === 'object') return raw;
  return {};
}

function readField(fields, definition) {
  const value = fields[definition.slug];
  if (value === undefined || value === null) return null;
  return value;
}

function normalizePreferences(contact) {
  const fields = normalizeCustomFields(contact && contact.customFields);
  const language = readField(fields, FIELDS.language);
  const source = readField(fields, FIELDS.languageSource);
  const confirmed = toBoolean(readField(fields, FIELDS.languageConfirmed));

  return {
    contactId: contact && contact.id ? contact.id : null,
    name: contact && contact.name ? String(contact.name).trim() : '',
    isSubscribed: contact && contact.isSubscribed === false ? false : true,
    language: language ? String(language).trim() : null,
    languageSource: source ? String(source).trim() : null,
    languageConfirmed: confirmed,
    languagePromptAt: readField(fields, FIELDS.languagePromptAt) || null,
    campaignLanguage: readField(fields, FIELDS.campaignLanguage) || null,
    optOut: toBoolean(readField(fields, FIELDS.optOut)) || (contact && contact.isSubscribed === false),
    humanHandoff: toBoolean(readField(fields, FIELDS.humanHandoff)),
    registered: toBoolean(readField(fields, FIELDS.registered)),
    deposited: toBoolean(readField(fields, FIELDS.deposited)),
    welcomed: toBoolean(readField(fields, FIELDS.welcomed)),
    sequenceLanguage: readField(fields, FIELDS.sequenceLanguage) || null,
    followUps: {
      '6h': toBoolean(readField(fields, FIELDS.followup6h)),
      '1d': toBoolean(readField(fields, FIELDS.followup1d)),
      '3d': toBoolean(readField(fields, FIELDS.followup3d))
    },
    raw: fields
  };
}

function createContactPreferences(options) {
  const opts = options || {};
  if (!opts.client) throw new Error('createContactPreferences requires a Zernio client');
  const client = opts.client;
  const logger = opts.logger || console;
  const ttlMs = Number(opts.ttlMs || 60000);
  const maxEntries = Number(opts.maxEntries || 2000);
  const clock = opts.clock || (() => Date.now());

  const cache = new Map();
  let readFailureLogged = false;

  function remember(contactId, preferences) {
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(contactId, { preferences, at: clock() });
  }

  async function getPreferences(contactId, getOptions) {
    const getOpts = getOptions || {};
    if (!contactId) {
      return { ...normalizePreferences(null), unavailable: true };
    }
    const cached = cache.get(contactId);
    if (!getOpts.refresh && cached && clock() - cached.at < ttlMs) {
      return cached.preferences;
    }
    try {
      const response = await client.getContact(contactId);
      const contact = response && response.contact ? response.contact : response;
      const preferences = normalizePreferences(contact);
      remember(contactId, preferences);
      readFailureLogged = false;
      return preferences;
    } catch (error) {
      if (!readFailureLogged) {
        readFailureLogged = true;
        logger.warn('[WhatsApp] Contact preference read failed; continuing with defaults', {
          event: 'whatsapp_contact_read_failed',
          code: error && error.code,
          status: error && error.status
        });
      }
      if (cached) return cached.preferences;
      return { ...normalizePreferences(null), contactId, unavailable: true };
    }
  }

  async function writeField(contactId, definition, value) {
    try {
      await client.setContactField(contactId, definition.slug, value);
      return true;
    } catch (error) {
      logger.warn('[WhatsApp] Contact field write failed', {
        event: 'whatsapp_contact_write_failed',
        field: definition.slug,
        code: error && error.code,
        status: error && error.status
      });
      return false;
    }
  }

  async function saveLanguage(contactId, { language, source, confirmed }) {
    if (!contactId || !language) return false;
    const results = await Promise.all([
      writeField(contactId, FIELDS.language, language),
      writeField(contactId, FIELDS.languageSource, source || 'detected'),
      writeField(contactId, FIELDS.languageConfirmed, Boolean(confirmed))
    ]);
    cache.delete(contactId);
    return results.every(Boolean);
  }

  async function markLanguagePrompt(contactId, at) {
    if (!contactId) return false;
    const result = await writeField(contactId, FIELDS.languagePromptAt, (at || new Date()).toISOString());
    cache.delete(contactId);
    return result;
  }

  async function setFlag(contactId, key, value) {
    const definition = FIELDS[key];
    if (!definition || !contactId) return false;
    if (definition.type !== 'boolean') return false;
    const result = await writeField(contactId, definition, Boolean(value));
    cache.delete(contactId);
    return result;
  }

  async function setValue(contactId, key, value) {
    const definition = FIELDS[key];
    if (!definition || !contactId) return false;
    const result = await writeField(contactId, definition, value);
    cache.delete(contactId);
    return result;
  }

  async function setOptOut(contactId, value) {
    const ok = await setFlag(contactId, 'optOut', value);
    try {
      await client.updateContact(contactId, { isSubscribed: !value });
    } catch (error) {
      logger.warn('[WhatsApp] Contact subscription update failed', {
        event: 'whatsapp_contact_subscribe_failed',
        code: error && error.code,
        status: error && error.status
      });
    }
    return ok;
  }

  function clearCache(contactId) {
    if (contactId) cache.delete(contactId);
    else cache.clear();
  }

  /**
   * Compare the fields this integration needs with the definitions that exist
   * and return the ones that must be created. Used by the setup script.
   */
  async function planFields() {
    const response = await client.listCustomFields();
    const existing = (response && (response.fields || response.customFields)) || [];
    const slugs = new Set(
      (Array.isArray(existing) ? existing : [])
        .map((field) => (field && (field.slug || field.name) ? String(field.slug || field.name) : ''))
        .filter(Boolean)
    );
    return {
      create: ALL_FIELDS.filter((field) => !slugs.has(field.slug)),
      existing: ALL_FIELDS.filter((field) => slugs.has(field.slug))
    };
  }

  return {
    FIELDS,
    getPreferences,
    saveLanguage,
    markLanguagePrompt,
    setFlag,
    setValue,
    setOptOut,
    clearCache,
    planFields,
    normalizePreferences
  };
}

module.exports = {
  FIELDS,
  ALL_FIELDS,
  toBoolean,
  normalizeCustomFields,
  normalizePreferences,
  createContactPreferences
};
