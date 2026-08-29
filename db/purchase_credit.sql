-- Ledger-backed purchase crediting, with a floor.
--
-- add_chips writes straight to profiles.chips: no ledger row, no idempotency,
-- and no floor — so a refund on already-spent chips drives the balance
-- negative. This replaces it for the webhook path.

create or replace function public.apply_purchase(
  p_user uuid, p_delta bigint, p_reason text, p_idem_key text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  inserted bigint;
  v_balance bigint;
  v_applied bigint;
begin
  select chips into v_balance from profiles where id = p_user;
  if v_balance is null then
    return jsonb_build_object('ok', false, 'error', 'no_profile');
  end if;

  -- A refund can only claw back what's actually there. Someone who bought
  -- 10k chips, spent 9k, then charged back can go to zero and no further.
  v_applied := case when p_delta < 0
                    then greatest(p_delta, -v_balance)
                    else p_delta end;

  insert into chip_ledger (user_id, delta, reason, idem_key)
  values (p_user, v_applied, p_reason, p_idem_key)
  on conflict (idem_key) do nothing
  returning id into inserted;

  if inserted is null then
    return jsonb_build_object('ok', true, 'status', 'already_applied');
  end if;

  update profiles set chips = chips + v_applied where id = p_user
    returning chips into v_balance;

  return jsonb_build_object('ok', true, 'status', 'applied',
                            'delta', v_applied, 'balance', v_balance);
end $$;

revoke execute on function public.apply_purchase(uuid, bigint, text, text)
  from public, anon, authenticated;
grant  execute on function public.apply_purchase(uuid, bigint, text, text)
  to service_role;

-- Somewhere to see payments that couldn't be matched to a player, instead of
-- a console.error nobody reads.
create table if not exists public.unmatched_payments (
  id         text primary key,
  event_type text,
  payload    jsonb,
  created_at timestamptz not null default now(),
  resolved   boolean not null default false
);

alter table public.unmatched_payments enable row level security;

select 'purchase crediting ready' as status;
