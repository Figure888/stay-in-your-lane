-- Lane Hold'em online — betting, streets, showdown, matchmaking.
--
-- Ports step(), commitAction(), advance() and finish() from index.html.
-- Every function checks it really is the caller's turn, so a client sending a
-- well-formed action out of turn is rejected rather than obeyed.

-- ===========================================================================
-- holdem_advance — close the street, deal the next one
--
--   0 On-ramp -> 1 The Merge (middle three)
--   1 -> 2 The Fork (one card to each lane)
--   2 -> 3 The Exit (the second)
--   3 -> showdown
-- ===========================================================================

create or replace function public.holdem_advance(p_table bigint)
returns text
language plpgsql security definer set search_path = public as $$
declare
  t record; cfg jsonb := holdem_config();
  d smallint[]; pos int := 1;
  can_act int;
begin
  select * into t from holdem_tables where id = p_table;

  update holdem_seats
     set bet = 0,
         last_action = case when folded then 'Fold' else null end,
         needs_to_act = false
   where table_id = p_table;

  update holdem_tables
     set cur_bet = 0, min_raise = t.bb, stage_idx = t.stage_idx + 1, updated_at = now()
   where id = p_table;

  select * into t from holdem_tables where id = p_table;

  if t.stage_idx >= 4 then
    return holdem_showdown(p_table);
  end if;

  select deck into d from holdem_secrets where table_id = p_table for update;

  if t.stage_idx = 1 then
    update holdem_tables set mid = ARRAY[d[1], d[2], d[3]] where id = p_table;
    pos := 4;
  else
    -- One card to each lane, A then B, same order as the offline deal.
    update holdem_tables
       set lane_a = lane_a || d[1], lane_b = lane_b || d[2]
     where id = p_table;
    pos := 3;
  end if;

  update holdem_secrets set deck = d[pos:array_length(d,1)] where table_id = p_table;

  -- Everyone still able to act owes an action on the new street.
  select count(*) into can_act from holdem_seats
   where table_id = p_table and not folded and not all_in;

  if can_act < 2 then
    -- Nobody left to bet: run the remaining streets out.
    return holdem_advance(p_table);
  end if;

  update holdem_seats set needs_to_act = true
   where table_id = p_table and not folded and not all_in;

  update holdem_tables
     set to_act_seat = holdem_next_to_act(p_table, t.dealer_seat),
         act_deadline = now() + ((cfg->>'act_seconds')::int || ' seconds')::interval
   where id = p_table;

  insert into holdem_actions (table_id, hand_no, action)
  values (p_table, t.hand_no, 'street_' || t.stage_idx);

  return 'street';
end $$;

-- ===========================================================================
-- holdem_showdown — evaluate, split, pay
-- ===========================================================================

create or replace function public.holdem_showdown(p_table bigint)
returns text
language plpgsql security definer set search_path = public as $$
declare
  t record; sec record; s record;
  d smallint[]; pos int := 1;
  players jsonb := '[]'::jsonb;
  line jsonb;
  settle jsonb;
  live int;
  seat_key text;
  amt bigint;
  results jsonb := '{}'::jsonb;
begin
  select * into t from holdem_tables where id = p_table for update;
  select * into sec from holdem_secrets where table_id = p_table for update;

  select count(*) into live from holdem_seats where table_id = p_table and not folded;

  -- If more than one is live the board must be complete, even if everyone
  -- went all-in on the first street.
  if live > 1 then
    d := sec.deck;
    while coalesce(array_length(t.mid,1),0) < 3 loop
      update holdem_tables set mid = mid || d[pos] where id = p_table;
      pos := pos + 1;
      select * into t from holdem_tables where id = p_table;
    end loop;
    while coalesce(array_length(t.lane_a,1),0) < 2 loop
      update holdem_tables set lane_a = lane_a || d[pos], lane_b = lane_b || d[pos+1]
       where id = p_table;
      pos := pos + 2;
      select * into t from holdem_tables where id = p_table;
    end loop;
    update holdem_secrets set deck = d[pos:array_length(d,1)] where table_id = p_table;
  end if;

  for s in select * from holdem_seats where table_id = p_table order by seat_idx loop
    line := null;
    if not s.folded and coalesce(array_length(t.mid,1),0) = 3 then
      line := best_line(
        (select array_agg(x::smallint) from jsonb_array_elements_text(sec.holes->s.seat_idx::text) x),
        t.lane_a, t.lane_b, t.mid);
      results := jsonb_set(results, ARRAY[s.seat_idx::text], line);
    end if;

    players := players || jsonb_build_object(
      'seat', s.seat_idx,
      'total', s.total,
      'folded', s.folded,
      'score', coalesce((line->>'v')::bigint, -1));
  end loop;

  settle := settle_pots(players);

  for seat_key in select jsonb_object_keys(settle->'payouts') loop
    amt := (settle->'payouts'->>seat_key)::bigint;
    update holdem_seats set chips = chips + amt
     where table_id = p_table and seat_idx = seat_key::int;
  end loop;

  update holdem_tables
     set phase = 'showdown', stage_idx = 4, pot = 0,
         to_act_seat = null, act_deadline = null,
         result = jsonb_build_object(
           'hands', results, 'pots', settle->'pots', 'payouts', settle->'payouts',
           'walkover', live = 1),
         updated_at = now()
   where id = p_table;

  insert into holdem_actions (table_id, hand_no, action) values (p_table, t.hand_no, 'showdown');
  return 'showdown';
end $$;

-- ===========================================================================
-- holdem_step — whose turn is it, or is the street over
-- ===========================================================================

create or replace function public.holdem_step(p_table bigint)
returns text
language plpgsql security definer set search_path = public as $$
declare
  t record; cfg jsonb := holdem_config();
  live int; can_act int; owing int; nxt int;
begin
  select * into t from holdem_tables where id = p_table;
  if t.phase <> 'betting' then return 'idle'; end if;

  select count(*) into live from holdem_seats where table_id = p_table and not folded;
  if live <= 1 then return holdem_showdown(p_table); end if;

  select count(*) filter (where not folded and not all_in),
         count(*) filter (where needs_to_act)
    into can_act, owing
    from holdem_seats where table_id = p_table;

  if owing = 0 or can_act = 0 then return holdem_advance(p_table); end if;

  -- If the current seat can't act, pass it on.
  if t.to_act_seat is null or not exists (
       select 1 from holdem_seats
        where table_id = p_table and seat_idx = t.to_act_seat and needs_to_act
          and not folded and not all_in) then
    nxt := holdem_next_to_act(p_table, coalesce(t.to_act_seat, -1));
    if nxt < 0 then return holdem_advance(p_table); end if;

    update holdem_tables
       set to_act_seat = nxt,
           act_deadline = now() + ((cfg->>'act_seconds')::int || ' seconds')::interval
     where id = p_table;
  end if;

  return 'acting';
end $$;

-- ===========================================================================
-- holdem_act — fold, call/check, raise
--
-- A raise re-arms everyone else who isn't folded or all-in, exactly as
-- commitAction() does offline.
-- ===========================================================================

create or replace function public.holdem_act(
  p_user uuid, p_table bigint, p_action text, p_amount bigint default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t record; s record; cfg jsonb := holdem_config();
  need bigint; target bigint; paid bigint; was_bet boolean;
begin
  select * into t from holdem_tables where id = p_table for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_such_table'); end if;
  if t.phase <> 'betting' then return jsonb_build_object('ok', false, 'error', 'not_betting'); end if;

  select * into s from holdem_seats
   where table_id = p_table and user_id = p_user for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_seated'); end if;
  if s.seat_idx <> t.to_act_seat then return jsonb_build_object('ok', false, 'error', 'not_your_turn'); end if;
  if s.folded or s.all_in then return jsonb_build_object('ok', false, 'error', 'cannot_act'); end if;

  if p_action = 'fold' then
    update holdem_seats set folded = true, last_action = 'Fold', needs_to_act = false
     where table_id = p_table and seat_idx = s.seat_idx;
    insert into holdem_actions (table_id, hand_no, seat_idx, action)
    values (p_table, t.hand_no, s.seat_idx, 'fold');

  elsif p_action in ('call', 'check') then
    need := least(t.cur_bet - s.bet, s.chips);
    paid := holdem_put(p_table, s.seat_idx, need);

    update holdem_seats
       set last_action = case when paid = 0 then 'Check'
                              when chips = 0 then 'All in'
                              else 'Call ' || paid end,
           needs_to_act = false
     where table_id = p_table and seat_idx = s.seat_idx;

    insert into holdem_actions (table_id, hand_no, seat_idx, action, amount)
    values (p_table, t.hand_no, s.seat_idx, case when paid = 0 then 'check' else 'call' end, paid);

  elsif p_action = 'raise' then
    target := least(coalesce(p_amount, 0), s.bet + s.chips);
    if target <= t.cur_bet then
      return holdem_act(p_user, p_table, 'call', null);   -- too small: treat as a call
    end if;

    paid := holdem_put(p_table, s.seat_idx, target - s.bet);
    was_bet := (t.cur_bet = 0);

    update holdem_tables
       set min_raise = greatest(t.min_raise, target - t.cur_bet),
           cur_bet = target
     where id = p_table;

    update holdem_seats
       set last_action = case when chips = 0 then 'All in ' || target
                              when was_bet then 'Bet ' || target
                              else 'Raise to ' || target end,
           needs_to_act = false
     where table_id = p_table and seat_idx = s.seat_idx;

    -- Everyone else owes a response.
    update holdem_seats set needs_to_act = true
     where table_id = p_table and seat_idx <> s.seat_idx and not folded and not all_in;

    insert into holdem_actions (table_id, hand_no, seat_idx, action, amount)
    values (p_table, t.hand_no, s.seat_idx, 'raise', target);

  else
    return jsonb_build_object('ok', false, 'error', 'unknown_action');
  end if;

  update holdem_tables set to_act_seat = holdem_next_to_act(p_table, s.seat_idx)
   where id = p_table;

  return jsonb_build_object('ok', true, 'status', holdem_step(p_table));
end $$;

-- ===========================================================================
-- holdem_sweep — auto-fold anyone past their clock
-- ===========================================================================

create or replace function public.holdem_sweep()
returns int
language plpgsql security definer set search_path = public as $$
declare t record; u uuid; n int := 0;
begin
  for t in select * from holdem_tables
            where phase = 'betting' and act_deadline is not null and act_deadline < now()
            for update skip locked loop
    select user_id into u from holdem_seats
     where table_id = t.id and seat_idx = t.to_act_seat;

    if u is not null then
      perform holdem_act(u, t.id, 'fold', null);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

revoke execute on function public.holdem_advance(bigint)                     from public, anon, authenticated;
revoke execute on function public.holdem_showdown(bigint)                    from public, anon, authenticated;
revoke execute on function public.holdem_step(bigint)                        from public, anon, authenticated;
revoke execute on function public.holdem_act(uuid, bigint, text, bigint)     from public, anon, authenticated;
revoke execute on function public.holdem_sweep()                             from public, anon, authenticated;

select cron.schedule('holdem-sweep', '30 seconds', 'select public.holdem_sweep()')
where not exists (select 1 from cron.job where jobname = 'holdem-sweep');

select 'holdem betting engine ready' as status;
