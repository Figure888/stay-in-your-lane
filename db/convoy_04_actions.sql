-- Convoy multiplayer — part 4: player actions
--
-- Run after convoy_03_game.sql. Every function here checks that it really is
-- the caller's turn before touching anything, so a client sending a
-- well-formed action out of turn gets rejected rather than obeyed.

-- ===========================================================================
-- convoy_draw — take the top card off the pile
-- ===========================================================================

create or replace function public.convoy_draw(p_game bigint, p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g record; s record;
  card smallint;
begin
  select * into g from convoy_games where id = p_game for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_such_game'); end if;
  if g.phase <> 'building' then return jsonb_build_object('ok', false, 'error', 'wrong_phase'); end if;
  if g.to_act <> p_user then return jsonb_build_object('ok', false, 'error', 'not_your_turn'); end if;

  select * into s from convoy_secrets where game_id = p_game for update;
  if s.drawn_card is not null then
    return jsonb_build_object('ok', false, 'error', 'already_drawn', 'card', s.drawn_card);
  end if;

  if coalesce(array_length(s.pile, 1), 0) = 0 then
    return jsonb_build_object('ok', true, 'status', 'pile_empty',
                              'result', convoy_finish(p_game));
  end if;

  card := s.pile[array_length(s.pile, 1)];

  update convoy_secrets
     set pile = pile[1:array_length(pile,1) - 1], drawn_card = card
   where game_id = p_game;

  insert into convoy_actions (game_id, user_id, action) values (p_game, p_user, 'draw');

  return jsonb_build_object('ok', true, 'card', card,
                            'canSwap', not (case when p_user = g.player_a then g.disc_a else g.disc_b end));
end $$;

-- ===========================================================================
-- convoy_place — put the drawn card into one of your lanes
-- ===========================================================================

create or replace function public.convoy_place(p_game bigint, p_user uuid, p_lane int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g record; s record;
  cur smallint[];
begin
  if p_lane < 0 or p_lane > 3 then
    return jsonb_build_object('ok', false, 'error', 'bad_lane');
  end if;

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

  -- Checkpoint takes precedence over passing the turn.
  if convoy_maybe_checkpoint(p_game) then
    return jsonb_build_object('ok', true, 'status', 'checkpoint');
  end if;

  perform convoy_advance(p_game);
  return jsonb_build_object('ok', true, 'status', 'placed');
end $$;

-- ===========================================================================
-- convoy_swap — swap the drawn card into your held hand.
--
-- Once per player per game. The replaced card is gone entirely — it does not
-- go back to the pile or into a lane.
-- ===========================================================================

create or replace function public.convoy_swap(p_game bigint, p_user uuid, p_slot int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g record; s record;
  is_a boolean;
  used boolean;
begin
  if p_slot < 0 or p_slot > 4 then
    return jsonb_build_object('ok', false, 'error', 'bad_slot');
  end if;

  select * into g from convoy_games where id = p_game for update;
  if g.phase <> 'building' then return jsonb_build_object('ok', false, 'error', 'wrong_phase'); end if;
  if g.to_act <> p_user then return jsonb_build_object('ok', false, 'error', 'not_your_turn'); end if;

  is_a := (p_user = g.player_a);
  used := case when is_a then g.disc_a else g.disc_b end;
  if used then return jsonb_build_object('ok', false, 'error', 'swap_already_used'); end if;

  select * into s from convoy_secrets where game_id = p_game for update;
  if s.drawn_card is null then return jsonb_build_object('ok', false, 'error', 'nothing_drawn'); end if;

  if is_a then
    update convoy_secrets set hole_a[p_slot + 1] = s.drawn_card, drawn_card = null
     where game_id = p_game;
    update convoy_games set disc_a = true where id = p_game;
  else
    update convoy_secrets set hole_b[p_slot + 1] = s.drawn_card, drawn_card = null
     where game_id = p_game;
    update convoy_games set disc_b = true where id = p_game;
  end if;

  -- Slot is logged, the card is not: the log is readable by admins and the
  -- held hand stays sealed until reveal.
  insert into convoy_actions (game_id, user_id, action, payload)
  values (p_game, p_user, 'swap', jsonb_build_object('slot', p_slot));

  if convoy_maybe_checkpoint(p_game) then
    return jsonb_build_object('ok', true, 'status', 'checkpoint');
  end if;

  perform convoy_advance(p_game);
  return jsonb_build_object('ok', true, 'status', 'swapped');
end $$;

-- ===========================================================================
-- convoy_bet — the checkpoint round. 'check', 'call', 'raise', 'fold'.
--
-- A raise is always exactly the stake on top of what you owe. Max three
-- raises, after which a raise attempt is treated as a call.
-- ===========================================================================

create or replace function public.convoy_bet(p_game bigint, p_user uuid, p_action text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g record;
  cfg jsonb := convoy_config();
  is_a boolean;
  my_committed bigint; opp_committed bigint;
  need bigint; want bigint; got bigint;
  my_chips bigint;
  opp uuid;
  both_acted boolean;
begin
  select * into g from convoy_games where id = p_game for update;
  if g.phase <> 'checkpoint' then return jsonb_build_object('ok', false, 'error', 'not_betting'); end if;
  if g.to_act <> p_user then return jsonb_build_object('ok', false, 'error', 'not_your_turn'); end if;

  is_a := (p_user = g.player_a);
  opp  := case when is_a then g.player_b else g.player_a end;
  my_committed  := case when is_a then g.committed_a else g.committed_b end;
  opp_committed := case when is_a then g.committed_b else g.committed_a end;
  need := greatest(0, opp_committed - my_committed);

  -- ---------------------------------------------------------------- fold
  if p_action = 'fold' then
    update convoy_games
       set phase = 'done', winner = opp, ended_at = now(),
           to_act = null, act_deadline = null,
           result = jsonb_build_object('reason', 'fold', 'folded', p_user)
     where id = p_game;

    perform credit_chips(opp, g.pot, 'convoy_fold_win', 'convoy:' || p_game || ':payout');
    insert into convoy_actions (game_id, user_id, action) values (p_game, p_user, 'fold');
    return jsonb_build_object('ok', true, 'status', 'folded');
  end if;

  -- --------------------------------------------------------------- raise
  if p_action = 'raise' then
    if g.raises >= (cfg->>'max_raises')::int then
      return convoy_bet(p_game, p_user, 'call');    -- cap reached, treat as a call
    end if;

    want := need + g.stake;
    select chips into my_chips from profiles where id = p_user;
    got := least(want, my_chips);

    if got <= 0 then
      return convoy_bet(p_game, p_user, 'call');
    end if;

    perform credit_chips(p_user, -got, 'convoy_bet',
                         'convoy:' || p_game || ':bet:' || p_user || ':' || g.raises || ':r');

    if is_a then
      update convoy_games set committed_a = committed_a + got, paid_a = paid_a + got,
                              pot = pot + got where id = p_game;
    else
      update convoy_games set committed_b = committed_b + got, paid_b = paid_b + got,
                              pot = pot + got where id = p_game;
    end if;

    -- Short of the full raise means they're all in; end the round there.
    if got < want then
      update convoy_games set acted_a = true, acted_b = true where id = p_game;
      perform convoy_end_betting(p_game);
      return jsonb_build_object('ok', true, 'status', 'all_in');
    end if;

    update convoy_games
       set raises = raises + 1, to_act = opp,
           acted_a = case when is_a then true else false end,
           acted_b = case when is_a then false else true end,
           act_deadline = now() + ((cfg->>'checkpoint_seconds')::int || ' seconds')::interval
     where id = p_game;

    insert into convoy_actions (game_id, user_id, action, payload)
    values (p_game, p_user, 'raise', jsonb_build_object('amount', got));

    return jsonb_build_object('ok', true, 'status', 'raised', 'amount', got);
  end if;

  -- ------------------------------------------------------ check and call
  if p_action not in ('check', 'call') then
    return jsonb_build_object('ok', false, 'error', 'bad_action');
  end if;

  if need > 0 then
    select chips into my_chips from profiles where id = p_user;
    got := least(need, my_chips);

    if got > 0 then
      perform credit_chips(p_user, -got, 'convoy_bet',
                           'convoy:' || p_game || ':bet:' || p_user || ':' || g.raises || ':c');
      if is_a then
        update convoy_games set committed_a = committed_a + got, paid_a = paid_a + got,
                                pot = pot + got where id = p_game;
      else
        update convoy_games set committed_b = committed_b + got, paid_b = paid_b + got,
                                pot = pot + got where id = p_game;
      end if;
    end if;

    insert into convoy_actions (game_id, user_id, action, payload)
    values (p_game, p_user, 'call', jsonb_build_object('amount', got));

    if got < need then          -- called all-in for less
      update convoy_games set acted_a = true, acted_b = true where id = p_game;
      perform convoy_end_betting(p_game);
      return jsonb_build_object('ok', true, 'status', 'all_in');
    end if;
  else
    insert into convoy_actions (game_id, user_id, action) values (p_game, p_user, 'check');
  end if;

  if is_a then
    update convoy_games set acted_a = true where id = p_game;
  else
    update convoy_games set acted_b = true where id = p_game;
  end if;

  select acted_a and acted_b and committed_a = committed_b
    into both_acted from convoy_games where id = p_game;

  if both_acted then
    perform convoy_end_betting(p_game);
    return jsonb_build_object('ok', true, 'status', 'betting_closed');
  end if;

  update convoy_games
     set to_act = opp,
         act_deadline = now() + ((cfg->>'checkpoint_seconds')::int || ' seconds')::interval
   where id = p_game;

  return jsonb_build_object('ok', true, 'status', 'acted');
end $$;

-- ---------------------------------------------------------------------------
-- convoy_end_betting — close the round and hand play back to the build.
-- ---------------------------------------------------------------------------
create or replace function public.convoy_end_betting(p_game bigint)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update convoy_games set checkpoint_done = true, phase = 'building' where id = p_game;
  insert into convoy_actions (game_id, action) values (p_game, 'checkpoint_closed');
  perform convoy_advance(p_game);
end $$;

-- ===========================================================================
-- Only the service role calls any of this.
-- ===========================================================================

revoke execute on function public.convoy_state(bigint, uuid)          from public, anon, authenticated;
revoke execute on function public.convoy_join(uuid, bigint)           from public, anon, authenticated;
revoke execute on function public.convoy_draw(bigint, uuid)           from public, anon, authenticated;
revoke execute on function public.convoy_place(bigint, uuid, int)     from public, anon, authenticated;
revoke execute on function public.convoy_swap(bigint, uuid, int)      from public, anon, authenticated;
revoke execute on function public.convoy_bet(bigint, uuid, text)      from public, anon, authenticated;
revoke execute on function public.convoy_finish(bigint)               from public, anon, authenticated;
revoke execute on function public.convoy_advance(bigint)              from public, anon, authenticated;
revoke execute on function public.convoy_maybe_checkpoint(bigint)     from public, anon, authenticated;
revoke execute on function public.convoy_end_betting(bigint)          from public, anon, authenticated;

select routine_name from information_schema.routines
where routine_schema = 'public' and routine_name like 'convoy%'
order by routine_name;
