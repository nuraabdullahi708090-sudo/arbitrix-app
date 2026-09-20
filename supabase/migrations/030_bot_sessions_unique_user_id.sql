-- ============================================
-- MIGRATION: 030 - public.bot_sessions.user_id is UNIQUE
--                  (Additive, idempotent, self-checking)
-- ============================================
-- PURPOSE
--   Record, in the repository, the database invariant that the application and
--   migrations 028/029 already depend on: public.bot_sessions holds AT MOST ONE
--   ROW PER user_id, enforced by the unique index `bot_sessions_user_id_unique`.
--
--   Production already carries this index (verified out of band). No migration in
--   this repository CREATES public.bot_sessions - like 028/029 this file only
--   documents and (re)asserts a requirement over an externally-created table.
--   Migrations 028 and 029 are NOT modified or recreated by this file.
--
-- WHY IT MUST BE UNIQUE (every one of these assumes a single row per user)
--   * server.js /api/bot/start upserts with `{ onConflict: 'user_id' }`.
--     PostgREST compiles that to `ON CONFLICT (user_id) DO UPDATE`, which
--     REQUIRES a unique index/constraint on user_id - without one PostgreSQL
--     raises 42P10 and the upsert fails. (The call site does not inspect the
--     error, so a missing index fails silently: the API answers "started" while
--     writing nothing.)
--   * server.js /api/bot/status and isWorkerOwnedSession() read the session with
--     `.eq('user_id', ...).single()`; more than one row makes `.single()` error.
--   * Migration 029's lease RPCs address the row by user_id
--     (`SELECT ... WHERE user_id = p_user_id FOR UPDATE`,
--     `UPDATE ... WHERE user_id = p_user_id RETURNING generation INTO ...`).
--     With duplicates, SELECT INTO / RETURNING pick an arbitrary row and the
--     UPDATEs hit several, so a stop/renew could fence the wrong session.
--   * The worker treats user_id as the session identity throughout
--     (services/TradingWorker.js claim/renew/stop/heartbeat).
--   The in-repo precedent is the sandbox twin, whose user_id is the PRIMARY KEY
--   (`sandbox_bot_sessions.user_id BIGINT PRIMARY KEY`, migration 013).
--
-- SCOPE / NON-GOALS
--   * Adds NO column, NO table, NO function and NO policy.
--   * Does NOT touch wallets, trades, deposits, withdrawals, transactions,
--     subscriptions, referrals, KYC, auth or any sandbox table.
--   * Does NOT create public.bot_sessions (it must already exist).
--   * Does NOT alter any data: if duplicate user_id rows exist this migration
--     fails loudly and changes nothing (de-duplication is a deliberate operator
--     decision, never a silent migration side effect).
--
-- ROLLBACK
--   DROP INDEX IF EXISTS public.bot_sessions_user_id_unique;
--   (Only safe if the application is not relying on the upsert, i.e. do not.)
--
-- NOT APPLIED by this repository. Apply through the normal migration review path.
-- ============================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS - fail loudly with a precise reason instead of guessing
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_dupes BIGINT;
BEGIN
    IF to_regclass('public.bot_sessions') IS NULL THEN
        RAISE EXCEPTION 'Migration 030 requires public.bot_sessions to exist. No migration in this repository creates it, so confirm the table in this database before applying 030.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'bot_sessions'
           AND column_name = 'user_id'
    ) THEN
        RAISE EXCEPTION 'Migration 030 requires public.bot_sessions.user_id.';
    END IF;

    -- Uniqueness is impossible with duplicate rows, and the RPCs 029 relies on
    -- would misbehave on them. Report the count so an operator can fix the data
    -- deliberately; never delete rows automatically.
    SELECT COUNT(*) INTO v_dupes
      FROM (
          SELECT user_id
            FROM public.bot_sessions
           GROUP BY user_id
          HAVING COUNT(*) > 1
      ) d;

    IF v_dupes > 0 THEN
        RAISE EXCEPTION 'Migration 030 cannot create bot_sessions_user_id_unique: % user_id value(s) in public.bot_sessions have more than one row. De-duplicate them (keeping the running/authoritative row) and re-run; this migration has made no changes.', v_dupes;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. The uniqueness itself (idempotent: a no-op where it already exists)
-- ---------------------------------------------------------------------------
-- A unique INDEX (not a table constraint) because that is what the live database
-- carries; PostgreSQL accepts either for `ON CONFLICT (user_id)` inference.
CREATE UNIQUE INDEX IF NOT EXISTS bot_sessions_user_id_unique
    ON public.bot_sessions (user_id);

COMMENT ON INDEX public.bot_sessions_user_id_unique IS
    'At most ONE bot_sessions row per user. Required by /api/bot/start''s upsert (onConflict: user_id), by the .single() session reads in server.js, and by migration 029''s per-user lease RPCs.';

-- ---------------------------------------------------------------------------
-- 2. Self-check: raise (and roll back) if the index did not land / is not unique
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'bot_sessions'
           AND indexname = 'bot_sessions_user_id_unique'
    ) THEN
        RAISE EXCEPTION 'Migration 030 self-check failed: index public.bot_sessions_user_id_unique does not exist.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'bot_sessions_user_id_unique'
           AND i.indisunique IS TRUE
    ) THEN
        RAISE EXCEPTION 'Migration 030 self-check failed: public.bot_sessions_user_id_unique exists but is NOT unique.';
    END IF;

    RAISE NOTICE 'Migration 030 self-check passed (bot_sessions.user_id uniqueness asserted).';
END $$;

COMMIT;
