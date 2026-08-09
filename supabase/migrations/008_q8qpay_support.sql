-- ============================================
-- Q8QPay Support Migration
-- Arbitrix AI - Q8QPay Integration (additive only)
-- ============================================
--
-- This migration adds Q8QPay support WITHOUT touching the existing Paymento
-- integration. Paymento's columns, tables, and the paymento_credit_user_safe()
-- function remain unchanged.
--
-- Key changes:
-- 1. Add provider_invoice_ref TEXT column to store q8qpay invoice UUID
--    (provider_invoice_id is BIGINT and used by Paymento; q8qpay ids are UUIDs)
-- 2. Add provider_invoice_ref index for reconciliation/lookup
-- 3. Create a SHARED atomic credit function `credit_payment_safe` that reuses
--    the exact secure crediting pattern already proven by paymento_credit_user_safe
--    (idempotency check -> row lock -> double-check after lock -> wallet credit
--     -> transaction record -> referral bonus -> EXCEPTION rollback).
--    This is NOT a second/different crediting system: it is the same mechanism,
--    generalized so Q8QPay (and future providers) can reuse it. Paymento continues
--    to use paymento_credit_user_safe() untouched.
-- 4. Insert Q8QPay payment_config rows.
--
-- Idempotency: the existing `credited` boolean + `transaction_hash UNIQUE`
-- constraint provide double-credit protection across providers.
-- ============================================

-- ============================================
-- 1. ADD provider_invoice_ref COLUMN (string provider invoice id, e.g. q8qpay UUID)
-- ============================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public'
                   AND table_name = 'payment_invoices'
                   AND column_name = 'provider_invoice_ref') THEN
        ALTER TABLE public.payment_invoices
            ADD COLUMN provider_invoice_ref TEXT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pi_provider_invoice_ref
    ON public.payment_invoices(provider_invoice_ref)
    WHERE provider_invoice_ref IS NOT NULL;

COMMENT ON COLUMN public.payment_invoices.provider_invoice_ref IS
    'Provider invoice identifier as a string (e.g. q8qpay invoice UUID) for audit/reconciliation';

-- ============================================
-- 2. SHARED ATOMIC CREDIT FUNCTION (reuses the proven secure pattern)
-- ============================================
-- Same security guarantees as paymento_credit_user_safe():
--   - SECURITY DEFINER (elevated privileges)
--   - Idempotency check before lock (credited flag)
--   - SELECT ... FOR UPDATE row lock on the invoice
--   - Double-check credited/status AFTER lock (race-condition safe)
--   - Atomic wallet credit (live_balance += amount)
--   - Transaction record insertion
--   - First-deposit referral bonus (best-effort, never breaks the credit)
--   - EXCEPTION handler returns JSON error instead of corrupting state
--
-- This function is provider-agnostic. It stores the blockchain tx hash in the
-- existing `transaction_hash` (UNIQUE -> cross-provider duplicate protection)
-- and the provider invoice id in `provider_invoice_ref`.
CREATE OR REPLACE FUNCTION public.credit_payment_safe(
    p_invoice_id BIGINT,
    p_user_id BIGINT,
    p_amount_usd DECIMAL,
    p_transaction_hash TEXT DEFAULT NULL,
    p_provider_invoice_id TEXT DEFAULT NULL,
    p_provider_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_invoice payment_invoices%ROWTYPE;
    v_wallet wallets%ROWTYPE;
    v_new_balance DECIMAL;
    v_existing_credit BOOLEAN;
    v_existing_tx BOOLEAN;
    v_deposit_count INTEGER;
    v_referral_reward DECIMAL := 0;
    v_referrer_id BIGINT;
    v_is_first_deposit BOOLEAN := FALSE;
BEGIN

    -- Idempotency check #1: already credited?
    SELECT credited INTO v_existing_credit
    FROM payment_invoices
    WHERE id = p_invoice_id;

    IF v_existing_credit = TRUE THEN
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Invoice already credited',
            'invoice_id', p_invoice_id
        );
    END IF;

    -- Idempotency check #2: same blockchain tx hash already confirmed?
    -- (transaction_hash is UNIQUE; protects against cross-provider double-credit)
    IF p_transaction_hash IS NOT NULL THEN
        SELECT EXISTS(
            SELECT 1 FROM payment_invoices
            WHERE transaction_hash = p_transaction_hash
            AND status = 'confirmed'
        ) INTO v_existing_tx;

        IF v_existing_tx THEN
            RETURN jsonb_build_object(
                'success', true,
                'duplicate', true,
                'message', 'Transaction hash already processed',
                'transaction_hash', p_transaction_hash
            );
        END IF;
    END IF;

    -- Lock the invoice row
    SELECT * INTO v_invoice
    FROM payment_invoices
    WHERE id = p_invoice_id
    FOR UPDATE;

    IF v_invoice IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
    END IF;

    -- Double-check credited status after lock (race-condition protection)
    IF v_invoice.credited = TRUE THEN
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Invoice already credited (race condition prevented)',
            'invoice_id', p_invoice_id
        );
    END IF;

    IF v_invoice.status = 'confirmed' THEN
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Invoice already confirmed',
            'invoice_id', p_invoice_id
        );
    END IF;

    -- First-deposit detection (only counts already-credited deposits)
    SELECT COUNT(*) INTO v_deposit_count
    FROM payment_invoices
    WHERE user_id = p_user_id
    AND status = 'confirmed'
    AND credited = TRUE;

    IF v_deposit_count = 0 THEN
        v_is_first_deposit := TRUE;
    END IF;

    -- Get or create wallet (row-locked)
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

    -- Update invoice: confirmed + credited + audit fields
    UPDATE payment_invoices
    SET status = 'confirmed',
        credited = TRUE,
        confirmed_at = NOW(),
        credited_at = NOW(),
        updated_at = NOW(),
        transaction_hash = COALESCE(p_transaction_hash, transaction_hash),
        provider_invoice_ref = COALESCE(p_provider_invoice_id, provider_invoice_ref),
        provider = COALESCE(NULLIF(p_provider_name, ''), provider)
    WHERE id = p_invoice_id;

    -- Record user-facing transaction
    INSERT INTO transactions (user_id, type, amount, detail, created_at)
    VALUES (p_user_id, 'Deposit', p_amount_usd,
        COALESCE(NULLIF(p_provider_name, ''), 'Payment') || ' deposit confirmed - Invoice: ' || p_invoice_id::TEXT
        || COALESCE(' - TX: ' || NULLIF(p_transaction_hash, ''), ''),
        NOW());

    -- First-deposit referral bonus (best-effort: never breaks the credit)
    IF v_is_first_deposit THEN
        BEGIN
            SELECT referrer_id INTO v_referrer_id
            FROM referrals
            WHERE referred_id = p_user_id
            LIMIT 1;

            IF v_referrer_id IS NOT NULL THEN
                v_referral_reward := 10;
                UPDATE wallets
                SET bonus_balance = COALESCE(bonus_balance, 0) + v_referral_reward,
                    updated_at = NOW()
                WHERE user_id = v_referrer_id;

                INSERT INTO transactions (user_id, type, amount, detail, created_at)
                VALUES (v_referrer_id, 'Referral Bonus', v_referral_reward,
                    'Referral bonus for first deposit - User: ' || p_user_id::TEXT, NOW());
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'Referral processing failed: %', SQLERRM;
        END;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'duplicate', false,
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

COMMENT ON FUNCTION public.credit_payment_safe IS
    'Shared, provider-agnostic atomic payment credit with duplicate protection (used by Q8QPay). Mirrors paymento_credit_user_safe security guarantees.';

-- ============================================
-- 3. Q8QPAY PAYMENT_CONFIG ROWS
-- ============================================
INSERT INTO public.payment_config (key, value, value_type, description, category, is_sensitive) VALUES
    ('q8qpay.api_key', '', 'string', 'Q8QPay API key (test_ or live_ prefix)', 'provider', true),
    ('q8qpay.webhook_secret', '', 'string', 'Q8QPay webhook secret for HMAC-SHA256 verification', 'provider', true),
    ('q8qpay.sandbox', 'false', 'boolean', 'Use Q8QPay sandbox (test_) mode', 'provider', false),
    ('q8qpay.callback_url', '', 'string', 'Per-invoice webhook URL for Q8QPay callbacks', 'provider', false),
    ('q8qpay.return_url', '', 'string', 'Customer redirect URL after payment (white-label)', 'provider', false),
    ('q8qpay.asset_code', 'USDT_TRC20', 'string', 'Q8QPay asset code used for Arbitrix deposits', 'provider', false)
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- 4. VERIFY MIGRATION
-- ============================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public'
                   AND table_name = 'payment_invoices'
                   AND column_name = 'provider_invoice_ref') THEN
        RAISE EXCEPTION 'provider_invoice_ref column missing';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'credit_payment_safe') THEN
        RAISE EXCEPTION 'credit_payment_safe function missing';
    END IF;

    -- Ensure Paymento function is still present (untouched)
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'paymento_credit_user_safe') THEN
        RAISE EXCEPTION 'paymento_credit_user_safe missing - Paymento must remain untouched';
    END IF;

    RAISE NOTICE '✅ Q8QPay migration completed successfully (Paymento untouched)';
END $$;
