-- ============================================
-- 025 — Session revocation store (JWT jti denylist)
-- ============================================
--
-- F1: server-side session revocation. `POST /api/auth/logout` inserts the
-- presented token's `jti` here; `authMiddleware` rejects any token whose jti is
-- present, so a stolen/replayed token cannot be reused after logout even though
-- its JWT signature and `exp` remain valid.
--
-- POSTURE: identical to the Phase-3 financial lockdown (018) — RLS enabled,
-- exactly one service-role-only policy, anon/authenticated fully revoked. The
-- Express server talks to this table through the service-role client
-- (supabaseAdmin) only; the browser never talks to Supabase directly.
--
-- Rows are bounded by the revoked token's own `exp` (`expires_at`); expired
-- rows are ignored by the lookup and can be deleted by prune_revoked_tokens().
--
-- IDEMPOTENT: safe to run repeatedly (CREATE ... IF NOT EXISTS, DROP POLICY IF
-- EXISTS, and the guard DO block).
-- ============================================

-- ============================================
-- 1. TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.revoked_tokens (
    jti         UUID        PRIMARY KEY,
    user_id     BIGINT,
    revoked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL
);

-- The lookup filters on `expires_at > now()`; the index keeps it O(log n).
CREATE INDEX IF NOT EXISTS revoked_tokens_expires_at_idx
    ON public.revoked_tokens (expires_at);

-- ============================================
-- 2. RLS + SERVICE-ROLE-ONLY POLICY
-- ============================================
ALTER TABLE public.revoked_tokens ENABLE ROW LEVEL SECURITY;

-- No policy is created for anon/authenticated, so RLS denies them by default.
DROP POLICY IF EXISTS "revoked_tokens_service_all" ON public.revoked_tokens;
CREATE POLICY "revoked_tokens_service_all" ON public.revoked_tokens
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON public.revoked_tokens FROM anon, authenticated;

-- ============================================
-- 3. PRUNE HELPER
-- ============================================
-- Expired entries can never match the `expires_at > now()` lookup, so removing
-- them is purely housekeeping. Safe to call from a cron/periodic task; NOT
-- SECURITY DEFINER (service_role already has full access).
CREATE OR REPLACE FUNCTION public.prune_revoked_tokens()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count integer;
BEGIN
    DELETE FROM public.revoked_tokens WHERE expires_at <= NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_revoked_tokens() FROM PUBLIC, anon, authenticated;

-- ============================================
-- 4. VERIFY POSTURE
-- ============================================
DO $$
DECLARE
    rls_on boolean;
    anon_grants integer;
    service_policy integer;
BEGIN
    SELECT relrowsecurity INTO rls_on
    FROM pg_class WHERE oid = 'public.revoked_tokens'::regclass;
    IF rls_on IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'revoked_tokens: RLS is not enabled';
    END IF;

    SELECT count(*) INTO anon_grants
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'revoked_tokens'
      AND grantee IN ('anon', 'authenticated');
    IF anon_grants > 0 THEN
        RAISE EXCEPTION 'revoked_tokens: anon/authenticated still hold % grant(s)', anon_grants;
    END IF;

    SELECT count(*) INTO service_policy
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'revoked_tokens'
      AND policyname = 'revoked_tokens_service_all'
      AND 'service_role' = ANY(roles);
    IF service_policy <> 1 THEN
        RAISE EXCEPTION 'revoked_tokens: service-role-only policy is missing';
    END IF;
END
$$;
