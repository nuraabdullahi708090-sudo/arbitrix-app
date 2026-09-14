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

/** Parse the comma-separated TELEGRAM_ADMIN_IDS value into a list of id strings. */
function parseAdminIds(raw) {
  if (raw === null || raw === undefined) return [];
  return String(raw)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Resolve Telegram configuration from an env-shaped object. Never logs values. */
function resolveTelegramConfig(env) {
  const e = env || {};
  const baseUrl = String(e.BASE_URL || '').trim().replace(/\/+$/, '');
  return {
    token: String(e.TELEGRAM_BOT_TOKEN || '').trim(),
    supportChatId: String(e.TELEGRAM_SUPPORT_CHAT_ID || '').trim() || null,
    adminIds: parseAdminIds(e.TELEGRAM_ADMIN_IDS),
    webhookSecret: String(e.TELEGRAM_WEBHOOK_SECRET || '').trim(),
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
      threadedReplies: forwarded.size()
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
    await store.insertMessage({
      conversationId: conversation.id,
      direction: DIRECTION_OUTBOUND,
      body
    });
    return sent;
  }

  async function handleUserUpdate(route, update) {
    const from = route.message.from || {};
    const { conversation, created } = await store.upsertConversation({
      chatId: route.chatId,
      telegramUserId: route.fromId,
      username: from.username || null,
      displayName: telegramDisplayName(from)
    });

    const command = route.command;
    if (command && (command.name === 'start' || command.name === 'help')) {
      await sendOutbound(conversation, USER_HELP_TEXT);
      return { handled: true, action: 'help' };
    }

    if (command && command.name === 'chatid') {
      await sendOutbound(conversation, `Your chat ID is: ${conversation.telegram_chat_id}`);
      return { handled: true, action: 'chatid' };
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
      const sent = await transport.sendMessage(cfg.supportChatId, buildForwardText(conversation, conversation.telegram_chat_id, name, text));
      if (sent && sent.message_id !== undefined && sent.message_id !== null) {
        forwarded.set(sent.message_id, conversation.telegram_chat_id);
      }
      if (created) {
        await sendOutbound(conversation, RECEIPT_TEXT);
      }
      return { handled: true, action: 'forwarded' };
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
    const id = updateId(update);
    if (seenUpdates.has(id)) return { handled: true, action: 'duplicate' };

    const route = routeUpdate(update, routingConfig);
    if (route.kind === 'ignore') return { handled: false, reason: route.reason };

    const result = route.kind === 'group'
      ? await handleGroupUpdate(route, update)
      : await handleUserUpdate(route, update);

    seenUpdates.remember(id);
    return result;
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
      allowed_updates: ['message', 'edited_message']
    });
    return { url, webhookPath: '/api/telegram/webhook' };
  }

  async function getWebhookInfo() {
    return transport.getWebhookInfo();
  }

  return { handleUpdate, setWebhook, getWebhookInfo, getConfig, status };
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
      if (log && typeof log.warn === 'function') {
        log.warn('[Telegram] Webhook rejected: invalid secret token header');
      }
      return res.status(401).json({ ok: false });
    }

    try {
      const result = await bot.handleUpdate(req.body);
      return res.status(200).json({ ok: true, handled: Boolean(result && result.handled) });
    } catch (error) {
      if (log && typeof log.error === 'function') {
        log.error('[Telegram] Webhook processing error: ' + (error && error.message ? error.message : error));
      }
      return res.status(200).json({ ok: true, handled: false });
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
  resolveTelegramConfig,
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
