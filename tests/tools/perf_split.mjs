// Where does the main thread's time go? Opens benchmark scenes at full quality and times each part of a frame in
// isolation, in CPU time (DevTools Performance domain, thread ticks), so a busy machine and a slow software
// rasteriser do not distort the split. Also: who allocates (sampling heap profiler), which materials three.js
// re-evaluates every frame, and a JavaScript-only CPU profile of whole frames.
//   node tests/tools/perf_split.mjs [--scenes=pad,ascent,orbit,pell,plane,docking] [--size=480x300] [--tag=name] [--soft]
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from '../e2e/server.mjs';
const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const has = k => process.argv.includes('--' + k);
const [W, H] = arg('size', '480x300').split('x').map(Number);
const TAG = arg('tag', 'split'), SCENES = arg('scenes', 'pad,ascent,orbit,pell,plane,docking').split(',');
const server = await startServer(ROOT);
const browser = await chromium.launch({ args: [...CHROMIUM_ARGS, '--enable-precise-memory-info'] });
const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: +arg('dpr', 1) })).newPage();
page.on('pageerror', e => console.log('page error: ' + e.message));
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
/**
 * Main-thread ms per call of an in-page loop body: the fastest of many short batches (performance.now). A batch that
 * was pre-empted by another process, or that had to wait for the software rasteriser, is slower than the fastest
 * one, so the minimum is the cost of the code itself. `idle` (ms): wait that long before every batch, so the GPU
 * process has drained and a draw call does not block on it.
 */
async function time(body, { batches = 25, per = 8, setup = '', idle = 0 } = {}) {
  let best = Infinity;
  const run = () => page.evaluate(`(() => { const sw = window.__sw, app = sw.app, f = app.flight, w = sw.world, v = w && w.active, r = app.renderer; ${setup}; let best = Infinity; for (let b = 0; b < ${idle ? 1 : batches}; b++) { const t0 = performance.now(); for (let i = 0; i < ${per}; i++) { ${body}; } best = Math.min(best, (performance.now() - t0) / ${per}); } return best; })()`);
  if (!idle) return Math.min(await run(), await run());
  for (let b = 0; b < batches; b++) { await page.waitForTimeout(idle); best = Math.min(best, await run()); }
  return best;
}
await page.goto(server.url + 'index.html', { timeout: 180000 });
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 180000 });
const out = {};
const lines = [];
const say = s => { console.log(s); lines.push(s); };
say(`Main-thread time per call, ms (fastest of many short batches, GPU drained before each draw; ${W}x${H}, ${has('soft') ? 'reduced' : 'high'} quality, software GL)`);
say('scene      |  frame =   sim + scene+terrain +    hud + navball + render | draws   tris | alloc kB/frame | materials re-evaluated/frame');
for (const id of SCENES) {
  const title = await page.evaluate(([id, hq]) => window.__sw.app.perf.openScene(id, { hq }), [id, !has('soft')]);
  await page.waitForTimeout(1500);
  const isFlight = await page.evaluate(() => window.__sw.app.currentName === 'flight');
  const r = { title };
  // allocation per frame and the materials three.js looks up again every frame, over whole frames
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 8192 });
  const FR = 6;
  const census = await page.evaluate(async (N) => {
    const THREE = await import('/js/lib/three.module.min.js');
    const seen = new Map(), orig = THREE.Material.prototype.customProgramCacheKey;
    THREE.Material.prototype.customProgramCacheKey = function () { const k = (this.name || this.type); seen.set(k, (seen.get(k) || 0) + 1); return orig.call(this); };
    const app = window.__sw.app, r = app.renderer; r.info.autoReset = false; let calls = 0, tris = 0;
    for (let i = 0; i < N; i++) { r.info.reset(); app.current.update(1 / 60); app.current.render(); app.input.endFrame(); calls = Math.max(calls, r.info.render.calls); tris = Math.max(tris, r.info.render.triangles); }
    THREE.Material.prototype.customProgramCacheKey = orig;
    let total = 0; for (const n of seen.values()) total += n;
    return { calls, tris, perFrame: total / N, top: [...seen].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => k + ' ×' + (n / N).toFixed(1)) };
  }, FR);
  const heap = await cdp.send('HeapProfiler.stopSampling');
  r.calls = census.calls; r.tris = census.tris;
  const alloc = new Map(); let allocTotal = 0;
  (function walk(n) { if (n.selfSize) { const cf = n.callFrame, k = (cf.functionName || '(anon)') + '  ' + (cf.url ? cf.url.replace(/^.*\/js\//, 'js/') + ':' + (cf.lineNumber + 1) : '[native]'); alloc.set(k, (alloc.get(k) || 0) + n.selfSize); allocTotal += n.selfSize; } for (const c of n.children || []) walk(c); })(heap.profile.head);
  r.allocKB = allocTotal / 1024 / FR;
  r.allocTop = [...alloc].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, b]) => `${(b / 1024 / FR).toFixed(1).padStart(7)} kB/frame  ${k}`);
  r.materials = census;
  const IDLE = +arg('idle', 7000);
  if (isFlight) {
    r.scene = await time('f.view.update(w, 1 / 60, 1 / 60, f.cam)');
    r.terrain = await time('wr.update({ ut: w.ut, dt: 1 / 60, body: f.view.anchor.body, origin: f.view.anchor.pos })', { setup: 'const wr = f.view.worlds' });
    r.hud = await time('f.hud.update(w, v, f.state, 1 / 60)', { per: 12 });
    r.ball = await time('f.ball.drawOverlay(f.hud.overlay)');
    // draw submission: one render per batch, GPU drained before each
    r.render = await time('f.view.render(r)', { batches: 5, per: 1, idle: IDLE });
    r.ballRender = await time('const rect = f.hud.ballRect(); if (rect) f.ball.render(r, rect, app.size.h)', { batches: 3, per: 1, idle: 1500 });
    // the same with the two-pass transparent materials as they were before the fix (decals, heat glow, plumes)
    await page.evaluate(() => { const f = window.__sw.app.flight; f.view.near.traverse(o => { const m = o.material; if (m && m.forceSinglePass && m.transparent) { m.forceSinglePass = false; m.needsUpdate = true; m.userData.wasSingle = true; } }); });
    r.renderTwoPass = await time('f.view.render(r)', { batches: 5, per: 1, idle: IDLE });
    await page.evaluate(() => { const f = window.__sw.app.flight; f.view.near.traverse(o => { const m = o.material; if (m && m.userData && m.userData.wasSingle) { m.forceSinglePass = true; m.needsUpdate = true; } }); });
    r.sim = await time('w.step(1 / 60)', { per: 20 });
    r.frame = r.sim + r.scene + r.hud + r.ball + r.render + r.ballRender;
    say(`${id.padEnd(10)} | ${r.frame.toFixed(2).padStart(6)} = ${r.sim.toFixed(2).padStart(5)} + ${(r.scene - r.terrain).toFixed(2).padStart(5)} + ${r.terrain.toFixed(2).padStart(5)} + ${r.hud.toFixed(2).padStart(6)} + ${(r.ball + r.ballRender).toFixed(2).padStart(6)} + ${r.render.toFixed(2).padStart(6)} (two-pass decals: ${r.renderTwoPass.toFixed(2)}) | ${String(r.calls).padStart(5)} ${String(Math.round(r.tris / 1000) + 'k').padStart(6)} | ${r.allocKB.toFixed(0).padStart(8)}       | ${census.perFrame.toFixed(1)}  ${census.top.slice(0, 4).join(', ')}`);
  } else {
    r.update = await time('app.current.update(1 / 60); app.input.endFrame()');
    r.render = await time('app.current.render()', { batches: 5, per: 1, idle: IDLE });
    r.frame = r.update + r.render;
    say(`${id.padEnd(10)} | ${r.frame.toFixed(2).padStart(6)} = update ${r.update.toFixed(2)} + render ${r.render.toFixed(2)}`.padEnd(71) + ` | ${String(r.calls).padStart(5)} ${String(Math.round(r.tris / 1000) + 'k').padStart(6)} | ${r.allocKB.toFixed(0).padStart(8)}       | ${census.perFrame.toFixed(1)}  ${census.top.slice(0, 4).join(', ')}`);
  }
  out[id] = r;
}
say('');
for (const id of SCENES) { say(`allocation by function, ${id}:`); for (const l of out[id].allocTop) say(l); }
fs.writeFileSync(path.join(OUT, `perf-${TAG}.json`), JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(OUT, `perf-${TAG}.txt`), lines.join('\n') + '\n');
await browser.close(); await server.close();
