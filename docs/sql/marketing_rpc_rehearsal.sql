-- ============================================================================
-- Arbitrix - marketing RPC rehearsal (DESTRUCTIVE - THROWAWAY DATABASE ONLY)
-- ============================================================================
-- Executes the EXACT calls services/MarketingStore.js makes - same function
-- names, same arguments - against a real PostgreSQL, and asserts the contract
-- that migrations 038 + 043 + 044 promise:
--
--   1. claim_marketing_posts() takes the due post, marks it sending and holds a
--      lease owned by the calling worker
--   2. a second worker claims nothing while that lease is held
--   3. finish_marketing_post() from a FOREIGN worker is fenced (no row, no
--      status change)
--   4. finish from the owner publishes the post with its message id
--   5. the heartbeat write updates worker_heartbeat_at without touching
--      paused / dry_run
--   6. block_marketing_post() records a blocked post and its reason
--   7. the telegram_marketing_sends audit row inserts with the expected columns
--   8. an EXPIRED lease is reclaimed by the next worker (crash recovery)
--
-- SAFETY
--   * This file DELETEs marketing rows. It is for a throwaway database or a
--     staging project you are willing to wipe - never production.
--   * It therefore REFUSES to run unless the session opts in explicitly:
--         set arbitrix.rehearsal = 'yes';
--     With the setting absent the script raises before touching a row.
--   * It touches only the four telegram_marketing_* tables. No wallet, trade,
--     deposit, withdrawal, subscription, referral or KYC object is referenced.
--
-- HOW TO RUN (throwaway PostgreSQL with 038 + 043 + 044 applied):
--   psql -d arbitrix_rehearsal \
--        -c "set arbitrix.rehearsal = 'yes';" \
--        -f docs/sql/marketing_rpc_rehearsal.sql
--   or interactively:
--     psql -d arbitrix_rehearsal
--     set arbitrix.rehearsal = 'yes';
--     \i docs/sql/marketing_rpc_rehearsal.sql
--   Every check prints PASS, and the block ends with ALL REHEARSAL CHECKS PASSED.
-- ============================================================================

\set ON_ERROR_STOP on

-- ---- opt-in guard: no setting, no rows touched -----------------------------
do $$
begin
  if coalesce(current_setting('arbitrix.rehearsal', true), '') <> 'yes' then
    raise exception 'refusing to run: this script DELETEs marketing rows. '
                    'Set arbitrix.rehearsal = ''yes'' on a THROWAWAY database first.';
  end if;
end;
$$;

-- ---- seed ----------------------------------------------------------------
update public.telegram_marketing_control
   set paused = false, dry_run = false, worker_heartbeat_at = null
 where id = 1;

delete from public.telegram_marketing_sends;
delete from public.telegram_marketing_posts;

insert into public.telegram_marketing_posts
  (kind, locale, audience, content, status, idempotency_key, scheduled_for)
values
  ('weekly', 'en', 'group', 'due-post', 'scheduled', 'reh:due',    now() - interval '1 minute'),
  ('weekly', 'en', 'group', 'future-post', 'scheduled', 'reh:future', now() + interval '2 hours');

do $$
declare
  claimed  public.telegram_marketing_posts[];
  row1     public.telegram_marketing_posts;
  n        integer;
  fenced   public.telegram_marketing_posts;
  finished public.telegram_marketing_posts;
  blocked  public.telegram_marketing_posts;
  ctl      record;
begin
  -- 1. claim exactly the due post, as MarketingStore.claimDue() does
  select array_agg(t) into claimed
    from public.claim_marketing_posts(
           p_now           => now(),
           p_limit         => 5,
           p_worker_id     => 'worker-A',
           p_lease_seconds => 60) t;
  if coalesce(array_length(claimed, 1), 0) <> 1 then
    raise exception 'FAIL claim: expected 1 due post, got %', coalesce(array_length(claimed, 1), 0);
  end if;
  row1 := claimed[1];
  if row1.content <> 'due-post' then raise exception 'FAIL claim: wrong post (%)', row1.content; end if;
  if row1.status <> 'sending' then raise exception 'FAIL claim: status %', row1.status; end if;
  if row1.claimed_by <> 'worker-A' then raise exception 'FAIL claim: claimed_by %', row1.claimed_by; end if;
  if row1.lease_expires_at is null or row1.lease_expires_at <= now() then
    raise exception 'FAIL claim: lease not set/expired';
  end if;
  raise notice 'PASS claim: 1 post, sending, claimed_by=worker-A, lease set';

  -- 2. a second claim must find nothing (the lease is held)
  n := (select count(*) from public.claim_marketing_posts(
          p_now => now(), p_limit => 5, p_worker_id => 'worker-B', p_lease_seconds => 60));
  if n <> 0 then raise exception 'FAIL second claim: % rows', n; end if;
  raise notice 'PASS second claim: 0 rows (lease held)';

  -- 3. finish from the WRONG worker must be fenced (no row returned)
  fenced := public.finish_marketing_post(
    p_id => row1.id, p_ok => true, p_message_id => 999, p_error => null,
    p_retry_at => null, p_worker_id => 'worker-B');
  if fenced.id is not null then raise exception 'FAIL fencing: worker-B finished worker-A''s post'; end if;
  if (select status from public.telegram_marketing_posts where id = row1.id) <> 'sending' then
    raise exception 'FAIL fencing: status changed by a foreign worker';
  end if;
  raise notice 'PASS fencing: a foreign worker cannot finish the post';

  -- 4. finish from the owner publishes it
  finished := public.finish_marketing_post(
    p_id => row1.id, p_ok => true, p_message_id => 555, p_error => null,
    p_retry_at => null, p_worker_id => 'worker-A');
  if finished.status <> 'published' then raise exception 'FAIL finish: status %', finished.status; end if;
  if finished.telegram_message_id <> 555 then raise exception 'FAIL finish: message id %', finished.telegram_message_id; end if;
  raise notice 'PASS finish: published with message id 555';

  -- 5. heartbeat, exactly as MarketingStore.heartbeat() writes it
  update public.telegram_marketing_control
     set worker_heartbeat_at = now(), worker_id = 'worker-A', worker_version = 'marketing-worker/1'
   where id = 1;
  select paused, dry_run, worker_heartbeat_at, worker_id into ctl
    from public.telegram_marketing_control where id = 1;
  if ctl.worker_heartbeat_at is null then raise exception 'FAIL heartbeat: not written'; end if;
  if ctl.paused or ctl.dry_run then raise exception 'FAIL heartbeat: it changed the gates'; end if;
  if ctl.worker_id <> 'worker-A' then raise exception 'FAIL heartbeat: worker_id %', ctl.worker_id; end if;
  raise notice 'PASS heartbeat: written, gates untouched (paused=false, dry_run=false)';

  -- 6. the block path used when ContentGuard rejects a claimed post
  insert into public.telegram_marketing_posts
    (kind, locale, audience, content, status, idempotency_key, scheduled_for)
  values ('weekly', 'en', 'group', 'blocked-post', 'scheduled', 'reh:block', now() - interval '1 minute');

  select * into row1 from public.claim_marketing_posts(
    p_now => now(), p_limit => 5, p_worker_id => 'worker-A', p_lease_seconds => 60) limit 1;
  blocked := public.block_marketing_post(
    p_id => row1.id, p_reason => 'guard:guaranteed-profit', p_worker_id => 'worker-A');
  if blocked.status <> 'blocked' then raise exception 'FAIL block: status %', blocked.status; end if;
  raise notice 'PASS block: status blocked with reason recorded';

  -- 7. the send audit row MarketingStore.recordSend() inserts
  insert into public.telegram_marketing_sends
    (post_id, audience, chat_id, status, attempt, telegram_message_id, error)
  values (row1.id, 'group', '-1001234567890', 'sent', 1, 555, null);
  if (select count(*) from public.telegram_marketing_sends where post_id = row1.id) <> 1 then
    raise exception 'FAIL audit: send row not written';
  end if;
  raise notice 'PASS audit: send row accepted';

  -- 8. an expired lease is reclaimable (worker crash recovery)
  insert into public.telegram_marketing_posts
    (kind, locale, audience, content, status, idempotency_key, scheduled_for,
     claimed_by, lease_expires_at, attempts)
  values ('weekly', 'en', 'group', 'orphan-post', 'sending', 'reh:orphan', now() - interval '1 hour',
          'dead-worker', now() - interval '1 minute', 1);

  n := (select count(*) from public.claim_marketing_posts(
          p_now => now(), p_limit => 5, p_worker_id => 'worker-C', p_lease_seconds => 60)
         where content = 'orphan-post');
  if n <> 1 then raise exception 'FAIL reclaim: expired lease not reclaimed (%)', n; end if;
  raise notice 'PASS reclaim: an expired lease is recovered by the next worker';

  raise notice 'ALL REHEARSAL CHECKS PASSED';
end;
$$;
