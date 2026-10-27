'use strict';

/**
 * Telegram <-> Arbitrix account linking (Phase 1).
 *
 * SECURITY MODEL
 *   - A linking token is minted ONLY from an authenticated Arbitrix session and
 *     is bound server-side to that user id. Nothing the client sends can choose
 *     the account.
 *   - The token is 32 cryptographically secure random bytes, base64url encoded,
 *     prefixed `lk_`. Only its SHA-256 hex digest is ever persisted, so a database
 *     dump cannot be replayed into a link.
 *   - Tokens expire after 10 minutes and are single use. Consumption is a single
 *     atomic database function (migration 039) that locks the token row, checks
 *     expiry, and enforces one-to-one ownership in BOTH directions. A conflict is
 *     a refusal, never a silent transfer of ownership.
 *   - The Telegram identity comes from the authenticated update (`chat.id` /
 *     `from.id`), never from a username, display name or anything typed in chat.
 *   - Linking does NOT subscribe the user to marketing messages; that stays the
 *     separate `/subscribe` opt-in (telegram_marketing_subscriptions).
 *   - Raw tokens are never logged and never returned by any endpoint other than
 *     the deep link the requesting user just created.
 *
 * The module takes an injected Supabase client so it can be tested without a
 * database. It stores NO state of its own except the in-process rate limiters.
 */

const crypto = require('crypto');

const TABLE = 'telegram_account_links';
const RPC_CONSUME = 'consume_telegram_link_token';

const TOKEN_PREFIX = 'lk_';
const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 10 * 60 * 1000;
// 32 random bytes -> 43 base64url characters. The bound is wider than the exact
// length so a future encoding change cannot silently reject valid tokens, but it
// still rejects junk before any database work.
const TOKEN_PAYLOAD_RE = /^lk_[A-Za-z0-9_-]{20,128}$/;

const DEFAULT_BOT_USERNAME = 'ArbitrixSupportBot';

// Token minting: 5 links per 10 minutes per account, with a short cooldown so a
// double-click cannot create two live tokens.
const MINT_LIMIT = 5;
const MINT_WINDOW_MS = 10 * 60 * 1000;
const MINT_COOLDOWN_MS = 3000;

// Failed consumption attempts: a chat that keeps presenting bad tokens is
// throttled before it reaches the database again.
const ATTEMPT_LIMIT = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

function generateLinkToken() {
  return TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashLinkToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function isValidLinkPayload(payload) {
  return typeof payload === 'string' && TOKEN_PAYLOAD_RE.test(payload);
}

function buildDeepLink(botUsername, payload) {
  const username = String(botUsername || DEFAULT_BOT_USERNAME).replace(/^@/, '');
  return 'https://t.me/' + username + '?start=' + encodeURIComponent(payload);
}

/** Bounded sliding-window counter, keyed by an opaque id (never a token). */
function createWindowLimiter({ limit, windowMs, cooldownMs = 0 }) {
  const hits = new Map();
  function prune(list, now) {
    while (list.length && now - list[0] > windowMs) list.shift();
  }
  return {
    /** @returns {{allowed:boolean, reason?:string, retryAfterMs?:number}} */
    check(key, nowMs = Date.now()) {
      const k = String(key);
      const list = hits.get(k) || [];
      prune(list, nowMs);
      if (cooldownMs && list.length && nowMs - list[list.length - 1] < cooldownMs) {
        return { allowed: false, reason: 'cooldown', retryAfterMs: cooldownMs - (nowMs - list[list.length - 1]) };
      }
      if (list.length >= limit) {
        return { allowed: false, reason: 'rate_limited', retryAfterMs: windowMs - (nowMs - list[0]) };
      }
      list.push(nowMs);
      hits.set(k, list);
      return { allowed: true };
    },
    reset(key) {
      hits.delete(String(key));
    },
    size() {
      return hits.size;
    }
  };
}

/**
 * @param {object} options
 * @param {object} options.admin  - service-role Supabase client
 * @param {function} [options.clock] - () => epoch ms
 * @param {string} [options.botUsername]
 */
function createTelegramAccountLinks(options) {
  const opts = options || {};
  const admin = opts.admin;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
  const botUsername = opts.botUsername || DEFAULT_BOT_USERNAME;
  if (!admin) throw new Error('createTelegramAccountLinks requires a Supabase client');

  const mintLimiter = createWindowLimiter({
    limit: MINT_LIMIT,
    windowMs: MINT_WINDOW_MS,
    cooldownMs: MINT_COOLDOWN_MS
  });
  const attemptLimiter = createWindowLimiter({ limit: ATTEMPT_LIMIT, windowMs: ATTEMPT_WINDOW_MS });

  /**
   * Mint a single-use linking token for an AUTHENTICATED user.
   * Any earlier pending token for that user is invalidated first, so at most one
   * token is ever live per account.
   *
   * @returns {Promise<{ok:true, url:string, expiresAt:string} | {ok:false, reason:string, retryAfterMs?:number}>}
   */
  async function createToken(userId) {
    if (userId === null || userId === undefined || userId === '') {
      return { ok: false, reason: 'no_user' };
    }
    const gate = mintLimiter.check(userId, clock());
    if (!gate.allowed) {
      return { ok: false, reason: gate.reason, retryAfterMs: gate.retryAfterMs };
    }

    try {
      // Supersede every pending token: one live token per account.
      await admin.from(TABLE).delete().eq('user_id', userId).eq('used', false);
    } catch (error) {
      return { ok: false, reason: 'store_error' };
    }

    const token = generateLinkToken();
    const expiresAt = new Date(clock() + TOKEN_TTL_MS).toISOString();
    let insert;
    try {
      insert = await admin.from(TABLE).insert({
        user_id: userId,
        token_hash: hashLinkToken(token),
        expires_at: expiresAt,
        used: false
      });
    } catch (error) {
      return { ok: false, reason: 'store_error' };
    }
    if (insert && insert.error) return { ok: false, reason: 'store_error' };

    // The raw token leaves the server exactly once, inside the deep link.
    return { ok: true, url: buildDeepLink(botUsername, token), expiresAt };
  }

  /**
   * The authenticated user's connection state. Deliberately minimal: no chat id,
   * no Telegram user id, no account details - just what the dashboard needs.
   */
  async function getStatus(userId) {
    const out = {
      ok: true,
      connected: false,
      linkedAt: null,
      pending: null
    };
    let link;
    try {
      link = await admin
        .from(TABLE)
        .select('user_id, telegram_chat_id, linked_at')
        .eq('user_id', userId)
        .not('telegram_chat_id', 'is', null)
        .maybeSingle();
    } catch (error) {
      return { ok: false, reason: 'store_error' };
    }
    // `.maybeSingle()` resolves with { data: null } when nothing matches; some
    // clients surface PGRST116 instead. Neither is an error here.
    if (link && link.error && link.error.code !== 'PGRST116') return { ok: false, reason: 'store_error' };
    if (link && link.data) {
      out.connected = true;
      out.linkedAt = link.data.linked_at || null;
      return out;
    }

    let pending;
    try {
      pending = await admin
        .from(TABLE)
        .select('expires_at')
        .eq('user_id', userId)
        .eq('used', false)
        .gt('expires_at', new Date(clock()).toISOString())
        .maybeSingle();
    } catch (error) {
      pending = null;
    }
    const pendingMissing = !pending || (pending.error && pending.error.code === 'PGRST116');
    if (!pendingMissing && !pending.error && pending.data) {
      out.pending = { expiresAt: pending.data.expires_at };
    }
    return out;
  }

  /** Revoke the authenticated user's link. Idempotent. */
  async function revoke(userId) {
    let result;
    try {
      result = await admin
        .from(TABLE)
        .delete()
        .eq('user_id', userId)
        .not('telegram_chat_id', 'is', null)
        .select('id');
    } catch (error) {
      return { ok: false, reason: 'store_error' };
    }
    if (result && result.error) return { ok: false, reason: 'store_error' };
    const removed = Array.isArray(result && result.data) ? result.data.length : 0;
    // Any pending token is useless once the user disconnects.
    try {
      await admin.from(TABLE).delete().eq('user_id', userId).eq('used', false);
    } catch (error) { /* best effort */ }
    return { ok: true, disconnected: removed > 0 };
  }

  /** `/unlink` in the bot: revoke by the chat id Telegram authenticated. */
  async function unlinkByChat(chatId) {
    if (!chatId) return { ok: false, reason: 'no_chat' };
    let result;
    try {
      result = await admin
        .from(TABLE)
        .delete()
        .eq('telegram_chat_id', String(chatId))
        .select('id, user_id');
    } catch (error) {
      return { ok: false, reason: 'store_error' };
    }
    if (result && result.error) return { ok: false, reason: 'store_error' };
    const rows = Array.isArray(result && result.data) ? result.data : [];
    return { ok: true, removed: rows.length > 0, userId: rows.length ? rows[0].user_id : null };
  }

  /**
   * Consume a linking token presented by the bot.
   *
   * @param {object} input { payload, chatId, telegramUserId }
   * @returns {Promise<{ok:boolean, reason?:string, already?:boolean, userId?:string}>}
   */
  async function consumeToken(input) {
    const payload = input && input.payload;
    const chatId = input && input.chatId;
    const telegramUserId = input && input.telegramUserId;

    if (!isValidLinkPayload(payload)) return { ok: false, reason: 'invalid' };
    if (!chatId) return { ok: false, reason: 'invalid_chat' };

    // Throttle repeated bad attempts per chat WITHOUT revealing anything.
    const gate = attemptLimiter.check(String(chatId), clock());
    if (!gate.allowed) return { ok: false, reason: 'rate_limited' };

    let response;
    try {
      response = await admin.rpc(RPC_CONSUME, {
        // The stored hash always covers the exact string the user holds (the
        // `lk_` prefix included), so create and consume can never disagree.
        p_token_hash: hashLinkToken(payload),
        p_chat_id: String(chatId),
        p_telegram_user_id: telegramUserId === null || telegramUserId === undefined
          ? null
          : String(telegramUserId)
      });
    } catch (error) {
      return { ok: false, reason: 'unavailable' };
    }
    if (response && response.error) {
      // Missing migration / missing function / database problem: fail closed and
      // never surface the database message to the user.
      return { ok: false, reason: 'unavailable' };
    }
    const data = response && response.data;
    if (!data || typeof data !== 'object') return { ok: false, reason: 'unavailable' };

    if (data.success === true) {
      attemptLimiter.reset(String(chatId));
      return { ok: true, already: data.already === true, userId: data.user_id ? String(data.user_id) : null };
    }
    const reason = typeof data.reason === 'string' ? data.reason : 'invalid';
    // A successful link clears the throttle; a refusal counts as an attempt
    // (already recorded above).
    return { ok: false, reason };
  }

  return {
    createToken,
    getStatus,
    revoke,
    unlinkByChat,
    consumeToken,
    // exposed for tests / operational introspection; contains no secrets
    _limits: { mintLimiter, attemptLimiter }
  };
}

module.exports = {
  TABLE,
  RPC_CONSUME,
  TOKEN_PREFIX,
  TOKEN_BYTES,
  TOKEN_TTL_MS,
  TOKEN_PAYLOAD_RE,
  DEFAULT_BOT_USERNAME,
  MINT_LIMIT,
  MINT_WINDOW_MS,
  MINT_COOLDOWN_MS,
  ATTEMPT_LIMIT,
  ATTEMPT_WINDOW_MS,
  generateLinkToken,
  hashLinkToken,
  isValidLinkPayload,
  buildDeepLink,
  createWindowLimiter,
  createTelegramAccountLinks
};
