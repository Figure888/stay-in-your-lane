select best_line(ARRAY[48,44]::smallint[], ARRAY[40,36]::smallint[],
                 ARRAY[1,5]::smallint[], ARRAY[32,9,13]::smallint[])->>'lane' as lane,
       best_line(ARRAY[48,44]::smallint[], ARRAY[40,36]::smallint[],
                 ARRAY[1,5]::smallint[], ARRAY[32,9,13]::smallint[])->>'name' as hand;

select settle_pots('[
  {"seat":0,"total":100,"folded":false,"score":900},
  {"seat":1,"total":300,"folded":false,"score":800},
  {"seat":2,"total":300,"folded":false,"score":700}
]'::jsonb)->'payouts'->>'0' as seat0_gets,
       settle_pots('[
  {"seat":0,"total":100,"folded":false,"score":900},
  {"seat":1,"total":300,"folded":false,"score":800},
  {"seat":2,"total":300,"folded":false,"score":700}
]'::jsonb)->'payouts'->>'1' as seat1_gets;
