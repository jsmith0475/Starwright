import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Quaternion } from '../../js/lib/three.module.min.js';
import { Vessel, TUNING } from '../../js/core/vessel.js';
import { Craft, stockCrafts } from '../../js/core/craft.js';
import { partDef, engineThrust, engineIsp, G0 } from '../../js/core/parts.js';
import { SYSTEM } from '../../js/core/bodies.js';

const home = SYSTEM.home;
const stock = name => stockCrafts().find(c => c.name === name);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || 'value'}: ${a} vs ${b} (tol ${tol})`);

/** A vessel coasting in vacuum high above Verda, nose along +Y, ready for stand-alone simulate() calls. */
function inSpace(craft, crew = ['Ada']) {
  const v = Vessel.fromCraft(craft, { crew });
  v.body = home;
  v.pos.set(home.radius + 300000, 0, 0);
  v.vel.set(0, 0, -Math.sqrt(home.gm / (home.radius + 300000)));
  v.launched = true;
  return v;
}
function run(v, seconds, dt = 0.02, each = null) {
  const ev = [];
  let t = 0;
  for (let i = 0, n = Math.round(seconds / dt); i < n; i++) { t += dt; v.simulate(dt, t, ev); if (each && each(ev) === false) break; }
  return ev;
}
function capsule(...extra) {
  const c = new Craft('cap');
  const [pod] = c.setRoot('pod_acorn');
  let cur = pod;
  for (const t of extra) cur = c.attachStack(t, cur.id, 'bottom')[0];
  c.autoStage();
  return c;
}

test('fromCraft: mass equals craft.mass(), resources full, crew seated, links undirected', () => {
  for (const craft of stockCrafts()) {
    const v = Vessel.fromCraft(craft, { crew: ['Ada', 'Bo'] });
    near(v.mass, craft.mass(), 1e-6, craft.name + ' mass');
    assert.equal(v.parts.size, craft.parts.length);
    for (const p of v.parts.values()) {
      for (const k in p.def.res) assert.equal(p.res[k], p.def.res[k]);
      for (const id of p.links) assert.ok(v.parts.get(id).links.includes(p.id), 'link is two-way');
    }
    for (const cp of craft.parts) if (cp.parent !== null) assert.ok(v.parts.get(cp.id).links.includes(cp.parent));
    assert.deepEqual(v.stages, craft.stages);
    assert.equal(v.stageIndex, 0);
  }
  const v = Vessel.fromCraft(stock('Skylark II'), { crew: ['Ada', 'Bo'] });
  assert.deepEqual(v.crew, ['Ada']);            // one seat only
  assert.equal(v.controlPart.def.id, 'pod_acorn');
  assert.equal(v.cost, stock('Skylark II').cost());
  assert.equal(v.resources.fuel.amount, 7000);
  assert.equal(v.resources.fuel.max, 7000);
});

test('centre of mass and inertia', () => {
  const craft = stock('Skylark II');
  const v = Vessel.fromCraft(craft);
  let m = 0, cy = 0, cx = 0;
  for (const p of craft.parts) {
    const d = partDef(p.type);
    let pm = d.mass * 1000;
    for (const k in d.res) if (k !== 'elec') pm += d.res[k];
    m += pm; cy += pm * (p.pos.y + (d.comY || 0)); cx += pm * p.pos.x;   // capsules carry their mass low (def.comY)
  }
  // the interstage truss around the upper engine: its mass sits half-way up the ring
  for (const t of craft.interstages()) { m += t.mass; cy += t.mass * (t.y0 + t.y1) / 2; cx += t.mass * t.x; }
  near(v.com.y, cy / m, 1e-9, 'com.y');
  near(v.com.x, cx / m, 1e-9, 'com.x');
  near(v.com.x, 0, 1e-9); near(v.com.z, 0, 1e-9);
  assert.ok(v.inertia.x > 20 * v.inertia.y, 'a tall rocket is much harder to pitch than to roll');
  near(v.inertia.x, v.inertia.z, v.inertia.x * 0.01);
  // CoM rises as the lower tanks drain, and `pos` follows it so parts do not jump
  const s = inSpace(craft);
  const part = s.parts.get(1);
  const before = s.partWorldPos(part).clone().sub(s.pos.clone());   // offset only: orbital motion removed below
  const com0 = s.com.y;
  s.parts.get(8).res.fuel = 0; s.parts.get(9).res.fuel = 0;
  const p0 = s.partWorldPos(part).clone();
  s._updateMass(true);
  assert.ok(s.com.y > com0 + 1);
  assert.ok(s.partWorldPos(part).distanceTo(p0) < 1e-6, 'part stays put when the CoM moves');
  void before;
});

test('delta-v estimate matches Craft.stats()', () => {
  for (const craft of stockCrafts()) {
    const v = Vessel.fromCraft(craft);
    const total = craft.stats().reduce((s, x) => s + x.dvVac, 0);
    near(v.deltaV, total, 0.5, craft.name + ' dv');
  }
});

for (const name of ['Skylark II', 'Pell Runner', 'Ember Twin']) {
  test(`staging: ${name} splits correctly, masses match Craft.stats() per stage`, () => {
    const craft = stock(name);
    const stats = craft.stats();
    const v = inSpace(craft);
    v.ctrl.throttle = 1;
    const total0 = v.mass;
    let debrisMass = 0, burned = 0;
    for (let si = 0; si < craft.stages.length; si++) {
      const before = v.mass;
      const ev = v.activateNextStage();
      assert.equal(ev[0].type, 'stage');
      assert.equal(ev[0].stage, si);
      const debris = ev.filter(e => e.type === 'decouple').map(e => e.debris);
      const stageDecs = craft.stages[si].filter(id => partDef(craft.getPart(id).type).decoupler);
      assert.equal(debris.length, stageDecs.length, 'one debris piece per decoupler');
      let dropped = 0;
      for (const d of debris) {
        dropped += d.mass;
        assert.equal(d.type, 'debris');
        assert.ok([...d.parts.values()].some(p => p.def.decoupler), 'debris carries the decoupler');
        assert.ok(!d.parts.has(v.controlId));
        for (const id of d.parts.keys()) assert.ok(!v.parts.has(id));
        // separation impulse pushes the pieces apart, momentum is conserved
        assert.ok(d.vel.distanceTo(v.vel) > 0.1);
      }
      debrisMass += dropped;
      near(v.mass + dropped, before, 1e-6, 'mass conserved by the split');
      near(v.mass, stats[si].startMass, 3, `stage ${si} start mass`);   // ±3 kg: flameout lands inside a 0.02 s step
      // burn the stage out at full throttle
      if (stats[si].burnTime > 0) {
        const m0 = v.mass;
        let t = 0;
        const ev2 = [];
        const nextDrop = v.dropSet(v.stages[v.stageIndex] || []);
        for (let i = 0; i < 40000; i++) {
          t += 0.02; v.simulate(0.02, t, ev2);
          const eng = [...v.parts.values()].filter(p => p.def.engine && p.ignited);
          const doomed = eng.filter(p => nextDrop.has(p.id));
          if (doomed.length ? doomed.every(p => p.flameout) : eng.every(p => p.flameout)) break;
        }
        near(v.mass, stats[si].endMass, 3, `stage ${si} end mass`);
        near(t, stats[si].burnTime, 0.1, `stage ${si} burn time`);
        burned += m0 - v.mass;
        assert.ok(ev2.some(e => e.type === 'flameout'));
      }
    }
    assert.equal(v.stageIndex, v.stages.length);
    near(v.mass + debrisMass + burned, total0, 1e-3, 'total mass accounted for');
    // what is left is the capsule with its shield and (armed) parachute
    assert.deepEqual([...v.parts.values()].map(p => p.def.id).sort(), ['chute', 'heatshield_m', 'pod_acorn']);
    assert.equal(v.parts.get(2).deployed, 'armed');
    assert.deepEqual(v.activateNextStage(), []);
  });
}

test('staging: radial boosters leave sideways, stack stages along the axis', () => {
  const v = inSpace(stock('Ember Twin'));
  v.activateNextStage();
  const ev = v.activateNextStage();
  const debris = ev.filter(e => e.type === 'decouple').map(e => e.debris);
  assert.equal(debris.length, 2);
  for (const d of debris) {
    assert.deepEqual([...d.parts.values()].map(p => p.def.id).sort(), ['dec_radial', 'nose_m', 'srb_ember']);
    const rel = d.vel.clone().sub(v.vel).applyQuaternion(v.q.clone().invert());
    assert.ok(Math.abs(rel.y) < 0.2 * Math.hypot(rel.x, rel.z), 'booster pushed sideways');
    const side = d.com.clone().sub(v.com);
    assert.ok(rel.x * side.x + rel.z * side.z > 0, 'booster pushed outward');
  }
  const ev2 = v.activateNextStage();
  const lower = ev2.find(e => e.type === 'decouple').debris;
  const rel = lower.vel.clone().sub(v.vel).applyQuaternion(v.q.clone().invert());
  assert.ok(rel.y < -0.5, 'lower stage pushed backwards');
  assert.ok(Math.hypot(rel.x, rel.z) < 0.3);
});

test('fuel drains per section, evenly from the tanks of the section', () => {
  const v = inSpace(stock('Skylark II'));
  v.ctrl.throttle = 1;
  v.activateNextStage();
  run(v, 10);
  const up = v.parts.get(5), t8 = v.parts.get(8), t9 = v.parts.get(9);
  assert.equal(up.res.fuel, 2000, 'upper-stage tank is behind a decoupler: untouched');
  const kestrel = partDef('eng_goshawk');
  const burned = kestrel.engine.thrust * 1000 / (kestrel.engine.ispVac * G0) * 10;
  near((4000 - t8.res.fuel) + (1000 - t9.res.fuel), burned, 0.01, 'propellant used');
  near(4000 - t8.res.fuel, 1000 - t9.res.fuel, 1e-6, 'even draw');
  // solids burn their own grain and ignore the throttle
  const h = inSpace(stock('Hopper I'));
  h.ctrl.throttle = 0;
  h.activateNextStage();
  run(h, 5);
  const srb = partDef('srb_ember');
  near(3400 - h.parts.get(3).res.solid, srb.engine.thrust * 1000 / (srb.engine.ispVac * G0) * 5, 0.01, 'solid burned');
  assert.ok(h.thrust > 0);
  // a liquid engine at zero throttle burns nothing
  const z = inSpace(stock('Skylark II'));
  z.activateNextStage();
  run(z, 2);
  assert.equal(z.updateResources().fuel.amount, 7000);
  assert.equal(z.thrust, 0);
  // half throttle = half the flow
  z.ctrl.throttle = 0.5;
  run(z, 4);
  near(7000 - z.updateResources().fuel.amount, kestrel.engine.thrust * 1000 / (kestrel.engine.ispVac * G0) * 2, 0.01, 'half throttle');
});

test('thrust and isp follow ambient pressure', () => {
  const kestrel = partDef('eng_goshawk');
  // vacuum
  const v = inSpace(stock('Skylark II'));
  v.ctrl.throttle = 1;
  v.activateNextStage();
  run(v, 0.1);
  near(v.thrust, 220000, 1e-6, 'vacuum thrust');
  near(v.isp, 305, 1e-6, 'vacuum isp');
  // sea level: on the surface
  const s = Vessel.fromCraft(stock('Skylark II'));
  s.body = home;
  s.pos.set(home.radius + 10, 0, 0);
  s.vel.set(0, 0, -(2 * Math.PI / home.rotPeriod) * (home.radius + 10));
  s.q.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(1, 0, 0));
  s.launched = true;
  s.ctrl.throttle = 1;
  s.activateNextStage();
  run(s, 0.1);
  const p = home.pressureAtm(s.pos.length() - home.radius);
  near(s.thrust, engineThrust(kestrel, p), 30, 'sea-level thrust');
  near(s.isp, engineIsp(kestrel, p), 0.05, 'sea-level isp');
  assert.ok(s.thrust < 195000 && s.thrust > 188000);
  near(s.maxThrust, s.thrust, 1e-6);
  // acceleration = thrust / mass (minus gravity)
  const a = inSpace(capsule('tank_m100', 'eng_sparrow'));
  a.ctrl.throttle = 1; a.activateNextStage();
  const v0 = a.vel.clone(), m0 = a.mass;
  run(a, 1);
  const g = home.gm / a.pos.lengthSq();
  const dv = a.vel.clone().sub(v0);
  near(dv.y, 65000 / m0, 65000 / m0 * 0.01, 'dv along the nose');
  near(dv.x, -g, 0.05, 'gravity');
  near(a.gForce, 65000 / a.mass / G0, 0.01, 'g-force');
});

test('control sign conventions: pitch, yaw, roll', () => {
  const dirs = {};
  for (const axis of ['pitch', 'yaw', 'roll']) {
    for (const sign of [1, -1]) {
      const v = inSpace(capsule());
      v.ctrl[axis] = sign;
      run(v, 0.5);
      dirs[axis + sign] = { w: v.w.clone(), nose: new Vector3(0, 1, 0).applyQuaternion(v.q), act: v.actuation.clone() };
    }
  }
  // pitch > 0: rotation about +X local, nose swings toward +Z local (the vessel starts aligned with the world axes)
  assert.ok(dirs.pitch1.w.x > 0.1 && Math.abs(dirs.pitch1.w.y) < 1e-9 && Math.abs(dirs.pitch1.w.z) < 1e-9);
  assert.ok(dirs.pitch1.nose.z > 0.05);
  assert.ok(dirs['pitch-1'].w.x < -0.1 && dirs['pitch-1'].nose.z < -0.05);
  // yaw > 0: rotation about −Z local, nose swings toward +X local
  assert.ok(dirs.yaw1.w.z < -0.1 && Math.abs(dirs.yaw1.w.x) < 1e-9);
  assert.ok(dirs.yaw1.nose.x > 0.05);
  assert.ok(dirs['yaw-1'].w.z > 0.1 && dirs['yaw-1'].nose.x < -0.05);
  // roll > 0: rotation about +Y local (clockwise seen from behind); the nose does not move
  assert.ok(dirs.roll1.w.y > 0.1 && Math.abs(dirs.roll1.w.x) < 1e-9);
  near(dirs.roll1.nose.y, 1, 1e-9);
  assert.ok(dirs['roll-1'].w.y < -0.1);
  assert.ok(dirs.pitch1.act.distanceTo(new Vector3(1, 0, 0)) < 1e-12);
  assert.ok(dirs.yaw1.act.distanceTo(new Vector3(0, 0, -1)) < 1e-12);
  assert.ok(dirs.roll1.act.distanceTo(new Vector3(0, 1, 0)) < 1e-12);
});

test('reaction wheels need electric charge; probe cores need charge to control anything', () => {
  const v = inSpace(capsule());
  v.ctrl.pitch = 1;
  run(v, 1);
  const e0 = v._total('elec');
  near(50 - e0, TUNING.WHEEL_EC * 5 * (1 / 3) * 1, 1e-6, '0.02 EC/s per kN·m, one axis of three');
  for (const p of v.parts.values()) if (p.res.elec !== undefined) p.res.elec = 0;
  const w0 = v.w.x;
  run(v, 1);
  near(v.w.x, w0, 1e-9, 'no charge, no torque');
  assert.ok(v.controllable, 'a crewed pod is still under control');
  // probe
  const c = new Craft('probe');
  const [core] = c.setRoot('probe_wisp');
  c.attachStack('battery', core.id, 'bottom');
  const p = inSpace(c, []);
  p.ctrl.yaw = 1;
  run(p, 10);
  assert.ok(p.controllable);
  assert.ok(Math.abs(p.w.z) > 0.01);
  near(430 - p._total('elec'), 0.03 * 10 + TUNING.WHEEL_EC * 1.5 / 3 * 10, 0.05, 'probe drain + wheel use');
  for (const q of p.parts.values()) if (q.res.elec !== undefined) q.res.elec = 0;
  const wz = p.w.z;
  run(p, 2);
  assert.equal(p.controllable, false);
  near(p.w.z, wz, 1e-9, 'dead probe does not respond');
  // an empty crew capsule cannot be flown either
  const empty = inSpace(capsule(), []);
  empty.ctrl.pitch = 1;
  run(empty, 1);
  assert.equal(empty.controllable, false);
  assert.equal(empty.w.x, 0);
});

test('engine gimbal and control fins add authority; RCS turns and translates on monopropellant', () => {
  // gimbal: far more pitch authority under thrust than from the wheels alone
  const a = inSpace(stock('Skylark II'));
  a.ctrl.pitch = 1;
  run(a, 1);
  const wheelsOnly = a.w.x;
  const b = inSpace(stock('Skylark II'));
  b.ctrl.throttle = 1; b.activateNextStage();
  b.ctrl.pitch = 1;
  run(b, 1);
  assert.ok(b.w.x > 5 * wheelsOnly, `gimbal ${b.w.x} vs wheels ${wheelsOnly}`);
  // RCS
  const c = new Craft('rcs');
  const [pod] = c.setRoot('pod_acorn');
  const [tank] = c.attachStack('tank_mono', pod.id, 'bottom');
  const [t2] = c.attachStack('tank_m400', tank.id, 'bottom');
  c.attachRadial('rcs', t2.id, t2.pos.y - 1.5, 0, 4);
  const r = inSpace(c);
  for (const p of r.parts.values()) if (p.res.elec !== undefined) p.res.elec = 0;   // no wheels
  r.ctrl.pitch = 1;
  run(r, 1);
  assert.equal(r.w.x, 0, 'RCS off');
  r.ctrl.rcs = true;
  const mono0 = r._total('mono');
  run(r, 1);
  assert.ok(r.w.x > 0.01, 'RCS turns the vessel');
  assert.ok(r._total('mono') < mono0);
  r.ctrl.pitch = 0; r.w.set(0, 0, 0); r.q.identity();
  const v0 = r.vel.clone(), m1 = r._total('mono');
  r.ctrl.tz = 1;
  const mass = r.mass;
  run(r, 2);
  const dv = r.vel.clone().sub(v0).applyQuaternion(r.q.clone().invert());
  near(dv.z, 2 * 4000 / mass, 0.1, 'translation along +Z local (gravity acts along X here)');
  near(m1 - r._total('mono'), 4000 / (240 * G0) * 2, 0.01, 'mono flow');
});

test('SAS: holds attitude, damps rotation and tracks prograde / a custom direction', () => {
  const v = inSpace(stock('Skylark II'));
  const q0 = v.q.clone();
  v.w.set(0.05, 0.1, -0.04);
  v.ctrl.sas = true;
  run(v, 40);
  assert.ok(v.w.length() < 1e-3, 'rotation damped: ' + v.w.length());
  assert.ok(v.q.angleTo(q0) < 0.01, 'attitude held: ' + v.q.angleTo(q0));
  // manual input overrides, then SAS holds the new attitude
  v.ctrl.pitch = 1; run(v, 4); v.ctrl.pitch = 0;
  run(v, 30);
  assert.ok(v.q.angleTo(q0) > 0.05);
  assert.ok(v.w.length() < 2e-3);
  // prograde
  v.ctrl.sasMode = 'prograde';
  run(v, 90);
  const nose = () => new Vector3(0, 1, 0).applyQuaternion(v.q);
  assert.ok(nose().angleTo(v.vel) < 0.02, 'prograde: ' + nose().angleTo(v.vel));
  v.ctrl.sasMode = 'retrograde';
  run(v, 120);
  assert.ok(nose().angleTo(v.vel.clone().negate()) < 0.02, 'retrograde');
  v.ctrl.sasMode = 'radialOut';
  run(v, 90);
  assert.ok(nose().angleTo(v.pos) < 0.03, 'radial out');
  v.ctrl.sasMode = 'normal';
  run(v, 90);
  assert.ok(nose().angleTo(new Vector3().crossVectors(v.pos, v.vel)) < 0.02, 'normal');
  v.ctrl.sasMode = 'direction';
  v.sasDir.set(0.3, -0.5, 0.8).normalize();
  run(v, 120);
  assert.ok(nose().angleTo(v.sasDir) < 0.01, 'custom direction');
  // SAS off: free rotation is conserved
  v.ctrl.sas = false; v.w.set(0, 0.2, 0);
  run(v, 5);
  near(v.w.y, 0.2, 1e-9);
});

test('maneuver nodes: burn vector, SAS maneuver mode and delivered delta-v bookkeeping', () => {
  const v = inSpace(capsule('tank_m200', 'eng_sparrow'));
  v.activateNextStage();
  const node = v.addNode(60, { prograde: 200 });
  const bv = v.burnVector(0);
  near(bv.length(), 200, 1e-6);
  assert.ok(bv.angleTo(v.getOrbit(0).stateAt(60).v) < 1e-6, 'prograde node points along the velocity at the node');
  v.ctrl.sas = true; v.ctrl.sasMode = 'maneuver';
  v.updateGuidance(0, null);
  let t = 0;
  const ev = [];
  const step = n => { for (let i = 0; i < n; i++) { t += 0.02; v.simulate(0.02, t, ev); if (i % 5 === 0) v.updateGuidance(t, null); } };
  step(2800);   // 56 s: aligned by now
  assert.ok(new Vector3(0, 1, 0).applyQuaternion(v.q).angleTo(v.burnVector(t)) < 0.02);
  v.ctrl.throttle = 1;
  step(100);    // 2 s of burn
  v.updateGuidance(t, null);
  const acc = 65000 / v.mass;
  assert.ok(node.rem, 'burn vector frozen once the burn starts');
  near(v.nodeDv, 200 - 2 * acc, 1.5, 'remaining dv');
  v.removeNode(node);
  assert.equal(v.nodes.length, 0);
});

test('destroyParts: explosions, crew loss, splitting and loss of control', () => {
  const v = inSpace(stock('Skylark II'));
  const ev = [];
  v.destroyParts([5], ev, 'test');     // the upper tank: the stack falls into two pieces
  assert.equal(ev.filter(e => e.type === 'explosion').length, 1);
  assert.equal(ev.find(e => e.type === 'explosion').partName, 'Canister M-400');
  const debris = ev.filter(e => e.type === 'decouple').map(e => e.debris);
  assert.equal(debris.length, 1);
  assert.ok(v.parts.has(1) && !v.parts.has(10) && debris[0].parts.has(10));
  assert.equal(v.type, 'ship');
  near(v.mass + debris[0].mass + 2250, stock('Skylark II').mass(), 1e-6);
  const ev2 = [];
  v.destroyParts([1], ev2, 'test');    // the capsule
  assert.deepEqual(ev2.filter(e => e.type === 'crewLost').map(e => e.name), ['Ada']);
  assert.ok(ev2.some(e => e.type === 'destroyed' && e.vessel === v));
  assert.equal(v.type, 'debris');
  const ev3 = [];
  v.destroyParts([...v.parts.keys()], ev3, 'test');
  assert.ok(v.dead);
});

test('toggles: legs, solar panels; panels charge only when deployed and sunlit', () => {
  const v = inSpace(stock('Pell Runner'));
  assert.equal(v.legsDown, false);
  const low0 = v._minY;
  // drop to the lander stage so the legs are the lowest thing
  v.activateNextStage(); v.activateNextStage(); v.activateNextStage();
  const stowed = v._minY;
  assert.equal(v.toggleLegs(), true);
  assert.ok(v.legsDown);
  assert.ok(v._minY < stowed - 0.1, 'deployed feet reach below the engine bell');
  assert.ok(v._baseR > 1.4, 'wide stance');
  void low0;
  for (const p of v.parts.values()) if (p.res.elec !== undefined) p.res.elec *= 0.5;
  const e0 = v._total('elec');
  v.ctrl.sas = false;
  run(v, 5);
  near(v._total('elec'), e0, 1e-9, 'stowed panels make nothing');
  v.setSolar(true);
  run(v, 5);
  near(v._total('elec') - e0, 2 * 1.6 * 5, 1e-6, 'two panels × 1.6 EC/s');
  v.sunlit = false;
  const e1 = v._total('elec');
  run(v, 5);
  near(v._total('elec'), e1, 1e-9, 'no light, no charge');
});

test('EVA pip: jetpack translation burns evafuel', () => {
  const pip = Vessel.makePip('Ada');
  pip.body = home; pip.pos.set(home.radius + 300000, 0, 0); pip.vel.set(0, 0, -2000);
  assert.equal(pip.type, 'eva');
  near(pip.mass, 95, 1e-9);
  const v0 = pip.vel.clone();
  pip.ctrl.sas = false;
  pip.ctrl.tz = 1;
  run(pip, 2);
  assert.ok(pip.controllable);
  const dv = pip.vel.clone().sub(v0);
  near(dv.z, 2 * TUNING.EVA_THRUST / 95, 0.05, 'jetpack acceleration');
  near(5 - pip._total('evafuel'), TUNING.EVA_THRUST / TUNING.EVA_VE * 2, 1e-6, 'evafuel flow');
});

test('JSON round trip reproduces the vessel and its future', () => {
  const a = inSpace(stock('Ember Twin'));
  a.ctrl.throttle = 0.8; a.ctrl.sas = true; a.ctrl.yaw = 0.2;
  a.activateNextStage();
  a.addNode(500, { prograde: 10, normal: -2 });
  a.science.push({ experiment: 'crew_report', bodyId: 'verda', situation: 'spaceLow' });
  run(a, 20);
  a.ctrl.yaw = 0;
  const json = JSON.parse(JSON.stringify(a.toJSON()));
  const b = Vessel.fromJSON(json);
  assert.deepEqual(JSON.parse(JSON.stringify(b.toJSON())), json);
  near(b.mass, a.mass, 1e-9);
  assert.ok(b.com.distanceTo(a.com) < 1e-12);
  assert.equal(b.parts.get(13).ignited, true);
  assert.equal(b.body, home);
  // both continue identically (through booster burnout and staging)
  for (const v of [a, b]) {
    const ev = [];
    let t = 20;
    for (let i = 0; i < 1500; i++) { t += 0.02; v.simulate(0.02, t, ev); if (i === 700) v.activateNextStage(ev); }
  }
  assert.ok(a.pos.distanceTo(b.pos) < 1e-6, 'positions agree: ' + a.pos.distanceTo(b.pos));
  assert.ok(a.vel.distanceTo(b.vel) < 1e-9);
  assert.ok(a.q.angleTo(b.q) < 1e-9);
  near(a.mass, b.mass, 1e-9);
  assert.equal(a.parts.size, b.parts.size);
});

test('transferCrew moves a Pip to a free seat in another part, and refuses a full or missing one', async () => {
  const { World } = await import('../../js/core/world.js');
  const { Craft } = await import('../../js/core/craft.js');
  const c = new Craft('Two Pods');
  const [a] = c.setRoot('pod_acorn');
  const [b] = c.attachStack('pod_acorn', a.id, 'bottom');
  c.autoStage();
  const w = new World();
  const v = w.launch(c, { crew: ['Ada'] });
  const from = v.partList.find(p => p.crew.includes('Ada')), to = v.partList.find(p => p !== from && p.def.crew);
  assert.ok(from && to, 'two crewed parts');
  assert.equal(v.transferCrew('Ada', to.id), true);
  assert.deepEqual(to.crew, ['Ada']); assert.deepEqual(from.crew, []);
  assert.deepEqual(v.crew, ['Ada']);
  assert.equal(v.transferCrew('Ada', to.id), false, 'already there');
  assert.equal(v.transferCrew('Nobody', from.id), false);
  assert.equal(v.transferCrew('Ada', 'no-such-part'), false);
});
