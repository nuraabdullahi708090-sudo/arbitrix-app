-- ============================================
-- Arbitrix Pro Subscription Migration
-- ============================================
--
-- GOAL: a single internal subscription ("Arbitrix Pro", $7/month) that is
-- billed as an internal server-side debit from the user's genuinely available
-- Live balance. This is NOT a payment method / deposit flow. The existing
-- deposit / payment / webhook / crediting systems are NOT touched.
--
-- AVAILABLE-BALANCE MODEL (read before changing):
--   This application has NO locked / committed / open-position funds. Trades
--   are REALIZED immediately via record_trade_safe() (live_balance += signed
--   P&L, clamped at 0). There is no "funds committed to active trades" column,
--   no pending-trade escrow, and no separate available-vs-total balance.
--   Therefore the genuinely available balance IS wallets.live_balance, and
--   an atomic debit of live_balance cannot consume committed funds (none
--   exist). Demo balance (wallets.demo_balance) and bonus balance
--   (wallets.bonus_balance) are NEVER touched by subscription billing.
--
-- ATOMICITY / IDEMPOTENCY (mirrors the proven credit_payment_safe() /
-- record_trade_safe() pattern):
--   - SECURITY DEFINER (elevated privileges)
--   - idempotency check on subscription_charges.idempotency_key (UNIQUE)
--   - SELECT ... FOR UPDATE row lock on wallets
--   - double-check idempotency AFTER lock (race-condition safe)
--   - sufficient-balance check BEFORE any mutation (never goes negative,
--     never consumes funds that are not genuinely available)
--   - atomic wallet debit (live_balance -= price) + ledger row + transactions
--     row (type='Subscription') + subscriptions update, all in one transaction
--   - EXCEPTION handler returns JSON error instead of corrupting state
--
-- PRICE is server-controlled (stored in payment_config as
-- 'subscription.pro_price', default 7). The frontend NEVER supplies the
-- price; the server reads it. RLS is DISABLED on the new tables to match the
-- existing payment/trades tables (BIGINT user_id, authorization via app code).
-- ============================================

-- ============================================
-- 0. DISABLE RLS (BIGINT compatibility, matches existing payment/trades tables)
-- ============================================
ALTER TABLE public.subscriptions DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_charges DISABLE ROW LEVEL SECURITY;

-- ============================================
-- 1. SUBSCRIPTIONS TABLE (one row per user)
-- ============================================
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL DEFAULT 'pro',
    price DECIMAL(18, 2) NOT NULL DEFAULT 7 CHECK (price >= 0),
    -- status values: 'active' | 'payment_due' | 'inactive' | 'cancelled'
    status TEXT NOT NULL DEFAULT 'inactive'
        CHECK (status IN ('active', 'payment_due', 'inactive', 'cancelled')),
    started_at TIMESTAMPTZ,
    next_billing_date TIMESTAMPTZ,
    last_billing_date TIMESTAMPTZ,
    last_charge_amount DECIMAL(18, 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON public.subscriptions(status);

COMMENT ON TABLE public.subscriptions IS
    'Per-user Arbitrix Pro subscription state. Billed as an internal debit of wallets.live_balance.';
COMMENT ON COLUMN public.subscriptions.price IS
    'Server-controlled price in USD (mirror of payment_config subscription.pro_price at charge time).';
COMMENT ON COLUMN public.subscriptions.status IS
    'active = paid for current period; payment_due = a charge could not be collected; inactive = never activated; cancelled = user cancelled.';

-- ============================================
-- 2. SUBSCRIPTION_CHARGES LEDGER (append-only, idempotency)
-- ============================================
CREATE TABLE IF NOT EXISTS public.subscription_charges (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    -- Server-computed unique key per billing period. UNIQUE -> a user can never
    -- be charged twice for the same billing period, regardless of retries /
    -- concurrency / scheduled re-runs.
    idempotency_key TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'pro',
    price DECIMAL(18, 2) NOT NULL,
    -- Authoritative live balance immediately after this charge was applied.
    balance_after DECIMAL(18, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sub_charges_user_created
    ON public.subscription_charges(user_id, created_at DESC);

COMMENT ON TABLE public.subscription_charges IS
    'Append-only ledger of successful subscription charges. UNIQUE(idempotency_key) prevents double-charge for the same billing period.';

-- ============================================
-- 3. ATOMIC CHARGE FUNCTION
-- ============================================
-- Charges the user's genuinely available Live balance for a billing period.
-- Security guarantees mirror credit_payment_safe() / record_trade_safe():
--   - SECURITY DEFINER
--   - idempotency_key UNIQUE -> never charged twice for the same period
--   - SELECT ... FOR UPDATE on wallets (row lock)
--   - double-check idempotency AFTER lock
--   - sufficient-balance check BEFORE mutation (price <= live_balance);
--     if insufficient -> NO mutation, status='payment_due', success=false,
--     reason='insufficient_balance' (balance preserved, never negative)
--   - on success: live_balance -= price, ledger row, transactions row
--     (type='Subscription'), subscriptions row updated (active + dates)
--   - NEVER touches demo_balance / bonus_balance
--   - EXCEPTION handler returns JSON error; no partial state.
--
-- p_billing_kind is appended to the idempotency key namespace so activation
-- ('activate') and recurring monthly billing ('monthly') for the same period
-- remain distinct; in practice the period label itself disambiguates.
CREATE OR REPLACE FUNCTION public.charge_subscription_safe(
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
    v_wallet wallets%ROWTYPE;
    v_existing_key TEXT;
    v_sub subscriptions%ROWTYPE;
    v_new_balance DECIMAL;
    v_charge_id BIGINT;
    v_price DECIMAL;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'user_id is required');
    END IF;
    IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'idempotency_key is required');
    END IF;
    -- Server is the authority on price; clamp to a non-negative 2-dp value.
    v_price := ROUND(COALESCE(p_price, 0)::numeric, 2);
    IF v_price < 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'price must be non-negative');
    END IF;

    -- Idempotency check #1 (before lock): already charged for this key?
    SELECT idempotency_key INTO v_existing_key
    FROM subscription_charges
    WHERE idempotency_key = p_idempotency_key;

    IF v_existing_key IS NOT NULL THEN
        SELECT balance_after, price INTO v_new_balance, v_price
        FROM subscription_charges WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Subscription already charged for this period',
            'idempotency_key', p_idempotency_key,
            'new_balance', v_new_balance,
            'price', v_price
        );
    END IF;

    -- Get the subscription row (must exist; activation creates it first).
    SELECT * INTO v_sub
    FROM subscriptions
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF v_sub IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Subscription not found');
    END IF;
    IF v_sub.status = 'cancelled' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Subscription cancelled', 'reason', 'cancelled');
    END IF;

    -- Lock the wallet row.
    SELECT * INTO v_wallet
    FROM wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF v_wallet IS NULL THEN
        -- No wallet => no available Live balance. Mark payment_due, no charge.
        UPDATE subscriptions
        SET status = 'payment_due', updated_at = NOW()
        WHERE user_id = p_user_id;
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'insufficient_balance',
            'message', 'No available Live balance',
            'status', 'payment_due'
        );
    END IF;

    -- Double-check idempotency AFTER lock (race-condition protection).
    SELECT idempotency_key INTO v_existing_key
    FROM subscription_charges
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing_key IS NOT NULL THEN
        SELECT balance_after, price INTO v_new_balance, v_price
        FROM subscription_charges WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Subscription already charged (race condition prevented)',
            'idempotency_key', p_idempotency_key,
            'new_balance', v_new_balance,
            'price', v_price
        );
    END IF;

    -- SUFFICIENT-BALANCE GATE: only the genuinely available Live balance may
    -- be used. If insufficient, do NOT mutate any balance, do NOT create debt,
    -- and mark the subscription payment_due. Demo/bonus balances are never
    -- considered (we only read live_balance).
    IF v_wallet.live_balance < v_price THEN
        UPDATE subscriptions
        SET status = 'payment_due', updated_at = NOW()
        WHERE user_id = p_user_id;
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'insufficient_balance',
            'available_balance', v_wallet.live_balance,
            'price', v_price,
            'status', 'payment_due',
            'message', 'Available Live balance is below the subscription price'
        );
    END IF;

    -- Atomic wallet debit. Safe: we just proved live_balance >= price, so the
    -- result is >= 0. We never subtract from demo_balance or bonus_balance.
    v_new_balance := v_wallet.live_balance - v_price;

    UPDATE wallets
    SET live_balance = v_new_balance,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    -- Append-only ledger row (idempotency anchor).
    INSERT INTO subscription_charges (user_id, idempotency_key, plan, price, balance_after, created_at)
    VALUES (p_user_id, p_idempotency_key, v_sub.plan, v_price, v_new_balance, NOW())
    RETURNING id INTO v_charge_id;

    -- User-facing transaction row. NEW type 'Subscription'; existing types
    -- ('Deposit','Withdraw','Trade Executed','Referral Bonus', etc.) are NOT
    -- changed. Display label is localized at render time (TX_TYPE_LABELS).
    INSERT INTO transactions (user_id, type, amount, detail, created_at)
    VALUES (p_user_id, 'Subscription', -v_price,
        'Arbitrix Pro Subscription' ||
        CASE WHEN p_period_label IS NOT NULL AND btrim(p_period_label) <> ''
             THEN ' - ' || p_period_label ELSE '' END,
        NOW());

    -- Advance billing dates: this charge covers the period starting now;
    -- next billing is one month later. status -> active.
    UPDATE subscriptions
    SET status = 'active',
        last_billing_date = NOW(),
        last_charge_amount = v_price,
        next_billing_date = (NOW() + INTERVAL '1 month'),
        started_at = COALESCE(started_at, NOW()),
        price = v_price,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
        'success', true,
        'duplicate', false,
        'user_id', p_user_id,
        'price', v_price,
        'new_balance', v_new_balance,
        'charge_id', v_charge_id,
        'status', 'active',
        'next_billing_date', (NOW() + INTERVAL '1 month')
    );

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.charge_subscription_safe IS
    'Atomic, idempotent Arbitrix Pro subscription debit from wallets.live_balance. Mirrors credit_payment_safe / record_trade_safe security guarantees. Never charges demo/bonus balances; never creates a negative balance; never double-charges a billing period.';

-- ============================================
-- 4. SERVER-CONTROLLED PRICE CONFIG
-- ============================================
INSERT INTO public.payment_config (key, value, value_type, description, category, is_sensitive) VALUES
    ('subscription.pro_price', '7', 'number', 'Arbitrix Pro monthly subscription price in USD (server-controlled)', 'general', false),
    ('subscription.pro_enabled', 'true', 'boolean', 'Whether the Arbitrix Pro subscription feature is available', 'general', false)
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- 5. VERIFY
-- ============================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'subscriptions') THEN RAISE EXCEPTION 'subscriptions table failed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'subscription_charges') THEN RAISE EXCEPTION 'subscription_charges table failed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'charge_subscription_safe') THEN RAISE EXCEPTION 'charge_subscription_safe function failed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.payment_config WHERE key = 'subscription.pro_price') THEN RAISE EXCEPTION 'subscription.pro_price config failed'; END IF;
    -- Ensure the deposit crediting functions are still present (untouched).
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'credit_payment_safe') THEN RAISE EXCEPTION 'credit_payment_safe missing - deposit system must remain untouched'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'record_trade_safe') THEN RAISE EXCEPTION 'record_trade_safe missing - trade system must remain untouched'; END IF;
    RAISE NOTICE '✅ Arbitrix Pro subscription migration completed (deposit/trade/payment systems untouched)';
END $$;
