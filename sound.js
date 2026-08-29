/*
 * Stay in Your Lane — sound
 * --------------------------
 * Drop-in, no audio files. Every sound is synthesised with the Web Audio API
 * at play time.
 *
 *   <script src="sound.js"></script>
 *
 * Why synthesis rather than samples: a set of decent card and chip samples is
 * 300–800 KB, needs licensing you'd have to keep records of, and has to be
 * precached by the service worker or it won't play offline. This is about
 * 9 KB of code, weighs nothing, and there's nobody to license from.
 *
 * Respects the sidebar's sound toggle (localStorage 'siyl.sound').
 *
 * SFX.play('deal'|'flip'|'chip'|'pot'|'tap'|'turn'|'win'|'lose'|'fold'|
 *          'gift'|'tick'|'raise'|'check'|'shuffle')
 */
(function () {
  'use strict';

  var ctx = null, master = null, unlocked = false;

  function on() {
    try { return localStorage.getItem('siyl.sound') !== 'off'; }
    catch (e) { return true; }
  }

  /* Mobile browsers refuse to start an AudioContext without a user gesture,
     so the first tap anywhere creates it. Until then every call is a no-op. */
  function unlock() {
    if (unlocked) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.32;          // headroom; individual sounds set their own
      master.connect(ctx.destination);
      if (ctx.state === 'suspended') ctx.resume();
      unlocked = true;
    } catch (e) { /* no audio available — silently do nothing */ }
  }

  function now() { return ctx.currentTime; }

  // --- building blocks -----------------------------------------------------

  function env(node, t0, peak, attack, decay) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    node.connect(g);
    g.connect(master);
    return g;
  }

  function tone(freq, t0, peak, attack, decay, type) {
    var o = ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    env(o, t0, peak, attack, decay);
    o.start(t0);
    o.stop(t0 + attack + decay + 0.02);
    return o;
  }

  function sweep(from, to, t0, peak, dur, type) {
    var o = ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(from, t0);
    o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    env(o, t0, peak, 0.006, dur);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  /* Filtered white noise. This is what makes cards sound like cards — a card
     is mostly a broadband scrape, not a pitch. */
  function noise(t0, peak, dur, cutoff, q, sweepTo) {
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    var src = ctx.createBufferSource();
    src.buffer = buf;

    var f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(cutoff, t0);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    f.Q.value = q || 1;

    src.connect(f);
    env(f, t0, peak, 0.004, dur);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  // --- the kit -------------------------------------------------------------

  var KIT = {
    // A card leaving the deck: short broadband scrape sweeping down.
    deal: function (t) { noise(t, 0.30, 0.085, 2600, 1.1, 900); },

    // Turning one over: two scrapes, the second brighter.
    flip: function (t) {
      noise(t, 0.24, 0.055, 1800, 1.3, 700);
      noise(t + 0.055, 0.20, 0.06, 3200, 1.6, 1400);
    },

    // Clay chips have a dull knock plus a bit of ring.
    chip: function (t) {
      noise(t, 0.22, 0.03, 3800, 3.2);
      tone(760 + Math.random() * 90, t, 0.13, 0.003, 0.055, 'triangle');
    },

    // Several chips landing, slightly uneven so it isn't a machine gun.
    pot: function (t) {
      for (var i = 0; i < 5; i++) {
        var d = t + i * (0.038 + Math.random() * 0.02);
        noise(d, 0.17, 0.028, 3400 + Math.random() * 900, 3);
        tone(700 + Math.random() * 160, d, 0.10, 0.003, 0.05, 'triangle');
      }
    },

    tap:   function (t) { tone(1180, t, 0.10, 0.002, 0.035, 'square'); },
    check: function (t) { noise(t, 0.16, 0.045, 900, 2.2); },
    fold:  function (t) { sweep(340, 120, t, 0.16, 0.16, 'sine');
                          noise(t, 0.14, 0.09, 600, 1.4, 260); },

    // Your move: a soft two-note prompt, not an alarm.
    turn:  function (t) { tone(880, t, 0.13, 0.01, 0.11, 'sine');
                          tone(1320, t + 0.09, 0.11, 0.01, 0.14, 'sine'); },

    // Clock running down. Deliberately dry and quiet.
    tick:  function (t) { tone(1500, t, 0.055, 0.001, 0.028, 'square'); },

    raise: function (t) { sweep(420, 900, t, 0.15, 0.13, 'sawtooth');
                          KIT.chip(t + 0.05); },

    // Rising major arpeggio.
    win:   function (t) {
      [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
        tone(f, t + i * 0.085, 0.17, 0.012, 0.30, 'triangle');
      });
      KIT.pot(t + 0.22);
    },

    // The same shape falling, and flattened.
    lose:  function (t) {
      [493.88, 415.30, 349.23].forEach(function (f, i) {
        tone(f, t + i * 0.11, 0.13, 0.015, 0.34, 'sine');
      });
    },

    // Gifts get a little sparkle.
    gift:  function (t) {
      [1318, 1760, 2093].forEach(function (f, i) {
        tone(f, t + i * 0.055, 0.10, 0.005, 0.17, 'sine');
      });
    },

    // Riffling the deck at the start of a hand.
    shuffle: function (t) {
      for (var i = 0; i < 9; i++) {
        noise(t + i * 0.026, 0.11, 0.03, 1500 + Math.random() * 2200, 2.2);
      }
    },
  };

  function play(name, delay) {
    if (!on()) return;
    unlock();
    if (!ctx || !KIT[name]) return;
    if (ctx.state === 'suspended') ctx.resume();
    try { KIT[name](now() + (delay || 0)); } catch (e) { /* never break the game for a sound */ }
  }

  // The first touch anywhere creates the context, so the sound after it works.
  ['pointerdown', 'keydown'].forEach(function (evt) {
    document.addEventListener(evt, unlock, { once: true, passive: true });
  });

  window.SFX = {
    play: play,
    enabled: on,
    set: function (v) {
      try { localStorage.setItem('siyl.sound', v ? 'on' : 'off'); } catch (e) {}
      if (v) play('tap');
    },
  };
})();
