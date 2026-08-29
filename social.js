/*
 * Stay in Your Lane — social layer
 * ---------------------------------
 * Drop-in. Table chat, gifts, leaderboards and tier progress.
 * Requires chips-server.js (window.sb). Load after convoy-online.js.
 *
 *   <script src="social.js"></script>
 *
 * Exposes:
 *   Social.attachChat(gameId, oppName)  — chat bar under an online game
 *   Social.detachChat()
 *   Social.leaderboard(container)       — render the three boards
 *   Social.progress(container)          — tier + XP bar
 */
(function () {
  'use strict';

  var STYLE_ID = 'siyl-social-styles';
  var chatGame = null, chatPoll = null, lastId = 0, gifts = null, oppName = 'Opponent';

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  async function api(path, opts) {
    opts = opts || {};
    var s = await window.sb.auth.getSession();
    if (!s.data.session) throw new Error('not_signed_in');
    var res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json',
                 Authorization: 'Bearer ' + s.data.session.access_token },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var d = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    return d;
  }

  function styles() {
    if ($(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.so-chat{border:1px solid var(--edge,#333);border-radius:6px;margin-top:10px;',
      'background:rgba(0,0,0,.22);overflow:hidden}',
      '.so-log{max-height:132px;overflow-y:auto;padding:8px 10px;font-size:12.5px;',
      'display:flex;flex-direction:column;gap:5px}',
      '.so-msg{line-height:1.35}.so-msg b{opacity:.65;font-weight:600;margin-right:5px}',
      '.so-msg.mine b{color:var(--paint,#f5c518)}',
      '.so-msg.gift{font-size:19px;line-height:1.1}',
      '.so-row{display:flex;gap:5px;padding:7px;border-top:1px solid var(--edge,#333)}',
      '.so-row input{flex:1;min-width:0;padding:9px;border-radius:4px;box-sizing:border-box;',
      'border:1px solid var(--edge,#333);background:#0d1012;color:inherit;font-size:15px}',
      '.so-row button{padding:9px 11px;border-radius:4px;border:1px solid var(--edge,#333);',
      'background:transparent;color:inherit;cursor:pointer;min-height:38px}',
      '.so-gifts{display:none;grid-template-columns:repeat(4,1fr);gap:5px;padding:8px;',
      'border-top:1px solid var(--edge,#333)}',
      '.so-gifts.on{display:grid}',
      '.so-gifts button{padding:7px 3px;border-radius:5px;border:1px solid var(--edge,#333);',
      'background:transparent;color:inherit;cursor:pointer;font-size:19px;line-height:1.25}',
      '.so-gifts small{display:block;font-size:8.5px;opacity:.55;letter-spacing:.03em}',
      '.so-tier{display:flex;align-items:center;gap:10px;padding:12px 0}',
      '.so-badge{width:42px;height:42px;border-radius:9px;display:flex;align-items:center;',
      'justify-content:center;font-family:var(--display,inherit);font-size:15px;font-weight:700;',
      'color:#111;flex:0 0 auto}',
      '.so-bar{height:5px;border-radius:3px;background:rgba(255,255,255,.1);margin-top:5px;overflow:hidden}',
      '.so-bar i{display:block;height:100%;background:var(--paint,#f5c518)}',
      '.so-tabs{display:flex;gap:5px;margin:12px 0 10px}',
      '.so-tabs button{flex:1;padding:9px;border-radius:4px;border:1px solid var(--edge,#333);',
      'background:transparent;color:inherit;font-size:11px;letter-spacing:.07em;',
      'text-transform:uppercase;cursor:pointer;min-height:38px}',
      '.so-tabs button.on{border-color:var(--paint,#f5c518);color:var(--paint,#f5c518)}',
      '.so-lb{display:flex;align-items:center;gap:9px;padding:8px 0;',
      'border-bottom:1px solid rgba(255,255,255,.06);font-size:13px}',
      '.so-lb.you{background:rgba(245,197,24,.07);margin:0 -8px;padding-left:8px;padding-right:8px}',
      '.so-rank{width:26px;opacity:.5;font-variant-numeric:tabular-nums;font-size:12px}',
      '.so-lb .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.so-lb .xp{opacity:.6;font-size:11.5px;font-variant-numeric:tabular-nums}',
      '.so-tiername{font-size:9.5px;opacity:.5;letter-spacing:.06em;text-transform:uppercase}',
    ].join('');
    document.head.appendChild(s);
  }

  // Tier colours run cool to hot as you climb.
  var TIER_COLOR = ['#8a9299','#7ee08a','#4bb8e8','#c58bf0','#f5c518','#f0a04b','#e8674b','#ff4d4d'];

  function badge(tier) {
    var i = (tier && tier.idx) || 0;
    return '<div class="so-badge" style="background:' + TIER_COLOR[i] + '">' +
           esc((tier && tier.name || '?').charAt(0)) + '</div>';
  }

  // ------------------------------------------------------------------ chat

  async function loadGifts() {
    if (gifts) return gifts;
    // The catalogue is small and fixed; mirroring it here avoids a round trip
    // just to draw eight buttons. Costs are enforced server-side regardless.
    gifts = [
      { id:'clap',  emoji:'\uD83D\uDC4F', label:'Nice hand', cost:25 },
      { id:'heart', emoji:'\u2764\uFE0F',  label:'Heart',     cost:50 },
      { id:'coffee',emoji:'\u2615',        label:'Coffee',    cost:50 },
      { id:'drink', emoji:'\uD83E\uDD43', label:'Drink',     cost:100 },
      { id:'fire',  emoji:'\uD83D\uDD25', label:'On fire',   cost:100 },
      { id:'ice',   emoji:'\uD83E\uDDCA', label:'Ice cold',  cost:100 },
      { id:'cigar', emoji:'\uD83D\uDEAC', label:'Cigar',     cost:150 },
      { id:'crown', emoji:'\uD83D\uDC51', label:'Crown',     cost:500 },
    ];
    return gifts;
  }

  function giftEmoji(id) {
    var g = (gifts || []).filter(function (x) { return x.id === id; })[0];
    return g ? g.emoji : '\uD83C\uDF81';
  }

  function attachChat(gameId, name) {
    styles();
    detachChat();
    chatGame = gameId;
    oppName = name || 'Opponent';
    lastId = 0;

    var host = $('convoyView');
    if (!host) return;

    var box = document.createElement('div');
    box.className = 'so-chat';
    box.id = 'soChat';
    box.innerHTML =
      '<div class="so-log" id="soLog"></div>' +
      '<div class="so-gifts" id="soGifts"></div>' +
      '<div class="so-row">' +
        '<input id="soInput" maxlength="200" placeholder="Say something\u2026" ' +
          'autocomplete="off" autocapitalize="sentences">' +
        '<button id="soGiftBtn" aria-label="Send a gift">\uD83C\uDF81</button>' +
        '<button id="soSend">Send</button>' +
      '</div>';
    host.appendChild(box);

    loadGifts().then(function (list) {
      $('soGifts').innerHTML = list.map(function (g) {
        return '<button data-gift="' + g.id + '">' + g.emoji +
               '<small>' + g.cost + '</small></button>';
      }).join('');
      Array.prototype.forEach.call($('soGifts').querySelectorAll('[data-gift]'), function (b) {
        b.addEventListener('click', function () { sendGift(b.dataset.gift); });
      });
    });

    $('soGiftBtn').addEventListener('click', function () {
      $('soGifts').classList.toggle('on');
    });
    $('soSend').addEventListener('click', send);
    $('soInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') send();
    });

    poll();
    chatPoll = setInterval(poll, 3000);
  }

  function detachChat() {
    if (chatPoll) { clearInterval(chatPoll); chatPoll = null; }
    var b = $('soChat');
    if (b && b.parentNode) b.parentNode.removeChild(b);
    chatGame = null;
  }

  async function poll() {
    if (!chatGame) return;
    try {
      var r = await api('/api/social?do=chat&gameId=' + chatGame + '&after=' + lastId);
      if (!r.ok || !r.messages || !r.messages.length) return;

      var log = $('soLog');
      if (!log) return;

      r.messages.forEach(function (m) {
        lastId = Math.max(lastId, m.id);
        var el = document.createElement('div');
        el.className = 'so-msg' + (m.mine ? ' mine' : '') + (m.kind === 'gift' ? ' gift' : '');
        el.innerHTML = m.kind === 'gift'
          ? '<b>' + esc(m.mine ? 'You' : m.name) + '</b>' + giftEmoji(m.gift)
          : '<b>' + esc(m.mine ? 'You' : m.name) + '</b>' + esc(m.body);
        log.appendChild(el);
      });

      log.scrollTop = log.scrollHeight;
    } catch (e) { /* transient */ }
  }

  async function send() {
    var input = $('soInput');
    if (!input || !input.value.trim() || !chatGame) return;
    var body = input.value.trim();
    input.value = '';
    try { await api('/api/social', { method: 'POST', body: { do: 'say', gameId: chatGame, body: body } }); poll(); }
    catch (e) { input.value = body; }
  }

  async function sendGift(id) {
    if (!chatGame) return;
    $('soGifts').classList.remove('on');
    try {
      await api('/api/social', { method: 'POST', body: { do: 'gift', gameId: chatGame, gift: id } });
      if (window.SFX) window.SFX.play('gift');
      if (window.Chips && window.Chips.syncBalance) window.Chips.syncBalance();
      poll();
    } catch (e) {
      var log = $('soLog');
      if (log) {
        var el = document.createElement('div');
        el.className = 'so-msg';
        el.style.opacity = '.6';
        el.textContent = e.message === 'insufficient_chips'
          ? 'Not enough chips for that.' : 'Could not send that.';
        log.appendChild(el);
      }
    }
  }

  // ---------------------------------------------------------- leaderboards

  async function leaderboard(host, scope) {
    styles();
    scope = scope || 'global';
    host.innerHTML = '<p class="muted" style="font-size:12.5px">Loading\u2026</p>';

    var d;
    try { d = await api('/api/social?do=leaderboard&scope=' + scope); }
    catch (e) {
      host.innerHTML = '<p class="muted" style="font-size:12.5px">Could not load rankings.</p>';
      return;
    }

    var needsRegion = (scope === 'local' && !d.hasRegion) ||
                      (scope === 'national' && !d.hasCountry);

    host.innerHTML =
      '<div class="so-tabs">' +
        ['global','national','local'].map(function (s) {
          return '<button data-scope="' + s + '"' + (s === scope ? ' class="on"' : '') + '>' +
                 s + '</button>';
        }).join('') +
      '</div>' +
      (needsRegion
        ? '<p class="muted" style="font-size:12.5px;padding:10px 0">' +
          'Set your country and city in the sidebar to see this board.</p>'
        : (d.entries.length
            ? d.entries.map(function (e) {
                return '<div class="so-lb' + (e.you ? ' you' : '') + '">' +
                  '<span class="so-rank">' + e.rank + '</span>' +
                  badge(e.tier) +
                  '<span class="nm">' + esc(e.name) +
                    '<div class="so-tiername">' + esc(e.tier.name) + '</div></span>' +
                  '<span class="xp">' + Number(e.xp).toLocaleString() + '</span>' +
                '</div>';
              }).join('')
            : '<p class="muted" style="font-size:12.5px;padding:10px 0">' +
              'Nobody here yet. Play a game and you\u2019ll be first.</p>')) +
      (d.yourRank && d.yourRank > 25
        ? '<p class="muted" style="font-size:12px;margin-top:9px">You\u2019re #' +
          d.yourRank + '.</p>' : '');

    Array.prototype.forEach.call(host.querySelectorAll('[data-scope]'), function (b) {
      b.addEventListener('click', function () { leaderboard(host, b.dataset.scope); });
    });
  }

  // ------------------------------------------------------------- progress

  async function progress(host) {
    styles();
    var d;
    try { d = await api('/api/account'); } catch (e) { return; }

    // player_progress isn't exposed as its own route; the account payload
    // carries what we need once xp lands there. Fall back quietly if not.
    if (!d || d.xp === undefined) return;

    var t = d.tier || { name: 'Learner', idx: 0 };
    host.innerHTML =
      '<div class="so-tier">' + badge(t) +
        '<div style="flex:1;min-width:0">' +
          '<b>' + esc(t.name) + '</b>' +
          '<div class="so-bar"><i style="width:' +
            Math.round((d.progress || 0) * 100) + '%"></i></div>' +
          '<div class="so-tiername" style="margin-top:4px">' +
            Number(d.xp || 0).toLocaleString() + ' XP' +
            (d.nextAt ? ' \u00b7 ' + Number(d.nextAt).toLocaleString() + ' to rank up' : '') +
          '</div>' +
        '</div>' +
      '</div>';
  }

  window.Social = {
    attachChat: attachChat,
    detachChat: detachChat,
    leaderboard: leaderboard,
    progress: progress,
  };
})();
