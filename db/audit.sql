-- Security and integrity audit. Read-only — changes nothing.
-- Every result below has a "what you want to see" note.

-- 1. RLS on every public table.
--    Supabase exposes public tables through PostgREST, so a table with RLS
--    off is readable AND writable by anyone holding the anon key — which is
--    in your page source. Want: no rows marked EXPOSED.
select relname as table_name,
       case when relrowsecurity then 'ok' else '*** EXPOSED ***' end as rls
from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r'
order by relrowsecurity, relname;

-- 2. Tables with RLS on but zero policies are locked to service_role only.
--    That's correct for game tables, wrong for anything the client reads
--    directly. Want: profiles has policies; convoy_* and referral tables don't.
select c.relname as table_name, count(p.polname) as policies
from pg_class c
left join pg_policy p on p.polrelid = c.oid
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
group by c.relname order by count(p.polname) desc, c.relname;

-- 3. Functions callable by anon or authenticated.
--    Anything here can be invoked straight from a browser with the anon key.
--    Want: empty, or only functions you deliberately exposed.
select p.proname as function_name,
       array_to_string(array(
         select a.rolname from pg_roles a
         where has_function_privilege(a.rolname, p.oid, 'EXECUTE')
           and a.rolname in ('anon','authenticated')
       ), ', ') as callable_by
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and exists (select 1 from pg_roles a
              where has_function_privilege(a.rolname, p.oid, 'EXECUTE')
                and a.rolname in ('anon','authenticated'))
order by p.proname;

-- 4. Chip conservation. Every chip in existence should trace to a ledger
--    entry. A mismatch means chips were created or destroyed outside the
--    ledger — the one bug that can't ship. Want: difference of 0 for
--    anyone whose balance is fully ledger-derived.
select
  (select coalesce(sum(chips), 0) from profiles)      as balances_total,
  (select coalesce(sum(delta), 0) from chip_ledger)   as ledger_total,
  (select coalesce(sum(chips), 0) from profiles)
  - (select coalesce(sum(delta), 0) from chip_ledger) as unledgered;

-- 5. Games stuck with no clock. These hang forever without pg_cron running
--    convoy_sweep. Want: 0.
select count(*) as games_without_deadline
from convoy_games
where phase in ('building','checkpoint') and act_deadline is null;

-- 6. Is the sweep actually scheduled? Want: one row.

-- 7. Orphaned queue entries — players queued while already in a game.
--    Want: 0.
select count(*) as ghost_queue_entries
from convoy_queue q
where exists (select 1 from convoy_games g
              where g.phase <> 'done'
                and (g.player_a = q.user_id or g.player_b = q.user_id));

-- 8. Referral integrity: any qualified referral that never paid out,
--    or paid twice. Want: 0 rows.
select r.id, r.status,
       (select count(*) from chip_ledger
         where idem_key like 'ref:' || r.id || ':%') as payouts
from referrals r
where r.status = 'qualified'
group by r.id, r.status
having (select count(*) from chip_ledger
         where idem_key like 'ref:' || r.id || ':%') <> 2;

-- 9. Negative balances. Want: 0.
select count(*) as negative_balances from profiles where chips < 0;
