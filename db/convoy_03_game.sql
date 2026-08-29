-- Convoy multiplayer — part 3: the game itself
--
-- Ported from the CV functions in index.html. Same rules, same edge cases,
-- but the server holds the deck and decides who wins.
--
-- Rules encoded here, for the record:
--   * 5 held cards + 4 lanes, each lane seeded with 1 card, filling to 5
--   * players alternate: draw one card, then place it in a lane OR swap it
--     into the held hand (once per player per game — the old held card is
--     gone, not discarded to anywhere)
--   * if a player's lanes are all full, the turn passes back; if both are
--     full, or the pile empties, the game scores immediately
--   * one checkpoint betting round, fired when all four lanes on BOTH sides
--     hold 3+ cards. check/call/raise/fold, raise = stake, max 3 raises
--   * scoring: five matchups — lanes 0..3 positionally, then held vs held.
--     An incomplete lane scores -1 and loses to anything complete. Level
--     matchups break on total strength; identical totals push the pot.
--
-- Deliberate difference from single player: there is NO bankroll reset when
-- a player busts. That's a courtesy offline and free money online.

-- ===========================================================================
-- 1. Extra state the multiplayer version needs
-- ===========================================================================

alter table public.convoy_games
  add column if not exists committed_a  bigint  not null default 0,
  add column if not exists committed_b  bigint  not null default 0,
  add column if not exists paid_a       bigint  not null default 0,
  add column if not exists paid_b       bigint  not null default 0,
  add column if not exists acted_a      boolean not null default false,
  add column if not exists acted_b      boolean not null default false,
  add column if not exists disc_a       boolean not null default false,
  add column if not exists disc_b       boolean not null default false,
  add column if not exists checkpoint_done boolean not null default false;

alter table public.convoy_secrets
  add column if not exists drawn_card smallint;   -- the card in the actor's hand

-- ===========================================================================
-- 2. convoy_state — what one player is allowed to see
--
-- The ONLY read path for clients. Never select the tables directly: the pile
-- order and the opponent's held cards are exactly what a cheater wants.
-- ===========================================================================

create or replace function public.convoy_state(p_game bigint, p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g record; s record;
  me_is_a boolean;
  my_lanes jsonb; opp_lanes jsonb;
  opp uuid;
begin
  select * into g from convoy_games where id = p_game;
  if not found then return jsonb_build_object('error', 'no_such_game'); end if;

  if p_user <> g.player_a and p_user <> g.player_b then
    return jsonb_build_object('error', 'not_your_game');
  end if;

  me_is_a := (p_user = g.player_a);
  opp := case when me_is_a then g.player_b else g.player_a end;

  select * into s from convoy_secrets where game_id = p_game;

  select jsonb_agg(cards order by lane_idx) into my_lanes
    from convoy_board where game_id = p_game and user_id = p_user;
  select jsonb_agg(cards order by lane_idx) into opp_lanes
    from convoy_board where game_id = p_game and user_id = opp;

  return jsonb_build_object(
    'gameId',      g.id,
    'phase',       g.phase,
    'stake',       g.stake,
    'pot',         g.pot,
    'yourTurn',    g.to_act = p_user,
    'deadline',    g.act_deadline,
    'pileLeft',    coalesce(array_length(s.pile, 1), 0),
    'lanes',       coalesce(my_lanes, '[]'::jsonb),
    'oppLanes',    coalesce(opp_lanes, '[]'::jsonb),
    -- Your own held cards. The opponent's are a count, never the cards.
    'held',        to_jsonb(case when me_is_a then s.hole_a else s.hole_b end),
    'oppHeldCount', coalesce(array_length(case when me_is_a then s.hole_b else s.hole_a end, 1), 0),
    'canSwap',     not (case when me_is_a then g.disc_a else g.disc_b end),
    -- The drawn card belongs to whoever is acting, and only they see it.
    'drawn',       case when g.to_act = p_user then s.drawn_card else null end,
    'betting',     case when g.phase = 'checkpoint' then jsonb_build_object(
                       'raises',    g.raises,
                       'youOwe',    greatest(0,
                          (case when me_is_a then g.committed_b else g.committed_a end)
                        - (case when me_is_a then g.committed_a else g.committed_b end)),
                       'maxRaises', (convoy_config()->>'max_raises')::int
                     ) else null end,
    -- Held hands and full results are only revealed once the game is over.
    'result',      case when g.phase = 'done' then g.result else null end,
    'oppHeld',     case when g.phase = 'done'
                        then to_jsonb(case when me_is_a then s.hole_b else s.hole_a end)
                        else null end,
    'winner',      g.winner
  );
end $$;

-- ===========================================================================
-- 3. convoy_join — matchmaking. Returns a game if one was made, else queues.
-- ===========================================================================

create or replace function public.convoy_join(p_user uuid, p_stake bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb := convoy_config();
  v_opp uuid;
  v_game bigint;
  deck smallint[];
  hole_a smallint[]; hole_b smallint[];
  pos int := 1;
  i int; L int;
  v_chips bigint;
begin
  select chips into v_chips from profiles where id = p_user;
  if v_chips is null then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;
  if v_chips < p_stake then return jsonb_build_object('ok', false, 'error', 'insufficient_chips'); end if;

  -- Already sitting at a live table? Send them back to it.
  select id into v_game from convoy_games
   where phase <> 'done' and (player_a = p_user or player_b = p_user) limit 1;
  if v_game is not null then
    return jsonb_build_object('ok', true, 'status', 'rejoined', 'gameId', v_game);
  end if;

  -- Longest wait at this stake wins the match. FOR UPDATE SKIP LOCKED so two
  -- players joining at the same instant can't both claim the same opponent.
  select user_id into v_opp from convoy_queue
   where stake = p_stake and user_id <> p_user
   order by joined_at
   for update skip locked
   limit 1;

  if v_opp is null then
    insert into convoy_queue (user_id, stake) values (p_user, p_stake)
    on conflict (user_id) do update set stake = excluded.stake, joined_at = now();
    return jsonb_build_object('ok', true, 'status', 'queued');
  end if;

  delete from convoy_queue where user_id in (p_user, v_opp);

  -- Opponent may have gone broke while waiting.
  select chips into v_chips from profiles where id = v_opp;
  if v_chips < p_stake then
    insert into convoy_queue (user_id, stake) values (p_user, p_stake)
    on conflict (user_id) do update set stake = excluded.stake, joined_at = now();
    return jsonb_build_object('ok', true, 'status', 'queued');
  end if;

  deck := shuffled_deck();

  insert into convoy_games (player_a, player_b, stake, pot, to_act, act_deadline,
                            paid_a, paid_b)
  values (v_opp, p_user, p_stake, p_stake * 2, v_opp,
          now() + ((cfg->>'turn_seconds')::int || ' seconds')::interval,
          p_stake, p_stake)
  returning id into v_game;

  -- Escrow both stakes now. Nobody can spend chips they've committed.
  perform credit_chips(v_opp,  -p_stake, 'convoy_stake', 'convoy:' || v_game || ':stake:a');
  perform credit_chips(p_user, -p_stake, 'convoy_stake', 'convoy:' || v_game || ':stake:b');

  -- Five held cards each, then one card seeding each of the four lanes.
  hole_a := deck[1:5];      pos := 6;
  hole_b := deck[pos:pos+4]; pos := pos + 5;

  insert into convoy_secrets (game_id, pile, hole_a, hole_b)
  values (v_game, deck[pos+8:52], hole_a, hole_b);

  for i in 0..1 loop
    for L in 0..3 loop
      insert into convoy_board (game_id, user_id, lane_idx, cards)
      values (v_game, case when i = 0 then v_opp else p_user end, L,
              ARRAY[deck[pos]]);
      pos := pos + 1;
    end loop;
  end loop;

  insert into convoy_actions (game_id, action, payload)
  values (v_game, 'deal', jsonb_build_object('stake', p_stake));

  return jsonb_build_object('ok', true, 'status', 'matched', 'gameId', v_game);
end $$;

-- ===========================================================================
-- 4. Internals — scoring, checkpoint, turn advance
-- ===========================================================================

create or replace function public.convoy_finish(p_game bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g record; s record;
  rows jsonb := '[]'::jsonb;
  a smallint[]; b smallint[];
  av bigint; bv bigint;
  wa int := 0; wb int := 0;
  suma bigint := 0; sumb bigint := 0;
  L int; r int;
  v_winner uuid; v_reason text;
begin
  select * into g from convoy_games where id = p_game for update;
  if g.phase = 'done' then return g.result; end if;

  select * into s from convoy_secrets where game_id = p_game;

  for L in 0..4 loop
    if L < 4 then
      select cards into a from convoy_board where game_id = p_game and user_id = g.player_a and lane_idx = L;
      select cards into b from convoy_board where game_id = p_game and user_id = g.player_b and lane_idx = L;
    else
      a := s.hole_a; b := s.hole_b;
    end if;

    -- An incomplete lane scores -1 and loses to anything complete.
    av := case when coalesce(array_length(a,1),0) >= 5 then score5(a[1:5]) else -1 end;
    bv := case when coalesce(array_length(b,1),0) >= 5 then score5(b[1:5]) else -1 end;

    suma := suma + greatest(av, 0);
    sumb := sumb + greatest(bv, 0);

    r := case when av > bv then 0 when bv > av then 1 else -1 end;
    if r = 0 then wa := wa + 1; elsif r = 1 then wb := wb + 1; end if;

    rows := rows || jsonb_build_object('lane', L, 'a', av, 'b', bv, 'winner', r);
  end loop;

  if wa > wb then
    v_winner := g.player_a; v_reason := 'matchups';
  elsif wb > wa then
    v_winner := g.player_b; v_reason := 'matchups';
  elsif suma > sumb then
    v_winner := g.player_a; v_reason := 'total_strength';
  elsif sumb > suma then
    v_winner := g.player_b; v_reason := 'total_strength';
  else
    v_winner := null;       v_reason := 'push';
  end if;

  if v_winner is null then
    -- Dead heat: each player gets their own contribution back.
    perform credit_chips(g.player_a, g.paid_a, 'convoy_push', 'convoy:' || p_game || ':push:a');
    perform credit_chips(g.player_b, g.paid_b, 'convoy_push', 'convoy:' || p_game || ':push:b');
  else
    perform credit_chips(v_winner, g.pot, 'convoy_win', 'convoy:' || p_game || ':payout');
  end if;

  update convoy_games
     set phase = 'done', winner = v_winner, ended_at = now(),
         to_act = null, act_deadline = null,
         result = jsonb_build_object(
           'reason', v_reason, 'matchups', rows,
           'winsA', wa, 'winsB', wb, 'sumA', suma, 'sumB', sumb)
   where id = p_game;

  select result into rows from convoy_games where id = p_game;
  return rows;
end $$;

-- ---------------------------------------------------------------------------
-- convoy_advance — flip the turn, skipping anyone whose lanes are all full.
-- ---------------------------------------------------------------------------
create or replace function public.convoy_advance(p_game bigint)
returns void
language plpgsql security definer set search_path = public as $$
declare
  g record;
  cfg jsonb := convoy_config();
  next_user uuid;
  pile_left int;
begin
  select * into g from convoy_games where id = p_game;

  select coalesce(array_length(pile, 1), 0) into pile_left
    from convoy_secrets where game_id = p_game;

  if pile_left = 0 then
    perform convoy_finish(p_game);
    return;
  end if;

  next_user := case when g.to_act = g.player_a then g.player_b else g.player_a end;

  -- Lanes all full? Pass it back. Both full? Score.
  if (select bool_and(coalesce(array_length(cards,1),0) >= 5)
        from convoy_board where game_id = p_game and user_id = next_user) then
    next_user := case when next_user = g.player_a then g.player_b else g.player_a end;

    if (select bool_and(coalesce(array_length(cards,1),0) >= 5)
          from convoy_board where game_id = p_game and user_id = next_user) then
      perform convoy_finish(p_game);
      return;
    end if;
  end if;

  update convoy_games
     set to_act = next_user,
         act_deadline = now() + ((cfg->>'turn_seconds')::int || ' seconds')::interval,
         phase = 'building'
   where id = p_game;

  update convoy_secrets set drawn_card = null where game_id = p_game;
end $$;

-- ---------------------------------------------------------------------------
-- convoy_maybe_checkpoint — fires once, when every lane on BOTH sides has 3+.
-- ---------------------------------------------------------------------------
create or replace function public.convoy_maybe_checkpoint(p_game bigint)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  g record;
  cfg jsonb := convoy_config();
  ready boolean;
begin
  select * into g from convoy_games where id = p_game;
  if g.checkpoint_done or g.phase = 'checkpoint' then return false; end if;

  select bool_and(coalesce(array_length(cards,1),0) >= (cfg->>'lane_target')::int)
    into ready from convoy_board where game_id = p_game;

  if not ready then return false; end if;

  update convoy_games
     set phase = 'checkpoint', to_act = player_a,
         committed_a = 0, committed_b = 0,
         acted_a = false, acted_b = false, raises = 0,
         act_deadline = now() + ((cfg->>'checkpoint_seconds')::int || ' seconds')::interval
   where id = p_game;

  insert into convoy_actions (game_id, action) values (p_game, 'checkpoint_open');
  return true;
end $$;

select 'convoy game logic ready' as status;
