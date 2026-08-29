/*
 * Stay in Your Lane — sidebar (account + settings)
 * -------------------------------------------------
 * Drop-in, same shape as age-gate.js and chip-store.js. Injects its own
 * styles and markup. Vanilla JS, no build step.
 *
 * Requires chips-server.js loaded first (it creates window.sb).
 *
 *   <script src="sidebar.js"></script>
 *
 * Adds a hamburger button top-left. Exposes window.Sidebar.open() / .close().
 */
(function () {
  'use strict';

  var STYLE_ID = 'siyl-sidebar-styles';
  var open = false, tab = 'account', account = null, busy = false;

  // Twelve generated avatars — deterministic SVG, no upload, no moderation,
  // no storage cost. This is the default path; uploads are the exception.
  var PRESET_COLORS = [
    ['#f5c518','#7a5c00'], ['#4bb8e8','#0f4a63'], ['#e8674b','#6b2314'],
    ['#7ee08a','#1f5c2a'], ['#c58bf0','#4a2266'], ['#f08bb4','#6b2543'],
    ['#8be0d8','#1f5b56'], ['#e8a14b','#6b4414'], ['#9aa7f0','#2a3266'],
    ['#d8e04b','#5c6114'], ['#f06b6b','#661f1f'], ['#6be0b4','#1f6650'],
  ];

  function presetSVG(i, size) {
    var c = PRESET_COLORS[i % PRESET_COLORS.length];
    size = size || 40;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 40 40">' +
      '<defs><linearGradient id="g' + i + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + c[0] + '"/>' +
      '<stop offset="1" stop-color="' + c[1] + '"/></linearGradient></defs>' +
      '<rect width="40" height="40" rx="9" fill="url(#g' + i + ')"/>' +
      '<path d="M8 ' + (14 + (i % 5) * 3) + 'h24M8 ' + (26 - (i % 4) * 3) + 'h24" ' +
      'stroke="rgba(0,0,0,.28)" stroke-width="3" stroke-linecap="round"/>' +
      '</svg>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  function avatarHTML(val, size) {
    size = size || 40;
    if (val && val.indexOf('preset:') === 0) {
      return presetSVG(Number(val.slice(7)) || 0, size);
    }
    if (val && window.SB_URL) {
      var url = window.SB_URL + '/storage/v1/object/public/avatars/' +
                val + '?v=' + Date.now();
      return '<img src="' + esc(url) + '" width="' + size + '" height="' + size +
             '" style="border-radius:9px;object-fit:cover" alt="">';
    }
    return presetSVG(0, size);
  }

  // ------------------------------------------------------------------ setup

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '#sbToggle{position:fixed;top:10px;left:10px;z-index:9998;width:40px;height:40px;',
      'border-radius:8px;border:1px solid var(--edge,#333);background:rgba(12,14,16,.88);',
      'color:inherit;display:flex;align-items:center;justify-content:center;cursor:pointer}',
      '#sbToggle span{display:block;width:17px;height:2px;background:currentColor;',
      'box-shadow:0 -5px 0 currentColor,0 5px 0 currentColor}',
      '#sbScrim{position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.55);',
      'opacity:0;pointer-events:none;transition:opacity .18s}',
      '#sbScrim.on{opacity:1;pointer-events:auto}',
      '#sbPanel{position:fixed;top:0;left:0;bottom:0;z-index:9999;width:min(310px,86vw);',
      'background:linear-gradient(180deg,#191d1f,#111416);border-right:1px solid var(--edge,#333);',
      'transform:translateX(-102%);transition:transform .2s ease;overflow-y:auto;',
      'padding:16px 16px calc(16px + env(safe-area-inset-bottom));',
      'padding-top:calc(16px + env(safe-area-inset-top))}',
      '#sbPanel.on{transform:none}',
      '.sb-tabs{display:flex;gap:6px;margin:14px 0 16px}',
      '.sb-tab{flex:1;padding:9px;border-radius:4px;border:1px solid var(--edge,#333);',
      'background:transparent;color:inherit;font-size:12px;letter-spacing:.06em;',
      'text-transform:uppercase;cursor:pointer;min-height:40px}',
      '.sb-tab.on{border-color:var(--paint,#f5c518);color:var(--paint,#f5c518)}',
      '.sb-me{display:flex;align-items:center;gap:11px;margin-bottom:6px}',
      '.sb-me b{font-size:15px;display:block}',
      '.sb-me small{opacity:.6;font-size:11.5px}',
      '.sb-field{margin:14px 0}',
      '.sb-field label{display:block;font-size:10.5px;letter-spacing:.08em;',
      'text-transform:uppercase;opacity:.6;margin-bottom:5px}',
      '.sb-field input{width:100%;padding:11px;border-radius:5px;box-sizing:border-box;',
      'border:1px solid var(--edge,#333);background:#0d1012;color:inherit;font-size:15px}',
      '.sb-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:7px}',
      '.sb-grid button{padding:3px;border-radius:9px;border:2px solid transparent;',
      'background:transparent;cursor:pointer;line-height:0}',
      '.sb-grid button.on{border-color:var(--paint,#f5c518)}',
      '.sb-btn{width:100%;padding:12px;border-radius:5px;border:0;font-size:14px;',
      'font-weight:600;cursor:pointer;min-height:46px;margin-top:8px;',
      'background:var(--paint,#f5c518);color:#111}',
      '.sb-btn.ghost{background:transparent;color:inherit;',
      'border:1px solid var(--edge,#333);font-weight:500}',
      '.sb-stat{display:flex;justify-content:space-between;padding:8px 0;',
      'border-bottom:1px solid rgba(255,255,255,.06);font-size:13px}',
      '.sb-stat span:first-child{opacity:.6}',
      '.sb-note{font-size:11.5px;opacity:.65;margin-top:7px;line-height:1.45}',
      '.sb-note.bad{color:#ff8f8f;opacity:1}',
      '.sb-note.good{color:#7ee08a;opacity:1}',
    ].join('');
    document.head.appendChild(s);
  }

  function build() {
    injectStyles();

    var btn = document.createElement('button');
    btn.id = 'sbToggle';
    btn.setAttribute('aria-label', 'Menu');
    btn.innerHTML = '<span></span>';
    btn.addEventListener('click', function () { open ? close() : show(); });
    document.body.appendChild(btn);

    var scrim = document.createElement('div');
    scrim.id = 'sbScrim';
    scrim.addEventListener('click', close);
    document.body.appendChild(scrim);

    var panel = document.createElement('div');
    panel.id = 'sbPanel';
    document.body.appendChild(panel);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) close();
    });
  }

  // ------------------------------------------------------------------- data

  async function token() {
    var s = await window.sb.auth.getSession();
    if (!s.data.session) throw new Error('not signed in');
    return s.data.session.access_token;
  }

  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (await token()),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok && !data.message) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  // ----------------------------------------------------------------- render

  function render() {
    var p = document.getElementById('sbPanel');
    if (!p) return;

    if (!account) { p.innerHTML = '<p class="sb-note">Loading\u2026</p>'; return; }

    p.innerHTML =
      '<div class="sb-me">' + avatarHTML(account.avatar, 44) +
        '<div><b>' + esc(account.displayName || 'Player') + '</b>' +
        '<small>' + Number(account.chips || 0).toLocaleString() + ' chips</small></div>' +
      '</div>' +
      '<div class="sb-tabs">' +
        '<button class="sb-tab' + (tab === 'account' ? ' on' : '') + '" data-tab="account">Account</button>' +
        '<button class="sb-tab' + (tab === 'settings' ? ' on' : '') + '" data-tab="settings">Settings</button>' +
      '</div>' +
      (tab === 'account' ? accountTab() : settingsTab());

    Array.prototype.forEach.call(p.querySelectorAll('[data-tab]'), function (b) {
      b.addEventListener('click', function () { tab = b.dataset.tab; render(); });
    });

    if (tab === 'account') wireAccount();
    else wireSettings();
  }

  function accountTab() {
    var sel = account.avatar || 'preset:0';
    return '' +
      '<div class="sb-field">' +
        '<label for="sbName">Username</label>' +
        '<input id="sbName" maxlength="16" autocapitalize="none" autocorrect="off" ' +
          'spellcheck="false" value="' + esc(account.username || '') + '" ' +
          'placeholder="3\u201316 characters">' +
        '<p class="sb-note" id="sbNameNote">' +
          (account.needsSetup
            ? 'Pick a name \u2014 this is what opponents see.'
            : 'Letters, numbers and underscores.') + '</p>' +
        '<button class="sb-btn" id="sbSaveName">Save name</button>' +
      '</div>' +
      '<div class="sb-field">' +
        '<label>Avatar</label>' +
        '<div class="sb-grid" id="sbAvatars">' +
          PRESET_COLORS.map(function (_, i) {
            var v = 'preset:' + i;
            return '<button data-avatar="' + v + '"' +
                   (sel === v ? ' class="on"' : '') + '>' + presetSVG(i, 46) + '</button>';
          }).join('') +
        '</div>' +
        '<button class="sb-btn ghost" id="sbUpload">Upload a picture</button>' +
        '<input type="file" id="sbFile" accept="image/jpeg,image/png,image/webp" hidden>' +
        '<p class="sb-note" id="sbAvatarNote"></p>' +
      '</div>' +
      '<div class="sb-field">' +
        '<label>Record</label>' +
        '<div class="sb-stat"><span>Games</span><span>' + (account.games || 0) + '</span></div>' +
        '<div class="sb-stat"><span>Wins</span><span>' + (account.wins || 0) + '</span></div>' +
        '<div class="sb-stat"><span>Hands played</span><span>' +
          (account.handsPlayed || 0) + '</span></div>' +
      '</div>';
  }

  function settingsTab() {
    return '' +
      '<div class="sb-field">' +
        '<label>Sound</label>' +
        '<button class="sb-btn ghost" id="sbSound">' +
          (localStorage.getItem('siyl.sound') === 'off' ? 'Off' : 'On') + '</button>' +
      '</div>' +
      '<div class="sb-field">' +
        '<label>Account</label>' +
        '<button class="sb-btn ghost" id="sbSignOut">Sign out</button>' +
      '</div>' +
      '<div class="sb-field">' +
        '<label>About</label>' +
        '<p class="sb-note">Play money only. No real-money gambling, ' +
          'no prizes of any value. 18+.</p>' +
        '<p class="sb-note"><a href="./privacy.html" style="color:inherit">Privacy</a> ' +
          '\u00b7 <a href="./terms.html" style="color:inherit">Terms</a></p>' +
      '</div>';
  }

  // ------------------------------------------------------------------ wiring

  function note(id, text, cls) {
    var n = document.getElementById(id);
    if (n) { n.textContent = text; n.className = 'sb-note' + (cls ? ' ' + cls : ''); }
  }

  function wireAccount() {
    document.getElementById('sbSaveName').addEventListener('click', async function () {
      if (busy) return;
      busy = true;
      var v = document.getElementById('sbName').value.trim();
      try {
        var r = await api('/api/account', { method: 'POST', body: { username: v } });
        if (r.ok) {
          account.username = r.username;
          account.displayName = r.username;
          account.needsSetup = false;
          note('sbNameNote', 'Saved.', 'good');
          render();
        } else {
          note('sbNameNote', r.message || 'Could not save that name.', 'bad');
        }
      } catch (e) {
        note('sbNameNote', 'Could not reach the server.', 'bad');
      } finally { busy = false; }
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-avatar]'), function (b) {
      b.addEventListener('click', function () { saveAvatar(b.dataset.avatar); });
    });

    var file = document.getElementById('sbFile');
    document.getElementById('sbUpload').addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      if (file.files && file.files[0]) upload(file.files[0]);
    });
  }

  async function saveAvatar(v) {
    try {
      var r = await api('/api/account', { method: 'POST', body: { avatar: v } });
      if (r.ok) { account.avatar = r.avatar; render(); }
      else note('sbAvatarNote', 'Could not save that.', 'bad');
    } catch (e) {
      note('sbAvatarNote', 'Could not reach the server.', 'bad');
    }
  }

  /* Straight to Supabase Storage. Sending image bytes through a serverless
     function would be slower and buy nothing — RLS keeps each player inside
     a folder named after their own id. */
  async function upload(f) {
    if (f.size > 2 * 1024 * 1024) {
      return note('sbAvatarNote', 'Under 2 MB, please.', 'bad');
    }

    note('sbAvatarNote', 'Uploading\u2026');
    try {
      var s = await window.sb.auth.getSession();
      var uid = s.data.session.user.id;
      var path = uid + '/avatar';

      var up = await window.sb.storage.from('avatars')
        .upload(path, f, { upsert: true, contentType: f.type });

      if (up.error) throw up.error;

      await saveAvatar(path);
      note('sbAvatarNote', 'Picture updated.', 'good');
    } catch (e) {
      note('sbAvatarNote', 'Upload failed. Try a smaller image.', 'bad');
    }
  }

  function wireSettings() {
    document.getElementById('sbSound').addEventListener('click', function (e) {
      var off = localStorage.getItem('siyl.sound') === 'off';
      localStorage.setItem('siyl.sound', off ? 'on' : 'off');
      e.target.textContent = off ? 'On' : 'Off';
    });

    document.getElementById('sbSignOut').addEventListener('click', function () {
      if (window.Chips && window.Chips.signOut) window.Chips.signOut();
      else window.sb.auth.signOut().then(function () { location.href = './login.html'; });
    });
  }

  // ------------------------------------------------------------------ public

  async function show() {
    open = true;
    document.getElementById('sbPanel').classList.add('on');
    document.getElementById('sbScrim').classList.add('on');
    render();

    try {
      account = await api('/api/account');
      render();
    } catch (e) {
      document.getElementById('sbPanel').innerHTML =
        '<p class="sb-note bad">Could not load your account. Are you signed in?</p>';
    }
  }

  function close() {
    open = false;
    document.getElementById('sbPanel').classList.remove('on');
    document.getElementById('sbScrim').classList.remove('on');
  }

  function start() {
    if (!window.sb) { console.error('sidebar.js needs chips-server.js first'); return; }
    if (!window.SB_URL) {
      // avatarHTML needs the project URL to build public image links.
      console.warn('window.SB_URL not set — uploaded avatars will not render');
    }
    build();
  }

  window.Sidebar = { open: show, close: close, refresh: function () { account = null; show(); } };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else { start(); }
})();
