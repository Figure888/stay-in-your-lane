-- Read-only. Shows what's in the database and which tables are exposed.

select current_database() as db;

select table_schema, table_name
from information_schema.tables
where table_schema not in ('pg_catalog', 'information_schema')
order by table_schema, table_name;

-- On Supabase this matters: a public table without RLS is readable and
-- writable by anyone holding the anon key, which is in your page source.
select relname as table_name,
       case when relrowsecurity then 'RLS on' else 'RLS OFF' end as rls
from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r'
order by relrowsecurity, relname;

select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name in ('profiles', 'users')
order by table_name, ordinal_position;
