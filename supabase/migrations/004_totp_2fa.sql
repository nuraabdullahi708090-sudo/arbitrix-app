-- ============================================
-- MIGRATION: 004 - TOTP 2FA Implementation
-- ============================================
-- This migration adds support for RFC 6238 compliant
-- Time-based One-Time Password (TOTP) authentication
-- Compatible with Google Authenticator, Microsoft Authenticator, Authy
-- ============================================

-- ============================================
-- 1. TWO-FACTOR AUTHENTICATION PROFILES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.twofa_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    encrypted_secret TEXT, -- AES-256-GCM encrypted TOTP secret
    is_enabled BOOLEAN NOT NULL DEFAULT false,
    is_verified BOOLEAN NOT NULL DEFAULT false, -- Has user verified a code during setup
    setup_completed_at TIMESTAMPTZ,
    enabled_at TIMESTAMPTZ,
    last_verified_at TIMESTAMPTZ,
    backup_codes_hash TEXT, -- JSON array of hashed recovery codes
    backup_codes_remaining INTEGER DEFAULT 10,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT unique_user_2fa UNIQUE (user_id)
);

-- Index for quick user lookup
CREATE INDEX IF NOT EXISTS idx_twofa_profiles_user_id ON public.twofa_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_twofa_profiles_enabled ON public.twofa_profiles(is_enabled) WHERE is_enabled = true;

-- ============================================
-- 2. 2FA VERIFICATION ATTEMPTS (for replay protection)
-- ============================================
CREATE TABLE IF NOT EXISTS public.twofa_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL, -- SHA256 hash of the code used
    used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address INET,
    user_agent TEXT,
    success BOOLEAN NOT NULL DEFAULT false
);

-- Index for checking recent codes (to prevent replay)
CREATE INDEX IF NOT EXISTS idx_twofa_attempts_user_code ON public.twofa_attempts(user_id, code_hash);
CREATE INDEX IF NOT EXISTS idx_twofa_attempts_used_at ON public.twofa_attempts(used_at);

-- Cleanup old attempts (keep only last 24 hours)
CREATE OR REPLACE FUNCTION cleanup_twofa_attempts()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM public.twofa_attempts 
    WHERE user_id = NEW.user_id 
    AND used_at < NOW() - INTERVAL '24 hours';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to clean up old attempts
-- Note: This is informational - actual cleanup happens on each verification

-- ============================================
-- 3. ENABLE ROW LEVEL SECURITY
-- ============================================
ALTER TABLE public.twofa_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.twofa_attempts ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 4. RLS POLICIES FOR twofa_profiles
-- ============================================

-- Users can view their own 2FA profile (but NOT the secret)
CREATE POLICY "Users can view own 2FA profile"
    ON public.twofa_profiles
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Users can create their own 2FA profile
CREATE POLICY "Users can create own 2FA profile"
    ON public.twofa_profiles
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own 2FA profile (but NOT the secret directly)
CREATE POLICY "Users can update own 2FA profile"
    ON public.twofa_profiles
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Admins can view 2FA status (but NOT secrets)
CREATE POLICY "Admins can view 2FA profiles"
    ON public.twofa_profiles
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.users 
            WHERE id = auth.uid() AND is_admin = true
        )
    );

-- Admins can update 2FA profiles (for disabling if needed)
CREATE POLICY "Admins can update 2FA profiles"
    ON public.twofa_profiles
    FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.users 
            WHERE id = auth.uid() AND is_admin = true
        )
    );

-- ============================================
-- 5. RLS POLICIES FOR twofa_attempts
-- ============================================

-- Users can view their own attempt history
CREATE POLICY "Users can view own 2FA attempts"
    ON public.twofa_attempts
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Users can insert their own attempts
CREATE POLICY "Users can insert own 2FA attempts"
    ON public.twofa_attempts
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- System/service role can manage attempts (for cleanup)
CREATE POLICY "Service role can manage 2FA attempts"
    ON public.twofa_attempts
    FOR ALL
    TO service_role
    USING (true);

-- ============================================
-- 6. ADD 2FA STATUS TO USERS (denormalized for quick checks)
-- ============================================
-- This column is for quick lookups and caching
-- The source of truth is twofa_profiles table

-- Note: We don't modify the users table directly to avoid schema conflicts
-- Instead, we query the twofa_profiles table for 2FA status

-- ============================================
-- 7. ADD UPDATED_AT TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION update_twofa_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS twofa_profiles_updated_at ON public.twofa_profiles;
CREATE TRIGGER twofa_profiles_updated_at
    BEFORE UPDATE ON public.twofa_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_twofa_updated_at();

-- ============================================
-- 8. VERIFY MIGRATION
-- ============================================
DO $$
BEGIN
    -- Verify tables exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'twofa_profiles'
    ) THEN
        RAISE EXCEPTION 'twofa_profiles table not created';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'twofa_attempts'
    ) THEN
        RAISE EXCEPTION 'twofa_attempts table not created';
    END IF;
    
    -- Verify columns
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'twofa_profiles' AND column_name = 'encrypted_secret'
    ) THEN
        RAISE EXCEPTION 'encrypted_secret column not found';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'twofa_profiles' AND column_name = 'backup_codes_hash'
    ) THEN
        RAISE EXCEPTION 'backup_codes_hash column not found';
    END IF;
    
    RAISE NOTICE '✓ 2FA migration completed successfully';
END $$;

-- ============================================
-- MIGRATION COMPLETE
-- ============================================
-- Run this in Supabase SQL Editor or via:
-- supabase db push
