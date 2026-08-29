select
  -- wheel (A2345, mixed suits) loses to 6-high straight
  score5(ARRAY[48,1,6,11,12]::smallint[]) < score5(ARRAY[4,8,12,16,1]::smallint[]) as wheel_is_low,
  hand_category(score5(ARRAY[48,1,6,11,12]::smallint[])) as wheel_cat,
  -- ace-high straight beats king-high
  score5(ARRAY[48,45,38,35,28]::smallint[]) > score5(ARRAY[45,38,35,28,25]::smallint[]) as ace_high_top,
  -- flush beats straight
  score5(ARRAY[0,8,16,24,36]::smallint[]) > score5(ARRAY[4,9,14,19,1]::smallint[]) as flush_beats_straight,
  -- aces up beats kings up
  score5(ARRAY[48,49,44,45,0]::smallint[]) > score5(ARRAY[44,45,40,41,0]::smallint[]) as higher_two_pair,
  -- same hand, different suits, ties exactly
  score5(ARRAY[48,44,40,36,33]::smallint[]) = score5(ARRAY[49,45,41,37,34]::smallint[]) as suits_dont_matter;
