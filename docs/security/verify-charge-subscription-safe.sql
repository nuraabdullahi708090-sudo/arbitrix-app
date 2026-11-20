-- ============================================================================
-- READ-ONLY VERIFICATION - public.charge_subscription_safe
-- ============================================================================
-- Run this BEFORE and AFTER docs/security/hotfix-charge-subscription-safe.sql.
--
--   * It contains SELECT statements only. It never calls the function, never
--     writes, never changes a privilege.
--   * Run it in the Supabase SQL editor (or psql) as a role that can read
--     pg_catalog - `postgres` in the SQL editor is fine.
--   * Result columns: #, check, observed, expected, status.
--     status = PASS  -> the safe state holds
--              FAIL  -> the exposure is present (or the state is unexpected)
--              INFO  -> informational, not a verdict on its own
--   * EXPECTED SAFE RESULT: rows 1-4 PASS/INFO, row 5 PASS (search_path pinned),
--     rows 6-8 PASS (anon/authenticated/PUBLIC cannot execute), row 9 PASS
--     (service_role can execute), row 10 PASS (no unexpected overload).
-- ============================================================================

with target as (
    select to_regprocedure('public.charge_subscription_safe(bigint,numeric,text,text,text)') as oid
),
fn as (
    select p.*, pg_get_userbyid(p.proowner) as owner_name, l.lanname
    from pg_proc p
    join pg_language l on l.oid = p.prolang
    where p.oid = (select oid from target)
),
acl as (
    select coalesce(
             string_agg(
               case when a.grantee = 0 then 'PUBLIC'
                    else pg_get_userbyid(a.grantee) end
               || ':' || a.privilege_type, ', ' order by a.grantee, a.privilege_type),
             '(no explicit grants - owner only + PostgreSQL default)') as acl_text
    -- aclexplode() rejects an EMPTY array ("ACL arrays must be one-dimensional"),
    -- so a default (NULL) ACL is passed through as NULL, which yields no rows.
    from fn, aclexplode(case when fn.proacl is null or cardinality(fn.proacl) = 0
                             then null else fn.proacl end) a
),
overloads as (
    select coalesce(string_agg(p.oid::regprocedure::text, ' ; ' order by p.oid::regprocedure::text), '(none)') as list,
           count(*) as n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'charge_subscription_safe'
      and p.oid <> coalesce((select oid from target), 0)
)
select * from (
    select 1 as "#", 'function exists (public.charge_subscription_safe(bigint,numeric,text,text,text))' as check,
           case when (select oid from target) is null then 'MISSING' else 'present' end as observed,
           'present' as expected,
           case when (select oid from target) is null then 'FAIL' else 'PASS' end as status
    union all
    select 2, 'owner / security mode / language',
           coalesce((select owner_name || ' / ' ||
                     case when prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end ||
                     ' / ' || lanname from fn), 'n/a'),
           'postgres / SECURITY DEFINER / plpgsql',
           case when exists (select 1 from fn where prosecdef and lanname = 'plpgsql') then 'PASS'
                when exists (select 1 from fn) then 'FAIL' else 'FAIL' end
    union all
    select 3, 'function body hash (changes only if the definition changes)',
           coalesce((select md5(prosrc) from fn), 'n/a'),
           'recorded value - compare before/after the hotfix',
           'INFO'
    union all
    select 4, 'effective EXECUTE privileges (ACL)',
           coalesce((select acl_text from acl), 'n/a'),
           'postgres:EXECUTE (owner) + service_role:EXECUTE - nothing else',
           'INFO'
    union all
    select 5, 'search_path pinned on the function',
           coalesce((select array_to_string(proconfig, ',') from fn), '(none)'),
           'search_path=public, pg_temp',
           case when exists (select 1 from fn)
                     and (select array_to_string(proconfig, ',') from fn) ~ 'search_path=public, ?pg_temp'
                then 'PASS' else 'FAIL' end
    union all
    select 6, 'anon can EXECUTE',
           case when (select oid from target) is null then 'n/a'
                else has_function_privilege('anon', (select oid from target), 'EXECUTE')::text end,
           'false',
           case when (select oid from target) is null then 'FAIL'
                when has_function_privilege('anon', (select oid from target), 'EXECUTE') then 'FAIL'
                else 'PASS' end
    union all
    select 7, 'authenticated can EXECUTE',
           case when (select oid from target) is null then 'n/a'
                else has_function_privilege('authenticated', (select oid from target), 'EXECUTE')::text end,
           'false',
           case when (select oid from target) is null then 'FAIL'
                when has_function_privilege('authenticated', (select oid from target), 'EXECUTE') then 'FAIL'
                else 'PASS' end
    union all
    -- Informational when the ACL is the PostgreSQL DEFAULT (proacl IS NULL): in
    -- that state PUBLIC's EXECUTE is implicit, which is exactly what rows 6 and 7
    -- measure. FAIL only when an EXPLICIT PUBLIC grant survived a revoke.
    select 8, 'PUBLIC holds an explicit EXECUTE grant (INFO when the ACL is default)',
           case when (select oid from target) is null then 'n/a'
                else (select exists (
                        select 1 from fn, aclexplode(case when fn.proacl is null or cardinality(fn.proacl) = 0
                                                          then null else fn.proacl end) a
                        where a.grantee = 0 and a.privilege_type = 'EXECUTE'))::text end,
           'false',
           case when (select oid from target) is null then 'FAIL'
                when (select exists (
                        select 1 from fn, aclexplode(case when fn.proacl is null or cardinality(fn.proacl) = 0
                                                          then null else fn.proacl end) a
                        where a.grantee = 0 and a.privilege_type = 'EXECUTE')) then 'FAIL'
                when (select proacl from fn) is null then 'INFO'
                else 'PASS' end
    union all
    select 9, 'service_role can EXECUTE (the legitimate application caller)',
           case when (select oid from target) is null then 'n/a'
                when not exists (select 1 from pg_roles where rolname = 'service_role') then 'role absent'
                else has_function_privilege('service_role', (select oid from target), 'EXECUTE')::text end,
           'true',
           case when (select oid from target) is null then 'FAIL'
                when not exists (select 1 from pg_roles where rolname = 'service_role') then 'FAIL'
                when has_function_privilege('service_role', (select oid from target), 'EXECUTE') then 'PASS'
                else 'FAIL' end
    union all
    select 10, 'unexpected overloads of charge_subscription_safe in schema public',
           (select list from overloads) || '  [count=' || (select n from overloads)::text || ']',
           '(none)',
           case when (select n from overloads) = 0 then 'PASS' else 'FAIL' end
) report
order by "#";

-- ---------------------------------------------------------------------------
-- Independent second look at the same facts straight from the catalogs. Use it
-- if the report above is ambiguous; it is also read-only.
-- ---------------------------------------------------------------------------
select p.oid::regprocedure::text                                   as signature,
       pg_get_userbyid(p.proowner)                                 as owner,
       p.prosecdef                                                 as security_definer,
       coalesce(array_to_string(p.proconfig, ', '), '(none)')       as proconfig,
       coalesce(array_to_string(p.proacl, ' | '), '(null = default ACL)') as proacl,
       pg_get_function_result(p.oid)                               as returns,
       md5(p.prosrc)                                               as body_md5
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'charge_subscription_safe';
