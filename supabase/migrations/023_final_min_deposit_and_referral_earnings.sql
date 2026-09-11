-- ============================================
-- MIGRATION 023 — FINAL management config: platform minimum deposit $100
--                 (+ server-authoritative referral-earnings conversion)
--                 Idempotent, additive.
-- ============================================
-- MANAGEMENT DECISIONS IMPLEMENTED HERE:
--   1. The platform minimum qualifying deposit is $100 (was $50). This is the
--      SAME value for PRODUCTION and MARKETING SANDBOX (both read the one
--      referral_config row / the same server constant). A referral therefore
--      only QUALIFIES on a >= $100 deposit; registration/onboarding never
--      qualifies. The final reward is a ONE-TIME 20% of that initial deposit
--      (referral_config.referral_reward_percent, seeded by migration 020) and
--      there is NO downline profit-share commission.
--   2. Referral earnings (the 20% rewards held in wallets.bonus_balance) must be
--      usable as trading capital through a SERVER-AUTHORITATIVE conversion. This
--      migration adds the ledger + convert_referral_earnings_safe() so the
--      conversion is atomic, idempotent, persisted, and can never double-convert,
--      create money, or touch the promotional credit / demo / unrelated balances.
--
-- WHAT THIS MIGRATION DOES (nothing else)
--   1. referral_config.minimum_qualifying_deposit: bump the platform default
--      50 -> 100 (an operator-customised value is left alone, mirroring the
--      020 convention); INSERT the row when missing. Re-assert the final reward
--      PERCENTAGE (referral_reward_percent = 20) idempotently. No fixed reward
--      amount and no commission rate exist in the final model.
--   2. CREATE public.referral_earning_conversions (append-only ledger) +
--      RLS/least-privilege (service_role only), matching migration 020/018.
--   3. CREATE public.convert_referral_earnings_safe(user, idempotency_key,
--      min_amount) — SECURITY DEFINER, mirrors the proven
--      credit_payment_safe()/convert-earnings pattern:
--      idempotency check -> FOR UPDATE wallet lock -> double-check -> validate
--      -> move bonus_balance -> live_balance atomically -> ledger row ->
--      transactions row. Refuses MARKETING_SANDBOX accounts (their simulated
--      earnings already sit in the tradable sandbox balance).
--   4. Re-assert the migration-014 execute lockdown (service_role only).
--
-- WHAT IT DOES NOT DO
--   * No column/table structure change to wallets/users/deposits/withdrawals/
--     transactions/referrals/referral_config.
--   * No change to crediting, duplicate protection, invoice state, withdrawal
--     sequence/minimum, KYC, MTA, subscriptions, sandbox tables or backstops.
--   * It does NOT touch the $50 promotional credit (wallets.live_balance seed).
--
-- IDEMPOTENT: guarded UPDATE / INSERT ... ON CONFLICT DO NOTHING / CREATE ...
-- IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS / REVOKE+GRANT are
-- all safe to re-run; the final DO block re-verifies and RAISES on drift.
--
-- DEPENDENCIES: 002 (wallets/transactions), 013 (users.environment),
--               014/018 (execute + RLS posture), 020 (referral reward config),
--               021 (referral award authority), 022 (sandbox referral parity).
-- APPLY ORDER: 020 -> 021 -> 022 -> 023 -> 024.
-- ============================================

-- ============================================
-- 1. PLATFORM MINIMUM QUALIFYING DEPOSIT -> $100
-- ============================================
DO $$
BEGIN
    IF to_regclass('public.referral_config') IS NOT NULL THEN
        -- Bump only the historical platform default (50 -> 100). An operator
        -- value that already differs from 50 is left untouched.
        UPDATE public.referral_config
           SET config_value = '100', updated_at = NOW()
         WHERE config_key = 'minimum_qualifying_deposit' AND config_value = '50';

        INSERT INTO public.referral_config (config_key, config_value, description)
        VALUES ('minimum_qualifying_deposit', '100', 'Minimum deposit amount required (USD)')
        ON CONFLICT (config_key) DO NOTHING;

        -- Re-assert the final referral economics (idempotent): a percentage of
        -- the initial qualifying deposit. The retired fixed-amount reward and
        -- commission-rate keys are removed by migration 020.
        INSERT INTO public.referral_config (config_key, config_value, description)
        VALUES ('referral_reward_percent', '20',
                'Referral reward as a percentage of the referred user''s initial qualifying deposit')
        ON CONFLICT (config_key) DO NOTHING;
    END IF;
END $$;

-- ============================================
-- 2. REFERRAL-EARNINGS CONVERSION LEDGER (append-only)
-- ============================================
CREATE TABLE IF NOT EXISTS public.referral_earning_conversions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    -- Referral earnings moved from bonus_balance to live_balance.
    amount DECIMAL(18, 2) NOT NULL,
    -- Authoritative balances immediately after the conversion.
    bonus_balance_after DECIMAL(18, 2) NOT NULL,
    live_balance_after DECIMAL(18, 2) NOT NULL,
    -- Caller action key: exactly-once per conversion attempt.
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_earning_conversions_user
    ON public.referral_earning_conversions(user_id, created_at DESC);

COMMENT ON TABLE public.referral_earning_conversions IS
    'Append-only ledger of referral-earnings -> tradable Live capital conversions. bonus_balance/live_balance are mutated atomically via convert_referral_earnings_safe().';

ALTER TABLE public.referral_earning_conversions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "referral_earning_conversions_service_all" ON public.referral_earning_conversions;
CREATE POLICY "referral_earning_conversions_service_all" ON public.referral_earning_conversions
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);
REVOKE ALL ON public.referral_earning_conversions FROM anon;
REVOKE ALL ON public.referral_earning_conversions FROM authenticated;

-- ============================================
-- 3. ATOMIC REFERRAL-EARNINGS CONVERSION FUNCTION
-- ============================================
-- Guarantees (mirroring credit_payment_safe / record_trade_safe):
--   1) validate inputs
--   2) idempotency check BEFORE the lock (replayed request -> duplicate)
--   3) SELECT ... FOR UPDATE on the user's wallet
--   4) double-check idempotency AFTER the lock (concurrent duplicate)
--   5) amount = the referral-earnings bucket (bonus_balance); 0 -> nothing to
--      convert; below the caller-supplied minimum -> refused (the app passes 0,
--      so referral earnings have NO conversion minimum in the final model)
--   6) ONE row update moves bonus_balance -> live_balance (no money created)
--   7) append ledger row + user-facing transactions row
--   8) EXCEPTION handler returns JSON, never partial state
-- It never reads or writes demo_balance, never lowers an existing live balance
-- (it only moves referral earnings IN), and refuses MARKETING_SANDBOX accounts.
CREATE OR REPLACE FUNCTION public.convert_referral_earnings_safe(
    p_user_id BIGINT,
    p_idempotency_key TEXT,
    p_min_amount DECIMAL DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_wallet public.wallets%ROWTYPE;
    v_existing public.referral_earning_conversions%ROWTYPE;
    v_amount DECIMAL;
    v_min DECIMAL;
    v_new_live DECIMAL;
    v_conversion_id BIGINT;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_user');
    END IF;
    IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_idempotency_key');
    END IF;
    v_min := CASE WHEN p_min_amount IS NULL OR p_min_amount < 0 THEN 0
                  ELSE ROUND(p_min_amount, 2) END;

    -- Production only: the sandbox has no referral-earnings bucket (its
    -- simulated referral income is credited straight to the tradable sandbox
    -- balance), so this conversion must never run for a sandbox account.
    BEGIN
        IF EXISTS (
            SELECT 1 FROM public.users
             WHERE id = p_user_id AND environment = 'MARKETING_SANDBOX'
        ) THEN
            RETURN jsonb_build_object('success', false, 'error', 'sandbox_account');
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL; -- users.environment absent (migration 013 not applied)
    END;

    -- 1. Idempotency check BEFORE the lock.
    SELECT * INTO v_existing FROM public.referral_earning_conversions
     WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'duplicate', true,
            'conversion_id', v_existing.id, 'amount', v_existing.amount,
            'bonus_balance', v_existing.bonus_balance_after,
            'live_balance', v_existing.live_balance_after);
    END IF;

    -- 2. Lock the wallet row (also serialises concurrent conversions).
    SELECT * INTO v_wallet FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'wallet_not_found');
    END IF;

    -- 3. Double-check idempotency AFTER the lock.
    SELECT * INTO v_existing FROM public.referral_earning_conversions
     WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'duplicate', true,
            'conversion_id', v_existing.id, 'amount', v_existing.amount,
            'bonus_balance', v_existing.bonus_balance_after,
            'live_balance', v_existing.live_balance_after);
    END IF;

    v_amount := ROUND(COALESCE(v_wallet.bonus_balance, 0), 2);
    IF v_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'reason', 'no_referral_earnings',
            'amount', 0,
            'bonus_balance', v_amount,
            'live_balance', ROUND(COALESCE(v_wallet.live_balance, 0), 2));
    END IF;
    IF v_amount < v_min THEN
        RETURN jsonb_build_object('success', false, 'reason', 'below_minimum',
            'minimum', v_min,
            'bonus_balance', v_amount,
            'live_balance', ROUND(COALESCE(v_wallet.live_balance, 0), 2));
    END IF;

    -- 4. Atomic move: referral earnings -> tradable Live capital. One row, one
    -- statement, no other balance column touched.
    v_new_live := ROUND(COALESCE(v_wallet.live_balance, 0) + v_amount, 2);
    UPDATE public.wallets
       SET bonus_balance = 0,
           live_balance = v_new_live,
           updated_at = NOW()
     WHERE user_id = p_user_id;

    INSERT INTO public.referral_earning_conversions
        (user_id, amount, bonus_balance_after, live_balance_after, idempotency_key)
    VALUES (p_user_id, v_amount, 0, v_new_live, p_idempotency_key)
    RETURNING id INTO v_conversion_id;

    INSERT INTO public.transactions (user_id, type, amount, detail, created_at)
    VALUES (p_user_id, 'Bonus Withdrawal', v_amount,
            'Bonus withdrawn to Live Wallet', NOW());

    RETURN jsonb_build_object('success', true, 'duplicate', false,
        'conversion_id', v_conversion_id,
        'amount', v_amount,
        'bonus_balance', 0,
        'live_balance', v_new_live);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ============================================
-- 4. EXECUTE LOCKDOWN (service_role only, matches migration 014/018)
-- ============================================
REVOKE EXECUTE ON FUNCTION public.convert_referral_earnings_safe(BIGINT, TEXT, DECIMAL) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.convert_referral_earnings_safe(BIGINT, TEXT, DECIMAL) FROM anon;
REVOKE EXECUTE ON FUNCTION public.convert_referral_earnings_safe(BIGINT, TEXT, DECIMAL) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.convert_referral_earnings_safe(BIGINT, TEXT, DECIMAL) TO service_role;

-- ============================================
-- 5. VERIFICATION (read-only; raises on drift)
-- ============================================
DO $$
DECLARE
    v_min TEXT;
BEGIN
    IF to_regclass('public.referral_earning_conversions') IS NULL THEN
        RAISE EXCEPTION 'referral_earning_conversions table was not created!';
    END IF;

    IF to_regprocedure('public.convert_referral_earnings_safe(BIGINT, TEXT, DECIMAL)') IS NULL THEN
        RAISE EXCEPTION 'convert_referral_earnings_safe() was not created!';
    END IF;

    IF to_regclass('public.referral_config') IS NOT NULL THEN
        SELECT config_value INTO v_min FROM public.referral_config
         WHERE config_key = 'minimum_qualifying_deposit';
        IF v_min IS NULL THEN
            RAISE EXCEPTION 'referral_config.minimum_qualifying_deposit is missing!';
        END IF;
        IF btrim(v_min) <> '100' THEN
            RAISE NOTICE 'referral_config.minimum_qualifying_deposit = % (operator-customised; platform default is 100)', v_min;
        END IF;

        -- Final model: a reward PERCENTAGE must exist, and the retired
        -- fixed-amount / commission-rate keys must be gone (removed by 020).
        IF NOT EXISTS (
            SELECT 1 FROM public.referral_config WHERE config_key = 'referral_reward_percent'
        ) THEN
            RAISE EXCEPTION 'referral_config.referral_reward_percent is missing!';
        END IF;
        IF EXISTS (
            SELECT 1 FROM public.referral_config
             WHERE config_key IN ('referral_reward_amount', 'referral_profit_commission_rate')
        ) THEN
            RAISE EXCEPTION 'retired referral config keys are still present!';
        END IF;
    END IF;

    RAISE NOTICE 'Migration 023 applied: platform minimum qualifying deposit $100 + referral-earnings conversion.';
END $$;
