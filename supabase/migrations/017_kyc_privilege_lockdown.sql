-- ============================================
-- MIGRATION: 017 - KYC Tables Privilege Lockdown (Phase 3B, Idempotent)
-- ============================================
-- PREFLIGHT FINDING (verified live, read-only, before this migration was
-- written): the four KYC tables are CURRENTLY reachable through PostgREST by
-- anyone holding the public anon key (anon SELECT returned rows with HTTP
-- 200, exposing PII - legal names, document references, status history).
--   verification_profiles, verification_documents,
--   verification_history, admin_review_history
--
-- ROOT CAUSE (why migration 010 did not contain them):
-- Migration 010 enabled RLS and added a service_role-only policy, but it
-- (a) never REVOKEd table privileges from anon/authenticated, and
-- (b) never GRANTed explicitly to service_role. In Supabase the
--     anon/authenticated roles hold default table GRANTs (SELECT/INSERT/
--     UPDATE/DELETE) on public-schema tables, so with privileges still in
--     place and no effective policy barrier the anon role can read/write.
-- (Migration 005 also DISABLEs RLS on these tables whenever re-run.)
--
-- SCOPE (deliberately narrow - Phase 3B only):
-- This migration touches ONLY the four KYC tables above. It does NOT:
--   - modify financial tables (users/wallets/deposits/withdrawals/
--     transactions/trades/bot_sessions/payment_invoices/webhook_logs/
--     subscriptions/subscription_charges)
--   - modify authentication tables (password_reset_tokens/
--     email_verification_codes/email_change_requests/twofa_profiles/
--     twofa_attempts/email_2fa_attempts/feature_flags - locked by 016)
--   - modify payment_config (locked by 015)
--   - modify Sandbox tables (sandbox_*)
--   - modify the storage.objects bucket/policies (010 already handles the
--     private kyc-documents bucket; left untouched)
--   - modify any function/RPC
--   - insert/update/delete any ROW (no KYC/PII data is changed)
--   - change KYC logic (server code untouched)
--
-- APPLICATION COMPATIBILITY (verified before this migration was written):
-- All server-side access to these tables uses the service-role client
-- (supabaseAdmin): server.js reads verification_profiles via supabaseAdmin
-- and KYCService is constructed as new KYCService(supabaseAdmin,
-- supabaseAdmin.storage). There is NO frontend/direct-browser Supabase
-- access. The app uses custom JWT auth (no Supabase Auth session), so
-- service_role-only is the correct least-privilege model.
--
-- TARGET STATE (per table):
--   RLS enabled. No policy for anon/authenticated/public -> denied by
--   default. Table privileges revoked from anon/authenticated (this is the
--   piece 010 missed). service_role (the Express server) retains full
--   access.
--
-- IDEMPOTENT: ALTER TABLE ... ENABLE ROW LEVEL SECURITY, DROP POLICY IF
-- EXISTS, REVOKE, and GRANT are all idempotent; the final DO block
-- re-verifies the posture for all four tables and RAISES EXCEPTION on
-- drift, so this migration is safe to run repeatedly.
-- ============================================

-- ============================================
-- 1. ENABLE ROW LEVEL SECURITY (re-assert; 005/010 may have left it off)
-- ============================================
ALTER TABLE public.verification_profiles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_history   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_review_history   ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 2. SERVICE-ROLE-ONLY POLICIES (re-assert 010's policies, idempotent)
-- ============================================
DROP POLICY IF EXISTS "kyc_vp_service_all" ON public.verification_profiles;
CREATE POLICY "kyc_vp_service_all" ON public.verification_profiles
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "kyc_vd_service_all" ON public.verification_documents;
CREATE POLICY "kyc_vd_service_all" ON public.verification_documents
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "kyc_vh_service_all" ON public.verification_history;
CREATE POLICY "kyc_vh_service_all" ON public.verification_history
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "kyc_arh_service_all" ON public.admin_review_history;
CREATE POLICY "kyc_arh_service_all" ON public.admin_review_history
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- ============================================
-- 3. REVOKE TABLE PRIVILEGES FROM CLIENT ROLES (the piece 010 missed)
-- ============================================
-- This is the actual containment: the anon/authenticated default GRANTs are
-- removed so PostgREST can no longer read or write these tables even if a
-- permissive policy were ever added by mistake.
REVOKE ALL ON public.verification_profiles  FROM anon;
REVOKE ALL ON public.verification_profiles  FROM authenticated;
REVOKE ALL ON public.verification_documents FROM anon;
REVOKE ALL ON public.verification_documents FROM authenticated;
REVOKE ALL ON public.verification_history   FROM anon;
REVOKE ALL ON public.verification_history   FROM authenticated;
REVOKE ALL ON public.admin_review_history   FROM anon;
REVOKE ALL ON public.admin_review_history   FROM authenticated;

-- ============================================
-- 4. GRANT SERVICE ROLE FULL ACCESS (idempotent)
-- ============================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.verification_profiles  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.verification_documents TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.verification_history   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_review_history   TO service_role;

-- ============================================
-- 5. VERIFICATION BLOCK (read-only; raises EXCEPTION on drift)
-- ============================================
DO $$
DECLARE
    v_table      TEXT;
    v_rls_on     BOOLEAN;
    v_bad_policy INT;
    v_bad_grant  INT;
    v_tables     TEXT[] := ARRAY[
        'verification_profiles',
        'verification_documents',
        'verification_history',
        'admin_review_history'
    ];
BEGIN
    FOREACH v_table IN ARRAY v_tables LOOP
        SELECT relrowsecurity INTO v_rls_on
        FROM pg_class
        WHERE oid = ('public.' || v_table)::regclass;

        IF v_rls_on IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'KYC RLS verification failed: RLS is not enabled on %', v_table;
        END IF;

        -- No policy may target anon/authenticated/public.
        SELECT count(*) INTO v_bad_policy
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = v_table
          AND (roles @> ARRAY['anon']::name[]
            OR roles @> ARRAY['authenticated']::name[]
            OR roles @> ARRAY['public']::name[]);

        IF v_bad_policy > 0 THEN
            RAISE EXCEPTION 'KYC RLS verification failed: % policy(ies) on % grant access to anon/authenticated/public', v_bad_policy, v_table;
        END IF;

        -- anon/authenticated must hold NO table privileges.
        SELECT count(*) INTO v_bad_grant
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name = v_table
          AND grantee IN ('anon', 'authenticated');

        IF v_bad_grant > 0 THEN
            RAISE EXCEPTION 'KYC RLS verification failed: % table privilege(s) on % still granted to anon/authenticated', v_bad_grant, v_table;
        END IF;
    END LOOP;

    RAISE NOTICE 'KYC containment verified: RLS enabled on all 4 tables, service_role-only policies, privileges revoked from anon/authenticated';
END $$;
