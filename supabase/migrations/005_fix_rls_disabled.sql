-- ============================================
-- MIGRATION: 005 - Fix RLS Disabled (Idempotent)
-- ============================================
-- PURPOSE: Explicitly disables RLS on tables that were created
-- without properly disabling RLS. This migration is IDEMPOTENT and
-- SAFE to run multiple times on fresh or existing databases.
--
-- WHY THIS FIX IS NEEDED:
-- =====================
-- Migrations 002, 003, and 004 had comments stating "RLS DISABLED" but
-- Supabase migrations do NOT automatically disable RLS - you must
-- explicitly execute "ALTER TABLE ... DISABLE ROW LEVEL SECURITY".
--
-- The comments were misleading because:
-- 1. CREATE TABLE statements do NOT disable RLS automatically
-- 2. RLS is ENABLED by default in Supabase for all new tables
-- 3. A comment is just documentation - it does NOT execute SQL
--
-- IMPACT:
-- Without this fix, inserts/updates were blocked with error:
-- "new row violates row-level security policy for table"
-- because Supabase's default RLS policy requires service_role key.
--
-- SOLUTION:
-- This migration disables RLS on the affected tables so that
-- authorization can be handled by application code (JWT via authMiddleware)
-- instead of Supabase's RLS policies.
-- ============================================

DO $$
DECLARE
    rls_disabled_count INTEGER := 0;
    table_name TEXT;
    is_rls_enabled BOOLEAN;
BEGIN
    -- Tables that need RLS disabled
    -- Payment System Tables (Migration 002)
    -- KYC Verification Tables (Migration 003)
    -- TOTP 2FA Tables (Migration 004)
    FOREACH table_name IN ARRAY ARRAY[
        'payment_invoices', 'webhook_logs', 'payment_config',
        'verification_profiles', 'verification_documents', 'verification_history', 'admin_review_history',
        'twofa_profiles', 'twofa_attempts'
    ]
    LOOP
        -- Check if table exists
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = table_name) THEN
            -- Check if RLS is currently enabled on this table
            SELECT relrowsecurity INTO is_rls_enabled
            FROM pg_class
            WHERE relname = table_name AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
            
            IF is_rls_enabled THEN
                -- RLS is enabled, disable it (this is idempotent - no error if already disabled)
                EXECUTE 'ALTER TABLE public.' || table_name || ' DISABLE ROW LEVEL SECURITY';
                RAISE NOTICE 'Disabled RLS on: %', table_name;
            ELSE
                RAISE NOTICE 'RLS already disabled on: %', table_name;
            END IF;
        ELSE
            RAISE NOTICE 'Table does not exist (skipping): %', table_name;
        END IF;
    END LOOP;
    
    RAISE NOTICE 'RLS fix migration completed successfully (idempotent)';
END $$;
