-- ============================================================================
-- 060_telegram_support_language_six.sql
-- ============================================================================
-- Widen the Telegram support language vocabulary from three languages to the
-- SIX the platform already offers everywhere else:
--
--   before: CHECK (language IN ('en', 'pt', 'ar'))          - migration 032
--   after:  CHECK (language IN ('en', 'es', 'pt', 'fr', 'ar', 'zh'))
--
-- WHY THIS FILE EXISTS
--   services/telegram-i18n.js now ships es / fr / zh dictionaries and
--   /language offers all six languages, so the customer's choice must be
--   storable. Without this migration the write would fail with 23514 (check
--   violation) and the customer would be told the change was applied while
--   every later reply still used the previous language - exactly the class of
--   bug migration 032 documents.
--
-- WHAT IT DOES *NOT* DO
--   - No INSERT/UPDATE/DELETE: **no customer data is rewritten**. A row is only
--     ever COPIED forward by being valid under the wider constraint.
--   - The column stays TEXT NOT NULL DEFAULT 'en'; the default is re-asserted,
--     never removed or changed.
--   - No money object is touched: this table holds one row per support chat and
--     nothing else in the schema references it.
--
-- SAFETY
--   - ADDITIVE and IDEMPOTENT: dropping then re-creating the same constraint is
--     a no-op once the target state is in place, so re-running changes nothing.
--     The re-create takes a brief ACCESS EXCLUSIVE lock on a table that holds one
--     row per support conversation.
--   - A pre-flight RAISES (changing nothing) if a stored value is not supported,
--     naming the count and one example, so the failure is diagnosable and a human
--     resolves the data. It never guesses.
--   - The self-check runs INSIDE the transaction, so any mismatch rolls the whole
--     migration back.
--
-- ROLLBACK (only valid while no row uses es / fr / zh - check first):
--   ALTER TABLE public.telegram_support_conversations
--     DROP CONSTRAINT IF EXISTS telegram_support_conversations_language_check;
--   ALTER TABLE public.telegram_support_conversations
--     ADD CONSTRAINT telegram_support_conversations_language_check
--     CHECK (language IN ('en', 'pt', 'ar'));
--   Rollback is only safe after re-pointing those rows at a supported language;
--   this migration never does that automatically.
-- ============================================================================

BEGIN;

-- 1. Pre-flight: refuse to continue - changing NOTHING - if the stored data cannot
--    satisfy the (already wider) target vocabulary. Both problems are diagnosed
--    here so the failure names the cause instead of surfacing as an opaque
--    23502/23514 from the statements below.
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
            'cannot widen telegram_support_conversations.language: % row(s) hold NULL. Set them to a supported language (en/es/pt/fr/ar/zh) first; this migration never rewrites data.',
            v_null_count;
    END IF;

    SELECT COUNT(*) INTO v_bad_count
      FROM public.telegram_support_conversations
     WHERE language NOT IN ('en', 'es', 'pt', 'fr', 'ar', 'zh');

    IF v_bad_count > 0 THEN
        SELECT language INTO v_sample
          FROM public.telegram_support_conversations
         WHERE language NOT IN ('en', 'es', 'pt', 'fr', 'ar', 'zh')
         LIMIT 1;

        RAISE EXCEPTION
            'cannot widen telegram_support_conversations.language: % row(s) hold an unsupported value (e.g. %). Resolve them first; this migration never rewrites data.',
            v_bad_count, v_sample;
    END IF;
END $$;

-- 2. Re-assert the column shape (both statements are no-ops in production, where
--    migration 032 already made it TEXT NOT NULL DEFAULT 'en').
ALTER TABLE public.telegram_support_conversations
    ALTER COLUMN language SET DEFAULT 'en';

ALTER TABLE public.telegram_support_conversations
    ALTER COLUMN language SET NOT NULL;

-- 3. The vocabulary backstop. Dropped first so a re-run replaces the constraint
--    instead of failing on a duplicate name. No NULL branch: the column is NOT
--    NULL, so NULL is not a storable state.
ALTER TABLE public.telegram_support_conversations
    DROP CONSTRAINT IF EXISTS telegram_support_conversations_language_check;

ALTER TABLE public.telegram_support_conversations
    ADD CONSTRAINT telegram_support_conversations_language_check
    CHECK (language IN ('en', 'es', 'pt', 'fr', 'ar', 'zh'));

COMMENT ON COLUMN public.telegram_support_conversations.language IS
    'Customer''s selected support language: one of en | es | pt | fr | ar | zh. TEXT NOT NULL DEFAULT ''en'': the default is what an INSERT that omits the column gets (the store relies on it), and the application additionally resolves any unexpected value to en defensively on read. Adding a language requires a new migration updating telegram_support_conversations_language_check.';

-- 4. Self-check: raise - and roll back the whole transaction - unless the target
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
        RAISE EXCEPTION '060 self-check failed: telegram_support_conversations.language is missing';
    END IF;

    IF v_type <> 'text' THEN
        RAISE EXCEPTION '060 self-check failed: language has type % (expected text)', v_type;
    END IF;

    IF v_nullable <> 'NO' THEN
        RAISE EXCEPTION '060 self-check failed: language is still nullable (is_nullable=%)', v_nullable;
    END IF;

    IF v_default IS NULL OR v_default NOT LIKE '%''en''%' THEN
        RAISE EXCEPTION '060 self-check failed: language default is % (expected ''en'')', COALESCE(v_default, '<none>');
    END IF;

    SELECT pg_get_constraintdef(c.oid) INTO v_definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'telegram_support_conversations'
       AND c.conname = 'telegram_support_conversations_language_check';

    IF v_definition IS NULL THEN
        RAISE EXCEPTION '060 self-check failed: telegram_support_conversations_language_check is missing';
    END IF;

    -- Every one of the six languages must be allowed by the constraint.
    IF v_definition NOT LIKE '%en%'
       OR v_definition NOT LIKE '%es%'
       OR v_definition NOT LIKE '%pt%'
       OR v_definition NOT LIKE '%fr%'
       OR v_definition NOT LIKE '%ar%'
       OR v_definition NOT LIKE '%zh%' THEN
        RAISE EXCEPTION '060 self-check failed: unexpected constraint definition: %', v_definition;
    END IF;

    IF v_definition LIKE '%IS NULL%' THEN
        RAISE EXCEPTION '060 self-check failed: the constraint still permits NULL: %', v_definition;
    END IF;

    RAISE NOTICE '060 self-check passed: language is TEXT NOT NULL DEFAULT ''en'' with CHECK (en/es/pt/fr/ar/zh)';
END $$;

COMMIT;
