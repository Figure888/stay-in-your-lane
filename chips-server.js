/*
 * Server-authoritative chip balance.
 * Load AFTER chips-billing.js — it overrides the localStorage versions.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://npprnzjptsqnjqvuvrvv.supabase.co';
const SUPABASE_ANON = 'sb_publishable_pbAu1TvLiBbFElFwVQJynw_zrSxe_I3';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON);
window.sb = sb;

const { data: { session } } = await sb.auth.getSession();
if (!session) location.href = './login.html';

let cached = 0;

function setCache(n) {
  cached = Number(n) || 0;
  window.dispatchEvent(new CustomEvent('chips:changed',
    { detail: { balance: cached } }));
  return cached;
}

Chips.getBalance  = () => cached;
Chips.grantChips  = () => { Chips.syncBalance(); return cached; };
Chips.spendChips  = (n) => setCache(Math.max(0, cached - n));

Chips.syncBalance = async () => {
  const { data } = await sb.from('profiles').select('chips').single();
  return data ? setCache(data.chips) : cached;
};

Chips.settleHand = async (delta) => {
  const { data } = await sb.rpc('settle_hand', { delta });
  return setCache(data);
};

Chips.tryRefill = async () => {
  const r = await fetch('/api/refill', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const { chips, next_refill } = await r.json();
  setCache(chips);
  return { chips, next_refill: new Date(next_refill) };
};

Chips.signOut = () => sb.auth.signOut().then(() => location.href = './login.html');

// tag the checkout embeds so the webhook knows whose chips to credit
document.querySelectorAll('[data-whop-checkout-plan-id]').forEach(el => {
  el.dataset.whopCheckoutMetadata =
    JSON.stringify({ user_id: session.user.id });
});

await Chips.syncBalance();
await Chips.tryRefill();
window.addEventListener('chips:purchased', () => Chips.syncBalance());


// ---- chips tab ----
const PACKS = [
  { plan: 'plan_mr2XMRmxmcRo1', label: 'Rack',  chips: 10000,  price: '$1.99'  },
  { plan: 'plan_vtLNPpoF6rn0N', label: 'Stack', chips: 60000,  price: '$9.99'  },
  { plan: 'plan_4HDYux4xqROpb', label: 'Tray',  chips: 200000, price: '$29.99' },
];

window.renderPacks = function () {
  const bal = document.getElementById('storeBalance');
  if (bal) bal.textContent = cached.toLocaleString();

  const list = document.getElementById('packList');
  if (!list || list.dataset.built) return;
  list.dataset.built = '1';

  list.innerHTML = PACKS.map(p => `
    <div class="cv-block" style="margin-top:10px">
      <div class="cv-head" style="margin-bottom:6px">
        <div>
          <div class="nm">${p.label}</div>
          <div class="stack">${p.chips.toLocaleString()} chips</div>
        </div>
        <div class="cv-bank">${p.price}</div>
      </div>
      <div data-whop-checkout-plan-id="${p.plan}"
           data-whop-checkout-theme="dark"
           data-whop-checkout-metadata='${JSON.stringify({ user_id: session.user.id })}'></div>
    </div>`).join('');
};

window.addEventListener('chips:changed', () => {
  const bal = document.getElementById('storeBalance');
  if (bal) bal.textContent = cached.toLocaleString();
});
