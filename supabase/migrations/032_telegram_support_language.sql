-- ============================================================================
-- 032_telegram_support_language.sql
-- ============================================================================
-- Multilingual Telegram support: the `language` column on
-- telegram_support_conversations and its value constraint.
--
-- TARGET SCHEMA - this is what PRODUCTION runs (verified after the change was
-- applied there) and what this migration converges every environment to:
--
--   telegram_support_conversations.language
--     TEXT NOT NULL DEFAULT 'en'
--     CHECK (language IN ('en', 'pt', 'ar'))
--
--   * NOT NULL, and the constraint has NO NULL branch: NULL is not a valid state
--     for this column.
--   * 'en' is a real column DEFAULT. An INSERT that omits the column therefore
--     lands on English without the application sending anything, and the store
--     relies on exactly that (services/TelegramSupportStore.js omits `language`
--     when it creates a conversation row). Nothing here removes or changes it.
--   * The supported vocabulary is exactly 'en', 'pt', 'ar'.
--
-- WHY THIS FILE EXISTS
--   The column already exists in production and the application writes it. This
--   migration records the shape and the vocabulary as a database BACKSTOP so an
--   unsupported code cannot be stored even by a future caller that forgets to
--   validate, and so a fresh environment (staging, a restore) converges on the
--   same schema instead of depending on out-of-band steps.
--
-- SAFETY
--   - ADDITIVE and IDEMPOTENT: every statement is a no-op once the target state
--     is in place, so re-running changes nothing. It does re-create the CHECK
--     constraint, which takes a brief ACCESS EXCLUSIVE lock on a table that holds
--     one row per support conversation.
--   - NEVER REWRITES DATA: there is no INSERT, UPDATE or DELETE anywhere. If the
--     existing rows would block the target schema, the migration RAISES with the
--     count and changes nothing at all (a human resolves the data).
--   - The default is neither removed nor altered: it is (re)asserted as 'en'.
--   - No index is added: conversations are looked up by the existing UNIQUE
--     telegram_chat_id, never by language.
--
-- ADDING A LANGUAGE LATER (es / fr / zh)
--   Update the CHECK below in a NEW migration in the same commit that adds the
--   locale to services/telegram-i18n.js. Nothing else in this file needs to
--   change.
-- ============================================================================

BEGIN;

-- 1. Make sure the column exists in the target shape.
--    No-op in production (the column is already there). On a FRESH database this
--    creates it as TEXT NOT NULL DEFAULT 'en' in one step: Postgres fills any
--    existing rows from the default, so no row is left NULL.
ALTER TABLE public.telegram_support_conversations
    ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';

-- 2. Assert the default. Deliberately separate from (1): `ADD COLUMN IF NOT
--    EXISTS` is a no-op once the column exists, so an environment whose column
--    predates the default would otherwise keep no default. Idempotent, and it
--    writes no row.
ALTER TABLE public.telegram_support_conversations
    ALTER COLUMN language SET DEFAULT 'en';

-- 3. Pre-flight: refuse to continue - changing NOTHING - if the stored data
--    cannot satisfy the target schema. Both problems are diagnosed here so the
--    failure names the cause instead of surfacing as an opaque 23502/23514 from
--    the statements below.
DO $$
DECLARE
    v_null_count INTEGER;
    v_bad_count  INTEGER;
    v_sample     TEXT;
BEGIN
    SELECT COUNT(*) INTO v_null_count
      FROM public.telegram_support_conversations
     WHERE language IS NULL;

    IF v_null_count > 0 THEN
        RAISE EXCEPTION
            'cannot make telegram_support_conversations.language NOT NULL: % row(s) hold NULL. Set them to a supported language (en/pt/ar) first; this migration never rewrites data.',
            v_null_count;
    END IF;

    SELECT COUNT(*) INTO v_bad_count
      FROM public.telegram_support_conversations
     WHERE language NOT IN ('en', 'pt', 'ar');

    IF v_bad_count > 0 THEN
        SELECT language INTO v_sample
          FROM public.telegram_support_conversations
         WHERE language NOT IN ('en', 'pt', 'ar')
         LIMIT 1;

        RAISE EXCEPTION
            'cannot constrain telegram_support_conversations.language: % row(s) hold an unsupported value (e.g. %). Resolve them first; this migration never rewrites data.',
            v_bad_count, v_sample;
    END IF;
END $$;

-- 4. Assert NOT NULL (no-op when it is already set). Safe at this point: step 3
--    proved that no row holds NULL.
ALTER TABLE public.telegram_support_conversations
    ALTER COLUMN language SET NOT NULL;

-- 5. The vocabulary backstop. Dropped first so a re-run replaces the constraint
--    instead of failing on a duplicate name. The definition is exactly the one
--    production carries - there is no NULL branch, because NULL cannot be stored
--    in a NOT NULL column.
ALTER TABLE public.telegram_support_conversations
    DROP CONSTRAINT IF EXISTS telegram_support_conversations_language_check;

ALTER TABLE public.telegram_support_conversations
    ADD CONSTRAINT telegram_support_conversations_language_check
    CHECK (language IN ('en', 'pt', 'ar'));

COMMENT ON COLUMN public.telegram_support_conversations.language IS
    'Customer''s selected support language: one of en | pt | ar. TEXT NOT NULL DEFAULT ''en'': the default is what an INSERT that omits the column gets (the store relies on it), and the application additionally resolves any unexpected value to en defensively on read. Adding a language requires a new migration updating telegram_support_conversations_language_check.';

-- 6. Self-check: raise - and roll back the whole transaction - unless the target
--    schema is exactly in place.
DO $$
DECLARE
    v_type       TEXT;
    v_nullable   TEXT;
    v_default    TEXT;
    v_definition TEXT;
BEGIN
    SELECT c.data_type, c.is_nullable, c.column_default
      INTO v_type, v_nullable, v_default
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'telegram_support_conversations'
       AND c.column_name = 'language';

    IF v_type IS NULL THEN
        RAISE EXCEPTION '032 self-check failed: telegram_support_conversations.language is missing';
    END IF;

    IF v_type <> 'text' THEN
        RAISE EXCEPTION '032 self-check failed: language has type % (expected text)', v_type;
    END IF;

    IF v_nullable <> 'NO' THEN
        RAISE EXCEPTION '032 self-check failed: language is still nullable (is_nullable=%)', v_nullable;
    END IF;

    IF v_default IS NULL OR v_default NOT LIKE '%''en''%' THEN
        RAISE EXCEPTION '032 self-check failed: language default is % (expected ''en'')', COALESCE(v_default, '<none>');
    END IF;

    SELECT pg_get_constraintdef(c.oid) INTO v_definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'telegram_support_conversations'
       AND c.conname = 'telegram_support_conversations_language_check';

    IF v_definition IS NULL THEN
        RAISE EXCEPTION '032 self-check failed: telegram_support_conversations_language_check is missing';
    END IF;

    IF v_definition NOT LIKE '%en%' OR v_definition NOT LIKE '%pt%' OR v_definition NOT LIKE '%ar%' THEN
        RAISE EXCEPTION '032 self-check failed: unexpected constraint definition: %', v_definition;
    END IF;

    IF v_definition LIKE '%IS NULL%' THEN
        RAISE EXCEPTION '032 self-check failed: the constraint still permits NULL: %', v_definition;
    END IF;

    RAISE NOTICE '032 self-check passed: language is TEXT NOT NULL DEFAULT ''en'' with CHECK (en/pt/ar)';
END $$;

COMMIT;
