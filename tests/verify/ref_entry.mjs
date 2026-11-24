// Independent reference for entry: trim of a capsule with its centre of mass off the axis, and the path of a
// lifting point mass through an atmosphere (docs/ENTRY.md). Nothing here imports the game's flight code. The trim
// comes from the triangle meshes of ref_aero.mjs; the path from the adaptive extrapolation integrator of ref.mjs
// (order 16, relative tolerance 1e-10), where the game's predictor is a fixed-step Runge-Kutta of order 4.
import * as R from './ref.mjs';
import * as RA from './ref_aero.mjs';

/**
 * Newtonian force and moment about `com` ([x, y, 0], metres in the stack's own frame) on a stack of parts moving
 * along u = (sin a, cos a, 0), per unit of q C_p,max. parts: [{ tris, y, r, shadeBy: [{ y, r }] }] where tris is the
 * part's mesh about its own centre, y its height in the stack and r its radius; shadeBy lists the wider parts that
 * may shelter it. A sheltered part keeps a tenth.
 */
export function stackNewton(parts, a, com) {
  const u = [Math.sin(a), Math.cos(a), 0];
  const F = [0, 0, 0]; let Mz = 0;
  for (const p of parts) {
    let sh = 0;
    for (const c of p.shadeBy || []) sh = Math.max(sh, RA.shade([0, p.y, 0], p.r, [0, c.y, 0], c.r, u));
    const keep = 1 - 0.9 * sh, n = RA.newton(p.tris, u);
    const fx = n.F[0] * keep, fy = n.F[1] * keep;
    F[0] += fx; F[1] += fy;
    Mz += n.M[2] * keep + (0 - com[0]) * fy - (p.y - com[1]) * fx;
  }
  return { F, Mz, u };
}
/** The angle near `guess` (radians, between the stack's +y and its motion) at which the moment about com is zero. */
export function trimAngle(parts, com, guess, span = 0.3) {
  let lo = guess - span, hi = guess + span, flo = stackNewton(parts, lo, com).Mz, fhi = stackNewton(parts, hi, com).Mz;
  if (!(flo * fhi < 0)) return NaN;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2, f = stackNewton(parts, mid, com).Mz;
    if (f * flo > 0) { lo = mid; flo = f; } else { hi = mid; fhi = f; }
  }
  return (lo + hi) / 2;
}
/** Lift over drag of the stack at angle a. */
export function liftOverDrag(parts, a) {
  const { F, u } = stackNewton(parts, a, [0, 0]);
  const along = F[0] * u[0] + F[1] * u[1];
  return Math.hypot(F[0] - along * u[0], F[1] - along * u[1]) / Math.abs(along);
}

/**
 * A point mass with drag area cdA(mach) (m²), lift over drag ld and bank (rad; 0 = lift straight up, positive = to
 * the right of the path) flown through the air of body b (a reference body from ref.mjs) from r0, v0 (inertial,
 * body-centred, arrays) until it reaches `floor` metres above the datum, leaves through the top of the air, or
 * tMax passes. With ldFade = [m0, m1] the lift fades smoothly from full at Mach m1 to none at Mach m0. The air turns
 * with the body about +y. heatK is the constant of the heating law K sqrt(rho) v^3.
 * → { end: 'land' | 'skip' | 'time', t, r, v, maxG, maxFlux, maxGSpeed, maxFluxSpeed }
 */
export function flyEntry(b, r0, v0, { mass, cdA, ld: ld0 = 0, ldFade = null, bank = 0, floor = 0, tMax = 4000, heatK = 0 }) {
  const wy = R.TAU / b.rotPeriod, top = b.atmo.height, cb = Math.cos(bank), sb = Math.sin(bank);
  const aero = (r, v) => {
    const rr = R.norm(r), alt = rr - b.radius, rho = R.airDensity(b, alt);
    if (!(rho > 0)) return { a: [0, 0, 0], g: 0, flux: 0, sp: 0 };
    const s = [v[0] - wy * r[2], v[1], v[2] + wy * r[0]], sp = R.norm(s), e = R.scale(s, 1 / sp);
    const mach = sp / R.soundSpeed(b, alt), D = 0.5 * rho * sp * sp * cdA(mach) / mass;
    let a = R.scale(e, -D), g = D;
    // the lift fades out between two Mach numbers on the way down (a falling capsule has none to steer with)
    let k = 1;
    if (ldFade) { const x = Math.min(1, Math.max(0, (mach - ldFade[0]) / (ldFade[1] - ldFade[0]))); k = x * x * (3 - 2 * x); }
    const ld = ld0 * k;
    if (ld) {
      const up = R.scale(r, 1 / rr), h = R.unit(R.sub(up, R.scale(e, R.dot(up, e)))), right = R.cross(e, h);
      a = R.add(a, R.scale(R.add(R.scale(h, cb), R.scale(right, sb)), D * ld));
      g = D * Math.hypot(1, ld);
    }
    return { a, g, flux: heatK * Math.sqrt(rho) * sp ** 3, sp };
  };
  const deriv = (t, y, out) => {
    const r = [y[0], y[1], y[2]], v = [y[3], y[4], y[5]], rr = R.norm(r), k = -b.gm / rr ** 3, A = aero(r, v).a;
    out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; out[3] = k * r[0] + A[0]; out[4] = k * r[1] + A[1]; out[5] = k * r[2] + A[2];
  };
  const y = new Float64Array([...r0, ...v0]);
  const res = { end: 'time', t: 0, r: null, v: null, maxG: 0, maxFlux: 0, maxGSpeed: 0, maxFluxSpeed: 0 };
  let t = 0, wasIn = false, prev = null;
  const h = 0.25;                                        // the integrator is asked for the state every quarter second
  while (t < tMax) {
    const r = [y[0], y[1], y[2]], v = [y[3], y[4], y[5]], alt = R.norm(r) - b.radius;
    const s = aero(r, v);
    if (s.g > res.maxG) { res.maxG = s.g; res.maxGSpeed = s.sp; }
    if (s.flux > res.maxFlux) { res.maxFlux = s.flux; res.maxFluxSpeed = s.sp; }
    if (alt <= floor) {
      // back along the last quarter second to the crossing
      if (prev) { const f = (alt - floor) / (alt - prev.alt); for (let k = 0; k < 6; k++) y[k] += (prev.y[k] - y[k]) * f; t += (prev.t - t) * f; }
      res.end = 'land'; break;
    }
    if (wasIn && alt >= top && R.dot(r, v) > 0) {
      if (prev && prev.alt < top) { const f = (alt - top) / (alt - prev.alt); for (let k = 0; k < 6; k++) y[k] += (prev.y[k] - y[k]) * f; t += (prev.t - t) * f; }
      res.end = 'skip'; break;
    }
    if (alt < top) wasIn = true;
    prev = { alt, y: Float64Array.from(y), t };
    R.integrate(deriv, y, t, t + h, { rtol: 1e-10, h0: h });
    t += h;
  }
  res.t = t; res.r = [y[0], y[1], y[2]]; res.v = [y[3], y[4], y[5]];
  return res;
}
