-- Stay in Your Lane — referral system for Supabase
--
-- Creates the tables and four Postgres functions. All the logic lives in the
-- database so payouts are atomic: a function body is a single transaction, so
-- a crash halfway through can't leave a referral marked paid with no chips
-- credited, or credit chips twice.
--
-- Your API routes call these with admin.rpc(), using the service role key —
-- the same pattern api/whop-webhook.js already uses.
--
-- Safe to run more than once.

-- ===========================================================================
-- 1. Tables
-- ===========================================================================

alter table public.profiles
  add column if not exists hands_played integer not null default 0;

create table if not exists public.referral_codes (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  code       text not null unique,
  created_at timestamptz not null default now()
);

do $$ begin
  create type referral_status as enum ('pending', 'qualified', 'rejected');
exception when duplicate_object then null;
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

-- Every chip movement, not just referral payouts. idem_key makes double
-- crediting impossible: the same logical event can replay any number of
-- times and pays exactly once.
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
create index if not exists chip_ledger_user_idx    on public.chip_ledger (user_id, created_at desc);

-- Supabase exposes every public table through PostgREST. RLS on with no
-- policies means anon and authenticated keys can read and write nothing here.
-- service_role bypasses RLS, which is how your API routes reach them.
alter table public.referral_codes enable row level security;
alter table public.referrals      enable row level security;
alter table public.chip_ledger    enable row level security;

-- ===========================================================================
-- 2. Tuning — change these numbers here, not in JavaScript
-- ===========================================================================

create or replace function public.referral_config()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'inviter_bonus',    5000,
    'invitee_bonus',    1000,
    'min_hands',          20,
    'min_age_hours',      24,
    'max_referrals',      20
  );
$$;

-- ===========================================================================
-- 3. credit_chips — the only way chips should ever move
-- ===========================================================================

create or replace function public.credit_chips(
  p_user uuid, p_delta bigint, p_reason text, p_idem_key text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  inserted bigint;
begin
  insert into chip_ledger (user_id, delta, reason, idem_key)
  values (p_user, p_delta, p_reason, p_idem_key)
  on conflict (idem_key) do nothing
  returning id into inserted;

  if inserted is null then
    return false;                       -- replay, already paid
  end if;

  update profiles set chips = chips + p_delta where id = p_user;
  return true;
end $$;

-- ===========================================================================
-- 4. referral_code_for — one permanent code per player
-- ===========================================================================

create or replace function public.referral_code_for(p_user uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  existing text;
  candidate text;
  alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';  -- no 0/O/1/I
  i int;
begin
  select code into existing from referral_codes where user_id = p_user;
  if existing is not null then return existing; end if;

  for attempt in 1..5 loop
    candidate := '';
    for i in 1..7 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;

    begin
      insert into referral_codes (user_id, code) values (p_user, candidate);
      return candidate;
    exception when unique_violation then
      -- Either the code collided or another request created this user's row.
      select code into existing from referral_codes where user_id = p_user;
      if existing is not null then return existing; end if;
    end;
  end loop;

  raise exception 'could not generate a referral code';
end $$;

-- ===========================================================================
-- 5. apply_referral_code — records the referral as pending. Pays nothing.
-- ===========================================================================

create or replace function public.apply_referral_code(
  p_invitee uuid, p_code text, p_ip_hash text default null, p_device_hash text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
  v_inviter uuid;
begin
  if length(v_code) <> 7 then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  select user_id into v_inviter from referral_codes where code = v_code;
  if v_inviter is null then
    return jsonb_build_object('ok', false, 'error', 'unknown_code');
  end if;

  if v_inviter = p_invitee then
    return jsonb_build_object('ok', false, 'error', 'self_referral');
  end if;

  begin
    insert into referrals (inviter_id, invitee_id, code, signup_ip_hash, device_hash)
    values (v_inviter, p_invitee, v_code, p_ip_hash, p_device_hash);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already_referred');
  end;

  return jsonb_build_object('ok', true, 'status', 'pending');
end $$;

-- ===========================================================================
-- 6. qualify_referral — the payout. Atomic.
--
-- Call after every hand the invitee finishes. Cheap no-op once settled.
-- ===========================================================================

create or replace function public.qualify_referral(p_invitee uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb := referral_config();
  r record;
  v_hands int;
  v_age_hours numeric;
  v_count int;
  v_dupe int;
begin
  -- Lock the row so two hands finishing at once can't both pay.
  select * into r from referrals
   where invitee_id = p_invitee and status = 'pending'
   for update;

  if not found then
    return jsonb_build_object('ok', true, 'status', 'nothing_pending');
  end if;

  select hands_played, extract(epoch from (now() - created_at)) / 3600
    into v_hands, v_age_hours
    from profiles where id = p_invitee;

  -- Not a real player yet. Leave it pending.
  if v_hands < (cfg->>'min_hands')::int
     or v_age_hours < (cfg->>'min_age_hours')::numeric then
    return jsonb_build_object(
      'ok', true, 'status', 'pending',
      'hands_remaining', greatest(0, (cfg->>'min_hands')::int - v_hands));
  end if;

  -- Abuse checks run at payout, not signup: telling a farmer which check
  -- they tripped at signup just teaches them how to pass it.
  select count(*) into v_count from referrals
   where inviter_id = r.inviter_id and status = 'qualified';

  if v_count >= (cfg->>'max_referrals')::int then
    update referrals set status = 'rejected', reject_reason = 'inviter_cap_reached'
     where id = r.id;
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'inviter_cap_reached');
  end if;

  if r.device_hash is not null then
    select count(*) into v_dupe from referrals
     where device_hash = r.device_hash and invitee_id <> p_invitee;
    if v_dupe > 0 then
      update referrals set status = 'rejected', reject_reason = 'duplicate_device'
       where id = r.id;
      return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'duplicate_device');
    end if;
  end if;

  -- Several signups from one IP is normal (households, campus wifi). Several
  -- from one IP all pointing at the same inviter is not.
  if r.signup_ip_hash is not null then
    select count(*) into v_dupe from referrals
     where inviter_id = r.inviter_id and signup_ip_hash = r.signup_ip_hash
       and invitee_id <> p_invitee;
    if v_dupe >= 2 then
      update referrals set status = 'rejected', reject_reason = 'ip_clustering'
       where id = r.id;
      return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'ip_clustering');
    end if;
  end if;

  update referrals set status = 'qualified', qualified_at = now() where id = r.id;

  perform credit_chips(r.inviter_id, (cfg->>'inviter_bonus')::bigint,
                       'referral_inviter', 'ref:' || r.id || ':inviter');
  perform credit_chips(r.invitee_id, (cfg->>'invitee_bonus')::bigint,
                       'referral_invitee', 'ref:' || r.id || ':invitee');

  return jsonb_build_object('ok', true, 'status', 'qualified',
                            'awarded', (cfg->>'inviter_bonus')::bigint);
end $$;

-- ===========================================================================
-- 7. referral_summary — everything the invite screen needs
-- ===========================================================================

create or replace function public.referral_summary(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb := referral_config();
  v_code text;
  v_pending int;
  v_qualified int;
begin
  v_code := referral_code_for(p_user);

  select count(*) filter (where status = 'pending'),
         count(*) filter (where status = 'qualified')
    into v_pending, v_qualified
    from referrals where inviter_id = p_user;

  return jsonb_build_object(
    'code',          v_code,
    'link',          'https://lanepoker.online/?ref=' || v_code,
    'pending',       v_pending,
    'qualified',     v_qualified,
    'chipsEarned',   v_qualified * (cfg->>'inviter_bonus')::bigint,
    'slotsLeft',     greatest(0, (cfg->>'max_referrals')::int - v_qualified),
    'inviterBonus',  (cfg->>'inviter_bonus')::bigint,
    'inviteeBonus',  (cfg->>'invitee_bonus')::bigint,
    'handsRequired', (cfg->>'min_hands')::int
  );
end $$;

-- ===========================================================================
-- 8. Only the service role may call these.
-- ===========================================================================

revoke execute on function public.credit_chips(uuid, bigint, text, text)  from public, anon, authenticated;
revoke execute on function public.referral_code_for(uuid)                 from public, anon, authenticated;
revoke execute on function public.apply_referral_code(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.qualify_referral(uuid)                  from public, anon, authenticated;
revoke execute on function public.referral_summary(uuid)                  from public, anon, authenticated;

-- Confirm
select routine_name from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('credit_chips','referral_code_for','apply_referral_code',
                       'qualify_referral','referral_summary','referral_config')
order by routine_name;
