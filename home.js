/*
 * Stay in Your Lane — home screen
 * --------------------------------
 * Drop-in. The screen the app opens on: who you are, what to play, who's
 * ahead, what the game is.
 *
 *   <script src="home.js"></script>
 *
 * Renders into #homeView. Call Home.mount() when the Home mode is selected.
 */
(function () {
  'use strict';

  var STYLE_ID = 'siyl-home-styles';
  var account = null;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  async function api(path) {
    var s = await window.sb.auth.getSession();
    if (!s.data.session) throw new Error('not_signed_in');
    var res = await fetch(path, {
      headers: { Authorization: 'Bearer ' + s.data.session.access_token },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function styles() {
    if ($(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.hm-hero{position:relative;border-radius:9px;overflow:hidden;margin-top:12px;',
      'border:1px solid var(--edge,#333);padding:22px 18px;',
      'background:radial-gradient(120% 90% at 18% 0%,#26313a 0%,#141a1e 55%,#0d1114 100%)}',
      '.hm-hero:after{content:"";position:absolute;inset:0;pointer-events:none;',
      'background:repeating-linear-gradient(90deg,transparent 0 38px,rgba(255,255,255,.022) 38px 40px)}',
      '.hm-hero h1{font-family:var(--display,inherit);font-size:26px;margin:0 0 6px;line-height:1.05}',
      '.hm-hero p{margin:0;font-size:13px;opacity:.72;line-height:1.5;max-width:31ch}',
      '.hm-lanes{display:flex;gap:4px;margin-top:16px}',
      '.hm-lanes i{height:3px;flex:1;border-radius:2px;background:rgba(255,255,255,.15)}',
      '.hm-lanes i:nth-child(2){background:var(--paint,#f5c518)}',

      '.hm-me{display:flex;align-items:center;gap:12px;padding:14px 0;',
      'border-bottom:1px solid rgba(255,255,255,.07)}',
      '.hm-me .who{flex:1;min-width:0}',
      '.hm-me b{display:block;font-size:15px}',
      '.hm-me small{opacity:.6;font-size:11.5px}',
      '.hm-badge{width:46px;height:46px;border-radius:10px;flex:0 0 auto;',
      'display:flex;align-items:center;justify-content:center;color:#111;',
      'font-family:var(--display,inherit);font-size:17px;font-weight:700}',
      '.hm-bar{height:4px;border-radius:2px;background:rgba(255,255,255,.1);',
      'margin-top:6px;overflow:hidden}',
      '.hm-bar i{display:block;height:100%;background:var(--paint,#f5c518);',
      'transition:width .6s cubic-bezier(.2,.8,.3,1)}',

      '.hm-play{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:16px 0}',
      '.hm-card{border:1px solid var(--edge,#333);border-radius:8px;padding:14px 12px;',
      'background:linear-gradient(180deg,rgba(255,255,255,.035),transparent);',
      'cursor:pointer;text-align:left;color:inherit;min-height:92px;',
      'display:flex;flex-direction:column;justify-content:space-between;',
      'transition:transform .18s,border-color .18s}',
      '.hm-card:active{transform:scale(.975)}',
      '.hm-card.wide{grid-column:1/-1;min-height:0;flex-direction:row;align-items:center}',
      '.hm-card b{font-size:14px;display:block}',
      '.hm-card small{opacity:.58;font-size:11px;line-height:1.4;display:block;margin-top:3px}',
      '.hm-card.primary{border-color:var(--paint,#f5c518)}',
      '.hm-card.primary b{color:var(--paint,#f5c518)}',

      '.hm-sec{font-family:var(--mono,monospace);font-size:8.5px;letter-spacing:.17em;',
      'text-transform:uppercase;opacity:.5;margin:20px 0 7px}',
      '.hm-lb{display:flex;align-items:center;gap:9px;padding:7px 0;font-size:12.5px;',
      'border-bottom:1px solid rgba(255,255,255,.05)}',
      '.hm-lb .r{width:22px;opacity:.45;font-size:11px}',
      '.hm-lb .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hm-lb .x{opacity:.55;font-size:11px}',
      '.hm-dot{width:9px;height:9px;border-radius:3px;flex:0 0 auto}',

      '.hm-rules{border:1px solid var(--edge,#333);border-radius:8px;padding:14px;',
      'margin-top:8px;font-size:12.5px;line-height:1.55;opacity:.82}',
      '.hm-rules b{color:var(--paint,#f5c518)}',
      '.hm-foot{text-align:center;font-size:10.5px;opacity:.45;margin:22px 0 8px;line-height:1.6}',
    ].join('');
    document.head.appendChild(s);
  }

  var TIER_COLOR = ['#8a9299','#7ee08a','#4bb8e8','#c58bf0','#f5c518','#f0a04b','#e8674b','#ff4d4d'];

  function render() {
    var host = $('homeView');
    if (!host) return;

    var t = (account && account.tier) || { name: 'Learner', idx: 0 };
    var chips = account ? Number(account.chips || 0).toLocaleString() : '\u2014';
    var name = account ? (account.username || account.displayName || 'Player') : 'Player';
    var pct = Math.round(((account && account.progress) || 0) * 100);

    host.innerHTML =
      '<div class="hm-hero">' +
        '<h1>Stay in Your Lane</h1>' +
        '<p>A poker variant of my own making. Four open lanes, one sealed hand, ' +
          'best of five takes it.</p>' +
        '<div class="hm-lanes"><i></i><i></i><i></i><i></i></div>' +
      '</div>' +

      '<div class="hm-me">' +
        '<div class="hm-badge" style="background:' + TIER_COLOR[t.idx || 0] + '">' +
          esc(t.name.charAt(0)) + '</div>' +
        '<div class="who">' +
          '<b>' + esc(name) + '</b>' +
          '<small>' + esc(t.name) + ' \u00b7 ' + chips + ' chips</small>' +
          '<div class="hm-bar"><i style="width:' + pct + '%"></i></div>' +
        '</div>' +
      '</div>' +

      '<div class="hm-play">' +
        '<button class="hm-card primary" data-go="online">' +
          '<b>Play online</b>' +
          '<small>Heads-up against a real player</small></button>' +
        '<button class="hm-card" data-go="convoy">' +
          '<b>Practice</b>' +
          '<small>Convoy against Rook</small></button>' +
        '<button class="hm-card wide" data-go="table">' +
          '<div style="flex:1"><b>Lane Hold\u2019em</b>' +
          '<small>The full table game</small></div></button>' +
      '</div>' +

      '<div class="hm-sec">Top players</div>' +
      '<div id="hmBoard"><p style="font-size:12px;opacity:.5">Loading\u2026</p></div>' +

      '<div class="hm-sec">How it works</div>' +
      '<div class="hm-rules">' +
        'You get <b>five cards in hand</b> and <b>four lanes</b>, each starting with ' +
        'one card face up. Take turns drawing from the pile and placing into a lane ' +
        '\u2014 or swap the card into your hand, <b>once per game</b>. ' +
        'When every lane holds three, there\u2019s <b>one round of betting</b>. ' +
        'Fill all four lanes to five, then your sealed hand opens. ' +
        '<b>Five matchups, best of five takes the pot.</b>' +
      '</div>' +

      '<div class="hm-foot">Play chips only \u00b7 no real money \u00b7 no cash-out \u00b7 18+<br>' +
        '<a href="./terms.html" style="color:inherit">Terms</a> \u00b7 ' +
        '<a href="./privacy.html" style="color:inherit">Privacy</a></div>';

    Array.prototype.forEach.call(host.querySelectorAll('[data-go]'), function (b) {
      b.addEventListener('click', function () {
        if (window.setMode) window.setMode(b.dataset.go);
      });
    });

    if (window.Social) {
      window.Social.leaderboard($('hmBoard'), 'global');
    }
  }

  async function mount() {
    styles();
    render();
    try {
      account = await api('/api/account');
      render();
    } catch (e) { /* signed out — the hero and rules still read fine */ }
  }

  window.Home = { mount: mount, refresh: function () { account = null; mount(); } };
})();
