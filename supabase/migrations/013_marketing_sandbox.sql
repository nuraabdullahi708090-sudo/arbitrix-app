-- ============================================
-- Marketing Sandbox Migration (MARKETING_SANDBOX)
-- ============================================
--
-- GOAL: a dedicated MARKETING SANDBOX / MARKETING DEMO environment for
-- marketing, screenshots, product demos, UGC videos, tutorials, landing-page
-- demos and internal training. It must be able to LOOK like the real Arbitrix
-- customer experience while being INCAPABLE of moving real money.
--
-- NON-NEGOTIABLE SAFETY MODEL (enforced at DB + server level, not frontend):
--   1. users.environment classifies every account: 'PRODUCTION' (default) or
--      'MARKETING_SANDBOX'. It is set ONCE at account creation and is
--      IMMUTABLE (a DB trigger rejects any UPDATE that changes it).
--   2. A MARKETING_SANDBOX account NEVER touches the production financial
--      tables (wallets, deposits, withdrawals, trades, transactions,
--      subscriptions, subscription_charges, payment_invoices). Backstop DB
--      triggers on those tables REJECT any write whose user_id belongs to a
--      MARKETING_SANDBOX account. These triggers are ADDITIVE: for
--      'PRODUCTION' users the environment check passes trivially and existing
--      behavior (and the existing SECURITY DEFINER credit functions
--      credit_payment_safe / record_trade_safe / charge_subscription_safe,
--      which are NOT modified) is byte-for-byte unchanged.
--   3. All sandbox state lives in DEDICATED sandbox_* tables (separate from
--      the production tables), each carrying the immutable classification
--      is_simulated = true (CHECK-constrained, cannot be flipped to false).
--      Production aggregates (admin stats, executive dashboard, withdrawal
--      queues, deposit lists, reports) read ONLY the production tables, so
--      simulated records can NEVER contaminate production accounting.
--   4. Every sandbox RPC (SECURITY DEFINER, same idempotency + FOR UPDATE
--      pattern as the production functions) FIRST asserts
--      users.environment = 'MARKETING_SANDBOX' and refuses otherwise.
--      This gives symmetric isolation: sandbox accounts cannot reach
--      production state and production accounts cannot be routed into the
--      sandbox functions.
--
-- RLS is intentionally DISABLED on the sandbox_* tables, matching the existing
-- payment/trades/subscription tables (BIGINT user_id, authorization enforced
-- in application code: authMiddleware + adminMiddleware + server-side
-- environment checks). New tables default to RLS disabled, so the CREATE
-- TABLE statements below already establish the intended (RLS-off) model.
--
-- This migration is IDEMPOTENT and ADDITIVE. It does NOT alter any existing
-- table data, function body, or behavior for PRODUCTION accounts.
-- ============================================

-- ============================================
-- 1. ACCOUNT CLASSIFICATION: users.environment
-- ============================================
ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'PRODUCTION';

ALTER TABLE public.users
    DROP CONSTRAINT IF EXISTS users_environment_check;
ALTER TABLE public.users
    ADD CONSTRAINT users_environment_check
    CHECK (environment IN ('PRODUCTION', 'MARKETING_SANDBOX'));

CREATE INDEX IF NOT EXISTS idx_users_environment ON public.users(environment);

COMMENT ON COLUMN public.users.environment IS
    'Account environment classification. PRODUCTION = normal customer/admin account (default). MARKETING_SANDBOX = marketing demo account; may NEVER write to production financial tables (backstop triggers + app-level guards enforce this). Set once at creation; immutable (see trg_users_environment_immutable).';

-- Immutability: environment can never be changed after creation. There is NO
-- API path to update it; this trigger is the hard DB-level guarantee that a
-- sandbox account can never be converted into a production account (and a
-- production account can never be re-classified as sandbox).
CREATE OR REPLACE FUNCTION public.users_environment_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.environment IS DISTINCT FROM OLD.environment THEN
        RAISE EXCEPTION 'users.environment is immutable (cannot change % -> % for user %)',
            OLD.environment, NEW.environment, OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_environment_immutable ON public.users;
CREATE TRIGGER trg_users_environment_immutable
    BEFORE UPDATE ON public.users
    FOR EACH ROW
    EXECUTE FUNCTION public.users_environment_immutable();

-- ============================================
-- 2. BACKSTOP: production financial tables reject sandbox accounts
-- ============================================
-- Shared guard function. Raises if the row's user belongs to a
-- MARKETING_SANDBOX account. No-ops (returns NEW) for PRODUCTION users, so
-- production flows are unaffected.
CREATE OR REPLACE FUNCTION public.assert_user_not_marketing_sandbox()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_env TEXT;
BEGIN
    SELECT environment INTO v_env FROM public.users WHERE id = NEW.user_id;
    IF v_env = 'MARKETING_SANDBOX' THEN
        RAISE EXCEPTION 'MARKETING_SANDBOX account % cannot write to production table %', NEW.user_id, TG_TABLE_NAME;
    END IF;
    RETURN NEW;
END;
$$;

-- wallets: block INSERT of a production wallet for a sandbox account, and
-- block UPDATEs that change live_balance OR pivot user_id for a sandbox
-- account. (demo/bonus-only updates for production users skip the env lookup
-- for efficiency; a user_id pivot or live_balance change always checks.)
CREATE OR REPLACE FUNCTION public.assert_wallet_not_marketing_sandbox()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_env TEXT;
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND NEW.live_balance IS NOT DISTINCT FROM OLD.live_balance THEN
        RETURN NEW; -- nothing financial/ownership-changing to guard
    END IF;
    SELECT environment INTO v_env FROM public.users WHERE id = NEW.user_id;
    IF v_env = 'MARKETING_SANDBOX' THEN
        RAISE EXCEPTION 'MARKETING_SANDBOX account % cannot hold/modify a production wallet', NEW.user_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wallets_no_sandbox ON public.wallets;
CREATE TRIGGER trg_wallets_no_sandbox
    BEFORE INSERT OR UPDATE ON public.wallets
    FOR EACH ROW
    EXECUTE FUNCTION public.assert_wallet_not_marketing_sandbox();

DROP TRIGGER IF EXISTS trg_trades_no_sandbox ON public.trades;
CREATE TRIGGER trg_trades_no_sandbox
    BEFORE INSERT OR UPDATE ON public.trades
    FOR EACH ROW
    EXECUTE FUNCTION public.assert_user_not_marketing_sandbox();

DROP TRIGGER IF EXISTS trg_deposits_no_sandbox ON public.deposits;
CREATE TRIGGER trg_deposits_no_sandbox
    BEFORE INSERT OR UPDATE ON public.deposits
    FOR EACH ROW
    EXECUTE FUNCTION public.assert_user_not_marketing_sandbox();

DROP TRIGGER IF EXISTS trg_withdrawals_no_sandbox ON public.withdrawals;
CREATE TRIGGER trg_withdrawals_no_sandbox
    BEFORE INSERT OR UPDATE ON public.withdrawals
    FOR EACH ROW
    EXECUTE FUNCTION public.assert_user_not_marketing_sandbox();

DROP TRIGGER IF EXISTS trg_subscriptions_no_sandbox ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_no_sandbox
    BEFORE INSERT OR UPDATE ON public.subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION public.assert_user_not_marketing_sandbox();

DROP TRIGGER IF EXISTS trg_sub_charges_no_sandbox ON public.subscription_charges;
CREATE TRIGGER trg_sub_charges_no_sandbox
    BEFORE INSERT OR UPDATE ON public.subscription_charges
    FOR EACH ROW
    EXECUTE FUNCTION public.assert_user_not_marketing_sandbox();

DROP TRIGGER IF EXISTS trg_payment_invoices_no_sandbox ON public.payment_invoices;
CREATE TRIGGER trg_payment_invoices_no_sandbox
    BEFORE INSERT OR UPDATE ON public.payment_invoices
    FOR EACH ROW
    EXECUTE FUNCTION public.assert_user_not_marketing_sandbox();

DROP TRIGGER IF EXISTS trg_transactions_no_sandbox ON public.transactions;
CREATE TRIGGER trg_transactions_no_sandbox
    BEFORE INSERT OR UPDATE ON public.transactions
    FOR EACH ROW
    EXECUTE FUNCTION public.assert_user_not_marketing_sandbox();

-- Referrals use (referrer_id, referred_id) instead of a single user_id, so they
-- need their own guard: a MARKETING_SANDBOX account may never appear on either
-- side of a production referral row (e.g. via /api/referral/simulate).
CREATE OR REPLACE FUNCTION public.assert_referral_not_marketing_sandbox()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_referrer_env TEXT;
    v_referred_env TEXT;
BEGIN
    SELECT environment INTO v_referrer_env FROM public.users WHERE id = NEW.referrer_id;
    IF v_referrer_env = 'MARKETING_SANDBOX' THEN
        RAISE EXCEPTION 'MARKETING_SANDBOX accounts cannot create production referral records';
    END IF;
    SELECT environment INTO v_referred_env FROM public.users WHERE id = NEW.referred_id;
    IF v_referred_env = 'MARKETING_SANDBOX' THEN
        RAISE EXCEPTION 'MARKETING_SANDBOX accounts cannot create production referral records';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_referrals_no_sandbox ON public.referrals;
CREATE TRIGGER trg_referrals_no_sandbox
    BEFORE INSERT OR UPDATE ON public.referrals
    FOR EACH ROW
    EXECUTE FUNCTION public.assert_referral_not_marketing_sandbox();

-- ============================================
-- 3. SANDBOX TABLES (dedicated, all records is_simulated = true)
-- ============================================

-- One row per MARKETING_SANDBOX account. `balance` is the simulated available
-- balance (zero monetary value, never transferable to production).
-- `intro_day` (1..15) drives the simulated 14-day introductory Live period.
-- `badge_hidden` lets the marketing operator hide the visible demo badge for
-- clean recordings; the BACKEND classification can never be hidden/removed.
CREATE TABLE IF NOT EXISTS public.sandbox_wallets (
    user_id BIGINT PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    balance DECIMAL(18, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    intro_day INT NOT NULL DEFAULT 1 CHECK (intro_day BETWEEN 1 AND 15),
    badge_hidden BOOLEAN NOT NULL DEFAULT false,
    environment TEXT NOT NULL DEFAULT 'MARKETING_SANDBOX' CHECK (environment = 'MARKETING_SANDBOX'),
    is_simulated BOOLEAN NOT NULL DEFAULT true CHECK (is_simulated),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sandbox_deposits (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    amount DECIMAL(18, 2) NOT NULL CHECK (amount > 0),
    network TEXT NOT NULL DEFAULT 'TRC20',
    address TEXT,
    invoice_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'expired', 'cancelled')),
    is_simulated BOOLEAN NOT NULL DEFAULT true CHECK (is_simulated),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sandbox_deposits_user ON public.sandbox_deposits(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.sandbox_withdrawals (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    amount DECIMAL(18, 2) NOT NULL CHECK (amount > 0),
    address TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
    is_simulated BOOLEAN NOT NULL DEFAULT true CHECK (is_simulated),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sandbox_withdrawals_user ON public.sandbox_withdrawals(user_id, created_at DESC);

-- Simulated trade ledger (mirrors public.trades shape).
CREATE TABLE IF NOT EXISTS public.sandbox_trades (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    asset TEXT,
    detail TEXT,
    amount DECIMAL(18, 2) NOT NULL,
    balance_after DECIMAL(18, 2) NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    is_simulated BOOLEAN NOT NULL DEFAULT true CHECK (is_simulated),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sandbox_trades_user ON public.sandbox_trades(user_id, created_at DESC);

-- Simulated user-visible transaction log (mirrors public.transactions shape).
CREATE TABLE IF NOT EXISTS public.sandbox_transactions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    amount DECIMAL(18, 2) NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    is_simulated BOOLEAN NOT NULL DEFAULT true CHECK (is_simulated),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sandbox_transactions_user ON public.sandbox_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.sandbox_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL DEFAULT 'pro',
    price DECIMAL(18, 2) NOT NULL DEFAULT 7 CHECK (price >= 0),
    status TEXT NOT NULL DEFAULT 'inactive'
        CHECK (status IN ('active', 'payment_due', 'inactive', 'cancelled')),
    started_at TIMESTAMPTZ,
    next_billing_date TIMESTAMPTZ,
    last_billing_date TIMESTAMPTZ,
    last_charge_amount DECIMAL(18, 2),
    is_simulated BOOLEAN NOT NULL DEFAULT true CHECK (is_simulated),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sandbox_bot_sessions (
    user_id BIGINT PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    is_running INT NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'live',
    started_at TIMESTAMPTZ,
    is_simulated BOOLEAN NOT NULL DEFAULT true CHECK (is_simulated)
);

-- Simulated subscription-charges ledger (mirrors public.subscription_charges).
CREATE TABLE IF NOT EXISTS public.sandbox_subscription_charges (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'pro',
    price DECIMAL(18, 2) NOT NULL,
    balance_after DECIMAL(18, 2) NOT NULL,
    is_simulated BOOLEAN NOT NULL DEFAULT true CHECK (is_simulated),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sandbox_sub_charges_user ON public.sandbox_subscription_charges(user_id, created_at DESC);

-- ============================================
-- 4. SANDBOX GUARD + RPCs (SECURITY DEFINER, env-asserted)
-- ============================================

-- Shared assertion: the given user MUST be a MARKETING_SANDBOX account.
CREATE OR REPLACE FUNCTION public.assert_sandbox_user(p_user_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_env TEXT;
BEGIN
    SELECT environment INTO v_env FROM public.users WHERE id = p_user_id;
    IF v_env IS DISTINCT FROM 'MARKETING_SANDBOX' THEN
        RAISE EXCEPTION 'User % is not a MARKETING_SANDBOX account', p_user_id;
    END IF;
END;
$$;

-- Ensure a sandbox wallet row exists (idempotent).
CREATE OR REPLACE FUNCTION public.sandbox_ensure_wallet(p_user_id BIGINT)
RETURNS public.sandbox_wallets
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_wallet public.sandbox_wallets%ROWTYPE;
BEGIN
    PERFORM public.assert_sandbox_user(p_user_id);
    SELECT * INTO v_wallet FROM public.sandbox_wallets WHERE user_id = p_user_id;
    IF v_wallet IS NULL THEN
        INSERT INTO public.sandbox_wallets (user_id) VALUES (p_user_id)
        RETURNING * INTO v_wallet;
    END IF;
    RETURN v_wallet;
END;
$$;

-- Set the simulated balance (presets/custom). Simulated funds have zero
-- monetary value and can never leave the sandbox tables.
CREATE OR REPLACE FUNCTION public.sandbox_set_balance(p_user_id BIGINT, p_amount DECIMAL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_wallet public.sandbox_wallets%ROWTYPE;
    v_amount DECIMAL;
BEGIN
    PERFORM public.assert_sandbox_user(p_user_id);
    IF p_amount IS NULL OR p_amount < 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'amount must be >= 0');
    END IF;
    v_amount := ROUND(p_amount::numeric, 2);
    v_wallet := public.sandbox_ensure_wallet(p_user_id);
    UPDATE public.sandbox_wallets
    SET balance = v_amount, updated_at = NOW()
    WHERE user_id = p_user_id;
    RETURN jsonb_build_object('success', true, 'balance', v_amount);
END;
$$;

-- Atomic simulated deposit credit. Mirrors credit_payment_safe's guarantees
-- (idempotency via deposit status, FOR UPDATE row lock) but ONLY touches
-- sandbox tables.
CREATE OR REPLACE FUNCTION public.sandbox_credit_deposit(p_user_id BIGINT, p_invoice_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_wallet public.sandbox_wallets%ROWTYPE;
    v_deposit public.sandbox_deposits%ROWTYPE;
    v_new_balance DECIMAL;
BEGIN
    PERFORM public.assert_sandbox_user(p_user_id);

    SELECT * INTO v_deposit FROM public.sandbox_deposits
    WHERE invoice_id = p_invoice_id AND user_id = p_user_id
    FOR UPDATE;
    IF v_deposit IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
    END IF;
    IF v_deposit.status = 'confirmed' THEN
        SELECT balance INTO v_new_balance FROM public.sandbox_wallets WHERE user_id = p_user_id;
        RETURN jsonb_build_object('success', true, 'duplicate', true,
            'new_balance', v_new_balance, 'credited_amount', 0, 'status', 'confirmed');
    END IF;
    IF v_deposit.status <> 'pending' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Deposit is not pending', 'status', v_deposit.status);
    END IF;

    v_wallet := public.sandbox_ensure_wallet(p_user_id);
    SELECT * INTO v_wallet FROM public.sandbox_wallets WHERE user_id = p_user_id FOR UPDATE;
    v_new_balance := v_wallet.balance + v_deposit.amount;

    UPDATE public.sandbox_wallets
    SET balance = v_new_balance, updated_at = NOW()
    WHERE user_id = p_user_id;

    UPDATE public.sandbox_deposits SET status = 'confirmed' WHERE id = v_deposit.id;

    INSERT INTO public.sandbox_transactions (user_id, type, amount, detail)
    VALUES (p_user_id, 'Deposit', v_deposit.amount,
            'SIMULATED MARKETING DEPOSIT - USDT (' || COALESCE(v_deposit.network, 'TRC20') || ')');

    RETURN jsonb_build_object('success', true, 'duplicate', false,
        'new_balance', v_new_balance, 'credited_amount', v_deposit.amount, 'status', 'confirmed');

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Atomic simulated trade recording. Mirrors record_trade_safe exactly
-- (idempotency -> FOR UPDATE lock -> double-check -> clamp at 0 -> ledger +
-- user transaction), but ONLY on sandbox tables.
CREATE OR REPLACE FUNCTION public.sandbox_record_trade(
    p_user_id BIGINT,
    p_amount DECIMAL,
    p_idempotency_key TEXT,
    p_asset TEXT DEFAULT NULL,
    p_detail TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_wallet public.sandbox_wallets%ROWTYPE;
    v_existing_key TEXT;
    v_applied DECIMAL;
    v_new_balance DECIMAL;
    v_amount_usd DECIMAL;
    v_trade_id BIGINT;
BEGIN
    PERFORM public.assert_sandbox_user(p_user_id);
    IF p_amount IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'amount is required');
    END IF;
    IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'idempotency_key is required');
    END IF;

    SELECT idempotency_key INTO v_existing_key
    FROM public.sandbox_trades WHERE idempotency_key = p_idempotency_key;
    IF v_existing_key IS NOT NULL THEN
        SELECT balance_after, amount INTO v_new_balance, v_amount_usd
        FROM public.sandbox_trades WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object('success', true, 'duplicate', true,
            'idempotency_key', p_idempotency_key,
            'new_balance', v_new_balance, 'applied_amount', v_amount_usd);
    END IF;

    v_wallet := public.sandbox_ensure_wallet(p_user_id);
    SELECT * INTO v_wallet FROM public.sandbox_wallets WHERE user_id = p_user_id FOR UPDATE;

    SELECT idempotency_key INTO v_existing_key
    FROM public.sandbox_trades WHERE idempotency_key = p_idempotency_key;
    IF v_existing_key IS NOT NULL THEN
        SELECT balance_after, amount INTO v_new_balance, v_amount_usd
        FROM public.sandbox_trades WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object('success', true, 'duplicate', true,
            'idempotency_key', p_idempotency_key,
            'new_balance', v_new_balance, 'applied_amount', v_amount_usd);
    END IF;

    v_applied := p_amount;
    IF p_amount < 0 AND (v_wallet.balance + p_amount) < 0 THEN
        v_applied := -v_wallet.balance;
    END IF;
    v_new_balance := GREATEST(0, v_wallet.balance + v_applied);

    UPDATE public.sandbox_wallets
    SET balance = v_new_balance, updated_at = NOW()
    WHERE user_id = p_user_id;

    INSERT INTO public.sandbox_trades (user_id, asset, detail, amount, balance_after, idempotency_key)
    VALUES (p_user_id, p_asset, p_detail, v_applied, v_new_balance, p_idempotency_key)
    RETURNING id INTO v_trade_id;

    INSERT INTO public.sandbox_transactions (user_id, type, amount, detail)
    VALUES (p_user_id, 'Trade Executed', v_applied,
        COALESCE(NULLIF(p_asset, ''), 'Trade') ||
        CASE WHEN p_detail IS NOT NULL AND btrim(p_detail) <> '' THEN ' - ' || p_detail ELSE '' END);

    RETURN jsonb_build_object('success', true, 'duplicate', false,
        'applied_amount', v_applied, 'new_balance', v_new_balance, 'trade_id', v_trade_id);

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Atomic simulated subscription charge. Mirrors charge_subscription_safe
-- (idempotency_key UNIQUE per period, FOR UPDATE locks, sufficient-balance
-- gate -> payment_due with $0 charged, atomic debit + ledger + transaction),
-- but ONLY on sandbox tables. The transaction detail is explicitly marked
-- SIMULATED so internal records can never be mistaken for a real charge.
CREATE OR REPLACE FUNCTION public.sandbox_charge_subscription(
    p_user_id BIGINT,
    p_price DECIMAL,
    p_idempotency_key TEXT,
    p_period_label TEXT DEFAULT NULL,
    p_billing_kind TEXT DEFAULT 'monthly'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_wallet public.sandbox_wallets%ROWTYPE;
    v_existing TEXT;
    v_sub public.sandbox_subscriptions%ROWTYPE;
    v_new_balance DECIMAL;
    v_price DECIMAL;
    v_detail TEXT;
BEGIN
    PERFORM public.assert_sandbox_user(p_user_id);
    IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'idempotency_key is required');
    END IF;
    v_price := ROUND(COALESCE(p_price, 0)::numeric, 2);
    IF v_price < 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'price must be >= 0');
    END IF;

    v_detail := 'SIMULATED MARKETING SUBSCRIPTION - Arbitrix Platform Subscription - $' || trim(to_char(v_price, 'FM999999990.00'))
        || CASE WHEN p_period_label IS NOT NULL AND btrim(p_period_label) <> '' THEN ' - ' || p_period_label ELSE '' END;

    -- Idempotency check #1 (before lock): same billing-period key already charged?
    SELECT idempotency_key INTO v_existing
    FROM public.sandbox_subscription_charges
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
        SELECT balance INTO v_new_balance FROM public.sandbox_wallets WHERE user_id = p_user_id;
        RETURN jsonb_build_object('success', true, 'duplicate', true,
            'new_balance', v_new_balance, 'price', v_price, 'status',
            (SELECT status FROM public.sandbox_subscriptions WHERE user_id = p_user_id));
    END IF;

    v_wallet := public.sandbox_ensure_wallet(p_user_id);
    SELECT * INTO v_wallet FROM public.sandbox_wallets WHERE user_id = p_user_id FOR UPDATE;

    SELECT * INTO v_sub FROM public.sandbox_subscriptions WHERE user_id = p_user_id FOR UPDATE;
    IF v_sub IS NULL THEN
        INSERT INTO public.sandbox_subscriptions (user_id, price, status)
        VALUES (p_user_id, v_price, 'inactive')
        RETURNING * INTO v_sub;
    END IF;

    -- Idempotency check #2 (AFTER lock): race-condition protection.
    SELECT idempotency_key INTO v_existing
    FROM public.sandbox_subscription_charges
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
        RETURN jsonb_build_object('success', true, 'duplicate', true,
            'new_balance', v_wallet.balance, 'price', v_price, 'status', v_sub.status);
    END IF;

    IF v_wallet.balance < v_price THEN
        UPDATE public.sandbox_subscriptions
        SET status = 'payment_due', updated_at = NOW()
        WHERE user_id = p_user_id;
        RETURN jsonb_build_object('success', false, 'reason', 'insufficient_balance',
            'status', 'payment_due', 'available_balance', v_wallet.balance, 'price', v_price);
    END IF;

    v_new_balance := v_wallet.balance - v_price;
    UPDATE public.sandbox_wallets
    SET balance = v_new_balance, updated_at = NOW()
    WHERE user_id = p_user_id;

    INSERT INTO public.sandbox_subscription_charges (user_id, idempotency_key, plan, price, balance_after)
    VALUES (p_user_id, p_idempotency_key, 'pro', v_price, v_new_balance);

    INSERT INTO public.sandbox_transactions (user_id, type, amount, detail)
    VALUES (p_user_id, 'Subscription', -v_price, v_detail);

    UPDATE public.sandbox_subscriptions
    SET status = 'active',
        last_billing_date = NOW(),
        last_charge_amount = v_price,
        next_billing_date = NOW() + INTERVAL '1 month',
        started_at = COALESCE(started_at, NOW()),
        updated_at = NOW()
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object('success', true, 'duplicate', false,
        'price', v_price, 'new_balance', v_new_balance, 'status', 'active',
        'next_billing_date', NOW() + INTERVAL '1 month');

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Simulated withdrawal request: debits the sandbox balance immediately (mirrors
-- the production debit-at-request behavior) and records a pending simulated
-- withdrawal. NO KYC requirement (sandbox-only rule), NO real funds move.
CREATE OR REPLACE FUNCTION public.sandbox_request_withdrawal(
    p_user_id BIGINT,
    p_amount DECIMAL,
    p_address TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_wallet public.sandbox_wallets%ROWTYPE;
    v_amount DECIMAL;
    v_new_balance DECIMAL;
    v_id BIGINT;
BEGIN
    PERFORM public.assert_sandbox_user(p_user_id);
    v_amount := ROUND(COALESCE(p_amount, 0)::numeric, 2);
    IF v_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than 0');
    END IF;
    IF p_address IS NULL OR length(btrim(p_address)) < 4 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Valid address required');
    END IF;

    v_wallet := public.sandbox_ensure_wallet(p_user_id);
    SELECT * INTO v_wallet FROM public.sandbox_wallets WHERE user_id = p_user_id FOR UPDATE;
    IF v_wallet.balance < v_amount THEN
        RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance');
    END IF;

    v_new_balance := v_wallet.balance - v_amount;
    UPDATE public.sandbox_wallets
    SET balance = v_new_balance, updated_at = NOW()
    WHERE user_id = p_user_id;

    INSERT INTO public.sandbox_withdrawals (user_id, amount, address, status)
    VALUES (p_user_id, v_amount, btrim(p_address), 'pending')
    RETURNING id INTO v_id;

    INSERT INTO public.sandbox_transactions (user_id, type, amount, detail)
    VALUES (p_user_id, 'Withdraw', -v_amount,
        'SIMULATED MARKETING WITHDRAWAL - To ' || left(btrim(p_address), 6) || '...');

    RETURN jsonb_build_object('success', true, 'id', v_id, 'amount', v_amount,
        'status', 'pending', 'new_balance', v_new_balance);

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Marketing control: set a simulated withdrawal's status
-- (pending/processing/completed/rejected; rejected refunds the debit once).
CREATE OR REPLACE FUNCTION public.sandbox_set_withdrawal_status(
    p_user_id BIGINT,
    p_withdrawal_id BIGINT,
    p_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_withdrawal public.sandbox_withdrawals%ROWTYPE;
BEGIN
    PERFORM public.assert_sandbox_user(p_user_id);
    IF p_status NOT IN ('pending', 'processing', 'completed', 'rejected') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid status');
    END IF;

    -- Lock the withdrawal row so a double-reject (or reject-after-refund) can
    -- never refund twice.
    SELECT * INTO v_withdrawal FROM public.sandbox_withdrawals
    WHERE id = p_withdrawal_id AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Withdrawal not found');
    END IF;

    -- 'rejected' is TERMINAL: a refunded withdrawal can never flow back into
    -- pending/processing/completed (which would show a completed withdrawal
    -- alongside its refund).
    IF v_withdrawal.status = 'rejected' AND p_status <> 'rejected' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Rejected withdrawals are final');
    END IF;

    -- Rejection refunds the debit-at-request amount exactly once, mirroring the
    -- production admin reject flow (live_balance refund + 'Withdraw Rejected'
    -- transaction). A completed withdrawal is final and cannot be rejected;
    -- an already-rejected one is never refunded a second time.
    IF p_status = 'rejected' THEN
        IF v_withdrawal.status = 'completed' THEN
            RETURN jsonb_build_object('success', false, 'error', 'Cannot reject a completed withdrawal');
        END IF;
        IF v_withdrawal.status <> 'rejected' THEN
            UPDATE public.sandbox_wallets
            SET balance = balance + v_withdrawal.amount, updated_at = NOW()
            WHERE user_id = p_user_id;
            INSERT INTO public.sandbox_transactions (user_id, type, amount, detail)
            VALUES (p_user_id, 'Withdraw Rejected', v_withdrawal.amount,
                'SIMULATED MARKETING WITHDRAWAL REJECTED - refund');
        END IF;
    END IF;

    UPDATE public.sandbox_withdrawals
    SET status = p_status
    WHERE id = p_withdrawal_id AND user_id = p_user_id;

    RETURN jsonb_build_object('success', true, 'status', p_status);
END;
$$;

-- One-click reset: returns the sandbox account to a clean state. Deletes ALL
-- simulated rows and resets balance=0, intro_day=1, badge shown, bot stopped.
-- Touches ONLY sandbox tables for this user.
CREATE OR REPLACE FUNCTION public.sandbox_reset_account(p_user_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    PERFORM public.assert_sandbox_user(p_user_id);

    DELETE FROM public.sandbox_deposits WHERE user_id = p_user_id;
    DELETE FROM public.sandbox_withdrawals WHERE user_id = p_user_id;
    DELETE FROM public.sandbox_trades WHERE user_id = p_user_id;
    DELETE FROM public.sandbox_transactions WHERE user_id = p_user_id;
    DELETE FROM public.sandbox_subscriptions WHERE user_id = p_user_id;
    DELETE FROM public.sandbox_subscription_charges WHERE user_id = p_user_id;
    DELETE FROM public.sandbox_bot_sessions WHERE user_id = p_user_id;

    INSERT INTO public.sandbox_wallets (user_id, balance, intro_day, badge_hidden)
    VALUES (p_user_id, 0, 1, false)
    ON CONFLICT (user_id) DO UPDATE
    SET balance = 0, intro_day = 1, badge_hidden = false, updated_at = NOW();

    RETURN jsonb_build_object('success', true, 'balance', 0, 'intro_day', 1);
END;
$$;

COMMENT ON TABLE public.sandbox_wallets IS
    'MARKETING_SANDBOX simulated wallet. balance has ZERO monetary value and can never move to production (app-level guards + production-table backstop triggers). intro_day (1..15) simulates the 14-day introductory Live period.';
COMMENT ON TABLE public.sandbox_trades IS
    'Simulated trade ledger for MARKETING_SANDBOX accounts. Records are demonstration data only (is_simulated=true); never production trading results.';
COMMENT ON TABLE public.sandbox_transactions IS
    'Simulated user-visible transaction log for MARKETING_SANDBOX accounts (is_simulated=true; details prefixed SIMULATED MARKETING ...).';
COMMENT ON FUNCTION public.sandbox_record_trade IS
    'Simulated atomic trade recorder for MARKETING_SANDBOX accounts. Mirrors record_trade_safe guarantees but writes ONLY sandbox_* tables and asserts users.environment = MARKETING_SANDBOX.';
COMMENT ON FUNCTION public.sandbox_charge_subscription IS
    'Simulated atomic subscription charge for MARKETING_SANDBOX accounts. Mirrors charge_subscription_safe guarantees but debits ONLY sandbox_wallets.balance; never the production wallet.';
COMMENT ON FUNCTION public.assert_referral_not_marketing_sandbox IS
    'Backstop guard for public.referrals: rejects any INSERT involving a MARKETING_SANDBOX account on either side.';

-- Migration runtime self-check: abort if any guard is missing.
DO $$
DECLARE
    v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_users_environment_immutable') THEN
        v_missing := v_missing || 'trg_users_environment_immutable';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_wallets_no_sandbox') THEN
        v_missing := v_missing || 'trg_wallets_no_sandbox';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_trades_no_sandbox') THEN
        v_missing := v_missing || 'trg_trades_no_sandbox';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_deposits_no_sandbox') THEN
        v_missing := v_missing || 'trg_deposits_no_sandbox';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_withdrawals_no_sandbox') THEN
        v_missing := v_missing || 'trg_withdrawals_no_sandbox';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_subscriptions_no_sandbox') THEN
        v_missing := v_missing || 'trg_subscriptions_no_sandbox';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sub_charges_no_sandbox') THEN
        v_missing := v_missing || 'trg_sub_charges_no_sandbox';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_payment_invoices_no_sandbox') THEN
        v_missing := v_missing || 'trg_payment_invoices_no_sandbox';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_transactions_no_sandbox') THEN
        v_missing := v_missing || 'trg_transactions_no_sandbox';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_referrals_no_sandbox') THEN
        v_missing := v_missing || 'trg_referrals_no_sandbox';
    END IF;
    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'Migration 013 self-check failed, missing triggers: %', v_missing;
    END IF;
END $$;
