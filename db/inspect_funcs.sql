select p.proname,
       pg_get_function_arguments(p.oid) as args,
       p.prosecdef as security_definer,
       left(p.prosrc, 400) as body_start
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('add_chips','settle_hand','claim_refill','handle_new_user')
order by p.proname;
