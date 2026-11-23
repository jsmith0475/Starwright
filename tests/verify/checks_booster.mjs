// 9. Two vessels at once (reusable boosters, phase 1; docs/BOOSTERS.md). A dropped stage that can still be flown
// keeps full physics at any distance from the vessel being watched. These checks ask whether that physics is the
// same physics: against two-body motion from tests/verify/ref.mjs, against the conservation laws, and against
// itself when the player watches a different vessel.
import { Craft } from '../../js/core/craft.js';
import { LOAD_RANGE } from '../../js/core/world.js';
import { World, SYSTEM, A, spawn, run } from './harness.mjs';
import * as R from './ref.mjs';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { predictFall, groundDistance, boosterRecovery } from '../../js/core/booster.js';
import { dropped } from '../tools/booster_dev.mjs';
import { flyReturn } from '../tools/booster_sweep.mjs';
const V3 = a => new Vector3(a[0], a[1], a[2]);

const sys = R.readSystem();

/** capsule + tank + Sparrow / separator / [guidance ring] + tanks + Goshawk, four fins. */
function rocket({ ring = true } = {}) {
  const c = new Craft('Verifier Returner');
  const [pod] = c.setRoot('pod_acorn');
  let cur = pod, low = null;
  for (const t of ['tank_m400', 'eng_sparrow', 'dec_m', ...(ring ? ['probe_wisp'] : []), 'tank_m800', 'tank_m200', 'eng_goshawk']) {
    cur = c.attachStack(t, cur.id, 'bottom')[0];
    if (t === 'tank_m200') low = cur;
  }
  c.attachRadial('fin', low.id, low.pos.y, Math.PI / 4, 4);
  c.autoStage();
  return c;
}
const mom = vs => vs.reduce((s, v) => R.add(s, R.scale(A(v.vel), v.mass)), [0, 0, 0]);
const stateOf = v => [...A(v.pos), ...A(v.vel), v.q.x, v.q.y, v.q.z, v.q.w, v.mass];

/** In deep space: the separation shares out momentum and mass and makes a flyable booster. */
function separation(S) {
  const w = new World();
  const v = spawn(w, rocket(), 'helion', [2e11, 0, 0], [0, 30, 0]);
  let booster = null;
  w.on('decouple', d => { booster = d.debris; });
  v.ctrl.sas = false;
  run(w, 1, 0.5);
  const m0 = v.mass, p0 = mom([v]);
  // skip the first stage's ignition: fire stages until the stack splits
  for (let i = 0; i < 4 && !booster; i++) { v.ctrl.throttle = 0; w.stage(); }
  S.ok('the stack split in two', !!booster);
  if (!booster) return;
  S.check('mass of the two pieces = mass before', m0, v.mass + booster.mass, 1e-6, { unit: 'kg' });
  const p1 = mom([v, booster]);
  S.check('momentum of the two pieces = momentum before', 0, R.norm(R.sub(p1, p0)) / R.norm(p0), 1e-12, { max: true, note: 'relative' });
  S.ok('the piece with the guidance ring is a ship, and is named a booster', booster.type === 'ship' && / booster$/.test(booster.name), booster.name);
  S.ok('the same piece without a ring is debris', (() => {
    const w2 = new World(); const u = spawn(w2, rocket({ ring: false }), 'helion', [2e11, 0, 0], [0, 30, 0]);
    let d = null; w2.on('decouple', e => { d = e.debris; });
    for (let i = 0; i < 4 && !d; i++) { u.ctrl.throttle = 0; w2.stage(); }
    return d && d.type === 'debris';
  })());
}

/**
 * Over airless Pell, on a path that comes down: the upper stage burns away, and the booster left far behind is
 * compared with two-body motion from the reference, next to the same measure for the vessel being flown.
 */
function farKepler(S) {
  const pell = sys.byId.pell;
  const r0 = [pell.radius + 60000, 0, 0], v0 = [0, 0, -200];
  const w = new World();
  const v = spawn(w, rocket(), 'pell', r0, v0);
  let booster = null;
  w.on('decouple', d => { booster = d.debris; });
  for (let i = 0; i < 4 && !booster; i++) { v.ctrl.throttle = 0; w.stage(); }
  // the upper stage flies off under power; the booster coasts
  v.ctrl.sas = true; v.ctrl.throttle = 1;
  let guard = 0;
  while (booster.pos.distanceTo(v.pos) < LOAD_RANGE * 2 && guard++ < 20000) w.step(0.02);
  v.ctrl.throttle = 0;
  run(w, 1, 0.02);
  S.info('distance between the stages when the comparison starts', booster.pos.distanceTo(v.pos), 'm', 'the load range is 2,500 m');
  S.ok('the booster is under full physics (not on rails) out there', !booster.onRails && w.tracked.includes(booster));
  const T = 100;
  const b0 = { r: A(booster.pos), v: A(booster.vel) }, a0 = { r: A(v.pos), v: A(v.vel) };
  run(w, T, 0.02);
  const refB = R.keplerUV(b0.r, b0.v, pell.gm, T), refA = R.keplerUV(a0.r, a0.v, pell.gm, T);
  const errB = R.norm(R.sub(A(booster.pos), refB.r)), errA = R.norm(R.sub(A(v.pos), refA.r));
  S.ok('still under full physics at the end', !booster.onRails && !booster.dead);
  S.check(`booster far away: position after ${T} s vs two-body reference`, 0, errB, 1e-3, { unit: 'm', max: true });
  S.check(`vessel being flown: the same measure`, 0, errA, 1e-3, { unit: 'm', max: true });
  S.check('booster velocity vs two-body reference', 0, R.norm(R.sub(A(booster.vel), refB.v)), 1e-5, { unit: 'm/s', max: true });
  // energy and angular momentum of the far booster over the coast
  const E = s => R.dot(s.v, s.v) / 2 - pell.gm / R.norm(s.r);
  const e1 = { r: A(booster.pos), v: A(booster.vel) };
  S.check('booster specific energy over the coast', E(b0), E(e1), 1e-6, { rel: true, unit: 'J/kg' });
  S.check('booster angular momentum over the coast', R.norm(R.cross(b0.r, b0.v)), R.norm(R.cross(e1.r, e1.v)), 1e-7, { rel: true, unit: 'm^2/s' });
}

/** From the pad through the air: the same launch watched three ways gives the same flight. */
function watching(S) {
  const fly = watch => {
    const w = new World();
    const upper = w.launch(rocket(), { crew: ['Ada'] });
    let booster = null;
    w.on('decouple', d => { if (!booster) booster = d.debris; });
    upper.ctrl.throttle = 1;
    w.stage();
    const first = upper.engines.find(e => e.part.ignited).part;
    for (let i = 0; i < 20000 && !first.flameout; i++) w.step(0.02);
    w.stage();
    const rows = [];
    for (let i = 1; i <= 3000; i++) {
      if (watch === 'booster' && i === 1) w.switchTo(booster);
      if (watch === 'both' && i % 250 === 0) w.switchTo(w.active === upper ? booster : upper);
      w.step(0.02);
      if (i % 500 === 0) rows.push([...stateOf(upper), ...stateOf(booster)]);
    }
    return { rows, sep: booster.pos.distanceTo(upper.pos), alive: !upper.dead && !booster.dead };
  };
  const a = fly('upper'), b = fly('booster'), c = fly('both');
  S.ok('both vessels are still flying after 60 s in all three flights', a.alive && b.alive && c.alive);
  S.info('distance between them at the end', a.sep, 'm');
  const worst = other => {
    let m = 0;
    for (let k = 0; k < a.rows.length; k++) for (let j = 0; j < a.rows[k].length; j++) m = Math.max(m, Math.abs(a.rows[k][j] - other.rows[k][j]) / Math.max(1, Math.abs(a.rows[k][j])));
    return m;
  };
  S.check('watching the booster instead of the upper stage: largest difference in any state value', 0, worst(b), 1e-6, { max: true, note: 'relative; position, velocity, attitude and mass of both, six samples' });
  S.check('switching between them every 5 s: largest difference', 0, worst(c), 1e-6, { max: true, note: 'relative' });
}


// ------------------------------------------------------------------------------------------------------------
// Phase 2: the fall predictor and the program that flies a stage back (js/core/booster.js).
// ------------------------------------------------------------------------------------------------------------
const home = SYSTEM.home;
/** The drag multiplier against Mach number, restated from the specification (not imported from the game). */
function machRef(m) { return m <= 0.7 ? 1 : m < 1.1 ? 1 + (m - 0.7) * 2.5 : m < 2.5 ? 2 - (m - 1.1) / 1.4 * 0.5 : 1.5; }
const SOUND = 320;
/**
 * A point mass under inverse-square gravity and drag in air that turns with the planet, on the reference's own
 * integrator with its own exponential atmosphere. y = [r, v]; stops at `stopAlt` above the reference sphere.
 */
function refFall(r0, v0, mass, area, stopAlt) {
  const mu = home.gm, Rb = home.radius, wy = R.TAU / home.rotPeriod, at = home.atmo;
  const y = Float64Array.from([...r0, ...v0]);
  let maxQ = 0, prev = null, hit = null;
  const deriv = (t, s, o) => {
    const r = Math.hypot(s[0], s[1], s[2]), alt = r - Rb, g = -mu / (r * r * r);
    const ax = s[3] - wy * s[2], ay = s[4], az = s[5] + wy * s[0];
    const sp = Math.hypot(ax, ay, az);
    const rho = alt < at.height ? at.rho0 * Math.exp(-Math.max(0, alt) / at.scale) : 0;
    const k = 0.5 * rho * sp * machRef(sp / SOUND) * area / mass;
    o[0] = s[3]; o[1] = s[4]; o[2] = s[5];
    o[3] = g * s[0] - k * ax; o[4] = g * s[1] - k * ay; o[5] = g * s[2] - k * az;
  };
  R.integrate(deriv, y, 0, 3000, { rtol: 1e-10, hmax: 0.25, onStep: (t, s) => {
    const r = Math.hypot(s[0], s[1], s[2]), alt = r - Rb;
    const sx = s[3] - wy * s[2], sz = s[5] + wy * s[0], sp = Math.hypot(sx, s[4], sz);
    const rho = alt < at.height ? at.rho0 * Math.exp(-Math.max(0, alt) / at.scale) : 0;
    maxQ = Math.max(maxQ, 0.5 * rho * sp * sp);
    if (alt <= stopAlt) {
      const f = prev ? (prev.alt - stopAlt) / (prev.alt - alt) : 1;      // the crossing, between the last two steps
      const p = prev || { t, s: Array.from(s), sp };
      hit = { t: p.t + f * (t - p.t), r: [0, 1, 2].map(i => p.s[i] + f * (s[i] - p.s[i])), speed: p.sp + f * (sp - p.sp) };
      return true;
    }
    prev = { t, s: Array.from(s), alt, sp };
    return false;
  } });
  return { ...hit, maxQ };
}

/** A stage falling engine first over the sea: the game's flight, the game's predictor, and the reference. */
function predictorCheck(S) {
  const { w, v } = dropped({ alt: 62000, speed: 640, pitch: 0, east: 20000, fuel: 0.2 });
  v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde';
  run(w, 30, 0.02);
  const t0 = w.ut, r0 = A(v.pos), v0 = A(v.vel), m0 = v.mass, area = v.axialDragArea(true), cg = v.baseHeight;
  const startDir = home.inertialToSurfaceDir(v.pos.clone(), t0);
  const pred = predictFall(home, v.pos, v.vel, v.mass, t0, { area, floor: cg });
  // the drag area, measured from the flight itself where the air is thick: what one step took off the velocity
  let areaMeas = null, maxQ = 0;
  while (!v.dead && !v.landed && w.ut - t0 < 900) {
    const before = A(v.vel), pos = A(v.pos), q = v.dynamicPressure || 0, sp = v.airspeed, mBefore = v.mass;
    w.step(0.02);
    if (v.dead) break;
    maxQ = Math.max(maxQ, v.dynamicPressure || 0);
    if (!areaMeas && q > 20000 && sp > 300) {
      const r = R.norm(pos), g = R.scale(pos, -home.gm / (r * r * r));
      const dv = R.sub(R.sub(A(v.vel), before), R.scale(g, 0.02));
      const qNow = 0.5 * home.density(r - home.radius) * sp * sp;
      areaMeas = R.norm(dv) / 0.02 * mBefore / (qNow * machRef(sp / SOUND));
    }
  }
  const T = w.ut - t0, endDir = home.inertialToSurfaceDir(v.pos.clone(), w.ut), flown = groundDistance(home, startDir, endDir);
  const seaAlt = v.altitude - Math.max(0, v.radarAlt);                 // height of the surface it hit, above the sphere
  S.info('the fall: time, and distance over the ground', T, 's', (flown / 1000).toFixed(1) + ' km, ending in the sea east of the pad');
  S.check('drag area the predictor uses = drag area measured from one step of the flight', areaMeas, area, 0.01, { rel: true, unit: 'm²' });
  const ref = refFall(r0, v0, m0, areaMeas, seaAlt + cg);
  const refDir = home.inertialToSurfaceDir(V3(ref.r), t0 + ref.t);
  S.check('reference vs the flight: impact point', 0, groundDistance(home, refDir, endDir) / flown, 0.01, { max: true, note: 'fraction of the distance flown' });
  S.check('reference vs the flight: time of fall', T, ref.t, 1, { unit: 's' });
  S.check('reference vs the flight: impact speed', v.airspeed, ref.speed, 0.01, { rel: true, unit: 'm/s' });
  S.check('reference vs the flight: peak dynamic pressure', maxQ, ref.maxQ, 0.02, { rel: true, unit: 'Pa' });
  S.check('predictor vs the flight: impact point', 0, groundDistance(home, pred.dir, endDir) / flown, 0.01, { max: true, note: 'fraction of the distance flown' });
  S.check('predictor vs the reference: impact point', 0, groundDistance(home, pred.dir, refDir), 100, { max: true, unit: 'm' });
  S.check('predictor vs the reference: time of fall', ref.t, pred.t, 0.5, { unit: 's' });
  S.check('predictor vs the reference: impact speed', ref.speed, pred.speed, 0.005, { rel: true, unit: 'm/s' });
}

/** The landing burn on airless Pell: where a burn stops, against the rocket equation integrated by the reference. */
function landingBurnCheck(S) {
  const pell = SYSTEM.byId.pell, mu = pell.gm;
  const F = 60000, ve = 2900, m0 = 4000, v0 = 180, h0 = 9000;
  const pos = V3([pell.radius + h0, 0, 0]), vel = V3([-v0, 0, 0]);
  const wy = R.TAU / pell.rotPeriod;
  vel.z -= wy * pos.x;                                                 // straight down over the turning ground
  const pb = predictFall(pell, pos, vel, m0, 0, { area: 0, thrust: F, ve, throttle: 1, dryMass: 500, maxT: 200, floor: -1e9 });
  // reference: radial fall with thrust up and mass flow, exact gravity
  const y = Float64Array.from([pell.radius + h0, -v0, m0]);
  let stop = null, prev = null;
  R.integrate((t, s, o) => { o[0] = s[1]; o[1] = -mu / (s[0] * s[0]) + F / s[2]; o[2] = -F / ve; }, y, 0, 200, { rtol: 1e-12, hmax: 0.05,
    onStep: (t, s) => { if (s[1] >= 0) { const f = prev ? -prev.v / (s[1] - prev.v) : 1; stop = { t: (prev ? prev.t : t) + f * (t - (prev ? prev.t : t)), r: (prev ? prev.r : s[0]) + f * (s[0] - (prev ? prev.r : s[0])) }; return true; } prev = { t, r: s[0], v: s[1] }; return false; } });
  const dRef = pell.radius + h0 - stop.r, dPred = pell.radius + h0 - pb.pos.length();
  S.ok('the predicted burn comes to rest', pb.stopped);
  S.check('distance fallen during the burn: predictor vs rocket equation', dRef, dPred, 0.01, { rel: true, unit: 'm' });
  S.check('time of the burn', stop.t, pb.t, 0.01, { rel: true, unit: 's' });
  // closed form with constant gravity, as a sanity check on the reference itself
  const g = mu / Math.pow(pell.radius + h0 - dRef / 2, 2), tb = stop.t, mdot = F / ve;
  const dClosed = v0 * tb + 0.5 * g * tb * tb - ve * (tb - (m0 / mdot - tb) * Math.log(m0 / (m0 - mdot * tb)));
  S.check('the same distance from the closed form (constant gravity)', dRef, dClosed, 0.01, { rel: true, unit: 'm' });
  S.check('propellant burned = thrust × time / exhaust speed', mdot * stop.t, m0 - pb.mass, 0.01, { rel: true, unit: 'kg' });
}

/** Returns from varied separations, each flown by the game at 0.02 s; every one is listed. */
function dispersion(S) {
  let seed = 4242;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let good = 0, worstMiss = 0, worstVs = 0, worstHs = 0, worstTilt = 0;
  const N = 12, bad = [];
  for (let i = 0; i < N; i++) {
    const start = { alt: 22000 + rnd() * 18000, speed: 850 + rnd() * 500, pitch: 35 + rnd() * 25, east: 12000 + rnd() * 28000, fuel: 0.42 + rnd() * 0.14 };
    const r = flyReturn(start);
    const inside = r.ok && r.miss < 10 && Math.abs(r.vs) < 2 && r.hs < 1 && r.tilt < 3;
    if (inside) good++; else bad.push(JSON.stringify(start));
    if (r.ok) { worstMiss = Math.max(worstMiss, r.miss); worstVs = Math.max(worstVs, Math.abs(r.vs)); worstHs = Math.max(worstHs, r.hs); worstTilt = Math.max(worstTilt, r.tilt); }
  }
  S.check(`returns inside the touchdown targets, of ${N} (separation 22 to 40 km, 850 to 1,350 m/s, 12 to 40 km downrange)`, N, good, 0, { note: bad.join(' ') });
  S.check('worst distance from the target', 0, worstMiss, 10, { max: true, unit: 'm' });
  S.check('worst vertical speed at touchdown', 0, worstVs, 2, { max: true, unit: 'm/s' });
  S.check('worst sideways speed at touchdown', 0, worstHs, 1, { max: true, unit: 'm/s' });
  S.check('worst tilt at touchdown', 0, worstTilt, 3, { max: true, unit: '°' });
  // a dead engine: the stage comes down hard, as an unguided one does (nothing is faked to save it)
  const { w, v } = dropped({ alt: 30000, speed: 1000, pitch: 45, east: 20000, fuel: 0.45 });
  const c = boosterRecovery(w, v, { target: home.dirFromLatLon(600 / home.radius, 0) });
  let cut = false;
  for (let i = 0; i < 40000 && !c.done; i++) {
    c.update(0.02);
    if (c.phase === 'coast' && v.verticalSpeed < 0 && v.altitude < 20000 && !cut) { cut = true; for (const p of v.partList) { if (p.res.fuel !== undefined) p.res.fuel = 0; if (p.res.ox !== undefined) p.res.ox = 0; } }
    w.step(0.02);
    if (v.dead) { c.update(0.02); break; }
  }
  S.ok('with its propellant taken away before the landing burn the stage is lost, and the program says so', v.dead && c.failed, (c.log.at(-1) || {}).msg);
}


// ------------------------------------------------------------------------------------------------------------
// Phase 3: the landing barge (a deck that is solid to the physics) and returns that end on it.
// ------------------------------------------------------------------------------------------------------------
function bargeCheck(S) {
  const b = home.sites.barge, Rb = home.radius;
  // where the deck is, from the haversine formula on the site's latitude and longitude (not the game's own distance)
  const hav = (la1, lo1, la2, lo2) => 2 * Rb * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
  S.check('the barge is 40 km from the launch pad along the ground', 40000, hav(0, 0, b.lat, b.lon), 0.01, { unit: 'm' });
  S.check('its deck is 4 m above the sea', 4, b.top - home.seaLevel, 1e-9, { unit: 'm' });
  // the deck's outline, found by walking outward from the middle in 1 cm steps until the ground stops being the deck
  const edge = (de, dn) => { let r = 0; while (r < 200 && home.deckAt(home.dirFromLatLon(b.lat + dn * (r + 0.01) / Rb, b.lon + de * (r + 0.01) / Rb)) > -Infinity) r += 0.01; return r; };
  S.check('deck length (east to west)', 80, edge(1, 0) + edge(-1, 0), 0.03, { unit: 'm' });
  S.check('deck width (north to south)', 50, edge(0, 1) + edge(0, -1), 0.03, { unit: 'm' });
  // a stage standing on the deck stands exactly as it does on land: same height of its centre of mass above what it stands on
  const stand = (target, top) => { const { w, v } = dropped({ alt: 16000, speed: 320, pitch: -80, east: (target === b.dir ? 40000 : -1500) - 1500, fuel: 0.14 }); const c = boosterRecovery(w, v, { target }); for (let i = 0; i < 12000 && !c.done; i++) { c.update(0.02); w.step(0.02); } for (let i = 0; i < 500; i++) w.step(0.02); return { ok: c.done && !c.failed && v.landed && !v.splashed, h: v.altitude - top, m: v.mass }; };
  const onDeck = stand(b.dir, b.top), onLand = stand(home.dirFromLatLon(0, -1500 / Rb), 0);      // (level ground 1.5 km west of the pad)
  S.ok('a stage flown down onto the deck stands on it, out of the water', onDeck.ok);
  S.ok('the same stage flown down onto level ground stands there', onLand.ok);
  S.check('mass of the two stages at rest (the two flights are the same but for where they end)', onLand.m, onDeck.m, 2, { unit: 'kg' });
  S.check('height of its centre of mass above the deck = above level ground', onLand.h, onDeck.h, 0.01, { unit: 'm' });
  // returns from separation that end on the barge
  let seed = 977;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const N = 10, bad = []; let good = 0, worstMiss = 0, worstVs = 0, worstTilt = 0;
  for (let i = 0; i < N; i++) {
    const start = { alt: 20000 + rnd() * 15000, speed: 800 + rnd() * 450, pitch: 36 + rnd() * 14, east: 10000 + rnd() * 14000, fuel: 0.26 + rnd() * 0.08 };
    const r = flyReturn(start, { target: b.dir });
    const inside = r.ok && r.miss < 10 && Math.abs(r.vs) < 2 && r.hs < 1 && r.tilt < 3;
    if (inside) good++; else bad.push(JSON.stringify(start) + ' ' + r.log.at(-1));
    if (r.ok) { worstMiss = Math.max(worstMiss, r.miss); worstVs = Math.max(worstVs, Math.abs(r.vs)); worstTilt = Math.max(worstTilt, r.tilt); }
  }
  S.check(`returns that land on the barge inside the touchdown targets, of ${N} (separation 20 to 35 km, 800 to 1,250 m/s, 10 to 24 km downrange)`, N, good, 0, { note: bad.join(' ') });
  S.check('worst distance from the middle of the deck (the deck is 80 by 50 m)', 0, worstMiss, 10, { max: true, unit: 'm' });
  S.check('worst vertical speed at touchdown', 0, worstVs, 2, { max: true, unit: 'm/s' });
  S.check('worst tilt at touchdown', 0, worstTilt, 3, { max: true, unit: '°' });
}

export const groups = [
  { name: '9a. Separation: mass, momentum, and what the dropped stage becomes', fast: true, run: S => separation(S) },
  { name: '9b. A booster far from the vessel being flown vs two-body motion', fast: true, run: S => farKepler(S) },
  { name: '9c. The flight does not depend on which vessel is watched', fast: true, run: S => watching(S) },
  { name: '9d. Where a falling stage comes down: predictor, flight and an independent integration', fast: true, run: S => predictorCheck(S) },
  { name: '9e. The landing burn against the rocket equation', fast: true, run: S => landingBurnCheck(S) },
  { name: '9f. Returns from varied separations', fast: false, run: S => dispersion(S) },
  { name: '9g. The landing barge: where it is, how it holds a stage, returns that end on it', fast: false, run: S => bargeCheck(S) },
];
