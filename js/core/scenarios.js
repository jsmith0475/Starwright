// Starwright scenarios: ready-made games that start somewhere interesting (a finished rocket in the assembly
// building, a ship on the pad, in orbit, beside a station, on another world, on the way in to a far planet).
// PURE LOGIC - no DOM. Runs under Node. Everything here is built with the game's own Craft, Vessel, World and Career
// APIs: a scenario game is an ordinary sandbox-mode Career (every part unlocked, no funds) whose `scenario` field
// names the scenario and remembers which objectives are done, and whose `flightState` is an ordinary World save.
// It is kept in its own save slot (Career.save writes a game with a `scenario` to SCENARIO_SAVE_KEY), so starting
// a scenario never touches the player's own program.
//
//   SCENARIOS                      [{ id, name, world, worldName, situation, difficulty, start, goal, brief,
//                                     objectives: [{ id, text }], tips: [string] }]   (frozen, in menu order)
//   scenarioDef(id)                → the definition, or null
//   buildScenario(id)              → { scenario, career, world, vessel, vessels, craft, crew, site, start }
//       career   the Career to play (already holds flightState / saved design / assigned crew)
//       world    the World as it stands at the start (for 'builder' starts: null)
//       start    { screen: 'builder' | 'flight', params }  what to hand to app.goto()
//   scenarioStatus(career)         → { id, name, goal, objectives: [{ id, text, done }], done, total, complete } | null
//   checkScenario(career, world)   → objectives newly completed by the state of `world` (marks them in the career)
//   loadScenarioGame(storage)      → the Career in the scenario slot, or null;   hasScenarioGame(storage),
//   deleteScenarioGame(storage)
//
// How to add a scenario: see docs/SCENARIOS.md.
import { Vector3, Quaternion, Matrix4 } from '../lib/three.module.min.js';
import { SYSTEM } from './bodies.js';
import { World } from './world.js';
import { Craft, shearwaterShip, deepwell } from './craft.js';
import { partDef } from './parts.js';
import { surfaceAt } from './vessel.js';
import { Career, SCENARIO_SAVE_KEY } from './career.js';

export { SCENARIO_SAVE_KEY };
export const SCENARIO_QUICK_KEY = 'starwright.scenario.quicksave.v1';
// Mid-morning at the space centre (the same hour a new program opens at; see NEW_GAME_UT in js/main.js).
export const SCENARIO_UT = 16950;

const Y = new Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const body = id => SYSTEM.byId[id];

// ---------------------------------------------------------------------------------------------
// Placement helpers (the same moves World.launch and World.spawn make)
// ---------------------------------------------------------------------------------------------
/** Unit vector from a body toward the star, flattened into the plane of an equatorial orbit. */
export function sunward(b, ut, out = new Vector3()) {
  b.globalPosAt(ut, out).negate();
  out.y = 0;
  if (out.lengthSq() < 1e-9) out.set(1, 0, 0);
  return out.normalize();
}

/**
 * State for a prograde equatorial orbit. `phase` (rad) is measured from the sub-solar point in the direction of
 * travel. `pe` / `ap` are altitudes (m); the vessel starts at the periapsis unless `atAp` is set.
 * → { pos, vel, q } with the nose prograde (`retro` turns it round) and the craft's +Z away from the body.
 */
export function orbitState(b, { pe, ap = pe, phase = 0, atAp = false, retro = false } = {}, ut = 0) {
  const rp = b.radius + Math.min(pe, ap), ra = b.radius + Math.max(pe, ap);
  const a = (rp + ra) / 2, r = atAp ? ra : rp;
  const out = sunward(b, ut).applyAxisAngle(Y, phase);
  const pro = new Vector3().crossVectors(Y, out).normalize();
  const speed = Math.sqrt(b.gm * (2 / r - 1 / a));
  const pos = out.clone().multiplyScalar(r), vel = pro.clone().multiplyScalar(speed);
  return { pos, vel, q: attitude(retro ? pro.clone().negate() : pro, out) };
}

/** Attitude with the craft's nose (+Y) along `nose` and its +Z as close to `up` as that allows. */
function attitude(nose, up) {
  const y = nose.clone().normalize();
  const z = up.clone().addScaledVector(y, -up.dot(y));
  if (z.lengthSq() < 1e-9) z.set(y.y, y.z, y.x).addScaledVector(y, -(y.y * y.x + y.z * y.y + y.x * y.z));
  z.normalize();
  const x = new Vector3().crossVectors(y, z);
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

/**
 * State on an incoming hyperbola in the equatorial plane: `vInf` (m/s) far away, periapsis altitude `pe`, now at
 * distance `r` from the centre and falling in. `phase` turns the whole path about the pole (from the sub-solar point).
 */
export function arrivalState(b, { vInf, pe, r, phase = 0 } = {}, ut = 0) {
  const rp = b.radius + pe, gm = b.gm;
  const e = 1 + rp * vInf * vInf / gm, p = rp * (1 + e);
  const nu = -Math.acos(clamp((p / r - 1) / e, -1, 1));              // before periapsis
  const P = sunward(b, ut).applyAxisAngle(Y, phase), Q = new Vector3().crossVectors(Y, P).normalize();
  const k = Math.sqrt(gm / p);
  const pos = P.clone().multiplyScalar(r * Math.cos(nu)).addScaledVector(Q, r * Math.sin(nu));
  const vel = P.clone().multiplyScalar(-k * Math.sin(nu)).addScaledVector(Q, k * (e + Math.cos(nu)));
  // engine first: the nose points against the motion, ready for the capture burn
  return { pos, vel, q: attitude(vel.clone().negate(), pos), e, periapsisSpeed: Math.sqrt(vInf * vInf + 2 * gm / rp) };
}

/** Local slope (rise / run) of the ground over `span` metres. */
export function slopeAt(b, dir, span = 6) {
  const e = span / b.radius, d = dir.clone().normalize();
  const east = new Vector3().crossVectors(Y, d); if (east.lengthSq() < 1e-9) east.set(0, 0, -1); east.normalize();
  const north = new Vector3().crossVectors(d, east);
  const h0 = surfaceAt(b, d);
  let worst = 0;
  for (const [ax, s] of [[east, 1], [north, 1], [east, -1], [north, -1]]) {
    worst = Math.max(worst, Math.abs(surfaceAt(b, d.clone().addScaledVector(ax, e * s).normalize()) - h0));
  }
  return worst / span;
}

/** The flattest dry spot near a body-fixed direction (a fixed spiral search, so every run picks the same place). */
export function flatSpot(b, near, { reach = 30000, samples = 400, wide = 60 } = {}) {
  const base = near.clone().normalize();
  const east = new Vector3().crossVectors(Y, base); if (east.lengthSq() < 1e-9) east.set(0, 0, -1); east.normalize();
  const north = new Vector3().crossVectors(base, east);
  let best = base.clone(), bestScore = Infinity;
  for (let i = 0; i < samples; i++) {
    const ang = i * 2.399963, rad = Math.sqrt(i / samples) * reach / b.radius;
    const d = base.clone().addScaledVector(east, Math.cos(ang) * rad).addScaledVector(north, Math.sin(ang) * rad).normalize();
    if (b.ocean && typeof b.isWater === 'function' && b.isWater(d)) continue;
    const score = slopeAt(b, d, 6) + slopeAt(b, d, wide) * 1.5;
    if (score < bestScore) { bestScore = score; best = d; if (score < 0.008) break; }
  }
  return { dir: best, slope: bestScore };
}

/**
 * A place to drive: a start point and compass heading (degrees, 90 = east) from which the ground stays gentle for
 * `length` metres. Searches a fixed spiral of spots round `near` and eight headings from each, scoring a run by its
 * steepest stretch, so every call picks the same route. → { dir, heading, slope (worst rise / run on the way) }
 */
export function driveRoute(b, near, opts = {}) {
  // first among spots that are themselves level (a parked rover should stand square); any spot if there is none
  return routeSearch(b, near, { ...opts, startFlat: opts.startFlat ?? 0.08 }) || routeSearch(b, near, { ...opts, startFlat: 0.3 })
    || { dir: near.clone().normalize(), heading: 90, slope: slopeAt(b, near.clone().normalize(), 6) };
}
function routeSearch(b, near, { length = 1000, reach = 30000, samples = 120, step = 20, good = 0.05, startFlat = 0.08 } = {}) {
  const base = near.clone().normalize();
  const frame = d => { const east = new Vector3().crossVectors(Y, d); if (east.lengthSq() < 1e-9) east.set(0, 0, -1); east.normalize(); return { east, north: new Vector3().crossVectors(d, east) }; };
  const f0 = frame(base);
  let best = null;
  for (let i = 0; i < samples; i++) {
    const ang = i * 2.399963, rad = Math.sqrt(i / samples) * reach / b.radius;
    const d = base.clone().addScaledVector(f0.east, Math.cos(ang) * rad).addScaledVector(f0.north, Math.sin(ang) * rad).normalize();
    if (b.ocean && typeof b.isWater === 'function' && b.isWater(d)) continue;
    if (slopeAt(b, d, 6) > startFlat || slopeAt(b, d, 2) > startFlat) continue;
    const f = frame(d);
    for (let h = 0; h < 360; h += 45) {
      const along = f.north.clone().multiplyScalar(Math.cos(h * Math.PI / 180)).addScaledVector(f.east, Math.sin(h * Math.PI / 180));
      let worst = 0;
      const limit = () => (best ? best.slope : 1);
      for (let x = 0; x <= length + 40 && worst < limit(); x += step) {
        const q = d.clone().addScaledVector(along, x / b.radius).normalize();
        if (b.ocean && typeof b.isWater === 'function' && b.isWater(q)) { worst = 9; break; }
        worst = Math.max(worst, slopeAt(b, q, 6), slopeAt(b, q, step));
      }
      // then the fine grain: a pit a few metres across hides between those samples and swallows a rover whole
      if (worst < limit()) {
        const side = new Vector3().crossVectors(d, along).normalize(), fine = 2;
        for (const off of [0, -0.9, 0.9]) {
          let hPrev = null;
          for (let x = -4; x <= length + 20 && worst < limit(); x += fine) {
            const h = surfaceAt(b, d.clone().addScaledVector(along, x / b.radius).addScaledVector(side, off / b.radius).normalize());
            if (hPrev !== null) worst = Math.max(worst, Math.abs(h - hPrev) / fine);
            hPrev = h;
          }
        }
      }
      if (!best || worst < best.slope) best = { dir: d, heading: h, slope: worst };
    }
    if (best && best.slope <= good) break;
  }
  return best;
}

/** A body-fixed direction on the sunlit side: `lon` rad round the equator from the sub-solar point, `lat` rad north. */
function sunlitDir(b, ut, lon = -0.6, lat = 0.08) {
  const d = b.inertialToSurfaceDir(sunward(b, ut).applyAxisAngle(Y, lon), ut, new Vector3());
  const ll = b.latLon ? b.latLon(d) : null;
  if (ll && b.dirFromLatLon) return b.dirFromLatLon(lat, ll.lon);
  return d;
}

/**
 * Stand a craft on the ground of any body, at rest: upright on its legs (or its engine bell), or on its wheels
 * facing `heading` when `vehicle` is set. This is World.launch's placement: a kinematic surface anchor whose
 * height Vessel.syncLanded works out so the vessel's lowest point rests on the terrain.
 */
export function placeLanded(world, craft, b, dir, { crew = [], vehicle = false, heading = 90, makeActive = true } = {}) {
  const d = dir.clone().normalize();
  const up = b.surfaceDirToInertial(d, world.ut, new Vector3());
  const pos = up.multiplyScalar(b.radius + surfaceAt(b, d) + 5);
  const wy = TAU / b.rotPeriod;
  const v = world.spawn(craft, { crew, body: b, pos, vel: new Vector3(wy * pos.z, 0, -wy * pos.x), makeActive });
  if ((v.legParts || []).length) v.setLegs(true);
  if (vehicle && v.hasGear) v.setGear(true);
  v.landed = true; v.splashed = false;
  // a vehicle stands square on the ground it is on (the terrain normal over its wheelbase), not level across a
  // slope with one side of its wheels buried
  const tilt = vehicle && typeof b.terrainNormal === 'function' ? b.terrainNormal(d, new Vector3(), 1) : d;
  v.surface = { dir: d.clone(), qRel: vehicle ? World.vehicleFrame(tilt, heading) : World.padFrame(d), h: 0, qTarget: null, vehicle: !!vehicle };
  if (vehicle) v.ctrl.brake = true;
  v.situation = 'landed';
  v.ctrl.sas = true; v.ctrl.throttle = 0;
  v.syncLanded(world.ut);
  v.updateTelemetry(world.ut);
  return v;
}

/** Height of a landed vessel's lowest point above the terrain under it (m): 0 when it stands on the ground. */
export function groundClearance(v) {
  if (!v || !v.surface) return NaN;
  const b = v.body, s = v.surface;
  const upLocal = s.dir.clone().applyQuaternion(s.qRel.clone().invert());
  return v.pos.length() - b.radius + v._lowest(upLocal).h - surfaceAt(b, s.dir);
}

/** Leave only `frac` (0..1) of the propellant in every tank of the given part types (default: all liquid tanks). */
function setFuel(v, frac, types = null) {
  for (const p of v.partList) {
    if (types && !types.includes(p.type)) continue;
    if (p.def.engine && p.def.engine.type === 'solid') continue;
    for (const k of ['fuel', 'lox', 'ch4']) if (p.res && p.res[k] > 0) p.res[k] = (p.def.res[k] || p.res[k]) * frac;
  }
  v._updateMass(false);
  v.updateResources();
  v.estimateDeltaV();
}

/** In-flight trim: engines of the first stage are live (throttle closed), solar panels out, SAS on. */
function readyInSpace(v, { ignite = true, solar = true } = {}) {
  v.ctrl.throttle = 0; v.ctrl.sas = true;
  if (ignite && v.stages.length && v.stageIndex === 0) {
    const first = v.stages[0].map(id => v.parts.get(id)).filter(Boolean);
    if (first.length && first.every(p => p.def.engine && p.def.engine.type !== 'solid')) v.activateNextStage();
  }
  v.ctrl.throttle = 0;
  if (solar && typeof v.setSolar === 'function') v.setSolar(true);
  v.estimateDeltaV();
  return v;
}

// ---------------------------------------------------------------------------------------------
// The craft (all from the part catalog; names are Starwright's own)
// ---------------------------------------------------------------------------------------------
function stackDown(craft, from, types) {
  const made = [];
  let cur = from;
  for (const t of types) {
    const [p] = craft.attachStack(t, cur.id, 'bottom');
    if (!p) throw new Error(`scenario craft ${craft.name}: cannot attach ${t}`);
    made.push(p); cur = p;
  }
  return made;
}
const bottomY = p => p.pos.y - partDef(p.type).h / 2;
const DOWN = Math.PI / 2, UP = -Math.PI / 2;

/**
 * Larkspur: a one-seat orbiter. Capsule with heat shield and parachute, a Sparrow service stage with solar foils,
 * and (with `launcher`) a Goshawk first stage. `capsuleOnly` is what is left for the ride home.
 */
function larkspur({ launcher = true, capsuleOnly = false } = {}) {
  const c = new Craft(capsuleOnly ? 'Larkspur Capsule' : 'Larkspur');
  const [pod] = c.setRoot('pod_acorn');
  c.attachStack('chute', pod.id, 'top');
  const [shield] = stackDown(c, pod, ['heatshield_m']);
  if (!capsuleOnly) {
    const [, tank] = stackDown(c, shield, ['dec_m', 'tank_m400', 'eng_sparrow']);
    c.attachRadial('solar', tank.id, tank.pos.y + 0.4, 0, 2);
    c.attachRadial('antenna', tank.id, tank.pos.y + 0.9, Math.PI / 2, 1);
    c.attachRadial('sci_thermo', tank.id, tank.pos.y + 0.5, -Math.PI / 2, 1);
    if (launcher) {
      const eng = c.parts.find(p => p.type === 'eng_sparrow');
      const low = stackDown(c, eng, ['dec_m', 'tank_m800', 'tank_m400', 'eng_goshawk']);
      c.attachRadial('fin', low[2].id, bottomY(low[2]) + 0.5, Math.PI / 4, 4);
    }
  }
  c.autoStage();
  c.desc = capsuleOnly ? 'The Larkspur capsule on its own: heat shield below, parachute above.'
    : 'One seat, two stages. The Goshawk lifts it out of the air, the Sparrow makes the orbit and brings it home.';
  return c;
}

/** Pipsqueak: a capsule on a Maul solid booster. Up past the edge of the air and straight back down. */
function pipsqueak() {
  const c = new Craft('Pipsqueak');
  const [pod] = c.setRoot('pod_acorn');
  c.attachStack('chute', pod.id, 'top');
  const s = stackDown(c, pod, ['heatshield_m', 'dec_m', 'srb_maul']);
  c.attachRadial('fin', s[2].id, bottomY(s[2]) + 0.5, Math.PI / 4, 4);
  c.attachRadial('sci_baro', pod.id, pod.pos.y - 0.2, Math.PI / 2, 1);
  c.autoStage();
  c.desc = 'A capsule on one Maul solid booster. No throttle, no steering to speak of: light it and hold on.';
  return c;
}

/**
 * Pellfarer: a one-seat Pell lander. `launcher` adds the Condor lifter, `transfer` the Sparrow stage that carries the
 * lander to Pell. The lander itself (legs, ladder, instruments, heat shield and parachute) flies home on its own.
 */
function pellfarer({ launcher = true, transfer = true } = {}) {
  const c = new Craft('Pellfarer');
  const [pod] = c.setRoot('pod_acorn');
  c.attachStack('chute', pod.id, 'top');
  const s = stackDown(c, pod, ['heatshield_m', 'dec_m', 'battery', 'tank_m400', 'eng_sparrow']);
  const tank = s[3], eng = s[4];
  c.attachRadial('legs', tank.id, bottomY(tank), Math.PI / 4, 4);
  c.attachRadial('solar', tank.id, tank.pos.y + 1.2, 0, 2);
  c.attachRadial('sci_thermo', tank.id, tank.pos.y + 1.2, Math.PI / 2, 1);
  c.attachRadial('sci_seis', tank.id, tank.pos.y + 0.6, Math.PI / 2, 1);
  c.attachRadial('antenna', tank.id, tank.pos.y + 1.2, -Math.PI / 2, 1);
  let last = eng;
  if (transfer) last = stackDown(c, last, ['dec_m', 'tank_m800', 'eng_sparrow'])[2];
  if (launcher) {
    const low = stackDown(c, last, ['dec_m', 'adapter_lm', 'tank_l3200', 'tank_l3200', 'eng_condor']);
    c.attachRadial('fin_ctrl', low[3].id, bottomY(low[3]) + 0.5, Math.PI / 4, 4);
  }
  c.autoStage();
  c.desc = 'Three stages for Pell: a Condor lifter, a Sparrow transfer stage, and a lander with legs that also flies home.';
  return c;
}

/**
 * Wayfarer: the heavy ship for other planets. A three-seat lander (Osprey engine, wide legs, ladder), a Furnace
 * atomic stage for the crossing and the capture, and (with `launcher`) a Roc core with two Anvil boosters.
 */
function wayfarer({ launcher = true, transfer = true } = {}) {
  const c = new Craft('Wayfarer');
  const [pod] = c.setRoot('pod_hearth');
  c.attachStack('dock_m', pod.id, 'top');
  const s = stackDown(c, pod, ['battery_l', 'tank_l1600', 'tank_l800', 'eng_osprey']);
  const t1 = s[1], t2 = s[2];
  c.attachRadial('leg_stilt', t2.id, bottomY(t2) + 0.3, Math.PI / 4, 4);
  c.attachRadial('solar_wing', t1.id, t1.pos.y + 1.2, Math.PI / 2, 2);
  c.attachRadial('antenna_saucer', t1.id, t1.pos.y + 1.2, Math.PI, 1);
  for (let y = bottomY(t2) - 0.5; y < t1.pos.y + 1.9; y += 1.2) c.attachRadial('ladder_rung', y < bottomY(t1) ? t2.id : t1.id, y, 0, 1);
  c.attachRadial('light_glare', t2.id, t2.pos.y + 0.5, Math.PI, 1);
  c.attachRadial('sci_grav', t1.id, t1.pos.y - 1, Math.PI, 1);
  c.attachRadial('sci_seis', t1.id, t1.pos.y - 1.4, Math.PI, 1);
  let last = s[3];
  if (transfer) last = stackDown(c, last, ['dec_l', 'tank_l3200', 'eng_furnace'])[2];
  if (launcher) {
    const low = stackDown(c, last, ['dec_l', 'adapter_xll', 'tank_xl7200', 'tank_xl7200', 'tank_xl3600', 'eng_roc']);
    const tank = low[4], roc = low[5];
    const clamps = c.attachRadial('dec_radial_l', tank.id, tank.pos.y - 0.5, 0, 2);
    const boosters = c.attachOuter('srb_anvil', clamps[0].id);
    c.attachStack('nose_l', boosters[0].id, 'top');
    c.attachRadial('fin_broad', tank.id, bottomY(tank) + 0.9, Math.PI / 2, 2);
    c.autoStage();
    // boosters and the core light together; the clamps get a stage of their own
    c.moveToStage(roc.id, 0);
    for (const b of boosters) c.moveToStage(b.id, 0);
    for (const k of clamps) c.moveToStage(k.id, 1);
    c.removeEmptyStages();
  } else c.autoStage();
  c.desc = 'A Roc core and two Anvil boosters to orbit, a Furnace atomic stage for the crossing, and a three-seat lander.';
  return c;
}

/**
 * Tern: a one-seat ferry made to dock. Latch Ring S on the nose (the parachutes ride on the capsule's flanks),
 * monopropellant and four thruster blocks. `launcher` adds the Goshawk core with two Ember boosters.
 */
function tern({ launcher = true } = {}) {
  const c = new Craft('Tern');
  const [pod] = c.setRoot('pod_acorn');
  c.attachStack('dock_s', pod.id, 'top');
  c.attachRadial('chute_radial', pod.id, pod.pos.y + 0.1, 0, 2);
  const s = stackDown(c, pod, ['heatshield_m', 'dec_m', 'tank_mono', 'tank_m400', 'eng_sparrow']);
  const svc = s[3];
  c.attachRadial('rcs', svc.id, svc.pos.y + 1.0, Math.PI / 4, 4);
  c.attachRadial('solar', svc.id, svc.pos.y - 0.9, Math.PI / 2, 2);
  c.attachRadial('light_glim', svc.id, svc.pos.y + 0.4, 0, 1);
  if (launcher) {
    const low = stackDown(c, s[4], ['dec_m', 'tank_m800', 'tank_m800', 'eng_goshawk']);
    const tank = low[2], core = low[3];
    const clamps = c.attachRadial('dec_radial', tank.id, tank.pos.y - 1.5, 0, 2);
    const boosters = c.attachOuter('srb_ember', clamps[0].id);
    c.attachStack('nose_m', boosters[0].id, 'top');
    c.attachRadial('fin', tank.id, bottomY(tank) + 0.5, Math.PI / 2, 2);
    c.autoStage();
    c.moveToStage(core.id, 0);
    for (const b of boosters) c.moveToStage(b.id, 0);
    for (const k of clamps) c.moveToStage(k.id, 1);
    c.removeEmptyStages();
  } else c.autoStage();
  c.desc = 'A ferry with a Latch Ring on its nose and thrusters for close work. Built to meet Hollin Station.';
  return c;
}

/** Hollin Station: an uncrewed core with a Latch Ring S on the nose, a gyro, a fuel store, power and a dish. */
function hollin() {
  const c = new Craft('Hollin Station');
  const [core] = c.setRoot('probe_wisp');
  const [ad] = c.attachStack('adapter_ms', core.id, 'top');
  c.attachStack('dock_s', ad.id, 'top');
  const s = stackDown(c, core, ['battery', 'gyro', 'tank_mono', 'tank_m800', 'truss_m']);
  const tank = s[3];
  c.attachRadial('solar_wing', tank.id, tank.pos.y + 0.6, 0, 2);
  c.attachRadial('antenna_saucer', tank.id, tank.pos.y - 0.4, Math.PI / 2, 1);
  c.attachRadial('rcs', s[2].id, s[2].pos.y, Math.PI / 4, 4);
  c.attachRadial('light_glare', tank.id, tank.pos.y + 1.2, -Math.PI / 2, 1);
  c.autoStage();
  c.desc = 'A small station core: Latch Ring on the nose, a gyro, a fuel store and wide solar wings.';
  return c;
}

/** Ostrider: a squat two-seat lander for small moons (side-mounted Hornets, four legs, a ladder to the ground). */
function ostrider() {
  const c = new Craft('Ostrider');
  const [pod] = c.setRoot('pod_burrow');
  c.attachStack('dock_m', pod.id, 'top');
  const [, mono, tank] = stackDown(c, pod, ['battery', 'tank_mono', 'tank_m400']);
  const engines = c.attachRadial('eng_hornet', tank.id, bottomY(tank) + 0.55, Math.PI / 2, 2);
  c.attachRadial('legs', tank.id, bottomY(tank) + 0.1, Math.PI / 4, 4);
  for (let y = bottomY(tank) + 0.5; y < tank.pos.y + 1.9; y += 1.2) c.attachRadial('ladder_rung', tank.id, y, 0, 1);
  c.attachRadial('rcs', mono.id, mono.pos.y, Math.PI / 4, 4);
  c.attachRadial('solar_tile', pod.id, pod.pos.y, Math.PI / 2, 2);
  c.attachRadial('antenna', pod.id, pod.pos.y, Math.PI, 1);
  const lamps = c.attachRadial('light_glim', tank.id, tank.pos.y + 1.5, Math.PI, 1);
  c.attachRadial('sci_seis', tank.id, tank.pos.y + 0.6, Math.PI, 1);
  c.attachRadial('sci_grav', tank.id, tank.pos.y + 0.2, Math.PI, 1);
  c.autoStage();
  for (const e of engines) c.setAction('abort', e.id, 'shutdownEngine', false);
  for (const l of lamps) c.setAction('lights', l.id, 'toggleLight', false);
  c.desc = 'A two-seat lander for small moons: two Hornets on its flanks, four legs and a ladder.';
  return c;
}

/** Pebble: a six-wheeled rover (built nose-forward along +Y, wheels on the −Z side; an isotope cell rides on its back). */
function pebble() {
  const c = new Craft('Pebble');
  const [chassis] = c.setRoot('rover_trundle');
  for (const dy of [0.62, 0, -0.62]) {
    c.attachRadial('wheel_scamper', chassis.id, chassis.pos.y + dy, DOWN - 1.0, 1);
    c.attachRadial('wheel_scamper', chassis.id, chassis.pos.y + dy, DOWN + 1.0, 1);
  }
  for (const [dy, da] of [[0.4, -0.35], [0.4, 0.35], [-0.4, -0.35], [-0.4, 0.35]]) c.attachRadial('solar_tile', chassis.id, chassis.pos.y + dy, UP + da, 1);
  // power for a long drive under cloud: three cell bricks and an isotope cell that never runs down
  for (const dy of [0.6, 0.35, 0.1]) c.attachRadial('battery_brick', chassis.id, chassis.pos.y + dy, UP, 1);
  c.attachRadial('gen_glowworm', chassis.id, chassis.pos.y - 0.2, UP, 1);
  c.attachRadial('antenna', chassis.id, chassis.pos.y - 0.6, UP, 1);
  const lamps = c.attachRadial('light_glim', chassis.id, chassis.pos.y + 0.75, UP - 0.9, 1).concat(c.attachRadial('light_glim', chassis.id, chassis.pos.y + 0.75, UP + 0.9, 1));
  c.attachRadial('sci_seis', chassis.id, chassis.pos.y - 0.1, 0, 1);
  c.attachRadial('sci_grav', chassis.id, chassis.pos.y - 0.1, Math.PI, 1);
  c.autoStage();
  for (const l of lamps) c.setAction('lights', l.id, 'toggleLight', false);
  c.site = 'runway';
  c.desc = 'A six-wheeled rover. W/S drive, A/D steer, B brakes, U lights.';
  return c;
}

/** The scenario designs by name (fresh Craft objects every call). */
export const SCENARIO_CRAFT = Object.freeze({
  'Larkspur': () => larkspur(),
  'Pipsqueak': () => pipsqueak(),
  'Pellfarer': () => pellfarer(),
  'Wayfarer': () => wayfarer(),
  'Tern': () => tern(),
  'Hollin Station': () => hollin(),
  'Ostrider': () => ostrider(),
  'Pebble': () => pebble(),
  'Larkspur (orbital stage)': () => larkspur({ launcher: false }),
  'Larkspur Capsule': () => larkspur({ capsuleOnly: true }),
  'Pellfarer (transfer stage and lander)': () => pellfarer({ launcher: false }),
  'Pellfarer (lander)': () => pellfarer({ launcher: false, transfer: false }),
  'Wayfarer (atomic stage and lander)': () => wayfarer({ launcher: false }),
  'Wayfarer (lander)': () => wayfarer({ launcher: false, transfer: false }),
  'Tern (orbital stage)': () => tern({ launcher: false }),
});

// ---------------------------------------------------------------------------------------------
// Delta-v book-keeping (what each goal costs; the unit tests hold every scenario to it)
// ---------------------------------------------------------------------------------------------
const circ = (b, alt) => Math.sqrt(b.gm / (b.radius + alt));
/** Vacuum delta-v to reach a low orbit from the ground: orbital speed plus gravity (and, with air, drag) losses. */
export function ascentDv(b) {
  const alt = b.atmo ? b.atmo.height + 10000 : Math.max(10000, (b.maxElevation || 0) + 3000);
  return circ(b, alt) * (b.atmo ? 1.42 : 1.25) + (b.atmo ? 150 : 40);
}
/** Vacuum delta-v for a powered landing from a low orbit of an airless world. */
export function landingDv(b, alt) { return circ(b, alt) * 1.3 + 60; }
/** Burn that takes a circular orbit at `alt` of body b out to (or in from) radius `rFar`. */
function hohmannDv(b, alt, rFar) {
  const r = b.radius + alt, a = (r + rFar) / 2;
  return Math.abs(Math.sqrt(b.gm * (2 / r - 1 / a)) - Math.sqrt(b.gm / r));
}
/** Speed relative to the destination planet at the end of a Hohmann transfer between two planets' orbits. */
export function arrivalVInf(from, to) {
  const gm = SYSTEM.star.gm, r1 = from.orbit.a, r2 = to.orbit.a, a = (r1 + r2) / 2;
  return Math.abs(Math.sqrt(gm / r2) - Math.sqrt(gm * (2 / r2 - 1 / a)));
}
export function departureVInf(from, to) {
  const gm = SYSTEM.star.gm, r1 = from.orbit.a, r2 = to.orbit.a, a = (r1 + r2) / 2;
  return Math.abs(Math.sqrt(gm * (2 / r1 - 1 / a)) - Math.sqrt(gm / r1));
}
/** Burn at a periapsis of altitude `pe` that turns an arrival at `vInf` into an ellipse reaching out to `rAp`. */
export function captureDv(b, vInf, pe, rAp = b.soi * 0.5) {
  const rp = b.radius + pe, a = (rp + rAp) / 2;
  return Math.sqrt(vInf * vInf + 2 * b.gm / rp) - Math.sqrt(b.gm * (2 / rp - 1 / a));
}
export function ejectionDv(b, vInf, alt) {
  const r = b.radius + alt;
  return Math.sqrt(vInf * vInf + 2 * b.gm / r) - Math.sqrt(b.gm / r);
}

// ---------------------------------------------------------------------------------------------
// Objectives (pure tests on the World; an objective stays done once met, and they are met in order)
// ---------------------------------------------------------------------------------------------
const ships = w => (w ? w.vessels.filter(v => !v.dead && v.type === 'ship') : []);
// the player's own flight: ships with a crew aboard (a station or a parked rover does not meet a flying objective)
const crewed = w => ships(w).filter(v => v.crew.length > 0);
const altOf = v => v.pos.length() - v.body.radius;
/** Is the vessel in a closed orbit of body `id` that clears the air and the mountains (and `minAlt`)? */
export function inStableOrbit(v, id, minAlt = 0, ut = 0) {
  if (!v || v.dead || v.landed || v.body.id !== id) return false;
  let o = null;
  try { o = v.getOrbit(ut); } catch { o = null; }
  if (!o || o.hyper || !(o.e < 1)) return false;
  const b = v.body, floor = Math.max(minAlt, b.atmo ? b.atmo.height : (b.maxElevation || 0) + 500);
  return o.periapsis - b.radius >= floor && o.apoapsis < b.soi;
}
const T = {
  orbit: (id, minAlt = 0) => w => crewed(w).some(v => inStableOrbit(v, id, minAlt, w.ut)),
  landed: id => w => crewed(w).some(v => v.body.id === id && (v.landed || v.splashed || (v.grounded && v.groundSpeed < 0.5)) && v.launched !== false && v.situation !== 'prelaunch'),
  home: () => w => crewed(w).some(v => v.body === SYSTEM.home && (v.landed || v.splashed) && v.situation !== 'prelaunch' && v.crew.length > 0),
  above: (id, alt) => w => crewed(w).some(v => v.body.id === id && !v.landed && altOf(v) >= alt),
  off: id => w => crewed(w).some(v => v.crew.length > 0 && (v.body.id !== id || (!v.landed && !v.grounded && altOf(v) - surfaceAt(v.body, v.body.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut, new Vector3())) > 1000))),
  soi: id => w => crewed(w).some(v => v.body.id === id && v.crew.length > 0),
  docked: () => w => ships(w).some(v => (v.dockedPairs || []).length > 0),
  near: (name, dist) => w => { const a = w.active, t = w.vessels.find(v => v.name === name && !v.dead); return !!(a && t && a !== t && a.body === t.body && a.pos.distanceTo(t.pos) <= dist); },
  eva: () => w => w.vessels.some(v => !v.dead && v.type === 'eva'),
  flag: id => w => (w.flags || []).some(f => f.bodyId === id),
  drove: (name, dist) => (w, sc) => {
    const v = w.vessels.find(x => x.name === name && !x.dead), from = sc && sc.marks && sc.marks[name];
    if (!v || !from) return false;
    const d = v.body.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut, new Vector3());
    return Math.acos(clamp(d.x * from.x + d.y * from.y + d.z * from.z, -1, 1)) * v.body.radius >= dist;
  },
};

// ---------------------------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------------------------
const pellSpot = ut => flatSpot(body('pell'), sunlitDir(body('pell'), ut, -0.7, 0.1), { reach: 40000 });
const ostSpot = ut => flatSpot(body('ost'), sunlitDir(body('ost'), ut, -0.7, 0.12), { reach: 12000 });

const DEFS = [
  {
    id: 'first-orbit', name: 'First Orbit', world: 'verda', situation: 'In the assembly building', difficulty: 'Easy', start: 'builder',
    goal: 'Fly the Larkspur into orbit of Verda and bring Juno home.',
    brief: 'The Larkspur is finished and checked. Look it over, change what you like, then roll it out to the pad.',
    tips: ['Start tipping east at about 1 km and keep the nose just ahead of the velocity marker.', 'Stage the Goshawk away when it runs dry; the Sparrow makes the orbit.', 'To come home, burn backwards on the far side of Verda and keep the heat shield forward.'],
    objectives: [
      { id: 'space', text: 'Climb above the air (72 km)', test: T.above('verda', 72000) },
      { id: 'orbit', text: 'Reach a closed orbit above the air', test: T.orbit('verda') },
      { id: 'home', text: 'Land or splash down on Verda', test: T.home() },
    ],
    build(ctx) { return ctx.hangar(larkspur(), ['Juno']); },
  },
  {
    id: 'pell-expedition', name: 'Pell Expedition', world: 'verda', situation: 'In the assembly building', difficulty: 'Medium', start: 'builder',
    goal: 'Take the Pellfarer to Pell, land, and come home.',
    brief: 'Three stages stand in the hall: a Condor lifter, a Sparrow transfer stage and a lander with legs. It has the fuel for the whole trip if you fly it cleanly.',
    tips: ['From low orbit, plan the transfer in the map (M) so your path meets Pell.', 'Brake into a low orbit of Pell first, then come down with the legs out (G).', 'The lander alone has what it needs to climb back and fall home to Verda.'],
    objectives: [
      { id: 'orbit', text: 'Reach orbit of Verda', test: T.orbit('verda') },
      { id: 'pell', text: "Enter Pell's sphere of influence", test: T.soi('pell') },
      { id: 'land', text: 'Land on Pell', test: T.landed('pell') },
      { id: 'home', text: 'Land or splash down on Verda', test: T.home() },
    ],
    build(ctx) { return ctx.hangar(pellfarer(), ['Juno']); },
  },
  {
    id: 'long-haul', name: 'The Long Haul', world: 'verda', situation: 'In the assembly building', difficulty: 'Hard', start: 'builder',
    goal: 'Launch the Wayfarer and put it in orbit of Rusk.',
    brief: 'The heaviest ship the hall can hold: a Roc core, two Anvil boosters, a Furnace atomic stage and a three-seat lander. Rusk is half a year away.',
    tips: ['Reach a low orbit of Verda on the core, then open the Autopilot panel for a transfer to Rusk.', 'The Furnace is weak but thrifty: start long burns early.', 'Capture at the closest point to Rusk; its thin air can help you brake.'],
    objectives: [
      { id: 'orbit', text: 'Reach orbit of Verda', test: T.orbit('verda') },
      { id: 'away', text: "Leave Verda's sphere of influence", test: T.soi('helion') },
      { id: 'rusk', text: "Enter Rusk's sphere of influence", test: T.soi('rusk') },
      { id: 'capture', text: 'Close the path into an orbit of Rusk', test: T.orbit('rusk') },
    ],
    build(ctx) { return ctx.hangar(wayfarer(), ['Oskar', 'Bram', 'Tilly']); },
  },
  {
    id: 'pad-hop', name: 'Light the Candle', world: 'verda', situation: 'On the launch pad', difficulty: 'Easy', start: 'launch',
    goal: 'Ride the Pipsqueak past the edge of space and land safely.',
    brief: 'Juno is strapped in on top of one Maul solid booster. There is no throttle. Space lights it.',
    tips: ['Space fires the booster. Leave SAS on and let it climb straight up.', 'When the booster is spent, Space again drops it.', 'Falling back, keep the heat shield down; the last Space arms the parachute.'],
    objectives: [
      { id: 'space', text: 'Climb above the air (72 km)', test: T.above('verda', 72000) },
      { id: 'home', text: 'Land or splash down on Verda', test: T.home() },
    ],
    build(ctx) { return ctx.pad(pipsqueak(), ['Juno']); },
  },
  {
    id: 'station-run', name: 'Station Run', world: 'verda', situation: 'On the launch pad', difficulty: 'Hard', start: 'launch',
    goal: 'Launch the Tern, catch Hollin Station and dock with it.',
    brief: 'Hollin Station is circling 150 km up, and the Tern is fuelled on the pad below it. Everything between here and its Latch Ring is yours to fly.',
    tips: ['Reach a low orbit first (the Autopilot panel has an ascent program).', 'Select Hollin Station in the map and set it as target, then plan the meeting.', 'Inside a few hundred metres switch on RCS (R) and creep in nose first, under 1 m/s.'],
    objectives: [
      { id: 'orbit', text: 'Reach orbit of Verda', test: T.orbit('verda') },
      { id: 'near', text: 'Come within 1 km of Hollin Station', test: T.near('Hollin Station', 1000) },
      { id: 'dock', text: 'Dock with Hollin Station', test: T.docked() },
    ],
    build(ctx) {
      const b = body('verda');
      const st = orbitState(b, { pe: 150000, phase: 2.4 }, ctx.world.ut);
      const station = ctx.world.spawn(hollin(), { body: b, pos: st.pos, vel: st.vel, q: st.q, makeActive: false });
      readyInSpace(station, { ignite: false });
      return ctx.pad(tern(), ['Juno']);
    },
  },
  {
    id: 'morning-orbit', name: 'Morning Orbit', world: 'verda', situation: 'In low orbit', difficulty: 'Easy', start: 'flight',
    goal: 'Raise the Larkspur from 95 km to an orbit above 200 km.',
    brief: 'Juno is already up: 95 km above Verda in the Larkspur, engine live, most of a tank left. A good place to learn maneuver nodes.',
    tips: ['Open the map (M), click your orbit and add a maneuver: pull the prograde handle until the far side reaches 200 km.', 'Burn at the node, coast half an orbit, then burn prograde again to lift the low side.', 'Z is full throttle, X cuts it. T toggles SAS.'],
    objectives: [
      { id: 'ap', text: 'Raise the high point above 200 km', test: w => crewed(w).some(v => { const o = v.body.id === 'verda' && !v.landed && v.getOrbit(w.ut); return !!o && !o.hyper && o.apoapsis - v.body.radius >= 200000; }) },
      { id: 'orbit', text: 'Lift the low point above 200 km too', test: T.orbit('verda', 200000) },
    ],
    build(ctx) {
      const b = body('verda');
      const st = orbitState(b, { pe: 95000, phase: -1.0 }, ctx.world.ut);
      const v = ctx.world.spawn(larkspur({ launcher: false }), { crew: ['Juno'], body: b, pos: st.pos, vel: st.vel, q: st.q });
      setFuel(v, 0.8);
      return readyInSpace(v);
    },
  },
  {
    id: 'hollin-approach', name: 'Hollin Approach', world: 'verda', situation: 'In orbit beside a station', difficulty: 'Medium', start: 'flight',
    goal: 'Dock the Tern with Hollin Station, 120 m ahead.',
    brief: 'The hard part is done: the Tern is holding 120 m off Hollin Station, nose toward its Latch Ring, both 150 km up.',
    tips: ['RCS is on. H/N push forward and back, I/K slide up and down, J/L slide left and right.', 'Keep the closing speed under 1 m/s and the rings lined up; the latches pull you in over the last half metre.', 'The station is already your target: the navball shows where it is.'],
    objectives: [
      { id: 'close', text: 'Close to within 25 m', test: T.near('Hollin Station', 25) },
      { id: 'dock', text: 'Dock with Hollin Station', test: T.docked() },
    ],
    build(ctx) {
      const b = body('verda'), w = ctx.world;
      const st = orbitState(b, { pe: 150000, phase: -0.6 }, w.ut);
      const station = w.spawn(hollin(), { body: b, pos: st.pos, vel: st.vel, q: st.q, makeActive: false });
      readyInSpace(station, { ignite: false });
      const pro = st.vel.clone().normalize(), out = st.pos.clone().normalize();
      const pos = st.pos.clone().addScaledVector(pro, 120).addScaledVector(out, 8);
      const v = w.spawn(tern({ launcher: false }), { crew: ['Juno'], body: b, pos, vel: st.vel.clone(), q: attitude(pro.clone().negate(), out) });
      setFuel(v, 0.6);
      readyInSpace(v);
      w.switchTo(v);
      w.setTarget(v, station);
      v.ctrl.rcs = true;
      return v;
    },
  },
  {
    id: 'topping-up', name: 'Topping Up', world: 'verda', situation: 'In orbit beside a propellant depot', difficulty: 'Medium', start: 'flight',
    goal: 'Dock Shearwater side by side with the depot Deepwell, fill its tanks, and let go.',
    brief: 'Shearwater reached orbit with its tanks 41 % full, which is not enough to go anywhere. The depot Deepwell is 150 m away with 400 tonnes of liquid oxygen and methane aboard. Its Flank Port is on its side, and so is yours.',
    tips: ['Open the Dock panel and start the docking assist: it turns the ship so the two Flank Ports face each other with the hulls parallel, then closes at walking pace.', 'Once docked, open the Fuel panel and pump from the depot. Liquid in free fall floats about in its tank, so the pump fires the thrusters gently along the stack to hold it on the outlet. That push is real: watch the orbit creep.', 'Ninety-four tonnes cross in a little over five minutes. Physics warp (.) makes that shorter.', 'By hand: RCS is on. H/N push forward and back, I/K up and down, J/L left and right. Under 1 m/s, hulls parallel.'],
    objectives: [
      { id: 'dock', text: 'Dock with Deepwell', test: T.docked() },
      { id: 'fill', text: "Fill Shearwater's tanks to 95 %", test: w => ships(w).some(v => { const t = v.partList.find(p => p.type === 'tank_xxl_ship'); return !!t && (t.res.lox + t.res.ch4) >= 0.95 * (t.def.res.lox + t.def.res.ch4); }) },
      { id: 'undock', text: 'Undock, with the tanks still full', test: w => ships(w).some(v => { const t = v.partList.find(p => p.type === 'tank_xxl_ship'); return !!t && v.crew.length > 0 && !(v.dockedPairs || []).length && (t.res.lox + t.res.ch4) >= 0.95 * (t.def.res.lox + t.def.res.ch4); }) },
    ],
    build(ctx) {
      const b = body('verda'), w = ctx.world;
      const st = orbitState(b, { pe: 100000, phase: -0.6 }, w.ut);
      const pro = st.vel.clone().normalize(), out = st.pos.clone().normalize();
      const depot = w.spawn(deepwell(), { body: b, pos: st.pos, vel: st.vel, q: attitude(pro, out), makeActive: false });
      readyInSpace(depot, { ignite: false });
      depot.ctrl.rcs = true;
      const pos = st.pos.clone().addScaledVector(pro, -150).addScaledVector(out, 12);
      const v = w.spawn(shearwaterShip(), { crew: ['Juno', 'Bram'], body: b, pos, vel: st.vel.clone(), q: attitude(out, pro) });
      setFuel(v, 0.41);
      readyInSpace(v);
      w.switchTo(v);
      w.setTarget(v, depot);
      v.ctrl.rcs = true;
      return v;
    },
  },
  {
    id: 'pell-descent', name: 'Above Pell', world: 'pell', situation: 'In orbit of Pell', difficulty: 'Medium', start: 'flight',
    goal: 'Take the Pellfarer down from a 30 km orbit and land on Pell.',
    brief: 'The Pellfarer circles Pell at 30 km with its transfer stage still attached and a third full. The grey plains are below.',
    tips: ['Burn backwards to drop the low point to the ground, using the transfer stage first; Space drops it when it is dry.', 'Legs out with G. Kill the sideways speed, then the fall: aim to touch down under 4 m/s.', 'The Autopilot panel can fly the landing if you want to watch one first.'],
    objectives: [
      { id: 'low', text: 'Descend below 5 km', test: w => ships(w).some(v => v.body.id === 'pell' && v.crew.length && altOf(v) < 5000 + surfaceAt(v.body, v.body.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut, new Vector3()))) },
      { id: 'land', text: 'Land on Pell', test: T.landed('pell') },
    ],
    build(ctx) {
      const b = body('pell');
      const st = orbitState(b, { pe: 30000, phase: -1.3, retro: true }, ctx.world.ut);
      const v = ctx.world.spawn(pellfarer({ launcher: false }), { crew: ['Juno'], body: b, pos: st.pos, vel: st.vel, q: st.q });
      setFuel(v, 0.35, ['tank_m800']);
      return readyInSpace(v);
    },
  },
  {
    id: 'pell-homecoming', name: 'Pell Homecoming', world: 'pell', situation: 'Landed on Pell', difficulty: 'Medium', start: 'flight',
    goal: 'Lift off from Pell and bring Juno home to Verda.',
    brief: 'The Pellfarer stands on its legs on Pell with three quarters of a tank. Verda hangs in the black sky. Time to go home.',
    tips: ['Lift off, tip east and reach a low orbit of Pell.', 'Leave Pell against its motion round Verda so your path falls back to the planet (the Autopilot panel has a return program).', 'Aim the low point at about 35 km over Verda, drop the engine before the air, heat shield first.'],
    objectives: [
      { id: 'up', text: 'Lift off from Pell', test: T.off('pell') },
      { id: 'verda', text: "Leave Pell for Verda's sphere of influence", test: T.soi('verda') },
      { id: 'home', text: 'Land or splash down on Verda', test: T.home() },
    ],
    build(ctx) {
      const v = placeLanded(ctx.world, pellfarer({ launcher: false, transfer: false }), body('pell'), pellSpot(ctx.world.ut).dir, { crew: ['Juno'] });
      setFuel(v, 0.75);
      readyInSpace(v);
      v.syncLanded(ctx.world.ut); v.updateTelemetry(ctx.world.ut);
      return v;
    },
  },
  {
    id: 'ost-outpost', name: 'Ost Outpost', world: 'ost', situation: 'Landed on Ost', difficulty: 'Easy', start: 'flight',
    goal: 'Send a Pip out to plant a flag on Ost, then fly the Ostrider back up to orbit.',
    brief: 'The Ostrider is down on the bright ice of little Ost with Bram and Tilly aboard. Gravity here is a twentieth of home: a jump lasts half a minute.',
    tips: ['Send a Pip outside from the crew portraits; walk with W/A/S/D and plant a flag from the EVA actions.', 'Walk back to the ladder and board again with F.', 'Lifting off takes very little: a short burn straight up, tip east, and 170 m/s sideways is an orbit.'],
    objectives: [
      { id: 'eva', text: 'Send a Pip outside', test: T.eva() },
      { id: 'flag', text: 'Plant a flag on Ost', test: T.flag('ost') },
      { id: 'up', text: 'Lift off from Ost', test: T.off('ost') },
      { id: 'orbit', text: 'Reach a closed orbit of Ost', test: T.orbit('ost') },
    ],
    build(ctx) {
      const w = ctx.world;
      const v = placeLanded(w, ostrider(), body('ost'), ostSpot(w.ut).dir, { crew: ['Bram', 'Tilly'] });
      setFuel(v, 0.7);
      readyInSpace(v);
      v.syncLanded(w.ut); v.updateTelemetry(w.ut);
      return v;
    },
  },
  {
    id: 'murk-tracks', name: 'Tracks on Murk', world: 'murk', situation: 'Landed on Murk', difficulty: 'Easy', start: 'flight',
    goal: 'Drive the Pebble rover a kilometre across the plains of Murk.',
    brief: 'Under fifty atmospheres of ochre cloud, the Pebble rover sits on a lava plain where its lander left it. Six powered wheels, a battery, and nobody for sixty million kilometres.',
    tips: ['W/S drive, A/D steer, B brakes, U lights.', 'Murk pulls nearly as hard as Verda, so the rover grips well; still, slow down before you turn.', 'The isotope cell on its back tops the battery up whenever you ease off.'],
    objectives: [
      { id: 'roll', text: 'Drive 50 m from where the rover is parked', test: T.drove('Pebble', 50) },
      { id: 'far', text: 'Drive 300 m', test: T.drove('Pebble', 300) },
      { id: 'km', text: 'Reach 1 km from the start', test: T.drove('Pebble', 1000) },
    ],
    build(ctx) {
      const b = body('murk'), w = ctx.world;
      const spot = flatSpot(b, sunlitDir(b, w.ut, -0.7, 0.05), { reach: 60000, wide: 300, samples: 800 });
      const v = placeLanded(w, pebble(), b, spot.dir, { vehicle: true, heading: 90 });
      v.setSolar(true);
      ctx.mark('Pebble', spot.dir);
      return v;
    },
  },
  {
    id: 'pell-overland', name: 'Pell Overland', world: 'pell', situation: 'Landed on Pell', difficulty: 'Easy', start: 'flight',
    goal: 'Drive the Pebble rover a kilometre across the grey plains of Pell.',
    brief: 'The Pebble stands on Pell where its lander set it down, Verda hanging in a black sky. One sixth of home gravity: the springs are soft, the motors gentle, and every crest wants to throw you. A clear run lies straight ahead.',
    tips: ['B releases the brake, W/S drive, A/D steer. Leave SAS on (T): it holds the rover level when a crest throws it.', 'The motors govern themselves to about 5 m/s here. Ease off before craters and steep ground.', 'The Autopilot panel has a cruise control that holds this heading for a kilometre.'],
    objectives: [
      { id: 'roll', text: 'Drive 50 m from where the rover is parked', test: T.drove('Pebble', 50) },
      { id: 'far', text: 'Drive 300 m', test: T.drove('Pebble', 300) },
      { id: 'km', text: 'Reach 1 km from the start', test: T.drove('Pebble', 1000) },
    ],
    build(ctx) {
      const b = body('pell'), w = ctx.world;
      const route = driveRoute(b, sunlitDir(b, w.ut, -0.5, 0.1), { length: 1100, reach: 30000, samples: 60 });
      const v = placeLanded(w, pebble(), b, route.dir, { vehicle: true, heading: route.heading });
      v.setSolar(true);
      ctx.mark('Pebble', route.dir);
      return v;
    },
  },
  {
    id: 'rusk-arrival', name: 'Rusk Arrival', world: 'rusk', situation: 'On the way in to Rusk', difficulty: 'Hard', start: 'flight',
    goal: 'Plan and fly the capture burn that puts the Wayfarer in orbit of Rusk.',
    brief: 'Half a year out from Verda, the Wayfarer is falling toward Rusk engine first. Its path skims 90 km over the rust-red dunes and then leaves again, unless you brake.',
    tips: ['Open the map (M) and put a maneuver at the closest point: pull retrograde until the path closes.', 'The Furnace is thrifty but weak. Start the burn well before the node so it straddles it.', 'Once captured, lower the high point at leisure; the moon Dray is close by.'],
    objectives: [
      { id: 'node', text: 'Plan a maneuver', test: w => ships(w).some(v => v.crew.length && v.nodes && v.nodes.length > 0) },
      { id: 'capture', text: 'Close the path into an orbit of Rusk', test: T.orbit('rusk') },
    ],
    build(ctx) {
      const b = body('rusk'), w = ctx.world;
      const st = arrivalState(b, { vInf: arrivalVInf(body('verda'), b), pe: 90000, r: 9.0e6, phase: 0.5 }, w.ut);
      const v = w.spawn(wayfarer({ launcher: false }), { crew: ['Oskar', 'Bram', 'Tilly'], body: b, pos: st.pos, vel: st.vel, q: st.q });
      setFuel(v, 0.45, ['tank_l3200']);
      readyInSpace(v);
      v.ctrl.sasMode = 'retrograde';
      return v;
    },
  },
  {
    id: 'tiv-survey', name: 'Under the Giant', world: 'tiv', situation: 'In orbit of Tiv, moon of Thal', difficulty: 'Hard', start: 'flight',
    goal: 'Land the Wayfarer on Tiv, with banded Thal filling the sky.',
    brief: 'The far end of the system. The Wayfarer has shed its atomic stage and circles Tiv at 60 km, a moon of the giant Thal. Nobody has stood here.',
    tips: ['Tiv pulls harder than Pell: start the braking burn early and keep some height in hand.', 'Legs out with G; the Osprey has plenty of thrust, so feather the throttle near the ground.', 'Once down, send a Pip out to plant a flag.'],
    objectives: [
      { id: 'land', text: 'Land on Tiv', test: T.landed('tiv') },
      { id: 'flag', text: 'Plant a flag on Tiv', test: T.flag('tiv') },
    ],
    build(ctx) {
      const b = body('tiv');
      const st = orbitState(b, { pe: 60000, phase: -1.2, retro: true }, ctx.world.ut);
      const v = ctx.world.spawn(wayfarer({ launcher: false, transfer: false }), { crew: ['Oskar', 'Bram', 'Tilly'], body: b, pos: st.pos, vel: st.vel, q: st.q });
      setFuel(v, 0.85);
      return readyInSpace(v);
    },
  },
  {
    id: 'fire-and-silk', name: 'Fire and Silk', world: 'verda', situation: 'Falling back into the air', difficulty: 'Easy', start: 'flight',
    goal: 'Bring the Larkspur capsule through re-entry and down under its parachute.',
    brief: 'The engine is gone and the capsule is falling toward the air at well over two kilometres a second. Juno has a heat shield, a parachute, and about four minutes.',
    tips: ['Point the heat shield into the wind: SAS is set to hold retrograde for you.', 'Do nothing while it glows. The air does the braking.', 'Below about 5 km and 250 m/s press Space to open the parachute.'],
    objectives: [
      { id: 'air', text: 'Survive the heat down to 20 km', test: w => ships(w).some(v => v.body.id === 'verda' && v.crew.length && !v.landed && altOf(v) < 20000) },
      { id: 'home', text: 'Land or splash down on Verda', test: T.home() },
    ],
    build(ctx) {
      const b = body('verda'), w = ctx.world;
      // a sub-orbital arc: 120 km up at its top, the low point deep in the air
      const st = orbitState(b, { pe: 18000, ap: 120000, phase: -2.2, atAp: true, retro: true }, w.ut);
      const v = w.spawn(larkspur({ capsuleOnly: true }), { crew: ['Juno'], body: b, pos: st.pos, vel: st.vel, q: st.q });
      v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde'; v.ctrl.throttle = 0;
      return v;
    },
  },
];

const WORLD_NAME = id => (body(id) ? body(id).name : id);
export const SCENARIOS = Object.freeze(DEFS.map(d => Object.freeze({
  id: d.id, name: d.name, world: d.world, worldName: WORLD_NAME(d.world), situation: d.situation, difficulty: d.difficulty,
  start: d.start, goal: d.goal, brief: d.brief, tips: Object.freeze(d.tips.slice()),
  objectives: Object.freeze(d.objectives.map(o => Object.freeze({ id: o.id, text: o.text }))),
})));
const DEF_BY_ID = Object.fromEntries(DEFS.map(d => [d.id, d]));
const PUBLIC_BY_ID = Object.fromEntries(SCENARIOS.map(s => [s.id, s]));
export function scenarioDef(id) { return PUBLIC_BY_ID[id] || null; }

// ---------------------------------------------------------------------------------------------
// Building a scenario game
// ---------------------------------------------------------------------------------------------
/**
 * Build the game for one scenario. Deterministic: the same id gives the same state every time.
 * → { scenario, career, world, vessel, vessels, craft, crew, site, start: { screen, params } }
 *   'builder' starts: `craft` is the design (also saved in career.crafts); world is null.
 *   'launch'  starts: `world` shows the craft on the pad (with anything already flying); the game itself is
 *                     started with start.params = { craft, crew, paid: true, site }, exactly like a launch from
 *                     the assembly building, on top of career.flightState when other vessels are up.
 *   'flight'  starts: career.flightState is `world`; start.params = { resume: true }.
 */
export function buildScenario(id) {
  const def = DEF_BY_ID[id];
  if (!def) throw new Error('Unknown scenario "' + id + '"');
  const career = Career.newGame('sandbox', { seed: 20261119 });
  career.ut = SCENARIO_UT;
  const world = new World({ ut: SCENARIO_UT });
  const marks = {};
  let craft = null, crew = [], site = 'pad', padVessel = null;
  const ctx = {
    world, career,
    mark(name, dir) { marks[name] = { x: dir.x, y: dir.y, z: dir.z }; },
    hangar(c, names) { craft = c; crew = names.slice(); return null; },
    pad(c, names, at = 'pad') { craft = c; crew = names.slice(); site = at; return null; },
  };
  let vessel = def.build(ctx) || null;
  career.scenario = { id: def.id, name: def.name, done: [], marks, startedUt: SCENARIO_UT, complete: false };

  let start;
  if (def.start === 'builder') {
    const json = craft.toJSON();
    career.saveCraft(json);
    start = { screen: 'builder', params: { craft: json, site } };
    career.scenario.crew = crew.slice();
    return { scenario: PUBLIC_BY_ID[id], career, world: null, vessel: null, vessels: [], craft, crew, site, start };
  }
  if (def.start === 'launch') {
    // what is already flying is the saved flight the launch joins
    career.flightState = world.vessels.length ? world.toJSON() : null;
    career.saveCraft(craft.toJSON());
    career.assignCrew(crew);
    padVessel = world.launch(craft, { crew, site });
    vessel = padVessel;
    start = { screen: 'flight', params: { craft: craft.toJSON(), crew: crew.slice(), paid: true, site } };
  } else {
    if (!vessel) throw new Error('Scenario "' + id + '" built no vessel');
    if (world.active !== vessel) world.switchTo(vessel);
    for (const v of world.vessels) v.updateTelemetry(world.ut);
    const aboard = [];
    for (const v of world.vessels) for (const n of v.crew) aboard.push(n);
    career.assignCrew(aboard);
    crew = aboard;
    career.flightState = world.toJSON();
    start = { screen: 'flight', params: { resume: true } };
  }
  return { scenario: PUBLIC_BY_ID[id], career, world, vessel, vessels: world.vessels.slice(), craft, crew, site, start };
}

// ---------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------
/** The scenario a career is playing: name, goal and objectives with their done flags. null for an ordinary game. */
export function scenarioStatus(career) {
  const sc = career && career.scenario, def = sc && DEF_BY_ID[sc.id];
  if (!def) return null;
  const done = new Set(Array.isArray(sc.done) ? sc.done : []);
  const objectives = def.objectives.map(o => ({ id: o.id, text: o.text, done: done.has(o.id) }));
  const n = objectives.filter(o => o.done).length;
  return { id: def.id, name: def.name, goal: def.goal, brief: def.brief, tips: def.tips.slice(), situation: def.situation, difficulty: def.difficulty,
    worldName: WORLD_NAME(def.world), objectives, done: n, total: objectives.length, complete: n === objectives.length };
}

/**
 * Test the next objectives against the world as it stands. Objectives are met in order (the first one still open
 * is the only one tested, then the next, so a state that satisfies several ticks them all at once).
 * → [{ id, text }] newly completed; marks them in career.scenario.done and sets .complete when all are.
 */
export function checkScenario(career, world) {
  const sc = career && career.scenario, def = sc && DEF_BY_ID[sc.id];
  if (!def || !world) return [];
  if (!Array.isArray(sc.done)) sc.done = [];
  const fresh = [];
  for (const o of def.objectives) {
    if (sc.done.includes(o.id)) continue;
    let ok = false;
    try { ok = !!o.test(world, sc); } catch { ok = false; }
    if (!ok) break;
    sc.done.push(o.id);
    fresh.push({ id: o.id, text: o.text });
  }
  if (fresh.length && sc.done.length >= def.objectives.length) sc.complete = true;
  return fresh;
}

// ---------------------------------------------------------------------------------------------
// The scenario save slot
// ---------------------------------------------------------------------------------------------
function defaultStorage() { try { return globalThis.localStorage ?? null; } catch { return null; } }
export function hasScenarioGame(storage = defaultStorage()) {
  if (!storage) return false;
  try { return !!storage.getItem(SCENARIO_SAVE_KEY); } catch { return false; }
}
/** The scenario game in progress, or null (also null when the slot holds something that is not a scenario game). */
export function loadScenarioGame(storage = defaultStorage()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SCENARIO_SAVE_KEY);
    if (!raw) return null;
    const c = Career.fromJSON(JSON.parse(raw));
    return c.scenario && DEF_BY_ID[c.scenario.id] ? c : null;
  } catch { return null; }
}
export function deleteScenarioGame(storage = defaultStorage()) {
  if (!storage) return false;
  try { storage.removeItem(SCENARIO_SAVE_KEY); storage.removeItem(SCENARIO_QUICK_KEY); return true; } catch { return false; }
}
/** Which scenario the slot holds and how far it got, without building the whole Career: { id, name, done, total, ut } | null. */
export function scenarioSlotInfo(storage = defaultStorage()) {
  if (!storage) return null;
  try {
    const o = JSON.parse(storage.getItem(SCENARIO_SAVE_KEY) || 'null');
    const sc = o && o.scenario, def = sc && DEF_BY_ID[sc.id];
    if (!def) return null;
    const done = Array.isArray(sc.done) ? sc.done.filter(x => def.objectives.some(q => q.id === x)).length : 0;
    return { id: def.id, name: def.name, done, total: def.objectives.length, complete: done >= def.objectives.length, ut: Number.isFinite(o.ut) ? o.ut : 0 };
  } catch { return null; }
}
