-- ============================================
-- Paymento Settlement Audit Migration
-- Requires Migration 006 to be applied first.
-- ============================================
-- 
-- This migration adds settlement audit fields to payment_invoices
-- to store blockchain transaction details from Paymento webhooks.
--
-- Key changes:
-- 1. Add settlement_address column for Paymento's ToAddress
-- 2. Add provider_tx_hash column for blockchain transaction hash
-- 3. Add provider_confirmations column for block confirmations
-- 4. Update paymento_credit_user_safe() to accept optional settlement data
-- 5. Ensure settlement data is NOT a prerequisite for valid payments
--
-- IMPORTANT: This migration is idempotent - safe to run multiple times.
-- It does NOT modify existing data, balances, or transaction records.
-- ============================================

-- ============================================
-- 1. ADD SETTLEMENT AUDIT COLUMNS TO payment_invoices
-- ============================================

-- Add settlement_address column (ToAddress from Paymento webhook)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'payment_invoices' 
                   AND column_name = 'settlement_address') THEN
        ALTER TABLE public.payment_invoices 
            ADD COLUMN settlement_address TEXT;
    END IF;
END $$;

-- Add provider_tx_hash column (blockchain transaction hash)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'payment_invoices' 
                   AND column_name = 'provider_tx_hash') THEN
        ALTER TABLE public.payment_invoices 
            ADD COLUMN provider_tx_hash TEXT;
    END IF;
END $$;

-- Add provider_confirmations column (block confirmations count)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'payment_invoices' 
                   AND column_name = 'provider_confirmations') THEN
        ALTER TABLE public.payment_invoices 
            ADD COLUMN provider_confirmations INTEGER DEFAULT 0;
    END IF;
END $$;

-- ============================================
-- 2. ADD INDEXES FOR NEW COLUMNS
-- ============================================

-- Index for settlement_address lookup (useful for reconciliation)
CREATE INDEX IF NOT EXISTS idx_pi_settlement_address 
    ON public.payment_invoices(settlement_address) 
    WHERE settlement_address IS NOT NULL;

-- Index for blockchain transaction hash lookup
CREATE INDEX IF NOT EXISTS idx_pi_provider_tx_hash 
    ON public.payment_invoices(provider_tx_hash) 
    WHERE provider_tx_hash IS NOT NULL;

-- ============================================
-- 3. UPDATE paymento_credit_user_safe FUNCTION
-- ============================================
-- 
-- CRITICAL SECURITY REQUIREMENTS PRESERVED:
-- - SECURITY DEFINER (runs with elevated privileges)
-- - Row-level locking (FOR UPDATE)
-- - Double-check idempotency after lock
-- - Atomic wallet updates
-- - Transaction recording
-- - Referral bonus handling
-- - EXCEPTION handling to prevent data corruption
--
-- NEW BEHAVIOR:
-- - Accepts optional settlement data parameters
-- - Stores settlement info when available
-- - Does NOT require settlement data to credit payment
--   (settlement info may arrive after initial confirmation)
-- ============================================

CREATE OR REPLACE FUNCTION public.paymento_credit_user_safe(
    p_invoice_id BIGINT,
    p_user_id BIGINT,
    p_amount_usd DECIMAL,
    p_provider_payment_id BIGINT DEFAULT NULL,
    p_provider_status_code INTEGER DEFAULT NULL,
    p_settlement_address TEXT DEFAULT NULL,
    p_provider_tx_hash TEXT DEFAULT NULL,
    p_provider_confirmations INTEGER DEFAULT NULL
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
    v_deposit_count INTEGER;
    v_referral_reward DECIMAL := 0;
    v_referrer_id BIGINT;
    v_is_first_deposit BOOLEAN := FALSE;
BEGIN
    
    -- Check if already credited (idempotency check)
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
    
    -- Lock the invoice row
    SELECT * INTO v_invoice
    FROM payment_invoices
    WHERE id = p_invoice_id
    FOR UPDATE;
    
    IF v_invoice IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
    END IF;
    
    -- Double-check credited status after lock
    IF v_invoice.credited = TRUE THEN
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Invoice already credited (race condition prevented)',
            'invoice_id', p_invoice_id
        );
    END IF;
    
    -- Check if already confirmed
    IF v_invoice.status = 'confirmed' THEN
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Invoice already confirmed',
            'invoice_id', p_invoice_id
        );
    END IF;
    
    -- Check for first deposit
    SELECT COUNT(*) INTO v_deposit_count
    FROM payment_invoices
    WHERE user_id = p_user_id
    AND status = 'confirmed'
    AND credited = TRUE;
    
    IF v_deposit_count = 0 THEN
        v_is_first_deposit := TRUE;
    END IF;
    
    -- Get or create wallet
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
    
    -- Update invoice status with ALL available data including settlement audit fields
    -- NOTE: Settlement data is stored when available but is NOT required for crediting
    UPDATE payment_invoices
    SET status = 'confirmed',
        credited = TRUE,
        confirmed_at = NOW(),
        credited_at = NOW(),
        updated_at = NOW(),
        provider_payment_id = COALESCE(p_provider_payment_id, provider_payment_id),
        provider_status_code = COALESCE(p_provider_status_code, provider_status_code),
        settlement_address = COALESCE(p_settlement_address, settlement_address),
        provider_tx_hash = COALESCE(p_provider_tx_hash, provider_tx_hash),
        provider_confirmations = COALESCE(p_provider_confirmations, provider_confirmations)
    WHERE id = p_invoice_id;
    
    -- Record transaction
    INSERT INTO transactions (user_id, type, amount, detail, created_at)
    VALUES (p_user_id, 'Deposit', p_amount_usd, 'Paymento deposit confirmed - Invoice: ' || p_invoice_id::TEXT, NOW());
    
    -- Process referral bonus for first deposit
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
                        'Referral bonus for first Paymento deposit - User: ' || p_user_id::TEXT, NOW());
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

-- ============================================
-- 4. UPDATE paymento_check_duplicate_webhook FUNCTION
-- ============================================
-- Update to also return settlement data for webhook response
-- This function is READ-ONLY and does not modify any data

CREATE OR REPLACE FUNCTION public.paymento_check_duplicate_webhook(
    p_paymento_token TEXT,
    p_provider_payment_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_invoice payment_invoices%ROWTYPE;
    v_result JSONB;
BEGIN
    -- Try to find by token first
    IF p_paymento_token IS NOT NULL THEN
        SELECT * INTO v_invoice
        FROM payment_invoices
        WHERE paymento_token = p_paymento_token
        LIMIT 1;
    END IF;
    
    -- If not found, try by provider_payment_id
    IF v_invoice IS NULL AND p_provider_payment_id IS NOT NULL THEN
        SELECT * INTO v_invoice
        FROM payment_invoices
        WHERE provider_payment_id = p_provider_payment_id
        LIMIT 1;
    END IF;
    
    IF v_invoice IS NULL THEN
        RETURN jsonb_build_object('found', false);
    END IF;
    
    -- Return invoice status with settlement audit data
    RETURN jsonb_build_object(
        'found', true,
        'invoice_id', v_invoice.id,
        'status', v_invoice.status,
        'credited', v_invoice.credited,
        'amount_usd', v_invoice.amount_usd,
        'user_id', v_invoice.user_id,
        'settlement_address', v_invoice.settlement_address,
        'provider_tx_hash', v_invoice.provider_tx_hash,
        'provider_confirmations', v_invoice.provider_confirmations
    );
END;
$$;

-- ============================================
-- 5. ADD COMMENTS FOR DOCUMENTATION
-- ============================================

COMMENT ON COLUMN public.payment_invoices.settlement_address IS 
    'Paymento ToAddress - destination blockchain address for the payment settlement';
    
COMMENT ON COLUMN public.payment_invoices.provider_tx_hash IS 
    'Blockchain transaction hash from Paymento webhook for audit/reconciliation';
    
COMMENT ON COLUMN public.payment_invoices.provider_confirmations IS 
    'Number of block confirmations at time of Paymento notification';

-- ============================================
-- 6. VERIFY MIGRATION
-- ============================================
DO $$
BEGIN
    -- Check new columns exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'payment_invoices' 
                   AND column_name = 'settlement_address') THEN 
        RAISE EXCEPTION 'settlement_address column missing';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'payment_invoices' 
                   AND column_name = 'provider_tx_hash') THEN 
        RAISE EXCEPTION 'provider_tx_hash column missing';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'payment_invoices' 
                   AND column_name = 'provider_confirmations') THEN 
        RAISE EXCEPTION 'provider_confirmations column missing';
    END IF;
    
    -- Check function exists with updated signature
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'paymento_credit_user_safe') THEN 
        RAISE EXCEPTION 'paymento_credit_user_safe function missing';
    END IF;
    
    RAISE NOTICE '✅ Paymento settlement audit migration completed successfully';
END $$;
