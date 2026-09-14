-- ============================================
-- MIGRATION: 027 - Telegram Support Bot
-- ============================================
-- Persistence for @ArbitrixSupportBot:
--   telegram_support_conversations - one row per Telegram private chat
--   telegram_support_messages      - inbound (user) and outbound messages
--   telegram_support_escalations   - a conversation flagged for human follow-up
--
-- This migration mirrors the schema that was ALREADY APPLIED and verified in
-- the Supabase project (column names confirmed against the live tables). It is
-- written idempotently so re-running it is a no-op and so a fresh environment
-- reproduces the deployed shape.
--
-- SECURITY NOTES:
-- - RLS is ENABLED on all three tables.
-- - The ONLY policy is FOR ALL TO service_role, so only the server-side
--   service-role client (supabaseAdmin in server.js) can read/write. The anon
--   and authenticated roles get no policy and therefore no access.
-- - Privileges are revoked from anon/authenticated for defence in depth.
-- - Authorization for humans (who may talk to whom) is enforced in the bot
--   layer via TELEGRAM_ADMIN_IDS, not by these tables.
-- - The bot token and the webhook secret are NEVER stored here.
--
-- Idempotent: safe to re-run (CREATE ... IF NOT EXISTS / DROP POLICY IF EXISTS).
-- ============================================

-- ============================================
-- 1. CONVERSATIONS (one per Telegram private chat)
-- ============================================
-- NOTE: `display_name` and `language` below are confirmed present in the applied
-- table. The applied table may also carry a `mode` column; it cannot be
-- introspected through PostgREST (that identifier resolves to the reserved
-- `mode()` aggregate) and the bot never reads or writes it, so it is not
-- asserted here. Column names are otherwise confirmed against the live tables.
CREATE TABLE IF NOT EXISTS public.telegram_support_conversations (
    id BIGSERIAL PRIMARY KEY,
    telegram_chat_id BIGINT NOT NULL UNIQUE,
    telegram_user_id BIGINT,
    username TEXT,
    display_name TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'escalated', 'closed')),
    language TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- 2. MESSAGES (inbound from the user / outbound from bot or agent)
-- ============================================
CREATE TABLE IF NOT EXISTS public.telegram_support_messages (
    id BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES public.telegram_support_conversations(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- 3. ESCALATIONS
-- ============================================
CREATE TABLE IF NOT EXISTS public.telegram_support_escalations (
    id BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES public.telegram_support_conversations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- 4. INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_telegram_support_messages_conversation
    ON public.telegram_support_messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telegram_support_escalations_conversation
    ON public.telegram_support_escalations (conversation_id, created_at DESC);

-- ============================================
-- 5. ROW LEVEL SECURITY (service_role only)
-- ============================================
ALTER TABLE public.telegram_support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_support_escalations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS telegram_support_conversations_service_role ON public.telegram_support_conversations;
CREATE POLICY telegram_support_conversations_service_role
    ON public.telegram_support_conversations
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS telegram_support_messages_service_role ON public.telegram_support_messages;
CREATE POLICY telegram_support_messages_service_role
    ON public.telegram_support_messages
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS telegram_support_escalations_service_role ON public.telegram_support_escalations;
CREATE POLICY telegram_support_escalations_service_role
    ON public.telegram_support_escalations
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);

REVOKE ALL ON public.telegram_support_conversations FROM anon, authenticated;
REVOKE ALL ON public.telegram_support_messages FROM anon, authenticated;
REVOKE ALL ON public.telegram_support_escalations FROM anon, authenticated;
