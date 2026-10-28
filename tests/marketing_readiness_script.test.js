'use strict';

/**
 * scripts/check-marketing-readiness.js is read-only by contract: it may only
 * call getMe / getChat / getChatMember, it must never print the bot token or a
 * full chat id, and it must fail closed with an actionable issue list.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildReport, maskId } = require('../scripts/check-marketing-readiness');

const ROOT = path.join(__dirname, '..');
const GROUP = '-1001111111111';
const CHANNEL = '-1002222222222';
const TOKEN = '123456789:TESTTOKENVALUE';

function jsonResponse(status, body) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options) => {
    const method = String(url).split('/').pop();
    const body = options && options.body ? JSON.parse(options.body) : {};
    calls.push({ method, body });
    const handler = routes[method];
    if (!handler) return jsonResponse(404, { ok: false, error_code: 404, description: 'Not Found' })();
    return handler(body);
  };
  impl.calls = calls;
  return impl;
}

function baseEnv(over) {
  return Object.assign({
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_MARKETING_CHAT_ID: GROUP,
    TELEGRAM_ANNOUNCEMENT_CHAT_ID: CHANNEL,
    TELEGRAM_MARKETING_ENABLED: 'true',
    TELEGRAM_MARKETING_DRY_RUN: 'false',
    TELEGRAM_MARKETING_LOCALE: 'en',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_KEY: 'service-key'
  }, over || {});
}

function healthyRoutes(over) {
  const o = over || {};
  return {
    getMe: jsonResponse(200, { ok: true, result: { id: 999, is_bot: true, username: 'ArbitrixSupportBot' } }),
    getChat: async (body) => {
      if (o.chatFails && String(body.chat_id) === String(o.chatFails)) {
        return jsonResponse(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' })();
      }
      const type = String(body.chat_id) === GROUP ? (o.groupType || 'supergroup') : 'channel';
      return jsonResponse(200, { ok: true, result: { id: body.chat_id, type } })();
    },
    getChatMember: async (body) => {
      const isGroup = String(body.chat_id) === GROUP;
      const rights = o.memberRights || {};
      return jsonResponse(200, {
        ok: true,
        result: {
          status: (isGroup ? rights.groupStatus : rights.channelStatus) || 'administrator',
          can_post_messages: isGroup ? undefined : (rights.channelCanPost !== false),
          can_pin_messages: isGroup ? (rights.groupCanPin !== false) : undefined
        }
      })();
    }
  };
}

test('a fully configured deployment is READY', async () => {
  const report = await buildReport(baseEnv(), fakeFetch(healthyRoutes()));
  assert.deepStrictEqual(report.issues, []);
  assert.deepStrictEqual(report.warnings, []);
  assert.strictEqual(report.verdict, 'READY');
  assert.strictEqual(report.token.ok, true);
  assert.strictEqual(report.group.canPost, true);
  assert.strictEqual(report.group.canPin, true);
  assert.strictEqual(report.channel.canPost, true);
  assert.strictEqual(report.channel.type, 'channel');
});

test('only read methods are ever called', async () => {
  const fetchImpl = fakeFetch(healthyRoutes());
  await buildReport(baseEnv(), fetchImpl);
  const methods = new Set(fetchImpl.calls.map((call) => call.method));
  assert.deepStrictEqual([...methods].sort(), ['getChat', 'getChatMember', 'getMe']);
  for (const forbidden of ['sendMessage', 'pinChatMessage', 'setWebhook', 'deleteMessage']) {
    assert.ok(!methods.has(forbidden), 'must never call ' + forbidden);
  }
});

test('the token and full chat ids never appear in the report', async () => {
  const report = await buildReport(baseEnv(), fakeFetch(healthyRoutes()));
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(TOKEN), 'the token must not be echoed');
  assert.ok(!serialized.includes(GROUP), 'the group id must be masked');
  assert.ok(!serialized.includes(CHANNEL), 'the channel id must be masked');
  assert.strictEqual(report.group.masked.endsWith(GROUP.slice(-4)), true);
  assert.ok(report.group.masked.startsWith('*'));
});

test('maskId keeps only the last four characters', () => {
  assert.strictEqual(maskId(GROUP), '*'.repeat(GROUP.length - 4) + GROUP.slice(-4));
  assert.strictEqual(maskId('123'), '***');
  assert.strictEqual(maskId(''), '');
});

test('a channel id equal to the group id is an issue, not a destination', async () => {
  const report = await buildReport(
    baseEnv({ TELEGRAM_ANNOUNCEMENT_CHAT_ID: GROUP }),
    fakeFetch(healthyRoutes())
  );
  assert.strictEqual(report.sameChatConfigured, true);
  assert.strictEqual(report.verdict, 'NOT_READY');
  assert.ok(report.issues.some((i) => /equals TELEGRAM_MARKETING_CHAT_ID/.test(i)));
  assert.strictEqual(report.channel.reachable, null, 'the conflicting channel must not be probed');
});

test('a bot that is only a member cannot post and is not ready', async () => {
  const report = await buildReport(
    baseEnv(),
    fakeFetch(healthyRoutes({ memberRights: { channelStatus: 'member', channelCanPost: false } }))
  );
  assert.strictEqual(report.verdict, 'NOT_READY');
  assert.strictEqual(report.channel.canPost, false);
  assert.ok(report.issues.some((i) => /Announcement channel: the bot cannot post/.test(i)));
});

test('an unreachable chat is an issue that names the chat', async () => {
  const report = await buildReport(
    baseEnv(),
    fakeFetch(healthyRoutes({ chatFails: CHANNEL }))
  );
  assert.strictEqual(report.verdict, 'NOT_READY');
  assert.strictEqual(report.channel.reachable, false);
  assert.ok(report.issues.some((i) => /Announcement channel: getChat failed/.test(i)));
});

test('missing pin rights are a warning, not a blocker', async () => {
  const report = await buildReport(
    baseEnv(),
    fakeFetch(healthyRoutes({ memberRights: { groupCanPin: false } }))
  );
  assert.strictEqual(report.issues.length, 0);
  assert.strictEqual(report.group.canPin, false);
  assert.ok(report.warnings.some((w) => /cannot pin/.test(w)));
  assert.strictEqual(report.verdict, 'READY_WITH_WARNINGS');
});

test('a type mismatch between configuration and reality is a warning', async () => {
  const report = await buildReport(
    baseEnv(),
    fakeFetch(healthyRoutes({ groupType: 'channel' }))
  );
  assert.ok(report.warnings.some((w) => /expected a supergroup/.test(w)));
  assert.strictEqual(report.verdict, 'READY_WITH_WARNINGS');
});

test('the inert defaults are warnings, never issues', async () => {
  const report = await buildReport(
    baseEnv({ TELEGRAM_MARKETING_ENABLED: 'false', TELEGRAM_MARKETING_DRY_RUN: 'true' }),
    fakeFetch(healthyRoutes())
  );
  assert.strictEqual(report.issues.length, 0);
  assert.strictEqual(report.gates.enabled, false);
  assert.strictEqual(report.gates.envDryRun, true);
  assert.strictEqual(report.verdict, 'READY_WITH_WARNINGS');
});

test('a missing token short-circuits with exit-code 3 semantics', async () => {
  const report = await buildReport(baseEnv({ TELEGRAM_BOT_TOKEN: '' }), fakeFetch({}));
  assert.strictEqual(report.verdict, 'TOKEN_MISSING');
  assert.strictEqual(report.token.configured, false);
  assert.strictEqual(report.group.reachable, null);
});

test('a rejected token is reported without leaking the token', async () => {
  const report = await buildReport(baseEnv(), fakeFetch({
    getMe: jsonResponse(401, { ok: false, error_code: 401, description: 'Unauthorized' })
  }));
  assert.strictEqual(report.verdict, 'TOKEN_REJECTED');
  assert.strictEqual(report.token.ok, false);
  assert.ok(report.issues.some((i) => /getMe failed/.test(i)));
  assert.ok(!JSON.stringify(report).includes(TOKEN));
});

test('a missing queue configuration is an issue', async () => {
  const report = await buildReport(
    baseEnv({ SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '' }),
    fakeFetch(healthyRoutes())
  );
  assert.strictEqual(report.verdict, 'NOT_READY');
  assert.ok(report.issues.some((i) => /SUPABASE_URL is not set/.test(i)));
  assert.ok(report.issues.some((i) => /SUPABASE_SERVICE_KEY/.test(i)));
});

test('SUPABASE_SERVICE_ROLE_KEY is accepted as the service key', async () => {
  const report = await buildReport(
    baseEnv({ SUPABASE_SERVICE_KEY: '', SUPABASE_SERVICE_ROLE_KEY: 'role-key' }),
    fakeFetch(healthyRoutes())
  );
  assert.strictEqual(report.gates.serviceKeyPresent, true);
  assert.strictEqual(report.verdict, 'READY');
});

test('an unset channel is an issue (no silent fallback to the group)', async () => {
  const report = await buildReport(
    baseEnv({ TELEGRAM_ANNOUNCEMENT_CHAT_ID: '' }),
    fakeFetch(healthyRoutes())
  );
  assert.strictEqual(report.verdict, 'NOT_READY');
  assert.ok(report.issues.some((i) => /TELEGRAM_ANNOUNCEMENT_CHAT_ID is not set/.test(i)));
});

test('the script contains no write call to Telegram', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/check-marketing-readiness.js'), 'utf8');
  for (const forbidden of ['sendMessage(', 'pinChatMessage(', 'setWebhook(']) {
    assert.ok(!source.includes(forbidden), 'must not call ' + forbidden);
  }
  assert.ok(source.includes('getChatMember'));
});
