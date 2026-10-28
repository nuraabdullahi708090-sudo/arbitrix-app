-- ============================================================================
-- 043 - lease-based recovery for the Telegram marketing queue
-- ============================================================================
-- DEFECT (documented in docs/TELEGRAM_RECOVERY_AUDIT.md, section 19)
--   claim_marketing_posts() only ever selected status = 'scheduled'. There was
--   no branch for status = 'sending' and no claimant/lease bookkeeping, so a
--   worker that died between claim and finish (crash, OOM, deploy, Render
--   restart, a hung Telegram call) left the row 'sending' FOREVER: it was never
--   claimed again, never published and never failed. Nothing noticed.
--
-- WHAT THIS MIGRATION ADDS
--   * telegram_marketing_posts.claimed_by / lease_expires_at / last_attempt_at
--   * a partial index on the lease for the cheap reclaim probe
--   * claim_marketing_posts(p_now, p_limit, p_worker_id, p_lease_seconds):
--     - still claims due 'scheduled' rows exactly as before;
--     - additionally reclaims 'sending' rows whose lease is NULL or expired;
--     - marks a post 'failed' (last_error = lease_expired) once a crashed claim
--       has consumed every attempt, BEFORE it could be reclaimed again;
--     - records the claimant and the lease expiry.
--   * finish_marketing_post(..., p_worker_id): FENCED on the current claimant,
--     so a worker whose lease was reclaimed cannot overwrite the new owner's
--     outcome. It also clears the lease on every transition.
--   * block_marketing_post(..., p_worker_id): same optional fence.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It never resets every 'sending' row on startup. That is unsafe with more
--     than one worker: worker A can be mid-send while worker B starts and resets
--     A's row, producing a duplicate channel post. Recovery happens only when a
--     lease has genuinely expired.
--   * It does not change the control switches, the content guard, the send
--     audit table, the audience/payload handling or the worker's gating.
--
-- DOUBLE-POST PROTECTION
--   A lease expiry does not prove the send failed. Before re-sending, the worker
--   reconciles against telegram_marketing_sends: a post that already has a
--   'sent' audit row is marked published instead of being sent again. The lease
--   default (180 s) is far longer than one send+finish cycle, so a reclaim only
--   happens after a real death.
--
-- DEPLOY ORDER (important)
--   This migration DROPS the old 2/5/2-argument signatures and creates 4/6/3
--   argument versions, so it and the worker code must move together:
--     old worker + this migration  = calls signatures that no longer exist;
--     new worker + no migration   = passes p_worker_id/p_lease_seconds to a
--                                   function that does not accept them.
--   Both fail closed (nothing is sent) but neither publishes. Apply this with,
--   or before, the matching services/MarketingWorker + services/MarketingStore
--   release. Publishing is disabled in this deployment (TELEGRAM_MARKETING_ENABLED
--   unset, control row paused + dry_run), so no worker is running during the swap.
--
-- IDEMPOTENT: ADD COLUMN / CREATE INDEX guarded, functions are CREATE OR REPLACE
-- with DROP IF EXISTS of the superseded overloads, safe to re-run.
--
-- ROLLBACK: re-apply supabase/migrations/038_marketing_broadcast.sql (it
--   recreates the original 2/5/2-argument functions); the added columns and the
--   index are additive and can stay.
-- ============================================================================

DO $migration$
DECLARE
  v_cols    INTEGER;
  v_lease_ok BOOLEAN;
  v_src_fin TEXT;
  v_src_clm TEXT;
BEGIN
  -- ------------------------------------------------------------------
  -- 0. Preconditions: migration 038 must be applied
  -- ------------------------------------------------------------------
  IF to_regclass('public.telegram_marketing_posts') IS NULL THEN
    RAISE EXCEPTION 'migration 043 requires public.telegram_marketing_posts (apply 038 first)';
  END IF;
  IF to_regprocedure('public.claim_marketing_posts(timestamp with time zone, integer)') IS NULL
     AND to_regprocedure('public.claim_marketing_posts(timestamp with time zone, integer, text, integer)') IS NULL THEN
    RAISE EXCEPTION 'migration 043 requires claim_marketing_posts() from migration 038';
  END IF;

  -- ------------------------------------------------------------------
  -- 1. Claimant + lease bookkeeping (additive, nullable)
  -- ------------------------------------------------------------------
  ALTER TABLE public.telegram_marketing_posts
    ADD COLUMN IF NOT EXISTS claimed_by       TEXT,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_attempt_at  TIMESTAMPTZ;

  COMMENT ON COLUMN public.telegram_marketing_posts.claimed_by IS
    'Worker id that currently owns this row. Set on claim, cleared on every transition; used to fence finish/block.';
  COMMENT ON COLUMN public.telegram_marketing_posts.lease_expires_at IS
    'When the current claim goes stale. NULL or past => the row may be reclaimed by another worker. Attempts are still bounded.';
  COMMENT ON COLUMN public.telegram_marketing_posts.last_attempt_at IS
    'Timestamp of the most recent claim (diagnostics only).';

  CREATE INDEX IF NOT EXISTS telegram_marketing_posts_lease_idx
    ON public.telegram_marketing_posts (lease_expires_at)
    WHERE status = 'sending';

  -- ------------------------------------------------------------------
  -- 2. Supersede the old signatures (no ambiguous overloads for PostgREST)
  -- ------------------------------------------------------------------
  DROP FUNCTION IF EXISTS public.finish_marketing_post(BIGINT, BOOLEAN, BIGINT, TEXT, TIMESTAMPTZ);
  DROP FUNCTION IF EXISTS public.block_marketing_post(BIGINT, TEXT);
  DROP FUNCTION IF EXISTS public.claim_marketing_posts(TIMESTAMPTZ, INTEGER);

  -- ------------------------------------------------------------------
  -- 3. claim_marketing_posts: due posts + expired-lease reclaim
  -- ------------------------------------------------------------------
  CREATE OR REPLACE FUNCTION public.claim_marketing_posts(
    p_now           TIMESTAMPTZ DEFAULT NULL,
    p_limit         INTEGER DEFAULT 5,
    p_worker_id     TEXT DEFAULT NULL,
    p_lease_seconds INTEGER DEFAULT 180
  )
  RETURNS SETOF public.telegram_marketing_posts
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    v_limit  INTEGER := LEAST(GREATEST(COALESCE(p_limit, 5), 1), 25);
    v_lease  INTEGER := LEAST(GREATEST(COALESCE(p_lease_seconds, 180), 30), 900);
    v_now    TIMESTAMPTZ := COALESCE(p_now, now());
    v_worker TEXT := COALESCE(NULLIF(btrim(COALESCE(p_worker_id, '')), ''), 'worker');
  BEGIN
    -- Poison posts first: a claim whose lease expired and which has used every
    -- attempt is terminal. Ending it here (instead of reclaiming it) keeps the
    -- retry budget bounded even when every attempt crashes.
    UPDATE public.telegram_marketing_posts
    SET status = 'failed',
        last_error = left(COALESCE(last_error, 'lease_expired'), 500),
        claimed_by = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    WHERE status = 'sending'
      AND attempts >= max_attempts
      AND (lease_expires_at IS NULL OR lease_expires_at < v_now);

    RETURN QUERY
    WITH due AS (
      SELECT p.id
      FROM public.telegram_marketing_posts p
      WHERE p.attempts < p.max_attempts
        AND (
              (p.status = 'scheduled'
               AND p.scheduled_for IS NOT NULL
               AND p.scheduled_for <= v_now)
           OR (p.status = 'sending'
               AND (p.lease_expires_at IS NULL OR p.lease_expires_at < v_now))
            )
      ORDER BY p.scheduled_for ASC
      LIMIT v_limit
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.telegram_marketing_posts p
    SET status = 'sending',
        attempts = p.attempts + 1,
        claimed_by = v_worker,
        lease_expires_at = v_now + make_interval(secs => v_lease),
        last_attempt_at = v_now,
        updated_at = v_now
    FROM due
    WHERE p.id = due.id
    RETURNING p.*;
  END;
  $$;

  -- ------------------------------------------------------------------
  -- 4. finish_marketing_post: fenced on the current claimant
  -- ------------------------------------------------------------------
  CREATE OR REPLACE FUNCTION public.finish_marketing_post(
    p_id         BIGINT,
    p_ok         BOOLEAN,
    p_message_id BIGINT DEFAULT NULL,
    p_error      TEXT DEFAULT NULL,
    p_retry_at   TIMESTAMPTZ DEFAULT NULL,
    p_worker_id  TEXT DEFAULT NULL
  )
  RETURNS public.telegram_marketing_posts
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    v_row public.telegram_marketing_posts;
  BEGIN
    IF p_id IS NULL THEN
      RAISE EXCEPTION 'post id is required';
    END IF;

    IF p_ok THEN
      UPDATE public.telegram_marketing_posts
      SET status = 'published',
          telegram_message_id = COALESCE(p_message_id, telegram_message_id),
          published_at = now(),
          last_error = NULL,
          claimed_by = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE id = p_id AND status = 'sending'
        AND (p_worker_id IS NULL OR claimed_by IS NULL OR claimed_by = p_worker_id)
      RETURNING * INTO v_row;
    ELSE
      UPDATE public.telegram_marketing_posts
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'scheduled' END,
          scheduled_for = CASE WHEN attempts >= max_attempts THEN scheduled_for
                               ELSE COALESCE(p_retry_at, now() + interval '2 minutes') END,
          last_error = left(COALESCE(p_error, 'unknown error'), 500),
          claimed_by = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE id = p_id AND status = 'sending'
        AND (p_worker_id IS NULL OR claimed_by IS NULL OR claimed_by = p_worker_id)
      RETURNING * INTO v_row;
    END IF;

    RETURN v_row;
  END;
  $$;

  -- ------------------------------------------------------------------
  -- 5. block_marketing_post: same optional fence
  -- ------------------------------------------------------------------
  CREATE OR REPLACE FUNCTION public.block_marketing_post(
    p_id        BIGINT,
    p_reason    TEXT,
    p_worker_id TEXT DEFAULT NULL
  )
  RETURNS public.telegram_marketing_posts
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    v_row public.telegram_marketing_posts;
  BEGIN
    UPDATE public.telegram_marketing_posts
    SET status = 'blocked',
        last_error = left(COALESCE(p_reason, 'blocked by content guard'), 500),
        claimed_by = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = p_id AND status IN ('scheduled', 'sending', 'approved')
      AND (p_worker_id IS NULL OR claimed_by IS NULL OR claimed_by = p_worker_id)
    RETURNING * INTO v_row;
    RETURN v_row;
  END;
  $$;

  -- ------------------------------------------------------------------
  -- 6. Grants: service_role only (same policy as 038)
  -- ------------------------------------------------------------------
  EXECUTE 'REVOKE ALL ON FUNCTION public.claim_marketing_posts(TIMESTAMPTZ, INTEGER, TEXT, INTEGER) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.finish_marketing_post(BIGINT, BOOLEAN, BIGINT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.block_marketing_post(BIGINT, TEXT, TEXT) FROM PUBLIC';

  IF to_regrole('anon') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.claim_marketing_posts(TIMESTAMPTZ, INTEGER, TEXT, INTEGER) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.finish_marketing_post(BIGINT, BOOLEAN, BIGINT, TEXT, TIMESTAMPTZ, TEXT) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.block_marketing_post(BIGINT, TEXT, TEXT) FROM anon';
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.claim_marketing_posts(TIMESTAMPTZ, INTEGER, TEXT, INTEGER) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.finish_marketing_post(BIGINT, BOOLEAN, BIGINT, TEXT, TIMESTAMPTZ, TEXT) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.block_marketing_post(BIGINT, TEXT, TEXT) FROM authenticated';
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.claim_marketing_posts(TIMESTAMPTZ, INTEGER, TEXT, INTEGER) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.finish_marketing_post(BIGINT, BOOLEAN, BIGINT, TEXT, TIMESTAMPTZ, TEXT) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.block_marketing_post(BIGINT, TEXT, TEXT) TO service_role';
  END IF;

  -- ------------------------------------------------------------------
  -- 7. Self-check: a failure rolls the whole file back
  -- ------------------------------------------------------------------
  SELECT count(*) INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'telegram_marketing_posts'
    AND column_name IN ('claimed_by', 'lease_expires_at', 'last_attempt_at');
  IF v_cols <> 3 THEN
    RAISE EXCEPTION '043 self-check: expected 3 lease columns on telegram_marketing_posts, found %', v_cols;
  END IF;

  SELECT to_regclass('public.telegram_marketing_posts_lease_idx') IS NOT NULL INTO v_lease_ok;
  IF NOT COALESCE(v_lease_ok, FALSE) THEN
    RAISE EXCEPTION '043 self-check: the lease index is missing';
  END IF;

  IF to_regprocedure('public.claim_marketing_posts(timestamp with time zone, integer, text, integer)') IS NULL THEN
    RAISE EXCEPTION '043 self-check: claim_marketing_posts(p_now, p_limit, p_worker_id, p_lease_seconds) is missing';
  END IF;
  IF to_regprocedure('public.finish_marketing_post(bigint, boolean, bigint, text, timestamp with time zone, text)') IS NULL THEN
    RAISE EXCEPTION '043 self-check: the fenced finish_marketing_post is missing';
  END IF;
  IF to_regprocedure('public.block_marketing_post(bigint, text, text)') IS NULL THEN
    RAISE EXCEPTION '043 self-check: the fenced block_marketing_post is missing';
  END IF;

  IF to_regprocedure('public.claim_marketing_posts(timestamp with time zone, integer)') IS NOT NULL
     OR to_regprocedure('public.finish_marketing_post(bigint, boolean, bigint, text, timestamp with time zone)') IS NOT NULL
     OR to_regprocedure('public.block_marketing_post(bigint, text)') IS NOT NULL THEN
    RAISE EXCEPTION '043 self-check: a superseded function signature is still present (ambiguous overloads)';
  END IF;

  SELECT pg_get_functiondef(to_regprocedure('public.claim_marketing_posts(timestamp with time zone, integer, text, integer)'))
    INTO v_src_clm;
  IF v_src_clm !~ 'lease_expired' THEN
    RAISE EXCEPTION '043 self-check: the poison-post (lease_expired) branch is missing';
  END IF;
  IF v_src_clm !~ 'lease_expires_at < v_now' THEN
    RAISE EXCEPTION '043 self-check: the expired-lease reclaim branch is missing';
  END IF;
  IF v_src_clm !~ 'claimed_by = v_worker' THEN
    RAISE EXCEPTION '043 self-check: the claim does not record the claimant';
  END IF;

  SELECT pg_get_functiondef(to_regprocedure('public.finish_marketing_post(bigint, boolean, bigint, text, timestamp with time zone, text)'))
    INTO v_src_fin;
  IF v_src_fin !~ 'claimed_by = p_worker_id' THEN
    RAISE EXCEPTION '043 self-check: finish_marketing_post is not fenced on the claimant';
  END IF;

  IF NOT (SELECT bool_and(prosecdef) FROM pg_proc
           WHERE oid IN (
             to_regprocedure('public.claim_marketing_posts(timestamp with time zone, integer, text, integer)'),
             to_regprocedure('public.finish_marketing_post(bigint, boolean, bigint, text, timestamp with time zone, text)'),
             to_regprocedure('public.block_marketing_post(bigint, text, text)')
           )) THEN
    RAISE EXCEPTION '043 self-check: SECURITY DEFINER was lost';
  END IF;

  RAISE NOTICE 'migration 043: lease claim, fenced finish and poison-post handling verified';
END
$migration$;

-- PostgREST caches function signatures; ask it to reload so the new argument
-- lists are immediately callable. Harmless where no listener is attached.
NOTIFY pgrst, 'reload schema';
