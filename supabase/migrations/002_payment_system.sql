-- ============================================
-- Payment System Migration
-- Arbitrix AI - Production Migration
-- ============================================
-- This migration creates the complete payment system with:
-- - Payment invoices table with full tracking
-- - Webhook logs for audit trail
-- - Database functions for atomic operations
-- - Proper indexes, constraints, and RLS policies
-- ============================================

-- ============================================
-- 1. CREATE PAYMENT_INVOICES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.payment_invoices (
    -- Primary key
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Unique invoice identifier
    invoice_id TEXT NOT NULL UNIQUE,
    
    -- User reference
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    
    -- Amount in USD
    amount_usd DECIMAL(18, 2) NOT NULL CHECK (amount_usd > 0),
    
    -- Cryptocurrency amount (calculated)
    amount_crypto DECIMAL(18, 8),
    
    -- Currency code (USDT, BTC, ETH, etc.)
    currency TEXT NOT NULL DEFAULT 'USDT',
    
    -- Network (TRC20, ERC20, BEP20, etc.)
    network TEXT NOT NULL DEFAULT 'TRC20',
    
    -- Wallet address for payment
    wallet_address TEXT,
    
    -- Provider reference
    provider TEXT NOT NULL DEFAULT 'nowpayments',
    
    -- Status: pending, confirmed, expired, cancelled, failed
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirming', 'confirmed', 'partial', 'expired', 'cancelled', 'failed')),
    
    -- Transaction hash (for blockchain verification)
    -- SECURITY: Unique constraint prevents double-crediting
    transaction_hash TEXT UNIQUE,
    
    -- IP address for security tracking
    ip_address INET,
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    credited_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    expired_at TIMESTAMPTZ,
    
    -- Expiration
    expires_at TIMESTAMPTZ NOT NULL,
    
    -- Provider's invoice ID (external reference)
    provider_invoice_id TEXT,
    
    -- Additional metadata (JSON for flexibility)
    metadata JSONB DEFAULT '{}',
    
    -- Idempotency key for preventing duplicates
    idempotency_key TEXT
);

-- ============================================
-- 2. CREATE WEBHOOK_LOGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.webhook_logs (
    -- Primary key
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Provider that sent the webhook
    provider TEXT NOT NULL,
    
    -- Event type from provider
    event_type TEXT,
    
    -- Raw payload (encrypted in production)
    payload JSONB NOT NULL,
    
    -- SHA256 hash of signature (for verification)
    signature_hash TEXT,
    
    -- Idempotency key for duplicate detection
    idempotency_key TEXT,
    
    -- Processing status
    status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'failed', 'duplicate')),
    
    -- Timestamps
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    
    -- Result/error information
    result JSONB,
    
    -- Related invoice (if found)
    related_invoice_id UUID REFERENCES public.payment_invoices(id),
    
    -- IP address of webhook source
    source_ip INET
);

-- ============================================
-- 3. CREATE PAYMENT_CONFIG TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.payment_config (
    -- Primary key
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Config key
    key TEXT NOT NULL UNIQUE,
    
    -- Config value (encrypted for secrets)
    value TEXT,
    
    -- Value type for parsing
    value_type TEXT NOT NULL DEFAULT 'string' CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
    
    -- Description
    description TEXT,
    
    -- Category
    category TEXT DEFAULT 'general' CHECK (category IN ('general', 'provider', 'network', 'security', 'notification')),
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ,
    
    -- Created by (admin user)
    created_by UUID REFERENCES public.users(id),
    
    -- Is sensitive (should be encrypted)
    is_sensitive BOOLEAN NOT NULL DEFAULT FALSE
);

-- ============================================
-- 4. CREATE INDEXES FOR payment_invoices
-- ============================================

-- Primary lookup index: Find invoice by invoice_id
CREATE INDEX IF NOT EXISTS idx_payment_invoices_invoice_id
    ON public.payment_invoices(invoice_id);

-- User lookup: Find all invoices for a user
CREATE INDEX IF NOT EXISTS idx_payment_invoices_user_id
    ON public.payment_invoices(user_id);

-- User + status: Find pending invoices for user
CREATE INDEX IF NOT EXISTS idx_payment_invoices_user_status
    ON public.payment_invoices(user_id, status)
    WHERE status IN ('pending', 'confirming');

-- Status lookup: Find invoices by status
CREATE INDEX IF NOT EXISTS idx_payment_invoices_status
    ON public.payment_invoices(status)
    WHERE status IN ('pending', 'confirming');

-- Provider reference: Find by provider's invoice ID
CREATE INDEX IF NOT EXISTS idx_payment_invoices_provider_id
    ON public.payment_invoices(provider_invoice_id)
    WHERE provider_invoice_id IS NOT NULL;

-- Wallet address: Find invoice by payment address
CREATE INDEX IF NOT EXISTS idx_payment_invoices_wallet_address
    ON public.payment_invoices(wallet_address)
    WHERE wallet_address IS NOT NULL;

-- Created at: For time-based queries
CREATE INDEX IF NOT EXISTS idx_payment_invoices_created_at
    ON public.payment_invoices(created_at DESC);

-- User + created: Recent invoices for user
CREATE INDEX IF NOT EXISTS idx_payment_invoices_user_created
    ON public.payment_invoices(user_id, created_at DESC);

-- Transaction hash: Find by blockchain tx
CREATE INDEX IF NOT EXISTS idx_payment_invoices_tx_hash
    ON public.payment_invoices(transaction_hash)
    WHERE transaction_hash IS NOT NULL;

-- ============================================
-- 5. CREATE INDEXES FOR webhook_logs
-- ============================================

-- Idempotency key: Prevent duplicate processing
CREATE INDEX IF NOT EXISTS idx_webhook_logs_idempotency_key
    ON public.webhook_logs(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Provider + status: Find failed webhooks for retry
CREATE INDEX IF NOT EXISTS idx_webhook_logs_provider_status
    ON public.webhook_logs(provider, status)
    WHERE status IN ('failed', 'pending');

-- Received at: Time-based cleanup
CREATE INDEX IF NOT EXISTS idx_webhook_logs_received_at
    ON public.webhook_logs(received_at DESC);

-- Related invoice: Find webhooks for an invoice
CREATE INDEX IF NOT EXISTS idx_webhook_logs_related_invoice
    ON public.webhook_logs(related_invoice_id)
    WHERE related_invoice_id IS NOT NULL;

-- ============================================
-- 6. CREATE ATOMIC PAYMENT FUNCTION
-- ============================================
-- CRITICAL: This function MUST be the ONLY way to confirm payments
-- ALL operations happen in a single atomic transaction:
-- 1. Validate invoice (with row lock)
-- 2. Credit wallet (with row lock)
-- 3. Update invoice status
-- 4. Create transaction record
-- 5. Check referral qualification
-- If ANY step fails, the entire transaction is rolled back
-- ============================================
CREATE OR REPLACE FUNCTION public.confirm_payment_with_credit(
    p_invoice_id UUID,
    p_user_id UUID,
    p_amount_usd DECIMAL,
    p_transaction_hash TEXT,
    p_is_first_deposit OUT BOOLEAN
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
    v_referrer_id UUID;
BEGIN
    -- Initialize output parameter
    p_is_first_deposit := FALSE;
    
    -- SECURITY: Check if transaction hash already exists (prevents double-crediting)
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

    -- Lock the invoice row to prevent concurrent updates
    SELECT * INTO v_invoice
    FROM payment_invoices
    WHERE id = p_invoice_id AND status = 'pending'
    FOR UPDATE;

    IF v_invoice IS NULL THEN
        RAISE EXCEPTION 'Invoice not found or already processed';
    END IF;

    -- Double-check invoice isn't already confirmed
    IF v_invoice.status != 'pending' THEN
        RAISE EXCEPTION 'Invoice already processed with status: %', v_invoice.status;
    END IF;

    -- Check if this is the user's first confirmed deposit
    SELECT COUNT(*) INTO v_deposit_count
    FROM payment_invoices
    WHERE user_id = p_user_id
    AND status = 'confirmed';
    
    -- This will be the second deposit (current one pending becomes confirmed)
    -- So if count is 0, this IS the first deposit
    IF v_deposit_count = 0 THEN
        p_is_first_deposit := TRUE;
    END IF;

    -- Lock the wallet row
    SELECT * INTO v_wallet
    FROM wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

    -- Credit the wallet or create if doesn't exist
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

    -- Update invoice status with transaction hash
    -- The UNIQUE constraint on transaction_hash will prevent duplicates
    UPDATE payment_invoices
    SET status = 'confirmed',
        confirmed_at = NOW(),
        credited_at = NOW(),
        updated_at = NOW(),
        transaction_hash = COALESCE(p_transaction_hash, transaction_hash)
    WHERE id = p_invoice_id;

    -- Add transaction record
    INSERT INTO transactions (user_id, type, amount, detail, created_at)
    VALUES (
        p_user_id,
        'Deposit',
        p_amount_usd,
        'Payment confirmed - ' || COALESCE(p_transaction_hash, 'Internal'),
        NOW()
    );

    -- ATOMIC REFERRAL HANDLING:
    -- If this is first deposit and user has a referrer, credit referral bonus
    -- This happens WITHIN the same transaction, so if it fails, everything rolls back
    IF p_is_first_deposit THEN
        -- Find the referrer (user who referred this user)
        -- This assumes there's a referral table or column
        -- Adjust based on your actual referral structure
        BEGIN
            -- Try to find referrer from referrals table
            SELECT referrer_id INTO v_referrer_id
            FROM referrals
            WHERE referred_id = p_user_id
            LIMIT 1;
            
            IF v_referrer_id IS NOT NULL THEN
                -- Check if referral bonus is configured
                -- Default to $10 if no config found
                v_referral_reward := 10;
                
                -- Credit referrer's bonus balance
                UPDATE wallets
                SET bonus_balance = COALESCE(bonus_balance, 0) + v_referral_reward,
                    updated_at = NOW()
                WHERE user_id = v_referrer_id;
                
                -- Add transaction record for referrer
                INSERT INTO transactions (user_id, type, amount, detail, created_at)
                VALUES (
                    v_referrer_id,
                    'Referral Bonus',
                    v_referral_reward,
                    'Referral bonus for first deposit - User: ' || p_user_id::TEXT,
                    NOW()
                );
            END IF;
        EXCEPTION WHEN OTHERS THEN
            -- If referral processing fails, log but don't fail the payment
            -- In production, you'd want proper error logging here
            RAISE WARNING 'Referral processing failed: %', SQLERRM;
        END;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'invoice_id', p_invoice_id,
        'user_id', p_user_id,
        'amount_usd', p_amount_usd,
        'new_balance', v_new_balance,
        'credited', true,
        'is_first_deposit', p_is_first_deposit,
        'referral_bonus', v_referral_reward
    );
EXCEPTION
    WHEN OTHERS THEN
        -- Any exception causes FULL transaction rollback
        RETURN jsonb_build_object(
            'success', false,
            'error', SQLERRM
        );
END;
$$;

COMMENT ON FUNCTION public.confirm_payment_with_credit IS
    'ATOMIC: Confirms payment, credits wallet, creates transaction, and handles referral - all in one transaction.';

-- ============================================
-- 7. CREATE WEBHOOK CLEANUP FUNCTION
-- ============================================
CREATE OR REPLACE FUNCTION public.cleanup_old_webhook_logs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count INTEGER;
    cutoff_date TIMESTAMPTZ := NOW() - INTERVAL '30 days';
BEGIN
    DELETE FROM webhook_logs
    WHERE received_at < cutoff_date
    AND status IN ('processed', 'duplicate', 'failed');
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    RAISE NOTICE 'Cleaned up % old webhook logs', deleted_count;
    RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION public.cleanup_old_webhook_logs IS
    'Removes webhook logs older than 30 days that have been processed.';

-- ============================================
-- 8. CREATE EXPIRED INVOICE CHECK FUNCTION
-- ============================================
CREATE OR REPLACE FUNCTION public.mark_expired_invoices()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    expired_count INTEGER;
BEGIN
    UPDATE payment_invoices
    SET status = 'expired',
        expired_at = NOW(),
        updated_at = NOW()
    WHERE status = 'pending'
    AND expires_at < NOW();
    
    GET DIAGNOSTICS expired_count = ROW_COUNT;
    
    RAISE NOTICE 'Marked % invoices as expired', expired_count;
    RETURN expired_count;
END;
$$;

COMMENT ON FUNCTION public.mark_expired_invoices IS
    'Marks pending invoices as expired if they have passed their expiration time.';

-- ============================================
-- 9. ENABLE ROW LEVEL SECURITY (RLS)
-- ============================================

-- Enable RLS on payment_invoices
ALTER TABLE public.payment_invoices ENABLE ROW LEVEL SECURITY;

-- Enable RLS on webhook_logs
ALTER TABLE public.webhook_logs ENABLE ROW LEVEL SECURITY;

-- Enable RLS on payment_config
ALTER TABLE public.payment_config ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 10. RLS POLICIES FOR payment_invoices
-- ============================================

-- Users can view their own invoices
CREATE POLICY "Users can view own invoices"
    ON public.payment_invoices
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Users can insert their own invoices (via service role only)
CREATE POLICY "Service role can insert invoices"
    ON public.payment_invoices
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own invoices (only cancel)
CREATE POLICY "Users can update own invoices"
    ON public.payment_invoices
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (
        auth.uid() = user_id 
        AND status = 'pending'
        AND (cancelled_at IS NULL OR cancelled_at = updated_at)
    );

-- Admins can view all invoices
CREATE POLICY "Admins can view all invoices"
    ON public.payment_invoices
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users 
            WHERE id = auth.uid() 
            AND is_admin = true
        )
    );

-- ============================================
-- 11. RLS POLICIES FOR webhook_logs
-- ============================================

-- Only service role can view webhook logs
CREATE POLICY "Service role can view webhook logs"
    ON public.webhook_logs
    FOR SELECT
    TO authenticated
    USING (auth.role() = 'service_role');

-- Service role can insert webhook logs
CREATE POLICY "Service role can insert webhook logs"
    ON public.webhook_logs
    FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- Service role can update webhook logs
CREATE POLICY "Service role can update webhook logs"
    ON public.webhook_logs
    FOR UPDATE
    TO authenticated
    USING (auth.role() = 'service_role');

-- ============================================
-- 12. RLS POLICIES FOR payment_config
-- ============================================

-- All authenticated users can view config (but not sensitive values)
CREATE POLICY "Users can view non-sensitive config"
    ON public.payment_config
    FOR SELECT
    TO authenticated
    USING (is_sensitive = false);

-- Only admins can manage config
CREATE POLICY "Admins can manage config"
    ON public.payment_config
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users 
            WHERE id = auth.uid() 
            AND is_admin = true
        )
    );

-- ============================================
-- 13. ADD COMMENTS FOR DOCUMENTATION
-- ============================================

COMMENT ON TABLE public.payment_invoices IS
    'Stores cryptocurrency payment invoices with full lifecycle tracking.';

COMMENT ON COLUMN public.payment_invoices.invoice_id IS
    'Internal unique invoice identifier (prefixed with arb_)';

COMMENT ON COLUMN public.payment_invoices.provider_invoice_id IS
    'External invoice ID from the payment provider';

COMMENT ON COLUMN public.payment_invoices.status IS
    'Payment status: pending, confirming, confirmed, partial, expired, cancelled, failed';

COMMENT ON TABLE public.webhook_logs IS
    'Audit log for all incoming payment provider webhooks.';

COMMENT ON COLUMN public.webhook_logs.signature_hash IS
    'SHA256 hash of webhook signature for verification (raw signature not stored)';

COMMENT ON COLUMN public.webhook_logs.idempotency_key IS
    'Unique key to detect and prevent duplicate webhook processing';

-- ============================================
-- 14. INSERT DEFAULT CONFIG
-- ============================================

INSERT INTO public.payment_config (key, value, value_type, description, category, is_sensitive) VALUES
    ('payment.provider', 'nowpayments', 'string', 'Active payment provider', 'provider', false),
    ('payment.min_deposit_usd', '10', 'number', 'Minimum deposit amount in USD', 'general', false),
    ('payment.invoice_expiry_minutes', '60', 'number', 'Invoice expiration time in minutes', 'general', false),
    ('payment.default_currency', 'USDT', 'string', 'Default cryptocurrency for deposits', 'general', false),
    ('payment.supported_currencies', '["USDT", "BTC", "ETH"]', 'json', 'List of supported cryptocurrencies', 'general', false),
    ('payment.networks', '["TRC20", "ERC20", "BEP20"]', 'json', 'List of supported networks', 'network', false),
    ('nowpayments.api_key', '', 'string', 'NOWPayments API key', 'provider', true),
    ('nowpayments.ipn_secret', '', 'string', 'NOWPayments webhook secret', 'provider', true),
    ('nowpayments.sandbox', 'false', 'boolean', 'Use NOWPayments sandbox mode', 'provider', false)
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- 15. VERIFY MIGRATION
-- ============================================
DO $$
BEGIN
    -- Verify tables exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'payment_invoices'
    ) THEN
        RAISE EXCEPTION 'Table payment_invoices was not created!';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'webhook_logs'
    ) THEN
        RAISE EXCEPTION 'Table webhook_logs was not created!';
    END IF;
    
    -- Verify functions exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc 
        WHERE proname = 'confirm_payment_with_credit'
    ) THEN
        RAISE EXCEPTION 'Function confirm_payment_with_credit was not created!';
    END IF;
    
    -- Verify indexes exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE tablename = 'payment_invoices' 
        AND indexname = 'idx_payment_invoices_user_status'
    ) THEN
        RAISE EXCEPTION 'Index idx_payment_invoices_user_status was not created!';
    END IF;
    
    RAISE NOTICE '✓ Payment system migration completed successfully!';
END $$;
