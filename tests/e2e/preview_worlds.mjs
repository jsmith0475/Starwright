// Worlds preview: renders every body from orbit, low orbit, 5 km and standing on the ground, at noon and at low
// sun, plus the sky from Verda's surface at day, dusk and night and the space-centre site, with the renderer
// settings of docs/SECOND_PASS.md. Fails on any console error; saves tests/out/worlds_*.png and prints the frame
// cost (draw calls, triangles) of each view.
//   node tests/e2e/preview_worlds.mjs [filter-substring] [--size=1440x900] [--quick]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--')) || '';      // substring, or several separated by commas
const filters = filter.split(',').filter(Boolean);
const size = (args.find((a) => a.startsWith('--size=')) || '--size=1440x900').slice(7).split('x').map(Number);

const SOLID = ['sear', 'cindra', 'murk', 'verda', 'pell', 'ost', 'rusk', 'dray', 'tiv', 'marn', 'slate', 'nock', 'brim', 'quell', 'nym', 'wend'];
const GAS = ['thal', 'orrin'];
const shots = [];
for (const b of [...SOLID, ...GAS, 'helion']) shots.push([`${b}_orbit`, `body=${b}&view=orbit`]);
for (const b of SOLID) {
  shots.push([`${b}_low`, `body=${b}&view=low&sun=35`]);
  shots.push([`${b}_air_noon`, `body=${b}&view=air&sun=60`]);
  shots.push([`${b}_air_lowsun`, `body=${b}&view=air&sun=7`]);
  shots.push([`${b}_ground_noon`, `body=${b}&view=ground&sun=60`]);
  shots.push([`${b}_ground_lowsun`, `body=${b}&view=ground&sun=6`]);
}
for (const b of GAS) shots.push([`${b}_low`, `body=${b}&view=low&sun=35&alt=${b === 'thal' ? 900000 : 800000}`]);
shots.push(
  ['verda_sky_day', 'body=verda&view=sky&sun=45&site=pad'],
  ['verda_sky_dusk', 'body=verda&view=sky&sun=1.5&site=pad&az=0&pitch=12'],
  ['verda_sky_night', 'body=verda&view=sky&sun=-30&site=pad&pitch=40'],
  ['verda_base_noon', 'body=verda&view=base&sun=55'],
  ['verda_base_lowsun', 'body=verda&view=base&sun=5&az=200'],
  ['verda_coast', 'body=verda&view=coast&sun=25&pm=1'],
  ['verda_base_air', 'body=verda&view=base&sun=40&alt=2500&pitch=-25&az=270'],
  ['pell_night', 'body=pell&view=ground&sun=-25'],
  ['pell_terminator', 'body=pell&view=low&sun=3'],
  ['orrin_rings', 'body=orrin&view=orbit&alt=14000000&phase=70'],
  ['murk_low_clouds', 'body=murk&view=low&sun=40&alt=120000'],
  // the home world close up, away from the space centre: meadow, forest edge, and the same at low sun
  ['verda_meadow', 'body=verda&view=ground&sun=42&lat=0.05&lon=-0.42&az=60'],
  ['verda_meadow_lowsun', 'body=verda&view=ground&sun=7&lat=0.05&lon=-0.42&az=35'],
  ['verda_meadow_30m', 'body=verda&view=ground&sun=35&lat=0.05&lon=-0.42&alt=30&pitch=-14&az=70'],
  ['verda_hills_300m', 'body=verda&view=ground&sun=30&lat=0.3&lon=-0.8&alt=300&pitch=-12&az=60'],
  ['wend_tail', 'body=wend&view=orbit&alt=9000000&phase=80&ut=perihelion'],
  ['verda_forest', 'body=verda&view=ground&sun=35&lat=0.3&lon=-0.8&alt=3&az=70&pitch=3'],
  ['verda_clouds_20km', 'body=verda&view=air&sun=40&alt=20000&pitch=-18'],
  ['verda_clouds_under', 'body=verda&view=air&sun=30&alt=3000&pitch=14'],
  ['verda_sunset', 'body=verda&view=sky&sun=3&site=pad&az=0&pitch=8&pm=1'],
  ['verda_night_orbit', 'body=verda&view=orbit&phase=150'],
  ['verda_night_low', 'body=verda&view=low&sun=-12'],
  // probes: orange balls of 0.3 m radius rest on the ground physics uses; they must rest on the drawn ground too
  ['pell_probe', 'body=pell&view=ground&sun=30&probe=1&alt=4&pitch=-12'],
  ['rusk_probe', 'body=rusk&view=ground&sun=30&probe=1&alt=4&pitch=-12'],
  ['verda_probe', 'body=verda&view=ground&sun=42&lat=0.3&lon=-0.8&probe=1&alt=4&pitch=-12'],
  ['nock_probe', 'body=nock&view=ground&sun=30&probe=1&alt=4&pitch=-12'],
);
// --quick: a representative couple of dozen views (the full list takes over an hour on software GL)
const QUICK = ['verda_orbit', 'murk_orbit', 'thal_orbit', 'quell_orbit', 'helion_orbit', 'orrin_rings', 'verda_low', 'verda_air_noon',
  'verda_ground_noon', 'verda_ground_lowsun', 'pell_ground_noon', 'pell_ground_lowsun', 'pell_night', 'rusk_ground_lowsun',
  'tiv_ground_lowsun', 'marn_ground_noon', 'sear_ground_noon', 'brim_air_lowsun', 'verda_sky_day', 'verda_sky_dusk', 'verda_sky_night',
  'verda_base_noon', 'verda_coast', 'verda_base_air'];
// --add=name:query adds a one-off view (debugging), e.g. --add=x:body=verda&view=base&dbg=hideclouds
for (const a of args.filter((x) => x.startsWith('--add='))) { const i = a.indexOf(':'); shots.push([a.slice(6, i), a.slice(i + 1)]); }
const quick = args.includes('--quick');
const list = shots.filter((s) => (!filters.length || filters.some((f) => (f.endsWith('$') ? s[0] === f.slice(0, -1) : s[0].includes(f)))) && (!quick || QUICK.includes(s[0])));

const { chromium } = await loadPlaywright();
const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const errors = [], rows = [], heightRows = [];
try {
  for (const [name, query] of list) {
    const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${name}] console: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[${name}] exception: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) errors.push(`[${name}] HTTP ${r.status()}: ${r.url()}`); });
    await page.goto(`${server.url}tests/worlds-preview.html?${query}`);
    try { await page.waitForFunction('window.__previewReady === true', null, { timeout: 150000 }); }
    catch { errors.push(`[${name}] preview never became ready`); }
    await page.waitForTimeout(250);
    const suffix = size[0] === 1440 ? '' : `_${size[0]}`;
    try { await page.waitForFunction('window.__previewDone === true', null, { timeout: 60000 }); } catch { /* slow software GL */ }
    await page.screenshot({ path: path.join(OUT, `worlds_${name}${suffix}.png`), timeout: 120000 });
    const st = await page.evaluate('window.__stats');
    if (st) {
      rows.push([name, st]);
      // the drawn ground against the ground physics stands on, within 25 m of the scene origin (the vessel's place)
      const hp = st.heights;
      if (hp && hp.near && hp.near.n && st.alt < 2000 && !st.timedOut) {
        heightRows.push([name, hp]);
        if (hp.near.max > 0.12 || hp.near.mean > 0.02) errors.push(`[${name}] drawn ground is off the physics ground near the origin: max ${(hp.near.max * 100).toFixed(1)} cm, mean ${(hp.near.mean * 100).toFixed(1)} cm (grid ${hp.near.spacing.toFixed(2)} m)`);
      }
      console.log(`ok  ${name.padEnd(24)} ${String(st.calls).padStart(4)} draws ${String(Math.round(st.triangles / 1000)).padStart(5)}k tris  ${String(st.chunks).padStart(4)} chunks  (terrain ${Math.round(st.terrainTriangles / 1000)}k shown, clutter ${st.clutter || 0} = ${Math.round((st.clutterTriangles || 0) / 1000)}k)  ${(st.ms / 1000).toFixed(1)} s${st.timedOut ? '  (TIMED OUT waiting for chunks)' : ''}`);
      if (st.timedOut) errors.push(`[${name}] terrain never settled`);
    }
    await page.close();
  }
} finally {
  await browser.close(); await server.close();
}
const ground = rows.filter(([n]) => /ground|base|coast/.test(n));
if (ground.length) {
  const mc = Math.max(...ground.map(([, s]) => s.calls)), mt = Math.max(...ground.map(([, s]) => s.triangles));
  console.log(`\nground views: up to ${mc} draw calls and ${(mt / 1000).toFixed(0)}k triangles per frame`);
}
if (heightRows.length) {
  console.log('\ndrawn ground vs physics ground (heightAt − terrainHeight), within 25 m / within 60 m of the origin:');
  for (const [n, h] of heightRows) console.log(`  ${n.padEnd(24)} near: max ${(h.near.max * 100).toFixed(1)} cm, mean ${(h.near.mean * 100).toFixed(2)} cm, grid ${h.near.spacing.toFixed(2)} m   wide: max ${(h.max * 100).toFixed(1)} cm, mean ${(h.mean * 100).toFixed(2)} cm`);
}
const real = errors.filter((e) => !/favicon/.test(e));
if (real.length) { console.error('\nFAILED:\n' + real.join('\n')); process.exit(1); }
console.log(`\nworlds preview: ${list.length} views OK, screenshots in tests/out/worlds_*.png`);
