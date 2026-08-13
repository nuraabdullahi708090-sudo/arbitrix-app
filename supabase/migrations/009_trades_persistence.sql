-- ============================================
-- Trades Persistence Migration
-- Arbitrix AI - Server-authoritative realized trading P&L
-- ============================================
--
-- Problem: realized trading profit existed only in localStorage['arbi_live']
-- (executeBotTrade mutates APP.liveData.balance client-side). After
-- logout/login localStorage was wiped, so realized P&L "disappeared" even
-- though the DB deposit baseline remained. The withdrawal gate also counted
-- transactions.type='Trade Executed' rows that were never written server-side.
--
-- Fix: make realized P&L server-authoritative by recording each realized
-- trade as an append-only ledger row and atomically crediting/debiting
-- wallets.live_balance inside a row-locked transaction. This reuses the EXACT
-- secure pattern already proven by credit_payment_safe():
--   - SECURITY DEFINER (elevated privileges)
--   - Idempotency check on trades.idempotency_key (UNIQUE)
--   - SELECT ... FOR UPDATE row lock on wallets
--   - Double-check idempotency AFTER lock (race-condition safe)
--   - Atomic wallet credit/debit (live_balance += amount, clamped at 0)
--   - Ledger row insert (trades) + user-facing transaction row (type='Trade Executed')
--   - EXCEPTION handler returns JSON error instead of corrupting state
--
-- This is NOT a second crediting system: deposits still go through
-- credit_payment_safe() untouched. Only realized trading P&L is added here.
-- RLS is disabled on the new table to match the existing payment tables
-- (BIGINT user_id / authorization-via-application-code model).
-- ============================================

-- ============================================
-- 0. DISABLE RLS (BIGINT compatibility, matches existing payment tables)
-- ============================================
ALTER TABLE public.trades DISABLE ROW LEVEL SECURITY;

-- ============================================
-- 1. CREATE TRADES LEDGER TABLE (append-only)
-- ============================================
CREATE TABLE IF NOT EXISTS public.trades (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('demo', 'live', 'bonus')),
    asset TEXT,
    detail TEXT,
    -- Signed realized P&L in USD. Positive = profit, negative = loss.
    amount DECIMAL(18, 2) NOT NULL,
    -- Authoritative wallet balance immediately after this trade was applied.
    balance_after DECIMAL(18, 2) NOT NULL,
    -- Prevents double-credit on client retry/replay (client-generated unique key).
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_user_created
    ON public.trades(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_user_id
    ON public.trades(user_id);

COMMENT ON TABLE public.trades IS
    'Append-only ledger of realized trading P&L. live-balance changes are applied atomically via record_trade_safe().';
COMMENT ON COLUMN public.trades.amount IS
    'Signed realized P&L in USD (profit > 0, loss < 0).';
COMMENT ON COLUMN public.trades.idempotency_key IS
    'Client-generated unique key preventing double-credit on retry/replay.';

-- ============================================
-- 2. SHARED ATOMIC TRADE RECORDING FUNCTION
-- ============================================
-- Mirrors credit_payment_safe() security guarantees, generalized for signed
-- trade P&L (profits and losses). Losses are clamped so live_balance can never
-- go negative: a loss is capped at the current balance (remaining balance -> 0)
-- rather than rejected, so a trade is never lost even if the client's stale
-- view of the balance would overshoot. The actual applied amount is returned so
-- the client can reconcile to the true authoritative balance.
CREATE OR REPLACE FUNCTION public.record_trade_safe(
    p_user_id BIGINT,
    p_amount DECIMAL,
    p_idempotency_key TEXT,
    p_mode TEXT DEFAULT 'live',
    p_asset TEXT DEFAULT NULL,
    p_detail TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_wallet wallets%ROWTYPE;
    v_existing_key TEXT;
    v_applied DECIMAL;
    v_new_balance DECIMAL;
    v_amount_usd DECIMAL;
    v_trade_id BIGINT;
BEGIN
    IF p_amount IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'amount is required');
    END IF;
    IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'idempotency_key is required');
    END IF;

    -- Idempotency check #1: same idempotency_key already recorded?
    SELECT idempotency_key INTO v_existing_key
    FROM trades
    WHERE idempotency_key = p_idempotency_key;

    IF v_existing_key IS NOT NULL THEN
        -- Replay: return the already-applied result so the client reconciles
        -- to the same authoritative balance instead of double-applying.
        SELECT balance_after, amount INTO v_new_balance, v_amount_usd
        FROM trades WHERE idempotency_key = p_idempotency_key;

        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Trade already recorded',
            'idempotency_key', p_idempotency_key,
            'new_balance', v_new_balance,
            'applied_amount', v_amount_usd
        );
    END IF;

    -- Lock the wallet row (get or create, mirroring credit_payment_safe).
    SELECT * INTO v_wallet
    FROM wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF v_wallet IS NULL THEN
        INSERT INTO wallets (user_id, live_balance, demo_balance, bonus_balance)
        VALUES (p_user_id, 0, 1000, 0)
        RETURNING * INTO v_wallet;
    END IF;

    -- Double-check idempotency AFTER lock (race-condition protection).
    SELECT idempotency_key INTO v_existing_key
    FROM trades
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing_key IS NOT NULL THEN
        SELECT balance_after, amount INTO v_new_balance, v_amount_usd
        FROM trades WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Trade already recorded (race condition prevented)',
            'idempotency_key', p_idempotency_key,
            'new_balance', v_new_balance,
            'applied_amount', v_amount_usd
        );
    END IF;

    -- Clamp losses so live_balance can never go negative. The applied amount
    -- may be smaller in magnitude than requested if a loss exceeds the balance.
    v_applied := p_amount;
    IF p_amount < 0 AND (v_wallet.live_balance + p_amount) < 0 THEN
        v_applied := -v_wallet.live_balance;  -- lose only what exists
    END IF;

    v_new_balance := GREATEST(0, v_wallet.live_balance + v_applied);

    -- Atomic wallet credit/debit.
    UPDATE wallets
    SET live_balance = v_new_balance,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    -- Append-only ledger row.
    INSERT INTO trades (user_id, mode, asset, detail, amount, balance_after, idempotency_key, created_at)
    VALUES (p_user_id, COALESCE(NULLIF(p_mode, ''), 'live'), p_asset, p_detail,
            v_applied, v_new_balance, p_idempotency_key, NOW())
    RETURNING id INTO v_trade_id;

    -- User-facing transaction (this is the row the withdrawal gate counts).
    INSERT INTO transactions (user_id, type, amount, detail, created_at)
    VALUES (p_user_id, 'Trade Executed', v_applied,
        COALESCE(NULLIF(p_asset, ''), 'Trade') ||
        CASE WHEN p_detail IS NOT NULL AND btrim(p_detail) <> '' THEN ' - ' || p_detail ELSE '' END,
        NOW());

    RETURN jsonb_build_object(
        'success', true,
        'duplicate', false,
        'user_id', p_user_id,
        'applied_amount', v_applied,
        'new_balance', v_new_balance,
        'trade_id', v_trade_id
    );

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.record_trade_safe IS
    'Shared, atomic realized-trade P&L recorder with idempotency + row locking. Mirrors credit_payment_safe security guarantees for signed (profit/loss) amounts. live_balance is clamped at 0 on losses.';
