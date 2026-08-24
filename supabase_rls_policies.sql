-- ============================================================
-- *** QUARANTINED — DO NOT APPLY TO PRODUCTION ***
-- ============================================================
--
-- This is a HISTORICAL LEGACY policy file, retained for reference ONLY.
--
--   * It creates the OLD PERMISSIVE "TO anon" policies (USING (true) /
--     WITH CHECK (true)) that RE-OPEN anonymous read/write access to the
--     production tables (users, wallets, transactions, referrals,
--     deposits, withdrawals, bot_sessions).
--   * Migration 018 (supabase/migrations/018_financial_tables_rls_lockdown.sql)
--     INTENTIONALLY REMOVES those 19 legacy anon policies and replaces them
--     with service-role-only policies. Re-applying this file would silently
--     undo that lockdown.
--   * Historical revisions of this legacy file also carried an OUTDATED
--     Paymento function definition, superseded by the migration history;
--     do not resurrect it from here.
--   * Current production security is managed EXCLUSIVELY by the migration
--     history under supabase/migrations/ (in particular the 014-018
--     lockdown migrations). This file is NOT part of that chain.
--
-- THIS FILE MUST NOT BE EXECUTED AGAINST PRODUCTION (or any live
-- environment). Do not run it in the Supabase SQL Editor, do not pipe it
-- through psql, and do not reference it from deployment tooling.
-- ============================================================

-- ============================================================
-- Supabase Row Level Security Policies for Arbitrix App
-- ============================================================
-- 
-- AUTHENTICATION SYSTEM: CUSTOM JWT (NOT Supabase Auth)
-- 
-- This application uses a custom JWT authentication system where:
-- - Express server is the authentication authority
-- - JWT_SECRET validates all tokens server-side
-- - Supabase is ONLY a data store (accessed with anon key)
-- - auth.uid() returns NULL because no Supabase Auth session exists
-- - All business logic and access control runs on the server
--
-- SECURITY MODEL:
-- The Express server validates every request via custom JWT middleware.
-- RLS policies allow operations for the 'anon' role because the server
-- handles all authentication. USING(true) is safe because server validates
-- all input and enforces business rules before any database operation.
-- ============================================================

-- ============================================================
-- ENABLE ROW LEVEL SECURITY ON ALL TABLES
-- ============================================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_sessions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- USERS TABLE POLICIES
-- ============================================================

-- Drop existing policies first (idempotent)
DROP POLICY IF EXISTS "Allow anonymous signup on users" ON public.users;
DROP POLICY IF EXISTS "Allow anonymous select on users" ON public.users;
DROP POLICY IF EXISTS "Allow anonymous update on users" ON public.users;

-- Allow INSERT for signup (public registration)
CREATE POLICY "Allow anonymous signup on users"
ON public.users
FOR INSERT
TO anon
WITH CHECK (true);

-- Allow SELECT for email lookups (login, referral checks)
CREATE POLICY "Allow anonymous select on users"
ON public.users
FOR SELECT
TO anon
USING (true);

-- Allow UPDATE for profile changes
CREATE POLICY "Allow anonymous update on users"
ON public.users
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- WALLETS TABLE POLICIES
-- ============================================================

DROP POLICY IF EXISTS "Allow wallet insert on wallets" ON public.wallets;
DROP POLICY IF EXISTS "Allow wallet select on wallets" ON public.wallets;
DROP POLICY IF EXISTS "Allow wallet update on wallets" ON public.wallets;

CREATE POLICY "Allow wallet insert on wallets"
ON public.wallets
FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY "Allow wallet select on wallets"
ON public.wallets
FOR SELECT
TO anon
USING (true);

CREATE POLICY "Allow wallet update on wallets"
ON public.wallets
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- TRANSACTIONS TABLE POLICIES
-- ============================================================

DROP POLICY IF EXISTS "Allow transaction insert on transactions" ON public.transactions;
DROP POLICY IF EXISTS "Allow transaction select on transactions" ON public.transactions;

CREATE POLICY "Allow transaction insert on transactions"
ON public.transactions
FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY "Allow transaction select on transactions"
ON public.transactions
FOR SELECT
TO anon
USING (true);

-- ============================================================
-- REFERRALS TABLE POLICIES
-- ============================================================

DROP POLICY IF EXISTS "Allow referral insert on referrals" ON public.referrals;
DROP POLICY IF EXISTS "Allow referral select on referrals" ON public.referrals;

CREATE POLICY "Allow referral insert on referrals"
ON public.referrals
FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY "Allow referral select on referrals"
ON public.referrals
FOR SELECT
TO anon
USING (true);

-- ============================================================
-- DEPOSITS TABLE POLICIES
-- ============================================================

DROP POLICY IF EXISTS "Allow deposit insert on deposits" ON public.deposits;
DROP POLICY IF EXISTS "Allow deposit select on deposits" ON public.deposits;
DROP POLICY IF EXISTS "Allow deposit update on deposits" ON public.deposits;

CREATE POLICY "Allow deposit insert on deposits"
ON public.deposits
FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY "Allow deposit select on deposits"
ON public.deposits
FOR SELECT
TO anon
USING (true);

CREATE POLICY "Allow deposit update on deposits"
ON public.deposits
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- WITHDRAWALS TABLE POLICIES
-- ============================================================

DROP POLICY IF EXISTS "Allow withdrawal insert on withdrawals" ON public.withdrawals;
DROP POLICY IF EXISTS "Allow withdrawal select on withdrawals" ON public.withdrawals;
DROP POLICY IF EXISTS "Allow withdrawal update on withdrawals" ON public.withdrawals;

CREATE POLICY "Allow withdrawal insert on withdrawals"
ON public.withdrawals
FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY "Allow withdrawal select on withdrawals"
ON public.withdrawals
FOR SELECT
TO anon
USING (true);

CREATE POLICY "Allow withdrawal update on withdrawals"
ON public.withdrawals
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- BOT_SESSIONS TABLE POLICIES
-- ============================================================

DROP POLICY IF EXISTS "Allow bot session insert on bot_sessions" ON public.bot_sessions;
DROP POLICY IF EXISTS "Allow bot session select on bot_sessions" ON public.bot_sessions;
DROP POLICY IF EXISTS "Allow bot session update on bot_sessions" ON public.bot_sessions;

CREATE POLICY "Allow bot session insert on bot_sessions"
ON public.bot_sessions
FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY "Allow bot session select on bot_sessions"
ON public.bot_sessions
FOR SELECT
TO anon
USING (true);

CREATE POLICY "Allow bot session update on bot_sessions"
ON public.bot_sessions
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- ============================================================
-- VERIFICATION: Run these to check policies
-- ============================================================

-- Check policies on a table:
-- SELECT policyname, cmd, permissive, roles, qual, with_check
-- FROM pg_policies WHERE tablename = 'users';

-- Check RLS is enabled:
-- SELECT relname, relrowsecurity FROM pg_class
-- WHERE relname IN ('users', 'wallets', 'transactions', 'referrals', 'deposits', 'withdrawals', 'bot_sessions');
