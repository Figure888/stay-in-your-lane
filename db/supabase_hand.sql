-- Counts a finished hand and checks the referral in one atomic step.
-- Run this after supabase_referrals.sql.

create or replace function public.record_hand(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hands int;
begin
  update profiles
     set hands_played = hands_played + 1
   where id = p_user
   returning hands_played into v_hands;

  if v_hands is null then
    return jsonb_build_object('ok', false, 'error', 'no_such_player');
  end if;

  return jsonb_build_object(
    'ok', true,
    'handsPlayed', v_hands,
    'referral', qualify_referral(p_user)
  );
end $$;

revoke execute on function public.record_hand(uuid) from public, anon, authenticated;

select routine_name from information_schema.routines
where routine_schema = 'public' and routine_name = 'record_hand';
