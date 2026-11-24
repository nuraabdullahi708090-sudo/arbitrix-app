-- 057_min_deposit_and_referral_50.sql
--
-- SYNC the referral qualifying deposit to the approved $50 platform minimum.
--
-- WHY THIS FILE EXISTS
--   PLATFORM_MIN_DEPOSIT_USD (server.js) is the single runtime source of truth for
--   the deposit floor, but the REFERRAL qualifying amount is ALSO stored as a row
--   in public.referral_config, and the provider award helper
--   (award_referral_qualification_safe, migration 021) reads THAT row - not the
--   server constant. The two must agree: if they disagree, a $50 deposit is
--   credited (server allows it) but the referral attached to it never qualifies,
--   because the SQL helper still demands $100. checkMinDepositSync() logs that
--   mismatch at boot; this migration removes it.
--
-- APPROVED VALUES (management decision)
--   platform minimum deposit    = $50   (server.js: PLATFORM_MIN_DEPOSIT_USD)
--   referral qualifying deposit = $50   (referral_config.minimum_qualifying_deposit)
--   referral reward             = 20% of the referred user's FIRST qualifying
--                                 deposit, paid once by the existing helper
--                                 ($50 -> $10, $100 -> $20). The reward
--                                 percentage is NOT touched here.
--
-- WHAT THIS FILE DOES
--   - ensures exactly one minimum_qualifying_deposit row exists;
--   - writes '50' when the row is ABSENT;
--   - moves the superseded '100' value to '50', with a NOTICE naming the change;
--   - leaves any OTHER operator value (e.g. '75', '250') exactly as it is and
--     reports it - a deliberately customised threshold is never rewritten;
--   - is a no-op when the row already holds '50';
--   - self-checks the final state and rolls back if it is empty or non-numeric.
--
-- WHAT THIS FILE DOES NOT DO
--   - it never touches a balance, deposit, withdrawal, trade, referral row,
--     earned reward, subscription or purchase;
--   - it does not change referral_reward_percent, the reward calculation, any
--     environment variable or any application code;
--   - it adds no schema (no columns, tables, functions, triggers or policies).
--
-- BACKWARD COMPATIBILITY
--   Additive and idempotent; re-running is a no-op. Works with either historical
--   column pair (config_key/config_value - production - or key/value). Applying it
--   BEFORE the new server code is harmless: the old server keeps rejecting < $100
--   invoices while the referral threshold is already 50, which only means a $60
--   deposit cannot happen yet. Applying it AFTER is equally safe: until it runs,
--   the referral award helper keeps demanding $100 (no wrong reward is ever paid,
--   a referral simply qualifies later).
--
-- ROLLBACK
--   UPDATE public.referral_config
--      SET config_value = '100'
--    WHERE config_key = 'minimum_qualifying_deposit' AND config_value = '50';
--   (Restores the previous approved value; earned rewards are NOT recomputed.)

BEGIN;

DO $$
DECLARE
  v_key_col   TEXT;
  v_value_col TEXT;
  v_value     TEXT;
  v_count     INTEGER;
  v_target    CONSTANT TEXT := '50';
BEGIN
  IF to_regclass('public.referral_config') IS NULL THEN
    RAISE EXCEPTION 'public.referral_config is missing - apply the earlier migrations first';
  END IF;

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
  ELSIF trim(v_value) = '100' THEN
    EXECUTE format(
      'UPDATE public.referral_config SET %I = %L WHERE %I = %L',
      v_value_col, v_target, v_key_col, 'minimum_qualifying_deposit');
    RAISE NOTICE 'minimum_qualifying_deposit 100 -> % (approved minimum)', v_target;
  ELSE
    RAISE NOTICE 'minimum_qualifying_deposit left at operator value % (platform default is %)', v_value, v_target;
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

  BEGIN
    PERFORM v_value::numeric;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'minimum_qualifying_deposit % is not numeric', v_value;
  END;

  IF v_value::numeric < 10 THEN
    RAISE EXCEPTION 'minimum_qualifying_deposit % is below the platform floor (10)', v_value;
  END IF;

  RAISE NOTICE 'final minimum_qualifying_deposit = %', v_value;
END $$;

COMMIT;
