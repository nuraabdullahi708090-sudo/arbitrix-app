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
-- SCOPE OF THE CONSTRAINT (this is what the pre-flight must mirror exactly)
--   The index is keyed on lower(email) for EVERY row. A unique B-tree treats NULL
--   as distinct, so any number of rows with email IS NULL can coexist. Everything
--   else - including an empty string '' and whitespace-only values such as '   ' -
--   is an ordinary non-NULL key: two identical ones collide, and '' and '   ' do
--   NOT collide with each other (they are different strings).
--   An earlier revision of the pre-flight filtered out `btrim(email) <> ''`, so a
--   pair of empty or identical whitespace-only addresses slipped past the guard
--   and CREATE UNIQUE INDEX failed with a raw duplicate-key error instead of this
--   migration's own explanation. The check below covers exactly the index's scope.
--
-- SAFETY
--   * PRE-FLIGHT: if two or more rows already share a key (case-insensitively)
--     the migration RAISES with the count - and separately the count that are
--     empty/whitespace-only - and changes NOTHING. Resolve those accounts first
--     (usually a support decision), then re-run.
--   * IDEMPOTENT: CREATE INDEX IF NOT EXISTS + a DROP/CREATE-free design, so a
--     second run is a no-op.
--   * NULL emails stay allowed and remain distinct (standard unique-index
--     semantics), so accounts without an address are unaffected.
--   * NON-DESTRUCTIVE: no row is inserted, updated, deleted or normalised. A
--     duplicated blank address is refused, never cleaned up automatically.
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
    duplicate_keys integer;
    duplicate_blank_keys integer;
    checked_addresses integer;
    blank_addresses integer;
    null_addresses integer;
BEGIN
    IF to_regclass('public.users') IS NULL THEN
        RAISE EXCEPTION 'public.users does not exist in this database; refusing to continue';
    END IF;

    -- The predicate below is EXACTLY the index scope: every non-NULL email.
    -- Empty ('') and whitespace-only ('   ') values are deliberately NOT filtered
    -- out - they are indexed like any other string, so excluding them here is what
    -- previously let a duplicate blank pair reach CREATE UNIQUE INDEX and fail
    -- with a raw error instead of this guard.
    SELECT count(*) INTO duplicate_keys
    FROM (
        SELECT lower(email) AS address
        FROM public.users
        WHERE email IS NOT NULL
        GROUP BY lower(email)
        HAVING count(*) > 1
    ) duplicates;

    -- Same groups, restricted to keys that render as blank, so the message can
    -- explain WHICH kind of duplicate was found (a blank address prints as
    -- nothing in a log otherwise).
    SELECT count(*) INTO duplicate_blank_keys
    FROM (
        SELECT lower(email) AS address
        FROM public.users
        WHERE email IS NOT NULL
        GROUP BY lower(email)
        HAVING count(*) > 1 AND btrim(lower(email)) = ''
    ) blank_duplicates;

    SELECT count(*) FILTER (WHERE email IS NULL),
           count(*) FILTER (WHERE email IS NOT NULL),
           count(*) FILTER (WHERE email IS NOT NULL AND btrim(email) = '')
      INTO null_addresses, checked_addresses, blank_addresses
    FROM public.users;

    IF duplicate_keys > 0 THEN
        RAISE EXCEPTION
            'cannot enforce uniqueness: % address(es) are shared by more than one account (case-insensitive), of which % are empty or whitespace-only. No row was changed. Run the read-only probe in docs/security/AUTH_SESSION_HARDENING.md, resolve the duplicates (a support decision), then re-run this migration.',
            duplicate_keys, duplicate_blank_keys;
    END IF;

    RAISE NOTICE '056 pre-flight: % non-NULL address(es) checked, no duplicates. % of them are empty/whitespace-only (allowed once each), % are NULL (allowed any number of times).',
        checked_addresses, blank_addresses, null_addresses;
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
