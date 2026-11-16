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
 * STATE: the relaunch candidate is RECORDED but NOT APPLIED. Approving it means
 * changing `name` and `mark` here and the same two fields in
 * public/index.html; everything else (favicon, PWA manifest, page title, social
 * card, all six dictionaries) derives from them.
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
  source: 'Arbitrix',
  /** Monogram used by the favicon, the app icon and the sign-in mark. */
  mark: 'A',
  /** The monogram the candidate uses. */
  candidateMark: 'K',
  /** Positioning line, used in metadata and the social share card. */
  tagline: 'Automated Arbitrage. Made Simple.',
  /** The installed-app (PWA) name. Follows a rename; today it keeps the suffix. */
  appName: 'Arbitrix AI',
  /** Accent colour. Follows the identity palette when one is applied. */
  accent: '#F0B90B'
};

/**
 * The candidate identity as data. Nothing here is applied: the values exist so
 * approval cannot introduce a colour picked in a hurry, and so the assets in
 * public/brand/ can be regenerated from the same numbers.
 */
BRAND.candidateIdentity = {
  name: 'Kalderix',
  mark: 'K',
  palette: {
    /** Primary accent; replaces the gold the current identity uses. */
    accent: '#7C5CFF',
    accentHover: '#9B85FF',
    accentPressed: '#6344E8',
    /** Secondary accent for "verified" and "opportunity" highlights. */
    secondary: '#2ED3B7',
    /** Surfaces are deliberately unchanged so contrast work carries over. */
    surface: '#070B14',
    surfaceRaised: '#0C1220',
    textPrimary: '#E8EDF7',
    textSecondary: '#8896B5'
  },
  typography: {
    display: "system-ui, 'Inter', -apple-system, 'Segoe UI', sans-serif",
    numeric: "'JetBrains Mono', 'SFMono-Regular', ui-monospace, monospace",
    note: 'No size changes: the current scale is tuned for dashboard density.'
  },
  rationale: {
    accent: 'Violet reads as technology rather than as a currency logo, which is '
      + 'what the current gold does. It stays legible as the 3px active-item '
      + 'indicator on the dark surface.',
    secondary: 'A cool teal gives opportunity and verified states a signal that '
      + 'cannot be confused with the green/red profit colours.',
    surfaces: 'Unchanged on purpose: every contrast ratio and chart colour was '
      + 'tuned against them.',
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
