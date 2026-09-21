'use strict';

/**
 * Telegram chat-id canonicalization for CONFIGURATION values.
 *
 * Regression context: `TELEGRAM_SUPPORT_CHAT_ID` and `TELEGRAM_ADMIN_IDS` are
 * pasted into a host dashboard by a human. A paste from a rich-text editor, a
 * PDF, a chat client or a CJK input method can replace the leading "-" of a
 * supergroup id (Telegram ids are negative: "-100...") with a Unicode dash, or
 * carry full-width digits, zero-width characters or typographic quotes. The old
 * helper only stripped ASCII quotes and trimmed whitespace, so such a value was
 * stored as-is and could never equal the numeric id Telegram sends - the support
 * group was silently never recognised, with no error anywhere.
 *
 * These tests pin, against the REAL service:
 *   - preservation of valid ASCII ids (and that NFKC is an identity on them),
 *   - Unicode minus/dash folding, full-width digit folding,
 *   - removal of invisible/control characters and whitespace,
 *   - ASCII + Unicode quote unwrapping,
 *   - validation as ^-?\d+$ with unrepairable values rejected as null,
 *   - that canonicalization is applied to the two CONFIG env vars only, never to
 *     ids read from an incoming Telegram update.
 *
 * All Unicode in this file is written as escapes so the source stays ASCII.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  canonicalizeTelegramChatId,
  parseAdminIds,
  normalizeTelegramId,
  resolveTelegramConfig,
  routeUpdate,
  TELEGRAM_CHAT_ID_FORMAT
} = require('../services/TelegramSupportService');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'TelegramSupportService.js'),
  'utf8'
);

const GROUP = '-1003306395935';
const ADMIN = '6054625818';
const ADMIN_NEGATIVE = '-99';

// ---------------------------------------------------------------------------
// Valid ids are preserved exactly
// ---------------------------------------------------------------------------

test('a valid ASCII Telegram id is returned unchanged', () => {
  assert.strictEqual(canonicalizeTelegramChatId(GROUP), GROUP);
  assert.strictEqual(canonicalizeTelegramChatId('-1001234567890'), '-1001234567890');
  assert.strictEqual(canonicalizeTelegramChatId(ADMIN), ADMIN);
  assert.strictEqual(canonicalizeTelegramChatId(ADMIN_NEGATIVE), ADMIN_NEGATIVE);
  assert.strictEqual(canonicalizeTelegramChatId('0'), '0');
});

test('Unicode normalization is an identity transform on a valid id', () => {
  // This is the guarantee that lets NFKC run on real configuration: whatever
  // NFKC would do, it cannot move a well-formed id.
  for (const id of [GROUP, ADMIN, ADMIN_NEGATIVE, '1', '9999999999999']) {
    assert.strictEqual(id.normalize('NFKC'), id, id + ' must survive NFKC');
    assert.strictEqual(canonicalizeTelegramChatId(id), id);
  }
});

test('canonicalization is idempotent', () => {
  for (const input of [GROUP, '\u2212' + GROUP.slice(1), '  "' + GROUP + '"  ']) {
    const once = canonicalizeTelegramChatId(input);
    assert.strictEqual(canonicalizeTelegramChatId(once), once);
  }
});

// ---------------------------------------------------------------------------
// Unicode minus / dash variants
// ---------------------------------------------------------------------------

test('every Unicode minus/dash look-alike folds to ASCII "-"', () => {
  const variants = {
    'U+2010 HYPHEN': '\u2010',
    'U+2011 NON-BREAKING HYPHEN': '\u2011',
    'U+2012 FIGURE DASH': '\u2012',
    'U+2013 EN DASH': '\u2013',
    'U+2014 EM DASH': '\u2014',
    'U+2015 HORIZONTAL BAR': '\u2015',
    'U+2212 MINUS SIGN': '\u2212',
    'U+FE63 SMALL HYPHEN-MINUS': '\ufe63',
    'U+FF0D FULLWIDTH HYPHEN-MINUS': '\uff0d'
  };
  for (const [name, ch] of Object.entries(variants)) {
    assert.strictEqual(
      canonicalizeTelegramChatId(ch + GROUP.slice(1)),
      GROUP,
      name + ' must fold to ASCII "-"'
    );
  }
});

test('an interior Unicode dash is folded but still fails validation', () => {
  // Folding must not invent an id: "1-2" is not a chat id.
  assert.strictEqual(canonicalizeTelegramChatId('1\u22122'), null);
  assert.strictEqual(canonicalizeTelegramChatId('1\u20142'), null);
});

// ---------------------------------------------------------------------------
// Full-width digits
// ---------------------------------------------------------------------------

test('full-width digits fold to ASCII digits', () => {
  const pairs = [
    ['\uff10', '0'], ['\uff11', '1'], ['\uff12', '2'], ['\uff13', '3'],
    ['\uff14', '4'], ['\uff15', '5'], ['\uff16', '6'], ['\uff17', '7'],
    ['\uff18', '8'], ['\uff19', '9']
  ];
  for (const [fullWidth, ascii] of pairs) {
    assert.strictEqual(canonicalizeTelegramChatId(fullWidth), ascii);
  }
  const fullWidthGroup =
    '\uff0d\uff11\uff10\uff10\uff13\uff13\uff10\uff16\uff13\uff19\uff15\uff19\uff13\uff15';
  assert.strictEqual(canonicalizeTelegramChatId(fullWidthGroup), GROUP);
});

test('other digit systems are rejected rather than guessed', () => {
  // Only full-width forms are auto-folded. Arabic-Indic / Devanagari digits have
  // no Unicode compatibility mapping, so they cannot be silently mis-read.
  assert.strictEqual(canonicalizeTelegramChatId('\u0660\u0661\u0662'), null);
  assert.strictEqual(canonicalizeTelegramChatId('\u0966\u0967\u0968'), null);
});

// ---------------------------------------------------------------------------
// Invisible + control characters
// ---------------------------------------------------------------------------

test('invisible and control characters are removed wherever they appear', () => {
  const invisible = {
    'U+200B ZERO WIDTH SPACE': '\u200B',
    'U+200C ZWNJ': '\u200C',
    'U+200D ZWJ': '\u200D',
    'U+2060 WORD JOINER': '\u2060',
    'U+00AD SOFT HYPHEN': '\u00AD',
    'U+200E LEFT-TO-RIGHT MARK': '\u200E',
    'U+200F RIGHT-TO-LEFT MARK': '\u200F',
    'U+2066 LEFT-TO-RIGHT ISOLATE': '\u2066',
    'U+2067 RIGHT-TO-LEFT ISOLATE': '\u2067',
    'U+2069 POP DIRECTIONAL ISOLATE': '\u2069',
    'U+FEFF ZERO WIDTH NO-BREAK SPACE': '\uFEFF',
    'U+0000 NUL': '\u0000',
    'U+0007 BELL': '\u0007',
    'U+001B ESCAPE': '\u001B',
    'U+007F DELETE': '\u007F',
    'U+0085 NEXT LINE': '\u0085',
    'U+180E MONGOLIAN VOWEL SEPARATOR': '\u180E'
  };
  for (const [name, ch] of Object.entries(invisible)) {
    assert.strictEqual(canonicalizeTelegramChatId(ch + GROUP), GROUP, name + ' leading');
    assert.strictEqual(canonicalizeTelegramChatId(GROUP + ch), GROUP, name + ' trailing');
    assert.strictEqual(
      canonicalizeTelegramChatId('-100' + ch + '3306395935'),
      GROUP,
      name + ' interior'
    );
  }
});

test('invisible characters next to quotes and dashes are still removed', () => {
  assert.strictEqual(canonicalizeTelegramChatId('\u200B"\u201C' + GROUP + '\u201D"\uFEFF'), GROUP);
  assert.strictEqual(canonicalizeTelegramChatId('\u2212\u200B' + GROUP.slice(1)), GROUP);
});

// ---------------------------------------------------------------------------
// Whitespace
// ---------------------------------------------------------------------------

test('whitespace padding is removed around and inside the value', () => {
  const spaces = {
    SPACE: ' ',
    TAB: '\t',
    LINE_FEED: '\n',
    CARRIAGE_RETURN: '\r',
    'U+00A0 NBSP': '\u00A0',
    'U+3000 IDEOGRAPHIC SPACE': '\u3000',
    'U+2000 EN QUAD': '\u2000',
    'U+202F NARROW NBSP': '\u202F',
    'U+2028 LINE SEPARATOR': '\u2028',
    'U+2029 PARAGRAPH SEPARATOR': '\u2029'
  };
  for (const [name, ch] of Object.entries(spaces)) {
    assert.strictEqual(canonicalizeTelegramChatId(ch + GROUP + ch), GROUP, name + ' padding');
    assert.strictEqual(
      canonicalizeTelegramChatId('-100' + ch + '3306395935'),
      GROUP,
      name + ' interior'
    );
  }
});

test('a separator inside a single value collapses (documented trade-off)', () => {
  // A single-value env var cannot hold two ids, and no legitimate id contains
  // whitespace, so the separator is dropped. The result is still validated.
  assert.strictEqual(canonicalizeTelegramChatId('-1 2'), '-12');
  assert.strictEqual(canonicalizeTelegramChatId('" ' + GROUP + ' "'), GROUP);
});

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

test('ASCII and Unicode quote wrapping is stripped', () => {
  const quoteChars = [
    '"', "'",
    '\u2018', '\u2019', '\u201C', '\u201D', '\u201A', '\u201E',
    '\u2039', '\u203A', '\u00AB', '\u00BB',
    '\u300C', '\u300D', '\u300E', '\u300F',
    '\uFE41', '\uFE42', '\uFE43', '\uFE44',
    '\uFF02', '\uFF07'
  ];
  for (const q of quoteChars) {
    assert.strictEqual(canonicalizeTelegramChatId(q + GROUP + q), GROUP, 'paired ' + q);
  }
});

test('asymmetric, mismatched, doubled and padded quoting is stripped', () => {
  assert.strictEqual(canonicalizeTelegramChatId('\u201C' + GROUP + '\u201D'), GROUP, 'curly');
  assert.strictEqual(canonicalizeTelegramChatId('\u00AB' + GROUP + '\u00BB'), GROUP, 'guillemets');
  assert.strictEqual(canonicalizeTelegramChatId('\u300C' + GROUP + '\u300D'), GROUP, 'CJK');
  assert.strictEqual(canonicalizeTelegramChatId('\u300E' + GROUP + '\u300F'), GROUP, 'CJK white');
  assert.strictEqual(canonicalizeTelegramChatId('\u201A' + GROUP + '\u201E'), GROUP, 'low quotes');
  assert.strictEqual(canonicalizeTelegramChatId('\uFE41' + GROUP + '\uFE42'), GROUP, 'presentation');
  assert.strictEqual(canonicalizeTelegramChatId('"' + GROUP + "'"), GROUP, 'mismatched ASCII');
  assert.strictEqual(canonicalizeTelegramChatId('""' + GROUP + '""'), GROUP, 'doubled');
  assert.strictEqual(canonicalizeTelegramChatId('  "\u201C' + GROUP + '\u201D"  '), GROUP, 'nested+padded');
});

test('a quoted admin id keeps its sign after unwrapping', () => {
  assert.strictEqual(canonicalizeTelegramChatId('"' + ADMIN_NEGATIVE + '"'), ADMIN_NEGATIVE);
  assert.strictEqual(canonicalizeTelegramChatId('\u201C' + ADMIN_NEGATIVE + '\u201D'), ADMIN_NEGATIVE);
});

// ---------------------------------------------------------------------------
// Validation / rejection
// ---------------------------------------------------------------------------

test('the canonical form is pinned to ^-?\\d+$', () => {
  assert.strictEqual(TELEGRAM_CHAT_ID_FORMAT.source, '^-?\\d+$');
  assert.ok(TELEGRAM_CHAT_ID_FORMAT.test(GROUP));
  assert.ok(TELEGRAM_CHAT_ID_FORMAT.test(ADMIN));
  assert.ok(TELEGRAM_CHAT_ID_FORMAT.test(ADMIN_NEGATIVE));
  assert.ok(!TELEGRAM_CHAT_ID_FORMAT.test('1a'));
  assert.ok(!TELEGRAM_CHAT_ID_FORMAT.test('a1'));
  assert.ok(!TELEGRAM_CHAT_ID_FORMAT.test('-'));
  assert.ok(!TELEGRAM_CHAT_ID_FORMAT.test(''));
});

test('anything that is not an optional minus plus digits is rejected as null', () => {
  const rejected = [
    '', '   ', '""', "''", '-', '+123', '--1', '1-2', '1.5', '1e5', '0x10',
    'hello', '123abc', 'abc123', '\u0660\u0661', undefined, null
  ];
  for (const bad of rejected) {
    assert.strictEqual(canonicalizeTelegramChatId(bad), null, 'must reject ' + JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Applied to the two configuration env vars
// ---------------------------------------------------------------------------

test('resolveTelegramConfig canonicalizes TELEGRAM_SUPPORT_CHAT_ID', () => {
  const unicodeMinus = '\u2212' + GROUP.slice(1);
  assert.strictEqual(
    resolveTelegramConfig({ TELEGRAM_SUPPORT_CHAT_ID: unicodeMinus }).supportChatId,
    GROUP
  );
  assert.strictEqual(
    resolveTelegramConfig({ TELEGRAM_SUPPORT_CHAT_ID: '"' + GROUP + '"' }).supportChatId,
    GROUP
  );
  assert.strictEqual(
    resolveTelegramConfig({ TELEGRAM_SUPPORT_CHAT_ID: '  ' + GROUP + '  ' }).supportChatId,
    GROUP
  );
  assert.strictEqual(resolveTelegramConfig({ TELEGRAM_SUPPORT_CHAT_ID: '' }).supportChatId, null);
  assert.strictEqual(
    resolveTelegramConfig({ TELEGRAM_SUPPORT_CHAT_ID: '   ' }).supportChatId,
    null,
    'blank stays unset (pre-existing behaviour)'
  );
  assert.strictEqual(
    resolveTelegramConfig({ TELEGRAM_SUPPORT_CHAT_ID: 'not-an-id' }).supportChatId,
    null,
    'an unrepairable value is treated as unconfigured, not as a value that can never match'
  );
});

test('parseAdminIds canonicalizes every entry and drops unrepairable ones', () => {
  const fullWidthAdmin = '\uff16\uff10\uff15\uff14\uff16\uff12\uff15\uff18\uff11\uff18';
  assert.notStrictEqual(fullWidthAdmin, ADMIN, 'fixture is genuinely full-width');
  assert.deepStrictEqual(
    parseAdminIds(' ' + ADMIN + ' ,\u2212' + ADMIN_NEGATIVE.slice(1) + ' , junk, "" '),
    [ADMIN, ADMIN_NEGATIVE]
  );
  assert.deepStrictEqual(parseAdminIds(fullWidthAdmin), [ADMIN]);
  // A CJK paste may separate entries with a full-width or small comma; the
  // separator is folded before splitting so no admin is silently lost.
  assert.deepStrictEqual(parseAdminIds(ADMIN + '\uFF0C999'), [ADMIN, '999']);
  assert.deepStrictEqual(parseAdminIds(ADMIN + '\uFE50999'), [ADMIN, '999']);
  assert.deepStrictEqual(parseAdminIds('"\u201C' + ADMIN + '\u201D"'), [ADMIN]);
  assert.deepStrictEqual(parseAdminIds(''), []);
  assert.deepStrictEqual(parseAdminIds(' , , '), []);
  assert.deepStrictEqual(parseAdminIds(null), []);
  assert.deepStrictEqual(parseAdminIds(undefined), []);
  // Entries stay strings, never numbers.
  for (const id of parseAdminIds(ADMIN)) assert.strictEqual(typeof id, 'string');
});

test('a legacy-quoted value still resolves as before (no regression)', () => {
  const cfg = resolveTelegramConfig({
    TELEGRAM_SUPPORT_CHAT_ID: '"' + GROUP + '"',
    TELEGRAM_ADMIN_IDS: '"' + ADMIN + '", 999'
  });
  assert.strictEqual(cfg.supportChatId, GROUP);
  assert.deepStrictEqual(cfg.adminIds, [ADMIN, '999']);
});

test('the legacy normalizeTelegramId contract is unchanged', () => {
  // Existing callers/tests depend on this exact behaviour (including '' -> '').
  assert.strictEqual(normalizeTelegramId('"-1001234567890"'), '-1001234567890');
  assert.strictEqual(normalizeTelegramId("'6054625818'"), ADMIN);
  assert.strictEqual(normalizeTelegramId('  -1001234567890  '), '-1001234567890');
  assert.strictEqual(normalizeTelegramId(''), '');
  assert.strictEqual(normalizeTelegramId(null), '');
  assert.strictEqual(normalizeTelegramId(undefined), '');
});

// ---------------------------------------------------------------------------
// A repaired config matches a REAL Telegram update
// ---------------------------------------------------------------------------

test('a mangled configured id still matches a real Telegram update', () => {
  const cfg = resolveTelegramConfig({
    TELEGRAM_SUPPORT_CHAT_ID: '\u2212' + GROUP.slice(1), // Unicode minus pasted
    TELEGRAM_ADMIN_IDS: '\uff16\uff10\uff15\uff14\uff16\uff12\uff15\uff18\uff11\uff18'
  });
  const update = {
    update_id: 1,
    message: {
      message_id: 2,
      chat: { id: Number(GROUP), type: 'supergroup', title: 'Arbitrix Support' },
      from: { id: Number(ADMIN) },
      text: '/chatid'
    }
  };
  const routed = routeUpdate(update, cfg);
  assert.strictEqual(routed.kind, 'group', 'the support group must be recognised');
  assert.strictEqual(routed.chatId, GROUP);
  assert.strictEqual(routed.isAdmin, true, 'the full-width admin id was canonicalized too');
});

// ---------------------------------------------------------------------------
// Configuration-only: incoming update ids are never rewritten
// ---------------------------------------------------------------------------

test('canonicalization is referenced only from configuration resolution', () => {
  // definition + doc mention + exactly the two config call sites
  const occurrences = SOURCE.match(/canonicalizeTelegramChatId\(/g) || [];
  assert.strictEqual(occurrences.length, 4, 'definition, doc, and 2 call sites');

  const parseBody = SOURCE.slice(SOURCE.indexOf('function parseAdminIds('));
  const parseSlice = parseBody.slice(0, parseBody.indexOf('\n}'));
  assert.ok(parseSlice.includes('canonicalizeTelegramChatId('), 'parseAdminIds canonicalizes entries');

  const cfgStart = SOURCE.indexOf('function resolveTelegramConfig(');
  const cfgSlice = SOURCE.slice(cfgStart, SOURCE.indexOf('\n}', cfgStart));
  assert.ok(cfgSlice.includes('canonicalizeTelegramChatId(e.TELEGRAM_SUPPORT_CHAT_ID)'));
  assert.ok(!cfgSlice.includes('normalizeTelegramId(e.TELEGRAM_SUPPORT_CHAT_ID)'));
});

test('routeUpdate reads update ids verbatim and never canonicalizes them', () => {
  const start = SOURCE.indexOf('function routeUpdate(');
  const body = SOURCE.slice(start, SOURCE.indexOf('function createUpdateDeduper(', start));
  assert.ok(body.length > 0, 'routeUpdate found');
  assert.ok(
    !body.includes('canonicalizeTelegramChatId'),
    'an incoming update id must never be rewritten'
  );
  assert.ok(body.includes('String(message.chat.id)'), 'chat id is taken straight off the update');
  assert.ok(body.includes('String(from.id)'), 'from id is taken straight off the update');
});

test('a plain ASCII update id is unaffected by the canonicalizer', () => {
  // Idempotence proof for the update path: the value Telegram sends is already
  // canonical, so even if it were passed through, nothing would change.
  assert.strictEqual(canonicalizeTelegramChatId(String(Number(GROUP))), GROUP);
  assert.strictEqual(canonicalizeTelegramChatId(String(Number(ADMIN))), ADMIN);
});
