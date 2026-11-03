-- ============================================================================
-- 047_telegram_conversation_state.sql
-- ============================================================================
-- Durable conversational state for the Telegram support bot.
--
-- WHY A NEW COLUMN IS GENUINELY REQUIRED
--   The bot now understands short replies ("yes", "no", "okay", "thanks") by
--   looking at the question it asked immediately before. That question, its
--   expected answer type, the active topic and the facts the customer already
--   gave (registered / deposited / has crypto / chosen deposit method) must
--   survive:
--     - consecutive webhook invocations (each update is a separate request),
--     - a process restart or deploy,
--     - a redelivered or out-of-order update.
--   An in-process map cannot provide any of those, and the existing
--   `telegram_support_conversations` row is the natural per-chat home for it.
--   No other table, no new row type and no rewrite of conversation history is
--   involved.
--
-- SHAPE
--   telegram_support_conversations.context
--     JSONB NOT NULL DEFAULT '{}'::jsonb
--     CHECK (jsonb_typeof(context) = 'object')
--
--   The application validates every field again on read
--   (services/support/ConversationEngine.js normalizeState), so a malformed or
--   older payload can never break a reply.
--
-- SAFETY
--   - ADDITIVE and IDEMPOTENT: ADD COLUMN IF NOT EXISTS plus a guarded CHECK.
--     Re-running changes nothing.
--   - NEVER REWRITES EXISTING DATA: the DEFAULT '{}' fills existing rows once,
--     and no history, message, language or status is read or changed.
--   - BACKWARDS COMPATIBLE IN BOTH DIRECTIONS: the deployed application keeps
--     working before this migration is applied (the store degrades to
--     in-process state and logs once), and this migration is safe to apply
--     before the new application code is deployed.
--   - RLS is unchanged: the table already has RLS enabled with a
--     service_role-only policy, and this adds no policy.
--   - Bounded by design: the application clamps every stored field, so the
--     column cannot grow without limit from customer input.
--
-- ROLLBACK
--   ALTER TABLE public.telegram_support_conversations DROP COLUMN context;
--   (the application falls back to in-process state automatically)
-- ============================================================================

BEGIN;

ALTER TABLE public.telegram_support_conversations
    ADD COLUMN IF NOT EXISTS context JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Reassert the default and the object type. ADD COLUMN IF NOT EXISTS is a no-op
-- once the column exists, so an environment whose column predates this file
-- would otherwise keep a different default.
ALTER TABLE public.telegram_support_conversations
    ALTER COLUMN context SET DEFAULT '{}'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND t.relname = 'telegram_support_conversations'
           AND c.conname = 'telegram_support_conversations_context_object'
           AND c.contype = 'c'
    ) THEN
        ALTER TABLE public.telegram_support_conversations
            ADD CONSTRAINT telegram_support_conversations_context_object
            CHECK (jsonb_typeof(context) = 'object');
    END IF;
END
$$;

COMMENT ON COLUMN public.telegram_support_conversations.context IS
    'Durable conversational state for the support bot (topic, pending question, '
    'collected answers). Written only by the service-role application.';

-- Self-check: assert the exact target shape, then roll back otherwise.
DO $$
DECLARE
    v_type TEXT;
    v_nullable TEXT;
    v_default TEXT;
    v_check INTEGER;
BEGIN
    SELECT data_type, is_nullable, column_default
      INTO v_type, v_nullable, v_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'telegram_support_conversations'
       AND column_name = 'context';

    IF v_type IS NULL THEN
        RAISE EXCEPTION 'telegram_support_conversations.context was not created';
    END IF;
    IF v_type <> 'jsonb' THEN
        RAISE EXCEPTION 'telegram_support_conversations.context must be jsonb, found %', v_type;
    END IF;
    IF v_nullable <> 'NO' THEN
        RAISE EXCEPTION 'telegram_support_conversations.context must be NOT NULL';
    END IF;
    IF v_default IS NULL OR v_default NOT LIKE '%{}%' THEN
        RAISE EXCEPTION 'telegram_support_conversations.context default must be an empty object';
    END IF;

    SELECT count(*) INTO v_check
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'telegram_support_conversations'
       AND c.conname = 'telegram_support_conversations_context_object'
       AND c.contype = 'c';
    IF v_check <> 1 THEN
        RAISE EXCEPTION 'telegram_support_conversations_context_object constraint is missing';
    END IF;
END
$$;

COMMIT;
