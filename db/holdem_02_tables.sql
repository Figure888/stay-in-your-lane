-- Lane Hold'em online — schema and hand setup.
--
-- Built for 2 seats now, generalised to N. A four-seat table needs four
-- humans to start; heads-up needs two, and two is a number you can actually
-- reach. The seat loops below don't assume 2, so raising the cap later is a
-- config change rather than a rewrite.
--
-- Stages match the offline game: 0 On-ramp, 1 The Merge (middle three),
-- 2 The Fork (one card to each lane), 3 The Exit (the second), 4 Showdown.

do $$ begin
  create type holdem_phase as enum ('waiting', 'betting', 'showdown', 'done');
exception when duplicate_object then null;
end $$;

create table if not exists public.holdem_tables (
  id           bigserial primary key,
  seats        int not null default 2,
  sb           bigint not null default 10,
  bb           bigint not null default 20,
  buyin        bigint not null default 1000,
  phase        holdem_phase not null default 'waiting',
  stage_idx    int not null default 0,
  dealer_seat  int not null default 0,
  to_act_seat  int,
  act_deadline timestamptz,
  pot          bigint not null default 0,
  cur_bet      bigint not null default 0,
  min_raise    bigint not null default 20,
  mid          smallint[] not null default '{}',
  lane_a       smallint[] not null default '{}',
  lane_b       smallint[] not null default '{}',
  hand_no      int not null default 0,
  result       jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists holdem_open_idx
  on public.holdem_tables (phase, buyin) where phase = 'waiting';
create index if not exists holdem_clock_idx
  on public.holdem_tables (act_deadline) where phase = 'betting';

create table if not exists public.holdem_seats (
  table_id      bigint not null references public.holdem_tables(id) on delete cascade,
  seat_idx      int not null,
  user_id       uuid references public.profiles(id) on delete set null,
  chips         bigint not null default 0,   -- stack at the table, not the wallet
  bet           bigint not null default 0,   -- committed this street
  total         bigint not null default 0,   -- committed this hand
  folded        boolean not null default true,
  all_in        boolean not null default false,
  needs_to_act  boolean not null default false,
  last_action   text,
  sitting_out   boolean not null default false,
  joined_at     timestamptz not null default now(),
  primary key (table_id, seat_idx)
);

create unique index if not exists holdem_one_seat_idx
  on public.holdem_seats (table_id, user_id) where user_id is not null;

-- Deck order and hole cards. Never leaves the server.
create table if not exists public.holdem_secrets (
  table_id bigint primary key references public.holdem_tables(id) on delete cascade,
  deck     smallint[] not null default '{}',
  holes    jsonb not null default '{}'::jsonb   -- {"0":[12,34], "1":[5,9]}
);

create table if not exists public.holdem_actions (
  id         bigserial primary key,
  table_id   bigint not null references public.holdem_tables(id) on delete cascade,
  hand_no    int,
  seat_idx   int,
  action     text not null,
  amount     bigint,
  created_at timestamptz not null default now()
);

create index if not exists holdem_actions_idx on public.holdem_actions (table_id, id desc);

alter table public.holdem_tables  enable row level security;
alter table public.holdem_seats   enable row level security;
alter table public.holdem_secrets enable row level security;
alter table public.holdem_actions enable row level security;

-- ===========================================================================
-- Config
-- ===========================================================================

create or replace function public.holdem_config()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'act_seconds', 30,
    'stages', jsonb_build_array('On-ramp','The Merge','The Fork','The Exit','Showdown')
  );
$$;

-- ===========================================================================
-- Seat helpers — ported from nextLive() and nextToAct()
-- ===========================================================================

create or replace function public.holdem_next_live(p_table bigint, p_from int)
returns int
language plpgsql stable set search_path = public as $$
declare n int; k int; i int;
begin
  select seats into n from holdem_tables where id = p_table;
  k := p_from;
  for i in 1..n loop
    k := (k + 1) % n;
    if exists (select 1 from holdem_seats
                where table_id = p_table and seat_idx = k
                  and chips > 0 and not folded) then
      return k;
    end if;
  end loop;
  return p_from;
end $$;

create or replace function public.holdem_next_to_act(p_table bigint, p_from int)
returns int
language plpgsql stable set search_path = public as $$
declare n int; k int; i int; d int;
begin
  select seats, dealer_seat into n, d from holdem_tables where id = p_table;
  k := case when p_from < 0 then d else p_from end;
  for i in 1..n loop
    k := (k + 1) % n;
    if exists (select 1 from holdem_seats
                where table_id = p_table and seat_idx = k
                  and not folded and not all_in) then
      return k;
    end if;
  end loop;
  return -1;
end $$;

-- put() — move chips from a stack into the pot, flagging all-in.
create or replace function public.holdem_put(p_table bigint, p_seat int, p_amt bigint)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_amt bigint; v_chips bigint;
begin
  select chips into v_chips from holdem_seats
   where table_id = p_table and seat_idx = p_seat for update;

  v_amt := greatest(0, least(p_amt, v_chips));
  if v_amt = 0 then return 0; end if;

  update holdem_seats
     set chips = chips - v_amt,
         bet   = bet + v_amt,
         total = total + v_amt,
         all_in = (chips - v_amt = 0)
   where table_id = p_table and seat_idx = p_seat;

  update holdem_tables set pot = pot + v_amt, updated_at = now() where id = p_table;
  return v_amt;
end $$;

-- ===========================================================================
-- holdem_new_hand — shuffle, deal, post blinds.
--
-- Heads-up blinds follow the standard rule, not the four-handed formula: with
-- two players the BUTTON posts the small blind, acts FIRST before the flop and
-- LAST on every street after. Applying the ring-game formula to two seats gets
-- this backwards, and poker players notice immediately.
-- ===========================================================================

create or replace function public.holdem_new_hand(p_table bigint)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  t record;
  cfg jsonb := holdem_config();
  deck smallint[];
  pos int := 1;
  s record;
  holes jsonb := '{}'::jsonb;
  n_ready int;
  sb_seat int; bb_seat int; first_seat int;
  heads_up boolean;
begin
  select * into t from holdem_tables where id = p_table for update;

  select count(*) into n_ready from holdem_seats
   where table_id = p_table and user_id is not null and chips > 0 and not sitting_out;

  if n_ready < 2 then
    update holdem_tables set phase = 'waiting', to_act_seat = null, act_deadline = null
     where id = p_table;
    return jsonb_build_object('ok', false, 'error', 'not_enough_players');
  end if;

  heads_up := (n_ready = 2);
  deck := shuffled_deck();

  -- Reset the table
  update holdem_tables
     set mid = '{}', lane_a = '{}', lane_b = '{}',
         pot = 0, cur_bet = t.bb, min_raise = t.bb,
         stage_idx = 0, phase = 'betting', result = null,
         hand_no = t.hand_no + 1, updated_at = now()
   where id = p_table;

  update holdem_seats
     set bet = 0, total = 0, all_in = false, last_action = null,
         folded = (chips <= 0 or user_id is null or sitting_out),
         needs_to_act = false
   where table_id = p_table;

  -- Button moves to the next seat with chips.
  update holdem_tables set dealer_seat = holdem_next_live(p_table, t.dealer_seat)
   where id = p_table;
  select * into t from holdem_tables where id = p_table;

  -- Two hole cards each.
  for s in select seat_idx from holdem_seats
            where table_id = p_table and not folded order by seat_idx loop
    holes := jsonb_set(holes, ARRAY[s.seat_idx::text],
                       to_jsonb(ARRAY[deck[pos], deck[pos+1]]));
    pos := pos + 2;
  end loop;

  insert into holdem_secrets (table_id, deck, holes)
  values (p_table, deck[pos:52], holes)
  on conflict (table_id) do update set deck = excluded.deck, holes = excluded.holes;

  -- Blinds
  if heads_up then
    sb_seat := t.dealer_seat;                       -- button posts the small blind
    bb_seat := holdem_next_live(p_table, sb_seat);
    first_seat := sb_seat;                          -- and acts first pre-flop
  else
    sb_seat := holdem_next_live(p_table, t.dealer_seat);
    bb_seat := holdem_next_live(p_table, sb_seat);
    first_seat := holdem_next_to_act(p_table, bb_seat);
  end if;

  perform holdem_put(p_table, sb_seat, t.sb);
  update holdem_seats set last_action = 'SB' where table_id = p_table and seat_idx = sb_seat;

  perform holdem_put(p_table, bb_seat, t.bb);
  update holdem_seats set last_action = 'BB' where table_id = p_table and seat_idx = bb_seat;

  update holdem_seats set needs_to_act = true
   where table_id = p_table and not folded and not all_in;

  update holdem_tables
     set to_act_seat = first_seat,
         act_deadline = now() + ((cfg->>'act_seconds')::int || ' seconds')::interval
   where id = p_table;

  insert into holdem_actions (table_id, hand_no, action)
  values (p_table, t.hand_no, 'deal');

  return jsonb_build_object('ok', true, 'handNo', t.hand_no, 'headsUp', heads_up);
end $$;

revoke execute on function public.holdem_config()                       from public, anon, authenticated;
revoke execute on function public.holdem_next_live(bigint, int)         from public, anon, authenticated;
revoke execute on function public.holdem_next_to_act(bigint, int)       from public, anon, authenticated;
revoke execute on function public.holdem_put(bigint, int, bigint)       from public, anon, authenticated;
revoke execute on function public.holdem_new_hand(bigint)               from public, anon, authenticated;

select 'holdem schema ready' as status,
       (select count(*) from information_schema.tables
         where table_schema='public' and table_name like 'holdem%') as tables;
