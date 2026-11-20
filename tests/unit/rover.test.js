// Rovers away from home. The wheel model used to be built for Verda's gravity alone: on a small moon the motors
// stood the rover on its tail, the springs were rigid and the chassis was a drum that struck every crest. These
// tests drive a kilometre on five low-gravity worlds, hold the stick forward, and pin each cause down by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { World } from '../../js/core/world.js';
import { stockCrafts } from '../../js/core/craft.js';
import { TUNING, wheelGravityScale, roverCruiseSpeed } from '../../js/core/vessel.js';
import * as AP from '../../js/core/autopilot.js';
import { SCENARIO_UT, sunward, driveRoute, placeLanded } from '../../js/core/scenarios.js';
import * as DemoScenes from '../../js/ui/demo/scenes.js';

const WORLDS = ['pell', 'ost', 'rusk', 'tiv', 'cindra'];
const scout = () => { const c = stockCrafts().find(x => x.name === 'Trundle Scout'); assert.ok(c, 'the stock rover exists'); return c.clone ? c.clone() : c; };
const upright = v => new Vector3(0, 0, 1).applyQuaternion(v.q).dot(v.pos.clone().normalize());
const logOf = c => c.log.map(l => l.msg).join(' | ');
function parked(id, { length = 1000 } = {}) {
  const b = SYSTEM.byId[id], w = new World({ ut: SCENARIO_UT });
  const near = b.inertialToSurfaceDir(sunward(b, w.ut), w.ut, new Vector3());
  const route = driveRoute(b, near, { length });
  const v = placeLanded(w, scout(), b, route.dir, { vehicle: true, heading: route.heading });
  return { b, w, v, route };
}

test('the gravity scale of a wheel: 1 at home, in proportion below, never zero', () => {
  assert.equal(wheelGravityScale(SYSTEM.home.surfaceG), 1);
  assert.equal(wheelGravityScale(SYSTEM.byId.murk.surfaceG) > 0.85, true);
  assert.ok(Math.abs(wheelGravityScale(1.6) - 1.6 / TUNING.WHEEL_G_REF) < 1e-12);
  assert.ok(wheelGravityScale(0) > 0);
  assert.equal(roverCruiseSpeed(SYSTEM.home, 8), 8);
  for (const id of WORLDS) { const s = roverCruiseSpeed(SYSTEM.byId[id], 8); assert.ok(s >= 1.2 && s < 8, id + ' cruises at ' + s.toFixed(1) + ' m/s'); }
});

test('the rover chassis is a flat tub: its belly clears the ground by more than the suspension travel', () => {
  const { v } = parked('pell', { length: 100 });
  const tyres = Math.min(...v.wheelParts.map(p => p._wz));
  const hull = v._pts.filter(c => c.p.def.shape === 'rover_body');
  assert.ok(hull.length >= 8, hull.length + ' hull points');
  const belly = Math.min(...hull.map(c => c.z));
  const travel = Math.max(...v.wheelParts.map(p => p._travel));
  assert.ok(belly - tyres > travel + 0.1, `belly ${(belly - tyres).toFixed(2)} m above the tyres, travel ${travel.toFixed(2)} m`);
  const wide = Math.max(...hull.map(c => Math.abs(c.x)));
  assert.ok(wide > 0.5 && wide < 0.62, 'as wide as it is drawn: ' + wide.toFixed(2));
});

for (const id of WORLDS) {
  test(`a rover drives a kilometre on ${SYSTEM.byId[id].name} (g ${SYSTEM.byId[id].surfaceG.toFixed(1)} m/s²)`, () => {
    const { b, w, v, route } = parked(id);
    assert.ok(route.slope < 0.45, 'a drivable route: worst grade ' + route.slope.toFixed(2));
    const parts = v.parts.size, cruise = roverCruiseSpeed(b, 8);
    const ctl = AP.roverDrive(w, v, { distance: 1000, speed: 8, heading: route.heading });
    let top = 0, low = 1, off = 0, n = 0;
    AP.fly(w, ctl, { dt: 1 / 30, physWarp: 0, maxSim: 1500, onStep() { n++; top = Math.max(top, v.groundSpeed); if (!v.landed) { low = Math.min(low, upright(v)); if (v.wheelsOnGround < 2) off++; } } });
    assert.ok(ctl.done && !ctl.failed, 'the drive: ' + logOf(ctl));
    assert.ok(ctl.driven >= 1000, ctl.driven.toFixed(0) + ' m');
    assert.equal(v.parts.size, parts, 'nothing broke');
    assert.ok(low > 0.6, 'never near going over: least uprightness ' + low.toFixed(2));
    assert.ok(upright(v) > 0.9, 'ends on its wheels');
    assert.ok(top < cruise * 1.5 + 0.5, `top speed ${top.toFixed(1)} m/s for a ${cruise.toFixed(1)} m/s cruise`);
    assert.ok(off / n < 0.2, 'on its wheels nearly all the way: ' + (100 * off / n).toFixed(0) + '% of the time off them');
    console.log(`#   ${b.name}: 1 km in ${(w.ut - SCENARIO_UT).toFixed(0)} s, top ${top.toFixed(1)} m/s, worst grade ${route.slope.toFixed(2)}, least uprightness ${low.toFixed(2)}`);
  });
}

test('full power from rest does not stand a rover on its tail on Ost, Pell or Tiv', () => {
  for (const id of ['ost', 'pell', 'tiv']) {
    const { w, v } = parked(id);
    v.ctrl.brake = false; v.ctrl.sas = false;
    let nose = 0, front = 6;
    AP.fly(w, null, { dt: 1 / 30, physWarp: 0, maxSim: 6, onStep() { v.ctrl.drive = 1; const y = new Vector3(0, 1, 0).applyQuaternion(v.q).dot(v.pos.clone().normalize()); nose = Math.max(nose, y); if (w.ut - SCENARIO_UT > 1 && w.ut - SCENARIO_UT < 4) front = Math.min(front, v.wheelsOnGround); } });
    assert.ok(nose < 0.3, id + ': nose never above ' + (Math.asin(nose) * 57.3).toFixed(0) + '°');
    assert.ok(front >= 4, id + ': at least four wheels down throughout (' + front + ')');
    assert.ok(v.groundSpeed > 0.3, id + ': and it moves, ' + v.groundSpeed.toFixed(2) + ' m/s');
  }
});

test('holding the stick forward for a minute (SAS on) keeps a rover on its wheels on gentle ground', () => {
  for (const id of ['pell', 'ost', 'tiv', 'cindra']) {
    const { b, w, v } = parked(id);
    v.ctrl.brake = false; v.ctrl.sas = true;
    let low = 1, top = 0;
    AP.fly(w, null, { dt: 1 / 30, physWarp: 0, maxSim: 60, onStep() { v.ctrl.drive = 1; low = Math.min(low, upright(v)); top = Math.max(top, v.groundSpeed); } });
    const vmax = 18 * Math.pow(wheelGravityScale(b.surfaceG), 0.75);
    assert.ok(low > 0.5, `${id}: least uprightness ${low.toFixed(2)}`);
    assert.ok(top <= vmax * 1.25 + 0.5, `${id}: governed to about ${vmax.toFixed(1)} m/s (reached ${top.toFixed(1)})`);
    assert.ok(top > 1, id + ': it does get going');
  }
});

test('the cruise control stops short of ground no rover can hold, instead of driving onto it', () => {
  // straight at the steepest thing nearby: it must end stopped, upright and whole, whatever it says
  const b = SYSTEM.byId.rusk, w = new World({ ut: SCENARIO_UT });
  const near = b.inertialToSurfaceDir(sunward(b, w.ut), w.ut, new Vector3());
  const v = placeLanded(w, scout(), b, driveRoute(b, near, { length: 60 }).dir, { vehicle: true, heading: 90 });
  let seen = 0;
  for (const heading of [0, 90, 180, 270]) {
    const ctl = AP.roverDrive(w, v, { distance: 600, speed: 8, heading });
    AP.fly(w, ctl, { dt: 1 / 30, physWarp: 0, maxSim: 600 });
    assert.ok(ctl.done, 'ends: ' + logOf(ctl));
    assert.ok(upright(v) > 0.7 && !v.dead, `heading ${heading}: upright (${upright(v).toFixed(2)}) after "${ctl.log[ctl.log.length - 1].msg}"`);
    if (ctl.failed && /too steep/.test(logOf(ctl))) seen++;
    v.ctrl.brake = true;
  }
  console.log('#   stopped for a grade on ' + seen + ' of 4 headings');
});

test('the demo tour\'s rover on Rusk keeps going well past the tour\'s 115 m', () => {
  const { world: w, vessel: v } = DemoScenes.roverScene();
  assert.equal(v.body.id, 'rusk');
  const parts = v.parts.size;
  const ctl = AP.roverDrive(w, v, { distance: 1000, speed: 8 });
  AP.fly(w, ctl, { dt: 1 / 30, physWarp: 0, maxSim: 900 });
  assert.ok(ctl.done, logOf(ctl));
  assert.ok(ctl.driven > 400, 'drove ' + ctl.driven.toFixed(0) + ' m: ' + logOf(ctl));
  assert.ok(upright(v) > 0.8 && v.parts.size === parts, 'upright and whole at the end');
  console.log('#   ' + ctl.driven.toFixed(0) + ' m: ' + ctl.log[ctl.log.length - 1].msg);
});

test('asking for the warp limit every frame (the HUD does) does not park a rover that has just been told to drive', () => {
  // at 60 frames a second the question arrives in the first instant of the drive, when the rover is slower than a
  // parked one and its wheels have not taken the weight yet: it used to be pinned there as a non-vehicle, for good
  const scene = DemoScenes.roverScene();
  const w = World.fromJSON(JSON.parse(JSON.stringify(scene.world.toJSON()))), v = w.active;
  for (let i = 0; i < 6; i++) { w.step(1 / 60); w.maxWarpIndex(); }
  const c = AP.roverDrive(w, v, { distance: 60, speed: 8 });
  const t0 = w.ut;
  while (w.ut - t0 < 40 && !c.done) { c.update(1 / 60); w.step(1 / 60); w.maxWarpIndex(); }
  assert.ok(c.done && !c.failed, 'the drive finished: ' + logOf(c));
  assert.ok(c.driven > 55, `drove ${c.driven.toFixed(1)} m`);
  // and once it has stopped with the brake on, the same question parks it as before
  for (let i = 0; i < 600 && !v.landed; i++) { w.step(1 / 60); w.maxWarpIndex(); }
  assert.ok(v.landed, 'parked after the drive');
});
