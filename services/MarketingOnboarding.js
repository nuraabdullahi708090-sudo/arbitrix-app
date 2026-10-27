'use strict';

/**
 * Partner onboarding for the Telegram marketing group, plus the builders that
 * turn approved templates into queue rows.
 *
 * WELCOME
 *   Sent when a human joins the configured marketing group. It never runs for a
 *   different chat, never messages bots, is de-duplicated per (chat, member) so a
 *   Telegram redelivery cannot double-post, and swallows every error so a bad
 *   Telegram response can never crash the webhook.
 *
 * QUEUE BUILDERS
 *   Pure functions that return the row to insert. They render the approved
 *   template, run the content guard, and choose the initial status:
 *     - guard ok          -> 'scheduled' (publishable autonomously)
 *     - requires approval -> 'awaiting_approval'
 *     - blocked           -> 'blocked' (never inserted as publishable)
 *
 * No network call and no database write happens in this module.
 */

const { render, normalizeLocale } = require('./MarketingContent');
const { checkContent } = require('./ContentGuard');
const { validateDestination } = require('./TelegramBroadcast');

const WEEKDAY_THEMES = Object.freeze({
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun'
});

/** Group: partner-facing actions. Channel: information and education. */
const DEFAULT_SCHEDULE = Object.freeze([
  { audience: 'group', theme: 'mon', hour: 9, minute: 0 },
  { audience: 'group', theme: 'wed', hour: 9, minute: 0 },
  { audience: 'group', theme: 'fri', hour: 9, minute: 0 },
  { audience: 'channel', theme: 'tue', hour: 18, minute: 0 },
  { audience: 'channel', theme: 'thu', hour: 18, minute: 0 },
  { audience: 'channel', theme: 'sat', hour: 18, minute: 0 },
  { audience: 'channel', theme: 'sun', hour: 18, minute: 0 }
]);

/** Local date/time parts for an instant in an IANA timezone. */
function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    weekday: parts.weekday,
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute)
  };
}

/** Local YYYY-MM-DD for an instant in a timezone (used in idempotency keys). */
function localDateKey(date, timeZone) {
  const p = localParts(date, timeZone);
  return p.year + '-' + p.month + '-' + p.day;
}

/**
 * Next instant at which the local wall clock in `timeZone` matches
 * (weekday, hour, minute). Steps in 15-minute increments, so DST transitions are
 * handled by the platform rather than by hand-rolled offset arithmetic.
 */
function nextSlot({ theme, hour, minute, timezone, after }) {
  const targetWeekday = Object.keys(WEEKDAY_THEMES).find((d) => WEEKDAY_THEMES[d] === theme);
  if (!targetWeekday) throw new Error('unknown theme: ' + theme);
  const start = after ? new Date(after) : new Date();
  const stepMs = 15 * 60 * 1000;
  const maxMs = 9 * 24 * 60 * 60 * 1000;
  const cursor = new Date(Math.ceil(start.getTime() / stepMs) * stepMs);

  for (let elapsed = 0; elapsed <= maxMs; elapsed += stepMs) {
    const candidate = new Date(cursor.getTime() + elapsed);
    const p = localParts(candidate, timezone);
    if (p.weekday === targetWeekday && p.hour === hour && p.minute === minute) {
      return candidate;
    }
  }
  throw new Error('no slot found for theme ' + theme);
}

/**
 * Template context for the partner messages.
 *
 * `greetingName` is the JOINING MEMBER's own Telegram first name and is used by
 * the welcome only (Start Here is a shared group post). The content layer
 * sanitises it and falls back to the generic greeting when it is missing or
 * unusable, so callers may pass null.
 */
function buildLinkContext(config, greetingName) {
  return {
    registerUrl: config.registerUrl,
    howItWorksUrl: config.howItWorksUrl,
    supportUrl: config.supportUrl,
    partnerSupportUrl: config.partnerSupportUrl,
    announcementUrl: config.announcementUrl,
    minDeposit: config.facts && config.facts.minDeposit,
    referralPercent: config.facts && config.facts.referralPercent,
    promoCredit: config.facts && config.facts.promoCredit,
    name: greetingName
  };
}

function guardOptions(config, locale) {
  return {
    locale,
    minDeposit: config.facts && config.facts.minDeposit,
    referralPercent: config.facts && config.facts.referralPercent
  };
}

/**
 * Build one queue row from an approved template.
 *
 * @returns {{row: object|null, guard: object, content: object}}
 */
function buildPostRow({ kind, theme, audience, locale, config, scheduledFor, idempotencyKey, createdBy, name }) {
  const lang = normalizeLocale(locale || config.locale);
  const content = render(kind, lang, buildLinkContext(config, name));
  const guard = checkContent(content.text, guardOptions(config, lang));

  const status = guard.blocked
    ? 'blocked'
    : (guard.requiresApproval ? 'awaiting_approval' : 'scheduled');

  return {
    content,
    guard,
    row: {
      kind,
      theme: theme || null,
      locale: lang,
      audience,
      chat_id: null,
      content: content.text,
      buttons: content.buttons,
      status,
      idempotency_key: idempotencyKey,
      scheduled_for: status === 'scheduled' ? scheduledFor : null,
      guard,
      created_by: createdBy || null
    }
  };
}

/** All calendar rows for the next `weeks` weeks. Pure; no writes. */
function buildCalendarRows({ config, weeks, now, createdBy }) {
  const span = Math.min(Math.max(Number(weeks) || 2, 1), 8);
  const after = now ? new Date(now) : new Date();
  const rows = [];
  const locale = normalizeLocale(config.locale);

  for (const slot of DEFAULT_SCHEDULE) {
    for (let week = 0; week < span; week++) {
      const reference = new Date(after.getTime() + week * 7 * 24 * 60 * 60 * 1000);
      const when = nextSlot({
        theme: slot.theme,
        hour: slot.hour,
        minute: slot.minute,
        timezone: config.timezone,
        after: reference
      });
      // Skip a slot that has already passed in the current week.
      if (when.getTime() <= after.getTime()) continue;
      const key = 'cal:' + slot.audience + ':' + locale + ':' + slot.theme + ':' +
        localDateKey(when, config.timezone);
      const built = buildPostRow({
        kind: 'weekly',
        theme: slot.theme,
        audience: slot.audience,
        locale,
        config,
        scheduledFor: when.toISOString(),
        idempotencyKey: key,
        createdBy
      });
      rows.push(built);
    }
  }

  // De-duplicate by key (a slot can be produced twice at a week boundary).
  const seen = new Set();
  return rows.filter((r) => {
    if (seen.has(r.row.idempotency_key)) return false;
    seen.add(r.row.idempotency_key);
    return true;
  });
}

/** The pinned Start Here post for the group. */
function buildStartHereRow({ config, locale, scheduledFor, createdBy }) {
  const lang = normalizeLocale(locale || config.locale);
  return buildPostRow({
    kind: 'startHere',
    audience: 'group',
    locale: lang,
    config,
    scheduledFor: scheduledFor || new Date().toISOString(),
    idempotencyKey: 'starthere:group:' + lang + ':' + localDateKey(new Date(), config.timezone),
    createdBy
  });
}

/** The introductory post for the announcement channel. */
function buildChannelIntroRow({ config, locale, scheduledFor, createdBy }) {
  const lang = normalizeLocale(locale || config.locale);
  return buildPostRow({
    kind: 'channelIntro',
    audience: 'channel',
    locale: lang,
    config,
    scheduledFor: scheduledFor || new Date().toISOString(),
    idempotencyKey: 'channelintro:' + lang + ':' + localDateKey(new Date(), config.timezone),
    createdBy
  });
}

/**
 * Create the join handler.
 *
 * @param {object} options {config, transport, store, logger, clock}
 */
function createOnboarding(options) {
  const opts = options || {};
  const config = opts.config || {};
  const transport = opts.transport;
  const store = opts.store;
  const log = opts.logger || console;
  if (!transport) throw new Error('createOnboarding requires a transport');

  // Bounded de-duplication: Telegram can redeliver a service message.
  const seen = new Map();
  const SEEN_MAX = 500;

  function remember(key) {
    if (seen.has(key)) return false;
    seen.set(key, Date.now());
    if (seen.size > SEEN_MAX) {
      const oldest = seen.keys().next().value;
      seen.delete(oldest);
    }
    return true;
  }

  function report(event, extra) {
    try {
      log.log(JSON.stringify(Object.assign(
        { event, component: 'marketing-onboarding', at: new Date().toISOString() },
        extra || {}
      )));
    } catch (error) { /* never break the webhook */ }
  }

  /**
   * @param {{chatId: string, members: Array<{id:string,name:string,isBot:boolean}>, messageId: string}} event
   */
  async function handleNewMembers(event) {
    const e = event || {};
    // A welcome belongs ONLY to the partner group. Checking against groupChatId
    // alone (not "any configured chat") means a join in the announcement channel
    // can never receive onboarding copy.
    const destination = config.groupChatId
      ? validateDestination(e.chatId, { groupChatId: config.groupChatId })
      : { ok: false, chatId: '', reason: 'marketing-group-not-configured' };
    if (!destination.ok) {
      report('welcome_skipped', { reason: destination.reason });
      return { sent: false, skipped: destination.reason };
    }

    const humans = (e.members || []).filter((m) => m && !m.isBot && m.id);
    if (!humans.length) {
      report('welcome_skipped', { reason: 'no-human-members' });
      return { sent: false, skipped: 'no-human-members' };
    }

    const fresh = humans.filter((m) => remember(String(e.chatId) + ':' + String(m.id) + ':' + String(e.messageId || '')));
    if (!fresh.length) {
      report('welcome_skipped', { reason: 'duplicate' });
      return { sent: false, skipped: 'duplicate' };
    }

    // Personalise with the JOINING MEMBER's own Telegram first name - never the
    // bot's or an administrator's. A service message can list several members at
    // once; there is no single person to name then, so those joins get the
    // generic greeting instead of one arbitrary member's name.
    const firstName = fresh.length === 1 ? fresh[0].firstName : null;
    const content = render('welcome', config.locale, buildLinkContext(config, firstName));

    try {
      const message = await transport.sendMessage(
        destination.chatId,
        content.text,
        content.replyMarkup ? { reply_markup: content.replyMarkup } : undefined
      );
      if (store) {
        await store.recordSend({
          audience: 'group',
          chatId: destination.chatId,
          status: 'sent',
          messageId: message && message.message_id ? message.message_id : null
        });
      }
      report('welcome_sent', {
        locale: content.locale,
        members: fresh.length,
        messageId: message && message.message_id ? message.message_id : null
      });
      return { sent: true, locale: content.locale, text: content.text };
    } catch (error) {
      // The customer's join event must never fail the webhook. Log and move on;
      // Telegram will not retry a 2xx, and a failed welcome is not worth an
      // update loop.
      const detail = String(error && error.message ? error.message : error).slice(0, 200);
      report('welcome_failed', { error: detail });
      if (store) {
        await store.recordSend({
          audience: 'group',
          chatId: destination.chatId,
          status: 'failed',
          error: detail
        });
      }
      return { sent: false, skipped: 'send-failed', error: detail };
    }
  }

  return {
    handleNewMembers,
    _seenSize: () => seen.size
  };
}

module.exports = {
  WEEKDAY_THEMES,
  DEFAULT_SCHEDULE,
  localParts,
  localDateKey,
  nextSlot,
  buildLinkContext,
  guardOptions,
  buildPostRow,
  buildCalendarRows,
  buildStartHereRow,
  buildChannelIntroRow,
  createOnboarding
};
