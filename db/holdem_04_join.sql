-- Lane Hold'em online — matchmaking and the filtered state view.

-- ===========================================================================
-- holdem_join — take a seat, buying in from your wallet.
--
-- Chips move out of profiles.chips and onto the table. They come back when
-- you stand up, so a stack in play can't also be spent in the store.
-- ===========================================================================

create or replace function public.holdem_join(p_user uuid, p_buyin bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t record; v_chips bigint; v_table bigint; v_seat int; i int;
begin
  -- Already sitting somewhere? Send them back to it.
  select ht.id into v_table
    from holdem_seats hs join holdem_tables ht on ht.id = hs.table_id
   where hs.user_id = p_user and ht.phase <> 'done'
   limit 1;

  if v_table is not null then
    return jsonb_build_object('ok', true, 'status', 'rejoined', 'tableId', v_table);
  end if;

  select chips into v_chips from profiles where id = p_user;
  if v_chips is null then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;
  if v_chips < p_buyin then return jsonb_build_object('ok', false, 'error', 'insufficient_chips'); end if;

  -- An open table at this buy-in with a free seat. SKIP LOCKED so two players
  -- arriving at the same instant don't claim the same chair.
  select ht.* into t from holdem_tables ht
   where ht.buyin = p_buyin and ht.phase in ('waiting', 'betting', 'showdown')
     and (select count(*) from holdem_seats hs
           where hs.table_id = ht.id and hs.user_id is not null) < ht.seats
   order by ht.created_at
   for update skip locked
   limit 1;

  if not found then
    insert into holdem_tables (seats, sb, bb, buyin)
    values (2, greatest(1, p_buyin / 100), greatest(2, p_buyin / 50), p_buyin)
    returning * into t;

    for i in 0..t.seats - 1 loop
      insert into holdem_seats (table_id, seat_idx) values (t.id, i);
    end loop;
  end if;

  select seat_idx into v_seat from holdem_seats
   where table_id = t.id and user_id is null
   order by seat_idx limit 1;

  if v_seat is null then return jsonb_build_object('ok', false, 'error', 'table_full'); end if;

  perform credit_chips(p_user, -p_buyin, 'holdem_buyin',
                       'holdem:' || t.id || ':' || v_seat || ':buyin:' ||
                       extract(epoch from clock_timestamp())::bigint);

  update holdem_seats
     set user_id = p_user, chips = p_buyin, folded = true, joined_at = now()
   where table_id = t.id and seat_idx = v_seat;

  -- Two seated and nothing running? Deal.
  if (select count(*) from holdem_seats
       where table_id = t.id and user_id is not null and chips > 0) >= 2
     and t.phase = 'waiting' then
    perform holdem_new_hand(t.id);
    return jsonb_build_object('ok', true, 'status', 'dealt', 'tableId', t.id, 'seat', v_seat);
  end if;

  return jsonb_build_object('ok', true, 'status', 'seated', 'tableId', t.id, 'seat', v_seat);
end $$;

-- ===========================================================================
-- holdem_leave — stand up, take your stack with you
-- ===========================================================================

create or replace function public.holdem_leave(p_user uuid, p_table bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare s record; t record;
begin
  select * into s from holdem_seats
   where table_id = p_table and user_id = p_user for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_seated'); end if;

  select * into t from holdem_tables where id = p_table for update;

  -- Mid-hand, standing up is a fold. You don't get your bet back.
  if t.phase = 'betting' and not s.folded then
    perform holdem_act(p_user, p_table, 'fold', null);
    select * into s from holdem_seats where table_id = p_table and seat_idx = s.seat_idx;
  end if;

  if s.chips > 0 then
    perform credit_chips(p_user, s.chips, 'holdem_cashout',
                         'holdem:' || p_table || ':' || s.seat_idx || ':out:' ||
                         extract(epoch from clock_timestamp())::bigint);
  end if;

  update holdem_seats
     set user_id = null, chips = 0, bet = 0, total = 0,
         folded = true, all_in = false, needs_to_act = false, last_action = null
   where table_id = p_table and seat_idx = s.seat_idx;

  if (select count(*) from holdem_seats
       where table_id = p_table and user_id is not null) = 0 then
    update holdem_tables set phase = 'done' where id = p_table;
  end if;

  return jsonb_build_object('ok', true, 'cashedOut', s.chips);
end $$;

-- ===========================================================================
-- holdem_state — what one player is allowed to see.
--
-- The only read path. Hole cards are yours alone until showdown, and the
-- undealt deck never leaves the server.
-- ===========================================================================

create or replace function public.holdem_state(p_user uuid, p_table bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t record; sec record; me record;
  cfg jsonb := holdem_config();
  seats jsonb := '[]'::jsonb;
  s record; my_hole smallint[]; line jsonb;
  showdown boolean;
begin
  select * into t from holdem_tables where id = p_table;
  if not found then return jsonb_build_object('error', 'no_such_table'); end if;

  select * into me from holdem_seats where table_id = p_table and user_id = p_user;
  if not found then return jsonb_build_object('error', 'not_seated'); end if;

  select * into sec from holdem_secrets where table_id = p_table;
  showdown := (t.phase = 'showdown');

  my_hole := (select array_agg(x::smallint)
                from jsonb_array_elements_text(coalesce(sec.holes->me.seat_idx::text, '[]')) x);

  for s in select hs.*, coalesce(pr.username, pr.display_name, 'Empty') as name, pr.avatar
             from holdem_seats hs
             left join profiles pr on pr.id = hs.user_id
            where hs.table_id = p_table order by hs.seat_idx loop
    seats := seats || jsonb_build_object(
      'seat', s.seat_idx,
      'name', case when s.user_id is null then null else s.name end,
      'avatar', s.avatar,
      'you', s.user_id = p_user,
      'chips', s.chips,
      'bet', s.bet,
      'folded', s.folded,
      'allIn', s.all_in,
      'action', s.last_action,
      'toAct', s.seat_idx = t.to_act_seat,
      'dealer', s.seat_idx = t.dealer_seat,
      -- Opponents' cards appear only at showdown, and only if they didn't fold.
      'hole', case when s.user_id = p_user then to_jsonb(my_hole)
                   when showdown and not s.folded
                     then coalesce(sec.holes->s.seat_idx::text, 'null'::jsonb)
                   else null end);
  end loop;

  line := case when coalesce(array_length(t.mid,1),0) = 3
                 and coalesce(array_length(my_hole,1),0) = 2
               then best_line(my_hole, t.lane_a, t.lane_b, t.mid) else null end;

  return jsonb_build_object(
    'tableId',   t.id,
    'phase',     t.phase,
    'stage',     (cfg->'stages')->>t.stage_idx,
    'stageIdx',  t.stage_idx,
    'pot',       t.pot,
    'curBet',    t.cur_bet,
    'minRaise',  t.min_raise,
    'sb',        t.sb,
    'bb',        t.bb,
    'mid',       to_jsonb(t.mid),
    'laneA',     to_jsonb(t.lane_a),
    'laneB',     to_jsonb(t.lane_b),
    'seats',     seats,
    'yourSeat',  me.seat_idx,
    'yourTurn',  t.to_act_seat = me.seat_idx and t.phase = 'betting',
    'toCall',    greatest(0, t.cur_bet - me.bet),
    'yourChips', me.chips,
    'deadline',  t.act_deadline,
    'bestLine',  line,       -- your own read only; working out theirs is the game
    'result',    t.result,
    'handNo',    t.hand_no
  );
end $$;

-- ===========================================================================
-- holdem_next — deal the next hand once both players are ready
-- ===========================================================================

create or replace function public.holdem_next(p_user uuid, p_table bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  select * into t from holdem_tables where id = p_table for update;
  if t.phase not in ('showdown', 'waiting') then
    return jsonb_build_object('ok', false, 'error', 'hand_in_progress');
  end if;
  if not exists (select 1 from holdem_seats
                  where table_id = p_table and user_id = p_user) then
    return jsonb_build_object('ok', false, 'error', 'not_seated');
  end if;

  return holdem_new_hand(p_table);
end $$;

revoke execute on function public.holdem_join(uuid, bigint)        from public, anon, authenticated;
revoke execute on function public.holdem_leave(uuid, bigint)       from public, anon, authenticated;
revoke execute on function public.holdem_state(uuid, bigint)       from public, anon, authenticated;
revoke execute on function public.holdem_next(uuid, bigint)        from public, anon, authenticated;

select routine_name from information_schema.routines
where routine_schema = 'public' and routine_name like 'holdem_%'
order by routine_name;
