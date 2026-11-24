// Starwright structural dynamics: the load every joint between two parts carries, its strength, its flex and
// its failure. PURE SIMULATION (no three.js at all) - runs under Node. Contract and model: docs/STRUCTURE.md.
//
// The vessel still flies as ONE rigid body (vessel.js is the only code that moves it). Each physics step the
// flight model tells this module what force it applied to which part (`wrench`), and how the vessel is moving;
// `solve` then cuts the vessel at every joint and asks Newton what the joint must carry for the far side to move
// as it does. Nothing here feeds back into the trajectory except a joint that breaks.

import { spanTarget } from './span.js';

const PI = Math.PI;

/** Tuning constants (exported so the UI, the tests and the assembly building can read them). */
export const STRUCT = {
  LINE_T: 0.3e6,           // N/m: allowable tension line load of a plain joint (a 1.25 m wide ring: 1.2 MN, or 0.37 MN·m)
  LINE_C: 1.2e6,           // N/m: allowable compression line load (faces bear on each other, not on the bolts)
  LINE_S: 0.3e6,           // N/m: allowable shear flow
  FACTOR: {                // strength of a joint relative to a plain one, by the weaker of the two parts it joins
    decoupler: 0.7, dock: 0.5,
  },
  MOUNT_FACTOR: {          // ... and of a side mount, by the mounted part: booster clamps are thrust fittings
    radialdec: 6.5, pylon: 3.5, clamp: 9,
    // lifting surfaces are bolted on along a thin root (see `rootSection`): a rocket fin as built, a wing or a tail
    // fin with a spar carried through the body, an elevon hung on a hinge line along its whole span
    fin: 0.7, wing: 3, tailfin: 3, elevon: 4,
  },
  AIR_FAIL_TIME: 0.25,     // s: a part 100 % over its air rating (parts.js AIR_RATING) is torn off after this long
  DEBRIS_SPIN: 2.5,        // rad/s: spin a light piece is given as it tears away (less for heavy ones) ...
  DEBRIS_PUSH: 1.2,        // m/s: ... and how fast it is pushed clear (shared with what it left, by mass)
  DEBRIS_PUSH_MAX: 1500,   // N·s: no break pushes harder than this
  MIN_R: 0.08,             // m: no joint ring is smaller than this
  FAIL_TIME: 0.12,         // s: damage grows at (u − 1) / FAIL_TIME per second while a joint is over its limit ...
  HEAL_TIME: 0.6,          // s: ... and heals fully in this time once it is back under it
  WARN: 0.75,              // utilisation at which a `stress` event is raised
  WARN_RESET: 0.55,        // ... and below which it is armed again
  STRUT_FORCE: 1.5e5,      // N: what one brace strut carries
  STRUT_REACH: 0.25,       // m: a strut braces the part its tip comes this close to
  // --- flex (shown, not fed back into the flight forces)
  FLEX_AT_LIMIT: 0.03,     // rad (1.7°): bend of a squat joint at its bending limit
  FLEX_SLENDER_MIN: 0.6, FLEX_SLENDER_MAX: 2,   // × that for stubby / slender neighbours (length over diameter)
  FLEX_ZETA: 0.14,         // damping ratio of a joint's wobble
  FLEX_W_MAX: 60,          // rad/s: stiffer joints than this follow their load without wobbling
  FLEX_REFRESH: 12,        // solves between refreshes of the wobble frequencies (they change as tanks drain)
};

// --------------------------------------------------------------------------------------------------------------
// Pure functions on plain data (the reference implementation: clear rather than fast). tests/verify checks these
// against an independent multibody solver, and the live solver below against these.

/**
 * Joint loads of a rigid tree of bodies. See docs/STRUCTURE.md for the equations.
 *   bodies: [{ m, r:[x,y,z], I:[Ixx,Iyy,Izz], F:[x,y,z], T:[x,y,z] }]   r from the assembly's mass centre; T about it
 *   joints: [{ parent, child, p:[x,y,z], n:[x,y,z] }]                   indices into bodies; a tree; any order
 *   motion: { w:[x,y,z], alpha:[x,y,z], f:[x,y,z] }
 * → [{ F:[x,y,z], M:[x,y,z] }] per joint: force and moment about p that the parent side exerts on the child side.
 */
export function solveJointLoads(bodies, joints, motion) {
  const n = bodies.length, w = motion.w, al = motion.alpha, f = motion.f;
  const kids = Array.from({ length: n }, () => []);
  for (let j = 0; j < joints.length; j++) kids[joints[j].parent].push(j);
  // demand of each body: what must be supplied to it for it to move as the assembly does
  const demand = b => {
    const [x, y, z] = b.r, m = b.m;
    // a = f + alpha × r + w × (w × r)
    const wxr = [w[1] * z - w[2] * y, w[2] * x - w[0] * z, w[0] * y - w[1] * x];
    const a = [
      f[0] + al[1] * z - al[2] * y + w[1] * wxr[2] - w[2] * wxr[1],
      f[1] + al[2] * x - al[0] * z + w[2] * wxr[0] - w[0] * wxr[2],
      f[2] + al[0] * y - al[1] * x + w[0] * wxr[1] - w[1] * wxr[0],
    ];
    const Fd = [m * a[0] - b.F[0], m * a[1] - b.F[1], m * a[2] - b.F[2]];
    const I = b.I, Iw = [I[0] * w[0], I[1] * w[1], I[2] * w[2]];
    // r × m a + I alpha + w × (I w) − T      (moment about the assembly's mass centre)
    const Md = [
      y * m * a[2] - z * m * a[1] + I[0] * al[0] + w[1] * Iw[2] - w[2] * Iw[1] - b.T[0],
      z * m * a[0] - x * m * a[2] + I[1] * al[1] + w[2] * Iw[0] - w[0] * Iw[2] - b.T[1],
      x * m * a[1] - y * m * a[0] + I[2] * al[2] + w[0] * Iw[1] - w[1] * Iw[0] - b.T[2],
    ];
    return [Fd, Md];
  };
  const sub = new Array(n).fill(null);
  const sum = i => {       // demand of the whole subtree hanging from body i
    if (sub[i]) return sub[i];
    const [F, M] = demand(bodies[i]);
    for (const j of kids[i]) { const [cF, cM] = sum(joints[j].child); for (let k = 0; k < 3; k++) { F[k] += cF[k]; M[k] += cM[k]; } }
    return (sub[i] = [F, M]);
  };
  return joints.map(j => {
    const [F, M0] = sum(j.child), p = j.p;
    return {
      F: [F[0], F[1], F[2]],
      M: [M0[0] - (p[1] * F[2] - p[2] * F[1]), M0[1] - (p[2] * F[0] - p[0] * F[2]), M0[2] - (p[0] * F[1] - p[1] * F[0])],
    };
  });
}

/**
 * Thin-ring utilisation of a joint. F, M: what the parent side exerts on the child side (M about the joint point);
 * n: unit axis from parent to child; r: ring radius (m); capT/capC/capS: allowable line loads (N/m).
 */
export function jointUtilisation(F, M, n, r, capT, capC, capS, root = null) {
  const fn = F[0] * n[0] + F[1] * n[1] + F[2] * n[2];
  const mn = M[0] * n[0] + M[1] * n[1] + M[2] * n[2];
  const axial = -fn;
  const shear = Math.hypot(F[0] - fn * n[0], F[1] - fn * n[1], F[2] - fn * n[2]);
  const bx = M[0] - mn * n[0], by = M[1] - mn * n[1], bz = M[2] - mn * n[2];
  const bending = Math.hypot(bx, by, bz);
  const torsion = Math.abs(mn);
  let nb, na, q;
  if (root) {
    // a thin rectangular root, `root.h` long along the unit vector `root.c` and `root.t` across: see rootSection
    const c = root.c, sec = rootSection(root.h, root.t);
    const mc = bx * c[0] + by * c[1] + bz * c[2];                       // bending about the long side: across the thin way
    const mt = Math.hypot(bx - mc * c[0], by - mc * c[1], bz - mc * c[2]);   // ... and about the short side
    nb = Math.abs(mc) / sec.zFlap + mt / sec.zEdge; na = axial / sec.perimeter;
    q = 2 * shear / sec.perimeter + torsion / (2 * sec.area);
  } else {
    nb = bending / (PI * r * r); na = axial / (2 * PI * r);
    q = shear / (PI * r) + torsion / (2 * PI * r * r);
  }
  const nT = Math.max(0, na + nb), nC = Math.max(0, nb - na);
  const uT = nT / capT, uC = nC / capC, uS = q / capS;
  let util = uT, mode = 'tension';
  if (uC > util) { util = uC; mode = 'compression'; }
  if (uS > util) { util = uS; mode = 'shear'; }
  return { axial, shear, bending, torsion, nT, nC, q, util, mode };
}

// --------------------------------------------------------------------------------------------------------------
// Joint geometry

function strengthFactor(def) {
  const f = STRUCT.FACTOR[def.shape];
  return (f === undefined ? 1 : f) * (def.joint || 1);      // def.joint: a part built with heavier end rings (parts.js)
}
function mountFactor(a, b) {
  // `m` is the mounted part, as in jointGeometry. A host's own factor counts when it is a fitting (a booster on its
  // clamp, a pod on its pylon), not when it is a wing that something else is hung on.
  const m = isStack(a) ? b : isStack(b) ? a : b, host = m === b ? a : b;
  const fm = isStack(m) ? undefined : STRUCT.MOUNT_FACTOR[m.def.shape];
  const fh = isStack(host) || host.def.fin || host.def.wing ? undefined : STRUCT.MOUNT_FACTOR[host.def.shape];
  const f = (fm === undefined ? 1 : fm) * (isStack(m) ? 1 : m.def.joint || 1);
  return fh === undefined ? f : Math.max(f, fh);
}
const defOfPart = p => p.def;
const isStack = p => !!(p.def.attach && p.def.attach.stack);
const faceTop = p => (p.flip ? p.def.rBottom : p.def.rTop) ?? p.def.r ?? 0.3;
const faceBot = p => (p.flip ? p.def.rTop : p.def.rBottom) ?? p.def.r ?? 0.3;
const footprint = d => Math.max(STRUCT.MIN_R, ((d.h || 0.2) + (d.t || 0.2)) / PI);
/** Is this part bolted on along a thin root (a fin, a wing, a tail fin, an elevon)? */
const thinRoot = d => !!(d.fin || d.wing);

/**
 * Section of a thin rectangular root: a line of fasteners around a rectangle `h` long and `t` across (m).
 * → { perimeter (m), area (m², enclosed), zFlap, zEdge (m²) }: with an allowable line load n (N/m) the root carries
 *   a pull of n × perimeter, a bending moment of n × zFlap about its long side (the fin bent flat-wise, across the
 *   thin way) and n × zEdge about its short side (edge-wise), and a twist of n × 2 × area.
 * (Second moment of a line rectangle about its long centre line: 2 h (t/2)² + 2 t³/12; divided by t/2.)
 */
export function rootSection(h, t) {
  return { perimeter: 2 * (h + t), area: h * t, zFlap: h * t + t * t / 3, zEdge: h * t + h * h / 3 };
}

/**
 * Where two linked parts meet. → { kind, x, y, z (joint point, craft coords), nx, ny, nz (unit, from a toward b), r, len }
 * `len` is the length of structure the joint's bend is spread over (for the flex angle).
 */
export function jointGeometry(a, b) {
  const da = a.def, db = b.def, sa = isStack(a), sb = isStack(b);
  const coaxial = Math.abs(a.pos.x - b.pos.x) < 1e-3 && Math.abs(a.pos.z - b.pos.z) < 1e-3;
  if (sa && sb && coaxial) {
    const up = b.pos.y >= a.pos.y ? 1 : -1;      // b sits above a ?
    const ya = a.pos.y + up * da.h / 2, yb = b.pos.y - up * db.h / 2;
    let r = Math.max(STRUCT.MIN_R, Math.min(up > 0 ? faceTop(a) : faceBot(a), up > 0 ? faceBot(b) : faceTop(b)));
    // an interstage truss carries the load rim to rim around the engine bell: the joint is as wide as the truss
    for (const p of [a, b]) if (p.truss) for (const t of p.truss) {
      const side = t.side * (p.flip ? -1 : 1);      // +1: the truss stands on the part's upper end (craft axes)
      if ((p === a) === (side * up > 0)) r = Math.max(r, Math.min(t.r0, t.r1));
    }
    return { kind: da.dock && db.dock ? 'dock' : 'stack', x: b.pos.x, y: (ya + yb) / 2, z: b.pos.z, nx: 0, ny: up, nz: 0, r, len: (da.h + db.h) / 2 };
  }
  if (sa && sb) {      // two stack parts side by side (engines under a multi-coupler): a stack joint at the smaller one's face
    const up = b.pos.y >= a.pos.y ? 1 : -1;
    const small = Math.max(db.rTop ?? db.r, db.rBottom ?? db.r) <= Math.max(da.rTop ?? da.r, da.rBottom ?? da.r) ? b : a;
    const r = Math.max(STRUCT.MIN_R, Math.min(up > 0 ? faceTop(a) : faceBot(a), up > 0 ? faceBot(b) : faceTop(b)));
    return { kind: 'stack', x: small.pos.x, y: (a.pos.y + up * da.h / 2 + b.pos.y - up * db.h / 2) / 2, z: small.pos.z, nx: 0, ny: up, nz: 0, r, len: (da.h + db.h) / 2 };
  }
  // One of them is mounted on the other's side. `m` is the mounted part: the radial one (for two surface parts,
  // an elevon on a wing say, the far one). The joint is on its inner face, where it is bolted on, or, for a stack
  // part hanging on a radial clamp or pylon, on the clamp's outer face.
  const m = sa ? b : sb ? a : b, host = m === b ? a : b;
  const md = m.def, ox = Math.cos(m.rot || 0), oz = -Math.sin(m.rot || 0), half = (md.rw || 0.2) / 2;
  const outer = isStack(host) && !!(md.attach && md.attach.outer) && (host.pos.x - m.pos.x) * ox + (host.pos.z - m.pos.z) * oz > 1e-6;
  const s = outer ? 1 : -1;
  const sign = (m === b) !== outer ? 1 : -1;      // the axis runs from a toward b
  const g = { kind: outer ? 'outer' : 'radial', x: m.pos.x + s * ox * half, y: m.pos.y, z: m.pos.z + s * oz * half,
    nx: sign * ox, ny: 0, nz: sign * oz, r: footprint(md), len: Math.max(md.rw || 0.2, 0.3) };
  // a lifting surface is held along its root chord, which is long and thin: strong edge-wise, weak flat-wise
  if (!outer && thinRoot(md)) { g.rh = Math.max(md.h || 0.2, 0.05); g.rt = Math.max(md.t || 0.05, 0.02); }
  return g;
}

// --------------------------------------------------------------------------------------------------------------
// The live structure of one vessel

export class Structure {
  constructor(vessel) {
    this.vessel = vessel;
    this.joints = [];
    this.maxUtil = 0; this.worst = null; this.valid = false;
    this.pending = null;        // joints that broke this step (vessel.js splits the vessel after the step)
    this.warned = false;
    this.clamped = false;
    this._n = 0; this._tick = 0;
    this._motion = { w: [0, 0, 0], alpha: [0, 0, 0], f: [0, 0, 0] };
    this.build();
  }

  /** (Re)build the joint tree from the vessel's parts and links. Called by Vessel._rebuild. */
  build() {
    const v = this.vessel, parts = v.parts;
    const list = v._list, n = list.length;
    const old = new Map();
    for (const j of this.joints) old.set(j.a.id + ':' + j.b.id, j);
    this._n = n;
    this.order = [];                      // parts, parents before children
    this.wrench = new Float64Array(n * 6);
    this._sub = new Float64Array(n * 6);
    this._mp = new Float64Array(n * 3);   // mass points, relative to the vessel's centre of mass
    this._ms = new Float64Array(n);       // part masses of the solved step
    this._com = [0, 0, 0];                // ... and the centre of mass it was solved about
    this.flex = new Float32Array(n * 6);  // per part: displacement (3) and rotation vector (3), body axes
    this.joints = [];
    for (let i = 0; i < n; i++) { list[i]._si = i; list[i]._sj = null; }
    const seen = new Set();
    const roots = [];
    const start = parts.get(v.controlId) || list[0];
    const walk = root => {
      seen.add(root.id); root._sp = -1; this.order.push(root); roots.push(root);
      for (let h = this.order.length - 1; h < this.order.length; h++) {
        const a = this.order[h];
        for (const id of a.links) {
          const b = parts.get(id);
          if (!b || seen.has(id)) continue;
          seen.add(id); b._sp = a._si; this.order.push(b);
          const g = jointGeometry(a, b);
          const k = g.kind === 'radial' || g.kind === 'outer' ? mountFactor(a, b) : Math.min(strengthFactor(a.def), strengthFactor(b.def));
          const prev = old.get(a.id + ':' + b.id);
          const j = {
            a, b, kind: g.kind, px: g.x, py: g.y, pz: g.z, nx: g.nx, ny: g.ny, nz: g.nz, r: g.r, len: g.len,
            capT: STRUCT.LINE_T * k, capC: STRUCT.LINE_C * k, capS: STRUCT.LINE_S * k,
            rh: g.rh || 0, rt: g.rt || 0,          // thin root (fins, wings): length along the stack axis and thickness, else 0
            relB: 1, relF: 1, braces: 0,           // load shares left to the joint once brace struts take theirs
            fx: 0, fy: 0, fz: 0, mx: 0, my: 0, mz: 0,
            axial: 0, shear: 0, bending: 0, torsion: 0, util: 0, mode: 'tension',
            damage: prev ? prev.damage : 0, peak: prev ? prev.peak : 0,
            bx: prev ? prev.bx : 0, by: prev ? prev.by : 0, bz: prev ? prev.bz : 0,
            vx: prev ? prev.vx : 0, vy: prev ? prev.vy : 0, vz: prev ? prev.vz : 0,
            kb: 1, wn: STRUCT.FLEX_W_MAX,
          };
          const slender = Math.min(STRUCT.FLEX_SLENDER_MAX, Math.max(STRUCT.FLEX_SLENDER_MIN, g.len / (2 * g.r)));
          j.kb = j.capT * (g.rh > 0 ? rootSection(g.rh, g.rt).zFlap : PI * g.r * g.r) / (STRUCT.FLEX_AT_LIMIT * slender);
          b._sj = j;
          this.joints.push(j);
        }
      }
    };
    if (start) walk(start);
    for (const p of list) if (!seen.has(p.id)) walk(p);      // pieces not (yet) split off: each is its own tree
    this._braces();
    this.valid = false; this.maxUtil = 0; this.worst = null; this._tick = 0;
  }

  /** Brace struts: a strut whose tip reaches another part shares the load of every joint between the two. */
  _braces() {
    const v = this.vessel;
    for (const s of v._list) {
      s._brace = undefined;
      if (s.def.shape !== 'strut') continue;
      const host = s._sp >= 0 ? v._list[s._sp] : null;
      if (!host) continue;
      // where its far end goes is one rule for the structure and the drawing (core/span.js): the part its made
      // length reaches, else the first stack part along its axis within SPAN.MAX
      const sp = spanTarget(v._list, s, defOfPart, host, STRUCT.STRUT_REACH);
      if (!sp) continue;
      const hit = sp.part, tx = sp.tx, ty = sp.ty, tz = sp.tz;
      s._brace = hit.id;
      // joints on the tree path between host and hit: climb from both ends to their common ancestor
      const path = [];
      const anc = new Set();
      for (let p = host; p; p = p._sp >= 0 ? v._list[p._sp] : null) anc.add(p);
      let top = hit;
      for (; top && !anc.has(top); top = top._sp >= 0 ? v._list[top._sp] : null) if (top._sj) path.push(top._sj);
      if (!top) continue;      // different trees
      for (let p = host; p && p !== top; p = p._sp >= 0 ? v._list[p._sp] : null) if (p._sj) path.push(p._sj);
      for (const j of path) {
        j.braces++;
        const arm = Math.max(0.3, Math.hypot(tx - j.px, ty - j.py, tz - j.pz));
        const capM = j.capT * PI * j.r * j.r, capF = j.capS * PI * j.r;
        const add = STRUCT.STRUT_FORCE * j.braces;
        j.relB = capM / (capM + add * arm);
        j.relF = capF / (capF + add);
        const slender = Math.min(STRUCT.FLEX_SLENDER_MAX, Math.max(STRUCT.FLEX_SLENDER_MIN, j.len / (2 * j.r)));
        j.kb = capM / (STRUCT.FLEX_AT_LIMIT * slender) / j.relB;
      }
    }
  }

  /** The joint a part would be torn off at: the one that holds it to the rest (toward the root), else the one it holds. */
  jointOf(part) {
    if (part._sj) return part._sj;
    let only = null;
    for (const j of this.joints) if (j.a === part) { if (only) return null; only = j; }
    return only;
  }

  /** Start of a physics step: forget the forces of the last one. */
  begin() { this.wrench.fill(0); this.clamped = false; }

  /** The vessel is not being simulated as a free body (pinned to the ground, on rails): loads are unknown. */
  rest(dt = 0) {
    if (!this.valid && !this._bent) return;
    this.valid = false; this.maxUtil = 0; this.worst = null;
    let bent = false;
    const k = Math.exp(-dt * 6);
    for (const j of this.joints) {
      j.util = 0; j.axial = j.shear = j.bending = j.torsion = 0; j.damage = 0;
      j.bx *= k; j.by *= k; j.bz *= k; j.vx = j.vy = j.vz = 0;
      if (Math.abs(j.bx) + Math.abs(j.by) + Math.abs(j.bz) > 1e-6) bent = true; else j.bx = j.by = j.bz = 0;
    }
    this._bent = bent;
  }

  /**
   * Forces that the flight model applies as lumps: engine thrust (known per engine), the attitude-control torque
   * (reaction wheels, gimbals, thrusters: shared out to the parts that make it, as pure couples, which is how the
   * flight model applies it) and translation thrusters (rfx, rfy, rfz: shared among the thruster blocks).
   */
  addLumped(rfx, rfy, rfz) {
    const v = this.vessel, W = this.wrench, com = v.com;
    for (const e of v._engines) {
      const p = e.part, T = p.thrust;
      if (!(T > 0)) continue;
      const k = p._si * 6, rx = p.pos.x - com.x, ry = p.pos.y - com.y, rz = p.pos.z - com.z;
      if (p._tilt) {
        const ax = T * p._ax, ay = T * p._ay, az = T * p._az;
        W[k] += ax; W[k + 1] += ay; W[k + 2] += az;
        W[k + 3] += ry * az - rz * ay; W[k + 4] += rz * ax - rx * az; W[k + 5] += rx * ay - ry * ax;
      } else {
        const Ts = p.flip ? -T : T;
        W[k + 1] += Ts; W[k + 3] -= rz * Ts; W[k + 5] += rx * Ts;
      }
    }
    // attitude-control torque
    const tq = [v._tqx || 0, v._tqy || 0, v._tqz || 0];
    if (tq[0] || tq[1] || tq[2]) {
      const wheel = v._auW || 0, rcs = v._auR ? v._rcsAuth : null;
      const gim = v._gim || 0;
      for (let ax = 0; ax < 3; ax++) {
        const t = tq[ax];
        if (!t) continue;
        const g = ax === 1 ? 0 : gim, rc = rcs ? (ax === 0 ? rcs.x : ax === 1 ? rcs.y : rcs.z) : 0;
        const tot = wheel + g + rc;
        if (!(tot > 0)) { W[this.order[0]._si * 6 + 3 + ax] += t; continue; }
        if (wheel > 0) {
          let sum = 0;
          for (const p of v._list) if (p.def.torque) sum += p.def.torque;
          if (sum > 0) for (const p of v._list) if (p.def.torque) W[p._si * 6 + 3 + ax] += t * (wheel / tot) * p.def.torque / sum;
        }
        if (g > 0) {
          for (const e of v._engines) {
            const p = e.part, gm = p.def.engine.gimbal;
            if (!gm || !(p.thrust > 0)) continue;
            W[p._si * 6 + 3 + ax] += t / tot * p.thrust * Math.sin(gm * PI / 180) * Math.abs(p.pos.y - com.y);
          }
        }
        if (rc > 0 && v._rcs.length) {
          let sum = 0;
          for (const p of v._rcs) sum += p.def.rcs.thrust;
          for (const p of v._rcs) W[p._si * 6 + 3 + ax] += t * (rc / tot) * p.def.rcs.thrust / sum;
        }
      }
    }
    if (rfx || rfy || rfz) {
      const l = v._rcs;
      if (l.length) {
        let sum = 0;
        for (const p of l) sum += p.def.rcs.thrust;
        for (const p of l) { const k = p._si * 6, s = p.def.rcs.thrust / sum; W[k] += rfx * s; W[k + 1] += rfy * s; W[k + 2] += rfz * s; }
      } else { const k = this.order[0]._si * 6; W[k] += rfx; W[k + 1] += rfy; W[k + 2] += rfz; }
    }
  }

  /** Mass points of the parts relative to the vessel's centre of mass (the same points Vessel._updateMass sums). */
  _massPoints() {
    const v = this.vessel, list = v._list, com = v.com, mp = this._mp;
    for (let i = 0; i < list.length; i++) {
      const p = list[i], pm = p.mass;
      mp[i * 3] = p._mx - com.x; mp[i * 3 + 1] = p._my - com.y; mp[i * 3 + 2] = p._mz - com.z;
      this._ms[i] = pm;
    }
  }

  /**
   * Joint loads for this step. F (N) and T (N·m, about the centre of mass) are the totals the flight model
   * integrates, body axes; `m` and `I` the mass and inertia it divides them by; `w` the angular velocity.
   * `fail`: joints may break (→ this.pending). Returns the highest utilisation.
   */
  solve(dt, Fx, Fy, Fz, Tx, Ty, Tz, m, I, w, fail = true) {
    const v = this.vessel, list = v._list, n = this._n, W = this.wrench, S = this._sub, mp = this._mp;
    if (!(m > 0) || n !== list.length) return 0;
    this._massPoints();
    this._com[0] = v.com.x; this._com[1] = v.com.y; this._com[2] = v.com.z; this._mass = m;
    const wx = w.x, wy = w.y, wz = w.z;
    // the same angular acceleration and specific force the integrator is about to apply
    const alx = (Tx - (I.z - I.y) * wy * wz) / I.x, aly = (Ty - (I.x - I.z) * wz * wx) / I.y, alz = (Tz - (I.y - I.x) * wx * wy) / I.z;
    const fx = Fx / m, fy = Fy / m, fz = Fz / m;
    const mo = this._motion;
    mo.w[0] = wx; mo.w[1] = wy; mo.w[2] = wz; mo.alpha[0] = alx; mo.alpha[1] = aly; mo.alpha[2] = alz; mo.f[0] = fx; mo.f[1] = fy; mo.f[2] = fz;
    // demand of every part
    for (let i = 0; i < n; i++) {
      const p = list[i], d = p.def, pm = p.mass, k = i * 6;
      const x = mp[i * 3], y = mp[i * 3 + 1], z = mp[i * 3 + 2];
      const cx = wy * z - wz * y, cy = wz * x - wx * z, cz = wx * y - wy * x;
      const ax = fx + aly * z - alz * y + wy * cz - wz * cy;
      const ay = fy + alz * x - alx * z + wz * cx - wx * cz;
      const az = fz + alx * y - aly * x + wx * cy - wy * cx;
      const r = p._stack ? Math.max(d.rTop, d.rBottom) : (d.rw || 0.2) / 2;
      const own = pm * (3 * r * r + d.h * d.h) / 12, oy = pm * r * r / 2;
      p._io = own; p._iy = oy;
      const Iwx = own * wx, Iwy = oy * wy, Iwz = own * wz;
      const max = pm * ax, may = pm * ay, maz = pm * az;
      S[k] = max - W[k]; S[k + 1] = may - W[k + 1]; S[k + 2] = maz - W[k + 2];
      S[k + 3] = y * maz - z * may + own * alx + wy * Iwz - wz * Iwy - W[k + 3];
      S[k + 4] = z * max - x * maz + oy * aly + wz * Iwx - wx * Iwz - W[k + 4];
      S[k + 5] = x * may - y * max + own * alz + wx * Iwy - wy * Iwx - W[k + 5];
    }
    // sum the subtrees: children come after their parents in `order`
    const order = this.order;
    for (let h = order.length - 1; h > 0; h--) {
      const p = order[h];
      if (p._sp < 0) continue;
      const k = p._si * 6, q = p._sp * 6;
      S[q] += S[k]; S[q + 1] += S[k + 1]; S[q + 2] += S[k + 2]; S[q + 3] += S[k + 3]; S[q + 4] += S[k + 4]; S[q + 5] += S[k + 5];
    }
    // what is left at the root is whatever Newton's laws do not close by (see `residual`)
    const r0 = order[0]._si * 6;
    this.resF = Math.hypot(S[r0], S[r0 + 1], S[r0 + 2]); this.resM = Math.hypot(S[r0 + 3], S[r0 + 4], S[r0 + 5]);
    if (++this._tick >= STRUCT.FLEX_REFRESH || !this.valid) { this._tick = 0; this._frequencies(m, I); }
    let maxU = 0, worst = null, pending = null;
    const zeta = STRUCT.FLEX_ZETA;
    for (const j of this.joints) {
      const k = j.b._si * 6;
      const Fjx = S[k], Fjy = S[k + 1], Fjz = S[k + 2];
      const Mx = S[k + 3] - (j.py - v.com.y) * Fjz + (j.pz - v.com.z) * Fjy;
      const My = S[k + 4] - (j.pz - v.com.z) * Fjx + (j.px - v.com.x) * Fjz;
      const Mz = S[k + 5] - (j.px - v.com.x) * Fjy + (j.py - v.com.y) * Fjx;
      j.fx = Fjx; j.fy = Fjy; j.fz = Fjz; j.mx = Mx; j.my = My; j.mz = Mz;
      const fn = Fjx * j.nx + Fjy * j.ny + Fjz * j.nz, mn = Mx * j.nx + My * j.ny + Mz * j.nz;
      const sx = Fjx - fn * j.nx, sy = Fjy - fn * j.ny, sz = Fjz - fn * j.nz;
      const bx = Mx - mn * j.nx, by = My - mn * j.ny, bz = Mz - mn * j.nz;
      const shear = Math.sqrt(sx * sx + sy * sy + sz * sz), bending = Math.sqrt(bx * bx + by * by + bz * bz), torsion = Math.abs(mn);
      j.axial = -fn; j.shear = shear; j.bending = bending; j.torsion = torsion;
      const r = j.r;
      let nb, na, qs;
      if (j.rh > 0) {      // thin root: the chord runs along the stack axis (jointUtilisation, rootSection)
        const h = j.rh, t = j.rt, per = 2 * (h + t);
        nb = (Math.abs(by) / (h * t + t * t / 3) + Math.sqrt(bx * bx + bz * bz) / (h * t + h * h / 3)) * j.relB;
        na = -fn * j.relF / per;
        qs = 2 * shear * j.relF / per + torsion * j.relB / (2 * h * t);
      } else {
        nb = bending * j.relB / (PI * r * r); na = -fn * j.relF / (2 * PI * r);
        qs = shear * j.relF / (PI * r) + torsion * j.relB / (2 * PI * r * r);
      }
      const uT = (na + nb) / j.capT, uC = (nb - na) / j.capC, uS = qs / j.capS;
      let u = uT, mode = 'tension';
      if (uC > u) { u = uC; mode = 'compression'; }
      if (uS > u) { u = uS; mode = 'shear'; }
      if (u < 0) u = 0;
      j.util = u; j.mode = mode;
      if (u > j.peak) j.peak = u;
      if (u > maxU) { maxU = u; worst = j; }
      if (u > 1) {
        j.damage += (u - 1) * dt / STRUCT.FAIL_TIME;
        if (fail && j.damage >= 1) (pending || (pending = [])).push(j);
      } else if (j.damage > 0) j.damage = Math.max(0, j.damage - dt / STRUCT.HEAL_TIME);
      // flex: a damped spring that follows −M_bending / kb (exact step of the oscillator, so any dt is stable)
      const tx = -bx / j.kb, ty = -by / j.kb, tz = -bz / j.kb, wn = j.wn;
      if (!this.valid || wn * dt > 1.5) { j.bx = tx; j.by = ty; j.bz = tz; j.vx = j.vy = j.vz = 0; }
      else {
        const wd = wn * Math.sqrt(1 - zeta * zeta), e = Math.exp(-zeta * wn * dt), c = Math.cos(wd * dt), s = Math.sin(wd * dt);
        const a11 = e * (c + zeta * wn / wd * s), a12 = e * s / wd, a21 = -e * wn * wn / wd * s, a22 = e * (c - zeta * wn / wd * s);
        let x = j.bx - tx, u1 = j.vx; j.bx = tx + a11 * x + a12 * u1; j.vx = a21 * x + a22 * u1;
        x = j.by - ty; u1 = j.vy; j.by = ty + a11 * x + a12 * u1; j.vy = a21 * x + a22 * u1;
        x = j.bz - tz; u1 = j.vz; j.bz = tz + a11 * x + a12 * u1; j.vz = a21 * x + a22 * u1;
      }
    }
    this.maxUtil = maxU; this.worst = worst; this.valid = true; this._bent = true;
    if (pending) this.pending = pending;
    this._flexStamp = (this._flexStamp || 0) + 1;
    return maxU;
  }

  /** Natural frequency of each joint's wobble: its bending stiffness against the reduced inertia of its two sides. */
  _frequencies(m, I) {
    const v = this.vessel, list = v._list, mp = this._mp, n = this._n;
    const Q = this._q || (this._q = new Float64Array(0));
    const acc = Q.length === n * 5 ? Q : (this._q = new Float64Array(n * 5));     // per subtree: m, m·x, m·y, m·z, m·r² + own
    for (let i = 0; i < n; i++) {
      const p = list[i], pm = p.mass, x = mp[i * 3], y = mp[i * 3 + 1], z = mp[i * 3 + 2], k = i * 5;
      acc[k] = pm; acc[k + 1] = pm * x; acc[k + 2] = pm * y; acc[k + 3] = pm * z; acc[k + 4] = pm * (x * x + y * y + z * z) + (p._io || 0);
    }
    const order = this.order;
    for (let h = order.length - 1; h > 0; h--) {
      const p = order[h];
      if (p._sp < 0) continue;
      const k = p._si * 5, q = p._sp * 5;
      for (let c = 0; c < 5; c++) acc[q + c] += acc[k + c];
    }
    const It = (I.x + I.z) / 2;
    for (const j of this.joints) {
      const k = j.b._si * 5, ms = acc[k];
      const px = j.px - v.com.x, py = j.py - v.com.y, pz = j.pz - v.com.z, p2 = px * px + py * py + pz * pz;
      // inertia of the far side about the joint point, and of everything else about it
      const Is = Math.max(1e-6, acc[k + 4] - 2 * (px * acc[k + 1] + py * acc[k + 2] + pz * acc[k + 3]) + ms * p2);
      const Ir = Math.max(1e-6, It + m * p2 - Is);
      const red = Is * Ir / (Is + Ir);
      j.wn = Math.min(STRUCT.FLEX_W_MAX, Math.sqrt(j.kb / red));
    }
  }

  /**
   * Fill `this.flex`: how far each part is displaced (m) and turned (rad) by the bent joints, body axes, with the
   * vessel's mass centre and mean orientation left where they are (a free body bends about its own middle).
   * Cheap; the renderer calls it once a frame. → true when anything is bent.
   */
  updateFlex() {
    const v = this.vessel, list = v._list, n = this._n, fl = this.flex;
    if (n !== list.length) return false;
    if (!this._bent) { if (this._flexZero) return false; fl.fill(0); this._flexZero = true; return false; }
    this._flexZero = false;
    const order = this.order;
    let mt = 0, ux = 0, uy = 0, uz = 0;
    for (let h = 0; h < order.length; h++) {
      const p = order[h], k = p._si * 6, j = p._sj;
      if (!j || p._sp < 0) { fl[k] = fl[k + 1] = fl[k + 2] = fl[k + 3] = fl[k + 4] = fl[k + 5] = 0; }
      else {
        const a = list[p._sp], q = p._sp * 6;
        const rx = fl[q + 3] + j.bx, ry = fl[q + 4] + j.by, rz = fl[q + 5] + j.bz;
        // joint point as carried by the parent, then this part's own turn about it
        const ax = j.px - a.pos.x, ay = j.py - a.pos.y, az = j.pz - a.pos.z;
        const bx = p.pos.x - j.px, by = p.pos.y - j.py, bz = p.pos.z - j.pz;
        fl[k] = fl[q] + (fl[q + 4] * az - fl[q + 5] * ay) + (ry * bz - rz * by);
        fl[k + 1] = fl[q + 1] + (fl[q + 5] * ax - fl[q + 3] * az) + (rz * bx - rx * bz);
        fl[k + 2] = fl[q + 2] + (fl[q + 3] * ay - fl[q + 4] * ax) + (rx * by - ry * bx);
        fl[k + 3] = rx; fl[k + 4] = ry; fl[k + 5] = rz;
      }
      const pm = p.mass; mt += pm; ux += pm * fl[k]; uy += pm * fl[k + 1]; uz += pm * fl[k + 2];
    }
    if (!(mt > 0)) return true;
    ux /= mt; uy /= mt; uz /= mt;
    // mean rotation: the turn that carries the same angular "momentum" as the displacements
    const com = v.com, I = v.inertia;
    let hx = 0, hy = 0, hz = 0;
    for (let i = 0; i < n; i++) {
      const p = list[i], k = i * 6, pm = p.mass;
      const rx = p.pos.x - com.x, ry = p.pos.y - com.y, rz = p.pos.z - com.z;
      const dx = fl[k] - ux, dy = fl[k + 1] - uy, dz = fl[k + 2] - uz;
      hx += pm * (ry * dz - rz * dy) + (p._io || 0) * fl[k + 3];
      hy += pm * (rz * dx - rx * dz) + (p._iy || 0) * fl[k + 4];
      hz += pm * (rx * dy - ry * dx) + (p._io || 0) * fl[k + 5];
    }
    const ox = hx / I.x, oy = hy / I.y, oz = hz / I.z;
    for (let i = 0; i < n; i++) {
      const p = list[i], k = i * 6;
      const rx = p.pos.x - com.x, ry = p.pos.y - com.y, rz = p.pos.z - com.z;
      fl[k] -= ux + (oy * rz - oz * ry); fl[k + 1] -= uy + (oz * rx - ox * rz); fl[k + 2] -= uz + (ox * ry - oy * rx);
      fl[k + 3] -= ox; fl[k + 4] -= oy; fl[k + 5] -= oz;
    }
    return true;
  }

  /** Displacement (m) and rotation vector (rad) of a part after updateFlex(), body axes. */
  partFlex(part, outPos, outRot) {
    const k = part._si * 6, fl = this.flex;
    if (outPos) outPos.set(fl[k], fl[k + 1], fl[k + 2]);
    if (outRot) outRot.set(fl[k + 3], fl[k + 4], fl[k + 5]);
    return outPos;
  }

  /** Plain data of the last solved step, in the form `solveJointLoads` takes, plus the loads found. */
  snapshot() {
    const v = this.vessel, list = v._list, W = this.wrench, mp = this._mp, c = this._com, com = { x: c[0], y: c[1], z: c[2] };
    const bodies = list.map((p, i) => ({
      id: p.id, m: this._ms[i], r: [mp[i * 3], mp[i * 3 + 1], mp[i * 3 + 2]], I: [p._io || 0, p._iy || 0, p._io || 0],
      F: [W[i * 6], W[i * 6 + 1], W[i * 6 + 2]], T: [W[i * 6 + 3], W[i * 6 + 4], W[i * 6 + 5]],
    }));
    const joints = this.joints.map(j => ({ parent: j.a._si, child: j.b._si, a: j.a.id, b: j.b.id, kind: j.kind, p: [j.px - com.x, j.py - com.y, j.pz - com.z], n: [j.nx, j.ny, j.nz], r: j.r, root: j.rh > 0 ? { h: j.rh, t: j.rt, c: [0, 1, 0] } : null, capT: j.capT, capC: j.capC, capS: j.capS, relB: j.relB, relF: j.relF }));
    const mo = this._motion;
    const loads = this.joints.map(j => ({ F: [j.fx, j.fy, j.fz], M: [j.mx, j.my, j.mz], axial: j.axial, shear: j.shear, bending: j.bending, torsion: j.torsion, util: j.util, mode: j.mode, damage: j.damage }));
    return { valid: this.valid, mass: this._mass || v.mass, inertia: [v.inertia.x, v.inertia.y, v.inertia.z], bodies, joints, motion: { w: mo.w.slice(), alpha: mo.alpha.slice(), f: mo.f.slice() }, loads, residual: { F: this.resF || 0, M: this.resM || 0 } };
  }
}
