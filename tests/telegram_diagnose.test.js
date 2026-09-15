'use strict';

/**
 * Telegram setWebhook 404 diagnostic + token normalization.
 *
 * A Telegram Bot API 404 "Not Found" is caused by a MALFORMED token value
 * (surrounding quotes, a leading `bot` prefix pasted from an API URL, inner
 * whitespace, a missing colon), while an unknown-but-well-formed token gets 401
 * "Unauthorized". These tests pin:
 *   - the normalization that repairs the formatting without changing the
 *     credential,
 *   - the shape descriptor / probe that report only non-secret facts,
 *   - the admin-gated diagnostic route and standalone script wiring.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'diagnose-telegram.js'), 'utf8');

const {
  normalizeTelegramToken,
  isValidTelegramToken,
  findTelegramTokenKeyVariants,
  describeTelegramToken,
  resolveTelegramConfig,
  probeTelegramMethod,
  summarizeTelegramBot,
  summarizeTelegramWebhook
} = require('../services/TelegramSupportService');

const { buildReport, verdict } = require('../scripts/diagnose-telegram.js');

// A syntactically valid but entirely fake BotFather-shaped token.
const GOOD_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const SAFE_DESCRIPTOR_KEYS = [
  'present', 'length', 'rawLength', 'hadSurroundingQuotes', 'hadLeadingWhitespace',
  'hadTrailingWhitespace', 'hadInnerWhitespace', 'hadBotPrefix',
  'changedByNormalization', 'validFormat'
];

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body
  };
}

// ---------------------------------------------------------------------------
// Normalization (formatting repair only - never a rotation)
// ---------------------------------------------------------------------------

test('normalizeTelegramToken strips surrounding double and single quotes', () => {
  assert.strictEqual(normalizeTelegramToken('"' + GOOD_TOKEN + '"'), GOOD_TOKEN);
  assert.strictEqual(normalizeTelegramToken("'" + GOOD_TOKEN + "'"), GOOD_TOKEN);
});

test('normalizeTelegramToken strips a leading bot prefix pasted from an API URL', () => {
  assert.strictEqual(normalizeTelegramToken('bot' + GOOD_TOKEN), GOOD_TOKEN);
  assert.strictEqual(normalizeTelegramToken('"bot' + GOOD_TOKEN + '"'), GOOD_TOKEN);
  assert.strictEqual(normalizeTelegramToken("'bot" + GOOD_TOKEN + "'"), GOOD_TOKEN);
});

test('normalizeTelegramToken trims whitespace and leaves a clean token unchanged', () => {
  assert.strictEqual(normalizeTelegramToken('  ' + GOOD_TOKEN + '\n'), GOOD_TOKEN);
  assert.strictEqual(normalizeTelegramToken(GOOD_TOKEN), GOOD_TOKEN);
});

test('normalizeTelegramToken is safe for empty input', () => {
  assert.strictEqual(normalizeTelegramToken(null), '');
  assert.strictEqual(normalizeTelegramToken(undefined), '');
  assert.strictEqual(normalizeTelegramToken('   '), '');
  assert.strictEqual(normalizeTelegramToken('""'), '');
});

test('resolveTelegramConfig normalizes a quoted env token without altering a clean one', () => {
  assert.strictEqual(resolveTelegramConfig({ TELEGRAM_BOT_TOKEN: '"' + GOOD_TOKEN + '"' }).token, GOOD_TOKEN);
  assert.strictEqual(resolveTelegramConfig({ TELEGRAM_BOT_TOKEN: GOOD_TOKEN }).token, GOOD_TOKEN);
});

test('resolveTelegramConfig strips surrounding quotes from the webhook secret', () => {
  assert.strictEqual(resolveTelegramConfig({ TELEGRAM_WEBHOOK_SECRET: '"abc-def"' }).webhookSecret, 'abc-def');
});

test('isValidTelegramToken accepts the BotFather shape and rejects malformed values', () => {
  assert.strictEqual(isValidTelegramToken(GOOD_TOKEN), true);
  assert.strictEqual(isValidTelegramToken('123456789'), false, 'no colon');
  assert.strictEqual(isValidTelegramToken('abc:def'), false, 'not a bot id');
  assert.strictEqual(isValidTelegramToken('123456789:short'), false, 'secret too short');
  assert.strictEqual(isValidTelegramToken(''), false);
});

test('findTelegramTokenKeyVariants reports case-variant keys and never the canonical one', () => {
  const env = { TELEGRAM_BOT_TOKEN: GOOD_TOKEN, telegram_bot_token: 'other', Telegram_Bot_Token: 'x', OTHER: 'y' };
  assert.deepStrictEqual(findTelegramTokenKeyVariants(env).sort(), ['Telegram_Bot_Token', 'telegram_bot_token']);
  assert.deepStrictEqual(findTelegramTokenKeyVariants({ TELEGRAM_BOT_TOKEN: GOOD_TOKEN }), []);
  assert.deepStrictEqual(findTelegramTokenKeyVariants({}), []);
});

// ---------------------------------------------------------------------------
// Shape descriptor - reports booleans/lengths ONLY, never the value
// ---------------------------------------------------------------------------

test('describeTelegramToken reports only the whitelisted non-secret fields', () => {
  const shape = describeTelegramToken(GOOD_TOKEN);
  assert.deepStrictEqual(Object.keys(shape).sort(), SAFE_DESCRIPTOR_KEYS.slice().sort());
  for (const value of Object.values(shape)) {
    assert.ok(typeof value === 'boolean' || typeof value === 'number', 'only booleans/numbers are reported');
  }
});

test('describeTelegramToken never contains any character of the token', () => {
  const quoted = '"bot' + GOOD_TOKEN + '"';
  const serialized = JSON.stringify(describeTelegramToken(quoted));
  assert.ok(!serialized.includes(GOOD_TOKEN), 'the token value must never appear in the descriptor');
  assert.ok(!serialized.includes('123456789'), 'not even the bot id portion');
});

test('describeTelegramToken flags the classic malformed shapes', () => {
  const quoted = describeTelegramToken('"' + GOOD_TOKEN + '"');
  assert.strictEqual(quoted.hadSurroundingQuotes, true);
  assert.strictEqual(quoted.changedByNormalization, true);
  assert.strictEqual(quoted.validFormat, true, 'after normalization it is valid');

  const prefixed = describeTelegramToken('bot' + GOOD_TOKEN);
  assert.strictEqual(prefixed.hadBotPrefix, true);
  assert.strictEqual(prefixed.changedByNormalization, true);

  const spaced = describeTelegramToken(GOOD_TOKEN.slice(0, 10) + ' ' + GOOD_TOKEN.slice(10));
  assert.strictEqual(spaced.hadInnerWhitespace, true);
  assert.strictEqual(spaced.validFormat, false);

  const clean = describeTelegramToken(GOOD_TOKEN);
  assert.strictEqual(clean.hadSurroundingQuotes, false);
  assert.strictEqual(clean.hadBotPrefix, false);
  assert.strictEqual(clean.changedByNormalization, false);
  assert.strictEqual(clean.validFormat, true);
  assert.strictEqual(clean.length, GOOD_TOKEN.length);
});

test('describeTelegramToken reports presence without leaking for empty input', () => {
  assert.strictEqual(describeTelegramToken('').present, false);
  assert.strictEqual(describeTelegramToken(undefined).present, false);
  assert.strictEqual(describeTelegramToken(undefined).length, 0);
});

// ---------------------------------------------------------------------------
// Probe - distinguishes Telegram 401 (wrong token) from 404 (malformed URL)
// ---------------------------------------------------------------------------

test('probeTelegramMethod reports a missing token without calling Telegram', async () => {
  let called = false;
  const out = await probeTelegramMethod({ token: '', method: 'getMe', fetchImpl: () => { called = true; } });
  assert.strictEqual(called, false);
  assert.strictEqual(out.httpStatus, null);
  assert.strictEqual(out.ok, false);
  assert.match(out.description, /TELEGRAM_BOT_TOKEN is not set/);
});

test('probeTelegramMethod reports the absence of a fetch implementation', async () => {
  const out = await probeTelegramMethod({ token: GOOD_TOKEN, method: 'getMe', fetchImpl: null });
  assert.strictEqual(out.ok, false);
  assert.match(out.description, /No fetch implementation/);
});

test('probeTelegramMethod surfaces a Telegram 404 as status 404 / Not Found', async () => {
  const out = await probeTelegramMethod({
    token: '"' + GOOD_TOKEN + '"',
    method: 'setWebhook',
    fetchImpl: async () => jsonResponse(404, { ok: false, error_code: 404, description: 'Not Found' })
  });
  assert.strictEqual(out.httpStatus, 404);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.errorCode, 404);
  assert.strictEqual(out.description, 'Not Found');
});

test('probeTelegramMethod surfaces a Telegram 401 as status 401 / Unauthorized', async () => {
  const out = await probeTelegramMethod({
    token: GOOD_TOKEN,
    method: 'getMe',
    fetchImpl: async () => jsonResponse(401, { ok: false, error_code: 401, description: 'Unauthorized' })
  });
  assert.strictEqual(out.httpStatus, 401);
  assert.strictEqual(out.description, 'Unauthorized');
  assert.strictEqual(out.ok, false);
});

test('probeTelegramMethod returns the result only on ok and never includes the token', async () => {
  const out = await probeTelegramMethod({
    token: GOOD_TOKEN,
    method: 'getMe',
    fetchImpl: async () => jsonResponse(200, {
      ok: true,
      result: { id: 123456789, is_bot: true, first_name: 'Arbitrix Support', username: 'ArbitrixSupportBot' }
    })
  });
  assert.strictEqual(out.httpStatus, 200);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.result.username, 'ArbitrixSupportBot');
  assert.ok(!JSON.stringify(out).includes(GOOD_TOKEN), 'token never appears in the probe result');
});

test('probeTelegramMethod scrubs the token from a thrown request error', async () => {
  const out = await probeTelegramMethod({
    token: GOOD_TOKEN,
    method: 'getMe',
    fetchImpl: async () => { throw new Error('connect failed for /bot' + GOOD_TOKEN + '/getMe'); }
  });
  assert.strictEqual(out.ok, false);
  assert.ok(!out.description.includes(GOOD_TOKEN), 'token must be scrubbed');
  assert.ok(out.description.includes('***'), 'the token is replaced, not dropped');
});

test('probeTelegramMethod handles an unparseable body safely', async () => {
  const out = await probeTelegramMethod({
    token: GOOD_TOKEN,
    method: 'getMe',
    fetchImpl: async () => ({ status: 502, ok: false, json: async () => { throw new Error('bad json'); } })
  });
  assert.strictEqual(out.httpStatus, 502);
  assert.strictEqual(out.ok, false);
});

test('summarizeTelegramBot / summarizeTelegramWebhook expose only non-secret fields', () => {
  assert.deepStrictEqual(summarizeTelegramBot({ id: 5, username: 'u', token: 'nope' }), { botId: 5, botUsername: 'u' });
  assert.deepStrictEqual(summarizeTelegramBot(null), { botId: null, botUsername: null });

  const hook = summarizeTelegramWebhook({ url: 'https://arbitrix.pro/api/telegram/webhook', pending_update_count: 2, last_error_message: 'x', secret_token: 'nope' });
  assert.deepStrictEqual(Object.keys(hook).sort(), ['lastErrorDate', 'lastErrorMessage', 'pendingUpdateCount', 'url']);
  assert.strictEqual(hook.url, 'https://arbitrix.pro/api/telegram/webhook');
  assert.strictEqual(summarizeTelegramWebhook(null), null);
});

// ---------------------------------------------------------------------------
// Server route wiring
// ---------------------------------------------------------------------------

test('the temporary /api/telegram/diagnose route is registered and admin-gated', () => {
  assert.ok(SERVER.includes("app.get('/api/telegram/diagnose', authMiddleware, adminMiddleware"),
    'diagnose route must be registered behind authMiddleware + adminMiddleware');
  assert.ok(/app\.get\('\/api\/telegram\/diagnose'[\s\S]{0,600}describeTelegramToken/.test(SERVER),
    'the route uses the safe shape descriptor');
  assert.ok(/app\.get\('\/api\/telegram\/diagnose'[\s\S]{0,900}probeTelegramMethod/.test(SERVER),
    'the route uses the non-throwing probe');
});

test('the diagnostic route never outputs the token or the webhook secret', () => {
  const start = SERVER.indexOf("app.get('/api/telegram/diagnose'");
  assert.ok(start > -1);
  const body = SERVER.slice(start, SERVER.indexOf('\n});', start));
  const jsonStart = body.indexOf('res.json({');
  assert.ok(jsonStart > -1, 'the route serializes a JSON report');
  const jsonBlock = body.slice(jsonStart, body.indexOf('});', jsonStart));

  assert.ok(jsonBlock.includes('token: tokenShape'),
    'the token field is the shape descriptor, not the raw value');
  assert.ok(!/telegramConfig\.token/.test(jsonBlock),
    'the raw token is never serialized');
  assert.ok(!/:\s*process\.env\.TELEGRAM_BOT_TOKEN\b/.test(jsonBlock),
    'the raw token env value is never serialized');
  assert.ok(body.includes('redact('), 'output strings are redacted as a backstop');

  const secretRefs = (jsonBlock.match(/telegramConfig\.webhookSecret/g) || []).length;
  const secretBooleans = (jsonBlock.match(/Boolean\(telegramConfig\.webhookSecret\)/g) || []).length;
  assert.ok(secretRefs > 0, 'the secret presence is reported');
  assert.strictEqual(secretRefs, secretBooleans, 'every webhook-secret reference is wrapped in Boolean()');
});

test('the diagnostic route does not trip the phase-5 forbidden-route guard', () => {
  const registrations = SERVER.match(/app\.(get|post|put|delete|patch)\('([^']+)'/g) || [];
  const bad = registrations.filter((r) => /'\/api\/(setup|debug|diagnostic)/.test(r));
  assert.deepStrictEqual(bad, []);
});

// ---------------------------------------------------------------------------
// Standalone script
// ---------------------------------------------------------------------------

test('the standalone script is inert on require and shares the safe helpers', () => {
  assert.ok(SCRIPT.includes('require.main === module'), 'must not run on require');
  assert.ok(SCRIPT.includes('describeTelegramToken'), 'uses the safe shape descriptor');
  assert.ok(SCRIPT.includes('probeTelegramMethod'), 'uses the non-throwing probe');
});

test('the standalone script never prints the token or the webhook secret', () => {
  assert.ok(!/console\.log\([^)]*process\.env\.TELEGRAM_BOT_TOKEN/.test(SCRIPT),
    'must not log the raw token env var');
  assert.ok(!/console\.log\([^)]*config\.token/.test(SCRIPT), 'must not log config.token');
  assert.ok(!/console\.log\([^)]*webhookSecret/.test(SCRIPT), 'must not log the webhook secret');
});

test('buildReport + verdict classify malformed, wrong and valid tokens', async () => {
  const empty = await buildReport({});
  assert.strictEqual(empty.token.present, false);
  assert.match(verdict(empty), /missing or empty/);

  const notFound = async () => jsonResponse(404, { ok: false, error_code: 404, description: 'Not Found' });
  const malformed = await buildReport({ TELEGRAM_BOT_TOKEN: '"' + GOOD_TOKEN + '"' }, notFound);
  assert.strictEqual(malformed.telegram.httpStatus, 404);
  assert.match(verdict(malformed), /malformed/);

  const unauthorized = async () => jsonResponse(401, { ok: false, error_code: 401, description: 'Unauthorized' });
  const wrong = await buildReport({ TELEGRAM_BOT_TOKEN: GOOD_TOKEN }, unauthorized);
  assert.strictEqual(wrong.telegram.httpStatus, 401);
  assert.match(verdict(wrong), /401|not recognised|Unauthorized/);

  const ok = async () => jsonResponse(200, { ok: true, result: { id: 1, username: 'ArbitrixSupportBot' } });
  const valid = await buildReport({ TELEGRAM_BOT_TOKEN: GOOD_TOKEN }, ok);
  assert.strictEqual(valid.telegram.ok, true);
  assert.strictEqual(valid.telegram.botUsername, 'ArbitrixSupportBot');
  assert.match(verdict(valid), /valid and accepted/);
});

test('buildReport never contains the raw token', async () => {
  const report = await buildReport(
    { TELEGRAM_BOT_TOKEN: '"bot' + GOOD_TOKEN + '"', TELEGRAM_WEBHOOK_SECRET: 'super-secret-value' },
    async () => jsonResponse(404, { ok: false, error_code: 404, description: 'Not Found' })
  );
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(GOOD_TOKEN), 'token must never appear in the report');
  assert.ok(!serialized.includes('super-secret-value'), 'webhook secret must never appear in the report');
});
