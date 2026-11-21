// Starwright live vessel: a rigid body made of parts, with engines, staging, aerodynamics, heating,
// attitude control and ground contact. PURE SIMULATION (three.js maths only) - runs under Node.
//
// Frames (see docs/ARCHITECTURE.md): `pos`/`vel` are the centre of mass relative to the SOI body in a
// non-rotating frame; `q` rotates local (craft axes, +Y = nose) to that frame; `w` is the angular velocity
// in LOCAL axes. A part's world position is  pos + q·(part.pos − com).
// Torque command axes (local): x = pitch, y = roll, z = −yaw.
import { Vector3, Quaternion } from '../lib/three.module.min.js';
import { partDef, currentPartId, engineThrust, engineIsp, G0 } from './parts.js';
import { Orbit } from './orbit.js';
import { SYSTEM } from './bodies.js';
import { maneuverBasis } from './trajectory.js';
import { Structure, STRUCT } from './structure.js';

const TAU = Math.PI * 2;

/** Tuning constants of the flight model (exported so the UI / tests can read them). */
export const TUNING = {
  DT_MAX: 0.02,              // physics sub-step under thrust / in atmosphere (s)
  DT_COAST: 0.1,             // sub-step while coasting in vacuum under physics warp (s)
  DECOUPLE_IMPULSE: 250,     // N·s of separation impulse per unit of def.decoupler.force
  HEAT_FLUX_K: 1.83e-4,      // Sutton-Graves-like: flux = K·sqrt(rho)·v³  (W/m²)
  HEAT_K: 0.30,              // equilibrium skin temperature rise = HEAT_K·(flux·exposure)^HEAT_EXP  (K)
  HEAT_EXP: 0.75,
  HEAT_TAU: 22,              // s, time constant while heating up
  COOL_TAU: 30,              // s, time constant while cooling down
  HEAT_MIN_FLUX: 1500,       // W/m²: below this nothing heats
  SIDE_EXPOSURE: 0.35,       // exposure of a part's flank at 90° angle of attack
  RADIAL_EXPOSURE: 0.6,      // exposure of radially mounted parts
  SHIELD_FACTOR: 0.3,        // temperature-rise multiplier of a heat shield that still has ablator
  ABLATE_RATE: 6e-6,         // kg of ablator per J/m² of heat load on the shield face
  AMBIENT_T: 290,
  BASE_DRAG: 0.25,           // leeward (wake-side) faces add this fraction of their drag area
  MACH_PEAK: 2.0, MACH_HIGH: 1.5,   // drag multiplier at Mach 1.1 and above Mach 2.5 (1 below Mach 0.7)
  FACE_CP: 0.25,             // restoring moment arm of a blunt leading face, in radii per sin(angle of attack)
  FACE_DAMP: 4,              // aerodynamic pitch damping of end faces
  CHUTE_CD: 1.6,
  CHUTE_MIN_PRESSURE: 0.02,  // atm: canopies stay packed above this altitude
  CHUTE_SEMI_TIME: 3.0,      // s to inflate the reefed canopy
  CHUTE_FULL_TIME: 2.5,      // s to open fully
  CHUTE_RIP: 1.5,            // × maxSpeed
  FIN_LIFT: 1.6,
  FIN_DEFLECT: 0.26,         // rad, control-fin throw
  WHEEL_EC: 0.02,            // EC/s per kN·m of reaction-wheel torque at full command
  RCS_ARM: 0.7,
  EVA_THRUST: 150,           // N, jetpack
  EVA_VE: 4500,              // m/s, jetpack exhaust velocity (≈ 250 m/s of dv)
  EVA_WALK: 1.5,             // m/s
  FLAG_REACH: 0.55,          // m: a flag is planted this far in front of the Pip
  EVA_TURN: 6,               // rad/s: how fast a walking Pip turns to face the way it is going
  EVA_JUMP: 2.2,             // m/s
  EVA_TORQUE: 0.2,           // × the pip part's torque
  SOUND_SPEED: 320,
  CRASH_ALL: 2.2,            // × tolerance: everything is destroyed
  WATER_TOL: 1.5,
  SAS_KP: 1.5, SAS_WMAX: 0.9, SAS_T: 0.15,
  MAX_ANG_ACC: 2.0,          // rad/s²: cap on commanded angular acceleration
  MAX_SPIN: 12,              // rad/s clamp
  // --- second pass: wings
  WING_SLOPE: 3.6,           // lift-curve slope (per rad) of a `wing`
  WING_STALL: 0.28,          // rad (16°): stall angle of a `wing`
  FIN_STALL: 0.45,           // rad: low-aspect fins stall late
  WING_CD0: 0.012,           // profile drag coefficient
  WING_K: 0.07,              // induced drag factor: CD = CD0 + K·CL²
  WING_PLATE: 0.9,           // post-stall flat-plate lift factor: CL = PLATE·sin 2α
  WING_PLATE_CD: 1.8,        // post-stall drag: CD = PLATE_CD·sin²α
  CTRL_DEFLECT: 0.35,        // rad (20°): full throw of a wing control surface
  CTRL_TAU: 0.55,            // effectiveness of a hinged surface (an all-moving fin is 1)
  // --- ground contact
  GROUND_W: 34,              // rad/s: natural frequency of the contact springs (per vessel)
  GROUND_ZETA: 0.85,         // damping ratio of the contact springs
  GROUND_REBOUND: 4,         // × that damping while a point is leaving the ground again
  GROUND_MU: 0.8,            // friction of hull parts on the ground
  LEG_MU: 1.1,
  // --- landing legs: each deployed leg is its own spring and damper (see docs/LANDING_LEGS.md)
  LEG_W: 11,                 // rad/s: natural frequency of a lander on its legs (1.75 Hz). Each leg's spring rate is
                             // mass × LEG_W² / legs down, so the static sag is g / LEG_W² : 7.9 cm on Verda, 1.3 cm on Pell
  LEG_ZETA: 0.3,             // damping ratio while a leg closes ...
  LEG_ZETA_REBOUND: 4,       // ... and while it opens again (an oleo strut lets go slowly: little bounce where gravity is weak)
  LEG_STROKE: 0.3,           // × reach: travel of a leg whose part does not say (`legs.stroke`, m)
  LEG_EASE: 0.15,            // m/s: how fast a leg found under the ground without having been driven there takes up its load
  LEG_BOTTOM_TOL: 0.3,       // × the part's impact tolerance: a leg that reaches the end of its travel still closing faster than this breaks
  STANCE_MIN: 0.04,          // m: loaded contact points spread less than this across their line are a knife edge, not a footprint
  STANCE_NUDGE: 0.002,       // rad/s (× the gravity scale): the push a craft balanced on a knife edge gets once a second
  STANCE_WAIT: 25,           // s: ... and how long it is left unpinned there
  SLEEP_G_REF: 9.6,          // m/s²: below this gravity "quiet enough to pin" is scaled down (things move slowly where gravity is weak)
  FRICTION_RATE: 22,         // 1/s: viscous slope of the friction law below the Coulomb limit
  CONTACT_DT: 0.01,          // s: largest physics step while touching the ground
  WHEEL_BRAKE_MU: 0.45,      // braking force per wheel is at most this × its load (the tyre itself grips to WHEEL_MU)
  WHEEL_DRIVE_MU: 0.7,       // traction control: a motor pushes with at most this × its wheel's load, so where gravity is weak
                             // the same motors do not stand a short rover on its tail
  SLEEP_SPEED: 0.25, SLEEP_SPIN: 0.06, SLEEP_TIME: 1.0,   // a vessel this quiet for this long is pinned ('landed')
  GROUND_SIT_TIME: 0.3,      // s of continuous contact before the situation reads 'landed'
  // --- wheels
  WHEEL_W: 11,               // rad/s: suspension natural frequency
  WHEEL_ZETA: 0.75,
  WHEEL_G_REF: 9.3,          // m/s²: at this gravity or more a wheel behaves as built; below it, see wheelGravityScale
  WHEEL_G_MIN: 0.03,         // ... down to this share of it
  WHEEL_MU: 1.0,
  WHEEL_ROLL: 0.03,          // rolling resistance coefficient
  WHEEL_SIDE_RATE: 14,       // 1/s: lateral grip build-up
  WHEEL_BRAKE_RATE: 20,
  WHEEL_STEER: 0.42,         // rad at standstill
  WHEEL_STEER_SPEED: 14,     // m/s at which the steering angle has halved
  WHEEL_STEER_GRIP: 0.55,    // steering asks for at most this share of the tyres' sideways grip (see the wheel loop in _contact)
  // --- water
  WATER_RHO: 1000,
  BUOY_FILL: 1.0,            // share of a part's geometric volume that displaces water
  BUOY_MIN: 1.8,             // every part displaces at least this × its own mass (sealed, hollow hardware floats)
  WATER_DRAG: 2.2,           // 1/s linear damping of submerged points
  WATER_QDRAG: 0.6,          // 1/m quadratic part
  // --- systems
  LIGHT_EC: 0.04,            // EC/s per lamp
  LAB_RATE: 0.0015,          // lab progress per second per record (× def.lab.rate)
  LAB_EC: 0.4,               // EC/s while a lab is processing
  LAB_BONUS: 0.5,            // extra science fraction a fully processed record is worth
  JET_ALT_EXP: 0.7,
  LADDER_REACH: 1.6,         // m: how close a Pip must be to grab a ladder
  LADDER_SPEED: 0.9,         // m/s climbing
  STRUCT_FAIL: true,         // joints break when overloaded (docs/STRUCTURE.md); false = loads are still worked out and shown
};

export const SAS_MODES = ['hold', 'prograde', 'retrograde', 'normal', 'antinormal', 'radialIn', 'radialOut',
  'maneuver', 'target', 'srfPrograde', 'srfRetrograde', 'up', 'direction',
  'antiTarget', 'relPrograde', 'relRetrograde'];

const _a = new Vector3(), _b = new Vector3(), _c = new Vector3(), _d = new Vector3(), _e = new Vector3();
const _up = new Vector3(), _ul = new Vector3(), _dir = new Vector3();
const _qa = new Quaternion(), _qb = new Quaternion(), _qi = new Quaternion();
const Y_AXIS = new Vector3(0, 1, 0);

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
function hash3(a, b, c) {   // deterministic pseudo-random in [−1, 1]
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 2147483648) - 1;
}
const v3 = o => new Vector3(o.x, o.y, o.z);
const j3 = v => ({ x: v.x, y: v.y, z: v.z });
const defaultCtrl = () => ({ pitch: 0, yaw: 0, roll: 0, throttle: 0, tx: 0, ty: 0, tz: 0, sas: false, sasMode: 'hold', rcs: false,
  brake: false, drive: 0, steer: 0, lights: false });

/** Propellant resource an engine burns: 'solid' | 'xenon' | 'fuel'. */
export function engineProp(def) {
  const t = def.engine && def.engine.type;
  return t === 'solid' ? 'solid' : t === 'ion' ? 'xenon' : 'fuel';
}
/** Does this body have an atmosphere jets can breathe? */
export function hasOxygen(body) { return !!(body && body.atmo && body.atmo.oxygen); }
/**
 * Thrust multiplier of a jet engine: 0 without oxygen, falls with air density and to zero at `jet.maxAlt`,
 * rises a little with speed and falls to zero at `jet.maxMach`.
 */
export function jetFactor(def, body, alt, mach) {
  if (!hasOxygen(body)) return 0;
  const j = def.engine.jet || {};
  const maxAlt = j.maxAlt || 18000, maxMach = j.maxMach || 2.5;
  if (!(alt < maxAlt)) return 0;
  const sigma = body.density(alt) / 1.22;
  let f = Math.pow(Math.max(sigma, 0), TUNING.JET_ALT_EXP);
  const edge = (maxAlt - alt) / (0.15 * maxAlt);
  if (edge < 1) f *= Math.max(0, edge);
  const x = Math.max(0, mach) / maxMach;
  if (x >= 1) return 0;
  return f * (1 + 1.2 * x) * (1 - x * x);
}
/** Height (m) of the terrain above the reference radius at a body-fixed direction (0 on bodies without relief). */
export function terrainAt(body, dir) {
  if (typeof body.terrainHeight !== 'function') return 0;
  const h = +body.terrainHeight(dir);
  return h === h ? h : 0;
}
/** Height of the liquid surface of an ocean world (m above the reference radius). */
export function seaLevelOf(body) { return body.ocean ? (body.seaLevel || 0) : -Infinity; }
/** Height of whatever a vessel meets first at a body-fixed direction: the terrain, or the sea over water. */
export function surfaceAt(body, dir) {
  if (typeof body.terrainHeight !== 'function') return 0;
  const h = terrainAt(body, dir);
  return body.ocean && h < (body.seaLevel || 0) ? (body.seaLevel || 0) : h;
}
/** Is there open water at this body-fixed direction? */
export function waterAt(body, dir) {
  if (!body.ocean) return false;
  if (typeof body.terrainHeight === 'function') return terrainAt(body, dir) < (body.seaLevel || 0) - 0.05;
  return !!body.biomeAt(dir).water;
}
const _tp = new Vector3();
function terrainAtPos(body, pos, ut) {
  if (typeof body.terrainHeight !== 'function') return 0;
  return surfaceAt(body, body.inertialToSurfaceDir(_tp.copy(pos).normalize(), ut, _tp));
}
const _rl1 = new Vector3(), _rl2 = new Vector3();   // relief under the contact points (_contact)
const WHEEL_DOWN = new Vector3(0, 0, -1);   // craft axis that points at the ground for wheeled vehicles

/** Lift and drag coefficients of a wing at angle of attack `a` (rad, any value). Returns [CL, CD]. */
export function wingCoefficients(a, slope = TUNING.WING_SLOPE, stall = TUNING.WING_STALL, out = [0, 0]) {
  const sa = Math.sin(a), ca = Math.cos(a);
  const plateL = TUNING.WING_PLATE * 2 * sa * ca, plateD = TUNING.WING_CD0 + TUNING.WING_PLATE_CD * sa * sa;
  // attached flow only near α = 0 (or 180° for a wing flying backwards, at half the efficiency)
  let al = a, eff = 1;
  if (ca < 0) { al = a > 0 ? a - Math.PI : a + Math.PI; eff = 0.5; }
  const x = Math.abs(al) / stall;
  // blend: 1 below 0.85·stall → 0 above 1.35·stall
  let w = x <= 0.85 ? 1 : x >= 1.35 ? 0 : 1 - (x - 0.85) / 0.5;
  w = w * w * (3 - 2 * w);
  const cl = slope * eff * al;
  const cd = TUNING.WING_CD0 + TUNING.WING_K * cl * cl;
  out[0] = w * cl + (1 - w) * plateL;
  out[1] = w * cd + (1 - w) * plateD;
  return out;
}
const _cf = [0, 0];

/** Range (m) of an antenna part definition (parts without an explicit range reach across the home system). */
export function antennaRange(def) {
  const a = def && def.antenna;
  if (!a) return 0;
  return a.range > 0 ? a.range : 6e7;
}
const _fa = new Vector3(), _fb = new Vector3(), _fc = new Vector3(), _fd = new Vector3(), _fe = new Vector3();
/**
 * Aeroplane-style attitude of a vessel (craft +Y = nose, +Z = top, +X = right wing), all in radians:
 * {pitch (nose above the horizon), heading (0 = north, π/2 = east), roll (right wing down positive),
 *  aoa (angle of attack), slip (sideslip: air from the right positive), track (compass course over the ground),
 *  climb (flight-path angle)}. Angles of the airflow are 0 below 1 m/s.
 */
export function flightAngles(v, out = {}) {
  const pos = v.pos, R = pos.length() || 1;
  const u = _fa.copy(pos).multiplyScalar(1 / R);
  const east = _fb.set(u.z, 0, -u.x);                    // Y × up
  if (east.lengthSq() < 1e-12) east.set(0, 0, -1);
  east.normalize();
  const north = _fc.crossVectors(u, east);
  const f = _fd.set(0, 1, 0).applyQuaternion(v.q);
  out.pitch = Math.asin(clamp(f.dot(u), -1, 1));
  let h = Math.atan2(f.dot(east), f.dot(north));
  out.heading = h < 0 ? h + TAU : h;
  const r = _fe.set(1, 0, 0).applyQuaternion(v.q);
  const ru = r.dot(u);
  f.set(0, 0, 1).applyQuaternion(v.q);                   // top
  out.roll = Math.atan2(-ru, f.dot(u));
  const wy = TAU / v.body.rotPeriod;
  const sx = v.vel.x - wy * pos.z, sy = v.vel.y, sz = v.vel.z + wy * pos.x;
  const sp = Math.sqrt(sx * sx + sy * sy + sz * sz);
  out.speed = sp;
  if (sp > 1) {
    const vz = sx * f.x + sy * f.y + sz * f.z, vx = sx * r.x + sy * r.y + sz * r.z;
    f.set(0, 1, 0).applyQuaternion(v.q);
    const vy = sx * f.x + sy * f.y + sz * f.z;
    out.aoa = Math.atan2(-vz, vy); out.slip = Math.atan2(vx, vy);
    const ve = sx * east.x + sy * east.y + sz * east.z, vn = sx * north.x + sy * north.y + sz * north.z;
    h = Math.atan2(ve, vn);
    out.track = h < 0 ? h + TAU : h;
    out.climb = Math.asin(clamp((sx * u.x + sy * u.y + sz * u.z) / sp, -1, 1));
  } else { out.aoa = 0; out.slip = 0; out.track = out.heading; out.climb = 0; }
  return out;
}
/** Total wing area (m²) that lifts along craft Z (the "wings" of an aeroplane) and its lift-curve slope × area. */
export function wingLoading(v) {
  let area = 0, k = 0;
  for (const p of v.wingParts) { const a = Math.abs(p._tilt ? p._nz : p._ox) * p._wArea; area += a; k += a * Math.min(p._wSlope * p._wStall, 1.4); }
  return { area, clArea: k };
}
/** Level-flight stall speed (m/s) at the vessel's altitude: where full lift just carries the weight. Infinity without wings or air. */
export function stallSpeed(v) {
  const { clArea } = wingLoading(v);
  const rho = v.body.density(Math.max(0, v.altitude || 0));
  if (!(clArea > 0) || !(rho > 0)) return Infinity;
  const R = v.pos.length() || v.body.radius;
  return Math.sqrt(2 * v.mass * (v.body.gm / (R * R)) / (rho * clArea));
}
/** Lifting area (m²) and lift-curve slope (per rad) of a part definition: wings and fins lift, nothing else does. */
export function liftArea(def) { const w = def && (def.wing || def.fin); return w ? (w.area || 0) : 0; }
export function liftSlope(def) { return def && def.wing ? (def.wing.slope || TUNING.WING_SLOPE) : TUNING.FIN_LIFT; }
/** Group names an action can be bound to: custom '1'..'9' and the four named ones. */
/**
 * How a wheeled vehicle is scaled to the gravity it stands in: 1 at Verda-like gravity, g / WHEEL_G_REF below it.
 * Three things follow it, so that a rover handles the same way everywhere instead of being built for one world:
 * the spring rate (× scale: the same static sag, so the wheels can follow the ground), the motor governor
 * (top speed × scale^¾: the speed at which a given bump throws the vehicle clear of the ground goes as √g, and
 * flat out leaves less in hand than a cruise does), and,
 * through each wheel's load, the push its motor may apply (TUNING.WHEEL_DRIVE_MU).
 */
export function wheelGravityScale(g) { return clamp(g / TUNING.WHEEL_G_REF, TUNING.WHEEL_G_MIN, 1); }
/** The fastest a rover should cruise on a body's open ground (m/s), given its speed for Verda-like gravity. */
export function roverCruiseSpeed(body, speed = 8) { return Math.max(1.2, speed * Math.sqrt(wheelGravityScale(body.surfaceG))); }

export const ACTION_GROUPS = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'gear', 'lights', 'brakes', 'abort']);
const ACTION_LABELS = {
  toggleEngine: 'Toggle engine', activateEngine: 'Start engine', shutdownEngine: 'Shut down engine', deployChute: 'Deploy parachute',
  cutChute: 'Cut parachute', decouple: 'Decouple', toggleLegs: 'Toggle leg', toggleGear: 'Toggle landing gear', toggleSolar: 'Toggle panel',
  toggleLight: 'Toggle light', toggleAirbrake: 'Toggle air brake', runExperiment: 'Run experiment', undock: 'Undock',
};
/** Actions a part of this definition offers to action groups: [{id, label}] (empty for inert parts). */
export function partActions(def) {
  const out = [];
  if (!def) return out;
  const add = id => out.push({ id, label: ACTION_LABELS[id] });
  if (def.engine) { add('toggleEngine'); add('activateEngine'); add('shutdownEngine'); }
  if (def.chute) { add('deployChute'); add('cutChute'); }
  if (def.decoupler) add('decouple');
  if (def.legs) add('toggleLegs');
  if (def.wheel && def.wheel.retract) add('toggleGear');
  if (def.solar && !def.solar.fixed) add('toggleSolar');
  if (def.light) add('toggleLight');
  if (def.airbrake) add('toggleAirbrake');
  if (def.experiment) add('runExperiment');
  if (def.dock) add('undock');
  return out;
}
function cloneGroups(g) {
  const out = {};
  if (g && typeof g === 'object') for (const k in g) if (Array.isArray(g[k])) out[k] = g[k].filter(a => a && a.part !== undefined).map(a => ({ part: a.part, action: a.action || 'toggle' }));
  return out;
}
const RING_N = 8;
const RING_COS = [], RING_SIN = [];
for (let i = 0; i < RING_N; i++) { RING_COS.push(Math.cos(i * TAU / RING_N)); RING_SIN.push(Math.sin(i * TAU / RING_N)); }

function makePart(id, type, pos, rot, sym) {
  const def = partDef(type);
  return {
    id, type, def, pos: new Vector3(pos.x, pos.y, pos.z), rot: rot || 0, links: [], res: { ...def.res },
    ignited: false, flameout: false, deployed: def.chute ? 'stowed' : (def.wheel ? true : false), deployT: 0,
    temp: TUNING.AMBIENT_T, crew: [], sym: sym || 0, destroyed: false, thrust: 0, level: 0, mass: 0,
    pitch: 0, roll: 0,    // optional tilt of a surface part (craft.js "part orientation"): Ry(rot)·Rx(flip)·Rz(pitch)·Rx(roll)
    flip: false,          // true: the part is upside down in craft coords (orientation = yaw(rot) · flipX); set by docking
    dockedTo: null,       // docking ports: id of the port this one is latched to
    truss: null,          // interstage trusses this part carries (Craft.interstages()): [{ side, h, r0, r1, mass }], side = ±1
                          // along the part's OWN axis (+1 = from its top node end), so it survives a change of craft frame
  };
}

const _fq = new Quaternion();
/** Orientation of a part in craft axes: Ry(rot) · Rx(flip ? π : 0) · Rz(pitch) · Rx(roll) (same as craft.js partQuat). */
function partQuatTo(p, out) {
  out.set(0, Math.sin((p.rot || 0) / 2), 0, Math.cos((p.rot || 0) / 2));
  if (p.flip) out.multiply(_fq.set(1, 0, 0, 0));
  if (p.pitch) out.multiply(_fq.set(0, 0, Math.sin(p.pitch / 2), Math.cos(p.pitch / 2)));
  if (p.roll) out.multiply(_fq.set(Math.sin(p.roll / 2), 0, 0, Math.cos(p.roll / 2)));
  return out;
}
const _pq = new Quaternion();

function sasAxis(e, w, alpha, T) {
  if (!(alpha > 1e-7)) return 0;
  const a = Math.abs(e);
  let wd = Math.min(TUNING.SAS_KP * a, Math.sqrt(alpha * a), TUNING.SAS_WMAX);
  if (e < 0) wd = -wd;
  return clamp((wd - w) / (alpha * T), -1, 1);
}

export class Vessel {
  constructor() {
    this.id = 0;
    this.name = 'Vessel';
    this.type = 'ship';
    this.parts = new Map();
    this.stages = [];
    this.stageIndex = 0;
    this.controlId = null;
    this.body = SYSTEM.home;
    this.pos = new Vector3(SYSTEM.home.radius + 100000, 0, 0);
    this.vel = new Vector3();
    this.q = new Quaternion();
    this.w = new Vector3();
    this.landed = false;
    this.splashed = false;
    this.surface = null;          // {dir: Vector3 body-fixed, qRel: Quaternion, h, qTarget?}
    this.onRails = false;
    this.orbit = null;
    this.ctrl = defaultCtrl();
    this.sasTarget = null;        // Quaternion held by SAS 'hold'
    this.sasDir = new Vector3(0, 1, 0);   // inertial direction for sasMode 'direction'
    this.targetId = null;         // body id (string) or vessel id (number); set it with world.setTarget()
    this.targetInfo = null;       // {name, kind, distance, relSpeed, closing, relVel, dir, relPos} refreshed by the World each step
    this.nodes = [];
    this.science = [];
    this.launched = false;        // false until first liftoff ('prelaunch')
    this.launchUt = 0;
    this.dead = false;
    this.sunlit = true;
    // derived
    this.mass = 0; this.com = new Vector3(); this.inertia = new Vector3(1, 1, 1);
    this.thrust = 0; this.maxThrust = 0; this.isp = 0;
    this.altitude = 0; this.radarAlt = 0; this.surfaceVel = new Vector3(); this.airspeed = 0;
    this.verticalSpeed = 0; this.horizontalSpeed = 0; this.orbitalSpeed = 0;
    this.dynamicPressure = 0; this.mach = 0; this.gForce = 0; this.heatFlux = 0; this.maxTempRatio = 0;
    this.situation = 'prelaunch';
    this.apoapsis = 0; this.periapsis = 0; this.period = 0;   // altitudes above the surface (m), s
    this.deltaV = 0; this.stageDeltaV = 0; this.stageInfo = [];
    this.resources = {};
    this.controllable = true;
    this.actuation = new Vector3();   // last torque command (pitch, roll, −yaw) in [−1, 1]
    this.cost = 0;
    this.crewCount = 0;
    this.nodeDv = 0;
    // private caches
    this._list = []; this._engines = []; this._chutes = []; this._fins = []; this._rcs = []; this._solar = [];
    this._legs = []; this._commands = []; this._res = {}; this._cp = []; this._ports = [];
    this._wheel = 0; this._finAuth = new Vector3(); this._rcsAuth = new Vector3(); this._rcsThrust = 0; this._rcsIsp = 240;
    this._baseH = 0; this._bound = 1; this._hot = false; this._stamp = 0; this._orbitStamp = -1;
    this._guideDir = null; this._sasCoast = false; this._dvTimer = 0; this._massDirty = false;
    this._lastSit = null;
    // second pass
    this.grounded = false;        // true while any part touches the ground / water (not pinned)
    this.groundContacts = 0;      // number of contact points pushing right now
    this.wheelsOnGround = 0;
    this.groundSpeed = 0;         // m/s over the ground (horizontal)
    this.sunDir = null;           // inertial unit vector to the star (set by the World); null = straight on every panel
    this.sunScale = 1;            // sunlight intensity relative to the home world's orbit
    this.actionGroups = {};       // { name: [{ part: id, action }] }
    this.commRange = 0; this.commLink = true; this.commDistance = 0;
    this.ctrlAccel = new Vector3();
    this.ladder = null;           // EVA holding a ladder: {vesselId, partId, y} (see World.evaGrab)
    this.launchSite = null;       // 'pad' | 'runway' for a vessel put there by World.launch
    this.stranded = false;        // a contract's castaway pod
    this._wings = []; this._wheels = []; this._lights = []; this._brakes = []; this._gens = []; this._labs = [];
    this._antennas = []; this._ladders = []; this._pts = []; this._ctlAuth = new Vector3();
    this._groundT = 0; this._airT = 99; this._sleepT = 0; this._touched = false; this._gnd = null; this._onWheels = false; this._rollUt = -1e9;
    this._driven = 0; this._impact = 0; this._wake = false;
    this.structure = null;        // joint loads, flex and failure (js/core/structure.js); null for a one-part vessel
  }

  // ------------------------------------------------------------------ construction
  static fromCraft(craft, { crew = [] } = {}) {
    const v = new Vessel();
    v.name = craft.name;
    for (const p of craft.parts) {
      const q = makePart(p.id, p.type, p.pos, p.rot, p.sym);
      if (p.flip) q.flip = true;
      if (Number.isFinite(p.pitch)) q.pitch = p.pitch;
      if (Number.isFinite(p.roll)) q.roll = p.roll;
      v.parts.set(p.id, q);
    }
    if (typeof craft.interstages === 'function') for (const t of craft.interstages()) {
      const q = v.parts.get(t.owner);
      if (q) (q.truss || (q.truss = [])).push({ side: t.dir * (q.flip ? -1 : 1), h: t.h, r0: t.r0, r1: t.r1, mass: t.mass });
    }
    for (const p of craft.parts) {
      if (p.parent === null || p.parent === undefined || !v.parts.has(p.parent)) continue;
      v.parts.get(p.id).links.push(p.parent);
      v.parts.get(p.parent).links.push(p.id);
    }
    v.stages = craft.stages.map(s => s.slice());
    const cp = craft.controlPart;
    v.controlId = cp ? cp.id : (craft.parts[0] ? craft.parts[0].id : null);
    const names = crew.slice();
    for (const p of v.parts.values()) {
      if (p.def.command !== 'crew') continue;
      while (p.crew.length < p.def.crew && names.length) p.crew.push(names.shift());
    }
    for (const p of v.parts.values()) {     // passenger / lab seats fill after the command seats
      if (p.def.command || !(p.def.crew > 0)) continue;
      while (p.crew.length < p.def.crew && names.length) p.crew.push(names.shift());
    }
    v.actionGroups = cloneGroups(craft.actionGroups);
    v._rebuild();
    v._updateMass(false);
    v.updateResources();
    v.estimateDeltaV();
    return v;
  }

  /** A Pip on EVA: a one-part vessel. */
  static makePip(name) {
    const v = new Vessel();
    v.name = name; v.type = 'eva';
    const p = makePart(1, 'pip', { x: 0, y: 0, z: 0 }, 0, 0);
    p.crew.push(name);
    v.parts.set(1, p);
    v.controlId = 1;
    v.launched = true;
    v.ctrl.sas = true;
    v._rebuild();
    v._updateMass(false);
    v.updateResources();
    return v;
  }

  get controlPart() { return this.parts.get(this.controlId) || null; }
  /** Crew names aboard. */
  get crew() { const out = []; for (const p of this._list) for (const n of p.crew) out.push(n); return out; }
  /** Move a crew member to another part of this vessel that has a free seat. → true when moved. */
  transferCrew(name, partId) {
    const to = this.parts.get(partId);
    if (this.dead || !to || !((to.def.crew || 0) > to.crew.length)) return false;
    const from = this._list.find(p => p.crew.includes(name));
    if (!from || from === to) return false;
    from.crew.splice(from.crew.indexOf(name), 1);
    to.crew.push(name);
    return true;
  }
  partWorldPos(part, out = new Vector3()) {
    return out.copy(part.pos).sub(this.com).applyQuaternion(this.q).add(this.pos);
  }

  // ------------------------------------------------------------------ public read-only views (round 2)
  // These arrays are the vessel's live caches: read them, do not mutate them. They are rebuilt whenever the
  // part set changes (staging, explosions, docking, undocking) - watch `structureStamp` to notice that.
  /** Every part, in a stable order: VPart[]. */
  get partList() { return this._list; }
  /** Engines with the tanks that feed them: [{part: VPart, tanks: VPart[]}]. */
  get engines() { return this._engines; }
  /** Landing-leg parts. */
  get legParts() { return this._legs; }
  /** Solar-panel parts. */
  get solarParts() { return this._solar; }
  /** RCS thruster-block parts. */
  get rcsParts() { return this._rcs; }
  /** Parachute parts. */
  get chuteParts() { return this._chutes; }
  /** Command parts (capsules, probe cores, an EVA Pip). */
  get commandParts() { return this._commands; }
  /** Docking ports with an exposed face (free to dock). `port._face` is +1 (faces local +Y) or −1. */
  get dockPorts() { return this._ports; }
  /** Radius (m) of a sphere around the centre of mass that contains the whole vessel. */
  get boundRadius() { return this._bound; }
  /** Radius (m) of the footprint the vessel stands on. */
  get baseRadius() { return this._baseR; }
  /** Height (m) of the centre of mass above the lowest point of the vessel. */
  get baseHeight() { return this._baseH; }
  /** True while any part is warmer than ambient (re-entry heating); see maxTempRatio. */
  get isHot() { return this._hot; }
  /** Counter that changes whenever the PART SET or part geometry changes. Rebuild meshes when it differs. */
  get structureStamp() { return this._struct || 0; }
  /** Counter that changes whenever pos/vel changed (every physics step); cached orbits key off it. */
  get motionStamp() { return this._stamp; }
  /** Total RCS translation thrust (N) with every block firing. */
  get rcsThrust() { return this._rcsThrust; }
  /** Lifting surfaces (parts with `wing` or `fin`). Each has `_defl` (current control deflection, −1…1). */
  get wingParts() { return this._wings; }
  /** Wheels and landing gear (parts with `wheel`). `part.deployed` = gear down; `part._load` (N), `part._steer` (rad), `part._spin` (rad/s). */
  get wheelParts() { return this._wheels; }
  get lightParts() { return this._lights; }
  get airbrakeParts() { return this._brakes; }
  get labParts() { return this._labs; }
  get antennaParts() { return this._antennas; }
  get ladderParts() { return this._ladders; }

  // ------------------------------------------------------------------ topology caches
  _rebuild() {
    const parts = this.parts;
    const list = this._list = [...parts.values()];
    this._engines = []; this._chutes = []; this._fins = []; this._rcs = []; this._solar = []; this._legs = [];
    this._commands = []; this._res = {}; this._ports = [];
    this._wings = []; this._wheels = []; this._lights = []; this._brakes = []; this._gens = []; this._labs = [];
    this._antennas = []; this._ladders = [];
    this._struct = (this._struct || 0) + 1;
    let driven = 0, commRange = 0;
    let wheel = 0, cost = 0, crewCount = 0;
    for (const p of list) {   // effective end radii: a flipped part has its ends swapped
      const d = p.def, fl = !!p.flip;
      p._ty = fl ? -1 : 1;
      if (d.attach.stack) { p._rT = fl ? d.rBottom : d.rTop; p._rB = fl ? d.rTop : d.rBottom; }
      if (p.dockedTo !== null && p.dockedTo !== undefined && !(parts.has(p.dockedTo) && p.links.includes(p.dockedTo))) p.dockedTo = null;
    }
    for (const p of list) {
      const d = p.def;
      cost += d.cost;
      crewCount += p.crew.length;
      p.links = p.links.filter(id => parts.has(id));
      for (const k in p.res) (this._res[k] || (this._res[k] = [])).push(p);
      if (d.torque) wheel += d.torque * 1000 * (d.command === 'eva' ? TUNING.EVA_TORQUE : 1);
      if (d.command) this._commands.push(p);
      if (d.chute) this._chutes.push(p);
      if (d.rcs) this._rcs.push(p);
      if (d.solar) this._solar.push(p);
      if (d.legs) this._legs.push(p);
      if (d.wheel) { this._wheels.push(p); if (d.wheel.drive > 0) driven++; }
      if (d.light) this._lights.push(p);
      if (d.airbrake) this._brakes.push(p);
      if (d.generator || d.rtg) this._gens.push(p);
      if (d.lab || d.shape === 'lab') this._labs.push(p);
      if (d.antenna) { this._antennas.push(p); commRange = Math.max(commRange, antennaRange(d)); }
      if (d.ladder || d.shape === 'ladder') this._ladders.push(p);
      if (d.wing || d.fin) {
        const wg = d.wing || d.fin;
        p._wArea = wg.area || 0;
        p._wSlope = d.wing ? (wg.slope || TUNING.WING_SLOPE) : TUNING.FIN_LIFT;
        p._wStall = d.wing ? (wg.stall || TUNING.WING_STALL) : TUNING.FIN_STALL;
        const c = wg.control;
        p._wCtl = c === true ? 'auto' : (c === 'pitch' || c === 'roll' || c === 'yaw' || c === 'auto') ? c : null;
        p._wTau = d.wing ? (wg.allMoving ? 1 : TUNING.CTRL_TAU) : 1;
        p._defl = 0; p._kp = 0; p._kr = 0; p._ky = 0;
        this._wings.push(p);
      }
      p._stack = !!d.attach.stack;
      p._ox = Math.cos(p.rot); p._oz = -Math.sin(p.rot);
      // tilted parts (pitch / roll set in the builder): own +Y axis `_a*`, wing normal `_n*` and span `_s*` in craft axes
      p._tilt = !!(p.pitch || p.roll);
      if (p._tilt) {
        partQuatTo(p, _pq);
        _a.set(0, 1, 0).applyQuaternion(_pq); p._ax = _a.x; p._ay = _a.y; p._az = _a.z;
        _a.set(0, 0, -1).applyQuaternion(_pq); p._nx = _a.x; p._ny = _a.y; p._nz = _a.z;
        _a.set(1, 0, 0).applyQuaternion(_pq); p._sx = _a.x; p._sy = _a.y; p._sz = _a.z;
      } else { p._ax = 0; p._ay = p.flip ? -1 : 1; p._az = 0; }
      if (p._stack) {
        let coverTop = 0, coverBot = 0, hasTop = false, hasBot = false;
        for (const id of p.links) {
          const n = parts.get(id);
          if (!n.def.attach.stack) continue;
          if (Math.abs(n.pos.x - p.pos.x) > 1e-3 || Math.abs(n.pos.z - p.pos.z) > 1e-3) continue;
          if (n.pos.y > p.pos.y) { coverTop = Math.max(coverTop, n._rB); hasTop = true; } else { coverBot = Math.max(coverBot, n._rT); hasBot = true; }
        }
        p._hasT = hasTop; p._hasB = hasBot;
        if (d.dock) {   // a port is usable when one of its faces is exposed
          p._face = !hasTop ? 1 : !hasBot ? -1 : 0;
          if (p._face) this._ports.push(p);
        }
        p._covT = coverTop; p._covB = coverBot;
        const rT = p._rT, rB = p._rB, rM = Math.max(rT, rB);
        const dragT = p.flip ? d.drag.bottom : d.drag.top, dragB = p.flip ? d.drag.top : d.drag.bottom;
        let aUp = Math.PI * Math.max(0, rT * rT - coverTop * coverTop);
        let aDown = Math.PI * Math.max(0, rB * rB - coverBot * coverBot);
        // flat faces right the body when they lead; a cone flank does the opposite
        p._sUp = aUp * dragT; p._sDown = aDown * dragB;
        if (rB > rT) { const fl = Math.PI * (rB * rB - rT * rT); aUp += fl; p._sUp -= fl * dragT; }
        else if (rT > rB) { const fl = Math.PI * (rT * rT - rB * rB); aDown += fl; p._sDown -= fl * dragB; }
        p._aUp = aUp * dragT; p._aDown = aDown * dragB; p._aSide = (rT + rB) * d.h * d.drag.side;
        const ref = 0.5 * Math.PI * rM * rM;
        p._eUp = Math.min(1, aUp / ref); p._eDown = Math.min(1, aDown / ref);
      } else {
        p._aRad = (d.wing || d.fin) ? 0 : d.h * Math.max(d.t || 0.1, 0.1) * 0.8;
        if (d.fin) this._fins.push(p);
      }
    }
    this._wheel = wheel; this.cost = cost; this.crewCount = crewCount;
    this._driven = driven; this.commRange = commRange;
    // engines and the tanks of their section (parts reachable without crossing a decoupler part)
    for (const p of list) {
      if (!p.def.engine) continue;
      const tanks = [];
      const prop = engineProp(p.def);
      if (p.def.engine.type !== 'solid') {
        const seen = new Set([p.id]), queue = [p];
        for (let i = 0; i < queue.length; i++) {
          const cur = queue[i];
          if (cur.def.res[prop]) tanks.push(cur);
          for (const id of cur.links) {
            if (seen.has(id)) continue;
            const n = parts.get(id);
            if (n.def.decoupler) continue;
            seen.add(id); queue.push(n);
          }
        }
      }
      this._engines.push({ part: p, tanks, prop });
    }
    if (!parts.has(this.controlId)) {
      const c = this._commands[0];
      this.controlId = c ? c.id : (list[0] ? list[0].id : null);
    }
    this._buildContacts();
    if (list.length > 1 && this.type !== 'eva') { if (this.structure) this.structure.build(); else this.structure = new Structure(this); }
    else this.structure = null;
  }

  /**
   * How much further (radians) the nose can come up before something aft of the main gear touches the ground,
   * rotating about the rearmost axle: the margin to a tail strike. On or just above the ground it uses the live clearances
   * (so a squashed suspension counts); otherwise the craft's geometry with the gear half compressed.
   * Infinity when nothing can strike or fewer than two wheels are down (`gearDown`: count retracted gear as down).
   */
  tailStrikeMargin(gearDown = false) {
    let y0 = Infinity, gz = 0, n = 0;
    let sag = 0;      // how much further the main gear can still squash (that lowers the tail too)
    for (const p of this._wheels) { if (!p.deployed && !gearDown) continue; n++; if (p._wy < y0) { y0 = p._wy; gz = p._wz + 0.5 * (p._travel || 0); sag = Math.max(0, (p._travel || 0) - Math.max(0, -(p._hp || 0))); } }
    if (n < 2) return Infinity;
    const live = this.grounded || this.radarAlt < 4;
    let best = Infinity;
    for (const c of this._pts) {
      if (c.kind !== 0 || c.p.def.wheel || !(c.y < y0 - 0.05)) continue;
      const a = Math.atan2(live && Number.isFinite(c.hp) ? c.hp - sag : c.z - gz, y0 - c.y);
      if (a < best) best = a;
    }
    return Math.max(0, best);
  }

  _buildContacts() {
    const cp = this._cp = [];
    const pts = this._pts = [];     // discrete contact samples for the ground / water dynamics
    const bp = this._bpts = [];     // buoyancy blobs: {p, x, y, z, rho (half-size), share}
    let minY = Infinity;
    for (const p of this._list) {
      const d = p.def, h2 = d.h / 2;
      p._nPts = 0;
      if (p._stack) {
        const levels = d.h < 0.5 ? [0] : [-d.h / 4, d.h / 4];
        const rho = Math.max(d.h / (2 * levels.length), 0.12);
        for (const ly of levels) {
          const r = 0.8 * (d.rBottom + (d.rTop - d.rBottom) * ((p.flip ? -ly : ly) / d.h + 0.5));
          for (let i = 0; i < 4; i++) bp.push({ p, x: p.pos.x + r * RING_COS[i * 2], y: p.pos.y + ly, z: p.pos.z + r * RING_SIN[i * 2], rho, share: 1 / (4 * levels.length) });
        }
        const rr = Math.max(d.rTop, d.rBottom);
        p._vol = Math.PI * d.h / 3 * (d.rTop * d.rTop + d.rTop * d.rBottom + d.rBottom * d.rBottom) || Math.PI * rr * rr * d.h;
      } else {
        bp.push({ p, x: p.pos.x, y: p.pos.y, z: p.pos.z, rho: Math.max(0.1, 0.35 * Math.max(d.h, d.rw || 0.2)), share: 1 });
        p._vol = (d.rw || 0.2) * (d.t || 0.2) * d.h * 0.5;
      }
      const add = (x, y, z, kind) => { pts.push({ p, x, y, z, kind, pen: false, f: 0 }); p._nPts++; };
      if (p._stack) {
        const rB = p._rB ?? d.rBottom, rT = p._rT ?? d.rTop;
        cp.push({ p, x: p.pos.x, y: p.pos.y - h2, z: p.pos.z, r: rB });
        cp.push({ p, x: p.pos.x, y: p.pos.y + h2, z: p.pos.z, r: rT });
        // A rover chassis is a flat tub, not a drum: its belly is 0.46 r under the axis (the skid plate a little lower),
        // its deck 0.3 r above, 1.78 r wide (render/parts/shapes_stack.js rover_body). With a full ring the hull
        // reached almost to the tyres' contact patch and the first crest it met threw the rover over.
        const tub = d.shape === 'rover_body';
        const ring = (y, r) => {
          if (r < 0.08) { add(p.pos.x, y, p.pos.z, 0); return; }
          if (tub) {
            const zb = -0.46 * r - 0.04, zt = 0.3 * r, w = 1.78 * r;
            for (const sx of [-1, 1]) { add(p.pos.x + sx * 0.3 * w, y, p.pos.z + zb, 0); add(p.pos.x + sx * 0.5 * w, y, p.pos.z + zt - 0.14 * r, 0); add(p.pos.x + sx * 0.43 * w, y, p.pos.z + zt, 0); }
            return;
          }
          for (let i = 0; i < RING_N; i++) add(p.pos.x + r * RING_COS[i], y, p.pos.z + r * RING_SIN[i], 0);
        };
        // a ring hidden inside an equal or wider neighbour is represented by that neighbour
        if (!((p._covB || 0) > rB + 1e-6)) ring(p.pos.y - h2, rB);
        if (!((p._covT || 0) >= rT - 1e-6)) ring(p.pos.y + h2, rT);
        else if ((p._covB || 0) > rB + 1e-6) add(p.pos.x, p.pos.y, p.pos.z, 0);
        // An interstage truss stands on this part and reaches the height of the engine it wrapped. While that engine
        // is still there its own mount ring (or the tank on it) is the contact; once the stack has split the open
        // rim of the lattice is the first thing to touch the ground.
        if (p.truss) for (const t of p.truss) {
          const dir = t.side * (p.flip ? -1 : 1);
          if (dir > 0 ? p._hasT : p._hasB) continue;
          const ty = p.pos.y + dir * (h2 + t.h);
          cp.push({ p, x: p.pos.x, y: ty, z: p.pos.z, r: t.r1 });
          ring(ty, t.r1);
        }
      } else if (d.wheel) {
        // tyre bottom with the suspension unloaded: wheels roll along craft +Y and stand on craft −Z
        const ext = Math.max(d.wheel.radius || 0.3, -p._oz * (d.rw || 0) / 2);
        p._wx = p.pos.x; p._wy = p.pos.y; p._wz = p.pos.z - ext;
        p._travel = Math.max(0.08, (d.wheel.travel || 0.6 * (d.wheel.radius || 0.3)));
        p._load = p._load || 0; p._steer = p._steer || 0; p._spin = p._spin || 0;
        if (p.deployed) {
          cp.push({ p, x: p._wx, y: p._wy, z: p._wz, r: 0 });
          add(p.pos.x, p.pos.y, p.pos.z - ext + Math.min(ext * 0.8, p._travel * 1.2), 2);   // hub / strut: crumples when the suspension bottoms out
        } else add(p.pos.x, p.pos.y, p.pos.z, 0);
      } else {
        // radial parts are a little shorter than their box; a whip antenna is drawn the whole length of it (a rover
        // stood on its tail on the pad had 6 cm of antenna in the slab)
        const r = (d.rw || 0.2) / 2, hr = h2 * (d.shape === 'antenna' ? 1 : 0.9);
        cp.push({ p, x: p.pos.x, y: p.pos.y - hr, z: p.pos.z, r });
        cp.push({ p, x: p.pos.x, y: p.pos.y + hr, z: p.pos.z, r });
        add(p.pos.x + p._ox * r, p.pos.y - hr, p.pos.z + p._oz * r, 0);
        add(p.pos.x + p._ox * r, p.pos.y + hr, p.pos.z + p._oz * r, 0);
        if (d.legs && !p.deployed) {
          // stowed, the pad hangs under the housing: its sole 3 cm (of the strut's scale) below the box, its rim out
          // to 0.24 from the part's middle (render/partmesh.js applyAnim, shapes_aero.js leg). A lander that stands
          // on its stowed legs (Moonstep on the pad) stood 9 cm into the slab.
          const ls = d.h / 1.2, sg = p.flip ? -1 : 1, sy = p.pos.y - (h2 + 0.03 * ls) * sg, fr = (d.variant === 'heavy' ? 0.26 : 0.2) * ls;
          cp.push({ p, x: p.pos.x + p._ox * 0.04 * ls, y: sy, z: p.pos.z + p._oz * 0.04 * ls, r: 0 });
          add(p.pos.x + p._ox * 0.04 * ls, sy, p.pos.z + p._oz * 0.04 * ls, 0);
          add(p.pos.x + p._ox * (0.04 * ls + fr), sy + 0.025 * ls * sg, p.pos.z + p._oz * (0.04 * ls + fr), 0);
        }
        if (d.legs && p.deployed) {
          const fx = p.pos.x + p._ox * d.legs.spread, fy = p.pos.y - d.legs.reach * (p.flip ? -1 : 1), fz = p.pos.z + p._oz * d.legs.spread;
          cp.push({ p, x: fx, y: fy, z: fz, r: 0 });
          // The foot and the rim of its pad belong to the leg's suspension (`leg`): _contact closes the strut by what
          // the deepest of them is under the ground, up to its stroke, and only then are they a hard contact.
          p._lp0 = pts.length; p._stroke = Math.max(0.02, d.legs.stroke || TUNING.LEG_STROKE * d.legs.reach); p._sg = p.flip ? -1 : 1;
          p._comp = p._comp || 0; p._pen = 0; p._x = p._x || 0;
          add(fx, fy, fz, 1);
          // The foot is a dished pad, not a point (render/parts/shapes_aero.js leg: radius 0.2 of the strut's scale,
          // 0.26 on the heavy one, its rim 2.5 cm above its sole). Without the rim a craft lying on its side had the
          // pads standing 20 cm into the ground, and on a slope the downhill edge of each pad was buried.
          const ls = d.h / 1.2, fr = (d.variant === 'heavy' ? 0.26 : 0.2) * ls, ry = fy + 0.025 * ls * (p.flip ? -1 : 1);
          add(fx + p._ox * fr, ry, fz + p._oz * fr, 1); add(fx - p._ox * fr, ry, fz - p._oz * fr, 1);
          add(fx - p._oz * fr, ry, fz + p._ox * fr, 1); add(fx + p._oz * fr, ry, fz - p._ox * fr, 1);
          for (let i = p._lp0; i < pts.length; i++) pts[i].leg = true;
        } else if (d.legs) { p._comp = 0; p._pen = 0; p._x = 0; }
      }
    }
    for (const c of cp) minY = Math.min(minY, c.y);
    this._minY = cp.length ? minY : 0;
    // footprint of a wheeled vehicle (three or more wheels down): how far its tyres stand from the middle of them
    { let n = 0, sx = 0, sy = 0, far = 0;
      for (const p of this._wheels) if (p.deployed) { n++; sx += p._wx; sy += p._wy; }
      if (n >= 3) { sx /= n; sy /= n; for (const p of this._wheels) if (p.deployed) far = Math.max(far, Math.hypot(p._wx - sx, p._wy - sy)); }
      const span = n >= 3 ? clamp(far, 0.5, 6) : 0;
      if (span !== this._wheelSpan) { this._wheelSpan = span; if (this._gnd) this._gnd.body = null; } }
    this._contactStats();
  }
  _contactStats() {
    let baseR = 0, bound = 0;
    const com = this.com;
    for (const c of this._cp) {
      if (c.y <= this._minY + 0.15) baseR = Math.max(baseR, Math.hypot(c.x - com.x, c.z - com.z) + c.r);
      bound = Math.max(bound, Math.hypot(c.x - com.x, c.y - com.y, c.z - com.z) + c.r);
    }
    this._baseR = baseR; this._bound = bound + 0.5;
    this._baseH = com.y - this._minY;
  }

  /** Recompute mass, centre of mass and inertia. With `shift`, `pos` follows the CoM so parts do not jump. */
  _updateMass(shift = true) {
    let m = 0, cx = 0, cy = 0, cz = 0;
    for (const p of this._list) {
      let pm = p.def.mass * 1000;
      const res = p.res, cy0 = cy;
      for (const k in res) if (k !== 'elec') pm += res[k];
      if (p.truss) for (const t of p.truss) {   // the lattice ring it carries: its mass sits half-way up the ring
        pm += t.mass;
        cy += t.mass * t.side * (p.flip ? -1 : 1) * (p.def.h + t.h) / 2;
      }
      p.mass = pm;
      m += pm; cx += pm * p.pos.x; cy += pm * p.pos.y; cz += pm * p.pos.z;
      const oy = p.def.comY;   // ballast low in a capsule: its mass sits off the part's centre along its own axis
      if (oy) { cx += pm * oy * (p._ax || 0); cy += pm * oy * (p._ay ?? (p.flip ? -1 : 1)); cz += pm * oy * (p._az || 0); }
      // where this part's mass sits (ballast and truss included): structure.js takes its loads about these points
      p._mx = p.pos.x + (oy ? oy * (p._ax || 0) : 0); p._mz = p.pos.z + (oy ? oy * (p._az || 0) : 0);
      p._my = pm > 0 ? (cy - cy0) / pm : p.pos.y;
    }
    if (!(m > 0)) { this.mass = 0; return; }
    cx /= m; cy /= m; cz /= m;
    let ix = 0, iy = 0, iz = 0;
    for (const p of this._list) {
      const d = p.def, pm = p.mass;
      // NOTE (found by tests/verify chapter 7): this takes the part's geometric centre, not its mass point (_mx, _my,
      // _mz), so a capsule's ballast offset is missing here: up to 9 % too much inertia for a capsule on a short stack.
      // Left as it is in this pass because correcting it changes how every landing is flown; see docs/STRUCTURE.md.
      const dx = p.pos.x - cx, dy = p.pos.y - cy, dz = p.pos.z - cz;
      const r = p._stack ? Math.max(d.rTop, d.rBottom) : (d.rw || 0.2) / 2;
      const own = pm * (3 * r * r + d.h * d.h) / 12;
      ix += pm * (dy * dy + dz * dz) + own;
      iz += pm * (dy * dy + dx * dx) + own;
      iy += pm * (dx * dx + dz * dz) + pm * r * r / 2;
    }
    const com = this.com;
    if (shift && (cx !== com.x || cy !== com.y || cz !== com.z)) {
      _a.set(cx - com.x, cy - com.y, cz - com.z);
      if (!this.landed) {
        // velocity of the new CoM point, then move the reference point
        _b.crossVectors(this.w, _a).applyQuaternion(this.q);
        this.vel.add(_b);
        this.pos.add(_a.applyQuaternion(this.q));
      }
    }
    com.set(cx, cy, cz);
    this.mass = m;
    const floor = m * 0.02;
    this.inertia.set(Math.max(ix, floor), Math.max(iy, floor), Math.max(iz, floor));
    // control authority sums that depend on the CoM
    this._finAuth.set(0, 0, 0);
    // control surfaces: how much each one helps pitch / roll / yaw follows from where it sits relative to the CoM
    let Lx = 0.05, Ly = 0.05, Lz = 0.05;
    for (const p of this._wings) {
      if (!p._wCtl) continue;
      const nx = p._tilt ? p._nx : p._oz, ny = p._tilt ? p._ny : 0, nz = p._tilt ? p._nz : -p._ox;
      const rx = p.pos.x - cx, ry = p.pos.y - cy, rz = p.pos.z - cz;
      p._tx = ry * nz - rz * ny; p._ty = rz * nx - rx * nz; p._tz = rx * ny - ry * nx;     // torque per unit force along the wing normal
      const c = p._wCtl;
      if ((c === 'auto' || c === 'pitch') && Math.abs(p._tx) > Lx) Lx = Math.abs(p._tx);
      if ((c === 'auto' || c === 'roll') && Math.abs(p._ty) > Ly) Ly = Math.abs(p._ty);
      if ((c === 'auto' || c === 'yaw') && Math.abs(p._tz) > Lz) Lz = Math.abs(p._tz);
    }
    const ca = this._ctlAuth.set(0, 0, 0);
    for (const p of this._wings) {
      p._kp = p._kr = p._ky = 0;
      const c = p._wCtl;
      if (!c) continue;
      const gain = (t, L) => { const k = t / L; return Math.abs(k) < 0.25 ? 0 : k; };
      if (c === 'auto' || c === 'pitch') p._kp = c === 'pitch' ? Math.sign(p._tx) || 0 : gain(p._tx, Lx);
      if (c === 'auto' || c === 'roll') p._kr = c === 'roll' ? Math.sign(p._ty) || 0 : gain(p._ty, Ly);
      if (c === 'auto' || c === 'yaw') p._ky = c === 'yaw' ? Math.sign(p._tz) || 0 : gain(p._tz, Lz);
      const f = p._wArea * p._wSlope * p._wTau * TUNING.CTRL_DEFLECT;
      ca.x += f * Math.abs(p._tx * p._kp); ca.y += f * Math.abs(p._ty * p._kr); ca.z += f * Math.abs(p._tz * p._ky);
    }
    const ra = this._rcsAuth.set(0, 0, 0);
    let rt = 0;
    for (const p of this._rcs) {
      const T = p.def.rcs.thrust * 1000, dy = Math.abs(p.pos.y - cy), R = Math.hypot(p.pos.x - cx, p.pos.z - cz);
      ra.x += T * dy * TUNING.RCS_ARM; ra.z += T * dy * TUNING.RCS_ARM; ra.y += T * R * TUNING.RCS_ARM;
      rt += T; this._rcsIsp = p.def.rcs.isp;
    }
    this._rcsThrust = rt;
    this._contactStats();
    this._massDirty = false;
  }

  // ------------------------------------------------------------------ resources
  _total(k) { const l = this._res[k]; let t = 0; if (l) for (const p of l) t += p.res[k]; return t; }
  /** Draw `amount` of a pooled resource; returns what was actually drawn. */
  _drain(k, amount) {
    const l = this._res[k];
    if (!l || !(amount > 0)) return 0;
    let total = 0;
    for (const p of l) total += p.res[k];
    if (total <= 0) return 0;
    if (amount >= total) { for (const p of l) p.res[k] = 0; return total; }
    const f = 1 - amount / total;
    for (const p of l) p.res[k] *= f;
    return amount;
  }
  _fill(k, amount) {
    const l = this._res[k];
    if (!l) return;
    let free = 0;
    for (const p of l) free += p.def.res[k] - p.res[k];
    if (free <= 0) return;
    const f = Math.min(1, amount / free);
    for (const p of l) p.res[k] += (p.def.res[k] - p.res[k]) * f;
  }
  updateResources() {
    const out = this.resources;
    for (const k in out) { out[k].amount = 0; out[k].max = 0; }
    for (const p of this._list) {
      for (const k in p.res) {
        const r = out[k] || (out[k] = { amount: 0, max: 0 });
        r.amount += p.res[k]; r.max += p.def.res[k];
      }
    }
    return out;
  }

  /**
   * Pump `amount` of `resource` ('fuel' | 'mono' | 'elec' | ...) from one part of this vessel to another
   * (docked vessels are one vessel, so this is how a tanker refuels a station). Limited by what the source
   * holds and by the free room in the destination. Returns the amount actually moved.
   */
  transferResource(fromPartId, toPartId, resource, amount = Infinity) {
    const a = this.parts.get(fromPartId), b = this.parts.get(toPartId);
    if (!a || !b || a === b || !(amount > 0)) return 0;
    if (!(resource in a.res) || !(resource in b.res)) return 0;
    if (resource === 'solid' || resource === 'ablator' || resource === 'evafuel') return 0;
    const moved = Math.max(0, Math.min(amount, a.res[resource], b.def.res[resource] - b.res[resource]));
    if (!(moved > 0)) return 0;
    a.res[resource] -= moved; b.res[resource] += moved;
    if (resource !== 'elec') this._updateMass(true);
    for (const e of this._engines) if (e.part.flameout && e.part.def.engine.type !== 'solid' && e.tanks.some(t => t.res[e.prop] > 0)) e.part.flameout = false;
    this.updateResources();
    this.estimateDeltaV();
    return moved;
  }

  // ------------------------------------------------------------------ docking
  /** World position of a docking port's mating face and its outward axis (unit, world). Returns `outPos`. */
  portWorld(port, outPos = new Vector3(), outAxis = null) {
    const f = port._face || 1;
    outPos.set(port.pos.x, port.pos.y + f * port.def.h / 2, port.pos.z).sub(this.com).applyQuaternion(this.q).add(this.pos);
    if (outAxis) outAxis.set(0, f, 0).applyQuaternion(this.q);
    return outPos;
  }
  /** Inertial velocity of a point fixed to the vessel at craft coordinates (x, y, z). */
  pointVelocity(x, y, z, out = new Vector3()) {
    _e.set(x, y, z).sub(this.com);
    return out.crossVectors(this.w, _e).applyQuaternion(this.q).add(this.vel);
  }
  /** Ids of the ports of every docked pair: [[idA, idB], ...]. */
  get dockedPairs() {
    const out = [];
    for (const p of this._list) if (p.def.dock && p.dockedTo !== null && p.dockedTo !== undefined && p.id < p.dockedTo) out.push([p.id, p.dockedTo]);
    return out;
  }

  /**
   * Merge `other` into this vessel, port to port (called by the World when two free ports capture).
   * The other vessel's parts are re-expressed in this vessel's craft coordinates (ids are shifted past this
   * vessel's highest id), linear and angular momentum are conserved, this vessel keeps its control part.
   * Returns {idMap: Map(oldId → newId), portId, otherPortId} or null.
   */
  absorb(other, myPort, otherPort) {
    if (!other || other === this || this.landed || other.landed) return null;
    if (!myPort || !otherPort || !myPort._face || !otherPort._face) return null;
    const sA = myPort._face, sB = otherPort._face;
    const mA = this.mass, mB = other.mass, M = mA + mB;
    // --- conserved quantities (relative to this vessel's SOI body)
    const cPos = new Vector3().copy(this.pos).multiplyScalar(mA / M).addScaledVector(other.pos, mB / M);
    const cVel = new Vector3().copy(this.vel).multiplyScalar(mA / M).addScaledVector(other.vel, mB / M);
    const L = new Vector3();
    const spin = (v) => _a.set(v.inertia.x * v.w.x, v.inertia.y * v.w.y, v.inertia.z * v.w.z).applyQuaternion(v.q);
    L.add(spin(this)); L.add(spin(other));
    L.addScaledVector(_a.copy(this.pos).sub(cPos).cross(_b.copy(this.vel).sub(cVel)), mA);
    L.addScaledVector(_a.copy(other.pos).sub(cPos).cross(_b.copy(other.vel).sub(cVel)), mB);
    // --- snapped relative attitude: yaw θ about the stack axis, plus a flip when the ports face the same way
    _qa.copy(this.q).invert().multiply(other.q);
    _a.set(1, 0, 0).applyQuaternion(_qa);
    const theta = Math.atan2(-_a.z, _a.x);
    const flip = sA * sB > 0;
    const ct = Math.cos(theta), st = Math.sin(theta);
    const fax = myPort.pos.x, fay = myPort.pos.y + sA * myPort.def.h / 2, faz = myPort.pos.z;
    const fbx = otherPort.pos.x, fby = otherPort.pos.y + sB * otherPort.def.h / 2, fbz = otherPort.pos.z;
    let offset = 0;
    for (const id of this.parts.keys()) if (id > offset) offset = id;
    for (const st2 of this.stages) for (const id of st2) if (id > offset) offset = id;
    const idMap = new Map();
    for (const id of other.parts.keys()) idMap.set(id, id + offset);
    const myName = this.name, otherName = other.name, otherType = other.type;
    for (const p of other.parts.values()) {
      let x = p.pos.x - fbx, y = p.pos.y - fby, z = p.pos.z - fbz;
      if (flip) { y = -y; z = -z; }
      p.pos.set(fax + x * ct + z * st, fay + y, faz - x * st + z * ct);
      if (flip) { p.rot = theta - p.rot; p.flip = !p.flip; } else p.rot = theta + p.rot;
      p.id = idMap.get(p.id);
      p.links = p.links.filter(id => idMap.has(id)).map(id => idMap.get(id));
      if (p.dockedTo !== null && p.dockedTo !== undefined) p.dockedTo = idMap.get(p.dockedTo) ?? null;
      this.parts.set(p.id, p);
    }
    myPort.links.push(otherPort.id); otherPort.links.push(myPort.id);
    myPort.dockedTo = otherPort.id; otherPort.dockedTo = myPort.id;
    myPort.dockName = myName; myPort.dockType = this.type;
    otherPort.dockName = otherName; otherPort.dockType = otherType;
    myPort.dockReady = otherPort.dockReady = true;
    // staging: what the absorbed vessel had left to fire goes after this vessel's own stages
    for (let i = other.stageIndex; i < other.stages.length; i++) {
      const st3 = other.stages[i].filter(id => idMap.has(id)).map(id => idMap.get(id));
      if (st3.length) this.stages.push(st3);
    }
    for (const r of other.science) {
      if (!this.science.some(x => x.experiment === r.experiment && x.situation === r.situation && x.bodyId === r.bodyId)) this.science.push(r);
    }
    if (this.type === 'debris' && otherType === 'ship') this.type = 'ship';
    other.parts = new Map(); other._list = []; other._ports = [];
    other.stages = []; other.nodes = [];
    other.dead = true; other.absorbedInto = this;
    // --- new rigid body
    this._rebuild();
    this._updateMass(false);
    this.pos.copy(cPos); this.vel.copy(cVel);
    _qi.copy(this.q).invert();
    L.applyQuaternion(_qi);
    this.w.set(L.x / this.inertia.x, L.y / this.inertia.y, L.z / this.inertia.z);
    this.sasTarget = null;
    this._stamp++;
    this.updateResources();
    this.estimateDeltaV();
    for (const g in other.actionGroups) {
      const add = other.actionGroups[g].filter(a => idMap.has(a.part)).map(a => ({ part: idMap.get(a.part), action: a.action }));
      if (add.length) this.actionGroups[g] = (this.actionGroups[g] || []).concat(add);
    }
    return { idMap, portId: myPort.id, otherPortId: otherPort.id };
  }

  /**
   * Release the docked port `partId`: the side without the control part becomes a new Vessel (returned; the
   * World gives it an id). Both get a small push apart. Returns null if that port is not docked.
   */
  undockPort(partId, pushSpeed = 0.3) {
    const a = this.parts.get(partId);
    if (!a || a.dockedTo === null || a.dockedTo === undefined) return null;
    const b = this.parts.get(a.dockedTo);
    if (!b) { a.dockedTo = null; return null; }
    a.links = a.links.filter(id => id !== b.id);
    b.links = b.links.filter(id => id !== a.id);
    a.dockedTo = null; b.dockedTo = null;
    a.dockReady = false; b.dockReady = false;   // re-armed once the ports have drifted apart
    const keep = this._component(this.controlId, null);
    const near = keep.has(a.id) ? a : b, far = near === a ? b : a;
    if (keep.has(far.id)) { this._rebuild(); return null; }   // still joined some other way
    const ids = this._component(far.id, null);
    const axis = new Vector3().copy(far.pos).sub(near.pos);
    if (axis.lengthSq() < 1e-9) axis.set(0, 1, 0);
    axis.normalize().applyQuaternion(this.q);
    const other = this._splitOff(ids);
    if (far.dockName) other.name = far.dockName;
    if (far.dockType && other.type !== 'debris') other.type = far.dockType;
    const M = this.mass + other.mass;
    if (M > 0) {
      this.vel.addScaledVector(axis, -pushSpeed * other.mass / M);
      other.vel.addScaledVector(axis, pushSpeed * this.mass / M);
    }
    other._normalizeFrame();
    other.ctrl.sas = true; other.ctrl.sasMode = 'hold';
    this.sasTarget = null;
    this._stamp++;
    this.estimateDeltaV(); other.estimateDeltaV();
    return other;
  }

  /** If the control part is upside down in craft coordinates (after undocking a flipped module), turn the
   *  craft frame over so that local +Y is the control part's nose again. The world state does not change. */
  _normalizeFrame() {
    const c = this.controlPart;
    if (!c || !c.flip) return false;
    for (const p of this.parts.values()) { p.pos.set(p.pos.x, -p.pos.y, -p.pos.z); p.rot = -p.rot; p.flip = !p.flip; }
    this.com.set(this.com.x, -this.com.y, -this.com.z);
    this.q.multiply(_qa.set(1, 0, 0, 0)).normalize();
    this.w.set(this.w.x, -this.w.y, -this.w.z);
    this.sasTarget = null;
    this._rebuild();
    this._updateMass(false);
    return true;
  }

  // ------------------------------------------------------------------ staging and splitting
  /** Part ids that would be dropped if the decouplers in `ids` fired now. */
  dropSet(ids) {
    const cut = new Set();
    for (const id of ids) { const p = this.parts.get(id); if (p && p.def.decoupler) cut.add(id); }
    const drop = new Set();
    if (!cut.size) return drop;
    const keep = this._component(this.controlId, cut);
    for (const p of this._list) if (!keep.has(p.id)) drop.add(p.id);
    return drop;
  }
  _component(startId, blocked) {
    const seen = new Set();
    if (!this.parts.has(startId) || (blocked && blocked.has(startId))) return seen;
    seen.add(startId);
    const queue = [startId];
    for (let i = 0; i < queue.length; i++) {
      for (const id of this.parts.get(queue[i]).links) {
        if (seen.has(id) || (blocked && blocked.has(id)) || !this.parts.has(id)) continue;
        seen.add(id); queue.push(id);
      }
    }
    return seen;
  }
  /** True if some stage at or after stageIndex still holds an engine. */
  hasEngineStagesLeft() {
    for (let i = this.stageIndex; i < this.stages.length; i++) {
      for (const id of this.stages[i]) { const p = this.parts.get(id); if (p && p.def.engine) return true; }
    }
    return false;
  }

  /** Fire the next stage. Returns the list of events ({type, ...}); debris vessels arrive in 'decouple' events. */
  activateNextStage(events = []) {
    if (this.stageIndex >= this.stages.length) return events;
    const si = this.stageIndex++;
    const ids = this.stages[si].slice();
    events.push({ type: 'stage', vessel: this, stage: si });
    for (const id of ids) {
      const p = this.parts.get(id);
      if (p && p.def.decoupler) this._decouple(p, events);
    }
    for (const id of ids) {
      const p = this.parts.get(id);
      if (!p) continue;
      if (p.def.engine && !p.ignited) { p.ignited = true; }
      else if (p.def.chute && p.deployed === 'stowed') {
        p.deployed = 'armed';
        events.push({ type: 'chute', vessel: this, part: p, state: 'armed' });
      }
    }
    this.estimateDeltaV();
    return events;
  }

  _decouple(dec, events) {
    const keep = this._component(this.controlId, new Set([dec.id]));
    if (!keep.size) return;
    // the decoupler lets go of the controlling side and stays with the rest
    for (const id of dec.links.slice()) {
      if (!keep.has(id)) continue;
      const n = this.parts.get(id);
      n.links = n.links.filter(x => x !== dec.id);
      dec.links = dec.links.filter(x => x !== id);
    }
    const ids = this._component(dec.id, null);
    const keepCom = this._comOf(keep), dropCom = this._comOf(ids);
    const debris = this._splitOff(ids);
    // separation impulse
    const J = dec.def.decoupler.force * TUNING.DECOUPLE_IMPULSE;
    if (dec.def.attach.outer) _a.set(dec._ox, 0, dec._oz);
    else _a.set(0, dropCom.y >= keepCom.y ? 1 : -1, 0);
    _a.applyQuaternion(this.q);
    if (debris.mass > 0) debris.vel.addScaledVector(_a, J / debris.mass);
    if (this.mass > 0 && !this.landed) this.vel.addScaledVector(_a, -J / this.mass);
    const k = 0.12 / Math.max(1, Math.sqrt(debris.inertia.x / 2000));
    debris.w.x += hash3(dec.id, this.stageIndex, 1) * k;
    debris.w.z += hash3(dec.id, this.stageIndex, 2) * k;
    events.push({ type: 'decouple', vessel: this, debris, part: dec });
  }
  _comOf(ids) {
    let m = 0; const c = new Vector3();
    for (const id of ids) { const p = this.parts.get(id); m += p.mass; c.addScaledVector(p.pos, p.mass); }
    return m > 0 ? c.multiplyScalar(1 / m) : c;
  }

  /** Move the given parts into a new vessel that inherits this vessel's motion. */
  _splitOff(ids) {
    const d = new Vessel();
    d.body = this.body;
    d.launched = true; d.launchUt = this.launchUt;
    d.sunlit = this.sunlit;
    let hasCmd = false;
    for (const id of ids) {
      const p = this.parts.get(id);
      this.parts.delete(id);
      d.parts.set(id, p);
      if (p.def.command && (p.def.command !== 'crew' || p.crew.length)) hasCmd = true;
    }
    d.type = hasCmd ? 'ship' : 'debris';
    d.name = this.name + (hasCmd ? ' probe' : ' debris');
    d.stages = this.stages.map(s => s.filter(id => d.parts.has(id)));
    for (const g in this.actionGroups) {
      const mine = this.actionGroups[g].filter(x => d.parts.has(x.part));
      if (mine.length) d.actionGroups[g] = mine.map(x => ({ ...x }));
    }
    d.stageIndex = Math.min(this.stageIndex, d.stages.length);
    d._filterStages();
    d.controlId = null;
    d._rebuild();
    d._updateMass(false);
    const oldCom = _e.copy(this.com);
    // world state of the debris CoM
    _b.copy(d.com).sub(oldCom);
    d.q.copy(this.q); d.w.copy(this.w);
    if (this.landed) this.syncLanded(this._lastUt || 0);
    d.pos.copy(_b).applyQuaternion(this.q).add(this.pos);
    d.vel.crossVectors(this.w, _b).applyQuaternion(this.q).add(this.vel);
    d.situation = this.landed ? 'flying' : this.situation;
    if (!hasCmd) d.ctrl.throttle = 0;
    d.updateResources();
    // what is left
    this._filterStages();
    this._rebuild();
    this._updateMass(true);
    return d;
  }
  _filterStages() {
    const out = [];
    let idx = 0;
    for (let i = 0; i < this.stages.length; i++) {
      const f = this.stages[i].filter(id => this.parts.has(id));
      if (i < this.stageIndex) { out.push(f); idx++; } else if (f.length) out.push(f);
    }
    this.stages = out; this.stageIndex = idx;
  }

  /** Destroy parts (explosions); the vessel may split or die. */
  destroyParts(ids, events, reason = 'crash') {
    let any = false;
    for (const id of ids) {
      const p = this.parts.get(id);
      if (!p) continue;
      any = true;
      p.destroyed = true;
      events.push({ type: 'explosion', pos: this.partWorldPos(p), body: this.body, size: Math.max(p.def.h, 2 * (p.def.r || p.def.rw || 0.3)), partName: p.def.name, vessel: this });
      for (const name of p.crew) events.push({ type: 'crewLost', name, vessel: this });
      p.crew = [];
      this.parts.delete(id);
    }
    if (!any) return;
    if (!this.parts.size) {
      this.dead = true; this._list = [];
      events.push({ type: 'destroyed', vessel: this, reason });
      return;
    }
    for (const p of this.parts.values()) p.links = p.links.filter(id => this.parts.has(id));
    const hadControl = this.parts.has(this.controlId);
    // connected pieces
    const pieces = [];
    const seen = new Set();
    for (const p of this.parts.values()) {
      if (seen.has(p.id)) continue;
      const comp = this._component(p.id, null);
      for (const id of comp) seen.add(id);
      pieces.push(comp);
    }
    let main = pieces.find(c => c.has(this.controlId));
    if (!main) main = pieces.find(c => [...c].some(id => this.parts.get(id).def.command));
    if (!main) {
      let best = -1;
      for (const c of pieces) { let m = 0; for (const id of c) m += this.parts.get(id).mass; if (m > best) { best = m; main = c; } }
    }
    this._list = [...this.parts.values()];
    for (const c of pieces) {
      if (c === main) continue;
      const debris = this._splitOff(c);
      events.push({ type: 'decouple', vessel: this, debris, part: null });
    }
    this._filterStages();
    this._rebuild();
    this._updateMass(true);
    if (!hadControl) {
      const cmd = this._commands[0];
      if (!cmd || (this.type !== 'debris' && !this._commands.some(c => c.def.command !== 'crew' || c.crew.length))) {
        if (this.type !== 'debris') { this.type = 'debris'; events.push({ type: 'destroyed', vessel: this, reason }); }
      }
    }
    this.estimateDeltaV();
  }

  /** Joints that gave way this step (structure.js): cut their links; whatever is no longer attached leaves. */
  _breakJoints(events) {
    const st = this.structure, broken = st.pending;
    st.pending = null;
    if (!broken || this.dead) return;
    const info = [];
    for (const j of broken) {
      const a = this.parts.get(j.a.id), b = this.parts.get(j.b.id);
      if (!a || !b || !a.links.includes(b.id)) continue;
      a.links = a.links.filter(x => x !== b.id);
      b.links = b.links.filter(x => x !== a.id);
      if (a.dockedTo === b.id) a.dockedTo = null;
      if (b.dockedTo === a.id) b.dockedTo = null;
      _a.set(j.px, j.py, j.pz).sub(this.com).applyQuaternion(this.q).add(this.pos);
      info.push({ a: a.id, b: b.id, kind: j.kind, mode: j.mode, util: j.util, aName: a.def.name, bName: b.def.name, pos: _a.clone() });
    }
    if (!info.length) return;
    const pieces = [], seen = new Set();
    for (const p of this.parts.values()) {
      if (seen.has(p.id)) continue;
      const comp = this._component(p.id, null);
      for (const id of comp) seen.add(id);
      pieces.push(comp);
    }
    let main = pieces.find(c => c.has(this.controlId));
    if (!main) main = pieces.find(c => [...c].some(id => this.parts.get(id).def.command)) || pieces[0];
    const left = [];
    for (const c of pieces) {
      if (c === main) continue;
      const debris = this._splitOff(c);
      left.push(debris);
      events.push({ type: 'decouple', vessel: this, debris, part: null });
    }
    if (!left.length) { this._rebuild(); this._updateMass(true); }      // still held some other way (a docked ring)
    for (const i of info) {
      const debris = left.find(d => d.parts.has(i.a) || d.parts.has(i.b)) || null;
      events.push({ type: 'structure', vessel: this, debris, joint: { a: i.a, b: i.b, kind: i.kind, aName: i.aName, bName: i.bName }, mode: i.mode, util: i.util, pos: i.pos, body: this.body });
    }
    this.estimateDeltaV();
  }

  // ------------------------------------------------------------------ toggles
  setLegs(down) {
    for (const p of this._legs) { p.deployed = !!down; }
    this._buildContacts();
    if (this.landed && this.surface && this.surface.fixed && this._legs.length) this._wake = true;
    return !!down;
  }
  /** Retractable landing gear (wheels with `wheel.retract`). Fixed wheels always stay down. */
  setGear(down) {
    let any = false;
    for (const p of this._wheels) if (p.def.wheel.retract) { p.deployed = !!down; any = true; }
    if (any) { this._buildContacts(); if (this.landed && this.surface && this.surface.fixed) this._wake = true; }
    return any ? !!down : true;
  }
  get gearDown() { let n = 0, d = 0; for (const p of this._wheels) if (p.def.wheel.retract) { n++; if (p.deployed) d++; } return n === 0 || d === n; }
  get hasGear() { return this._wheels.some(p => p.def.wheel.retract); }
  toggleGear() { return this.setGear(!this.gearDown); }
  setLights(on) { for (const p of this._lights) p.deployed = !!on; this.ctrl.lights = !!on; return !!on; }
  get lightsOn() { return this._lights.length > 0 && this._lights.every(p => p.deployed); }
  toggleLights() { return this.setLights(!this.lightsOn); }
  setAirbrakes(out) { for (const p of this._brakes) p.deployed = !!out; return !!out; }
  get airbrakesOut() { return this._brakes.length > 0 && this._brakes.every(p => p.deployed); }
  /** Wheel brakes and air brakes together (the B key). */
  setBrakes(on) { this.ctrl.brake = !!on; this.setAirbrakes(on); return !!on; }
  toggleBrakes() { return this.setBrakes(!this.ctrl.brake); }
  get legsDown() { return this._legs.length > 0 && this._legs.every(p => p.deployed); }
  toggleLegs() { return this.setLegs(!this.legsDown); }
  setSolar(out) { for (const p of this._solar) p.deployed = !!out; return !!out; }
  get solarOut() { return this._solar.length > 0 && this._solar.every(p => p.deployed); }
  toggleSolar() { return this.setSolar(!this.solarOut); }
  // ------------------------------------------------------------------ action groups
  /**
   * Do one part action (see partActions). `ev` collects events. → true if something happened.
   * 'runExperiment' and 'undock' need the World: they are reported as {type: 'action', …} events for it to carry out.
   */
  doAction(partId, action, ev = []) {
    const p = this.parts.get(partId);
    if (!p || this.dead) return false;
    const d = p.def;
    switch (action) {
      case 'toggleEngine': case 'toggle': case 'activateEngine': case 'shutdownEngine':
        if (action === 'toggle' && !d.engine) {
          const first = partActions(d)[0];
          return first && first.id !== 'toggleEngine' ? this.doAction(partId, first.id, ev) : false;
        }
        if (!d.engine) return false;
        if (d.engine.type === 'solid' && p.ignited) return false;                 // a lit booster stays lit
        p.ignited = action === 'activateEngine' ? true : action === 'shutdownEngine' ? false : !p.ignited;
        if (p.ignited && p.flameout && d.engine.type !== 'solid') p.flameout = false;
        this.estimateDeltaV();
        return true;
      case 'deployChute':
        if (!d.chute || p.deployed !== 'stowed') return false;
        p.deployed = 'armed'; ev.push({ type: 'chute', vessel: this, part: p, state: 'armed' });
        return true;
      case 'cutChute':
        if (!d.chute || p.deployed === 'stowed' || p.deployed === 'cut') return false;
        p.deployed = 'cut'; p.deployT = 0; ev.push({ type: 'chute', vessel: this, part: p, state: 'cut' });
        return true;
      case 'decouple':
        if (!d.decoupler) return false;
        this._decouple(p, ev); this.estimateDeltaV();
        return true;
      case 'toggleLegs':
        if (!d.legs) return false;
        p.deployed = !p.deployed; this._buildContacts();
        if (this.landed && this.surface && this.surface.fixed) this._wake = true;
        return true;
      case 'toggleGear':
        if (!d.wheel || !d.wheel.retract) return false;
        p.deployed = !p.deployed; this._buildContacts();
        if (this.landed && this.surface && this.surface.fixed) this._wake = true;
        return true;
      case 'toggleSolar': if (!d.solar || d.solar.fixed) return false; p.deployed = !p.deployed; return true;
      case 'toggleLight': if (!d.light) return false; p.deployed = !p.deployed; return true;
      case 'toggleAirbrake': if (!d.airbrake) return false; p.deployed = !p.deployed; return true;
      case 'runExperiment': if (!d.experiment) return false; ev.push({ type: 'action', vessel: this, part: p, action }); return true;
      case 'undock':
        if (!d.dock || p.dockedTo === null || p.dockedTo === undefined) return false;
        ev.push({ type: 'action', vessel: this, part: p, action });
        return true;
      default: return false;
    }
  }
  /**
   * Fire an action group: '1'..'9', 'gear', 'lights', 'brakes' or 'abort' (case-insensitive; numbers accepted).
   * A group with saved actions runs exactly those. The four named groups have a built-in meaning when nothing is
   * saved for them: gear = toggle legs and retractable wheels, lights = toggle all lamps, brakes = toggle wheel
   * brakes and air brakes, abort = throttle to zero and shut down every liquid engine.
   * → number of actions carried out. Pushes {type: 'actionGroup', vessel, group, count} to `ev`.
   */
  fireGroup(name, ev = []) {
    const g = String(name).toLowerCase();
    if (this.dead || !ACTION_GROUPS.includes(g)) return 0;
    const list = this.actionGroups[g];
    let n = 0;
    if (list && list.length) {
      for (const a of list.slice()) if (this.doAction(a.part, a.action, ev)) n++;
    } else if (g === 'gear') {
      if (this._legs.length) { this.toggleLegs(); n += this._legs.length; }
      if (this.hasGear) { this.toggleGear(); n++; }
    } else if (g === 'lights') {
      if (this._lights.length) { this.toggleLights(); n = this._lights.length; }
    } else if (g === 'brakes') {
      this.toggleBrakes(); n = 1;
    } else if (g === 'abort') {
      this.ctrl.throttle = 0; n = 1;
      for (const e of this._engines) if (e.part.ignited && e.part.def.engine.type !== 'solid') { e.part.ignited = false; n++; }
      this.estimateDeltaV();
    }
    ev.push({ type: 'actionGroup', vessel: this, group: g, count: n });
    return n;
  }
  /** Bind (or with action null, unbind) a part action to a group on this vessel in flight. */
  setGroupAction(group, partId, action) {
    const g = String(group).toLowerCase();
    if (!ACTION_GROUPS.includes(g) || !this.parts.has(partId)) return false;
    const list = (this.actionGroups[g] || []).filter(a => !(a.part === partId && (action === null || a.action === action)));
    if (action !== null) {
      if (!partActions(this.parts.get(partId).def).some(a => a.id === action)) return false;
      list.push({ part: partId, action });
    }
    if (list.length) this.actionGroups[g] = list; else delete this.actionGroups[g];
    return true;
  }

  /** Would the engines push right now (ignited, fed, and throttled up)? */
  wouldThrust() {
    for (const e of this._engines) {
      const p = e.part;
      if (!p.ignited || p.flameout) continue;
      if (p.def.engine.type === 'solid') { if (p.res.solid > 0) return true; continue; }
      if (p.def.engine.type === 'jet' && !(p._jf > 0) && p._jf !== undefined) continue;
      if (this.ctrl.throttle > 0) for (const t of e.tanks) if (t.res[e.prop] > 0) return true;
    }
    return false;
  }
  /** Vacuum thrust (N) and exhaust velocity (m/s) of the engines that can burn now at full throttle. */
  enginePower() {
    let F = 0, mdot = 0;
    for (const e of this._engines) {
      const p = e.part, en = p.def.engine;
      if (!p.ignited) continue;
      const fed = en.type === 'solid' ? p.res.solid > 0 : e.tanks.some(t => t.res[e.prop] > 0);
      if (!fed) continue;
      if (en.type === 'jet') {       // a jet only counts where it can breathe
        const jf = p._jf === undefined ? jetFactor(p.def, this.body, this.altitude || 0, this.mach || 0) : p._jf;
        if (!(jf > 0)) continue;
        F += en.thrust * 1000 * jf; mdot += en.thrust * 1000 * jf / (Math.max(en.ispAtm, en.ispVac) * G0);
        continue;
      }
      F += en.thrust * 1000; mdot += en.thrust * 1000 / (en.ispVac * G0);
    }
    return { thrust: F, ve: mdot > 0 ? F / mdot : 0, mdot };
  }
  /** Seconds of full-throttle burn for `dv` with the engines burning now (Infinity if none). */
  burnTime(dv) {
    const { thrust, ve } = this.enginePower();
    if (!(thrust > 0)) return Infinity;
    return this.mass * ve / thrust * (1 - Math.exp(-Math.abs(dv) / ve));
  }

  // ------------------------------------------------------------------ orbit helpers
  getOrbit(t) {
    if (this.onRails && this.orbit) return this.orbit;
    // Called without a time: the vessel's state is as of the last telemetry update, so that is the epoch. (An
    // undefined epoch used to be cached with the orbit and poisoned every later reading of it.) A vessel that has
    // never been stepped has no time of its own: it gets an orbit from epoch 0 that is not kept.
    if (!Number.isFinite(t)) {
      if (!Number.isFinite(this._ut)) return this.orbit && this._orbitStamp === this._stamp && this._orbitBody === this.body ? this.orbit : Orbit.fromState(this.pos, this.vel, this.body.gm, 0);
      t = this._ut;
    }
    if (this.landed) this.syncLanded(t);
    if (!this.orbit || this._orbitStamp !== this._stamp || this._orbitBody !== this.body) {
      this.orbit = Orbit.fromState(this.pos, this.vel, this.body.gm, t);
      this._orbitStamp = this._stamp; this._orbitBody = this.body;
    }
    return this.orbit;
  }
  /** Remaining burn vector (inertial, m/s) of the first maneuver node, or null. */
  burnVector(t, out = new Vector3()) {
    const node = this.nodes[0];
    if (!node) return null;
    if (node.rem) return out.set(node.rem.x, node.rem.y, node.rem.z);
    const o = this.getOrbit(t);
    let r, v;
    if (node.t > t) { const s = o.stateAt(node.t); r = s.r; v = s.v; } else { r = this.pos; v = this.vel; }
    const b = maneuverBasis(r, v);
    const dv = node.dv;
    return out.set(0, 0, 0).addScaledVector(b.prograde, dv.prograde || 0).addScaledVector(b.normal, dv.normal || 0).addScaledVector(b.radial, dv.radial || 0);
  }
  addNode(t, dv) {
    const node = { t, dv: { prograde: dv.prograde || 0, normal: dv.normal || 0, radial: dv.radial || 0 } };
    this.nodes.push(node);
    this.nodes.sort((a, b) => a.t - b.t);
    return node;
  }
  removeNode(node) { const i = this.nodes.indexOf(node); if (i >= 0) this.nodes.splice(i, 1); }

  /** Called once per world step: refresh the cached guidance direction used by SAS 'maneuver' / 'target'. */
  updateGuidance(t, targetDir) {
    const mode = this.ctrl.sasMode;
    this._guideDir = null;
    const node = this.nodes[0];
    if (node) {
      const bv = this.burnVector(t, _d);
      this.nodeDv = bv.length();
      if (mode === 'maneuver' && this.nodeDv > 1e-6) this._guideDir = (this._guideVec || (this._guideVec = new Vector3())).copy(bv).normalize();
    } else this.nodeDv = 0;
    if ((mode === 'target' || mode === 'antiTarget') && targetDir) this._guideDir = (this._guideVec || (this._guideVec = new Vector3())).copy(targetDir).normalize();
  }

  _sasDirection(mode, out) {
    const pos = this.pos, vel = this.vel;
    switch (mode) {
      case 'prograde': return vel.lengthSq() > 1e-6 ? out.copy(vel).normalize() : null;
      case 'retrograde': return vel.lengthSq() > 1e-6 ? out.copy(vel).normalize().negate() : null;
      case 'normal': return out.crossVectors(pos, vel).lengthSq() > 1e-6 ? out.normalize() : null;
      case 'antinormal': return out.crossVectors(pos, vel).lengthSq() > 1e-6 ? out.normalize().negate() : null;
      case 'radialOut': case 'radialIn': {
        _a.crossVectors(pos, vel);
        if (_a.lengthSq() < 1e-6) return null;
        out.crossVectors(vel, _a).normalize();
        return mode === 'radialIn' ? out.negate() : out;
      }
      case 'srfPrograde': case 'srfRetrograde': {
        const wy = TAU / this.body.rotPeriod;
        out.set(vel.x - wy * pos.z, vel.y, vel.z + wy * pos.x);
        if (out.lengthSq() < 0.01) return out.copy(pos).normalize();
        out.normalize();
        return mode === 'srfRetrograde' ? out.negate() : out;
      }
      case 'up': return out.copy(pos).normalize();
      case 'direction': return this.sasDir.lengthSq() > 1e-9 ? out.copy(this.sasDir).normalize() : null;
      case 'maneuver': return this._guideDir ? out.copy(this._guideDir) : null;
      case 'target': case 'antiTarget': {
        const ti = this.targetInfo;
        if (ti) return mode === 'target' ? out.copy(ti.dir) : out.copy(ti.dir).negate();
        if (!this._guideDir) return null;
        return mode === 'target' ? out.copy(this._guideDir) : out.copy(this._guideDir).negate();
      }
      case 'relPrograde': case 'relRetrograde': {   // velocity relative to the target
        const ti = this.targetInfo;
        if (!ti || !(ti.relSpeed > 0.02)) return null;
        out.copy(ti.relVel).normalize();
        return mode === 'relRetrograde' ? out.negate() : out;
      }
      default: return null;
    }
  }

  // ------------------------------------------------------------------ systems (engines, power, control check)
  // Returns the total thrust (N). Fills this._thr = {tx, tz, gim} (torque from off-axis thrust, gimbal authority).
  _systems(dt, pAtm, ev) {
    // --- command / power
    let ctl = false, drain = 0, probe = false;
    for (const p of this._commands) {
      const c = p.def.command;
      if (c === 'eva') ctl = true;
      else if (c === 'crew') { if (p.crew.length) ctl = true; }
      else { probe = true; drain += p.def.elecDrain || 0; }
    }
    if (probe) {
      const need = drain * dt;
      if (this._drain('elec', need) >= need * 0.999 && this._total('elec') > 0) ctl = true;
    }
    this.controllable = ctl;
    if (this._solar.length && this.sunlit) {
      let rate = 0;
      const sd = this.sunDir;
      for (const p of this._solar) {
        const so = p.def.solar;
        if (!p.deployed && !so.fixed) continue;
        let f = 1;
        if (sd && (so.fixed || so.tracking === false)) {      // a fixed panel only works facing the sun; tracking panels turn to it
          _a.set(p._ox, 0, p._oz).applyQuaternion(this.q);
          f = Math.max(0, _a.dot(sd));
        }
        rate += so.rate * f;
      }
      if (rate > 0) this._fill('elec', rate * this.sunScale * dt);
    }
    if (this._gens.length) {
      let rate = 0;
      for (const p of this._gens) {
        const g = p.def.generator || p.def.rtg;
        if (g.fuelUse > 0) {       // fuel cell: runs only while the batteries have room, and burns propellant
          const er = this.resources.elec;
          if (er && er.max > 0 && this._total('elec') >= er.max - 1e-6) continue;
          const need = g.fuelUse * dt;
          if (this._drain('fuel', need) < need * 0.999) continue;
          this._massDirty = true;
        }
        rate += g.rate || 0;
      }
      if (rate > 0) this._fill('elec', rate * dt);
    }
    if (this._lights.length) {
      let n = 0;
      for (const p of this._lights) if (p.deployed) n++;
      if (n) {
        const need = n * TUNING.LIGHT_EC * dt;
        if (this._drain('elec', need) < need * 0.5) for (const p of this._lights) p.deployed = false;
      }
    }
    if (this._labs.length && this.science.length) this.processLabs(dt, ev);
    // --- engines
    const throttle = clamp(this.ctrl.throttle || 0, 0, 1);
    let F = 0, Fabs = 0, tx = 0, ty = 0, tz = 0, gim = 0, maxF = 0, mdotSum = 0, burned = false, Flx = 0, Flz = 0;
    const com = this.com;
    for (const e of this._engines) {
      const p = e.part;
      p.thrust = 0; p.level = 0;
      if (!p.ignited) continue;
      const d = p.def, en = d.engine, prop = e.prop;
      let full = engineThrust(d, pAtm);
      let mdot = en.thrust * 1000 / (en.ispVac * G0);
      let level = 0;
      if (en.type === 'solid') {
        if (p.flameout) continue;
        const need = mdot * dt, have = p.res.solid;
        if (have <= need) {
          level = have / need; p.res.solid = 0; p.flameout = true;
          ev.push({ type: 'flameout', vessel: this, part: p });
        } else { p.res.solid = have - need; level = 1; maxF += full; }
        burned = true;
      } else {
        if (en.type === 'jet') {
          const jf = jetFactor(d, this.body, this._envAlt || 0, this._envMach || 0);
          p._jf = jf;
          full = en.thrust * 1000 * jf;
          mdot = full / (engineIsp(d, pAtm) * G0);
          if (!(jf > 0)) {
            if (throttle > 0 && !p.flameout) { p.flameout = true; ev.push({ type: 'flameout', vessel: this, part: p, reason: 'air' }); }
            continue;
          }
        }
        let avail = 0;
        for (const t of e.tanks) avail += t.res[prop];
        if (avail <= 0) {
          if (throttle > 0 && !p.flameout) { p.flameout = true; ev.push({ type: 'flameout', vessel: this, part: p }); }
          continue;
        }
        p.flameout = false;
        maxF += full;
        if (throttle <= 0) continue;
        let power = 1;
        if (en.elecUse > 0) {       // electric engines throttle back when the batteries cannot keep up
          const needE = en.elecUse * throttle * dt;
          power = needE > 0 ? this._drain('elec', needE) / needE : 1;
          if (power < 0.999 && !(this._total('elec') > 0) && !p._starved) { p._starved = true; ev.push({ type: 'flameout', vessel: this, part: p, reason: 'power' }); }
          if (power >= 0.999) p._starved = false;
          if (!(power > 0)) continue;
        }
        const need = mdot * throttle * power * dt;
        let got;
        if (avail <= need) {
          got = avail;
          for (const t of e.tanks) t.res[prop] = 0;
          p.flameout = true; ev.push({ type: 'flameout', vessel: this, part: p });
        } else {
          got = need;
          let rem = need, n = 0;
          for (const t of e.tanks) if (t.res[prop] > 0) n++;
          for (let pass = 0; pass < 4 && rem > 1e-12 && n > 0; pass++) {
            const share = rem / n;
            n = 0;
            for (const t of e.tanks) {
              const f = t.res[prop];
              if (f <= 0) continue;
              if (f <= share) { rem -= f; t.res[prop] = 0; } else { rem -= share; t.res[prop] = f - share; n++; }
            }
          }
        }
        level = need > 0 ? throttle * power * got / need : 0;
        burned = true;
      }
      const T = full * level;
      p.thrust = T; p.level = level;
      mdotSum += mdot * level; Fabs += T;
      const Ts = p.flip ? -T : T;      // a flipped engine (docked nose to nose) pushes the other way
      if (p._tilt) {   // a tilted engine pushes along its own axis
        const ax = T * p._ax, ay = T * p._ay, az = T * p._az, rx = p.pos.x - com.x, ry = p.pos.y - com.y, rz = p.pos.z - com.z;
        F += ay; Flx += ax; Flz += az;
        tx += ry * az - rz * ay; ty += rz * ax - rx * az; tz += rx * ay - ry * ax;
      } else {
        F += Ts;
        tx -= (p.pos.z - com.z) * Ts; tz += (p.pos.x - com.x) * Ts;
      }
      if (en.gimbal) gim += T * Math.sin(en.gimbal * Math.PI / 180) * Math.abs(p.pos.y - com.y);
    }
    if (burned) this._massDirty = true;
    this.thrust = Math.abs(F); this.maxThrust = maxF;
    this.isp = mdotSum > 0 ? Fabs / (mdotSum * G0) : 0;
    this._mdot = mdotSum;       // kg/s leaving through the engines during this step (see _stepFlight)
    this._thrTx = tx; this._thrTy = ty; this._thrTz = tz; this._gim = gim; this._thrFx = Flx; this._thrFz = Flz;
    return F;
  }

  /**
   * Science lab modules work through the stored experiment records: each record gains `lab` (0…1 progress) and,
   * once done, `bonus` (extra fraction of its science value, paid when the record is recovered or transmitted).
   * Needs a crew in the lab and electric charge. Called by simulate() and by the World for vessels on rails.
   */
  processLabs(dt, ev = null, free = false) {
    let rate = 0, mult = 1;
    for (const p of this._labs) {
      const lab = p.def.lab || {};
      if ((p.def.crew || 0) > 0 && !p.crew.length && lab.crew !== 0) continue;
      rate += lab.rate || 1; mult = Math.max(mult, lab.mult || 1);
    }
    if (!(rate > 0)) return 0;
    let rec = null;
    for (const r of this.science) if (!(r.lab >= 1)) { rec = r; break; }
    if (!rec) return 0;
    // `free`: on rails the power budget is not simulated; a vessel that can make power keeps its lab running
    if (free) { if (!(this._solar.length || this._gens.length || this._total('elec') > 0)) return 0; }
    else { const need = TUNING.LAB_EC * dt; if (this._drain('elec', need) < need * 0.999) return 0; }
    rec.lab = Math.min(1, (rec.lab || 0) + TUNING.LAB_RATE * rate * dt);
    if (rec.lab >= 1) {
      rec.bonus = TUNING.LAB_BONUS * mult;
      if (ev) ev.push({ type: 'labDone', vessel: this, record: rec });
    }
    return 1;
  }

  // Torque command (cx, cy, cz in [−1,1]) and authority (ax, ay, az in N·m). Writes this.actuation and this._auth.
  _control(dt, qdyn, axial) {
    const c = this.ctrl, I = this.inertia;
    let ax = 0, ay = 0, az = 0;
    const eva = this.type === 'eva';
    const elec = eva ? 1 : this._total('elec');
    if (this._wheel > 0 && elec > 0) { ax = ay = az = this._wheel; }
    this._auW = ax;             // what makes the control torque (structure.js shares it out to those parts)
    ax += this._gim; az += this._gim;
    // a rover standing on its driven wheels steers with them: reaction wheels and thrusters leave pitch and yaw alone
    const rover = this._onWheels && this._driven > 0;
    if (rover) { ax = 0; az = 0; }
    let fx = 0, fy = 0, fz = 0;        // aerodynamic control authority: delivered by the surfaces themselves
    if (qdyn > 1 && this._wings.length) {
      const k = qdyn * axial * axial;
      fx = this._ctlAuth.x * k; fy = this._ctlAuth.y * k; fz = this._ctlAuth.z * k;
      ax += fx; ay += fy; az += fz;
    }
    const rcsOn = c.rcs && this._rcsThrust > 0 && this._total('mono') > 0;
    this._auR = rcsOn;
    if (rcsOn) { ax += rover ? 0 : this._rcsAuth.x; ay += this._rcsAuth.y; az += rover ? 0 : this._rcsAuth.z; }
    // fly-by-wire limiter: never command more than MAX_ANG_ACC, however light the vessel is
    const lim = TUNING.MAX_ANG_ACC;
    let dx = ax - fx, dy = ay - fy, dz = az - fz;      // torque applied directly (wheels, gimbal, RCS)
    if (dx > I.x * lim) dx = I.x * lim;
    if (dy > I.y * lim) dy = I.y * lim;
    if (dz > I.z * lim) dz = I.z * lim;
    if (ax > I.x * lim) ax = I.x * lim;
    if (ay > I.y * lim) ay = I.y * lim;
    if (az > I.z * lim) az = I.z * lim;
    // angular acceleration (rad/s²) a full command would give on each axis right now (guidance scales its gains by it)
    this.ctrlAccel.set((dx + fx) / I.x, (dy + fy) / I.y, (dz + fz) / I.z);
    let cx = 0, cy = 0, cz = 0;
    if (this.controllable) {
      const mx = clamp(c.pitch || 0, -1, 1), my = clamp(c.roll || 0, -1, 1), mz = -clamp(c.yaw || 0, -1, 1);
      const manual = Math.abs(mx) > 0.01 || Math.abs(my) > 0.01 || Math.abs(mz) > 0.01;
      cx = mx; cy = my; cz = mz;
      // Standing on its feet (or its hull) with the engines shut down, the attitude hold lets go. Reaction wheels
      // strong enough to turn a lander in space hold it up on one foot where gravity is weak: it then stood, and
      // was pinned, with three feet 10 to 30 cm in the air (Dray, Nym, Wend). The pilot's own stick still works.
      const standing = this.grounded && this._groundT > TUNING.GROUND_SIT_TIME && !this._onWheels && !(this._wheelSpan > 0) && !this._floating && !(c.throttle > 0) && !eva
        && (this._legsOn > 0 || this._stance > TUNING.STANCE_MIN);      // balanced on an engine bell it keeps its hold
      if (standing) { if (this._groundT > 2) this.sasTarget = null; }      // (a bounce is flown with the hold it came down with)
      else if (c.sas) {
        const w = this.w;
        const T = Math.max(TUNING.SAS_T, 2.5 * dt);
        const alx = ax / I.x, aly = ay / I.y, alz = az / I.z;
        let ex = 0, ey = 0, ez = 0, track = true;
        const dir = this._sasDirection(c.sasMode, _dir);
        if (dir) {
          _qi.copy(this.q).invert();
          dir.applyQuaternion(_qi);
          const s = Math.hypot(dir.x, dir.z), ang = Math.atan2(s, dir.y);
          if (s > 1e-9) { ex = dir.z / s * ang; ez = -dir.x / s * ang; } else if (dir.y < 0) ex = Math.PI;
          this.sasTarget = null;
        } else {
          if (manual) { this._sasCoast = true; this.sasTarget = null; }
          if (this._sasCoast && !manual && w.lengthSq() < 0.0009) this._sasCoast = false;
          if (this._sasCoast) track = false;
          else {
            if (!this.sasTarget) this.sasTarget = this.q.clone();
            _qi.copy(this.q).invert().multiply(this.sasTarget);
            if (_qi.w < 0) { _qi.x = -_qi.x; _qi.y = -_qi.y; _qi.z = -_qi.z; _qi.w = -_qi.w; }
            const s = Math.hypot(_qi.x, _qi.y, _qi.z);
            if (s > 1e-12) { const ang = 2 * Math.atan2(s, _qi.w) / s; ex = _qi.x * ang; ey = _qi.y * ang; ez = _qi.z * ang; }
          }
        }
        if (!track) { ex = ey = ez = 0; }
        if (Math.abs(mx) <= 0.01) cx = sasAxis(ex, w.x, alx, T);
        if (Math.abs(my) <= 0.01) cy = sasAxis(ey, w.y, aly, T);
        if (Math.abs(mz) <= 0.01) cz = sasAxis(ez, w.z, alz, T);
      } else this.sasTarget = null;
    }
    // consumables
    const use = (Math.abs(cx) + Math.abs(cy) + Math.abs(cz)) / 3;
    if (use > 0) {
      if (!eva && this._wheel > 0 && elec > 0) this._drain('elec', TUNING.WHEEL_EC * this._wheel / 1000 * use * dt);
      if (rcsOn) { this._drain('mono', this._rcsThrust * use * 0.5 / (this._rcsIsp * G0) * dt); this._massDirty = true; }
    }
    this.actuation.set(cx, cy, cz);
    this._tqx = cx * dx; this._tqy = cy * dy; this._tqz = cz * dz;
    // control surfaces follow the same command
    for (const p of this._wings) {
      if (!p._wCtl) continue;
      const d = p._kp * cx + p._kr * cy + p._ky * cz;
      p._defl = d > 1 ? 1 : d < -1 ? -1 : d;
    }
  }

  // ------------------------------------------------------------------ one physics sub-step
  /** Advance by dt. `ev` collects events. Works for flying and landed vessels (not for rails). */
  simulate(dt, ut, ev) {
    this._lastUt = ut;
    if (this.dead || !this._list.length) return;
    if (this.landed) this._stepLanded(dt, ut, ev);
    else if (this._nearGround && dt > TUNING.CONTACT_DT * 1.01 && this.type !== 'eva') {
      // stiff ground contact: take smaller steps while touching (or about to touch) the surface
      const n = Math.ceil(dt / TUNING.CONTACT_DT - 1e-9), h = dt / n;
      for (let i = 0; i < n && !this.dead && !this.landed; i++) {
        this._stepFlight(h, ut - dt + (i + 1) * h, ev);
        if (this._massDirty && !this.dead) this._updateMass(true);
        if (this.structure && this.structure.pending) break;
      }
    } else this._stepFlight(dt, ut, ev);
    if (this._massDirty && !this.dead) this._updateMass(true);
    const st = this.structure;
    if (st) { if (st.pending && !this.dead) this._breakJoints(ev); else if (this.landed) st.rest(dt); }
  }

  _stepFlight(dt, ut, ev) {
    const body = this.body, pos = this.pos, vel = this.vel, q = this.q, w = this.w;
    const R = pos.length();
    const alt = R - body.radius;
    const rho = body.density(alt), pAtm = body.pressureAtm(alt);
    const wy = TAU / body.rotPeriod;
    const sx = vel.x - wy * pos.z, sy = vel.y, sz = vel.z + wy * pos.x;
    const speed2 = sx * sx + sy * sy + sz * sz, speed = Math.sqrt(speed2);
    const qdyn = 0.5 * rho * speed2;
    _qi.copy(q).invert();
    _ul.set(sx, sy, sz).applyQuaternion(_qi);
    const ux = _ul.x, uy = _ul.y, uz = _ul.z;

    this._envAlt = alt; this._envMach = speed / TUNING.SOUND_SPEED;
    const thrust = this._systems(dt, pAtm, ev);
    this._control(dt, qdyn, speed > 1 ? uy / speed : 0);
    const m = this.mass, com = this.com, c = this.ctrl;

    let Fx = this._thrFx || 0, Fy = thrust, Fz = this._thrFz || 0;
    let Tx = this._thrTx + this._tqx, Ty = (this._thrTy || 0) + this._tqy, Tz = this._thrTz + this._tqz;

    // --- translation thrusters (RCS / EVA jetpack)
    if (this.controllable && (c.tx || c.ty || c.tz)) {
      const tx = clamp(c.tx, -1, 1), ty = clamp(c.ty, -1, 1), tz = clamp(c.tz, -1, 1);
      const use = Math.abs(tx) + Math.abs(ty) + Math.abs(tz);
      if (this.type === 'eva') {
        const need = TUNING.EVA_THRUST * use / TUNING.EVA_VE * dt;
        if (need > 0 && this._drain('evafuel', need) >= need * 0.999) {
          Fx += tx * TUNING.EVA_THRUST; Fy += ty * TUNING.EVA_THRUST; Fz += tz * TUNING.EVA_THRUST;
          this._massDirty = true;
        }
      } else if (c.rcs && this._rcsThrust > 0) {
        const need = this._rcsThrust * use / (this._rcsIsp * G0) * dt;
        if (need > 0 && this._drain('mono', need) >= need * 0.999) {
          Fx += tx * this._rcsThrust; Fy += ty * this._rcsThrust; Fz += tz * this._rcsThrust;
          this._massDirty = true;
        }
      }
    }
    const thrFx = Fx, thrFy = Fy, thrFz = Fz;
    // structural loads: every force below is also booked to the part it acts on (wrench about the centre of mass)
    const st = this.structure, SW = st ? st.wrench : null;
    if (st) st.begin();

    // --- parachute state machine
    if (this._chutes.length) this._updateChutes(dt, rho, pAtm, speed, alt - this._baseH, ev);

    // --- aerodynamics and heating
    let Ax = 0, Ay = 0, Az = 0, ATx = 0, ATy = 0, ATz = 0;
    const flux = rho > 0 ? TUNING.HEAT_FLUX_K * Math.sqrt(rho) * speed2 * speed : 0;
    this.heatFlux = flux;
    const heating = flux > TUNING.HEAT_MIN_FLUX;
    let overheated = null, maxRatio = 0;
    if (rho > 1e-10 && speed2 > 0.01) {
      const list = this._list, n = list.length;
      const cxm = com.x, cym = com.y, czm = com.z;
      const uAx = uy / speed;
      const BASE = TUNING.BASE_DRAG;
      const mach = speed / TUNING.SOUND_SPEED;
      const mf = mach <= 0.7 ? 1 : mach < 1.1 ? 1 + (mach - 0.7) * 2.5 * (TUNING.MACH_PEAK - 1)
        : mach < 2.5 ? TUNING.MACH_PEAK + (mach - 1.1) / 1.4 * (TUNING.MACH_HIGH - TUNING.MACH_PEAK) : TUNING.MACH_HIGH;
      const lat0 = Math.sqrt(Math.max(0, 1 - uAx * uAx));
      for (let i = 0; i < n; i++) {
        const p = list[i], d = p.def;
        const rx = p.pos.x - cxm, ry = p.pos.y - cym, rz = p.pos.z - czm;
        const vx = ux + (w.y * rz - w.z * ry), vy = uy + (w.z * rx - w.x * rz), vz = uz + (w.x * ry - w.y * rx);
        const v2 = vx * vx + vy * vy + vz * vz;
        if (v2 < 1e-6) continue;
        const Ax0 = Ax, Ay0 = Ay, Az0 = Az, ATx0 = ATx, ATy0 = ATy, ATz0 = ATz;
        const sp = Math.sqrt(v2), qd = 0.5 * rho * v2, qdm = qd * mf;
        let fx = 0, fy = 0, fz = 0;
        if (p._stack) {
          const ca = vy / sp;
          if (ca > 0) fy = -qdm * (p._aUp + BASE * p._aDown) * ca; else fy = -qdm * (p._aDown + BASE * p._aUp) * ca;
          ATx -= rz * fy; ATz += rx * fy;
          // a blunt leading face rights itself (its centre of pressure moves to the windward edge) and damps pitching
          const rr = d.rTop > d.rBottom ? d.rTop : d.rBottom;
          const kR = TUNING.FACE_CP * qdm * (ca > 0 ? p._sUp : -p._sDown) * Math.abs(ca) * rr / sp;
          const kD = TUNING.FACE_DAMP * qdm * (p._aUp + p._aDown) * rr * rr / sp;
          ATx += kR * vz - kD * w.x; ATz -= kR * vx + kD * w.z;
          const k = qdm * p._aSide / sp;
          fx = -k * vx; fz = -k * vz;
          ATx += ry * fz; ATy += rz * fx - rx * fz; ATz -= ry * fx;
          Ax += fx; Ay += fy; Az += fz;
        } else if (p._wArea > 0) {
          // lifting surface: chord along the stack axis, span along the mount direction, normal n tangential
          const nx = p._oz, nz = -p._ox;
          const vn = vx * nx + vz * nz, vpl2 = vy * vy + vn * vn;
          if (p._tilt) {
            // tilted surface: same model in the part's own frame (chord = its +Y axis, normal and span as built)
            const vc = vx * p._ax + vy * p._ay + vz * p._az, vnt = vx * p._nx + vy * p._ny + vz * p._nz, v2 = vc * vc + vnt * vnt;
            if (v2 > 1e-8) {
              const vp = Math.sqrt(v2);
              let alpha = Math.atan2(-vnt, vc);
              if (p._defl) alpha += p._wTau * TUNING.CTRL_DEFLECT * p._defl;
              wingCoefficients(alpha, p._wSlope, p._wStall, _cf);
              const qS = 0.5 * rho * v2 * p._wArea;
              const L = qS * _cf[0], D = qS * _cf[1] * mf;
              const fn = (L * vc - D * vnt) / vp, fc = (-L * vnt - D * vc) / vp;
              const vs = vx * p._sx + vy * p._sy + vz * p._sz, ks = qd * p._wArea * 0.01 / sp * vs;
              fx = fn * p._nx + fc * p._ax - ks * p._sx; fy = fn * p._ny + fc * p._ay - ks * p._sy; fz = fn * p._nz + fc * p._az - ks * p._sz;
              p._aoa = alpha; p._lift = L;
              Ax += fx; Ay += fy; Az += fz;
              ATx += ry * fz - rz * fy; ATy += rz * fx - rx * fz; ATz += rx * fy - ry * fx;
            }
          } else if (vpl2 > 1e-8) {
            const vpl = Math.sqrt(vpl2);
            let alpha = Math.atan2(-vn, vy);
            if (p._defl) alpha += p._wTau * TUNING.CTRL_DEFLECT * p._defl;
            wingCoefficients(alpha, p._wSlope, p._wStall, _cf);
            const qS = 0.5 * rho * vpl2 * p._wArea;
            const L = qS * _cf[0], D = qS * _cf[1] * mf;
            const fn = (L * vy - D * vn) / vpl;
            fy = (-L * vn - D * vy) / vpl;
            const vs = vx * p._ox + vz * p._oz, ks = qd * p._wArea * 0.01 / sp * vs;   // a little skin friction along the span
            fx = fn * nx - ks * p._ox; fz = fn * nz - ks * p._oz;
            p._aoa = alpha; p._lift = L;
            Ax += fx; Ay += fy; Az += fz;
            ATx += ry * fz - rz * fy; ATy += rz * fx - rx * fz; ATz += rx * fy - ry * fx;
          }
        } else {
          let aR = p._aRad;
          if (d.wheel && !p.deployed) aR = 0;
          else if (d.airbrake && p.deployed) aR += d.airbrake.area;
          const k = qdm * aR / sp;
          fx = -k * vx; fy = -k * vy; fz = -k * vz;
          Ax += fx; Ay += fy; Az += fz;
          ATx += ry * fz - rz * fy; ATy += rz * fx - rx * fz; ATz += rx * fy - ry * fx;
        }
        if (d.chute && (p.deployed === 'semi' || p.deployed === 'full')) {
          const area = p.deployed === 'semi' ? d.chute.semiArea * p.deployT : d.chute.semiArea + (d.chute.area - d.chute.semiArea) * p.deployT;
          const k = qd * area * TUNING.CHUTE_CD / sp;
          fx = -k * vx; fy = -k * vy; fz = -k * vz;
          const py = ry + d.h / 2;
          Ax += fx; Ay += fy; Az += fz;
          ATx += py * fz - rz * fy; ATy += rz * fx - rx * fz; ATz += rx * fy - py * fx;
        }
        if (SW) { const k = i * 6; SW[k] = Ax - Ax0; SW[k + 1] = Ay - Ay0; SW[k + 2] = Az - Az0; SW[k + 3] = ATx - ATx0; SW[k + 4] = ATy - ATy0; SW[k + 5] = ATz - ATz0; }
        if (heating) {
          let ex;
          if (p._stack) {
            ex = TUNING.SIDE_EXPOSURE * lat0;
            const f = uAx > 0 ? p._eUp * uAx : -p._eDown * uAx;
            if (f > ex) ex = f;
          } else ex = TUNING.RADIAL_EXPOSURE;
          let rise = TUNING.HEAT_K * Math.pow(flux * ex, TUNING.HEAT_EXP);
          if (d.heatshield && p.res.ablator > 0) {
            p.res.ablator = Math.max(0, p.res.ablator - TUNING.ABLATE_RATE * flux * ex * dt);
            rise *= TUNING.SHIELD_FACTOR;
            this._massDirty = true;
          }
          const target = TUNING.AMBIENT_T + rise;
          p.temp += (target - p.temp) * Math.min(1, dt / (target > p.temp ? TUNING.HEAT_TAU : TUNING.COOL_TAU));
          const ratio = p.temp / d.maxTemp;
          if (ratio > maxRatio) maxRatio = ratio;
          if (ratio > 1) (overheated || (overheated = [])).push(p.id);
        }
      }
      // keep explicit drag stable for flimsy debris: never remove more than half the speed in one step
      const fm = Math.sqrt(Ax * Ax + Ay * Ay + Az * Az);
      if (fm * dt > 0.5 * m * speed) { const s = 0.5 * m * speed / (fm * dt); Ax *= s; Ay *= s; Az *= s; ATx *= s; ATy *= s; ATz *= s; if (SW) for (let k = 0; k < SW.length; k++) SW[k] *= s; }
      Fx += Ax; Fy += Ay; Fz += Az; Tx += ATx; Ty += ATy; Tz += ATz;
    }
    if (heating) { this._hot = true; this.maxTempRatio = maxRatio; }
    else if (this._hot) {
      let any = false;
      const k = Math.min(1, dt / TUNING.COOL_TAU);
      maxRatio = 0;
      for (const p of this._list) {
        p.temp += (TUNING.AMBIENT_T - p.temp) * k;
        if (p.temp > TUNING.AMBIENT_T + 2) any = true;
        maxRatio = Math.max(maxRatio, p.temp / p.def.maxTemp);
      }
      this._hot = any; this.maxTempRatio = maxRatio;
    }

    // --- ground and water contact (penalty springs, friction, wheels, buoyancy)
    let near = false;
    if (this.type !== 'eva' && alt < this._bound + 2 + (typeof body.terrainHeight === 'function' ? Math.max(body.maxElevation || 0, 0) + 50 : 0) && !(ut < this._gndSkip && ut > this._gndSkip - 30)) {
      // `ut` is the time at the END of this step; `pos` is still where the vessel is at its START. The ground turns
      // with the body (200 m/s at Verda's equator), so it has to be looked up at the start time: with `ut` the terrain
      // was sampled 2 m east of the vessel, which on a 9° slope is 30 cm of height (round 3: craft at rest stood
      // inside the hillside or above it by that much).
      const g = this._groundInfo(ut - dt);
      const clear = alt - (g.water ? g.sea : g.h) - this._bound - 2;
      this._gndSkip = clear > 200 ? ut + clear / (speed + 50) / 4 : 0;
      if (clear < 0) {
        near = true;
        if (this._contact(dt, ut, ev, g, alt, ux, uy, uz, speed)) return;      // parts were destroyed: start the step over next time
        Fx += this._cfx; Fy += this._cfy; Fz += this._cfz; Tx += this._ctx; Ty += this._cty; Tz += this._ctz;
      }
    }
    this._nearGround = near;
    if (!near && this._legLoad) { this._legLoad = false; for (const p of this._legs) { p._comp = 0; p._pen = 0; p._load = 0; p._x = 0; } }
    if (!near && (this.grounded || this._groundT > 0)) { this.grounded = false; this.groundContacts = 0; this.wheelsOnGround = 0; this._onWheels = false; this._groundT = 0; this._sleepT = 0; }
    if (!this.grounded) {
      this._airT += dt;
      if (this._airT > 1) this._touched = false;
      if (!this.launched && this._airT > 0.25) { this.launched = true; this.launchUt = ut; ev.push({ type: 'liftoff', vessel: this }); }
    } else if (!this.launched && this._onWheels && this.groundSpeed > 2) {
      // a vehicle that drives off has started its mission too (a rover never leaves the ground): 'rollout', not 'liftoff'
      this._rollT = (this._rollT || 0) + dt;
      if (this._rollT > 6) { this.launched = true; this.launchUt = ut; ev.push({ type: 'rollout', vessel: this }); }
    }

    // --- structure: what every joint carries for the vessel to move as these forces make it move
    if (st) {
      st.addLumped(thrFx - (this._thrFx || 0), thrFy - thrust, thrFz - (this._thrFz || 0));
      const u = st.solve(dt, Fx, Fy, Fz, Tx, Ty, Tz, m, this.inertia, w, TUNING.STRUCT_FAIL);
      if (u > STRUCT.WARN) { if (!st.warned) { st.warned = true; ev.push({ type: 'stress', vessel: this, util: u }); } }
      else if (u < STRUCT.WARN_RESET) st.warned = false;
    }

    // --- integrate translation: kick-drift-kick with gravity re-evaluated
    // The propellant of this step has already left the tanks but `m` is still the mass at its start. Dividing the
    // forces by the mass at mid-step makes a burn second order in dt: it then delivers the rocket equation's
    // delta-v (with the start mass every burn came up short by dt/2 * ve * mdot * (1/m1 - 1/m0), ~0.01 to 0.1 %).
    const mMid = m - 0.5 * (this._mdot || 0) * dt;
    const im = 1 / (mMid > 0.5 * m ? mMid : m);
    _a.set(Fx * im, Fy * im, Fz * im);
    this.gForce = _a.length() / G0;
    _a.applyQuaternion(q);
    const gm = body.gm;
    let k = -gm / (R * R * R) * 0.5 * dt;
    vel.x += pos.x * k + _a.x * 0.5 * dt; vel.y += pos.y * k + _a.y * 0.5 * dt; vel.z += pos.z * k + _a.z * 0.5 * dt;
    pos.x += vel.x * dt; pos.y += vel.y * dt; pos.z += vel.z * dt;
    const R2 = pos.length();
    k = -gm / (R2 * R2 * R2) * 0.5 * dt;
    vel.x += pos.x * k + _a.x * 0.5 * dt; vel.y += pos.y * k + _a.y * 0.5 * dt; vel.z += pos.z * k + _a.z * 0.5 * dt;

    // maneuver-node bookkeeping: subtract the dv the engines delivered
    if ((thrFx || thrFy || thrFz) && this.nodes.length) {
      const node = this.nodes[0];
      if (!node.rem && Math.abs(node.t - ut) < Math.max(90, 1.5 * this.burnTime(this.nodeDv || 1))) {
        const bv = this.burnVector(ut, _d);
        node.rem = { x: bv.x, y: bv.y, z: bv.z };
      }
      if (node.rem) {
        _b.set(thrFx * im * dt, thrFy * im * dt, thrFz * im * dt).applyQuaternion(q);
        node.rem.x -= _b.x; node.rem.y -= _b.y; node.rem.z -= _b.z;
      }
    }

    // --- rotation (Euler's equations, diagonal inertia)
    const I = this.inertia;
    const wx0 = w.x, wy0 = w.y, wz0 = w.z;
    w.x += (Tx - (I.z - I.y) * wy0 * wz0) / I.x * dt;
    w.y += (Ty - (I.x - I.z) * wz0 * wx0) / I.y * dt;
    w.z += (Tz - (I.y - I.x) * wx0 * wy0) / I.z * dt;
    const wl2 = w.lengthSq();
    if (wl2 > TUNING.MAX_SPIN * TUNING.MAX_SPIN) w.multiplyScalar(TUNING.MAX_SPIN / Math.sqrt(wl2));
    if (wl2 > 1e-18) {
      const wl = w.length(), ha = 0.5 * wl * dt, s = Math.sin(ha) / wl;
      _qa.set(w.x * s, w.y * s, w.z * s, Math.cos(ha));
      q.multiply(_qa).normalize();
    }
    this._stamp++;

    if (!(pos.x === pos.x && vel.x === vel.x && q.w === q.w)) {   // NaN guard
      this.dead = true;
      ev.push({ type: 'destroyed', vessel: this, reason: 'error' });
      return;
    }
    if (overheated) {
      this.destroyParts(overheated, ev, 'overheat');
      if (this.dead) return;
    }
    // --- ground contact
    if (this.type === 'eva') { if (R2 - body.radius - terrainAtPos(body, pos, ut) < this._bound) this._groundContact(ut, ev); return; }
    // --- coming to rest: a vessel that sits quietly on the ground (or floats quietly) is pinned to the surface
    if (this.grounded) {
      const sp2 = Math.hypot(vel.x - wy * pos.z, vel.y, vel.z + wy * pos.x);
      // Where gravity is weak everything is slow: a lander rocking from one pair of feet to the other on a small moon
      // never moves faster than "quiet" at home. Without the scale it was pinned in the middle of a rock, with feet
      // 10 to 30 cm in the air (Pell, Slate, Dray, Nym, Wend). Speeds on a rock go with the square root of gravity.
      // (All of this is for a craft on its legs. One standing on its hull, an engine bell say, is pinned as it always was:
      // the bell is one point here, and a tall stack balanced on a point would fall over while it waited.)
      const onLegs = this._legsOn > 0;
      const gs = this._onWheels || this._floating || !onLegs ? 1 : clamp(Math.sqrt(gm / (R2 * R2) / TUNING.SLEEP_G_REF), 0.04, 1);
      const calm = this._onWheels ? 0.06 : (this._floating ? 0.12 : TUNING.SLEEP_SPEED * gs);
      if (sp2 < calm && w.length() < TUNING.SLEEP_SPIN * (this._floating ? 0.4 : 1) * gs && !this._slipping && this._supported && !this._legMoving && !this._wantsAwake(thrust, null)) {
        this._sleepT += dt;
        // Balanced on a line (see `_stance`) it is not at rest, only slow: it is not pinned there. A craft set down
        // dead level stands on such a line exactly, and nothing in a computer disturbs it; nature would. Once a
        // second it gets the smallest of pushes about that line, and falls onto its other feet as a real one does.
        // (After STANCE_WAIT of this it is pinned anyway: something round that can find no footprint.)
        const edge = onLegs && !this._onWheels && !(this._wheelSpan > 0) && !this._floating && !(this._stance > TUNING.STANCE_MIN);
        if (edge) {
          this._edgeT = (this._edgeT || 0) + dt;
          if (this._edgeT > (this._nudgeT || 0) && this._rockAxis) { this._nudgeT = this._edgeT + 1; w.addScaledVector(this._rockAxis, TUNING.STANCE_NUDGE * Math.sqrt(gs)); }
        } else { this._edgeT = 0; this._nudgeT = 0; }
        if (this._sleepT >= TUNING.SLEEP_TIME * (this._floating ? 2.5 : 1) / Math.max(gs, 0.4) && (!edge || this._edgeT > TUNING.STANCE_WAIT / Math.max(gs, 0.25))) this._pin(ut);
      } else this._sleepT = 0;
    }
  }

  _updateChutes(dt, rho, pAtm, speed, radar, ev) {
    for (const p of this._chutes) {
      const ch = p.def.chute, st = p.deployed;
      if (st === 'armed') {
        if (pAtm >= TUNING.CHUTE_MIN_PRESSURE && speed < ch.maxSpeed) {
          p.deployed = 'semi'; p.deployT = 0;
          ev.push({ type: 'chute', vessel: this, part: p, state: 'semi' });
        }
      } else if (st === 'semi' || st === 'full') {
        if (speed > ch.maxSpeed * TUNING.CHUTE_RIP && rho > 0) {
          p.deployed = 'cut'; p.deployT = 0;
          ev.push({ type: 'chute', vessel: this, part: p, state: 'cut' });
          continue;
        }
        p.deployT = Math.min(1, p.deployT + dt / (st === 'semi' ? TUNING.CHUTE_SEMI_TIME : TUNING.CHUTE_FULL_TIME));
        if (st === 'semi' && radar < ch.fullAlt && p.deployT >= 1) {
          p.deployed = 'full'; p.deployT = 0;
          ev.push({ type: 'chute', vessel: this, part: p, state: 'full' });
        }
      }
    }
  }

  /**
   * Terrain under the centre of mass: { h (m above the reference radius), n (unit normal, inertial), water (bool),
   * floor (solid ground height: the sea bed under water) }. Cached while the vessel has not moved.
   */
  _groundInfo(ut) {
    const body = this.body;
    const g = this._gnd || (this._gnd = { h: 0, floor: 0, water: false, n: new Vector3(), nb: new Vector3(0, 1, 0), dir: new Vector3(2, 0, 0), body: null, slope: 0 });
    const d = body.inertialToSurfaceDir(_a.copy(this.pos).normalize(), ut, _b);
    const R = body.radius;
    if (g.body !== body || g.dir.distanceToSquared(d) * R * R > 0.0025) {
      g.body = body; g.dir.copy(d);
      const relief = typeof body.terrainHeight === 'function';
      const h0 = relief ? terrainAt(body, d) : 0;
      let fit = h0;
      g.nb.copy(d);
      if (relief) {
        const e1 = _c.crossVectors(Y_AXIS, d);
        if (e1.lengthSq() < 1e-10) e1.set(1, 0, 0);
        e1.normalize();
        const e2 = _d.crossVectors(d, e1);
        let gx, gy;
        const span = this._wheelSpan || 0;
        if (span > 0) {
          // A vehicle on three or more wheels stands on the plane that best fits the ground under its wheels: heights
          // a wheel-span out on four sides, and the middle. A one-sided slope taken at the centre of mass makes
          // every ripple shorter than the wheelbase rock the whole plane, and a rover is thrown about by ground
          // it would in fact straddle.
          const eps = span;
          const hE = terrainAt(body, _e.copy(d).addScaledVector(e1, eps / R).normalize()), hW = terrainAt(body, _e.copy(d).addScaledVector(e1, -eps / R).normalize());
          const hN = terrainAt(body, _e.copy(d).addScaledVector(e2, eps / R).normalize()), hS = terrainAt(body, _e.copy(d).addScaledVector(e2, -eps / R).normalize());
          gx = (hE - hW) / (2 * eps); gy = (hN - hS) / (2 * eps);
          fit = (h0 + hE + hW + hN + hS) / 5;
        } else {
          // the slope across what the craft stands on: heights one base radius out on four sides (round 3: this was a
          // one-sided difference over 2 m, which on rough ground is not the slope the feet find; each contact point
          // now meets its own ground, see _contact, and the plane's normal is the direction the ground pushes in)
          const eps = clamp(this._baseR || 1, 0.75, 3);
          const hE = terrainAt(body, _e.copy(d).addScaledVector(e1, eps / R).normalize()), hW = terrainAt(body, _e.copy(d).addScaledVector(e1, -eps / R).normalize());
          const hN = terrainAt(body, _e.copy(d).addScaledVector(e2, eps / R).normalize()), hS = terrainAt(body, _e.copy(d).addScaledVector(e2, -eps / R).normalize());
          gx = (hE - hW) / (2 * eps); gy = (hN - hS) / (2 * eps);
        }
        g.nb.addScaledVector(e1, -gx).addScaledVector(e2, -gy).normalize();
        g.slope = Math.hypot(gx, gy);
      } else g.slope = 0;
      const water = relief ? (body.ocean && h0 < (body.seaLevel || 0) - 0.05) : (body.ocean && !!body.biomeAt(d).water);
      g.water = water; g.h = h0;
      g.sea = body.ocean ? (body.seaLevel || 0) : 0;
      g.floor = water && !relief ? -60 : (water ? h0 : fit);
    }
    body.surfaceDirToInertial(g.nb, ut, g.n);
    return g;
  }

  /** Is the player (or the machine) asking for something a pinned vessel cannot do? See the wake rules in the docs. */
  _wantsAwake(thrust, s) {
    const c = this.ctrl;
    if (this._wake) return true;
    const vehicle = s ? s.vehicle : this._onWheels;
    if (vehicle) {
      if (this._driven > 0 && Math.abs(this.driveInput()) > 0.01 && this._total('elec') > 0) return true;
      if (thrust > 0 && !c.brake && thrust > 0.02 * this.mass * this.body.surfaceG) return true;
      if (s && s.slope > TUNING.WHEEL_ROLL * 1.5 && !c.brake) return true;
    }
    if (this.controllable && this.type !== 'eva') {
      const m = Math.max(Math.abs(c.pitch || 0), Math.abs(c.yaw || 0), Math.abs(c.roll || 0));
      if (m > 0.5 && !(vehicle && this._driven > 0)) {
        const auth = this._wheel * (this._total('elec') > 0 ? 1 : 0) + (c.rcs && this._total('mono') > 0 ? this._rcsAuth.x : 0);
        if (auth > 0.3 * this.mass * this.body.surfaceG * Math.max(0.3, this._baseR)) return true;
      }
    }
    return false;
  }
  /** Drive command for powered wheels in [−1, 1]: `ctrl.drive`, or forward on pitch-down (W) when that is zero. */
  driveInput() {
    const c = this.ctrl;
    const d = c.drive ? c.drive : -(c.pitch || 0);
    return d > 1 ? 1 : d < -1 ? -1 : d;
  }

  /**
   * Ground / water contact for one step. Fills this._cfx… (force, local frame) and this._ctx… (torque).
   * Returns true if parts were destroyed (the caller abandons the step).
   */
  _contact(dt, ut, ev, g, alt, ux, uy, uz, speed) {
    const body = this.body, q = this.q, w = this.w, com = this.com, m = this.mass;
    _qi.copy(q).invert();
    const R = this.pos.length();
    _up.copy(this.pos).multiplyScalar(1 / R);
    const nL = _a.copy(g.n).applyQuaternion(_qi);
    const upL = _b.copy(_up).applyQuaternion(_qi);
    const nx = nL.x, ny = nL.y, nz = nL.z, upx = upL.x, upy = upL.y, upz = upL.z;
    // distance of the CoM from the ground plane (through the surface point under the CoM, with the terrain normal)
    const d0 = (alt - g.floor) * _up.dot(g.n);
    const gLoc = body.gm / (R * R);
    const pts = this._pts, list = this._list;
    // --- relief under each hull point (round 3). The ground plane above goes through the terrain under the CoM; a point
    // a metre or two from it stands on its own ground, which on rough or sloping terrain is tens of centimetres off that
    // plane: an upright lander had feet in the air or in the ground, and a craft lying on its side lay half a metre
    // inside the hill. `dh` is the true clearance of the point minus its clearance from the plane, measured where the
    // point is now and kept until the vessel has moved 3 cm or turned about half a degree. A vehicle standing on three
    // or more wheels keeps the plane fitted over its wheel footprint (see _groundInfo); water has no relief.
    const relief = !g.water && !(this._wheelSpan > 0) && typeof body.terrainHeight === 'function';
    if (relief) {
      const k = this._reliefKey || (this._reliefKey = { x: 1e30, y: 0, z: 0, q: new Quaternion(), n: -1, body: null });
      const ut0 = ut - dt;      // the time `pos` belongs to (see _stepFlight)
      const sd = body.inertialToSurfaceDir(_rl1.copy(this.pos), ut0, _rl1).multiplyScalar(R);      // body-fixed position (m): unchanged while it sits still
      const turn = 1 - Math.abs(k.q.x * q.x + k.q.y * q.y + k.q.z * q.z + k.q.w * q.w);
      if (k.body !== body || k.n !== pts.length || turn > 1e-5 || (sd.x - k.x) ** 2 + (sd.y - k.y) ** 2 + (sd.z - k.z) ** 2 > 0.0009) {
        k.body = body; k.n = pts.length; k.x = sd.x; k.y = sd.y; k.z = sd.z; k.q.copy(q);
        const cosS = _up.dot(g.n), Rb = body.radius;
        for (let i = 0; i < pts.length; i++) {
          const c = pts[i];
          const rx = c.x - com.x, ry = c.y - com.y, rz = c.z - com.z;
          _rl2.set(rx, ry, rz).applyQuaternion(q).add(this.pos);
          const len = _rl2.length();
          const hT = terrainAt(body, body.inertialToSurfaceDir(_rl2, ut0, _rl2).normalize());
          c.dh = (len - Rb - hT) * cosS - (d0 + rx * nx + ry * ny + rz * nz);
          if (!(c.dh === c.dh) || c.dh > 3 || c.dh < -3) c.dh = 0;
        }
      }
    } else if (this._reliefKey && this._reliefKey.n !== -1) { this._reliefKey.n = -1; for (let i = 0; i < pts.length; i++) pts[i].dh = 0; }
    const SW = this.structure ? this.structure.wrench : null;      // structural loads: forces are booked to their parts too
    let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0;
    let nPen = 0, support = 0, slipping = false, floating = false, wet = 0;
    for (let i = 0; i < list.length; i++) { const p = list[i]; p._tcP = p._tc; p._tc = false; p._wetP = p._wet; p._wet = false; p._hit = 0; p._hitN = -1; }
    // --- pass 1: which hull points are below the ground / water, and how hard did they arrive
    // still rolling while two tyres carry it (or did a moment ago), even when a tail or wing tip already drags
    if (this.wheelsOnGround >= 2) this._rollUt = ut;
    const rolling = this._onWheels || ut - this._rollUt < 2;
    for (let i = 0; i < pts.length; i++) {
      const c = pts[i];
      const rx = c.x - com.x, ry = c.y - com.y, rz = c.z - com.z;
      const hp = d0 + rx * nx + ry * ny + rz * nz + (relief ? c.dh || 0 : 0);
      c.hp = hp; c.rx = rx; c.ry = ry; c.rz = rz;
      const vx = ux + (w.y * rz - w.z * ry), vy = uy + (w.z * rx - w.x * rz), vz = uz + (w.x * ry - w.y * rx);
      c.vx = vx; c.vy = vy; c.vz = vz;
      if (hp < 0 && !c.leg) {
        nPen++;
        const p = c.p;
        if (!p._tcP && !p._tc) {
          let hit = Math.sqrt(vx * vx + vy * vy + vz * vz);
          if (rolling) {       // a vehicle rolling on its wheels that brushes the ground scrapes: the sink rate counts in full, the slide for a third
            const vn = vx * nx + vy * ny + vz * nz;
            hit = Math.sqrt(vn * vn + (hit * hit - vn * vn) * 0.11);
            if (Math.abs(vn) > p._hitN) p._hitN = Math.abs(vn);
          }
          if (hit > p._hit) p._hit = hit;
        }
        p._tc = true;
      }
    }
    const bpts = this._bpts;
    if (g.water) {
      for (let i = 0; i < bpts.length; i++) {
        const c = bpts[i];
        const rx = c.x - com.x, ry = c.y - com.y, rz = c.z - com.z;
        const dep = g.sea - (alt + rx * upx + ry * upy + rz * upz) + c.rho;     // depth of the blob's underside
        c.dep = dep; c.rx = rx; c.ry = ry; c.rz = rz;
        if (dep > 0) {
          const vx = ux + (w.y * rz - w.z * ry), vy = uy + (w.z * rx - w.x * rz), vz = uz + (w.x * ry - w.y * rx);
          c.vx = vx; c.vy = vy; c.vz = vz;
          const p = c.p;
          if (!p._wetP && !p._wet && !p._tc) p._hit = Math.max(p._hit, Math.sqrt(vx * vx + vy * vy + vz * vz) / TUNING.WATER_TOL);
          p._wet = true; wet++;
        }
      }
    }
    // wheels (tyre contact): only the sink rate hurts them
    const wheels = this._wheels;
    let nW = 0, nWdown = 0;
    for (let i = 0; i < wheels.length; i++) {
      const p = wheels[i];
      p._loadP = p._load; p._load = 0;
      if (!p.deployed) continue;
      nWdown++;
      const rx = p._wx - com.x, ry = p._wy - com.y, rz = p._wz - com.z;
      const hp = d0 + rx * nx + ry * ny + rz * nz;
      p._hp = hp;
      if (hp < 0) {
        nW++;
        if (!p._tcP && !p._tc) {
          const vx = ux + (w.y * rz - w.z * ry), vy = uy + (w.z * rx - w.x * rz), vz = uz + (w.x * ry - w.y * rx);
          p._hit = Math.max(p._hit, Math.abs(vx * nx + vy * ny + vz * nz));
        }
        p._tc = true;
      }
    }
    // landing legs: how far is each foot under the ground, and has the strut run out of travel
    const legs = this._legs;
    let nLt = 0, nLdown = 0, snapped = null;
    for (let i = 0; i < legs.length; i++) {
      const p = legs[i];
      p._load = 0;
      if (!p.deployed || p._lp0 === undefined) continue;
      nLdown++;
      let pen = 0, at = -1;
      for (let j = p._lp0; j < p._lp0 + 5; j++) { const h = -pts[j].hp; if (h > pen) { pen = h; at = j; } }
      const penP = p._pen || 0;
      p._pen = pen; p._at = at;
      if (at < 0) { p._comp = 0; p._x = 0; continue; }
      nLt++;
      const c = pts[at];
      if (!p._tcP && !p._tc) { const hit = Math.sqrt(c.vx * c.vx + c.vy * c.vy + c.vz * c.vz); if (hit > p._hit) p._hit = hit; }
      p._tc = true;
      // the strut slides along the craft's axis; against ground that leans it has less travel, and none lying down
      const an = p._sg * ny, strokeN = p._stroke * (an > 0 ? an : 0);
      p._strokeN = strokeN;
      // How far the strut is closed (`_x`, along the ground normal). It closes as fast as the foot is driven into the
      // ground and no faster: a foot that is suddenly found deep under it (a leg unfolded while the craft stands on
      // its engine, a craft placed low) has not been loaded by anything, and a spring released from there would
      // throw a lander on a small moon tens of metres up. Such a leg takes up its load at LEG_EASE.
      const vn = c.vx * nx + c.vy * ny + c.vz * nz;
      // (in contact already, the strut follows the foot; at first contact it may be closed by what the speed of
      // arrival explains over one step)
      const want = pen < strokeN ? pen : strokeN, xP = p._x || 0;
      const can = Math.max(0, penP > 0 ? xP + (pen - penP) + TUNING.LEG_EASE * dt : (vn < 0 ? -1.5 * vn * dt : 0) + 0.005 + TUNING.LEG_EASE * dt);
      const x = want < can ? want : can;
      p._x = x; p._ease = want > can + 1e-9;
      if (pen > strokeN && x >= strokeN && xP < strokeN && an > 0.5) {
        p._bottomV = -vn;
        if (-vn > TUNING.LEG_BOTTOM_TOL * p.def.tolerance) (snapped || (snapped = [])).push(p.id);
        else if (-vn > 0.3) ev.push({ type: 'legBottom', vessel: this, part: p, speed: -vn });
      }
    }
    // --- crashes: parts that arrive faster than they can take are destroyed and soak up some of the speed
    let doomed = null, absorb = 0, all = false, hitMax = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!(p._hit > 0)) continue;
      if (p._hit > hitMax) hitMax = p._hit;
      const tol = p.def.tolerance;
      // a scrape while rolling (a tail strike, a wing tip) costs the part that touched; only a hard slam takes the whole craft
      if ((p._hitN >= 0 ? p._hitN : p._hit) > tol * TUNING.CRASH_ALL) all = true;
      else if (p._hit > tol) {
        (doomed || (doomed = [])).push(p.id);
        // what a part takes with it: its tolerance, but a leg only what it can take at the end of its stroke (a leg
        // good for 14 m/s used to stop the whole craft dead from 14 m/s: arriving faster was safer than slower)
        const soak = p.def.legs ? TUNING.LEG_BOTTOM_TOL * tol : tol;
        if (soak > absorb) absorb = soak;
      }
    }
    if (body.gas && (nPen || nW)) { this.destroyParts([...this.parts.keys()], ev, 'crushed'); return true; }
    if (all) { this.destroyParts([...this.parts.keys()], ev, 'crash'); return true; }
    if (doomed) {
      if (speed > 1e-6) {
        const f = Math.max(0, 1 - absorb / speed);
        const wy = TAU / body.rotPeriod, pos = this.pos, vel = this.vel;
        const sx = vel.x - wy * pos.z, sy = vel.y, sz = vel.z + wy * pos.x;
        vel.x -= sx * (1 - f); vel.y -= sy * (1 - f); vel.z -= sz * (1 - f);
      }
      this.destroyParts(doomed, ev, 'crash');
      return true;
    }
    // a leg that bottomed out too fast collapses. Its spring has already taken what it could: nothing more is
    // taken off the speed, and the craft comes down on what is left.
    if (snapped) {
      for (const id of snapped) ev.push({ type: 'legBroke', vessel: this, part: this.parts.get(id) });
      this.destroyParts(snapped, ev, 'crash');
      return true;
    }
    const touching = nPen > 0 || nW > 0 || wet > 0 || nLt > 0;
    if (touching && !this._touched) {
      this._touched = true;
      this._impact = speed;
      for (const p of this._chutes) if (p.deployed === 'semi' || p.deployed === 'full') { p.deployed = 'cut'; p.deployT = 0; }
      ev.push({ type: g.water && wet > 0 ? 'splashed' : 'landed', vessel: this, speed: this._impact });
    }
    // --- pass 2: forces
    const W = TUNING.GROUND_W, kN = m * W * W, cN = 2 * TUNING.GROUND_ZETA * W * m;
    const kf = TUNING.FRICTION_RATE * m;
    const inv0 = nPen > 0 ? 1 / nPen : 0;
    const I = this.inertia, iIx = 1 / I.x, iIy = 1 / I.y, iIz = 1 / I.z;
    const wRho = TUNING.WATER_RHO;
    // how the points that carry load are spread over the ground (two axes across the normal): see `_stance`
    let t1x, t1y, t1z;
    if (Math.abs(nx) < 0.9) { t1x = 0; t1y = nz; t1z = -ny; } else { t1x = -nz; t1y = 0; t1z = nx; }
    { const l = Math.sqrt(t1x * t1x + t1y * t1y + t1z * t1z) || 1; t1x /= l; t1y /= l; t1z /= l; }
    const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
    let sN = 0, sU = 0, sV = 0, sUU = 0, sVV = 0, sUV = 0;
    for (let i = 0; i < pts.length; i++) {
      const c = pts[i];
      let px = 0, py = 0, pz = 0;
      if (c.hp < 0 && !c.leg) {
        const vn = c.vx * nx + c.vy * ny + c.vz * nz;
        // the spring saturates a few centimetres in: deeper overlaps (a vessel placed inside the ground) ease out gently
        // effective mass seen by this point (a blow far from the centre of mass mostly turns the vessel)
        const ax = c.ry * nz - c.rz * ny, ay = c.rz * nx - c.rx * nz, az = c.rx * ny - c.ry * nx;
        const inv = inv0;
        // (on the way back out the damper is GROUND_REBOUND times firmer: what the ground gives back is what makes a
        // craft that has struck it hop, and where gravity is a fiftieth of home a hop of 0.8 m/s is a flight of metres)
        let N = (kN * (c.hp < -0.04 ? 0.04 : -c.hp) - cN * (vn > 0 ? TUNING.GROUND_REBOUND : 1) * vn / (1 + m * (ax * ax * iIx + ay * ay * iIy + az * az * iIz))) * inv0;
        if (N > 0) {
          const cap = 60 * m * gLoc + kN * 0.05;        // a single point never pushes harder than this
          if (N > cap) N = cap;
          support += N;
          { const u = c.rx * t1x + c.ry * t1y + c.rz * t1z, v = c.rx * t2x + c.ry * t2y + c.rz * t2z; sN++; sU += u; sV += v; sUU += u * u; sVV += v * v; sUV += u * v; }
          const tvx = c.vx - vn * nx, tvy = c.vy - vn * ny, tvz = c.vz - vn * nz;
          const vt = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz);
          px = N * nx; py = N * ny; pz = N * nz;
          if (vt > 1e-9) {
            const mu = c.kind === 1 ? TUNING.LEG_MU : TUNING.GROUND_MU;
            // like the damper, the viscous part is scaled by the effective mass at this point, so that a light vessel
            // with a wide stance (small roll inertia, long lever arms) does not chatter about its axis
            const ex = tvx / vt, ey = tvy / vt, ez = tvz / vt;
            const bx = c.ry * ez - c.rz * ey, by = c.rz * ex - c.rx * ez, bz = c.rx * ey - c.ry * ex;
            let F = kf * inv * vt / (1 + m * (bx * bx * iIx + by * by * iIy + bz * bz * iIz));
            if (F > mu * N) { F = mu * N; if (vt > 0.05) slipping = true; }
            const k = F / vt;
            px -= k * tvx; py -= k * tvy; pz -= k * tvz;
          }
        }
      }
      if (px || py || pz) {
        fx += px; fy += py; fz += pz;
        tx += c.ry * pz - c.rz * py; ty += c.rz * px - c.rx * pz; tz += c.rx * py - c.ry * px;        if (SW) { const k = c.p._si * 6, mx = c.ry * pz - c.rz * py, my = c.rz * px - c.rx * pz, mz = c.rx * py - c.ry * px; SW[k] += px; SW[k + 1] += py; SW[k + 2] += pz; SW[k + 3] += mx; SW[k + 4] += my; SW[k + 5] += mz; }
      }
    }
    // --- landing legs: one spring and damper per leg, a hard stop at the end of the stroke, friction under the foot
    if (nLt) {
      const Wl = TUNING.LEG_W, kL = m * Wl * Wl / nLdown, cIn = 2 * TUNING.LEG_ZETA * Wl * m / nLdown, cOut = 2 * TUNING.LEG_ZETA_REBOUND * Wl * m / nLdown;
      const invL = 1 / nLt;
      let sDamp = 0, legsOn = 0;
      for (let i = 0; i < legs.length; i++) {
        const p = legs[i];
        if (!p.deployed || !(p._pen > 0) || p._at < 0) { if (p._comp) p._comp = 0; continue; }
        const c = pts[p._at], pen = p._pen, strokeN = p._strokeN;
        const vn = c.vx * nx + c.vy * ny + c.vz * nz;
        const comp = p._x;
        // the foot stands on the ground: the force acts there, not where the unloaded foot would be
        const rx = c.rx + nx * pen, ry = c.ry + ny * pen, rz = c.rz + nz * pen;
        // The spring is taken where the strut will be at mid-step (x + v dt/2). Taken at the start of the step it lags
        // the motion by half a step, which acts as negative damping (W dt / 2 against a ratio of 0.3) and the legs
        // closed deeper than the equation they stand for. At rest the two are the same.
        // While a leg is still taking up its load (`_ease`) the strut itself is opening at LEG_EASE.
        const vs = vn - (p._ease ? TUNING.LEG_EASE : 0), cL = vs < 0 ? cIn : cOut;
        let N = kL * (comp - 0.5 * vs * dt) - cL * vs;
        if (!(strokeN > 0)) N = 0;
        if (pen > strokeN && comp >= strokeN) {
          const ax = ry * nz - rz * ny, ay = rz * nx - rx * nz, az = rx * ny - ry * nx;
          const over = pen - strokeN;
          N += (kN * (over > 0.04 ? 0.04 : over) - cN * (vn > 0 ? TUNING.GROUND_REBOUND : 1) * vn / (1 + m * (ax * ax * iIx + ay * ay * iIy + az * az * iIz))) * invL;
        }
        const an = p._sg * ny;
        p._comp = an > 0.2 ? Math.min(comp / an, p._stroke) : 0;
        if (!(N > 0)) continue;
        const cap = 60 * m * gLoc + kN * 0.05;
        if (N > cap) N = cap;
        support += N;
        p._load = N;
        legsOn++;
        sDamp += Math.abs(N - kL * comp);
        { const u = rx * t1x + ry * t1y + rz * t1z, v = rx * t2x + ry * t2y + rz * t2z; sN++; sU += u; sV += v; sUU += u * u; sVV += v * v; sUV += u * v; }
        let px = N * nx, py = N * ny, pz = N * nz;
        const tvx = c.vx - vn * nx, tvy = c.vy - vn * ny, tvz = c.vz - vn * nz;
        const vt = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz);
        if (vt > 1e-9) {
          const ex = tvx / vt, ey = tvy / vt, ez = tvz / vt;
          const bx = ry * ez - rz * ey, by = rz * ex - rx * ez, bz = rx * ey - ry * ex;
          let F = kf * invL * vt / (1 + m * (bx * bx * iIx + by * by * iIy + bz * bz * iIz));
          if (F > TUNING.LEG_MU * N) { F = TUNING.LEG_MU * N; if (vt > 0.05) slipping = true; }
          const k = F / vt;
          px -= k * tvx; py -= k * tvy; pz -= k * tvz;
        }
        fx += px; fy += py; fz += pz;
        tx += ry * pz - rz * py; ty += rz * px - rx * pz; tz += rx * py - ry * px;
        if (SW) { const k = p._si * 6; SW[k] += px; SW[k + 1] += py; SW[k + 2] += pz; SW[k + 3] += ry * pz - rz * py; SW[k + 4] += rz * px - rx * pz; SW[k + 5] += rx * py - ry * px; }
      }
      this._legLoad = true;
      this._legsOn = legsOn;
      // still creeping up (or down) on its dampers: the springs do not yet carry what the ground does
      this._legMoving = sDamp > 0.03 * m * (gLoc > 3 ? gLoc : 3);      // (3 m/s²: on the smallest moons the slow rocking of a craft at rest is more than 3 % of its weight)
    } else { this._legMoving = false; this._legsOn = 0; }
    // --- buoyancy and water drag
    if (g.water && wet > 0) {
      for (let i = 0; i < bpts.length; i++) {
        const c = bpts[i];
        if (!(c.dep > 0)) continue;
        const p = c.p;
        const disp = Math.max(p._vol * TUNING.BUOY_FILL * TUNING.WATER_RHO, TUNING.BUOY_MIN * p.mass) * c.share;
        const sub = c.dep >= 2 * c.rho ? 1 : c.dep / (2 * c.rho);
        const B = disp * gLoc * sub;
        const vv = Math.sqrt(c.vx * c.vx + c.vy * c.vy + c.vz * c.vz);
        const kd = (p.mass * c.share + 0.25 * disp) * sub * (TUNING.WATER_DRAG + TUNING.WATER_QDRAG * vv);
        const px = B * upx - kd * c.vx, py = B * upy - kd * c.vy, pz = B * upz - kd * c.vz;
        fx += px; fy += py; fz += pz;
        tx += c.ry * pz - c.rz * py; ty += c.rz * px - c.rx * pz; tz += c.rx * py - c.ry * px;
        if (SW) { const k = c.p._si * 6; SW[k] += px; SW[k + 1] += py; SW[k + 2] += pz; SW[k + 3] += c.ry * pz - c.rz * py; SW[k + 4] += c.rz * px - c.rx * pz; SW[k + 5] += c.rx * py - c.ry * px; }
        floating = true;
        support += B;
      }
    }
    // --- wheels: suspension, grip, drive, brakes, steering
    let onWheels = 0;
    if (nWdown) {
      const gScale = wheelGravityScale(gLoc);
      // The springs are sized for the weight they carry here: the same static sag (g / W²) on every world. With
      // Verda's spring rate a rover on a small moon sits on rigid legs, and the first ripple throws it into the air.
      const kStop = m * TUNING.WHEEL_W * TUNING.WHEEL_W / nWdown, cStop = 2 * m * TUNING.WHEEL_W / nWdown * (1 - Math.sqrt(gScale));
      const Ww = TUNING.WHEEL_W * Math.sqrt(gScale), kW = m * Ww * Ww / nWdown, cW = 2 * TUNING.WHEEL_ZETA * Ww * m / nWdown, mW = m / nWdown;
      const ctrl = this.ctrl;
      const drive = this._driven > 0 ? this.driveInput() : 0;
      const steerIn = clamp(ctrl.steer ? ctrl.steer : (ctrl.yaw || 0), -1, 1);
      const brake = ctrl.brake ? 1 : 0;
      const hasEC = this._driven > 0 && drive !== 0 ? this._total('elec') > 0 : false;
      let ecUse = 0;
      // anti-wheelie: as the axle that leads the push comes off the ground (hard acceleration, a steep climb) the
      // motors back off, so the rover neither stands on its tail nor goes over backwards on a slope
      // (a push forward lifts the front axle, a push backward - reverse, or braking - lifts the rear one)
      let cutFwd = 1, cutBack = 1;
      if (this._driven > 0) {
        let fore = 0, aft = 0;
        for (let i = 0; i < wheels.length; i++) { const p = wheels[i]; if (!p.deployed || !(p._loadP > 0)) continue; const y = p._wy - com.y; if (y > 0.05) fore += p._loadP; else if (y < -0.05) aft += p._loadP; }
        const tot = fore + aft;
        if (tot > 0) { cutFwd = clamp((fore / tot - 0.08) / 0.17, 0, 1); cutBack = clamp((aft / tot - 0.08) / 0.17, 0, 1); }
      }
      const lead = drive > 0 ? cutFwd : cutBack;
      for (let i = 0; i < wheels.length; i++) {
        const p = wheels[i];
        if (!p.deployed) continue;
        const wd = p.def.wheel;
        const rx = p._wx - com.x, ry = p._wy - com.y, rz = p._wz - com.z;
        const vx = ux + (w.y * rz - w.z * ry), vy = uy + (w.z * rx - w.x * rz), vz = uz + (w.x * ry - w.y * rx);
        // steering: front wheels turn into the corner, rear ones against it
        let ang = 0;
        if (wd.steer && steerIn) {
          ang = steerIn * TUNING.WHEEL_STEER / (1 + (speed / TUNING.WHEEL_STEER_SPEED) * (speed / TUNING.WHEEL_STEER_SPEED));
          // … and never more than the tyres can follow: a wheel `ry` from the centre of mass turned by `ang` asks for a
          // turn of radius ry / tan(ang), a sideways acceleration of v² tan(ang) / ry. Keep that to about half of what
          // the tyres grip with (round 3: the lock above still asked for 5 g at a rover's top speed; held, the D key
          // spun it through 200° in four seconds, sliding).
          const lock = Math.atan(Math.max(Math.abs(ry), 0.3) * TUNING.WHEEL_STEER_GRIP * TUNING.WHEEL_MU * gLoc / Math.max(speed * speed, 1));
          if (ang > lock) ang = lock; else if (ang < -lock) ang = -lock;
          if (ry < -0.05) ang = -ang; else if (ry <= 0.05) ang = 0;
        }
        p._steer = ang;
        if (!(p._hp < 0)) { p._spin *= 0.995; continue; }
        const vn = vx * nx + vy * ny + vz * nz;
        const comp = -p._hp;
        let N = kW * comp - cW * vn;
        // the bump stop is rubber, not spring: as hard on a small moon as at home, so that a soft-sprung rover coming
        // down off a ripple is caught by it and not by the hub striking the ground
        if (comp > p._travel) { N += 6 * kStop * (comp - p._travel); if (vn < 0) N -= cStop * vn; }
        if (!(N > 0)) { p._spin *= 0.995; continue; }
        const cap = 40 * m * gLoc + kW * 0.3;
        if (N > cap) N = cap;
        onWheels++;
        support += N;
        p._load = N;
        // rolling direction in the ground plane
        let dx = Math.sin(ang), dy = Math.cos(ang), dz = 0;
        const dn = dx * nx + dy * ny;
        dx -= dn * nx; dy -= dn * ny; dz -= dn * nz;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        dx /= dl; dy /= dl; dz /= dl;
        const lx = ny * dz - nz * dy, ly = nz * dx - nx * dz, lz = nx * dy - ny * dx;      // lateral = n × forward
        const vLong = vx * dx + vy * dy + vz * dz, vLat = vx * lx + vy * ly + vz * lz;
        p._spin = vLong / (wd.radius || 0.3);
        const grip = TUNING.WHEEL_MU * N;
        let Flat = -TUNING.WHEEL_SIDE_RATE * mW * vLat;
        if (Flat > grip) { Flat = grip; slipping = slipping || Math.abs(vLat) > 0.3; } else if (Flat < -grip) { Flat = -grip; slipping = slipping || Math.abs(vLat) > 0.3; }
        let Flong = 0;
        if (wd.drive > 0 && drive !== 0 && hasEC) {
          const vmax = (wd.maxSpeed || 20) * Math.pow(gScale, 0.75);     // the governor: see wheelGravityScale
          const along = vLong * Math.sign(drive);
          let f = along <= 0 ? 1 : 1 - (along / vmax) * (along / vmax);
          if (f < 0) f = Math.max(-1, f) * (gScale < 1 ? 1 : 0);      // past the governed speed (downhill) the motors hold it back; at home they freewheel as before
          const push = Math.min(wd.drive * 1000, TUNING.WHEEL_DRIVE_MU * N) * lead;
          Flong += drive * push * f;
          // a motor held back by traction control draws in proportion (never less than a fifth: electronics, losses)
          ecUse += (wd.elecUse || 0) * Math.abs(drive) * Math.max(0.2, push / (wd.drive * 1000));
        }
        // brakes (and a parking hold for powered wheels left alone), then rolling resistance
        // brakes bite at well under the tyre's grip: a short, tall rover (or a nose-wheel aeroplane) braked at
        // the limit of adhesion goes over its front wheels
        const bmax = brake ? Math.min((wd.brake || 0) * 1000, TUNING.WHEEL_BRAKE_MU * N) : 0;
        if (bmax > 0) Flong -= clamp(TUNING.WHEEL_BRAKE_RATE * mW * vLong, -bmax, bmax) * (vLong > 0 ? cutBack : cutFwd);
        const roll = TUNING.WHEEL_ROLL * N;
        Flong -= clamp(2.5 * mW * vLong, -roll, roll);
        // motor and brake together stay inside what one of them may do: a rover braking hard with its motors in
        // reverse as well went over its front wheels
        const lim = Math.min(grip, Math.max(TUNING.WHEEL_BRAKE_MU, TUNING.WHEEL_DRIVE_MU) * N + roll);
        if (Flong > lim) Flong = lim; else if (Flong < -lim) Flong = -lim;
        const px = N * nx + Flong * dx + Flat * lx, py = N * ny + Flong * dy + Flat * ly, pz = N * nz + Flong * dz + Flat * lz;
        fx += px; fy += py; fz += pz;
        tx += ry * pz - rz * py; ty += rz * px - rx * pz; tz += rx * py - ry * px;
        if (SW) { const k = p._si * 6; SW[k] += px; SW[k + 1] += py; SW[k + 2] += pz; SW[k + 3] += ry * pz - rz * py; SW[k + 4] += rz * px - rx * pz; SW[k + 5] += rx * py - ry * px; }
      }
      if (ecUse > 0) this._drain('elec', ecUse * dt);
    }
    this._cfx = fx; this._cfy = fy; this._cfz = fz; this._ctx = tx; this._cty = ty; this._ctz = tz;
    this.grounded = touching;
    this.groundContacts = nPen + nW + nLt;
    this.wheelsOnGround = onWheels;
    this._onWheels = onWheels >= 2 && onWheels >= nPen;
    this._slipping = slipping;
    this._floating = floating && nPen === 0 && nW === 0;
    this._supported = support > 0.5 * m * gLoc;
    // A craft stands only on a footprint with some width. On a single line of contact (two feet of four, the other
    // two in the air) it is balanced on a knife edge, however still it is: `_stance` is the smaller spread of the
    // loaded points (m), `_rockAxis` the line they lie on (craft frame). See the pinning rule in _stepFlight.
    if (sN >= 2) {
      const a = sUU / sN - (sU / sN) * (sU / sN), b = sUV / sN - (sU / sN) * (sV / sN), d = sVV / sN - (sV / sN) * (sV / sN);
      const h = Math.sqrt((a - d) * (a - d) / 4 + b * b), lo = (a + d) / 2 - h, hi = (a + d) / 2 + h;
      this._stance = Math.sqrt(Math.max(0, lo));
      // direction of the larger spread
      let eu = b, ev2 = hi - a;
      if (Math.abs(eu) + Math.abs(ev2) < 1e-12) { eu = hi - d; ev2 = b; }
      if (Math.abs(eu) + Math.abs(ev2) < 1e-12) { eu = 1; ev2 = 0; }
      const el = Math.hypot(eu, ev2);
      eu /= el; ev2 /= el;
      (this._rockAxis || (this._rockAxis = new Vector3())).set(eu * t1x + ev2 * t2x, eu * t1y + ev2 * t2y, eu * t1z + ev2 * t2z);
    } else { this._stance = 0; if (this._rockAxis) this._rockAxis.set(0, 0, 0); }
    if (touching) { this._groundT += dt; this._airT = 0; } else { this._groundT = 0; this._sleepT = 0; }
    return false;
  }

  /** Freeze a resting vessel onto the surface where it is (it becomes `landed`; `splashed` when afloat). */
  _pin(ut) {
    const body = this.body;
    const R = this.pos.length();
    const dir = new Vector3();
    body.inertialToSurfaceDir(_a.copy(this.pos).multiplyScalar(1 / R), ut, dir);
    _qa.setFromAxisAngle(Y_AXIS, -body.rotationAngle(ut));
    const qRel = _qa.clone().multiply(this.q).normalize();
    const g = this._gnd;
    this.landed = true; this.splashed = !!this._floating;
    this.surface = { dir, qRel, h: R - body.radius, qTarget: null, fixed: true, vehicle: !!this._onWheels, slope: g ? g.slope : 0 };
    this.w.set(0, 0, 0);
    this.grounded = false; this._sleepT = 0; this._wake = false; this._nearGround = false;
    for (const p of this._chutes) if (p.deployed === 'semi' || p.deployed === 'full') { p.deployed = 'cut'; p.deployT = 0; }
    this.gForce = body.gm / (R * R) / G0;
    this.syncLanded(ut);
  }
  /** Pin the vessel where it is right now if it is touching the ground (used before unloading it). */
  pinToGround(ut) {
    if (this.landed || this.dead) return this.landed;
    if (!this.grounded && !(this._groundT > 0)) return false;
    this._pin(ut);
    return true;
  }
  /** Let a pinned vessel move again (it stays on the ground until something pushes it). */
  _unpin(ut) {
    if (!this.landed) return;
    this.syncLanded(ut);
    this.landed = false; this.splashed = false; this.surface = null;
    this.sasTarget = null;
    this._wake = false; this._sleepT = 0; this._touched = true; this._airT = 0; this._nearGround = true;
    this.grounded = true; this._groundT = TUNING.GROUND_SIT_TIME + 0.01;
    this._gnd = null;
    this._stamp++;
  }
  /** Wake a landed vessel (after a change the pinned pose cannot represent: gear toggled, part lost, …). */
  wake() { if (this.landed && this.type !== 'eva') this._wake = true; }

  /** Lowest point of the vessel along `upLocal` (unit, local frame), relative to the CoM: {h, part}. */
  _lowest(upLocal) {
    const com = this.com, ux = upLocal.x, uy = upLocal.y, uz = upLocal.z;
    const s = Math.sqrt(Math.max(0, 1 - uy * uy));
    let h = Infinity, part = null;
    for (const c of this._cp) {
      const v = (c.x - com.x) * ux + (c.y - com.y) * uy + (c.z - com.z) * uz - c.r * s;
      if (v < h) { h = v; part = c.p; }
    }
    return { h, part };
  }

  _groundContact(ut, ev) {
    const body = this.body, pos = this.pos, vel = this.vel;
    const R = pos.length();
    _up.copy(pos).multiplyScalar(1 / R);
    _qi.copy(this.q).invert();
    _ul.copy(_up).applyQuaternion(_qi);
    const low = this._lowest(_ul);
    body.inertialToSurfaceDir(_up, ut, _b);
    const gh = surfaceAt(body, _b);
    const hmin = R - body.radius + low.h - gh;
    if (hmin > 0) return;
    const wy = TAU / body.rotPeriod;
    _a.set(vel.x - wy * pos.z, vel.y, vel.z + wy * pos.x);
    const vs = _a.dot(_up);
    if (vs > 0.2) return;   // climbing away
    const speed = _a.length();
    if (body.gas) { this.destroyParts([...this.parts.keys()], ev, 'crushed'); return; }
    const water = waterAt(body, _b);
    const wt = water ? TUNING.WATER_TOL : 1;
    // parts touching the ground
    const com = this.com, sn = Math.sqrt(Math.max(0, 1 - _ul.y * _ul.y));
    const touching = new Set();
    for (const c of this._cp) {
      const v = (c.x - com.x) * _ul.x + (c.y - com.y) * _ul.y + (c.z - com.z) * _ul.z - c.r * sn;
      if (v <= low.h + 0.03) touching.add(c.p);
    }
    let ids = [], absorb = 0;
    if (speed > low.part.def.tolerance * wt * TUNING.CRASH_ALL) { ids = [...this.parts.keys()]; }
    else for (const p of touching) if (speed > p.def.tolerance * wt) { ids.push(p.id); absorb = Math.max(absorb, p.def.tolerance * wt); }
    if (!ids.length) { this._land(ut, water, speed, ev); return; }
    // too fast: the weak contacting parts are destroyed and soak up some of the speed
    const f = Math.max(0, 1 - absorb / speed);
    vel.x -= _a.x * (1 - f); vel.y -= _a.y * (1 - f); vel.z -= _a.z * (1 - f);
    this.destroyParts(ids, ev, 'crash');
  }

  _land(ut, water, speed, ev) {
    const body = this.body;
    const R = this.pos.length();
    const dir = new Vector3();
    body.inertialToSurfaceDir(_a.copy(this.pos).multiplyScalar(1 / R), ut, dir);
    _qa.setFromAxisAngle(Y_AXIS, -body.rotationAngle(ut));
    const qRel = _qa.clone().multiply(this.q).normalize();
    this.landed = true; this.splashed = !!water;
    this.surface = { dir, qRel, h: R - body.radius, qTarget: null };
    // settle: stand upright if the base is wide enough for the tilt, else topple onto the side
    const yb = _b.set(0, 1, 0).applyQuaternion(qRel);
    const cosT = clamp(yb.dot(dir), -1, 1), tilt = Math.acos(cosT);
    const limit = this.type === 'eva' ? 4 : Math.atan2(this._baseR, Math.max(0.05, this._baseH)) * (water ? 1.6 : 1) + 0.12;
    if (tilt <= limit) _c.copy(dir);
    else {
      _c.copy(yb).addScaledVector(dir, -cosT);
      if (_c.lengthSq() < 1e-8) { _c.set(dir.y, dir.z, dir.x); _c.addScaledVector(dir, -_c.dot(dir)); }
      _c.normalize();
    }
    _qb.setFromUnitVectors(yb, _c);
    this.surface.qTarget = _qb.clone().multiply(qRel).normalize();
    this.w.set(0, 0, 0);
    for (const p of this._chutes) if (p.deployed === 'semi' || p.deployed === 'full') { p.deployed = 'cut'; p.deployT = 0; }
    this.gForce = body.gm / (R * R) / G0;
    this.syncLanded(ut);
    ev.push({ type: water ? 'splashed' : 'landed', vessel: this, speed });
  }

  _stepLanded(dt, ut, ev) {
    const body = this.body, s = this.surface;
    const R = body.radius + s.h;
    this._envAlt = s.h; this._envMach = 0;
    const thrust = this._systems(dt, body.pressureAtm(s.h), ev);
    this.actuation.set(0, 0, 0);
    if (s.qTarget) {
      s.qRel.rotateTowards(s.qTarget, 1.2 * dt);
      if (s.qRel.angleTo(s.qTarget) < 1e-4) { s.qRel.copy(s.qTarget); s.qTarget = null; }
    }
    const c = this.ctrl;
    if (this.type === 'eva') {
      if (this.ladder) return;                       // holding a ladder: the World moves the Pip (see World._ladderStep)
      if (c.yaw) { _qa.setFromAxisAngle(s.dir, -clamp(c.yaw, -1, 1) * 2.0 * dt); s.qRel.premultiply(_qa).normalize(); }
      if (c.tx || c.tz) {
        // A Pip walks the way it faces. The command (tx, tz) is a direction in the Pip's own frame: the Pip turns toward
        // it (EVA_TURN rad/s) and only steps out once it is nearly facing that way, so it never walks sideways or
        // backwards. The command is re-expressed in the turned frame, so a held command keeps its direction over the
        // ground and ends up as "straight ahead" (tx = 0, tz > 0).
        let tx = clamp(c.tx, -1, 1), tz = clamp(c.tz, -1, 1);
        const m = Math.min(1, Math.hypot(tx, tz));
        const ang = Math.atan2(tx, tz);
        const turn = clamp(ang, -TUNING.EVA_TURN * dt, TUNING.EVA_TURN * dt);
        const rem = ang - turn;
        if (turn) {
          _qa.setFromAxisAngle(s.dir, turn); s.qRel.premultiply(_qa).normalize();
          tx = c.tx = m * Math.sin(rem); tz = c.tz = m * Math.cos(rem);
        }
        const pace = clamp((Math.cos(rem) - 0.5) * 2, 0, 1);
        if (pace > 0) {
          _a.set(tx, 0, tz).applyQuaternion(s.qRel);
          _a.addScaledVector(s.dir, -_a.dot(s.dir));
          _b.copy(s.dir).addScaledVector(_a, pace * TUNING.EVA_WALK * dt / R).normalize();
          _qa.setFromUnitVectors(s.dir, _b);
          s.qRel.premultiply(_qa).normalize();
          s.dir.copy(_b);
          s.gh = undefined;
        }
      }
      if (c.ty > 0.5) {
        this._release(ut, ev);
        _a.copy(this.pos).normalize();
        this.vel.addScaledVector(_a, TUNING.EVA_JUMP);
        this.pos.addScaledVector(_a, 0.02);
        return;
      }
      return;
    }
    _qi.copy(s.qRel).invert();
    _ul.copy(s.dir).applyQuaternion(_qi);
    const g = body.gm / (R * R);
    const lift = thrust * _ul.y;
    if (thrust > 0 && lift > this.mass * g) { this._release(ut, ev); return; }
    // sideways thrust that beats friction makes it slide; a vehicle rolls as soon as it is asked to
    let wake = this._wantsAwake(thrust, s);
    if (!wake && thrust > 0) {
      const side = thrust * Math.sqrt(Math.max(0, 1 - _ul.y * _ul.y));
      if (lift > this.mass * g || side > TUNING.GROUND_MU * Math.max(0, this.mass * g - lift)) wake = true;
    }
    if (wake) this._unpin(ut);
  }

  _release(ut, ev) {
    this.syncLanded(ut);
    this.landed = false; this.splashed = false; this.surface = null;
    this.sasTarget = null;
    this._stamp++;
    this._touched = true; this._airT = 0; this._gnd = null; this._sleepT = 0; this._wake = false;
    if (!this.launched) {
      this.launched = true; this.launchUt = ut;
      ev.push({ type: 'liftoff', vessel: this });
    }
  }

  /** Recompute pos / vel / q of a landed vessel from its surface anchor. */
  syncLanded(ut) {
    const s = this.surface, body = this.body;
    if (!s) return;
    if (!s.fixed) {
      // kinematic placement: the lowest point of the vessel rests on the terrain (on the sea surface over water)
      _qi.copy(s.qRel).invert();
      _ul.copy(s.dir).applyQuaternion(_qi);
      if (s.gh === undefined || s.gb !== body) { s.gh = surfaceAt(body, s.dir); s.gb = body; }
      s.h = s.gh - this._lowest(_ul).h;
      if (!(s.h > -1e6 && s.h < 1e6)) s.h = 0;
    }
    body.surfaceDirToInertial(s.dir, ut, this.pos).multiplyScalar(body.radius + s.h);
    const wy = TAU / body.rotPeriod;
    this.vel.set(wy * this.pos.z, 0, -wy * this.pos.x);
    _qa.setFromAxisAngle(Y_AXIS, body.rotationAngle(ut));
    this.q.copy(_qa).multiply(s.qRel).normalize();
    this.w.set(0, 0, 0);
    this._stamp++;
  }

  // ------------------------------------------------------------------ telemetry
  /** Refresh derived fields. Returns the previous situation if it changed, else null. */
  updateTelemetry(ut) {
    if (Number.isFinite(ut)) this._ut = ut;
    if (this.dead) return null;
    const body = this.body, pos = this.pos, vel = this.vel;
    if (this.landed) this.syncLanded(ut);
    const R = pos.length();
    const wy = TAU / body.rotPeriod;
    const sv = this.surfaceVel.set(vel.x - wy * pos.z, vel.y, vel.z + wy * pos.x);
    this.altitude = R - body.radius;
    this.airspeed = sv.length();
    this.orbitalSpeed = vel.length();
    this.verticalSpeed = this.landed ? 0 : sv.dot(pos) / R;
    this.horizontalSpeed = Math.sqrt(Math.max(0, this.airspeed * this.airspeed - this.verticalSpeed * this.verticalSpeed));
    const rho = body.density(this.altitude);
    this.dynamicPressure = 0.5 * rho * this.airspeed * this.airspeed;
    this.mach = this.airspeed / TUNING.SOUND_SPEED;
    this.groundSpeed = this.landed ? 0 : this.horizontalSpeed;
    // height of the terrain under the vessel (the sea surface over water)
    let gh = 0;
    if (typeof body.terrainHeight === 'function' && this.altitude < 60000 && !this.onRails) {
      gh = terrainAtPos(body, pos, ut);
    }
    this.groundHeight = gh;
    if (this.landed) { this.radarAlt = 0; this.gForce = body.gm / (R * R) / G0; }
    else if (this.altitude - gh < this._bound + 2000) {
      _up.copy(pos).multiplyScalar(1 / R);
      _qi.copy(this.q).invert();
      this.radarAlt = this.altitude - gh + this._lowest(_up.applyQuaternion(_qi)).h;
    } else this.radarAlt = this.altitude - gh - this._baseH;
    if (this.onRails) { this.gForce = 0; this.thrust = 0; }
    // apsides
    const gm = body.gm;
    const energy = 0.5 * vel.lengthSq() - gm / R;
    const h2 = _a.crossVectors(pos, vel).lengthSq();
    const ecc = Math.sqrt(Math.max(0, 1 + 2 * energy * h2 / (gm * gm)));
    const rp = h2 / gm / (1 + ecc);
    let ra = Infinity, period = Infinity;
    if (energy < 0) { const a = -gm / (2 * energy); ra = a * (1 + ecc); period = TAU * Math.sqrt(a * a * a / gm); }
    this.periapsis = rp - body.radius;
    this.apoapsis = ra - body.radius;
    this.period = period;
    // situation
    let sit;
    const onGround = !this.landed && this.grounded && this._groundT > TUNING.GROUND_SIT_TIME;
    if (this.splashed || (onGround && this._floating)) sit = 'splashed';
    else if (this.landed || onGround) sit = this.launched ? 'landed' : 'prelaunch';
    else if (body.atmo && this.altitude < body.atmo.height) sit = 'flying';
    else {
      const floor = body.atmo ? body.atmo.height : 5000;
      if (energy >= 0 || ra > body.soi) sit = 'escape';
      else if (this.periapsis > floor) sit = 'orbit';
      else sit = 'suborbital';
    }
    const from = this.situation;
    this.situation = sit;
    this.updateResources();
    return from !== sit ? from : null;
  }

  /** Remaining vacuum delta-v, simulating the staging sequence like Craft.stats(). Sets deltaV and stageDeltaV. */
  estimateDeltaV() {
    const parts = this.parts;
    let alive = new Set(parts.keys());
    const fuel = new Map(), solid = new Map(), xen = new Map(), ignited = new Set();
    let mass = 0;
    for (const p of this._list) {
      mass += p.mass || (p.def.mass * 1000);
      if (p.res.fuel) fuel.set(p.id, p.res.fuel);
      if (p.res.xenon) xen.set(-p.id, p.res.xenon);
      if (p.res.solid) solid.set(p.id, p.res.solid);
      if (p.ignited) ignited.add(p.id);
    }
    const partMass = id => { const p = parts.get(id); return p.mass - (p.res.fuel || 0) - (p.res.solid || 0) - (p.res.xenon || 0) + (fuel.get(id) || 0) + (solid.get(id) || 0) + (xen.get(-id) || 0); };
    const comp = (start, blocked, within) => {
      const seen = new Set();
      if (!within.has(start) || blocked.has(start)) return seen;
      seen.add(start);
      const queue = [start];
      for (let i = 0; i < queue.length; i++) for (const id of parts.get(queue[i]).links) {
        if (seen.has(id) || blocked.has(id) || !within.has(id)) continue;
        seen.add(id); queue.push(id);
      }
      return seen;
    };
    const after = (set, stage) => {
      const cut = new Set();
      for (const id of stage) if (set.has(id) && parts.get(id).def.decoupler) cut.add(id);
      return cut.size ? comp(this.controlId, cut, set) : set;
    };
    const none = new Set();
    const burning = () => {
      const list = [];
      for (const e of this._engines) {
        const p = e.part;
        if (!ignited.has(p.id) || !alive.has(p.id)) continue;
        const en = p.def.engine, mdot = en.thrust * 1000 / (en.ispVac * G0);
        if (en.type === 'jet') continue;      // air-breathers do not count towards vacuum delta-v
        if (en.type === 'solid') { if ((solid.get(p.id) || 0) > 1e-9) list.push({ id: p.id, F: en.thrust * 1000, mdot, tanks: null }); }
        else {
          const sec = comp(p.id, decs, alive);
          const tanks = [];
          // tank keys: +id for fuel, −id for xenon (both live in the `fuel` bookkeeping below)
          if (e.prop === 'xenon') { for (const id of sec) if ((xen.get(-id) || 0) > 1e-9) tanks.push(-id); }
          else for (const id of sec) if ((fuel.get(id) || 0) > 1e-9) tanks.push(id);
          if (tanks.length) list.push({ id: p.id, F: en.thrust * 1000, mdot, tanks });
        }
      }
      return list;
    };
    const decs = new Set();
    for (const p of this._list) if (p.def.decoupler) decs.add(p.id);
    void none;
    let total = 0, first = null;
    const info = [];
    for (let si = this.stageIndex - 1; si < this.stages.length; si++) {
      if (si >= this.stageIndex) {
        const stage = this.stages[si];
        const next = after(alive, stage);
        if (next !== alive) { alive = next; mass = 0; for (const id of alive) mass += partMass(id); }
        for (const id of stage) if (alive.has(id) && parts.get(id).def.engine) ignited.add(id);
      }
      const nextStage = this.stages[si + 1];
      const survivors = nextStage ? after(alive, nextStage) : alive;
      let dv = 0, time = 0, F0 = 0, mdot0 = 0;
      const m0 = mass;
      for (let guard = 0; guard < 200; guard++) {
        const eng = burning();
        if (!eng.length) break;
        if (guard === 0) for (const e of eng) { F0 += e.F; mdot0 += e.mdot; }
        let everDoomed = false;
        for (const id of ignited) if (alive.has(id) && !survivors.has(id)) { everDoomed = true; break; }
        if (everDoomed && !eng.some(e => !survivors.has(e.id))) break;
        const drain = new Map();
        let F = 0, mdot = 0, dt = Infinity;
        for (const e of eng) {
          F += e.F; mdot += e.mdot;
          if (!e.tanks) dt = Math.min(dt, solid.get(e.id) / e.mdot);
          else for (const t of e.tanks) drain.set(t, (drain.get(t) || 0) + e.mdot / e.tanks.length);
        }
        for (const [id, rate] of drain) dt = Math.min(dt, (id < 0 ? xen : fuel).get(id) / rate);
        for (const [id, rate] of drain) { const st = id < 0 ? xen : fuel; const left = st.get(id) - rate * dt; st.set(id, left < 1e-6 ? 0 : left); }
        for (const e of eng) if (!e.tanks) { const left = solid.get(e.id) - e.mdot * dt; solid.set(e.id, left < 1e-6 ? 0 : left); }
        const m1 = mass - mdot * dt;
        if (!(m1 > 0)) break;
        dv += F / mdot * Math.log(mass / m1);
        time += dt;
        mass = m1;
      }
      if (first === null) first = dv;
      total += dv;
      info.push({ stage: si, dv, thrust: F0, ve: mdot0 > 0 ? F0 / mdot0 : 0, startMass: m0, burnTime: time });
    }
    this.deltaV = total; this.stageDeltaV = first || 0;
    this.stageInfo = info;   // [{stage (index, stageIndex−1 = burning now), dv, thrust, ve, startMass, burnTime}]
    return total;
  }

  // ------------------------------------------------------------------ persistence
  toJSON() {
    const parts = [];
    for (const p of this.parts.values()) {
      parts.push({
        id: p.id, type: p.type, pos: j3(p.pos), rot: p.rot, links: p.links.slice(), res: { ...p.res },
        ignited: p.ignited, flameout: p.flameout, deployed: p.deployed, deployT: p.deployT, comp: p._comp > 0.001 ? +p._comp.toFixed(4) : undefined, temp: p.temp,
        crew: p.crew.slice(), sym: p.sym,
        flip: p.flip || undefined, pitch: p.pitch || undefined, roll: p.roll || undefined, dockedTo: p.dockedTo ?? undefined, dockName: p.dockName, dockType: p.dockType,
        truss: p.truss && p.truss.length ? p.truss.map(t => ({ ...t })) : undefined,
        dockReady: p.dockReady === false ? false : undefined,
      });
    }
    const s = this.surface;
    return {
      id: this.id, name: this.name, type: this.type, parts, stages: this.stages.map(x => x.slice()), stageIndex: this.stageIndex,
      controlId: this.controlId, body: this.body.id, pos: j3(this.pos), vel: j3(this.vel), q: this.q.toArray(), w: j3(this.w),
      com: j3(this.com),
      landed: this.landed, splashed: this.splashed,
      surface: s ? { dir: j3(s.dir), qRel: s.qRel.toArray(), h: s.h, qTarget: s.qTarget ? s.qTarget.toArray() : null,
        fixed: s.fixed || undefined, vehicle: s.vehicle || undefined, slope: s.slope || undefined } : null,
      ground: this.landed ? undefined : { g: this.grounded, t: this._groundT, a: this._airT, s: this._sleepT, c: this._touched, n: !!this._nearGround,
        tc: this._list.filter(p => p._tc).map(p => p.id), wet: this._list.filter(p => p._wet).map(p => p.id) },
      actionGroups: Object.keys(this.actionGroups).length ? cloneGroups(this.actionGroups) : undefined,
      ladder: this.ladder ? { ...this.ladder } : undefined, launchSite: this.launchSite || undefined, stranded: this.stranded || undefined,
      onRails: this.onRails, orbit: this.onRails && this.orbit ? this.orbit.toJSON() : null,
      ctrl: { ...this.ctrl }, sasTarget: this.sasTarget ? this.sasTarget.toArray() : null, sasDir: j3(this.sasDir),
      sasCoast: this._sasCoast, targetId: this.targetId,
      nodes: this.nodes.map(n => ({ t: n.t, dv: { ...n.dv }, rem: n.rem ? { ...n.rem } : undefined })),
      science: this.science.map(r => ({ ...r })), launched: this.launched, launchUt: this.launchUt,
      situation: this.situation, sunlit: this.sunlit, hot: this._hot,
      role: this.role || undefined,   // player-chosen map / tracking-station type (see js/ui/map/glyphs.js)
    };
  }

  static fromJSON(o) {
    if (typeof o === 'string') o = JSON.parse(o);
    const v = new Vessel();
    v.id = o.id; v.name = o.name; v.type = o.type || 'ship';
    for (const j of o.parts) {
      const p = makePart(j.id, currentPartId(j.type), j.pos, j.rot, j.sym);
      p.links = j.links.slice(); p.res = { ...j.res };
      p.ignited = !!j.ignited; p.flameout = !!j.flameout; p.deployed = j.deployed; p.deployT = j.deployT || 0; if (j.comp > 0) p._comp = j.comp;
      p.temp = j.temp ?? TUNING.AMBIENT_T; p.crew = (j.crew || []).slice();
      p.flip = !!j.flip; p.pitch = +j.pitch || 0; p.roll = +j.roll || 0; p.dockedTo = j.dockedTo ?? null;
      if (j.dockName !== undefined) p.dockName = j.dockName;
      if (j.dockType !== undefined) p.dockType = j.dockType;
      if (j.dockReady === false) p.dockReady = false;
      if (Array.isArray(j.truss)) { const tr = j.truss.filter(t => t && t.h > 0 && t.r0 > 0 && t.r1 > 0).map(t => ({ side: t.side < 0 ? -1 : 1, h: +t.h, r0: +t.r0, r1: +t.r1, mass: +t.mass || 0 })); if (tr.length) p.truss = tr; }
      v.parts.set(p.id, p);
    }
    v.stages = o.stages.map(s => s.slice()); v.stageIndex = o.stageIndex || 0;
    v.controlId = o.controlId;
    v.body = SYSTEM.byId[o.body] || SYSTEM.home;
    v.pos.copy(v3(o.pos)); v.vel.copy(v3(o.vel)); v.q.fromArray(o.q); v.w.copy(v3(o.w));
    v.landed = !!o.landed; v.splashed = !!o.splashed;
    if (o.surface) {
      v.surface = { dir: v3(o.surface.dir), qRel: new Quaternion().fromArray(o.surface.qRel), h: o.surface.h,
        qTarget: o.surface.qTarget ? new Quaternion().fromArray(o.surface.qTarget) : null };
      if (o.surface.fixed) v.surface.fixed = true;
      if (o.surface.vehicle) v.surface.vehicle = true;
      if (o.surface.slope) v.surface.slope = o.surface.slope;
    }
    if (o.ground) {
      const gs = o.ground;
      v.grounded = !!gs.g; v._groundT = gs.t || 0; v._airT = gs.a ?? 99; v._sleepT = gs.s || 0; v._touched = !!gs.c; v._nearGround = !!gs.n;
      for (const id of gs.tc || []) { const p = v.parts.get(id); if (p) p._tc = true; }
      for (const id of gs.wet || []) { const p = v.parts.get(id); if (p) p._wet = true; }
    }
    v.actionGroups = cloneGroups(o.actionGroups);
    v.ladder = o.ladder ? { ...o.ladder } : null; v.launchSite = o.launchSite || null; v.stranded = !!o.stranded;
    v.ctrl = { ...defaultCtrl(), ...o.ctrl };
    v.sasTarget = o.sasTarget ? new Quaternion().fromArray(o.sasTarget) : null;
    if (o.sasDir) v.sasDir.copy(v3(o.sasDir));
    v._sasCoast = !!o.sasCoast;
    v.targetId = o.targetId ?? null;
    v.nodes = (o.nodes || []).map(n => { const r = { t: n.t, dv: { ...n.dv } }; if (n.rem) r.rem = { ...n.rem }; return r; });
    v.science = (o.science || []).map(r => ({ ...r }));
    v.launched = !!o.launched; v.launchUt = o.launchUt || 0;
    v.situation = o.situation || 'flying';
    v.sunlit = o.sunlit !== false; v._hot = !!o.hot;
    if (typeof o.role === 'string') v.role = o.role;
    v._rebuild();
    if (o.com) v.com.copy(v3(o.com));
    v._updateMass(false);
    v.onRails = !!o.onRails;
    if (o.orbit) v.orbit = Orbit.fromJSON(o.orbit);
    v.updateResources();
    v.estimateDeltaV();
    return v;
  }
}
