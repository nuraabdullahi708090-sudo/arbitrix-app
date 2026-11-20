'use strict';

/**
 * Text fixtures for the tests.
 *
 * WHY THIS EXISTS: several suites pin the exact bytes of reviewed artifacts
 * (migrations 028/029, the legacy RLS file) or the exact byte length/line count
 * of them. A Windows checkout with `core.autocrlf=true` rewrites LF to CRLF in
 * the working tree, which changes `sha256` and `Buffer.byteLength` while the
 * committed content is unchanged - the suite then fails on Windows and passes on
 * Linux for a reason that has nothing to do with the code.
 *
 * `.gitattributes` (`* text=auto eol=lf`) prevents that for fresh checkouts.
 * This helper is the second layer: hashes are taken over the LF-normalised text,
 * so a tree that was already checked out with CRLF still verifies the CONTENT.
 * A real edit to a pinned file still changes the hash - only the line-ending
 * transport is ignored.
 *
 * Anything binary (images, video) must NOT go through here: read the Buffer and
 * hash that, so a line-ending rule can never mask a corrupted asset.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

/** Normalise CRLF and lone CR to LF. */
function toLf(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Read a UTF-8 text file with normalised line endings. */
function readLf(file) {
  return toLf(fs.readFileSync(file, 'utf8'));
}

/** sha256 of the LF-normalised text of a file. */
function sha256FileLf(file) {
  return crypto.createHash('sha256').update(readLf(file), 'utf8').digest('hex');
}

/** sha256 of a string that has already been read (also normalised). */
function sha256TextLf(text) {
  return crypto.createHash('sha256').update(toLf(text), 'utf8').digest('hex');
}

/** Byte length of the LF-normalised text. */
function byteLengthLf(text) {
  return Buffer.byteLength(toLf(text), 'utf8');
}

/** Line count of the LF-normalised text (same convention as split('\n').length). */
function lineCountLf(text) {
  return toLf(text).split('\n').length;
}

/** True when the working-tree file carries CRLF (a checkout artefact, not content). */
function hasCrlf(file) {
  return /\r\n/.test(fs.readFileSync(file, 'utf8'));
}

module.exports = { toLf, readLf, sha256FileLf, sha256TextLf, byteLengthLf, lineCountLf, hasCrlf };
