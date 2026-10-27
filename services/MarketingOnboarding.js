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
 * Split a Telegram `new_chat_members` batch into the members that may be
 * welcomed and the bots that must not be.
 *
 * Every member is inspected INDIVIDUALLY: a bot in the batch never suppresses the
 * humans beside it, and a batch of only bots yields an empty `humans` list. The
 * list is de-duplicated by id - Telegram does not send the same member twice, but
 * a duplicated entry must not read as two separate people (that would turn a
 * single personalised greeting into a generic one) - and malformed entries are
 * dropped instead of throwing.
 *
 * @param {Array<{id:*,firstName?:(string|null),isBot?:boolean}>} members
 * @returns {{humans: Array<{id:string,firstName:(string|null)}>, bots: Array<{id:string}>, received: number}}
 */
function selectWelcomeTargets(members) {
  const list = Array.isArray(members) ? members : [];
  const humans = [];
  const bots = [];
  const seenIds = new Set();
  for (const member of list) {
    if (!member || typeof member !== 'object') continue;
    const id = member.id === undefined || member.id === null ? '' : String(member.id);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    if (member.isBot === true) {
      bots.push({ id });
    } else {
      humans.push({ id, firstName: typeof member.firstName === 'string' ? member.firstName : null });
    }
  }
  return { humans, bots, received: list.length };
}

/**
 * The greeting name for one service message: used only when EXACTLY ONE human
 * joined. Several people sharing a single welcome must not be addressed with one
 * arbitrary member's name - the content layer then renders the generic community
 * greeting instead.
 */
function pickGreetingName(humans) {
  return Array.isArray(humans) && humans.length === 1 ? humans[0].firstName : null;
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

  // Bounded de-duplication of the member keys we have welcomed. Telegram can
  // redeliver a service message, and two copies can even be in flight at once, so
  // a key is RESERVED before the send and RELEASED again if the send fails: a
  // message that never reached the group must not block that member's welcome.
  // This map lives in process memory, so it guarantees at-most-once per running
  // process - not exactly-once across restarts or instances.
  const seen = new Map();
  const SEEN_MAX = 500;

  // Reserve every key or none: a service message is atomic, so a partially known
  // batch is treated as a redelivery rather than greeted twice.
  function reserve(keys) {
    if (keys.some((key) => seen.has(key))) return false;
    const at = Date.now();
    for (const key of keys) {
      seen.set(key, at);
      if (seen.size > SEEN_MAX) {
        const oldest = seen.keys().next().value;
        seen.delete(oldest);
      }
    }
    return true;
  }

  function release(keys) {
    for (const key of keys) seen.delete(key);
  }

  function report(event, extra) {
    try {
      log.log(JSON.stringify(Object.assign(
        { event, component: 'marketing-onboarding', at: new Date().toISOString() },
        extra || {}
      )));
    } catch (error) { /* never break the webhook */ }
  }

  // The send audit is bookkeeping, not delivery: a store failure must never turn
  // a delivered welcome into a reported failure (which would also release the
  // reservation for a message the group already received).
  async function audit(chatId, row) {
    if (!store) return;
    try {
      await store.recordSend(Object.assign({ audience: 'group', chatId }, row));
    } catch (error) { /* best effort, see above */ }
  }

  /**
   * Greet the humans in a Telegram `new_chat_members` service message.
   *
   * Bots are filtered out individually, so a mixed batch still greets its humans;
   * a batch with no humans sends nothing. One welcome is posted per service
   * message: personalised when exactly one human joined, generic otherwise.
   *
   * @param {{chatId: string, chatType?: string,
   *          members: Array<{id:string,firstName:(string|null),name:string,isBot:boolean}>,
   *          messageId: string}} event
   * @returns {Promise<{sent:boolean, skipped?:string, error?:string, locale?:string,
   *                    text?:string, members?:number, bots?:number}>}
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

    const targets = selectWelcomeTargets(e.members);
    if (!targets.humans.length) {
      // A bot-only (or empty/garbage) batch is not an error: there is simply
      // nobody to greet, and nothing is sent.
      report('welcome_skipped', {
        reason: 'no-human-members',
        received: targets.received,
        bots: targets.bots.length
      });
      return { sent: false, skipped: 'no-human-members', members: 0, bots: targets.bots.length };
    }

    const keys = targets.humans.map(
      (member) => String(e.chatId) + ':' + member.id + ':' + String(e.messageId || '')
    );
    if (!reserve(keys)) {
      report('welcome_skipped', { reason: 'duplicate', received: targets.received, bots: targets.bots.length });
      return { sent: false, skipped: 'duplicate', members: 0, bots: targets.bots.length };
    }

    // Personalise with the JOINING MEMBER's own Telegram first name - never the
    // bot's or an administrator's. Several humans in one service message share a
    // single welcome, so none of them is named.
    const firstName = pickGreetingName(targets.humans);
    const content = render('welcome', config.locale, buildLinkContext(config, firstName));

    let message;
    try {
      message = await transport.sendMessage(
        destination.chatId,
        content.text,
        content.replyMarkup ? { reply_markup: content.replyMarkup } : undefined
      );
    } catch (error) {
      // The customer's join event must never fail the webhook. Log and move on,
      // but free the reservations so this service message can still be welcomed
      // if Telegram redelivers it: nothing was delivered.
      const detail = String(error && error.message ? error.message : error).slice(0, 200);
      release(keys);
      report('welcome_failed', { error: detail, members: keys.length, bots: targets.bots.length });
      await audit(destination.chatId, { status: 'failed', error: detail });
      return { sent: false, skipped: 'send-failed', error: detail };
    }

    await audit(destination.chatId, {
      status: 'sent',
      messageId: message && message.message_id ? message.message_id : null
    });
    report('welcome_sent', {
      locale: content.locale,
      members: keys.length,
      bots: targets.bots.length,
      received: targets.received,
      messageId: message && message.message_id ? message.message_id : null
    });
    return {
      sent: true,
      locale: content.locale,
      text: content.text,
      members: keys.length,
      bots: targets.bots.length
    };
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
  selectWelcomeTargets,
  pickGreetingName,
  guardOptions,
  buildPostRow,
  buildCalendarRows,
  buildStartHereRow,
  buildChannelIntroRow,
  createOnboarding
};
