// Parts preview: renders contact sheets of every part (stowed and active states), thumbnails, LOD comparisons
// and a few assembled vehicles with the renderer settings from docs/SECOND_PASS.md, into tests/out/parts_*.png.
// Fails on any console error or page exception.
//   node tests/e2e/preview_parts.mjs [filter-substring] [--size=1440x900]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';
import { CATEGORIES, PART_LIST } from '../../js/core/parts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out'); fs.mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2), filter = args.find(a => !a.startsWith('--')) || '', sizeArg = (args.find(a => a.startsWith('--size=')) || '--size=1440x900').slice(7).split('x').map(Number);
const custom = args.find(a => a.startsWith('--q='));   // --q="view=close&ids=..." --name=foo renders one ad-hoc shot
const PER = 24;
let shots = [];
if (custom) shots.push([(args.find(a => a.startsWith('--name=')) || '--name=adhoc').slice(7), custom.slice(4)]);
else {
  for (const c of CATEGORIES) {
    const n = Math.ceil(PART_LIST.filter(d => d.cat === c.id).length / PER);
    for (let p = 0; p < n; p++) for (const s of [0, 1]) shots.push([`sheet_${c.id}_${p}_${s}`, `view=sheet&cat=${c.id}&page=${p}&state=${s}&per=${PER}`]);
  }
  shots.push(['thumbs', 'view=thumbs'], ['lod', 'view=lod'], ['rockets_stock', 'view=rockets&set=0'], ['rockets_heavy', 'view=rockets&set=1'], ['rockets_plane', 'view=rockets&set=2&az=0.7&el=0.3'],
    ['close_engines', 'view=close&ids=eng_goshawk,eng_sparrow,eng_heron,jet_puffin,eng_whisper&az=0.5&el=-0.12&state=1'], ['close_pods', 'view=close&ids=pod_acorn,cockpit_swift,probe_wisp,pod_burrow'],
    ['close_wheels', 'view=close&ids=wheel_lumber,wheel_scamper,gear_tuck_m,legs&state=0']);
  shots = shots.filter(s => s[0].includes(filter));
}

const server = await startServer(ROOT);
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const errors = []; const stats = [];
try {
  const queue = [...shots], jobs = +(args.find(a => a.startsWith('--jobs=')) || '--jobs=1').slice(7);
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [name, query] = job;
      const page = await browser.newPage({ viewport: { width: sizeArg[0], height: sizeArg[1] } });
      page.on('console', m => { if (m.type() === 'error') errors.push(`[${name}] console: ${m.text()}`); else if (m.type() === 'warning' && m.text().includes('[partmesh]')) errors.push(`[${name}] ${m.text()}`); });
      page.on('pageerror', e => errors.push(`[${name}] exception: ${e.message}`));
      page.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) errors.push(`[${name}] HTTP ${r.status()}: ${r.url()}`); });
      const t0 = Date.now();
      await page.goto(`${server.url}tests/parts-preview.html?${query}`, { waitUntil: "commit", timeout: 120000 });
      try { await page.waitForFunction('window.__previewReady === true', null, { timeout: 240000 }); } catch { errors.push(`[${name}] preview never became ready`); }
      await page.waitForTimeout(250);
      const info = await page.evaluate(() => window.__info || null);
      await page.screenshot({ path: path.join(OUT, `parts_${name}.png`), timeout: 120000 });
      stats.push(`${name}: ${Date.now() - t0} ms${info ? `, ${info.calls} draw calls, ${(info.triangles / 1000).toFixed(0)}k tris, ${info.textures} textures` : ''}`);
      await page.close();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, shots.length) }, worker));
} finally { await browser.close(); await server.close(); }
for (const s of stats) console.log(s);
if (errors.length) { console.error(`\n${errors.length} error(s):\n` + errors.slice(0, 40).join('\n')); process.exit(1); }
console.log(`\nparts preview: ${shots.length} screenshots in tests/out/parts_*.png, no errors`);
