/*
 * Stay in Your Lane — 3D and motion
 * ----------------------------------
 * Drop-in. Adds real 3D perspective to the table, card flips that rotate
 * through the Y axis, deal and place animations, chip flight, and floating
 * gifts.
 *
 *   <script src="fx.js"></script>
 *
 * Built on CSS 3D transforms rather than WebGL. That's a deliberate call: a
 * Three.js scene would look impressive on a desktop and stutter on the phones
 * most of your players will use, and it would mean rebuilding a board that
 * already works. CSS transforms are GPU-composited, cost almost nothing, and
 * degrade to flat on old hardware instead of failing.
 *
 * Everything respects prefers-reduced-motion.
 *
 * Exposes window.FX:
 *   FX.dealt(el)        — a card arriving from the pile
 *   FX.flip(el)         — reveal, rotating through the edge
 *   FX.placed(el)       — settling into a lane
 *   FX.chips(from, to)  — chips flying to the pot
 *   FX.gift(emoji)      — a gift floating up the screen
 *   FX.win(el) / FX.lose(el)
 *   FX.shake(el)        — an illegal move
 */
(function () {
  'use strict';

  var STYLE_ID = 'siyl-fx-styles';

  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      /* --- the table gets depth --------------------------------------- */
      '#convoyView,#tableView{perspective:1400px;perspective-origin:50% 34%}',
      '.cv-block{transform-style:preserve-3d;transition:transform .45s cubic-bezier(.2,.7,.3,1)}',
      /* The opponent sits further away, you sit nearer. Subtle — a couple of
         degrees reads as depth without making text hard to read. */
      '#cvOpp{transform:rotateX(4.5deg) translateZ(-26px)}',
      '#cvYou{transform:rotateX(-2.5deg) translateZ(10px)}',
      '.cv-block.turn{transform:rotateX(-1deg) translateZ(20px)}',

      /* --- cards live in 3D ------------------------------------------- */
      '.card{transform-style:preserve-3d;backface-visibility:hidden;',
      'transition:transform .28s cubic-bezier(.2,.7,.3,1),box-shadow .28s}',
      '.card.cv{will-change:transform}',
      '.cv-lane:hover .card.cv{transform:translateZ(4px)}',

      /* --- dealing ----------------------------------------------------- */
      '@keyframes fxDeal{',
      'from{transform:translate3d(0,-140px,220px) rotateY(180deg) rotateZ(-14deg);opacity:0}',
      'to{transform:none;opacity:1}}',
      '.fx-deal{animation:fxDeal .42s cubic-bezier(.2,.8,.25,1) both}',

      /* --- flipping to reveal ------------------------------------------ */
      '@keyframes fxFlip{',
      '0%{transform:rotateY(0deg) translateZ(0)}',
      '45%{transform:rotateY(90deg) translateZ(34px) scale(1.07)}',
      '100%{transform:rotateY(180deg) translateZ(0)}}',
      '.fx-flip{animation:fxFlip .46s cubic-bezier(.4,.05,.3,1) both}',

      /* --- settling into a lane ---------------------------------------- */
      '@keyframes fxPlace{',
      '0%{transform:translate3d(0,-42px,110px) rotateX(28deg);opacity:.4}',
      '62%{transform:translate3d(0,4px,0) rotateX(-6deg);opacity:1}',
      '100%{transform:none}}',
      '.fx-place{animation:fxPlace .34s cubic-bezier(.2,.8,.3,1) both}',

      /* --- chips flying to the pot ------------------------------------- */
      '.fx-chip{position:fixed;width:19px;height:19px;border-radius:50%;z-index:9997;',
      'pointer-events:none;background:radial-gradient(circle at 34% 30%,#ffe071,#c99b10);',
      'box-shadow:0 2px 7px rgba(0,0,0,.55),inset 0 0 0 2.5px rgba(255,255,255,.32)}',

      /* --- gifts float up ---------------------------------------------- */
      '@keyframes fxFloat{',
      '0%{transform:translate3d(0,0,0) scale(.4);opacity:0}',
      '18%{transform:translate3d(0,-18px,0) scale(1.25);opacity:1}',
      '100%{transform:translate3d(var(--dx,10px),-190px,0) scale(.85);opacity:0}}',
      '.fx-gift{position:fixed;z-index:9997;font-size:34px;pointer-events:none;',
      'animation:fxFloat 2.1s cubic-bezier(.25,.6,.35,1) both;',
      'filter:drop-shadow(0 3px 8px rgba(0,0,0,.5))}',

      /* --- results ------------------------------------------------------ */
      '@keyframes fxWin{',
      '0%,100%{transform:none}',
      '28%{transform:translateZ(30px) scale(1.035)}',
      '64%{transform:translateZ(12px) scale(1.012)}}',
      '.fx-win{animation:fxWin .8s cubic-bezier(.2,.8,.3,1) both}',
      '.fx-lose{animation:fxWin .8s reverse both;opacity:.75}',

      '@keyframes fxShake{',
      '0%,100%{transform:translateX(0)}',
      '18%{transform:translateX(-7px) rotateZ(-1deg)}',
      '38%{transform:translateX(6px) rotateZ(1deg)}',
      '62%{transform:translateX(-4px)}82%{transform:translateX(3px)}}',
      '.fx-shake{animation:fxShake .38s ease-in-out both}',

      /* --- your turn breathes ------------------------------------------ */
      '@keyframes fxPulse{',
      '0%,100%{box-shadow:0 0 0 0 rgba(245,197,24,.34)}',
      '50%{box-shadow:0 0 0 9px rgba(245,197,24,0)}}',
      '.cv-block.turn{animation:fxPulse 2.3s ease-out infinite}',

      /* --- the drawn card hovers over the table ------------------------ */
      '#cvDrawnSlot .card{transform:translateZ(26px) rotateX(-7deg);',
      'box-shadow:0 12px 26px rgba(0,0,0,.5)}',

      /* Anyone who's asked for less motion gets none of it. */
      '@media (prefers-reduced-motion:reduce){',
      '.fx-deal,.fx-flip,.fx-place,.fx-win,.fx-lose,.fx-shake,.fx-gift{animation:none!important}',
      '.cv-block,#cvOpp,#cvYou,.card{transform:none!important;animation:none!important;',
      'transition:none!important}}',
    ].join('');
    document.head.appendChild(s);
  }

  var reduced = window.matchMedia &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function once(el, cls, ms) {
    if (!el || reduced) return;
    el.classList.remove(cls);
    void el.offsetWidth;              // restart the animation
    el.classList.add(cls);
    setTimeout(function () { el.classList.remove(cls); }, ms || 700);
  }

  function centreOf(el) {
    if (!el) return { x: innerWidth / 2, y: innerHeight / 2 };
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /* Chips arc toward the pot rather than sliding in a straight line —
     a straight line reads as a UI transition, an arc reads as a throw. */
  function chips(fromEl, toEl, count) {
    if (reduced) return;
    var a = centreOf(fromEl), b = centreOf(toEl);
    count = count || 6;

    for (var i = 0; i < count; i++) {
      (function (n) {
        setTimeout(function () {
          var c = document.createElement('div');
          c.className = 'fx-chip';
          c.style.left = (a.x - 9) + 'px';
          c.style.top = (a.y - 9) + 'px';
          document.body.appendChild(c);

          var lift = 60 + Math.random() * 50;
          var jitter = (Math.random() - 0.5) * 34;

          c.animate([
            { transform: 'translate(0,0) scale(1)', opacity: 1 },
            { transform: 'translate(' + ((b.x - a.x) / 2 + jitter) + 'px,' +
                         ((b.y - a.y) / 2 - lift) + 'px) scale(1.12)', offset: 0.5 },
            { transform: 'translate(' + (b.x - a.x) + 'px,' + (b.y - a.y) + 'px) scale(.72)',
              opacity: 0 },
          ], { duration: 560 + Math.random() * 160, easing: 'cubic-bezier(.3,.6,.4,1)' })
            .onfinish = function () { c.remove(); };
        }, n * 55);
      })(i);
    }
  }

  function gift(emoji, nearEl) {
    if (reduced) return;
    var p = centreOf(nearEl);
    var g = document.createElement('div');
    g.className = 'fx-gift';
    g.textContent = emoji || '\uD83C\uDF81';
    g.style.left = (p.x - 17) + 'px';
    g.style.top = p.y + 'px';
    g.style.setProperty('--dx', ((Math.random() - 0.5) * 70) + 'px');
    document.body.appendChild(g);
    setTimeout(function () { g.remove(); }, 2200);
  }

  window.FX = {
    dealt:  function (el) { once(el, 'fx-deal', 480); },
    flip:   function (el) { once(el, 'fx-flip', 520); },
    placed: function (el) { once(el, 'fx-place', 400); },
    win:    function (el) { once(el, 'fx-win', 880); },
    lose:   function (el) { once(el, 'fx-lose', 880); },
    shake:  function (el) { once(el, 'fx-shake', 440); },
    chips:  chips,
    gift:   gift,
    reduced: reduced,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', styles);
  } else { styles(); }
})();
