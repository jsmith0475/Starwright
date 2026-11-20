// Starwright — the demo tour: a self-running guided walk through the REAL game, made to be recorded.
//
//   installDemo(app)            called once from main.js; adds app.demo and honours ?demo=1 in the page address
//   app.demo.start({ chapter, clean, fast, hq, poster, pointer })   → Promise (resolves when the tour has ended)
//   app.demo.stop()             leave the tour (Esc does the same) and go back to where it was started from
//   app.demo.next() / prev() / jump(id) / toggle() / resume()
//   app.demo.state()            { running, paused, index, chapter, clock, chapters: [{ id, title, status, … }], log }
//
// Address parameters:  ?demo=1            start at once (good for recording)
//                      &chapter=<id>      start at that chapter (ids: see js/ui/demo/chapters.js or docs/DEMO.md)
//                      &clean=1           no control strip and no mouse cursor
//                      &fast=1            accelerated run for the automated test (waits and flights 8× quicker)
//                      &hq=1              full graphics quality even on a software renderer (the preview script)
//                      &poster=1          pause at each chapter's key frame until app.demo.resume() (the preview script)
//                      &pointer=0         hide the scripted pointer in the assembly chapters
//                      &seed=<n>          the random seed (default 20260)
//                      &step=1/60         fixed step: every drawn frame advances the tour and the game by exactly this many
//                                         seconds, whatever the wall clock says (filming on a slow renderer; repeatable runs)
//                      &watch=1           per-frame checks of what is on screen (camera above ground, ship in the picture, no
//                                         jumps without a cut): app.demo.watchReport(), used by tests/e2e/demo.mjs
//                                         Every run also leaves window.__demoReport (one record per chapter and a total,
//                                         see reportChapter below) and prints "[demo] report {…}" as each chapter ends.
//                      &fail=<id>         that chapter fails at once (the test of what the tour shows after a failure)
//                      &film=2            hold every 2 tour seconds until app.demo.resume() (tests/e2e/demo_film.mjs)
//                      &draw=6            with step and film: draw only every 6th frame between holds (the game still advances
//                                         frame by frame; a software renderer needs seconds for each full-quality picture)
//
// How it works
//   The tour is a director, not a screen: it calls app.goto() and then drives the screens through the same hooks the
//   test suites use (app.builder, app.flight, the hub's debug view, the map's setView / focus), flies vessels with
//   the core autopilot programs, and makes its scene changes by handing the flight screen a World it prepared.
//   · Sandbox: it runs on its own Career whose save() does nothing, so the player's save, quicksave and settings
//     are never written. The player's Career object is put back when the tour ends.
//   · Timing: every wait is either "tour seconds" (real time, frozen while paused) or a condition on the simulation
//     with a time limit. Nothing can deadlock: a chapter that fails or runs out of time is logged and skipped.
//   · Flights: the tour wraps world.step() of the live World so its controller runs once per physics step, and so a
//     "time-lapse" factor can run the same physics faster where a real-time flight would be dull.
//   · Repeatable: Math.random is replaced by a seeded generator while the tour runs, the cut scenes start from fixed
//     states and times, and guidance decisions are made on simulation time, so two runs match shot for shot.
import { el } from './dom.js';
import { seededRandom, ease, clamp } from './demo/kit.js';
import { CHAPTERS } from './demo/chapters.js';

const FAST = 8;                        // &fast=1: how much quicker waits, camera moves and flights run
const ABORT = Symbol('demo-abort');
const KEYS = ['starwright.save.v1', 'starwright.quicksave.v1', 'starwright.settings.v1', 'starwright.save.corrupt'];
const PHYS_WARP_MAX = 3;
const FRAME_MAX = 0.1;                   // the longest frame the tour clock follows (the game's main loop uses the same)

function ensureCss() {
  if (document.getElementById('sw-demo-css')) return;
  const link = document.createElement('link');
  link.id = 'sw-demo-css'; link.rel = 'stylesheet';
  link.href = new URL('../../css/demo.css', import.meta.url).href;
  document.head.appendChild(link);
}

export function installDemo(app) {
  if (app.demo) return app.demo;
  ensureCss();

  // ------------------------------------------------------------------ state
  const D = {
    running: false, paused: false, ended: false, opts: {}, token: 0, index: -1, clock: 0, real: 0,
    tasks: [], cleanups: [], pendingJump: null, shared: {}, log: [], status: [], finish: null,
    prevCareer: null, prevScreen: 'title', prevSettings: null, prevRandom: null, storage: null,
    sim: null, raf: 0, last: 0, stripTimer: 0, poster: null, posterCount: 0,
  };
  const dom = {};
  const speed = () => (D.opts.fast ? FAST : 1);

  function note(msg, kind = 'info') {
    const line = { t: Math.round(D.real * 10) / 10, chapter: D.index >= 0 && CHAPTERS[D.index] ? CHAPTERS[D.index].id : '', kind, msg: String(msg) };
    D.log.push(line);
    if (D.log.length > 400) D.log.shift();
    if (kind === 'warn' || kind === 'fail') console.warn('[demo] ' + (line.chapter ? line.chapter + ': ' : '') + line.msg);
    return line;
  }

  // ------------------------------------------------------------------ overlay
  function buildDom() {
    dom.shield = el('div', { class: 'swd-shield' });
    dom.fade = el('div', { class: 'swd-fade' });
    dom.cardN = el('div', { class: 'n' }); dom.cardT = el('div', { class: 't' }); dom.cardS = el('div', { class: 's' });
    dom.card = el('div', { class: 'swd-card' }, dom.cardN, dom.cardT, el('i'), dom.cardS);
    dom.capN = el('span', { class: 'n' }); dom.capBadge = el('span', { class: 'badge' });
    dom.capT = el('h2'); dom.capL = el('p');
    dom.caption = el('div', { class: 'swd-caption', attrs: { 'data-pos': 'bl' } }, el('div', { class: 'k' }, dom.capN, dom.capBadge), dom.capT, dom.capL);
    dom.progress = el('div', { class: 'swd-progress' }, CHAPTERS.map(c => el('span', { attrs: { 'data-chapter': c.id, title: c.title } }, el('i'))));
    const btn = (action, label, tip, fn) => el('button', { class: 'swd-btn', text: label, attrs: { type: 'button', 'data-demo': action, title: tip, 'aria-label': tip }, on: { click: e => { e.stopPropagation(); fn(); } } });
    dom.stripName = el('span', { class: 'name' });
    dom.playBtn = btn('pause', 'Pause', 'Pause / resume (Space)', () => api.toggle());
    dom.strip = el('div', { class: 'swd-strip' },
      btn('prev', '‹ Prev', 'Previous chapter (←)', () => api.prev()), dom.playBtn, btn('next', 'Next ›', 'Next chapter (→)', () => api.next()),
      dom.stripName, el('span', { class: 'keys', text: 'Space pause · ← → chapters · Esc exit' }), btn('exit', 'Exit', 'Leave the tour (Esc)', () => api.stop()));
    dom.pausedTag = el('div', { class: 'swd-paused', text: 'Paused' });
    dom.cursor = el('div', { class: 'swd-cursor' });
    dom.root = el('div', { class: 'swd', attrs: { 'data-demo-root': '1' } }, dom.shield, dom.fade, dom.card, dom.caption, dom.cursor, dom.progress, dom.pausedTag, dom.strip);
    if (D.opts.clean) dom.root.classList.add('clean');
    if (D.opts.pointer === false) dom.root.classList.add('no-pointer');
    dom.shield.addEventListener('mousemove', wakeStrip);
    dom.shield.addEventListener('mousedown', wakeStrip);
    dom.shield.addEventListener('contextmenu', e => e.preventDefault());
    document.body.appendChild(dom.root);
  }
  function wakeStrip() {
    if (!dom.root || D.opts.clean) return;
    dom.root.classList.add('awake');
    clearTimeout(D.stripTimer);
    D.stripTimer = setTimeout(() => { if (dom.root) dom.root.classList.remove('awake'); }, 2600);
  }
  function setFade(a) { if (dom.fade) dom.fade.style.opacity = String(clamp(a, 0, 1)); D.fadeNow = a; }
  function showProgress() {
    if (!dom.progress) return;
    [...dom.progress.children].forEach((n, i) => {
      n.classList.toggle('done', i < D.index); n.classList.toggle('on', i === D.index);
      n.classList.toggle('bad', !!(D.status[i] && D.status[i].status === 'failed'));
    });
    const c = CHAPTERS[D.index];
    if (dom.stripName) dom.stripName.textContent = c ? `${String(D.index + 1).padStart(2, '0')} / ${String(CHAPTERS.length).padStart(2, '0')}  ${c.title}` : '';
  }

  // ------------------------------------------------------------------ keys (the tour owns the keyboard while it runs)
  function onKey(e) {
    if (!D.running) return;
    const down = e.type === 'keydown';
    // the game must not see the player's keys during the tour (its scripted taps go through app.input.tap)
    e.stopImmediatePropagation();
    if (e.metaKey || e.ctrlKey) return;                      // browser shortcuts stay with the browser
    if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape', 'Tab'].includes(e.code)) e.preventDefault();
    if (!down || e.repeat) return;
    if (e.code === 'Space' || e.code === 'KeyP') api.toggle();
    else if (e.code === 'ArrowRight') api.next();
    else if (e.code === 'ArrowLeft') api.prev();
    else if (e.code === 'Escape') api.stop();
    wakeStrip();
  }

  // ------------------------------------------------------------------ clock, waits, tweens
  function frame(now, timer = false) {
    if (!D.running) return;
    if (!timer) { D.raf = requestAnimationFrame(frame); D.frames++; }
    // the same frame time as the game's own loop (js/main.js: at most 0.1 s), so a slow or uneven frame rate slows the
    // tour and the flights together and never lets one run ahead of the other; &step= makes it exact
    const realDt = D.opts.step ? D.opts.step : clamp((now - D.last) / 1000, 0, D.opts.fast ? 1 : FRAME_MAX);
    D.credit = 0;
    D.last = now;
    D.real += realDt;
    const dt = D.paused ? 0 : realDt * speed();
    D.clock += dt;
    D.frameDt = dt;
    if (!D.paused) D.used += realDt;                          // what the chapter time limits count
    if (D.opts.film > 0 && !D.paused && D.clock >= D.filmNext && (D.hold || (D.fadeNow || 0) > 0.97)) {
      // nothing to see behind the black of a cut, and a hold there would give the scene being loaded time that a
      // real viewer's machine does not get: the next picture is the next one that shows something
      D.filmNext = (Math.floor(D.clock / D.opts.film + 1e-9) + 1) * D.opts.film;
    } else if (D.opts.film > 0 && !D.paused && D.clock >= D.filmNext) {
      // filming: hold (silently) every `film` tour seconds until app.demo.resume(), so a script can take a picture
      D.filmCount++;
      D.filmStop = { n: D.filmCount, clock: Math.round(D.clock * 1000) / 1000, chapter: CHAPTERS[D.index] ? CHAPTERS[D.index].id : '' };
      D.filmNext = (Math.floor(D.clock / D.opts.film + 1e-9) + 1) * D.opts.film;
      app.drawEvery = 1;                                       // the held picture is always drawn
      setPaused(true, true);
    }
    if (D.watch) { try { D.watch(); } catch { /* the view is changing */ } }
    if (D.guard && D.guard.token === D.token && D.used > D.guard.end) { const g = D.guard; D.guard = null; g.reject(); }
    for (const t of D.tasks.slice()) {
      if (t.dead) continue;
      let res;
      try { res = t.token !== D.token ? { abort: true } : t.step(dt, realDt); }
      catch (err) { res = { error: err }; }
      if (!res) continue;
      t.dead = true;
      D.tasks.splice(D.tasks.indexOf(t), 1);
      if (res.abort) t.reject(ABORT); else if (res.error) t.reject(res.error); else t.resolve(res.value);
    }
    const cur = D.status[D.index];
    if (cur && cur.status === 'running' && !cur.captionSeen && dom.caption && dom.caption.classList.contains('show') && dom.capT.textContent) {
      try { const r = dom.caption.getBoundingClientRect(); if (r.width > 50 && r.height > 20 && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1) cur.captionSeen = true; } catch { /* not laid out */ }
    }
    if (D.status[D.index] && D.status[D.index].status === 'running') D.status[D.index].seconds = Math.round((D.clock - D.status[D.index].startClock) * 10) / 10;
  }
  /** A task is stepped every frame until its step() returns { value }. It is rejected when the chapter is left. */
  function task(step) {
    const token = D.token;
    return new Promise((resolve, reject) => {
      if (!D.running || token !== D.token) { reject(ABORT); return; }
      D.tasks.push({ step, token, resolve, reject, dead: false });
    });
  }
  const alive = token => { if (!D.running || token !== D.token) throw ABORT; };
  /** Accelerated runs only: time left over from the wait that just ended is spent on the next one, so a slow page
      (a frame can be a whole second in the test browser) does not pay one frame for every short wait. */
  function spend(seconds) {
    if (!D.opts.fast || !(D.credit > 0)) return 0;
    const use = Math.min(D.credit, Math.max(0, seconds));
    D.credit -= use;
    return use;
  }

  // ------------------------------------------------------------------ the simulation hook
  /**
   * Wrap world.step so that (a) the tour's controller and per-step hooks run right before every physics step, after
   * the flight screen has read the (empty) keyboard, (b) `sim.scale` runs the same physics as a time-lapse and
   * (c) the world stands still while the tour is paused. Rails warp is left to the World: the controllers ask for it.
   */
  function attachSim(world) {
    const reset = sim => () => { sim.ctl = null; sim.hooks.length = 0; sim.scale = 1; };        // a chapter's controller ends with the chapter
    if (world.__demoSim) { D.sim = world.__demoSim; D.cleanups.push(reset(world.__demoSim)); return world.__demoSim; }
    const orig = world.step.bind(world);
    const sim = { world, scale: 1, ctl: null, hooks: [], error: null, steps: 0, orig };
    const tick = h => {
      if (sim.ctl && !sim.ctl.done) { try { sim.ctl.update(h); } catch (err) { sim.error = err; sim.ctl.done = true; sim.ctl.failed = true; note('controller stopped: ' + (err && err.message), 'warn'); } }
      for (const fn of sim.hooks.slice()) { try { fn(h); } catch (err) { note('step hook failed: ' + (err && err.message), 'warn'); sim.hooks.splice(sim.hooks.indexOf(fn), 1); } }
    };
    world.step = dt => {
      if (D.paused || D.hold || !D.running) { sim.wall = 0; return; }
      const k = speed();
      if (D.opts.fast && !D.opts.step) { const now = performance.now(); dt = Math.max(dt, Math.min((now - (sim.wall || now)) / 1000, 0.6)); sim.wall = now; }   // slow test browser: follow real time
      if (world.warpIndex > PHYS_WARP_MAX || world.warpTarget != null) {                 // on rails
        tick(dt);
        const n = D.opts.fast ? 4 : 1;
        for (let i = 0; i < n; i++) { orig(dt * k / n); if (!(world.warpIndex > PHYS_WARP_MAX || world.warpTarget != null)) break; }
        sim.steps++;
        return;
      }
      const rate = world.rate || 1;
      const total = dt * sim.scale * k;
      const n = Math.max(1, Math.ceil(total / (1 / 30)));
      const h = total / n, t0 = performance.now(), budget = D.opts.step ? Infinity : D.opts.fast ? 300 : 14;
      for (let i = 0; i < n; i++) {
        tick(h);
        orig(h / rate);
        sim.steps++;
        if (!world.active || world.active.dead) break;
        if (world.warpIndex > PHYS_WARP_MAX || world.warpTarget != null) break;         // a controller asked for rails warp
        if (i < n - 1 && performance.now() - t0 > budget) {                            // a slow machine shows a shorter lapse, never a frozen page
          const st = D.status[D.index]; if (st) st.lapseCut = (st.lapseCut || 0) + 1;
          break;
        }
      }
    };
    world.__demoSim = sim;
    D.sim = sim;
    D.cleanups.push(reset(sim));
    return sim;
  }

  // ------------------------------------------------------------------ the viewer's eye (&watch=1)
  /**
   * Checks made on EVERY drawn frame that the audience can see (not behind a fade), for the automated tests: is the
   * flight camera above the ground, is the ship in the picture, is the ship above the ground, did the picture jump.
   * A key frame every few seconds cannot see a fault that lasts half a second; this can. Results: api.watchReport().
   */
  function makeWatch() {
    const W = { chapters: {}, last: null };
    const rec = id => W.chapters[id] || (W.chapters[id] = { frames: 0, flightFrames: 0, minCamClear: null, minCamClearAt: 0, minRadar: null, minRadarAt: 0, off: 0, offStreak: 0, maxOffStreak: 0, maxOffAt: 0, jumps: [], loading: 0, loadStreak: 0, maxLoad: 0, maxLoadAt: 0, minSun: null, minSunAt: 0 });
    const tick = () => {
      const c = CHAPTERS[D.index]; if (!c || D.paused) return;
      const r = rec(c.id);
      r.frames++;
      const visible = !D.hold && !((D.fadeNow || 0) > 0.5);
      const f = app.flight, sc = f && f.view, world = f && f.world, v = world && world.active;
      if (app.currentName !== 'flight' || !sc || !v || v.dead || f.mapOpen || !visible || !sc.anchor || !sc.anchor.valid) { W.last = null; r.offStreak = 0; return; }
      const cam = sc.camera, a = sc.anchor, t = Math.round((D.clock - (D.status[D.index] ? D.status[D.index].startClock : 0)) * 10) / 10;
      r.flightFrames++;
      // daylight on a ship that is near the ground (a landing, a splashdown, a take-off in the dark is a black picture)
      const sun = sc.info && Number.isFinite(sc.info.sunElevation) ? sc.info.sunElevation : null;
      if (sun != null && v.radarAlt < 2500 && (r.minSun == null || sun < r.minSun)) { r.minSun = sun; r.minSunAt = t; }
      // the ground still loading in a picture the audience can see
      // (what a viewer notices is ground that is still arriving when a scene is REVEALED; finer chunks streaming in as
      //  a ship climbs, descends or drives is the terrain working as designed, so only the total of that is kept)
      const loadingNow = !!(sc.worlds && sc.worlds.info && sc.worlds.info.busy && v.altitude < 30000);
      if (!W.last) r.reveal = loadingNow;                    // first visible frame after a cut (or the map closing)
      if (loadingNow) { r.loading += D.frameDt; if (r.reveal) { r.loadStreak += D.frameDt; if (r.loadStreak > r.maxLoad) { r.maxLoad = r.loadStreak; r.maxLoadAt = t; } } }
      else { r.reveal = false; r.loadStreak = 0; }
      // camera above the ground under it
      const px = cam.position.x + a.pos.x, py = cam.position.y + a.pos.y, pz = cam.position.z + a.pos.z;
      let ground = a.ground;
      if (typeof a.groundAt === 'function') { W.p = W.p || cam.position.clone(); const g = a.groundAt(W.p.set(px, py, pz)); if (Number.isFinite(g)) ground = g; }
      const clear = Math.hypot(px, py, pz) - ground;
      if (r.minCamClear == null || clear < r.minCamClear) { r.minCamClear = clear; r.minCamClearAt = t; }
      // the ship above the ground (its lowest point; a landed ship rests at about zero)
      // (over the sea the "ground" is the water: a capsule dips a metre into it as it splashes down and then floats
      //  low, which is right; there only a ship more than its own height under the surface counts)
      const wet = !!(v.splashed || v._floating || (v.body.ocean && v.altitude < 3 && Math.abs(v.altitude - v.radarAlt) < 0.05));
      const radar = wet ? Math.min(0, v.radarAlt + 2.4) : v.radarAlt;
      if (Number.isFinite(radar) && (r.minRadar == null || radar < r.minRadar)) { r.minRadar = radar; r.minRadarAt = t; }
      // the ship in the picture (the followed vessel is the scene origin)
      W.n = W.n || cam.position.clone();
      const n = W.n.set(0, 0, 0).project(cam);
      const out = !(Math.abs(n.x) < 0.94 && Math.abs(n.y) < 0.94 && n.z > -1 && n.z < 1);
      if (out) { r.off++; r.offStreak += D.frameDt; if (r.offStreak > r.maxOffStreak) { r.maxOffStreak = r.offStreak; r.maxOffAt = t; } } else r.offStreak = 0;
      // a jump of the picture: the camera's bearing from the ship turning more than a few degrees in one frame
      const L = Math.hypot(cam.position.x, cam.position.y, cam.position.z) || 1;
      const now = { x: cam.position.x / L, y: cam.position.y / L, z: cam.position.z / L, d: L, v, world };
      if (W.last && W.last.v === v && W.last.world === world) {
        const dot = clamp(now.x * W.last.x + now.y * W.last.y + now.z * W.last.z, -1, 1), deg = Math.acos(dot) * 180 / Math.PI;
        const zoom = Math.abs(Math.log(now.d / W.last.d));
        // (a rate, so a machine that draws few frames is not blamed for the distance a moving camera covers between
        //  two of them: 6° or a quarter zoom in one frame at 60 a second, half that rate for longer frames)
        const k = Math.max(1, D.frameDt * 30);
        if ((deg > 6 * k || zoom > 0.25 * k) && r.jumps.length < 12) r.jumps.push({ t, deg: Math.round(deg * 10) / 10, zoom: Math.round(zoom * 100) / 100 });
      }
      W.last = now;
    };
    return { W, tick };
  }
  /** The per-frame findings as a list per chapter: [{ t (s into the chapter), kind, detail }]. */
  function watchProblems(id, r) {
    const out = [], r2 = x => (x == null ? null : Math.round(x * 100) / 100);
    if (!r || !r.flightFrames) return out;
    if (r.minCamClear < 0.4) out.push({ t: r.minCamClearAt, kind: 'camera-low', detail: `the camera was ${r2(r.minCamClear)} m above the ground (${r.minCamClearAt} s into the chapter)` });
    if (r.minRadar < -0.6) out.push({ t: r.minRadarAt, kind: 'ship-underground', detail: `the ship was ${r2(-r.minRadar)} m under the ground (${r.minRadarAt} s into the chapter)` });
    if (r.maxOffStreak > 0.4) out.push({ t: r.maxOffAt, kind: 'out-of-picture', detail: `the ship was out of the picture for ${r2(r.maxOffStreak)} s (${r.maxOffAt} s into the chapter)` });
    if (r.minSun != null && r.minSun < 0.1) out.push({ t: r.minSunAt, kind: 'dark', detail: `the ship was near the ground in the dark (sun ${Math.round(r.minSun * 57.3)}° above the horizon, ${r.minSunAt} s into the chapter)` });
    if (r.maxLoad > 0.75) out.push({ t: r.maxLoadAt, kind: 'ground-loading', detail: `the ground was still loading for ${r2(r.maxLoad)} s after the scene was shown (${r.maxLoadAt} s into the chapter)` });
    for (const jmp of r.jumps) out.push({ t: jmp.t, kind: 'jump', detail: `the picture jumped with no cut (${jmp.t} s into the chapter: ${jmp.deg}°, zoom ${jmp.zoom})` });
    return out;
  }
  function watchReport() {
    if (!D.watcher) return null;
    const chapters = {}, problems = [];
    const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
    for (const [id, r] of Object.entries(D.watcher.W.chapters)) {
      chapters[id] = { frames: r.frames, flightFrames: r.flightFrames, minCamClear: r2(r.minCamClear), minCamClearAt: r.minCamClearAt, minRadar: r2(r.minRadar), minRadarAt: r.minRadarAt, offFrames: r.off, maxOffStreak: r2(r.maxOffStreak), maxOffAt: r.maxOffAt, jumps: r.jumps, loading: r2(r.loading), maxLoad: r2(r.maxLoad), maxLoadAt: r.maxLoadAt, minSun: r2(r.minSun), minSunAt: r.minSunAt };
      const list = watchProblems(id, r), jumps = list.filter(x => x.kind === 'jump');
      for (const x of list) if (x.kind !== 'jump') problems.push(`${id}: ${x.detail}`);
      if (jumps.length) problems.push(`${id}: the picture jumped ${jumps.length}× with no cut (first at ${r.jumps[0].t} s: ${r.jumps[0].deg}°, zoom ${r.jumps[0].zoom})`);
    }
    return { chapters, problems };
  }

  // ------------------------------------------------------------------ the report (window.__demoReport)
  /** Reading pace: a fifth of a second a word (a quick reader), two seconds at least. */
  const captionNeeds = words => Math.max(2, words / 5);
  /**
   * One record per finished chapter, for a run on a real machine that nobody is watching frame by frame:
   *   window.__demoReport = { chapters: [{ id, tourSeconds, wallSeconds, ok, status, fallback, problems: [{ t, kind,
   *   detail }], captions: [{ text, words, seconds }] }], total: { tourSeconds, wallSeconds, ok, problems, ended } }
   * and one console line per chapter ("[demo] report {…}"). The per-frame kinds need &watch=1; a failed chapter, a
   * stand-in and a caption that left too soon are reported either way. The tour never stops for a problem.
   */
  function reportChapter(st) {
    const R = window.__demoReport || (window.__demoReport = { chapters: [], total: null });
    const caps = (D.capLog || []).filter(c => c.run === st.runId);
    const problems = [];
    if (st.status === 'failed') problems.push({ t: st.seconds, kind: 'failed', detail: st.error || 'the chapter failed' });
    for (const f of st.fallbacks) problems.push({ t: st.seconds, kind: 'fallback', detail: f });
    if (st.lapseCut) problems.push({ t: st.seconds, kind: 'lapse-cut', detail: `a time-lapse was cut short ${st.lapseCut}× (the machine could not keep up)` });
    if (st.groundLate) problems.push({ t: 0, kind: 'ground-late', detail: `the ground had not finished loading after the longest wait behind a cut (${st.groundLate}×)` });
    if (D.watcher) problems.push(...watchProblems(st.id, D.watcher.W.chapters[st.id]));
    if (!D.opts.fast && st.status !== 'left') for (const c of caps) if (c.seconds < captionNeeds(c.words) - 0.05) problems.push({ t: c.at, kind: 'caption-pace', detail: `the caption "${c.title}" (${c.words} words) was on screen for ${c.seconds} s; it needs ${captionNeeds(c.words).toFixed(1)} s` });
    const rec = { id: st.id, tourSeconds: st.seconds, wallSeconds: Math.round((performance.now() - st.startWall) / 100) / 10, ok: st.status === 'ok' && !problems.length, status: st.status, fallback: st.fallbacks.length ? st.fallbacks.join('; ') : null, problems, captions: caps.map(c => ({ text: c.title, words: c.words, seconds: c.seconds })), groundWaitSeconds: st.groundWait || 0 };
    const k = R.chapters.findIndex(c => c.id === st.id);
    if (k >= 0) R.chapters[k] = rec; else R.chapters.push(rec);
    console.log('[demo] report ' + JSON.stringify(rec));
    return rec;
  }
  function reportTotal() {
    const R = window.__demoReport || (window.__demoReport = { chapters: [], total: null });
    R.total = { tourSeconds: Math.round(D.clock * 10) / 10, wallSeconds: Math.round((performance.now() - (D.startWall || performance.now())) / 100) / 10, chapters: R.chapters.length, ok: R.chapters.length === CHAPTERS.length && R.chapters.every(c => c.ok), problems: R.chapters.reduce((n, c) => n + c.problems.length, 0), ended: !!D.ended };
    console.log('[demo] report total ' + JSON.stringify(R.total));
    return R;
  }

  /** A caption leaves the screen: note how long it could be read (api.state().captionLog; the tests check the pace). */
  function closeCaption() {
    const c = D.capNow; if (!c) return;
    D.capNow = null;
    const st = D.status[D.index];
    D.capLog.push({ chapter: c.chapter, title: c.title, words: c.words, seconds: Math.round((D.clock - c.at) * 10) / 10, at: Math.round((c.at - (st ? st.startClock : 0)) * 10) / 10, run: st ? st.runId : 0 });
  }

  // ------------------------------------------------------------------ what a chapter can do
  function context(token, chapter, st) {
    const d = {
      app, opts: D.opts, shared: D.shared, chapter, ease, fastFactor: speed(),
      get clock() { return D.clock; },
      get paused() { return D.paused; },
      alive: () => alive(token),
      note: msg => note(msg),
      /** The chapter could not show the real thing and used its stand-in (logged; the test reports it). */
      fallback(msg) { st.fallbacks.push(String(msg)); note('fallback: ' + msg, 'warn'); },
      /** Run an optional step: an exception is logged, never fatal. */
      attempt(fn, what = 'optional step') { try { return fn(); } catch (err) { if (err === ABORT) throw err; note(what + ' failed: ' + (err && err.message), 'warn'); return undefined; } },
      cleanup(fn) { D.cleanups.push(fn); },

      /** Tour seconds (real time; frozen while paused). */
      wait(seconds) {
        alive(token);
        let left = seconds - spend(seconds);
        if (left <= 0) return Promise.resolve(true);
        return task(dt => { left -= dt; if (left > 0) return null; D.credit = D.opts.fast ? -left : 0; return { value: true }; });
      },
      /** Wait for a condition; false when `timeout` tour seconds pass first (also bounded in real time). */
      until(cond, timeout = 20, { real = 90 } = {}) {
        alive(token);
        let left = timeout, wall = real;
        return task((dt, realDt) => {
          let ok = false;
          try { ok = !!cond(); } catch { ok = false; }
          if (ok) return { value: true };
          left -= dt; if (!D.paused) wall -= realDt;
          return left <= 0 || wall <= 0 ? { value: false } : null;
        });
      },
      /** Wait for a condition on a flight, bounded in SIMULATION seconds (so it is the same on any machine). */
      untilSim(world, cond, simSeconds, { real = 150 } = {}) {
        alive(token);
        const end = world.ut + simSeconds; let wall = real, lastUt = world.ut, still = 0;
        return task((dt, realDt) => {
          let ok = false;
          try { ok = !!cond(); } catch { ok = false; }
          if (ok) return { value: true };
          if (!D.paused && !D.hold) { wall -= realDt; if (world.ut === lastUt) still += realDt; else { still = 0; lastUt = world.ut; } }
          // give up when the limit passes, the flight is gone, or the clock has stopped (the vessel was lost)
          return world.ut >= end || wall <= 0 || still > 6 || app.world !== world ? { value: false } : null;
        });
      },
      /** Call fn(k) every frame with k eased from 0 to 1 over `seconds`. */
      tween(seconds, fn, curve = ease.inOut) {
        alive(token);
        let t = spend(seconds);
        if (t >= seconds) { fn(curve(1), 1); return Promise.resolve(true); }
        return task(dt => {
          t += dt;
          const k = seconds > 0 ? clamp(t / seconds, 0, 1) : 1;
          fn(curve(k), k);
          if (k < 1) return null;
          D.credit = D.opts.fast ? t - seconds : 0;
          return { value: true };
        });
      },
      /** Run fn(dt, t) every frame for `seconds` (Infinity: until the chapter ends). Returns a stop function. */
      every(fn, seconds = Infinity) {
        let t = 0, stopped = false;
        task(dt => { if (stopped) return { value: true }; t += dt; fn(dt, t); return t >= seconds ? { value: true } : null; }).catch(() => {});
        return () => { stopped = true; };
      },

      // ---- presentation
      caption(title, line = '', { pos, badge = null } = {}) {
        alive(token);
        closeCaption();
        D.capNow = { chapter: chapter.id, title, words: (title + ' ' + line).trim().split(/\s+/).length, at: D.clock };
        st.captions++;
        st.caption = title;
        dom.capN.textContent = `${String(D.index + 1).padStart(2, '0')} / ${String(CHAPTERS.length).padStart(2, '0')}`;
        dom.caption.classList.remove('show');
        void dom.caption.offsetWidth;                       // restart the slide-in
        dom.capT.textContent = title; dom.capL.textContent = line;
        if (pos) dom.caption.dataset.pos = pos;
        d.badge(badge);
        dom.caption.classList.add('show');
        try { const r = dom.caption.getBoundingClientRect(); if (r.width > 50 && r.height > 20 && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 16) st.captionSeen = true; } catch { /* not laid out */ }
      },
      captionPos(pos) { dom.caption.dataset.pos = pos; },
      badge(text) { dom.capBadge.textContent = text || ''; dom.capBadge.classList.toggle('on', !!text); },
      hideCaption() { closeCaption(); dom.caption.classList.remove('show'); },
      async fadeOut(seconds = 0.4) { const a0 = D.fadeNow || 0; await d.tween(seconds, k => setFade(a0 + (1 - a0) * k), ease.soft); },
      async fadeIn(seconds = 0.5) { const a0 = D.fadeNow == null ? 1 : D.fadeNow; await d.tween(seconds, k => setFade(a0 * (1 - k)), ease.soft); },
      /**
       * A clean scene change: fade to black, show the chapter card, run `setup` (screen changes, world building),
       * hold the card a moment, fade in. `title: false` skips the card (a cut inside a chapter).
       */
      async cut(setup, { title = chapter.title, sub = chapter.sub || '', hold = 0.9, settle = 0.3 } = {}) {
        d.hideCaption();
        await d.fadeOut(0.4);
        D.hold = true;                                        // no flight runs behind the black
        if (title) {
          dom.cardN.textContent = String(D.index + 1).padStart(2, '0');
          dom.cardT.textContent = title; dom.cardS.textContent = sub;
          dom.card.classList.add('show');
        }
        const t0 = D.clock;
        let result;
        try { result = await setup(); alive(token); }
        catch (err) { D.hold = false; dom.card.classList.remove('show'); throw err; }
        await d.sceneReady();
        if (title) { const left = hold - (D.clock - t0); if (left > 0) await d.wait(left); }
        if (settle > 0) await d.waitFrames(D.opts.hq ? 6 : D.opts.fast ? 1 : 3, D.opts.fast && !D.opts.hq ? 0 : settle);
        dom.card.classList.remove('show');
        D.hold = false;
        await d.fadeIn(0.5);
        return result;
      },
      /**
       * Behind the black of a cut: wait until the flight scene has the ground it is about to show. The terrain is built
       * chunk by chunk beside the frames; a machine that opens the flight in a few frames would otherwise fade in on
       * the coarse first chunks (a pad half sunk in a smooth hill) and watch the detail arrive. Bounded: a scene that
       * never reports ready is shown as it is after `seconds`.
       */
      async sceneReady(seconds = 8) {
        const w0 = performance.now();
        try { return await d._sceneReady(seconds); }
        finally { st.groundWait = Math.round(((st.groundWait || 0) + (performance.now() - w0) / 1000) * 100) / 100; }
      },
      async _sceneReady(seconds) {
        const busy = () => { const f = app.flight, sc = app.currentName === 'flight' && f && f.view, w = sc && sc.worlds; return !!(w && w.info && w.info.busy); };
        if (app.currentName !== 'flight') return true;
        await d.waitFrames(3);                               // the scene has to see its new place (and camera) first
        if (!busy()) return true;
        d.attempt(() => app.flight.view.settleTerrain(250));  // nobody is watching: build on this thread as well
        let wall = seconds, calm = 0;
        const ok = await task((dt, realDt) => {
          wall -= D.opts.step ? D.opts.step : realDt;
          calm = busy() ? 0 : calm + 1;
          if (calm >= 3) return { value: true };
          if (wall <= 0) return { value: false };
          if (busy()) d.attempt(() => app.flight.view.settleTerrain(60));
          return null;
        });
        if (!ok) { note('the ground was still loading when the scene was shown', 'warn'); st.groundLate = (st.groundLate || 0) + 1; }
        return ok;
      },
      /** A few rendered frames (and at least `seconds`), so a new scene has drawn before it is shown. */
      async waitFrames(n = 2, seconds = 0) {
        let left = n, t = seconds;
        let f0 = D.frames;
        await task((dt, realDt) => { if (D.frames !== f0) { f0 = D.frames; left--; } t -= realDt; return left <= 0 && t <= 0 ? { value: true } : null; });
      },
      /** The chapter's key frame. In poster mode the tour holds here until app.demo.resume(). */
      async poster(name = '') {
        alive(token);
        if (!D.opts.poster) return;
        D.posterCount++;
        D.poster = { chapter: chapter.id, name, n: D.posterCount };
        setPaused(true, true);
        await task(() => (D.paused ? null : { value: true }));
        D.poster = null;
      },

      // ---- the scripted pointer (assembly chapters)
      pointer: {
        x: 0, y: 0, shown: false,
        show(x, y) { this.shown = true; dom.cursor.classList.add('on'); if (x != null) this.set(x, y); },
        hide() { this.shown = false; dom.cursor.classList.remove('on'); d.pointer.leaveCanvas(); },
        set(x, y) { this.x = x; this.y = y; dom.cursor.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`; },
        /** Glide to a point; with `canvas` the game's canvas receives real pointer-move events on the way. */
        async move(x, y, seconds = 0.6, { canvas = false } = {}) {
          const x0 = this.x, y0 = this.y;
          await d.tween(seconds, k => { this.set(x0 + (x - x0) * k, y0 + (y - y0) * k); if (canvas) d.pointer.send('pointermove'); }, ease.inOut);
        },
        send(type, extra = {}) {
          const c = app.canvas; if (!c) return;
          if (!this.inside) { this.inside = true; try { c.dispatchEvent(new PointerEvent('pointerenter', { clientX: this.x, clientY: this.y, pointerId: 97, pointerType: 'mouse' })); } catch { /* old browser */ } }
          try { c.dispatchEvent(new PointerEvent(type, { clientX: this.x, clientY: this.y, pointerId: 97, pointerType: 'mouse', bubbles: true, buttons: 0, ...extra })); } catch { /* old browser */ }
        },
        leaveCanvas() {
          if (!this.inside) return; this.inside = false;
          try { app.canvas.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 97, pointerType: 'mouse' })); } catch { /* ignore */ }
        },
        async click() { dom.cursor.classList.add('down'); await d.wait(0.12); dom.cursor.classList.remove('down'); },
      },

      // ---- screens
      async goto(name, params = {}) {
        alive(token);
        let timer = 0;
        const timeout = new Promise(r => { timer = setTimeout(() => r('timeout'), 45000); });
        const res = await Promise.race([app.goto(name, params).catch(err => err), timeout]);
        clearTimeout(timer);
        alive(token);
        if (res === 'timeout') throw new Error('the ' + name + ' screen did not open in time');
        if (app.currentName !== name || !app.current) throw new Error('the ' + name + ' screen could not be opened');
        if (app.screens[name] && app.screens[name].placeholder) throw new Error('the ' + name + ' screen is not built yet');
        return app.current;
      },
      /** Hold career.flightState at `json` across the next screen change (a screen that is left writes its own world there). */
      pinFlightState(json) {
        const c = app.career; if (!c) return () => {};
        let done = false;
        try { Object.defineProperty(c, 'flightState', { configurable: true, enumerable: true, get: () => json, set: () => {} }); } catch { c.flightState = json; done = true; }
        const release = () => { if (done) return; done = true; try { Object.defineProperty(c, 'flightState', { configurable: true, enumerable: true, writable: true, value: json }); } catch { /* keep the accessor */ } };
        D.cleanups.push(release);
        return release;
      },
      /** Open the flight screen on a World the chapter prepared. Returns { world, vessel, sim, flight }. */
      async enterFlight(prepared, { vesselId } = {}) {
        alive(token);
        const json = prepared.toJSON();
        const release = d.pinFlightState(json);
        if (app.career) app.career.ut = prepared.ut;
        try { await d.goto('flight', { resume: true, vesselId }); } finally { release(); }
        const flight = app.flight, world = flight && flight.world;
        if (!world) throw new Error('the flight did not start');
        const sim = attachSim(world);
        d.cleanup(() => { try { if (app.flight && app.flight.hud) app.flight.hud.setHidden(false); } catch { /* gone */ } });
        return { world, vessel: world.active, sim, flight };
      },
      attachSim,
      get sim() { return D.sim; },
    };
    return d;
  }

  // ------------------------------------------------------------------ sandbox
  // every key the game owns (save, quicksave, settings, HUD layout…) is recorded at the start and put back at the end
  const ownKeys = () => { const ks = new Set(KEYS); try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('starwright.')) ks.add(k); } } catch { /* storage unavailable */ } return [...ks]; };
  function snapshotStorage() {
    const s = {};
    for (const k of ownKeys()) { try { s[k] = localStorage.getItem(k); } catch { s[k] = undefined; } }
    return s;
  }
  function restoreStorage(s) {
    if (!s) return;
    for (const k of new Set([...Object.keys(s), ...ownKeys()])) {
      try {
        const now = localStorage.getItem(k), was = s[k] === undefined ? null : s[k];
        if (now === was) continue;
        note('storage key ' + k + ' changed during the tour: put back', 'warn');
        if (was == null) localStorage.removeItem(k); else localStorage.setItem(k, was);
      } catch { /* storage unavailable */ }
    }
  }
  function makeCareer() {
    const mod = app.careerModule || {}, Career = app.Career;
    const c = Career.newGame('career', { seed: (D.opts.seed || 20260) >>> 0 });
    // a program a few seasons in: most of the tree researched, a few nodes left to buy on camera
    const tree = mod.TECH_TREE || [];
    const required = new Set(); for (const n of tree) for (const r of n.requires || []) required.add(r);
    const leaves = tree.filter(n => n.id !== 'start' && !required.has(n.id)).sort((a, b) => b.cost - a.cost).slice(0, 3);
    const held = new Set(leaves.map(n => n.id));
    for (const n of tree) if (!held.has(n.id)) c.tech.add(n.id);
    const cheapest = leaves.length ? Math.min(...leaves.map(n => n.cost)) : 0;
    c.science = Math.max(180, Math.round(cheapest * 1.45));
    c.funds = 486500; c.reputation = 44;
    if (c.facilities) for (const id of Object.keys(c.facilities)) c.facilities[id] = mod.FACILITY_MAX || c.facilities[id];
    const xp = [14, 9, 7, 3], flights = [6, 4, 3, 1];
    c.roster.forEach((p, i) => { p.xp = xp[i] || 0; p.flights = flights[i] || 0; });
    try { for (const id of ['first_launch', 'reach_space', 'verda_orbit', 'pell_flyby', 'pell_orbit']) if (mod.milestoneDef && mod.milestoneDef(id) && !c.milestones.has(id)) c.milestones.add(id); } catch { /* optional colour */ }
    try { if (c.contracts && c.contracts.refresh) c.contracts.refresh(); } catch { /* the board can be empty */ }
    c.settings = app.settings;
    c.save = () => true;                       // the sandbox: nothing this program does is ever written
    c.demo = true;
    D.heldTech = [...held];
    return c;
  }

  function setPaused(on, quiet = false) {
    D.paused = !!on;
    if (dom.root) dom.root.classList.toggle('paused', D.paused && !quiet);
    if (dom.playBtn) dom.playBtn.textContent = D.paused ? 'Resume' : 'Pause';
  }

  // ------------------------------------------------------------------ run
  function runCleanups() {
    const list = D.cleanups.splice(0);
    for (const fn of list.reverse()) { try { fn(); } catch (err) { note('cleanup failed: ' + (err && err.message), 'warn'); } }
  }

  async function runChapters(first) {
    let i = first;
    while (D.running && i < CHAPTERS.length) {
      const chapter = CHAPTERS[i];
      D.index = i; D.pendingJump = null;
      const token = ++D.token;
      const st = D.status[i] = { id: chapter.id, title: chapter.title, status: 'running', captions: 0, caption: '', fallbacks: [], error: null, seconds: 0, startClock: D.clock, startReal: D.real, runs: ((D.status[i] && D.status[i].runs) || 0) + 1, runId: (D.runSeq = (D.runSeq || 0) + 1), startWall: performance.now() };
      if (D.watcher) delete D.watcher.W.chapters[chapter.id];   // a restarted chapter is judged on its last run
      showProgress();
      note('chapter ' + chapter.id + ' starts');
      const d = context(token, chapter, st);
      let outcome = 'ok';
      // the limit counts TOUR time (frame time, at most FRAME_MAX a frame, not while paused): a machine that draws
      // slowly gets the same number of tour seconds as a fast one, so a low frame rate can never fail a chapter
      const limit = chapter.limit || 150;
      try {
        const run = Promise.resolve().then(() => { if (D.opts.fail === chapter.id) throw new Error('made to fail (&fail=' + chapter.id + ')'); return chapter.run(d); });
        run.catch(() => {});                                   // an orphaned chapter must not raise an unhandled rejection
        const guard = new Promise((_, reject) => { D.guard = { token, end: D.used + limit, reject: () => reject(new Error('ran out of time (' + limit + ' s of tour time)')) }; });
        guard.catch(() => {});
        await Promise.race([run, guard]);
        outcome = st.fallbacks.length ? 'fallback' : 'ok';
      } catch (err) {
        if (err === ABORT) outcome = 'left';
        else { outcome = 'failed'; st.error = String((err && err.message) || err); note('chapter ' + chapter.id + ' failed: ' + st.error + (err && err.stack ? '\n' + String(err.stack).split('\n').slice(1, 4).join('\n') : ''), 'fail'); }
      }
      D.guard = null;
      closeCaption();
      if (D.token === token) D.token++;                        // stop anything the chapter left running
      D.hold = false;
      runCleanups();
      st.status = outcome; st.seconds = Math.round((D.clock - st.startClock) * 10) / 10; st.realSeconds = Math.round((D.real - st.startReal) * 10) / 10;
      note('chapter ' + chapter.id + ' ' + outcome + ' after ' + st.seconds + ' s');
      try { reportChapter(st); } catch (err) { note('report failed: ' + (err && err.message), 'warn'); }
      if (!D.running) break;
      if (D.pendingJump != null) { i = D.pendingJump; D.shared.previous = null; continue; }
      D.shared.previous = outcome === 'ok' || outcome === 'fallback' ? chapter.id : null;
      if (outcome === 'failed') { dom.caption.classList.remove('show'); }
      i++;
    }
    if (D.running) { D.ended = true; try { reportTotal(); } catch { /* the report is a convenience */ } await finish(); }
  }

  async function finish() {
    if (!D.running) return;
    D.running = false;
    D.token++;
    cancelAnimationFrame(D.raf);
    clearInterval(D.ticker); D.ticker = 0;
    app.fixedStep = 0; app.drawEvery = 1; D.guard = null; D.filmStop = null; D.watch = null;
    for (const t of D.tasks.splice(0)) { t.dead = true; t.reject(ABORT); }
    runCleanups();
    setPaused(false);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    // leave through the title screen with the sandbox program still in place, so no screen writes anywhere else
    try { if (dom.fade) setFade(1); await app.goto('title'); } catch (err) { console.warn('[demo] could not return to the title screen:', err && err.message); }
    if (D.opts.hq) import('./baseview.js').then(m => { if (m.getBaseView) m.getBaseView(app).lockQuality(null); }).catch(() => {});
    app.career = D.prevCareer; app.world = null;
    if (D.prevSettings) { for (const k of Object.keys(app.settings)) if (!(k in D.prevSettings)) delete app.settings[k]; Object.assign(app.settings, D.prevSettings); }
    if (D.prevRandom) { Math.random = D.prevRandom; D.prevRandom = null; }
    restoreStorage(D.storage);
    window.removeEventListener('pagehide', D.onHide);
    document.body.classList.remove('sw-demo');
    clearTimeout(D.stripTimer);
    if (dom.root) { dom.root.remove(); for (const k of Object.keys(dom)) delete dom[k]; }
    if (D.prevCareer && D.prevScreen === 'hub') { try { await app.goto('hub'); } catch { /* the title screen is fine */ } }
    else { try { await app.goto('title'); } catch { /* already there */ } }       // redraw the menu for the real state
    const done = D.finish; D.finish = null;
    if (done) done(api.state());
  }

  const api = {
    get running() { return D.running; },
    get paused() { return D.paused; },
    get posterReady() { return D.poster; },
    chapters: CHAPTERS.map(c => ({ id: c.id, title: c.title })),
    start(opts = {}) {
      if (D.running) return Promise.resolve(api.state());
      if (!app.Career) { app.toast('The demo tour is not ready yet.', 'warn'); return Promise.resolve(null); }
      D.opts = { clean: false, fast: false, hq: false, poster: false, pointer: true, seed: 20260, ...opts };
      let first = 0;
      if (D.opts.chapter != null) { const i = CHAPTERS.findIndex(c => c.id === String(D.opts.chapter)); first = i >= 0 ? i : clamp((Number(D.opts.chapter) | 0) - 1, 0, CHAPTERS.length - 1); }
      window.__demoReport = { chapters: [], total: null }; D.startWall = performance.now(); D.capLog = [];
      Object.assign(D, { running: true, paused: false, ended: false, token: D.token + 1, index: -1, clock: 0, real: 0, tasks: [], cleanups: [], pendingJump: null, shared: {}, log: [], status: [], sim: null, poster: null, posterCount: 0, fadeNow: 0, hold: false, used: 0, guard: null, filmStop: null, filmCount: 0, filmNext: 0, watch: null, capNow: null, capLog: [] });
      D.opts.step = Number.isFinite(+D.opts.step) && +D.opts.step > 0 ? Math.min(+D.opts.step, FRAME_MAX) : 0;
      D.opts.film = Number.isFinite(+D.opts.film) && +D.opts.film > 0 ? +D.opts.film : 0;
      app.fixedStep = D.opts.step;
      D.opts.draw = D.opts.step && D.opts.film && +D.opts.draw > 1 ? Math.round(+D.opts.draw) : 1;      // filming only
      app.drawEvery = D.opts.draw;
      D.watcher = D.opts.watch ? makeWatch() : null;
      D.watch = D.watcher ? D.watcher.tick : null;
      // ---- sandbox
      D.storage = snapshotStorage();
      D.onHide = () => restoreStorage(D.storage);              // closing the tab mid-tour leaves the stored game as it was
      window.addEventListener('pagehide', D.onHide);
      D.prevCareer = app.career; D.prevScreen = app.currentName || 'title';
      // the player's program is set aside untouched (the same object comes back at the end); nothing is saved here
      D.prevSettings = { ...app.settings };
      app.settings.showHints = false;
      if (D.opts.hq) {
        app.settings.gfxForce = true; app.settings.gfxQuality = 'high';
        import('./baseview.js').then(m => { if (D.running && D.opts.hq && m.getBaseView) m.getBaseView(app).lockQuality(0); }).catch(() => {});
      }
      D.prevRandom = Math.random; Math.random = seededRandom(D.opts.seed);
      app.career = makeCareer();
      app.world = null;
      // ---- overlay and input
      document.body.classList.add('sw-demo');
      buildDom();
      setFade(0);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('keyup', onKey, true);
      try { app.input.releaseAll(); } catch { /* fine */ }
      D.last = performance.now(); D.frames = 0;
      D.raf = requestAnimationFrame(frame);
      // accelerated runs (the automated test) must not crawl when the page draws slowly: the tour's clock also ticks on a timer
      if (D.opts.fast && !D.opts.step) { clearInterval(D.ticker); D.ticker = setInterval(() => frame(performance.now(), true), 16); }
      wakeStrip();
      const promise = new Promise(resolve => { D.finish = resolve; });
      runChapters(first).catch(err => { console.error('[demo] the tour stopped:', err); finish(); });
      return promise;
    },
    stop() { if (!D.running) return Promise.resolve(); D.ended = false; return finish(); },
    toggle() { if (D.running) setPaused(!D.paused); },
    pause() { if (D.running) setPaused(true); },
    resume() { if (D.running) { D.filmStop = null; app.drawEvery = D.opts.draw; setPaused(false); } },
    /** Filming (&film=N): set while the tour holds for a picture, every N tour seconds; resume() carries on. */
    get filmReady() { return D.filmStop; },
    /** &watch=1: what the per-frame checks saw, per chapter, and the faults among it ({ chapters, problems }). */
    watchReport,
    jump(to) {
      if (!D.running) return false;
      const i = typeof to === 'number' ? to : CHAPTERS.findIndex(c => c.id === to);
      if (i < 0 || i >= CHAPTERS.length) return false;
      D.pendingJump = i;
      setPaused(false);
      D.token++;                                 // every wait of the running chapter ends now
      return true;
    },
    next() { return D.index + 1 < CHAPTERS.length ? api.jump(D.index + 1) : (api.stop(), true); },
    prev() { return api.jump(Math.max(0, D.index - (D.status[D.index] && D.clock - D.status[D.index].startClock > 4 ? 0 : 1))); },
    state() {
      return {
        running: D.running, paused: D.paused, ended: D.ended, index: D.index, chapter: CHAPTERS[D.index] ? CHAPTERS[D.index].id : null,
        clock: Math.round(D.clock * 10) / 10, real: Math.round(D.real * 10) / 10, fast: !!D.opts.fast,
        caption: dom.capT ? dom.capT.textContent : '', captionShown: !!(dom.caption && dom.caption.classList.contains('show')),
        chapters: CHAPTERS.map((c, i) => ({ id: c.id, title: c.title, ...(D.status[i] || { status: 'pending', captions: 0, fallbacks: [] }) })),
        captionLog: (D.capLog || []).slice(), poster: D.poster, log: D.log.slice(-200), sandbox: !!(app.career && app.career.demo),
      };
    },
  };
  app.demo = api;

  // ---- ?demo=1
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('demo') && q.get('demo') !== '0') {
      const on = k => q.has(k) && q.get(k) !== '0' && q.get(k) !== 'false';
      const opts = { clean: on('clean'), fast: on('fast'), hq: on('hq'), poster: on('poster'), watch: on('watch'), pointer: !(q.has('pointer') && !on('pointer')) };
      if (q.get('chapter')) opts.chapter = q.get('chapter');
      if (q.get('seed') && Number.isFinite(Number(q.get('seed')))) opts.seed = Number(q.get('seed'));
      if (q.get('step')) { const m = /^\s*([\d.]+)\s*(?:\/\s*([\d.]+))?\s*$/.exec(q.get('step')); if (m) opts.step = m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]); }
      if (q.get('film')) opts.film = Number(q.get('film'));
      if (q.get('fail')) opts.fail = q.get('fail');
      if (q.get('draw')) opts.draw = Number(q.get('draw'));
      api.auto = opts;
    }
  } catch { /* no address to read */ }
  return api;
}
