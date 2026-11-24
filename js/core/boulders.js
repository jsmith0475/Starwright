// Starwright boulders: where every boulder on every world lies, how big it is, and what it is to run into one.
// PURE SIMULATION - runs under Node (no DOM, no three.js objects are needed by callers).
//
// A boulder used to be a picture: render/scatter.js placed it and nothing could touch it. The field is now made
// here, once, and both sides read it: the renderer draws these boulders and the ground-contact code in vessel.js
// collides with them, so a rock that is drawn is solid and a rock that is solid is drawn. Placement is the same
// deterministic recipe the renderer always used (a cube-sphere grid of cells about 64 m across, a seeded random
// stream per cell, the physics height field for the ground), so no boulder has moved.
//
// What is solid: the boulder layer only. Pebbles (the small stones scattered among them, a hand to a knee high) stay
// pictures: a wheel or a foot rolls over them. What a boulder is to the physics: a rounded solid fitted to its drawn
// model (ROCK_BOX below: the model's bounding box, the horizontal half-widths taken at 0.9 because a rock does not
// fill the corners of its box), standing where the model stands, turned and squashed as the model is. The solid is
// a superellipsoid, |x/a|^p + |y/b|^p + |z/c|^p = 1: p = 2 is an egg, and the higher p is the squarer its
// shoulders and the steeper its sides (ROCK_SQUARE: worn stones are rounded, broken blocks and plates are nearly
// boxes). That matters to a wheel: a rover climbs a mound and is stopped by a step.
// Written up in docs/BOULDERS.md.

// --- the cube-sphere grid (the same mapping as render/terrainmesh.js: a unit test holds the two together)
const FACES = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];
const QP = Math.PI / 4;
function faceDir(face, u, v, out) {
  const f = FACES[face], n = f[0], a = f[1], b = f[2];
  const tu = Math.tan(u * QP), tv = Math.tan(v * QP);
  const x = n[0] + a[0] * tu + b[0] * tv, y = n[1] + a[1] * tu + b[1] * tv, z = n[2] + a[2] * tu + b[2] * tv;
  const k = 1 / Math.sqrt(x * x + y * y + z * z);
  out.x = x * k; out.y = y * k; out.z = z * k;
  return out;
}
const _fo = { face: 0, u: 0, v: 0 };
function dirToFace(x, y, z, out = _fo) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  const face = ax >= ay && ax >= az ? (x > 0 ? 0 : 1) : ay >= az ? (y > 0 ? 2 : 3) : (z > 0 ? 4 : 5);
  const f = FACES[face], n = f[0], a = f[1], b = f[2];
  const dn = x * n[0] + y * n[1] + z * n[2];
  out.face = face;
  out.u = Math.atan((x * a[0] + y * a[1] + z * a[2]) / dn) / QP;
  out.v = Math.atan((x * b[0] + y * b[1] + z * b[2]) / dn) / QP;
  return out;
}
function hash(a, b, c, d) {
  let h = Math.imul(a, 0x8da6b343) ^ Math.imul(b, 0xd8163841) ^ Math.imul(c, 0xcb1ab31f) ^ Math.imul(d, 0x165667b1);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); h ^= h >>> 15;
  return h >>> 0;
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Size of a boulder cell asked for (m); the real cells are the nearest power-of-two split of a cube face. */
export const BOULDER_CELL = 64;
const LAYER_SEED = 13;        // the boulder layer's own seed (it is the first clutter layer of a world)
const PAD_CLEAR = 3080;       // m: no clutter inside the space-centre circle on the home world

// How each kind of rock is placed (the numbers render/scatter.js ROCK_KINDS carries too; a unit test holds them
// together): size against a worn stone; squash = [least, span] of the height scale; tilt = how far it may lie over
// (rad, full range); sink = [least, span] of how deep it is buried, as a fraction of its size; wind = all lie the
// same way; lie = it lies on the slope of the ground and does not stand upright.
export const ROCK_SHAPE = {
  worn: { size: 1, squash: [0.6, 0.6], tilt: 0.5, sink: [0.04, 0.13] },
  angular: { size: 1.15, squash: [0.9, 0.6], tilt: 0.5, sink: [0.08, 0.14], lie: 1 },
  ice: { size: 1.15, squash: [0.9, 0.7], tilt: 0.5, sink: [0.08, 0.14], lie: 1 },
  shard: { size: 1.1, squash: [0.7, 0.5], tilt: 0.3, sink: [0, 0.06] },
  clinker: { size: 1, squash: [0.6, 0.5], tilt: 0.6, sink: [0.05, 0.12], lie: 1 },
  clod: { size: 1, squash: [0.6, 0.5], tilt: 0.6, sink: [0.05, 0.12], lie: 1 },
  slab: { size: 1.25, squash: [0.35, 0.3], tilt: 0.3, sink: [0, 0.05], lie: 2 },
  ventifact: { size: 1, squash: [0.7, 0.4], tilt: 0.2, sink: [0.06, 0.1], wind: true, lie: 2 },
};
// The bounding box of each kind's boulder model, in the model's own units (about one unit in radius, the ground
// line at y = 0): [min x, max x, top y, min z, max z]. Measured from the models in render/scatter.js; a unit test
// measures them again and fails if a model has outgrown or shrunk from its box by more than a tenth.
export const ROCK_BOX = {
  worn: [-0.87, 1.15, 0.76, -0.92, 0.80],
  angular: [-1.04, 1.01, 0.66, -0.85, 0.86],
  ice: [-0.58, 0.72, 0.87, -0.54, 0.51],
  shard: [-0.85, 0.40, 1.04, -0.61, 0.92],
  clinker: [-1.04, 1.11, 0.85, -1.06, 0.76],
  clod: [-1.04, 1.11, 0.85, -1.06, 0.76],
  slab: [-1.11, 0.93, 0.62, -1.70, 1.13],
  ventifact: [-1.27, 1.18, 0.82, -0.75, 0.77],
};
const FILL = 0.9;
/** How square each kind's collision solid is (the exponent p above). */
export const ROCK_SQUARE = { worn: 2.5, angular: 4, ice: 4, shard: 3, clinker: 2.5, clod: 2.5, slab: 4, ventifact: 2.5 };
// How thickly each world is strewn (rocks: boulders per cell = max(3, 1.5 × this)) and with which one or two kinds
// (share = the first kind's part of them). The same numbers as scatter.rocks and scatter.rockKinds in
// render/worldstyle.js, which also holds the colours; a unit test holds the two together.
export const ROCK_FIELD = {
  sear: { rocks: 5, kinds: [['clinker', 0.65], ['slab']] },
  cindra: { rocks: 7, kinds: [['clinker', 0.6], ['angular']] },
  murk: { rocks: 6, kinds: [['worn', 0.6], ['clinker']] },
  verda: { rocks: 1.2, kinds: [['worn']] },
  pell: { rocks: 8, kinds: [['angular', 0.55], ['worn']] },
  ost: { rocks: 3, kinds: [['ice', 0.6], ['shard']] },
  rusk: { rocks: 9, kinds: [['ventifact', 0.65], ['slab']] },
  dray: { rocks: 9, kinds: [['clod', 0.5], ['angular']] },
  tiv: { rocks: 5, kinds: [['worn', 0.5], ['slab']] },
  marn: { rocks: 4, kinds: [['worn', 0.65], ['slab']] },
  slate: { rocks: 8, kinds: [['slab', 0.6], ['angular']] },
  nock: { rocks: 12, kinds: [['angular', 0.7], ['clod']] },
  brim: { rocks: 3, kinds: [['ice', 0.5], ['slab']] },
  quell: { rocks: 4, kinds: [['ice', 0.5], ['worn']] },
  nym: { rocks: 8, kinds: [['clod', 0.5], ['worn']] },
  wend: { rocks: 14, kinds: [['clod', 0.85], ['ice']] },
};

/** Switch for tests and tools that want the bare height field (the field is still made and drawn). */
export const BOULDERS = { solid: true };

const _fields = new WeakMap();
/** The boulder field of a body: null where a world has none (stars, gas giants, bodies with no height field). */
export function boulderField(body) {
  let F = _fields.get(body);
  if (F !== undefined) return F;
  const spec = body && ROCK_FIELD[body.id];
  if (!spec || typeof body.terrainHeight !== 'function') { _fields.set(body, null); return null; }
  const R = body.radius, faceSize = (Math.PI / 2) * R;
  const level = Math.max(0, Math.round(Math.log2(faceSize / BOULDER_CELL)));
  const kinds = spec.kinds.slice(0, 2).map(([kind, share]) => {
    const S = ROCK_SHAPE[kind] || ROCK_SHAPE.worn, B = ROCK_BOX[kind] || ROCK_BOX.worn;
    return { kind, share: share ?? 0.5, ...S, p: ROCK_SQUARE[kind] || 2.5, cx: (B[0] + B[1]) / 2, cz: (B[3] + B[4]) / 2, hx: FILL * (B[1] - B[0]) / 2, hy: B[2], hz: FILL * (B[4] - B[3]) / 2 };
  });
  F = { body, level, cells: 2 ** level, cellSize: faceSize / 2 ** level, perCell: Math.max(1, Math.round(Math.max(3, spec.rocks * 1.5))), kinds, cache: new Map(),
    pad: body.sites && body.sites.pad ? body.sites.pad.dir : null, padCos: Math.cos(PAD_CLEAR / R) };
  _fields.set(body, F);
  return F;
}

const _d = { x: 0, y: 0, z: 0 }, _g = { x: 0, y: 0, z: 0, h: 0 };
function quatFromUnit(ax, ay, az, bx, by, bz, out) {       // rotation taking unit a to unit b (three.js setFromUnitVectors)
  let r = ax * bx + ay * by + az * bz + 1, x, y, z;
  if (r < 1e-12) { r = 0; if (Math.abs(ax) > Math.abs(az)) { x = -ay; y = ax; z = 0; } else { x = 0; y = -az; z = ay; } }
  else { x = ay * bz - az * by; y = az * bx - ax * bz; z = ax * by - ay * bx; }
  const l = Math.sqrt(x * x + y * y + z * z + r * r) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l; out[3] = r / l;
}
function quatMul(a, b, out) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = ax * bw + aw * bx + ay * bz - az * by; out[1] = ay * bw + aw * by + az * bx - ax * bz;
  out[2] = az * bw + aw * bz + ax * by - ay * bx; out[3] = aw * bw - ax * bx - ay * by - az * bz;
}
const _q1 = [0, 0, 0, 1], _q2 = [0, 0, 0, 1], _q3 = [0, 0, 0, 1];

/**
 * The boulders of one cell (ix, iy) of the grid on cube face `face`: an array of
 *   { x, y, z        body-fixed position of the model's origin (m from the body's centre): on the ground, sunk by `sink`
 *     dx, dy, dz     the body-fixed direction it stands at;  h  the terrain height there (m above body.radius)
 *     size, yaw, tilt, squash, sink (m, negative), kind (0 or 1: which of the world's kinds), stretch
 *     ux, uy, uz     the way it stands if it lies on the slope (not unit; all zero = straight up)
 *     c1, c2         two random numbers kept for the renderer's colouring
 *     m[9]           rotation, model axes → body-fixed (row-major);  ox, oy, oz  the ellipsoid's centre (body-fixed m)
 *     a, b, c        the solid's half-axes along the model's x, y, z (m);  p  how square it is;  top  its height above the ground (m)
 *     reach          radius of a ball round (ox, oy, oz) that holds it }
 * Cached; the same cell always gives the same boulders.
 */
export function boulderCell(body, face, ix, iy) {
  const F = boulderField(body);
  if (!F) return EMPTY;
  const key = (face * F.cells + ix) * F.cells + iy;
  let list = F.cache.get(key);
  if (list) return list;
  if (F.cache.size > 600) F.cache.clear();
  list = [];
  const R = body.radius, two = F.kinds.length > 1;
  const r = rng(hash(face, ix, iy, body.seed + LAYER_SEED));
  const u0 = -1 + (2 * ix) / F.cells, du = 2 / F.cells, v0 = -1 + (2 * iy) / F.cells;
  const g = _g;
  for (let k = 0; k < F.perCell; k++) {
    const u = u0 + r() * du, v = v0 + r() * du;
    faceDir(face, u, v, _d);
    if (F.pad && (_d.x * F.pad.x + _d.y * F.pad.y + _d.z * F.pad.z) > F.padCos) continue;
    const h = body.terrainHeight(_d, 0);
    if (body.ocean && h < body.seaLevel + 0.4) continue;
    g.x = _d.x; g.y = _d.y; g.z = _d.z; g.h = h;
    const ki = two && r() >= F.kinds[0].share ? 1 : 0, K = F.kinds[ki], q = r();
    // sizes: mostly small, a long tail of bigger ones, and the odd great block
    const size = K.size * (0.4 + 1.1 * q * q * q + (r() < 0.04 ? 0.8 + 1.6 * r() : 0));
    const sink = -(K.sink[0] + K.sink[1] * r()) * size;
    let ux = 0, uy = 0, uz = 0;
    if (K.lie > 0) {
      // flat and blocky kinds lie on the slope: its normal from two more heights a stone's width away
      const e = Math.max(0.5, 0.7 * size), l1 = Math.hypot(g.z, g.x) || 1, ax = g.z / l1, az = -g.x / l1;
      const bx = g.y * az, by = g.z * ax - g.x * az, bz = -g.y * ax, kk = e / R;
      _d.x = g.x + ax * kk; _d.y = g.y; _d.z = g.z + az * kk;
      let l = Math.hypot(_d.x, _d.y, _d.z); _d.x /= l; _d.y /= l; _d.z /= l;
      const sa = Math.max(-1, Math.min(1, (body.terrainHeight(_d, 0) - g.h) / e));
      _d.x = g.x + bx * kk; _d.y = g.y + by * kk; _d.z = g.z + bz * kk;
      l = Math.hypot(_d.x, _d.y, _d.z); _d.x /= l; _d.y /= l; _d.z /= l;
      const sb = Math.max(-1, Math.min(1, (body.terrainHeight(_d, 0) - g.h) / e));
      ux = g.x - ax * sa - bx * sb; uy = g.y - by * sb; uz = g.z - az * sa - bz * sb;
    }
    const c1 = r(), c2 = r();
    const yaw = K.wind ? 0.9 + (r() - 0.5) * 1.3 : r() * 6.283;
    const tilt = (r() - 0.5) * K.tilt, squash = K.squash[0] + K.squash[1] * r();
    const stretch = 0.3 * Math.sin(yaw * 7.3);
    const rr = R + g.h + sink;
    const b = { x: g.x * rr, y: g.y * rr, z: g.z * rr, dx: g.x, dy: g.y, dz: g.z, h: g.h, size, yaw, tilt, squash, sink, kind: ki, stretch, ux, uy, uz, c1, c2,
      m: new Float64Array(9), ox: 0, oy: 0, oz: 0, a: 0, b: 0, c: 0, p: K.p, top: 0, reach: 0 };
    // the way the model stands: up (the ground's normal for a rock that lies on the slope), then yaw, then tilt
    let nx = g.x, ny = g.y, nz = g.z;
    if (ux || uy || uz) { const l = Math.hypot(ux, uy, uz); nx = ux / l; ny = uy / l; nz = uz / l; }
    quatFromUnit(0, 1, 0, nx, ny, nz, _q1);
    _q2[0] = 0; _q2[1] = Math.sin(yaw / 2); _q2[2] = 0; _q2[3] = Math.cos(yaw / 2); quatMul(_q1, _q2, _q3);
    if (tilt) { _q2[0] = Math.sin(tilt / 2); _q2[1] = 0; _q2[2] = 0; _q2[3] = Math.cos(tilt / 2); quatMul(_q3, _q2, _q1); } else { _q1[0] = _q3[0]; _q1[1] = _q3[1]; _q1[2] = _q3[2]; _q1[3] = _q3[3]; }
    const qx = _q1[0], qy = _q1[1], qz = _q1[2], qw = _q1[3], m = b.m;
    m[0] = 1 - 2 * (qy * qy + qz * qz); m[1] = 2 * (qx * qy - qz * qw); m[2] = 2 * (qx * qz + qy * qw);
    m[3] = 2 * (qx * qy + qz * qw); m[4] = 1 - 2 * (qx * qx + qz * qz); m[5] = 2 * (qy * qz - qx * qw);
    m[6] = 2 * (qx * qz - qy * qw); m[7] = 2 * (qy * qz + qx * qw); m[8] = 1 - 2 * (qx * qx + qy * qy);
    const sx = size * (1 + stretch), sy = size * squash, sz = size * (1 - stretch);
    b.a = K.hx * sx; b.b = K.hy * sy; b.c = K.hz * sz;
    const lx = K.cx * sx, lz = K.cz * sz;
    b.ox = b.x + m[0] * lx + m[2] * lz; b.oy = b.y + m[3] * lx + m[5] * lz; b.oz = b.z + m[6] * lx + m[8] * lz;
    // how high it stands: the solid's reach along the local vertical (a wide plate that lies tilted has an edge in the air)
    { const vx = Math.abs(m[0] * g.x + m[3] * g.y + m[6] * g.z) * b.a, vy = Math.abs(m[1] * g.x + m[4] * g.y + m[7] * g.z) * b.b, vz = Math.abs(m[2] * g.x + m[5] * g.y + m[8] * g.z) * b.c, e = K.p / (K.p - 1);
      b.top = Math.max(0, Math.pow(Math.pow(vx, e) + Math.pow(vy, e) + Math.pow(vz, e), 1 / e) + sink); }
    b.reach = Math.hypot(b.a, b.b, b.c);      // (a squared-off solid reaches into the corners of its box)
    list.push(b);
  }
  F.cache.set(key, list);
  return list;
}
const EMPTY = Object.freeze([]);

/**
 * The boulders that could touch a ball of `radius` metres round the body-fixed point (px, py, pz) (m from the
 * body's centre; only its direction counts, the distance is measured over the ground). Appends to `out` (emptied first) and returns it. Cells of the point's own cube face only, as
 * they are drawn.
 */
export function bouldersNear(body, px, py, pz, radius, out = []) {
  out.length = 0;
  const F = boulderField(body);
  if (!F) return out;
  const f = dirToFace(px, py, pz), pInv = 1 / (Math.hypot(px, py, pz) || 1);
  const n = Math.min(4, Math.ceil((radius + 6) / (0.5 * F.cellSize)));       // (cells shrink to about 0.7 of their size toward a face's corners)
  const ci = Math.floor((f.u + 1) / 2 * F.cells), cj = Math.floor((f.v + 1) / 2 * F.cells), face = f.face;
  for (let dj = -n; dj <= n; dj++) for (let di = -n; di <= n; di++) {
    const ix = ci + di, iy = cj + dj;
    if (ix < 0 || iy < 0 || ix >= F.cells || iy >= F.cells) continue;
    const list = boulderCell(body, face, ix, iy);
    for (let i = 0; i < list.length; i++) {
      // (over the ground: the point is taken at the boulder's own height, so a caller need not know the terrain)
      const b = list[i], s = (b.rad || (b.rad = Math.hypot(b.ox, b.oy, b.oz))) * pInv;
      const ex = b.ox - px * s, ey = b.oy - py * s, ez = b.oz - pz * s, lim = radius + b.reach;
      if (ex * ex + ey * ey + ez * ez < lim * lim) out.push(b);
    }
  }
  return out;
}

/**
 * Where the body-fixed point (px, py, pz) is against boulder `b` grown by `grow` metres all round (a wheel is
 * tested as its hub against the boulder grown by the tyre's radius: the grown solid is the true one with its
 * corners rounded to that radius, so a tyre rides up over a kerb lower than its hub). Writes out.d (m: negative inside, about the
 * distance to the surface) and out.nx, ny, nz (the unit outward normal of the surface there, body-fixed), and
 * returns true when the point is inside.
 */
export function boulderProbe(b, px, py, pz, grow, out) {
  const ex = px - b.ox, ey = py - b.oy, ez = pz - b.oz, m = b.m;
  const lx = m[0] * ex + m[3] * ey + m[6] * ez, ly = m[1] * ex + m[4] * ey + m[7] * ez, lz = m[2] * ex + m[5] * ey + m[8] * ez;
  const a = b.a, bb = b.b, c = b.c;
  const qx = Math.abs(lx) / a, qy = Math.abs(ly) / bb, qz = Math.abs(lz) / c, p = b.p;
  // f = (qx^p + qy^p + qz^p)^(1/p) is 1 on the surface; its gradient is the way out, and (f - 1) / |grad f| is
  // about the distance to the surface
  const sx = Math.pow(qx, p - 1), sy = Math.pow(qy, p - 1), sz = Math.pow(qz, p - 1);
  const k0 = Math.pow(sx * qx + sy * qy + sz * qz, 1 / p);
  let gx = sx / a, gy = sy / bb, gz = sz / c;
  if (lx < 0) gx = -gx; if (ly < 0) gy = -gy; if (lz < 0) gz = -gz;
  const k1 = Math.sqrt(gx * gx + gy * gy + gz * gz);
  if (!(k1 > 1e-12)) { out.d = -Math.min(a, bb, c) - grow; out.nx = b.dx; out.ny = b.dy; out.nz = b.dz; return true; }
  out.d = (k0 - 1) * Math.pow(k0, p - 1) / k1 - grow;
  const nx = gx / k1, ny = gy / k1, nz = gz / k1;
  out.nx = m[0] * nx + m[1] * ny + m[2] * nz; out.ny = m[3] * nx + m[4] * ny + m[5] * nz; out.nz = m[6] * nx + m[7] * ny + m[8] * nz;
  return out.d < 0;
}

const _near = [], _pr = { d: 0, nx: 0, ny: 0, nz: 0 };
/**
 * The tallest boulder (m above the ground; 0 = none) any part of which lies within `radius` metres of body-fixed
 * direction `dir` (unit). What a landing program asks before it chooses where to stand.
 */
export function boulderHazard(body, dir, radius) {
  if (!BOULDERS.solid) return 0;
  const F = boulderField(body);
  if (!F) return 0;
  const l = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z) || 1, R = body.radius;
  const list = bouldersNear(body, dir.x / l * R, dir.y / l * R, dir.z / l * R, radius + 2, _near);
  let top = 0;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    // distance over the ground between the two directions
    const dot = (b.dx * dir.x + b.dy * dir.y + b.dz * dir.z) / l;
    const dist = R * Math.sqrt(Math.max(0, 2 - 2 * dot));
    if (dist < radius + Math.max(b.a, b.c) + Math.hypot(b.ox - b.x, b.oy - b.y, b.oz - b.z) && b.top > top) top = b.top;
  }
  return top;
}

/**
 * Is the body-fixed point (m from the centre) inside a boulder grown by `grow`? Returns the deepest one's probe
 * ({ d, nx, ny, nz, b }) or null. For things that walk (a Pip) and for tests.
 */
export function boulderAt(body, px, py, pz, grow = 0, out = { d: 0, nx: 0, ny: 0, nz: 0, b: null }) {
  if (!BOULDERS.solid) return null;
  const list = bouldersNear(body, px, py, pz, grow + 0.5, _near);
  let hit = null;
  for (let i = 0; i < list.length; i++) {
    if (boulderProbe(list[i], px, py, pz, grow, _pr) && (!hit || _pr.d < out.d)) { out.d = _pr.d; out.nx = _pr.nx; out.ny = _pr.ny; out.nz = _pr.nz; out.b = list[i]; hit = out; }
  }
  return hit;
}

/** Test hook: the grid mapping, for the unit test that holds it to the renderer's. */
export const _grid = { faceDir, dirToFace, hash, rng, LAYER_SEED };
