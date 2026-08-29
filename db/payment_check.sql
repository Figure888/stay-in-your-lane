-- Payment reconciliation. Read-only.
--
-- Compare these numbers against the Whop dashboard's delivery log
-- (webhook menu -> deliveries; Whop keeps 30 days). If Whop shows successful
-- payments that don't appear here, those customers paid and got nothing.

-- 1. Every purchase the ledger knows about.
select reason, count(*) as events, sum(delta) as chips_moved,
       min(created_at) as first, max(created_at) as latest
from chip_ledger
where idem_key like 'whop:%'
group by reason order by reason;

-- 2. Payments that arrived but couldn't be matched to a player.
--    These are real money with no chips delivered. Resolve them by hand.
select id, event_type, created_at, resolved,
       payload->>'user_email' as email,
       payload->>'plan_id' as plan
from unmatched_payments
where not resolved
order by created_at desc
limit 20;

-- 3. The old duplicate-guard table. If it has rows the ledger doesn't,
--    those events were seen by the previous webhook but may never have
--    credited anyone.
select
  (select count(*) from processed_events)                              as guard_rows,
  (select count(*) from chip_ledger where idem_key like 'whop:%')      as ledger_rows;

-- 4. Anyone whose balance can't be explained by the ledger. The 25,000
--    baseline predates the ledger; anything growing beyond it is drift.
select
  (select coalesce(sum(chips), 0) from profiles)    as balances,
  (select coalesce(sum(delta), 0) from chip_ledger) as ledger,
  (select coalesce(sum(chips), 0) from profiles)
  - (select coalesce(sum(delta), 0) from chip_ledger) as unexplained;
