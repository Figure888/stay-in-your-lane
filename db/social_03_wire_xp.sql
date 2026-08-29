-- Wire XP into the end of a game.
--
-- convoy_finish already knows who won, by how much, and how the matchups
-- fell. This adds the XP award to that same transaction, so a game can't
-- settle chips without also settling progression.

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
  xp_a jsonb; xp_b jsonb;
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

    av := case when coalesce(array_length(a,1),0) >= 5 then score5(a[1:5]) else -1 end;
    bv := case when coalesce(array_length(b,1),0) >= 5 then score5(b[1:5]) else -1 end;

    suma := suma + greatest(av, 0);
    sumb := sumb + greatest(bv, 0);

    r := case when av > bv then 0 when bv > av then 1 else -1 end;
    if r = 0 then wa := wa + 1; elsif r = 1 then wb := wb + 1; end if;

    rows := rows || jsonb_build_object('lane', L, 'a', av, 'b', bv, 'winner', r);
  end loop;

  if wa > wb then      v_winner := g.player_a; v_reason := 'matchups';
  elsif wb > wa then   v_winner := g.player_b; v_reason := 'matchups';
  elsif suma > sumb then v_winner := g.player_a; v_reason := 'total_strength';
  elsif sumb > suma then v_winner := g.player_b; v_reason := 'total_strength';
  else                 v_winner := null;       v_reason := 'push';
  end if;

  if v_winner is null then
    perform credit_chips(g.player_a, g.paid_a, 'convoy_push', 'convoy:' || p_game || ':push:a');
    perform credit_chips(g.player_b, g.paid_b, 'convoy_push', 'convoy:' || p_game || ':push:b');
  else
    perform credit_chips(v_winner, g.pot, 'convoy_win', 'convoy:' || p_game || ':payout');
  end if;

  -- XP for both players, in the same transaction as the chips.
  xp_a := award_game_xp(g.player_a, v_winner = g.player_a,
                        case when v_winner = g.player_a then g.pot - g.paid_a else -g.paid_a end, wa);
  xp_b := award_game_xp(g.player_b, v_winner = g.player_b,
                        case when v_winner = g.player_b then g.pot - g.paid_b else -g.paid_b end, wb);

  update convoy_games
     set phase = 'done', winner = v_winner, ended_at = now(),
         to_act = null, act_deadline = null,
         result = jsonb_build_object(
           'reason', v_reason, 'matchups', rows,
           'winsA', wa, 'winsB', wb, 'sumA', suma, 'sumB', sumb,
           'xpA', xp_a, 'xpB', xp_b)
   where id = p_game;

  select result into rows from convoy_games where id = p_game;
  return rows;
end $$;

-- Timeout losses count too — walking away shouldn't dodge the record.
create or replace function public.convoy_sweep()
returns int
language plpgsql security definer set search_path = public as $$
declare
  g record; v_opponent uuid; n int := 0;
begin
  for g in
    select * from convoy_games
     where phase in ('building', 'checkpoint')
       and act_deadline is not null and act_deadline < now()
     for update skip locked
  loop
    v_opponent := case when g.to_act = g.player_a then g.player_b else g.player_a end;

    update convoy_games
       set phase = 'done', winner = v_opponent, ended_at = now(),
           to_act = null, act_deadline = null,
           result = jsonb_build_object('reason', 'timeout', 'folded', g.to_act,
                                       'winsA', 0, 'winsB', 0)
     where id = g.id;

    insert into convoy_actions (game_id, user_id, action, payload)
    values (g.id, g.to_act, 'timeout_fold', jsonb_build_object('awarded_to', v_opponent));

    perform credit_chips(v_opponent, g.pot, 'convoy_timeout_win',
                         'convoy:' || g.id || ':payout');

    perform award_game_xp(v_opponent, true,
                          g.pot - case when v_opponent = g.player_a then g.paid_a else g.paid_b end, 0);
    perform award_game_xp(g.to_act, false,
                          -(case when g.to_act = g.player_a then g.paid_a else g.paid_b end), 0);

    n := n + 1;
  end loop;

  return n;
end $$;

revoke execute on function public.convoy_finish(bigint) from public, anon, authenticated;
revoke execute on function public.convoy_sweep()        from public, anon, authenticated;

-- Surface progression in the state payload so the UI can show it.
create or replace function public.player_progress(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare p record; t jsonb; nxt bigint;
begin
  select xp, wins, losses, chips_won, username, display_name, avatar
    into p from profiles where id = p_user;
  if not found then return jsonb_build_object('ok', false); end if;

  t := tier_for(p.xp);
  nxt := nullif(t->>'next', '')::bigint;

  return jsonb_build_object(
    'ok', true,
    'name', coalesce(p.username, p.display_name),
    'avatar', p.avatar,
    'xp', p.xp,
    'wins', p.wins,
    'losses', p.losses,
    'chipsWon', p.chips_won,
    'tier', t,
    'nextAt', nxt,
    'progress', case when nxt is null then 1.0
                     else round((p.xp::numeric / nxt), 3) end
  );
end $$;

revoke execute on function public.player_progress(uuid) from public, anon, authenticated;

select 'xp wired into game settlement' as status;
