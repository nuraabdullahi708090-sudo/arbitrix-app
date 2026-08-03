-- ============================================================
-- Referral Configuration Table
-- Migration: 003_referral_config.sql
-- Arbitrix AI - Dynamic Referral Configuration
-- ============================================================
--
-- This migration creates a table to store referral system configuration
-- allowing administrators to modify referral behavior without code changes.
-- ============================================================

-- ============================================
-- 1. CREATE REFERRAL CONFIG TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.referral_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Configuration keys and values
    config_key TEXT NOT NULL UNIQUE,
    config_value TEXT NOT NULL,
    
    -- Metadata
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT referral_config_key_format CHECK (config_key ~ '^[a-z_]+$')
);

-- ============================================
-- 2. INSERT DEFAULT CONFIGURATION
-- ============================================

INSERT INTO public.referral_config (config_key, config_value, description) VALUES
    ('rewards_enabled', 'true', 'Enable or disable referral rewards system-wide'),
    ('minimum_qualifying_deposit', '50', 'Minimum deposit amount required for referral qualification (in USD)'),
    ('referral_reward_amount', '10', 'Amount awarded to referrer when referral qualifies (in USD)'),
    ('first_deposit_required', 'true', 'Whether referral requires first deposit to qualify'),
    ('max_rewards_per_user', '0', 'Maximum number of referral rewards per user (0 = unlimited)')
ON CONFLICT (config_key) DO NOTHING;

-- ============================================
-- 3. CREATE INDEXES
-- ============================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_config_key ON public.referral_config(config_key);
CREATE INDEX IF NOT EXISTS idx_referral_config_updated ON public.referral_config(updated_at DESC);

-- ============================================
-- 4. ENABLE ROW LEVEL SECURITY
-- ============================================

ALTER TABLE public.referral_config ENABLE ROW LEVEL SECURITY;

-- Allow read access to all authenticated users
CREATE POLICY "Allow read referral config"
    ON public.referral_config
    FOR SELECT
    TO anon
    USING (true);

-- Allow admin updates
CREATE POLICY "Allow admin update referral config"
    ON public.referral_config
    FOR UPDATE
    TO anon
    USING (true)
    WITH CHECK (true);

-- Allow admin inserts (for future config additions)
CREATE POLICY "Allow admin insert referral config"
    ON public.referral_config
    FOR INSERT
    TO anon
    WITH CHECK (true);

-- ============================================
-- 5. CREATE UPDATE FUNCTION
-- ============================================

CREATE OR REPLACE FUNCTION update_referral_config(
    p_key TEXT,
    p_value TEXT
)
RETURNS public.referral_config
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result public.referral_config;
BEGIN
    UPDATE public.referral_config
    SET config_value = p_value, updated_at = NOW()
    WHERE config_key = p_key
    RETURNING * INTO v_result;
    
    IF v_result IS NULL THEN
        INSERT INTO public.referral_config (config_key, config_value)
        VALUES (p_key, p_value)
        RETURNING * INTO v_result;
    END IF;
    
    RETURN v_result;
END;
$$;

-- ============================================
-- 6. VERIFY MIGRATION
-- ============================================

DO $$
BEGIN
    -- Verify table exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'referral_config'
    ) THEN
        RAISE EXCEPTION 'referral_config table not created!';
    END IF;

    -- Verify default config values exist
    IF NOT EXISTS (SELECT 1 FROM public.referral_config WHERE config_key = 'rewards_enabled') THEN
        RAISE EXCEPTION 'rewards_enabled config not set!';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM public.referral_config WHERE config_key = 'minimum_qualifying_deposit') THEN
        RAISE EXCEPTION 'minimum_qualifying_deposit config not set!';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM public.referral_config WHERE config_key = 'referral_reward_amount') THEN
        RAISE EXCEPTION 'referral_reward_amount config not set!';
    END IF;
    
    RAISE NOTICE '✅ Referral config migration completed successfully!';
END $$;

-- ============================================
-- ROLLBACK SCRIPT (for reference only)
-- ============================================
-- To rollback these changes, run:
--
-- DROP FUNCTION IF EXISTS update_referral_config(TEXT, TEXT);
-- DROP TABLE IF EXISTS public.referral_config;
-- ============================================
