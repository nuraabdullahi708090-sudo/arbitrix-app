-- ============================================
-- Meta Event Claims (once-per-user server-side claim ledger)
-- Arbitrix AI — Marketing/Live-activation conversion tracking
-- ============================================
--
-- Purpose: durable, server-authoritative once-per-account guard for
-- one-shot marketing conversion events (currently: LiveAccountActivated).
-- The client may never decide alone whether an event has fired; each user+event
-- can hold exactly ONE claim row, written by the server on the first authoritative
-- confirmation (e.g. first confirmed real deposit via hasConfirmedDeposit). A
-- later attempt (page reload, log back in, new device, localStorage cleared)
-- insert collides with the UNIQUE(event_name, user_id) constraint (Postgres raises
-- 23505, which the server treats as a no-op claimed=>false). No amounts,
-- balances, user PII, wallet data, transaction
-- data — only the fact "this user claimed this conversion event".
--
-- Security model: RLS-is disabled and service-role-only writes, matching the
-- existing BIGINT-user_id tables (subscriptions, trades, payment_invoices:
 no
-- auth.uid()-based RLS is possible because this app uses custom JWT auth.) The
-- endpoint that inserts rows is authMiddleware-guarded andre-verifies the caller's
-- PRODUCTION environment before any write.
-- ============================================

-- ============================================
-- 1. META_EVENT_CLAIMS (once-per-user-per-event)
-- ============================================
CREATE TABLE IF NOT EXISTS public.meta_event_claims (
    id BIGSERIAL PRIMARY KEY,
    event_name TEXT NOT NULL CHECK (event_name IN ('LiveAccountActivated')),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    -- PRODUCTION-only by design: MARKETING_SANDBOX demos never claim.
    environment TEXT NOT NULL DEFAULT 'PRODUCTION'
        CHECK (environment IN ('PRODUCTION', 'MARKETING_SANDBOX')),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Once-per-user-per-event: a second claim attempt is a no-op.
    UNIQUE (event_name, user_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_event_claims_user
    ON public.meta_event_claims(user_id);

COMMENT ON TABLE public.meta_event_claims IS
    'Durable once-per-user-per-event server-side claim ledger for one-shot conversion events (no PII, no amounts, no balances).';
COMMENT ON COLUMN public.meta_event_claims.environment IS
    'Immutable account environment at claim time (PRODUCTION only ever written by the endpoint; MARKETING_SANDBOX accounts never claim).';
COMMENT ON COLUMN public.meta_event_claims.event_name IS
    'Conversion event identifier (extendable: future events add values here).';