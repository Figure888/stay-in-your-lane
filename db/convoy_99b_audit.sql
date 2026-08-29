-- Every chip movement for game 1. Sum must be zero: two stakes out, one pot in.
select reason, sum(delta) as total, count(*) as entries
from chip_ledger where idem_key like 'convoy:1:%'
group by reason order by reason;

select sum(delta) as net_change_should_be_zero
from chip_ledger where idem_key like 'convoy:1:%';

-- Did the checkpoint actually fire?
select action, count(*) from convoy_actions where game_id = 1
group by action order by count(*) desc;
