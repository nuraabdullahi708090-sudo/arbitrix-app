-- ============================================
-- MIGRATION: 018 - Production Financial/Application Tables RLS Lockdown
--                  (Phase 3C, Idempotent)
-- ============================================
-- PHASE 3C-1 AUDIT FINDING (verified live, read-only, before this migration
-- was written): the eleven production financial/application tables below are
-- reachable through PostgREST by anyone holding the public anon key. anon
-- SELECT returns rows (HTTP 200) AND anon UPDATE/DELETE succeed (HTTP 204).
--   users, wallets, deposits, withdrawals, transactions, trades,
--   bot_sessions, payment_invoices, webhook_logs, referrals, subscriptions
--
-- ROOT CAUSE: these tables were never given Row Level Security. They default
-- to RLS-off, and the anon/authenticated roles hold Supabase's default table
-- GRANTs (SELECT/INSERT/UPDATE/DELETE) on public-schema tables, so the anon
-- role can read AND write them. A repo-wide audit confirmed there are NO
-- existing non-service-role policies on these eleven tables (the exposure is
-- RLS-disabled/default-grant, not a permissive policy), so no arbitrary
-- policy drops are required.
--
-- SCOPE (deliberately narrow - Phase 3C only):
-- This migration touches ONLY the eleven tables listed above. It does NOT:
--   - modify payment_config (locked by migration 015)
--   - modify authentication/security tables (password_reset_tokens/
--     email_verification_codes/email_change_requests/twofa_profiles/
--     twofa_attempts/email_2fa_attempts/feature_flags - locked by 016)
--   - modify KYC tables (verification_profiles/verification_documents/
--     verification_history/admin_review_history - locked by 017)
--   - modify any sandbox_* table (intentionally RLS-off by design, 013)
--   - modify storage.objects (010)
--   - modify referral_config, referral_config_audit_log, or audit_logs
--   - modify any function/RPC (migration 014 financial RPC lockdown and all
--     SECURITY DEFINER functions are untouched)
--   - insert/update/delete any ROW (no data changed)
--   - change any column or table structure
--   - change deposit/withdrawal/trading/subscription/wallet/bot/payment/
--     webhook/referral/auth/KYC logic (server code untouched)
--
-- APPLICATION COMPATIBILITY (verified in the Phase 3C-1 audit):
-- All server-side access to these eleven tables uses the service-role client
-- (supabaseAdmin); there are ZERO bare-anon-client references to them in
-- server.js, PaymentService uses its own service-role client
-- (SUPABASE_SERVICE_KEY), and there is NO frontend/direct-browser Supabase
-- access. The app uses custom JWT auth (no Supabase Auth session), so
-- service_role-only is the correct least-privilege model. User-facing routes
-- scope by req.user.id; admin routes are gated by authMiddleware +
-- adminMiddleware.
--
-- TARGET STATE (per table):
--   RLS enabled. Exactly one service-role-only policy ("<table>_service_all").
--   No policy for anon/authenticated/public -> denied by default. Table
--   privileges revoked from anon/authenticated. service_role (the Express
--   server) retains full access.
--
-- IDEMPOTENT: ALTER TABLE ... ENABLE ROW LEVEL SECURITY, DROP POLICY IF
-- EXISTS, REVOKE, and GRANT are all idempotent; the final DO block
-- re-verifies the posture for all eleven tables (checking BOTH pg_policies
-- AND information_schema.role_table_grants) and RAISES EXCEPTION on drift,
-- so this migration is safe to run repeatedly.
-- ============================================

-- ============================================
-- 1. ENABLE ROW LEVEL SECURITY (all eleven tables)
-- ============================================
ALTER TABLE public.users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deposits          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withdrawals       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_invoices  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions     ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 2. SERVICE-ROLE-ONLY POLICIES
-- ============================================
-- No policy is created for the anon or authenticated roles, so with RLS
-- enabled they are denied ALL operations (SELECT/INSERT/UPDATE/DELETE) by
-- default. The audit found no pre-existing non-service-role policies on
-- these tables, so only the (idempotent) "<table>_service_all" drop+create
-- is needed.
DROP POLICY IF EXISTS "users_service_all" ON public.users;
CREATE POLICY "users_service_all" ON public.users
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "wallets_service_all" ON public.wallets;
CREATE POLICY "wallets_service_all" ON public.wallets
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "deposits_service_all" ON public.deposits;
CREATE POLICY "deposits_service_all" ON public.deposits
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "withdrawals_service_all" ON public.withdrawals;
CREATE POLICY "withdrawals_service_all" ON public.withdrawals
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "transactions_service_all" ON public.transactions;
CREATE POLICY "transactions_service_all" ON public.transactions
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "trades_service_all" ON public.trades;
CREATE POLICY "trades_service_all" ON public.trades
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "bot_sessions_service_all" ON public.bot_sessions;
CREATE POLICY "bot_sessions_service_all" ON public.bot_sessions
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "payment_invoices_service_all" ON public.payment_invoices;
CREATE POLICY "payment_invoices_service_all" ON public.payment_invoices
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "webhook_logs_service_all" ON public.webhook_logs;
CREATE POLICY "webhook_logs_service_all" ON public.webhook_logs
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "referrals_service_all" ON public.referrals;
CREATE POLICY "referrals_service_all" ON public.referrals
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "subscriptions_service_all" ON public.subscriptions;
CREATE POLICY "subscriptions_service_all" ON public.subscriptions
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- ============================================
-- 3. REVOKE TABLE PRIVILEGES FROM CLIENT ROLES (the actual containment)
-- ============================================
REVOKE ALL ON public.users             FROM anon;
REVOKE ALL ON public.users             FROM authenticated;
REVOKE ALL ON public.wallets           FROM anon;
REVOKE ALL ON public.wallets           FROM authenticated;
REVOKE ALL ON public.deposits          FROM anon;
REVOKE ALL ON public.deposits          FROM authenticated;
REVOKE ALL ON public.withdrawals       FROM anon;
REVOKE ALL ON public.withdrawals       FROM authenticated;
REVOKE ALL ON public.transactions      FROM anon;
REVOKE ALL ON public.transactions      FROM authenticated;
REVOKE ALL ON public.trades            FROM anon;
REVOKE ALL ON public.trades            FROM authenticated;
REVOKE ALL ON public.bot_sessions      FROM anon;
REVOKE ALL ON public.bot_sessions      FROM authenticated;
REVOKE ALL ON public.payment_invoices  FROM anon;
REVOKE ALL ON public.payment_invoices  FROM authenticated;
REVOKE ALL ON public.webhook_logs      FROM anon;
REVOKE ALL ON public.webhook_logs      FROM authenticated;
REVOKE ALL ON public.referrals         FROM anon;
REVOKE ALL ON public.referrals         FROM authenticated;
REVOKE ALL ON public.subscriptions     FROM anon;
REVOKE ALL ON public.subscriptions     FROM authenticated;

-- ============================================
-- 4. GRANT SERVICE ROLE FULL ACCESS (idempotent)
-- ============================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users             TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wallets           TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deposits          TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.withdrawals       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transactions      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trades            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_sessions      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_invoices  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.webhook_logs      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referrals         TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscriptions     TO service_role;

-- ============================================
-- 5. VERIFICATION BLOCK (read-only; raises EXCEPTION on drift)
-- ============================================
DO $$
DECLARE
    v_table      TEXT;
    v_rls_on     BOOLEAN;
    v_bad_policy INT;
    v_bad_grant  INT;
    v_svc_policy INT;
    v_svc_grant  INT;
    v_tables     TEXT[] := ARRAY[
        'users',
        'wallets',
        'deposits',
        'withdrawals',
        'transactions',
        'trades',
        'bot_sessions',
        'payment_invoices',
        'webhook_logs',
        'referrals',
        'subscriptions'
    ];
BEGIN
    FOREACH v_table IN ARRAY v_tables LOOP
        -- RLS must be enabled.
        SELECT relrowsecurity INTO v_rls_on
        FROM pg_class
        WHERE oid = ('public.' || v_table)::regclass;

        IF v_rls_on IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'financial RLS verification failed: RLS is not enabled on %', v_table;
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
            RAISE EXCEPTION 'financial RLS verification failed: % policy(ies) on % grant access to anon/authenticated/public', v_bad_policy, v_table;
        END IF;

        -- anon/authenticated must hold NO table privileges.
        SELECT count(*) INTO v_bad_grant
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name = v_table
          AND grantee IN ('anon', 'authenticated');

        IF v_bad_grant > 0 THEN
            RAISE EXCEPTION 'financial RLS verification failed: % table privilege(s) on % still granted to anon/authenticated', v_bad_grant, v_table;
        END IF;

        -- The expected service_role policy must exist.
        SELECT count(*) INTO v_svc_policy
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = v_table
          AND policyname = v_table || '_service_all'
          AND roles @> ARRAY['service_role']::name[];

        IF v_svc_policy < 1 THEN
            RAISE EXCEPTION 'financial RLS verification failed: expected service-role policy missing on %', v_table;
        END IF;

        -- service_role must hold table privileges.
        SELECT count(*) INTO v_svc_grant
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name = v_table
          AND grantee = 'service_role'
          AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE');

        IF v_svc_grant < 4 THEN
            RAISE EXCEPTION 'financial RLS verification failed: service_role missing privileges on % (% of 4)', v_table, v_svc_grant;
        END IF;
    END LOOP;

    RAISE NOTICE 'financial containment verified: RLS enabled on all 11 tables, service_role-only policies, privileges revoked from anon/authenticated, service_role retains full access';
END $$;
