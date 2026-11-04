'use strict';

/**
 * Multilingual WhatsApp automation for Arbitrix (Zernio transport).
 *
 * SCOPE: this module decides WHAT to say and in WHICH language, and delegates
 * every network call to the Zernio client. It does not create a second funnel:
 * the existing welcome / 6h / 1d / 3d touchpoints keep their timing, and the
 * existing Zernio sequence (or the API-mode router) keeps scheduling them.
 *
 * It is intentionally transport-agnostic and side-effect free apart from the
 * injected client, so the whole conversation can be tested without a network,
 * a database or a real customer.
 *
 * BEHAVIOUR CONTRACT
 *   1. First contact with a clear language  -> welcome in that language.
 *   2. First contact with no clear language -> bilingual language question, no
 *      welcome yet (a Portuguese speaker never receives a 600-character English
 *      welcome).
 *   3. Explicit selection always wins and is persisted as confirmed.
 *   4. A persisted preference is never overwritten by a detection.
 *   5. Short replies (yes / no / ok / emoji / numbers) never change language.
 *   6. STOP / PARAR unsubscribe from promotional messages and unenroll the
 *      sequence; START / ATIVAR opt back in.
 *   7. A human request (or a human reply, or another app taking the thread)
 *      pauses automated promotional messaging and unenrolls the sequence.
 *      The language preference is retained.
 */

const {
  DEFAULT_LANGUAGE,
  isActiveLanguage,
  toMetaLocale
} = require('./Languages');
const {
  resolveLanguage,
  isLanguageMenuRequest,
  matchExplicitLanguage
} = require('./LanguageResolver');
const { replyText, detectIntent, INTENTS } = require('./WhatsAppContent');
const { evaluateFollowUp } = require('./FollowUpRouter');

function envBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].indexOf(text) !== -1) return true;
  if (['0', 'false', 'no', 'off'].indexOf(text) !== -1) return false;
  return fallback;
}

function resolveAutomationConfig(overrides) {
  const input = overrides || {};
  const env = process.env;
  const promptHours = Number(env.WHATSAPP_LANGUAGE_PROMPT_TTL_HOURS || 168);

  return {
    enabled: input.enabled === undefined
      ? envBoolean(env.WHATSAPP_AUTOMATION_ENABLED, false)
      : Boolean(input.enabled),
    accountId: input.accountId !== undefined ? input.accountId : env.ZERNIO_WHATSAPP_ACCOUNT_ID || '',
    profileId: input.profileId !== undefined ? input.profileId : env.ZERNIO_PROFILE_ID || '',
    confidenceThreshold: input.confidenceThreshold !== undefined
      ? input.confidenceThreshold
      : Number(env.WHATSAPP_LANGUAGE_CONFIDENCE_THRESHOLD || 0.6),
    campaignLanguage: input.campaignLanguage !== undefined
      ? input.campaignLanguage
      : env.WHATSAPP_CAMPAIGN_LANGUAGE || '',
    // The EXISTING Zernio automation already sends an immediate welcome. When
    // it is kept, set WHATSAPP_SEND_WELCOME=false so the first inbound message
    // is answered instead of producing a second welcome.
    sendWelcome: input.sendWelcome !== undefined
      ? Boolean(input.sendWelcome)
      : envBoolean(env.WHATSAPP_SEND_WELCOME, true),
    promptTtlMs: input.promptTtlMs !== undefined
      ? input.promptTtlMs
      : (Number.isFinite(promptHours) && promptHours > 0 ? promptHours : 168) * 60 * 60 * 1000,
    sequenceIds: input.sequenceIds || {
      en: env.ZERNIO_SEQUENCE_EN || '',
      'pt-BR': env.ZERNIO_SEQUENCE_PT_BR || ''
    }
  };
}

function fillName(text, name, language) {
  const fallback = replyText(language, 'nameFallback') || 'there';
  const clean = String(name || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return String(text || '').replace(/\{\{1\}\}/g, clean || fallback);
}

function safeUserText(text) {
  return String(text === undefined || text === null ? '' : text).trim();
}

/**
 * Map a "1"/"2" reply to a language. Only valid while a language question is
 * recent; the numbers are meaningless otherwise and must not switch a customer.
 */
function matchNumericSelection(text) {
  const normalized = safeUserText(text).toLowerCase().replace(/\s+/g, ' ');
  const match = normalized.match(/^(?:op[cç][aã]o\s*)?([12])[.)!]?$/);
  if (!match) return null;
  return match[1] === '1' ? 'en' : 'pt-BR';
}

function createWhatsAppAutomation(options) {
  const opts = options || {};
  if (!opts.client) throw new Error('createWhatsAppAutomation requires a Zernio client');
  if (!opts.preferences) throw new Error('createWhatsAppAutomation requires a preferences store');

  const client = opts.client;
  const preferences = opts.preferences;
  const logger = opts.logger || console;
  const clock = opts.clock || (() => Date.now());
  const baseConfig = resolveAutomationConfig(opts.config);
  const config = {
    ...baseConfig,
    ...(opts.config || {}),
    sequenceIds: { ...baseConfig.sequenceIds, ...((opts.config && opts.config.sequenceIds) || {}) }
  };
  const approvalLookup = opts.approvalLookup || null;

  const stats = {
    received: 0,
    replied: 0,
    welcomed: 0,
    languagePrompts: 0,
    languageSelections: 0,
    optOuts: 0,
    optIns: 0,
    handoffs: 0,
    enrollments: 0,
    unenrollments: 0,
    skipped: 0,
    failures: 0,
    lastAction: null,
    lastReason: null,
    lastLanguage: null,
    lastAt: null
  };

  function record(action, extra) {
    stats.lastAction = action;
    stats.lastReason = (extra && extra.reason) || null;
    stats.lastLanguage = (extra && extra.language) || stats.lastLanguage;
    stats.lastAt = new Date(clock()).toISOString();
  }

  async function sendText({ accountId, conversationId, text, eventId, suffix }) {
    try {
      await client.sendText({
        accountId,
        conversationId,
        message: text,
        idempotencyKey: eventId ? `wa_${eventId}_${suffix || 'reply'}` : undefined
      });
      stats.replied += 1;
      return true;
    } catch (error) {
      stats.failures += 1;
      logger.error('[WhatsApp] Reply send failed', {
        event: 'whatsapp_reply_failed',
        code: error && error.code,
        status: error && error.status,
        retryable: error && error.retryable
      });
      return false;
    }
  }

  async function unenrollAll(contactId, prefs) {
    if (!contactId) return;
    const languages = new Set([
      prefs && prefs.sequenceLanguage,
      ...Object.keys(config.sequenceIds || {})
    ]);
    for (const language of languages) {
      const sequenceId = config.sequenceIds && config.sequenceIds[language];
      if (!sequenceId) continue;
      try {
        await client.unenrollContact(sequenceId, contactId);
        stats.unenrollments += 1;
      } catch (error) {
        // Not enrolled is the normal case for most contacts; a 404 is not an error.
        if (error && error.status !== 404) {
          logger.warn('[WhatsApp] Unenroll failed', {
            event: 'whatsapp_unenroll_failed',
            status: error && error.status,
            code: error && error.code
          });
        }
      }
    }
    if (prefs && prefs.sequenceLanguage && contactId) {
      await preferences.setValue(contactId, 'sequenceLanguage', '');
    }
  }

  async function enroll(contactId, language, prefs) {
    if (!contactId || !language) return { enrolled: false, reason: 'no-contact' };
    if (prefs.optOut) return { enrolled: false, reason: 'opted_out' };
    if (prefs.humanHandoff) return { enrolled: false, reason: 'human_handoff' };
    if (prefs.registered) return { enrolled: false, reason: 'registered' };
    if (prefs.deposited) return { enrolled: false, reason: 'deposited' };
    if (prefs.sequenceLanguage === language) return { enrolled: false, reason: 'already_enrolled' };

    const sequenceId = config.sequenceIds && config.sequenceIds[language];
    if (!sequenceId) return { enrolled: false, reason: 'sequence_not_configured' };

    if (prefs.sequenceLanguage && prefs.sequenceLanguage !== language) {
      const oldSequence = config.sequenceIds[prefs.sequenceLanguage];
      if (oldSequence) {
        try {
          await client.unenrollContact(oldSequence, contactId);
        } catch (error) {
          if (error && error.status !== 404) {
            logger.warn('[WhatsApp] Unenroll on language change failed', {
              event: 'whatsapp_unenroll_language_change_failed',
              status: error && error.status
            });
          }
        }
      }
    }

    try {
      await client.enrollContacts(sequenceId, [contactId]);
      await preferences.setValue(contactId, 'sequenceLanguage', language);
      stats.enrollments += 1;
      return { enrolled: true, sequenceId };
    } catch (error) {
      logger.warn('[WhatsApp] Enroll failed', {
        event: 'whatsapp_enroll_failed',
        status: error && error.status,
        code: error && error.code
      });
      return { enrolled: false, reason: 'enroll_failed' };
    }
  }

  async function isTemplateApproved(name, language) {
    if (!approvalLookup) return true;
    try {
      const approved = await approvalLookup(name, toMetaLocale(language));
      return approved === true;
    } catch (error) {
      logger.warn('[WhatsApp] Template approval lookup failed', {
        event: 'whatsapp_template_lookup_failed',
        name,
        status: error && error.status
      });
      return false;
    }
  }

  async function handleInbound(event, context) {
    const ctx = context || {};
    const payload = event || {};
    stats.received += 1;

    const message = payload.message;
    if (!message) return { action: 'skipped', reason: 'no-message' };
    if (message.direction && message.direction !== 'incoming') {
      return { action: 'skipped', reason: 'not-incoming' };
    }
    if (message.platform && message.platform !== 'whatsapp') {
      return { action: 'skipped', reason: 'not-whatsapp' };
    }
    if (payload.metadata && payload.metadata.standby === true) {
      stats.skipped += 1;
      record('skipped', { reason: 'standby' });
      return { action: 'skipped', reason: 'standby' };
    }

    const conversation = payload.conversation || {};
    const account = payload.account || {};
    const conversationId = message.conversationId || conversation.id || null;
    const contactId = (message.sender && message.sender.contactId) || conversation.contactId || null;
    const accountId = account.accountId || config.accountId;
    const displayName = (message.sender && message.sender.name) || conversation.participantName || '';
    const text = safeUserText(message.text);
    const eventId = payload.id || ctx.eventId || null;

    if (!conversationId) {
      stats.skipped += 1;
      record('skipped', { reason: 'no-conversation' });
      return { action: 'skipped', reason: 'no-conversation' };
    }

    const prefs = contactId
      ? await preferences.getPreferences(contactId)
      : {
        contactId: null,
        name: displayName,
        language: null,
        languageSource: null,
        languageConfirmed: false,
        languagePromptAt: null,
        campaignLanguage: null,
        optOut: false,
        humanHandoff: false,
        registered: false,
        deposited: false,
        welcomed: false,
        sequenceLanguage: null,
        followUps: {},
        isSubscribed: true
      };

    const persisted = prefs.language;
    const campaignLanguage = prefs.campaignLanguage || config.campaignLanguage || null;
    // Duplicate-message guard: the app only sends its own welcome when that is
    // enabled. Otherwise `alreadyWelcomed` is true so the first message is
    // answered by the intent handler and no second welcome is produced.
    const alreadyWelcomed = prefs.welcomed || config.sendWelcome === false;

    function resolveFor(input) {
      return resolveLanguage({
        text: input === undefined ? text : input,
        persistedLanguage: persisted,
        campaignLanguage,
        confidenceThreshold: config.confidenceThreshold
      });
    }

    async function persist(language, source, confirmed) {
      if (!contactId) return false;
      return preferences.saveLanguage(contactId, { language, source, confirmed });
    }

    // 1. Opt-out -----------------------------------------------------------
    if (text && INTENTS.optOut.test(text)) {
      const base = resolveFor(text);
      const language = base.language;
      if (contactId) {
        await preferences.setOptOut(contactId, true);
        await unenrollAll(contactId, prefs);
      }
      const delivered = await sendText({
        accountId,
        conversationId,
        text: replyText(language, 'optOutAck'),
        eventId,
        suffix: 'optout'
      });
      stats.optOuts += 1;
      record('opt_out', { language });
      return { action: 'opt_out', language, delivered };
    }

    // 2. Opt-in ------------------------------------------------------------
    if (text && INTENTS.optIn.test(text)) {
      const base = resolveFor(text);
      const language = base.language;
      if (contactId) {
        await preferences.setOptOut(contactId, false);
      }
      const delivered = await sendText({
        accountId,
        conversationId,
        text: replyText(language, 'optInAck'),
        eventId,
        suffix: 'optin'
      });
      stats.optIns += 1;
      record('opt_in', { language });
      return { action: 'opt_in', language, delivered };
    }

    // 3. Language menu -----------------------------------------------------
    if (text && isLanguageMenuRequest(text)) {
      const base = resolveFor(text);
      const language = base.language;
      if (contactId) await preferences.markLanguagePrompt(contactId, new Date(clock()));
      const delivered = await sendText({
        accountId,
        conversationId,
        text: replyText(language, 'languagePrompt'),
        eventId,
        suffix: 'langmenu'
      });
      stats.languagePrompts += 1;
      record('language_menu', { language });
      return { action: 'language_menu', language, delivered };
    }

    // 4. Numeric answer to a language question -----------------------------
    const promptAge = prefs.languagePromptAt ? clock() - Date.parse(prefs.languagePromptAt) : Infinity;
    const promptRecent = Number.isFinite(promptAge) && promptAge >= 0 && promptAge < config.promptTtlMs;
    const numeric = promptRecent ? matchNumericSelection(text) : null;
    if (numeric && isActiveLanguage(numeric)) {
      await persist(numeric, 'explicit', true);
      stats.languageSelections += 1;
      const welcomed = alreadyWelcomed;
      const delivered = await sendText({
        accountId,
        conversationId,
        text: welcomed
          ? replyText(numeric, 'languageSet')
          : fillName(replyText(numeric, 'welcome'), displayName || prefs.name, numeric),
        eventId,
        suffix: 'langselect'
      });
      if (contactId && !welcomed) {
        await preferences.setFlag(contactId, 'welcomed', true);
        stats.welcomed += 1;
      }
      const enrollment = await enroll(contactId, numeric, { ...prefs, language: numeric });
      record('language_selected', { language: numeric });
      return { action: 'language_selected', language: numeric, source: 'explicit', enrollment, delivered };
    }

    // 5. Explicit language choice -----------------------------------------
    const explicit = matchExplicitLanguage(text);
    if (explicit) {
      if (!isActiveLanguage(explicit)) {
        const base = resolveFor(text);
        const delivered = await sendText({
          accountId,
          conversationId,
          text: replyText(base.language, 'languageUnsupported'),
          eventId,
          suffix: 'langunsupported'
        });
        record('language_unsupported', { language: base.language });
        return { action: 'language_unsupported', language: base.language, requested: explicit, delivered };
      }

      await persist(explicit, 'explicit', true);
      stats.languageSelections += 1;

      let delivered;
      if (!alreadyWelcomed) {
        delivered = await sendText({
          accountId,
          conversationId,
          text: fillName(replyText(explicit, 'welcome'), displayName || prefs.name, explicit),
          eventId,
          suffix: 'welcome'
        });
        if (contactId) await preferences.setFlag(contactId, 'welcomed', true);
        stats.welcomed += 1;
      } else {
        delivered = await sendText({
          accountId,
          conversationId,
          text: replyText(explicit, 'languageSet'),
          eventId,
          suffix: 'langset'
        });
      }
      const enrollment = await enroll(contactId, explicit, { ...prefs, language: explicit });
      record('language_selected', { language: explicit });
      return { action: 'language_selected', language: explicit, source: 'explicit', enrollment, delivered };
    }

    // 6. Human handoff request --------------------------------------------
    if (text && INTENTS.handoff.test(text)) {
      const base = resolveFor(text);
      const language = base.language;
      if (contactId) {
        await preferences.setFlag(contactId, 'humanHandoff', true);
        await unenrollAll(contactId, prefs);
      }
      const delivered = await sendText({
        accountId,
        conversationId,
        text: replyText(language, 'humanHandoffAck'),
        eventId,
        suffix: 'handoff'
      });
      stats.handoffs += 1;
      record('handoff', { language });
      return { action: 'handoff', language, delivered };
    }

    // 7. Media / no text ---------------------------------------------------
    if (!text) {
      const base = resolveFor('');
      const language = base.language;
      const delivered = await sendText({
        accountId,
        conversationId,
        text: replyText(language, 'textOnly'),
        eventId,
        suffix: 'textonly'
      });
      record('answered', { language, reason: 'no-text' });
      return { action: 'answered', language, reason: 'no-text', delivered };
    }

    // 8. Resolve and persist a confident detection -------------------------
    const resolution = resolveFor(text);
    const language = resolution.language;

    if (resolution.source === 'detected' && !persisted) {
      await persist(language, 'detected', false);
    }

    // 9. Ambiguous first contact -> ask before sending a long welcome ------
    if (resolution.shouldAsk && !promptRecent) {
      if (contactId) await preferences.markLanguagePrompt(contactId, new Date(clock()));
      const delivered = await sendText({
        accountId,
        conversationId,
        text: replyText(language, 'languagePrompt'),
        eventId,
        suffix: 'langprompt'
      });
      // Enroll in the FALLBACK language so the existing 6h/1d/3d funnel is not
      // lost while the customer decides. The preference itself is NOT persisted:
      // an explicit choice or a confident detection can still set it, and the
      // language-change path moves the enrollment to the other sequence.
      const enrollment = await enroll(contactId, language, prefs);
      stats.languagePrompts += 1;
      record('language_prompt', { language, reason: resolution.reason });
      return { action: 'language_prompt', language, reason: resolution.reason, enrollment, delivered };
    }

    // 10. First welcome ----------------------------------------------------
    if (!alreadyWelcomed) {
      const delivered = await sendText({
        accountId,
        conversationId,
        text: fillName(replyText(language, 'welcome'), displayName || prefs.name, language),
        eventId,
        suffix: 'welcome'
      });
      if (contactId) await preferences.setFlag(contactId, 'welcomed', true);
      stats.welcomed += 1;
      const enrollment = await enroll(contactId, language, { ...prefs, language });
      record('welcomed', { language, reason: resolution.source });
      return { action: 'welcomed', language, source: resolution.source, enrollment, delivered };
    }

    // 11. Answer the intent ------------------------------------------------
    const intent = detectIntent(text);
    const key = intent || 'fallback';
    const delivered = await sendText({
      accountId,
      conversationId,
      text: replyText(language, key),
      eventId,
      suffix: key
    });
    const enrollment = await enroll(contactId, language, { ...prefs, language });
    record('answered', { language, reason: intent || 'fallback' });
    return {
      action: 'answered',
      language,
      source: resolution.source,
      intent: intent || 'fallback',
      enrollment,
      delivered
    };
  }

  async function handleSent(event) {
    const payload = event || {};
    const message = payload.message || {};
    if (message.sentVia !== 'human') {
      return { action: 'ignored', reason: 'not-human' };
    }
    const conversation = payload.conversation || {};
    const contactId = conversation.contactId || (message.sender && message.sender.contactId) || null;
    if (!contactId) return { action: 'ignored', reason: 'no-contact' };

    const prefs = await preferences.getPreferences(contactId);
    await preferences.setFlag(contactId, 'humanHandoff', true);
    await unenrollAll(contactId, prefs);
    stats.handoffs += 1;
    record('handoff', { language: prefs.language, reason: 'human_reply' });
    return { action: 'handoff', reason: 'human_reply' };
  }

  async function handleControlChanged(event) {
    const payload = event || {};
    const conversation = payload.conversation || {};
    const contactId = conversation.contactId || null;
    const control = payload.control || {};
    if (!contactId) return { action: 'ignored', reason: 'no-contact' };

    const prefs = await preferences.getPreferences(contactId);
    if (control.owner && control.owner !== 'app') {
      await preferences.setFlag(contactId, 'humanHandoff', true);
      await unenrollAll(contactId, prefs);
      record('handoff', { language: prefs.language, reason: `owner:${control.owner}` });
      return { action: 'handoff', reason: `owner:${control.owner}` };
    }
    if (control.owner === 'app' && control.previousOwner && control.previousOwner !== 'app') {
      await preferences.setFlag(contactId, 'humanHandoff', false);
      record('resumed', { language: prefs.language, reason: 'control_returned' });
      return { action: 'resumed', reason: 'control_returned' };
    }
    return { action: 'ignored', reason: 'no-change' };
  }

  async function handleFieldChanged(event) {
    const payload = event || {};
    const contactId = payload.contactId || (payload.contact && payload.contact.id) || null;
    const field = String(payload.field || '');
    if (!contactId || !field) return { action: 'ignored', reason: 'missing-identifiers' };

    const prefs = await preferences.getPreferences(contactId, { refresh: true });
    if (field === 'arbitrix_registered' || field === 'arbitrix_deposited' || field === 'arbitrix_opt_out') {
      const truthy = payload.value === true || String(payload.value).toLowerCase() === 'true';
      if (truthy) await unenrollAll(contactId, prefs);
      record('unenrolled', { language: prefs.language, reason: field });
      return { action: 'unenrolled', reason: field };
    }
    return { action: 'ignored', reason: 'unrelated-field' };
  }

  /**
   * Follow-up decision for one contact (API mode). Reads the persisted
   * preferences and applies the router; never sends on its own.
   */
  async function decideFollowUp({ contactId, stage, now, enrolledAt, lastInboundAt }) {
    const prefs = await preferences.getPreferences(contactId);
    const language = prefs.language || DEFAULT_LANGUAGE;
    const decision = evaluateFollowUp({
      stage,
      now: now === undefined ? clock() : now,
      enrolledAt,
      lastInboundAt,
      language,
      optedOut: prefs.optOut,
      humanHandoff: prefs.humanHandoff,
      registered: prefs.registered,
      deposited: prefs.deposited,
      followUps: prefs.followUps
    });
    return { ...decision, approved: decision.send ? await isTemplateApproved(decision.templateName, language) : false };
  }

  async function handleEvent(eventName, payload) {
    switch (eventName) {
      case 'message.received':
        return handleInbound(payload);
      case 'message.sent':
        return handleSent(payload);
      case 'conversation.control_changed':
        return handleControlChanged(payload);
      case 'contact.field_changed':
        return handleFieldChanged(payload);
      default:
        return { action: 'ignored', reason: 'unhandled-event' };
    }
  }

  return {
    config,
    stats,
    handleEvent,
    handleInbound,
    handleSent,
    handleControlChanged,
    handleFieldChanged,
    decideFollowUp,
    // exported for tests
    _internals: { fillName, matchNumericSelection, unenrollAll, enroll }
  };
}

module.exports = {
  createWhatsAppAutomation,
  resolveAutomationConfig,
  fillName,
  matchNumericSelection
};
