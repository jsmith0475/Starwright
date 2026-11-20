// 1. Two-body mechanics: the game's Kepler maths and its stepping against the independent reference.
import { Orbit, solveKeplerElliptic, solveKeplerHyperbolic } from '../../js/core/orbit.js';
import { WARP_RATES, PHYSICS_WARP_MAX, railMinAltitude } from '../../js/core/world.js';
import { World, SYSTEM, V, A, capsule, spawn, run } from './harness.mjs';
import * as R from './ref.mjs';

const sys = R.readSystem();
const verda = sys.byId.verda;

function circularOnEveryBody(S) {
  for (const b of sys.bodies) {
    let worstV = 0, worstT = 0, worstG = 0, worstA = 0;
    const g = SYSTEM.byId[b.id];
    for (const frac of [0.05, 0.5, 5]) {
      const alt = (b.atmo ? b.atmo.height : 0) + b.radius * frac;
      const r = b.radius + alt;
      const o = Orbit.fromElements({ a: r, e: 0 }, g.gm, 0);
      worstV = Math.max(worstV, Math.abs(o.velAt(123).length() / R.circularSpeed(b.gm, r) - 1));
      worstT = Math.max(worstT, Math.abs(o.period / R.orbitPeriod(b.gm, r) - 1));
      // and through the live vessel telemetry (what the HUD shows)
      const w = new World();
      const v = spawn(w, capsule(), b.id, [r, 0, 0], [0, 0, -R.circularSpeed(b.gm, r)]);
      worstT = Math.max(worstT, Math.abs(v.period / R.orbitPeriod(b.gm, r) - 1));
      worstV = Math.max(worstV, Math.abs(v.orbitalSpeed / R.circularSpeed(b.gm, r) - 1));
      worstA = Math.max(worstA, Math.abs(v.apoapsis - alt) / r, Math.abs(v.periapsis - alt) / r);
    }
    worstG = Math.abs(g.gm / b.gm - 1);
    S.check(`${b.name}: GM used by the game = table value (surface g x R^2)`, 0, worstG, 1e-14, { max: true });
    S.check(`${b.name}: circular speed sqrt(GM/r) at 3 altitudes (orbit + HUD), worst rel error`, 0, worstV, 1e-12);
    // the HUD gets e from sqrt(1 + 2*E*h^2/GM^2): for an exactly circular orbit that is sqrt(rounding) ~ 1e-8
    S.check(`${b.name}: HUD apoapsis / periapsis of a circular orbit, worst error / r`, 0, worstA, 1e-7);
    S.check(`${b.name}: circular period 2pi sqrt(r^3/GM) at 3 altitudes, worst rel error`, 0, worstT, 1e-12);
  }
}

// state vectors (game frame) for a set of shapes and orientations around Verda
function cases() {
  const mu = verda.gm, rp = verda.radius + 150e3;
  const mk = (name, e, i, lan, argp, M0, span, extra = {}) => {
    const a = e < 1 ? rp / (1 - e) : -rp / (e - 1);
    return { name, el: { a, e, i, lan, argp, M0 }, mu, span, ...extra };
  };
  const T = e => R.orbitPeriod(mu, rp / (1 - e));
  return [
    mk('circular equatorial, 100 orbits', 0, 0, 0, 0, 0.3, 100 * T(0)),
    mk('e = 1e-8 (near circular), 100 orbits', 1e-8, 20, 30, 40, 1.0, 100 * T(1e-8)),
    mk('e = 0.3 inclined 35 deg, 50 orbits', 0.3, 35, 80, 120, 2.0, 50 * T(0.3)),
    mk('e = 0.7 polar, 30 orbits', 0.7, 90, 10, 200, -1.0, 30 * T(0.7)),
    mk('e = 0.95 retrograde 150 deg, 20 orbits', 0.95, 150, 300, 45, 0.5, 20 * T(0.95)),
    mk('exactly retrograde equatorial (180 deg), 40 orbits', 0.2, 180, 0, 70, 1.3, 40 * T(0.2)),
    mk('e = 0.999 (near parabolic ellipse), 3 orbits', 0.999, 12, 5, 60, 0.2, 3 * T(0.999)),
    mk('e = 1 - 1e-9 (parabolic-ish, closed)', 1 - 1e-9, 5, 0, 0, 0, 5e5, { fromPe: true }),
    mk('e = 1 + 1e-9 (parabolic-ish, open)', 1 + 1e-9, 5, 0, 0, 0, 5e5, { fromPe: true }),
    mk('e = 1.5 hyperbola', 1.5, 28, 100, 250, -2.0, 2e5),
    mk('e = 5 hyperbola, retrograde', 5, 170, 200, 10, -8.0, 1e5),
    mk('e = 40 hyperbola (fast flyby)', 40, 60, 0, 0, -30.0, 2e4),
  ];
}

function propagation(S, long) {
  for (const c of cases()) {
    // start state from the REFERENCE's own element conversion (near-parabolic cases start at periapsis by hand)
    let s0;
    if (c.fromPe) {
      const rp = verda.radius + 150e3, vp = Math.sqrt(c.mu * (1 + c.el.e) / rp);
      s0 = { r: [rp, 0, 0], v: [0, vp * Math.sin(5 * Math.PI / 180), -vp * Math.cos(5 * Math.PI / 180)] };
    } else s0 = R.elementsToState(c.el, c.mu, 0);
    const o = Orbit.fromState(V(s0.r), V(s0.v), SYSTEM.byId.verda.gm, 0);
    let worstUV = 0, worstVel = 0, worstVV = 0, worstE = 0, worstH = 0;
    const e0 = R.stateToElements(s0.r, s0.v, c.mu);
    for (const f of [0.013, 0.25, 0.5, 0.777, 1]) {
      const t = c.span * f;
      const g = o.stateAt(t), ref = R.keplerUV(s0.r, s0.v, c.mu, t);
      const rr = R.norm(ref.r), vv = R.norm(ref.v);
      worstUV = Math.max(worstUV, R.dist(A(g.r), ref.r) / rr);
      worstVel = Math.max(worstVel, R.dist(A(g.v), ref.v) / vv);
      const ge = R.stateToElements(A(g.r), A(g.v), c.mu);
      worstVV = Math.max(worstVV, Math.abs(g.v.lengthSq() / (c.mu * (2 / g.r.length() - 1 / e0.a)) - 1));
      worstE = Math.max(worstE, Math.abs((ge.energy - e0.energy) / (c.mu / rr)));
      worstH = Math.max(worstH, R.norm(R.sub(ge.h, e0.h)) / e0.hmag);
    }
    // near-parabolic orbits are ill-conditioned in time (dt/da is huge): the tolerance reflects that
    // near-circular (1e-10 < e < 1e-6): the game takes the anomaly from two rounding-limited numbers, a fixed ~2 mm phase offset
    const tol = Math.abs(c.el.e - 1) < 1e-6 ? 2e-6 : c.el.e > 0.99 && c.el.e < 1 ? 1e-7 : c.el.e > 0 && c.el.e < 1e-6 ? 1e-8 : 2e-9;
    S.check(`${c.name}: position vs universal-variable Kepler, worst rel error`, 0, worstUV, tol);
    S.check(`${c.name}: velocity vs universal-variable Kepler, worst rel error`, 0, worstVel, tol * 10);
    S.check(`${c.name}: vis-viva v^2 = GM(2/r - 1/a), worst rel error`, 0, worstVV, 1e-9);
    S.check(`${c.name}: energy drift / (GM/r)`, 0, worstE, 1e-9);
    S.check(`${c.name}: angular-momentum vector drift (rel)`, 0, worstH, 1e-9);
    if (long || c.span < 3e5) {
      // and against the numerical integrator (independent of both closed forms)
      const t = Math.min(c.span, long ? c.span : 2e5);
      const num = R.integrateTwoBody(s0.r, s0.v, c.mu, t, 1e-13);
      const g = o.stateAt(t);
      S.check(`${c.name}: position vs numerical integrator after ${(t / 3600).toFixed(1)} h (rel)`, 0, R.dist(A(g.r), num.r) / R.norm(num.r), Math.max(tol, 2e-8));
    }
  }
}

function keplerEdgeCases(S) {
  let worst = 0, n = 0;
  for (const e of [0, 1e-12, 1e-6, 0.1, 0.5, 0.9, 0.99, 0.999999, 1 - 1e-12]) {
    for (let k = -40; k <= 40; k++) {
      const M = Math.PI * k / 40;
      const E = solveKeplerElliptic(M, e);
      // residual measured in M, scaled by the local sensitivity dM/dE so that it is an error in E
      const res = Math.abs(E - e * Math.sin(E) - M) / Math.max(1 - e * Math.cos(E), 1e-12);
      worst = Math.max(worst, Math.min(res, Math.abs(E - R.solveKepler(M, e)))); n++;
    }
    for (const M of [1e-12, -1e-9, 1e-5, 3.1415926, -3.1415926, 7, -100.5]) {
      const E = solveKeplerElliptic(M, e), Er = R.solveKepler(M, e);
      let d = Math.abs(E - Er); d = Math.min(d, Math.abs(d - R.TAU));
      worst = Math.max(worst, Math.min(d, Math.abs(E - e * Math.sin(E) - (M - R.TAU * Math.round(M / R.TAU))))); n++;
    }
  }
  S.check(`Kepler's equation, elliptic: ${n} (M, e) pairs incl. e -> 0 and e -> 1, worst error in E`, 0, worst, 1e-9, { unit: 'rad' });
  worst = 0; n = 0;
  for (const e of [1 + 1e-12, 1 + 1e-6, 1.001, 1.5, 3, 20, 1000]) {
    for (const M of [0, 1e-12, -1e-8, 1e-3, 0.5, -2, 30, -400, 1e5]) {
      const F = solveKeplerHyperbolic(M, e);
      const res = Math.abs(e * Math.sinh(F) - F - M) / Math.max(e * Math.cosh(F) - 1, 1e-12);
      worst = Math.max(worst, res / Math.max(1, Math.abs(F))); n++;
    }
  }
  S.check(`Kepler's equation, hyperbolic: ${n} (M, e) pairs incl. e -> 1+, worst rel error in F`, 0, worst, 1e-9);

  // derived quantities of one awkward orbit against the reference
  const el = { a: 3e6, e: 0.6, i: 63.4, lan: 200, argp: 270, M0: 1 };
  const s0 = R.elementsToState(el, verda.gm, 0);
  const o = Orbit.fromState(V(s0.r), V(s0.v), SYSTEM.byId.verda.gm, 0);
  S.check('derived: periapsis radius a(1-e)', el.a * (1 - el.e), o.periapsis, 1e-3, { unit: 'm' });
  S.check('derived: apoapsis radius a(1+e)', el.a * (1 + el.e), o.apoapsis, 1e-3, { unit: 'm' });
  S.check('derived: period', R.orbitPeriod(verda.gm, el.a), o.period, 1e-6, { unit: 's' });
  S.check('derived: inclination', 63.4, o.inclination * 180 / Math.PI, 1e-9, { unit: 'deg' });
  S.check('derived: eccentricity', el.e, o.e, 1e-12);
  const nm = Math.sqrt(verda.gm / el.a ** 3);
  S.check('derived: time to periapsis (2pi - M0)/n', (R.TAU - 1) / nm, o.timeToPeriapsis(0), 1e-6, { unit: 's' });
  S.check('derived: time to apoapsis (pi - M0)/n', (Math.PI - 1) / nm, o.timeToApoapsis(0), 1e-6, { unit: 's' });
  // radius-crossing time: check by propagating the reference to that time
  const rq = 2.5e6, tq = o.timeAtRadius(rq, false, 0);
  S.check('derived: timeAtRadius lands on the requested radius', rq, R.norm(R.keplerUV(s0.r, s0.v, verda.gm, tq).r), 1e-3, { unit: 'm' });
  // prograde direction convention: counter-clockwise seen from +Y
  const eq = R.elementsToState({ a: 1e6, e: 0, i: 0, lan: 0, argp: 0, M0: 0 }, verda.gm, 0);
  S.check('frame: prograde equatorial orbit has angular momentum along +Y', 1, R.unit(R.cross(eq.r, eq.v))[1], 1e-12);
}

// vessel flown by World.step at each warp level, compared with exact Kepler from its initial state
function coastAtWarp(S, idx, s0, span, slice, label, tol) {
  const w = new World();
  const v = spawn(w, capsule(), 'verda', s0.r, s0.v);
  const got = w.setWarp(idx);
  if (got !== idx) { S.ok(`${label}: warp ${WARP_RATES[idx]}x allowed here`, false, `got index ${got}`); return; }
  const e0 = R.stateToElements(s0.r, s0.v, verda.gm);
  let worstE = 0, worstH = 0;
  const t0 = w.ut, end = t0 + span;
  while (w.ut < end - 1e-9) {
    w.step(Math.min(slice, (end - w.ut) / w.rate));
    const e = R.stateToElements(A(v.pos), A(v.vel), verda.gm);
    worstE = Math.max(worstE, Math.abs(e.energy / e0.energy - 1));
    worstH = Math.max(worstH, R.norm(R.sub(e.h, e0.h)) / e0.hmag);
  }
  S.ok(`${label}: still at ${WARP_RATES[idx]}x at the end`, w.warpIndex === idx);
  const ref = R.keplerUV(s0.r, s0.v, verda.gm, w.ut - t0);
  S.check(`${label}: energy conservation, worst rel drift`, 0, worstE, tol.e);
  S.check(`${label}: angular momentum conservation, worst rel drift`, 0, worstH, tol.e);
  S.check(`${label}: position error vs exact Kepler at the end`, 0, R.dist(A(v.pos), ref.r), tol.pos, { unit: 'm' });
  S.check(`${label}: velocity error vs exact Kepler at the end`, 0, R.dist(A(v.vel), ref.v), tol.vel, { unit: 'm/s' });
}

function conservation(S, long) {
  // low orbit (150 x 400 km) for the physics levels, high orbit (peri 2.2 R altitude) where every rails level is allowed
  const low = R.elementsToState({ a: verda.radius + 275e3, e: 125e3 / (verda.radius + 275e3), i: 28, lan: 40, argp: 10, M0: 0.4 }, verda.gm, 0);
  const high = R.elementsToState({ a: 4.2e6, e: 0.5, i: 40, lan: 10, argp: 70, M0: 2.5 }, verda.gm, 0);
  const Tlow = R.orbitPeriod(verda.gm, verda.radius + 275e3), Thigh = R.orbitPeriod(verda.gm, 4.2e6);
  S.ok('test orbit is high enough for the top warp level', 4.2e6 * 0.5 - verda.radius > railMinAltitude(SYSTEM.byId.verda, WARP_RATES.length - 1));
  for (let idx = 0; idx <= PHYSICS_WARP_MAX; idx++) {
    const orbits = long ? 2 : 0.25;
    coastAtWarp(S, idx, low, orbits * Tlow, 2, `physics ${WARP_RATES[idx]}x, low orbit, ${orbits} orbits`, { e: 1e-8, pos: idx ? 2 : 0.5, vel: 0.01 });
  }
  for (let idx = PHYSICS_WARP_MAX + 1; idx < WARP_RATES.length; idx++) {
    const orbits = long ? 200 : 20;
    coastAtWarp(S, idx, high, orbits * Thigh, 0.37, `rails ${WARP_RATES[idx]}x, high orbit, ${orbits} orbits`, { e: 1e-10, pos: 1, vel: 1e-3 });
  }
  // warp changes up and down, physics <-> rails, many times
  {
    const w = new World();
    const v = spawn(w, capsule(), 'verda', high.r, high.v);
    const seq = [0, 3, 6, 10, 5, 0, 8, 2, 9, 4, 1, 7, 10, 0, 6, 3, 10, 0];
    let jumps = 0;
    for (let k = 0; k < (long ? 4 : 1); k++) for (const idx of seq) {
      const before = { r: A(v.pos), v: A(v.vel), t: w.ut };
      w.setWarp(idx);
      // the switch itself must not move the vessel: one tiny step, compared with Kepler from just before
      w.step(1e-3 / w.rate);
      const ref = R.keplerUV(before.r, before.v, verda.gm, w.ut - before.t);
      jumps = Math.max(jumps, R.dist(A(v.pos), ref.r));
      for (let i = 0; i < 5; i++) w.step(idx <= PHYSICS_WARP_MAX ? 1 : 0.31);
    }
    const ref = R.keplerUV(high.r, high.v, verda.gm, w.ut);
    S.check('warp changes (72 switches, physics <-> rails): largest position jump at a switch', 0, jumps, 1e-3, { unit: 'm' });
    S.check(`warp changes: position error vs exact Kepler after ${(w.ut / Thigh).toFixed(1)} orbits`, 0, R.dist(A(v.pos), ref.r), 1, { unit: 'm' });
    S.check('warp changes: velocity error vs exact Kepler', 0, R.dist(A(v.vel), ref.v), 1e-3, { unit: 'm/s' });
  }
}

// physics stepping drift in a low orbit: the number players notice (apsides wandering while they watch)
function physicsDrift(S, long) {
  const r = verda.radius + 100e3;
  const s0 = { r: [r, 0, 0], v: [0, 0, -R.circularSpeed(verda.gm, r)] };
  const T = R.orbitPeriod(verda.gm, r);
  for (const idx of [0, PHYSICS_WARP_MAX]) {
    const orbits = long ? 10 : 1;
    const w = new World();
    const v = spawn(w, capsule(), 'verda', s0.r, s0.v);
    w.setWarp(idx);
    let minAlt = Infinity, maxAlt = -Infinity;
    const end = orbits * T;
    while (w.ut < end - 1e-9) {
      w.step(Math.min(2, (end - w.ut) / w.rate));
      const alt = v.pos.length() - verda.radius;
      minAlt = Math.min(minAlt, alt); maxAlt = Math.max(maxAlt, alt);
    }
    const ref = R.keplerUV(s0.r, s0.v, verda.gm, w.ut);
    const e = R.stateToElements(A(v.pos), A(v.vel), verda.gm);
    const lab = `100 km circular orbit, ${orbits} orbit${orbits > 1 ? 's' : ''} at ${WARP_RATES[idx]}x physics`;
    S.check(`${lab}: position error vs exact`, 0, R.dist(A(v.pos), ref.r), idx ? 5 : 1, { unit: 'm' });
    S.check(`${lab}: semi-major axis drift`, 0, Math.abs(e.a - r), 0.05, { unit: 'm' });
    S.check(`${lab}: altitude wander (max - min)`, 0, maxAlt - minAlt, 0.05, { unit: 'm' });
    S.check(`${lab}: eccentricity picked up`, 0, e.e, 1e-7);
  }
  // rails <-> physics hand-over in the low orbit: Kepler state continuity both ways
  {
    const w = new World();
    const v = spawn(w, capsule(), 'verda', s0.r, s0.v);
    run(w, 30, 1);
    const a = { r: A(v.pos), v: A(v.vel), t: w.ut };
    w.setWarp(6);                                     // 50x rails
    w.step(1);
    const refA = R.keplerUV(a.r, a.v, verda.gm, w.ut - a.t);
    S.check('physics -> rails (50x) hand-over: position vs Kepler from the last physics state', 0, R.dist(A(v.pos), refA.r), 1e-4, { unit: 'm' });
    S.check('physics -> rails (50x) hand-over: velocity', 0, R.dist(A(v.vel), refA.v), 1e-6, { unit: 'm/s' });
    const b = { r: A(v.pos), v: A(v.vel), t: w.ut };
    w.setWarp(0);
    w.step(0.5);
    const refB = R.keplerUV(b.r, b.v, verda.gm, w.ut - b.t);
    S.check('rails -> physics (1x) hand-over: position vs Kepler from the last rails state', 0, R.dist(A(v.pos), refB.r), 1e-4, { unit: 'm' });
    S.check('rails -> physics (1x) hand-over: velocity', 0, R.dist(A(v.vel), refB.v), 1e-6, { unit: 'm/s' });
  }
}

export const groups = [
  { name: '1a. Circular speed and period on every body', fast: true, run: S => circularOnEveryBody(S) },
  { name: '1b. Kepler propagation, all conic types and orientations', fast: true, run: (S, long) => propagation(S, long) },
  { name: "1c. Kepler's equation edge cases and derived quantities", fast: true, run: S => keplerEdgeCases(S) },
  { name: '1d. Conservation while coasting at every warp level and across warp changes', fast: true, run: (S, long) => conservation(S, long) },
  { name: '1e. Physics-step drift in low orbit and physics/rails hand-over', fast: true, run: (S, long) => physicsDrift(S, long) },
];
