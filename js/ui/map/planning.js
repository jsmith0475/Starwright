// Starwright — map planning maths (pure: only Vector3 maths, runs under Node; see tests/unit/mapplanning.test.js).
//
//   relativeNodes(orbitA, orbitB, after)      ascending / descending node of A relative to B's plane
//   findApproaches(orbitA, orbitB, t0, t1)    the (up to) two closest local minima of the separation
//   transferWindow(...)                       Hohmann phase-angle helper for two orbits around one parent
//   transferFor(world-ish, vessel, target)    picks the right pair of orbits for a vessel / body and a target
import { Vector3 } from '../../lib/three.module.min.js';

const TAU = Math.PI * 2;
const _n = new Vector3(), _p = new Vector3(), _q = new Vector3();

const wrapPi = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const wrapTau = a => { a %= TAU; return a < 0 ? a + TAU : a; };

/**
 * Where orbit A crosses the plane of orbit B (both around the same body).
 * → { relInc (rad), an: {nu, t, pos, radius} | null, dn: {...} | null }; a node that the conic never reaches
 * (hyperbolic asymptote) is null. `t` is the next time ≥ `after` for closed orbits.
 */
export function relativeNodes(orbitA, orbitB, after = 0) {
  const hA = orbitA.H, hB = orbitB.H;
  const relInc = Math.acos(Math.max(-1, Math.min(1, hA.dot(hB))));
  _n.crossVectors(hB, hA);                           // ascending node direction of A through B's plane
  const out = { relInc, an: null, dn: null };
  if (_n.lengthSq() < 1e-14) return out;             // co-planar: no line of nodes
  _n.normalize();
  const nuAn = Math.atan2(_n.dot(orbitA.Q), _n.dot(orbitA.P));
  const make = nu => {
    nu = wrapPi(nu);
    if (orbitA.hyper && Math.abs(nu) >= orbitA.maxTrueAnomaly - 1e-6) return null;
    const t = orbitA.timeAtTrueAnomaly(nu, after);
    if (!Number.isFinite(t)) return null;
    const pos = orbitA.posAtTrueAnomaly(nu);
    return { nu, t, pos, radius: pos.length() };
  };
  out.an = make(nuAn);
  out.dn = make(nuAn + Math.PI);
  return out;
}

function sep2(a, b, t) { a.posAt(t, _p); b.posAt(t, _q); return _p.distanceToSquared(_q); }

/**
 * Local minima of the separation of two orbits around the same body over [t0, t1], refined by golden-section
 * search. Returns at most `max` of them (the closest ones), sorted by time: [{ t, distance, relSpeed }].
 * A minimum sitting on the very start of the window (already receding) is skipped unless nothing else exists.
 */
export function findApproaches(orbitA, orbitB, t0, t1, { max = 2, samples = 0 } = {}) {
  if (!(t1 > t0) || !Number.isFinite(t1)) return [];
  const span = t1 - t0;
  let N = samples | 0;
  if (N < 2) {
    const P = Math.min(orbitA.period, orbitB.period);
    N = Number.isFinite(P) && P > 0 ? Math.ceil(90 * span / P) : 240;
    N = Math.max(96, Math.min(3000, N));
  }
  const d = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) d[i] = sep2(orbitA, orbitB, t0 + span * i / N);
  const g = 0.6180339887498949;
  const found = [];
  for (let i = 1; i < N; i++) {
    if (d[i] > d[i - 1] || d[i] >= d[i + 1]) continue;
    let a = t0 + span * (i - 1) / N, b = t0 + span * (i + 1) / N;
    let c1 = b - g * (b - a), c2 = a + g * (b - a);
    let f1 = sep2(orbitA, orbitB, c1), f2 = sep2(orbitA, orbitB, c2);
    for (let k = 0; k < 60 && b - a > 1e-3; k++) {
      if (f1 < f2) { b = c2; c2 = c1; f2 = f1; c1 = b - g * (b - a); f1 = sep2(orbitA, orbitB, c1); }
      else { a = c1; c1 = c2; f1 = f2; c2 = a + g * (b - a); f2 = sep2(orbitA, orbitB, c2); }
    }
    found.push({ t: f1 < f2 ? c1 : c2, d2: Math.min(f1, f2) });
  }
  if (!found.length) {
    // monotonic over the window: the nearer end is the best we can say
    const i = d[N] < d[0] ? N : 0;
    found.push({ t: t0 + span * i / N, d2: d[i] });
  }
  found.sort((x, y) => x.d2 - y.d2);
  const best = found.slice(0, Math.max(1, max)).sort((x, y) => x.t - y.t);
  return best.map(m => {
    const a = orbitA.stateAt(m.t), b = orbitB.stateAt(m.t);
    return { t: m.t, distance: a.r.distanceTo(b.r), relSpeed: a.v.distanceTo(b.v) };
  });
}

/** Angle of position `to` ahead of position `from`, measured in the direction of travel around `normal`. −π..π */
export function phaseAngle(from, to, normal) {
  _n.crossVectors(from, to);
  return Math.atan2(_n.dot(normal), from.dot(to));
}

/**
 * Hohmann transfer helper between two near-circular, near-co-planar orbits around one parent.
 * `origin` / `target` are Orbit objects (use the body's orbit, or the vessel's own orbit for a moon transfer).
 * → { phaseNow, phaseNeeded (rad, target ahead of origin, −π..π), phaseError, timeToWindow (s, ≥ 0), synodic,
 *     transferTime, r1, r2, vInf (m/s relative to the origin at departure), vArr (m/s relative to the target at
 *     arrival), ejectDv (m/s from a circular parking orbit, when `parking = {gm, radius}` is given, else vInf) }
 */
export function transferWindow(origin, target, ut, parking = null) {
  const gm = origin.gm;
  const p1 = origin.posAt(ut, new Vector3()), p2 = target.posAt(ut, new Vector3());
  const r1 = p1.length(), r2 = p2.length();
  const at = 0.5 * (r1 + r2);
  const transferTime = Math.PI * Math.sqrt(at * at * at / gm);
  const n1 = origin.n, n2 = target.n;
  const phaseNeeded = wrapPi(Math.PI - n2 * transferTime);
  const phaseNow = phaseAngle(p1, p2, origin.H);
  const rate = n2 - n1;                              // how fast the phase angle changes
  let timeToWindow = Infinity, synodic = Infinity;
  if (Math.abs(rate) > 1e-14) {
    synodic = TAU / Math.abs(rate);
    const need = rate > 0 ? wrapTau(phaseNeeded - phaseNow) : wrapTau(phaseNow - phaseNeeded);
    timeToWindow = need / Math.abs(rate);
  }
  const v1 = Math.sqrt(gm / r1), v2 = Math.sqrt(gm / r2);
  const vInf = Math.abs(Math.sqrt(gm * (2 / r1 - 1 / at)) - v1);
  const vArr = Math.abs(v2 - Math.sqrt(gm * (2 / r2 - 1 / at)));
  let ejectDv = vInf;
  if (parking && parking.gm > 0 && parking.radius > 0) {
    const vc = Math.sqrt(parking.gm / parking.radius);
    ejectDv = Math.sqrt(vInf * vInf + 2 * vc * vc) - vc;
  }
  return { phaseNow, phaseNeeded, phaseError: wrapPi(phaseNow - phaseNeeded), timeToWindow, synodic, transferTime, r1, r2, vInf, vArr, ejectDv };
}

/**
 * Pick the pair of orbits for "go from where this vessel is to `target`" and run transferWindow on them.
 *   origin: a Vessel-like { body, landed, getOrbit(ut), pos } or a Body (the tracking station uses the home body)
 *   target: a Body, or a vessel-like object in orbit
 * → the transferWindow result plus { from (name), to (name), around (Body), kind: 'moon' | 'planet' | 'vessel' }
 *   or null when the two do not share a parent anywhere up the origin's chain (e.g. the star, or the origin itself).
 */
export function transferFor(origin, target, ut) {
  if (!origin || !target) return null;
  const tgtIsBody = typeof target.globalPosAt === 'function';
  const orgIsBody = typeof origin.globalPosAt === 'function';
  let tgtOrbit = null, around = null;
  if (tgtIsBody) { tgtOrbit = target.orbit; around = target.parent; }
  else if (!target.landed && target.body) { try { tgtOrbit = target.getOrbit(ut); } catch { tgtOrbit = null; } around = target.body; }
  if (!tgtOrbit || !around) return null;
  // the origin itself orbits `around` → use its own orbit (moon transfer / rendezvous)
  if (!orgIsBody && origin.body === around) {
    if (origin.landed) return null;
    let o = null; try { o = origin.getOrbit(ut); } catch { o = null; }
    if (!o || o.hyper) return null;
    const w = transferWindow(o, tgtOrbit, ut, null);
    return { ...w, from: origin.name || 'Vessel', to: target.name, around, kind: tgtIsBody ? 'moon' : 'vessel' };
  }
  // otherwise climb from the origin's body until something orbits `around`
  let b = orgIsBody ? origin : origin.body, guard = 0;
  while (b && b.parent !== around && guard++ < 8) b = b.parent;
  if (!b || b === target || !b.orbit || b.parent !== around) return null;
  let parking = null;
  if (!orgIsBody && origin.body === b && !origin.landed && origin.pos) parking = { gm: b.gm, radius: Math.hypot(origin.pos.x, origin.pos.y, origin.pos.z) };
  else parking = { gm: b.gm, radius: b.radius + (b.atmo ? b.atmo.height : 0) + Math.max(10e3, b.radius * 0.05) };
  const w = transferWindow(b.orbit, tgtOrbit, ut, parking);
  return { ...w, from: b.name, to: target.name, around, kind: tgtIsBody ? 'planet' : 'vessel', fromBody: b, parkingRadius: parking.radius };
}
