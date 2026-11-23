// Starwright — body aerodynamics above the speed of sound (docs/REENTRY_SPEC.md part B).
//
// Plain functions and tables, no state. js/core/vessel.js calls them from its per-part force loop.
//
//   dragRise(mach, bluntness)   the multiplier on a face's low-speed drag coefficient: a blend of two curves, one for
//                               blunt faces and one for slender ones. 1 at and below Mach 0.7.
//   bluntness(c)                0 for a slender face (coefficient 0.2 or less) to 1 for a blunt one (0.7 or more)
//   wakeFraction(mach)          how much of a lee face's drag area the wake behind it adds: 0.25 up to Mach 1, then
//                               0.25 / Mach², because the base pressure cannot fall below a vacuum
//   newtonWeight(mach)          0 below Mach 1.5, 1 above Mach 4, smooth between: the share of the Newtonian force
//   shadowWeight(mach)          0 below Mach 0.7, 1 above Mach 1.5, smooth between: how much a wake shelters
//   pitotCp(mach, gamma)        the stagnation pressure coefficient behind a normal shock (Rayleigh pitot formula),
//                               the C_p,max of modified Newtonian theory
//   newtonTable(...)            for one part (a frustum with optional end faces, flat or a spherical cap): the
//                               Newtonian axial force, normal force and moment against angle of attack, per unit of
//                               q C_p,max, integrated over the surface that faces the flow
//   newtonAt(table, cosAlpha, out)   the three numbers at an angle, linear between the 2.5 degree rows
//
// Newtonian theory: the air is a stream of particles that give up their momentum normal to the surface they hit.
// A surface element whose outward normal n makes an angle with the direction of motion u feels
// C_p = C_p,max (n . u)^2 where it faces the flow, and nothing where it does not. It is the high Mach limit and it
// is good to a few percent for blunt shapes above about Mach 4; below Mach 1.5 the game's classic face-and-flank
// model is used, and between the two are blended.

/** Mach numbers of the drag curves, and the two curves. Tunables, calibrated in docs/AERODYNAMICS.md. */
export const DRAG_MACH = [0.7, 0.9, 1.1, 1.5, 2.5, 4, 8];
export const DRAG_BLUNT = [1.00, 1.25, 1.55, 1.75, 1.90, 1.98, 2.00];
export const DRAG_SLENDER = [1.00, 1.40, 1.90, 1.60, 1.10, 0.90, 0.80];
export const WAKE = 0.25;
export const NEWTON_FROM = 1.5, NEWTON_FULL = 4;
export const SHADOW_FROM = 0.7, SHADOW_FULL = 1.5;
/** What a part wholly in another's wake keeps of its force above Mach 1.5. */
export const SHADOW_KEEP = 0.1;
/** A wake closes: the shadow is whole to this many diameters behind the disc that casts it, and gone by the second. */
export const SHADOW_NEAR = 2, SHADOW_FAR = 4;
/** Rows of a Newtonian table: 0 to 180 degrees in 2.5 degree steps. */
export const NEWTON_ROWS = 73;

function curve(ys, mach) {
  const xs = DRAG_MACH, n = xs.length;
  if (mach <= xs[0]) return ys[0];
  if (mach >= xs[n - 1]) return ys[n - 1];
  let i = 1;
  while (mach > xs[i]) i++;
  return ys[i - 1] + (ys[i] - ys[i - 1]) * (mach - xs[i - 1]) / (xs[i] - xs[i - 1]);
}
export function bluntness(c) { return c <= 0.2 ? 0 : c >= 0.7 ? 1 : (c - 0.2) / 0.5; }
export function dragRise(mach, blunt = 1) {
  if (mach <= 0.7) return 1;
  return blunt >= 1 ? curve(DRAG_BLUNT, mach) : blunt <= 0 ? curve(DRAG_SLENDER, mach) : (1 - blunt) * curve(DRAG_SLENDER, mach) + blunt * curve(DRAG_BLUNT, mach);
}
export function wakeFraction(mach) { return mach <= 1 ? WAKE : WAKE / (mach * mach); }
const smooth = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
export function newtonWeight(mach) { return smooth((mach - NEWTON_FROM) / (NEWTON_FULL - NEWTON_FROM)); }
export function shadowWeight(mach) { return smooth((mach - SHADOW_FROM) / (SHADOW_FULL - SHADOW_FROM)); }

/**
 * Stagnation pressure coefficient behind a normal shock, (p02 - p1) / q. Below Mach 1 the isentropic value. Tends to
 * 1.839 for air (gamma 1.4) at high Mach number.
 */
export function pitotCp(mach, gamma = 1.4) {
  const g = gamma, m2 = mach * mach;
  if (!(mach > 0)) return 1;
  let ratio;
  if (mach <= 1) ratio = Math.pow(1 + 0.5 * (g - 1) * m2, g / (g - 1));
  else ratio = Math.pow((g + 1) * (g + 1) * m2 / (4 * g * m2 - 2 * (g - 1)), g / (g - 1)) * (1 - g + 2 * g * m2) / (g + 1);
  return (ratio - 1) / (0.5 * g * m2);
}

const _tables = new Map();
/**
 * The Newtonian table of a part: a frustum of radius rB at y = -h/2 and rT at y = +h/2, with what is left open of
 * each end face (outside a covered radius covB / covT). An end face is flat, or with capB / capT (radians) a
 * spherical cap of that half-angle bulging outward (used only when the face is wholly open).
 *
 * Returns a Float64Array of NEWTON_ROWS x 3. Row k is the angle of attack 2.5 k degrees: the angle between the part's
 * +y axis and its motion through the air, the motion being u = (sin a, cos a, 0). Columns, each per unit of q C_p,max:
 *   [0] force along +y (m²)      negative nose first: the air pushes back
 *   [1] force along +x (m²)      the side the motion leans to; negative
 *   [2] moment about +z through the part's centre (m³)
 */
export function newtonTable(rB, rT, h, covB = 0, covT = 0, capB = 0, capT = 0) {
  const key = rB + '|' + rT + '|' + h + '|' + covB + '|' + covT + '|' + capB + '|' + capT;
  let t = _tables.get(key);
  if (t) return t;
  t = new Float64Array(NEWTON_ROWS * 3);
  const NY = 24, NP = 72, NT = 24;
  const slant = Math.hypot(h, rB - rT), ny = slant > 0 ? (rB - rT) / slant : 0, nr = slant > 0 ? h / slant : 1;
  for (let k = 0; k < NEWTON_ROWS; k++) {
    const a = k * Math.PI / (NEWTON_ROWS - 1), ux = Math.sin(a), uy = Math.cos(a);
    let fx = 0, fy = 0, mz = 0;
    const add = (x, y, nx, nyy, dA) => {
      const c = nx * ux + nyy * uy;
      if (c <= 0) return;
      const p = c * c * dA, dfx = -p * nx, dfy = -p * nyy;
      fx += dfx; fy += dfy; mz += x * dfy - y * dfx;
    };
    // the flank: midpoint rule along the axis and round it (the two halves in z mirror each other)
    if (h > 0) for (let i = 0; i < NY; i++) {
      const s = (i + 0.5) / NY, y = -h / 2 + s * h, r = rB + (rT - rB) * s;
      const dA = r * (2 * Math.PI / NP) * (slant / NY);
      for (let j = 0; j < NP; j++) { const ps = (j + 0.5) * 2 * Math.PI / NP, cp = Math.cos(ps); add(r * cp, y, nr * cp, ny, dA); }
    }
    // the end faces
    for (const top of [true, false]) {
      const r = top ? rT : rB, cov = top ? covT : covB, cap = top ? capT : capB, sgn = top ? 1 : -1;
      if (!(r > cov)) continue;
      if (cap > 0 && cov === 0) {
        const Rn = r / Math.sin(cap), yc = sgn * (h / 2 - Rn * Math.cos(cap));
        for (let i = 0; i < NT; i++) {
          const th = (i + 0.5) / NT * cap, st = Math.sin(th), ct = Math.cos(th);
          const dA = Rn * Rn * st * (cap / NT) * (2 * Math.PI / NP);
          for (let j = 0; j < NP; j++) { const ps = (j + 0.5) * 2 * Math.PI / NP, cp = Math.cos(ps); add(Rn * st * cp, yc + sgn * Rn * ct, st * cp, sgn * ct, dA); }
        }
      } else {
        // flat: every element has the same normal, so only the area and its centre (the axis) matter
        add(0, sgn * h / 2, 0, sgn, Math.PI * (r * r - cov * cov));
      }
    }
    t[k * 3] = fy; t[k * 3 + 1] = fx; t[k * 3 + 2] = mz;
  }
  _tables.set(key, t);
  return t;
}

/** Linear interpolation in a Newtonian table at an angle given by its cosine. out = [along +y, along +x, moment z]. */
export function newtonAt(t, cosAlpha, out) {
  const a = Math.acos(cosAlpha > 1 ? 1 : cosAlpha < -1 ? -1 : cosAlpha) * (NEWTON_ROWS - 1) / Math.PI;
  let k = a | 0; if (k > NEWTON_ROWS - 2) k = NEWTON_ROWS - 2;
  const f = a - k, i = k * 3;
  out[0] = t[i] + (t[i + 3] - t[i]) * f; out[1] = t[i + 1] + (t[i + 4] - t[i + 1]) * f; out[2] = t[i + 2] + (t[i + 5] - t[i + 2]) * f;
  return out;
}
