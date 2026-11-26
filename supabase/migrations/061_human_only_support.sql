-- 061_human_only_support.sql
--
-- Human-only customer support: bookkeeping columns the human-only flow needs.
-- ADDITIVE + IDEMPOTENT. It never drops a table/column, never rewrites a body and
-- never deletes a conversation, so existing history is preserved exactly.
--
--  * support_messages.via       - WHO/WHAT produced a message:
--        'customer' | 'admin' (dashboard) | 'telegram' (agent via Telegram) |
--        'system' (static notices). 'ai' is accepted ONLY so historical rows written
--        before the human-only switch stay valid; nothing writes it any more.
--  * support_conversations.acknowledged_at - the once-per-conversation claim that
--        makes the static "we received your message" notice idempotent even when
--        two browsers post the first message at the same moment.
--
-- Rollback (does not touch data):
--   DROP INDEX IF EXISTS public.support_messages_thread_idx;
--   ALTER TABLE public.support_messages DROP CONSTRAINT IF EXISTS support_messages_via_check;
--   ALTER TABLE public.support_messages DROP COLUMN IF EXISTS via;
--   ALTER TABLE public.support_conversations DROP COLUMN IF EXISTS acknowledged_at;

-- ------------------------------------------------------------------ columns
ALTER TABLE public.support_messages
    ADD COLUMN IF NOT EXISTS via TEXT;

ALTER TABLE public.support_conversations
    ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

-- Historical rows: derive the source from the sender the old code wrote.
-- Only rows with a NULL via are touched, so re-running is a no-op.
UPDATE public.support_messages
   SET via = CASE sender_type
                 WHEN 'customer' THEN 'customer'
                 WHEN 'agent'    THEN 'admin'
                 WHEN 'system'   THEN 'system'
                 WHEN 'ai'       THEN 'ai'
                 ELSE NULL
             END
 WHERE via IS NULL;

-- ------------------------------------------------------------------ constraints
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE c.conname = 'support_messages_via_check'
           AND n.nspname = 'public'
           AND t.relname = 'support_messages'
    ) THEN
        ALTER TABLE public.support_messages
            ADD CONSTRAINT support_messages_via_check
            CHECK (via IS NULL OR via IN ('customer', 'admin', 'telegram', 'system', 'ai'));
    END IF;
END $$;

-- ------------------------------------------------------------------ trigger
-- Customer messages are written by the locked RPC support_post_customer_message(),
-- which knows nothing about `via`. Filling the default in the database keeps every
-- insert path correct without touching a money-adjacent RPC, and an explicit value
-- (the Telegram bridge passes 'telegram') always wins.
CREATE OR REPLACE FUNCTION public.support_messages_default_via()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.via IS NULL THEN
        NEW.via := CASE NEW.sender_type
                       WHEN 'customer' THEN 'customer'
                       WHEN 'agent'    THEN 'admin'
                       WHEN 'system'   THEN 'system'
                       ELSE NULL
                   END;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS support_messages_default_via_trg ON public.support_messages;
CREATE TRIGGER support_messages_default_via_trg
    BEFORE INSERT ON public.support_messages
    FOR EACH ROW EXECUTE FUNCTION public.support_messages_default_via();

-- ------------------------------------------------------------------ indexes
-- Thread reads are "WHERE conversation_id = ? ORDER BY id"; this makes the
-- customer widget's polling and the admin thread view index-only.
CREATE INDEX IF NOT EXISTS support_messages_thread_idx
    ON public.support_messages (conversation_id, id);

-- Admin inbox filters by status and by assignee.
CREATE INDEX IF NOT EXISTS support_conversations_status_idx
    ON public.support_conversations (status, last_message_at DESC);

CREATE INDEX IF NOT EXISTS support_conversations_assignee_idx
    ON public.support_conversations (assigned_admin_id, status);

-- ------------------------------------------------------------------ self-check
DO $$
DECLARE
    missing TEXT := '';
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'support_messages' AND column_name = 'via'
    ) THEN missing := missing || ' support_messages.via'; END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'support_conversations' AND column_name = 'acknowledged_at'
    ) THEN missing := missing || ' support_conversations.acknowledged_at'; END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = 'support_messages_thread_idx' AND n.nspname = 'public'
    ) THEN missing := missing || ' support_messages_thread_idx'; END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE t.tgname = 'support_messages_default_via_trg'
           AND c.relname = 'support_messages'
    ) THEN missing := missing || ' support_messages_default_via_trg'; END IF;

    IF missing <> '' THEN
        RAISE EXCEPTION '061_human_only_support incomplete:%', missing;
    END IF;
END $$;
