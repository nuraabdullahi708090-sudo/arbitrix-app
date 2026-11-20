'use strict';

/**
 * Regression fixtures for the rebrand gate.
 *
 * Each fixture is a defect that the PREVIOUS gate missed (or a legitimate string
 * the gate must not flag). They are executed by
 *   node scripts/verify-rebrand.js --self-test
 * and by tests/rebrand_gate.test.js, so a detector that stops working fails a
 * check instead of silently passing the release gate.
 */

const TEXT_CASES = [
  // --- must be flagged: the article/grammar defect class -------------------
  { label: 'partners hero title', text: 'Become an Kalderix Referral Partner', expect: 'article' },
  { label: 'login subtitle', text: 'Already have an Kalderix account? Sign in.', expect: 'article' },
  { label: 'support bot unlink reply', text: 'This chat is not linked to an Kalderix account.', expect: 'article' },
  { label: 'capitalised sentence start', text: 'An Kalderix account is required.', expect: 'article' },

  // --- must be flagged: the other-script class ----------------------------
  { label: 'Arabic login subtitle', text: '\u0647\u0644 \u0644\u062f\u064a\u0643 \u062d\u0633\u0627\u0628 \u0641\u064a \u0623\u0631\u0628\u064a\u062a\u0631\u064a\u0643\u0633 \u0628\u0627\u0644\u0641\u0639\u0644\u061f', expect: 'oldBrand' },
  { label: 'Arabic without hamza', text: '\u062c\u062f\u064a\u062f \u0641\u064a \u0627\u0631\u0628\u064a\u062a\u0631\u064a\u0643\u0633\u061f', expect: 'oldBrand' },
  { label: 'plain Latin copy', text: 'Sign in to your Arbitrix account.', expect: 'oldBrand' },

  // --- must NOT be flagged: protected identifiers -------------------------
  { label: 'legal operator', text: 'Arbitrix Trading, registered with the KVK under 72923513.', expect: 'none' },
  { label: 'public domain', text: 'Read more at https://arbitrix.pro/partners', expect: 'none' },
  { label: 'support handle', text: 'Message @ArbitrixSupportBot for help.', expect: 'none' },
  { label: 'partner handle', text: 'Contact @AlexArbitrix on Telegram.', expect: 'none' },
  { label: 'technical identifier', text: '<meta name="arbitrix-support-telegram" content="">', expect: 'none' },
  { label: 'historical transaction label', text: 'Kalderix Pro Subscription - 2026-11', expect: 'none' },
  { label: 'ordinary product copy', text: 'Earn 20% of a referred user\'s first qualifying deposit of $100.', expect: 'none' }
];

const METADATA_CASES = [
  { label: 'title article defect', html: '<title>Become an Kalderix Referral Partner | Kalderix</title>', expect: 'defect' },
  { label: 'og:title article defect', html: '<meta property="og:title" content="Become an Kalderix Referral Partner">', expect: 'defect' },
  { label: 'twitter:title article defect', html: '<meta name="twitter:title" content="Become an Kalderix Referral Partner">', expect: 'defect' },
  { label: 'description old brand', html: '<meta name="description" content="An Arbitrix product.">', expect: 'defect' },
  { label: 'clean metadata', html: '<title>Become a Kalderix Referral Partner | Kalderix</title><meta property="og:site_name" content="Kalderix">', expect: 'clean' }
];

const LOCALE_CASES = [
  {
    label: 'missing key in one locale',
    dicts: { en: { 'a.b': 'One', 'a.c': 'Two' }, ar: { 'a.b': 'One' } },
    expect: 'defect'
  },
  {
    label: 'empty translation',
    dicts: { en: { 'a.b': 'One' }, ar: { 'a.b': '   ' } },
    expect: 'defect'
  },
  {
    label: 'placeholder mismatch',
    dicts: { en: { 'a.b': 'Pay ${{min}}' }, ar: { 'a.b': 'Pay now' } },
    expect: 'defect'
  },
  {
    label: 'old brand inside a locale value',
    dicts: { en: { 'a.b': 'Welcome' }, ar: { 'a.b': '\u0645\u0631\u062d\u0628\u0627 \u0628\u0643 \u0641\u064a \u0623\u0631\u0628\u064a\u062a\u0631\u064a\u0643\u0633' } },
    expect: 'defect'
  },
  {
    label: 'clean locales',
    dicts: { en: { 'a.b': 'Pay ${{min}}' }, ar: { 'a.b': '\u0627\u062f\u0641\u0639 ${{min}} \u0641\u064a Kalderix' } },
    expect: 'clean'
  }
];

/**
 * Run every fixture against the shared detectors.
 * @returns {{passed:number, failed:number, results:Array<{label:string, ok:boolean, detail:string}>}}
 */
function runFixtures(lint, brand = 'Kalderix') {
  const results = [];

  for (const c of TEXT_CASES) {
    const oldHits = lint.detectOldBrand(c.text);
    const article = lint.detectArticleDefects(c.text, brand);
    const isOld = oldHits.length > 0;
    const isArticle = article.length > 0;
    let ok;
    if (c.expect === 'none') ok = !isOld && !isArticle;
    else if (c.expect === 'oldBrand') ok = isOld;
    else ok = isArticle;
    results.push({ label: 'text: ' + c.label, ok, detail: 'old=' + isOld + ' article=' + isArticle + ' expect=' + c.expect });
  }

  for (const c of METADATA_CASES) {
    const defects = lint.detectMetadataDefects(c.html, { brand });
    const ok = c.expect === 'defect' ? defects.length > 0 : defects.length === 0;
    results.push({ label: 'metadata: ' + c.label, ok, detail: defects.length + ' defect(s), expect=' + c.expect });
  }

  for (const c of LOCALE_CASES) {
    const defects = lint.detectLocaleDefects(c.dicts, { brand });
    const ok = c.expect === 'defect' ? defects.length > 0 : defects.length === 0;
    results.push({ label: 'locale: ' + c.label, ok, detail: defects.length + ' defect(s), expect=' + c.expect });
  }

  const failed = results.filter((r) => !r.ok).length;
  return { passed: results.length - failed, failed, results };
}

module.exports = { TEXT_CASES, METADATA_CASES, LOCALE_CASES, runFixtures };
