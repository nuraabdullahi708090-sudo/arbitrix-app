-- ============================================
-- MIGRATION 036 - SANDBOX REFERRAL PAYOUTS (MARKETING_SANDBOX ONLY)
--                 Additive, idempotent, self-checking. Simulated money only.
-- ============================================
-- PURPOSE
--   Let a MARKETING_SANDBOX partner demonstrate the COMPLETE referral-partner
--   payout workflow (request -> UNDER_REVIEW -> manager records a SIMULATED
--   reference -> PAID) without ever touching production tables, balances,
--   deposits, withdrawals or public.referral_payouts.
--
-- WHAT THIS MIGRATION DOES (sandbox_* only)
--   1. Adds sandbox_wallets.referral_earnings - a SIMULATED earnings bucket,
--      kept SEPARATE from the simulated trading balance, mirroring production
--      (a referral reward credits the earnings bucket, not the trading balance).
--   2. Re-creates sandbox_award_referral_qualification() so a referral reward
--      credits referral_earnings; the simulated trading balance is UNTOUCHED.
--   3. Creates public.sandbox_referral_payouts (the simulated payout queue).
--   4. Adds sandbox_request_referral_payout_safe() and
--      sandbox_update_referral_payout_safe() (request -> UNDER_REVIEW ->
--      PAID / REJECTED, with an exactly-once refund of the reserved earnings).
--   5. Extends sandbox_reset_account() to clear the payout rows and zero the
--      simulated earnings, so the demo is deterministic and repeatable.
--
-- PRESERVED: the 20% reward, the $100 platform minimum qualifying deposit, the
--   USDT/TRC20 launch asset restriction (enforced in the API via PAYOUT_ASSETS),
--   and the fact that payouts are MANUAL - an admin records a SIMULATED
--   reference; there is NO blockchain transfer.
--
-- ISOLATION: every object is sandbox_*; every RPC begins with
--   assert_sandbox_user(); payout rows carry is_simulated=true and
--   environment='MARKETING_SANDBOX'. public.referral_payouts and every other
--   production table/RPC are UNCHANGED by this file.
--
-- DEPENDENCIES: 013 (sandbox tables + asserts), 022 (sandbox referral program).
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, guarded
--   constraint creation, CREATE OR REPLACE FUNCTION; the final DO block RAISES
--   on drift.
-- ============================================

-- ============================================
-- 1. SIMULATED REFERRAL-EARNINGS BUCKET
-- ============================================
ALTER TABLE public.sandbox_wallets
    ADD COLUMN IF NOT EXISTS referral_earnings DECIMAL(18, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sandbox_wallets_referral_earnings_nonneg') THEN
        ALTER TABLE public.sandbox_wallets
            ADD CONSTRAINT sandbox_wallets_referral_earnings_nonneg
            CHECK (referral_earnings >= 0);
    END IF;
END $$;

COMMENT ON COLUMN public.sandbox_wallets.referral_earnings IS
    'SIMULATED referral-earnings bucket, separate from the simulated trading balance. Zero real value.';

-- ============================================
-- 2. SIMULATED PAYOUT QUEUE
-- ============================================
CREATE TABLE IF NOT EXISTS public.sandbox_referral_payouts (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    -- Amount reserved from sandbox_wallets.referral_earnings at request time.
    amount DECIMAL(18, 2) NOT NULL CHECK (amount > 0),
    -- Simulated amount the manager reports as paid.
    paid_amount DECIMAL(18, 2),
    status TEXT NOT NULL DEFAULT 'UNDER_REVIEW'
        CHECK (status IN ('PENDING', 'UNDER_REVIEW', 'PAID', 'REJECTED')),
    wallet_address TEXT NOT NULL,
    coin TEXT NOT NULL DEFAULT 'USDT',
    network TEXT NOT NULL DEFAULT 'TRC20',
    -- SIMULATED payment reference recorded by the manager. Never a real tx.
    tx_reference TEXT,
    note TEXT,
    manager_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    is_simulated BOOLEAN NOT NULL DEFAULT true CHECK (is_simulated),
    environment TEXT NOT NULL DEFAULT 'MARKETING_SANDBOX' CHECK (environment = 'MARKETING_SANDBOX'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sandbox_referral_payouts_user
    ON public.sandbox_referral_payouts(user_id, created_at DESC);

ALTER TABLE public.sandbox_referral_payouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sandbox_referral_payouts FROM PUBLIC;
REVOKE ALL ON public.sandbox_referral_payouts FROM anon;
REVOKE ALL ON public.sandbox_referral_payouts FROM authenticated;
GRANT ALL ON public.sandbox_referral_payouts TO service_role;
DROP POLICY IF EXISTS sandbox_referral_payouts_service_all ON public.sandbox_referral_payouts;
CREATE POLICY sandbox_referral_payouts_service_all
    ON public.sandbox_referral_payouts FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.sandbox_referral_payouts IS
    'SIMULATED referral-partner payouts (MARKETING_SANDBOX only). Never production money.';

-- ============================================
-- 3. AWARD CREDITS THE SIMULATED EARNINGS BUCKET
-- ============================================
-- Same guards as 022 (minimum deposit, percent reward, exactly-once, row lock,
-- env-asserted). Only the credit target changes: referral_earnings instead of
-- the simulated trading balance, so a payout debits EARNINGS (production
-- parity) and the trader demo balance is never conflated with referral income.
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
    v_new_earnings DECIMAL;
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

    v_reward := ROUND(p_deposit_amount * v_percent / 100.0, 2);
    IF v_reward <= 0 THEN
        RETURN jsonb_build_object('success', false, 'reason', 'no_reward');
    END IF;

    SELECT * INTO v_ref FROM public.sandbox_referrals
    WHERE referred_id = p_referred_id AND status = 'pending' AND bonus_earned = 0
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'reason', 'no_pending_referral');
    END IF;

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
    v_new_earnings := ROUND(COALESCE(v_wallet.referral_earnings, 0) + v_reward, 2);
    UPDATE public.sandbox_wallets
    SET referral_earnings = v_new_earnings, updated_at = NOW()
    WHERE user_id = v_ref.referrer_id;

    INSERT INTO public.sandbox_transactions (user_id, type, amount, detail)
    VALUES (v_ref.referrer_id, 'Referral Bonus', v_reward,
        'SIMULATED referral bonus (qualifying deposit)');

    RETURN jsonb_build_object('success', true,
        'referrer_id', v_ref.referrer_id,
        'referred_id', p_referred_id,
        'bonus_amount', v_reward,
        'new_earnings', v_new_earnings,
        'new_balance', v_wallet.balance);

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ============================================
-- 4. REQUEST A SIMULATED PAYOUT (no minimum)
-- ============================================
CREATE OR REPLACE FUNCTION public.sandbox_request_referral_payout_safe(
    p_user_id BIGINT,
    p_wallet_address TEXT,
    p_idempotency_key TEXT,
    p_amount DECIMAL DEFAULT NULL,
    p_coin TEXT DEFAULT 'USDT',
    p_network TEXT DEFAULT 'TRC20'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_wallet public.sandbox_wallets%ROWTYPE;
    v_existing public.sandbox_referral_payouts%ROWTYPE;
    v_open_id BIGINT;
    v_available DECIMAL;
    v_requested DECIMAL;
    v_new_earnings DECIMAL;
    v_payout_id BIGINT;
    v_address TEXT;
    v_coin TEXT;
    v_network TEXT;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_user');
    END IF;
    IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_idempotency_key');
    END IF;
    v_address := btrim(COALESCE(p_wallet_address, ''));
    IF length(v_address) < 10 OR length(v_address) > 200 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_address');
    END IF;
    v_coin := upper(btrim(COALESCE(NULLIF(p_coin, ''), 'USDT')));
    v_network := upper(btrim(COALESCE(NULLIF(p_network, ''), 'TRC20')));
    IF length(v_coin) > 20 OR length(v_network) > 20 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_asset');
    END IF;

    -- Isolation: only a MARKETING_SANDBOX account may hold simulated payouts.
    PERFORM public.assert_sandbox_user(p_user_id);

    -- 1. Idempotency check BEFORE the lock.
    SELECT * INTO v_existing FROM public.sandbox_referral_payouts
     WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'duplicate', true,
            'payout_id', v_existing.id, 'amount', v_existing.amount, 'status', v_existing.status);
    END IF;

    -- 2. Lock the simulated wallet row.
    v_wallet := public.sandbox_ensure_wallet(p_user_id);
    SELECT * INTO v_wallet FROM public.sandbox_wallets WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'wallet_not_found');
    END IF;

    -- 3. Double-check idempotency AFTER the lock.
    SELECT * INTO v_existing FROM public.sandbox_referral_payouts
     WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'duplicate', true,
            'payout_id', v_existing.id, 'amount', v_existing.amount, 'status', v_existing.status);
    END IF;

    -- 4. One open payout at a time.
    SELECT id INTO v_open_id FROM public.sandbox_referral_payouts
     WHERE user_id = p_user_id AND status IN ('PENDING', 'UNDER_REVIEW')
     LIMIT 1;
    IF v_open_id IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'reason', 'payout_already_open',
            'payout_id', v_open_id);
    END IF;

    -- 5. Available = the simulated earnings bucket (nothing else).
    v_available := ROUND(COALESCE(v_wallet.referral_earnings, 0), 2);
    IF v_available <= 0 THEN
        RETURN jsonb_build_object('success', false, 'reason', 'no_referral_earnings',
            'available', 0);
    END IF;

    -- 6. Requested amount. NO MINIMUM (mirrors production).
    v_requested := ROUND(COALESCE(p_amount, v_available), 2);
    IF v_requested <= 0 THEN
        RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount',
            'available', v_available);
    END IF;
    IF v_requested > v_available THEN
        RETURN jsonb_build_object('success', false, 'reason', 'amount_exceeds_available',
            'available', v_available);
    END IF;

    -- 7. Reserve ONLY the requested amount from EARNINGS (balance untouched).
    v_new_earnings := ROUND(v_available - v_requested, 2);
    UPDATE public.sandbox_wallets
       SET referral_earnings = v_new_earnings, updated_at = NOW()
     WHERE user_id = p_user_id;

    INSERT INTO public.sandbox_referral_payouts
        (user_id, amount, status, wallet_address, coin, network, idempotency_key)
    VALUES (p_user_id, v_requested, 'UNDER_REVIEW', v_address, v_coin, v_network, p_idempotency_key)
    RETURNING id INTO v_payout_id;

    RETURN jsonb_build_object('success', true, 'duplicate', false,
        'payout_id', v_payout_id,
        'amount', v_requested,
        'status', 'UNDER_REVIEW',
        'coin', v_coin,
        'network', v_network,
        'referral_earnings', v_new_earnings);

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ============================================
-- 5. MANAGER UPDATE (record simulated payment / reject)
-- ============================================
CREATE OR REPLACE FUNCTION public.sandbox_update_referral_payout_safe(
    p_payout_id BIGINT,
    p_status TEXT,
    p_paid_amount DECIMAL,
    p_tx_reference TEXT,
    p_manager_id BIGINT,
    p_note TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_payout public.sandbox_referral_payouts%ROWTYPE;
    v_status TEXT;
    v_wallet public.sandbox_wallets%ROWTYPE;
    v_new_earnings DECIMAL;
    v_tx TEXT;
BEGIN
    IF p_payout_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_payout');
    END IF;
    v_status := upper(btrim(COALESCE(p_status, '')));
    IF v_status NOT IN ('PENDING', 'UNDER_REVIEW', 'PAID', 'REJECTED') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_status');
    END IF;

    SELECT * INTO v_payout FROM public.sandbox_referral_payouts WHERE id = p_payout_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'payout_not_found');
    END IF;

    PERFORM public.assert_sandbox_user(v_payout.user_id);

    IF v_payout.status = 'PAID' THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_paid');
    END IF;
    IF v_payout.status = 'REJECTED' THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_rejected');
    END IF;

    IF v_status = 'REJECTED' THEN
        -- Refund the reserved simulated earnings exactly once (row is locked
        -- and the status guard above prevents a second refund).
        SELECT * INTO v_wallet FROM public.sandbox_wallets
         WHERE user_id = v_payout.user_id FOR UPDATE;
        v_new_earnings := ROUND(COALESCE(v_wallet.referral_earnings, 0) + v_payout.amount, 2);
        UPDATE public.sandbox_wallets
           SET referral_earnings = v_new_earnings, updated_at = NOW()
         WHERE user_id = v_payout.user_id;
        UPDATE public.sandbox_referral_payouts
           SET status = 'REJECTED',
               note = COALESCE(NULLIF(btrim(COALESCE(p_note, '')), ''), note),
               manager_id = p_manager_id,
               reviewed_at = COALESCE(reviewed_at, NOW()),
               updated_at = NOW()
         WHERE id = p_payout_id;
        RETURN jsonb_build_object('success', true, 'payout_id', p_payout_id,
            'status', 'REJECTED', 'refunded', v_payout.amount, 'referral_earnings', v_new_earnings);
    END IF;

    IF v_status = 'PAID' THEN
        v_tx := NULLIF(btrim(COALESCE(p_tx_reference, '')), '');
        UPDATE public.sandbox_referral_payouts
           SET status = 'PAID',
               paid_amount = COALESCE(p_paid_amount, amount),
               tx_reference = v_tx,
               manager_id = p_manager_id,
               note = COALESCE(NULLIF(btrim(COALESCE(p_note, '')), ''), note),
               reviewed_at = COALESCE(reviewed_at, NOW()),
               paid_at = NOW(),
               updated_at = NOW()
         WHERE id = p_payout_id;
        RETURN jsonb_build_object('success', true, 'payout_id', p_payout_id,
            'status', 'PAID', 'paid_amount', COALESCE(p_paid_amount, v_payout.amount),
            'tx_reference', v_tx);
    END IF;

    -- PENDING / UNDER_REVIEW (review step)
    UPDATE public.sandbox_referral_payouts
       SET status = v_status,
           manager_id = COALESCE(p_manager_id, manager_id),
           note = COALESCE(NULLIF(btrim(COALESCE(p_note, '')), ''), note),
           reviewed_at = COALESCE(reviewed_at, NOW()),
           updated_at = NOW()
     WHERE id = p_payout_id;
    RETURN jsonb_build_object('success', true, 'payout_id', p_payout_id, 'status', v_status);

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ============================================
-- 6. EXECUTE LOCKDOWN (service_role only)
-- ============================================
REVOKE ALL ON FUNCTION public.sandbox_award_referral_qualification(BIGINT, DECIMAL) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sandbox_request_referral_payout_safe(BIGINT, TEXT, TEXT, DECIMAL, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sandbox_update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sandbox_award_referral_qualification(BIGINT, DECIMAL) FROM anon;
REVOKE ALL ON FUNCTION public.sandbox_request_referral_payout_safe(BIGINT, TEXT, TEXT, DECIMAL, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.sandbox_update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.sandbox_award_referral_qualification(BIGINT, DECIMAL) FROM authenticated;
REVOKE ALL ON FUNCTION public.sandbox_request_referral_payout_safe(BIGINT, TEXT, TEXT, DECIMAL, TEXT, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.sandbox_update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sandbox_award_referral_qualification(BIGINT, DECIMAL) TO service_role;
GRANT EXECUTE ON FUNCTION public.sandbox_request_referral_payout_safe(BIGINT, TEXT, TEXT, DECIMAL, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sandbox_update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT) TO service_role;

-- ============================================
-- 7. RESET (deterministic replay)
-- ============================================
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
    DELETE FROM public.sandbox_referral_payouts WHERE user_id = p_user_id;
    DELETE FROM public.sandbox_referrals
        WHERE referrer_id = p_user_id OR referred_id = p_user_id;

    INSERT INTO public.sandbox_wallets (user_id, balance, referral_earnings, intro_day, badge_hidden)
    VALUES (p_user_id, 0, 0, 1, false)
    ON CONFLICT (user_id) DO UPDATE
    SET balance = 0, referral_earnings = 0, intro_day = 1, badge_hidden = false, updated_at = NOW();

    RETURN jsonb_build_object('success', true, 'balance', 0, 'referral_earnings', 0, 'intro_day', 1);
END;
$$;

REVOKE ALL ON FUNCTION public.sandbox_reset_account(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sandbox_reset_account(BIGINT) FROM anon;
REVOKE ALL ON FUNCTION public.sandbox_reset_account(BIGINT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sandbox_reset_account(BIGINT) TO service_role;

-- ============================================
-- 8. VERIFICATION (read-only; raises on drift)
-- ============================================
DO $$
DECLARE
    v_missing TEXT := '';
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'sandbox_wallets' AND column_name = 'referral_earnings'
    ) THEN
        v_missing := v_missing || 'sandbox_wallets.referral_earnings ';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'sandbox_referral_payouts'
    ) THEN
        v_missing := v_missing || 'sandbox_referral_payouts ';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sandbox_request_referral_payout_safe') THEN
        v_missing := v_missing || 'sandbox_request_referral_payout_safe ';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sandbox_update_referral_payout_safe') THEN
        v_missing := v_missing || 'sandbox_update_referral_payout_safe ';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_class c
         WHERE c.relname = 'sandbox_referral_payouts' AND c.relrowsecurity = false
    ) THEN
        v_missing := v_missing || 'sandbox_referral_payouts RLS ';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'sandbox_wallets_referral_earnings_nonneg'
    ) THEN
        v_missing := v_missing || 'sandbox_wallets_referral_earnings_nonneg ';
    END IF;

    IF v_missing <> '' THEN
        RAISE EXCEPTION 'Migration 036 self-check failed: missing %', v_missing;
    END IF;

    RAISE NOTICE 'Migration 036 applied: sandbox referral payouts ready (simulated only).';
END $$;
