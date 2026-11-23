// End-to-end check of reusable boosters, phase 2, in the real game: a rocket whose first stage has a guidance ring,
// grid fins and legs is launched with the ascent assist. The assist lets the booster go early with propellant to
// return; the booster turns round, flies back and lands by the pad on its own while the assist takes the upper
// stage to orbit; the hop key (\) watches either one.
//   node tests/e2e/booster_return.mjs     (screenshots land in tests/out/return-*.png)
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

/** Run the flight screen's own update(dt) (input → programs → world.step → HUD) until `until` holds or `sim` seconds pass. */
async function ff(sim, until = 'false') {
  let left = sim, hit = false;
  while (left > 0 && !hit) {
    const r = await page.evaluate(({ budget, until }) => {
      const sw = window.__sw, app = sw.app, test = new Function('w', 'v', 'B', 'return (' + until + ');');
      const t0 = performance.now(), ut0 = sw.world.ut; let hit = false;
      while (performance.now() - t0 < 400 && app.currentName === 'flight' && sw.world.ut - ut0 < budget) {
        app.current.update(0.02); app.input.endFrame();
        if (test(sw.world, sw.world.active, window.__bst)) { hit = true; break; }
      }
      return { advanced: sw.world.ut - ut0, hit };
    }, { budget: left, until });
    hit = r.hit; left -= Math.max(r.advanced, 0.01);
  }
  return hit;
}
/** A real key press that the flight screen sees on its next update. */
const key = async code => { await page.keyboard.down(code); await page.waitForTimeout(60); await page.evaluate(() => { const a = window.__sw.app; a.current.update(0.02); a.input.endFrame(); }); await page.keyboard.up(code); await page.waitForTimeout(40); };
const info = () => page.evaluate(() => {
  const sw = window.__sw, w = sw.world, B = window.__bst, f = sw.app.flight;
  const u = w.getVessel(B.upperId), b = B.booster;
  return { active: w.active ? w.active.name : null, activeId: w.active ? w.active.id : null, upperId: B.upperId, boosterId: b ? b.id : null,
    boosterName: b ? b.name : '', boosterType: b ? b.type : '', boosterDead: b ? !!b.dead : null, boosterRails: b ? !!b.onRails : null, boosterAlt: b ? b.altitude : 0,
    sep: u && b ? u.pos.distanceTo(b.pos) : 0, upperAlt: u ? u.altitude : 0, upperApo: u ? u.apoapsis : 0, upperPeri: u ? u.periapsis : 0, upperProgram: u ? u.program : null,
    upperThrottle: u ? u.ctrl.throttle : 0, assist: f.assist ? f.assist.phase : null, assistKind: f.assistKind, warp: w.warpIndex, tracked: w.tracked.map(x => x.name),
    toasts: B.toasts.slice(), destroyed: B.destroyed.slice(), removed: B.removed.slice() };
});


const state = () => page.evaluate(() => {
  const sw = window.__sw, w = sw.world, B = window.__bst, f = sw.app.flight, b = B.booster, u = w.getVessel(B.upperId);
  const site = sw.SYSTEM ? sw.SYSTEM.sites.landing : null;
  let miss = null, tilt = null;
  if (b && !b.dead) {
    const here = b.body.inertialToSurfaceDir(b.pos.clone(), w.ut), t = B.target;
    miss = Math.acos(Math.min(1, here.dot(t))) * b.body.radius;
    const up = b.pos.clone().normalize(), ax = B.axis(b);
    tilt = Math.acos(Math.min(1, Math.abs(up.dot(ax)))) * 180 / Math.PI;
  }
  return { active: w.active ? w.active.id : null, upperId: B.upperId, boosterId: b ? b.id : null, name: b ? b.name : '', dead: b ? !!b.dead : null, landed: b ? !!b.landed : null,
    alt: b ? b.altitude : 0, radar: b ? b.radarAlt : 0, speed: b ? b.airspeed : 0, vs: b ? b.verticalSpeed : 0, program: b ? b.program : null, miss, tilt,
    dv: b && !b.dead ? b.estimateDeltaV() : 0, sepAlt: B.sep ? B.sep.alt : 0, sepSpeed: B.sep ? B.sep.speed : 0, touch: B.touch,
    upperApo: u ? u.apoapsis : 0, upperPeri: u ? u.periapsis : 0, upperProgram: u ? u.program : null, assist: f.assist ? f.assist.phase : null, assistKind: f.assistKind,
    toasts: B.toasts.slice(), destroyed: B.destroyed.slice(), fps: B.frames };
});

console.log('\n=== A booster built to come back: launch, early separation, boostback, landing, orbit (1440×900) ===');
await page.goto(server.url);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
await page.click('[data-action="new"]');
await page.click('.sw-mode[data-mode="sandbox"]');
await page.click('.sw-modal .sw-btn.primary');
await waitScreen('hub');
await page.evaluate(async () => {
  const { Craft } = await import('/js/core/craft.js');
  const c = new Craft('Test Returner');
  const [pod] = c.setRoot('probe_wisp');
  let cur = pod, first = null, last = null;
  const lower = ['tank_m800', 'tank_m800', 'tank_m400'];
  for (const t of ['tank_m400', 'eng_sparrow', 'dec_m', 'probe_wisp', ...lower, 'eng_goshawk']) {
    const [p] = c.attachStack(t, cur.id, 'bottom');
    if (lower.includes(t)) { if (cur.type === 'probe_wisp') first = p; last = p; }
    cur = p;
  }
  c.attachRadial('fin_grid', first.id, first.pos.y + 0.6, Math.PI / 4, 4);
  c.attachRadial('leg_sprig', last.id, last.pos.y - 0.3, Math.PI / 4, 4);
  c.autoStage();
  window.__sw.app.goto('flight', { craft: c.toJSON(), crew: [] });
});
await waitScreen('flight');
await page.waitForTimeout(1200);
await page.evaluate(async () => {
  const sw = window.__sw, w = sw.world;
  const { SYSTEM } = await import('/js/core/bodies.js');
  const { Vector3 } = await import('/js/lib/three.module.min.js');
  const B = window.__bst = { upperId: w.active.id, booster: null, toasts: [], destroyed: [], sep: null, touch: null, target: SYSTEM.home.sites.landing.dir.clone(),
    axis: v => new Vector3(0, 1, 0).applyQuaternion(v.q) };
  w.on('decouple', d => { if (!B.booster && d.debris.type === 'ship') { B.booster = d.debris; d.debris.updateTelemetry(w.ut); B.sep = { alt: d.debris.altitude, speed: d.debris.airspeed }; } });
  w.on('destroyed', d => B.destroyed.push({ name: d.vessel.name, reason: d.reason, ut: w.ut }));
  w.on('landed', d => { if (B.booster && d.vessel === B.booster && !B.touch) B.touch = { speed: d.speed, ut: w.ut }; });
  const toast = sw.app.toast.bind(sw.app);
  sw.app.toast = (text, ...rest) => { B.toasts.push(String(text)); return toast(text, ...rest); };
  sw.app.flight.actions.toggleAssist();
});
ok((await state()).assistKind === 'ascent', 'the ascent assist is flying the rocket');
ok(await ff(200, 'B.booster'), 'the assist stages and the first stage separates');
let s = await state();
ok(s.sepAlt > 15000 && s.sepAlt < 45000 && s.sepSpeed < 1400, `it lets the booster go early: ${(s.sepAlt / 1000).toFixed(1)} km, ${s.sepSpeed.toFixed(0)} m/s`);
ok(s.toasts.some(t => /left in the booster to fly back/.test(t)), 'the assist says why it staged: ' + (s.toasts.find(t => /fly back/.test(t)) || ''));
ok(s.toasts.some(t => /is flying itself back to land/.test(t)), 'the player is told the booster is flying itself back, and which key reaches it');
ok(s.program === 'recovery' && s.active === s.upperId, 'the booster return runs in the background; the player is still on the upper stage');
await ff(4);
await shot('return-1-separation');

await key('Backslash');
s = await state();
ok(s.active === s.boosterId, 'the hop key (\\) goes to the booster');
ok(s.assistKind === 'recovery', 'and its return program comes with it (the Guidance panel shows it)');
ok(s.upperProgram === 'ascent', 'the ascent assist stays with the upper stage');
await ff(12);
await shot('return-2-boostback');
ok(await ff(400, 'B.booster.verticalSpeed < -50 && B.booster.altitude < 30000'), 'the booster comes back down');
await shot('return-3-falling');
ok(await ff(400, 'B.booster.dead || (B.booster.radarAlt < 900 && B.booster.ctrl.throttle > 0)'), 'the landing burn lights');
await ff(1.5);
await shot('return-4-landing-burn');
ok(await ff(300, 'B.booster.dead || B.booster.landed'), 'it reaches the ground');
await ff(6);
s = await state();
ok(!s.dead && s.landed, 'the booster is down in one piece');
ok(s.miss !== null && s.miss < 10, `it stands ${s.miss === null ? '?' : s.miss.toFixed(1)} m from the landing zone`);
ok(s.tilt !== null && s.tilt < 3, `upright (tilt ${s.tilt === null ? '?' : s.tilt.toFixed(1)}°)`);
ok(s.dv > 50, `with propellant to spare (${s.dv.toFixed(0)} m/s)`);
ok(s.toasts.some(t => /boostback|Boostback/.test(t)) && s.toasts.some(t => /landing burn|Landing burn/i.test(t)), 'the return was called out step by step');
await shot('return-5-landed');

await key('Backslash');
s = await state();
ok(s.active === s.upperId, 'the hop key goes back to the upper stage');
ok(await ff(900, '!window.__sw.app.flight.assist'), 'the ascent assist runs to its end');
s = await state();
ok(s.upperPeri > 72000, `the upper stage is in orbit: ${(s.upperApo / 1000).toFixed(1)} × ${(s.upperPeri / 1000).toFixed(1)} km`);
ok(!s.dead && s.landed, 'and the booster is still standing by the pad');
ok(!s.destroyed.length, 'nothing was destroyed');
console.log('   toasts: ' + s.toasts.join(' | '));
await shot('return-6-orbit');

await browser.close();
await server.close();
console.log(`\n${checks} checks, ${problems.length} problems`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
