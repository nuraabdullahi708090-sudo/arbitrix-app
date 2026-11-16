-- Minimal production-shaped bootstrap for the tables this repo does NOT declare
-- in any migration (users, wallets, transactions, deposits, payment_invoices...).
-- Columns are taken from the application's own queries, not invented.
create table if not exists public.users (
  id bigserial primary key,
  name text not null,
  email text not null unique,
  password_hash text not null,
  referral_code text unique,
  is_admin integer not null default 0,
  environment text not null default 'PRODUCTION',
  created_at timestamptz not null default now()
);
create table if not exists public.wallets (
  id bigserial primary key,
  user_id bigint not null unique references public.users(id) on delete cascade,
  demo_balance numeric(18,2) not null default 1000,
  live_balance numeric(18,2) not null default 50,
  bonus_balance numeric(18,2) not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists public.deposits (
  id bigserial primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  amount numeric(18,2) not null,
  status text not null default 'pending',
  credited boolean not null default false,
  tx_hash text,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);
create table if not exists public.payment_invoices (
  id bigserial primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  invoice_id text unique,
  amount_usd numeric(18,2) not null default 0,
  status text not null default 'pending',
  credited boolean not null default false,
  provider text,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);
create table if not exists public.transactions (
  id bigserial primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  type text not null,
  amount numeric(18,2) not null default 0,
  detail text,
  mode text default 'live',
  created_at timestamptz not null default now()
);
-- PRODUCTION SHAPE: (id, config_key, config_value, description, created_at,
-- updated_at) as created by migrations/003_referral_config.sql and read by
-- server.js plus migrations 020-024. Do NOT "simplify" this to (key, value):
-- an earlier rehearsal fixture did, and it hid a defect in 049.
create table if not exists public.referral_config (
  id uuid primary key default gen_random_uuid(),
  config_key text not null unique,
  config_value text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.referral_config(config_key, config_value, description) values
  ('minimum_qualifying_deposit','100','Minimum deposit for referral qualification'),
  ('referral_reward_percent','20','One-time reward percent'),
  ('rewards_enabled','true','Enable referral rewards'),
  ('max_rewards_per_user','1','Max rewards per referrer')
on conflict (config_key) do nothing;
create table if not exists public.referrals (
  id bigserial primary key,
  referrer_id bigint not null,
  referred_id bigint not null,
  status text not null default 'pending',
  bonus_earned numeric(18,2) not null default 0,
  qualified_at timestamptz,
  qualification_type text,
  created_at timestamptz not null default now()
);
create table if not exists public.payment_config (
  key text primary key,
  value text,
  value_type text default 'string',
  description text,
  category text default 'general',
  is_sensitive boolean default false
);
-- Real 011 shapes: the rehearsal must not invent a schema the RPC does not use.
create table if not exists public.subscriptions (
  id bigserial primary key,
  user_id bigint not null unique references public.users(id) on delete cascade,
  plan text not null default 'pro',
  price decimal(18,2) not null default 7 check (price >= 0),
  status text not null default 'inactive' check (status in ('active','payment_due','inactive','cancelled')),
  started_at timestamptz,
  next_billing_date timestamptz,
  last_billing_date timestamptz,
  last_charge_amount decimal(18,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.subscription_charges (
  id bigserial primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  idempotency_key text not null unique,
  plan text not null default 'pro',
  price decimal(18,2) not null,
  balance_after decimal(18,2) not null,
  created_at timestamptz not null default now()
);
create table if not exists public.bot_sessions (
  id bigserial primary key,
  user_id bigint not null unique,
  is_running boolean not null default false,
  started_at timestamptz,
  updated_at timestamptz,
  heartbeat_at timestamptz,
  claimed_by text,
  lease_acquired_at timestamptz,
  lease_expires_at timestamptz,
  generation integer not null default 0,
  stopped_reason text,
  tick_count integer not null default 0,
  consecutive_failures integer not null default 0,
  worker_version text,
  risk_limits jsonb,
  last_tick_at timestamptz
);
create table if not exists public.bot_profit_pauses (
  id bigserial primary key,
  user_id bigint not null,
  triggered_at timestamptz not null default now(),
  cleared_at timestamptz
);
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;

-- Prerequisite stubs: earlier migrations (006/007, 009) that the 008/011 verify
-- blocks only test for by NAME. They represent "already applied in production".
create or replace function public.paymento_credit_user_safe(p_user_id bigint, p_invoice_id bigint, p_amount numeric, p_tx text)
returns json language plpgsql as $$ begin return '{"success":true}'::json; end $$;
create or replace function public.record_trade_safe(p_user_id bigint, p_mode text, p_asset text, p_detail text, p_bet numeric, p_amount numeric, p_idempotency_key text)
returns json language plpgsql as $$ begin return '{"success":true}'::json; end $$;

-- Tables the server writes but no migration in this slice creates.
create table if not exists public.withdrawals (
  id bigserial primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  amount numeric(18,2) not null,
  address text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);
create table if not exists public.revoked_tokens (
  jti text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Columns / tables the server writes that this slice's migrations do not create.
alter table public.bot_sessions add column if not exists mode text default 'live';
create table if not exists public.bot_worker_control (
  id integer primary key default 1,
  emergency_stop boolean not null default false,
  reason text,
  engaged_by bigint,
  engaged_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.bot_worker_control (id, emergency_stop) values (1, false) on conflict (id) do nothing;
create table if not exists public.trades (
  id bigserial primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  amount numeric(18,2) not null,
  mode text default 'live',
  asset text,
  detail text,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);
