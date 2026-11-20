// Starwright — textures for the vegetation, painted on canvases at load and cached (no image files anywhere).
//
//   leafAtlas(size)   → THREE.Texture: sprays of leaves / needled boughs / a palm frond, one per cell of treegen.ATLAS
//                       (rgb = leaf colour, a = cut-out). Transparent texels carry the leaf colour, so mip levels and
//                       filtering never drag a dark fringe into the edges.
//   barkTextures()    → [{ map, normalMap }] for bark kinds 0 (furrowed), 1 (birch), 2 (palm): tile both ways
//   blobTexture()     → a soft irregular shadow blot (white = no change, for multiply blending)
import * as THREE from '../lib/three.module.min.js';
import { ATLAS } from './treegen.js';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const cv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
/** tileable value noise n(x, y, period) */
function noise(seed) {
  const r = rng(seed), N = 64, t = new Float32Array(N * N);
  for (let i = 0; i < t.length; i++) t[i] = r();
  const at = (x, y, p, q) => t[((((y % q) + q) % q) % N) * N + ((((x % p) + p) % p) % N)];
  return (x, y, p = N, q = p) => { const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy); return (at(xi, yi, p, q) * (1 - sx) + at(xi + 1, yi, p, q) * sx) * (1 - sy) + (at(xi, yi + 1, p, q) * (1 - sx) + at(xi + 1, yi + 1, p, q) * sx) * sy; };
}

// one leaf: a pointed blade from (0,0) along +x, in the current transform
function leafPath(g, len, wid, lobes = 0, r = null) {
  g.beginPath(); g.moveTo(0, 0);
  if (!lobes) { g.bezierCurveTo(len * 0.25, -wid, len * 0.7, -wid * 0.8, len, 0); g.bezierCurveTo(len * 0.7, wid * 0.8, len * 0.25, wid, 0, 0); }
  else {
    const n = lobes * 2 + 1, pts = [];
    for (let s = -1; s <= 1; s += 2) for (let i = 0; i <= n; i++) { const t = s < 0 ? i / n : 1 - i / n, w = Math.sin(Math.PI * Math.pow(t, 0.8)) * wid * (i % 2 ? 1.0 : 0.55 + 0.1 * (r ? r() : 0.5)); pts.push([t * len, s * w]); }
    for (const p of pts) g.lineTo(p[0], p[1]);
  }
  g.closePath();
}
function drawLeaf(g, x, y, ang, len, wid, col, lobes, r) {
  g.save(); g.translate(x, y); g.rotate(ang);
  g.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`; leafPath(g, len, wid, lobes, r); g.fill();
  // half of the blade catches less light; a pale midrib
  g.fillStyle = 'rgba(0,0,0,0.13)'; g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(len * 0.25, wid, len * 0.7, wid * 0.8, len, 0); g.closePath(); g.fill();
  g.strokeStyle = `rgba(${Math.min(255, col[0] + 46) | 0},${Math.min(255, col[1] + 40) | 0},${col[2] + 16 | 0},0.6)`; g.lineWidth = Math.max(0.6, wid * 0.09); g.beginPath(); g.moveTo(0, 0); g.lineTo(len * 0.94, 0); g.stroke();
  g.restore();
}
const green = (r, light, warm = 0) => { const k = 0.62 + 0.62 * light + (r() - 0.5) * 0.14; return [(68 + 26 * warm + 18 * r()) * k, (94 + 10 * r()) * k, (42 - 8 * warm + 10 * r()) * k]; };

/** a broadleaf spray: twigs from the bottom centre, leaves in layers (shaded ones first, sunlit ones on top) */
function spray(g, S, seed, { leafLen, leafWid, count, lobes = 0, warm = 0, fill = 0.44, twigs = 5, droop = 0 }) {
  const r = rng(seed), tips = [];
  g.lineCap = 'round';
  for (let t = 0; t < twigs; t++) {
    let x = S * 0.5, y = S * 0.98, a = -Math.PI / 2 + (t - (twigs - 1) / 2) * (1.9 / twigs) + (r() - 0.5) * 0.3;
    const segs = 7, L = S * (0.62 + 0.3 * r()) / segs;
    g.strokeStyle = 'rgb(58,46,34)'; g.lineWidth = S * 0.012 * (1 - t * 0.04);
    g.beginPath(); g.moveTo(x, y);
    for (let i = 0; i < segs; i++) { a += (r() - 0.5) * 0.5 + droop * 0.08 * Math.sign(Math.cos(a) || 1); x += Math.cos(a) * L; y += Math.sin(a) * L; g.lineTo(x, y); tips.push([x, y, a, i / segs]); }
    g.stroke();
  }
  for (let layer = 0; layer < 3; layer++) {
    const n = Math.round(count * [0.4, 0.35, 0.25][layer]);
    for (let i = 0; i < n; i++) {
      const tp = tips[Math.floor(r() * tips.length)], rad = S * fill * (0.2 + 0.5 * r()) * (0.35 + tp[3] * 0.4);
      const an = r() * 6.283, x = tp[0] + Math.cos(an) * rad * 0.5, y = tp[1] + Math.sin(an) * rad * 0.5;
      if (Math.hypot(x - S / 2, y - S * 0.5) > S * 0.47) continue;
      const k = 0.75 + 0.5 * r();
      drawLeaf(g, x, y, tp[2] + (r() - 0.5) * 2.6 + droop * 1.2, leafLen * S * k, leafWid * S * k, green(r, layer * 0.36 + 0.16 * r(), warm), lobes, r);
    }
  }
}
function bough(g, S, seed) {
  // a spruce bough: a rib with side twigs, each fringed with short needles; gaps between the twigs let the sky through
  const r = rng(seed);
  g.lineCap = 'round';
  const twig = (x0, y0, a, len, depth) => {
    const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len;
    const n = Math.round(len / (S * 0.0075));
    for (let i = 0; i < n; i++) {
      const t = i / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t, c = green(r, 0.15 + 0.75 * r() * (0.4 + 0.6 * t), -0.6), nl = S * (0.024 + 0.014 * r()) * (1 - 0.35 * t);
      g.strokeStyle = `rgb(${c[0] * 0.78 | 0},${c[1] * 0.95 | 0},${c[2] * 1.12 | 0})`; g.lineWidth = S * 0.0068;
      for (const s of [-1, 1]) { const na = a + s * (0.9 + 0.4 * r()); g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(na) * nl, y + Math.sin(na) * nl); g.stroke(); }
    }
    g.strokeStyle = 'rgb(66,50,36)'; g.lineWidth = S * 0.006 * (depth ? 1 : 2); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    if (depth) return;
    const m = Math.round(len / (S * 0.082));
    for (let i = 1; i < m; i++) { const t = i / m, w = Math.sin(Math.PI * Math.pow(t, 0.7)) * 0.9 + 0.12; for (const s of [-1, 1]) twig(x0 + (x1 - x0) * (t + 0.03 * s), y0 + (y1 - y0) * (t + 0.03 * s), a + s * (0.7 + 0.25 * r()), S * 0.4 * w * (0.7 + 0.5 * r()), 1); }
  };
  twig(S * 0.5, S * 0.99, -Math.PI / 2, S * 0.93, 0);
}
function pineTuft(g, S, seed) {
  // long needles bursting from the ends of a forked shoot
  const r = rng(seed);
  g.lineCap = 'round';
  const burst = (x, y, a, len, n) => { for (let i = 0; i < n; i++) { const c = green(r, 0.2 + 0.7 * (i / n) * (0.5 + 0.5 * r()), -0.2), na = a + (r() - 0.5) * 2.4, l = len * (0.6 + 0.5 * r()); g.strokeStyle = `rgb(${c[0] * 0.9 | 0},${c[1] * 0.98 | 0},${c[2] * 1.02 | 0})`; g.lineWidth = S * 0.0062; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(na) * l * 0.5, y + Math.sin(na) * l * 0.5 + l * 0.04, x + Math.cos(na) * l, y + Math.sin(na) * l + l * 0.1); g.stroke(); } };
  g.strokeStyle = 'rgb(84,58,40)'; g.lineWidth = S * 0.016;
  const forks = [[0.5, 0.5, -1.57], [0.27, 0.62, -2.4], [0.73, 0.6, -0.75], [0.38, 0.3, -1.9], [0.64, 0.28, -1.2]];
  for (const [fx, fy] of forks) { g.beginPath(); g.moveTo(S * 0.5, S * 0.99); g.quadraticCurveTo(S * 0.5, S * 0.75, S * fx, S * fy); g.stroke(); }
  for (const [fx, fy, a] of forks) burst(S * fx, S * fy, a, S * 0.24, 110);
}
function frond(g, S, seed) {
  // a palm frond: rib up the middle, leaflets either side, longest at mid length, gaps between them near the tip
  const r = rng(seed);
  g.lineCap = 'round';
  const n = 46;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), y = S * (0.97 - 0.93 * t), len = S * 0.45 * Math.pow(Math.sin(Math.PI * (0.12 + 0.86 * t)), 0.7) * (0.85 + 0.2 * r());
    for (const s of [-1, 1]) {
      const c = green(r, 0.25 + 0.5 * r(), 0.5), a = -Math.PI / 2 + s * (1.25 - 0.55 * t) + (r() - 0.5) * 0.12;
      g.save(); g.translate(S * 0.5, y); g.rotate(a);
      g.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; g.beginPath(); g.moveTo(0, -S * 0.012); g.quadraticCurveTo(len * 0.5, -S * 0.02, len, 0); g.quadraticCurveTo(len * 0.5, S * 0.016, 0, S * 0.012); g.fill();
      g.strokeStyle = 'rgba(190,210,120,0.45)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, 0); g.lineTo(len * 0.95, 0); g.stroke();
      g.restore();
    }
  }
  g.strokeStyle = 'rgb(120,118,60)'; g.lineWidth = S * 0.016; g.beginPath(); g.moveTo(S * 0.5, S); g.lineTo(S * 0.5, S * 0.05); g.stroke();
}

let ATLAS_TEX = {};
export function leafAtlas(size = 2048) {
  if (ATLAS_TEX[size]) return ATLAS_TEX[size];
  const S = size / ATLAS.cols, W = size, Hh = S * ATLAS.rows, c = cv(W, Hh), g = c.getContext('2d');
  const cell = (id, fn) => { const cx = id % ATLAS.cols, cy = Math.floor(id / ATLAS.cols); g.save(); g.translate(cx * S, cy * S); g.beginPath(); g.rect(1, 1, S - 2, S - 2); g.clip(); fn(); g.restore(); };
  const C = ATLAS.cells;
  cell(C.oak, () => spray(g, S, 11, { leafLen: 0.105, leafWid: 0.036, count: 300, lobes: 3 }));
  cell(C.maple, () => spray(g, S, 23, { leafLen: 0.1, leafWid: 0.055, count: 290, lobes: 2, fill: 0.46 }));
  cell(C.birch, () => spray(g, S, 37, { leafLen: 0.062, leafWid: 0.03, count: 300, warm: 0.5, fill: 0.5, twigs: 6, droop: 1 }));
  cell(C.spruce, () => bough(g, S, 41));
  cell(C.pine, () => pineTuft(g, S, 53));
  cell(C.palm, () => frond(g, S, 61));
  cell(C.bush, () => spray(g, S, 71, { leafLen: 0.085, leafWid: 0.034, count: 380, fill: 0.5, twigs: 7, warm: 0.2 }));
  cell(C.solid, () => { g.fillStyle = '#fff'; g.fillRect(0, 0, S, S); });
  // un-premultiplied pixels, flipped to v-up; transparent texels take the foliage colour (no dark fringes)
  const src = g.getImageData(0, 0, W, Hh).data, out = new Uint8Array(W * Hh * 4);
  // (average leaf colour per cell)
  const avg = [];
  for (let id = 0; id < ATLAS.cols * ATLAS.rows; id++) {
    const x0 = (id % ATLAS.cols) * S, y0 = Math.floor(id / ATLAS.cols) * S; let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = y0; y < y0 + S; y += 3) for (let x = x0; x < x0 + S; x += 3) { const o = (y * W + x) * 4; if (src[o + 3] > 200) { sr += src[o]; sg += src[o + 1]; sb += src[o + 2]; n++; } }
    avg.push(n ? [sr / n, sg / n, sb / n] : [60, 90, 40]);
  }
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, d = ((Hh - 1 - y) * W + x) * 4, a = src[o + 3];
    if (a < 8) { const m = avg[Math.floor(y / S) * ATLAS.cols + Math.floor(x / S)]; out[d] = m[0]; out[d + 1] = m[1]; out[d + 2] = m[2]; out[d + 3] = 0; }
    else { out[d] = src[o]; out[d + 1] = src[o + 1]; out[d + 2] = src[o + 2]; out[d + 3] = a; }
  }
  const t = new THREE.DataTexture(out, W, Hh, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; t.name = 'leafAtlas';
  t.userData.average = avg;
  return (ATLAS_TEX[size] = t);
}

function normalFrom(height, w, h, strength) {
  const out = new Uint8Array(w * h * 4), H = (x, y) => height[(((y % h) + h) % h) * w + (((x % w) + w) % w)];
  for (let y = 0, o = 0; y < h; y++) for (let x = 0; x < w; x++, o += 4) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength, l = 1 / Math.hypot(dx, dy, 1);
    out[o] = (-dx * l * 0.5 + 0.5) * 255; out[o + 1] = (-dy * l * 0.5 + 0.5) * 255; out[o + 2] = (l * 0.5 + 0.5) * 255; out[o + 3] = 255;
  }
  return out;
}
let BARK = null;
export function barkTextures() {
  if (BARK) return BARK;
  const W = 256, H = 512, n1 = noise(301), n2 = noise(302), r = rng(9);
  const fb = (n, x, y, px, py, oct) => { let s = 0, a = 0.5, t = 0; for (let i = 0; i < oct; i++) { s += a * n(x * px, y * py, px, py); t += a; a *= 0.5; px *= 2; py *= 2; } return s / t; };
  const make = (fn) => {
    const col = new Uint8Array(W * H * 4), hgt = new Float32Array(W * H);
    for (let y = 0, o = 0; y < H; y++) for (let x = 0; x < W; x++, o += 4) { const v = fn(x / W, y / H); col[o] = v[0]; col[o + 1] = v[1]; col[o + 2] = v[2]; col[o + 3] = 255; hgt[y * W + x] = v[3]; }
    const T = (data, srgb) => { const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4; t.needsUpdate = true; return t; };
    return { map: T(col, true), normalMap: T(normalFrom(hgt, W, H, 5), false) };
  };
  // (the period of every octave divides the lattice, so the textures tile)
  const furrowed = make((u, v) => {
    const warp = fb(n2, u, v, 4, 4, 3) * 0.16, ridge = 1 - Math.abs(2 * fb(n1, u + warp, v, 8, 2, 4) - 1), plate = fb(n2, u, v, 16, 8, 3);
    const h = Math.pow(ridge, 1.6) * 0.8 + plate * 0.2, k = 0.42 + 0.75 * h;
    return [112 * k + 14 * plate, 96 * k + 10 * plate, 80 * k, h];
  });
  const birch = make((u, v) => {
    const band = fb(n1, u, v, 2, 32, 3), mark = Math.max(0, fb(n2, u, v, 4, 16, 3) - 0.6) * 5, scar = Math.max(0, fb(n1, u + 0.3, v + 0.1, 4, 4, 3) - 0.66) * 7;
    const dark = Math.min(1, mark * (band > 0.5 ? 1 : 0.4) + scar), k = 1 - 0.82 * dark;
    return [(218 + 26 * band) * k, (214 + 24 * band) * k, (202 + 20 * band) * k, 0.6 - 0.5 * dark + 0.1 * band];
  });
  const palm = make((u, v) => {
    const ring = (v * 16 + 0.25 * fb(n1, u, v, 8, 16, 2)) % 1, edge = Math.pow(1 - Math.abs(ring * 2 - 1), 3), fib = fb(n2, u, v, 32, 4, 2);
    const k = 0.55 + 0.4 * (1 - edge) + 0.2 * fib;
    return [138 * k, 118 * k, 92 * k, (1 - edge) * 0.8 + fib * 0.2];
  });
  void r;
  return (BARK = [furrowed, birch, palm]);
}

let BLOB = null;
export function blobTexture() {
  if (BLOB) return BLOB;
  const S = 128, c = cv(S, S), g = c.getContext('2d'), r = rng(5);
  g.fillStyle = '#fff'; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 26; i++) {
    const a = r() * 6.283, d = S * 0.2 * Math.sqrt(r()), x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d, rad = S * (0.14 + 0.14 * r());
    const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, 'rgba(150,150,150,1)'); gr.addColorStop(0.55, 'rgba(200,200,200,1)'); gr.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.name = 'treeBlob';
  return (BLOB = t);
}
