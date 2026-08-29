-- Convoy private tables — invite a specific person with a link.
--
-- Solves the empty-lobby problem: heads-up matchmaking needs someone already
-- waiting, and at launch nobody is. A private table lets a player open one and
-- send the link to a friend.
--
-- Run after convoy_04_actions.sql.

create table if not exists public.convoy_invites (
  code       text primary key,
  host_id    uuid not null references public.profiles(id) on delete cascade,
  stake      bigint not null,
  game_id    bigint references public.convoy_games(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);

create index if not exists convoy_invites_host_idx on public.convoy_invites (host_id);

alter table public.convoy_invites enable row level security;

-- ===========================================================================
-- convoy_create_invite — open a private table and get a shareable code
-- ===========================================================================

create or replace function public.convoy_create_invite(p_user uuid, p_stake bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_chips bigint;
  v_code text;
  alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';  -- no 0/O/1/I
  i int;
  v_existing record;
begin
  select chips into v_chips from profiles where id = p_user;
  if v_chips is null then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;
  if v_chips < p_stake then return jsonb_build_object('ok', false, 'error', 'insufficient_chips'); end if;

  -- Already at a table? Don't let them open a second one.
  if exists (select 1 from convoy_games
              where phase <> 'done' and (player_a = p_user or player_b = p_user)) then
    return jsonb_build_object('ok', false, 'error', 'already_in_game');
  end if;

  -- Reuse an unclaimed invite rather than littering codes every time they
  -- tap the button.
  select * into v_existing from convoy_invites
   where host_id = p_user and game_id is null and expires_at > now()
   limit 1;

  if found then
    update convoy_invites set stake = p_stake, expires_at = now() + interval '24 hours'
     where code = v_existing.code;
    return jsonb_build_object('ok', true, 'code', v_existing.code, 'stake', p_stake);
  end if;

  for attempt in 1..5 loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;

    begin
      insert into convoy_invites (code, host_id, stake) values (v_code, p_user, p_stake);
      return jsonb_build_object('ok', true, 'code', v_code, 'stake', p_stake);
    exception when unique_violation then
      null;   -- collision, try again
    end;
  end loop;

  return jsonb_build_object('ok', false, 'error', 'code_generation_failed');
end $$;

-- ===========================================================================
-- convoy_redeem_invite — the guest joins, and the game deals immediately
--
-- Same deal logic as convoy_join, but skips matchmaking: the two players are
-- already decided.
-- ===========================================================================

create or replace function public.convoy_redeem_invite(p_user uuid, p_code text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  cfg jsonb := convoy_config();
  inv record;
  v_game bigint;
  v_chips bigint;
  deck smallint[];
  pos int;
  i int; L int;
  host uuid;
begin
  select * into inv from convoy_invites
   where code = upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'))
   for update;

  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_code'); end if;
  if inv.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'invite_expired'); end if;

  -- Already claimed? Send whoever asks back to that game if they belong in it.
  if inv.game_id is not null then
    if exists (select 1 from convoy_games
                where id = inv.game_id and (player_a = p_user or player_b = p_user)) then
      return jsonb_build_object('ok', true, 'status', 'rejoined', 'gameId', inv.game_id);
    end if;
    return jsonb_build_object('ok', false, 'error', 'invite_already_used');
  end if;

  host := inv.host_id;
  if host = p_user then return jsonb_build_object('ok', false, 'error', 'cannot_join_own_table'); end if;

  if exists (select 1 from convoy_games
              where phase <> 'done' and (player_a = p_user or player_b = p_user)) then
    return jsonb_build_object('ok', false, 'error', 'already_in_game');
  end if;

  select chips into v_chips from profiles where id = p_user;
  if v_chips is null or v_chips < inv.stake then
    return jsonb_build_object('ok', false, 'error', 'insufficient_chips');
  end if;

  -- The host may have spent their chips while waiting.
  select chips into v_chips from profiles where id = host;
  if v_chips < inv.stake then
    return jsonb_build_object('ok', false, 'error', 'host_short_on_chips');
  end if;

  -- Neither player is in the open queue any more.
  delete from convoy_queue where user_id in (p_user, host);

  deck := shuffled_deck();

  insert into convoy_games (player_a, player_b, stake, pot, to_act, act_deadline,
                            paid_a, paid_b)
  values (host, p_user, inv.stake, inv.stake * 2, host,
          now() + ((cfg->>'turn_seconds')::int || ' seconds')::interval,
          inv.stake, inv.stake)
  returning id into v_game;

  perform credit_chips(host,   -inv.stake, 'convoy_stake', 'convoy:' || v_game || ':stake:a');
  perform credit_chips(p_user, -inv.stake, 'convoy_stake', 'convoy:' || v_game || ':stake:b');

  -- Five held cards each, then one card seeding each of the four lanes.
  insert into convoy_secrets (game_id, pile, hole_a, hole_b)
  values (v_game, deck[19:52], deck[1:5], deck[6:10]);

  pos := 11;
  for i in 0..1 loop
    for L in 0..3 loop
      insert into convoy_board (game_id, user_id, lane_idx, cards)
      values (v_game, case when i = 0 then host else p_user end, L, ARRAY[deck[pos]]);
      pos := pos + 1;
    end loop;
  end loop;

  update convoy_invites set game_id = v_game where code = inv.code;

  insert into convoy_actions (game_id, action, payload)
  values (v_game, 'deal', jsonb_build_object('stake', inv.stake, 'private', true));

  return jsonb_build_object('ok', true, 'status', 'matched', 'gameId', v_game);
end $$;

-- ===========================================================================
-- convoy_invite_status — has anyone taken the seat yet?
-- ===========================================================================

create or replace function public.convoy_invite_status(p_user uuid, p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare inv record;
begin
  select * into inv from convoy_invites where code = p_code and host_id = p_user;
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_code'); end if;

  return jsonb_build_object('ok', true, 'code', inv.code, 'stake', inv.stake,
                            'gameId', inv.game_id,
                            'expired', inv.expires_at < now());
end $$;

revoke execute on function public.convoy_create_invite(uuid, bigint) from public, anon, authenticated;
revoke execute on function public.convoy_redeem_invite(uuid, text)  from public, anon, authenticated;
revoke execute on function public.convoy_invite_status(uuid, text)  from public, anon, authenticated;

select routine_name from information_schema.routines
where routine_schema = 'public' and routine_name like 'convoy_%invite%'
order by routine_name;
