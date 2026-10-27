'use strict';

/**
 * Configuration, destination validation and send-side helpers for the Telegram
 * marketing publisher.
 *
 * DESIGN RULES
 *   1. NOTHING here sends anything by itself: it only describes WHERE a post may
 *      go and whether the outbound call is allowed to happen now.
 *   2. A destination is NEVER taken from the database row. It is resolved from
 *      `audience` + configuration at send time, so a malformed or tampered queue
 *      row cannot redirect a post to an arbitrary chat.
 *   3. A missing or malformed chat id disables that destination rather than
 *      falling back to "some chat". The worker treats "no destination" as a
 *      retryable configuration error and never sends.
 *
 * No secrets are read, returned or logged here.
 */

const { canonicalizeTelegramChatId } = require('./TelegramSupportService');
const { normalizeLocale, DEFAULT_LOCALE } = require('./MarketingContent');

/** Telegram channels and supergroups always have a -100... id. */
const CHANNEL_ID_FORMAT = /^-100\d{6,}$/;

const AUDIENCES = Object.freeze(['group', 'channel', 'subscribers']);

function firstString(...values) {
  for (const value of values) {
    const s = String(value === null || value === undefined ? '' : value).trim();
    if (s) return s;
  }
  return '';
}

function boolFromEnv(value, fallback) {
  const s = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
  if (!s) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function intFromEnv(value, fallback, min, max) {
  const n = Number.parseInt(String(value === null || value === undefined ? '' : value).trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Accept 'https://t.me/name', '@name' or 'name' and return the t.me URL. */
function telegramProfileUrl(raw) {
  const value = firstString(raw);
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    // Only Telegram hosts are accepted, so a mistyped value cannot inject an
    // arbitrary link into an official-looking message.
    return /^https?:\/\/(t\.me|telegram\.me)\//i.test(value) ? value : '';
  }
  const handle = value.replace(/^@+/, '');
  if (!/^[A-Za-z0-9_]{3,64}$/.test(handle)) return '';
  return 'https://t.me/' + handle;
}

function httpUrl(raw) {
  const value = firstString(raw);
  if (!value) return '';
  return /^https?:\/\/[^\s]+$/i.test(value) ? value : '';
}

/**
 * Confirmed official destinations for the partner onboarding messages.
 * A configured value always wins; these are only the fallbacks used when the
 * environment leaves a value empty, so the approved welcome can never render a
 * missing or invented link.
 */
const OFFICIAL_LINKS = Object.freeze({
  registerUrl: 'https://arbitrix.pro/?action=create-account',
  howItWorksUrl: 'https://arbitrix.pro/how-it-works',
  supportUrl: 'https://t.me/ArbitrixSupportBot',
  partnerSupportUrl: 'https://t.me/Arbitrix_CSA1'
});

/**
 * Resolve the whole marketing configuration from an env-shaped object.
 * Presence booleans only - never a token or a secret.
 */
function resolveMarketingConfig(env) {
  const e = env || {};
  const baseUrl = firstString(e.BASE_URL).replace(/\/+$/, '');
  const registerUrl = httpUrl(e.TELEGRAM_MARKETING_REGISTER_URL) ||
    (baseUrl ? baseUrl + '/?action=create-account' : OFFICIAL_LINKS.registerUrl);
  return {
    enabled: boolFromEnv(e.TELEGRAM_MARKETING_ENABLED, false),
    dryRun: boolFromEnv(e.TELEGRAM_MARKETING_DRY_RUN, true),
    groupChatId: canonicalizeTelegramChatId(e.TELEGRAM_MARKETING_CHAT_ID) || '',
    channelChatId: canonicalizeTelegramChatId(e.TELEGRAM_ANNOUNCEMENT_CHAT_ID) || '',
    locale: normalizeLocale(e.TELEGRAM_MARKETING_LOCALE || DEFAULT_LOCALE),
    timezone: firstString(e.TELEGRAM_MARKETING_TIMEZONE) || 'UTC',
    tickMs: intFromEnv(e.TELEGRAM_MARKETING_TICK_MS, 60000, 15000, 900000),
    workerId: firstString(e.TELEGRAM_MARKETING_WORKER_ID) || 'marketing-worker',
    registerUrl,
    howItWorksUrl: httpUrl(e.TELEGRAM_MARKETING_HOW_IT_WORKS_URL) ||
      (baseUrl ? baseUrl + '/how-it-works' : OFFICIAL_LINKS.howItWorksUrl),
    announcementUrl: httpUrl(e.TELEGRAM_ANNOUNCEMENT_CHANNEL_URL) ||
      (firstString(e.TELEGRAM_ANNOUNCEMENT_CHANNEL_USERNAME)
        ? telegramProfileUrl(e.TELEGRAM_ANNOUNCEMENT_CHANNEL_USERNAME)
        : ''),
    supportUrl: telegramProfileUrl(e.TELEGRAM_SUPPORT_USERNAME) || OFFICIAL_LINKS.supportUrl,
    partnerSupportUrl: telegramProfileUrl(e.TELEGRAM_PARTNER_SUPPORT_USERNAME) ||
      OFFICIAL_LINKS.partnerSupportUrl,
    baseUrl
  };
}

/** Safe, secret-free summary for logs and the admin status route. */
function describeMarketingConfig(config) {
  const c = config || {};
  return {
    enabled: Boolean(c.enabled),
    dryRun: Boolean(c.dryRun),
    groupConfigured: Boolean(c.groupChatId),
    channelConfigured: Boolean(c.channelChatId),
    locale: normalizeLocale(c.locale),
    timezone: c.timezone || 'UTC',
    registerUrlConfigured: Boolean(c.registerUrl),
    howItWorksUrlConfigured: Boolean(c.howItWorksUrl),
    announcementUrlConfigured: Boolean(c.announcementUrl),
    supportUrlConfigured: Boolean(c.supportUrl),
    partnerSupportUrlConfigured: Boolean(c.partnerSupportUrl)
  };
}

/**
 * Validate a destination chat id against configuration.
 * Returns { ok, chatId, reason }.
 */
function validateDestination(chatId, config) {
  const id = String(chatId === null || chatId === undefined ? '' : chatId).trim();
  if (!id) return { ok: false, chatId: '', reason: 'missing-chat-id' };
  if (!CHANNEL_ID_FORMAT.test(id)) return { ok: false, chatId: id, reason: 'malformed-chat-id' };
  const allowed = [config && config.groupChatId, config && config.channelChatId]
    .filter(Boolean)
    .map(String);
  if (!allowed.length) return { ok: false, chatId: id, reason: 'no-destination-configured' };
  if (!allowed.includes(id)) return { ok: false, chatId: id, reason: 'chat-not-configured' };
  return { ok: true, chatId: id, reason: null };
}

/** Resolve the configured chat for an audience. Never trusts a stored chat_id. */
function chatIdForAudience(audience, config) {
  const a = AUDIENCES.includes(audience) ? audience : 'group';
  if (a === 'channel') return { audience: a, chatId: (config && config.channelChatId) || '', reason: 'announcement-channel-not-configured' };
  if (a === 'subscribers') return { audience: a, chatId: '', reason: null };
  return { audience: a, chatId: (config && config.groupChatId) || '', reason: 'marketing-group-not-configured' };
}

/**
 * Per-chat rate limiter. Telegram's documented ceiling for one group is about
 * 20 messages per minute; the default here is deliberately lower so ordinary
 * support traffic is never crowded out.
 */
function createRateLimiter(options) {
  const opts = options || {};
  const maxPerMinute = Math.min(Math.max(Number(opts.maxPerMinute) || 15, 1), 20);
  const windowMs = Number(opts.windowMs) || 60000;
  const clock = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const buckets = new Map();

  return {
    maxPerMinute,
    take(chatId) {
      const key = String(chatId);
      const now = clock();
      const recent = (buckets.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= maxPerMinute) {
        const waitMs = windowMs - (now - recent[0]);
        buckets.set(key, recent);
        return { ok: false, waitMs: Math.max(waitMs, 1000) };
      }
      recent.push(now);
      buckets.set(key, recent);
      return { ok: true, waitMs: 0 };
    },
    reset(chatId) {
      if (chatId === undefined) buckets.clear();
      else buckets.delete(String(chatId));
    }
  };
}

/** Exponential backoff with a ceiling, in milliseconds. */
function backoffMs(attempt, options) {
  const opts = options || {};
  const baseMs = Number(opts.baseMs) || 60000;
  const maxMs = Number(opts.maxMs) || 3600000;
  const n = Math.min(Math.max(Number(attempt) || 1, 1), 10);
  return Math.min(baseMs * Math.pow(2, n - 1), maxMs);
}

/** True when the error is a Telegram 429 and carries a retry_after hint. */
function retryAfterMs(error) {
  if (!error) return 0;
  const direct = Number(error.retryAfter || (error.parameters && error.parameters.retry_after));
  if (Number.isFinite(direct) && direct > 0) return direct * 1000;
  const match = /retry[_\s-]?after["'\s:=]*(\d+)/i.exec(String(error.message || ''));
  if (match) return Number(match[1]) * 1000;
  return 0;
}

module.exports = {
  CHANNEL_ID_FORMAT,
  AUDIENCES,
  resolveMarketingConfig,
  describeMarketingConfig,
  validateDestination,
  chatIdForAudience,
  createRateLimiter,
  backoffMs,
  retryAfterMs,
  telegramProfileUrl,
  httpUrl
};
