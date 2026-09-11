-- ============================================
-- MIGRATION 024 — Remove the retired 10% downline-profit-share commission
--                 architecture (idempotent convergence step)
-- ============================================
-- FINAL management model: the referrer receives a ONE-TIME reward equal to 20%
-- of the referred user's INITIAL QUALIFYING DEPOSIT. There is NO 10% downline
-- profit-share commission.
--
-- WHY THIS MIGRATION EXISTS (in addition to the amended 020/022):
--   * Migrations 020 and 022 were AMENDED so a fresh install only ever creates
--     the final model (no commission table/RPC, no commission config key).
--   * A migration runner never re-runs an already-applied file, so an
--     environment that applied the EARLIER revision of 020/022 still holds the
--     retired objects AND the retired FUNCTION BODIES (award helper returning
--     numeric with a flat amount, sandbox config exposing reward_amount /
--     commission_rate). This migration removes the retired OBJECTS and then
--     VERIFIES the final function contract.
--
--   If the verification fails, the environment still has the retired bodies and
--   this migration RAISES with instructions: re-apply the amended migrations
--   020 -> 021 -> 022 -> 023 (all idempotent), then re-run 024. Failing loudly
--   is deliberate: silently keeping the retired bodies would break the JSONB
--   contract the server and the provider credit functions now rely on.
--
-- SCOPE: drops exactly four retired objects (if present), deletes the retired
-- config keys, and re-asserts the final config defaults. No other table,
-- function, row or grant is touched.
-- IDEMPOTENT: DROP ... IF EXISTS + guarded DO blocks; safe to re-run. The final
-- DO block RAISES if any retired object or stale function body survived.
-- ============================================

-- ============================================
-- 1. DROP THE RETIRED PRODUCTION COMMISSION OBJECTS
-- ============================================
-- Dropped by resolved signature so any earlier revision's argument list is
-- tolerated (the retired function had 6 arguments).
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
-- 2. DROP THE RETIRED SANDBOX COMMISSION OBJECTS
-- ============================================
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

-- ============================================
-- 3. REMOVE THE RETIRED CONFIG KEYS
-- ============================================
-- There is no fixed reward amount and no commission rate in the final model, so
-- leaving these rows behind would let stale configuration be misread.
DO $$
BEGIN
    IF to_regclass('public.referral_config') IS NOT NULL THEN
        DELETE FROM public.referral_config
         WHERE config_key IN ('referral_reward_amount', 'referral_profit_commission_rate');

        -- The final model's percentage key must exist (owned by migration 020).
        IF NOT EXISTS (
            SELECT 1 FROM public.referral_config WHERE config_key = 'referral_reward_percent'
        ) THEN
            INSERT INTO public.referral_config (config_key, config_value, description)
            VALUES ('referral_reward_percent', '20',
                    'Referral reward as a percentage of the referred user''s initial qualifying deposit')
            ON CONFLICT (config_key) DO NOTHING;
        END IF;
    END IF;
END $$;

-- ============================================
-- 4. VERIFICATION (read-only; raises on drift)
-- ============================================
DO $$
BEGIN
    IF to_regclass('public.referral_commissions') IS NOT NULL THEN
        RAISE EXCEPTION '024 verification failed: referral_commissions still present';
    END IF;
    IF to_regclass('public.sandbox_referral_commissions') IS NOT NULL THEN
        RAISE EXCEPTION '024 verification failed: sandbox_referral_commissions still present';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('credit_referral_commission_safe', 'sandbox_credit_referral_commission')
    ) THEN
        RAISE EXCEPTION '024 verification failed: a retired commission function is still present';
    END IF;
    IF to_regclass('public.referral_config') IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM public.referral_config
             WHERE config_key IN ('referral_reward_amount', 'referral_profit_commission_rate')
        ) THEN
            RAISE EXCEPTION '024 verification failed: retired referral config keys are still present';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.referral_config WHERE config_key = 'referral_reward_percent'
        ) THEN
            RAISE EXCEPTION '024 verification failed: referral_reward_percent is missing';
        END IF;
    END IF;

    -- FINAL FUNCTION CONTRACT. An environment that applied the earlier revision
    -- of 021/022 still carries the retired bodies (numeric/flat-amount award,
    -- reward_amount/commission_rate sandbox config) because applied migrations
    -- are never re-run. Detect that here instead of failing later at runtime.
    IF to_regprocedure('public.award_referral_qualification_safe(BIGINT, DECIMAL)') IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'award_referral_qualification_safe'
               AND pg_get_function_result(p.oid) = 'jsonb'
               AND pg_get_functiondef(p.oid) LIKE '%referral_reward_percent%'
        ) THEN
            RAISE EXCEPTION '024 verification failed: stale award_referral_qualification_safe body (expected JSONB + referral_reward_percent). Re-apply the amended migrations 020 -> 021 -> 022 -> 023 (all idempotent), then re-run 024.';
        END IF;
    END IF;

    IF to_regprocedure('public.sandbox_referral_config()') IS NOT NULL THEN
        IF (public.sandbox_referral_config() ? 'reward_amount')
           OR NOT (public.sandbox_referral_config() ? 'reward_percent') THEN
            RAISE EXCEPTION '024 verification failed: stale sandbox_referral_config body (expected reward_percent). Re-apply the amended migrations 020 -> 021 -> 022 -> 023 (all idempotent), then re-run 024.';
        END IF;
    END IF;

    RAISE NOTICE '024 complete: retired 10%% commission architecture removed; referral reward = 20%% of the initial qualifying deposit.';
END $$;

-- ============================================
-- ROLLBACK (reference only — the retired model is NOT restorable)
-- ============================================
