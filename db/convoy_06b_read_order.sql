-- Reorder partial_read: a made pair is more useful information than a
-- three-card straight draw. Longer draws still outrank a bare pair.
create or replace function public.partial_read(cards smallint[])
returns text
language plpgsql immutable as $$
declare
  n int := coalesce(array_length(cards, 1), 0);
  counts int[] := array_fill(0, ARRAY[13]);
  suits  int[] := array_fill(0, ARRAY[4]);
  c int; i int;
  best_rank int := -1; best_count int := 0;
  suited int := 0;
  rks int[]; run int := 1; longest int := 1;
  rank_names text[] := ARRAY['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
begin
  if n = 0 then return ''; end if;

  foreach c in array cards loop
    counts[(c / 4) + 1] := counts[(c / 4) + 1] + 1;
    suits[(c % 4) + 1]  := suits[(c % 4) + 1] + 1;
  end loop;

  for i in 1..13 loop
    if counts[i] >= 2 and (counts[i] > best_count or
       (counts[i] = best_count and i - 1 > best_rank)) then
      best_count := counts[i]; best_rank := i - 1;
    end if;
  end loop;

  for i in 1..4 loop
    if suits[i] > suited then suited := suits[i]; end if;
  end loop;

  select array_agg(g order by g) into rks
    from generate_series(0, 12) g where counts[g + 1] > 0;

  if array_length(rks, 1) > 1 then
    for i in 2..array_length(rks, 1) loop
      if rks[i] = rks[i - 1] + 1 then
        run := run + 1;
        if run > longest then longest := run; end if;
      else run := 1; end if;
    end loop;
  end if;

  if best_count >= 3 then
    return best_count || ' of a kind, ' || rank_names[best_rank + 1] || 's';
  elsif suited >= 4 then
    return suited || ' to a flush';
  elsif longest >= 4 then
    return longest || ' to a straight';
  elsif best_count = 2 then
    return 'pair of ' || rank_names[best_rank + 1] || 's';
  elsif suited >= 3 then
    return suited || ' to a flush';
  elsif longest >= 3 then
    return longest || ' to a straight';
  end if;

  return n || ' card' || case when n = 1 then '' else 's' end;
end $$;

revoke execute on function public.partial_read(smallint[]) from public, anon, authenticated;

select partial_read(ARRAY[0,1,4,9]::smallint[])      as should_be_pair,
       partial_read(ARRAY[0,4,8]::smallint[])        as three_suited,
       partial_read(ARRAY[0,4,8,12]::smallint[])     as four_suited,
       partial_read(ARRAY[0,5,10,15]::smallint[])    as four_straight,
       partial_read(ARRAY[0,1,2]::smallint[])        as trips;
