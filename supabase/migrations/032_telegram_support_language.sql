-- ============================================================================
-- 032_telegram_support_language.sql
-- ============================================================================
-- Multilingual Telegram support: make the EXISTING
-- `telegram_support_conversations.language` column authoritative and
-- constrained to the languages this release supports.
--
-- WHY A MIGRATION AT ALL
--   The column already exists (documented as present in the applied table in
--   migration 027) and the application writes it. This migration therefore only
--   (a) makes sure it really exists, and (b) records the allowed vocabulary as a
--   database BACKSTOP so an unsupported code cannot be stored even by a future
--   caller that forgets to validate.
--
--   It does NOT create a second language column, does NOT touch any other table,
--   and does NOT set or rely on a column DEFAULT: the application resolves a
--   missing/invalid value to 'en' explicitly on read.
--
-- SAFETY
--   - ADDITIVE and IDEMPOTENT: safe to re-run.
--   - The constraint allows NULL (rows written before this release remain valid
--     and are read as English by the application).
--   - A PRE-FLIGHT check refuses to install the constraint if a non-NULL value
--     outside the supported set already exists. It RAISES with the count and
--     changes NOTHING (it never deletes or rewrites a row).
--   - No index is added: conversations are looked up by the existing UNIQUE
--     telegram_chat_id, never by language.
--
-- ADDING A LANGUAGE LATER (es / fr / zh)
--   Update the CHECK below in a NEW migration in the same commit that adds the
--   locale to services/telegram-i18n.js. Nothing else in this file needs to
--   change.
-- ============================================================================

BEGIN;

-- 1. The column must exist (no-op when it already does, as in production).
ALTER TABLE public.telegram_support_conversations
    ADD COLUMN IF NOT EXISTS language TEXT;

-- 2. Pre-flight: fail LOUDLY, and without touching data, if an unsupported value
--    is already stored. Done before the constraint so the migration can never
--    leave a half-applied state with data it refuses to accept.
DO $$
DECLARE
    v_bad_count INTEGER;
    v_sample    TEXT;
BEGIN
    SELECT COUNT(*) INTO v_bad_count
      FROM public.telegram_support_conversations
     WHERE language IS NOT NULL
       AND language NOT IN ('en', 'pt', 'ar');

    IF v_bad_count > 0 THEN
        SELECT language INTO v_sample
          FROM public.telegram_support_conversations
         WHERE language IS NOT NULL
           AND language NOT IN ('en', 'pt', 'ar')
         LIMIT 1;

        RAISE EXCEPTION
            'cannot constrain telegram_support_conversations.language: % row(s) hold an unsupported value (e.g. %). Resolve them first; this migration never rewrites data.',
            v_bad_count, v_sample;
    END IF;
END $$;

-- 3. The vocabulary backstop. NULL stays allowed on purpose: a pre-existing row
--    (or a row created by anything other than the bot) reads as English.
ALTER TABLE public.telegram_support_conversations
    DROP CONSTRAINT IF EXISTS telegram_support_conversations_language_check;

ALTER TABLE public.telegram_support_conversations
    ADD CONSTRAINT telegram_support_conversations_language_check
    CHECK (language IS NULL OR language IN ('en', 'pt', 'ar'));

COMMENT ON COLUMN public.telegram_support_conversations.language IS
    'Customer''s selected support language: en | pt | ar (NULL = English). Written by the Telegram bot on /language; resolved to en in application code, never via a column DEFAULT. Adding a language requires a new migration updating telegram_support_conversations_language_check.';

-- 4. Self-check: raise (and roll back) unless the column and the constraint are
--    both in place with the expected definition.
DO $$
DECLARE
    v_column_exists     BOOLEAN;
    v_constraint_exists BOOLEAN;
    v_definition        TEXT;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'telegram_support_conversations'
           AND column_name = 'language'
    ) INTO v_column_exists;

    IF NOT v_column_exists THEN
        RAISE EXCEPTION '032 self-check failed: telegram_support_conversations.language is missing';
    END IF;

    SELECT pg_get_constraintdef(c.oid) INTO v_definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'telegram_support_conversations'
       AND c.conname = 'telegram_support_conversations_language_check';

    v_constraint_exists := v_definition IS NOT NULL;

    IF NOT v_constraint_exists THEN
        RAISE EXCEPTION '032 self-check failed: telegram_support_conversations_language_check is missing';
    END IF;

    IF v_definition NOT LIKE '%en%' OR v_definition NOT LIKE '%pt%' OR v_definition NOT LIKE '%ar%' THEN
        RAISE EXCEPTION '032 self-check failed: unexpected constraint definition: %', v_definition;
    END IF;

    RAISE NOTICE '032 self-check passed: language column + constraint present';
END $$;

COMMIT;
