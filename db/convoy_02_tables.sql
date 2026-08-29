-- Convoy multiplayer — part 2: schema, matchmaking, turn clock
--
-- Run after convoy_01_engine.sql.
--
-- The security model in one line: cards live in tables the client can never
-- read, and every state change goes through a function that checks whose
-- turn it is.

-- ===========================================================================
-- 1. Matchmaking queue
-- ===========================================================================

create table if not exists public.convoy_queue (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  stake      bigint not null,
  joined_at  timestamptz not null default now()
);

create index if not exists convoy_queue_stake_idx on public.convoy_queue (stake, joined_at);

-- ===========================================================================
-- 2. Games
--
-- phase: 'building'   — alternating draws
--        'checkpoint' — the betting round once every lane holds three
--        'reveal'     — sealed hands open, matchups scored
--        'done'
-- ===========================================================================

do $$ begin
  create type convoy_phase as enum ('building', 'checkpoint', 'reveal', 'done');
exception when duplicate_object then null;
end $$;

create table if not exists public.convoy_games (
  id           bigserial primary key,
  player_a     uuid not null references public.profiles(id),
  player_b     uuid not null references public.profiles(id),
  stake        bigint not null,
  pot          bigint not null default 0,
  phase        convoy_phase not null default 'building',
  to_act       uuid,
  act_deadline timestamptz,
  raises       int not null default 0,
  winner       uuid,
  result       jsonb,
  created_at   timestamptz not null default now(),
  ended_at     timestamptz,
  constraint distinct_players check (player_a <> player_b)
);

create index if not exists convoy_games_active_idx
  on public.convoy_games (phase, act_deadline)
  where phase in ('building', 'checkpoint');

create index if not exists convoy_games_player_idx
  on public.convoy_games (player_a, player_b);

-- ---------------------------------------------------------------------------
-- Private state. NOTHING in here is ever sent to a client wholesale — the
-- pile order and the opponent's hole cards are exactly what a cheater wants.
-- ---------------------------------------------------------------------------
create table if not exists public.convoy_secrets (
  game_id  bigint primary key references public.convoy_games(id) on delete cascade,
  pile     smallint[] not null,      -- undrawn cards, in order
  hole_a   smallint[] not null,      -- player A's five
  hole_b   smallint[] not null,
  sealed_a smallint[] not null default '{}',
  sealed_b smallint[] not null default '{}'
);

-- ---------------------------------------------------------------------------
-- Public board state. Lane cards are face-up in Convoy, so this is safe to
-- broadcast in full.
-- ---------------------------------------------------------------------------
create table if not exists public.convoy_board (
  game_id  bigint not null references public.convoy_games(id) on delete cascade,
  user_id  uuid not null references public.profiles(id),
  lane_idx smallint not null check (lane_idx between 0 and 3),
  cards    smallint[] not null default '{}',
  primary key (game_id, user_id, lane_idx)
);

-- Append-only. Every action, in order — the audit trail for any dispute
-- about what happened in a hand.
create table if not exists public.convoy_actions (
  id        bigserial primary key,
  game_id   bigint not null references public.convoy_games(id) on delete cascade,
  user_id   uuid,
  action    text not null,
  payload   jsonb,
  created_at timestamptz not null default now()
);

create index if not exists convoy_actions_game_idx on public.convoy_actions (game_id, id);

-- ===========================================================================
-- 3. Lock everything down.
--
-- RLS on with no policies means anon and authenticated read nothing directly.
-- Clients get state through functions that filter per-player, never by
-- selecting these tables.
-- ===========================================================================

alter table public.convoy_queue   enable row level security;
alter table public.convoy_games   enable row level security;
alter table public.convoy_secrets enable row level security;
alter table public.convoy_board   enable row level security;
alter table public.convoy_actions enable row level security;

-- ===========================================================================
-- 4. Turn clock
-- ===========================================================================

create or replace function public.convoy_config()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'turn_seconds',      30,
    'checkpoint_seconds',20,
    'max_raises',         3,
    'lanes',              4,
    'hole_cards',         5,
    'lane_target',        3    -- cards per lane that triggers the checkpoint
  );
$$;

-- ---------------------------------------------------------------------------
-- convoy_sweep — auto-folds anyone past their clock.
--
-- Heads-up makes this mandatory rather than nice to have: with two players,
-- one going idle stalls the only opponent and there is nobody else at the
-- table to absorb it.
--
-- Schedule it with pg_cron:
--   select cron.schedule('convoy-sweep', '5 seconds', 'select public.convoy_sweep()');
-- ---------------------------------------------------------------------------
create or replace function public.convoy_sweep()
returns int
language plpgsql security definer set search_path = public as $$
declare
  g record;
  v_opponent uuid;
  n int := 0;
begin
  for g in
    select * from convoy_games
     where phase in ('building', 'checkpoint')
       and act_deadline is not null
       and act_deadline < now()
     for update skip locked
  loop
    v_opponent := case when g.to_act = g.player_a then g.player_b else g.player_a end;

    update convoy_games
       set phase = 'done', winner = v_opponent, ended_at = now(),
           to_act = null, act_deadline = null,
           result = jsonb_build_object('reason', 'timeout', 'folded', g.to_act)
     where id = g.id;

    insert into convoy_actions (game_id, user_id, action, payload)
    values (g.id, g.to_act, 'timeout_fold', jsonb_build_object('awarded_to', v_opponent));

    -- The loser's stake was already escrowed at deal time, so only the
    -- winner needs crediting.
    perform credit_chips(v_opponent, g.pot, 'convoy_timeout_win',
                         'convoy:' || g.id || ':payout');

    n := n + 1;
  end loop;

  return n;
end $$;

revoke execute on function public.convoy_sweep()  from public, anon, authenticated;
revoke execute on function public.convoy_config() from public, anon, authenticated;

select 'schema ready' as status,
       (select count(*) from information_schema.tables
         where table_schema = 'public' and table_name like 'convoy%') as convoy_tables;
