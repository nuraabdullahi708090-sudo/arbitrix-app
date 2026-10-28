'use strict';

/**
 * A destination supplied as `@ChannelName` (or a t.me link) is a realistic
 * operator mistake that used to be SILENT: getChat resolves a username, so the
 * readiness check reported the chat reachable and able to post, while
 * resolveMarketingConfig() dropped the value to '' and the publisher kept
 * publishing only to the other chat. These tests pin the loud behaviour.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');

const {
  resolveMarketingConfig,
  describeMarketingConfig
} = require('../services/TelegramBroadcast');
const {
  buildReport,
  resolveChat
} = require('../scripts/check-marketing-readiness');

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

const okGetMe = () => jsonResponse(200, { ok: true, result: { id: 999, is_bot: true, username: 'ArbitrixSupportBot' } })();
const okChat = () => jsonResponse(200, {
  ok: true, result: { id: Number(CHANNEL), type: 'channel', title: 'Channel' }
})();
const okMember = () => jsonResponse(200, {
  ok: true, result: { status: 'administrator', can_post_messages: true, can_pin_messages: true }
})();

// ---- configuration -------------------------------------------------------

test('a @username for the channel is reported, not silently dropped', () => {
  const config = resolveMarketingConfig({
    TELEGRAM_MARKETING_CHAT_ID: GROUP,
    TELEGRAM_ANNOUNCEMENT_CHAT_ID: '@ArbitrixAnnouncements'
  });
  assert.strictEqual(config.groupChatId, GROUP);
  assert.strictEqual(config.channelChatId, '');
  assert.strictEqual(config.channelChatIdInvalid, 'username-not-supported');
  assert.strictEqual(config.groupChatIdInvalid, null);
});

test('a t.me link is treated the same way', () => {
  for (const value of ['https://t.me/ArbitrixAnnouncements', 'http://telegram.me/ArbitrixAnnouncements']) {
    const config = resolveMarketingConfig({ TELEGRAM_ANNOUNCEMENT_CHAT_ID: value });
    assert.strictEqual(config.channelChatId, '', value);
    assert.strictEqual(config.channelChatIdInvalid, 'username-not-supported', value);
  }
});

test('a non-numeric value is reported as malformed', () => {
  const config = resolveMarketingConfig({ TELEGRAM_ANNOUNCEMENT_CHAT_ID: 'announcements' });
  assert.strictEqual(config.channelChatId, '');
  assert.strictEqual(config.channelChatIdInvalid, 'malformed-chat-id');
});

test('the group variable is validated the same way', () => {
  const config = resolveMarketingConfig({ TELEGRAM_MARKETING_CHAT_ID: '@ArbitrixPartners' });
  assert.strictEqual(config.groupChatId, '');
  assert.strictEqual(config.groupChatIdInvalid, 'username-not-supported');
});

test('numeric ids produce no invalid flag', () => {
  const config = resolveMarketingConfig({
    TELEGRAM_MARKETING_CHAT_ID: GROUP,
    TELEGRAM_ANNOUNCEMENT_CHAT_ID: CHANNEL
  });
  assert.strictEqual(config.groupChatIdInvalid, null);
  assert.strictEqual(config.channelChatIdInvalid, null);
});

test('an unset variable is not an invalid value', () => {
  const config = resolveMarketingConfig({});
  assert.strictEqual(config.groupChatIdInvalid, null);
  assert.strictEqual(config.channelChatIdInvalid, null);
});

test('a channel id that equals the group is a conflict, not a format error', () => {
  const config = resolveMarketingConfig({
    TELEGRAM_MARKETING_CHAT_ID: GROUP,
    TELEGRAM_ANNOUNCEMENT_CHAT_ID: GROUP
  });
  assert.strictEqual(config.channelConflictsWithGroup, true);
  assert.strictEqual(config.channelChatId, '');
  assert.strictEqual(config.channelChatIdInvalid, null);
});

test('the config summary carries both reasons', () => {
  const summary = describeMarketingConfig(resolveMarketingConfig({
    TELEGRAM_MARKETING_CHAT_ID: '@ArbitrixPartners',
    TELEGRAM_ANNOUNCEMENT_CHAT_ID: 'announcements'
  }));
  assert.strictEqual(summary.groupChatIdInvalid, 'username-not-supported');
  assert.strictEqual(summary.channelChatIdInvalid, 'malformed-chat-id');
});

// ---- worker -------------------------------------------------------------

test('the worker logs the warning at runtime and still boots', async () => {
  const env = Object.assign({}, process.env, {
    TELEGRAM_MARKETING_ENABLED: 'true',
    TELEGRAM_MARKETING_CHAT_ID: GROUP,
    TELEGRAM_ANNOUNCEMENT_CHAT_ID: '@ArbitrixAnnouncements',
    SUPABASE_URL: 'http://127.0.0.1:9',
    SUPABASE_SERVICE_KEY: 'service-key',
    TELEGRAM_BOT_TOKEN: TOKEN
  });
  delete env.SUPABASE_SERVICE_ROLE_KEY;

  const run = await new Promise((resolve) => {
    execFile(process.execPath, ['marketing-worker.js'], { cwd: ROOT, env, timeout: 20000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });

  assert.match(run.stdout, /"event":"worker_config_warning"/);
  assert.match(run.stdout, /"variable":"TELEGRAM_ANNOUNCEMENT_CHAT_ID"/);
  assert.match(run.stdout, /username-not-supported/);
  // The group is still usable, so the worker does NOT refuse to start.
  assert.ok(!/"event":"worker_misconfigured".*TELEGRAM_ANNOUNCEMENT_CHAT_ID=username/.test(run.stdout));
  assert.strictEqual(run.code, 1, 'it exits 1 only because the fake database is unreachable');
});

test('a worker with no usable destination names the bad variable', () => {
  const source = require('node:fs').readFileSync(path.join(ROOT, 'marketing-worker.js'), 'utf8');
  assert.match(source, /worker_config_warning/);
  assert.match(source, /no usable destination/);
  assert.ok(
    source.indexOf('worker_config_warning') < source.indexOf('no usable destination'),
    'the per-variable warning precedes the aggregated failure'
  );
});

// ---- readiness ----------------------------------------------------------

test('readiness flags a username channel and points at the resolver', async () => {
  const fetchImpl = fakeFetch({ getMe: okGetMe, getChat: okChat, getChatMember: okMember });
  const report = await buildReport({
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_MARKETING_CHAT_ID: GROUP,
    TELEGRAM_ANNOUNCEMENT_CHAT_ID: '@ArbitrixAnnouncements'
  }, fetchImpl);

  const issue = report.issues.find((text) => /TELEGRAM_ANNOUNCEMENT_CHAT_ID is not a numeric chat id/.test(text));
  assert.ok(issue, 'the format issue is reported');
  assert.match(issue, /--resolve-chat @ArbitrixAnnouncements/);
  assert.strictEqual(report.channel.formatValid, false);
  assert.strictEqual(report.channel.reachable, null, 'an invalid destination is not probed');
  assert.ok(
    !fetchImpl.calls.some((call) => call.method === 'getChat' && String(call.body.chat_id).startsWith('@')),
    'no getChat against a value the publisher cannot use'
  );
  assert.strictEqual(report.verdict, 'NOT_READY');
});

test('readiness is quiet about format when both ids are numeric', async () => {
  const fetchImpl = fakeFetch({ getMe: okGetMe, getChat: okChat, getChatMember: okMember });
  const report = await buildReport({
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_MARKETING_CHAT_ID: GROUP,
    TELEGRAM_ANNOUNCEMENT_CHAT_ID: CHANNEL
  }, fetchImpl);
  assert.ok(!report.issues.some((text) => /not a numeric chat id/.test(text)));
  assert.strictEqual(report.channel.reachable, true);
});

// ---- resolver -----------------------------------------------------------

test('--resolve-chat prints the numeric id the publisher needs', async () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  const printed = [];
  const originalLog = console.log;
  console.log = (line) => printed.push(String(line));
  try {
    const fetchImpl = fakeFetch({ getChat: okChat });
    const code = await resolveChat('@ArbitrixAnnouncements', fetchImpl);
    assert.strictEqual(code, 0);
  } finally {
    console.log = originalLog;
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  }
  const payload = JSON.parse(printed.join('\n'));
  assert.strictEqual(payload.resolved, true);
  assert.strictEqual(payload.id, CHANNEL);
  assert.strictEqual(payload.type, 'channel');
});

test('--resolve-chat without a token refuses instead of guessing', async () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.strictEqual(await resolveChat('@ArbitrixAnnouncements', fakeFetch({})), 3);
  } finally {
    console.error = originalError;
    if (previous !== undefined) process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});
