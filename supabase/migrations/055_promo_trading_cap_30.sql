-- ============================================
-- 055 - Promotional-credit trading cap raised to $30 (PRODUCTION ONLY)
-- ============================================
--
-- SUPERSEDES the $20 threshold in 026. Business rule (management decision):
-- a PRODUCTION user whose non-deposited Live capital IS the $50 promotional
-- credit may accumulate at most $30.00 of cumulative NET realized profit from
-- trading that credit. The lock is INCLUSIVE: >= $30.00 blocks (exactly $30.00
-- locks). A confirmed deposit, or a referral-earnings conversion, clears it
-- automatically because the rule is evaluated live against those sources.
--
-- WHY A SEPARATE MIGRATION. 026 has already been reviewed/applied in some
-- environments; rewriting it in place would leave the deployed function on the
-- old threshold depending on apply order. 055 re-creates the SAME function with
-- the SAME guards and only the threshold changed, then asserts that the ACTIVE
-- function body really says `>= 30`, so a stale re-apply of 026 fails loudly
-- instead of silently lowering the cap back to $20.
--
-- EVERYTHING ELSE IS BYTE-IDENTICAL TO 026: the source-of-funds rule map
-- (confirmed deposit -> exempt, MARKETING_SANDBOX -> exempt, referral-earnings
-- conversion -> exempt, otherwise capped), the fail-open exception handler, the
-- realized-P&L basis SUM(trades.amount) WHERE mode = 'live', and the trigger
-- definition. tests/promo_trading_cap.test.js proves only the threshold differs.
--
-- APPLICATION ORDER: apply 055 AFTER 026 (or apply 055 alone on a database that
-- never had 026 - it creates the function and the trigger itself).
--
-- NOT APPLIED by this repository. server.js and services/PromoCheck.js enforce
-- the cap at $30 before this trigger exists; the trigger is defence-in-depth
-- against concurrent trade inserts.

-- ============================================
-- 1. GUARD FUNCTION
-- ============================================
CREATE OR REPLACE FUNCTION public.enforce_promo_trade_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_env          TEXT := 'PRODUCTION';
    v_has_deposit  BOOLEAN := FALSE;
    v_promo_profit DECIMAL;
BEGIN
    -- SOURCE-OF-FUNDS RULE MAP (must stay identical to server.js
    -- isPromoCreditFunded() / hasConvertedReferralEarnings()):
    --   R1 confirmed deposit (deposits OR payment_invoices)      -> EXEMPT
    --   R2 MARKETING_SANDBOX                                      -> EXEMPT
    --   R3 referral conversion marker (ledger OR 'Bonus Withdrawal' tx) -> EXEMPT
    --   R4 otherwise (no deposit, not sandbox, no marker)         -> promo-funded -> cap
    --   R5 the Live balance amount is NEVER inspected
    --   R6 threshold is INCLUSIVE at >= $30.00
    --   R7 realized P&L basis is SUM(trades.amount) with mode = 'live'
    -- All guard inputs are computed defensively: an unexpected error must never
    -- block a legitimate trade (fail open — the application pre-check decides).
    BEGIN
        BEGIN
            SELECT u.environment INTO v_env
            FROM public.users u
            WHERE u.id = NEW.user_id;
        EXCEPTION WHEN undefined_column OR undefined_table THEN
            v_env := 'PRODUCTION';
        END;

        -- MARKETING_SANDBOX can never be capped by this production-only rule.
        IF v_env = 'MARKETING_SANDBOX' THEN
            RETURN NEW;
        END IF;

        -- Mirrors hasConfirmedDeposit(): a confirmed provider invoice OR a
        -- confirmed legacy deposit means the user is no longer promo-funded.
        SELECT (
            EXISTS (SELECT 1 FROM public.deposits d
                     WHERE d.user_id = NEW.user_id AND d.status = 'confirmed')
            OR
            EXISTS (SELECT 1 FROM public.payment_invoices pi
                     WHERE pi.user_id = NEW.user_id AND pi.status = 'confirmed')
        ) INTO v_has_deposit;

        IF v_has_deposit IS TRUE THEN
            RETURN NEW;   -- deposited users are never promo-restricted
        END IF;

        -- AUTHORITATIVE SOURCE-OF-FUNDS: a no-deposit user whose Live balance
        -- was funded (at least partly) by a referral-earnings conversion is NOT
        -- a promotional-credit user and must never be capped.
        --
        -- 1. Append-only conversion ledger (migration 023). It may be absent in
        --    schemas that predate 023; only this sub-check is skipped then, so a
        --    missing ledger can never disable the whole guard.
        BEGIN
            IF EXISTS (SELECT 1 FROM public.referral_earning_conversions c
                        WHERE c.user_id = NEW.user_id) THEN
                RETURN NEW;
            END IF;
        EXCEPTION WHEN undefined_table THEN
            NULL;   -- ledger not present; the transactions marker below applies
        END;

        -- 2. convert_referral_earnings_safe() writes this transactions row
        --    ATOMICALLY with the conversion and it exists in every schema.
        IF EXISTS (SELECT 1 FROM public.transactions tx
                    WHERE tx.user_id = NEW.user_id AND tx.type = 'Bonus Withdrawal') THEN
            RETURN NEW;
        END IF;

        SELECT COALESCE(SUM(t.amount), 0) INTO v_promo_profit
        FROM public.trades t
        WHERE t.user_id = NEW.user_id AND t.mode = 'live';
    EXCEPTION WHEN OTHERS THEN
        RETURN NEW;   -- fail open: never break trading on a guard error
    END;

    -- Inclusive lock: exactly $30.00 (or more) net realized profit blocks.
    IF v_promo_profit >= 30 THEN
        RAISE EXCEPTION 'PROMO_TRADING_LIMIT_REACHED';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_promo_trade_cap() IS
    'Defence-in-depth for the production-only $30 promotional-credit trading cap. Blocks a trades INSERT when the user is a promotional-credit user by authoritative source of funds — no confirmed deposit (deposits/payment_invoices) AND no referral-earnings conversion into Live balance (referral_earning_conversions ledger or "Bonus Withdrawal" transaction) — and the user''s cumulative net realized profit in `trades` is already >= $30.00. Fail-open on unexpected errors; skips MARKETING_SANDBOX; never consults the balance amount.';

-- ============================================
-- 2. TRIGGER
-- ============================================
DROP TRIGGER IF EXISTS trg_enforce_promo_trade_cap ON public.trades;
CREATE TRIGGER trg_enforce_promo_trade_cap
    BEFORE INSERT ON public.trades
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_promo_trade_cap();

-- ============================================
-- 3. SELF-CHECK
-- ============================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'enforce_promo_trade_cap'
    ) THEN
        RAISE EXCEPTION 'migration 026: enforce_promo_trade_cap() was not created';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_enforce_promo_trade_cap' AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'migration 026: trg_enforce_promo_trade_cap was not created';
    END IF;
END $$;

-- ============================================
-- 4. THRESHOLD SELF-CHECK
-- ============================================
-- Guards against apply-order regressions: a later re-apply of 026 would restore
-- the $20 body while this migration still counts as applied.
DO $$
DECLARE
    v_body TEXT;
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'enforce_promo_trade_cap';

    IF v_body IS NULL THEN
        RAISE EXCEPTION 'migration 055: enforce_promo_trade_cap() is missing';
    END IF;
    IF v_body NOT LIKE '%>= 30%' THEN
        RAISE EXCEPTION 'migration 055: the active cap threshold is not $30 (re-apply 055 after 026)';
    END IF;
    IF v_body LIKE '%>= 20%' THEN
        RAISE EXCEPTION 'migration 055: the active cap threshold is still $20';
    END IF;
END $$;
