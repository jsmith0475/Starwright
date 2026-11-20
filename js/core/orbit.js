// Two-body (Kepler) orbit maths. Pure simulation: only three.js Vector3 maths, runs under Node.
//
// The orbit is stored as the perifocal basis P (towards periapsis), Q (in-plane, 90° ahead) and
// H (orbit normal) plus shape/phase scalars, so circular and equatorial orbits are never degenerate.
// Frame: right-handed, Y-up. Prograde = counter-clockwise seen from +Y (+X moves toward −Z).
import { Vector3 } from '../lib/three.module.min.js';

const TAU = Math.PI * 2;
const CIRCULAR_E = 1e-10;      // below this the orbit is treated as exactly circular
const PARABOLIC_EPS = 1e-12;   // minimum |r/a|: exactly parabolic states are nudged off the singularity
const RADIAL_EPS = 1e-7;       // minimum h / sqrt(gm·r): exactly radial states get a hair of sideways speed

const _a = new Vector3();
const _b = new Vector3();

/** x − sin x without cancellation for small x. */
function xMinusSin(x) {
  if (Math.abs(x) < 0.3) {
    const x2 = x * x;
    return (x * x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - (x2 / 72) * (1 - (x2 / 110) * (1 - x2 / 156)))));
  }
  return x - Math.sin(x);
}

/** sinh x − x without cancellation for small x. */
function sinhMinusX(x) {
  if (Math.abs(x) < 0.3) {
    const x2 = x * x;
    return (x * x2 / 6) * (1 + (x2 / 20) * (1 + (x2 / 42) * (1 + (x2 / 72) * (1 + (x2 / 110) * (1 + x2 / 156)))));
  }
  return Math.sinh(x) - x;
}

/**
 * Solve E − e·sin E = M for E (M in [−π, π]). `ome` is 1 − e computed without cancellation.
 * Newton iteration inside a shrinking bracket (falls back to bisection), so it always converges.
 */
export function solveKeplerElliptic(M, e, ome = 1 - e) {
  if (!(M === M)) return 0;
  if (M > Math.PI || M < -Math.PI) M -= TAU * Math.round(M / TAU);
  const m = Math.abs(M);
  if (m === 0) return 0;
  let lo = 0, hi = Math.PI;
  let E;
  if (e < 0.8) E = m + e * Math.sin(m);
  else {
    E = Math.cbrt(6 * m / e);
    if (ome > 0 && m / ome < E) E = m / ome;
  }
  if (!(E > lo && E < hi)) E = 0.5 * (lo + hi);
  for (let i = 0; i < 100; i++) {
    const f = ome * Math.sin(E) + xMinusSin(E) - m;
    if (f === 0) break;
    if (f > 0) hi = E; else lo = E;
    const s = Math.sin(0.5 * E);
    const fp = ome + 2 * e * s * s;
    let En = E - f / fp;
    if (!(En > lo && En < hi)) En = 0.5 * (lo + hi);
    const d = Math.abs(En - E);
    E = En;
    if (d <= 2e-16 * Math.max(E, 1e-300) || hi - lo <= 0) break;
  }
  return M < 0 ? -E : E;
}

/** Solve e·sinh F − F = M for F (hyperbolic, e ≥ 1). `ome` is 1 − e (≤ 0). */
export function solveKeplerHyperbolic(M, e, ome = 1 - e) {
  if (!(M === M)) return 0;
  const m = Math.abs(M);
  if (m === 0) return 0;
  const em1 = -ome;
  // bounds: sinh F = (m + F)/e ≥ m/e, and F ≤ min(cbrt(6m), m/(e−1))
  let lo = Math.asinh(m / e);
  let fmax = Math.cbrt(6 * m);
  if (em1 > 0 && m / em1 < fmax) fmax = m / em1;
  let hi = Math.asinh((m + fmax) / e) * (1 + 1e-12) + 1e-300;
  lo *= 1 - 1e-12;
  let F = hi;
  for (let i = 0; i < 100; i++) {
    const f = em1 * Math.sinh(F) + sinhMinusX(F) - m;
    if (f === 0) break;
    if (f > 0) hi = F; else lo = F;
    const s = Math.sinh(0.5 * F);
    const fp = em1 + 2 * e * s * s;
    let Fn = F - f / fp;
    if (!(Fn > lo && Fn < hi)) Fn = 0.5 * (lo + hi);
    const d = Math.abs(Fn - F);
    F = Fn;
    if (d <= 2e-16 * Math.max(F, 1e-300) || hi - lo <= 0) break;
  }
  if (!Number.isFinite(F)) F = lo;
  return M < 0 ? -F : F;
}

function anyPerpendicular(v, out) {
  const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
  if (ax <= ay && ax <= az) out.set(1, 0, 0);
  else if (az <= ay) out.set(0, 0, 1);
  else out.set(0, 1, 0);
  // out − (out·v̂)v̂
  const l2 = v.lengthSq() || 1;
  out.addScaledVector(v, -out.dot(v) / l2);
  return out.normalize();
}

export class Orbit {
  constructor() {
    this.gm = 1; this.e = 0; this.p = 1; this.a = 1; this.hyper = false; this.n = 1;
    this.M0 = 0; this.t0 = 0;
    this.P = new Vector3(1, 0, 0); this.Q = new Vector3(0, 0, -1); this.H = new Vector3(0, 1, 0);
    this._finish(1);
  }

  // alpha = 1/a (negative for hyperbolic). Derives everything that depends on shape.
  _finish(alpha) {
    this.alpha = alpha;
    this.a = 1 / alpha;
    this.hyper = alpha < 0;
    this.n = Math.sqrt(this.gm) * Math.pow(Math.abs(alpha), 1.5);
    this.rp = this.p / (1 + this.e);       // periapsis radius
    this.ome = this.rp * alpha;            // 1 − e without cancellation (≤ 0 if hyperbolic)
    this.b = Math.sqrt(this.p * Math.abs(this.a));   // semi-minor axis
    return this;
  }

  /** Orbit from a state vector (r, v relative to the body, non-rotating frame) at time t. */
  static fromState(r, v, gm, t = 0) {
    const o = new Orbit();
    o.gm = gm; o.t0 = t;
    const R = new Vector3().copy(r);
    const V = new Vector3().copy(v);
    if (!Number.isFinite(R.x + R.y + R.z)) R.set(1, 0, 0);
    if (!Number.isFinite(V.x + V.y + V.z)) V.set(0, 0, 0);
    let r0 = R.length();
    if (!(r0 > 0)) { R.set(1e-3, 0, 0); r0 = 1e-3; }
    const rhat = new Vector3().copy(R).multiplyScalar(1 / r0);

    // near-radial guard: enforce a tiny minimum angular momentum
    const h = new Vector3().crossVectors(R, V);
    let hmag = h.length();
    const hmin = RADIAL_EPS * Math.sqrt(gm * r0);
    if (!(hmag >= hmin)) {
      const vr = V.dot(rhat);
      const u = _a.copy(V).addScaledVector(rhat, -vr);
      if (u.length() > 1e-12 * Math.sqrt(gm / r0) && hmag > 0) u.normalize();
      else anyPerpendicular(rhat, u);
      V.copy(rhat).multiplyScalar(vr).addScaledVector(u, hmin / r0);
      h.crossVectors(R, V);
      hmag = h.length();
    }

    // near-parabolic guard: keep 1/a away from exactly zero
    let alpha = 2 / r0 - V.lengthSq() / gm;
    if (Math.abs(alpha * r0) < PARABOLIC_EPS) {
      alpha = (alpha > 0 ? PARABOLIC_EPS : -PARABOLIC_EPS) / r0;
      const speed = Math.sqrt(gm * (2 / r0 - alpha));
      V.multiplyScalar(speed / V.length());
      h.crossVectors(R, V);
      hmag = h.length();
    }

    o.p = hmag * hmag / gm;
    o.H.copy(h).multiplyScalar(1 / hmag);
    const evec = new Vector3().crossVectors(V, h).multiplyScalar(1 / gm).sub(rhat);
    const pa = o.p * alpha;
    let e = Math.abs(pa) < 1e-3 ? Math.sqrt(Math.max(0, 1 - pa)) : evec.length();
    if (alpha < 0 && e < 1) e = 1;
    if (alpha > 0 && e > 1) e = 1;

    const rv = R.dot(V);
    if (e < CIRCULAR_E) {
      o.e = 0;
      alpha = 1 / o.p;
      o.P.copy(rhat).addScaledVector(o.H, -rhat.dot(o.H)).normalize();
      o.Q.crossVectors(o.H, o.P);
      o.M0 = 0;
      return o._finish(alpha);
    }
    o.e = e;
    o.P.copy(evec).addScaledVector(o.H, -evec.dot(o.H));
    if (o.P.lengthSq() > 0) o.P.normalize();
    else o.P.copy(rhat).addScaledVector(o.H, -rhat.dot(o.H)).normalize();
    o.Q.crossVectors(o.H, o.P);
    o._finish(alpha);
    if (!o.hyper) {
      const E = Math.atan2(rv * Math.sqrt(alpha / gm), 1 - r0 * alpha);
      o.M0 = o.ome * Math.sin(E) + xMinusSin(E);
    } else {
      const F = Math.asinh(rv * Math.sqrt(-alpha / gm) / e);
      o.M0 = -o.ome * Math.sinh(F) + sinhMinusX(F);
    }
    return o;
  }

  /** Orbit from classical elements. i, lan, argp in DEGREES, M0 in radians. a < 0 with e > 1 is hyperbolic. */
  static fromElements({ a, e = 0, i = 0, lan = 0, argp = 0, M0 = 0 }, gm, t0 = 0) {
    const o = new Orbit();
    o.gm = gm; o.t0 = t0; o.M0 = M0;
    if (e > 1 && a > 0) a = -a;
    if (Math.abs(e - 1) < 1e-12) e = e < 1 ? 1 - 1e-12 : 1 + 1e-12;
    o.e = e;
    o.p = a * (1 - e * e);
    const d = Math.PI / 180;
    const ci = Math.cos(i * d), si = Math.sin(i * d);
    const cO = Math.cos(lan * d), sO = Math.sin(lan * d);
    const cw = Math.cos(argp * d), sw = Math.sin(argp * d);
    // standard Z-up perifocal basis ...
    const px = cO * cw - sO * sw * ci, py = sO * cw + cO * sw * ci, pz = sw * si;
    const qx = -cO * sw - sO * cw * ci, qy = -sO * sw + cO * cw * ci, qz = cw * si;
    // ... mapped (x, y, z)_std → (x, z, −y) into the Y-up frame
    o.P.set(px, pz, -py).normalize();
    o.Q.set(qx, qz, -qy);
    o.H.crossVectors(o.P, o.Q).normalize();
    o.Q.crossVectors(o.H, o.P);
    return o._finish(1 / a);
  }

  /** Mean anomaly at time t (wrapped to [−π, π] for closed orbits). */
  meanAnomalyAt(t) {
    let M = this.M0 + this.n * (t - this.t0);
    if (!this.hyper) M -= TAU * Math.round(M / TAU);
    return M;
  }

  /** Eccentric anomaly E (closed) or hyperbolic anomaly F at time t. */
  anomalyAt(t) {
    const M = this.meanAnomalyAt(t);
    return this.hyper ? solveKeplerHyperbolic(M, this.e, this.ome) : solveKeplerElliptic(M, this.e, this.ome);
  }

  _state(t, r, v) {
    const A = this.anomalyAt(t);
    const a = this.a, e = this.e;
    let x, y, rr, vx, vy;
    if (!this.hyper) {
      const s = Math.sin(0.5 * A), s2 = 2 * s * s, sE = Math.sin(A);
      x = this.rp - a * s2;
      y = this.b * sE;
      rr = this.rp + a * e * s2;
      if (v) {
        const k = 1 / Math.max(rr, 1e-300);
        vx = -Math.sqrt(this.gm * a) * k * sE;
        vy = Math.sqrt(this.gm * this.p) * k * Math.cos(A);
      }
    } else {
      const s = Math.sinh(0.5 * A), s2 = 2 * s * s, sF = Math.sinh(A);
      x = this.rp + a * s2;
      y = this.b * sF;
      rr = this.rp - a * e * s2;
      if (v) {
        const k = 1 / Math.max(rr, 1e-300);
        vx = -Math.sqrt(-this.gm * a) * k * sF;
        vy = Math.sqrt(this.gm * this.p) * k * Math.cosh(A);
      }
    }
    const P = this.P, Q = this.Q;
    if (r) r.set(P.x * x + Q.x * y, P.y * x + Q.y * y, P.z * x + Q.z * y);
    if (v) v.set(P.x * vx + Q.x * vy, P.y * vx + Q.y * vy, P.z * vx + Q.z * vy);
  }

  stateAt(t) {
    const r = new Vector3(), v = new Vector3();
    this._state(t, r, v);
    return { r, v };
  }

  posAt(t, out = new Vector3()) { this._state(t, out, null); return out; }
  velAt(t, out = new Vector3()) { this._state(t, null, out); return out; }

  /** True anomaly at time t, in (−π, π]. */
  trueAnomalyAt(t) {
    const A = this.anomalyAt(t);
    if (!this.hyper) {
      return 2 * Math.atan2(Math.sqrt(1 + this.e) * Math.sin(0.5 * A), Math.sqrt(Math.max(this.ome, 0)) * Math.cos(0.5 * A));
    }
    return 2 * Math.atan2(Math.sqrt(1 + this.e) * Math.tanh(0.5 * A), Math.sqrt(Math.max(-this.ome, 0)));
  }

  /** Distance from the body centre at true anomaly nu (Infinity beyond a hyperbola's asymptote). */
  radiusAtTrueAnomaly(nu) {
    const d = 1 + this.e * Math.cos(nu);
    return d > 1e-12 ? this.p / d : Infinity;
  }

  posAtTrueAnomaly(nu, out = new Vector3()) {
    const r = this.radiusAtTrueAnomaly(nu);
    const x = r * Math.cos(nu), y = r * Math.sin(nu);
    const P = this.P, Q = this.Q;
    return out.set(P.x * x + Q.x * y, P.y * x + Q.y * y, P.z * x + Q.z * y);
  }

  velAtTrueAnomaly(nu, out = new Vector3()) {
    const k = Math.sqrt(this.gm / this.p);
    const x = -k * Math.sin(nu), y = k * (this.e + Math.cos(nu));
    const P = this.P, Q = this.Q;
    return out.set(P.x * x + Q.x * y, P.y * x + Q.y * y, P.z * x + Q.z * y);
  }

  /**
   * True anomaly (≥ 0, the outbound crossing) at which the orbit is at radius r.
   * Clamped: returns 0 below periapsis and π (or the asymptote angle) above apoapsis.
   */
  trueAnomalyAtRadius(r) {
    if (this.e === 0) return 0;
    let c = (this.p / r - 1) / this.e;
    if (!(c < 1)) c = 1; else if (c < -1) c = -1;
    return Math.acos(c);
  }

  /** Largest reachable true anomaly: π for closed orbits, the asymptote angle for hyperbolic ones. */
  get maxTrueAnomaly() {
    return this.hyper ? Math.acos(-1 / this.e) : Math.PI;
  }

  /**
   * Time at which the orbit is at true anomaly nu. Closed orbits: the next time ≥ `after`.
   * Hyperbolic: the unique time (may be < after); ±Infinity if nu is beyond the asymptote.
   */
  timeAtTrueAnomaly(nu, after = this.t0) {
    const e = this.e;
    if (!this.hyper) {
      const E = 2 * Math.atan2(Math.sqrt(Math.max(this.ome, 0)) * Math.sin(0.5 * nu), Math.sqrt(1 + e) * Math.cos(0.5 * nu));
      return this._nextTimeAtMean(this.ome * Math.sin(E) + xMinusSin(E), after);
    }
    nu -= TAU * Math.round(nu / TAU);
    const x = Math.sqrt(-this.ome / (1 + e)) * Math.tan(0.5 * nu);
    if (!(Math.abs(x) < 1)) return nu > 0 ? Infinity : -Infinity;
    const F = 2 * Math.atanh(x);
    const M = -this.ome * Math.sinh(F) + sinhMinusX(F);
    return this.t0 + (M - this.M0) / this.n;
  }

  // closed orbits: next time ≥ `after` at which the mean anomaly equals M
  _nextTimeAtMean(M, after) {
    const T = TAU / this.n;
    let t = this.t0 + (M - this.M0) / this.n;
    if (Number.isFinite(after)) {
      t += Math.ceil((after - t) / T) * T;
      if (t < after) t = t < after - 1e-9 * T ? t + T : after;
      else if (t - T >= after) t -= T;
    }
    return t;
  }

  /**
   * Time at which the orbit crosses radius r on the inbound (descending) or outbound leg.
   * Well conditioned even for near-radial orbits, unlike going through the true anomaly.
   * Closed orbits: next time ≥ `after`. Hyperbolic: the unique time (may be < after).
   * r is clamped to [periapsis, apoapsis].
   */
  timeAtRadius(r, inbound = false, after = this.t0) {
    if (this.e === 0) return after;
    let s2 = (r - this.rp) / (2 * Math.abs(this.a) * this.e);
    if (!(s2 > 0)) s2 = 0;
    if (!this.hyper) {
      let E = 2 * Math.asin(Math.sqrt(s2 > 1 ? 1 : s2));
      if (inbound) E = -E;
      return this._nextTimeAtMean(this.ome * Math.sin(E) + xMinusSin(E), after);
    }
    let F = 2 * Math.asinh(Math.sqrt(s2));
    if (inbound) F = -F;
    return this.t0 + (-this.ome * Math.sinh(F) + sinhMinusX(F) - this.M0) / this.n;
  }

  /** Radii from the body centre. */
  get periapsis() { return this.rp; }
  get apoapsis() { return this.hyper ? Infinity : this.a * (1 + this.e); }
  get period() { return this.hyper ? Infinity : TAU / this.n; }
  /** Specific orbital energy (J/kg). */
  get energy() { return -0.5 * this.gm * this.alpha; }
  /** Radians: angle between the orbit normal and +Y (0 = prograde equatorial, π = retrograde). */
  get inclination() {
    const y = this.H.y;
    return Math.acos(y > 1 ? 1 : y < -1 ? -1 : y);
  }

  /** Seconds until the next periapsis (hyperbolic: may be negative once past it). */
  timeToPeriapsis(t) { return this.timeAtTrueAnomaly(0, t) - t; }
  /** Seconds until the next apoapsis (Infinity for hyperbolic orbits). */
  timeToApoapsis(t) { return this.hyper ? Infinity : this.timeAtTrueAnomaly(Math.PI, t) - t; }

  clone() { return Orbit.fromJSON(this.toJSON()); }

  toJSON() {
    return {
      gm: this.gm, e: this.e, p: this.p, a: this.a, M0: this.M0, t0: this.t0,
      P: this.P.toArray(), Q: this.Q.toArray(), H: this.H.toArray(),
    };
  }

  static fromJSON(j) {
    const o = new Orbit();
    o.gm = j.gm; o.e = j.e; o.p = j.p; o.M0 = j.M0; o.t0 = j.t0;
    o.P.fromArray(j.P); o.Q.fromArray(j.Q); o.H.fromArray(j.H);
    return o._finish(1 / j.a);
  }
}
