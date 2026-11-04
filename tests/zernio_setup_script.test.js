'use strict';

/**
 * The setup script is the only thing an operator runs against the live Zernio
 * account, so its two safety properties are pinned here:
 *   1. it refuses to run without a key and never prints one;
 *   2. it never ACTIVATES a follow-up sequence before every template for that
 *      language is APPROVED by Meta.
 *
 * The second is the one that matters: activating early would make the first
 * follow-up send a PENDING template hours after the customer's message.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'zernio-setup.js');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-zernio-preload.js');

function run(args, extraEnv) {
  const logPath = path.join(os.tmpdir(), `zernio-setup-${process.pid}-${Date.now()}.jsonl`);
  fs.writeFileSync(logPath, '');
  const env = Object.assign({}, process.env, {
    NODE_ENV: 'test',
    ZERNIO_API_KEY: 'fake-zernio-key',
    ZERNIO_PROFILE_ID: 'prof-1',
    ZERNIO_WHATSAPP_ACCOUNT_ID: 'acc-1',
    ZERNIO_FAKE_LOG: logPath,
    NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD)
  }, extraEnv || {});

  const result = spawnSync(process.execPath, [SCRIPT].concat(args), {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 20000
  });
  try {
    fs.unlinkSync(logPath);
  } catch (error) {
    // best effort
  }
  return result;
}

test('the setup script prints help without needing credentials', () => {
  const result = run(['--help'], { ZERNIO_API_KEY: '' });
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /inspect \(read-only\)/);
  assert.match(result.stdout, /--activate-sequences/);
});

test('the setup script refuses to run without an API key and reveals nothing', () => {
  const result = run([], { ZERNIO_API_KEY: '' });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /ZERNIO_API_KEY is not set/);
  assert.doesNotMatch(result.stderr, /sk_/);
});

test('--apply creates templates and sequences as DRAFT, never activated', () => {
  const result = run(['--apply', '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);

  assert.strictEqual(report.mode, 'apply');
  const actions = report.actions.map((entry) => entry.action);
  assert.ok(actions.includes('custom_field_created'), actions.join(','));
  assert.ok(actions.includes('template_submitted'), actions.join(','));
  assert.ok(actions.includes('sequence_created_draft'), actions.join(','));
  assert.ok(actions.includes('sequence_left_draft'), actions.join(','));
  assert.ok(!actions.includes('sequence_activated'), 'must not activate without approval');

  for (const template of report.templatesRequired) {
    assert.strictEqual(template.status, 'MISSING');
  }
});

test('--activate-sequences still refuses while templates are not APPROVED', () => {
  const result = run(['--apply', '--activate-sequences', '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);

  const actions = report.actions.map((entry) => entry.action);
  assert.ok(!actions.includes('sequence_activated'), 'activation must be gated on approval');
  assert.ok(
    report.warnings.some((warning) => /NOT activated: templates are not all APPROVED/.test(warning)),
    JSON.stringify(report.warnings)
  );
});

test('the report never contains the API key', () => {
  for (const args of [[], ['--json'], ['--apply', '--json']]) {
    const result = run(args);
    const combined = String(result.stdout) + String(result.stderr);
    assert.ok(!combined.includes('fake-zernio-key'), combined.slice(0, 400));
  }
});
