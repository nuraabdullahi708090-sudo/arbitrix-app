-- ============================================
-- MIGRATION 020 — FINAL referral reward model
--   One-time reward = 20% of the referred user's INITIAL QUALIFYING DEPOSIT.
-- ============================================
-- FINAL MANAGEMENT MODEL (supersedes every earlier referral-reward revision):
--   * A referral QUALIFIES only when the referred user makes the platform's
--     minimum qualifying deposit (the "initial qualifying deposit").
--   * The referrer then receives a ONE-TIME reward equal to 20% of that deposit.
--   * There is NO fixed/flat referral reward (no $10, no $20 flat) and NO
--     10% downline profit-share commission. Both are removed by this migration
--     where an earlier revision of this file had created them.
--
-- SCOPE (deliberately narrow, additive/idempotent):
--   - referral_config rows only: seed referral_reward_percent = '20'; delete the
--     obsolete 'referral_reward_amount' / 'referral_profit_commission_rate'.
--   - REMOVE the obsolete commission architecture if present
--     (public.credit_referral_commission_safe + public.referral_commissions).
--   - No change to referrals / wallets / transactions / users / deposits /
--     withdrawals table STRUCTURE, and no change to any other config row.
--
-- IDEMPOTENT: guarded INSERT/DELETE + DROP ... IF EXISTS are safe to re-run; the
-- trailing DO block re-verifies the final state and RAISES on drift.
-- ============================================

-- ============================================
-- 1. REFERRAL CONFIG — final model
-- ============================================
DO $$
BEGIN
    IF to_regclass('public.referral_config') IS NOT NULL THEN
        -- Reward = percentage of the initial qualifying deposit. ON CONFLICT DO
        -- NOTHING preserves an operator-configured live value (this table is the
        -- runtime source of truth for both server.js and the DB functions).
        INSERT INTO public.referral_config (config_key, config_value, description)
        VALUES ('referral_reward_percent', '20',
                'Referral reward as a percentage of the referred user''s initial qualifying deposit')
        ON CONFLICT (config_key) DO NOTHING;

        -- The final model has no fixed amount and no downline commission, so the
        -- obsolete keys are deleted rather than left to be misread.
        DELETE FROM public.referral_config
         WHERE config_key IN ('referral_reward_amount', 'referral_profit_commission_rate');
    END IF;
END $$;

-- ============================================
-- 2. REMOVE THE OBSOLETE COMMISSION ARCHITECTURE
-- ============================================
-- Drop by resolved signature (tolerant of any earlier revision's argument list).
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'credit_referral_commission_safe'
    LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig;
    END LOOP;
END $$;

DROP TABLE IF EXISTS public.referral_commissions;

-- ============================================
-- 3. VERIFICATION (read-only; raises on drift)
-- ============================================
DO $$
BEGIN
    IF to_regclass('public.referral_config') IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.referral_config WHERE config_key = 'referral_reward_percent'
        ) THEN
            RAISE EXCEPTION '020 verification failed: referral_reward_percent config missing';
        END IF;

        IF EXISTS (
            SELECT 1 FROM public.referral_config
             WHERE config_key IN ('referral_reward_amount', 'referral_profit_commission_rate')
        ) THEN
            RAISE EXCEPTION '020 verification failed: obsolete referral config keys still present';
        END IF;
    END IF;

    IF to_regclass('public.referral_commissions') IS NOT NULL THEN
        RAISE EXCEPTION '020 verification failed: obsolete referral_commissions ledger still present';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'credit_referral_commission_safe'
    ) THEN
        RAISE EXCEPTION '020 verification failed: obsolete credit_referral_commission_safe still present';
    END IF;

    RAISE NOTICE '020 complete: referral reward = 20%% of the initial qualifying deposit; commission architecture removed.';
END $$;

-- ============================================
-- ROLLBACK (reference only — restoring the obsolete model is NOT supported)
-- ============================================
-- DROP FUNCTION IF EXISTS public.credit_referral_commission_safe(...);
-- DELETE FROM public.referral_config WHERE config_key = 'referral_reward_percent';
-- ============================================
