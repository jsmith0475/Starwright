// Starwright — what the launch pad does for the rocket standing on it: the launch mount under it, the hold-down
// clamps on its base and the service tower's arms out to its hull.
//
// The simulation stands a rocket on the pad by its lowest point, which for most rockets is the lip of an engine
// bell. Nothing real stands on its bell: it stands on a launch mount by the base ring of its lowest tank, the bell
// hanging free over the flame opening, held by clamps that let go at lift-off. This file works out that hardware
// for the craft that is actually there and draws it, so the load path on screen is one that would work:
//
//   planPadFit(vessel)   → { height, columns: [...], arms: [...] } or null. Pure arithmetic on the craft's parts (no
//                          three.js), in the pad's own frame: +X east (the tower's side), +Y up from the deck the
//                          rocket rests on, +Z south, the origin under the craft's centre of mass.
//       columns  one for every body that stands on an engine: { x, z, R (the rim the clamps take), h (its height),
//                Rp (the mount ring's radius), w, t (the ring's section), legs: [angles], arcs: [[a0, a1], ...] }
//       arms     { y (the walkway's floor), tip (x of its end, 4 cm short of the hull), crew }
//   DEFAULT_ARMS         the arms with no rocket on the pad
//   drawMount(k, plan)   the fixed steel: rings, legs, braces, foot plates and the arms' hinge stubs
//   drawJaw(k, col)      one clamp, drawn about its hinge (x toward the rocket's axis, y up)
//   drawArm(k, arm, x0)  one arm, drawn about its hinge pin (it runs toward −X)
// `k` is the geometry kit of js/render/basegfx.js, which owns the meshes and moves the clamps and the arms.
//
// Nothing here changes the flight: the mount is drawn round a rocket that stands exactly where it always stood.
// A craft that stands on legs, wheels, fins or a flat base gets no mount (it is standing on what it should).

const TAU = Math.PI * 2;
const C = { white: 0xe4e7ea, dark: 0x171b20, teal: 0x1e9c90, amber: 0xe59a2f, steel: 0x8b949e, steelDark: 0x555d66, core: 0x4a525c, deck: 0x6b727b, rubber: 0x22252a, cable: 0xd9dee2 };

/** The service tower as the arms need it: its west face, where the hinges stand, the highest and lowest an arm can be. */
export const PAD_TOWER = { face: 13.5, hinge: 12.2, half: 0.8, truss: 1.8, minY: 2.4, maxY: 49, swing: 62 * Math.PI / 180, decks: [12.7, 24.5, 36.3, 48.1] };
export const DEFAULT_ARMS = [{ y: 14.6, tip: 7.9 }, { y: 27, tip: 7.9 }, { y: 40, tip: 7.9, crew: true }];

const radiusAt = (b, y) => (b.y1 - b.y0 < 1e-6 ? Math.max(b.rB, b.rT) : b.rB + (b.rT - b.rB) * Math.min(1, Math.max(0, (y - b.y0) / (b.y1 - b.y0))));

/** The craft's parts as simple solids in the pad frame: upright drums for stack parts, boxes for what hangs on the side. */
function solids(v) {
  const com = v.com || { x: 0, y: 0, z: 0 }, out = [];
  let ground = Infinity;
  for (const p of v.parts.values()) {
    const d = p.def; if (!d || !p.pos) continue;
    const x = p.pos.x - com.x, yc = p.pos.y - com.y, z = p.pos.z - com.z, h = d.h || 0.2;
    if (p._stack !== false && d.attach && d.attach.stack && !d.rw) {
      const tilted = !!(p.pitch || p.roll);
      let rB = d.rBottom ?? d.r ?? 0.3, rT = d.rTop ?? d.r ?? 0.3;
      if (p.flip) [rB, rT] = [rT, rB];
      out.push({ p, d, drum: true, x, z, y0: yc - h / 2, y1: yc + h / 2, rB, rT, r: Math.max(rB, rT), tilted });
    } else {
      const a = p.rot || 0, rw = d.rw || d.r || 0.3, t = d.t || rw;
      out.push({ p, d, drum: false, x, z, y0: yc - h / 2, y1: yc + h / 2, ux: Math.cos(a), uz: -Math.sin(a), hx: rw / 2, hz: t / 2, r: Math.hypot(rw, t) / 2 });
    }
  }
  // the deck is under the lowest thing the simulation knows about (its contact points), else under the lowest solid
  if (typeof v._lowest === 'function') { try { const low = v._lowest({ x: 0, y: 1, z: 0 }); if (Number.isFinite(low.h)) ground = low.h; } catch { /* fall through */ } }
  if (!Number.isFinite(ground)) for (const b of out) ground = Math.min(ground, b.y0);
  for (const b of out) { b.y0 -= ground; b.y1 -= ground; }
  return out;
}

/** How far the point (x, z) is from a solid between the heights ya and yb (negative inside; Infinity when it is not at that height). */
function gap(b, x, z, ya, yb) {
  if (b.y1 < ya || b.y0 > yb) return Infinity;
  if (b.drum) return Math.hypot(x - b.x, z - b.z) - Math.max(radiusAt(b, ya), radiusAt(b, yb), radiusAt(b, Math.max(b.y0, Math.min(b.y1, (ya + yb) / 2))));
  const dx = x - b.x, dz = z - b.z, u = Math.abs(dx * b.ux + dz * b.uz) - b.hx, w = Math.abs(-dx * b.uz + dz * b.ux) - b.hz;
  return u > 0 || w > 0 ? Math.hypot(Math.max(u, 0), Math.max(w, 0)) : Math.max(u, w);
}

/**
 * The hardware the pad needs for this craft, or null when the craft is not a rocket standing upright on the pad.
 * `opts.arms: false` leaves the tower's arms out (a craft somewhere the tower is not).
 */
export function planPadFit(v, opts = {}) {
  if (!v || !v.parts || !v.parts.size) return null;
  const all = solids(v);
  if (!all.length) return null;
  const height = all.reduce((m, b) => Math.max(m, b.y1), 0);
  const columns = [];

  // ---- the bodies that stand on an engine: each is taken by the rim above that engine
  const seen = new Set();
  for (const e of all) {
    const d = e.d;
    if (!e.drum || !d.engine || e.p.flip || e.tilted || e.y0 > 0.08) continue;
    let col;
    if (d.shape === 'srb') {
      // a solid motor is one piece: the clamps take the shoulder at the top of its aft skirt
      const nozz = Math.min(1, Math.max(0.12, d.h * 0.1)), skirt = Math.min(0.9, Math.max(0.1, d.h * 0.09));
      col = { key: e.p, x: e.x, z: e.z, R: d.r, h: e.y0 + nozz * 0.55 + skirt, rEng: d.r * 1.04, own: [e] };
    } else {
      // the part that sits on this engine (a tank, or the coupler several engines hang under)
      const up = all.find(b => b !== e && b.drum && Math.abs(b.y0 - e.y1) < 0.08 && Math.hypot(b.x - e.x, b.z - e.z) < Math.max(b.rB, 0.05) + 1e-3);
      if (up) col = { key: up.p, x: up.x, z: up.z, R: Math.max(up.rB, 0.2), h: e.y1, rEng: Math.hypot(up.x - e.x, up.z - e.z) + e.r, own: [e, up] };
      else col = { key: e.p, x: e.x, z: e.z, R: e.r, h: e.y1, rEng: e.r, own: [e] };
    }
    if (seen.has(col.key)) { const c0 = columns.find(c => c.key === col.key); c0.rEng = Math.max(c0.rEng, col.rEng); c0.own.push(...col.own); continue; }
    if (col.h < 0.25 || col.h > 9) continue;                       // nothing to stand a mount under, or no mount this tall
    seen.add(col.key); columns.push(col);
  }
  columns.sort((a, b) => b.R - a.R);

  // ---- a ring for each on legs, cut away wherever another part of the craft is in its way
  const rings = [];
  for (const c of columns) {
    const big = Math.max(c.R, c.rEng);
    c.w = 0.2 + 0.1 * c.R; c.t = 0.18 + 0.08 * c.R;                 // the ring beam: how wide, how deep
    c.Rp = big + 0.14 + c.w / 2 + 0.06 * c.R;
    c.top = c.h - 0.05;
    c.low = c.top - c.t < 0.22;                                   // too near the deck for a ring on legs: clamps on low blocks
    c.hingeY = c.low ? Math.max(0.08, c.h - 0.2) : c.top + 0.06;  // where the clamps hinge
    const others = all.filter(b => !c.own.includes(b));
    const free = (x, z, ya, yb, clear) => {
      for (const b of others) if (gap(b, x, z, ya, yb) < clear) return false;
      for (const r of rings) if (yb > r.y0 && ya < r.y1 && Math.abs(Math.hypot(x - r.x, z - r.z) - r.Rp) < r.w / 2 + clear) return false;
      return true;
    };
    const at = (a, r) => [c.x + Math.cos(a) * r, c.z + Math.sin(a) * r];
    const n = c.R < 0.45 ? 3 : c.R > 1.7 ? 6 : 4;
    // turn the legs to where most of them are clear (ties go to the first, so a bare rocket's legs stand on the diagonals)
    let best = -1, phase = Math.PI / n;
    for (let s = 0; s < 24; s++) {
      const ph = Math.PI / n + (s * TAU) / (n * 24); let ok = 0;
      for (let i = 0; i < n; i++) { const [x, z] = at(ph + (i * TAU) / n, c.Rp); if (free(x, z, 0, c.h + 0.5, c.w * 0.75 + 0.1)) ok++; }
      if (ok > best) { best = ok; phase = ph; }
    }
    c.legs = [];
    for (let i = 0; i < n; i++) { const a = phase + (i * TAU) / n, [x, z] = at(a, c.Rp); if (free(x, z, 0, c.h + 0.5, c.w * 0.75 + 0.1)) c.legs.push(a); }
    // which of the legs can have a brace out to the deck
    c.braces = c.low ? [] : c.legs.filter(a => { const [x, z] = at(a, c.Rp + Math.min(1.6, 0.45 + c.h * 0.45)); return free(x, z, 0, c.h, 0.25); });
    c.arcs = [];
    if (!c.low) {
      const N = 48; let run = null;
      for (let i = 0; i <= N; i++) {
        const a = phase + (i * TAU) / N, [x, z] = at(a + TAU / N / 2, c.Rp);
        const ok = i < N && free(x, z, c.top - c.t, c.top + 0.02, c.w / 2 + 0.06);
        if (ok && !run) run = [a, a];
        if (ok) run[1] = a + TAU / N; else if (run) { c.arcs.push(run); run = null; }
      }
      rings.push({ x: c.x, z: c.z, Rp: c.Rp, w: c.w, y0: 0, y1: c.top });
    }
    delete c.key; delete c.own;
  }
  const held = columns.filter(c => c.legs.length >= 2);

  // ---- the tower's arms: one to the crew's hatch (or the top of the stack), and up to two more below it
  const arms = [];
  if (opts.arms !== false && height >= 3.4) {
    const T = PAD_TOWER;
    const reach = y => {
      let x = -Infinity, hull = 0;
      for (const b of all) {
        if (b.y1 < y - 0.1 || b.y0 > y + T.truss + 0.1) continue;
        if (b.drum) {
          const r = Math.max(radiusAt(b, y - 0.1), radiusAt(b, y + T.truss + 0.1)), dz = Math.max(0, Math.abs(b.z) - T.half);
          if (dz < r) { const e = b.x + Math.sqrt(r * r - dz * dz); if (e > x) { x = e; hull = dz > 0 || Math.abs(b.rT - b.rB) > 0.02 ? 0 : r; } }
        } else if (Math.abs(b.z) - (Math.abs(b.uz) * b.hx + Math.abs(b.ux) * b.hz) < T.half) { const e = b.x + Math.abs(b.ux) * b.hx + Math.abs(b.uz) * b.hz; if (e > x) { x = e; hull = 0; } }
      }
      return [x, hull];
    };
    const crewed = all.filter(b => b.drum && b.d.crew > 0).sort((a, b) => b.y1 - a.y1)[0];
    // the floor of the top arm: a little under the middle of the cabin, or under the top of the stack
    let top = crewed ? (crewed.y0 + crewed.y1) / 2 - 0.75 : height * 0.82 - T.truss / 2;
    top = Math.min(T.maxY, Math.max(T.minY, Math.min(top, height - 1.2)));
    const levels = [[top, !!crewed]];
    if (top > 30) levels.push([top * 0.64, false], [top * 0.3, false]); else if (top > 13) levels.push([top * 0.45, false]);
    for (let [y, crew] of levels) {
      // an arm does not come out through one of the tower's own decks
      if (!crew) for (const dk of T.decks) if (y > dk - 2.2 && y < dk + 1.6) y = dk - 2.2;
      if (y < T.minY) continue;
      const [x, hull] = reach(y);
      if (!(x > -Infinity) || x > T.hinge - 2.5) continue;         // nothing to reach at that height, or the craft is against the tower
      arms.push({ y, tip: x + 0.04, crew, hull });                 // hull: the radius of the round skin it meets (0 = something flat or tapered)
    }
  }
  if (!held.length && !arms.length) return null;
  return { height, columns: held, arms };
}

// ---------------------------------------------------------------------------------------------------------------
// Drawing (through the kit of js/render/basegfx.js: box(bucket, x, y0, z, w, h, d, color, ry), beam, tube, cyl)
// ---------------------------------------------------------------------------------------------------------------

/** The fixed steel of the mount: for each column a ring beam on legs with braces and foot plates; for each arm its hinge stub on the tower. */
export function drawMount(k, plan) {
  for (const c of plan.columns || []) {
    const at = (a, r) => [c.x + Math.cos(a) * r, c.z + Math.sin(a) * r];
    if (!c.low) {
      // the ring, in short straight lengths
      for (const [a0, a1] of c.arcs) {
        const n = Math.max(1, Math.round((a1 - a0) / (TAU / 48)));
        for (let i = 0; i < n; i++) {
          const a = a0 + ((i + 0.5) * (a1 - a0)) / n, [x, z] = at(a, c.Rp), len = 2 * c.Rp * Math.tan((a1 - a0) / n / 2) + 0.012;
          k.box('smooth', x, c.top - c.t, z, c.w, c.t, len, C.core, -a);
          k.box('smooth', x, c.top - c.t * 0.42, z, c.w + 0.03, c.t * 0.16, len, C.amber, -a);
        }
        for (const a of [a0, a1]) { const [x, z] = at(a, c.Rp); k.box('smooth', x, c.top - c.t - 0.01, z, c.w + 0.04, c.t + 0.02, 0.05, C.steelDark, -a); }   // end plates where the ring is cut
      }
    }
    for (const a of c.legs) {
      const [x, z] = at(a, c.Rp), lw = c.w * 0.82, legTop = c.low ? Math.max(0.08, c.h - 0.2) : c.top - c.t;
      k.box('smooth', x, 0, z, lw * 2.1, 0.05, lw * 2.1, C.steelDark, -a);                                   // foot plate, bolted to the deck
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const bx = lw * 0.78 * sx, bz = lw * 0.78 * sz; k.cyl('metal', x + Math.cos(a) * bx - Math.sin(a) * bz, 0.05, z + Math.sin(a) * bx + Math.cos(a) * bz, 0.035, 0.035, 0.04, C.steel, 6); }
      k.box('smooth', x, 0.05, z, lw, legTop - 0.05, lw, C.core, -a);
      if (legTop > 0.7) k.box('smooth', x, legTop * 0.45, z, lw + 0.02, 0.12, lw + 0.02, C.amber, -a);
      // the clamp's pedestal on top of the ring (the jaw hinges on it)
      if (!c.low) k.box('smooth', x, c.top, z, c.w * 1.05, 0.06, c.w * 1.25, C.steelDark, -a);
    }
    for (const a of c.braces) {
      const out = Math.min(1.6, 0.45 + c.h * 0.45), [x0, z0] = at(a, c.Rp + out), [x1, z1] = at(a, c.Rp + c.w * 0.3), th = c.w * 0.5;
      k.beam('smooth', [x0, 0.05, z0], [x1, c.top - c.t * 0.6, z1], th, C.core);
      k.box('smooth', x0, 0, z0, th * 2.4, 0.05, th * 2.4, C.steelDark, -a);
    }
  }
  const T = PAD_TOWER;
  for (const arm of plan.arms || []) {
    // the stub the arm hinges on: a short deck out from the tower's face, two brackets and the pin's bearing blocks
    const y = arm.y, len = T.face - T.hinge + 0.5;
    k.box('smooth', T.hinge + len / 2 - 0.25, y - 0.32, 0, len, 0.2, 2.0, C.deck);
    for (const s of [-1, 1]) { k.beam('metal', [T.face + 0.2, y - 1.6, s * 0.8], [T.hinge + 0.1, y - 0.3, s * 0.8], 0.16, C.white); k.beam('metal', [T.face + 0.2, y + T.truss, s * 0.8], [T.hinge + 0.1, y + T.truss, s * 0.8], 0.16, C.white); k.beam('metal', [T.face + 0.2, y - 0.3, s * 0.8], [T.face + 0.2, y + T.truss, s * 0.8], 0.16, C.white); }
    k.box('smooth', T.hinge, y - 0.4, 0, 0.5, 0.2, 0.5, C.steelDark); k.box('smooth', T.hinge, y + T.truss + 0.02, 0, 0.5, 0.2, 0.5, C.steelDark);
    k.beam('metal', [T.face + 0.2, y + T.truss, 0], [T.hinge, y + 7, 0], 0.12, C.cable); k.beam('metal', [T.face + 0.2, y + 5.5, 0], [T.hinge, y + 7, 0], 0.1, C.cable);                // the mast the arm's stay hangs from
  }
}

/**
 * One hold-down clamp about its hinge: +X points at the rocket's axis, the hinge is on the ring's top at the origin.
 * Closed, its pad bears on the hull at x = Rp − R and its toe is under the rim.
 */
export function drawJaw(k, c) {
  const d = c.Rp - c.R, rim = c.h - c.hingeY, bw = c.w * 0.9;               // d: from the hinge in to the hull; rim: the rim's height from the hinge
  // the arm from the hinge up and in to the rim, the pad on the hull above the rim, the toe under it
  k.beam('smooth', [0, 0.04, 0], [d - 0.07, rim + 0.17, 0], bw * 0.62, C.amber);
  k.box('smooth', d - 0.06, rim - 0.05, 0, 0.12, 0.36, bw, C.amber, 0);
  k.box('smooth', d - 0.012, rim + 0.03, 0, 0.03, 0.26, bw * 0.92, C.rubber, 0);                             // the bearing pad on the hull
  k.box('smooth', d + 0.02, rim - 0.05, 0, 0.1, 0.045, bw * 0.8, C.steelDark, 0);                             // the toe the rim sits on
  k.tube('metal', [0, 0.04, -bw * 0.62], [0, 0.04, bw * 0.62], 0.05, C.steel, 10);                           // hinge pin
}

/** One service arm about its hinge pin: it runs along −X from the pin to its tip, the walkway's floor at y = 0. */
export function drawArm(k, arm) {
  const T = PAD_TOWER, L = Math.max(1.2, T.hinge - arm.tip), hz = T.half, H = T.truss;
  const boot = 0.22, head = arm.crew ? Math.min(2.6, L * 0.4) : 0.3, Lt = L - boot - head;                   // truss, then the head, then the soft boot on the hull
  const n = Math.max(1, Math.round(Lt / 1.9));
  for (const s of [-1, 1]) {
    k.beam('metal', [0, 0, s * hz], [-Lt, 0, s * hz], 0.2, C.white); k.beam('metal', [0, H, s * hz], [-Lt, H, s * hz], 0.2, C.white);
    for (let i = 0; i <= n; i++) { const x = (-Lt * i) / n; k.beam('metal', [x, 0, s * hz], [x, H, s * hz], 0.12, C.white); if (i < n) k.beam('metal', [x, i % 2 ? H : 0, s * hz], [x - Lt / n, i % 2 ? 0 : H, s * hz], 0.1, C.white); }
    k.beam('metal', [0, 0.95, s * (hz - 0.08)], [-Lt, 0.95, s * (hz - 0.08)], 0.05, C.amber);                // handrail
  }
  for (let i = 0; i <= n; i++) { const x = (-Lt * i) / n; k.beam('metal', [x, 0, -hz], [x, 0, hz], 0.12, C.white); k.beam('metal', [x, H, -hz], [x, H, hz], 0.1, C.white); }
  k.box('smooth', -Lt / 2, -0.05, 0, Lt, 0.1, hz * 2 - 0.1, C.deck);                                          // the walkway
  // umbilical lines along the arm (to the tower's risers at one end, into the head at the other)
  for (const [z, col, r] of [[-hz - 0.16, 0xcfd4d9, 0.09], [hz + 0.16, C.teal, 0.07]]) k.tube('smooth', [0.1, 0.3, z], [-Lt - head * 0.5, 0.3, z * 0.8], r, col, 10);
  if (arm.crew) {
    // the white room: a closed cabin at the end of the walkway, its door on the hull
    k.box('smooth', -Lt - head / 2, -0.2, 0, head, 2.5, hz * 2 + 0.5, C.white); k.box('smooth', -Lt - head / 2, 2.3, 0, head + 0.1, 0.16, hz * 2 + 0.6, C.teal);
    k.box('smooth', -Lt - head / 2, 0.85, hz + 0.26, head * 0.5, 0.6, 0.02, C.dark); k.box('smooth', -Lt - head / 2, 0.85, -hz - 0.26, head * 0.5, 0.6, 0.02, C.dark);
  } else {
    // the umbilical head: a frame with the plate the lines plug through
    k.box('smooth', -Lt - head / 2, -0.1, 0, head, H + 0.3, hz * 2 + 0.4, C.amber); k.box('smooth', -Lt - head / 2 - 0.01, 0.55, 0, head, 0.5, hz * 2 + 0.42, C.dark);
  }
  // the soft boot between the head and the hull: three folds, the last one on the skin
  const hh = arm.crew ? 2.1 : H - 0.1, hw = arm.crew ? hz * 2 - 0.1 : hz * 2 - 0.2, y0 = arm.crew ? 0 : 0.1;
  for (let i = 0; i < 3; i++) { const x = -Lt - head - (boot * (i + 0.5)) / 3, g = i === 1 ? 0.12 : 0; k.box('smooth', x, y0 + g / 2, 0, boot / 3 + 0.004, hh - g, hw - g, C.rubber); }
  // on a round hull the last fold follows the skin: strips across it, each as long as the curve falls away there
  if (arm.hull > 0.2) { const m = 7, half = Math.min(hw / 2, arm.hull * 0.92); for (let j = 0; j < m; j++) { const z = (((j + 0.5) / m) * 2 - 1) * half, zo = Math.min(arm.hull, Math.abs(z) + half / m), sag = arm.hull - Math.sqrt(arm.hull * arm.hull - zo * zo); if (sag > 0.004) k.box('smooth', -L - sag / 2, y0, z, sag, hh, (2 * half) / m + 0.002, C.rubber); } }
  // the stay from the mast on the tower down to the arm (it swings with the arm: its top is on the pin's line)
  k.beam('metal', [0, 7 - 0.02, 0], [-Lt * 0.86, H, 0], 0.07, C.cable);
  k.tube('metal', [0, -0.3, 0], [0, H + 0.12, 0], 0.14, C.steelDark, 12);                                    // the hinge pin
}
