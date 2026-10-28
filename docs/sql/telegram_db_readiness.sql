-- ============================================================================
-- Arbitrix - Telegram production database readiness check
-- ============================================================================
-- READ-ONLY verification for migrations 038, 039, 040 and 041.
-- Answers: "is this database ready for the four undeployed commits, and what
-- exactly is missing if not?"
--
-- SAFETY
--   * SELECT only. No CREATE/ALTER/INSERT/UPDATE/DELETE/DROP/GRANT/REVOKE,
--     no function execution, no temp tables, no writes of any kind.
--   * Safe to run repeatedly on production at any time.
--
-- HOW TO RUN
--   1. Supabase dashboard -> SQL Editor (or psql as the service role).
--   2. Run the whole file.
--   3. Every row has a `status` column:
--        OK       object exists as the migration defines it
--        MISSING  the migration that creates it is not applied
--        DRIFT    exists but differs from the expected definition
--        REVIEW   a state value to look at (not necessarily a fault)
--        APPLIED / NOT APPLIED / PARTIAL  (verdict rows only)
--   * Any MISSING or DRIFT row is an action item. The last result set
--     ("verdict") summarises which migrations are applied and the next action.
--
-- MIGRATION DEPENDENCIES (taken from the migration files, not assumed)
--   038 marketing broadcast queue : independent (service_role only)
--   039 telegram account links    : needs public.users
--   040 conversion events/outbox  : needs users, payment_invoices, referrals,
--                                   wallets, transactions, users.environment
--                                   (013); its reminder RPC also needs 038 and
--                                   039 tables at runtime
--   041 legacy deposit credit     : needs 040 + deposits/wallets/transactions
--   Apply 038 -> 039 -> (040 + 041 together).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. Context
-- ----------------------------------------------------------------------------
select current_database()                as database,
       current_user                      as role,
       current_setting('server_version') as server_version,
       now()                             as checked_at,
       pg_is_in_recovery()               as is_read_replica;


-- ----------------------------------------------------------------------------
-- 1. Prerequisite tables (must exist before 038-041)
-- ----------------------------------------------------------------------------
with expected(tbl) as (
  values ('users'), ('wallets'), ('transactions'), ('referrals'),
         ('payment_invoices'), ('deposits')
)
select 'prerequisite-table' as check_type,
       e.tbl as object_name,
       case when to_regclass('public.' || e.tbl) is null then 'MISSING' else 'OK' end as status,
       coalesce(to_regclass('public.' || e.tbl)::text, '(table absent)') as detail
from expected e
order by status desc, object_name;


-- ----------------------------------------------------------------------------
-- 2. Prerequisite columns owned by earlier migrations
--      users.environment         -> 013 (sandbox classification)
--      payment_invoices.credited -> 006 (credit marker, DEFAULT FALSE)
-- ----------------------------------------------------------------------------
with expected(tbl, col, origin) as (
  values ('users', 'environment', 'migration 013'),
         ('payment_invoices', 'credited', 'migration 006'),
         ('payment_invoices', 'status', 'base schema'),
         ('payment_invoices', 'amount_usd', 'base schema'),
         ('deposits', 'status', 'legacy schema'),
         ('referrals', 'referrer_id', 'referral schema'),
         ('referrals', 'referred_id', 'referral schema'),
         ('referrals', 'bonus_earned', 'referral schema'),
         ('wallets', 'live_balance', 'base schema'),
         ('wallets', 'bonus_balance', 'base schema')
)
select 'prerequisite-column' as check_type,
       e.tbl || '.' || e.col as object_name,
       case when c.column_name is null then 'MISSING' else 'OK' end as status,
       coalesce(c.data_type || ' / nullable=' || c.is_nullable
                || ' / default=' || coalesce(c.column_default, 'none'), '(column absent)')
         || ' [' || e.origin || ']' as detail
from expected e
left join information_schema.columns c
       on c.table_schema = 'public'
      and c.table_name   = e.tbl
      and c.column_name  = e.col
order by status desc, object_name;


-- ----------------------------------------------------------------------------
-- 3a. Columns created by 038 (marketing broadcast queue)
-- ----------------------------------------------------------------------------
with expected(tbl, col) as (
  values
    ('telegram_marketing_posts','id'),
    ('telegram_marketing_posts','kind'),
    ('telegram_marketing_posts','theme'),
    ('telegram_marketing_posts','locale'),
    ('telegram_marketing_posts','audience'),
    ('telegram_marketing_posts','chat_id'),
    ('telegram_marketing_posts','content'),
    ('telegram_marketing_posts','buttons'),
    ('telegram_marketing_posts','status'),
    ('telegram_marketing_posts','idempotency_key'),
    ('telegram_marketing_posts','scheduled_for'),
    ('telegram_marketing_posts','attempts'),
    ('telegram_marketing_posts','max_attempts'),
    ('telegram_marketing_posts','last_error'),
    ('telegram_marketing_posts','guard'),
    ('telegram_marketing_posts','telegram_message_id'),
    ('telegram_marketing_posts','approved_by'),
    ('telegram_marketing_posts','approved_at'),
    ('telegram_marketing_posts','published_at'),
    ('telegram_marketing_posts','created_by'),
    ('telegram_marketing_posts','created_at'),
    ('telegram_marketing_posts','updated_at'),
    ('telegram_marketing_subscriptions','telegram_chat_id'),
    ('telegram_marketing_subscriptions','telegram_user_id'),
    ('telegram_marketing_subscriptions','locale'),
    ('telegram_marketing_subscriptions','subscribed'),
    ('telegram_marketing_subscriptions','consent_source'),
    ('telegram_marketing_subscriptions','created_at'),
    ('telegram_marketing_subscriptions','updated_at'),
    ('telegram_marketing_subscriptions','unsubscribed_at'),
    ('telegram_marketing_control','id'),
    ('telegram_marketing_control','paused'),
    ('telegram_marketing_control','dry_run'),
    ('telegram_marketing_control','updated_at'),
    ('telegram_marketing_control','updated_by'),
    ('telegram_marketing_sends','id'),
    ('telegram_marketing_sends','post_id'),
    ('telegram_marketing_sends','audience'),
    ('telegram_marketing_sends','chat_id'),
    ('telegram_marketing_sends','status'),
    ('telegram_marketing_sends','attempt'),
    ('telegram_marketing_sends','telegram_message_id'),
    ('telegram_marketing_sends','error'),
    ('telegram_marketing_sends','created_at')
)
select 'column-038' as check_type,
       e.tbl || '.' || e.col as object_name,
       case when c.column_name is null then 'MISSING' else 'OK' end as status,
       coalesce(c.data_type || ' / nullable=' || c.is_nullable, '(column absent)') as detail
from expected e
left join information_schema.columns c
       on c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.col
order by status desc, object_name;


-- ----------------------------------------------------------------------------
-- 3b. Columns created by 039, 040 and 041
-- ----------------------------------------------------------------------------
with expected(tbl, col, mig) as (
  values
    ('telegram_account_links','id','039'),
    ('telegram_account_links','user_id','039'),
    ('telegram_account_links','token_hash','039'),
    ('telegram_account_links','expires_at','039'),
    ('telegram_account_links','used','039'),
    ('telegram_account_links','telegram_chat_id','039'),
    ('telegram_account_links','telegram_user_id','039'),
    ('telegram_account_links','created_at','039'),
    ('telegram_account_links','used_at','039'),
    ('telegram_account_links','linked_at','039'),
    ('conversion_events','id','040'),
    ('conversion_events','event_type','040'),
    ('conversion_events','dedupe_key','040'),
    ('conversion_events','user_id','040'),
    ('conversion_events','amount','040'),
    ('conversion_events','source','040'),
    ('conversion_events','payload','040'),
    ('conversion_events','occurred_at','040'),
    ('conversion_events','created_at','040'),
    ('conversion_notifications','id','040'),
    ('conversion_notifications','event_id','040'),
    ('conversion_notifications','event_type','040'),
    ('conversion_notifications','category','040'),
    ('conversion_notifications','user_id','040'),
    ('conversion_notifications','idempotency_key','040'),
    ('conversion_notifications','status','040'),
    ('conversion_notifications','attempts','040'),
    ('conversion_notifications','max_attempts','040'),
    ('conversion_notifications','next_attempt_at','040'),
    ('conversion_notifications','lease_expires_at','040'),
    ('conversion_notifications','claimed_by','040'),
    ('conversion_notifications','last_error','040'),
    ('conversion_notifications','skip_reason','040'),
    ('conversion_notifications','sent_at','040'),
    ('conversion_notifications','created_at','040'),
    ('conversion_notifications','updated_at','040'),
    ('deposits','credited','041')
)
select 'column-039-040-041' as check_type,
       e.tbl || '.' || e.col as object_name,
       case when c.column_name is null then 'MISSING' else 'OK' end as status,
       'migration ' || e.mig || coalesce(' / ' || c.data_type || ' / nullable=' || c.is_nullable,
                                         ' / (column absent)') as detail
from expected e
left join information_schema.columns c
       on c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.col
order by status desc, object_name;


-- ----------------------------------------------------------------------------
-- 3c. Columns created by 043 (marketing claim lease)
-- ----------------------------------------------------------------------------
with expected(tbl, col, mig) as (
  values
    ('telegram_marketing_posts','claimed_by','043'),
    ('telegram_marketing_posts','lease_expires_at','043'),
    ('telegram_marketing_posts','last_attempt_at','043')
)
select 'column-043' as check_type,
       e.tbl || '.' || e.col as object_name,
       case when c.column_name is null then 'MISSING' else 'OK' end as status,
       'migration ' || e.mig || coalesce(' / ' || c.data_type || ' / nullable=' || c.is_nullable,
                                         ' / (column absent)') as detail
from expected e
left join information_schema.columns c
       on c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.col
order by status desc, object_name;


-- ----------------------------------------------------------------------------
-- 4. Function signatures (exact, including parameter types)
--    to_regprocedure() is NULL when the function does not exist with exactly
--    that signature. SECURITY DEFINER is required for every RPC the server or
--    a worker calls through PostgREST.
-- ----------------------------------------------------------------------------
with expected(sig, mig, needs_secdef) as (
  values
    -- 043 supersedes the 038 signatures (claimant + lease + fence); the verdict
    -- section accepts EITHER claim signature so a pre-043 database still reads
    -- 038 = APPLIED rather than a false PARTIAL.
    ('public.claim_marketing_posts(timestamp with time zone, integer, text, integer)', '043', true),
    ('public.finish_marketing_post(bigint, boolean, bigint, text, timestamp with time zone, text)', '043', true),
    ('public.block_marketing_post(bigint, text, text)', '043', true),
    ('public.consume_telegram_link_token(text, text, text)', '039', true),
    ('public.conversion_user_is_sandbox(bigint)', '040', true),
    ('public.conversion_record_event(text, text, bigint, numeric, text, jsonb, text)', '040', true),
    ('public.conversion_capture_registration()', '040', true),
    ('public.conversion_capture_deposit()', '040', true),
    ('public.conversion_capture_referral()', '040', true),
    ('public.conversion_claim_notifications(text, integer, integer)', '040', true),
    ('public.conversion_complete_notification(bigint, text, text, integer, text)', '040', true),
    ('public.conversion_enqueue_pending_reminders(integer, integer, integer)', '040', true),
    ('public.conversion_purge(integer, integer)', '040', true),
    ('public.confirm_legacy_deposit_safe(bigint, bigint)', '041', true),
    ('public.conversion_backfill_missing(integer, integer)', '041', true),
    -- 042 re-creates this one; the marker it writes is what makes the next row
    -- possible. 'credited = TRUE' is asserted separately in section 4b.
    ('public.confirm_payment_with_credit(bigint, bigint, numeric, text)', '042', true)
),
resolved as (
  select e.*, to_regprocedure(e.sig) as fn_oid from expected e
)
select 'function' as check_type,
       r.sig as object_name,
       case when r.fn_oid is null then 'MISSING'
            when r.needs_secdef and not p.prosecdef then 'DRIFT'
            else 'OK' end as status,
       'migration ' || r.mig
         || case when r.fn_oid is null then ' / (not installed)'
                 else ' / secdef=' || p.prosecdef::text
                      || ' / args=(' || pg_get_function_identity_arguments(p.oid) || ')'
            end as detail
from resolved r
left join pg_proc p on p.oid = r.fn_oid
order by status desc, object_name;


-- ----------------------------------------------------------------------------
-- 4b. Migration 042: the audit marker inside the credit function
--     Without `credited = TRUE` the 040 trigger records no deposit event, so a
--     confirmed invoice silently produces no customer notification.
-- ----------------------------------------------------------------------------
select 'marker-042' as check_type,
       'confirm_payment_with_credit sets payment_invoices.credited' as object_name,
       case when to_regprocedure('public.confirm_payment_with_credit(bigint, bigint, numeric, text)') is null
                 then 'MISSING'
            when pg_get_functiondef(to_regprocedure('public.confirm_payment_with_credit(bigint, bigint, numeric, text)'))
                 ~ 'status = ''confirmed'',\s+credited = TRUE,'
                 then 'OK'
            else 'DRIFT' end as status,
       case when to_regprocedure('public.confirm_payment_with_credit(bigint, bigint, numeric, text)') is null
                 then 'migration 042 / (function not installed)'
            else 'migration 042 / marker ' ||
                 case when pg_get_functiondef(to_regprocedure('public.confirm_payment_with_credit(bigint, bigint, numeric, text)'))
                           ~ 'status = ''confirmed'',\s+credited = TRUE,'
                      then 'present in the invoice UPDATE'
                      else 'ABSENT - provider credits emit no notification' end
       end as detail;


-- ----------------------------------------------------------------------------
-- 5. Triggers installed by 040 (names come from its DO block)
-- ----------------------------------------------------------------------------
with expected(trg, tbl, mig) as (
  values ('conversion_capture_registration',   'users',            '040'),
         ('conversion_capture_deposit_invoice', 'payment_invoices', '040'),
         ('conversion_capture_deposit_legacy',  'deposits',         '040'),
         ('conversion_capture_referral',        'referrals',        '040')
)
select 'trigger' as check_type,
       e.tbl || '.' || e.trg as object_name,
       case when t.tgname is null then 'MISSING'
            when t.tgenabled = 'D' then 'DRIFT'
            else 'OK' end as status,
       'migration ' || e.mig
         || coalesce(' / enabled=' || t.tgenabled::text
                     || ' / function=' || pn.nspname || '.' || pf.proname,
                     ' / (trigger absent)') as detail
from expected e
left join pg_class c on c.relname = e.tbl
left join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
left join pg_trigger t on t.tgrelid = c.oid and t.tgname = e.trg and not t.tgisinternal
left join pg_proc pf on pf.oid = t.tgfoid
left join pg_namespace pn on pn.oid = pf.pronamespace
order by status desc, object_name;


-- ----------------------------------------------------------------------------
-- 6. Indexes (the UNIQUE ones are load-bearing for idempotency)
-- ----------------------------------------------------------------------------
with expected(idx, tbl, must_be_unique) as (
  values
    ('telegram_marketing_posts_due_idx',           'telegram_marketing_posts',        false),
    ('telegram_marketing_posts_lease_idx',         'telegram_marketing_posts',        false),
    ('telegram_marketing_posts_created_idx',       'telegram_marketing_posts',        false),
    ('telegram_marketing_subscriptions_active_idx','telegram_marketing_subscriptions',false),
    ('telegram_marketing_sends_post_idx',          'telegram_marketing_sends',        false),
    ('telegram_account_links_token_hash_key',      'telegram_account_links',          true),
    ('telegram_account_links_chat_key',            'telegram_account_links',          true),
    ('telegram_account_links_user_key',            'telegram_account_links',          true),
    ('telegram_account_links_pending_idx',         'telegram_account_links',          false),
    ('conversion_events_user_idx',                 'conversion_events',               false),
    ('conversion_events_type_idx',                 'conversion_events',               false),
    ('conversion_notifications_due_idx',           'conversion_notifications',        false),
    ('conversion_notifications_lease_idx',         'conversion_notifications',        false),
    ('conversion_notifications_user_idx',          'conversion_notifications',        false)
)
select 'index' as check_type,
       e.tbl || '.' || e.idx as object_name,
       case when i.indexname is null then 'MISSING'
            when e.must_be_unique and i.indexdef not like 'CREATE UNIQUE%' then 'DRIFT'
            else 'OK' end as status,
       coalesce(i.indexdef, '(index absent)') as detail
from expected e
left join pg_indexes i
       on i.schemaname = 'public' and i.tablename = e.tbl and i.indexname = e.idx
order by status desc, object_name;


-- ----------------------------------------------------------------------------
-- 7. Constraints that encode the state machines and the uniqueness anchors
-- ----------------------------------------------------------------------------
with expected(conname, tbl, mig) as (
  values
    ('telegram_marketing_posts_status_check',   'telegram_marketing_posts',   '038'),
    ('telegram_marketing_posts_locale_check',   'telegram_marketing_posts',   '038'),
    ('telegram_marketing_posts_audience_check', 'telegram_marketing_posts',   '038'),
    ('telegram_marketing_control_singleton',    'telegram_marketing_control', '038'),
    ('telegram_marketing_sends_status_check',   'telegram_marketing_sends',   '038'),
    ('conversion_notifications_status_check',   'conversion_notifications',   '040'),
    ('conversion_notifications_attempts_check', 'conversion_notifications',   '040'),
    ('conversion_notifications_category_check', 'conversion_notifications',   '040'),
    ('conversion_events_type_check',            'conversion_events',          '040'),
    -- uniqueness anchors: these are what make dedupe/idempotency real
    ('telegram_marketing_posts_idempotency_key_key', 'telegram_marketing_posts', '038'),
    ('conversion_events_dedupe_key_key',             'conversion_events',        '040'),
    ('conversion_notifications_key_key',             'conversion_notifications', '040')
)
select 'constraint' as check_type,
       e.tbl || '.' || e.conname as object_name,
       case when k.conname is null then 'MISSING' else 'OK' end as status,
       'migration ' || e.mig
         || coalesce(' / ' || pg_get_constraintdef(k.oid), ' / (constraint absent)') as detail
from expected e
left join pg_constraint k
       on k.conname = e.conname and k.conrelid = to_regclass('public.' || e.tbl)
order by status desc, object_name;


-- ----------------------------------------------------------------------------
-- 8. RLS: enabled, exactly one service_role policy, no anon/public policy
--    (an anon-readable queue or link table would be a security regression)
-- ----------------------------------------------------------------------------
with t(tbl) as (
  values ('telegram_marketing_posts'), ('telegram_marketing_subscriptions'),
         ('telegram_marketing_control'), ('telegram_marketing_sends'),
         ('telegram_account_links'),
         ('conversion_events'), ('conversion_notifications')
),
agg as (
  select t.tbl,
         c.oid is not null as tbl_exists,
         coalesce(c.relrowsecurity, false) as rls_on,
         count(*) filter (where p.roles && array['service_role']::name[]) as svc_policies,
         count(*) filter (where p.roles && array['anon','authenticated','public']::name[]) as open_policies
  from t
  left join pg_class c
         on c.relname = t.tbl and c.relnamespace = 'public'::regnamespace
  left join pg_policies p
         on p.schemaname = 'public' and p.tablename = t.tbl
  group by t.tbl, c.oid, c.relrowsecurity
)
select 'rls' as check_type,
       tbl as object_name,
       case when not tbl_exists        then 'MISSING'
            when not rls_on            then 'DRIFT'
            when svc_policies <> 1     then 'DRIFT'
            when open_policies <> 0    then 'DRIFT'
            else 'OK' end as status,
       'rls=' || rls_on::text
         || ' / service_role policies=' || svc_policies::text
         || ' / anon-or-public policies=' || open_policies::text
         || '  (expected: rls=true, service_role=1, anon/public=0)' as detail
from agg
order by status desc, object_name;


-- ----------------------------------------------------------------------------
-- 9. Grants: the RPCs must not be executable by anon or authenticated
--    (section is skipped gracefully on a database without those roles)
-- ----------------------------------------------------------------------------
with fns(sig) as (
  values ('public.claim_marketing_posts(timestamp with time zone, integer, text, integer)'),
         ('public.finish_marketing_post(bigint, boolean, bigint, text, timestamp with time zone, text)'),
         ('public.block_marketing_post(bigint, text, text)'),
         ('public.confirm_payment_with_credit(bigint, bigint, numeric, text)'),
         ('public.consume_telegram_link_token(text, text, text)'),
         ('public.conversion_claim_notifications(text, integer, integer)'),
         ('public.conversion_complete_notification(bigint, text, text, integer, text)'),
         ('public.confirm_legacy_deposit_safe(bigint, bigint)')
),
probe as (
  select f.sig,
         to_regprocedure(f.sig) as fn_oid,
         to_regrole('anon')          is not null as has_anon,
         to_regrole('authenticated') is not null as has_authenticated
  from fns f
)
select 'grant' as check_type,
       sig as object_name,
       case when fn_oid is null then 'MISSING'
            when not has_anon and not has_authenticated then 'OK'
            when (has_anon          and has_function_privilege('anon',          fn_oid, 'EXECUTE'))
              or (has_authenticated and has_function_privilege('authenticated', fn_oid, 'EXECUTE'))
            then 'DRIFT'
            else 'OK' end as status,
       case when fn_oid is null then '(function absent)'
            when not has_anon and not has_authenticated then '(anon/authenticated roles absent: not a Supabase database)'
            else 'anon_execute='
                 || case when has_anon then has_function_privilege('anon', fn_oid, 'EXECUTE')::text else 'n/a' end
                 || ' / authenticated_execute='
                 || case when has_authenticated then has_function_privilege('authenticated', fn_oid, 'EXECUTE')::text else 'n/a' end
                 || '  (expected: both false)'
       end as detail
from probe
order by status desc, object_name;


-- ----------------------------------------------------------------------------
-- 10. Publisher control state - THE MASTER SWITCH
--     Expected at rest: exactly one row, id = 1, paused = TRUE, dry_run = TRUE.
--     Uses query_to_xml() so the statement also parses when 038 is not applied
--     (query_to_xml executes the inner text only when the table exists).
-- ----------------------------------------------------------------------------
with ctl as (
  select case
           when to_regclass('public.telegram_marketing_control') is null then null
           else query_to_xml(
                  'select count(*)::text as rows,
                          coalesce(bool_or(paused),  false)::text as paused,
                          coalesce(bool_or(dry_run), false)::text as dry_run,
                          coalesce(max(updated_at)::text, '''') as updated_at
                     from public.telegram_marketing_control',
                  false, true, '')
         end as x
)
select 'control-row' as check_type,
       'telegram_marketing_control' as object_name,
       case when x is null then 'MISSING'
            when coalesce((xpath('/row/rows/text()', x))[1]::text, '0') = '0' then 'MISSING'
            when (xpath('/row/paused/text()', x))[1]::text = 'true'
              or (xpath('/row/dry_run/text()', x))[1]::text = 'true' then 'OK'
            else 'REVIEW' end as status,
       case when x is null then '(control table absent - 038 not applied)'
            else 'rows='     || coalesce((xpath('/row/rows/text()', x))[1]::text, '?')
              || ' / paused='   || coalesce((xpath('/row/paused/text()', x))[1]::text, '?')
              || ' / dry_run='  || coalesce((xpath('/row/dry_run/text()', x))[1]::text, '?')
              || ' / updated_at=' || coalesce(nullif((xpath('/row/updated_at/text()', x))[1]::text, ''), 'n/a')
              || '  (REVIEW = publishing is currently ENABLED)'
       end as detail
from ctl;


-- ----------------------------------------------------------------------------
-- 11. Queue volume by status (counts only - no content, no chat ids)
-- ----------------------------------------------------------------------------
with q as (
  select case
           when to_regclass('public.telegram_marketing_posts') is null then null
           else query_to_xml(
                  'select coalesce(string_agg(status || ''='' || n::text, '' / '' order by status), ''(empty)'' ) as posts
                     from (select status, count(*)::int as n from public.telegram_marketing_posts group by status) s',
                  false, true, '')
         end as posts,
         case
           when to_regclass('public.conversion_notifications') is null then null
           else query_to_xml(
                  'select coalesce(string_agg(status || ''='' || n::text, '' / '' order by status), ''(empty)'') as notif
                     from (select status, count(*)::int as n from public.conversion_notifications group by status) s',
                  false, true, '')
         end as notif,
         case
           when to_regclass('public.conversion_events') is null then null
           else query_to_xml(
                  'select coalesce(string_agg(event_type || ''='' || n::text, '' / '' order by event_type), ''(empty)'') as events
                     from (select event_type, count(*)::int as n from public.conversion_events group by event_type) s',
                  false, true, '')
         end as events
)
select 'queue' as check_type, 'telegram_marketing_posts by status' as object_name,
       case when posts  is null then 'MISSING' else 'OK' end as status,
       coalesce((xpath('/row/posts/text()',  posts))[1]::text,  '(table absent)') as detail from q
union all
select 'queue', 'conversion_notifications by status',
       case when notif  is null then 'MISSING' else 'OK' end,
       coalesce((xpath('/row/notif/text()',  notif))[1]::text,  '(table absent)') from q
union all
select 'queue', 'conversion_events by type',
       case when events is null then 'MISSING' else 'OK' end,
       coalesce((xpath('/row/events/text()', events))[1]::text, '(table absent)') from q;


-- ----------------------------------------------------------------------------
-- 12. Orphaned work that no worker will ever finish on its own
--     Marketing (038) has NO lease, so a 'sending' row older than a few minutes
--     is stuck until an operator resets it (defect D2).
--     Conversion (040) DOES have a lease and reclaims itself automatically.
-- ----------------------------------------------------------------------------
with w as (
  select case
           when to_regclass('public.telegram_marketing_posts') is null then null
           else query_to_xml(
                  'select count(*)::text as stuck
                     from public.telegram_marketing_posts
                    where status = ''sending''
                      and coalesce(updated_at, created_at) < now() - interval ''10 minutes''',
                  false, true, '')
         end as post_stuck,
         case
           when to_regclass('public.conversion_notifications') is null then null
           else query_to_xml(
                  'select count(*)::text as expired
                     from public.conversion_notifications
                    where status = ''sending'' and lease_expires_at is not null
                      and lease_expires_at < now()',
                  false, true, '')
         end as lease_expired
)
select 'orphan' as check_type, 'marketing posts stuck in sending (>10 min)' as object_name,
       case when post_stuck   is null then 'MISSING'
            when (xpath('/row/stuck/text()',   post_stuck))[1]::text = '0' then 'OK'
            else 'REVIEW' end as status,
       case when post_stuck is null then '(table absent)'
            else 'count=' || (xpath('/row/stuck/text()', post_stuck))[1]::text
                 || '  (reset these rows or wait for the lease fix)'
       end as detail from w
union all
select 'orphan', 'conversion notifications with expired lease',
       case when lease_expired is null then 'MISSING'
            when (xpath('/row/expired/text()', lease_expired))[1]::text = '0' then 'OK'
            else 'REVIEW' end,
       case when lease_expired is null then '(table absent)'
            else 'count=' || (xpath('/row/expired/text()', lease_expired))[1]::text
                 || '  (self-healing: the next claim reclaims them)'
       end from w;


-- ----------------------------------------------------------------------------
-- 13. Defect D1 impact (aggregate counts only)
--     Confirmed invoices whose credit marker was never set. Their money IS
--     credited, but the 040 trigger requires credited = TRUE, so no Telegram
--     "deposit confirmed" message is produced for them.
--     Legacy deposits are intentionally NOT queried here: `deposits.credited`
--     only exists after 041 (see section 3b for that column check).
-- ----------------------------------------------------------------------------
with d as (
  select case
           when to_regclass('public.payment_invoices') is null then null
           else query_to_xml(
                  'select count(*)::text as confirmed,
                          count(*) filter (where credited is not true)::text as unmarked
                     from public.payment_invoices where status = ''confirmed''',
                  false, true, '')
         end as inv
)
select 'd1-impact' as check_type,
       'payment_invoices: confirmed but not credited' as object_name,
       case when inv is null then 'MISSING'
            when (xpath('/row/unmarked/text()', inv))[1]::text = '0' then 'OK'
            else 'REVIEW' end as status,
       case when inv is null then '(table absent)'
            else 'unmarked=' || (xpath('/row/unmarked/text()',  inv))[1]::text
              || ' / total confirmed=' || (xpath('/row/confirmed/text()', inv))[1]::text
              || '  (REVIEW = these deposits produced no notification; no money is affected)'
       end as detail
from d;


-- ----------------------------------------------------------------------------
-- 14. VERDICT - which migrations are applied, and the next action
-- ----------------------------------------------------------------------------
with probe as (
  select
    (to_regclass('public.telegram_marketing_posts')        is not null) as t_posts,
    (to_regclass('public.telegram_marketing_control')      is not null) as t_control,
    (to_regclass('public.telegram_marketing_sends')        is not null) as t_sends,
    (to_regclass('public.telegram_marketing_subscriptions') is not null) as t_subs,
    -- 038 or 043 signature: the table contract is what 038 owns.
    (to_regprocedure('public.claim_marketing_posts(timestamp with time zone, integer)') is not null
     or to_regprocedure('public.claim_marketing_posts(timestamp with time zone, integer, text, integer)') is not null) as f_claim,
    (to_regclass('public.telegram_account_links') is not null) as t_links,
    (to_regprocedure('public.consume_telegram_link_token(text, text, text)') is not null) as f_consume,
    (to_regclass('public.conversion_events')        is not null) as t_events,
    (to_regclass('public.conversion_notifications') is not null) as t_outbox,
    (to_regprocedure('public.conversion_claim_notifications(text, integer, integer)') is not null) as f_claim_notif,
    (to_regprocedure('public.confirm_legacy_deposit_safe(bigint, bigint)') is not null) as f_legacy,
    (to_regprocedure('public.conversion_backfill_missing(integer, integer)') is not null) as f_backfill,
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'deposits'
               and column_name = 'credited') as c_deposits_credited,
    -- 042: the credit function and the marker it must write.
    (to_regprocedure('public.confirm_payment_with_credit(bigint, bigint, numeric, text)') is not null) as f_credit,
    coalesce(
      (select pg_get_functiondef(to_regprocedure('public.confirm_payment_with_credit(bigint, bigint, numeric, text)'))
              ~ 'status = ''confirmed'',\s+credited = TRUE,'), false) as m_marker,
    -- 043: the lease columns and the superseding signatures.
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'telegram_marketing_posts'
        and column_name in ('claimed_by', 'lease_expires_at', 'last_attempt_at')) as n_lease_cols,
    (to_regprocedure('public.claim_marketing_posts(timestamp with time zone, integer, text, integer)') is not null) as f_claim_lease,
    (to_regprocedure('public.finish_marketing_post(bigint, boolean, bigint, text, timestamp with time zone, text)') is not null) as f_finish_lease
)
select 'verdict' as check_type, '038 marketing broadcast' as object_name,
       case when t_posts and t_control and t_sends and t_subs and f_claim then 'APPLIED'
            when not (t_posts or t_control or t_sends or t_subs or f_claim) then 'NOT APPLIED'
            else 'PARTIAL' end as status,
       'tables posts/control/sends/subscriptions + claim_marketing_posts()' as detail
from probe
union all
select 'verdict', '039 telegram account links',
       case when t_links and f_consume then 'APPLIED'
            when not (t_links or f_consume) then 'NOT APPLIED'
            else 'PARTIAL' end,
       'telegram_account_links + consume_telegram_link_token()'
from probe
union all
select 'verdict', '040 conversion events + outbox',
       case when t_events and t_outbox and f_claim_notif then 'APPLIED'
            when not (t_events or t_outbox or f_claim_notif) then 'NOT APPLIED'
            else 'PARTIAL' end,
       'conversion_events + conversion_notifications + conversion_claim_notifications()'
from probe
union all
select 'verdict', '041 legacy deposit credit',
       case when c_deposits_credited and f_legacy and f_backfill then 'APPLIED'
            when not (c_deposits_credited or f_legacy or f_backfill) then 'NOT APPLIED'
            else 'PARTIAL' end,
       'deposits.credited + confirm_legacy_deposit_safe() + conversion_backfill_missing()'
from probe
union all
select 'verdict', '042 provider credit marker',
       case when m_marker then 'APPLIED'
            when not f_credit then 'NOT APPLIED'
            else 'NOT APPLIED' end,
       case when m_marker then 'credited = TRUE present in the invoice UPDATE'
            when not f_credit then 'confirm_payment_with_credit is missing entirely'
            else 'function present but the marker is ABSENT - provider credits emit no notification' end
from probe
union all
select 'verdict', '043 marketing claim lease',
       case when n_lease_cols = 3 and f_claim_lease and f_finish_lease then 'APPLIED'
            when n_lease_cols = 0 and not f_claim_lease and not f_finish_lease then 'NOT APPLIED'
            else 'PARTIAL' end,
       'claimed_by/lease_expires_at/last_attempt_at + the 4-arg claim and 6-arg fenced finish'
from probe
union all
select 'verdict', 'NEXT ACTION',
       case
         when not (t_posts or t_links or t_events)
           then 'Apply 038, then 039, then 040 + 041 together'
         when t_posts and not t_links
           then 'Apply 039, then 040 + 041 together'
         when t_links and not t_events
           then 'Apply 040 + 041 together'
         when t_events and not c_deposits_credited
           then 'Apply 041 now (040 alone suppresses legacy deposit events)'
         when t_events and c_deposits_credited and not f_backfill
           then 'Re-apply 041 (backfill RPC missing)'
         when not m_marker
           then 'Apply 042 (provider credits currently emit no deposit notification)'
         when m_marker and n_lease_cols <> 3
           then 'Apply 043 (a crashed marketing claim cannot be recovered)'
         when m_marker and n_lease_cols = 3 and not f_claim_lease
           then 'Re-apply 043 (the lease claim signature is missing)'
         when m_marker and n_lease_cols = 3 and f_claim_lease and not f_finish_lease
           then 'Re-apply 043 (the fenced finish signature is missing)'
         when t_posts and t_links and t_events and c_deposits_credited and f_backfill and m_marker and n_lease_cols = 3
           then 'No migration work required for 038-043'
         else 'Review the individual rows above'
       end,
       'derived from the object probes above'
from probe;
