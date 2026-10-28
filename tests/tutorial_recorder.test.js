'use strict';

/**
 * The tutorial recorder is a working tool, not a runtime dependency, so nothing
 * else in the suite would notice if its safety defaults drifted. These tests pin
 * the parts that make a recording honest: the placeholder data is self-labelling,
 * the disclosure badge is on by default for stub recordings, the verifier really
 * checks narration and scene changes, and the tooling can never publish anything.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'scripts', 'tutorial');
const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');

const RECORD = read('record.js');
const BUILD = read('build.js');
const NARRATE = read('narrate.js');
const README = read('README.md');
const SCENES = JSON.parse(read('scenes.json'));

test('the scene list is complete and sells nothing', () => {
  assert.strictEqual(SCENES.scenes.length, 8);
  assert.deepStrictEqual(SCENES.scenes.map((s) => s.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const scene of SCENES.scenes) {
    assert.ok(scene.say && scene.say.length > 40, 'scene ' + scene.id + ' has narration');
    assert.ok(scene.caption && scene.caption.length > 5, 'scene ' + scene.id + ' has a caption');
    assert.ok(!/guaranteed|risk[- ]free|assured profit|passive income|lifetime commission/i.test(scene.say),
      'scene ' + scene.id + ' makes no promise');
  }
  // the withdrawal minimum must not be advertised: it is disclosed only in the
  // withdrawal pop-up for an already-eligible account.
  assert.ok(!SCENES.scenes.some((s) => /\$?700/.test(s.say)), 'no withdrawal minimum in the narration');
  assert.strictEqual(SCENES.voice, 'en-US-AriaNeural');
});

test('stub recordings are labelled by default', () => {
  assert.match(RECORD, /args\.disclosure = args\.mode === 'stub';/);
  assert.match(RECORD, /Simulated data - not a real payment/);
  assert.match(RECORD, /#recDisclosure/);
});

test('the fake invoice cannot be mistaken for a real destination', () => {
  assert.match(RECORD, /id: 'DEMO-INVOICE-0001'/);
  assert.match(RECORD, /payoutAddress: 'TDEMONSTRATIONONLYDONOTSEND/);
  assert.match(RECORD, /tutorial@example\.invalid/);
});

test('live mode requires a real session and refuses to record without one', () => {
  assert.match(RECORD, /--storage-state/);
  assert.match(RECORD, /did not reach the dashboard/);
  assert.match(RECORD, /Nothing was recorded/);
  assert.match(RECORD, /if \(args\.mode === 'live' && !args\.url\) args\.url = 'https:\/\/arbitrix\.pro';/);
  // a password must never be a supported input
  assert.ok(!/--password|--email\b/.test(RECORD), 'no credential flags');
});

test('the recorder cannot move money', () => {
  for (const forbidden of ['/api/withdraw', 'sendTransaction', 'tronweb', 'TronWeb', '/api/admin', '/api/bot/start']) {
    assert.ok(!RECORD.includes(forbidden), 'record.js must not reference ' + forbidden);
  }
  // it demonstrates the deposit screen; it never confirms or credits anything
  assert.ok(!/status\s*=\s*['"]confirmed/.test(RECORD), 'never forges a confirmed status');
});

test('the verifier checks decoding, codecs, duration, narration and scene changes', () => {
  assert.match(BUILD, /decodes without errors/);
  assert.match(BUILD, /pix_fmt=yuv420p/);
  assert.match(BUILD, /audio stream present/);
  assert.match(BUILD, /duration within 2s of the plan/);
  assert.match(BUILD, /narration present in every scene/);
  assert.match(BUILD, /mean_volume/);
  assert.match(BUILD, /every scene is visually distinct/);
  // a failing check must fail the run
  assert.match(BUILD, /return failed === 0 \? 0 : 1;/);
});

test('share copies target WhatsApp and Telegram and carry a caption', () => {
  assert.match(BUILD, /-whatsapp\.mp4/);
  assert.match(BUILD, /-telegram\.mp4/);
  assert.match(BUILD, /caption\.txt/);
  assert.match(BUILD, /\+faststart/);
  assert.match(BUILD, /Trading involves risk/);
  assert.match(BUILD, /https:\/\/t\.me\/ArbitrixSupportBot/);
  assert.ok(!/guaranteed|risk[- ]free|assured profit/i.test(BUILD), 'no promise language in the caption');
});

test('the tooling never writes into the published asset directory', () => {
  // record.js READS public/ to serve the shipped page locally; nothing may write there.
  for (const source of [RECORD, BUILD, NARRATE]) {
    assert.ok(!/writeFileSync\([^)]*PUBLIC_DIR/.test(source), 'no write into public/');
    assert.ok(!/createWriteStream\([^)]*PUBLIC_DIR/.test(source), 'no stream into public/');
    assert.ok(!source.includes("'public', 'video'"), 'no path into public/video');
    assert.ok(!/copyFileSync|cp -r|fs\.cpSync/.test(source), 'no copy helper');
  }
  assert.match(README, /Do not\*\* copy the result into `public\/video\/`/);
  assert.match(README, /needs explicit authorisation/i);
});

test('the README states which mode is publishable', () => {
  assert.match(README, /stub \(default\)/);
  assert.match(README, /MARKETING_SANDBOX/);
  assert.match(README, /No\.\*\* Internal draft only/);
  assert.match(README, /never send a password/i);
});

test('optional dev tools are loaded lazily, so the scripts run without them', () => {
  assert.match(RECORD, /function loadPuppeteer/);
  assert.match(RECORD, /puppeteer-core is required to record/);
  assert.match(NARRATE, /msedge-tts is not installed/);
  for (const file of ['record.js', 'narrate.js', 'build.js']) {
    const out = execFileSync(process.execPath, [path.join(DIR, file), '--help'], { encoding: 'utf8' });
    assert.ok(out.length > 40, file + ' prints usage without optional dependencies');
  }
});

test('pipeline inputs and outputs live under build/, never in git', () => {
  assert.match(RECORD, /build', 'video', 'deposit-tutorial/);
  assert.match(BUILD, /build', 'video', 'deposit-tutorial/);
  assert.match(README, /not\*\* committed|not committed/i);
});
