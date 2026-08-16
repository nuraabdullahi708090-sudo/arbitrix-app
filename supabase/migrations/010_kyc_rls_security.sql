-- ============================================
-- MIGRATION: 010 - KYC Security & Storage Repair (Phase 6D)
-- ============================================
-- PURPOSE: Enable Row Level Security on the four KYC tables and lock
-- them to the service role only, and keep the kyc-documents Storage
-- bucket private + service-role-only. Idempotent and safe to run on
-- fresh or existing databases.
--
-- AUTHENTICATION CONTEXT (why service_role-only, not auth.uid()):
-- ============================================================
-- This application uses a CUSTOM JWT auth system (Express + JWT_SECRET),
-- NOT Supabase Auth. The Express server is the authentication authority;
-- Supabase is only a data store. There is NO Supabase Auth session, so
-- auth.uid() returns NULL and there is no per-request user JWT carried by
-- the Supabase clients (they are shared singletons bound to the anon or
-- service key). Additionally, public.users.id is BIGINT while Supabase
-- Auth uses UUIDs, which cannot be cast in RLS policies.
--
-- Therefore true per-user "ownership" RLS policies (user_id = auth.uid())
-- are NOT possible in this architecture. The least-privilege model that
-- works here is:
--   * ENABLE RLS on the KYC tables (defense-in-depth lock).
--   * Grant access ONLY to the service role (the server, via supabaseAdmin,
--     which bypasses RLS). The anon and authenticated roles get NO policy
--     and are therefore DENIED by default -> KYC data cannot be read or
--     modified if the anon key ever leaks.
--   * Ownership + admin authorization continues to be enforced in
--     application code (authMiddleware / adminMiddleware + user_id-scoped
--     queries), exactly as before. No business logic changes.
--
-- DEV REQUIREMENT: Because RLS now denies the anon role, KYC DB and
-- Storage operations require the SUPABASE_SERVICE_KEY (so supabaseAdmin
-- is the service-role client). In development without a service key,
-- supabaseAdmin falls back to anon and KYC operations will be blocked by
-- these RLS policies by design. Set SUPABASE_SERVICE_KEY for local KYC
-- testing. Non-KYC admin operations (users/wallets/etc., which keep their
-- existing USING(true) anon policies) are unaffected.
-- ============================================

-- ============================================
-- 1. ENABLE ROW LEVEL SECURITY ON THE FOUR KYC TABLES
-- ============================================
ALTER TABLE public.verification_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_review_history ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 2. LEAST-PRIVILEGE POLICIES (service_role only)
-- ============================================
-- The service role bypasses RLS, so these policies document intent and
-- ensure the server (supabaseAdmin) can perform all CRUD. Crucially, NO
-- policy is created for the anon or authenticated roles, so they are
-- denied all access by default. This is the least-privilege posture for
-- a custom-JWT app that cannot express auth.uid()-based ownership.

-- --- verification_profiles ---
DROP POLICY IF EXISTS "kyc_vp_service_all" ON public.verification_profiles;
CREATE POLICY "kyc_vp_service_all" ON public.verification_profiles
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- --- verification_documents ---
DROP POLICY IF EXISTS "kyc_vd_service_all" ON public.verification_documents;
CREATE POLICY "kyc_vd_service_all" ON public.verification_documents
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- --- verification_history ---
DROP POLICY IF EXISTS "kyc_vh_service_all" ON public.verification_history;
CREATE POLICY "kyc_vh_service_all" ON public.verification_history
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- --- admin_review_history ---
DROP POLICY IF EXISTS "kyc_arh_service_all" ON public.admin_review_history;
CREATE POLICY "kyc_arh_service_all" ON public.admin_review_history
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- ============================================
-- 3. STORAGE BUCKET: keep kyc-documents private + service-role-only
-- ============================================
-- Ensure the bucket exists and stays private (public=false) with the
-- 10MB limit and image-only MIME types. Idempotent.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('kyc-documents', 'kyc-documents', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp']::text[])
ON CONFLICT (id) DO UPDATE SET
    public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Defensively drop any anon/authenticated storage policy that could have
-- been added to this bucket (none should exist), so the bucket stays
-- private and service-role-only.
DROP POLICY IF EXISTS "anon_kyc_read" ON storage.objects;
DROP POLICY IF EXISTS "anon_kyc_all" ON storage.objects;
DROP POLICY IF EXISTS "authenticated_kyc_all" ON storage.objects;

-- (Re)assert the single service_role-only management policy for the bucket.
DROP POLICY IF EXISTS "svc_kyc_manage" ON storage.objects;
CREATE POLICY svc_kyc_manage ON storage.objects FOR ALL TO service_role
    USING (bucket_id = 'kyc-documents') WITH CHECK (bucket_id = 'kyc-documents');

-- ============================================
-- 4. VERIFY
-- ============================================
DO $$
DECLARE
    tbl TEXT;
    rls_on BOOLEAN;
    bucket_public BOOLEAN;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'verification_profiles', 'verification_documents',
        'verification_history', 'admin_review_history'
    ]
    LOOP
        SELECT relrowsecurity INTO rls_on
        FROM pg_class
        WHERE relname = tbl AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
        IF NOT rls_on THEN
            RAISE EXCEPTION 'RLS not enabled on %', tbl;
        END IF;
    END LOOP;

    SELECT public INTO bucket_public
    FROM storage.buckets WHERE id = 'kyc-documents';
    IF bucket_public IS NULL OR bucket_public = true THEN
        RAISE EXCEPTION 'kyc-documents bucket must be private (public=false)';
    END IF;

    RAISE NOTICE 'Phase 6D OK: RLS enabled on 4 KYC tables (service_role only); kyc-documents private + service-role-only';
END $$;
