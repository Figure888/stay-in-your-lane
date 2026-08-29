/*
 * Stay in Your Lane — Convoy online
 * ----------------------------------
 * Drop-in. Requires chips-server.js (window.sb) and must load AFTER the
 * inline game script in index.html, because it borrows that renderer.
 *
 * The important design choice: online mode does NOT have its own board. It
 * builds a CV-shaped object from server state and calls your existing
 * cvRender(), so the two modes are identical by construction rather than by
 * imitation — empty slots, 1/5 counters, SWAP OPEN, pips, result colouring,
 * card markup, all of it. Style the offline board and the online one follows.
 *
 * The four action handlers are wrapped rather than edited: top-level function
 * declarations live on window, so reassigning them redirects the clicks
 * cvBlock already wired up. Nothing in index.html's logic needs changing.
 */
(function () {
  'use strict';

  var STAKES = [100, 250, 500];
  var POLL_MS = 2000;

  var online = false, gameId = null, state = null, busy = false;
  var timer = null, tick = null, deadline = null;
  var offlineCV = null;          // stashed while online, restored on exit
  var orig = {};                 // the handlers we wrap

  function $(id) { return document.getElementById(id); }
  function card(c) { return { r: c >> 2, s: c & 3 }; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch];
    });
  }

  // ------------------------------------------------------------------- api

  async function token() {
    var s = await window.sb.auth.getSession();
    if (!s.data.session) throw new Error('not_signed_in');
    return s.data.session.access_token;
  }

  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json',
                 Authorization: 'Bearer ' + (await token()) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || data.message || 'HTTP ' + res.status);
    return data;
  }

  function friendly(code) {
    return ({
      insufficient_chips: 'Not enough chips for that stake.',
      no_profile: 'Your account isn\u2019t set up yet.',
      not_signed_in: 'Sign in to play online.',
      already_in_game: 'You\u2019re already at a table.',
      cannot_join_own_table: 'That\u2019s your own invite.',
      invite_already_used: 'Someone else took that seat.',
      invite_expired: 'That invite has expired.',
      unknown_code: 'No table with that code.',
      host_short_on_chips: 'The host is short on chips.',
      not_your_turn: 'Not your turn.',
      rate_limited: 'Slow down a moment.',
    })[code] || code;
  }

  // ------------------------------------------------- server state -> CV

  /* cvBlock reads p.held for the opponent and renders backs when the game is
     live, so the array only needs the right length — never real cards. */
  function hiddenHand(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push({ r: 0, s: 0 });
    return out;
  }

  function toCV(s) {
    var mine = (s.lanes || []).map(function (l) { return l.map(card); });
    var theirs = (s.oppLanes || []).map(function (l) { return l.map(card); });
    while (mine.length < 4) mine.push([]);
    while (theirs.length < 4) theirs.push([]);

    var over = s.phase === 'done';
    var myHeld = (s.held || []).map(card);
    var oppHeld = over && s.oppHeld ? s.oppHeld.map(card) : hiddenHand(s.oppHeldCount || 5);

    var cv = {
      P: [
        { name: 'You', lanes: mine, held: myHeld, disc: !s.canSwap },
        { name: s.oppName || 'Opponent', lanes: theirs, held: oppHeld, disc: false },
      ],
      bank: 0,                      // filled from the account balance
      pot: s.pot || 0,
      stake: s.stake || STAKES[0],
      paid: [s.stake || 0, s.stake || 0],
      turn: s.yourTurn ? 0 : 1,
      drawn: (s.drawn === null || s.drawn === undefined) ? null : card(s.drawn),
      deck: { length: s.pileLeft || 0 },
      live: !over,
      over: over,
      swapping: false,
      result: null,
      bet: null,
      betDone: false,
      foldedBy: -1,
    };

    if (s.phase === 'checkpoint' && s.betting) {
      var owe = s.betting.youOwe || 0;
      cv.bet = {
        turn: s.yourTurn ? 0 : 1,
        committed: [0, owe],        // cvRender only reads the difference
        raises: s.betting.raises || 0,
        acted: [false, false],
      };
    }

    // Scores come back in the server's encoding, which catOf() doesn't speak.
    // Everything is revealed at this point, so re-score locally instead.
    if (over && window.score5) {
      cv.result = [0, 1, 2, 3, 4].map(function (L) {
        var a = L < 4 ? cv.P[0].lanes[L] : cv.P[0].held;
        var b = L < 4 ? cv.P[1].lanes[L] : cv.P[1].held;
        var av = a.length >= 5 ? window.score5(a.slice(0, 5)) : -1;
        var bv = b.length >= 5 ? window.score5(b.slice(0, 5)) : -1;
        return { av: av, bv: bv, r: av > bv ? 0 : (bv > av ? 1 : -1) };
      });
    }

    return cv;
  }

  function paint(s) {
    state = s;
    deadline = s.deadline;

    var cv = toCV(s);
    cv.bank = (window.Chips && window.Chips.getBalance) ? window.Chips.getBalance() : 0;
    window.CV = cv;
    window.cvRender();

    // The header's Deal button and stake picker mean nothing online.
    var act = $('cvAction');
    if (act) {
      if (s.phase === 'done') { act.textContent = 'Play again'; act.disabled = false; }
      else if (!s.yourTurn)   { act.textContent = 'Waiting\u2026'; act.disabled = true; }
      else if (s.drawn !== null && s.drawn !== undefined) {
        act.textContent = 'Pick lane'; act.disabled = true;
      } else { act.textContent = 'Draw'; act.disabled = false; }
    }

    var stakes = $('cvStakes');
    if (stakes) stakes.style.display = 'none';

    if (s.phase !== 'done') {
      var left = deadline ? Math.max(0, Math.round((new Date(deadline) - Date.now()) / 1000)) : null;
      window.cvMsg(s.yourTurn
        ? 'Your turn' + (left !== null ? ' \u2014 ' + left + 's' : '')
        : (s.oppName || 'Opponent') + ' is thinking\u2026');
    } else {
      var r = s.result || {};
      var won = s.winner && s.youAre &&
                ((s.youAre === 'a' && r.winsA > r.winsB) || (s.youAre === 'b' && r.winsB > r.winsA));
      window.cvMsg(
        r.reason === 'push' ? 'Dead heat. Stakes returned.'
        : r.reason === 'fold' ? (won ? 'They folded. You take the pot.' : 'You folded.')
        : r.reason === 'timeout' ? (won ? 'They ran out of time.' : 'You ran out of time.')
        : (won ? 'You take it ' : 'You lose it ') + r.winsA + '\u2013' + r.winsB +
          (r.reason === 'total_strength' ? ' on total strength.' : '.'),
        won ? 'win' : '');
      if (window.Chips && window.Chips.syncBalance) window.Chips.syncBalance();
    }
  }

  // -------------------------------------------------------------- actions

  async function send(payload) {
    if (busy || !gameId) return;
    busy = true;
    try {
      payload.gameId = gameId;
      var r = await api('/api/convoy/action', { method: 'POST', body: payload });
      if (r.state) paint(r.state);
    } catch (e) {
      window.cvMsg(friendly(e.message));
    } finally { busy = false; }
  }

  /* Wrap rather than edit: top-level declarations live on window, so the
     handlers cvBlock already bound resolve through these. */
  function wrap() {
    ['cvDraw', 'cvPlace', 'cvSwapInto', 'cvBetAct', 'cvNew'].forEach(function (n) {
      if (!orig[n]) orig[n] = window[n];
    });

    window.cvDraw = function () {
      if (!online) return orig.cvDraw.apply(null, arguments);
      if (state && state.phase === 'done') return rejoin();
      send({ action: 'draw' });
    };

    window.cvPlace = function (L) {
      if (!online) return orig.cvPlace.apply(null, arguments);
      if (!window.CV || !window.CV.drawn) return;
      send({ action: 'place', lane: L });
    };

    window.cvSwapInto = function (k) {
      if (!online) return orig.cvSwapInto.apply(null, arguments);
      send({ action: 'swap', slot: k });
    };

    window.cvBetAct = function (side, type) {
      if (!online) return orig.cvBetAct.apply(null, arguments);
      send({ action: 'bet', bet: type === 'raise' ? 'raise'
                            : type === 'fold' ? 'fold'
                            : (state && state.betting && state.betting.youOwe > 0 ? 'call' : 'check') });
    };

    window.cvNew = function () {
      if (!online) return orig.cvNew.apply(null, arguments);
      rejoin();
    };
  }

  // --------------------------------------------------------------- polling

  function startPolling() {
    stopPolling();
    showTable();
    refresh();
    timer = setInterval(refresh, POLL_MS);
    tick = setInterval(function () {
      if (!state || state.phase === 'done' || !state.yourTurn || !deadline) return;
      var left = Math.max(0, Math.round((new Date(deadline) - Date.now()) / 1000));
      window.cvMsg('Your turn \u2014 ' + left + 's');
    }, 1000);
  }

  function stopPolling() {
    if (timer) { clearInterval(timer); timer = null; }
    if (tick) { clearInterval(tick); tick = null; }
  }

  async function refresh() {
    if (busy || !gameId) return;
    try { paint(await api('/api/convoy/state?gameId=' + gameId)); }
    catch (e) { /* transient — the next poll retries */ }
  }

  // ----------------------------------------------------------------- lobby

  function showLobby(note) {
    stopPolling();
    $('convoyView').style.display = 'none';
    var box = $('convoyOnline');
    box.style.display = '';
    box.innerHTML =
      '<div class="cv-block" style="margin-top:12px">' +
        '<div class="cv-head"><div><div class="stage" style="font-size:14px">Online</div>' +
        '<div class="sub" style="margin-top:3px">Heads-up against another player</div></div></div>' +
        '<div class="mode-row" id="coStakes" style="margin-top:12px">' +
          STAKES.map(function (s) {
            return '<button class="mode-btn" data-stake="' + s + '">' + s + '</button>';
          }).join('') +
        '</div>' +
        '<div class="msg" id="coMsg" style="margin-top:10px">' + (note || 'Pick a stake.') + '</div>' +
        '<div style="border-top:1px solid var(--edge);margin-top:14px;padding-top:12px">' +
          '<button class="chipbtn" id="coPrivate" style="width:100%;padding:11px">Open a private table</button>' +
          '<div class="mode-row" style="margin-top:6px">' +
            '<input id="coCode" placeholder="Have a code?" maxlength="6" ' +
              'style="flex:2;min-width:0;padding:10px;border-radius:4px;border:1px solid var(--edge);' +
              'background:#0d1012;color:inherit;text-transform:uppercase;text-align:center;' +
              'letter-spacing:.12em">' +
            '<button class="chipbtn" id="coJoin" style="flex:1">Join</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    Array.prototype.forEach.call(box.querySelectorAll('#coStakes .mode-btn'), function (b) {
      b.addEventListener('click', function () { join(Number(b.dataset.stake)); });
    });
    $('coPrivate').addEventListener('click', function () { createInvite(STAKES[0]); });
    $('coJoin').addEventListener('click', function () {
      var v = $('coCode').value.trim();
      if (v) redeem(v);
    });
  }

  function note(t) { var n = $('coMsg'); if (n) n.textContent = t; }

  function showTable() {
    $('convoyOnline').style.display = 'none';
    $('convoyView').style.display = '';
  }

  async function join(stake) {
    note('Looking for a table\u2026');
    try {
      var r = await api('/api/convoy/join', { method: 'POST', body: { stake: stake } });
      if (r.gameId) { gameId = r.gameId; startPolling(); }
      else { note('Waiting for an opponent\u2026'); waitForMatch(stake); }
    } catch (e) { note(friendly(e.message)); }
  }

  function waitForMatch(stake) {
    stopPolling();
    timer = setInterval(async function () {
      try {
        var r = await api('/api/convoy/join', { method: 'POST', body: { stake: stake } });
        if (r.gameId) { gameId = r.gameId; startPolling(); }
      } catch (e) {}
    }, POLL_MS);
  }

  async function createInvite(stake) {
    note('Opening a table\u2026');
    try {
      var inv = await api('/api/convoy/invite', { method: 'POST', body: { stake: stake } });
      showLobby('');
      $('coMsg').innerHTML = 'Code <b style="letter-spacing:.2em">' + esc(inv.code) +
        '</b> \u2014 <a href="#" id="coShare" style="color:var(--paint)">share the link</a>';
      $('coShare').addEventListener('click', function (e) {
        e.preventDefault();
        var text = 'Play a hand of Convoy with me: ' + inv.link;
        if (navigator.share) navigator.share({ text: text, url: inv.link }).catch(function () {});
        else navigator.clipboard.writeText(inv.link).then(function () { note('Link copied.'); });
      });
      watchInvite(inv.code);
    } catch (e) { note(friendly(e.message)); }
  }

  function watchInvite(code) {
    stopPolling();
    timer = setInterval(async function () {
      try {
        var r = await api('/api/convoy/invite?code=' + encodeURIComponent(code));
        if (r.gameId) { gameId = r.gameId; startPolling(); }
        else if (r.expired) { stopPolling(); showLobby('That invite expired.'); }
      } catch (e) {}
    }, POLL_MS);
  }

  async function redeem(code) {
    note('Joining\u2026');
    try {
      var r = await api('/api/convoy/invite', { method: 'POST', body: { code: code } });
      if (r.gameId) { gameId = r.gameId; startPolling(); }
    } catch (e) { note(friendly(e.message)); }
  }

  function rejoin() { gameId = null; state = null; showLobby(); }

  // ---------------------------------------------------------------- public

  window.ConvoyOnline = {
    mount: async function () {
      wrap();
      online = true;
      if (!offlineCV) offlineCV = window.CV;   // keep the offline game intact

      var invited = null;
      try { invited = new URLSearchParams(location.search).get('table'); } catch (e) {}

      if (invited) {
        try {
          var inv = await api('/api/convoy/invite', { method: 'POST', body: { code: invited } });
          if (inv.gameId) { gameId = inv.gameId; startPolling(); return; }
        } catch (e) { showLobby(friendly(e.message)); return; }
      }

      try {
        var r = await api('/api/convoy/join', { method: 'POST', body: { stake: STAKES[0] } });
        if (r.status === 'rejoined' && r.gameId) { gameId = r.gameId; startPolling(); return; }
        if (r.gameId) { gameId = r.gameId; startPolling(); return; }
      } catch (e) {}

      showLobby();
    },

    unmount: function () {
      stopPolling();
      online = false;
      gameId = null;
      state = null;
      $('convoyView').style.display = 'none';
      var stakes = $('cvStakes');
      if (stakes) stakes.style.display = '';
      if (offlineCV) { window.CV = offlineCV; offlineCV = null; window.cvRender(); }
    },
  };
})();
