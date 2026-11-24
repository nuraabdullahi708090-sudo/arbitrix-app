'use strict';
/**
 * Markup integrity for the single-file SPA.
 *
 * The app is ~1.8 MB of HTML with a dozen inline <script> blocks, and several
 * blocks are adjacent (one closes, the next opens). Deleting a "debug" block
 * once removed the OPENING tag of the following block, so the whole main app
 * logic was parsed as text: the dashboard still rendered, but every value on it
 * was the static HTML default and no handler ran. Nothing caught it except a
 * browser.
 *
 * These checks are cheap, text-only and catch that class of edit.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const strip = (html) => html
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '');

test('every inline script block is opened and closed exactly once', () => {
  const opens = (INDEX.match(/<script\b/gi) || []).length;
  const closes = (INDEX.match(/<\/script>/gi) || []).length;
  assert.strictEqual(opens, closes, `unbalanced script tags: ${opens} open / ${closes} close`);
  assert.ok(opens >= 10, `expected the app's inline blocks, found ${opens}`);
});

test('no script tag literal hides inside another block', () => {
  // A `<script` written inside JS (comments, strings) shifts naive pairing and
  // makes every downstream "is this inside a script?" check wrong.
  const withoutBlocks = INDEX.replace(/<script[\s\S]*?<\/script>/gi, '');
  assert.strictEqual((withoutBlocks.match(/<script\b/gi) || []).length, 0,
    'a <script literal remains outside the blocks');
  assert.strictEqual((withoutBlocks.match(/<\/script>/gi) || []).length, 0,
    'a </script> literal remains outside the blocks');
});

test('stripping scripts and styles leaves no orphan closing tag', () => {
  const bare = strip(INDEX);
  assert.strictEqual((bare.match(/<\/script>/gi) || []).length, 0,
    'a script block ended early: its remainder leaked into the page markup');
});

test('the application config lives inside a script block, not in page text', () => {
  const bare = strip(INDEX);
  assert.ok(!/MIN_WITHDRAWAL\s*:/.test(bare), 'the APP config leaked out of its script block');
  assert.ok(!/const APP\s*=/.test(bare), 'the APP declaration leaked out of its script block');
});

test('the document closes normally after the last script block', () => {
  const tail = INDEX.trimEnd().slice(-120);
  assert.match(tail, /<\/body>\s*<\/html>$/);
});

test('each top-level block starts on its own line and none are empty', () => {
  const blocks = INDEX.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  assert.ok(blocks.length >= 10);
  for (const block of blocks) {
    if (/\ssrc=/.test(block)) continue; // external include, legitimately empty
    const body = block.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    assert.ok(body.length > 0, 'an inline script block is empty');
  }
});
