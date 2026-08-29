-- Player accounts: username and avatar.
--
-- display_name already exists (added in convoy_06_polish). This adds a real
-- username with uniqueness and validation, plus an avatar reference.

alter table public.profiles
  add column if not exists username text,
  add column if not exists avatar   text,
  add column if not exists updated_at timestamptz;

-- Case-insensitive uniqueness: "Rook" and "rook" are the same player to a
-- human, so they can't both exist.
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

-- ===========================================================================
-- Names that shouldn't be claimable — system voices and the bot names your
-- single-player mode already uses.
-- ===========================================================================

create or replace function public.username_is_reserved(p_name text)
returns boolean
language sql immutable as $$
  select lower(p_name) = any (ARRAY[
    'admin','administrator','moderator','mod','staff','support','system',
    'lanepoker','stayinyourlane','official','dealer','house',
    'vega','cutler','rook',            -- the single-player bots
    'you','opponent','player','null','undefined','anonymous'
  ]);
$$;

-- ===========================================================================
-- set_username
-- ===========================================================================

create or replace function public.set_username(p_user uuid, p_name text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
begin
  if length(v_name) < 3 or length(v_name) > 16 then
    return jsonb_build_object('ok', false, 'error', 'bad_length',
      'message', 'Between 3 and 16 characters.');
  end if;

  -- Letters, numbers and underscore. Anything else invites homoglyph tricks
  -- and names that break layout.
  if v_name !~ '^[A-Za-z0-9_]+$' then
    return jsonb_build_object('ok', false, 'error', 'bad_chars',
      'message', 'Letters, numbers and underscores only.');
  end if;

  if username_is_reserved(v_name) then
    return jsonb_build_object('ok', false, 'error', 'reserved',
      'message', 'That name is taken.');
  end if;

  if exists (select 1 from profiles
              where lower(username) = lower(v_name) and id <> p_user) then
    return jsonb_build_object('ok', false, 'error', 'taken',
      'message', 'That name is taken.');
  end if;

  update profiles
     set username = v_name, display_name = v_name, updated_at = now()
   where id = p_user;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_profile');
  end if;

  return jsonb_build_object('ok', true, 'username', v_name);
end $$;

-- ===========================================================================
-- set_avatar
--
-- Accepts a preset id ('preset:0'..'preset:11') or a path inside the avatars
-- bucket. Anything else is rejected — never store a client-supplied URL, or
-- someone points their avatar at a tracking pixel or worse.
-- ===========================================================================

create or replace function public.set_avatar(p_user uuid, p_avatar text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v text := btrim(coalesce(p_avatar, ''));
begin
  if v = '' then
    update profiles set avatar = null, updated_at = now() where id = p_user;
    return jsonb_build_object('ok', true, 'avatar', null);
  end if;

  if v ~ '^preset:([0-9]|1[01])$' then
    null;                                   -- one of the built-ins
  elsif v = p_user::text || '/avatar' then  -- their own folder, fixed name
    null;
  else
    return jsonb_build_object('ok', false, 'error', 'bad_avatar');
  end if;

  update profiles set avatar = v, updated_at = now() where id = p_user;
  return jsonb_build_object('ok', true, 'avatar', v);
end $$;

-- ===========================================================================
-- get_account / account_summary
-- ===========================================================================

create or replace function public.get_account(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare p record; v_games int; v_wins int;
begin
  select * into p from profiles where id = p_user;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;

  select count(*), count(*) filter (where winner = p_user)
    into v_games, v_wins
    from convoy_games
   where phase = 'done' and (player_a = p_user or player_b = p_user);

  return jsonb_build_object(
    'ok', true,
    'username',    p.username,
    'displayName', coalesce(p.display_name, split_part(p.email, '@', 1)),
    'avatar',      p.avatar,
    'chips',       p.chips,
    'handsPlayed', p.hands_played,
    'memberSince', p.created_at,
    'games',       v_games,
    'wins',        v_wins,
    'needsSetup',  p.username is null
  );
end $$;

revoke execute on function public.set_username(uuid, text)  from public, anon, authenticated;
revoke execute on function public.set_avatar(uuid, text)    from public, anon, authenticated;
revoke execute on function public.get_account(uuid)         from public, anon, authenticated;
revoke execute on function public.username_is_reserved(text) from public, anon, authenticated;

select 'account functions ready' as status;
