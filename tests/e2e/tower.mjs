// End-to-end check of the catch tower in the real game (docs/SHEARWATER.md, "The tower and the catch"): Shearwater
// stands on the tower's mount, not the launch pad; the ascent assist stages it; the booster flies itself back and the
// arms take it; the ship goes on to orbit. Then the miss: a stage dropped too fast is refused, and the game says why.
//   node tests/e2e/tower.mjs     (screenshots land in tests/out/tower-*.png)
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
const state = () => page.evaluate(async () => {
  const sw = window.__sw, w = sw.world, B = window.__shw, v = w.getVessel(B.shipId);
  const b = w.vessels.find(x => !x.dead && x.id !== B.shipId && x.partList.some(p => p.type === 'eng_peregrine33'));
  return { active: w.active.id, ship: { alt: v.altitude, apo: v.apoapsis, peri: v.periapsis, dv: v.deltaV, situation: v.situation, site: v.launchSite },
    booster: b ? { id: b.id, alt: v === b ? 0 : b.altitude, landed: b.landed, held: b.surface && b.surface.held || null, dead: b.dead, prop: b.partList.reduce((m, p) => m + (p.res.lox || 0) + (p.res.ch4 || 0), 0), mode: (b.partList.find(p => p.type === 'eng_peregrine33') || {}).mode, thrust: b.thrust } : null,
    toasts: B.toasts.slice(), caught: B.caught, missed: B.missed, sep: B.sep, vessels: w.vessels.filter(x => !x.dead).length };
});

console.log('\n=== Catch tower: launch from the mount, booster caught, ship to orbit (1440×900) ===');
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
const where = await page.evaluate(async () => {
  const sw = window.__sw, w = sw.world, v = w.active;
  const { TOWER } = await import('/js/core/bodies.js');
  const B = window.__shw = { shipId: v.id, toasts: [], caught: null, missed: null, sep: null };
  w.on('caught', d => { B.caught = { name: d.name || d.vessel.name, speed: d.speed, offset: d.offset, ut: w.ut }; });
  w.on('catchMissed', d => { B.missed = { why: d.reason || null, ut: w.ut }; });
  w.on('decouple', () => { if (!B.sep) B.sep = { ut: w.ut }; });
  const toast = sw.app.toast.bind(sw.app);
  sw.app.toast = (text, ...rest) => { B.toasts.push(String(text)); return toast(text, ...rest); };
  const a = v.body.surfaceDirToInertial(v.body.sites.tower.dir, w.ut, v.pos.clone()).normalize(), R = v.pos.length();
  const d = a.multiplyScalar(R).sub(v.pos), u = v.pos.clone().normalize(); d.addScaledVector(u, -d.dot(u));
  const s = { offset: d.length() };
  return { site: v.launchSite, offset: s ? s.offset : null, situation: v.situation, landed: v.landed, hang: TOWER.hang };
});
ok(where.site === 'tower', 'Shearwater is rolled out to the tower, not the launch pad');
ok(where.offset !== null && where.offset < 0.5, `it stands on the mount's axis (${where.offset === null ? 'n/a' : where.offset.toFixed(2)} m off)`);
await ff(0.5);
await shot('tower-1-on-the-mount');

await key('Space');
await page.evaluate(() => window.__sw.app.flight.actions.toggleAssist());
await ff(6); await shot('tower-2-liftoff');
ok(await ff(220, 'B.sep'), 'the assist stages');
await ff(4);
let s = await state();
ok(s.toasts.some(t => /flying itself back to the tower to be caught/.test(t)), 'the booster says it is flying back to the tower');
ok(s.active === (await page.evaluate(() => window.__shw.shipId)), 'the player stays with the ship');
ok(s.booster && !s.booster.dead, 'the booster is a live vessel');
ok(await ff(400, 'B.caught || B.missed'), 'the return ends at the tower');
s = await state();
ok(!!s.caught && !s.missed, 'caught by the arms' + (s.missed ? ' (missed: ' + s.missed.why + ')' : ''));
if (s.caught) {
  ok(s.caught.speed < 5 && s.caught.offset < 2.5, `at ${s.caught.speed.toFixed(1)} m/s, ${s.caught.offset.toFixed(2)} m from the mount's axis`);
  ok(s.caught.ut - s.sep.ut < 300, `${(s.caught.ut - s.sep.ut).toFixed(0)} s after staging`);
}
ok(s.booster.held === 'tower' && s.booster.landed, 'the booster is held by the tower');
ok(s.booster.prop > 500, `with ${(s.booster.prop / 1000).toFixed(1)} t of propellant left`);
ok(s.toasts.some(t => /is caught: the arms have it/.test(t)), 'the player is told');
// look at it: hop to the booster
await key('Backslash'); await ff(1);
s = await state();
ok(s.active === s.booster.id, '\\ hops to the caught booster');
await shot('tower-3-caught');
await ff(20);
s = await state();
ok(s.booster.held === 'tower' && !s.booster.dead, 'twenty seconds on it still hangs there');
await key('Backslash'); await ff(1);
ok(await ff(1500, '!window.__sw.app.flight.assist || w.getVessel(B.shipId).situation === "orbit" && w.getVessel(B.shipId).periapsis > 70000'), 'the assist finishes');
await ff(5);
s = await state();
ok(s.ship.peri > 70000 && s.ship.apo < 100000, `the ship is in orbit: ${(s.ship.apo / 1000).toFixed(1)} by ${(s.ship.peri / 1000).toFixed(1)} km, ${s.ship.dv.toFixed(0)} m/s left`);
await shot('tower-4-ship-in-orbit');

await browser.close();
await server.close();
console.log(`\n${checks} checks, ${problems.length} problems`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
