// Full-resolution stills of the Shearwater mission for the docs and pull requests: the tower catch and the Topping Up
// scenario, with graphics forced to "high" and automatic quality off, HUD hidden. On a machine with no graphics card
// each frame takes seconds; that does not matter for stills.
//   node tests/tools/shearwater_stills.mjs [outDir] [refuel|tower]     (default: both)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from '../e2e/server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'tests/out/stills')), ONLY = process.argv[3] || '';
fs.mkdirSync(OUT, { recursive: true });
const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.setDefaultTimeout(600000);
page.on('pageerror', e => console.log('page error: ' + e.message));
const E = (fn, arg) => page.evaluate(fn, arg);
const waitScreen = async name => { await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 600000 }); await page.waitForTimeout(500); };
const hq = () => E(() => { const a = window.__sw.app, s = a.settings; s.gfxForce = true; s.gfxQuality = 'high'; s.gfxAuto = false; s.showHints = false; if (a.applySettings) a.applySettings(); });
async function ff(sim, until = 'false') {
  let left = sim, hit = false;
  while (left > 0 && !hit) {
    const r = await E(({ budget, until }) => {
      const sw = window.__sw, app = sw.app, test = new Function('w', 'v', 'return (' + until + ');');
      const t0 = performance.now(), ut0 = sw.world.ut; let hit = false;
      while (performance.now() - t0 < 400 && app.currentName === 'flight' && sw.world.ut - ut0 < budget) {
        app.current.update(0.02); app.input.endFrame();
        if (test(sw.world, sw.world.active)) { hit = true; break; }
      }
      return { advanced: sw.world.ut - ut0, hit };
    }, { budget: left, until });
    hit = r.hit; left -= Math.max(r.advanced, 0.01);
  }
  return hit;
}
const cam = (yaw, pitch, dist) => E(([yaw, pitch, dist]) => { const f = window.__sw.app.flight, c = f.cam; c.yaw = yaw; c.pitch = pitch; c.setDist(dist); c.snap(); const g = f.view && f.view.governor; if (g) g.lock(0); if (f.view && f.view.settleTerrain) f.view.settleTerrain(4000); }, [yaw, pitch, dist]);
async function shot(name, hud = false) {
  await E(h => { const f = window.__sw.app.flight; f.hud.setHidden(!h); window.__sw.app.paused = true; }, hud).catch(() => {});
  // several real frames so that terrain, shadows and the environment probe are in
  for (let i = 0; i < 6; i++) await E(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  await E(() => { window.__sw.app.paused = false; });
  console.log('  ' + name);
}

await page.goto(server.url);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 600000 });
await hq();

if (ONLY !== 'tower') {
// ---- refuelling: the Topping Up scenario
await page.click('.sw-menu [data-action="scenarios"]');
await page.waitForSelector('.sw-scn-modal .sw-scn-grid');
const btn = page.locator('.sw-scn-card[data-scenario="topping-up"] [data-action="start"]');
await btn.scrollIntoViewIfNeeded(); await btn.click();
await waitScreen('flight');
await page.waitForSelector('.sw-scn-brief', { timeout: 60000 });
await E(() => { const b = document.querySelector('.sw-scn-brief .sw-btn, .sw-modal .sw-btn.primary'); if (b) b.click(); });
await hq();
await ff(1);
await E(() => window.__sw.app.flight.actions.toggleDockAssist());
await ff(95);
await cam(0.9, 0.25, 110); await shot('refuel-1-approach');
await ff(900, 'v.dockedPairs.length > 0'); await ff(3);
await cam(0.6, 0.3, 95); await shot('refuel-2-docked');
await cam(2.3, 0.1, 70); await shot('refuel-3-docked-other-side');
await E(() => window.__sw.app.flight.actions.pumpStart('in'));
await ff(60);
await E(() => window.__sw.app.flight.hud.togglePanel('fuel'));
await cam(0.6, 0.3, 95); await shot('refuel-4-pumping-panel', true);
await E(() => window.__sw.app.flight.hud.closePanels());

}

// ---- the tower: on the mount, coming down, held
if (ONLY !== 'refuel') {
await E(async () => { const app = window.__sw.app; if (app.currentName !== 'title') await app.exitToTitle(); });
await waitScreen('title');
await page.click('[data-action="new"]');
await page.click('.sw-mode[data-mode="sandbox"]');
await page.click('.sw-modal .sw-btn.primary');
await waitScreen('hub');
await E(async () => {
  const { stockCrafts } = await import('/js/core/craft.js');
  const c = stockCrafts().find(x => x.name === 'Shearwater');
  window.__sw.app.goto('flight', { craft: c.toJSON(), crew: ['Ada', 'Bo'] });
});
await waitScreen('flight');
await hq();
await ff(0.5);
await cam(0.9, 0.12, 230); await shot('tower-1-on-the-mount');
await cam(2.4, 0.5, 150); await shot('tower-2-from-above');
await page.keyboard.down('Space'); await E(() => { const a = window.__sw.app; a.current.update(0.02); a.input.endFrame(); }); await page.keyboard.up('Space');
await E(() => { const w = window.__sw.world; window.__b = { sep: false, caught: false }; w.on('decouple', () => { window.__b.sep = true; }); w.on('caught', () => { window.__b.caught = true; }); window.__sw.app.flight.actions.toggleAssist(); });
await ff(5); await cam(0.9, 0.05, 260); await shot('tower-3-liftoff');
await ff(240, 'window.__b.sep'); await ff(3);
await page.keyboard.down('Backslash'); await E(() => { const a = window.__sw.app; a.current.update(0.02); a.input.endFrame(); }); await page.keyboard.up('Backslash');
await ff(400, 'v.radarAlt < 150 && v.vel.dot(v.pos) < 0 && w.ut > 200 && v.partList.some(p => p.type === "eng_peregrine33") && v.altitude < 400');
await cam(0.9, 0.1, 240); await shot('tower-4-coming-down');
await ff(120, 'window.__b.caught'); await ff(4);
await cam(0.9, 0.1, 200); await shot('tower-5-caught');
await cam(2.2, 0.45, 110); await shot('tower-6-caught-above');
}

await browser.close(); await server.close();
