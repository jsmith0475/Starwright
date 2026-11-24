// End-to-end check of the ship coming home in the real game (docs/SHEARWATER.md, step 4): the Belly First scenario,
// the Autopilot panel's "Return to the tower", the fall on the flaps, the flip and the catch.
//   node tests/e2e/belly_first.mjs     (screenshots land in tests/out/belly-*.png)
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

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.setDefaultTimeout(180000);
page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
const shot = async name => { await page.waitForTimeout(700); await page.screenshot({ path: path.join(OUT, name + '.png') }); };
const waitScreen = async name => { await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 240000 }); await page.waitForTimeout(400); };
async function ff(sim, until = 'false') {
  let left = sim, hit = false;
  while (left > 0 && !hit) {
    const r = await page.evaluate(({ budget, until }) => {
      const sw = window.__sw, app = sw.app, test = new Function('w', 'v', 'B', 'return (' + until + ');');
      const t0 = performance.now(), ut0 = sw.world.ut; let hit = false;
      while (performance.now() - t0 < 400 && app.currentName === 'flight' && sw.world.ut - ut0 < budget) {
        app.current.update(0.02); app.input.endFrame();
        if (test(sw.world, sw.world.active, window.__shw)) { hit = true; break; }
      }
      return { advanced: sw.world.ut - ut0, hit };
    }, { budget: left, until });
    hit = r.hit; left -= Math.max(r.advanced, 0.01);
  }
  return hit;
}
const key = async code => { await page.keyboard.down(code); await page.waitForTimeout(60); await page.evaluate(() => { const a = window.__sw.app; a.current.update(0.02); a.input.endFrame(); }); await page.keyboard.up(code); await page.waitForTimeout(40); };
const E = fn => page.evaluate(fn);
const state = () => page.evaluate(() => {
  const sw = window.__sw, w = sw.world, v = w.active, B = window.__shw;
  const flaps = v.partList.filter(p => p.def.flap).map(p => +(p.fold || 0).toFixed(2));
  const u = v.surfaceVel.clone().normalize(), q = v.q;
  const nose = u.clone().set(0, 1, 0).applyQuaternion(q), belly = u.clone().set(0, 0, -1).applyQuaternion(q);
  return { name: v.name, mass: v.mass, alt: v.altitude, speed: v.surfaceVel.length(), dead: v.dead, landed: v.landed, held: v.surface && v.surface.held, sas: v.ctrl.sasMode, aoa: Math.acos(Math.max(-1, Math.min(1, nose.dot(u)))) * 180 / Math.PI, bellyLead: belly.dot(u),
    bellyAoa: v.bellyAoa * 180 / Math.PI, flaps, temp: v.maxTempRatio || 0, parts: v.partList.length, warp: w.warp, assistKind: sw.app.flight.assistKind, phase: sw.app.flight.assist ? (sw.app.flight.assist.landing ? 'landing' : sw.app.flight.assist.phase) : '',
    toasts: B ? B.toasts.slice() : [], done: (sw.app.career && sw.app.career.scenario && sw.app.career.scenario.done) || [], drawnFold: (() => { let m = 0; for (const sc of [sw.app.flight.scene, sw.app.flight.nearScene]) if (sc && sc.traverse) sc.traverse(o => { if (o.name === 'bladeA' || o.name === 'bladeB') m = Math.max(m, Math.abs(o.rotation.y)); }); return m; })() };
});

console.log('\n=== Belly First: the ship comes home from orbit to the tower arms (1440×900) ===');
await page.goto(server.url);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
await page.waitForSelector('.sw-menu [data-action="scenarios"]');
await page.click('.sw-menu [data-action="scenarios"]');
await page.waitForSelector('.sw-scn-modal .sw-scn-grid');
const btn = page.locator('.sw-scn-card[data-scenario="belly-first"] [data-action="start"]');
await btn.scrollIntoViewIfNeeded();
await btn.click();
await waitScreen('flight');
await page.waitForSelector('.sw-scn-brief', { timeout: 60000 });
await shot('belly-1-brief');
await E(() => { const b = document.querySelector('.sw-scn-brief .sw-btn, .sw-modal .sw-btn.primary'); if (b) b.click(); });
await page.waitForTimeout(600);
await E(() => {
  const sw = window.__sw, B = window.__shw = { toasts: [] };
  const toast = sw.app.toast.bind(sw.app);
  sw.app.toast = (text, ...rest) => { B.toasts.push(String(text)); return toast(text, ...rest); };
});
let s = await state();
ok(s.name === 'Shearwater' && Math.abs(s.mass - 95600) < 1500, `Shearwater, ${(s.mass / 1000).toFixed(1)} t, in orbit at ${(s.alt / 1000).toFixed(0)} km`);
ok(await page.locator('[data-sas="belly"]').isVisible(), 'the SAS row has a BELLY button on this ship');
await ff(1); await shot('belly-2-orbit');

// the Autopilot panel offers the return, and it flies it
await page.click('[data-tool="guide"]');
await page.waitForSelector('[data-program="shipreturn"]');
ok(await page.locator('[data-program="shipreturn"] [data-action="program"]').isEnabled(), 'the Autopilot panel offers "Return to the tower"');
await shot('belly-3-autopilot-panel');
await page.click('[data-program="shipreturn"] [data-action="program"]');
s = await state();
ok(s.assistKind === 'shipreturn', 'the return program is flying: ' + s.assistKind);
await E(() => window.__sw.app.flight.hud.closePanels());
ok(await ff(3000, 'v.altitude < 71000'), 'braking burn done and the ship meets the air');
s = await state();
ok(s.speed > 1900 && s.speed < 2300, `at ${s.speed.toFixed(0)} m/s`);
ok(await ff(600, 'v.altitude < 45000'), 'down to 45 km');
s = await state();
ok(s.sas === 'belly' && s.bellyLead > 0.7, `belly to the wind, ${s.aoa.toFixed(0)} degrees to the air`);
ok(s.flaps.length === 4 && s.flaps.some(f => f > 0.05), 'the flaps are working: ' + s.flaps.join(' '));
ok(s.drawnFold > 0.05, 'and they are drawn folded: ' + s.drawnFold.toFixed(2));
await shot('belly-4-entry-45km');
ok(await ff(600, 'v.altitude < 29000'), 'down to 29 km');
await ff(1);
s = await state();
ok(s.done.includes('air'), 'objective: below 30 km belly first');
await shot('belly-5-30km');
ok(await ff(600, 'v.altitude < 9000'), 'down to 9 km');
s = await state();
ok(s.aoa > 75, `lying flat for the last leg: ${s.aoa.toFixed(0)} degrees`);
await shot('belly-6-flat-9km');
ok(await ff(300, 'v.altitude < 2200'), 'the flip');
await shot('belly-7-flip');
ok(await ff(120, 'v.altitude < 400'), 'the landing burn');
await shot('belly-8-burn');
ok(await ff(200, 'v.landed || v.dead'), 'down');
await ff(6);
s = await state();
ok(!s.dead && s.landed && s.held === 'tower', 'caught by the tower arms');
ok(s.temp < 0.9, `nothing overheated (hottest part at ${(s.temp * 100).toFixed(0)} % of its limit)`);
ok(s.done.includes('catch'), 'objective: caught. Scenario complete');
ok(s.toasts.some(t => /Return to the tower engaged/.test(t)), 'the player was told the program engaged');
await shot('belly-9-caught');

await browser.close();
await server.close();
console.log(`\n${checks} checks, ${problems.length} problems`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
