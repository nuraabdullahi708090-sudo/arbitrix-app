-- 054_grandfather_activation.sql
--
-- COMPLIMENTARY LIVE ACTIVATION FOR PRE-LAUNCH FUNDED CUSTOMERS.
--
-- WHY
--   Activating the Payhip gate would stop every existing customer from trading
--   Live until they buy a $50 activation - including the handful who already
--   funded an account with a real deposit. This migration lets those customers
--   keep what they already paid for, through a FROZEN snapshot taken before the
--   gate is switched on.
--
-- WHAT COUNTS AS FUNDED
--   Exactly the resolver's own definition (server.js getConfirmedDepositTotal):
--       GREATEST(SUM(deposits.amount WHERE status='confirmed'),
--                SUM(payment_invoices.amount_usd WHERE status='confirmed'))
--       >= 100
--   NOT the sum of the two, NOT live_balance (wallet creation seeds $50 of
--   promotional credit, so a positive balance proves nothing), NOT trading
--   history, NOT account age.
--
-- ARCHITECTURE CHOICE (and why no purchase row is created)
--   A paid activation must stay a paid activation. The alternative design - a
--   synthetic payhip_purchases row with price_cents = 0 and status = 'paid' -
--   would put a non-payment into the revenue ledger and into every
--   reconciliation that reads payhip_purchases, so it is rejected.
--   Instead payhip_entitlements gains an explicit `source`:
--       'payhip'                        a real, verified sale (unchanged)
--       'grandfathered_funded_customer' a complimentary grant, no purchase,
--                                       no licence key, no money
--   purchase_id and licence_key_hash become NULLABLE for non-Payhip rows only,
--   enforced by a CHECK that keeps every 'payhip' row exactly as strict as
--   before. The resolver keeps ONE code path and the worker gate needs no
--   change, because both call payhip_has_live_activation().
--
-- SAFETY
--   - Nothing here is executed by the application. No runtime code calls these
--     functions; an operator runs them deliberately (scripts/grandfather-activation.js).
--   - The snapshot is frozen: membership is materialised into a table at
--     snapshot time, so a deposit made afterwards can never join it.
--   - One grant per account, ever: a partial unique index on (user_id, source)
--     for non-Payhip sources plus ON CONFLICT DO NOTHING.
--   - A Payhip refund/chargeback cannot revoke a grant: the refund RPC matches
--     entitlements by purchase_id, and a grant has none (NULL never equals).
--   - Revocation of a grant is a separate, explicit, admin-only function.
--   - Aggregates only reach the operator; no emails are stored or logged.
--
-- ROLLBACK (see the end of the file): remove the grants, then the triggers/columns
-- and the two new tables. Existing paid entitlements are never touched by this
-- migration in either direction.
--
-- NOT APPLIED. Requires approval.

BEGIN;

-- --------------------------------------------------------------- snapshots
CREATE TABLE IF NOT EXISTS public.activation_grandfather_snapshots (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_key     TEXT NOT NULL UNIQUE,
  cutover_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criteria_version TEXT NOT NULL DEFAULT 'funded-v1',
  min_deposit      NUMERIC NOT NULL DEFAULT 100,
  note             TEXT,
  eligible_count   INTEGER,
  applied_count    INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.activation_grandfather_snapshots IS
  'Frozen eligibility snapshots for complimentary Live activation. One row per cutover.';

-- Frozen membership. Rows are written ONCE by the snapshot function and never
-- recomputed, so funding after the cutover cannot join an existing snapshot.
CREATE TABLE IF NOT EXISTS public.activation_grandfather_candidates (
  snapshot_id  BIGINT NOT NULL REFERENCES public.activation_grandfather_snapshots(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  eligible     BOOLEAN NOT NULL,
  reason       TEXT NOT NULL,
  legacy_total    NUMERIC NOT NULL DEFAULT 0,
  provider_total  NUMERIC NOT NULL DEFAULT 0,
  deposit_total   NUMERIC NOT NULL DEFAULT 0,
  already_licensed BOOLEAN NOT NULL DEFAULT FALSE,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_at   TIMESTAMPTZ,
  PRIMARY KEY (snapshot_id, user_id)
);

COMMENT ON TABLE public.activation_grandfather_candidates IS
  'Frozen per-account eligibility evidence captured at snapshot time. No emails, no balances.';

CREATE INDEX IF NOT EXISTS activation_grandfather_candidates_eligible_idx
  ON public.activation_grandfather_candidates (snapshot_id, eligible);

-- ------------------------------------------------------- entitlement columns
-- A complimentary grant has no purchase and no licence key. The CHECK below
-- keeps that freedom strictly limited to non-Payhip sources.
ALTER TABLE public.payhip_entitlements
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'payhip';

ALTER TABLE public.payhip_entitlements
  ADD COLUMN IF NOT EXISTS granted_at TIMESTAMPTZ;

ALTER TABLE public.payhip_entitlements
  ADD COLUMN IF NOT EXISTS grant_snapshot_id BIGINT
  REFERENCES public.activation_grandfather_snapshots(id) ON DELETE SET NULL;

ALTER TABLE public.payhip_entitlements
  ADD COLUMN IF NOT EXISTS grant_reason TEXT;

-- Drop NOT NULL only where the new source permits it (idempotent).
ALTER TABLE public.payhip_entitlements ALTER COLUMN purchase_id     DROP NOT NULL;
ALTER TABLE public.payhip_entitlements ALTER COLUMN licence_key_hash DROP NOT NULL;

ALTER TABLE public.payhip_entitlements
  DROP CONSTRAINT IF EXISTS payhip_entitlement_source_valid;
ALTER TABLE public.payhip_entitlements
  ADD CONSTRAINT payhip_entitlement_source_valid
  CHECK (source IN ('payhip', 'grandfathered_funded_customer'));

ALTER TABLE public.payhip_entitlements
  DROP CONSTRAINT IF EXISTS payhip_entitlement_source_shape;
ALTER TABLE public.payhip_entitlements
  ADD CONSTRAINT payhip_entitlement_source_shape CHECK (
    (source = 'payhip'
       AND purchase_id IS NOT NULL
       AND licence_key_hash IS NOT NULL)
    OR
    (source <> 'payhip'
       AND purchase_id IS NULL
       AND licence_key_hash IS NULL
       AND claimed_at IS NOT NULL
       AND user_id IS NOT NULL)
  );

COMMENT ON COLUMN public.payhip_entitlements.source IS
  'payhip = verified sale; grandfathered_funded_customer = complimentary grant, no purchase, no licence key.';

-- At most ONE complimentary grant per account, forever - including after a
-- revocation, so a replay can never resurrect a removed grant.
CREATE UNIQUE INDEX IF NOT EXISTS payhip_entitlements_one_grant_per_user
  ON public.payhip_entitlements (user_id, source)
  WHERE source <> 'payhip';

CREATE INDEX IF NOT EXISTS payhip_entitlements_grant_snapshot_idx
  ON public.payhip_entitlements (grant_snapshot_id)
  WHERE grant_snapshot_id IS NOT NULL;

-- ---------------------------------------------------------------- resolver
-- Single activation predicate for BOTH executors (web routes and the trading
-- worker). A Payhip row still requires a paid purchase; a grant requires only
-- that it is claimed and not revoked.
CREATE OR REPLACE FUNCTION public.payhip_has_live_activation(p_user_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM payhip_entitlements e
      LEFT JOIN payhip_purchases p ON p.id = e.purchase_id
     WHERE e.user_id = p_user_id
       AND e.claimed_at IS NOT NULL
       AND e.revoked_at IS NULL
       AND (
             (e.source = 'payhip' AND p.status = 'paid')
          OR (e.source <> 'payhip')
       )
  );
$$;

-- --------------------------------------------------------------- preview
-- READ-ONLY. Evaluates the criteria live (nothing frozen, nothing written).
CREATE OR REPLACE FUNCTION public.grandfather_activation_preview(p_min_deposit NUMERIC DEFAULT 100)
RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH dep AS (
    SELECT user_id, SUM(CASE WHEN status = 'confirmed' THEN COALESCE(amount, 0) ELSE 0 END) AS total
      FROM deposits GROUP BY user_id
  ), inv AS (
    SELECT user_id, SUM(CASE WHEN status = 'confirmed' THEN COALESCE(amount_usd, 0) ELSE 0 END) AS total
      FROM payment_invoices GROUP BY user_id
  ), per AS (
    SELECT u.id,
           COALESCE(u.environment, 'PRODUCTION') AS env,
           COALESCE(dep.total, 0) AS legacy_total,
           COALESCE(inv.total, 0) AS provider_total,
           GREATEST(COALESCE(dep.total, 0), COALESCE(inv.total, 0)) AS deposit_total,
           EXISTS (
             SELECT 1 FROM payhip_entitlements e
               LEFT JOIN payhip_purchases p ON p.id = e.purchase_id
              WHERE e.user_id = u.id AND e.claimed_at IS NOT NULL AND e.revoked_at IS NULL
                AND ((e.source = 'payhip' AND p.status = 'paid') OR e.source <> 'payhip')
           ) AS already_licensed
      FROM users u
      LEFT JOIN dep ON dep.user_id = u.id
      LEFT JOIN inv ON inv.user_id = u.id
  )
  SELECT jsonb_build_object(
    'minDeposit', p_min_deposit,
    'totalAccounts',        (SELECT COUNT(*) FROM per),
    'productionAccounts',   (SELECT COUNT(*) FROM per WHERE env <> 'MARKETING_SANDBOX'),
    'sandboxAccounts',      (SELECT COUNT(*) FROM per WHERE env = 'MARKETING_SANDBOX'),
    'alreadyLicensed',      (SELECT COUNT(*) FROM per WHERE env <> 'MARKETING_SANDBOX' AND already_licensed),
    'eligibleNow',          (SELECT COUNT(*) FROM per WHERE env <> 'MARKETING_SANDBOX' AND NOT already_licensed AND deposit_total >= p_min_deposit),
    'fundedTotal',          (SELECT COUNT(*) FROM per WHERE env <> 'MARKETING_SANDBOX' AND deposit_total >= p_min_deposit),
    'belowMinimum',         (SELECT COUNT(*) FROM per WHERE env <> 'MARKETING_SANDBOX' AND deposit_total > 0 AND deposit_total < p_min_deposit),
    'promoOrNoDeposit',     (SELECT COUNT(*) FROM per WHERE env <> 'MARKETING_SANDBOX' AND deposit_total = 0)
  );
$$;

-- --------------------------------------------------------------- snapshot
-- Freezes the eligibility set. Idempotent on snapshot_key: replaying the same
-- key returns the existing snapshot and writes nothing.
CREATE OR REPLACE FUNCTION public.grandfather_activation_snapshot(
  p_snapshot_key TEXT,
  p_note         TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id        BIGINT;
  v_cutover   TIMESTAMPTZ := NOW();
  v_min       NUMERIC := 100;
  v_total     INTEGER;
  v_eligible  INTEGER;
  v_existing  public.activation_grandfather_snapshots%ROWTYPE;
BEGIN
  IF p_snapshot_key IS NULL OR btrim(p_snapshot_key) = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_snapshot_key');
  END IF;

  SELECT * INTO v_existing FROM activation_grandfather_snapshots WHERE snapshot_key = p_snapshot_key;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'duplicate', true,
                              'snapshotId', v_existing.id,
                              'snapshotKey', v_existing.snapshot_key,
                              'cutoverAt', v_existing.cutover_at,
                              'eligibleCount', v_existing.eligible_count,
                              'appliedCount', v_existing.applied_count);
  END IF;

  INSERT INTO activation_grandfather_snapshots (snapshot_key, cutover_at, criteria_version, min_deposit, note)
  VALUES (p_snapshot_key, v_cutover, 'funded-v1', v_min, p_note)
  ON CONFLICT (snapshot_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT * INTO v_existing FROM activation_grandfather_snapshots WHERE snapshot_key = p_snapshot_key;
    RETURN jsonb_build_object('success', true, 'duplicate', true,
                              'snapshotId', v_existing.id,
                              'snapshotKey', v_existing.snapshot_key,
                              'eligibleCount', v_existing.eligible_count);
  END IF;

  -- Freeze EVERY production account with its evidence, so the decision for a
  -- non-qualifying account is auditable too.
  INSERT INTO activation_grandfather_candidates
    (snapshot_id, user_id, eligible, reason, legacy_total, provider_total, deposit_total, already_licensed, evaluated_at)
  WITH dep AS (
    SELECT user_id, SUM(CASE WHEN status = 'confirmed' THEN COALESCE(amount, 0) ELSE 0 END) AS total
      FROM deposits GROUP BY user_id
  ), inv AS (
    SELECT user_id, SUM(CASE WHEN status = 'confirmed' THEN COALESCE(amount_usd, 0) ELSE 0 END) AS total
      FROM payment_invoices GROUP BY user_id
  ), per AS (
    SELECT u.id,
           COALESCE(u.environment, 'PRODUCTION') AS env,
           COALESCE(dep.total, 0) AS legacy_total,
           COALESCE(inv.total, 0) AS provider_total,
           GREATEST(COALESCE(dep.total, 0), COALESCE(inv.total, 0)) AS deposit_total,
           EXISTS (
             SELECT 1 FROM payhip_entitlements e
               LEFT JOIN payhip_purchases p ON p.id = e.purchase_id
              WHERE e.user_id = u.id AND e.claimed_at IS NOT NULL AND e.revoked_at IS NULL
                AND ((e.source = 'payhip' AND p.status = 'paid') OR e.source <> 'payhip')
           ) AS already_licensed
      FROM users u
      LEFT JOIN dep ON dep.user_id = u.id
      LEFT JOIN inv ON inv.user_id = u.id
  )
  SELECT v_id, per.id,
         (per.env <> 'MARKETING_SANDBOX' AND NOT per.already_licensed AND per.deposit_total >= v_min),
         CASE
           WHEN per.env = 'MARKETING_SANDBOX' THEN 'sandbox_excluded'
           WHEN per.already_licensed          THEN 'already_licensed'
           WHEN per.deposit_total >= v_min    THEN 'eligible'
           WHEN per.deposit_total > 0         THEN 'below_minimum_deposit'
           ELSE 'no_confirmed_deposit'
         END,
         per.legacy_total, per.provider_total, per.deposit_total, per.already_licensed, v_cutover
    FROM per
  ON CONFLICT (snapshot_id, user_id) DO NOTHING;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE eligible) INTO v_total, v_eligible
    FROM activation_grandfather_candidates WHERE snapshot_id = v_id;

  UPDATE activation_grandfather_snapshots SET eligible_count = v_eligible WHERE id = v_id;

  RETURN jsonb_build_object('success', true, 'duplicate', false,
                            'snapshotId', v_id,
                            'snapshotKey', p_snapshot_key,
                            'cutoverAt', v_cutover,
                            'evaluatedCount', v_total,
                            'eligibleCount', v_eligible);
END $$;

-- --------------------------------------------------------------- apply
-- Grants the frozen eligible set. Idempotent: the partial unique index plus
-- ON CONFLICT make a replay a no-op. Never touches a wallet or a purchase.
CREATE OR REPLACE FUNCTION public.grandfather_activation_apply(
  p_snapshot_id BIGINT,
  p_limit       INTEGER DEFAULT 1000
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_snap        public.activation_grandfather_snapshots%ROWTYPE;
  v_candidate   RECORD;
  v_granted     INTEGER := 0;
  v_skipped     INTEGER := 0;
  v_batch       INTEGER := GREATEST(1, LEAST(COALESCE(p_limit, 1000), 5000));
BEGIN
  IF p_snapshot_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_snapshot_id');
  END IF;

  SELECT * INTO v_snap FROM activation_grandfather_snapshots WHERE id = p_snapshot_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'unknown_snapshot');
  END IF;

  FOR v_candidate IN
    SELECT c.user_id
      FROM activation_grandfather_candidates c
     WHERE c.snapshot_id = p_snapshot_id
       AND c.eligible
       AND c.granted_at IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM payhip_entitlements e
               LEFT JOIN payhip_purchases p ON p.id = e.purchase_id
              WHERE e.user_id = c.user_id AND e.claimed_at IS NOT NULL AND e.revoked_at IS NULL
                AND ((e.source = 'payhip' AND p.status = 'paid') OR e.source <> 'payhip')
           )
     ORDER BY c.user_id
     LIMIT v_batch
       FOR UPDATE OF c SKIP LOCKED
  LOOP
    INSERT INTO payhip_entitlements
      (purchase_id, licence_key_hash, user_id, claimed_at, source, granted_at, grant_snapshot_id, grant_reason)
    VALUES
      (NULL, NULL, v_candidate.user_id, NOW(), 'grandfathered_funded_customer', NOW(), p_snapshot_id,
       'funded customer at cutover ' || v_snap.snapshot_key)
    ON CONFLICT DO NOTHING;

    IF FOUND THEN
      v_granted := v_granted + 1;
      UPDATE activation_grandfather_candidates
         SET granted_at = NOW()
       WHERE snapshot_id = p_snapshot_id AND user_id = v_candidate.user_id;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  UPDATE activation_grandfather_snapshots
     SET applied_count = (SELECT COUNT(*) FROM activation_grandfather_candidates
                           WHERE snapshot_id = p_snapshot_id AND granted_at IS NOT NULL)
   WHERE id = p_snapshot_id;

  RETURN jsonb_build_object('success', true,
                            'snapshotId', p_snapshot_id,
                            'snapshotKey', v_snap.snapshot_key,
                            'granted', v_granted,
                            'skipped', v_skipped,
                            'appliedTotal', (SELECT applied_count FROM activation_grandfather_snapshots WHERE id = p_snapshot_id));
END $$;

-- --------------------------------------------------------------- report
-- Admin visibility. Aggregates plus one row per grant; no email, no balance.
CREATE OR REPLACE FUNCTION public.grandfather_activation_report()
RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'snapshots', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', s.id, 'key', s.snapshot_key, 'cutoverAt', s.cutover_at,
               'eligibleCount', s.eligible_count, 'appliedCount', s.applied_count,
               'note', s.note) ORDER BY s.id)
        FROM activation_grandfather_snapshots s), '[]'::jsonb),
    'grants', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'userId', e.user_id, 'snapshotId', e.grant_snapshot_id,
               'grantedAt', e.granted_at, 'revokedAt', e.revoked_at,
               'reason', e.grant_reason) ORDER BY e.id)
        FROM payhip_entitlements e WHERE e.source <> 'payhip'), '[]'::jsonb),
    'activeGrants', (SELECT COUNT(*) FROM payhip_entitlements
                      WHERE source <> 'payhip' AND revoked_at IS NULL)
  );
$$;

-- --------------------------------------------------------------- revoke
-- Explicit revocation of a COMPLIMENTARY grant only. The Payhip refund path
-- (revoke_payhip_entitlement_safe) matches by purchase_id and therefore can
-- never reach a grant; this is the only way to end one.
CREATE OR REPLACE FUNCTION public.revoke_grandfathered_entitlement_safe(
  p_user_id BIGINT,
  p_reason  TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id BIGINT;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_user_id');
  END IF;

  UPDATE payhip_entitlements
     SET revoked_at = COALESCE(revoked_at, NOW()),
         revoke_reason = COALESCE(p_reason, 'grandfather_revoked')
   WHERE user_id = p_user_id
     AND source <> 'payhip'
     AND revoked_at IS NULL
   RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_active_grant');
  END IF;

  RETURN jsonb_build_object('success', true, 'entitlementId', v_id);
END $$;

-- -------------------------------------------------------------------- RLS
ALTER TABLE public.activation_grandfather_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activation_grandfather_candidates ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['activation_grandfather_snapshots','activation_grandfather_candidates']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_all', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                   t || '_service_all', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
  END LOOP;
END $$;

DO $$
DECLARE s TEXT;
BEGIN
  FOREACH s IN ARRAY ARRAY['activation_grandfather_snapshots_id_seq']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname = s AND c.relkind = 'S') THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM PUBLIC, anon, authenticated', s);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO service_role', s);
    END IF;
  END LOOP;
END $$;

-- Grants: service_role only, exactly like every other Payhip function.
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.payhip_has_live_activation(bigint)',
    'public.grandfather_activation_preview(numeric)',
    'public.grandfather_activation_snapshot(text,text)',
    'public.grandfather_activation_apply(bigint,integer)',
    'public.grandfather_activation_report()',
    'public.revoke_grandfathered_entitlement_safe(bigint,text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

-- ------------------------------------------------------------- self-check
DO $$
DECLARE missing TEXT := '';
BEGIN
  IF to_regclass('public.activation_grandfather_snapshots')  IS NULL THEN missing := missing || ' snapshots'; END IF;
  IF to_regclass('public.activation_grandfather_candidates') IS NULL THEN missing := missing || ' candidates'; END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='payhip_entitlements' AND column_name='source')
    THEN missing := missing || ' col:source'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public' AND indexname='payhip_entitlements_one_grant_per_user')
    THEN missing := missing || ' idx:one_grant'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='payhip_entitlement_source_shape' AND conrelid='public.payhip_entitlements'::regclass)
    THEN missing := missing || ' check:shape'; END IF;

  -- purchase_id must be nullable now, or a grant could not exist at all.
  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name='payhip_entitlements' AND column_name='purchase_id') <> 'YES'
    THEN missing := missing || ' nullable:purchase_id'; END IF;

  -- The resolver must carry BOTH branches.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='payhip_has_live_activation'
       AND position('grandfathered' IN p.prosrc) = 0            -- must not be hard-coded
       AND position('e.source' IN p.prosrc) > 0                 -- but must use the column
       AND position('p.status = ''paid''' IN p.prosrc) > 0      -- and keep the paid branch
       AND p.proconfig::text LIKE '%search_path=public, pg_temp%')
    THEN missing := missing || ' fn:resolver'; END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class
           WHERE relname='activation_grandfather_snapshots' AND relnamespace='public'::regnamespace)
    THEN missing := missing || ' rls:snapshots'; END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '054 self-check failed, missing:%', missing;
  END IF;
END $$;

COMMIT;

-- ROLLBACK (in this order; paid entitlements are never touched)
--   -- 1. remove the complimentary grants only (never 'payhip' rows)
--   DELETE FROM public.payhip_entitlements WHERE source <> 'payhip';
--   -- 2. restore the resolver to its 050 form (see 050 for the body)
--   -- 3. functions
--   DROP FUNCTION IF EXISTS public.revoke_grandfathered_entitlement_safe(bigint,text);
--   DROP FUNCTION IF EXISTS public.grandfather_activation_report();
--   DROP FUNCTION IF EXISTS public.grandfather_activation_apply(bigint,integer);
--   DROP FUNCTION IF EXISTS public.grandfather_activation_snapshot(text,text);
--   DROP FUNCTION IF EXISTS public.grandfather_activation_preview(numeric);
--   -- 4. indexes + constraints + columns
--   DROP INDEX IF EXISTS public.payhip_entitlements_one_grant_per_user;
--   DROP INDEX IF EXISTS public.payhip_entitlements_grant_snapshot_idx;
--   ALTER TABLE public.payhip_entitlements DROP CONSTRAINT IF EXISTS payhip_entitlement_source_shape;
--   ALTER TABLE public.payhip_entitlements DROP CONSTRAINT IF EXISTS payhip_entitlement_source_valid;
--   ALTER TABLE public.payhip_entitlements
--     DROP COLUMN IF EXISTS grant_reason, DROP COLUMN IF EXISTS grant_snapshot_id,
--     DROP COLUMN IF EXISTS granted_at,   DROP COLUMN IF EXISTS source;
--   ALTER TABLE public.payhip_entitlements ALTER COLUMN purchase_id SET NOT NULL;
--   ALTER TABLE public.payhip_entitlements ALTER COLUMN licence_key_hash SET NOT NULL;
--   -- 5. tables
--   DROP TABLE IF EXISTS public.activation_grandfather_candidates;
--   DROP TABLE IF EXISTS public.activation_grandfather_snapshots;
