-- ============================================
-- 033 - TEMPORARY: bot profit-pause state (management test)
-- ============================================
--
-- BUSINESS RULE (temporary experiment, expected to change):
--   Once a PRODUCTION account's cumulative NET realized Live profit reaches
--   $400 (BOT_PROFIT_PAUSE_USD), its bot is paused and further trading is
--   refused until the account receives a NEW confirmed deposit created AFTER
--   the pause triggered.
--
--   This table stores ONLY the pause bookkeeping: when the pause was triggered
--   and when it was cleared by a qualifying deposit. It stores no money, no
--   balance and no threshold. Accounts with no row are simply "never paused".
--
-- ADDITIVE / IDEMPOTENT: CREATE TABLE IF NOT EXISTS + indexes + policy, with a
-- trailing self-check. It does NOT touch wallets, trades, deposits, withdrawals,
-- subscriptions, referrals, KYC, bot_sessions or any sandbox table.
--
-- ACCESS MODEL: same as bot_sessions (migration 018) - RLS ENABLED with a
-- service_role-only policy; no anon/authenticated policy. The server and the
-- trading worker reach it through the service-role client only.
--
-- NOT APPLIED by this repository. Apply through the normal migration review
-- path. Both the server and the worker FAIL OPEN when this table is absent, so
-- deploying the code before the migration can never strand a trader.
-- ============================================

CREATE TABLE IF NOT EXISTS public.bot_profit_pauses (
    user_id      BIGINT PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cleared_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bot_profit_pauses_triggered
    ON public.bot_profit_pauses (triggered_at DESC);

ALTER TABLE public.bot_profit_pauses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bot_profit_pauses_service_all" ON public.bot_profit_pauses;
CREATE POLICY "bot_profit_pauses_service_all" ON public.bot_profit_pauses
    FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.bot_profit_pauses FROM anon;
REVOKE ALL ON public.bot_profit_pauses FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_profit_pauses TO service_role;

-- Self-check: fail loudly (and roll back) if anything is missing.
DO $$
BEGIN
    IF to_regclass('public.bot_profit_pauses') IS NULL THEN
        RAISE EXCEPTION '033: bot_profit_pauses table was not created';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bot_profit_pauses' AND column_name = 'triggered_at'
    ) THEN
        RAISE EXCEPTION '033: bot_profit_pauses.triggered_at is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bot_profit_pauses' AND column_name = 'cleared_at'
    ) THEN
        RAISE EXCEPTION '033: bot_profit_pauses.cleared_at is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'bot_profit_pauses' AND policyname = 'bot_profit_pauses_service_all'
    ) THEN
        RAISE EXCEPTION '033: bot_profit_pauses service_role policy is missing';
    END IF;
END $$;
