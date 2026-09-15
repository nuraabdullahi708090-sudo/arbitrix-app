'use strict';

/**
 * Telegram webhook-secret compatibility.
 *
 * Telegram's setWebhook `secret_token` accepts ONLY A-Z a-z 0-9 _ - (1-256
 * characters). Anything else is rejected with
 * "Bad Request: secret token contains illegal characters" - and Telegram then
 * KEEPS the previously registered webhook, so the bot silently stops receiving
 * updates while getMe/setWebhook look healthy.
 *
 * These tests pin the validation, the generator, the refusal to register an
 * invalid secret, the operator-facing reporting, and that no test ever prints a
 * secret value.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  TELEGRAM_SECRET_FORMAT,
  TELEGRAM_SECRET_ALPHABET,
  isValidTelegramWebhookSecret,
  generateTelegramWebhookSecret,
  describeTelegramWebhookSecret,
  resolveTelegramConfig,
  createTelegramSupportBot
} = require('../services/TelegramSupportService');

const ROOT = path.join(__dirname, '..');
const MODEL = '998877:MODEL-TOKEN';
const BASE_URL = 'https://arbitrix.pro';

function makeBot(env) {
  const calls = [];
  const transport = {
    async sendMessage() { return { message_id: 1 }; },
    async setWebhook(payload) { calls.push({ method: 'setWebhook', payload }); return true; },
    async getWebhookInfo() { calls.push({ method: 'getWebhookInfo' }); return { url: '' }; },
    async getMe() { return { id: 1, username: 'ArbitrixSupportBot' }; },
    getLastCall() { return null; }
  };
  const config = resolveTelegramConfig(env);
  const bot = createTelegramSupportBot({
    config,
    store: {},
    transport,
    logger: { log() {}, warn() {}, error() {} }
  });
  return { bot, calls, config };
}

// ---------------------------------------------------------------------------
// Charset contract
// ---------------------------------------------------------------------------

test('the accepted secret charset matches Telegram: A-Z a-z 0-9 _ - only', () => {
  assert.match(TELEGRAM_SECRET_ALPHABET, /^[A-Za-z0-9_-]+$/);
  assert.match('aZ09_-', TELEGRAM_SECRET_FORMAT);
  assert.doesNotMatch('secret+value', TELEGRAM_SECRET_FORMAT);
  assert.doesNotMatch('secret/value', TELEGRAM_SECRET_FORMAT);
  assert.doesNotMatch('secret=value', TELEGRAM_SECRET_FORMAT);
  assert.doesNotMatch('secret value', TELEGRAM_SECRET_FORMAT);
  assert.doesNotMatch('secret.value', TELEGRAM_SECRET_FORMAT);
  assert.doesNotMatch('sécret', TELEGRAM_SECRET_FORMAT);
  assert.doesNotMatch('', TELEGRAM_SECRET_FORMAT, 'empty is not valid');
  assert.doesNotMatch('a'.repeat(257), TELEGRAM_SECRET_FORMAT, 'over 256 chars is not valid');
  assert.ok(isValidTelegramWebhookSecret('a'.repeat(256)), '256 chars is the maximum');
});

test('a base64 secret (the documented misconfiguration) is rejected', () => {
  // `openssl rand -base64 32` style output - the exact shape that caused the
  // production incident.
  const base64Secret = 'kZ8vQ2mR7tLpX0aB4cD6eF9gH1jK3nP5sT7uV+W/xY=';
  assert.strictEqual(isValidTelegramWebhookSecret(base64Secret), false);

  const info = describeTelegramWebhookSecret(base64Secret);
  assert.strictEqual(info.validFormat, false);
  assert.ok(info.disallowedCharCount > 0);
  assert.deepStrictEqual(info.disallowedCharClasses, ['punctuation-or-symbol']);
  assert.ok(!JSON.stringify(info).includes(base64Secret), 'the value is never reported');
});

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

test('the generator can only produce Telegram-compatible secrets', () => {
  for (let i = 0; i < 200; i += 1) {
    const secret = generateTelegramWebhookSecret();
    assert.ok(isValidTelegramWebhookSecret(secret), 'generated secret must be valid');
    assert.strictEqual(secret.length, 48);
  }
});

test('the generator is long, random and honours the length bounds', () => {
  const a = generateTelegramWebhookSecret();
  const b = generateTelegramWebhookSecret();
  assert.notStrictEqual(a, b, 'two generated secrets must differ');

  const seen = new Set();
  for (let i = 0; i < 50; i += 1) seen.add(generateTelegramWebhookSecret(64));
  assert.strictEqual(seen.size, 50, 'no collisions');
  for (const value of seen) assert.strictEqual(value.length, 64);

  // Bounds: never below 32 (too short to be safe), never above Telegram's 256.
  assert.strictEqual(generateTelegramWebhookSecret(1).length, 32);
  assert.strictEqual(generateTelegramWebhookSecret(9999).length, 256);
  assert.strictEqual(generateTelegramWebhookSecret('nonsense').length, 48);

  // Uses the whole alphabet, so it is not accidentally hex or digit-only.
  const chars = new Set(generateTelegramWebhookSecret(256).split(''));
  assert.ok(chars.size > 32, `expected a wide alphabet, saw ${chars.size} distinct characters`);
});

// ---------------------------------------------------------------------------
// Registration refuses an invalid secret (fail-closed, loud)
// ---------------------------------------------------------------------------

test('registration refuses an invalid secret instead of letting Telegram answer opaquely', async () => {
  const { bot, calls } = makeBot({
    TELEGRAM_BOT_TOKEN: MODEL,
    TELEGRAM_WEBHOOK_SECRET: 'bad+secret/with=illegal',
    BASE_URL
  });

  const result = await bot.ensureWebhookRegistration({ force: true });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'invalid-webhook-secret-format');
  assert.strictEqual(result.reRegistered, false);
  assert.strictEqual(calls.filter((c) => c.method === 'setWebhook').length, 0,
    'setWebhook must NOT be called with an invalid secret');
  assert.match(result.hint, /generate-telegram-secret\.js/);
});

test('registration proceeds with a valid secret and sends it only to Telegram', async () => {
  const valid = generateTelegramWebhookSecret(64);
  const { bot, calls } = makeBot({
    TELEGRAM_BOT_TOKEN: MODEL,
    TELEGRAM_WEBHOOK_SECRET: valid,
    BASE_URL
  });

  const result = await bot.ensureWebhookRegistration({ force: true });
  assert.strictEqual(result.ok, true);

  const setWebhook = calls.find((c) => c.method === 'setWebhook');
  assert.ok(setWebhook, 'setWebhook was called');
  assert.strictEqual(setWebhook.payload.url, 'https://arbitrix.pro/api/telegram/webhook');
  assert.strictEqual(setWebhook.payload.secret_token, valid,
    'the secret is sent to Telegram, unchanged');
});

test('a secret wrapped in quotes is unwrapped before validation', () => {
  const config = resolveTelegramConfig({
    TELEGRAM_BOT_TOKEN: MODEL,
    TELEGRAM_WEBHOOK_SECRET: '"abcDEF0123_-xyz"',
    BASE_URL
  });
  assert.strictEqual(config.webhookSecret, 'abcDEF0123_-xyz');
  assert.strictEqual(config.webhookSecretValid, true);
});

test('a quoted secret containing illegal characters is still refused', () => {
  const config = resolveTelegramConfig({
    TELEGRAM_BOT_TOKEN: MODEL,
    TELEGRAM_WEBHOOK_SECRET: '"abc+def/ghi="',
    BASE_URL
  });
  assert.strictEqual(config.webhookSecretValid, false);
});

// ---------------------------------------------------------------------------
// Operator-facing reporting carries no secret
// ---------------------------------------------------------------------------

test('status reports secret validity as metadata only', () => {
  const { bot } = makeBot({
    TELEGRAM_BOT_TOKEN: MODEL,
    TELEGRAM_WEBHOOK_SECRET: 'has+illegal/chars=',
    BASE_URL
  });
  const status = bot.status();

  assert.strictEqual(status.webhookSecretConfigured, true);
  assert.strictEqual(status.webhookSecretFormatValid, false);
  assert.strictEqual(status.webhookSecretLength, 18);
  assert.ok(status.webhookSecretIssues);
  assert.strictEqual(status.webhookSecretIssues.validFormat, false);
  assert.ok(!JSON.stringify(status).includes('has+illegal/chars='), 'never returns the secret value');
});

test('the describe helper reports shape, not content', () => {
  const info = describeTelegramWebhookSecret('ab+cd');
  assert.deepStrictEqual(Object.keys(info).sort(), [
    'disallowedCharClasses', 'disallowedCharCount', 'hadSurroundingQuotes',
    'hadWhitespace', 'length', 'present', 'rawLength', 'validFormat', 'withinLengthLimit'
  ]);
  assert.strictEqual(info.length, 5);
  assert.strictEqual(info.disallowedCharCount, 1);
  assert.strictEqual(info.present, true);
  assert.strictEqual(info.validFormat, false);
  assert.ok(!JSON.stringify(info).includes('ab+cd'));
});

// ---------------------------------------------------------------------------
// CLI + documentation
// ---------------------------------------------------------------------------

test('the generator CLI prints a Telegram-compatible secret', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/generate-telegram-secret.js')], { encoding: 'utf8' }).trim();
  assert.ok(isValidTelegramWebhookSecret(out), 'CLI output must be valid');
  assert.ok(out.length >= 32);

  const longer = execFileSync(process.execPath, [path.join(ROOT, 'scripts/generate-telegram-secret.js'), '--length', '64'], { encoding: 'utf8' }).trim();
  assert.strictEqual(longer.length, 64);
  assert.ok(isValidTelegramWebhookSecret(longer));
});

test('the generator CLI --check reports validity without echoing the value', () => {
  const secret = 'aZ09_-secret';
  const out = execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts/generate-telegram-secret.js'), '--check', secret],
    { encoding: 'utf8' }
  );
  assert.match(out, /VALID/);
  assert.ok(!out.includes(secret), 'the checked value must not be echoed');
});

test('the generator CLI --check fails on an illegal secret', () => {
  let failed = false;
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts/generate-telegram-secret.js'), '--check', 'bad+base64/secret='],
      { encoding: 'utf8', stdio: 'pipe' }
    );
  } catch (error) {
    failed = true;
    out = String(error.stdout || '');
  }
  assert.ok(failed, 'an invalid secret must exit non-zero');
  assert.match(out, /INVALID/);
  assert.ok(!out.includes('bad+base64/secret='), 'the value must not be echoed');
});

test('.env.example documents the Telegram charset and warns against base64', () => {
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(env, /TELEGRAM_WEBHOOK_SECRET=/);
  assert.match(env, /only A-Z a-z 0-9 _ - are accepted/, 'charset documented');
  assert.match(env, /DO NOT use a base64 secret/, 'the base64 trap is called out');
  assert.match(env, /generate-telegram-secret\.js/, 'the generator is referenced');
  // The old, unsafe suggestion must be gone.
  assert.ok(!/openssl rand -hex 32` and configure/.test(env), 'old guidance removed');
});

test('the diagnose script reports secret format validity', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'diagnose-telegram.js'), 'utf8');
  assert.ok(script.includes('describeTelegramWebhookSecret'), 'uses the safe describer');
  assert.ok(script.includes('TELEGRAM_WEBHOOK_SECRET_FORMAT_VALID'), 'reports validity');
  assert.ok(script.includes('secret token contains illegal characters'), 'explains the failure');
});

test('server.js logs an actionable error when the secret is not Telegram-compatible', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(server.includes("result.reason === 'invalid-webhook-secret-format'"));
  assert.ok(server.includes('secretFormatValid'), 'boot log reports validity');
  assert.ok(server.includes('CONFIGURATION ERROR: TELEGRAM_WEBHOOK_SECRET is not'));
  assert.ok(server.includes('generate-telegram-secret.js'), 'points at the generator');
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

test('the fix touches no trading-worker or sandbox code', () => {
  const service = fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportService.js'), 'utf8');
  assert.ok(!/sandbox_/.test(service), 'the telegram service never touches sandbox tables');
  assert.ok(!/record_trade_safe|TradingWorker/.test(service), 'never touches the trading engine');

  const worker = fs.readFileSync(path.join(ROOT, 'services', 'TradingWorker.js'), 'utf8');
  assert.ok(!/TELEGRAM_WEBHOOK_SECRET|telegram/i.test(worker), 'the worker is untouched by telegram config');
});
