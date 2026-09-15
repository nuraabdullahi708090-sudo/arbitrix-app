-- ============================================
-- MIGRATION: 027 - Server-side trading worker support
--                  (Additive, idempotent, self-checking)
-- ============================================
-- PURPOSE
--   The production trading loop currently lives in the BROWSER
--   (`setInterval(executeBotTrade, 8000)` in public/index.html), so it stops the
--   moment the tab closes, the phone sleeps, or the page is refreshed.
--   `bot_sessions.is_running` is therefore an unreliable signal: it can stay 1
--   after the tab is gone (a "phantom running bot" that admin stats still count)
--   while nothing is trading at all.
--
--   This migration adds the persistence the SERVER-SIDE worker needs to become
--   the source of truth for "is this session actually trading":
--     * a heartbeat + tick bookkeeping on bot_sessions, so a worker crash, a
--       deploy restart or a network partition is DETECTABLE (stale heartbeat),
--     * failure accounting so a session auto-stops instead of retrying forever,
--     * a single-row CONTROL table holding the platform-wide EMERGENCY STOP.
--
--   NOTHING here starts, schedules or enables trading. Execution is gated by the
--   `TRADING_WORKER_ENABLED` env flag (default OFF) and, independently, by the
--   emergency-stop row. This migration only adds columns/tables and is safe to
--   apply while the browser engine is still the only executor.
--
-- SCOPE / NON-GOALS
--   * Does NOT change record_trade_safe, wallets, trades, deposits, withdrawals,
--     subscriptions, referrals, KYC or any sandbox table/RPC.
--   * Does NOT alter any existing bot_sessions value; existing rows keep
--     is_running as-is and simply gain NULL heartbeat columns until the worker
--     reconciles them.
--   * MARKETING_SANDBOX is untouched: sandbox bot sessions live in
--     sandbox_bot_sessions and this migration never reads or writes them.
--
-- ROLLBACK
--   The added columns are nullable / defaulted and the control table is new, so
--   the previous application build keeps working unchanged if this is reverted.
--   DROP TABLE bot_worker_control; ALTER TABLE bot_sessions DROP COLUMN ...;
-- ============================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Worker bookkeeping on bot_sessions (all nullable / defaulted = additive)
-- ---------------------------------------------------------------------------
-- heartbeat_at        : last successful proof-of-life from the worker.
-- last_tick_at        : last completed evaluation tick for this session.
-- tick_count          : monotonic count of evaluated ticks (diagnostics).
-- consecutive_failures: reset on success; drives auto-stop after N failures.
-- stopped_reason      : why the worker (or an admin) stopped the session.
-- worker_version      : which worker build last touched the session.
-- risk_limits         : per-session risk-limit override snapshot (JSONB).
ALTER TABLE public.bot_sessions
    ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_tick_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS tick_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS stopped_reason TEXT,
    ADD COLUMN IF NOT EXISTS worker_version TEXT,
    ADD COLUMN IF NOT EXISTS risk_limits JSONB,
    -- Written by the worker's heartbeat/stop paths and by the admin emergency
    -- stop. bot_sessions is pre-existing (no migration creates it), so the
    -- column is added defensively: without it those writes fail silently and a
    -- phantom "running" session survives a stop.
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Stale-heartbeat reconciliation scans running sessions only.
CREATE INDEX IF NOT EXISTS idx_bot_sessions_heartbeat
    ON public.bot_sessions (is_running, heartbeat_at);

-- ---------------------------------------------------------------------------
-- 2. Platform-wide emergency stop (single row, id = 1)
-- ---------------------------------------------------------------------------
-- FAIL-SAFE SEMANTICS: emergency_stop is a KILL SWITCH, not an enable switch.
-- It defaults to FALSE so applying this migration changes nothing; the worker
-- additionally requires TRADING_WORKER_ENABLED=true before it will ever trade.
-- When TRUE, the worker refuses to open new trades and stops every running
-- session. The worker FAILS CLOSED if this row cannot be read (it cannot prove
-- the platform is not stopped), which also means the worker must not be enabled
-- before this migration is applied.
CREATE TABLE IF NOT EXISTS public.bot_worker_control (
    id            SMALLINT PRIMARY KEY DEFAULT 1,
    emergency_stop BOOLEAN NOT NULL DEFAULT FALSE,
    reason        TEXT,
    engaged_by    TEXT,
    engaged_at    TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT bot_worker_control_singleton CHECK (id = 1)
);

INSERT INTO public.bot_worker_control (id, emergency_stop)
VALUES (1, FALSE)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.bot_worker_control IS
    'Singleton kill switch for the server-side trading worker. emergency_stop=TRUE makes the worker refuse new trades and stop all running bot sessions. Not read by the sandbox.';

COMMENT ON COLUMN public.bot_sessions.heartbeat_at IS
    'Last successful proof-of-life from the server-side trading worker. A stale value on a running session means the executor is gone (worker crash / deploy restart / partition).';

-- ---------------------------------------------------------------------------
-- 3. RLS lockdown: service_role only (anon/authenticated get NO policy = DENY)
-- ---------------------------------------------------------------------------
-- Mirrors migrations 010/018/026: the app uses custom JWT auth (no auth.uid()),
-- so ownership is enforced in application code and the database backstop is
-- "service_role only, deny by default".
ALTER TABLE public.bot_worker_control ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bot_worker_control_service_all" ON public.bot_worker_control;
CREATE POLICY "bot_worker_control_service_all"
    ON public.bot_worker_control
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- bot_sessions is already RLS'd by 018; re-assert (idempotent no-op if so).
ALTER TABLE public.bot_sessions ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 4. Self-check: raise (and roll back) if anything above did not land
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_missing TEXT[] := ARRAY[]::TEXT[];
    v_col TEXT;
BEGIN
    FOREACH v_col IN ARRAY ARRAY['heartbeat_at', 'last_tick_at', 'tick_count',
                                 'consecutive_failures', 'stopped_reason',
                                 'worker_version', 'risk_limits', 'updated_at']
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'bot_sessions'
              AND column_name = v_col
        ) THEN
            v_missing := array_append(v_missing, 'bot_sessions.' || v_col);
        END IF;
    END LOOP;

    IF to_regclass('public.bot_worker_control') IS NULL THEN
        v_missing := array_append(v_missing, 'table bot_worker_control');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.bot_worker_control WHERE id = 1) THEN
        v_missing := array_append(v_missing, 'bot_worker_control singleton row');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'bot_worker_control'
          AND policyname = 'bot_worker_control_service_all'
    ) THEN
        v_missing := array_append(v_missing, 'bot_worker_control service_role policy');
    END IF;

    IF array_length(v_missing, 1) IS NOT NULL THEN
        RAISE EXCEPTION 'Migration 027 self-check failed; missing: %', array_to_string(v_missing, ', ');
    END IF;

    RAISE NOTICE 'Migration 027 self-check passed (worker columns + control row + RLS).';
END $$;

COMMIT;
