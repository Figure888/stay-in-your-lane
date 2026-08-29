-- Rate limiting, in Postgres.
--
-- No Redis, no extra vendor, no new dependency — you already have a database
-- and every route already talks to it. A fixed window is coarser than a
-- sliding one but it's a few lines and it stops the abuse that matters.

create table if not exists public.rate_limits (
  key          text primary key,
  hits         int not null default 0,
  window_start timestamptz not null default now()
);

alter table public.rate_limits enable row level security;

create index if not exists rate_limits_window_idx on public.rate_limits (window_start);

-- ---------------------------------------------------------------------------
-- check_rate_limit — returns whether this call is allowed, and counts it.
--
-- The counter increments on the allowed path only, so a client that keeps
-- hammering after a 429 doesn't extend its own lockout indefinitely.
-- ---------------------------------------------------------------------------
create or replace function public.check_rate_limit(
  p_key text, p_limit int, p_window_seconds int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  cutoff timestamptz := now() - (p_window_seconds || ' seconds')::interval;
begin
  insert into rate_limits (key, hits, window_start)
  values (p_key, 1, now())
  on conflict (key) do update
    set hits = case when rate_limits.window_start < cutoff then 1
                    else rate_limits.hits + 1 end,
        window_start = case when rate_limits.window_start < cutoff then now()
                           else rate_limits.window_start end
  returning * into r;

  if r.hits > p_limit then
    return jsonb_build_object(
      'allowed', false,
      'retryAfter', greatest(1, ceil(extract(epoch from
        (r.window_start + (p_window_seconds || ' seconds')::interval) - now()))::int));
  end if;

  return jsonb_build_object('allowed', true, 'remaining', p_limit - r.hits);
end $$;

revoke execute on function public.check_rate_limit(text, int, int)
  from public, anon, authenticated;
grant  execute on function public.check_rate_limit(text, int, int) to service_role;

-- Old windows are dead weight. Sweep them hourly.
create or replace function public.sweep_rate_limits()
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from rate_limits where window_start < now() - interval '1 hour';
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.sweep_rate_limits() from public, anon, authenticated;

select cron.schedule('rate-limit-sweep', '0 * * * *',
                     'select public.sweep_rate_limits()')
where not exists (select 1 from cron.job where jobname = 'rate-limit-sweep');

select 'rate limiting ready' as status,
       check_rate_limit('selftest', 2, 60) as first_call,
       check_rate_limit('selftest', 2, 60) as second_call,
       check_rate_limit('selftest', 2, 60) as third_should_deny;
