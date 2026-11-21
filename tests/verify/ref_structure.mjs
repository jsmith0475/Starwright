// Independent reference for joint loads (docs/STRUCTURE.md). NOTHING in this file imports js/core.
//
// The game gets the load in a joint by cutting the vessel there and summing m*a - F over the parts beyond the cut.
// This file never forms such a sum. It uses the MULTIBODY formulation instead:
//
//   every part is its own rigid body with its own unknown acceleration a_i and angular acceleration alpha_i;
//   every joint is a weld with an unknown constraint wrench (force Fc and moment Mc at the joint point p, defined
//   as what the parent body does to the child body); for every body Newton and Euler are written about its OWN
//   mass centre; every weld adds the kinematic conditions "same angular acceleration" and "same acceleration of the
//   joint point". All of that is one dense linear system, solved by Gaussian elimination (own code, below).
//
// Two modes:
//   multibodyDynamic(bodies, joints, w)          unknowns: a_i, alpha_i (6 N) and the wrenches (6 (N-1)). The rigid-body
//       motion (alpha, f) is DERIVED, not given, with the assembly's full inertia tensor (products of inertia included,
//       since each body only knows its own diagonal inertia and where it is). Used by: the closed-form cases of 7a
//       (lateral rod and one-booster-out, as a check of this reference itself and of the game's solver), the random
//       trees of 7b (the game's solver is then fed the derived motion), and in 7e ONLY to judge the motion the live
//       game reports (motion.f on every craft; motion.alpha and "no residual" on craft that are symmetric, reported
//       but not judged on the lopsided one). No live joint load is judged with this mode.
//   multibodyPrescribed(bodies, joints, motion)  the motion {w, alpha, f} is GIVEN (the game flies with a diagonal
//       vessel inertia, so for an asymmetric craft its alpha is not the alpha of the true tensor, and it divides thrust
//       by a mid-step mass). The body accelerations then follow from rigid kinematics and the 6 N body equations are
//       solved for the 6 (N-1) joint wrenches plus ONE extra unknown wrench acting on the root body's mass centre:
//       the "residual", i.e. what would have to act on the root for the prescribed motion to be the true one. This is
//       not a least-squares fit: it states where the inconsistency goes (to the root, which is what a cut that sums the
//       far side implies) and reports its size. residual = 0 when the prescribed motion is the dynamically right one.
//       Used by: 7b (random inconsistent motion) and by EVERY live comparison of joint loads: 7e (each step of five
//       flights) and 7h (which joint breaks, when, at what utilisation).
//
// Also here: closed-form textbook cases (rod, spinning rod, lateral end load, torsion, boosters) and the thin-ring
// line loads obtained by numerical quadrature from "plane sections stay plane" instead of from the peak formulas.

// ------------------------------------------------------------------------------------------ small vector kit
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = a => Math.hypot(a[0], a[1], a[2]);

/** Seeded PRNG (mulberry32): deterministic checks, no Math.random. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------------------------------ dense linear solver
/**
 * Solve A x = b (A: array of rows, modified copies are made). Gaussian elimination with scaled partial pivoting and
 * two rounds of iterative refinement. Throws on a singular matrix.
 */
export function solveDense(A, b) {
  const n = b.length;
  const LU = A.map(r => Float64Array.from(r));
  const perm = Array.from({ length: n }, (_, i) => i);
  const sc = LU.map(r => { let m = 0; for (let j = 0; j < n; j++) m = Math.max(m, Math.abs(r[j])); if (!(m > 0)) throw new Error('solveDense: empty row'); return 1 / m; });
  for (let k = 0; k < n; k++) {
    let best = -1, bi = k;
    for (let i = k; i < n; i++) { const v = Math.abs(LU[i][k]) * sc[i]; if (v > best) { best = v; bi = i; } }
    if (!(best > 1e-14)) throw new Error('solveDense: singular matrix at column ' + k);
    if (bi !== k) { [LU[k], LU[bi]] = [LU[bi], LU[k]]; [sc[k], sc[bi]] = [sc[bi], sc[k]]; [perm[k], perm[bi]] = [perm[bi], perm[k]]; }
    const rk = LU[k], piv = rk[k];
    for (let i = k + 1; i < n; i++) {
      const ri = LU[i], f = ri[k] / piv;
      ri[k] = f;                                   // keep the multiplier (L)
      if (f !== 0) for (let j = k + 1; j < n; j++) ri[j] -= f * rk[j];
    }
  }
  const lusolve = rhs => {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = rhs[perm[i]]; const r = LU[i]; for (let j = 0; j < i; j++) s -= r[j] * y[j]; y[i] = s; }
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; const r = LU[i]; for (let j = i + 1; j < n; j++) s -= r[j] * y[j]; y[i] = s / r[i]; }
    return y;
  };
  const x = lusolve(b);
  for (let it = 0; it < 2; it++) {
    const res = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = b[i]; const r = A[i]; for (let j = 0; j < n; j++) s -= r[j] * x[j]; res[i] = s; }
    const d = lusolve(res);
    for (let i = 0; i < n; i++) x[i] += d[i];
  }
  return Array.from(x);
}

// ------------------------------------------------------------------------------------------ multibody system
// helpers to write "coefficient x cross (unknown vector)" and "c cross (unknown vector)" into rows
function putEye(A, row, col, k) { for (let i = 0; i < 3; i++) A[row + i][col + i] += k; }
/** rows += k * (c x u) where u is the unknown 3-vector at `col`. */
function putCross(A, row, col, c, k) {
  A[row][col + 1] += -c[2] * k; A[row][col + 2] += c[1] * k;
  A[row + 1][col] += c[2] * k; A[row + 1][col + 2] += -c[0] * k;
  A[row + 2][col] += -c[1] * k; A[row + 2][col + 1] += c[0] * k;
}
const zeros = n => Array.from({ length: n }, () => new Array(n).fill(0));
const gyro = (I, w) => cross(w, [I[0] * w[0], I[1] * w[1], I[2] * w[2]]);
/** Torque of a body's external forces about its OWN mass centre, from the torque about the common origin. */
const ownTorque = b => sub(b.T, cross(b.r, b.F));

function rootOf(bodies, joints) {
  const isChild = new Array(bodies.length).fill(false);
  for (const j of joints) { if (isChild[j.child]) throw new Error('ref: body ' + j.child + ' has two parents'); isChild[j.child] = true; }
  const roots = isChild.map((c, i) => (c ? -1 : i)).filter(i => i >= 0);
  if (roots.length !== 1 || joints.length !== bodies.length - 1) throw new Error('ref: the joints are not a tree');
  return roots[0];
}

/**
 * Free multibody system welded at its joints: derive everything.
 * → { loads: [{F, M}] (wrench parent→child at each joint point, moment about that point),
 *     acc: [a_i], alphas: [alpha_i], alpha (of body 0; all are equal), f (mass-weighted mean of a_i = acceleration
 *     of the mass centre less gravity), spread (largest |alpha_i - alpha_0|: must be ~0) }
 */
export function multibodyDynamic(bodies, joints, w = [0, 0, 0]) {
  const N = bodies.length, J = joints.length;
  rootOf(bodies, joints);
  const n = 6 * N + 6 * J;
  const A = zeros(n), b = new Array(n).fill(0);
  const ia = i => 6 * i, ial = i => 6 * i + 3, iF = j => 6 * N + 6 * j, iM = j => 6 * N + 6 * j + 3;
  for (let i = 0; i < N; i++) {
    const B = bodies[i];
    // Newton:  m a_i - sum(+-Fc) = F_i
    putEye(A, 6 * i, ia(i), B.m);
    for (let k = 0; k < 3; k++) b[6 * i + k] = B.F[k];
    // Euler about the body's own centre:  I alpha_i - sum(+-(Mc + (p - r_i) x Fc)) = T_own - w x (I w)
    for (let k = 0; k < 3; k++) A[6 * i + 3 + k][ial(i) + k] += B.I[k];
    const t = sub(ownTorque(B), gyro(B.I, w));
    for (let k = 0; k < 3; k++) b[6 * i + 3 + k] = t[k];
  }
  joints.forEach((jt, j) => {
    for (const [body, sgn] of [[jt.child, 1], [jt.parent, -1]]) {
      const arm = sub(jt.p, bodies[body].r);
      putEye(A, 6 * body, iF(j), -sgn);
      putEye(A, 6 * body + 3, iM(j), -sgn);
      putCross(A, 6 * body + 3, iF(j), arm, -sgn);
    }
    // weld:  alpha_parent = alpha_child ;  a_P + alpha_P x dP + w x (w x dP) = a_C + alpha_C x dC + w x (w x dC)
    const row = 6 * N + 6 * j;
    const dP = sub(jt.p, bodies[jt.parent].r), dC = sub(jt.p, bodies[jt.child].r);
    putEye(A, row, ial(jt.parent), 1); putEye(A, row, ial(jt.child), -1);
    putEye(A, row + 3, ia(jt.parent), 1); putEye(A, row + 3, ia(jt.child), -1);
    putCross(A, row + 3, ial(jt.parent), dP, -1);      // alpha x d = -(d x alpha)
    putCross(A, row + 3, ial(jt.child), dC, 1);
    const cen = sub(cross(w, cross(w, dC)), cross(w, cross(w, dP)));
    for (let k = 0; k < 3; k++) b[row + 3 + k] = cen[k];
  });
  const x = solveDense(A, b);
  const v3 = i => [x[i], x[i + 1], x[i + 2]];
  const acc = bodies.map((_, i) => v3(ia(i))), alphas = bodies.map((_, i) => v3(ial(i)));
  let mt = 0, f = [0, 0, 0], spread = 0;
  bodies.forEach((B, i) => { mt += B.m; f = add(f, scale(acc[i], B.m)); spread = Math.max(spread, norm(sub(alphas[i], alphas[0]))); });
  return { loads: joints.map((_, j) => ({ F: v3(iF(j)), M: v3(iM(j)) })), acc, alphas, alpha: alphas[0], f: scale(f, 1 / mt), spread };
}

/**
 * The same bodies and welds made to move as prescribed: motion = { w, alpha, f } with f the acceleration (less
 * gravity) of the origin of the r_i. → { loads: [{F, M}], residual: {F, M} } where the residual is the extra wrench
 * that must act on the root body (force at, and moment about, its mass centre) for that motion to happen.
 */
export function multibodyPrescribed(bodies, joints, motion) {
  const N = bodies.length, J = joints.length;
  const root = rootOf(bodies, joints);
  const { w, alpha, f } = motion;
  const n = 6 * N;                           // 6 J wrench unknowns + 6 residual unknowns
  const A = zeros(n), b = new Array(n).fill(0);
  const iF = j => 6 * j, iM = j => 6 * j + 3, iR = 6 * J;
  for (let i = 0; i < N; i++) {
    const B = bodies[i];
    const a = add(f, add(cross(alpha, B.r), cross(w, cross(w, B.r))));
    // sum(+-Fc) [+ residual] = m a - F
    const rf = sub(scale(a, B.m), B.F);
    // sum(+-(Mc + (p - r) x Fc)) [+ residual] = I alpha + w x (I w) - T_own
    const rm = sub(add([B.I[0] * alpha[0], B.I[1] * alpha[1], B.I[2] * alpha[2]], gyro(B.I, w)), ownTorque(B));
    for (let k = 0; k < 3; k++) { b[6 * i + k] = rf[k]; b[6 * i + 3 + k] = rm[k]; }
    if (i === root) { putEye(A, 6 * i, iR, 1); putEye(A, 6 * i + 3, iR + 3, 1); }
  }
  joints.forEach((jt, j) => {
    for (const [body, sgn] of [[jt.child, 1], [jt.parent, -1]]) {
      putEye(A, 6 * body, iF(j), sgn);
      putEye(A, 6 * body + 3, iM(j), sgn);
      putCross(A, 6 * body + 3, iF(j), sub(jt.p, bodies[body].r), sgn);
    }
  });
  const x = solveDense(A, b);
  const v3 = i => [x[i], x[i + 1], x[i + 2]];
  return { loads: joints.map((_, j) => ({ F: v3(iF(j)), M: v3(iM(j)) })), residual: { F: v3(iR), M: v3(iR + 3) }, root };
}

/** Mass, mass centre and FULL inertia tensor (3x3, about the mass centre) of a set of bodies: by direct summation. */
export function assembly(bodies) {
  let m = 0, c = [0, 0, 0];
  for (const B of bodies) { m += B.m; c = add(c, scale(B.r, B.m)); }
  c = scale(c, 1 / m);
  const I = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const B of bodies) {
    const d = sub(B.r, c), d2 = dot(d, d);
    for (let i = 0; i < 3; i++) { I[i][i] += B.I[i] + B.m * d2; for (let j = 0; j < 3; j++) I[i][j] -= B.m * d[i] * d[j]; }
  }
  return { m, c, I };
}

/** Move the origin of a body set to its mass centre (torques are re-referenced too). Returns new plain data. */
export function centred(bodies, joints) {
  const { c } = assembly(bodies);
  return {
    bodies: bodies.map(B => ({ m: B.m, r: sub(B.r, c), I: B.I.slice(), F: B.F.slice(), T: sub(B.T, cross(c, B.F)) })),
    joints: joints.map(j => ({ parent: j.parent, child: j.child, p: sub(j.p, c), n: j.n.slice() })),
  };
}

// ------------------------------------------------------------------------------------------ random trees
/** A random welded tree of n bodies with random loads, origin at its mass centre. */
export function randomTree(rnd, n) {
  const u = (lo, hi) => lo + (hi - lo) * rnd();
  const vec = s => [u(-s, s), u(-s, s), u(-s, s)];
  const bodies = [], joints = [];
  for (let i = 0; i < n; i++) {
    const m = Math.exp(u(Math.log(20), Math.log(40000)));
    const size = u(0.3, 3);
    const parent = i ? Math.floor(rnd() * i) : -1;
    const r = i ? add(bodies[parent].r, vec(6)) : vec(2);
    const F = rnd() < 0.25 ? [0, 0, 0] : vec(m * u(1, 40));
    const app = add(r, vec(size));                                     // where that force acts
    const couple = rnd() < 0.5 ? vec(m * u(0, 10)) : [0, 0, 0];
    bodies.push({ m, r, I: [m * size * size * u(0.05, 0.6), m * size * size * u(0.05, 0.6), m * size * size * u(0.05, 0.6)], F, T: add(cross(app, F), couple) });
    if (i) {
      const p = add(scale(add(r, bodies[parent].r), 0.5), vec(0.5));
      const d = sub(r, bodies[parent].r), dl = norm(d) || 1;
      joints.push({ parent, child: i, p, n: scale(d, 1 / dl) });
    }
  }
  // any order: shuffle the joints
  for (let i = joints.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [joints[i], joints[k]] = [joints[k], joints[i]]; }
  return centred(bodies, joints);
}

// ------------------------------------------------------------------------------------------ textbook cases
/**
 * A uniform rod along +Y cut into N equal segments (mass m, length L each, own transverse inertia m L^2 / 12 and axial
 * inertia Iy), mass centre at the origin. Segment k = 0 is the tail. rootAt 'nose' | 'tail' chooses which end is the
 * root of the joint tree. Joint k (k = 1 ... N-1) is the station between segments k-1 and k, at y = (k - N/2) L.
 */
export function rod(N, m, L, { rootAt = 'nose', Iy = 0 } = {}) {
  const It = m * L * L / 12;
  const bodies = [], joints = [];
  for (let k = 0; k < N; k++) bodies.push({ m, r: [0, (k + 0.5 - N / 2) * L, 0], I: [It, Iy, It], F: [0, 0, 0], T: [0, 0, 0] });
  for (let k = 1; k < N; k++) {
    const p = [0, (k - N / 2) * L, 0];
    if (rootAt === 'nose') joints.push({ parent: k, child: k - 1, p, n: [0, -1, 0] });
    else joints.push({ parent: k - 1, child: k, p, n: [0, 1, 0] });
  }
  return { bodies, joints, stationY: k => (k - N / 2) * L, half: N * L / 2, M: N * m };
}
/** Put a force F at point `at` (origin = mass centre) on body i. */
export function push(bodies, i, F, at) { bodies[i].F = add(bodies[i].F, F); bodies[i].T = add(bodies[i].T, cross(at, F)); }

/**
 * Continuous slender free rod of mass M and half-length H on the Y axis, lateral force P (along +X) at its tail end
 * y = -H. Rigid-body dynamics: a_x(y) = P/M - alpha y with alpha = P H / (M H^2 / 3) about +Z. The piece ABOVE a
 * station s carries no external load, so what the lower piece does to it is
 *   Vx(s) = integral_s^H mu a_x dy,   Mz(s) about the station = -integral_s^H mu (y - s) a_x dy     (mu = M / 2H)
 * → { alpha, Vx, Mz } (force on / moment about the station on the UPPER piece from the lower one).
 */
export function lateralRod(M, H, P, s) {
  const alpha = 3 * P / (M * H), mu = M / (2 * H), c0 = P / M;
  const Vx = mu * (c0 * (H - s) - alpha * (H * H - s * s) / 2);
  const Mz = -mu * (c0 * (H - s) * (H - s) / 2 - alpha * ((H * H * H - s * s * s) / 3 - s * (H * H - s * s) / 2));
  return { alpha, Vx, Mz };
}

// ------------------------------------------------------------------------------------------ thin ring
/**
 * Line loads of a thin ring of radius r (axis n, centre = the joint point) that transmits the wrench (F, M) from the
 * root side to the far side, WITHOUT the peak formulas. Assumptions only: the axial line load varies linearly across
 * the section (plane sections), s(theta) = A + B cos + C sin, and the shear flow of a thin ring is
 * q(theta) = a + b cos + c sin along the tangent. The six coefficients are fitted so that the line loads, integrated
 * numerically round the ring, give back the wrench: this file therefore also proves that such a distribution exists.
 * → { N, V, Mb, Mt (resultants recomputed by quadrature), nT, nC, q (peaks found by scanning), back: {F, M} }
 */
export function ringLineLoads(F, M, n, r, { K = 720, scan = 20000 } = {}) {
  const nn = scale(n, 1 / norm(n));
  // two unit vectors that span the plane of the ring
  const h = Math.abs(nn[0]) < 0.7 ? [1, 0, 0] : [0, 0, 1];
  let e1 = cross(nn, h); e1 = scale(e1, 1 / norm(e1));
  const e2 = cross(nn, e1);
  const dth = 2 * Math.PI / K;
  const basis = [() => 1, t => Math.cos(t), t => Math.sin(t)];
  // response of each basis function: force and moment (about the centre) on the FAR side
  const colsAx = [], colsSh = [];
  for (const g of basis) {
    let fa = [0, 0, 0], ma = [0, 0, 0], fs = [0, 0, 0], ms = [0, 0, 0];
    for (let k = 0; k < K; k++) {
      const t = (k + 0.5) * dth, c = Math.cos(t), s = Math.sin(t);
      const x = add(scale(e1, r * c), scale(e2, r * s));
      const tan = add(scale(e1, -s), scale(e2, c));
      const dl = r * dth;
      // axial line load g (tension positive): the root side pulls the far side back, along -n
      const df = scale(nn, -g(t) * dl);
      fa = add(fa, df); ma = add(ma, cross(x, df));
      // shear flow g along the tangent, acting on the far side
      const ds = scale(tan, g(t) * dl);
      fs = add(fs, ds); ms = add(ms, cross(x, ds));
    }
    colsAx.push({ f: fa, m: ma }); colsSh.push({ f: fs, m: ms });
  }
  // axial: match F.n, M.e1, M.e2 ; shear: match F.e1, F.e2, M.n
  const Aax = [0, 1, 2].map(row => colsAx.map(c => (row === 0 ? dot(c.f, nn) : dot(c.m, row === 1 ? e1 : e2))));
  const ax = solveDense(Aax, [dot(F, nn), dot(M, e1), dot(M, e2)]);
  const Ash = [0, 1, 2].map(row => colsSh.map(c => (row === 2 ? dot(c.m, nn) : dot(c.f, row === 0 ? e1 : e2))));
  const sh = solveDense(Ash, [dot(F, e1), dot(F, e2), dot(M, nn)]);
  // peaks: walk round the ring, then polish the highest and lowest sample with a few Newton steps on the slope
  const extremes = c => {
    const val = t => c[0] + c[1] * Math.cos(t) + c[2] * Math.sin(t);
    let tHi = 0, tLo = 0, hi = -Infinity, lo = Infinity;
    for (let k = 0; k < scan; k++) {
      const t = k * 2 * Math.PI / scan, s = val(t);
      if (s > hi) { hi = s; tHi = t; }
      if (s < lo) { lo = s; tLo = t; }
    }
    const polish = t => {
      for (let it = 0; it < 4; it++) {
        const d1 = -c[1] * Math.sin(t) + c[2] * Math.cos(t), d2 = -c[1] * Math.cos(t) - c[2] * Math.sin(t);
        if (!(Math.abs(d2) > 0)) break;
        const step = d1 / d2;
        if (!(Math.abs(step) < 4 * Math.PI / scan)) break;
        t -= step;
      }
      return val(t);
    };
    return { hi: Math.max(hi, polish(tHi)), lo: Math.min(lo, polish(tLo)) };
  };
  const ea = extremes(ax), es = extremes(sh);
  const nT = Math.max(0, ea.hi), nC = Math.max(0, -ea.lo), q = Math.max(Math.abs(es.hi), Math.abs(es.lo));
  let bf = [0, 0, 0], bm = [0, 0, 0];
  for (let k = 0; k < K; k++) {
    const t = (k + 0.5) * dth, c = Math.cos(t), s = Math.sin(t);
    const x = add(scale(e1, r * c), scale(e2, r * s)), tan = add(scale(e1, -s), scale(e2, c));
    const df = add(scale(nn, -(ax[0] + ax[1] * c + ax[2] * s) * r * dth), scale(tan, (sh[0] + sh[1] * c + sh[2] * s) * r * dth));
    bf = add(bf, df); bm = add(bm, cross(x, df));
  }
  const Fa = dot(bf, nn), Ma = dot(bm, nn);
  return {
    N: -Fa, V: norm(sub(bf, scale(nn, Fa))), Mt: Math.abs(Ma), Mb: norm(sub(bm, scale(nn, Ma))),
    nT, nC, q, back: { F: bf, M: bm },
  };
}

/** Utilisation from the ring line loads above. → { util, mode, nT, nC, q, N, V, Mb, Mt } */
export function ringUtilisation(F, M, n, r, capT, capC, capS, opts = {}) {
  const L = ringLineLoads(F, M, n, r, opts);
  const c = [['tension', L.nT / capT], ['compression', L.nC / capC], ['shear', L.q / capS]].sort((a, b) => b[1] - a[1]);
  return { ...L, util: c[0][1], mode: c[0][0], margin: c[0][1] - c[1][1] };
}
