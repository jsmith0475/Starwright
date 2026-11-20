// A filmstrip of the demo tour as a viewer sees it: the WHOLE tour, in order, in one page, at full quality, with one
// picture every 2 s of TOUR time. The tour runs in fixed-step mode (&step=1/60: every drawn frame advances the tour
// and the game by exactly a sixtieth of a second, as on a machine that holds 60 frames a second), so the software
// renderer's slowness changes how long the film takes to make, not what is on it.
//   node tests/e2e/demo_film.mjs [chapters,comma,separated] [WxH]
//     → tests/out/film/<tag>/f<nnnn>-<mm>m<ss>s-<chapter>.png      one frame per stop
//       tests/out/film/<tag>/sheet-<nn>.png                       contact sheets, six frames each (needs ImageMagick)
//       tests/out/film/<tag>/film.json                            per frame: what was on screen (demo_probe.mjs)
//       tests/out/film/<tag>/film.log                             chapter table, tour length, the tour's own log
//   env: FILM_STEP (default 1/60), FILM_EVERY (2), FILM_DRAW (1000: only every 1000th frame between two pictures is drawn,
//        i.e. in practice only the pictures; every frame is still simulated. A software renderer needs about ten
//        seconds for one full-quality flight frame, so 1, which draws them all, takes days), FILM_TAG (default: the process id), FILM_FROM (start chapter; the
//        tour carries on from there), FILM_DPR (1), FILM_STOP_AFTER (chapter id: stop when it is over)
// With a chapter list, only frames of those chapters are kept (the tour still runs from FILM_FROM or the first listed).
// It is a capture script: it exits non-zero on page errors, a chapter that did not end "ok", or a tour that stalls.
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';
import { probeDemo } from './demo_probe.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ONLY = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);
const [W, H] = (process.argv[3] || '1280x800').split('x').map(Number);
const STEP = process.env.FILM_STEP || '1/60', EVERY = Number(process.env.FILM_EVERY || 2), DPR = Number(process.env.FILM_DPR || 1);
const DRAW = Number(process.env.FILM_DRAW || 1000);
const TAG = process.env.FILM_TAG || String(process.pid);
const FROM = process.env.FILM_FROM || ONLY[0] || '';
const STOP_AFTER = process.env.FILM_STOP_AFTER || (ONLY.length ? ONLY[ONLY.length - 1] : '');
const OUT = path.join(ROOT, 'tests/out/film', TAG);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'film.log');
const log = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const problems = [];

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text()); else if (/^\[demo\]/.test(m.text())) log('    ' + m.text().split('\n')[0]); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));

// The page's frames are pumped from here instead of by the browser's own requestAnimationFrame: a headless software
// compositor needs up to a second or two to present each frame of the full-quality page, which the tour (in fixed
// step) does not need in order to advance. Each pumped frame still gets FRAME_MS of wall time (default 16, as at
// 60 frames a second), so work that runs beside the frames (terrain chunks on worker threads, texture baking,
// loading) gets no more time per frame than on the real machine and pop-in shows up here if it would there.
const FRAME_MS = Number(process.env.FILM_FRAME_MS || 16);
await page.addInitScript(frameMs => {
  const q = []; let id = 0, vnow = performance.now();
  window.requestAnimationFrame = cb => { q.push({ id: ++id, cb }); return id; };
  window.cancelAnimationFrame = i => { const k = q.findIndex(e => e.id === i); if (k >= 0) q.splice(k, 1); };
  const once = () => { const batch = q.splice(0); vnow += 1000 / 60; for (const e of batch) { try { e.cb(vnow); } catch (err) { console.error(err); } } };
  /** Run frames until the tour holds for a picture or ends (or `max` frames have run); `n`: exactly n frames. */
  window.__pump = async (max, n = 0) => {
    for (let i = 0; i < max; i++) {
      const t = performance.now();
      once();
      const d = window.__sw && window.__sw.app && window.__sw.app.demo;
      if (n ? i + 1 >= n : (d && document.body.dataset.ready === '1' && (d.filmReady || (window.__filmStarted && !d.running)))) return true;
      if (d && d.running) window.__filmStarted = true;
      await new Promise(r => setTimeout(r, Math.max(0, frameMs - (performance.now() - t))));
    }
    return false;
  };
}, FRAME_MS);
const pump = async () => { for (let i = 0; i < 4000; i++) { if (await page.evaluate(() => window.__pump(240))) return true; } return false; };

const t0 = Date.now();
await page.goto(server.url + `index.html?demo=1&clean=1&hq=1&watch=1&step=${STEP}&film=${EVERY}&draw=${DRAW}${FROM ? '&chapter=' + FROM : ''}`, { timeout: 180000 });
await page.waitForFunction(() => typeof window.__pump === 'function' && !!document.body, null, { timeout: 180000 });
log(`film ${TAG}: ${W}x${H} dpr ${DPR}, step ${STEP}, a frame every ${EVERY} s of tour time${FROM ? ', from ' + FROM : ''}`);

const frames = [];
let final = null, lastStop = Date.now();
for (;;) {
  const r = await pump().then(ok => (ok ? page.evaluate(() => { const d = window.__sw.app.demo; return d.filmReady ? { stop: d.filmReady } : { over: true }; }) : { over: true, error: 'no picture stop in 960000 frames' })).catch(err => ({ over: true, error: err.message }));
  if (r.error) problems.push('the tour stalled: ' + r.error.split('\n')[0]);
  if (r.over) break;
  const s = r.stop;
  const past = STOP_AFTER && (await page.evaluate(id => { const st = window.__sw.app.demo.state(); const i = st.chapters.findIndex(c => c.id === id); return i >= 0 && st.index > i; }, STOP_AFTER));
  if (past) break;
  if (!ONLY.length || ONLY.includes(s.chapter)) {
    // two more drawn frames so the picture is the paused state (camera easing has a frame of lag), then the shot
    await page.evaluate(() => window.__pump(1, 1));          // (a held frame is always drawn)
    const info = await page.evaluate(probeDemo);
    const mm = Math.floor(s.clock / 60), ss = Math.floor(s.clock % 60);
    const name = `f${String(s.n).padStart(4, '0')}-${String(mm).padStart(2, '0')}m${String(ss).padStart(2, '0')}s-${s.chapter || 'none'}.png`;
    await page.screenshot({ path: path.join(OUT, name), timeout: 300000 });
    info.file = name; info.wall = Math.round((Date.now() - t0) / 1000);
    frames.push(info);
    const fl = info.flight;
    log(`${name}  +${((Date.now() - lastStop) / 1000).toFixed(0)}s  ${info.screen}${info.fade > 0.02 ? ' fade ' + info.fade : ''}${info.card ? ' CARD' : ''}  "${info.caption}"${fl ? `  ${fl.name}@${fl.body} ${fl.situation} alt ${fl.alt} radar ${fl.radar} cam+${fl.camClear} d${fl.dist} at ${fl.subject ? fl.subject.x + ',' + fl.subject.y : '?'}${info.mapOpen ? ' MAP' : ''}` : ''}`);
    fs.writeFileSync(path.join(OUT, 'film.json'), JSON.stringify(frames, null, 1));
  }
  lastStop = Date.now();
  await page.evaluate(() => window.__sw.app.demo.resume());
}
final = await page.evaluate(() => { const d = window.__sw.app.demo, s = d.state(); return { ...s, watch: d.watchReport ? d.watchReport(true) : null }; }).catch(() => null);
await page.evaluate(() => window.__sw.app.demo.stop()).catch(() => {});
await browser.close();
await server.close();

if (final) {
  log('');
  let total = 0;
  for (const c of final.chapters) {
    if (c.status === 'pending') continue;
    total += c.seconds || 0;
    log(`  ${c.id.padEnd(9)} ${String(c.status).padEnd(8)} ${String(c.seconds ?? '').padStart(6)} s  captions ${c.captions}${c.lapseCut ? '  lapse cut short ' + c.lapseCut + '×' : ''}${c.fallbacks && c.fallbacks.length ? '  fallback: ' + c.fallbacks.join('; ') : ''}${c.error ? '  error: ' + c.error : ''}`);
    if (c.status !== 'ok' && c.status !== 'left' && c.status !== 'running') problems.push(`chapter ${c.id} ended as "${c.status}"${c.error ? ': ' + c.error : ''}${c.fallbacks && c.fallbacks.length ? ' (' + c.fallbacks.join('; ') + ')' : ''}`);
  }
  log(`  tour length ${Math.floor(final.clock / 60)}:${String(Math.round(final.clock % 60)).padStart(2, '0')} (${final.clock} s of tour time; chapters ${total.toFixed(1)} s), ${frames.length} frames, ${((Date.now() - t0) / 60000).toFixed(1)} min to film`);
  if (final.watch) { log('  watch: ' + JSON.stringify(final.watch)); for (const w of final.watch.problems || []) problems.push('watch: ' + w); }
  fs.appendFileSync(LOG, '\n' + final.log.map(l => `${String(l.t).padStart(7)} ${l.chapter.padEnd(9)} ${l.kind.padEnd(5)} ${l.msg}`).join('\n') + '\n');
}
// contact sheets: six frames to a sheet, labelled, for a first look (read the single frames where a sheet looks wrong)
try {
  const files = frames.map(f => f.file);
  for (let i = 0, n = 1; i < files.length; i += 6, n++) {
    const group = files.slice(i, i + 6);
    execFileSync('montage', [...group.flatMap(f => ['-label', f.replace(/\.png$/, ''), path.join(OUT, f)]), '-tile', '3x2', '-geometry', '640x400+4+4', '-background', '#101418', '-fill', '#d0d8e0', '-pointsize', '15', path.join(OUT, `sheet-${String(n).padStart(2, '0')}.png`)], { stdio: 'ignore' });
  }
  log(`  ${Math.ceil(files.length / 6)} contact sheets in ${path.relative(ROOT, OUT)}`);
} catch (err) { log('  (no contact sheets: ' + String(err && err.message).split('\n')[0] + ')'); }
for (const p of problems) log('PROBLEM ' + p);
log(`${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);
