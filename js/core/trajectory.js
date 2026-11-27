// Patched-conic trajectory prediction, SOI frame changes and maneuver-node maths. Pure simulation.
import { Vector3 } from '../lib/three.module.min.js';
import { Orbit } from './orbit.js';

const ENC_STEP = 0.1;          // encounter search: sample step as a fraction of the local dynamical time sqrt(r³/GM)
const MAX_SAMPLES = 8000;      // hard cap on the samples of one encounter search (a normal orbit needs 50 to 400)
const _p1 = new Vector3();
const _p2 = new Vector3();

/** Convert a state relative to `body` into its parent's frame. */
export function toParentFrame(body, pos, vel, t) {
  const parent = body.parent;
  if (!parent) return { body, pos: pos.clone(), vel: vel.clone() };
  return {
    body: parent,
    pos: body.posAt(t).add(pos),
    vel: body.velAt(t).add(vel),
  };
}

/** Convert a state relative to `child.parent` into the child's frame. */
export function toChildFrame(child, pos, vel, t) {
  return {
    body: child,
    pos: pos.clone().sub(child.posAt(t, _p1)),
    vel: vel.clone().sub(child.velAt(t, _p1)),
  };
}

/**
 * Live-sim SOI check. Returns null, or the state in the new frame {body, pos, vel}.
 * Leaves only while moving outward and enters only while approaching, so a state sitting on a
 * boundary cannot flip-flop between frames.
 */
export function checkSoiTransition(body, pos, vel, t) {
  if (body.parent && pos.lengthSq() > body.soi * body.soi && pos.dot(vel) > 0) {
    return toParentFrame(body, pos, vel, t);
  }
  for (const child of body.children) {
    const rel = child.posAt(t, _p1).sub(pos);          // vessel → child
    if (rel.lengthSq() < child.soi * child.soi) {
      const relVel = child.velAt(t, _p2).sub(vel);
      if (rel.dot(relVel) < 0) return toChildFrame(child, pos, vel, t);
    }
  }
  return null;
}

/** Unit vectors for maneuver nodes: prograde = v̂, normal = (r × v)^, radial = prograde × normal (outward). */
export function maneuverBasis(r, v) {
  const prograde = v.clone().normalize();
  const normal = new Vector3().crossVectors(r, v).normalize();
  if (normal.lengthSq() === 0) {
    // radial trajectory: any direction perpendicular to the velocity will do
    normal.set(0, 1, 0);
    if (Math.abs(prograde.y) > 0.99) normal.set(1, 0, 0);
    normal.addScaledVector(prograde, -normal.dot(prograde)).normalize();
  }
  const radial = new Vector3().crossVectors(prograde, normal).normalize();
  return { prograde, normal, radial };
}

/** Orbit after an impulsive burn dv = {prograde, normal, radial} (m/s) at time t. */
export function applyManeuver(orbit, t, dv) {
  const { r, v } = orbit.stateAt(t);
  const b = maneuverBasis(r, v);
  v.addScaledVector(b.prograde, dv.prograde || 0)
    .addScaledVector(b.normal, dv.normal || 0)
    .addScaledVector(b.radial, dv.radial || 0);
  return Orbit.fromState(r, v, orbit.gm, t);
}

// Next time ≥ `after` at which the orbit crosses radius R (inbound or outbound leg); Infinity if never.
function crossingTime(orbit, R, inbound, after) {
  if (orbit.periapsis > R || orbit.apoapsis < R) return Infinity;
  const t = orbit.timeAtRadius(R, inbound, after);
  if (!(t >= after)) return t >= after - 1e-6 ? after : Infinity;   // hyperbolic: already past it
  return t;
}

// Signed distance (m) from the vessel to the child's SOI surface at time t (negative = inside).
function soiDistance(orbit, child, t) {
  orbit.posAt(t, _p1);
  child.posAt(t, _p2);
  return _p1.distanceTo(_p2) - child.soi;
}

// Find the first time at which the vessel goes from outside to inside the child's SOI. `ts` are the N sample
// times and `d` the signed distance to the SOI surface at each of them (see sampleEncounters).
function findEncounter(orbit, child, ts, d, N) {
  let armIdx = -1;
  for (let i = 0; i < N; i++) {
    if (armIdx < 0) {
      // already inside at the start (the body just left, or a degenerate start): wait until outside
      if (d[i] > 0) armIdx = i;
      continue;
    }
    if (d[i] <= 0) return bisectEntry(orbit, child, ts[i - 1], ts[i]);
    const j = i - 1;
    // A sampled local minimum of the distance: look for a dip below zero between the samples. The first armed sample
    // can be that minimum too (closest approach less than one step away: a pass after a late correction burn, or
    // when time warp re-predicts close in), and so can the last one (still closing at the end of the search).
    const prev = j - 1 >= armIdx ? d[j - 1] : Infinity;
    const last = i === N - 1 && d[i] < d[j];
    if ((d[j] < prev && d[j] <= d[i]) || last) {
      let a = last ? ts[j] : ts[Math.max(j - 1, armIdx)], b = ts[i];
      const a0 = a;
      const g = 0.6180339887498949;
      let c1 = b - g * (b - a), c2 = a + g * (b - a);
      let f1 = soiDistance(orbit, child, c1), f2 = soiDistance(orbit, child, c2);
      for (let k = 0; k < 40 && f1 > 0 && f2 > 0; k++) {
        if (f1 < f2) { b = c2; c2 = c1; f2 = f1; c1 = b - g * (b - a); f1 = soiDistance(orbit, child, c1); }
        else { a = c1; c1 = c2; f1 = f2; c2 = a + g * (b - a); f2 = soiDistance(orbit, child, c2); }
      }
      if (f1 <= 0) return bisectEntry(orbit, child, a0, c1);
      if (f2 <= 0) return bisectEntry(orbit, child, a0, c2);
    }
  }
  return Infinity;
}

// Sample buffers for the encounter search (predictPatches is synchronous and never re-entered).
const _ts = new Float64Array(MAX_SAMPLES + 4);
const _ds = [];

/**
 * Sample the distance from the vessel to the SOI of each candidate child from t0 to tLimit, densely enough that
 * no encounter can fall between the samples unnoticed: the step is ENC_STEP of the local dynamical time
 * sqrt(r³/GM) of the vessel (or of r / speed, if that is shorter: fast hyperbolic passes) and, while the vessel is at a radius where it can meet a child, of that child too. Over
 * two such steps both paths are close to straight lines, so their distance has a single minimum, which
 * findEncounter then refines. Stretches of the orbit outside the band of radii of all candidates are jumped over
 * exactly (through the crossing time of the band edge), so a long, eccentric orbit costs no more than a short one.
 * `extend`: tLimit is just the end of one revolution, so carry on two samples past it to close a minimum there.
 * Fills _ts and _ds[k] (one array per candidate); returns { n, searched } where `searched` is the time up to
 * which the search is complete (Infinity when the vessel leaves for good).
 */
function sampleEncounters(orbit, cands, t0, tLimit, extend) {
  let Rlo = Infinity, Rhi = 0;
  for (const c of cands) {
    Rlo = Math.min(Rlo, c.orbit.periapsis - c.soi);
    Rhi = Math.max(Rhi, c.orbit.apoapsis + c.soi);
  }
  Rlo *= 0.8; Rhi *= 1.25;
  while (_ds.length < cands.length) _ds.push(new Float64Array(MAX_SAMPLES + 4));
  const gm = orbit.gm;
  let t = t0, n = 0, extra = extend ? 2 : 0, searched = tLimit;
  for (;;) {
    orbit.posAt(t, _p1);
    const r = _p1.length();
    _ts[n] = t;
    // local time scale: the dynamical time, or on a hyperbola the time to cover its own radius if that is shorter
    // (a fast pass crosses a whole moon system in less than one dynamical time; a closed orbit never moves faster
    // than 1.41 times the circular speed, so there the dynamical time is enough)
    let dt = ENC_STEP * Math.sqrt(r * r * r / gm);
    if (orbit.hyper) dt = Math.min(dt, ENC_STEP * r / Math.sqrt(gm * (2 / r - 1 / orbit.a)));
    for (let k = 0; k < cands.length; k++) {
      const c = cands[k];
      c.posAt(t, _p2);
      _ds[k][n] = _p1.distanceTo(_p2) - c.soi;
      if (r * 0.8 <= c.orbit.apoapsis + c.soi && r * 1.2 >= c.orbit.periapsis - c.soi) {
        const rc = _p2.length();
        dt = Math.min(dt, ENC_STEP * Math.sqrt(rc * rc * rc / gm));
      }
    }
    n++;
    if (t >= tLimit && extra-- <= 0) break;
    if (n >= MAX_SAMPLES) { searched = t; break; }
    let tn = t + dt;
    if (r > Rhi * (1 + 1e-9)) {
      // beyond every candidate: nothing can happen until the orbit comes back in through Rhi (if it ever does)
      const tc = crossingTime(orbit, Rhi, true, t);
      if (tc === Infinity) { searched = Infinity; break; }
      if (tc > tn) tn = tc;
    } else if (r < Rlo * (1 - 1e-9)) {
      const tc = crossingTime(orbit, Rlo, false, t);
      if (tc === Infinity) { searched = Infinity; break; }
      if (tc > tn) tn = tc;
    }
    if (t < tLimit && tn > tLimit) tn = tLimit;
    t = tn;
  }
  return { n, searched };
}

// d(lo) > 0, d(hi) ≤ 0 → the crossing time, returned on the inside so the next patch starts within the SOI.
function bisectEntry(orbit, child, lo, hi) {
  for (let k = 0; k < 60 && hi - lo > 1e-5; k++) {
    const mid = 0.5 * (lo + hi);
    if (soiDistance(orbit, child, mid) > 0) lo = mid; else hi = mid;
  }
  return hi;
}

// Earliest event ending the patch: {t, type, next} or null.
function findPatchEnd(orbit, body, t0) {
  let tEnd = Infinity, type = null, next = null;
  const r0v = orbit.stateAt(t0);
  const r0 = r0v.r.length();

  // --- atmosphere entry / surface impact on the inbound leg ---
  const Rsurf = body.radius;
  const Ratmo = body.atmo ? Rsurf + body.atmo.height : Rsurf;
  if (body.atmo && r0 >= Ratmo * (1 - 1e-9) && orbit.periapsis < Ratmo) {
    const t = crossingTime(orbit, Ratmo, true, t0);
    if (t < tEnd) { tEnd = t; type = 'atmo'; }
  } else if (orbit.periapsis < Rsurf) {
    let t;
    if (r0 <= Rsurf || orbit.apoapsis < Rsurf) t = t0;
    else t = crossingTime(orbit, Rsurf, true, t0);
    if (t < tEnd) { tEnd = t; type = 'impact'; }
  }

  // --- SOI exit on the outbound leg ---
  if (body.parent && Number.isFinite(body.soi) && orbit.apoapsis > body.soi) {
    let t;
    if (r0 > body.soi && r0v.r.dot(r0v.v) > 0) t = t0;
    else t = crossingTime(orbit, body.soi, false, t0);
    if (t < tEnd) { tEnd = t; type = 'exit'; next = body.parent; }
  }

  // --- encounters with child bodies ---
  let searched = Infinity;
  if (body.children.length) {
    const rp = orbit.periapsis, ra = orbit.apoapsis;
    const candidates = body.children.filter((c) =>
      ra >= c.orbit.periapsis - c.soi && rp <= c.orbit.apoapsis + c.soi);
    if (candidates.length) {
      // nothing else ends the patch: a closed orbit is searched for one revolution (the caller asks again after
      // that), an open one until it has left the children behind
      const open = !Number.isFinite(tEnd);
      const tLimit = open ? (orbit.hyper ? Infinity : t0 + orbit.period) : tEnd;
      if (tLimit > t0) {
        const s = sampleEncounters(orbit, candidates, t0, tLimit, open && !orbit.hyper);
        searched = s.searched;
        for (let k = 0; k < candidates.length; k++) {
          const t = findEncounter(orbit, candidates[k], _ts, _ds[k], s.n);
          if (t < tEnd) { tEnd = t; type = 'enter'; next = candidates[k]; }
        }
      }
    }
  }

  if (type && searched < tEnd) return { t: Infinity, type: null, next: null, searched };   // (sample cap: ask again from there)
  return type ? { t: tEnd, type, next, searched } : (searched < Infinity ? { t: Infinity, type: null, next: null, searched } : null);
}


/**
 * Patched-conic prediction. Returns patches
 * { orbit, body, tStart, tEnd (Infinity if nothing ends it), endType: null|'exit'|'enter'|'impact'|'atmo', nextBody }.
 * 'exit'/'enter' patches are followed by the patch in the new frame (up to maxPatches);
 * 'impact' (surface) and 'atmo' (top of atmosphere) end the prediction.
 * `searchedUntil`: the time up to which encounters with child bodies have been looked for on this patch. For a
 * closed orbit that nothing ends it is one revolution after tStart (plus a little): predict again from there.
 */
export function predictPatches(orbit, body, tStart, maxPatches = 4) {
  const patches = [];
  let o = orbit, b = body, t0 = tStart;
  for (let k = 0; k < maxPatches; k++) {
    const patch = { orbit: o, body: b, tStart: t0, tEnd: Infinity, endType: null, nextBody: null, searchedUntil: Infinity };
    patches.push(patch);
    const ev = findPatchEnd(o, b, t0);
    if (!ev) break;
    patch.searchedUntil = ev.searched;
    if (!ev.type) break;
    patch.tEnd = ev.t;
    patch.endType = ev.type;
    patch.nextBody = ev.next;
    if (ev.type !== 'exit' && ev.type !== 'enter') break;
    const { r, v } = o.stateAt(ev.t);
    const nx = ev.type === 'exit' ? toParentFrame(b, r, v, ev.t) : toChildFrame(ev.next, r, v, ev.t);
    o = Orbit.fromState(nx.pos, nx.vel, nx.body.gm, ev.t);
    b = nx.body;
    t0 = ev.t;
  }
  return patches;
}

// ---------------------------------------------------------------------------------------------
// Closest approach between two orbits around the same body (round 2: targeting and rendezvous)
// ---------------------------------------------------------------------------------------------
const _ca1 = new Vector3(), _ca2 = new Vector3();
function separation2(orbitA, orbitB, t) {
  orbitA.posAt(t, _ca1); orbitB.posAt(t, _ca2);
  return _ca1.distanceToSquared(_ca2);
}

/**
 * Closest approach of two orbits AROUND THE SAME BODY between tStart and tEnd: the separation is sampled
 * (at least 64 samples, ≥ 72 per revolution of the faster orbit, at most 4000), every sampled local minimum is
 * refined by golden-section search and the best one wins.
 * Returns { t, distance (m), relSpeed (m/s) }.
 */
export function closestApproach(orbitA, orbitB, tStart, tEnd, samples = 0) {
  const at = t => {
    const a = orbitA.stateAt(t), b = orbitB.stateAt(t);
    return { t, distance: a.r.distanceTo(b.r), relSpeed: a.v.distanceTo(b.v) };
  };
  if (!(tEnd > tStart)) return at(tStart);
  const span = tEnd - tStart;
  let N = samples | 0;
  if (N < 2) {
    const P = Math.min(orbitA.period, orbitB.period);
    N = Number.isFinite(P) && P > 0 ? Math.ceil(72 * span / P) : 200;
    N = Math.max(64, Math.min(4000, N));
  }
  const d = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) d[i] = separation2(orbitA, orbitB, tStart + span * i / N);
  const g = 0.6180339887498949;
  let bestT = tStart, bestD = d[0];
  if (d[N] < bestD) { bestD = d[N]; bestT = tEnd; }
  for (let i = 0; i <= N; i++) {
    const lo = i > 0 ? d[i - 1] : Infinity, hi = i < N ? d[i + 1] : Infinity;
    if (d[i] > lo || d[i] > hi) continue;
    let a = tStart + span * Math.max(0, i - 1) / N, b = tStart + span * Math.min(N, i + 1) / N;
    let c1 = b - g * (b - a), c2 = a + g * (b - a);
    let f1 = separation2(orbitA, orbitB, c1), f2 = separation2(orbitA, orbitB, c2);
    for (let k = 0; k < 60 && b - a > 1e-4; k++) {
      if (f1 < f2) { b = c2; c2 = c1; f2 = f1; c1 = b - g * (b - a); f1 = separation2(orbitA, orbitB, c1); }
      else { a = c1; c1 = c2; f1 = f2; c2 = a + g * (b - a); f2 = separation2(orbitA, orbitB, c2); }
    }
    const t = f1 < f2 ? c1 : c2, f = Math.min(f1, f2);
    if (f < bestD) { bestD = f; bestT = t; }
  }
  return at(bestT);
}
