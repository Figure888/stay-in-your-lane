-- add_chips: SECURITY DEFINER, arbitrary user id, arbitrary amount, callable
-- by anon, zero call sites. Anyone reading your page source could have set
-- their own balance to anything.
revoke execute on function public.add_chips(uuid, bigint) from public, anon, authenticated;

-- settle_hand is scoped to auth.uid(), but a positive delta mints chips.
-- Spending is safe to trust a client with; winning is not.
create or replace function public.settle_hand(delta bigint)
returns bigint
language plpgsql security definer set search_path = public as $$
declare new_balance bigint;
begin
  if delta > 0 then
    raise exception 'settle_hand cannot add chips';
  end if;

  update public.profiles
     set chips = greatest(0, chips + delta)
   where id = auth.uid()
   returning chips into new_balance;

  return new_balance;
end $$;

-- Trigger function and internal helper — never called from a client.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.shuffled_deck() from public, anon, authenticated;

select 'faucets closed' as status;
