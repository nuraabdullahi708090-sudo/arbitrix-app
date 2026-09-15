'use strict';

/**
 * Telegram support bot service.
 *
 * Bridges @ArbitrixSupportBot to the support inbox:
 *   - Private user messages are stored (telegram_support_messages) and
 *     forwarded to the private support group so an agent can answer.
 *   - An agent replies by replying to the forwarded message in the group, or
 *     with /reply <chat_id> <message>; the reply is delivered back to the user.
 *   - /chatid answers with the CURRENT chat id, which is how the support group
 *     chat id is discovered: the bot is an admin in the group, so it receives
 *     group messages even before TELEGRAM_SUPPORT_CHAT_ID is set.
 *
 * The applied `telegram_support_messages` table has only
 * (id, conversation_id, direction, body, created_at) - no Telegram message id
 * and no update id. Two per-process helpers therefore live here:
 *   - a bounded deduper for `update_id` (Telegram redeliveries)
 *   - a bounded map from the forwarded group message id -> user chat id, so an
 *     agent's reply-to-message can be routed back
 * Both are complements to, not replacements for, the durable
 * /reply <chat_id> path, which works across restarts.
 *
 * The module is transport- and storage-agnostic (a `store` and a `transport`
 * are injected), so routing/formatting is unit-testable without a database, a
 * network, or booting Express (server.js binds a port on require).
 *
 * Secrets: the bot token is only used to build the Telegram API URL inside the
 * transport. It is never logged, returned, or included in error messages.
 */

const crypto = require('crypto');

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

const DIRECTION_INBOUND = 'inbound';
const DIRECTION_OUTBOUND = 'outbound';

const STATUS_OPEN = 'open';
const STATUS_ESCALATED = 'escalated';
const STATUS_CLOSED = 'closed';

const USER_HELP_TEXT = [
  'Arbitrix Support',
  '',
  'Send your question as a normal message and a support agent will reply here.',
  '/escalate - request a human agent',
  '/chatid - show this chat ID'
].join('\n');

const RECEIPT_TEXT = 'Message received. Our support team will respond in this chat.';
const ESCALATION_ACK = 'Your request has been flagged for a human agent. A member of the support team will follow up in this chat.';

const ADMIN_HELP_TEXT = [
  'Arbitrix support group commands',
  '',
  'Reply directly to a forwarded message to answer that user, or:',
  '/reply <chat_id> <message> - send a reply to a user',
  '/escalate <chat_id> [reason] - flag a conversation for follow-up',
  '/close <chat_id> - close a conversation',
  '/chatid - show this group chat ID'
].join('\n');

/** Normalize a Telegram numeric id: strips surrounding quotes and whitespace. */
function normalizeTelegramId(raw) {
  const trimmed = String(raw === null || raw === undefined ? '' : raw).trim();
  return stripSurroundingQuotes(trimmed).trim();
}

/** Parse the comma-separated TELEGRAM_ADMIN_IDS value into a list of id strings. */
function parseAdminIds(raw) {
  if (raw === null || raw === undefined) return [];
  return String(raw)
    .split(',')
    .map((part) => normalizeTelegramId(part))
    .filter((part) => part.length > 0);
}

/** Shape of a real BotFather token: "<bot id>:<secret>". */
const TELEGRAM_TOKEN_FORMAT = /^\d{5,15}:[A-Za-z0-9_-]{25,}$/;

/** Remove one matching pair of surrounding quotes, if present. */
function stripSurroundingQuotes(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s.length >= 2) {
    const first = s.charAt(0);
    const last = s.charAt(s.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Normalize a raw TELEGRAM_BOT_TOKEN value.
 *
 * Hosts and copy/paste from BotFather routinely introduce formatting damage
 * that is invisible in a dashboard: a value wrapped in quotes, a leading `bot`
 * prefix pasted from an API URL, or stray whitespace. Any of those makes the
 * request URL malformed, and Telegram answers HTTP 404 "Not Found" - the same
 * response as a genuinely wrong token, which is why it is hard to diagnose.
 * Normalizing fixes only the FORMATTING of the stored credential; the
 * credential itself is never changed or rotated. The raw value is never
 * logged or returned.
 */
function normalizeTelegramToken(raw) {
  let s = String(raw === null || raw === undefined ? '' : raw).trim();
  // Loop: a value can carry several artifacts at once ("bot<token>", quotes
  // around either form, extra padding). Two passes cover every combination.
  for (let pass = 0; pass < 3; pass += 1) {
    const before = s;
    s = stripSurroundingQuotes(s).trim();
    // Pasted from https://api.telegram.org/bot<token>/getMe
    if (/^bot\d/i.test(s)) s = s.slice(3).trim();
    if (s === before) break;
  }
  return s;
}

/** True when the value looks like a real BotFather token. */
function isValidTelegramToken(token) {
  return TELEGRAM_TOKEN_FORMAT.test(String(token === null || token === undefined ? '' : token));
}

/**
 * Env keys that look like TELEGRAM_BOT_TOKEN but are not the exact key.
 *
 * A host can end up holding a case-variant (or typo) alongside the real key,
 * and only one of them is the value the code reads. Reporting the KEY NAMES
 * (never the values) is safe and makes that mistake visible.
 */
function findTelegramTokenKeyVariants(env) {
  const e = env || {};
  return Object.keys(e).filter((key) => key !== 'TELEGRAM_BOT_TOKEN' && key.toUpperCase() === 'TELEGRAM_BOT_TOKEN');
}

/**
 * Non-secret description of how a raw token is shaped.
 *
 * Reports lengths and booleans only - never any character of the value - so it
 * is safe to return from an admin diagnostic endpoint or print in a log.
 */
function describeTelegramToken(raw) {
  const rawString = raw === null || raw === undefined ? '' : String(raw);
  const trimmed = rawString.trim();
  const dequoted = stripSurroundingQuotes(trimmed).trim();
  const normalized = normalizeTelegramToken(rawString);
  const hasMatchingQuotes = trimmed.length >= 2 &&
    ((trimmed.charAt(0) === '"' && trimmed.charAt(trimmed.length - 1) === '"') ||
     (trimmed.charAt(0) === "'" && trimmed.charAt(trimmed.length - 1) === "'"));
  return {
    present: rawString.length > 0,
    length: normalized.length,
    rawLength: rawString.length,
    hadSurroundingQuotes: hasMatchingQuotes,
    hadLeadingWhitespace: /^\s/.test(rawString),
    hadTrailingWhitespace: /\s$/.test(rawString),
    hadInnerWhitespace: /\s/.test(dequoted),
    hadBotPrefix: /^bot\d/i.test(dequoted),
    changedByNormalization: normalized !== rawString,
    validFormat: isValidTelegramToken(normalized)
  };
}

/** Resolve Telegram configuration from an env-shaped object. Never logs values. */
function resolveTelegramConfig(env) {
  const e = env || {};
  const baseUrl = String(e.BASE_URL || '').trim().replace(/\/+$/, '');
  return {
    token: normalizeTelegramToken(e.TELEGRAM_BOT_TOKEN),
    supportChatId: normalizeTelegramId(e.TELEGRAM_SUPPORT_CHAT_ID) || null,
    adminIds: parseAdminIds(e.TELEGRAM_ADMIN_IDS),
    // Same class of damage as the token: a quoted value would be rejected by
    // Telegram ("secret token contains unallowed characters").
    webhookSecret: stripSurroundingQuotes(String(e.TELEGRAM_WEBHOOK_SECRET || '').trim()).trim(),
    baseUrl
  };
}

/** Constant-time string comparison (used for the webhook secret). */
function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Verify the Telegram webhook secret token. Fails closed: no configured secret
 * or no provided header means "not verified".
 */
function verifyTelegramWebhookSecret(provided, expected) {
  if (!expected) return false;
  if (!provided) return false;
  return timingSafeStringEqual(provided, expected);
}

/** True when the bot has everything it needs to receive updates. */
function isTelegramConfigured(config) {
  if (!config) return false;
  return Boolean(config.token && config.webhookSecret);
}

/** Telegram hard-caps message text at 4096 characters. */
function truncateForTelegram(text, max = TELEGRAM_MAX_MESSAGE_LENGTH) {
  const s = text === null || text === undefined ? '' : String(text);
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Message text/caption, or '' when the update carries neither (photo, sticker, ...). */
function extractMessageText(message) {
  if (!message) return '';
  if (typeof message.text === 'string') return message.text;
  if (typeof message.caption === 'string') return message.caption;
  return '';
}

/** Human-readable name for a Telegram sender. */
function telegramDisplayName(from) {
  const f = from || {};
  const name = [f.first_name, f.last_name].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (f.username) return '@' + f.username;
  if (f.id !== undefined && f.id !== null) return 'user ' + f.id;
  return null;
}

/**
 * Parse a bot command. Returns null for non-commands.
 * Handles the group form `/chatid@ArbitrixSupportBot`.
 */
function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.charAt(0) !== '/') return null;
  const spaceAt = trimmed.search(/\s/);
  const head = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
  const rest = spaceAt === -1 ? '' : trimmed.slice(spaceAt + 1).trim();
  const name = head.slice(1).split('@')[0].toLowerCase();
  if (!/^[a-z0-9_]+$/.test(name)) return null;
  return { name, rest, args: rest ? rest.split(/\s+/) : [] };
}

/**
 * Decide what an update is and who sent it.
 *
 * Returns one of:
 *   { kind: 'ignore', reason }
 *   { kind: 'user',  chatId, chatType, fromId, isAdmin, message, text, command }
 *   { kind: 'group', chatId, chatType, chatTitle, fromId, isAdmin, message, text, command }
 *
 * Group messages are only accepted from the configured support group, EXCEPT
 * while TELEGRAM_SUPPORT_CHAT_ID is unset - in that window admin messages are
 * accepted from any group so the bot can answer /chatid for setup.
 */
function routeUpdate(update, config) {
  const cfg = config || { adminIds: [], supportChatId: null };
  const adminIds = Array.isArray(cfg.adminIds) ? cfg.adminIds.map(String) : [];
  if (!update || typeof update !== 'object') return { kind: 'ignore', reason: 'no-update' };

  const message = update.message || update.edited_message;
  if (!message || !message.chat) return { kind: 'ignore', reason: 'no-message' };

  const chatType = message.chat.type;
  const chatId = message.chat.id !== undefined && message.chat.id !== null ? String(message.chat.id) : null;
  const from = message.from || {};
  const fromId = from.id !== undefined && from.id !== null ? String(from.id) : null;
  const isAdmin = fromId !== null && adminIds.indexOf(fromId) !== -1;
  const text = extractMessageText(message);
  const base = { chatId, chatType, fromId, isAdmin, message, text, command: parseCommand(text) };

  if (chatType === 'private') {
    return Object.assign({ kind: 'user' }, base);
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    if (cfg.supportChatId && chatId !== String(cfg.supportChatId)) {
      return { kind: 'ignore', reason: 'other-group' };
    }
    if (!cfg.supportChatId && !isAdmin) {
      return { kind: 'ignore', reason: 'unconfigured-group-non-admin' };
    }
    return Object.assign({ kind: 'group', chatTitle: message.chat.title || null }, base);
  }

  return { kind: 'ignore', reason: 'unsupported-chat-type' };
}

/** Bounded set of recently seen update ids (guards Telegram redeliveries). */
function createUpdateDeduper({ max = 1000 } = {}) {
  const seen = new Set();
  const order = [];
  return {
    has(updateId) {
      if (updateId === null || updateId === undefined) return false;
      return seen.has(String(updateId));
    },
    remember(updateId) {
      if (updateId === null || updateId === undefined) return;
      const key = String(updateId);
      if (seen.has(key)) return;
      seen.add(key);
      order.push(key);
      while (order.length > max) seen.delete(order.shift());
    },
    size() { return seen.size; }
  };
}

/** Bounded insertion-ordered map (group message id -> user chat id). */
function createLimitedMap({ max = 500 } = {}) {
  const map = new Map();
  return {
    get(key) {
      if (key === null || key === undefined) return null;
      return map.get(String(key)) || null;
    },
    set(key, value) {
      const k = String(key);
      if (map.has(k)) map.delete(k);
      map.set(k, value);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    size() { return map.size; }
  };
}

/** The block an agent sees in the support group for a new user message. */
function buildForwardText(conversation, chatId, name, text) {
  return [
    '📩 New support message',
    `Conversation #${conversation.id}`,
    `From: ${name || 'unknown'}`,
    `Chat ID: ${chatId}`,
    '',
    text,
    '',
    `Reply to this message, or use: /reply ${chatId} <message>`
  ].join('\n');
}

/** Telegram Bot API client. The token lives only inside the request URL. */
function createTelegramTransport({ token, fetchImpl } = {}) {
  // undefined -> use the global fetch; an explicit value (including null) wins,
  // so callers can pass an implementation or deliberately none.
  const doFetch = fetchImpl === undefined
    ? (typeof fetch === 'function' ? fetch : null)
    : fetchImpl;
  const safe = (message) => String(message === undefined || message === null ? '' : message)
    .split(String(token || '\u0000')).join('***');

  async function call(method, payload) {
    // Resolved here rather than at construction so a runtime without a global
    // fetch can still boot the app while the bot stays unconfigured.
    if (typeof doFetch !== 'function') {
      throw new Error(`No fetch implementation available for Telegram ${method}`);
    }
    let res;
    try {
      res = await doFetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
      });
    } catch (err) {
      throw new Error(`Telegram ${method} request failed: ${safe(err && err.message)}`);
    }
    let body = null;
    try {
      body = await res.json();
    } catch (err) {
      body = null;
    }
    if (!res.ok || !body || body.ok !== true) {
      const description = body && body.description ? body.description : `HTTP ${res.status}`;
      throw new Error(`Telegram ${method} failed: ${safe(description)}`);
    }
    return body.result;
  }

  return {
    sendMessage(chatId, text, options) {
      return call('sendMessage', Object.assign(
        { chat_id: chatId, text: truncateForTelegram(text), disable_web_page_preview: true },
        options || {}
      ));
    },
    setWebhook(params) {
      return call('setWebhook', params || {});
    },
    getWebhookInfo() {
      return call('getWebhookInfo', {});
    },
    getMe() {
      return call('getMe', {});
    }
  };
}

/**
 * Call a Telegram Bot API method and return a SAFE summary instead of throwing.
 *
 * createTelegramTransport.call() throws on a non-2xx response and hides the
 * HTTP status, so an operator cannot tell a 404 "Not Found" (malformed or wrong
 * bot token) from a 400 (bad parameters) or a network failure. This helper
 * returns the status/ok/description so a diagnosis can be made, while never
 * including the bot token in the returned object or the error text.
 *
 * @returns {Promise<{httpStatus:number|null, ok:boolean, errorCode:number|null,
 *                    description:string, result:object|null}>}
 */
async function probeTelegramMethod({ token, method, payload, fetchImpl } = {}) {
  const safeToken = normalizeTelegramToken(token);
  const doFetch = fetchImpl === undefined
    ? (typeof fetch === 'function' ? fetch : null)
    : fetchImpl;
  const scrub = (text) => String(text === null || text === undefined ? '' : text)
    .split(String(safeToken || '\u0000')).join('***');

  if (!safeToken) {
    return { httpStatus: null, ok: false, errorCode: null, description: 'TELEGRAM_BOT_TOKEN is not set', result: null };
  }
  if (typeof doFetch !== 'function') {
    return { httpStatus: null, ok: false, errorCode: null, description: 'No fetch implementation available for Telegram', result: null };
  }

  let res;
  try {
    res = await doFetch(`${TELEGRAM_API_BASE}/bot${safeToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
  } catch (err) {
    return {
      httpStatus: null,
      ok: false,
      errorCode: null,
      description: scrub('Request failed: ' + (err && err.message ? err.message : err)),
      result: null
    };
  }

  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  const httpStatus = typeof res.status === 'number' ? res.status : null;
  const ok = Boolean(body && body.ok === true);
  const description = body && body.description
    ? scrub(body.description)
    : (ok ? '' : 'HTTP ' + httpStatus);
  return {
    httpStatus,
    ok,
    errorCode: body && body.error_code ? body.error_code : null,
    description,
    result: ok && body.result && typeof body.result === 'object' ? body.result : null
  };
}

/**
 * Extract only the non-secret identity fields from a getMe result.
 * Bot usernames/ids are public, so this is safe to show an operator.
 */
function summarizeTelegramBot(result) {
  if (!result || typeof result !== 'object') return { botId: null, botUsername: null };
  return {
    botId: result.id !== undefined && result.id !== null ? result.id : null,
    botUsername: typeof result.username === 'string' ? result.username : null
  };
}

/** Extract only the non-secret fields from a getWebhookInfo result. */
function summarizeTelegramWebhook(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    url: typeof result.url === 'string' ? result.url : '',
    pendingUpdateCount: result.pending_update_count || 0,
    lastErrorDate: result.last_error_date || null,
    lastErrorMessage: result.last_error_message || null
  };
}

/** Updates the bot asks Telegram to deliver. */
const TELEGRAM_ALLOWED_UPDATES = ['message', 'edited_message'];

/**
 * Decide whether the registered webhook must be re-asserted.
 *
 * Re-registration is required when the registered URL is not ours, or when
 * Telegram recorded a delivery error. A rejected secret token, a wrong path and
 * an unreachable host all surface to Telegram as a failed delivery and land in
 * `lastErrorMessage`, so this single check covers every "registered but the bot
 * never replies" case.
 *
 * Pure: no network, no secrets. `webhookSummary` comes from
 * summarizeTelegramWebhook(getWebhookInfo()).
 */
function planWebhookRegistration(webhookSummary, expectedUrl) {
  const info = webhookSummary || null;
  const currentUrl = info && typeof info.url === 'string' ? info.url : '';
  const lastError = info && info.lastErrorMessage ? String(info.lastErrorMessage) : '';
  if (currentUrl !== expectedUrl) {
    return {
      needsRegistration: true,
      reason: currentUrl ? 'url-mismatch' : 'no-webhook-registered',
      currentUrl,
      lastError
    };
  }
  if (lastError) {
    return { needsRegistration: true, reason: 'telegram-last-error', currentUrl, lastError };
  }
  return { needsRegistration: false, reason: 'up-to-date', currentUrl, lastError };
}

/**
 * Build the bot from injected collaborators.
 *
 * @param {object} deps
 * @param {object} deps.config    - resolveTelegramConfig(...) output
 * @param {object} deps.store     - see services/TelegramSupportStore.js
 * @param {object} deps.transport - createTelegramTransport(...) output
 * @param {object} [deps.logger]  - console-like logger (never receives secrets)
 * @param {object} [deps.deduper] - createUpdateDeduper(...) output
 * @param {object} [deps.threadMap] - createLimitedMap(...) output
 */
function createTelegramSupportBot({ config, store, transport, logger, deduper, threadMap }) {
  if (!store) throw new Error('createTelegramSupportBot requires a store');
  if (!transport) throw new Error('createTelegramSupportBot requires a transport');
  const log = logger || console;
  const cfg = config || {};
  const adminIds = Array.isArray(cfg.adminIds) ? cfg.adminIds.map(String) : [];
  const routingConfig = { adminIds, supportChatId: cfg.supportChatId || null };
  const seenUpdates = deduper || createUpdateDeduper({ max: 1000 });
  const forwarded = threadMap || createLimitedMap({ max: 500 });

  // Secret-free delivery telemetry. This is what turns "the bot is silent" into
  // a diagnosable event: it records whether updates arrive at all, whether they
  // were rejected on the secret header, how routing classified them, and the
  // last error message (with the token scrubbed out).
  const stats = {
    updatesReceived: 0,
    duplicateUpdates: 0,
    secretRejected: 0,
    processed: 0,
    ignored: 0,
    repliesSent: 0,
    storageFailures: 0,
    lastUpdateAt: null,
    lastAction: null,
    lastReason: null,
    lastSecretRejectionAt: null,
    lastErrorStage: null,
    lastError: null
  };

  const scrub = (message) => String(message === undefined || message === null ? '' : message)
    .split(String(cfg.token || '\u0000')).join('***')
    .slice(0, 300);

  function getStats() {
    return Object.assign({}, stats);
  }

  /** Called by the webhook route when the secret header is missing/mismatched. */
  function recordRejectedSecret() {
    stats.secretRejected += 1;
    stats.lastSecretRejectionAt = new Date().toISOString();
  }

  const warn = (message) => {
    if (log && typeof log.warn === 'function') log.warn(`[Telegram] ${message}`);
  };

  function getConfig() {
    return {
      token: cfg.token || '',
      supportChatId: cfg.supportChatId || null,
      adminIds: adminIds.slice(),
      webhookSecret: cfg.webhookSecret || '',
      baseUrl: cfg.baseUrl || ''
    };
  }

  function status() {
    return {
      configured: isTelegramConfigured(cfg),
      tokenConfigured: Boolean(cfg.token),
      webhookSecretConfigured: Boolean(cfg.webhookSecret),
      supportChatConfigured: Boolean(cfg.supportChatId),
      adminIdsConfigured: adminIds.length > 0,
      baseUrlConfigured: Boolean(cfg.baseUrl),
      webhookPath: '/api/telegram/webhook',
      seenUpdates: seenUpdates.size(),
      threadedReplies: forwarded.size(),
      stats: getStats()
    };
  }

  function messageId(message) {
    return message && message.message_id !== undefined ? message.message_id : null;
  }

  function updateId(update) {
    return update && update.update_id !== undefined ? update.update_id : null;
  }

  /** Send to the user and persist an outbound row. Returns Telegram's result. */
  async function sendOutbound(conversation, body) {
    const sent = await transport.sendMessage(conversation.telegram_chat_id, body);
    stats.repliesSent += 1;
    await store.insertMessage({
      conversationId: conversation.id,
      direction: DIRECTION_OUTBOUND,
      body
    });
    return sent;
  }

  /**
   * Reply straight to a chat WITHOUT touching storage.
   *
   * Deliberately storage-free: answering `/start`, `/help` and `/chatid` is a
   * pure function of the incoming update. A database problem (missing
   * table/column, RLS/service-key, outage) must never make the bot silent.
   */
  async function replyToChat(chatId, body) {
    const sent = await transport.sendMessage(chatId, body);
    stats.repliesSent += 1;
    return sent;
  }

  /** Record a storage failure without letting it break a reply. */
  function noteStorageFailure(error) {
    const message = error && error.message ? error.message : error;
    stats.storageFailures += 1;
    stats.lastErrorStage = 'storage';
    stats.lastError = scrub(message);
    warn(`storage unavailable (${stats.lastError})`);
  }

  /** Best-effort conversation bookkeeping; never blocks a reply. */
  async function rememberConversation(route, from) {
    try {
      const { conversation } = await store.upsertConversation({
        chatId: route.chatId,
        telegramUserId: route.fromId,
        username: from.username || null,
        displayName: telegramDisplayName(from)
      });
      return conversation;
    } catch (error) {
      noteStorageFailure(error);
      return null;
    }
  }

  async function handleUserUpdate(route, update) {
    const from = route.message.from || {};
    const command = route.command;

    // Commands answer WITHOUT storage so /start can never be silenced by a
    // database problem. Booking is best-effort and logged on failure.
    if (command && (command.name === 'start' || command.name === 'help')) {
      await replyToChat(route.chatId, USER_HELP_TEXT);
      await rememberConversation(route, from);
      return { handled: true, action: 'help' };
    }

    if (command && command.name === 'chatid') {
      await replyToChat(route.chatId, `Your chat ID is: ${route.chatId}`);
      await rememberConversation(route, from);
      return { handled: true, action: 'chatid' };
    }

    let conversation = null;
    let created = false;
    try {
      const upserted = await store.upsertConversation({
        chatId: route.chatId,
        telegramUserId: route.fromId,
        username: from.username || null,
        displayName: telegramDisplayName(from)
      });
      conversation = upserted.conversation;
      created = upserted.created;
    } catch (error) {
      // A ticket cannot be queued without storage. Do NOT answer 2xx: rethrow so
      // the handler returns 500 and Telegram retries the update instead of
      // dropping the customer's message forever.
      noteStorageFailure(error);
      throw error;
    }

    if (command && command.name === 'escalate') {
      const reason = command.rest || 'User requested human support';
      await store.createEscalation({ conversationId: conversation.id });
      await store.setConversationStatus({ conversationId: conversation.id, status: STATUS_ESCALATED });
      if (cfg.supportChatId) {
        try {
          await transport.sendMessage(cfg.supportChatId, truncateForTelegram([
            '⚠️ Escalation requested',
            `Conversation #${conversation.id} · chat ${route.chatId}`,
            `From: ${conversation.display_name || telegramDisplayName(from) || 'unknown'}`,
            reason
          ].join('\n')));
        } catch (err) {
          warn(`escalation notice failed for conversation ${conversation.id}`);
        }
      }
      await sendOutbound(conversation, ESCALATION_ACK);
      return { handled: true, action: 'escalate' };
    }

    const text = route.text;
    if (!text) {
      await sendOutbound(conversation, 'Please send a text message so our support team can help.');
      return { handled: true, action: 'unsupported-content' };
    }

    await store.insertMessage({
      conversationId: conversation.id,
      direction: DIRECTION_INBOUND,
      body: text
    });

    if (cfg.supportChatId) {
      const name = conversation.display_name || telegramDisplayName(from);
      // Acknowledge the customer BEFORE forwarding. A wrong/unreachable
      // TELEGRAM_SUPPORT_CHAT_ID (or a group the bot was removed from) must
      // never leave the customer with silence.
      let acknowledged = false;
      if (created) {
        await sendOutbound(conversation, RECEIPT_TEXT);
        acknowledged = true;
      }
      try {
        const sent = await transport.sendMessage(cfg.supportChatId, buildForwardText(conversation, conversation.telegram_chat_id, name, text));
        if (sent && sent.message_id !== undefined && sent.message_id !== null) {
          forwarded.set(sent.message_id, conversation.telegram_chat_id);
        }
        return { handled: true, action: 'forwarded' };
      } catch (err) {
        warn(`forwarding to the support group failed for conversation ${conversation.id}: ${scrub(err && err.message ? err.message : err)}`);
        if (!acknowledged) {
          // The team will not see this message, so acknowledge the customer.
          try {
            await sendOutbound(conversation, RECEIPT_TEXT);
          } catch (ackError) {
            warn(`customer acknowledgement also failed for conversation ${conversation.id}: ${scrub(ackError && ackError.message ? ackError.message : ackError)}`);
          }
        }
        return { handled: true, action: 'forward-failed' };
      }
    }

    // Capture mode: TELEGRAM_SUPPORT_CHAT_ID is not set yet, so there is nowhere
    // to forward to. The message is still stored; acknowledge the first one.
    if (created) {
      await sendOutbound(conversation, RECEIPT_TEXT);
    }
    return { handled: true, action: 'stored-without-group' };
  }

  async function handleGroupUpdate(route, update) {
    if (!route.isAdmin) return { handled: false, reason: 'non-admin-group-message' };
    const command = route.command;

    if (command) {
      switch (command.name) {
        case 'chatid':
        case 'id': {
          const lines = [
            `Chat ID: ${route.chatId}`,
            `Chat type: ${route.chatType}`
          ];
          if (route.chatTitle) lines.push(`Chat title: ${route.chatTitle}`);
          lines.push(`Your user ID: ${route.fromId}`);
          lines.push('Set TELEGRAM_SUPPORT_CHAT_ID to the Chat ID above to enable forwarding.');
          await transport.sendMessage(route.chatId, lines.join('\n'));
          return { handled: true, action: 'chatid' };
        }
        case 'help': {
          await transport.sendMessage(route.chatId, ADMIN_HELP_TEXT);
          return { handled: true, action: 'help' };
        }
        case 'reply': {
          const target = command.args[0];
          const body = target ? command.rest.slice(target.length).trim() : '';
          if (!target || !body) {
            await transport.sendMessage(route.chatId, 'Usage: /reply <chat_id> <message>');
            return { handled: true, action: 'reply-usage' };
          }
          const conversation = await store.getConversationByChatId(target);
          if (!conversation) {
            await transport.sendMessage(route.chatId, `No conversation found for chat ${target}.`);
            return { handled: true, action: 'reply-missing' };
          }
          await sendOutbound(conversation, body);
          await transport.sendMessage(route.chatId, `Sent to chat ${conversation.telegram_chat_id}.`);
          return { handled: true, action: 'reply' };
        }
        case 'close': {
          const target = command.args[0];
          if (!target) {
            await transport.sendMessage(route.chatId, 'Usage: /close <chat_id>');
            return { handled: true, action: 'close-usage' };
          }
          const conversation = await store.getConversationByChatId(target);
          if (!conversation) {
            await transport.sendMessage(route.chatId, `No conversation found for chat ${target}.`);
            return { handled: true, action: 'close-missing' };
          }
          await store.setConversationStatus({ conversationId: conversation.id, status: STATUS_CLOSED });
          await transport.sendMessage(route.chatId, `Conversation #${conversation.id} closed.`);
          return { handled: true, action: 'close' };
        }
        case 'escalate': {
          const target = command.args[0];
          if (!target) {
            await transport.sendMessage(route.chatId, 'Usage: /escalate <chat_id> [reason]');
            return { handled: true, action: 'escalate-usage' };
          }
          const conversation = await store.getConversationByChatId(target);
          if (!conversation) {
            await transport.sendMessage(route.chatId, `No conversation found for chat ${target}.`);
            return { handled: true, action: 'escalate-missing' };
          }
          await store.createEscalation({ conversationId: conversation.id });
          await store.setConversationStatus({ conversationId: conversation.id, status: STATUS_ESCALATED });
          await transport.sendMessage(route.chatId, `Conversation #${conversation.id} escalated.`);
          return { handled: true, action: 'escalate' };
        }
        default:
          return { handled: false, reason: 'unknown-command' };
      }
    }

    const repliedTo = route.message.reply_to_message && route.message.reply_to_message.message_id;
    if (repliedTo !== undefined && repliedTo !== null) {
      if (!route.text) return { handled: false, reason: 'empty-reply' };
      const targetChatId = forwarded.get(repliedTo);
      if (!targetChatId) return { handled: false, reason: 'reply-unmapped' };
      const conversation = await store.getConversationByChatId(targetChatId);
      if (!conversation) return { handled: false, reason: 'reply-conversation-missing' };
      await sendOutbound(conversation, route.text);
      return { handled: true, action: 'admin-reply' };
    }

    return { handled: false, reason: 'group-no-action' };
  }

  async function handleUpdate(update) {
    stats.updatesReceived += 1;
    stats.lastUpdateAt = new Date().toISOString();
    // Reset per-update so the reported stage always belongs to THIS update.
    stats.lastErrorStage = null;

    const id = updateId(update);
    if (seenUpdates.has(id)) {
      stats.duplicateUpdates += 1;
      stats.lastAction = 'duplicate';
      return { handled: true, action: 'duplicate' };
    }

    const route = routeUpdate(update, routingConfig);
    if (route.kind === 'ignore') {
      stats.ignored += 1;
      stats.lastAction = 'ignored';
      stats.lastReason = route.reason;
      return { handled: false, reason: route.reason };
    }

    try {
      const result = route.kind === 'group'
        ? await handleGroupUpdate(route, update)
        : await handleUserUpdate(route, update);
      stats.processed += 1;
      stats.lastAction = (result && result.action) || (result && result.handled ? 'handled' : 'no-action');
      stats.lastReason = (result && result.reason) || null;
      seenUpdates.remember(id);
      return result;
    } catch (error) {
      stats.lastErrorStage = stats.lastErrorStage || 'processing';
      stats.lastError = scrub(error && error.message ? error.message : error);
      stats.lastAction = 'error';
      stats.lastReason = 'processing-error';
      throw error;
    }
  }

  /**
   * Read-only storage preflight.
   *
   * Verifies the Telegram tables are actually reachable with the client the bot
   * was built with (a missing table/column, RLS or a missing service key all
   * fail here). Called at boot so a broken store is visible immediately instead
   * of silently swallowing every customer message. Never throws; never returns
   * or logs a secret.
   */
  async function checkStorage() {
    try {
      const probe = await store.getConversationByChatId(cfg.supportChatId || '0');
      return { ok: true, error: null, probeFound: Boolean(probe) };
    } catch (error) {
      const message = scrub(error && error.message ? error.message : error);
      stats.lastErrorStage = 'storage-preflight';
      stats.lastError = message;
      return { ok: false, error: message };
    }
  }

  /**
   * Compare Telegram's registered webhook with what this deployment expects and
   * re-register when they differ.
   *
   * Re-registering also re-asserts `secret_token`. That repairs the common
   * production failure where the webhook was registered before (or without) the
   * current secret, after which every delivery is rejected and the bot is
   * silent even though getMe and setWebhook both report success.
   *
   * Never throws and never returns or logs a secret value.
   *
   * @param {object} [options]
   * @param {boolean} [options.force] - re-register even when the current state
   *   looks healthy. Used on boot, because `getWebhookInfo` does NOT reveal
   *   whether a secret_token is registered, so only an explicit re-assert can
   *   guarantee the running config matches Telegram's.
   */
  async function ensureWebhookRegistration({ force = false } = {}) {
    const expectedUrl = cfg.baseUrl ? `${cfg.baseUrl}/api/telegram/webhook` : null;
    if (!isTelegramConfigured(cfg) || !expectedUrl) {
      return { ok: false, reason: 'not-configured', reRegistered: false, plan: null, webhook: null };
    }

    let summary = null;
    let probeError = null;
    try {
      summary = summarizeTelegramWebhook(await transport.getWebhookInfo());
    } catch (error) {
      probeError = scrub(error && error.message ? error.message : error);
    }

    const plan = planWebhookRegistration(summary, expectedUrl);
    const base = { plan, webhook: summary, probeError };

    // Without a reliable "current state" we still re-assert once: registering
    // the correct URL + secret is idempotent and is the safer default.
    const needsRegistration = force || probeError ? true : plan.needsRegistration;
    if (!needsRegistration) {
      return Object.assign({ ok: true, reRegistered: false, reason: plan.reason }, base);
    }

    try {
      await transport.setWebhook({
        url: expectedUrl,
        secret_token: cfg.webhookSecret,
        allowed_updates: TELEGRAM_ALLOWED_UPDATES
      });
      return Object.assign({
        ok: true,
        reRegistered: true,
        reason: force ? 'forced-reassert' : (probeError ? 'probe-failed-reasserted' : plan.reason)
      }, base);
    } catch (error) {
      return Object.assign({
        ok: false,
        reRegistered: false,
        reason: 'set-webhook-failed',
        error: scrub(error && error.message ? error.message : error)
      }, base);
    }
  }

  /** Register the webhook with Telegram. Never returns the secret token. */
  async function setWebhook() {
    if (!cfg.token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    if (!cfg.webhookSecret) throw new Error('TELEGRAM_WEBHOOK_SECRET is not set');
    if (!cfg.baseUrl) throw new Error('BASE_URL is not set');
    const url = `${cfg.baseUrl}/api/telegram/webhook`;
    await transport.setWebhook({
      url,
      secret_token: cfg.webhookSecret,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES
    });
    return { url, webhookPath: '/api/telegram/webhook' };
  }

  async function getWebhookInfo() {
    return transport.getWebhookInfo();
  }

  return { handleUpdate, setWebhook, getWebhookInfo, getConfig, status, ensureWebhookRegistration, checkStorage, getStats, recordRejectedSecret };
}

/**
 * Build the Express route handler for POST /api/telegram/webhook.
 *
 * Behaviour (all fail-closed):
 *   - 503 when the bot is not configured (no token or no webhook secret).
 *   - 401 when the X-Telegram-Bot-Api-Secret-Token header is missing/mismatched
 *     (constant-time compare). The header value is never logged.
 *   - 200 otherwise, even if processing throws, so Telegram does not retry a
 *     poisoned update forever; the error is logged without secrets.
 */
function createTelegramWebhookHandler({ bot, logger }) {
  if (!bot) throw new Error('createTelegramWebhookHandler requires a bot');
  const log = logger || console;

  return async function telegramWebhookHandler(req, res) {
    const config = bot.getConfig();
    if (!isTelegramConfigured(config)) {
      return res.status(503).json({ ok: false, error: 'Telegram bot not configured' });
    }

    const provided = typeof req.get === 'function'
      ? req.get('x-telegram-bot-api-secret-token')
      : (req.headers ? req.headers['x-telegram-bot-api-secret-token'] : undefined);

    if (!verifyTelegramWebhookSecret(provided, config.webhookSecret)) {
      if (typeof bot.recordRejectedSecret === 'function') bot.recordRejectedSecret();
      if (log && typeof log.warn === 'function') {
        // A MISSING header while a secret IS configured is the signature of a
        // webhook registered without (or with a different) secret_token:
        // Telegram cannot match, so every delivery is refused and the bot looks
        // dead even though getMe/setWebhook both succeed. Re-registering repairs
        // it; the startup reconciliation does this automatically.
        log.warn(provided
          ? '[Telegram] Webhook rejected: secret token header does not match'
          : '[Telegram] Webhook rejected: secret token header missing - the registered webhook carries no/another secret_token');
      }
      return res.status(401).json({ ok: false });
    }

    try {
      const result = await bot.handleUpdate(req.body);
      const action = result && result.action
        ? result.action
        : (result && result.handled ? 'handled' : 'no-action');
      if (log && typeof log.log === 'function') {
        log.log(`[Telegram] update received -> ${action}${result && result.reason ? ' (' + result.reason + ')' : ''}`);
      }
      return res.status(200).json({ ok: true, handled: Boolean(result && result.handled) });
    } catch (error) {
      // A processing failure is NOT a delivered update. Answering 200 here would
      // make Telegram drop the customer's message forever AND record no error at
      // all (a silently dead bot). 500 keeps the update queued, makes Telegram
      // retry it, and surfaces the failure in getWebhookInfo.last_error_message.
      const stage = (bot.getStats && bot.getStats().lastErrorStage) || 'processing';
      if (log && typeof log.error === 'function') {
        log.error(`[Telegram] processing failed at ${stage}: ` +
          (error && error.message ? error.message : error) +
          ' (answering 500 so Telegram retries; check storage/webhook config)');
      }
      return res.status(500).json({ ok: false, error: 'processing_failed', stage });
    }
  };
}

module.exports = {
  TELEGRAM_API_BASE,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  DIRECTION_INBOUND,
  DIRECTION_OUTBOUND,
  STATUS_OPEN,
  STATUS_ESCALATED,
  STATUS_CLOSED,
  USER_HELP_TEXT,
  RECEIPT_TEXT,
  ESCALATION_ACK,
  ADMIN_HELP_TEXT,
  parseAdminIds,
  normalizeTelegramId,
  TELEGRAM_TOKEN_FORMAT,
  stripSurroundingQuotes,
  normalizeTelegramToken,
  isValidTelegramToken,
  findTelegramTokenKeyVariants,
  describeTelegramToken,
  resolveTelegramConfig,
  probeTelegramMethod,
  summarizeTelegramBot,
  summarizeTelegramWebhook,
  TELEGRAM_ALLOWED_UPDATES,
  planWebhookRegistration,
  timingSafeStringEqual,
  verifyTelegramWebhookSecret,
  isTelegramConfigured,
  truncateForTelegram,
  extractMessageText,
  telegramDisplayName,
  parseCommand,
  routeUpdate,
  createUpdateDeduper,
  createLimitedMap,
  buildForwardText,
  createTelegramTransport,
  createTelegramSupportBot,
  createTelegramWebhookHandler
};
