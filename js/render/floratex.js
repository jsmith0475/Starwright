// Starwright — textures for the vegetation, composed on canvases at load and cached.
//
// The leaves and the bark of the mesh trees come from public-domain (CC0) scans in media/flora/ (built by
// tools/flora_assets.py; credits in the README): single cut-out leaves and conifer boughs on one sheet, and tiling
// bark. They are arranged here into sprays, one per cell of the atlas. When the files cannot be loaded (or have not
// been asked for), everything is painted in code instead, as before: the game never depends on them.
//
//   loadFloraAssets() → Promise (never rejects): fetch the scans once; call before the first leafAtlas()
//   floraAssets       { leaves: canvas | null, bark: { furrowed, scaly, fir: { map, normalMap } }, photo: bool }
//
//   leafAtlas(size)   → THREE.Texture: sprays of leaves / needled boughs / a palm frond, one per cell of treegen.ATLAS
//                       (rgb = leaf colour, a = cut-out). Transparent texels carry the leaf colour, so mip levels and
//                       filtering never drag a dark fringe into the edges; the mip levels are made here and keep the
//                       cover of the full-size picture (crowns do not thin out with distance).
//                       .userData.tilt: a second texture of the same layout: rg = which way each leaf leans
//                       (in the card's own axes), b = 1 on the leaves in front (they catch the sun's glint)
//   barkTextures()    → [{ map, normalMap }] for bark kinds 0 (furrowed), 1 (birch), 2 (palm), 3 (scaly), 4 (fir): tile both ways
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

// ---- scans --------------------------------------------------------------------------------------------------
const SHEET = { cell: 128, w: 1024, h: 896,
  // first cell (col, row), how many, cell size in cells: see tools/flora_assets.py
  oak: [0, 0, 6, 1, 1], maple: [6, 0, 4, 1, 1], birch: [2, 1, 6, 1, 1], shrub: [0, 2, 6, 1, 1], bough: [0, 3, 3, 4, 2] };
export const floraAssets = { leaves: null, variants: null, bark: {}, photo: false, promise: null };
function loadImage(url) {
  return new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = url; });
}
/** Fetch the scans (once). Resolves when they are in, or have failed: then the painted textures are used. */
export function loadFloraAssets(base = new URL('../../media/flora/', import.meta.url).href) {
  if (floraAssets.promise) return floraAssets.promise;
  if (typeof Image === 'undefined') return (floraAssets.promise = Promise.resolve(floraAssets));
  const kinds = ['furrowed', 'scaly', 'fir'];
  floraAssets.promise = Promise.all([loadImage(base + 'leaves.webp'), ...kinds.flatMap(k => [loadImage(base + `bark_${k}.jpg`), loadImage(base + `bark_${k}_n.jpg`)])]).then(([leaves, ...barks]) => {
    try {
      if (leaves && leaves.width === SHEET.w && leaves.height === SHEET.h) { const c = cv(SHEET.w, SHEET.h); c.getContext('2d').drawImage(leaves, 0, 0); floraAssets.leaves = c; floraAssets.photo = true; }
      kinds.forEach((k, i) => {
        const a = barks[i * 2], n = barks[i * 2 + 1];
        if (!a || !n) return;
        const T = (im, srgb) => { const t = new THREE.Texture(im); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4; t.needsUpdate = true; return t; };
        floraAssets.bark[k] = { map: T(a, true), normalMap: T(n, false), photo: true };
      });
    } catch (err) { console.warn('[flora] the scanned textures could not be used:', err && err.message); floraAssets.leaves = null; floraAssets.photo = false; }
    return floraAssets;
  });
  return floraAssets.promise;
}
/** the sheet in several lights: [r, g, b] multipliers → canvases (made once) */
const TONES = [[0.3, 0.33, 0.32], [0.45, 0.5, 0.44], [0.62, 0.66, 0.54], [0.78, 0.8, 0.62], [0.9, 0.92, 0.7], [1.0, 0.96, 0.66], [1.0, 1.0, 0.8]];
function toned() {
  if (floraAssets.variants) return floraAssets.variants;
  return (floraAssets.variants = TONES.map(t => {
    const c = cv(SHEET.w, SHEET.h), g = c.getContext('2d');
    g.drawImage(floraAssets.leaves, 0, 0);
    g.globalCompositeOperation = 'multiply'; g.fillStyle = `rgb(${t[0] * 255 | 0},${t[1] * 255 | 0},${t[2] * 255 | 0})`; g.fillRect(0, 0, SHEET.w, SHEET.h);
    g.globalCompositeOperation = 'destination-in'; g.drawImage(floraAssets.leaves, 0, 0);
    return c;
  }));
}
/**
 * Draw scan `i` of `kind` from (x, y) along `ang`, `len` long, squeezed across by `squeeze` (a leaf seen at a slant),
 * in tone `tone` (0 dark … TONES.length - 1 sunlit); on the tilt canvas `gt` the same patch says which way it leans.
 */
function stamp(g, gt, kind, i, x, y, ang, len, squeeze, tone, flip, front) {
  const [c0, r0, n, cw, ch] = SHEET[kind], W = cw * SHEET.cell, H = ch * SHEET.cell, k = i % n;
  const sx = (c0 * SHEET.cell + k * W) % SHEET.w, sy = r0 * SHEET.cell + Math.floor((c0 * SHEET.cell + k * W) / SHEET.w) * H, sc = len / W;
  g.save(); g.translate(x, y); g.rotate(ang); g.scale(sc, sc * squeeze * (flip ? -1 : 1));
  g.drawImage(toned()[Math.max(0, Math.min(TONES.length - 1, Math.round(tone)))], sx, sy, W, H, 0, -H / 2, W, H);
  g.restore();
  if (!gt) return;
  // a squeezed leaf leans across its own width: toward one side or the other
  const lean = (1 - Math.abs(squeeze)) * (flip ? -1 : 1), tx = -Math.sin(ang) * lean, ty = Math.cos(ang) * lean;
  gt.save(); gt.translate(x, y); gt.rotate(ang);
  gt.fillStyle = `rgb(${127.5 + 127.5 * tx | 0},${127.5 - 127.5 * ty | 0},${front ? 255 : 0})`;        // (canvas y runs down, the card's v up)
  gt.beginPath(); gt.ellipse(len * 0.52, 0, len * 0.5, Math.max(1, (H / W) * len * 0.5 * Math.abs(squeeze) * (kind === 'bough' ? 0.9 : 0.8)), 0, 0, 6.2832); gt.fill();
  gt.restore();
}

/** a broadleaf spray from scans: forking twigs from the bottom centre, leaves along them, the shaded ones drawn first */
function photoSpray(g, gt, S, seed, { kind, leafLen, count, twigs = 5, droop = 0, reach = 0.9, open = 0, tone = 0, wood = 'rgb(46,38,30)' }) {
  const r = rng(seed), spots = [];
  g.lineCap = 'round'; g.lineJoin = 'round';
  // the wood: main twigs fanning from the foot, each with side shoots; every point along them can carry leaves
  const shoot = (x, y, a, len, w, depth) => {
    const segs = depth ? 5 : 8, L = len / segs;
    g.strokeStyle = wood; g.lineWidth = Math.max(0.8, w); g.beginPath(); g.moveTo(x, y);
    for (let i = 0; i < segs; i++) {
      a += (r() - 0.5) * 0.34 + droop * 0.05 * Math.sign(Math.cos(a) || 1);
      x += Math.cos(a) * L; y += Math.sin(a) * L; g.lineTo(x, y);
      const t = (i + 1) / segs;
      if (Math.hypot(x - S / 2, y - S / 2) < S * 0.46) spots.push([x, y, a, depth ? 0.55 + 0.45 * t : 0.25 + 0.5 * t]);
      if (!depth && i > 0 && i < segs - 1) for (const s of [-1, 1]) if (r() < 0.8) { g.stroke(); shoot(x, y, a + s * (0.5 + 0.5 * r()), len * (0.42 - 0.2 * t) * (0.7 + 0.6 * r()), w * 0.5, 1); g.strokeStyle = wood; g.lineWidth = Math.max(0.8, w); g.beginPath(); g.moveTo(x, y); }
    }
    g.stroke();
  };
  for (let t = 0; t < twigs; t++) shoot(S * 0.5, S * 0.985, -Math.PI / 2 + (t - (twigs - 1) / 2) * (1.7 / twigs) + (r() - 0.5) * 0.25, S * reach * (0.62 + 0.34 * r()) * (1 - 0.25 * Math.abs(t - (twigs - 1) / 2) / twigs), S * 0.011, 0);
  // leaves: three depths. The ones behind are in the spray's own shade (dark, a little blue); the ones in front take the light
  const LAYERS = [[0.42, 0.4, 0], [0.34, 2.3, 0], [0.24, 4.4, 1]];
  for (const [share, light, front] of LAYERS) {
    const n = Math.round(count * share);
    for (let i = 0; i < n; i++) {
      const sp = spots[Math.floor(r() * spots.length)]; if (!sp || r() > sp[3] + 0.25) continue;
      const side = r() < 0.5 ? -1 : 1, len = leafLen * S * (0.7 + 0.55 * r());
      const off = len * (0.1 + (open ? 0.9 : 0.5) * r()), x = sp[0] + Math.cos(sp[2] + side * 1.3) * off * 0.5 + (r() - 0.5) * len * 0.6, y = sp[1] + Math.sin(sp[2] + side * 1.3) * off * 0.5 + (r() - 0.5) * len * 0.6;
      if (Math.hypot(x - S / 2, y - S * 0.5) > S * 0.44 || y > S * 0.93) continue;
      const ang = sp[2] + side * (0.35 + 0.9 * r()) + (r() - 0.5) * 0.7 + droop * 0.9 * Math.sign(Math.cos(sp[2]) || 1) * r();
      const squeeze = 0.28 + 0.72 * Math.pow(r(), 0.6);
      stamp(g, gt, kind, Math.floor(r() * 16), x, y, ang, len, squeeze, light + tone + (r() - 0.5) * 2.2 + (squeeze < 0.5 ? -0.5 : 0), r() < 0.5, front && squeeze > 0.45);
    }
  }
}
/** a conifer bough from scans: a rib, side branches off it, and many small scanned sprays hanging along each; the under ones dark */
function photoBough(g, gt, S, seed) {
  const r = rng(seed), spots = [];
  g.lineCap = 'round'; g.strokeStyle = 'rgb(44,34,26)';
  const line = (x0, y0, x1, y1, w) => { g.lineWidth = Math.max(0.8, w); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
  line(S * 0.5, S * 0.985, S * 0.5, S * 0.08, S * 0.011);
  const n = 13;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5 * r()) / n, y = S * (0.96 - 0.86 * t), w = Math.sin(Math.PI * Math.pow(0.06 + 0.92 * t, 0.7)) * 0.92 + 0.12;
    for (const s of [-1, 1]) {
      const len = S * 0.42 * w * (0.75 + 0.4 * r()), a = -Math.PI / 2 + s * (0.95 + 0.35 * r() - 0.35 * t), x1 = S * 0.5 + Math.cos(a) * len, y1 = y + Math.sin(a) * len + len * 0.12;
      line(S * 0.5, y, x1, y1, S * 0.005);
      const m = Math.max(2, Math.round(len / (S * 0.03)));
      for (let k = 0; k <= m; k++) { const q = k / m; spots.push([S * 0.5 + (x1 - S * 0.5) * q, y + (y1 - y) * q, a, s, q]); }
    }
  }
  for (let k = 0; k < 8; k++) spots.push([S * 0.5, S * (0.1 + 0.05 * k), -Math.PI / 2, k % 2 ? 1 : -1, 1]);
  for (const [light, share, front] of [[0.2, 1.3, 0], [1.6, 1.0, 0], [3.0, 0.6, 1]]) {
    for (const sp of spots) for (let j = 0; j < 2; j++) {
      if (r() > share * 0.62) continue;
      const side = j ? 1 : -1, len = S * (0.075 + 0.06 * r()) * (0.7 + 0.3 * sp[4]);
      const a = sp[2] + side * (0.35 + 0.75 * r()) + sp[3] * 0.25 * r();
      const x = sp[0] + (r() - 0.5) * S * 0.012, y = sp[1] + (r() - 0.5) * S * 0.012;
      if (x < S * 0.03 || x > S * 0.97 || y < S * 0.03) continue;
      stamp(g, gt, 'bough', Math.floor(r() * 3), x, y, a, len, 0.5 + 0.5 * r(), light + (r() - 0.5) * 1.8, r() < 0.5, front);
    }
  }
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
function pineTuft(g, S, seed, fine = false) {
  // long needles bursting from the ends of a forked shoot
  const r = rng(seed);
  g.lineCap = 'round';
  if (fine) {
    // a pine branch end: forking shoots, a brush of needles round every length of shoot, candles at the tips;
    // the brushes underneath are drawn first and dark
    const pts = [];
    const shoot = (x, y, a, len, w, depth) => {
      const segs = 5, L = len / segs;
      g.strokeStyle = 'rgb(72,50,36)'; g.lineWidth = Math.max(0.8, w); g.beginPath(); g.moveTo(x, y);
      for (let i = 0; i < segs; i++) {
        a += (r() - 0.5) * 0.3; x += Math.cos(a) * L; y += Math.sin(a) * L; g.lineTo(x, y);
        if (depth > 0 || i > 1) pts.push([x, y, a, i === segs - 1]);
        if (depth < 2 && i >= 1 && i < segs - 1 && r() < 0.75) { g.stroke(); shoot(x, y, a + (r() < 0.5 ? -1 : 1) * (0.5 + 0.4 * r()), len * (0.6 - 0.1 * i) * (0.8 + 0.4 * r()), w * 0.6, depth + 1); g.strokeStyle = 'rgb(72,50,36)'; g.lineWidth = Math.max(0.8, w); g.beginPath(); g.moveTo(x, y); }
      }
      g.stroke();
    };
    for (let t = 0; t < 4; t++) shoot(S * 0.5, S * 0.985, -Math.PI / 2 + (t - 1.5) * 0.42 + (r() - 0.5) * 0.2, S * (0.6 + 0.3 * r()), S * 0.012, 0);
    for (const [light, share] of [[0.34, 1], [0.6, 0.8], [0.95, 0.5]]) for (const [x, y, a, tip] of pts) {
      if (r() > share || Math.hypot(x - S / 2, y - S / 2) > S * 0.45) continue;
      const n = tip ? 34 : 22, len = S * (0.05 + 0.03 * r()) * (tip ? 1.2 : 1);
      for (let i = 0; i < n; i++) {
        const na = a + (r() - 0.5) * (tip ? 2.2 : 3.6), l = len * (0.6 + 0.5 * r()), k = light * (0.75 + 0.5 * r());
        g.strokeStyle = `rgb(${62 * k | 0},${98 * k | 0},${48 * k | 0})`; g.lineWidth = Math.max(0.7, S * 0.0022);
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(na) * l, y + Math.sin(na) * l + l * 0.12); g.stroke();
      }
    }
    return;
  }
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

/**
 * Mip levels of an RGBA picture laid out in cols × rows cells. Colour is averaged by cover (transparent texels do not
 * count), and when `keep` is set every level's alpha is scaled, cell by cell, until as much of the cell passes the
 * cut-out test (alpha > 0.4) as in the full-size picture: without that, foliage thins out and vanishes with distance.
 */
export function coverMips(data, W, H, cols, rows, keep = true, cut = 0.4) {
  const levels = [{ data, width: W, height: H }], T = cut * 255;
  const cover = (d, w, x0, y0, cw, ch, k) => { let n = 0; for (let y = y0; y < y0 + ch; y++) for (let x = x0, o = (y * w + x0) * 4 + 3; x < x0 + cw; x++, o += 4) if (d[o] * k > T) n++; return n / (cw * ch); };
  const base = [];
  if (keep) for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) base.push(cover(data, W, (c * W) / cols, (r * H) / rows, W / cols, H / rows, 1));
  let src = data, w = W, h = H;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), out = new Uint8Array(nw * nh * 4), fx = w > 1 ? 2 : 1, fy = h > 1 ? 2 : 1;
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0, pr = 0, pg = 0, pb = 0;
      for (let j = 0; j < fy; j++) for (let i = 0; i < fx; i++) { const o = ((y * fy + j) * w + x * fx + i) * 4, al = src[o + 3]; r += src[o] * al; g += src[o + 1] * al; b += src[o + 2] * al; a += al; pr += src[o]; pg += src[o + 1]; pb += src[o + 2]; }
      const o = (y * nw + x) * 4, n = fx * fy;
      if (a > 0) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; } else { out[o] = pr / n; out[o + 1] = pg / n; out[o + 2] = pb / n; }
      out[o + 3] = a / n;
    }
    if (keep && nw >= cols * 4 && nh >= rows * 4) for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cw = nw / cols, ch = nh / rows, x0 = c * cw, y0 = r * ch, want = base[r * cols + c];
      if (want <= 0.001 || want >= 0.999) continue;
      let lo = 0.5, hi = 4;
      for (let it = 0; it < 9; it++) { const mid = (lo + hi) / 2; if (cover(out, nw, x0, y0, cw, ch, mid) < want) lo = mid; else hi = mid; }
      const k = hi;                    // (the side that keeps at least as much: a crown should fill in, never thin out)
      for (let y = y0; y < y0 + ch; y++) for (let x = x0, o = (y * nw + x0) * 4 + 3; x < x0 + cw; x++, o += 4) out[o] = Math.min(255, Math.ceil(out[o] * k));
    }
    levels.push({ data: out, width: nw, height: nh });
    src = out; w = nw; h = nh;
  }
  return levels;
}

let ATLAS_TEX = {};
export function leafAtlas(size = 2048) {
  const photo = !!floraAssets.leaves, key = size + (photo ? 'p' : '');
  if (ATLAS_TEX[key]) return ATLAS_TEX[key];
  const S = size / ATLAS.cols, W = size, Hh = S * ATLAS.rows, c = cv(W, Hh), g = c.getContext('2d', { willReadFrequently: true });
  const ct = cv(W, Hh), gt = ct.getContext('2d', { willReadFrequently: true });
  gt.fillStyle = 'rgb(127,127,0)'; gt.fillRect(0, 0, W, Hh);
  const cell = (id, fn) => { const cx = id % ATLAS.cols, cy = Math.floor(id / ATLAS.cols); for (const q of [g, gt]) { q.save(); q.translate(cx * S, cy * S); q.beginPath(); q.rect(1, 1, S - 2, S - 2); q.clip(); } fn(); g.restore(); gt.restore(); };
  const C = ATLAS.cells;
  if (photo) {
    cell(C.oak, () => photoSpray(g, gt, S, 11, { kind: 'oak', leafLen: 0.062, count: 2300, twigs: 5 }));
    cell(C.maple, () => photoSpray(g, gt, S, 23, { kind: 'maple', leafLen: 0.07, count: 1700, twigs: 5, tone: -0.3 }));
    cell(C.birch, () => photoSpray(g, gt, S, 37, { kind: 'birch', leafLen: 0.046, count: 2100, twigs: 6, droop: 1, open: 1, tone: 0.4, wood: 'rgb(70,60,52)' }));
    cell(C.spruce, () => photoBough(g, gt, S, 41));
    cell(C.pine, () => pineTuft(g, S, 53, true));
    cell(C.palm, () => frond(g, S, 61));
    cell(C.bush, () => photoSpray(g, gt, S, 71, { kind: 'shrub', leafLen: 0.075, count: 1500, twigs: 7, reach: 0.8, tone: -0.2 }));
  } else {
    cell(C.oak, () => spray(g, S, 11, { leafLen: 0.105, leafWid: 0.036, count: 300, lobes: 3 }));
    cell(C.maple, () => spray(g, S, 23, { leafLen: 0.1, leafWid: 0.055, count: 290, lobes: 2, fill: 0.46 }));
    cell(C.birch, () => spray(g, S, 37, { leafLen: 0.062, leafWid: 0.03, count: 300, warm: 0.5, fill: 0.5, twigs: 6, droop: 1 }));
    cell(C.spruce, () => bough(g, S, 41));
    cell(C.pine, () => pineTuft(g, S, 53));
    cell(C.palm, () => frond(g, S, 61));
    cell(C.bush, () => spray(g, S, 71, { leafLen: 0.085, leafWid: 0.034, count: 380, fill: 0.5, twigs: 7, warm: 0.2 }));
  }
  cell(C.solid, () => { g.fillStyle = '#fff'; g.fillRect(0, 0, S, S); });
  // un-premultiplied pixels, flipped to v-up; transparent texels take the foliage colour (no dark fringes)
  const src = g.getImageData(0, 0, W, Hh).data, out = new Uint8Array(W * Hh * 4);
  const tsrc = gt.getImageData(0, 0, W, Hh).data, tout = new Uint8Array(W * Hh * 4);
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
    tout[d] = tsrc[o]; tout[d + 1] = tsrc[o + 1]; tout[d + 2] = tsrc[o + 2]; tout[d + 3] = 255;
  }
  const make = (data, srgb, keep, name) => {
    const t = new THREE.DataTexture(data, W, Hh, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.mipmaps = coverMips(data, W, Hh, ATLAS.cols, ATLAS.rows, keep); t.generateMipmaps = false;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; t.name = name;
    return t;
  };
  const t = make(out, true, true, 'leafAtlas');
  t.userData.average = avg; t.userData.photo = photo; t.userData.tilt = make(tout, false, false, 'leafTilt');
  return (ATLAS_TEX[key] = t);
}

function normalFrom(height, w, h, strength) {
  const out = new Uint8Array(w * h * 4), H = (x, y) => height[(((y % h) + h) % h) * w + (((x % w) + w) % w)];
  for (let y = 0, o = 0; y < h; y++) for (let x = 0; x < w; x++, o += 4) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength, l = 1 / Math.hypot(dx, dy, 1);
    out[o] = (-dx * l * 0.5 + 0.5) * 255; out[o + 1] = (-dy * l * 0.5 + 0.5) * 255; out[o + 2] = (l * 0.5 + 0.5) * 255; out[o + 3] = 255;
  }
  return out;
}
let BARK = null, BARK_PHOTO = false;
export function barkTextures() {
  if (BARK && BARK_PHOTO === !!floraAssets.bark.furrowed) return BARK;
  BARK_PHOTO = !!floraAssets.bark.furrowed;
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
  const P = floraAssets.bark;
  return (BARK = [P.furrowed || furrowed, birch, palm, P.scaly || furrowed, P.fir || furrowed]);
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
