// End-to-end interplanetary flight through the flight screen: the stock Farwind leaves Verda for Rusk in the first
// transfer window, captures, crosses to the moon Dray, lands, a Pip walks and plants a flag, and the ship flies back
// to Verda's sphere of influence. Every burn is planned and flown with the Autopilot panel's programs (the same
// actions.runProgram the panel buttons call); the long coasts use the game's own time warp.
//   node tests/e2e/interplanetary.mjs          (ONLY=out stops after the landing; screenshots: tests/out/interplanetary-*.png)
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
page.setDefaultTimeout(240000);
page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text() + ' @ ' + (m.location()?.url || '')); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
page.on('requestfailed', r => { if (!/^data:/.test(r.url())) problems.push('request failed: ' + r.url()); });

const E = (fn, arg) => page.evaluate(fn, arg);
const shot = async name => { await page.waitForTimeout(900); await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 180000 }); };
async function waitScreen(name) {
  await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 600000 });
  await page.waitForTimeout(400);
}
/** Advance the game with the flight screen's own update(dt) until the expression over (w, v, f) holds. `warp` keeps the highest allowed time warp on. */
async function ff(sim, until = 'false', { dt = 0.05, warp = false } = {}) {
  let left = sim, hit = false;
  while (left > 0 && !hit) {
    const r = await E(({ budget, until, dt, warp }) => {
      const sw = window.__sw, app = sw.app, f = app.flight;
      const test = new Function('w', 'v', 'f', 'return (' + until + ');');
      const t0 = performance.now(), u0 = sw.world.ut; let hit = false, n = 0;
      while (performance.now() - t0 < 500 && app.currentName === 'flight' && sw.world.ut - u0 < budget && n++ < 20000) {
        const w = sw.world;
        if (warp && w.warpIndex < w.maxWarpIndex()) w.setWarp(99);
        app.current.update(dt); app.input.endFrame();
        const v = w.active && !w.active.dead ? w.active : null;
        if (test(w, v, f)) { hit = true; break; }
        if (f.paused) break;
      }
      if (warp && hit) sw.world.setWarp(0);
      return { adv: sw.world.ut - u0, hit, n, gone: app.currentName !== 'flight' };
    }, { budget: left, until, dt, warp });
    hit = r.hit;
    if (r.gone) break;
    left -= Math.max(r.adv, r.n ? dt * 0.5 : left);
  }
  return hit;
}
const st = () => E(() => {
  const w = window.__sw.world, f = window.__sw.app.flight, v = w.active;
  return { day: w.ut / 86400, body: v.body.id, sit: v.situation, ap: v.apoapsis, pe: v.periapsis, dv: v.deltaV, alt: v.altitude, landed: v.landed, dead: v.dead, parts: v.parts.size, nodes: v.nodes.length,
    type: v.type, crew: v.crew.length, sceneBody: f.view.anchor && f.view.anchor.body ? f.view.anchor.body.id : null, assist: f.assist ? (f.assist.phase || 'on') : null,
    hudBody: (document.querySelector('.fl-vessel-sit') || {}).textContent || '' };
});
const km = x => (x / 1000).toFixed(0) + ' km';
const note = async what => { const s = await st(); console.log(`    [day ${s.day.toFixed(1)} ${s.body} ${s.sit} dv ${Math.round(s.dv)}] ${what}`); return s; };
const program = id => E(id => window.__sw.app.flight.actions.runProgram(id), id);
const target = id => E(async id => { const { SYSTEM } = await import('/js/core/bodies.js'); return window.__sw.app.flight.actions.setTarget(SYSTEM.byId[id]) !== false; }, id);
/** Plan with a panel program, then fly the node with "Fly the next maneuver" (warps there, aims, burns). → true when the burn completed. */
async function planAndFly(id, sim = 4e6) {
  const planned = await program(id);
  const s = await st();
  if (!planned || !s.nodes) return planned && !s.nodes ? 'none' : false;
  if (!await program('node')) return false;
  await ff(sim, '!f.assist', { dt: 0.05 });
  await ff(2, 'false');
  return (await st()).nodes === 0;
}
const coast = (until, sim = 1e8) => ff(sim, until, { warp: true });

async function run() {
  console.log('\n=== Farwind: Verda → Rusk → Dray landing, flag → back to Verda (1440×900) ===');
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
  await page.click('[data-action="new"]');
  await page.click('.sw-mode[data-mode="sandbox"]');
  await page.click('.sw-modal .sw-btn.primary');
  await waitScreen('hub');
  // start three days before the first Rusk window so the wait in parking orbit is short
  const win = await E(async () => {
    const AP = await import('/js/core/autopilot.js'); const { SYSTEM } = await import('/js/core/bodies.js');
    const first = AP.transferWindow(SYSTEM.home, SYSTEM.byId.rusk, 0);
    window.__sw.career.ut = first.t - 3 * 86400;
    return { t: first.t, tof: first.tof };
  });
  await page.click('.sw-card[data-goto="launch"]');
  await page.waitForSelector('.sw-launch');
  await page.click('.sw-item[data-craft="Farwind"]');
  await page.click('[data-action="launch"]');
  await waitScreen('flight');
  await page.waitForTimeout(1200);
  let s = await st();
  ok(s.body === 'verda' && s.sit === 'prelaunch' && s.crew >= 1, `Farwind stands on the pad with ${s.crew} aboard, ${((win.t / 86400) - s.day).toFixed(1)} days before the Rusk window`);

  // ---- to orbit with the ascent assist, then the transfer from the Autopilot panel
  await page.click('[data-tool="assist"]');
  await ff(2500, '!f.assist');
  s = await note('ascent finished');
  ok(s.body === 'verda' && s.pe > 72000 && !s.dead, `ascent assist reaches a parking orbit (${km(s.ap)} × ${km(s.pe)})`);
  ok(await target('rusk'), 'Rusk is set as the target');
  await page.click('[data-tool="guide"]');
  await page.waitForSelector('[data-program="transfer"]');
  ok(/Rusk/.test(await page.locator('[data-program="transfer"]').innerText()), 'the Autopilot panel offers "Plan: transfer to Rusk"');
  await page.click('[data-program="transfer"] [data-action="program"]');
  s = await st();
  ok(s.nodes === 1, 'planning puts the ejection burn on the flight plan');
  await page.waitForSelector('[data-program="node"]');
  await page.click('[data-program="node"] [data-action="program"]');
  ok(await E(() => !!window.__sw.app.flight.assist), '"Fly the next maneuver" takes the ship');
  await page.click('[data-tool="guide"]');
  await ff(4e6, '!f.assist');
  s = await note('ejection burn done');
  ok(s.nodes === 0 && !s.dead, 'the ejection burn is flown to completion');
  await coast("v.body.id !== 'verda'", 4e6);
  await ff(1, 'false');
  s = await note('left Verda');
  ok(s.body === 'helion', 'the ship leaves Verda\'s sphere of influence into solar orbit');
  ok(s.sceneBody === 'helion' && /Helion/i.test(s.hudBody), `the scene and the HUD follow the change of world (scene ${s.sceneBody}, HUD "${s.hudBody.trim()}")`);
  const tEj = s.day * 86400;
  await coast(`w.ut > ${tEj + win.tof * 0.4}`, 1e8);
  const mcc = await planAndFly('correct', 4e6);
  s = await note('mid-course correction: ' + mcc);
  ok(mcc === true || mcc === 'none', 'a mid-course correction is planned and flown from the panel');
  await coast("v.body.id === 'rusk'", 1e8);
  await ff(1, 'false');
  s = await note('Rusk SOI, periapsis ' + km((await st()).pe));
  ok(s.body === 'rusk', 'the ship arrives in Rusk\'s sphere of influence');
  ok(s.sceneBody === 'rusk' && /Rusk/.test(s.hudBody), 'the scene anchors on Rusk');
  ok(s.pe > 45000, `the arrival periapsis is clear of the air (${km(s.pe)})`);
  await shot('interplanetary-01-rusk-arrival');

  // ---- capture, then across to the moon
  ok(await target('dray'), 'Dray is set as the target');
  ok(await E(() => window.__sw.app.flight.actions.programs().some(p => p.id === 'capmoon' && p.ok)), 'with a moon targeted the panel offers a capture that reaches out to it');
  ok(await planAndFly('capmoon') === true, 'capture burn at the periapsis');
  s = await note('Rusk orbit ' + km((await st()).ap) + ' × ' + km((await st()).pe));
  ok(s.pe > 45000 && Number.isFinite(s.ap) && s.ap > 1e6, 'the ship is in a long closed orbit of Rusk');
  await shot('interplanetary-02-rusk-orbit');
  const pl = await planAndFly('plane');
  await note('plane match with Dray: ' + pl);
  ok(await planAndFly('circlow') === true, 'circularise low over Rusk');
  const tr = await planAndFly('transfer');
  ok(tr === true, 'transfer burn to Dray');
  const c2 = await planAndFly('correct');
  await note('Dray correction: ' + c2);
  await coast("v.body.id === 'dray'", 3e6);
  await ff(1, 'false');
  s = await note('Dray SOI, periapsis ' + km((await st()).pe));
  ok(s.body === 'dray' && s.sceneBody === 'dray', 'the ship enters Dray\'s sphere of influence and the scene follows');
  ok(await planAndFly('circ') === true, 'capture burn at Dray');
  s = await note('Dray orbit ' + km((await st()).ap) + ' × ' + km((await st()).pe));

  // ---- landing, a walk and a flag
  ok(await program('landhere'), '"Land here" engages');
  await ff(2e5, '!f.assist || !v || v.landed');
  await ff(30, 'false');
  s = await note('landing finished');
  ok(s.landed && !s.dead && s.body === 'dray', `the ship stands on Dray in one piece (${s.parts} parts)`);
  await shot('interplanetary-03-dray-landed');
  await page.click('[data-tool="crew"]');
  await page.waitForSelector('.fl-pop[data-panel="crew"]');
  await page.click('.fl-pop [data-action="eva"]');
  // the Pip comes out on the ladder: climb down (S), then stand clear of it
  for (let i = 0; i < 12; i++) {
    if (await E(() => { const v = window.__sw.world.active; return v.type === 'eva' && v.landed && !v.ladder; })) break;
    await page.keyboard.down('KeyS'); await ff(4, "v && v.type === 'eva' && v.landed && !v.ladder"); await page.keyboard.up('KeyS');
  }
  s = await st();
  const eva = await E(() => { const v = window.__sw.world.active; return { landed: v.landed, ladder: !!v.ladder, alt: v.radarAlt }; });
  ok(s.type === 'eva' && eva.landed && !eva.ladder, `a Pip climbs down and stands on Dray (${JSON.stringify(eva)})`);
  const flag = await E(async () => { const f = await window.__sw.app.flight.actions.plantFlag('Dray Landing'); return !!f; });
  ok(flag && await E(() => window.__sw.world.flags.some(f => f.bodyId === 'dray' && f.name === 'Dray Landing')), 'the Pip plants a flag');
  await ff(2, 'false');
  await shot('interplanetary-04-dray-flag');
  let aboard = await E(() => window.__sw.app.flight.actions.board());
  if (!aboard) {            // walk back to the ship first
    await E(() => { const w = window.__sw.world, e = w.active; const ship = w.vessels.find(o => o.type === 'ship' && !o.dead); if (ship) window.__sw.app.flight.actions.setTarget(ship); });
    for (let i = 0; i < 6 && !aboard; i++) { await page.keyboard.down('KeyW'); await ff(4, 'false'); await page.keyboard.up('KeyW'); aboard = await E(() => window.__sw.app.flight.actions.board()); }
  }
  await ff(1, 'false');
  s = await st();
  ok(aboard && s.type === 'ship', 'the Pip boards the ship again');
  if (s.type !== 'ship') await E(() => { const w = window.__sw.world, e = w.active; const ship = w.vessels.find(o => o.type === 'ship' && !o.dead); w.evaBoard(e, ship) || w.switchTo(ship); });
  if (process.env.ONLY === 'out') return;

  // ---- the way back
  ok(await program('ascent'), 'ascent assist engages on Dray');
  await ff(8000, '!f.assist');
  s = await note('Dray ascent finished ' + km((await st()).ap) + ' × ' + km((await st()).pe));
  ok(s.body === 'dray' && s.pe > 4500 && !s.dead, `the ship is back in orbit of Dray (${km(s.ap)} × ${km(s.pe)})`);
  ok(await planAndFly('return') === true, '"Plan: return to Rusk" is planned and flown');
  await coast("v.body.id === 'rusk'", 3e6);
  await ff(1, 'false');
  s = await note('back at Rusk ' + km((await st()).ap) + ' × ' + km((await st()).pe));
  ok(s.body === 'rusk' && s.pe > 45000, `the ship falls back to a low pass over Rusk (periapsis ${km(s.pe)})`);
  ok(await planAndFly('circlow') === true, 'circularise low over Rusk');
  ok(await target('verda'), 'Verda is set as the target');
  ok(await program('transfer'), 'the transfer home is planned');
  const wait = await E(() => { const w = window.__sw.world, v = w.active; return v.nodes.length ? (v.nodes[0].t - w.ut) / 86400 : null; });
  console.log('    home window in ' + (wait === null ? '?' : wait.toFixed(0)) + ' days');
  ok(await program('node'), '"Fly the next maneuver" waits for the window');
  await ff(6e7, '!f.assist');
  s = await note('ejection from Rusk done');
  ok(s.nodes === 0 && !s.dead, 'the ejection burn for home is flown');
  await coast("v.body.id !== 'rusk'", 1e8);
  const t2 = (await st()).day * 86400;
  await coast(`w.ut > ${t2 + 25 * 86400}`, 1e8);
  const mcc2 = await planAndFly('correct', 4e7);
  await note('correction home: ' + mcc2);
  ok(mcc2 === true || mcc2 === 'none', 'the course home is corrected on the way');
  await coast("v.body.id === 'verda'", 1.5e7);
  await ff(1, 'false');
  s = await note('Verda SOI, periapsis ' + km((await st()).pe));
  ok(s.body === 'verda' && s.sceneBody === 'verda', 'the ship is back in Verda\'s sphere of influence');
  ok(s.crew >= 1 && !s.dead, `the crew is alive (${s.crew} aboard, ${Math.round(s.dv)} m/s left)`);
  await shot('interplanetary-05-verda-return');
}

try { await run(); } catch (err) { problems.push('test aborted: ' + (err.stack || err.message)); }
await browser.close();
await server.close();
console.log(`\n${checks} checks, ${problems.length} problem(s)`);
for (const p of problems) console.log('  - ' + p);
process.exit(problems.length ? 1 : 0);
