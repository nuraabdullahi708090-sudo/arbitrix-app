-- ============================================
-- MIGRATION: 014 - Financial RPC EXECUTE Lockdown (Idempotent)
-- ============================================
-- PHASE 1 EMERGENCY SECURITY CONTAINMENT (authorization-boundary fix ONLY).
--
-- SECURITY ADVISOR FINDING:
-- The three financial SECURITY DEFINER functions below were executable by
-- PUBLIC / anon / authenticated through PostgREST (Postgres grants EXECUTE on
-- new functions to PUBLIC by default, and no REVOKE was ever issued):
--   - public.record_trade_safe      -> credits/debits wallets.live_balance
--   - public.credit_payment_safe    -> credits wallets.live_balance + ledger
--   - public.paymento_credit_user_safe -> credits wallets.live_balance + ledger
-- Because they are SECURITY DEFINER and have NO caller-authorization check,
-- any unauthenticated internet caller could invoke them directly with the
-- public anon key and mutate production financial state.
--
-- SCOPE (deliberately narrow):
-- This migration changes FUNCTION EXECUTE privileges ONLY. It does NOT:
--   - alter function bodies, parameters, return values, or SECURITY DEFINER
--   - enable/disable RLS on any table
--   - create/drop any policy, table, column, or data
--   - touch balances, trades, deposits, withdrawals, transactions, users,
--     payment providers, subscriptions, or sandbox behavior
-- Table-level RLS remediation and credential rotation are LATER phases.
--
-- APPLICATION COMPATIBILITY (verified before this migration was written):
-- The Express server invokes ALL THREE functions exclusively through the
-- service-role client (supabaseAdmin):
--   server.js:3169  supabaseAdmin.rpc('paymento_credit_user_safe', ...)
--   server.js:3383  supabaseAdmin.rpc('credit_payment_safe', ...)
--   server.js:4677  supabaseAdmin.rpc('record_trade_safe', ...)
-- No anon-client or frontend invocation exists. service_role BYPASSES RLS and
-- retains EXECUTE via the explicit grants below, so production behavior is
-- unchanged for the server path.
--
-- IDEMPOTENCY: REVOKE/GRANT are idempotent in PostgreSQL; the final DO block
-- re-verifies the resulting ACL and RAISES EXCEPTION on drift, so this
-- migration is safe to run repeatedly.
-- ============================================

-- ============================================
-- 1. record_trade_safe
--    Exact signature (supabase/migrations/009_trades_persistence.sql:74):
--      record_trade_safe(BIGINT, DECIMAL, TEXT, TEXT, TEXT, TEXT)
--    DECIMAL resolves to pg_catalog.numeric. No other overload is defined
--    anywhere in the migration history.
-- ============================================
REVOKE EXECUTE ON FUNCTION public.record_trade_safe(BIGINT, DECIMAL, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_trade_safe(BIGINT, DECIMAL, TEXT, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.record_trade_safe(BIGINT, DECIMAL, TEXT, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_trade_safe(BIGINT, DECIMAL, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ============================================
-- 2. credit_payment_safe
--    Exact signature (supabase/migrations/008_q8qpay_support.sql:64):
--      credit_payment_safe(BIGINT, BIGINT, DECIMAL, TEXT, TEXT, TEXT)
--    No other overload is defined anywhere in the migration history.
-- ============================================
REVOKE EXECUTE ON FUNCTION public.credit_payment_safe(BIGINT, BIGINT, DECIMAL, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_payment_safe(BIGINT, BIGINT, DECIMAL, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.credit_payment_safe(BIGINT, BIGINT, DECIMAL, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.credit_payment_safe(BIGINT, BIGINT, DECIMAL, TEXT, TEXT, TEXT) TO service_role;

-- ============================================
-- 3. paymento_credit_user_safe
--    TWO overloads exist in the migration history (no DEFAULT-parameter
--    ambiguity: the 5-arg form has all-defaulted trailing params, but they
--    are distinct functions in pg_proc and BOTH must be locked down):
--      a) 5-arg: supabase/migrations/006_paymento_support.sql:132
--      b) 8-arg: supabase/migrations/007_paymento_settlement_audit.sql:94
--         (this is the CURRENT definition; server.js:3169 passes all 8 args)
-- ============================================
REVOKE EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER) TO service_role;

REVOKE EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER, TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER, TEXT, TEXT, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER, TEXT, TEXT, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER, TEXT, TEXT, INTEGER) TO service_role;

-- ============================================
-- 4. POST-MIGRATION VERIFICATION (read-only)
--    Asserts, for every exact signature above, that:
--      - the function exists exactly once (no un-locked overloads left)
--      - PUBLIC / anon / authenticated do NOT have EXECUTE
--      - service_role DOES have EXECUTE
--    Raises EXCEPTION (fails the migration) on any drift.
--    NOTE: pg_roles entries for PUBLIC have rolname = '-'.
-- ============================================
DO $$
DECLARE
    sig RECORD;
    v_count INTEGER;
BEGIN
    FOR sig IN
        SELECT * FROM (VALUES
            ('record_trade_safe',         'bigint,numeric,text,text,text,text'),
            ('credit_payment_safe',       'bigint,bigint,numeric,text,text,text'),
            ('paymento_credit_user_safe', 'bigint,bigint,numeric,bigint,integer'),
            ('paymento_credit_user_safe', 'bigint,bigint,numeric,bigint,integer,text,text,integer')
        ) AS v(proname, argtypes)
    LOOP
        -- Function must exist exactly once for this exact signature.
        SELECT COUNT(*) INTO v_count
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = sig.proname
          AND pg_get_function_identity_arguments(p.oid) = sig.argtypes;

        IF v_count <> 1 THEN
            RAISE EXCEPTION '014 verification failed: % with identity args (%) found % times (expected exactly 1)',
                sig.proname, sig.argtypes, v_count;
        END IF;

        -- PUBLIC / anon / authenticated must NOT have EXECUTE.
        IF EXISTS (
            SELECT 1
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            CROSS JOIN LATERAL aclexplode(p.proacl) acl
            JOIN pg_roles r ON r.oid = acl.grantee
            WHERE n.nspname = 'public'
              AND p.proname = sig.proname
              AND pg_get_function_identity_arguments(p.oid) = sig.argtypes
              AND acl.privilege_type = 'EXECUTE'
              AND acl.grantee <> 0  -- grantee 0 = PUBLIC
              AND r.rolname IN ('anon', 'authenticated')
        ) OR EXISTS (
            SELECT 1
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            CROSS JOIN LATERAL aclexplode(p.proacl) acl
            WHERE n.nspname = 'public'
              AND p.proname = sig.proname
              AND pg_get_function_identity_arguments(p.oid) = sig.argtypes
              AND acl.privilege_type = 'EXECUTE'
              AND acl.grantee = 0  -- PUBLIC
        ) THEN
            RAISE EXCEPTION '014 verification failed: %(%) still grants EXECUTE to PUBLIC/anon/authenticated',
                sig.proname, sig.argtypes;
        END IF;

        -- service_role MUST have EXECUTE (the Express server path).
        IF NOT EXISTS (
            SELECT 1
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            CROSS JOIN LATERAL aclexplode(p.proacl) acl
            JOIN pg_roles r ON r.oid = acl.grantee
            WHERE n.nspname = 'public'
              AND p.proname = sig.proname
              AND pg_get_function_identity_arguments(p.oid) = sig.argtypes
              AND acl.privilege_type = 'EXECUTE'
              AND r.rolname = 'service_role'
        ) THEN
            RAISE EXCEPTION '014 verification failed: %(%) is missing service_role EXECUTE grant',
                sig.proname, sig.argtypes;
        END IF;
    END LOOP;

    RAISE NOTICE '014 complete: record_trade_safe, credit_payment_safe, paymento_credit_user_safe (both overloads) locked to service_role only';
END $$;
