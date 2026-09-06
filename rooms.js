/*
 * Stay in Your Lane — room backdrops
 * -----------------------------------
 * Drop-in. Puts a photographic backdrop behind each game mode.
 *
 *   <script src="rooms.js"></script>
 *
 * The images are already darkened to about a third brightness, and there's a
 * further scrim over the top. That's deliberate: a backdrop sits behind cards
 * and small text, and anything with contrast left in it makes the board
 * harder to read. If it looks slightly too dark on its own, it's about right
 * with a hand on top of it.
 *
 * Set --room-dim higher if you want it even flatter.
 */
(function () {
  'use strict';

  var STYLE_ID = 'siyl-room-styles';

  var ROOMS = {
    table:  './room-lounge.jpg',   // Lane Hold'em — the card room
    convoy: './room-street.jpg',   // Convoy — the strip at night
    online: './room-street.jpg',
  };

  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      ':root{--room-dim:.62}',

      /* One fixed layer behind everything, cross-fading between rooms.
         Fixed rather than per-view so it doesn't scroll with the board and
         doesn't repaint on every render. */
      '#roomBg{position:fixed;inset:0;z-index:-2;background-size:cover;',
      'background-position:center;opacity:0;transition:opacity .5s ease,',
      'background-image .01s;pointer-events:none}',
      '#roomBg.on{opacity:1}',

      /* The scrim. Darkest at the top and bottom where the header and the
         action bar live. */
      '#roomBg:after{content:"";position:absolute;inset:0;',
      'background:linear-gradient(180deg,rgba(8,11,14,.92) 0%,',
      'rgba(8,11,14,calc(var(--room-dim) - .05)) 26%,',
      'rgba(8,11,14,var(--room-dim)) 62%,rgba(8,11,14,.94) 100%)}',

      /* Panels get a touch of translucency so the room shows through without
         costing legibility. */
      '.cv-block,#tableView .seat,#storeView .cv-block{',
      'backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}',

      /* Anyone who asked for less motion gets no cross-fade. */
      '@media (prefers-reduced-motion:reduce){#roomBg{transition:none}}',
    ].join('');
    document.head.appendChild(s);
  }

  var el = null, current = null;

  function layer() {
    if (el && document.body.contains(el)) return el;
    el = document.createElement('div');
    el.id = 'roomBg';
    document.body.insertBefore(el, document.body.firstChild);
    return el;
  }

  function show(mode) {
    styles();
    var src = ROOMS[mode];
    var node = layer();

    if (!src) { node.classList.remove('on'); current = null; return; }
    if (src === current) { node.classList.add('on'); return; }

    // Preload so the fade doesn't reveal an empty layer first.
    var img = new Image();
    img.onload = function () {
      node.style.backgroundImage = 'url("' + src + '")';
      node.classList.add('on');
      current = src;
    };
    img.src = src;
  }

  /* setMode is a global in index.html, so wrapping it catches every mode
     change without editing the switcher. */
  function hook() {
    if (typeof window.setMode !== 'function') return false;
    var orig = window.setMode;
    window.setMode = function (m) {
      var r = orig.apply(this, arguments);
      try { show(m); } catch (e) {}
      return r;
    };
    return true;
  }

  function start() {
    styles();
    if (!hook()) {
      // Loaded before the game script — try once more after everything settles.
      window.addEventListener('load', hook);
    }
    // Whatever tab we opened on.
    var on = document.querySelector('.mode-btn.on');
    if (on) {
      show((on.id || '').replace('mode', '').toLowerCase());
    }
  }

  window.Rooms = { show: show, rooms: ROOMS };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else { start(); }
})();
