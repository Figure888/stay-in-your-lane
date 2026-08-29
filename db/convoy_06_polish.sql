-- Convoy polish — hand readouts and opponent presence.
--
-- Run after convoy_05_private.sql.

-- ===========================================================================
-- 1. Display names. profiles only has an email, and showing someone's email
--    to their opponent is both ugly and a privacy leak.
-- ===========================================================================

alter table public.profiles
  add column if not exists display_name text;

update public.profiles
   set display_name = split_part(email, '@', 1)
 where display_name is null and email is not null;

-- ===========================================================================
-- 2. partial_read — what a lane is building toward before it's complete.
--
--    A lane isn't a hand until it holds five, but "3 to a flush" is the
--    information a player actually wants while deciding where to place.
-- ===========================================================================

create or replace function public.partial_read(cards smallint[])
returns text
language plpgsql immutable as $$
declare
  n int := coalesce(array_length(cards, 1), 0);
  counts int[] := array_fill(0, ARRAY[13]);
  suits  int[] := array_fill(0, ARRAY[4]);
  c int; r int; i int;
  best_rank int := -1; best_count int := 0;
  suited int := 0;
  ranks int[]; run int := 1; longest int := 1;
  rank_names text[] := ARRAY['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
begin
  if n = 0 then return ''; end if;

  foreach c in array cards loop
    counts[(c / 4) + 1] := counts[(c / 4) + 1] + 1;
    suits[(c % 4) + 1]  := suits[(c % 4) + 1] + 1;
  end loop;

  for i in 1..13 loop
    if counts[i] > best_count or (counts[i] = best_count and i - 1 > best_rank) then
      if counts[i] >= 2 then best_count := counts[i]; best_rank := i - 1; end if;
    end if;
  end loop;

  for i in 1..4 loop
    if suits[i] > suited then suited := suits[i]; end if;
  end loop;

  -- Longest run of consecutive distinct ranks.
  select array_agg(g order by g) into ranks
    from generate_series(0, 12) g where counts[g + 1] > 0;

  if array_length(ranks, 1) > 1 then
    for i in 2..array_length(ranks, 1) loop
      if ranks[i] = ranks[i - 1] + 1 then
        run := run + 1;
        if run > longest then longest := run; end if;
      else
        run := 1;
      end if;
    end loop;
  end if;

  -- Report the strongest thing going, in the order a player would care.
  if best_count >= 3 then
    return best_count || ' of a kind, ' || rank_names[best_rank + 1] || 's';
  elsif suited >= 3 then
    return suited || ' to a flush';
  elsif longest >= 3 then
    return longest || ' to a straight';
  elsif best_count = 2 then
    return 'pair of ' || rank_names[best_rank + 1] || 's';
  end if;

  return n || ' card' || case when n = 1 then '' else 's' end;
end $$;

-- ===========================================================================
-- 3. convoy_state, extended.
--
--    Adds: your own hand readouts (never the opponent's — that's their
--    information), both display names, and the last action taken so the
--    board doesn't silently change under you.
-- ===========================================================================

create or replace function public.convoy_state(p_game bigint, p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g record; s record;
  me_is_a boolean;
  my_lanes jsonb; opp_lanes jsonb;
  opp uuid;
  reads jsonb := '[]'::jsonb;
  lane_cards smallint[];
  L int;
  sc bigint; best_score bigint := -1; best_lane int := -1;
  held smallint[];
  last_act record;
  my_name text; opp_name text;
begin
  select * into g from convoy_games where id = p_game;
  if not found then return jsonb_build_object('error', 'no_such_game'); end if;

  if p_user <> g.player_a and p_user <> g.player_b then
    return jsonb_build_object('error', 'not_your_game');
  end if;

  me_is_a := (p_user = g.player_a);
  opp := case when me_is_a then g.player_b else g.player_a end;

  select * into s from convoy_secrets where game_id = p_game;

  select coalesce(display_name, split_part(email, '@', 1), 'Player')
    into my_name from profiles where id = p_user;
  select coalesce(display_name, split_part(email, '@', 1), 'Opponent')
    into opp_name from profiles where id = opp;

  select jsonb_agg(cards order by lane_idx) into my_lanes
    from convoy_board where game_id = p_game and user_id = p_user;
  select jsonb_agg(cards order by lane_idx) into opp_lanes
    from convoy_board where game_id = p_game and user_id = opp;

  -- Your own readouts. The opponent's lanes are face-up, but working out
  -- what they hold is part of the game — we don't do it for you.
  for L in 0..3 loop
    select cards into lane_cards from convoy_board
     where game_id = p_game and user_id = p_user and lane_idx = L;

    if coalesce(array_length(lane_cards, 1), 0) >= 5 then
      sc := score5(lane_cards[1:5]);
      if sc > best_score then best_score := sc; best_lane := L; end if;
      reads := reads || jsonb_build_object(
        'lane', L, 'complete', true, 'label', hand_category(sc), 'score', sc);
    else
      reads := reads || jsonb_build_object(
        'lane', L, 'complete', false, 'label', partial_read(lane_cards));
    end if;
  end loop;

  held := case when me_is_a then s.hole_a else s.hole_b end;

  select user_id, action, payload, created_at into last_act
    from convoy_actions
   where game_id = p_game and user_id is not null and user_id <> p_user
   order by id desc limit 1;

  return jsonb_build_object(
    'gameId',      g.id,
    'phase',       g.phase,
    'stake',       g.stake,
    'pot',         g.pot,
    'yourTurn',    g.to_act = p_user,
    'deadline',    g.act_deadline,
    'pileLeft',    coalesce(array_length(s.pile, 1), 0),
    'you',         my_name,
    'oppName',     opp_name,
    'lanes',       coalesce(my_lanes, '[]'::jsonb),
    'oppLanes',    coalesce(opp_lanes, '[]'::jsonb),
    'handReads',   reads,
    'bestLane',    best_lane,
    'heldRead',    case when coalesce(array_length(held,1),0) >= 5
                        then hand_category(score5(held[1:5]))
                        else partial_read(held) end,
    'held',        to_jsonb(held),
    'oppHeldCount', coalesce(array_length(case when me_is_a then s.hole_b else s.hole_a end, 1), 0),
    'canSwap',     not (case when me_is_a then g.disc_a else g.disc_b end),
    'drawn',       case when g.to_act = p_user then s.drawn_card else null end,
    'lastAction',  case when last_act.action is null then null
                        else jsonb_build_object('action', last_act.action,
                                                'payload', last_act.payload,
                                                'at', last_act.created_at) end,
    'betting',     case when g.phase = 'checkpoint' then jsonb_build_object(
                       'raises',    g.raises,
                       'youOwe',    greatest(0,
                          (case when me_is_a then g.committed_b else g.committed_a end)
                        - (case when me_is_a then g.committed_a else g.committed_b end)),
                       'maxRaises', (convoy_config()->>'max_raises')::int
                     ) else null end,
    'result',      case when g.phase = 'done' then g.result else null end,
    'oppHeld',     case when g.phase = 'done'
                        then to_jsonb(case when me_is_a then s.hole_b else s.hole_a end)
                        else null end,
    'winner',      g.winner,
    'youAre',      case when me_is_a then 'a' else 'b' end
  );
end $$;

revoke execute on function public.partial_read(smallint[]) from public, anon, authenticated;

select partial_read(ARRAY[0,4,8]::smallint[])    as three_suited,
       partial_read(ARRAY[0,1,4,9]::smallint[])  as has_pair,
       partial_read(ARRAY[0,5,10]::smallint[])   as straight_draw,
       hand_category(score5(ARRAY[48,44,40,36,32]::smallint[])) as complete;
