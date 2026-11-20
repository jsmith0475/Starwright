// Starwright demo tour — the prepared scenes ("cuts"). Each function builds a fresh World at a fixed game time with
// vessels spawned straight into the state a chapter shows, the way the test suites do through the World API.
// Pure simulation (no DOM): tests/unit/demo.test.js flies every one of them with the core autopilot.
import { Vector3, Quaternion } from '../../lib/three.module.min.js';
import { SYSTEM } from '../../core/bodies.js';
import { World } from '../../core/world.js';
import { Craft } from '../../core/craft.js';
import * as AP from '../../core/autopilot.js';
import { driveRoute } from '../../core/scenarios.js';
import * as K from './kit.js';

const Y = new Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const home = () => SYSTEM.home;

/** Height of the sun above the horizon (rad) at a body-fixed direction and time. */
export function sunElevation(body, dir, ut) {
  const up = body.surfaceDirToInertial(dir, ut, new Vector3());
  const sun = body.globalPosAt(ut, new Vector3()).negate().normalize();
  return Math.asin(K.clamp(up.dot(sun), -1, 1));
}
/** The first time (within one day from t0) when the sun stands `deg` above the horizon there, rising or setting. */
export function utForSun(body, dir, deg, rising = true, t0 = 0) {
  const want = deg * Math.PI / 180, step = body.rotPeriod / 720;
  let best = t0, bestErr = Infinity;
  for (let t = t0; t < t0 + body.rotPeriod; t += step) {
    const e = sunElevation(body, dir, t), e2 = sunElevation(body, dir, t + step);
    if ((e2 > e) !== rising) continue;
    const err = Math.abs(e - want);
    if (err < bestErr) { bestErr = err; best = t; }
  }
  return best;
}

function need(name) {
  const c = K.stock(name);
  if (!c) throw new Error('stock design "' + name + '" is not available');
  return c;
}
function corotating(body, pos) { const wy = TAU / body.rotPeriod; return new Vector3(wy * pos.z, 0, -wy * pos.x); }

/** The rocket on the pad in morning light. `craftJSON` is the design from the assembly chapter (default: Ember Twin). */
export function padLaunch(craftJSON = null) {
  const b = home();
  const world = new World({ ut: utForSun(b, SYSTEM.launchSite.dir, 27, true) });
  let craft = null;
  if (craftJSON) { try { craft = Craft.fromJSON(craftJSON); } catch { craft = null; } }
  if (!craft || !craft.parts.length) craft = need('Ember Twin');
  const vessel = world.launch(craft, { crew: ['Juno'] });
  return { world, vessel };
}

/**
 * The same rocket half a minute into its flight: boosters gone, climbing through the first kilometres on its core.
 * The "To orbit" chapter opens here when the launch chapter did not hand a flight over (opened on its own, or the
 * launch failed), so its stand-in is a rocket in the air, never a second roll-out. Flown here with the ascent
 * guidance in fixed steps, so it is the same state every time. `resume(world)` gives the guidance for the rest.
 */
export function ascentScene(craftJSON = null) {
  const { world, vessel } = padLaunch(craftJSON);
  let dropped = 0;
  const off = world.on('decouple', () => { dropped++; });
  const ctl = AP.ascentProgram(world, { targetAlt: 85000, useWarp: false });
  const t0 = world.ut, h = 1 / 30;
  let tDrop = Infinity;
  for (let i = 0; i < 4000 && !ctl.done && !vessel.dead; i++) {
    ctl.update(h);
    world.step(h);
    if (dropped && tDrop === Infinity) tDrop = world.ut;
    if (world.ut - tDrop > 4 || world.ut - t0 > 70) break;
  }
  if (typeof off === 'function') off();
  for (const o of world.vessels.slice()) if (o.type === 'debris') world.removeVessel(o);      // the boosters are long gone
  if (vessel.dead || ctl.done) throw new Error('the prepared ascent did not get off the pad');
  return { world, vessel, resume: ascentResume };
}
/** The ascent guidance for a rocket that is already flying (it must not fire the first stage again). */
export function ascentResume(world) {
  const ctl = AP.ascentProgram(world, { targetAlt: 85000, useWarp: true });
  ctl.phase = 'ascent';
  return ctl;
}

/** The upper stage of the Ember Twin in an 85 km orbit, coming round to the day side. */
export function orbitScene() {
  const b = home();
  const world = new World({ ut: 5200 });
  const st = K.orbitState(b, 85000, world.ut, { phase: -1.15 });
  const vessel = world.spawn(need('Ember Twin'), { crew: ['Juno'], body: b, pos: st.pos, vel: st.vel, q: st.q });
  K.stageDown(world, vessel, 2);
  vessel.ctrl.throttle = 0; vessel.ctrl.sas = true;
  return { world, vessel };
}

/** A Moonstep lander falling toward a flat patch of Pell, a kilometre and a half up. */
export function pellDescent() {
  const pell = SYSTEM.byId.pell;
  const world = new World({ ut: 4000 });
  const near = pell.inertialToSurfaceDir(K.sunwardOf(pell, world.ut).applyAxisAngle(Y, -0.75), world.ut, new Vector3());
  const spot = K.flatSpot(pell, near, { reach: 40000 });
  const up = pell.surfaceDirToInertial(spot.dir, world.ut, new Vector3());
  const east = new Vector3().crossVectors(Y, up).normalize();
  const pos = up.clone().multiplyScalar(pell.radius + pell.terrainHeight(spot.dir) + 1700).addScaledVector(east, -640);
  const vel = corotating(pell, pos).addScaledVector(east, 30).addScaledVector(up, -52);
  const q = new Quaternion().setFromUnitVectors(Y, up);
  const vessel = world.spawn(need('Moonstep'), { crew: ['Juno', 'Tilly'], body: pell, pos, vel, q });
  if (typeof vessel.setLegs === 'function') vessel.setLegs(true);
  vessel.ctrl.sas = true;
  return { world, vessel, spot };
}

/** The same lander already standing on Pell (the EVA chapter when it is opened on its own). */
export function pellSurface() {
  const pell = SYSTEM.byId.pell;
  const world = new World({ ut: 4000 });
  const near = pell.inertialToSurfaceDir(K.sunwardOf(pell, world.ut).applyAxisAngle(Y, -0.75), world.ut, new Vector3());
  const spot = K.flatSpot(pell, near, { reach: 40000 });
  const vessel = K.placeLanded(world, need('Moonstep'), pell, spot.dir, { crew: ['Juno', 'Tilly'] });
  return { world, vessel, spot };
}

/** An Acorn capsule (Skylark II without its launcher) hitting the upper air at orbital speed, heat shield first. */
export function reentryScene() {
  const b = home();
  // mid-morning at the space centre: the capsule comes down off that coast half a minute later (chuteState), and a
  // splashdown at a fixed game time happened to be in the middle of the night, a black sea under a black sky. The
  // re-entry itself is placed relative to the sun, so it is in daylight at any time.
  const world = new World({ ut: utForSun(b, SYSTEM.launchSite.dir, 38, true) });
  const st = K.orbitState(b, 44500, world.ut, { phase: -0.55, speedFactor: 0.935, vy: -290, retro: true });
  const vessel = world.spawn(need('Skylark II'), { crew: ['Juno'], body: b, pos: st.pos, vel: st.vel, q: st.q });
  K.stageDown(world, vessel, 1);
  vessel.ctrl.sas = true; vessel.ctrl.sasMode = 'srfRetrograde'; vessel.ctrl.throttle = 0;
  return { world, vessel };
}
/** Where the capsule is put for the parachute scene: over the sea a few kilometres off the space centre. */
export function chuteState(world) {
  const b = home();
  const dir = b.dirFromLatLon(-900 / b.radius, 7200 / b.radius);
  const up = b.surfaceDirToInertial(dir, world.ut, new Vector3());
  const east = new Vector3().crossVectors(Y, up).normalize();
  const pos = up.clone().multiplyScalar(b.radius + 1750).addScaledVector(east, 380);
  const vel = corotating(b, pos).addScaledVector(up, -95).addScaledVector(east, -22);
  return { pos, vel, q: new Quaternion().setFromUnitVectors(Y, up), dir };
}

/** A stock aeroplane at the runway threshold, brakes on, in the morning. */
export function runwayScene(name = 'Kite Trainer') {
  const b = home();
  const site = (SYSTEM.sites && SYSTEM.sites.runway) || null;
  if (!site) throw new Error('the runway site is not defined');
  const world = new World({ ut: utForSun(b, site.dir, 21, true) });
  const vessel = world.launch(need(name), { crew: ['Oskar'], site: 'runway' });
  if (!(vessel.surface && vessel.surface.vehicle)) throw new Error(name + ' does not stand on its wheels');
  return { world, vessel };
}

/** A Trundle Scout rover on the ochre dunes of Rusk, low sun. */
export function roverScene() {
  const rusk = SYSTEM.byId.rusk;
  const world = new World({ ut: 30000 });
  const candidates = [[0.2, 1.0], [-0.1, 2.0], [0.3, -1.0]];
  let best = null;
  for (const [lat, lon] of candidates) {
    const spot = K.flatSpot(rusk, K.dirAt(lat, lon), { reach: 20000, wide: 150 });
    const elev = sunElevation(rusk, spot.dir, world.ut);
    if (elev < 0.12) continue;
    if (!best || spot.slope < best.spot.slope - 0.04) best = { spot, elev };
    if (best && best.spot.slope < 0.06) break;
  }
  if (!best) best = { spot: K.flatSpot(rusk, rusk.inertialToSurfaceDir(K.sunwardOf(rusk, world.ut).applyAxisAngle(Y, -0.9), world.ut, new Vector3()), { reach: 30000, wide: 150 }) };
  // from that place, a start and a heading with a gentle run ahead (the same search the rover scenarios use)
  const route = driveRoute(rusk, best.spot.dir, { length: 220, reach: 2500 });
  const vessel = K.placeLanded(world, need('Trundle Scout'), rusk, route.dir, { vehicle: true, heading: route.heading });
  return { world, vessel, spot: { dir: route.dir, slope: route.slope }, heading: route.heading };
}

/** A crewed Latch Chaser 45 m from the Latch Target station core, both in a 150 km orbit, nose to nose. */
export function dockScene() {
  const b = home();
  const world = new World({ ut: 12000 });
  const st = K.orbitState(b, 150000, world.ut, { phase: -0.6 });
  const target = world.spawn(need('Latch Target'), { body: b, pos: st.pos, vel: st.vel, q: st.q });
  K.stageDown(world, target, 0);
  const pro = st.vel.clone().normalize(), out = st.pos.clone().normalize();
  const pos = st.pos.clone().addScaledVector(pro, 45).addScaledVector(out, 6);
  const vessel = world.spawn(need('Latch Chaser'), { crew: ['Juno'], body: b, pos, vel: st.vel.clone(), q: K.orbitState(b, 150000, world.ut, { phase: -0.6, retro: true }).q });
  K.stageDown(world, vessel, 2);
  for (const o of [target, vessel]) { o.ctrl.throttle = 0; o.ctrl.sas = true; if (typeof o.setSolar === 'function') o.setSolar(true); }
  target.name = 'Latch Target';
  world.switchTo(vessel);
  world.setTarget(vessel, target);
  vessel.ctrl.rcs = true;
  return { world, vessel, target };
}

/** A program in full swing for the tracking station: flights around the home world, on two surfaces and far out. */
export function fleetWorld() {
  const world = new World({ ut: 86000 });
  const b = home(), by = SYSTEM.byId;
  const made = [];
  const orbit = (name, label, body, alt, opts = {}, keep = 0, crew = []) => {
    const c = K.stock(name); if (!c || !body) return null;
    try {
      const st = K.orbitState(body, alt, world.ut, opts);
      const v = world.spawn(c, { crew, body, pos: st.pos, vel: st.vel, q: st.q, makeActive: false });
      K.stageDown(world, v, keep);
      v.ctrl.throttle = 0; v.name = label;
      if (typeof v.setSolar === 'function') v.setSolar(true);
      made.push(v);
      return v;
    } catch { return null; }
  };
  const ground = (name, label, body, lat, lon, opts = {}) => {
    const c = K.stock(name); if (!c || !body) return null;
    try {
      const spot = K.flatSpot(body, K.dirAt(lat, lon), { reach: 20000, samples: 200 });
      const v = K.placeLanded(world, c, body, spot.dir, { makeActive: false, ...opts });
      v.name = label; made.push(v);
      return v;
    } catch { return null; }
  };
  const station = orbit('Hearthstone Core', 'Hearthstone Station', b, 240000, { phase: 0.4 }, 0);
  orbit('Latch Target', 'Latch Depot', b, 150000, { phase: 2.2, tilt: 0.1 }, 0);
  orbit('Latch Chaser', 'Chaser 3', b, 152000, { phase: 2.9, tilt: 0.1 }, 2, ['Bram']);
  ground('Moonstep', 'Pell Base Camp', by.pell, 0.1, 0.6, { crew: ['Juno', 'Tilly'] });
  orbit('Whisper Probe', 'Whisper 1', by.orrin, 9.0e6, { phase: 1.0, tilt: 0.25 }, 0);
  orbit('Farwind', 'Farwind', by.tiv, 60000, { phase: 0.3 }, 1, ['Oskar']);
  ground('Trundle Scout', 'Rusk Trundle', by.rusk, 0.2, 1.0, { vehicle: true, heading: 90 });
  orbit('Mote Sounder', 'Sounder 4', by.murk, 300000, { phase: -0.8, tilt: 0.5 }, 0);
  for (const o of world.vessels.slice()) if (o.type === 'debris') world.removeVessel(o);
  world.active = station || made[0] || null;
  return { world, vessels: made };
}

export const SCENES = { padLaunch, ascentScene, orbitScene, pellDescent, pellSurface, reentryScene, runwayScene, roverScene, dockScene, fleetWorld };
