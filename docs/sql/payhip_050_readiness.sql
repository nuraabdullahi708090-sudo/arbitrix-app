-- ============================================================================
-- payhip_050_readiness.sql
--
-- READ-ONLY pre-flight for supabase/migrations/050_payhip_live_activation.sql.
--
-- Run this in the Supabase SQL Editor BEFORE applying 050. It changes nothing:
-- every statement is a SELECT over the catalogues.
--
-- It answers the questions that actually decide whether 050 can be applied:
--   1. does public.users exist, and is users.id BIGINT?
--      (050 declares  payhip_entitlements.user_id BIGINT REFERENCES users(id) -
--       a UUID primary key would abort the whole migration on the FK)
--   2. do the anon / authenticated / service_role roles exist?
--      (the GRANT statements name them, so a missing role is a hard error)
--   3. are the payhip objects ABSENT?
--      Every CREATE uses IF NOT EXISTS, which means a PARTIALLY created object is
--      kept as-is and missing columns are never added. A partial set is therefore
--      the one state that must be inspected by hand, not "just re-run".
--
-- Read the NEXT ACTION row at the bottom, then follow
-- docs/relaunch/10-RELEASE-CHECKLIST.md section 3.1.
-- ============================================================================

with
users_tbl as (
  select c.oid,
         coalesce((
           select a.atttypid::regtype::text
             from pg_attribute a
            where a.attrelid = c.oid and a.attname = 'id'
              and a.attnum > 0 and not a.attisdropped
         ), '(no id column)') as id_type
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'users' and c.relkind = 'r'
),
objs as (
  select 'table' as kind, c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relname in ('payhip_products','payhip_purchases','payhip_entitlements','payhip_events')
  union all
  select 'sequence', c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'S'
     and c.relname in ('payhip_products_id_seq','payhip_purchases_id_seq',
                       'payhip_entitlements_id_seq','payhip_events_id_seq')
  union all
  select 'function', p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('record_payhip_purchase_safe','redeem_payhip_entitlement_safe',
                       'revoke_payhip_entitlement_safe','payhip_has_live_activation')
),
facts as (
  select
    (select count(*) from users_tbl)                                as users_tables,
    (select id_type from users_tbl)                                 as users_id_type,
    (select count(*) from pg_roles where rolname = 'anon')           as has_anon,
    (select count(*) from pg_roles where rolname = 'authenticated')  as has_authenticated,
    (select count(*) from pg_roles where rolname = 'service_role')   as has_service_role,
    (select coalesce(string_agg(kind || ':' || name, ', ' order by kind, name), '(none)')
       from objs)                                                   as existing_objects,
    (select count(*) from objs)                                      as existing_count,
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'S'
        and c.relname in ('payhip_products_id_seq','payhip_purchases_id_seq',
                          'payhip_entitlements_id_seq','payhip_events_id_seq')) as existing_sequences
)
select * from (
  select 1 as ord, 'public.users exists' as check_name,
         case when f.users_tables = 1 then 'OK' else 'BLOCKER' end as status,
         case when f.users_tables = 1 then 'found' else 'not found - 050 cannot be applied' end as detail
    from facts f
  union all
  select 2, 'users.id is BIGINT',
         case when f.users_id_type = 'bigint' then 'OK'
              when f.users_id_type = '(no id column)' then 'BLOCKER'
              else 'BLOCKER' end,
         coalesce(f.users_id_type, '(unknown)') ||
         case when f.users_id_type = 'bigint' then ' - FK-compatible with payhip_entitlements.user_id'
              else ' - NOT compatible: 050 declares user_id BIGINT REFERENCES users(id)' end
    from facts f
  union all
  select 3, 'role anon exists',
         case when f.has_anon = 1 then 'OK' else 'BLOCKER' end,
         case when f.has_anon = 1 then 'found' else 'missing - the REVOKE would fail' end
    from facts f
  union all
  select 4, 'role authenticated exists',
         case when f.has_authenticated = 1 then 'OK' else 'BLOCKER' end,
         case when f.has_authenticated = 1 then 'found' else 'missing - the REVOKE would fail' end
    from facts f
  union all
  select 5, 'role service_role exists',
         case when f.has_service_role = 1 then 'OK' else 'BLOCKER' end,
         case when f.has_service_role = 1 then 'found' else 'missing - the GRANT would fail' end
    from facts f
  union all
  select 6, 'payhip objects present',
         case when f.existing_count = 0 then 'OK'
              when f.existing_count >= 11 then 'INFO'
              else 'REVIEW' end,
         case when f.existing_count = 0 then '(none - a fresh apply will create all 11)'
              else f.existing_objects end
    from facts f
  union all
  select 7, 'sequence names available',
         case when f.existing_sequences = 0 then 'OK'
              when f.existing_count >= 11 then 'OK'
              else 'REVIEW' end,
         case when f.existing_sequences = 0 then 'all names are free'
              when f.existing_count >= 11 then 'the three sequences belong to the existing apply'
              else 'some sequences exist without the full object set - a partial apply is present' end
    from facts f
  union all
  select 8, 'NEXT ACTION', 'INFO',
         case
           when (select users_tables from facts) <> 1
             or (select users_id_type from facts) is distinct from 'bigint'
             or (select has_anon from facts) <> 1
             or (select has_authenticated from facts) <> 1
             or (select has_service_role from facts) <> 1
             then 'DO NOT APPLY - resolve the BLOCKER rows first'
           when (select existing_count from facts) = 0
             then 'READY - apply supabase/migrations/050_payhip_live_activation.sql, then run payhip_050_postcheck.sql'
           when (select existing_count from facts) >= 11
             then 'ALREADY APPLIED - do not re-run blindly; run payhip_050_postcheck.sql'
           else 'PARTIAL APPLY - inspect the listed objects by hand before doing anything'
         end
    from facts f
) rows
order by rows.ord;
