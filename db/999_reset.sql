-- DESTRUCTIVE. Only run this if you want to wipe the referral tables and
-- start over. It drops referral data and every chip ledger entry.
-- It does NOT touch users.
--
-- Do not run this once real players exist.

drop table if exists public.chip_ledger    cascade;
drop table if exists public.referrals      cascade;
drop table if exists public.referral_codes cascade;
drop type  if exists referral_status;
