// Performance regression check: runs the game's own ?perf=1 benchmark (js/ui/perfbench.js) at full quality on a
// small canvas and holds every scene to a budget of
//   · main-thread CPU time per frame, measured in thread ticks through the DevTools Performance domain (CPU time
//     of the page's main thread, NOT wall time: other processes on a busy machine do not count),
//   · draw calls and triangles per frame (renderer.info over the whole frame, shadow and post passes included),
//   · terrain chunks built on the main thread while the scene arrives.
//   node tests/e2e/perf.mjs            (PERF_SCENES=pad,orbit to run a subset; the table goes to tests/out/perf-suite.txt)
//
// The budgets are about 2.5 times what this 4-core cloud machine measured when they were set (2026-11-19; see
// docs/RUST_ASSESSMENT.md for the table), so they catch a regression of the "someone made every frame twice as
// expensive" kind without flaking. Software GL cannot say anything about GPU time; that is what the benchmark's
// own table on a real machine is for.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });

const problems = [];
let checks = 0;
function ok(cond, what) { checks++; if (!cond) { problems.push('FAILED: ' + what); console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); }

// scene id → budgets. cpu = main-thread JavaScript CPU ms per frame (thread ticks); draws / tris = per frame;
// onmain = chunks built on the main thread during arrival; late = shader programs compiled inside a drawn frame.
const BUDGET = {
  builder: { cpu: 30, draws: 950, tris: 650e3 },
  pad: { cpu: 24, draws: 470, tris: 2.4e6, onmain: 400, late: 16 },
  ascent: { cpu: 22, draws: 440, tris: 2.3e6 },
  orbit: { cpu: 14, draws: 150, tris: 300e3, onmain: 260 },
  map: { cpu: 9, draws: 20, tris: 60e3 },
  pell: { cpu: 17, draws: 440, tris: 480e3, onmain: 260 },
  plane: { cpu: 24, draws: 450, tris: 2.1e6, onmain: 480 },
  tracking: { cpu: 12, draws: 20, tris: 45e3 },
};
const scenes = (process.env.PERF_SCENES || Object.keys(BUDGET).join(',')).split(',').map(s => s.trim()).filter(s => BUDGET[s]);
const FRAMES = 12;

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const ctx = await browser.newContext({ viewport: { width: 480, height: 300 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.setDefaultTimeout(180000);
page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text() + ' @ ' + (m.location()?.url || '')); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
page.on('requestfailed', r => { if (!/^data:/.test(r.url())) problems.push('request failed: ' + r.url()); });

const cdp = await ctx.newCDPSession(page);
await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
const cpu = {};
let m0 = null;
await page.exposeFunction('__perfHook', async (id, what, frames) => {
  if (what === 'begin') { m0 = await metrics(); return null; }
  if (what !== 'end' || !m0) return null;
  const m1 = await metrics();
  cpu[id] = { task: 1000 * (m1.TaskDuration - m0.TaskDuration) / frames, script: 1000 * (m1.ScriptDuration - m0.ScriptDuration) / frames };
  return cpu[id];
});

try {
  console.log('The benchmark, full quality, ' + scenes.length + ' scenes × ' + FRAMES + ' frames');
  await page.goto(server.url + `index.html?perf=1&hq=1&drain=0&frames=${FRAMES}&warm=8&scenes=${scenes.join(',')}`, { timeout: 180000 });
  await page.waitForFunction(() => document.body.dataset.perf === 'done', null, { timeout: 40 * 60 * 1000, polling: 500 });
  const res = await page.evaluate(() => { const r = window.__sw.app.perf.results; return { text: r.text, json: r.json, title: window.__sw.app.currentName, career: !!window.__sw.app.career }; });
  fs.writeFileSync(path.join(OUT, 'perf-suite.txt'), res.text + '\n');
  fs.writeFileSync(path.join(OUT, 'perf-suite.json'), JSON.stringify({ ...res.json, cpu }, null, 1));
  console.log(res.text.split('\n').slice(0, 30).join('\n'));
  await page.screenshot({ path: path.join(OUT, 'perf-suite.png') });

  ok(res.json.scenes.length === scenes.length && res.json.scenes.every(r => !r.error), 'every scene ran: ' + res.json.scenes.filter(r => r.error).map(r => r.id + ' (' + r.error + ')').join(', '));
  ok(/GPU\s+\S/.test(res.text) && /Display\s+canvas 480 x 300 CSS px, devicePixelRatio 1/.test(res.text) && /Settings\s+detail high/.test(res.text), 'the report names the GPU, the canvas size, the pixel ratio and the quality');
  ok(res.json.env && res.json.env.software === true, 'and says it ran on a software renderer here');
  ok(await page.evaluate(() => !!document.querySelector('[data-perf="report"]') && !!document.querySelector('[data-perf="copy"]')), 'the results card has the table and a copy button');
  ok(res.title === 'title' && !res.career, 'the benchmark hands the game back on the title screen with no program loaded');
  for (const r of res.json.scenes) {
    if (r.error) continue;
    const b = BUDGET[r.id], c = cpu[r.id];
    console.log(`\n${r.title}`);
    ok(r.frames === FRAMES, `${r.id}: ${FRAMES} frames measured (${r.frames})`);
    ok(!!c && c.task > 0, `${r.id}: main-thread CPU time was measured`);
    // JavaScript CPU time of the frames (the task total also counts the software rasteriser's hand-over, which is
    // not the game's work and does not exist on a real GPU)
    if (c) ok(c.script <= b.cpu, `${r.id}: main-thread JavaScript ${c.script.toFixed(2)} ms of CPU a frame (all tasks ${c.task.toFixed(2)}) within ${b.cpu} ms`);
    if (b.late != null) ok(r.arrive.late + (r.programs || 0) <= b.late, `${r.id}: ${r.arrive.late + (r.programs || 0)} of the scene's ${r.arrive.programs} shader programs were compiled inside a drawn frame, within ${b.late} (the rest before the first frame)`);
    ok(r.callsMax <= b.draws, `${r.id}: ${r.callsMax} draw calls at most, within ${b.draws}`);
    ok(r.trisMax <= b.tris, `${r.id}: ${Math.round(r.trisMax / 1000)}k triangles at most, within ${Math.round(b.tris / 1000)}k`);
    if (r.arrive.textures > 0) ok(r.arrive.texMax <= 1, `${r.id}: ${r.arrive.textures} body-map textures arrived, never more than one upload in a frame (most: ${r.arrive.texMax})`);
    if (r.twoPass) { const bad = Object.keys(r.twoPass).filter(k => /decal|heat|plume|flame|exhaust/i.test(k)); ok(bad.length === 0, `${r.id}: no craft decal, glow or plume material is drawn in two passes (${JSON.stringify(r.twoPass)})`); }
    if (b.onmain != null) ok(r.arrive.chunksMain <= b.onmain, `${r.id}: ${r.arrive.chunksMain} terrain chunks built on the main thread on arrival, within ${b.onmain}`);
    const sum = r.sim + r.scene + r.terrain + r.render + r.hud + r.other;
    ok(Math.abs(sum - r.cpu.avg) < 0.05 * r.cpu.avg + 0.2, `${r.id}: the recorder's buckets add up to its main-thread total (${sum.toFixed(2)} vs ${r.cpu.avg.toFixed(2)} ms)`);
    if (['pad', 'ascent', 'orbit', 'pell', 'plane'].includes(r.id)) {
      ok(r.flightQuality === 'high', `${r.id}: drawn at "high" (${r.flightQuality})`);
      ok(/x4$/.test(r.sceneTarget || ''), `${r.id}: 4 samples per pixel at devicePixelRatio 1 (${r.sceneTarget})`);
      ok(r.governor && r.governor.locked && r.governor.level === 0, `${r.id}: automatic quality held at full for the test`);
    }
  }

  // ---- the overlay: F3 shows it, F3 hides it, nothing is recorded while it is hidden
  console.log('\nF3 overlay');
  await page.goto(server.url + 'index.html', { timeout: 180000 });
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 180000 });
  ok(await page.evaluate(() => !document.querySelector('.sw-perf') && window.__sw.app.perf.perf.on === false), 'off by default: no overlay, recorder idle');
  await page.keyboard.press('F3');
  await page.waitForFunction(() => { const n = document.querySelector('.sw-perf'); return n && /fps/.test(n.textContent); }, null, { timeout: 60000 });
  const text = await page.evaluate(() => document.querySelector('.sw-perf').textContent);
  ok(/fps/.test(text) && /main thread/.test(text) && /draw calls/.test(text) && /dpr/.test(text) && /SwiftShader|ANGLE|llvmpipe/i.test(text), 'F3 shows frame time, the main-thread split, draw calls, the pixel ratio and the GPU');
  ok(await page.evaluate(() => { const n = document.querySelector('.sw-perf'), r = n.getBoundingClientRect(); return getComputedStyle(n).pointerEvents === 'none' && r.width < 760 && r.height < 200; }), 'small, and clicks pass through it');
  await page.screenshot({ path: path.join(OUT, 'perf-overlay.png') });
  // body-map textures: however many worlds finish baking together, one texture is handed to the GPU per frame
  const tex = await page.evaluate(async () => {
    const bt = await import('/js/render/bodytex.js'), { SYSTEM } = await import('/js/core/bodies.js');
    const perf = window.__sw.app.perf.perf, prev = perf.onFrame;
    let most = 0, total = 0, frames = 0;
    perf.onFrame = f => { const n = f.counters && f.counters.textureSwaps || 0; most = Math.max(most, n); total += n; frames++; if (prev) prev(f); };
    const fresh = SYSTEM.bodies.filter(b => b !== SYSTEM.star && bt.getBodyMaps(b).level === 'tiny' && !bt.getBodyMaps(b).pending).slice(0, 5);
    await Promise.all(fresh.map(b => bt.requestBodyMaps(b, 'low')));
    await new Promise(r => { let n = 0; const f = () => (++n > 4 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    perf.onFrame = prev;
    return { bodies: fresh.length, most, total, frames };
  });
  ok(tex.bodies >= 4 && tex.total >= 2 * tex.bodies, `${tex.bodies} worlds baked their maps at once: ${tex.total} textures replaced over ${tex.frames} frames`);
  ok(tex.most === 1, `never more than one texture upload in a frame (most: ${tex.most})`);
  await page.keyboard.press('F3');
  ok(await page.evaluate(() => !document.querySelector('.sw-perf') && window.__sw.app.perf.perf.on === false && window.__sw.app.renderer.info.autoReset === true), 'F3 again removes it and stops the recorder');
} catch (err) {
  problems.push('suite error: ' + (err.stack || err.message));
}

// ---- a retina display: the pixel budget, 2 samples per pixel, and the governor's levels reaching the picture
try {
  console.log('\nRetina (devicePixelRatio 2)');
  const ctx2 = await browser.newContext({ viewport: { width: 480, height: 300 }, deviceScaleFactor: 2 });
  const p2 = await ctx2.newPage();
  p2.setDefaultTimeout(180000);
  p2.on('console', m => { if (m.type() === 'error') problems.push('console error (retina): ' + m.text()); });
  p2.on('pageerror', e => problems.push('page error (retina): ' + (e.stack || e.message)));
  await p2.goto(server.url + 'index.html', { timeout: 180000 });
  await p2.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 180000 });
  const pr = await p2.evaluate(() => { const app = window.__sw.app; return { small: app.pixelRatio(1440, 900), mbp: app.pixelRatio(1728, 1117), huge: app.pixelRatio(3008, 1692), dpr: window.devicePixelRatio, now: app.renderer.getPixelRatio() }; });
  ok(pr.dpr === 2 && pr.small === 2 && pr.now === 2, `a 1440 x 900 window at devicePixelRatio 2 is drawn at 2 (${pr.small}; the canvas now: ${pr.now})`);
  ok(pr.mbp === 2, `so is a full-screen 16-inch MacBook Pro, 1728 x 1117 (${pr.mbp})`);
  ok(pr.huge < 2 && pr.huge >= 1 && Math.round(3008 * pr.huge) * Math.round(1692 * pr.huge) <= 3840 * 2160 * 1.01, `a 6K display (3008 x 1692 CSS px) is held to the 3840 x 2160 pixel budget (ratio ${pr.huge.toFixed(3)})`);
  // the map scene: the flight scene's targets exist, the picture is the cheap one
  await p2.evaluate(() => window.__sw.app.perf.openScene('map', { hq: true }));
  const target = () => p2.evaluate(async () => {
    const app = window.__sw.app;
    app.flight.view.render(app.renderer);          // (the map does not draw the flight scene: one frame of it, for its target)
    const e = app.perf.env(), g = app.flight.view.governor;
    return { target: e.sceneTarget, level: g.level, state: g.state, quality: e.flightQuality, auto: app.settings.gfxAuto };
  });
  const t0 = await target();
  ok(t0.quality === 'high' && /^960 x 600 x2$/.test(t0.target), `"high" at devicePixelRatio 2: the scene target is 960 x 600 with 2 samples, not 4 (${t0.target})`);
  await p2.evaluate(() => { const app = window.__sw.app; app.flight.view.governor.lock(2); app.flight.view.applySettings(app.settings); });
  const t2 = await target();
  ok(/^691 x 432 x4$/.test(t2.target), `governor level 2 (render scale 0.72): 691 x 432, and 4 samples again below 1.5 device pixels per CSS pixel (${t2.target})`);
  await p2.evaluate(() => { const app = window.__sw.app; app.flight.view.governor.lock(6); app.flight.view.applySettings(app.settings); });
  const t6 = await target();
  ok(/^576 x 360 x1$/.test(t6.target) && t6.state.shadow === 0 && t6.state.bloom === true, `level 6 (scale 0.6, no shadows, no multisampling): ${t6.target}`);
  await p2.evaluate(() => { const app = window.__sw.app; app.flight.view.governor.lock(null); app.flight.view.applySettings(app.settings); });
  const t9 = await target();
  ok(/^960 x 600 x2$/.test(t9.target), `released: back to full (${t9.target})`);
  await p2.evaluate(() => window.__sw.app.perf.closeScene());
  await ctx2.close();
} catch (err) {
  problems.push('suite error (retina): ' + (err.stack || err.message));
}

await browser.close();
await server.close();
console.log(`\n${checks} checks, ${problems.length} problem(s)`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
