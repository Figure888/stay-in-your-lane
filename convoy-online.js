/*
 * Stay in Your Lane — Convoy online
 * ----------------------------------
 * Drop-in, same shape as age-gate.js and chip-store.js. Vanilla JS, no build
 * step. Reuses the existing .cv-* and .card.cv styles so it inherits the look
 * of the offline mode.
 *
 * Requires chips-server.js loaded first (it creates window.sb).
 *
 *   <script src="convoy-online.js"></script>
 *
 * Renders into #convoyOnline if present, otherwise appends to body.
 * Call ConvoyOnline.mount() to show the lobby.
 *
 * State comes from the server on a 2-second poll. Realtime would be nicer,
 * but the convoy tables have RLS on with no policies — deliberately, so the
 * pile order and the opponent's hand are unreachable from a browser — and a
 * Realtime subscription would need those opened up. Polling keeps the
 * security model intact. Swap it later if the traffic justifies it.
 */
(function () {
  'use strict';

  var RANK = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  var SUIT = ['\u2660','\u2665','\u2666','\u2663'];
  var STAKES = [100, 500, 1000, 5000];
  var POLL_MS = 2000;

  var mount = null, timer = null, state = null, gameId = null, busy = false;

  // ---------------------------------------------------------------- helpers

  function el() {
    if (mount && document.body.contains(mount)) return mount;
    mount = document.getElementById('convoyOnline');
    if (!mount) {
      mount = document.createElement('div');
      mount.id = 'convoyOnline';
      document.body.appendChild(mount);
    }
    return mount;
  }

  async function token() {
    if (!window.sb) throw new Error('chips-server.js must load first');
    var s = await window.sb.auth.getSession();
    if (!s.data.session) throw new Error('not signed in');
    return s.data.session.access_token;
  }

  async function api(path, opts) {
    opts = opts || {};
    var t = await token();
    var res = await fetch(path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + t,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || data.message || ('HTTP ' + res.status));
    return data;
  }

  function cardHTML(c, extra) {
    if (c === null || c === undefined) {
      return '<div class="card cv back' + (extra ? ' ' + extra : '') + '"></div>';
    }
    var r = RANK[c >> 2], s = SUIT[c & 3];
    var red = (c & 3) === 1 || (c & 3) === 2;
    return '<div class="card cv' + (red ? ' red' : '') + (extra ? ' ' + extra : '') + '">' +
             '<div class="ix tl"><b>' + r + '</b><i>' + s + '</i></div>' +
             '<div class="ix br"><b>' + r + '</b><i>' + s + '</i></div>' +
           '</div>';
  }

  function secondsLeft(deadline) {
    if (!deadline) return null;
    return Math.max(0, Math.round((new Date(deadline) - Date.now()) / 1000));
  }

  function msg(text, cls) {
    var m = document.getElementById('coMsg');
    if (m) { m.textContent = text; m.className = 'msg' + (cls ? ' ' + cls : ''); }
  }

  // ------------------------------------------------------------------ lobby

  function renderLobby(note) {
    stopPolling();
    el().innerHTML =
      '<div class="cv-block">' +
        '<div class="cv-head"><b>Convoy \u2014 online</b></div>' +
        '<p class="muted" style="font-size:12.5px;margin:6px 0 12px">' +
          'Heads-up against another player. Pick a stake and you\u2019ll be ' +
          'matched with whoever\u2019s waiting.</p>' +
        '<div class="mode-row" id="coStakes">' +
          STAKES.map(function (s) {
            return '<button class="mode-btn" data-stake="' + s + '">' +
                   s.toLocaleString() + '</button>';
          }).join('') +
        '</div>' +
        '<p class="msg" id="coMsg" style="margin-top:10px">' + (note || '') + '</p>' +
        '<div style="border-top:1px solid var(--edge);margin-top:14px;padding-top:12px">' +
          '<p class="muted" style="font-size:12.5px;margin:0 0 8px">' +
            'Or open a private table and send the link to someone.</p>' +
          '<div class="mode-row">' +
            '<button class="mode-btn" id="coPrivate">Open a private table</button>' +
          '</div>' +
          '<div class="mode-row" style="margin-top:6px">' +
            '<input id="coJoinCode" placeholder="Have a code?" maxlength="6" ' +
              'style="flex:2;min-width:0;padding:10px;border-radius:4px;' +
              'border:1px solid var(--edge);background:#0d1012;color:inherit;' +
              'text-transform:uppercase;letter-spacing:.12em;text-align:center">' +
            '<button class="mode-btn" id="coJoinCodeBtn" style="flex:1">Join</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    Array.prototype.forEach.call(
      document.querySelectorAll('#coStakes .mode-btn'),
      function (b) {
        b.addEventListener('click', function () { join(Number(b.dataset.stake)); });
      }
    );

    document.getElementById('coPrivate').addEventListener('click', function () {
      createInvite(pendingStake || STAKES[0]);
    });

    document.getElementById('coJoinCodeBtn').addEventListener('click', function () {
      var v = document.getElementById('coJoinCode').value.trim();
      if (v) redeemInvite(v);
    });
  }

  var pendingStake = null;

  // -------------------------------------------------------- private tables

  async function createInvite(stake) {
    msg('Opening a table\u2026');
    try {
      var r = await api('/api/convoy/invite', { method: 'POST', body: { stake: stake } });
      renderInvite(r);
      watchInvite(r.code);
    } catch (e) {
      msg(friendly(e.message), 'bad');
    }
  }

  function renderInvite(inv) {
    el().innerHTML =
      '<div class="cv-block">' +
        '<div class="cv-head"><b>Your table is open</b>' +
          '<span class="muted">' + inv.stake.toLocaleString() + '</span></div>' +
        '<p class="muted" style="font-size:12.5px;margin:8px 0">' +
          'Send this to whoever you want to play. The game starts the moment ' +
          'they join. Expires in 24 hours.</p>' +
        '<div class="cv-invite-code" style="font-family:ui-monospace,Menlo,monospace;' +
          'font-size:1.8rem;letter-spacing:.2em;text-align:center;padding:14px;' +
          'border-radius:6px;background:rgba(0,0,0,.3);margin-bottom:10px;' +
          'user-select:all">' + esc(inv.code) + '</div>' +
        '<div class="mode-row">' +
          '<button class="mode-btn" id="coShare">Share the link</button>' +
          '<button class="mode-btn" id="coBack">Back</button>' +
        '</div>' +
        '<p class="msg" id="coMsg" style="margin-top:10px">Waiting for them to join\u2026</p>' +
      '</div>';

    document.getElementById('coShare').addEventListener('click', function () {
      shareLink(inv);
    });
    document.getElementById('coBack').addEventListener('click', function () {
      stopPolling();
      renderLobby();
    });
  }

  async function shareLink(inv) {
    var text = 'Come play a hand of Convoy with me \u2014 heads-up, ' +
               inv.stake.toLocaleString() + ' chips: ' + inv.link;

    if (navigator.share) {
      try {
        await navigator.share({ title: 'Stay in Your Lane', text: text, url: inv.link });
        return;
      } catch (e) { /* dismissed */ }
    }

    try {
      await navigator.clipboard.writeText(inv.link);
      msg('Link copied.');
    } catch (e) {
      msg('Copy failed \u2014 long-press the code.', 'bad');
    }
  }

  function watchInvite(code) {
    stopPolling();
    timer = setInterval(async function () {
      try {
        var r = await api('/api/convoy/invite?code=' + encodeURIComponent(code));
        if (r.gameId) {
          gameId = r.gameId;
          startPolling();
        } else if (r.expired) {
          stopPolling();
          renderLobby('That invite expired.');
        }
      } catch (e) { /* keep waiting */ }
    }, POLL_MS);
  }

  async function redeemInvite(code) {
    msg('Joining\u2026');
    try {
      var r = await api('/api/convoy/invite', { method: 'POST', body: { code: code } });
      if (r.gameId) {
        gameId = r.gameId;
        startPolling();
      }
    } catch (e) {
      msg(friendly(e.message), 'bad');
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function join(stake) {
    msg('Looking for a table\u2026');
    try {
      var r = await api('/api/convoy/join', { method: 'POST', body: { stake: stake } });

      if (r.status === 'queued') {
        renderWaiting(stake);
        pollForMatch(stake);
      } else if (r.gameId) {
        gameId = r.gameId;
        startPolling();
      }
    } catch (e) {
      msg(friendly(e.message), 'bad');
    }
  }

  function friendly(code) {
    return ({
      insufficient_chips: 'Not enough chips for that stake.',
      no_profile: 'Your account isn\u2019t set up yet. Try signing out and back in.',
      not_signed_in: 'Sign in to play online.',
      bad_stake: 'That stake isn\u2019t available.',
      already_in_game: 'You\u2019re already at a table.',
      cannot_join_own_table: 'That\u2019s your own invite.',
      invite_already_used: 'Someone else took that seat.',
      invite_expired: 'That invite has expired.',
      unknown_code: 'No table with that code.',
      host_short_on_chips: 'The host is short on chips.',
    })[code] || code;
  }

  function renderWaiting(stake) {
    el().innerHTML =
      '<div class="cv-block">' +
        '<div class="cv-head"><b>Waiting for an opponent</b></div>' +
        '<p class="muted" style="font-size:12.5px;margin:8px 0">' +
          'Stake ' + stake.toLocaleString() + '. You\u2019ll drop in as soon as ' +
          'someone joins.</p>' +
        '<button class="mode-btn" id="coCancel">Leave the queue</button>' +
        '<p class="msg" id="coMsg"></p>' +
      '</div>';

    document.getElementById('coCancel').addEventListener('click', function () {
      stopPolling();
      renderLobby('Left the queue.');
    });
  }

  function pollForMatch(stake) {
    stopPolling();
    timer = setInterval(async function () {
      try {
        var r = await api('/api/convoy/join', { method: 'POST', body: { stake: stake } });
        if (r.gameId) {
          gameId = r.gameId;
          startPolling();
        }
      } catch (e) { /* keep waiting */ }
    }, POLL_MS);
  }

  // ------------------------------------------------------------------ table

  function startPolling() {
    stopPolling();
    refresh();
    timer = setInterval(refresh, POLL_MS);
  }

  function stopPolling() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  async function refresh() {
    if (busy || !gameId) return;
    try {
      state = await api('/api/convoy/state?gameId=' + gameId);
      renderTable();
    } catch (e) {
      msg('Connection trouble \u2014 retrying\u2026');
    }
  }

  function laneHTML(cards, idx, clickable) {
    var full = cards.length >= 5;
    return '<div class="cv-lane' + (clickable && !full ? ' sel' : '') + '"' +
             (clickable && !full ? ' data-lane="' + idx + '"' : '') + '>' +
             '<span class="cv-num">' + (idx + 1) + '</span>' +
             cards.map(function (c) { return cardHTML(c); }).join('') +
           '</div>';
  }

  function renderTable() {
    var s = state;
    if (!s || s.error) { renderLobby('That game has ended.'); return; }

    if (s.phase === 'done') { renderResult(s); return; }

    var mine = s.lanes || [], theirs = s.oppLanes || [];
    var secs = secondsLeft(s.deadline);
    var drawn = s.drawn;

    var html =
      '<div class="cv-block' + (s.yourTurn ? ' turn' : '') + '">' +
        '<div class="cv-head"><b>Pot ' + s.pot.toLocaleString() + '</b>' +
          '<span class="muted">' + s.pileLeft + ' left' +
          (secs !== null ? ' \u00b7 ' + secs + 's' : '') + '</span></div>';

    // opponent
    html += '<div class="muted" style="font-size:10px;letter-spacing:.08em;' +
            'text-transform:uppercase;margin:8px 0 4px">Opponent</div>';
    theirs.forEach(function (l, i) { html += laneHTML(l, i, false); });
    html += '<div class="cv-held">' +
              Array(s.oppHeldCount).fill(0).map(function () { return cardHTML(null); }).join('') +
            '</div>';

    // you
    html += '<div class="muted" style="font-size:10px;letter-spacing:.08em;' +
            'text-transform:uppercase;margin:12px 0 4px">You</div>';
    mine.forEach(function (l, i) {
      html += laneHTML(l, i, s.yourTurn && s.phase === 'building' && drawn !== null);
    });

    html += '<div class="cv-held" id="coHeld">' +
              (s.held || []).map(function (c, i) {
                var swappable = s.yourTurn && s.canSwap && drawn !== null &&
                                s.phase === 'building';
                return cardHTML(c, swappable ? 'sel" data-slot="' + i : '');
              }).join('') +
            '</div>';

    html += '<p class="msg" id="coMsg"></p>';

    // controls
    if (s.phase === 'checkpoint') {
      html += betControls(s);
    } else if (s.yourTurn) {
      html += drawn === null
        ? '<button class="mode-btn" id="coDraw">Draw a card</button>'
        : '<div class="cv-head" style="margin-top:8px"><span class="muted">Drawn</span>' +
          cardHTML(drawn) + '</div>' +
          '<p class="muted" style="font-size:12px;margin:6px 0 0">Tap a lane' +
          (s.canSwap ? ', or a held card to swap it in.' : '.') + '</p>';
    } else {
      html += '<p class="muted" style="font-size:12.5px;margin-top:8px">' +
              'Waiting for your opponent\u2026</p>';
    }

    html += '</div>';
    el().innerHTML = html;
    wire();
  }

  function betControls(s) {
    var owe = s.betting ? s.betting.youOwe : 0;
    if (!s.yourTurn) {
      return '<p class="muted" style="font-size:12.5px;margin-top:8px">' +
             'Checkpoint \u2014 waiting for your opponent.</p>';
    }
    return '<p style="font-size:12.5px;margin:8px 0 6px">Checkpoint \u2014 every ' +
           'lane is three deep.' + (owe > 0 ? ' You owe ' + owe.toLocaleString() + '.' : '') +
           '</p>' +
           '<div class="mode-row">' +
             '<button class="mode-btn" data-bet="' + (owe > 0 ? 'call' : 'check') + '">' +
               (owe > 0 ? 'Call ' + owe.toLocaleString() : 'Check') + '</button>' +
             (s.betting.raises < s.betting.maxRaises
               ? '<button class="mode-btn" data-bet="raise">Raise</button>' : '') +
             '<button class="mode-btn" data-bet="fold">Fold</button>' +
           '</div>';
  }

  function renderResult(s) {
    stopPolling();
    var r = s.result || {};
    var won = s.winner && s.winner === myId(s);
    var line = r.reason === 'push' ? 'Dead heat. Stakes returned.'
             : r.reason === 'fold' ? (won ? 'They folded. You take the pot.' : 'You folded.')
             : r.reason === 'timeout' ? (won ? 'They ran out of time.' : 'You ran out of time.')
             : (won ? 'You take it ' : 'You lose it ') + r.winsA + '\u2013' + r.winsB +
               (r.reason === 'total_strength' ? ' on total strength.' : '.');

    el().innerHTML =
      '<div class="cv-block">' +
        '<div class="cv-head"><b>' + (won ? 'Winner' : 'Game over') + '</b></div>' +
        '<p style="margin:8px 0 12px">' + line + '</p>' +
        '<div class="muted" style="font-size:10px;text-transform:uppercase;' +
          'letter-spacing:.08em;margin-bottom:4px">Their hand</div>' +
        '<div class="cv-held">' +
          (s.oppHeld || []).map(function (c) { return cardHTML(c); }).join('') +
        '</div>' +
        '<button class="mode-btn" id="coAgain" style="margin-top:12px">Play again</button>' +
      '</div>';

    document.getElementById('coAgain').addEventListener('click', function () {
      gameId = null; state = null;
      renderLobby();
    });
  }

  // The state payload doesn't name you, but yourTurn and winner are both
  // compared server-side. Cache your id from the session instead.
  var _myId = null;
  function myId() { return _myId; }

  function wire() {
    var d = document.getElementById('coDraw');
    if (d) d.addEventListener('click', function () { act({ action: 'draw' }); });

    Array.prototype.forEach.call(document.querySelectorAll('[data-lane]'), function (n) {
      n.addEventListener('click', function () {
        act({ action: 'place', lane: Number(n.dataset.lane) });
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-slot]'), function (n) {
      n.addEventListener('click', function () {
        act({ action: 'swap', slot: Number(n.dataset.slot) });
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-bet]'), function (n) {
      n.addEventListener('click', function () {
        act({ action: 'bet', bet: n.dataset.bet });
      });
    });
  }

  async function act(payload) {
    if (busy) return;
    busy = true;
    try {
      payload.gameId = gameId;
      var r = await api('/api/convoy/action', { method: 'POST', body: payload });
      if (r.state) { state = r.state; renderTable(); }
    } catch (e) {
      msg(friendly(e.message), 'bad');
    } finally {
      busy = false;
    }
  }

  // ----------------------------------------------------------------- public

  window.ConvoyOnline = {
    mount: async function () {
      try {
        var s = await window.sb.auth.getSession();
        _myId = s.data.session ? s.data.session.user.id : null;
      } catch (e) { _myId = null; }

      // Arrived from an invite link? Take the seat before anything else.
      var invited = null;
      try {
        invited = new URLSearchParams(location.search).get('table');
      } catch (e) {}

      if (invited) {
        try {
          var inv = await api('/api/convoy/invite', {
            method: 'POST', body: { code: invited },
          });
          if (inv.gameId) {
            gameId = inv.gameId;
            startPolling();
            return;
          }
        } catch (e) {
          renderLobby(friendly(e.message));
          return;
        }
      }

      // Already at a table? Drop straight back in.
      try {
        var r = await api('/api/convoy/join', { method: 'POST', body: { stake: STAKES[0] } });
        if (r.status === 'rejoined' && r.gameId) {
          gameId = r.gameId;
          startPolling();
          return;
        }
        if (r.status === 'queued') {
          renderWaiting(STAKES[0]);
          pollForMatch(STAKES[0]);
          return;
        }
        if (r.gameId) { gameId = r.gameId; startPolling(); return; }
      } catch (e) { /* fall through to the lobby */ }

      renderLobby();
    },
    unmount: function () { stopPolling(); el().innerHTML = ''; },
  };
})();
