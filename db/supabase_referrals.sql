-- Stay in Your Lane — referral tables for SUPABASE
--
-- Keys off public.profiles (your existing table), not a new users table.
-- Safe to run more than once.
--
-- IMPORTANT: Supabase auto-exposes every public table through PostgREST.
-- Without RLS, anyone holding your anon key could insert chip_ledger rows
-- and grant themselves chips. These tables therefore get RLS enabled with
-- NO anon/authenticated policies at all - only the service_role key (used
-- by your Vercel API routes) can touch them. That is deliberate.

-- ---------------------------------------------------------------------------
-- 1. The qualification gate needs a hand counter.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists hands_played integer not null default 0;

-- ---------------------------------------------------------------------------
-- 2. Referral tables
-- ---------------------------------------------------------------------------
create table if not exists public.referral_codes (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  code       text not null unique,
  created_at timestamptz not null default now()
);

do $$ begin
  create type referral_status as enum ('pending', 'qualified', 'rejected');
exception
  when duplicate_object then null;
end $$;

-- invitee_id is unique: a player can be referred exactly once, enforced by
-- the database rather than by code that might race.
create table if not exists public.referrals (
  id             bigserial primary key,
  inviter_id     uuid not null references public.profiles(id) on delete cascade,
  invitee_id     uuid not null unique references public.profiles(id) on delete cascade,
  code           text not null,
  status         referral_status not null default 'pending',
  reject_reason  text,
  signup_ip_hash text,
  device_hash    text,
  created_at     timestamptz not null default now(),
  qualified_at   timestamptz,
  constraint no_self_referral check (inviter_id <> invitee_id)
);

-- idem_key makes double-crediting impossible: the same logical event can
-- replay any number of times and pays exactly once.
create table if not exists public.chip_ledger (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  delta      bigint not null,
  reason     text not null,
  idem_key   text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists referral_codes_code_idx on public.referral_codes (code);
create index if not exists referrals_inviter_idx   on public.referrals (inviter_id, status);
create index if not exists referrals_ip_idx        on public.referrals (inviter_id, signup_ip_hash);
create index if not exists referrals_device_idx    on public.referrals (device_hash);
create index if not exists chip_ledger_user_idx    on public.chip_ledger (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Lock them down. RLS on, no policies -> the anon and authenticated keys
--    can read and write nothing. service_role bypasses RLS, which is how the
--    Vercel routes reach them.
-- ---------------------------------------------------------------------------
alter table public.referral_codes enable row level security;
alter table public.referrals      enable row level security;
alter table public.chip_ledger    enable row level security;

revoke all on public.referral_codes from anon, authenticated;
revoke all on public.referrals      from anon, authenticated;
revoke all on public.chip_ledger    from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Check your existing tables too. This one is worth reading closely.
-- ---------------------------------------------------------------------------
select relname as table_name,
       case when relrowsecurity then 'RLS on' else 'RLS OFF - EXPOSED' end as status
from pg_class
where relnamespace = 'public'::regnamespace
  and relkind = 'r'
order by relrowsecurity, relname;
