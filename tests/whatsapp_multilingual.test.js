'use strict';

/**
 * Multilingual Zernio WhatsApp automation.
 *
 * These tests exercise the REAL resolver, the REAL content catalogue, the REAL
 * template catalogue, the REAL preference store and the REAL automation
 * orchestrator. Only the Zernio transport is faked (an in-memory client), so
 * what is asserted is the message a customer would receive. No network call is
 * made and no real customer is contacted.
 *
 * Coverage map (Phase 6 of the brief):
 *   first-time contact, returning contact, language detection, short ambiguous
 *   replies, explicit language change, every follow-up interval, template
 *   selection, template approval restrictions, opt-out, human handoff,
 *   duplicate webhook events, error and retry behaviour.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { ACTIVE_LANGUAGES, LANGUAGES, normalizeLanguage, toMetaLocale } = require('../services/whatsapp/Languages');
const {
  resolveLanguage,
  detectLanguage,
  classifyContent,
  isLanguageMenuRequest,
  matchExplicitLanguage
} = require('../services/whatsapp/LanguageResolver');
const {
  CONTENT,
  LINKS,
  replyText,
  detectIntent
} = require('../services/whatsapp/WhatsAppContent');
const {
  TEMPLATE_DEFINITIONS,
  templateName,
  validateTemplateBody,
  buildTemplatePayload,
  requiredTemplates,
  planProvisioning,
  isSendableTemplate,
  assertSendableTemplate,
  findTemplate
} = require('../services/whatsapp/WhatsAppTemplates');
const {
  FOLLOW_UP_STAGES,
  FOLLOW_UP_OFFSETS_MS,
  evaluateFollowUp,
  templateNameFor,
  sequenceSpec,
  sequenceNameFor
} = require('../services/whatsapp/FollowUpRouter');
const { FIELDS, createContactPreferences } = require('../services/whatsapp/ContactPreferences');
const { createWhatsAppAutomation, fillName, matchNumericSelection } = require('../services/whatsapp/WhatsAppAutomation');
const {
  verifySignature,
  createEventDeduper,
  createZernioWebhookHandler
} = require('../services/whatsapp/ZernioWebhook');
const {
  createWhatsAppIntegrationSafely,
  describeWhatsAppConfig
} = require('../services/whatsapp');

const silentLogger = { log() {}, warn() {}, error() {}, info() {} };

let clockNow = Date.parse('2026-06-01T12:00:00Z');
const clock = () => clockNow;

function createFetchRecorder() {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ success: true })
    };
  };
  return { calls, fetchImpl };
}

function createFakeClient(seed) {
  const options = seed || {};
  const contacts = new Map();
  const messages = [];
  const enrollments = [];
  const unenrollments = [];
  const calls = [];
  const templates = options.templates || [];

  function ensure(id) {
    if (!contacts.has(id)) {
      contacts.set(id, {
        id,
        name: options.name || 'Test Customer',
        isSubscribed: true,
        customFields: { ...(options.customFields || {}) }
      });
    }
    return contacts.get(id);
  }

  let sendFailures = Number(options.sendFailures || 0);

  return {
    contacts,
    messages,
    enrollments,
    unenrollments,
    calls,
    async getContact(id) {
      calls.push(['getContact', id]);
      return { contact: ensure(id) };
    },
    async updateContact(id, patch) {
      Object.assign(ensure(id), patch);
      return { success: true };
    },
    async setContactField(id, slug, value) {
      ensure(id).customFields[slug] = value;
      return { success: true };
    },
    async listCustomFields() {
      return { success: true, fields: [] };
    },
    async createCustomField(field) {
      return { success: true, field };
    },
    async listTemplates() {
      return { success: true, templates };
    },
    async createTemplate(payload) {
      templates.push({ name: payload.name, language: payload.language, status: 'PENDING' });
      return { success: true, template: { name: payload.name, language: payload.language, status: 'PENDING' } };
    },
    async sendText(args) {
      calls.push(['sendText', args]);
      if (sendFailures > 0) {
        sendFailures -= 1;
        const error = new Error('simulated transport failure');
        error.code = 'network_error';
        throw error;
      }
      messages.push(args);
      return { success: true, data: { messageId: `wamid.${messages.length}` } };
    },
    async sendTemplate(args) {
      calls.push(['sendTemplate', args]);
      messages.push({ template: args });
      return { success: true, data: { messageId: `wamid.t${messages.length}` } };
    },
    async enrollContacts(sequenceId, contactIds) {
      enrollments.push({ sequenceId, contactIds });
      return { success: true };
    },
    async unenrollContact(sequenceId, contactId) {
      unenrollments.push({ sequenceId, contactId });
      return { success: true };
    },
    async listSequences() {
      return { success: true, sequences: [] };
    },
    async createSequence(payload) {
      return { success: true, sequence: { id: 'seq-created', name: payload.name } };
    },
    async activateSequence(id) {
      return { success: true, sequence: { id, status: 'active' } };
    },
    async listAccounts() {
      return { success: true, accounts: [] };
    },
    async listWebhookSettings() {
      return { success: true, webhooks: [] };
    }
  };
}

function buildHarness(overrides) {
  const opts = overrides || {};
  const client = createFakeClient(opts.seed);
  const preferences = createContactPreferences({ client, logger: silentLogger, clock });
  const automation = createWhatsAppAutomation({
    client,
    preferences,
    logger: opts.logger || silentLogger,
    clock,
    approvalLookup: opts.approvalLookup,
    config: {
      enabled: true,
      accountId: 'acc-1',
      profileId: 'prof-1',
      confidenceThreshold: 0.6,
      promptTtlMs: 7 * 24 * 60 * 60 * 1000,
      sequenceIds: { en: 'seq-en', 'pt-BR': 'seq-pt' },
      ...(opts.config || {})
    }
  });
  return { client, preferences, automation };
}

let eventCounter = 0;
function inbound(overrides) {
  const opts = overrides || {};
  eventCounter += 1;
  const id = opts.id || `evt-${eventCounter}`;
  const contactId = opts.contactId || 'contact-1';
  const conversationId = opts.conversationId || 'conv-1';
  return {
    id,
    event: 'message.received',
    message: {
      id: `msg-${eventCounter}`,
      conversationId,
      platform: 'whatsapp',
      platformMessageId: `wamid.in.${eventCounter}`,
      direction: 'incoming',
      text: opts.text === undefined ? '' : opts.text,
      attachments: [],
      sender: {
        id: '5511999999999',
        contactId,
        name: opts.name || 'Ana'
      },
      sentAt: new Date(clockNow).toISOString(),
      isRead: false
    },
    conversation: { id: conversationId, contactId, participantId: '5511999999999' },
    account: { accountId: 'acc-1' },
    ...(opts.metadata ? { metadata: opts.metadata } : {})
  };
}

function lastReply(client) {
  return client.messages[client.messages.length - 1] || null;
}

// ---------------------------------------------------------------------------
// 1. Language registry and resolver
// ---------------------------------------------------------------------------

test('language registry: en and pt-BR active, es declared for the future', () => {
  assert.deepStrictEqual(ACTIVE_LANGUAGES, ['en', 'pt-BR']);
  assert.strictEqual(LANGUAGES.es.active, false);
  assert.strictEqual(LANGUAGES['pt-BR'].metaLocale, 'pt_BR');
  assert.strictEqual(toMetaLocale('pt-BR'), 'pt_BR');
  assert.strictEqual(normalizeLanguage('pt'), 'pt-BR');
  assert.strictEqual(normalizeLanguage('Portuguese'), 'pt-BR');
  assert.strictEqual(normalizeLanguage('english'), 'en');
  assert.strictEqual(normalizeLanguage('klingon'), null);
});

test('detection: Portuguese and English messages resolve with confidence', () => {
  const pt = detectLanguage('Olá, preciso de ajuda com o meu depósito');
  assert.strictEqual(pt.language, 'pt-BR');
  assert.strictEqual(pt.ambiguous, false);
  assert.ok(pt.confidence >= 0.6);

  const en = detectLanguage('Hello, I need help with my deposit and my account');
  assert.strictEqual(en.language, 'en');
  assert.strictEqual(en.ambiguous, false);
});

test('detection: short / content-free messages are ambiguous and never a language', () => {
  for (const text of ['yes', 'no', 'ok', 'OK', '👍', '🙂🙂', '12345', '1', '2', 'sim', 'não', 'thanks', '']) {
    const result = detectLanguage(text);
    assert.strictEqual(result.language, null, `expected no language for ${JSON.stringify(text)}`);
    assert.strictEqual(result.ambiguous, true, `expected ambiguous for ${JSON.stringify(text)}`);
  }
  assert.strictEqual(classifyContent('👍').contentFree, true);
  assert.strictEqual(classifyContent('ok').contentFree, true);
  assert.strictEqual(classifyContent('1234567890').contentFree, true);
  assert.strictEqual(classifyContent('Olá').contentFree, false);
});

test('detection: low-confidence mixed text is ambiguous, not guessed', () => {
  const result = detectLanguage('quero saber how much is the minimum');
  if (result.language) {
    assert.ok(result.confidence >= 0.6);
  } else {
    assert.strictEqual(result.ambiguous, true);
  }
});

test('resolver priority: explicit > persisted > detection > campaign > default', () => {
  const explicit = resolveLanguage({
    text: 'how much is the minimum deposit',
    explicitLanguage: 'pt-BR',
    persistedLanguage: 'en',
    campaignLanguage: 'en'
  });
  assert.strictEqual(explicit.language, 'pt-BR');
  assert.strictEqual(explicit.source, 'explicit');

  const persisted = resolveLanguage({
    text: 'how much is the minimum deposit',
    persistedLanguage: 'pt-BR',
    campaignLanguage: 'en'
  });
  assert.strictEqual(persisted.language, 'pt-BR');
  assert.strictEqual(persisted.source, 'persisted');

  const detected = resolveLanguage({
    text: 'Olá, preciso de ajuda com o meu depósito',
    campaignLanguage: 'en'
  });
  assert.strictEqual(detected.language, 'pt-BR');
  assert.strictEqual(detected.source, 'detected');

  const campaign = resolveLanguage({ text: 'ok', campaignLanguage: 'pt-BR' });
  assert.strictEqual(campaign.language, 'pt-BR');
  assert.strictEqual(campaign.source, 'campaign');

  const fallback = resolveLanguage({ text: 'ok' });
  assert.strictEqual(fallback.language, 'en');
  assert.strictEqual(fallback.source, 'default');
  assert.strictEqual(fallback.shouldAsk, true);
});

test('resolver: a stored preference is never replaced by a detection', () => {
  const result = resolveLanguage({
    text: 'Hello, I need help with my account',
    persistedLanguage: 'pt-BR'
  });
  assert.strictEqual(result.language, 'pt-BR');
  assert.strictEqual(result.source, 'persisted');
  assert.strictEqual(result.shouldAsk, false);
});

test('resolver: Spanish is recognised but not supported, so the customer is asked', () => {
  const result = resolveLanguage({ text: 'Hola, necesito ayuda con mi cuenta y mi depósito' });
  assert.strictEqual(result.unsupported, true);
  assert.strictEqual(result.shouldAsk, true);
  assert.strictEqual(result.language, 'en');
});

test('explicit language requests are recognised, mere mentions are not', () => {
  assert.strictEqual(matchExplicitLanguage('português'), 'pt-BR');
  assert.strictEqual(matchExplicitLanguage('Portuguese please'), 'pt-BR');
  assert.strictEqual(matchExplicitLanguage('quero falar em português'), 'pt-BR');
  assert.strictEqual(matchExplicitLanguage('english'), 'en');
  assert.strictEqual(matchExplicitLanguage('my friend speaks English'), null);
  assert.strictEqual(matchExplicitLanguage('the deposit is small'), null);
  assert.strictEqual(isLanguageMenuRequest('/language'), true);
  assert.strictEqual(isLanguageMenuRequest('idioma'), true);
  assert.strictEqual(isLanguageMenuRequest('change language'), true);
  assert.strictEqual(isLanguageMenuRequest('language of the site'), false);
});

// ---------------------------------------------------------------------------
// 2. Content and templates
// ---------------------------------------------------------------------------

test('content: every key exists and is non-empty in both languages', () => {
  const keys = Object.keys(CONTENT.en);
  for (const language of ACTIVE_LANGUAGES) {
    for (const key of keys) {
      assert.strictEqual(typeof CONTENT[language][key], 'string', `${language}.${key}`);
      assert.ok(CONTENT[language][key].trim().length > 0, `${language}.${key} is empty`);
    }
    assert.deepStrictEqual(Object.keys(CONTENT[language]).sort(), keys.slice().sort());
  }
});

test('content: business facts are preserved in both languages', () => {
  for (const language of ACTIVE_LANGUAGES) {
    const all = Object.keys(CONTENT[language]).map((key) => CONTENT[language][key]).join('\n');
    assert.match(all, /\$100/, `${language} must state the $100 minimum`);
    assert.match(all, /\$50/, `${language} must state the $50 promotional credit`);
    assert.match(all, /20%/, `${language} must state the 20% referral reward`);
    assert.match(all, /one-time|pagamento \u00fanico|\u00fanica/i, `${language} must say the reward is one-time`);
    assert.match(all, /risk|risco/i, `${language} must mention risk`);
    assert.match(all, /not guaranteed|n\u00e3o s\u00e3o garantidos|n\u00e3o garante/i, `${language} must deny guaranteed profits`);
    assert.match(all, /simulated|simulados/i, `${language} must say the demo uses simulated funds`);
    assert.match(all, /not limited to cryptocurrency|n\u00e3o se limita a criptomoedas/i, `${language} must say multi-asset`);
  }
});

test('content: the referral copy is one-time 20% of a qualifying initial deposit, never recurring', () => {
  assert.match(CONTENT.en.referral, /one-time 20% commission/);
  assert.match(CONTENT.en.referral, /initial deposit of at least \$100/);
  assert.match(CONTENT.en.referral, /no recurring/i);
  assert.match(CONTENT['pt-BR'].referral, /comiss\u00e3o \u00fanica de 20%/);
  assert.match(CONTENT['pt-BR'].referral, /primeiro dep\u00f3sito qualificado/);
  assert.match(CONTENT['pt-BR'].referral, /n\u00e3o existe comiss\u00e3o recorrente/);
});

test('content: no guaranteed-profit or risk-free claim in any language', () => {
  const forbidden = [
    /guaranteed profit/i,
    /risk[- ]free/i,
    /lucro garantido/i,
    /retorno garantido/i,
    /sem risco/i,
    /ganho garantido/i,
    /renda garantida/i
  ];
  for (const language of ACTIVE_LANGUAGES) {
    const all = Object.keys(CONTENT[language]).map((key) => CONTENT[language][key]).join('\n');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(all), `${language} must not contain ${pattern}`);
    }
  }
});

test('content: only the four official links are used', () => {
  const allowed = new Set(Object.values(LINKS));
  for (const language of ACTIVE_LANGUAGES) {
    const all = Object.keys(CONTENT[language]).map((key) => CONTENT[language][key]).join('\n');
    const found = all.match(/https?:\/\/\S+/g) || [];
    assert.ok(found.length > 0);
    for (const url of found) {
      const clean = url.replace(/[.,;:)]+$/, '');
      assert.ok(allowed.has(clean), `unexpected link ${clean} in ${language}`);
    }
  }
  assert.strictEqual(LINKS.signup, 'https://arbitrix.pro/signup?ref=ARBI-YE9TUN');
});

test('content: {{1}} placeholder parity in every templated message', () => {
  for (const key of ['welcome', 'followup_6h', 'followup_1d', 'followup_3d']) {
    assert.strictEqual((CONTENT.en[key].match(/\{\{1\}\}/g) || []).length, 1, `en.${key}`);
    assert.strictEqual((CONTENT['pt-BR'][key].match(/\{\{1\}\}/g) || []).length, 1, `pt-BR.${key}`);
  }
});

test('content: intent detection covers both languages', () => {
  assert.strictEqual(detectIntent('How do I deposit?'), 'deposit');
  assert.strictEqual(detectIntent('Como fa\u00e7o um dep\u00f3sito?'), 'deposit');
  assert.strictEqual(detectIntent('What is the referral commission?'), 'referral');
  assert.strictEqual(detectIntent('Qual \u00e9 a comiss\u00e3o de indica\u00e7\u00e3o?'), 'referral');
  assert.strictEqual(detectIntent('Is it guaranteed?'), 'risk');
  assert.strictEqual(detectIntent('Existe garantia?'), 'risk');
  assert.strictEqual(detectIntent('How do I sign up?'), 'registration');
  assert.strictEqual(detectIntent('Como fa\u00e7o o cadastro?'), 'registration');
  assert.strictEqual(detectIntent('Does demo mode use real money?'), 'demo');
  assert.strictEqual(detectIntent('O modo demo usa dinheiro real?'), 'demo');
  assert.strictEqual(detectIntent('Tell me about arbitrage'), 'trading');
  assert.strictEqual(detectIntent('Fale sobre arbitragem'), 'trading');
});

test('templates: English and pt-BR names follow the documented convention', () => {
  const welcome = TEMPLATE_DEFINITIONS.find((entry) => entry.key === 'welcome');
  assert.strictEqual(templateName(welcome, 'en'), 'arbitrix_welcome');
  assert.strictEqual(templateName(welcome, 'pt-BR'), 'arbitrix_welcome_pt_br');

  const sixHour = TEMPLATE_DEFINITIONS.find((entry) => entry.key === 'followup_6h');
  assert.strictEqual(templateName(sixHour, 'en'), 'arbitrix_followup_6h');
  assert.strictEqual(templateName(sixHour, 'pt-BR'), 'arbitrix_followup_6h_pt_br');

  const all = requiredTemplates('acc-1');
  assert.strictEqual(all.length, 8);
  assert.strictEqual(new Set(all.map((entry) => entry.name)).size, 8);
});

test('templates: bodies pass the local Meta validation', () => {
  for (const definition of TEMPLATE_DEFINITIONS) {
    for (const language of ACTIVE_LANGUAGES) {
      assert.deepStrictEqual(validateTemplateBody(definition, language), [], `${definition.key}/${language}`);
    }
  }
});

test('templates: payload uses the pt_BR Meta locale and a variable-free body', () => {
  const welcome = TEMPLATE_DEFINITIONS.find((entry) => entry.key === 'welcome');
  const payload = buildTemplatePayload(welcome, 'pt-BR', 'acc-1');
  assert.strictEqual(payload.language, 'pt_BR');
  assert.strictEqual(payload.category, 'MARKETING');
  assert.strictEqual(payload.name, 'arbitrix_welcome_pt_br');
  assert.strictEqual(payload.components.length, 1);
  assert.ok(!/\{\{/.test(payload.components[0].text));
  assert.match(payload.components[0].text, /Olá, tudo bem! Boas-vindas/);
  assert.strictEqual(payload.components[0].example, undefined);
});

test('templates: no approved template body contains a variable', () => {
  const { templateBody } = require('../services/whatsapp/WhatsAppTemplates');
  for (const definition of TEMPLATE_DEFINITIONS) {
    for (const language of ACTIVE_LANGUAGES) {
      const body = templateBody(definition, language);
      assert.ok(!/\{\{\s*\d+\s*\}\}/.test(body), `${definition.key}/${language}`);
    }
  }
});

test('templates: provisioning never duplicates an existing template', () => {
  const existing = [
    { name: 'arbitrix_welcome', language: 'en', status: 'APPROVED' },
    { name: 'arbitrix_welcome_pt_br', language: 'pt_BR', status: 'PENDING' }
  ];
  const plan = planProvisioning({ accountId: 'acc-1', existing });
  assert.ok(!plan.create.some((entry) => entry.name === 'arbitrix_welcome'));
  assert.ok(!plan.create.some((entry) => entry.name === 'arbitrix_welcome_pt_br'));
  assert.strictEqual(plan.create.length, 6);
  assert.strictEqual(plan.present.length, 2);

  const again = planProvisioning({ accountId: 'acc-1', existing: requiredTemplates('acc-1').map((entry) => ({
    name: entry.name,
    language: entry.metaLocale,
    status: 'APPROVED'
  })) });
  assert.strictEqual(again.create.length, 0);
  assert.strictEqual(again.present.length, 8);
});

test('templates: the approval gate refuses everything except APPROVED', () => {
  assert.strictEqual(isSendableTemplate({ status: 'APPROVED' }), true);
  for (const status of ['PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'UNKNOWN', '']) {
    assert.strictEqual(isSendableTemplate({ status }), false, status);
  }
  assert.strictEqual(isSendableTemplate(null), false);

  let thrown = null;
  try {
    assertSendableTemplate({ status: 'PENDING' }, 'arbitrix_welcome_pt_br');
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown);
  assert.strictEqual(thrown.code, 'TEMPLATE_NOT_APPROVED');
  assert.strictEqual(thrown.status, 'PENDING');
  assert.match(thrown.message, /not approved/);
});

test('templates: findTemplate matches on name and Meta locale', () => {
  const list = [{ name: 'arbitrix_welcome_pt_br', language: 'pt_BR', status: 'APPROVED' }];
  assert.ok(findTemplate(list, 'arbitrix_welcome_pt_br', 'pt-BR'));
  assert.strictEqual(findTemplate(list, 'arbitrix_welcome', 'pt-BR'), null);
});

// ---------------------------------------------------------------------------
// 3. Follow-up routing and timing
// ---------------------------------------------------------------------------

test('follow-ups: the original 6h / 1d / 3d intervals are preserved', () => {
  assert.deepStrictEqual(FOLLOW_UP_STAGES.map((entry) => entry.stage), ['6h', '1d', '3d']);
  assert.strictEqual(FOLLOW_UP_OFFSETS_MS['6h'], 6 * 60 * 60 * 1000);
  assert.strictEqual(FOLLOW_UP_OFFSETS_MS['1d'], 24 * 60 * 60 * 1000);
  assert.strictEqual(FOLLOW_UP_OFFSETS_MS['3d'], 72 * 60 * 60 * 1000);

  const spec = sequenceSpec({ language: 'pt-BR', profileId: 'prof-1', accountId: 'acc-1' });
  assert.strictEqual(spec.exitOnReply, true);
  assert.strictEqual(spec.exitOnUnsubscribe, true);
  assert.deepStrictEqual(spec.steps.map((step) => step.delayMinutes), [360, 1080, 2880]);
  assert.deepStrictEqual(spec.steps.map((step) => step.template.name), [
    'arbitrix_followup_6h_pt_br',
    'arbitrix_followup_1d_pt_br',
    'arbitrix_followup_3d_pt_br'
  ]);
  assert.deepStrictEqual(spec.steps.map((step) => step.template.language), ['pt_BR', 'pt_BR', 'pt_BR']);
  assert.strictEqual(sequenceNameFor('pt-BR'), 'arbitrix_followup_pt_br');
  assert.strictEqual(sequenceNameFor('en'), 'arbitrix_followup_en');
});

test('follow-ups: not due before the interval, due at and after it', () => {
  const enrolledAt = Date.parse('2026-06-01T00:00:00Z');
  const at = (hours) => enrolledAt + hours * 60 * 60 * 1000;

  assert.strictEqual(evaluateFollowUp({ stage: '6h', enrolledAt, now: at(5.99), language: 'en' }).reason, 'not_due');
  assert.strictEqual(evaluateFollowUp({ stage: '6h', enrolledAt, now: at(6), language: 'en' }).send, true);
  assert.strictEqual(evaluateFollowUp({ stage: '1d', enrolledAt, now: at(23.99), language: 'en' }).reason, 'not_due');
  assert.strictEqual(evaluateFollowUp({ stage: '1d', enrolledAt, now: at(24), language: 'en' }).send, true);
  assert.strictEqual(evaluateFollowUp({ stage: '3d', enrolledAt, now: at(71.99), language: 'en' }).reason, 'not_due');
  assert.strictEqual(evaluateFollowUp({ stage: '3d', enrolledAt, now: at(72), language: 'en' }).send, true);
  assert.strictEqual(evaluateFollowUp({ stage: 'nope', enrolledAt, now: at(100) }).reason, 'invalid_stage');
  assert.strictEqual(evaluateFollowUp({ stage: '6h', enrolledAt: null, now: at(100) }).reason, 'no_enrollment');
});

test('follow-ups: every disqualifying condition is honoured', () => {
  const enrolledAt = Date.parse('2026-06-01T00:00:00Z');
  const now = enrolledAt + 100 * 60 * 60 * 1000;
  const base = { stage: '6h', enrolledAt, now, language: 'pt-BR' };

  assert.strictEqual(evaluateFollowUp({ ...base, optedOut: true }).reason, 'opted_out');
  assert.strictEqual(evaluateFollowUp({ ...base, humanHandoff: true }).reason, 'human_handoff');
  assert.strictEqual(evaluateFollowUp({ ...base, registered: true }).reason, 'registered');
  assert.strictEqual(evaluateFollowUp({ ...base, deposited: true }).reason, 'deposited');
  assert.strictEqual(evaluateFollowUp({ ...base, lastInboundAt: enrolledAt + 1000 }).reason, 'replied');
  assert.strictEqual(evaluateFollowUp({ ...base, alreadySent: true }).reason, 'already_sent');
  assert.strictEqual(evaluateFollowUp({ ...base, followUps: { '6h': true } }).reason, 'already_sent');

  const due = evaluateFollowUp(base);
  assert.strictEqual(due.send, true);
  assert.strictEqual(due.templateName, 'arbitrix_followup_6h_pt_br');
});

test('follow-ups: template selection follows the contact language', () => {
  assert.strictEqual(templateNameFor('6h', 'en'), 'arbitrix_followup_6h');
  assert.strictEqual(templateNameFor('6h', 'pt-BR'), 'arbitrix_followup_6h_pt_br');
  assert.strictEqual(templateNameFor('1d', 'en'), 'arbitrix_followup_1d');
  assert.strictEqual(templateNameFor('1d', 'pt-BR'), 'arbitrix_followup_1d_pt_br');
  assert.strictEqual(templateNameFor('3d', 'en'), 'arbitrix_followup_3d');
  assert.strictEqual(templateNameFor('3d', 'pt-BR'), 'arbitrix_followup_3d_pt_br');
  assert.strictEqual(templateNameFor('nope', 'en'), null);
});

// ---------------------------------------------------------------------------
// 4. First-time and returning contacts
// ---------------------------------------------------------------------------

test('first contact in English receives the English welcome and is enrolled', async () => {
  const { client, automation } = buildHarness();
  const result = await automation.handleInbound(inbound({ text: 'Hello, I need help with my account' }));

  assert.strictEqual(result.action, 'welcomed');
  assert.strictEqual(result.language, 'en');
  const reply = lastReply(client);
  assert.match(reply.message, /welcome to Arbitrix/i);
  assert.match(reply.message, /\$100/);
  assert.match(reply.message, /simulated funds/);
  assert.match(reply.message, /not guaranteed/);
  assert.ok(!/Boas-vindas/.test(reply.message));

  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.language.slug], 'en');
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.languageSource.slug], 'detected');
  assert.deepStrictEqual(client.enrollments.map((entry) => entry.sequenceId), ['seq-en']);
});

test('first contact in Brazilian Portuguese receives the Portuguese welcome and is enrolled in the pt-BR sequence', async () => {
  const { client, automation } = buildHarness();
  const result = await automation.handleInbound(inbound({ text: 'Olá, preciso de ajuda com o meu depósito' }));

  assert.strictEqual(result.action, 'welcomed');
  assert.strictEqual(result.language, 'pt-BR');
  const reply = lastReply(client);
  assert.match(reply.message, /Boas-vindas à Arbitrix/);
  assert.match(reply.message, /fundos simulados/);
  assert.match(reply.message, /mínimo de \$100/);
  assert.match(reply.message, /lucros não são garantidos/);
  assert.ok(!/Welcome to Arbitrix/.test(reply.message));

  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.language.slug], 'pt-BR');
  assert.deepStrictEqual(client.enrollments.map((entry) => entry.sequenceId), ['seq-pt']);
});

test('returning English contact keeps receiving English', async () => {
  const { client, automation } = buildHarness({
    seed: {
      customFields: {
        [FIELDS.language.slug]: 'en',
        [FIELDS.languageSource.slug]: 'detected',
        [FIELDS.welcomed.slug]: true
      }
    }
  });
  const result = await automation.handleInbound(inbound({ text: 'How do I make a deposit?' }));
  assert.strictEqual(result.language, 'en');
  assert.strictEqual(result.intent, 'deposit');
  const reply = lastReply(client);
  assert.match(reply.message, /minimum deposit is \$100/);
  assert.ok(!/depósito mínimo/i.test(reply.message));
});

test('returning Portuguese contact keeps receiving Portuguese even on an English word', async () => {
  const { client, automation } = buildHarness({
    seed: {
      customFields: {
        [FIELDS.language.slug]: 'pt-BR',
        [FIELDS.languageSource.slug]: 'explicit',
        [FIELDS.languageConfirmed.slug]: true,
        [FIELDS.welcomed.slug]: true
      }
    }
  });
  const result = await automation.handleInbound(inbound({ text: 'deposit' }));
  assert.strictEqual(result.language, 'pt-BR');
  assert.strictEqual(result.source, 'persisted');
  const reply = lastReply(client);
  assert.match(reply.message, /depósito mínimo é de \$100/);
  assert.ok(!/minimum deposit is/i.test(reply.message));
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.language.slug], 'pt-BR');
});

// ---------------------------------------------------------------------------
// 5. Ambiguity, short replies and explicit changes
// ---------------------------------------------------------------------------

test('an ambiguous first contact is asked which language they prefer, before any long welcome', async () => {
  const { client, automation } = buildHarness();
  const result = await automation.handleInbound(inbound({ text: 'ok' }));

  assert.strictEqual(result.action, 'language_prompt');
  assert.strictEqual(client.messages.length, 1);
  const reply = lastReply(client);
  assert.match(reply.message, /English/);
  assert.match(reply.message, /português do Brasil/i);
  assert.match(reply.message, /1 - English/);
  assert.match(reply.message, /2 - Português \(Brasil\)/);
  assert.ok(!/Welcome to Arbitrix|Boas-vindas/.test(reply.message));
  assert.ok(client.contacts.get('contact-1').customFields[FIELDS.languagePromptAt.slug]);
  // The funnel is not lost while the customer decides: the fallback (English)
  // sequence is enrolled, and the preference itself is NOT written.
  assert.deepStrictEqual(client.enrollments.map((entry) => entry.sequenceId), ['seq-en']);
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.language.slug], undefined);
});

test('short replies never change a stored language', async () => {
  const { client, automation } = buildHarness({
    seed: {
      customFields: {
        [FIELDS.language.slug]: 'pt-BR',
        [FIELDS.welcomed.slug]: true
      }
    }
  });

  for (const text of ['yes', 'no', 'ok', '👍', '12345', 'thanks']) {
    const result = await automation.handleInbound(inbound({ text }));
    assert.strictEqual(result.language, 'pt-BR', `text ${text}`);
    assert.strictEqual(
      client.contacts.get('contact-1').customFields[FIELDS.language.slug],
      'pt-BR',
      `text ${text} must not change the stored language`
    );
  }
});

test('an explicit request switches the language and persists it as confirmed', async () => {
  const { client, automation } = buildHarness({
    seed: {
      customFields: {
        [FIELDS.language.slug]: 'en',
        [FIELDS.languageSource.slug]: 'detected',
        [FIELDS.welcomed.slug]: true,
        [FIELDS.sequenceLanguage.slug]: 'en'
      }
    }
  });
  const result = await automation.handleInbound(inbound({ text: 'quero falar em português' }));

  assert.strictEqual(result.action, 'language_selected');
  assert.strictEqual(result.language, 'pt-BR');
  const reply = lastReply(client);
  assert.match(reply.message, /vou continuar em português do Brasil/);

  const fields = client.contacts.get('contact-1').customFields;
  assert.strictEqual(fields[FIELDS.language.slug], 'pt-BR');
  assert.strictEqual(fields[FIELDS.languageSource.slug], 'explicit');
  assert.strictEqual(fields[FIELDS.languageConfirmed.slug], true);
  assert.ok(client.unenrollments.some((entry) => entry.sequenceId === 'seq-en'));
  assert.ok(client.enrollments.some((entry) => entry.sequenceId === 'seq-pt'));
});

test('replying "2" to the language question selects Portuguese', async () => {
  const { client, automation } = buildHarness();
  await automation.handleInbound(inbound({ text: 'ok' }));
  const result = await automation.handleInbound(inbound({ text: '2' }));

  assert.strictEqual(result.action, 'language_selected');
  assert.strictEqual(result.language, 'pt-BR');
  assert.match(lastReply(client).message, /Boas-vindas à Arbitrix/);
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.language.slug], 'pt-BR');
});

test('a bare "2" with no recent language question does not switch the language', async () => {
  const { client, automation } = buildHarness({
    seed: {
      customFields: {
        [FIELDS.language.slug]: 'en',
        [FIELDS.welcomed.slug]: true,
        [FIELDS.languagePromptAt.slug]: new Date(clockNow - 30 * 24 * 60 * 60 * 1000).toISOString()
      }
    }
  });
  const result = await automation.handleInbound(inbound({ text: '2' }));
  assert.strictEqual(result.language, 'en');
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.language.slug], 'en');
});

test('/language opens the language menu without changing the preference', async () => {
  const { client, automation } = buildHarness({
    seed: {
      customFields: {
        [FIELDS.language.slug]: 'pt-BR',
        [FIELDS.welcomed.slug]: true
      }
    }
  });
  const result = await automation.handleInbound(inbound({ text: '/language' }));
  assert.strictEqual(result.action, 'language_menu');
  assert.match(lastReply(client).message, /1 - English/);
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.language.slug], 'pt-BR');
});

test('an unsupported language request is answered in a supported language, not switched', async () => {
  const { client, automation } = buildHarness({
    seed: { customFields: { [FIELDS.language.slug]: 'en', [FIELDS.welcomed.slug]: true } }
  });
  const result = await automation.handleInbound(inbound({ text: 'quero falar em espanhol' }));
  assert.strictEqual(result.action, 'language_unsupported');
  assert.strictEqual(result.requested, 'es');
  assert.match(lastReply(client).message, /inglês ou em português/);
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.language.slug], 'en');
});

// ---------------------------------------------------------------------------
// 6. Opt-out, opt-in, human handoff
// ---------------------------------------------------------------------------

test('STOP unsubscribes, unenrolls and acknowledges in English', async () => {
  const { client, automation } = buildHarness({
    seed: { customFields: { [FIELDS.language.slug]: 'en', [FIELDS.welcomed.slug]: true } }
  });
  const result = await automation.handleInbound(inbound({ text: 'STOP' }));

  assert.strictEqual(result.action, 'opt_out');
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.optOut.slug], true);
  assert.strictEqual(client.contacts.get('contact-1').isSubscribed, false);
  assert.match(lastReply(client).message, /unsubscribed/);
  assert.ok(client.unenrollments.length >= 1);
});

test('a bare "cancelar" is not treated as an opt-out (it is ambiguous)', async () => {
  const { client, automation } = buildHarness({
    seed: { customFields: { [FIELDS.language.slug]: 'pt-BR', [FIELDS.welcomed.slug]: true } }
  });
  const result = await automation.handleInbound(inbound({ text: 'cancelar' }));
  assert.notStrictEqual(result.action, 'opt_out');
  assert.notStrictEqual(client.contacts.get('contact-1').customFields[FIELDS.optOut.slug], true);
});

test('"cancelar inscrição" does unsubscribe', async () => {
  const { client, automation } = buildHarness({
    seed: { customFields: { [FIELDS.language.slug]: 'pt-BR', [FIELDS.welcomed.slug]: true } }
  });
  const result = await automation.handleInbound(inbound({ text: 'cancelar inscrição' }));
  assert.strictEqual(result.action, 'opt_out');
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.optOut.slug], true);
});

test('PARAR unsubscribes and acknowledges in Portuguese', async () => {
  const { client, automation } = buildHarness({
    seed: { customFields: { [FIELDS.language.slug]: 'pt-BR', [FIELDS.welcomed.slug]: true } }
  });
  const result = await automation.handleInbound(inbound({ text: 'PARAR' }));

  assert.strictEqual(result.action, 'opt_out');
  assert.strictEqual(result.language, 'pt-BR');
  assert.match(lastReply(client).message, /descadastrado/);
});

test('after opt-out every follow-up stage is refused', async () => {
  const { automation } = buildHarness({
    seed: {
      customFields: {
        [FIELDS.language.slug]: 'pt-BR',
        [FIELDS.optOut.slug]: true
      }
    }
  });
  const enrolledAt = clockNow - 100 * 60 * 60 * 1000;
  for (const stage of ['6h', '1d', '3d']) {
    const decision = await automation.decideFollowUp({ contactId: 'contact-1', stage, enrolledAt });
    assert.strictEqual(decision.send, false);
    assert.strictEqual(decision.reason, 'opted_out');
  }
});

test('START opts back in', async () => {
  const { client, automation } = buildHarness({
    seed: {
      customFields: {
        [FIELDS.language.slug]: 'en',
        [FIELDS.optOut.slug]: true,
        [FIELDS.welcomed.slug]: true
      }
    }
  });
  const result = await automation.handleInbound(inbound({ text: 'START' }));
  assert.strictEqual(result.action, 'opt_in');
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.optOut.slug], false);
});

test('a human request pauses automation, unenrolls, and keeps the language', async () => {
  const { client, automation } = buildHarness({
    seed: { customFields: { [FIELDS.language.slug]: 'pt-BR', [FIELDS.welcomed.slug]: true } }
  });
  const result = await automation.handleInbound(inbound({ text: 'Quero falar com um atendente' }));

  assert.strictEqual(result.action, 'handoff');
  assert.strictEqual(result.language, 'pt-BR');
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.humanHandoff.slug], true);
  assert.match(lastReply(client).message, /equipe de suporte/);
  assert.ok(client.unenrollments.length >= 1);
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.language.slug], 'pt-BR');

  const decision = await automation.decideFollowUp({
    contactId: 'contact-1',
    stage: '6h',
    enrolledAt: clockNow - 100 * 60 * 60 * 1000
  });
  assert.strictEqual(decision.reason, 'human_handoff');
});

test('a human reply from the inbox (sentVia=human) pauses promotional messaging', async () => {
  const { client, automation } = buildHarness({
    seed: {
      customFields: {
        [FIELDS.language.slug]: 'en',
        [FIELDS.welcomed.slug]: true,
        [FIELDS.sequenceLanguage.slug]: 'en'
      }
    }
  });
  const result = await automation.handleSent({
    id: 'evt-human',
    event: 'message.sent',
    message: { sentVia: 'human', conversationId: 'conv-1' },
    conversation: { id: 'conv-1', contactId: 'contact-1' }
  });

  assert.strictEqual(result.action, 'handoff');
  assert.strictEqual(result.reason, 'human_reply');
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.humanHandoff.slug], true);
  assert.ok(client.unenrollments.some((entry) => entry.sequenceId === 'seq-en'));
});

test('control returning to the app resumes automation without losing the language', async () => {
  const { client, automation } = buildHarness({
    seed: {
      customFields: {
        [FIELDS.language.slug]: 'pt-BR',
        [FIELDS.humanHandoff.slug]: true
      }
    }
  });
  const result = await automation.handleControlChanged({
    control: { owner: 'app', previousOwner: 'other' },
    conversation: { contactId: 'contact-1' }
  });
  assert.strictEqual(result.action, 'resumed');
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.humanHandoff.slug], false);
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.language.slug], 'pt-BR');
});

// ---------------------------------------------------------------------------
// 7. Webhook: signature, dedupe, disable, retry
// ---------------------------------------------------------------------------

function signed(body, secret) {
  return crypto.createHmac('sha256', secret).update(Buffer.from(JSON.stringify(body), 'utf8')).digest('hex');
}

test('webhook: a valid signature processes exactly one reply', async () => {
  const { client, automation } = buildHarness();
  const body = inbound({ text: 'Hello, I need help with my account', id: 'evt-sig-1' });
  const secret = 'whsec_test';
  const handler = createZernioWebhookHandler({ automation, secret, enabled: true, logger: silentLogger });

  const result = await handler.handle({
    headers: {
      'x-zernio-signature': signed(body, secret),
      'x-zernio-event-id': body.id,
      'x-zernio-event': body.event
    },
    rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
    body
  });

  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.ok, true);
  assert.strictEqual(client.messages.length, 1);
});

test('webhook: a bad or missing signature is rejected before anything happens', async () => {
  const { client, automation } = buildHarness();
  const body = inbound({ text: 'Hello, I need help with my account' });
  const secret = 'whsec_test';
  const handler = createZernioWebhookHandler({ automation, secret, enabled: true, logger: silentLogger });

  const bad = await handler.handle({
    headers: { 'x-zernio-signature': 'a'.repeat(64) },
    rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
    body
  });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(bad.body.error, 'invalid_signature');

  const missing = await handler.handle({
    headers: { 'x-zernio-signature': '' },
    rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
    body
  });
  assert.strictEqual(missing.status, 401);
  assert.strictEqual(missing.body.reason, 'missing-signature');
  assert.strictEqual(client.messages.length, 0);
});

test('webhook: signature verification accepts the sha256= prefix and rejects malformed values', () => {
  const rawBody = Buffer.from('{"event":"message.received"}', 'utf8');
  const secret = 'whsec_test';
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  assert.strictEqual(verifySignature({ rawBody, signature: digest, secret }).ok, true);
  assert.strictEqual(verifySignature({ rawBody, signature: `sha256=${digest}`, secret }).ok, true);
  assert.strictEqual(verifySignature({ rawBody, signature: 'not-hex', secret }).ok, false);
  assert.strictEqual(verifySignature({ rawBody, signature: digest, secret: '' }).reason, 'not-configured');
  assert.strictEqual(verifySignature({ rawBody, signature: '', secret }).reason, 'missing-signature');
});

test('webhook: a duplicate event id produces no second reply', async () => {
  const { client, automation } = buildHarness();
  const body = inbound({ text: 'Hello, I need help with my account', id: 'evt-dup' });
  const secret = 'whsec_test';
  const handler = createZernioWebhookHandler({ automation, secret, enabled: true, logger: silentLogger });
  const request = {
    headers: {
      'x-zernio-signature': signed(body, secret),
      'x-zernio-event-id': body.id,
      'x-zernio-event': body.event
    },
    rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
    body
  };

  const first = await handler.handle(request);
  const second = await handler.handle(request);

  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.body.duplicate, true);
  assert.strictEqual(client.messages.length, 1);
});

test('webhook: a processing failure answers 500 and the retry is processed', async () => {
  const { client, automation } = buildHarness({ seed: { sendFailures: 1 } });
  const body = inbound({ text: 'Hello, I need help with my account', id: 'evt-retry' });
  const secret = 'whsec_test';
  const handler = createZernioWebhookHandler({ automation, secret, enabled: true, logger: silentLogger });
  const request = {
    headers: {
      'x-zernio-signature': signed(body, secret),
      'x-zernio-event-id': body.id,
      'x-zernio-event': body.event
    },
    rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
    body
  };

  const first = await handler.handle(request);
  assert.strictEqual(first.status, 500);
  assert.strictEqual(first.body.error, 'delivery_failed');
  assert.strictEqual(client.messages.length, 0);
  assert.strictEqual(handler.deduper.has(body.id), false);

  const retry = await handler.handle(request);
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(client.messages.length, 1);
});

test('webhook: a disabled automation answers 200 and sends nothing', async () => {
  const { client, automation } = buildHarness();
  const body = inbound({ text: 'Hello, I need help with my account' });
  const handler = createZernioWebhookHandler({
    automation,
    secret: 'whsec_test',
    enabled: false,
    logger: silentLogger
  });
  const result = await handler.handle({
    headers: { 'x-zernio-signature': signed(body, 'whsec_test') },
    rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
    body
  });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.skipped, 'disabled');
  assert.strictEqual(client.messages.length, 0);
});

test('webhook: an unconfigured secret fails closed with 503', async () => {
  const { automation } = buildHarness();
  const body = inbound({ text: 'Hello, I need help with my account' });
  const handler = createZernioWebhookHandler({ automation, secret: '', enabled: true, logger: silentLogger });
  const result = await handler.handle({
    headers: { 'x-zernio-signature': signed(body, 'anything') },
    rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
    body
  });
  assert.strictEqual(result.status, 503);
  assert.strictEqual(result.body.error, 'not_configured');
});

test('deduper is bounded and honours the TTL', () => {
  let now = 1000;
  const deduper = createEventDeduper({ ttlMs: 100, maxEntries: 2, clock: () => now });
  assert.strictEqual(deduper.reserve('a'), true);
  assert.strictEqual(deduper.reserve('a'), false);
  assert.strictEqual(deduper.reserve('b'), true);
  assert.strictEqual(deduper.reserve('c'), true);
  assert.ok(deduper.size() <= 2);
  now += 200;
  assert.strictEqual(deduper.reserve('a'), true);
});

// ---------------------------------------------------------------------------
// 8. Safety, secret handling and failure modes
// ---------------------------------------------------------------------------

test('the automation never contacts the network directly', async () => {
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('network must not be used in these tests');
  };
  try {
    const { automation } = buildHarness();
    await automation.handleInbound(inbound({ text: 'Olá, preciso de ajuda com o meu depósito' }));
    assert.strictEqual(called, false);
  } finally {
    global.fetch = realFetch;
  }
});

test('no log line contains the API key or the webhook secret', async () => {
  const lines = [];
  const logger = {
    log: (...args) => lines.push(JSON.stringify(args)),
    warn: (...args) => lines.push(JSON.stringify(args)),
    error: (...args) => lines.push(JSON.stringify(args)),
    info: (...args) => lines.push(JSON.stringify(args))
  };
  const { automation } = buildHarness({ logger, seed: { sendFailures: 1 } });
  await automation.handleInbound(inbound({ text: 'Hello, I need help with my account' }));

  const joined = lines.join('\n');
  assert.ok(!joined.includes('test_api_key_placeholder'));
  assert.ok(!joined.includes('whsec_test'));
});

test('a preference read failure still answers the customer in the fallback language', async () => {
  const client = createFakeClient();
  client.getContact = async () => {
    const error = new Error('supabase unavailable');
    error.code = 'network_error';
    throw error;
  };
  const preferences = createContactPreferences({ client, logger: silentLogger, clock });
  const automation = createWhatsAppAutomation({
    client,
    preferences,
    logger: silentLogger,
    clock,
    config: { enabled: true, accountId: 'acc-1', sequenceIds: { en: 'seq-en', 'pt-BR': 'seq-pt' } }
  });

  const result = await automation.handleInbound(inbound({ text: 'Olá, preciso de ajuda com o meu depósito' }));
  assert.ok(['welcomed', 'language_prompt', 'answered'].includes(result.action));
  assert.ok(client.messages.length >= 1);
});

test('a missing contact id still replies (persistence is best-effort)', async () => {
  const { client, automation } = buildHarness();
  const event = inbound({ text: 'Hello, I need help with my account' });
  event.message.sender.contactId = undefined;
  event.conversation.contactId = undefined;
  const result = await automation.handleInbound(event);
  assert.strictEqual(result.action, 'welcomed');
  assert.strictEqual(client.messages.length, 1);
});

test('standby updates (another app owns the thread) are ignored', async () => {
  const { client, automation } = buildHarness({
    seed: { customFields: { [FIELDS.language.slug]: 'en', [FIELDS.welcomed.slug]: true } }
  });
  const result = await automation.handleInbound(inbound({ text: 'Hello', metadata: { standby: true } }));
  assert.strictEqual(result.action, 'skipped');
  assert.strictEqual(result.reason, 'standby');
  assert.strictEqual(client.messages.length, 0);
});

test('non-WhatsApp and outgoing events are ignored', async () => {
  const { automation } = buildHarness();
  const instagram = inbound({ text: 'Hello' });
  instagram.message.platform = 'instagram';
  assert.strictEqual((await automation.handleInbound(instagram)).reason, 'not-whatsapp');

  const outgoing = inbound({ text: 'Hello' });
  outgoing.message.direction = 'outgoing';
  assert.strictEqual((await automation.handleInbound(outgoing)).reason, 'not-incoming');
});

test('fillName substitutes {{1}} and falls back per locale', () => {
  assert.strictEqual(fillName('Hi {{1}}!', 'Ana', 'en'), 'Hi Ana!');
  assert.strictEqual(fillName('Olá, {{1}}!', 'Ana', 'pt-BR'), 'Olá, Ana!');
  assert.strictEqual(fillName('Hi {{1}}!', '', 'en'), 'Hi there!');
  assert.strictEqual(fillName('Olá, {{1}}!', '   ', 'pt-BR'), 'Olá, tudo bem!');
  assert.strictEqual(fillName('Hi {{1}}!', 'a\nb', 'en'), 'Hi a b!');
});

test('numeric selection only maps 1 and 2', () => {
  assert.strictEqual(matchNumericSelection('1'), 'en');
  assert.strictEqual(matchNumericSelection('2'), 'pt-BR');
  assert.strictEqual(matchNumericSelection(' 2. '), 'pt-BR');
  assert.strictEqual(matchNumericSelection('3'), null);
  assert.strictEqual(matchNumericSelection('yes'), null);
});

// ---------------------------------------------------------------------------
// 9. Integration factory and status description
// ---------------------------------------------------------------------------

test('the integration factory is optional and never crashes the server', () => {
  const saved = process.env.ZERNIO_API_KEY;
  delete process.env.ZERNIO_API_KEY;
  try {
    assert.strictEqual(createWhatsAppIntegrationSafely({ logger: silentLogger }), null);
  } finally {
    if (saved === undefined) delete process.env.ZERNIO_API_KEY;
    else process.env.ZERNIO_API_KEY = saved;
  }
});

test('the integration factory builds a client and description without leaking the key', () => {
  const recorder = createFetchRecorder();
  const integration = createWhatsAppIntegrationSafely({
    apiKey: 'test_api_key_placeholder',
    webhookSecret: 'whsec_test',
    fetchImpl: recorder.fetchImpl,
    logger: silentLogger,
    config: { enabled: true, accountId: 'acc-1', profileId: 'prof-1', sequenceIds: { en: 'seq-en' } }
  });
  assert.ok(integration);

  const description = integration.describe();
  const serialized = JSON.stringify(description);
  assert.ok(!serialized.includes('test_api_key_placeholder'));
  assert.ok(!serialized.includes('whsec_test'));
  assert.strictEqual(description.apiKeyConfigured, true);
  assert.strictEqual(description.webhookSecretConfigured, true);
  assert.deepStrictEqual(description.languages.map((entry) => entry.code), ['en', 'pt-BR']);
});

test('the status description is secret-free even when nothing is configured', () => {
  const saved = { ...process.env };
  delete process.env.ZERNIO_API_KEY;
  delete process.env.ZERNIO_WEBHOOK_SECRET;
  try {
    const description = describeWhatsAppConfig();
    assert.strictEqual(description.apiKeyConfigured, false);
    assert.strictEqual(description.webhookSecretConfigured, false);
    assert.deepStrictEqual(description.languages.map((entry) => entry.code), ['en', 'pt-BR']);
    assert.strictEqual(description.followUps.length, 3);
  } finally {
    process.env = saved;
  }
});

test('the Zernio client refuses to build without an API key', () => {
  const { createZernioClient } = require('../services/whatsapp/ZernioClient');
  assert.throws(() => createZernioClient({ apiKey: '', fetchImpl: async () => ({}) }), /ZERNIO_API_KEY/);
});

test('the Zernio client sends the bearer token and never retries a plain POST', async () => {
  const { createZernioClient } = require('../services/whatsapp/ZernioClient');
  const recorder = createFetchRecorder();
  const client = createZernioClient({
    apiKey: 'test_api_key_placeholder',
    fetchImpl: recorder.fetchImpl,
    maxRetries: 2,
    baseUrl: 'https://zernio.com/api'
  });
  await client.getContact('contact-1');
  const call = recorder.calls[0];
  assert.strictEqual(call.url, 'https://zernio.com/api/v1/contacts/contact-1');
  assert.strictEqual(call.options.headers.Authorization, 'Bearer test_api_key_placeholder');
});

// ---------------------------------------------------------------------------
// 10. Follow-up decisions through the automation (end-to-end prefs)
// ---------------------------------------------------------------------------

test('decideFollowUp reads the stored language and template approval', async () => {
  const { automation } = buildHarness({
    seed: {
      customFields: {
        [FIELDS.language.slug]: 'pt-BR',
        [FIELDS.followup6h.slug]: false
      }
    },
    approvalLookup: async (name, locale) => name === 'arbitrix_followup_6h_pt_br' && locale === 'pt_BR'
  });

  const due = await automation.decideFollowUp({
    contactId: 'contact-1',
    stage: '6h',
    enrolledAt: clockNow - 7 * 60 * 60 * 1000
  });
  assert.strictEqual(due.send, true);
  assert.strictEqual(due.language, 'pt-BR');
  assert.strictEqual(due.templateName, 'arbitrix_followup_6h_pt_br');
  assert.strictEqual(due.approved, true);

  const notApproved = await automation.decideFollowUp({
    contactId: 'contact-1',
    stage: '1d',
    enrolledAt: clockNow - 30 * 60 * 60 * 1000
  });
  assert.strictEqual(notApproved.approved, false);
});

test('decideFollowUp refuses after registration or deposit', async () => {
  const enrolledAt = clockNow - 100 * 60 * 60 * 1000;

  const registered = buildHarness({
    seed: { customFields: { [FIELDS.language.slug]: 'en', [FIELDS.registered.slug]: true } }
  });
  assert.strictEqual(
    (await registered.automation.decideFollowUp({ contactId: 'contact-1', stage: '3d', enrolledAt })).reason,
    'registered'
  );

  const deposited = buildHarness({
    seed: { customFields: { [FIELDS.language.slug]: 'en', [FIELDS.deposited.slug]: true } }
  });
  assert.strictEqual(
    (await deposited.automation.decideFollowUp({ contactId: 'contact-1', stage: '3d', enrolledAt })).reason,
    'deposited'
  );
});

test('a registration field change unenrolls the contact', async () => {
  const { client, automation } = buildHarness({
    seed: {
      customFields: {
        [FIELDS.language.slug]: 'en',
        [FIELDS.sequenceLanguage.slug]: 'en'
      }
    }
  });
  const result = await automation.handleFieldChanged({
    contactId: 'contact-1',
    field: 'arbitrix_registered',
    value: true
  });
  assert.strictEqual(result.action, 'unenrolled');
  assert.ok(client.unenrollments.some((entry) => entry.sequenceId === 'seq-en'));
});

// ---------------------------------------------------------------------------
// 11. Continuity across a process restart
// ---------------------------------------------------------------------------

test('the persisted preference survives a new automation instance', async () => {
  const client = createFakeClient();
  const firstPreferences = createContactPreferences({ client, logger: silentLogger, clock });
  const first = createWhatsAppAutomation({
    client,
    preferences: firstPreferences,
    logger: silentLogger,
    clock,
    config: { enabled: true, accountId: 'acc-1', sequenceIds: { en: 'seq-en', 'pt-BR': 'seq-pt' } }
  });
  await first.handleInbound(inbound({ text: 'Olá, preciso de ajuda com o meu depósito' }));
  assert.strictEqual(client.contacts.get('contact-1').customFields[FIELDS.language.slug], 'pt-BR');

  // New process: new cache, same contact record.
  const secondPreferences = createContactPreferences({ client, logger: silentLogger, clock });
  const second = createWhatsAppAutomation({
    client,
    preferences: secondPreferences,
    logger: silentLogger,
    clock,
    config: { enabled: true, accountId: 'acc-1', sequenceIds: { en: 'seq-en', 'pt-BR': 'seq-pt' } }
  });
  const reply = await second.handleInbound(inbound({ text: 'How do I deposit?' }));
  assert.strictEqual(reply.language, 'pt-BR');
  assert.match(lastReply(client).message, /depósito mínimo é de \$100/);
});
