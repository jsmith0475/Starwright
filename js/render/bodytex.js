// Starwright — baked globe maps for a body (colour + water mask, relief normals + height + glow, clouds, rings).
// A tiny map is baked at once so there is always something to show; sharper ones arrive from the worker pool and
// are swapped in place (the texture objects stay the same, so materials never need to be told).
//
//   const maps = getBodyMaps(body);            // { color, normal, clouds|null, ring|null, level, pending }
//   requestBodyMaps(body, 'high' | 'medium' | 'low') → Promise (resolves when that size is in the textures)
import * as THREE from '../lib/three.module.min.js';
import { getPool } from './workpool.js';
import { bakeRows, bakeCloudRows } from './bodybake.js';
import { styleOf } from './worldstyle.js';
import { makeRandom } from '../core/noise.js';
import { perf } from '../perf.js';

export const MAP_SIZES = { tiny: [64, 32], low: [512, 256], medium: [1024, 512], high: [2048, 1024] };
const ORDER = ['tiny', 'low', 'medium', 'high'];
const cache = new Map();

function dataTex(data, w, h, srgb, format = THREE.RGBAFormat) {
  const t = new THREE.DataTexture(data, w, h, format, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 8; t.flipY = false; t.unpackAlignment = 1;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
const nextFrame = () => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));
let swapQueue = Promise.resolve();
/** swap() in turn: resolves one animation frame after this texture was handed over, and the next one waits for that */
function swapNext(tex, data, w, h) {
  const p = swapQueue.then(() => { swap(tex, data, w, h); return nextFrame(); });
  swapQueue = p.catch(() => {});
  return p;
}
function swap(tex, data, w, h) {
  perf.count('textureSwaps');
  tex.dispose();
  tex.image = { data, width: w, height: h };
  tex.needsUpdate = true;
}

function ringTexture(body) {
  const st = styleOf(body.id).ring;
  if (!body.ring || !st) return null;
  const W = 1024, data = new Uint8Array(W * 4), rnd = makeRandom(st.seed * 977 + 5);
  // density: broad bands, fine ringlets and a few clean gaps
  const gaps = []; for (let i = 0; i < 5; i++) gaps.push([0.1 + 0.8 * rnd(), 0.004 + 0.02 * rnd() * rnd()]);
  const ph = [rnd() * 9, rnd() * 9, rnd() * 9, rnd() * 9];
  for (let i = 0; i < W; i++) {
    const x = i / (W - 1);
    let d = 0.55 + 0.25 * Math.sin(x * 9 + ph[0]) + 0.16 * Math.sin(x * 37 + ph[1]) + 0.1 * Math.sin(x * 131 + ph[2]) + 0.08 * Math.sin(x * 409 + ph[3]);
    d *= Math.min(1, x / 0.04) * Math.min(1, (1 - x) / 0.03);         // soft inner and outer edges
    if (x > 0.36 && x < 0.44) d *= 0.35;                                // a dusty inner division
    for (const [g, w] of gaps) { const k = Math.abs(x - g) / w; if (k < 1) d *= k * k; }
    d = Math.max(0, Math.min(1, d));
    const c0 = st.colors[0], c1 = st.colors[1], c2 = st.colors[2];
    const t = 0.5 + 0.5 * Math.sin(x * 23 + ph[1]), u = Math.max(0, Math.sin(x * 5 + ph[2]));
    for (let k = 0; k < 3; k++) data[i * 4 + k] = 255 * ((c0[k] * (1 - t) + c1[k] * t) * (1 - 0.5 * u) + c2[k] * 0.5 * u);
    data[i * 4 + 3] = 255 * d;
  }
  const t = dataTex(data, W, 1, true);
  t.wrapS = THREE.ClampToEdgeWrapping;
  return t;
}

/** The (shared, cached) map set of a body. Creating it bakes a 64 × 32 placeholder synchronously (≈ 10 ms). */
export function getBodyMaps(body) {
  let e = cache.get(body.id);
  if (e) return e;
  const [w, h] = MAP_SIZES.tiny;
  const r = bakeRows(body, w, h, 0, h);
  const st = styleOf(body.id);
  e = {
    body, level: 'tiny', want: 'tiny', pending: 0, promises: {},
    color: dataTex(r.color, w, h, true), normal: dataTex(r.normal, w, h, false),
    clouds: st.clouds ? dataTex(bakeCloudRows(body, w, h, 0, h), w, h, false, THREE.RedFormat) : null,
    ring: ringTexture(body),
  };
  cache.set(body.id, e);
  return e;
}

function bakeLevel(e, level, priority) {
  const [w, h] = MAP_SIZES[level], pool = getPool(), body = e.body;
  const color = new Uint8Array(w * h * 4), normal = new Uint8Array(w * h * 4);
  const clouds = e.clouds ? new Uint8Array(w * h) : null;
  const batch = Math.max(4, Math.round(24000 / w));
  const jobs = [];
  for (let row = 0; row < h; row += batch) {
    const row1 = Math.min(h, row + batch);
    jobs.push(pool.run({ kind: 'bake', body: body.id, width: w, height: h, row0: row, row1 }, priority + row / h).promise.then((res) => {
      if (!res) return;
      color.set(res.rows.color, row * w * 4); normal.set(res.rows.normal, row * w * 4);
    }));
    if (clouds) jobs.push(pool.run({ kind: 'clouds', body: body.id, width: w, height: h, row0: row, row1 }, priority + 0.5 + row / h).promise.then((res) => {
      if (res) clouds.set(res.rows, row * w);
    }));
  }
  e.pending++;
  // One texture per frame: each swap is an upload of up to 8 MB plus its mip chain inside the next frame that
  // draws the body; three in the same frame made one long frame out of what can be three unnoticeable ones.
  // (One per frame over ALL bodies: in the map a dozen worlds finish their bakes within a few frames of each other.)
  return Promise.all(jobs).then(async () => {
    try {
      if (ORDER.indexOf(level) <= ORDER.indexOf(e.level)) return e;     // a sharper one already landed
      await swapNext(e.color, color, w, h);
      await swapNext(e.normal, normal, w, h);
      if (clouds) await swapNext(e.clouds, clouds, w, h);
      if (ORDER.indexOf(level) > ORDER.indexOf(e.level)) e.level = level;
      return e;
    } finally { e.pending--; }
  });
}

/**
 * Ask for maps of at least the given size. Bakes 512 × 256 first (well under a second in a worker) and then the
 * requested size. `urgent` puts the work ahead of other bodies' bakes.
 */
export function requestBodyMaps(body, level = 'high', urgent = false) {
  const e = getBodyMaps(body);
  if (!MAP_SIZES[level]) level = 'high';
  if (ORDER.indexOf(level) <= ORDER.indexOf(e.level)) return Promise.resolve(e);
  if (e.promises[level]) return e.promises[level];
  const base = urgent ? 2e5 : 1e6;
  let p = e.promises.low || (e.promises.low = bakeLevel(e, 'low', base));
  if (level !== 'low') p = e.promises[level] = p.then(() => bakeLevel(e, level, base + 10));
  return p;
}

/** Number of bake jobs still running across all bodies. */
export function bakesPending() { let n = 0; for (const e of cache.values()) n += e.pending; return n; }

export function disposeBodyMaps() {
  for (const e of cache.values()) { e.color.dispose(); e.normal.dispose(); if (e.clouds) e.clouds.dispose(); if (e.ring) e.ring.dispose(); }
  cache.clear();
}
