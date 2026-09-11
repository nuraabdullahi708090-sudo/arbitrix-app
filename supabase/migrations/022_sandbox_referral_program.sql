-- ============================================================================
-- 022 — MARKETING SANDBOX REFERRAL PROGRAM (production parity, sandbox-only)
-- ============================================================================
-- ============================================================================
-- 022 — MARKETING SANDBOX REFERRAL PROGRAM (production parity, sandbox-only)
-- ============================================================================
-- FINAL management model (production parity): the MARKETING SANDBOX referral
-- program mirrors PRODUCTION exactly:
--     * referral reward ............ 20% of the referred user's INITIAL
--                                    QUALIFYING DEPOSIT (one-time, from
--                                    referral_config.referral_reward_percent)
--     * qualification .............. platform minimum qualifying deposit ($100)
--     * downline profit share ...... NONE (the 10% commission model is retired)
--     * MTA ........................ NONE (removed for the sandbox; see server.js)
--
-- This migration is ADDITIVE and SANDBOX-ONLY:
--   * Every row lives in a sandbox_* table (is_simulated = true). No production
--     table (referrals, wallets, transactions, ...) is written or altered, so
--     production referral data and production balances can never be involved.
--   * Every RPC asserts users.environment = 'MARKETING_SANDBOX' for the account
--     that RECEIVES money, so a production account can never be credited by
--     these functions. The existing production-table backstop triggers
--     (migration 013) remain the second line of defense.
--   * Sandbox referral earnings are credited to sandbox_wallets.balance — the
--     same simulated, persistent, tradable balance the sandbox trading engine
--     already debits/credits — so referral earnings are immediately usable as
--     trading capital through the EXISTING engine (no second engine), and are
--     withdrawable through the EXISTING sandbox withdrawal flow without any
--     trade requirement. Nothing about the sandbox withdrawal rules changes.
--
-- Guarantees mirror the production helper (migration 021):
--   * exactly-once referral award  -> pending + bonus_earned = 0 + FOR UPDATE +
--     post-lock re-check + GET DIAGNOSTICS row_count (concurrency-safe).
--   * a deposit below the platform minimum qualifying deposit never qualifies.
--   * self-referral impossible (CHECK + unique index on real referred users).
--
-- Idempotent: safe to re-run (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE /
-- DROP ... IF EXISTS). No DDL is applied to any existing (production) table.
-- ============================================================================

-- ============================================
-- 1. SANDBOX REFERRAL TABLES
-- ============================================

-- One row per referral relationship held by a MARKETING_SANDBOX account.
-- `referred_id` is a REAL sandbox user id (> 0) when a sandbox account was
-- created with a sandbox referral code, or a SYNTHETIC negative id when the
-- marketing operator simulates a downline (mirrors production's simulated
-- referral convention of a negative referred id).
CREATE TABLE IF NOT EXISTS public.sandbox_referrals (
    id BIGSERIAL PRIMARY KEY,
    referrer_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    referred_id BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
    bonus_earned DECIMAL(18, 2) NOT NULL DEFAULT 0 CHECK (bonus_earned >= 0),
    qualified_at TIMESTAMPTZ,
    qualification_type TEXT,
    is_simulated BOOLEAN NOT NULL DEFAULT true CHECK (is_simulated),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT sandbox_referrals_no_self CHECK (referred_id <> referrer_id)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_referrals_referrer
    ON public.sandbox_referrals(referrer_id, created_at DESC);
-- A REAL sandbox user can only ever be attributed once (anti-abuse). Synthetic
-- (negative) simulated downlines are exempt so a demo can create many.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_referrals_referred_unique
    ON public.sandbox_referrals(referred_id) WHERE referred_id > 0;

-- ============================================
-- 2. SANDBOX REFERRAL CONFIG (production keys, safe fallbacks)
-- ============================================
-- The sandbox mirrors the PLATFORM referral rules rather than inventing new
-- numbers: the minimum qualifying deposit and the reward PERCENTAGE are read
-- from the same referral_config keys production uses (single source of truth).
-- Missing/unreadable config falls back to the platform defaults ($100 / 20%).
CREATE OR REPLACE FUNCTION public.sandbox_referral_config()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_min DECIMAL := 100;
    v_percent DECIMAL := 20;
    v_txt TEXT;
BEGIN
    BEGIN
        SELECT config_value INTO v_txt FROM public.referral_config
        WHERE config_key = 'minimum_qualifying_deposit';
        IF v_txt IS NOT NULL AND btrim(v_txt) <> '' THEN v_min := btrim(v_txt)::numeric; END IF;
    EXCEPTION WHEN OTHERS THEN v_min := 100;
    END;
    BEGIN
        SELECT config_value INTO v_txt FROM public.referral_config
        WHERE config_key = 'referral_reward_percent';
        IF v_txt IS NOT NULL AND btrim(v_txt) <> '' THEN v_percent := btrim(v_txt)::numeric; END IF;
    EXCEPTION WHEN OTHERS THEN v_percent := 20;
    END;
    IF v_percent IS NULL OR v_percent < 0 THEN v_percent := 20; END IF;
    IF v_percent > 100 THEN v_percent := 100; END IF;
    RETURN jsonb_build_object(
        'minimum_deposit', COALESCE(v_min, 100),
        'reward_percent', COALESCE(v_percent, 20));
END;
$$;

-- ============================================
-- 3. SANDBOX REFERRAL RPCs (SECURITY DEFINER, env-asserted)
-- ============================================

-- Exactly-once simulated referral award. Mirrors the production helper
-- award_referral_qualification_safe(): the referred account must have made a
-- deposit of at least the platform minimum qualifying deposit; the reward is
-- credited to the REFERRER's sandbox balance (never the referred user's money)
-- and the referral flips pending -> active atomically.
--
-- p_referred_id may be a real sandbox user id (> 0) or a synthetic negative id
-- for a simulated downline. The account that RECEIVES money (the referrer) is
-- always asserted to be a MARKETING_SANDBOX account.
CREATE OR REPLACE FUNCTION public.sandbox_award_referral_qualification(
    p_referred_id BIGINT,
    p_deposit_amount DECIMAL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_cfg JSONB;
    v_min DECIMAL;
    v_percent DECIMAL;
    v_reward DECIMAL;
    v_ref public.sandbox_referrals%ROWTYPE;
    v_wallet public.sandbox_wallets%ROWTYPE;
    v_new_balance DECIMAL;
    v_rows INT;
BEGIN
    IF p_referred_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'reason', 'no_referred_user');
    END IF;

    v_cfg := public.sandbox_referral_config();
    v_min := COALESCE((v_cfg->>'minimum_deposit')::numeric, 100);
    v_percent := COALESCE((v_cfg->>'reward_percent')::numeric, 20);

    IF p_deposit_amount IS NULL OR p_deposit_amount < v_min THEN
        RETURN jsonb_build_object('success', false, 'reason', 'below_minimum_deposit',
            'minimum_required', v_min);
    END IF;

    -- FINAL MODEL: one-time reward = <percent>% of the initial qualifying deposit.
    v_reward := ROUND(p_deposit_amount * v_percent / 100.0, 2);
    IF v_reward <= 0 THEN
        RETURN jsonb_build_object('success', false, 'reason', 'no_reward');
    END IF;

    -- Row lock = concurrency guard: a concurrent award for the same referred
    -- user blocks here, then re-evaluates the WHERE clause (status/bonus_earned)
    -- after the winning transaction commits, finds no pending row and awards 0.
    SELECT * INTO v_ref FROM public.sandbox_referrals
    WHERE referred_id = p_referred_id AND status = 'pending' AND bonus_earned = 0
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'reason', 'no_pending_referral');
    END IF;

    -- The owner of the money that is about to be created MUST be a sandbox
    -- account (isolation). The referred party is asserted too when it is real.
    PERFORM public.assert_sandbox_user(v_ref.referrer_id);
    IF p_referred_id > 0 THEN
        PERFORM public.assert_sandbox_user(p_referred_id);
    END IF;

    UPDATE public.sandbox_referrals
    SET status = 'active',
        bonus_earned = v_reward,
        qualified_at = NOW(),
        qualification_type = 'minimum_deposit'
    WHERE id = v_ref.id AND status = 'pending' AND bonus_earned = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
        RETURN jsonb_build_object('success', false, 'reason', 'already_activated');
    END IF;

    v_wallet := public.sandbox_ensure_wallet(v_ref.referrer_id);
    SELECT * INTO v_wallet FROM public.sandbox_wallets
    WHERE user_id = v_ref.referrer_id FOR UPDATE;
    v_new_balance := v_wallet.balance + v_reward;
    UPDATE public.sandbox_wallets
    SET balance = v_new_balance, updated_at = NOW()
    WHERE user_id = v_ref.referrer_id;

    INSERT INTO public.sandbox_transactions (user_id, type, amount, detail)
    VALUES (v_ref.referrer_id, 'Referral Bonus', v_reward,
        'SIMULATED referral bonus (qualifying deposit)');

    RETURN jsonb_build_object('success', true,
        'referrer_id', v_ref.referrer_id,
        'referred_id', p_referred_id,
        'bonus_amount', v_reward,
        'new_balance', v_new_balance);

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Keep the existing one-click marketing reset complete: it already deletes
-- every sandbox_* row for the account (migration 013). The two new sandbox
-- referral tables are added to that same cleanup. Nothing else about the reset
-- changes (balance -> 0, intro_day -> 1, badge -> visible).
CREATE OR REPLACE FUNCTION public.sandbox_reset_account(p_user_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    PERFORM public.assert_sandbox_user(p_user_id);

    DELETE FROM public.sandbox_deposits WHERE user_id = p_user_id;
    DELETE FROM public.sandbox_withdrawals WHERE user_id = p_user_id;
    DELETE FROM public.sandbox_trades WHERE user_id = p_user_id;
    DELETE FROM public.sandbox_transactions WHERE user_id = p_user_id;
    DELETE FROM public.sandbox_subscriptions WHERE user_id = p_user_id;
    DELETE FROM public.sandbox_subscription_charges WHERE user_id = p_user_id;
    DELETE FROM public.sandbox_bot_sessions WHERE user_id = p_user_id;
    DELETE FROM public.sandbox_referrals
        WHERE referrer_id = p_user_id OR referred_id = p_user_id;

    INSERT INTO public.sandbox_wallets (user_id, balance, intro_day, badge_hidden)
    VALUES (p_user_id, 0, 1, false)
    ON CONFLICT (user_id) DO UPDATE
    SET balance = 0, intro_day = 1, badge_hidden = false, updated_at = NOW();

    RETURN jsonb_build_object('success', true, 'balance', 0, 'intro_day', 1);
END;
$$;

-- ============================================
-- 3b. REMOVE THE RETIRED SANDBOX COMMISSION SURFACE
-- ============================================
-- The 10% downline profit-share model is retired, so the sandbox must not keep
-- a parallel commission ledger/RPC. Dropped by resolved signature so any earlier
-- revision's argument list is tolerated. Idempotent.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'sandbox_credit_referral_commission'
    LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig;
    END LOOP;
END $$;

DROP TABLE IF EXISTS public.sandbox_referral_commissions;

-- Keep the new surface server-only, mirroring every other sandbox RPC.
REVOKE ALL ON FUNCTION public.sandbox_referral_config() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sandbox_award_referral_qualification(BIGINT, DECIMAL) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sandbox_referral_config() TO service_role;
GRANT EXECUTE ON FUNCTION public.sandbox_award_referral_qualification(BIGINT, DECIMAL) TO service_role;

COMMENT ON TABLE public.sandbox_referrals IS
    'MARKETING_SANDBOX referral relationships (is_simulated=true). Never production referral data; the referrer is always asserted to be a sandbox account.';
COMMENT ON FUNCTION public.sandbox_award_referral_qualification IS
    'Exactly-once simulated referral award for MARKETING_SANDBOX accounts: requires the platform minimum qualifying deposit, credits ONLY the referrer''s sandbox balance, pending -> active atomically (FOR UPDATE + row_count guard).';

-- ============================================
-- 4. RUNTIME SELF-CHECK
-- ============================================
DO $$
DECLARE
    v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = 'sandbox_referrals') THEN
        v_missing := v_missing || 'sandbox_referrals';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sandbox_referral_config') THEN
        v_missing := v_missing || 'sandbox_referral_config';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sandbox_award_referral_qualification') THEN
        v_missing := v_missing || 'sandbox_award_referral_qualification';
    END IF;
    -- The retired 10% commission surface must be ABSENT from the sandbox too.
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = 'sandbox_referral_commissions') THEN
        RAISE EXCEPTION 'Migration 022 self-check failed: obsolete sandbox_referral_commissions still present';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'sandbox_credit_referral_commission') THEN
        RAISE EXCEPTION 'Migration 022 self-check failed: obsolete sandbox_credit_referral_commission still present';
    END IF;
    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'Migration 022 self-check failed, missing objects: %', v_missing;
    END IF;
END $$;
