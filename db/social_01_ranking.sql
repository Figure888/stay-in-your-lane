-- Ranking, tiers and XP.
--
-- Three boards — local (your city), national (your country), global — off one
-- stats table. Region comes from what the player sets, not from IP: guessing
-- someone's location and then ranking them by it is a support ticket waiting
-- to happen.

alter table public.profiles
  add column if not exists country text,
  add column if not exists region  text,
  add column if not exists xp      bigint  not null default 0,
  add column if not exists wins    int     not null default 0,
  add column if not exists losses  int     not null default 0,
  add column if not exists chips_won bigint not null default 0;

create index if not exists profiles_xp_idx      on public.profiles (xp desc);
create index if not exists profiles_country_idx on public.profiles (country, xp desc);
create index if not exists profiles_region_idx  on public.profiles (region, xp desc);

-- ===========================================================================
-- Tiers. Named for the game, not for generic bronze/silver/gold.
-- ===========================================================================

create or replace function public.tier_for(p_xp bigint)
returns jsonb
language sql immutable as $$
  select case
    when p_xp >= 250000 then jsonb_build_object('name','Redline',   'idx',7,'next',null)
    when p_xp >=  90000 then jsonb_build_object('name','Overdrive', 'idx',6,'next',250000)
    when p_xp >=  35000 then jsonb_build_object('name','Interstate','idx',5,'next',90000)
    when p_xp >=  12000 then jsonb_build_object('name','Highway',   'idx',4,'next',35000)
    when p_xp >=   4000 then jsonb_build_object('name','Cruiser',   'idx',3,'next',12000)
    when p_xp >=   1200 then jsonb_build_object('name','Merging',   'idx',2,'next',4000)
    when p_xp >=    300 then jsonb_build_object('name','On-ramp',   'idx',1,'next',1200)
    else                     jsonb_build_object('name','Learner',   'idx',0,'next',300)
  end;
$$;

-- ===========================================================================
-- award_xp — called when a game finishes.
--
-- XP rewards playing, not just winning: a close loss is worth more than a
-- walkover, so grinding easy opponents isn't the fast route up.
-- ===========================================================================

create or replace function public.award_game_xp(
  p_user uuid, p_won boolean, p_net bigint, p_matchups int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_xp bigint;
  v_before bigint;
  v_after bigint;
begin
  -- 20 base for finishing, 60 for winning, plus something for how close it
  -- was and a small slice of the pot.
  v_xp := 20
        + case when p_won then 60 else 0 end
        + coalesce(p_matchups, 0) * 8
        + least(200, greatest(0, coalesce(p_net, 0) / 25));

  select xp into v_before from profiles where id = p_user;

  update profiles
     set xp = xp + v_xp,
         wins   = wins   + case when p_won then 1 else 0 end,
         losses = losses + case when p_won then 0 else 1 end,
         chips_won = chips_won + greatest(0, coalesce(p_net, 0))
   where id = p_user
   returning xp into v_after;

  return jsonb_build_object(
    'xp', v_xp,
    'total', v_after,
    'tierBefore', tier_for(v_before),
    'tierAfter',  tier_for(v_after),
    'promoted',   (tier_for(v_after)->>'idx')::int > (tier_for(v_before)->>'idx')::int
  );
end $$;

-- ===========================================================================
-- leaderboard — scope is 'global', 'national' or 'local'
-- ===========================================================================

create or replace function public.leaderboard(
  p_user uuid, p_scope text default 'global', p_limit int default 25
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me record;
  rows jsonb;
  my_rank int;
begin
  select country, region, xp into me from profiles where id = p_user;

  with ranked as (
    select p.id, p.username, p.display_name, p.avatar, p.xp, p.wins, p.losses,
           row_number() over (order by p.xp desc, p.wins desc, p.id) as rank
      from profiles p
     where p.username is not null
       and (p_scope = 'global'
            or (p_scope = 'national' and p.country is not null and p.country = me.country)
            or (p_scope = 'local'    and p.region  is not null and p.region  = me.region))
  )
  select jsonb_agg(jsonb_build_object(
           'rank', rank,
           'name', coalesce(username, display_name),
           'avatar', avatar,
           'xp', xp,
           'wins', wins,
           'losses', losses,
           'tier', tier_for(xp),
           'you', id = p_user
         ) order by rank)
    into rows
    from ranked where rank <= p_limit;

  select rank into my_rank from (
    select p.id, row_number() over (order by p.xp desc, p.wins desc, p.id) as rank
      from profiles p
     where p.username is not null
       and (p_scope = 'global'
            or (p_scope = 'national' and p.country = me.country)
            or (p_scope = 'local'    and p.region  = me.region))
  ) r where id = p_user;

  return jsonb_build_object(
    'scope', p_scope,
    'entries', coalesce(rows, '[]'::jsonb),
    'yourRank', my_rank,
    'yourTier', tier_for(coalesce(me.xp, 0)),
    'hasRegion', me.region is not null,
    'hasCountry', me.country is not null
  );
end $$;

-- ===========================================================================
-- set_location — the player tells us, we don't guess from IP
-- ===========================================================================

create or replace function public.set_location(p_user uuid, p_country text, p_region text)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_country is not null and p_country !~ '^[A-Z]{2}$' then
    return jsonb_build_object('ok', false, 'error', 'bad_country');
  end if;
  if p_region is not null and length(p_region) > 60 then
    return jsonb_build_object('ok', false, 'error', 'bad_region');
  end if;

  update profiles set country = p_country, region = btrim(p_region), updated_at = now()
   where id = p_user;

  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.tier_for(bigint)                          from public, anon, authenticated;
revoke execute on function public.award_game_xp(uuid, boolean, bigint, int) from public, anon, authenticated;
revoke execute on function public.leaderboard(uuid, text, int)              from public, anon, authenticated;
revoke execute on function public.set_location(uuid, text, text)            from public, anon, authenticated;

select tier_for(0)->>'name'      as start_tier,
       tier_for(5000)->>'name'   as mid_tier,
       tier_for(300000)->>'name' as top_tier;
