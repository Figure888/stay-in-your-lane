-- Where does pgcrypto actually live?
select n.nspname as schema
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'pgcrypto';

-- Pin a search_path that includes it, so security-definer callers can reach it.
alter function public.shuffled_deck() set search_path = public, extensions;

select array_length(shuffled_deck(), 1) as deck_size;
