// Starwright scripted guidance. Used by the flight-test harness and offered in-game as a piloting assist.
// Controllers only set vessel.ctrl / SAS targets and call world.stage() / setWarp() / warpTo():
// they fly through the same public API as the player. PURE SIMULATION - runs under Node.
//
// Every controller is { phase, done, failed, log: [{t, msg}], update(dt) }. Call update() once per frame
// (or per World.step) until `done`. They tolerate update intervals up to ~0.25 s of simulated time.
import { Vector3, Quaternion } from '../lib/three.module.min.js';
import { Orbit } from './orbit.js';
import { predictPatches, applyManeuver, closestApproach } from './trajectory.js';
import { SYSTEM } from './bodies.js';
import { flightAngles, stallSpeed, surfaceAt, roverCruiseSpeed } from './vessel.js';
import { returnReserve } from './booster.js';
export { boosterRecovery, predictFall, returnReserve, recoverableStage } from './booster.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const Y_AXIS = new Vector3(0, 1, 0);
const _a = new Vector3(), _b = new Vector3(), _c = new Vector3(), _d = new Vector3();
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

function base(world, vessel, name) {
  const c = { name, phase: 'init', done: false, failed: false, log: [], vessel };
  c.note = msg => { c.log.push({ t: world.ut, msg }); };
  c.finish = (ok, msg) => { c.done = true; c.failed = !ok; c.phase = ok ? 'done' : 'failed'; if (msg) c.note(msg); };
  return c;
}

/** Angle (rad) between the vessel's nose and an inertial direction. */
export function pointingError(vessel, dir) {
  _a.set(0, 1, 0).applyQuaternion(vessel.q);
  return _a.angleTo(dir);
}
function point(vessel, dir) {
  vessel.ctrl.sas = true;
  vessel.ctrl.sasMode = 'direction';
  vessel.sasDir.copy(dir).normalize();
}
function mode(vessel, m) { vessel.ctrl.sas = true; vessel.ctrl.sasMode = m; }

/** Fire the next stage when the burning one is spent. Returns true if it staged. */
export function autoStage(world, vessel, state) {
  if (!vessel.hasEngineStagesLeft()) return false;
  if (state.lastStage !== undefined && world.ut - state.lastStage < 0.6) return false;
  let go = false;
  if (vessel.enginePower().thrust <= 0) go = true;
  else {
    const drop = vessel.dropSet(vessel.stages[vessel.stageIndex] || []);
    if (drop.size) {
      let spent = false, burning = false;
      for (const id of drop) {
        const p = vessel.parts.get(id);
        if (!p.def.engine || !p.ignited) continue;
        const fed = p.def.engine.type === 'solid' ? p.res.solid > 0 : !p.flameout;
        if (fed) burning = true; else spent = true;
      }
      go = spent && !burning;
    }
  }
  if (!go) return false;
  state.lastStage = world.ut;
  world.stage(vessel);
  return true;
}

/** Full-throttle burn time for `dv`, following the staging sequence. */
export function stagedBurnTime(vessel, dv) {
  vessel.estimateDeltaV();
  let left = Math.abs(dv), t = 0;
  for (const s of vessel.stageInfo) {
    if (!(s.thrust > 0) || !(s.dv > 0)) continue;
    const use = Math.min(left, s.dv);
    t += s.startMass * s.ve / s.thrust * (1 - Math.exp(-use / s.ve));
    left -= use;
    if (left <= 1e-6) break;
  }
  return left > 1 ? Infinity : t;
}

// ---------------------------------------------------------------------------------------------
// Ascent to orbit
// ---------------------------------------------------------------------------------------------
/**
 * Gravity-turn ascent of world.active to a circular orbit.
 * opts: targetAlt (m), heading (deg, 90 = east), turnStart / turnEnd (altitudes of the pitch program),
 * turnShape (exponent), finalPitch (deg above the horizon at turnEnd), maxG, useWarp.
 */
export function ascentProgram(world, opts = {}) {
  const v = opts.vessel || world.active;
  const body = v.body;
  const atmoH = body.atmo ? body.atmo.height : 0;
  const o = {
    targetAlt: 80000, heading: 90, turnStart: 700, turnEnd: atmoH ? atmoH * 0.62 : 20000, turnShape: 0.55,
    finalPitch: 4, maxG: 4, useWarp: true, ...opts,
  };
  const c = base(world, v, 'ascent');
  const st = {};
  c.opts = o;
  c.dvUsed = 0;
  let dv0 = null;
  const up = new Vector3(), east = new Vector3(), north = new Vector3(), dir = new Vector3(), hd = new Vector3();

  c.update = () => {
    if (c.done) return;
    // (the program flies its own vessel whether or not it is the one being watched: see World.isTrackable)
    if (v.dead || !world.vessels.includes(v)) return c.finish(false, 'vessel lost');
    if (dv0 === null) dv0 = v.deltaV;
    const ut = world.ut;
    up.copy(v.pos).normalize();
    east.crossVectors(Y_AXIS, up).normalize();
    north.crossVectors(up, east);
    const alt = v.altitude;
    switch (c.phase) {
      case 'init':
        v.ctrl.throttle = 1;
        point(v, up);
        // a lander standing on an engine that is already lit (it landed on it) only needs the throttle: firing the
        // next stage would throw that engine away
        if (!v.engines.some(e => e.part.ignited && !e.part.flameout && e.part.def.engine.type !== 'solid')) world.stage(v);
        st.lastStage = ut;
        c.phase = 'ascent';
        c.note('liftoff');
        break;
      case 'ascent': {
        // a first stage built to come back is let go while it still holds the propellant to do so
        if (o.recover && !st.recovered && (st.lastStage === undefined || ut - st.lastStage > 1)) {
          const need = returnReserve(world, v, o.recover.target || body.launchSite.dir);
          if (need && need.have <= need.kg) {
            st.recovered = true; st.lastStage = ut;
            world.stage(v);
            // (a stage with catch pins and no legs has nowhere to come down yet: say so, do not promise a return)
            c.note(need.stage.legs ? `staged with ${need.have.toFixed(0)} kg left in the booster to fly back` : `staged with ${(need.have / 1000).toFixed(0)} t left in the booster to fly back to the tower`);
          }
        }
        if (autoStage(world, v, st)) c.note('staged → stage ' + v.stageIndex);
        let el = 90;
        if (alt > o.turnStart) {
          const f = clamp((alt - o.turnStart) / (o.turnEnd - o.turnStart), 0, 1);
          el = 90 - (90 - o.finalPitch) * Math.pow(f, o.turnShape);
        }
        // A stage that cannot hold its own weight (an upper stage with thrust below its weight, as on the Shearwater)
        // sinks if it flies the turn the altitude asks for: it keeps its nose up enough to hold a climb rate until
        // its sideways speed carries it. Stages that can lift themselves are not touched.
        const accNow = v.maxThrust / v.mass, rNow = v.pos.length(), gNow = body.gm / (rNow * rNow);
        if (alt > o.turnStart && accNow > 0 && accNow < gNow) {
          const vsN = v.vel.dot(up), vh2 = v.vel.lengthSq() - vsN * vsN;
          const want = clamp((o.targetAlt - alt) / 90, 0, 400);
          const sn = clamp((gNow - vh2 / rNow - (vsN - want) / 10) / accNow, 0, 0.94);
          el = Math.max(el, Math.asin(sn) / DEG);
        }
        const h = o.heading * DEG;
        hd.copy(east).multiplyScalar(Math.sin(h)).addScaledVector(north, Math.cos(h));
        dir.copy(up).multiplyScalar(Math.sin(el * DEG)).addScaledVector(hd, Math.cos(el * DEG));
        point(v, dir);
        const gap = o.targetAlt - v.apoapsis;
        let thr = gap > 6000 ? 1 : clamp(gap / 6000, 0.08, 1);
        const acc = v.maxThrust / v.mass;
        if (acc > o.maxG * 9.81) thr = Math.min(thr, o.maxG * 9.81 / acc);
        v.ctrl.throttle = thr;
        if (gap <= 0) {
          v.ctrl.throttle = 0;
          c.phase = 'coast';
          c.note(`apoapsis ${(v.apoapsis / 1000).toFixed(1)} km reached at ${(alt / 1000).toFixed(1)} km altitude`);
        } else if (!v.hasEngineStagesLeft() && v.enginePower().thrust <= 0) return c.finish(false, 'out of propellant during ascent');
        break;
      }
      case 'coast': {
        // still in the atmosphere: keep the nose into the wind (the air moves with the ground, so that is surface
        // prograde, a few degrees from orbital prograde; held off the wind, a rocket whose engine is out has only its
        // reaction wheels against the air), and top the apoapsis up against drag
        mode(v, alt < atmoH ? 'srfPrograde' : 'prograde');
        if (alt < atmoH) {
          _a.copy(v.surfaceVel).normalize();
          const err = pointingError(v, _a);
          if (v.apoapsis < o.targetAlt - 250) st.topUp = true;
          // the engine's gimbal is what turns a big rocket: once a top-up burn is running it is not cut while the
          // rocket is still swinging, or the swing is left for the reaction wheels to stop against the air
          else if (v.apoapsis > o.targetAlt + (err > 0.02 || v.w.lengthSq() > 1e-4 ? 1500 : 0)) st.topUp = false;
          if (st.topUp) {
            if (v.enginePower().thrust <= 0) autoStage(world, v, st);
            v.ctrl.throttle = err < 0.15 ? clamp((o.targetAlt - v.apoapsis) / 3000, 0.05, 0.5) : 0;
          } else v.ctrl.throttle = 0;
          break;
        }
        v.ctrl.throttle = 0;
        if (v.enginePower().thrust <= 0 && autoStage(world, v, st)) { c.note('staged → stage ' + v.stageIndex); break; }
        const orbit = v.getOrbit(ut);
        const rAp = orbit.apoapsis, gm = body.gm;
        const vAp = Math.sqrt(Math.max(0, gm * (2 / rAp - 1 / orbit.a)));
        const need = Math.sqrt(gm / rAp) - vAp;
        const tb = stagedBurnTime(v, need);
        if (!Number.isFinite(tb)) return c.finish(false, `not enough delta-v to circularise (need ${need.toFixed(0)} m/s, have ${v.deltaV.toFixed(0)})`);
        st.tBurn = ut + orbit.timeToApoapsis(ut) - tb / 2;
        if (v.verticalSpeed < 0) st.tBurn = ut;   // already past apoapsis
        st.need = need;
        c.phase = 'coastToAp';
        c.note(`coasting; circularisation needs ${need.toFixed(0)} m/s, burn ${tb.toFixed(0)} s`);
        break;
      }
      case 'coastToAp': {
        mode(v, 'prograde');
        if (ut < st.tBurn - 14) { if (o.useWarp && world.warpTarget === null) world.warpTo(st.tBurn - 12); break; }
        if (ut >= st.tBurn) { c.phase = 'circularise'; c.note('circularisation burn'); }
        break;
      }
      case 'circularise': {
        if (autoStage(world, v, st)) c.note('staged → stage ' + v.stageIndex);
        const r = v.pos.length(), gm = body.gm;
        const vs = v.vel.dot(up);
        hd.copy(v.vel).addScaledVector(up, -vs);
        const vh = hd.length();
        hd.multiplyScalar(1 / vh);
        const vc = Math.sqrt(gm / r);
        const rem = vc - vh;
        const acc = Math.max(0.1, v.maxThrust / v.mass);
        // pitch so that the vertical speed is driven to zero while the horizontal speed builds up
        const gEff = gm / (r * r) - vh * vh / r;
        const sinT = clamp((gEff - vs / 8) / acc, -0.5, 0.5);
        dir.copy(hd).multiplyScalar(Math.sqrt(1 - sinT * sinT)).addScaledVector(up, sinT);
        point(v, dir);
        const aligned = pointingError(v, dir) < 0.2;
        v.ctrl.throttle = aligned ? clamp(rem / (acc * 0.8), 0.03, 1) : 0;
        if (rem <= 0.3) {
          v.ctrl.throttle = 0;
          mode(v, 'prograde');
          c.dvUsed = dv0 - v.estimateDeltaV();
          return c.finish(true, `orbit ${(v.apoapsis / 1000).toFixed(1)} × ${(v.periapsis / 1000).toFixed(1)} km`);
        }
        if (!v.hasEngineStagesLeft() && v.enginePower().thrust <= 0) return c.finish(false, 'out of propellant while circularising');
        if (alt < atmoH * 0.8) return c.finish(false, 'fell back into the atmosphere');
        break;
      }
      default: break;
    }
  };
  return c;
}

// ---------------------------------------------------------------------------------------------
// Maneuver node execution
// ---------------------------------------------------------------------------------------------
export function executeNode(world, vessel = world.active, opts = {}) {
  // tolerance: the burn ends with less than this left. 0.006 m/s, because a deep-space correction weeks before arrival
  // turns every 0.1 m/s left over into hundreds of kilometres at the target (0.03 m/s still missed a 210 km periapsis
  // at Rusk by 190 km, into the air).
  const o = { useWarp: true, tolerance: 0.006, ...opts };
  const v = vessel;
  const c = base(world, v, 'executeNode');
  const st = {};
  const bv = new Vector3(), dir0 = new Vector3();
  c.dvUsed = 0;
  c.update = () => {
    if (c.done) return;
    if (v.dead) return c.finish(false, 'vessel lost');
    const node = v.nodes[0];
    if (!node) {
      // the node can be cleared under a running burn (the flight screen removes a node once less than 0.5 m/s of it
      // is left, before this program's own cut-off): the engine must not be left idling at a few percent
      if (c.phase === 'burn') { v.ctrl.throttle = 0; mode(v, 'hold'); }
      return c.finish(c.phase === 'burn', 'no maneuver node');
    }
    const ut = world.ut;
    v.burnVector(ut, bv);
    const rem = bv.length();
    switch (c.phase) {
      case 'init': {
        if (v.enginePower().thrust <= 0 && !autoStage(world, v, st) && !v.hasEngineStagesLeft()) return c.finish(false, 'no engine');
        if (v.enginePower().thrust <= 0) break;
        st.dv = rem;
        const tb = stagedBurnTime(v, rem);
        if (!Number.isFinite(tb)) c.note(`warning: node needs ${rem.toFixed(0)} m/s, only ${v.deltaV.toFixed(0)} available`);
        // start so that half the delta-v is delivered before the node
        const half = stagedBurnTime(v, rem / 2);
        st.tStart = node.t - (Number.isFinite(half) ? half : 0);
        st.dv0 = v.deltaV;
        mode(v, 'maneuver');
        c.phase = 'wait';
        c.note(`node: ${rem.toFixed(1)} m/s, burn ${Number.isFinite(tb) ? tb.toFixed(1) : '?'} s`);
        break;
      }
      case 'wait':
        mode(v, 'maneuver');
        v.ctrl.throttle = 0;
        if (ut < st.tStart - 22) { if (o.useWarp && world.warpTarget === null) world.warpTo(st.tStart - 20); break; }
        if (ut >= st.tStart) { c.phase = 'burn'; dir0.copy(bv).normalize(); }
        break;
      case 'burn': {
        mode(v, 'maneuver');
        if (autoStage(world, v, st)) c.note('staged → stage ' + v.stageIndex);
        const acc = Math.max(0.05, v.maxThrust / v.mass);
        const err = rem > 1e-6 ? pointingError(v, _b.copy(bv).normalize()) : 0;
        const along = bv.dot(dir0);
        if (rem < o.tolerance || along <= 0) {
          v.ctrl.throttle = 0;
          v.removeNode(node);
          mode(v, 'hold');
          c.dvUsed = st.dv0 - v.estimateDeltaV();
          return c.finish(true, `burn complete, ${rem.toFixed(2)} m/s residual`);
        }
        v.ctrl.throttle = err < 0.12 || (rem < 3 && err < 0.6) ? clamp(rem / (acc * 0.7), 0.002, 1) : (err < 0.3 ? 0.1 : 0);
        if (!v.hasEngineStagesLeft() && v.enginePower().thrust <= 0) { v.ctrl.throttle = 0; return c.finish(false, `out of propellant with ${rem.toFixed(0)} m/s to go`); }
        break;
      }
      default: break;
    }
  };
  return c;
}

/** True when the orbit does not stay with `body`: open, or closed with its apoapsis beyond the sphere of influence. */
export function leavesSoi(orbit, body) {
  return !!orbit.hyper || !Number.isFinite(orbit.period) || (Number.isFinite(body.soi) && orbit.apoapsis > body.soi);
}
/** Add a node that circularises at the next 'periapsis' or 'apoapsis'. Returns the node. */
export function planCircularize(world, vessel = world.active, at = 'apoapsis') {
  const ut = world.ut, orbit = vessel.getOrbit(ut), gm = vessel.body.gm;
  // an ellipse whose high point lies outside the sphere of influence never gets there: the vessel leaves first
  // (a slow arrival at a small moon comes in on one, e 0.93 to 0.98), so it is captured at the periapsis like a flyby
  const atPe = at === 'periapsis' || leavesSoi(orbit, vessel.body);
  const t = ut + (atPe ? orbit.timeToPeriapsis(ut) : orbit.timeToApoapsis(ut));
  const r = atPe ? orbit.periapsis : orbit.apoapsis;
  const speed = Math.sqrt(Math.max(0, gm * (2 / r - 1 / orbit.a)));
  return vessel.addNode(t, { prograde: Math.sqrt(gm / r) - speed });
}

// ---------------------------------------------------------------------------------------------
// Deorbit
// ---------------------------------------------------------------------------------------------
/** Burn retrograde until the periapsis altitude drops to opts.periapsis (default 30 km; use < 0 on airless bodies). */
export function deorbit(world, vessel = world.active, opts = {}) {
  const o = { periapsis: 30000, ...opts };
  const v = vessel;
  const c = base(world, v, 'deorbit');
  const st = {};
  c.dvUsed = 0;
  c.update = () => {
    if (c.done) return;
    if (v.dead) return c.finish(false, 'vessel lost');
    if (st.dv0 === undefined) st.dv0 = v.deltaV;
    mode(v, 'retrograde');
    if (v.periapsis <= o.periapsis) {
      v.ctrl.throttle = 0;
      c.dvUsed = st.dv0 - v.estimateDeltaV();
      return c.finish(true, `periapsis ${(v.periapsis / 1000).toFixed(1)} km`);
    }
    if (v.enginePower().thrust <= 0) {
      if (!autoStage(world, v, st) && !v.hasEngineStagesLeft()) { v.ctrl.throttle = 0; return c.finish(false, 'out of propellant'); }
      return;
    }
    _a.copy(v.vel).normalize().negate();
    const err = pointingError(v, _a);
    c.phase = 'burn';
    const gap = v.periapsis - o.periapsis;
    const acc = Math.max(0.05, v.maxThrust / v.mass);
    // d(periapsis)/d(v) is a few km per m/s in low orbit: ease off at the end
    v.ctrl.throttle = err < 0.1 ? clamp(gap / (acc * 4000), 0.03, 1) : 0;
  };
  return c;
}

// ---------------------------------------------------------------------------------------------
// Powered landing on an airless body
// ---------------------------------------------------------------------------------------------
// Predicts where a retrograde burn at constant throttle would bring the surface speed to zero.
// `alt` is measured above the terrain under the stopping point (bodies with relief), `ut` is the time now.
function groundAt(body, x, y, z, t) {
  if (typeof body.terrainHeight !== 'function') return 0;
  body.inertialToSurfaceDir(_d.set(x, y, z).normalize(), t, _d);
  return typeof body.surfaceHeight === 'function' ? body.surfaceHeight(_d) : body.terrainHeight(_d);
}
function stopAltitude(body, pos, vel, mass, thrust, ve, throttle, ut = 0) {
  const wy = TAU / body.rotPeriod, gm = body.gm;
  const floor = (body.minElevation || 0) - 5000;
  let x = pos.x, y = pos.y, z = pos.z, vx = vel.x, vy = vel.y, vz = vel.z, m = mass;
  const F = thrust * throttle, mdot = ve > 0 ? F / ve : 0;
  let last = Infinity, t = 0;
  for (let i = 0; i < 400; i++) {
    const sx = vx - wy * z, sy = vy, sz = vz + wy * x;
    const sp = Math.sqrt(sx * sx + sy * sy + sz * sz);
    const r = Math.sqrt(x * x + y * y + z * z);
    if (sp < 0.5 || (sp > last && sp < 20)) return { alt: r - body.radius - groundAt(body, x, y, z, ut + t), t, speed: sp };
    last = sp;
    const a = F / m;
    let dt = Math.min(0.5, Math.max(0.02, 0.25 * sp / a));
    const g = -gm / (r * r * r);
    const ax = g * x - a * sx / sp, ay = g * y - a * sy / sp, az = g * z - a * sz / sp;
    vx += ax * dt; vy += ay * dt; vz += az * dt;
    x += vx * dt; y += vy * dt; z += vz * dt;
    m = Math.max(mass * 0.2, m - mdot * dt);
    t += dt;
    if (r - body.radius < floor) return { alt: r - body.radius - groundAt(body, x, y, z, ut + t), t, speed: sp };
  }
  return { alt: Math.sqrt(x * x + y * y + z * z) - body.radius - groundAt(body, x, y, z, ut + t), t, speed: last };
}

/**
 * Suicide-burn landing on an airless body. From orbit it first lowers the periapsis below the surface,
 * coasts, then brakes so that the surface speed reaches zero `stopAlt` metres above the ground and
 * finally descends vertically. opts: stopAlt (m), touchdownSpeed (m/s), useWarp, deorbitPeriapsis (m, negative).
 */
export function hoverslamLanding(world, vessel = world.active, opts = {}) {
  const v = vessel;
  const body = v.body;
  const o = { stopAlt: 40, touchdownSpeed: 1.5, useWarp: true, deorbitPeriapsis: -0.08 * body.radius, ...opts };
  const c = base(world, v, 'hoverslam');
  const st = {};
  const up = new Vector3(), dir = new Vector3();
  c.dvUsed = 0;
  const needThrottle = () => {
    const { thrust, ve } = v.enginePower();
    if (!(thrust > 0)) return 2;
    const cg = v._baseH || 0;
    const target = o.stopAlt + cg;
    if (stopAltitude(body, v.pos, v.vel, v.mass, thrust, ve, 1, world.ut).alt < target) return 1.5;   // late: full power
    let lo = 0.15, hi = 1;
    if (stopAltitude(body, v.pos, v.vel, v.mass, thrust, ve, lo, world.ut).alt > target) return lo;
    for (let i = 0; i < 7; i++) {
      const mid = 0.5 * (lo + hi);
      if (stopAltitude(body, v.pos, v.vel, v.mass, thrust, ve, mid, world.ut).alt > target) hi = mid; else lo = mid;
    }
    return 0.5 * (lo + hi);
  };
  c.update = () => {
    if (c.done) return;
    if (v.dead) return c.finish(false, 'vessel lost');
    if (st.dv0 === undefined) { st.dv0 = v.deltaV; v.setLegs(true); }
    const ut = world.ut;
    if (v.landed) {
      v.ctrl.throttle = 0;
      mode(v, 'hold');
      c.dvUsed = st.dv0 - v.estimateDeltaV();
      return c.finish(true, `touchdown on ${body.name}`);
    }
    // feet on the ground: engine off and let it settle (in weak gravity even a whisper of thrust hops it off again)
    if (v.grounded && (c.phase === 'final' || c.phase === 'brake')) { v.ctrl.throttle = 0; mode(v, 'hold'); return; }
    if (v.enginePower().thrust <= 0) {
      if (!autoStage(world, v, st) && !v.hasEngineStagesLeft()) { v.ctrl.throttle = 0; return c.finish(false, 'out of propellant'); }
      return;
    }
    up.copy(v.pos).normalize();
    switch (c.phase) {
      case 'init':
        c.phase = v.periapsis > o.deorbitPeriapsis ? 'deorbit' : 'coast';
        if (c.phase === 'deorbit') c.note('deorbit burn');
        break;
      case 'deorbit': {
        mode(v, 'retrograde');
        _a.copy(v.vel).normalize().negate();
        const err = pointingError(v, _a);
        const acc = Math.max(0.05, v.maxThrust / v.mass);
        const gap = v.periapsis - o.deorbitPeriapsis;
        v.ctrl.throttle = err < 0.1 ? clamp(gap / (acc * 1500), 0.05, 1) : 0;
        if (gap <= 0) { v.ctrl.throttle = 0; c.phase = 'coast'; c.note(`descent orbit, periapsis ${(v.periapsis / 1000).toFixed(1)} km`); }
        break;
      }
      case 'coast': {
        mode(v, 'srfRetrograde');
        v.ctrl.throttle = 0;
        const need = needThrottle();
        if (need >= 0.9) { c.phase = 'brake'; c.note(`braking burn at ${(v.radarAlt / 1000).toFixed(1)} km, ${v.airspeed.toFixed(0)} m/s`); break; }
        if (o.useWarp && world.warpTarget === null && st.warped !== world.ut) {
          // warp towards the burn: the burn takes about speed/acc, so stop that long (plus slack) before impact
          const orbit = v.getOrbit(ut);
          const patch = predictPatches(orbit, body, ut, 1)[0];
          if (patch.endType === 'impact') {
            const { thrust } = v.enginePower();
            const tBurn = v.airspeed / (thrust / v.mass);
            // the ground may stand well above the reference sphere: find when the path meets the terrain height there
            let tHit = patch.tEnd;
            const sI = orbit.stateAt(tHit);
            const hT = Math.max(0, groundAt(body, sI.r.x, sI.r.y, sI.r.z, tHit)) + 0.25 * Math.max(0, body.maxElevation || 0);
            if (hT > 0) {
              let lo = ut, hi = tHit;
              for (let i = 0; i < 24; i++) { const mid = 0.5 * (lo + hi); if (orbit.posAt(mid, _a).length() - body.radius > hT) lo = mid; else hi = mid; }
              tHit = lo;
            }
            const tGo = tHit - 1.6 * tBurn - 40;
            if (tGo > ut + 5) world.warpTo(tGo);
          }
        }
        break;
      }
      case 'brake': {
        mode(v, 'srfRetrograde');
        const need = needThrottle();
        _a.copy(v.surfaceVel).normalize().negate();
        const err = pointingError(v, _a);
        v.ctrl.throttle = err < 0.35 ? clamp(need, 0.1, 1) : 0.05;
        if (v.airspeed < 6 || v.radarAlt < o.stopAlt * 0.5) { c.phase = 'final'; c.note(`final descent from ${v.radarAlt.toFixed(0)} m`); }
        break;
      }
      case 'final': {
        // vertical descent: lean against the sideways drift, hold a descent rate that shrinks with height
        // touch down no harder than a fall from one metre would be there (legs bounce a long way in weak gravity)
        const r = v.pos.length();
        const g = body.gm / (r * r);
        let vsT = -clamp(v.radarAlt / 6, Math.min(o.touchdownSpeed, Math.max(0.4, Math.sqrt(2 * g))), 8);
        _a.copy(v.surfaceVel).addScaledVector(up, -v.verticalSpeed);       // horizontal drift
        // Leaning a hovering thrust of g sideways gives only g·tan(lean): in weak gravity lean harder for the same
        // drift, and do not go down the last metres until the drift is gone (a sideways touchdown there skips for minutes).
        const drift = _a.length(), lean = 0.12 * clamp(1.6 / g, 1, 12);
        // Committed: upright and slow a few metres up. From here it goes down whatever a brushing leg does to the
        // drift reading; climbing back to the hover height after first contact only makes it hop.
        if (v.radarAlt > 14) st.committed = false;
        let fastDrift = false;
        if (st.committed) { /* straight down */ }
        else if (g < 1.2) { if (drift > 0.35 && v.radarAlt < 16) { fastDrift = true; vsT = clamp((10 - v.radarAlt) * 0.3, -1, 1); } }
        else if (drift > 0.5 + 0.06 * v.radarAlt) { fastDrift = true; vsT = v.radarAlt < 14 ? clamp((9 - v.radarAlt) * 0.3, -1, 1) : Math.max(vsT, -1.5); }
        // A tall lander that touches down still leaning pivots over its first leg and falls (slowly, in weak gravity):
        // once the drift is small enough to land with, stand upright for the last metres, and wait above the ground
        // until it is upright.
        let leanMax = 0.35;
        if (v.radarAlt < 12 && !fastDrift) {
          leanMax = 0.05;
          if (st.committed) leanMax = 0;
          else if (pointingError(v, up) > 0.1) vsT = clamp((9 - v.radarAlt) * 0.3, -1, 1);
          else if (v.radarAlt < 5) st.committed = true;
        }
        dir.copy(up).addScaledVector(_a, -clamp(lean, 0, leanMax / Math.max(0.01, drift)));
        point(v, dir);
        const acc = v.maxThrust / v.mass;
        v.ctrl.throttle = clamp((g + (vsT - v.verticalSpeed) * 1.5) / acc, 0, 1);
        break;
      }
      default: break;
    }
  };
  return c;
}

// ---------------------------------------------------------------------------------------------
// Transfer planning
// ---------------------------------------------------------------------------------------------
/**
 * Plans a Hohmann-like transfer from a low orbit to a moon of the current body: searches the node time over
 * one synodic period and the prograde delta-v, using predictPatches, for an encounter whose periapsis is
 * close to opts.periapsis (altitude above the moon, default 15 % of its radius).
 * Adds the node to the vessel and returns {node, dv, periapsis (alt), encounterUt, arrivalUt, patches}, or null.
 */
export function planHohmannToMoon(world, vessel, moon, opts = {}) {
  const v = vessel, body = v.body, ut = world.ut;
  if (!moon || moon.parent !== body) return null;
  const o = { periapsis: moon.radius * 0.15, lead: 180, samples: 240, ...opts };
  const orbit = v.getOrbit(ut);
  if (orbit.hyper) return null;
  const gm = body.gm, r2 = moon.orbit.a;
  const T1 = orbit.period, T2 = moon.orbit.period;
  const synodic = 1 / Math.abs(1 / T1 - 1 / T2);
  const targetR = moon.radius + o.periapsis;
  const dvFor = t => {
    const s = orbit.stateAt(t), r1 = s.r.length();
    return Math.sqrt(gm * (2 / r1 - 2 / (r1 + r2))) - s.v.length();
  };
  const evaluate = (t, dv, nrm = 0) => {
    const o2 = applyManeuver(orbit, t, { prograde: dv, normal: nrm });
    const patches = predictPatches(o2, body, t, 3);
    const enc = patches.find(p => p.body === moon);
    if (!enc) return null;
    return { t, dv, pe: enc.orbit.periapsis, encounterUt: enc.tStart, arrivalUt: enc.tStart + enc.orbit.timeToPeriapsis(enc.tStart), patches, enc };
  };
  // coarse scan over the node time
  const t0 = ut + o.lead;
  let window = null;
  const hits = [];
  for (let i = 0; i <= o.samples; i++) {
    const t = t0 + synodic * i / o.samples;
    const r = evaluate(t, dvFor(t));
    if (r) { hits.push(r); if (!window) window = [t, t]; else window[1] = t; }
    else if (window) break;
  }
  if (!hits.length) return null;
  // fine scan of the first encounter window: closest periapsis to the target
  const step = synodic / o.samples;
  let best = null;
  const score = r => Math.abs(r.pe - targetR);
  const a = window[0] - step, b = window[1] + step;
  for (let i = 0; i <= 80; i++) {
    const t = a + (b - a) * i / 80;
    if (t < ut + 30) continue;
    const r = evaluate(t, dvFor(t));
    if (r && (!best || score(r) < score(best))) best = r;
  }
  if (!best) best = hits[0];
  // polish the node time with a shrinking bracket
  let h = (b - a) / 80;
  for (let k = 0; k < 24 && score(best) > 200; k++) {
    let improved = false;
    for (const t of [best.t - h, best.t + h]) {
      const r = evaluate(t, dvFor(t));
      if (r && score(r) < score(best)) { best = r; improved = true; }
    }
    if (!improved) h *= 0.5;
  }
  // and the delta-v by a few tenths of a m/s
  let hv = 2;
  for (let k = 0; k < 16 && score(best) > 200; k++) {
    let improved = false;
    for (const dv of [best.dv - hv, best.dv + hv]) {
      const r = evaluate(best.t, dv);
      if (r && score(r) < score(best)) { best = r; improved = true; }
    }
    if (!improved) hv *= 0.5;
  }
  const node = v.addNode(best.t, { prograde: best.dv });
  return { node, dv: best.dv, periapsis: best.pe - moon.radius, encounterUt: best.encounterUt, arrivalUt: best.arrivalUt, patches: best.patches };
}

/**
 * Plans the way home from a moon: `vessel` in a closed orbit of a moon, bound for the moon's parent. Leaves the moon
 * against its orbital motion so that the orbit around the parent dips to opts.periapsis (altitude above the parent;
 * default: 20 km above its air, or 15 % of its radius without air). Searches the node time over one orbit and then
 * polishes time and delta-v with predictPatches. Adds the node and returns
 *   { node, dv, periapsis (alt at the parent), exitUt, arrivalUt, patches }     or null (open orbit, not at a moon).
 */
export function planReturnFromMoon(world, vessel, opts = {}) {
  const v = vessel, moon = v.body, parent = moon.parent, ut = world.ut;
  if (!parent || !parent.parent || !moon.orbit) return null;
  const orbit = v.getOrbit(ut);
  if (orbit.hyper || !Number.isFinite(orbit.period)) return null;
  const o = { periapsis: parent.atmo ? parent.atmo.height + 20000 : parent.radius * 0.15, lead: 120, samples: 96, ...opts };
  const targetR = parent.radius + o.periapsis;
  const ms = moon.orbit.stateAt(ut), r2 = ms.r.length(), vMoon = ms.v.length();
  // speed wanted at the moon's distance on an ellipse that grazes targetR, and the excess to shed on leaving the moon
  const vInf = Math.max(1, vMoon - Math.sqrt(parent.gm * (2 / r2 - 2 / (r2 + targetR))));
  const dvFor = t => { const s = orbit.stateAt(t), r1 = s.r.length(); return Math.sqrt(vInf * vInf + 2 * moon.gm / r1) - s.v.length(); };
  const evaluate = (t, dv) => {
    const patches = predictPatches(applyManeuver(orbit, t, { prograde: dv }), moon, t, 3);
    const out = patches.find(p => p.body === parent);
    if (!out) return null;
    return { t, dv, pe: out.orbit.periapsis, exitUt: out.tStart, arrivalUt: out.tStart + out.orbit.timeToPeriapsis(out.tStart), patches };
  };
  const score = r => Math.abs(r.pe - targetR);
  let best = null;
  const t0 = ut + o.lead;
  for (let i = 0; i < o.samples; i++) {
    const t = t0 + orbit.period * i / o.samples;
    const r = evaluate(t, dvFor(t));
    if (r && (!best || score(r) < score(best))) best = r;
  }
  if (!best) return null;
  let h = orbit.period / o.samples, hv = Math.max(0.5, best.dv * 0.05);
  for (let k = 0; k < 60 && score(best) > 500; k++) {
    let improved = false;
    for (const [dt, dd] of [[-h, 0], [h, 0], [0, -hv], [0, hv]]) {
      const t = best.t + dt; if (t < ut + 30) continue;
      const r = evaluate(t, best.dv + dd);
      if (r && score(r) < score(best)) { best = r; improved = true; }
    }
    if (!improved) { h *= 0.5; hv *= 0.5; }
  }
  const node = v.addNode(best.t, { prograde: best.dv });
  return { node, dv: best.dv, periapsis: best.pe - parent.radius, exitUt: best.exitUt, arrivalUt: best.arrivalUt, patches: best.patches };
}

/**
 * Mid-course correction: adds a small node `delay` seconds from now (prograde + radial components) that
 * brings the periapsis of the coming encounter with `moon` to opts.periapsis (altitude).
 * Returns {node (null if no burn is needed), dv, periapsis (alt), encounterUt, arrivalUt} or null without an encounter.
 */
export function planCorrection(world, vessel, moon, opts = {}) {
  const v = vessel, body = v.body, ut = world.ut;
  const o = { periapsis: moon.radius * 0.15, delay: 240, ...opts };
  const orbit = v.getOrbit(ut);
  const t = ut + o.delay;
  const targetR = moon.radius + o.periapsis;
  // without an encounter yet (a near miss after a long burn) the search first closes the distance to the target
  const far = moon.parent === body && moon.orbit;
  const span = orbit.hyper || !Number.isFinite(orbit.period) ? moon.orbit.period : orbit.period;
  const evaluate = (p, r, n) => {
    const burn = p || r || n;
    const o2 = burn ? applyManeuver(orbit, t, { prograde: p, radial: r, normal: n }) : orbit;
    const enc = predictPatches(o2, body, burn ? t : ut, 3).find(x => x.body === moon);
    if (!enc) {
      if (!far || !o.seek) return null;
      const ca = closestApproach(o2, moon.orbit, t, t + (o.horizon || span), 240);
      return { p, r, n, pe: null, err: 1e11 + ca.distance, miss: ca.distance };
    }
    return { p, r, n, pe: enc.orbit.periapsis, err: Math.abs(enc.orbit.periapsis - targetR), encounterUt: enc.tStart, arrivalUt: enc.tStart + enc.orbit.timeToPeriapsis(enc.tStart) };
  };
  let best = evaluate(0, 0, 0);
  if (!best) return null;
  let h = best.pe === null ? 40 : 8;
  // pattern search: the step grows again after a success, so a path that starts without an encounter (hundreds of
  // m/s away) still ends within 100 m of the wanted periapsis instead of running out of rounds 100 km from it
  for (let k = 0; k < (o.seek ? 400 : 120) && best.err > 100 && h > 0.0005; k++) {
    let improved = false;
    for (const [dp, dr, dn] of [[h, 0, 0], [-h, 0, 0], [0, h, 0], [0, -h, 0], [0, 0, h], [0, 0, -h]]) {
      if (dn && !o.seek && !o.normal) continue;
      const e = evaluate(best.p + dp, best.r + dr, best.n + dn);
      if (e && e.err < best.err) { best = e; improved = true; }
    }
    h = improved ? Math.min(h * 1.6, 40) : h * 0.5;
  }
  // The periapsis is a V over each burn axis (zero where the path runs through the middle of the target), and the
  // search above can stall on its steep wall still 100 km out. Finish on one axis: step out until the error changes
  // sign, then bisect to 50 m.
  if (best.pe !== null && best.err > 100) {
    const b0 = best, f0 = b0.pe - targetR;
    polish: for (const [ap, ar, an] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      if (an && !o.seek && !o.normal) continue;
      const at = s => evaluate(b0.p + ap * s, b0.r + ar * s, b0.n + an * s);
      for (const sg of [1, -1]) {
        let lo = 0, hi = null;
        for (let s = 0.005; s <= 6; s *= 2) {
          const e = at(sg * s);
          if (!e || e.pe === null) break;
          if ((e.pe - targetR) * f0 < 0) { hi = sg * s; break; }
          lo = sg * s;
        }
        if (hi === null) continue;
        let e = null;
        for (let k = 0; k < 48; k++) {
          const mid = (lo + hi) / 2; e = at(mid);
          if (!e || e.pe === null) break;
          if (e.err < 50) break;
          if ((e.pe - targetR) * f0 < 0) hi = mid; else lo = mid;
        }
        if (e && e.pe !== null && e.err < best.err) best = e;
        if (best.err <= 100) break polish;
      }
    }
  }
  if (best.pe === null) return { node: null, dv: 0, periapsis: null, miss: best.miss, encounterUt: null, arrivalUt: null };
  const dv = Math.hypot(best.p, best.r, best.n);
  const node = dv > 0.05 ? v.addNode(t, { prograde: best.p, radial: best.r, normal: best.n }) : null;
  return { node, dv, periapsis: best.pe - moon.radius, encounterUt: best.encounterUt, arrivalUt: best.arrivalUt };
}

// ---------------------------------------------------------------------------------------------
// Rendezvous and docking (round 2)
// ---------------------------------------------------------------------------------------------
const _qi = new Quaternion();
/** Command RCS translation so that the inertial velocity error `err` (m/s) is removed in about `tau` seconds. */
function translate(vessel, err, tau = 0.8, deadband = 0.01) {
  const c = vessel.ctrl;
  const acc = vessel.rcsThrust / Math.max(1, vessel.mass);
  if (!(acc > 0) || err.lengthSq() < deadband * deadband) { c.tx = c.ty = c.tz = 0; return false; }
  c.rcs = true;
  _d.copy(err).applyQuaternion(_qi.copy(vessel.q).invert());
  c.tx = clamp(_d.x / (acc * tau), -1, 1); c.ty = clamp(_d.y / (acc * tau), -1, 1); c.tz = clamp(_d.z / (acc * tau), -1, 1);
  return true;
}
const hasRcs = v => v.rcsThrust > 0 && v.resources.mono && v.resources.mono.amount > 0.5;
function signedAngle(a, b, n) { _c.crossVectors(a, b); return Math.atan2(_c.dot(n), a.dot(b)); }

/**
 * Plan a Hohmann-like transfer from the vessel's (near-circular) orbit to meet `target` (a vessel in a
 * roughly co-planar orbit around the same body): waits for the phase angle, then one prograde/retrograde burn
 * whose far apsis touches the target's orbit as the target arrives there. The node time and delta-v are then
 * polished against closestApproach(). Adds the node and returns
 * {node, dv, approach: {t, distance, relSpeed}} — or null when the orbits are too alike to phase in
 * opts.maxWait seconds (default 3 days) or either orbit is open.
 */
export function planRendezvous(world, vessel, target, opts = {}) {
  const v = vessel, ut = world.ut, body = v.body;
  if (!target || target.body !== body) return null;
  const o = { lead: 150, maxWait: 259200, samples: 240, ...opts };
  const o1 = v.getOrbit(ut), o2 = target.getOrbit(ut);
  if (o1.hyper || o2.hyper) return null;
  const gm = body.gm, T1 = o1.period, T2 = o2.period;
  const synodic = 1 / Math.abs(1 / T1 - 1 / T2);
  if (!(synodic < o.maxWait)) return null;
  const H = o1.H, dir = new Vector3(), p2 = new Vector3();
  const guess = t => {
    const s = o1.stateAt(t), r1 = s.r.length();
    dir.copy(s.r).multiplyScalar(-1 / r1);
    const r2 = o2.radiusAtTrueAnomaly(Math.atan2(dir.dot(o2.Q), dir.dot(o2.P)));
    const at = (r1 + r2) / 2;
    const tt = Math.PI * Math.sqrt(at * at * at / gm);
    o2.posAt(t + tt, p2);
    p2.addScaledVector(H, -p2.dot(H));
    return { t, dv: Math.sqrt(gm * (2 / r1 - 1 / at)) - s.v.length(), tt, err: signedAngle(dir, p2, H) };
  };
  // scan one synodic period for the phase error crossing zero
  const t0 = ut + o.lead;
  let prev = guess(t0), hit = null;
  for (let i = 1; i <= o.samples && !hit; i++) {
    const cur = guess(t0 + synodic * 1.02 * i / o.samples);
    if (prev.err * cur.err <= 0 && Math.abs(prev.err - cur.err) < Math.PI) {
      let a = prev, b = cur;
      for (let k = 0; k < 40 && b.t - a.t > 0.01; k++) {
        const m = guess(0.5 * (a.t + b.t));
        if (a.err * m.err <= 0) b = m; else a = m;
      }
      hit = Math.abs(a.err) < Math.abs(b.err) ? a : b;
    }
    prev = cur;
  }
  if (!hit) return null;
  const score = (t, dv) => {
    const o3 = applyManeuver(o1, t, { prograde: dv });
    if (o3.hyper || o3.periapsis < body.radius + (body.atmo ? body.atmo.height : 0)) return { distance: Infinity, t, relSpeed: 0 };
    return closestApproach(o3, o2, t + 0.6 * hit.tt, t + 1.4 * hit.tt);
  };
  let best = { t: hit.t, dv: hit.dv, ca: score(hit.t, hit.dv) };
  let ht = 4, hv = 1;
  for (let k = 0; k < 60 && best.ca.distance > 50 && (ht > 0.02 || hv > 0.005); k++) {
    let improved = false;
    for (const [dt, dvv] of [[ht, 0], [-ht, 0], [0, hv], [0, -hv]]) {
      const t = best.t + dt, dv = best.dv + dvv;
      if (t < ut + 30) continue;
      const ca = score(t, dv);
      if (ca.distance < best.ca.distance) { best = { t, dv, ca }; improved = true; }
    }
    if (!improved) { ht *= 0.5; hv *= 0.5; }
  }
  if (!Number.isFinite(best.ca.distance)) return null;
  const node = v.addNode(best.t, { prograde: best.dv });
  return { node, dv: best.dv, approach: best.ca };
}

/**
 * Rendezvous controller: brings `vessel` (must be world.active) from a nearby, roughly co-planar orbit to rest
 * relative to `target` at about opts.distance metres (default 100): phasing wait and transfer burn through
 * maneuver nodes (planRendezvous), an optional mid-course correction against the predicted closest approach,
 * a braking burn that kills the relative velocity at closest approach, then a closed-loop approach.
 * Finishes with distance < opts.distance + 40 and relative speed < 0.3 m/s. Sets the vessel's target.
 * `c.result` = {distance, relSpeed, dvUsed} when done.
 */
export function rendezvous(world, vessel, target, opts = {}) {
  const v = vessel;
  const o = { distance: 100, useWarp: true, maxApproachSpeed: 12, offset: 15000, ...opts };
  const c = base(world, v, 'rendezvous');
  const st = {};
  const err = new Vector3(), want = new Vector3();
  c.dvUsed = 0;
  let sub = null;
  const runSub = () => {
    sub.update();
    if (!sub.done) return false;
    for (const l of sub.log) c.log.push({ t: l.t, msg: `${sub.name}: ${l.msg}` });
    const ok = !sub.failed;
    sub = null;
    return ok ? true : (c.finish(false, 'burn failed'), false);
  };
  const stop = () => { const k = v.ctrl; k.throttle = 0; k.tx = k.ty = k.tz = 0; };
  c.update = () => {
    if (c.done) return;
    if (v.dead) return c.finish(false, 'vessel lost');
    if (!target || target.dead) { stop(); return c.finish(false, 'target lost'); }
    if (target.body !== v.body) { stop(); return c.finish(false, 'target is not orbiting ' + v.body.name); }
    if (st.dv0 === undefined) st.dv0 = v.deltaV;
    if (v.targetId !== target.id) world.setTarget(v, target);
    const ut = world.ut;
    const info = v.targetInfo;
    if (!info) return;
    switch (c.phase) {
      case 'init':
        if (info.distance < 4000 && info.relSpeed < 40) { c.phase = 'close'; c.note(`target ${(info.distance / 1000).toFixed(2)} km away: closing in directly`); }
        else c.phase = 'plan';
        break;
      case 'plan': {
        v.nodes.length = 0;
        const plan = planRendezvous(world, v, target);
        if (plan) {
          st.plan = plan;
          c.note(`transfer node in ${((plan.node.t - ut) / 60).toFixed(1)} min: ${plan.dv.toFixed(1)} m/s, predicted closest approach ${plan.approach.distance.toFixed(0)} m at ${plan.approach.relSpeed.toFixed(1)} m/s`);
          sub = executeNode(world, v, { useWarp: o.useWarp });
          c.phase = 'transfer';
          break;
        }
        if (st.offsetDone) return c.finish(false, 'no rendezvous transfer found');
        // orbits too alike to phase: step the orbit down (or up) first
        st.offsetDone = true;
        const orbit = v.getOrbit(ut), body = v.body, gm = body.gm;
        const floor = body.radius + (body.atmo ? body.atmo.height + 6000 : 8000);
        st.up = orbit.periapsis - o.offset < floor;
        const t = ut + 90, s = orbit.stateAt(t), r = s.r.length();
        const a2 = (2 * r + (st.up ? o.offset : -o.offset)) / 2;
        v.addNode(t, { prograde: Math.sqrt(gm * (2 / r - 1 / a2)) - s.v.length() });
        c.note(`orbits too alike to phase: moving ${(o.offset / 1000).toFixed(0)} km ${st.up ? 'up' : 'down'} first`);
        sub = executeNode(world, v, { useWarp: o.useWarp });
        c.phase = 'offset1';
        break;
      }
      case 'offset1':
        if (runSub()) { planCircularize(world, v, st.up ? 'apoapsis' : 'periapsis'); sub = executeNode(world, v, { useWarp: o.useWarp }); c.phase = 'offset2'; }
        break;
      case 'offset2':
        if (runSub()) c.phase = 'plan';
        break;
      case 'transfer':
        if (runSub()) c.phase = 'coast';
        break;
      case 'coast': {
        const o1 = v.getOrbit(ut), o2 = target.getOrbit(ut);
        const tEnd = Math.max(st.plan ? st.plan.approach.t : 0, ut) + 0.3 * o1.period;
        let ca = closestApproach(o1, o2, ut, tEnd);
        if (!st.corrected && ca.distance > 1500 && ca.t - ut > 400) {
          st.corrected = true;
          const t = ut + 75;
          const sc = (p, r, n) => closestApproach(applyManeuver(o1, t, { prograde: p, radial: r, normal: n }), o2, ca.t - 300, ca.t + 300);
          let best = { p: 0, r: 0, n: 0, ca };
          let h = 4;
          for (let k = 0; k < 80 && best.ca.distance > 100 && h > 0.01; k++) {
            let improved = false;
            for (const [dp, dr, dn] of [[h, 0, 0], [-h, 0, 0], [0, h, 0], [0, -h, 0], [0, 0, h], [0, 0, -h]]) {
              const e = sc(best.p + dp, best.r + dr, best.n + dn);
              if (e.distance < best.ca.distance) { best = { p: best.p + dp, r: best.r + dr, n: best.n + dn, ca: e }; improved = true; }
            }
            if (!improved) h *= 0.5;
          }
          const dv = Math.hypot(best.p, best.r, best.n);
          if (dv > 0.05) {
            v.addNode(t, { prograde: best.p, radial: best.r, normal: best.n });
            c.note(`mid-course correction ${dv.toFixed(2)} m/s → closest approach ${best.ca.distance.toFixed(0)} m`);
            sub = executeNode(world, v, { useWarp: o.useWarp });
            c.phase = 'transfer';
            break;
          }
          ca = best.ca;
        }
        st.ca = ca;
        const tb = stagedBurnTime(v, ca.relSpeed);
        st.tBrake = ca.t - (Number.isFinite(tb) ? tb : 0) / 2 - 1;
        c.note(`closest approach ${ca.distance.toFixed(0)} m at ${ca.relSpeed.toFixed(1)} m/s in ${((ca.t - ut) / 60).toFixed(1)} min`);
        c.phase = 'toBrake';
        break;
      }
      case 'toBrake':
        mode(v, 'relRetrograde');
        v.ctrl.throttle = 0;
        if (ut < st.tBrake - 27) { if (o.useWarp && world.warpTarget === null) world.warpTo(st.tBrake - 25); break; }
        if (ut >= st.tBrake || (info.distance < 400 && info.closing > 0)) { c.phase = 'brake'; c.note(`braking burn: ${info.relSpeed.toFixed(1)} m/s at ${info.distance.toFixed(0)} m`); }
        break;
      case 'brake': {
        mode(v, 'relRetrograde');
        if (v.enginePower().thrust <= 0 && !autoStage(world, v, st) && !v.hasEngineStagesLeft()) { stop(); return c.finish(false, 'out of propellant'); }
        const acc = Math.max(0.05, v.maxThrust / v.mass);
        _a.copy(info.relVel).normalize().negate();
        const pe = pointingError(v, _a);
        v.ctrl.throttle = pe < 0.1 || (info.relSpeed < 3 && pe < 0.5) ? clamp(info.relSpeed / (acc * 1.2), 0.004, 1) : 0;
        if (info.relSpeed < 0.6) { v.ctrl.throttle = 0; c.phase = 'close'; st.tClose = ut; c.note(`relative velocity killed ${info.distance.toFixed(0)} m from the target`); }
        break;
      }
      case 'close': {
        if (st.tClose === undefined) st.tClose = ut;
        const d = info.distance;
        const arrived = d <= o.distance;
        if (arrived && !st.arrived) { st.arrived = true; }
        const sp = st.arrived ? 0 : clamp((d - o.distance * 0.8) / 50, 0.4, o.maxApproachSpeed);
        want.copy(info.dir).multiplyScalar(sp);
        err.copy(want).sub(info.relVel);
        const e = err.length();
        if (st.arrived && info.relSpeed < 0.25) {
          stop(); mode(v, 'hold');
          c.dvUsed = st.dv0 - v.estimateDeltaV();
          c.result = { distance: d, relSpeed: info.relSpeed, dvUsed: c.dvUsed };
          return c.finish(true, `holding ${d.toFixed(0)} m from ${target.name} at ${info.relSpeed.toFixed(2)} m/s`);
        }
        if (ut - st.tClose > 3 * v.period) { stop(); return c.finish(false, 'could not close in on the target'); }
        const band = st.arrived ? 0.08 : Math.max(0.15, 0.06 * sp);
        if (st.burning ? e < band * 0.4 : e < band) {
          st.burning = false; stop();
          if (!st.arrived) mode(v, 'target');
          break;
        }
        st.burning = true;
        if (hasRcs(v) && e < 4) {
          v.ctrl.throttle = 0;
          if (v.ctrl.sasMode !== 'hold') mode(v, 'hold');
          translate(v, err, 1.0);
        } else {
          v.ctrl.tx = v.ctrl.ty = v.ctrl.tz = 0;
          if (v.enginePower().thrust <= 0) { stop(); return c.finish(false, 'out of propellant'); }
          point(v, err);
          const acc = Math.max(0.05, v.maxThrust / v.mass);
          _a.copy(err).normalize();
          const pe = pointingError(v, _a);
          v.ctrl.throttle = pe < 0.08 ? clamp(e / (acc * 1.5), 0.004, 1) : 0;
        }
        break;
      }
      default: break;
    }
  };
  return c;
}

/**
 * Docking controller: flies `vessel` (world.active, with RCS blocks and monopropellant) from within a few
 * hundred metres of `target` to a latch. It keeps the two port axes nose to nose with SAS, steers clear of the
 * target's hull to a stand-off point on the port axis, then closes along the axis at 0.3–0.5 m/s with RCS
 * translation. opts: portId (own port), targetPortId, standoff (m), maxSpeed (m/s, far approach), timeout (s).
 * Done when the World has merged the two vessels (`dock` event); `c.result` = {portId, time}.
 */
export function dockingApproach(world, vessel, target, opts = {}) {
  const v = vessel;
  const o = { maxSpeed: 3, timeout: 3600, ...opts };
  const c = base(world, v, 'docking');
  const st = {};
  const PT = new Vector3(), NT = new Vector3(), PM = new Vector3(), NM = new Vector3(), rel = new Vector3(),
    lat = new Vector3(), goal = new Vector3(), vT = new Vector3(), cmd = new Vector3(), lhat = new Vector3();
  const stop = () => { const k = v.ctrl; k.throttle = 0; k.tx = k.ty = k.tz = 0; };
  c.update = () => {
    if (c.done) return;
    if (target && (target.absorbedInto === v || v.absorbedInto === target)) {
      stop(); if (!v.dead) mode(v, 'hold');
      c.result = { portId: st.mp ? st.mp.id : null, time: world.ut - (st.t0 || world.ut) };
      return c.finish(true, `docked with ${target.name}`);
    }
    if (v.dead) return c.finish(false, 'vessel lost');
    if (!target || target.dead) { stop(); return c.finish(false, 'target lost'); }
    const ut = world.ut;
    if (st.t0 === undefined) {
      st.t0 = ut;
      if (v.targetId !== target.id) world.setTarget(v, target);
    }
    // ports (re-resolved every update: the part set can change)
    const mp = (o.portId !== undefined && v.dockPorts.find(p => p.id === o.portId)) || v.dockPorts[0];
    if (!mp) { stop(); return c.finish(false, 'no free docking port on this vessel'); }
    let tp = o.targetPortId !== undefined ? target.dockPorts.find(p => p.id === o.targetPortId) : null;
    if (!tp) {
      let bd = Infinity;
      v.portWorld(mp, PM);
      for (const p of target.dockPorts) {
        if (p.def.dock.size !== mp.def.dock.size) continue;
        const d = target.portWorld(p, PT).distanceToSquared(PM);
        if (d < bd) { bd = d; tp = p; }
      }
    }
    if (!tp) { stop(); return c.finish(false, `no free size-${mp.def.dock.size} docking port on ${target.name}`); }
    if (!hasRcs(v)) { stop(); return c.finish(false, 'docking needs RCS thrusters and monopropellant'); }
    if (ut - st.t0 > o.timeout) { stop(); return c.finish(false, 'docking timed out'); }
    st.mp = mp;
    target.portWorld(tp, PT, NT); v.portWorld(mp, PM, NM);
    rel.copy(PM).sub(PT);
    const a = rel.dot(NT);
    lat.copy(rel).addScaledVector(NT, -a);
    const rho = lat.length();
    target.pointVelocity(tp.pos.x, tp.pos.y + tp._face * tp.def.h / 2, tp.pos.z, vT);
    // attitude: my port axis opposite to the target's
    _a.copy(NT).multiplyScalar(-mp._face);
    point(v, _a);
    v.ctrl.throttle = 0;
    const align = NM.angleTo(_b.copy(NT).negate());
    const Rs = target.boundRadius + v.boundRadius + 3;
    const S = o.standoff ?? Math.max(8, Math.min(Rs, 20));
    if (rho > 1e-3) lhat.copy(lat).multiplyScalar(1 / rho);
    else { lhat.set(1, 0, 0); if (Math.abs(NT.x) > 0.9) lhat.set(0, 0, 1); lhat.addScaledVector(NT, -lhat.dot(NT)).normalize(); }
    let phase;
    if (rho < 0.15 + 0.06 * Math.max(0, a) && a > -0.3) phase = 'final';
    else if (a < 0.5 * S && rho < Rs) phase = 'clear';
    else if (a < 0.8 * S) phase = 'forward';
    else phase = 'align';
    if (phase !== c.phase) { c.phase = phase; c.note(`${phase}: ${rel.length().toFixed(1)} m from the port, ${rho.toFixed(1)} m off its axis`); }
    if (phase === 'final') {
      const ok = align < 0.07;
      const sAx = !ok ? 0 : a > 1.5 ? 0.5 : 0.35;
      cmd.copy(NT).multiplyScalar(-sAx).addScaledVector(lat, -0.3);
    } else {
      if (phase === 'clear') goal.copy(PT).addScaledVector(NT, a).addScaledVector(lhat, Rs * 1.3);
      else if (phase === 'forward') goal.copy(PT).addScaledVector(NT, S).addScaledVector(lhat, Math.max(rho, Rs));
      else goal.copy(PT).addScaledVector(NT, Math.max(S, Math.min(a, 2 * S)));
      goal.sub(PM);
      const g = goal.length();
      cmd.copy(goal).multiplyScalar(g > 1e-6 ? Math.min(o.maxSpeed, 0.1 * g + 0.05) / g : 0);
    }
    cmd.add(vT).sub(v.vel);
    translate(v, cmd, 0.8, 0.008);
  };
  return c;
}

// ---------------------------------------------------------------------------------------------
// Interplanetary transfers (second pass)
// ---------------------------------------------------------------------------------------------
const wrapPi = a => { a %= TAU; return a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a; };

/**
 * Next Hohmann-style launch window from `from` to `to` (two bodies orbiting the same parent: planet to planet, or
 * moon to moon) at or after `t0`. The window is where the target, one transfer time later, sits opposite the
 * departure point. Returns
 *   { t, tof, phase (rad, target ahead of `from` at departure), phaseNow (at t0), wait (s), synodic (s),
 *     vInfDepart, vInfArrive (m/s, speeds relative to each body), outward (bool), dir (unit Vector3: the direction,
 *     in the non-rotating frame, in which to leave `from`), ejectionDv(r0) (m/s from a circular orbit of radius r0),
 *     ejectionAngle(r0) (rad between the burn point and that direction, measured against the orbit's motion),
 *     captureDv(r0) (m/s into a circular orbit of radius r0 at the target) }
 * or null when the bodies do not share a parent.
 */
export function transferWindow(from, to, t0 = 0, opts = {}) {
  if (!from || !to || from === to || !from.parent || from.parent !== to.parent) return null;
  const mu = from.parent.gm;
  const p1 = new Vector3(), p2 = new Vector3(), v1 = new Vector3(), n = new Vector3();
  const T1 = from.orbit.period, T2 = to.orbit.period;
  const synodic = 1 / Math.abs(1 / T1 - 1 / T2);
  const tofAt = t => {
    from.posAt(t, p1);
    let tof = Math.PI * Math.sqrt(Math.pow((p1.length() + to.orbit.a) / 2, 3) / mu);
    for (let i = 0; i < 4; i++) { to.posAt(t + tof, p2); tof = Math.PI * Math.sqrt(Math.pow((p1.length() + p2.length()) / 2, 3) / mu); }
    return tof;
  };
  // signed angle from `from` (at t) to `to` (at t + dt), measured along the motion of `from`
  const angle = (t, dt) => {
    from.posAt(t, p1); from.velAt(t, v1); to.posAt(t + dt, p2);
    n.crossVectors(p1, v1).normalize();
    p2.addScaledVector(n, -p2.dot(n));
    return Math.atan2(_c.crossVectors(p1, p2).dot(n), p1.dot(p2));
  };
  const miss = t => wrapPi(angle(t, tofAt(t)) - Math.PI);
  const span = Math.min(synodic * 1.05, opts.maxWait || Infinity), N = opts.samples || 400;
  let ta = t0, fa = miss(ta), t = null;
  for (let i = 1; i <= N; i++) {
    const tb = t0 + span * i / N, fb = miss(tb);
    if (fa === 0 || (fa * fb < 0 && Math.abs(fa - fb) < Math.PI)) {
      let lo = ta, hi = tb, flo = fa;
      for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2, fm = miss(mid); if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; } }
      t = (lo + hi) / 2;
      break;
    }
    ta = tb; fa = fb;
  }
  if (t === null) return null;
  const tof = tofAt(t);
  from.posAt(t, p1); from.velAt(t, v1); to.posAt(t + tof, p2);
  const r1 = p1.length(), r2 = p2.length(), a = (r1 + r2) / 2;
  n.crossVectors(p1, v1).normalize();
  const tang = new Vector3().crossVectors(n, p1).normalize();              // along the motion, square to the radius
  const vDep = Math.sqrt(mu * (2 / r1 - 1 / a)), vArr = Math.sqrt(mu * (2 / r2 - 1 / a));
  const vinf = tang.clone().multiplyScalar(vDep).sub(v1);
  const vInfDepart = vinf.length();
  const vTo = to.velAt(t + tof, new Vector3());
  const tang2 = new Vector3().crossVectors(n, p2).normalize();
  const vInfArrive = tang2.multiplyScalar(vArr).sub(vTo).length();
  const out = {
    t, tof, phase: angle(t, 0), phaseNow: angle(t0, 0), wait: t - t0, synodic, vInfDepart, vInfArrive, outward: r2 > r1,
    dir: vinf.clone().normalize(),
    ejectionDv: r0 => Math.sqrt(vInfDepart * vInfDepart + 2 * from.gm / r0) - Math.sqrt(from.gm / r0),
    ejectionAngle: r0 => Math.acos(-1 / (1 + r0 * vInfDepart * vInfDepart / from.gm)),
    captureDv: r0 => Math.sqrt(vInfArrive * vInfArrive + 2 * to.gm / r0) - Math.sqrt(to.gm / r0),
  };
  return out;
}

/**
 * Plans the ejection burn of an interplanetary transfer: `vessel` in a closed orbit of a body, `target` another
 * body sharing that body's parent. Finds the window (transferWindow), puts the node where the escape leaves along
 * the right direction (the ejection angle), then polishes node time and delta-v with predictPatches until the
 * trajectory meets the target, aiming for opts.periapsis (altitude at the target, default 4 × its radius or just
 * above its atmosphere). Adds the node. Returns
 *   { node, dv, window, periapsis (alt at the target, or null without an encounter), miss (m: closest pass when
 *     there is no encounter yet), encounterUt, arrivalUt, patches }
 * or null if no window or the vessel is not in a closed orbit. A mid-course planCorrection() after the burn is
 * normal: the burn is long and the search is patched-conic.
 */
export function planInterplanetary(world, vessel, target, opts = {}) {
  const v = vessel, body = v.body, ut = world.ut;
  if (!target || !body.parent || target.parent !== body.parent || target === body) return null;
  const orbit = v.getOrbit(ut);
  if (orbit.hyper) return null;
  const win = transferWindow(body, target, ut + (opts.lead || 300), opts);
  if (!win) return null;
  const targetPe = target.radius + (opts.periapsis ?? Math.max(target.radius * 4, (target.atmo ? target.atmo.height : 0) + 20000));
  const T = orbit.period;
  // node position: the escape hyperbola turns through ν∞ from its periapsis to its outgoing leg
  const h = _a.crossVectors(orbit.stateAt(win.t).r, orbit.stateAt(win.t).v).normalize().clone();
  const want = win.dir.clone().addScaledVector(h, -win.dir.dot(h)).normalize();
  const s0 = orbit.stateAt(win.t);
  const r0 = s0.r.length();
  const turn = win.ejectionAngle(r0);
  const pHat = want.clone().applyAxisAngle(h, -turn);
  let tNode = win.t, bestAng = Infinity;
  for (let i = 0; i < 360; i++) {
    const t = win.t + T * i / 360;
    const ang = orbit.stateAt(t).r.angleTo(pHat);
    if (ang < bestAng) { bestAng = ang; tNode = t; }
  }
  // v∞ is wanted at the edge of the sphere of influence, not at infinity: the energy there is v∞²/2 - GM/r_soi
  const dv0 = (() => { const s = orbit.stateAt(tNode), r = s.r.length(); return Math.sqrt(win.vInfDepart * win.vInfDepart + 2 * body.gm / r - 2 * body.gm / body.soi) - s.v.length(); })();
  const parent = body.parent;
  // The miss is judged in the plane of the departure planet's orbit: timing and burn size can only close the
  // in-plane miss. What the tilt of the target's orbit adds is left to the mid-course correction (or, without
  // opts.planar, to a normal component found below).
  const nPl = new Vector3().crossVectors(body.posAt(win.t, _a), body.velAt(win.t, _b)).normalize().clone();
  const pS = new Vector3(), pT = new Vector3();
  const sep = (o, t) => {
    o.posAt(t, pS); target.posAt(t, pT);
    pS.addScaledVector(nPl, -pS.dot(nPl)); pT.addScaledVector(nPl, -pT.dot(nPl));
    return pS.distanceTo(pT);
  };
  const planeMiss = (o, ta, tb) => {
    const N = 160, g = 0.6180339887498949;
    let bi = 0, bd = Infinity;
    for (let i = 0; i <= N; i++) { const d = sep(o, ta + (tb - ta) * i / N); if (d < bd) { bd = d; bi = i; } }
    let a = ta + (tb - ta) * Math.max(0, bi - 1) / N, b = ta + (tb - ta) * Math.min(N, bi + 1) / N;
    let c1 = b - g * (b - a), c2 = a + g * (b - a), f1 = sep(o, c1), f2 = sep(o, c2);
    for (let k = 0; k < 40 && b - a > 1; k++) {
      if (f1 < f2) { b = c2; c2 = c1; f2 = f1; c1 = b - g * (b - a); f1 = sep(o, c1); }
      else { a = c1; c1 = c2; f1 = f2; c2 = a + g * (b - a); f2 = sep(o, c2); }
    }
    return Math.min(f1, f2, bd);
  };
  const evaluate = (t, dv, nrm = 0, full = false) => {
    const o2 = applyManeuver(orbit, t, { prograde: dv, normal: nrm });
    const patches = predictPatches(o2, body, t, 4);
    const enc = patches.find(p => p.body === target);
    if (enc) {
      return { t, dv, nrm, enc, patches, pe: enc.orbit.periapsis, cost: Math.abs(enc.orbit.periapsis - targetPe), inPlane: 0, encounterUt: enc.tStart,
        arrivalUt: enc.tStart + enc.orbit.timeToPeriapsis(enc.tStart) };
    }
    const sun = patches.find(p => p.body === parent);
    if (!sun) return { t, dv, nrm, patches, cost: 1e15, inPlane: Infinity, miss: Infinity };
    const inPlane = planeMiss(sun.orbit, sun.tStart + win.tof * 0.5, sun.tStart + win.tof * 1.5);
    const e = { t, dv, nrm, patches, cost: 1e11 + inPlane, inPlane, miss: inPlane };
    if (full) { e.miss = closestApproach(sun.orbit, target.orbit, sun.tStart + win.tof * 0.5, sun.tStart + win.tof * 1.5, 200).distance; e.cost = 1e11 + e.miss; }
    return e;
  };
  let best = evaluate(tNode, dv0);
  // The phase-angle window is good to a day or so (real orbits are neither circular nor coplanar), and a day is
  // far cheaper to fix by leaving a few orbits earlier or later than by burning harder: scan whole orbits around it.
  const kMin = Math.ceil((ut + (opts.lead || 300) - tNode) / T);
  if (!best.enc) {
    const slack = opts.slack ?? 4 * 86400;
    const kMax = Math.floor(slack / T);
    const stride = Math.max(1, Math.ceil((kMax - Math.max(kMin, -kMax)) / 160));
    let bk = 0;
    for (let k = Math.max(kMin, -kMax); k <= kMax; k += stride) {
      if (k === 0) continue;
      const e = evaluate(tNode + k * T, dv0);
      if (e.cost < best.cost) { best = e; bk = k; }
    }
    for (let k = bk - stride + 1; stride > 1 && k < bk + stride; k++) {
      if (k < kMin) continue;
      const e = evaluate(tNode + k * T, dv0);
      if (e.cost < best.cost) best = e;
    }
  }
  // Whole orbits are coarse steps for a small target: close what is left of the in-plane miss with the burn size, a
  // little at a time and re-checking the neighbouring orbits, so the transfer stays close to the cheapest one.
  const near = 0.25 * target.soi;
  {
    let hv = dv0 * 0.004;
    for (let it = 0; it < 30 && !best.enc && best.inPlane > near && hv > 0.02; it++) {
      let improved = false;
      for (const dd of [hv, -hv]) for (const kk of [0, 1, -1, 2, -2]) {
        const tt = best.t + kk * T;
        if (tt < tNode + kMin * T - 1) continue;
        const e = evaluate(tt, best.dv + dd);
        if (e.enc || e.inPlane < best.inPlane) { best = e; improved = true; if (e.enc) break; }
      }
      if (!improved) hv *= 0.5;
    }
  }
  if (!best.enc) {
    // A direct hit may still be within reach of nearly the same burn, when the target is near the departure plane
    // as the ship arrives. Look for one from the in-plane solution and from the departure that passes closest in
    // three dimensions, never straying more than 2.5 % from the minimum-energy burn (a harder burn is a faster,
    // costlier transfer), and take it only if it is cheaper overall than fixing the tilt in mid-course.
    const seekHit = (from, bound) => {
      // moves: burn size, whole orbits, and the place of the burn on the parking orbit (which turns the way out)
      let cand = from, hv = dv0 * 0.003, ht = T / 48;
      for (let it = 0; it < 40 && !cand.enc && (hv > 0.02 || ht > 0.05); it++) {
        let improved = false;
        for (const [dt, dd] of [[0, hv], [0, -hv], [T, 0], [-T, 0], [ht, 0], [-ht, 0], [T, hv], [T, -hv], [-T, hv], [-T, -hv]]) {
          const tt = cand.t + dt;
          if (tt < tNode + kMin * T - 1 || Math.abs(cand.dv + dd - dv0) > bound * Math.abs(dv0)) continue;
          const e = evaluate(tt, cand.dv + dd, 0, true);
          if (e.cost < cand.cost) { cand = e; improved = true; if (e.enc) break; }
        }
        if (!improved) { hv *= 0.5; ht *= 0.5; }
      }
      return cand.enc ? cand : null;
    };
    let hit = seekHit(evaluate(best.t, best.dv, 0, true), 0.015);
    if (!hit) {
      const kMax = Math.floor((opts.slack ?? 4 * 86400) / T), k0 = Math.max(kMin, -kMax);
      const stride = Math.max(1, Math.ceil((kMax - k0) / 120));
      let near3 = null;
      for (let k = k0; k <= kMax; k += stride) { const e = evaluate(tNode + k * T, dv0, 0, true); if (!near3 || e.cost < near3.cost) near3 = e; }
      if (near3) hit = near3.enc ? near3 : seekHit(near3, 0.025);
    }
    if (hit) {
      const cap = vInf => Math.sqrt(vInf * vInf + 2 * target.gm / targetPe) - Math.sqrt(target.gm / targetPe);
      // what the in-plane plan still owes: turning the path through the target's out-of-plane angle in mid-course
      const sun = best.patches.find(p => p.body === parent);
      const tArr = (sun ? sun.tStart : best.t) + win.tof;
      target.posAt(tArr, pT);
      const tiltCost = sun ? sun.orbit.stateAt(sun.tStart + 0.5 * win.tof).v.length() * Math.abs(pT.dot(nPl)) / pT.length() : 0;
      const direct = Math.abs(hit.dv) + cap(Math.sqrt(target.gm / -hit.enc.orbit.a));
      if (direct <= Math.abs(best.dv) + tiltCost + cap(win.vInfArrive)) best = hit;
    }
  }
  if (!opts.planar && !best.enc) {
    // out of plane: a normal component at the burn; kept only if it does reach the target at a sane price
    const planarBest = best;
    best = evaluate(best.t, best.dv, 0, true);
    // Newton steps on the miss vector at closest approach bring a near miss inside the target's sphere of influence
    const missAt = (e, t) => {
      const sun = e.patches.find(p => p.body === parent);
      if (!sun) return null;
      return sun.orbit.stateAt(t).r.clone().sub(target.orbit.stateAt(t).r);
    };
    for (let k = 0; k < 12 && !best.enc && Number.isFinite(best.miss); k++) {
      const sun = best.patches.find(p => p.body === parent);
      const tca = closestApproach(sun.orbit, target.orbit, sun.tStart + win.tof * 0.5, sun.tStart + win.tof * 1.5, 200).t;
      const f0 = missAt(best, tca);
      // the plane square to the approach velocity: a miss along the approach is only a matter of arriving earlier
      const vrel = sun.orbit.stateAt(tca).v.clone().sub(target.orbit.stateAt(tca).v).normalize();
      const e1 = new Vector3().crossVectors(vrel, h).normalize(), e2 = new Vector3().crossVectors(vrel, e1);
      const st = 0.5, sn = 1;
      const fa = missAt(evaluate(best.t, best.dv + st, best.nrm, true), tca), fb = missAt(evaluate(best.t, best.dv, best.nrm + sn, true), tca);
      if (!fa || !fb) break;
      fa.sub(f0).multiplyScalar(1 / st); fb.sub(f0).multiplyScalar(1 / sn);
      const a11 = fa.dot(e1), a12 = fb.dot(e1), a21 = fa.dot(e2), a22 = fb.dot(e2), b1 = -f0.dot(e1), b2 = -f0.dot(e2);
      let x0, x2;
      const det = a11 * a22 - a12 * a21;
      if (Math.abs(det) < 1e-12) { x0 = Math.abs(a11) > 1e-12 ? b1 / a11 : 0; x2 = 0; }
      else { x0 = (b1 * a22 - a12 * b2) / det; x2 = (a11 * b2 - a21 * b1) / det; }
      const scale = Math.min(1, 60 / Math.abs(x0 || 1e-9), 120 / Math.abs(x2 || 1e-9));
      x0 *= scale; x2 *= scale;
      const e = evaluate(best.t, best.dv + x0, best.nrm + x2, true);
      if (e.cost >= best.cost) break;
      best = e;
    }
    if (!best.enc || Math.hypot(best.dv, best.nrm) > 1.15 * Math.abs(planarBest.dv) + 20) best = planarBest;
  }
  if (best.enc) {
    // on an encounter course: trim the periapsis
    // (the burn stays within 1 % of where it was: the periapsis is set by aim, not by a faster transfer)
    let ht = T / 400, hv = 1, hn = opts.planar ? 0 : 2;
    const dvTrim = best.dv;
    for (let k = 0; k < 200 && best.cost > 2000 && (ht > 0.02 || hv > 0.002); k++) {
      let improved = false;
      for (const [dt, dd, dn] of [[ht, 0, 0], [-ht, 0, 0], [0, hv, 0], [0, -hv, 0], [0, 0, hn], [0, 0, -hn]]) {
        if (best.t + dt < ut + 60 || (!dt && !dd && !dn) || Math.abs(best.dv + dd - dvTrim) > 0.01 * Math.abs(dv0)) continue;
        const e = evaluate(best.t + dt, best.dv + dd, best.nrm + dn);
        if (e.enc && e.cost < best.cost) { best = e; improved = true; }
      }
      if (!improved) { ht *= 0.5; hv *= 0.5; hn *= 0.5; }
    }
  } else {
    const sun = best.patches.find(p => p.body === parent);
    if (sun) best.miss = closestApproach(sun.orbit, target.orbit, sun.tStart + win.tof * 0.5, sun.tStart + win.tof * 1.5, 200).distance;
  }
  const node = v.addNode(best.t, { prograde: best.dv, normal: best.nrm });
  return { node, dv: Math.hypot(best.dv, best.nrm), window: win, periapsis: best.enc ? best.pe - target.radius : null, miss: best.enc ? 0 : best.miss,
    encounterUt: best.encounterUt ?? null, arrivalUt: best.arrivalUt ?? null, patches: best.patches };
}

/**
 * Plane match: a node at whichever crossing of the target's orbital plane is cheaper (usually the higher, slower
 * one) that turns the vessel's orbit into that plane, keeping its speed. `target` is a moon of the vessel's body
 * or another vessel around it. Arriving from another planet leaves you in whatever plane the approach gave, and a
 * small moon cannot be met from an orbit tilted against its own. Adds the node and returns
 *   { node, dv, inclination (rad, before the burn), t } — node is null when the planes already agree to opts.tolerance
 * (default 0.2°); returns null for an open orbit.
 */
export function planMatchPlane(world, vessel, target, opts = {}) {
  const v = vessel, ut = world.ut;
  const orbit = v.getOrbit(ut);
  if (orbit.hyper || !Number.isFinite(orbit.period)) return null;
  const ts = target.orbit ? target.orbit.stateAt(ut) : target.getOrbit(ut).stateAt(ut);
  const nT = new Vector3().crossVectors(ts.r, ts.v).normalize();
  const s0 = orbit.stateAt(ut);
  const h = new Vector3().crossVectors(s0.r, s0.v).normalize();
  const inclination = h.angleTo(nT);
  if (inclination < (opts.tolerance ?? 0.0035)) return { node: null, dv: 0, inclination, t: ut };
  const T = orbit.period, t0 = ut + (opts.lead || 120), N = 720;
  const side = t => orbit.stateAt(t).r.dot(nT);
  let best = null, fa = side(t0);
  for (let i = 1; i <= N; i++) {
    const ta = t0 + T * (i - 1) / N, tb = t0 + T * i / N, fb = side(tb);
    if (fa * fb <= 0 && fa !== fb) {
      let lo = ta, hi = tb, flo = fa;
      for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2, fm = side(mid); if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; } }
      const t = (lo + hi) / 2, st = orbit.stateAt(t);
      const r = st.r.clone(), vel = st.v.clone();
      // the new velocity keeps its radial part and its speed, and lies in the target's plane, going the same way round
      const rHat = r.clone().normalize();
      const vr = vel.dot(rHat);
      const tangOld = vel.clone().addScaledVector(rHat, -vr);
      const tangNew = new Vector3().crossVectors(nT, rHat).normalize().multiplyScalar(tangOld.length());
      const dvec = tangNew.addScaledVector(rHat, vr).sub(vel);
      if (!best || dvec.length() < best.dvec.length()) best = { t, r, vel, dvec };
    }
    fa = fb;
  }
  if (!best) return null;
  const pro = best.vel.clone().normalize();
  const nrm = new Vector3().crossVectors(best.r, best.vel).normalize();
  const rad = new Vector3().crossVectors(pro, nrm);
  const node = v.addNode(best.t, { prograde: best.dvec.dot(pro), normal: best.dvec.dot(nrm), radial: best.dvec.dot(rad) });
  return { node, dv: best.dvec.length(), inclination, t: best.t };
}

/**
 * Aerobraking forecast: flies the vessel's current path through the atmosphere of its body numerically (drag
 * only, a constant ballistic coefficient taken from the vessel's mass and frontal drag area) for one pass.
 * Cheap enough to call a few times a second. Returns
 *   { enters (bool), periapsis (alt of the lowest point), speedIn, speedOut, dv (speed lost),
 *     outcome: 'none' | 'capture' | 'flyby' | 'landing', apoapsis (alt after the pass, Infinity if still escaping),
 *     maxQ (Pa), maxG }.
 */
export function predictAerobrake(world, vessel, opts = {}) {
  const v = vessel, body = v.body;
  const out = { enters: false, periapsis: v.periapsis, speedIn: 0, speedOut: 0, dv: 0, outcome: 'none', apoapsis: v.apoapsis, maxQ: 0, maxG: 0 };
  if (!body.atmo) return out;
  const H = body.atmo.height, R = body.radius, gm = body.gm;
  const orbit = v.getOrbit(world.ut);
  if (orbit.periapsis > R + H) return out;
  // start where the path meets the top of the atmosphere (or here, if already inside)
  const pos = new Vector3(), vel = new Vector3();
  if (v.pos.length() > R + H) {
    const t = orbit.timeAtRadius(R + H, true, world.ut);
    if (!Number.isFinite(t)) return out;
    orbit._state(t, pos, vel);
  } else { pos.copy(v.pos); vel.copy(v.vel); }
  const cda = opts.cda ?? aeroArea(v);
  const k = cda / Math.max(1, v.mass);
  const wy = TAU / body.rotPeriod;
  out.enters = true; out.speedIn = vel.length();
  let minAlt = pos.length() - R, t = 0;
  const dt = opts.dt || 0.5;
  const acc = (p, u, o) => {
    const r = p.length(), rho = body.density(r - R);
    const ax = u.x - wy * p.z, ay = u.y, az = u.z + wy * p.x;              // air-relative velocity
    const sp = Math.sqrt(ax * ax + ay * ay + az * az);
    const d = 0.5 * rho * sp * k;
    o.set(-gm * p.x / (r * r * r) - d * ax, -gm * p.y / (r * r * r) - d * ay, -gm * p.z / (r * r * r) - d * az);
    return 0.5 * rho * sp * sp;
  };
  const a1 = new Vector3(), a2 = new Vector3(), pm = new Vector3(), vm = new Vector3();
  for (let i = 0; i < 20000; i++) {
    const q = acc(pos, vel, a1);
    out.maxQ = Math.max(out.maxQ, q); out.maxG = Math.max(out.maxG, q * k / 9.81);
    pm.copy(pos).addScaledVector(vel, dt / 2); vm.copy(vel).addScaledVector(a1, dt / 2);
    acc(pm, vm, a2);
    pos.addScaledVector(vm, dt); vel.addScaledVector(a2, dt);
    t += dt;
    const alt = pos.length() - R;
    if (alt < minAlt) minAlt = alt;
    if (alt <= surfaceFloor(body)) { out.outcome = 'landing'; out.periapsis = minAlt; out.speedOut = vel.length(); out.dv = out.speedIn - out.speedOut; out.apoapsis = 0; return out; }
    if (alt > H && pos.dot(vel) > 0) break;
  }
  out.periapsis = minAlt; out.speedOut = vel.length(); out.dv = out.speedIn - out.speedOut;
  const after = Orbit.fromState(pos, vel, gm, 0);
  if (after.hyper || after.apoapsis > body.soi) { out.outcome = 'flyby'; out.apoapsis = Infinity; }
  else if (after.periapsis < R + surfaceFloor(body)) { out.outcome = after.apoapsis < R + H ? 'landing' : 'capture'; out.apoapsis = after.apoapsis - R; }
  else { out.outcome = 'capture'; out.apoapsis = after.apoapsis - R; }
  return out;
}
const surfaceFloor = body => Math.min(0, body.seaLevel || 0);
/** Frontal drag area × coefficient (m²) of a vessel flying nose- or tail-first: its widest stack part. */
function aeroArea(v) {
  let r = 0.3;
  for (const p of v.partList) { const d = p.def; if (d.attach && d.attach.stack) r = Math.max(r, d.r || 0, d.rBottom || 0); }
  return Math.PI * r * r * 1.0;
}

// ---------------------------------------------------------------------------------------------
// Aeroplanes and rovers (second pass)
// ---------------------------------------------------------------------------------------------
const _ang = {};
/**
 * A runway (or any strip) as a local frame: `site` is a SYSTEM.sites entry {dir, heading, length}; `reverse`
 * lands/takes off the other way. → {body, T (threshold, body-fixed unit Vector3), A (along the strip), R (to the
 * right), elev (m), length, heading (deg)}. Use siteCoords() to locate a vessel in it.
 */
export function runwayFrame(site = SYSTEM.sites.runway, { reverse = false, body = SYSTEM.home } = {}) {
  const T = new Vector3(site.dir.x, site.dir.y, site.dir.z).normalize();
  const east = new Vector3(T.z, 0, -T.x).normalize(), north = new Vector3().crossVectors(T, east);
  const h = (site.heading ?? 90) * DEG;
  const A = new Vector3().addScaledVector(north, Math.cos(h)).addScaledVector(east, Math.sin(h));
  const length = site.length || 1600;
  const f = { body, T, A, R: new Vector3(), elev: 0, length, heading: site.heading ?? 90 };
  if (reverse) {
    f.T = T.clone().addScaledVector(A, length / body.radius).normalize();
    f.A = A.clone().negate();
    f.heading = (f.heading + 180) % 360;
  }
  f.R.crossVectors(f.A, f.T);
  f.elev = surfaceAt(body, f.T);
  return f;
}
/** Where a vessel is in a runway frame: {along (m past the threshold), cross (m right of the centreline), alt (m above the strip)}. */
export function siteCoords(frame, vessel, ut, out = {}) {
  const b = frame.body, R = vessel.pos.length();
  b.inertialToSurfaceDir(_a.copy(vessel.pos).multiplyScalar(1 / R), ut, _b);
  _b.sub(frame.T);
  out.along = _b.dot(frame.A) * b.radius; out.cross = _b.dot(frame.R) * b.radius;
  out.alt = R - b.radius - frame.elev;
  return out;
}

/**
 * Low-level aeroplane control: one call sets ctrl.pitch / roll / yaw for this frame from a commanded pitch and
 * bank angle (rad). Gains follow vessel.ctrlAccel, so the same call flies a light trainer and a heavy spaceplane.
 * `st` keeps the controller state between calls. Used by the plane programs below; exported for the UI's wing leveller.
 */
export function planeAttitude(vessel, st, pitchCmd, bankCmd, dt, opts = {}) {
  const v = vessel, c = v.ctrl, A = flightAngles(v, _ang);
  c.sas = false;
  const acc = v.ctrlAccel;
  const gain = (wn, zeta, a) => { const am = Math.max(a, 0.05); return [wn * wn / am, 2 * zeta * wn / am]; };
  const [kpP, kdP] = gain(opts.wnPitch || 1.6, 0.9, acc.x);
  const [kpR, kdR] = gain(opts.wnRoll || 2.2, 0.9, acc.y);
  const kdY = 0.8 / Math.max(acc.z, 0.05);
  // pitch about the wing axis: the horizon pitch rate is w.x·cos(bank) − (−w.z)·sin(bank); close enough with w.x
  // an integral term carries the steady moments (wheels on the ground, a nose-heavy trim)
  const eP = (pitchCmd - A.pitch) * Math.cos(A.roll);
  const raw = kpP * eP - kdP * v.w.x;
  if (st.iP === undefined) st.iP = 0;
  if (Math.abs(raw + st.iP) < 1 || (raw + st.iP) * eP < 0) st.iP = clamp(st.iP + 0.8 * kpP * eP * dt, -0.9, 0.9);
  c.pitch = clamp(raw + st.iP, -1, 1);
  c.roll = clamp(kpR * wrapPi(bankCmd - A.roll) - kdR * v.w.y, -1, 1);
  // rudder: point into the airflow and damp the yaw rate (not the steady turn)
  const turnRate = A.speed > 20 ? (v.body.surfaceG * Math.tan(A.roll) / A.speed) : 0;      // nose-right rate of a coordinated turn
  c.yaw = clamp((opts.kSlip ?? 1.5) * A.slip * Math.min(1, A.speed / 30) + kdY * (v.w.z + turnRate * Math.cos(A.roll)), -1, 1);
  st.angles = A;
  return A;
}

/**
 * Outer loops shared by the plane programs: hold an altitude (or a climb angle), a compass course and an airspeed.
 * tgt = { alt (m above sea) | climb (rad), heading (deg) | bank (rad), speed (m/s) | throttle (0..1), maxBank, maxClimb, maxDescent }.
 */
export function planeHold(vessel, st, tgt, dt) {
  const v = vessel, A = flightAngles(v, _ang);
  if (st.trim === undefined) { st.trim = 0.06; st.thr = v.ctrl.throttle || 0.6; }
  const sp = Math.max(A.speed, 20);
  let climb;
  if (tgt.climb !== undefined) climb = tgt.climb;
  else climb = clamp((tgt.alt - v.altitude) / (sp * 10), -(tgt.maxDescent ?? 0.12), tgt.maxClimb ?? 0.18);
  // angle-of-attack trim learns what it takes to hold the commanded path
  st.trim = clamp(st.trim + 0.18 * (climb - A.climb) * dt, -0.06, tgt.maxAoa ?? 0.2);
  const pitchCmd = clamp(climb + st.trim + 0.35 * (climb - A.climb), -0.45, 0.6);
  let bank = 0;
  if (tgt.bank !== undefined) bank = tgt.bank;
  else if (tgt.heading !== undefined) bank = clamp(1.3 * wrapPi(tgt.heading * DEG - A.track), -(tgt.maxBank ?? 0.5), tgt.maxBank ?? 0.5);
  planeAttitude(v, st, pitchCmd, bank, dt, tgt);
  if (tgt.throttle !== undefined) v.ctrl.throttle = tgt.throttle;
  else if (tgt.speed !== undefined) {
    const err = tgt.speed - A.speed;
    st.thr = clamp(st.thr + 0.008 * err * dt, 0.05, 1);
    v.ctrl.throttle = clamp(st.thr + 0.04 * err, 0, 1);
  }
  return A;
}

/**
 * Take-off program for a vessel standing on its wheels (World.launch(craft, {site: 'runway'})): lights the engines,
 * releases the brakes, keeps the centreline, rotates at 1.15 × the stall speed, raises the gear and climbs out on
 * the runway heading to opts.altitude (m above the runway, default 600). Done when that altitude is reached.
 * opts: { altitude, heading (deg; default: the way the vessel points), climb (rad, default 0.14), speed (m/s to hold in the climb) }
 */
export function planeTakeoff(world, vessel = world.active, opts = {}) {
  const v = vessel;
  const c = base(world, v, 'takeoff');
  const o = { altitude: 600, climb: 0.14, ...opts };
  const st = {};
  let heading = o.heading, alt0 = 0, vr = 0, t0 = world.ut, line = null;
  c.update = dt => {
    if (c.done) return;
    if (v.dead) return c.finish(false, 'vessel lost');
    const A = flightAngles(v, _ang);
    switch (c.phase) {
      case 'init': {
        if (heading === undefined) heading = A.heading / DEG;
        alt0 = v.altitude;
        vr = 1.15 * stallSpeed(v);
        if (!Number.isFinite(vr)) return c.finish(false, 'no wings, or no air to fly in');
        // the line to keep: through the start point along the heading
        line = runwayFrame({ dir: v.landed && v.surface ? v.surface.dir : surfaceDirOf(v, world.ut), heading, length: 1 }, { body: v.body });
        if (!v.engines.some(e => e.part.ignited) && world.active === v) world.stage();
        v.ctrl.brake = false; v.ctrl.throttle = 1; v.ctrl.sas = false;
        v.ctrl.pitch = 0; v.ctrl.roll = 0; v.ctrl.yaw = 0;
        c.note(`rolling; rotate at ${vr.toFixed(0)} m/s`);
        c.phase = 'roll'; t0 = world.ut;
        break;
      }
      case 'roll': {
        const pos = siteCoords(line, v, world.ut);
        // steer back to the line: heading error plus cross-track, damped by the yaw rate
        const want = heading * DEG - clamp(pos.cross / 120, -0.2, 0.2);
        v.ctrl.yaw = clamp(2.5 * wrapPi(want - A.heading) + 0.8 * v.w.z, -1, 1) / (1 + (A.speed / 40) * (A.speed / 40));
        v.ctrl.roll = clamp(-2 * A.roll - 0.5 * v.w.y, -1, 1);
        v.ctrl.pitch = 0; v.ctrl.throttle = 1; v.ctrl.brake = false;
        if (A.speed >= vr) { c.phase = 'rotate'; c.note(`rotating at ${A.speed.toFixed(0)} m/s after ${pos.along.toFixed(0)} m`); }
        else if (world.ut - t0 > (o.timeout || 90)) return c.finish(false, `never reached rotation speed (${A.speed.toFixed(0)} of ${vr.toFixed(0)} m/s)`);
        break;
      }
      case 'rotate': {
        // rotate to 10°, or to just short of a tail strike on a craft that sits low
        planeAttitude(v, st, Math.min(0.17, A.pitch + v.tailStrikeMargin() - 0.035), 0, dt);
        v.ctrl.throttle = 1;
        if (!v.grounded && v.radarAlt > 3 && v.verticalSpeed > 0.5) { c.phase = 'climb'; c.liftoffUt = world.ut; c.note(`airborne at ${A.speed.toFixed(0)} m/s`); st.trim = clamp(A.aoa, 0.04, 0.12); st.iP = (st.iP || 0) * 0.3; }
        else if (world.ut - t0 > (o.timeout || 90) + 30) return c.finish(false, 'would not leave the ground');
        break;
      }
      case 'climb': {
        if (v.hasGear && v.gearDown && v.radarAlt > 15) { v.setGear(false); c.note('gear up'); }
        const pos = siteCoords(line, v, world.ut);
        const hdg = heading - clamp(pos.cross / 400, -0.35, 0.35) / DEG;
        planeHold(v, st, { climb: o.climb, heading: hdg, ...(o.speed ? { speed: o.speed } : { throttle: 1 }), maxBank: 0.35 }, dt);
        if (v.altitude - alt0 >= o.altitude) return c.finish(true, `climbed to ${(v.altitude - alt0).toFixed(0)} m at ${A.speed.toFixed(0)} m/s`);
        if (v.grounded && world.ut - c.liftoffUt > 3) return c.finish(false, 'settled back onto the ground');
        break;
      }
      default: break;
    }
  };
  return c;
}
function surfaceDirOf(v, ut) {
  const R = v.pos.length();
  return v.body.inertialToSurfaceDir(_a.copy(v.pos).multiplyScalar(1 / R), ut, new Vector3());
}

/**
 * Cruise program: holds altitude, course and speed. opts: { altitude (m above sea), heading (deg) or
 * waypoint ({along, cross} in opts.frame, a runwayFrame), speed (m/s) or throttle, duration (s) or distance (m) or
 * until (fn → true) }. Done when the duration / distance has passed, the waypoint is within opts.radius (default
 * 600 m) or `until` says so.
 */
export function planeCruise(world, vessel = world.active, opts = {}) {
  const v = vessel;
  const c = base(world, v, 'cruise');
  const o = { radius: 600, ...opts };
  const st = opts.state || {};
  let t0 = null, travelled = 0;
  c.update = dt => {
    if (c.done) return;
    if (v.dead) return c.finish(false, 'vessel lost');
    if (t0 === null) { t0 = world.ut; c.phase = 'cruise'; if (o.altitude === undefined) o.altitude = v.altitude; }
    let heading = o.heading;
    if (o.waypoint) {
      const pos = siteCoords(o.frame, v, world.ut);
      const dx = o.waypoint.along - pos.along, dy = o.waypoint.cross - pos.cross;
      heading = o.frame.heading + Math.atan2(dy, dx) / DEG;
      if (Math.hypot(dx, dy) < o.radius) return c.finish(true, 'waypoint reached');
    }
    const A = planeHold(v, st, { alt: o.altitude, heading, ...(o.speed !== undefined ? { speed: o.speed } : { throttle: o.throttle ?? 0.7 }), maxBank: o.maxBank }, dt);
    travelled += A.speed * dt;
    if (v.grounded && v.radarAlt < 1 && world.ut - t0 > 2) return c.finish(false, 'hit the ground');
    if (o.duration !== undefined && world.ut - t0 >= o.duration) return c.finish(true, 'cruise time flown');
    if (o.distance !== undefined && travelled >= o.distance) return c.finish(true, 'cruise distance flown');
    if (o.until && o.until()) return c.finish(true, 'cruise ended');
  };
  return c;
}

/**
 * Landing program: flies to the extended centreline, down a glide slope to the threshold, flares, touches down
 * on the wheels and brakes to a stop. opts: { site (SYSTEM.sites entry, default the home runway), reverse (land the
 * other way), slope (rad, default 0.07 ≈ 4°), speed (approach speed, default 1.35 × stall), final (m of straight
 * final approach, default 4500), aim (m past the threshold to touch down at, default 200) }.
 * Done when the vessel has stopped on the ground (it is then `landed`, or as good as).
 */
export function planeLand(world, vessel = world.active, opts = {}) {
  const v = vessel;
  const c = base(world, v, 'landing');
  const o = { slope: 0.07, final: 4500, aim: 200, ...opts };
  const frame = o.frame || runwayFrame(o.site || SYSTEM.sites.runway, { reverse: !!o.reverse, body: v.body });
  const st = {};
  let vapp = 0, t0 = world.ut, touchUt = null, flareAlt = 9, tailMargin = Infinity;
  c.frame = frame;
  c.update = dt => {
    if (c.done) return;
    if (v.dead) return c.finish(false, 'vessel lost');
    const pos = siteCoords(frame, v, world.ut);
    const A = flightAngles(v, _ang);
    switch (c.phase) {
      case 'init':
        vapp = o.speed || Math.max(1.35 * stallSpeed(v), 35);
        // a craft that sits low cannot raise its nose far in the flare: bring it down a shallower slope instead
        tailMargin = v.tailStrikeMargin(true);        // geometric (gear down, half compressed): the vessel is in the air here
        if (!opts.slope && tailMargin < 0.2) o.slope = 0.04;
        if (!Number.isFinite(vapp)) return c.finish(false, 'no wings, or no air to fly in');
        c.phase = pos.along > -o.final * 0.8 || Math.abs(pos.cross) > 1500 ? 'reposition' : 'final';
        c.note(`approach at ${vapp.toFixed(0)} m/s for runway heading ${frame.heading.toFixed(0)}°`);
        t0 = world.ut;
        break;
      case 'reposition': {
        // downwind beside the strip until well past the far end of the final approach; the final-approach law then
        // turns the vessel onto the centreline by itself
        const gateAlong = -o.final - 1500;
        if (!st.side) st.side = pos.cross >= 0 ? 1 : -1;
        const dx = gateAlong - 3000 - pos.along, dy = st.side * 2600 - pos.cross;
        const hdg = frame.heading + Math.atan2(dy, dx) / DEG;
        const altGate = frame.elev + Math.tan(o.slope) * (o.final + 1500 + o.aim);
        planeHold(v, st, { alt: Math.max(altGate, frame.elev + 350), heading: hdg, speed: Math.max(vapp * 1.25, vapp + 12), maxBank: 0.5 }, dt);
        if (pos.along < gateAlong) { c.phase = 'final'; c.note('turning final'); }
        if (world.ut - t0 > 1500) return c.finish(false, 'could not line up');
        break;
      }
      case 'final': {
        if (v.hasGear && !v.gearDown) { v.setGear(true); c.note('gear down'); }
        const dist = o.aim - pos.along;                                   // metres to the touchdown point
        const glideAlt = frame.elev + Math.max(0, dist) * Math.tan(o.slope);
        // centreline: intercept angle from the cross-track error, tightening close in
        const lead = clamp(Math.abs(dist) * 0.25, 250, 1200);
        const hdg = frame.heading - Math.atan(clamp(pos.cross / lead, -1.2, 1.2)) / DEG;
        const above = v.altitude - glideAlt;
        // down the glide slope: the height error steers the path, and the path's own error damps it. Without the second
        // term a craft that answers slowly in pitch (the Skimmer) swung ±6 m/s about the slope all the way down and
        // met the runway at whatever sink rate the swing had at that moment (round 3: 5 to 7 m/s).
        const climb = clamp(-o.slope - above / 220 - 0.5 * (A.climb + o.slope), -0.2, 0.08);
        planeHold(v, st, { climb: dist > o.final * 1.2 ? clamp((glideAlt - v.altitude) / 400, -0.12, 0.1) : climb, heading: hdg, speed: vapp, maxBank: dist < 1200 ? 0.25 : 0.45 }, dt);
        if (v.radarAlt < flareAlt && dist < 900) { c.phase = 'flare'; c.note(`flare at ${A.speed.toFixed(0)} m/s, ${pos.cross.toFixed(0)} m off the centreline`); }
        else if (pos.along > frame.length * 0.6) return c.finish(false, 'overshot the runway');
        break;
      }
      case 'flare': {
        // hold the wings level, ease the sink rate to about 1 m/s, let the speed bleed off
        // The sink rate to hold falls with the height left: the approach's own rate at the top of the flare, about
        // 0.8 m/s at the wheels (round 3: it asked for 0.9 m/s from 9 m up, ballooned, and came down nose-high).
        const sink = -v.verticalSpeed;
        const want = clamp(0.7 + 0.45 * Math.max(0, v.radarAlt - 0.5), 0.8, Math.max(0.8, vapp * Math.tan(o.slope)));
        // never flare into a tail strike: the nose stays under the angle at which the tail would touch with the wheels
        // on the ground (the craft's geometry, measured in `init`), whatever height is left. The live clearance alone
        // lets the nose come up while there is air under the tail, and the tail then arrives before the wheels.
        const pitchCmd = Math.min(clamp(0.06 + 0.035 * (sink - want) + st.trim * 0.5, 0.0, 0.2), tailMargin - 0.035, A.pitch + v.tailStrikeMargin() - 0.03);
        const hdgErr = wrapPi(frame.heading * DEG - A.track);
        planeAttitude(v, st, pitchCmd, clamp(0.6 * hdgErr - pos.cross / 600, -0.08, 0.08), dt);
        // idle, unless the nose is at its limit and the craft still sinks faster than asked: then power carries what
        // the wing may not (a craft that sits low cannot raise its nose to flare)
        v.ctrl.throttle = pitchCmd >= tailMargin - 0.036 ? clamp(0.3 * (sink - want), 0, 0.8) : 0;
        if (v.wheelsOnGround >= 2 || (v.grounded && v.radarAlt < 0.3)) { c.phase = 'rollout'; touchUt = world.ut; c.touchdown = { speed: A.speed, sink, along: pos.along, cross: pos.cross }; c.note(`touchdown at ${A.speed.toFixed(0)} m/s, sinking ${sink.toFixed(1)} m/s, ${pos.along.toFixed(0)} m down the runway`); }
        break;
      }
      case 'rollout': {
        v.ctrl.throttle = 0; v.ctrl.brake = true;
        if (v.airbrakeParts.length) v.setAirbrakes(true);
        const want = frame.heading * DEG - clamp(pos.cross / 150, -0.15, 0.15);
        v.ctrl.yaw = clamp(2.0 * wrapPi(want - A.heading) + 0.8 * v.w.z, -1, 1) / (1 + (A.speed / 40) * (A.speed / 40));
        v.ctrl.roll = clamp(-2 * A.roll - 0.5 * v.w.y, -1, 1);
        v.ctrl.pitch = clamp(-1.5 * (A.pitch - 0.02) - 0.6 * v.w.x, -0.4, 0.4);
        if (v.landed || A.speed < 0.6) { v.ctrl.yaw = 0; v.ctrl.pitch = 0; v.ctrl.roll = 0; return c.finish(true, `stopped ${pos.along.toFixed(0)} m down the runway, ${Math.abs(pos.cross).toFixed(0)} m from the centreline`); }
        if (world.ut - touchUt > 120) return c.finish(false, 'did not stop');
        break;
      }
      default: break;
    }
  };
  return c;
}

/**
 * Rover program: drives a wheeled vessel on its powered wheels. opts: { distance (m to cover) or heading (deg) +
 * distance, speed (m/s, default 8), brakeAtEnd (default true) }. Steers to hold the compass heading it starts on
 * (or opts.heading), eases off downhill and stops at the end. Done when the distance is covered and it has stopped.
 * `c.driven` is the ground distance covered so far.
 */
const _rv1 = new Vector3(), _rv2 = new Vector3(), _rv3 = new Vector3(), Y_UP = new Vector3(0, 1, 0);
export function roverDrive(world, vessel = world.active, opts = {}) {
  const v = vessel;
  const c = base(world, v, 'drive');
  const o = { distance: 500, speed: 8, brakeAtEnd: true, maxGrade: 0.42, ...opts };
  // where gravity is weak the same ground throws a rover about at a lower speed: cruise at what this world allows
  o.speed = Math.min(o.speed, roverCruiseSpeed(v.body, o.speed));
  let heading = o.heading, last = null, t0 = world.ut, stuck = 0, look = 0, grade = 0, rough = 0, track = null;
  const slow = Math.min(1.2, 0.2 * v.body.surfaceG);       // m/s²: the braking it plans for, gentle enough for this gravity
  c.driven = 0;
  c.update = dt => {
    if (c.done) return;
    if (v.dead) return c.finish(false, 'vessel lost');
    const A = flightAngles(v, _ang);
    if (c.phase === 'init') {
      if (!v.wheelParts.some(p => p.def.wheel.drive > 0)) return c.finish(false, 'no powered wheels');
      if (heading === undefined) heading = A.heading / DEG;
      v.ctrl.sas = false; v.ctrl.brake = false; v.ctrl.throttle = 0;
      c.phase = 'drive'; t0 = world.ut;
    }
    const here = surfaceDirOf(v, world.ut);
    if (!track) {
      const east = new Vector3().crossVectors(Y_UP, here); if (east.lengthSq() < 1e-9) east.set(0, 0, -1); east.normalize();
      const along = new Vector3().crossVectors(here, east).multiplyScalar(Math.cos(heading * DEG)).addScaledVector(east, Math.sin(heading * DEG));
      track = { right: new Vector3().crossVectors(along, here).normalize() };
    }
    if (last) { const step = here.distanceTo(last) * v.body.radius; if (step < 50) c.driven += step; }
    last = here;
    const sp = v.landed ? 0 : v.groundSpeed;
    if (c.phase === 'drive') {
      const left = o.distance - c.driven;
      // the ground ahead on this course: ease off for a grade, and do not drive onto one no rover can hold
      look -= dt;
      if (look <= 0) {
        look = 0.25;
        const hr = heading * DEG, L = Math.max(5, sp * 2.5);
        const east = _rv1.crossVectors(Y_UP, here); if (east.lengthSq() < 1e-9) east.set(0, 0, -1); east.normalize();
        const fwd = _rv2.crossVectors(here, east).multiplyScalar(Math.cos(hr)).addScaledVector(east, Math.sin(hr));
        const h0 = surfaceAt(v.body, here);
        grade = 0;
        for (const k of [0.5, 1, 2]) grade = Math.max(grade, Math.abs(surfaceAt(v.body, _rv3.copy(here).addScaledVector(fwd, k * L / v.body.radius).normalize()) - h0) / (k * L));
        // and the fine grain over the distance it takes to slow down: the rim of a small crater, a ledge
        const reach = 5 + sp * sp / (2 * slow);
        let hPrev = h0; rough = 0;
        for (let x = 1.5; x <= reach; x += 1.5) {
          const h = surfaceAt(v.body, _rv3.copy(here).addScaledVector(fwd, x / v.body.radius).normalize());
          rough = Math.max(rough, Math.abs(h - hPrev) / 1.5); hPrev = h;
        }
      }
      if (grade > o.maxGrade || rough > o.maxGrade * 1.7) {
        v.ctrl.drive = 0; v.ctrl.steer = 0; v.ctrl.brake = true;
        if (sp < 0.3) return c.finish(false, `the ground ahead is too steep (${Math.round(Math.atan(Math.max(grade, rough / 1.5)) / DEG)}°): stopped after ${c.driven.toFixed(0)} m`);
        return;
      }
      const under = v._gnd ? v._gnd.slope || 0 : 0;          // the tilt of the ground under the wheels right now
      const ease = Math.min(clamp(1 - (Math.max(grade, under) - 0.08) / 0.25, 0.4, 1), clamp(1 - (rough - 0.2) / 0.6, 0.6, 1));
      const want = Math.min(o.speed * ease, Math.max(Math.min(1.5, o.speed), Math.sqrt(2 * slow * Math.max(left, 0))));
      v.ctrl.drive = clamp(0.6 * (want - sp), -1, 1);
      v.ctrl.brake = sp > want * 1.4;
      // hold the line it set out on, not just its direction: a rover pushed aside by every bump otherwise ends up
      // tens of metres from the ground it was sent across
      const xt = track ? here.dot(track.right) * v.body.radius : 0;
      const course = heading - clamp(xt * 3, -20, 20);
      v.ctrl.steer = clamp(2.2 * wrapPi(course * DEG - A.heading) + 0.4 * v.w.z, -1, 1) / (1 + sp / 12);
      v.ctrl.pitch = 0; v.ctrl.yaw = 0; v.ctrl.roll = 0;
      // thrown clear of the ground by a crest: the chassis' reaction wheels hold it level until the tyres are back
      v.ctrl.sas = !v.landed && v.wheelsOnGround < 2;
      if (sp < 0.15) stuck += dt; else stuck = 0;
      if (left <= 0) { c.phase = 'stop'; c.note(`drove ${c.driven.toFixed(0)} m`); }
      else if (stuck > 40) return c.finish(false, `stuck after ${c.driven.toFixed(0)} m`);
      else if (!(v.resources.elec && v.resources.elec.amount > 0.01)) return c.finish(false, `out of charge after ${c.driven.toFixed(0)} m`);
      else if (world.ut - t0 > (o.timeout || 60 + o.distance / Math.max(0.5, o.speed) * 6)) return c.finish(false, `too slow: ${c.driven.toFixed(0)} m`);
    } else if (c.phase === 'stop') {
      v.ctrl.drive = 0; v.ctrl.steer = 0; v.ctrl.brake = !!o.brakeAtEnd; v.ctrl.sas = false;
      if (v.landed || sp < 0.2) return c.finish(true, 'stopped');
    }
  };
  return c;
}


/** Test/assist driver: step the world, calling ctl.update() every step, until ctl.done or `until()` or maxSim seconds. */
export function fly(world, ctl, { dt = 0.05, physWarp = 3, maxSim = 36000, until = null, onStep = null } = {}) {
  const tEnd = world.ut + maxSim;
  let guard = 0;
  while (world.ut < tEnd && guard++ < 5e6) {
    if (ctl) { ctl.update(dt); if (ctl.done) break; }
    if (until && until()) break;
    if (world.warpTarget === null && world.warpIndex < physWarp) world.setWarp(physWarp);
    world.step(dt);
    if (onStep) onStep();
    if (!world.active || world.active.dead) break;
  }
  return ctl;
}
void Orbit; void _c; void _d;
