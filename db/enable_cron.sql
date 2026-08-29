create extension if not exists pg_cron;
select cron.schedule('convoy-sweep', '30 seconds', 'select public.convoy_sweep()');
select jobname, schedule, active from cron.job;
