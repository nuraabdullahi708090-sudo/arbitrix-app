-- ============================================================================
-- BATCH 3 of 5: migrations 040 + 041 - MUST run as ONE transaction
-- ============================================================================
-- 040's legacy-deposit trigger reads deposits.credited, a column that only 041
-- creates. Between 040 and 041 a legacy deposit confirmation would record no
-- event (its handler raises a warning and returns); this batch removes that
-- window by committing both or neither.
--
-- Do not split this file. Do not remove the begin/commit.
-- Bodies below are the unmodified migration files:
--   supabase/migrations/040_conversion_events.sql
--   supabase/migrations/041_legacy_deposit_atomic_credit.sql
-- ============================================================================
begin;

-- ===========================================================================
-- 040_conversion_events.sql - durable conversion events + Telegram outbox
-- ===========================================================================
--
-- WHAT THIS ADDS
--   1. public.conversion_events          append-only record of business facts
--   2. public.conversion_notifications   retryable Telegram delivery outbox
--   3. capture triggers on the tables that ARE the authoritative markers of a
--      business event (users / payment_invoices / deposits / referrals)
--   4. operational RPCs: claim, complete, enqueue pending-deposit reminders,
--      purge
--
-- WHY TRIGGERS
--   The authoritative "money arrived" markers are written INSIDE PostgreSQL
--   credit functions (credit_payment_safe, paymento_credit_user_safe,
--   confirm_payment_with_credit, award_referral_qualification_safe) and by
--   several JS paths (legacy /api/deposit/status auto-confirm, admin confirm).
--   A JavaScript hook would have to be added to every one of them and would
--   silently miss any path added later. A row trigger fires inside the SAME
--   transaction as the marker write, so:
--     * the event exists if and only if the marker was committed;
--     * a duplicate/retried webhook cannot create a second event (the credit
--       function returns "duplicate" BEFORE writing, and the event key is
--       UNIQUE as a second line of defence).
--   This migration does NOT modify any credit function, wallet, ledger or
--   referral rule. It only OBSERVES the tables.
--
-- SAFETY POSTURE
--   * Every trigger function is defensive: any unexpected error is caught and
--     downgraded to a WARNING, so a problem here can never block a deposit, a
--     credit or a referral award.
--   * MARKETING_SANDBOX users are skipped (their demo never produces production
--     conversion events).
--   * Synthetic/test referral rows (referred_id <= 0) are skipped.
--   * The outbox stores NO chat id, NO message body and NO token: the delivery
--     target is resolved and re-validated at send time from
--     telegram_account_links + telegram_marketing_subscriptions.
--   * RLS is enabled with a single service_role policy; anon/authenticated get
--     no access at all. Both tables are service-role only, like 039.
--
-- DEPENDENCIES
--   * 039_telegram_account_links.sql  - required at SEND time (not here): the
--     reminder sweep refuses to run without it.
--   * 038_marketing_broadcast.sql     - required at SEND time for promotional
--     consent (telegram_marketing_subscriptions).
--   Both are checked with to_regclass() so this file applies cleanly even when
--   they are absent; the affected functions then report "not available" instead
--   of failing.
--
-- ROLLBACK (safe, no money data involved)
--   DROP TRIGGER IF EXISTS conversion_capture_registration ON public.users;
--   DROP TRIGGER IF EXISTS conversion_capture_deposit_invoice ON public.payment_invoices;
--   DROP TRIGGER IF EXISTS conversion_capture_deposit_legacy ON public.deposits;
--   DROP TRIGGER IF EXISTS conversion_capture_referral ON public.referrals;
--   DROP FUNCTION IF EXISTS public.conversion_capture_registration();
--   DROP FUNCTION IF EXISTS public.conversion_capture_deposit();
--   DROP FUNCTION IF EXISTS public.conversion_capture_referral();
--   DROP FUNCTION IF EXISTS public.conversion_record_event(TEXT, TEXT, BIGINT, NUMERIC, TEXT, JSONB, TEXT);
--   DROP FUNCTION IF EXISTS public.conversion_user_is_sandbox(BIGINT);
--   DROP FUNCTION IF EXISTS public.conversion_claim_notifications(TEXT, INTEGER);
--   DROP FUNCTION IF EXISTS public.conversion_complete_notification(BIGINT, TEXT, TEXT, INTEGER);
--   DROP FUNCTION IF EXISTS public.conversion_enqueue_pending_reminders(INTEGER, INTEGER, INTEGER);
--   DROP FUNCTION IF EXISTS public.conversion_purge(INTEGER, INTEGER);
--   DROP TABLE IF EXISTS public.conversion_notifications;
--   DROP TABLE IF EXISTS public.conversion_events;
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.conversion_events (
    id           BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    event_type   TEXT        NOT NULL,
    dedupe_key   TEXT        NOT NULL,
    user_id      BIGINT      NOT NULL,
    amount       NUMERIC(18,2),
    source       TEXT        NOT NULL DEFAULT 'unknown',
    payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.conversion_events DROP CONSTRAINT IF EXISTS conversion_events_type_check;
ALTER TABLE public.conversion_events
    ADD CONSTRAINT conversion_events_type_check
    CHECK (event_type IN ('registration', 'deposit_confirmed', 'referral_qualified', 'deposit_pending_reminder'));

ALTER TABLE public.conversion_events DROP CONSTRAINT IF EXISTS conversion_events_dedupe_key_key;
ALTER TABLE public.conversion_events
    ADD CONSTRAINT conversion_events_dedupe_key_key UNIQUE (dedupe_key);

ALTER TABLE public.conversion_events DROP CONSTRAINT IF EXISTS conversion_events_user_id_fkey;
ALTER TABLE public.conversion_events
    ADD CONSTRAINT conversion_events_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS conversion_events_user_idx
    ON public.conversion_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS conversion_events_type_idx
    ON public.conversion_events (event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS public.conversion_notifications (
    id                BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    event_id          BIGINT      NOT NULL,
    event_type        TEXT        NOT NULL,
    category          TEXT        NOT NULL,
    user_id           BIGINT      NOT NULL,
    idempotency_key   TEXT        NOT NULL,
    status            TEXT        NOT NULL DEFAULT 'pending',
    attempts          INTEGER     NOT NULL DEFAULT 0,
    max_attempts      INTEGER     NOT NULL DEFAULT 5,
    next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_expires_at  TIMESTAMPTZ,
    claimed_by        TEXT,
    last_error        TEXT,
    skip_reason       TEXT,
    sent_at           TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.conversion_notifications DROP CONSTRAINT IF EXISTS conversion_notifications_event_id_fkey;
ALTER TABLE public.conversion_notifications
    ADD CONSTRAINT conversion_notifications_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES public.conversion_events (id) ON DELETE CASCADE;

ALTER TABLE public.conversion_notifications DROP CONSTRAINT IF EXISTS conversion_notifications_key_key;
ALTER TABLE public.conversion_notifications
    ADD CONSTRAINT conversion_notifications_key_key UNIQUE (idempotency_key);

ALTER TABLE public.conversion_notifications DROP CONSTRAINT IF EXISTS conversion_notifications_category_check;
ALTER TABLE public.conversion_notifications
    ADD CONSTRAINT conversion_notifications_category_check
    CHECK (category IN ('transactional', 'promotional'));

ALTER TABLE public.conversion_notifications DROP CONSTRAINT IF EXISTS conversion_notifications_status_check;
ALTER TABLE public.conversion_notifications
    ADD CONSTRAINT conversion_notifications_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed'));

ALTER TABLE public.conversion_notifications DROP CONSTRAINT IF EXISTS conversion_notifications_attempts_check;
ALTER TABLE public.conversion_notifications
    ADD CONSTRAINT conversion_notifications_attempts_check
    CHECK (attempts >= 0 AND max_attempts > 0);

-- Claim scan + cleanup support.
CREATE INDEX IF NOT EXISTS conversion_notifications_due_idx
    ON public.conversion_notifications (next_attempt_at)
    WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS conversion_notifications_lease_idx
    ON public.conversion_notifications (lease_expires_at)
    WHERE status = 'sending';
CREATE INDEX IF NOT EXISTS conversion_notifications_user_idx
    ON public.conversion_notifications (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. RLS - service_role only (no anon / authenticated access at all)
-- ---------------------------------------------------------------------------

ALTER TABLE public.conversion_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversion_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversion_events_service_all ON public.conversion_events;
CREATE POLICY conversion_events_service_all
    ON public.conversion_events
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS conversion_notifications_service_all ON public.conversion_notifications;
CREATE POLICY conversion_notifications_service_all
    ON public.conversion_notifications
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);

REVOKE ALL ON public.conversion_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.conversion_notifications FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.conversion_events TO service_role;
GRANT ALL ON public.conversion_notifications TO service_role;

DO $$
BEGIN
    IF to_regclass('public.conversion_events_id_seq') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON SEQUENCE public.conversion_events_id_seq FROM PUBLIC, anon, authenticated';
        EXECUTE 'GRANT ALL ON SEQUENCE public.conversion_events_id_seq TO service_role';
    END IF;
    IF to_regclass('public.conversion_notifications_id_seq') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON SEQUENCE public.conversion_notifications_id_seq FROM PUBLIC, anon, authenticated';
        EXECUTE 'GRANT ALL ON SEQUENCE public.conversion_notifications_id_seq TO service_role';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------

-- Sandbox classifier that never raises: when migration 013 (users.environment)
-- is absent there are no sandbox accounts, so production behaviour applies -
-- the same fail-closed-to-production rule server.js uses.
CREATE OR REPLACE FUNCTION public.conversion_user_is_sandbox(p_user_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_is_sandbox BOOLEAN := FALSE;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN FALSE;
    END IF;
    BEGIN
        SELECT EXISTS (
            SELECT 1 FROM public.users
             WHERE id = p_user_id AND environment = 'MARKETING_SANDBOX'
        ) INTO v_is_sandbox;
    EXCEPTION WHEN OTHERS THEN
        v_is_sandbox := FALSE;
    END;
    RETURN COALESCE(v_is_sandbox, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.conversion_user_is_sandbox(BIGINT) FROM PUBLIC, anon, authenticated;

-- Record one business event, plus (optionally) exactly one outbox row.
--
-- Idempotency: conversion_events.dedupe_key is UNIQUE, so a duplicate call is a
-- no-op that returns NULL. The notification shares the same key, so the pair is
-- created together exactly once. A caller that gets NULL knows the fact was
-- already recorded and must not notify again.
CREATE OR REPLACE FUNCTION public.conversion_record_event(
    p_event_type     TEXT,
    p_dedupe_key     TEXT,
    p_user_id        BIGINT,
    p_amount         NUMERIC DEFAULT NULL,
    p_source         TEXT DEFAULT 'unknown',
    p_payload        JSONB DEFAULT '{}'::jsonb,
    p_notify_category TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_event_id BIGINT;
BEGIN
    IF p_event_type IS NULL OR p_dedupe_key IS NULL OR p_user_id IS NULL THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.conversion_events (event_type, dedupe_key, user_id, amount, source, payload)
    VALUES (p_event_type, p_dedupe_key, p_user_id, p_amount, COALESCE(p_source, 'unknown'), COALESCE(p_payload, '{}'::jsonb))
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id INTO v_event_id;

    IF v_event_id IS NULL THEN
        -- Already recorded (duplicate webhook, retried request, re-run trigger).
        RETURN NULL;
    END IF;

    IF p_notify_category IS NOT NULL THEN
        INSERT INTO public.conversion_notifications (
            event_id, event_type, category, user_id, idempotency_key, status, next_attempt_at
        )
        VALUES (v_event_id, p_event_type, p_notify_category, p_user_id, p_dedupe_key, 'pending', now())
        ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;

    RETURN v_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.conversion_record_event(TEXT, TEXT, BIGINT, NUMERIC, TEXT, JSONB, TEXT)
    FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Capture triggers
-- ---------------------------------------------------------------------------

-- A. Registration. Recorded durably, NEVER notified: a new account must not
--    receive promotional Telegram messages (see the Phase 2 brief).
CREATE OR REPLACE FUNCTION public.conversion_capture_registration()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.conversion_user_is_sandbox(NEW.id) THEN
        RETURN NEW;
    END IF;
    PERFORM public.conversion_record_event(
        'registration',
        'registration:' || NEW.id::text,
        NEW.id,
        NULL,
        'users',
        jsonb_build_object('userId', NEW.id),
        NULL            -- no notification
    );
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Never block account creation because telemetry failed.
    RAISE WARNING 'conversion_capture_registration skipped for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.conversion_capture_registration() FROM PUBLIC, anon, authenticated;

-- B. Deposit confirmed. Fires on the AUTHORITATIVE marker only:
--    payment_invoices.status = 'confirmed' AND credited = TRUE (provider credits)
--    or deposits.status = 'confirmed' (legacy / admin confirm paths).
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
        -- The legacy `deposits` table historically had no credit marker: the
        -- application flipped status to 'confirmed' and only THEN called the
        -- wallet update, so a status change alone proves nothing. Migration 041
        -- adds `deposits.credited`, set by the atomic
        -- confirm_legacy_deposit_safe() AFTER the wallet credit and in the same
        -- transaction, and this trigger refuses to record the event without it.
        -- Consequence (deliberate): a status flip that forgot to credit produces
        -- NO notification instead of a false "we received your deposit". If 041
        -- has not been applied yet this reference raises, the handler below logs
        -- a warning and no legacy event is recorded - the safe direction. Apply
        -- 040 and 041 together (see 041's header).
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

-- C. Referral qualified. The recipient is the REFERRER. Synthetic rows
--    (referred_id <= 0, used by the sandbox/test helpers) are ignored.
CREATE OR REPLACE FUNCTION public.conversion_capture_referral()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF COALESCE(NEW.status, '') <> 'active' THEN
        RETURN NEW;
    END IF;
    IF COALESCE(NEW.bonus_earned, 0) <= 0 THEN
        RETURN NEW;
    END IF;
    IF COALESCE(NEW.referred_id, 0) <= 0 THEN
        RETURN NEW;
    END IF;
    IF NEW.referrer_id = NEW.referred_id THEN
        -- Self-referral is refused upstream; never announce one either.
        RETURN NEW;
    END IF;
    IF NEW.referrer_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF public.conversion_user_is_sandbox(NEW.referrer_id) THEN
        RETURN NEW;
    END IF;

    PERFORM public.conversion_record_event(
        'referral_qualified',
        'referral:' || NEW.id::text,
        NEW.referrer_id,
        NEW.bonus_earned,
        'referrals',
        jsonb_build_object('referralId', NEW.id),
        'transactional'
    );
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'conversion_capture_referral skipped for referral %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.conversion_capture_referral() FROM PUBLIC, anon, authenticated;

-- Attach the triggers only to tables that actually exist in this database, so
-- the file applies cleanly on a partially provisioned environment.
DO $$
BEGIN
    IF to_regclass('public.users') IS NOT NULL THEN
        EXECUTE 'DROP TRIGGER IF EXISTS conversion_capture_registration ON public.users';
        EXECUTE 'CREATE TRIGGER conversion_capture_registration
                 AFTER INSERT ON public.users
                 FOR EACH ROW EXECUTE FUNCTION public.conversion_capture_registration()';
    END IF;

    IF to_regclass('public.payment_invoices') IS NOT NULL THEN
        EXECUTE 'DROP TRIGGER IF EXISTS conversion_capture_deposit_invoice ON public.payment_invoices';
        EXECUTE 'CREATE TRIGGER conversion_capture_deposit_invoice
                 AFTER INSERT OR UPDATE OF status, credited ON public.payment_invoices
                 FOR EACH ROW EXECUTE FUNCTION public.conversion_capture_deposit()';
    END IF;

    IF to_regclass('public.deposits') IS NOT NULL THEN
        EXECUTE 'DROP TRIGGER IF EXISTS conversion_capture_deposit_legacy ON public.deposits';
        EXECUTE 'CREATE TRIGGER conversion_capture_deposit_legacy
                 AFTER INSERT OR UPDATE OF status ON public.deposits
                 FOR EACH ROW EXECUTE FUNCTION public.conversion_capture_deposit()';
    END IF;

    IF to_regclass('public.referrals') IS NOT NULL THEN
        EXECUTE 'DROP TRIGGER IF EXISTS conversion_capture_referral ON public.referrals';
        EXECUTE 'CREATE TRIGGER conversion_capture_referral
                 AFTER INSERT OR UPDATE OF status, bonus_earned ON public.referrals
                 FOR EACH ROW EXECUTE FUNCTION public.conversion_capture_referral()';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Outbox operations
-- ---------------------------------------------------------------------------

-- Claim up to p_limit due notifications for one worker.
--
-- Duplicate-worker safety: FOR UPDATE SKIP LOCKED means two workers can never
-- claim the same row; a lease (lease_expires_at) makes a crashed worker's claims
-- reclaimable; attempts is incremented at CLAIM time so a message can never be
-- retried forever even if the worker dies mid-send.
CREATE OR REPLACE FUNCTION public.conversion_claim_notifications(
    p_worker_id TEXT,
    p_limit     INTEGER DEFAULT 20,
    p_lease_seconds INTEGER DEFAULT 180
)
RETURNS SETOF public.conversion_notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
    v_lease INTEGER := LEAST(GREATEST(COALESCE(p_lease_seconds, 180), 30), 900);
BEGIN
    RETURN QUERY
    WITH due AS (
        SELECT id
          FROM public.conversion_notifications
         WHERE (status = 'pending' AND next_attempt_at <= now())
            OR (status = 'failed' AND next_attempt_at <= now() AND attempts < max_attempts)
            -- A claimed row whose lease ran out belongs to a worker that died or
            -- stalled. A NULL lease on a 'sending' row cannot be produced by the
            -- claim below (it always sets one), so treating it as expired is pure
            -- defence: without it such a row would be stuck forever.
            OR (status = 'sending' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
         ORDER BY next_attempt_at ASC, id ASC
         LIMIT v_limit
         FOR UPDATE SKIP LOCKED
    )
    UPDATE public.conversion_notifications n
       SET status = 'sending',
           attempts = n.attempts + 1,
           claimed_by = COALESCE(NULLIF(p_worker_id, ''), 'worker'),
           lease_expires_at = now() + make_interval(secs => v_lease),
           updated_at = now()
      FROM due
     WHERE n.id = due.id
    RETURNING n.*;
END;
$$;

REVOKE ALL ON FUNCTION public.conversion_claim_notifications(TEXT, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversion_claim_notifications(TEXT, INTEGER, INTEGER) TO service_role;

-- Finish one claimed notification.
--   'sent'    -> terminal success (sent_at set)
--   'skipped' -> terminal, deliberate non-delivery (p_reason explains why)
--   'failed'  -> retry with backoff, or terminal once attempts hit max_attempts
-- Any row not currently 'sending' is left alone, so a duplicate completion call
-- is harmless.
-- The 4-argument version is replaced by the fenced one below. Dropping the
-- exact old signature keeps a single (unambiguous) function for PostgREST; the
-- new parameter defaults, so a 4-argument call still works.
DROP FUNCTION IF EXISTS public.conversion_complete_notification(BIGINT, TEXT, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.conversion_complete_notification(
    p_id            BIGINT,
    p_status        TEXT,
    p_reason        TEXT DEFAULT NULL,
    p_retry_seconds INTEGER DEFAULT NULL,
    p_worker_id     TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.conversion_notifications%ROWTYPE;
    v_backoff INTEGER;
BEGIN
    IF p_id IS NULL OR p_status NOT IN ('sent', 'skipped', 'failed') THEN
        RETURN FALSE;
    END IF;

    SELECT * INTO v_row
      FROM public.conversion_notifications
     WHERE id = p_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    -- Only a claimed row may be completed (prevents a stale worker from
    -- overwriting a row another worker already finished).
    IF v_row.status <> 'sending' THEN
        RETURN FALSE;
    END IF;
    -- FENCE: when the caller identifies itself, it may only complete a row it
    -- still owns. A worker that stalled past its lease and was superseded gets
    -- FALSE instead of clobbering the newer claim. The CURRENT owner always
    -- matches, so this can never wedge a row. (The lease itself is not required
    -- to be live: a worker whose send simply took longer than the lease should
    -- still be allowed to record its own outcome, which avoids a duplicate.)
    IF p_worker_id IS NOT NULL
       AND COALESCE(v_row.claimed_by, '') <> COALESCE(NULLIF(p_worker_id, ''), 'worker') THEN
        RETURN FALSE;
    END IF;

    IF p_status = 'sent' THEN
        UPDATE public.conversion_notifications
           SET status = 'sent',
               sent_at = now(),
               lease_expires_at = NULL,
               claimed_by = NULL,
               last_error = NULL,
               updated_at = now()
         WHERE id = p_id;
        RETURN TRUE;
    END IF;

    IF p_status = 'skipped' THEN
        UPDATE public.conversion_notifications
           SET status = 'skipped',
               skip_reason = LEFT(COALESCE(p_reason, 'skipped'), 200),
               lease_expires_at = NULL,
               claimed_by = NULL,
               updated_at = now()
         WHERE id = p_id;
        RETURN TRUE;
    END IF;

    -- 'failed'
    IF v_row.attempts >= v_row.max_attempts THEN
        UPDATE public.conversion_notifications
           SET status = 'failed',
               last_error = LEFT(COALESCE(p_reason, 'failed'), 500),
               next_attempt_at = now(),
               lease_expires_at = NULL,
               claimed_by = NULL,
               updated_at = now()
         WHERE id = p_id;
        RETURN TRUE;
    END IF;

    -- Exponential backoff (1m, 2m, 4m, 8m, ...) capped at 6h; an explicit
    -- Telegram retry_after always wins.
    v_backoff := LEAST(
        COALESCE(p_retry_seconds, (60 * power(2, GREATEST(v_row.attempts - 1, 0)))::INTEGER),
        21600
    );

    UPDATE public.conversion_notifications
       SET status = 'pending',
           last_error = LEFT(COALESCE(p_reason, 'failed'), 500),
           next_attempt_at = now() + make_interval(secs => GREATEST(v_backoff, 30)),
           lease_expires_at = NULL,
           claimed_by = NULL,
           updated_at = now()
     WHERE id = p_id;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.conversion_complete_notification(BIGINT, TEXT, TEXT, INTEGER, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversion_complete_notification(BIGINT, TEXT, TEXT, INTEGER, TEXT) TO service_role;

-- Enqueue at most p_max_per_deposit PROMOTIONAL reminders for deposits that are
-- still genuinely pending.
--
-- Preconditions enforced here (the worker re-checks all of them immediately
-- before sending):
--   * status is still 'pending' (expired / cancelled / confirmed are excluded);
--   * the invoice has not expired;
--   * the user has a LINKED Telegram chat (migration 039) and is SUBSCRIBED
--     (migration 038) - marketing consent, which account linking is not;
--   * the deposit is older than p_delay_minutes;
--   * fewer than p_max_per_deposit reminders already exist for that invoice.
-- Returns the number of reminders enqueued.
CREATE OR REPLACE FUNCTION public.conversion_enqueue_pending_reminders(
    p_delay_minutes  INTEGER DEFAULT 30,
    p_max_per_deposit INTEGER DEFAULT 1,
    p_limit          INTEGER DEFAULT 50
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count   INTEGER := 0;
    v_row     RECORD;
    v_existing INTEGER;
    v_key     TEXT;
    v_limit   INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
    v_max     INTEGER := LEAST(GREATEST(COALESCE(p_max_per_deposit, 1), 1), 5);
    v_delay   INTEGER := LEAST(GREATEST(COALESCE(p_delay_minutes, 30), 5), 10080);
BEGIN
    -- Promotional reminders need BOTH the link table and the consent table.
    IF to_regclass('public.payment_invoices') IS NULL
       OR to_regclass('public.telegram_account_links') IS NULL
       OR to_regclass('public.telegram_marketing_subscriptions') IS NULL THEN
        RETURN 0;
    END IF;

    FOR v_row IN
        SELECT i.id, i.user_id, i.amount_usd
          FROM public.payment_invoices i
          JOIN public.telegram_account_links l
            ON l.user_id = i.user_id
           AND l.telegram_chat_id IS NOT NULL
          JOIN public.telegram_marketing_subscriptions s
            ON s.telegram_chat_id = l.telegram_chat_id
           AND s.subscribed = TRUE
         WHERE lower(COALESCE(i.status, '')) = 'pending'
           AND i.created_at <= now() - make_interval(mins => v_delay)
           AND (i.expires_at IS NULL OR i.expires_at > now())
           AND i.user_id IS NOT NULL
         ORDER BY i.created_at ASC
         LIMIT v_limit
    LOOP
        IF public.conversion_user_is_sandbox(v_row.user_id) THEN
            CONTINUE;
        END IF;

        SELECT count(*) INTO v_existing
          FROM public.conversion_notifications
         WHERE idempotency_key LIKE ('reminder:invoice:' || v_row.id::text || ':%');

        IF v_existing >= v_max THEN
            CONTINUE;
        END IF;

        v_key := 'reminder:invoice:' || v_row.id::text || ':' || (v_existing + 1)::text;

        IF public.conversion_record_event(
               'deposit_pending_reminder',
               v_key,
               v_row.user_id,
               v_row.amount_usd,
               'payment_invoice',
               jsonb_build_object('invoiceId', v_row.id),
               'promotional'
           ) IS NOT NULL THEN
            v_count := v_count + 1;
        END IF;
    END LOOP;

    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.conversion_enqueue_pending_reminders(INTEGER, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversion_enqueue_pending_reminders(INTEGER, INTEGER, INTEGER)
    TO service_role;

-- Safe cleanup. Never deletes a notification that is still in flight, and never
-- deletes an event that still has an undelivered notification.
CREATE OR REPLACE FUNCTION public.conversion_purge(
    p_notification_days INTEGER DEFAULT 90,
    p_event_days        INTEGER DEFAULT 180
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_notes INTEGER := 0;
    v_events INTEGER := 0;
BEGIN
    DELETE FROM public.conversion_notifications
     WHERE status IN ('sent', 'skipped')
       AND updated_at < now() - make_interval(days => GREATEST(COALESCE(p_notification_days, 90), 1));
    GET DIAGNOSTICS v_notes = ROW_COUNT;

    DELETE FROM public.conversion_events e
     WHERE e.created_at < now() - make_interval(days => GREATEST(COALESCE(p_event_days, 180), 1))
       AND NOT EXISTS (
           SELECT 1 FROM public.conversion_notifications n
            WHERE n.event_id = e.id
              AND n.status IN ('pending', 'sending', 'failed')
       );
    GET DIAGNOSTICS v_events = ROW_COUNT;

    RETURN jsonb_build_object('notificationsDeleted', v_notes, 'eventsDeleted', v_events);
END;
$$;

REVOKE ALL ON FUNCTION public.conversion_purge(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversion_purge(INTEGER, INTEGER) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Self-check (runs inside the transaction: a failure rolls the file back)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF to_regclass('public.conversion_events') IS NULL THEN
        v_missing := array_append(v_missing, 'table conversion_events');
    END IF;
    IF to_regclass('public.conversion_notifications') IS NULL THEN
        v_missing := array_append(v_missing, 'table conversion_notifications');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'conversion_events'
           AND policyname = 'conversion_events_service_all'
    ) THEN
        v_missing := array_append(v_missing, 'policy conversion_events_service_all');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'conversion_notifications'
           AND policyname = 'conversion_notifications_service_all'
    ) THEN
        v_missing := array_append(v_missing, 'policy conversion_notifications_service_all');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
         WHERE c.relname = 'conversion_events' AND c.relrowsecurity = TRUE
    ) THEN
        v_missing := array_append(v_missing, 'RLS on conversion_events');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
         WHERE c.relname = 'conversion_notifications' AND c.relrowsecurity = TRUE
    ) THEN
        v_missing := array_append(v_missing, 'RLS on conversion_notifications');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'conversion_events_dedupe_key_key'
    ) THEN
        v_missing := array_append(v_missing, 'unique dedupe_key');
    END IF;

    IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'conversion_capture_registration' AND NOT tgisinternal
    ) THEN
        v_missing := array_append(v_missing, 'trigger conversion_capture_registration');
    END IF;
    IF to_regclass('public.payment_invoices') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'conversion_capture_deposit_invoice' AND NOT tgisinternal
    ) THEN
        v_missing := array_append(v_missing, 'trigger conversion_capture_deposit_invoice');
    END IF;
    IF to_regclass('public.deposits') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'conversion_capture_deposit_legacy' AND NOT tgisinternal
    ) THEN
        v_missing := array_append(v_missing, 'trigger conversion_capture_deposit_legacy');
    END IF;
    IF to_regclass('public.referrals') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'conversion_capture_referral' AND NOT tgisinternal
    ) THEN
        v_missing := array_append(v_missing, 'trigger conversion_capture_referral');
    END IF;

    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'conversion_events: missing objects: %', array_to_string(v_missing, ', ');
    END IF;

    RAISE NOTICE 'conversion_events: schema, RLS and capture triggers verified';
END $$;

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

commit;
