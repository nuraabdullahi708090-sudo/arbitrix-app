-- ============================================
-- MIGRATION: 005 - Email 2FA Implementation
-- ============================================
-- Email-based two-factor authentication
--
-- SCHEMA NOTES:
-- - Uses BIGINT for user_id to match existing users(id) column type
-- - RLS IS DISABLED on all tables
-- - Authorization is handled by application code via JWT tokens
-- - Codes are hashed before storage (SHA256)
-- - Codes expire after 10 minutes
-- - Codes can only be used once
-- ============================================

-- ============================================
-- 1. EMAIL VERIFICATION CODES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.email_verification_codes (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'login_2fa' CHECK (purpose IN ('login_2fa', 'password_reset', 'email_change')),
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address INET,
    user_agent TEXT
);

-- ============================================
-- 2. EMAIL 2FA VERIFICATION ATTEMPTS LOG
-- ============================================
CREATE TABLE IF NOT EXISTS public.email_2fa_attempts (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    success BOOLEAN NOT NULL DEFAULT FALSE,
    failure_reason TEXT,
    ip_address INET,
    user_agent TEXT,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- 3. CREATE INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_email_verification_user ON public.email_verification_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_code ON public.email_verification_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_email_verification_active ON public.email_verification_codes(user_id, used) WHERE used = FALSE;
CREATE INDEX IF NOT EXISTS idx_email_verification_expires ON public.email_verification_codes(expires_at) WHERE used = FALSE;
CREATE INDEX IF NOT EXISTS idx_email_2fa_attempts_user ON public.email_2fa_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_email_2fa_attempts_time ON public.email_2fa_attempts(attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_2fa_attempts_user_time ON public.email_2fa_attempts(user_id, attempted_at DESC);

-- ============================================
-- 4. DISABLE RLS (Required for BIGINT compatibility)
-- ============================================
ALTER TABLE public.email_verification_codes DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_2fa_attempts DISABLE ROW LEVEL SECURITY;

-- ============================================
-- 5. CLEANUP FUNCTION
-- ============================================
CREATE OR REPLACE FUNCTION cleanup_expired_email_codes()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Delete all expired codes (regardless of used status)
    DELETE FROM public.email_verification_codes
    WHERE expires_at < NOW();
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    RAISE NOTICE 'Cleaned up % expired email verification codes', deleted_count;
    
    RETURN deleted_count;
END;
$$;

-- ============================================
-- 6. AUTO-CLEANUP TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION trigger_cleanup_old_email_codes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Delete codes older than 24 hours when a new code is created
    -- This is a safety net for cleanup
    DELETE FROM public.email_verification_codes
    WHERE created_at < NOW() - INTERVAL '24 hours';
    
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cleanup_old_email_codes ON public.email_verification_codes;
CREATE TRIGGER trg_cleanup_old_email_codes
    AFTER INSERT ON public.email_verification_codes
    FOR EACH ROW
    EXECUTE FUNCTION trigger_cleanup_old_email_codes();

-- ============================================
-- 7. FEATURE FLAG TABLE (for TOTP re-enablement)
-- ============================================
CREATE TABLE IF NOT EXISTS public.feature_flags (
    id BIGSERIAL PRIMARY KEY,
    flag_key TEXT NOT NULL UNIQUE,
    flag_value TEXT NOT NULL DEFAULT 'false',
    description TEXT,
    enabled_for_all BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default value for 2FA type
INSERT INTO public.feature_flags (flag_key, flag_value, description)
VALUES (
    '2fa_type',
    'email',
    'Controls 2FA type: "email" for email codes, "totp" for authenticator app'
)
ON CONFLICT (flag_key) DO NOTHING;

-- Index for feature flags
CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_flags_key ON public.feature_flags(flag_key);

-- ============================================
-- 8. UPDATED_AT TRIGGER FOR FEATURE FLAGS
-- ============================================
CREATE OR REPLACE FUNCTION update_feature_flags_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS feature_flags_updated_at ON public.feature_flags;
CREATE TRIGGER feature_flags_updated_at
    BEFORE UPDATE ON public.feature_flags
    FOR EACH ROW EXECUTE FUNCTION update_feature_flags_updated_at();

-- ============================================
-- 9. DISABLE RLS ON FEATURE FLAGS
-- ============================================
ALTER TABLE public.feature_flags DISABLE ROW LEVEL SECURITY;

-- ============================================
-- 10. VERIFY
-- ============================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'email_verification_codes') THEN
        RAISE EXCEPTION 'email_verification_codes table not created';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'email_2fa_attempts') THEN
        RAISE EXCEPTION 'email_2fa_attempts table not created';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'feature_flags') THEN
        RAISE EXCEPTION 'feature_flags table not created';
    END IF;
    
    -- Verify feature flag exists
    IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_key = '2fa_type') THEN
        RAISE EXCEPTION '2fa_type feature flag not created';
    END IF;
    
    RAISE NOTICE '✅ Email 2FA migration completed successfully';
    RAISE NOTICE '   - email_verification_codes table created';
    RAISE NOTICE '   - email_2fa_attempts table created';
    RAISE NOTICE '   - feature_flags table created';
    RAISE NOTICE '   - 2fa_type feature flag set to "email" by default';
END $$;
