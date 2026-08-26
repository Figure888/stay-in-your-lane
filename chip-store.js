/*
 * Stay in Your Lane — chip pack store UI
 * ---------------------------------------
 * Drop-in. Renders a "Buy chips" button and a purchase sheet, driven by
 * chips-billing.js. Hides itself completely when Play Billing isn't available
 * (plain browser, desktop, dev) so nothing dead ever shows.
 *
 * Load AFTER chips-billing.js:
 *   <script src="chips-billing.js"></script>
 *   <script src="chip-store.js"></script>
 *   <script>
 *     SIYLGate.require();
 *     Chips.init().then(() => ChipStore.mount());
 *   </script>
 *
 * Hook purchases into your own chip balance:
 *   window.addEventListener('chips:purchased', e => {
 *     myGame.addChips(e.detail.chips);   // your existing balance function
 *   });
 *
 * Open it from your own button instead of the floating one:
 *   ChipStore.mount({ floatingButton: false });
 *   yourButton.onclick = () => ChipStore.open();
 */
const ChipStore = (function () {
  'use strict';

  const CSS = `
#siyl-store-btn{
  position:fixed;right:14px;bottom:14px;z-index:2147482000;
  padding:11px 16px;border:0;border-radius:999px;cursor:pointer;
  background:#F2B705;color:#14161B;
  font:700 14px/1 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
  box-shadow:0 4px 14px rgba(0,0,0,.45);
}
#siyl-store-btn:active{transform:translateY(1px)}
#siyl-store{
  position:fixed;inset:0;z-index:2147482500;
  display:flex;align-items:flex-end;justify-content:center;
  background:rgba(8,9,11,.82);
  font:16px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
}
#siyl-store .siyl-sheet{
  width:100%;max-width:26rem;max-height:86vh;overflow-y:auto;
  background:#14161B;color:#EDE7D8;
  border-top:3px solid #F2B705;border-radius:14px 14px 0 0;
  padding:22px 18px calc(22px + env(safe-area-inset-bottom));
}
#siyl-store .siyl-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px}
#siyl-store h2{margin:0;font-size:1.2rem;font-weight:800;letter-spacing:-.01em}
#siyl-store .siyl-bal{font-size:.85rem;color:#F2B705;font-variant-numeric:tabular-nums}
#siyl-store .siyl-sub{margin:0 0 18px;font-size:.82rem;color:#8B8779}
#siyl-store .siyl-pack{
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  width:100%;padding:14px 16px;margin-bottom:10px;
  background:#1D2128;border:2px solid #2A2F38;border-radius:8px;
  color:#EDE7D8;font:inherit;text-align:left;cursor:pointer;
}
#siyl-store .siyl-pack:active{border-color:#F2B705}
#siyl-store .siyl-pack[disabled]{opacity:.5;cursor:default}
#siyl-store .siyl-pack .n{font-weight:700;font-size:1rem}
#siyl-store .siyl-pack .c{font-size:.82rem;color:#A8A395;font-variant-numeric:tabular-nums}
#siyl-store .siyl-pack .p{
  flex:none;padding:7px 12px;border-radius:6px;
  background:#F2B705;color:#14161B;font-weight:800;font-size:.9rem;
}
#siyl-store .siyl-close{
  width:100%;padding:13px;margin-top:6px;
  background:transparent;color:#A8A395;
  border:2px solid #2A2F38;border-radius:8px;
  font:600 .95rem inherit;cursor:pointer;
}
#siyl-store .siyl-note{margin:14px 0 0;font-size:.74rem;color:#6F6B60;line-height:1.5}
#siyl-store .siyl-msg{margin:0 0 12px;padding:10px 12px;border-radius:6px;
  background:#1D2128;border-left:3px solid #F2B705;font-size:.85rem;color:#DAD5C7}
#siyl-store button:focus-visible,#siyl-store-btn:focus-visible{outline:3px solid #EDE7D8;outline-offset:2px}
`;

  let mounted = false;
  let packs = [];

  function injectStyles() {
    if (document.getElementById('siyl-store-styles')) return;
    const s = document.createElement('style');
    s.id = 'siyl-store-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function fmt(n) {
    return n.toLocaleString();
  }

  async function mount(opts) {
    const options = Object.assign({ floatingButton: true }, opts || {});
    if (!Chips.isAvailable()) return false;   // no billing, no store
    injectStyles();
    try {
      packs = await Chips.getPacks();
    } catch (err) {
      console.warn('[store] could not load packs:', err);
      return false;
    }
    if (!packs.length) return false;

    if (options.floatingButton) {
      const btn = document.createElement('button');
      btn.id = 'siyl-store-btn';
      btn.type = 'button';
      btn.textContent = 'Buy chips';
      btn.addEventListener('click', open);
      document.body.appendChild(btn);
    }
    mounted = true;
    return true;
  }

  function open() {
    if (document.getElementById('siyl-store')) return;

    const overlay = document.createElement('div');
    overlay.id = 'siyl-store';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Buy chips');

    overlay.innerHTML =
      '<div class="siyl-sheet">' +
        '<div class="siyl-head">' +
          '<h2>Chip packs</h2>' +
          '<span class="siyl-bal">' + fmt(Chips.getBalance()) + ' chips</span>' +
        '</div>' +
        '<p class="siyl-sub">Play money. No cash value, no cash-out.</p>' +
        '<div id="siyl-msg-slot"></div>' +
        packs.map(p =>
          '<button class="siyl-pack" type="button" data-sku="' + p.sku + '">' +
            '<span><span class="n">' + p.label + '</span><br>' +
            '<span class="c">' + fmt(p.chips) + ' chips</span></span>' +
            '<span class="p">' + p.price + '</span>' +
          '</button>'
        ).join('') +
        '<button class="siyl-close" type="button" id="siyl-store-close">Close</button>' +
        '<p class="siyl-note">Purchases are handled by Google Play. Chips are consumable ' +
        'play money and cannot be transferred, redeemed, or exchanged for anything of value.</p>' +
      '</div>';

    document.body.appendChild(overlay);

    overlay.addEventListener('click', e => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('#siyl-store-close').addEventListener('click', close);

    overlay.querySelectorAll('.siyl-pack').forEach(btn => {
      btn.addEventListener('click', () => purchase(btn.dataset.sku, overlay));
    });
  }

  async function purchase(sku, overlay) {
    const buttons = overlay.querySelectorAll('.siyl-pack');
    buttons.forEach(b => (b.disabled = true));
    message(overlay, 'Opening Google Play…');

    try {
      const granted = await Chips.buy(sku);
      overlay.querySelector('.siyl-bal').textContent = fmt(Chips.getBalance()) + ' chips';
      message(overlay, fmt(granted) + ' chips added.');
      window.dispatchEvent(new CustomEvent('chips:purchased', {
        detail: { sku: sku, chips: granted, balance: Chips.getBalance() }
      }));
      setTimeout(close, 1200);
    } catch (err) {
      // AbortError = player backed out of the Play sheet. Not an error worth shouting about.
      if (err && err.name === 'AbortError') {
        message(overlay, '');
      } else {
        console.warn('[store] purchase failed:', err);
        message(overlay, 'That purchase didn\'t go through. Nothing was charged.');
      }
      buttons.forEach(b => (b.disabled = false));
    }
  }

  function message(overlay, text) {
    const slot = overlay.querySelector('#siyl-msg-slot');
    slot.innerHTML = text ? '<p class="siyl-msg">' + text + '</p>' : '';
  }

  function close() {
    const el = document.getElementById('siyl-store');
    if (el) el.remove();
  }

  return { mount, open, close, isMounted: () => mounted };
})();
