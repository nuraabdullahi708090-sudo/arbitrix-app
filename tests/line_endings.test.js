'use strict';

/**
 * LINE-ENDING INTEGRITY
 *
 * The suite pins the exact bytes of reviewed artifacts (migrations 028/029, the
 * legacy RLS file) and several suites assert source structure with `$`-anchored
 * multiline regexes. A Windows checkout with `core.autocrlf=true` rewrites LF to
 * CRLF in the working tree, which broke both classes of assertion while the
 * committed content was untouched.
 *
 * Two defences, both tested here:
 *   1. `.gitattributes` forces `eol=lf` for text and keeps binaries binary, so a
 *      fresh clone is identical on every platform.
 *   2. `tests/helpers/text.js` hashes/measures the LF-normalised text, so a tree
 *      that was ALREADY checked out with CRLF still verifies the CONTENT.
 *
 * This file proves the second defence cannot hide a real edit: the same pin is
 * checked against a CRLF-converted copy (must match) and against a mutated copy
 * (must differ).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { toLf, readLf, sha256TextLf, byteLengthLf, lineCountLf } = require('./helpers/text');

const ROOT = path.join(__dirname, '..');
const GITATTRIBUTES = path.join(ROOT, '.gitattributes');

// The pins under test (reviewed, approved content).
const MIG_028 = 'supabase/migrations/028_trading_worker.sql';
const MIG_029 = 'supabase/migrations/029_bot_session_lease.sql';
const SHA_028 = 'e711af83e21cbb7dd53495b94685a74b8fe8897a651ff3a47b87f394246ef0dc';
const SHA_029 = 'f566fa51a7c0a13ce314ee7fd4af71ae721b516d5c22c3f5658243e22d7ceb8a';

test('.gitattributes normalises text to LF and never touches binaries', () => {
  assert.ok(fs.existsSync(GITATTRIBUTES), '.gitattributes must exist so a Windows clone is identical');
  const spec = fs.readFileSync(GITATTRIBUTES, 'utf8');
  assert.match(spec, /^\* text=auto eol=lf$/m, 'text files must be checked out with LF');
  for (const ext of ['png', 'jpg', 'mp4']) {
    assert.match(spec, new RegExp('^\\*\\.' + ext + '\\s+binary$', 'm'),
      ext + ' must stay binary: "text=auto" would corrupt it');
  }
  assert.match(spec, /^\*\.sh text eol=lf$/m, 'shell scripts must keep LF on Windows');
});

test('the helper folds CRLF and lone CR to LF', () => {
  assert.strictEqual(toLf('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.strictEqual(toLf('no newline'), 'no newline');
  assert.strictEqual(toLf(''), '');
});

test('a CRLF working tree verifies the same content as an LF one', () => {
  const lf = readLf(path.join(ROOT, MIG_028));
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.notStrictEqual(crlf, lf, 'the fixture must really differ in bytes');

  assert.strictEqual(sha256TextLf(crlf), sha256TextLf(lf),
    'a CRLF checkout must hash to the same value as the committed LF content');
  assert.strictEqual(sha256TextLf(lf), SHA_028, 'the approved content still matches its pin');
  assert.strictEqual(byteLengthLf(crlf), byteLengthLf(lf), 'byte length is measured after folding');
  assert.strictEqual(lineCountLf(crlf), lineCountLf(lf), 'line count is measured after folding');

  const lf29 = readLf(path.join(ROOT, MIG_029));
  assert.strictEqual(sha256TextLf(lf29.replace(/\n/g, '\r\n')), SHA_029);
});

test('normalisation can NOT hide a real edit to a pinned migration', () => {
  const lf = readLf(path.join(ROOT, MIG_028));

  // (a) ONE character changed, same length: the smallest edit that must fail.
  const at = lf.search(/[A-Za-z]/);
  assert.ok(at >= 0, 'the migration must contain a letter to mutate');
  const flipped = lf.slice(0, at) + (lf[at] === 'Q' ? 'Z' : 'Q') + lf.slice(at + 1);
  assert.notStrictEqual(flipped, lf);
  assert.strictEqual(byteLengthLf(flipped), byteLengthLf(lf), 'same length, by construction');
  assert.notStrictEqual(sha256TextLf(flipped), SHA_028,
    'an edited migration must NOT match the approved hash');
  assert.notStrictEqual(sha256TextLf(flipped.replace(/\n/g, '\r\n')), SHA_028,
    'the same edit with CRLF must NOT match either');

  // (b) An insertion changes the length too: the byte-length tripwire catches it.
  const grown = lf.slice(0, 200) + ' ' + lf.slice(200);
  assert.notStrictEqual(sha256TextLf(grown), SHA_028);
  assert.notStrictEqual(byteLengthLf(grown), byteLengthLf(lf));
});

test('every test that pins a file hash reads it through the helper', () => {
  // A future edit that reverts one of these to a raw read would silently
  // reintroduce the Windows failure.
  const pinnedReaders = [
    'tests/trading_worker_lease_integration.test.js',
    'tests/phase5_cleanup.test.js',
  ];
  for (const rel of pinnedReaders) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(src, /require\('\.\/helpers\/text'\)/, rel + ' must use the LF-safe helper');
    assert.ok(!/createHash\('sha256'\)\.update\(\s*fs\.readFileSync/.test(src),
      rel + ' must not hash a raw read');
  }
});

test('the pinned migrations are LF in the committed blob (git eol attribute is in force)', () => {
  // Independent of the local checkout: ask git what it has stored. `i/lf` means
  // the index holds LF, so the repository itself is normalised.
  const { execFileSync } = require('node:child_process');
  let out;
  try {
    out = execFileSync('git', ['ls-files', '--eol', MIG_028, MIG_029], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    // A shallow/absent git checkout must not fail the suite.
    return;
  }
  for (const line of out.trim().split('\n')) {
    assert.match(line, /\bi\/lf\b/, 'the index must store LF for ' + line.split(/\s+/).pop());
  }
});
