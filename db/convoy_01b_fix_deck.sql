create or replace function public.shuffled_deck()
returns smallint[]
language plpgsql volatile as $$
declare
  deck smallint[];
  b bytea;
  i int; j int; tmp smallint;
begin
  select array_agg(g::smallint order by g) into deck from generate_series(0, 51) g;

  -- Fisher-Yates. Four random bytes per swap, accumulated in bigint so the
  -- 2^32 range can't overflow int4.
  for i in reverse 52..2 loop
    b := gen_random_bytes(4);
    j := 1 + ((get_byte(b,0)::bigint << 24)
            | (get_byte(b,1)::bigint << 16)
            | (get_byte(b,2)::bigint << 8)
            |  get_byte(b,3)::bigint) % i;
    tmp := deck[i]; deck[i] := deck[j]; deck[j] := tmp;
  end loop;

  return deck;
end $$;

select array_length(shuffled_deck(), 1) as deck_size,
       (select count(distinct x) from unnest(shuffled_deck()) x) as unique_cards;
