// The ship's way home (js/core/shipreturn.js, the flaps in js/core/vessel.js, docs/SHEARWATER.md): the four body
// flaps, the belly-first hold, the wind tunnel the guidance flies in before it commits, what it refuses, and the
// whole return from a 100 km orbit to the arms of the catch tower.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { TUNING } from '../../js/core/vessel.js';
import { World } from '../../js/core/world.js';
import { shearwaterShip } from '../../js/core/craft.js';
import { PARTS } from '../../js/core/parts.js';
import { SYSTEM, TOWER } from '../../js/core/bodies.js';
import { orbitState, buildScenario, checkScenario } from '../../js/core/scenarios.js';
import { shipReturn, bellyFlyer, windTunnel } from '../../js/core/autopilot.js';
import { flyHome } from '../tools/ship_return_dev.mjs';

const home = SYSTEM.home, DEG = Math.PI / 180;
/** The ship alone in a 100 km orbit with `frac` of its propellant. */
function inOrbit({ frac = 0.16, cargo = false } = {}) {
  const w = new World(), st = orbitState(home, { pe: 100000 }, w.ut);
  const v = w.spawn(shearwaterShip({ cargo }), { crew: ['Juno', 'Bram'], body: home, pos: st.pos, vel: st.vel, q: st.q });
  for (const p of v.partList) for (const k of ['lox', 'ch4']) if (p.res && p.res[k] != null) p.res[k] = p.def.res[k] * frac;
  v._updateMass(false); v.updateResources();
  if (v.stages.length && v.stageIndex === 0) v.activateNextStage();
  v.ctrl.throttle = 0; v.ctrl.rcs = true;
  w.switchTo(v);
  return { w, v };
}

test('the ship: four flaps, two catch pins, tiles on the belly parts, and the same launch mass with or without freight named', () => {
  const full = shearwaterShip(), empty = shearwaterShip({ cargo: false });
  const types = c => c.parts.map(p => p.type);
  assert.equal(types(full).filter(t => t === 'flap_fore').length, 2);
  assert.equal(types(full).filter(t => t === 'flap_aft').length, 2);
  assert.equal(types(full).filter(t => t === 'pin_catch').length, 2);
  assert.ok(types(full).includes('bay_shearwater') && types(empty).includes('bay_shearwater_empty'));
  assert.equal(PARTS.bay_shearwater.freight, 68);
  assert.ok(Math.abs(PARTS.bay_shearwater.mass - PARTS.bay_shearwater_empty.mass - 68) < 1e-9, 'the unloaded bay is the loaded one less its freight');
  for (const id of ['pod_shearwater', 'bay_shearwater', 'bay_shearwater_empty', 'flap_fore', 'flap_aft']) assert.equal(PARTS[id].tiles, true, id + ' carries tiles');
});

test('flaps: found on a ship with a lee side to fold to, rest half folded, and never leave 0 to FLAP_MAX', () => {
  const { w, v } = inOrbit();
  assert.ok(bellyFlyer(v), 'the ship is a belly flyer');
  const flaps = v.partList.filter(p => p.def.flap);
  assert.equal(flaps.length, 4);
  for (const p of flaps) assert.ok(p._flap, 'each flap has a lee side');
  v.ctrl.sas = true; v.ctrl.sasMode = 'belly';
  for (let i = 0; i < 400; i++) { w.step(0.02); for (const p of flaps) assert.ok(p.fold >= -1e-9 && p.fold <= TUNING.FLAP_MAX + 1e-9, 'fold in range: ' + p.fold); }
});

test('belly hold: in thick air the ship settles flat to the wind at the angle asked for, belly (not back) forward', () => {
  const { w, v } = inOrbit({ frac: 0.14 });
  // put it at 20 km falling at 200 m/s, already near the attitude
  const up = v.pos.clone().normalize(), east = new Vector3(0, 1, 0).cross(up).normalize();
  v.pos.copy(up).multiplyScalar(home.radius + 20000);
  v.vel.copy(east).multiplyScalar(2 * Math.PI / home.rotPeriod * (home.radius + 20000) + 60).addScaledVector(up, -190);
  v.ctrl.sas = true; v.ctrl.sasMode = 'belly'; v.bellyAoa = 70 * DEG;
  for (let i = 0; i < 1500; i++) w.step(0.02);
  const u = v.surfaceVel.clone().normalize();
  const nose = new Vector3(0, 1, 0).applyQuaternion(v.q), belly = new Vector3(0, 0, -1).applyQuaternion(v.q);
  const aoa = Math.acos(Math.max(-1, Math.min(1, nose.dot(u)))) / DEG;
  assert.ok(Math.abs(aoa - 70) < 6, 'angle to the air near 70 deg: ' + aoa.toFixed(1));
  assert.ok(belly.dot(u) > 0.8, 'the belly leads: ' + belly.dot(u).toFixed(2));
  assert.ok(v.w.length() < 0.08, 'and it is not tumbling: ' + v.w.length().toFixed(3));
  assert.ok(!v.dead);
});

test('wind tunnel: flatter means more drag and less glide, and the real ship is left untouched', () => {
  const { w, v } = inOrbit({ frac: 0.14 });
  const pos = v.pos.clone(), vel = v.vel.clone(), mass = v.mass, n = w.vessels.length;
  const t = windTunnel(w, v);
  assert.equal(t.rows.length, 3);
  assert.equal(t.rows[0].drag.length, 121);
  assert.ok(t.rows[0].drag[60] < t.rows[1].drag[60] && t.rows[1].drag[60] < t.rows[2].drag[60], 'drag area grows as the ship lies flatter');
  assert.ok(t.rows[0].ld > t.rows[1].ld && t.rows[1].ld > t.rows[2].ld, 'glide falls as it lies flatter');
  assert.ok(t.rows[0].ld > 0.4 && t.rows[0].ld < 1, 'at 50 deg it glides about 0.66: ' + t.rows[0].ld.toFixed(2));
  assert.ok(Math.abs(t.rows[2].ld) < 0.08, 'flat on, nearly none: ' + t.rows[2].ld.toFixed(2));
  assert.ok(t.rows[1].drag[60] > 150 && t.rows[1].drag[60] < 260, 'drag area at Mach 6 and 70 deg: ' + t.rows[1].drag[60].toFixed(0));
  assert.ok(v.pos.equals(pos) && v.vel.equals(vel) && v.mass === mass && w.vessels.length === n, 'the tunnel flies a copy');
});

test('the guidance refuses a ship it cannot set down: freight aboard, or too much propellant', () => {
  const site = SYSTEM.sites.tower;
  const opts = { target: site.dir, floor: TOWER.hang - 0.5, sets: { deorbit: 2, burn: 0, final: 0 } };
  for (const [what, o] of [['freight', { cargo: true, frac: 0.16 }], ['propellant', { frac: 0.35 }]]) {
    const { w, v } = inOrbit(o);
    const r = shipReturn(w, v, opts);
    r.update();
    assert.ok(r.done && r.failed, what + ': refused');
    assert.match(r.log[r.log.length - 1].msg, /too heavy to set down/);
    assert.equal(v.ctrl.throttle, 0);
  }
});

test('home from orbit: a braking burn, the fall on the flaps, the flip, and the arms close on the ship', { timeout: 600000 }, () => {
  const r = flyHome({ frac: 0.16 });
  const caught = r.events.find(e => e.type === 'caught');
  assert.ok(caught, 'caught: ' + JSON.stringify(r.events));
  assert.ok(!r.v.dead && r.v.landed && r.v.surface.held === 'tower');
  assert.ok(caught.speed < 2.5, 'gently: ' + caught.speed.toFixed(2) + ' m/s');
  assert.ok(caught.offset < 1.5, 'on the centre line: ' + caught.offset.toFixed(2) + ' m');
  assert.ok(r.gmax < 3.5, 'the crew feel under 3.5 g: ' + r.gmax.toFixed(2));
  assert.ok(r.tmax < 0.9, 'nothing near its heat limit: ' + r.tmax.toFixed(2));
  assert.ok(r.left > 1500, 'propellant to spare: ' + (r.left / 1000).toFixed(1) + ' t');
  assert.equal(r.v.partList.length, shearwaterShip({ cargo: false }).parts.length, 'nothing broke off');
  assert.ok(!r.events.some(e => e.type === 'towerStrike'), 'nothing touched the tower: the arms waited for the aft flaps to pass under them');
});

test('scenario Belly First: built unloaded with a sixth of a tank, survives a save, and the catch completes it', { timeout: 600000 }, () => {
  const b = buildScenario('belly-first');
  const w = World.fromJSON(JSON.parse(JSON.stringify(b.career.flightState))), v = w.active;
  assert.ok(bellyFlyer(v) && v.crew.length === 2);
  assert.ok(!v.partList.some(p => p.def.freight > 0), 'no freight aboard');
  assert.ok(Math.abs(v.mass - 95600) < 1500, 'about 96 t: ' + v.mass.toFixed(0));
  assert.ok(v.enginePower().thrust > 0, 'engines live');
  const ret = shipReturn(w, v, { target: SYSTEM.sites.tower.dir, floor: TOWER.hang - 0.5, sets: { deorbit: 2, burn: 0, final: 0 }, useWarp: true });
  let n = 0;
  while (n < 600000 && !ret.done && !v.dead) { ret.update(); w.step(0.02); if (++n % 500 === 0) checkScenario(b.career, w); }
  for (let i = 0; i < 250; i++) w.step(0.02);
  checkScenario(b.career, w);
  assert.ok(!ret.failed && !v.dead, 'flown home');
  assert.ok(n < 60000, 'warp skipped the quiet stretches: ' + n + ' steps');
  assert.deepEqual(b.career.scenario.done, ['air', 'catch']);
  assert.equal(b.career.scenario.complete, true);
});
