// Starwright — procedural trees: pure geometry generators (no DOM, no three.js; Node-testable).
//
//   SPECIES                      { oak, maple, birch, spruce, pine, palm }: growth parameters and look of each species
//   ATLAS                        layout of the leaf atlas the cards index (cols, rows, cell ids); cellUV(id) → [u0, v0, u1, v1]
//   buildTree(id, { lod, seed }) → { position, normal, uv, bark, leaf, index, height, radius, center, tris, cards, tubeTris }
//
// A tree is a branching skeleton (trunk → limbs → branches) grown by a seeded recursion, meshed as tapered tubes with
// bark coordinates, and dressed with alpha-tested leaf cards that index one cell of the leaf atlas each.
//   lod 0: every branch level meshed, several cards per branch          (≈ 1.5k–2.5k triangles)
//   lod 1: the SAME skeleton (same crown outline), trunk and limbs only, one big card per branch (≈ 200–400 triangles)
// Vertex attributes:
//   position, normal   normals of cards point away from the crown's middle, so a crown shades as one soft volume
//   uv                 leaf-atlas coordinates (bark vertices point at the atlas' solid white cell)
//   bark  (u, v, k)    bark texture coordinates (u wraps the limb, v runs along it in the same scale); k = 1 on wood, 0 on leaves
//   leaf  (ao, sway, flutter)   ao: 1 outside … ~0.3 deep inside and under the crown; sway: how far a point moves in
//                      the wind with its branch (0 at the trunk foot); flutter: 1 at a card's free edge, 0 where it is attached
// Units are metres; the tree stands on y = 0 with its trunk at the origin.

export const ATLAS = { cols: 4, rows: 2, cells: { oak: 0, maple: 1, birch: 2, spruce: 3, pine: 4, palm: 5, bush: 6, solid: 7 } };
/** uv rectangle of an atlas cell [u0, v0, u1, v1] (v up), inset a little so neighbours never bleed in. */
export function cellUV(id, inset = 0.004) {
  const c = id % ATLAS.cols, r = Math.floor(id / ATLAS.cols), w = 1 / ATLAS.cols, h = 1 / ATLAS.rows;
  return [c * w + inset, 1 - (r + 1) * h + inset, (c + 1) * w - inset, 1 - r * h - inset];
}

export const SPECIES = {
  // kind: growth habit. Colours are linear-ish multipliers applied to the atlas (leaf) and bark textures.
  oak: { kind: 'broad', cell: 'oak', bark: 0, height: 17, trunk: 0.3, trunkR: 0.6, limbs: 8, limbAngle: [0.75, 1.15], limbLen: 0.46, twigs: 5, up: 0.16, spread: 0.95, card: 3.7, leafTint: [1.0, 1.0, 0.9], barkTint: [0.78, 0.70, 0.62] },
  maple: { kind: 'broad', cell: 'maple', bark: 0, height: 15, trunk: 0.28, trunkR: 0.46, limbs: 8, limbAngle: [0.55, 0.95], limbLen: 0.42, twigs: 5, up: 0.3, spread: 0.95, card: 3.3, leafTint: [0.9, 1.02, 0.85], barkTint: [0.66, 0.62, 0.60] },
  birch: { kind: 'broad', cell: 'birch', bark: 1, height: 14.5, trunk: 0.4, trunkR: 0.24, limbs: 9, limbAngle: [0.4, 0.75], limbLen: 0.4, twigs: 4, up: 0.34, spread: 0.7, droop: 0.5, card: 2.5, airy: 1, leafTint: [1.12, 1.1, 0.8], barkTint: [1, 1, 1] },
  spruce: { kind: 'conifer', cell: 'spruce', bark: 3, height: 18, trunkR: 0.27, whorls: 13, perWhorl: 6, base: 0.1, reach: 3.7, droop: 0.42, taper: 1.15, leafTint: [1.22, 1.2, 0.9], barkTint: [0.55, 0.47, 0.42] },
  pine: { kind: 'pine', cell: 'pine', bark: 4, height: 17, trunkR: 0.3, whorls: 6, perWhorl: 4, base: 0.5, reach: 3.6, leafTint: [1.2, 1.25, 1.0], barkTint: [0.86, 0.60, 0.44] },
  bush: { kind: 'bush', cell: 'bush', bark: 0, height: 2.2, trunkR: 0.05, card: 1.9, leafTint: [0.95, 1.0, 0.8], barkTint: [0.6, 0.5, 0.42] },
  palm: { kind: 'palm', cell: 'palm', bark: 2, height: 9, trunkR: 0.24, fronds: 15, frondLen: 4.2, leafTint: [1.0, 1.05, 0.75], barkTint: [0.84, 0.76, 0.62] },
};
export const SPECIES_IDS = Object.keys(SPECIES);

function rng(seed) { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const perp = d => norm(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
/** d turned by `ang` away from itself toward the direction at azimuth `az` round it. */
function turn(d, ang, az) {
  const a = perp(d), b = cross(d, a), c = Math.cos(az), s = Math.sin(az), ca = Math.cos(ang), sa = Math.sin(ang);
  return norm([d[0] * ca + (a[0] * c + b[0] * s) * sa, d[1] * ca + (a[1] * c + b[1] * s) * sa, d[2] * ca + (a[2] * c + b[2] * s) * sa]);
}

/** A branch: a polyline of nodes { p, r, d } grown from `start` along `dir`, bending a little and toward `up`. */
function grow(r, start, dir, len, r0, r1, segs, wander, up) {
  const nodes = [{ p: start, r: r0, d: dir }];
  let p = start, d = dir;
  for (let i = 1; i <= segs; i++) {
    d = norm([d[0] + (r() - 0.5) * wander, d[1] + (r() - 0.5) * wander * 0.6 + up, d[2] + (r() - 0.5) * wander]);
    p = add(p, d, len / segs);
    nodes.push({ p, r: r0 + (r1 - r0) * (i / segs), d });
  }
  return nodes;
}
const at = (nodes, t) => {
  const f = Math.min(nodes.length - 1.001, Math.max(0, t * (nodes.length - 1))), i = Math.floor(f), k = f - i, a = nodes[i], b = nodes[i + 1];
  return { p: [a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k], r: a.r + (b.r - a.r) * k, d: b.d };
};

/** The skeleton of one tree: { branches: [{ nodes, level, len }], cards: [{ base, u, n, len, width, cell, big }] } */
export function growSkeleton(id, seed = 1) {
  const sp = SPECIES[id];
  if (!sp) throw new Error('unknown tree species: ' + id);
  const r = rng(seed * 7919 + id.length * 131 + id.charCodeAt(0));
  const branches = [], cards = [], H = sp.height * (0.92 + 0.16 * r()), cell = ATLAS.cells[sp.cell];
  const GA = 2.39996;
  if (sp.kind === 'broad') {
    const th = H * sp.trunk, lean = [(r() - 0.5) * 0.1, 1, (r() - 0.5) * 0.1];
    const trunk = grow(r, [0, 0, 0], norm(lean), H * 0.72, sp.trunkR, sp.trunkR * 0.3, 7, 0.14, 0.04);
    branches.push({ nodes: trunk, level: 0, len: H * 0.72 });
    const az0 = r() * 6.283;
    for (let i = 0; i < sp.limbs; i++) {
      const t = (th / (H * 0.72)) + (1 - th / (H * 0.72)) * ((i + 0.3 * r()) / sp.limbs) * 0.97, a = at(trunk, t);
      const ang = sp.limbAngle[0] + (sp.limbAngle[1] - sp.limbAngle[0]) * (1 - i / sp.limbs) * (0.75 + 0.5 * r());
      const len = H * sp.limbLen * (1 - 0.45 * (i / sp.limbs)) * (0.8 + 0.4 * r()) * sp.spread;
      const limb = grow(r, a.p, turn(a.d, ang, az0 + i * GA + (r() - 0.5) * 0.5), len, a.r * 0.62, a.r * 0.14, 5, 0.3, sp.up * 0.5);
      branches.push({ nodes: limb, level: 1, len });
      for (let j = 0; j < sp.twigs; j++) {
        const tt = 0.3 + 0.7 * ((j + r() * 0.6) / sp.twigs), b = at(limb, tt), bl = len * (0.55 - 0.22 * tt) * (0.75 + 0.5 * r());
        const tw = grow(r, b.p, turn(b.d, 0.5 + 0.6 * r(), j * GA + r()), bl, b.r * 0.6, 0.012, 3, 0.4, sp.droop ? -sp.droop * 0.35 : sp.up * 0.4);
        branches.push({ nodes: tw, level: 2, len: bl });
      }
    }
    // the leader carries the top of the crown
    const top = trunk[trunk.length - 1];
    for (let j = 0; j < 4; j++) { const bl = H * 0.2 * (0.8 + 0.4 * r()); branches.push({ nodes: grow(r, top.p, turn(top.d, 0.25 + 0.5 * r(), j * 1.6 + r()), bl, top.r * 0.8, 0.012, 3, 0.35, sp.up * 0.4), level: 2, len: bl }); }
    // leaf sprays. Every twig carries a run of sprays and ends in a clump of crossed ones (a sub-crown); the limbs
    // carry large sprays turned inward, so the middle of the crown is filled and no sky shows through it.
    const spray = (p, d, s, big, jit = 1.4) => {
      const u = norm([d[0] + (r() - 0.5) * jit, d[1] + (r() - 0.5) * jit * 0.8 - (sp.droop || 0), d[2] + (r() - 0.5) * jit]);
      cards.push({ base: add(p, u, -s * 0.3), u, roll: r() * 6.283, len: s, width: s, cell, big });
    };
    for (const b of branches) {
      if (b.level === 0) continue;
      if (b.level === 2) {
        for (let k = 0; k < 3; k++) { const a = at(b.nodes, 0.35 + 0.3 * k); spray(a.p, a.d, sp.card * (0.7 + 0.4 * r()), false); }
        const tip = at(b.nodes, 1), s = sp.card * (0.95 + 0.4 * r());
        // the clump at the end: three sprays across each other, one of them kept by the reduced mesh
        spray(tip.p, tip.d, s, true, 0.5); spray(tip.p, [tip.d[2], 0.3, -tip.d[0]], s * 0.9, false, 0.8); spray(tip.p, [0.2, 1, 0.1], s * 0.85, false, 0.9);
        if (!sp.airy) spray(tip.p, [-tip.d[2], -0.2, tip.d[0]], s * 0.9, false, 0.8);
      } else {
        for (let k = 0; k < (sp.airy ? 2 : 4); k++) { const a = at(b.nodes, 0.3 + 0.2 * k); spray(a.p, [(r() - 0.5), 0.9, (r() - 0.5)], sp.card * (1.15 + 0.4 * r()), k === 1, 1.0); }
      }
    }
  } else if (sp.kind === 'conifer') {
    const trunk = grow(r, [0, 0, 0], [0, 1, 0], H, sp.trunkR, 0.02, 8, 0.03, 0.02);
    branches.push({ nodes: trunk, level: 0, len: H });
    for (let w = 0; w < sp.whorls; w++) {
      const k = w / (sp.whorls - 1), t = sp.base + (0.97 - sp.base) * Math.pow(k, 0.92), a = at(trunk, t), az0 = r() * 6.283;
      const reach = sp.reach * Math.pow(1 - k, sp.taper) * (0.85 + 0.3 * r()) + 0.35, n = Math.max(3, Math.round(sp.perWhorl * (1 - 0.4 * k)));
      for (let i = 0; i < n; i++) {
        const az = az0 + (i / n) * 6.283 + (r() - 0.5) * 0.4, len = reach * (0.8 + 0.4 * r());
        const dir = norm([Math.cos(az), -sp.droop * (1 - 0.8 * k) + 0.25 * k, Math.sin(az)]);
        const br = grow(r, a.p, dir, len, Math.max(0.02, a.r * 0.35), 0.01, 3, 0.1, 0.06);     // boughs sweep down, then lift at the tip
        branches.push({ nodes: br, level: 1, len, whorl: w });
        const side = norm(cross(dir, [0, 1, 0]));
        // a skirt of needled twigs sloping down and outward from the bough, and a plate hanging under it: whichever
        // way the tree is seen, one of the two faces the eye
        const out = norm([dir[0], 0, dir[2]]), slope = norm([out[0] * 0.72, -0.7 + 0.5 * k, out[2] * 0.72]);
        cards.push({ base: add(a.p, slope, -len * 0.08), u: slope, r: side, len: len * 1.18, width: len * 1.05, cell, big: true, branch: br, whorl: w });
        cards.push({ base: add(a.p, dir, -len * 0.02), u: dir, r: norm([side[0] * 0.25, -1, side[2] * 0.25]), len: len * 1.08, width: len * 0.8, cell, big: i % 2 === 0, branch: br, whorl: w });
      }
    }
    const tip = trunk[trunk.length - 1].p;
    for (let i = 0; i < 2; i++) cards.push({ base: [tip[0], tip[1] - 1.7, tip[2]], u: [0, 1, 0], r: [Math.cos(i * 1.57), 0, Math.sin(i * 1.57)], len: 2.5, width: 1.5, cell, big: i === 0 });
  } else if (sp.kind === 'bush') {
    const stem = grow(r, [0, 0, 0], [0, 1, 0], H * 0.35, sp.trunkR, 0.02, 2, 0.05, 0);
    branches.push({ nodes: stem, level: 0, len: H * 0.35 });
    const n = 11;
    for (let i = 0; i < n; i++) {
      const az = i * GA + r(), el = 0.25 + 1.2 * r(), s = sp.card * (0.75 + 0.5 * r()), d = [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)];
      cards.push({ base: [Math.cos(az) * 0.25 * r(), 0.05, Math.sin(az) * 0.25 * r()], u: d, roll: r() * 6.283, len: s, width: s * 1.1, cell, big: i % 3 === 0 });
    }
  } else if (sp.kind === 'pine') {
    const trunk = grow(r, [0, 0, 0], norm([(r() - 0.5) * 0.08, 1, (r() - 0.5) * 0.08]), H, sp.trunkR, 0.05, 8, 0.07, 0.02);
    branches.push({ nodes: trunk, level: 0, len: H });
    const tuft = (p, d, s, big) => {
      const side = perp(d);
      cards.push({ base: add(p, d, -s * 0.3), u: d, r: side, len: s, width: s, cell, big });
      cards.push({ base: add(p, d, -s * 0.3), u: d, r: cross(d, side), len: s, width: s, cell, big: false });
    };
    for (let w = 0; w < sp.whorls; w++) {
      const k = w / (sp.whorls - 1), t = sp.base + (0.96 - sp.base) * k, a = at(trunk, t), az0 = r() * 6.283;
      const n = sp.perWhorl - (k > 0.7 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const az = az0 + (i / n) * 6.283 + (r() - 0.5) * 0.7, len = sp.reach * (1 - 0.55 * k) * (0.65 + 0.6 * r());
        const br = grow(r, a.p, norm([Math.cos(az), 0.12 + 0.5 * k, Math.sin(az)]), len, Math.max(0.03, a.r * 0.5), 0.02, 4, 0.25, 0.1);
        branches.push({ nodes: br, level: 1, len });
        for (let j = 0; j < 3; j++) {
          const b = at(br, 0.45 + 0.27 * j), d = j === 2 ? b.d : turn(b.d, 0.7 + 0.5 * r(), j * 2.4 + r() * 2), bl = len * 0.38 * (0.7 + 0.6 * r());
          const tw = grow(r, b.p, norm([d[0], d[1] + 0.25, d[2]]), bl, b.r * 0.7, 0.012, 2, 0.2, 0.12);
          branches.push({ nodes: tw, level: 2, len: bl });
          const e = tw[tw.length - 1];
          tuft(e.p, norm([e.d[0], e.d[1] + 0.5, e.d[2]]), 1.7 + 0.8 * r(), true);
          if (r() < 0.6) { const m = at(tw, 0.5); tuft(m.p, norm([m.d[0] + r() - 0.5, 0.8, m.d[2] + r() - 0.5]), 1.3 + 0.6 * r(), false); }
        }
      }
    }
    const tip = trunk[trunk.length - 1];
    tuft(tip.p, [0, 1, 0], 2.2, true);
  } else {            // palm
    const bend = r() * 6.283, trunk = grow(r, [0, 0, 0], norm([Math.cos(bend) * 0.16, 1, Math.sin(bend) * 0.16]), H, sp.trunkR, sp.trunkR * 0.62, 8, 0.04, 0.035);
    branches.push({ nodes: trunk, level: 0, len: H });
    const top = trunk[trunk.length - 1].p;
    for (let i = 0; i < sp.fronds; i++) {
      const az = i * GA + r() * 0.3, el = 0.95 - 1.5 * (i / sp.fronds) + (r() - 0.5) * 0.2, len = sp.frondLen * (0.8 + 0.35 * r());
      cards.push({ frond: true, base: top, az, el, len, width: len * 0.42, cell, big: i % 2 === 0 });
    }
  }
  return { sp, branches, cards, height: H };
}

/**
 * Mesh a tree.
 * @param {string} id      species id (see SPECIES)
 * @param {{lod?: 0|1, seed?: number}} opts
 */
export function buildTree(id, { lod = 0, seed = 1 } = {}) {
  const sk = growSkeleton(id, seed), sp = sk.sp;
  const P = [], N = [], UV = [], BK = [], LF = [], IDX = [];
  const solid = cellUV(ATLAS.cells.solid, 0.06), su = (solid[0] + solid[2]) / 2, sv = (solid[1] + solid[3]) / 2;
  // crown: the middle and reach of everything that carries leaves
  let cx = 0, cy = 0, cz = 0, n = 0;
  const ends = sk.cards.map(c => (c.frond ? [c.base[0] + Math.cos(c.az) * c.len * 0.6, c.base[1], c.base[2] + Math.sin(c.az) * c.len * 0.6] : add(c.base, c.u, c.len * 0.6)));
  for (const e of ends) { cx += e[0]; cy += e[1]; cz += e[2]; n++; }
  cx /= n || 1; cy /= n || 1; cz /= n || 1;
  let cr = 0.5, yMin = 1e9;
  for (const e of ends) { cr = Math.max(cr, Math.hypot(e[0] - cx, (e[1] - cy) * 0.8, e[2] - cz)); yMin = Math.min(yMin, e[1]); }
  const H = sk.height;
  const swayAt = p => Math.min(1, Math.pow(Math.max(0, p[1]) / H, 1.5) * 0.55 + Math.hypot(p[0], p[2]) / (cr * 2.2));

  // ---- wood
  let tubeTris = 0;
  const maxLevel = lod === 0 ? 2 : (sp.kind === 'broad' ? 1 : sp.kind === 'pine' ? 1 : 0);
  for (const b of sk.branches) {
    if (b.level > maxLevel) continue;
    if (lod === 1 && sp.kind === 'conifer' && b.level > 0) continue;
    const thin = sp.kind === 'conifer' && b.level > 0;
    const rad = thin ? 3 : lod === 0 ? [9, sp.kind === 'pine' ? 5 : 6, sp.kind === 'pine' ? 3 : 4][b.level] : [6, 4, 3][b.level];
    let nodes = b.nodes;
    if (lod === 1 || b.level === 2 || thin) nodes = nodes.filter((_, i) => i === 0 || i === nodes.length - 1 || (b.level === 0 && i % 2 === 0));
    const base = P.length / 3, circ = 2 * Math.PI * nodes[0].r, uRep = Math.max(1, Math.round(circ / 1.2));
    let v = 0, a = perp(nodes[0].d);
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i], d = i === 0 ? nodes[0].d : norm(add(nodes[i].p, nodes[i - 1].p, -1));
      a = norm(add(a, d, -(a[0] * d[0] + a[1] * d[1] + a[2] * d[2])));          // carry the frame along: no twist
      const bn = cross(d, a);
      if (i > 0) v += Math.hypot(nd.p[0] - nodes[i - 1].p[0], nd.p[1] - nodes[i - 1].p[1], nd.p[2] - nodes[i - 1].p[2]);
      for (let s = 0; s <= rad; s++) {
        const th = (s / rad) * 6.283185, c = Math.cos(th), sn = Math.sin(th);
        // the foot of the trunk flares into roots
        let rr = nd.r;
        if (b.level === 0 && sp.kind !== 'palm') rr *= 1 + 0.75 * Math.exp(-nd.p[1] / (0.55 + nodes[0].r)) * (1 + 0.3 * Math.sin(th * 5 + seed));
        if (b.level === 0 && sp.kind === 'palm') rr *= 1 + 0.5 * Math.exp(-nd.p[1] / 0.5);
        const nx = a[0] * c + bn[0] * sn, ny = a[1] * c + bn[1] * sn, nz = a[2] * c + bn[2] * sn;
        const p = [nd.p[0] + nx * rr, nd.p[1] + ny * rr - (i === 0 && b.level === 0 ? 0.25 : 0), nd.p[2] + nz * rr];
        P.push(p[0], p[1], p[2]); N.push(nx, ny, nz); UV.push(su, sv);
        BK.push((s / rad) * uRep, v / 1.2, 1);
        // wood is shaded by the crown above it
        const inside = 1 - Math.min(1, Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz) / cr);
        LF.push(Math.max(0.3, 1 - 0.65 * inside - (b.level > 0 ? 0.15 : 0)), b.level === 0 ? Math.pow(Math.max(0, p[1]) / H, 2) * 0.35 : swayAt(p), 0);
      }
      if (i > 0) for (let s = 0; s < rad; s++) { const q = base + (i - 1) * (rad + 1) + s; IDX.push(q, q + 1, q + rad + 1, q + 1, q + rad + 2, q + rad + 1); tubeTris += 2; }
    }
  }

  // ---- leaves
  let cardCount = 0;
  const vert = (p, uvx, uvy, flutter, aoK = 1) => {
    // normal: away from the crown's middle, a little upward: the whole crown takes the light as one rounded mass
    const nn = sp.kind === 'conifer' ? norm([p[0], 0.45 * Math.hypot(p[0], p[2]) + 0.05, p[2]]) : norm([p[0] - cx, (p[1] - cy) * 0.8 + cr * 0.3, p[2] - cz]);
    const dist = Math.hypot(p[0] - cx, (p[1] - cy) * 0.8, p[2] - cz) / cr;
    const low = Math.min(1, Math.max(0, (p[1] - yMin) / Math.max(1, H - yMin)));
    let ao;
    if (sp.kind === 'conifer') { const reach = sp.reach * Math.pow(Math.max(0, 1 - p[1] / H), sp.taper) + 0.5; ao = (0.56 + 0.44 * Math.min(1, Math.pow(Math.hypot(p[0], p[2]) / reach, 1.5))) * (0.75 + 0.25 * Math.sqrt(low)); }
    else ao = (0.42 + 0.58 * Math.min(1, dist * dist * 1.25)) * (0.7 + 0.3 * Math.sqrt(low));
    ao = Math.max(0.22, Math.min(1, ao * aoK));
    P.push(p[0], p[1], p[2]); N.push(nn[0], nn[1], nn[2]); UV.push(uvx, uvy); BK.push(0, 0, 0); LF.push(ao, swayAt(p), flutter);
    return P.length / 3 - 1;
  };
  for (const c of sk.cards) {
    if (lod === 1 && !c.big) continue;
    const [u0, v0, u1, v1] = cellUV(c.cell), grow1 = lod === 1 ? (sp.kind === 'broad' ? 1.9 : sp.kind === 'bush' ? 1.5 : sp.kind === 'pine' ? 1.35 : 1.12) : 1;
    if (c.frond) {
      // a palm frond: an arching strip, wide in the middle, drooping to its tip
      const segs = lod === 0 ? 5 : 2, dirH = [Math.cos(c.az), 0, Math.sin(c.az)], side = [-dirH[2], 0, dirH[0]];
      let p = c.base, el = c.el, prev = null;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs, w = c.width * 0.5, d = [dirH[0] * Math.cos(el), Math.sin(el), dirH[2] * Math.cos(el)];
        const a = vert(add(p, side, -w), u0, v0 + (v1 - v0) * t, t), b = vert(add(add(p, side, w), [0, 1, 0], 0), u1, v0 + (v1 - v0) * t, t);
        // the leaflets hang from the rib: drop the edges a little
        P[a * 3 + 1] -= w * 0.28; P[b * 3 + 1] -= w * 0.28;
        if (prev) IDX.push(prev[0], prev[1], a, prev[1], b, a);
        prev = [a, b]; p = add(p, d, c.len / segs); el -= (1.5 + 0.6 * c.el) / segs;
      }
      cardCount++;
      continue;
    }
    const len = c.len * grow1, width = c.width * grow1;
    let rt = c.r;
    if (!rt) { const a = perp(c.u), b = cross(c.u, a), cs = Math.cos(c.roll), sn = Math.sin(c.roll); rt = [a[0] * cs + b[0] * sn, a[1] * cs + b[1] * sn, a[2] * cs + b[2] * sn]; }
    const b0 = add(c.base, c.u, lod === 1 ? -len * 0.2 : 0), e = add(b0, c.u, len);
    const i0 = vert(add(b0, rt, -width / 2), u0, v0, 0.2), i1 = vert(add(b0, rt, width / 2), u1, v0, 0.2), i2 = vert(add(e, rt, width / 2), u1, v1, 1), i3 = vert(add(e, rt, -width / 2), u0, v1, 1);
    IDX.push(i0, i1, i2, i0, i2, i3);
    cardCount++;
  }

  let radius = 0, top = 0;
  for (let i = 0; i < P.length; i += 3) { radius = Math.max(radius, Math.hypot(P[i], P[i + 2])); top = Math.max(top, P[i + 1]); }
  return {
    position: new Float32Array(P), normal: new Float32Array(N), uv: new Float32Array(UV), bark: new Float32Array(BK), leaf: new Float32Array(LF),
    index: new Uint32Array(IDX), height: top, radius, center: [cx, cy, cz], crownRadius: cr,
    tris: IDX.length / 3, tubeTris, cards: cardCount, species: id, lod,
  };
}

/** Deterministic hash → 0..1 (used for per-instance variation; shared by the CPU placement and the tests). */
export function hash01(a, b = 0) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Which level of detail draws a tree at a given distance: the thresholds are distances for a tree of unit scale
 * (bigger trees keep their detail farther). Returns the blend the shaders use, so the CPU bins and the GPU agree:
 *   { mesh0, mesh1, impostor }  each 0..1, summing to 1 (two are non-zero only inside a cross-fade band)
 */
export function lodBlend(dist, scale, lod) {
  const d = dist / Math.max(scale, 1e-3), st = (a, w) => Math.min(1, Math.max(0, (d - a) / Math.max(w, 1e-3)));
  const s = x => x * x * (3 - 2 * x);
  const o0 = s(st(lod.d0, lod.w0)), o1 = s(st(lod.d1, lod.w1));
  return { mesh0: 1 - o0, mesh1: o0 * (1 - o1), impostor: o1 };
}

/** LOD distances (for a unit-scale tree ~10 m tall) from the height of the picture in pixels, the vertical field of view and the detail level. */
export function lodDistances(pixelHeight, fovDeg, detail = 'high') {
  const pxPerM = pixelHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));      // pixels per metre at 1 m
  // a tree is drawn in full while it is taller than px0 pixels, as the reduced mesh down to px1, then as an impostor
  const T = { ultra: [170, 60], high: [230, 84], medium: [420, 120], low: [1e9, 190], off: [1e9, 1e9] }[detail] || [230, 84];
  // ceilings: on a large retina target the pixel rule alone would draw hundreds of full crowns (alpha-tested
  // cards: fill rate, not triangles, is what they cost)
  const CAP = { ultra: [140, 420], high: [80, 250], medium: [60, 200], low: [0, 160] }[detail] || [80, 250];
  const d0 = T[0] > 1e8 ? -1e6 : Math.min(CAP[0], (10 * pxPerM) / T[0]), d1 = T[1] > 1e8 ? -1e6 : Math.min(CAP[1], (10 * pxPerM) / T[1]);
  return { d0, w0: Math.max(4, Math.abs(d0) * 0.2), d1: Math.max(d1, d0 + 1), w1: Math.max(8, Math.abs(d1) * 0.2) };
}
