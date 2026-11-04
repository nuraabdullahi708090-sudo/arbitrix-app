'use strict';

/**
 * Follow-up routing.
 *
 * The existing funnel times are PRESERVED: 6 hours, 1 day and 3 days after the
 * first inbound contact. Nothing here changes them; the module exists so the
 * decision to send (and which language to send) is explicit, testable and
 * independent of the transport.
 *
 * TWO DELIVERY MODES
 *   'sequence' (default) - Zernio sequences own the schedule. `sequenceSpec()`
 *     creates one sequence per language with `exitOnReply` and
 *     `exitOnUnsubscribe` enabled, which covers "did the contact reply?" and
 *     "did the contact opt out?" inside Zernio. The app unenrolls on a human
 *     handoff, registration or deposit.
 *   'api' - the caller sweeps with `evaluateFollowUp()` and sends an approved
 *     template. This is what the tests exercise and what the optional
 *     `POST /api/whatsapp/followups/evaluate` admin endpoint reports.
 *
 * DELAY SEMANTICS (must be confirmed once against the live Zernio account):
 * `delayMinutes` in a Zernio sequence is the delay AFTER the previous step, so
 * the three steps are 360 / 1080 / 2880 minutes from the previous one, which
 * resolves to 360 / 1440 / 4320 minutes (6h / 24h / 72h) from enrollment. The
 * absolute offsets are also exposed as `dueOffsetMinutes` so an operator can
 * verify the resolved schedule from the setup script without guessing.
 */

const { toMetaLocale } = require('./Languages');
const { TEMPLATE_DEFINITIONS, templateName } = require('./WhatsAppTemplates');

const HOUR_MS = 60 * 60 * 1000;

const FOLLOW_UP_STAGES = Object.freeze([
  Object.freeze({
    stage: '6h',
    contentKey: 'followup_6h',
    templateKey: 'followup_6h',
    dueOffsetMinutes: 6 * 60,
    delayMinutesFromPrevious: 6 * 60
  }),
  Object.freeze({
    stage: '1d',
    contentKey: 'followup_1d',
    templateKey: 'followup_1d',
    dueOffsetMinutes: 24 * 60,
    delayMinutesFromPrevious: 24 * 60 - 6 * 60
  }),
  Object.freeze({
    stage: '3d',
    contentKey: 'followup_3d',
    templateKey: 'followup_3d',
    dueOffsetMinutes: 72 * 60,
    delayMinutesFromPrevious: 72 * 60 - 24 * 60
  })
]);

function stageDefinition(stage) {
  return FOLLOW_UP_STAGES.find((entry) => entry.stage === stage) || null;
}

function templateDefinitionForStage(stage) {
  const definition = stageDefinition(stage);
  if (!definition) return null;
  return TEMPLATE_DEFINITIONS.find((entry) => entry.key === definition.templateKey) || null;
}

/**
 * Name of the approved template for a stage and language, e.g.
 * arbitrix_followup_6h_pt_br.
 */
function templateNameFor(stage, language) {
  const definition = templateDefinitionForStage(stage);
  if (!definition) return null;
  return templateName(definition, language);
}

function sequenceNameFor(language) {
  const suffix = language === 'en' ? 'en' : String(language || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `arbitrix_followup_${suffix}`;
}

/**
 * The Zernio sequence definition for one language.
 */
function sequenceSpec({ language, profileId, accountId }) {
  if (!language || !profileId || !accountId) {
    throw new Error('sequenceSpec requires language, profileId and accountId');
  }
  const metaLocale = toMetaLocale(language);
  return {
    profileId,
    accountId,
    platform: 'whatsapp',
    name: sequenceNameFor(language),
    description: `Arbitrix ${language} follow-ups: 6 hours, 1 day and 3 days after first contact.`,
    exitOnReply: true,
    exitOnUnsubscribe: true,
    steps: FOLLOW_UP_STAGES.map((entry, index) => ({
      order: index + 1,
      delayMinutes: entry.delayMinutesFromPrevious,
      template: {
        name: templateNameFor(entry.stage, language),
        language: metaLocale
      }
    }))
  };
}

/**
 * Decide whether one follow-up step may be sent.
 *
 * Every guard is explicit and ordered so the reason recorded in logs is the
 * first real blocker, not an arbitrary one.
 */
function evaluateFollowUp(input) {
  const options = input || {};
  const definition = stageDefinition(options.stage);
  if (!definition) {
    return { send: false, reason: 'invalid_stage', stage: options.stage || null };
  }

  const now = Number(options.now === undefined ? Date.now() : options.now);
  const enrolledAt = options.enrolledAt === undefined || options.enrolledAt === null
    ? null
    : Number(options.enrolledAt);

  const base = {
    stage: definition.stage,
    language: options.language || null,
    templateName: options.language ? templateNameFor(definition.stage, options.language) : null
  };

  if (options.optedOut) return { ...base, send: false, reason: 'opted_out' };
  if (options.humanHandoff) return { ...base, send: false, reason: 'human_handoff' };
  if (options.registered) return { ...base, send: false, reason: 'registered' };
  if (options.deposited) return { ...base, send: false, reason: 'deposited' };

  if (options.lastInboundAt !== undefined && options.lastInboundAt !== null && enrolledAt !== null) {
    if (Number(options.lastInboundAt) > enrolledAt) {
      return { ...base, send: false, reason: 'replied' };
    }
  }

  const alreadySent = Boolean(
    options.alreadySent === true ||
    (options.followUps && options.followUps[definition.stage])
  );
  if (alreadySent) return { ...base, send: false, reason: 'already_sent' };

  if (enrolledAt === null || !Number.isFinite(enrolledAt)) {
    return { ...base, send: false, reason: 'no_enrollment' };
  }

  const dueAt = enrolledAt + definition.dueOffsetMinutes * 60 * 1000;
  if (now < dueAt) {
    return { ...base, send: false, reason: 'not_due', dueAt };
  }

  return { ...base, send: true, reason: 'due', dueAt };
}

/**
 * Fixed offsets in milliseconds, exposed for tests and reporting.
 */
const FOLLOW_UP_OFFSETS_MS = Object.freeze(
  FOLLOW_UP_STAGES.reduce((accumulator, entry) => {
    accumulator[entry.stage] = entry.dueOffsetMinutes * 60 * 1000;
    return accumulator;
  }, {})
);

module.exports = {
  HOUR_MS,
  FOLLOW_UP_STAGES,
  FOLLOW_UP_OFFSETS_MS,
  stageDefinition,
  templateNameFor,
  sequenceNameFor,
  sequenceSpec,
  evaluateFollowUp
};
