// Group 5: model honesty. How far the game's patched conics are from n-body gravity. Rows are mostly INFO: they
// measure the model, they do not judge the code. The PASS/FAIL rows confirm that the game does follow patched conics
// in these cases and that the n-body reference itself is sound.
import { World, SYSTEM, A, simpleShip, spawn } from './harness.mjs';
import { gameCoast } from './gameflight.mjs';
import * as AP from '../../js/core/autopilot.js';
import * as R from './ref.mjs';

const sys = R.readSystem(), eph = new R.Ephemeris(sys);
const verda = sys.byId.verda, pell = sys.byId.pell, ost = sys.byId.ost, helion = sys.byId.helion;
const DAY = 86400, km = 1000;

/**
 * Vessel about Verda with the other bodies as perturbers. State relative to Verda (non-rotating frame).
 * `recoil` true: perturbing acceleration = direct pull minus the pull on Verda itself (what real gravity does: Verda
 * is pulled too). false: direct pull only, Verda nailed to its rail (the naive "add the moons' gravity" mode).
 * Helion always acts as a tide: Verda's rail IS its fall around Helion.
 */
function verdaFrame(perturbers, { recoil = true } = {}) {
  const posOf = (b, t) => b === helion ? R.scale(eph.rel(verda, t).r, -1) : eph.rel(b, t).r;
  return (t, s, o) => {
    const r3 = Math.pow(s[0] * s[0] + s[1] * s[1] + s[2] * s[2], 1.5);
    let ax = -verda.gm * s[0] / r3, ay = -verda.gm * s[1] / r3, az = -verda.gm * s[2] / r3;
    for (const b of perturbers) {
      const p = posOf(b, t);
      const dx = p[0] - s[0], dy = p[1] - s[1], dz = p[2] - s[2];
      const k = b.gm / Math.pow(dx * dx + dy * dy + dz * dz, 1.5);
      ax += k * dx; ay += k * dy; az += k * dz;
      if (recoil || b === helion) { const q = b.gm / Math.pow(p[0] * p[0] + p[1] * p[1] + p[2] * p[2], 1.5); ax -= q * p[0]; ay -= q * p[1]; az -= q * p[2]; }
    }
    o[0] = s[3]; o[1] = s[4]; o[2] = s[5]; o[3] = ax; o[4] = ay; o[5] = az;
  };
}
const st = y => ({ r: [y[0], y[1], y[2]], v: [y[3], y[4], y[5]] });

// ------------------------------------------------------------------------------------------ 5a low Verda orbit, 30 days
function lowOrbit(S, long) {
  const r0 = verda.radius + 120e3, vc = R.circularSpeed(verda.gm, r0), T = R.orbitPeriod(verda.gm, r0);
  const inc = 30 * Math.PI / 180;
  const s0 = { r: [r0, 0, 0], v: [0, vc * Math.sin(inc), -vc * Math.cos(inc)] };
  // soundness of the integrator on this very orbit: no perturbers, 30 days = ~1200 orbits, against the closed form
  const days = long ? 30 : 5;
  {
    const y = Float64Array.from([...s0.r, ...s0.v]);
    R.integrate(verdaFrame([]), y, 0, days * DAY, { rtol: 1e-13, h0: T / 40 });
    const k = R.keplerUV(s0.r, s0.v, verda.gm, days * DAY);
    S.check(`reference integrator alone, ${days} days (${Math.round(days * DAY / T)} orbits) vs closed-form Kepler`, 0, R.dist(st(y).r, k.r), 1, { unit: 'm', note: 'soundness of the reference' });
  }
  // the game: rails at top warp is Kepler
  const g = gameCoast({ body: verda, r: s0.r, v: s0.v, t: 0 }, days * DAY, { mode: 'active' });
  const kep = R.keplerUV(s0.r, s0.v, verda.gm, days * DAY);
  S.check(`game, ${days} days at up to 100 000x: position vs closed-form Kepler (it IS two-body)`, 0, R.dist(g.end.r, kep.r), 0.05, { unit: 'm' });
  const y = Float64Array.from([...s0.r, ...s0.v]), yNaive = Float64Array.from(y), ySun = Float64Array.from(y);
  const full = verdaFrame([helion, pell, ost]), naive = verdaFrame([helion, pell, ost], { recoil: false }), sunOnly = verdaFrame([helion]);
  const e0 = R.stateToElements(s0.r, s0.v, verda.gm);
  let t = 0;
  const t0w = Date.now();
  for (const d of (long ? [1, 10, 30] : [1, 5])) {
    R.integrate(full, y, t, d * DAY, { rtol: 1e-12, h0: T / 40 });
    R.integrate(naive, yNaive, t, d * DAY, { rtol: 1e-12, h0: T / 40 });
    R.integrate(sunOnly, ySun, t, d * DAY, { rtol: 1e-12, h0: T / 40 });
    t = d * DAY;
    const k = R.keplerUV(s0.r, s0.v, verda.gm, t), n = st(y), el = R.stateToElements(n.r, n.v, verda.gm);
    const dr = R.sub(n.r, k.r), along = R.dot(dr, R.unit(k.v)), cross = R.dot(dr, R.unit(R.cross(k.r, k.v))), radial = R.dot(dr, R.unit(k.r));
    S.info(`low Verda orbit (120 km, 30 deg), day ${d}: n-body minus the game's Kepler orbit, total`, R.norm(dr) / km, 'km', `along-track ${(along / km).toFixed(2)}, radial ${(radial / km).toFixed(3)}, out-of-plane ${(cross / km).toFixed(3)} km`);
    S.info(`  day ${d}: change of semi-major axis / periapsis / apoapsis / inclination`, `${(el.a - e0.a).toFixed(1)} m / ${(el.rp - e0.rp).toFixed(1)} m / ${(el.ra - e0.ra).toFixed(1)} m / ${((el.inc - e0.inc) * 180 / Math.PI * 3600).toFixed(2)} arcsec`, '', 'the orbit keeps its size and shape: the error is a slow slide along the track');
    S.info(`  day ${d}: of which Helion's tide alone`, R.dist(st(ySun).r, k.r) / km, 'km');
    S.info(`  day ${d}: naive n-body (moons pull the ship but Verda stays on its rail) minus proper n-body`, R.dist(st(yNaive).r, n.r) / km, 'km', 'what a careless n-body mode would add: the missing recoil of Verda');
  }
  S.info('cost of the reference n-body integration (3 models), wall clock per simulated day', (Date.now() - t0w) / (long ? 30 : 5) / 3, 'ms', 'order-16 extrapolation at 1e-12; a game mode would use a cheaper symplectic step');
  // size of the neglected accelerations
  const tidePell = 2 * pell.gm * r0 / pell.elements.a ** 3, tideSun = 2 * helion.gm * r0 / verda.elements.a ** 3, g0 = verda.gm / r0 ** 2;
  S.info('neglected accelerations in low orbit: Pell tide / Helion tide / Verda gravity', `${tidePell.toExponential(2)} / ${tideSun.toExponential(2)} / ${g0.toFixed(2)}`, 'm/s2', `ratio ${(tidePell / g0).toExponential(1)}`);
}

// ------------------------------------------------------------------------------------------ 5b Verda to Pell
function toPell(S) {
  const r1 = verda.radius + 120e3;
  const w = new World();
  const v = spawn(w, simpleShip(), 'verda', [r1, 0, 0], [0, 0, -R.circularSpeed(verda.gm, r1)]);
  const plan = AP.planHohmannToMoon(w, v, SYSTEM.byId.pell);
  if (!S.ok('planner gives a transfer to Pell to compare on', !!plan)) return;
  const at = R.keplerUV([r1, 0, 0], [0, 0, -R.circularSpeed(verda.gm, r1)], verda.gm, plan.node.t);
  const s0 = { r: at.r, v: R.add(at.v, R.scale(R.unit(at.v), plan.dv)) }, t0 = plan.node.t;
  // patched conics (independent reference; group 3 shows the game agrees with it to millimetres)
  const pc = R.refPatched(sys, eph, { body: verda, r: s0.r, v: s0.v, t: t0 }, t0 + 4e5, { maxEvents: 1 });
  const ent = pc.events.find(e => e.type === 'enter' && e.to.id === 'pell');
  if (!S.ok('patched conics: the transfer enters the SOI of Pell', !!ent)) return;
  const el = R.stateToElements(ent.r, ent.v, pell.gm);
  const nuIn = Math.atan2(R.dot(ent.r, ent.v) * Math.sqrt(el.p / pell.gm), el.p - R.norm(ent.r));       // true anomaly (< 0 inbound)
  const F = 2 * Math.atanh(Math.sqrt((el.e - 1) / (el.e + 1)) * Math.tan(nuIn / 2));
  const tPe = ent.t - (el.e * Math.sinh(F) - F) / Math.sqrt(pell.gm / (-el.a) ** 3);
  const run = (perturbers, opts) => {
    const y = Float64Array.from([...s0.r, ...s0.v]);
    const f = verdaFrame(perturbers, opts);
    let t = t0, best = { d: Infinity }, atEntry = null, prev = [];
    const tEnd = tPe + 30000, step = 30;
    R.integrate(f, y, t, ent.t, { rtol: 1e-12, atol: 1e-9, h0: 50 }); t = ent.t; atEntry = st(y);
    while (t < tEnd) {
      R.integrate(f, y, t, t + step, { rtol: 1e-12, atol: 1e-9, h0: step }); t += step;
      const d = R.dist(st(y).r, eph.rel(pell, t).r);
      prev.push({ t, d }); if (prev.length > 3) prev.shift();
      if (prev.length === 3 && prev[1].d < prev[0].d && prev[1].d <= prev[2].d && prev[1].d < best.d) {
        // parabola through three samples
        const [a, b, c] = prev, den = a.d - 2 * b.d + c.d, x = 0.5 * (a.d - c.d) / den;
        best = { d: b.d - 0.25 * (a.d - c.d) * x, t: b.t + x * step };
      }
    }
    return { best, atEntry };
  };
  const pcAtEntry = R.add(ent.r, eph.rel(pell, ent.t).r);
  const two = run([pell]), all = run([pell, helion, ost]), naive = run([pell, helion, ost], { recoil: false });
  S.info('Verda to Pell: patched-conic periapsis at Pell (altitude) and time after the burn', `${((el.rp - pell.radius) / km).toFixed(1)} km at ${((tPe - t0) / 3600).toFixed(2)} h`, '', `departure burn ${plan.dv.toFixed(1)} m/s from a 120 km orbit`);
  const row = (label, n) => {
    S.info(`  ${label}: position difference from patched conics at the SOI edge`, R.dist(n.atEntry.r, pcAtEntry) / km, 'km');
    S.info(`  ${label}: closest approach to Pell (altitude) / shift vs patched conics / time shift`, `${((n.best.d - pell.radius) / km).toFixed(1)} km / ${((n.best.d - el.rp) / km).toFixed(1)} km / ${(n.best.t - tPe).toFixed(0)} s`, '', n.best.d < pell.radius ? 'IMPACT in n-body' : '');
  };
  row('n-body, Verda + Pell', two); row('n-body, Verda + Pell + Helion + Ost', all); row('naive n-body (no recoil of Verda)', naive);
  // what the miss costs: delta-v at the departure burn that moves the periapsis by that much (patched-conic sensitivity)
  const pe = dv => {
    const p = R.refPatched(sys, eph, { body: verda, r: s0.r, v: R.add(s0.v, R.scale(R.unit(s0.v), dv)), t: t0 }, t0 + 4e5, { maxEvents: 1 });
    const e = p.events.find(x => x.type === 'enter' && x.to.id === 'pell');
    return e ? R.stateToElements(e.r, e.v, pell.gm).rp : NaN;
  };
  const sens = (pe(0.05) - pe(-0.05)) / 0.1;
  S.info('  periapsis sensitivity to the departure burn', sens / km, 'km per m/s', `so the n-body shift equals a ${Math.abs((all.best.d - el.rp) / sens).toFixed(2)} m/s error at departure, or a few m/s of mid-course correction`);
}

// ------------------------------------------------------------------------------------------ 5c Lagrange points
function lagrange(S, long) {
  const a = pell.elements.a, m1 = verda.gm, m2 = pell.gm, M = m1 + m2, mu = m2 / M;
  const w = Math.sqrt(M / a ** 3);                       // true mutual rate
  const wRails = Math.sqrt(m1 / a ** 3);                 // the game's Pell: period from Verda's mass alone
  S.info('Verda-Pell: mass ratio / L4-L5 stable below', `${mu.toFixed(5)} / 0.03852`, '', 'L4 and L5 would be stable in this system');
  S.info('Pell orbital period: game rail (Verda mass only) / two-body with both masses', `${(R.TAU / wRails).toFixed(0)} / ${(R.TAU / w).toFixed(0)}`, 's', `${((w / wRails - 1) * 100).toFixed(3)} % apart`);
  // L1 distance from Pell (collinear equilibrium of the rotating frame), by bisection
  const fL1 = d => m1 / (a - d) ** 2 - m2 / d ** 2 - w * w * (a * (1 - mu) - d);
  let lo = 1e5, hi = a / 2; for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (fL1(lo) * fL1(mid) <= 0) hi = mid; else lo = mid; }
  const dL1 = (lo + hi) / 2;
  const hh = Math.cbrt(mu / 3);
  S.check('L1 distance from Pell vs the series a h (1 - h/3 - h^2/9), h = (mu/3)^(1/3)', a * hh * (1 - hh / 3 - hh * hh / 9), dL1, 0.01, { rel: true, unit: 'm' });
  S.info('L1 distance from Pell / radius of the game\'s SOI of Pell', `${(dL1 / km).toFixed(0)} / ${(pell.soiLaplace / km).toFixed(0)}`, 'km', 'L1 (and L2) lie INSIDE the SOI: there the game applies Pell\'s gravity only');

  // self-consistent three-body problem (Verda and Pell both move; no Helion), barycentric, rotation about +Y like the game
  const full = R.fullNBodyDeriv([m1, m2, 0]);
  const rot = p => [w * p[2], 0, -w * p[0]];            // omega x p for omega = (0, w, 0) ... prograde in the game frame is -Y
  const spin = p => R.scale(rot(p), -1);
  const body1 = [-a * mu, 0, 0], body2 = [a * (1 - mu), 0, 0];
  const frame = t => { const c = Math.cos(w * t), s = Math.sin(w * t); return p => [p[0] * c - p[2] * s, 0, p[0] * s + p[2] * c].map((x, i) => i === 1 ? p[1] : x); };
  const threeBody = (p0, tEnd, samples) => {
    const y = Float64Array.from([...body1, ...spin(body1), ...body2, ...spin(body2), ...p0, ...spin(p0)]);
    let t = 0, worst = 0; const out = [];
    for (let i = 1; i <= samples; i++) {
      const tt = tEnd * i / samples;
      R.integrate(full, y, t, tt, { rtol: 1e-13, h0: 500 }); t = tt;
      // where the point would be if it had kept its place in the rotating frame: rotate p0 by the angle Pell has turned
      const ang = Math.atan2(y[6 + 2] - y[2], y[6] - y[0]);
      const c = Math.cos(ang), s = Math.sin(ang);
      const home = [y[0] + (p0[0] - body1[0]) * c - (p0[2] - body1[2]) * s, 0, y[2] + (p0[0] - body1[0]) * s + (p0[2] - body1[2]) * c];
      const d = R.dist([y[12], y[13], y[14]], home);
      worst = Math.max(worst, d); out.push({ t, d });
    }
    return { worst, out, sep: Math.hypot(y[6] - y[0], y[8] - y[2]) };
  };
  const span = (long ? 30 : 10) * DAY;
  // ---- L4: 60 degrees ahead of Pell
  const L4 = [body1[0] + a * 0.5, 0, -a * Math.sqrt(3) / 2];
  const exact = threeBody(L4, span, 60);
  S.check(`three-body reference: a ship placed exactly at L4 stays there for ${span / DAY} days`, 0, exact.worst, 1, { unit: 'm', note: 'soundness of the reference' });
  const off = threeBody(R.add(L4, R.scale(R.unit(R.sub(L4, body1)), 10e3)), span, 240);
  S.info(`three-body: ship released 10 km outside L4, largest distance from L4 in ${span / DAY} days`, off.worst / km, 'km', 'bounded: it circles the point (libration)');
  // the game: ship on Verda's rail-frame circular orbit 60 deg ahead of Pell, with and without the 10 km offset
  const p0 = eph.rel(pell, 0), n = R.unit(R.cross(p0.r, p0.v));
  const ahead = (x, ang) => R.add(R.scale(x, Math.cos(ang)), R.scale(R.cross(n, x), Math.sin(ang)));
  const gameL4 = (extra) => {
    const dir = ahead(R.unit(p0.r), Math.PI / 3), r = R.scale(dir, a + extra), vdir = R.unit(R.cross(n, dir));
    const s0 = { body: verda, r, v: R.scale(vdir, wRails * (a + extra)), t: 0 };     // at rest in the frame turning with Pell
    const g = gameCoast(s0, span, { mode: 'active' });
    const pe = eph.rel(pell, span).r, home = R.scale(ahead(R.unit(pe), Math.PI / 3), a + extra);
    return { d: R.dist(g.end.r, home), sameBody: g.end.bodyId === 'verda', events: g.events.length };
  };
  const g0 = gameL4(0), g10 = gameL4(10e3);
  S.check(`game: ship exactly at "L4" of the rails (60 deg ahead on Pell's orbit) after ${span / DAY} days`, 0, g0.d, 5, { unit: 'm', note: 'stays for ever: but ANY phase angle does, the point is not special in the game' });
  S.info(`game: ship released 10 km outside L4, distance from L4 after ${span / DAY} days`, g10.d / km, 'km', 'unbounded steady drift (a slightly longer Kepler period), no libration');
  // any other phase is just as "stable" in the game: 20 deg ahead, where real gravity would carry the ship off
  {
    const dir = ahead(R.unit(p0.r), 20 * Math.PI / 180), r = R.scale(dir, a), s0 = { body: verda, r, v: R.scale(R.unit(R.cross(n, dir)), wRails * a), t: 0 };
    const g = gameCoast(s0, span, { mode: 'active' });
    const home = R.scale(ahead(R.unit(eph.rel(pell, span).r), 20 * Math.PI / 180), a);
    const p20 = [body1[0] + a * Math.cos(20 * Math.PI / 180), 0, -a * Math.sin(20 * Math.PI / 180)];
    const real = threeBody(p20, span, 240);
    S.info(`ship 20 deg ahead of Pell on its orbit, ${span / DAY} days: drift in the game / in the three-body problem`, `${(R.dist(g.end.r, home) / km).toFixed(3)} / ${(real.worst / km).toFixed(0)}`, 'km', 'real gravity sends it on a horseshoe or tadpole path; the game keeps it frozen in place');
  }
  // ---- L1
  const L1 = [body2[0] - dL1, 0, 0];
  const l1 = threeBody(R.add(L1, [1, 0, 0]), 2 * DAY, 48);
  const at = h => l1.out.find(o => o.t >= h * 3600 - 1).d;
  S.info('three-body: ship 1 m from L1, distance from L1 after 6 h / 12 h / 24 h / 48 h', `${at(6).toFixed(1)} m / ${at(12).toFixed(0)} m / ${(at(24) / km).toFixed(2)} km / ${(at(48) / km).toFixed(0)} km`, '', 'unstable, but it can be held for a few cm/s per day');
  // the game: at rest in the frame turning with Pell, on the Pell-Verda line, dL1 from Pell -> inside the SOI
  const rel0 = { r: R.scale(R.unit(p0.r), -dL1), v: R.scale(R.unit(R.cross(n, R.unit(p0.r))), -wRails * dL1) };
  const elp = R.stateToElements(rel0.r, rel0.v, pell.gm);
  S.info('game: a ship parked at L1 is on this orbit around Pell', `${((elp.rp - pell.radius) / km).toFixed(0)} x ${((elp.ra - pell.radius) / km).toFixed(0)} km, period ${(elp.period / 3600).toFixed(1)} h`, '', 'Verda\'s pull, which balances Pell\'s at L1, is switched off inside the SOI');
  const g = gameCoast({ body: pell, r: rel0.r, v: rel0.v, t: 0 }, DAY, { mode: 'active' });
  const kep = R.keplerUV(rel0.r, rel0.v, pell.gm, DAY);
  S.check('game: that ship after 24 h vs the Kepler orbit around Pell (the game follows its model exactly)', 0, R.dist(g.end.r, kep.r), 0.05, { unit: 'm' });
  let worstGame = 0, at6 = 0;
  for (let i = 1; i <= 96; i++) {
    const t = DAY * i / 96, k = R.keplerUV(rel0.r, rel0.v, pell.gm, t), home = R.scale(R.unit(eph.rel(pell, t).r), -dL1);
    const d = R.dist(k.r, home); worstGame = Math.max(worstGame, d); if (i === 24) at6 = d;
  }
  S.info('game: distance of that ship from the L1 point after 6 h / largest in 24 h', `${(at6 / km).toFixed(0)} / ${(worstGame / km).toFixed(0)}`, 'km', 'there is no L1, L2 or L3 in the game');
}

export const groups = [
  { name: '5a. Model honesty: low Verda orbit for 30 days, patched conics vs n-body', fast: false, run: (S, long) => lowOrbit(S, long) },
  { name: '5b. Model honesty: Verda to Pell transfer, patched conics vs n-body', fast: false, run: S => toPell(S) },
  { name: '5c. Model honesty: Verda-Pell L4 and L1, patched conics vs the three-body problem', fast: false, run: (S, long) => lagrange(S, long) },
];
