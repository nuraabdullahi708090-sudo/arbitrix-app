-- ============================================
-- KYC Verification System Migration v2.0
-- ============================================
-- Uses BIGINT for user_id to match existing users(id)
-- RLS IS DISABLED - authorization via application code (JWT)
-- ============================================
--
-- IMPORTANT: RLS MUST be explicitly disabled because:
-- 1. Supabase Auth uses UUIDs but users.id is BIGINT
-- 2. PostgreSQL cannot cast UUID to BIGINT in RLS policies
-- 3. RLS is ENABLED by default on all new tables in Supabase
-- ============================================

-- ============================================
-- 1. DISABLE RLS (Required for BIGINT compatibility)
-- ============================================
-- RLS must be explicitly disabled because Supabase Auth uses UUIDs but users.id is BIGINT.
-- PostgreSQL cannot cast UUID to BIGINT in RLS policies.
-- Authorization is handled by application code via JWT tokens and authMiddleware.
ALTER TABLE public.verification_profiles DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_history DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_review_history DISABLE ROW LEVEL SECURITY;

-- ============================================
-- 2. CREATE TABLES
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
-- 3. CREATE INDEXES
-- ============================================

CREATE INDEX idx_vp_user_id ON public.verification_profiles(user_id);
CREATE INDEX idx_vp_status ON public.verification_profiles(status) WHERE status IN ('pending_review', 'rejected', 'resubmission_required');
CREATE INDEX idx_vp_submitted ON public.verification_profiles(submitted_at DESC) WHERE submitted_at IS NOT NULL;
CREATE INDEX idx_vd_ver_id ON public.verification_documents(verification_id);
CREATE INDEX idx_vd_user_id ON public.verification_documents(user_id);
CREATE INDEX idx_vd_type ON public.verification_documents(document_type);
CREATE INDEX idx_vd_active ON public.verification_documents(user_id, is_active) WHERE is_active = TRUE;
CREATE INDEX idx_vh_ver_id ON public.verification_history(verification_id);
CREATE INDEX idx_vh_user_id ON public.verification_history(user_id);
CREATE INDEX idx_vh_created ON public.verification_history(created_at DESC);
CREATE INDEX idx_arh_ver_id ON public.admin_review_history(verification_id);
CREATE INDEX idx_arh_admin_id ON public.admin_review_history(admin_id);
CREATE INDEX idx_arh_user_id ON public.admin_review_history(user_id);
CREATE INDEX idx_arh_created ON public.admin_review_history(created_at DESC);

-- ============================================
-- 3. CREATE FUNCTIONS (before triggers)
-- ============================================

CREATE OR REPLACE FUNCTION public.update_vp_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.update_vd_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.check_verification_status(p_user_id BIGINT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_status TEXT;
BEGIN
    SELECT status INTO v_status FROM public.verification_profiles WHERE user_id = p_user_id;
    RETURN COALESCE(v_status, 'not_started');
END;
$$;

-- ============================================
-- 4. CREATE TRIGGERS (after functions)
-- ============================================

CREATE TRIGGER trg_vp_updated_at
    BEFORE UPDATE ON public.verification_profiles
    FOR EACH ROW EXECUTE FUNCTION public.update_vp_updated_at();

CREATE TRIGGER trg_vd_updated_at
    BEFORE UPDATE ON public.verification_documents
    FOR EACH ROW EXECUTE FUNCTION public.update_vd_updated_at();

-- ============================================
-- 5. STORAGE BUCKET
-- ============================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('kyc-documents', 'kyc-documents', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp']::text[])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "svc_kyc_manage" ON storage.objects;
CREATE POLICY svc_kyc_manage ON storage.objects FOR ALL TO service_role
    USING (bucket_id = 'kyc-documents') WITH CHECK (bucket_id = 'kyc-documents');

-- ============================================
-- 6. VERIFY
-- ============================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'verification_profiles') THEN RAISE EXCEPTION 'vp failed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'verification_documents') THEN RAISE EXCEPTION 'vd failed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'verification_history') THEN RAISE EXCEPTION 'vh failed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'admin_review_history') THEN RAISE EXCEPTION 'arh failed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_vp_updated_at') THEN RAISE EXCEPTION 'fn_vp failed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_vd_updated_at') THEN RAISE EXCEPTION 'fn_vd failed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_vp_updated_at') THEN RAISE EXCEPTION 'trg_vp failed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_vd_updated_at') THEN RAISE EXCEPTION 'trg_vd failed'; END IF;
    RAISE NOTICE 'KYC migration OK - BIGINT, no RLS';
END $$;
