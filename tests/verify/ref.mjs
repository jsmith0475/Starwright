// Independent physics reference for the Starwright verification suite.
//
// NOTHING in this file imports the game's maths. Plain arrays, double precision. It provides
//   - readSystem():   body constants parsed as DATA from the DEFS table in js/core/bodies.js
//   - integrate():    adaptive Gragg-Bulirsch-Stoer extrapolation integrator (order 16)
//   - keplerUV():     closed-form two-body propagation by universal variables (Stumpff functions)
//   - elementsToState(), stateToElements(): classical elements <-> state vectors
//   - Ephemeris:      body positions from their elements (own Kepler solver)
//   - textbook formulas (vis-viva, Hohmann, Laplace SOI, hyperbola turn angle, Clohessy-Wiltshire, rocket equation)
//
// Frame: the game is right-handed, Y up, prograde = counter-clockwise seen from +Y. A standard Z-up
// perifocal vector (x, y, z) maps to (x, z, -y). That mapping is the only convention shared with the game.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const TAU = Math.PI * 2;
export const G0 = 9.80665;
const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------------------------------ vectors
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = a => Math.hypot(a[0], a[1], a[2]);
export const unit = a => scale(a, 1 / norm(a));
export const dist = (a, b) => norm(sub(a, b));
export const arr = v => [v.x, v.y, v.z];                 // game Vector3 -> array (read-only bridge)
export const angleBetween = (a, b) => Math.atan2(norm(cross(a, b)), dot(a, b));

// ------------------------------------------------------------------------------------------ system data
/** Parse the DEFS table of js/core/bodies.js as data (no game code is executed). */
export function readSystem() {
  const src = readFileSync(join(HERE, '../../js/core/bodies.js'), 'utf8');
  const i0 = src.indexOf('const DEFS = [');
  const i1 = src.indexOf('\n];', i0);
  if (i0 < 0 || i1 < 0) throw new Error('DEFS table not found in bodies.js');
  const seaM = /const VERDA_SEA = (-?[\d.]+)/.exec(src);
  const defs = new Function('VERDA_SEA', 'return ' + src.slice(i0 + 'const DEFS = '.length, i1 + 2))(seaM ? +seaM[1] : 0);
  const byId = {};
  const bodies = defs.map(d => {
    const b = {
      id: d.id, name: d.name, parentId: d.parent, radius: d.radius,
      gm: d.gm !== undefined ? d.gm : d.surfaceG * d.radius * d.radius,
      surfaceG: d.surfaceG, rotPeriodDef: d.rotPeriod, rotSync: d.rotSync || null, rot0: d.rot0 || 0,
      elements: d.orbit ? { a: d.orbit[0], e: d.orbit[1], i: d.orbit[2], lan: d.orbit[3], argp: d.orbit[4], M0: d.orbit[5] } : null,
      atmo: d.atmo ? { height: d.atmo[0], scale: d.atmo[1], rho0: d.atmo[2] } : null,
      relief: d.relief || [0, 0], gas: !!d.gas, children: [],
    };
    byId[b.id] = b;
    return b;
  });
  for (const b of bodies) {
    b.parent = b.parentId ? byId[b.parentId] : null;
    if (b.parent) b.parent.children.push(b);
  }
  for (const b of bodies) {
    if (!b.parent) continue;
    b.period = TAU * Math.sqrt(Math.pow(b.elements.a, 3) / b.parent.gm);        // Kepler III about the parent's GM
    b.soiLaplace = b.elements.a * Math.pow(b.gm / b.parent.gm, 0.4);
  }
  for (const b of bodies) {
    if (b.rotPeriodDef === 'tidal') b.rotPeriod = b.period;
    else if (b.rotSync) b.rotPeriod = byId[b.rotSync].period;
    else b.rotPeriod = b.rotPeriodDef;
  }
  return { bodies, byId };
}

// ------------------------------------------------------------------------------------------ Kepler, closed form
/** Solve Kepler's equation E - e sin E = M (plain Newton with bisection fallback; independent of the game). */
export function solveKepler(M, e) {
  M = M - TAU * Math.floor((M + Math.PI) / TAU);
  let lo = -Math.PI, hi = Math.PI, E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
  for (let k = 0; k < 200; k++) {
    const f = E - e * Math.sin(E) - M;
    if (f > 0) hi = E; else lo = E;
    let En = E - f / (1 - e * Math.cos(E));
    if (!(En > lo && En < hi)) En = 0.5 * (lo + hi);
    if (Math.abs(En - E) < 1e-15 * Math.max(1, Math.abs(En))) { E = En; break; }
    E = En;
  }
  return E;
}
export function solveKeplerHyp(M, e) {
  let F = Math.asinh(M / e);
  let lo = -Infinity, hi = Infinity;
  for (let k = 0; k < 200; k++) {
    const f = e * Math.sinh(F) - F - M;
    if (f > 0) hi = F; else lo = F;
    let Fn = F - f / (e * Math.cosh(F) - 1);
    if (!(Fn > lo && Fn < hi)) Fn = Number.isFinite(lo) && Number.isFinite(hi) ? 0.5 * (lo + hi) : Fn;
    if (Math.abs(Fn - F) < 1e-15 * Math.max(1, Math.abs(Fn))) { F = Fn; break; }
    F = Fn;
  }
  return F;
}

/** Classical elements (a, e, i/lan/argp in degrees, M0 rad at t0) -> state {r, v} at time t, in the GAME frame. */
export function elementsToState(el, mu, t, t0 = 0) {
  const { a, e } = el;
  const d = Math.PI / 180, i = (el.i || 0) * d, O = (el.lan || 0) * d, w = (el.argp || 0) * d;
  let x, y, vx, vy;
  if (e < 1) {
    const n = Math.sqrt(mu / (a * a * a));
    const E = solveKepler((el.M0 || 0) + n * (t - t0), e);
    const b = a * Math.sqrt(1 - e * e), r = a * (1 - e * Math.cos(E));
    x = a * (Math.cos(E) - e); y = b * Math.sin(E);
    vx = -a * n * Math.sin(E) * a / r; vy = b * n * Math.cos(E) * a / r;
  } else {
    const aa = Math.abs(a), n = Math.sqrt(mu / (aa * aa * aa));
    const F = solveKeplerHyp((el.M0 || 0) + n * (t - t0), e);
    const b = aa * Math.sqrt(e * e - 1), r = aa * (e * Math.cosh(F) - 1);
    x = aa * (e - Math.cosh(F)); y = b * Math.sinh(F);
    vx = -aa * n * Math.sinh(F) * aa / r; vy = b * n * Math.cosh(F) * aa / r;
  }
  const cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(i), si = Math.sin(i), cw = Math.cos(w), sw = Math.sin(w);
  const P = [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si];
  const Q = [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si];
  const std = (px, py) => [P[0] * px + Q[0] * py, P[1] * px + Q[1] * py, P[2] * px + Q[2] * py];
  const toGame = s => [s[0], s[2], -s[1]];
  return { r: toGame(std(x, y)), v: toGame(std(vx, vy)) };
}

/** State -> {a, e, energy, h (vector), hmag, rp, ra, period, inc (rad from +Y)}. */
export function stateToElements(r, v, mu) {
  const rr = norm(r), v2 = dot(v, v);
  const energy = 0.5 * v2 - mu / rr;
  const h = cross(r, v), hmag = norm(h);
  const evec = sub(scale(cross(v, h), 1 / mu), scale(r, 1 / rr));
  const e = norm(evec);
  const a = -mu / (2 * energy);
  const p = hmag * hmag / mu;
  const rp = p / (1 + e), ra = e < 1 ? p / (1 - e) : Infinity;
  return { a, e, energy, h, hmag, evec, p, rp, ra, period: e < 1 ? TAU * Math.sqrt(a * a * a / mu) : Infinity, inc: Math.acos(Math.max(-1, Math.min(1, h[1] / hmag))) };
}

// Stumpff functions
function stumpC(z) {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 0.5 - z / 24 + z * z / 720 - z * z * z / 40320;
}
function stumpS(z) {
  if (z > 1e-6) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); }
  if (z < -1e-6) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); }
  return 1 / 6 - z / 120 + z * z / 5040 - z * z * z / 362880;
}

/** Two-body propagation by universal variables: state (r0, v0) advanced by dt under gravitational parameter mu. */
export function keplerUV(r0, v0, mu, dt) {
  if (dt === 0) return { r: r0.slice(), v: v0.slice() };
  const R0 = norm(r0), vr0 = dot(r0, v0) / R0, sm = Math.sqrt(mu);
  const alpha = 2 / R0 - dot(v0, v0) / mu;
  if (alpha > 0) {                                    // closed orbit: drop whole periods (keeps Newton well behaved)
    const T = TAU / (sm * Math.pow(alpha, 1.5));
    dt -= T * Math.round(dt / T);
    if (dt === 0) return { r: r0.slice(), v: v0.slice() };
  }
  const F = chi => {
    const z = alpha * chi * chi, C = stumpC(z), S = stumpS(z);
    return {
      f: R0 * vr0 / sm * chi * chi * C + (1 - alpha * R0) * chi * chi * chi * S + R0 * chi - sm * dt,
      df: R0 * vr0 / sm * chi * (1 - z * S) + (1 - alpha * R0) * chi * chi * C + R0,
    };
  };
  // F is monotonic in chi (dF/dchi = r > 0): bracket by doubling, then safeguarded Newton.
  // Work with s = sign(dt): g(x) = s * F(s * x) is increasing in x >= 0 with g(0) < 0; overflow counts as "too far".
  const sg = Math.sign(dt);
  const G = x => { const q = F(sg * x); return { f: Number.isFinite(q.f) ? sg * q.f : Infinity, df: q.df }; };
  let lo = 0, hi = Math.sqrt(R0) * 1e-3;
  while (G(hi).f < 0) { lo = hi; hi *= 2; }
  let x = 0.5 * (lo + hi);
  for (let k = 0; k < 400; k++) {
    const { f, df } = G(x);
    if (f > 0) hi = x; else lo = x;
    let xn = Number.isFinite(f) && Number.isFinite(df) ? x - f / df : NaN;
    if (!(xn > lo && xn < hi)) xn = 0.5 * (lo + hi);
    if (Math.abs(xn - x) <= 4e-16 * Math.abs(xn) || hi - lo <= 0) { x = xn; break; }
    x = xn;
  }
  const chi = sg * x;
  const z = alpha * chi * chi, C = stumpC(z), S = stumpS(z);
  const f = 1 - chi * chi / R0 * C, g = dt - chi * chi * chi * S / sm;
  const r = add(scale(r0, f), scale(v0, g)), R = norm(r);
  const fd = sm / (R * R0) * (z * S - 1) * chi, gd = 1 - chi * chi / R * C;
  return { r, v: add(scale(r0, fd), scale(v0, gd)) };
}

/** Seconds from the given state to the next apoapsis of its (closed) orbit. */
export function keplerTimeToApo(r, v, mu) {
  const el = stateToElements(r, v, mu);
  const n = Math.sqrt(mu / (el.a * el.a * el.a));
  const E = Math.atan2(dot(r, v) / Math.sqrt(mu * el.a), 1 - norm(r) / el.a);
  let M = E - el.e * Math.sin(E);
  let dM = Math.PI - M; if (dM < 0) dM += TAU;
  return dM / n;
}

// ------------------------------------------------------------------------------------------ integrator
const SEQ = [2, 4, 6, 8, 10, 12, 14, 16];
/**
 * Adaptive Gragg-Bulirsch-Stoer integrator (modified midpoint + Richardson extrapolation in h^2, 8 columns:
 * order 16). deriv(t, y, out) fills out = dy/dt. Integrates y (Float64Array, modified in place) from t0 to t1.
 * opts: { rtol = 1e-13, atol, h0, hmax, onStep(t, y) -> true to stop }. Returns { t, steps, evals, h }.
 */
export function integrate(deriv, y, t0, t1, opts = {}) {
  const n = y.length, K = SEQ.length;
  const rtol = opts.rtol || 1e-13;
  const atol = opts.atol || 1e-300;      // absolute floor per component (for components that are zero by symmetry)
  const dir = t1 >= t0 ? 1 : -1;
  let h = (opts.h0 || Math.abs(t1 - t0) / 100 || 1) * dir;
  const hmax = opts.hmax || Infinity;
  const f0 = new Float64Array(n), ym = new Float64Array(n), yn = new Float64Array(n), ft = new Float64Array(n);
  const T = []; for (let k = 0; k < K; k++) T.push(new Float64Array(n));
  const Tprev = []; for (let k = 0; k < K; k++) Tprev.push(new Float64Array(n));
  const ysave = new Float64Array(n);
  let t = t0, steps = 0, evals = 0;
  while ((t1 - t) * dir > 1e-14 * Math.max(1, Math.abs(t1))) {
    if (Math.abs(h) > hmax) h = hmax * dir;
    if ((t + h - t1) * dir > 0) h = t1 - t;
    deriv(t, y, f0); evals++;
    ysave.set(y);
    let err = Infinity;
    for (let k = 0; k < K; k++) {
      // modified midpoint with SEQ[k] sub-steps
      const m = SEQ[k], hs = h / m;
      for (let i = 0; i < n; i++) { ym[i] = y[i]; yn[i] = y[i] + hs * f0[i]; }
      for (let j = 1; j < m; j++) {
        deriv(t + j * hs, yn, ft); evals++;
        for (let i = 0; i < n; i++) { const s = ym[i] + 2 * hs * ft[i]; ym[i] = yn[i]; yn[i] = s; }
      }
      deriv(t + h, yn, ft); evals++;
      const row = T[k];
      for (let i = 0; i < n; i++) row[i] = 0.5 * (ym[i] + yn[i] + hs * ft[i]);
      // Neville: Tprev holds the previous row's columns; build this row's columns in place
      // column j of row k: T_kj = T_k,j-1 + (T_k,j-1 - T_k-1,j-1) / ((n_k/n_{k-j})^2 - 1)
      const cols = [row.slice()];
      for (let j = 1; j <= k; j++) {
        const c = new Float64Array(n), ratio = SEQ[k] / SEQ[k - j], den = ratio * ratio - 1;
        const a = cols[j - 1], b = Tprev[j - 1];
        for (let i = 0; i < n; i++) c[i] = a[i] + (a[i] - b[i]) / den;
        cols.push(c);
      }
      if (k === K - 1) {
        err = 0;
        const hi = cols[k], lo = cols[k - 1];
        for (let i = 0; i < n; i++) {
          const sc = rtol * (Math.abs(ysave[i]) + Math.abs(h * f0[i])) + atol;
          const e = Math.abs(hi[i] - lo[i]) / sc;
          if (e > err) err = e;
        }
        if (err <= 1) y.set(hi);
      }
      for (let j = 0; j <= k; j++) Tprev[j].set(cols[j]);
    }
    if (err <= 1) {
      t += h; steps++;
      if (opts.onStep && opts.onStep(t, y)) break;
      h *= Math.min(4, Math.max(0.3, 0.9 * Math.pow(1 / Math.max(err, 1e-10), 1 / 15)));
    } else {
      y.set(ysave);
      h *= Math.max(0.2, 0.9 * Math.pow(1 / err, 1 / 15));
      if (!(Math.abs(h) > 1e-12 * Math.max(1, Math.abs(t)))) throw new Error('integrate: step size underflow at t=' + t);
    }
  }
  return { t, steps, evals, h: Math.abs(h) };
}

/** Two-body numerical propagation (for cross-checking the closed form and the game). */
export function integrateTwoBody(r0, v0, mu, dt, rtol = 1e-13) {
  const y = Float64Array.from([...r0, ...v0]);
  const period = (() => { const a = 1 / (2 / norm(r0) - dot(v0, v0) / mu); return a > 0 ? TAU * Math.sqrt(a * a * a / mu) : Math.abs(dt); })();
  integrate((t, s, o) => {
    const r3 = Math.pow(s[0] * s[0] + s[1] * s[1] + s[2] * s[2], 1.5);
    o[0] = s[3]; o[1] = s[4]; o[2] = s[5]; o[3] = -mu * s[0] / r3; o[4] = -mu * s[1] / r3; o[5] = -mu * s[2] / r3;
  }, y, 0, dt, { rtol, h0: Math.min(Math.abs(dt), period / 50) });
  return { r: [y[0], y[1], y[2]], v: [y[3], y[4], y[5]] };
}

// ------------------------------------------------------------------------------------------ ephemeris
/** Body positions from their elements, by this file's own Kepler solver. All states in the game frame. */
export class Ephemeris {
  constructor(sys) { this.sys = sys; }
  /** State of body relative to its parent. */
  rel(body, t) { return body.parent ? elementsToState(body.elements, body.parent.gm, t) : { r: [0, 0, 0], v: [0, 0, 0] }; }
  /** State of body relative to the star. */
  global(body, t) {
    let r = [0, 0, 0], v = [0, 0, 0];
    for (let b = body; b && b.parent; b = b.parent) { const s = this.rel(b, t); r = add(r, s.r); v = add(v, s.v); }
    return { r, v };
  }
}

/**
 * Restricted n-body: a massless vessel under the gravity of `bodies` (ref bodies) which stay on their rails.
 * State is relative to the star, in the game frame. Returns the derivative function for integrate().
 */
export function railsNBodyDeriv(eph, bodies) {
  return (t, s, o) => {
    let ax = 0, ay = 0, az = 0;
    for (const b of bodies) {
      const p = eph.global(b, t).r;
      const dx = s[0] - p[0], dy = s[1] - p[1], dz = s[2] - p[2];
      const k = -b.gm / Math.pow(dx * dx + dy * dy + dz * dz, 1.5);
      ax += k * dx; ay += k * dy; az += k * dz;
    }
    o[0] = s[3]; o[1] = s[4]; o[2] = s[5]; o[3] = ax; o[4] = ay; o[5] = az;
  };
}

/** Full, self-consistent n-body: state = [r0, v0, r1, v1, ...] for point masses gms[i] (0 for test particles). */
export function fullNBodyDeriv(gms) {
  const N = gms.length;
  return (t, s, o) => {
    for (let i = 0; i < N; i++) { o[6 * i] = s[6 * i + 3]; o[6 * i + 1] = s[6 * i + 4]; o[6 * i + 2] = s[6 * i + 5]; o[6 * i + 3] = 0; o[6 * i + 4] = 0; o[6 * i + 5] = 0; }
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      if (gms[i] === 0 && gms[j] === 0) continue;
      const dx = s[6 * j] - s[6 * i], dy = s[6 * j + 1] - s[6 * i + 1], dz = s[6 * j + 2] - s[6 * i + 2];
      const k = 1 / Math.pow(dx * dx + dy * dy + dz * dz, 1.5);
      o[6 * i + 3] += gms[j] * k * dx; o[6 * i + 4] += gms[j] * k * dy; o[6 * i + 5] += gms[j] * k * dz;
      o[6 * j + 3] -= gms[i] * k * dx; o[6 * j + 4] -= gms[i] * k * dy; o[6 * j + 5] -= gms[i] * k * dz;
    }
  };
}

// ------------------------------------------------------------------------------------------ textbook formulas
export const circularSpeed = (mu, r) => Math.sqrt(mu / r);
export const orbitPeriod = (mu, a) => TAU * Math.sqrt(a * a * a / mu);
export const visViva = (mu, r, a) => Math.sqrt(mu * (2 / r - 1 / a));
export const escapeSpeed = (mu, r) => Math.sqrt(2 * mu / r);

/** Hohmann transfer between coplanar circular orbits r1 -> r2 about mu. */
export function hohmann(mu, r1, r2) {
  const at = (r1 + r2) / 2;
  const dv1 = visViva(mu, r1, at) - circularSpeed(mu, r1);
  const dv2 = circularSpeed(mu, r2) - visViva(mu, r2, at);
  const tof = Math.PI * Math.sqrt(at * at * at / mu);
  const n2 = Math.sqrt(mu / (r2 * r2 * r2));
  let phase = Math.PI - n2 * tof;                           // target ahead of the chaser at departure
  phase -= TAU * Math.round(phase / TAU);
  return { at, dv1, dv2, tof, phase, vInf1: Math.abs(dv1), vInf2: Math.abs(dv2) };
}
/** Speed change from a circular parking orbit of radius r to a hyperbola with excess speed vInf. */
export const ejectionDv = (mu, r, vInf) => Math.sqrt(vInf * vInf + 2 * mu / r) - Math.sqrt(mu / r);
/** Hyperbolic flyby: eccentricity and total turn angle for periapsis radius rp and excess speed vInf. */
export function flyby(mu, rp, vInf) {
  const e = 1 + rp * vInf * vInf / mu;
  return { e, turn: 2 * Math.asin(1 / e) };
}
/** Tsiolkovsky. */
export const rocketDv = (isp, m0, m1) => isp * G0 * Math.log(m0 / m1);

/**
 * Clohessy-Wiltshire relative motion. Local frame of the target on a circular orbit of mean motion n:
 * x radial (outward), y along-track (prograde), z cross-track (orbit normal). Returns [x, y, z, vx, vy, vz] at t.
 */
export function clohessyWiltshire(s0, n, t) {
  const [x0, y0, z0, vx0, vy0, vz0] = s0;
  const c = Math.cos(n * t), s = Math.sin(n * t);
  return [
    (4 - 3 * c) * x0 + s / n * vx0 + 2 / n * (1 - c) * vy0,
    6 * (s - n * t) * x0 + y0 - 2 / n * (1 - c) * vx0 + (4 * s - 3 * n * t) / n * vy0,
    z0 * c + vz0 / n * s,
    3 * n * s * x0 + c * vx0 + 2 * s * vy0,
    -6 * n * (1 - c) * x0 - 2 * s * vx0 + (4 * c - 3) * vy0,
    -z0 * n * s + vz0 * c,
  ];
}

// ------------------------------------------------------------------------------------------ reference patched conics
/**
 * Brute-force patched-conic propagation, written to be obviously right rather than fast: the vessel follows an
 * exact Kepler arc about its current body; time advances by conservative steps (never more than half the gap to
 * the nearest boundary divided by the closing speed, never more than 2 % of the local dynamical time), so no
 * sphere of influence can be stepped over, and each crossing is then bisected.
 *
 * state = { body (ref body), r, v, t } relative to that body. Runs until tEnd or until the path meets the
 * surface / top of the atmosphere. Returns { state, events: [{ type: 'enter'|'exit'|'atmo'|'impact', t, from, to,
 * r, v (state in the new frame) }], closest: { [bodyId]: least distance to that body's centre while it was a
 * neighbour (not the current body) } }.
 */
export function refPatched(sys, eph, state, tEnd, opts = {}) {
  let { body, r, v, t } = state;
  const events = [], closest = {};
  const maxEvents = opts.maxEvents || 50;
  let t0 = t, r0 = r, v0 = v;                              // epoch of the current arc
  const at = tt => keplerUV(r0, v0, body.gm, tt - t0);
  const armed = new Map();                                 // child -> has been clearly outside since this arc began
  let stopR = body.radius + (body.atmo ? body.atmo.height : 0);
  const startedBelow = () => norm(r0) < stopR * (1 - 1e-9);
  let below = startedBelow();
  let guard = 0;
  while (t < tEnd && events.length < maxEvents) {
    if (guard++ > 5e6) throw new Error('refPatched: too many steps');
    const s = at(t);
    const R = norm(s.r), sp = norm(s.v);
    const tau = Math.sqrt(R * R * R / body.gm);
    let dt = Math.min(0.02 * tau, tEnd - t);
    const vEsc = Math.sqrt(2 * body.gm / R);
    const vMax = Math.max(sp, vEsc) * 1.1;
    if (body.parent) dt = Math.min(dt, Math.max(0.5 * (body.soiLaplace - R) / vMax, 1e-3));
    if (!below) dt = Math.min(dt, Math.max(0.5 * (R - stopR) / vMax, 1e-3));
    else if (R > stopR * (1 + 1e-9)) below = false;        // started inside the air (or underground) and climbed out
    const kids = [];
    for (const c of body.children) {
      const cs = eph.rel(c, t);
      const d = dist(s.r, cs.r);
      const gap = d - c.soiLaplace;
      if (closest[c.id] === undefined || d < closest[c.id]) closest[c.id] = d;
      if (!armed.get(c)) { if (gap > 1) armed.set(c, true); else continue; }
      dt = Math.min(dt, Math.max(0.5 * gap / (vMax + norm(cs.v) * 1.2), 1e-3));
      kids.push(c);
    }
    const t1 = t + dt;
    const s1 = at(t1);
    const R1 = norm(s1.r);
    // which boundary (if any) was crossed during this step? bisect the earliest
    let ev = null;
    const consider = (type, f, to) => {
      if (!(f(t1) <= 0)) return;
      let lo = t, hi = t1;
      for (let k = 0; k < 80 && hi - lo > 1e-7; k++) { const m = 0.5 * (lo + hi); if (f(m) > 0) lo = m; else hi = m; }
      if (!ev || hi < ev.t) ev = { type, t: hi, to };
    };
    if (body.parent && R1 > body.soiLaplace) consider('exit', tt => body.soiLaplace - norm(at(tt).r), body.parent);
    if (!below && R1 < stopR) consider(body.atmo ? 'atmo' : 'impact', tt => norm(at(tt).r) - stopR, null);
    for (const c of kids) {
      if (dist(s1.r, eph.rel(c, t1).r) < c.soiLaplace) consider('enter', tt => dist(at(tt).r, eph.rel(c, tt).r) - c.soiLaplace, c);
    }
    if (!ev) { t = t1; continue; }
    const se = at(ev.t);
    if (ev.type === 'atmo' || ev.type === 'impact') {
      events.push({ type: ev.type, t: ev.t, from: body, to: null, r: se.r, v: se.v });
      return { state: { body, r: se.r, v: se.v, t: ev.t }, events, closest };
    }
    let nr, nv;
    if (ev.type === 'exit') { const b = eph.rel(body, ev.t); nr = add(se.r, b.r); nv = add(se.v, b.v); }
    else { const c = eph.rel(ev.to, ev.t); nr = sub(se.r, c.r); nv = sub(se.v, c.v); }
    events.push({ type: ev.type, t: ev.t, from: body, to: ev.to, r: nr, v: nv });
    body = ev.to; r0 = nr; v0 = nv; t0 = ev.t; t = ev.t;
    armed.clear();
    stopR = body.radius + (body.atmo ? body.atmo.height : 0);
    below = startedBelow();
  }
  const s = at(Math.min(t, tEnd));
  return { state: { body, r: s.r, v: s.v, t: Math.min(t, tEnd) }, events, closest };
}
