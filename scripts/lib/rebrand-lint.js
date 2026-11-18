'use strict';

/**
 * Pure detectors used by scripts/verify-rebrand.js and by the regression tests.
 *
 * WHY THIS IS A SEPARATE MODULE
 * The gate used to scan only the ASCII string "Arbitrix" inside the six locale
 * dictionaries. That missed four classes of real, customer-visible defect:
 *
 *   1. the old brand in ANOTHER SCRIPT (the Arabic login/signup subtitles said
 *      "أربيتريكس" while every other Arabic string said "Kalderix");
 *   2. article/grammar defects ("Become an Kalderix Referral Partner"), which the
 *      gate could not see because it only required the new name to be PRESENT;
 *   3. the old brand in page METADATA (<title>, og:*, twitter:*), which is what a
 *      search result and a social card show;
 *   4. the old brand in the support bot / marketing strings, which live outside
 *      public/index.html.
 *
 * Keeping the rules in one pure module means the gate and its regression
 * fixtures exercise the SAME code, so a detector cannot silently rot.
 */

/** Old-brand spellings per script. Extend this list when a new transliteration appears. */
const OLD_BRAND_ALIASES = [
  'Arbitrix',            // Latin
  '\u0623\u0631\u0628\u064a\u062a\u0631\u064a\u0643\u0633', // Arabic: أربيتريكس
  '\u0627\u0631\u0628\u064a\u062a\u0631\u064a\u0643\u0633', // Arabic, no hamza: اربيتريكس
  '\u0623\u0631\u0628\u064a\u062a\u0631\u0643\u0633'        // Arabic variant: أربيتركس
];

/**
 * Substrings that make an old-brand mention LEGITIMATE. Each entry is tested
 * against a +-40 character window around the match, never against the whole file.
 */
const ALLOW_CONTEXT = [
  [/https?:\/\/(?:[a-z0-9-]+\.)?arbitrix\.(?:pro|ai)/i, 'public domain'],
  [/[a-z0-9._%+-]+@arbitrix\./i, 'mailbox'],
  [/@(?:[A-Za-z]+)?Arbitrix[A-Za-z0-9_]*/, 'Telegram handle'],
  [/t\.me\/(?:[A-Za-z_+0-9]*)?Arbitrix/, 'Telegram destination'],
  [/arbitrix[-_][a-z-]+/i, 'technical identifier (meta name, filename, env var)'],
  [/Arbitrix Trading/, 'legal operator'],
  [/data-brand|brand-|source:/, 'brand configuration'],
  [/%3EArbitrix|Arbitrix%3C/i, 'URL-encoded identifier']
];

function contextAround(text, index, radius = 40) {
  return text.slice(Math.max(0, index - radius), index + radius);
}

function isAllowed(oldName, context) {
  return ALLOW_CONTEXT.some(([re]) => re.test(context));
}

/**
 * Every old-brand spelling that is NOT in an allowed context.
 * @returns {Array<{index:number, match:string, context:string}>}
 */
function detectOldBrand(text, options = {}) {
  const haystack = String(text == null ? '' : text);
  const aliases = options.aliases || OLD_BRAND_ALIASES;
  const out = [];
  for (const alias of aliases) {
    let from = 0;
    for (;;) {
      const i = haystack.indexOf(alias, from);
      if (i < 0) break;
      from = i + 1;
      const ctx = contextAround(haystack, i);
      if (!isAllowed(alias, ctx)) out.push({ index: i, match: alias, context: ctx });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Article and duplication defects around the CURRENT brand name.
 *
 * "an Kalderix" is wrong in English because the name begins with a consonant
 * sound. The capitalised form is checked too, because metadata often starts a
 * sentence. Duplication ("Kalderix Kalderix") catches a mechanical rename that
 * replaced a phrase rather than a token.
 */
function detectArticleDefects(text, brand) {
  const haystack = String(text == null ? '' : text);
  const name = String(brand || '');
  if (!name) return [];
  const out = [];
  const patterns = [
    [new RegExp('\\b([Aa]n)\\s+' + escapeRegExp(name) + '\\b', 'g'), 'wrong article ("an ' + name + '")'],
    [new RegExp('\\b' + escapeRegExp(name) + '\\s+' + escapeRegExp(name) + '\\b', 'g'), 'duplicated brand name'],
    [new RegExp('\\b([Tt]he)\\s+the\\b', 'g'), 'duplicated article']
  ];
  for (const [re, reason] of patterns) {
    let m;
    while ((m = re.exec(haystack)) !== null) {
      out.push({ index: m.index, match: m[0], reason, context: contextAround(haystack, m.index) });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out;
}

/** Extract the metadata values a search engine or social card would show. */
function metadataValues(html) {
  const text = String(html == null ? '' : html);
  const out = [];
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) out.push({ tag: 'title', value: title[1] });
  const metaRe = /<meta\s+([^>]+?)>/gi;
  let m;
  while ((m = metaRe.exec(text)) !== null) {
    const attrs = m[1];
    const name = (attrs.match(/(?:name|property)\s*=\s*"([^"]+)"/i) || [])[1];
    const content = (attrs.match(/content\s*=\s*"([^"]*)"/i) || [])[1];
    if (!name || content === undefined) continue;
    if (!/^(description|og:title|og:description|og:site_name|twitter:title|twitter:description|apple-mobile-web-app-title)$/i.test(name)) continue;
    out.push({ tag: name, value: content });
  }
  return out;
}

/**
 * Defects in what a search result / social card shows: old brand, article
 * grammar, and (optionally) a missing brand name.
 */
function detectMetadataDefects(html, options = {}) {
  const brand = String(options.brand || '');
  const out = [];
  for (const { tag, value } of metadataValues(html)) {
    const oldHits = detectOldBrand(value, options);
    if (oldHits.length) out.push({ tag, value, reason: 'old brand in metadata', match: oldHits[0].match });
    const article = detectArticleDefects(value, brand);
    if (article.length) out.push({ tag, value, reason: article[0].reason, match: article[0].match });
    if (options.requireBrand && tag === 'title' && brand && !String(value).includes(brand)) {
      out.push({ tag, value, reason: 'title does not name the product', match: '' });
    }
  }
  return out;
}

/**
 * Locale completeness: identical KEY SETS, no empty values, identical
 * placeholder sets per key, and no old-brand / article defects per value.
 */
function detectLocaleDefects(dictionaries, options = {}) {
  const brand = String(options.brand || '');
  const locales = Object.keys(dictionaries || {});
  const out = [];
  if (locales.length === 0) return [{ locale: null, key: null, reason: 'no locales found' }];
  const base = locales.includes('en') ? 'en' : locales[0];
  const baseKeys = Object.keys(dictionaries[base]);

  for (const locale of locales) {
    const dict = dictionaries[locale] || {};
    const keys = Object.keys(dict);
    for (const key of baseKeys) if (!(key in dict)) out.push({ locale, key, reason: 'missing key (present in ' + base + ')' });
    for (const key of keys) if (!(key in dictionaries[base])) out.push({ locale, key, reason: 'extra key (absent from ' + base + ')' });
    for (const key of keys) {
      const value = dict[key];
      if (value === null || value === undefined || String(value).trim() === '') {
        out.push({ locale, key, reason: 'empty translation' });
        continue;
      }
      const oldHits = detectOldBrand(value, options);
      if (oldHits.length) out.push({ locale, key, reason: 'old brand: ' + oldHits[0].match });
      const article = detectArticleDefects(value, brand);
      if (article.length) out.push({ locale, key, reason: article[0].reason });
      const expected = placeholders(dictionaries[base][key]);
      const actual = placeholders(value);
      if (expected !== actual) {
        out.push({ locale, key, reason: 'placeholder mismatch: expected {' + expected + '} got {' + actual + '}' });
      }
    }
  }
  return out;
}

function placeholders(value) {
  const found = String(value == null ? '' : value).match(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g) || [];
  return found.map((s) => s.replace(/[{}\s]/g, '')).sort().join(',');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  OLD_BRAND_ALIASES,
  ALLOW_CONTEXT,
  detectOldBrand,
  detectArticleDefects,
  metadataValues,
  detectMetadataDefects,
  detectLocaleDefects,
  placeholders
};
