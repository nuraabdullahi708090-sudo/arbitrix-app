'use strict';

/**
 * BRAND - the single source of truth for the customer-visible product name.
 *
 * Why this file exists: the product name appeared 1741 times across the repo,
 * which made a rename a mechanical edit with 1741 chances to break something.
 * Everything customer-visible now reads from here (or from the mirroring
 * `BRAND` constant in public/index.html, which feeds the {{brand}} placeholder
 * used by all six locale dictionaries).
 *
 * DENY-LIST - these are IDENTIFIERS, not branding. They must never follow a
 * rename, because changing them breaks customers, credentials or isolation:
 *   - the public domain (arbitrix.pro) and the mail domain (arbitrix.ai)
 *   - the Telegram handles (@ArbitrixSupportBot, @Arbitrix_CSA1,
 *     @ArbitrixAnnouncements)
 *   - "Arbitrix Trading" - the legal entity registered at KVK 72923513. A new
 *     name is a TRADING NAME of that entity; it does not change the operator.
 *   - the seeded admin login (admin@arbitrix.ai) - that is a credential
 *   - localStorage keys (jwt_token, arbi_*) - renaming logs every user out
 *   - DB tables, columns and enum values (MARKETING_SANDBOX, PRODUCTION)
 *
 * The new identity is NOT applied here. `candidate` records the provisionally
 * approved name so that approving it is a one-line change to `name`, and
 * `isCandidate` tells tests which state the build is in.
 */

const BRAND = {
  /** The name the product presents to customers today. ONE line to change. */
  name: 'Arbitrix',
  /** Provisionally approved relaunch candidate. NOT applied until approval. */
  candidate: 'Kalderix',
  /** The legal operator. Never changes with a rebrand. */
  legalName: 'Arbitrix Trading',
  /** Netherlands Chamber of Commerce registration of the legal operator. */
  kvk: '72923513',
  /** The public site, kept stable through any rebrand. */
  domain: 'arbitrix.pro',
  /** Transactional mail domain. Changing it requires SPF/DKIM re-verification. */
  mailDomain: 'arbitrix.ai',
  /** The literal currently written in localized strings and markup defaults. */
  source: 'Arbitrix'
};

/** True while the build still shows the pre-relaunch name. */
BRAND.isCandidate = BRAND.name === BRAND.candidate;

/**
 * Replace brand tokens in a server-authored string.
 * `{{brand}}` and `{{legalName}}` keep message templates free of the literal
 * name, so a rename does not require editing every email body.
 */
function brandize(text) {
  if (typeof text !== 'string') return text;
  return text
    .split('{{brand}}').join(BRAND.name)
    .split('{{legalName}}').join(BRAND.legalName);
}

/**
 * The transactional sender. The DISPLAY NAME follows the brand, but the ADDRESS
 * stays on the verified mail domain: swapping the domain before its SPF/DKIM
 * records exist sends password resets to spam, so that is a separate, approved
 * change.
 */
function emailSender() {
  return BRAND.name + ' <noreply@' + BRAND.mailDomain + '>';
}

module.exports = { BRAND, brandize, emailSender };
