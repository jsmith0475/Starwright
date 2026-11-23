import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Quaternion } from '../../js/lib/three.module.min.js';
import { World, WARP_RATES, railMinAltitude, MAX_SUBSTEPS } from '../../js/core/world.js';
import { Vessel, TUNING } from '../../js/core/vessel.js';
import { Craft, stockCrafts } from '../../js/core/craft.js';
import { Orbit } from '../../js/core/orbit.js';
import { SYSTEM } from '../../js/core/bodies.js';

const home = SYSTEM.home, pell = SYSTEM.byId.pell;
const stock = name => stockCrafts().find(c => c.name === name);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || 'value'}: ${a} vs ${b} (tol ${tol})`);
const Y = new Vector3(0, 1, 0);

function capsule({ chute = true, shield = false, extra = [] } = {}) {
  const c = new Craft('Test Capsule');
  const [pod] = c.setRoot('pod_acorn');
  if (chute) c.attachStack('chute', pod.id, 'top');
  let cur = pod;
  if (shield) cur = c.attachStack('heatshield_m', cur.id, 'bottom')[0];
  for (const t of extra) cur = c.attachStack(t, cur.id, 'bottom')[0];
  c.autoStage();
  return c;
}
/** Spawn in an orbit given by apsis altitudes; starts at periapsis (or true anomaly `nu`). */
function inOrbit(w, craft, apAlt, peAlt, { body = home, nu = 0, crew = ['Ada'], makeActive = true } = {}) {
  const ra = body.radius + apAlt, rp = body.radius + peAlt;
  const o = Orbit.fromElements({ a: (ra + rp) / 2, e: (ra - rp) / (ra + rp) }, body.gm, w.ut);
  const t = nu ? o.timeAtTrueAnomaly(nu, w.ut) : w.ut;
  const s = o.stateAt(t);
  const o2 = Orbit.fromState(s.r, s.v, body.gm, w.ut);
  const v = w.spawn(craft, { crew, body, pos: s.r, vel: s.v, makeActive });
  return { v, orbit: o2 };
}
/** Spawn hovering (zero surface speed) `alt` metres above a body-fixed direction, nose up. */
function above(w, craft, dirBF, alt, body = home) {
  const up = body.surfaceDirToInertial(dirBF, w.ut).normalize();
  const pos = up.clone().multiplyScalar(body.radius + alt);
  const wy = 2 * Math.PI / body.rotPeriod;
  const vel = new Vector3(wy * pos.z, 0, -wy * pos.x);
  const q = new Quaternion().setFromAxisAngle(Y, body.rotationAngle(w.ut)).multiply(World.padFrame(dirBF));
  return w.spawn(craft, { crew: ['Ada'], body, pos, vel, q });
}
function record(w) {
  const log = [];
  w.on('*', (d, type) => log.push({ type, ut: w.ut, ...d }));
  log.types = () => log.map(e => e.type);
  log.of = t => log.filter(e => e.type === t);
  return log;
}
function waterDir() {
  for (let lat = -0.6; lat <= 0.6; lat += 0.1) for (let lon = 0.3; lon < 6; lon += 0.1) {
    const d = home.dirFromLatLon(lat, lon);
    if (home.biomeAt(d).id === 'deepwater') return d;
  }
  throw new Error('no ocean found');
}


test('launch: pad placement, orientation and surface rotation', () => {
  const w = new World();
  const v = w.launch(stock('Skylark II'), { crew: ['Ada'] });
  assert.equal(w.active, v);
  assert.equal(v.situation, 'prelaunch');
  assert.ok(v.landed && !v.splashed);
  assert.equal(v.body, home);
  near(v.radarAlt, 0, 1e-6, 'lowest point on the ground');
  near(v.altitude, v.com.y - stock('Skylark II').bounds().minY, 1e-6, 'CoM altitude = height of the CoM above the lowest point');
  // position: over the launch site
  const dir = home.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut);
  assert.ok(dir.distanceTo(SYSTEM.launchSite.dir) < 1e-9);
  // orientation: X→east, Y→up, Z→south
  const up = v.pos.clone().normalize();
  const east = new Vector3().crossVectors(Y, up).normalize();
  const north = new Vector3().crossVectors(up, east);
  const ax = k => new Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0).applyQuaternion(v.q);
  assert.ok(ax(1).distanceTo(up) < 1e-9, 'nose up');
  assert.ok(ax(0).distanceTo(east) < 1e-9, 'local X east');
  assert.ok(ax(2).distanceTo(north.clone().negate()) < 1e-9, 'local Z south');
  // velocity = ω × r ≈ 203 m/s eastward
  near(v.vel.dot(east), 2 * Math.PI * v.pos.length() / home.rotPeriod, 1e-6, 'eastward speed');
  near(v.vel.length(), 203.1, 0.2);
  near(v.airspeed, 0, 1e-9);
  // stays put relative to the ground for 60 s
  const p0 = home.inertialToSurfaceDir(v.pos, w.ut).clone();
  for (let i = 0; i < 600; i++) w.step(0.1);
  near(w.ut, 60, 1e-6);
  const p1 = home.inertialToSurfaceDir(v.pos, w.ut);
  assert.ok(p1.distanceTo(p0) < 1e-6, 'pinned to the rotating surface');
  assert.ok(v.pos.distanceTo(home.surfaceDirToInertial(SYSTEM.launchSite.dir, 0).multiplyScalar(v.pos.length())) > 10000, 'moved with the planet');
  near(v.airspeed, 0, 1e-9);
  assert.equal(v.situation, 'prelaunch');
  near(v.gForce, 9.6 / 9.80665, 0.01, 'weight on the pad');
  // engines on but too weak to lift: stays landed; full thrust: liftoff event
  const log = record(w);
  v.ctrl.throttle = 0.3;
  w.stage();
  for (let i = 0; i < 20; i++) w.step(0.05);
  assert.ok(v.landed, 'TWR < 1 stays on the pad');
  assert.ok(v.resources.fuel.amount < 7000, 'but burns propellant');
  v.ctrl.throttle = 1;
  for (let i = 0; i < 40; i++) w.step(0.05);
  assert.ok(!v.landed);
  assert.equal(log.of('liftoff').length, 1);
  assert.deepEqual(log.of('situation').map(e => e.to), ['flying']);
  assert.ok(v.verticalSpeed > 1 && v.altitude > 9);
});

test('coasting orbit conserves energy: apsides drift < 100 m over 3 orbits at 1× and at physics warp', () => {
  for (const mode of ['1x', 'warp4']) {
    const w = new World();
    const { v, orbit } = inOrbit(w, capsule(), 150000, 100000);
    const ap0 = orbit.apoapsis, pe0 = orbit.periapsis, T = orbit.period;
    if (mode === 'warp4') assert.equal(w.setWarp(3), 3);
    const dt = mode === '1x' ? 0.02 : 0.1;
    const steps = Math.round(3 * T / (dt * w.rate));
    let maxSub = 0;
    for (let i = 0; i < steps; i++) { w.step(dt); maxSub = Math.max(maxSub, w.substeps); }
    near(w.ut, 3 * T, 1, 'elapsed');
    const o = v.getOrbit(w.ut);
    near(o.apoapsis, ap0, 100, mode + ' apoapsis drift');
    near(o.periapsis, pe0, 100, mode + ' periapsis drift');
    near(v.apoapsis, 150000, 100); near(v.periapsis, 100000, 100);
    // and it is where Kepler says it should be (within a few hundred metres after 3 orbits)
    assert.ok(v.pos.distanceTo(orbit.posAt(w.ut)) < (mode === '1x' ? 200 : 2000), 'position vs Kepler: ' + v.pos.distanceTo(orbit.posAt(w.ut)));
    assert.equal(v.situation, 'orbit');
    assert.equal(v.onRails, false);
    if (mode === 'warp4') assert.equal(maxSub, 4, 'vacuum coasting uses 0.1 s sub-steps');
  }
});

test('rails warp matches analytic Kepler propagation exactly; warpTo stops on the dot', () => {
  const w = new World();
  const { v, orbit } = inOrbit(w, capsule(), 900000, 400000);
  const log = record(w);
  assert.equal(w.setWarp(8), 8);
  for (let i = 0; i < 50; i++) w.step(0.1);
  near(w.ut, 5000, 1e-6);
  assert.ok(v.onRails);
  const s = orbit.stateAt(w.ut);
  assert.ok(v.pos.distanceTo(s.r) < 1e-3, 'rails position ' + v.pos.distanceTo(s.r));
  assert.ok(v.vel.distanceTo(s.v) < 1e-6);
  assert.equal(w.setWarp(0), 0);
  w.step(0.02);
  assert.equal(v.onRails, false);
  assert.ok(v.pos.distanceTo(orbit.posAt(w.ut)) < 0.01, 'seamless hand-over to physics');
  // warpTo
  const target = w.ut + 123456.789;
  assert.ok(w.warpTo(target));
  let n = 0;
  while (w.warpTarget !== null && n++ < 10000) { w.step(0.25); assert.ok(w.ut <= target + 1e-6, 'never overshoots'); }
  near(w.ut, target, 1e-6, 'warpTo lands on the target time');
  assert.equal(w.warpIndex, 0);
  assert.ok(n < 400, 'and gets there quickly (' + n + ' steps)');
  assert.ok(v.pos.distanceTo(orbit.posAt(w.ut)) < 1, 'still on the same orbit: ' + v.pos.distanceTo(orbit.posAt(w.ut)));
  const warps = log.of('warp');
  assert.equal(warps[warps.length - 1].reason, 'warpTo');
  assert.equal(warps[warps.length - 1].rate, 1);
  assert.ok(warps.some(e => e.rate >= 1000));
  assert.equal(w.warpTo(w.ut - 5), false);
});

test('warp limits: atmosphere, thrust, altitude, landed; sub-step cap', () => {
  assert.deepEqual([...WARP_RATES], [1, 2, 3, 4, 5, 10, 50, 100, 1000, 10000, 100000]);
  // on the pad: rails warp allowed
  let w = new World();
  let v = w.launch(stock('Skylark II'), { crew: ['Ada'] });
  assert.equal(w.maxWarpIndex(), 10);
  assert.equal(w.setWarp(10), 10);
  w.step(0.1);
  near(w.ut, 10000, 1e-6);
  assert.ok(v.landed);
  assert.ok(home.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut).distanceTo(SYSTEM.launchSite.dir) < 1e-9, 'still on the pad after half a day');
  // under thrust: physics warp only
  w.setWarp(0);
  v.ctrl.throttle = 1; w.stage();
  assert.equal(w.maxWarpIndex(), 3);
  assert.equal(w.setWarp(7), 3);
  for (let i = 0; i < 100; i++) w.step(0.05);
  assert.ok(v.altitude > 300, 'flew 20 s in 5 s of wall time');
  // in the atmosphere, engine off: still physics warp only
  v.ctrl.throttle = 0;
  w.step(0.05);
  assert.equal(w.setWarp(6), 3);
  // altitude limits in orbit
  w = new World();
  ({ v } = inOrbit(w, capsule({ extra: ['tank_m100', 'eng_sparrow'] }), 80000, 80000));
  assert.equal(w.maxWarpIndex(), 6, '80 km: up to 50×');
  assert.equal(w.setWarp(10), 6);
  assert.equal(w.rate, 50);
  w.step(1);
  near(w.ut, 50, 1e-6);
  for (let i = 4; i <= 10; i++) assert.ok(railMinAltitude(home, i) >= railMinAltitude(home, i - 1), 'higher warp needs more altitude');
  assert.equal(railMinAltitude(home, 4), 72000);
  assert.ok(railMinAltitude(pell, 4) > 1000 && railMinAltitude(pell, 4) < 10000);
  // throttle up while on rails → drops to physics warp with a reason
  const log = record(w);
  w.stage();
  v.ctrl.throttle = 1;
  w.setWarp(6);
  assert.equal(w.warpIndex, 3);
  w.step(0.1);
  assert.ok(v.thrust > 0);
  assert.equal(v.onRails, false);
  assert.ok(log.of('message').length >= 1, 'the player is told why');
  // high orbit: everything allowed
  const w2 = new World();
  inOrbit(w2, capsule(), 3e6, 3e6);
  assert.equal(w2.maxWarpIndex(), 10);
  // sub-step cap: one call never does more than MAX_SUBSTEPS physics steps
  const w3 = new World();
  inOrbit(w3, capsule(), 200000, 200000);
  w3.setWarp(3);
  w3.step(1000);
  assert.ok(w3.substeps <= MAX_SUBSTEPS);
  assert.ok(w3.ut <= MAX_SUBSTEPS * TUNING.DT_COAST + 1e-6, 'effective rate degrades instead of the step size');
  const w4 = new World();
  const v4 = w4.launch(stock('Skylark II'));
  v4.ctrl.throttle = 1; w4.stage();
  w4.setWarp(3);
  w4.step(100);
  assert.ok(w4.substeps <= MAX_SUBSTEPS);
  near(w4.ut, MAX_SUBSTEPS * TUNING.DT_MAX, 1e-6, 'dt stays 0.02 s under thrust');
});

test('rails warp drops out before atmosphere entry, before impact, at SOI changes and at maneuver nodes', () => {
  // atmosphere
  let w = new World();
  let { v } = inOrbit(w, capsule(), 400000, 30000, { nu: Math.PI });
  let log = record(w);
  w.setWarp(8);
  assert.ok(w.warpIndex >= 6);
  for (let i = 0; i < 2000 && w.warpIndex > 0; i++) w.step(0.1);
  assert.equal(w.warpIndex, 0);
  assert.equal(log.of('warp').pop().reason, 'atmosphere');
  assert.ok(v.altitude > home.atmo.height && v.altitude < home.atmo.height + 20000, 'stopped just above the atmosphere: ' + v.altitude);
  assert.ok(v.verticalSpeed < 0);
  assert.equal(w.setWarp(8), 3, 'cannot rails-warp into the air');
  for (let i = 0; i < 400 && v.situation !== 'flying'; i++) w.step(0.1);
  assert.equal(v.situation, 'flying');
  assert.ok(!v.dead);
  // impact on an airless body
  w = new World();
  ({ v } = inOrbit(w, capsule(), 400000, -150000, { body: pell, nu: Math.PI }));
  log = record(w);
  w.setWarp(7);
  for (let i = 0; i < 5000 && w.warpIndex > 0; i++) w.step(0.1);
  assert.equal(log.of('warp').pop().reason, 'impact');
  assert.equal(w.warpIndex, 0);
  assert.ok(v.altitude > 3000 && v.altitude < 30000 && !v.dead, 'still above ground: ' + v.altitude);
  // a shallow descent runs into the altitude limit first; that also ends at 1×
  w = new World();
  ({ v } = inOrbit(w, capsule(), 100000, -5000, { body: pell, nu: Math.PI }));
  log = record(w);
  w.setWarp(7);
  for (let i = 0; i < 5000 && w.warpIndex > 0; i++) w.step(0.1);
  assert.ok(['altitude', 'impact'].includes(log.of('warp').pop().reason));
  assert.ok(v.altitude > 1000 && !v.dead, 'still above ground: ' + v.altitude);
  // maneuver node
  w = new World();
  ({ v } = inOrbit(w, capsule({ extra: ['tank_m100', 'eng_sparrow'] }), 500000, 500000));
  w.stage();
  const node = v.addNode(w.ut + 20000, { prograde: 100 });
  log = record(w);
  w.setWarp(9);
  for (let i = 0; i < 5000 && w.warpIndex > 0; i++) w.step(0.1);
  assert.equal(log.of('warp').pop().reason, 'node');
  assert.ok(w.ut < node.t - 15 && w.ut > node.t - 120, 'stops shortly before the node: ' + (node.t - w.ut));
  w.setWarp(9);
  for (let i = 0; i < 5000 && w.warpIndex > 0; i++) w.step(0.1);
  near(w.ut, node.t, 1e-6, 'a second warp never passes the node');
  w.setWarp(5);
  w.step(1);
  assert.ok(w.ut > node.t + 5, 'after the node nothing holds the warp');
});

test('SOI transitions: global position and velocity are continuous into Pell\'s SOI and out again', () => {
  const g = (w, v) => ({ p: v.body.globalPosAt(w.ut).add(v.pos), v: v.body.globalVelAt(w.ut).add(v.vel) });
  // --- physics mode: approach the edge of the SOI at 400 m/s
  const w = new World({ ut: 5000 });
  const pp = pell.posAt(w.ut), pv = pell.velAt(w.ut);
  const out = pp.clone().normalize();
  const pos = pp.clone().addScaledVector(out, -(pell.soi + 2000));   // between Verda and Pell, just outside
  const vel = pv.clone().addScaledVector(out, 400).add(new Vector3(0, 0, 0).crossVectors(Y, out).multiplyScalar(250));
  const v = w.spawn(capsule(), { crew: ['Ada'], pos, vel });
  const log = record(w);
  let prev = g(w, v), jumped = 0;
  for (let i = 0; i < 1500 && v.body !== pell; i++) {
    w.step(0.02);
    const cur = g(w, v);
    const expect = prev.p.clone().addScaledVector(prev.v, 0.02);
    jumped = Math.max(jumped, cur.p.distanceTo(expect));
    assert.ok(cur.v.distanceTo(prev.v) < 0.05, 'velocity continuous: ' + cur.v.distanceTo(prev.v));
    prev = cur;
  }
  assert.equal(v.body, pell);
  assert.ok(jumped < 0.01, 'position continuous through the frame change: ' + jumped);
  assert.equal(log.of('soi').length, 1);
  assert.equal(log.of('soi')[0].from, home);
  assert.equal(log.of('soi')[0].to, pell);
  assert.ok(Math.abs(v.pos.length() - pell.soi) < 50);
  assert.equal(v.situation, 'escape', 'a flyby');
  // --- rails: fly through and out the other side
  const inbound = v.getOrbit(w.ut).clone();
  assert.ok(inbound.hyper);
  w.setWarp(8);
  for (let i = 0; i < 5000 && v.body === pell; i++) { w.step(0.1); if (w.warpIndex === 0 && v.body === pell) w.setWarp(8); }
  assert.equal(v.body, home);
  const soi = log.of('soi');
  assert.equal(soi.length, 2);
  assert.equal(soi[1].from, pell); assert.equal(soi[1].to, home);
  assert.equal(log.of('warp').pop().reason, 'soi', 'warp drops at the SOI change');
  assert.equal(w.warpIndex, 0);
  const tx = soi[1].ut;
  near(w.ut, tx, 1e-6);
  const before = inbound.stateAt(tx);
  near(before.r.length(), pell.soi, 5, 'left at the SOI radius');
  const expectP = pell.posAt(tx).add(before.r), expectV = pell.velAt(tx).add(before.v);
  assert.ok(v.pos.distanceTo(expectP) < 0.01, 'exit position continuous: ' + v.pos.distanceTo(expectP));
  assert.ok(v.vel.distanceTo(expectV) < 1e-6, 'exit velocity continuous');
  // --- rails entry agrees with the physics entry
  const w2 = new World({ ut: 5000 });
  const far = pp.clone().addScaledVector(out, -(pell.soi + 400000));
  const v2 = w2.spawn(capsule(), { crew: ['Bo'], pos: far, vel });
  const o2 = Orbit.fromState(far, vel, home.gm, w2.ut);
  const log2 = record(w2);
  w2.setWarp(8);
  for (let i = 0; i < 100 && v2.body !== pell; i++) w2.step(0.05);
  assert.equal(v2.body, pell);
  const te = log2.of('soi')[0].ut;
  const s = o2.stateAt(te);
  assert.ok(v2.pos.distanceTo(s.r.clone().sub(pell.posAt(te))) < 0.01, 'entry position continuous');
  assert.ok(v2.vel.distanceTo(s.v.clone().sub(pell.velAt(te))) < 1e-6, 'entry velocity continuous');
  near(v2.pos.length(), pell.soi, 5);
});

test('parachute descent: terminal velocity 5–8 m/s, safe landing and splashdown', () => {
  for (const where of ['land', 'water']) {
    const w = new World();
    const dir = where === 'land' ? SYSTEM.launchSite.dir : waterDir();
    const v = above(w, capsule({ shield: true }), dir, 4000);   // 1.2 t: capsule, heat shield, parachute
    const log = record(w);
    assert.equal(v.parts.get(2).deployed, 'stowed');
    w.stage();
    assert.equal(v.parts.get(2).deployed, 'armed');
    w.setWarp(3);
    let vt = null, maxG = 0, semiSpeed = null;
    for (let i = 0; i < 20000 && !v.landed && !v.dead; i++) {
      w.step(0.025);
      if (v.radarAlt < 300 && v.radarAlt > 50) vt = v.airspeed;
      if (v.parts.get(2).deployed === 'semi' && v.radarAlt > 1500) semiSpeed = v.airspeed;
      if (!v.grounded) maxG = Math.max(maxG, v.gForce);   // the opening shock, not the bump of touchdown (a one-step sample of a stiff contact)
    }
    assert.ok(v.landed && !v.dead);
    assert.ok(vt >= 5 && vt <= 8, `terminal velocity under the canopy: ${vt}`);
    assert.ok(semiSpeed > 20 && semiSpeed < 80, 'reefed canopy descends faster: ' + semiSpeed);
    assert.ok(maxG < 12, 'opening shock is survivable: ' + maxG);
    assert.deepEqual(log.of('chute').map(e => e.state), ['armed', 'semi', 'full']);
    const ev = log.of(where === 'land' ? 'landed' : 'splashed');
    assert.equal(ev.length, 1);
    assert.ok(ev[0].speed >= 5 && ev[0].speed <= 8);
    assert.equal(v.situation, where === 'land' ? 'landed' : 'splashed');
    assert.equal(v.splashed, where === 'water');
    assert.equal(log.of('explosion').length, 0);
    assert.deepEqual(v.crew, ['Ada']);
    assert.equal(v.parts.get(2).deployed, 'cut');
    for (let i = 0; i < 100; i++) w.step(0.1);
    near(v.radarAlt, 0, 1e-6);
    near(v.airspeed, 0, 1e-9);
    const nose = new Vector3(0, 1, 0).applyQuaternion(v.q);
    // second pass: on land it stands on its heat shield; at sea it floats (a capsule this light bobs over onto its flank)
    if (where === 'land') assert.ok(nose.angleTo(v.pos) < 0.01, 'settles upright');
    else assert.ok(Math.abs(v.altitude - home.seaLevel) < 1.0, 'floats at the surface: ' + (v.altitude - home.seaLevel));
  }
});

test('terminal velocity and drag sanity', () => {
  // a capsule falling heat-shield first without a parachute
  const w = new World();
  const v = above(w, capsule({ chute: false }), SYSTEM.launchSite.dir, 9000);
  v.q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3));   // start tilted: it must right itself
  w.setWarp(3);
  let at = null;
  for (let i = 0; i < 20000 && v.altitude > 3000; i++) w.step(0.025);
  w.setWarp(0);
  const s0 = v.airspeed, t0 = w.ut;
  for (let i = 0; i < 50; i++) w.step(0.02);
  at = { speed: 0.5 * (s0 + v.airspeed), alt: v.altitude, acc: (v.airspeed - s0) / (w.ut - t0) };
  // drag = weight − m·dv/dt  →  measured drag area
  const cdA = Math.PI * 0.625 ** 2 * 0.9 + TUNING.BASE_DRAG * Math.PI * 0.625 ** 2 * 0.35;
  const measured = 2 * v.mass * (9.6 - at.acc) / (home.density(at.alt) * at.speed ** 2);
  near(measured, cdA, cdA * 0.06, 'drag area of a capsule falling blunt end first');
  const vt = Math.sqrt(2 * v.mass * 9.6 / (home.density(at.alt) * cdA));
  assert.ok(at.speed > vt && at.speed < vt * 1.25, `near terminal velocity (${vt.toFixed(0)} m/s): ${at.speed.toFixed(0)}`);
  near(v.dynamicPressure, 0.5 * home.density(v.altitude) * v.airspeed ** 2, 1, 'dynamic pressure');
  near(v.mach, v.airspeed / TUNING.SOUND_SPEED, 1e-9);
  const tail = new Vector3(0, -1, 0).applyQuaternion(v.q);
  assert.ok(tail.angleTo(v.surfaceVel) < 0.35, 'blunt end first: ' + tail.angleTo(v.surfaceVel));
  // drag is dissipative: a coasting rocket loses energy in the air and none in vacuum
  const w2 = new World();
  const r = above(w2, stock('Hopper I'), SYSTEM.launchSite.dir, 20000);
  r.vel.addScaledVector(r.pos.clone().normalize(), 800);
  const e0 = 0.5 * r.vel.lengthSq() - home.gm / r.pos.length();
  for (let i = 0; i < 500; i++) w2.step(0.02);
  const e1 = 0.5 * r.vel.lengthSq() - home.gm / r.pos.length();
  assert.ok(e1 < e0 - 100, 'drag removes energy');
  // fins keep a rocket pointed into the airflow without SAS
  r.ctrl.sas = false;
  const noseErr = () => new Vector3(0, 1, 0).applyQuaternion(r.q).angleTo(r.surfaceVel);
  assert.ok(noseErr() < 0.1, 'weathervanes: ' + noseErr());
});

test('impact: above tolerance destroys, weak parts crumple first', () => {
  // free fall from 3 km without a parachute: everything goes
  let w = new World();
  let v = above(w, capsule({ chute: false }), SYSTEM.launchSite.dir, 3000);
  let log = record(w);
  w.setWarp(3);
  for (let i = 0; i < 20000 && !v.landed && !v.dead; i++) w.step(0.025);
  assert.ok(v.dead);
  assert.equal(log.of('landed').length, 0);
  assert.equal(log.of('explosion')[0].partName, 'Acorn Capsule');
  assert.equal(log.of('explosion')[0].body, home);
  assert.ok(log.of('explosion')[0].pos.length() > home.radius - 10);
  assert.deepEqual(log.of('crewLost').map(e => e.name), ['Ada']);
  assert.equal(log.of('destroyed')[0].reason, 'crash');
  assert.equal(w.vessels.length, 0);
  assert.ok(w.active.dead, 'the UI can see that the active vessel is gone');
  w.step(0.1);   // stepping with a dead active vessel is harmless
  // 10 m/s touchdown on an engine bell (tolerance 7): the engine is lost, the rest survives
  w = new World();
  v = above(w, capsule({ chute: false, extra: ['tank_m100', 'eng_sparrow'] }), SYSTEM.launchSite.dir, 8);
  log = record(w);
  for (let i = 0; i < 2000 && !v.landed && !v.dead; i++) w.step(0.02);
  assert.ok(v.landed && !v.dead);
  assert.deepEqual(log.of('explosion').map(e => e.partName), ['Sparrow Vacuum Engine']);
  assert.deepEqual(v.crew, ['Ada']);
  assert.ok(v.parts.size === 2);
  // a gentle 3 m/s touchdown harms nothing
  w = new World();
  v = above(w, capsule({ chute: false, extra: ['tank_m100', 'eng_sparrow'] }), SYSTEM.launchSite.dir, 2.2);
  log = record(w);
  for (let i = 0; i < 2000 && !v.landed; i++) w.step(0.02);
  assert.equal(log.of('explosion').length, 0);
  assert.ok(log.of('landed')[0].speed > 2 && log.of('landed')[0].speed < 4);
  assert.equal(v.parts.size, 3);
});

function reentry({ shield, apAlt, peAlt }) {
  const w = new World();
  const { v } = inOrbit(w, capsule({ shield }), apAlt, peAlt, { nu: -0.6 });
  // jump to just above the atmosphere on the way down
  const o = v.getOrbit(w.ut);
  const t = o.timeAtTrueAnomaly(-o.trueAnomalyAtRadius(home.radius + home.atmo.height + 1000), w.ut);
  const s = o.stateAt(t);
  w.ut = t; v.pos.copy(s.r); v.vel.copy(s.v);
  v.q.setFromUnitVectors(Y, s.v.clone().normalize().negate());
  v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde';
  const log = record(w);
  w.stage();
  w.step(0.02);
  const out = { v, w, log, entrySpeed: v.orbitalSpeed, maxTemp: 0, maxG: 0, maxFlux: 0 };
  w.setWarp(3);
  for (let i = 0; i < 40000 && !v.landed && !v.dead; i++) {
    w.step(0.05);
    if (v.parts.get(1)) out.maxTemp = Math.max(out.maxTemp, v.parts.get(1).temp);
    out.maxG = Math.max(out.maxG, v.gForce); out.maxFlux = Math.max(out.maxFlux, v.heatFlux);
  }
  return out;
}

test('re-entry heating: bare capsule survives a shallow return from low orbit', () => {
  const r = reentry({ shield: false, apAlt: 80000, peAlt: 35000 });
  near(r.entrySpeed, 2325, 30, 'entry speed');
  assert.ok(!r.v.dead && r.v.landed, 'landed');
  assert.deepEqual(r.v.crew, ['Ada']);
  assert.equal(r.log.of('explosion').length, 0);
  assert.ok(r.maxTemp > 900 && r.maxTemp < 0.85 * 2000, `capsule got hot but not too hot: ${r.maxTemp.toFixed(0)} K`);
  assert.ok(r.maxFlux > 3e4 && r.maxFlux < 1e5, 'peak flux ' + r.maxFlux);
  assert.ok(r.maxG < 13, 'peak g ' + r.maxG);
});

test('re-entry heating: a 3200 m/s return destroys a bare capsule, a heat shield saves it', () => {
  const bare = reentry({ shield: false, apAlt: 1.25e7 - home.radius, peAlt: 35000 });
  near(bare.entrySpeed, 3230, 40, 'entry speed');
  assert.ok(bare.v.dead, 'burned up');
  assert.equal(bare.log.of('explosion')[0].partName, 'Acorn Capsule');
  assert.equal(bare.log.of('destroyed')[0].reason, 'overheat');
  assert.deepEqual(bare.log.of('crewLost').map(e => e.name), ['Ada']);
  const safe = reentry({ shield: true, apAlt: 1.25e7 - home.radius, peAlt: 35000 });
  assert.ok(!safe.v.dead && safe.v.landed, 'shielded capsule lands');
  assert.equal(safe.log.of('explosion').length, 0);
  assert.ok(safe.maxTemp < 1000, 'capsule stays cool behind the shield: ' + safe.maxTemp);
  const abl = safe.v.parts.get(3).res.ablator;
  assert.ok(abl < 160 && abl > 20, 'ablator consumed: ' + abl);
  assert.deepEqual(safe.v.crew, ['Ada']);
  assert.ok(safe.maxFlux > bare.maxFlux * 0.9);
});

test('debris: full physics nearby, removed once unloaded in the atmosphere; rails debris dies at entry', () => {
  const w = new World();
  const v = w.launch(stock('Skylark II'), { crew: ['Ada'] });
  const log = record(w);
  v.ctrl.throttle = 1;
  w.stage();
  w.setWarp(3);
  for (let i = 0; i < 4000 && !v.parts.get(10).flameout; i++) w.step(0.05);
  w.stage();
  assert.equal(w.vessels.length, 2);
  const debris = log.of('decouple')[0].debris;
  assert.equal(debris.type, 'debris');
  assert.ok(debris.id > v.id && w.vessels.includes(debris));
  for (let i = 0; i < 20; i++) w.step(0.05);
  assert.equal(debris.onRails, false, 'near the active vessel: simulated');
  assert.equal(w.vessels.length, 3, 'half a second on, the separator ring has left the spent stage as a piece of its own');
  assert.ok(debris.pos.distanceTo(v.pos) > 5, 'drifting apart');
  for (let i = 0; i < 2000 && w.vessels.length > 1; i++) w.step(0.05);
  assert.equal(w.vessels.length, 1, 'debris removed');
  const d = log.of('destroyed');
  assert.equal(d.length, 2, 'the stage and the ring');
  assert.ok(d.some(x => x.vessel === debris));
  for (const x of d) assert.equal(x.reason, 'atmosphere');
  assert.ok(debris.dead);
  assert.ok(debris.pos.distanceTo(v.pos) >= 2500);
  assert.equal(log.of('crewLost').length, 0);
  // --- a crewed vessel left on a suborbital path far away: rides rails, lost when it meets the air
  const w2 = new World();
  const a = inOrbit(w2, capsule(), 300000, 300000).v;
  const b = inOrbit(w2, capsule(), 250000, 20000, { nu: Math.PI, crew: ['Bo'], makeActive: false });
  const log2 = record(w2);
  assert.equal(w2.active, a);
  for (let i = 0; i < 50; i++) w2.step(0.1);
  assert.ok(b.v.onRails && !a.onRails);
  assert.ok(b.v.pos.distanceTo(b.orbit.posAt(w2.ut)) < 1e-3, 'unloaded vessel follows its Kepler orbit');
  assert.equal(b.v.situation, 'suborbital');
  w2.setWarp(6);
  for (let i = 0; i < 400 && w2.vessels.length > 1; i++) w2.step(0.2);
  assert.equal(w2.vessels.length, 1);
  assert.deepEqual(log2.of('crewLost').map(e => e.name), ['Bo']);
  assert.equal(log2.of('destroyed')[0].reason, 'atmosphere');
  assert.ok(Math.abs(b.v.pos.length() - home.radius - home.atmo.height) < 2000, 'lost at the top of the atmosphere');
});

test('EVA: start, jetpack, board; walking, flag and jump on the ground', () => {
  // --- in orbit
  const w = new World();
  const { v } = inOrbit(w, capsule(), 200000, 200000);
  const log = record(w);
  v.ctrl.sas = true;
  for (let i = 0; i < 20; i++) w.step(0.05);
  assert.equal(w.evaStart(v, 2), null, 'no crew in the parachute');
  const pip = w.evaStart(v, 1);
  assert.ok(pip instanceof Vessel);
  assert.equal(pip.type, 'eva');
  assert.equal(pip.name, 'Ada');
  assert.equal(w.active, pip);
  assert.deepEqual(v.crew, []);
  assert.equal(log.of('eva')[0].eva, pip);
  assert.equal(log.of('eva')[0].vessel, v);
  assert.ok(pip.pos.distanceTo(v.pos) < 3 && pip.pos.distanceTo(v.pos) > 1);
  assert.ok(pip.vel.distanceTo(v.vel) < 1e-9);
  w.step(0.05);
  assert.equal(pip.situation, 'orbit');
  assert.ok(pip.controllable);
  assert.equal(v.controllable, false, 'nobody left to fly the capsule');
  // jet away along local +X, then fail to board from afar
  pip.ctrl.tx = 1;
  for (let i = 0; i < 60; i++) w.step(0.05);
  pip.ctrl.tx = 0;
  assert.ok(pip.resources.evafuel.amount < 5);
  for (let i = 0; i < 60; i++) w.step(0.05);
  const far = pip.pos.distanceTo(v.pos);
  assert.ok(far > 6, 'drifted away: ' + far);
  assert.equal(v.onRails, false, 'the capsule stays loaded next to the Pip');
  assert.equal(w.evaBoard(pip, v), false, 'too far to board');
  // come back
  pip.ctrl.tx = -1;
  for (let i = 0; i < 400 && pip.pos.distanceTo(v.pos) > 2.5; i++) w.step(0.05);
  pip.ctrl.tx = 0;
  assert.ok(pip.pos.distanceTo(v.pos) <= 3);
  const rep = w.runExperiment(pip, 1);
  assert.equal(rep.experiment, 'eva_report');
  assert.equal(w.evaBoard(pip, v), true);
  assert.deepEqual(v.crew, ['Ada']);
  assert.equal(w.active, v);
  assert.equal(w.vessels.length, 1);
  assert.equal(log.of('board')[0].name, 'Ada');
  assert.deepEqual(v.science.map(r => r.experiment), ['eva_report'], 'EVA data comes aboard');
  w.step(0.05);
  assert.ok(v.controllable);
  // --- on the ground
  const g = new World();
  const pod = g.launch(capsule(), { crew: ['Bo'] });
  const glog = record(g);
  const bo = g.evaStart(pod);
  assert.ok(bo.landed);
  assert.equal(bo.situation, 'landed');
  near(bo.radarAlt, 0, 1e-6);
  assert.ok(bo.pos.distanceTo(pod.pos) < 4);
  assert.equal(g.plantFlag(pod, 'nope'), null);
  const start = bo.surface.dir.clone();
  bo.ctrl.tz = 1;
  for (let i = 0; i < 100; i++) g.step(0.1);
  bo.ctrl.tz = 0;
  near(start.angleTo(bo.surface.dir) * home.radius, 15, 0.2, 'walks 1.5 m/s');
  near(bo.radarAlt, 0, 1e-6);
  assert.equal(g.evaBoard(bo, pod), false, 'walked too far away');
  const flag = g.plantFlag(bo, 'First Steps');
  assert.equal(g.flags.length, 1);
  assert.equal(flag.name, 'First Steps'); assert.equal(flag.bodyId, 'verda');
  near(Math.hypot(flag.dir.x, flag.dir.y, flag.dir.z), 1, 1e-9);
  assert.ok(new Vector3(flag.dir.x, flag.dir.y, flag.dir.z).angleTo(SYSTEM.launchSite.dir) * home.radius < 30);
  assert.equal(glog.of('flag')[0].flag, flag);
  // jump
  bo.ctrl.ty = 1; g.step(0.02); bo.ctrl.ty = 0;
  assert.equal(bo.landed, false);
  let top = 0;
  for (let i = 0; i < 100; i++) { g.step(0.02); top = Math.max(top, bo.radarAlt); }
  assert.ok(top > 0.1 && top < 1, 'small hop: ' + top);
  assert.ok(bo.landed && !bo.dead, 'and lands again');
  // walk back and board
  bo.ctrl.tz = -1;
  for (let i = 0; i < 200 && bo.pos.distanceTo(pod.pos) > 2.5; i++) g.step(0.1);
  bo.ctrl.tz = 0;
  assert.equal(g.evaBoard(bo, pod), true);
  assert.deepEqual(pod.crew, ['Bo']);
});

test('science records and recovery', () => {
  const w = new World();
  const c = capsule();
  c.attachRadial('sci_thermo', 1, 0, 0, 1);
  const v = w.launch(c, { crew: ['Ada'] });
  const log = record(w);
  const thermoId = [...v.parts.values()].find(p => p.def.id === 'sci_thermo').id;
  const r1 = w.runExperiment(v, 1);
  assert.equal(r1.experiment, 'crew_report'); assert.equal(r1.bodyId, 'verda'); assert.equal(r1.situation, 'landed');
  const r2 = w.runExperiment(v, thermoId);
  assert.equal(r2.experiment, 'temperature');
  assert.equal(w.runExperiment(v, 1), r1, 'one record per experiment + situation');
  assert.equal(v.science.length, 2);
  assert.equal(w.runExperiment(v, 2), null, 'a parachute is not an instrument');
  assert.equal(log.of('science').length, 2);
  // a different situation gives a new record
  const w2 = new World();
  const o = inOrbit(w2, c, 100000, 100000).v;
  const r3 = w2.runExperiment(o, 1);
  assert.equal(r3.situation, 'spaceLow');
  assert.equal(w2.recover(o), null, 'cannot recover from orbit');
  const p = inOrbit(w2, c, 30000, 30000, { body: pell }).v;
  assert.equal(w2.runExperiment(p, 1).bodyId, 'pell');
  // recovery on the pad
  const sum = w.recover(v);
  assert.equal(sum.partsCost, c.cost());
  near(sum.distance, 0, 1, 'on the pad');
  assert.deepEqual(sum.crew, ['Ada']);
  assert.equal(sum.bodyId, 'verda');
  assert.deepEqual(sum.science.map(r => r.experiment), ['crew_report', 'temperature']);
  assert.equal(w.vessels.length, 0);
  assert.equal(w.active, null);
  assert.equal(log.of('recovered')[0].summary, sum);
  assert.equal(w.recover(v), null);
  w.step(0.1);
  // distance from the pad is measured along the surface
  const w3 = new World();
  const far = above(w3, capsule(), home.dirFromLatLon(0, 0.01), 300);
  w3.stage(); w3.setWarp(3);
  for (let i = 0; i < 4000 && !far.landed; i++) w3.step(0.05);
  near(w3.recover(far).distance, 0.01 * home.radius, 60, 'surface distance');
});

test('solar panels: sunlit on the day side, dark behind the planet', () => {
  const w = new World();
  const sun = home.globalPosAt(0).negate().normalize();     // direction to the star
  const c = stock('Pell Runner');
  const r = home.radius + 200000, sp = Math.sqrt(home.gm / r);
  const side = new Vector3().crossVectors(Y, sun).normalize();
  const day = w.spawn(c, { pos: sun.clone().multiplyScalar(r), vel: side.clone().multiplyScalar(sp) });
  day.setSolar(true);
  for (const p of day.parts.values()) if (p.res.elec !== undefined) p.res.elec = 0;
  day.ctrl.sas = false;
  for (let i = 0; i < 100; i++) w.step(0.05);
  assert.ok(day.sunlit);
  near(day.resources.elec.amount, 2 * 1.6 * 5, 0.2, 'charging in sunlight');
  const w2 = new World();
  const night = w2.spawn(c, { pos: sun.clone().multiplyScalar(-r), vel: side.clone().multiplyScalar(sp) });
  night.setSolar(true);
  for (const p of night.parts.values()) if (p.res.elec !== undefined) p.res.elec = 0;
  for (let i = 0; i < 100; i++) w2.step(0.05);
  assert.equal(night.sunlit, false);
  assert.ok(night.resources.elec.amount < 0.2, 'no charge in the shadow: ' + night.resources.elec.amount);
});

test('serialization: a saved world continues identically', () => {
  const a = new World();
  const v = a.launch(stock('Ember Twin'), { crew: ['Ada'] });
  // some company: a landed capsule next door, a vessel in orbit on rails, a flag
  const pad2 = above(a, capsule(), home.dirFromLatLon(0.0002, 0.0002), 1.0);
  const sat = inOrbit(a, capsule({ extra: ['tank_m100', 'eng_sparrow'] }), 300000, 200000, { crew: ['Cy'], makeActive: false }).v;
  sat.addNode(4000, { prograde: 20, radial: -3 });
  a.switchTo(v);
  a.flags.push({ name: 'Old Flag', bodyId: 'verda', dir: { x: 1, y: 0, z: 0 }, ut: 0 });
  v.ctrl.throttle = 1;
  a.stage();
  const script = (w, i) => {
    const s = w.active;
    if (i === 100) s.ctrl.yaw = 0.3;
    if (i === 160) s.ctrl.yaw = 0;
    if (i === 700) w.stage();
    if (i === 900) s.ctrl.throttle = 0.6;
  };
  for (let i = 0; i < 400; i++) { script(a, i); a.step(0.05); }
  assert.ok(pad2.landed);
  assert.ok(sat.onRails);
  const json = JSON.parse(JSON.stringify(a.toJSON()));
  const b = World.fromJSON(json);
  assert.deepEqual(JSON.parse(JSON.stringify(b.toJSON())), json, 'toJSON → fromJSON → toJSON is stable');
  assert.equal(b.vessels.length, 3);
  assert.equal(b.active.id, v.id);
  assert.equal(b.active.name, 'Ember Twin');
  assert.deepEqual(b.flags, a.flags);
  near(b.ut, a.ut, 0);
  assert.equal(b.active.situation, 'flying');
  // continue both: booster burnout, staging, throttle change, debris creation and removal
  const la = record(a), lb = record(b);
  for (let i = 400; i < 1400; i++) { script(a, i); a.step(0.05); script(b, i); b.step(0.05); }
  const va = a.active, vb = b.active;
  assert.ok(va.pos.distanceTo(vb.pos) < 1e-6, 'position: ' + va.pos.distanceTo(vb.pos));
  assert.ok(va.vel.distanceTo(vb.vel) < 1e-8, 'velocity');
  assert.ok(va.q.angleTo(vb.q) < 1e-9, 'attitude');
  near(va.mass, vb.mass, 1e-9, 'mass');
  assert.equal(va.stageIndex, vb.stageIndex);
  assert.deepEqual(la.types(), lb.types(), 'same events in the same order');
  assert.ok(la.types().includes('decouple') && la.types().includes('destroyed'));
  assert.equal(a.vessels.length, b.vessels.length);
  const sa = a.getVessel(sat.id), sb = b.getVessel(sat.id);
  assert.ok(sa.pos.distanceTo(sb.pos) < 1e-3, 'rails vessel: ' + sa.pos.distanceTo(sb.pos));
  assert.deepEqual(sb.nodes, [{ t: 4000, dv: { prograde: 20, normal: 0, radial: -3 } }]);
  assert.deepEqual(sb.crew, ['Cy']);
  assert.ok(b.getVessel(pad2.id).landed);
  near(a.ut, b.ut, 1e-9);
});

test('switching vessels and nearby loading', () => {
  const w = new World();
  const a = inOrbit(w, capsule(), 200000, 200000).v;
  const b = w.spawn(capsule(), { crew: ['Bo'], pos: a.pos.clone().add(new Vector3(0, 300, 0)), vel: a.vel.clone(), makeActive: false });
  const c = inOrbit(w, capsule(), 500000, 500000, { crew: ['Cy'], makeActive: false }).v;
  for (let i = 0; i < 10; i++) w.step(0.05);
  assert.equal(b.onRails, false, 'within 2.5 km: physics');
  assert.equal(c.onRails, true, 'far away: rails');
  assert.equal(w.switchTo(c), true);
  assert.equal(w.active, c);
  for (let i = 0; i < 10; i++) w.step(0.05);
  assert.equal(c.onRails, false);
  assert.equal(a.onRails, true); assert.equal(b.onRails, true);
  assert.equal(w.switchTo({}), false);
  // everything rides rails under rails warp and comes back afterwards
  w.setWarp(7);
  for (let i = 0; i < 10; i++) w.step(0.1);
  assert.ok(a.onRails && b.onRails && c.onRails);
  w.setWarp(0);
  w.switchTo(a);
  w.step(0.05);
  assert.ok(!a.onRails && !b.onRails && c.onRails);
  assert.ok(a.pos.distanceTo(b.pos) < 400);
});

test('performance: World.step(1/60) with a 26-part vessel under thrust in the atmosphere', () => {
  const w = new World();
  const v = w.launch(stock('Pell Runner'), { crew: ['Ada'] });
  v.ctrl.throttle = 1;
  w.stage();
  for (let i = 0; i < 600; i++) w.step(1 / 60);          // warm-up, climbing through the air
  assert.ok(v.dynamicPressure > 100 && v.thrust > 0);
  const N = 1500;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) w.step(1 / 60);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`    World.step(1/60), ${v.parts.size} parts, thrust + aerodynamics: ${(ms * 1000).toFixed(1)} µs per step`);
  assert.ok(v.dynamicPressure > 10, 'still in the air at the end of the measurement');
  assert.ok(ms < 2, `step took ${ms} ms`);
});

test('launch accepts a site record: the vessel stands at that spot and heading, on its wheels', () => {
  const w = new World();
  const R = home.radius;
  const dir = home.dirFromLatLon(-850 / R, -850 / R);                       // 850 m west, 850 m south of the pad
  const v = w.launch(stock('Kite Trainer'), { crew: ['Ada'], site: { dir, heading: 90 } });
  assert.equal(v.launchSite, 'runway', 'a wheeled craft at a custom site counts as a runway launch');
  const ll = home.latLon(home.inertialToSurfaceDir(v.pos, w.ut));
  near(ll.lon * R, -850, 0.5, 'metres east of the pad');
  near(-ll.lat * R, 850, 0.5, 'metres south of the pad');
  for (let i = 0; i < 100; i++) w.step(0.02);
  assert.ok(v.landed && !v.dead && v.parts.size === stock('Kite Trainer').parts.length, 'it rests there in one piece');
  const ll2 = home.latLon(home.inertialToSurfaceDir(v.pos, w.ut));
  near(ll2.lon * R, -850, 1, 'it does not creep along the strip with the brakes on');
});

test('planReturnFromMoon: a burn from low Dray orbit drops the path to a low pass over Rusk', async () => {
  const AP = await import('../../js/core/autopilot.js');
  const rusk = SYSTEM.byId.rusk, dray = SYSTEM.byId.dray;
  const w = new World({ ut: 5e6 });
  const { v } = inOrbit(w, stock('Skylark II'), 8000, 8000, { body: dray });
  const plan = AP.planReturnFromMoon(w, v, { periapsis: 150000 });
  assert.ok(plan && plan.node && v.nodes.length === 1, 'a node is planned');
  assert.ok(plan.dv > 20 && plan.dv < 400, `a modest burn (${plan.dv.toFixed(1)} m/s)`);
  near(plan.periapsis, 150000, 15000, 'predicted periapsis over Rusk');
  assert.ok(plan.exitUt > plan.node.t && plan.arrivalUt > plan.exitUt, 'leaves Dray, then reaches the periapsis');
  assert.equal(AP.planReturnFromMoon(w, inOrbit(w, stock('Skylark II'), 90000, 90000, { makeActive: false }).v), null, 'not offered around a planet');
  assert.ok(rusk.atmo.height < 150000);
});

test('warpTo is not held back by a low orbit: months pass in a few steps, and the orbit is unchanged', () => {
  const w = new World();
  const { v } = inOrbit(w, capsule(), 82000, 80000);
  for (let i = 0; i < 20; i++) w.step(0.05);
  assert.ok(w.setWarp(99) < WARP_RATES.length - 1, 'manual warp is still limited this low');
  w.setWarp(0);
  const ap0 = v.apoapsis, pe0 = v.periapsis, t1 = w.ut + 150 * 86400;
  assert.ok(w.warpTo(t1));
  let n = 0;
  while (w.ut < t1 - 1e-3 && n++ < 20000) w.step(0.05);
  assert.ok(n < 6000, `150 days took ${n} steps`);
  near(w.ut, t1, 1e-3, 'stops exactly there');
  assert.equal(w.warpIndex, 0);
  for (let i = 0; i < 5; i++) w.step(0.05);
  near(v.apoapsis, ap0, 50, 'apoapsis kept'); near(v.periapsis, pe0, 50, 'periapsis kept');
  assert.ok(!v.dead && v.situation === 'orbit');
});

test('a capsule dropped in the sea on its side rights itself, heat shield down (def.comY)', () => {
  const w = new World();
  const v = above(w, capsule({ chute: false, shield: true }), waterDir(), 3);
  const up = v.pos.clone().normalize();
  const side = new Vector3(0, 1, 0).applyQuaternion(v.q).cross(up).normalize();
  if (!(side.lengthSq() > 0.5)) side.set(1, 0, 0).cross(up).normalize();
  v.q.premultiply(new Quaternion().setFromAxisAngle(side, 1.75));   // nose a little below the horizon
  for (let i = 0; i < 4000 && !v.dead; i++) w.step(0.025);
  assert.ok(!v.dead && v.splashed, 'afloat');
  const tilt = Math.acos(new Vector3(0, 1, 0).applyQuaternion(v.q).dot(v.pos.clone().normalize())) * 180 / Math.PI;
  assert.ok(tilt < 15, 'floats nose up: ' + tilt.toFixed(1) + '°');
});

test('tilted parts: the general wing / engine path agrees with the plain one and follows craft.js partAxis', async () => {
  const { partAxis, partQuat } = await import('../../js/core/craft.js');
  const fly = tilt => {
    const craft = JSON.parse(JSON.stringify(stock('Kite Trainer')));
    if (tilt) for (const p of craft.parts) if (!Vessel.fromCraft(craft).parts.get(p.id).def.attach.stack) p.roll = tilt;
    const w = new World();
    const v = above(w, craft, SYSTEM.launchSite.dir, 1500);
    const nose = new Vector3(0, 1, 0).applyQuaternion(v.q), belly = new Vector3(0, 0, 1).applyQuaternion(v.q);
    v.vel.addScaledVector(nose, 90).addScaledVector(belly, 6);
    v.ctrl.throttle = 1; for (const e of v.engines) e.part.ignited = true;
    for (let i = 0; i < 80; i++) w.step(0.025);
    return v;
  };
  const a = fly(0), b = fly(1e-7);
  assert.ok(b.partList.some(p => p._tilt), 'the tilted path is in use');
  assert.ok(a.vel.distanceTo(b.vel) < 1e-3, 'same flight: ' + a.vel.distanceTo(b.vel));
  assert.ok(a.q.angleTo(b.q) < 1e-4, 'same attitude: ' + a.q.angleTo(b.q));
  // orientation fields survive fromCraft and a save, and the axes match the builder's
  const craft = JSON.parse(JSON.stringify(stock('Kite Trainer')));
  const wing = craft.parts.find(p => Vessel.fromCraft(craft).parts.get(p.id).def.wing);
  wing.pitch = 0.2; wing.roll = -0.35;
  const v = Vessel.fromCraft(craft), p = v.parts.get(wing.id), ax = partAxis(wing), q = partQuat(wing);
  assert.ok(Math.hypot(p._ax - ax.x, p._ay - ax.y, p._az - ax.z) < 1e-9);
  const n = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(q[0], q[1], q[2], q[3]));
  assert.ok(Math.hypot(p._nx - n.x, p._ny - n.y, p._nz - n.z) < 1e-9);
  const back = Vessel.fromJSON(JSON.parse(JSON.stringify(v.toJSON()))).parts.get(wing.id);
  assert.equal(back.pitch, 0.2); assert.equal(back.roll, -0.35);
});

test('EVA: a walking Pip faces the way it goes, and plants its flag in front of itself', () => {
  const g = new World();
  const pod = g.launch(capsule(), { crew: ['Bo'] });
  const bo = g.evaStart(pod);
  // everything in the body-fixed frame (the ground turns under the inertial one)
  const R = home.radius;
  const here = () => bo.surface.dir.clone().multiplyScalar(R), ship = pod.surface.dir.clone().multiplyScalar(R);
  const up = () => bo.surface.dir.clone().normalize();
  const flat = v => { const u = up(); return v.addScaledVector(u, -v.dot(u)).normalize(); };
  const facing = () => flat(new Vector3(0, 0, 1).applyQuaternion(bo.surface.qRel));
  const deg = r => r * 180 / Math.PI;
  // steps out with its back to the hatch
  assert.ok(deg(facing().angleTo(flat(here().sub(ship)))) < 1, 'looks away from the ship on the way out');
  // commanded along a direction over the ground (as the keys and the demo do: re-expressed in the Pip's frame each step)
  const away = flat(here().sub(ship));
  const dirs = [0, 45, 90, 135, 180, 225, 270, -30].map(a => away.clone().applyAxisAngle(up(), a * Math.PI / 180));
  dirs.push(null);                                           // null: straight back toward the ship
  for (const want of dirs) {
    const from = here();
    let worst = 0, moved = 0;
    for (let i = 0; i < 60; i++) {
      const w = want ? flat(want.clone()) : flat(ship.clone().sub(here()));
      const l = w.clone().applyQuaternion(bo.surface.qRel.clone().invert());
      bo.ctrl.tx = l.x; bo.ctrl.tz = l.z;
      const p0 = bo.surface.dir.clone();
      g.step(1 / 30);
      const step = bo.surface.dir.clone().sub(p0);
      if (step.length() * home.radius > 1e-4) {              // every step it takes is a step forward
        moved++;
        const f = new Vector3(0, 0, 1).applyQuaternion(bo.surface.qRel);
        worst = Math.max(worst, deg(f.angleTo(step.addScaledVector(bo.surface.dir, -step.dot(bo.surface.dir)))));
      }
    }
    bo.ctrl.tx = bo.ctrl.tz = 0;
    g.step(1 / 30);
    assert.ok(moved > 40, 'walked: ' + moved);
    assert.ok(worst <= 61, 'never sideways or backwards: ' + worst.toFixed(1));
    const went = flat(here().sub(from));
    assert.ok(deg(facing().angleTo(went)) < 3, 'faces its path: ' + deg(facing().angleTo(went)).toFixed(2));
    if (want) assert.ok(deg(went.angleTo(flat(want.clone()))) < 3, 'and goes where it was sent');
    assert.ok(here().distanceTo(from) > 1.8 && here().distanceTo(from) < 3.05, 'at walking pace');
  }
  // a held command keeps its direction over the ground: the Pip turns round and walks, it does not circle or moonwalk
  const f0 = facing(), from = here();
  bo.ctrl.tx = 0; bo.ctrl.tz = -1;
  for (let i = 0; i < 90; i++) g.step(1 / 30);
  near(bo.ctrl.tx, 0, 1e-6); near(bo.ctrl.tz, 1, 1e-6, 'the command ends up straight ahead');
  bo.ctrl.tz = 0;
  g.step(1 / 30);
  assert.ok(deg(facing().angleTo(f0.clone().negate())) < 3, 'turned right round');
  assert.ok(deg(flat(here().sub(from)).angleTo(facing())) < 3, 'and walked that way');
  // the flag goes in just ahead, so the Pip is left looking at it
  const flag = g.plantFlag(bo, 'Ahead');
  const fp = new Vector3(flag.dir.x, flag.dir.y, flag.dir.z).multiplyScalar(R).sub(here());
  near(fp.length(), TUNING.FLAG_REACH, 0.02, 'half a metre away');
  assert.ok(deg(flat(fp).angleTo(facing())) < 2, 'dead ahead');
});
