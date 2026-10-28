#!/usr/bin/env node
'use strict';

/**
 * Read-only readiness check for the Telegram marketing group and channel.
 *
 * ANSWERS ONE QUESTION: can the bot deliver the approved posts to the configured
 * destinations, and can it pin the Start Here guide?
 *
 * It sends NOTHING. Every call is a Bot API read (getMe, getChat,
 * getChatMember) and the database is never touched. Run it in the host shell
 * (Render: Shell tab) so it reads the SAME environment the deploy loaded.
 *
 * Usage:
 *   node scripts/check-marketing-readiness.js           # human readable
 *   node scripts/check-marketing-readiness.js --json    # machine readable
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
 * Build the report. Pure with respect to `fetchImpl`, so tests never touch the
 * network.
 *
 * @param {object} env environment-shaped object
 * @param {Function} fetchImpl injected fetch
 */
async function buildReport(env, fetchImpl) {
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
    issues,
    warnings
  };

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
  const report = await buildReport(process.env);
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

module.exports = { buildReport, verdictLine, maskId, describeId, postingRight, pinningRight };
