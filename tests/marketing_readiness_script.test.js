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

const { buildReport, verdictLine, maskId } = require('../scripts/check-marketing-readiness');

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
    TELEGRAM_ANNOUNCEMENT_CHANNEL_URL: 'https://t.me/ArbitrixAnnouncements',
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
      const type = String(body.chat_id) === GROUP ? (o.groupType || 'supergroup') : (o.channelType || 'channel');
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

test('a channel where the group belongs is an ISSUE, not a warning', async () => {
  const report = await buildReport(
    baseEnv(),
    fakeFetch(healthyRoutes({ groupType: 'channel' }))
  );
  assert.ok(
    report.issues.some((text) => /Partner group: this chat is a "channel"/.test(text) &&
      /TELEGRAM_MARKETING_CHAT_ID does not point at the partner group/.test(text)),
    'the wrong chat kind blocks readiness'
  );
  assert.strictEqual(report.verdict, 'NOT_READY');
});

test('a supergroup where the channel belongs is an ISSUE', async () => {
  const report = await buildReport(
    baseEnv(),
    fakeFetch(healthyRoutes({ channelType: 'supergroup' }))
  );
  assert.ok(
    report.issues.some((text) => /Announcement channel: this chat is a "supergroup"/.test(text))
  );
  assert.strictEqual(report.verdict, 'NOT_READY');
});

test('two swapped ids are reported once, as a swap', async () => {
  const report = await buildReport(
    baseEnv(),
    fakeFetch(healthyRoutes({ groupType: 'channel', channelType: 'supergroup' }))
  );
  const swaps = report.issues.filter((text) => /look SWAPPED/.test(text));
  assert.strictEqual(swaps.length, 1);
  assert.match(swaps[0], /publish would mix the audiences/);
  assert.ok(
    !report.issues.some((text) => /does not point at the partner group|does not point at the announcement channel/.test(text)),
    'the combined message replaces the two per-destination ones'
  );
  assert.strictEqual(report.verdict, 'NOT_READY');
});

test('a plain group instead of a supergroup stays a warning', async () => {
  const report = await buildReport(
    baseEnv(),
    fakeFetch(healthyRoutes({ groupType: 'group' }))
  );
  assert.strictEqual(report.issues.length, 0);
  assert.ok(report.warnings.some((w) => /expected a supergroup but the chat reports "group"/.test(w)));
  assert.strictEqual(report.verdict, 'READY_WITH_WARNINGS');
});

test('a channel without a public link is a warning, not a blocker', async () => {
  const withoutLink = baseEnv();
  delete withoutLink.TELEGRAM_ANNOUNCEMENT_CHANNEL_URL;
  const report = await buildReport(withoutLink, fakeFetch(healthyRoutes()));
  assert.strictEqual(report.announcementLinkConfigured, false);
  assert.ok(report.warnings.some((w) => /link back to the channel/.test(w)));
  assert.strictEqual(report.issues.length, 0);
  assert.strictEqual(report.verdict, 'READY_WITH_WARNINGS');
});

test('a username is enough for the channel link', async () => {
  const env = baseEnv();
  delete env.TELEGRAM_ANNOUNCEMENT_CHANNEL_URL;
  env.TELEGRAM_ANNOUNCEMENT_CHANNEL_USERNAME = '@ArbitrixAnnouncements';
  const report = await buildReport(env, fakeFetch(healthyRoutes()));
  assert.strictEqual(report.announcementLinkConfigured, true);
  assert.ok(!report.warnings.some((w) => /link back to the channel/.test(w)));
});

test('no channel configured means no link warning', async () => {
  const env = baseEnv();
  delete env.TELEGRAM_ANNOUNCEMENT_CHANNEL_URL;
  delete env.TELEGRAM_ANNOUNCEMENT_CHAT_ID;
  const report = await buildReport(env, fakeFetch(healthyRoutes()));
  assert.ok(!report.warnings.some((w) => /link back to the channel/.test(w)));
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

// ---------------------------------------------------------------------------
// Database section (read-only control row, heartbeat and queue counts)
// ---------------------------------------------------------------------------

function fakeAdmin(opts) {
  const o = opts || {};
  const calls = [];
  function table(name) {
    const q = {
      _status: null,
      select(cols, options) {
        calls.push({ op: 'select', table: name, cols: String(cols), options: options || null });
        return q;
      },
      eq(col, value) {
        if (col === 'status') q._status = value;
        return q;
      },
      async maybeSingle() {
        return {
          data: Object.prototype.hasOwnProperty.call(o, 'control') ? o.control : null,
          error: o.controlError || null
        };
      },
      then(resolve) {
        resolve({
          count: (o.counts && o.counts[q._status]) || 0,
          error: o.countsError || null
        });
      }
    };
    return q;
  }
  return {
    calls,
    from(name) {
      calls.push({ op: 'from', table: name });
      return table(name);
    }
  };
}

const HEALTHY_CONTROL = {
  id: 1,
  paused: true,
  dry_run: true,
  updated_at: '2026-10-28T21:00:00Z',
  worker_heartbeat_at: new Date().toISOString(),
  worker_id: 'marketing-worker',
  worker_version: 'marketing-worker/1'
};

test('the database section reports gates, heartbeat, queue and 044', async () => {
  const admin = fakeAdmin({ control: HEALTHY_CONTROL, counts: { scheduled: 2, published: 4 } });
  const report = await buildReport(baseEnv(), fakeFetch(healthyRoutes()), { admin });
  assert.strictEqual(report.database.ok, true);
  assert.strictEqual(report.database.migration044, true);
  assert.strictEqual(report.database.control.paused, true);
  assert.strictEqual(report.database.control.dryRun, true);
  assert.strictEqual(report.database.heartbeat.healthy, true);
  assert.strictEqual(report.database.heartbeat.workerId, 'marketing-worker');
  assert.strictEqual(report.database.queue.scheduled, 2);
  assert.strictEqual(report.database.queue.published, 4);
  assert.strictEqual(report.verdict, 'READY');
});

test('a control row without worker_heartbeat_at means 044 is not applied', async () => {
  const control = Object.assign({}, HEALTHY_CONTROL);
  delete control.worker_heartbeat_at;
  delete control.worker_id;
  delete control.worker_version;
  const report = await buildReport(baseEnv(), fakeFetch(healthyRoutes()), {
    admin: fakeAdmin({ control })
  });
  assert.strictEqual(report.database.migration044, false);
  assert.ok(report.warnings.some((w) => /migration 044 is not applied/.test(w)));
  assert.strictEqual(report.verdict, 'READY_WITH_WARNINGS');
});

test('an unreadable control row is an issue, not a crash', async () => {
  const report = await buildReport(baseEnv(), fakeFetch(healthyRoutes()), {
    admin: fakeAdmin({ controlError: { message: '', code: 'PGRST301' } })
  });
  assert.strictEqual(report.database.ok, false);
  assert.strictEqual(report.database.reason, 'control-unreadable');
  assert.ok(report.issues.some((i) => /publisher database/.test(i)));
  assert.strictEqual(report.verdict, 'NOT_READY');
});

test('a missing control row is reported distinctly', async () => {
  const report = await buildReport(baseEnv(), fakeFetch(healthyRoutes()), {
    admin: fakeAdmin({ control: null })
  });
  assert.strictEqual(report.database.ok, false);
  assert.strictEqual(report.database.reason, 'control-row-missing');
});

test('the database section issues selects only', async () => {
  const admin = fakeAdmin({ control: HEALTHY_CONTROL, counts: {} });
  await buildReport(baseEnv(), fakeFetch(healthyRoutes()), { admin });
  const ops = new Set(admin.calls.map((c) => c.op));
  assert.deepStrictEqual([...ops].sort(), ['from', 'select']);
  for (const forbidden of ['update', 'insert', 'delete', 'upsert', 'rpc']) {
    assert.ok(!ops.has(forbidden), 'must never call ' + forbidden);
  }
});

test('the database section is skipped when no client is supplied', async () => {
  const report = await buildReport(baseEnv(), fakeFetch(healthyRoutes()));
  assert.strictEqual(report.database, null);
  assert.strictEqual(report.verdict, 'READY');
});

// ---------------------------------------------------------------------------
// --db-only mode: database credentials without a bot token
// ---------------------------------------------------------------------------

const NEVER_CALLED = async () => {
  throw new Error('Telegram must not be contacted in --db-only mode');
};

test('--db-only reports READY from a healthy control row without a bot token', async () => {
  const admin = fakeAdmin({ control: HEALTHY_CONTROL, counts: { scheduled: 1 } });
  const report = await buildReport(baseEnv({ TELEGRAM_BOT_TOKEN: '' }), NEVER_CALLED, { admin, dbOnly: true });
  assert.strictEqual(report.dbOnly, true);
  assert.strictEqual(report.verdict, 'READY');
  assert.deepStrictEqual(report.issues, []);
  assert.strictEqual(report.token.ok, undefined, 'Telegram was never called');
  assert.match(verdictLine(report), /database only/);
});

test('--db-only downgrades a stale heartbeat to READY_WITH_WARNINGS', async () => {
  const control = Object.assign({}, HEALTHY_CONTROL, {
    worker_heartbeat_at: new Date(Date.now() - 3600 * 1000).toISOString()
  });
  const report = await buildReport(baseEnv({ TELEGRAM_BOT_TOKEN: '' }), NEVER_CALLED, {
    admin: fakeAdmin({ control }),
    dbOnly: true
  });
  assert.strictEqual(report.verdict, 'READY_WITH_WARNINGS');
  assert.strictEqual(report.database.heartbeat.healthy, false);
  assert.ok(report.warnings.some((w) => /Background Worker running/.test(w)));
  assert.match(verdictLine(report), /with warnings/);
});

test('--db-only downgrades a missing 044 to READY_WITH_WARNINGS', async () => {
  const control = Object.assign({}, HEALTHY_CONTROL);
  delete control.worker_heartbeat_at;
  const report = await buildReport(baseEnv({ TELEGRAM_BOT_TOKEN: '' }), NEVER_CALLED, {
    admin: fakeAdmin({ control }),
    dbOnly: true
  });
  assert.strictEqual(report.verdict, 'READY_WITH_WARNINGS');
  assert.ok(report.warnings.some((w) => /migration 044 is not applied/.test(w)));
});

test('--db-only without credentials is NOT_READY and never calls Telegram', async () => {
  const report = await buildReport(baseEnv({ TELEGRAM_BOT_TOKEN: '' }), NEVER_CALLED, { admin: null, dbOnly: true });
  assert.strictEqual(report.verdict, 'NOT_READY');
  assert.ok(report.issues.some((i) => /required for --db-only/.test(i)));
});

test('--db-only with an unreadable control row is NOT_READY', async () => {
  const report = await buildReport(baseEnv({ TELEGRAM_BOT_TOKEN: '' }), NEVER_CALLED, {
    admin: fakeAdmin({ controlError: { message: 'nope', code: 'PGRST301' } }),
    dbOnly: true
  });
  assert.strictEqual(report.verdict, 'NOT_READY');
});
