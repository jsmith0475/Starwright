// Independent reference for parachutes (verification group 13). It shares no code with js/core/parachute.js or
// js/core/vessel.js: the constants are typed here a second time on purpose, the cloth length is integrated with a
// different rule, and the descent is a plane two-body problem (a point mass under a point canopy on a rigid line)
// integrated with classical Runge-Kutta at 1 ms, where the game is a 3D rigid body stepped semi-implicitly at 20 ms.
//
// The model, as docs/PARACHUTES.md states it:
//   cloth      a flat round canopy, nominal diameter D0, drag coefficient 0.8 on its cloth area
//   inflated   mouth 0.67 D0 across when fully open; any other drag area is that of a canopy of the same coefficient
//              on its inflated disc; the cloth from skirt to apex is D0/2 long
//   lines      D0 long, on a riser 0.1 D0 long
//   filling    the mouth fills over 3 D0 of travel; the reefing line pays out from 3 % to all of the reefed drag
//              area over 6 s; the last stage opens over 4 D0 of travel with the square of the fraction travelled
//   air        1.5 x the half ellipsoid the canopy encloses moves with it (inertia, no weight)

export const K = {
  cdPerArea: 1.6, cd0: 0.8, proj: 0.67, line: 1.0, riser: 0.10, stretch: 3, reefFirst: 0.03, reefTime: 6,
  disreef: 4, disreefExp: 2, added: 1.5, skirtFull: 0.12, skirtReefed: 0.95, minMass: 1,
};

/** Numbers of a parachute part from its `chute` block alone. */
export function spec(chute) {
  const n = chute.count || 1, cdsFull = chute.area * K.cdPerArea, cdsReef = chute.semiArea * K.cdPerArea;
  const d0 = 2 * Math.sqrt(cdsFull / n / (Math.PI * K.cd0));
  return { n, cdsFull, cdsReef, d0, gore: d0 / 2, line: K.line * d0, riser: K.riser * d0, rFull: K.proj * d0 / 2, strength: chute.strength * 1000, maxMach: chute.maxMach, fullAlt: chute.fullAlt };
}

// arc length from the apex to the skirt on r = rm sin(phi), y = c cos(phi): composite Simpson, 400 panels
function arc(rm, c, end) {
  const n = 400, h = end / n, f = p => Math.hypot(rm * Math.cos(p), c * Math.sin(p));
  let s = f(0) + f(end);
  for (let i = 1; i < n; i++) s += f(i * h) * (i % 2 ? 4 : 2);
  return s * h / 3;
}

/** Shape of one canopy making `cds` m² of drag area (all canopies together). */
export function shape(sp, cds) {
  const cdp = K.cd0 / (K.proj * K.proj);
  let rm = Math.sqrt(cds / sp.n / (Math.PI * cdp));
  rm = Math.min(sp.rFull, Math.max(0.02 * sp.rFull, rm));
  const e = rm / sp.rFull, x = Math.min(1, Math.max(0, (e - 0.1) / 0.8)), sm = x * x * (3 - 2 * x);
  const delta = K.skirtReefed + (K.skirtFull - K.skirtReefed) * sm, end = Math.PI / 2 + delta;
  // crown height by the secant method on arc(c) = gore
  let c0 = 0.2 * rm, c1 = sp.gore, f0 = arc(rm, c0, end) - sp.gore, f1 = arc(rm, c1, end) - sp.gore;
  for (let i = 0; i < 60 && Math.abs(f1) > 1e-11; i++) {
    const c2 = c1 - f1 * (c1 - c0) / (f1 - f0);
    c0 = c1; f0 = f1; c1 = Math.max(1e-4, c2); f1 = arc(rm, c1, end) - sp.gore;
  }
  const c = c1, rs = rm * Math.cos(delta), drop = c * Math.sin(delta), h = Math.sqrt(sp.line * sp.line - rs * rs);
  const tilt = sp.n > 1 ? Math.asin(Math.min(0.9, 1.03 * rm / Math.sin(Math.PI / sp.n) / (h + drop))) : 0;
  return { rm, c, delta, rs, drop, h, tilt, L: sp.riser + (h + drop) * Math.cos(tilt), cloth: arc(rm, c, end) };
}

export const addedMass = (sp, sh, rho) => sp.n * K.added * rho * (2 / 3) * Math.PI * sh.rm * sh.rm * sh.c;

/** Drag area in a stage: 'reefed' after s metres and t seconds, 'full' after s metres from drag area `from`. */
export function dragArea(sp, stage, s, t, from = sp.cdsReef) {
  if (stage === 'reefed') {
    const mouth = Math.min(1, s / (K.stretch * sp.d0)), reef = Math.min(1, K.reefFirst + (1 - K.reefFirst) * t / K.reefTime);
    return sp.cdsReef * mouth * reef;
  }
  const f = Math.min(1, s / (K.disreef * sp.d0));
  return from + (sp.cdsFull - from) * Math.pow(f, K.disreefExp);
}

/**
 * Fly a point mass under one parachute in a vertical plane.
 *   o.mass (kg), o.capCdA (m², the craft's own drag area, or a function of (speed, h)), o.sp (spec), o.stage ('reefed' | 'full'), o.from,
 *   o.rho(h), o.g (m/s², downward, constant), o.h (m), o.vx, o.vy (m/s, vy up), o.theta (rad, line from vertical),
 *   o.omega (rad/s), o.s, o.t0 (progress of the stage at the start), o.tEnd (s), o.dt (s, default 1 ms), o.every (s)
 * → rows { t, h, x, vx, vy, speed, theta, T, cds, s }
 */
export function fly(o) {
  const M = o.mass, sp = o.sp, dt = o.dt || 1e-3, rows = [];
  // state: x, h, vx, vy, theta, omega, s
  let y = [0, o.h, o.vx || 0, o.vy, o.theta ?? Math.atan2(-(o.vx || 0), -o.vy), o.omega || 0, o.s || 0];
  let t = 0, lastT = 0;
  const deriv = (y, t) => {
    const [, h, vx, vy, th, om, s] = y, rho = o.rho(h), tt = (o.t0 || 0) + t;
    const cds = dragArea(sp, o.stage, s, tt, o.from), sh = shape(sp, cds), L = sh.L;
    const ex = Math.sin(th), ey = Math.cos(th), tx = Math.cos(th), ty = -Math.sin(th);
    const cvx = vx + L * om * tx, cvy = vy + L * om * ty, cs = Math.hypot(cvx, cvy);
    // air newly taken along: d(m_a)/dt along the path, by a forward difference
    const ma = addedMass(sp, sh, rho), eps = 1e-4;
    const ma2 = addedMass(sp, shape(sp, dragArea(sp, o.stage, s + cs * eps, tt + eps, o.from)), rho);
    const mdot = Math.max(0, (ma2 - ma) / eps), m = Math.max(ma, K.minMass);
    const kap = 0.5 * rho * cs * cds + mdot;
    const sv = Math.hypot(vx, vy), cap = typeof o.capCdA === 'function' ? o.capCdA(sv, h) : o.capCdA;
    const fcx = -0.5 * rho * sv * vx * cap, fcy = -0.5 * rho * sv * vy * cap;
    // along the line: T (1 + m/M) = -kap Vc.e - m (g.e + Fc.e / M - L om^2), g = (0, -g)
    const ge = -o.g * ey, gt = -o.g * ty;
    let T = (-kap * (cvx * ex + cvy * ey) - m * (ge + (fcx * ex + fcy * ey) / M - L * om * om)) / (1 + m / M);
    if (T < 0) T = 0;
    // across it: m (A.t + L om') = -kap Vc.t, A = g + (Fc + T e) / M
    const al = (-kap * (cvx * tx + cvy * ty) / m - (gt + (fcx * tx + fcy * ty) / M)) / L;
    lastT = T;
    return [vx, vy, (fcx + T * ex) / M, -o.g + (fcy + T * ey) / M, om, al, cs];
  };
  const step = (y, t, h) => {
    const k1 = deriv(y, t), k2 = deriv(y.map((v, i) => v + 0.5 * h * k1[i]), t + 0.5 * h);
    const k3 = deriv(y.map((v, i) => v + 0.5 * h * k2[i]), t + 0.5 * h), k4 = deriv(y.map((v, i) => v + h * k3[i]), t + h);
    return y.map((v, i) => v + h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  };
  const every = o.every || 0.1;
  let next = 0;
  while (t <= o.tEnd + 1e-9) {
    if (t >= next - 1e-9) {
      deriv(y, t);
      const cds = dragArea(sp, o.stage, y[6], (o.t0 || 0) + t, o.from);
      rows.push({ t, x: y[0], h: y[1], vx: y[2], vy: y[3], speed: Math.hypot(y[2], y[3]), theta: y[4], T: lastT, cds, s: y[6] });
      next += every;
    }
    y = step(y, t, dt); t += dt;
  }
  return rows;
}

/** Steady sinking speed under drag area cds with the craft's own capCdA: weight = drag. */
export const sinkSpeed = (mass, g, rho, cds, capCdA) => Math.sqrt(2 * mass * g / (rho * (cds + capCdA)));
