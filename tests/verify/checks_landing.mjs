// Verification group 12: the landing autopilot reads the ground (js/core/landingsite.js, docs/LANDING_SITES.md).
//
// The references here share nothing with the game's site assessment: slopes come from the formula of a made-up
// world or from a 400-point least-squares fit solved by Cramer's rule, "fit to stand on" is settled by setting a
// lander down there and seeing whether it stands, and the cost of the hover across is worked by hand.
import { SYSTEM, World, Vector3 } from './harness.mjs';
import * as AP from '../../js/core/autopilot.js';
import { assessSite, findSite, slopeLimit, footprint } from '../../js/core/landingsite.js';
import { SCENARIO_CRAFT, orbitState } from '../../js/core/scenarios.js';

const DEG = 180 / Math.PI, TAU = Math.PI * 2;
const Y = new Vector3(0, 1, 0);
const frame = d => { const e = new Vector3().crossVectors(Y, d).normalize(); return { e, n: new Vector3().crossVectors(d, e) }; };
const offset = (b, d, x, y) => { const f = frame(d); return d.clone().addScaledVector(f.e, x / b.radius).addScaledVector(f.n, y / b.radius).normalize(); };
function formulaWorld(h, R = 2e5) {
  const base = new Vector3(1, 0, 0), f = frame(base);
  return { radius: R, base, terrainHeight(d) { const k = R / d.dot(base); return h(d.dot(f.e) * k, d.dot(f.n) * k); } };
}
/** Independent slope of real ground: least squares over 400 points of a disc, normal equations by Cramer's rule. */
function refSlope(b, d, radius) {
  let n = 0, sx = 0, sy = 0, sh = 0, sxx = 0, syy = 0, sxy = 0, sxh = 0, syh = 0;
  for (let i = 0; i < 400; i++) {
    const r = radius * Math.sqrt((i + 0.5) / 400), a = i * 2.39996;
    const x = r * Math.cos(a), y = r * Math.sin(a), h = b.terrainHeight(offset(b, d, x, y));
    n++; sx += x; sy += y; sh += h; sxx += x * x; syy += y * y; sxy += x * y; sxh += x * h; syh += y * h;
  }
  const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const D = det([sxx, sxy, sx, sxy, syy, sy, sx, sy, n]);
  const gx = det([sxh, sxy, sx, syh, syy, sy, sh, sy, n]) / D, gy = det([sxx, sxh, sx, sxy, syh, sy, sx, sh, n]) / D;
  return Math.atan(Math.hypot(gx, gy));
}
const tiltOf = v => new Vector3(0, 1, 0).applyQuaternion(v.q).angleTo(v.pos) * DEG;
function inOrbit(bodyId, phase, craft = 'Wayfarer (lander)') {
  const b = SYSTEM.byId[bodyId], w = new World();
  const st = orbitState(b, { pe: Math.max(8000, 0.12 * b.radius), phase }, w.ut);
  const v = w.spawn(SCENARIO_CRAFT[craft](), { body: b, pos: st.pos, vel: st.vel, crew: ['Ada'], makeActive: true });
  v.q.copy(st.q); v.updateTelemetry(w.ut);
  return { w, v, b };
}
function land(bodyId, phase, opts = {}, craft) {
  const { w, v, b } = inOrbit(bodyId, phase, craft);
  const c = AP.hoverslamLanding(w, v, opts);
  const dv0 = v.estimateDeltaV();
  let touch = null, minClear = Infinity, hover = null, dvHover = NaN, tHover = NaN, tTouch = NaN, gsMax = 0;
  AP.fly(w, c, { dt: 0.05, maxSim: 20000, until: () => touch && tiltOf(v) > 60, onStep: () => {
    if (c.phase === 'brake' && v.groundSpeed > 10) minClear = Math.min(minClear, v.radarAlt);
    if (c.phase === 'final' && !hover) { hover = b.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut, new Vector3()); dvHover = v.estimateDeltaV(); tHover = w.ut; }
    if (hover && !touch) gsMax = Math.max(gsMax, v.groundSpeed);
    if (!touch && v.grounded) {
      const d = b.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut, new Vector3());
      tTouch = w.ut;
      touch = { dir: d, slope: refSlope(b, d, footprint(v)), miss: c.site ? Math.acos(Math.min(1, d.dot(c.site.dir))) * b.radius : NaN, dv: dvHover - v.estimateDeltaV() };
    }
  } });
  for (let i = 0; i < 200 && !v.dead && tiltOf(v) < 60; i++) w.step(0.1);
  return { c, v, b, touch, minClear, hover, tilt: tiltOf(v), standing: !v.dead && v.landed && tiltOf(v) < 25, dv: dv0 - v.estimateDeltaV(), tCross: tTouch - tHover, gsMax };
}

function assessment(S) {
  // a made-up world whose slope is known exactly
  for (const [gx, gy] of [[0.05, 0], [0.12, -0.05], [-0.3, 0.2]]) {
    const w = formulaWorld((x, y) => 50 + gx * x + gy * y);
    S.check(`plane ${gx}, ${gy}: slope vs atan of the gradient`, Math.atan(Math.hypot(gx, gy)) * DEG, assessSite(w, w.base, 4).slope * DEG, 0.01, { unit: '°' });
  }
  const dome = formulaWorld((x, y) => -(x * x + y * y) / 200);      // a dome of 100 m radius: level on top, no plane fits it
  const s = assessSite(dome, dome.base, 4);
  S.check('top of a dome: slope', 0, s.slope * DEG, 0.01, { unit: '°' });
  // (seventeen heights: 0 in the middle, -r²/200 on the two rings; the level plane through their mean is furthest from the middle one)
  S.check('top of a dome: departure from the plane, by hand (the mean of 8 × 16/200 and 8 × 4/200 over 17 points)', (8 * 16 / 200 + 8 * 4 / 200) / 17, s.rough, 1e-3, { unit: 'm' });
  // real ground against the independent 400-point fit
  let worst = 0, n = 0;
  for (const id of ['pell', 'dray', 'slate', 'cindra']) {
    const b = SYSTEM.byId[id];
    for (let i = 0; i < 60; i++) {
      const d = new Vector3(Math.sin(i * 1.7 + 1), Math.sin(i * 0.37) * 0.3, Math.cos(i * 1.7 + 1)).normalize();
      const a = assessSite(b, d, 4);
      if (a.rough > 0.25) continue;                       // (on broken ground "the slope" depends on where one samples)
      worst = Math.max(worst, Math.abs(a.slope - refSlope(b, d, 4)) * DEG); n++;
    }
  }
  S.check(`real ground, ${n} smooth spots on four worlds: slope vs a 400-point least-squares fit`, 0, worst, 1.5, { unit: '°', max: true });
}

function standing(S, full) {
  // What "fit to stand on" claims, tested the direct way: set the lander down at 1 m/s on ground the search calls
  // fit, and on ground at twice its tipping angle.
  for (const [name, bodyId] of full ? [['Wayfarer (lander)', 'pell'], ['Pellfarer (lander)', 'pell'], ['Wayfarer (lander)', 'cindra']] : [['Wayfarer (lander)', 'pell']]) {
    const b = SYSTEM.byId[bodyId];
    let stood = 0, tried = 0, fell = 0, steep = 0, limit = 0, tip = 0;
    const drop = (d) => {
      const w = new World();
      const up = b.surfaceDirToInertial(d, w.ut, new Vector3()).normalize(), wy = TAU / b.rotPeriod;
      const v = w.spawn(SCENARIO_CRAFT[name](), { body: b, pos: up.clone().multiplyScalar(b.radius + b.terrainHeight(d) + 12), vel: new Vector3(), crew: ['Ada'], makeActive: true });
      v.setLegs(true); w.step(0.01);
      v.pos.copy(up).multiplyScalar(b.radius + b.terrainHeight(d) + v.baseHeight + 1);
      v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x).addScaledVector(up, -1);
      v.q.setFromUnitVectors(new Vector3(0, 1, 0), up);
      v.ctrl.sas = true; v.ctrl.sasMode = 'hold'; v.ctrl.throttle = 0; v.updateTelemetry(w.ut);
      limit = slopeLimit(v); tip = Math.atan2(v.baseRadius, v.baseHeight);
      for (let i = 0; i < 1500 && !v.dead && tiltOf(v) < 60; i++) w.step(0.05);
      return !v.dead && tiltOf(v) < 25;
    };
    { const { w, v } = inOrbit(bodyId, 0, name); v.setLegs(true); w.step(0.05); limit = slopeLimit(v); tip = Math.atan2(v.baseRadius, v.baseHeight); var radius = footprint(v); }
    for (let i = 0; i < 4000 && (tried < 16 || steep < 8); i++) {
      const d = new Vector3(Math.sin(i * 1.7), Math.sin(i * 0.37) * 0.5, Math.cos(i * 1.7)).normalize();
      const f = findSite(b, d, { radius, reach: 0, limit, samples: 1 });
      if (f.ok && f.slope > 0.5 * limit && tried < 16) { tried++; if (drop(d)) stood++; }
      else if (!f.ok && refSlope(b, d, radius) > 2 * tip && steep < 8) { steep++; if (!drop(d)) fell++; }
    }
    S.info(`${name} on ${b.name}: tips over its feet at`, tip * DEG, '°');
    S.info(`${name} on ${b.name}: steepest ground the autopilot will choose`, limit * DEG, '°');
    S.check(`${name} on ${b.name}: set down on ${tried} spots called fit (upper half of the limit), stood on`, tried, stood, 0, { unit: 'spots' });
    S.check(`${name} on ${b.name}: set down on ${steep} spots at twice the tipping angle, fell on`, steep, fell, 1, { unit: 'spots', note: 'the ground the old program took as it came' });
  }
}

function search(S) {
  // every site it calls fit must be fit by the independent measure; where it finds none, a dense independent
  // search of the same disc must find (next to) none either
  let n = 0, worst = 0, noneCases = 0, refFound = 0;
  for (const id of ['pell', 'dray', 'slate']) {
    const b = SYSTEM.byId[id], limit = 0.09;
    for (let i = 0; i < 40; i++) {
      const d = new Vector3(Math.sin(i * 2.1 + 0.4), Math.sin(i * 0.53) * 0.3, Math.cos(i * 2.1 + 0.4)).normalize();
      const f = findSite(b, d, { radius: 4, reach: 200, limit });
      if (f.ok) { n++; worst = Math.max(worst, refSlope(b, f.dir, 4) / limit); }
      else {
        noneCases++;
        let fit = 0;
        for (let k = 0; k < 900; k++) { const r = 200 * Math.sqrt((k + 0.5) / 900), a = k * 2.39996; const p = offset(b, d, r * Math.cos(a), r * Math.sin(a)); if (refSlope(b, p, 4) < 0.8 * limit && refSlope(b, p, 12) < 0.8 * limit) fit++; }
        refFound = Math.max(refFound, fit / 900);
      }
    }
  }
  S.check(`${n} sites called fit on three worlds: steepest by the independent fit, as a fraction of the limit (may not pass 1.15)`, 0, worst, 1.15, { max: true });
  S.check(`${noneCases} places where it found nothing fit within 200 m: share of the disc an independent search calls clearly fit`, 0, refFound, 0.03, { max: true });
}

function flights(S, full) {
  const worlds = full ? ['pell', 'dray', 'slate', 'cindra', 'quell', 'nym'] : ['pell', 'dray'];
  const N = full ? 8 : 4;
  for (const id of worlds) {
    let stood = 0, oldStood = 0, worstSlope = 0, worstMiss = 0, extra = 0, warned = 0, minClear = Infinity;
    for (let i = 0; i < N; i++) {
      const ph = i / N * TAU + 0.1;
      const r = land(id, ph);
      if (r.standing) stood++;
      if (r.c.warning) warned++;
      if (r.touch) { worstSlope = Math.max(worstSlope, r.touch.slope / slopeLimit(r.v)); if (r.c.site) worstMiss = Math.max(worstMiss, r.touch.miss); }
      minClear = Math.min(minClear, r.minClear);
      const o = land(id, ph, { terrain: false });
      if (o.standing) oldStood++;
      extra += r.dv - o.dv;
    }
    const b = SYSTEM.byId[id];
    S.check(`${b.name}: ${N} landings from points round a low orbit, standing afterwards`, N, stood, 0, { unit: 'landers' });
    S.info(`${b.name}: the same ${N} starts without the terrain watch, standing`, oldStood, 'landers');
    S.check(`${b.name}: steepest ground under the feet at touchdown (independent fit), as a fraction of the lander's limit (may not pass 1.4)`, 0, worstSlope, 1.4, { max: true });
    S.check(`${b.name}: furthest touchdown from the spot it chose`, 0, worstMiss, 4, { unit: 'm', max: true });
    S.ok(`${b.name}: least height over the ground in the braking burn while faster than 10 m/s is 20 m or more`, minClear >= 20, minClear.toFixed(1) + ' m');
    S.info(`${b.name}: propellant the look at the ground cost, mean per landing`, extra / N, 'm/s');
    S.info(`${b.name}: landings that ended with a warning (no fit ground in reach)`, warned, 'landers');
  }
}

function prediction(S, full) {
  // the survey says where a burn begun now would leave the lander hovering: compare with where the flight hovered
  for (const id of full ? ['pell', 'dray', 'slate'] : ['dray']) {
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      const r = land(id, i / 4 * TAU + 0.3);
      if (r.c.aim && r.hover) worst = Math.max(worst, Math.acos(Math.min(1, r.hover.dot(r.c.aim))) * r.b.radius);
    }
    S.check(`${SYSTEM.byId[id].name}: hover point vs where the survey said it would be, worst of 4 (it looks 500 m round that point)`, 0, worst, id === 'dray' ? 300 : 1000, { unit: 'm', max: true });
  }
}

function crossing(S) {
  // The hover across, by hand. A lander that leans a hovering thrust by θ gets g·tanθ sideways, so d metres take at
  // least 2·sqrt(d / (g·tanθ)) seconds, and every second of hover costs g of delta-v. The flight may not beat that.
  let n = 0;
  for (const [id, ph] of [['pell', 1.147], ['dray', 0.1], ['slate', 0.1], ['cindra', 2.2]]) {
    const r = land(id, ph, { survey: false });
    if (!r.c.site || r.c.site.dist < 30 || !r.touch) continue;
    const b = r.b, g = b.gm / (b.radius * b.radius), lean = g < 0.5 ? 0.5 : 0.3;
    const tMin = 2 * Math.sqrt(r.c.site.dist / (g * Math.tan(lean)));
    S.ok(`${b.name}: ${r.c.site.dist.toFixed(0)} m across at the hover took no less than the bang-bang minimum`, r.tCross >= tMin, `${r.tCross.toFixed(0)} s flown, ${tMin.toFixed(0)} s minimum`);
    S.ok(`${b.name}: and cost no less than hovering that long (g × time)`, r.touch.dv >= g * tMin, `${r.touch.dv.toFixed(1)} m/s spent, ${(g * tMin).toFixed(1)} m/s minimum`);
    S.ok(`${b.name}: nor more than twice the hover for the time it really took`, r.touch.dv <= 2 * g * r.tCross + 10, `${r.touch.dv.toFixed(1)} m/s spent, ${(g * r.tCross).toFixed(1)} m/s to hover ${r.tCross.toFixed(0)} s`);
    n++;
  }
  S.ok('at least two of the four flights had a crossing worth timing', n >= 2, String(n));
}

export const groups = [
  { name: '12a. Landing sites: the slope and roughness of the ground vs formulas and an independent fit', fast: true, run: S => assessment(S) },
  { name: '12b. Landing sites: a lander set down on ground called fit stands, and on ground twice as steep as it can bear falls', fast: false, run: (S, full) => standing(S, full) },
  { name: '12c. Landing sites: the search vs a dense independent search', fast: false, run: S => search(S) },
  { name: '12d. Landing autopilot: landings from orbit stand, on the ground it chose, clear of the ground on the way', fast: false, run: (S, full) => flights(S, full) },
  { name: '12e. Landing autopilot: the hover point vs the survey from orbit', fast: false, run: (S, full) => prediction(S, full) },
  { name: '12f. Landing autopilot: the hover across vs a hand calculation', fast: false, run: S => crossing(S) },
];
