-- 049_min_deposit_50.sql
--
-- COORDINATED RELEASE STEP 2 of 3 for the $50 minimum deposit.
--
-- WHY THIS FILE EXISTS
--   PLATFORM_MIN_DEPOSIT_USD (server.js) is the single runtime source for the
--   deposit floor, but the REFERRAL qualifying amount is ALSO stored as a row in
--   public.referral_config. Changing only the environment variable would let a
--   $50 deposit succeed while referral qualification still required $100 - the
--   exact half-applied state the runtime knob exists to prevent.
--
--   Apply this TOGETHER with PLATFORM_MIN_DEPOSIT_USD=50, never on its own.
--   Applying this alone makes referral qualification $50 while deposits still
--   require $100 (harmless but inconsistent).
--
-- SCHEMA (corrected 2026-11-16)
--   The production table is (id, config_key, config_value, description,
--   created_at, updated_at) - that is what migrations/003_referral_config.sql
--   creates and what migrations 020/021/022/023/024 and server.js all read and
--   write. An earlier revision of this file required (key, value) and RAISED
--   otherwise, so it would have ABORTED on the real database and left the
--   referral minimum at $100 while deposits accepted $50.
--
--   This file now DETECTS the columns and works with either shape:
--     config_key / config_value   (production; preferred when both exist)
--     key / value                 (a database built from this file's earlier
--                                  assumption)
--   It raises only when neither pair exists.
--
-- SAFETY
--   - Additive and idempotent; re-running is a no-op.
--   - Only rewrites the HISTORICAL default '100'. An operator-customised value
--     (e.g. '75') is left exactly as it is.
--   - Guarantees the row EXISTS, so the PL/pgSQL fallbacks in migrations 021/022
--     (which still read 100) are unreachable in practice.
--   - Self-checking: raises (and rolls back) if the value is not 50 and not a
--     deliberate operator override.
--   - Logs which column pair it used, so the release log shows what happened.

BEGIN;

DO $$
DECLARE
  v_key_col   TEXT;
  v_value_col TEXT;
  v_value     TEXT;
  v_count     INTEGER;
BEGIN
  IF to_regclass('public.referral_config') IS NULL THEN
    RAISE EXCEPTION 'public.referral_config is missing - apply the earlier migrations first';
  END IF;

  -- Prefer the production pair when present; fall back to the alternative.
  SELECT column_name INTO v_key_col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'referral_config'
     AND column_name IN ('config_key', 'key')
   ORDER BY (column_name = 'config_key') DESC
   LIMIT 1;

  SELECT column_name INTO v_value_col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'referral_config'
     AND column_name IN ('config_value', 'value')
   ORDER BY (column_name = 'config_value') DESC
   LIMIT 1;

  IF v_key_col IS NULL OR v_value_col IS NULL THEN
    RAISE EXCEPTION 'public.referral_config must have a key column (config_key or key) and a value column (config_value or value)';
  END IF;

  RAISE NOTICE 'referral_config columns: % / %', v_key_col, v_value_col;

  EXECUTE format(
    'SELECT %I::text FROM public.referral_config WHERE %I = %L',
    v_value_col, v_key_col, 'minimum_qualifying_deposit')
  INTO v_value;

  IF v_value IS NULL THEN
    EXECUTE format(
      'INSERT INTO public.referral_config (%I, %I) VALUES (%L, %L)',
      v_key_col, v_value_col, 'minimum_qualifying_deposit', '50');
    RAISE NOTICE 'minimum_qualifying_deposit was absent - inserted 50';
  ELSIF trim(v_value) IN ('100', '') THEN
    EXECUTE format(
      'UPDATE public.referral_config SET %I = %L WHERE %I = %L',
      v_value_col, '50', v_key_col, 'minimum_qualifying_deposit');
    RAISE NOTICE 'minimum_qualifying_deposit % -> 50', v_value;
  ELSE
    RAISE NOTICE 'minimum_qualifying_deposit left at operator value %', v_value;
  END IF;

  EXECUTE format(
    'SELECT count(*) FROM public.referral_config WHERE %I = %L',
    v_key_col, 'minimum_qualifying_deposit')
  INTO v_count;

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 minimum_qualifying_deposit row, found %', v_count;
  END IF;

  -- Self-check: the value must be 50, or a deliberate non-default operator value.
  EXECUTE format(
    'SELECT %I::text FROM public.referral_config WHERE %I = %L',
    v_value_col, v_key_col, 'minimum_qualifying_deposit')
  INTO v_value;

  IF v_value IS NULL OR trim(v_value) = '' THEN
    RAISE EXCEPTION 'minimum_qualifying_deposit is empty after migration';
  END IF;

  IF v_value = '100' THEN
    RAISE EXCEPTION 'minimum_qualifying_deposit is still 100 - migration did not take effect';
  END IF;

  IF v_value::numeric < 10 THEN
    RAISE EXCEPTION 'minimum_qualifying_deposit % is below the platform floor (10)', v_value;
  END IF;
END $$;

COMMIT;

-- ROLLBACK (use the value column reported by the NOTICE above)
--   UPDATE public.referral_config SET config_value = '100'
--    WHERE config_key = 'minimum_qualifying_deposit' AND config_value = '50';
--   ...and unset PLATFORM_MIN_DEPOSIT_USD on the service (which reverts the
--   effective minimum to the built-in $100 immediately, no deploy required).
