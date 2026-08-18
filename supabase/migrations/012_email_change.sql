-- ============================================
-- MIGRATION: 012 - Secure Profile Email Change
-- ============================================
-- Arbitrix Pro / Phase 8B
--
-- GOAL: a secure, verified email-change flow that does NOT allow a user to
-- change their account email by simply editing a field. The user requests a
-- change to a NEW email; a single-use, time-limited, cryptographically random
-- verification code is sent to the NEW email; only after successful
-- verification does users.email get updated. The user's internal user id is
-- NEVER changed. The OLD email continues to work for login until the new one
-- is verified.
--
-- This migration is strictly ADDITIVE:
--   - It creates ONE new table: public.email_change_requests
--   - It does NOT alter users, wallets, transactions, deposits, withdrawals,
--     KYC, subscriptions, referrals, 2FA, payment_config, or any auth table.
--   - It does NOT change the subscription price or any financial logic.
--
-- DESIGN (mirrors the proven password_reset_tokens / email_verification_codes
-- security model):
--   - BIGINT user_id to match users(id) (Supabase Auth uses UUIDs; users.id is
--     BIGINT, so RLS is disabled and authorization is enforced in app code via
--     JWT -> req.user.id, exactly like every other BIGINT table in this app).
--   - The verification code is stored ONLY as a SHA256 hash (code_hash), never
--     in plaintext. The plaintext code is sent to the NEW email and is never
--     returned by any API, logged, or stored.
--   - Single-use: a verified row is marked used=true and cannot be reused.
--   - Time-limited: expires_at is enforced in app code (mirrors
--     password_reset_tokens, which enforces expiry at the app level to avoid
--     volatile NOW() in CHECK constraints).
--   - One pending request per user: the request endpoint replaces any prior
--     unused pending row for the same user (so a new request invalidates the
--     previous pending one), enforced in app code.
--   - Rate limiting / cooldown is enforced in app code (per-user).
-- ============================================

-- ============================================
-- 1. EMAIL CHANGE REQUESTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.email_change_requests (
    id BIGSERIAL PRIMARY KEY,
    -- The authenticated user requesting the change (from JWT req.user.id).
    -- The app NEVER trusts a client-supplied user id.
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

    -- The proposed NEW email. Only written to users.email AFTER successful
    -- verification of this row.
    new_email TEXT NOT NULL,

    -- SHA256 hash of the single-use verification code. Plaintext is never stored.
    code_hash TEXT NOT NULL,

    -- App-level expiry (mirrors password_reset_tokens).
    expires_at TIMESTAMPTZ NOT NULL,

    -- Single-use flag. Set true on successful verification; a used row can
    -- never verify again.
    used BOOLEAN NOT NULL DEFAULT FALSE,

    -- Verification attempts against this code, for per-request throttling.
    attempts INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used_at TIMESTAMPTZ,
    ip_address INET,
    user_agent TEXT
);

-- ============================================
-- 2. INDEXES
-- ============================================
-- Lookup the active pending request for a user.
CREATE INDEX IF NOT EXISTS idx_email_change_user
    ON public.email_change_requests(user_id);

-- Fast invalidation/lookup of pending (unused, unexpired) requests per user.
CREATE INDEX IF NOT EXISTS idx_email_change_pending
    ON public.email_change_requests(user_id, used)
    WHERE used = FALSE;

-- Optional cleanup of expired rows.
CREATE INDEX IF NOT EXISTS idx_email_change_expires
    ON public.email_change_requests(expires_at)
    WHERE used = FALSE;

-- ============================================
-- 3. DISABLE RLS (BIGINT compatibility, matches existing payment/trades/
--    email_verification_codes tables; authorization via app code / JWT)
-- ============================================
-- NOTE: this ALTER runs AFTER CREATE TABLE above, so the table exists.
-- (Newly created tables default to RLS disabled; this is explicit for clarity
--  and to match the documented security model.)
ALTER TABLE public.email_change_requests DISABLE ROW LEVEL SECURITY;

-- ============================================
-- 4. VERIFY
-- ============================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = 'email_change_requests') THEN
        RAISE EXCEPTION 'email_change_requests table failed';
    END IF;

    -- Ensure existing auth/financial systems are untouched (still present).
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = 'users') THEN
        RAISE EXCEPTION 'users table missing - auth system must remain untouched';
    END IF;

    RAISE NOTICE '✅ Secure email-change migration completed (users/wallets/KYC/subscriptions untouched)';
END $$;
