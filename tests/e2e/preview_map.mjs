// Screenshot tour of the orbital map and the tracking station (no assertions; LOOK at tests/out/mapprev-*.png).
//   node tests/e2e/preview_map.mjs [filter]      filter = substring of a shot name, e.g. "plan" or "1024"
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const filter = process.argv[2] || '';
const SIZES = [[1440, 900], [1024, 768]];
const errors = [];

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });

async function open(query, [width, height]) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);            // software GL on a busy machine can take seconds per frame
  page.on('console', m => { if (m.type() === 'error') errors.push(query + ': ' + m.text()); });
  page.on('pageerror', e => errors.push(query + ': ' + (e.stack || e.message)));
  await page.goto(server.url + 'tests/map-preview.html' + query);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(900);
  return { ctx, page };
}
const view = (page, v) => page.evaluate(v => window.__map.setView(v), v);
const focus = (page, id) => page.evaluate(id => window.__map.focus(id, { instant: true }), id);
async function shot(page, name, size, wait = 900) {
  const file = `mapprev-${name}-${size[0]}.png`;
  if (filter && !file.includes(filter)) return;
  await page.waitForTimeout(wait);
  await page.screenshot({ path: path.join(OUT, file) });
  const ms = await page.evaluate(() => window.__frameMs || null);
  console.log('  ' + file + (ms ? `   (map frame ${ms.avg.toFixed(1)} ms avg, ${ms.worst.toFixed(1)} worst)` : ''));
}

try {
  for (const size of SIZES) {
    console.log(size.join('×'));
    const cx = size[0] / 2, cy = size[1] / 2;

    // ---- the whole system, the inner system, every planet with its moons
    {
      const { ctx, page } = await open('?scene=fleet', size);
      await focus(page, 'helion');
      await view(page, { yaw: 0.5, pitch: 0.62 });
      await shot(page, '01-system', size, 2500);
      await view(page, { dist: 8.5e10, yaw: 0.9, pitch: 0.5 });
      await shot(page, '02-inner-system', size, 1200);
      const planets = await page.evaluate(() => window.__SYSTEM.bodies.filter(b => b.type === 'planet').map(b => ({ id: b.id, moons: b.children.length })));
      let i = 3;
      for (const p of planets) {
        await focus(page, p.id);
        if (p.moons) await page.evaluate(id => { const m = window.__map; m.setView({ dist: m.systemDist(window.__SYSTEM.byId[id]), yaw: 0.7, pitch: 0.45 }); }, p.id);
        else await view(page, { yaw: 0.7, pitch: 0.3 });
        await shot(page, String(i++).padStart(2, '0') + '-' + p.id, size, 2200);
        if (p.moons) { await focus(page, p.id); await view(page, { yaw: -0.6, pitch: 0.25 }); await shot(page, String(i - 1).padStart(2, '0') + '-' + p.id + '-close', size, 1800); }
      }
      // hover card on a vessel in the Verda system
      await focus(page, 'verda'); await view(page, { dist: 6e6, yaw: 0.3, pitch: 0.5 });
      await page.waitForTimeout(600);
      const v = await page.evaluate(() => window.__map.debug().vessels.find(v => v.x > 350 && v.x < innerWidth - 350 && v.y > 150 && v.y < innerHeight - 200 && v.role !== 'debris'));
      if (v) { await page.mouse.move(v.x + 2, v.y + 1); }
      await shot(page, '20-fleet-hover', size, 700);
      await ctx.close();
    }

    // ---- default flight map, target with AN / DN and two intercepts
    {
      const { ctx, page } = await open('?target=1', size);
      await shot(page, '21-flight-open', size);
      await page.evaluate(() => { const w = window.__world; w.setTarget(w.active, 6); });
      await view(page, { dist: 3.6e6, yaw: 0.2, pitch: 0.75 });
      await shot(page, '22-target', size, 1800);
      await ctx.close();
    }

    // ---- interplanetary transfer with an encounter
    {
      const { ctx, page } = await open('?scene=transfer', size);
      await focus(page, 'helion');
      await view(page, { dist: 7.5e10, yaw: 0.4, pitch: 0.7 });
      await page.evaluate(() => { const w = window.__world; w.setTarget(w.active, 'rusk'); });
      await shot(page, '23-transfer', size, 1800);
      await focus(page, 'rusk');
      await view(page, { dist: 2.4e8, yaw: 0.4, pitch: 0.6 });
      await shot(page, '24-transfer-encounter', size, 1500);
      await ctx.close();
    }

    // ---- a three-burn plan
    {
      const { ctx, page } = await open('?scene=plan', size);
      await focus(page, 'verda');
      await view(page, { dist: 3.9e7, yaw: 0.25, pitch: 0.8 });
      await page.evaluate(() => { const w = window.__world; w.setTarget(w.active, 'pell'); });
      await shot(page, '25-plan', size, 1800);
      await page.evaluate(() => window.__map.selectNode(window.__world.active.nodes[0]));
      await page.evaluate(() => window.__map.focus(window.__world.active, { instant: true }));
      await view(page, { dist: 4.2e6, yaw: 0.2, pitch: 0.6 });
      await shot(page, '26-plan-node1', size, 1500);
      await focus(page, 'pell');
      await view(page, { dist: 3.2e6, yaw: 0.9, pitch: 0.55 });
      await page.evaluate(() => window.__map.selectNode(window.__world.active.nodes[1] || null));
      await shot(page, '27-plan-capture', size, 1500);
      await ctx.close();
    }

    // ---- suborbital paths: atmosphere entry, impact point
    {
      const { ctx, page } = await open('?scene=suborbital', size);
      await view(page, { yaw: 0.2, pitch: 0.35 });
      await shot(page, '28-atmo-entry', size, 1200);
      await ctx.close();
      const b = await open('?scene=suborbital&active=pell', size);
      await b.page.evaluate(() => window.__map.setView({ yaw: 1.7, pitch: 0.4 }));
      await shot(b.page, '29-impact', size, 1200);
      await b.ctx.close();
    }

    // ---- tracking station (real world)
    {
      const { ctx, page } = await open('?screen=tracking&real=1', size);
      await shot(page, '30-tracking', size, 2500);
      await page.locator('.trk-item[data-vessel]').nth(1).click();
      await shot(page, '31-tracking-transfer', size, 2200);
      await page.locator('.trk-tab[data-tab="worlds"]').click();
      await page.locator('.trk-item[data-body="rusk"]').click();
      await shot(page, '32-tracking-worlds', size, 2400);
      await page.locator('.trk-item[data-body="helion"]').click();
      await page.mouse.move(cx, cy);
      await shot(page, '33-tracking-system', size, 2600);
      await ctx.close();
    }
  }
} catch (err) {
  errors.push('crashed: ' + (err.stack || err.message));
} finally {
  await browser.close();
  await server.close();
}
if (errors.length) { console.log('\n' + errors.length + ' error(s):'); for (const e of errors) console.log(' - ' + e); }
process.exit(errors.length ? 1 : 0);
