'use strict';

/**
 * Supabase-backed storage for the Telegram support bot.
 *
 * Uses the APPLIED schema (verified against the live project):
 *
 *   telegram_support_conversations(id, telegram_chat_id, telegram_user_id,
 *     username, display_name, mode, status, language, created_at, updated_at)
 *   telegram_support_messages(id, conversation_id, direction, body, created_at)
 *   telegram_support_escalations(id, conversation_id, support_message_id,
 *                               created_at)
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

/**
 * The ONLY values the LIVE `telegram_support_messages.direction` CHECK allows:
 * `CHECK (direction = ANY (ARRAY['customer'::text, 'bot'::text, 'agent'::text]))`.
 *
 *   - 'customer' = an incoming customer message
 *   - 'bot'      = an automated bot/AI reply
 *   - 'agent'    = a human support-agent reply
 *
 * The pre-existing production table is authoritative. Migration 027's own DDL
 * still carries a legacy ('inbound','outbound') CHECK (documented there).
 * Kept here as the single source of truth and enforced before an insert, so a
 * value the live CHECK does not allow can never reach Postgres (the production
 * failure was a 23514 check-constraint violation on this column).
 */
const ALLOWED_DIRECTIONS = Object.freeze(['customer', 'bot', 'agent']);

/**
 * CONFIRMED live values for `telegram_support_conversations.status`.
 *
 * The pre-existing production table was created OUTSIDE migration 027 and its
 * CHECK (`telegram_support_conversations_status_check`) does NOT accept the
 * app's legacy vocabulary: production rejected 'escalated' with 23514. A CHECK
 * definition cannot be read through PostgREST, so the allowed literals are
 * UNKNOWN - and we do not guess. This list is intentionally EMPTY, which makes
 * setConversationStatus refuse every write, so an unsupported status can never
 * reach Postgres again. The escalation is recorded in
 * telegram_support_escalations instead.
 *
 * To re-enable status writes: run
 *   SELECT pg_get_constraintdef(oid) FROM pg_constraint
 *    WHERE conname = 'telegram_support_conversations_status_check';
 * add the confirmed literal(s) here and start calling setConversationStatus
 * again from the service.
 */
const CONFIRMED_CONVERSATION_STATUSES = Object.freeze([]);

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
   * Persist the conversation's language (en / pt / ar).
   *
   * Uses the EXISTING `telegram_support_conversations.language` column - no
   * second column is introduced. The caller always passes an explicitly
   * validated code (en / pt / ar), which is what the column's CHECK constraint
   * requires. Creating a conversation omits this column on purpose, so a new row
   * takes the column DEFAULT 'en' (see upsertConversation).
   *
   * A 0-row UPDATE is raised as a STORAGE FAILURE, never returned as "nothing".
   * PostgREST answers 200 with an empty body when the update matches no row, so a
   * bare `return row || null` let a dropped language change look like a success:
   * the caller marked it applied, the customer was told their language had been
   * set, and every later message (and the operator notice) still read the old
   * language. The written row is therefore verified before returning.
   *
   * `updated_at` is refreshed like every other write in this store.
   * @returns {Promise<{id: number|string, language: string}>} the updated row.
   * @throws {Error} when the write errors OR matches no conversation row.
   */
  async function setConversationLanguage({ conversationId, language }) {
    if (conversationId === undefined || conversationId === null) {
      throw new Error('setConversationLanguage requires a conversationId');
    }
    const { data, error } = await supabaseClient
      .from(CONVERSATIONS)
      .update({ language, updated_at: new Date().toISOString() })
      .eq('id', numeric(conversationId))
      .select('id, language')
      .limit(1);
    if (error) throw storageError('conversation language update', error);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw storageError('conversation language update', {
        code: 'no-row-returned',
        message: `the update matched no conversation row for id ${conversationId}`,
        details: 'PostgREST answers 200 with an empty body for an UPDATE that matches no row',
        hint: 'verify the conversation still exists and that the client may update it (RLS / service key / id)'
      });
    }
    return row;
  }

  /**
   * Find-or-create the conversation for a Telegram chat.
   *
   * NOTE: the update branch deliberately does NOT write `language`, so a routine
   * message upsert can never reset a customer's language choice.
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

  /**
   * Persist one message. `direction` must be one of ALLOWED_DIRECTIONS - the
   * exact literals the LIVE constraint accepts ('customer' from the customer,
   * 'bot' for an automated reply, 'agent' for a human reply). Validating here
   * means an unsupported value fails locally with a clear message instead of
   * surfacing as an opaque Postgres 23514 check-constraint violation.
   */
  async function insertMessage({ conversationId, direction, body }) {
    if (!ALLOWED_DIRECTIONS.includes(direction)) {
      throw new Error(
        'invalid message direction ' + JSON.stringify(direction) +
        '; allowed directions: ' + ALLOWED_DIRECTIONS.join(', ')
      );
    }
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

  /**
   * Newest stored message for a conversation (read-only), used when an agent
   * escalates from the support group without supplying a message id. An optional
   * `direction` narrows it to the customer's own message. Returns null when the
   * conversation has no matching stored message.
   */
  async function getLatestMessageByConversation({ conversationId, direction = null }) {
    let query = supabaseClient
      .from(MESSAGES)
      .select('id, conversation_id, direction, body, created_at')
      .eq('conversation_id', numeric(conversationId));
    if (direction) query = query.eq('direction', direction);
    const { data, error } = await query.order('id', { ascending: false }).limit(1);
    if (error) throw storageError('message lookup', error);
    return (data && data[0]) || null;
  }

  /**
   * Update a conversation's status.
   *
   * Refuses every value that is not in CONFIRMED_CONVERSATION_STATUSES (which is
   * currently EMPTY because the live CHECK's allowed literals are unknown - see
   * that constant). The live constraint rejected the legacy 'escalated' literal
   * with 23514, so this guard stops any unverified status reaching Postgres.
   */
  async function setConversationStatus({ conversationId, status }) {
    if (!CONFIRMED_CONVERSATION_STATUSES.includes(status)) {
      throw new Error(
        'refusing to write conversation status ' + JSON.stringify(status) +
        ': not a confirmed value of telegram_support_conversations.status ' +
        '(the live CHECK rejected the legacy literals with 23514 and its ' +
        'definition cannot be read through PostgREST)'
      );
    }
    const { error } = await supabaseClient
      .from(CONVERSATIONS)
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', numeric(conversationId));
    if (error) throw storageError('conversation status update', error);
    return true;
  }

  /**
   * Record an escalation.
   *
   * The LIVE table requires `support_message_id` NOT NULL (the
   * telegram_support_messages.id of the message being escalated), so it is
   * mandatory here and validated BEFORE the insert: an escalation can never be
   * written with a null/undefined/missing reference (that was the production
   * 23502). Returns the inserted row.
   */
  async function createEscalation({ conversationId, supportMessageId }) {
    const messageId = numeric(supportMessageId);
    if (messageId === null || typeof messageId !== 'number' ||
        !Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error(
        'createEscalation requires a valid supportMessageId ' +
        '(the telegram_support_messages.id); got ' + JSON.stringify(supportMessageId)
      );
    }
    const { data, error } = await supabaseClient
      .from(ESCALATIONS)
      .insert({
        conversation_id: numeric(conversationId),
        support_message_id: messageId
      })
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
    setConversationLanguage,
    insertMessage,
    getLatestMessageByConversation,
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
  ESCALATIONS,
  ALLOWED_DIRECTIONS,
  CONFIRMED_CONVERSATION_STATUSES
};
