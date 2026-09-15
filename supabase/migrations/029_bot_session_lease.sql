-- ============================================
-- MIGRATION: 029 - Bot session executor lease + generation fencing
--                  (Additive, precondition-guarded, idempotent where practical)
-- ============================================
-- PURPOSE
--   Today the trading loop runs in the browser, so `bot_sessions.is_running`
--   can be 1 with no executor behind it, and nothing server-side can say WHO is
--   executing a given session. Before a server-side worker can own execution,
--   two things are required:
--
--     1. EXECUTOR LEASE - at most ONE worker instance may execute a session at a
--        time. The lease is written with the DATABASE clock, expires on its own,
--        and is released on shutdown, so a crashed worker cannot hold a session
--        forever and a second instance cannot legally claim the same session.
--
--     2. GENERATION FENCING - a monotonically increasing per-session counter. A
--        stop (or a reassignment) bumps the generation, so an in-flight tick
--        from a previous executor is rejected BEFORE it can write a trade. The
--        worker also includes the generation in its idempotency key, so a new
--        executor is never deduped against a previous executor's tick.
--
--   THIS MIGRATION DOES NOT ENABLE TRADING. It only adds columns and RPCs. No
--   application code calls these RPCs in the stage that introduces this file.
--
-- PREREQUISITES (all verified by the precondition block below, which raises)
--   1. `public.bot_sessions` MUST exist. NO migration in this repository
--      creates it (verified: only `sandbox_bot_sessions` is created, by 013).
--      If the table is missing this migration refuses to run instead of
--      creating an approximation of it.
--   2. Migration 028 MUST be applied first (`bot_worker_control`, plus
--      heartbeat_at / tick_count / consecutive_failures / stopped_reason /
--      updated_at on bot_sessions, all of which these RPCs write or return).
--   3. `bot_sessions.is_running` MUST be numeric (smallint/integer/bigint) with
--      the 0/1 convention the application already uses (`.eq('is_running', 1)`,
--      `.update({ is_running: 0 })`). If it is boolean, this migration raises
--      rather than guessing - adapt the predicates first.
--   4. `bot_sessions.user_id` MUST exist and be the per-user identity used by
--      the application (`onConflict: 'user_id'` is used by /api/bot/start, i.e.
--      it is expected to be UNIQUE, but that is NOT assumed here: the RPCs take
--      the DB's own row lock and would misbehave on duplicate rows, so verify it
--      before applying - see the verification queries in the header comment of
--      the accompanying report / commit message).
--
-- ASSUMPTIONS ABOUT THE EXISTING bot_sessions SCHEMA (NOT verified from code)
--   * is_running   : numeric 0/1 (checked by the precondition block)
--   * user_id      : BIGINT-compatible, one row per user (NOT checked)
--   * generation   : may already exist - the column is added with
--                    IF NOT EXISTS and defaults to 0, so a pre-existing column
--                    with a different type must be reconciled manually.
--   * mode         : NOT read or written here (the worker is live-only), so its
--                    type/existence cannot break this migration.
--
-- NON-GOALS (deliberately untouched)
--   * record_trade_safe / wallets / trades / transactions are NOT modified.
--   * No trading is scheduled, started or enabled by this migration.
--   * MARKETING_SANDBOX (`sandbox_bot_sessions`) is never read or written.
--   * Deposits, withdrawals, subscriptions, referrals, KYC, auth and payment
--     tables are not referenced.
--
-- ROLLBACK
--   Everything here is additive. To revert:
--     DROP FUNCTION IF EXISTS public.claim_bot_sessions(TEXT, INTEGER, INTEGER);
--     DROP FUNCTION IF EXISTS public.renew_bot_session_lease(BIGINT, TEXT, BIGINT, INTEGER);
--     DROP FUNCTION IF EXISTS public.release_bot_session_lease(BIGINT, TEXT, BIGINT);
--     DROP FUNCTION IF EXISTS public.stop_bot_session_fenced(BIGINT, TEXT, TEXT);
--     DROP INDEX IF EXISTS public.idx_bot_sessions_claimable;
--     ALTER TABLE public.bot_sessions
--       DROP COLUMN IF EXISTS claimed_by,
--       DROP COLUMN IF EXISTS lease_acquired_at,
--       DROP COLUMN IF EXISTS lease_expires_at,
--       DROP COLUMN IF EXISTS generation;
--   Dropping the columns is safe only while NO worker is running: a live worker
--   would keep claiming/expiring leases. Stop the worker FIRST.
-- ============================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS - fail loudly with a precise reason instead of guessing
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_type TEXT;
BEGIN
    IF to_regclass('public.bot_sessions') IS NULL THEN
        RAISE EXCEPTION 'Migration 029 requires public.bot_sessions to exist. No migration in this repository creates it, so confirm the table (and its shape) in this database before applying 029.';
    END IF;

    IF to_regclass('public.bot_worker_control') IS NULL THEN
        RAISE EXCEPTION 'Migration 029 requires migration 028 (public.bot_worker_control) to be applied first.';
    END IF;

    SELECT data_type INTO v_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'bot_sessions'
       AND column_name = 'is_running';

    IF v_type IS NULL THEN
        RAISE EXCEPTION 'Migration 029 requires public.bot_sessions.is_running (expected numeric 0/1).';
    END IF;

    IF v_type NOT IN ('smallint', 'integer', 'bigint') THEN
        RAISE EXCEPTION 'Migration 029 expects bot_sessions.is_running to be numeric 0/1, but found type %. Adapt the predicates in this migration before applying it.', v_type;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'bot_sessions' AND column_name = 'user_id'
    ) THEN
        RAISE EXCEPTION 'Migration 029 requires public.bot_sessions.user_id.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'bot_sessions' AND column_name = 'updated_at'
    ) THEN
        RAISE EXCEPTION 'Migration 029 requires migration 028 (bot_sessions.updated_at) to be applied first.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'bot_sessions' AND column_name = 'heartbeat_at'
    ) THEN
        RAISE EXCEPTION 'Migration 029 requires migration 028 (bot_sessions.heartbeat_at) to be applied first: the claim RPC writes it to announce liveness so the tab-bound engine yields immediately.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Lease + generation columns (additive; defaults keep existing rows valid)
-- ---------------------------------------------------------------------------
ALTER TABLE public.bot_sessions
    -- Executor identity that currently owns the session (worker instance id).
    ADD COLUMN IF NOT EXISTS claimed_by TEXT,
    -- When the current lease was first handed out (DB clock).
    ADD COLUMN IF NOT EXISTS lease_acquired_at TIMESTAMPTZ,
    -- When the current lease lapses and another instance may claim it (DB clock).
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    -- Fencing token: bumped on stop/reassignment. A tick carrying an older
    -- generation is rejected before it can write a trade.
    ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.bot_sessions.claimed_by IS
    'Executor instance id currently holding the lease. NULL = unclaimed. Written only by the lease RPCs (service_role).';
COMMENT ON COLUMN public.bot_sessions.lease_expires_at IS
    'Database-clock deadline of the executor lease. A NULL or past value means the session may be claimed by another instance.';
COMMENT ON COLUMN public.bot_sessions.generation IS
    'Fencing token, incremented on stop/reassignment. Trades carrying an older generation are rejected before any write.';

-- ---------------------------------------------------------------------------
-- 2. Claim scan index (partial: only running sessions are ever claimable)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_bot_sessions_claimable
    ON public.bot_sessions (lease_expires_at)
    WHERE is_running = 1;

-- ---------------------------------------------------------------------------
-- 3. RPCs - all SECURITY DEFINER, all timestamped by the DATABASE clock
-- ---------------------------------------------------------------------------
-- 3a. Claim up to p_limit claimable sessions for p_worker_id.
--     FOR UPDATE SKIP LOCKED is what makes concurrent claims safe: a row being
--     claimed by another instance is skipped rather than blocked or duplicated.
CREATE OR REPLACE FUNCTION public.claim_bot_sessions(
    p_worker_id TEXT,
    p_lease_ms INTEGER DEFAULT 30000,
    p_limit INTEGER DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_now  TIMESTAMPTZ := now();
    v_rows JSONB;
BEGIN
    IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'worker_id is required', 'server_now', v_now);
    END IF;

    IF p_lease_ms IS NULL OR p_lease_ms < 1000 OR p_lease_ms > 600000 THEN
        RETURN jsonb_build_object('success', false, 'error', 'lease_ms must be between 1000 and 600000', 'server_now', v_now);
    END IF;

    WITH claimable AS (
        SELECT ctid
          FROM public.bot_sessions
         WHERE is_running = 1
           AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= v_now)
         ORDER BY user_id
         LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 10), 100))
         FOR UPDATE SKIP LOCKED
    ), claimed AS (
        -- Claiming also announces LIVENESS (heartbeat_at). The server's
        -- single-engine guard (/api/trade) refuses a browser-originated trade
        -- whenever the session has a FRESH heartbeat, so writing it at claim time
        -- closes the window between "a worker owns this session" and "the worker
        -- has completed its first tick", during which the tab could otherwise
        -- still write a second, differently-keyed trade.
        UPDATE public.bot_sessions s
           SET claimed_by        = p_worker_id,
               heartbeat_at      = v_now,
               lease_acquired_at = v_now,
               lease_expires_at  = v_now + make_interval(secs => p_lease_ms::double precision / 1000.0),
               updated_at        = v_now
         WHERE s.ctid IN (SELECT ctid FROM claimable)
        RETURNING s.user_id, s.is_running, s.generation, s.claimed_by,
                  s.lease_expires_at, s.consecutive_failures, s.tick_count
    )
    SELECT COALESCE(
               jsonb_agg(jsonb_build_object(
                   'user_id',              user_id,
                   'is_running',           is_running,
                   'generation',           generation,
                   'claimed_by',           claimed_by,
                   'lease_expires_at',     lease_expires_at,
                   'consecutive_failures', consecutive_failures,
                   'tick_count',           tick_count
               )),
               '[]'::jsonb)
      INTO v_rows
      FROM claimed;

    RETURN jsonb_build_object('success', true, 'server_now', v_now, 'claimed', v_rows);
END $$;

-- 3b. Renew + verify the lease. THIS IS THE FENCE: it is called immediately
--     before any money-moving write and returns renewed=false with a stable
--     `code` when the caller may no longer execute this session. The code order
--     matches the worker's pure evaluateFence() so logs are deterministic:
--       SESSION_NOT_RUNNING -> GENERATION_MISMATCH -> LEASE_UNCLAIMED
--       -> LEASE_NOT_OWNED -> LEASE_EXPIRED -> renewed
CREATE OR REPLACE FUNCTION public.renew_bot_session_lease(
    p_user_id BIGINT,
    p_worker_id TEXT,
    p_generation BIGINT,
    p_lease_ms INTEGER DEFAULT 30000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_now TIMESTAMPTZ := now();
    v_row public.bot_sessions%ROWTYPE;
BEGIN
    IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'worker_id is required', 'server_now', v_now);
    END IF;
    IF p_lease_ms IS NULL OR p_lease_ms < 1000 OR p_lease_ms > 600000 THEN
        RETURN jsonb_build_object('success', false, 'error', 'lease_ms must be between 1000 and 600000', 'server_now', v_now);
    END IF;

    SELECT * INTO v_row
      FROM public.bot_sessions
     WHERE user_id = p_user_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', true, 'renewed', false, 'code', 'SESSION_NOT_FOUND', 'server_now', v_now);
    END IF;

    IF COALESCE(v_row.is_running, 0) <> 1 THEN
        -- Our claim, if any, is meaningless on a stopped session: clear it.
        UPDATE public.bot_sessions
           SET claimed_by = NULL, lease_acquired_at = NULL, lease_expires_at = NULL, updated_at = v_now
         WHERE user_id = p_user_id AND claimed_by = p_worker_id;
        RETURN jsonb_build_object(
            'success', true, 'renewed', false, 'code', 'SESSION_NOT_RUNNING', 'server_now', v_now,
            'is_running', v_row.is_running, 'generation', v_row.generation, 'claimed_by', v_row.claimed_by
        );
    END IF;

    IF COALESCE(v_row.generation, 0) <> COALESCE(p_generation, 0) THEN
        RETURN jsonb_build_object(
            'success', true, 'renewed', false, 'code', 'GENERATION_MISMATCH', 'server_now', v_now,
            'is_running', v_row.is_running, 'generation', v_row.generation, 'claimed_by', v_row.claimed_by
        );
    END IF;

    IF v_row.claimed_by IS NULL THEN
        RETURN jsonb_build_object(
            'success', true, 'renewed', false, 'code', 'LEASE_UNCLAIMED', 'server_now', v_now,
            'is_running', v_row.is_running, 'generation', v_row.generation, 'claimed_by', v_row.claimed_by
        );
    END IF;

    IF v_row.claimed_by IS DISTINCT FROM p_worker_id THEN
        RETURN jsonb_build_object(
            'success', true, 'renewed', false, 'code', 'LEASE_NOT_OWNED', 'server_now', v_now,
            'is_running', v_row.is_running, 'generation', v_row.generation, 'claimed_by', v_row.claimed_by
        );
    END IF;

    IF v_row.lease_expires_at IS NULL OR v_row.lease_expires_at <= v_now THEN
        RETURN jsonb_build_object(
            'success', true, 'renewed', false, 'code', 'LEASE_EXPIRED', 'server_now', v_now,
            'is_running', v_row.is_running, 'generation', v_row.generation, 'claimed_by', v_row.claimed_by
        );
    END IF;

    UPDATE public.bot_sessions
       SET lease_expires_at  = v_now + make_interval(secs => p_lease_ms::double precision / 1000.0),
           lease_acquired_at = COALESCE(lease_acquired_at, v_now),
           updated_at        = v_now
     WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
        'success', true, 'renewed', true, 'code', NULL, 'server_now', v_now,
        'is_running', v_row.is_running, 'generation', v_row.generation, 'claimed_by', p_worker_id,
        'lease_expires_at', v_now + make_interval(secs => p_lease_ms::double precision / 1000.0)
    );
END $$;

-- 3c. Release the lease on graceful shutdown (best effort; expiry covers the rest).
CREATE OR REPLACE FUNCTION public.release_bot_session_lease(
    p_user_id BIGINT,
    p_worker_id TEXT,
    p_generation BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_now   TIMESTAMPTZ := now();
    v_count INTEGER;
BEGIN
    UPDATE public.bot_sessions
       SET claimed_by = NULL, lease_acquired_at = NULL, lease_expires_at = NULL, updated_at = v_now
     WHERE user_id = p_user_id
       AND claimed_by = p_worker_id
       AND (p_generation IS NULL OR COALESCE(generation, 0) = COALESCE(p_generation, 0));

    GET DIAGNOSTICS v_count = ROW_COUNT;

    RETURN jsonb_build_object('success', true, 'released', v_count > 0, 'server_now', v_now);
END $$;

-- 3d. Fenced stop: stopping a session is what BUMPS the generation, so any
--     in-flight tick from a previous executor is rejected at its next fence
--     check. NOT wired into /api/bot/stop in this stage; it exists so the stop
--     path can be switched over atomically when the worker goes live.
CREATE OR REPLACE FUNCTION public.stop_bot_session_fenced(
    p_user_id BIGINT,
    p_reason TEXT DEFAULT 'user_stopped',
    p_requested_by TEXT DEFAULT 'api'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_now   TIMESTAMPTZ := now();
    v_count INTEGER;
    v_gen   BIGINT;
BEGIN
    UPDATE public.bot_sessions
       SET is_running        = 0,
           generation        = COALESCE(generation, 0) + 1,
           claimed_by        = NULL,
           lease_acquired_at = NULL,
           lease_expires_at  = NULL,
           stopped_reason    = COALESCE(NULLIF(btrim(COALESCE(p_reason, '')), ''), 'stopped'),
           updated_at        = v_now
     WHERE user_id = p_user_id
    RETURNING generation INTO v_gen;

    GET DIAGNOSTICS v_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'success', true, 'stopped', v_count > 0, 'generation', v_gen,
        'requested_by', p_requested_by, 'server_now', v_now
    );
END $$;

-- ---------------------------------------------------------------------------
-- 4. Privileges: service_role only (matches migrations 014 / 016 / 018)
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.claim_bot_sessions(TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_bot_sessions(TEXT, INTEGER, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_bot_sessions(TEXT, INTEGER, INTEGER) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_bot_sessions(TEXT, INTEGER, INTEGER) TO service_role;

REVOKE EXECUTE ON FUNCTION public.renew_bot_session_lease(BIGINT, TEXT, BIGINT, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.renew_bot_session_lease(BIGINT, TEXT, BIGINT, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.renew_bot_session_lease(BIGINT, TEXT, BIGINT, INTEGER) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.renew_bot_session_lease(BIGINT, TEXT, BIGINT, INTEGER) TO service_role;

REVOKE EXECUTE ON FUNCTION public.release_bot_session_lease(BIGINT, TEXT, BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.release_bot_session_lease(BIGINT, TEXT, BIGINT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.release_bot_session_lease(BIGINT, TEXT, BIGINT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.release_bot_session_lease(BIGINT, TEXT, BIGINT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.stop_bot_session_fenced(BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stop_bot_session_fenced(BIGINT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.stop_bot_session_fenced(BIGINT, TEXT, TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.stop_bot_session_fenced(BIGINT, TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Self-check: raise (and roll back) if anything above did not land
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_missing TEXT[] := ARRAY[]::TEXT[];
    v_col     TEXT;
    v_fn      TEXT;
BEGIN
    FOREACH v_col IN ARRAY ARRAY['claimed_by', 'lease_acquired_at', 'lease_expires_at', 'generation']
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'bot_sessions' AND column_name = v_col
        ) THEN
            v_missing := array_append(v_missing, 'bot_sessions.' || v_col);
        END IF;
    END LOOP;

    IF to_regclass('public.idx_bot_sessions_claimable') IS NULL THEN
        v_missing := array_append(v_missing, 'index idx_bot_sessions_claimable');
    END IF;

    FOREACH v_fn IN ARRAY ARRAY[
        'claim_bot_sessions(text,integer,integer)',
        'renew_bot_session_lease(bigint,text,bigint,integer)',
        'release_bot_session_lease(bigint,text,bigint)',
        'stop_bot_session_fenced(bigint,text,text)'
    ]
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = split_part(v_fn, '(', 1)
        ) THEN
            v_missing := array_append(v_missing, 'function ' || v_fn);
        END IF;
    END LOOP;

    IF array_length(v_missing, 1) IS NOT NULL THEN
        RAISE EXCEPTION 'Migration 029 self-check failed; missing: %', array_to_string(v_missing, ', ');
    END IF;

    RAISE NOTICE 'Migration 029 self-check passed (lease columns + claim index + 4 lease RPCs).';
END $$;

COMMIT;
