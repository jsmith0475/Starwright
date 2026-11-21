// Starwright — fully procedural WebAudio. No sound files; every sound is synthesised here.
//
//   const audio = createAudio()
//   audio.unlock()                          call from the first user gesture (safe to call repeatedly)
//   audio.setEngine(level, {vacuum, solid, kind, atm})
//                                           layered engine sound, level 0..1. kind: 'liquid' | 'solid' | 'nuclear' | 'ion' | 'jet';
//                                           atm 0..1 = how much air carries the sound (1 at sea level; the roar and crackle thin
//                                           out with it and only the hull-borne rumble is left in vacuum)
//   audio.setWind(level)                    atmospheric rush, level 0..1
//   audio.setReentry(level)                 the deep roar and buffet of re-entry plasma, level 0..1
//   audio.play(name, {volume})              'stage' | 'decouple' | 'explosion' | 'click' | 'switch' | 'gear' | 'chute' | 'alarm' |
//                                           'beep' | 'warning' | 'master' | 'shutter' | 'success' | 'splash' | 'land' | 'warp'
//                                           'creak' (the structure groans under load) | 'snap' (a joint breaks)
//   audio.setVolume({sfx, music})           0..1 each
//   audio.setAmbient(on, mood)              calm generative score: mood 'centre' (menus, the space centre; the default)
//                                           or 'space' (sparse and slow, for coasting in orbit)
//   audio.suspend() / audio.resume()        e.g. while paused
//   audio.available / audio.unlocked
//
// Nothing here throws when AudioContext is missing or blocked: every entry point is a no-op in that case.

export function createAudio() {
  const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  let ctx = null, failed = !AC;
  let master = null, sfxBus = null, musicBus = null, noiseBuf = null;
  let engine = null, wind = null, ambient = null, reentry = null;
  const vol = { sfx: 0.7, music: 0.4 };
  const want = { engine: 0, vacuum: false, solid: false, kind: 'liquid', atm: 1, wind: 0, ambient: false, mood: 'centre', reentry: 0 };

  const safe = fn => (...args) => { try { return fn(...args); } catch (err) { if (!safe.warned) { safe.warned = true; console.warn('[audio] disabled:', err && err.message); } return undefined; } };
  const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

  function ensure() {
    if (ctx || failed) return ctx;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createDynamicsCompressor();
      master.threshold.value = -14; master.knee.value = 18; master.ratio.value = 6;
      master.attack.value = 0.004; master.release.value = 0.25;
      master.connect(ctx.destination);
      sfxBus = ctx.createGain(); sfxBus.gain.value = vol.sfx; sfxBus.connect(master);
      musicBus = ctx.createGain(); musicBus.gain.value = vol.music; musicBus.connect(master);
      // Two seconds of white noise shared by everything.
      const len = ctx.sampleRate * 2;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      let seed = 0x2f6e2b1;
      for (let i = 0; i < len; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; d[i] = seed / 2147483648 - 1; }
    } catch (err) {
      failed = true; ctx = null;
      console.warn('[audio] WebAudio unavailable:', err && err.message);
    }
    return ctx;
  }

  const now = () => ctx.currentTime;
  function noiseSrc(loop = true) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf; s.loop = loop;
    if (loop) s.loopStart = Math.random() * 1.5;
    return s;
  }
  function gain(v, dest) { const g = ctx.createGain(); g.gain.value = v; if (dest) g.connect(dest); return g; }
  function filter(type, freq, q, dest) {
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (q != null) f.Q.value = q;
    if (dest) f.connect(dest); return f;
  }
  function ramp(param, value, tc = 0.08) { param.setTargetAtTime(value, now(), tc); }
  function env(g, t0, peak, attack, decay) {
    g.gain.cancelScheduledValues(t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  // ------------------------------------------------------------ continuous: engine + wind

  function buildEngine() {
    const out = gain(0, sfxBus);
    // Body: low-passed noise.
    const lp = filter('lowpass', 300, 0.7, out);
    const body = noiseSrc(); body.playbackRate.value = 0.55; body.connect(lp); body.start();
    // Crackle: band-passed noise, amplitude-wobbled by slow noise.
    const crackGain = gain(0, out);
    const bp = filter('bandpass', 1400, 0.8, crackGain);
    const crack = noiseSrc(); crack.connect(bp); crack.start();
    const wobble = noiseSrc(); wobble.playbackRate.value = 0.004;
    const wobbleDepth = gain(0); wobble.connect(wobbleDepth); wobbleDepth.connect(crackGain.gain); wobble.start();
    // Sub rumble: two detuned low oscillators.
    const subGain = gain(0, out);
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 43;
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = 57.5;
    const subLp = filter('lowpass', 120, 0.5, subGain);
    o1.connect(subLp); o2.connect(subLp); o1.start(); o2.start();
    // Air roar: the wide hiss of exhaust tearing through air (only with atmosphere around).
    const roarGain = gain(0, out);
    const roarHp = filter('highpass', 900, 0.4, roarGain);
    const roar = noiseSrc(); roar.playbackRate.value = 1.3; roar.connect(roarHp); roar.start();
    // Tone layer: turbine whine (jets), reactor hum (nuclear), thin electric note (ion).
    const toneGain = gain(0, out);
    const toneLp = filter('lowpass', 2400, 0.6, toneGain);
    const t1 = ctx.createOscillator(); t1.type = 'sawtooth'; t1.frequency.value = 220;
    const t2 = ctx.createOscillator(); t2.type = 'sine'; t2.frequency.value = 331;
    t1.connect(toneLp); t2.connect(toneLp); t1.start(); t2.start();
    return { out, lp, crackGain, wobbleDepth, bp, subGain, o1, o2, roarGain, roarHp, toneGain, toneLp, t1, t2 };
  }

  function applyEngine() {
    if (!ctx) return;
    const lvl = want.engine;
    if (!engine) { if (lvl <= 0) return; engine = buildEngine(); }
    const e = engine;
    const kind = want.solid ? 'solid' : want.kind;
    const air = want.vacuum ? Math.min(want.atm, 0.04) : want.atm;        // 0 … 1
    const loud = lvl <= 0 ? 0 : 0.25 + 0.75 * lvl;
    // what the air carries, and what only the hull carries
    const open = Math.sqrt(Math.max(0, air));
    const K = { liquid: [0.8, 320, 0.22, 0.15, 1300, 0.5], solid: [0.95, 520, 0.5, 0.45, 2100, 0.75], nuclear: [0.6, 240, 0.08, 0.05, 900, 0.3], ion: [0.12, 200, 0, 0, 900, 0], jet: [0.6, 420, 0.1, 0.06, 1700, 0.55] }[kind] || [0.8, 320, 0.22, 0.15, 1300, 0.5];
    ramp(e.out.gain, loud * (K[0] * (0.35 + 0.65 * open)));
    ramp(e.lp.frequency, 110 + 90 * lvl + (K[1] - 110 + 900 * lvl) * open);
    ramp(e.crackGain.gain, K[2] * lvl * open); ramp(e.wobbleDepth.gain, K[3] * lvl * open);
    ramp(e.bp.frequency, K[4]);
    ramp(e.subGain.gain, kind === 'ion' ? 0.05 : 0.5 - 0.2 * open + 0.25 * lvl * open);
    ramp(e.roarGain.gain, K[5] * lvl * lvl * open * 0.5); ramp(e.roarHp.frequency, 700 + 1600 * lvl);
    ramp(e.o1.frequency, 38 + 14 * lvl); ramp(e.o2.frequency, 52 + 17 * lvl);
    if (kind === 'jet') { ramp(e.toneGain.gain, (0.03 + 0.05 * lvl) * (0.3 + 0.7 * open)); ramp(e.t1.frequency, 380 + 900 * lvl, 0.5); ramp(e.t2.frequency, (380 + 900 * lvl) * 1.503, 0.5); ramp(e.toneLp.frequency, 3200); }
    else if (kind === 'nuclear') { ramp(e.toneGain.gain, 0.05 * lvl); ramp(e.t1.frequency, 62); ramp(e.t2.frequency, 93.3); ramp(e.toneLp.frequency, 420); }
    else if (kind === 'ion') { ramp(e.toneGain.gain, 0.035 * lvl); ramp(e.t1.frequency, 880 + 220 * lvl); ramp(e.t2.frequency, 1322 + 330 * lvl); ramp(e.toneLp.frequency, 2600); }
    else ramp(e.toneGain.gain, 0);
  }

  function applyReentry() {
    if (!ctx) return;
    const lvl = want.reentry;
    if (!reentry) {
      if (lvl <= 0) return;
      const out = gain(0, sfxBus);
      const lp = filter('lowpass', 260, 0.9, out);
      const src = noiseSrc(); src.playbackRate.value = 0.4; src.connect(lp); src.start();
      // buffet: the roar swells and sags on slow noise
      const wob = noiseSrc(); wob.playbackRate.value = 0.0025; const wobG = gain(0); wob.connect(wobG); wobG.connect(out.gain); wob.start();
      const hissG = gain(0, sfxBus); const hp = filter('bandpass', 2600, 0.5, hissG);
      const hiss = noiseSrc(); hiss.connect(hp); hiss.start();
      reentry = { out, lp, wobG, hissG, hp };
    }
    ramp(reentry.out.gain, lvl * 0.9, 0.2); ramp(reentry.wobG.gain, lvl * 0.35, 0.2);
    ramp(reentry.lp.frequency, 160 + 500 * lvl, 0.3);
    ramp(reentry.hissG.gain, lvl * lvl * 0.16, 0.2); ramp(reentry.hp.frequency, 1800 + 2200 * lvl, 0.3);
  }

  function applyWind() {
    if (!ctx) return;
    const lvl = want.wind;
    if (!wind) {
      if (lvl <= 0) return;
      const out = gain(0, sfxBus);
      const bp = filter('bandpass', 500, 0.6, out);
      const hp = filter('highpass', 180, 0.5, bp);
      const src = noiseSrc(); src.connect(hp); src.start();
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.23;
      const lfoGain = gain(120); lfo.connect(lfoGain); lfoGain.connect(bp.frequency); lfo.start();
      wind = { out, bp };
    }
    ramp(wind.out.gain, lvl * lvl * 0.6, 0.15);
    ramp(wind.bp.frequency, 350 + 1500 * lvl, 0.2);
  }

  // ------------------------------------------------------------ one-shots

  function tone(type, f0, f1, t0, dur, peak, dest) {
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
    const g = gain(0, dest || sfxBus); env(g, t0, peak, Math.min(0.01, dur * 0.2), dur);
    o.connect(g); o.start(t0); o.stop(t0 + dur + 0.1);
    return o;
  }
  function burst(t0, dur, peak, type, f0, f1, q = 0.7, attack = 0.005) {
    const src = noiseSrc(false);
    const f = filter(type, f0, q);
    if (f1 && f1 !== f0) { f.frequency.setValueAtTime(f0, t0); f.frequency.exponentialRampToValueAtTime(f1, t0 + dur); }
    const g = gain(0, sfxBus); env(g, t0, peak, attack, dur);
    src.connect(f); f.connect(g);
    src.start(t0, Math.random() * 0.5, Math.min(dur + attack + 0.2, 1.4));
    return g;
  }

  const SHOTS = {
    click(t, v) {
      tone('triangle', 1250, 820, t, 0.045, 0.16 * v);
      burst(t, 0.02, 0.05 * v, 'highpass', 3000);
    },
    stage(t, v) {
      // Clamp release: a dry clack, a pneumatic hiss and a low thunk.
      burst(t, 0.05, 0.6 * v, 'bandpass', 2400, 900, 1.2, 0.002);
      burst(t + 0.02, 0.32, 0.28 * v, 'highpass', 2600, 5200, 0.5, 0.02);
      tone('sine', 150, 48, t, 0.22, 0.7 * v);
    },
    explosion(t, v) {
      burst(t, 1.3, 1.0 * v, 'lowpass', 2600, 90, 0.4, 0.004);
      burst(t + 0.03, 0.5, 0.5 * v, 'bandpass', 900, 200, 0.6, 0.004);
      tone('sine', 95, 26, t, 0.9, 0.9 * v);
      burst(t + 0.18, 0.9, 0.22 * v, 'highpass', 1800, 700, 0.4, 0.05);   // debris patter
    },
    chute(t, v) {
      // Fabric whoosh then a soft snap as the canopy fills.
      burst(t, 0.55, 0.42 * v, 'bandpass', 380, 1500, 0.9, 0.3);
      burst(t + 0.5, 0.18, 0.55 * v, 'lowpass', 1500, 300, 0.6, 0.004);
      tone('sine', 120, 62, t + 0.5, 0.2, 0.4 * v);
    },
    alarm(t, v) {
      for (let i = 0; i < 3; i++) {
        tone('square', 660, 660, t + i * 0.26, 0.11, 0.1 * v);
        tone('square', 495, 495, t + i * 0.26 + 0.12, 0.11, 0.1 * v);
      }
    },
    success(t, v) {
      // Rising pentatonic sparkle.
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      notes.forEach((f, i) => {
        tone('triangle', f, f, t + i * 0.085, 0.5, 0.17 * v);
        tone('sine', f * 2, f * 2, t + i * 0.085, 0.3, 0.05 * v);
      });
    },
    splash(t, v) {
      burst(t, 0.9, 0.7 * v, 'lowpass', 3200, 350, 0.5, 0.02);
      burst(t + 0.08, 1.1, 0.25 * v, 'highpass', 2200, 4200, 0.4, 0.12);
      tone('sine', 180, 55, t, 0.3, 0.4 * v);
    },
    land(t, v) {
      tone('sine', 110, 40, t, 0.28, 0.85 * v);
      burst(t, 0.16, 0.4 * v, 'lowpass', 700, 180, 0.6, 0.003);
      burst(t + 0.05, 0.4, 0.1 * v, 'bandpass', 2500, 1200, 0.8, 0.03);   // dust settling
    },
    decouple(t, v) {
      // Separation: a sharp pyro crack and the ring letting go.
      burst(t, 0.035, 0.8 * v, 'highpass', 1800, 900, 0.8, 0.001);
      tone('sine', 210, 60, t, 0.16, 0.6 * v);
      burst(t + 0.03, 0.22, 0.2 * v, 'bandpass', 700, 300, 1.4, 0.01);
    },
    switch(t, v) {
      // A cabin toggle switch.
      burst(t, 0.012, 0.3 * v, 'bandpass', 3400, 2200, 2.5, 0.001);
      tone('square', 180, 120, t, 0.03, 0.07 * v);
    },
    gear(t, v) {
      // Servo whirr and a latch.
      tone('sawtooth', 140, 260, t, 0.5, 0.05 * v);
      tone('sawtooth', 211, 392, t, 0.5, 0.03 * v);
      burst(t + 0.52, 0.05, 0.4 * v, 'bandpass', 1500, 700, 1.5, 0.002);
      tone('sine', 120, 70, t + 0.52, 0.1, 0.3 * v);
    },
    beep(t, v) { tone('sine', 1320, 1320, t, 0.07, 0.09 * v); },
    warning(t, v) {
      // Cabin caution tone: two soft two-note chirps.
      for (let i = 0; i < 2; i++) { tone('triangle', 880, 880, t + i * 0.3, 0.09, 0.11 * v); tone('triangle', 1108, 1108, t + i * 0.3 + 0.1, 0.09, 0.11 * v); }
    },
    master(t, v) {
      // Master alarm: an insistent low-high warble.
      for (let i = 0; i < 4; i++) { tone('square', 520, 520, t + i * 0.18, 0.08, 0.075 * v); tone('square', 780, 780, t + i * 0.18 + 0.09, 0.08, 0.075 * v); }
    },
    shutter(t, v) {
      burst(t, 0.02, 0.35 * v, 'highpass', 2500, 4000, 0.7, 0.001);
      burst(t + 0.07, 0.03, 0.3 * v, 'bandpass', 1800, 900, 1.2, 0.001);
    },
    creak(t, v) {
      // Structure under strain: two slow metal groans (a rough low reed rising, then sagging) with a thin squeal on top.
      tone('sawtooth', 62, 84, t, 0.55, 0.16 * v);
      tone('sawtooth', 93, 127, t + 0.02, 0.5, 0.07 * v);
      burst(t + 0.05, 0.45, 0.2 * v, 'bandpass', 520, 760, 9, 0.12);
      tone('sawtooth', 88, 58, t + 0.62, 0.7, 0.15 * v);
      tone('sawtooth', 131, 87, t + 0.64, 0.6, 0.06 * v);
      burst(t + 0.66, 0.55, 0.16 * v, 'bandpass', 900, 430, 11, 0.15);
    },
    snap(t, v) {
      // A joint lets go: a hard crack, the torn ring singing for a moment, and the thud through the hull.
      burst(t, 0.03, 0.9 * v, 'highpass', 2400, 1200, 0.8, 0.001);
      burst(t + 0.01, 0.12, 0.6 * v, 'bandpass', 1300, 500, 1.6, 0.002);
      tone('triangle', 742, 690, t + 0.01, 0.5, 0.09 * v);
      tone('triangle', 1187, 1120, t + 0.01, 0.34, 0.05 * v);
      tone('sine', 120, 38, t, 0.4, 0.8 * v);
      burst(t + 0.1, 0.6, 0.18 * v, 'highpass', 2000, 800, 0.4, 0.04);     // bits rattling away
    },
    warp(t, v) {
      tone('sine', 320, 960, t, 0.24, 0.12 * v);
      tone('triangle', 480, 1440, t + 0.03, 0.2, 0.05 * v);
    },
  };

  // ------------------------------------------------------------ ambient pad (menus)

  // Slow modal drift over open fifths: each "breath" picks the next chord and fades voices in and out.
  const CHORDS = [
    [110.0, 164.81, 220.0, 329.63, 493.88],     // A  E  A  E  B
    [98.0, 146.83, 220.0, 293.66, 440.0],       // G  D  A  D  A
    [87.31, 130.81, 196.0, 261.63, 392.0],      // F  C  G  C  G
    [82.41, 123.47, 185.0, 246.94, 369.99],     // E  B  F# B  F#
    [73.42, 146.83, 220.0, 277.18, 440.0],      // D  D  A  C# A
  ];

  // Space: wide, slow, unresolved (stacked fifths and a raised fourth), an octave above the centre's warmth.
  const SPACE_CHORDS = [
    [73.42, 110.0, 164.81, 246.94, 415.3, 554.37],   // D  A  E  B  G# C#
    [65.41, 98.0, 146.83, 220.0, 369.99, 493.88],    // C  G  D  A  F# B
    [82.41, 123.47, 185.0, 277.18, 466.16, 622.25],  // E  B  F# C# A# D#
    [55.0, 82.41, 164.81, 246.94, 369.99, 493.88],   // A  E  E  B  F# B
  ];

  function startAmbient() {
    if (ambient && ambient.mood !== want.mood) stopAmbient();
    if (ambient || !ctx) return;
    const space = want.mood === 'space';
    const SET = space ? SPACE_CHORDS : CHORDS;
    const out = gain(0, musicBus);
    const lp = filter('lowpass', space ? 1400 : 900, 0.3, out);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05;
    const lfoG = gain(260); lfo.connect(lfoG); lfoG.connect(lp.frequency); lfo.start();
    // A simple feedback delay gives the pad some air.
    const delay = ctx.createDelay(1.5); delay.delayTime.value = space ? 1.13 : 0.71;
    const fb = gain(space ? 0.58 : 0.42); const wet = gain(space ? 0.5 : 0.35, out);
    lp.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet);
    ambient = { out, lp, lfo, voices: [], step: Math.floor(Math.random() * SET.length), timer: 0, stopped: false, mood: want.mood };
    ramp(out.gain, space ? 0.42 : 0.5, space ? 3 : 1.5);
    const breathe = () => {
      if (!ambient || ambient.stopped || !ctx) return;
      const a = ambient;
      const chord = SET[a.step % SET.length];
      a.step += Math.random() < 0.75 ? 1 : 2;
      const t = now();
      const dur = (space ? 15 : 9) + Math.random() * (space ? 6 : 3);
      chord.forEach((f, i) => {
        for (const det of [-4, 5]) {
          const o = ctx.createOscillator();
          o.type = i < 2 ? 'sine' : 'triangle';
          o.frequency.value = f; o.detune.value = det + (Math.random() - 0.5) * 4;
          const g = gain(0, a.lp);
          const peak = (i < 2 ? 0.11 : 0.05) / (1 + i * 0.15) * (space ? 0.8 : 1);
          const at = (space ? 5 : 2.5) + Math.random() * 2;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(peak, t + at);
          g.gain.linearRampToValueAtTime(peak * 0.8, t + dur - 3);
          g.gain.linearRampToValueAtTime(0, t + dur + 2);
          o.connect(g); o.start(t); o.stop(t + dur + 2.2);
          a.voices.push(o);
          o.onended = () => { const k = a.voices.indexOf(o); if (k >= 0) a.voices.splice(k, 1); try { g.disconnect(); } catch { /* gone */ } };
        }
      });
      // An occasional glassy chime on top.
      for (let n = space ? 3 : 1; n > 0; n--) if (Math.random() < 0.6) {
        const f = chord[2 + Math.floor(Math.random() * (chord.length - 2))] * 2;
        const tt = t + 2 + Math.random() * (space ? 11 : 4);
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        const g = gain(0, a.lp); env(g, tt, 0.05, 0.02, 3.5);
        o.connect(g); o.start(tt); o.stop(tt + 4);
      }
      a.timer = setTimeout(breathe, (dur - 2.5) * 1000);
    };
    breathe();
  }

  function stopAmbient() {
    if (!ambient) return;
    const a = ambient; ambient = null;
    a.stopped = true; clearTimeout(a.timer);
    if (!ctx) return;
    ramp(a.out.gain, 0, 0.4);
    setTimeout(() => {
      try { for (const o of a.voices) o.stop(); a.lfo.stop(); a.out.disconnect(); } catch { /* already stopped */ }
    }, 2200);
  }

  function applyAll() { applyEngine(); applyWind(); applyReentry(); if (want.ambient) startAmbient(); else stopAmbient(); }

  // ------------------------------------------------------------ public API

  const api = {
    get available() { return !failed; },
    get unlocked() { return !!ctx && ctx.state === 'running'; },
    get volume() { return { ...vol }; },

    unlock: safe(() => {
      if (failed) return false;
      if (!ensure()) return false;
      if (ctx.state === 'suspended') { const p = ctx.resume(); if (p && p.then) p.then(() => safe(applyAll)(), () => {}); }
      applyAll();
      return true;
    }),

    setEngine: safe((level, opts = {}) => {
      want.engine = clamp01(level); want.vacuum = !!opts.vacuum; want.solid = !!opts.solid;
      want.kind = opts.kind || (opts.solid ? 'solid' : 'liquid');
      want.atm = opts.atm == null ? (opts.vacuum ? 0 : 1) : clamp01(opts.atm);
      applyEngine();
    }),

    setReentry: safe(level => { want.reentry = clamp01(level); applyReentry(); }),

    setWind: safe(level => { want.wind = clamp01(level); applyWind(); }),

    play: safe((name, opts = {}) => {
      if (!ctx || ctx.state !== 'running') return false;
      const fn = SHOTS[name];
      if (!fn) return false;
      fn(now() + 0.005, clamp01(opts.volume == null ? 1 : opts.volume));
      return true;
    }),

    setVolume: safe(({ sfx, music } = {}) => {
      if (sfx != null) vol.sfx = clamp01(sfx);
      if (music != null) vol.music = clamp01(music);
      if (ctx) { ramp(sfxBus.gain, vol.sfx, 0.05); ramp(musicBus.gain, vol.music, 0.05); }
    }),

    setAmbient: safe((on, mood = 'centre') => {
      want.ambient = !!on; want.mood = mood === 'space' ? 'space' : 'centre';
      if (!ctx) return;
      if (want.ambient) startAmbient(); else stopAmbient();
    }),

    /** Silence the continuous layers (engine + wind) at once, e.g. when leaving flight. */
    stopAll: safe(() => { want.engine = 0; want.wind = 0; want.reentry = 0; applyEngine(); applyWind(); applyReentry(); }),

    suspend: safe(() => { if (ctx && ctx.state === 'running') ctx.suspend(); }),
    resume: safe(() => { if (ctx && ctx.state === 'suspended') ctx.resume(); }),
    names: Object.keys(SHOTS),
  };
  return api;
}
