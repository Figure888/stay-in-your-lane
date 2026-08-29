-- Match the offline turn order exactly.
--
-- cvAdvance() checks terminal conditions BEFORE the checkpoint:
--   1. both players' lanes full -> score
--   2. pile empty -> score
--   3. checkpoint -> open betting
--   4. otherwise flip the turn
--
-- The server had the checkpoint first, so a placement that both emptied the
-- pile and brought every lane to three deep would open a betting round on a
-- hand that offline would have already scored.

create or replace function public.convoy_after_action(p_game bigint)
returns text
language plpgsql security definer set search_path = public as $$
declare
  both_full boolean;
  pile_left int;
begin
  select bool_and(coalesce(array_length(cards,1),0) >= 5)
    into both_full from convoy_board where game_id = p_game;

  if both_full then
    perform convoy_finish(p_game);
    return 'scored';
  end if;

  select coalesce(array_length(pile, 1), 0) into pile_left
    from convoy_secrets where game_id = p_game;

  if pile_left = 0 then
    perform convoy_finish(p_game);
    return 'scored';
  end if;

  if convoy_maybe_checkpoint(p_game) then
    return 'checkpoint';
  end if;

  perform convoy_advance(p_game);
  return 'advanced';
end $$;

revoke execute on function public.convoy_after_action(bigint) from public, anon, authenticated;

-- Rewire place and swap to use it.
create or replace function public.convoy_place(p_game bigint, p_user uuid, p_lane int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare g record; s record; cur smallint[]; outcome text;
begin
  if p_lane < 0 or p_lane > 3 then return jsonb_build_object('ok', false, 'error', 'bad_lane'); end if;

  select * into g from convoy_games where id = p_game for update;
  if g.phase <> 'building' then return jsonb_build_object('ok', false, 'error', 'wrong_phase'); end if;
  if g.to_act <> p_user then return jsonb_build_object('ok', false, 'error', 'not_your_turn'); end if;

  select * into s from convoy_secrets where game_id = p_game for update;
  if s.drawn_card is null then return jsonb_build_object('ok', false, 'error', 'nothing_drawn'); end if;

  select cards into cur from convoy_board
   where game_id = p_game and user_id = p_user and lane_idx = p_lane;
  if coalesce(array_length(cur, 1), 0) >= 5 then
    return jsonb_build_object('ok', false, 'error', 'lane_full');
  end if;

  update convoy_board set cards = cards || s.drawn_card
   where game_id = p_game and user_id = p_user and lane_idx = p_lane;

  insert into convoy_actions (game_id, user_id, action, payload)
  values (p_game, p_user, 'place', jsonb_build_object('lane', p_lane, 'card', s.drawn_card));

  update convoy_secrets set drawn_card = null where game_id = p_game;

  outcome := convoy_after_action(p_game);
  return jsonb_build_object('ok', true, 'status', outcome);
end $$;

create or replace function public.convoy_swap(p_game bigint, p_user uuid, p_slot int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare g record; s record; is_a boolean; used boolean; outcome text;
begin
  if p_slot < 0 or p_slot > 4 then return jsonb_build_object('ok', false, 'error', 'bad_slot'); end if;

  select * into g from convoy_games where id = p_game for update;
  if g.phase <> 'building' then return jsonb_build_object('ok', false, 'error', 'wrong_phase'); end if;
  if g.to_act <> p_user then return jsonb_build_object('ok', false, 'error', 'not_your_turn'); end if;

  is_a := (p_user = g.player_a);
  used := case when is_a then g.disc_a else g.disc_b end;
  if used then return jsonb_build_object('ok', false, 'error', 'swap_already_used'); end if;

  select * into s from convoy_secrets where game_id = p_game for update;
  if s.drawn_card is null then return jsonb_build_object('ok', false, 'error', 'nothing_drawn'); end if;

  if is_a then
    update convoy_secrets set hole_a[p_slot + 1] = s.drawn_card, drawn_card = null where game_id = p_game;
    update convoy_games set disc_a = true where id = p_game;
  else
    update convoy_secrets set hole_b[p_slot + 1] = s.drawn_card, drawn_card = null where game_id = p_game;
    update convoy_games set disc_b = true where id = p_game;
  end if;

  insert into convoy_actions (game_id, user_id, action, payload)
  values (p_game, p_user, 'swap', jsonb_build_object('slot', p_slot));

  outcome := convoy_after_action(p_game);
  return jsonb_build_object('ok', true, 'status', outcome);
end $$;

revoke execute on function public.convoy_place(bigint, uuid, int) from public, anon, authenticated;
revoke execute on function public.convoy_swap(bigint, uuid, int)  from public, anon, authenticated;

select 'turn order matched to offline' as status;
