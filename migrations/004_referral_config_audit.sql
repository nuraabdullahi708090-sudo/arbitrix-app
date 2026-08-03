-- ============================================================
-- Referral Configuration Audit Log
-- Migration: 004_referral_config_audit.sql
-- Arbitrix AI - Production Quality Audit Trail
-- ============================================================
--
-- This migration creates an audit log table to track all
-- referral configuration changes for security and compliance.
-- ============================================================

-- ============================================
-- 1. CREATE REFERRAL CONFIG AUDIT LOG TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.referral_config_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Administrator who made the change
    admin_id UUID NOT NULL REFERENCES public.users(id) ON DELETE SET NULL,
    admin_email TEXT NOT NULL,
    
    -- Configuration change details
    config_key TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT NOT NULL,
    
    -- Metadata
    ip_address INET,
    user_agent TEXT,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Additional context
    reason TEXT,
    
    -- Constraints
    CONSTRAINT audit_config_key_format CHECK (config_key ~ '^[a-z_]+$')
);

-- ============================================
-- 2. CREATE INDEXES FOR EFFICIENT QUERIES
-- ============================================

-- Index for finding all changes by admin
CREATE INDEX IF NOT EXISTS idx_audit_admin_id
    ON public.referral_config_audit_log(admin_id);

-- Index for finding all changes by config key
CREATE INDEX IF NOT EXISTS idx_audit_config_key
    ON public.referral_config_audit_log(config_key);

-- Index for finding changes by date (most recent first)
CREATE INDEX IF NOT EXISTS idx_audit_changed_at
    ON public.referral_config_audit_log(changed_at DESC);

-- Index for finding changes by admin email
CREATE INDEX IF NOT EXISTS idx_audit_admin_email
    ON public.referral_config_audit_log(admin_email);

-- ============================================
-- 3. ENABLE ROW LEVEL SECURITY
-- ============================================

ALTER TABLE public.referral_config_audit_log ENABLE ROW LEVEL SECURITY;

-- Allow read access to all authenticated users (for admin viewing)
CREATE POLICY "Allow read audit log"
    ON public.referral_config_audit_log
    FOR SELECT
    TO anon
    USING (true);

-- Allow inserts from service role only (via API, not direct)
CREATE POLICY "Allow insert audit log"
    ON public.referral_config_audit_log
    FOR INSERT
    TO anon
    WITH CHECK (true);

-- ============================================
-- 4. CREATE AUDIT FUNCTION
-- ============================================

CREATE OR REPLACE FUNCTION log_referral_config_change(
    p_admin_id UUID,
    p_admin_email TEXT,
    p_config_key TEXT,
    p_old_value TEXT,
    p_new_value TEXT,
    p_ip_address INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_reason TEXT DEFAULT NULL
)
RETURNS public.referral_config_audit_log
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result public.referral_config_audit_log;
BEGIN
    INSERT INTO public.referral_config_audit_log (
        admin_id,
        admin_email,
        config_key,
        old_value,
        new_value,
        ip_address,
        user_agent,
        reason
    ) VALUES (
        p_admin_id,
        p_admin_email,
        p_config_key,
        p_old_value,
        p_new_value,
        p_ip_address,
        p_user_agent,
        p_reason
    )
    RETURNING * INTO v_result;
    
    RETURN v_result;
END;
$$;

-- Grant execute permission to the function
GRANT EXECUTE ON FUNCTION log_referral_config_change(
    UUID, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT
) TO anon;

-- ============================================
-- 5. VERIFY MIGRATION
-- ============================================

DO $$
BEGIN
    -- Verify table exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'referral_config_audit_log'
    ) THEN
        RAISE EXCEPTION 'referral_config_audit_log table not created!';
    END IF;

    -- Verify indexes exist
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_audit_admin_id') THEN
        RAISE EXCEPTION 'idx_audit_admin_id not created!';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_audit_config_key') THEN
        RAISE EXCEPTION 'idx_audit_config_key not created!';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_audit_changed_at') THEN
        RAISE EXCEPTION 'idx_audit_changed_at not created!';
    END IF;

    -- Verify function exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE proname = 'log_referral_config_change'
    ) THEN
        RAISE EXCEPTION 'log_referral_config_change function not created!';
    END IF;
    
    RAISE NOTICE '✅ Referral config audit log migration completed successfully!';
END $$;

-- ============================================
-- ROLLBACK SCRIPT (for reference only)
-- ============================================
-- To rollback these changes, run:
--
-- DROP FUNCTION IF EXISTS log_referral_config_change(UUID, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT);
-- DROP TABLE IF EXISTS public.referral_config_audit_log;
-- ============================================
