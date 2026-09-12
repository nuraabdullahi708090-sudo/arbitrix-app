-- ============================================
-- 026 — Promotional-credit trading cap (PRODUCTION ONLY)
-- ============================================
--
-- BUSINESS RULE (management decision): a PRODUCTION user whose non-deposited
-- Live capital IS the $50 promotional credit is capped at $20.00 cumulative NET
-- realized profit from trading that credit. The lock is INCLUSIVE (>= $20.00).
-- Once reached, the bot is stopped and no further trading is accepted through
-- /api/trade or /api/bot/start until a confirmed deposit exists. A confirmed
-- deposit clears the restriction automatically (the cap is evaluated live
-- against confirmed deposits).
--
-- WHO IS A "PROMOTIONAL-CREDIT USER" is an AUTHORITATIVE SOURCE-OF-FUNDS
-- classification (mirroring server.js isPromoCreditFunded()), NOT "no deposit +
-- positive balance":
--   * a confirmed qualifying deposit -> NOT promotional-credit funded;
--   * a referral-earnings conversion into Live balance (a row in
--     referral_earning_conversions, and/or the 'Bonus Withdrawal' transaction
--     written atomically by convert_referral_earnings_safe()) -> NOT
--     promotional-credit funded;
--   * MARKETING_SANDBOX -> never classified, never capped;
--   * otherwise (no deposit, no conversion) the non-deposited Live capital is
--     the $50 promotional credit grant -> capped.
-- The Live balance AMOUNT is never consulted.
--
-- WHY A TRIGGER IS NEEDED. server.js already enforces the cap before the trade
-- RPC (and on bot start), which covers repeated requests, duplicate/replayed
-- idempotency keys, and bot restarts. The remaining vector is CONCURRENCY: two
-- (or many) parallel /api/trade requests could each read the ledger sum while
-- it is still below the cap and all be admitted. This trigger closes that hole
-- atomically: record_trade_safe() holds the `wallets` row FOR UPDATE for the
-- whole transaction, so the trigger's ledger sum is serialized per user and a
-- later transaction observes the earlier committed trade.
--
-- POSTURE / SAFETY:
--   * Fail open. Any unexpected condition (missing users.environment column,
--     missing deposit tables, NULLs, future schema drift) is swallowed and the
--     trade is allowed — this guard must never block legitimate trading.
--   * MARKETING_SANDBOX is skipped defensively. Sandbox trades are recorded in
--     sandbox_trades, so they never reach this table anyway; the explicit check
--     guarantees a sandbox account can never be capped by the production rule.
--   * Only the accounted profit basis is used: SUM(trades.amount) (signed), the
--     same server-authoritative realized-P&L ledger record_trade_safe() writes.
--   * The trigger is evaluated ONLY for users with no confirmed production
--     deposit (either `deposits` or `payment_invoices`, mirroring
--     hasConfirmedDeposit() in server.js) AND no referral-earnings conversion
--     into Live balance (the referral_earning_conversions ledger and/or the
--     'Bonus Withdrawal' transactions marker, mirroring
--     hasConvertedReferralEarnings()). Deposited users and referral-funded users
--     are therefore never restricted.
--   * The threshold literal mirrors PROMO_PROFIT_CAP_USD = 20 in server.js.
--
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS + CREATE
-- TRIGGER, with a trailing self-check. Safe to run repeatedly.
--
-- NOT APPLIED by this repository. Apply through the normal migration review
-- path. server.js enforces the cap (pre-check) even before it is applied.
-- ============================================

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
    --   R6 threshold is INCLUSIVE at >= $20.00
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

    -- Inclusive lock: exactly $20.00 (or more) net realized profit blocks.
    IF v_promo_profit >= 20 THEN
        RAISE EXCEPTION 'PROMO_TRADING_LIMIT_REACHED';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_promo_trade_cap() IS
    'Defence-in-depth for the production-only $20 promotional-credit trading cap. Blocks a trades INSERT when the user is a promotional-credit user by authoritative source of funds — no confirmed deposit (deposits/payment_invoices) AND no referral-earnings conversion into Live balance (referral_earning_conversions ledger or "Bonus Withdrawal" transaction) — and the user''s cumulative net realized profit in `trades` is already >= $20.00. Fail-open on unexpected errors; skips MARKETING_SANDBOX; never consults the balance amount.';

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
