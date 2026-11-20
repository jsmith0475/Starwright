// Starwright — terrain chunk geometry (pure maths: no DOM, no three.js; runs on the main thread and in workers).
//
// The planet is a cube-sphere. A chunk is the cell (ix, iy) of the 2^level × 2^level grid on one cube face, meshed
// as an N × N quad grid plus a skirt. Heights come from body.terrainHeight (the same function physics uses), sampled
// one ring wider than the chunk so the normals match across chunk borders.

// face normal n, and the in-plane axes a, b with a × b = n
const FACES = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];
const QP = Math.PI / 4;

/** Unit direction for face coordinates u, v in [−1, 1] (tangent-warped so cells have nearly equal area). */
export function faceDir(face, u, v, out) {
  const f = FACES[face], n = f[0], a = f[1], b = f[2];
  const tu = Math.tan(u * QP), tv = Math.tan(v * QP);
  const x = n[0] + a[0] * tu + b[0] * tv, y = n[1] + a[1] * tu + b[1] * tv, z = n[2] + a[2] * tu + b[2] * tv;
  const k = 1 / Math.sqrt(x * x + y * y + z * z);
  out.x = x * k; out.y = y * k; out.z = z * k;
  return out;
}

const _fo = { face: 0, u: 0, v: 0 };
/** Inverse of faceDir: which face a direction falls on and its (u, v) in [−1, 1]. Writes out.face, out.u, out.v. */
export function dirToFace(x, y, z, out = _fo) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  const face = ax >= ay && ax >= az ? (x > 0 ? 0 : 1) : ay >= az ? (y > 0 ? 2 : 3) : (z > 0 ? 4 : 5);
  const f = FACES[face], n = f[0], a = f[1], b = f[2];
  const dn = x * n[0] + y * n[1] + z * n[2];
  out.face = face;
  out.u = Math.atan((x * a[0] + y * a[1] + z * a[2]) / dn) / QP;
  out.v = Math.atan((x * b[0] + y * b[1] + z * b[2]) / dn) / QP;
  return out;
}

/** Spacing (m) below which chunk vertices carry the exact physics height (terrainHeight at lod 0). */
export const EXACT_SPACING = 3;
/** The lod passed to body.terrainHeight for a chunk whose grid cells are `spacing` metres wide. */
export const chunkLod = (spacing) => (spacing < EXACT_SPACING ? 0 : spacing * 1.2);

/**
 * Height of the drawn chunk surface at grid coordinates (fu, fv) in [0, N]: the same two triangles per cell the
 * index buffer draws, so this is what is on screen, not what the height function says between vertices.
 * `hs` is the chunk's [height, skirt] array; `sea` lifts sea-bed vertices exactly as the vertex shader does.
 */
export function chunkHeightAt(hs, N, fu, fv, sea = -Infinity) {
  const V = N + 1;
  let i = Math.floor(fu), j = Math.floor(fv);
  if (i < 0) i = 0; else if (i > N - 1) i = N - 1;
  if (j < 0) j = 0; else if (j > N - 1) j = N - 1;
  let fx = fu - i, fy = fv - j;
  fx = fx < 0 ? 0 : fx > 1 ? 1 : fx; fy = fy < 0 ? 0 : fy > 1 ? 1 : fy;
  const o = (j * V + i) * 2;
  let a = hs[o], b = hs[o + 2], c = hs[o + V * 2], d = hs[o + V * 2 + 2];
  if (sea > -Infinity) { if (a < sea) a = sea; if (b < sea) b = sea; if (c < sea) c = sea; if (d < sea) d = sea; }
  return fx >= fy ? a + (b - a) * fx + (d - b) * fy : a + (d - c) * fx + (c - a) * fy;
}

/** Vertex count of a chunk with an N × N grid (grid vertices + 4 skirt strips). */
export const chunkVertexCount = (N) => (N + 1) * (N + 1) + 4 * (N + 1);

/** Shared index buffer for every chunk of grid size N. */
export function chunkIndices(N) {
  const V = N + 1, idx = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  // skirts: strip s copies edge vertices; (edge vertex e_i, skirt vertex s_i)
  const base = V * V;
  const edge = [
    (i) => i,                    // v = −1 edge (j = 0), outward is −v
    (i) => N * V + (N - i),      // v = +1 edge, reversed so the winding stays outward
    (i) => (N - i) * V,          // u = −1 edge
    (i) => i * V + N,            // u = +1 edge
  ];
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < N; i++) {
      const e0 = edge[s](i), e1 = edge[s](i + 1), s0 = base + s * V + i, s1 = s0 + 1;
      idx.push(e0, s0, s1, e0, s1, e1);
    }
  }
  return V * V + 4 * V > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
}

const _d = { x: 0, y: 0, z: 0 };
const _rgb = [0, 0, 0];

/**
 * Build one chunk.
 * @returns {{ pos: Float32Array, nrm: Int8Array, col: Uint8Array, hs: Float32Array,
 *             center: [x, y, z], radius, minH, maxH, size, spacing }}
 *   pos   vertex positions relative to `center`, body-fixed axes, metres (skirt vertices sit on their edge vertex)
 *   nrm   normals ×127
 *   col   sRGB colour ×255 + ambient occlusion ×255
 *   hs    [height above the datum, skirt drop] per vertex
 *   center  body-fixed position of the chunk's middle (on the terrain), in double precision
 */
export function buildChunk(body, face, level, ix, iy, N) {
  const R = body.radius, V = N + 1, G = N + 3;
  const cells = 2 ** level, du = 2 / (cells * N);
  const u0 = -1 + (2 * ix) / cells, v0 = -1 + (2 * iy) / cells;
  const size = (Math.PI / 2) * R / cells, spacing = size / N;
  // fine chunks carry the exact physics height at every vertex, so what stands on the ground looks like it does
  const lod = chunkLod(spacing);
  // positions on the padded grid, double precision
  const P = new Float64Array(G * G * 3), H = new Float64Array(G * G);
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      faceDir(face, u0 + (i - 1) * du, v0 + (j - 1) * du, _d);
      const h = body.terrainHeight(_d, lod), r = R + h, k = (j * G + i) * 3;
      P[k] = _d.x * r; P[k + 1] = _d.y * r; P[k + 2] = _d.z * r;
      H[j * G + i] = h;
      if (h < minH) minH = h; if (h > maxH) maxH = h;
    }
  }
  const cI = ((N >> 1) + 1) * G + (N >> 1) + 1;
  const cx = P[cI * 3], cy = P[cI * 3 + 1], cz = P[cI * 3 + 2];
  const nV = chunkVertexCount(N);
  const pos = new Float32Array(nV * 3), nrm = new Int8Array(nV * 4), col = new Uint8Array(nV * 4), hs = new Float32Array(nV * 2);
  const sea = body.ocean ? body.seaLevel : -Infinity;
  let rad2 = 0;
  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const g = (j + 1) * G + i + 1, k = g * 3, o = j * V + i;
      const px = P[k], py = P[k + 1], pz = P[k + 2];
      const x = px - cx, y = py - cy, z = pz - cz;
      pos[o * 3] = x; pos[o * 3 + 1] = y; pos[o * 3 + 2] = z;
      const d2 = x * x + y * y + z * z; if (d2 > rad2) rad2 = d2;
      // normal from the neighbours (central differences on the padded grid)
      const e = k + 3, w = k - 3, n = k + G * 3, s = k - G * 3;
      const ax = P[e] - P[w], ay = P[e + 1] - P[w + 1], az = P[e + 2] - P[w + 2];
      const bx = P[n] - P[s], by = P[n + 1] - P[s + 1], bz = P[n + 2] - P[s + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const nl = 127 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
      nrm[o * 4] = Math.round(nx * nl); nrm[o * 4 + 1] = Math.round(ny * nl); nrm[o * 4 + 2] = Math.round(nz * nl);
      // ambient occlusion from concavity: how far the point sits below the mean of its neighbours
      const h = H[g];
      const lap = (H[g + 1] + H[g - 1] + H[g + G] + H[g - G] + 0.7 * (H[g + G + 1] + H[g + G - 1] + H[g - G + 1] + H[g - G - 1])) / 6.8 - h;
      let ao = 1 - 1.6 * lap / spacing;
      ao = ao < 0.35 ? 0.35 : ao > 1 ? 1 : ao;
      const il = 1 / Math.sqrt(px * px + py * py + pz * pz);
      _d.x = px * il; _d.y = py * il; _d.z = pz * il;
      body.surfaceColorAt(_d, _rgb);
      col[o * 4] = _rgb[0] * 255; col[o * 4 + 1] = _rgb[1] * 255; col[o * 4 + 2] = _rgb[2] * 255; col[o * 4 + 3] = ao * 255;
      hs[o * 2] = h; hs[o * 2 + 1] = 0;
    }
  }
  // skirts: copies of the edge vertices, dropped in the vertex shader
  const drop = Math.max(spacing * 2.5, size * 0.03) + (maxH - minH) * 0.1;
  const edge = [(i) => i, (i) => N * V + (N - i), (i) => (N - i) * V, (i) => i * V + N];
  let o = V * V;
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < V; i++, o++) {
      const e = edge[s](i);
      pos[o * 3] = pos[e * 3]; pos[o * 3 + 1] = pos[e * 3 + 1]; pos[o * 3 + 2] = pos[e * 3 + 2];
      nrm[o * 4] = nrm[e * 4]; nrm[o * 4 + 1] = nrm[e * 4 + 1]; nrm[o * 4 + 2] = nrm[e * 4 + 2];
      col[o * 4] = col[e * 4]; col[o * 4 + 1] = col[e * 4 + 1]; col[o * 4 + 2] = col[e * 4 + 2]; col[o * 4 + 3] = col[e * 4 + 3];
      hs[o * 2] = hs[e * 2]; hs[o * 2 + 1] = drop;
    }
  }
  // the vertex shader lifts the sea bed to the sea surface: the culling sphere has to reach that far, or a chunk
  // of deep water is culled by its bed while its surface is in view
  const lift = sea > minH ? sea - minH : 0;
  if (sea > minH) { if (sea > maxH) maxH = sea; }
  return { pos, nrm, col, hs, center: [cx, cy, cz], radius: Math.sqrt(rad2) + drop + lift, minH, maxH, size, spacing };
}
