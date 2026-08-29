-- Surface XP and tier in the account payload, so the progress bar has data
-- and the sidebar can show a rank without a second round trip.

create or replace function public.get_account(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p record; v_games int; v_wins int; t jsonb; nxt bigint;
begin
  select * into p from profiles where id = p_user;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;

  select count(*), count(*) filter (where winner = p_user)
    into v_games, v_wins
    from convoy_games
   where phase = 'done' and (player_a = p_user or player_b = p_user);

  t := tier_for(coalesce(p.xp, 0));
  nxt := nullif(t->>'next', '')::bigint;

  return jsonb_build_object(
    'ok', true,
    'username',    p.username,
    'displayName', coalesce(p.display_name, split_part(p.email, '@', 1)),
    'avatar',      p.avatar,
    'chips',       p.chips,
    'handsPlayed', p.hands_played,
    'memberSince', p.created_at,
    'games',       v_games,
    'wins',        coalesce(p.wins, v_wins),
    'losses',      coalesce(p.losses, 0),
    'chipsWon',    coalesce(p.chips_won, 0),
    'xp',          coalesce(p.xp, 0),
    'tier',        t,
    'nextAt',      nxt,
    'progress',    case when nxt is null then 1.0
                        else least(1.0, round(coalesce(p.xp,0)::numeric / nxt, 3)) end,
    'country',     p.country,
    'region',      p.region,
    'needsSetup',  p.username is null
  );
end $$;

revoke execute on function public.get_account(uuid) from public, anon, authenticated;

select (get_account(id)->>'tier') as sample_tier
from profiles limit 1;
