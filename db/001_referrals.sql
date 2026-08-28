-- Stay in Your Lane — referral system schema (v2)
--
-- Safe to run more than once. It inspects what's already in the database
-- instead of assuming, which is what went wrong with v1:
--   * creates users only if it's missing
--   * adds chips / hands_played / created_at only if they're missing
--   * matches the referral foreign keys to whatever type users.id actually is
--
-- Run the whole thing in one go, then run 002_verify.sql.

create extension if not exists "pgcrypto";

do $migration$
declare
  id_type text;
begin
  ------------------------------------------------------------------
  -- 1. users
  ------------------------------------------------------------------
  if to_regclass('public.users') is null then
    execute $ddl$
      create table public.users (
        id           uuid primary key default gen_random_uuid(),
        email        text unique,
        chips        bigint      not null default 10000,
        hands_played integer     not null default 0,
        created_at   timestamptz not null default now()
      )
    $ddl$;
    raise notice 'created table users';
  else
    raise notice 'users already exists - leaving it alone';
  end if;

  -- Columns the referral logic reads. No-ops if already present.
  execute 'alter table public.users add column if not exists chips bigint not null default 10000';
  execute 'alter table public.users add column if not exists hands_played integer not null default 0';
  execute 'alter table public.users add column if not exists created_at timestamptz not null default now()';

  ------------------------------------------------------------------
  -- 2. Find out what type users.id actually is, so the foreign keys
  --    match. v1 hardcoded uuid, which is why it failed.
  ------------------------------------------------------------------
  select format_type(a.atttypid, a.atttypmod)
    into id_type
    from pg_attribute a
   where a.attrelid = 'public.users'::regclass
     and a.attname  = 'id'
     and a.attnum   > 0
     and not a.attisdropped;

  if id_type is null then
    raise exception 'users has no id column - cannot build referral tables';
  end if;

  raise notice 'users.id is %', id_type;

  ------------------------------------------------------------------
  -- 3. referral_codes - one permanent code per player
  ------------------------------------------------------------------
  execute format($ddl$
    create table if not exists public.referral_codes (
      user_id    %s primary key references public.users(id) on delete cascade,
      code       text not null unique,
      created_at timestamptz not null default now()
    )
  $ddl$, id_type);

  ------------------------------------------------------------------
  -- 4. referrals
  --
  --    invitee_id is unique: a player can be referred exactly once,
  --    enforced by the database rather than by code that might race.
  ------------------------------------------------------------------
  begin
    create type referral_status as enum ('pending', 'qualified', 'rejected');
  exception
    when duplicate_object then null;
  end;

  execute format($ddl$
    create table if not exists public.referrals (
      id             bigserial primary key,
      inviter_id     %1$s not null references public.users(id) on delete cascade,
      invitee_id     %1$s not null unique references public.users(id) on delete cascade,
      code           text not null,
      status         referral_status not null default 'pending',
      reject_reason  text,
      signup_ip_hash text,
      device_hash    text,
      created_at     timestamptz not null default now(),
      qualified_at   timestamptz,
      constraint no_self_referral check (inviter_id <> invitee_id)
    )
  $ddl$, id_type);

  ------------------------------------------------------------------
  -- 5. chip_ledger
  --
  --    Every chip movement in the game, not just referral payouts.
  --    idem_key makes double-crediting impossible: the same logical
  --    event can replay any number of times and pays exactly once.
  ------------------------------------------------------------------
  execute format($ddl$
    create table if not exists public.chip_ledger (
      id         bigserial primary key,
      user_id    %s not null references public.users(id) on delete cascade,
      delta      bigint not null,
      reason     text not null,
      idem_key   text not null unique,
      created_at timestamptz not null default now()
    )
  $ddl$, id_type);

  raise notice 'referral tables ready';
end
$migration$;

------------------------------------------------------------------
-- 6. Indexes. Plain statements outside the DO block, all idempotent.
------------------------------------------------------------------
create index if not exists referral_codes_code_idx on public.referral_codes (code);
create index if not exists referrals_inviter_idx   on public.referrals (inviter_id, status);
create index if not exists referrals_ip_idx        on public.referrals (inviter_id, signup_ip_hash);
create index if not exists referrals_device_idx    on public.referrals (device_hash);
create index if not exists chip_ledger_user_idx    on public.chip_ledger (user_id, created_at desc);
