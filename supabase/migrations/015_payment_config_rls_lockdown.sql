-- ============================================
-- MIGRATION: 015 - payment_config RLS Containment (Phase 1B, Idempotent)
-- ============================================
-- SECURITY ADVISOR FINDING:
-- public.payment_config had RLS DISABLED in the public schema, so every row
-- was readable (and writable) through PostgREST by anyone holding the public
-- anon key. The table's sensitive rows (nowpayments.api_key,
-- nowpayments.ipn_secret, paymento.api_key, paymento.secret_key,
-- q8qpay.api_key, q8qpay.webhook_secret) are currently EMPTY placeholders --
-- production secrets live in server environment variables only -- but the
-- table ALSO holds payment routing configuration and is designed to hold
-- provider secrets, so it must never be client-reachable.
--
-- SCOPE (deliberately narrow):
-- This migration touches ONLY public.payment_config. It does NOT:
--   - modify any other table (users/wallets/deposits/withdrawals/
--     transactions/trades/subscriptions/KYC/auth/Sandbox are untouched)
--   - modify any function/RPC (Phase 1 financial RPC lockdown untouched)
--   - insert/update/delete any ROW (no configuration values changed)
--   - change payment calculations, provider request formats, invoice
--     logic, webhook verification, or deposit crediting
--
-- APPLICATION COMPATIBILITY (verified before this migration was written):
-- The ONLY application code that reads payment_config is the Express
-- server's getSubscriptionPrice() (key 'subscription.pro_price'), which now
-- uses the service-role client (supabaseAdmin). No frontend code and no
-- other server path references the table. All provider API keys / webhook
-- secrets are read from process.env at startup, NOT from this table, so
-- denying anon/authenticated access changes no production behavior.
--
-- TARGET STATE:
--   RLS enabled. No policy for anon/authenticated -> denied by default.
--   Table privileges revoked from anon/authenticated (defense in depth).
--   service_role (the Express server) retains full access.
--
-- IDEMPOTENT: ALTER TABLE ... ENABLE ROW LEVEL SECURITY, DROP POLICY IF
-- EXISTS, REVOKE, and GRANT are all idempotent; the final DO block
-- re-verifies the posture and RAISES EXCEPTION on drift, so this migration
-- is safe to run repeatedly.
-- ============================================

-- ============================================
-- 1. ENABLE ROW LEVEL SECURITY
-- ============================================
ALTER TABLE public.payment_config ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 2. SERVICE-ROLE-ONLY POLICY
-- ============================================
-- No policy is created for the anon or authenticated roles, so with RLS
-- enabled they are denied ALL operations (SELECT/INSERT/UPDATE/DELETE) by
-- default. The custom-JWT app has no Supabase Auth session (auth.uid() is
-- always NULL), so ownership-style policies are impossible here; the
-- least-privilege model is service-role only (same pattern as migration
-- 010 for the KYC tables).
DROP POLICY IF EXISTS "payment_config_service_all" ON public.payment_config;
CREATE POLICY "payment_config_service_all" ON public.payment_config
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- ============================================
-- 3. REVOKE TABLE PRIVILEGES FROM CLIENT ROLES (defense in depth)
-- ============================================
-- Even if a permissive policy were ever added by mistake, the anon and
-- authenticated roles must not hold table-level privileges on this table.
REVOKE ALL ON public.payment_config FROM anon;
REVOKE ALL ON public.payment_config FROM authenticated;

-- ============================================
-- 4. GRANT SERVICE ROLE FULL ACCESS (idempotent)
-- ============================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_config TO service_role;

-- ============================================
-- 5. VERIFICATION BLOCK (read-only; raises EXCEPTION on drift)
-- ============================================
DO $$
DECLARE
    v_rls_enabled BOOLEAN;
    v_bad_policy  INT;
BEGIN
    SELECT relrowsecurity INTO v_rls_enabled
    FROM pg_class
    WHERE oid = 'public.payment_config'::regclass;

    IF v_rls_enabled IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'payment_config RLS verification failed: RLS is not enabled';
    END IF;

    -- No policy may target anon/authenticated/public.
    SELECT count(*) INTO v_bad_policy
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'payment_config'
      AND (roles @> ARRAY['anon']::name[]
        OR roles @> ARRAY['authenticated']::name[]
        OR roles @> ARRAY['public']::name[]);

    IF v_bad_policy > 0 THEN
        RAISE EXCEPTION 'payment_config RLS verification failed: % policy(ies) grant access to anon/authenticated/public', v_bad_policy;
    END IF;

    RAISE NOTICE 'payment_config containment verified: RLS enabled, service_role-only policy, no anon/authenticated/public policy';
END $$;
