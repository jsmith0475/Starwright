// Starwright — frame-time recorder. No DOM, no three.js: every module may import it (js/render too).
//
// Off by default, and then every call below is one branch. The F3 overlay (js/ui/perf.js) and the ?perf=1
// benchmark (js/ui/perfbench.js) turn it on.
//
//   perf.on                         true while something is recording
//   perf.frameBegin(now)            main loop, top of a frame (now = the rAF timestamp)
//   perf.frameEnd()                 main loop, bottom of a frame
//   perf.begin('sim') … perf.end()  time a section; sections nest and each gets its EXCLUSIVE time
//                                   (terrain work inside the scene update counts as terrain, not as scene)
//   perf.count('chunksBuilt', 1)    event counters, per frame
//   perf.frames                     ring of the last RING frames: { dt, cpu, sim, scene, terrain, render, hud,
//                                   other, async, calls, tris, … }  (ms; dt = time since the previous frame started)
//   perf.summary(n)                 statistics over the last n frames (see below)
//
// Buckets (ms of main-thread time per frame):
//   sim      world.step, autopilot programs                               (JavaScript, pure number crunching)
//   scene    scene/camera/effects update: matrices, particles, uniforms   (JavaScript + three.js objects)
//   terrain  chunk LOD selection, chunk builds that land on this thread, worker results adopted, texture swaps
//   render   renderer.render calls: three.js traversal, sorting, uniform and draw submission to the GPU process
//   hud      DOM and 2D-canvas instrument work
//   other    the rest of the frame callback (input, audio, screen logic)
//   async    main-thread work done between frames by worker replies and timers (already split into the buckets
//            above where it was marked; reported so it is not mistaken for idle time)
// What it cannot see directly: the GPU. `dt − cpu` is the time the main thread was NOT busy: waiting for vsync or
// for the GPU process. The benchmark adds a drained-GPU measurement (see perfbench.js).

const RING = 600;
const BUCKETS = ['sim', 'scene', 'terrain', 'render', 'hud', 'other'];
const now = () => performance.now();

function blank() { const f = { t: 0, dt: 0, cpu: 0, async: 0, calls: 0, tris: 0, lines: 0, points: 0, gc: 0, heap: 0, alloc: 0, gpu: -1, drain: -1, programs: 0, counters: null }; for (const b of BUCKETS) f[b] = 0; return f; }

const frames = []; for (let i = 0; i < RING; i++) frames.push(blank());
const acc = {}; for (const b of BUCKETS) acc[b] = 0;
const counters = {};
const stack = [];                 // open sections: [name, startedAt, childTime]
const drainPx = new Uint8Array(4);
let lastPrograms = -1;
let head = 0, filled = 0, inFrame = false, frameStart = 0, lastStart = 0, asyncAcc = 0, lastHeap = 0;

export const perf = {
  on: false,
  BUCKETS, RING,
  frames,
  counters,
  /** total frames recorded since enable() */
  total: 0,
  /** set by the overlay / benchmark: (frame) => void, called at the end of every recorded frame */
  onFrame: null,
  /** the renderer whose info.render is sampled at frameEnd (set by main.js) */
  renderer: null,
  /** { begin(), end(), ms } GPU timer-query helper while recording (js/ui/perf.js), or null */
  gpuTimer: null,
  /** true: block at the end of each frame until the GPU is done and record the wait as frame.drain (benchmark) */
  drainGL: false,

  enable(v = true) {
    v = !!v;
    if (v === perf.on) return;
    perf.on = v;
    perf.reset();
    const r = perf.renderer;
    // draw calls of the whole frame, not of the last render() call
    if (r && r.info) r.info.autoReset = !v;
  },
  reset() {
    head = 0; filled = 0; perf.total = 0; stack.length = 0; inFrame = false; lastStart = 0; asyncAcc = 0; lastHeap = 0; lastPrograms = -1;
    for (const b of BUCKETS) acc[b] = 0;
    for (const k of Object.keys(counters)) counters[k] = 0;
  },

  begin(name) {
    if (!perf.on) return;
    stack.push(name, now(), 0);
  },
  end() {
    if (!perf.on || stack.length < 3) return;
    const child = stack.pop(), t0 = stack.pop(), name = stack.pop();
    const total = now() - t0, self = total - child;
    acc[name] = (acc[name] || 0) + (self > 0 ? self : 0);
    if (stack.length) stack[stack.length - 1] += total;        // the parent does not count this time again
    else if (!inFrame) asyncAcc += total;
  },
  /** time fn() as a section (for one-off call sites; hot paths use begin/end to avoid the closure) */
  wrap(name, fn) { if (!perf.on) return fn(); perf.begin(name); try { return fn(); } finally { perf.end(); } },
  count(name, n = 1) { if (perf.on) counters[name] = (counters[name] || 0) + n; },

  frameBegin(t) {
    if (!perf.on) return;
    frameStart = now();
    inFrame = true;
    stack.length = 0;
    const r = perf.renderer;
    if (r && r.info) { r.info.reset(); lastPrograms = r.info.programs ? r.info.programs.length : 0; }
    if (perf.gpuTimer) perf.gpuTimer.begin();
  },
  frameEnd() {
    if (!perf.on || !inFrame) return;
    inFrame = false;
    const end = now(), f = frames[head];
    f.t = frameStart;
    f.dt = lastStart ? frameStart - lastStart : 0;
    lastStart = frameStart;
    f.cpu = end - frameStart;
    let marked = 0;
    for (const b of BUCKETS) { if (b !== 'other') { f[b] = acc[b]; marked += acc[b]; } acc[b] = 0; }
    // work marked between frames (worker replies) is in the buckets but not in this callback's own time
    f.async = asyncAcc; asyncAcc = 0;
    f.other = Math.max(0, f.cpu - (marked - f.async));
    f.cpu += f.async;
    const r = perf.renderer;
    if (r && r.info) {
      const ri = r.info.render; f.calls = ri.calls; f.tris = ri.triangles; f.lines = ri.lines; f.points = ri.points;
      // shader programs created inside this frame: each one is compiled and linked while the frame waits
      // (programs pre-compiled between frames, flightscene.prewarm, do not count)
      const np = r.info.programs ? r.info.programs.length : 0;
      f.programs = lastPrograms >= 0 && np > lastPrograms ? np - lastPrograms : 0;
    }
    // heap: only meaningful when Chrome reports it precisely (see perf.heapPrecise)
    // (the getter itself costs a fraction of a millisecond: sampled every 8th frame)
    f.heap = 0; f.gc = 0; f.alloc = 0;
    if ((perf.total & 7) === 0) {
      const mem = typeof performance !== 'undefined' && performance.memory ? performance.memory.usedJSHeapSize : 0;
      f.heap = mem; f.gc = lastHeap && mem < lastHeap - 262144 ? lastHeap - mem : 0;
      f.alloc = lastHeap && mem > lastHeap ? mem - lastHeap : 0;
      lastHeap = mem;
    }
    f.gpu = -1; f.drain = -1;
    if (perf.gpuTimer) perf.gpuTimer.end();
    // benchmark only: wait until the GPU has finished this frame's commands and time the wait
    if (perf.drainGL && r) {
      try { const gl = r.getContext(), t0 = now(); gl.finish(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, drainPx); f.drain = now() - t0; } catch { f.drain = -1; }
    }
    f.counters = null;
    let any = false; for (const k in counters) if (counters[k]) { any = true; break; }
    if (any) { f.counters = { ...counters }; for (const k in counters) counters[k] = 0; }
    head = (head + 1) % RING; if (filled < RING) filled++;
    perf.total++;
    if (perf.onFrame) { try { perf.onFrame(f); } catch { /* the recorder never breaks a frame */ } }
  },

  /** the last n recorded frames, oldest first */
  last(n = RING) {
    n = Math.min(n, filled);
    const out = [];
    for (let i = n; i > 0; i--) out.push(frames[(head - i + RING * 2) % RING]);
    return out;
  },

  /**
   * Statistics over the last n frames:
   * { frames, fps, dt: {avg, p50, p95, p99, max}, cpu: {…}, sim/scene/terrain/render/hud/other/async: avg ms,
   *   calls, tris (avg and max), long33, long50 (frames whose interval exceeded 33.4 / 50 ms), worst (ms),
   *   hitches: frames slower than 2.5× the median interval, gcCount, gcMB, allocMBs }
   */
  summary(n = RING) {
    const fs = perf.last(n).filter(f => f.dt > 0);
    const s = { frames: fs.length };
    if (!fs.length) return s;
    const stat = key => {
      const a = fs.map(f => f[key]).sort((x, y) => x - y), q = p => a[Math.min(a.length - 1, Math.floor(p * a.length))];
      return { avg: a.reduce((x, y) => x + y, 0) / a.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: a[a.length - 1] };
    };
    s.dt = stat('dt'); s.cpu = stat('cpu');
    s.fps = 1000 / s.dt.avg;
    for (const b of [...BUCKETS, 'async']) s[b] = stat(b).avg;
    const calls = stat('calls'), tris = stat('tris');
    s.calls = Math.round(calls.avg); s.callsMax = calls.max; s.tris = Math.round(tris.avg); s.trisMax = tris.max;
    s.long33 = fs.filter(f => f.dt > 33.4).length; s.long50 = fs.filter(f => f.dt > 50).length;
    s.worst = s.dt.max; s.worstCpu = s.cpu.max;
    s.hitches = fs.filter(f => f.dt > Math.max(2.5 * s.dt.p50, s.dt.p50 + 12)).length;
    const secs = fs.reduce((x, f) => x + f.dt, 0) / 1000;
    s.gcCount = fs.filter(f => f.gc > 0).length;
    s.gcMB = fs.reduce((x, f) => x + f.gc, 0) / 1048576;
    s.allocMBs = secs > 0 ? fs.reduce((x, f) => x + (f.alloc || 0), 0) / 1048576 / secs : 0;
    const gpu = fs.filter(f => f.gpu >= 0).map(f => f.gpu);
    s.gpu = gpu.length ? gpu.reduce((x, y) => x + y, 0) / gpu.length : -1;
    const drain = fs.filter(f => f.drain >= 0).map(f => f.drain).sort((x, y) => x - y);
    s.drain = drain.length ? drain[Math.floor(drain.length / 2)] : -1;
    const cs = {};
    for (const f of fs) if (f.counters) for (const k in f.counters) cs[k] = (cs[k] || 0) + f.counters[k];
    s.counters = cs;
    s.programs = fs.reduce((x, f) => x + (f.programs || 0), 0);
    // the slowest frame of the window, with what was in it (for "what was that hitch?")
    const w = fs.reduce((a, f) => (f.dt > a.dt ? f : a), fs[0]);
    s.worstFrame = { dt: w.dt, cpu: w.cpu, sim: w.sim, scene: w.scene, terrain: w.terrain, render: w.render, hud: w.hud, other: w.other, programs: w.programs || 0, counters: w.counters || null };
    return s;
  },
};

export default perf;
