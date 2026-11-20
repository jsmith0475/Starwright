// Runs the in-game ?perf=1 benchmark in headless Chromium and prints its table; optionally CPU-profiles each scene.
//   node tests/tools/perf_run.mjs [--hq] [--frames=40] [--scenes=pad,orbit] [--size=1440x900] [--dpr=1] [--profile] [--tag=name] [--quality=high]
// --profile: one V8 CPU profile per scene (Profiler.start/stop over the measured window) → tests/out/perf-<tag>-<scene>.cpuprofile
//            and a ranked self-time table per scene on stdout.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from '../e2e/server.mjs';
const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const has = k => process.argv.includes('--' + k);
const [W, H] = arg('size', '1440x900').split('x').map(Number);
const DPR = +arg('dpr', 1), FRAMES = +arg('frames', 40), TAG = arg('tag', 'run');
const server = await startServer(ROOT);
const browser = await chromium.launch({ args: [...CHROMIUM_ARGS, '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR })).newPage();
page.on('pageerror', e => console.log('page error: ' + e.message));
page.on('console', m => { if (m.type() === 'error' || /\[perf\]/.test(m.text())) console.log('console: ' + m.text()); });
const cdp = await page.context().newCDPSession(page);
// --noprewarm: serve flight.js without the shader pre-compile, to measure what it buys (A/B; no file is changed)
if (has('noprewarm')) {
  const fs2 = await import('node:fs');
  const src = fs2.readFileSync(new URL('../../js/ui/flight.js', import.meta.url), 'utf8'), body = src.replace('await sc.prewarm(app.renderer)', '0');
  if (body === src) throw new Error('flight.js: prewarm call not found');
  await page.route('**/js/ui/flight.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body }));
}
const q = new URLSearchParams({ perf: '1', frames: String(FRAMES), warm: arg('warm', '20') });
if (has('hq')) q.set('hq', '1');
if (arg('scenes')) q.set('scenes', arg('scenes'));
if (arg('quality')) q.set('quality', arg('quality'));
if (has('gov')) q.set('gov', '1');
if (has('nodrain')) q.set('drain', '0');
// The benchmark calls window.__perfHook(sceneId, 'begin' | 'end', frames) round each measured window: the CPU
// profiler and the per-thread CPU-time counters (Performance domain, thread ticks: not wall time, so other
// processes on the machine do not count) run over exactly those frames.
const profiles = {}, cpu = {};
await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
if (has('profile')) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); }
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
let m0 = null;
const PHASE = has('arrive') ? 'arrive' : 'steady';       // which window the profiler covers
await page.exposeFunction('__perfHook', async (id, what, frames) => {
  const arrive = what.startsWith('arrive-'), begin = what.endsWith('begin');
  const prof = has('profile') && (PHASE === 'arrive') === arrive;
  if (begin) { if (!arrive || PHASE === 'arrive') m0 = await metrics(); if (prof) await cdp.send('Profiler.start'); return null; }
  if (prof) { const { profile } = await cdp.send('Profiler.stop'); profiles[id] = profile; }
  if (arrive && PHASE !== 'arrive') return null;
  const m1 = await metrics(), per = k => +(1000 * (m1[k] - m0[k]) / (arrive ? 1 : frames)).toFixed(3);
  const out = { task: per('TaskDuration'), script: per('ScriptDuration'), layout: per('LayoutDuration'), style: per('RecalcStyleDuration'), heapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1), nodes: m1.Nodes };
  if ((PHASE === 'arrive') === arrive) cpu[id] = out;
  return out;
});
await page.goto(server.url + 'index.html?' + q, { timeout: 180000 });
await page.waitForFunction(() => document.body.dataset.perf === 'done', null, { timeout: 3600000, polling: 500 });

const res = await page.evaluate(() => { const r = window.__sw.app.perf.results; return { text: r.text, json: r.json }; });
console.log(res.text);
console.log('\nMain-thread CPU time ' + (PHASE === 'arrive' ? 'for the whole arrival (open + settle)' : 'per frame') + ' (thread ticks, ms): task = everything the renderer main thread ran, script = JavaScript');
for (const [id, c] of Object.entries(cpu)) console.log(`  ${id.padEnd(10)} task ${String(c.task).padStart(8)}  script ${String(c.script).padStart(8)}  layout ${String(c.layout).padStart(6)}  style ${String(c.style).padStart(6)}  heap ${c.heapMB} MB  DOM nodes ${c.nodes}`);
fs.writeFileSync(path.join(OUT, `perf-${TAG}.json`), JSON.stringify(res.json, null, 1));
fs.writeFileSync(path.join(OUT, `perf-${TAG}.txt`), res.text + '\n');
await page.screenshot({ path: path.join(OUT, `perf-${TAG}.png`) }).catch(() => {});

// Self time per function. On a software rasteriser the main thread spends most of its wall time blocked in native
// code waiting for the GPU process ("(program)"): that and "(idle)" are left out of the percentages, so the ranking
// is of the work the main thread actually did (JavaScript, GL calls, DOM calls, GC).
function rank(profile, top = 26) {
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const self = new Map(); let total = 0;
  const dts = profile.timeDeltas, samples = profile.samples;
  for (let i = 0; i < samples.length; i++) { const d = dts[i] || 0; self.set(samples[i], (self.get(samples[i]) || 0) + d); total += d; }
  const fn = new Map(), file = new Map();
  let idle = 0, gc = 0, program = 0;
  for (const [id, us] of self) {
    const n = byId.get(id), cf = n.callFrame, name = cf.functionName || '(anonymous)';
    if (name === '(idle)') { idle += us; continue; }
    if (name === '(program)') { program += us; continue; }
    if (name === '(garbage collector)') gc += us;
    const u = cf.url ? cf.url.replace(/^.*\/js\//, 'js/') : '';
    const k = name + (u ? '  ' + u + ':' + (cf.lineNumber + 1) : '  [native]');
    fn.set(k, (fn.get(k) || 0) + us);
    const fk = u || (name.startsWith('(') ? name : '[native GL/DOM calls]'); file.set(fk, (file.get(fk) || 0) + us);
  }
  const busy = total - idle - program;
  const fmt = (m, n = top) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => `  ${(us / 1000).toFixed(1).padStart(8)} ms ${(100 * us / busy).toFixed(1).padStart(5)}%  ${k}`).join('\n');
  return `  sampled ${(total / 1000).toFixed(0)} ms: work ${(busy / 1000).toFixed(0)} ms, blocked in native "(program)" ${(program / 1000).toFixed(0)} ms, idle ${(idle / 1000).toFixed(0)} ms; GC ${(gc / 1000).toFixed(1)} ms (${(100 * gc / busy).toFixed(1)}% of work)\n by function (self time, % of work):\n${fmt(fn)}\n by file:\n${fmt(file, 14)}`;
}
for (const [k, p] of Object.entries(profiles)) {
  const name = k.replace(/[^\w]+/g, '_');
  fs.writeFileSync(path.join(OUT, `perf-${TAG}-${name}.cpuprofile`), JSON.stringify(p));
  console.log(`\n=== CPU profile: ${k}\n` + rank(p));
}
await browser.close(); await server.close();
