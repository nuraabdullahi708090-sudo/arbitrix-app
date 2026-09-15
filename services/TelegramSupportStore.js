'use strict';

/**
 * Supabase-backed storage for the Telegram support bot.
 *
 * Uses the APPLIED schema (verified against the live project):
 *
 *   telegram_support_conversations(id, telegram_chat_id, telegram_user_id,
 *     username, display_name, mode, status, language, created_at, updated_at)
 *   telegram_support_messages(id, conversation_id, direction, body, created_at)
 *   telegram_support_escalations(id, conversation_id, created_at)
 *
 * Two consequences shape this store:
 *   - The conversation is keyed by `telegram_chat_id` (the Telegram private
 *     chat id), not a generic `chat_id`.
 *   - `telegram_support_messages` has no message-id or update-id column, so
 *     redelivery idempotency and agent-reply threading live in the service
 *     layer, not here.
 *
 * RLS is enabled on all three tables with service_role-only policies, so this
 * store MUST be built with the service-role client (`supabaseAdmin` in
 * server.js); the anon client is denied.
 *
 * Columns the applied schema provides defaults for (mode, status, language,
 * timestamps) are not written on insert; only `status` is ever set explicitly,
 * and only when it changes.
 */

const CONVERSATIONS = 'telegram_support_conversations';
const MESSAGES = 'telegram_support_messages';
const ESCALATIONS = 'telegram_support_escalations';

/** Postgres bigint columns: send numbers when the value is a safe integer. */
function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  if (/^-?\d+$/.test(s) && Number.isSafeInteger(Number(s))) return Number(s);
  return s;
}

/**
 * Build an Error that PRESERVES PostgREST's structured diagnostics.
 *
 * Supabase/PostgREST return `code`, `details` and `hint` next to `message`, and
 * `code` alone identifies the failure class:
 *   42P01 / PGRST205 - table missing        (migration not applied)
 *   42703 / PGRST204 - column missing       (applied table differs from the migration)
 *   42501            - permission denied    (RLS / not the service-role client)
 *   23514            - CHECK constraint     (a literal does not match the applied schema)
 *   23502            - NOT NULL violation
 *   23503            - foreign key violation
 *   23505            - unique violation
 * Wrapping only `message` (as this store used to) discards exactly the
 * information needed to diagnose a storage outage, so a log line could never
 * say WHICH problem it was. These fields are never secrets.
 */
function storageError(label, error) {
  const code = error && error.code ? String(error.code) : null;
  const message = error && error.message ? String(error.message) : String(error || 'unknown storage error');
  const wrapped = new Error(`telegram ${label} failed${code ? ' [' + code + ']' : ''}: ${message}`);
  wrapped.supabase = {
    code,
    details: error && error.details ? String(error.details) : null,
    hint: error && error.hint ? String(error.hint) : null
  };
  return wrapped;
}

function createTelegramSupportStore(supabaseClient) {
  if (!supabaseClient || typeof supabaseClient.from !== 'function') {
    throw new Error('createTelegramSupportStore requires a Supabase client');
  }

  async function getConversationById(id) {
    const { data, error } = await supabaseClient
      .from(CONVERSATIONS)
      .select('*')
      .eq('id', numeric(id))
      .limit(1);
    if (error) throw storageError('conversation lookup', error);
    const row = Array.isArray(data) ? data[0] : data;
    return row || null;
  }

  /** Look up a conversation by the Telegram private chat id. */
  async function getConversationByChatId(chatId) {
    const { data, error } = await supabaseClient
      .from(CONVERSATIONS)
      .select('*')
      .eq('telegram_chat_id', numeric(chatId))
      .limit(1);
    if (error) throw storageError('conversation lookup', error);
    const row = Array.isArray(data) ? data[0] : data;
    return row || null;
  }

  /**
   * Find-or-create the conversation for a Telegram chat.
   * @returns {Promise<{conversation: object, created: boolean}>}
   */
  async function upsertConversation({ chatId, telegramUserId, username, displayName }) {
    const now = new Date().toISOString();
    const existing = await getConversationByChatId(chatId);

    if (existing) {
      const { data, error } = await supabaseClient
        .from(CONVERSATIONS)
        .update({
          telegram_user_id: numeric(telegramUserId),
          username: username === undefined ? null : username,
          display_name: displayName === undefined ? null : displayName,
          updated_at: now
        })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw storageError('conversation update', error);
      return { conversation: data, created: false };
    }

    const { data, error } = await supabaseClient
      .from(CONVERSATIONS)
      .insert({
        telegram_chat_id: numeric(chatId),
        telegram_user_id: numeric(telegramUserId),
        username: username === undefined ? null : username,
        display_name: displayName === undefined ? null : displayName
      })
      .select()
      .single();
    if (error) throw storageError('conversation insert', error);
    return { conversation: data, created: true };
  }

  /** Persist one message. `direction` is 'inbound' (from the user) or 'outbound'. */
  async function insertMessage({ conversationId, direction, body }) {
    const { data, error } = await supabaseClient
      .from(MESSAGES)
      .insert({
        conversation_id: numeric(conversationId),
        direction,
        body
      })
      .select()
      .single();
    if (error) throw storageError('message insert', error);
    return { message: data };
  }

  async function setConversationStatus({ conversationId, status }) {
    const { error } = await supabaseClient
      .from(CONVERSATIONS)
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', numeric(conversationId));
    if (error) throw storageError('conversation status update', error);
    return true;
  }

  /** Record an escalation. The applied table links a conversation to a timestamp. */
  async function createEscalation({ conversationId }) {
    const { data, error } = await supabaseClient
      .from(ESCALATIONS)
      .insert({ conversation_id: numeric(conversationId) })
      .select()
      .single();
    if (error) throw storageError('escalation insert', error);
    return data;
  }

  /**
   * READ-ONLY schema probe: verifies a table exists and that the exact columns
   * the store writes are present.
   *
   * A `select` with the write column list surfaces the two failures that a
   * plain existence check cannot separate:
   *   - table missing      -> 42P01 / PGRST205 (migration not applied)
   *   - column missing     -> 42703 / PGRST204 (applied table != migration)
   *
   * LIMITATION, by design: an RLS-denied SELECT returns an empty result rather
   * than an error, so this probe cannot confirm INSERT permission or CHECK
   * constraints. Those only surface on a real write, which is why the live
   * error is captured separately in the delivery trace.
   */
  async function probeColumns(table, columns) {
    const { error } = await supabaseClient
      .from(table)
      .select(columns.join(','))
      .limit(1);
    if (error) throw storageError(`schema probe on ${table}`, error);
    return true;
  }

  return {
    getConversationById,
    getConversationByChatId,
    upsertConversation,
    insertMessage,
    setConversationStatus,
    createEscalation,
    probeColumns
  };
}

module.exports = {
  createTelegramSupportStore,
  storageError,
  numeric,
  CONVERSATIONS,
  MESSAGES,
  ESCALATIONS
};
