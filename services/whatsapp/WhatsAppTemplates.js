'use strict';

/**
 * WhatsApp template catalogue, provisioning plan and approval gate.
 *
 * WHY A CATALOGUE AND NOT FREE STRINGS
 * A business-initiated WhatsApp message is only allowed with a Meta-approved
 * template. The template body and the in-window text therefore come from the
 * same source (WhatsAppContent), and every template send goes through
 * `assertSendableTemplate()` so an unapproved (PENDING / REJECTED / PAUSED)
 * template can never be sent.
 *
 * NAMING
 *   English:  arbitrix_welcome, arbitrix_followup_6h, arbitrix_followup_1d,
 *             arbitrix_followup_3d
 *   pt-BR:    the same names with the `_pt_br` suffix, which is also the
 *             Meta locale convention (language: "pt_BR").
 * The suffix comes from Languages.templateSuffix, so adding Spanish produces
 * `_es` names and `es_ES` locales with no edit here.
 *
 * IDEMPOTENCY
 * `planProvisioning()` compares against the templates Meta already has, keyed by
 * (name, language). Re-running the setup script creates nothing twice and never
 * deletes or edits an existing approved template.
 */

const { LANGUAGES, toMetaLocale, isActiveLanguage } = require('./Languages');
const { contentFor, replyText } = require('./WhatsAppContent');

const TEMPLATE_CATEGORY = 'MARKETING';
const MAX_BODY_LENGTH = 1024;
const APPROVED = 'APPROVED';

const TEMPLATE_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: 'welcome',
    baseName: 'arbitrix_welcome',
    contentKey: 'welcome',
    category: TEMPLATE_CATEGORY,
    description: 'Immediate welcome after the first inbound WhatsApp message.'
  }),
  Object.freeze({
    key: 'followup_6h',
    baseName: 'arbitrix_followup_6h',
    contentKey: 'followup_6h',
    category: TEMPLATE_CATEGORY,
    description: 'Six-hour follow-up.'
  }),
  Object.freeze({
    key: 'followup_1d',
    baseName: 'arbitrix_followup_1d',
    contentKey: 'followup_1d',
    category: TEMPLATE_CATEGORY,
    description: 'One-day follow-up.'
  }),
  Object.freeze({
    key: 'followup_3d',
    baseName: 'arbitrix_followup_3d',
    contentKey: 'followup_3d',
    category: TEMPLATE_CATEGORY,
    description: 'Three-day follow-up (referral introduction).'
  })
]);

function suffixFor(language) {
  const meta = LANGUAGES[language];
  return meta ? meta.templateSuffix : LANGUAGES.en.templateSuffix;
}

function templateName(definition, language) {
  const suffix = suffixFor(language);
  return suffix === 'en' ? definition.baseName : `${definition.baseName}_${suffix}`;
}

/**
 * Approved narrative templates carry NO variables. The personalised greeting
 * (`{{1}}`) is used only for the free-form reply inside the 24-hour window, so
 * a template has no `{{1}}` to map and `variableMapping` can never be wrong.
 * The placeholder is replaced with the locale's generic form ("there" /
 * "tudo bem"), which reads naturally in every sentence in the catalogue.
 */
function templateBody(definition, language) {
  const body = contentFor(language)[definition.contentKey];
  return String(body).replace(/\{\{1\}\}/g, replyText(language, 'nameFallback') || 'there');
}

function countVariables(body) {
  const matches = String(body || '').match(/\{\{\s*\d+\s*\}\}/g);
  return matches ? matches.length : 0;
}

/**
 * Validate a body against the Meta rules this integration depends on. Returning
 * a list (instead of throwing) lets the setup script report every problem at
 * once before submitting anything.
 */
function validateTemplateBody(def, language) {
  const body = templateBody(def, language);
  const problems = [];
  if (!body || !body.trim()) problems.push('body is empty');
  if (body !== body.trim()) problems.push('body has leading or trailing whitespace');
  if (body.length > MAX_BODY_LENGTH) problems.push(`body exceeds ${MAX_BODY_LENGTH} characters`);
  if (countVariables(body) !== 0) problems.push('template bodies must not contain variables');
  return problems;
}

function buildTemplatePayload(definition, language, accountId) {
  if (!isActiveLanguage(language)) {
    throw new Error(`Unsupported template language: ${language}`);
  }
  const problems = validateTemplateBody(definition, language);
  if (problems.length) {
    throw new Error(`Invalid ${definition.baseName} (${language}) body: ${problems.join('; ')}`);
  }
  const name = templateName(definition, language);
  return {
    accountId,
    name,
    category: definition.category,
    language: toMetaLocale(language),
    components: [
      {
        type: 'body',
        text: templateBody(definition, language)
      }
    ]
  };
}

/**
 * All templates the integration needs, for every active language.
 */
function requiredTemplates(accountId) {
  const list = [];
  for (const language of Object.keys(LANGUAGES).filter((code) => LANGUAGES[code].active)) {
    for (const definition of TEMPLATE_DEFINITIONS) {
      list.push({
        definition,
        language,
        name: templateName(definition, language),
        metaLocale: toMetaLocale(language),
        payload: buildTemplatePayload(definition, language, accountId)
      });
    }
  }
  return list;
}

function keyOf(name, language) {
  return `${String(name || '').toLowerCase()}::${String(language || '').toLowerCase()}`;
}

/**
 * Compare the required catalogue with what already exists.
 * `existing` is the array returned by GET /v1/whatsapp/templates.
 */
function planProvisioning({ accountId, existing }) {
  const existingList = Array.isArray(existing) ? existing : [];
  const index = new Map();
  for (const template of existingList) {
    if (!template || !template.name) continue;
    index.set(keyOf(template.name, template.language), template);
  }

  const create = [];
  const present = [];
  for (const required of requiredTemplates(accountId)) {
    const found = index.get(keyOf(required.name, required.metaLocale));
    if (found) {
      present.push({ ...required, existing: found, status: found.status || 'UNKNOWN' });
    } else {
      create.push(required);
    }
  }
  return { create, present };
}

/**
 * THE APPROVAL GATE. Callers must not send a template unless this returns true.
 */
function isSendableTemplate(template) {
  return Boolean(template) && String(template.status || '').toUpperCase() === APPROVED;
}

function assertSendableTemplate(template, name) {
  if (!isSendableTemplate(template)) {
    const status = template ? template.status : 'MISSING';
    const error = new Error(`Template ${name} is not approved (status: ${status})`);
    error.code = 'TEMPLATE_NOT_APPROVED';
    error.status = status;
    throw error;
  }
  return true;
}

/**
 * Find a template by name + Meta locale in a list from the API.
 */
function findTemplate(list, name, language) {
  const locale = toMetaLocale(language);
  const target = keyOf(name, locale);
  return (Array.isArray(list) ? list : []).find((item) => {
    if (!item || !item.name) return false;
    return keyOf(item.name, item.language) === target;
  }) || null;
}

module.exports = {
  TEMPLATE_CATEGORY,
  TEMPLATE_DEFINITIONS,
  MAX_BODY_LENGTH,
  APPROVED,
  templateName,
  templateBody,
  validateTemplateBody,
  buildTemplatePayload,
  requiredTemplates,
  planProvisioning,
  isSendableTemplate,
  assertSendableTemplate,
  findTemplate,
  countVariables
};
