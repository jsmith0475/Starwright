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
import { dropped, heronBooster } from '../tools/booster_dev.mjs';
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
  w.on('decouple', d => { if (!booster) booster = d.debris; });      // (the separator ring follows as a second piece)
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
    let d = null; w2.on('decouple', e => { if (!d) d = e.debris; });
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
  w.on('decouple', d => { if (!booster) booster = d.debris; });      // (the separator ring follows as a second piece)
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
const homeRef = R.readSystem().byId[home.id];          // the same world as plain data, for the reference's own atmosphere
/**
 * A point mass under inverse-square gravity and drag in air that turns with the planet, on the reference's own
 * integrator with its own exponential atmosphere. y = [r, v]; stops at `stopAlt` above the reference sphere.
 * `areaAt(mach)` is the drag area (m²) at a Mach number.
 */
function refFall(r0, v0, mass, areaAt, stopAlt) {
  const mu = home.gm, Rb = home.radius, wy = R.TAU / home.rotPeriod, at = home.atmo;
  const y = Float64Array.from([...r0, ...v0]);
  let maxQ = 0, prev = null, hit = null;
  const deriv = (t, s, o) => {
    const r = Math.hypot(s[0], s[1], s[2]), alt = r - Rb, g = -mu / (r * r * r);
    const ax = s[3] - wy * s[2], ay = s[4], az = s[5] + wy * s[0];
    const sp = Math.hypot(ax, ay, az);
    const rho = R.airDensity(homeRef, alt);
    const k = 0.5 * rho * sp * areaAt(sp / R.soundSpeed(homeRef, alt)) / mass;
    o[0] = s[3]; o[1] = s[4]; o[2] = s[5];
    o[3] = g * s[0] - k * ax; o[4] = g * s[1] - k * ay; o[5] = g * s[2] - k * az;
  };
  R.integrate(deriv, y, 0, 3000, { rtol: 1e-10, hmax: 0.25, onStep: (t, s) => {
    const r = Math.hypot(s[0], s[1], s[2]), alt = r - Rb;
    const sx = s[3] - wy * s[2], sz = s[5] + wy * s[0], sp = Math.hypot(sx, s[4], sz);
    const rho = R.airDensity(homeRef, alt);
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
  const t0 = w.ut, r0 = A(v.pos), v0 = A(v.vel), m0 = v.mass, drag = v.axialDragTable(true), cg = v.baseHeight;
  const tableAt = m => { const x = Math.min(120, Math.max(0, m * 10)), i = Math.min(119, x | 0); return drag[i] + (drag[i + 1] - drag[i]) * (x - i); };
  const startDir = home.inertialToSurfaceDir(v.pos.clone(), t0);
  const pred = predictFall(home, v.pos, v.vel, v.mass, t0, { drag, floor: cg });
  // the drag area by Mach number, measured from the flight itself wherever the air presses: what each step took off
  // the velocity, over the dynamic pressure from the reference's own atmosphere. Averaged in bins of Mach 0.05.
  const BIN = 0.05, sum = new Map();
  let maxQ = 0;
  while (!v.dead && !v.landed && w.ut - t0 < 900) {
    const before = A(v.vel), pos = A(v.pos), sp = v.airspeed, mBefore = v.mass;
    w.step(0.02);
    if (v.dead) break;
    maxQ = Math.max(maxQ, v.dynamicPressure || 0);
    const r = R.norm(pos), alt = r - home.radius, qNow = 0.5 * R.airDensity(homeRef, alt) * sp * sp;
    if (qNow > 300 && !v.landed) {
      const g = R.scale(pos, -home.gm / (r * r * r));
      const dv = R.sub(R.sub(A(v.vel), before), R.scale(g, 0.02));
      const k = Math.round(sp / R.soundSpeed(homeRef, alt) / BIN), e = sum.get(k) || [0, 0];
      e[0] += R.norm(dv) / 0.02 * mBefore / qNow; e[1]++; sum.set(k, e);
    }
  }
  const bins = [...sum.entries()].map(([k, e]) => [k * BIN, e[0] / e[1]]).sort((p, q) => p[0] - q[0]);
  const areaAt = m => {
    if (m <= bins[0][0]) return bins[0][1];
    for (let i = 1; i < bins.length; i++) if (m <= bins[i][0]) return bins[i - 1][1] + (bins[i][1] - bins[i - 1][1]) * (m - bins[i - 1][0]) / (bins[i][0] - bins[i - 1][0]);
    return bins[bins.length - 1][1];
  };
  let worst = 0;
  for (const [m, a] of bins) worst = Math.max(worst, Math.abs(tableAt(m) / a - 1));
  const T = w.ut - t0, endDir = home.inertialToSurfaceDir(v.pos.clone(), w.ut), flown = groundDistance(home, startDir, endDir);
  const seaAlt = v.altitude - Math.max(0, v.radarAlt);                 // height of the surface it hit, above the sphere
  S.info('the fall: time, and distance over the ground', T, 's', (flown / 1000).toFixed(1) + ' km, ending in the sea east of the pad');
  S.info('drag area engine first, measured in the flight: slowest / at Mach 1.1 / fastest', `${bins[0][1].toFixed(2)} / ${areaAt(1.1).toFixed(2)} / ${bins[bins.length - 1][1].toFixed(2)}`, 'm²', `Mach ${bins[0][0].toFixed(2)} to ${bins[bins.length - 1][0].toFixed(2)}; the forces part by part are checked in chapter 10`);
  S.check('drag table the predictor uses vs the drag measured in the flight, at every Mach number flown (worst)', 0, worst, 0.02, { max: true, note: 'the table is made at zero angle of attack; the stage sways a little as it falls' });
  const ref = refFall(r0, v0, m0, areaAt, seaAlt + cg);
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

// 9h. The folding leg. Its numbers are worked here from the part's own dimensions and from the flight, not read from
// the code that draws or deploys it.
function foldingLegCheck(S) {
  const { w, v } = dropped({ alt: 30000, speed: 1000, pitch: 45, east: 20000, fuel: 0.3, craft: heronBooster() });
  const c = boosterRecovery(w, v, { target: home.dirFromLatLon(600 / home.radius, 0) });
  const leg = v.legParts[0], d = leg.def, L = d.legs, eng = v.partList.find(p => p.type === 'eng_goshawk');
  // one rigid swing about a hinge 10 cm inside the foot of the box: the leg is as long folded as it is down
  const hx = -d.rw / 2 + 0.1, hy = -d.h / 2 + 0.1, len = Math.hypot(L.spread - hx, -L.reach + 0.3 * L.foot - hy);
  S.ok('folded, the leg ends inside its own box', hy + len < d.h / 2, `${(d.h / 2 - hy - len).toFixed(2)} m of room at the top`);
  S.check('down, the leg stands this far from straight down', 56, Math.atan2(L.spread - hx, L.reach - 0.3 * L.foot + hy) * 180 / Math.PI, 6, { unit: '°' });
  let tDown = null, altDown = null, tTouch = null, lowFolded = Infinity, vsDown = 0;
  const t0 = w.ut;
  while (!c.done && w.ut - t0 < 1200) {
    c.update(0.02);
    if (!v.legsDown) lowFolded = Math.min(lowFolded, v.radarAlt);
    else if (tDown === null) { tDown = w.ut; altDown = v.radarAlt; vsDown = v.verticalSpeed; }
    w.step(0.02);
    if (v.dead) break;
    if (tTouch === null && (v.landed || v.grounded)) tTouch = w.ut;
  }
  S.check('the return ends landed', 1, c.done && !c.failed && v.landed ? 1 : 0, 0);
  S.check('the legs stay folded until below this height', 60, lowFolded, 20, { unit: 'm' });
  S.ok('the legs are fully out before first contact (the swing takes 2.4 s)', tTouch - tDown > 2.4, `told down at ${altDown.toFixed(0)} m, falling at ${(-vsDown).toFixed(0)} m/s, ${(tTouch - tDown).toFixed(1)} s before contact`);
  for (let i = 0; i < 500; i++) w.step(0.02);
  // standing height from the dimensions: centre of mass above the pads' soles, less what the struts have closed
  const comp = v.legParts.reduce((a, p) => a + p._comp, 0) / v.legParts.length;
  const dir = v.pos.clone().normalize(), ground = home.radius + home.surfaceHeight(home.inertialToSurfaceDir(dir, w.ut));
  S.check('standing height of the centre of mass above the ground', v.com.y - (leg.pos.y - L.reach) - comp, v.pos.length() - ground, 0.02, { unit: 'm' });
  { const gap = (eng.pos.y - eng.def.h / 2) - (leg.pos.y - L.reach) - comp; S.ok('the engine bell clears the ground with the struts loaded', gap > 0.1, gap.toFixed(2) + ' m'); }
  { const used = Math.max(...v.legParts.map(p => p._comp)) / L.stroke; S.ok('no strut is closed to its stop', used < 1, (used * 100).toFixed(0) + ' % of the stroke used'); }
}

/** 9i. A stack separator fires at both ends: three pieces from one staging, worked by hand from the catalogue masses. */
function threePieceCheck(S) {
  const c = new Craft('Three Piece'); const [top] = c.setRoot('probe_wisp'); let cur = top; const id = {};
  for (const t of ['tank_m400', 'eng_sparrow', 'dec_m', 'probe_wisp', 'tank_m800', 'eng_goshawk']) { cur = c.attachStack(t, cur.id, 'bottom')[0]; id[t] = cur.id; }
  c.autoStage();
  const r0 = SYSTEM.home.radius + 300e3;
  const w = new World(), v = spawn(w, c, 'home', [r0, 0, 0], [0, 0, Math.sqrt(SYSTEM.home.gm / r0)], { crew: [] });
  const m0 = v.mass, p0 = mom([v]), v0 = A(v.vel), ax = A(new Vector3(0, 1, 0).applyQuaternion(v.q));
  for (let i = 0; i < 4 && w.vessels.length === 1; i++) w.stage(v);
  v.ctrl.throttle = 0;
  const stage = w.vessels[1];
  S.check('pieces straight after staging (the ring still rides on the dropped stage)', 2, w.vessels.length, 0);
  // first plane, by hand: J = force x 250 N s between the upper stage and (first stage + ring), along the stack
  const J = 12 * 250, along = (x, ref) => -R.dot(R.sub(A(x.vel), ref), ax);      // the first stage is on the -Y side of the stack
  S.check('first plane: upper stage speed along the stack', -J / v.mass, along(v, v0), 1e-9, { unit: 'm/s' });
  S.check('first plane: dropped stage speed along the stack', J / stage.mass, along(stage, v0), 1e-9, { unit: 'm/s' });
  S.check('first plane: momentum vs before', 0, R.norm(R.sub(mom([v, stage]), p0)) / R.norm(p0), 1e-12, { unit: 'rel' });
  let t = 0; while (w.vessels.length === 2 && t < 2) { var vS = A(stage.vel), mS = stage.mass; w.step(0.02); t += 0.02; }
  const ring = w.vessels[2];
  S.check('second plane fires this long after the first', 0.5, t, 0.021, { unit: 's' });
  S.check('pieces after the second plane', 3, w.vessels.length, 0);
  S.ok('the ring is a piece of its own, on neither stage', !!ring && ring.parts.size === 1 && ring.parts.has(id.dec_m) && !stage.parts.has(id.dec_m) && !v.parts.has(id.dec_m), ring ? `${ring.mass.toFixed(1)} kg, "${ring.name}"` : 'no ring');
  S.ok('the first stage is still a ship that can be flown', stage.type === 'ship');
  S.check('mass of the three pieces', m0, v.mass + stage.mass + ring.mass, 1e-6, { unit: 'kg' });
  // the step that fired it also had 0.02 s of gravity on every piece: g x dt x mass, the same for all, so compare
  // the stage + ring pair before and after with that taken out
  const gdt = R.scale(A(stage.pos), -SYSTEM.home.gm / Math.pow(R.norm(A(stage.pos)), 3) * 0.02);
  const pair0 = R.add(R.scale(vS, mS), R.scale(gdt, mS)), pair1 = R.add(R.scale(A(stage.vel), stage.mass), R.scale(A(ring.vel), ring.mass));
  S.check('second plane: momentum of stage + ring vs just before (gravity taken out)', 0, R.norm(R.sub(pair1, pair0)) / R.norm(pair0), 1e-7, { unit: 'rel' });
  // by hand: the ring is thrown at 20 m/s sideways and 1 m/s off the end, relative to the pair; shared by mass
  const rel = R.sub(A(ring.vel), A(stage.vel)), axS = A(new Vector3(0, 1, 0).applyQuaternion(stage.q));
  const off = R.dot(rel, axS), side = R.norm(R.sub(rel, R.scale(axS, off)));
  S.check('ring speed sideways from the stage', 20, side, 0.3, { unit: 'm/s', note: 'the tumbling stage top adds a few cm/s' });
  S.check('ring speed off the end of the stage', 1, off, 0.3, { unit: 'm/s' });
  S.check('recoil of the stage: 20.02 m/s x ring mass / (ring + stage)', Math.hypot(20, 1) * ring.mass / (ring.mass + stage.mass), R.norm(R.sub(R.sub(A(stage.vel), vS), gdt)), 2e-3, { unit: 'm/s' });
}

export const groups = [
  { name: '9a. Separation: mass, momentum, and what the dropped stage becomes', fast: true, run: S => separation(S) },
  { name: '9b. A booster far from the vessel being flown vs two-body motion', fast: true, run: S => farKepler(S) },
  { name: '9c. The flight does not depend on which vessel is watched', fast: true, run: S => watching(S) },
  { name: '9d. Where a falling stage comes down: predictor, flight and an independent integration', fast: true, run: S => predictorCheck(S) },
  { name: '9e. The landing burn against the rocket equation', fast: true, run: S => landingBurnCheck(S) },
  { name: '9f. Returns from varied separations', fast: false, run: S => dispersion(S) },
  { name: '9g. The landing barge: where it is, how it holds a stage, returns that end on it', fast: false, run: S => bargeCheck(S) },
  { name: '9h. The folding leg: one rigid swing, out before touchdown, and how the stage stands on it', fast: false, run: S => foldingLegCheck(S) },
  { name: '9i. A stack separator fires at both ends: three pieces, their mass and momentum, by hand', fast: true, run: S => threePieceCheck(S) },
];
