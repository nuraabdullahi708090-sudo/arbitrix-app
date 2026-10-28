-- 044_marketing_worker_heartbeat.sql
--
-- Liveness for the Telegram marketing publisher.
--
-- WHY
--   Before this migration the admin status route could only report whether the
--   worker was ENABLED by configuration. It could not distinguish a running
--   worker from one that had crashed, been removed from Render, or lost its
--   database connection - the queue simply stopped moving with no signal.
--
-- WHAT
--   Three nullable columns on the singleton control row:
--     worker_heartbeat_at  last time a worker completed a tick
--     worker_id            which worker instance wrote it (TELEGRAM_MARKETING_WORKER_ID)
--     worker_version       entrypoint version, for spotting a stale deploy
--
-- SAFETY
--   * Additive and idempotent. NULL means "no heartbeat yet", so an existing
--     deployment is healthy-but-unknown rather than broken.
--   * No permission change: service_role already holds UPDATE on this row and
--     anon/authenticated hold nothing. RLS policy from 038 is untouched.
--   * A heartbeat can NEVER change paused or dry_run, so writing one cannot
--     resume publishing.
--   * No money, wallet, ledger, subscription or sandbox object is referenced.
--
-- The trailing DO block re-verifies the contract and rolls the file back if any
-- column is missing.

BEGIN;

ALTER TABLE public.telegram_marketing_control
  ADD COLUMN IF NOT EXISTS worker_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS worker_id           TEXT,
  ADD COLUMN IF NOT EXISTS worker_version      TEXT;

COMMENT ON COLUMN public.telegram_marketing_control.worker_heartbeat_at IS
  'Last successful publishing tick by a worker process. NULL = the worker has never reported.';
COMMENT ON COLUMN public.telegram_marketing_control.worker_id IS
  'Worker instance that wrote the heartbeat (TELEGRAM_MARKETING_WORKER_ID).';
COMMENT ON COLUMN public.telegram_marketing_control.worker_version IS
  'Marketing worker entrypoint version, used to spot a stale deployment.';

DO $$
DECLARE
  v_cols INTEGER;
BEGIN
  SELECT count(*) INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'telegram_marketing_control'
    AND column_name IN ('worker_heartbeat_at', 'worker_id', 'worker_version');

  IF v_cols <> 3 THEN
    RAISE EXCEPTION '044 self-check: expected 3 heartbeat columns on telegram_marketing_control, found %', v_cols;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.telegram_marketing_control WHERE id = 1
  ) THEN
    RAISE EXCEPTION '044 self-check: the singleton control row (id = 1) is missing';
  END IF;
END;
$$;

COMMIT;
