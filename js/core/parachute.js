// Starwright: what a parachute is. One description, used twice: js/core/vessel.js flies it and js/render/canopy.js
// draws it, so the canopy on the screen is the canopy in the physics (its width, its height above the craft, its
// shape while it fills). No DOM, no THREE. Written up in docs/PARACHUTES.md.
//
// A part's `chute` block says how much drag it makes: `area × TUNING.CHUTE_CD` fully open, `semiArea × CHUTE_CD`
// reefed (held partly closed for the fast part of the descent). Everything else follows from that:
//
//   cloth          a flat round canopy of nominal diameter D0 with drag coefficient CD0 on its cloth area
//                  (drag area = CD0 · π D0² / 4), `count` of them side by side in a cluster
//   inflated       the open mouth is PROJ · D0 across; a reefed or filling canopy is as wide as its drag area asks for
//                  at the same coefficient, and since the cloth from skirt to crown is D0/2 long whatever the width,
//                  a narrow canopy is a long one (a reefed parachute is a sock, not a small dome)
//   lines          LINE · D0 long from the confluence to the skirt, on a riser RISER · D0 long
//   filling        a canopy fills from the air it passes through, so by distance travelled, not by the clock:
//                  STRETCH diameters to pull out and fill the reefed stage, DISREEF diameters to open fully.
//                  The reefed stage is itself let out gradually: the reefing line holds the mouth at REEF_FIRST of
//                  the reefed drag area at first and pays out to all of it over REEF_TIME seconds (cutters on a
//                  timer, as on a real staged canopy). That is what lets one canopy open at Mach 1.4 near the ground.
//                  Below its `fullAlt` the last reefing line is cut as soon as the mouth has filled and opening fully
//                  would not overload the lines (or when the reefed stage is all the way out, whatever the load).
//   air it carries the air inside the canopy and around it has to be moved with it: ADDED × the half ellipsoid of air
//                  it encloses. That mass has inertia and no weight.
//   strength       the part states what its lines hold (`strength`, kN) and the Mach number it may open at
//                  (`maxMach`). An armed parachute opens when it is slow enough AND the load of opening here, worked
//                  out from the air and the mass hanging on it, is inside that strength with a margin.

export const CHUTE = {
  CD0: 0.8,            // drag coefficient of the open canopy on its nominal (cloth) area
  PROJ: 0.67,          // inflated diameter / nominal diameter, fully open
  LINE: 1.0,           // suspension line length / nominal diameter
  RISER: 0.10,         // riser length (pack to the point the lines meet) / nominal diameter
  STRETCH: 3,          // nominal diameters travelled to pull the canopy out to the end of its lines and fill its mouth
  REEF_FIRST: 0.03,    // the reefed stage starts at this share of its drag area ...
  REEF_TIME: 6,       // ... and is let out to all of it over this many seconds
  DISREEF: 4,          // nominal diameters travelled from reefed to fully open
  DISREEF_EXP: 2,      // the drag area grows with the fill fraction to this power while it opens fully
  ADDED: 1.5,          // air moved with the canopy, as a multiple of the half ellipsoid it encloses
  SKIRT_FULL: 0.12,    // rad: how far the skirt curls in under the widest part, fully open ...
  SKIRT_REEFED: 0.95,  // ... and reefed
  OPEN_MARGIN: 0.8,    // an armed parachute opens only when the load of opening is expected to stay under this share of its strength
  OPEN_AIR: 1.1,       // the sequencer's allowance for the air the canopy sets moving, on top of its drag
  FAIL_TIME: 0.25,     // s at twice its strength before the canopy tears away
  CONTACT_W: 4,        // rad/s: stiffness of two canopies pressing on each other, as a natural frequency
  MIN_MASS: 1,         // kg: floor of the canopy's inertia (in thin air it carries almost none)
};

const specs = new WeakMap();
const smooth = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);

/**
 * The fixed numbers of a parachute part. `cd` is TUNING.CHUTE_CD (drag area per unit of the part's `area`).
 * → { cdsFull, cdsReef (m², all canopies), count, d0 (m, nominal diameter of ONE canopy), gore (m, skirt to apex
 *     along the cloth), line, riser (m), rmFull (m, inflated radius of one canopy), maxMach, rated (N: what the lines
 *     hold), fullAlt (m) }
 */
export function chuteSpec(def, cd = 1.6) {
  let s = specs.get(def);
  if (s && s.cd === cd) return s;
  const ch = def.chute, count = ch.count || 1;
  const cdsFull = ch.area * cd, cdsReef = ch.semiArea * cd;
  const d0 = Math.sqrt(4 * (cdsFull / count) / (Math.PI * CHUTE.CD0));
  s = {
    cd, cdsFull, cdsReef, count, d0, gore: d0 / 2, line: CHUTE.LINE * d0, riser: CHUTE.RISER * d0,
    rmFull: CHUTE.PROJ * d0 / 2, maxMach: ch.maxMach || 1.5, rated: (ch.strength || 25 * cdsReef) * 1000, fullAlt: ch.fullAlt,
  };
  specs.set(def, s);
  return s;
}

/**
 * Drag area (m², all canopies) in a stage ('semi' = reefed, 'full') at fill fraction 0..1 of that stage. The full
 * stage opens from the drag area `from` it had when the last reefing line was cut.
 */
export function chuteDragArea(spec, stage, fill, from = spec.cdsReef) {
  const f = fill <= 0 ? 0 : fill >= 1 ? 1 : fill;
  if (stage === 'semi') return spec.cdsReef * f;
  if (stage === 'full') return from + (spec.cdsFull - from) * Math.pow(f, CHUTE.DISREEF_EXP);
  return 0;
}

/** Distance (m) the canopy travels through the air to complete a stage. */
export function chuteFillDistance(spec, stage) { return (stage === 'semi' ? CHUTE.STRETCH : CHUTE.DISREEF) * spec.d0; }

// length of the cloth from the apex (phi = 0) to the skirt (phi = pi/2 + delta) on the ellipse r = rm sin phi, y = c cos phi
function meridian(rm, c, delta) {
  const n = 24, end = Math.PI / 2 + delta, h = end / n;
  let s = 0;
  for (let i = 0; i < n; i++) {                       // Simpson on each of n panels would be overkill: midpoint, 24 panels
    const p = (i + 0.5) * h, a = rm * Math.cos(p), b = c * Math.sin(p);
    s += Math.sqrt(a * a + b * b);
  }
  return s * h;
}

/**
 * The shape of ONE canopy making drag area `cds` (m², all canopies together). The canopy is the part of an ellipsoid
 * of revolution from its apex down past its widest circle to a skirt that curls in by `delta`; the cloth from apex to
 * skirt is always `gore` long, which fixes how tall it stands.
 * → out: { rm (widest radius), c (height of the crown above the widest circle), delta, rs (skirt radius),
 *          drop (the skirt hangs this far below the widest circle), h (confluence to skirt plane), riser,
 *          L (pack to the widest circle: where the drag acts), top (pack to apex), tilt (rad: each canopy of a cluster
 *          leans out by this), count }
 */
export function chuteShape(spec, cds, out = {}) {
  const cdp = CHUTE.CD0 / (CHUTE.PROJ * CHUTE.PROJ);
  let rm = Math.sqrt(Math.max(cds, 0) / spec.count / (Math.PI * cdp));
  if (rm > spec.rmFull) rm = spec.rmFull;
  if (rm < 0.02 * spec.rmFull) rm = 0.02 * spec.rmFull;
  const e = rm / spec.rmFull;
  const delta = CHUTE.SKIRT_REEFED + (CHUTE.SKIRT_FULL - CHUTE.SKIRT_REEFED) * smooth((e - 0.1) / 0.8);
  // crown height from the cloth length (bisection: the length grows with c)
  let lo = 0.05 * rm, hi = spec.gore * 1.2;
  for (let i = 0; i < 28; i++) { const mid = 0.5 * (lo + hi); if (meridian(rm, mid, delta) < spec.gore) lo = mid; else hi = mid; }
  const c = 0.5 * (lo + hi);
  const rs = rm * Math.cos(delta), drop = c * Math.sin(delta);
  const h = Math.sqrt(Math.max(spec.line * spec.line - rs * rs, 0.01));
  out.rm = rm; out.c = c; out.delta = delta; out.rs = rs; out.drop = drop; out.h = h; out.riser = spec.riser; out.count = spec.count;
  out.tilt = spec.count > 1 ? Math.asin(Math.min(0.9, 1.03 * rm / Math.sin(Math.PI / spec.count) / (h + drop))) : 0;
  const ct = Math.cos(out.tilt);
  out.L = spec.riser + (h + drop) * ct;
  out.top = spec.riser + (h + drop + c) * ct + (spec.count > 1 ? rm * Math.sin(out.tilt) : 0);
  return out;
}

/** How far a parachute reaches sideways from its own axis (m): one canopy's radius, or the circle round a cluster. */
export function chuteReach(shape) {
  return shape.count > 1 ? shape.rm * Math.cos(shape.tilt) + (shape.h + shape.drop) * Math.sin(shape.tilt) : shape.rm;
}

/** Air carried with the canopies (kg): inertia without weight. */
export function chuteAddedMass(spec, shape, rho) {
  return spec.count * CHUTE.ADDED * rho * (2 / 3) * Math.PI * shape.rm * shape.rm * shape.c;
}

/**
 * How far the reefed stage has come, 0..1 of its drag area: `s` m travelled since it left the pack, `t` s ago.
 * The mouth fills over the first STRETCH diameters; the reefing line pays out from REEF_FIRST to 1 over REEF_TIME.
 */
export function chuteReefProgress(spec, s, t) {
  const f = s / (CHUTE.STRETCH * spec.d0), r = CHUTE.REEF_FIRST + (1 - CHUTE.REEF_FIRST) * (t / CHUTE.REEF_TIME);
  return (f >= 1 ? 1 : f <= 0 ? 0 : f) * (r >= 1 ? 1 : r);
}

/**
 * The largest line load (N) to expect if a packed parachute opens now, in air of density rho at dynamic pressure q,
 * with `mass` kg hanging on it: the reefed stage is run forward on a point mass that feels nothing but the canopy
 * (m dv/dt = -(rho/2) v^2 C(s, t)), and the largest drag on the way is returned with an allowance for the air set
 * moving. Gravity `g` (m/s²) is taken to pull straight along the flight path, the worst case, and the craft's own drag
 * is left out: this is the sequencer's estimate, not the flight model.
 */
export function chuteOpeningLoad(spec, q, rho, mass, g = 0) {
  if (!(rho > 0) || !(q > 0) || !(mass > 0)) return 0;
  let v = Math.sqrt(2 * q / rho), s = 0, t = 0, peak = 0;
  const end = CHUTE.REEF_TIME + 0.2, k = 0.5 * rho * spec.cdsReef / mass;
  while (t < end) {
    // steps short enough to see the mouth fill (a tenth of that distance) and never longer than 50 ms
    const dt = Math.min(0.05, 0.1 * CHUTE.STRETCH * spec.d0 / v);
    const a = k * chuteReefProgress(spec, s + 0.5 * v * dt, t + 0.5 * dt);
    const f = a * v * v * mass;
    if (f > peak) peak = f;
    v = (v + g * dt) / (1 + a * v * dt); s += v * dt; t += dt;
    if (f < 0.5 * peak && t > 0.5) break;
  }
  return peak * CHUTE.OPEN_AIR;
}

/**
 * The largest line load (N) to expect if the last reefing line is cut now: the canopy opens from drag area `from` to
 * all of it over DISREEF diameters, on a point mass at dynamic pressure q in air of density rho. Here the air the
 * canopy takes along matters (fully open it outweighs a light capsule), so the mass and that air slow together:
 * (m + m_a) dv = m g dt - (rho/2) v^2 C dt - v dm_a, and the line carries what slows the mass, m (g - dv/dt), with
 * gravity `g` along the flight path (the worst case). The air carried is scaled from the fully open canopy as
 * (drag area)^1.5.
 */
export function chuteDisreefLoad(spec, q, rho, mass, from = spec.cdsReef, g = 0) {
  if (!(rho > 0) || !(q > 0) || !(mass > 0)) return 0;
  if (!spec.maFull) { const sh = chuteShape(spec, spec.cdsFull, {}); spec.maFull = chuteAddedMass(spec, sh, 1); }
  const sf = chuteFillDistance(spec, 'full'), n = 60, ds = sf / n;
  const air = c => rho * spec.maFull * Math.pow(c / spec.cdsFull, 1.5);
  let v = Math.sqrt(2 * q / rho), peak = 0, ma = air(from);
  for (let i = 0; i < n; i++) {
    const c = chuteDragArea(spec, 'full', (i + 0.5) / n, from), ma1 = air(chuteDragArea(spec, 'full', (i + 1) / n, from));
    // per metre travelled: dv/ds = -[ (rho/2) v C + v dm_a/ds ] / (m + m_a)
    const dv = (mass * g / v - 0.5 * rho * v * c - v * (ma1 - ma) / ds) / (mass + 0.5 * (ma + ma1));
    const f = mass * (g - dv * v);
    if (f > peak) peak = f;
    v = Math.max(v + dv * ds, 0.2 * v); ma = ma1;
  }
  return peak;
}

/**
 * May a packed, armed parachute open here? `mass` is the mass (kg) this parachute will carry.
 * → 'ok' | 'thin' (not enough air to fill it) | 'mach' (too fast) | 'load' (opening now would overload its lines)
 */
export function chuteGate(spec, pAtm, minPressure, mach, qdyn, rho, mass, g = 0) {
  if (!(pAtm >= minPressure)) return 'thin';
  if (mach >= spec.maxMach) return 'mach';
  if (chuteOpeningLoad(spec, qdyn, rho, mass, g) > CHUTE.OPEN_MARGIN * spec.rated) return 'load';
  return 'ok';
}
