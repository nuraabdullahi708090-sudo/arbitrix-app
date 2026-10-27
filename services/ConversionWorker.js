'use strict';

/**
 * Conversion notification worker (Phase 2).
 *
 * WHAT IT DOES
 *   Claims due rows from the `conversion_notifications` outbox (migration 040),
 *   RE-CHECKS every eligibility rule immediately before dispatch, sends the
 *   localized message to the user's own LINKED private Telegram chat, and
 *   records the outcome.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   * It never creates events: events are written by database triggers in the
 *     same transaction as the deposit credit / referral activation. A worker
 *     that is down loses no event, it only delays the message.
 *   * It never sends to a group: the target chat must not be a negative id
 *     (Telegram groups are negative) and must come from
 *     `telegram_account_links`, a table written only from a private chat.
 *   * It never sends advertising to someone who has not opted in: promotional
 *     rows require marketing consent at ENQUEUE time (SQL) AND are re-checked
 *     here at SEND time. Transactional rows (deposit confirmed, referral
 *     qualified) are service messages about the user's own account.
 *   * It never treats a status change as proof of a credit: a legacy deposit
 *     must still carry `credited = TRUE` (migration 041), which is written only
 *     after the wallet credit committed.
 *   * It periodically runs the idempotent `conversion_backfill_missing()` pass,
 *     so an event the capture triggers failed to record (they downgrade their
 *     own errors to a WARNING on purpose) is recovered instead of lost.
 *   * It never logs a chat id, a token, an email, an amount or a balance.
 *
 * CONCURRENCY
 *   Rows are claimed with `conversion_claim_notifications` (FOR UPDATE SKIP
 *   LOCKED + lease + attempts incremented at claim time), so two workers can
 *   never send the same row, a crashed worker's rows are reclaimed after the
 *   lease, and a poisonous row stops retrying on its own.
 *
 * CONCURRENCY: a completion is FENCED by the claiming worker id, so a worker
 * that stalled past its lease and was superseded cannot overwrite the state of
 * the worker that took over. A claimed row whose lease is missing or expired is
 * always reclaimable, so a crash can never leave a notification stuck.
 *
 * DELIVERY GUARANTEE: at-least-once, bounded by max_attempts. If the process
 * dies (or the database is unreachable) in the instant BETWEEN a successful
 * Telegram send and the completion write, the reclaimed row is sent again. That
 * window is unavoidable without a Telegram-side idempotency key, and the
 * alternative - marking rows sent before sending - would silently drop messages,
 * which is worse for an account notification. Attempts are incremented at claim
 * time, so the total number of sends per row is bounded even across crashes.
 */

const {
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  normalizeLanguage
} = require('./telegram-i18n');
const { renderConversionMessage } = require('./conversion-i18n');

const DEFAULT_CONFIG = Object.freeze({
  tickMs: 15000,
  batchSize: 20,
  leaseSeconds: 180,
  // A message about an event older than this is not sent at all: it would be
  // stale ("your deposit was confirmed" three days later) and would arrive as a
  // burst for a user who linked their chat long after the fact.
  maxAgeMinutes: 1440,
  minSendIntervalMs: 1000,
  // PROMOTIONAL. Off unless explicitly enabled (management approval required).
  pendingRemindersEnabled: false,
  reminderDelayMinutes: 30,
  reminderMaxPerDeposit: 1,
  // Event reconciliation (recover a swallowed capture error). ON by default:
  // it is idempotent, bounded, and it is what makes the triggers' "never block a
  // credit" trade-off safe instead of lossy.
  backfillEnabled: true,
  backfillIntervalMs: 15 * 60 * 1000,
  backfillWindowMinutes: 2880,
  backfillLimit: 200,
  // Housekeeping. Off by default: an operator enables it deliberately.
  purgeEnabled: false,
  purgeIntervalMs: 24 * 60 * 60 * 1000,
  notificationRetentionDays: 90,
  eventRetentionDays: 180
});

function envBool(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase() === 'true';
}

/** Boolean flag with a real default (only an explicit true/false overrides it). */
function envFlag(value, fallback) {
  const raw = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

function envInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value === undefined || value === null ? '' : value).trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  const lower = min === undefined ? Number.MIN_SAFE_INTEGER : min;
  const upper = max === undefined ? Number.MAX_SAFE_INTEGER : max;
  return Math.min(Math.max(parsed, lower), upper);
}

/** Resolve worker configuration from an env-like object. */
function resolveConversionConfig(env) {
  const source = env || {};
  return {
    enabled: envBool(source.CONVERSION_WORKER_ENABLED),
    tickMs: envInt(source.CONVERSION_TICK_MS, DEFAULT_CONFIG.tickMs, 5000, 15 * 60 * 1000),
    batchSize: envInt(source.CONVERSION_BATCH_SIZE, DEFAULT_CONFIG.batchSize, 1, 100),
    leaseSeconds: envInt(source.CONVERSION_LEASE_SECONDS, DEFAULT_CONFIG.leaseSeconds, 30, 900),
    maxAgeMinutes: envInt(source.CONVERSION_MAX_AGE_MINUTES, DEFAULT_CONFIG.maxAgeMinutes, 5, 60 * 24 * 30),
    minSendIntervalMs: envInt(source.CONVERSION_MIN_SEND_INTERVAL_MS, DEFAULT_CONFIG.minSendIntervalMs, 0, 60000),
    pendingRemindersEnabled: envBool(source.CONVERSION_PENDING_REMINDERS_ENABLED),
    reminderDelayMinutes: envInt(source.CONVERSION_REMINDER_DELAY_MINUTES, DEFAULT_CONFIG.reminderDelayMinutes, 5, 10080),
    reminderMaxPerDeposit: envInt(source.CONVERSION_REMINDER_MAX_PER_DEPOSIT, DEFAULT_CONFIG.reminderMaxPerDeposit, 1, 5),
    backfillEnabled: envFlag(source.CONVERSION_BACKFILL_ENABLED, DEFAULT_CONFIG.backfillEnabled),
    backfillIntervalMs: envInt(source.CONVERSION_BACKFILL_INTERVAL_MS, DEFAULT_CONFIG.backfillIntervalMs, 60000, 24 * 60 * 60 * 1000),
    backfillWindowMinutes: envInt(source.CONVERSION_BACKFILL_WINDOW_MINUTES, DEFAULT_CONFIG.backfillWindowMinutes, 5, 43200),
    backfillLimit: envInt(source.CONVERSION_BACKFILL_LIMIT, DEFAULT_CONFIG.backfillLimit, 1, 1000),
    purgeEnabled: envBool(source.CONVERSION_PURGE_ENABLED),
    purgeIntervalMs: envInt(source.CONVERSION_PURGE_INTERVAL_MS, DEFAULT_CONFIG.purgeIntervalMs, 60000, 7 * 24 * 60 * 60 * 1000),
    notificationRetentionDays: envInt(source.CONVERSION_NOTIFICATION_RETENTION_DAYS, DEFAULT_CONFIG.notificationRetentionDays, 7, 3650),
    eventRetentionDays: envInt(source.CONVERSION_EVENT_RETENTION_DAYS, DEFAULT_CONFIG.eventRetentionDays, 7, 3650)
  };
}

/** Secret-free description for boot logs. */
function describeConversionConfig(config) {
  const c = config || {};
  return {
    tickMs: c.tickMs,
    batchSize: c.batchSize,
    leaseSeconds: c.leaseSeconds,
    maxAgeMinutes: c.maxAgeMinutes,
    backfillEnabled: c.backfillEnabled !== false,
    pendingRemindersEnabled: Boolean(c.pendingRemindersEnabled),
    reminderDelayMinutes: c.reminderDelayMinutes,
    reminderMaxPerDeposit: c.reminderMaxPerDeposit,
    purgeEnabled: Boolean(c.purgeEnabled)
  };
}

/** Telegram groups/supergroups have negative chat ids; a private chat never does. */
function isPrivateChatId(chatId) {
  const value = String(chatId === undefined || chatId === null ? '' : chatId).trim();
  if (!value) return false;
  if (value.startsWith('-')) return false;
  return /^[0-9]+$/.test(value);
}

/**
 * Map a transport failure to a retry decision, using the transport's own record
 * of the last API call (never the raw exception text).
 */
function classifySendFailure(transport) {
  let last = null;
  try {
    last = typeof transport.getLastCall === 'function' ? transport.getLastCall() : null;
  } catch (error) {
    last = null;
  }
  const errorCode = last && last.errorCode ? Number(last.errorCode) : null;
  const httpStatus = last && last.httpStatus ? Number(last.httpStatus) : null;
  const description = String((last && last.description) || '');

  if (errorCode === 429) {
    return { retry: true, retryAfterSeconds: last && last.retryAfter ? Number(last.retryAfter) : 30, reason: 'rate_limited' };
  }
  // 403: the user blocked the bot / deleted the chat. Retrying cannot help.
  if (errorCode === 403 || httpStatus === 403) {
    return { retry: false, reason: 'unreachable' };
  }
  // 400 with a permanent chat problem.
  if ((httpStatus === 400 || errorCode === 400)
      && /chat not found|bot was blocked|user is deactivated|peer_id_invalid/i.test(description)) {
    return { retry: false, reason: 'unreachable' };
  }
  return { retry: true, retryAfterSeconds: null, reason: 'send_failed' };
}

function createConversionWorker(options) {
  const opts = options || {};
  const store = opts.store;
  const transport = opts.transport;
  const config = Object.assign({}, DEFAULT_CONFIG, opts.config || {});
  const logger = opts.logger || console;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
  const sleep = typeof opts.sleep === 'function'
    ? opts.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const workerId = String(opts.workerId || ('conversion-' + process.pid));

  if (!store) throw new Error('createConversionWorker requires a store');
  if (!transport) throw new Error('createConversionWorker requires a transport');

  const state = {
    running: false,
    stopped: false,
    timer: null,
    lastPurgeAt: 0,
    lastBackfillAt: 0,
    lastBackfillReason: null,
    lastSendAtByChat: new Map()
  };

  const stats = {
    ticks: 0,
    claimed: 0,
    sent: 0,
    skipped: 0,
    retried: 0,
    enqueuedReminders: 0,
    backfilled: 0,
    claimFailures: 0,
    completeFailures: 0,
    lastTickAt: null,
    lastError: null
  };

  function emit(level, event, extra) {
    const line = JSON.stringify(Object.assign({
      event,
      component: 'conversion-worker',
      at: new Date().toISOString()
    }, extra || {}));
    const fn = level === 'warn' ? (logger.warn || logger.log) : logger.log;
    try {
      fn.call(logger, line);
    } catch (error) {
      logger.log('[Conversion] ' + event);
    }
  }

  /** Complete a row and update the counters. Never throws. */
  async function finish(row, status, reason, retrySeconds) {
    const res = await store.completeNotification(row.id, status, reason, retrySeconds, workerId);
    if (!res.ok) {
      stats.completeFailures += 1;
      emit('warn', 'notification_complete_failed', { notificationId: row.id, reason: res.reason });
      return false;
    }
    if (status === 'sent') stats.sent += 1;
    else if (status === 'skipped') stats.skipped += 1;
    else stats.retried += 1;
    emit('info', 'notification_' + status, {
      notificationId: row.id,
      eventType: row.event_type,
      category: row.category,
      attempts: row.attempts,
      reason: reason || null
    });
    return true;
  }

  /**
   * Every rule that must still hold at send time. Returns
   * `{ ok:true, chatId, language }` or `{ ok:false, reason, retry? }`.
   */
  async function checkEligibility(row, event) {
    if (!event) return { ok: false, reason: 'event_missing' };

    // 1. Freshness: a stale "deposit confirmed" is noise, not a notification.
    const createdAtMs = Date.parse(row.created_at || event.created_at || '');
    if (!Number.isFinite(createdAtMs)) return { ok: false, reason: 'invalid_timestamp' };
    if (clock() - createdAtMs > config.maxAgeMinutes * 60 * 1000) {
      return { ok: false, reason: 'stale' };
    }

    // 2. Promotional dispatch is off unless explicitly enabled.
    if (row.category === 'promotional' && !config.pendingRemindersEnabled) {
      return { ok: false, reason: 'promotional_disabled' };
    }

    // 3. The account must still be linked (unlink removes the row).
    const link = await store.getLinkedChat(row.user_id);
    if (!link.ok) return { ok: false, reason: 'link_unreadable', retry: true };
    if (!link.data) return { ok: false, reason: 'not_linked' };
    const chatId = link.data.chatId;
    if (!isPrivateChatId(chatId)) return { ok: false, reason: 'not_private' };

    // 4. Promotional messages need live marketing consent (re-checked now).
    let language = null;
    if (row.category === 'promotional') {
      const sub = await store.getSubscription(chatId);
      if (!sub.ok) return { ok: false, reason: 'subscription_unreadable', retry: true };
      if (!sub.data || sub.data.subscribed !== true) return { ok: false, reason: 'not_subscribed' };
      language = sub.data.locale || null;
    }

    // 5. The business fact must still be true.
    const payload = (event.payload && typeof event.payload === 'object') ? event.payload : {};

    if (row.event_type === 'deposit_confirmed') {
      if (event.source === 'legacy_deposit') {
        const depositId = payload.depositId;
        if (depositId === undefined || depositId === null) return { ok: false, reason: 'unverifiable' };
        const res = await store.getLegacyDeposit(depositId);
        if (!res.ok) return { ok: false, reason: 'deposit_unreadable', retry: true };
        if (!res.data || String(res.data.status || '').toLowerCase() !== 'confirmed') {
          return { ok: false, reason: 'not_confirmed' };
        }
        // status alone is never proof: migration 041 writes this marker only
        // after the wallet credit committed in the same transaction.
        if (res.data.credited !== true) {
          return { ok: false, reason: 'not_credited' };
        }
      } else {
        const invoiceId = payload.invoiceId;
        if (invoiceId === undefined || invoiceId === null) return { ok: false, reason: 'unverifiable' };
        const res = await store.getInvoice(invoiceId);
        if (!res.ok) return { ok: false, reason: 'invoice_unreadable', retry: true };
        const invoice = res.data;
        if (!invoice || String(invoice.status || '').toLowerCase() !== 'confirmed' || invoice.credited !== true) {
          return { ok: false, reason: 'not_confirmed' };
        }
      }
    }

    if (row.event_type === 'referral_qualified') {
      const referralId = payload.referralId;
      if (referralId === undefined || referralId === null) return { ok: false, reason: 'unverifiable' };
      const res = await store.getReferral(referralId);
      if (!res.ok) return { ok: false, reason: 'referral_unreadable', retry: true };
      const referral = res.data;
      if (!referral || String(referral.status || '').toLowerCase() !== 'active') {
        return { ok: false, reason: 'not_qualified' };
      }
      if (!(Number(referral.bonus_earned) > 0)) return { ok: false, reason: 'not_qualified' };
      // The recipient must still be the referrer of this row.
      if (Number(referral.referrer_id) !== Number(row.user_id)) return { ok: false, reason: 'not_qualified' };
    }

    if (row.event_type === 'deposit_pending_reminder') {
      const invoiceId = payload.invoiceId;
      if (invoiceId === undefined || invoiceId === null) return { ok: false, reason: 'unverifiable' };
      const res = await store.getInvoice(invoiceId);
      if (!res.ok) return { ok: false, reason: 'invoice_unreadable', retry: true };
      const invoice = res.data;
      if (!invoice) return { ok: false, reason: 'no_longer_pending' };
      if (String(invoice.status || '').toLowerCase() !== 'pending') return { ok: false, reason: 'no_longer_pending' };
      const expiresAtMs = Date.parse(invoice.expires_at || '');
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= clock()) {
        return { ok: false, reason: 'no_longer_pending' };
      }
    }

    // 6. Language: the support conversation wins (the user's explicit choice),
    //    then the subscription locale, else English.
    if (!language) {
      const conversation = await store.getConversationLanguage(chatId);
      language = conversation && conversation.data ? conversation.data : null;
    }
    if (!isSupportedLanguage(language)) language = DEFAULT_LANGUAGE;

    return { ok: true, chatId, language: normalizeLanguage(language) };
  }

  /** Per-chat pacing so a burst of events cannot hammer one conversation. */
  async function respectSendInterval(chatId) {
    if (!config.minSendIntervalMs) return;
    const last = state.lastSendAtByChat.get(chatId);
    if (!last) return;
    const wait = config.minSendIntervalMs - (clock() - last);
    if (wait > 0) await sleep(wait);
  }

  async function dispatch(row) {
    const eventRes = await store.getEvent(row.event_id);
    if (!eventRes.ok) {
      // A read failure must not consume the attempt; retry later.
      await store.completeNotification(row.id, 'failed', 'event_unreadable', 60, workerId);
      stats.retried += 1;
      return;
    }
    const event = eventRes.data;

    const eligibility = await checkEligibility(row, event);
    if (!eligibility.ok) {
      if (eligibility.retry) await finish(row, 'failed', eligibility.reason, 60);
      else await finish(row, 'skipped', eligibility.reason);
      return;
    }

    const text = renderConversionMessage(row.event_type, eligibility.language, event ? event.amount : null);
    if (!text) {
      await finish(row, 'skipped', 'no_template');
      return;
    }

    await respectSendInterval(eligibility.chatId);

    try {
      await transport.sendMessage(eligibility.chatId, text, { disable_web_page_preview: true });
      state.lastSendAtByChat.set(eligibility.chatId, clock());
      await finish(row, 'sent', null);
    } catch (error) {
      const failure = classifySendFailure(transport);
      state.lastSendAtByChat.set(eligibility.chatId, clock());
      if (failure.retry) await finish(row, 'failed', failure.reason, failure.retryAfterSeconds);
      else await finish(row, 'skipped', failure.reason);
    }
  }

  async function maybeEnqueueReminders() {
    if (!config.pendingRemindersEnabled) return 0;
    const res = await store.enqueuePendingReminders({
      delayMinutes: config.reminderDelayMinutes,
      maxPerDeposit: config.reminderMaxPerDeposit,
      limit: config.batchSize * 5
    });
    if (!res.ok) {
      emit('warn', 'reminder_enqueue_failed', { reason: res.reason });
      return 0;
    }
    if (res.data > 0) {
      stats.enqueuedReminders += res.data;
      emit('info', 'reminders_enqueued', { count: res.data });
    }
    return res.data;
  }

  /**
   * Recover events a capture trigger failed to record. Bounded, idempotent, and
   * skipped entirely when disabled or when the RPC is not deployed yet (the
   * failure is logged once per distinct reason, not every tick).
   */
  async function maybeBackfill() {
    if (!config.backfillEnabled) return;
    const nowMs = clock();
    if (nowMs - state.lastBackfillAt < config.backfillIntervalMs) return;
    state.lastBackfillAt = nowMs;

    if (typeof store.backfillMissing !== 'function') return;
    const res = await store.backfillMissing({
      sinceMinutes: config.backfillWindowMinutes,
      limit: config.backfillLimit
    });
    if (!res.ok) {
      if (state.lastBackfillReason !== res.reason) {
        state.lastBackfillReason = res.reason;
        emit('warn', 'backfill_failed', {
          reason: res.reason,
          hint: res.reason === 'backfill_failed' ? 'migration 041 may not be applied' : undefined
        });
      }
      return;
    }
    state.lastBackfillReason = null;
    const recovered = res.data && Number(res.data.total) > 0 ? Number(res.data.total) : 0;
    if (recovered > 0) {
      stats.backfilled += recovered;
      emit('info', 'backfill_recovered', res.data);
    }
  }

  async function maybePurge() {
    if (!config.purgeEnabled) return;
    const nowMs = clock();
    if (nowMs - state.lastPurgeAt < config.purgeIntervalMs) return;
    state.lastPurgeAt = nowMs;
    const res = await store.purge({
      notificationDays: config.notificationRetentionDays,
      eventDays: config.eventRetentionDays
    });
    if (!res.ok) {
      emit('warn', 'purge_failed', { reason: res.reason });
      return;
    }
    emit('info', 'purged', res.data || {});
  }

  /** One pass: reminders (if enabled) -> claim -> dispatch. Never throws. */
  async function tick() {
    if (state.stopped) return stats;
    stats.ticks += 1;
    stats.lastTickAt = new Date().toISOString();
    try {
      await maybeBackfill();
      await maybeEnqueueReminders();
      await maybePurge();

      const claimed = await store.claimNotifications(workerId, config.batchSize, config.leaseSeconds);
      if (!claimed.ok) {
        stats.claimFailures += 1;
        emit('warn', 'claim_failed', { reason: claimed.reason });
        return stats;
      }
      if (claimed.data.length === 0) return stats;
      stats.claimed += claimed.data.length;
      emit('info', 'claimed', { count: claimed.data.length });

      for (const row of claimed.data) {
        if (state.stopped) break;
        await dispatch(row);
      }
    } catch (error) {
      stats.lastError = String(error && error.message ? error.message : error).slice(0, 200);
      emit('warn', 'tick_failed', { error: stats.lastError });
    }
    return stats;
  }

  function scheduleNext() {
    if (!state.running || state.stopped) return;
    // setTimeout chaining (not setInterval) so a slow tick can never overlap the
    // next one. The timer is intentionally NOT unref'd: the loop must keep the
    // process alive.
    state.timer = setTimeout(async () => {
      if (state.stopped) return;
      await tick();
      scheduleNext();
    }, config.tickMs);
  }

  async function start() {
    if (state.running) return stats;
    state.running = true;
    state.stopped = false;
    emit('info', 'worker_started', { workerId, config: describeConversionConfig(config) });
    await tick();
    scheduleNext();
    return stats;
  }

  function stop() {
    state.stopped = true;
    state.running = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function statsSnapshot() {
    return Object.assign({}, stats);
  }

  return {
    tick,
    start,
    stop,
    stats: statsSnapshot,
    // exposed for tests
    checkEligibility,
    dispatch
  };
}

module.exports = {
  DEFAULT_CONFIG,
  classifySendFailure,
  createConversionWorker,
  describeConversionConfig,
  isPrivateChatId,
  resolveConversionConfig
};
