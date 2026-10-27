'use strict';

/**
 * Localized copy for CONVERSION notifications (en / pt / ar).
 *
 * Scope: the three messages the Phase 2 conversion automation can send to a
 * LINKED Telegram chat -
 *   * depositConfirmed       transactional, private chat only
 *   * referralQualified      transactional, private chat only
 *   * pendingReminder        promotional (opt-in), opt-out line included
 *
 * RULES BAKED INTO THIS FILE (from the Phase 2 brief)
 *   - Truthful and neutral. No profit promises, no "guaranteed returns", no
 *     claim that a deposit is an investment or that it earns anything.
 *   - A deposit is only ever described as CONFIRMED when the authoritative
 *     credit marker exists; a pending deposit is never described as paid.
 *   - The referral message quotes NO reward amount and does not claim a payment
 *     has landed: the two qualification paths (SQL, which credits inside the
 *     same transaction, and the legacy JS path, which credits in a second call)
 *     cannot both be described as "paid" truthfully from one template. It
 *     points the user at the Referral section instead.
 *   - No credentials, no payment data (address / tx hash), no email address and
 *     no balance are ever part of a message.
 *   - Every PROMOTIONAL message carries an explicit `/unsubscribe` instruction.
 *
 * Localization: pt is Brazilian Portuguese, ar is Modern Standard Arabic. Every
 * locale defines the SAME key set (pinned by tests); a missing key falls back to
 * English per key, and an unsupported language resolves to English.
 */

const { DEFAULT_LANGUAGE, normalizeLanguage } = require('./telegram-i18n');

const CONVERSION_STRINGS = Object.freeze({
  en: Object.freeze({
    depositConfirmed:
      '\u2705 Deposit confirmed\n\n'
      + 'We received your deposit of {{amount}} and it has been added to your Arbitrix Live balance.\n\n'
      + 'You can see the details in the Transactions section of your dashboard.',
    depositConfirmedNoAmount:
      '\u2705 Deposit confirmed\n\n'
      + 'We received your deposit and it has been added to your Arbitrix Live balance.\n\n'
      + 'You can see the details in the Transactions section of your dashboard.',
    referralQualified:
      '\uD83C\uDF89 Referral qualified\n\n'
      + 'A user you referred has made their first qualifying deposit.\n\n'
      + 'Your referral reward is being applied. You can check the Referral section of your Arbitrix dashboard for the details.',
    pendingReminder:
      '\u23F3 Deposit still pending\n\n'
      + 'We have not yet received your deposit of {{amount}}. If you have already sent it, please allow a little time for network confirmation.\n\n'
      + 'You can check the status in your Arbitrix dashboard.\n\n'
      + 'To stop these reminders, send /unsubscribe.',
    pendingReminderNoAmount:
      '\u23F3 Deposit still pending\n\n'
      + 'We have not yet received your deposit. If you have already sent it, please allow a little time for network confirmation.\n\n'
      + 'You can check the status in your Arbitrix dashboard.\n\n'
      + 'To stop these reminders, send /unsubscribe.'
  }),
  pt: Object.freeze({
    depositConfirmed:
      '\u2705 Dep\u00f3sito confirmado\n\n'
      + 'Recebemos o seu dep\u00f3sito de {{amount}} e ele foi adicionado ao seu saldo Live na Arbitrix.\n\n'
      + 'Voc\u00ea pode ver os detalhes na se\u00e7\u00e3o Transa\u00e7\u00f5es do seu painel.',
    depositConfirmedNoAmount:
      '\u2705 Dep\u00f3sito confirmado\n\n'
      + 'Recebemos o seu dep\u00f3sito e ele foi adicionado ao seu saldo Live na Arbitrix.\n\n'
      + 'Voc\u00ea pode ver os detalhes na se\u00e7\u00e3o Transa\u00e7\u00f5es do seu painel.',
    referralQualified:
      '\uD83C\uDF89 Indica\u00e7\u00e3o qualificada\n\n'
      + 'Um usu\u00e1rio que voc\u00ea indicou fez o primeiro dep\u00f3sito qualificativo.\n\n'
      + 'Sua recompensa de indica\u00e7\u00e3o est\u00e1 sendo aplicada. Consulte a se\u00e7\u00e3o Indica\u00e7\u00f5es do seu painel da Arbitrix para ver os detalhes.',
    pendingReminder:
      '\u23F3 Dep\u00f3sito ainda pendente\n\n'
      + 'Ainda n\u00e3o recebemos o seu dep\u00f3sito de {{amount}}. Se j\u00e1 o enviou, aguarde um pouco pela confirma\u00e7\u00e3o da rede.\n\n'
      + 'Voc\u00ea pode verificar a situa\u00e7\u00e3o no seu painel da Arbitrix.\n\n'
      + 'Para n\u00e3o receber estes lembretes, envie /unsubscribe.',
    pendingReminderNoAmount:
      '\u23F3 Dep\u00f3sito ainda pendente\n\n'
      + 'Ainda n\u00e3o recebemos o seu dep\u00f3sito. Se j\u00e1 o enviou, aguarde um pouco pela confirma\u00e7\u00e3o da rede.\n\n'
      + 'Voc\u00ea pode verificar a situa\u00e7\u00e3o no seu painel da Arbitrix.\n\n'
      + 'Para n\u00e3o receber estes lembretes, envie /unsubscribe.'
  }),
  ar: Object.freeze({
    depositConfirmed:
      '\u2705 \u062a\u0645 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0625\u064a\u062f\u0627\u0639\n\n'
      + '\u062a\u0644\u0642\u064a\u0646\u0627 \u0625\u064a\u062f\u0627\u0639\u0643 \u0628\u0642\u064a\u0645\u0629 {{amount}} \u0648\u062a\u0645\u062a \u0625\u0636\u0627\u0641\u062a\u0647 \u0625\u0644\u0649 \u0631\u0635\u064a\u062f Live \u0641\u064a Arbitrix.\n\n'
      + '\u064a\u0645\u0643\u0646\u0643 \u0627\u0644\u0627\u0637\u0644\u0627\u0639 \u0639\u0644\u0649 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0641\u064a \u0642\u0633\u0645 \u0627\u0644\u0645\u0639\u0627\u0645\u0644\u0627\u062a \u062f\u0627\u062e\u0644 \u0644\u0648\u062d\u0629 \u0627\u0644\u062a\u062d\u0643\u0645.',
    depositConfirmedNoAmount:
      '\u2705 \u062a\u0645 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0625\u064a\u062f\u0627\u0639\n\n'
      + '\u062a\u0644\u0642\u064a\u0646\u0627 \u0625\u064a\u062f\u0627\u0639\u0643 \u0648\u062a\u0645\u062a \u0625\u0636\u0627\u0641\u062a\u0647 \u0625\u0644\u0649 \u0631\u0635\u064a\u062f Live \u0641\u064a Arbitrix.\n\n'
      + '\u064a\u0645\u0643\u0646\u0643 \u0627\u0644\u0627\u0637\u0644\u0627\u0639 \u0639\u0644\u0649 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0641\u064a \u0642\u0633\u0645 \u0627\u0644\u0645\u0639\u0627\u0645\u0644\u0627\u062a \u062f\u0627\u062e\u0644 \u0644\u0648\u062d\u0629 \u0627\u0644\u062a\u062d\u0643\u0645.',
    referralQualified:
      '\uD83C\uDF89 \u062a\u0645 \u062a\u0623\u0647\u064a\u0644 \u0627\u0644\u0625\u062d\u0627\u0644\u0629\n\n'
      + '\u0642\u0627\u0645 \u0645\u0633\u062a\u062e\u062f\u0645 \u0623\u062d\u0644\u062a\u0647 \u0628\u0623\u0648\u0644 \u0625\u064a\u062f\u0627\u0639 \u0645\u0624\u0647\u0644 \u0644\u062f\u064a\u0647.\n\n'
      + '\u064a\u062a\u0645 \u062a\u0637\u0628\u064a\u0642 \u0645\u0643\u0627\u0641\u0623\u0629 \u0627\u0644\u0625\u062d\u0627\u0644\u0629 \u0627\u0644\u062e\u0627\u0635\u0629 \u0628\u0643. \u064a\u0645\u0643\u0646\u0643 \u0645\u0631\u0627\u062c\u0639\u0629 \u0642\u0633\u0645 \u0627\u0644\u0625\u062d\u0627\u0644\u0627\u062a \u0641\u064a \u0644\u0648\u062d\u0629 \u062a\u062d\u0643\u0645 Arbitrix \u0644\u0644\u062a\u0641\u0627\u0635\u064a\u0644.',
    pendingReminder:
      '\u23F3 \u0627\u0644\u0625\u064a\u062f\u0627\u0639 \u0645\u0627 \u0632\u0627\u0644 \u0645\u0639\u0644\u0642\u064b\u0627\n\n'
      + '\u0644\u0645 \u0646\u062a\u0644\u0642 \u0628\u0639\u062f \u0625\u064a\u062f\u0627\u0639\u0643 \u0628\u0642\u064a\u0645\u0629 {{amount}}. \u0625\u0630\u0627 \u0643\u0646\u062a \u0642\u062f \u0623\u0631\u0633\u0644\u062a\u0647 \u0628\u0627\u0644\u0641\u0639\u0644\u060c \u064a\u0631\u062c\u0649 \u0627\u0644\u0627\u0646\u062a\u0638\u0627\u0631 \u0642\u0644\u064a\u0644\u064b\u0627 \u0644\u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0634\u0628\u0643\u0629.\n\n'
      + '\u064a\u0645\u0643\u0646\u0643 \u0627\u0644\u062a\u062d\u0642\u0642 \u0645\u0646 \u0627\u0644\u062d\u0627\u0644\u0629 \u0641\u064a \u0644\u0648\u062d\u0629 \u0627\u0644\u062a\u062d\u0643\u0645.\n\n'
      + '\u0644\u0625\u064a\u0642\u0627\u0641 \u0647\u0630\u0647 \u0627\u0644\u062a\u0630\u0643\u064a\u0631\u0627\u062a \u0623\u0631\u0633\u0644 /unsubscribe.',
    pendingReminderNoAmount:
      '\u23F3 \u0627\u0644\u0625\u064a\u062f\u0627\u0639 \u0645\u0627 \u0632\u0627\u0644 \u0645\u0639\u0644\u0642\u064b\u0627\n\n'
      + '\u0644\u0645 \u0646\u062a\u0644\u0642 \u0628\u0639\u062f \u0625\u064a\u062f\u0627\u0639\u0643. \u0625\u0630\u0627 \u0643\u0646\u062a \u0642\u062f \u0623\u0631\u0633\u0644\u062a\u0647 \u0628\u0627\u0644\u0641\u0639\u0644\u060c \u064a\u0631\u062c\u0649 \u0627\u0644\u0627\u0646\u062a\u0638\u0627\u0631 \u0642\u0644\u064a\u0644\u064b\u0627 \u0644\u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0634\u0628\u0643\u0629.\n\n'
      + '\u064a\u0645\u0643\u0646\u0643 \u0627\u0644\u062a\u062d\u0642\u0642 \u0645\u0646 \u0627\u0644\u062d\u0627\u0644\u0629 \u0641\u064a \u0644\u0648\u062d\u0629 \u0627\u0644\u062a\u062d\u0643\u0645.\n\n'
      + '\u0644\u0625\u064a\u0642\u0627\u0641 \u0647\u0630\u0647 \u0627\u0644\u062a\u0630\u0643\u064a\u0631\u0627\u062a \u0623\u0631\u0633\u0644 /unsubscribe.'
  })
});

/** Event type -> template key pair. Unknown events are never sent. */
const MESSAGE_KEYS_BY_EVENT = Object.freeze({
  deposit_confirmed: Object.freeze({ withAmount: 'depositConfirmed', withoutAmount: 'depositConfirmedNoAmount' }),
  referral_qualified: Object.freeze({ withAmount: 'referralQualified', withoutAmount: 'referralQualified' }),
  deposit_pending_reminder: Object.freeze({ withAmount: 'pendingReminder', withoutAmount: 'pendingReminderNoAmount' })
});

function interpolate(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Format a USD amount the way the app does ($1,234.56). */
function formatAmount(amount) {
  const value = Number(amount);
  if (!isFinite(value) || value <= 0) return null;
  return '$' + value.toFixed(2);
}

/**
 * Render the message for one notification.
 *
 * @param {string} eventType
 * @param {string} language
 * @param {number|null} amount
 * @returns {string|null} null when the event type has no approved message
 */
function renderConversionMessage(eventType, language, amount) {
  const keys = MESSAGE_KEYS_BY_EVENT[eventType];
  if (!keys) return null;

  const lang = normalizeLanguage(language);
  const table = CONVERSION_STRINGS[lang] || CONVERSION_STRINGS[DEFAULT_LANGUAGE];
  const formatted = formatAmount(amount);
  const key = formatted ? keys.withAmount : keys.withoutAmount;
  const template = table[key] !== undefined
    ? table[key]
    : CONVERSION_STRINGS[DEFAULT_LANGUAGE][key];

  if (template === undefined) return null;
  return interpolate(template, { amount: formatted });
}

module.exports = {
  CONVERSION_STRINGS,
  MESSAGE_KEYS_BY_EVENT,
  formatAmount,
  renderConversionMessage
};
