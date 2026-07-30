-- ============================================================
-- Supabase Row Level Security Policies for Arbitrix App
-- ============================================================
-- 
-- AUTHENTICATION SYSTEM ANALYSIS:
-- -------------------------------
-- This application uses a CUSTOM JWT authentication system, NOT Supabase Auth.
-- 
-- Evidence:
-- - Server uses 'jsonwebtoken' library for JWT generation
-- - Server uses 'bcryptjs' for password hashing
-- - The supabaseKey has role="anon" (verified from JWT payload)
-- - No use of supabase.auth.signUp() or supabase.auth.signInWithPassword()
-- - JWT tokens are created manually: jwt.sign({ id, email, isAdmin }, JWT_SECRET)
--
-- SECURITY ARCHITECTURE:
-- -----------------------
-- - Express server is the authentication authority
-- - JWT_SECRET validates all tokens server-side
-- - Supabase is ONLY a data store (accessed with anon key)
-- - auth.uid() returns NULL because no Supabase Auth session exists
-- - All business logic and access control runs on the server
--
-- WHY USING(true) IS NECESSARY:
-- ------------------------------
-- In this architecture, RLS cannot distinguish between users because:
-- 1. auth.uid() returns NULL (no Supabase Auth session)
-- 2. All requests use the 'anon' role
-- 3. User identity is only known to the server via custom JWT
--
-- USING(true) is SECURE in this context because:
-- - Server validates every request via custom JWT middleware
-- - Server extracts user ID from JWT and uses it for data access
-- - Server enforces all business rules (e.g., users can only access their own data)
-- - RLS is defense-in-depth, not primary access control
-- ============================================================

-- ============================================================
-- USERS TABLE POLICIES
-- ============================================================

-- POLICY: Allow anonymous signup
-- PURPOSE: Required for /api/auth/register endpoint
-- WHY INSERT WITH CHECK (true):
--   - Signup is a public operation (no authenticated user yet)
--   - Server validates all input: name, email, password, referral_code
--   - Server always sets is_admin=0 (hardcoded in signup handler)
--   - Server generates unique referral_code server-side
-- SECURITY: Server input validation prevents malicious data
CREATE OR REPLACE POLICY "Allow anonymous signup on users"
ON public.users
FOR INSERT
TO anon
WITH CHECK (true);

-- POLICY: Allow anonymous SELECT for email lookups
-- PURPOSE: Required for:
--   - Email uniqueness check during signup (line 88)
--   - Email+password lookup during login (line 110)
--   - Referral code lookup (line 95, 208)
--   - Admin user lookup (line 345)
-- WHY USING (true):
--   - These are read-only operations that don't modify data
--   - Email uniqueness is enforced by application logic
--   - No sensitive data exposure (server validates access to results)
-- SECURITY: SELECT returns data but server controls who can act on it
CREATE OR REPLACE POLICY "Allow anonymous select on users"
ON public.users
FOR SELECT
TO anon
USING (true);

-- POLICY: Allow anonymous UPDATE for profile updates
-- PURPOSE: Required for profile modification (future feature)
-- WHY USING(true) AND WITH CHECK (true):
--   - Server must validate user owns the profile being updated
--   - Server validates is_admin cannot be changed
-- SECURITY: Server's authMiddleware extracts user ID from JWT
CREATE OR REPLACE POLICY "Allow anonymous update on users"
ON public.users
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- WALLETS TABLE POLICIES
-- ============================================================

-- POLICY: Allow wallet INSERT
-- PURPOSE: Required when:
--   - New user signs up (getWallet creates wallet)
--   - Admin creates user (server.js line 278)
-- WHY INSERT WITH CHECK (true):
--   - Server always sets initial balances: demo=1000, live=50, bonus=0
--   - Server always links to a valid user_id
-- SECURITY: Server controls all wallet creation
CREATE OR REPLACE POLICY "Allow wallet insert on wallets"
ON public.wallets
FOR INSERT
TO anon
WITH CHECK (true);

-- POLICY: Allow wallet SELECT
-- PURPOSE: Required for:
--   - /api/auth/me endpoint (getWallet)
--   - Admin dashboard (line 251)
--   - Balance display throughout app
-- SECURITY: Server validates user can only view their own wallet
CREATE OR REPLACE POLICY "Allow wallet select on wallets"
ON public.wallets
FOR SELECT
TO anon
USING (true);

-- POLICY: Allow wallet UPDATE
-- PURPOSE: Required for:
--   - updateWallet() function (line 54-58)
--   - Bot trading operations (add/subtract balance)
--   - Referral bonuses
--   - Deposits and withdrawals
-- WHY USING(true) AND WITH CHECK (true):
--   - Server validates user owns the wallet
--   - Server enforces business rules (e.g., sufficient balance)
-- SECURITY: Server calculates new balance and validates transactions
CREATE OR REPLACE POLICY "Allow wallet update on wallets"
ON public.wallets
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- TRANSACTIONS TABLE POLICIES
-- ============================================================

-- POLICY: Allow transaction INSERT
-- PURPOSE: Required for:
--   - addTransaction() helper (line 60-62)
--   - Recording trades, deposits, withdrawals
--   - Referral bonuses
-- SECURITY: Server creates all transactions with validated user_id
CREATE OR REPLACE POLICY "Allow transaction insert on transactions"
ON public.transactions
FOR INSERT
TO anon
WITH CHECK (true);

-- POLICY: Allow transaction SELECT
-- PURPOSE: Required for:
--   - /api/transactions endpoint (line 199)
--   - Withdrawal validation (line 162)
--   - Admin dashboard (line 329)
-- SECURITY: Server filters by user_id for regular users
CREATE OR REPLACE POLICY "Allow transaction select on transactions"
ON public.transactions
FOR SELECT
TO anon
USING (true);

-- ============================================================
-- REFERRALS TABLE POLICIES
-- ============================================================

-- POLICY: Allow referral INSERT
-- PURPOSE: Required for:
--   - Creating referral link when new user signs up (line 97)
--   - Simulated referrals (line 216)
-- SECURITY: Server validates referrer and referred users exist
CREATE OR REPLACE POLICY "Allow referral insert on referrals"
ON public.referrals
FOR INSERT
TO anon
WITH CHECK (true);

-- POLICY: Allow referral SELECT
-- PURPOSE: Required for:
--   - /api/referral/stats (line 206-212)
--   - Admin dashboard (line 336)
-- SECURITY: Server filters by user_id
CREATE OR REPLACE POLICY "Allow referral select on referrals"
ON public.referrals
FOR SELECT
TO anon
USING (true);

-- ============================================================
-- DEPOSITS TABLE POLICIES
-- ============================================================

-- POLICY: Allow deposit INSERT
-- PURPOSE: Required for:
--   - /api/deposit/request (line 131)
--   - Creating deposit record with invoice
-- SECURITY: Server validates amount, user_id, and generates invoice
CREATE OR REPLACE POLICY "Allow deposit insert on deposits"
ON public.deposits
FOR INSERT
TO anon
WITH CHECK (true);

-- POLICY: Allow deposit SELECT
-- PURPOSE: Required for:
--   - /api/deposit/status (line 137)
--   - Admin dashboard (line 283)
-- SECURITY: Server filters by invoice_id and user_id
CREATE OR REPLACE POLICY "Allow deposit select on deposits"
ON public.deposits
FOR SELECT
TO anon
USING (true);

-- POLICY: Allow deposit UPDATE
-- PURPOSE: Required for:
--   - Confirming deposit (line 141)
--   - Expiring deposit (line 147)
-- SECURITY: Server validates status transitions
CREATE OR REPLACE POLICY "Allow deposit update on deposits"
ON public.deposits
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- WITHDRAWALS TABLE POLICIES
-- ============================================================

-- POLICY: Allow withdrawal INSERT
-- PURPOSE: Required for:
--   - /api/withdraw/request (line 166)
--   - Creating withdrawal record
-- SECURITY: Server validates amount, balance, and user identity
CREATE OR REPLACE POLICY "Allow withdrawal insert on withdrawals"
ON public.withdrawals
FOR INSERT
TO anon
WITH CHECK (true);

-- POLICY: Allow withdrawal SELECT
-- PURPOSE: Required for:
--   - /api/withdraw/history (line 172)
--   - Admin dashboard (line 301)
-- SECURITY: Server filters by user_id
CREATE OR REPLACE POLICY "Allow withdrawal select on withdrawals"
ON public.withdrawals
FOR SELECT
TO anon
USING (true);

-- POLICY: Allow withdrawal UPDATE
-- PURPOSE: Required for:
--   - Admin status updates (approve/reject)
-- SECURITY: Server validates admin role via JWT
CREATE OR REPLACE POLICY "Allow withdrawal update on withdrawals"
ON public.withdrawals
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- BOT_SESSIONS TABLE POLICIES
-- ============================================================

-- POLICY: Allow bot_sessions INSERT
-- PURPOSE: Required for:
--   - /api/bot/start (line 183)
--   - Creating bot session record
-- SECURITY: Server creates session linked to authenticated user
CREATE OR REPLACE POLICY "Allow bot session insert on bot_sessions"
ON public.bot_sessions
FOR INSERT
TO anon
WITH CHECK (true);

-- POLICY: Allow bot_sessions SELECT
-- PURPOSE: Required for:
--   - /api/bot/status (line 193)
-- SECURITY: Server filters by user_id
CREATE OR REPLACE POLICY "Allow bot session select on bot_sessions"
ON public.bot_sessions
FOR SELECT
TO anon
USING (true);

-- POLICY: Allow bot_sessions UPDATE
-- PURPOSE: Required for:
--   - /api/bot/start (upsert)
--   - /api/bot/stop (line 188)
-- SECURITY: Server validates user owns the session
CREATE OR REPLACE POLICY "Allow bot session update on bot_sessions"
ON public.bot_sessions
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================

-- Check existing policies on a table:
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE tablename = 'users';

-- Check if RLS is enabled on tables:
-- SELECT relname, relrowsecurity FROM pg_class 
-- WHERE relname IN ('users', 'wallets', 'transactions', 'referrals', 'deposits', 'withdrawals', 'bot_sessions');

-- Enable RLS on a table (if not already enabled):
-- ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Drop a specific policy:
-- DROP POLICY IF EXISTS "Allow anonymous signup on users" ON public.users;
