-- ============================================
-- MIGRATION: 031 - Single-executor trade guard (browser vs server-side worker)
--                  (Additive, fail-open, self-checking, PRODUCTION ONLY)
-- ============================================
-- PURPOSE
--   /api/trade refuses a browser-originated trade whenever the session is owned
--   by the server-side worker (server.js isWorkerOwnedSession(): an ACTIVE
--   migration-029 executor lease, or a fresh heartbeat). That check is a
--   read-then-write, so a worker can claim the session in the gap between the
--   check and record_trade_safe() committing: the browser's trade and the
--   worker's trade would then both be recorded for what was meant to be a single
--   execution.
--
--   This trigger closes that gap ATOMICALLY, because it runs INSIDE the trade's
--   own transaction (record_trade_safe performs the INSERT INTO trades):
--     * worker claim committed BEFORE the trade  -> the trade is REFUSED;
--     * trade committed BEFORE the worker claimed -> it strictly preceded the
--       worker's ownership of the session, and the worker simply trades after it.
--   There is no interleaving in which both engines write while the same
--   ownership state is current, so the residual race can no longer produce a
--   concurrent duplicate execution.
--
-- DISCRIMINATOR (how the worker's own trade is admitted)
--   The worker's idempotency keys are SERVER-DERIVED and live in the `bot_`
--   namespace for that user: `bot_<user_id>_<mode>_<generation>_<bucket>`
--   (services/TradingWorker.js buildTickIdempotencyKey). Browser/API keys never
--   do - public/index.html and the /api/trade fallback both generate
--   `trade_<uid>_<timestamp>_<random>`. While a lease is ACTIVE only the worker's
--   namespace is admitted; everything else raced the claim.
--
-- POSTURE / SAFETY
--   * FAIL OPEN. Any unexpected condition (missing bot_sessions, missing lease
--     columns because 029 is not applied, NULLs, future schema drift) is
--     swallowed and the trade is ALLOWED. This guard must never be able to block
--     legitimate trading on its own - the application pre-check decides.
--   * WORKER-EXEMPT BY CONSTRUCTION. The check ADMITS the worker's namespace
--     rather than DENYING the browser's format, so a mis-specified pattern can
--     only weaken the backstop (a false negative) - it can never reject the
--     execution the guard exists to protect.
--   * STRICT NO-OP TODAY. With no worker holding a lease (the current production
--     state) the trigger returns immediately: no lease, nothing to enforce.
--   * MARKETING_SANDBOX is skipped defensively. Sandbox trades are recorded in
--     sandbox_trades and never reach this table; the explicit check guarantees a
--     sandbox account can never be affected by a production trading rule.
--   * NO FINANCIAL LOGIC. The trigger never reads or writes an amount, a
--     balance, a wallet or a ledger row. It only decides whether the INSERT may
--     proceed; record_trade_safe() and its arithmetic are untouched.
--     On refusal PostgreSQL rolls the whole record_trade_safe transaction back
--     (PL/pgSQL's exception handler implies a savepoint), so no wallet debit and
--     no ledger row survive - identical to migration 026's behaviour.
--   * The raised code is the same machine-readable code server.js already
--     returns from its pre-check (WORKER_OWNED_CODE), and record_trade_safe
--     surfaces it as {success:false, error:'WORKER_OWNED_SESSION'}, which
--     /api/trade maps to the same 409 body.
--
-- DEPENDENCIES: migration 029 (claimed_by / lease_expires_at on bot_sessions) and
--   028 (bot_sessions being the worker's session table). Missing columns are
--   tolerated (fail open), so applying 031 out of order cannot break trading.
--
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS + CREATE
--   TRIGGER, with a trailing self-check. Safe to run repeatedly.
--
-- NOT APPLIED by this repository. Apply through the normal migration review path.
-- server.js enforces the same condition pre-write even before this is applied.
-- ============================================

BEGIN;

-- ============================================
-- 1. GUARD FUNCTION
-- ============================================
CREATE OR REPLACE FUNCTION public.enforce_single_executor_trade()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_env        TEXT := 'PRODUCTION';
    v_is_running SMALLINT;
    v_claimed_by TEXT;
    v_lease_exp  TIMESTAMPTZ;
    -- Decided INSIDE the fail-open block and raised AFTER it: a RAISE inside the
    -- block would itself be swallowed by the WHEN OTHERS handler and the guard
    -- would silently never fire.
    v_block      BOOLEAN := FALSE;
BEGIN
    BEGIN
        BEGIN
            SELECT u.environment INTO v_env
              FROM public.users u
             WHERE u.id = NEW.user_id;
        EXCEPTION WHEN undefined_column OR undefined_table THEN
            v_env := 'PRODUCTION';
        END;

        -- R1: MARKETING_SANDBOX is never subject to production trading rules.
        IF v_env = 'MARKETING_SANDBOX' THEN
            RETURN NEW;
        END IF;

        -- R2: no session row -> no executor -> nothing to protect.
        SELECT s.is_running, s.claimed_by, s.lease_expires_at
          INTO v_is_running, v_claimed_by, v_lease_exp
          FROM public.bot_sessions s
         WHERE s.user_id = NEW.user_id;
        IF NOT FOUND THEN
            RETURN NEW;
        END IF;

        -- R3: a stopped session is not being driven by anything.
        IF COALESCE(v_is_running, 0) <> 1 THEN
            RETURN NEW;
        END IF;

        -- R4: no ACTIVE lease -> the browser/API is the legitimate executor.
        -- A NULL expiry counts as INACTIVE, mirroring 029's own claim predicate
        -- (`claimed_by IS NULL OR lease_expires_at IS NULL OR
        -- lease_expires_at <= now()`), so a crashed worker's stale claimant can
        -- never refuse trading forever - the lease expires and this returns NEW.
        IF v_claimed_by IS NULL OR v_lease_exp IS NULL OR v_lease_exp <= now() THEN
            RETURN NEW;
        END IF;

        -- R5: ACTIVE worker lease. Admit ONLY the worker's server-derived key
        -- namespace for THIS user (`bot_<user_id>_...`); every other key is a
        -- browser/API trade that raced the claim.
        IF NEW.idempotency_key IS NOT NULL
           AND NEW.idempotency_key LIKE 'bot\_' || NEW.user_id::text || '\_%' ESCAPE '\' THEN
            RETURN NEW;
        END IF;

        -- R6: a browser/API trade during an active worker lease -> refuse.
        v_block := TRUE;
    EXCEPTION WHEN OTHERS THEN
        RETURN NEW;   -- fail open: a guard error must never block a trade
    END;

    IF v_block THEN
        RAISE EXCEPTION 'WORKER_OWNED_SESSION';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_single_executor_trade() IS
    'Defence-in-depth for the browser-vs-worker single-executor rule. Refuses a trades INSERT (which only record_trade_safe performs) when the session carries an ACTIVE migration-029 executor lease AND the idempotency_key is not the server-side worker''s own namespace for that user (bot_<user_id>_...). Fail-open on unexpected errors; skips MARKETING_SANDBOX; never reads a balance or amount.';

-- ============================================
-- 2. TRIGGER
-- ============================================
DROP TRIGGER IF EXISTS trg_enforce_single_executor_trade ON public.trades;
CREATE TRIGGER trg_enforce_single_executor_trade
    BEFORE INSERT ON public.trades
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_single_executor_trade();

-- ============================================
-- 3. SELF-CHECK
-- ============================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'enforce_single_executor_trade'
    ) THEN
        RAISE EXCEPTION 'migration 031: enforce_single_executor_trade() was not created';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_enforce_single_executor_trade' AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'migration 031: trg_enforce_single_executor_trade was not created';
    END IF;

    RAISE NOTICE 'Migration 031 self-check passed (single-executor trade guard armed).';
END $$;

COMMIT;
