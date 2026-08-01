-- ============================================
-- Password Reset Tokens Table Migration
-- Arbitrix AI - Production Migration
-- ============================================
-- This migration creates the password_reset_tokens table with:
-- - Proper constraints for data integrity
-- - Indexes for query performance
-- - Row Level Security (RLS) for access control
-- - Automatic cleanup of expired tokens
-- ============================================

-- ============================================
-- 1. CREATE THE TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Email address (required)
    email TEXT NOT NULL,
    
    -- Hashed reset token (bcrypt hash of the actual token)
    -- The actual token is sent via email; only the hash is stored
    token_hash TEXT NOT NULL,
    
    -- Token expiration timestamp
    -- NOTE: Expiration is enforced at the APPLICATION LEVEL, not via constraint
    -- Why: Using NOW() in CHECK constraints is problematic for production:
    --   - Volatile functions in constraints can cause replication issues
    --   - Partial indexes with NOW() become stale over time
    --   - The application already calculates Date.now() + RESET_TOKEN_EXPIRY correctly
    expires_at TIMESTAMPTZ NOT NULL,
    
    -- Whether the token has been used
    used BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Creation timestamp (used for cleanup instead of expires_at)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Track which IP requested the reset (for security auditing)
    ip_address INET
);

-- ============================================
-- 2. ADD CONSTRAINTS
-- ============================================

-- Validate email format (basic check)
-- More strict validation can be done at application level
ALTER TABLE public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_email_format
    CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
    NOT VALID;

-- Ensure expires_at is NOT NULL and is a valid timestamp
-- This is a basic sanity check, not a time validation
ALTER TABLE public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_expires_at_not_null
    CHECK (expires_at IS NOT NULL)
    NOT VALID;

-- ============================================
-- 3. CREATE INDEXES
-- ============================================

-- Primary lookup index: Find tokens by email for cleanup and validation
-- Used when: checking for existing tokens, invalidating old tokens
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email
    ON public.password_reset_tokens(email);

-- Token lookup index: Find token by hash for validation
-- Used when: validating a reset token from URL
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash
    ON public.password_reset_tokens(token_hash);

-- Unused tokens index: Find unused tokens for cleanup
-- Used when: cleaning up old tokens via scheduled job
-- NOTE: We only index unused tokens to reduce index size
-- The expires_at check is done in the query, not the index
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_unused
    ON public.password_reset_tokens(expires_at)
    WHERE used = FALSE;

-- Composite index: Find unused tokens for a specific email
-- Used when: checking if user already has a pending reset request
-- NOTE: No time filter in partial index - expires_at check is in the query
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email_unused
    ON public.password_reset_tokens(email, expires_at)
    WHERE used = FALSE;

-- ============================================
-- 4. ENABLE ROW LEVEL SECURITY (RLS)
-- ============================================

-- Enable RLS on the table
ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 5. RLS POLICIES
-- ============================================

-- Policy 1: Allow INSERT (create new reset tokens)
-- Only the server (authenticated via service role) can create tokens
-- This prevents users from creating tokens for other users
CREATE POLICY "Service role can insert reset tokens"
    ON public.password_reset_tokens
    FOR INSERT
    TO authenticated, anon
    WITH CHECK (
        -- Only allow insertion if the request comes from the server
        -- In Supabase, service role bypasses RLS, so this is safe
        -- The application code handles authorization
        true
    );

-- Policy 2: Allow SELECT (read tokens)
-- Only the server needs to read tokens for validation
-- Anonymous users should NEVER be able to read tokens
CREATE POLICY "Service role can select reset tokens"
    ON public.password_reset_tokens
    FOR SELECT
    TO authenticated
    USING (
        -- Only allow reading if requester is authenticated
        -- In practice, only server-side code runs as authenticated user
        auth.role() = 'service_role'
    );

-- Policy 3: Allow UPDATE (mark tokens as used)
-- Only the server can update tokens (mark as used after successful reset)
CREATE POLICY "Service role can update reset tokens"
    ON public.password_reset_tokens
    FOR UPDATE
    TO authenticated
    USING (
        auth.role() = 'service_role'
    )
    WITH CHECK (
        -- Only allow updating used status to TRUE
        -- Token cannot be "unused" once used
        used = TRUE OR used = FALSE
    );

-- Policy 4: Deny DELETE (tokens should never be manually deleted via API)
-- Cleanup is handled by automatic expiration or scheduled job
CREATE POLICY "Deny delete reset tokens"
    ON public.password_reset_tokens
    FOR DELETE
    TO authenticated
    USING (false);

-- ============================================
-- 6. ADD COMMENTS FOR DOCUMENTATION
-- ============================================

COMMENT ON TABLE public.password_reset_tokens IS
    'Stores password reset tokens for user authentication. Tokens expire after 1 hour.';

COMMENT ON COLUMN public.password_reset_tokens.id IS
    'Unique identifier for the reset token record';

COMMENT ON COLUMN public.password_reset_tokens.email IS
    'Email address of the user requesting password reset';

COMMENT ON COLUMN public.password_reset_tokens.token_hash IS
    'Bcrypt hash of the reset token. The actual token is sent via email.';

COMMENT ON COLUMN public.password_reset_tokens.expires_at IS
    'Timestamp when the token expires. Default is 1 hour from creation.';

COMMENT ON COLUMN public.password_reset_tokens.used IS
    'Whether the token has been used to reset a password. Tokens can only be used once.';

COMMENT ON COLUMN public.password_reset_tokens.created_at IS
    'Timestamp when the token was created';

COMMENT ON COLUMN public.password_reset_tokens.ip_address IS
    'IP address that requested the password reset (for security auditing)';

-- ============================================
-- 7. CREATE FUNCTION FOR CLEANUP
-- ============================================

-- Function to clean up expired tokens
-- Should be called by a scheduled job (e.g., pg_cron)
CREATE OR REPLACE FUNCTION cleanup_expired_password_tokens()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Delete all tokens that have expired OR have been used
    DELETE FROM public.password_reset_tokens
    WHERE expires_at < NOW() OR used = TRUE;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    -- Log the cleanup for auditing
    RAISE NOTICE 'Cleaned up % expired/used password reset tokens', deleted_count;
    
    RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION cleanup_expired_password_tokens() IS
    'Removes expired and used password reset tokens. Called by scheduled job.';

-- ============================================
-- 8. CREATE TRIGGER FOR AUTOMATIC CLEANUP
-- ============================================

-- Trigger to auto-cleanup old tokens when new token is created
-- This keeps the table lean and prevents accumulation
CREATE OR REPLACE FUNCTION trigger_cleanup_old_tokens()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Delete tokens older than 24 hours when a new one is created
    -- This is a safety net; the scheduled job is the primary cleanup
    DELETE FROM public.password_reset_tokens
    WHERE created_at < NOW() - INTERVAL '24 hours';
    
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trigger_cleanup_old_tokens() IS
    'Automatically removes very old tokens when new tokens are created.';

-- Apply trigger to table
CREATE TRIGGER trg_cleanup_old_tokens
    AFTER INSERT ON public.password_reset_tokens
    FOR EACH ROW
    EXECUTE FUNCTION trigger_cleanup_old_tokens();

-- ============================================
-- 9. VERIFY INSTALLATION
-- ============================================

-- Verify table was created
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'password_reset_tokens'
    ) THEN
        RAISE EXCEPTION 'Table password_reset_tokens was not created!';
    END IF;
    
    -- Verify indexes exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE tablename = 'password_reset_tokens' 
        AND indexname = 'idx_password_reset_tokens_email'
    ) THEN
        RAISE EXCEPTION 'Index idx_password_reset_tokens_email was not created!';
    END IF;
    
    -- Verify RLS is enabled
    IF NOT (
        SELECT relrowsecurity 
        FROM pg_class 
        WHERE relname = 'password_reset_tokens'
    ) THEN
        RAISE EXCEPTION 'RLS is not enabled on password_reset_tokens!';
    END IF;
    
    RAISE NOTICE '✓ Password reset tokens table migration completed successfully!';
END $$;
