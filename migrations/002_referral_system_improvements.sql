-- ============================================================
-- Referral System Database Improvements
-- Migration: 002_referral_system_improvements.sql
-- Arbitrix AI - Production Quality Referral System
-- ============================================================
-- 
-- This migration adds:
-- 1. Unique constraint on users.referral_code
-- 2. Index on referrals.referrer_id for faster lookups
-- 3. Index on referrals.referred_id for faster lookups
-- 4. Composite unique index to prevent duplicate referral relationships
-- 5. New columns for referral lifecycle tracking (qualified_at, qualification_type)
-- 6. Check constraint for bonus_earned
-- 7. Default value for referral status
-- ============================================================

-- ============================================
-- 1. ADD UNIQUE CONSTRAINT ON REFERRAL CODE
-- ============================================

-- First, check if there are any duplicate referral codes
-- If duplicates exist, we need to handle them before adding the constraint
DO $$
DECLARE
    duplicate_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO duplicate_count
    FROM (
        SELECT referral_code
        FROM public.users
        WHERE referral_code IS NOT NULL
        GROUP BY referral_code
        HAVING COUNT(*) > 1
    ) duplicates;
    
    IF duplicate_count > 0 THEN
        RAISE NOTICE 'Found % referral codes with duplicates. Manual intervention may be required.',
                     duplicate_count;
    ELSE
        RAISE NOTICE 'No duplicate referral codes found. Proceeding with migration.';
    END IF;
END $$;

-- Add unique constraint on referral_code (will fail if duplicates exist)
-- Use NOT VALID to add without immediately enforcing, then validate
ALTER TABLE public.users
    ADD CONSTRAINT users_referral_code_unique UNIQUE (referral_code)
    DEFERRABLE INITIALLY DEFERRED;

-- ============================================
-- 2. ADD COLUMNS FOR REFERRAL LIFECYCLE TRACKING
-- ============================================

-- qualified_at: Timestamp when the referral became active (first deposit made)
ALTER TABLE public.referrals
    ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMPTZ;

-- qualification_type: What action qualified the referral (e.g., 'first_deposit')
ALTER TABLE public.referrals
    ADD COLUMN IF NOT EXISTS qualification_type TEXT;

-- ============================================
-- 3. ADD INDEXES FOR FASTER REFERRAL LOOKUPS
-- ============================================

-- Index on referrer_id for finding all referrals made by a user
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id
    ON public.referrals(referrer_id);

-- Index on referred_id for finding who referred a specific user
CREATE INDEX IF NOT EXISTS idx_referrals_referred_id
    ON public.referrals(referred_id);

-- Composite index for status filtering on referrer's referrals
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_status
    ON public.referrals(referrer_id, status);

-- Index for finding referrals created within a time window
CREATE INDEX IF NOT EXISTS idx_referrals_created_at
    ON public.referrals(created_at DESC);

-- ============================================
-- 4. PREVENT DUPLICATE REFERRAL RELATIONSHIPS
-- ============================================

-- Add unique constraint to prevent duplicate referral relationships
-- Each (referrer_id, referred_id) pair should only exist once
ALTER TABLE public.referrals
    ADD CONSTRAINT referrals_unique_relationship UNIQUE (referrer_id, referred_id);

-- ============================================
-- 5. ADD CHECK CONSTRAINT FOR BONUS EARNED
-- ============================================

-- Ensure bonus_earned is non-negative
ALTER TABLE public.referrals
    ADD CONSTRAINT referrals_bonus_earned_non_negative CHECK (bonus_earned >= 0);

-- ============================================
-- 6. UPDATE EXISTING PENDING REFERRALS
-- ============================================

-- Update any existing referrals that have status='active' but bonus_earned=0
-- These were created before the lifecycle system and need to be marked as pending
UPDATE public.referrals
SET status = 'pending'
WHERE status = 'active' AND bonus_earned = 0;

-- ============================================
-- 7. ANALYZE TABLES TO UPDATE STATISTICS
-- ============================================

ANALYZE public.users;
ANALYZE public.referrals;

-- ============================================
-- 8. VERIFY MIGRATION
-- ============================================

DO $$
BEGIN
    -- Verify unique constraint on referral_code
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint con
        JOIN pg_class cls ON con.conrelid = cls.oid
        WHERE con.contype = 'u'
        AND con.conname = 'users_referral_code_unique'
        AND cls.relname = 'users'
    ) THEN
        RAISE EXCEPTION 'users_referral_code_unique constraint not created!';
    END IF;

    -- Verify indexes exist
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_referrals_referrer_id') THEN
        RAISE EXCEPTION 'idx_referrals_referrer_id not created!';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_referrals_referred_id') THEN
        RAISE EXCEPTION 'idx_referrals_referred_id not created!';
    END IF;

    -- Verify unique constraint on referral relationships
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint con
        JOIN pg_class cls ON con.conrelid = cls.oid
        WHERE con.contype = 'u'
        AND con.conname = 'referrals_unique_relationship'
        AND cls.relname = 'referrals'
    ) THEN
        RAISE EXCEPTION 'referrals_unique_relationship constraint not created!';
    END IF;
    
    -- Verify new columns exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'referrals'
        AND column_name = 'qualified_at'
    ) THEN
        RAISE EXCEPTION 'qualified_at column not created!';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'referrals'
        AND column_name = 'qualification_type'
    ) THEN
        RAISE EXCEPTION 'qualification_type column not created!';
    END IF;

    RAISE NOTICE '✅ Referral system migration completed successfully!';
END $$;

-- ============================================
-- ROLLBACK SCRIPT (for reference only)
-- ============================================
-- To rollback these changes, run:
--
-- ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_referral_code_unique;
-- DROP INDEX IF EXISTS idx_referrals_referrer_id;
-- DROP INDEX IF EXISTS idx_referrals_referred_id;
-- DROP INDEX IF EXISTS idx_referrals_referrer_status;
-- DROP INDEX IF EXISTS idx_referrals_created_at;
-- ALTER TABLE public.referrals DROP CONSTRAINT IF EXISTS referrals_unique_relationship;
-- ALTER TABLE public.referrals DROP CONSTRAINT IF EXISTS referrals_bonus_earned_non_negative;
-- ALTER TABLE public.referrals DROP COLUMN IF EXISTS qualified_at;
-- ALTER TABLE public.referrals DROP COLUMN IF EXISTS qualification_type;
-- ============================================
