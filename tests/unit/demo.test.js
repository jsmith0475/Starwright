// The demo tour's prepared scenes (js/ui/demo/scenes.js), flown here without a browser: every cut the tour makes
// must start from a sane state and reach the end its chapter waits for, with the same autopilot programs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { World } from '../../js/core/world.js';
import * as AP from '../../js/core/autopilot.js';
import * as K from '../../js/ui/demo/kit.js';
import * as S from '../../js/ui/demo/scenes.js';

const Q = 1 / 30;
/** Step like the tour does: the controller once per physics step. Returns simulated seconds. */
function run(w, ctl, maxSim, until) {
  const t0 = w.ut; let n = 0;
  while (w.ut - t0 < maxSim && n++ < 2e6) {
    if (ctl) { ctl.update(Q); if (ctl.done) break; }
    if (until && until()) break;
    w.step(Q);
    if (!w.active || w.active.dead) break;
  }
  return w.ut - t0;
}
const logOf = c => c.log.map(l => l.msg).join(' | ');

test('demo kit: seeded random numbers repeat, poses mix, orbit states are circular', () => {
  const a = K.seededRandom(7), b = K.seededRandom(7), c = K.seededRandom(8);
  const xs = [a(), a(), a()], ys = [b(), b(), b()];
  assert.deepEqual(xs, ys);
  assert.notEqual(xs[0], c());
  assert.ok(xs.every(x => x >= 0 && x < 1));
  assert.deepEqual(K.mixPose({ a: 0, b: 2 }, { a: 10, b: 4 }, 0.5), { a: 5, b: 3 });
  const st = K.orbitState(SYSTEM.home, 100000, 1234);
  const r = st.pos.length(), v = st.vel.length();
  assert.ok(Math.abs(r - (SYSTEM.home.radius + 100000)) < 1e-3);
  assert.ok(Math.abs(v - Math.sqrt(SYSTEM.home.gm / r)) < 1e-6);
  assert.ok(Math.abs(st.pos.dot(st.vel)) < 1e-3, 'velocity is horizontal');
  assert.ok(st.pos.clone().normalize().dot(K.sunwardOf(SYSTEM.home, 1234)) > 0.999, 'starts over the lit side');
});

test('demo scenes: sun-angle helper finds a morning and an evening', () => {
  const dir = SYSTEM.launchSite.dir, b = SYSTEM.home;
  const am = S.utForSun(b, dir, 27, true), pm = S.utForSun(b, dir, 27, false);
  assert.ok(Math.abs(S.sunElevation(b, dir, am) - 27 * Math.PI / 180) < 0.02);
  assert.ok(S.sunElevation(b, dir, am + 300) > S.sunElevation(b, dir, am), 'rising');
  assert.ok(S.sunElevation(b, dir, pm + 300) < S.sunElevation(b, dir, pm), 'setting');
});

test('demo scene: pad launch reaches orbit, then a Pell transfer is planned and flown', () => {
  const { world: w, vessel: v } = S.padLaunch();
  assert.equal(v.situation, 'prelaunch');
  assert.ok(S.sunElevation(SYSTEM.home, SYSTEM.launchSite.dir, w.ut) > 0.3, 'daylight on the pad');
  let boosters = 0;
  w.on('decouple', () => boosters++);
  const c = AP.ascentProgram(w, { targetAlt: 85000, useWarp: true });
  const t = run(w, c, 2000);
  assert.ok(c.done && !c.failed, 'ascent: ' + logOf(c));
  assert.equal(v.situation, 'orbit');
  assert.ok(t < 600, 'in orbit after ' + t.toFixed(0) + ' s');
  assert.ok(boosters >= 2, 'boosters fell away');
  const plan = AP.planHohmannToMoon(w, v, SYSTEM.byId.pell);
  assert.ok(plan && plan.dv > 700 && plan.dv < 1100, 'transfer planned');
  const e = AP.executeNode(w, v, { useWarp: true });
  run(w, e, 20000);
  assert.ok(e.done && !e.failed, 'burn: ' + logOf(e));
  w.warpTo(plan.encounterUt + 600);
  run(w, null, plan.encounterUt - w.ut + 2000, () => v.body.id === 'pell');
  assert.equal(v.body.id, 'pell', 'entered Pell’s sphere of influence');
});

test('demo scene: the ascent cut is a rocket in the air that carries on to orbit after a save and load', () => {
  const sc = S.ascentScene();
  const v0 = sc.vessel;
  assert.ok(!v0.landed && v0.altitude > 1500 && v0.altitude < 30000, 'climbing at ' + v0.altitude.toFixed(0) + ' m');
  assert.ok(v0.verticalSpeed > 50, 'going up');
  assert.equal(sc.world.vessels.filter(o => o.type === 'debris').length, 0, 'no spent boosters in the picture');
  const again = S.ascentScene();
  assert.ok(Math.abs(again.vessel.altitude - v0.altitude) < 1e-6, 'the same state every time');
  // the flight screen opens it from its saved form, then the guidance resumes without firing a stage
  const w = World.fromJSON(JSON.parse(JSON.stringify(sc.world.toJSON())));
  const v = w.active, stage = v.stageIndex;
  const c = sc.resume(w);
  run(w, c, 3);
  assert.equal(v.stageIndex, stage, 'no stage was fired on resuming');
  assert.ok(v.thrust > 0, 'the core is burning');
  const t = run(w, c, 2000);
  assert.ok(c.done && !c.failed, 'ascent: ' + logOf(c));
  assert.equal(v.situation, 'orbit');
  assert.ok(t < 600);
});

test('transfer burn: the engine is off at the end even when the node is cleared under the running burn', () => {
  // the flight screen removes a node once less than 0.5 m/s of it is left, before the guidance's own cut-off; the
  // demo's map chapter then ran the clock up with the engine idling at 3 % and flew the ship out of the system
  const { world: w, vessel: v } = S.orbitScene();
  const plan = AP.planHohmannToMoon(w, v, SYSTEM.byId.pell);
  assert.ok(plan, 'transfer planned');
  const e = AP.executeNode(w, v, { useWarp: true });
  let cleared = false;
  run(w, e, 20000, () => {
    if (!cleared && e.phase === 'burn' && v.nodes[0] && v.burnVector(w.ut, new Vector3()).length() < 0.5) { v.removeNode(v.nodes[0]); cleared = true; }
    return false;
  });
  assert.ok(cleared, 'the node was cleared during the burn');
  assert.ok(e.done && !e.failed, 'burn: ' + logOf(e));
  assert.equal(v.ctrl.throttle, 0, 'throttle left at ' + v.ctrl.throttle);
  w.warpTo(plan.encounterUt + 600);
  run(w, null, plan.encounterUt - w.ut + 2000, () => v.body.id === 'pell');
  assert.equal(v.body.id, 'pell', 'the transfer still meets Pell');
});

test('demo scene: orbit cut has the same upper stage and can plan the transfer', () => {
  const { world: w, vessel: v } = S.orbitScene();
  run(w, null, 2);
  assert.equal(v.situation, 'orbit');
  assert.ok(v.deltaV > 1500, 'fuel for the transfer: ' + v.deltaV);
  assert.ok(AP.planHohmannToMoon(w, v, SYSTEM.byId.pell));
});

test('demo scene: Pell descent lands, then a Pip walks, plants a flag and takes a sample', () => {
  const { world: w, vessel: v, spot } = S.pellDescent();
  assert.ok(spot.slope < 0.15, 'flat target: ' + spot.slope);
  let boom = 0; w.on('explosion', () => boom++);
  const c = AP.hoverslamLanding(w, v, { useWarp: false });
  const t = run(w, c, 600, () => v.landed);
  run(w, null, 4);
  assert.ok(v.landed && !v.dead, 'landed: ' + logOf(c));
  assert.ok(t < 120, 'down in ' + t.toFixed(0) + ' s');
  assert.equal(boom, 0);
  const pip = w.evaStart(v);
  assert.ok(pip && pip.landed);
  const p0 = pip.pos.clone(), ax = {};
  for (let i = 0; i < 30 * 4; i++) { K.localAxes(pip, ax); const l = ax.east.clone().applyQuaternion(pip.q.clone().invert()); pip.ctrl.tx = l.x; pip.ctrl.tz = l.z; w.step(Q); }
  pip.ctrl.tx = pip.ctrl.tz = 0; run(w, null, 2);
  assert.ok(pip.pos.distanceTo(p0) > 2, 'walked');
  assert.ok(w.plantFlag(pip, 'First Steps'));
  assert.ok(w.runExperiment(pip, null, 'surface_sample'));
});

test('demo scene: Pell surface cut stands on its legs', () => {
  const { world: w, vessel: v } = S.pellSurface();
  run(w, null, 10);
  assert.ok(v.landed && !v.dead);
  assert.equal(v.situation, 'landed');
  assert.ok(w.evaStart(v));
});

test('demo scene: re-entry heats the shield; the parachute scene splashes down off the coast', () => {
  const { world: w, vessel: v } = S.reentryScene();
  assert.equal(v.parts.size, 3, 'capsule, shield and parachute');
  let peak = 0;
  run(w, null, 45, () => { peak = Math.max(peak, v.heatFlux || 0); return false; });
  assert.ok(!v.dead && peak > 40000, 'plasma: ' + peak);
  const st = S.chuteState(w);
  assert.ok(SYSTEM.home.isWater(st.dir), 'over the sea');
  assert.ok(S.sunElevation(SYSTEM.home, st.dir, w.ut) > 0.45, 'the splashdown is in daylight (sun ' + (S.sunElevation(SYSTEM.home, st.dir, w.ut) * 57.3).toFixed(0) + '° up)');
  K.teleport(w, v, SYSTEM.home, st);
  v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde';
  run(w, null, 1); w.stage();
  const t = run(w, null, 500, () => v.landed);
  assert.ok(v.landed && v.splashed && !v.dead, 'splashed down after ' + t.toFixed(0) + ' s');
  assert.ok(S.sunElevation(SYSTEM.home, st.dir, w.ut) > 0.45, 'still daylight at the splashdown');
  assert.ok(t < 260);
});

test('demo scene: the Kite Trainer takes off from the runway', () => {
  const { world: w, vessel: v } = S.runwayScene();
  run(w, null, 1);
  const c = AP.planeTakeoff(w, v, { altitude: 300 });
  const t = run(w, c, 300);
  assert.ok(c.done && !c.failed, 'take-off: ' + logOf(c));
  assert.ok(v.radarAlt > 250 && t < 60, t.toFixed(0) + ' s');
});

test('demo scene: the rover drives across Rusk', () => {
  const { world: w, vessel: v } = S.roverScene();
  assert.equal(v.body.id, 'rusk');
  assert.ok(S.sunElevation(v.body, v.surface.dir, w.ut) > 0.1, 'in daylight');
  // it is parked square on the ground under its wheels (level across a slope, the wheels of one side start buried
  // and the rover is kicked when it wakes up)
  const normal = v.body.terrainNormal(v.surface.dir, new Vector3(), 1);
  const roof = new Vector3(0, 0, 1).applyQuaternion(v.surface.qRel);
  assert.ok(Math.abs(roof.dot(normal)) > 0.9995, 'stands on the terrain normal: ' + roof.dot(normal).toFixed(5));
  run(w, null, 2);
  const n = v.parts.size;
  const c = AP.roverDrive(w, v, { distance: 110, speed: 8 });
  const t = run(w, c, 200);
  assert.ok(c.done && !c.failed, 'drive: ' + logOf(c));
  assert.ok(c.driven >= 100 && t < 60, c.driven.toFixed(0) + ' m in ' + t.toFixed(0) + ' s');
  assert.equal(v.parts.size, n, 'nothing broke');
});

test('demo scene: the chaser docks with the station core', () => {
  const { world: w, vessel: v, target } = S.dockScene();
  assert.ok(v.dockPorts.length && target.dockPorts.length && v.rcsParts.length);
  assert.ok(v.pos.distanceTo(target.pos) < 80);
  let docked = false; w.on('dock', () => { docked = true; });
  const c = AP.dockingApproach(w, v, target, {});
  const t = run(w, c, 600);
  assert.ok(docked && c.done && !c.failed, 'docking: ' + logOf(c));
  assert.ok(t < 150, t.toFixed(0) + ' s');
});

test('demo scene: the fleet for the tracking station survives a save and a day on rails', () => {
  const { world: w, vessels } = S.fleetWorld();
  assert.ok(vessels.length >= 5, 'vessels: ' + vessels.map(v => v.name).join(', '));
  const bodies = new Set(vessels.map(v => v.body.id));
  assert.ok(bodies.size >= 4, 'spread over ' + [...bodies].join(', '));
  const w2 = World.fromJSON(JSON.parse(JSON.stringify(w.toJSON())));
  assert.equal(w2.vessels.length, w.vessels.length);
  w2.active = null;
  w2.setWarp(9);
  for (let i = 0; i < 200; i++) w2.step(0.1);
  assert.equal(w2.vessels.filter(v => v.type === 'ship').length, vessels.length, 'nobody crashed or was removed');
  void Vector3;
});
