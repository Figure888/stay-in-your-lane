-- Lane Hold'em — server-side engine.
--
-- Ports bestLine() and the side-pot maths out of index.html. The client
-- currently decides who wins; online, it can't.
--
-- The rule being enforced: your hand is BOTH hole cards plus EXACTLY three
-- board cards, and those three come from one lane plus the middle. You pick
-- the lane, you never mix. Two players at the same table can be reading
-- completely different boards.

-- ===========================================================================
-- 1. best_line — a player's strongest legal hand, and which lane gives it
--
--    Board is middle (3) + one lane (2) = 5 cards, choose 3. Twenty hands
--    scored per player per showdown, which is nothing.
-- ===========================================================================

create or replace function public.best_line(
  p_hole smallint[], p_lane_a smallint[], p_lane_b smallint[], p_mid smallint[]
) returns jsonb
language plpgsql immutable as $$
declare
  board smallint[];
  best bigint := -1;
  best_lane text := null;
  best_cards smallint[];
  lane_name text;
  lane_cards smallint[];
  n int;
  i int; j int; k int;
  v bigint;
  picked smallint[];
begin
  if coalesce(array_length(p_hole, 1), 0) < 2 then
    return jsonb_build_object('v', 0, 'lane', null, 'cards', '[]'::jsonb);
  end if;

  foreach lane_name in array ARRAY['A', 'B'] loop
    lane_cards := case when lane_name = 'A' then p_lane_a else p_lane_b end;
    board := coalesce(p_mid, '{}') || coalesce(lane_cards, '{}');
    n := coalesce(array_length(board, 1), 0);
    continue when n < 3;

    -- Every 3-subset of the board.
    for i in 1..n-2 loop
      for j in i+1..n-1 loop
        for k in j+1..n loop
          picked := ARRAY[board[i], board[j], board[k]];
          v := score5(ARRAY[p_hole[1], p_hole[2], picked[1], picked[2], picked[3]]);
          if v > best then
            best := v; best_lane := lane_name; best_cards := picked;
          end if;
        end loop;
      end loop;
    end loop;
  end loop;

  if best < 0 then
    return jsonb_build_object('v', 0, 'lane', null, 'cards', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'v', best,
    'lane', best_lane,
    'cards', to_jsonb(best_cards),
    'name', hand_category(best)
  );
end $$;

-- ===========================================================================
-- 2. settle_pots — side pots, ported from finish().
--
--    Contributions come in as a jsonb array:
--      [{"seat":0,"total":300,"folded":false,"score":123456}, ...]
--
--    Levels are the distinct contribution amounts in ascending order. At each
--    level everyone pays in up to that level, and only players who reached it
--    can win that slice. Remainders go to the earliest seats rather than
--    vanishing, so the chips always add up.
-- ===========================================================================

create or replace function public.settle_pots(p_players jsonb)
returns jsonb
language plpgsql immutable as $$
declare
  levels bigint[];
  lvl bigint;
  prev bigint := 0;
  amt bigint;
  pl jsonb;
  elig int[];
  best bigint;
  winners int[];
  share bigint; rem int;
  payouts jsonb := '{}'::jsonb;
  pots jsonb := '[]'::jsonb;
  seat int; idx int;
  cur bigint;
begin
  select array_agg(distinct (value->>'total')::bigint order by (value->>'total')::bigint)
    into levels
    from jsonb_array_elements(p_players) value
   where (value->>'total')::bigint > 0;

  if levels is null then
    return jsonb_build_object('payouts', payouts, 'pots', pots);
  end if;

  foreach lvl in array levels loop
    -- Everyone contributes the slice between the previous level and this one.
    amt := 0;
    for pl in select value from jsonb_array_elements(p_players) value loop
      cur := (pl->>'total')::bigint;
      amt := amt + greatest(0, least(cur, lvl) - least(cur, prev));
    end loop;

    -- Only unfolded players who put in at least this much can win it.
    select array_agg((value->>'seat')::int)
      into elig
      from jsonb_array_elements(p_players) value
     where not (value->>'folded')::boolean
       and (value->>'total')::bigint >= lvl;

    prev := lvl;
    continue when amt <= 0 or elig is null;

    best := -1; winners := '{}';
    for pl in select value from jsonb_array_elements(p_players) value loop
      seat := (pl->>'seat')::int;
      continue when not (seat = any (elig));
      cur := coalesce((pl->>'score')::bigint, -1);
      if cur > best then best := cur; winners := ARRAY[seat];
      elsif cur = best then winners := winners || seat;
      end if;
    end loop;

    continue when array_length(winners, 1) is null;

    share := amt / array_length(winners, 1);
    rem   := (amt - share * array_length(winners, 1))::int;

    for idx in 1..array_length(winners, 1) loop
      seat := winners[idx];
      payouts := jsonb_set(payouts, ARRAY[seat::text],
        to_jsonb(coalesce((payouts->>seat::text)::bigint, 0)
                 + share + case when idx <= rem then 1 else 0 end));
    end loop;

    pots := pots || jsonb_build_object('amount', amt, 'winners', to_jsonb(winners));
  end loop;

  return jsonb_build_object('payouts', payouts, 'pots', pots);
end $$;

revoke execute on function public.best_line(smallint[], smallint[], smallint[], smallint[])
  from public, anon, authenticated;
revoke execute on function public.settle_pots(jsonb) from public, anon, authenticated;

-- ===========================================================================
-- Checks
-- ===========================================================================

-- Ace-king in hand. Lane A gives a broadway straight, Lane B doesn't.
-- Cards: rank*4 + suit, so 48=Ace(s0) 44=King(s0) 40=Queen 36=Jack 32=Ten.
select best_line(
  ARRAY[48,44]::smallint[],        -- A K
  ARRAY[40,36]::smallint[],        -- lane A: Q J
  ARRAY[1,5]::smallint[],          -- lane B: junk
  ARRAY[32,9,13]::smallint[]       -- middle: T + junk
) as lane_a_should_win;

-- Two players, one all-in short. Seat 0 puts 100, seat 1 puts 300, seat 2
-- puts 300. Seat 0 has the best hand but can only win the 300 main pot;
-- the 400 side pot goes to the better of seats 1 and 2.
select settle_pots('[
  {"seat":0,"total":100,"folded":false,"score":900},
  {"seat":1,"total":300,"folded":false,"score":800},
  {"seat":2,"total":300,"folded":false,"score":700}
]'::jsonb) as side_pot_split;
