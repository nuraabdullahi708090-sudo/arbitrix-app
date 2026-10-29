/**
 * Deposit partner directory - validation and public projection.
 *
 * A "partner" is a human who may help a customer obtain cryptocurrency off
 * platform and send it to the customer's own Arbitrix deposit address. Arbitrix
 * never accepts a partner confirmation, screenshot or Telegram message as proof
 * of payment: only the existing deposit-verification path credits a balance.
 *
 * SERVICE MODEL (two independent capabilities, a partner may offer both):
 *   direct_sale        - the partner sells USDT and can arrange its transfer to
 *                        the customer's Arbitrix deposit address.
 *   guided_assistance  - the partner helps the customer buy USDT through an
 *                        external exchange/wallet/service and guides them
 *                        through depositing it.
 * The service list is authoritative: the customer card renders exactly the
 * capabilities the administrator recorded, never a guess.
 *
 * COVERAGE MODEL: `serves_worldwide` means "no country restriction".
 * Otherwise `countries` is the coverage/limitation list that is displayed
 * verbatim. A partner with neither is NOT customer-visible, because we cannot
 * honestly claim unrestricted availability and have nothing accurate to show.
 *
 * This module is deliberately pure (no database, no network) so the rules can be
 * unit-tested and reused by both the public and the admin routes.
 *
 * SECURITY:
 *  - A Telegram USERNAME is stored, never a URL. Links are built here, so an
 *    administrator cannot store an arbitrary/phishing URL in the directory.
 *  - Only ACTIVE and VERIFIED partners are ever exposed to customers.
 *  - Public projections drop every administrative field.
 */

// Telegram usernames: 5-32 characters, letters/digits/underscore, must start
// with a letter. Stored lowercase because Telegram usernames are
// case-insensitive (a stored mixed-case handle could otherwise look like a
// different account to a customer reading it).
const TELEGRAM_USERNAME_RE = /^[a-z][a-z0-9_]{4,31}$/;
const TELEGRAM_HOST = 'https://t.me/';
const MAX_NAME_LENGTH = 60;
const MAX_LIST_ITEM = 40;
const MAX_LIST_ITEMS = 12;

// Canonical service identifiers. These strings are stored in the database
// (TEXT[] with a subset CHECK) and are never displayed: the UI maps each one to
// a localized label, so a new service would be a data + copy change only.
const SERVICE_DIRECT_SALE = 'direct_sale';
const SERVICE_GUIDED_ASSISTANCE = 'guided_assistance';
const SERVICES = Object.freeze([SERVICE_DIRECT_SALE, SERVICE_GUIDED_ASSISTANCE]);

/**
 * Normalize an administrator-supplied Telegram handle.
 *
 * Accepts `@name`, `name`, `t.me/name` or `https://t.me/name`. Anything else -
 * including a non-Telegram URL - is rejected.
 *
 * @param {string} raw
 * @returns {{ok: boolean, username: string|null, reason: string|null}}
 */
function normalizeTelegramUsername(raw) {
  if (typeof raw !== 'string') return { ok: false, username: null, reason: 'not-a-string' };
  let value = raw.trim();
  if (!value) return { ok: false, username: null, reason: 'empty' };
  if (value.length > 120) return { ok: false, username: null, reason: 'too-long' };

  // Accept a full Telegram profile URL, but only a Telegram one.
  const urlMatch = value.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]+)\/?$/i);
  if (urlMatch) {
    value = urlMatch[1];
  } else if (/[:/?#]/.test(value)) {
    // Any other scheme/host/path/query is not a handle.
    return { ok: false, username: null, reason: 'not-a-telegram-handle' };
  }

  value = value.replace(/^@/, '').trim().toLowerCase();
  if (!TELEGRAM_USERNAME_RE.test(value)) {
    return { ok: false, username: null, reason: 'invalid-format' };
  }
  return { ok: true, username: value, reason: null };
}

/**
 * Build the canonical profile URL for a stored username. Returns null when the
 * stored value is not a valid handle, so a corrupted row can never render a
 * link a customer might follow.
 *
 * @param {string} username
 * @returns {string|null}
 */
function telegramProfileUrl(username) {
  const normalized = normalizeTelegramUsername(username);
  if (!normalized.ok) return null;
  return TELEGRAM_HOST + normalized.username;
}

/**
 * Sanitize a display name: single line, no markup characters, length-capped.
 *
 * @param {string} raw
 * @returns {{ok: boolean, value: string, reason: string|null}}
 */
function sanitizeDisplayName(raw) {
  if (typeof raw !== 'string') return { ok: false, value: '', reason: 'not-a-string' };
  const value = raw.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!value) return { ok: false, value: '', reason: 'empty' };
  if (value.length > MAX_NAME_LENGTH) return { ok: false, value: '', reason: 'too-long' };
  return { ok: true, value, reason: null };
}

/**
 * Sanitize an optional list (countries served, payment methods) supplied by an
 * administrator. Accepts an array or a comma-separated string.
 *
 * @param {string|string[]} raw
 * @returns {{ok: boolean, items: string[], reason: string|null}}
 */
function sanitizeList(raw) {
  let parts = [];
  if (Array.isArray(raw)) {
    parts = raw;
  } else if (typeof raw === 'string') {
    parts = raw.split(',');
  } else if (raw === null || raw === undefined) {
    return { ok: true, items: [], reason: null };
  } else {
    return { ok: false, items: [], reason: 'not-a-list' };
  }

  const items = [];
  for (const part of parts) {
    if (typeof part !== 'string') return { ok: false, items: [], reason: 'not-a-string' };
    const item = part.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!item) continue;
    if (item.length > MAX_LIST_ITEM) return { ok: false, items: [], reason: 'item-too-long' };
    // Deduplicate case-insensitively while preserving the first spelling.
    if (!items.some((existing) => existing.toLowerCase() === item.toLowerCase())) items.push(item);
    if (items.length > MAX_LIST_ITEMS) return { ok: false, items: [], reason: 'too-many-items' };
  }
  return { ok: true, items, reason: null };
}

/**
 * Normalize an administrator-supplied service list.
 *
 * Accepts an array or a comma-separated string of canonical identifiers. Values
 * are case-insensitive and hyphen/space tolerant ("direct sale" ->
 * "direct_sale") so a hand-typed payload cannot silently produce an unknown
 * service. Any unrecognised value is REJECTED rather than dropped: storing a
 * capability the UI cannot describe would misrepresent the partner.
 *
 * @param {string|string[]} raw
 * @returns {{ok: boolean, services: string[], reason: string|null}}
 */
function sanitizeServices(raw) {
  let parts = [];
  if (Array.isArray(raw)) parts = raw;
  else if (typeof raw === 'string') parts = raw.split(',');
  else if (raw === null || raw === undefined) return { ok: true, services: [], reason: null };
  else return { ok: false, services: [], reason: 'not-a-list' };

  const services = [];
  for (const part of parts) {
    if (typeof part !== 'string') return { ok: false, services: [], reason: 'not-a-string' };
    const token = part.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!token) continue;
    if (SERVICES.indexOf(token) === -1) return { ok: false, services: [], reason: 'unknown-service' };
    if (services.indexOf(token) === -1) services.push(token);
  }
  // Canonical order so two payloads that describe the same partner compare equal.
  services.sort((a, b) => SERVICES.indexOf(a) - SERVICES.indexOf(b));
  return { ok: true, services, reason: null };
}

/**
 * Whether a partner offers a given service.
 *
 * @param {object} row
 * @param {string} service
 * @returns {boolean}
 */
function offersService(row, service) {
  if (!row || !Array.isArray(row.services)) return false;
  return row.services.indexOf(service) !== -1;
}

/**
 * Coverage is only honest when it is either explicitly worldwide or an
 * explicit list. Anything else must not be presented to a customer.
 *
 * @param {object} row
 * @returns {boolean}
 */
function hasDisclosedCoverage(row) {
  if (!row) return false;
  if (row.serves_worldwide === true) return true;
  return Array.isArray(row.countries) && row.countries.length > 0;
}

/**
 * Parse a display order. Missing/invalid values fall back to the default so a
 * typo can never reorder the directory unpredictably.
 *
 * @param {*} raw
 * @returns {number}
 */
function parseDisplayOrder(raw) {
  const DEFAULT_ORDER = 100;
  if (raw === null || raw === undefined || raw === '') return DEFAULT_ORDER;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_ORDER;
  return Math.max(0, Math.min(10000, Math.trunc(value)));
}

/**
 * Whether a stored row may be shown to customers.
 * Both flags are required: "verified" is what the badge claims, so an
 * unverified partner must never be reachable from the deposit page.
 *
 * @param {object} row
 * @returns {boolean}
 */
function isCustomerVisible(row) {
  if (!row || row.is_active !== true || row.is_verified !== true) return false;
  // A partner with no recorded service, or with no honest coverage statement,
  // cannot be described to a customer without inventing something.
  if (sanitizeServices(row.services).services.length === 0) return false;
  return hasDisclosedCoverage(row);
}

/**
 * Customer-facing projection. Contains no administrative fields: no database
 * id (a sequential key would expose directory size/growth and is not needed by
 * the deposit page - cards are rendered from the fields below), no
 * created/updated timestamps, no notes and no flags.
 *
 * @param {object} row
 * @returns {object|null}
 */
function toPublicPartner(row) {
  if (!isCustomerVisible(row)) return null;
  const url = telegramProfileUrl(row.telegram_username);
  if (!url) return null;
  const services = sanitizeServices(row.services).services;
  const worldwide = row.serves_worldwide === true;
  const paymentMethods = Array.isArray(row.payment_methods)
    ? row.payment_methods.slice(0, MAX_LIST_ITEMS) : [];
  return {
    displayName: row.display_name,
    telegramUsername: normalizeTelegramUsername(row.telegram_username).username,
    telegramUrl: url,
    services,
    // True when the partner sells USDT and can arrange the transfer; false when
    // they only guide the customer through an external service.
    directSale: services.indexOf(SERVICE_DIRECT_SALE) !== -1,
    guidedAssistance: services.indexOf(SERVICE_GUIDED_ASSISTANCE) !== -1,
    servesWorldwide: worldwide,
    // Empty when worldwide: there is no limitation to display.
    countries: worldwide ? [] : (Array.isArray(row.countries) ? row.countries.slice(0, MAX_LIST_ITEMS) : []),
    paymentMethods,
    // Payment methods describe what the partner accepts for a DIRECT sale.
    // Guided assistance always depends on the external service the customer
    // chooses, so that caveat is shown whenever the partner guides - including
    // for a partner that does both.
    paymentMethodsApplyToDirectSale: services.indexOf(SERVICE_DIRECT_SALE) !== -1,
    paymentMethodsDependOnExternalService: services.indexOf(SERVICE_GUIDED_ASSISTANCE) !== -1
  };
}

/**
 * Filter + project a list of rows for the deposit page.
 *
 * @param {object[]} rows
 * @returns {object[]}
 */
function toPublicPartnerList(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(isCustomerVisible)
    // display_order ascending, then name, so administrators control the list.
    .slice()
    .sort((a, b) => {
      const orderA = Number.isFinite(Number(a.display_order)) ? Number(a.display_order) : 100;
      const orderB = Number.isFinite(Number(b.display_order)) ? Number(b.display_order) : 100;
      if (orderA !== orderB) return orderA - orderB;
      return String(a.display_name || '').localeCompare(String(b.display_name || ''));
    })
    .map(toPublicPartner)
    .filter(Boolean);
}

module.exports = {
  TELEGRAM_USERNAME_RE,
  MAX_NAME_LENGTH,
  MAX_LIST_ITEM,
  MAX_LIST_ITEMS,
  SERVICE_DIRECT_SALE,
  SERVICE_GUIDED_ASSISTANCE,
  SERVICES,
  normalizeTelegramUsername,
  telegramProfileUrl,
  sanitizeDisplayName,
  sanitizeList,
  sanitizeServices,
  offersService,
  hasDisclosedCoverage,
  parseDisplayOrder,
  isCustomerVisible,
  toPublicPartner,
  toPublicPartnerList
};
