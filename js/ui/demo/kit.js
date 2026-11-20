// Starwright demo tour — pure helpers (no DOM): seeded random numbers, easing, and the "scene cut" spawners that put
// vessels straight into the states the tour shows (the same moves the test suites make through the World API).
// Runs under Node, so tests/e2e and scratch scripts can rehearse the tour's flights without a browser.
import { Vector3, Quaternion, Matrix4 } from '../../lib/three.module.min.js';
import { SYSTEM } from '../../core/bodies.js';
import { World } from '../../core/world.js';
import { stockCrafts } from '../../core/craft.js';
import { surfaceAt } from '../../core/vessel.js';

const Y = new Vector3(0, 1, 0);
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Deterministic PRNG (mulberry32): the tour replaces Math.random with one of these while it runs. */
export function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ease = {
  linear: t => t,
  in: t => t * t,
  out: t => 1 - (1 - t) * (1 - t),
  inOut: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  soft: t => t * t * (3 - 2 * t),
};

/** Interpolate every numeric key of two plain poses. */
export function mixPose(a, b, t, out = {}) {
  for (const k in b) if (typeof b[k] === 'number') out[k] = lerp(typeof a[k] === 'number' ? a[k] : b[k], b[k], t);
  return out;
}

export function stock(name) {
  try { return stockCrafts().find(c => c.name === name) || null; } catch { return null; }
}

/** Unit vector from a body toward the star, flattened into the ecliptic (the lit side of an equatorial orbit). */
export function sunwardOf(body, ut, out = new Vector3()) {
  body.globalPosAt(ut, out).negate();
  out.y = 0;
  if (out.lengthSq() < 1e-9) out.set(1, 0, 0);
  return out.normalize();
}

/**
 * State for a prograde equatorial orbit: `phase` (rad) is measured from the sub-solar point, positive in the
 * direction of travel; side −1 starts over the night side. speedFactor scales the circular speed, vy adds radial speed.
 * Returns { pos, vel, q } with the nose prograde (retro: true points it backwards) and the "top" away from the body.
 */
export function orbitState(body, alt, ut, { phase = 0, side = 1, speedFactor = 1, vy = 0, retro = false, tilt = 0 } = {}) {
  const r = body.radius + alt;
  const out = sunwardOf(body, ut).applyAxisAngle(Y, phase).multiplyScalar(side);
  const pro = new Vector3().crossVectors(Y, out).normalize();
  if (tilt) pro.applyAxisAngle(out, tilt);
  const vc = Math.sqrt(body.gm / r) * speedFactor;
  const pos = out.clone().multiplyScalar(r);
  const vel = pro.clone().multiplyScalar(vc).addScaledVector(out, vy);
  const yAxis = retro ? pro.clone().negate() : pro.clone(), zAxis = out.clone(), xAxis = new Vector3().crossVectors(yAxis, zAxis);
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(xAxis, yAxis, zAxis));
  return { pos, vel, q };
}

/** Move an existing vessel (the test suites' "teleport"): any SOI, any state; clears nodes and rails. */
export function teleport(world, v, body, state) {
  if (v.landed) { v.landed = false; v.splashed = false; v.surface = null; }
  v.launched = true; if (!Number.isFinite(v.launchUt)) v.launchUt = world.ut;
  v.grounded = false;
  v.body = body; v.onRails = false; v._patch = null;
  v.pos.copy(state.pos); v.vel.copy(state.vel);
  if (state.q) v.q.copy(state.q);
  v.w.set(0, 0, 0); v.sasTarget = null; v.ctrl.throttle = 0;
  if (typeof v._stamp === 'number') v._stamp++;
  while (v.nodes && v.nodes.length) { if (typeof v.removeNode === 'function') v.removeNode(v.nodes[0]); else v.nodes.shift(); }
  v.updateTelemetry(world.ut);
  return v;
}

/** Body-fixed unit direction at latitude / longitude (rad). */
export function dirAt(lat, lon, out = new Vector3()) {
  return out.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
}

/** Local slope (rise / run) of the ground over `span` metres. */
export function slopeAt(body, dir, span = 6) {
  const e = span / body.radius;
  const d = dir.clone().normalize();
  const east = new Vector3().crossVectors(Y, d); if (east.lengthSq() < 1e-9) east.set(0, 0, -1); east.normalize();
  const north = new Vector3().crossVectors(d, east);
  const h0 = surfaceAt(body, d);
  const h1 = surfaceAt(body, d.clone().addScaledVector(east, e).normalize());
  const h2 = surfaceAt(body, d.clone().addScaledVector(north, e).normalize());
  const h3 = surfaceAt(body, d.clone().addScaledVector(east, -e).normalize());
  const h4 = surfaceAt(body, d.clone().addScaledVector(north, -e).normalize());
  return Math.max(Math.abs(h1 - h0), Math.abs(h2 - h0), Math.abs(h3 - h0), Math.abs(h4 - h0)) / span;
}

/**
 * The flattest spot near a body-fixed direction: a deterministic spiral search (so two runs pick the same place).
 * `reach` is the search radius in metres; also checks the slope over a wider span so a rover has room to drive.
 */
export function flatSpot(body, near, { reach = 30000, samples = 500, wide = 60, dry = true } = {}) {
  const base = near.clone().normalize();
  const east = new Vector3().crossVectors(Y, base); if (east.lengthSq() < 1e-9) east.set(0, 0, -1); east.normalize();
  const north = new Vector3().crossVectors(base, east);
  let best = base.clone(), bestScore = Infinity;
  for (let i = 0; i < samples; i++) {
    const f = i / samples, ang = i * 2.399963, rad = Math.sqrt(f) * reach / body.radius;
    const d = base.clone().addScaledVector(east, Math.cos(ang) * rad).addScaledVector(north, Math.sin(ang) * rad).normalize();
    if (dry && body.ocean && typeof body.isWater === 'function' && body.isWater(d)) continue;
    const score = slopeAt(body, d, 6) + slopeAt(body, d, wide) * 1.5;
    if (score < bestScore) { bestScore = score; best = d; if (score < 0.01) break; }
  }
  return { dir: best, slope: bestScore };
}

/**
 * Stand a craft on the ground of any body, at rest: upright on its legs (or its engine bell), or on its wheels
 * pointing along a compass heading when `vehicle` is set. Uses the same kinematic placement as World.launch.
 */
export function placeLanded(world, craft, body, dir, { crew = [], vehicle = false, heading = 90, legs = true, makeActive = true } = {}) {
  const d = dir.clone().normalize();
  const inertial = body.surfaceDirToInertial(d, world.ut, new Vector3());
  const r = body.radius + surfaceAt(body, d) + 5;
  const pos = inertial.clone().multiplyScalar(r);
  const wy = (Math.PI * 2) / body.rotPeriod;
  const v = world.spawn(craft, { crew, body, pos, vel: new Vector3(wy * pos.z, 0, -wy * pos.x), makeActive });
  if (legs && typeof v.setLegs === 'function' && (v.legParts || []).length) v.setLegs(true);
  if (vehicle && typeof v.setGear === 'function' && v.hasGear) v.setGear(true);
  v.landed = true; v.splashed = false;
  // a vehicle stands square on the ground it is on (the terrain normal over its wheelbase, as js/core/scenarios.js
  // does), not level across a slope with the wheels of one side buried: that kicked the rover when it woke up
  const tilt = vehicle && typeof body.terrainNormal === 'function' ? body.terrainNormal(d, new Vector3(), 1) : d;
  v.surface = { dir: d.clone(), qRel: vehicle ? World.vehicleFrame(tilt, heading) : World.padFrame(d), h: 0, qTarget: null, vehicle: !!vehicle };
  if (vehicle) v.ctrl.brake = true;
  v.situation = 'landed';
  v.ctrl.sas = true;
  v.syncLanded(world.ut);
  v.updateTelemetry(world.ut);
  return v;
}

/** Fire stages until only the last `keep` stage groups are left (drops launchers so the payload flies alone). */
export function stageDown(world, v, keep = 1) {
  let guard = 0;
  const prev = world.active;
  world.active = v;
  while (v.stages && v.stageIndex < v.stages.length - keep && guard++ < 12) world.stage();
  world.active = prev || v;
  // the spent pieces are not part of the picture
  for (const o of world.vessels.slice()) if (o.type === 'debris') world.removeVessel(o);
  return v;
}

/** Compass heading (deg) and the local east / north / up axes at a vessel, all inertial. */
export function localAxes(v, out = {}) {
  const up = (out.up || (out.up = new Vector3())).copy(v.pos).normalize();
  const east = (out.east || (out.east = new Vector3())).crossVectors(Y, up);
  if (east.lengthSq() < 1e-9) east.set(0, 0, -1);
  east.normalize();
  (out.north || (out.north = new Vector3())).crossVectors(up, east);
  return out;
}

export { SYSTEM, World, Vector3, Quaternion };
