-- ============================================
-- MIGRATION 034 - REFERRAL PARTNER PAYOUT WORKFLOW
--                 (manual payouts, no automated crypto)
--                 Idempotent, additive.
-- ============================================
-- MANAGEMENT DECISION IMPLEMENTED HERE:
--   Referral partners may request a payout of their genuinely earned referral
--   earnings. A human payment manager verifies the payout OFF-PLATFORM and
--   sends the crypto manually, then records the payment details. There is NO
--   automated crypto payout anywhere in this migration or its callers.
--
-- EXISTING BUSINESS RULES PRESERVED (not touched here):
--   * one-time 20% referral reward (referral_config.referral_reward_percent)
--   * reward is based on the referred user's INITIAL qualifying deposit
--   * minimum qualifying deposit $100 (referral_config.minimum_qualifying_deposit)
--   * registration alone never qualifies a referral
--   * no recurring commission, no tiers
--   This migration only adds a way to PAY OUT earnings that already exist in
--   wallets.bonus_balance; it does not calculate or mint any reward.
--
-- WHAT THIS MIGRATION DOES (nothing else)
--   1. CREATE public.referral_payouts (append/state table) with RLS enabled and
--      a service_role-only policy (no anon/authenticated access).
--   2. CREATE public.request_referral_payout_safe(user, wallet_address, key):
--      idempotency check -> FOR UPDATE wallet lock -> double-check -> refuse a
--      second OPEN payout -> available = min(bonus_balance, genuine active
--      rewards) -> debit bonus_balance -> insert a PENDING payout row. Atomic.
--   3. CREATE public.update_referral_payout_safe(payout_id, status, paid_amount,
--      tx_reference, manager_id, note): FOR UPDATE the payout row, validate the
--      lifecycle transition, refund the reserved amount on REJECTED (exactly
--      once), and record paid_amount/tx_reference/manager/timestamps.
--   4. Execute lockdown (service_role only) + a read-only verification block.
--
-- PAYOUT LIFECYCLE: PENDING -> UNDER_REVIEW -> PAID
--                   PENDING/UNDER_REVIEW -> REJECTED (reserved amount refunded)
--                   PAID / REJECTED are terminal.
--
-- WHAT IT DOES NOT DO
--   * No change to referrals / wallets / users / deposits / withdrawals /
--     transactions structure, no reward calculation, no commission.
--   * No automated crypto transfer / provider call / blockchain interaction.
--   * No change to the platform $100 minimum deposit or the withdrawal minimum.
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP POLICY IF EXISTS, REVOKE+GRANT are safe to re-run; the final DO block
-- RAISES on drift.
--
-- DEPENDENCIES: 002 (wallets), 013 (users.environment), 018/014 (RLS + execute).
-- APPLY ORDER: after 020/023 (referral config + earnings bucket).
-- ============================================

-- ============================================
-- 1. PAYOUT REQUESTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.referral_payouts (
    id BIGSERIAL PRIMARY KEY,
    -- The referral partner requesting the payout.
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    -- Amount RESERVED from wallets.bonus_balance when the request was created.
    amount DECIMAL(18, 2) NOT NULL CHECK (amount > 0),
    -- Actual amount the payment manager reports as paid (may differ from the
    -- reserved amount; recorded by the manager on PAID).
    paid_amount DECIMAL(18, 2),
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'UNDER_REVIEW', 'PAID', 'REJECTED')),
    -- Destination the partner supplied (TRC20 wallet address).
    wallet_address TEXT NOT NULL,
    -- Payment transaction / hash / reference recorded by the manager.
    tx_reference TEXT,
    -- The admin/manager who processed the payout.
    manager_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    -- Free-form manager note.
    note TEXT,
    -- Caller action key: exactly-once per request.
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ
);

-- At most one OPEN payout per partner (enforced in the RPC too, this is the
-- DB-level backstop).
CREATE UNIQUE INDEX IF NOT EXISTS referral_payouts_one_open_per_user
    ON public.referral_payouts (user_id)
    WHERE status IN ('PENDING', 'UNDER_REVIEW');

CREATE INDEX IF NOT EXISTS idx_referral_payouts_user
    ON public.referral_payouts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_referral_payouts_status
    ON public.referral_payouts (status, created_at DESC);

COMMENT ON TABLE public.referral_payouts IS
    'Referral partner payout requests. Earnings are reserved (debited from bonus_balance) on request and refunded on rejection. Payouts are paid manually off-platform; this table only records the workflow.';

ALTER TABLE public.referral_payouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "referral_payouts_service_all" ON public.referral_payouts;
CREATE POLICY "referral_payouts_service_all" ON public.referral_payouts
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);
REVOKE ALL ON public.referral_payouts FROM anon;
REVOKE ALL ON public.referral_payouts FROM authenticated;

-- ============================================
-- 2. REQUEST A PAYOUT (reserves earnings atomically)
-- ============================================
-- Guarantees (mirroring convert_referral_earnings_safe):
--   1) validate inputs
--   2) idempotency check BEFORE the lock (replay -> duplicate)
--   3) SELECT ... FOR UPDATE on the wallet
--   4) double-check idempotency AFTER the lock
--   5) refuse when an OPEN payout already exists
--   6) available = LEAST(bonus_balance, SUM(active genuine rewards))
--      -> a pending/unqualified referral grants nothing, and the cap prevents
--         re-reserving earnings already withdrawn/converted
--   7) ONE wallet update reserves the amount (bonus_balance only)
--   8) insert a PENDING payout row
--   9) EXCEPTION handler returns JSON, never partial state
-- Refuses MARKETING_SANDBOX accounts (they have no referral-earnings bucket).
CREATE OR REPLACE FUNCTION public.request_referral_payout_safe(
    p_user_id BIGINT,
    p_wallet_address TEXT,
    p_idempotency_key TEXT
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
    v_new_bonus DECIMAL;
    v_payout_id BIGINT;
    v_address TEXT;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_user');
    END IF;
    IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_idempotency_key');
    END IF;
    v_address := btrim(COALESCE(p_wallet_address, ''));
    IF length(v_address) < 10 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_address');
    END IF;
    IF length(v_address) > 200 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_address');
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
            'bonus_balance', ROUND(COALESCE(v_wallet.bonus_balance, 0), 2));
    END IF;

    -- 6. Reserve the amount: one wallet row, bonus_balance only.
    v_new_bonus := ROUND(COALESCE(v_wallet.bonus_balance, 0) - v_available, 2);
    UPDATE public.wallets
       SET bonus_balance = v_new_bonus,
           updated_at = NOW()
     WHERE user_id = p_user_id;

    INSERT INTO public.referral_payouts
        (user_id, amount, status, wallet_address, idempotency_key)
    VALUES (p_user_id, v_available, 'PENDING', v_address, p_idempotency_key)
    RETURNING id INTO v_payout_id;

    RETURN jsonb_build_object('success', true, 'duplicate', false,
        'payout_id', v_payout_id,
        'amount', v_available,
        'status', 'PENDING',
        'bonus_balance', v_new_bonus);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ============================================
-- 3. UPDATE A PAYOUT (manager lifecycle + reject refund)
-- ============================================
CREATE OR REPLACE FUNCTION public.update_referral_payout_safe(
    p_payout_id BIGINT,
    p_status TEXT,
    p_paid_amount DECIMAL DEFAULT NULL,
    p_tx_reference TEXT DEFAULT NULL,
    p_manager_id BIGINT DEFAULT NULL,
    p_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_payout public.referral_payouts%ROWTYPE;
    v_status TEXT;
    v_paid DECIMAL;
    v_refund DECIMAL;
BEGIN
    IF p_payout_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_payout');
    END IF;
    v_status := upper(btrim(COALESCE(p_status, '')));
    IF v_status NOT IN ('PENDING', 'UNDER_REVIEW', 'PAID', 'REJECTED') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_status');
    END IF;

    SELECT * INTO v_payout FROM public.referral_payouts WHERE id = p_payout_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'payout_not_found');
    END IF;

    IF v_payout.status = 'PAID' THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_paid');
    END IF;
    IF v_payout.status = 'REJECTED' THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_rejected');
    END IF;

    -- Refund the reserved earnings exactly once when a payout is rejected.
    IF v_status = 'REJECTED' THEN
        v_refund := ROUND(COALESCE(v_payout.amount, 0), 2);
        IF v_refund > 0 THEN
            UPDATE public.wallets
               SET bonus_balance = ROUND(COALESCE(bonus_balance, 0) + v_refund, 2),
                   updated_at = NOW()
             WHERE user_id = v_payout.user_id;
        END IF;
    END IF;

    v_paid := CASE
        WHEN p_paid_amount IS NULL THEN v_payout.paid_amount
        WHEN p_paid_amount < 0 THEN NULL
        ELSE ROUND(p_paid_amount, 2)
    END;
    IF v_status = 'PAID' AND v_paid IS NULL THEN
        v_paid := ROUND(COALESCE(v_payout.amount, 0), 2);
    END IF;

    UPDATE public.referral_payouts
       SET status = v_status,
           paid_amount = v_paid,
           tx_reference = COALESCE(NULLIF(btrim(COALESCE(p_tx_reference, '')), ''), tx_reference),
           manager_id = COALESCE(p_manager_id, manager_id),
           note = COALESCE(NULLIF(btrim(COALESCE(p_note, '')), ''), note),
           reviewed_at = CASE WHEN v_status IN ('UNDER_REVIEW', 'REJECTED')
                              THEN COALESCE(reviewed_at, NOW()) ELSE reviewed_at END,
           paid_at = CASE WHEN v_status = 'PAID' THEN NOW() ELSE paid_at END,
           updated_at = NOW()
     WHERE id = p_payout_id;

    RETURN jsonb_build_object('success', true,
        'payout_id', p_payout_id,
        'status', v_status,
        'amount', ROUND(COALESCE(v_payout.amount, 0), 2),
        'paid_amount', v_paid,
        'refunded', CASE WHEN v_status = 'REJECTED' THEN ROUND(COALESCE(v_payout.amount, 0), 2) ELSE 0 END);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ============================================
-- 4. EXECUTE LOCKDOWN (service_role only)
-- ============================================
REVOKE EXECUTE ON FUNCTION public.request_referral_payout_safe(BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.request_referral_payout_safe(BIGINT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.request_referral_payout_safe(BIGINT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.request_referral_payout_safe(BIGINT, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT) TO service_role;

-- ============================================
-- 5. VERIFICATION (read-only; raises on drift)
-- ============================================
DO $$
BEGIN
    IF to_regclass('public.referral_payouts') IS NULL THEN
        RAISE EXCEPTION 'referral_payouts table was not created!';
    END IF;
    IF to_regprocedure('public.request_referral_payout_safe(BIGINT, TEXT, TEXT)') IS NULL THEN
        RAISE EXCEPTION 'request_referral_payout_safe() was not created!';
    END IF;
    IF to_regprocedure('public.update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT)') IS NULL THEN
        RAISE EXCEPTION 'update_referral_payout_safe() was not created!';
    END IF;

    -- RLS must be enabled and there must be NO anon/authenticated policy.
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

    RAISE NOTICE 'Migration 034 applied: referral partner payout workflow (manual payouts).';
END $$;
