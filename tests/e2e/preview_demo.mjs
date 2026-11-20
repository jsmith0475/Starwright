// Preview captures of the demo tour: one full-quality picture of every chapter's key frame, for eyeballing.
//   node tests/e2e/preview_demo.mjs [chapters,comma,separated] [WxH]     → tests/out/demo-<nn>-<chapter>[-<name>]-<w>x<h>.png
// Each chapter is opened on its own with ?demo=1&chapter=<id>&fast=1&hq=1&poster=1: the tour runs accelerated at full
// graphics quality and holds at the chapter's key frame (d.poster() in js/ui/demo/chapters.js) until the picture is taken.
// It is a capture script, not a test: it fails only on page errors or when a chapter never reaches its key frame.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const ALL = ['title', 'centre', 'build', 'launch', 'orbit', 'map', 'landing', 'eva', 'reentry', 'plane', 'rover', 'docking', 'tracking', 'system', 'program', 'closing'];
const ONLY = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);
const [W, H] = (process.argv[3] || '1920x1080').split('x').map(Number);
const HQ = process.env.DEMO_LQ ? '' : '&hq=1';
const problems = [];

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));

for (const id of ALL) {
  if (ONLY.length && !ONLY.includes(id)) continue;
  const nn = String(ALL.indexOf(id) + 1).padStart(2, '0');
  const t0 = Date.now();
  await page.goto('about:blank', { timeout: 180000 }).catch(() => {});      // drop the previous (heavy) page first
  await page.goto(server.url + `index.html?demo=1&chapter=${id}&fast=1&poster=1&clean=1${HQ}`, { timeout: 180000 });
  await page.waitForFunction(() => document.body.dataset.ready === '1' && window.__sw && window.__sw.app.demo && window.__sw.app.demo.running, null, { timeout: 180000 });
  let shots = 0;
  for (;;) {
    // the next key frame of this chapter, or the chapter's end
    const r = await page.waitForFunction(cid => {
      const d = window.__sw.app.demo, s = d.state();
      if (d.posterReady && d.posterReady.chapter === cid) return { poster: d.posterReady };
      if (!s.running || s.chapter !== cid) return { over: true, status: (s.chapters.find(c => c.id === cid) || {}).status, error: (s.chapters.find(c => c.id === cid) || {}).error, fallbacks: (s.chapters.find(c => c.id === cid) || {}).fallbacks };
      return null;
    }, id, { timeout: 900000, polling: 250 }).then(h => h.jsonValue()).catch(err => ({ over: true, status: 'timeout', error: err.message }));
    if (r.over) {
      if (!shots) problems.push(`chapter ${id} never reached a key frame (${r.status}${r.error ? ': ' + r.error : ''})`);
      if (r.status !== 'ok' && r.status !== 'left') console.log(`  ${id}: ended as ${r.status}${r.error ? ' — ' + r.error : ''}${r.fallbacks && r.fallbacks.length ? ' — ' + r.fallbacks.join('; ') : ''}`);
      break;
    }
    await page.waitForTimeout(HQ ? 2500 : 600);                 // let the paused frame finish drawing (shadows, post chain, caption slide-in)
    const file = path.join(OUT, `demo-${nn}-${id}${r.poster.name ? '-' + r.poster.name : ''}${shots && !r.poster.name ? '-' + (shots + 1) : ''}-${W}x${H}.png`);
    await page.screenshot({ path: file, timeout: 300000 });
    console.log(`  ${path.relative(ROOT, file)}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    shots++;
    await page.evaluate(() => window.__sw.app.demo.resume());
    await page.waitForFunction(() => !window.__sw.app.demo.posterReady, null, { timeout: 30000 }).catch(() => {});
  }
  await page.evaluate(() => window.__sw.app.demo.stop()).catch(() => {});
}
await browser.close();
await server.close();
for (const p of problems) console.log('PROBLEM ' + p);
console.log(`${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);
