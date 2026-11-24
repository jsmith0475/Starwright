// End-to-end test of the flight screen: launch the stock Skylark II from the real UI, fly it to orbit, use the
// map, stage, pause, quicksave/quickload, time warp, spacewalk, land and recover; then crash a Hopper.
//   node tests/e2e/flight.mjs            (screenshots land in tests/out/flight-*.png)
//
// Software GL in CI renders only a few frames per second, so long stretches of flight are advanced by calling
// the screen's own update(dt) in a loop (same code path as the game loop: input → world.step → HUD), with the
// input edges cleared after every call exactly as the main loop does.
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

async function newPage(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);            // software GL on a busy machine: a single frame can take seconds
  page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text() + ' @ ' + (m.location()?.url || '')); });
  page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
  page.on('requestfailed', r => { if (!/^data:/.test(r.url())) problems.push('request failed: ' + r.url()); });
  return { ctx, page };
}
const shot = async (page, name) => { await page.waitForTimeout(700); await page.screenshot({ path: path.join(OUT, name + '.png') }); };
async function waitScreen(page, name) {
  await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 240000 });
  await page.waitForTimeout(400);
}
/** Snapshot of the flight for assertions. */
const tel = page => page.evaluate(() => {
  const sw = window.__sw, w = sw.world, f = sw.app.flight;
  if (!w) return null;
  const v = w.active && !w.active.dead ? w.active : null;
  return {
    ut: w.ut, warp: w.warpIndex, vessels: w.vessels.length, paused: f.paused, mapOpen: f.mapOpen, assist: f.assist ? f.assist.phase : null,
    hud: { ...f.hud.values }, speedMode: f.state.speedMode, camMode: f.cam.mode,
    v: v && { id: v.id, name: v.name, type: v.type, sit: v.situation, alt: v.altitude, vs: v.verticalSpeed, speed: v.airspeed, orb: v.orbitalSpeed, thr: v.ctrl.throttle, sas: v.ctrl.sas, sasMode: v.ctrl.sasMode,
      stage: v.stageIndex, stages: v.stages.length, parts: v.parts.size, crew: v.crew, ap: v.apoapsis, pe: v.periapsis, landed: v.landed, splashed: v.splashed,
      thrust: v.thrust, ignited: [...v.parts.values()].filter(p => p.def.engine && p.ignited).length, nodes: v.nodes.length, science: v.science.length,
      evafuel: v.resources.evafuel ? v.resources.evafuel.amount : null, heat: v.heatFlux },
  };
});
/** Advance the game by calling the flight screen's update(dt) directly; stops early when `until` (a JS expression using w, v, f) is true. */
async function ff(page, simSeconds, until = 'false', dt = 0.05) {
  let left = simSeconds, hit = false;
  while (left > 0 && !hit) {
    const r = await page.evaluate(({ budget, until, dt }) => {
      const sw = window.__sw, app = sw.app, f = app.flight;
      const test = new Function('w', 'v', 'f', 'return (' + until + ');');
      const t0 = performance.now(); let sim0 = sw.world ? sw.world.ut : 0, hit = false, n = 0;
      while (performance.now() - t0 < 400 && app.currentName === 'flight' && sw.world) {
        const w = sw.world;
        if (w.ut - sim0 >= budget) break;
        app.current.update(dt); app.input.endFrame(); n++;
        const v = w.active && !w.active.dead ? w.active : null;
        if (test(w, v, f)) { hit = true; break; }
        if (f.paused || n > 20000) break;
      }
      return { advanced: sw.world ? sw.world.ut - sim0 : budget, hit, n, gone: app.currentName !== 'flight' };
    }, { budget: left, until, dt });
    hit = r.hit;
    if (r.gone) break;
    left -= Math.max(r.advanced, r.n ? dt * 0.5 : left);
  }
  return hit;
}
const key = async (page, code, hold = 60) => { await page.keyboard.down(code); await page.waitForTimeout(hold); await page.evaluate(() => { const a = window.__sw.app; if (a.currentName === 'flight' && !a.flight.paused) { a.current.update(0.02); a.input.endFrame(); } }); await page.keyboard.up(code); await page.waitForTimeout(30); };

async function startSandbox(page) {
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
  await page.click('[data-action="new"]');
  await page.click('.sw-mode[data-mode="sandbox"]');
  await page.click('.sw-modal .sw-btn.primary');
  await waitScreen(page, 'hub');
}
async function launchFromDialog(page, craftName) {
  await page.click('.sw-card[data-goto="launch"]');
  await page.waitForSelector('.sw-launch');
  await page.click(`.sw-item[data-craft="${craftName}"]`);
  await page.click('[data-action="launch"]');
  await waitScreen(page, 'flight');
  await page.waitForTimeout(1200);
}

// =====================================================================================================
async function mainFlight() {
  console.log('\n=== Skylark II: pad → orbit → EVA → landing → recovery (1440×900) ===');
  const { ctx, page } = await newPage(1440, 900);
  await startSandbox(page);
  await launchFromDialog(page, 'Skylark II');

  // ---- on the pad
  let t = await tel(page);
  ok(t && t.v && t.v.sit === 'prelaunch' && t.v.landed, 'the craft sits on the pad (prelaunch)');
  ok(t.v.crew.length === 1, `one Pip aboard (${t.v.crew.join(', ')})`);
  ok(await page.evaluate(() => window.__sw.app.flight.world === window.__sw.world && !!window.__sw.app.flight.scene && !!window.__sw.app.flight.camera && typeof window.__sw.app.flight.setCameraMode === 'function' && !!window.__sw.app.flight.hud), 'app.flight exposes world, scene, camera, setCameraMode, hud');
  ok(Math.abs(t.hud.pitch - 90) < 0.5, `attitude ball shows straight up on the pad (pitch ${t.hud.pitch.toFixed(1)}°)`);
  ok(await page.locator('.fl-hint').isVisible(), 'first-flight hint card is shown');
  ok(await page.locator('.fl-console').isVisible() && await page.locator('.fl-stage.next').isVisible(), 'console and stage strip are visible');
  ok(await page.locator('.fl-stage').count() >= 3, 'stage strip lists the stages');
  ok(await page.evaluate(() => document.querySelectorAll('.fl-stage-ico img').length > 0), 'stage cards carry part thumbnails');
  await shot(page, 'flight-01-pad');

  // camera: wheel zoom, right-drag orbit, V cycles modes, double-click resets
  const d0 = await page.evaluate(() => window.__sw.app.flight.cam.dist);
  await page.mouse.move(700, 350); await page.mouse.wheel(0, 300); await page.waitForTimeout(500);
  await ff(page, 0.5);
  const d1 = await page.evaluate(() => window.__sw.app.flight.cam.dist);
  ok(d1 > d0 * 1.05, `scrolling zooms the camera out (${d0.toFixed(1)} → ${d1.toFixed(1)} m)`);
  const y0 = await page.evaluate(() => window.__sw.app.flight.cam.yaw);
  await page.mouse.move(700, 350); await page.mouse.down({ button: 'right' }); await page.mouse.move(780, 330, { steps: 4 }); await page.mouse.up({ button: 'right' });
  const y1 = await page.evaluate(() => window.__sw.app.flight.cam.yaw);
  ok(Math.abs(y1 - y0) > 0.2, 'right-drag orbits the camera');
  await key(page, 'KeyV');
  ok((await tel(page)).camMode === 'chase', 'V switches to the chase camera');
  await key(page, 'KeyV'); await key(page, 'KeyV'); await key(page, 'KeyV');
  ok((await tel(page)).camMode === 'orbit', 'V cycles (chase, free, locked) back to the orbital camera');
  await page.mouse.dblclick(700, 350); await ff(page, 0.6);
  ok(Math.abs(await page.evaluate(() => window.__sw.app.flight.cam.dist) - d0) < 1, 'double-click resets the camera');

  // ---- T (SAS), Z (full throttle), Space (launch)
  await key(page, 'KeyT');
  ok((await tel(page)).v.sas === false, 'T toggles SAS off');
  await key(page, 'KeyT');
  ok((await tel(page)).v.sas === true, 'T toggles SAS back on');
  await key(page, 'KeyZ');
  ok((await tel(page)).v.thr === 1, 'Z sets full throttle');
  await key(page, 'Space');
  await ff(page, 3);
  t = await tel(page);
  ok(t.v.ignited >= 1 && t.v.thrust > 0, 'Space ignites the first stage');
  ok(t.v.stage === 1, 'stage index advanced to 1');
  ok(t.v.sit === 'flying' && t.v.alt > 9 && t.v.vs > 1, `liftoff: climbing at ${t.v.vs.toFixed(1)} m/s, ${t.v.alt.toFixed(0)} m`);
  ok(!(await page.locator('.fl-hint').isVisible()), 'hint card went away at launch');
  ok(await page.evaluate(() => window.__sw.career.milestones.has('first_launch')), 'first launch milestone was credited through career.onEvent');
  await shot(page, 'flight-02-liftoff');

  // ---- climb to 2 km
  await ff(page, 60, 'v && v.altitude > 2000');
  t = await tel(page);
  ok(t.v.alt > 1900 && t.v.alt < 4000, `reached ~2 km (${(t.v.alt / 1000).toFixed(2)} km)`);
  await shot(page, 'flight-03-2km');

  // ---- pitch east with D
  await page.keyboard.down('KeyD');
  await ff(page, 12, 'f.state.pitch < 78');
  await page.keyboard.up('KeyD');
  await ff(page, 2);
  t = await tel(page);
  ok(t.hud.pitch < 82 && t.hud.pitch > 55, `holding D tips the nose over (pitch ${t.hud.pitch.toFixed(1)}°)`);
  ok(Math.abs(t.hud.heading - 90) < 6, `the attitude ball shows heading ~90° after yawing east (${t.hud.heading.toFixed(1)}°)`);
  await page.screenshot({ path: path.join(OUT, 'flight-04-ball-east.png'), clip: { x: 520, y: 660, width: 400, height: 240 } });

  // ---- hand over to the ascent assist, physics warp with the period key
  await page.click('[data-tool="assist"]');
  ok((await tel(page)).assist !== null, 'ascent assist engaged from the toolbar');
  await key(page, 'Period'); await key(page, 'Period');
  ok((await tel(page)).warp === 2, 'period key raises physics warp');
  await key(page, 'Comma');
  ok((await tel(page)).warp === 1, 'comma key lowers it');
  await key(page, 'Slash');
  ok((await tel(page)).warp === 0, 'slash stops time warp');
  await ff(page, 200, 'v && v.altitude > 20000');
  t = await tel(page);
  ok(t.v.alt > 19000, `climbed to ~20 km (${(t.v.alt / 1000).toFixed(1)} km), speed ${t.v.speed.toFixed(0)} m/s`);
  await shot(page, 'flight-05-20km');

  // ---- to orbit
  const staged0 = t.v.stage;
  await ff(page, 3000, '!f.assist');
  t = await tel(page);
  ok(t.v && t.v.sit === 'orbit', `in orbit: ${(t.v.ap / 1000).toFixed(1)} × ${(t.v.pe / 1000).toFixed(1)} km`);
  ok(t.v.stage > staged0 || t.v.stage >= 2, 'the booster stage was dropped on the way up');
  ok(t.vessels >= 1, 'debris is tracked as separate vessels');
  ok(t.speedMode === 'orbit', 'speed readout switched to orbit mode above the atmosphere');
  ok(await page.evaluate(() => window.__sw.career.milestones.has('orbit_verda') || [...window.__sw.career.milestones].some(m => /orbit/.test(m))), 'orbit milestone credited');
  await ff(page, 1);
  await shot(page, 'flight-06-orbit');
  await key(page, 'KeyC');
  ok((await tel(page)).speedMode === 'surface', 'C toggles the speed readout mode');
  await key(page, 'KeyC');

  // ---- SAS mode buttons
  await page.click('[data-sas="prograde"]');
  ok((await tel(page)).v.sasMode === 'prograde', 'SAS prograde button sets the mode');
  await ff(page, 25);
  const err = await page.evaluate(() => { const v = window.__sw.world.active; const n = v.vel.clone().normalize(); const y = n.clone().set(0, 1, 0).applyQuaternion(v.q); return y.angleTo(n) * 180 / Math.PI; });
  ok(err < 8, `SAS turns the nose prograde (${err.toFixed(1)}° off)`);
  const mk = await page.evaluate(() => { const b = window.__sw.app.flight.ball; const p = b.markers.find(m => m.kind === 'prograde'); const o = b.project(p.dir, {}); return o; });
  ok(mk.front && Math.hypot(mk.x, mk.y) < 0.15, 'the prograde marker sits at the centre of the attitude ball');
  await page.click('[data-sas="hold"]');

  // ---- map + maneuver node
  await key(page, 'KeyM');
  await page.waitForTimeout(800);
  t = await tel(page);
  ok(t.mapOpen && await page.locator('.map-root').isVisible(), 'M opens the map');
  ok(await page.locator('.fl-console').isVisible() && await page.locator('.fl-time').isVisible(), 'console and warp controls stay visible over the map');
  const ut0 = t.ut;
  await ff(page, 2);
  ok((await tel(page)).ut > ut0 + 1, 'the simulation keeps running while the map is open');
  await page.evaluate(() => { const w = window.__sw.world, v = w.active; v.addNode(w.ut + 900, { prograde: 40, normal: 0, radial: 0 }); });
  await ff(page, 1);
  await shot(page, 'flight-07-map');
  ok(await page.locator('.fl-node').isVisible(), 'maneuver read-out appears with the node');
  t = await tel(page);
  ok(Math.abs(t.hud.nodeDv - 40) < 0.5 && t.hud.nodeBurn > 0 && Number.isFinite(t.hud.nodeBurn), `node shows ${t.hud.nodeDv.toFixed(1)} m/s and a ${t.hud.nodeBurn.toFixed(1)} s burn`);
  ok(await page.evaluate(() => window.__sw.app.flight.ball.markers.some(m => m.kind === 'maneuver')), 'maneuver marker is on the attitude ball');
  await key(page, 'KeyM');
  ok(!(await tel(page)).mapOpen && !(await page.locator('.map-root').count()), 'M closes the map');
  // fly the node with SAS maneuver hold
  await page.click('[data-sas="maneuver"]');
  ok((await tel(page)).v.sasMode === 'maneuver', 'SAS maneuver mode engages');
  await page.evaluate(() => window.__sw.world.warpTo(window.__sw.world.active.nodes[0].t - 12));
  await ff(page, 1200, 'v && w.warpTarget === null && w.warpIndex === 0 && v.nodes[0] && v.nodes[0].t - w.ut < 30');
  // let SAS bring the nose onto the node before lighting the engine, as a pilot would: the warp leaves the ship pointing
  // where it was, and this engine gives 2.8 g, so a burn started far off the marker spends the tank chasing its own error
  const NOSE_ON_NODE = '(g => g && 2 * (v.q.x * v.q.y - v.q.w * v.q.z) * g.x + (1 - 2 * (v.q.x * v.q.x + v.q.z * v.q.z)) * g.y + 2 * (v.q.y * v.q.z + v.q.w * v.q.x) * g.z > 0.9994)(v && v._guideDir)';
  await ff(page, 25, NOSE_ON_NODE);
  ok(await page.evaluate(expr => { const v = window.__sw.world.active; return new Function('v', 'return ' + expr)(v); }, NOSE_ON_NODE), 'SAS maneuver hold brings the nose within 2° of the node before the burn');
  // burn across the node time: full throttle for the bulk, then a trickle for the last few m/s (2.8 g is 1.4 m/s a step)
  await ff(page, 40, 'v && v.nodes[0] && v.nodes[0].t - w.ut < 0.8');
  await key(page, 'KeyZ');
  await ff(page, 30, '!v || !v.nodes.length || v.nodeDv < 8');
  await page.evaluate(() => { window.__sw.world.active.ctrl.throttle = 0.1; });
  await ff(page, 60, '!v || !v.nodes.length || v.nodeDv < 0.4');
  await key(page, 'KeyX');
  await ff(page, 10, '!v || !v.nodes.length');
  t = await tel(page);
  ok(t.v.nodes === 0, 'the finished maneuver node is removed');
  ok(t.v.thr === 0, 'X cuts the throttle');
  ok(t.v.sit === 'orbit' && t.v.ap > 120000 && t.v.pe > 79000, `the 40 m/s prograde burn raised the far side of the orbit and left the near side alone: ${(t.v.ap / 1000).toFixed(1)} × ${(t.v.pe / 1000).toFixed(1)} km`);

  // ---- time warp on rails
  for (let i = 0; i < 6; i++) await key(page, 'Period');
  t = await tel(page);
  ok(t.warp >= 4, `period key reaches on-rails warp in orbit (index ${t.warp})`);
  const utW = t.ut;
  await ff(page, 2000, 'false', 0.05);
  ok((await tel(page)).ut - utW > 150, 'rails warp moves time quickly');
  await key(page, 'Slash');
  ok((await tel(page)).warp === 0, 'slash drops out of warp');
  await page.click('[data-warp="2"]');
  ok((await tel(page)).warp === 2, 'warp steps are clickable');
  await page.click('[data-warp="0"]');

  // ---- pause menu
  await key(page, 'Escape');
  await page.waitForSelector('.fl-menu');
  t = await tel(page);
  ok(t.paused, 'Escape opens the pause menu and pauses');
  await page.waitForTimeout(600);
  ok(Math.abs((await tel(page)).ut - t.ut) < 1e-6, 'time stands still while paused');
  ok(await page.locator('[data-menu="revertLaunch"]').isEnabled() && await page.locator('[data-menu="revertHangar"]').isEnabled() && !(await page.locator('[data-menu="recover"]').isEnabled()), 'pause menu offers the reverts; recover is disabled in orbit');
  await shot(page, 'flight-08-pause');
  await page.click('[data-menu="controls"]');
  await page.waitForSelector('.sw-controls');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.fl-menu');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.sw-modal-backdrop:not(.closing)'));
  await page.waitForTimeout(250);
  ok(!(await tel(page)).paused, 'Escape resumes');

  // ---- quicksave / quickload
  const before = await tel(page);
  await key(page, 'F5');
  ok(await page.evaluate(() => !!localStorage.getItem('starwright.quicksave.v1')), 'F5 writes a quicksave');
  await ff(page, 30);
  await page.evaluate(() => { window.__sw.world.active.ctrl.sas = false; });
  await page.keyboard.down('ShiftLeft'); await key(page, 'KeyL'); await page.keyboard.up('ShiftLeft');
  await page.waitForSelector('.sw-modal .sw-btn.primary');
  await page.click('.sw-modal .sw-btn.primary');
  await page.waitForFunction(() => !document.querySelector('.sw-modal-backdrop:not(.closing)'));
  await ff(page, 0.2);
  t = await tel(page);
  ok(Math.abs(t.ut - before.ut) < 1.5 && t.v.sas === true && t.v.parts === before.v.parts && t.vessels === before.vessels, `Shift+L restores the quicksave (ut ${before.ut.toFixed(1)} → ${t.ut.toFixed(1)})`);
  ok(Math.abs(t.v.ap - before.v.ap) < 200 && t.v.sit === 'orbit', 'orbit is intact after the round trip');
  ok(t.v.thr === before.v.thr, 'holding Shift for the shortcut did not bump the throttle');

  // ---- science: crew report
  await page.click('[data-tool="science"]');
  await page.waitForSelector('.fl-pop[data-panel="science"]');
  await page.click('.fl-pop-row[data-exp="crew_report"] [data-action="run"]');
  t = await tel(page);
  ok(t.v.science === 1, 'running the crew report stores a result');
  await shot(page, 'flight-09-science');
  await page.click('[data-tool="science"]');

  // ---- EVA from orbit and back
  await page.click('[data-tool="crew"]');
  await page.waitForSelector('.fl-pop[data-panel="crew"]');
  await page.click('.fl-pop [data-action="eva"]');
  await ff(page, 0.5);
  t = await tel(page);
  ok(t.v.type === 'eva', `${t.v.name} is on a spacewalk`);
  ok(await page.locator('.fl-eva').isVisible(), 'spacewalk controls are shown');
  ok(await page.evaluate(() => window.__sw.career.milestones.has('eva_space')), 'spacewalk milestone credited');
  await page.keyboard.down('KeyS'); await ff(page, 1.5); await page.keyboard.up('KeyS');
  const fuel1 = (await tel(page)).v.evafuel;
  ok(fuel1 !== null && fuel1 < t.v.evafuel, 'the jetpack burns fuel when translating');
  await page.click('[data-eva="report"]');
  ok((await tel(page)).v.science === 1, 'spacewalk report taken');
  await ff(page, 2);
  await shot(page, 'flight-10-eva');
  // fly back to the hatch and board
  const hatch = `(() => { const s = w.vessels.find(x => x.type === 'ship' && x._commands.length); const p = s._commands[0]; return s.partWorldPos(p).distanceTo(v.pos); })()`;
  await page.keyboard.down('KeyW'); await ff(page, 20, `v && v.type === 'eva' && ${hatch} < 2.8`, 0.02); await page.keyboard.up('KeyW');
  let boarded = false;
  await key(page, 'KeyF');
  boarded = (await tel(page)).v.type === 'ship';
  ok(boarded, 'W flies the Pip back and F boards within reach of the hatch');
  if (!boarded) { await page.evaluate(() => { const w = window.__sw.world, e = w.active, s = w.vessels.find(v => v.type === 'ship' && v._commands.length); s.partWorldPos(s._commands[0], e.pos); e.pos.x += 1.5; e.vel.copy(s.vel); window.__sw.app.flight.actions.board(); }); }
  t = await tel(page);
  ok(boarded && t.v.crew.length === 1, 'F boards the capsule again');
  ok(t.v.science === 2, 'the spacewalk report came aboard with the Pip');

  // ---- drop the upper stage (Space), then set up re-entry
  const stageBefore = t.v.stage, vesselsBefore = t.vessels;
  await key(page, 'Space');
  await ff(page, 1);
  t = await tel(page);
  ok(t.v.stage === stageBefore + 1 && t.vessels > vesselsBefore, 'Space fires the separator: a new debris vessel appears');
  await shot(page, 'flight-11-staged');

  // Re-entry: put the capsule on a steep-ish descent at 48 km (constructed state to save time)
  await page.evaluate(() => {
    const w = window.__sw.world, v = w.active, b = v.body;
    const up = v.pos.clone().normalize(), fwd = v.vel.clone().normalize();
    v.pos.copy(up).multiplyScalar(b.radius + 48000);
    v.vel.copy(fwd).multiplyScalar(2150).addScaledVector(up, -160);
    v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde'; v._stamp++;
    while (v.nodes.length) v.removeNode(v.nodes[0]);
  });
  await ff(page, 400, 'v && v.heatFlux > 45000');      // (the peak on this path is 58 kW/m² for a 1 m nose)
  await ff(page, 3);
  t = await tel(page);
  ok(t.v.heat > 30000, `re-entry heating builds up (${(t.v.heat / 1000).toFixed(0)} kW/m²)`);
  await shot(page, 'flight-12-reentry');
  await ff(page, 900, 'v && v.altitude < 6000 && v.airspeed < 330');
  t = await tel(page);
  ok(t.v && t.v.alt < 6500, 'the capsule survives re-entry');
  // place it over the launch site region (land) for a dry landing, then pop the chute with Space
  await page.evaluate(async () => {
    const { SYSTEM } = await import('/js/core/bodies.js');
    const w = window.__sw.world, v = w.active, b = v.body;
    const dir = SYSTEM.launchSite.dir.clone().applyAxisAngle({ x: 0, y: 1, z: 0 }, 0.004);
    b.surfaceDirToInertial(dir, w.ut, v.pos).multiplyScalar(b.radius + 2600);
    const wy = 2 * Math.PI / b.rotPeriod;
    v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x).addScaledVector(v.pos.clone().normalize(), -120);
    v._stamp++;
  });
  await key(page, 'Space');
  await ff(page, 20, 'v && [...v.parts.values()].some(p => p.deployed === "full")');
  await ff(page, 2);
  t = await tel(page);
  ok(await page.evaluate(() => [...window.__sw.world.active.parts.values()].some(p => p.deployed === 'full' || p.deployed === 'semi')), 'Space deploys the parachute');
  await shot(page, 'flight-13-chute');
  await ff(page, 600, 'v && v.landed');
  await ff(page, 2);
  t = await tel(page);
  ok(t.v && t.v.landed && (t.v.sit === 'landed' || t.v.sit === 'splashed'), `touchdown: ${t.v && t.v.sit}`);
  ok(await page.locator('[data-tool="recover"]').isVisible(), 'Recover button appears after landing on Verda');
  await shot(page, 'flight-14-landed');

  // plant a flag on a quick spacewalk
  await page.click('[data-tool="crew"]');
  await page.click('.fl-pop [data-action="eva"]');
  await ff(page, 1);
  t = await tel(page);
  ok(t.v.type === 'eva' && t.v.landed, 'the Pip steps out onto the ground');
  await page.keyboard.down('KeyW'); await ff(page, 2); await page.keyboard.up('KeyW');
  await key(page, 'KeyP');
  await page.waitForSelector('[data-flag-name]');
  await page.fill('[data-flag-name]', 'First Steps');
  await page.click('.sw-modal .sw-btn.primary');
  await page.waitForFunction(() => !document.querySelector('.sw-modal-backdrop:not(.closing)'));
  await ff(page, 0.5);
  ok(await page.evaluate(() => window.__sw.world.flags.length === 1 && window.__sw.world.flags[0].name === 'First Steps'), 'P plants a named flag');
  await page.click('[data-eva="sample"]');
  await ff(page, 1);
  await shot(page, 'flight-15-flag');
  let back = false;
  for (let i = 0; i < 30 && !back; i++) { await key(page, 'KeyF'); back = (await tel(page)).v.type === 'ship'; if (!back) { await page.keyboard.down('KeyS'); await ff(page, 0.5); await page.keyboard.up('KeyS'); } }
  ok(back, 'the Pip walks back and boards with F');

  // ---- recovery
  const sciBefore = await page.evaluate(() => window.__sw.career.science);
  await page.click('[data-tool="recover"]');
  await page.waitForSelector('[data-summary="recovery"]');
  await shot(page, 'flight-16-recovery');
  ok(/Crew home safe/.test(await page.locator('.fl-sum').innerText()), 'recovery summary lists the crew');
  await page.click('.sw-modal .sw-btn.primary');
  await waitScreen(page, 'hub');
  const c = await page.evaluate(() => { const c = window.__sw.career; return { roster: c.roster.map(p => p.status), flights: c.roster.reduce((s, p) => s + p.flights, 0), science: c.science, flightState: c.flightState, world: window.__sw.world, ut: c.ut }; });
  ok(c.roster.every(s => s === 'available') && c.flights === 1, 'the crew is home and available again');
  ok(c.ut > 600, 'career clock advanced with the flight');
  ok(c.science >= sciBefore, 'stored science was banked on recovery');
  ok(c.flightState === null || c.flightState.vessels.every(v => v.type === 'debris' || v.type === 'ship'), 'flight state was saved on exit');
  await ctx.close();
}

// =====================================================================================================
async function crashAndRevert() {
  console.log('\n=== Hopper I: revert, crash, resume (1280×720) ===');
  const { ctx, page } = await newPage(1280, 720);
  await startSandbox(page);
  await launchFromDialog(page, 'Hopper I');
  await shot(page, 'flight-20-pad-720');
  const box = async sel => page.locator(sel).boundingBox();
  const con = await box('.fl-console'), stages = await box('.fl-stages'), tools = await box('.fl-tools'), time = await box('.fl-time'), ves = await box('.fl-vessel');
  const alt = await box('[data-hud="altitude"]'), res = await box('[data-hud="resources"]'), crew = await box('[data-hud="crew"]');
  ok(con && con.x >= 0 && con.x + con.width <= 1280 && con.y + con.height <= 720, 'console fits at 1280×720');
  // second pass layout: staging stack bottom-left, console bottom-centre, crew portraits bottom-right
  ok(stages && stages.x + stages.width <= con.x + 2, 'the staging stack (bottom left) does not overlap the console at 1280×720');
  ok(crew && con.x + con.width <= crew.x + 2, 'the crew portraits (bottom right) do not overlap the console at 1280×720');
  // top row: clock + vessel (left column), altimeter (centre), resources, toolbar (right edge)
  ok(tools && time && alt && res && time.x + time.width <= alt.x && ves.x + ves.width <= alt.x && alt.x + alt.width <= res.x && res.x + res.width <= tools.x && ves.y >= time.y + time.height, 'top row pieces do not overlap at 1280×720');
  ok(alt.y + alt.height < con.y && tools.y + tools.height <= 720, 'altimeter clears the console and the toolbar fits at 1280×720');

  // save & return, then resume from the hub
  await key(page, 'Escape');
  await page.waitForSelector('.fl-menu');
  await page.click('[data-menu="exit"]');
  await waitScreen(page, 'hub');
  ok(await page.evaluate(() => !!window.__sw.career.flightState && window.__sw.career.flightState.vessels.length === 1), 'save & return keeps the flight');
  await page.click('[data-action="resume"]');
  await waitScreen(page, 'flight');
  let t = await tel(page);
  ok(t.v && t.v.name === 'Hopper I' && t.v.sit === 'prelaunch', 'resume puts us back in the same flight');

  // fly a little, quicksave is not needed here: launch, then revert to hangar is unavailable after resume
  await key(page, 'Escape');
  await page.waitForSelector('.fl-menu');
  ok(await page.locator('[data-menu="revertLaunch"]').count() === 0 && await page.locator('[data-menu="revertSave"]').isEnabled(), 'a resumed flight offers "Revert to last save" instead of the launch reverts');
  await page.click('[data-menu="exit"]');
  await waitScreen(page, 'hub');

  // fresh launch: fly, revert to launch
  await launchFromDialog(page, 'Hopper I');
  const utLaunch = (await tel(page)).ut;
  await key(page, 'Space');
  await ff(page, 6);
  t = await tel(page);
  ok(t.v.alt > 30 && t.v.sit === 'flying', `the solid booster lifts the Hopper (${t.v.alt.toFixed(0)} m)`);
  await shot(page, 'flight-21-hopper');
  await key(page, 'Escape');
  await page.waitForSelector('.fl-menu');
  await page.click('[data-menu="revertLaunch"]');
  await page.waitForSelector('.sw-modal .sw-btn.danger');
  await page.click('.sw-modal .sw-btn.danger');
  await page.waitForFunction(() => !document.querySelector('.sw-modal-backdrop:not(.closing)'));
  // the clock as the revert left it: read before anything else runs (the game clock runs in real time from here, and a
  // loaded machine took more than the 0.5 s allowed just to get through the 0.3 s of frames that follow)
  const utReverted = (await tel(page)).ut;
  await ff(page, 0.3);
  t = await tel(page);
  ok(t.v.sit === 'prelaunch' && t.v.stage === 0 && Math.abs(utReverted - utLaunch) < 0.5 && t.ut - utReverted < 5, `revert to launch restores the pad (${t.v.sit}, stage ${t.v.stage}, ut ${utReverted.toFixed(1)} vs ${utLaunch.toFixed(1)})`);

  // crash: launch and tip over, then come down hard
  await key(page, 'Space');
  await ff(page, 4);
  await page.evaluate(() => {
    const v = window.__sw.world.active, b = v.body, up = v.pos.clone().normalize(), wy = 2 * Math.PI / b.rotPeriod;
    for (const p of v.parts.values()) if (p.res.solid) p.res.solid = 0;          // burnt out
    v.pos.copy(up).multiplyScalar(b.radius + 260);
    v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x).addScaledVector(up, -110);
    v.ctrl.sas = false; v._stamp++;
  });
  await ff(page, 30, '!v || v.type === "debris"');
  await ff(page, 1.5);
  await page.waitForTimeout(600);
  ok(await page.locator('.fl-center').isVisible(), 'a destroyed vessel brings up the centre message');
  ok(/lost/i.test(await page.locator('.fl-center h2').innerText()), 'the message says the vessel was lost');
  const lost = await page.evaluate(() => window.__sw.career.roster.filter(p => p.status === 'lost').length);
  ok(lost === 1, 'the lost Pip is recorded through career.onEvent (loseCrew)');
  await shot(page, 'flight-22-lost');
  await page.click('[data-center="revertHangar"]');
  await waitScreen(page, 'builder');
  const after = await page.evaluate(() => ({ lost: window.__sw.career.roster.filter(p => p.status === 'lost').length, assigned: window.__sw.career.roster.filter(p => p.status === 'assigned').length, fs: window.__sw.career.flightState }));
  ok(after.lost === 0 && after.assigned === 0, 'revert to the hangar rolls the career back (crew alive and released)');
  ok(after.fs === null, 'no flight is left behind after reverting to the hangar');
  await page.waitForTimeout(800);
  await shot(page, 'flight-23-back-in-hangar');
  await ctx.close();
}

// =====================================================================================================
/** Where the active vessel stands relative to the pad (metres east / south), plus the wheel and lamp state. */
const ground = page => page.evaluate(() => {
  const w = window.__sw.world, v = w.active, b = v.body;
  const ll = b.latLon(b.inertialToSurfaceDir(v.pos, w.ut));
  return { east: ll.lon * b.radius, south: -ll.lat * b.radius, speed: v.surfaceVel.length(), alt: v.altitude, agl: v.radarAlt,
    sit: v.situation, landed: v.landed, dead: v.dead, site: v.launchSite, gear: v.gearDown, brake: v.ctrl.brake, lights: !!v.lightsOn, met: v.launched ? w.ut - v.launchUt : 0,
    heading: window.__sw.app.flight.state.heading, parts: v.parts.size, thr: v.ctrl.throttle };
});
async function launchFromRunway(page, craftName) {
  await page.click('.sw-card[data-goto="runway"]');
  await page.waitForSelector('.sw-launch[data-site="runway"]');
  await page.click(`.sw-item[data-craft="${craftName}"]`);
  await page.click('[data-action="launch"]');
  await waitScreen(page, 'flight');
  await page.waitForTimeout(1200);
}
const hold = async (page, code, sim, until = 'false') => { await page.keyboard.down(code); await page.waitForTimeout(40); const r = await ff(page, sim, until); await page.keyboard.up(code); await page.waitForTimeout(40); return r; };

async function openPauseMenu(page) {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape');
    try { await page.waitForSelector('.fl-menu', { timeout: 15000 }); return; } catch { /* a panel took the key: again */ }
  }
  await page.waitForSelector('.fl-menu');
}
async function vehicles() {
  console.log('\n=== Runway: Kite Trainer take-off, turn and autopilot landing; Trundle Scout drive (1440×900) ===');
  const { ctx, page } = await newPage(1440, 900);
  await startSandbox(page);

  const roverOnly = process.env.ONLY === 'rover';
  let g = null, t = null;
  if (!roverOnly) {
  // ---- aeroplane, flown by hand
  await launchFromRunway(page, 'Kite Trainer');
  g = await ground(page);
  ok(g.site === 'runway' && g.sit === 'prelaunch' && g.landed, `the plane stands at the runway (site ${g.site}, ${g.sit})`);
  ok(g.east > -960 && g.east < -700 && Math.abs(g.south - 850) < 12, `it stands on the drawn strip near its west end (${g.east.toFixed(0)} m east, ${g.south.toFixed(0)} m south of the pad)`);
  ok(/runway/i.test(await page.locator('.fl-vessel-sit').innerText()), 'the HUD says the craft is on the runway');
  ok(Math.abs((await tel(page)).hud.pitch) < 6, 'the attitude ball shows a level aeroplane');
  const eng = await page.evaluate(() => { const v = window.__sw.world.active; const e = v.partList.find(p => p.def.engine); v.setGroupAction('1', e.id, 'toggleEngine'); return e.id; });
  await key(page, 'Digit1');
  ok(await page.evaluate(id => window.__sw.world.active.parts.get(id).ignited, eng), 'action group 1 (bound to the engine) starts it from the keyboard');
  await key(page, 'KeyZ'); await key(page, 'KeyB');
  g = await ground(page);
  ok(g.thr > 0.95 && !g.brake, 'Z opens the throttle and B releases the brakes');
  await ff(page, 60, 'v && v.airspeed > 70');
  g = await ground(page);
  ok(g.speed > 40 && Math.abs(g.south - 850) < 25, `the take-off roll runs down the strip (${g.speed.toFixed(0)} m/s, ${(g.south - 850).toFixed(1)} m off the centreline)`);
  ok(g.met > 1, `the mission clock started at roll-out (T+${(g.met || 0).toFixed(0)} s)`);
  await hold(page, 'KeyS', 25, 'v && !v.landed && v.altitude - 0 > 0 && v.verticalSpeed > 4');
  await ff(page, 20, 'v && v.verticalSpeed > 3 && !v.landed');
  t = await tel(page);
  ok(t.v && !t.v.landed && t.v.vs > 0, `pulling back lifts it off the runway (climbing ${t.v ? t.v.vs.toFixed(1) : '?'} m/s)`);
  await shot(page, 'flight-30-plane-airborne');
  await key(page, 'KeyG');
  ok((await ground(page)).gear === false, 'G retracts the landing gear');
  await ff(page, 40, 'v && v.altitude > 500');                      // SAS holds the climb attitude
  g = await ground(page);
  const h0 = g.heading;
  console.log(`    climbing through ${g.alt.toFixed(0)} m at ${g.speed.toFixed(0)} m/s`);
  await hold(page, 'KeyE', 1.6); await hold(page, 'KeyS', 5); await hold(page, 'KeyQ', 1.6);
  g = await ground(page);
  const turned = Math.abs(((g.heading - h0 + 540) % 360) - 180);
  ok(turned > 8 && !g.dead, `banking and pulling turns the aeroplane (${turned.toFixed(0)}° of heading)`);

  // ---- the Autopilot panel flies the approach and landing
  await page.click('[data-tool="guide"]');
  await page.waitForSelector('[data-program="land"]');
  ok(await page.locator('[data-program="land"] [data-action="program"]').isEnabled(), 'the Autopilot panel offers "land at the runway" in flight');
  await page.click('[data-program="land"] [data-action="program"]');
  ok(await page.evaluate(() => !!window.__sw.app.flight.assist), 'engaging it hands the aeroplane to the landing program');
  await ff(page, 1500, '!v || (v.landed && v.surfaceVel.length() < 1) || !f.assist', 0.05);
  await ff(page, 20, '!v || (v.landed && v.surfaceVel.length() < 0.5)');
  g = await ground(page);
  ok(!g.dead && g.landed, `the program lands the aeroplane in one piece (${g.sit}, ${g.parts} parts)`);
  ok(g.east > -1000 && g.east < 1100 && Math.abs(g.south - 850) < 40, `it stops on the runway (${g.east.toFixed(0)} m east, ${(g.south - 850).toFixed(1)} m off the centreline)`);
  await shot(page, 'flight-31-plane-landed');

  // back to the Flight Center through the pause menu (the open Autopilot panel takes the first Escape)
  await page.click('[data-tool="guide"]');
  await openPauseMenu(page);
  await page.click('[data-menu="exit"]');
  await waitScreen(page, 'hub');
  }

  // ---- rover
  await launchFromRunway(page, 'Trundle Scout');
  g = await ground(page);
  ok(g.site === 'runway' && g.landed && Math.abs(g.south - 850) < 12, 'the rover rolls out onto the runway');
  ok(await page.evaluate(() => { const a = window.__sw.app.flight.actions.programs(); return a.some(p => p.id === 'drive' && p.ok) && !a.some(p => p.id === 'ascent' && p.ok); }), 'the Autopilot panel offers the drive program (and no ascent) for a rover');
  if (g.brake) await key(page, 'KeyB');
  await hold(page, 'KeyW', 12);
  g = await ground(page);
  ok(g.speed > 2 && !g.dead && g.agl < 1, `W drives it forward (${g.speed.toFixed(1)} m/s)`);
  ok(g.met > 1, 'the mission clock runs once the rover rolls');
  const hd = g.heading;
  await page.keyboard.down('KeyW'); await hold(page, 'KeyD', 4); await page.keyboard.up('KeyW');
  g = await ground(page);
  const steer = ((g.heading - hd + 540) % 360) - 180;
  ok(steer > 3 && !g.dead, `D steers to the right (${steer.toFixed(0)}° of heading)`);
  await key(page, 'KeyU');
  ok((await ground(page)).lights, 'U switches the headlamps on');
  await hold(page, 'KeyB', 15, 'v && v.surfaceVel.length() < 0.2');
  g = await ground(page);
  ok(g.speed < 0.5, `holding B brakes it to a stop (${g.speed.toFixed(2)} m/s)`);
  await shot(page, 'flight-32-rover');

  // ---- graphics menu under software GL
  const soft = await page.evaluate(() => window.__sw.app.flight.view.softGL);
  if (soft) {
    await openPauseMenu(page);
    await page.click('[data-menu="graphics"]');
    await page.waitForSelector('[data-gfx="soft-note"]');
    ok(await page.locator('[data-gfx="gfxQuality"][data-v=""]').evaluate(b => b.classList.contains('primary') && /Reduced/.test(b.textContent)), 'under software GL the graphics menu shows "Reduced (automatic)" as the active detail level');
  }
  await ctx.close();
}

try {
  const only = process.env.ONLY || '';
  if (!only || only === 'main') await mainFlight();
  if (!only || only === 'crash') await crashAndRevert();
  if (!only || only === 'vehicles' || only === 'rover') await vehicles();
} catch (err) {
  problems.push('test aborted: ' + (err.stack || err.message));
}
await browser.close();
await server.close();
console.log(`\n${checks} checks, ${problems.length} problem(s)`);
for (const p of problems) console.log('  - ' + p);
process.exit(problems.length ? 1 : 0);
