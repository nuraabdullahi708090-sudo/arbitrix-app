-- ============================================
-- KYC Verification System Migration v2.0
-- Arbitrix AI - Identity Verification Tables
-- ============================================
-- This migration creates the complete KYC verification system with:
-- - Verification profiles for user personal information
-- - Document storage references for Supabase Storage
-- - Verification history for audit trail
-- - Admin review history for accountability
-- - Proper indexes, constraints
--
-- SCHEMA NOTES:
-- - Uses BIGINT for user_id to match existing users(id) column type
-- - RLS IS DISABLED on all tables
-- - Authorization is handled by application code via JWT tokens and authMiddleware
-- - This is required because Supabase Auth uses UUIDs but users.id is BIGINT
-- ============================================

-- ============================================
-- 1. CREATE VERIFICATION_PROFILES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.verification_profiles (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
    full_legal_name TEXT NOT NULL,
    date_of_birth DATE NOT NULL,
    country TEXT NOT NULL,
    residential_address TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN (
        'not_started', 'pending_review', 'approved', 'rejected', 'resubmission_required'
    )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,
    reviewed_at TIMESTAMPTZ,
    rejection_reason TEXT,
    reviewed_by BIGINT REFERENCES public.users(id),
    version INTEGER NOT NULL DEFAULT 1
);

-- ============================================
-- 2. CREATE VERIFICATION_DOCUMENTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.verification_documents (
    id BIGSERIAL PRIMARY KEY,
    verification_id BIGINT NOT NULL REFERENCES public.verification_profiles(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    document_type TEXT NOT NULL CHECK (document_type IN (
        'national_id_front', 'national_id_back', 'passport',
        'drivers_license_front', 'drivers_license_back', 'selfie_with_id'
    )),
    original_filename TEXT NOT NULL,
    stored_filename TEXT NOT NULL,
    storage_path TEXT,
    file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 10485760),
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    file_hash TEXT NOT NULL,
    is_uploaded BOOLEAN NOT NULL DEFAULT TRUE,
    upload_completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    replaced_at TIMESTAMPTZ
);

-- ============================================
-- 3. CREATE VERIFICATION_HISTORY TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.verification_history (
    id BIGSERIAL PRIMARY KEY,
    verification_id BIGINT NOT NULL REFERENCES public.verification_profiles(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    previous_status TEXT,
    new_status TEXT NOT NULL,
    changed_fields TEXT[],
    change_summary TEXT,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- 4. CREATE ADMIN_REVIEW_HISTORY TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.admin_review_history (
    id BIGSERIAL PRIMARY KEY,
    verification_id BIGINT NOT NULL REFERENCES public.verification_profiles(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    admin_id BIGINT NOT NULL REFERENCES public.users(id),
    action TEXT NOT NULL CHECK (action IN (
        'approved', 'rejected', 'requested_resubmission', 'viewed', 'downloaded_document'
    )),
    reason TEXT,
    notes TEXT,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- 5. CREATE INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_verification_profiles_user_id ON public.verification_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_verification_profiles_status ON public.verification_profiles(status) WHERE status IN ('pending_review', 'rejected', 'resubmission_required');
CREATE INDEX IF NOT EXISTS idx_verification_profiles_submitted_at ON public.verification_profiles(submitted_at DESC) WHERE submitted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_verification_documents_verification_id ON public.verification_documents(verification_id);
CREATE INDEX IF NOT EXISTS idx_verification_documents_user_id ON public.verification_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_verification_documents_type ON public.verification_documents(document_type);
CREATE INDEX IF NOT EXISTS idx_verification_documents_active ON public.verification_documents(user_id, is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_verification_history_verification_id ON public.verification_history(verification_id);
CREATE INDEX IF NOT EXISTS idx_verification_history_user_id ON public.verification_history(user_id);
CREATE INDEX IF NOT EXISTS idx_verification_history_created_at ON public.verification_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_review_history_verification_id ON public.admin_review_history(verification_id);
CREATE INDEX IF NOT EXISTS idx_admin_review_history_admin_id ON public.admin_review_history(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_review_history_user_id ON public.admin_review_history(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_review_history_created_at ON public.admin_review_history(created_at DESC);

-- ============================================
-- 6. NOTE: RLS IS DISABLED
-- ============================================
-- RLS is DISABLED because Supabase Auth uses UUIDs but users.id is BIGINT.
-- PostgreSQL cannot cast UUID to BIGINT.
-- Authorization is handled by application code via JWT tokens and authMiddleware.

-- ============================================
-- 7. CREATE TRIGGER FOR updated_at
-- ============================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_verification_profiles_updated_at
    BEFORE UPDATE ON public.verification_profiles
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_verification_documents_updated_at
    BEFORE UPDATE ON public.verification_documents
    FOR EACH ROW EXECUTE FUNCTION public.update_verification_documents_updated_at();

-- ============================================
-- 8. CREATE HELPER FUNCTION
-- ============================================
CREATE OR REPLACE FUNCTION public.check_user_verification_status(p_user_id BIGINT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_status TEXT;
BEGIN
    SELECT status INTO v_status FROM public.verification_profiles WHERE user_id = p_user_id;
    RETURN COALESCE(v_status, 'not_started');
END;
$$;

-- ============================================
-- 9. COMMENTS
-- ============================================
COMMENT ON TABLE public.verification_profiles IS 'Stores user KYC verification personal information and status.';
COMMENT ON TABLE public.verification_documents IS 'Stores uploaded identity documents for KYC verification.';
COMMENT ON TABLE public.verification_history IS 'Audit log of all verification status changes.';
COMMENT ON TABLE public.admin_review_history IS 'Audit log of all admin actions on verification reviews.';

-- ============================================
-- 10. STORAGE BUCKET
-- ============================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('kyc-documents', 'kyc-documents', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp']::text[])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Service role can manage KYC documents" ON storage.objects;
CREATE POLICY "Service role can manage KYC documents"
    ON storage.objects FOR ALL TO service_role
    USING (bucket_id = 'kyc-documents') WITH CHECK (bucket_id = 'kyc-documents');

-- ============================================
-- 11. CONFIG
-- ============================================
INSERT INTO public.payment_config (key, value, value_type, description, category, is_sensitive) VALUES
    ('kyc.enabled', 'true', 'boolean', 'Enable/disable KYC verification requirement', 'security', false),
    ('kyc.require_for_withdrawal', 'true', 'boolean', 'Require KYC approval before first withdrawal', 'security', false),
    ('kyc.min_document_count', '2', 'number', 'Minimum number of documents required', 'security', false),
    ('kyc.max_file_size_mb', '10', 'number', 'Maximum document file size in MB', 'security', false),
    ('kyc.allowed_formats', '["image/jpeg", "image/png", "image/webp"]', 'json', 'Allowed document MIME types', 'security', false)
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- 12. VERIFY
-- ============================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'verification_profiles') THEN
        RAISE EXCEPTION 'verification_profiles not created';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'verification_documents') THEN
        RAISE EXCEPTION 'verification_documents not created';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'verification_history') THEN
        RAISE EXCEPTION 'verification_history not created';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'admin_review_history') THEN
        RAISE EXCEPTION 'admin_review_history not created';
    END IF;
    RAISE NOTICE 'KYC migration completed - RLS disabled, BIGINT schema';
END $$;
