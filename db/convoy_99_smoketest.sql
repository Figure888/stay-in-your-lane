-- Plays a full game between the two oldest profiles. Read the output.
do $$
declare
  pa uuid; pb uuid; g bigint; r jsonb; guard int := 0;
begin
  select id into pa from profiles order by created_at limit 1;
  select id into pb from profiles where id <> pa order by created_at limit 1;
  if pb is null then raise notice 'need two profiles to test'; return; end if;

  perform convoy_join(pa, 100);
  r := convoy_join(pb, 100);
  g := (r->>'gameId')::bigint;
  raise notice 'game % started', g;

  loop
    guard := guard + 1;
    exit when guard > 200;
    exit when (select phase from convoy_games where id = g) = 'done';

    declare actor uuid; ph text;
    begin
      select to_act, phase into actor, ph from convoy_games where id = g;

      if ph = 'checkpoint' then
        perform convoy_bet(g, actor, 'check');
      else
        perform convoy_draw(g, actor);
        -- place in the first lane that isn't full
        perform convoy_place(g, actor, (
          select lane_idx from convoy_board
           where game_id = g and user_id = actor
             and coalesce(array_length(cards,1),0) < 5
           order by lane_idx limit 1));
      end if;
    end;
  end loop;

  raise notice 'finished in % turns', guard;
end $$;

select id, phase, pot, winner, result->>'reason' as reason,
       result->>'winsA' as wins_a, result->>'winsB' as wins_b
from convoy_games order by id desc limit 1;
