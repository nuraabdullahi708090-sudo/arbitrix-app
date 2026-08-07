-- ============================================
-- Paymento Support Migration
-- Arbitrix AI - Paymento Integration
-- ============================================
-- 
-- This migration adds Paymento-specific fields to support
-- the Paymento non-custodial payment gateway.
--
-- Key changes:
-- 1. Add paymento_token field to payment_invoices
-- 2. Add provider_payment_id for Paymento's internal ID
-- 3. Add status_code for raw Paymento status codes
-- 4. Create idempotency tracking table
-- 5. Update payment_config with Paymento settings
-- ============================================

-- ============================================
-- 1. ADD PAYMENTO COLUMNS TO payment_invoices
-- ============================================

-- Add Paymento-specific fields (only if they don't exist)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'payment_invoices' 
                   AND column_name = 'paymento_token') THEN
        ALTER TABLE public.payment_invoices 
            ADD COLUMN paymento_token TEXT;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'payment_invoices' 
                   AND column_name = 'provider_payment_id') THEN
        ALTER TABLE public.payment_invoices 
            ADD COLUMN provider_payment_id BIGINT;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'payment_invoices' 
                   AND column_name = 'provider_status_code') THEN
        ALTER TABLE public.payment_invoices 
            ADD COLUMN provider_status_code INTEGER;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'payment_invoices' 
                   AND column_name = 'gateway_url') THEN
        ALTER TABLE public.payment_invoices 
            ADD COLUMN gateway_url TEXT;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'payment_invoices' 
                   AND column_name = 'credited') THEN
        ALTER TABLE public.payment_invoices 
            ADD COLUMN credited BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

-- ============================================
-- 2. ADD INDEXES FOR NEW COLUMNS
-- ============================================

CREATE INDEX IF NOT EXISTS idx_pi_paymento_token 
    ON public.payment_invoices(paymento_token) 
    WHERE paymento_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pi_provider_payment_id 
    ON public.payment_invoices(provider_payment_id) 
    WHERE provider_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pi_credited 
    ON public.payment_invoices(credited) 
    WHERE credited = FALSE;

-- ============================================
-- 3. UPDATE PAYMENT_CONFIG WITH PAYMENTO SETTINGS
-- ============================================

INSERT INTO public.payment_config (key, value, value_type, description, category, is_sensitive) VALUES
    ('paymento.api_key', '', 'string', 'Paymento API key', 'provider', true),
    ('paymento.secret_key', '', 'string', 'Paymento webhook secret for HMAC verification', 'provider', true),
    ('paymento.sandbox', 'false', 'boolean', 'Use Paymento sandbox mode', 'provider', false),
    ('paymento.return_url', '', 'string', 'Customer redirect URL after payment', 'provider', false),
    ('paymento.ipn_url', '', 'string', 'Webhook endpoint URL for Paymento callbacks', 'provider', false),
    ('paymento.speed', '1', 'number', 'Payment speed: 0=High(mempool), 1=Low(block confirm)', 'provider', false)
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- 4. CREATE IDEMPOTENCY TABLE FOR PAYMENTO
-- ============================================

CREATE TABLE IF NOT EXISTS public.paymento_idempotency (
    id BIGSERIAL PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    paymento_token TEXT NOT NULL,
    invoice_id BIGINT REFERENCES public.payment_invoices(id),
    status TEXT NOT NULL DEFAULT 'processing',
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pi_idempotency_key 
    ON public.paymento_idempotency(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_pi_paymento_token_idemp 
    ON public.paymento_idempotency(paymento_token);

-- ============================================
-- 5. CREATE FUNCTION TO PREVENT DOUBLE CREDIT
-- ============================================

CREATE OR REPLACE FUNCTION public.paymento_credit_user_safe(
    p_invoice_id BIGINT,
    p_user_id BIGINT,
    p_amount_usd DECIMAL,
    p_provider_payment_id BIGINT DEFAULT NULL,
    p_provider_status_code INTEGER DEFAULT NULL
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
    
    -- Update invoice status
    UPDATE payment_invoices
    SET status = 'confirmed',
        credited = TRUE,
        confirmed_at = NOW(),
        credited_at = NOW(),
        updated_at = NOW(),
        provider_payment_id = COALESCE(p_provider_payment_id, provider_payment_id),
        provider_status_code = COALESCE(p_provider_status_code, provider_status_code)
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
-- 6. CREATE FUNCTION TO CHECK DUPLICATE IPN
-- ============================================

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
    
    -- Return invoice status
    RETURN jsonb_build_object(
        'found', true,
        'invoice_id', v_invoice.id,
        'status', v_invoice.status,
        'credited', v_invoice.credited,
        'amount_usd', v_invoice.amount_usd,
        'user_id', v_invoice.user_id
    );
END;
$$;

-- ============================================
-- 7. VERIFY MIGRATION
-- ============================================
DO $$
BEGIN
    -- Check new columns exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'payment_invoices' 
                   AND column_name = 'paymento_token') THEN 
        RAISE EXCEPTION 'paymento_token column missing';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'payment_invoices' 
                   AND column_name = 'credited') THEN 
        RAISE EXCEPTION 'credited column missing';
    END IF;
    
    -- Check new table exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables 
                   WHERE table_schema = 'public' 
                   AND table_name = 'paymento_idempotency') THEN 
        RAISE EXCEPTION 'paymento_idempotency table missing';
    END IF;
    
    -- Check function exists
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'paymento_credit_user_safe') THEN 
        RAISE EXCEPTION 'paymento_credit_user_safe function missing';
    END IF;
    
    RAISE NOTICE '✅ Paymento migration completed successfully';
END $$;

COMMENT ON TABLE public.paymento_idempotency IS 
    'Tracks Paymento webhook idempotency to prevent duplicate processing';
    
COMMENT ON FUNCTION public.paymento_credit_user_safe IS 
    'Atomically credit user balance with duplicate protection for Paymento';
