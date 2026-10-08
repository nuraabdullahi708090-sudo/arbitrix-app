-- ============================================================================
-- 037_referral_payout_paid_requires_reference.sql
--
-- Referral Partner payouts: a payout may NOT transition to PAID without a real
-- payment transaction reference.
--
-- AUDIT FIX: previously an admin could mark a payout PAID with an empty/NULL
-- tx_reference. The UPDATE used
--   tx_reference = COALESCE(NULLIF(btrim(COALESCE(p_tx_reference, '')), ''), tx_reference)
-- so an empty input silently KEPT the old value (which could itself be NULL) and
-- the payout still became PAID + paid_at. This migration re-creates
-- public.update_referral_payout_safe() so a PAID transition REQUIRES a non-empty
-- reference: null / undefined / empty string / whitespace-only are all rejected
-- with {"success": false, "error": "tx_reference_required"} under the existing
-- row lock. The value is TRIMMED before it is stored, and any non-empty format
-- is accepted (no blockchain-hash format requirement).
--
-- Everything else is byte-for-byte the 034 behaviour: the FOR UPDATE row lock,
-- the terminal-state guards (already_paid / already_rejected), the
-- refund-exactly-once-on-rejection, the manager/note/paid_at/reviewed_at writes
-- and the JSONB return shape. No table, column, index or policy is changed and
-- no business rule changes (20% reward, $100 qualifying deposit, first
-- qualifying deposit only, no minimum payout, no trading requirement,
-- USDT/TRC20 only, manual process).
--
-- ADDITIVE + IDEMPOTENT (CREATE OR REPLACE). 034 remains the base migration;
-- this file only overrides the update RPC.
--
-- DEPENDENCIES: 034 (referral_payouts + update_referral_payout_safe).
-- ============================================================================

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

    -- AUDIT FIX: a payout MUST carry a real payment reference before it can be
    -- marked PAID. Reject null / empty / whitespace-only (any non-empty format
    -- is accepted).
    IF v_status = 'PAID' AND NULLIF(btrim(COALESCE(p_tx_reference, '')), '') IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'tx_reference_required');
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
           -- The reference is trimmed; for a PAID transition it is guaranteed
           -- non-empty by the guard above.
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
-- EXECUTE LOCKDOWN (unchanged: service_role only)
-- ============================================
REVOKE EXECUTE ON FUNCTION public.update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT) TO service_role;

-- ============================================
-- VERIFICATION (read-only; raises on drift)
-- ============================================
DO $$
BEGIN
    IF to_regprocedure('public.update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT)') IS NULL THEN
        RAISE EXCEPTION 'update_referral_payout_safe() is missing!';
    END IF;
    IF pg_get_functiondef('public.update_referral_payout_safe(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT)'::regprocedure)
         NOT LIKE '%tx_reference_required%' THEN
        RAISE EXCEPTION 'update_referral_payout_safe() is missing the PAID tx-reference guard!';
    END IF;
END $$;
