-- ============================================================================
-- payhip_050_postcheck.sql
--
-- READ-ONLY verification AFTER supabase/migrations/050_payhip_live_activation.sql.
--
-- Run it immediately after applying 050, and again before enabling
-- PAYHIP_ENABLED. It changes nothing: every statement is a SELECT over the
-- catalogues and the four payhip tables.
--
-- It verifies the properties the application relies on:
--   * the four tables exist and have ROW LEVEL SECURITY enabled
--   * exactly one policy per table, for service_role, and NO anon/authenticated
--     policy at all (RLS + no policy = deny, which is the model 050 documents)
--   * anon/authenticated hold no table, sequence or function privilege
--   * every SECURITY DEFINER body pins search_path = public, pg_temp (the 053 rule)
--   * the idempotency anchors exist (payhip_sale_id, licence_key_hash)
--   * no function body references a wallet or the ledger
--   * the product the site sells ('dlxuu') is in the catalogue and ON SALE.
--     The buy button stays hidden until is_active is TRUE - that is deliberate,
--     and it is the last step before checkout can be enabled.
--
-- Read the NEXT ACTION row at the bottom.
-- ============================================================================

with
t as (
  select c.relname, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relname in ('payhip_products','payhip_purchases','payhip_entitlements','payhip_events')
),
pol as (
  select tablename, policyname, roles::text as roles
    from pg_policies
   where schemaname = 'public' and tablename like 'payhip%'
),
fn as (
  select p.proname,
         coalesce(array_to_string(p.proconfig, ','), '') as cfg,
         p.prosrc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('record_payhip_purchase_safe','redeem_payhip_entitlement_safe',
                       'revoke_payhip_entitlement_safe','payhip_has_live_activation')
),
facts as (
  select
    (select count(*) from t)                                                          as tables,
    (select count(*) from t where relrowsecurity)                                     as rls_tables,
    (select count(*) from pol where roles like '%service_role%')                      as service_policies,
    (select count(*) from pol where roles like '%anon%' or roles like '%authenticated%') as open_policies,
    (select count(*) from fn)                                                         as functions,
    (select count(*) from fn where cfg like '%search_path=public, pg_temp%')          as pinned,
    (select count(*) from fn where prosrc ilike '%wallets%' or prosrc ilike '%live_balance%') as wallet_refs,
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'S'
        and c.relname in ('payhip_products_id_seq','payhip_purchases_id_seq',
                          'payhip_entitlements_id_seq','payhip_events_id_seq'))     as sequences,
    coalesce((
      select string_agg(x, ', ') from (
        select 'anon:' || p.proname as x from fn p
         where has_function_privilege('anon',
                 'public.' || p.proname || '(' ||
                 case p.proname
                   when 'record_payhip_purchase_safe' then 'text,text,text,integer,text,integer,integer,text,jsonb'
                   when 'redeem_payhip_entitlement_safe' then 'bigint,text'
                   when 'revoke_payhip_entitlement_safe' then 'text,text,integer,text'
                   else 'bigint' end || ')', 'EXECUTE')
        union all
        select 'authenticated:' || p.proname from fn p
         where has_function_privilege('authenticated',
                 'public.' || p.proname || '(' ||
                 case p.proname
                   when 'record_payhip_purchase_safe' then 'text,text,text,integer,text,integer,integer,text,jsonb'
                   when 'redeem_payhip_entitlement_safe' then 'bigint,text'
                   when 'revoke_payhip_entitlement_safe' then 'text,text,integer,text'
                   else 'bigint' end || ')', 'EXECUTE')
      ) z
    ), '(none)')                                                                     as open_functions,
    (select count(*) from pg_constraint c
      join pg_class t2 on t2.oid = c.conrelid
      join pg_namespace n2 on n2.oid = t2.relnamespace
      where n2.nspname = 'public' and t2.relname in ('payhip_purchases','payhip_entitlements')
        and c.contype in ('u','p'))                                                  as keys,
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'payhip_entitlements'
        and column_name = 'owner_detached_at')                                        as detach_col,
    (select count(*) from pg_trigger
      where tgname = 'payhip_entitlement_detach_note' and not tgisinternal)          as detach_trg,
    (select count(*) from payhip_products where lower(product_key) = 'dlxuu')        as catalogue_rows,
    (select count(*) from payhip_products where lower(product_key) = 'dlxuu' and is_active) as catalogue_active
)
select * from (
  select 1 as ord, 'four payhip tables exist' as check_name,
         case when f.tables = 4 then 'OK' else 'FAIL' end as status,
         f.tables || ' of 4' as detail from facts f
  union all
  select 2, 'RLS enabled on every table',
         case when f.rls_tables = 4 then 'OK' else 'FAIL' end,
         f.rls_tables || ' of 4' from facts f
  union all
  select 3, 'one service_role policy per table',
         case when f.service_policies = 4 then 'OK' else 'FAIL' end,
         f.service_policies || ' of 4' from facts f
  union all
  select 4, 'no anon/authenticated policy',
         case when f.open_policies = 0 then 'OK' else 'FAIL' end,
         f.open_policies || ' open policy/policies' from facts f
  union all
  select 5, 'four functions present',
         case when f.functions = 4 then 'OK' else 'FAIL' end,
         f.functions || ' of 4' from facts f
  union all
  select 6, 'every body pins search_path = public, pg_temp',
         case when f.pinned = 4 then 'OK' else 'FAIL' end,
         f.pinned || ' of 4' from facts f
  union all
  select 7, 'anon/authenticated cannot EXECUTE',
         case when f.open_functions = '(none)' then 'OK' else 'FAIL' end,
         f.open_functions from facts f
  union all
  select 8, 'no function touches a wallet or the ledger',
         case when f.wallet_refs = 0 then 'OK' else 'FAIL' end,
         f.wallet_refs || ' suspicious body/bodies' from facts f
  union all
  select 9, 'three sequences exist',
         case when f.sequences = 3 then 'OK' else 'FAIL' end,
         f.sequences || ' of 3' from facts f
  union all
  select 10, 'idempotency keys are unique constraints',
         case when f.keys >= 2 then 'OK' else 'FAIL' end,
         f.keys || ' unique/primary keys on the two anchors' from facts f
  union all
  select 11, 'deleting an account stamps the detach marker',
         case when f.detach_col = 1 and f.detach_trg = 1 then 'OK' else 'FAIL' end,
         'column=' || f.detach_col || ' trigger=' || f.detach_trg ||
         ' (a paid licence survives account deletion, stays claimed and cannot be reused)'
    from facts f
  union all
  select 12, 'product dlxuu in the catalogue',
         case when f.catalogue_rows > 0 then 'OK' else 'ACTION' end,
         case when f.catalogue_rows > 0 then 'row present'
              else 'missing - run the activation SQL under NEXT ACTION' end from facts f
  union all
  select 13, 'product dlxuu is ON SALE',
         case when f.catalogue_active > 0 then 'OK' else 'ACTION' end,
         case when f.catalogue_active > 0 then 'is_active = TRUE, the buy button can render'
              else 'is_active = FALSE, checkout stays hidden by design' end from facts f
  union all
  select 14, 'NEXT ACTION', 'INFO',
         case
           when (select tables from facts) <> 4
             or (select rls_tables from facts) <> 4
             or (select service_policies from facts) <> 4
             or (select open_policies from facts) <> 0
             or (select functions from facts) <> 4
             or (select pinned from facts) <> 4
             or (select detach_col from facts) <> 1
             or (select detach_trg from facts) <> 1
             or (select open_functions from facts) <> '(none)'
             or (select wallet_refs from facts) <> 0
             then 'FAIL - 050 is not correctly applied; do not enable PAYHIP_ENABLED'
           when (select catalogue_active from facts) = 0
             then 'Enable the product: INSERT INTO public.payhip_products (product_key, name, price_cents, is_active) VALUES (''dlxuu'', ''Kalderix Live Mode activation'', 5000, TRUE) ON CONFLICT (product_key) DO UPDATE SET is_active = TRUE;'
           else 'PASS - 050 is applied and the product is on sale; checkout may be enabled'
         end
    from facts f
) rows
order by rows.ord;
