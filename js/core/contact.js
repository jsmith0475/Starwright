// Starwright: craft are solid to each other. Two vessels whose parts touch push apart, sharing the push by their
// masses as momentum says (a little bounce, most of the speed lost), and each of them breaks by the ground's rules
// (js/core/tower.js strikeSteel): if the body part pressed deepest meets the other faster than TUNING.CRASH_ALL times
// its crash tolerance, that whole vessel is lost; otherwise every touching part met faster than its own tolerance breaks
// off. A landed vessel does not move: it takes the hit as the ground would.
//
// What is left out:
//   - pieces that start out touching: two stages just after separation, a booster just off its core, a craft just
//     undocked, two craft placed together. Such a pair is not solid to each other until it has once been clear (1 m
//     apart) and for CONTACT.grace seconds after they came apart; after that, coming back together is a collision.
//     (The grace is there because the stock boosters, once let go, tip their tails into the core within half a
//     second: the radial decouplers push them off too gently. Until they push harder, that touch is not counted.)
//   - two craft docking: while their nearest matching ports are within 3 m and they move together slower than 3 m/s,
//     the ports are left to latch (World._dockingStep);
//   - Pips on a walk (they climb ladders and board), and a vessel held by the catch tower's arms.
// Parts are tried as the same balls the tower and the buildings use (eachBall): a stack part as rings of its own radius
// every 2 m up its length, a plate on the side as balls across its face, anything else as one ball as big as it is.
//
//   stepContacts(world, ev)    called by the world after every physics sub-step
//   CONTACT                    { solid: true, dockReach: 3, dockSpeed: 3, clear: 1, grace: 3, bounce: 0.2 }
import { Vector3 } from '../lib/three.module.min.js';
import { eachBall, inertialFrame } from './tower.js';
import { TUNING } from './vessel.js';

export const CONTACT = { solid: true, dockReach: 3, dockSpeed: 3, clear: 1, grace: 3, bounce: 0.2 };

const _pa = new Vector3(), _pb = new Vector3(), _na = new Vector3(), _nb = new Vector3(), _n = new Vector3(), _va = new Vector3(), _vb = new Vector3();

/** Every ball of `v` relative to `origin` (inertial axes): a flat array [x, y, z, r, …] and the part of each. */
function balls(v, origin, out) {
  inertialFrame(origin);
  out.xyz.length = 0; out.parts.length = 0;
  out.x0 = out.y0 = out.z0 = Infinity; out.x1 = out.y1 = out.z1 = -Infinity;
  eachBall(v, (p, x, y, z, r) => {
    out.xyz.push(x, y, z, r); out.parts.push(p);
    if (x - r < out.x0) out.x0 = x - r; if (x + r > out.x1) out.x1 = x + r;
    if (y - r < out.y0) out.y0 = y - r; if (y + r > out.y1) out.y1 = y + r;
    if (z - r < out.z0) out.z0 = z - r; if (z + r > out.z1) out.z1 = z + r;
    return false;
  });
  return out;
}
const _A = { xyz: [], parts: [] }, _B = { xyz: [], parts: [] };

/** The deepest touch between a's and b's balls: { depth, nx, ny, nz (from b toward a), ia, ib (ball indices) } and,
 *  per part, how deep it is in (Maps part → depth), or null when nothing touches (`slack` m counts as touching). */
function touches(A, B, slack) {
  if (A.x1 + slack < B.x0 || B.x1 + slack < A.x0 || A.y1 + slack < B.y0 || B.y1 + slack < A.y0 || A.z1 + slack < B.z0 || B.z1 + slack < A.z0) return null;
  let best = null;
  const pa = new Map(), pb = new Map(), a = A.xyz, b = B.xyz;
  for (let j = 0; j < b.length; j += 4) {
    const bx = b[j], by = b[j + 1], bz = b[j + 2], br = b[j + 3];
    if (bx + br + slack < A.x0 || bx - br - slack > A.x1 || by + br + slack < A.y0 || by - br - slack > A.y1 || bz + br + slack < A.z0 || bz - br - slack > A.z1) continue;
    for (let i = 0; i < a.length; i += 4) {
      const dx = a[i] - bx, dy = a[i + 1] - by, dz = a[i + 2] - bz, rr = a[i + 3] + br + slack;
      if (dx * dx + dy * dy + dz * dz >= rr * rr) continue;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz), depth = rr - slack - d;
      const p = A.parts[i / 4], q = B.parts[j / 4];
      if (depth > (pa.get(p) ?? -Infinity)) pa.set(p, depth);
      if (depth > (pb.get(q) ?? -Infinity)) pb.set(q, depth);
      if (!best || depth > best.depth) best = { depth, nx: d > 1e-9 ? dx / d : 0, ny: d > 1e-9 ? dy / d : 1, nz: d > 1e-9 ? dz / d : 0, partA: p, partB: q };
    }
  }
  if (best) { best.pa = pa; best.pb = pb; }
  return best;
}

/** Whether a and b are docking: their nearest matching ports within CONTACT.dockReach, moving together slowly. */
function docking(a, b) {
  if (!a._ports || !b._ports || !a._ports.length || !b._ports.length) return false;
  _va.copy(a.vel).sub(b.vel);
  if (_va.lengthSq() > CONTACT.dockSpeed * CONTACT.dockSpeed) return false;
  for (const p of a._ports) {
    a.portWorld(p, _pa, _na);
    for (const q of b._ports) {
      if (p.def.dock.size !== q.def.dock.size) continue;
      b.portWorld(q, _pb, _nb);
      if (_pa.distanceToSquared(_pb) < CONTACT.dockReach * CONTACT.dockReach) return true;
    }
  }
  return false;
}

/** What breaks on `v` when it meets something at `into` m/s with the parts in `depths` touching: 'lost', a list of part
 *  ids, or null (the ground's rule, as js/core/tower.js strikeSteel). */
function damage(v, depths, into) {
  let lead = null, leadD = -Infinity, absorb = 0;
  const broken = [];
  for (const [p, d] of depths) {
    if (d <= 0) continue;
    if (p._stack && d > leadD) { lead = p; leadD = d; }
    if (into > (p.def.tolerance || 6)) { broken.push(p.id); absorb = Math.max(absorb, p.def.tolerance || 6); }
  }
  if (lead && into > (lead.def.tolerance || 6) * TUNING.CRASH_ALL) return { lost: true, lead };
  return broken.length ? { lost: false, broken, absorb } : null;
}

const held = v => v.landed && v.surface && v.surface.held === 'tower';
const skip = v => v.dead || v.type === 'eva' || held(v);

/** After every physics sub-step: every pair of loaded vessels near each other. */
export function stepContacts(world, ev) {
  if (!CONTACT.solid) return;
  const L = world._loaded || world.vessels;
  if (L.length < 2) return;
  const pairs = world._contactPairs || (world._contactPairs = new Map());
  const ut = world.ut;
  for (let i = 0; i < L.length; i++) {
    const a = L[i];
    if (skip(a)) continue;
    for (let j = i + 1; j < L.length; j++) {
      const b = L[j];
      if (skip(b) || a.dead || b.body !== a.body || (a.landed && b.landed)) continue;
      const reach = a._bound + b._bound + 1;
      if (a.pos.distanceToSquared(b.pos) > reach * reach) continue;
      const key = a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id;
      let st = pairs.get(key);
      const A = balls(a, a.pos, _A), B = balls(b, a.pos, _B);
      const hit = touches(A, B, CONTACT.clear);
      if (!st) { st = { clear: !hit, sep: !!hit, ut, born: ut }; pairs.set(key, st); }
      st.ut = ut;
      if (!hit) { st.clear = true; continue; }
      if (!st.clear || hit.depth <= 0) continue;          // not yet apart from where they started, or only within the margin
      if (st.sep && ut - st.born < CONTACT.grace) continue;    // they came apart moments ago
      if (docking(a, b)) continue;
      collide(world, a, b, hit, ev);
    }
  }
  // forget pairs not seen for a while (they are far apart, or gone)
  if (pairs.size > 64 || (world._contactPrune ?? 0) < ut - 10) {
    world._contactPrune = ut;
    for (const [k, st] of pairs) if (ut - st.ut > 5) pairs.delete(k);
  }
}

function collide(world, a, b, hit, ev) {
  const n = _n.set(hit.nx, hit.ny, hit.nz);                 // from b toward a
  // the touching points' velocities (with the turning of each vessel), and how fast they close
  const pa = hit.partA, pb = hit.partB;
  a.pointVelocity(pa.pos.x, pa.pos.y, pa.pos.z, _va);
  b.pointVelocity(pb.pos.x, pb.pos.y, pb.pos.z, _vb);
  const into = -_va.sub(_vb).dot(n);
  if (!(into > 0)) {
    // touching but already parting: only set them apart
    separate(a, b, n, hit.depth);
    return;
  }
  const fixedA = a.landed, fixedB = b.landed;
  const da = damage(a, hit.pa, into), db = damage(b, hit.pb, into);
  for (const [v, d, o] of [[a, da, b], [b, db, a]]) {
    if (!d) continue;
    if (d.lost) {
      ev.push({ type: 'vesselStrike', vessel: v, other: o, what: o.name, part: d.lead.def.name, lost: true, broken: v.parts.size });
      v.destroyParts([...v.parts.keys()], ev, 'collision');
    } else {
      const p = v.parts.get(d.broken[0]);
      ev.push({ type: 'vesselStrike', vessel: v, other: o, what: o.name, part: p ? p.def.name : 'hull', lost: false, broken: d.broken.length });
      v.destroyParts(d.broken, ev, 'collision');
    }
  }
  if (a.dead && b.dead) return;
  if (da || db) {
    // what broke soaked up some of the closing speed, as on the ground; the rest meet whatever touches next
    const soak = Math.min(into, Math.max(da && !da.lost ? da.absorb : 0, db && !db.lost ? db.absorb : 0));
    push(a, b, n, soak, fixedA, fixedB, 0);
    return;
  }
  // a touch nothing breaks in: an inelastic push along the normal, shared by mass (momentum is kept)
  push(a, b, n, into, fixedA, fixedB, CONTACT.bounce);
  separate(a, b, n, hit.depth);
  if (!a._touchV || world.ut - a._touchV > 2) { a._touchV = world.ut; ev.push({ type: 'vesselStrike', vessel: a, other: b, what: b.name, part: pa.def.name, lost: false, broken: 0 }); ev.push({ type: 'vesselStrike', vessel: b, other: a, what: a.name, part: pb.def.name, lost: false, broken: 0 }); }
}

/** Change the closing speed along n by `dv` (m/s) times (1 + bounce), shared by mass; a landed vessel does not move. */
function push(a, b, n, dv, fixedA, fixedB, bounce) {
  if (a.dead) fixedA = true; if (b.dead) fixedB = true;
  if (fixedA && fixedB) return;
  const ma = fixedA ? Infinity : a.mass, mb = fixedB ? Infinity : b.mass;
  const wa = fixedA ? 0 : fixedB ? 1 : mb / (ma + mb), wb = 1 - wa;
  const j = dv * (1 + bounce);
  if (!fixedA) { a.vel.addScaledVector(n, j * wa); a._stamp++; }
  if (!fixedB) { b.vel.addScaledVector(n, -j * wb); b._stamp++; }
}
function separate(a, b, n, depth) {
  const d = Math.min(Math.max(depth, 0), 0.2);
  if (!(d > 0)) return;
  const fa = a.landed || a.dead, fb = b.landed || b.dead;
  if (fa && fb) return;
  const wa = fa ? 0 : fb ? 1 : b.mass / (a.mass + b.mass);
  if (!fa) a.pos.addScaledVector(n, d * wa);
  if (!fb) b.pos.addScaledVector(n, -d * (1 - wa));
}
