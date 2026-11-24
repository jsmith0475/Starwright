// Starwright — ground clutter near the camera: stones and boulders everywhere, grass and trees where a world has them.
// Instanced (one draw call per kind). Objects are placed deterministically per ground cell from the same
// body.terrainHeight the physics uses, so a rock is always in the same spot and sits exactly on the ground.
// Nothing is placed inside the space-centre circle on the home world (the space-centre model owns that ground).
//
// Layers: boulders (out to 150 m), pebbles (a dense field round the camera), grass in two layers (a thick
// sward within 25 m, tufts out to 80 m), conifers and broadleaf trees in groves (out to 760 m) with a soft shadow
// under each. Only the instances that exist are drawn: tiles pack their objects to the front of the buffer.
//
// Rocks come in kinds (ROCK_KINDS below): worn stones, angular fractured blocks, ice blocks, ice blades, clinker,
// clods, flat slabs and wind-cut ventifacts. A world's style names one or two of them (scatter.rockKinds in
// worldstyle.js), so the loose stone under a rover's wheels is that world's own: each kind has its own shape and its
// own shading. A second kind costs one more draw call in each rock layer (its stones share the layer's tiles and are
// sorted into their own instanced mesh when the tiles are packed), so a world has at most two.
//
// Boulders are solid. Where each one lies, its size and the way it stands come from core/boulders.js, the same
// field the ground-contact physics collides with: this file only draws them (and colours them). So they are drawn
// at every quality setting and in full number, because a rock a rover can hit must be on the screen. Pebbles are
// still only pictures, placed here.
import * as THREE from '../lib/three.module.min.js';
import { faceDir, dirToFace } from './terrainmesh.js';
import { buildTree, growSkeleton } from './treegen.js';
import { SUN_SURFACE, ATMO_GLSL, atmoUniforms } from './atmosphere.js';
import { boulderField, boulderCell } from '../core/boulders.js';

const _d = { x: 0, y: 0, z: 0 }, _rgb = [0, 0, 0];
const REC = 10;      // numbers kept for each placed object (see `rec` in createScatter)
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _up = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);

function hash(a, b, c, d) {
  let h = Math.imul(a, 0x8da6b343) ^ Math.imul(b, 0xd8163841) ^ Math.imul(c, 0xcb1ab31f) ^ Math.imul(d, 0x165667b1);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); h ^= h >>> 15;
  return h >>> 0;
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// smooth lumps for displacing geometry: a few sines, continuous over the sphere
function lump(x, y, z, s) {
  return Math.sin(x * 2.1 + s) * Math.sin(y * 2.7 + s * 1.7) * Math.sin(z * 2.3 + s * 0.6) + 0.5 * Math.sin(x * 4.7 + y * 3.9 + s * 2.2) * Math.sin(z * 5.3 - y * 2.9 + s);
}

/** Geometry from loose triangles → welded, with smooth normals; uv filled by `uvOf(x, y, z)`. */
function weld(pos, uvOf) {
  const map = new Map(), P = [], idx = [];
  for (let i = 0; i < pos.length; i += 3) {
    const key = `${Math.round(pos[i] * 2000)},${Math.round(pos[i + 1] * 2000)},${Math.round(pos[i + 2] * 2000)}`;
    let k = map.get(key);
    if (k === undefined) { k = P.length / 3; map.set(key, k); P.push(pos[i], pos[i + 1], pos[i + 2]); }
    idx.push(k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const uv = new Float32Array((P.length / 3) * 2);
  for (let i = 0; i < P.length / 3; i++) { const t = uvOf(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); uv[i * 2] = t[0]; uv[i * 2 + 1] = t[1]; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * The same triangles with normals that are part face normal, part smooth (flat = 1: hard facets, as broken rock and
 * ice have). uv.x of each face gets a tone of its own (0..1) so the shader can make one fracture face a little
 * lighter than the next; uv.y from `uvOf` as in weld. Triangles squeezed to nothing are dropped.
 */
function facet(pos, flat, uvOf, seed = 1) {
  const w = weld(pos, uvOf), P = w.attributes.position.array, SN = w.attributes.normal.array, I = w.index.array;
  const p = [], n = [], uv = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-7) continue;
    fx /= fl; fy /= fl; fz /= fl;
    // (triangles that lie in one plane must get one tone: take it from the way the face looks, not from its number)
    const tone = Math.abs((Math.sin(Math.round(fx * 9) * 12.9898 + Math.round(fy * 9) * 78.233 + Math.round(fz * 9) * 37.719 + seed) * 43758.5453) % 1);
    for (const v of [a, b, c]) {
      const nx = fx * flat + SN[v] * (1 - flat), ny = fy * flat + SN[v + 1] * (1 - flat), nz = fz * flat + SN[v + 2] * (1 - flat), l = Math.hypot(nx, ny, nz) || 1;
      p.push(P[v], P[v + 1], P[v + 2]); n.push(nx / l, ny / l, nz / l); uv.push(tone, uvOf(P[v], P[v + 1], P[v + 2])[1]);
    }
  }
  w.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

// every rock model: about one unit in radius, the ground line near y = 0 with a root below it to bury, and
// uv.y = height (0 at the bottom of a worn stone, about 1 at its top) for the dark where a stone meets the ground
const rockUV = (x, y) => [0, (y + 0.26) / 0.9];

/**
 * A stone carved from a ball: an icosphere knocked into a lump by smooth noise, sheared by a few planes, squashed,
 * its underside flattened into the ground. The defaults are the worn stone; the options make the other kinds:
 *   cuts        how many planes
 *   planes(r)   the planes themselves ([nx, ny, nz, d] each), for a shape that is not random
 *   hard        1 = a vertex past a plane is put on it (a true flat face); less leaves the face bulging
 *   lumps, fine, rough   strength of the broad lumps, the small ones, and of a sharp knobbly roughness
 *   shape       [x, y, z] proportions;  flat   0 = smooth normals (worn), towards 1 = faceted (see facet)
 */
function rockGeometry(detail, seed, { cuts: nCuts = 6, planes = null, hard = 0.92, lumps = 0.26, fine = 0.08, rough = 0, shape = [1.08, 0.74, 0.9], flat = 0 } = {}) {
  // (worn: welded, so the normals are smooth and it reads as a worn stone, not a faceted prop)
  const src = new THREE.IcosahedronGeometry(1, detail).attributes.position.array, pos = new Float32Array(src.length);
  // a few planes shear lumps off, as fractures do: flat faces and edges that the smooth normals then round over
  const r = rng(seed * 101 + 7), cuts = planes ? planes(r) : [];
  if (!planes) for (let c = 0; c < nCuts; c++) {
    const a = r() * 6.283, cy = -0.15 + 1.0 * r(), s = Math.sqrt(Math.max(0, 1 - cy * cy));
    cuts.push([Math.cos(a) * s, cy, Math.sin(a) * s, 0.6 + 0.26 * r()]);
  }
  for (let i = 0; i < src.length; i += 3) {
    let x = src[i], y = src[i + 1], z = src[i + 2];
    let k = 0.9 + lumps * lump(x, y, z, seed) + fine * lump(x * 2.6, y * 2.6, z * 2.6, seed + 4);
    if (rough) k += rough * (Math.abs(lump(x * 3.3, y * 3.3, z * 3.3, seed + 9)) - 0.3) + 0.45 * rough * lump(x * 7.1, y * 7.1, z * 7.1, seed + 2);
    x *= k; y *= k; z *= k;
    for (const [nx, ny, nz, d] of cuts) { const over = x * nx + y * ny + z * nz - d; if (over > 0) { x -= nx * over * hard; y -= ny * over * hard; z -= nz * over * hard; } }
    pos[i] = x * shape[0]; pos[i + 1] = Math.max(-0.26, y * shape[1]); pos[i + 2] = z * shape[2];
  }
  return flat ? facet(pos, flat, rockUV, seed) : weld(pos, rockUV);
}

/**
 * A block with true flat faces and sharp edges, as rock and ice break: a box cut down by `cuts` random planes (and
 * one below, its bed in the ground). Only real corners become vertices, so a face is one flat polygon and not a patch
 * of triangles, which is what makes a faceted stone look like a prop. `up` = how far the planes may lean up or down
 * (small: upright sides and a flat top, a box or a column; 1: any way), `d` = [nearest, span] of how deep they bite.
 */
function blockGeometry(cuts, seed, { up = 1, d = [0.5, 0.35], shape = [1.1, 0.85, 0.95], flat = 0.9 } = {}) {
  const r = rng(seed * 89 + 17), B = 1.3;
  const quad = (a, b, c, e) => [a, b, c, e];
  const c8 = []; for (let i = 0; i < 8; i++) c8.push([i & 1 ? B : -B, i & 2 ? B : -B, i & 4 ? B : -B]);
  let faces = [quad(c8[0], c8[1], c8[3], c8[2]), quad(c8[4], c8[5], c8[7], c8[6]), quad(c8[0], c8[1], c8[5], c8[4]), quad(c8[2], c8[3], c8[7], c8[6]), quad(c8[0], c8[2], c8[6], c8[4]), quad(c8[1], c8[3], c8[7], c8[5])];
  const planes = [[0, -1, 0, 0.55]];      // (deep: a block lying over on a slope must not show its underside)
  for (let c = 0; c < cuts; c++) {
    // directions spread evenly round the ball, then knocked about: every side gets cut, none twice the same
    const fy = 1 - (2 * (c + 0.5)) / cuts, fs = Math.sqrt(1 - fy * fy), fa = c * 2.39996 + seed;
    let x = Math.cos(fa) * fs + 0.5 * (r() - 0.5), y = c ? (fy + 0.5 * (r() - 0.5)) * up : 0.6 + up, z = Math.sin(fa) * fs + 0.5 * (r() - 0.5);      // (the first is the top)
    const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
    planes.push([x, y, z, c ? d[0] + d[1] * r() : 0.45 + 0.2 * r()]);
  }
  for (const [nx, ny, nz, dd] of planes) {
    const next = [], rim = [];
    for (const poly of faces) {
      const out = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length], da = a[0] * nx + a[1] * ny + a[2] * nz - dd, db = b[0] * nx + b[1] * ny + b[2] * nz - dd;
        if (da <= 0) out.push(a);
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const t = da / (da - db), q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; out.push(q); rim.push(q); }
      }
      if (out.length >= 3) next.push(out);
    }
    if (rim.length >= 3) {
      // the new face: the cut's own points, put in order round the plane's normal
      const m = [0, 0, 0]; for (const q of rim) { m[0] += q[0] / rim.length; m[1] += q[1] / rim.length; m[2] += q[2] / rim.length; }
      const ax = Math.abs(nx) < 0.8 ? [1, 0, 0] : [0, 1, 0], u = [ny * ax[2] - nz * ax[1], nz * ax[0] - nx * ax[2], nx * ax[1] - ny * ax[0]], v = [ny * u[2] - nz * u[1], nz * u[0] - nx * u[2], nx * u[1] - ny * u[0]];
      const ang = (q) => Math.atan2((q[0] - m[0]) * v[0] + (q[1] - m[1]) * v[1] + (q[2] - m[2]) * v[2], (q[0] - m[0]) * u[0] + (q[1] - m[1]) * u[1] + (q[2] - m[2]) * u[2]);
      const cap = rim.map((q) => [ang(q), q]).sort((x, y) => x[0] - y[0]).map((x) => x[1]).filter((q, i, arr) => { const o = arr[(i + arr.length - 1) % arr.length]; return Math.hypot(q[0] - o[0], q[1] - o[1], q[2] - o[2]) > 1e-4; });
      if (cap.length >= 3) next.push(cap);
    }
    faces = next;
  }
  // fans of triangles, each face wound to look away from the middle of the block
  const mid = [0, 0, 0]; let nv = 0;
  for (const f of faces) for (const q of f) { mid[0] += q[0]; mid[1] += q[1]; mid[2] += q[2]; nv++; }
  const tris = [];
  for (const f of faces) for (let i = 1; i + 1 < f.length; i++) {
    const a = f[0], b = f[i], c = f[i + 1];
    const fx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), fy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), fz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const outward = fx * (a[0] - mid[0] / nv) + fy * (a[1] - mid[1] / nv) + fz * (a[2] - mid[2] / nv) > 0;
    for (const q of outward ? [a, b, c] : [a, c, b]) tris.push(q[0] * shape[0], q[1] * shape[1], q[2] * shape[2]);
  }
  return facet(tris, flat, rockUV, seed);
}

/** Loose triangles of a skin over rings of n points each (lowest ring first, points in order of angle), closed on top by a fan to `tip`. */
function loft(rings, tip, out) {
  const n = rings[0].length;
  for (let k = 0; k + 1 < rings.length; k++) for (let i = 0; i < n; i++) {
    const a = rings[k][i], b = rings[k][(i + 1) % n], c = rings[k + 1][(i + 1) % n], d = rings[k + 1][i];
    out.push(...a, ...c, ...b, ...a, ...d, ...c);
  }
  const top = rings[rings.length - 1];
  for (let i = 0; i < n; i++) out.push(...top[i], ...tip, ...top[(i + 1) % n]);
}

function slabGeometry(plates, seed) {
  // flat plates of split rock or broken crust: an uneven polygon with a bevelled edge, lying a little askew, its
  // root well under the ground; the bigger model has a smaller piece lying against it. (Twice as thick as it will
  // look: slabs are placed with a small squash, which also keeps their shade small.)
  const r = rng(seed * 57 + 3), tris = [];
  for (let p = 0; p < plates; p++) {
    const rad = p ? 0.45 + 0.2 * r() : 1, off = p ? 0.85 + 0.3 * r() : 0, oa = r() * 6.283, cx = Math.cos(oa) * off, cz = Math.sin(oa) * off;
    const n = 5 + Math.floor(r() * 3), th = 0.3 + 0.2 * r(), a0 = r() * 6.283, tx = (r() - 0.5) * (p ? 0.7 : 0.3), tz = (r() - 0.5) * (p ? 0.7 : 0.3);
    const poly = [];
    for (let i = 0; i < n; i++) { const a = a0 + ((i + 0.7 * (r() - 0.5)) / n) * 6.283, rr = rad * (0.72 + 0.38 * r()); poly.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
    const ring = (y, k, lean = 1) => poly.map(([x, z]) => [cx + x * k, y + lean * (tx * x + tz * z), cz + z * k]);
    loft([ring(-0.5, 1.08, 0), ring(th - 0.07, 1), ring(th, 0.9)], [cx, th + 0.015, cz], tris);
  }
  return facet(tris, 0.92, rockUV, seed);
}

function shardGeometry(blades, rings, seed) {
  // ice that has split stands in broken plates on edge: thin wedges leaning the way they fell, a big one and smaller
  // ones against its foot. Each is a flattened four-sided body with a blunt, chisel-shaped top, not a spike.
  const r = rng(seed * 73 + 11), tris = [];
  for (let b = 0; b < blades; b++) {
    const a = r() * 6.283, off = b ? 0.35 + 0.3 * r() : 0, bx = Math.cos(a) * off, bz = Math.sin(a) * off;
    const h = b ? 0.35 + 0.35 * r() : 0.8 + 0.3 * r(), w = (b ? 0.34 : 0.55) + 0.2 * r(), tk = w * (0.22 + 0.2 * r()), dir = r() * 3.1416, lean = 0.25 + 0.4 * r(), la = dir + 1.5708 + (r() - 0.5);
    const cd = Math.cos(dir), sd = Math.sin(dir), skew = (r() - 0.5) * 0.5 * w;
    const at = (y, lx, lz) => { const k = Math.max(y, 0), ox = bx + Math.cos(la) * lean * k + cd * skew * k, oz = bz + Math.sin(la) * lean * k + sd * skew * k; return [ox + lx * cd - lz * sd, y, oz + lx * sd + lz * cd]; };
    const ring = (y, k, kt = k) => [at(y, w * k, 0), at(y, 0, tk * kt), at(y, -w * k, 0), at(y, 0, -tk * kt)];
    const rs = rings > 2 ? [ring(-0.3, 1.1), ring(h * 0.5, 0.9), ring(h * 0.93, 0.62, 0.5)] : [ring(-0.3, 1.05), ring(h * 0.9, 0.85, 0.6)];
    loft(rs, at(h, w * 0.15, 0), tris);
  }
  return facet(tris, 0.95, rockUV, seed);
}

// The kinds of loose rock. look = which shading the rock shader uses (LOOK); big / small = the boulder and the
// pebble model; size = scale against a worn stone; squash = [least, span] of the height scale; tilt = how far it
// may lie over (rad, full range); sink = [least, span] of how deep a boulder is buried, as a fraction of its size;
// own = how much it keeps its own colour rather than the ground's; wind = all lie the same way (cut by one wind);
// lie = it lies on the slope of the ground and does not stand upright (1: boulders, 2: pebbles too. It costs two
// more terrain heights a stone, so only the kinds that would show a gap under them on a hillside have it).
// (The shade under a boulder is sized by its height scale. So the blocks' models are a little low and their squash
// high, and the shade reaches the edges of a wide block; slabs the other way, and their shade stays under them.)
const ANGULAR = { up: 0.45, d: [0.55, 0.35], shape: [1.15, 0.8, 0.95], flat: 0.9 };
const ICE = { up: 0.55, d: [0.38, 0.36], shape: [1.0, 1.0, 0.9], flat: 0.95 };
const CLINKER = { cuts: 2, lumps: 0.3, fine: 0.14, rough: 0.34, shape: [1.05, 0.8, 0.95], flat: 0.3 };
// a ventifact: two long faces ground flat by blown sand, meeting in a keel that runs down the wind, and a blunt nose
const VENTIFACT = { planes: (r) => [[0.1 * (r() - 0.5), 0.62, 0.78], [0.1 * (r() - 0.5), 0.62, -0.78], [0.8, 0.55, 0.3 * (r() - 0.5)]].map(([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l, 0.44 + 0.14 * r()]; }),
  hard: 0.85, lumps: 0.16, fine: 0.06, shape: [1.3, 1.0, 0.9], flat: 0.4 };
const ROCK_KINDS = {
  worn: { look: 0, big: () => rockGeometry(2, 3), small: () => rockGeometry(1, 9), size: 1, squash: [0.6, 0.6], tilt: 0.5, sink: [0.04, 0.13], own: 0.35 },
  angular: { look: 5, big: () => blockGeometry(15, 5, ANGULAR), small: () => blockGeometry(9, 12, ANGULAR), size: 1.15, squash: [0.9, 0.6], tilt: 0.5, sink: [0.08, 0.14], own: 0.4, lie: 1 },
  ice: { look: 1, big: () => blockGeometry(11, 8, ICE), small: () => blockGeometry(8, 14, ICE), size: 1.15, squash: [0.9, 0.7], tilt: 0.5, sink: [0.08, 0.14], own: 0.5, lie: 1 },
  shard: { look: 1, big: () => shardGeometry(3, 3, 4), small: () => shardGeometry(2, 2, 6), size: 1.1, squash: [0.7, 0.5], tilt: 0.3, sink: [0, 0.06], own: 0.5 },
  clinker: { look: 2, big: () => rockGeometry(2, 6, CLINKER), small: () => rockGeometry(1, 15, CLINKER), size: 1, squash: [0.6, 0.5], tilt: 0.6, sink: [0.05, 0.12], own: 0.45, lie: 1 },
  clod: { look: 0, big: () => rockGeometry(2, 6, CLINKER), small: () => rockGeometry(1, 15, CLINKER), size: 1, squash: [0.6, 0.5], tilt: 0.6, sink: [0.05, 0.12], own: 0.3, lie: 1 },
  slab: { look: 3, big: () => slabGeometry(2, 2), small: () => slabGeometry(1, 7), size: 1.25, squash: [0.35, 0.3], tilt: 0.3, sink: [0, 0.05], own: 0.45, lie: 2 },
  ventifact: { look: 4, big: () => rockGeometry(2, 4, VENTIFACT), small: () => rockGeometry(1, 11, VENTIFACT), size: 1, squash: [0.7, 0.4], tilt: 0.2, sink: [0.06, 0.1], own: 0.6, wind: true, lie: 2 },
};

function grassGeometry(blades, hMin, hMax, wMin, wMax, spread, seed) {
  // a tuft: tapered blades leaning outward, each bent once; uv.y = height fraction (0 at the root)
  const pos = [], nor = [], uv = [];
  const r = rng(seed);
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + r() * 1.3, lean = 0.1 + 0.34 * r(), h = hMin + (hMax - hMin) * r(), w = wMin + (wMax - wMin) * r();
    const rad = spread * (0.15 + 0.85 * r()), cx = Math.cos(a), cz = Math.sin(a), ox = cx * rad, oz = cz * rad;
    const tw = a + 1.2 + r() * 0.7, px = Math.cos(tw) * w, pz = Math.sin(tw) * w;     // the blade's width runs across its lean, a little twisted
    const mid = [ox + cx * lean * 0.3 * h, h * 0.56, oz + cz * lean * 0.3 * h], tip = [ox + cx * lean * h * 1.2, h, oz + cz * lean * h * 1.2];
    const quad = [[ox - px, 0, oz - pz], [ox + px, 0, oz + pz], [mid[0] + px * 0.72, mid[1], mid[2] + pz * 0.72], [mid[0] - px * 0.72, mid[1], mid[2] - pz * 0.72]];
    const tris = [quad[0], quad[1], quad[2], quad[0], quad[2], quad[3], quad[3], quad[2], tip];
    for (const v of tris) { pos.push(v[0], v[1], v[2]); nor.push(cx * 0.35, 0.86, cz * 0.35); uv.push(0, v[1] / hMax); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** Join geometries that have position / normal / uv into one non-indexed geometry. */
function join(parts) {
  const P = [], N = [], U = [];
  for (const src of parts) {
    const p = src.index ? src.toNonIndexed() : src;
    P.push(...p.attributes.position.array); N.push(...p.attributes.normal.array); U.push(...p.attributes.uv.array);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  return g;
}
function trunk(r0, r1, h, total, seg = 7) {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1, true); g.translate(0, h / 2 - 0.2, 0);
  const n = g.attributes.position.count, uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { uv[i * 2] = 2; uv[i * 2 + 1] = g.attributes.position.getY(i) / total; }      // uv.x = 2 marks wood
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

function coniferGeometry(tiers = 9, seg = 14, tseg = 7) {
  // a spruce: trunk and whorls of drooping boughs. Each whorl is a ragged star (long boughs with gaps between), not
  // a cone, and the whorls overlap, so the outline is broken the way a real tree's is. uv.x = how far out a point
  // is on its whorl (1 at the tips, 0 under the whorl above: used for shading), uv.y = height fraction. Normals
  // lean outward and up, so the light models the whole crown softly instead of faceting every tier.
  const H = 11, parts = [trunk(0.3, 0.1, 4.2, H, tseg)];
  const r = rng(31);
  for (let t = 0; t < tiers; t++) {
    const k = t / (tiers - 1), y0 = 1.3 + k * 7.4, hgt = 2.5 - 1.1 * k, rad = 2.7 * Math.pow(1 - 0.86 * k, 0.9) * (0.9 + 0.2 * r());
    const pos = [], nor = [], uv = [];
    const rim = [], tw = r() * 6.283;
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2 + tw, tip = s % 2 === 0;
      const rr = rad * (tip ? 0.82 + 0.36 * r() : 0.38 + 0.2 * r());
      rim.push([Math.cos(a) * rr, y0 - (tip ? 0.22 * rad + 0.3 * r() : -0.1 * rad), Math.sin(a) * rr, tip ? 1 : 0.45]);
    }
    const apex = [0, y0 + hgt, 0, 0];
    for (let s = 0; s < seg; s++) {
      const a = rim[s], b = rim[(s + 1) % seg];
      for (const v of [apex, b, a]) {
        pos.push(v[0], v[1], v[2]);
        const l = Math.hypot(v[0], v[2]) || 1, out = v[3] > 0 ? 1 : 0;
        const nx = out ? v[0] / l : 0, nz = out ? v[2] / l : 0, ny = out ? 0.6 : 1, nl = Math.hypot(nx, ny, nz);
        nor.push(nx / nl, ny / nl, nz / nl); uv.push(v[3], v[1] / H);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    parts.push(g);
  }
  return join(parts);
}

function broadleafGeometry(far = false) {
  // a spreading tree: trunk, and a crown of three merged lumpy masses with normals that point away from the crown's
  // middle (so the crown shades as one soft volume). uv.x = 1 on top / outside, lower underneath.
  const H = 9, parts = [trunk(0.36, 0.2, 4.2, H, far ? 4 : 7)];
  const blobs = [[0, 6.0, 0, 2.9, 2.3], [1.5, 5.0, 0.7, 1.9, 1.5], [-1.3, 5.2, -0.9, 2.0, 1.5], [0.2, 4.9, -1.6, 1.6, 1.3]];
  blobs.forEach(([bx, by, bz, rw, rh], bi) => {
    if (far && bi >= 2) return;
    const s = far ? new THREE.SphereGeometry(1, bi === 0 ? 6 : 5, bi === 0 ? 5 : 4) : new THREE.SphereGeometry(1, bi === 0 ? 10 : 8, bi === 0 ? 7 : 5);
    const p = s.attributes.position, n = s.attributes.normal, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + 0.2 * lump(x * 1.6, y * 1.6, z * 1.6, bi * 3.1 + 1) + 0.1 * lump(x * 3.4, y * 3.4, z * 3.4, bi + 7);
      const px = bx + x * rw * k, py = by + Math.max(y, -0.55) * rh * k, pz = bz + z * rw * k;
      p.setXYZ(i, px, py, pz);
      const nx = px, ny = (py - 5.0) * 1.2, nz = pz, l = Math.hypot(nx, ny, nz) || 1;
      n.setXYZ(i, nx / l, ny / l, nz / l);
      uv[i * 2] = Math.min(1, Math.max(0, 0.55 + 0.6 * (ny / l) + 0.25 * (Math.hypot(px, pz) / 3)));
      uv[i * 2 + 1] = py / H;
    }
    s.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    parts.push(s);
  });
  return join(parts);
}

// [realism pass] The home world's broadleaf woods use the same trees as the space centre (js/render/treegen.js): the
// real trunk and limbs of an oak, and its crown as one small lumpy mass per leaf clump, so a wood seen from a few
// hundred metres has the layered, clustered outline of the trees with leaf cards and there is no change of style
// where the centre's own trees end. Same conventions as broadleafGeometry (uv.x: 2 = wood, else light on the crown).
function groveGeometry(far = false, seed = 5) {
  const K = 0.85, t = buildTree('oak', { lod: 1, seed }), sk = growSkeleton('oak', seed), H = t.height * K;
  // wood: the triangles of the reduced mesh that are bark
  const map = new Map(), P = [], N = [], U = [], I = [];
  for (let i = 0; i < t.index.length; i += 3) {
    const tri = [t.index[i], t.index[i + 1], t.index[i + 2]];
    if (t.bark[tri[0] * 3 + 2] < 0.5) continue;
    if (far && t.position[tri[0] * 3 + 1] > t.height * 0.55) continue;                      // far: the trunk only
    for (const v of tri) {
      if (!map.has(v)) { map.set(v, P.length / 3); P.push(t.position[v * 3] * K, t.position[v * 3 + 1] * K, t.position[v * 3 + 2] * K); N.push(t.normal[v * 3], t.normal[v * 3 + 1], t.normal[v * 3 + 2]); U.push(2, (t.position[v * 3 + 1] * K) / H); }
      I.push(map.get(v));
    }
  }
  const wood = new THREE.BufferGeometry();
  wood.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); wood.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); wood.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); wood.setIndex(I);
  const parts = [wood], c = t.center, cr = t.crownRadius || t.radius;
  const big = sk.cards.filter(k => k.big);
  big.forEach((k, bi) => {
    if (far && bi % 4) return;
    const rad = k.len * (far ? 1.05 : 0.6) * K, cx = (k.base[0] + k.u[0] * k.len * 0.5) * K, cy = (k.base[1] + k.u[1] * k.len * 0.5) * K, cz = (k.base[2] + k.u[2] * k.len * 0.5) * K;
    const sph = far ? new THREE.SphereGeometry(1, 5, 3) : new THREE.SphereGeometry(1, 6, 4);
    const p = sph.attributes.position, n = sph.attributes.normal, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), q = 1 + 0.28 * lump(x * 1.9, y * 1.9, z * 1.9, bi * 3.1 + 1);
      const px = cx + x * rad * q, py = cy + y * rad * 0.8 * q, pz = cz + z * rad * q;
      p.setXYZ(i, px, py, pz);
      const nx = px - c[0] * K, ny = (py - c[1] * K) * 0.9 + cr * K * 0.25, nz = pz - c[2] * K, l = Math.hypot(nx, ny, nz) || 1;
      n.setXYZ(i, nx / l, ny / l, nz / l);
      uv[i * 2] = Math.min(1, Math.max(0, 0.3 + 0.45 * (ny / l) + 0.4 * (l / (cr * K)) + 0.2 * y));
      uv[i * 2 + 1] = Math.min(1, py / H);
    }
    sph.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    parts.push(sph);
  });
  return join(parts);
}

function shadowGeometry() {
  // a unit disc in the ground plane (y = 0): stretched away from the sun into each tree's shadow by the vertex shader
  const g = new THREE.CircleGeometry(1, 12); g.rotateX(-Math.PI / 2);
  return g;
}

const NOISE = `
float h3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z); }`;

const VS = `#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uRange, uTime, uSway;
uniform vec4 uShadowDims;        // of the thing that casts it, per unit of its height scale: radius, height; then lift off the ground (m), depth pull
uniform vec3 uSun;
varying vec3 vN, vC, vL, vView; varying float vY, vT, vFade;
void main(){
  vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec4 wc = modelMatrix * ip;
  float d = distance(wc.xyz, cameraPosition);
  float k = 1.0 - smoothstep(uRange * 0.7, uRange, d);          // shrink into the ground at the edge of the range
  vec3 p = position * k;
  #ifdef SHADOW
    // the disc becomes the tree's shadow: laid on the ground, drawn out away from the sun
    vec3 upW = normalize(mat3(modelMatrix) * (mat3(instanceMatrix) * vec3(0.0, 1.0, 0.0)));
    float sz = length(mat3(instanceMatrix) * vec3(0.0, 1.0, 0.0));
    float mu = dot(upW, uSun);
    vec3 flt = uSun - upW * mu;
    vec3 away = -flt / max(length(flt), 1e-4);
    vec3 side = cross(upW, away);
    float len = min(uShadowDims.y * sz * sqrt(max(1.0 - mu * mu, 0.0)) / max(mu, 0.13), 60.0);
    float rad = uShadowDims.x * sz * k;
    vec3 wpos = wc.xyz + upW * (uShadowDims.z + 0.02 * rad) + side * (position.x * rad) + away * (position.z * (rad + 0.5 * len) + 0.5 * len + 0.3 * rad) * k;
    vN = upW; vC = vec3(0.0); vL = position; vY = length(position.xz); vT = smoothstep(-0.02, 0.1, mu); vFade = k;
    vView = wpos - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * vec4(wpos, 1.0);
  #else
    if (uSway > 0.0) { float ph = ip.x * 0.7 + ip.z * 0.9; float y2 = uv.y * uv.y; p.xz += uSway * y2 * vec2(sin(uTime * 1.7 + ph) + 0.4 * sin(uTime * 4.3 + ph * 2.1), cos(uTime * 1.3 + ph * 1.3)); }
    vec4 wp = modelMatrix * (instanceMatrix * vec4(p, 1.0));
    vN = normalize(mat3(modelMatrix) * (mat3(instanceMatrix) * normal));
    vC = instanceColor; vY = uv.y; vT = uv.x; vFade = k;
    vL = position + fract(ip.xyz * 0.173) * 9.0;                // each object gets its own piece of the noise
    vView = wp.xyz - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * wp;
  #endif
  #include <logdepthbuf_vertex>
}`;
const FS = `#include <common>
#include <logdepthbuf_pars_fragment>
${ATMO_GLSL}
${NOISE}
uniform vec3 uSun, uSunColor, uAmb, uUp, uCamU; uniform float uRadius, uShadowK, uShadowGain; uniform vec4 uShadowDims;
varying vec3 vN, vC, vL, vView; varying float vY, vT, vFade;
void main(){
  #include <logdepthbuf_fragment>
  if (vFade < 0.02) discard;
  float dist = length(vView);
  vec3 V = -vView / dist;
  #ifdef SHADOW
    // soft-edged and not black: the sky still lights the shade
    float a = min((1.0 - smoothstep(0.35, 1.0, vY)) * uShadowK * uShadowGain * vT * vFade, 0.92);
    gl_FragColor = vec4(vec3(0.0), a);
    #ifdef USE_LOGDEPTHBUF
      gl_FragDepth = log2(vFragDepth * uShadowDims.w) * logDepthBufFC * 0.5;      // lie on the ground even where it rolls a little
    #endif
  #else
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 alb = pow(vC, vec3(2.2));
  float ndl = max(dot(N, uSun), 0.0), ao = 1.0;
  vec3 extra = vec3(0.0);
  #ifdef GRASS
    // blades: lit from above whatever way they face, dark at the root, pale at the tip, glowing when back-lit
    float top = max(dot(uUp, uSun), 0.0);
    ndl = 0.3 + 0.7 * top;
    ao = 0.34 + 0.66 * vY;
    alb *= mix(vec3(0.7, 0.76, 0.66), vec3(1.3, 1.25, 0.95), vY);
    float back = pow(max(dot(-V, uSun), 0.0), 3.0);
    extra = alb * uSunColor * back * vY * 0.5 * vec3(1.0, 1.0, 0.55);
  #endif
  #ifdef TREE
    if (vT > 1.5) {
      // bark
      float bn = n3(vL * vec3(9.0, 1.6, 9.0));
      alb = vec3(0.058, 0.04, 0.028) * (0.65 + 0.8 * bn);
      ndl = 0.2 + 0.8 * ndl; ao = 0.5 + 0.5 * smoothstep(0.0, 0.35, vY);
    } else {
      // foliage: clumps of lighter and darker leaves, shaded as a soft volume, darker inside and underneath
      float f1 = n3(vL * 1.3), f2 = n3(vL * 4.6 + 3.0), f3 = n3(vL * 15.0 + 8.0);
      float clump = f1 * 0.5 + f2 * 0.32 + f3 * 0.18;
      alb *= 0.45 + 0.95 * clump;
      alb = mix(alb, alb * vec3(1.22, 1.15, 0.75), smoothstep(0.55, 0.8, clump) * 0.5);     // sunlit sprays are yellower
      float wrap = dot(N, uSun) * 0.6 + 0.4;
      ndl = max(wrap, 0.0) * (0.55 + 0.45 * smoothstep(0.3, 0.7, clump));
      ao = (0.42 + 0.58 * vT) * (0.62 + 0.38 * smoothstep(0.1, 0.9, vY)) * (0.7 + 0.3 * f2);
      float back = pow(max(dot(-V, uSun), 0.0), 2.5);
      extra = alb * uSunColor * back * vT * 0.22 * vec3(1.0, 1.0, 0.5);
    }
  #endif
  #ifdef ROCK
    // every kind of rock: mottled, a little bumpy, dark where it meets the ground; then each look in its own way
    float r1 = n3(vL * 2.4), r2 = n3(vL * 7.5 + 2.0), r3 = n3(vL * 23.0 + 5.0);
    vec3 bump = vec3(n3(vL * 6.1 + 11.0), n3(vL * 6.1 + 23.0), n3(vL * 6.1 + 37.0)) - 0.5 + 0.5 * (vec3(n3(vL * 19.0 + 3.0), n3(vL * 19.0 + 13.0), r3) - 0.5);
    float top = dot(N, uUp);                                    // which way the face itself looks, before the bumps
    float foot = smoothstep(0.04, 0.6, vY);
    #if LOOK == 1
      // ice: hard clean facets, rime on what looks up and clear blue ice between; light gets a little way into it,
      // so the shaded side is not black; a broad glint off the faces that catch the sun
      N = normalize(N + bump * 0.1);
      float wrap = dot(N, uSun);
      ndl = max(mix(wrap, wrap * 0.5 + 0.5, 0.45), 0.0);
      float frost = smoothstep(0.35, 0.75, 0.6 * r1 + 0.4 * r2 + 0.3 * top);
      alb = mix(alb * vec3(0.74, 0.88, 1.0), alb * 1.08, frost) * (0.92 + 0.16 * r3) * (0.92 + 0.16 * vT);
      ao = 0.66 + 0.34 * smoothstep(0.04, 0.5, vY);
      float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
      // (the bright ground it stands on lights its sides from below, and the faces turned from the sun glow blue with
      // the light that has come through the block)
      extra = uSunColor * (pow(max(dot(N, normalize(uSun + V)), 0.0), 48.0) * 0.22 * (1.0 - 0.7 * frost) * step(0.0, wrap)) + uAmb * fres * 0.35
        + alb * uSunColor * (max(dot(uUp, uSun), 0.0) * 0.16 * (1.0 - 0.6 * top))
        + alb * vec3(0.66, 0.84, 1.0) * uSunColor * (0.11 * (1.0 - ndl) * smoothstep(0.0, 0.45, dot(uUp, uSun)));
    #elif LOOK == 2
      // clinker: the crust of a lava flow, broken up. Rough, full of gas holes, rusted in patches
      N = normalize(N + bump * 0.95);
      ndl = max(dot(N, uSun), 0.0);
      float ves = smoothstep(0.58, 0.78, n3(vL * 34.0 + 9.0));
      alb *= (0.5 + 0.7 * r1) * (0.72 + 0.4 * r2) * (1.0 - 0.55 * ves);
      alb = mix(alb, alb * vec3(1.5, 0.92, 0.7), 0.6 * smoothstep(0.55, 0.8, n3(vL * 1.3 + 4.0)));
      ao = (0.36 + 0.64 * foot) * (0.6 + 0.4 * smoothstep(0.2, 0.6, r2));
    #elif LOOK == 3
      // slabs: bedded rock split along its beds. Smooth, dusted on top; the beds show as bands on the broken edges
      float side = 1.0 - smoothstep(0.45, 0.8, abs(top));
      N = normalize(N + bump * mix(0.2, 0.45, side));
      ndl = max(dot(N, uSun), 0.0);
      float beds = n3(vec3(vL.y * 26.0 + 1.5 * r1, vL.xz * 0.6));
      alb *= (0.74 + 0.36 * r1) * (0.9 + 0.2 * r3) * mix(0.92 + 0.16 * vT, 0.62 + 0.6 * beds, side);
      alb *= 1.0 + 0.2 * smoothstep(0.5, 0.9, top);
      ao = (0.42 + 0.58 * foot) * mix(1.0, 0.78 + 0.22 * step(0.4, beds), side);
    #elif LOOK == 4
      // ventifacts: faces ground smooth by blown sand, a faint sheen on them, dark varnish above, sand banked at the foot
      N = normalize(N + bump * 0.16);
      ndl = max(dot(N, uSun), 0.0);
      alb *= (0.8 + 0.28 * r1) * (0.94 + 0.12 * r3) * mix(1.2, 0.74, smoothstep(0.15, 0.6, vY));
      ao = 0.5 + 0.5 * smoothstep(0.04, 0.45, vY);
      extra = uSunColor * (pow(max(dot(N, normalize(uSun + V)), 0.0), 14.0) * 0.05 * step(0.0, dot(N, uSun)));
    #elif LOOK == 5
      // fresh broken rock: clean flat fracture faces, one a little lighter than the next, hardly any dust yet
      N = normalize(N + bump * 0.4);
      ndl = max(dot(N, uSun), 0.0);
      alb *= (0.86 + 0.2 * r1) * (0.9 + 0.2 * r3) * (0.84 + 0.32 * vT);
      alb *= 1.0 + 0.1 * smoothstep(0.5, 0.95, top);
      ao = 0.42 + 0.58 * foot;
    #else
      // worn stone: pitted, dusted on top
      N = normalize(N + bump * 0.55);
      ndl = max(dot(N, uSun), 0.0);
      alb *= (0.66 + 0.5 * r1) * (0.8 + 0.3 * r2) * (0.88 + 0.24 * r3);
      alb *= 1.0 + 0.22 * smoothstep(0.35, 0.9, dot(N, uUp));
      ao = (0.42 + 0.58 * foot) * (0.75 + 0.25 * smoothstep(0.25, 0.6, r2));
    #endif
  #endif
  vec3 col = alb * (uSunColor * ndl * ao + uAmb * ao * (0.6 + 0.4 * max(dot(N, uUp), 0.0))) + extra;
  // the same air the terrain is seen through
  vec3 trans;
  vec3 insc = aScatter(uCamU, -V, dist / uRadius, uSun, 3, trans);
  col = col * trans + insc;
  gl_FragColor = vec4(col, 1.0);
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * @returns {{ group, update(camBodyFixed, ctx), drawCalls, instances, triangles, pending, dispose() }}
 * ctx = { sunDir (scene axes), rot (Matrix3 body-fixed → scene), camU (camera, unit-sphere space, scene axes),
 *         sunColor [r,g,b], amb [r,g,b], alt, time, day }
 */
export function createScatter(body, style, { quality = 'high' } = {}) {
  const sc = style.scatter, R = body.radius, faceSize = (Math.PI / 2) * R;
  const group = new THREE.Group(); group.name = 'scatter_' + body.id;
  const dens = quality === 'high' ? 1 : 0.6;
  const bouldersOnly = quality === 'low';      // the lowest setting draws no clutter but the boulders, which are solid
  const home = !!body.sites;
  const layers = [];
  const cellLevel = (size) => Math.max(0, Math.round(Math.log2(faceSize / size)));
  const atmoU = atmoUniforms(body);

  function makeLayer(name, define, geo, cellSize, radius, perTile, range, place, { sway = 0, side = THREE.FrontSide, shadowOf = null, farGeo = null, farDist = 0, stretch = 0, shadowDims = [2.6, 6.5, 0.12, 0.985], shadowGain = 1, look = null, also = [] } = {}) {
    const level = cellLevel(cellSize), span = 2 * radius + 1, slots = span * span + 2 * span;
    perTile = Math.max(1, Math.round(perTile));
    const uniforms = {
      ...atmoU,
      uSun: { value: new THREE.Vector3(1, 0, 0) }, uSunColor: { value: new THREE.Vector3(1, 1, 1) }, uAmb: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3(0, 1, 0) },
      uCamU: { value: new THREE.Vector3(0, 2, 0) }, uRadius: { value: R }, uRange: { value: range }, uTime: { value: 0 }, uSway: { value: sway }, uShadowK: { value: 0.5 }, uShadowGain: { value: shadowGain }, uShadowDims: { value: new THREE.Vector4(...shadowDims) },
    };
    // (look: which rock shading; every material of a layer shares the one set of uniforms)
    const mkMat = (lk) => {
      const opts = { uniforms, defines: lk == null ? { [define]: 1 } : { [define]: 1, LOOK: lk }, vertexShader: VS, fragmentShader: FS, side };
      if (shadowOf) Object.assign(opts, { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
      return new THREE.ShaderMaterial(opts);
    };
    const mat = mkMat(look);
    const cap = shadowOf ? shadowOf.cap : slots * perTile;
    const mk = (geom, nm, material = mat) => {
      const mesh = new THREE.InstancedMesh(geom, material, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (shadowOf) mesh.renderOrder = 1;
      else { mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); mesh.instanceColor.setUsage(THREE.DynamicDrawUsage); }
      mesh.frustumCulled = false; mesh.count = 0; mesh.name = nm;
      group.add(mesh);
      return mesh;
    };
    const mesh = mk(geo, name);
    // a second, simpler model for the same objects beyond farDist (trees: most of a wood is far away)
    const farMesh = farGeo ? mk(farGeo, name + '_far') : null;
    if (shadowOf) shadowOf.shadow = mesh;
    const trisOf = (gm) => (gm.index ? gm.index.count : gm.attributes.position.count) / 3;
    // more models for the same layer (`also`: [{ geo, look }], the second kind of rock): each object says which model
    // it is (kind, kept per tile) and pack sorts it into that model's mesh
    const meshes = [mesh, ...also.map((v, i) => mk(v.geo, name + '_' + (i + 2), mkMat(v.look)))];
    const L = { name, mesh, meshes, meshTris: meshes.map((m) => trisOf(m.geometry)), kind: meshes.length > 1 ? [] : null, farMesh, farDist, farTris: farGeo ? trisOf(farGeo) : 0, shadow: null, lastPack: new THREE.Vector3(), mat, uniforms, level, cells: 2 ** level, radius, perTile, range, place, cap, shadowOf, stretch, tris: trisOf(geo),
      slots: [], tiles: new Map(), anchor: new THREE.Vector3(), anchored: false, data: [], mats: [], cols: [], counts: [], dirty: false, face: -1, seed: layers.length * 7919 + 13 };
    if (!shadowOf) for (let i = 0; i < slots; i++) { L.slots.push(null); L.data.push(new Float64Array(perTile * REC)); L.mats.push(new Float32Array(perTile * 16)); L.cols.push(new Float32Array(perTile * 3)); L.counts.push(0); if (L.kind) L.kind.push(new Uint8Array(perTile)); }
    layers.push(L);
    return L;
  }

  // world-space placement of one object: returns false to leave the slot empty
  const rockColor = sc.rockColor, grassColor = sc.grassColor || [0.3, 0.5, 0.2], dryColor = sc.dryColor || [0.6, 0.56, 0.3];
  const pad = home ? body.sites.pad.dir : null;
  const padCos = Math.cos(3080 / R);
  function ground(u, v, face, out) {
    faceDir(face, u, v, _d);
    if (pad && (_d.x * pad.x + _d.y * pad.y + _d.z * pad.z) > padCos) return false;
    const h = body.terrainHeight(_d, 0);
    if (body.ocean && h < body.seaLevel + 0.4) return false;
    out.x = _d.x; out.y = _d.y; out.z = _d.z; out.h = h;
    return true;
  }
  const g = { x: 0, y: 0, z: 0, h: 0 };
  const isGreen = (c) => c[1] > c[0] * 1.02;

  let boulders = null;
  if (sc.rocks) {
    // the world's kinds of rock (one or two: see ROCK_KINDS), each with its share of the stones and its colour
    const kinds = (sc.rockKinds || [{ kind: 'worn' }]).slice(0, 2).map((k) => ({ ...(ROCK_KINDS[k.kind] || ROCK_KINDS.worn), ...(k.ice ? { look: 1 } : null), color: k.color || rockColor, share: k.share ?? 0.5 }));
    const two = kinds.length > 1;
    const stone = (r, o, big) => {
      const ki = two && r() >= kinds[0].share ? 1 : 0, K = kinds[ki], q = r();
      // sizes: mostly small, a long tail of bigger ones, and among the boulders the odd great block
      const size = K.size * (big ? 0.4 + 1.1 * q * q * q + (r() < 0.04 ? 0.8 + 1.6 * r() : 0) : 0.06 + 0.34 * q * q);
      // (boulders lie part-buried, a different depth each; pebbles just bed into the dust. Deep-set kinds go deeper.)
      const sink = -(big ? K.sink[0] + K.sink[1] * r() : 0.03 + Math.max(0, K.sink[0] - 0.04)) * size;
      // (flat and blocky kinds lie on the slope: its normal from two more heights a stone's width away)
      if (K.lie > (big ? 0 : 1)) {
        const e = Math.max(0.5, 0.7 * size), l1 = Math.hypot(g.z, g.x) || 1, ax = g.z / l1, az = -g.x / l1;      // a = a level direction; b = up × a
        const bx = g.y * az, by = g.z * ax - g.x * az, bz = -g.y * ax, k = e / R;
        _d.x = g.x + ax * k; _d.y = g.y; _d.z = g.z + az * k;
        let l = Math.hypot(_d.x, _d.y, _d.z); _d.x /= l; _d.y /= l; _d.z /= l;
        const sa = Math.max(-1, Math.min(1, (body.terrainHeight(_d, 0) - g.h) / e));
        _d.x = g.x + bx * k; _d.y = g.y + by * k; _d.z = g.z + bz * k;
        l = Math.hypot(_d.x, _d.y, _d.z); _d.x /= l; _d.y /= l; _d.z /= l;
        const sb = Math.max(-1, Math.min(1, (body.terrainHeight(_d, 0) - g.h) / e));
        o.up(g.x - ax * sa - bx * sb, g.y - by * sb, g.z - az * sa - bz * sb);
      } else o.up(0, 0, 0);
      body.surfaceColorAt(g, _rgb);
      const t = 0.72 + 0.45 * r(), w = K.own + 0.3 * r(), c = K.color;      // some stones take the ground's colour, some keep their own
      const yaw = K.wind ? 0.9 + (r() - 0.5) * 1.3 : r() * 6.283;
      o.set(g, size, yaw, (r() - 0.5) * K.tilt, K.squash[0] + K.squash[1] * r(),
        (w * c[0] + (1 - w) * _rgb[0]) * t, (w * c[1] + (1 - w) * _rgb[1]) * t, (w * c[2] + (1 - w) * _rgb[2]) * t, sink, ki);
      return true;
    };
    // (no two stones have the same proportions: see stretch in writeTile)
    const rockLayer = (name, big, cell, per, range) => makeLayer(name, 'ROCK', kinds[0][big ? 'big' : 'small'](), cell, 2, per, range,
      (r, face, u, v, o) => ground(u, v, face, g) && stone(r, o, big),
      { stretch: 0.3, look: kinds[0].look, also: two ? [{ geo: kinds[1][big ? 'big' : 'small'](), look: kinds[1].look }] : [] });
    // boulders: placed by the simulation (core/boulders.js), drawn here. One record per boulder of the cell.
    const field = boulderField(body);
    boulders = rockLayer('boulders', true, 64, field ? field.perCell : Math.max(3, sc.rocks * 1.5), 150);
    if (field && field.cells === boulders.cells) boulders.fill = (face, ix, iy, o, next) => {
      const list = boulderCell(body, face, ix, iy);
      let n = 0;
      for (let i = 0; i < list.length && n < boulders.perTile; i++) {
        const b = list[i], K = kinds[Math.min(b.kind, kinds.length - 1)], c = K.color;
        next(n);
        g.x = b.dx; g.y = b.dy; g.z = b.dz; g.h = b.h;
        o.up(b.ux, b.uy, b.uz);
        body.surfaceColorAt(g, _rgb);
        const t = 0.72 + 0.45 * b.c1, w = K.own + 0.3 * b.c2;      // some stones take the ground's colour, some keep their own
        o.set(g, b.size, b.yaw, b.tilt, b.squash, (w * c[0] + (1 - w) * _rgb[0]) * t, (w * c[1] + (1 - w) * _rgb[1]) * t, (w * c[2] + (1 - w) * _rgb[2]) * t, b.sink, Math.min(b.kind, kinds.length - 1));
        n++;
      }
      return n;
    };
    if (!bouldersOnly) rockLayer('pebbles', false, 20, Math.max(4, sc.rocks * 4.5 * dens), 46);
  }
  if (sc.grass && !bouldersOnly) {
    const tuft = (r, o, s, dryK) => {
      body.surfaceColorAt(g, _rgb);
      if (body.id === 'verda' ? !isGreen(_rgb) : Math.max(_rgb[0], _rgb[1], _rgb[2]) > 0.8) return false;      // on green ground only; not on ice
      // patches of thick and thin growth, and of dry straw among the green
      const k = 5200 * (R / 6.4e5);
      const patch = Math.sin(g.x * k + 3 * Math.sin(g.z * k * 0.43)) * Math.sin(g.y * k * 1.3 + 2 * Math.sin(g.x * k * 0.57)) + 0.5 * Math.sin(g.z * k * 2.9 + g.y * k * 2.2);
      if (r() < 0.25 - 0.3 * patch) return false;
      const t = 0.74 + 0.5 * r(), dry = r() < dryK + 0.18 * Math.max(0, -patch) ? 0.75 : 0.12 * r();
      const cr = grassColor[0] + (dryColor[0] - grassColor[0]) * dry, cg = grassColor[1] + (dryColor[1] - grassColor[1]) * dry, cb = grassColor[2] + (dryColor[2] - grassColor[2]) * dry;
      o.set(g, s * (1 + 0.25 * patch), r() * 6.283, 0, 0.75 + 0.6 * r(), (0.5 * cr + 0.5 * _rgb[0]) * t, (0.5 * cg + 0.5 * _rgb[1]) * t, (0.5 * cb + 0.5 * _rgb[2]) * t, -0.02);
      return true;
    };
    // a thick sward round the camera, then sparser, bigger tufts farther out where single blades cannot be seen
    makeLayer('sward', 'GRASS', grassGeometry(9, 0.14, 0.4, 0.012, 0.024, 0.24, 5), 9, 2, sc.grass * 7.5 * dens, 23, (r, face, u, v, o) => ground(u, v, face, g) && tuft(r, o, 0.6 + 0.8 * r(), 0.1), { sway: 0.05, side: THREE.DoubleSide });
    makeLayer('grass', 'GRASS', grassGeometry(5, 0.24, 0.55, 0.022, 0.04, 0.3, 8), 32, 2, sc.grass * 9 * dens, 80, (r, face, u, v, o) => ground(u, v, face, g) && tuft(r, o, 0.6 + 0.7 * r(), 0.14), { sway: 0.07, side: THREE.DoubleSide });
  }
  if (sc.trees && !bouldersOnly) {
    const noise = (x, y, z) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); };
    const tree = (kind) => (r, face, u, v, o) => {
      if (!ground(u, v, face, g)) return false;
      if (g.h > 1500 || g.h < body.seaLevel + 3) return false;
      body.surfaceColorAt(g, _rgb);
      if (!(_rgb[1] > _rgb[0] * 1.25 && _rgb[1] > _rgb[2] * 1.2)) return false;                       // forests grow on the green
      // clumps: groves a few hundred metres across with clearings between
      const k = 2100;
      const grove = Math.sin(g.x * k * 1.3 + 4 * Math.sin(g.z * k * 0.7)) + Math.sin(g.y * k * 1.7 + 3 * Math.sin(g.x * k * 0.9)) + Math.sin(g.z * k * 2.3);
      if (grove < 0.25 - 1.2 * (_rgb[1] < 0.42 ? 1 : 0) + noise(g.x * 9e4, g.y * 9e4, g.z * 9e4) * 0.4) return false;
      // conifers keep to the higher, cooler ground; broadleaf trees to the low country; they mix in between
      const high = (g.h - 180) / 260 + (noise(g.z * 4e4, g.x * 4e4, g.y * 4e4) - 0.5) * 1.6;
      if ((high > 0) !== (kind === 0)) return false;
      const s = 0.65 + 0.85 * r(), t = 0.75 + 0.5 * r();
      if (kind === 0) o.set(g, s, r() * 6.283, (r() - 0.5) * 0.07, 0.9 + 0.35 * r(), (0.12 + 0.04 * r()) * t, (0.2 + 0.07 * r()) * t, 0.11 * t, -0.15);
      else o.set(g, s * 1.05, r() * 6.283, (r() - 0.5) * 0.1, 0.8 + 0.35 * r(), (0.13 + 0.06 * r()) * t, (0.24 + 0.07 * r()) * t, 0.08 * t, -0.15);
      return true;
    };
    const per = sc.trees * 270 * dens;
    const con = makeLayer('conifers', 'TREE', coniferGeometry(), 320, 2, per, 760, tree(0), { sway: 0.04, side: THREE.DoubleSide, farGeo: coniferGeometry(4, 6, 4), farDist: 150 });
    const bro = makeLayer('broadleaf', 'TREE', groveGeometry(), 320, 2, per, 760, tree(1), { sway: 0.05, farGeo: groveGeometry(true), farDist: 150 });
    makeLayer('shade_conifers', 'SHADOW', shadowGeometry(), 320, 2, per, 760, null, { shadowOf: con });
    makeLayer('shade_broadleaf', 'SHADOW', shadowGeometry(), 320, 2, per, 760, null, { shadowOf: bro });
  }

  // the shade a boulder throws: without it a stone on sunlit ground looks pasted on. (Made last, so the layers before
  // it keep the seeds they always had and every tree and tuft stays where it was.) Darker where there is no air to
  // light the shade.
  if (boulders) makeLayer('shade_boulders', 'SHADOW', shadowGeometry(), 64, 2, boulders.perTile, 150, null, { shadowOf: boulders, shadowDims: [1.15, 0.7, 0.03, 0.997], shadowGain: body.atmo ? 1.15 : 1.6 });

  // an object record: position (3 doubles), size, yaw, tilt, squash, and the way it stands (3: the ground's normal
  // for a rock that lies on the slope, else zeros = straight up); colour kept beside it
  const rec = {
    f: null, i: 0, c: null, ci: 0, k: null,
    set(g, size, yaw, tilt, squash, cr, cg, cb, sink, kind = 0) {
      const f = this.f, i = this.i, rr = R + g.h + sink;
      f[i] = g.x * rr; f[i + 1] = g.y * rr; f[i + 2] = g.z * rr; f[i + 3] = size; f[i + 4] = yaw; f[i + 5] = tilt; f[i + 6] = squash;
      this.c[this.ci] = cr; this.c[this.ci + 1] = cg; this.c[this.ci + 2] = cb;
      if (this.k) this.k[i / REC] = kind;
    },
    up(x, y, z) { const f = this.f, i = this.i; f[i + 7] = x; f[i + 8] = y; f[i + 9] = z; },
  };

  /** matrices of one tile, relative to the layer's anchor */
  function writeTile(L, slot) {
    const f = L.data[slot], out = L.mats[slot], n = L.counts[slot];
    for (let k = 0; k < n; k++) {
      const i = k * REC;
      _p.set(f[i] - L.anchor.x, f[i + 1] - L.anchor.y, f[i + 2] - L.anchor.z);
      if (f[i + 7] || f[i + 8] || f[i + 9]) _up.set(f[i + 7], f[i + 8], f[i + 9]).normalize(); else _up.set(f[i], f[i + 1], f[i + 2]).normalize();
      _q.setFromUnitVectors(Y, _up);
      _q2.setFromAxisAngle(Y, f[i + 4]); _q.multiply(_q2);
      if (f[i + 5]) { _q2.setFromAxisAngle(X, f[i + 5]); _q.multiply(_q2); }
      // (stones: longer one way than the other, by an amount taken from the yaw so it never changes)
      const st = L.stretch ? L.stretch * Math.sin(f[i + 4] * 7.3) : 0;
      _s.set(f[i + 3] * (1 + st), f[i + 3] * f[i + 6], f[i + 3] * (1 - st));
      _m.compose(_p, _q, _s);
      out.set(_m.elements, k * 16);
    }
  }

  function fillTile(L, slot, face, ix, iy) {
    const r = rng(hash(face, ix, iy, body.seed + L.seed));
    const f = L.data[slot], cols = L.cols[slot];
    const u0 = -1 + (2 * ix) / L.cells, du = 2 / L.cells, v0 = -1 + (2 * iy) / L.cells;
    let n = 0;
    if (L.fill) n = L.fill(face, ix, iy, rec, (k) => { rec.f = f; rec.i = k * REC; rec.c = cols; rec.ci = k * 3; rec.k = L.kind && L.kind[slot]; });
    else for (let k = 0; k < L.perTile; k++) {
      rec.f = f; rec.i = n * REC; rec.c = cols; rec.ci = n * 3; rec.k = L.kind && L.kind[slot];
      if (L.place(r, face, u0 + r() * du, v0 + r() * du, rec)) n++;
    }
    L.counts[slot] = n;
    writeTile(L, slot);
  }

  /** pack every live tile's objects to the front of the instance buffers */
  function pack(L, camBF) {
    const mesh = L.mesh, M = mesh.instanceMatrix.array, C = mesh.instanceColor.array;
    const far = L.farMesh, FM = far && far.instanceMatrix.array, FC = far && far.instanceColor.array;
    const SM = L.shadow && L.shadow.instanceMatrix.array;
    const cx = camBF.x - L.anchor.x, cy = camBF.y - L.anchor.y, cz = camBF.z - L.anchor.z, d2 = L.farDist * L.farDist;
    let o = 0, of = 0, os = 0;
    const also = L.kind ? L.meshes : null, at = also && also.map(() => 0);
    for (let s = 0; s < L.slots.length; s++) {
      if (L.slots[s] === null) continue;
      const n = L.counts[s];
      if (!n) continue;
      const ms = L.mats[s], cs = L.cols[s];
      if (SM) { SM.set(ms.subarray(0, n * 16), os * 16); os += n; }
      if (also) {
        // two kinds of rock in the tile: each object goes to the mesh of its kind
        const ks = L.kind[s];
        for (let k = 0; k < n; k++) {
          const j = ks[k], A = also[j].instanceMatrix.array, B = also[j].instanceColor.array, a = at[j]++;
          for (let e = 0; e < 16; e++) A[a * 16 + e] = ms[k * 16 + e];
          B[a * 3] = cs[k * 3]; B[a * 3 + 1] = cs[k * 3 + 1]; B[a * 3 + 2] = cs[k * 3 + 2];
        }
        continue;
      }
      if (!far) { M.set(ms.subarray(0, n * 16), o * 16); C.set(cs.subarray(0, n * 3), o * 3); o += n; continue; }
      for (let k = 0; k < n; k++) {
        const i = k * 16, dx = ms[i + 12] - cx, dy = ms[i + 13] - cy, dz = ms[i + 14] - cz;
        if (dx * dx + dy * dy + dz * dz < d2) { M.set(ms.subarray(i, i + 16), o * 16); C.set(cs.subarray(k * 3, k * 3 + 3), o * 3); o++; }
        else { FM.set(ms.subarray(i, i + 16), of * 16); FC.set(cs.subarray(k * 3, k * 3 + 3), of * 3); of++; }
      }
    }
    mesh.count = o;
    if (also) also.forEach((m, j) => { m.count = at[j]; m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; });
    mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
    if (far) { far.count = of; far.instanceMatrix.needsUpdate = true; far.instanceColor.needsUpdate = true; far.position.copy(mesh.position); far.visible = of > 0; }
    if (L.shadow) { L.shadow.count = os; L.shadow.instanceMatrix.needsUpdate = true; }
    L.lastPack.copy(camBF);
    L.dirty = false;
  }

  function faceUV(dir) { const f = dirToFace(dir.x, dir.y, dir.z); return [f.face, f.u, f.v]; }

  const api = {
    group, drawCalls: layers.length, instances: 0, triangles: 0,
    update(camBF, ctx) {
      const cr = camBF.length(), alt = ctx.alt;
      const show = alt < 2500;
      group.visible = show;
      api.instances = 0; api.triangles = 0; api.drawCalls = 0;
      if (!show) return;
      _up.copy(camBF).divideScalar(cr);
      const [face, u, v] = faceUV(_up);
      const day = ctx.day;
      for (const L of layers) {
        const un = L.uniforms;
        un.uSun.value.copy(ctx.sunDir);
        un.uSunColor.value.set(ctx.sunColor[0], ctx.sunColor[1], ctx.sunColor[2]).multiplyScalar(SUN_SURFACE * day);
        un.uAmb.value.set(ctx.amb[0], ctx.amb[1], ctx.amb[2]).multiplyScalar(Math.max(0.15, day)).addScalar(style.fill != null ? style.fill : 0.05);
        un.uUp.value.copy(_up).applyMatrix3(ctx.rot);
        if (ctx.camU) un.uCamU.value.copy(ctx.camU);
        un.uTime.value = ctx.time;
        un.uShadowK.value = 0.52 * day * Math.min(1, (ctx.sunColor[0] + ctx.sunColor[1] + ctx.sunColor[2]) / 1.5);
        L.mesh.visible = alt < L.range * 2.5;
        for (let j = 1; j < L.meshes.length; j++) L.meshes[j].visible = L.mesh.visible;
        if (!L.mesh.visible) { if (L.farMesh) L.farMesh.visible = false; continue; }
        if (L.shadowOf) {
          const T = L.shadowOf;
          L.mesh.position.copy(T.mesh.position); L.mesh.visible = T.mesh.visible && L.mesh.count > 0 && un.uShadowK.value > 0.01;
          if (L.mesh.visible) { api.drawCalls++; api.triangles += L.mesh.count * L.tris; }
          continue;
        }
        // keep instance coordinates small: re-anchor when the camera has moved far from the anchor
        if (!L.anchored || L.anchor.distanceTo(camBF) > 1500) {
          L.anchor.copy(camBF).setLength(R); L.anchored = true;
          for (const m of L.meshes) m.position.copy(L.anchor);
          for (let s = 0; s < L.slots.length; s++) if (L.slots[s] !== null) writeTile(L, s);
          L.dirty = true;
        }
        if (L.face !== face) { L.face = face; L.tiles.clear(); L.slots.fill(null); L.dirty = true; }
        const ci = Math.floor((u + 1) / 2 * L.cells), cj = Math.floor((v + 1) / 2 * L.cells);
        const want = new Set();
        for (let dj = -L.radius; dj <= L.radius; dj++) for (let di = -L.radius; di <= L.radius; di++) {
          const ix = ci + di, iy = cj + dj;
          if (ix < 0 || iy < 0 || ix >= L.cells || iy >= L.cells) continue;       // (cube-face edges: clutter stops at the seam)
          want.add(ix * 4194304 + iy);
        }
        for (const [key, slot] of L.tiles) if (!want.has(key)) { L.tiles.delete(key); L.slots[slot] = null; L.dirty = true; }
        let budget = 2;
        for (const key of want) {
          if (L.tiles.has(key) || budget <= 0) continue;
          const slot = L.slots.indexOf(null);
          if (slot < 0) break;
          L.slots[slot] = key; L.tiles.set(key, slot);
          fillTile(L, slot, face, Math.floor(key / 4194304), key % 4194304);
          L.dirty = true;
          budget--;
        }
        L.wantCount = want.size;
        if (L.dirty || (L.farMesh && L.lastPack.distanceTo(camBF) > 10)) pack(L, camBF);
        for (let j = 0; j < L.meshes.length; j++) { const m = L.meshes[j]; if (m.count > 0) { api.drawCalls++; api.instances += m.count; api.triangles += m.count * L.meshTris[j]; } }
        if (L.farMesh && L.farMesh.count > 0) { api.drawCalls++; api.instances += L.farMesh.count; api.triangles += L.farMesh.count * L.farTris; }
      }
    },
    /** tiles still to be filled (first frame / screenshots) */
    get pending() { let n = 0; for (const L of layers) if (!L.shadowOf && L.mesh.visible) n += (L.wantCount ?? (2 * L.radius + 1) ** 2) - L.tiles.size; return n; },
    dispose() { for (const L of layers) { for (const m of L.meshes) { m.geometry.dispose(); m.material.dispose(); m.dispose(); } if (L.farMesh) { L.farMesh.geometry.dispose(); L.farMesh.dispose(); } } },
  };
  return api;
}

/** Bounding box of each kind's boulder model, [min x, max x, top y, min z, max z] in model units: the unit test that holds core/boulders.js ROCK_BOX to the models reads it. */
export function rockModelBoxes() {
  const out = {};
  for (const k in ROCK_KINDS) { const g = ROCK_KINDS[k].big(); g.computeBoundingBox(); const b = g.boundingBox; out[k] = [b.min.x, b.max.x, b.max.y, b.min.z, b.max.z]; g.dispose(); }
  return out;
}
/** The placement numbers of each kind (for the same test). */
export function rockKindNumbers() { const out = {}; for (const k in ROCK_KINDS) { const K = ROCK_KINDS[k]; out[k] = { size: K.size, squash: K.squash, tilt: K.tilt, sink: K.sink, lie: K.lie, wind: K.wind }; } return out; }
