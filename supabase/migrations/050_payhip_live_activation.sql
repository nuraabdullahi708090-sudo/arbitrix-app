-- 050_payhip_live_activation.sql
--
-- ONE-TIME LIVE MODE SOFTWARE ACTIVATION ENTITLEMENT (Payhip, Option A).
--
-- MODEL
--   A customer buys a live-activation product on Payhip. That purchase is
--   recorded here from the verified sale payload and produces exactly ONE
--   entitlement, which can be claimed by exactly ONE Arbitrix account, once,
--   permanently. Activation unlocks Live Mode; it credits NO capital. Funding is
--   a separate deposit through the existing Q8Pay flow.
--
-- WHAT ACTIVATION DOES NOT DO
--   - It does not credit wallets.live_balance (no money moves here at all).
--   - It does not create a deposit, a trade or a subscription.
--   - It does not bypass any existing gate: the deposit minimum, the withdrawal
--     minimum, the completed-trade requirement and KYC all still apply.
--
-- SECURITY
--   - The licence key is NEVER stored: only its SHA-256 hex digest.
--   - The sale id from Payhip is the idempotency anchor (UNIQUE).
--   - RLS is ENABLED with a service_role-only policy; anon/authenticated get no
--     policy and no grant, so a leaked anon key cannot read purchases.
--   - Redemption is a SECURITY DEFINER function so the one-time claim is atomic
--     (row lock) and cannot be won by two accounts racing.
--
-- NOT APPLIED. Requires approval.

BEGIN;

-- ---------------------------------------------------------------- products
CREATE TABLE IF NOT EXISTS public.payhip_products (
  product_key   TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'live_activation'
                CHECK (kind IN ('live_activation', 'software')),
  price_cents   INTEGER CHECK (price_cents IS NULL OR price_cents > 0),
  is_active     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.payhip_products IS
  'Payhip product catalogue. is_active is FALSE until the founder enables checkout.';

-- ---------------------------------------------------------------- purchases
CREATE TABLE IF NOT EXISTS public.payhip_purchases (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payhip_sale_id     TEXT NOT NULL UNIQUE,
  product_key        TEXT REFERENCES public.payhip_products(product_key),
  buyer_email        TEXT,
  price_cents        INTEGER,
  currency           TEXT,
  stripe_fee_cents   INTEGER,
  payhip_fee_cents   INTEGER,
  status             TEXT NOT NULL DEFAULT 'paid'
                     CHECK (status IN ('paid', 'refunded', 'chargedback', 'voided')),
  amount_refunded_cents INTEGER,
  raw_payload        JSONB,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refunded_at        TIMESTAMPTZ,
  note               TEXT
);

CREATE INDEX IF NOT EXISTS payhip_purchases_email_idx
  ON public.payhip_purchases (lower(buyer_email));

COMMENT ON TABLE public.payhip_purchases IS
  'Verified Payhip sales. payhip_sale_id is the idempotency anchor.';

-- ------------------------------------------------------------- entitlements
CREATE TABLE IF NOT EXISTS public.payhip_entitlements (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_id      BIGINT NOT NULL UNIQUE
                   REFERENCES public.payhip_purchases(id) ON DELETE CASCADE,
  licence_key_hash TEXT NOT NULL UNIQUE,
  user_id          BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  claimed_at       TIMESTAMPTZ,
  -- Stamped when the owning account is deleted (the FK nulls user_id). The
  -- licence stays CLAIMED - so nobody else can ever use it - while the purchase
  -- evidence survives for reconciliation. See the three-state CHECK below.
  owner_detached_at TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  revoke_reason    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Exactly three legal states:
  --   unclaimed  -> no owner, no claim, no detach
  --   claimed    -> owner, claim, no detach
  --   detached   -> claim, no owner, detach stamp (the account was deleted)
  CONSTRAINT payhip_entitlement_claim_shape CHECK (
    (claimed_at IS NULL     AND user_id IS NULL     AND owner_detached_at IS NULL)
    OR (claimed_at IS NOT NULL AND user_id IS NOT NULL AND owner_detached_at IS NULL)
    OR (claimed_at IS NOT NULL AND user_id IS NULL     AND owner_detached_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS payhip_entitlements_user_idx
  ON public.payhip_entitlements (user_id);

-- Converge a draft that created the table without the detach column/constraint.
ALTER TABLE public.payhip_entitlements
  ADD COLUMN IF NOT EXISTS owner_detached_at TIMESTAMPTZ;

ALTER TABLE public.payhip_entitlements
  DROP CONSTRAINT IF EXISTS payhip_entitlement_claim_shape;
ALTER TABLE public.payhip_entitlements
  ADD CONSTRAINT payhip_entitlement_claim_shape CHECK (
    (claimed_at IS NULL     AND user_id IS NULL     AND owner_detached_at IS NULL)
    OR (claimed_at IS NOT NULL AND user_id IS NOT NULL AND owner_detached_at IS NULL)
    OR (claimed_at IS NOT NULL AND user_id IS NULL     AND owner_detached_at IS NOT NULL)
  );

-- Deleting an account runs the FK's ON DELETE SET NULL as a normal UPDATE, so a
-- BEFORE trigger can record WHY the owner disappeared. Without this the updated
-- row would violate the CHECK above and the account deletion would fail.
-- The licence itself is untouched: claimed_at stays set, the hash stays UNIQUE,
-- and redeem_payhip_entitlement_safe already refuses a claimed row whose owner
-- differs (NULL IS DISTINCT FROM p_user_id), so a detached licence can never be
-- claimed again by anyone.
CREATE OR REPLACE FUNCTION public.payhip_entitlement_note_detach()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL AND NEW.owner_detached_at IS NULL THEN
    NEW.owner_detached_at := NOW();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payhip_entitlement_detach_note ON public.payhip_entitlements;
CREATE TRIGGER payhip_entitlement_detach_note
  BEFORE UPDATE OF user_id ON public.payhip_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.payhip_entitlement_note_detach();

COMMENT ON COLUMN public.payhip_entitlements.licence_key_hash IS
  'SHA-256 hex of the Payhip licence key. The raw key is never stored.';

COMMENT ON COLUMN public.payhip_entitlements.owner_detached_at IS
  'Set when the owning account was deleted. The licence stays claimed and unusable; the purchase record is retained.';

-- ------------------------------------------------------------------- events
CREATE TABLE IF NOT EXISTS public.payhip_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type  TEXT NOT NULL,
  sale_id     TEXT,
  outcome     TEXT,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payhip_events_sale_idx ON public.payhip_events (sale_id);

COMMENT ON TABLE public.payhip_events IS
  'Append-only audit of every webhook and redemption outcome. Holds no secrets.';

-- ---------------------------------------------------------------------- RLS
ALTER TABLE public.payhip_products     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payhip_purchases    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payhip_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payhip_events       ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['payhip_products','payhip_purchases','payhip_entitlements','payhip_events']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_all', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                   t || '_service_all', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
  END LOOP;
END $$;

-- Sequences are separate objects; grant only if they exist.
DO $$
DECLARE s TEXT;
BEGIN
  FOREACH s IN ARRAY ARRAY['payhip_purchases_id_seq','payhip_entitlements_id_seq','payhip_events_id_seq']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname = s AND c.relkind = 'S') THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM PUBLIC, anon, authenticated', s);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO service_role', s);
    END IF;
  END LOOP;
END $$;

-- Every function below is SECURITY DEFINER. search_path pins public FIRST and
-- pg_temp LAST, so a temp schema cannot shadow a table these bodies touch
-- (the same rule migration 053 applies to the other financial RPCs).

-- --------------------------------------------------------- record a purchase
-- Idempotent on the Payhip sale id. Creates the entitlement in the same
-- transaction, with the hashed licence key. NEVER credits anything.
CREATE OR REPLACE FUNCTION public.record_payhip_purchase_safe(
  p_sale_id       TEXT,
  p_product_key   TEXT,
  p_buyer_email   TEXT,
  p_price_cents   INTEGER,
  p_currency      TEXT,
  p_stripe_fee    INTEGER,
  p_payhip_fee    INTEGER,
  p_licence_hash  TEXT,
  p_payload       JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_purchase_id BIGINT;
  v_entitlement_id BIGINT;
BEGIN
  IF p_sale_id IS NULL OR btrim(p_sale_id) = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_sale_id');
  END IF;
  IF p_licence_hash IS NULL OR length(p_licence_hash) < 32 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_licence_hash');
  END IF;
  IF p_product_key IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM payhip_products WHERE product_key = p_product_key) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'unknown_product');
  END IF;

  INSERT INTO payhip_purchases
    (payhip_sale_id, product_key, buyer_email, price_cents, currency,
     stripe_fee_cents, payhip_fee_cents, status, raw_payload)
  VALUES
    (p_sale_id, p_product_key, p_buyer_email, p_price_cents, p_currency,
     p_stripe_fee, p_payhip_fee, 'paid', p_payload)
  ON CONFLICT (payhip_sale_id) DO NOTHING
  RETURNING id INTO v_purchase_id;

  IF v_purchase_id IS NULL THEN
    -- Replay: find the existing purchase and its entitlement, create nothing.
    SELECT id INTO v_purchase_id FROM payhip_purchases WHERE payhip_sale_id = p_sale_id;
    SELECT id INTO v_entitlement_id FROM payhip_entitlements WHERE purchase_id = v_purchase_id;
    RETURN jsonb_build_object('success', true, 'duplicate', true,
                              'purchase_id', v_purchase_id,
                              'entitlement_id', v_entitlement_id);
  END IF;

  INSERT INTO payhip_entitlements (purchase_id, licence_key_hash)
  VALUES (v_purchase_id, p_licence_hash)
  ON CONFLICT (purchase_id) DO NOTHING
  RETURNING id INTO v_entitlement_id;

  IF v_entitlement_id IS NULL THEN
    SELECT id INTO v_entitlement_id FROM payhip_entitlements WHERE purchase_id = v_purchase_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'duplicate', false,
                            'purchase_id', v_purchase_id,
                            'entitlement_id', v_entitlement_id);
END $$;

-- ------------------------------------------------------------- redemption
-- One licence -> one account, once. Atomic: the entitlement row is locked.
CREATE OR REPLACE FUNCTION public.redeem_payhip_entitlement_safe(
  p_user_id      BIGINT,
  p_licence_hash TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_row    payhip_entitlements%ROWTYPE;
  v_status TEXT;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_authenticated');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'unknown_user');
  END IF;
  IF p_licence_hash IS NULL OR length(p_licence_hash) < 32 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_licence');
  END IF;

  SELECT * INTO v_row
    FROM payhip_entitlements
   WHERE licence_key_hash = p_licence_hash
   FOR UPDATE;

  IF NOT FOUND THEN
    -- One generic reason for unknown/failed lookups so keys cannot be probed.
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_licence');
  END IF;

  SELECT status INTO v_status FROM payhip_purchases WHERE id = v_row.purchase_id;
  IF v_status IS DISTINCT FROM 'paid' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'purchase_not_active');
  END IF;

  IF v_row.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'entitlement_revoked');
  END IF;

  -- Already claimed by a DIFFERENT account: refuse and never transfer.
  IF v_row.claimed_at IS NOT NULL AND v_row.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'claimed_by_other_account',
                              'entitlement_id', v_row.id);
  END IF;

  -- Already claimed by THIS account: idempotent success.
  IF v_row.claimed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'duplicate', true,
                              'entitlement_id', v_row.id);
  END IF;

  UPDATE payhip_entitlements
     SET user_id = p_user_id, claimed_at = NOW()
   WHERE id = v_row.id;

  RETURN jsonb_build_object('success', true, 'duplicate', false,
                            'entitlement_id', v_row.id);
END $$;

-- --------------------------------------------------------------- refunds
-- A refund or chargeback revokes the entitlement and ends the activation. It
-- touches NO balance: activation never credited capital, so there is nothing to
-- reverse and a negative balance is impossible here.
CREATE OR REPLACE FUNCTION public.revoke_payhip_entitlement_safe(
  p_sale_id TEXT,
  p_status  TEXT,
  p_amount_refunded_cents INTEGER DEFAULT NULL,
  p_reason  TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_purchase_id BIGINT;
  v_entitlement_id BIGINT;
  v_new_status TEXT := CASE WHEN p_status IN ('refunded','chargedback','voided')
                            THEN p_status ELSE 'voided' END;
BEGIN
  SELECT id INTO v_purchase_id FROM payhip_purchases WHERE payhip_sale_id = p_sale_id FOR UPDATE;
  IF v_purchase_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'unknown_sale');
  END IF;

  UPDATE payhip_purchases
     SET status = v_new_status,
         amount_refunded_cents = COALESCE(p_amount_refunded_cents, amount_refunded_cents),
         refunded_at = COALESCE(refunded_at, NOW()),
         note = COALESCE(p_reason, note)
   WHERE id = v_purchase_id;

  UPDATE payhip_entitlements
     SET revoked_at = COALESCE(revoked_at, NOW()),
         revoke_reason = COALESCE(p_reason, v_new_status)
   WHERE purchase_id = v_purchase_id
   RETURNING id INTO v_entitlement_id;

  RETURN jsonb_build_object('success', true,
                            'purchase_id', v_purchase_id,
                            'entitlement_id', v_entitlement_id,
                            'status', v_new_status);
END $$;

-- ---------------------------------------------------------------- activation
CREATE OR REPLACE FUNCTION public.payhip_has_live_activation(p_user_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM payhip_entitlements e
      JOIN payhip_purchases p ON p.id = e.purchase_id
     WHERE e.user_id = p_user_id
       AND e.claimed_at IS NOT NULL
       AND e.revoked_at IS NULL
       AND p.status = 'paid'
  );
$$;

-- Grants: service_role only for every function here.
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.record_payhip_purchase_safe(text,text,text,integer,text,integer,integer,text,jsonb)',
    'public.redeem_payhip_entitlement_safe(bigint,text)',
    'public.revoke_payhip_entitlement_safe(text,text,integer,text)',
    'public.payhip_has_live_activation(bigint)',
    'public.payhip_entitlement_note_detach()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

-- ------------------------------------------------------------- self-check
DO $$
DECLARE missing TEXT := '';
BEGIN
  IF to_regclass('public.payhip_purchases')    IS NULL THEN missing := missing || ' purchases'; END IF;
  IF to_regclass('public.payhip_entitlements') IS NULL THEN missing := missing || ' entitlements'; END IF;
  IF to_regclass('public.payhip_products')     IS NULL THEN missing := missing || ' products'; END IF;
  IF to_regclass('public.payhip_events')       IS NULL THEN missing := missing || ' events'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'redeem_payhip_entitlement_safe') THEN
    missing := missing || ' fn:redeem';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'record_payhip_purchase_safe') THEN
    missing := missing || ' fn:record';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'payhip_purchases'
            AND relnamespace = 'public'::regnamespace) THEN
    missing := missing || ' rls:purchases';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'payhip_entitlements'
                    AND column_name = 'owner_detached_at') THEN
    missing := missing || ' col:owner_detached_at';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'payhip_entitlement_detach_note' AND NOT tgisinternal) THEN
    missing := missing || ' trg:detach';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'payhip_purchases'
                    AND policyname = 'payhip_purchases_service_all') THEN
    missing := missing || ' policy:purchases';
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '050 self-check failed, missing:%', missing;
  END IF;
END $$;

COMMIT;

-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.payhip_has_live_activation(bigint);
--   DROP FUNCTION IF EXISTS public.revoke_payhip_entitlement_safe(text,text,integer,text);
--   DROP FUNCTION IF EXISTS public.redeem_payhip_entitlement_safe(bigint,text);
--   DROP FUNCTION IF EXISTS public.record_payhip_purchase_safe(text,text,text,integer,text,integer,integer,text,jsonb);
--   DROP TABLE IF EXISTS public.payhip_events, public.payhip_entitlements,
--                        public.payhip_purchases, public.payhip_products;
