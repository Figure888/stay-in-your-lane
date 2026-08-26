/*
 * Stay in Your Lane — age gate + no-real-money disclaimer
 * -------------------------------------------------------
 * Drop-in. Injects its own styles and markup, blocks the app until the
 * player confirms they are 18+, and remembers the answer.
 *
 * Usage in index.html, BEFORE your game script:
 *   <script src="age-gate.js"></script>
 *   <script>
 *     SIYLGate.require().then(startGame);   // startGame runs only after confirmation
 *   </script>
 *
 * Reset while testing:  SIYLGate.reset()
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'siyl.age.confirmed.v1';
  var PRIVACY_URL = 'privacy.html';   // change if you host it elsewhere

  var CSS = [
    '#siyl-gate{',
    '  position:fixed;inset:0;z-index:2147483000;',
    '  display:flex;align-items:center;justify-content:center;',
    '  padding:24px 20px;overflow-y:auto;',
    '  background:#14161B;color:#EDE7D8;',
    '  font:16px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;',
    '  -webkit-font-smoothing:antialiased;',
    '}',
    '#siyl-gate .siyl-card{width:100%;max-width:26rem;margin:auto;text-align:center}',

    /* signature: the two-lane board, drawn as road markings */
    '#siyl-gate .siyl-board{',
    '  display:flex;align-items:center;justify-content:center;gap:6px;',
    '  margin:0 0 28px;',
    '}',
    '#siyl-gate .siyl-lane{display:flex;flex-direction:column;gap:6px}',
    '#siyl-gate .siyl-c{',
    '  width:26px;height:36px;border-radius:3px;',
    '  border:2px solid #3A404A;background:#1D2128;',
    '}',
    '#siyl-gate .siyl-mid{display:flex;gap:6px}',
    '#siyl-gate .siyl-mid .siyl-c{border-color:#F2B705;background:#20242C}',
    '#siyl-gate .siyl-mid .siyl-c:nth-child(2){',
    '  background:#F2B705;border-color:#F2B705;',
    '  display:flex;align-items:center;justify-content:center;',
    '  color:#14161B;font-weight:800;font-size:11px;letter-spacing:-.02em;',
    '}',

    '#siyl-gate h1{',
    '  font-size:1.6rem;line-height:1.15;margin:0 0 6px;',
    '  font-weight:800;letter-spacing:-.02em;',
    '}',
    '#siyl-gate .siyl-eyebrow{',
    '  font-size:.66rem;letter-spacing:.24em;text-transform:uppercase;',
    '  color:#F2B705;margin:0 0 10px;',
    '}',
    '#siyl-gate .siyl-rules{',
    '  list-style:none;margin:22px 0;padding:18px 16px;text-align:left;',
    '  background:#1D2128;border-left:4px solid #F2B705;border-radius:0 4px 4px 0;',
    '}',
    '#siyl-gate .siyl-rules li{',
    '  margin:0 0 10px;padding-left:20px;position:relative;',
    '  font-size:.92rem;color:#DAD5C7;',
    '}',
    '#siyl-gate .siyl-rules li:last-child{margin-bottom:0}',
    '#siyl-gate .siyl-rules li::before{',
    '  content:"";position:absolute;left:0;top:.55em;',
    '  width:10px;height:2px;background:#F2B705;',
    '}',
    '#siyl-gate .siyl-btn{',
    '  display:block;width:100%;padding:15px 18px;margin:0 0 10px;',
    '  border:0;border-radius:6px;cursor:pointer;',
    '  font:inherit;font-weight:700;font-size:1rem;',
    '  background:#F2B705;color:#14161B;',
    '  transition:transform .12s ease,filter .12s ease;',
    '}',
    '#siyl-gate .siyl-btn:hover{filter:brightness(1.08)}',
    '#siyl-gate .siyl-btn:active{transform:translateY(1px)}',
    '#siyl-gate .siyl-btn.siyl-secondary{',
    '  background:transparent;color:#A8A395;',
    '  border:2px solid #3A404A;font-weight:600;',
    '}',
    '#siyl-gate .siyl-btn:focus-visible,#siyl-gate a:focus-visible{',
    '  outline:3px solid #EDE7D8;outline-offset:2px;',
    '}',
    '#siyl-gate .siyl-fine{',
    '  font-size:.78rem;color:#8B8779;margin:16px 0 0;line-height:1.55;',
    '}',
    '#siyl-gate a{color:#F2B705}',
    '#siyl-gate .siyl-exit{',
    '  max-width:22rem;margin:auto;text-align:center;',
    '}',
    '#siyl-gate .siyl-exit h1{font-size:1.25rem}',
    '@media (prefers-reduced-motion:reduce){',
    '  #siyl-gate .siyl-btn{transition:none}',
    '}'
  ].join('\n');

  var BOARD =
    '<div class="siyl-board" aria-hidden="true">' +
      '<div class="siyl-lane"><div class="siyl-c"></div><div class="siyl-c"></div></div>' +
      '<div class="siyl-mid">' +
        '<div class="siyl-c"></div><div class="siyl-c">18+</div><div class="siyl-c"></div>' +
      '</div>' +
      '<div class="siyl-lane"><div class="siyl-c"></div><div class="siyl-c"></div></div>' +
    '</div>';

  function injectStyles() {
    if (document.getElementById('siyl-gate-styles')) return;
    var s = document.createElement('style');
    s.id = 'siyl-gate-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function read() {
    try { return localStorage.getItem(STORAGE_KEY) === 'yes'; }
    catch (e) { return false; }
  }

  function write() {
    try { localStorage.setItem(STORAGE_KEY, 'yes'); } catch (e) { /* private mode */ }
  }

  function build(resolve) {
    var overlay = document.createElement('div');
    overlay.id = 'siyl-gate';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'siyl-gate-title');

    overlay.innerHTML =
      '<div class="siyl-card">' +
        BOARD +
        '<p class="siyl-eyebrow">Play money only</p>' +
        '<h1 id="siyl-gate-title">Stay in Your Lane</h1>' +
        '<ul class="siyl-rules">' +
          '<li>Chips are play money. They have no cash value.</li>' +
          '<li>Nothing here can be cashed out, redeemed, or traded.</li>' +
          '<li>There are no prizes of real-world value.</li>' +
          '<li>This is not gambling, and it is not practice for gambling.</li>' +
          '<li>Intended for players aged 18 and over.</li>' +
        '</ul>' +
        '<button class="siyl-btn" id="siyl-yes" type="button">I am 18 or older — deal me in</button>' +
        '<button class="siyl-btn siyl-secondary" id="siyl-no" type="button">I am under 18</button>' +
        '<p class="siyl-fine">Chip packs sold in this app are consumable play money. ' +
        'Read the <a href="' + PRIVACY_URL + '">privacy policy</a>.</p>' +
      '</div>';

    document.body.appendChild(overlay);
    overlay.querySelector('#siyl-yes').focus();

    overlay.querySelector('#siyl-yes').addEventListener('click', function () {
      write();
      overlay.remove();
      resolve(true);
    });

    overlay.querySelector('#siyl-no').addEventListener('click', function () {
      overlay.innerHTML =
        '<div class="siyl-exit">' +
          BOARD +
          '<h1>This game is for adults</h1>' +
          '<p class="siyl-fine">Stay in Your Lane simulates casino-style card play and is ' +
          'restricted to players aged 18 and over. Close the app to exit.</p>' +
        '</div>';
      // never resolves: the game must not start
    });
  }

  var api = {
    require: function () {
      injectStyles();
      if (read()) return Promise.resolve(true);
      return new Promise(function (resolve) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', function () { build(resolve); });
        } else {
          build(resolve);
        }
      });
    },
    reset: function () {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    }
  };

  global.SIYLGate = api;
})(window);
