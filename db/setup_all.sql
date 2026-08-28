-- Stay in Your Lane — full database setup, one paste.
--
-- Includes everything: the referral tables, the link to Neon's auth schema,
-- and verification queries at the end. Every statement is idempotent, so
-- running this twice is safe and running it after 001_referrals.sql is safe.
--
-- Paste the whole file into the Neon SQL editor and hit Run. Neon executes
-- each statement separately, so check ALL the result tabs at the end.

create extension if not exists "pgcrypto";

-- ===========================================================================
-- PART 1 — referral tables
-- ===========================================================================

do $migration$
declare
  id_type text;
begin
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
  end if;

  execute 'alter table public.users add column if not exists chips bigint not null default 10000';
  execute 'alter table public.users add column if not exists hands_played integer not null default 0';
  execute 'alter table public.users add column if not exists created_at timestamptz not null default now()';

  -- Match the foreign keys to whatever type users.id actually is.
  select format_type(a.atttypid, a.atttypmod)
    into id_type
    from pg_attribute a
   where a.attrelid = 'public.users'::regclass
     and a.attname  = 'id'
     and a.attnum   > 0
     and not a.attisdropped;

  if id_type is null then
    raise exception 'users has no id column';
  end if;

  raise notice 'users.id is %', id_type;

  execute format($ddl$
    create table if not exists public.referral_codes (
      user_id    %s primary key references public.users(id) on delete cascade,
      code       text not null unique,
      created_at timestamptz not null default now()
    )
  $ddl$, id_type);

  begin
    create type referral_status as enum ('pending', 'qualified', 'rejected');
  exception
    when duplicate_object then null;
  end;

  -- invitee_id is unique: a player can be referred exactly once, enforced
  -- by the database rather than by code that might race.
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

  -- idem_key makes double-crediting impossible: the same logical event can
  -- replay any number of times and pays exactly once.
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
end
$migration$;

create index if not exists referral_codes_code_idx on public.referral_codes (code);
create index if not exists referrals_inviter_idx   on public.referrals (inviter_id, status);
create index if not exists referrals_ip_idx        on public.referrals (inviter_id, signup_ip_hash);
create index if not exists referrals_device_idx    on public.referrals (device_hash);
create index if not exists chip_ledger_user_idx    on public.chip_ledger (user_id, created_at desc);

-- ===========================================================================
-- PART 2 — link game profiles to Neon's auth schema
--
-- neon_auth is managed by Neon and may change on their schedule, so game
-- state does NOT go in there. Identity lives in neon_auth."user", game state
-- lives in public.users, and auth_user_id is the single link between them.
-- ===========================================================================

do $link$
begin
  if to_regclass('neon_auth.user') is null then
    raise notice 'neon_auth.user not found - skipping link';
    return;
  end if;

  execute 'alter table public.users add column if not exists auth_user_id uuid';

  if not exists (
    select 1 from pg_constraint where conname = 'users_auth_user_id_fkey'
  ) then
    execute 'alter table public.users
               add constraint users_auth_user_id_fkey
               foreign key (auth_user_id)
               references neon_auth."user"(id) on delete cascade';
  end if;

  execute 'create unique index if not exists users_auth_user_id_idx
             on public.users (auth_user_id)';

  raise notice 'linked public.users to neon_auth.user';
end
$link$;

-- ===========================================================================
-- PART 3 — verification. Read these result tabs.
-- ===========================================================================

-- Expect four rows, all reading 'yes'.
select 'referral_codes'  as object, case when to_regclass('public.referral_codes') is null then 'MISSING' else 'yes' end as ok
union all
select 'referrals',       case when to_regclass('public.referrals')      is null then 'MISSING' else 'yes' end
union all
select 'chip_ledger',     case when to_regclass('public.chip_ledger')    is null then 'MISSING' else 'yes' end
union all
select 'auth_user_id',    case when exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='users' and column_name='auth_user_id'
  ) then 'yes' else 'MISSING' end;

-- Needed to finish lib/auth.js — the shape of Neon's session table.
select column_name, data_type
from information_schema.columns
where table_schema = 'neon_auth' and table_name = 'session'
order by ordinal_position;
