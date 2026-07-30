-- ============================================================
-- Supabase Row Level Security Policies for Arbitrix App
-- ============================================================
-- This file contains the RLS policies needed for the Arbitrix
-- application to work with the anon key.
--
-- IMPORTANT: This application uses a CUSTOM JWT auth system (not Supabase Auth).
-- Therefore, auth.uid() will NOT work - all requests use the 'anon' role.
-- 
-- Security model:
-- - The Express server holds the anon key and validates all requests
-- - Custom JWT tokens are used for user authentication
-- - RLS policies must allow operations for the 'anon' role
-- - Server-side validation ensures security
--
-- IMPORTANT: These policies assume the following table structure:
-- - users (id, name, email, password_hash, referral_code, is_admin, created_at)
-- - wallets (id, user_id, demo_balance, live_balance, bonus_balance)
-- - transactions (id, user_id, type, amount, detail, created_at)
-- - referrals (id, referrer_id, referred_id, bonus_earned, created_at)
-- - deposits (id, user_id, amount, network, address, invoice_id, status, created_at)
-- - withdrawals (id, user_id, amount, address, status, created_at)
-- - bot_sessions (user_id, is_running, mode, started_at)
-- ============================================================

-- ============================================================
-- USERS TABLE POLICIES
-- ============================================================

-- Allow anonymous users to INSERT (for signup)
-- Security: The server validates all input and sets is_admin=0
CREATE OR REPLACE POLICY "Allow anonymous signup on users"
ON public.users
FOR INSERT
TO anon
WITH CHECK (true);

-- Allow anon to SELECT users (needed for login validation and referral lookups)
CREATE OR REPLACE POLICY "Allow anonymous select on users"
ON public.users
FOR SELECT
TO anon
USING (true);

-- Allow anon to UPDATE users (needed for profile updates)
-- Security: Server validates that users can only update their own data
CREATE OR REPLACE POLICY "Allow anonymous update on users"
ON public.users
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- WALLETS TABLE POLICIES
-- ============================================================

-- Allow INSERT on wallets (called after user creation)
CREATE OR REPLACE POLICY "Allow wallet insert on wallets"
ON public.wallets
FOR INSERT
TO anon
WITH CHECK (true);

-- Allow SELECT on wallets
CREATE OR REPLACE POLICY "Allow wallet select on wallets"
ON public.wallets
FOR SELECT
TO anon
USING (true);

-- Allow UPDATE on wallets (for balance updates)
CREATE OR REPLACE POLICY "Allow wallet update on wallets"
ON public.wallets
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- TRANSACTIONS TABLE POLICIES
-- ============================================================

-- Allow INSERT on transactions
CREATE OR REPLACE POLICY "Allow transaction insert on transactions"
ON public.transactions
FOR INSERT
TO anon
WITH CHECK (true);

-- Allow SELECT on transactions
CREATE OR REPLACE POLICY "Allow transaction select on transactions"
ON public.transactions
FOR SELECT
TO anon
USING (true);

-- ============================================================
-- REFERRALS TABLE POLICIES
-- ============================================================

-- Allow INSERT on referrals
CREATE OR REPLACE POLICY "Allow referral insert on referrals"
ON public.referrals
FOR INSERT
TO anon
WITH CHECK (true);

-- Allow SELECT on referrals
CREATE OR REPLACE POLICY "Allow referral select on referrals"
ON public.referrals
FOR SELECT
TO anon
USING (true);

-- ============================================================
-- DEPOSITS TABLE POLICIES
-- ============================================================

-- Allow INSERT on deposits
CREATE OR REPLACE POLICY "Allow deposit insert on deposits"
ON public.deposits
FOR INSERT
TO anon
WITH CHECK (true);

-- Allow SELECT on deposits
CREATE OR REPLACE POLICY "Allow deposit select on deposits"
ON public.deposits
FOR SELECT
TO anon
USING (true);

-- Allow UPDATE on deposits (for status changes)
CREATE OR REPLACE POLICY "Allow deposit update on deposits"
ON public.deposits
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- WITHDRAWALS TABLE POLICIES
-- ============================================================

-- Allow INSERT on withdrawals
CREATE OR REPLACE POLICY "Allow withdrawal insert on withdrawals"
ON public.withdrawals
FOR INSERT
TO anon
WITH CHECK (true);

-- Allow SELECT on withdrawals
CREATE OR REPLACE POLICY "Allow withdrawal select on withdrawals"
ON public.withdrawals
FOR SELECT
TO anon
USING (true);

-- Allow UPDATE on withdrawals (for status changes)
CREATE OR REPLACE POLICY "Allow withdrawal update on withdrawals"
ON public.withdrawals
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- BOT_SESSIONS TABLE POLICIES
-- ============================================================

-- Allow INSERT on bot_sessions
CREATE OR REPLACE POLICY "Allow bot session insert on bot_sessions"
ON public.bot_sessions
FOR INSERT
TO anon
WITH CHECK (true);

-- Allow SELECT on bot_sessions
CREATE OR REPLACE POLICY "Allow bot session select on bot_sessions"
ON public.bot_sessions
FOR SELECT
TO anon
USING (true);

-- Allow UPDATE on bot_sessions (for start/stop)
CREATE OR REPLACE POLICY "Allow bot session update on bot_sessions"
ON public.bot_sessions
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- VERIFICATION QUERIES (run these in SQL Editor)
-- ============================================================

-- Check existing policies on a table:
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE tablename = 'users';

-- Check if RLS is enabled:
-- SELECT relname, relrowsecurity FROM pg_class 
-- WHERE relname IN ('users', 'wallets', 'transactions', 'referrals', 'deposits', 'withdrawals', 'bot_sessions');

-- Drop all policies if you need to start fresh:
-- DROP POLICY IF EXISTS "Allow anonymous signup on users" ON public.users;
-- (run similar commands for each policy)
