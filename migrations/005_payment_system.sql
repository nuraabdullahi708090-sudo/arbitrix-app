-- ============================================================
-- Payment System Database Improvements
-- Migration: 005_payment_system.sql
-- Arbitrix AI - Production Quality Payment System
-- ============================================================
--
-- This migration improves the payment/deposit tables with:
-- 1. Additional columns for better tracking
-- 2. Indexes for efficient queries
-- 3. Constraints for data integrity
-- 4. Audit logging for transactions
-- 5. Idempotency keys
-- ============================================================

-- ============================================
-- 1. ADD COLUMNS TO DEPOSITS TABLE
-- ============================================

-- Add missing columns to deposits table
ALTER TABLE public.deposits ADD COLUMN IF NOT EXISTS order_id TEXT;
ALTER TABLE public.deposits ADD COLUMN IF NOT EXISTS crypto_amount DECIMAL(20, 8);
ALTER TABLE public.deposits ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'demo';
ALTER TABLE public.deposits ADD COLUMN IF NOT EXISTS qr_code_url TEXT;
ALTER TABLE public.deposits ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE public.deposits ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE public.deposits ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Add unique constraint on idempotency_key
ALTER TABLE public.deposits ADD CONSTRAINT deposits_idempotency_key_unique UNIQUE (idempotency_key);

-- Add unique constraint on order_id
ALTER TABLE public.deposits ADD CONSTRAINT deposits_order_id_unique UNIQUE (order_id);

-- Add index on invoice_id for fast lookups
CREATE INDEX IF NOT EXISTS idx_deposits_invoice_id ON public.deposits(invoice_id);

-- Add index on status for filtering
CREATE INDEX IF NOT EXISTS idx_deposits_status ON public.deposits(status);

-- Add index on user_id for user's deposits
CREATE INDEX IF NOT EXISTS idx_deposits_user_id ON public.deposits(user_id);

-- Add index on created_at for sorting
CREATE INDEX IF NOT EXISTS idx_deposits_created_at ON public.deposits(created_at DESC);

-- Add composite index for common queries
CREATE INDEX IF NOT EXISTS idx_deposits_user_status ON public.deposits(user_id, status);

-- ============================================
-- 2. CREATE PAYMENT TRANSACTIONS AUDIT LOG
-- ============================================

CREATE TABLE IF NOT EXISTS public.payment_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Reference to deposit
    deposit_id UUID REFERENCES public.deposits(id) ON DELETE SET NULL,
    invoice_id TEXT,
    
    -- Event details
    event_type TEXT NOT NULL, -- 'created', 'pending', 'confirmed', 'expired', 'cancelled', 'failed'
    previous_status TEXT,
    new_status TEXT,
    
    -- Metadata
    ip_address INET,
    user_agent TEXT,
    provider TEXT,
    provider_response JSONB,
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for audit log
CREATE INDEX IF NOT EXISTS idx_payment_audit_deposit_id ON public.payment_audit_log(deposit_id);
CREATE INDEX IF NOT EXISTS idx_payment_audit_invoice_id ON public.payment_audit_log(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_audit_event_type ON public.payment_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_payment_audit_created_at ON public.payment_audit_log(created_at DESC);

-- ============================================
-- 3. CREATE WEBHOOK LOGS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.webhook_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Request details
    provider TEXT NOT NULL,
    event_type TEXT,
    headers JSONB,
    payload JSONB,
    
    -- Processing result
    processed BOOLEAN DEFAULT FALSE,
    processing_result JSONB,
    error_message TEXT,
    
    -- Idempotency
    idempotency_key TEXT,
    
    -- Timestamps
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- Indexes for webhook logs
CREATE INDEX IF NOT EXISTS idx_webhook_logs_provider ON public.webhook_logs(provider);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_event_type ON public.webhook_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_processed ON public.webhook_logs(processed);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_idempotency ON public.webhook_logs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_logs_received_at ON public.webhook_logs(received_at DESC);

-- ============================================
-- 4. CREATE PAYMENT PROVIDER CONFIG TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.payment_provider_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Provider details
    provider_name TEXT NOT NULL UNIQUE,
    is_active BOOLEAN DEFAULT FALSE,
    
    -- Configuration (encrypted in production)
    api_key_encrypted TEXT,
    api_secret_encrypted TEXT,
    webhook_secret_encrypted TEXT,
    config_data JSONB DEFAULT '{}',
    
    -- Supported networks
    supported_networks TEXT[] DEFAULT ARRAY['TRC20', 'ERC20', 'BEP20'],
    
    -- Payment addresses per network
    payment_addresses JSONB DEFAULT '{"TRC20": "", "ERC20": "", "BEP20": ""}',
    
    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- 5. CREATE PAYMENT TRANSACTION TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.payment_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Transaction reference
    deposit_id UUID REFERENCES public.deposits(id) ON DELETE SET NULL,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    
    -- Transaction details
    transaction_type TEXT NOT NULL, -- 'deposit', 'withdrawal', 'refund'
    amount DECIMAL(20, 2) NOT NULL,
    currency TEXT DEFAULT 'USDT',
    network TEXT,
    
    -- Status
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'confirmed', 'failed'
    
    -- Provider transaction
    provider_tx_id TEXT,
    provider_response JSONB,
    
    -- Blockchain transaction (for verification)
    blockchain_tx_hash TEXT,
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ
);

-- Indexes for payment transactions
CREATE INDEX IF NOT EXISTS idx_payment_tx_deposit_id ON public.payment_transactions(deposit_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_user_id ON public.payment_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_status ON public.payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_payment_tx_provider_tx ON public.payment_transactions(provider_tx_id) WHERE provider_tx_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_tx_created_at ON public.payment_transactions(created_at DESC);

-- ============================================
-- 6. ADD CONSTRAINTS
-- ============================================

-- Ensure amount is positive
ALTER TABLE public.deposits ADD CONSTRAINT deposits_amount_positive CHECK (amount > 0);

-- Ensure crypto_amount is positive if set
ALTER TABLE public.deposits ADD CONSTRAINT deposits_crypto_amount_positive CHECK (crypto_amount IS NULL OR crypto_amount > 0);

-- Ensure confirmed_at is set only for confirmed deposits
ALTER TABLE public.deposits ADD CONSTRAINT deposits_confirmed_at_check CHECK (
    (status = 'confirmed' AND confirmed_at IS NOT NULL) OR
    (status != 'confirmed' AND confirmed_at IS NULL) OR
    (confirmed_at IS NULL)
);

-- Ensure payment_transactions amount is positive
ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_tx_amount_positive CHECK (amount > 0);

-- ============================================
-- 7. UPDATE EXISTING DATA
-- ============================================

-- Set expires_at for existing pending deposits (1 hour from now)
UPDATE public.deposits
SET expires_at = NOW() + INTERVAL '1 hour'
WHERE status = 'pending' AND expires_at IS NULL;

-- Set provider for existing deposits
UPDATE public.deposits
SET provider = 'demo'
WHERE provider IS NULL;

-- ============================================
-- 8. ANALYZE TABLES
-- ============================================

ANALYZE public.deposits;
ANALYZE public.payment_audit_log;
ANALYZE public.webhook_logs;
ANALYZE public.payment_provider_config;
ANALYZE public.payment_transactions;

-- ============================================
-- 9. VERIFY MIGRATION
-- ============================================

DO $$
BEGIN
    -- Verify deposits table columns
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'deposits' AND column_name = 'order_id'
    ) THEN
        RAISE EXCEPTION 'order_id column not added to deposits!';
    END IF;

    -- Verify payment_audit_log table exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'payment_audit_log'
    ) THEN
        RAISE EXCEPTION 'payment_audit_log table not created!';
    END IF;

    -- Verify webhook_logs table exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'webhook_logs'
    ) THEN
        RAISE EXCEPTION 'webhook_logs table not created!';
    END IF;

    -- Verify indexes exist
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_deposits_invoice_id') THEN
        RAISE EXCEPTION 'idx_deposits_invoice_id not created!';
    END IF;

    RAISE NOTICE '✅ Payment system migration completed successfully!';
END $$;

-- ============================================
-- ROLLBACK SCRIPT (for reference only)
-- ============================================
-- To rollback these changes, run:
--
-- ALTER TABLE public.deposits DROP COLUMN IF EXISTS order_id;
-- ALTER TABLE public.deposits DROP COLUMN IF EXISTS crypto_amount;
-- ALTER TABLE public.deposits DROP COLUMN IF EXISTS provider;
-- ALTER TABLE public.deposits DROP COLUMN IF EXISTS qr_code_url;
-- ALTER TABLE public.deposits DROP COLUMN IF EXISTS confirmed_at;
-- ALTER TABLE public.deposits DROP COLUMN IF EXISTS expires_at;
-- ALTER TABLE public.deposits DROP COLUMN IF EXISTS idempotency_key;
-- ALTER TABLE public.deposits DROP CONSTRAINT IF EXISTS deposits_idempotency_key_unique;
-- ALTER TABLE public.deposits DROP CONSTRAINT IF EXISTS deposits_order_id_unique;
-- ALTER TABLE public.deposits DROP CONSTRAINT IF EXISTS deposits_amount_positive;
-- ALTER TABLE public.deposits DROP CONSTRAINT IF EXISTS deposits_crypto_amount_positive;
-- ALTER TABLE public.deposits DROP CONSTRAINT IF EXISTS deposits_confirmed_at_check;
-- DROP INDEX IF EXISTS idx_deposits_invoice_id;
-- DROP INDEX IF EXISTS idx_deposits_status;
-- DROP INDEX IF EXISTS idx_deposits_user_id;
-- DROP INDEX IF EXISTS idx_deposits_created_at;
-- DROP INDEX IF EXISTS idx_deposits_user_status;
-- DROP TABLE IF EXISTS public.payment_audit_log;
-- DROP TABLE IF EXISTS public.webhook_logs;
-- DROP TABLE IF EXISTS public.payment_provider_config;
-- DROP TABLE IF EXISTS public.payment_transactions;
-- ============================================
