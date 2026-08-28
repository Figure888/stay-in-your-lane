-- Stay in Your Lane — referral system schema
-- Postgres. Works on Vercel Postgres, Neon, or Supabase.
--
-- ASSUMES you already have a users table with:
--   id            uuid primary key
--   chips         bigint not null default 0
--   created_at    timestamptz not null default now()
--   hands_played  integer not null default 0
--
-- If your column names differ, change them here and in lib/referrals.js.
-- If you don't have hands_played yet, add it:
--   alter table users add column hands_played integer not null default 0;

begin;

-- One permanent code per player. Generated on first request, never rotated,
-- so old links keep working.
create table if not exists referral_codes (
  user_id    uuid primary key references users(id) on delete cascade,
  code       text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists referral_codes_code_idx on referral_codes (code);

do $$ begin
  create type referral_status as enum ('pending', 'qualified', 'rejected');
exception
  when duplicate_object then null;
end $$;

-- The unique constraint on invitee_id is the important one: a player can be
-- referred exactly once in their lifetime, enforced by the database rather
-- than by application code that might race.
create table if not exists referrals (
  id             bigserial primary key,
  inviter_id     uuid not null references users(id) on delete cascade,
  invitee_id     uuid not null unique references users(id) on delete cascade,
  code           text not null,
  status         referral_status not null default 'pending',
  reject_reason  text,
  signup_ip_hash text,
  device_hash    text,
  created_at     timestamptz not null default now(),
  qualified_at   timestamptz,
  constraint no_self_referral check (inviter_id <> invitee_id)
);

create index if not exists referrals_inviter_idx on referrals (inviter_id, status);
create index if not exists referrals_ip_idx on referrals (inviter_id, signup_ip_hash);
create index if not exists referrals_device_idx on referrals (device_hash);

-- Every chip movement in the game gets a row here, not just referral payouts.
-- idem_key is what makes double-crediting impossible: the same logical event
-- can be replayed any number of times and still only pay once.
create table if not exists chip_ledger (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  delta      bigint not null,
  reason     text not null,
  idem_key   text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists chip_ledger_user_idx on chip_ledger (user_id, created_at desc);

commit;
