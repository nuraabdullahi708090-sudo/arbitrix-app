-- ============================================
-- MIGRATION: 016 - Authentication/Security Tables RLS Lockdown (Phase 3A, Idempotent)
-- ============================================
-- PRE-FLIGHT FINDING (verified live, read-only, before this migration was
-- written): all seven authentication/security tables below were reachable
-- through PostgREST by anyone holding the public anon key (RLS disabled or
-- permissive; anon SELECT returned rows with HTTP 200). These tables hold
-- the most sensitive non-financial data in the system:
--   password_reset_tokens    - password-reset token hashes
--   email_verification_codes - email 2FA verification code hashes
--   email_change_requests    - email-change verification code hashes
--   twofa_profiles           - encrypted TOTP secrets + backup-code hashes
--   twofa_attempts           - 2FA attempt/rate-limit/audit data
--   email_2fa_attempts       - email 2FA rate-limit data
--   feature_flags            - security-relevant config (e.g. 2fa_type=email)
--
-- SCOPE (deliberately narrow - Phase 3A only):
-- This migration touches ONLY the seven tables listed above. It does NOT:
--   - modify financial tables (users/wallets/deposits/withdrawals/
--     transactions/trades/bot_sessions/payment_invoices/webhook_logs/
--     subscriptions/subscription_charges) - later phases
--   - modify KYC tables (verification_*/admin_review_history - already
--     locked by migration 010)
--   - modify Sandbox tables (sandbox_* - already service-role only)
--   - modify payment_config (already locked by migration 015)
--   - modify any function/RPC (migration 014 financial RPC lockdown and
--     the update_feature_flags_updated_at trigger function are untouched)
--   - insert/update/delete any ROW (no tokens, codes, secrets, flag
--     values, or user/auth records are changed)
--   - change authentication, 2FA, password-reset, email-change, or
--     rate-limit logic (server code untouched)
--
-- APPLICATION COMPATIBILITY (verified before this migration was written):
-- Every access to these seven tables goes through the Express server using
-- the service-role client (supabaseAdmin) - Phase 2 (PR #112) migrated all
-- server-side Supabase access to service_role, services/Email2FAService.js
-- receives supabaseAdmin for its email_2fa_attempts rate-limit queries, and
-- there is NO frontend/direct-browser Supabase access (grep-verified). The
-- app uses custom JWT auth, not Supabase Auth, so auth.uid() is always NULL
-- and ownership-style policies are impossible; the least-privilege model is
-- service-role only (same pattern as migrations 010 and 015).
--
-- TARGET STATE (per table):
--   RLS enabled. No policy for anon/authenticated/public -> denied by
--   default. Table privileges revoked from anon/authenticated (defense in
--   depth). service_role (the Express server) retains full access.
--
-- IDEMPOTENT: ALTER TABLE ... ENABLE ROW LEVEL SECURITY, DROP POLICY IF
-- EXISTS, REVOKE, and GRANT are all idempotent; the final DO block
-- re-verifies the posture for all seven tables and RAISES EXCEPTION on
-- drift, so this migration is safe to run repeatedly.
-- ============================================

-- ============================================
-- 1. ENABLE ROW LEVEL SECURITY (all seven tables)
-- ============================================
ALTER TABLE public.password_reset_tokens    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_verification_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_change_requests    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.twofa_profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.twofa_attempts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_2fa_attempts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags            ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 2. SERVICE-ROLE-ONLY POLICIES
-- ============================================
-- No policy is created for the anon or authenticated roles, so with RLS
-- enabled they are denied ALL operations (SELECT/INSERT/UPDATE/DELETE) by
-- default. No USING(true)/WITH CHECK(true) client-facing policy is created
-- anywhere; the only policies grant the service_role (server) full access.
--
-- LEGACY POLICY CLEANUP (password_reset_tokens only):
-- Migration 001 created four legacy policies on password_reset_tokens that
-- target anon/authenticated (one of them, "Service role can insert reset
-- tokens", is TO authenticated, anon WITH CHECK(true) -- the live anon-INSERT
-- exposure). They must be dropped BEFORE the service-role-only policy is
-- created, otherwise the verification block below correctly fails. The other
-- six Phase-3A tables have NO legacy policies (repo-wide grep + live probe
-- confirmed), so no drops are needed for them.
DROP POLICY IF EXISTS "Service role can insert reset tokens" ON public.password_reset_tokens;
DROP POLICY IF EXISTS "Service role can select reset tokens" ON public.password_reset_tokens;
DROP POLICY IF EXISTS "Service role can update reset tokens" ON public.password_reset_tokens;
DROP POLICY IF EXISTS "Deny delete reset tokens" ON public.password_reset_tokens;

DROP POLICY IF EXISTS "password_reset_tokens_service_all" ON public.password_reset_tokens;
CREATE POLICY "password_reset_tokens_service_all" ON public.password_reset_tokens
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "email_verification_codes_service_all" ON public.email_verification_codes;
CREATE POLICY "email_verification_codes_service_all" ON public.email_verification_codes
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "email_change_requests_service_all" ON public.email_change_requests;
CREATE POLICY "email_change_requests_service_all" ON public.email_change_requests
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "twofa_profiles_service_all" ON public.twofa_profiles;
CREATE POLICY "twofa_profiles_service_all" ON public.twofa_profiles
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "twofa_attempts_service_all" ON public.twofa_attempts;
CREATE POLICY "twofa_attempts_service_all" ON public.twofa_attempts
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "email_2fa_attempts_service_all" ON public.email_2fa_attempts;
CREATE POLICY "email_2fa_attempts_service_all" ON public.email_2fa_attempts
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "feature_flags_service_all" ON public.feature_flags;
CREATE POLICY "feature_flags_service_all" ON public.feature_flags
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- ============================================
-- 3. REVOKE TABLE PRIVILEGES FROM CLIENT ROLES (defense in depth)
-- ============================================
-- Even if a permissive policy were ever added by mistake, the anon and
-- authenticated roles must not hold table-level privileges on these tables.
REVOKE ALL ON public.password_reset_tokens    FROM anon;
REVOKE ALL ON public.password_reset_tokens    FROM authenticated;
REVOKE ALL ON public.email_verification_codes FROM anon;
REVOKE ALL ON public.email_verification_codes FROM authenticated;
REVOKE ALL ON public.email_change_requests    FROM anon;
REVOKE ALL ON public.email_change_requests    FROM authenticated;
REVOKE ALL ON public.twofa_profiles           FROM anon;
REVOKE ALL ON public.twofa_profiles           FROM authenticated;
REVOKE ALL ON public.twofa_attempts           FROM anon;
REVOKE ALL ON public.twofa_attempts           FROM authenticated;
REVOKE ALL ON public.email_2fa_attempts       FROM anon;
REVOKE ALL ON public.email_2fa_attempts       FROM authenticated;
REVOKE ALL ON public.feature_flags            FROM anon;
REVOKE ALL ON public.feature_flags            FROM authenticated;

-- ============================================
-- 4. GRANT SERVICE ROLE FULL ACCESS (idempotent)
-- ============================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.password_reset_tokens    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_verification_codes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_change_requests    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.twofa_profiles           TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.twofa_attempts           TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_2fa_attempts       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feature_flags            TO service_role;

-- ============================================
-- 5. VERIFICATION BLOCK (read-only; raises EXCEPTION on drift)
-- ============================================
DO $$
DECLARE
    v_table      TEXT;
    v_rls_on     BOOLEAN;
    v_bad_policy INT;
    v_tables     TEXT[] := ARRAY[
        'password_reset_tokens',
        'email_verification_codes',
        'email_change_requests',
        'twofa_profiles',
        'twofa_attempts',
        'email_2fa_attempts',
        'feature_flags'
    ];
BEGIN
    FOREACH v_table IN ARRAY v_tables LOOP
        SELECT relrowsecurity INTO v_rls_on
        FROM pg_class
        WHERE oid = ('public.' || v_table)::regclass;

        IF v_rls_on IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'auth/security RLS verification failed: RLS is not enabled on %', v_table;
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
            RAISE EXCEPTION 'auth/security RLS verification failed: % policy(ies) on % grant access to anon/authenticated/public', v_bad_policy, v_table;
        END IF;
    END LOOP;

    RAISE NOTICE 'auth/security containment verified: RLS enabled on all 7 tables, service_role-only policies, no anon/authenticated/public policy';
END $$;
