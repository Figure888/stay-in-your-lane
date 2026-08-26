/*
 * Stay in Your Lane — chip packs via Google Play Billing
 * ------------------------------------------------------
 * Works only when the PWA is running inside a Trusted Web Activity built with
 * Play Billing enabled (tick "Play Billing" in PWABuilder before generating the
 * Android package). Outside the TWA — plain Chrome, desktop, dev — isAvailable()
 * returns false and you should hide the store UI entirely.
 *
 * Chips are CONSUMABLE and dead-ended by design: no cash-out, no transfer between
 * players, no redemption. Keep it that way or the app becomes a real-money
 * gambling product under Play policy.
 *
 * Usage:
 *   await Chips.init();
 *   if (Chips.isAvailable()) {
 *     const packs = await Chips.getPacks();          // [{sku, title, price, chips}]
 *     await Chips.buy('chips_stack');                // returns chips granted
 *   }
 */
const Chips = (function () {
  'use strict';

  const PLAY_BILLING = 'https://play.google.com/billing';

  // Must match the product IDs you create in Play Console > Monetize > In-app products.
  // Set every one of these to "Consumable".
  const CATALOG = [
    { sku: 'chips_rack',  chips: 10000,  label: 'Rack'  },
    { sku: 'chips_stack', chips: 60000,  label: 'Stack' },
    { sku: 'chips_tray',  chips: 200000, label: 'Tray'  }
  ];

  let service = null;

  async function init() {
    if (!('getDigitalGoodsService' in window)) return false;
    try {
      service = await window.getDigitalGoodsService(PLAY_BILLING);
      // Clean up anything that was paid for but never granted (app killed mid-purchase).
      await recoverPendingPurchases();
      return true;
    } catch (err) {
      console.warn('[chips] Play Billing unavailable:', err);
      service = null;
      return false;
    }
  }

  function isAvailable() {
    return service !== null;
  }

  async function getPacks() {
    if (!service) return [];
    const skus = CATALOG.map(p => p.sku);
    const details = await service.getDetails(skus);
    return details.map(d => {
      const entry = CATALOG.find(p => p.sku === d.itemId);
      return {
        sku: d.itemId,
        title: d.title,
        description: d.description,
        price: `${d.price.currency} ${d.price.value}`,
        chips: entry ? entry.chips : 0,
        label: entry ? entry.label : d.title
      };
    });
  }

  async function buy(sku) {
    if (!service) throw new Error('Play Billing is not available in this context.');
    const entry = CATALOG.find(p => p.sku === sku);
    if (!entry) throw new Error(`Unknown chip pack: ${sku}`);

    const request = new PaymentRequest(
      [{ supportedMethods: PLAY_BILLING, data: { sku } }],
      { total: { label: entry.label, amount: { currency: 'USD', value: '0' } } }
      // Play supplies the real price; this total is a required placeholder.
    );

    const response = await request.show();
    const token = response.details.purchaseToken ?? response.details.token;

    try {
      // Consumable: consume immediately so the player can buy the pack again.
      await service.consume(token);
      grantChips(entry.chips);
      await response.complete('success');
      return entry.chips;
    } catch (err) {
      await response.complete('fail');
      throw err;
    }
  }

  // Purchases that were paid for but not consumed (crash, force-close, lost signal).
  async function recoverPendingPurchases() {
    if (!service || typeof service.listPurchases !== 'function') return;
    let purchases = [];
    try {
      purchases = await service.listPurchases();
    } catch (err) {
      console.warn('[chips] could not list purchases:', err);
      return;
    }
    for (const p of purchases) {
      const entry = CATALOG.find(c => c.sku === p.itemId);
      if (!entry) continue;
      try {
        await service.consume(p.purchaseToken);
        grantChips(entry.chips);
        console.info(`[chips] recovered ${entry.chips} chips from an unfinished purchase`);
      } catch (err) {
        console.warn('[chips] recovery failed for', p.itemId, err);
      }
    }
  }

  // ---- local balance -------------------------------------------------------
  // Replace these two with your game's own balance handling if it already has one.
  const BALANCE_KEY = 'siyl.chips.balance.v1';

  function getBalance() {
    try { return parseInt(localStorage.getItem(BALANCE_KEY) || '0', 10) || 0; }
    catch (e) { return 0; }
  }

  function grantChips(amount) {
    const next = getBalance() + amount;
    try { localStorage.setItem(BALANCE_KEY, String(next)); } catch (e) {}
    window.dispatchEvent(new CustomEvent('chips:changed', { detail: { balance: next } }));
    return next;
  }

  function spendChips(amount) {
    const next = Math.max(0, getBalance() - amount);
    try { localStorage.setItem(BALANCE_KEY, String(next)); } catch (e) {}
    window.dispatchEvent(new CustomEvent('chips:changed', { detail: { balance: next } }));
    return next;
  }

  return { init, isAvailable, getPacks, buy, getBalance, grantChips, spendChips, CATALOG };
})();
