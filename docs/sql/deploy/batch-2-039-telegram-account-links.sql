-- ============================================
-- 039_telegram_account_links.sql
-- ============================================
-- PHASE 1 - secure Telegram <-> Arbitrix account linking.
--
-- ONE table holds BOTH sides of the flow:
--   * a PENDING row: token_hash + expires_at, telegram_chat_id IS NULL
--     (minted only from an authenticated web session, never from Telegram)
--   * a LINK row:   telegram_chat_id + telegram_user_id + linked_at
--     (created by consuming a pending row inside consume_telegram_link_token)
--
-- PROPERTIES
--   * No raw token is ever stored: token_hash is SHA-256 (hex) of the token the
--     user's browser received. A stolen database dump cannot mint a link.
--   * Single use: the consuming function flips used = TRUE and nulls nothing, so
--     a replay is detected and answered idempotently.
--   * One-to-one BOTH ways, enforced by partial unique indexes:
--       - one LINK row per user_id        (an account has one Telegram chat)
--       - one LINK row per telegram_chat_id (a chat has one account)
--     A conflict REFUSES the link; ownership is never transferred silently.
--   * RLS is ENABLED with a service_role-only policy; anon/authenticated get no
--     policy and lose the table privileges, so only supabaseAdmin (service role)
--     can read or write. This mirrors migrations 027/036/038.
--
-- ADDITIVE + IDEMPOTENT: safe to run more than once. It does not touch users,
-- wallets, deposits, payment_invoices, referrals or any other existing table.
--
-- NOT APPLIED AUTOMATICALLY. Apply manually (see AGENTS.md) before enabling the
-- feature; until then the endpoints answer 503 and the bot answers "unavailable".
-- ============================================

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telegram_account_links (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT      NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- SHA-256 (hex) of the linking token. NULL only for rows created before this
  -- column existed; every row written by the application has one.
  token_hash        TEXT,
  expires_at        TIMESTAMPTZ,
  used              BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Telegram identity, filled in ONLY by the consuming function from the
  -- authenticated update (chat.id / from.id). Never supplied by a client.
  telegram_chat_id  TEXT,
  telegram_user_id  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at           TIMESTAMPTZ,
  linked_at         TIMESTAMPTZ
);

-- A consumed row must describe a link; a row without a chat must still be a
-- usable token (otherwise it is meaningless).
ALTER TABLE public.telegram_account_links
  DROP CONSTRAINT IF EXISTS telegram_account_links_shape_check;
ALTER TABLE public.telegram_account_links
  ADD CONSTRAINT telegram_account_links_shape_check
  CHECK (
    (used = FALSE AND token_hash IS NOT NULL)
    OR (used = TRUE AND telegram_chat_id IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 2. Uniqueness (the security boundary for ownership)
-- ---------------------------------------------------------------------------
-- A token hash can only ever describe one pending row.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_account_links_token_hash_key
  ON public.telegram_account_links (token_hash)
  WHERE token_hash IS NOT NULL;

-- One Telegram chat -> at most one Arbitrix account.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_account_links_chat_key
  ON public.telegram_account_links (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;

-- One Arbitrix account -> at most one Telegram chat.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_account_links_user_key
  ON public.telegram_account_links (user_id)
  WHERE telegram_chat_id IS NOT NULL;

-- Cheap lookup of the one pending token a user may hold.
CREATE INDEX IF NOT EXISTS telegram_account_links_pending_idx
  ON public.telegram_account_links (user_id, expires_at)
  WHERE used = FALSE;

-- ---------------------------------------------------------------------------
-- 3. RLS: service_role only (server-side code), deny everything else
-- ---------------------------------------------------------------------------
ALTER TABLE public.telegram_account_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS telegram_account_links_service_all ON public.telegram_account_links;
CREATE POLICY telegram_account_links_service_all
  ON public.telegram_account_links
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

REVOKE ALL ON public.telegram_account_links FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.telegram_account_links TO service_role;
-- The sequence backing id BIGSERIAL is written only by the service role too.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'telegram_account_links_id_seq') THEN
    EXECUTE 'REVOKE ALL ON SEQUENCE public.telegram_account_links_id_seq FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.telegram_account_links_id_seq TO service_role';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Atomic consumption
-- ---------------------------------------------------------------------------
-- The ONLY way a link row is created. Runs as SECURITY DEFINER so the caller
-- cannot bypass the checks, and inside the statement's own transaction so a
-- concurrent call cannot consume the same token twice (row lock + used flag +
-- unique indexes).
--
-- Returns JSONB, never raises for expected outcomes:
--   { success: true,  already: false, user_id: "<id>" }   newly linked
--   { success: true,  already: true,  user_id: "<id>" }   this chat already owns it
--   { success: false, reason: 'invalid' | 'used' | 'expired'
--                          | 'chat_linked_elsewhere' | 'account_linked_elsewhere'
--                          | 'invalid_chat' }
CREATE OR REPLACE FUNCTION public.consume_telegram_link_token(
  p_token_hash       TEXT,
  p_chat_id          TEXT,
  p_telegram_user_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token       public.telegram_account_links%ROWTYPE;
  v_chat_link   public.telegram_account_links%ROWTYPE;
  v_user_link   public.telegram_account_links%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR length(p_token_hash) < 32 THEN
    RETURN jsonb_build_object('success', FALSE, 'reason', 'invalid');
  END IF;
  IF p_chat_id IS NULL OR p_chat_id = '' THEN
    RETURN jsonb_build_object('success', FALSE, 'reason', 'invalid_chat');
  END IF;

  -- Lock the token row first: the row lock is what makes consumption atomic.
  SELECT * INTO v_token
    FROM public.telegram_account_links
   WHERE token_hash = p_token_hash
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'reason', 'invalid');
  END IF;

  -- Replay of a consumed token.
  IF v_token.used THEN
    IF v_token.telegram_chat_id = p_chat_id THEN
      -- Same chat, same account: idempotent success (Telegram may redeliver).
      RETURN jsonb_build_object('success', TRUE, 'already', TRUE, 'user_id', v_token.user_id::TEXT);
    END IF;
    RETURN jsonb_build_object('success', FALSE, 'reason', 'used');
  END IF;

  IF v_token.expires_at IS NULL OR v_token.expires_at <= now() THEN
    RETURN jsonb_build_object('success', FALSE, 'reason', 'expired');
  END IF;

  -- Is this Telegram chat already linked?
  SELECT * INTO v_chat_link
    FROM public.telegram_account_links
   WHERE telegram_chat_id = p_chat_id
   FOR UPDATE;

  IF FOUND THEN
    -- Burn the token either way: it can never be used again. Destroying the
    -- pending row (rather than marking it used) keeps the shape invariant
    -- "a used row always carries a chat" true for every stored row.
    DELETE FROM public.telegram_account_links WHERE id = v_token.id;

    IF v_chat_link.user_id = v_token.user_id THEN
      RETURN jsonb_build_object('success', TRUE, 'already', TRUE, 'user_id', v_token.user_id::TEXT);
    END IF;
    RETURN jsonb_build_object('success', FALSE, 'reason', 'chat_linked_elsewhere');
  END IF;

  -- Is this Arbitrix account already linked to a different chat?
  SELECT * INTO v_user_link
    FROM public.telegram_account_links
   WHERE user_id = v_token.user_id
     AND telegram_chat_id IS NOT NULL
   FOR UPDATE;

  IF FOUND THEN
    DELETE FROM public.telegram_account_links WHERE id = v_token.id;
    RETURN jsonb_build_object('success', FALSE, 'reason', 'account_linked_elsewhere');
  END IF;

  UPDATE public.telegram_account_links
     SET used = TRUE,
         used_at = now(),
         telegram_chat_id = p_chat_id,
         telegram_user_id = p_telegram_user_id,
         linked_at = now()
   WHERE id = v_token.id;

  RETURN jsonb_build_object('success', TRUE, 'already', FALSE, 'user_id', v_token.user_id::TEXT);

EXCEPTION
  -- The partial unique indexes are the final backstop for a race between two
  -- concurrent consumptions. Losing the race is a refusal, never a transfer.
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', FALSE, 'reason', 'chat_linked_elsewhere');
END;
$$;

REVOKE ALL ON FUNCTION public.consume_telegram_link_token(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_telegram_link_token(TEXT, TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Self-check (raises and rolls the migration back if something is missing)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rls       BOOLEAN;
  v_policy    INTEGER;
  v_chat_idx  INTEGER;
  v_user_idx  INTEGER;
  v_token_idx INTEGER;
  v_fn        INTEGER;
BEGIN
  SELECT relrowsecurity INTO v_rls
    FROM pg_class WHERE oid = 'public.telegram_account_links'::regclass;
  IF v_rls IS NOT TRUE THEN
    RAISE EXCEPTION 'telegram_account_links: RLS is not enabled';
  END IF;

  SELECT count(*) INTO v_policy
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'telegram_account_links';
  IF v_policy <> 1 THEN
    RAISE EXCEPTION 'telegram_account_links: expected exactly one policy, found %', v_policy;
  END IF;

  SELECT count(*) INTO v_chat_idx
    FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'telegram_account_links'
     AND indexname = 'telegram_account_links_chat_key';
  IF v_chat_idx <> 1 THEN
    RAISE EXCEPTION 'telegram_account_links: chat uniqueness index is missing';
  END IF;

  SELECT count(*) INTO v_user_idx
    FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'telegram_account_links'
     AND indexname = 'telegram_account_links_user_key';
  IF v_user_idx <> 1 THEN
    RAISE EXCEPTION 'telegram_account_links: user uniqueness index is missing';
  END IF;

  SELECT count(*) INTO v_token_idx
    FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'telegram_account_links'
     AND indexname = 'telegram_account_links_token_hash_key';
  IF v_token_idx <> 1 THEN
    RAISE EXCEPTION 'telegram_account_links: token hash uniqueness index is missing';
  END IF;

  SELECT count(*) INTO v_fn
    FROM pg_proc
   WHERE proname = 'consume_telegram_link_token'
     AND pronamespace = 'public'::regnamespace;
  IF v_fn < 1 THEN
    RAISE EXCEPTION 'consume_telegram_link_token() is missing';
  END IF;
END $$;
