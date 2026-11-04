'use strict';

/**
 * Supported WhatsApp customer languages.
 *
 * The resolver returns one of ACTIVE_LANGUAGES. `es` is declared here as a
 * PLANNED locale: it carries a canonical code, a Meta template locale and an
 * alias list, but `active: false` keeps it out of every resolver decision and
 * out of template provisioning. Adding Spanish later therefore means flipping
 * one flag, adding its content keys (WhatsAppContent) and its detection
 * markers - no structural change.
 *
 * Canonical codes are BCP-47 (`pt-BR`), while Meta/WhatsApp template locales
 * use underscores (`pt_BR`). toMetaLocale() is the only conversion point.
 */

const DEFAULT_LANGUAGE = 'en';

const LANGUAGES = Object.freeze({
  en: Object.freeze({
    code: 'en',
    label: 'English',
    native: 'English',
    metaLocale: 'en',
    templateSuffix: 'en',
    active: true,
    formalAddress: 'default'
  }),
  'pt-BR': Object.freeze({
    code: 'pt-BR',
    label: 'Brazilian Portuguese',
    native: 'Português (Brasil)',
    metaLocale: 'pt_BR',
    templateSuffix: 'pt_br',
    active: true,
    formalAddress: 'Brazilian'
  }),
  es: Object.freeze({
    code: 'es',
    label: 'Spanish',
    native: 'Español',
    metaLocale: 'es_ES',
    templateSuffix: 'es',
    active: false,
    formalAddress: 'neutral'
  })
});

const ACTIVE_LANGUAGES = Object.freeze(
  Object.keys(LANGUAGES).filter((code) => LANGUAGES[code].active)
);

/**
 * Aliases are compared after normalisation: lower-case, trimmed, underscores
 * and spaces folded to a hyphen. `pt` maps to `pt-BR` because Brazilian
 * Portuguese is the only Portuguese the platform supports; mapping it to a
 * European variant would silently produce the wrong copy.
 */
const ALIASES = Object.freeze({
  en: 'en',
  'en-us': 'en',
  'en-gb': 'en',
  'en-au': 'en',
  english: 'en',
  ingles: 'en',
  'inglês': 'en',

  pt: 'pt-BR',
  'pt-br': 'pt-BR',
  'pt_br': 'pt-BR',
  ptbr: 'pt-BR',
  'pt-brazil': 'pt-BR',
  brazilian: 'pt-BR',
  'brazilian-portuguese': 'pt-BR',
  'portuguese-brazil': 'pt-BR',
  portuguese: 'pt-BR',
  portugues: 'pt-BR',
  'português': 'pt-BR',
  'português-brasil': 'pt-BR',
  brasil: 'pt-BR',
  brazil: 'pt-BR',
  br: 'pt-BR',

  es: 'es',
  'es-es': 'es',
  'es-mx': 'es',
  spanish: 'es',
  espanol: 'es',
  'español': 'es'
});

function normalizeKey(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Resolve any alias to a canonical code. Returns null when the value is not a
 * known language, so callers can distinguish "no preference" from "English".
 */
function normalizeLanguage(value) {
  const key = normalizeKey(value);
  if (!key) return null;
  const canonical = ALIASES[key];
  return canonical || null;
}

function isActiveLanguage(value) {
  const code = normalizeLanguage(value);
  return Boolean(code) && ACTIVE_LANGUAGES.indexOf(code) !== -1;
}

function toMetaLocale(value) {
  const code = normalizeLanguage(value) || DEFAULT_LANGUAGE;
  return LANGUAGES[code] ? LANGUAGES[code].metaLocale : LANGUAGES[DEFAULT_LANGUAGE].metaLocale;
}

function languageMeta(value) {
  const code = normalizeLanguage(value) || DEFAULT_LANGUAGE;
  return LANGUAGES[code] || LANGUAGES[DEFAULT_LANGUAGE];
}

function languageLabel(value) {
  return languageMeta(value).label;
}

module.exports = {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  ACTIVE_LANGUAGES,
  ALIASES,
  normalizeLanguage,
  isActiveLanguage,
  toMetaLocale,
  languageMeta,
  languageLabel
};
