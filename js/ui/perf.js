// Starwright — frame-time overlay (F3) and the entry point of the ?perf=1 benchmark.
//
//   installPerf(app)       called once from main.js; adds app.perf and the F3 key
//   app.perf.toggle()      show / hide the overlay (also: F3, or ?fps=1 in the address)
//   app.perf.runBenchmark(opts)   → Promise<results>   (js/ui/perfbench.js; ?perf=1 starts it once the title is up)
//   app.perf.env()         { gpu, vendor, canvas, dpr, buffer, … }  what the picture is drawn with
//
// The overlay reads js/perf.js (the recorder the main loop, the flight screen and the terrain feed). It repaints
// four times a second, not every frame, and is one <pre>: showing it costs well under 0.1 ms a frame.
import { perf } from '../perf.js';

const CSS = `
.sw-perf { position: fixed; left: 8px; top: 8px; z-index: 9000; margin: 0; padding: 6px 9px; pointer-events: none;
  font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #d8e6ee; white-space: pre;
  background: rgba(11, 15, 20, 0.82); border: 1px solid rgba(57, 208, 192, 0.45); border-radius: 4px; }
.sw-perf b { color: #39d0c0; font-weight: 600; } .sw-perf i { color: #ffb347; font-style: normal; } .sw-perf u { color: #ff6b6b; text-decoration: none; }
`;

const f1 = x => (Number.isFinite(x) ? x.toFixed(1) : '–');
const f2 = x => (Number.isFinite(x) ? x.toFixed(2) : '–');
const big = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + ' M' : n >= 1e4 ? Math.round(n / 1e3) + ' k' : String(Math.round(n)));

/** GPU time of a whole frame through EXT_disjoint_timer_query_webgl2, where the browser offers it. */
function createGpuTimer(gl) {
  let ext = null;
  try { ext = gl && gl.getExtension && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null; } catch { ext = null; }
  const pending = [];
  let open = null;
  const t = {
    available: !!ext, ms: -1,
    begin() {
      if (!ext || open || pending.length > 6) return;
      try { open = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, open); } catch { open = null; }
    },
    end() {
      if (!ext) return;
      if (open) { try { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(open); } catch { /* lost context */ } open = null; }
      while (pending.length) {
        const q = pending[0];
        let ready = false;
        try { ready = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); } catch { ready = true; }
        if (!ready) break;
        pending.shift();
        try {
          const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
          if (!disjoint) { const ns = gl.getQueryParameter(q, gl.QUERY_RESULT); t.ms = t.ms < 0 ? ns / 1e6 : t.ms + (ns / 1e6 - t.ms) * 0.15; t.last = ns / 1e6; }
          gl.deleteQuery(q);
        } catch { /* ignore */ }
      }
    },
  };
  return t;
}

export function installPerf(app) {
  if (app.perf) return app.perf;
  let node = null, shown = false, lastPaint = 0, bench = null, gpuTimer = null, heapSeen = new Set(), heapPrecise = false;
  const users = new Set();          // who needs the recorder running: 'overlay', 'bench'

  function env() {
    const r = app.renderer, out = { gpu: 'no WebGL', vendor: '', webgl: '', canvas: '', dpr: window.devicePixelRatio || 1, buffer: '', pixelRatio: 0 };
    out.canvas = app.size.w + ' x ' + app.size.h;
    out.cores = navigator.hardwareConcurrency || 0;
    out.memoryGB = navigator.deviceMemory || 0;
    out.ua = navigator.userAgent;
    out.platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (!r) return out;
    try {
      const gl = r.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      out.gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      out.vendor = String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
      out.webgl = String(gl.getParameter(gl.VERSION));
      out.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      out.maxSamples = gl.MAX_SAMPLES ? gl.getParameter(gl.MAX_SAMPLES) : 0;
      out.buffer = gl.drawingBufferWidth + ' x ' + gl.drawingBufferHeight;
      out.bufferPixels = gl.drawingBufferWidth * gl.drawingBufferHeight;
      out.software = /swiftshader|llvmpipe|software|basic render/i.test(out.gpu);
      out.gpuTimer = !!(gpuTimer && gpuTimer.available);
    } catch { /* context lost */ }
    out.pixelRatio = r.getPixelRatio();
    const s = app.settings || {};
    out.settings = { quality: s.gfxQuality, forced: !!s.gfxForce, shadows: s.gfxShadows !== false, bloom: s.gfxBloom, lens: s.gfxLens !== false, auto: s.gfxAuto !== false };
    const view = app.flight && app.flight.view;
    if (view) {
      out.flightQuality = view.qualityName;
      const g = view.governor; if (g) out.governor = { enabled: g.enabled, level: g.level, locked: g.locked, ...g.state };
      const post = view.fx && view.fx.post, rt = post && post.target;
      if (rt) out.sceneTarget = rt.width + ' x ' + rt.height + ' x' + (rt.samples || 1);
    }
    return out;
  }

  function need(who, on) {
    if (on) users.add(who); else users.delete(who);
    const want = users.size > 0;
    if (want && !gpuTimer && app.renderer) gpuTimer = createGpuTimer(app.renderer.getContext());
    if (want !== perf.on) perf.enable(want);
    perf.gpuTimer = want ? gpuTimer : null;
  }

  function paint(nowMs) {
    if (!node || nowMs - lastPaint < 250) return;
    lastPaint = nowMs;
    const s = perf.summary(120);
    if (!s.frames) { node.textContent = 'measuring…'; return; }
    const e = env(), r = app.renderer, mem = r ? r.info.memory : null;
    const idle = Math.max(0, s.dt.avg - s.cpu.avg);
    const warn = (v, a, b) => (v > b ? 'u' : v > a ? 'i' : 'b');
    const tag = (t, v) => `<${t}>${v}</${t}>`;
    const fpsT = warn(s.dt.avg, 17.5, 25);
    const lines = [];
    lines.push(`${tag(fpsT, f1(s.fps) + ' fps')}  frame ${f1(s.dt.avg)} ms  p95 ${f1(s.dt.p95)}  worst ${f1(s.worst)}   over 33 ms: ${tag(s.long33 ? 'i' : 'b', s.long33)}/${s.frames}`);
    lines.push(`main thread ${tag(warn(s.cpu.avg, 8, 14), f1(s.cpu.avg) + ' ms')}  sim ${f2(s.sim)}  scene ${f2(s.scene)}  terrain ${f2(s.terrain)}  render ${f2(s.render)}  hud ${f2(s.hud)}  other ${f2(s.other)}`);
    lines.push(`not on main thread ${f1(idle)} ms (GPU + vsync wait)` + (s.gpu >= 0 ? `   GPU ${tag(warn(s.gpu, 12, 16), f1(s.gpu) + ' ms')} (timer query)` : ''));
    lines.push(`draw calls ${tag('b', s.calls)}  triangles ${tag('b', big(s.tris))}` + (mem ? `  geometries ${mem.geometries}  textures ${mem.textures}` : ''));
    lines.push(`${e.canvas} css  dpr ${e.dpr}  buffer ${e.buffer}` + (e.sceneTarget ? `  scene ${e.sceneTarget}` : ''));
    const g = e.governor;
    lines.push(`${app.currentName}` + (e.flightQuality ? `  quality ${e.flightQuality}` : '') + (g ? `  auto ${g.enabled ? 'L' + g.level + ' (scale ' + g.scale + (g.shadow < 1 ? ', shadows ' + g.shadow : '') + (g.msaa ? '' : ', no msaa') + (g.bloom ? '' : ', no bloom') + ')' : 'off'}` : ''));
    const heap = performance.memory ? performance.memory.usedJSHeapSize : 0;
    if (heap) { heapSeen.add(heap); if (heapSeen.size > 12) heapPrecise = true; }
    lines.push(heap ? `JS heap ${f1(heap / 1048576)} MB` + (heapPrecise ? `  alloc ${f1(s.allocMBs)} MB/s  GCs ${s.gcCount}` : '  (coarse: start Chrome with --enable-precise-memory-info for GC figures)') : 'JS heap: not reported by this browser');
    const wf = s.worstFrame;
    if (wf && wf.dt > Math.max(30, 2 * s.dt.p50)) {
      const top = ['sim', 'scene', 'terrain', 'render', 'hud', 'other'].sort((x, y) => wf[y] - wf[x])[0];
      lines.push(`slowest of the last ${s.frames}: ${tag('i', f1(wf.dt) + ' ms')}  main ${f1(wf.cpu)} (${top} ${f1(wf[top])})` + (wf.programs ? `  new shaders ${wf.programs}` : '') + (wf.counters ? '  ' + Object.keys(wf.counters).map(k => k + ' ' + wf.counters[k]).join(' ') : ''));
    }
    const c = s.counters || {}, ck = Object.keys(c).filter(k => c[k]);
    if (ck.length) lines.push(ck.map(k => k + ' ' + c[k]).join('  '));
    lines.push(e.gpu.length > 86 ? e.gpu.slice(0, 85) + '…' : e.gpu);
    node.innerHTML = lines.join('\n');
  }

  function show(on) {
    on = !!on;
    if (on === shown) return shown;
    shown = on;
    if (on) {
      if (!document.getElementById('sw-perf-css')) { const st = document.createElement('style'); st.id = 'sw-perf-css'; st.textContent = CSS; document.head.appendChild(st); }
      node = document.createElement('pre'); node.className = 'sw-perf'; node.dataset.perf = 'overlay'; node.textContent = 'measuring…';
      document.body.appendChild(node);
      need('overlay', true);
    } else {
      if (node) node.remove(); node = null;
      need('overlay', false);
    }
    return shown;
  }

  // one hook for the overlay and the benchmark
  perf.onFrame = f => {
    if (gpuTimer && gpuTimer.ms >= 0) f.gpu = gpuTimer.last != null ? gpuTimer.last : gpuTimer.ms;
    if (bench && bench.onFrame) bench.onFrame(f);
    if (shown) paint(f.t);
  };

  window.addEventListener('keydown', e => {
    if (e.code !== 'F3' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault(); e.stopPropagation();
    show(!shown);
  }, true);

  const api = {
    perf,
    env,
    get shown() { return shown; },
    get heapPrecise() { return heapPrecise; },
    toggle(on) { return show(on == null ? !shown : on); },
    need,
    results: null,
    running: false,
    /** Open one benchmark scene (sandboxed, like the benchmark) and leave it running; closeScene() puts the game back. */
    async openScene(id, opts = {}) {
      if (api.running) return null;
      const mod = await import('./perfbench.js');
      need('bench', true);
      if (!bench || bench.optsKey !== JSON.stringify(opts)) { bench = mod.createBenchmark(app, api, opts); bench.optsKey = JSON.stringify(opts); }
      return bench.open(id);
    },
    async closeScene() { if (bench && !api.running) { await bench.close(); bench = null; need('bench', false); } },
    async runBenchmark(opts = {}) {
      if (api.running) return null;
      api.running = true;
      try {
        const mod = await import('./perfbench.js');
        need('bench', true);
        bench = mod.createBenchmark(app, api, opts);
        api.results = await bench.run();
        // for whoever drives the browser from outside: the same result as data, and one line in the console
        try { window.__perfResults = api.results; console.log('[starwright-perf] done ' + JSON.stringify(api.results && api.results.json)); console.log(api.results && api.results.text); } catch { /* no console */ }
        return api.results;
      } finally { bench = null; need('bench', false); api.running = false; }
    },
  };
  app.perf = api;

  try {
    const q = new URLSearchParams(window.location.search);
    const on = k => q.has(k) && q.get(k) !== '0' && q.get(k) !== 'false';
    if (on('fps')) show(true);
    if (on('perf')) {
      const num = (k, d) => (q.get(k) != null && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
      api.auto = { frames: num('frames', undefined), warm: num('warm', undefined), hq: on('hq'), gov: on('gov'), only: q.get('scenes') || q.get('only') || '', drain: !(q.has('drain') && !on('drain')), quality: q.get('quality') || '' };
    }
  } catch { /* no address to read */ }
  return api;
}
