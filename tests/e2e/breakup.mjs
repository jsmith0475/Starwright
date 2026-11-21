// End-to-end check of aerodynamic breakup in the real game: launch the stock Colossus from the menus, hold a
// hard pitch-over from 20 kPa, and watch the side boosters, the antenna and the nose cones come off.
//   node tests/e2e/breakup.mjs            (screenshots land in tests/out/breakup-*.png)
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

/** Run the flight screen's own update(dt) (input → world.step → HUD) until `until` holds or `sim` seconds pass. */
async function ff(sim, until = 'false', hold = null) {
  let left = sim, hit = false;
  while (left > 0 && !hit) {
    const r = await page.evaluate(({ budget, until, hold }) => {
      const sw = window.__sw, app = sw.app, test = new Function('w', 'v', 'return (' + until + ');');
      const t0 = performance.now(), ut0 = sw.world.ut; let hit = false;
      while (performance.now() - t0 < 400 && app.currentName === 'flight' && sw.world.ut - ut0 < budget) {
        const v = sw.world.active;
        if (hold && v && !v.dead) { v.ctrl.sas = false; v.ctrl.pitch = hold; }
        app.current.update(0.02); app.input.endFrame();
        if (test(sw.world, sw.world.active)) { hit = true; break; }
      }
      return { advanced: sw.world.ut - ut0, hit };
    }, { budget: left, until, hold });
    hit = r.hit; left -= Math.max(r.advanced, 0.01);
  }
  return hit;
}

console.log('\n=== Colossus: a clean climb to 20 kPa, then a hard pitch-over (1440×900) ===');
await page.goto(server.url);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
await page.click('[data-action="new"]');
await page.click('.sw-mode[data-mode="sandbox"]');
await page.click('.sw-modal .sw-btn.primary');
await waitScreen('hub');
await page.click('.sw-card[data-goto="launch"]');
await page.waitForSelector('.sw-launch');
await page.click('.sw-item[data-craft="Colossus"]');
await page.click('[data-action="launch"]');
await waitScreen('flight');
await page.waitForTimeout(1200);

await page.evaluate(() => {
  const w = window.__sw.world;
  window.__brk = { events: [], toasts: [] };
  w.on('structure', d => window.__brk.events.push({ ut: w.ut, ship: d.vessel === w.active, mode: d.mode, name: d.air ? d.air.name : d.joint.bName, q: d.air ? d.air.q : 0, rated: d.air ? d.air.rated : 0 }));
  const v = w.active; v.ctrl.throttle = 1; v.ctrl.sas = true; w.stage();
});
const parts0 = await page.evaluate(() => window.__sw.world.active.parts.size);
ok(await ff(90, 'v && v.dynamicPressure > 20000'), 'the climb reaches 20 kPa');
let s = await page.evaluate(() => ({ n: window.__brk.events.length, air: window.__sw.world.active.airUtil, parts: window.__sw.world.active.parts.size, q: window.__sw.world.active.dynamicPressure }));
ok(s.n === 0 && s.parts === parts0, `nothing has come off on the way up (${s.parts} parts, air reading ${(s.air * 100).toFixed(0)} %)`);
await shot('breakup-01-clean-climb');

// pitch hard over and hold; stop a moment after the first part is torn off, for the picture
await ff(25, 'window.__brk.events.length > 0', 1);
await ff(0.6, 'false', 1);
await shot('breakup-02-first-pieces');
const toast = await page.evaluate(() => [...document.querySelectorAll('.fl-toast, .sw-toast, .fl-msg')].map(e => e.textContent).join(' | '));
await ff(12, 'false', 1);
await shot('breakup-03-after');
s = await page.evaluate(() => {
  const w = window.__sw.world, v = w.active;
  return { events: window.__brk.events, parts: v.parts.size, clamps: [...v.parts.values()].filter(p => p.def.shape === 'radialdec').length, debris: w.vessels.filter(x => x.type === 'debris' && !x.dead).length, text: document.body.innerText };
});
const air = s.events.filter(e => e.mode === 'airflow');
for (const e of s.events) console.log(`    ${e.ship ? 'ship  ' : 'debris'} ${e.mode.padEnd(11)} ${e.name}${e.q ? `  ${(e.q / 1000).toFixed(1)} kPa, rated ${(e.rated / 1000).toFixed(0)}` : ''}`);
ok(air.filter(e => e.ship).length >= 2, `the airflow tore ${air.filter(e => e.ship).length} parts off the ship`);
ok(s.clamps === 0, 'no side booster is left on the ship');
ok(s.debris >= 2, `${s.debris} pieces are flying on as debris`);
ok(s.parts < parts0, `the ship is down from ${parts0} to ${s.parts} parts`);
ok(/torn off by the airflow/.test(toast + s.text), 'the screen says what was torn off and why');

await browser.close();
await server.close();
console.log(`\n${checks} checks, ${problems.length} problems`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
