-- Convoy multiplayer — part 1: card engine
--
-- Ports the evaluation logic out of index.html and into Postgres, so the
-- server decides who wins. Nothing here trusts the client.
--
-- Card encoding: smallint 0..51, where rank = card / 4 (0=deuce .. 12=ace)
-- and suit = card % 4. Matches the {r,s} shape in your JS.

-- ===========================================================================
-- score5 — rank a five-card hand
--
-- Returns a bigint that sorts correctly: higher always beats lower, and equal
-- values are genuine ties. Encoded base-15 as
--   category, then the five tiebreak ranks in significance order.
--
-- Categories: 0 high card, 1 pair, 2 two pair, 3 trips, 4 straight,
--             5 flush, 6 full house, 7 quads, 8 straight flush.
-- ===========================================================================

create or replace function public.score5(cards smallint[])
returns bigint
language plpgsql immutable as $$
declare
  counts int[] := array_fill(0, ARRAY[13]);
  suit0 int;
  is_flush boolean := true;
  distinct_ranks int[];
  ordered int[] := '{}';       -- tiebreak ranks, most significant first
  cat int := 0;
  straight_high int := -1;
  c int; r int; n int; i int; run int;
  result bigint := 0;
begin
  if array_length(cards, 1) <> 5 then
    raise exception 'score5 needs exactly 5 cards, got %', array_length(cards, 1);
  end if;

  suit0 := cards[1] % 4;

  foreach c in array cards loop
    if c < 0 or c > 51 then
      raise exception 'card out of range: %', c;
    end if;
    r := c / 4;
    counts[r + 1] := counts[r + 1] + 1;
    if c % 4 <> suit0 then is_flush := false; end if;
  end loop;

  -- Duplicate cards would silently corrupt scoring, so reject them.
  for i in 1..13 loop
    if counts[i] > 4 then
      raise exception 'impossible card counts — duplicate cards in hand';
    end if;
  end loop;

  -- Straight: five consecutive ranks. Ace plays low for A-2-3-4-5 only.
  select array_agg(g order by g desc) into distinct_ranks
    from generate_series(0, 12) g where counts[g + 1] > 0;

  if array_length(distinct_ranks, 1) = 5 then
    run := 1;
    for i in 2..5 loop
      if distinct_ranks[i] = distinct_ranks[i - 1] - 1 then
        run := run + 1;
      else
        run := 1;
      end if;
    end loop;

    if run = 5 then
      straight_high := distinct_ranks[1];
    elsif distinct_ranks[1] = 12
      and distinct_ranks[2] = 3 and distinct_ranks[3] = 2
      and distinct_ranks[4] = 1 and distinct_ranks[5] = 0 then
      straight_high := 3;                     -- the wheel: 5 is the high card
    end if;
  end if;

  -- Tiebreak order: by count descending, then by rank descending. So a full
  -- house sorts as [trip rank, pair rank], two pair as [hi, lo, kicker].
  for n in reverse 4..1 loop
    for r in reverse 12..0 loop
      if counts[r + 1] = n then
        ordered := ordered || r;
      end if;
    end loop;
  end loop;

  -- Category
  if straight_high >= 0 and is_flush then
    cat := 8; ordered := ARRAY[straight_high];
  elsif ordered = '{}' then
    cat := 0;
  elsif counts[ordered[1] + 1] = 4 then
    cat := 7;
  elsif counts[ordered[1] + 1] = 3 and array_length(ordered, 1) = 2 then
    cat := 6;
  elsif is_flush then
    cat := 5;
  elsif straight_high >= 0 then
    cat := 4; ordered := ARRAY[straight_high];
  elsif counts[ordered[1] + 1] = 3 then
    cat := 3;
  elsif counts[ordered[1] + 1] = 2 and counts[ordered[2] + 1] = 2 then
    cat := 2;
  elsif counts[ordered[1] + 1] = 2 then
    cat := 1;
  else
    cat := 0;
  end if;

  -- Pack: category first, then up to five tiebreak ranks, base 15.
  result := cat;
  for i in 1..5 loop
    result := result * 15 + coalesce(ordered[i], 0);
  end loop;

  return result;
end $$;

-- ===========================================================================
-- hand_category — human-readable name, for the UI and for debugging
-- ===========================================================================

create or replace function public.hand_category(p_score bigint)
returns text
language sql immutable as $$
  select (ARRAY['High card','Pair','Two pair','Three of a kind','Straight',
                'Flush','Full house','Four of a kind','Straight flush']
         )[(p_score / 759375) + 1];   -- 15^5
$$;

-- ===========================================================================
-- shuffled_deck — a full 52-card deck, server-side.
--
-- Uses gen_random_bytes (pgcrypto) rather than random(), because random() is
-- seeded per session and is predictable enough to be worth attacking when
-- real money is buying the chips.
-- ===========================================================================

create extension if not exists pgcrypto;

