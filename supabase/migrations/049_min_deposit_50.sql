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
-- SAFETY
--   - Additive and idempotent; re-running is a no-op.
--   - Only rewrites the HISTORICAL default '100'. An operator-customised value
--     (e.g. '75') is left exactly as it is.
--   - Guarantees the row EXISTS, so the PL/pgSQL fallbacks in migrations 021/022
--     (which still read 100) are unreachable in practice.
--   - Self-checking DO block raises (and rolls back) if the value is not 50 and
--     not a deliberate operator override.
--
-- NOT APPLIED. Requires approval.

BEGIN;

DO $$
DECLARE
  v_value TEXT;
  v_count INTEGER;
BEGIN
  IF to_regclass('public.referral_config') IS NULL THEN
    RAISE EXCEPTION 'public.referral_config is missing - apply the earlier migrations first';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'referral_config'
                AND column_name = 'key')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'referral_config'
                    AND column_name = 'value') THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'public.referral_config must have (key, value) columns';
  END IF;

  SELECT value INTO v_value
    FROM public.referral_config
   WHERE key = 'minimum_qualifying_deposit';

  IF v_value IS NULL THEN
    INSERT INTO public.referral_config (key, value)
    VALUES ('minimum_qualifying_deposit', '50');
    RAISE NOTICE 'minimum_qualifying_deposit was absent - inserted 50';
  ELSIF trim(v_value) IN ('100', '') THEN
    UPDATE public.referral_config
       SET value = '50'
     WHERE key = 'minimum_qualifying_deposit';
    RAISE NOTICE 'minimum_qualifying_deposit % -> 50', v_value;
  ELSE
    RAISE NOTICE 'minimum_qualifying_deposit left at operator value %', v_value;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.referral_config
   WHERE key = 'minimum_qualifying_deposit';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 minimum_qualifying_deposit row, found %', v_count;
  END IF;
END $$;

-- Self-check: the value must be 50, or a deliberate non-default operator value.
DO $$
DECLARE v_value TEXT;
BEGIN
  SELECT value INTO v_value
    FROM public.referral_config
   WHERE key = 'minimum_qualifying_deposit';

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

-- ROLLBACK
--   UPDATE public.referral_config SET value = '100'
--    WHERE key = 'minimum_qualifying_deposit' AND value = '50';
--   ...and unset PLATFORM_MIN_DEPOSIT_USD on the service (which reverts the
--   effective minimum to the built-in $100 immediately, no deploy required).
