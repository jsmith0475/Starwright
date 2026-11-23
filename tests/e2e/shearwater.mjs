// End-to-end check of the Shearwater stack in the real game (docs/SHEARWATER.md): the stock rocket stands on the pad
// with a methane gauge and an oxygen gauge, the = key steps the lit cluster through its engine sets, the ascent
// assist flies it to orbit, staging is a hot staging that leaves two pieces, and the ship arrives part full.
//   node tests/e2e/shearwater.mjs     (screenshots land in tests/out/shearwater-*.png)
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
const state = () => page.evaluate(() => {
  const sw = window.__sw, w = sw.world, v = w.getVessel(window.__shw.shipId), B = window.__shw;
  const sum = k => v.partList.reduce((m, p) => m + (p.res[k] || 0), 0), cap = k => v.partList.reduce((m, p) => m + (p.def.res && p.def.res[k] || 0), 0);
  const mode = t => { const p = v.partList.find(x => x.type === t); return p ? p.mode || 0 : null; };
  const row = k => { const r = document.querySelector('.fl-res-row[data-res="' + k + '"]'); return r && !r.classList.contains('sw-hidden') ? r.textContent : null; };
  return { mass: v.mass, thrust: v.thrust, alt: v.altitude, apo: v.apoapsis, peri: v.periapsis, lox: sum('lox'), ch4: sum('ch4'), loxCap: cap('lox'), ch4Cap: cap('ch4'), dv: v.deltaV,
    mode33: mode('eng_peregrine33'), mode6: mode('eng_peregrine6'), rowLox: row('lox'), rowCh4: row('ch4'), rowFuel: row('fuel'), vessels: w.vessels.filter(x => !x.dead).map(x => ({ name: x.name, type: x.type, parts: x.partList.map(p => p.type) })),
    assist: sw.app.flight.assist ? sw.app.flight.assist.phase : null, assistKind: sw.app.flight.assistKind, toasts: B.toasts.slice(), events: B.events.slice(), hot: B.hot, sep: B.sep, situation: v.situation };
});

console.log('\n=== Shearwater: pad, engine sets, hot staging, orbit (1440×900) ===');
await page.goto(server.url);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
await page.click('[data-action="new"]');
await page.click('.sw-mode[data-mode="sandbox"]');
await page.click('.sw-modal .sw-btn.primary');
await waitScreen('hub');
await page.evaluate(async () => {
  const { stockCrafts } = await import('/js/core/craft.js');
  const c = stockCrafts().find(x => x.name === 'Shearwater');
  window.__sw.app.goto('flight', { craft: c.toJSON(), crew: ['Ada', 'Bo'] });
});
await waitScreen('flight');
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const sw = window.__sw, w = sw.world;
  const B = window.__shw = { shipId: w.active.id, toasts: [], events: [], hot: null, sep: null };
  w.on('*', (d, type) => { if (['hotstage', 'decouple', 'engineMode', 'destroyed', 'structure'].includes(type)) B.events.push(type); });
  w.on('hotstage', d => { B.hot = { ut: w.ut, alt: d.vessel.altitude, speed: d.vessel.airspeed, n: w.vessels.length }; });
  w.on('decouple', d => { if (!B.sep) B.sep = { ut: w.ut, debris: d.debris ? d.debris.type : null, ring: d.debris ? d.debris.partList.some(p => p.type === 'ring_hotstage') : null }; });
  const toast = sw.app.toast.bind(sw.app);
  sw.app.toast = (text, ...rest) => { B.toasts.push(String(text)); return toast(text, ...rest); };
});
await ff(0.5);
let s = await state();
ok(Math.abs(s.mass / 1000 - 769) < 3, `on the pad at ${(s.mass / 1000).toFixed(0)} t`);
ok(s.rowLox && /Oxygen/.test(s.rowLox) && s.rowCh4 && /Methane/.test(s.rowCh4), 'the resource panel has an oxygen gauge and a methane gauge: ' + s.rowLox + ' | ' + s.rowCh4);
ok(!s.rowFuel, 'and no single "Propellant" gauge, because it carries none');
ok(Math.abs(s.lox / s.ch4 - 3.6) < 0.01, 'loaded 3.6 to 1');
await shot('shearwater-1-pad');

// the engine-set key, on the pad with the 33 lit and the throttle shut
await key('Space');
s = await state();
ok(s.mode33 === 0, 'the booster starts on all 33');
await key('Equal'); s = await state();
ok(s.mode33 === 1 && s.toasts.some(t => /Inner 13/.test(t)), '= moves it to the inner 13 and says so');
await key('Equal'); s = await state();
ok(s.mode33 === 2 && s.toasts.some(t => /Centre 3/.test(t)), 'again: the centre 3');
ok(s.mode6 === 0, 'the ship\'s cluster, not lit, is left alone');
await page.evaluate(() => { window.__sw.world.active.ctrl.throttle = 1; });
await ff(0.3); s = await state();
ok(Math.abs(s.thrust / 1000 - 3 * 340 * 330 / 350) < 25, `three engines at sea level give ${(s.thrust / 1000).toFixed(0)} kN, and it stays on the pad`);
ok(s.alt < 5 || s.situation === 'prelaunch' || s.situation === 'landed', 'still on the pad');
await shot('shearwater-2-centre-three');
await page.evaluate(() => { window.__sw.world.active.ctrl.throttle = 0; });
await key('Equal'); s = await state();
ok(s.mode33 === 0, 'a third press is all 33 again');

// to orbit on the assist
await page.evaluate(() => window.__sw.app.flight.actions.toggleAssist());
s = await state();
ok(s.assistKind === 'ascent', 'the ascent assist is flying');
await ff(25); await shot('shearwater-3-climb');
ok(await ff(200, 'B.hot'), 'the assist stages');
s = await state();
ok(s.hot.n === 1 && s.vessels.length === 1, 'hot staging: the ship is lit and the stack is still one vessel');
ok(s.toasts.some(t => /Hot staging/.test(t)), 'the player is told');
ok(s.toasts.some(t => /no tower to catch it yet/.test(t)) && !s.toasts.some(t => /to fly back/.test(t)), 'the assist does not promise a return that cannot happen yet');
await shot('shearwater-4-hot-staging');
ok(await ff(3, 'B.sep'), 'the ring lets go');
s = await state();
ok(Math.abs(s.sep.ut - s.hot.ut - 0.8) < 0.06, `${(s.sep.ut - s.hot.ut).toFixed(2)} s after the ship lit`);
ok(s.sep.ring === true && s.sep.debris === 'ship', 'the ring stays on the booster, which is still a vessel');
ok(s.vessels.length === 2, 'two pieces, not three');
console.log(`    staged at ${(s.hot.alt / 1000).toFixed(1)} km, ${s.hot.speed.toFixed(0)} m/s`);
await ff(3); await shot('shearwater-5-apart');
ok(await ff(1500, '!window.__sw.app.flight.assist || v.situation === "orbit" && v.periapsis > 70000'), 'the assist finishes');
await ff(5);
s = await state();
ok(s.peri > 70000 && s.apo < 100000, `in orbit: ${(s.apo / 1000).toFixed(1)} by ${(s.peri / 1000).toFixed(1)} km`);
const full = (s.lox + s.ch4) / (s.loxCap + s.ch4Cap);
ok(full > 0.3 && full < 0.6, `the ship arrives ${(full * 100).toFixed(0)} % full, ${s.dv.toFixed(0)} m/s left`);
ok(Math.abs(s.lox / s.ch4 - 3.6) < 0.02, 'still 3.6 to 1');
ok(!s.events.includes('structure') && !s.events.includes('destroyed') || s.vessels.some(v => v.parts.includes('pod_shearwater')), 'nothing broke on the ship');
await key('Equal'); s = await state();
ok(s.mode6 === 1 && s.toasts.some(t => /Sea-level 3/.test(t)), 'in orbit = steps the ship\'s six: sea-level 3');
await key('Equal'); s = await state();
ok(s.mode6 === 2 && s.toasts.some(t => /Vacuum 3/.test(t)), 'then the vacuum 3');
await shot('shearwater-6-orbit');

await browser.close();
await server.close();
console.log(`\n${checks} checks, ${problems.length} problems`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
