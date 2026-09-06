-- Return both players' avatars in the convoy state, so the table can show a
-- face instead of an initial.

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
  my_av text; opp_av text;
begin
  select * into g from convoy_games where id = p_game;
  if not found then return jsonb_build_object('error', 'no_such_game'); end if;

  if p_user <> g.player_a and p_user <> g.player_b then
    return jsonb_build_object('error', 'not_your_game');
  end if;

  me_is_a := (p_user = g.player_a);
  opp := case when me_is_a then g.player_b else g.player_a end;

  select * into s from convoy_secrets where game_id = p_game;

  select coalesce(display_name, split_part(email, '@', 1), 'Player'), avatar
    into my_name, my_av from profiles where id = p_user;
  select coalesce(display_name, split_part(email, '@', 1), 'Opponent'), avatar
    into opp_name, opp_av from profiles where id = opp;

  select jsonb_agg(cards order by lane_idx) into my_lanes
    from convoy_board where game_id = p_game and user_id = p_user;
  select jsonb_agg(cards order by lane_idx) into opp_lanes
    from convoy_board where game_id = p_game and user_id = opp;

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
    'youAvatar',   my_av,
    'oppAvatar',   opp_av,
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

revoke execute on function public.convoy_state(bigint, uuid) from public, anon, authenticated;

select 'avatars in convoy state' as status;
