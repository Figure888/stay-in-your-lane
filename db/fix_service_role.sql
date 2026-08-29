grant execute on function public.add_chips(uuid, bigint) to service_role;

select p.proname,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_ok,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_call
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('add_chips','settle_hand','credit_chips','convoy_join');
