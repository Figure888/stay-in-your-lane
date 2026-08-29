-- Table chat.
--
-- Scoped to a game: two people at a table, nobody else. A global lobby chat
-- is a moderation job you don't have staff for; table chat between two adults
-- who chose to sit down together is a much smaller surface.
--
-- Gifts live here too — drinks, cigarettes, hearts, gifs. Purely decorative:
-- they cost chips and return nothing, so no player-to-player value transfer
-- and no path from chips back to anything real.

do $$ begin
  create type chat_kind as enum ('text', 'gift', 'system');
exception when duplicate_object then null;
end $$;

create table if not exists public.chat_messages (
  id         bigserial primary key,
  game_id    bigint not null references public.convoy_games(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete set null,
  kind       chat_kind not null default 'text',
  body       text,
  gift       text,
  created_at timestamptz not null default now(),
  hidden     boolean not null default false
);

create index if not exists chat_game_idx on public.chat_messages (game_id, id desc);

alter table public.chat_messages enable row level security;

-- Reports. One table, so a player always has somewhere to send a complaint
-- even before there's anyone to read them.
create table if not exists public.reports (
  id          bigserial primary key,
  reporter_id uuid references public.profiles(id) on delete set null,
  target_id   uuid references public.profiles(id) on delete set null,
  game_id     bigint,
  reason      text,
  created_at  timestamptz not null default now(),
  resolved    boolean not null default false
);

alter table public.reports enable row level security;

-- Mutes, so a player can shut someone up without waiting for a moderator.
create table if not exists public.mutes (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  muted_id uuid not null references public.profiles(id) on delete cascade,
  primary key (user_id, muted_id)
);

alter table public.mutes enable row level security;

-- ===========================================================================
-- Gift catalogue. Cosmetic only — nothing here can be sold, traded or
-- converted back into chips.
-- ===========================================================================

create or replace function public.gift_catalogue()
returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('id','heart',    'label','Heart',     'cost',   50, 'emoji','\u2764\uFE0F'),
    jsonb_build_object('id','drink',    'label','Drink',     'cost',  100, 'emoji','\U0001F943'),
    jsonb_build_object('id','cigar',    'label','Cigar',     'cost',  150, 'emoji','\U0001F6AC'),
    jsonb_build_object('id','coffee',   'label','Coffee',    'cost',   50, 'emoji','\u2615'),
    jsonb_build_object('id','clap',     'label','Nice hand', 'cost',   25, 'emoji','\U0001F44F'),
    jsonb_build_object('id','fire',     'label','On fire',   'cost',  100, 'emoji','\U0001F525'),
    jsonb_build_object('id','ice',      'label','Ice cold',  'cost',  100, 'emoji','\U0001F9CA'),
    jsonb_build_object('id','crown',    'label','Crown',     'cost',  500, 'emoji','\U0001F451')
  );
$$;

-- ===========================================================================
-- send_chat
-- ===========================================================================

create or replace function public.send_chat(
  p_user uuid, p_game bigint, p_body text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_body text := btrim(coalesce(p_body, ''));
begin
  if not exists (select 1 from convoy_games
                  where id = p_game and (player_a = p_user or player_b = p_user)) then
    return jsonb_build_object('ok', false, 'error', 'not_your_game');
  end if;

  if length(v_body) = 0 then return jsonb_build_object('ok', false, 'error', 'empty'); end if;
  if length(v_body) > 200 then v_body := left(v_body, 200); end if;

  insert into chat_messages (game_id, user_id, kind, body)
  values (p_game, p_user, 'text', v_body);

  return jsonb_build_object('ok', true);
end $$;

-- ===========================================================================
-- send_gift — costs chips, delivers nothing but a picture.
--
-- The chips are spent, not transferred. A gift that moved chips between
-- players would be a value-transfer path, and that's the line between a
-- social casino and an unlicensed one.
-- ===========================================================================

create or replace function public.send_gift(
  p_user uuid, p_game bigint, p_gift text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  item jsonb;
  v_chips bigint;
begin
  if not exists (select 1 from convoy_games
                  where id = p_game and (player_a = p_user or player_b = p_user)) then
    return jsonb_build_object('ok', false, 'error', 'not_your_game');
  end if;

  select value into item from jsonb_array_elements(gift_catalogue()) value
   where value->>'id' = p_gift;

  if item is null then return jsonb_build_object('ok', false, 'error', 'unknown_gift'); end if;

  select chips into v_chips from profiles where id = p_user;
  if v_chips < (item->>'cost')::bigint then
    return jsonb_build_object('ok', false, 'error', 'insufficient_chips');
  end if;

  perform credit_chips(p_user, -(item->>'cost')::bigint, 'gift_' || p_gift,
                       'gift:' || p_game || ':' || p_user || ':' || extract(epoch from clock_timestamp()));

  insert into chat_messages (game_id, user_id, kind, gift)
  values (p_game, p_user, 'gift', p_gift);

  return jsonb_build_object('ok', true, 'gift', item);
end $$;

-- ===========================================================================
-- chat_since — poll for new messages, respecting mutes
-- ===========================================================================

create or replace function public.chat_since(
  p_user uuid, p_game bigint, p_after bigint default 0
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare rows jsonb;
begin
  if not exists (select 1 from convoy_games
                  where id = p_game and (player_a = p_user or player_b = p_user)) then
    return jsonb_build_object('ok', false, 'error', 'not_your_game');
  end if;

  select jsonb_agg(jsonb_build_object(
           'id', m.id,
           'mine', m.user_id = p_user,
           'name', coalesce(pr.username, pr.display_name, 'Player'),
           'kind', m.kind,
           'body', m.body,
           'gift', m.gift,
           'at', m.created_at
         ) order by m.id)
    into rows
    from chat_messages m
    left join profiles pr on pr.id = m.user_id
   where m.game_id = p_game
     and m.id > coalesce(p_after, 0)
     and not m.hidden
     and not exists (select 1 from mutes
                      where user_id = p_user and muted_id = m.user_id);

  return jsonb_build_object('ok', true, 'messages', coalesce(rows, '[]'::jsonb));
end $$;

create or replace function public.mute_player(p_user uuid, p_target uuid, p_on boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_user = p_target then return jsonb_build_object('ok', false, 'error', 'cannot_mute_self'); end if;

  if p_on then
    insert into mutes (user_id, muted_id) values (p_user, p_target) on conflict do nothing;
  else
    delete from mutes where user_id = p_user and muted_id = p_target;
  end if;

  return jsonb_build_object('ok', true, 'muted', p_on);
end $$;

create or replace function public.report_player(
  p_user uuid, p_target uuid, p_game bigint, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  insert into reports (reporter_id, target_id, game_id, reason)
  values (p_user, p_target, p_game, left(coalesce(p_reason, ''), 500));
  -- Reporting mutes them too: nobody wants to keep reading it while they wait.
  perform mute_player(p_user, p_target, true);
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.send_chat(uuid, bigint, text)          from public, anon, authenticated;
revoke execute on function public.send_gift(uuid, bigint, text)          from public, anon, authenticated;
revoke execute on function public.chat_since(uuid, bigint, bigint)       from public, anon, authenticated;
revoke execute on function public.mute_player(uuid, uuid, boolean)       from public, anon, authenticated;
revoke execute on function public.report_player(uuid, uuid, bigint, text) from public, anon, authenticated;
revoke execute on function public.gift_catalogue()                       from public, anon, authenticated;

select jsonb_array_length(gift_catalogue()) as gifts_available;
