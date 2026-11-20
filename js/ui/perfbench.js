// Starwright — the ?perf=1 benchmark: a fixed set of scenes, a fixed number of frames each, one table at the end.
//
// Address parameters:  ?perf=1            run it once the title screen is up
//                      &frames=<n>        frames measured per scene (default 240: four seconds at 60 fps)
//                      &warm=<n>          frames drawn before measuring starts (default 45; terrain is also waited for)
//                      &scenes=a,b,c      only these scene ids (see SCENES below)
//                      &hq=1              force full quality on a software renderer (the cloud test machine)
//                      &quality=low|medium|high   use this detail setting instead of the saved one
//                      &gov=1             leave the automatic quality governor on (default: off, so the numbers
//                                         are those of the chosen quality and not of what the governor made of it)
//                      &drain=0           skip the GPU-drain pass
//
// What one scene's row means (all times in milliseconds per frame, averaged over the measured frames):
//   frame     time from one frame to the next (what the player sees: 16.7 = 60 fps), with the 95th percentile and
//             the worst frame
//   main      main-thread time the game spent on the frame, split into sim / scene / terrain / render / hud / other
//             (js/perf.js explains each bucket). This is all JavaScript and is the ONLY part Rust/WASM could touch,
//             and of it only `sim` and worker-side terrain are number crunching rather than three.js and DOM calls.
//   gpu wait  a second pass of 30 frames in which the game waits, after drawing, until the graphics card has
//             finished (gl.finish + a 1-pixel read-back) and times the wait. A lower bound for the GPU's share:
//             the card already works while the frame is being submitted.
//   draws / tris   renderer.info for the whole frame (shadow pass and post passes included)
//   >33 ms    frames in the measured window that took longer than two 60 Hz refreshes
//   arrive    the scene's arrival: time to open the screen, the worst frame while terrain and textures streamed in,
//             and how many chunks / textures landed
//
// The benchmark runs on its own throw-away Career (never saved) and puts the browser's stored game back when it
// ends, exactly like the demo tour.
import { perf } from '../perf.js';
import { el } from './dom.js';
import { SYSTEM } from '../core/bodies.js';
import { stockCrafts } from '../core/craft.js';
import { World } from '../core/world.js';
import * as THREE from '../lib/three.module.min.js';
import * as K from './demo/kit.js';
import { SCENES as CUTS } from './demo/scenes.js';

const CSS = `
.sw-bench { position: fixed; inset: 0; z-index: 9500; display: flex; align-items: flex-start; justify-content: center; pointer-events: none; }
.sw-bench .bar { margin-top: 10px; padding: 7px 14px; background: rgba(11, 15, 20, 0.88); border: 1px solid rgba(57, 208, 192, 0.5); border-radius: 4px;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #d8e6ee; }
.sw-bench .bar b { color: #39d0c0; }
.sw-bench.done { background: rgba(8, 11, 15, 0.94); pointer-events: auto; overflow: auto; align-items: flex-start; }
.sw-bench .card { margin: 18px; padding: 16px 20px; background: #141a22; border: 1px solid #2b3846; border-radius: 6px; max-width: calc(100vw - 36px); }
.sw-bench h2 { margin: 0 0 4px; font: 600 17px system-ui, sans-serif; color: #e9f2f6; }
.sw-bench p { margin: 4px 0 10px; font: 12.5px/1.45 system-ui, sans-serif; color: #9fb1bd; max-width: 1100px; }
.sw-bench pre { margin: 0; padding: 12px 14px; background: #0b0f14; border: 1px solid #2b3846; border-radius: 4px; color: #d8e6ee; overflow: auto;
  font: 11.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; user-select: text; -webkit-user-select: text; }
.sw-bench .row { display: flex; gap: 8px; margin: 12px 0 0; }
`;

const f1 = x => (Number.isFinite(x) && x >= 0 ? x.toFixed(1) : '–');
const f2 = x => (Number.isFinite(x) && x >= 0 ? x.toFixed(2) : '–');
const big = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const Y = new THREE.Vector3(0, 1, 0);

export function createBenchmark(app, api, opts = {}) {
  const FRAMES = Math.max(5, Math.min(perf.RING - 10, opts.frames | 0 || 240));
  const WARM = Math.max(2, opts.warm | 0 || 45);
  const DRAIN = opts.drain === false ? 0 : Math.max(5, Math.min(30, Math.round(FRAMES / 8)));
  let frameHook = null, tally = null, dom = null, storage = null, prev = null;
  const log = [];

  // ------------------------------------------------------------------ helpers
  /** resolve after `n` drawn frames (or when `until()` says so); `each(frame)` sees every one */
  function frames(n, { until = null, each = null, maxMs = 120000 } = {}) {
    return new Promise(resolve => {
      let seen = 0; const t0 = performance.now();
      const timer = setInterval(() => { if (performance.now() - t0 > maxMs) done('timeout'); }, 500);
      function done(why) { clearInterval(timer); if (frameHook === hook) frameHook = null; resolve(why); }
      function hook(f) {
        seen++;
        if (each) { try { each(f, seen); } catch (err) { console.warn('[perf] frame hook failed:', err && err.message); } }
        if (seen >= n) return done('frames');
        if (until) { let ok = false; try { ok = until(seen); } catch { ok = false; } if (ok) done('until'); }
      }
      frameHook = hook;
    });
  }
  const flightBusy = () => { const v = app.flight && app.flight.view, w = v && v.worlds; return !!(w && w.info && w.info.busy); };

  async function gotoFlight(prepared, { vesselId } = {}) {
    const json = prepared.toJSON(), c = app.career;
    // (the screen that is being left writes its own world into career.flightState: pin ours across the change)
    Object.defineProperty(c, 'flightState', { configurable: true, enumerable: true, get: () => json, set: () => {} });
    c.ut = prepared.ut;
    try { await app.goto('flight', { resume: true, vesselId }); }
    finally { Object.defineProperty(c, 'flightState', { configurable: true, enumerable: true, writable: true, value: json }); }
    if (app.currentName !== 'flight' || !app.flight) throw new Error('the flight screen did not open');
    const g = app.flight.view && app.flight.view.governor;
    if (g && !opts.gov) g.lock(0);
    if (app.flight.view && app.flight.view.applySettings) app.flight.view.applySettings();
    return { world: app.flight.world, vessel: app.flight.world.active, flight: app.flight };
  }
  /** run the game faster than real time (extra update() calls per drawn frame) until `cond`, at most `maxMs` */
  async function advance(cond, maxMs = 40000) {
    await frames(1e9, {
      maxMs,
      until: () => cond(),
      each: () => {
        const t0 = performance.now();
        while (performance.now() - t0 < 12 && app.currentName === 'flight' && !cond()) { app.current.update(0.05); app.input.endFrame(); }
      },
    });
  }
  const stock = name => { const c = K.stock(name); if (!c) throw new Error('stock design "' + name + '" is missing'); return c; };

  // ------------------------------------------------------------------ the scenes
  const SCENES = [
    { id: 'centre', title: 'Space centre (hub)', async setup() {
      await app.goto('hub', { fresh: true });
      if (!opts.gov || opts.hq) { try { const m = await import('./baseview.js'); if (m.getBaseView) m.getBaseView(app).lockQuality(0); } catch { /* older hub */ } }
    } },
    { id: 'builder', title: 'Assembly, 39-part Farwind', async setup() {
      const big = stockCrafts().slice().sort((a, b) => b.parts.length - a.parts.length)[0];
      await app.goto('builder', { craft: big.toJSON(), ...(opts.hq ? { quality: 'high' } : {}) });
      this.title = 'Assembly, ' + big.parts.length + '-part ' + big.name;
    } },
    { id: 'pad', title: 'On the pad (Ember Twin)', async setup() { await gotoFlight(CUTS.padLaunch().world); } },
    { id: 'ascent', title: 'Ascent, 1 to 6 km, full thrust', async setup() {
      const { world, flight } = await gotoFlight(CUTS.padLaunch().world);
      flight.actions.toggleAssist();
      await advance(() => { const v = world.active; return !v || v.dead || v.altitude > 1200; }, 60000);
    } },
    { id: 'orbit', title: 'Orbit, 85 km over Verda', async setup() { await gotoFlight(CUTS.orbitScene().world); } },
    { id: 'map', title: 'Map view (from that orbit)', async setup() {
      const { flight } = await gotoFlight(CUTS.orbitScene().world);
      await frames(5);
      if (!flight.mapOpen) flight.actions.toggleMap(true);
    } },
    { id: 'pell', title: 'Landing on Pell, 1.7 km up', async setup() {
      const { vessel } = await gotoFlight(CUTS.pellDescent().world);
      vessel.ctrl.throttle = 0.35;
    } },
    { id: 'plane', title: 'Plane over the base, 300 m', async setup() {
      const { world, vessel } = await gotoFlight(CUTS.runwayScene('Kite Trainer').world);
      const b = SYSTEM.home, dir = SYSTEM.launchSite.dir;
      const up = b.surfaceDirToInertial(dir, world.ut, new THREE.Vector3()).normalize();
      const east = new THREE.Vector3().crossVectors(Y, up).normalize(), north = new THREE.Vector3().crossVectors(up, east);
      const pos = up.clone().multiplyScalar(b.radius + b.terrainHeight(dir) + 300).addScaledVector(east, -900).addScaledVector(north, -250);
      const wy = (Math.PI * 2) / b.rotPeriod;
      const vel = new THREE.Vector3(wy * pos.z, 0, -wy * pos.x).addScaledVector(east, 85);
      const right = new THREE.Vector3().crossVectors(east, up);
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, east, up));
      K.teleport(world, vessel, b, { pos, vel, q });
      if (typeof vessel.setGear === 'function') vessel.setGear(false);
      vessel.ctrl.brake = false; vessel.ctrl.throttle = 1; vessel.ctrl.sas = true;
      for (const e of vessel.engines || []) e.part.ignited = true;
    } },
    { id: 'reentry', title: 'Re-entry, capsule at 44 km', async setup() { await gotoFlight(CUTS.reentryScene().world); } },
    { id: 'rover', title: 'Rover on Rusk', async setup() { await gotoFlight(CUTS.roverScene().world); } },
    { id: 'docking', title: 'Docking, two ships at 45 m', async setup() { await gotoFlight(CUTS.dockScene().world); } },
    { id: 'tracking', title: 'Tracking station, 8 flights', async setup() {
      const w = CUTS.fleetWorld().world, json = w.toJSON(), c = app.career;
      c.ut = w.ut; c.flightState = json;
      await app.goto('tracking');
    } },
  ];
  // the demo tour's chapters these scenes stand for (the heaviest of them is named in the summary)
  const DEMO_OF = { centre: 'centre', builder: 'build', pad: 'launch', ascent: 'launch / orbit', orbit: 'orbit', map: 'map', pell: 'landing', plane: 'plane', reentry: 'reentry', rover: 'rover', docking: 'docking', tracking: 'tracking' };

  // ------------------------------------------------------------------ sandbox
  const ownKeys = () => { const ks = new Set(); try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('starwright.')) ks.add(k); } } catch { /* no storage */ } return [...ks]; };
  function snapshot() { const s = {}; for (const k of ownKeys()) { try { s[k] = localStorage.getItem(k); } catch { /* skip */ } } return s; }
  function restore(s) {
    if (!s) return;
    for (const k of new Set([...Object.keys(s), ...ownKeys()])) {
      try { const was = s[k] == null ? null : s[k]; if (localStorage.getItem(k) === was) continue; if (was == null) localStorage.removeItem(k); else localStorage.setItem(k, was); } catch { /* skip */ }
    }
  }
  function makeCareer() {
    const mod = app.careerModule || {}, c = app.Career.newGame('sandbox');
    try { for (const n of mod.TECH_TREE || []) c.tech.add(n.id); } catch { /* sandbox has everything anyway */ }
    c.settings = app.settings;
    c.save = () => true;                    // nothing the benchmark does is ever written
    c.demo = true;
    return c;
  }

  // ------------------------------------------------------------------ report
  function report(res) {
    const e = res.env, L = [];
    L.push('STARWRIGHT PERFORMANCE BENCHMARK   ' + res.date);
    L.push('GPU       ' + e.gpu + (e.software ? '   [SOFTWARE RENDERER: no graphics card in use]' : ''));
    L.push('Browser   ' + e.ua);
    L.push(`Display   canvas ${e.canvas} CSS px, devicePixelRatio ${e.dpr}, drawn at ratio ${f2(e.pixelRatio)} = ${e.buffer} device px` + (res.sceneTarget ? `; flight scene target ${res.sceneTarget}` : ''));
    L.push(`Machine   ${e.cores} logical cores` + (e.memoryGB ? `, ${e.memoryGB}+ GB` : '') + `, ${e.platform}`);
    L.push(`Settings  detail ${res.quality}${e.settings && e.settings.forced ? ' (forced)' : ''}, shadows ${e.settings && e.settings.shadows ? 'on' : 'off'}, bloom ${e.settings ? e.settings.bloom : '?'}, lens ${e.settings && e.settings.lens ? 'on' : 'off'}, automatic quality ${res.governor ? 'ON (numbers include what it changed)' : 'held off for the test'}`);
    L.push(`Run       ${res.frames} frames per scene after ${res.warm}+ warm-up frames; times are milliseconds per frame; 16.7 ms = 60 fps`);
    L.push('');
    const cols = [
      ['scene', 31, r => r.title], ['fps', 6, r => f1(r.fps)], ['frame', 6, r => f1(r.dt.avg)], ['p95', 6, r => f1(r.dt.p95)], ['worst', 6, r => f1(r.worst)],
      ['|', 1, () => '|'], ['main', 6, r => f1(r.cpu.avg)], ['sim', 5, r => f2(r.sim)], ['scene', 5, r => f2(r.scene)], ['terr', 5, r => f2(r.terrain)], ['render', 6, r => f2(r.render)], ['hud', 5, r => f2(r.hud)], ['other', 5, r => f2(r.other)],
      ['|', 1, () => '|'], ['gpu wait', 8, r => f1(r.drain)], ['gpu tq', 6, r => f1(r.gpu)], ['draws', 6, r => String(r.calls)], ['tris', 6, r => big(r.tris)], ['>33ms', 5, r => String(r.long33)],
      ['|', 1, () => '|'], ['open ms', 7, r => String(Math.round(r.arrive.openMs))], ['arr.worst', 9, r => f1(r.arrive.worst)], ['arr.main', 8, r => f1(r.arrive.worstCpu)], ['shaders', 7, r => String(r.arrive.programs)], ['late', 4, r => String(r.arrive.late + (r.programs || 0))], ['chunks', 6, r => String(r.arrive.chunks)], ['onmain', 6, r => String(r.arrive.chunksMain)], ['tex', 4, r => String(r.arrive.textures)],
    ];
    const line = cells => cells.map((c, i) => (i === 0 ? String(c).padEnd(cols[i][1]) : String(c).padStart(cols[i][1]))).join(' ');
    L.push(line(cols.map(c => c[0])));
    L.push(line(cols.map(c => '-'.repeat(c[1]))));
    for (const r of res.scenes) L.push(r.error ? (r.title.padEnd(31) + ' FAILED: ' + r.error) : line(cols.map(c => c[2](r))));
    L.push('');
    const slowRows = res.scenes.filter(r => !r.error && r.worstFrame && r.worstFrame.dt > Math.max(30, 2 * r.dt.p50));
    if (slowRows.length) {
      L.push('Slowest measured frame per scene, where it stood out (ms): what the main thread was doing in it');
      for (const r of slowRows) {
        const w = r.worstFrame;
        L.push('  ' + r.title.padEnd(31) + ` ${f1(w.dt).padStart(6)}  main ${f1(w.cpu)}: sim ${f1(w.sim)} scene ${f1(w.scene)} terrain ${f1(w.terrain)} render ${f1(w.render)} hud ${f1(w.hud)} other ${f1(w.other)}` + (w.programs ? `; ${w.programs} shader(s) compiled` : '') + (w.counters ? '; ' + Object.keys(w.counters).map(k => k + ' ' + w.counters[k]).join(', ') : ''));
      }
      L.push('');
    }
    const ok = res.scenes.filter(r => !r.error);
    if (ok.length) {
      const slow = ok.slice().sort((a, b) => b.dt.avg - a.dt.avg)[0], busy = ok.slice().sort((a, b) => b.cpu.avg - a.cpu.avg)[0];
      L.push(`Slowest scene: ${slow.title} (${f1(slow.dt.avg)} ms a frame; demo chapter "${DEMO_OF[slow.id] || slow.id}").   Most main-thread work: ${busy.title} (${f1(busy.cpu.avg)} ms).`);
      const avg = k => ok.reduce((s, r) => s + (typeof r[k] === 'object' ? r[k].avg : r[k]), 0) / ok.length;
      const dt = avg('dt'), cpu = avg('cpu');
      L.push(`Average over scenes: frame ${f1(dt)} ms, of which main thread ${f1(cpu)} ms (${Math.round(100 * cpu / dt)}%): sim ${f2(avg('sim'))}, scene ${f2(avg('scene'))}, terrain ${f2(avg('terrain'))}, render ${f2(avg('render'))}, hud ${f2(avg('hud'))}, other ${f2(avg('other'))}.`);
      L.push(`The rest (${f1(Math.max(0, dt - cpu))} ms, ${Math.round(100 * Math.max(0, dt - cpu) / dt)}%) is the graphics card and waiting for the display's refresh.`);
    }
    L.push('');
    L.push('Columns: fps and frame/p95/worst = what you see.  main = game code on the main thread, split into');
    L.push('sim (physics, autopilot), scene (objects, particles, camera), terr (terrain LOD and chunks), render');
    L.push('(three.js submitting the frame), hud (instruments, DOM), other.  gpu wait = extra wait until the');
    L.push('graphics card had finished the frame (separate pass).  gpu tq = GPU timer query, where the browser');
    L.push('offers one.  draws/tris = draw calls and triangles per frame.  >33ms = slow frames in the window.');
    L.push('open ms = time to open the scene.  arr.worst = worst frame while terrain/textures streamed in,');
    L.push('arr.main = the most main-thread time one of those frames took; shaders = shader programs compiled for the scene, late = how many of them inside a drawn frame (a hitch each);');
    L.push('chunks / onmain = terrain chunks that arrived (from workers / built on the main thread); tex = texture swaps.');
    return L.join('\n');
  }

  function showResults(res) {
    dom.root.classList.add('done');
    dom.root.textContent = '';
    const pre = el('pre', { text: res.text, attrs: { 'data-perf': 'report' } });
    const copy = el('button', { class: 'sw-btn primary', text: 'Copy as text', attrs: { type: 'button', 'data-perf': 'copy' }, on: { click: async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(res.text + '\n\nJSON\n' + JSON.stringify(res.json)); ok = true; } catch { ok = false; }
      if (!ok) { const r = document.createRange(); r.selectNodeContents(pre); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); try { ok = document.execCommand('copy'); } catch { ok = false; } }
      copy.textContent = ok ? 'Copied' : 'Select the text and copy it';
    } } });
    const again = el('button', { class: 'sw-btn', text: 'Run again', attrs: { type: 'button' }, on: { click: () => window.location.reload() } });
    const close = el('button', { class: 'sw-btn', text: 'Close', attrs: { type: 'button', 'data-perf': 'close' }, on: { click: () => { dom.root.remove(); } } });
    dom.root.appendChild(el('div', { class: 'card' },
      el('h2', { text: 'Starwright performance benchmark: done' }),
      el('p', { text: 'Take a screenshot of this table, or press "Copy as text" and paste it into a message (the copy also carries the raw numbers). The game was not saved or changed by this test.' }),
      pre, el('div', { class: 'row' }, copy, again, close)));
  }

  // ------------------------------------------------------------------ sandbox in, sandbox out
  let onHide = null;
  function sandbox() {
    if (prev) return;
    storage = snapshot();
    onHide = () => restore(storage);
    window.addEventListener('pagehide', onHide);
    prev = { career: app.career, settings: { ...app.settings }, random: Math.random };
    Math.random = K.seededRandom(20260);
    app.settings.showHints = false;
    if (opts.hq) app.settings.gfxForce = true;
    if (opts.quality && ['low', 'medium', 'high'].includes(opts.quality)) app.settings.gfxQuality = opts.quality;
    else if (opts.hq) app.settings.gfxQuality = 'high';
    if (!opts.gov) app.settings.gfxAuto = false;
    app.career = makeCareer(); app.world = null;
    try { app.audio.setVolume({ sfx: 0, music: 0 }); } catch { /* silent already */ }
  }
  /** leave everything as it was */
  async function leave() {
    if (!prev) return;
    frameHook = null;
    try { await app.goto('title'); } catch { /* stay */ }
    try { const m = await import('./baseview.js'); if (m.getBaseView && app.renderer) m.getBaseView(app).lockQuality(null); } catch { /* older hub */ }
    app.career = prev.career; app.world = null;
    for (const k of Object.keys(app.settings)) if (!(k in prev.settings)) delete app.settings[k];
    Object.assign(app.settings, prev.settings);
    Math.random = prev.random;
    try { app.applySettings(); } catch { /* fine */ }
    restore(storage);
    window.removeEventListener('pagehide', onHide);
    prev = null;
    try { await app.goto('title'); } catch { /* stay */ }
  }
  /** Open one benchmark scene and leave it running (tools: tests/tools/perf_split.mjs). close() puts the game back. */
  async function open(id) {
    const scene = SCENES.find(s => s.id === id);
    if (!scene) throw new Error('no benchmark scene "' + id + '"');
    sandbox();
    await scene.setup();
    await frames(1e9, { maxMs: 25000, until: (() => { let quiet = 0; return n => { quiet = flightBusy() ? 0 : quiet + 1; return n >= 10 && quiet >= 8; }; })() });
    return scene.title;
  }

  // ------------------------------------------------------------------ run
  async function measure(scene, index, total) {
    const say = t => { dom.bar.innerHTML = `<b>Benchmark ${index + 1}/${total}</b>  ${scene.title}  ·  ${t}`; };
    const out = { id: scene.id, title: scene.title };
    say('opening…');
    for (const k of Object.keys(perf.counters)) perf.counters[k] = 0;
    const hook = typeof window.__perfHook === 'function' ? window.__perfHook : null;
    const programs0 = app.renderer && app.renderer.info.programs ? app.renderer.info.programs.length : 0;
    if (hook) { try { await hook(scene.id, 'arrive-begin'); } catch { /* tool gone */ } }
    // chunks, texture swaps and late shader compiles are counted from here: what opening the scene costs includes
    // the frames drawn while it opens
    const arrive = { openMs: 0, worst: 0, worstCpu: 0, frames: 0, chunks: 0, chunksMain: 0, textures: 0, ms: 0, cpuSum: 0, programs: 0, late: 0, texMax: 0 };
    tally = f => { const c = f.counters || {}; arrive.late += f.programs || 0; arrive.texMax = Math.max(arrive.texMax, c.textureSwaps || 0); arrive.chunks += c.chunksFromWorkers || 0; arrive.chunksMain += c.chunksBuiltOnMain || 0; arrive.textures += c.textureSwaps || 0; };
    const t0 = performance.now();
    try { await scene.setup(); } catch (err) { tally = null; throw err; }
    out.title = scene.title;
    const openMs = performance.now() - t0;
    // ---- arrival: draw until the terrain and textures are in (and at least WARM frames); remember the worst frame
    arrive.openMs = openMs;
    const ta = performance.now();
    let quiet = 0;
    await frames(1e9, {
      maxMs: 25000,
      each: (f, n) => {
        say('settling ' + n);
        if (n > 2) { arrive.worst = Math.max(arrive.worst, f.dt); arrive.worstCpu = Math.max(arrive.worstCpu, f.cpu); }
        arrive.cpuSum += f.cpu;
        arrive.frames = n;
        quiet = flightBusy() ? 0 : quiet + 1;
      },
      until: n => n >= WARM && quiet >= 10,
    });
    arrive.ms = performance.now() - ta;
    tally = null;
    arrive.programs = (app.renderer && app.renderer.info.programs ? app.renderer.info.programs.length : 0) - programs0;
    if (hook) { try { arrive.tool = await hook(scene.id, 'arrive-end', arrive.frames); } catch { /* tool gone */ } }
    out.arrive = arrive;
    if (scene.during) scene.during();
    // ---- the measured window (window.__perfHook: the test tools start and stop their CPU profiler / counters here)
    say('measuring');
    if (hook) { try { await hook(scene.id, 'begin'); } catch { /* tool gone */ } await frames(2); }
    perf.reset();
    await frames(FRAMES + 1, { each: (f, n) => { if (n % 10 === 0) say('measuring ' + n + '/' + FRAMES); }, maxMs: 600000 });
    Object.assign(out, perf.summary(FRAMES));
    if (hook) { try { out.tool = await hook(scene.id, 'end', FRAMES + 1); } catch { /* tool gone */ } }
    const e = api.env();
    out.sceneTarget = e.sceneTarget || ''; out.buffer = e.buffer; out.flightQuality = e.flightQuality || ''; out.governor = e.governor || null;
    try { const m = app.renderer.info.memory; out.geometries = m.geometries; out.textures = m.textures; } catch { /* no renderer */ }
    const view = app.flight && app.flight.view, wi = view && view.worlds && view.worlds.info;
    if (wi) out.world = { chunks: wi.chunks, drawn: wi.drawn, terrainTris: wi.triangles, clutter: wi.clutter, clutterTris: wi.clutterTriangles };
    // what is on screen, by owner: visible meshes (one draw call each per material group; casters are drawn
    // again into the shadow map) under each top-level object of the two flight scenes
    if (view) {
      const census = root => {
        const out = {};
        for (const top of root.children) {
          let n = 0, tris = 0, cast = 0;
          const walk = o => {
            if (!o.visible) return;
            if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && o.geometry) {
              const k = Array.isArray(o.material) ? Math.max(1, o.geometry.groups.length) : 1;
              n += k; if (o.castShadow) cast += k;
              const g = o.geometry, cnt = g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0;
              tris += (cnt / 3) * (o.isInstancedMesh ? o.count : 1);
            }
            for (const c of o.children) walk(c);
          };
          walk(top);
          if (n) { const key = (top.name || top.type).replace(/_\d+$/, ''); const e = out[key] || (out[key] = { meshes: 0, tris: 0, casters: 0 }); e.meshes += n; e.tris += Math.round(tris); e.casters += cast; }
        }
        return out;
      };
      try { out.census = { near: census(view.near), far: census(view.far) }; } catch { /* scene gone */ }
      // transparent double-sided materials three.js draws in two passes (back faces, then front faces: two draw
      // calls and two program look-ups per mesh per frame); craft decals, glows and plumes must not be among them
      try {
        const two = new Map();
        view.near.traverse(o => { for (const m of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) if (m.transparent && m.side === 2 && !m.forceSinglePass) two.set(m.name || m.type, (two.get(m.name || m.type) || 0) + 1); });
        out.twoPass = Object.fromEntries(two);
      } catch { /* scene gone */ }
    }
    // ---- GPU drain pass
    if (DRAIN) {
      say('GPU wait pass');
      perf.reset(); perf.drainGL = true;
      await frames(DRAIN + 1, { maxMs: 120000 });
      perf.drainGL = false;
      out.drain = perf.summary(DRAIN).drain;
    } else out.drain = -1;
    return out;
  }

  async function run() {
    if (!document.getElementById('sw-bench-css')) { const st = document.createElement('style'); st.id = 'sw-bench-css'; st.textContent = CSS; document.head.appendChild(st); }
    dom = { root: el('div', { class: 'sw-bench', attrs: { 'data-perf': 'bench' } }) };
    dom.bar = el('div', { class: 'bar', text: 'Benchmark starting…' });
    dom.root.appendChild(dom.bar);
    document.body.appendChild(dom.root);
    document.body.dataset.perf = 'running';

    sandbox();

    const only = String(opts.only || '').split(',').map(s => s.trim()).filter(Boolean);
    const list = SCENES.filter(s => !only.length || only.includes(s.id));
    const res = { date: new Date().toISOString(), frames: FRAMES, warm: WARM, governor: !!opts.gov, quality: app.settings.gfxQuality, scenes: [] };
    for (let i = 0; i < list.length; i++) {
      let row;
      try { row = await measure(list[i], i, list.length); }
      catch (err) { console.error('[perf] scene ' + list[i].id + ' failed:', err); row = { id: list[i].id, title: list[i].title, error: String(err && err.message || err) }; }
      res.scenes.push(row);
      if (row.sceneTarget) res.sceneTarget = row.sceneTarget;
      if (row.flightQuality) res.flightQuality = row.flightQuality;
      log.push(row);
    }
    res.env = api.env();
    if (res.flightQuality && res.flightQuality !== res.quality) res.quality = res.quality + ' (drawn as "' + res.flightQuality + '")';

    await leave();

    res.json = { date: res.date, env: res.env, frames: FRAMES, quality: res.quality, governor: res.governor, scenes: res.scenes };
    res.text = report(res);
    showResults(res);
    document.body.dataset.perf = 'done';
    return res;
  }

  return { run, open, close: leave, onFrame(f) { if (tally) tally(f); if (frameHook) frameHook(f); }, SCENES };
}
