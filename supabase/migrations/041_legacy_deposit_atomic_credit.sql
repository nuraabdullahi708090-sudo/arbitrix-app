-- ===========================================================================
-- 041_legacy_deposit_atomic_credit.sql
-- ===========================================================================
--
-- PROBLEM THIS FIXES
--   Three application paths confirm a LEGACY deposit (the `deposits` table):
--     * GET  /api/deposit/status/:invoiceId      (customer polling)
--     * PUT  /api/admin/deposits/:id/confirm     (admin)
--     * POST /api/admin/payments/:invoiceId/confirm (admin, old-table branch)
--   Each one used to run, as SEPARATE round-trips:
--       UPDATE deposits SET status='confirmed'   <-- the outbox trigger fired here
--       updateWallet(user, live_balance, amount) <-- the money arrived here
--       INSERT INTO transactions ...
--   So a failure (or a crash) between the two steps left a deposit marked
--   confirmed but never credited, and the Phase 2 trigger had already recorded a
--   `deposit_confirmed` event -> the customer could be told "we received your
--   deposit and it was added to your Live balance" when it was not.
--
-- WHAT THIS MIGRATION DOES
--   1. Adds `deposits.credited` (additive, default FALSE) - an explicit credit
--      marker, mirroring `payment_invoices.credited` which the provider credit
--      functions already set.
--   2. Adds `confirm_legacy_deposit_safe(deposit_id, user_id)`: ONE transaction
--      that row-locks the deposit, credits the wallet with an ATOMIC increment,
--      writes the ledger row, and only THEN sets status='confirmed' +
--      credited=TRUE. The Phase 2 trigger fires on that final UPDATE, i.e. after
--      the money moved, in the same transaction. Either everything happens or
--      nothing does.
--   3. Replaces `conversion_capture_deposit()` (from 040) so the legacy branch
--      requires `credited = TRUE`; a bare status change can never notify again.
--   4. Adds `conversion_backfill_missing()` so an event that a capture trigger
--      failed to record (all capture functions intentionally downgrade their own
--      errors to a WARNING) is RECOVERED instead of being lost forever.
--
-- WHAT IT DOES NOT CHANGE
--   * No deposit, withdrawal, referral, trading, subscription or sandbox rule.
--   * No provider credit function (credit_payment_safe, paymento_credit_user_safe,
--     confirm_payment_with_credit) and no ledger/wallet schema beyond the marker.
--   * Referral qualification is still done by the existing
--     activateReferralOnQualification() / award_referral_qualification_safe()
--     exactly-once paths; this RPC does not touch referrals at all.
--
-- DEPLOY ORDER (IMPORTANT)
--   Apply 040 first, then 041, in the same batch - 040's legacy trigger branch
--   reads `deposits.credited`, which 041 creates. In the few seconds between the
--   two, a legacy deposit confirmation would record no event (the trigger's
--   handler logs a warning); `conversion_backfill_missing()` recovers it later.
--   Shipping 041 without the matching server build is SAFE: the old code sets
--   status without `credited`, so no legacy notification is produced (the safe
--   direction) while the deposit is still credited exactly as today.
--
-- ROLLBACK (no money data is modified by the rollback)
--   DROP FUNCTION IF EXISTS public.conversion_backfill_missing(INTEGER, INTEGER);
--   DROP FUNCTION IF EXISTS public.confirm_legacy_deposit_safe(BIGINT, BIGINT);
--   -- restore 040's capture function by re-applying 040, then:
--   ALTER TABLE public.deposits DROP COLUMN IF EXISTS credited;
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Preconditions
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regclass('public.deposits') IS NULL THEN
        RAISE EXCEPTION 'migration 041 requires public.deposits (legacy deposit table)';
    END IF;
    IF to_regclass('public.wallets') IS NULL THEN
        RAISE EXCEPTION 'migration 041 requires public.wallets';
    END IF;
    IF to_regclass('public.transactions') IS NULL THEN
        RAISE EXCEPTION 'migration 041 requires public.transactions';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Credit marker on the legacy deposit row
-- ---------------------------------------------------------------------------
ALTER TABLE public.deposits
    ADD COLUMN IF NOT EXISTS credited BOOLEAN;

-- Existing rows keep a NULL marker: it means "no atomic credit was recorded".
-- They are already terminal (confirmed / expired) so they produce no new events,
-- and nothing here claims a past credit happened. New rows get FALSE.
UPDATE public.deposits SET credited = FALSE WHERE credited IS NULL;

ALTER TABLE public.deposits
    ALTER COLUMN credited SET DEFAULT FALSE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'deposits'
           AND column_name = 'credited' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE public.deposits ALTER COLUMN credited SET NOT NULL;
    END IF;
END $$;

COMMENT ON COLUMN public.deposits.credited IS
    'TRUE only when confirm_legacy_deposit_safe() credited the wallet in the same transaction. A bare status=''confirmed'' is NOT proof of a credit.';

-- ---------------------------------------------------------------------------
-- 2. Atomic legacy confirmation
-- ---------------------------------------------------------------------------
-- Mirrors the guarantee of credit_payment_safe():
--   validate -> row lock -> idempotency re-check AFTER the lock -> atomic wallet
--   increment -> ledger row -> status/credited -> single commit.
--
-- Idempotency: `credited` is the anchor. A retry (double click, admin retry,
-- two concurrent requests) finds credited = TRUE, returns duplicate = TRUE and
-- credits NOTHING. There is no second source of truth: `credited` is written by
-- this function and read by the notification pipeline, and `status` keeps its
-- existing meaning for the rest of the application.
CREATE OR REPLACE FUNCTION public.confirm_legacy_deposit_safe(
    p_deposit_id BIGINT,
    p_user_id    BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_deposit     public.deposits%ROWTYPE;
    v_wallet      public.wallets%ROWTYPE;
    v_amount      NUMERIC;
    v_new_balance NUMERIC;
    v_detail      TEXT;
BEGIN
    IF p_deposit_id IS NULL THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'invalid_input');
    END IF;

    -- Fast idempotency check before taking any lock.
    SELECT * INTO v_deposit FROM public.deposits WHERE id = p_deposit_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'deposit_not_found');
    END IF;
    IF p_user_id IS NOT NULL AND v_deposit.user_id IS DISTINCT FROM p_user_id THEN
        -- The caller must know the owner; never credit one account for another.
        RETURN jsonb_build_object('success', FALSE, 'error', 'user_mismatch');
    END IF;
    IF COALESCE(v_deposit.credited, FALSE) THEN
        RETURN jsonb_build_object(
            'success', TRUE,
            'duplicate', TRUE,
            'credited', FALSE,
            'amount', v_deposit.amount,
            'status', v_deposit.status
        );
    END IF;

    -- Row lock: concurrent confirmations serialise here.
    SELECT * INTO v_deposit FROM public.deposits WHERE id = p_deposit_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'deposit_not_found');
    END IF;
    IF p_user_id IS NOT NULL AND v_deposit.user_id IS DISTINCT FROM p_user_id THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'user_mismatch');
    END IF;

    -- Idempotency check AFTER the lock (race-condition protection).
    IF COALESCE(v_deposit.credited, FALSE) THEN
        RETURN jsonb_build_object(
            'success', TRUE,
            'duplicate', TRUE,
            'credited', FALSE,
            'amount', v_deposit.amount,
            'status', v_deposit.status
        );
    END IF;

    IF lower(COALESCE(v_deposit.status, '')) <> 'pending' THEN
        -- Expired / cancelled / otherwise terminal rows are never credited.
        RETURN jsonb_build_object(
            'success', FALSE,
            'error', 'not_pending',
            'status', v_deposit.status
        );
    END IF;

    v_amount := COALESCE(v_deposit.amount, 0);
    IF v_amount <= 0 THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'invalid_amount');
    END IF;

    -- Atomic wallet credit (no read-modify-write in application code).
    SELECT * INTO v_wallet FROM public.wallets WHERE user_id = v_deposit.user_id FOR UPDATE;
    IF v_wallet IS NULL THEN
        INSERT INTO public.wallets (user_id, live_balance, demo_balance, bonus_balance)
        VALUES (v_deposit.user_id, v_amount, 0, 0)
        RETURNING * INTO v_wallet;
        v_new_balance := v_amount;
    ELSE
        -- Only live_balance is touched: the wallet table carries no audit column
        -- this function could rely on, and the ledger row below records the move.
        UPDATE public.wallets
           SET live_balance = live_balance + v_amount
         WHERE user_id = v_deposit.user_id
        RETURNING live_balance INTO v_new_balance;
    END IF;

    -- Same ledger shape the application used (addTransaction), so history and
    -- the transaction log render exactly as before.
    v_detail := 'USDT (' || COALESCE(NULLIF(v_deposit.network, ''), 'TRC20') || ')';
    INSERT INTO public.transactions (user_id, type, amount, detail, created_at)
    VALUES (v_deposit.user_id, 'Deposit', v_amount, v_detail, NOW());

    -- LAST: mark confirmed. The conversion trigger (040/041) fires on this
    -- UPDATE, i.e. AFTER the wallet credit, inside this same transaction.
    UPDATE public.deposits
       SET status = 'confirmed',
           credited = TRUE
     WHERE id = p_deposit_id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'duplicate', FALSE,
        'credited', TRUE,
        'amount', v_amount,
        'new_balance', v_new_balance,
        'status', 'confirmed'
    );

EXCEPTION WHEN OTHERS THEN
    -- No partial state: PL/pgSQL rolls the whole function body back.
    RETURN jsonb_build_object(
        'success', FALSE,
        'error', 'exception',
        'detail', SQLSTATE
    );
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_legacy_deposit_safe(BIGINT, BIGINT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_legacy_deposit_safe(BIGINT, BIGINT) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Capture trigger: the legacy branch now requires the credit marker
-- ---------------------------------------------------------------------------
-- Re-stated here (identical to 040 apart from the marker check) so that applying
-- 041 alone on top of 040 is enough; 040 was edited in the same release, so a
-- re-apply of either file yields the same function.
CREATE OR REPLACE FUNCTION public.conversion_capture_deposit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id BIGINT;
    v_amount  NUMERIC;
    v_key     TEXT;
    v_source  TEXT;
    v_payload JSONB;
BEGIN
    IF TG_TABLE_NAME = 'payment_invoices' THEN
        IF COALESCE(NEW.status, '') <> 'confirmed' THEN
            RETURN NEW;
        END IF;
        IF COALESCE(NEW.credited, FALSE) = FALSE THEN
            -- "confirmed" without an authoritative credit is not a credit.
            RETURN NEW;
        END IF;
        v_user_id := NEW.user_id;
        v_amount  := NEW.amount_usd;
        v_key     := 'deposit:invoice:' || NEW.id::text;
        v_source  := 'payment_invoice';
        v_payload := jsonb_build_object('invoiceId', NEW.id);
    ELSE
        IF COALESCE(NEW.status, '') <> 'confirmed' THEN
            RETURN NEW;
        END IF;
        -- status alone proves nothing on the legacy table: see the file header.
        IF COALESCE(NEW.credited, FALSE) = FALSE THEN
            RETURN NEW;
        END IF;
        v_user_id := NEW.user_id;
        v_amount  := NEW.amount;
        v_key     := 'deposit:legacy:' || NEW.id::text;
        v_source  := 'legacy_deposit';
        v_payload := jsonb_build_object('depositId', NEW.id);
    END IF;

    IF v_user_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF public.conversion_user_is_sandbox(v_user_id) THEN
        RETURN NEW;
    END IF;

    PERFORM public.conversion_record_event(
        'deposit_confirmed',
        v_key,
        v_user_id,
        v_amount,
        v_source,
        COALESCE(v_payload, '{}'::jsonb),
        'transactional'
    );
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'conversion_capture_deposit skipped (%): %', TG_TABLE_NAME, SQLERRM;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.conversion_capture_deposit() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Reconciliation: recover an event a capture trigger failed to record
-- ---------------------------------------------------------------------------
-- The capture triggers deliberately catch their own errors (a telemetry failure
-- must never block a deposit). That trades completeness for availability, so a
-- swallowed error would otherwise be a PERMANENT gap. This function re-derives
-- the events from the authoritative markers over a bounded recent window and is
-- idempotent: the dedupe keys are the same ones the triggers use, so a row that
-- WAS captured produces nothing.
--
-- It never invents a fact: every row it reads is a committed, credited deposit
-- or a committed, qualified referral. Registration events are not backfilled
-- (they have no notification and carry no value retroactively).
CREATE OR REPLACE FUNCTION public.conversion_backfill_missing(
    p_since_minutes INTEGER DEFAULT 2880,
    p_limit         INTEGER DEFAULT 200
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_since      INTERVAL;
    v_limit      INTEGER;
    v_invoices   INTEGER := 0;
    v_deposits   INTEGER := 0;
    v_referrals  INTEGER := 0;
    v_row        RECORD;
BEGIN
    v_limit := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
    v_since := make_interval(mins => LEAST(GREATEST(COALESCE(p_since_minutes, 2880), 5), 43200));

    -- Provider invoices: confirmed AND credited is the authoritative marker.
    IF to_regclass('public.payment_invoices') IS NOT NULL THEN
        FOR v_row IN
            SELECT i.id, i.user_id, i.amount_usd
              FROM public.payment_invoices i
             WHERE COALESCE(i.status, '') = 'confirmed'
               AND COALESCE(i.credited, FALSE) = TRUE
               AND i.user_id IS NOT NULL
               AND COALESCE(i.updated_at, i.created_at) >= now() - v_since
               AND NOT EXISTS (
                   SELECT 1 FROM public.conversion_events e
                    WHERE e.dedupe_key = 'deposit:invoice:' || i.id::text
               )
             ORDER BY i.id ASC
             LIMIT v_limit
        LOOP
            IF NOT public.conversion_user_is_sandbox(v_row.user_id)
               AND public.conversion_record_event(
                       'deposit_confirmed',
                       'deposit:invoice:' || v_row.id::text,
                       v_row.user_id,
                       v_row.amount_usd,
                       'payment_invoice',
                       jsonb_build_object('invoiceId', v_row.id),
                       'transactional'
                   ) IS NOT NULL THEN
                v_invoices := v_invoices + 1;
            END IF;
        END LOOP;
    END IF;

    -- Legacy deposits: now requires the credit marker too.
    IF to_regclass('public.deposits') IS NOT NULL THEN
        FOR v_row IN
            SELECT d.id, d.user_id, d.amount
              FROM public.deposits d
             WHERE COALESCE(d.status, '') = 'confirmed'
               AND COALESCE(d.credited, FALSE) = TRUE
               AND d.user_id IS NOT NULL
               AND d.created_at >= now() - v_since
               AND NOT EXISTS (
                   SELECT 1 FROM public.conversion_events e
                    WHERE e.dedupe_key = 'deposit:legacy:' || d.id::text
               )
             ORDER BY d.id ASC
             LIMIT v_limit
        LOOP
            IF NOT public.conversion_user_is_sandbox(v_row.user_id)
               AND public.conversion_record_event(
                       'deposit_confirmed',
                       'deposit:legacy:' || v_row.id::text,
                       v_row.user_id,
                       v_row.amount,
                       'legacy_deposit',
                       jsonb_build_object('depositId', v_row.id),
                       'transactional'
                   ) IS NOT NULL THEN
                v_deposits := v_deposits + 1;
            END IF;
        END LOOP;
    END IF;

    -- Referral qualifications (recipient = the referrer).
    IF to_regclass('public.referrals') IS NOT NULL THEN
        FOR v_row IN
            SELECT r.id, r.referrer_id, r.bonus_earned
              FROM public.referrals r
             WHERE COALESCE(r.status, '') = 'active'
               AND COALESCE(r.bonus_earned, 0) > 0
               AND COALESCE(r.referred_id, 0) > 0
               AND r.referrer_id IS NOT NULL
               AND r.referrer_id <> r.referred_id
               AND COALESCE(r.qualified_at, r.created_at) >= now() - v_since
               AND NOT EXISTS (
                   SELECT 1 FROM public.conversion_events e
                    WHERE e.dedupe_key = 'referral:' || r.id::text
               )
             ORDER BY r.id ASC
             LIMIT v_limit
        LOOP
            IF NOT public.conversion_user_is_sandbox(v_row.referrer_id)
               AND public.conversion_record_event(
                       'referral_qualified',
                       'referral:' || v_row.id::text,
                       v_row.referrer_id,
                       v_row.bonus_earned,
                       'referrals',
                       jsonb_build_object('referralId', v_row.id),
                       'transactional'
                   ) IS NOT NULL THEN
                v_referrals := v_referrals + 1;
            END IF;
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'invoices', v_invoices,
        'deposits', v_deposits,
        'referrals', v_referrals,
        'total', v_invoices + v_deposits + v_referrals
    );
END;
$$;

REVOKE ALL ON FUNCTION public.conversion_backfill_missing(INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversion_backfill_missing(INTEGER, INTEGER) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Self-check (inside the transaction: a failure rolls this file back)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'deposits' AND column_name = 'credited'
    ) THEN
        v_missing := array_append(v_missing, 'column deposits.credited');
    END IF;

    IF to_regprocedure('public.confirm_legacy_deposit_safe(bigint,bigint)') IS NULL THEN
        v_missing := array_append(v_missing, 'function confirm_legacy_deposit_safe');
    END IF;
    IF to_regprocedure('public.conversion_backfill_missing(integer,integer)') IS NULL THEN
        v_missing := array_append(v_missing, 'function conversion_backfill_missing');
    END IF;
    IF to_regprocedure('public.conversion_capture_deposit()') IS NULL THEN
        v_missing := array_append(v_missing, 'function conversion_capture_deposit');
    END IF;

    -- The legacy branch must require the marker.
    IF position('COALESCE(NEW.credited, FALSE) = FALSE' in
                pg_get_functiondef('public.conversion_capture_deposit()'::regprocedure)) = 0 THEN
        v_missing := array_append(v_missing, 'legacy credit-marker guard');
    END IF;

    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'legacy deposit integrity: missing objects: %', array_to_string(v_missing, ', ');
    END IF;

    RAISE NOTICE 'legacy deposit integrity: marker, atomic RPC, trigger guard and backfill verified';
END $$;
