/*
 * Stay in Your Lane — avatar roster
 * ----------------------------------
 * Drop-in. Loads before sidebar.js and convoy-online.js.
 *
 *   <script src="avatars.js"></script>
 *
 * The roster is data, not code: to add more portraits, drop av5-128.webp,
 * av5-48.webp and av5-128.png into the site root and raise COUNT. Nothing
 * else changes, and set_avatar already accepts preset:0 through preset:11.
 *
 * Two sizes on purpose. 128px for the picker and profile header, 48px for
 * seat badges at the table — shipping a 128px portrait for a 40px badge
 * wastes bytes on every seat of every hand.
 */
(function () {
  'use strict';

  var COUNT = 5;
  var webp = null;

  function supportsWebp() {
    if (webp !== null) return webp;
    try {
      var c = document.createElement('canvas');
      webp = c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) { webp = false; }
    return webp;
  }

  function src(idx, size) {
    idx = Math.max(0, Math.min(COUNT - 1, Number(idx) || 0));
    if (size <= 64 && supportsWebp()) return './av' + idx + '-48.webp';
    return supportsWebp() ? './av' + idx + '-128.webp' : './av' + idx + '-128.png';
  }

  /* Falls back to a coloured initial for players who haven't picked one, and
     for uploaded avatars that fail to load. */
  var FALLBACK = ['#8a9299','#7ee08a','#4bb8e8','#c58bf0','#f5c518',
                  '#f0a04b','#e8674b','#ff4d4d'];

  function initial(name, size, seedIdx) {
    var ch = String(name || '?').charAt(0).toUpperCase();
    var col = FALLBACK[(seedIdx || 0) % FALLBACK.length];
    return '<div class="av-fallback" style="width:' + size + 'px;height:' + size +
           'px;border-radius:50%;background:' + col + ';color:#111;display:flex;' +
           'align-items:center;justify-content:center;font-weight:700;' +
           'font-size:' + Math.round(size * 0.42) + 'px;flex:0 0 auto">' + ch + '</div>';
  }

  /**
   * html(avatar, size, name) -> markup for any avatar value.
   *   'preset:3'          a roster portrait
   *   '<uuid>/avatar'     an upload in Supabase Storage
   *   null                a coloured initial
   */
  function html(avatar, size, name, seedIdx) {
    size = size || 44;

    if (typeof avatar === 'string' && avatar.indexOf('preset:') === 0) {
      return '<img class="av-img" src="' + src(avatar.slice(7), size) + '" width="' +
             size + '" height="' + size + '" alt="" loading="lazy" ' +
             'style="border-radius:50%;flex:0 0 auto;display:block">';
    }

    if (typeof avatar === 'string' && avatar && window.SB_URL) {
      return '<img class="av-img" src="' + window.SB_URL +
             '/storage/v1/object/public/avatars/' + avatar + '" width="' + size +
             '" height="' + size + '" alt="" loading="lazy" ' +
             'style="border-radius:50%;object-fit:cover;flex:0 0 auto;display:block" ' +
             'onerror="this.style.display=\'none\'">';
    }

    return initial(name, size, seedIdx);
  }

  window.Avatars = {
    count: COUNT,
    src: src,
    html: html,
    ids: (function () {
      var out = [];
      for (var i = 0; i < COUNT; i++) out.push('preset:' + i);
      return out;
    })(),
  };
})();
