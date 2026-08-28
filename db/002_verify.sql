-- Run this AFTER 001_referrals.sql. Expect three rows, all showing 'yes'.

select 'referral_codes' as table_name,
       case when to_regclass('public.referral_codes') is null then 'MISSING' else 'yes' end as created
union all
select 'referrals',
       case when to_regclass('public.referrals') is null then 'MISSING' else 'yes' end
union all
select 'chip_ledger',
       case when to_regclass('public.chip_ledger') is null then 'MISSING' else 'yes' end;

-- Confirm users has the four columns the referral code reads.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'users'
  and column_name in ('id', 'chips', 'hands_played', 'created_at')
order by column_name;
