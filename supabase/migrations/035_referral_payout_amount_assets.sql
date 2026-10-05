-- ============================================
-- MIGRATION 035 - REFERRAL PARTNER PAYOUT: AMOUNT + COIN/NETWORK
--                 Idempotent, additive, manual payouts only.
-- ============================================
-- MANAGEMENT DECISION IMPLEMENTED HERE (final referral-partner policy):
--   * Referral earnings are SEPARATE from normal platform-user withdrawals.
--   * There is NO minimum referral payout (a partner may request $20 from one
--     qualifying referral).
--   * There is NO trading requirement for a referral payout.
--   * Normal platform withdrawal minimums/rules do NOT apply to referral payouts.
--   The existing 20% reward on the referred user's first qualifying deposit of
--   $100+ is UNCHANGED and is not touched by this migration.
--
-- WHAT THIS MIGRATION DOES (nothing else)
--   1. Adds `coin` and `network` to public.referral_payouts so the partner can
--      choose the asset/network they are paid in (starts with USDT TRC20/ERC20,
--      extendable later). Existing rows default to USDT / TRC20.
--   2. Replaces public.request_referral_payout_safe() with an extended version
--      that accepts an explicit payout amount (no minimum) plus coin/network.
--
-- PRESERVED (unchanged): self-referral prevention (referrals are created with
--   referred_id > 0 and referrer_id <> referred_id), duplicate-payout protection
--   (idempotency key + one OPEN payout per partner), confirmed-deposit protection
--   (available = minimum of the earnings bucket and ACTIVE, qualified referral
--   rewards), the FOR UPDATE wallet lock, the reject refund, RLS and the
--   service_role-only policy. No automated crypto transfer is implemented.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS, DROP FUNCTION IF EXISTS, CREATE OR
-- REPLACE FUNCTION, REVOKE+GRANT are safe to re-run; the final DO block RAISES
-- on drift.
--
-- DEPENDENCIES: 034 (referral_payouts + update_referral_payout_safe).
-- APPLY ORDER: after 034. Safe to apply before or after the matching app deploy
--   (the deployed server's 3-argument RPC call resolves to the new function via
--   its parameter defaults and keeps working).
-- ============================================

-- ============================================
-- 1. ASSET COLUMNS
-- ============================================
ALTER TABLE public.referral_payouts
    ADD COLUMN IF NOT EXISTS coin TEXT NOT NULL DEFAULT 'USDT';
ALTER TABLE public.referral_payouts
    ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'TRC20';

COMMENT ON COLUMN public.referral_payouts.coin IS
    'Payout currency requested by the partner (e.g. USDT).';
COMMENT ON COLUMN public.referral_payouts.network IS
    'Payout network requested by the partner (e.g. TRC20, ERC20).';

-- ============================================
-- 2. REQUEST A PAYOUT (partner-chosen amount, no minimum)
-- ============================================
-- The old 3-argument signature is removed so there is a SINGLE function (no
-- ambiguous overload). The new parameters carry DEFAULTs, so the currently
-- deployed server (which sends only the first three) keeps working unchanged.
DROP FUNCTION IF EXISTS public.request_referral_payout_safe(BIGINT, TEXT, TEXT);

-- Guarantees (mirroring the previous version):
--   1) validate inputs (user, key, address, asset, amount)
--   2) idempotency check BEFORE the lock (replay -> duplicate)
--   3) SELECT ... FOR UPDATE on the wallet
--   4) double-check idempotency AFTER the lock
--   5) refuse when an OPEN payout already exists
--   6) available = LEAST(bonus_balance, SUM(active genuine rewards))
--   7) requested = p_amount (NULL = full available); NO MINIMUM, must be > 0 and
--      <= available
--   8) ONE wallet update reserves ONLY the requested amount (bonus_balance only)
--   9) insert an UNDER_REVIEW payout row (the manual review queue)
--  10) EXCEPTION handler returns JSON, never partial state
-- Refuses MARKETING_SANDBOX accounts (they have no referral-earnings bucket).
CREATE OR REPLACE FUNCTION public.request_referral_payout_safe(
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
    v_wallet public.wallets%ROWTYPE;
    v_existing public.referral_payouts%ROWTYPE;
    v_open_id BIGINT;
    v_rewards DECIMAL;
    v_available DECIMAL;
    v_requested DECIMAL;
    v_new_bonus DECIMAL;
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

    -- Production only.
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
    SELECT * INTO v_existing FROM public.referral_payouts
     WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'duplicate', true,
            'payout_id', v_existing.id, 'amount', v_existing.amount,
            'status', v_existing.status);
    END IF;

    -- 2. Lock the wallet row (serialises concurrent requests).
    SELECT * INTO v_wallet FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'wallet_not_found');
    END IF;

    -- 3. Double-check idempotency AFTER the lock.
    SELECT * INTO v_existing FROM public.referral_payouts
     WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'duplicate', true,
            'payout_id', v_existing.id, 'amount', v_existing.amount,
            'status', v_existing.status);
    END IF;

    -- 4. One open payout at a time.
    SELECT id INTO v_open_id FROM public.referral_payouts
     WHERE user_id = p_user_id AND status IN ('PENDING', 'UNDER_REVIEW')
     LIMIT 1;
    IF v_open_id IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'reason', 'payout_already_open',
            'payout_id', v_open_id);
    END IF;

    -- 5. Available = genuine, active referral rewards capped by the bucket.
    BEGIN
        SELECT COALESCE(SUM(bonus_earned), 0) INTO v_rewards
          FROM public.referrals
         WHERE referrer_id = p_user_id AND status = 'active' AND referred_id > 0;
    EXCEPTION WHEN OTHERS THEN
        v_rewards := 0;
    END;
    v_available := ROUND(LEAST(COALESCE(v_wallet.bonus_balance, 0), COALESCE(v_rewards, 0)), 2);
    IF v_available <= 0 THEN
        RETURN jsonb_build_object('success', false, 'reason', 'no_referral_earnings',
            'amount', 0,
            'available', 0,
            'bonus_balance', ROUND(COALESCE(v_wallet.bonus_balance, 0), 2));
    END IF;

    -- 6. Requested amount. NO MINIMUM: any positive amount up to the available
    --    earnings is allowed (e.g. $20 from one qualifying referral). NULL means
    --    "pay the full available balance" (backward compatible).
    v_requested := ROUND(COALESCE(p_amount, v_available), 2);
    IF v_requested <= 0 THEN
        RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount',
            'available', v_available);
    END IF;
    IF v_requested > v_available THEN
        RETURN jsonb_build_object('success', false, 'reason', 'amount_exceeds_available',
            'available', v_available);
    END IF;

    -- 7. Reserve ONLY the requested amount: one wallet row, bonus_balance only.
    v_new_bonus := ROUND(COALESCE(v_wallet.bonus_balance, 0) - v_requested, 2);
    UPDATE public.wallets
       SET bonus_balance = v_new_bonus,
           updated_at = NOW()
     WHERE user_id = p_user_id;

    INSERT INTO public.referral_payouts
        (user_id, amount, status, wallet_address, coin, network, idempotency_key)
    VALUES (p_user_id, v_requested, 'UNDER_REVIEW', v_address, v_coin, v_network, p_idempotency_key)
    RETURNING id INTO v_payout_id;

    RETURN jsonb_build_object('success', true, 'duplicate', false,
        'payout_id', v_payout_id,
        'amount', v_requested,
        'status', 'UNDER_REVIEW',
        'coin', v_coin,
        'network', v_network,
        'bonus_balance', v_new_bonus);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ============================================
-- 3. EXECUTE LOCKDOWN (service_role only)
-- ============================================
REVOKE EXECUTE ON FUNCTION public.request_referral_payout_safe(BIGINT, TEXT, TEXT, DECIMAL, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.request_referral_payout_safe(BIGINT, TEXT, TEXT, DECIMAL, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.request_referral_payout_safe(BIGINT, TEXT, TEXT, DECIMAL, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.request_referral_payout_safe(BIGINT, TEXT, TEXT, DECIMAL, TEXT, TEXT) TO service_role;

-- ============================================
-- 4. VERIFICATION (read-only; raises on drift)
-- ============================================
DO $$
BEGIN
    IF to_regprocedure('public.request_referral_payout_safe(BIGINT, TEXT, TEXT, DECIMAL, TEXT, TEXT)') IS NULL THEN
        RAISE EXCEPTION 'request_referral_payout_safe() v2 was not created!';
    END IF;
    IF to_regprocedure('public.request_referral_payout_safe(BIGINT, TEXT, TEXT)') IS NOT NULL THEN
        RAISE EXCEPTION 'the old 3-argument request_referral_payout_safe() still exists!';
    END IF;
    IF to_regprocedure('public.update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT)') IS NULL THEN
        RAISE EXCEPTION 'update_referral_payout_safe() is missing!';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'referral_payouts' AND column_name = 'coin'
    ) THEN
        RAISE EXCEPTION 'referral_payouts.coin was not created!';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'referral_payouts' AND column_name = 'network'
    ) THEN
        RAISE EXCEPTION 'referral_payouts.network was not created!';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
         WHERE c.relname = 'referral_payouts' AND c.relrowsecurity = true
    ) THEN
        RAISE EXCEPTION 'referral_payouts RLS is not enabled!';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename = 'referral_payouts'
           AND roles::text IN ('{anon}', '{authenticated}')
    ) THEN
        RAISE EXCEPTION 'referral_payouts has an anon/authenticated policy!';
    END IF;

    RAISE NOTICE 'Migration 035 applied: referral payout amount + coin/network (no minimum).';
END $$;
