-- ============================================
-- Payment System Migration
-- Arbitrix AI - Production Migration
-- ============================================
-- SCHEMA NOTES:
-- - Uses BIGINT for user_id to match existing users(id)
-- - RLS IS DISABLED (authorization via application code)
-- - This is required because Supabase Auth uses UUIDs but users.id is BIGINT
-- ============================================

-- ============================================
-- 1. CREATE PAYMENT_INVOICES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.payment_invoices (
    id BIGSERIAL PRIMARY KEY,
    invoice_id TEXT NOT NULL UNIQUE,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    amount_usd DECIMAL(18, 2) NOT NULL CHECK (amount_usd > 0),
    amount_crypto DECIMAL(18, 8),
    currency TEXT NOT NULL DEFAULT 'USDT',
    network TEXT NOT NULL DEFAULT 'TRC20',
    wallet_address TEXT,
    provider TEXT NOT NULL DEFAULT 'nowpayments',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirming', 'confirmed', 'partial', 'expired', 'cancelled', 'failed')),
    transaction_hash TEXT UNIQUE,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    credited_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    expired_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    provider_invoice_id TEXT,
    metadata JSONB DEFAULT '{}',
    idempotency_key TEXT
);

-- ============================================
-- 2. CREATE WEBHOOK_LOGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.webhook_logs (
    id BIGSERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    event_type TEXT,
    payload JSONB NOT NULL,
    signature_hash TEXT,
    idempotency_key TEXT,
    status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'failed', 'duplicate')),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    result JSONB,
    related_invoice_id BIGINT REFERENCES public.payment_invoices(id),
    source_ip INET
);

-- ============================================
-- 3. CREATE PAYMENT_CONFIG TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.payment_config (
    id BIGSERIAL PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    value TEXT,
    value_type TEXT NOT NULL DEFAULT 'string' CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
    description TEXT,
    category TEXT DEFAULT 'general' CHECK (category IN ('general', 'provider', 'network', 'security', 'notification')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ,
    created_by BIGINT REFERENCES public.users(id),
    is_sensitive BOOLEAN NOT NULL DEFAULT FALSE
);

-- ============================================
-- 4. CREATE INDEXES FOR payment_invoices
-- ============================================
CREATE INDEX idx_pi_invoice_id ON public.payment_invoices(invoice_id);
CREATE INDEX idx_pi_user_id ON public.payment_invoices(user_id);
CREATE INDEX idx_pi_user_status ON public.payment_invoices(user_id, status) WHERE status IN ('pending', 'confirming');
CREATE INDEX idx_pi_status ON public.payment_invoices(status) WHERE status IN ('pending', 'confirming');
CREATE INDEX idx_pi_provider_id ON public.payment_invoices(provider_invoice_id) WHERE provider_invoice_id IS NOT NULL;
CREATE INDEX idx_pi_wallet ON public.payment_invoices(wallet_address) WHERE wallet_address IS NOT NULL;
CREATE INDEX idx_pi_created_at ON public.payment_invoices(created_at DESC);
CREATE INDEX idx_pi_user_created ON public.payment_invoices(user_id, created_at DESC);
CREATE INDEX idx_pi_tx_hash ON public.payment_invoices(transaction_hash) WHERE transaction_hash IS NOT NULL;

-- ============================================
-- 5. CREATE INDEXES FOR webhook_logs
-- ============================================
CREATE INDEX idx_wl_idem_key ON public.webhook_logs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_wl_provider_status ON public.webhook_logs(provider, status) WHERE status IN ('failed', 'pending');
CREATE INDEX idx_wl_received_at ON public.webhook_logs(received_at DESC);
CREATE INDEX idx_wl_related_invoice ON public.webhook_logs(related_invoice_id) WHERE related_invoice_id IS NOT NULL;

-- ============================================
-- 6. NOTE: RLS IS DISABLED
-- ============================================
-- RLS is DISABLED because Supabase Auth uses UUIDs but users.id is BIGINT.
-- PostgreSQL cannot cast UUID to BIGINT.
-- Authorization is handled by application code via JWT tokens and authMiddleware.

-- ============================================
-- 7. CREATE ATOMIC PAYMENT FUNCTION
-- ============================================
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
        confirmed_at = NOW(),
        credited_at = NOW(),
        updated_at = NOW(),
        transaction_hash = COALESCE(p_transaction_hash, transaction_hash)
    WHERE id = p_invoice_id;

    INSERT INTO transactions (user_id, type, amount, detail, created_at)
    VALUES (p_user_id, 'Deposit', p_amount_usd, 'Payment confirmed - ' || COALESCE(p_transaction_hash, 'Internal'), NOW());

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
                VALUES (v_referrer_id, 'Referral Bonus', v_referral_reward, 'Referral bonus for first deposit - User: ' || p_user_id::TEXT, NOW());
            END IF;
        EXCEPTION WHEN OTHERS THEN
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
        'is_first_deposit', v_is_first_deposit,
        'referral_bonus', v_referral_reward
    );
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ============================================
-- 8. CREATE WEBHOOK CLEANUP FUNCTION
-- ============================================
CREATE OR REPLACE FUNCTION public.cleanup_old_webhook_logs()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE deleted_count INTEGER;
BEGIN
    DELETE FROM webhook_logs WHERE received_at < NOW() - INTERVAL '30 days' AND status IN ('processed', 'duplicate', 'failed');
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RAISE NOTICE 'Cleaned up % old webhook logs', deleted_count;
    RETURN deleted_count;
END;
$$;

-- ============================================
-- 9. CREATE EXPIRED INVOICE CHECK FUNCTION
-- ============================================
CREATE OR REPLACE FUNCTION public.mark_expired_invoices()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE expired_count INTEGER;
BEGIN
    UPDATE payment_invoices
    SET status = 'expired', expired_at = NOW(), updated_at = NOW()
    WHERE status = 'pending' AND expires_at < NOW();
    GET DIAGNOSTICS expired_count = ROW_COUNT;
    RAISE NOTICE 'Marked % invoices as expired', expired_count;
    RETURN expired_count;
END;
$$;

-- ============================================
-- 10. INSERT DEFAULT CONFIG
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
-- 11. VERIFY
-- ============================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payment_invoices') THEN RAISE EXCEPTION 'payment_invoices failed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'webhook_logs') THEN RAISE EXCEPTION 'webhook_logs failed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payment_config') THEN RAISE EXCEPTION 'payment_config failed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'confirm_payment_with_credit') THEN RAISE EXCEPTION 'confirm_payment_with_credit failed'; END IF;
    RAISE NOTICE 'Payment system migration OK - BIGINT schema, no RLS';
END $$;
