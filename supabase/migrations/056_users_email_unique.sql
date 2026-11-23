-- ============================================
-- 056 - Case-insensitive uniqueness of users.email (guarded)
-- ============================================
--
-- WHY
--   Account identity assumes one row per address:
--     * registration rejects an address that already exists;
--     * admin provisioning refuses to create an account whose address exists
--       (and reports `exists` when it loses a concurrent race);
--     * /api/auth/login and the password-reset flow look an account up by
--       address.
--   `users` predates the migrations tracked here and no uniqueness constraint on
--   `email` is declared anywhere in the repository. Without one, nothing at the
--   database level prevents two concurrent registrations (or two cold-start
--   provisioning attempts) from creating two rows for the same address, which
--   would make "which account does this password reset belong to" ambiguous.
--
-- WHAT THIS DOES
--   Adds ONE unique expression index on lower(email). Nothing else: no column is
--   added, no row is read out, no row is changed or deleted.
--
-- SAFETY
--   * PRE-FLIGHT: if two or more rows already share an address (case-insensitively)
--     the migration RAISES with the number of duplicated addresses and changes
--     NOTHING. Resolve those accounts first (usually a support decision), then
--     re-run.
--   * IDEMPOTENT: CREATE INDEX IF NOT EXISTS + a DROP/CREATE-free design, so a
--     second run is a no-op.
--   * NULL emails stay allowed and remain distinct (standard unique-index
--     semantics), so accounts without an address are unaffected.
--
-- OPERATIONAL NOTE
--   A plain CREATE UNIQUE INDEX takes a SHARE lock that blocks writes to `users`
--   for the duration of the build. That is fine at the current table size. On a
--   large table, run the equivalent manually, outside a transaction:
--     CREATE UNIQUE INDEX CONCURRENTLY users_email_lower_unique
--       ON public.users (lower(email));
--   and skip section 5 (CONCURRENTLY cannot run inside a transaction block).
-- ============================================

-- ============================================
-- 1. PRE-FLIGHT - refuse if duplicates exist, change nothing
-- ============================================
DO $$
DECLARE
    duplicate_addresses integer;
BEGIN
    IF to_regclass('public.users') IS NULL THEN
        RAISE EXCEPTION 'public.users does not exist in this database; refusing to continue';
    END IF;

    SELECT count(*) INTO duplicate_addresses
    FROM (
        SELECT lower(email) AS address
        FROM public.users
        WHERE email IS NOT NULL AND btrim(email) <> ''
        GROUP BY lower(email)
        HAVING count(*) > 1
    ) duplicates;

    IF duplicate_addresses > 0 THEN
        RAISE EXCEPTION
            'cannot enforce uniqueness: % address(es) are shared by more than one account (case-insensitive). Resolve them first - nothing was changed.',
            duplicate_addresses;
    END IF;

    RAISE NOTICE '056 pre-flight: no duplicate addresses found';
END $$;

-- ============================================
-- 2. THE CONSTRAINT
-- ============================================
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique
    ON public.users (lower(email));

COMMENT ON INDEX public.users_email_lower_unique IS
    'One account per email address (case-insensitive). Required by registration, login and password reset.';

-- ============================================
-- 3. SELF-CHECK - the index exists, is unique, and is an expression index
-- ============================================
DO $$
DECLARE
    found_unique boolean := false;
    found_expression boolean := false;
BEGIN
    SELECT i.indisunique,
           (pg_get_indexdef(i.indexrelid) ILIKE '%lower%email%')
      INTO found_unique, found_expression
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'users_email_lower_unique';

    IF found_unique IS NULL THEN
        RAISE EXCEPTION 'self-check failed: index users_email_lower_unique is missing';
    END IF;
    IF NOT found_unique THEN
        RAISE EXCEPTION 'self-check failed: index users_email_lower_unique is not unique';
    END IF;
    IF NOT found_expression THEN
        RAISE EXCEPTION 'self-check failed: index users_email_lower_unique is not the lower(email) expression index';
    END IF;

    RAISE NOTICE '056 self-check: users_email_lower_unique is present, unique and case-insensitive';
END $$;
