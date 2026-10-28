-- ============================================================================
-- 042 - record the deposit-credit audit marker on the provider credit path
-- ============================================================================
-- DEFECT (documented in docs/TELEGRAM_RECOVERY_AUDIT.md, section 17)
--   confirm_payment_with_credit() credits the wallet and marks the invoice
--   'confirmed', but never sets payment_invoices.credited. The conversion
--   trigger added by migration 040 requires `credited = TRUE` before it records
--   a deposit_confirmed event, so every deposit credited through this path
--   (NOWPayments) produced NO Telegram notification. Money was always correct:
--   the wallet credit, the ledger row and the invoice update are one
--   transaction. Only the audit marker was missing.
--
-- WHAT THIS MIGRATION CHANGES
--   Exactly one line: `credited = TRUE,` is added to the payment_invoices
--   UPDATE inside confirm_payment_with_credit(). Everything else - the
--   transaction/exception handling, the FOR UPDATE locks, the idempotency
--   checks (status = 'pending' and the transaction_hash duplicate check), the
--   wallet credit, the transactions row, the referral delegation and the return
--   shape - is copied byte-for-byte from migration 021.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * No backfill. Historical invoices keep credited = false on purpose:
--     retroactively setting the marker would emit notifications for old
--     deposits. conversion_backfill_missing() (041) covers only the legacy
--     deposits table.
--   * No change to credit_payment_safe() or paymento_credit_user_safe() - both
--     already set the marker.
--   * No schema change, no new table, no new column.
--
-- NOTE ON NAMING
--   This function updates payment_invoices, so the marker it must set is
--   payment_invoices.credited (added by migration 006). The legacy deposits
--   table has its own marker, deposits.credited, which migration 041's
--   confirm_legacy_deposit_safe() already sets correctly. Both paths are now
--   consistent with the conversion trigger's `credited = TRUE` requirement.
--
-- PRECONDITION
--   Migration 021 must already be applied: its body is what is re-created here,
--   including the delegated referral award. Applying this on a database without
--   021 would silently upgrade the retired flat-reward logic, so the migration
--   refuses instead of guessing.
--
-- IDEMPOTENT: CREATE OR REPLACE + guarded grants, safe to re-run.
--
-- ROLLBACK (only if the marker must be removed again):
--   re-apply supabase/migrations/021_provider_referral_award_correctness.sql
--   (its CREATE OR REPLACE restores the previous body verbatim).
-- ============================================================================

DO $migration$
DECLARE
    v_src TEXT;
    v_oid OID;
BEGIN

    -- ------------------------------------------------------------------
    -- 0. Preconditions
    -- ------------------------------------------------------------------
    IF to_regclass('public.payment_invoices') IS NULL THEN
        RAISE EXCEPTION 'migration 042 requires public.payment_invoices';
    END IF;
    IF to_regclass('public.wallets') IS NULL THEN
        RAISE EXCEPTION 'migration 042 requires public.wallets';
    END IF;
    IF to_regclass('public.transactions') IS NULL THEN
        RAISE EXCEPTION 'migration 042 requires public.transactions';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'payment_invoices'
           AND column_name = 'credited'
    ) THEN
        RAISE EXCEPTION 'migration 042 requires payment_invoices.credited (migration 006)';
    END IF;

    IF to_regprocedure('public.award_referral_qualification_safe(bigint, numeric)') IS NULL THEN
        RAISE EXCEPTION 'migration 042 requires migration 021 - apply 021 first (award_referral_qualification_safe is missing)';
    END IF;

    -- ------------------------------------------------------------------
    -- 1. The function: identical to 021 plus `credited = TRUE,`
    -- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.confirm_payment_with_credit(
    p_invoice_id BIGINT,
    p_user_id BIGINT,
    p_amount_usd DECIMAL,
    p_transaction_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_invoice payment_invoices%ROWTYPE;
    v_wallet wallets%ROWTYPE;
    v_new_balance DECIMAL;
    v_existing_tx BOOLEAN;
    v_deposit_count INTEGER;
    v_referral_reward DECIMAL := 0;
    v_referrer_id BIGINT;
    v_is_first_deposit BOOLEAN := FALSE;
BEGIN
    
    IF p_transaction_hash IS NOT NULL THEN
        SELECT EXISTS(
            SELECT 1 FROM payment_invoices 
            WHERE transaction_hash = p_transaction_hash
            AND status = 'confirmed'
        ) INTO v_existing_tx;
        
        IF v_existing_tx THEN
            RAISE EXCEPTION 'Transaction already processed';
        END IF;
    END IF;

    SELECT * INTO v_invoice
    FROM payment_invoices
    WHERE id = p_invoice_id AND status = 'pending'
    FOR UPDATE;

    IF v_invoice IS NULL THEN
        RAISE EXCEPTION 'Invoice not found or already processed';
    END IF;

    IF v_invoice.status != 'pending' THEN
        RAISE EXCEPTION 'Invoice already processed with status: %', v_invoice.status;
    END IF;

    SELECT COUNT(*) INTO v_deposit_count
    FROM payment_invoices
    WHERE user_id = p_user_id
    AND status = 'confirmed';
    
    IF v_deposit_count = 0 THEN
        v_is_first_deposit := TRUE;
    END IF;

    SELECT * INTO v_wallet
    FROM wallets
    WHERE user_id = p_user_id
    FOR UPDATE;
    
    IF v_wallet IS NULL THEN
        INSERT INTO wallets (user_id, live_balance, demo_balance, bonus_balance)
        VALUES (p_user_id, p_amount_usd, 0, 0)
        RETURNING * INTO v_wallet;
        v_new_balance := p_amount_usd;
    ELSE
        UPDATE wallets
        SET live_balance = live_balance + p_amount_usd,
            updated_at = NOW()
        WHERE user_id = p_user_id
        RETURNING live_balance INTO v_new_balance;
    END IF;

    UPDATE payment_invoices
    SET status = 'confirmed',
        credited = TRUE,
        confirmed_at = NOW(),
        credited_at = NOW(),
        updated_at = NOW(),
        transaction_hash = COALESCE(p_transaction_hash, transaction_hash)
    WHERE id = p_invoice_id;

    INSERT INTO transactions (user_id, type, amount, detail, created_at)
    VALUES (p_user_id, 'Deposit', p_amount_usd, 'Payment confirmed - ' || COALESCE(p_transaction_hash, 'Internal'), NOW());

    -- Referral qualification (final management model): a referral qualifies ONLY
    -- on the platform's minimum qualifying deposit and only ONCE, and pays a
    -- ONE-TIME reward of 20% of that initial deposit. Delegated to
    -- award_referral_qualification_safe() so the reward can never be
    -- hard-coded here again (single source of truth = referral_config).
    BEGIN
        v_referral_reward := COALESCE((award_referral_qualification_safe(p_user_id, p_amount_usd)->>'reward')::DECIMAL, 0);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Referral qualification failed: %', SQLERRM;
        v_referral_reward := 0;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'invoice_id', p_invoice_id,
        'user_id', p_user_id,
        'amount_usd', p_amount_usd,
        'new_balance', v_new_balance,
        'credited', true,
        'is_first_deposit', v_is_first_deposit,
        'referral_bonus', v_referral_reward
    );
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

    EXECUTE 'COMMENT ON FUNCTION public.confirm_payment_with_credit(BIGINT, BIGINT, DECIMAL, TEXT) IS '
         || quote_literal('Credits a provider invoice atomically: wallet credit + transactions row + invoice confirmed AND credited = TRUE (the marker migration 040 requires before recording a deposit_confirmed event). One transaction; idempotent on status = pending and on the UNIQUE transaction_hash.');

    -- ------------------------------------------------------------------
    -- 2. Grants: service_role only (same as migration 021)
    -- ------------------------------------------------------------------
    EXECUTE 'REVOKE ALL ON FUNCTION public.confirm_payment_with_credit(BIGINT, BIGINT, DECIMAL, TEXT) FROM PUBLIC';
    IF to_regrole('anon') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON FUNCTION public.confirm_payment_with_credit(BIGINT, BIGINT, DECIMAL, TEXT) FROM anon';
    END IF;
    IF to_regrole('authenticated') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON FUNCTION public.confirm_payment_with_credit(BIGINT, BIGINT, DECIMAL, TEXT) FROM authenticated';
    END IF;
    IF to_regrole('service_role') IS NOT NULL THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.confirm_payment_with_credit(BIGINT, BIGINT, DECIMAL, TEXT) TO service_role';
    END IF;

    -- ------------------------------------------------------------------
    -- 3. Self-check: a failure rolls the whole file back
    -- ------------------------------------------------------------------
    v_oid := to_regprocedure('public.confirm_payment_with_credit(bigint, bigint, numeric, text)');
    IF v_oid IS NULL THEN
        RAISE EXCEPTION '042 self-check: confirm_payment_with_credit is missing';
    END IF;

    SELECT pg_get_functiondef(v_oid) INTO v_src;

    IF v_src !~ 'status = ''confirmed'',\s+credited = TRUE,' THEN
        RAISE EXCEPTION '042 self-check: the credited marker is not set in the invoice UPDATE';
    END IF;
    IF v_src !~ 'WHERE id = p_invoice_id AND status = ''pending''' THEN
        RAISE EXCEPTION '042 self-check: the row-lock idempotency guard changed';
    END IF;
    IF v_src !~ 'Transaction already processed' THEN
        RAISE EXCEPTION '042 self-check: the transaction_hash duplicate check changed';
    END IF;
    IF v_src !~ 'live_balance \+ p_amount_usd' THEN
        RAISE EXCEPTION '042 self-check: the wallet credit changed';
    END IF;
    IF v_src !~ 'award_referral_qualification_safe' THEN
        RAISE EXCEPTION '042 self-check: the referral delegation changed';
    END IF;
    IF v_src ILIKE '%FROM deposits%' OR v_src ILIKE '%UPDATE deposits%' THEN
        RAISE EXCEPTION '042 self-check: this function must not touch the legacy deposits table';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
        RAISE EXCEPTION '042 self-check: SECURITY DEFINER was lost';
    END IF;

    RAISE NOTICE 'migration 042: verified - credited = TRUE is set in the invoice UPDATE, idempotency and referral delegation intact';

END
$migration$;
