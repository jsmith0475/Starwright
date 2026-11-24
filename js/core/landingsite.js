// Starwright landing-site assessment: what the ground is like where a lander is about to stand, and where the
// nearest ground fit to stand on is. PURE SIMULATION - runs under Node. Nothing here moves a vessel: these functions
// only read the height field (the same one the physics stands the craft on), and the landing programs in
// autopilot.js and booster.js decide what to do with the answer. Written up in docs/LANDING_SITES.md.
import { Vector3 } from '../lib/three.module.min.js';
import { surfaceAt, waterAt, deckUnder } from './vessel.js';

const Y_AXIS = new Vector3(0, 1, 0);
const _d = new Vector3(), _e = new Vector3(), _n = new Vector3(), _p = new Vector3();
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const RING = 8;
const COS = [], SIN = [];
for (let i = 0; i < RING; i++) { COS.push(Math.cos(i * Math.PI * 2 / RING)); SIN.push(Math.sin(i * Math.PI * 2 / RING)); }

/** East and north unit vectors (body-fixed) at body-fixed direction d. */
function tangents(d, east, north) {
  east.crossVectors(Y_AXIS, d);
  if (east.lengthSq() < 1e-10) east.set(1, 0, 0);
  east.normalize();
  north.crossVectors(d, east);
}

/**
 * The ground within `radius` metres of body-fixed direction `dir`: the plane that best fits seventeen heights (the
 * middle, a ring at the radius and a ring at half of it), and how far the ground departs from that plane.
 * → { h (m above body.radius, at the middle), slope (rad, tilt of the fitted plane), gx, gy (rise / run to the east
 *     and north), rough (m, the largest departure of a sampled height from the plane), water (open water under any
 *     sample), deck (a built deck under the middle: level by construction) }
 */
export function assessSite(body, dir, radius = 4, out = {}) {
  const d = _d.copy(dir).normalize();
  out.h = 0; out.slope = 0; out.gx = 0; out.gy = 0; out.rough = 0; out.water = false; out.deck = false;
  if (typeof body.terrainHeight !== 'function') { out.water = !!body.ocean && waterAt(body, d); return out; }
  const R = body.radius;
  tangents(d, _e, _n);
  const h0 = surfaceAt(body, d);
  out.h = h0;
  out.water = waterAt(body, d) && !deckUnder(body, d);
  out.deck = deckUnder(body, d);
  const hs = [];
  let sx = 0, sy = 0, sh = h0, sxx = 0;
  for (let ring = 0; ring < 2; ring++) {
    const r = ring ? radius * 0.5 : radius;
    for (let i = 0; i < RING; i++) {
      const x = r * COS[i], y = r * SIN[i];
      _p.copy(d).addScaledVector(_e, x / R).addScaledVector(_n, y / R).normalize();
      const h = surfaceAt(body, _p);
      if (!out.water && waterAt(body, _p) && !deckUnder(body, _p)) out.water = true;
      hs.push(x, y, h);
      sx += h * x; sy += h * y; sh += h; sxx += x * x;
    }
  }
  // (the sample points are symmetric about the middle, so the least-squares plane separates)
  const gx = sx / sxx, gy = sy / sxx, mean = sh / (2 * RING + 1);
  let rough = Math.abs(h0 - mean);
  for (let i = 0; i < hs.length; i += 3) rough = Math.max(rough, Math.abs(hs[i + 2] - (mean + gx * hs[i] + gy * hs[i + 1])));
  out.gx = gx; out.gy = gy; out.slope = Math.atan(Math.hypot(gx, gy)); out.rough = rough;
  return out;
}

/**
 * The steepest ground (rad) a vessel should be set down on: well inside the angle at which it would tip over its
 * own feet (atan of the footprint radius over the height of the centre of mass), because a lander does not arrive
 * perfectly still and a leg that lands downhill takes the weight first. Measured by setting stock landers down at
 * 1 m/s on real ground: one that tips at 13° stood on everything up to 6° and one that tips at 26° up to 8°.
 */
export function slopeLimit(vessel) {
  const tip = Math.atan2(vessel.baseRadius || 1, Math.max(0.05, vessel.baseHeight || 1));
  return clamp(0.4 * tip, 0.026, 0.105);
}
/** Radius (m) of the ground a vessel's feet need, with room for a touchdown a couple of metres off. */
export function footprint(vessel) { return clamp((vessel.baseRadius || 1) + 2, 3, 12); }

const _site = {}, _wide = {};
/** Is this ground fit to stand on? Fills `out` with the assessment (and `wide`, the slope of the ground round it). */
function fit(body, dir, radius, limit, roughLimit, out) {
  assessSite(body, dir, radius, out);
  out.wide = 0; out.ok = false;
  if (out.deck) { out.ok = true; return out; }
  if (out.water) return out;
  if (out.slope > limit || out.rough > roughLimit) return out;
  assessSite(body, dir, radius * 3, _wide);
  out.wide = _wide.slope;
  out.ok = !_wide.water && _wide.slope <= limit * 1.4 && _wide.rough <= roughLimit * 3;
  return out;
}

/**
 * Looks for ground fit to stand on within `reach` metres of body-fixed direction `near`, on a fixed spiral (so the
 * same question always gets the same answer). Fit means dry, no steeper than `limit` (rad) over `radius` metres,
 * no rougher than `roughLimit` (m off the fitted plane), and not on the lip of something steeper. Of the fit spots it
 * takes the one that is nearest, counting flatter ground as nearer.
 * → { ok, dir (body-fixed unit vector of the chosen spot), dist (m from `near`), slope, rough, wide, here (the
 *     assessment of `near` itself), fitCount, tested }. With no fit ground in reach `ok` is false and the spot is
 *     the least steep dry one found (dir is null when everything in reach is water).
 */
export function findSite(body, near, opts = {}) {
  const o = { radius: 4, reach: 300, limit: 0.1, roughLimit: 0, samples: 500, ...opts };
  const roughLimit = o.roughLimit || 0.08 * o.radius;
  const base = new Vector3().copy(near).normalize();
  const east = new Vector3(), north = new Vector3();
  tangents(base, east, north);
  const R = body.radius, d = new Vector3();
  const res = { ok: false, dir: null, dist: 0, slope: Infinity, rough: 0, wide: 0, here: null, fitCount: 0, tested: 0, limit: o.limit, reach: o.reach };
  let best = Infinity, fallback = Infinity;
  const n = Math.max(1, o.samples | 0);
  for (let i = 0; i < n; i++) {
    const ang = i * 2.399963229728653, rad = Math.sqrt(i / n) * o.reach;
    d.copy(base).addScaledVector(east, Math.cos(ang) * rad / R).addScaledVector(north, Math.sin(ang) * rad / R).normalize();
    const s = fit(body, d, o.radius, o.limit, roughLimit, _site);
    res.tested++;
    if (i === 0) res.here = { slope: s.slope, rough: s.rough, water: s.water, ok: s.ok, deck: s.deck };
    if (s.ok) {
      res.fitCount++;
      const q = s.slope / o.limit;
      const score = rad + 0.35 * o.reach * q * q;
      if (score < best) { best = score; res.ok = true; res.dir = d.clone(); res.dist = rad; res.slope = s.slope; res.rough = s.rough; res.wide = s.wide; }
      if (rad > best) break;              // nothing further out can beat it
    } else if (!res.ok && !s.water) {
      const score = Math.max(s.slope, s.wide / 1.4) + (s.rough > roughLimit ? 0.05 : 0) + 0.02 * rad / o.reach;
      if (score < fallback) { fallback = score; res.dir = d.clone(); res.dist = rad; res.slope = s.slope; res.rough = s.rough; res.wide = s.wide; }
    }
  }
  return res;
}
