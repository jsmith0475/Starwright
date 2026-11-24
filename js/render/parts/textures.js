// Starwright part textures. Everything is drawn into canvases at first use and cached:
// colour (sRGB), normal (from a painted height field), and "ORM" maps (g = roughness, b = metalness).
// All maps tile. World scale is noted per map so geometry can lay UVs out in metres.
import * as THREE from '../../lib/three.module.min.js';

const cache = new Map();
const TAU = Math.PI * 2;

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function ctxOf(c) { return c.getContext('2d', { willReadFrequently: true }); }
const grey = (v, a = 1) => `rgba(${v | 0},${v | 0},${v | 0},${a})`;

function tex(c, { srgb = false, repeat = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Height canvas (white = high) → tangent-space normal map canvas. Wraps at the edges. */
export function normalFromHeight(hc, strength = 2) {
  const w = hc.width, h = hc.height, src = ctxOf(hc).getImageData(0, 0, w, h).data;
  const out = canvas(w, h), octx = ctxOf(out), img = octx.createImageData(w, h), d = img.data;
  const H = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const nx = (H(x - 1, y) - H(x + 1, y)) * strength / 255, ny = (H(x, y + 1) - H(x, y - 1)) * strength / 255;
    const l = 1 / Math.hypot(nx, ny, 1), i = (y * w + x) * 4;
    d[i] = (nx * l * 0.5 + 0.5) * 255; d[i + 1] = (ny * l * 0.5 + 0.5) * 255; d[i + 2] = (l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// Draw something at (x, y) and again at the wrapped positions so the tile stays seamless.
function wrapDraw(w, h, x, y, rad, fn) {
  const xs = [0], ys = [0];
  if (x - rad < 0) xs.push(w); if (x + rad > w) xs.push(-w);
  if (y - rad < 0) ys.push(h); if (y + rad > h) ys.push(-h);
  for (const ox of xs) for (const oy of ys) fn(x + ox, y + oy);
}
function speckle(g, w, h, r, n, lo, hi, alpha, size = 1.5) {
  for (let i = 0; i < n; i++) { g.fillStyle = grey(lo + r() * (hi - lo), alpha * (0.4 + r() * 0.6)); const s = 0.5 + r() * size; g.fillRect(r() * w, r() * h, s, s); }
}

// ---------------------------------------------------------------------------------------------
// Painted hull: 2.5 m × 2.5 m tile. Four rows of plating with staggered seams, rivet lines, small
// access hatches, grime streaks under the seams, scuffs and chipped paint.
// ---------------------------------------------------------------------------------------------
export const HULL_TILE = 2.5;
export function hullMaps() {
  if (cache.has('hull')) return cache.get('hull');
  const S = 1024, r = rng(7), col = canvas(S, S), hgt = canvas(S, S), orm = canvas(S, S);
  const c = ctxOf(col), hh = ctxOf(hgt), o = ctxOf(orm);
  c.fillStyle = '#e6e8ea'; c.fillRect(0, 0, S, S);
  hh.fillStyle = grey(140); hh.fillRect(0, 0, S, S);
  o.fillStyle = 'rgb(255,132,0)'; o.fillRect(0, 0, S, S);
  const rows = 4, rh = S / rows, panels = [];
  for (let k = 0; k < rows; k++) {
    const n = k % 2 ? 3 : 2, pw = S / n, off = (k * 0.37 % 1) * pw;
    for (let j = 0; j < n; j++) panels.push({ x: off + j * pw, y: k * rh, w: pw, h: rh });
  }
  // per-panel tone and gloss variation
  for (const p of panels) {
    const tone = 226 + r() * 16, rough = 118 + r() * 34;
    for (const ox of [0, -S]) {
      c.fillStyle = `rgb(${tone | 0},${(tone + 1) | 0},${(tone + 3) | 0})`; c.fillRect(p.x + ox, p.y, p.w, p.h);
      o.fillStyle = `rgb(255,${rough | 0},0)`; o.fillRect(p.x + ox, p.y, p.w, p.h);
      // slight pillowing: panel centre a touch higher than its edges
      const gr = hh.createLinearGradient(0, p.y, 0, p.y + p.h);
      gr.addColorStop(0, grey(128)); gr.addColorStop(0.08, grey(142)); gr.addColorStop(0.92, grey(142)); gr.addColorStop(1, grey(128));
      hh.fillStyle = gr; hh.fillRect(p.x + ox, p.y, p.w, p.h);
    }
  }
  speckle(c, S, S, r, 9000, 190, 250, 0.10, 2);
  speckle(o, S, S, r, 5000, 90, 190, 0.3, 3);
  // grime streaks running down from the horizontal seams (canvas y grows downward = down the hull)
  for (let i = 0; i < 150; i++) {
    const k = (r() * rows) | 0, x = r() * S, y = k * rh + 2, len = 30 + r() * r() * 230, wd = 1.5 + r() * 7, a = 0.03 + r() * 0.1;
    for (const oy of [0, -S]) {
      const gr = c.createLinearGradient(0, y + oy, 0, y + oy + len);
      gr.addColorStop(0, `rgba(70,62,52,${a})`); gr.addColorStop(1, 'rgba(70,62,52,0)');
      c.fillStyle = gr; c.fillRect(x, y + oy, wd, len);
      const g2 = o.createLinearGradient(0, y + oy, 0, y + oy + len);
      g2.addColorStop(0, `rgba(255,205,0,${a * 3})`); g2.addColorStop(1, 'rgba(255,205,0,0)');
      o.fillStyle = g2; o.fillRect(x, y + oy, wd, len);
    }
  }
  // broad dirt wash below each seam
  for (let k = 0; k < rows; k++) for (const oy of [0]) {
    const y = k * rh + oy, gr = c.createLinearGradient(0, y, 0, y + 46);
    gr.addColorStop(0, 'rgba(84,78,70,0.16)'); gr.addColorStop(1, 'rgba(84,78,70,0)');
    c.fillStyle = gr; c.fillRect(0, y, S, 46);
  }
  // seams + rivets
  const seam = (x0, y0, x1, y1) => {
    for (const [ox, oy] of [[0, 0], [-S, 0], [S, 0], [0, -S], [0, S]]) {
      c.strokeStyle = 'rgba(96,104,112,0.9)'; c.lineWidth = 2; c.beginPath(); c.moveTo(x0 + ox, y0 + oy); c.lineTo(x1 + ox, y1 + oy); c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 1; c.beginPath(); c.moveTo(x0 + ox + 1.5, y0 + oy + 1.5); c.lineTo(x1 + ox + 1.5, y1 + oy + 1.5); c.stroke();
      hh.strokeStyle = grey(40); hh.lineWidth = 3.2; hh.beginPath(); hh.moveTo(x0 + ox, y0 + oy); hh.lineTo(x1 + ox, y1 + oy); hh.stroke();
      o.strokeStyle = 'rgb(255,220,0)'; o.lineWidth = 3; o.beginPath(); o.moveTo(x0 + ox, y0 + oy); o.lineTo(x1 + ox, y1 + oy); o.stroke();
    }
  };
  const rivet = (x, y) => wrapDraw(S, S, x, y, 5, (px, py) => {
    const g1 = hh.createRadialGradient(px, py, 0, px, py, 3.6); g1.addColorStop(0, grey(235)); g1.addColorStop(0.6, grey(190)); g1.addColorStop(1, grey(140, 0));
    hh.fillStyle = g1; hh.beginPath(); hh.arc(px, py, 3.6, 0, TAU); hh.fill();
    c.fillStyle = 'rgba(120,126,134,0.55)'; c.beginPath(); c.arc(px + 0.6, py + 0.8, 2.3, 0, TAU); c.fill();
    c.fillStyle = 'rgba(246,248,250,0.9)'; c.beginPath(); c.arc(px - 0.3, py - 0.4, 1.7, 0, TAU); c.fill();
  });
  for (let k = 0; k < rows; k++) {
    seam(0, k * rh, S, k * rh);
    for (let x = 16; x < S; x += 32) { rivet(x, k * rh + 11); rivet(x, k * rh - 11); }
  }
  for (const p of panels) {
    seam(p.x, p.y, p.x, p.y + p.h);
    for (let y = p.y + 27; y < p.y + p.h - 12; y += 32) { rivet(p.x + 10, y); rivet(p.x - 10, y); }
  }
  // small access hatches and placards
  const rr = (g, x, y, w, h, rad) => { g.beginPath(); g.roundRect(x, y, w, h, rad); };
  for (let i = 0; i < 7; i++) {
    const p = panels[(r() * panels.length) | 0], w = 44 + r() * 50, h = 30 + r() * 40;
    const x = (p.x + 30 + r() * (p.w - w - 60)) % (S - w - 4), y = p.y + 40 + r() * (p.h - h - 80);
    rr(c, x, y, w, h, 6); c.strokeStyle = 'rgba(90,98,106,0.9)'; c.lineWidth = 1.6; c.stroke();
    rr(hh, x, y, w, h, 6); hh.strokeStyle = grey(50); hh.lineWidth = 2.4; hh.stroke();
    for (const [sx, sy] of [[5, 5], [w - 5, 5], [5, h - 5], [w - 5, h - 5]]) rivet(x + sx, y + sy);
    if (r() < 0.6) { c.fillStyle = r() < 0.5 ? 'rgba(226,170,60,0.85)' : 'rgba(40,46,54,0.8)'; c.fillRect(x + w * 0.25, y + h * 0.36, w * 0.5, h * 0.28); c.fillStyle = 'rgba(30,34,40,0.8)'; for (let q = 0; q < 3; q++) c.fillRect(x + w * 0.3, y + h * (0.42 + q * 0.07), w * (0.2 + r() * 0.2), 1.2); }
  }
  // chipped paint (bare metal showing) along seams
  for (let i = 0; i < 260; i++) {
    const p = panels[(r() * panels.length) | 0], along = r() < 0.6;
    const x = along ? p.x + r() * p.w : p.x + (r() - 0.5) * 9, y = along ? p.y + (r() - 0.5) * 9 : p.y + r() * p.h, s = 1 + r() * r() * 5;
    wrapDraw(S, S, ((x % S) + S) % S, ((y % S) + S) % S, 8, (px, py) => {
      c.fillStyle = 'rgba(128,134,142,0.9)'; c.beginPath(); c.ellipse(px, py, s * (0.6 + r()), s * (0.5 + r() * 0.6), r() * 3, 0, TAU); c.fill();
      o.fillStyle = 'rgb(255,80,255)'; o.beginPath(); o.ellipse(px, py, s, s * 0.7, 0, 0, TAU); o.fill();
      hh.fillStyle = grey(110, 0.8); hh.beginPath(); hh.arc(px, py, s, 0, TAU); hh.fill();
    });
  }
  // long scuffs
  for (let i = 0; i < 40; i++) {
    const x = r() * S, y = r() * S, l = 20 + r() * 90, a = (r() - 0.5) * 0.5;
    c.strokeStyle = `rgba(60,64,70,${0.04 + r() * 0.07})`; c.lineWidth = 0.8 + r() * 1.6; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke();
    o.strokeStyle = 'rgba(255,70,0,0.5)'; o.lineWidth = 2; o.beginPath(); o.moveTo(x, y); o.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); o.stroke();
  }
  const maps = { map: tex(col, { srgb: true }), normalMap: tex(normalFromHeight(hgt, 2.6)), ormMap: tex(orm) };
  cache.set('hull', maps); return maps;
}

// ---------------------------------------------------------------------------------------------
// Bare machined metal: lathe-turned streaks running along u. 1 m tile.
// ---------------------------------------------------------------------------------------------
export function metalMaps() {
  if (cache.has('metal')) return cache.get('metal');
  const S = 512, r = rng(21), col = canvas(S, S), hgt = canvas(S, S), orm = canvas(S, S);
  const c = ctxOf(col), hh = ctxOf(hgt), o = ctxOf(orm);
  c.fillStyle = '#d2d5d9'; c.fillRect(0, 0, S, S); hh.fillStyle = grey(128); hh.fillRect(0, 0, S, S); o.fillStyle = 'rgb(255,96,255)'; o.fillRect(0, 0, S, S);
  for (let i = 0; i < 900; i++) {
    const y = r() * S, t = 0.5 + r() * 1.8, v = r();
    c.fillStyle = grey(150 + v * 105, 0.10 + r() * 0.16); c.fillRect(0, y, S, t);
    hh.fillStyle = grey(90 + v * 80, 0.35); hh.fillRect(0, y, S, t);
    o.fillStyle = `rgba(255,${(60 + r() * 90) | 0},255,0.4)`; o.fillRect(0, y, S, t);
  }
  // blotchy oxidation / oil
  for (let i = 0; i < 60; i++) {
    const x = r() * S, y = r() * S, rad = 14 + r() * 60;
    wrapDraw(S, S, x, y, rad, (px, py) => {
      const g1 = c.createRadialGradient(px, py, 0, px, py, rad); g1.addColorStop(0, `rgba(96,84,70,${0.05 + r() * 0.08})`); g1.addColorStop(1, 'rgba(96,84,70,0)');
      c.fillStyle = g1; c.fillRect(px - rad, py - rad, rad * 2, rad * 2);
      const g2 = o.createRadialGradient(px, py, 0, px, py, rad); g2.addColorStop(0, 'rgba(255,170,255,0.3)'); g2.addColorStop(1, 'rgba(255,170,255,0)');
      o.fillStyle = g2; o.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    });
  }
  speckle(c, S, S, r, 2500, 90, 240, 0.12, 1.6);
  const maps = { map: tex(col, { srgb: true }), normalMap: tex(normalFromHeight(hgt, 0.8)), ormMap: tex(orm) };
  cache.set('metal', maps); return maps;
}

// ---------------------------------------------------------------------------------------------
// Engine bell: channel-wall cooling tubes running along v, 48 per tile, with soot.
// ---------------------------------------------------------------------------------------------
export function bellMaps() {
  if (cache.has('bell')) return cache.get('bell');
  const W = 512, Hh = 256, r = rng(5), col = canvas(W, Hh), hgt = canvas(W, Hh), orm = canvas(W, Hh);
  const c = ctxOf(col), hh = ctxOf(hgt), o = ctxOf(orm), n = 32, pw = W / n;
  c.fillStyle = '#cfd0d2'; c.fillRect(0, 0, W, Hh); o.fillStyle = 'rgb(255,110,255)'; o.fillRect(0, 0, W, Hh);
  for (let i = 0; i < n; i++) {
    const g1 = hh.createLinearGradient(i * pw, 0, (i + 1) * pw, 0);
    g1.addColorStop(0, grey(40)); g1.addColorStop(0.5, grey(230)); g1.addColorStop(1, grey(40));
    hh.fillStyle = g1; hh.fillRect(i * pw, 0, pw + 1, Hh);
    c.fillStyle = 'rgba(40,36,34,0.55)'; c.fillRect(i * pw - 1, 0, 2, Hh);
    c.fillStyle = grey(180 + r() * 60, 0.25); c.fillRect(i * pw + 2, 0, pw - 4, Hh);
  }
  for (let i = 0; i < 90; i++) { const x = r() * W, y = r() * Hh, l = 20 + r() * 120; c.fillStyle = `rgba(30,24,20,${0.05 + r() * 0.12})`; c.fillRect(x, y, 2 + r() * 10, l); c.fillRect(x, y - Hh, 2 + r() * 10, l); }
  speckle(o, W, Hh, r, 1500, 80, 200, 0.3, 3);
  const maps = { map: tex(col, { srgb: true }), normalMap: tex(normalFromHeight(hgt, 2.2)), ormMap: tex(orm) };
  cache.set('bell', maps); return maps;
}

// ---------------------------------------------------------------------------------------------
// Insulating foil blanket: crinkled facets. 0.5 m tile.
// ---------------------------------------------------------------------------------------------
export function foilMaps() {
  if (cache.has('foil')) return cache.get('foil');
  const S = 512, r = rng(99), col = canvas(S, S), hgt = canvas(S, S), orm = canvas(S, S);
  const c = ctxOf(col), hh = ctxOf(hgt), o = ctxOf(orm);
  c.fillStyle = '#f2f2f2'; c.fillRect(0, 0, S, S); hh.fillStyle = grey(128); hh.fillRect(0, 0, S, S); o.fillStyle = 'rgb(255,70,255)'; o.fillRect(0, 0, S, S);
  // Crumpled blanket: flat facets of every size and direction, each tilted its own way (a gradient across the facet
  // in a random direction), big folds first and fine crinkles on top. Nothing lines up, so it cannot read as grain.
  const facet = (x, y, rad, alpha) => {
    const a0 = r() * TAU, n = 3 + (r() * 3 | 0), v = r(), ga = r() * TAU, sq = 0.65 + r() * 0.7;
    const offs = []; for (let k = 0; k < n; k++) offs.push([Math.cos(a0 + (k + r() * 0.5) * TAU / n) * rad * sq, Math.sin(a0 + (k + r() * 0.5) * TAU / n) * rad / sq]);
    wrapDraw(S, S, x, y, rad * 1.6, (px, py) => {
      const g1 = hh.createLinearGradient(px - Math.cos(ga) * rad, py - Math.sin(ga) * rad, px + Math.cos(ga) * rad, py + Math.sin(ga) * rad);
      g1.addColorStop(0, grey(30 + v * 70, alpha)); g1.addColorStop(1, grey(160 + v * 95, alpha));
      hh.fillStyle = g1; hh.beginPath(); offs.forEach((q, k) => (k ? hh.lineTo(px + q[0], py + q[1]) : hh.moveTo(px + q[0], py + q[1]))); hh.closePath(); hh.fill();
      c.fillStyle = grey(196 + v * 59, 0.16); c.beginPath(); offs.forEach((q, k) => (k ? c.lineTo(px + q[0], py + q[1]) : c.moveTo(px + q[0], py + q[1]))); c.closePath(); c.fill();
    });
  };
  for (let i = 0; i < 260; i++) facet(r() * S, r() * S, 26 + r() * 44, 0.8);
  for (let i = 0; i < 900; i++) facet(r() * S, r() * S, 8 + r() * 16, 0.6);
  for (let i = 0; i < 1500; i++) facet(r() * S, r() * S, 3 + r() * 6, 0.4);
  // quilting: one stitched seam each way per tile, and a strip of tape
  for (let k = 0; k < 1; k++) { const y = 6; hh.fillStyle = grey(30, 0.9); hh.fillRect(0, y, S, 3); c.fillStyle = 'rgba(120,110,90,0.4)'; c.fillRect(0, y, S, 2); const x = 90; hh.fillRect(x, 0, 3, S); c.fillRect(x, 0, 2, S); }
  const maps = { map: tex(col, { srgb: true }), normalMap: tex(normalFromHeight(hgt, 3.4)), ormMap: tex(orm) };
  cache.set('foil', maps); return maps;
}

// ---------------------------------------------------------------------------------------------
// Solar cells: 0.5 m tile, 4 × 4 cells with busbars and fingers.
// ---------------------------------------------------------------------------------------------
export function solarMaps() {
  if (cache.has('solar')) return cache.get('solar');
  const S = 512, r = rng(3), col = canvas(S, S), hgt = canvas(S, S), orm = canvas(S, S);
  const c = ctxOf(col), hh = ctxOf(hgt), o = ctxOf(orm), n = 4, cw = S / n, gap = 5;
  c.fillStyle = '#b9bfc6'; c.fillRect(0, 0, S, S); hh.fillStyle = grey(60); hh.fillRect(0, 0, S, S); o.fillStyle = 'rgb(255,150,150)'; o.fillRect(0, 0, S, S);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = i * cw + gap / 2, y = j * cw + gap / 2, w = cw - gap;
    const g1 = c.createLinearGradient(x, y, x + w, y + w), t = r() * 0.25;
    g1.addColorStop(0, `rgb(${18 + t * 30 | 0},${40 + t * 40 | 0},${118 + t * 60 | 0})`); g1.addColorStop(0.5, `rgb(10,${22 + t * 30 | 0},${74 + t * 50 | 0})`); g1.addColorStop(1, `rgb(${22 + t * 30 | 0},${52 + t * 30 | 0},${140 + t * 40 | 0})`);
    c.fillStyle = g1; c.beginPath(); c.roundRect(x, y, w, w, 9); c.fill();
    hh.fillStyle = grey(200); hh.beginPath(); hh.roundRect(x, y, w, w, 9); hh.fill();
    o.fillStyle = 'rgb(255,52,40)'; o.beginPath(); o.roundRect(x, y, w, w, 9); o.fill();
    c.strokeStyle = 'rgba(150,190,255,0.22)'; c.lineWidth = 0.7;
    for (let f = 1; f < 16; f++) { c.beginPath(); c.moveTo(x + 2, y + f * w / 16); c.lineTo(x + w - 2, y + f * w / 16); c.stroke(); }
    c.fillStyle = 'rgba(214,222,232,0.85)'; c.fillRect(x + w * 0.3 - 1, y + 1, 2.4, w - 2); c.fillRect(x + w * 0.7 - 1, y + 1, 2.4, w - 2);
  }
  const maps = { map: tex(col, { srgb: true }), normalMap: tex(normalFromHeight(hgt, 1.2)), ormMap: tex(orm) };
  cache.set('solar', maps); return maps;
}

// ---------------------------------------------------------------------------------------------
// Heat-shield tiles: 1 m tile of staggered ceramic tiles, charred.
// ---------------------------------------------------------------------------------------------
export function tileMaps() {
  if (cache.has('tile')) return cache.get('tile');
  const S = 512, r = rng(41), col = canvas(S, S), hgt = canvas(S, S), orm = canvas(S, S);
  const c = ctxOf(col), hh = ctxOf(hgt), o = ctxOf(orm), n = 8, cw = S / n;
  c.fillStyle = '#17120f'; c.fillRect(0, 0, S, S); hh.fillStyle = grey(30); hh.fillRect(0, 0, S, S); o.fillStyle = 'rgb(255,235,0)'; o.fillRect(0, 0, S, S);
  for (let j = 0; j < n; j++) for (let i = -1; i < n; i++) {
    const x = i * cw + (j % 2 ? cw / 2 : 0) + 1.5, y = j * cw + 1.5, w = cw - 3, v = r();
    const tone = v < 0.08 ? 150 + r() * 40 : v < 0.2 ? 92 + r() * 20 : 46 + r() * 30;
    for (const ox of [0, S]) {
      c.fillStyle = `rgb(${tone | 0},${(tone * 0.88) | 0},${(tone * 0.78) | 0})`; c.beginPath(); c.roundRect(x + ox, y, w, w, 4); c.fill();
      const g1 = hh.createRadialGradient(x + ox + w / 2, y + w / 2, w * 0.2, x + ox + w / 2, y + w / 2, w * 0.75); g1.addColorStop(0, grey(210)); g1.addColorStop(1, grey(120));
      hh.fillStyle = g1; hh.beginPath(); hh.roundRect(x + ox, y, w, w, 4); hh.fill();
      o.fillStyle = `rgb(255,${(170 + r() * 60) | 0},0)`; o.beginPath(); o.roundRect(x + ox, y, w, w, 4); o.fill();
    }
  }
  for (let i = 0; i < 70; i++) {
    const x = r() * S, y = r() * S, rad = 20 + r() * 70;
    wrapDraw(S, S, x, y, rad, (px, py) => { const g1 = c.createRadialGradient(px, py, 0, px, py, rad); g1.addColorStop(0, `rgba(8,6,5,${0.15 + r() * 0.3})`); g1.addColorStop(1, 'rgba(8,6,5,0)'); c.fillStyle = g1; c.fillRect(px - rad, py - rad, rad * 2, rad * 2); });
  }
  speckle(c, S, S, r, 3000, 20, 120, 0.25, 2);
  const maps = { map: tex(col, { srgb: true }), normalMap: tex(normalFromHeight(hgt, 2.4)), ormMap: tex(orm) };
  cache.set('tile', maps); return maps;
}

// ---------------------------------------------------------------------------------------------
// Brushed stainless sheet (the XXL "Wayfarer" hulls): 3 m tile. Fine brushing along u, faint rolling marks and
// heat tint, and a soft low-frequency ripple in the normal map so the mirror finish wobbles like thin welded sheet.
// ---------------------------------------------------------------------------------------------
export const STEEL_TILE = 3;
export function steelMaps() {
  if (cache.has('steel')) return cache.get('steel');
  const S = 512, r = rng(77), col = canvas(S, S), hgt = canvas(S, S), orm = canvas(S, S);
  const c = ctxOf(col), hh = ctxOf(hgt), o = ctxOf(orm);
  c.fillStyle = '#d3d6da'; c.fillRect(0, 0, S, S); hh.fillStyle = grey(128); hh.fillRect(0, 0, S, S); o.fillStyle = 'rgb(255,84,255)'; o.fillRect(0, 0, S, S);
  // oil-canning: broad shallow dents between the stiffening rings (height only)
  for (let i = 0; i < 26; i++) {
    const x = r() * S, y = r() * S, rx = 50 + r() * 90, up = r() < 0.5;
    wrapDraw(S, S, x, y, rx, (px, py) => { const g1 = hh.createRadialGradient(px, py, 0, px, py, rx); g1.addColorStop(0, grey(up ? 156 : 100, 0.5)); g1.addColorStop(1, grey(128, 0)); hh.fillStyle = g1; hh.fillRect(px - rx, py - rx, rx * 2, rx * 2); });
  }
  // brushing: thin streaks all the way round
  for (let i = 0; i < 1300; i++) {
    const y = r() * S, t = 0.4 + r() * 1.2, v = r();
    c.fillStyle = grey(168 + v * 80, 0.05 + r() * 0.1); c.fillRect(0, y, S, t);
    o.fillStyle = `rgba(255,${(58 + r() * 70) | 0},255,0.35)`; o.fillRect(0, y, S, t);
  }
  // rolling marks down the sheet and the odd straw / blue heat stain
  for (let i = 0; i < 46; i++) { const x = r() * S, w = 2 + r() * 14; c.fillStyle = grey(120 + r() * 120, 0.03 + r() * 0.04); c.fillRect(x, 0, w, S); }
  for (let i = 0; i < 34; i++) {
    const x = r() * S, y = r() * S, rad = 24 + r() * 80, tint = r() < 0.5 ? '150,128,96' : '104,118,150', al = 0.03 + r() * 0.06;
    wrapDraw(S, S, x, y, rad, (px, py) => {
      const g1 = c.createRadialGradient(px, py, 0, px, py, rad); g1.addColorStop(0, `rgba(${tint},${al})`); g1.addColorStop(1, `rgba(${tint},0)`); c.fillStyle = g1; c.fillRect(px - rad, py - rad, rad * 2, rad * 2);
      const g2 = o.createRadialGradient(px, py, 0, px, py, rad); g2.addColorStop(0, 'rgba(255,120,255,0.22)'); g2.addColorStop(1, 'rgba(255,120,255,0)'); o.fillStyle = g2; o.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    });
  }
  speckle(c, S, S, r, 1600, 110, 240, 0.08, 1.4);
  const maps = { map: tex(col, { srgb: true }), normalMap: tex(normalFromHeight(hgt, 1.1)), ormMap: tex(orm) };
  cache.set('steel', maps); return maps;
}

// ---------------------------------------------------------------------------------------------
// Black hexagonal heat tiles (the Wayfarer's belly): 1 m tile, 7 tiles across and 8 rows, so it wraps.
// ---------------------------------------------------------------------------------------------
export function hexTileMaps() {
  if (cache.has('hextile')) return cache.get('hextile');
  const S = 512, r = rng(93), col = canvas(S, S), hgt = canvas(S, S), orm = canvas(S, S);
  const c = ctxOf(col), hh = ctxOf(hgt), o = ctxOf(orm), nx = 7, ny = 8, w = S / nx, rowH = S / ny, a = rowH / 1.5, gap = 1.6;
  c.fillStyle = '#060607'; c.fillRect(0, 0, S, S); hh.fillStyle = grey(40); hh.fillRect(0, 0, S, S); o.fillStyle = 'rgb(255,240,0)'; o.fillRect(0, 0, S, S);
  const hex = (g, cx, cy) => { const hw = w / 2 - gap, ha = a - gap; g.beginPath(); g.moveTo(cx, cy - ha); g.lineTo(cx + hw, cy - ha / 2); g.lineTo(cx + hw, cy + ha / 2); g.lineTo(cx, cy + ha); g.lineTo(cx - hw, cy + ha / 2); g.lineTo(cx - hw, cy - ha / 2); g.closePath(); g.fill(); };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = r(), tone = v < 0.04 ? 40 + r() * 8 : v < 0.2 ? 29 + r() * 7 : 19 + r() * 9, rough = 150 + r() * 70, cx = (i + (j % 2 ? 0.5 : 0)) * w, cy = j * rowH;
    wrapDraw(S, S, cx, cy, w, (px, py) => {
      c.fillStyle = `rgb(${tone | 0},${tone | 0},${(tone * 1.06) | 0})`; hex(c, px, py);
      hh.fillStyle = grey(190 + v * 30); hex(hh, px, py);
      o.fillStyle = `rgb(255,${rough | 0},0)`; hex(o, px, py);
    });
  }
  speckle(c, S, S, r, 2200, 10, 70, 0.2, 1.6);
  const maps = { map: tex(col, { srgb: true }), normalMap: tex(normalFromHeight(hgt, 1.6)), ormMap: tex(orm) };
  cache.set('hextile', maps); return maps;
}

// ---------------------------------------------------------------------------------------------
// Tyre tread (u around the wheel, 12 lugs per tile) and woven canopy fabric.
// ---------------------------------------------------------------------------------------------
export function treadMaps() {
  if (cache.has('tread')) return cache.get('tread');
  // One tile = one pitch of the tread round the tyre (u) by the tyre's width (v): two rows of raked lugs meeting at a
  // centre groove, each lug with a chamfered edge and two sipes, shoulder blocks at the edges. Drawn at 512 so a lug
  // has an edge when the camera sits beside the wheel.
  const W = 512, Hh = 512, col = canvas(W, Hh), hgt = canvas(W, Hh), c = ctxOf(col), hh = ctxOf(hgt), r = rng(8);
  c.fillStyle = '#2b2d30'; c.fillRect(0, 0, W, Hh); hh.fillStyle = grey(30); hh.fillRect(0, 0, W, Hh);
  const n = 4, pw = W / n, half = Hh * 0.5;
  const lug = (g, x, ya, yb, rake, inset, fill) => {
    g.fillStyle = fill; g.beginPath();
    g.moveTo(x + inset, ya + inset); g.lineTo(x + pw * 0.56 - inset, ya + inset);
    g.lineTo(x + pw * 0.56 + rake - inset, yb - inset); g.lineTo(x + rake + inset, yb - inset); g.closePath(); g.fill();
  };
  for (let i = -1; i <= n; i++) for (const side of [0, 1]) {
    const x = i * pw + (side ? pw / 2 : 0), ya = side ? half + 10 : Hh * 0.11, yb = side ? Hh * 0.89 : half - 10, rake = (side ? -1 : 1) * pw * 0.26;
    const x0 = side ? x - rake : x;
    lug(hh, x0, ya, yb, rake, 4, grey(150)); lug(hh, x0, ya, yb, rake, 12, grey(232));      // chamfer, then the flat top
    lug(c, x0, ya, yb, rake, 4, '#3b3d41'); lug(c, x0, ya, yb, rake, 12, '#4d5055');
    // sipes: two thin cuts across each lug
    for (const u of [0.36, 0.68]) {
      const yy = ya + (yb - ya) * u, xs = x0 + rake * u;
      for (const [g, f] of [[hh, grey(70)], [c, '#2f3134']]) { g.fillStyle = f; g.fillRect(xs + 14, yy - 2, pw * 0.56 - 28, 4); }
    }
    // shoulder block at the tyre's edge, between the lugs
    const ys = side ? Hh * 0.91 : 0, xsb = x0 + pw * 0.62 + (side ? rake : 0);
    for (const [g, f] of [[hh, grey(190)], [c, '#44474b']]) { g.fillStyle = f; g.fillRect(xsb, ys + 5, pw * 0.3, Hh * 0.09 - 10); }
  }
  speckle(c, W, Hh, r, 5200, 60, 150, 0.22, 2);
  const maps = { map: tex(col, { srgb: true, aniso: 16 }), normalMap: tex(normalFromHeight(hgt, 3.5), { aniso: 16 }) };
  cache.set('tread', maps); return maps;
}
export function fabricMaps() {
  if (cache.has('fabric')) return cache.get('fabric');
  const S = 256, col = canvas(S, S), hgt = canvas(S, S), c = ctxOf(col), hh = ctxOf(hgt);
  c.fillStyle = '#f4f4f2'; c.fillRect(0, 0, S, S); hh.fillStyle = grey(128); hh.fillRect(0, 0, S, S);
  for (let i = 0; i < S; i += 4) { c.fillStyle = 'rgba(0,0,0,0.035)'; c.fillRect(i, 0, 1, S); c.fillRect(0, i, S, 1); hh.fillStyle = grey(100, 0.5); hh.fillRect(i, 0, 1, S); hh.fillRect(0, i, S, 1); }
  for (let i = 0; i < S; i += 32) { c.fillStyle = 'rgba(0,0,0,0.12)'; c.fillRect(i, 0, 2, S); c.fillRect(0, i, S, 2); hh.fillStyle = grey(210); hh.fillRect(i, 0, 3, S); hh.fillRect(0, i, S, 3); }
  const maps = { map: tex(col, { srgb: true }), normalMap: tex(normalFromHeight(hgt, 1.5)) };
  cache.set('fabric', maps); return maps;
}

// Emissive ramp for nozzle interiors: v = 0 at the throat (white hot) → v = 1 at the exit (dim).
export function glowRamp() {
  if (cache.has('glow')) return cache.get('glow');
  const c = canvas(4, 128), g = ctxOf(c), gr = g.createLinearGradient(0, 128, 0, 0);
  gr.addColorStop(0, '#fff3d6'); gr.addColorStop(0.3, '#ff9a3a'); gr.addColorStop(0.65, '#8a3208'); gr.addColorStop(1, '#2a0b02');
  g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
  const t = tex(c, { srgb: true, repeat: false }); t.wrapS = THREE.RepeatWrapping; cache.set('glow', t); return t;
}

// Re-entry glow over a heat shield: v = 0 at the stagnation point (centre, white hot) → v = 1 at the shoulder,
// where the flow turns the corner and heats the rim again before the glow dies away.
export function heatRamp() {
  if (cache.has('heat')) return cache.get('heat');
  const c = canvas(4, 128), g = ctxOf(c), gr = g.createLinearGradient(0, 128, 0, 0);
  gr.addColorStop(0, '#fff0c8'); gr.addColorStop(0.22, '#ffb04a'); gr.addColorStop(0.55, '#e0521a'); gr.addColorStop(0.8, '#b02c0c'); gr.addColorStop(0.9, '#ff7a2a'); gr.addColorStop(0.96, '#7a1c06'); gr.addColorStop(1, '#000000');
  g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
  const t = tex(c, { srgb: true, repeat: false }); t.wrapS = THREE.RepeatWrapping; cache.set('heat', t); return t;
}

// ---------------------------------------------------------------------------------------------
// Decal atlas (RGBA, 1024²). Rows at the top tile in u; the rest are stamps addressed by rect.
// Every marking here is original Starwright art: the four-point star, stencil words, hazard bands.
// ---------------------------------------------------------------------------------------------
export const DECALS = {};          // name → [x, y, w, h] in pixels
export const DECAL_ROWS = {};      // name → [y, h, tileWidthPx] bands that repeat across the full width
const ATLAS = 1024;
function star(g, x, y, R, color) {
  g.fillStyle = color; g.beginPath();
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 - Math.PI / 2, rr = i % 2 ? R * 0.3 : R * (i % 4 === 0 ? 1 : 0.7); g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  g.closePath(); g.fill();
}
function stencil(g, text, x, y, px, color, { align = 'left', weight = 800, spacing = 2 } = {}) {
  g.font = `${weight} ${px}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`; g.textBaseline = 'middle'; g.textAlign = align; g.fillStyle = color;
  try { g.letterSpacing = spacing + 'px'; } catch { /* older canvas */ }
  g.fillText(text, x, y);
  // stencil bridges: thin gaps through the glyphs
  const w = g.measureText(text).width, x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  g.save(); g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000';
  for (let bx = x0 + px * 0.33; bx < x0 + w; bx += px * 0.62) g.fillRect(bx, y - px * 0.6, Math.max(1.5, px * 0.045), px * 1.2);
  g.restore();
}
export function decalAtlas() {
  if (cache.has('decal')) return cache.get('decal');
  const c = canvas(ATLAS, ATLAS), g = ctxOf(c), r = rng(1234);
  const INK = '#20262e', TEAL = '#2ab5a6', AMBER = '#f2a33a', RED = '#c8402f', WHITE = '#f4f5f6';
  // --- tiling rows
  let y = 0;
  const row = (name, h, tile, draw) => { DECAL_ROWS[name] = [y, h, tile]; g.save(); g.beginPath(); g.rect(0, y, ATLAS, h); g.clip(); for (let x = 0; x < ATLAS; x += tile) draw(x, y, tile, h); g.restore(); y += h + 4; };
  row('hazard', 64, 64, (x, yy, w, h) => { g.fillStyle = AMBER; g.fillRect(x, yy, w, h); g.fillStyle = '#17191d'; g.beginPath(); g.moveTo(x, yy + h); g.lineTo(x + w / 2, yy + h); g.lineTo(x + w, yy); g.lineTo(x + w / 2, yy); g.closePath(); g.fill(); });
  row('checker', 64, 128, (x, yy, w, h) => { g.fillStyle = '#16181c'; g.fillRect(x, yy, w / 2, h / 2); g.fillRect(x + w / 2, yy + h / 2, w / 2, h / 2); g.fillStyle = WHITE; g.fillRect(x + w / 2, yy, w / 2, h / 2); g.fillRect(x, yy + h / 2, w / 2, h / 2); });
  row('dash', 24, 64, (x, yy, w, h) => { g.fillStyle = RED; g.fillRect(x + 4, yy + 6, w * 0.55, h - 12); });
  row('ticks', 32, 32, (x, yy, w, h) => { g.fillStyle = INK; g.fillRect(x + 2, yy + 4, 3, h - 8); g.fillRect(x + 17, yy + 14, 2, h - 18); });
  row('tealstripe', 40, 256, (x, yy, w, h) => { g.fillStyle = TEAL; g.fillRect(x, yy + 4, w, h - 18); g.fillStyle = '#157f76'; g.fillRect(x, yy + h - 10, w, 5); });
  // --- stamps
  let sx = 0, sy = y + 4, rowH = 0;
  const stamp = (name, w, h, draw) => {
    if (sx + w > ATLAS) { sx = 0; sy += rowH + 6; rowH = 0; }
    DECALS[name] = [sx, sy, w, h]; g.save(); g.translate(sx, sy); g.beginPath(); g.rect(0, 0, w, h); g.clip(); draw(w, h); g.restore();
    sx += w + 6; rowH = Math.max(rowH, h);
  };
  const word = (name, text, color = INK, px = 54) => stamp(name, Math.round(px * 0.62 * text.length + 30), px + 20, (w, h) => stencil(g, text, w / 2, h / 2 + 2, px, color, { align: 'center' }));
  stamp('wordmark', 420, 96, (w, h) => { star(g, 46, h / 2, 40, TEAL); star(g, 46, h / 2, 17, WHITE); stencil(g, 'STARWRIGHT', 100, h / 2 + 2, 56, INK, { spacing: 3 }); });
  stamp('roundel', 128, 128, (w, h) => { g.fillStyle = INK; g.beginPath(); g.arc(64, 64, 62, 0, TAU); g.fill(); g.fillStyle = WHITE; g.beginPath(); g.arc(64, 64, 54, 0, TAU); g.fill(); g.fillStyle = TEAL; g.beginPath(); g.arc(64, 64, 48, 0, TAU); g.fill(); star(g, 64, 64, 42, WHITE); star(g, 64, 64, 14, AMBER); });
  stamp('starmark', 96, 96, (w, h) => { star(g, 48, 48, 46, TEAL); star(g, 48, 48, 20, WHITE); });
  stamp('flag', 160, 96, (w, h) => { g.fillStyle = WHITE; g.fillRect(0, 0, w, h); g.fillStyle = TEAL; g.fillRect(4, 4, w - 8, h - 8); g.fillStyle = AMBER; g.fillRect(4, h - 30, w - 8, 12); star(g, 46, 40, 28, WHITE); g.strokeStyle = INK; g.lineWidth = 3; g.strokeRect(1.5, 1.5, w - 3, h - 3); });
  word('fuel', 'FUEL'); word('oxidiser', 'LOX'); word('mono', 'MONO'); word('xenon', 'XENON'); word('solid', 'SOLID'); word('sw', 'SW');
  word('noStep', 'NO STEP', RED, 40); word('rescue', 'RESCUE', RED, 44); word('exit', 'HATCH', INK, 40); word('lift', 'LIFT HERE', INK, 34);
  word('danger', 'DANGER', RED, 46); word('hot', 'HOT SURFACE', RED, 34); word('vent', 'VENT', INK, 36); word('probe', 'AUTOPILOT', INK, 34);
  for (const n of ['01', '02', '03', '04', '05', '07', '12', '27']) word('n' + n, n, INK, 64);
  for (const [n, t] of [['sizeS', 'S·0.6'], ['sizeM', 'M·1.25'], ['sizeL', 'L·2.5'], ['sizeXL', 'XL·3.75']]) word(n, t, INK, 40);
  stamp('arrowUp', 72, 110, (w, h) => { g.fillStyle = RED; g.beginPath(); g.moveTo(36, 4); g.lineTo(68, 50); g.lineTo(48, 50); g.lineTo(48, 106); g.lineTo(24, 106); g.lineTo(24, 50); g.lineTo(4, 50); g.closePath(); g.fill(); });
  stamp('warnTri', 110, 100, (w, h) => { g.fillStyle = AMBER; g.strokeStyle = INK; g.lineWidth = 8; g.lineJoin = 'round'; g.beginPath(); g.moveTo(55, 8); g.lineTo(102, 92); g.lineTo(8, 92); g.closePath(); g.fill(); g.stroke(); g.fillStyle = INK; g.fillRect(50, 36, 10, 32); g.fillRect(50, 74, 10, 10); });
  stamp('atom', 110, 110, (w, h) => { g.fillStyle = AMBER; g.beginPath(); g.arc(55, 55, 53, 0, TAU); g.fill(); g.strokeStyle = INK; g.lineWidth = 5; for (let i = 0; i < 3; i++) { g.beginPath(); g.ellipse(55, 55, 44, 16, i * Math.PI / 3, 0, TAU); g.stroke(); } g.fillStyle = INK; g.beginPath(); g.arc(55, 55, 9, 0, TAU); g.fill(); });
  stamp('bolt', 90, 110, (w, h) => { g.fillStyle = AMBER; g.strokeStyle = INK; g.lineWidth = 5; g.lineJoin = 'round'; g.beginPath(); g.moveTo(54, 4); g.lineTo(14, 62); g.lineTo(40, 62); g.lineTo(30, 106); g.lineTo(76, 44); g.lineTo(48, 44); g.closePath(); g.fill(); g.stroke(); });
  stamp('placard', 150, 90, (w, h) => { g.fillStyle = '#e9e4d2'; g.fillRect(0, 0, w, h); g.strokeStyle = INK; g.lineWidth = 4; g.strokeRect(2, 2, w - 4, h - 4); g.fillStyle = RED; g.fillRect(10, 10, w - 20, 16); g.fillStyle = INK; for (let i = 0; i < 5; i++) g.fillRect(10, 34 + i * 10, 60 + r() * 66, 4); });
  stamp('serial', 230, 46, (w, h) => stencil(g, 'SW-204 · LOT 7', w / 2, h / 2 + 1, 28, INK, { align: 'center', weight: 700 }));
  stamp('stripeTeal', 64, 64, (w, h) => { g.fillStyle = TEAL; g.fillRect(0, 0, w, h); });
  stamp('stripeDark', 64, 64, (w, h) => { g.fillStyle = INK; g.fillRect(0, 0, w, h); });
  stamp('target', 128, 128, (w, h) => { g.strokeStyle = WHITE; g.lineWidth = 7; for (const rr of [56, 34]) { g.beginPath(); g.arc(64, 64, rr, 0, TAU); g.stroke(); } g.fillStyle = WHITE; g.fillRect(60, 2, 8, 124); g.fillRect(2, 60, 124, 8); g.fillStyle = AMBER; g.beginPath(); g.arc(64, 64, 12, 0, TAU); g.fill(); });
  word('sizeXXL', 'XXL·5.6', INK, 40);
  // weathering: knock tiny holes out of every marking
  g.save(); g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 5200; i++) { g.fillStyle = `rgba(0,0,0,${0.25 + r() * 0.6})`; const s = 0.6 + r() * r() * 3.2; g.fillRect(r() * ATLAS, r() * ATLAS, s, s * (0.5 + r())); }
  for (let i = 0; i < 160; i++) { g.strokeStyle = `rgba(0,0,0,${0.2 + r() * 0.4})`; g.lineWidth = 0.7 + r(); const x = r() * ATLAS, yy = r() * ATLAS; g.beginPath(); g.moveTo(x, yy); g.lineTo(x + (r() - 0.5) * 60, yy + (r() - 0.5) * 18); g.stroke(); }
  g.restore();
  const t = tex(c, { srgb: true, repeat: false }); t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  cache.set('decal', t); return t;
}
/** UV rect [u0, v0, u1, v1] of a stamp (v up). */
export function decalUV(name) {
  decalAtlas();
  const d = DECALS[name]; if (!d) throw new Error('unknown decal ' + name);
  return [d[0] / ATLAS, 1 - (d[1] + d[3]) / ATLAS, (d[0] + d[2]) / ATLAS, 1 - d[1] / ATLAS, d[2] / d[3]];
}
/** Tiling band: { v0, v1, tileU (fraction of the atlas width per repeat), aspect (tile w / h) }. */
export function decalRow(name) {
  decalAtlas();
  const d = DECAL_ROWS[name]; if (!d) throw new Error('unknown decal row ' + name);
  return { v0: 1 - (d[0] + d[1]) / ATLAS, v1: 1 - d[0] / ATLAS, tileU: d[2] / ATLAS, aspect: d[2] / d[1] };
}

export function disposePartTextures() {
  for (const v of cache.values()) { if (v.isTexture) v.dispose(); else for (const t of Object.values(v)) if (t && t.isTexture) t.dispose(); }
  cache.clear();
}
