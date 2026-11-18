-- 049_min_deposit_100.sql
--
-- ASSERT the approved $100 platform + referral minimum (idempotent, no rewrite to 50).
--
-- WHY THIS FILE EXISTS
--   PLATFORM_MIN_DEPOSIT_USD (server.js) is the single runtime source for the
--   deposit floor, but the REFERRAL qualifying amount is ALSO stored as a row in
--   public.referral_config. The two MUST agree: if they disagree, a deposit can
--   succeed while the referral attached to it never qualifies - a silent
--   half-applied state that checkMinDepositSync() warns about at boot.
--
-- APPROVED VALUES (management decision)
--   platform minimum deposit        = $100  (server.js PLATFORM_MIN_DEPOSIT_USD)
--   referral qualifying deposit     = $100  (referral_config.minimum_qualifying_deposit)
--
-- WHAT THIS FILE DOES
--   - ensures exactly one minimum_qualifying_deposit row exists;
--   - writes '100' when the row is ABSENT;
--   - repairs a leftover '50' (the superseded interim value) back to '100',
--     with a NOTICE naming what it changed;
--   - leaves any other operator value (e.g. '75') EXACTLY as it is;
--   - is a no-op on a database that already holds the approved value - a correct
--     $100 is the SUCCESS case, never an error;
--   - self-checks the final state and rolls back if it is empty, non-numeric,
--     below the platform floor, or still 50.
--
-- WHAT THIS FILE DOES NOT DO
--   - it never writes 50 and never lowers a threshold;
--   - it does not touch PLATFORM_MIN_DEPOSIT_USD, any environment variable, the
--     referral reward percentage, or any balance/transaction/purchase row;
--   - it adds no schema (columns, tables, functions, policies).
--
-- HISTORY
--   An earlier revision of this migration number was named
--   049_min_deposit_50.sql and moved the row 100 -> 50, raising if it stayed 100.
--   That contradicted the approved $100 model and has been replaced. The file was
--   never applied to production, so no deployed state needs correcting.
--
-- SAFETY
--   - Additive and idempotent; re-running is a no-op.
--   - Works with either historical column pair:
--       config_key / config_value   (production; preferred when both exist)
--       key / value                 (a database built from an earlier assumption)
--   - Raises only when neither pair exists, or the self-check fails.

BEGIN;

DO $$
DECLARE
  v_key_col   TEXT;
  v_value_col TEXT;
  v_value     TEXT;
  v_count     INTEGER;
  v_target    CONSTANT TEXT := '100';
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
      v_key_col, v_value_col, 'minimum_qualifying_deposit', v_target);
    RAISE NOTICE 'minimum_qualifying_deposit was absent - inserted %', v_target;
  ELSIF trim(v_value) = v_target THEN
    RAISE NOTICE 'minimum_qualifying_deposit already % - no change', v_target;
  ELSIF trim(v_value) = '50' THEN
    -- The superseded interim value. Repair it to the approved one.
    EXECUTE format(
      'UPDATE public.referral_config SET %I = %L WHERE %I = %L',
      v_value_col, v_target, v_key_col, 'minimum_qualifying_deposit');
    RAISE NOTICE 'minimum_qualifying_deposit 50 -> % (approved minimum)', v_target;
  ELSE
    -- An operator-chosen value: report it, never rewrite it silently.
    RAISE NOTICE 'minimum_qualifying_deposit left at operator value % (approved value is %)', v_value, v_target;
  END IF;

  EXECUTE format(
    'SELECT count(*) FROM public.referral_config WHERE %I = %L',
    v_key_col, 'minimum_qualifying_deposit')
  INTO v_count;

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 minimum_qualifying_deposit row, found %', v_count;
  END IF;

  EXECUTE format(
    'SELECT %I::text FROM public.referral_config WHERE %I = %L',
    v_value_col, v_key_col, 'minimum_qualifying_deposit')
  INTO v_value;

  IF v_value IS NULL OR trim(v_value) = '' THEN
    RAISE EXCEPTION 'minimum_qualifying_deposit is empty after migration';
  END IF;
  IF trim(v_value) = '50' THEN
    RAISE EXCEPTION 'minimum_qualifying_deposit is still 50 - the approved minimum is 100';
  END IF;
  IF v_value::numeric < 10 THEN
    RAISE EXCEPTION 'minimum_qualifying_deposit % is below the platform floor (10)', v_value;
  END IF;
END $$;

COMMIT;

-- ROLLBACK (only meaningful if this file wrote the 100)
--   UPDATE public.referral_config
--      SET config_value = '50'
--    WHERE config_key = 'minimum_qualifying_deposit' AND config_value = '100';
--   ...which is NOT the approved state: prefer restoring the operator value that
--   the NOTICE above reported, if any.
