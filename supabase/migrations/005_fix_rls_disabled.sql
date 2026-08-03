-- ============================================
-- MIGRATION: 005 - Fix RLS Disabled
-- ============================================
-- This migration explicitly disables RLS on tables
-- that were created without disabling RLS
--
-- ROOT CAUSE: The original migrations had comments saying "RLS DISABLED"
-- but no actual SQL statement to disable RLS
-- ============================================

-- KYC Verification Tables
ALTER TABLE public.verification_profiles DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_history DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_review_history DISABLE ROW LEVEL SECURITY;

-- TOTP 2FA Tables
ALTER TABLE public.twofa_profiles DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.twofa_attempts DISABLE ROW LEVEL SECURITY;

-- Verify RLS is disabled
DO $$
BEGIN
    -- Check KYC tables
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'verification_profiles') THEN
        IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.verification_profiles'::regclass) THEN
            RAISE NOTICE 'WARNING: verification_profiles still has RLS policies';
        ELSE
            RAISE NOTICE 'OK: verification_profiles RLS disabled';
        END IF;
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'verification_documents') THEN
        IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.verification_documents'::regclass) THEN
            RAISE NOTICE 'WARNING: verification_documents still has RLS policies';
        ELSE
            RAISE NOTICE 'OK: verification_documents RLS disabled';
        END IF;
    END IF;
    
    -- Check 2FA tables
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'twofa_profiles') THEN
        IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.twofa_profiles'::regclass) THEN
            RAISE NOTICE 'WARNING: twofa_profiles still has RLS policies';
        ELSE
            RAISE NOTICE 'OK: twofa_profiles RLS disabled';
        END IF;
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'twofa_attempts') THEN
        IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.twofa_attempts'::regclass) THEN
            RAISE NOTICE 'WARNING: twofa_attempts still has RLS policies';
        ELSE
            RAISE NOTICE 'OK: twofa_attempts RLS disabled';
        END IF;
    END IF;
    
    RAISE NOTICE 'RLS fix migration completed';
END $$;
