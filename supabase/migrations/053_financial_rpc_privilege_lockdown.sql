-- ============================================================================
-- 053 - EXECUTE privileges for the remaining financial-adjacent RPCs
-- ============================================================================
-- Completes the work started by migration 014 (record_trade_safe,
-- credit_payment_safe, paymento_credit_user_safe) and finished for the
-- subscription debit by 051/052 (charge_subscription_safe).
--
-- AUDIT RESULT (docs/security/FINAL-SECURITY-CLOSURE-REPORT.md)
--   After 014 + 051/052, every function that moves real money is already
--   service_role-only. Ten functions in the money-adjacent surface were still
--   reachable by PUBLIC/anon/authenticated because PostgreSQL grants EXECUTE to
--   PUBLIC by default and no REVOKE was ever issued for them:
--
--   public.mark_expired_invoices()
--       SECURITY DEFINER, no search_path, NO application caller. Writes
--       payment_invoices.status='expired' but ONLY where expires_at < now(),
--       so an anonymous caller can do nothing the clock would not do anyway.
--       Benign, hardened here for defence in depth.
--
--   public.paymento_check_duplicate_webhook(text, bigint)
--       SECURITY DEFINER, no search_path, NO application caller. READ-ONLY, but
--       it returns another customer's invoice_id, status, credited, amount_usd,
--       user_id, settlement_address, provider_tx_hash and confirmations for a
--       caller-supplied token OR sequential provider_payment_id. That is a
--       deposit-data disclosure to anonymous callers. This is the one genuine
--       finding in this migration.
--
--   the MARKETING_SANDBOX money functions created by 013:
--       sandbox_ensure_wallet, sandbox_set_balance, sandbox_credit_deposit,
--       sandbox_record_trade, sandbox_charge_subscription,
--       sandbox_request_withdrawal, sandbox_set_withdrawal_status,
--       sandbox_reset_account (036 locks the last one only when it is applied;
--       locking an already-locked function is a no-op).
--       Every one calls assert_sandbox_user(), which RAISES for a production
--       account, so no production balance is reachable. They are locked because
--       they are wallet-balance functions, because an anonymous caller should
--       not be able to drive them at all, and because an unpinned search_path
--       would let a shadowed `users` table defeat that guard.
--
-- SCOPE: privileges and search_path ONLY. No body is recreated, no table, row,
--        policy, role, index or unrelated function is touched, and the
--        postcondition proves that no OTHER function's effective privileges
--        changed.
--
-- Idempotent: every statement is a no-op on the second run.
-- Fails safe: aborts without changing anything if the two payment functions are
--        absent (they come from migrations 002 and 007 and every deployment of
--        this application has them). Absent sandbox functions are skipped with a
--        NOTICE, because migration 013 is not applied everywhere.
-- ============================================================================

begin;

-- ---------------------------------------------------------------- preconditions
do $pre$
begin
    if to_regprocedure('public.mark_expired_invoices()') is null then
        raise exception
            '053 ABORTED: public.mark_expired_invoices() does not exist (migration 002 missing). Nothing was changed.';
    end if;
    if to_regprocedure('public.paymento_check_duplicate_webhook(text,bigint)') is null then
        raise exception
            '053 ABORTED: public.paymento_check_duplicate_webhook(text,bigint) does not exist (migration 007 missing). Nothing was changed.';
    end if;
end
$pre$;

-- Target list. Absent entries are skipped (see the loop), so the same file
-- works on a database where migration 013 or 036 was never applied.
create temporary table _m53_targets (sig text primary key) on commit drop;
insert into _m53_targets (sig) values
    ('public.mark_expired_invoices()'),
    ('public.paymento_check_duplicate_webhook(text,bigint)'),
    ('public.sandbox_ensure_wallet(bigint)'),
    ('public.sandbox_set_balance(bigint,numeric)'),
    ('public.sandbox_credit_deposit(bigint,text)'),
    ('public.sandbox_record_trade(bigint,numeric,text,text,text)'),
    ('public.sandbox_charge_subscription(bigint,numeric,text,text,text)'),
    ('public.sandbox_request_withdrawal(bigint,numeric,text)'),
    ('public.sandbox_set_withdrawal_status(bigint,bigint,text)'),
    ('public.sandbox_reset_account(bigint)');

-- Body hashes and the effective-privilege baseline for EVERY public function,
-- so the postcondition can prove nothing outside the target list changed.
create temporary table _m53_before on commit drop as
select p.oid,
       p.oid::regprocedure::text as sig,
       md5(p.prosrc)             as body_md5,
       p.prosecdef               as secdef,
       pg_get_function_identity_arguments(p.oid) as args,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_before,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_before
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public';

-- ------------------------------------------------------------------- the fix
do $lockdown$
declare
    t     record;
    v_oid oid;
    v_sig text;
    n_done int := 0;
    n_skip int := 0;
begin
    for t in select sig from _m53_targets order by sig loop
        v_oid := to_regprocedure(t.sig);

        if v_oid is null then
            raise notice '053 SKIP: % does not exist (migration not applied) - nothing to lock', t.sig;
            n_skip := n_skip + 1;
            continue;
        end if;

        if not (select prosecdef from pg_proc where oid = v_oid) then
            -- Not a privilege-escalation risk if it runs with caller rights, but
            -- it is not the expected shape; report it instead of silently
            -- re-granting.
            raise notice '053 NOTE: % is SECURITY INVOKER - left for manual review', t.sig;
            n_skip := n_skip + 1;
            continue;
        end if;

        v_sig := v_oid::regprocedure::text;
        execute format('alter function %s set search_path = public, pg_temp', v_sig);
        execute format('revoke all on function %s from public', v_sig);
        execute format('revoke all on function %s from anon', v_sig);
        execute format('revoke all on function %s from authenticated', v_sig);
        execute format('grant execute on function %s to service_role', v_sig);
        n_done := n_done + 1;
    end loop;

    raise notice '053: locked % function(s), skipped %', n_done, n_skip;
end
$lockdown$;

-- ---------------------------------------------------------------- postconditions
do $post$
declare
    r        record;
    v_state  _m53_before;
    v_cfg    text;
    v_pub    boolean;
    v_changed int;
begin
    -- 1. every target that exists is now service_role-only, pinned, unchanged
    for r in
        select t.sig, to_regprocedure(t.sig) as oid
        from _m53_targets t
        where to_regprocedure(t.sig) is not null
        order by t.sig
    loop
        if not (select prosecdef from pg_proc where oid = r.oid) then
            continue;  -- reported by the loop above
        end if;

        if has_function_privilege('anon', r.oid, 'EXECUTE') then
            raise exception '053 FAILED: anon can still EXECUTE %', r.sig;
        end if;
        if has_function_privilege('authenticated', r.oid, 'EXECUTE') then
            raise exception '053 FAILED: authenticated can still EXECUTE %', r.sig;
        end if;
        if not has_function_privilege('service_role', r.oid, 'EXECUTE') then
            raise exception '053 FAILED: service_role lost EXECUTE on %', r.sig;
        end if;

        select exists (
            select 1 from pg_proc p,
                 aclexplode(case when p.proacl is null or cardinality(p.proacl) = 0
                                 then null else p.proacl end) a
            where p.oid = r.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'
        ) into v_pub;
        if v_pub then
            raise exception '053 FAILED: PUBLIC still holds an explicit EXECUTE grant on %', r.sig;
        end if;

        select coalesce(array_to_string(proconfig, ','), '') into v_cfg from pg_proc where oid = r.oid;
        if v_cfg !~ 'search_path=public, ?pg_temp' then
            raise exception '053 FAILED: search_path is not pinned on % (proconfig=%)', r.sig, v_cfg;
        end if;

        select * into v_state from _m53_before where oid = r.oid;
        if md5((select prosrc from pg_proc where oid = r.oid)) <> v_state.body_md5 then
            raise exception '053 FAILED: the body of % changed', r.sig;
        end if;
        if pg_get_function_identity_arguments(r.oid) <> v_state.args
           or (select prosecdef from pg_proc where oid = r.oid) is distinct from v_state.secdef then
            raise exception '053 FAILED: the signature or security mode of % changed', r.sig;
        end if;
    end loop;

    -- 2. no function outside the target list lost or gained anon/authenticated
    --    EXECUTE (catches an accidental over-broad revoke)
    -- compare by OID: _m53_before.sig is regprocedure::text, which omits the
    -- schema prefix that the target list spells out explicitly.
    select count(*) into v_changed
    from _m53_before b
    where to_regprocedure(b.sig) not in (select to_regprocedure(sig) from _m53_targets)
      and (   has_function_privilege('anon', b.oid, 'EXECUTE') <> b.anon_before
           or has_function_privilege('authenticated', b.oid, 'EXECUTE') <> b.auth_before);
    if v_changed > 0 then
        raise exception '053 FAILED: % function(s) outside the target list changed privileges', v_changed;
    end if;

    raise notice '053 OK: financial-adjacent RPCs are service_role-only with a pinned search_path; no other function changed';
end
$post$;

commit;

-- ROLLBACK (restores the pre-053 exposure - do NOT use except to undo the fix)
--   alter function public.mark_expired_invoices() reset search_path;
--   alter function public.paymento_check_duplicate_webhook(text,bigint) reset search_path;
--   grant execute on function public.mark_expired_invoices() to anon, authenticated;
--   grant execute on function public.paymento_check_duplicate_webhook(text,bigint) to anon, authenticated;
--   ... and the same for each sandbox_* target in _m53_targets.
