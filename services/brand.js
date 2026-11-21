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
 * STATE: the relaunch identity is APPLIED on the release branch - `name`, `mark`,
 * `appName` and `accent` above are Kalderix. `source` deliberately keeps the
 * pre-rename literal: it is what maps a transaction detail written before the
 * rename, and what the support knowledge base uses as a query alias, so both
 * spellings keep working. A FUTURE rename is still one command
 * (scripts/relaunch-brand.js) and it re-asserts `source` for exactly that reason.
 */

const BRAND = {
  /** The name the product presents to customers today. ONE line to change. */
  name: 'Kalderix',
  /** The approved identity. Compared with `name` to prove the palette and the
   *  name ship together, never one before the other. */
  candidate: 'Kalderix',
  /** The legal operator. Never changes with a rebrand. */
  legalName: 'Arbitrix Trading',
  /** Netherlands Chamber of Commerce registration of the legal operator. */
  kvk: '72923513',
  /** The public site, kept stable through any rebrand. */
  domain: 'arbitrix.pro',
  /** Transactional mail domain. Changing it requires SPF/DKIM re-verification. */
  mailDomain: 'arbitrix.ai',
  /** The pre-rename literal. NEVER rewritten: pre-rename transaction details map
   *  through it, and the support bot accepts it as an alias of `name`. */
  source: 'Arbitrix',
  /** Monogram used by the favicon, the app icon and the sign-in mark. */
  mark: 'K',
  /** The monogram the candidate uses. */
  candidateMark: 'K',
  /** Positioning line, used in metadata and the social share card. */
  tagline: 'Automated Arbitrage. Made Simple.',
  /** The installed-app (PWA) name. Follows a rename. */
  appName: 'Kalderix',
  /** Accent colour. Follows the identity palette when one is applied. */
  accent: '#D4AF63'
};

/**
 * The identity as data. The name and the accent above are live; these values are
 * the source the assets in public/brand/ are regenerated from, so a future
 * identity change cannot introduce a colour picked in a hurry.
 */
BRAND.candidateIdentity = {
  name: 'Kalderix',
  mark: 'K',
  palette: {
    /** Primary accent; replaces the gold the current identity uses. */
    accent: '#D4AF63',
    accentHover: '#E0C07B',
    accentPressed: '#C09A4E',
    /** Secondary accent for "verified" and "information" highlights. */
    secondary: '#38BDF8',
    /** Neutral near-black surfaces: a brighter accent needs less blue undertone. */
    surface: '#0B0F14',
    surfaceRaised: '#131A23',
    textPrimary: '#E8EEF5',
    textSecondary: '#AAB6C4'
  },
  typography: {
    display: "system-ui, 'Inter', -apple-system, 'Segoe UI', sans-serif",
    numeric: "'JetBrains Mono', 'SFMono-Regular', ui-monospace, monospace",
    note: 'No size changes: the current scale is tuned for dashboard density.'
  },
  rationale: {
    accent: 'Emerald reads as an active, modern exchange rather than a legacy '
      + 'bank, and it measures 9.21:1 on the base surface, so unlike the violet it '
      + 'is legible as text as well as a fill. Dark ink (#1A1305) on the fill '
      + 'measures 8.89:1.',
    secondary: 'A cool sky blue gives verified and informational states a signal '
      + 'that cannot be confused with the green/red profit colours next to a '
      + 'green accent.',
    surfaces: 'Near-black neutrals with a lighter surface ramp, so cards separate '
      + 'from the page without relying on borders alone.',
    mark: 'One letterform works at 16px (favicon) and at 340px (app icon), so a '
      + 'single asset serves both without a second lockup.'
  }
};

/** True once the candidate name is the name in force. */
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

/**
 * The identity in force. The candidate palette/typography are returned ONLY when
 * the candidate name has actually been applied, so a half-finished rename cannot
 * ship a new colour with an old name.
 */
function activeIdentity() {
  const applied = BRAND.name === BRAND.candidate;
  if (!applied) {
    return { name: BRAND.name, mark: BRAND.mark, palette: null, typography: null, applied: false };
  }
  return {
    name: BRAND.name,
    mark: BRAND.mark,
    palette: BRAND.candidateIdentity.palette,
    typography: BRAND.candidateIdentity.typography,
    applied: true
  };
}

module.exports = { BRAND, brandize, emailSender, activeIdentity };
