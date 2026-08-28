-- Run this FIRST. It changes nothing; it just reports what's there.
-- Paste the output back before running the migration.

-- Which database and schema am I actually in?
select current_database() as db, current_schema() as schema;

-- Every table, in every schema. If an earlier check "found nothing" but a
-- table plainly exists, it's because the table lives outside public.
select table_schema, table_name
from information_schema.tables
where table_schema not in ('pg_catalog', 'information_schema')
order by table_schema, table_name;

-- The shape of users, wherever it lives.
select table_schema, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name = 'users'
order by table_schema, ordinal_position;
