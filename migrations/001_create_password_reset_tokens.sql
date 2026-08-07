-- Migration: Create password_reset_tokens table
-- Date: 2024-08-01
-- Purpose: Store secure password reset tokens

-- Create the password_reset_tokens table
CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for faster lookups by email
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email 
ON public.password_reset_tokens(email);

-- Create index for faster lookups by token hash
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash 
ON public.password_reset_tokens(token_hash);

-- Create index for finding unused tokens
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_used 
ON public.password_reset_tokens(used) WHERE used = FALSE;

-- Enable Row Level Security
ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;

-- Policy: Allow anyone to insert tokens (API handles validation)
CREATE POLICY "Anyone can insert reset tokens" ON public.password_reset_tokens
    FOR INSERT WITH CHECK (true);

-- Policy: Allow anyone to update tokens (mark as used)
CREATE POLICY "Anyone can update reset tokens" ON public.password_reset_tokens
    FOR UPDATE USING (true);

-- Policy: Allow anyone to select tokens (for verification)
CREATE POLICY "Anyone can view tokens" ON public.password_reset_tokens
    FOR SELECT USING (true);

-- Policy: Allow anyone to delete tokens
CREATE POLICY "Anyone can delete tokens" ON public.password_reset_tokens
    FOR DELETE USING (true);

-- Add comment for documentation
COMMENT ON TABLE public.password_reset_tokens IS 
    'Stores one-time use password reset tokens. Tokens are hashed before storage for security.';
