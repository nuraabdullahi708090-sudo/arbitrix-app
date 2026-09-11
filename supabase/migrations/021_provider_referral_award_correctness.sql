-- ============================================
-- ============================================
-- MIGRATION 021 — Production referral award correctness in the provider
--                 credit functions (COMPANION to migration 020)
-- ============================================
-- WHY THIS EXISTS
--   The provider credit functions (confirm_payment_with_credit,
--   credit_payment_safe, paymento_credit_user_safe) hard-coded a FIXED $10
--   bonus on the referred user's FIRST credited invoice of ANY amount, without
--   ever updating the referral row. Because migrations 006/007/008 predate the
--   final management model, that path:
--     * paid a flat amount instead of the approved 20% of the qualifying deposit,
--     * qualified on ANY first deposit (even below the platform minimum),
--     * never marked the referral `active`, so earnings/attribution stayed wrong.
--   A config row cannot change a literal hard-coded inside a function, so this
--   migration re-points those functions at one shared SQL authority.
--
-- WHAT THIS MIGRATION DOES (nothing else)
--   1. Adds public.award_referral_qualification_safe(p_referred_id,
--      p_deposit_amount) — the SINGLE SQL authority for the production referral
--      award. FINAL MODEL: a ONE-TIME reward equal to
--        referral_reward_percent (default 20) % of the referred user's initial
--        qualifying deposit,
--      config-driven (referral_config = single source of truth),
--      platform-minimum-deposit gate, exactly-once via the pending referral row
--      + FOR UPDATE lock, honours rewards_enabled and max_rewards_per_user,
--      refuses MARKETING_SANDBOX accounts, and never touches the referred
--      user's money. Returns JSONB so callers get the awarded amount + reason.
--      It pays NO downline profit commission (that model is retired).
--   2. Replaces ONLY the hard-coded referral block inside the four existing
--      provider credit functions with a call to that helper. Every other line
--      of those functions is byte-identical to 006/007/008 — verified by
--      tests/referral_provider_award.test.js, which diffs them against the
--      source migrations.
--   3. Re-asserts the migration-014 execute lockdown (service_role only).
--
-- WHAT IT DOES NOT DO
--   * No table/column/constraint change, no data migration, no balance change.
--   * No change to crediting, duplicate protection, invoice state, wallets or
--     transaction logic.
--   * No MARKETING_SANDBOX behavior change (that path never reaches these
--     production credit functions, and the helper refuses sandbox accounts).
--
-- IDEMPOTENT: CREATE OR REPLACE + guarded grants; safe to re-run. The final DO
-- block re-verifies the helper and RAISES on drift.
--
-- NOT APPLIED. Do not apply to production or to the Marketing Sandbox until
-- explicitly instructed.
-- ============================================

-- ============================================
-- 1. SINGLE SQL AUTHORITY FOR THE REFERRAL AWARD
-- ============================================
-- DROP first: the retired revision of this helper returned DECIMAL, and
-- CREATE OR REPLACE cannot change a function's return type. Dropping by name
-- (any signature) makes this file safely re-appliable on an environment that
-- already ran the earlier revision — the provider functions below are replaced
-- in the same transaction, so the intermediate state is never observable.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'award_referral_qualification_safe'
    LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig;
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.award_referral_qualification_safe(
    p_referred_id BIGINT,
    p_deposit_amount DECIMAL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_referral referrals%ROWTYPE;
    v_reward DECIMAL := 0;
    v_reward_percent DECIMAL := 20;
    v_min DECIMAL := 100;
    v_max INTEGER := 0;
    v_raw TEXT;
    v_rewards_enabled BOOLEAN := TRUE;
    v_is_sandbox BOOLEAN := FALSE;
    v_active_count INTEGER := 0;
    v_updated INTEGER := 0;
    v_referrer_sandbox BOOLEAN := FALSE;
BEGIN
    IF p_referred_id IS NULL OR p_deposit_amount IS NULL THEN
        RETURN jsonb_build_object('awarded', FALSE, 'reward', 0, 'reason', 'invalid_input');
    END IF;

    -- Production-only: never award production referral income for a
    -- MARKETING_SANDBOX account. If users.environment does not exist (migration
    -- 013 not applied) there are no sandbox accounts -> production behavior,
    -- mirroring server.js getUserEnvironment(), which fails closed to production.
    BEGIN
        SELECT EXISTS (
            SELECT 1 FROM public.users
             WHERE id = p_referred_id AND environment = 'MARKETING_SANDBOX'
        ) INTO v_is_sandbox;
    EXCEPTION WHEN OTHERS THEN
        v_is_sandbox := FALSE;
    END;
    IF COALESCE(v_is_sandbox, FALSE) THEN
        RETURN jsonb_build_object('awarded', FALSE, 'reward', 0, 'reason', 'sandbox_account');
    END IF;

    -- Configuration is the single source of truth (defaults mirror server.js).
    IF to_regclass('public.referral_config') IS NOT NULL THEN
        SELECT config_value INTO v_raw FROM public.referral_config WHERE config_key = 'rewards_enabled';
        IF v_raw IS NOT NULL THEN
            v_rewards_enabled := lower(v_raw) IN ('true', 't', '1', 'yes', 'on');
        END IF;

        SELECT config_value INTO v_raw FROM public.referral_config WHERE config_key = 'minimum_qualifying_deposit';
        IF v_raw IS NOT NULL THEN
            BEGIN
                v_min := v_raw::DECIMAL;
            EXCEPTION WHEN OTHERS THEN
                v_min := 100;
            END;
        END IF;

        -- FINAL MODEL: the reward is a percentage, not a fixed amount.
        SELECT config_value INTO v_raw FROM public.referral_config WHERE config_key = 'referral_reward_percent';
        IF v_raw IS NOT NULL THEN
            BEGIN
                v_reward_percent := v_raw::DECIMAL;
            EXCEPTION WHEN OTHERS THEN
                v_reward_percent := 20;
            END;
        END IF;

        SELECT config_value INTO v_raw FROM public.referral_config WHERE config_key = 'max_rewards_per_user';
        IF v_raw IS NOT NULL THEN
            BEGIN
                v_max := v_raw::INTEGER;
            EXCEPTION WHEN OTHERS THEN
                v_max := 0;
            END;
        END IF;
    END IF;

    IF v_reward_percent IS NULL OR v_reward_percent <= 0 THEN
        v_reward_percent := 20;
    END IF;
    IF v_reward_percent > 100 THEN
        v_reward_percent := 100;
    END IF;
    IF v_min IS NULL OR v_min < 0 THEN
        v_min := 100;
    END IF;
    IF NOT COALESCE(v_rewards_enabled, FALSE) THEN
        RETURN jsonb_build_object('awarded', FALSE, 'reward', 0, 'reason', 'rewards_disabled');
    END IF;

    -- QUALIFICATION RULE: only the platform's minimum qualifying deposit.
    -- Registration/onboarding/KYC/referral-link clicks never reach here, and a
    -- deposit below the minimum does not qualify.
    IF p_deposit_amount < v_min THEN
        RETURN jsonb_build_object('awarded', FALSE, 'reward', 0, 'reason', 'below_minimum_deposit');
    END IF;

    -- FINAL REWARD: one-time, 20% (configurable) of the INITIAL qualifying
    -- deposit. Computed from the deposit actually credited, rounded to cents.
    v_reward := ROUND(p_deposit_amount * v_reward_percent / 100.0, 2);
    IF v_reward IS NULL OR v_reward <= 0 THEN
        RETURN jsonb_build_object('awarded', FALSE, 'reward', 0, 'reason', 'no_reward');
    END IF;

    -- Attribution + exactly-once anchor: the still-pending referral row.
    SELECT * INTO v_referral
      FROM public.referrals
     WHERE referred_id = p_referred_id
       AND status = 'pending'
       AND COALESCE(bonus_earned, 0) = 0
     ORDER BY id
     LIMIT 1
     FOR UPDATE;

    IF v_referral.id IS NULL THEN
        RETURN jsonb_build_object('awarded', FALSE, 'reward', 0, 'reason', 'no_pending_referral');
    END IF;
    IF v_referral.referrer_id IS NULL OR v_referral.referrer_id = p_referred_id THEN
        RETURN jsonb_build_object('awarded', FALSE, 'reward', 0, 'reason', 'invalid_referrer');
    END IF;

    -- Never let a sandbox referrer receive production referral earnings.
    BEGIN
        SELECT EXISTS (
            SELECT 1 FROM public.users
             WHERE id = v_referral.referrer_id AND environment = 'MARKETING_SANDBOX'
        ) INTO v_referrer_sandbox;
    EXCEPTION WHEN OTHERS THEN
        v_referrer_sandbox := FALSE;
    END;
    IF COALESCE(v_referrer_sandbox, FALSE) THEN
        RETURN jsonb_build_object('awarded', FALSE, 'reward', 0, 'reason', 'sandbox_referrer');
    END IF;

    IF v_max > 0 THEN
        SELECT COUNT(*) INTO v_active_count
          FROM public.referrals
         WHERE referrer_id = v_referral.referrer_id
           AND status = 'active';
        IF v_active_count >= v_max THEN
            RETURN jsonb_build_object('awarded', FALSE, 'reward', 0, 'reason', 'max_rewards_reached');
        END IF;
    END IF;

    -- Mark qualified FIRST and guarded: a concurrent/duplicate call can never
    -- award twice, and a failure below rolls back with the transaction.
    UPDATE public.referrals
       SET status = 'active',
           bonus_earned = v_reward,
           qualified_at = NOW(),
           qualification_type = 'first_deposit'
     WHERE id = v_referral.id
       AND status = 'pending'
       AND COALESCE(bonus_earned, 0) = 0;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
        RETURN jsonb_build_object('awarded', FALSE, 'reward', 0, 'reason', 'already_qualified');
    END IF;

    -- Credit the referrer's existing referral-earnings bucket.
    UPDATE public.wallets
       SET bonus_balance = COALESCE(bonus_balance, 0) + v_reward,
           updated_at = NOW()
     WHERE user_id = v_referral.referrer_id;
    IF NOT FOUND THEN
        INSERT INTO public.wallets (user_id, live_balance, demo_balance, bonus_balance)
        VALUES (v_referral.referrer_id, 0, 1000, v_reward);
    END IF;

    INSERT INTO public.transactions (user_id, type, amount, detail, created_at)
    VALUES (v_referral.referrer_id, 'Referral Bonus', v_reward,
            'Referral bonus for qualifying deposit - User: ' || p_referred_id::TEXT, NOW());

    RETURN jsonb_build_object(
        'awarded', TRUE,
        'reward', v_reward,
        'reward_percent', v_reward_percent,
        'deposit_amount', p_deposit_amount,
        'referrer_id', v_referral.referrer_id,
        'referral_id', v_referral.id
    );
END;
$$;

COMMENT ON FUNCTION public.award_referral_qualification_safe(BIGINT, DECIMAL) IS
    'Single SQL authority for the production referral award (FINAL model): one-time reward = referral_reward_percent (default 20) percent of the referred user''s initial qualifying deposit (platform minimum), exactly-once, sandbox-refusing, no downline commission. Returns JSONB {awarded, reward, reason}.';

-- ============================================
-- 2. PROVIDER CREDIT FUNCTIONS — referral block delegated
-- ============================================
-- ONLY the referral block differs from migrations 006/007/008. Verified by
-- tests/referral_provider_award.test.js (byte-diff against the source files).

CREATE OR REPLACE FUNCTION public.confirm_payment_with_credit(
    p_invoice_id BIGINT,
    p_user_id BIGINT,
    p_amount_usd DECIMAL,
    p_transaction_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_invoice payment_invoices%ROWTYPE;
    v_wallet wallets%ROWTYPE;
    v_new_balance DECIMAL;
    v_existing_tx BOOLEAN;
    v_deposit_count INTEGER;
    v_referral_reward DECIMAL := 0;
    v_referrer_id BIGINT;
    v_is_first_deposit BOOLEAN := FALSE;
BEGIN
    
    IF p_transaction_hash IS NOT NULL THEN
        SELECT EXISTS(
            SELECT 1 FROM payment_invoices 
            WHERE transaction_hash = p_transaction_hash
            AND status = 'confirmed'
        ) INTO v_existing_tx;
        
        IF v_existing_tx THEN
            RAISE EXCEPTION 'Transaction already processed';
        END IF;
    END IF;

    SELECT * INTO v_invoice
    FROM payment_invoices
    WHERE id = p_invoice_id AND status = 'pending'
    FOR UPDATE;

    IF v_invoice IS NULL THEN
        RAISE EXCEPTION 'Invoice not found or already processed';
    END IF;

    IF v_invoice.status != 'pending' THEN
        RAISE EXCEPTION 'Invoice already processed with status: %', v_invoice.status;
    END IF;

    SELECT COUNT(*) INTO v_deposit_count
    FROM payment_invoices
    WHERE user_id = p_user_id
    AND status = 'confirmed';
    
    IF v_deposit_count = 0 THEN
        v_is_first_deposit := TRUE;
    END IF;

    SELECT * INTO v_wallet
    FROM wallets
    WHERE user_id = p_user_id
    FOR UPDATE;
    
    IF v_wallet IS NULL THEN
        INSERT INTO wallets (user_id, live_balance, demo_balance, bonus_balance)
        VALUES (p_user_id, p_amount_usd, 0, 0)
        RETURNING * INTO v_wallet;
        v_new_balance := p_amount_usd;
    ELSE
        UPDATE wallets
        SET live_balance = live_balance + p_amount_usd,
            updated_at = NOW()
        WHERE user_id = p_user_id
        RETURNING live_balance INTO v_new_balance;
    END IF;

    UPDATE payment_invoices
    SET status = 'confirmed',
        confirmed_at = NOW(),
        credited_at = NOW(),
        updated_at = NOW(),
        transaction_hash = COALESCE(p_transaction_hash, transaction_hash)
    WHERE id = p_invoice_id;

    INSERT INTO transactions (user_id, type, amount, detail, created_at)
    VALUES (p_user_id, 'Deposit', p_amount_usd, 'Payment confirmed - ' || COALESCE(p_transaction_hash, 'Internal'), NOW());

    -- Referral qualification (final management model): a referral qualifies ONLY
    -- on the platform's minimum qualifying deposit and only ONCE, and pays a
    -- ONE-TIME reward of 20% of that initial deposit. Delegated to
    -- award_referral_qualification_safe() so the reward can never be
    -- hard-coded here again (single source of truth = referral_config).
    BEGIN
        v_referral_reward := COALESCE((award_referral_qualification_safe(p_user_id, p_amount_usd)->>'reward')::DECIMAL, 0);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Referral qualification failed: %', SQLERRM;
        v_referral_reward := 0;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'invoice_id', p_invoice_id,
        'user_id', p_user_id,
        'amount_usd', p_amount_usd,
        'new_balance', v_new_balance,
        'credited', true,
        'is_first_deposit', v_is_first_deposit,
        'referral_bonus', v_referral_reward
    );
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.credit_payment_safe(
    p_invoice_id BIGINT,
    p_user_id BIGINT,
    p_amount_usd DECIMAL,
    p_transaction_hash TEXT DEFAULT NULL,
    p_provider_invoice_id TEXT DEFAULT NULL,
    p_provider_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_invoice payment_invoices%ROWTYPE;
    v_wallet wallets%ROWTYPE;
    v_new_balance DECIMAL;
    v_existing_credit BOOLEAN;
    v_existing_tx BOOLEAN;
    v_deposit_count INTEGER;
    v_referral_reward DECIMAL := 0;
    v_referrer_id BIGINT;
    v_is_first_deposit BOOLEAN := FALSE;
BEGIN

    -- Idempotency check #1: already credited?
    SELECT credited INTO v_existing_credit
    FROM payment_invoices
    WHERE id = p_invoice_id;

    IF v_existing_credit = TRUE THEN
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Invoice already credited',
            'invoice_id', p_invoice_id
        );
    END IF;

    -- Idempotency check #2: same blockchain tx hash already confirmed?
    -- (transaction_hash is UNIQUE; protects against cross-provider double-credit)
    IF p_transaction_hash IS NOT NULL THEN
        SELECT EXISTS(
            SELECT 1 FROM payment_invoices
            WHERE transaction_hash = p_transaction_hash
            AND status = 'confirmed'
        ) INTO v_existing_tx;

        IF v_existing_tx THEN
            RETURN jsonb_build_object(
                'success', true,
                'duplicate', true,
                'message', 'Transaction hash already processed',
                'transaction_hash', p_transaction_hash
            );
        END IF;
    END IF;

    -- Lock the invoice row
    SELECT * INTO v_invoice
    FROM payment_invoices
    WHERE id = p_invoice_id
    FOR UPDATE;

    IF v_invoice IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
    END IF;

    -- Double-check credited status after lock (race-condition protection)
    IF v_invoice.credited = TRUE THEN
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Invoice already credited (race condition prevented)',
            'invoice_id', p_invoice_id
        );
    END IF;

    IF v_invoice.status = 'confirmed' THEN
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Invoice already confirmed',
            'invoice_id', p_invoice_id
        );
    END IF;

    -- First-deposit detection (only counts already-credited deposits)
    SELECT COUNT(*) INTO v_deposit_count
    FROM payment_invoices
    WHERE user_id = p_user_id
    AND status = 'confirmed'
    AND credited = TRUE;

    IF v_deposit_count = 0 THEN
        v_is_first_deposit := TRUE;
    END IF;

    -- Get or create wallet (row-locked)
    SELECT * INTO v_wallet
    FROM wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF v_wallet IS NULL THEN
        INSERT INTO wallets (user_id, live_balance, demo_balance, bonus_balance)
        VALUES (p_user_id, p_amount_usd, 0, 0)
        RETURNING * INTO v_wallet;
        v_new_balance := p_amount_usd;
    ELSE
        UPDATE wallets
        SET live_balance = live_balance + p_amount_usd,
            updated_at = NOW()
        WHERE user_id = p_user_id
        RETURNING live_balance INTO v_new_balance;
    END IF;

    -- Update invoice: confirmed + credited + audit fields
    UPDATE payment_invoices
    SET status = 'confirmed',
        credited = TRUE,
        confirmed_at = NOW(),
        credited_at = NOW(),
        updated_at = NOW(),
        transaction_hash = COALESCE(p_transaction_hash, transaction_hash),
        provider_invoice_ref = COALESCE(p_provider_invoice_id, provider_invoice_ref),
        provider = COALESCE(NULLIF(p_provider_name, ''), provider)
    WHERE id = p_invoice_id;

    -- Record user-facing transaction
    INSERT INTO transactions (user_id, type, amount, detail, created_at)
    VALUES (p_user_id, 'Deposit', p_amount_usd,
        COALESCE(NULLIF(p_provider_name, ''), 'Payment') || ' deposit confirmed - Invoice: ' || p_invoice_id::TEXT
        || COALESCE(' - TX: ' || NULLIF(p_transaction_hash, ''), ''),
        NOW());

    -- Referral qualification (final management model): a referral qualifies ONLY
    -- on the platform's minimum qualifying deposit and only ONCE, and pays a
    -- ONE-TIME reward of 20% of that initial deposit. Delegated to
    -- award_referral_qualification_safe() so the reward can never be
    -- hard-coded here again (single source of truth = referral_config).
    BEGIN
        v_referral_reward := COALESCE((award_referral_qualification_safe(p_user_id, p_amount_usd)->>'reward')::DECIMAL, 0);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Referral qualification failed: %', SQLERRM;
        v_referral_reward := 0;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'duplicate', false,
        'invoice_id', p_invoice_id,
        'user_id', p_user_id,
        'amount_usd', p_amount_usd,
        'new_balance', v_new_balance,
        'credited', true,
        'is_first_deposit', v_is_first_deposit,
        'referral_bonus', v_referral_reward
    );

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.paymento_credit_user_safe(
    p_invoice_id BIGINT,
    p_user_id BIGINT,
    p_amount_usd DECIMAL,
    p_provider_payment_id BIGINT DEFAULT NULL,
    p_provider_status_code INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_invoice payment_invoices%ROWTYPE;
    v_wallet wallets%ROWTYPE;
    v_new_balance DECIMAL;
    v_existing_credit BOOLEAN;
    v_deposit_count INTEGER;
    v_referral_reward DECIMAL := 0;
    v_referrer_id BIGINT;
    v_is_first_deposit BOOLEAN := FALSE;
BEGIN
    
    -- Check if already credited (idempotency check)
    SELECT credited INTO v_existing_credit
    FROM payment_invoices
    WHERE id = p_invoice_id;
    
    IF v_existing_credit = TRUE THEN
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Invoice already credited',
            'invoice_id', p_invoice_id
        );
    END IF;
    
    -- Lock the invoice row
    SELECT * INTO v_invoice
    FROM payment_invoices
    WHERE id = p_invoice_id
    FOR UPDATE;
    
    IF v_invoice IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
    END IF;
    
    -- Double-check credited status after lock
    IF v_invoice.credited = TRUE THEN
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Invoice already credited (race condition prevented)',
            'invoice_id', p_invoice_id
        );
    END IF;
    
    -- Check if already confirmed
    IF v_invoice.status = 'confirmed' THEN
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Invoice already confirmed',
            'invoice_id', p_invoice_id
        );
    END IF;
    
    -- Check for first deposit
    SELECT COUNT(*) INTO v_deposit_count
    FROM payment_invoices
    WHERE user_id = p_user_id
    AND status = 'confirmed'
    AND credited = TRUE;
    
    IF v_deposit_count = 0 THEN
        v_is_first_deposit := TRUE;
    END IF;
    
    -- Get or create wallet
    SELECT * INTO v_wallet
    FROM wallets
    WHERE user_id = p_user_id
    FOR UPDATE;
    
    IF v_wallet IS NULL THEN
        INSERT INTO wallets (user_id, live_balance, demo_balance, bonus_balance)
        VALUES (p_user_id, p_amount_usd, 0, 0)
        RETURNING * INTO v_wallet;
        v_new_balance := p_amount_usd;
    ELSE
        UPDATE wallets
        SET live_balance = live_balance + p_amount_usd,
            updated_at = NOW()
        WHERE user_id = p_user_id
        RETURNING live_balance INTO v_new_balance;
    END IF;
    
    -- Update invoice status
    UPDATE payment_invoices
    SET status = 'confirmed',
        credited = TRUE,
        confirmed_at = NOW(),
        credited_at = NOW(),
        updated_at = NOW(),
        provider_payment_id = COALESCE(p_provider_payment_id, provider_payment_id),
        provider_status_code = COALESCE(p_provider_status_code, provider_status_code)
    WHERE id = p_invoice_id;
    
    -- Record transaction
    INSERT INTO transactions (user_id, type, amount, detail, created_at)
    VALUES (p_user_id, 'Deposit', p_amount_usd, 'Paymento deposit confirmed - Invoice: ' || p_invoice_id::TEXT, NOW());
    
    -- Referral qualification (final management model): a referral qualifies ONLY
    -- on the platform's minimum qualifying deposit and only ONCE, and pays a
    -- ONE-TIME reward of 20% of that initial deposit. Delegated to
    -- award_referral_qualification_safe() so the reward can never be
    -- hard-coded here again (single source of truth = referral_config).
    BEGIN
        v_referral_reward := COALESCE((award_referral_qualification_safe(p_user_id, p_amount_usd)->>'reward')::DECIMAL, 0);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Referral qualification failed: %', SQLERRM;
        v_referral_reward := 0;
    END;
    
    RETURN jsonb_build_object(
        'success', true,
        'duplicate', false,
        'invoice_id', p_invoice_id,
        'user_id', p_user_id,
        'amount_usd', p_amount_usd,
        'new_balance', v_new_balance,
        'credited', true,
        'is_first_deposit', v_is_first_deposit,
        'referral_bonus', v_referral_reward
    );
    
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.paymento_credit_user_safe(
    p_invoice_id BIGINT,
    p_user_id BIGINT,
    p_amount_usd DECIMAL,
    p_provider_payment_id BIGINT DEFAULT NULL,
    p_provider_status_code INTEGER DEFAULT NULL,
    p_settlement_address TEXT DEFAULT NULL,
    p_provider_tx_hash TEXT DEFAULT NULL,
    p_provider_confirmations INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_invoice payment_invoices%ROWTYPE;
    v_wallet wallets%ROWTYPE;
    v_new_balance DECIMAL;
    v_existing_credit BOOLEAN;
    v_deposit_count INTEGER;
    v_referral_reward DECIMAL := 0;
    v_referrer_id BIGINT;
    v_is_first_deposit BOOLEAN := FALSE;
BEGIN
    
    -- Check if already credited (idempotency check)
    SELECT credited INTO v_existing_credit
    FROM payment_invoices
    WHERE id = p_invoice_id;
    
    IF v_existing_credit = TRUE THEN
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Invoice already credited',
            'invoice_id', p_invoice_id
        );
    END IF;
    
    -- Lock the invoice row
    SELECT * INTO v_invoice
    FROM payment_invoices
    WHERE id = p_invoice_id
    FOR UPDATE;
    
    IF v_invoice IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
    END IF;
    
    -- Double-check credited status after lock
    IF v_invoice.credited = TRUE THEN
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Invoice already credited (race condition prevented)',
            'invoice_id', p_invoice_id
        );
    END IF;
    
    -- Check if already confirmed
    IF v_invoice.status = 'confirmed' THEN
        RETURN jsonb_build_object(
            'success', true,
            'duplicate', true,
            'message', 'Invoice already confirmed',
            'invoice_id', p_invoice_id
        );
    END IF;
    
    -- Check for first deposit
    SELECT COUNT(*) INTO v_deposit_count
    FROM payment_invoices
    WHERE user_id = p_user_id
    AND status = 'confirmed'
    AND credited = TRUE;
    
    IF v_deposit_count = 0 THEN
        v_is_first_deposit := TRUE;
    END IF;
    
    -- Get or create wallet
    SELECT * INTO v_wallet
    FROM wallets
    WHERE user_id = p_user_id
    FOR UPDATE;
    
    IF v_wallet IS NULL THEN
        INSERT INTO wallets (user_id, live_balance, demo_balance, bonus_balance)
        VALUES (p_user_id, p_amount_usd, 0, 0)
        RETURNING * INTO v_wallet;
        v_new_balance := p_amount_usd;
    ELSE
        UPDATE wallets
        SET live_balance = live_balance + p_amount_usd,
            updated_at = NOW()
        WHERE user_id = p_user_id
        RETURNING live_balance INTO v_new_balance;
    END IF;
    
    -- Update invoice status with ALL available data including settlement audit fields
    -- NOTE: Settlement data is stored when available but is NOT required for crediting
    UPDATE payment_invoices
    SET status = 'confirmed',
        credited = TRUE,
        confirmed_at = NOW(),
        credited_at = NOW(),
        updated_at = NOW(),
        provider_payment_id = COALESCE(p_provider_payment_id, provider_payment_id),
        provider_status_code = COALESCE(p_provider_status_code, provider_status_code),
        settlement_address = COALESCE(p_settlement_address, settlement_address),
        provider_tx_hash = COALESCE(p_provider_tx_hash, provider_tx_hash),
        provider_confirmations = COALESCE(p_provider_confirmations, provider_confirmations)
    WHERE id = p_invoice_id;
    
    -- Record transaction
    INSERT INTO transactions (user_id, type, amount, detail, created_at)
    VALUES (p_user_id, 'Deposit', p_amount_usd, 'Paymento deposit confirmed - Invoice: ' || p_invoice_id::TEXT, NOW());
    
    -- Referral qualification (final management model): a referral qualifies ONLY
    -- on the platform's minimum qualifying deposit and only ONCE, and pays a
    -- ONE-TIME reward of 20% of that initial deposit. Delegated to
    -- award_referral_qualification_safe() so the reward can never be
    -- hard-coded here again (single source of truth = referral_config).
    BEGIN
        v_referral_reward := COALESCE((award_referral_qualification_safe(p_user_id, p_amount_usd)->>'reward')::DECIMAL, 0);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Referral qualification failed: %', SQLERRM;
        v_referral_reward := 0;
    END;
    
    RETURN jsonb_build_object(
        'success', true,
        'duplicate', false,
        'invoice_id', p_invoice_id,
        'user_id', p_user_id,
        'amount_usd', p_amount_usd,
        'new_balance', v_new_balance,
        'credited', true,
        'is_first_deposit', v_is_first_deposit,
        'referral_bonus', v_referral_reward
    );
    
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ============================================
-- 3. EXECUTE LOCKDOWN (matches migration 014 posture)
-- ============================================
REVOKE EXECUTE ON FUNCTION public.award_referral_qualification_safe(BIGINT, DECIMAL) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.award_referral_qualification_safe(BIGINT, DECIMAL) FROM anon;
REVOKE EXECUTE ON FUNCTION public.award_referral_qualification_safe(BIGINT, DECIMAL) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.award_referral_qualification_safe(BIGINT, DECIMAL) TO service_role;

REVOKE EXECUTE ON FUNCTION public.confirm_payment_with_credit(BIGINT, BIGINT, DECIMAL, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.confirm_payment_with_credit(BIGINT, BIGINT, DECIMAL, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.confirm_payment_with_credit(BIGINT, BIGINT, DECIMAL, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payment_with_credit(BIGINT, BIGINT, DECIMAL, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.credit_payment_safe(BIGINT, BIGINT, DECIMAL, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_payment_safe(BIGINT, BIGINT, DECIMAL, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.credit_payment_safe(BIGINT, BIGINT, DECIMAL, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.credit_payment_safe(BIGINT, BIGINT, DECIMAL, TEXT, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER) TO service_role;

REVOKE EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER, TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER, TEXT, TEXT, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER, TEXT, TEXT, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.paymento_credit_user_safe(BIGINT, BIGINT, DECIMAL, BIGINT, INTEGER, TEXT, TEXT, INTEGER) TO service_role;

-- ============================================
-- 4. VERIFICATION (read-only; raises on drift)
-- ============================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'award_referral_qualification_safe'
    ) THEN
        RAISE EXCEPTION 'award_referral_qualification_safe function missing!';
    END IF;

    -- The helper must implement the FINAL percentage model and must not read
    -- the retired fixed-reward config key.
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'award_referral_qualification_safe'
           AND pg_get_function_result(p.oid) = 'jsonb'
    ) THEN
        RAISE EXCEPTION 'award_referral_qualification_safe must return JSONB!';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'award_referral_qualification_safe'
           AND pg_get_functiondef(p.oid) LIKE '%referral_reward_amount%'
    ) THEN
        RAISE EXCEPTION 'award_referral_qualification_safe still reads the retired referral_reward_amount config!';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'award_referral_qualification_safe'
           AND pg_get_functiondef(p.oid) LIKE '%referral_reward_percent%'
    ) THEN
        RAISE EXCEPTION 'award_referral_qualification_safe does not read referral_reward_percent!';
    END IF;

    -- The hard-coded referral award must be gone from every provider credit
    -- function that exists, and every one of them must delegate to the helper.
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('confirm_payment_with_credit', 'credit_payment_safe', 'paymento_credit_user_safe')
    ) THEN
        IF EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public'
               AND p.proname IN ('confirm_payment_with_credit', 'credit_payment_safe', 'paymento_credit_user_safe')
               AND (pg_get_functiondef(p.oid) LIKE '%v_referral_reward := 10;%'
                    OR pg_get_functiondef(p.oid) LIKE '%referral_reward_amount%')
        ) THEN
            RAISE EXCEPTION 'a provider credit function still hard-codes a fixed referral reward!';
        END IF;

        IF EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public'
               AND p.proname IN ('confirm_payment_with_credit', 'credit_payment_safe', 'paymento_credit_user_safe')
               AND pg_get_functiondef(p.oid) NOT LIKE '%award_referral_qualification_safe%'
        ) THEN
            RAISE EXCEPTION 'a provider credit function does not call the shared referral helper!';
        END IF;
    END IF;

    RAISE NOTICE '✅ Provider referral award correctness migration completed successfully (20%% of the initial qualifying deposit)!';
END $$;

-- ============================================
-- ROLLBACK (reference only)
-- ============================================
-- Re-applying the referral block from migrations 006/007/008 would restore the
-- retired flat reward; that is NOT supported. Reference only:
-- DROP FUNCTION IF EXISTS public.award_referral_qualification_safe(BIGINT, DECIMAL);
-- ============================================
