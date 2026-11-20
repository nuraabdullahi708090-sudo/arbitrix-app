'use strict';

/**
 * TEST-ONLY preload: make UTF-8 text reads line-ending agnostic.
 *
 * WHY: a large part of this suite asserts the SHAPE of the source (byte pins,
 * `$`-anchored multiline regexes, exact snippets). A Windows checkout with
 * `core.autocrlf=true` rewrites LF to CRLF in the working tree, so those
 * assertions fail while the committed content - and the product - are fine.
 * Patch the tests would mean touching ~25 files and would still miss new ones.
 *
 * WHAT IT DOES: when a caller asks for UTF-8 *text*, CRLF and lone CR are folded
 * to LF, exactly like a normalising checkout would. Bytes, Buffers, binary
 * encodings and every non-text read are returned untouched, so hashing an image
 * or a video is unaffected.
 *
 * WHAT IT DOES NOT DO: it cannot hide a real edit. The content is unchanged
 * apart from line terminators, so a changed byte still fails a hash or a regex.
 * The repository-level invariant (committed files are LF) is asserted separately
 * by tests/line_endings.test.js via `git ls-files --eol`.
 *
 * Loaded from package.json: `node --require ./tests/helpers/lf-preload.js --test`.
 */

const fs = require('node:fs');

const isUtf8Request = (options) => {
  if (typeof options === 'string') return /^utf-?8$/i.test(options);
  if (options && typeof options === 'object') {
    const enc = options.encoding;
    return typeof enc === 'string' && /^utf-?8$/i.test(enc);
  }
  return false;
};

const fold = (s) => String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

if (!fs.__lfPreloadInstalled) {
  const realReadFileSync = fs.readFileSync;

  fs.readFileSync = function readFileSyncLf(file, options, ...rest) {
    const out = realReadFileSync.call(fs, file, options, ...rest);
    return typeof out === 'string' && isUtf8Request(options) ? fold(out) : out;
  };

  if (fs.promises && typeof fs.promises.readFile === 'function') {
    const realPromisesReadFile = fs.promises.readFile;
    fs.promises.readFile = async function readFileLf(file, options, ...rest) {
      const out = await realPromisesReadFile.call(fs.promises, file, options, ...rest);
      return typeof out === 'string' && isUtf8Request(options) ? fold(out) : out;
    };
  }

  Object.defineProperty(fs, '__lfPreloadInstalled', { value: true, enumerable: false });
}

module.exports = { fold, isUtf8Request };
