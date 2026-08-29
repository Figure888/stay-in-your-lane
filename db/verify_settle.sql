do $$ begin
  perform settle_hand(1000000);
  raise notice 'PROBLEM: positive delta accepted';
exception when others then
  raise notice 'guard works: %', SQLERRM;
end $$;
