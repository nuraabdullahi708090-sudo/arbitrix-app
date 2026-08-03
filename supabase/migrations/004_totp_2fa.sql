-- ============================================
-- MIGRATION: 004 - TOTP 2FA Implementation
-- ============================================
-- RFC 6238 compliant Time-based One-Time Password authentication
-- Compatible with Google Authenticator, Microsoft Authenticator, Authy
--
-- SCHEMA NOTES:
-- - Uses BIGINT for user_id to match existing users(id) column type
-- - RLS IS DISABLED on all tables
-- - Authorization is handled by application code via JWT tokens and authMiddleware
-- - This is required because Supabase Auth uses UUIDs but users.id is BIGINT
-- ============================================

-- ============================================
-- 1. TWO-FACTOR AUTHENTICATION PROFILES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.twofa_profiles (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
    encrypted_secret TEXT,
    is_enabled BOOLEAN NOT NULL DEFAULT false,
    is_verified BOOLEAN NOT NULL DEFAULT false,
    setup_completed_at TIMESTAMPTZ,
    enabled_at TIMESTAMPTZ,
    last_verified_at TIMESTAMPTZ,
    backup_codes_hash TEXT,
    backup_codes_remaining INTEGER DEFAULT 10,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- 2. 2FA VERIFICATION ATTEMPTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.twofa_attempts (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address INET,
    user_agent TEXT,
    success BOOLEAN NOT NULL DEFAULT false
);

-- ============================================
-- 3. CREATE INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_twofa_profiles_user_id ON public.twofa_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_twofa_profiles_enabled ON public.twofa_profiles(is_enabled) WHERE is_enabled = true;
CREATE INDEX IF NOT EXISTS idx_twofa_attempts_user_code ON public.twofa_attempts(user_id, code_hash);
CREATE INDEX IF NOT EXISTS idx_twofa_attempts_used_at ON public.twofa_attempts(used_at);

-- ============================================
-- 4. NOTE: RLS IS DISABLED
-- ============================================
-- RLS is DISABLED because Supabase Auth uses UUIDs but users.id is BIGINT.
-- PostgreSQL cannot cast UUID to BIGINT.
-- Authorization is handled by application code via JWT tokens and authMiddleware.

-- ============================================
-- 5. UPDATED_AT TRIGGER
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
    FOR EACH ROW EXECUTE FUNCTION update_twofa_updated_at();

-- ============================================
-- 6. VERIFY
-- ============================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'twofa_profiles') THEN
        RAISE EXCEPTION 'twofa_profiles not created';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'twofa_attempts') THEN
        RAISE EXCEPTION 'twofa_attempts not created';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'twofa_profiles' AND column_name = 'encrypted_secret') THEN
        RAISE EXCEPTION 'encrypted_secret column not found';
    END IF;
    RAISE NOTICE 'TOTP 2FA migration completed - RLS disabled, BIGINT schema';
END $$;
