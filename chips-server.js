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

// ---- web store (only when Play Billing isn't available) ----
if (!('getDigitalGoodsService' in window)) {
  const PACKS = [
    { plan: 'plan_mr2XMRmxmcRo1', label: 'Rack',  chips: 10000,  price: '$1.99'  },
    { plan: 'plan_vtLNPpoF6rn0N', label: 'Stack', chips: 60000,  price: '$9.99'  },
    { plan: 'plan_4HDYux4xqROpb', label: 'Tray',  chips: 200000, price: '$29.99' },
  ];

  const wrap = document.createElement('div');
  wrap.id = 'web-store';
  wrap.style.cssText =
    'position:fixed;inset:0;z-index:2147482000;background:#0b3d2ef2;' +
    'display:none;overflow:auto;padding:24px;color:#f4efe4;font-family:system-ui';

  wrap.innerHTML =
    '<button id="ws-close" style="float:right;font-size:24px;background:none;' +
    'border:0;color:#d4af37">&times;</button><h2>Buy chips</h2>' +
    PACKS.map(p =>
      `<div style="margin:18px 0;padding:14px;border:1px solid #d4af3755;border-radius:12px">
         <h3 style="margin:0 0 4px">${p.label} — ${p.chips.toLocaleString()} chips</h3>
         <p style="margin:0 0 10px;opacity:.8">${p.price}</p>
         <div data-whop-checkout-plan-id="${p.plan}"
              data-whop-checkout-theme="dark"
              data-whop-checkout-metadata='${JSON.stringify({ user_id: session.user.id })}'></div>
       </div>`).join('') +
    '<p style="font-size:13px;opacity:.7;margin-top:24px">Chips have no real-world ' +
    'value and cannot be redeemed, withdrawn, or exchanged for cash or prizes. ' +
    'All purchases are final.</p>';

  document.body.appendChild(wrap);
  wrap.querySelector('#ws-close').onclick = () => wrap.style.display = 'none';

  const btn = document.createElement('button');
  btn.textContent = '+ Chips';
  btn.style.cssText =
    'position:fixed;right:14px;bottom:14px;z-index:2147481999;padding:12px 18px;' +
    'border:0;border-radius:24px;background:#d4af37;font-weight:600;font-size:16px';
  btn.onclick = () => wrap.style.display = 'block';
  document.body.appendChild(btn);

  window.openWebStore = () => wrap.style.display = 'block';
}

// re-enable controls once the real balance lands
window.addEventListener('chips:changed', () => {
  ['btnDeal','btnFold','btnRaise'].forEach(id => {
    const el = document.getElementById(id);
    if (el && cached > 0) el.disabled = false;
  });
});
