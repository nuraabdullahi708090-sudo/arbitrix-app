-- ============================================
-- Deposit partner directory
-- Arbitrix AI - add-on migration
-- ============================================
-- PURPOSE
--   Stores the small, admin-curated directory of VERIFIED HUMAN PARTNERS that
--   the Deposit page may offer to customers who need help obtaining
--   cryptocurrency. A partner record is contact metadata only: it never holds a
--   customer reference, a deposit reference, a balance or a settlement figure.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It does not create, credit or modify any deposit, wallet, transaction,
--     payment_invoice, withdrawal, referral or subscription row.
--   * It does not add a partner payout / escrow / rating feature.
--   * It does not grant any privilege to anon or authenticated.
--
-- AUTHORIZATION MODEL (matches the rest of this repository)
--   The application uses custom JWT auth (users.id is BIGINT, there is no
--   auth.uid()), so ownership/role checks are enforced in server code
--   (authMiddleware + adminMiddleware). The database therefore enables RLS and
--   grants access ONLY to service_role (the server's supabaseAdmin client).
--   anon/authenticated receive NO policy and NO table privilege => deny by
--   default, so a leaked anon key cannot enumerate or edit the directory.
--
-- SERVICE + COVERAGE MODEL (columns added 2026-10-29)
--   services        canonical capabilities, a subset of
--                   {direct_sale, guided_assistance} (an empty list is
--                   schema-legal but never customer-visible). direct_sale = the partner
--                   sells USDT and can arrange its transfer to the customer's
--                   Arbitrix deposit address; guided_assistance = the partner
--                   helps the customer buy through an external service and
--                   guides the deposit. A partner may offer BOTH.
--   serves_worldwide TRUE = no country restriction (the intended default for
--                   partners who serve customers anywhere). When TRUE the
--                   countries list is ignored and the UI says "worldwide".
--   countries       coverage/limitation list, displayed verbatim when
--                   serves_worldwide is FALSE. There is deliberately no
--                   single-country restriction: a partner may list many.
--   payment_methods what the partner accepts for a DIRECT sale. Guided-only
--                   partners leave it empty and the UI states that the method
--                   depends on the external service.
--   A row with no service, or with neither worldwide coverage nor a country
--   list, is NOT customer-visible: the server would have nothing truthful to
--   display, so it hides the row instead of implying unrestricted availability.
--
-- VERIFICATION STATUS
--   is_verified is the flag the customer-facing "Verified Partner" badge claims.
--   The server only reveals rows where is_active = TRUE AND is_verified = TRUE
--   AND at least one service AND disclosed coverage.
--
-- IDEMPOTENT / ADDITIVE: safe to re-run. The trailing block verifies the result
-- and rolls the whole migration back if anything is missing.
-- ============================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.deposit_partners (
    id              BIGSERIAL PRIMARY KEY,
    display_name    TEXT        NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 60),
    -- Stored WITHOUT '@' or a URL: the server builds the t.me link, so an
    -- administrator can never store an arbitrary destination.
    telegram_username TEXT      NOT NULL CHECK (telegram_username ~ '^[a-z][a-z0-9_]{4,31}$'),
    -- Canonical service identifiers; see the header. Additive so the migration
    -- stays re-runnable on a table created by an earlier revision of this file.
    services        TEXT[]      NOT NULL DEFAULT '{}',
    serves_worldwide BOOLEAN    NOT NULL DEFAULT FALSE,
    countries       TEXT[]      NOT NULL DEFAULT '{}',
    payment_methods TEXT[]      NOT NULL DEFAULT '{}',
    is_active       BOOLEAN     NOT NULL DEFAULT FALSE,
    is_verified     BOOLEAN     NOT NULL DEFAULT FALSE,
    display_order   INTEGER     NOT NULL DEFAULT 100 CHECK (display_order >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent upgrade path: a database that already ran the first revision of
-- this migration gains the new columns here without losing any row.
ALTER TABLE public.deposit_partners ADD COLUMN IF NOT EXISTS services TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE public.deposit_partners ADD COLUMN IF NOT EXISTS serves_worldwide BOOLEAN NOT NULL DEFAULT FALSE;

-- A service list may only contain known capabilities (unknown values are
-- rejected, not silently stored: the customer card can only describe what it
-- knows). An empty list is allowed by the schema but is never customer-visible.
--
-- The three predicates together reject every representation the application
-- cannot render honestly:
--   1. services <@ ...            - no unknown capability;
--   2. array_position(...) IS NULL - no NULL element. A CHECK only fails on
--      FALSE, and `services <@ ARRAY[...]` evaluates to NULL (not FALSE) when the
--      array contains NULL, so predicate 1 alone would ACCEPT ['{NULL}'];
--   3. cardinality = present-count - no duplicates. The domain has exactly two
--      values, so the number of distinct elements equals the number of the two
--      literal services present; a repeated value would exceed it. (A DISTINCT
--      subquery is not allowed inside a CHECK, hence the CASE form.)
-- '{}' still passes all three (0 = 0) and stays schema-legal but invisible.
ALTER TABLE public.deposit_partners DROP CONSTRAINT IF EXISTS deposit_partners_services_valid;
ALTER TABLE public.deposit_partners ADD CONSTRAINT deposit_partners_services_valid
    CHECK (
        services <@ ARRAY['direct_sale', 'guided_assistance']::TEXT[]
        AND array_position(services, NULL) IS NULL
        AND cardinality(services) = (
            (CASE WHEN 'direct_sale' = ANY (services) THEN 1 ELSE 0 END) +
            (CASE WHEN 'guided_assistance' = ANY (services) THEN 1 ELSE 0 END)
        )
    );

-- One row per Telegram account: two cards pointing at the same handle would be
-- ambiguous for a customer trying to verify who they are talking to.
CREATE UNIQUE INDEX IF NOT EXISTS deposit_partners_telegram_username_key
    ON public.deposit_partners (telegram_username);

-- The deposit page only ever asks for active+verified rows in display order.
CREATE INDEX IF NOT EXISTS deposit_partners_visible_idx
    ON public.deposit_partners (display_order, display_name)
    WHERE is_active AND is_verified;

ALTER TABLE public.deposit_partners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deposit_partners_service_all ON public.deposit_partners;
CREATE POLICY deposit_partners_service_all ON public.deposit_partners
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- Deny by default: no policy exists for anon/authenticated, and the table
-- privileges are removed explicitly as a second line of defence.
REVOKE ALL ON public.deposit_partners FROM PUBLIC;
REVOKE ALL ON public.deposit_partners FROM anon;
REVOKE ALL ON public.deposit_partners FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deposit_partners TO service_role;

-- The id sequence is written only by the service role. Guarded exactly like
-- migration 039: if the table already existed with a different primary-key design
-- (identity column, UUID key, or a restore that dropped the sequence) there is no
-- sequence to grant, and an unguarded GRANT would abort the whole migration for
-- no security benefit. Nothing is granted when the sequence is absent.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'deposit_partners_id_seq'
          AND c.relkind = 'S'
    ) THEN
        EXECUTE 'REVOKE ALL ON SEQUENCE public.deposit_partners_id_seq FROM PUBLIC, anon, authenticated';
        EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.deposit_partners_id_seq TO service_role';
    END IF;
END $$;

COMMENT ON TABLE public.deposit_partners IS
    'Admin-curated directory of verified human deposit partners. Contact metadata only; no financial data. Customer-visible only when is_active AND is_verified AND services is non-empty AND coverage is disclosed (serves_worldwide OR countries).';
COMMENT ON COLUMN public.deposit_partners.services IS
    'Subset of {direct_sale, guided_assistance}: no unknown value, no NULL element, no duplicate. Empty is schema-legal but never customer-visible. Rendered as capability badges; never used to price or credit anything.';
COMMENT ON COLUMN public.deposit_partners.serves_worldwide IS
    'TRUE = the partner serves customers worldwide and countries is ignored. FALSE = countries lists the supported coverage.';
COMMENT ON COLUMN public.deposit_partners.payment_methods IS
    'Payment methods accepted for a DIRECT USDT sale. Guided-only partners leave this empty.';

-- Self-check: fail loudly (and roll back) if the result is not what the server
-- expects, so a partially applied migration can never reach production.
DO $$
DECLARE
    v_rls       BOOLEAN;
    v_policy    INTEGER;
    v_anon      INTEGER;
    v_auth      INTEGER;
BEGIN
    IF to_regclass('public.deposit_partners') IS NULL THEN
        RAISE EXCEPTION 'deposit_partners table was not created';
    END IF;

    -- services must be TEXT[] specifically: data_type = 'ARRAY' alone is also
    -- true for integer[]/uuid[]/etc, so the element type is asserted separately.
    -- Nullability and the '{}' default are part of the contract the server relies
    -- on (ADD COLUMN IF NOT EXISTS would silently keep a wrong-typed column, so
    -- these assertions are what turn that into a loud failure).
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'deposit_partners'
          AND column_name = 'services'
          AND data_type = 'ARRAY'
          AND udt_name = '_text'
          AND is_nullable = 'NO'
          AND column_default IS NOT NULL
          AND position('{}' in column_default) > 0
    ) THEN
        RAISE EXCEPTION 'deposit_partners.services must be TEXT[] NOT NULL DEFAULT ''{}''';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'deposit_partners'
          AND column_name = 'serves_worldwide'
          AND data_type = 'boolean'
          AND udt_name = 'bool'
          AND is_nullable = 'NO'
          AND lower(column_default) = 'false'
    ) THEN
        RAISE EXCEPTION 'deposit_partners.serves_worldwide must be BOOLEAN NOT NULL DEFAULT FALSE';
    END IF;

    -- Scoped to this table: a same-named constraint on an unrelated table must
    -- not satisfy the check.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'deposit_partners'
          AND c.conname = 'deposit_partners_services_valid'
          AND c.contype = 'c'
    ) THEN
        RAISE EXCEPTION 'deposit_partners_services_valid constraint is missing from public.deposit_partners';
    END IF;

    SELECT c.relrowsecurity INTO v_rls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'deposit_partners';

    IF v_rls IS NOT TRUE THEN
        RAISE EXCEPTION 'RLS is not enabled on deposit_partners';
    END IF;

    SELECT count(*) INTO v_policy
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'deposit_partners'
      AND 'service_role' = ANY (roles);

    IF v_policy < 1 THEN
        RAISE EXCEPTION 'deposit_partners has no service_role policy';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'deposit_partners'
          AND ('anon' = ANY (roles) OR 'authenticated' = ANY (roles) OR 'public' = ANY (roles))
    ) THEN
        RAISE EXCEPTION 'deposit_partners must not expose a policy to anon/authenticated/public';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name = 'deposit_partners'
          AND grantee IN ('anon', 'authenticated')
    ) THEN
        RAISE EXCEPTION 'deposit_partners still grants privileges to anon/authenticated';
    END IF;
END $$;

COMMIT;
