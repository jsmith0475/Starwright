// Independent reference for body aerodynamics above the speed of sound (docs/REENTRY_SPEC.md part B).
//
// Nothing here imports the game's aerodynamics (js/core/aero.js, js/core/vessel.js). The curves, the wake rule, the
// blending weights and the shadow rule are typed a second time from the specification, and the Newtonian force is
// found a different way from the game: the part's surface is cut into flat triangles, each triangle's normal comes
// from the cross product of its edges, and the force is summed at the exact angle asked for (the game integrates
// analytic rings into a table every 2.5 degrees and interpolates).
//
// Part frame: the part's axis is +y, its centre is the origin, the bottom face is at y = -h/2.

// ------------------------------------------------------------------------------------------ the rules, restated
const M_PTS = [0.7, 0.9, 1.1, 1.5, 2.5, 4, 8];
const BLUNT = [1.00, 1.25, 1.55, 1.75, 1.90, 1.98, 2.00];
const SLENDER = [1.00, 1.40, 1.90, 1.60, 1.10, 0.90, 0.80];
function lerpTable(ys, m) {
  if (m <= M_PTS[0]) return ys[0];
  for (let i = 1; i < M_PTS.length; i++) if (m <= M_PTS[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (m - M_PTS[i - 1]) / (M_PTS[i] - M_PTS[i - 1]);
  return ys[ys.length - 1];
}
/** Multiplier on a face's low-speed coefficient c: slender below c = 0.2, blunt above c = 0.7, mixed between. */
export function rise(mach, c) {
  const b = Math.min(1, Math.max(0, (c - 0.2) / 0.5));
  return (1 - b) * lerpTable(SLENDER, mach) + b * lerpTable(BLUNT, mach);
}
export const riseBlunt = mach => lerpTable(BLUNT, mach);
/** The wake behind a lee face adds this fraction of the face: a quarter, falling as 1 / Mach^2 past Mach 1. */
export const wake = mach => 0.25 / Math.max(1, mach * mach);
const hermite = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
/** Share of the Newtonian force: none at Mach 1.5, all of it at Mach 4. */
export const newtonShare = mach => hermite((mach - 1.5) / 2.5);
/** How much shelter a wake gives: none at Mach 0.7, all at Mach 1.5. */
export const shadowShare = mach => hermite((mach - 0.7) / 0.8);
/** Rayleigh pitot: stagnation pressure coefficient behind a normal shock (isentropic below Mach 1). */
export function cpMax(mach, gamma) {
  const g = gamma, M2 = mach * mach;
  const p02 = mach <= 1
    ? Math.pow(1 + (g - 1) / 2 * M2, g / (g - 1))
    : Math.pow((g + 1) * M2 / 2, g / (g - 1)) * Math.pow((g + 1) / (2 * g * M2 - (g - 1)), 1 / (g - 1));
  return (p02 - 1) / (g / 2 * M2);
}

// ------------------------------------------------------------------------------------------ Newtonian force on a mesh
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Triangles of a part's wetted surface. geo = { rB, rT, h, covB, covT, capB, capT }: a frustum, with the open part
 * of each end face (outside the covered radius), flat or a spherical cap of the given half-angle (radians).
 * Each triangle is [p0, p1, p2] wound so that its normal points out of the body.
 */
export function mesh(geo, n = 240) {
  const { rB, rT, h, covB = 0, covT = 0, capB = 0, capT = 0 } = geo, tris = [];
  const ring = (r, y, j) => { const a = 2 * Math.PI * j / n; return [r * Math.cos(a), y, r * Math.sin(a)]; };
  const quad = (a, b, c, d, outward) => {            // two triangles, flipped if their normal points inward
    for (const t of [[a, b, c], [a, c, d]]) {
      const nrm = cross(sub(t[1], t[0]), sub(t[2], t[0]));
      const cen = [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3, (t[0][2] + t[1][2] + t[2][2]) / 3];
      tris.push(dot(nrm, outward(cen)) >= 0 ? t : [t[0], t[2], t[1]]);
    }
  };
  const NY = 40;
  if (h > 0) for (let i = 0; i < NY; i++) {
    const y0 = -h / 2 + h * i / NY, y1 = -h / 2 + h * (i + 1) / NY, r0 = rB + (rT - rB) * i / NY, r1 = rB + (rT - rB) * (i + 1) / NY;
    for (let j = 0; j < n; j++) quad(ring(r0, y0, j), ring(r0, y0, j + 1), ring(r1, y1, j + 1), ring(r1, y1, j), c => [c[0], 0, c[2]]);
  }
  for (const top of [true, false]) {
    const r = top ? rT : rB, cov = top ? covT : covB, cap = top ? capT : capB, s = top ? 1 : -1, yf = s * h / 2;
    if (!(r > cov)) continue;
    if (cap > 0 && cov === 0) {
      const Rn = r / Math.sin(cap), yc = yf - s * Rn * Math.cos(cap), NT = 40;
      for (let i = 0; i < NT; i++) {
        const t0 = cap * i / NT, t1 = cap * (i + 1) / NT;
        for (let j = 0; j < n; j++) quad(ring(Rn * Math.sin(t0), yc + s * Rn * Math.cos(t0), j), ring(Rn * Math.sin(t0), yc + s * Rn * Math.cos(t0), j + 1), ring(Rn * Math.sin(t1), yc + s * Rn * Math.cos(t1), j + 1), ring(Rn * Math.sin(t1), yc + s * Rn * Math.cos(t1), j), c => [c[0], c[1] - yc, c[2]]);
      }
    } else {
      const NR = 8;
      for (let i = 0; i < NR; i++) {
        const a0 = cov + (r - cov) * i / NR, a1 = cov + (r - cov) * (i + 1) / NR;
        for (let j = 0; j < n; j++) quad(ring(a0, yf, j), ring(a0, yf, j + 1), ring(a1, yf, j + 1), ring(a1, yf, j), () => [0, s, 0]);
      }
    }
  }
  return tris;
}

/**
 * Newtonian force and moment (about the origin) on a mesh moving through the air in the direction of the unit vector
 * u, per unit of q C_p,max: each triangle that faces the motion feels (n . u)^2 times its area, along -n.
 */
export function newton(tris, u) {
  const F = [0, 0, 0], M = [0, 0, 0];
  for (const t of tris) {
    const nA = cross(sub(t[1], t[0]), sub(t[2], t[0]));            // normal times twice the area
    const twoA = Math.hypot(nA[0], nA[1], nA[2]);
    if (!(twoA > 0)) continue;
    const c = dot(nA, u) / twoA;
    if (c <= 0) continue;
    const p = c * c * 0.5, f = [-p * nA[0], -p * nA[1], -p * nA[2]];   // (n.u)^2 * area * (-n) = -c^2 * (nA / 2)
    const cen = [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3, (t[0][2] + t[1][2] + t[2][2]) / 3];
    const m = cross(cen, f);
    for (let k = 0; k < 3; k++) { F[k] += f[k]; M[k] += m[k]; }
  }
  return { F, M };
}

// ------------------------------------------------------------------------------------------ one stack part
/**
 * Air force and moment (about the part's centre, part frame) on one stack part that is not spinning.
 *   geo   { rB, rT, h, covB, covT, capB, capT }
 *   cd    { top, bottom, side }   the part's low-speed coefficients
 *   v     [x, y, z] the part's velocity through the air in its own frame (m/s)
 *   env   { rho, mach, gamma, shade }   shade = 0 in the open to 1 wholly in a wake
 *   opt   { cpArm, tris }   FACE_CP (the game's empirical righting arm, data) and a cached mesh
 */
export function partWrench(geo, cd, v, env, opt = {}) {
  const { rB, rT, h, covB = 0, covT = 0 } = geo, { rho, mach, gamma, shade = 0 } = env;
  const sp = Math.hypot(v[0], v[1], v[2]), q = 0.5 * rho * sp * sp, u = [v[0] / sp, v[1] / sp, v[2] / sp];
  // classic: face areas outside what a neighbour covers; a cone's projected ring counts with its wide end's...
  let openT = Math.PI * Math.max(0, rT * rT - covT * covT), openB = Math.PI * Math.max(0, rB * rB - covB * covB);
  let rightT = openT * cd.top, rightB = openB * cd.bottom;                 // flat faces right the body; a flank ring does the opposite
  if (rB > rT) { const ringA = Math.PI * (rB * rB - rT * rT); openT += ringA; rightT -= ringA * cd.top; }
  else if (rT > rB) { const ringA = Math.PI * (rT * rT - rB * rB); openB += ringA; rightB -= ringA * cd.bottom; }
  const aT = openT * cd.top * rise(mach, cd.top), aB = openB * cd.bottom * rise(mach, cd.bottom);
  const aS = (rT + rB) * h * cd.side * riseBlunt(mach);
  const wk = wake(mach), ca = u[1];
  const Fc = [-q * aS * u[0], -q * (ca > 0 ? aT + wk * aB : aB + wk * aT) * ca, -q * aS * u[2]];
  const arm = (opt.cpArm || 0) * Math.max(rT, rB);
  const kR = arm * q * (ca > 0 ? rightT * rise(mach, cd.top) : -rightB * rise(mach, cd.bottom)) * Math.abs(ca);
  const Mc = [kR * u[2], 0, -kR * u[0]];
  const wN = newtonShare(mach), keep = 1 - 0.9 * shade * shadowShare(mach);
  const F = [0, 0, 0], M = [0, 0, 0];
  let Fn = [0, 0, 0], Mn = [0, 0, 0];
  if (wN > 0) { const r = newton(opt.tris || mesh(geo), u), k = q * cpMax(mach, gamma); Fn = r.F.map(x => x * k); Mn = r.M.map(x => x * k); }
  for (let k = 0; k < 3; k++) { F[k] = keep * ((1 - wN) * Fc[k] + wN * Fn[k]); M[k] = keep * ((1 - wN) * Mc[k] + wN * Mn[k]); }
  return { F, M, q };
}

/**
 * Drag area (m², force / q) of one stack part flying along its own axis, bottom first (or top first), by Mach number:
 * a table from Mach 0 to `top` in steps of `step`, and a function that reads it linearly.
 */
export function axialDrag(geo, cd, gamma, { bottomFirst = true, top = 12, step = 0.05 } = {}) {
  const tris = mesh(geo), n = Math.round(top / step), table = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const r = partWrench(geo, cd, [0, bottomFirst ? -1 : 1, 0], { rho: 2, mach: i * step, gamma }, { tris });   // q = 1
    table[i] = Math.abs(r.F[1]);
  }
  return mach => { const x = Math.min(n, Math.max(0, mach / step)), i = Math.min(n - 1, x | 0); return table[i] + (table[i + 1] - table[i]) * (x - i); };
}

/**
 * The shadow rule. A part of radius rp at `p`, a wider part of radius rc at `c` (both part centres, any common
 * frame), motion along the unit vector u. Returns 0 (in the open) to 1 (wholly in the wake).
 */
export function shade(p, rp, c, rc, u) {
  if (!(rc > rp * 1.02)) return 0;
  const d = sub(p, c), along = -dot(d, u);
  if (along <= 0) return 0;
  const perp = Math.sqrt(Math.max(0, dot(d, d) - along * along));
  const inside = Math.min(1, Math.max(0, 1 + (rc - perp - rp) / (0.5 * rp)));
  const diameters = along / (2 * rc);
  const fade = diameters <= 2 ? 1 : diameters >= 4 ? 0 : (4 - diameters) / 2;
  return inside * fade;
}
