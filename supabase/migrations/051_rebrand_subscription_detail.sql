-- 051_rebrand_subscription_detail.sql
--
-- Rebrand ONE customer-visible string inside an already-applied function.
--
-- WHY THIS EXISTS
--   charge_subscription_safe() (migration 011) writes the transaction detail
--   'Arbitrix Pro Subscription'. That text is what a customer reads in their
--   transaction history and what an admin CSV export contains, so it is a
--   branding asset that lives in the database rather than in the frontend.
--
-- WHAT IT CHANGES
--   Exactly one literal: 'Arbitrix Pro Subscription' -> 'Kalderix Pro Subscription'.
--   Everything else in the function - the idempotency check, the wallet row lock,
--   the balance gate, the atomic debit, the ledger insert, the billing dates, the
--   exception handler - is byte-identical to migration 011. There is no new
--   money path and no changed money behaviour, which is why this can be applied
--   without a billing review.
--
-- ALSO FIXES A GENUINE PRIVILEGE DEFECT (M2)
--   charge_subscription_safe was created by migration 011 and was NEVER added to
--   migration 014's EXECUTE lockdown (014 covers record_trade_safe,
--   credit_payment_safe and paymento_credit_user_safe only). PostgreSQL grants
--   EXECUTE on a new function to PUBLIC by default, so this SECURITY DEFINER
--   function - which debits wallets.live_balance for any p_user_id at any
--   p_price the caller chooses - was callable by `anon` and `authenticated`
--   through PostgREST. The body also ran with no pinned search_path, so an
--   unqualified reference (wallets, subscriptions, transactions) could be
--   hijacked from a schema earlier in the path.
--
--   This file therefore also:
--     - pins SET search_path = public, pg_temp;
--     - REVOKEs EXECUTE from PUBLIC, anon and authenticated;
--     - GRANTs EXECUTE to service_role only (the server path);
--     - self-checks BOTH properties so a re-run cannot silently regress them.
--
-- WHAT IT DOES NOT CHANGE
--   Historical rows keep the text they were written with. A rename is not a
--   reason to rewrite a customer's past statements, and the frontend maps both
--   eras to a localized label at render time (TX_DETAIL_LABELS).
--
-- IDEMPOTENT: CREATE OR REPLACE, safe to re-run.
-- GATED: refuses to run unless migration 011 is present.
--
-- ONLY apply this together with the approved brand rename. Applying it while the
-- product still presents the old name would make new transactions inconsistent
-- with the UI.

-- ATOMIC: one transaction, like 050/052/053. The function replacement, the ACL
-- re-assertion and the self-check either all land or none do, so a failure cannot
-- leave a replaced body with an unverified privilege state.
begin;

DO $pre$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'charge_subscription_safe'
    ) THEN
        RAISE EXCEPTION 'migration 011 (charge_subscription_safe) is not applied - nothing to update';
    END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.charge_subscription_safe(
    p_user_id BIGINT,
    p_price DECIMAL,
    p_idempotency_key TEXT,
    p_period_label TEXT DEFAULT NULL,
    p_billing_kind TEXT DEFAULT 'monthly'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wallet wallets%ROWTYPE;
    v_existing_key TEXT;
    v_sub subscriptions%ROWTYPE;
    v_new_balance DECIMAL;
    v_charge_id BIGINT;
    v_price DECIMAL;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'user_id is required');
    END IF;
    IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'idempotency_key is required');
    END IF;
    -- Server is the authority on price; clamp to a non-negative 2-dp value.
    v_price := ROUND(COALESCE(p_price, 0)::numeric, 2);
    IF v_price < 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'price must be non-negative');
    END IF;

    -- Idempotency check #1 (before lock): already charged for this key?
    SELECT idempotency_key INTO v_existing_key
    FROM subscription_charges
    WHERE idempotency_key = p_idempotency_key;

    IF v_existing_key IS NOT NULL THEN
        SELECT balance_after, price INTO v_new_balance, v_price
        FROM subscription_charges WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Subscription already charged for this period',
            'idempotency_key', p_idempotency_key,
            'new_balance', v_new_balance,
            'price', v_price
        );
    END IF;

    -- Get the subscription row (must exist; activation creates it first).
    SELECT * INTO v_sub
    FROM subscriptions
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF v_sub IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Subscription not found');
    END IF;
    IF v_sub.status = 'cancelled' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Subscription cancelled', 'reason', 'cancelled');
    END IF;

    -- Lock the wallet row.
    SELECT * INTO v_wallet
    FROM wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF v_wallet IS NULL THEN
        -- No wallet => no available Live balance. Mark payment_due, no charge.
        UPDATE subscriptions
        SET status = 'payment_due', updated_at = NOW()
        WHERE user_id = p_user_id;
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'insufficient_balance',
            'message', 'No available Live balance',
            'status', 'payment_due'
        );
    END IF;

    -- Double-check idempotency AFTER lock (race-condition protection).
    SELECT idempotency_key INTO v_existing_key
    FROM subscription_charges
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing_key IS NOT NULL THEN
        SELECT balance_after, price INTO v_new_balance, v_price
        FROM subscription_charges WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Subscription already charged (race condition prevented)',
            'idempotency_key', p_idempotency_key,
            'new_balance', v_new_balance,
            'price', v_price
        );
    END IF;

    -- SUFFICIENT-BALANCE GATE: only the genuinely available Live balance may
    -- be used. If insufficient, do NOT mutate any balance, do NOT create debt,
    -- and mark the subscription payment_due. Demo/bonus balances are never
    -- considered (we only read live_balance).
    IF v_wallet.live_balance < v_price THEN
        UPDATE subscriptions
        SET status = 'payment_due', updated_at = NOW()
        WHERE user_id = p_user_id;
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'insufficient_balance',
            'available_balance', v_wallet.live_balance,
            'price', v_price,
            'status', 'payment_due',
            'message', 'Available Live balance is below the subscription price'
        );
    END IF;

    -- Atomic wallet debit. Safe: we just proved live_balance >= price, so the
    -- result is >= 0. We never subtract from demo_balance or bonus_balance.
    v_new_balance := v_wallet.live_balance - v_price;

    UPDATE wallets
    SET live_balance = v_new_balance,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    -- Append-only ledger row (idempotency anchor).
    INSERT INTO subscription_charges (user_id, idempotency_key, plan, price, balance_after, created_at)
    VALUES (p_user_id, p_idempotency_key, v_sub.plan, v_price, v_new_balance, NOW())
    RETURNING id INTO v_charge_id;

    -- User-facing transaction row. NEW type 'Subscription'; existing types
    -- ('Deposit','Withdraw','Trade Executed','Referral Bonus', etc.) are NOT
    -- changed. Display label is localized at render time (TX_TYPE_LABELS).
    INSERT INTO transactions (user_id, type, amount, detail, created_at)
    VALUES (p_user_id, 'Subscription', -v_price,
        'Kalderix Pro Subscription' ||
        CASE WHEN p_period_label IS NOT NULL AND btrim(p_period_label) <> ''
             THEN ' - ' || p_period_label ELSE '' END,
        NOW());

    -- Advance billing dates: this charge covers the period starting now;
    -- next billing is one month later. status -> active.
    UPDATE subscriptions
    SET status = 'active',
        last_billing_date = NOW(),
        last_charge_amount = v_price,
        next_billing_date = (NOW() + INTERVAL '1 month'),
        started_at = COALESCE(started_at, NOW()),
        price = v_price,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
        'success', true,
        'duplicate', false,
        'user_id', p_user_id,
        'price', v_price,
        'new_balance', v_new_balance,
        'charge_id', v_charge_id,
        'status', 'active',
        'next_billing_date', (NOW() + INTERVAL '1 month')
    );

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- EXECUTE lockdown (M2). Migration 014 does NOT cover this function; its default
-- PUBLIC grant is still in place, so it is revoked here explicitly. The signature
-- is spelled out exactly (DECIMAL -> numeric) so the statement targets THIS
-- function and no other overload.
REVOKE EXECUTE ON FUNCTION public.charge_subscription_safe(BIGINT, DECIMAL, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.charge_subscription_safe(BIGINT, DECIMAL, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.charge_subscription_safe(BIGINT, DECIMAL, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.charge_subscription_safe(BIGINT, DECIMAL, TEXT, TEXT, TEXT) TO service_role;

DO $check$
DECLARE
    v_src TEXT;
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'charge_subscription_safe';

    IF v_src IS NULL THEN
        RAISE EXCEPTION 'charge_subscription_safe is missing after replace';
    END IF;
    IF position('Kalderix Pro Subscription' IN v_src) = 0 THEN
        RAISE EXCEPTION 'the rebranded transaction detail was not applied';
    END IF;
    IF position('Arbitrix Pro Subscription' IN v_src) > 0 THEN
        RAISE EXCEPTION 'the old transaction detail is still present';
    END IF;
    -- Money behaviour must be untouched: the idempotency anchor and the balance
    -- gate are the two statements whose absence would be a billing bug.
    IF position('idempotency_key' IN v_src) = 0 OR position('live_balance <' IN v_src) = 0 THEN
        RAISE EXCEPTION 'the function body lost its idempotency or balance guard';
    END IF;

    -- M2: the hardening must actually be in effect, not just written down.
    IF position('search_path' IN v_src) = 0 THEN
        RAISE EXCEPTION 'charge_subscription_safe does not pin search_path';
    END IF;

    IF to_regrole('anon') IS NOT NULL
       AND has_function_privilege('anon',
            'public.charge_subscription_safe(BIGINT, DECIMAL, TEXT, TEXT, TEXT)', 'EXECUTE') THEN
        RAISE EXCEPTION 'anon can still EXECUTE charge_subscription_safe';
    END IF;

    IF to_regrole('authenticated') IS NOT NULL
       AND has_function_privilege('authenticated',
            'public.charge_subscription_safe(BIGINT, DECIMAL, TEXT, TEXT, TEXT)', 'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated can still EXECUTE charge_subscription_safe';
    END IF;

    IF to_regrole('service_role') IS NOT NULL
       AND NOT has_function_privilege('service_role',
            'public.charge_subscription_safe(BIGINT, DECIMAL, TEXT, TEXT, TEXT)', 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role lost EXECUTE on charge_subscription_safe - billing would break';
    END IF;
END $check$;

commit;
