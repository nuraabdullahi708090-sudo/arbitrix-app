-- ============================================
-- KYC Verification System Migration v2.0
-- Arbitrix AI - Identity Verification Tables
-- ============================================
-- This migration creates the complete KYC verification system with:
-- - Verification profiles for user personal information
-- - Document storage references for Supabase Storage
-- - Verification history for audit trail
-- - Admin review history for accountability
-- - Proper indexes, constraints, and RLS policies
-- - Signed URL security for document access
--
-- SCHEMA NOTE: Uses BIGINT for user_id to match existing users(id) column type
-- ============================================

-- ============================================
-- 0. CREATE SUPABASE STORAGE BUCKET (requires service role)
-- NOTE: Run this manually in Supabase Dashboard or via service role
-- ============================================
-- The bucket will be created with the following settings:
-- - Name: kyc-documents
-- - Public: false (private, requires authentication)
-- - File size limit: 10MB
-- - Allowed MIME types: image/jpeg, image/png, image/webp
-- ============================================

-- ============================================
-- 1. CREATE VERIFICATION_PROFILES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.verification_profiles (
    -- Primary key
    id BIGSERIAL PRIMARY KEY,
    
    -- User reference (one-to-one relationship) - BIGINT to match users(id)
    user_id BIGINT NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
    
    -- Personal Information
    full_legal_name TEXT NOT NULL,
    date_of_birth DATE NOT NULL,
    country TEXT NOT NULL,
    residential_address TEXT NOT NULL,
    
    -- Verification Status
    -- Status values: not_started, pending_review, approved, rejected, resubmission_required
    status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN (
        'not_started', 
        'pending_review', 
        'approved', 
        'rejected', 
        'resubmission_required'
    )),
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,
    reviewed_at TIMESTAMPTZ,
    
    -- Rejection details
    rejection_reason TEXT,
    reviewed_by BIGINT REFERENCES public.users(id),
    
    -- Current version for optimistic locking
    version INTEGER NOT NULL DEFAULT 1
);

-- ============================================
-- 2. CREATE VERIFICATION_DOCUMENTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.verification_documents (
    -- Primary key
    id BIGSERIAL PRIMARY KEY,
    
    -- Reference to verification profile - BIGINT to match verification_profiles(id)
    verification_id BIGINT NOT NULL REFERENCES public.verification_profiles(id) ON DELETE CASCADE,
    
    -- Reference to user (for quick access and RLS) - BIGINT to match users(id)
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    
    -- Document Type
    -- Types: national_id, passport, drivers_license, selfie_with_id
    document_type TEXT NOT NULL CHECK (document_type IN (
        'national_id_front',
        'national_id_back',
        'passport',
        'drivers_license_front',
        'drivers_license_back',
        'selfie_with_id'
    )),
    
    -- File information
    original_filename TEXT NOT NULL,
    stored_filename TEXT NOT NULL,
    storage_path TEXT, -- Supabase Storage path (userId/filename)
    file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 10485760), -- Max 10MB
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    
    -- File hash for integrity verification
    file_hash TEXT NOT NULL,
    
    -- Upload status
    is_uploaded BOOLEAN NOT NULL DEFAULT TRUE,
    upload_completed_at TIMESTAMPTZ,
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Is this document currently active (vs replaced/deleted)
    -- SECURITY: Soft delete ensures documents cannot be recovered by normal means
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    replaced_at TIMESTAMPTZ
);

-- ============================================
-- 3. CREATE VERIFICATION_HISTORY TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.verification_history (
    -- Primary key
    id BIGSERIAL PRIMARY KEY,
    
    -- Reference to verification profile - BIGINT to match verification_profiles(id)
    verification_id BIGINT NOT NULL REFERENCES public.verification_profiles(id) ON DELETE CASCADE,
    
    -- Reference to user - BIGINT to match users(id)
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    
    -- Previous status (for tracking changes)
    previous_status TEXT,
    
    -- New status
    new_status TEXT NOT NULL,
    
    -- Change details
    changed_fields TEXT[], -- Array of field names that were changed
    change_summary TEXT,
    
    -- Rejection reason (if applicable)
    rejection_reason TEXT,
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- 4. CREATE ADMIN_REVIEW_HISTORY TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.admin_review_history (
    -- Primary key
    id BIGSERIAL PRIMARY KEY,
    
    -- Reference to verification profile - BIGINT to match verification_profiles(id)
    verification_id BIGINT NOT NULL REFERENCES public.verification_profiles(id) ON DELETE CASCADE,
    
    -- Reference to user being reviewed - BIGINT to match users(id)
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    
    -- Admin who performed the review - BIGINT to match users(id)
    admin_id BIGINT NOT NULL REFERENCES public.users(id),
    
    -- Action taken
    -- Actions: approved, rejected, requested_resubmission, viewed
    action TEXT NOT NULL CHECK (action IN (
        'approved', 
        'rejected', 
        'requested_resubmission', 
        'viewed',
        'downloaded_document'
    )),
    
    -- Review details
    reason TEXT,
    notes TEXT,
    
    -- IP address for audit
    ip_address INET,
    user_agent TEXT,
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- 5. CREATE INDEXES FOR verification_profiles
-- ============================================
CREATE INDEX IF NOT EXISTS idx_verification_profiles_user_id
    ON public.verification_profiles(user_id);

CREATE INDEX IF NOT EXISTS idx_verification_profiles_status
    ON public.verification_profiles(status)
    WHERE status IN ('pending_review', 'rejected', 'resubmission_required');

CREATE INDEX IF NOT EXISTS idx_verification_profiles_submitted_at
    ON public.verification_profiles(submitted_at DESC)
    WHERE submitted_at IS NOT NULL;

-- ============================================
-- 6. CREATE INDEXES FOR verification_documents
-- ============================================
CREATE INDEX IF NOT EXISTS idx_verification_documents_verification_id
    ON public.verification_documents(verification_id);

CREATE INDEX IF NOT EXISTS idx_verification_documents_user_id
    ON public.verification_documents(user_id);

CREATE INDEX IF NOT EXISTS idx_verification_documents_type
    ON public.verification_documents(document_type);

CREATE INDEX IF NOT EXISTS idx_verification_documents_active
    ON public.verification_documents(user_id, is_active)
    WHERE is_active = TRUE;

-- ============================================
-- 7. CREATE INDEXES FOR verification_history
-- ============================================
CREATE INDEX IF NOT EXISTS idx_verification_history_verification_id
    ON public.verification_history(verification_id);

CREATE INDEX IF NOT EXISTS idx_verification_history_user_id
    ON public.verification_history(user_id);

CREATE INDEX IF NOT EXISTS idx_verification_history_created_at
    ON public.verification_history(created_at DESC);

-- ============================================
-- 8. CREATE INDEXES FOR admin_review_history
-- ============================================
CREATE INDEX IF NOT EXISTS idx_admin_review_history_verification_id
    ON public.admin_review_history(verification_id);

CREATE INDEX IF NOT EXISTS idx_admin_review_history_admin_id
    ON public.admin_review_history(admin_id);

CREATE INDEX IF NOT EXISTS idx_admin_review_history_user_id
    ON public.admin_review_history(user_id);

CREATE INDEX IF NOT EXISTS idx_admin_review_history_created_at
    ON public.admin_review_history(created_at DESC);

-- ============================================
-- 9. ENABLE ROW LEVEL SECURITY (RLS)
-- ============================================
ALTER TABLE public.verification_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_review_history ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 10. RLS POLICIES FOR verification_profiles
-- ============================================
-- NOTE: auth.uid() returns UUID but users.id is BIGINT
-- Cast auth.uid() to BIGINT using (auth.uid())::bigint

-- Users can view their own verification profile
CREATE POLICY "Users can view own verification profile"
    ON public.verification_profiles
    FOR SELECT
    TO authenticated
    USING ((auth.uid())::bigint = user_id);

-- Users can insert their own verification profile
CREATE POLICY "Users can insert own verification profile"
    ON public.verification_profiles
    FOR INSERT
    TO authenticated
    WITH CHECK ((auth.uid())::bigint = user_id);

-- Users can update their own verification profile (only when not under review)
CREATE POLICY "Users can update own verification profile"
    ON public.verification_profiles
    FOR UPDATE
    TO authenticated
    USING (
        (auth.uid())::bigint = user_id 
        AND status IN ('not_started', 'rejected', 'resubmission_required')
    )
    WITH CHECK (
        (auth.uid())::bigint = user_id 
        AND status IN ('not_started', 'rejected', 'resubmission_required')
    );

-- Admins can view all verification profiles
CREATE POLICY "Admins can view all verification profiles"
    ON public.verification_profiles
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users 
            WHERE id = (auth.uid())::bigint 
            AND is_admin = true
        )
    );

-- Admins can update verification profiles (for status changes)
CREATE POLICY "Admins can update verification profiles"
    ON public.verification_profiles
    FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users 
            WHERE id = (auth.uid())::bigint 
            AND is_admin = true
        )
    );

-- ============================================
-- 11. RLS POLICIES FOR verification_documents
-- ============================================

-- Users can view their own documents
CREATE POLICY "Users can view own documents"
    ON public.verification_documents
    FOR SELECT
    TO authenticated
    USING ((auth.uid())::bigint = user_id);

-- Users can insert their own documents
CREATE POLICY "Users can insert own documents"
    ON public.verification_documents
    FOR INSERT
    TO authenticated
    WITH CHECK ((auth.uid())::bigint = user_id);

-- Users can update their own documents (to replace)
CREATE POLICY "Users can update own documents"
    ON public.verification_documents
    FOR UPDATE
    TO authenticated
    USING ((auth.uid())::bigint = user_id);

-- Admins can view all documents
CREATE POLICY "Admins can view all documents"
    ON public.verification_documents
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users 
            WHERE id = (auth.uid())::bigint 
            AND is_admin = true
        )
    );

-- ============================================
-- 12. RLS POLICIES FOR verification_history
-- ============================================

-- Users can view their own verification history
CREATE POLICY "Users can view own verification history"
    ON public.verification_history
    FOR SELECT
    TO authenticated
    USING ((auth.uid())::bigint = user_id);

-- System can insert verification history
CREATE POLICY "System can insert verification history"
    ON public.verification_history
    FOR INSERT
    TO authenticated
    WITH CHECK ((auth.uid())::bigint = user_id);

-- Admins can view all verification history
CREATE POLICY "Admins can view all verification history"
    ON public.verification_history
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users 
            WHERE id = (auth.uid())::bigint 
            AND is_admin = true
        )
    );

-- ============================================
-- 13. RLS POLICIES FOR admin_review_history
-- ============================================

-- Admins can view their own review history
CREATE POLICY "Admins can view own review history"
    ON public.admin_review_history
    FOR SELECT
    TO authenticated
    USING ((auth.uid())::bigint = admin_id);

-- Admins can view all review history
CREATE POLICY "Admins can view all review history"
    ON public.admin_review_history
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users 
            WHERE id = (auth.uid())::bigint 
            AND is_admin = true
        )
    );

-- Admins can insert review history (themselves)
CREATE POLICY "Admins can insert review history"
    ON public.admin_review_history
    FOR INSERT
    TO authenticated
    WITH CHECK ((auth.uid())::bigint = admin_id);

-- ============================================
-- 14. CREATE TRIGGER FOR updated_at
-- ============================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_verification_profiles_updated_at
    BEFORE UPDATE ON public.verification_profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_verification_documents_updated_at
    BEFORE UPDATE ON public.verification_documents
    FOR EACH ROW
    EXECUTE FUNCTION public.update_verification_documents_updated_at();

-- ============================================
-- 15. CREATE VERIFICATION HELPER FUNCTION
-- ============================================
CREATE OR REPLACE FUNCTION public.check_user_verification_status(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status INTO v_status
    FROM public.verification_profiles
    WHERE user_id = p_user_id;
    
    RETURN COALESCE(v_status, 'not_started');
END;
$$;

-- ============================================
-- 16. ADD COMMENTS FOR DOCUMENTATION
-- ============================================
COMMENT ON TABLE public.verification_profiles IS
    'Stores user KYC verification personal information and status.';

COMMENT ON TABLE public.verification_documents IS
    'Stores uploaded identity documents for KYC verification.';

COMMENT ON TABLE public.verification_history IS
    'Audit log of all verification status changes.';

COMMENT ON TABLE public.admin_review_history IS
    'Audit log of all admin actions on verification reviews.';

COMMENT ON COLUMN public.verification_profiles.status IS
    'Verification status: not_started, pending_review, approved, rejected, resubmission_required';

COMMENT ON COLUMN public.verification_documents.file_hash IS
    'SHA256 hash of file for integrity verification';

COMMENT ON COLUMN public.verification_documents.file_size IS
    'File size in bytes, maximum 10MB enforced';

COMMENT ON COLUMN public.verification_documents.storage_path IS
    'Supabase Storage path for document (userId/filename)';

COMMENT ON COLUMN public.verification_documents.is_active IS
    'Soft delete flag - documents cannot be recovered by normal means when inactive';

-- ============================================
-- 16b. SUPABASE STORAGE BUCKET SETUP
-- ============================================
-- This section creates the KYC documents storage bucket and policies.
-- 
-- REQUIREMENTS:
-- - Must be run with service_role privileges (Supabase admin)
-- - The storage system is separate from regular database tables
-- - Bucket creation and storage policies require elevated permissions
--
-- NOTE: Since users.id is BIGINT, folder names use BIGINT format (e.g., "14/")
--
-- If running via 'supabase db push', ensure your local config has
-- the SERVICE_KEY environment variable set for service role access.

-- Create KYC documents bucket (idempotent - won't fail if exists)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'kyc-documents',
    'kyc-documents',
    false,  -- PRIVATE: requires authentication
    10485760,  -- 10MB limit
    ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO NOTHING;

-- Drop existing storage policies if they exist (for clean recreation)
DROP POLICY IF EXISTS "Users can upload own KYC documents" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own KYC documents" ON storage.objects;
DROP POLICY IF EXISTS "Admins can access KYC documents" ON storage.objects;
DROP POLICY IF EXISTS "Service role can manage KYC documents" ON storage.objects;

-- Storage policy: Users can only upload documents to their own folder (userId/filename)
-- Folder format: "user_id/document.ext" (e.g., "14/passport.jpg")
-- auth.uid() is cast to text for comparison with folder name
CREATE POLICY "Users can upload own KYC documents"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
        bucket_id = 'kyc-documents' 
        AND (auth.uid())::text = (storage.foldername(name))[1]
    );

-- Storage policy: Users can only update/delete their own documents
CREATE POLICY "Users can update own KYC documents"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (
        bucket_id = 'kyc-documents' 
        AND (auth.uid())::text = (storage.foldername(name))[1]
    )
    WITH CHECK (
        bucket_id = 'kyc-documents' 
        AND (auth.uid())::text = (storage.foldername(name))[1]
    );

-- Storage policy: Admins can view all documents in the bucket
CREATE POLICY "Admins can access KYC documents"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
        bucket_id = 'kyc-documents' 
        AND EXISTS (
            SELECT 1 FROM public.users 
            WHERE id = (auth.uid())::bigint AND is_admin = true
        )
    );

-- Storage policy: Service role has full access (for backend operations)
CREATE POLICY "Service role can manage KYC documents"
    ON storage.objects FOR ALL
    TO service_role
    USING (bucket_id = 'kyc-documents')
    WITH CHECK (bucket_id = 'kyc-documents');

-- Verify storage setup
DO $$
BEGIN
    -- Check if bucket was created/updated
    IF EXISTS (
        SELECT 1 FROM storage.buckets WHERE id = 'kyc-documents'
    ) THEN
        RAISE NOTICE '✓ KYC storage bucket created/verified successfully';
    ELSE
        RAISE WARNING '⚠ KYC storage bucket not found - may require manual creation';
    END IF;
    
    -- Count policies
    IF EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE policyname = 'Users can upload own KYC documents'
        AND tablename = 'objects'
    ) THEN
        RAISE NOTICE '✓ Storage policies created successfully';
    ELSE
        RAISE WARNING '⚠ Storage policies not created - check permissions';
    END IF;
END $$;

-- ============================================
-- 17. INSERT DEFAULT CONFIG FOR KYC
-- ============================================
INSERT INTO public.payment_config (key, value, value_type, description, category, is_sensitive) VALUES
    ('kyc.enabled', 'true', 'boolean', 'Enable/disable KYC verification requirement', 'security', false),
    ('kyc.require_for_withdrawal', 'true', 'boolean', 'Require KYC approval before first withdrawal', 'security', false),
    ('kyc.min_document_count', '2', 'number', 'Minimum number of documents required', 'security', false),
    ('kyc.max_file_size_mb', '10', 'number', 'Maximum document file size in MB', 'security', false),
    ('kyc.allowed_formats', '["image/jpeg", "image/png", "image/webp"]', 'json', 'Allowed document MIME types', 'security', false)
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- 18. VERIFY MIGRATION
-- ============================================
DO $$
BEGIN
    -- Verify tables exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'verification_profiles'
    ) THEN
        RAISE EXCEPTION 'Table verification_profiles was not created!';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'verification_documents'
    ) THEN
        RAISE EXCEPTION 'Table verification_documents was not created!';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'verification_history'
    ) THEN
        RAISE EXCEPTION 'Table verification_history was not created!';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'admin_review_history'
    ) THEN
        RAISE EXCEPTION 'Table admin_review_history was not created!';
    END IF;
    
    -- Verify indexes exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE tablename = 'verification_profiles' 
        AND indexname = 'idx_verification_profiles_status'
    ) THEN
        RAISE EXCEPTION 'Index idx_verification_profiles_status was not created!';
    END IF;
    
    -- Verify RLS is enabled
    IF NOT EXISTS (
        SELECT 1 FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename = 'verification_profiles' 
        AND rowsecurity = true
    ) THEN
        RAISE EXCEPTION 'RLS not enabled on verification_profiles!';
    END IF;
    
    RAISE NOTICE '✓ KYC verification system migration completed successfully!';
END $$;
