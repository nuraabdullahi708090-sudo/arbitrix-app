#!/usr/bin/env node
'use strict';

/**
 * Read-only readiness check for the Telegram marketing group and channel.
 *
 * ANSWERS ONE QUESTION: can the bot deliver the approved posts to the configured
 * destinations, and can it pin the Start Here guide?
 *
 * It sends NOTHING. Telegram calls are reads only (getMe, getChat,
 * getChatMember). When a service-role credential is present it also READS the
 * publisher control row, the worker heartbeat and the queue counts - never a
 * write, never a chat id, never a message body. Run it in the host shell
 * (Render: Shell tab) so it reads the SAME environment the deploy loaded.
 *
 * Usage:
 *   node scripts/check-marketing-readiness.js           # human readable
 *   node scripts/check-marketing-readiness.js --json    # machine readable
 *   node scripts/check-marketing-readiness.js --no-db   # skip the database read
 *   node scripts/check-marketing-readiness.js --db-only # database only, no bot token needed
 *
 * SAFETY
 *   * Never prints the bot token or any Supabase key.
 *   * Never prints a full chat id: ids are reported as configured/length/masked.
 *   * No write call, no message, no pin, no queue mutation.
 *
 * EXIT CODES
 *   0  ready (no issues; warnings may still be reported)
 *   2  not ready - see `issues`
 *   3  TELEGRAM_BOT_TOKEN is not set, so nothing could be checked
 */

const { probeTelegramMethod } = require('../services/TelegramSupportService');
const { workerHealth } = require('../services/TelegramBroadcast');
const { createMarketingStore } = require('../services/MarketingStore');

const CHANNEL_ID_FORMAT = /^-100\d{6,}$/;

function maskId(id) {
  const value = String(id === null || id === undefined ? '' : id);
  if (!value) return '';
  if (value.length <= 6) return '*'.repeat(value.length);
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

function describeId(id) {
  const value = String(id === null || id === undefined ? '' : id);
  return {
    configured: Boolean(value),
    length: value.length,
    formatValid: CHANNEL_ID_FORMAT.test(value),
    masked: maskId(value)
  };
}

function gateState(env) {
  const raw = (v) => String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  return {
    enabled: raw(env.TELEGRAM_MARKETING_ENABLED) === 'true',
    envDryRun: raw(env.TELEGRAM_MARKETING_DRY_RUN) !== 'false',
    locale: String(env.TELEGRAM_MARKETING_LOCALE || 'en').trim() || 'en',
    supabaseUrlPresent: Boolean(String(env.SUPABASE_URL || '').trim()),
    serviceKeyPresent: Boolean(
      String(env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
    )
  };
}

/** Interpret getChatMember for a posting right. */
function postingRight(member) {
  if (!member || !member.ok || !member.result) return { ok: false, reason: 'membership-unreadable' };
  const status = String(member.result.status || '');
  const isAdmin = status === 'administrator' || status === 'creator';
  const canPost = member.result.can_post_messages !== undefined
    ? member.result.can_post_messages === true
    : isAdmin || (status === 'restricted' && member.result.can_send_messages === true);
  return { ok: canPost, status, isAdmin };
}

function pinningRight(member) {
  if (!member || !member.ok || !member.result) return { ok: false, status: null };
  const status = String(member.result.status || '');
  const isAdmin = status === 'administrator' || status === 'creator';
  const canPin = member.result.can_pin_messages !== undefined
    ? member.result.can_pin_messages === true
    : isAdmin;
  return { ok: canPin, status };
}

/**
 * Read the publisher control row, the worker heartbeat and the queue counts.
 *
 * READ-ONLY by construction: this function only issues selects. It never calls
 * .update(), .insert(), .delete() or .rpc(), so running it can not change a gate,
 * a post or a consent row.
 *
 * @param {object} admin service-role Supabase client
 */
async function checkDatabase(admin) {
  if (!admin) return { ok: false, reason: 'no-client' };
  try {
    const control = await admin
      .from('telegram_marketing_control')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (control.error) {
      return { ok: false, reason: 'control-unreadable', errorCode: control.error.code || null };
    }
    if (!control.data) return { ok: false, reason: 'control-row-missing' };

    const row = control.data;
    const migration044 = Object.prototype.hasOwnProperty.call(row, 'worker_heartbeat_at');
    const store = createMarketingStore({ admin, logger: { warn() {} } });
    const counts = await store.countByStatus();

    return {
      ok: true,
      migration044,
      control: {
        paused: row.paused === true,
        dryRun: row.dry_run === true,
        updatedAt: row.updated_at || null
      },
      heartbeat: workerHealth(row),
      queue: counts.ok ? counts.data : null,
      queueError: counts.ok ? null : counts.reason
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'db-error',
      errorCode: error && error.code ? String(error.code) : null
    };
  }
}

/**
 * Build the report. Pure with respect to `fetchImpl`, so tests never touch the
 * network.
 *
 * @param {object} env environment-shaped object
 * @param {Function} fetchImpl injected fetch
 * @param {{admin?: object, dbOnly?: boolean}} deps optional service-role client
 *   for the read-only database section (omitted by tests so nothing leaves the
 *   process) and a flag to skip the Telegram checks entirely
 */
async function buildReport(env, fetchImpl, deps) {
  const e = env || {};
  const token = String(e.TELEGRAM_BOT_TOKEN || '').trim();
  const groupId = String(e.TELEGRAM_MARKETING_CHAT_ID || '').trim();
  const channelId = String(e.TELEGRAM_ANNOUNCEMENT_CHAT_ID || '').trim();
  const gates = gateState(e);
  const issues = [];
  const warnings = [];

  const report = {
    gates,
    token: { configured: Boolean(token) },
    group: Object.assign(describeId(groupId), { reachable: null, type: null, botStatus: null, canPost: null, canPin: null }),
    channel: Object.assign(describeId(channelId), { reachable: null, type: null, botStatus: null, canPost: null, canPin: null }),
    sameChatConfigured: Boolean(groupId) && groupId === channelId,
    database: null,
    dbOnly: Boolean(deps && deps.dbOnly),
    issues,
    warnings
  };

  // The database section is READ-ONLY and optional: it runs before the Telegram
  // checks so an operator still sees control/heartbeat/queue state on a service
  // that has no bot token configured.
  if (deps && deps.admin) {
    const db = await checkDatabase(deps.admin);
    report.database = db;
    if (!db.ok) {
      issues.push(
        'publisher database: ' +
        (db.reason === 'control-unreadable'
          ? 'the control row is unreadable - is migration 038 applied and is the service key correct?'
          : db.reason === 'control-row-missing'
            ? 'the control row does not exist - re-apply migration 038'
            : 'the database could not be read (' + db.reason + ')')
      );
    } else if (!db.migration044) {
      warnings.push(
        'migration 044 is not applied - the worker cannot record a heartbeat, so liveness is invisible'
      );
    }
  }

  // --db-only: an operator with database credentials but no bot token can still
  // verify the publisher state. Telegram is not contacted at all.
  if (deps && deps.dbOnly) {
    if (!deps.admin) {
      issues.push('SUPABASE_URL and a service key are required for --db-only');
    }
    const db = report.database;
    const workerAlive = Boolean(db && db.ok && db.heartbeat && db.heartbeat.healthy);
    if (db && db.ok && !workerAlive) {
      warnings.push(
        'worker heartbeat is not healthy (' + (db.heartbeat ? db.heartbeat.note : 'unknown') +
        ') - is the Background Worker running against this database?'
      );
    }
    report.verdict = !db || !db.ok
      ? 'NOT_READY'
      : (db.migration044 && workerAlive ? 'READY' : 'READY_WITH_WARNINGS');
    return report;
  }

  if (!token) {
    issues.push('TELEGRAM_BOT_TOKEN is not set on this service');
    report.verdict = 'TOKEN_MISSING';
    return report;
  }

  const me = await probeTelegramMethod({ token, method: 'getMe', fetchImpl });
  report.token.ok = Boolean(me.ok);
  report.token.username = me.result && me.result.username ? String(me.result.username) : null;
  report.token.errorCode = me.ok ? null : (me.errorCode || null);
  report.token.description = me.ok ? null : me.description;
  if (!me.ok) {
    issues.push(
      'getMe failed (' + (me.httpStatus || 'no http status') + '): ' + (me.description || 'unknown error') +
      ' - check TELEGRAM_BOT_TOKEN'
    );
    report.verdict = 'TOKEN_REJECTED';
    return report;
  }
  const botId = me.result && me.result.id ? me.result.id : null;

  if (!groupId) {
    issues.push('TELEGRAM_MARKETING_CHAT_ID is not set - the partner group receives no welcome');
  }
  if (!channelId && !report.sameChatConfigured) {
    issues.push('TELEGRAM_ANNOUNCEMENT_CHAT_ID is not set - channel posts have no destination');
  }
  if (report.sameChatConfigured) {
    issues.push(
      'TELEGRAM_ANNOUNCEMENT_CHAT_ID equals TELEGRAM_MARKETING_CHAT_ID - the channel is disabled ' +
      'on purpose; set the real channel id'
    );
  }

  async function inspect(targetId, label, state, expectType) {
    if (!targetId || report.sameChatConfigured) return;
    const chat = await probeTelegramMethod({
      token,
      method: 'getChat',
      payload: { chat_id: targetId },
      fetchImpl
    });
    state.reachable = Boolean(chat.ok);
    if (!chat.ok) {
      issues.push(
        label + ': getChat failed (' + (chat.httpStatus || 'no http status') + '): ' +
        (chat.description || 'unknown error') + ' - is the bot a member of that chat?'
      );
      return;
    }
    state.type = chat.result && chat.result.type ? String(chat.result.type) : null;
    if (expectType && state.type && state.type !== expectType) {
      warnings.push(label + ': expected a ' + expectType + ' but the chat reports "' + state.type + '"');
    }
    if (!botId) return;
    const member = await probeTelegramMethod({
      token,
      method: 'getChatMember',
      payload: { chat_id: targetId, user_id: botId },
      fetchImpl
    });
    const post = postingRight(member);
    const pin = pinningRight(member);
    state.botStatus = post.status || null;
    state.canPost = Boolean(post.ok);
    state.canPin = Boolean(pin.ok);
    if (!post.ok) {
      issues.push(
        label + ': the bot cannot post (status "' + (post.status || 'unknown') +
        '") - promote it to administrator with post rights'
      );
    }
    if (post.ok && !pin.ok) {
      warnings.push(
        label + ': the bot cannot pin messages - the Start Here guide can be published but not pinned'
      );
    }
  }

  await inspect(groupId, 'Partner group', report.group, 'supergroup');
  await inspect(channelId, 'Announcement channel', report.channel, 'channel');

  if (!gates.supabaseUrlPresent) {
    issues.push('SUPABASE_URL is not set - the publisher cannot read its queue');
  }
  if (!gates.serviceKeyPresent) {
    issues.push('SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) is not set - the publisher cannot read its queue');
  }
  if (!gates.enabled) {
    warnings.push('TELEGRAM_MARKETING_ENABLED is not true - the publisher is inert (expected before go-live)');
  }
  if (gates.envDryRun) {
    warnings.push('TELEGRAM_MARKETING_DRY_RUN is still true - the worker will not publish (expected before go-live)');
  }

  const destinationsOk =
    (!groupId || (report.group.reachable && report.group.canPost)) &&
    (!channelId || report.sameChatConfigured || (report.channel.reachable && report.channel.canPost));

  report.verdict = issues.length === 0 && destinationsOk
    ? (warnings.length ? 'READY_WITH_WARNINGS' : 'READY')
    : 'NOT_READY';
  return report;
}

function verdictLine(report) {
  if (report.dbOnly) {
    if (report.verdict === 'READY') {
      return 'READY (database only) - control, heartbeat and queue verified; Telegram was not checked.';
    }
    if (report.verdict === 'READY_WITH_WARNINGS') {
      return 'READY (database only) with warnings - review them before enabling publishing.';
    }
    return 'NOT READY - resolve the issues above.';
  }
  if (report.verdict === 'READY') return 'READY - the bot can post to every configured destination.';
  if (report.verdict === 'READY_WITH_WARNINGS') {
    return 'READY - destinations work; review the warnings above before enabling publishing.';
  }
  if (report.verdict === 'TOKEN_MISSING') return 'NOT READY - TELEGRAM_BOT_TOKEN is not set on this service.';
  if (report.verdict === 'TOKEN_REJECTED') return 'NOT READY - Telegram rejected the bot token.';
  return 'NOT READY - resolve the issues above.';
}

function printHuman(report) {
  const yesNo = (v) => (v === null || v === undefined ? 'n/a' : (v ? 'yes' : 'no'));
  console.log('Telegram marketing readiness (read-only, nothing is sent)');
  console.log('--- gates ---');
  console.log('TELEGRAM_MARKETING_ENABLED :', report.gates.enabled);
  console.log('env dry run                :', report.gates.envDryRun);
  console.log('locale                     :', report.gates.locale);
  console.log('SUPABASE_URL set           :', report.gates.supabaseUrlPresent);
  console.log('service key set            :', report.gates.serviceKeyPresent);
  console.log('--- bot ---');
  console.log('token set                  :', report.token.configured);
  console.log('getMe ok                   :', report.token.ok === undefined ? 'not checked' : yesNo(report.token.ok));
  console.log('bot username               :', report.token.username || 'n/a');
  if (report.token.description) console.log('getMe error                :', report.token.description);
  console.log('--- partner group ---');
  console.log('id configured / valid      :', report.group.configured, '/', report.group.formatValid);
  console.log('id (masked)                :', report.group.masked || 'n/a');
  console.log('chat reachable             :', yesNo(report.group.reachable));
  console.log('chat type                  :', report.group.type || 'n/a');
  console.log('bot status                 :', report.group.botStatus || 'n/a');
  console.log('bot can post               :', yesNo(report.group.canPost));
  console.log('bot can pin                :', yesNo(report.group.canPin));
  console.log('--- announcement channel ---');
  console.log('id configured / valid      :', report.channel.configured, '/', report.channel.formatValid);
  console.log('id (masked)                :', report.channel.masked || 'n/a');
  console.log('same id as the group       :', report.sameChatConfigured);
  console.log('chat reachable             :', yesNo(report.channel.reachable));
  console.log('chat type                  :', report.channel.type || 'n/a');
  console.log('bot status                 :', report.channel.botStatus || 'n/a');
  console.log('bot can post               :', yesNo(report.channel.canPost));
  if (report.database) {
    const db = report.database;
    console.log('--- publisher database (read-only) ---');
    if (!db.ok) {
      console.log('readable                   : no (' + db.reason + ')');
    } else {
      console.log('migration 044 (heartbeat)  :', db.migration044);
      console.log('control paused / dry run   :', db.control.paused, '/', db.control.dryRun);
      console.log('worker heartbeat           :', db.heartbeat.healthy ? 'healthy' : 'unhealthy');
      console.log('heartbeat note             :', db.heartbeat.note);
      if (db.heartbeat.ageMs !== null) console.log('heartbeat age (ms)         :', db.heartbeat.ageMs);
      console.log('worker id / version        :', (db.heartbeat.workerId || 'n/a') + ' / ' + (db.heartbeat.version || 'n/a'));
      console.log('queue by status            :', db.queue ? JSON.stringify(db.queue) : 'unreadable (' + (db.queueError || '?') + ')');
    }
  }
  if (report.issues.length) {
    console.log('--- issues ---');
    for (const issue of report.issues) console.log('-', issue);
  }
  if (report.warnings.length) {
    console.log('--- warnings ---');
    for (const warning of report.warnings) console.log('-', warning);
  }
  console.log('VERDICT:', verdictLine(report));
}

async function main() {
  const json = process.argv.includes('--json');
  const dbOnly = process.argv.includes('--db-only');
  const skipDb = process.argv.includes('--no-db') || dbOnly;
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  ).trim();
  let admin = null;
  if ((dbOnly || !skipDb) && url && key) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    } catch (error) {
      admin = null;
    }
  }
  const report = await buildReport(process.env, undefined, { admin, dbOnly });
  if (json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);

  if (report.verdict === 'TOKEN_MISSING') process.exit(3);
  process.exit(report.verdict === 'NOT_READY' ? 2 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('readiness check failed:', error && error.message ? error.message : error);
    process.exit(2);
  });
}

module.exports = { buildReport, checkDatabase, verdictLine, maskId, describeId, postingRight, pinningRight };
