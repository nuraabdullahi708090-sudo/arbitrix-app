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

// Live `telegram_support_messages.direction` CHECK:
//   CHECK (direction = ANY (ARRAY['customer'::text, 'bot'::text, 'agent'::text]))
// The pre-existing production table is authoritative; migration 027's file
// still carries a legacy ('inbound','outbound') CHECK (documented there).
const DIRECTION_CUSTOMER = 'customer'; // incoming customer message
const DIRECTION_BOT = 'bot';           // automated bot/AI reply
const DIRECTION_AGENT = 'agent';       // human support-agent reply

// NOTE (conversation status): this service does NOT write
// telegram_support_conversations.status. The live table's CHECK rejected the
// legacy 'escalated' literal with 23514 and its allowed values cannot be read
// through PostgREST, so no status literal is guessed (see
// CONFIRMED_CONVERSATION_STATUSES in TelegramSupportStore.js). Escalations are
// recorded in telegram_support_escalations and announced to the support group.

/**
 * Sent to a customer when a storage write fails.
 *
 * A storage outage must never leave the customer in silence, but it must also
 * not be answered with 2xx: the update is redelivered until it can be stored, so
 * the ticket is never lost. This message is the courtesy half of that trade-off
 * and touches no database.
 */
const STORAGE_DEGRADED_TEXT =
  'We received your message. Our support system is temporarily unavailable, so ' +
  'our team may take longer than usual to reply.';

/**
 * Map a PostgREST/Postgres error code to a plain-English cause and remedy.
 *
 * The code is what actually distinguishes these failures; the wording of
 * `message` varies between PostgREST versions.
 */
const STORAGE_ERROR_CAUSES = {
  '42P01': {
    cause: 'table-missing',
    remedy: 'Apply supabase/migrations/027_telegram_support_bot.sql to this Supabase project.'
  },
  PGRST205: {
    cause: 'table-missing',
    remedy: 'Apply supabase/migrations/027_telegram_support_bot.sql to this Supabase project.'
  },
  '42703': {
    cause: 'column-missing',
    remedy: 'The applied table differs from migration 027. The message names the column; add it, or align the store with the applied schema.'
  },
  PGRST204: {
    cause: 'column-missing',
    remedy: 'The applied table differs from migration 027. The message names the column; add it, or align the store with the applied schema.'
  },
  '42501': {
    cause: 'permission-denied',
    remedy: 'RLS/privileges are blocking this write. The bot must run with the SERVICE-ROLE key (SUPABASE_SERVICE_KEY); the anon key cannot write these tables.'
  },
  '23514': {
    cause: 'check-constraint-violation',
    remedy: 'A CHECK constraint rejected the row. The message names the constraint - align the DIRECTION_* constants (customer/bot/agent) or the STATUS_* literals with the values the applied table allows.'
  },
  '23502': {
    cause: 'not-null-violation',
    remedy: 'The applied table has a NOT NULL column that the store does not write.'
  },
  '23503': {
    cause: 'foreign-key-violation',
    remedy: 'The referenced conversation row does not exist in the applied table.'
  },
  '23505': {
    cause: 'unique-violation',
    remedy: 'A unique constraint was violated (most likely a duplicate telegram_chat_id).'
  },
  PGRST301: {
    cause: 'invalid-or-missing-api-key',
    remedy: 'Supabase rejected the client credentials. Check SUPABASE_SERVICE_KEY in the host environment.'
  }
};

/** Classify a storage error without exposing the client credentials. */
function classifyStorageError(error) {
  const code = (error && error.supabase && error.supabase.code) || (error && error.code) || null;
  const message = error && error.message ? String(error.message) : String(error || '');
  const known = STORAGE_ERROR_CAUSES[String(code)];
  if (known) return { code: code || null, cause: known.cause, remedy: known.remedy };
  // PostgREST does not send a code for every failure; fall back to the wording.
  if (/does not exist|schema cache/i.test(message)) {
    return {
      code: code || null,
      cause: 'relation-or-column-missing',
      remedy: 'A table or column the store writes is absent from the applied schema. Compare it with migration 027.'
    };
  }
  if (/permission denied|row-level security/i.test(message)) {
    return {
      code: code || null,
      cause: 'permission-denied',
      remedy: 'RLS/privileges are blocking this write; confirm the bot uses the SERVICE-ROLE key (SUPABASE_SERVICE_KEY).'
    };
  }
  return { code: code || null, cause: 'unknown', remedy: 'Read the captured message in the delivery trace.' };
}

const USER_HELP_TEXT = [
  'Arbitrix Support',
  '',
  'Send your question as a normal message and a support agent will reply here.',
  '/escalate - request a human agent',
  '/chatid - show this chat ID'
].join('\n');

// Sent to the customer for EVERY ordinary (non-command) message. It both
// acknowledges the message and guides the customer, including the /escalate
// hint. It replaces the old receipt that was sent only when the conversation had
// just been created - which left customers with no reply at all whenever their
// conversation already existed (e.g. created by /chatid or /escalate) and for
// every message after their first.
const CUSTOMER_GUIDE_TEXT =
  'Thanks for contacting Arbitrix Support. Please describe your issue, and a support agent will assist you here. You can also use /escalate to request a human agent.';
const ESCALATION_ACK = 'Your request has been flagged for a human agent. A member of the support team will follow up in this chat.';

// Stage 2: the AI support layer answers ordinary customer messages from the
// approved knowledge base (services/support/SupportAIService.js). It is injected
// by server.js ONLY when AI_SUPPORT_ENABLED=true - with no `supportAI` the reply
// is exactly CUSTOMER_GUIDE_TEXT above, so the default behaviour is unchanged.
const SUPPORT_AI_MAX_QUESTION_CHARS = 2000;

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

/**
 * Telegram's `secret_token` charset: "1-256 characters. Only characters A-Z,
 * a-z, 0-9, _ and - are allowed."
 *
 * https://core.telegram.org/bots/api#setwebhook
 *
 * Telegram REJECTS a setWebhook call whose secret_token contains anything else
 * with `Bad Request: secret token contains illegal characters`. The rejection
 * leaves the PREVIOUS registration in place, so the bot silently stops
 * receiving updates while `getMe`/`setWebhook` appear to work - which is exactly
 * how this shipped to production once. Validate before calling Telegram.
 */
const TELEGRAM_SECRET_FORMAT = /^[A-Za-z0-9_-]{1,256}$/;
const TELEGRAM_SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

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
 * True when the value is a Telegram-compatible `secret_token`.
 *
 * Only A-Z a-z 0-9 _ - are permitted, 1-256 characters. Anything else makes
 * Telegram reject setWebhook, which leaves the old registration in place and
 * makes the bot silently miss every update.
 */
function isValidTelegramWebhookSecret(secret) {
  return TELEGRAM_SECRET_FORMAT.test(String(secret === null || secret === undefined ? '' : secret));
}

/**
 * Generate a Telegram-compatible webhook secret.
 *
 * Maps crypto-random bytes onto Telegram's permitted alphabet (rejection
 * sampling, so every character is uniformly likely), which guarantees the value
 * passes setWebhook. Never log the return value.
 */
function generateTelegramWebhookSecret(length = 48) {
  const size = Math.min(Math.max(Number(length) || 48, 32), 256);
  const out = [];
  while (out.length < size) {
    for (const byte of crypto.randomBytes(size)) {
      if (byte < 256 - (256 % TELEGRAM_SECRET_ALPHABET.length)) {
        out.push(TELEGRAM_SECRET_ALPHABET[byte % TELEGRAM_SECRET_ALPHABET.length]);
      }
      if (out.length === size) break;
    }
  }
  return out.join('');
}

/**
 * Non-secret description of how a raw webhook secret is shaped.
 *
 * Returns booleans, a length and a count only - never any character of the
 * value - so it is safe for logs and admin diagnostics.
 */
function describeTelegramWebhookSecret(raw) {
  const rawString = raw === null || raw === undefined ? '' : String(raw);
  const trimmed = rawString.trim();
  const dequoted = stripSurroundingQuotes(trimmed).trim();
  const normalised = dequoted;
  const illegal = normalised.split('').filter((ch) => !/[A-Za-z0-9_-]/.test(ch));
  return {
    present: rawString.length > 0,
    length: normalised.length,
    rawLength: rawString.length,
    hadSurroundingQuotes: trimmed.length >= 2 &&
      ((trimmed.charAt(0) === '"' && trimmed.charAt(trimmed.length - 1) === '"') ||
       (trimmed.charAt(0) === "'" && trimmed.charAt(trimmed.length - 1) === "'")),
    hadWhitespace: /\s/.test(trimmed),
    disallowedCharCount: illegal.length,
    // Distinct offending characters, never the value itself.
    disallowedCharClasses: Array.from(new Set(illegal.map((ch) => {
      if (/\s/.test(ch)) return 'whitespace';
      if (/[A-Za-z0-9_-]/.test(ch)) return 'allowed';
      return 'punctuation-or-symbol';
    }))).filter((c) => c !== 'allowed'),
    withinLengthLimit: normalised.length >= 1 && normalised.length <= 256,
    validFormat: isValidTelegramWebhookSecret(normalised)
  };
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
  // Normalize formatting damage only (quotes/whitespace). The value itself is
  // never altered: if it still contains characters Telegram does not allow, it
  // is reported as INVALID rather than silently rewritten, because a silently
  // mutated credential is worse than a loud configuration error.
  const webhookSecret = stripSurroundingQuotes(String(e.TELEGRAM_WEBHOOK_SECRET || '').trim()).trim();
  return {
    token: normalizeTelegramToken(e.TELEGRAM_BOT_TOKEN),
    supportChatId: normalizeTelegramId(e.TELEGRAM_SUPPORT_CHAT_ID) || null,
    adminIds: parseAdminIds(e.TELEGRAM_ADMIN_IDS),
    // Same class of damage as the token: a quoted value is rejected by Telegram
    // ("secret token contains illegal characters").
    webhookSecret,
    webhookSecretValid: isValidTelegramWebhookSecret(webhookSecret),
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

  // Outcome of the most recent Telegram API call: HTTP status plus Telegram's
  // error_code/description, scrubbed of the token. Never carries the request
  // body, the chat id or any customer content.
  let lastCall = null;

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
      lastCall = {
        method,
        httpStatus: null,
        ok: false,
        errorCode: null,
        description: safe(err && err.message).slice(0, 200),
        at: new Date().toISOString()
      };
      throw new Error(`Telegram ${method} request failed: ${safe(err && err.message)}`);
    }
    let body = null;
    try {
      body = await res.json();
    } catch (err) {
      body = null;
    }
    const ok = Boolean(res.ok && body && body.ok === true);
    lastCall = {
      method,
      httpStatus: typeof res.status === 'number' ? res.status : null,
      ok,
      errorCode: body && body.error_code ? body.error_code : null,
      description: body && body.description
        ? safe(body.description).slice(0, 200)
        : (ok ? null : `HTTP ${res.status}`),
      at: new Date().toISOString()
    };
    if (!ok || !body || body.ok !== true) {
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
    },
    getLastCall() {
      return lastCall;
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
 * @param {object} [deps.supportAI] - OPTIONAL support AI answerer
 *   (services/support/SupportAIService.js). Absent = AI off = the standard guide
 *   text. It receives ONLY the customer's message text and returns a string;
 *   it has no database, trading, withdrawal or account access.
 */
function createTelegramSupportBot({ config, store, transport, logger, deduper, threadMap, supportAI }) {
  if (!store) throw new Error('createTelegramSupportBot requires a store');
  if (!transport) throw new Error('createTelegramSupportBot requires a transport');
  const log = logger || console;
  const cfg = config || {};
  // Optional AI answerer (Stage 2). Absent/null => AI off => standard guide text.
  // It is only ever handed the customer's message text (see composeCustomerReply).
  const ai = supportAI && typeof supportAI.ask === 'function' ? supportAI : null;
  const adminIds = Array.isArray(cfg.adminIds) ? cfg.adminIds.map(String) : [];
  const routingConfig = { adminIds, supportChatId: cfg.supportChatId || null };
  const seenUpdates = deduper || createUpdateDeduper({ max: 1000 });
  const forwarded = threadMap || createLimitedMap({ max: 500 });
  // Update ids already answered with the storage-degraded notice, so Telegram's
  // retries do not send the customer one apology per attempt.
  const degradedAcks = createUpdateDeduper({ max: 500 });

  // Secret-free delivery telemetry: enough to locate the exact failing stage of
  // a delivery without ever recording a token, secret, JWT or message text.
  /**
   * Delivery trace.
   *
   * Records enough to locate the exact failing stage of a Telegram delivery
   * WITHOUT any secret or customer content: how many requests arrived, how many
   * passed/failed the secret check, the last update timestamp, the last routing
   * action, the last processing stage, the HTTP status we answered with, and the
   * outcome of the last Telegram API call (sendMessage status + description).
   */
  const stats = {
    requestsReceived: 0,
    secretPassed: 0,
    secretRejected: 0,
    updatesReceived: 0,
    duplicateUpdates: 0,
    processed: 0,
    ignored: 0,
    repliesSent: 0,
    storageFailures: 0,
    lastUpdateAt: null,
    lastUpdateId: null,
    lastAction: null,
    lastReason: null,
    lastStage: null,
    lastSecretRejectionAt: null,
    lastResponseStatus: null,
    lastResponseAt: null,
    lastPendingResult: null,
    lastErrorStage: null,
    lastError: null,
    lastErrorCode: null,
    lastErrorDetails: null,
    lastErrorHint: null,
    storageCause: null,
    lastRegistration: null,
    // Stage 2 AI answering. All zero while AI_SUPPORT_ENABLED is off.
    aiEnabled: Boolean(ai),
    aiReplies: 0,
    aiHandoffs: 0,
    aiFailures: 0
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
    stats.lastStage = 'secret-rejected';
    stats.lastPendingResult = 'rejected (Telegram records last_error_message and retries)';
  }

  /** Called by the webhook route for every POST it receives, before validation. */
  function recordRequest() {
    stats.requestsReceived += 1;
  }

  /** Called by the webhook route once the secret header has been verified. */
  function recordSecretPassed() {
    stats.secretPassed += 1;
  }

  /** Record the HTTP status this server answered the webhook with. */
  function noteResponse(statusCode) {
    stats.lastResponseStatus = statusCode;
    stats.lastResponseAt = new Date().toISOString();
    if (statusCode >= 200 && statusCode < 300) {
      stats.lastPendingResult = 'acknowledged 2xx (update leaves the Telegram pending queue)';
    } else if (statusCode === 401) {
      stats.lastPendingResult = 'rejected 401 (Telegram sets last_error_message and retries)';
    } else if (statusCode >= 500) {
      stats.lastPendingResult = 'retry 5xx (Telegram keeps it pending and retries)';
    } else {
      stats.lastPendingResult = `not-acknowledged ${statusCode} (Telegram keeps it pending and retries)`;
    }
  }

  /** Mark the phase of the update currently being processed. */
  function markStage(stage) {
    stats.lastStage = stage;
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
      webhookSecretValid: isValidTelegramWebhookSecret(cfg.webhookSecret),
      baseUrl: cfg.baseUrl || ''
    };
  }

  function status() {
    return {
      configured: isTelegramConfigured(cfg),
      tokenConfigured: Boolean(cfg.token),
      webhookSecretConfigured: Boolean(cfg.webhookSecret),
      // Telegram-compatibility of the configured secret - booleans and a length
      // only, never the value. False means setWebhook will be REJECTED, which
      // silently leaves the previous webhook registration in place.
      webhookSecretFormatValid: isValidTelegramWebhookSecret(cfg.webhookSecret),
      webhookSecretLength: String(cfg.webhookSecret || '').length,
      webhookSecretIssues: describeTelegramWebhookSecret(cfg.webhookSecret),
      supportChatConfigured: Boolean(cfg.supportChatId),
      adminIdsConfigured: adminIds.length > 0,
      baseUrlConfigured: Boolean(cfg.baseUrl),
      webhookPath: '/api/telegram/webhook',
      // Whether the configured client can actually reach the Telegram tables.
      // Populated by checkStorage() at boot; null until then.
      storage: stats.lastErrorStage === 'storage-preflight'
        ? { ok: false, cause: stats.storageCause, code: stats.lastErrorCode, error: stats.lastError }
        : null,
      seenUpdates: seenUpdates.size(),
      threadedReplies: forwarded.size(),
      // Stage 2: whether the AI answerer is wired in, and which provider backs
      // it. Booleans/name only - never an API key or any configuration value.
      supportAIEnabled: Boolean(ai),
      aiProvider: ai && typeof ai.providerName === 'function' ? ai.providerName() : null,
      // Last Telegram API call outcome (sendMessage status + Telegram's own
      // description) - token scrubbed, no chat id, no message text.
      lastApiCall: transport.getLastCall ? transport.getLastCall() : null,
      stats: getStats()
    };
  }

  function messageId(message) {
    return message && message.message_id !== undefined ? message.message_id : null;
  }

  function updateId(update) {
    return update && update.update_id !== undefined ? update.update_id : null;
  }

  /**
   * Send to the customer and persist a reply row.
   *
   * `direction` distinguishes the two outbound kinds the live CHECK allows:
   * DIRECTION_BOT for an automated acknowledgement/reply (the default, which
   * every automated call site relies on) and DIRECTION_AGENT for a reply typed
   * by a human support agent. Returns Telegram's result.
   */
  async function sendOutbound(conversation, body, direction = DIRECTION_BOT) {
    markStage('sendMessage');
    const sent = await transport.sendMessage(conversation.telegram_chat_id, body);
    stats.repliesSent += 1;
    await store.insertMessage({
      conversationId: conversation.id,
      direction,
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
  async function replyToChat(chatId, body, { stage = 'sendMessage' } = {}) {
    // `stage: null` keeps the CURRENT stage, which is what the storage-degraded
    // acknowledgement needs: it must not overwrite the storage stage that is the
    // whole point of the trace.
    if (stage) markStage(stage);
    const sent = await transport.sendMessage(chatId, body);
    stats.repliesSent += 1;
    return sent;
  }

  /**
   * Record a storage failure without letting it break a reply.
   *
   * Idempotent per error object: the same error can pass through an inner catch
   * (this function) and the outer per-update catch, and counting it twice would
   * make the failure counter drift away from reality.
   *
   * The PostgREST `code`/`details`/`hint` are preserved so the trace can name
   * the CAUSE (table missing vs column mismatch vs RLS vs constraint) instead of
   * only proving that something failed.
   */
  function noteStorageFailure(error) {
    if (error && error.__storageFailureNoted) return;
    if (error && typeof error === 'object') {
      try { error.__storageFailureNoted = true; } catch (err) { /* frozen error object */ }
    }
    stats.storageFailures += 1;
    stats.lastErrorStage = stats.lastStage || 'storage';
    stats.lastError = scrub(error && error.message ? error.message : error);
    stats.lastErrorCode = (error && error.supabase && error.supabase.code)
      || (error && error.code)
      || null;
    stats.lastErrorDetails = scrub((error && error.supabase && error.supabase.details)
      || (error && error.details) || '') || null;
    stats.lastErrorHint = scrub((error && error.supabase && error.supabase.hint)
      || (error && error.hint) || '') || null;
    stats.storageCause = classifyStorageError(error).cause;
    warn(`storage unavailable [${stats.lastErrorStage}] cause=${stats.storageCause}: ${stats.lastError}`);
  }

  /**
   * Best-effort customer acknowledgement when storage is unavailable.
   *
   * The update is still answered 5xx so Telegram redelivers it and the ticket is
   * not lost, but the customer must not be left in silence while that happens.
   * Deduplicated by update id so the retries do not produce one apology each.
   * In-process only: a restart can at worst produce one extra message, which is
   * preferable to silence.
   */
  async function acknowledgeStorageDegraded(update, route) {
    const id = updateId(update);
    if (id !== null && id !== undefined) {
      if (degradedAcks.has(id)) return false;
      degradedAcks.remember(id);
    }
    try {
      // `stage: null`: this reply is a consequence of the storage failure, so it
      // must not replace the storage stage in the trace.
      await replyToChat(route.chatId, STORAGE_DEGRADED_TEXT, { stage: null });
      return true;
    } catch (error) {
      warn(`degraded-storage acknowledgement failed: ${scrub(error && error.message ? error.message : error)}`);
      return false;
    }
  }

  /** Best-effort conversation bookkeeping; never blocks a reply. */
  async function rememberConversation(route, from) {
    try {
      markStage('storage:bookkeeping');
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

  /**
   * Compose the reply to an ORDINARY (non-command) customer message.
   *
   * No AI (the default): returns the standard acknowledgement/guide text, so the
   * behaviour of the bot is byte-identical to before Stage 2.
   *
   * With AI: asks the support AI layer for an answer built ONLY from approved
   * knowledge. SupportAIService itself performs the safety checks (no invented
   * facts, no promises, no secrets, no personalized advice, unresolved conflicts
   * and sensitive account topics handed to a human).
   *
   * The AI is handed NOTHING but the customer's message text - no chat id, no
   * user id, no account data, no wallet, no tools. It cannot read or write
   * anything; this function only receives a string back.
   *
   * Any failure (provider error, empty answer) falls back to the standard text,
   * so the customer is never left without a reply.
   */
  async function composeCustomerReply(text) {
    if (!ai) return CUSTOMER_GUIDE_TEXT;
    // A disabled service must never change customer-visible behaviour.
    if (typeof ai.isEnabled === 'function' && !ai.isEnabled()) return CUSTOMER_GUIDE_TEXT;
    try {
      markStage('support-ai');
      const question = String(text === null || text === undefined ? '' : text).slice(0, SUPPORT_AI_MAX_QUESTION_CHARS);
      const result = await ai.ask(question);
      if (result && typeof result.answer === 'string' && result.answer.trim().length > 0) {
        stats.aiReplies += 1;
        if (result.needsHuman) stats.aiHandoffs += 1;
        return result.answer.trim();
      }
      stats.aiFailures += 1;
    } catch (error) {
      // The AI must never be able to silence support: log and fall back.
      stats.aiFailures += 1;
      warn(`support AI failed; sending the standard acknowledgement: ${scrub(error && error.message ? error.message : error)}`);
    }
    return CUSTOMER_GUIDE_TEXT;
  }

  async function handleUserUpdate(route, update) {
    const from = route.message.from || {};
    const command = route.command;

    // Commands answer WITHOUT storage so /start can never be silenced by a
    // database problem. Booking is best-effort and logged on failure.
    if (command && (command.name === 'start' || command.name === 'help')) {
      markStage('reply:help');
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
      markStage('storage:upsert-conversation');
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
      await acknowledgeStorageDegraded(update, route);
      throw error;
    }

    if (command && command.name === 'escalate') {
      const reason = command.rest || 'User requested human support';
      // The live escalations table requires support_message_id NOT NULL (the id
      // of the escalated message), so the incoming customer message is persisted
      // FIRST and that exact row id is referenced. A storage failure here keeps
      // the update queued (500) instead of writing a null reference.
      let escalated = null;
      try {
        markStage('storage:insert-message');
        const inserted = await store.insertMessage({
          conversationId: conversation.id,
          direction: DIRECTION_CUSTOMER,
          body: route.text || reason
        });
        escalated = inserted && inserted.message ? inserted.message : null;
      } catch (error) {
        noteStorageFailure(error);
        await acknowledgeStorageDegraded(update, route);
        throw error;
      }
      if (!escalated || escalated.id === undefined || escalated.id === null) {
        const missingId = new Error('escalation aborted: the inserted message did not return an id');
        noteStorageFailure(missingId);
        await acknowledgeStorageDegraded(update, route);
        throw missingId;
      }
      markStage('storage:create-escalation');
      await store.createEscalation({ conversationId: conversation.id, supportMessageId: escalated.id });
      // The conversation status is deliberately NOT written: the live CHECK
      // rejected the legacy vocabulary with 23514. The escalation row above is
      // the authoritative record (see CONFIRMED_CONVERSATION_STATUSES).
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

    try {
      markStage('storage:insert-message');
      await store.insertMessage({
        conversationId: conversation.id,
        direction: DIRECTION_CUSTOMER,
        body: text
      });
    } catch (error) {
      // Same contract as the conversation upsert: keep the update queued (500 so
      // Telegram redelivers) but never leave the customer in silence.
      noteStorageFailure(error);
      await acknowledgeStorageDegraded(update, route);
      throw error;
    }

    // Acknowledge AND guide the customer on EVERY ordinary message, BEFORE any
    // forwarding. This is the fix for "normal messages are silent": the reply
    // used to be gated on `created`, so a customer whose conversation already
    // existed (created by /chatid, /start or /escalate) - and every message
    // after their first - received no reply at all.
    //
    // Stage 2: when the AI support layer is enabled, composeCustomerReply returns
    // its (already safety-checked) answer instead of the generic guide text. The
    // message is still PERSISTED and still FORWARDED below either way, so the
    // human support system keeps the full record and /escalate is unaffected.
    //
    // A send failure propagates (HTTP 500) so Telegram redelivers instead of
    // dropping the message; a successfully processed update is recorded in the
    // deduper, so a redelivery can never duplicate this reply.
    await sendOutbound(conversation, await composeCustomerReply(text));

    if (cfg.supportChatId) {
      const name = conversation.display_name || telegramDisplayName(from);
      try {
        markStage('forwardToSupportGroup');
        const sent = await transport.sendMessage(cfg.supportChatId, buildForwardText(conversation, conversation.telegram_chat_id, name, text));
        if (sent && sent.message_id !== undefined && sent.message_id !== null) {
          forwarded.set(sent.message_id, conversation.telegram_chat_id);
        }
        return { handled: true, action: 'forwarded' };
      } catch (err) {
        // The customer has already been acknowledged above, so a broken or
        // unreachable support group can never leave them in silence.
        warn(`forwarding to the support group failed for conversation ${conversation.id}: ${scrub(err && err.message ? err.message : err)}`);
        return { handled: true, action: 'forward-failed' };
      }
    }

    // Capture mode: TELEGRAM_SUPPORT_CHAT_ID is not set yet, so there is nowhere
    // to forward to. The message is stored and the customer has been
    // acknowledged above.
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
          // A human agent typed this in the support group -> 'agent', never 'bot'.
          await sendOutbound(conversation, body, DIRECTION_AGENT);
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
          // Conversation status is deliberately NOT written (live CHECK
          // vocabulary unconfirmed) - see CONFIRMED_CONVERSATION_STATUSES.
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
          // The live table requires support_message_id, so an agent escalation
          // references the customer's newest stored message. With nothing stored
          // there is no valid reference, so it is refused rather than inserted
          // with null.
          const latest = await store.getLatestMessageByConversation({
            conversationId: conversation.id,
            direction: DIRECTION_CUSTOMER
          });
          if (!latest || latest.id === undefined || latest.id === null) {
            await transport.sendMessage(route.chatId, `No stored message for chat ${target}; nothing to escalate.`);
            return { handled: true, action: 'escalate-no-message' };
          }
          markStage('storage:create-escalation');
          await store.createEscalation({ conversationId: conversation.id, supportMessageId: latest.id });
          // Status is not written (live CHECK vocabulary unconfirmed) - the
          // escalation row above is the record.
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
      // A human agent replied to the forwarded message -> 'agent', never 'bot'.
      await sendOutbound(conversation, route.text, DIRECTION_AGENT);
      return { handled: true, action: 'admin-reply' };
    }

    return { handled: false, reason: 'group-no-action' };
  }

  async function handleUpdate(update) {
    stats.updatesReceived += 1;
    stats.lastUpdateAt = new Date().toISOString();
    // Reset per-update so the reported stage always belongs to THIS update.
    stats.lastErrorStage = null;
    markStage('parsed');

    const id = updateId(update);
    stats.lastUpdateId = id;
    if (seenUpdates.has(id)) {
      stats.duplicateUpdates += 1;
      stats.lastAction = 'duplicate';
      markStage('duplicate');
      return { handled: true, action: 'duplicate' };
    }

    const route = routeUpdate(update, routingConfig);
    markStage('routed:' + route.kind);
    if (route.kind === 'ignore') {
      stats.ignored += 1;
      stats.lastAction = 'ignored';
      stats.lastReason = route.reason;
      stats.lastStage = 'ignored:' + route.reason;
      return { handled: false, reason: route.reason };
    }

    try {
      const result = route.kind === 'group'
        ? await handleGroupUpdate(route, update)
        : await handleUserUpdate(route, update);
      stats.processed += 1;
      stats.lastAction = (result && result.action) || (result && result.handled ? 'handled' : 'no-action');
      stats.lastReason = (result && result.reason) || null;
      markStage('done:' + stats.lastAction);
      seenUpdates.remember(id);
      return result;
    } catch (error) {
      // Attribute the failure to the stage that actually threw (storage/sendMessage/
      // forward), falling back to a generic marker.
      stats.lastErrorStage = stats.lastErrorStage || stats.lastStage || 'processing';
      // Count EVERY storage failure exactly once, whether or not an inner catch
      // already reported it. Previously only the two conversation-upsert paths
      // called noteStorageFailure, so a failing insertMessage/escalation/status
      // write produced status=500 with storageFailures=0 - a trace that proved
      // something failed without saying what.
      if (String(stats.lastErrorStage).startsWith('storage')
        || String(stats.lastStage || '').startsWith('storage')) {
        noteStorageFailure(error);
      }
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
    const tables = {};
    let allOk = true;
    const recordFailure = (table, error) => {
      allOk = false;
      const classified = classifyStorageError(error);
      tables[table] = {
        ok: false,
        code: classified.code,
        cause: classified.cause,
        message: scrub(error && error.message ? error.message : error)
      };
    };

    // The conversations probe is the REAL call the write path makes, so on its
    // own it detects a missing table, a missing column, RLS, a bad service key
    // and an outage. It is kept first for exactly that reason.
    try {
      await store.getConversationByChatId(cfg.supportChatId || '0');
      tables.conversations = { ok: true };
    } catch (error) {
      recordFailure('conversations', error);
    }

    // The other two tables get a read-only probe with the exact column list the
    // store writes. This separates "table missing" from "column missing", which
    // a plain existence check cannot.
    //
    // `label` is the short key used in the telemetry output; `table` is the REAL
    // relation that is queried. Keep them separate: passing the short label as
    // the table name asked PostgREST for public.messages / public.escalations
    // and logged a false PGRST205 even when the real tables existed.
    const probes = [
      { label: 'messages', table: 'telegram_support_messages', columns: ['id', 'conversation_id', 'direction', 'body', 'created_at'] },
      { label: 'escalations', table: 'telegram_support_escalations', columns: ['id', 'conversation_id', 'support_message_id', 'created_at'] }
    ];
    for (const probe of probes) {
      if (typeof store.probeColumns !== 'function') {
        tables[probe.label] = { ok: null, reason: 'probe-not-supported' };
        continue;
      }
      try {
        await store.probeColumns(probe.table, probe.columns);
        tables[probe.label] = { ok: true };
      } catch (error) {
        recordFailure(probe.label, error);
      }
    }

    // A read probe cannot see an RLS/INSERT or CHECK-constraint problem - those
    // only surface on a real write, which is why the live error is captured
    // separately by the delivery trace.
    if (allOk) {
      return { ok: true, error: null, tables };
    }

    const firstFailure = Object.values(tables).find((t) => t && t.ok === false) || {};
    stats.lastErrorStage = 'storage-preflight';
    stats.lastError = firstFailure.message || 'storage preflight failed';
    stats.lastErrorCode = firstFailure.code || null;
    stats.storageCause = firstFailure.cause || null;
    return {
      ok: false,
      error: firstFailure.message || 'storage preflight failed',
      code: firstFailure.code || null,
      cause: firstFailure.cause || null,
      tables
    };
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
    const result = await runWebhookRegistration(force);
    // Keep the last registration outcome so the trace can answer "did the
    // webhook we think we registered actually get registered?".
    stats.lastRegistration = {
      at: new Date().toISOString(),
      ok: result.ok,
      reRegistered: Boolean(result.reRegistered),
      reason: result.reason || null,
      error: result.error || null,
      probeError: result.probeError || null
    };
    return result;
  }

  async function runWebhookRegistration(force) {
    const expectedUrl = cfg.baseUrl ? `${cfg.baseUrl}/api/telegram/webhook` : null;
    if (!isTelegramConfigured(cfg) || !expectedUrl) {
      return { ok: false, reason: 'not-configured', reRegistered: false, plan: null, webhook: null };
    }

    // Telegram only accepts a secret_token made of A-Z a-z 0-9 _ - (1-256
    // chars). Calling setWebhook with anything else fails with
    // "Bad Request: secret token contains illegal characters" and leaves the
    // PREVIOUS registration in place - the bot then silently receives nothing
    // while getMe/setWebhook look fine. Refuse early with a precise, secret-free
    // reason instead of letting Telegram answer opaquely.
    if (!isValidTelegramWebhookSecret(cfg.webhookSecret)) {
      return {
        ok: false,
        reason: 'invalid-webhook-secret-format',
        reRegistered: false,
        plan: null,
        webhook: null,
        secret: describeTelegramWebhookSecret(cfg.webhookSecret),
        hint: 'Telegram allows only A-Z a-z 0-9 _ - (1-256 chars). Generate a ' +
          'compliant value with: node scripts/generate-telegram-secret.js'
      };
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

  return {
    handleUpdate,
    setWebhook,
    getWebhookInfo,
    getConfig,
    status,
    ensureWebhookRegistration,
    checkStorage,
    getStats,
    recordRequest,
    recordSecretPassed,
    recordRejectedSecret,
    noteResponse,
    markStage
  };
}

/**
 * Build the Express route handler for POST /api/telegram/webhook.
 *
 * Behaviour (all fail-closed):
 *   - 503 when the bot is not configured (no token or no webhook secret).
 *   - 401 when the X-Telegram-Bot-Api-Secret-Token header is missing/mismatched
 *     (constant-time compare). The header value is never logged.
 *   - 200 when the update was processed.
 *   - 500 when processing failed, so the update stays queued, Telegram retries
 *     it, and `getWebhookInfo.last_error_message` finally shows the failure.
 *
 * The ENTIRE body is inside one try/catch so no exception (config read, header
 * read, logging) can escape without a recorded status and a response.
 *
 * Every response logs one secret-free evidence line carrying the delivery trace:
 * requests received, secret pass/reject counts, last update/action/stage, replies
 * sent, the last sendMessage HTTP status + Telegram description, and what the
 * answer means for Telegram's pending queue.
 */
function createTelegramWebhookHandler({ bot, logger }) {
  if (!bot) throw new Error('createTelegramWebhookHandler requires a bot');
  const log = logger || console;

  return async function telegramWebhookHandler(req, res) {
    const safeCall = (fn) => {
      try { return fn(); } catch (err) { return null; }
    };

    const evidence = (status) => {
      const stats = safeCall(() => (bot.getStats ? bot.getStats() : {})) || {};
      const api = safeCall(() => (bot.status ? bot.status().lastApiCall : null));
      const lastSend = api
        ? `${api.method} http=${api.httpStatus} ok=${api.ok}` +
          (api.errorCode ? ` error_code=${api.errorCode}` : '') +
          (api.description ? ` desc="${api.description}"` : '')
        : 'none';
      return [
        `status=${status}`,
        `requests=${stats.requestsReceived}`,
        `secretPassed=${stats.secretPassed}`,
        `secretRejected=${stats.secretRejected}`,
        `updates=${stats.updatesReceived}`,
        `duplicates=${stats.duplicateUpdates}`,
        `lastUpdateAt=${stats.lastUpdateAt}`,
        `lastUpdateId=${stats.lastUpdateId}`,
        `lastAction=${stats.lastAction}`,
        `lastStage=${stats.lastStage}`,
        `lastErrorStage=${stats.lastErrorStage}`,
        `lastErrorCode=${stats.lastErrorCode}`,
        `storageCause=${stats.storageCause}`,
        `lastError="${String(stats.lastError || '').slice(0, 200)}"`,
        `repliesSent=${stats.repliesSent}`,
        `storageFailures=${stats.storageFailures}`,
        `lastSendMessage=${lastSend}`,
        `pendingResult=${stats.lastPendingResult}`
      ].join(' ');
    };

    // Records the status + trace and sends the response exactly once.
    const respond = (status, payload, level = 'log') => {
      safeCall(() => { if (typeof bot.noteResponse === 'function') bot.noteResponse(status); });
      safeCall(() => {
        if (log && typeof log[level] === 'function') log[level](`[Telegram] ${evidence(status)}`);
      });
      if (res.headersSent) return res;
      return res.status(status).json(payload);
    };

    try {
      safeCall(() => { if (typeof bot.recordRequest === 'function') bot.recordRequest(); });

      const config = bot.getConfig();
      if (!isTelegramConfigured(config)) {
        return respond(503, { ok: false, error: 'Telegram bot not configured' }, 'warn');
      }

      const provided = typeof req.get === 'function'
        ? req.get('x-telegram-bot-api-secret-token')
        : (req.headers ? req.headers['x-telegram-bot-api-secret-token'] : undefined);

      if (!verifyTelegramWebhookSecret(provided, config.webhookSecret)) {
        safeCall(() => { if (typeof bot.recordRejectedSecret === 'function') bot.recordRejectedSecret(); });
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
        return respond(401, { ok: false, error: 'invalid_secret', secretProvided: Boolean(provided) }, 'warn');
      }
      safeCall(() => { if (typeof bot.recordSecretPassed === 'function') bot.recordSecretPassed(); });

      const result = await bot.handleUpdate(req.body);
      const action = result && result.action
        ? result.action
        : (result && result.handled ? 'handled' : 'no-action');
      return respond(200, { ok: true, handled: Boolean(result && result.handled), action });
    } catch (error) {
      // A processing failure is NOT a delivered update. Answering 200 here would
      // make Telegram drop the customer's message forever AND record no error at
      // all (a silently dead bot). 500 keeps the update queued, makes Telegram
      // retry it, and surfaces the failure in getWebhookInfo.last_error_message.
      const stats = safeCall(() => (bot.getStats ? bot.getStats() : {})) || {};
      const stage = stats.lastErrorStage || stats.lastStage || 'processing';
      if (log && typeof log.error === 'function') {
        log.error(`[Telegram] processing failed at ${stage}: ` +
          (error && error.message ? error.message : error) +
          ' (answering 500 so Telegram retries; check storage/webhook config)');
      }
      return respond(500, { ok: false, error: 'processing_failed', stage }, 'error');
    }
  };
}

module.exports = {
  TELEGRAM_API_BASE,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  DIRECTION_CUSTOMER,
  DIRECTION_BOT,
  DIRECTION_AGENT,
  STORAGE_DEGRADED_TEXT,
  STORAGE_ERROR_CAUSES,
  classifyStorageError,
  USER_HELP_TEXT,
  CUSTOMER_GUIDE_TEXT,
  SUPPORT_AI_MAX_QUESTION_CHARS,
  ESCALATION_ACK,
  ADMIN_HELP_TEXT,
  parseAdminIds,
  normalizeTelegramId,
  TELEGRAM_TOKEN_FORMAT,
  TELEGRAM_SECRET_FORMAT,
  TELEGRAM_SECRET_ALPHABET,
  stripSurroundingQuotes,
  normalizeTelegramToken,
  isValidTelegramToken,
  isValidTelegramWebhookSecret,
  generateTelegramWebhookSecret,
  describeTelegramWebhookSecret,
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
