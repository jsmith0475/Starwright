// Starwright — the Flight Center: a fully 3D, procedural space centre on a coastal plain.
//
//   createBase({ quality = 'high', interactive = false, planetRadius = 0 }) -> {
//     group,                    THREE.Group in the local pad frame (see below)
//     buildings,                [{ id, name, blurb, object3d, focus: Vector3, radius, pick }]
//     padAnchor, runwayAnchor,  Object3D where vessels stand (runwayAnchor.userData.heading = 90, east)
//     update(dt, { sunDir, timeOfDay }),   animates lights, dishes, flags, vehicles, walking Pips, doors, the crawler
//     setDoor(id, open),        'hangar' | 'spaceplane': 0 closed … 1 open; the door glides there (default closed)
//     setDisplay(mode),         'none' (default: the pad is empty, the crawler is parked) | 'rollout' (a show rocket rides
//                               the crawler from the assembly building to the pad, then stands there) | 'pad' (it stands
//                               on the pad at once). The flight scene leaves this at 'none': the pad is the player's.
//     display,                  the current mode ('none' | 'rollout' | 'pad')
//     fitPad(plan, {open}),     dress the pad for the rocket on it: the launch mount and hold-down clamps under it and the
//                               tower's arms out to its hull, from planPadFit(vessel) (js/render/padfit.js). No plan: the
//                               bare pad, arms at their stock length. `open`: start with clamps and arms let go.
//     setPadState({arms, clamps}),  0 = on the rocket, 1 = let go (the arms swing back to the tower, the clamps tip away)
//     setDetail(level),         vegetation detail 'low' | 'medium' | 'high' | 'ultra'; `vegetation` reports what is drawn
//     dispose(),
//   }
//
// Local frame: origin at the pad centre on the ground, +Y up, +X east, +Z south (north is −Z). Metres.
// Pad clearances (the flight scene relies on these): the pad deck top is at y = +0.04; nothing fixed comes closer
// than 10 m to the pad axis. What does come closer is fitted to the rocket that is there (fitPad): the launch mount
// and its clamps round the rocket's base and the tower's swing arms, which end on its hull; the service tower is
// centred at x = +17; the flame channel runs toward −Z; the crawlerway arrives from +Z.
// The runway centreline is z = +850, from x = −950 (west threshold) to x = +1050; runwayAnchor is at
// (−850, 0, 850), about 1.2 km south-west of the pad, heading east.
//
// `planetRadius` (optional, metres): bend everything down by d²/2R so the base hugs a spherical world
// instead of a flat plane (the default 0 keeps it flat, which is what the hub's own ground uses).
// `interactive: true` also builds invisible pick boxes (building.pick) for mouse picking.
//
// Everything is procedural: merged static geometry per material (one draw call each), instancing for trees,
// cars and lamps, canvas-generated colour / normal / emissive textures (cached at module level).
// Materials are authored for the game's renderer contract (sRGB output, ACES, shadows, log depth).
import * as THREE from '../lib/three.module.min.js';
import { createTreeSystem, createGrass, vegLevel } from './flora.js';
import { perf } from '../perf.js';
import { DEFAULT_ARMS, PAD_TOWER, drawMount, drawJaw, drawArm } from './padfit.js';

// This module deliberately imports nothing but three.js: the hub (and so the whole game shell) must keep working
// whatever state the other render modules are in.
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const _mc = new THREE.Color();
/** Merge [{ geo, color, m, uScale, vScale }] into one non-indexed geometry with position / normal / uv / color.
 *  `color` is a hex number or a function (outColor, x, y, z) evaluated per vertex after the transform. */
export function mergeGeometries(items) {
  let n = 0;
  const parts = items.map(({ geo, color, m, uScale, vScale }) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (m) g.applyMatrix4(m);
    n += g.attributes.position.count;
    return { g, color, uScale: uScale || 1, vScale: vScale || 1 };
  });
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3);
  let o = 0;
  for (const { g, color, uScale, vScale } of parts) {
    const c = g.attributes.position.count, pa = g.attributes.position.array;
    pos.set(pa.subarray(0, c * 3), o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
    if (g.attributes.uv) { const a = g.attributes.uv.array; for (let i = 0; i < c; i++) { uv[(o + i) * 2] = a[i * 2] * uScale; uv[(o + i) * 2 + 1] = a[i * 2 + 1] * vScale; } }
    if (typeof color === 'function') for (let i = 0; i < c; i++) { color(_mc, pa[i * 3], pa[i * 3 + 1], pa[i * 3 + 2]); col[(o + i) * 3] = _mc.r; col[(o + i) * 3 + 1] = _mc.g; col[(o + i) * 3 + 2] = _mc.b; }
    else { _mc.set(color ?? 0xffffff); for (let i = 0; i < c; i++) { col[(o + i) * 3] = _mc.r; col[(o + i) * 3 + 1] = _mc.g; col[(o + i) * 3 + 2] = _mc.b; } }
    o += c; g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere(); out.computeBoundingBox();
  return out;
}
const _Y = V3(0, 1, 0);
const TAU = Math.PI * 2;

export const BASE_BUILDINGS = [
  { id: 'hangar', name: 'Vehicle Assembly Building', blurb: 'Design and assemble rockets.' },
  { id: 'pad', name: 'Launch Pad', blurb: 'Roll a rocket out and fly it.' },
  { id: 'runway', name: 'Runway', blurb: 'Take off with planes and rovers.' },
  { id: 'spaceplane', name: 'Spaceplane Hangar', blurb: 'Build aircraft and wheeled craft.' },
  { id: 'tracking', name: 'Tracking Station', blurb: 'Follow every vessel in flight.' },
  { id: 'research', name: 'Research Lab', blurb: 'Spend science on new technology.' },
  { id: 'missions', name: 'Mission Control', blurb: 'Contracts, milestones and the science archive.' },
  { id: 'crew', name: 'Crew Quarters', blurb: 'Meet, hire and train the Pips.' },
  { id: 'school', name: 'Flight School', blurb: 'Lessons and reference for new pilots.' },
  { id: 'admin', name: 'Administration', blurb: 'Settings, saves and the main menu.' },
];

/** Where each building stands (local frame, metres). Shared with the hub camera and the ground builder. */
export const BASE_LAYOUT = {
  pad: [0, 0], hangar: [0, 520], missions: [300, 470], admin: [-300, 548], research: [-540, 300],
  tracking: [640, 210], crew: [520, 740], school: [-360, 716], spaceplane: [-720, 700], runway: [50, 850],
  runwayX: [-950, 1050], runwayZ: 850, bounds: [-1250, -330, 1350, 1060],
};

const C = {
  white: 0xe4e7ea, shell: 0xcfd4d9, cream: 0xd6cfbd, slate: 0x39414c, dark: 0x171b20, teal: 0x1e9c90, tealDeep: 0x14695f,
  amber: 0xe59a2f, red: 0xc5382b, orange: 0xe2702a, steel: 0x8b949e, steelDark: 0x555d66, conc: 0xb9b5aa, concDark: 0x8c8981,
  asphalt: 0x3a3c40, asphaltLight: 0x53565a, gravel: 0xa39880, scorch: 0x2c2926, line: 0xe9e6dc, yellow: 0xe0b23a,
};

// ---------------------------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------------------------
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Tileable value noise: n(x, y, period) with integer `period` ≤ 64 lattice cells. */
export function makeNoise(seed) {
  const r = rng(seed), N = 64, t = new Float32Array(N * N);
  for (let i = 0; i < t.length; i++) t[i] = r();
  const at = (x, y, p) => t[((((y % p) + p) % p) % N) * N + ((((x % p) + p) % p) % N)];
  return (x, y, p = N) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (at(xi, yi, p) * (1 - sx) + at(xi + 1, yi, p) * sx) * (1 - sy) + (at(xi, yi + 1, p) * (1 - sx) + at(xi + 1, yi + 1, p) * sx) * sy;
  };
}
function fbm(n, u, v, base, oct) { let s = 0, a = 0.5, f = base, tot = 0; for (let i = 0; i < oct; i++) { s += a * n(u * f, v * f, f); tot += a; a *= 0.5; f *= 2; } return s / tot; }

function cv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function tex(canvas, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
/** Fill a canvas from fn(u, v) → grey 0..255 (or [r,g,b]). */
function paint(canvas, fn) {
  const w = canvas.width, h = canvas.height, g = canvas.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  for (let y = 0, o = 0; y < h; y++) for (let x = 0; x < w; x++, o += 4) {
    const v = fn(x / w, y / h);
    if (typeof v === 'number') { d[o] = d[o + 1] = d[o + 2] = v; } else { d[o] = v[0]; d[o + 1] = v[1]; d[o + 2] = v[2]; }
    d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return g;
}
/** Tangent-space normal map from a greyscale height canvas (tileable). */
export function normalFromHeight(canvas, strength = 2) {
  const w = canvas.width, h = canvas.height, src = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const out = cv(w, h), g = out.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  const H = (x, y) => src[((((y % h) + h) % h) * w + (((x % w) + w) % w)) * 4];
  for (let y = 0, o = 0; y < h; y++) for (let x = 0; x < w; x++, o += 4) {
    const dx = (H(x + 1, y) - H(x - 1, y)) / 255 * strength, dy = (H(x, y + 1) - H(x, y - 1)) / 255 * strength;
    const l = 1 / Math.hypot(dx, dy, 1);
    d[o] = (-dx * l * 0.5 + 0.5) * 255; d[o + 1] = (dy * l * 0.5 + 0.5) * 255; d[o + 2] = (l * 0.5 + 0.5) * 255; d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Textures (generated once, shared by every base instance)
// ---------------------------------------------------------------------------------------------
const TILE = { paint: 16, concrete: 14, asphalt: 9, gravel: 10, smooth: 8, metal: 8 };
let TEX = null;
const FONT = 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Helvetica Neue", Arial, sans-serif';

function starPath(g, cx, cy, R, r) {
  g.beginPath();
  for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4 - Math.PI / 2, rad = i % 2 ? r : R; g[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); }
  g.closePath();
}

function buildTextures() {
  const n1 = makeNoise(11), n2 = makeNoise(29), rnd = rng(77);
  const T = {};
  { // painted metal siding: ribs every 0.5 m, panel seams every 4 m (tile = 16 m), streaks of grime
    const S = 512, c = cv(S, S), hgt = cv(S, S);
    const g = paint(c, (u, v) => 222 + fbm(n1, u, v, 4, 4) * 26 + (n2(u * 64, v * 64, 64) - 0.5) * 6);
    const gh = paint(hgt, () => 128);
    for (let x = 0; x < S; x += 16) { g.fillStyle = 'rgba(0,0,0,0.07)'; g.fillRect(x, 0, 2, S); g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(x + 2, 0, 2, S); gh.fillStyle = '#5a5a5a'; gh.fillRect(x, 0, 3, S); gh.fillStyle = '#9c9c9c'; gh.fillRect(x + 7, 0, 4, S); }
    for (let y = 0; y < S; y += 128) {
      for (let px = 0; px < S; px += 128) { const tint = (rnd() - 0.5) * 0.09; g.fillStyle = tint > 0 ? `rgba(255,255,255,${tint})` : `rgba(0,0,0,${-tint})`; g.fillRect(px, y, 128, 128); }
      g.fillStyle = 'rgba(20,24,28,0.42)'; g.fillRect(0, y, S, 3); gh.fillStyle = '#202020'; gh.fillRect(0, y, S, 4);
      const off = (y / 128) % 2 ? 64 : 0;
      for (let x = off; x < S; x += 256) { g.fillStyle = 'rgba(20,24,28,0.3)'; g.fillRect(x, y, 2, 128); gh.fillStyle = '#303030'; gh.fillRect(x, y, 3, 128); }
    }
    for (let i = 0; i < 90; i++) { // rain streaks below seams
      const x = rnd() * S, y = Math.floor(rnd() * 4) * 128 + 3, len = 30 + rnd() * 110, w = 2 + rnd() * 9;
      const gr = g.createLinearGradient(0, y, 0, y + len); gr.addColorStop(0, `rgba(70,62,50,${0.08 + rnd() * 0.14})`); gr.addColorStop(1, 'rgba(70,62,50,0)');
      g.fillStyle = gr; g.fillRect(x, y, w, len);
    }
    T.paint = tex(c); T.paintN = tex(normalFromHeight(hgt, 3), { srgb: false });
  }
  { // concrete slabs: joints every 7 m (tile = 14 m), blotches, stains, tyre marks
    const S = 512, c = cv(S, S), hgt = cv(S, S);
    const g = paint(c, (u, v) => { const b = fbm(n2, u, v, 3, 5); return 196 + b * 48 + (n1(u * 64, v * 64, 64) - 0.5) * 18; });
    const gh = paint(hgt, (u, v) => 120 + n1(u * 64, v * 64, 64) * 16);
    for (let i = 0; i < 2; i++) { const p = i * 256; g.fillStyle = 'rgba(30,30,28,0.5)'; g.fillRect(p, 0, 3, S); g.fillRect(0, p, S, 3); gh.fillStyle = '#101010'; gh.fillRect(p, 0, 4, S); gh.fillRect(0, p, S, 4); }
    for (let i = 0; i < 26; i++) { const x = rnd() * S, y = rnd() * S, r = 8 + rnd() * 34; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(40,36,30,${0.06 + rnd() * 0.16})`); gr.addColorStop(1, 'rgba(40,36,30,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); }
    g.strokeStyle = 'rgba(30,30,30,0.22)'; g.lineWidth = 1;
    for (let i = 0; i < 14; i++) { let x = rnd() * S, y = rnd() * S; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (rnd() - 0.5) * 50; y += (rnd() - 0.5) * 50; g.lineTo(x, y); } g.stroke(); }
    T.concrete = tex(c); T.concreteN = tex(normalFromHeight(hgt, 2.2), { srgb: false });
  }
  { // asphalt: fine dark aggregate with patches and a faint seam
    const S = 256, c = cv(S, S);
    const g = paint(c, (u, v) => 150 + fbm(n1, u, v, 4, 4) * 50 + (n2(u * 64, v * 64, 64) - 0.5) * 60 * (0.5 + rnd() * 0.5));
    for (let i = 0; i < 9; i++) { g.fillStyle = `rgba(0,0,0,${0.05 + rnd() * 0.1})`; g.fillRect(rnd() * S, rnd() * S, 20 + rnd() * 70, 14 + rnd() * 50); }
    T.asphalt = tex(c);
  }
  { // windows: an 8 × 8 grid of glazed cells, plus the matching "lit at night" emissive map
    const S = 512, n = 8, cs = S / n, c = cv(S, S), e = cv(S, S), g = c.getContext('2d'), ge = e.getContext('2d');
    g.fillStyle = '#8f98a2'; g.fillRect(0, 0, S, S); ge.fillStyle = '#000'; ge.fillRect(0, 0, S, S);
    const warm = ['#ffd9a0', '#ffe9c4', '#ffc878', '#fff1d8', '#cfe4ff'];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = i * cs + 5, y = j * cs + 7, w = cs - 10, h = cs - 14, k = rnd();
      const gr = g.createLinearGradient(0, y, 0, y + h); const l = 20 + k * 22;
      gr.addColorStop(0, `rgb(${l + 22},${l + 52},${l + 70})`); gr.addColorStop(1, `rgb(${l - 8},${l + 8},${l + 22})`);
      g.fillStyle = gr; g.fillRect(x, y, w, h);
      g.fillStyle = 'rgba(255,255,255,0.10)'; g.beginPath(); g.moveTo(x + w * 0.15, y + h); g.lineTo(x + w * 0.55, y); g.lineTo(x + w * 0.75, y); g.lineTo(x + w * 0.35, y + h); g.fill();
      if (rnd() < 0.22) { g.fillStyle = 'rgba(214,220,226,0.75)'; g.fillRect(x, y, w, h * (0.25 + rnd() * 0.5)); }      // blinds
      g.fillStyle = '#6d7680'; g.fillRect(x + w / 2 - 1, y, 2, h);
      if (rnd() < 0.42) {
        ge.globalAlpha = 0.45 + rnd() * 0.55; ge.fillStyle = warm[Math.floor(rnd() * warm.length)]; ge.fillRect(x, y, w, h);
        ge.globalAlpha = 0.35; ge.fillStyle = '#000'; ge.fillRect(x, y + h * 0.62, w, h * 0.38); ge.globalAlpha = 1;
      }
    }
    T.window = tex(c); T.windowLit = tex(e);
  }
  { // chain-link fence (alpha), light pool, soft glow dot
    const S = 128, c = cv(S, S), g = c.getContext('2d'); g.clearRect(0, 0, S, S); g.strokeStyle = 'rgba(190,198,206,0.85)'; g.lineWidth = 2.2;
    for (let i = -S; i < S * 2; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + S, S); g.stroke(); g.beginPath(); g.moveTo(i, S); g.lineTo(i + S, 0); g.stroke(); }
    g.fillStyle = 'rgba(200,206,212,1)'; g.fillRect(0, 0, S, 7); g.fillRect(0, S - 5, S, 5);
    T.fence = tex(c, { aniso: 4 });
    const p = cv(128, 128), gp = p.getContext('2d'), gr = gp.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.14)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    gp.fillStyle = gr; gp.fillRect(0, 0, 128, 128);
    T.pool = tex(p, { repeat: false, aniso: 1 });
  }
  { // decal atlas: wordmark, emblem, runway numbers, signs (white art is tinted by vertex colour)
    const S = 2048, c = cv(S, S), g = c.getContext('2d'); g.clearRect(0, 0, S, S);
    const R = {}; let px = 0, py = 0, rowH = 0;
    const put = (name, w, h, draw) => {
      if (px + w > S) { px = 0; py += rowH + 8; rowH = 0; }
      g.save(); g.translate(px, py); g.beginPath(); g.rect(0, 0, w, h); g.clip(); draw(g, w, h); g.restore();
      R[name] = [(px + 1) / S, 1 - (py + h - 1) / S, (px + w - 1) / S, 1 - (py + 1) / S]; px += w + 8; rowH = Math.max(rowH, h);
    };
    const text = (str, color = '#fff', weight = 800, fit = 0.9) => (g2, w, h) => {
      g2.fillStyle = color; g2.textAlign = 'center'; g2.textBaseline = 'middle';
      let size = h * 0.8; g2.font = `${weight} ${size}px ${FONT}`;
      const tw = g2.measureText(str).width; if (tw > w * fit) { size *= (w * fit) / tw; g2.font = `${weight} ${size}px ${FONT}`; }
      g2.fillText(str, w / 2, h / 2 + size * 0.04);
    };
    put('wordmark', 1500, 220, (g2, w, h) => { g2.fillStyle = '#fff'; starPath(g2, 110, h / 2, 100, 30); g2.fill(); g2.textAlign = 'left'; g2.textBaseline = 'middle'; const s = 'STARWRIGHT'; let size = 170; g2.font = `800 ${size}px ${FONT}`; const tw = [...s].reduce((a, ch) => a + g2.measureText(ch).width + 14, 0); if (tw > w - 260) { size *= (w - 260) / tw; g2.font = `800 ${size}px ${FONT}`; } let x = 240; for (const ch of s) { g2.fillText(ch, x, h / 2 + 8); x += g2.measureText(ch).width + 14; } });
    put('emblem', 500, 500, (g2, w) => { const r = w / 2; g2.fillStyle = '#e59a2f'; g2.beginPath(); g2.arc(r, r, r - 6, 0, TAU); g2.fill(); g2.strokeStyle = '#fff'; g2.lineWidth = 16; g2.beginPath(); g2.arc(r, r, r - 26, 0, TAU); g2.stroke(); g2.fillStyle = '#17756c'; starPath(g2, r, r, r - 62, (r - 62) * 0.3); g2.fill(); g2.strokeStyle = '#fff'; g2.lineWidth = 8; g2.beginPath(); g2.ellipse(r, r + 30, r - 70, (r - 70) * 0.36, -0.5, 0.2, Math.PI * 1.25); g2.stroke(); });
    put('emblemMono', 400, 400, (g2, w) => { const r = w / 2; g2.strokeStyle = '#fff'; g2.lineWidth = 22; g2.beginPath(); g2.arc(r, r, r - 20, 0, TAU); g2.stroke(); g2.fillStyle = '#fff'; starPath(g2, r, r, r - 56, (r - 56) * 0.3); g2.fill(); });
    put('n09', 420, 520, text('09', '#fff', 800, 0.96)); put('n27', 420, 520, text('27', '#fff', 800, 0.96));
    put('H', 300, 300, (g2, w) => { g2.strokeStyle = '#fff'; g2.lineWidth = 18; g2.beginPath(); g2.arc(w / 2, w / 2, w / 2 - 14, 0, TAU); g2.stroke(); text('H')(g2, w, w); });
    const sign = name => put(name, 1000, 130, text(name));
    ['MISSION CONTROL', 'RESEARCH LAB', 'FLIGHT SCHOOL', 'ADMINISTRATION', 'TRACKING', 'CREW QUARTERS', 'HANGAR 2', 'PAD 1', 'VAB'].forEach(sign);
    put('clock', 700, 200, (g2, w, h) => { g2.fillStyle = '#0c0f12'; g2.fillRect(0, 0, w, h); g2.strokeStyle = '#3b4450'; g2.lineWidth = 10; g2.strokeRect(5, 5, w - 10, h - 10); g2.fillStyle = '#ffb347'; g2.textAlign = 'center'; g2.textBaseline = 'middle'; g2.font = `700 120px ui-monospace, Menlo, monospace`; g2.fillText('T-00:10:00', w / 2, h / 2 + 6); });
    put('flag', 384, 256, (g2, w, h) => { g2.fillStyle = '#e59a2f'; g2.fillRect(0, 0, w, h); g2.fillStyle = '#17756c'; g2.fillRect(0, h * 0.7, w, h * 0.3); g2.fillStyle = '#fff'; g2.fillRect(0, h * 0.66, w, h * 0.05); starPath(g2, w * 0.3, h * 0.36, h * 0.27, h * 0.085); g2.fill(); });
    put('hazard', 512, 64, (g2, w, h) => { g2.fillStyle = '#e0b23a'; g2.fillRect(0, 0, w, h); g2.fillStyle = '#1b1f25'; for (let x = -h; x < w; x += 64) { g2.beginPath(); g2.moveTo(x, h); g2.lineTo(x + h, 0); g2.lineTo(x + h + 30, 0); g2.lineTo(x + 30, h); g2.fill(); } });
    T.atlas = tex(c, { repeat: false }); T.region = R;
  }
  return T;
}

// ---------------------------------------------------------------------------------------------
// Materials (shared)
// ---------------------------------------------------------------------------------------------
let MAT = null;
const GLOW_VS = `#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 color; attribute float aSize; attribute vec3 aFx; uniform float uScale, uTime, uNight; varying vec3 vC;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
  float px = aSize * uScale / max(gl_Position.w, 1.0);
  float k = 1.0;
  if (aFx.x > 0.0) { float ph = fract(uTime / aFx.x + aFx.y); k = aFx.z > 1.5 ? smoothstep(0.0, 0.08, ph) * smoothstep(0.42, 0.3, ph) : 0.25 + 0.75 * smoothstep(0.5, 0.0, abs(ph - 0.5) * 2.0); }
  float lum = aFx.z > 0.5 ? mix(0.5, 1.0, uNight) * k : uNight * k;
  gl_PointSize = clamp(px, 2.0, 56.0);
  vC = color * lum * clamp(px / 2.0, 0.25, 1.0);
  #include <logdepthbuf_vertex>
}`;
const GLOW_FS = `#include <logdepthbuf_pars_fragment>
varying vec3 vC;
void main(){
  #include <logdepthbuf_fragment>
  float d = length(gl_PointCoord - 0.5) * 2.0; float a = pow(max(0.0, 1.0 - d), 2.4) + smoothstep(0.32, 0.0, d) * 1.6;
  gl_FragColor = vec4(vC * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function buildMaterials() {
  const T = TEX || (TEX = buildTextures());
  const std = p => new THREE.MeshStandardMaterial({ vertexColors: true, ...p });
  const ground = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
  const M = {
    paint: std({ map: T.paint, normalMap: T.paintN, normalScale: new THREE.Vector2(0.7, 0.7), roughness: 0.62, metalness: 0.12 }),
    smooth: std({ roughness: 0.42, metalness: 0.18, side: THREE.DoubleSide }),
    concrete: std({ map: T.concrete, normalMap: T.concreteN, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.93, metalness: 0 }),
    metal: std({ roughness: 0.48, metalness: 0.72 }),
    glass: new THREE.MeshStandardMaterial({ map: T.window, emissiveMap: T.windowLit, emissive: new THREE.Color(0xffd9a6), emissiveIntensity: 0, roughness: 0.16, metalness: 0.82, envMapIntensity: 1.3 }),
    slab: std({ map: T.concrete, normalMap: T.concreteN, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.93, ...ground }),
    asphalt: std({ map: T.asphalt, roughness: 0.94, ...ground, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    mark: std({ roughness: 0.78, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }),
    decal: std({ map: T.atlas, alphaTest: 0.35, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -7, polygonOffsetUnits: -7, side: THREE.DoubleSide }),
    lamp: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    screen: new THREE.MeshBasicMaterial({ map: T.atlas, side: THREE.DoubleSide }),
    pool: new THREE.MeshBasicMaterial({ map: T.pool, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -9, polygonOffsetUnits: -9 }),
    beam: new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 }),
    fence: new THREE.MeshStandardMaterial({ map: T.fence, transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.5 }),
    car: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.45 }),
    flag: new THREE.MeshStandardMaterial({ map: T.atlas, roughness: 0.85, side: THREE.DoubleSide }),
    glow: new THREE.ShaderMaterial({ uniforms: { uScale: { value: 400 }, uTime: { value: 0 }, uNight: { value: 0 } }, vertexShader: GLOW_VS, fragmentShader: GLOW_FS, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
    // contact shade: a soft dark skirt on the ground around each building (multiplies what is under it; white = no change)
    ao: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, blending: THREE.MultiplyBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }),
    pick: new THREE.MeshBasicMaterial({ visible: false }),
  };
  // [realism pass] weathering in the shader, from the position in the space centre's own frame (metres): broad stains
  // and bleached patches that never tile, a band of ground dirt up the foot of every wall, uneven roughness (so
  // concrete and asphalt catch the sun in patches), and paint markings worn through to the surface under them.
  M.grime = { value: 1 };
  const weather = (mat, mode, k) => {
    mat.onBeforeCompile = sh => {
      sh.uniforms.uGrime = M.grime;
      sh.vertexShader = 'varying vec4 vSwP;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vSwP = vec4(transformed, normal.y);');
      sh.fragmentShader = `uniform float uGrime; varying vec4 vSwP;
        float swH(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float swN(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(swH(i), swH(i + vec3(1, 0, 0)), f.x), mix(swH(i + vec3(0, 1, 0)), swH(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(swH(i + vec3(0, 0, 1)), swH(i + vec3(1, 0, 1)), f.x), mix(swH(i + vec3(0, 1, 1)), swH(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
        float swG2 = 0.5;\n` + sh.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>
          if (uGrime > 0.5) {
            float g1 = swN(vSwP.xyz * 0.043), g2 = swN(vSwP.xyz * 0.19 + 7.3), g3 = swN(vSwP.xyz * 1.9 + 3.1); swG2 = g2;
            ${mode === 2 ? `float wear = smoothstep(0.5, 0.82, g3 * 0.45 + swN(vSwP.xyz * 7.0) * 0.3 + g2 * 0.4);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.075, 0.075, 0.08), wear * ${k.toFixed(2)});`
            : mode === 1 ? `// asphalt: fine aggregate grain, faint broad tone, lighter patched rectangles and seams (no big stains)
            float swD = length(vViewPosition), swNear = 1.0 - smoothstep(25.0, 140.0, swD);
            float fine = mix(0.5, swN(vSwP.xyz * 11.0) * 0.6 + swN(vSwP.xyz * 37.0) * 0.4, swNear); swG2 = 0.5 + (fine - 0.5) * 1.6;
            diffuseColor.rgb *= (0.86 + 0.28 * fine) * (0.95 + 0.1 * g1);
            vec2 pc = floor(vSwP.xz / vec2(13.0, 6.5)); float ph = swH(vec3(pc, 3.7));
            diffuseColor.rgb *= 1.0 + 0.16 * step(0.93, ph) + 0.07 * (ph - 0.5);
            vec2 sm = abs(fract(vSwP.xz / vec2(13.0, 6.5)) - 0.5); float seam = smoothstep(0.492, 0.498, max(sm.x, sm.y));
            diffuseColor.rgb *= 1.0 - 0.22 * seam * step(0.35, swH(vec3(pc, 9.1))) * (1.0 - smoothstep(60.0, 260.0, swD));
            // rubber laid down along the runway's touchdown zones and, faintly, its whole centreline (the strip runs
            // along x through its kit's origin; roads are shorter than the 600 m where the zones begin)
            float ax = abs(vSwP.x), zone = smoothstep(600.0, 700.0, ax) * (1.0 - smoothstep(880.0, 960.0, ax));
            float streak = 0.45 + 0.55 * swN(vec3(vSwP.x * 0.012, vSwP.z * 1.9, 4.0));
            float rub = exp(-vSwP.z * vSwP.z / 110.0) * zone * streak * 0.55 + exp(-vSwP.z * vSwP.z / 14.0) * 0.12 * step(300.0, ax + 300.0 * zone);
            diffuseColor.rgb *= 1.0 - min(rub, 0.6); swG2 -= rub * 0.5;`
            : `float stain = smoothstep(0.4, 0.8, g1 * 0.62 + g2 * 0.38), pale = smoothstep(0.55, 0.9, g1 * 0.3 + (1.0 - g2) * 0.7);
            diffuseColor.rgb *= mix(1.0, 0.76, stain * ${k.toFixed(2)}) * mix(1.0, 1.1, pale * ${k.toFixed(2)}) * (0.95 + 0.1 * g3);
            float wall = 1.0 - smoothstep(0.2, 0.6, abs(vSwP.w));
            float skirt = wall * (1.0 - smoothstep(0.15, 1.6 + 3.2 * g2, vSwP.y)) * step(-0.5, vSwP.y);
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.74, 0.69, 0.6), skirt * ${(k * 0.8).toFixed(2)});`}
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n roughnessFactor = clamp(roughnessFactor + (swG2 - 0.5) * ${(0.3 * k).toFixed(2)}, 0.04, 1.0);`);
    };
    mat.customProgramCacheKey = () => 'sw-weather3-' + mode + '-' + k;
  };
  // glass mirrors the sky at a glancing angle (the fog colour is the sky near the horizon; scenes without fog keep the plain glass)
  M.glass.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
      #ifdef USE_FOG
      { float swF = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 4.0); outgoingLight = mix(outgoingLight, fogColor * 1.05 + totalEmissiveRadiance, (0.08 + 0.92 * swF) * 0.7); }
      #endif
      #include <opaque_fragment>`);
  };
  M.glass.customProgramCacheKey = () => 'sw-glass';
  weather(M.concrete, 0, 0.9); weather(M.slab, 0, 1); weather(M.asphalt, 1, 1); weather(M.paint, 0, 0.55); weather(M.mark, 2, 0.7);
  M.flagTime = { value: 0 };
  M.flag.onBeforeCompile = sh => {
    sh.uniforms.uTime = M.flagTime;
    sh.vertexShader = 'uniform float uTime;\nattribute float aWave;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n float fw = aWave; transformed.z += sin(fw * 1.1 - uTime * 4.2 + position.y * 0.6) * 0.07 * fw; transformed.y += cos(fw * 0.8 - uTime * 3.1) * 0.03 * fw - fw * fw * 0.012;');
  };
  return M;
}
const CAST = { paint: 1, smooth: 1, concrete: 1, metal: 1, foliage: 1, car: 1, flag: 1 };
const NO_RECEIVE = { lamp: 1, screen: 1, pool: 1, beam: 1, glow: 1, fence: 1, decal: 1, ao: 1 };

// ---------------------------------------------------------------------------------------------
// Geometry kit: primitives with metre-scaled UVs, collected per material bucket, merged at the end
// ---------------------------------------------------------------------------------------------
const _q = new THREE.Quaternion(), _e = new THREE.Euler();
function Mx(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(V3(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), V3(sx, sy, sz));
}
function rawGeo(P, N, U) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  return g;
}
function quadInto(P, N, U, a, b, c, d, n, u0, v0, u1, v1) {
  P.push(...a, ...b, ...c, ...a, ...c, ...d); for (let i = 0; i < 6; i++) N.push(...n);
  U.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
}
/** Box with its base at y = 0, UVs in tiles of `t` metres. */
function boxGeo(w, h, d, t = 8, bottom = false) {
  const x = w / 2, z = d / 2, P = [], N = [], U = [];
  quadInto(P, N, U, [-x, 0, z], [x, 0, z], [x, h, z], [-x, h, z], [0, 0, 1], 0, 0, w / t, h / t);
  quadInto(P, N, U, [x, 0, -z], [-x, 0, -z], [-x, h, -z], [x, h, -z], [0, 0, -1], 0, 0, w / t, h / t);
  quadInto(P, N, U, [x, 0, z], [x, 0, -z], [x, h, -z], [x, h, z], [1, 0, 0], 0, 0, d / t, h / t);
  quadInto(P, N, U, [-x, 0, -z], [-x, 0, z], [-x, h, z], [-x, h, -z], [-1, 0, 0], 0, 0, d / t, h / t);
  quadInto(P, N, U, [-x, h, z], [x, h, z], [x, h, -z], [-x, h, -z], [0, 1, 0], 0, 0, w / t, d / t);
  if (bottom) quadInto(P, N, U, [-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z], [0, -1, 0], 0, 0, w / t, d / t);
  return rawGeo(P, N, U);
}
/** Horizontal quad (facing up) centred on the origin. */
function flatGeo(w, d, t = 8, uv = null) {
  const x = w / 2, z = d / 2, P = [], N = [], U = [];
  if (uv) quadInto(P, N, U, [-x, 0, z], [x, 0, z], [x, 0, -z], [-x, 0, -z], [0, 1, 0], uv[0], uv[1], uv[2], uv[3]);
  else quadInto(P, N, U, [-x, 0, z], [x, 0, z], [x, 0, -z], [-x, 0, -z], [0, 1, 0], 0, 0, w / t, d / t);
  return rawGeo(P, N, U);
}
/** Vertical quad facing +Z, base at y = 0, with explicit UV rectangle. */
/** A flat frame around a w × d rectangle, `m` metres wide (the contact shade under a building's walls). */
function skirtGeo(w, d, m) {
  const x = w / 2, z = d / 2, P = [], N = [], U = [], n = [0, 1, 0];
  quadInto(P, N, U, [-x, 0, z], [x, 0, z], [x + m, 0, z + m], [-x - m, 0, z + m], n, 0, 0, 1, 1);
  quadInto(P, N, U, [x, 0, -z], [-x, 0, -z], [-x - m, 0, -z - m], [x + m, 0, -z - m], n, 0, 0, 1, 1);
  quadInto(P, N, U, [x, 0, z], [x, 0, -z], [x + m, 0, -z - m], [x + m, 0, z + m], n, 0, 0, 1, 1);
  quadInto(P, N, U, [-x, 0, -z], [-x, 0, z], [-x - m, 0, z + m], [-x - m, 0, -z - m], n, 0, 0, 1, 1);
  return rawGeo(P, N, U);
}
function wallGeo(w, h, uv) {
  const x = w / 2, P = [], N = [], U = [];
  quadInto(P, N, U, [-x, 0, 0], [x, 0, 0], [x, h, 0], [-x, h, 0], [0, 0, 1], uv[0], uv[1], uv[2], uv[3]);
  return rawGeo(P, N, U);
}
const FACE = { s: 0, e: Math.PI / 2, n: Math.PI, w: -Math.PI / 2 };

class Kit {
  constructor(seed = 1) { this.b = Object.create(null); this.rnd = rng(seed); this.glows = []; }
  push(bucket, geo, color, m, uScale, vScale) { (this.b[bucket] || (this.b[bucket] = [])).push({ geo, color, m, uScale, vScale }); return this; }
  /** Box: centre x,z, base y0. */
  box(bucket, x, y0, z, w, h, d, color, ry = 0, bottom = false) { return this.push(bucket, boxGeo(w, h, d, TILE[bucket] || 8, bottom), color, Mx(x, y0, z, 0, ry)); }
  /** Rotated / tilted box (pivot at its base centre). */
  boxM(bucket, w, h, d, color, m) { return this.push(bucket, boxGeo(w, h, d, TILE[bucket] || 8, true), color, m); }
  flat(bucket, x, z, w, d, y, color, ry = 0) { return this.push(bucket, flatGeo(w, d, TILE[bucket] || 8), color, Mx(x, y, z, 0, ry)); }
  /** Polygon lying flat; pts are [x, z] pairs. */
  poly(bucket, pts, y, color) {
    const sh = new THREE.Shape(); pts.forEach(([x, z], i) => sh[i ? 'lineTo' : 'moveTo'](x, -z));
    const t = 1 / (TILE[bucket] || 8);
    return this.push(bucket, new THREE.ShapeGeometry(sh), color, Mx(0, y, 0, -Math.PI / 2), t, t);
  }
  disc(bucket, x, z, r, y, color, seg = 32, r0 = 0) {
    const sh = new THREE.Shape(); sh.absarc(0, 0, r, 0, TAU, false);
    if (r0 > 0) { const h = new THREE.Path(); h.absarc(0, 0, r0, 0, TAU, true); sh.holes.push(h); }
    const t = 1 / (TILE[bucket] || 8);
    return this.push(bucket, new THREE.ShapeGeometry(sh, seg), color, Mx(x, y, z, -Math.PI / 2), t, t);
  }
  /** Upright cylinder / cone: top radius r1, bottom radius r2. */
  cyl(bucket, x, y0, z, r1, r2, h, color, seg = 20, open = false) {
    const t = TILE[bucket] || 8;
    return this.push(bucket, new THREE.CylinderGeometry(r1, r2, h, seg, 1, open), color, Mx(x, y0 + h / 2, z), Math.max(1, Math.round((TAU * Math.max(r1, r2)) / t)), h / t);
  }
  /** Cylinder along an arbitrary axis between two points. */
  tube(bucket, a, b, r, color, seg = 10, r2 = r) {
    const A = V3(...a), B = V3(...b), d = B.clone().sub(A), len = d.length();
    const m = new THREE.Matrix4().compose(A.add(B).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(_Y, d.normalize()), V3(1, 1, 1));
    return this.push(bucket, new THREE.CylinderGeometry(r2, r, len, seg, 1), color, m, 1, len / (TILE[bucket] || 8));
  }
  /** Square beam between two points. */
  beam(bucket, a, b, th, color) {
    const A = V3(...a), B = V3(...b), d = B.clone().sub(A), len = d.length();
    const m = new THREE.Matrix4().compose(A.add(B).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(_Y, d.normalize()), V3(1, 1, 1));
    return this.push(bucket, new THREE.BoxGeometry(th, len, th), color, m);
  }
  sphere(bucket, x, y, z, r, color, sy = 1, seg = 20) { return this.push(bucket, new THREE.SphereGeometry(r, seg, Math.round(seg * 0.6)), color, Mx(x, y, z, 0, 0, 0, 1, sy, 1), 2, 1); }
  dome(bucket, x, y0, z, r, color, sy = 1, seg = 24) { return this.push(bucket, new THREE.SphereGeometry(r, seg, Math.round(seg / 3), 0, TAU, 0, Math.PI / 2), color, Mx(x, y0, z, 0, 0, 0, 1, sy, 1), 2, 1); }
  /** A band of windows on a wall: centre x,z of the quad, base y0; facing 's' | 'e' | 'n' | 'w'. */
  win(x, y0, z, w, h, face, cell = 3.4) {
    const nx = Math.max(1, Math.round(w / cell)), ny = Math.max(1, Math.round(h / (cell * 1.05)));
    const u0 = Math.floor(this.rnd() * 8) / 8, v0 = Math.floor(this.rnd() * 8) / 8;
    return this.push('glass', wallGeo(w, h, [u0, v0, u0 + nx / 8, v0 + ny / 8]), 0xffffff, Mx(x, y0, z, 0, FACE[face]));
  }
  /** Window bands on the faces of a box-shaped building. */
  bands(cx, cz, w, d, y0, floors, fh, faces = 'nsew', margin = 3, frac = 0.56) {
    for (let f = 0; f < floors; f++) {
      const y = y0 + f * fh + fh * (1 - frac) * 0.55, h = fh * frac, o = 0.12;
      if (faces.includes('s')) this.win(cx, y, cz + d / 2 + o, w - margin * 2, h, 's');
      if (faces.includes('n')) this.win(cx, y, cz - d / 2 - o, w - margin * 2, h, 'n');
      if (faces.includes('e')) this.win(cx + w / 2 + o, y, cz, d - margin * 2, h, 'e');
      if (faces.includes('w')) this.win(cx - w / 2 - o, y, cz, d - margin * 2, h, 'w');
    }
    return this;
  }
  /** Atlas decal on a wall (centre x,y,z) or flat on the ground (`up` = direction the art's top points, radians from −Z toward +X). */
  decalWall(name, x, y, z, w, h, face, tint = 0xffffff, bucket = 'decal') { return this.push(bucket, wallGeo(w, h, TEX.region[name]), tint, Mx(x, y - h / 2, z, 0, FACE[face])); }
  decalFlat(name, x, z, w, h, y, up = 0, tint = 0xffffff) { return this.push('decal', flatGeo(w, h, 1, TEX.region[name]), tint, Mx(x, y, z, 0, -up)); }
  /** Square lattice mast, optionally tapered (w0 at the base, w1 at the top). */
  lattice(cx, cz, w0, w1, y0, y1, n, colA, colB = colA, th = 0.3, bucket = 'metal') {
    const hw = t => (w0 + (w1 - w0) * t) / 2;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.beam(bucket, [cx + sx * hw(0), y0, cz + sz * hw(0)], [cx + sx * hw(1), y1, cz + sz * hw(1)], th * 1.25, colA);
    for (let i = 0; i <= n; i++) {
      const t = i / n, y = y0 + (y1 - y0) * t, a = hw(t), col = i % 2 ? colB : colA;
      for (const s of [-1, 1]) { this.beam(bucket, [cx - a, y, cz + s * a], [cx + a, y, cz + s * a], th * 0.75, col); this.beam(bucket, [cx + s * a, y, cz - a], [cx + s * a, y, cz + a], th * 0.75, col); }
      if (i < n) {
        const t2 = (i + 1) / n, y2 = y0 + (y1 - y0) * t2, b = hw(t2), f = i % 2 ? 1 : -1;
        for (const s of [-1, 1]) { this.beam(bucket, [cx - f * a, y, cz + s * a], [cx + f * b, y2, cz + s * b], th * 0.55, colA); this.beam(bucket, [cx + s * a, y, cz - f * a], [cx + s * b, y2, cz + f * b], th * 0.55, colA); }
      }
    }
    return this;
  }
  /** A solid shape the drawing does not make by itself (something that moves); kept only by recordSiteSolids. */
  solid() { return this; }
  /** Point light sprite. kind: 0 lamp (night only), 1 beacon (slow pulse, always), 2 strobe. */
  glow(x, y, z, color, size = 1.6, kind = 0, period = 0, phase = 0) { this.glows.push([x, y, z, color, size, period, phase, kind]); return this; }
  /** Additive light pool on the ground. */
  pool(x, z, r, color = 0xffe2b0, y = 0.2) { return this.push('pool', flatGeo(r * 2, r * 2, 1, [0, 0, 1, 1]), color, Mx(x, y, z)); }
  /** Build one mesh per bucket into `group`; `off` is the group's base-frame offset (for the glow list and curvature). */
  build(group, M, { cast = true, bend = null } = {}) {
    for (const bucket of Object.keys(this.b)) {
      const geo = mergeGeometries(this.b[bucket]);
      if (bend) bend(geo, group.position);
      const mesh = new THREE.Mesh(geo, M[bucket]);
      mesh.name = bucket; mesh.castShadow = cast && !!CAST[bucket]; mesh.receiveShadow = !NO_RECEIVE[bucket];
      if (bucket === 'pool' || bucket === 'beam') mesh.renderOrder = 4;
      if (bucket === 'ao') mesh.renderOrder = 2;
      if (bucket === 'fence') mesh.renderOrder = 3;
      group.add(mesh);
    }
    return group;
  }
}

// ---------------------------------------------------------------------------------------------
// Buildings. Each takes a Kit whose origin is the building's own spot and returns { focus, radius, pick }.
// pick boxes are [x, y0, z, w, h, d] in the building frame.
// ---------------------------------------------------------------------------------------------
function buildHangar(k) {
  const W = 120, D = 96, H = 108, n = -D / 2, s = D / 2;
  k.flat('slab', 0, -6, 250, 190, 0.05, C.conc);
  k.box('concrete', 0, 0, 0, W + 1.2, 7, D + 1.2, C.concDark);
  k.box('paint', 0, 7, 0, W, 83, D, C.white);
  k.box('paint', 0, 90, 0, W + 0.4, 5, D + 0.4, C.tealDeep);
  k.box('paint', 0, 95, 0, W, 11, D, C.slate);
  k.box('paint', 0, 106, 0, W + 2, 2.4, D + 2, C.shell);
  k.box('concrete', 0, 108.3, 0, W - 2, 0.5, D - 2, 0x6b7077);
  for (let i = -5; i <= 5; i++) {                                // pilasters give the long walls relief
    if (Math.abs(i) > 1) { k.box('paint', i * 11, 7, n - 0.7, 1.8, 88, 1.4, C.shell); k.box('paint', i * 11, 7, s + 0.7, 1.8, 88, 1.4, C.shell); }
  }
  for (let i = -4; i <= 4; i++) { k.box('paint', -W / 2 - 0.7, 7, i * 10.5, 1.4, 88, 1.8, C.shell); k.box('paint', W / 2 + 0.7, 7, i * 10.5, 1.4, 88, 1.8, C.shell); }
  // the high-bay door on the north face: seven lifting leaves, the lowest ones raised
  k.box('paint', -18.5, 0, n - 1.6, 5, 97, 3.2, C.slate); k.box('paint', 18.5, 0, n - 1.6, 5, 97, 3.2, C.slate); k.box('paint', 0, 92, n - 1.6, 42, 5, 3.2, C.slate);
  k.box('smooth', 0, 0.1, n - 0.5, 32, 26, 1.2, 0x0b0d10);
  k.push('lamp', wallGeo(30, 3, [0, 0, 1, 1]), 0xffc98a, Mx(0, 21, n - 1.2, 0, FACE.n));
  // what shows when the door goes up: work lights on the gantry levels inside and a lit floor strip
  for (const y of [5.5, 11, 16.5]) { k.push('lamp', wallGeo(27, 0.14, [0, 0, 1, 1]), 0x6a7480, Mx(0, y, n - 1.13, 0, FACE.n)); for (let i = -3; i <= 3; i++) k.push('lamp', wallGeo(1.5, 0.45, [0, 0, 1, 1]), 0xffdca8, Mx(i * 4.2, y + 0.5, n - 1.13, 0, FACE.n)); }
  for (const x of [-13.5, 13.5]) k.push('lamp', wallGeo(0.3, 19, [0, 0, 1, 1]), 0x56606c, Mx(x, 0.4, n - 1.13, 0, FACE.n));
  k.push('lamp', wallGeo(26, 0.5, [0, 0, 1, 1]), 0xc79a55, Mx(0, 0.3, n - 1.13, 0, FACE.n));
  for (let i = 0; i < 6; i++) { const y = 26 + i * 11; k.box('paint', 0, y, n - 1.1 - (i % 2) * 0.35, 32, 10.6, 1.0, i % 2 ? 0xc3c9cf : 0xd3d8dd); k.box('smooth', 0, y + 10.6, n - 1.5, 32, 0.4, 0.5, C.steelDark); }
  for (const sx of [-1, 1]) for (let i = 0; i < 9; i++) k.box('smooth', sx * 16.6, 3 + i * 10.4, n - 3.3, 1.2, 5, 0.3, i % 2 ? C.amber : C.dark);
  k.decalWall('emblem', -39, 60, n - 0.14, 30, 30, 'n'); k.decalWall('wordmark', 0, 100.5, n - 0.3, 78, 9.5, 'n', C.white);
  k.decalWall('wordmark', 0, 100.5, s + 0.3, 78, 9.5, 's', C.white); k.decalWall('emblem', 0, 58, s + 0.14, 30, 30, 's');
  k.decalWall('emblemMono', W / 2 + 0.3, 62, 0, 40, 40, 'e', C.tealDeep); k.decalWall('emblemMono', -W / 2 - 0.3, 62, 0, 40, 40, 'w', C.tealDeep);
  k.decalWall('VAB', 39, 16, n - 0.14, 26, 5.5, 'n', C.slate);
  for (const x of [-46, -30, 30, 46]) k.win(x, 9, n - 0.15, 10, 4, 'n');
  for (let f = 0; f < 3; f++) k.win(40, 30 + f * 18, n - 0.15, 20, 5, 'n');
  // low bay (east) and the office wing (west)
  k.box('paint', 86, 0, 8, 52, 34, 70, C.shell); k.box('paint', 86, 34, 8, 53, 2, 71, C.tealDeep); k.box('concrete', 86, 36, 8, 50, 0.4, 68, 0x6b7077);
  for (let i = -1; i <= 1; i++) { k.box('smooth', 86 + i * 15, 0.1, -27.4, 11, 20, 0.8, 0x2a3038); for (let j = 1; j < 5; j++) k.box('smooth', 86 + i * 15, j * 4, -27.9, 11, 0.25, 0.3, C.steelDark); }
  k.bands(86, 8, 52, 70, 22, 2, 5.5, 'se', 4); k.bands(86, 8, 52, 70, 4, 3, 5.5, 'e', 6);
  k.box('paint', -82, 0, 12, 44, 26, 64, C.cream); k.box('paint', -82, 26, 12, 45, 1.6, 65, C.slate);
  k.bands(-82, 12, 44, 64, 2, 5, 4.7, 'nsw', 3, 0.5);
  k.box('concrete', -82, 0, -24, 14, 0.4, 10, C.conc); k.box('paint', -82, 4.4, -23, 16, 0.5, 9, C.tealDeep);
  // roof furniture
  const r = k.rnd;
  for (let i = 0; i < 9; i++) k.box('smooth', -48 + (i % 3) * 20 + r() * 4, 108.8, -26 + Math.floor(i / 3) * 24 + r() * 4, 6 + r() * 5, 2.5 + r() * 2.5, 5 + r() * 4, i % 2 ? 0x9aa2ab : 0x7c858f);
  k.box('paint', 40, 108.8, 30, 12, 6, 9, C.shell); k.box('paint', -44, 108.8, 34, 9, 5, 7, C.shell);
  for (let i = 0; i < 5; i++) k.cyl('smooth', 22 + i * 6, 108.8, -34, 1.5, 1.7, 3, 0x9aa2ab, 12);
  k.decalFlat('emblem', 4, 4, 44, 44, 108.95, 0);
  k.lattice(48, -36, 3, 1, 108.8, 138, 6, C.white, C.red, 0.25);
  k.glow(48, 139.2, -36, 0xff3524, 3.4, 1, 2.2, 0);
  for (const [x, z] of [[-W / 2, n], [W / 2, n], [-W / 2, s], [W / 2, s]]) { k.box('smooth', x * 0.985, 108.4, z * 0.985, 0.6, 2, 0.6, C.steelDark); k.glow(x * 0.985, 110.9, z * 0.985, 0xff3524, 2.4, 1, 2.2, 0.5); }
  for (let i = -2; i <= 2; i++) { k.glow(i * 7, 27.5, n - 2.6, 0xffe2b0, 2.0); }
  k.pool(0, n - 26, 46, 0xffdca8); k.pool(86, -46, 30, 0xffe2b0); k.pool(-82, -36, 24);
  return { focus: V3(0, 52, 0), radius: 105, pick: [[0, 0, 0, W + 4, H + 4, D + 4], [86, 0, 8, 54, 38, 72], [-82, 0, 12, 46, 30, 66]] };
}

function buildPad(k) {
  const R = 38, oct = []; for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + Math.PI / 8; oct.push([Math.cos(a) * R / Math.cos(Math.PI / 8), Math.sin(a) * R / Math.cos(Math.PI / 8)]); }
  const Ro = R / Math.cos(Math.PI / 8);
  k.flat('slab', 0, 0, 230, 230, 0.03, 0xa9a59b);
  k.push('concrete', new THREE.CylinderGeometry(Ro, Ro + 1.6, 0.7, 8, 1, true), C.concDark, Mx(0, -0.31, 0, 0, Math.PI / 8), 12, 0.2);
  k.poly('concrete', oct, 0.04, C.conc);
  k.disc('mark', 0, 0, R - 2, 0.07, C.amber, 8, R - 2.9); k.disc('mark', 0, 0, 14.4, 0.075, C.line, 48, 14); k.disc('mark', 0, 0, 9.6, 0.075, C.teal, 48, 8.8);
  k.disc('mark', 0, 0, 5.2, 0.08, C.scorch, 8);
  for (let i = -4; i <= 4; i++) k.flat('mark', 0, i * 1.1, 9.4, 0.16, 0.09, 0x57534d);
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; if (i === 6) continue; k.decalFlat('hazard', Math.cos(a) * 30.5, Math.sin(a) * 30.5, 14, 1.6, 0.085, -a); }
  k.decalFlat('PAD 1', 0, 26, 22, 3.2, 0.085, 0, C.line);
  // flame channel toward −Z with blast walls and a deflector
  k.flat('mark', 0, -40, 12.5, 62, 0.085, C.scorch); k.flat('mark', 0, -22, 9, 30, 0.09, 0x1d1b19);
  for (const sx of [-1, 1]) { k.box('concrete', sx * 7, 0, -41, 1.4, 3.4, 60, C.concDark); for (let i = 0; i < 10; i++) k.box('smooth', sx * 7, 3.4, -14 - i * 6, 1.5, 0.3, 3, i % 2 ? C.amber : C.dark); }
  k.boxM('concrete', 14, 1.2, 15, 0x4b4742, Mx(0, 0, -77, 0.42)); k.box('concrete', 0, 0, -85.5, 16, 7.5, 1.6, C.concDark);
  k.box('concrete', -7.6, 0, -78, 1.4, 6.5, 15, C.concDark); k.box('concrete', 7.6, 0, -78, 1.4, 6.5, 15, C.concDark);
  // service tower, centred 17 m east of the pad axis
  const tx = 17, tw = 7, H = 54;
  k.box('concrete', tx, 0, 0, 11, 0.9, 11, C.concDark);
  k.lattice(tx, 0, tw, tw, 0.9, H, 9, C.white, C.amber, 0.38);
  k.box('smooth', tx + 0.6, 0.9, 0, 2.6, H - 1, 2.6, 0x4a525c); k.box('smooth', tx + 0.6, 18, 0.2, 2.2, 3, 2.2, C.teal);
  for (let i = 1; i <= 4; i++) { const y = 0.9 + (i * 2 * (H - 0.9)) / 9; k.box('smooth', tx, y, 0, tw + 2.4, 0.25, tw + 2.4, 0x6b727b); for (const s of [-1, 1]) { k.beam('metal', [tx - tw / 2 - 1.2, y + 1.2, s * (tw / 2 + 1.2)], [tx + tw / 2 + 1.2, y + 1.2, s * (tw / 2 + 1.2)], 0.1, C.amber); k.beam('metal', [tx + s * (tw / 2 + 1.2), y + 1.2, -tw / 2 - 1.2], [tx + s * (tw / 2 + 1.2), y + 1.2, tw / 2 + 1.2], 0.1, C.amber); } }
  // propellant risers up the tower's west face (the pad's pipe runs come up into them; the swing arms are fitted to
  // the rocket on the pad and are not part of this model: fitPad, js/render/padfit.js)
  for (const [z, col, y0] of [[2.4, 0xcfd4d9, 0.9], [3.1, C.teal, 0.9], [-2.4, C.orange, 1.6]]) {
    const x = tx - tw / 2 - 0.35; k.tube('smooth', [x, y0, z], [x, H - 3, z], 0.22, col, 14); k.sphere('smooth', x, H - 3, z, 0.24, col, 1, 10);
    if (y0 < 1) k.cyl('smooth', x, 0.9, z, 0.36, 0.36, 0.12, C.steelDark, 14);
    for (let y = 8; y < H - 4; y += 9) { k.cyl('smooth', x, y, z, 0.3, 0.3, 0.1, C.steel, 14); k.box('metal', x + 0.2, y - 0.3, z, 0.5, 0.12, 0.12, C.steelDark); }
  }
  k.box('smooth', tx, H, 0, tw + 3, 0.4, tw + 3, 0x6b727b); k.box('smooth', tx + 1, H + 0.4, 0, 4.2, 3.4, 4.2, C.teal); k.box('smooth', tx + 1, H + 3.8, 0, 4.6, 0.4, 4.6, C.white);
  k.win(tx - 1.15, H + 1.4, 0, 3.4, 1.6, 'w', 1.7);
  // hammerhead crane and lightning rod. The jib stops 11 m from the pad's axis (it reached 4 m, over a tall rocket's
  // flaps, until the space centre was made solid: js/core/structures.js)
  k.beam('metal', [tx + 9, H + 5.4, 0], [tx - 6, H + 5.4, 0], 1.0, C.amber); k.beam('metal', [tx + 9, H + 6.9, 0], [tx - 6, H + 6.9, 0], 0.3, C.amber);
  for (let i = 0; i < 8; i++) k.beam('metal', [tx + 9 - i * 2, H + 5.9, 0], [tx + 8 - i * 2, H + 6.9, 0], 0.16, C.amber);
  k.box('smooth', tx + 8, H + 4.2, 0, 3, 2.6, 2.4, C.steelDark); k.beam('metal', [tx - 4.5, H + 5, 0], [tx - 4.5, H - 1, 0], 0.08, C.dark); k.box('smooth', tx - 4.5, H - 2, 0, 0.7, 1, 0.7, C.amber);
  k.beam('metal', [tx + 1, H + 4.2, 0], [tx + 1, H + 22, 0], 0.22, 0xd9dee2); k.glow(tx + 1, H + 22.6, 0, 0xff3524, 3, 1, 1.6, 0);
  k.glow(tx - 6, H + 5.4, 0, 0xff3524, 2, 1, 1.6, 0.5);
  // lightning masts and floodlight towers
  for (const [x, z] of [[-50, -50], [50, -50], [-50, 50], [50, 50]]) {
    k.box('concrete', x, 0, z, 5, 0.6, 5, C.concDark); k.lattice(x, z, 4, 0.9, 0.6, 72, 12, C.white, C.red, 0.24); k.beam('metal', [x, 72, z], [x, 84, z], 0.14, 0xd9dee2);
    k.glow(x, 84.5, z, 0xff3524, 2.6, 1, 1.6, (x + z) * 0.01); k.glow(x, 40, z, 0xff3524, 1.6, 1, 1.6, 0.5);
  }
  for (const [x, z] of [[-34, 33], [34, 33], [-36, -30], [36, -30]]) {
    k.box('concrete', x, 0, z, 2.4, 0.5, 2.4, C.concDark); k.lattice(x, z, 1.8, 1.2, 0.5, 30, 6, C.steel, C.steel, 0.18);
    const head = Mx(x, 30.4, z, 0.5, Math.atan2(-x, -z));
    k.push('smooth', new THREE.BoxGeometry(5.4, 2.4, 0.7), 0x2b3038, head);
    for (let i = -2; i <= 2; i++) for (let j = 0; j < 2; j++) k.push('lamp', new THREE.CircleGeometry(0.42, 10), 0xfff1c9, head.clone().multiply(Mx(i * 1.02, -0.55 + j * 1.1, 0.37)));
    k.glow(x, 30.4, z, 0xfff0cc, 5.5);
    const d = V3(-x, -30, -z + 0.001), len = d.length();
    k.push('beam', new THREE.CylinderGeometry(1.2, 15, len, 20, 1, true), 0xfff0cc, new THREE.Matrix4().compose(V3(x / 2, 15.2, z / 2), new THREE.Quaternion().setFromUnitVectors(_Y, d.clone().multiplyScalar(-1).normalize()), V3(1, 1, 1)));
  }
  k.pool(0, 0, 46, 0x7a7262);
  // propellant farm (west), cryogenic tanks (east), water tower, pad ops bunker
  for (const [x, z] of [[-84, -34], [-84, 4]]) {
    k.sphere('smooth', x, 13.5, z, 11, C.white); k.cyl('smooth', x, 12.6, z, 11.06, 11.06, 1.8, C.teal, 24, true); k.disc('slab', x, z, 15, 0.06, C.conc);
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + 0.3; k.beam('metal', [x + Math.cos(a) * 8.4, 0, z + Math.sin(a) * 8.4], [x + Math.cos(a) * 9.4, 11, z + Math.sin(a) * 9.4], 0.6, C.steel); }
    k.tube('smooth', [x, 24.4, z], [x, 27, z], 0.5, C.steel, 8); k.glow(x, 27.6, z, 0xff3524, 1.8, 1, 2.2, 0.3);
  }
  for (let i = 0; i < 3; i++) {
    const z = -44 + i * 13, x = 84;
    k.tube('smooth', [x - 12, 5.6, z], [x + 12, 5.6, z], 4.4, i === 1 ? C.cream : C.white, 20); k.sphere('smooth', x - 12, 5.6, z, 4.4, C.shell, 1, 14); k.sphere('smooth', x + 12, 5.6, z, 4.4, C.shell, 1, 14);
    for (const sx of [-7, 7]) k.box('concrete', x + sx, 0, z, 2, 2.6, 8, C.concDark);
    k.tube('smooth', [x, 5.6, z], [x, 5.6, z + 0.01], 4.46, C.orange, 20);
  }
  k.flat('slab', 84, -31, 40, 44, 0.06, C.conc);
  // pipe runs from the farms to the pad: round pipe with flanged joints and elbows, on saddles; every run starts in a
  // tank and ends in something (the valve skid, a riser on the tower, or a collar where it goes under the deck)
  const pipe = (pts, r, col, collar = false) => {
    const P = pts.map(p => V3(...p));
    for (let i = 0; i < P.length - 1; i++) {
      const A = P[i], B = P[i + 1], d = B.clone().sub(A), len = d.length(), u = d.clone().normalize(), flat = Math.abs(u.y) < 0.2;
      k.tube('smooth', A.toArray(), B.toArray(), r, col, 16);
      // flanges: one pair a little way from each end, and one every 12 m of a long run
      const at = [Math.min(0.7, len * 0.3), len - Math.min(0.7, len * 0.3)]; for (let t = 12; t < len - 6; t += 12) at.push(t);
      for (const t of at) { const c = A.clone().addScaledVector(u, t); k.tube('smooth', c.clone().addScaledVector(u, -0.07).toArray(), c.clone().addScaledVector(u, 0.07).toArray(), r * 1.38, C.steel, 16); }
      if (flat && len > 5 && A.y > 0.8) {
        const n = Math.max(1, Math.round(len / 9)), ry = Math.atan2(-u.z, u.x);
        for (let j = 0; j <= n; j++) { const c = A.clone().addScaledVector(u, len * (j + 0.5) / (n + 1)); k.box('metal', c.x, 0, c.z, 0.3, c.y - r * 0.55, r * 2.9, C.steelDark, ry); k.box('concrete', c.x, 0, c.z, 0.7, 0.18, r * 4.2, C.concDark, ry); k.box('metal', c.x, c.y - r * 0.9, c.z, 0.34, r * 0.5, r * 2.3, C.steel, ry); }
      }
    }
    for (let i = 1; i < P.length - 1; i++) k.sphere('smooth', P[i].x, P[i].y, P[i].z, r * 1.12, col, 1, 14);       // elbows
    if (collar) { const e = P[P.length - 1]; k.cyl('smooth', e.x, 0.02, e.z, r * 1.75, r * 1.75, 0.16, C.steelDark, 16); k.box('concrete', e.x, 0, e.z, r * 5, 0.1, r * 5, C.concDark); }
  };
  pipe([[-84, 2.8, -34], [-84, 1.6, -34], [-33.2, 1.6, -18.4]], 0.42, 0xcfd4d9);
  pipe([[-84, 2.8, 4], [-84, 1.6, 4], [-33.2, 1.6, -15.6]], 0.42, C.teal);
  // the valve skid where the two farm lines are metered out to the pad
  k.box('concrete', -31.5, 0, -17, 5.4, 0.3, 6.4, C.concDark); k.box('smooth', -31.5, 0.3, -17, 3.6, 2.5, 4.6, C.white); k.box('smooth', -31.5, 2.8, -17, 3.8, 0.16, 4.8, C.teal);
  for (const z of [-18.4, -15.6]) { k.tube('metal', [-31.5, 2.96, z], [-31.5, 3.5, z], 0.05, C.steel, 8); k.cyl('metal', -31.5, 3.5, z, 0.36, 0.36, 0.06, C.red, 14); }
  pipe([[-29.7, 1.6, -17.75], [-12.75, 1.6, -11.75], [-12.75, 0.05, -11.75]], 0.36, 0xcfd4d9, true);
  pipe([[-29.7, 1.6, -16.25], [-13.25, 1.6, -10.25], [-13.25, 0.05, -10.25]], 0.36, C.teal, true);
  // … and the covered trench that carries them under the deck, round the flame opening, to the risers on the tower
  for (const [x, z, w, d] of [[-13, 0.6, 2, 24.6], [-2.4, 12, 23.2, 2], [8.2, 7.4, 2, 11.2], [9.9, 2.75, 3.4, 2]]) {
    k.flat('mark', x, z, w, d, 0.092, 0x4d5258); const long = Math.max(w, d), n = Math.round(long / 1.6);
    for (let i = 1; i < n; i++) { const t = (i / n - 0.5) * long; if (w > d) k.flat('mark', x + t, z, 0.05, d, 0.096, 0x2a2d31); else k.flat('mark', x, z + t, w, 0.05, 0.096, 0x2a2d31); }
  }
  pipe([[67.8, 5.6, -31], [66.3, 5.6, -31], [66.3, 1.6, -31], [30, 1.6, -18], [15.2, 1.6, -8.4], [13.15, 1.6, -2.4]], 0.42, C.orange);
  k.sphere('smooth', 13.15, 1.6, -2.4, 0.46, C.orange, 1, 14);
  { const x = 66, z = 52; k.cyl('smooth', x, 30, z, 7.5, 5.2, 8, C.white, 20); k.dome('smooth', x, 38, z, 7.5, C.shell, 0.5); k.cyl('smooth', x, 33, z, 7.56, 7.56, 1.6, C.amber, 20, true);
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; k.beam('metal', [x + Math.cos(a) * 7.5, 0, z + Math.sin(a) * 7.5], [x + Math.cos(a) * 4.6, 30.5, z + Math.sin(a) * 4.6], 0.5, C.steel); }
    k.tube('smooth', [x, 0, z], [x, 30, z], 0.9, C.steel, 10); pipe([[x, 4, z], [x, 1.2, z + 1.4], [17.5, 1.2, 16.6], [17.5, 0.05, 16.6]], 0.5, 0x5b88b0, true); k.glow(x, 42.4, z, 0xff3524, 2, 1, 2.2, 0.7); }
  k.box('concrete', -62, 0, 62, 26, 5.5, 14, C.cream); k.box('paint', -62, 5.5, 62, 26.6, 0.8, 14.6, C.tealDeep); k.win(-62, 2.4, 54.85, 20, 1.6, 'n', 2.5);
  k.dome('smooth', -56, 6.3, 64, 3, C.white); k.beam('metal', [-70, 6.3, 66], [-70, 15, 66], 0.16, 0xd9dee2);
  // perimeter lamps
  for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6 + 0.26, x = Math.cos(a) * 100, z = Math.sin(a) * 100; if (Math.abs(x) < 16 && z > 0) continue; k.beam('metal', [x, 0, z], [x, 9, z], 0.2, C.steel); k.glow(x, 9.2, z, 0xffe2b0, 1.8); k.pool(x, z, 14); }
  return { focus: V3(6, 26, -4), radius: 85, pick: [[0, 0, -20, 96, 6, 150], [tx - 4, 0, 0, 30, 80, 14], [-84, 0, -15, 26, 26, 64], [84, 0, -31, 36, 12, 40], [66, 0, 52, 16, 42, 16], [-50, 0, -50, 5, 84, 5], [50, 0, -50, 5, 84, 5], [-50, 0, 50, 5, 84, 5], [50, 0, 50, 5, 84, 5]] };
}

function buildRunway(k) {
  // kit origin: runway centre (x = 50, z = 850). The strip runs along X.
  const L = 2000, W = 56, hx = L / 2;
  k.flat('asphalt', 0, 0, L + 120, W + 20, 0.05, C.asphaltLight); k.flat('asphalt', 0, 0, L, W, 0.07, C.asphalt);
  for (const s of [-1, 1]) k.flat('mark', 0, s * (W / 2 - 1.2), L - 20, 0.9, 0.1, C.line);
  for (let x = -hx + 130; x < hx - 130; x += 60) k.flat('mark', x + 15, 0, 30, 0.9, 0.1, C.line);
  for (const e of [-1, 1]) {
    for (let i = 0; i < 12; i++) { const z = (i - 5.5) * 3.9 + Math.sign(i - 5.5) * 1.6; k.flat('mark', e * (hx - 36), z, 30, 1.9, 0.1, C.line); }
    for (const s of [-1, 1]) { k.flat('mark', e * (hx - 330), s * 10, 46, 7, 0.1, C.line); for (const d of [170, 480, 630]) for (let j = 0; j < (d === 170 ? 3 : 2); j++) k.flat('mark', e * (hx - d), s * (7 + j * 3), 22, 1.7, 0.1, C.line); }
    for (let i = 0; i < 4; i++) k.decalFlat('hazard', e * (hx + 20 + i * 11), 0, W, 3, 0.1, Math.PI / 2, C.yellow);
    k.decalFlat(e < 0 ? 'n09' : 'n27', e * (hx - 80), 0, 20, 26, 0.1, -e * Math.PI / 2, C.line);
    // threshold / end lights, approach bars, PAPI
    for (let i = 0; i < 14; i++) { const z = (i - 6.5) * 4; k.glow(e * hx, 0.5, z, 0x48ff7a, 1.5); k.glow(e * (hx - 3), 0.5, z, 0xff4a36, 1.2); }
    for (let i = 1; i <= 7; i++) { const x = e * (hx + 40 + i * 40); k.box('metal', x, 0, 0, 0.3, 1.6 + i * 0.25, 9, C.steel); for (let j = -2; j <= 2; j++) k.glow(x, 2 + i * 0.25, j * 2, 0xfff4d8, 1.5, i > 4 ? 2 : 0, 1.4, 1 - i * 0.09); }
    for (let i = 0; i < 4; i++) { k.box('smooth', e * (hx - 300), 0, -W / 2 - 14 - i * 3, 1.4, 0.8, 1.2, C.steelDark); k.glow(e * (hx - 300), 1, -W / 2 - 14 - i * 3, i < 2 ? 0xff4a36 : 0xffffff, 1.6); }
  }
  for (let x = -hx; x <= hx; x += 62.5) for (const s of [-1, 1]) k.glow(x, 0.5, s * (W / 2 + 1.5), 0xfff4d8, 1.3);
  // parallel taxiway (north side) with four connectors
  const tz = -78;
  k.flat('asphalt', -340, tz, 1260, 23, 0.07, 0x44474b); k.flat('mark', -340, tz, 1250, 0.45, 0.1, C.yellow);
  for (const x of [-980, -560, -60, 270]) { k.flat('asphalt', x, (tz - W / 2) / 2 + 1, 24, -tz - W / 2 + 12, 0.07, 0x44474b); k.flat('mark', x, (tz - W / 2) / 2, 0.45, -tz - W / 2 + 8, 0.1, C.yellow); for (const s of [-1, 1]) { k.glow(x + s * 13, 0.5, tz + 12, 0x3d7bff, 1.2); k.glow(x + s * 13, 0.5, -W / 2 - 6, 0x3d7bff, 1.2); } }
  for (let x = -960; x <= 280; x += 45) for (const s of [-1, 1]) k.glow(x, 0.5, tz + s * 12.5, 0x3d7bff, 1.1);
  // windsocks and a runway distance board
  for (const [x, z] of [[-hx + 220, 52], [hx - 220, 52]]) {
    k.beam('metal', [x, 0, z], [x, 8, z], 0.22, C.white); k.disc('mark', x, z, 5, 0.09, C.line, 20, 4.2);
    for (let i = 0; i < 5; i++) k.push('smooth', new THREE.CylinderGeometry(0.95 - i * 0.12, 0.83 - i * 0.12, 1.3, 10, 1, true), i % 2 ? C.white : C.orange, Mx(x + 0.8 + i * 1.28, 7.7 - i * 0.12, z, 0, 0, -Math.PI / 2 + 0.1));
    k.glow(x, 8.4, z, 0xff3524, 1.4, 1, 2, 0.2);
  }
  return { focus: V3(-600, 4, 0), radius: 330, pick: [[0, 0, 0, L + 120, 9, W + 24], [-340, 0, tz, 1260, 6, 24]] };
}

function buildSpaceplaneHangar(k) {
  // barrel-vault hangar, doors facing south (+Z) toward the taxiway
  const R = 31, L = 80, zf = L / 2;
  k.flat('slab', 0, 22, 190, 110, 0.05, C.conc);
  k.flat('mark', -6, 56, 0.5, 33, 0.1, C.yellow);
  k.push('paint', new THREE.CylinderGeometry(R, R, L, 28, 1, true, 0, Math.PI), C.shell, new THREE.Matrix4().makeTranslation(0, 6, 0).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)), 6, 6);
  for (let i = 0; i <= 8; i++) k.push('smooth', new THREE.TorusGeometry(R + 0.2, 0.5, 6, 28, Math.PI), i % 4 === 0 ? C.tealDeep : 0xaab1b9, Mx(0, 6, -zf + (i * L) / 8, 0, 0, 0));
  for (const sx of [-1, 1]) { k.box('paint', sx * (R - 0.5), 0, 0, 2.4, 6.4, L, C.shell); k.box('paint', sx * (R + 9), 0, -6, 17, 9, L - 24, C.cream); k.box('paint', sx * (R + 9), 9, -6, 17.6, 0.9, L - 23.4, C.tealDeep); k.bands(sx * (R + 9), -6, 17, L - 24, 1, 2, 4, sx > 0 ? 'e' : 'w', 4); }
  // end walls: the south one is mostly door
  const endWall = (z, face) => {
    const sh = new THREE.Shape(); sh.moveTo(-R, 0); sh.lineTo(R, 0); sh.lineTo(R, 6); sh.absarc(0, 6, R, 0, Math.PI, false); sh.lineTo(-R, 0);
    k.push('paint', new THREE.ShapeGeometry(sh, 28), C.white, Mx(0, 0, z, 0, face === 's' ? 0 : Math.PI), 1 / 16, 1 / 16);
  };
  endWall(zf, 's'); endWall(-zf, 'n');
  k.box('smooth', -6, 0.1, zf + 0.2, 40, 19, 0.5, 0x0c0e11); k.push('lamp', wallGeo(38, 2, [0, 0, 1, 1]), 0xffc98a, Mx(-6, 16, zf + 0.5, 0, 0));
  for (let i = 0; i < 3; i++) { k.box('paint', 16.5 + i * 3.2, 0.1, zf + 0.7 + i * 0.35, 10, 19, 0.3, i % 2 ? 0xc3c9cf : 0xd3d8dd); k.box('paint', -29 - i * 0.4, 0.1, zf + 0.7 + i * 0.35, 6, 19, 0.3, 0xc9ced3); }
  k.box('smooth', 0, 19.1, zf + 0.6, 2 * R - 6, 1.2, 1.2, C.slate);
  k.win(0, 23, zf + 0.12, 34, 5, 's'); k.decalWall('HANGAR 2', 0, 32, zf + 0.14, 22, 3.6, 's', C.slate); k.decalWall('emblem', 0, 28, -zf - 0.14, 14, 14, 'n');
  k.win(0, 8, -zf - 0.12, 30, 4, 'n');
  // a parked spaceplane on the apron
  const px = -68, pz = 30, py = 2.4;
  k.tube('smooth', [px, py, pz - 13], [px, py, pz + 9], 1.9, C.white, 14); k.tube('smooth', [px, py, pz - 13], [px, py + 0.3, pz - 19], 1.9, C.white, 14, 0.25);
  k.tube('smooth', [px, py, pz + 9], [px, py, pz + 11.5], 1.9, C.slate, 14, 1.3);
  { const sh = new THREE.Shape(); sh.moveTo(0, -8); sh.lineTo(12.5, 7); sh.lineTo(12.5, 9.5); sh.lineTo(-12.5, 9.5); sh.lineTo(-12.5, 7); sh.closePath();
    k.push('smooth', new THREE.ExtrudeGeometry(sh, { depth: 0.36, bevelEnabled: false }), C.shell, Mx(px, py - 0.9, pz + 1, Math.PI / 2, 0, 0)); }
  k.boxM('smooth', 0.4, 6, 5.5, C.tealDeep, Mx(px, py + 1.2, pz + 7.4, -0.5)); k.win(px, py + 1.0, pz - 12.2, 2.2, 0.9, 'n', 1.2);
  for (const [gx, gz] of [[0, -11], [-3.5, 4], [3.5, 4]]) k.tube('metal', [px + gx, 0.1, pz + gz], [px + gx, py - 1.2, pz + gz], 0.22, C.steelDark, 6);
  for (const sx of [-1, 1]) { k.beam('metal', [sx * 52, 0, 62], [sx * 52, 16, 62], 0.3, C.steel); k.glow(sx * 52, 16.3, 62, 0xfff0cc, 3.6); k.pool(sx * 30, 58, 36, 0xfff0cc); }
  k.glow(0, 38.2, 0, 0xff3524, 2.2, 1, 2.2, 0.4); k.box('smooth', 0, 37, 0, 0.5, 1.2, 0.5, C.steelDark);
  return { focus: V3(0, 16, 12), radius: 95, pick: [[0, 0, 0, 2 * R + 36, 39, L + 4], [px, 0, pz - 4, 28, 9, 34]] };
}

function buildTracking(k, movers) {
  k.flat('slab', 0, 10, 210, 170, 0.05, C.conc);
  k.box('paint', -14, 0, 44, 52, 9, 24, C.cream); k.box('paint', -14, 9, 44, 53, 1, 25, C.tealDeep); k.bands(-14, 44, 52, 24, 1, 2, 4, 'nsew', 3);
  k.box('paint', -34, 10, 44, 10, 5, 12, C.shell); k.sphere('smooth', 2, 17.5, 44, 8.5, C.white, 1, 18); k.cyl('concrete', 2, 10, 44, 6.4, 6.8, 2.4, C.shell, 18);
  k.decalWall('TRACKING', -14, 6.4, 31.86, 20, 2.6, 'n', C.slate);
  k.lattice(52, 50, 3.2, 0.8, 0, 46, 9, C.white, C.red, 0.2);
  for (let i = 0; i < 3; i++) { k.box('smooth', 52, 30 + i * 5, 50.6, 1.6, 2.4, 0.3, C.shell); k.cyl('smooth', 52.9, 31 + i * 5, 50, 0.7, 0.7, 0.5, C.white, 10); }
  k.glow(52, 46.8, 50, 0xff3524, 2.6, 1, 2.2, 0.1);
  const dish = (x, z, D, hp, phase) => {
    const R = D / 2, f = D * 0.38, yokeH = R * 0.55;
    k.cyl('concrete', x, 0, z, R * 0.42, R * 0.5, hp * 0.45, C.conc, 16); k.cyl('smooth', x, hp * 0.45, z, R * 0.3, R * 0.38, hp * 0.55, C.white, 16); k.cyl('smooth', x, hp * 0.62, z, R * 0.335, R * 0.335, 0.8, C.teal, 16, true);
    k.disc('slab', x, z, R * 0.9, 0.06, C.conc);
    const az = new THREE.Group(); az.position.set(x, hp, z);
    const ka = new Kit(3);
    ka.cyl('smooth', 0, 0, 0, R * 0.36, R * 0.36, 1.2, C.steelDark, 16);
    for (const s of [-1, 1]) { ka.boxM('smooth', R * 0.14, yokeH + 1, R * 0.3, C.white, Mx(s * R * 0.34, 0.6, 0)); }
    ka.box('smooth', 0, 0.8, R * 0.34, R * 0.5, R * 0.3, R * 0.22, C.steelDark);
    const el = new THREE.Group(); el.position.set(0, yokeH + 1, 0);
    const ke = new Kit(4), pts = [];
    for (let i = 0; i <= 14; i++) { const r = (R * i) / 14; pts.push(new THREE.Vector2(Math.max(r, 0.01), (r * r) / (4 * f))); }
    ke.push('smooth', new THREE.LatheGeometry(pts, 36), C.white, Mx(0, 0.6, 0), 4, 2);
    const rimY = 0.6 + (R * R) / (4 * f);
    ke.push('smooth', new THREE.TorusGeometry(R, 0.22, 6, 36), C.shell, Mx(0, rimY, 0, Math.PI / 2));
    ke.push('smooth', new THREE.TorusGeometry(R * 0.62, 0.3, 6, 24), C.steel, Mx(0, 0.2 + (R * R * 0.38) / (4 * f) - 1.2, 0, Math.PI / 2));
    for (let i = 0; i < 12; i++) { const a = (i * TAU) / 12; ke.beam('smooth', [Math.cos(a) * R * 0.2, -0.6, Math.sin(a) * R * 0.2], [Math.cos(a) * R * 0.96, rimY - 0.5, Math.sin(a) * R * 0.96], 0.26, C.steel); }
    for (let i = 0; i < 4; i++) { const a = (i * TAU) / 4 + 0.78; ke.beam('smooth', [Math.cos(a) * R * 0.7, 0.6 + (R * R * 0.49) / (4 * f), Math.sin(a) * R * 0.7], [Math.cos(a) * 0.5, 0.6 + f, Math.sin(a) * 0.5], 0.22, C.shell); }
    ke.cyl('smooth', 0, 0.6 + f - 0.8, 0, R * 0.06, R * 0.11, 1.4, C.steelDark, 12); ke.cyl('smooth', 0, 0.6, 0, R * 0.05, R * 0.09, R * 0.34, C.shell, 10);
    ke.cyl('smooth', 0, -1.2, 0, R * 0.22, R * 0.22, 1.8, C.steelDark, 14); ke.box('smooth', 0, -R * 0.2, -R * 0.36, R * 0.44, R * 0.3, R * 0.2, C.steelDark);
    ka.build(az, MAT); ke.build(el, MAT); az.add(el);
    movers.push({ az, el, phase, speed: 18 / D });
    k.solid('sph', x, hp + R * 0.55, z, R * 0.85, 1);                // for the physics: the dish turns, so all the room it sweeps
    return az;
  };
  const dishes = [dish(-58, -22, 52, 26, 0.3), dish(34, -40, 30, 16, 2.1), dish(74, 2, 24, 13, 4.0)];
  for (const [x, z] of [[-90, 60], [90, 60], [0, 78]]) { k.beam('metal', [x, 0, z], [x, 10, z], 0.22, C.steel); k.glow(x, 10.3, z, 0xffe2b0, 2.2); k.pool(x, z, 20); }
  k.glow(-58, 27, -22, 0xff3524, 2, 1, 2.2, 0.6);
  return { focus: V3(-6, 22, 4), radius: 115, pick: [[-14, 0, 44, 54, 27, 26], [-58, 0, -22, 54, 64, 54], [34, 0, -40, 32, 40, 32], [74, 0, 2, 26, 32, 26], [52, 0, 50, 4, 47, 4]], extra: dishes };
}

function buildResearch(k) {
  k.flat('slab', 0, 0, 250, 190, 0.05, C.conc);
  // main laboratory block with a glass atrium
  k.box('paint', -20, 0, 30, 104, 17, 30, C.white); k.box('paint', -20, 17, 30, 105, 1.2, 31, C.tealDeep); k.bands(-20, 30, 104, 30, 1.2, 3, 5.2, 'nsew', 3);
  k.box('smooth', -20, 0, 50, 26, 21, 14, 0x2a3540); k.win(-20, 1, 57.14, 25, 19.4, 's'); k.win(-33.14, 1, 50, 13, 19.4, 'w'); k.win(-6.86, 1, 50, 13, 19.4, 'e'); k.box('smooth', -20, 21, 50, 27, 0.6, 15, C.shell);
  k.decalWall('RESEARCH LAB', -52, 14.6, 45.14, 26, 3, 's', C.slate);
  for (let i = 0; i < 6; i++) k.cyl('smooth', -62 + i * 9, 18.2, 22, 0.7, 0.7, 4 + (i % 3), 0xaab1b9, 8);
  for (let i = 0; i < 4; i++) k.box('smooth', 4 + i * 8, 18.2, 34, 5, 2.4, 5, 0x8a929c);
  // clean room high bay
  k.box('paint', 66, 0, 26, 44, 26, 36, C.shell); k.box('paint', 66, 26, 26, 45, 1.4, 37, C.slate); k.box('paint', 66, 12, 26, 44.5, 2.4, 36.5, C.teal);
  k.box('smooth', 66, 0.1, 44.3, 14, 16, 0.5, 0x2a3038); k.win(80, 18, 44.14, 10, 4, 's'); k.decalWall('emblem', 52, 20, 44.2, 9, 9, 's');
  // observatory dome
  k.cyl('paint', -86, 0, -30, 13, 13, 11, C.cream, 28); k.dome('smooth', -86, 11, -30, 13.4, C.white, 1, 28);
  k.push('smooth', new THREE.TorusGeometry(13.5, 0.5, 6, 28), C.tealDeep, Mx(-86, 11, -30, Math.PI / 2));
  k.push('smooth', new THREE.BoxGeometry(4.6, 0.6, 15), 0x1f262e, Mx(-86, 21.6, -24.5, 0.55)); k.win(-86, 2.5, -16.9, 8, 4, 's');
  // wind tunnel
  k.tube('smooth', [-40, 6, -44], [14, 6, -44], 4.6, C.shell, 18); k.tube('smooth', [14, 6, -44], [28, 6, -44], 4.6, C.white, 18, 8); k.box('paint', 36, 0, -44, 16, 16, 20, C.cream); k.box('paint', 36, 16, -44, 16.6, 1, 20.6, C.tealDeep);
  k.tube('smooth', [-40, 6, -44], [-52, 6, -44], 4.6, C.white, 18, 7); k.box('paint', -58, 0, -44, 12, 14, 18, C.cream);
  for (const x of [-30, -10, 6]) { k.box('concrete', x, 0, -44, 2, 3.4, 9, C.concDark); k.push('smooth', new THREE.TorusGeometry(4.75, 0.3, 6, 18), C.teal, Mx(x, 6, -44, 0, Math.PI / 2)); }
  // cryo tanks and an engine test stand
  for (let i = 0; i < 3; i++) { k.cyl('smooth', 96 + (i % 2) * 2, 0, -22 - i * 11, 4, 4, 16, C.white, 16); k.dome('smooth', 96 + (i % 2) * 2, 16, -22 - i * 11, 4, C.shell, 0.7, 16); k.cyl('smooth', 96 + (i % 2) * 2, 9, -22 - i * 11, 4.05, 4.05, 1.4, i === 1 ? C.amber : C.teal, 16, true); }
  k.lattice(60, -50, 8, 8, 0, 22, 4, C.steel, C.amber, 0.34); k.box('smooth', 60, 22, -50, 10, 0.4, 10, 0x6b727b); k.cyl('smooth', 60, 9, -50, 1.4, 2.6, 6, C.slate, 14); k.cyl('smooth', 60, 15, -50, 2.4, 2.4, 6.5, C.white, 14);
  k.boxM('concrete', 12, 1, 12, 0x4b4742, Mx(60, 0, -64, 0.5)); k.box('concrete', 60, 0, -72, 16, 8, 1.6, C.concDark); k.flat('mark', 60, -58, 9, 14, 0.09, C.scorch);
  // solar array
  for (let r = 0; r < 4; r++) for (let c = 0; c < 9; c++) { const x = -112 + c * 8.4, z = 62 + r * 7.4; k.boxM('smooth', 7.6, 0.16, 4.4, 0x16284a, Mx(x, 1.3, z, 0.5)); k.boxM('smooth', 7.9, 0.1, 0.25, 0xb9c0c8, Mx(x, 0.3, z + 1.9, 0)); k.beam('metal', [x, 0, z], [x, 1.4, z], 0.2, C.steel); }
  for (const [x, z] of [[-110, 6], [0, 70], [110, 6], [20, -80]]) { k.beam('metal', [x, 0, z], [x, 9, z], 0.2, C.steel); k.glow(x, 9.3, z, 0xffe2b0, 2); k.pool(x, z, 18); }
  k.glow(60, 23, -50, 0xff3524, 1.8, 1, 2.2, 0.8);
  return { focus: V3(-8, 12, 6), radius: 125, pick: [[-20, 0, 34, 106, 23, 46], [66, 0, 26, 46, 28, 38], [-86, 0, -30, 28, 26, 28], [-10, 0, -44, 110, 18, 22], [97, 0, -33, 12, 20, 34], [60, 0, -56, 18, 24, 34], [-78, 0, 73, 78, 4, 32]] };
}

function buildMissions(k) {
  k.flat('slab', 0, -6, 180, 130, 0.05, C.conc);
  // main hall with a raked glass front facing the pad (north)
  k.box('paint', 0, 0, 8, 88, 21, 40, C.white); k.box('paint', 0, 21, 8, 89, 1.6, 41, C.slate); k.box('paint', 0, 14, 8, 88.5, 1.6, 40.5, C.teal);
  { const sh = new THREE.Shape(); sh.moveTo(0, 0); sh.lineTo(13, 0); sh.lineTo(0, 19); sh.closePath();
    k.push('smooth', new THREE.ExtrudeGeometry(sh, { depth: 70, bevelEnabled: false }), 0x27313b, Mx(-35, 0, -12, 0, Math.PI / 2, 0));
    const slope = Math.hypot(13, 19), ang = Math.atan2(13, 19);
    k.push('glass', wallGeo(68, slope - 1, [0, 0, 20 / 8, 7 / 8]), 0xffffff, Mx(0, 0.4, -25 + 0.5, -ang, Math.PI).multiply(Mx(0, 0, 0.22))); }
  k.bands(0, 8, 88, 40, 2, 3, 5.6, 'sew', 4);
  k.decalWall('MISSION CONTROL', 0, 18.4, 28.2, 40, 3.4, 's', C.white); k.decalWall('emblem', -34, 9, 28.2, 10, 10, 's');
  k.box('paint', 58, 0, 14, 28, 11, 30, C.cream); k.box('paint', 58, 11, 14, 28.6, 1, 30.6, C.tealDeep); k.bands(58, 14, 28, 30, 1, 2, 4.6, 'nse', 3);
  k.box('concrete', 0, 0, 33, 22, 0.5, 10, C.conc); k.box('paint', 0, 5, 33, 24, 0.6, 9, C.tealDeep); for (const sx of [-10, 10]) k.tube('metal', [sx, 0, 36.5], [sx, 5, 36.5], 0.3, C.steel, 8);
  // roof: static uplink dishes, whip antennas, AC plant
  for (const [x, z, r, tilt] of [[-28, 10, 5, 0.6], [-10, 16, 3.4, -0.4], [22, 4, 4.2, 0.3]]) {
    k.cyl('smooth', x, 22.6, z, 0.7, 0.9, 3, C.steelDark, 10);
    const pts = []; for (let i = 0; i <= 8; i++) { const rr = (r * i) / 8; pts.push(new THREE.Vector2(Math.max(rr, 0.01), (rr * rr) / (4 * r * 0.8))); }
    k.push('smooth', new THREE.LatheGeometry(pts, 20), C.white, Mx(x, 26, z, 0.7, tilt * 3), 2, 1);
  }
  for (let i = 0; i < 5; i++) k.beam('metal', [30 + i * 2.6, 22.6, 20], [30 + i * 2.6, 31 + (i % 2) * 4, 20], 0.12, 0xd9dee2);
  for (let i = 0; i < 4; i++) k.box('smooth', -4 + i * 7, 22.6, 22, 5, 2.2, 4, 0x8a929c);
  k.lattice(40, -4, 2.4, 0.8, 22.6, 44, 5, C.white, C.red, 0.18); k.glow(40, 44.8, -4, 0xff3524, 2.4, 1, 2.2, 0.2);
  // the countdown clock on the lawn, facing the avenue
  k.box('concrete', -52, 0, 46, 22, 1.2, 3, C.concDark); k.box('smooth', -52, 1.2, 46, 21, 6.4, 1.2, 0x15181c);
  k.decalWall('clock', -52, 4.4, 46.66, 20, 5.6, 's', 0xffffff, 'screen'); k.decalWall('clock', -52, 4.4, 45.34, 20, 5.6, 'n', 0xffffff, 'screen');
  for (const [x, z] of [[-70, -40], [70, -40], [-30, 52], [40, 52]]) { k.beam('metal', [x, 0, z], [x, 9, z], 0.2, C.steel); k.glow(x, 9.3, z, 0xffe2b0, 2); k.pool(x, z, 18); }
  return { focus: V3(4, 13, 6), radius: 80, pick: [[0, 0, 4, 90, 32, 60], [58, 0, 14, 30, 14, 32], [-52, 0, 46, 23, 9, 5], [40, 0, -4, 4, 46, 4]] };
}

function buildCrew(k) {
  k.flat('slab', -8, -4, 150, 120, 0.05, C.conc);
  // central commons dome with four habitat modules
  k.cyl('paint', 0, 0, 0, 14, 14, 6, C.cream, 28); k.dome('smooth', 0, 6, 0, 14.2, C.white, 0.72, 28); k.push('smooth', new THREE.TorusGeometry(14.2, 0.5, 6, 28), C.orange, Mx(0, 6, 0, Math.PI / 2));
  for (let i = 0; i < 8; i++) { const a = (i * TAU) / 8 + 0.39; k.win(Math.cos(a) * 14.1, 1.6, Math.sin(a) * 14.1, 5, 3, 's', 2.6); k.b.glass[k.b.glass.length - 1].m = Mx(Math.sin(a) * 14.1, 1.6, Math.cos(a) * 14.1, 0, a); }
  k.cyl('smooth', 0, 15.6, 0, 2.2, 3, 1.6, 0x2a3540, 12); k.glow(0, 17.8, 0, 0xffb347, 2.4, 1, 3, 0);
  for (let i = 0; i < 4; i++) {
    const a = (i * TAU) / 4 + Math.PI / 4, dx = Math.cos(a), dz = Math.sin(a), r0 = 17, r1 = 48, cy = 6.4, R = 6.2;
    k.tube('smooth', [dx * r0, cy, dz * r0], [dx * r1, cy, dz * r1], R, C.cream, 18); k.sphere('smooth', dx * r1, cy, dz * r1, R, C.white, 1, 16);
    k.tube('smooth', [dx * (r0 + 6), cy, dz * (r0 + 6)], [dx * (r0 + 9), cy, dz * (r0 + 9)], R + 0.08, C.orange, 18); k.tube('smooth', [dx * (r1 - 5), cy, dz * (r1 - 5)], [dx * (r1 - 3.6), cy, dz * (r1 - 3.6)], R + 0.08, C.orange, 18);
    k.tube('smooth', [dx * 12, 3, dz * 12], [dx * r0, 4.5, dz * r0], 2.6, C.shell, 10);
    for (const t of [0.3, 0.55, 0.8]) { const r = r0 + (r1 - r0) * t; k.box('concrete', dx * r, 0, dz * r, 2.4, 1.8, 2.4, C.concDark, -a); for (const s of [-1, 1]) k.push('glass', wallGeo(2.6, 2.6, [0, 0, 1 / 8, 1 / 8]), 0xffffff, Mx(dx * r - s * dz * (R + 0.05), cy - 0.6, dz * r + s * dx * (R + 0.05), 0, Math.atan2(-s * dz, s * dx))); }
  }
  // centrifuge training hall, pool, running track
  k.cyl('paint', -58, 0, -34, 15, 15, 8, C.shell, 28); k.push('smooth', new THREE.ConeGeometry(15.6, 4, 28), C.tealDeep, Mx(-58, 10, -34), 4, 1); k.cyl('smooth', -58, 12, -34, 1.2, 1.2, 1.4, C.steelDark, 10);
  k.decalWall('CREW QUARTERS', -8, 2.6, 56.2, 24, 2.6, 's', C.slate); k.box('concrete', -8, 0, 56, 26, 3.8, 0.6, C.cream);
  k.flat('mark', 56, -40, 26, 13, 0.09, 0x2f8fc4); k.flat('mark', 56, -40, 30, 17, 0.085, 0xd9d2c0);
  { const x = 52, z = 26; k.disc('mark', x - 14, z, 15, 0.085, 0xb5553a, 24, 9); k.disc('mark', x + 14, z, 15, 0.085, 0xb5553a, 24, 9); k.flat('mark', x, z - 12, 28, 6, 0.085, 0xb5553a); k.flat('mark', x, z + 12, 28, 6, 0.085, 0xb5553a); k.flat('mark', x, z, 28, 18, 0.08, 0x4f8a45); k.disc('mark', x - 14, z, 9, 0.08, 0x4f8a45, 20); k.disc('mark', x + 14, z, 9, 0.08, 0x4f8a45, 20); }
  for (const [x, z] of [[-70, 30], [20, -62], [84, -10], [0, 62]]) { k.beam('metal', [x, 0, z], [x, 8, z], 0.2, C.steel); k.glow(x, 8.3, z, 0xffe2b0, 2); k.pool(x, z, 17); }
  return { focus: V3(-2, 9, 0), radius: 95, pick: [[0, 0, 0, 30, 18, 30], [0, 0, 0, 78, 13, 78], [-58, 0, -34, 32, 14, 32], [56, 0, 4, 62, 3, 104]] };
}

function buildSchool(k, movers) {
  k.flat('slab', 10, 6, 190, 110, 0.05, C.conc);
  // classroom wing (L-shaped) and the simulator dome
  k.box('paint', -34, 0, -22, 70, 10, 20, C.cream); k.box('paint', -34, 10, -22, 71, 1, 21, C.tealDeep); k.bands(-34, -22, 70, 20, 1, 2, 4.4, 'nsw', 3);
  k.box('paint', -60, 0, 4, 20, 10, 34, C.cream); k.box('paint', -60, 10, 4, 21, 1, 35, C.tealDeep); k.bands(-60, 4, 20, 34, 1, 2, 4.4, 'ew', 3);
  k.decalWall('FLIGHT SCHOOL', -30, 8.2, -11.86, 28, 2.6, 's', C.slate);
  k.cyl('paint', -14, 0, 12, 11, 11, 4, C.shell, 24); k.dome('smooth', -14, 4, 12, 11.2, C.white, 0.8, 24); k.push('smooth', new THREE.TorusGeometry(11.2, 0.4, 6, 24), C.teal, Mx(-14, 4, 12, Math.PI / 2));
  // aerodrome control tower
  const tx = 36, tz = -14;
  k.box('paint', tx, 0, tz, 16, 7, 16, C.cream); k.cyl('concrete', tx, 7, tz, 3.4, 4.6, 26, C.shell, 12); k.cyl('smooth', tx, 20, tz, 3.72, 3.72, 1.2, C.tealDeep, 12, true);
  k.cyl('smooth', tx, 33, tz, 7.4, 4.2, 2.2, C.shell, 8); k.cyl('glass', tx, 35.2, tz, 7.9, 7.0, 4.2, 0xffffff, 8, true);
  k.b.glass[k.b.glass.length - 1].uScale = 1; k.b.glass[k.b.glass.length - 1].vScale = 1 / 8;
  k.cyl('smooth', tx, 39.4, tz, 8.3, 8.3, 0.6, C.slate, 8); k.cyl('smooth', tx, 40, tz, 2, 5.6, 1.6, C.shell, 8);
  k.beam('metal', [tx - 2, 41.6, tz], [tx - 2, 48, tz], 0.12, 0xd9dee2); k.glow(tx - 2, 48.5, tz, 0xff3524, 2.2, 1, 2.2, 0.9); k.glow(tx, 37.4, tz, 0x7dffb0, 4.4, 2, 2.6, 0);
  const radar = new THREE.Group(); radar.position.set(tx + 1.6, 41.6, tz);
  const kr = new Kit(5); kr.cyl('smooth', 0, 0, 0, 0.3, 0.3, 1.6, C.steelDark, 8); kr.boxM('smooth', 6.4, 1.5, 0.3, C.orange, Mx(0, 1.6, 0, 0.2)); kr.build(radar, MAT);
  movers.push({ spin: radar, speed: 1.3 });
  // apron with two trainers
  k.flat('slab', 30, 30, 120, 44, 0.06, 0xaaa69b);
  for (const [px, pz, ry, col] of [[10, 28, 0.3, C.orange], [44, 32, -0.2, C.teal]]) {
    const m = Mx(px, 0, pz, 0, ry);
    k.push('smooth', new THREE.CylinderGeometry(0.9, 0.5, 9, 10), C.white, m.clone().multiply(Mx(0, 1.6, 0, Math.PI / 2)));
    k.push('smooth', new THREE.BoxGeometry(12, 0.22, 2), col, m.clone().multiply(Mx(0, 1.5, -1.2))); k.push('smooth', new THREE.BoxGeometry(4.4, 0.18, 1.2), col, m.clone().multiply(Mx(0, 1.9, 4)));
    k.push('smooth', new THREE.BoxGeometry(0.2, 1.9, 1.4), col, m.clone().multiply(Mx(0, 2.5, 4))); k.push('smooth', new THREE.SphereGeometry(0.8, 10, 6), 0x1c2a36, m.clone().multiply(Mx(0, 2.2, -1.4, 0, 0, 0, 1, 0.8, 1.8)));
    for (const [gx, gz] of [[0, -3.4], [-1.6, 0], [1.6, 0]]) k.push('metal', new THREE.BoxGeometry(0.16, 1.2, 0.16), C.steelDark, m.clone().multiply(Mx(gx, 0.6, gz)));
  }
  k.decalFlat('H', 74, -6, 16, 16, 0.09, 0, C.line);
  for (const [x, z] of [[-80, 30], [-20, 46], [80, 46], [70, -40]]) { k.beam('metal', [x, 0, z], [x, 9, z], 0.2, C.steel); k.glow(x, 9.3, z, 0xffe2b0, 2); k.pool(x, z, 18); }
  // the first box is the yard between the wing, the dome and the tower: the camera looks at it, so a click there must count
  return { focus: V3(4, 15, -4), radius: 90, pick: [[4, 0, 2, 124, 5, 74], [-34, 0, -22, 72, 12, 22], [-60, 0, 4, 22, 12, 36], [-14, 0, 12, 24, 14, 24], [tx, 0, tz, 18, 49, 18], [28, 0, 30, 60, 5, 24]] };
}

function buildAdmin(k, flags) {
  k.flat('slab', 0, 12, 170, 130, 0.05, C.conc);
  // podium and a slim glass tower
  k.box('paint', 0, 0, -6, 84, 9, 48, C.cream); k.box('paint', 0, 9, -6, 85, 1.2, 49, C.tealDeep); k.bands(0, -6, 84, 48, 1, 2, 4.2, 'nsew', 3);
  k.box('smooth', -14, 10.2, -10, 36, 50, 28, 0x232d37);
  k.bands(-14, -10, 36, 28, 10.4, 12, 4.1, 'nsew', 0.6, 0.86);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box('paint', -14 + sx * 18, 10.2, -10 + sz * 14, 1.6, 52, 1.6, C.white);
  k.box('paint', -14, 60.2, -10, 38, 2.4, 30, C.white); k.box('paint', -14, 62.6, -10, 20, 4, 14, C.slate); k.decalWall('emblem', -14, 56, 4.3, 7.5, 7.5, 's');
  k.beam('metal', [-20, 66.6, -12], [-20, 82, -12], 0.2, 0xd9dee2); k.glow(-20, 82.6, -12, 0xff3524, 2.6, 1, 2.2, 0.35); k.dome('smooth', -6, 66.6, -8, 3, C.white);
  k.decalWall('ADMINISTRATION', 16, 7.2, 18.14, 30, 2.6, 's', C.slate);
  k.box('concrete', 16, 0, 22, 18, 0.5, 9, C.conc); k.box('paint', 16, 4.6, 22, 20, 0.5, 8, C.tealDeep); for (const sx of [8, 24]) k.tube('metal', [sx, 0, 25], [sx, 4.6, 25], 0.28, C.steel, 8);
  // plaza: an emblem set in the paving, a ring pool, and the flag row
  k.disc('mark', 16, 50, 15, 0.085, 0xd0c8b4, 36); k.disc('mark', 16, 50, 11, 0.09, 0x3d92b8, 32, 8.4); k.decalFlat('emblem', 16, 50, 15, 15, 0.1, 0);
  for (let i = 0; i < 7; i++) {
    const x = -26 + i * 14, z = 70;
    k.tube('metal', [x, 0, z], [x, 17, z], 0.16, 0xd9dee2, 8, 0.1); k.sphere('metal', x, 17.2, z, 0.3, C.amber, 1, 8);
    flags.push([x, 13.2, z, 5.6, 3.6]);
  }
  for (const [x, z] of [[-60, 40], [70, 40], [-40, 74], [72, 74]]) { k.beam('metal', [x, 0, z], [x, 9, z], 0.2, C.steel); k.glow(x, 9.3, z, 0xffe2b0, 2); k.pool(x, z, 18); }
  return { focus: V3(-4, 30, 4), radius: 95, pick: [[0, 0, -6, 86, 11, 50], [-14, 0, -10, 40, 68, 32], [16, 0, 52, 100, 18, 46]] };
}

// ---------------------------------------------------------------------------------------------
// Scenery: roads, crawlerway, parking, fences, lamps, the campus water tower
// ---------------------------------------------------------------------------------------------
const ROADS = [
  { w: 13, pts: [[-1700, 640], [-900, 640], [820, 640], [1180, 610], [1560, 420], [2140, 330]] },
  { w: 10, pts: [[150, 640], [150, 215], [560, 215]] },
  { w: 9, pts: [[150, 330], [42, 330], [42, 150]] },
  { w: 9, pts: [[-540, 640], [-540, 410]] },
  { w: 9, pts: [[-660, 640], [-660, 730]] },
  { w: 9, pts: [[520, 640], [520, 680]] },
  { w: 9, pts: [[-232, 640], [-232, 612]] },
  { w: 9, pts: [[300, 640], [300, 545]] },
  { w: 9, pts: [[-130, 640], [-130, 570]] },
  { w: 9, pts: [[-360, 640], [-360, 672]] },
];
const LOTS = [  // [x, z, w, d, rows]
  [-170, 560, 60, 56, 4], [300, 562, 96, 30, 2], [-470, 420, 120, 30, 2], [440, 245, 100, 28, 2], [-200, 690, 90, 28, 2], [640, 668, 70, 28, 2],
];

/** The Return Pad: where a booster flying back is sent (SYSTEM.sites.landing, 600 m north of the launch pad). */
export const RETURN_PAD = { x: 0, z: -600, r: 45 };
/** Nothing grows on the Return Pad, its apron or the road to it. */
function onReturnPad(x, z) { return Math.hypot(x - RETURN_PAD.x, z - RETURN_PAD.z) < RETURN_PAD.r + 28 || (Math.abs(x - RETURN_PAD.x) < 12 && z < -170 && z > RETURN_PAD.z); }
function buildReturnPad(k) {
  const { x, z, r } = RETURN_PAD;
  k.flat('asphalt', x, (-172 + z + r) / 2, 8, -172 - (z + r) + 4, 0.06, 0x44474b);       // the road from the launch pad
  k.disc('slab', x, z, r + 6, 0.04, C.gravel, 48);
  k.disc('concrete', x, z, r, 0.06, C.conc, 64);
  k.disc('mark', x, z, r - 1.5, 0.085, C.line, 64, r - 3);                              // outer ring
  k.disc('mark', x, z, 22, 0.085, C.teal, 48, 20.4);                                    // inner ring
  k.disc('mark', x, z, 6, 0.085, C.amber, 32, 4.8); k.disc('mark', x, z, 1.6, 0.09, C.scorch, 16);   // the aim point
  for (let i = 0; i < 4; i++) {                                                         // four bars pointing in from the compass points
    const a = i * Math.PI / 2, cx = Math.cos(a), cz = Math.sin(a);
    k.flat('mark', x + cx * 31, z + cz * 31, cz ? 2.2 : 14, cz ? 14 : 2.2, 0.085, C.line);
  }
  for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6 + Math.PI / 12; k.flat('mark', x + Math.cos(a) * (r - 6), z + Math.sin(a) * (r - 6), 1.2, 1.2, 0.085, C.amber); }
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {                         // four light masts, clear of the pad
    const mx = x + sx * (r + 3) * 0.7071, mz = z + sz * (r + 3) * 0.7071;
    k.box('concrete', mx, 0, mz, 1.6, 0.4, 1.6, C.concDark); k.beam('metal', [mx, 0, mz], [mx, 16, mz], 0.2, C.white); k.glow(mx, 16.4, mz, 0xfff1c9, 1.6);
  }
}

/** The Catch Tower's compound (SYSTEM.sites.tower; the tower itself and the Tall Bay are js/render/tower.js, which
 *  keeps the same numbers): the mount, the Tall Bay's spot, and the two ways in. */
export const TOWER_SITE = { x: -420, z: -260, half: 62, bay: [-545, -340], road: [[-358, -232], [-160, -152]] };
function nearSeg(x, z, a, b, r) { const dx = b[0] - a[0], dz = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz))); return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t) < r; }
/** Nothing grows on the tower's compound, round the Tall Bay or on the ways between them. */
function onTowerSite(x, z) {
  const T = TOWER_SITE;
  return inRect(x, z, [T.x - T.half - 8, T.z - T.half - 8, T.x + T.half + 8, T.z + T.half + 8]) || Math.hypot(x - T.bay[0], z - T.bay[1]) < 52
    || nearSeg(x, z, T.bay, [T.x, T.z], 16) || nearSeg(x, z, T.road[0], T.road[1], 12);
}
function buildTowerSite(k) {
  const T = TOWER_SITE, { x, z } = T, bx = T.bay[0], bz = T.bay[1], ry = Math.atan2(bz - z, x - bx), len = Math.hypot(bx - x, bz - z);
  k.flat('slab', x, z, T.half * 2, T.half * 2, 0.03, 0xa9a59b);                          // the apron
  k.flat('slab', (x + bx) / 2, (z + bz) / 2, len, 16, 0.045, C.gravel, ry);             // the transporter's way from the Tall Bay's door
  k.flat('slab', bx, bz, 66, 60, 0.035, C.conc, ry);                                    // the Tall Bay's own slab
  k.disc('concrete', x, z, 24, 0.06, C.conc, 48);                                       // the mount's deck
  k.disc('mark', x, z, 22.4, 0.085, C.amber, 48, 21.6); k.disc('mark', x, z, 12.6, 0.085, C.teal, 48, 11.8);
  k.disc('mark', x, z, 4.4, 0.085, C.scorch, 24);                                       // the flame hole, under the stack
  k.flat('mark', x + 15, z, 16, 9, 0.085, 0x57534d);                                    // where the flame is turned out, east, away from the tower
  for (const s of [-1, 1]) k.flat('mark', x + 15, z + s * 4.9, 16, 0.5, 0.09, C.amber);
  { const [a, b] = T.road, dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz); k.flat('asphalt', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, L, 9, 0.06, C.asphalt, Math.atan2(-dz, dx)); }
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {                         // four light masts at the apron's corners
    const mx = x + sx * (T.half - 6), mz = z + sz * (T.half - 6);
    k.box('concrete', mx, 0, mz, 1.6, 0.4, 1.6, C.concDark); k.beam('metal', [mx, 0, mz], [mx, 18, mz], 0.24, C.white); k.glow(mx, 18.4, mz, 0xfff1c9, 1.8); k.pool(mx, mz, 20);
  }
  k.glow(x - 11, 107.6, z, 0xff3524, 3, 1, 1.6, 0.2);                                   // the beacon on the tower's lightning rod
}

function buildScenery(k, quality) {
  const rnd = k.rnd, cars = [], lamps = [];
  buildReturnPad(k);
  buildTowerSite(k);
  // crawlerway: two gravel tracks from the VAB door to the pad
  const z0 = 40, z1 = 470, len = z1 - z0, zc = (z0 + z1) / 2;
  for (const s of [-1, 1]) { k.flat('slab', s * 11, zc, 12, len, 0.06, C.gravel); k.flat('slab', s * 17.6, zc, 1.2, len, 0.07, C.concDark); k.flat('slab', s * 4.4, zc, 1.2, len, 0.07, C.concDark); }
  k.flat('slab', 0, 37, 46, 10, 0.06, C.gravel);
  for (let z = z0 + 20; z < z1; z += 40) for (const s of [-1, 1]) { k.box('metal', s * 21, 0, z, 0.25, 1.2, 0.25, C.steel); k.glow(s * 21, 1.4, z, 0xffc070, 1.1); }
  // roads
  for (const road of ROADS) {
    const p = road.pts;
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1], dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz), ry = Math.atan2(-dz, dx);
      k.flat('asphalt', (ax + bx) / 2, (az + bz) / 2, L, road.w, 0.06, C.asphalt, ry);
      if (i > 0) k.disc('asphalt', ax, az, road.w / 2, 0.06, C.asphalt, 14);
      const nd = Math.floor(L / 18);
      for (let j = 0; j < nd; j++) { const t = (j + 0.5) / nd; k.flat('mark', ax + dx * t, az + dz * t, 6, 0.28, 0.1, road.w > 11 ? C.yellow : C.line, ry); }
      if (road.w > 11) for (const s of [-1, 1]) k.flat('mark', (ax + bx) / 2 - s * (dz / L) * (road.w / 2 - 0.6), (az + bz) / 2 + s * (dx / L) * (road.w / 2 - 0.6), L, 0.22, 0.1, C.line, ry);
      const nl = Math.floor(L / 55);
      if (Math.abs(ax) < 1300 && Math.abs(bx) < 1300) for (let j = 0; j <= nl; j++) { const t = nl ? j / nl : 0.5, s = j % 2 ? 1 : -1; lamps.push([ax + dx * t - s * (dz / L) * (road.w / 2 + 2), az + dz * t + s * (dx / L) * (road.w / 2 + 2), ry + (s > 0 ? Math.PI : 0)]); }
    }
  }
  for (const [x, z, ry] of lamps) {
    k.tube('metal', [x, 0, z], [x, 9, z], 0.14, C.steel, 6, 0.09); const ox = Math.sin(ry) * 2.2, oz = Math.cos(ry) * 2.2;
    k.beam('metal', [x, 9, z], [x + ox, 9.4, z + oz], 0.12, C.steel); k.push('lamp', new THREE.BoxGeometry(0.9, 0.12, 0.5), 0xfff1c9, Mx(x + ox, 9.3, z + oz, 0, ry));
    k.glow(x + ox, 9.2, z + oz, 0xffd9a0, 1.9); k.pool(x + ox * 1.6, z + oz * 1.6, 19, 0xffd9a0);
  }
  // parking lots with stall lines; cars are instanced by the caller
  const pal = [0xe8eaec, 0xc9ced3, 0x30343a, 0x8a1f1f, 0x1f4f8a, 0xd8b23a, 0x2f6f5f, 0x6f757c, 0xe59a2f, 0xf4f4f0];
  for (const [x, z, w, d, rows] of LOTS) {
    if (!rows) continue;
    k.flat('asphalt', x, z, w, d, 0.06, 0x45484c);
    for (let r = 0; r < rows; r++) {
      const rz = z + (r - (rows - 1) / 2) * (d / rows);
      k.flat('mark', x, rz, w - 4, 0.18, 0.1, C.line);
      for (let cx = -w / 2 + 2; cx <= w / 2 - 2; cx += 3) {
        k.flat('mark', x + cx, rz, 0.16, 11, 0.1, C.line);
        for (const s of [-1, 1]) if (rnd() < 0.62 && cx < w / 2 - 3) cars.push([x + cx + 1.5, rz + s * 3, (s > 0 ? 0 : Math.PI) + Math.PI / 2 + (rnd() - 0.5) * 0.06, pal[Math.floor(rnd() * pal.length)], 0.9 + rnd() * 0.2]);
      }
    }
  }
  // perimeter fences (pad and tracking), with a guard hut at the pad gate
  const fence = (pts, h = 2.6) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz), ry = Math.atan2(-dz, dx);
      k.push('fence', wallGeo(L, h, [0, 0, L / 2.6, 1]), 0xffffff, Mx((ax + bx) / 2, 0, (az + bz) / 2, 0, ry));
      const n = Math.max(1, Math.round(L / 13));
      for (let j = 0; j <= n; j++) k.box('metal', ax + (dx * j) / n, 0, az + (dz * j) / n, 0.14, h + 0.3, 0.14, C.steel);
    }
  };
  fence([[-28, 150], [-150, 150], [-150, -150], [150, -150], [150, 150], [58, 150]]);
  k.box('paint', 62, 0, 158, 7, 3.4, 6, C.cream); k.box('paint', 62, 3.4, 158, 8, 0.4, 7, C.tealDeep); k.win(62, 1.2, 154.9, 5, 1.6, 'n', 2.5);
  for (const s of [-1, 1]) for (let i = 0; i < 4; i++) k.box('smooth', 42 + s * 7 + i * s * 1.6, 1.0, 152, 1.6, 0.3, 0.3, i % 2 ? C.red : C.white);
  fence([[520, 110], [520, 320], [780, 320], [780, 110], [520, 110]]);
  // main gate on the avenue, west side
  k.box('paint', -940, 0, 652, 10, 4, 8, C.cream); k.box('paint', -940, 4, 646, 26, 0.6, 22, C.tealDeep); for (const sz of [-9, 9]) k.tube('metal', [-950, 0, 640 + sz], [-950, 4, 640 + sz], 0.3, C.steel, 8);
  k.box('concrete', -960, 0, 626, 24, 3.2, 1.4, C.cream); k.decalWall('wordmark', -960, 1.8, 625.2, 21, 2.6, 'n', C.slate);
  // campus water tower (a landmark by the avenue)
  { const x = -60, z = 706; k.cyl('smooth', x, 34, z, 9, 6.2, 9, C.white, 22); k.dome('smooth', x, 43, z, 9, C.shell, 0.45); k.cyl('smooth', x, 31, z, 6.2, 1.2, 3, C.shell, 22); k.cyl('smooth', x, 37.4, z, 9.06, 9.06, 2.4, C.tealDeep, 22, true);
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; k.beam('metal', [x + Math.cos(a) * 9, 0, z + Math.sin(a) * 9], [x + Math.cos(a) * 6, 34.6, z + Math.sin(a) * 6], 0.55, C.steel); if (i % 2 === 0) k.beam('metal', [x + Math.cos(a) * 8, 12, z + Math.sin(a) * 8], [x + Math.cos(a + Math.PI / 3) * 7, 24, z + Math.sin(a + Math.PI / 3) * 7], 0.2, C.steel); }
    k.tube('smooth', [x, 0, z], [x, 31, z], 1.1, C.steel, 10); k.disc('slab', x, z, 13, 0.06, C.conc); k.decalWall('emblemMono', x, 38.6, z + 9.1, 3.4, 3.4, 's', C.white); k.glow(x, 47.6, z, 0xff3524, 2.4, 1, 2.2, 0.15); }
  // fuel depot and warehouses along the east road, a small substation
  for (let i = 0; i < 3; i++) { const x = 940 + i * 46, z = 680 + (i % 2) * 6; k.box('paint', x, 0, z, 38, 10, 26, i % 2 ? C.cream : C.shell); k.boxM('paint', 20, 0.5, 27, C.slate, Mx(x - 9.6, 10, z, 0, 0, 0.2)); k.boxM('paint', 20, 0.5, 27, C.slate, Mx(x + 9.6, 10, z, 0, 0, -0.2)); k.box('smooth', x, 0.1, z - 13.2, 12, 7, 0.4, 0x2a3038); }
  k.flat('slab', 985, 676, 170, 60, 0.05, C.conc);
  for (let i = 0; i < 4; i++) { k.cyl('smooth', 760 + i * 17, 0, 700, 6.5, 6.5, 9, C.white, 18); k.cyl('smooth', 760 + i * 17, 9, 700, 0.5, 6.5, 1.2, C.shell, 18); }
  k.flat('slab', 786, 700, 84, 26, 0.05, C.conc);
  if (quality !== 'low') {
    for (let i = 0; i < 5; i++) for (let j = 0; j < 2; j++) { const x = -820 + i * 9, z = 560 + j * 10; k.box('smooth', x, 0, z, 3, 5, 3, 0x7c858f); k.beam('metal', [x, 5, z], [x, 8, z], 0.2, C.steel); if (i < 4) k.beam('metal', [x, 7.6, z], [x + 9, 7.6, z], 0.08, C.dark); }
    k.flat('slab', -802, 565, 56, 30, 0.05, 0x8f8b82);
  }
  return { cars };
}

// ---------------------------------------------------------------------------------------------
// Instanced props
// ---------------------------------------------------------------------------------------------
/** A wheel lying along X (axle), centred. */
function wheelGeo(r, w, seg = 8) { const g = new THREE.CylinderGeometry(r, r, w, seg); g.rotateZ(Math.PI / 2); return g; }
/** A box whose top is narrower than its base (cabins, bonnets): top scale tx, tz and a shift of the top along z. */
function taperGeo(w, h, d, tx, tz, shift = 0) {
  const g = new THREE.BoxGeometry(w, h, d), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) { p.setX(i, p.getX(i) * tx); p.setZ(i, p.getZ(i) * tz + shift); }
  g.computeVertexNormals();
  return g;
}
function carGeometry() {
  const tyre = 0x0e0f11, glass = 0x161d25;
  return mergeGeometries([
    { geo: taperGeo(1.8, 0.62, 4.3, 0.96, 0.97), color: 0xffffff, m: Mx(0, 0.72, 0) },
    { geo: new THREE.BoxGeometry(1.74, 0.16, 4.36), color: 0x23272c, m: Mx(0, 0.4, 0) },
    { geo: taperGeo(1.66, 0.56, 2.5, 0.84, 0.66, -0.08), color: glass, m: Mx(0, 1.3, -0.2) },
    { geo: new THREE.BoxGeometry(1.36, 0.07, 1.5), color: 0xffffff, m: Mx(0, 1.6, -0.27) },
    { geo: new THREE.BoxGeometry(1.5, 0.12, 0.08), color: 0xfff4d6, m: Mx(0, 0.82, 2.14) }, { geo: new THREE.BoxGeometry(1.5, 0.12, 0.08), color: 0x8a1410, m: Mx(0, 0.84, -2.14) },
    ...[[-1, 1], [1, 1], [-1, -1], [1, -1]].map(([sx, sz]) => ({ geo: wheelGeo(0.36, 0.26), color: tyre, m: Mx(sx * 0.82, 0.36, sz * 1.36) })),
  ]);
}
function truckGeometry() {
  const tyre = 0x0e0f11;
  return mergeGeometries([
    { geo: new THREE.BoxGeometry(2.3, 0.3, 8.6), color: 0x23272c, m: Mx(0, 0.95, 0) },
    { geo: new THREE.BoxGeometry(2.5, 2.5, 5.9), color: 0xffffff, m: Mx(0, 2.35, -1.3) },
    { geo: new THREE.BoxGeometry(2.52, 0.3, 5.92), color: 0x1e9c90, m: Mx(0, 1.7, -1.3) },
    { geo: taperGeo(2.4, 1.9, 2.1, 0.94, 0.8, -0.14), color: 0xd7dade, m: Mx(0, 2.05, 3.15) },
    { geo: new THREE.BoxGeometry(2.1, 0.75, 0.1), color: 0x18202a, m: Mx(0, 2.45, 4.02, -0.18) },
    { geo: new THREE.BoxGeometry(2.3, 0.14, 0.1), color: 0xfff4d6, m: Mx(0, 1.25, 4.22) },
    { geo: new THREE.BoxGeometry(0.5, 0.16, 0.3), color: 0xe59a2f, m: Mx(0, 3.08, 3.0) },
    ...[[-1, 3.0], [1, 3.0], [-1, -1.9], [1, -1.9], [-1, -3.1], [1, -3.1]].map(([sx, z]) => ({ geo: wheelGeo(0.52, 0.36), color: tyre, m: Mx(sx * 1.08, 0.52, z) })),
  ]);
}
/** A Pip in a flight suit, about 1.5 m tall, feet at y = 0, facing +Z. */
function pipGeometry() {
  const suit = 0xe2702a, white = 0xeef0f2;
  return mergeGeometries([
    { geo: new THREE.CapsuleGeometry(0.3, 0.42, 3, 8), color: suit, m: Mx(0, 0.62, 0) },
    { geo: new THREE.SphereGeometry(0.37, 10, 8), color: white, m: Mx(0, 1.22, 0) },
    { geo: new THREE.SphereGeometry(0.27, 8, 6), color: 0x1a222b, m: Mx(0, 1.22, 0.17, 0, 0, 0, 1, 0.82, 0.8) },
    { geo: new THREE.BoxGeometry(0.42, 0.5, 0.22), color: white, m: Mx(0, 0.74, -0.3) },
    { geo: new THREE.CylinderGeometry(0.02, 0.02, 0.3, 4), color: 0x555d66, m: Mx(0.12, 1.68, -0.05) }, { geo: new THREE.SphereGeometry(0.06, 5, 4), color: 0x39d0c0, m: Mx(0.12, 1.84, -0.05) },
    { geo: new THREE.CapsuleGeometry(0.11, 0.16, 2, 6), color: 0x30353c, m: Mx(-0.15, 0.16, 0.02) }, { geo: new THREE.CapsuleGeometry(0.11, 0.16, 2, 6), color: 0x30353c, m: Mx(0.15, 0.16, 0.02) },
    { geo: new THREE.CapsuleGeometry(0.09, 0.26, 2, 6), color: suit, m: Mx(-0.36, 0.66, 0, 0, 0, 0.25) }, { geo: new THREE.CapsuleGeometry(0.09, 0.26, 2, 6), color: suit, m: Mx(0.36, 0.66, 0, 0, 0, -0.25) },
  ]);
}

/** The crawler-transporter (origin: its centre on the ground; the deck top is at y = 8.2). */
function buildCrawler(k) {
  k.box('smooth', 0, 5.2, 0, 40, 2.6, 34, 0x5a626c); k.box('smooth', 0, 7.8, 0, 38, 0.4, 32, 0x767e88);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * 13, zz = sz * 11; k.box('smooth', x, 0.2, zz, 9, 4.6, 12, 0x30353c); k.box('smooth', x, 4.8, zz, 4, 0.6, 5, C.amber);
    for (const s2 of [-1, 1]) { k.box('smooth', x + s2 * 3.6, 0.5, zz, 1.8, 2.4, 11, 0x1b1e22); for (const e of [-1, 1]) k.push('smooth', new THREE.CylinderGeometry(1.6, 1.6, 1.8, 12), 0x1b1e22, Mx(x + s2 * 3.6, 1.7, zz + e * 5.4, 0, 0, Math.PI / 2)); for (let i = 0; i < 7; i++) k.box('metal', x + s2 * 3.6, 3.26, zz - 5.1 + i * 1.7, 1.9, 0.12, 0.5, 0x3a4048); }
  }
  k.box('smooth', 16, 7.8, -12, 5, 3, 5, C.white); k.win(16, 8.6, -14.6, 4.4, 1.6, 'n', 2.2); k.box('smooth', -16, 7.8, 12, 5, 3, 5, C.white); k.win(-16, 8.6, 14.6, 4.4, 1.6, 's', 2.2);
  for (let i = 0; i < 6; i++) { k.box('smooth', -18 + i * 7.2, 8.2, 17.2, 3, 0.3, 0.4, i % 2 ? C.amber : C.dark); k.box('smooth', -18 + i * 7.2, 8.2, -17.2, 3, 0.3, 0.4, i % 2 ? C.dark : C.amber); }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { k.beam('metal', [sx * 19, 8.2, sz * 16], [sx * 19, 9.6, sz * 16], 0.14, C.amber); }
}
/** The show rocket: a two-stage launcher with two strap-on boosters, about 47 m tall, standing on a launch mount.
 *  Origin: the ground under its axis. The boosters sit on the ±Z sides, clear of the service tower's swing arms. */
function buildShowRocket(k) {
  const W = 0xeceff1, D = 0x20252b, y0 = 2.2;
  k.box('smooth', 0, 0, 0, 9, 1.4, 12, 0x4a525c); for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box('smooth', sx * 2.6, 1.4, sz * 4.2, 1.1, 1.5, 1.1, C.amber);
  k.cyl('smooth', 0, y0, 0, 0.9, 1.5, 1.6, D, 16); k.cyl('smooth', 0, y0 + 1.6, 0, 2.2, 2.2, 23, W, 28);
  k.cyl('smooth', 0, y0 + 1.6, 0, 2.23, 2.23, 1.4, D, 28, true); k.cyl('smooth', 0, y0 + 13, 0, 2.23, 2.23, 0.7, C.teal, 28, true); k.cyl('smooth', 0, y0 + 22.4, 0, 2.23, 2.23, 2.2, D, 28, true);
  k.cyl('smooth', 0, y0 + 24.6, 0, 1.7, 2.2, 1.6, 0x8b949e, 28); k.cyl('smooth', 0, y0 + 26.2, 0, 1.7, 1.7, 8, W, 24); k.cyl('smooth', 0, y0 + 30.5, 0, 1.73, 1.73, 0.6, C.amber, 24, true);
  k.cyl('smooth', 0, y0 + 34.2, 0, 2.1, 1.7, 1.2, W, 24); k.cyl('smooth', 0, y0 + 35.4, 0, 2.1, 2.1, 4.2, W, 24);
  { const pts = []; for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push(new THREE.Vector2(2.1 * Math.cos(t * Math.PI / 2) ** 0.8 + 0.001, 5.4 * Math.sin(t * Math.PI / 2))); } k.push('smooth', new THREE.LatheGeometry(pts, 24), W, Mx(0, y0 + 39.6, 0)); }
  k.decalWall('emblem', 0, y0 + 18.5, 2.24, 3.2, 3.2, 's'); k.decalWall('emblem', 0, y0 + 18.5, -2.24, 3.2, 3.2, 'n');
  for (const sz of [-1, 1]) {
    const z = sz * 3.35; k.cyl('smooth', 0, y0 + 0.2, z, 0.55, 0.95, 1.3, D, 12); k.cyl('smooth', 0, y0 + 1.5, z, 1.1, 1.1, 15, W, 18); k.cyl('smooth', 0, y0 + 1.5, z, 1.12, 1.12, 1, C.orange, 18, true);
    k.cyl('smooth', 0, y0 + 16.5, z, 0.12, 1.1, 3.2, C.orange, 18); k.box('smooth', 0, y0 + 4, sz * 2.5, 0.5, 0.4, 0.8, D); k.box('smooth', 0, y0 + 13, sz * 2.5, 0.5, 0.4, 0.8, D);
    k.boxM('smooth', 0.14, 3.4, 2.2, C.teal, Mx(0, y0 + 0.6, z + sz * 1.6, sz * 0.32));
  }
  for (const sx of [-1, 1]) k.boxM('smooth', 2.2, 3.4, 0.14, C.teal, Mx(sx * 3.0, y0 + 1.2, 0, 0, 0, -sx * 0.32));
}

function inRect(x, z, r, pad = 0) { return x > r[0] - pad && x < r[2] + pad && z > r[1] - pad && z < r[3] + pad; }

/** True where nothing of the base stands (used for trees). */
function clearGround(x, z) {
  const B = BASE_LAYOUT;
  if (inRect(x, z, [-175, -175, 175, 175])) return false;                               // pad compound
  if (inRect(x, z, [-34, 150, 60, 480])) return false;                                  // crawlerway + service road
  if (inRect(x, z, [B.runwayX[0] - 400, 730, B.runwayX[1] + 400, 940])) return false;   // runway, taxiway and approach
  if (inRect(x, z, [1040, 800, 1400, 900])) return false;
  for (const [id, r] of [['hangar', 150], ['missions', 110], ['admin', 100], ['research', 140], ['tracking', 150], ['crew', 95], ['school', 110], ['spaceplane', 115]]) { const p = B[id]; if (Math.hypot(x - p[0], z - p[1]) < r) return false; }
  for (const road of ROADS) for (let i = 0; i < road.pts.length - 1; i++) {
    const [ax, az] = road.pts[i], [bx, bz] = road.pts[i + 1], dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    if (Math.hypot(x - ax - dx * t, z - az - dz * t) < road.w / 2 + 7) return false;
  }
  for (const l of LOTS) if (l[4] && inRect(x, z, [l[0] - l[2] / 2, l[1] - l[3] / 2, l[0] + l[2] / 2, l[1] + l[3] / 2], 6)) return false;
  if (inRect(x, z, [900, 640, 1080, 715]) || inRect(x, z, [740, 680, 830, 716]) || inRect(x, z, [-840, 545, -770, 585]) || inRect(x, z, [-980, 610, -920, 670])) return false;
  if (Math.hypot(x + 60, z - 706) < 18) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// createBase
// ---------------------------------------------------------------------------------------------
export function createBase({ quality = 'high', interactive = false, planetRadius = 0, vegetation = 'auto' } = {}) {
  MAT = MAT || buildMaterials();
  const M = MAT, L = BASE_LAYOUT, low = quality === 'low';
  if (M.grime) M.grime.value = low ? 0 : 1;      // weathering in the shader: not at low quality
  const group = new THREE.Group(); group.name = 'starwrightBase';
  const drop = (x, z) => (planetRadius > 0 ? -(x * x + z * z) / (2 * planetRadius) : 0);
  const bend = planetRadius > 0 ? (geo, off) => { const p = geo.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + drop(p.getX(i) + off.x, p.getZ(i) + off.z) - drop(off.x, off.z)); geo.computeBoundingSphere(); geo.computeBoundingBox(); } : null;
  const movers = [], flags = [], glows = [], owned = [];
  const builders = { hangar: buildHangar, pad: buildPad, runway: buildRunway, spaceplane: buildSpaceplaneHangar, tracking: buildTracking, research: buildResearch, missions: buildMissions, crew: buildCrew, school: buildSchool, admin: buildAdmin };

  const footprints = {};
  const buildings = BASE_BUILDINGS.map((def, i) => {
    const [bx, bz] = L[def.id], k = new Kit(100 + i * 17), obj = new THREE.Group();
    obj.name = 'building:' + def.id; obj.position.set(bx, drop(bx, bz), bz);
    const flagStart = flags.length;
    const info = builders[def.id](k, def.id === 'admin' ? flags : movers);
    for (let j = flagStart; j < flags.length; j++) { flags[j][0] += bx; flags[j][2] += bz; }
    if (def.id !== 'pad' && def.id !== 'runway') for (const [x, y0, z, w, h, d] of info.pick) {
      if (y0 > 0.5 || h < 5 || w * d < 60) continue;
      const m = Math.min(16, 6 + h * 0.16), shade = Math.max(0.16, 0.34 - h * 0.003);      // linear: 0.3 reads as about 40 % darker
      k.push('ao', skirtGeo(w - 4.4, d - 4.4, m), (c, px, py, pz) => { const edge = Math.max(Math.abs(px - x) - (w - 4.4) / 2, Math.abs(pz - z) - (d - 4.4) / 2); c.setScalar(edge > 0.01 ? 1 : shade); }, Mx(x, 0.09, z));
    }
    k.build(obj, M, { bend });
    footprints[def.id] = info.pick;
    if (info.extra) for (const e of info.extra) obj.add(e);
    for (const g of k.glows) glows.push([g[0] + bx, g[1] + drop(g[0] + bx, g[2] + bz), g[2] + bz, g[3], g[4], g[5], g[6], g[7]]);
    group.add(obj);
    const b = { id: def.id, name: def.name, blurb: def.blurb, object3d: obj, focus: info.focus.clone().add(obj.position), radius: info.radius, pick: null };
    if (interactive) {
      b.pick = new THREE.Group(); b.pick.name = 'pick:' + def.id; b.pick.position.copy(obj.position);
      // plus a pillar through the focus point: the camera looks at that point when it flies to the building, and a click
      // there must pick it even where the point hangs between two halls
      const fp = info.focus, picks = [...info.pick, [fp.x, 0, fp.z, 22, fp.y + 3, 22]];
      for (const [x, y0, z, w, h, d] of picks) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M.pick); m.position.set(x, y0 + h / 2, z); m.userData.building = def.id; b.pick.add(m); owned.push(m.geometry); }
      group.add(b.pick);
    }
    return b;
  });

  // scenery (not part of any building): roads, lots, fences, lamps, landmarks
  const ks = new Kit(9), scenery = new THREE.Group(); scenery.name = 'scenery';
  const { cars } = buildScenery(ks, quality);
  ks.build(scenery, M, { bend });
  for (const g of ks.glows) glows.push([g[0], g[1] + drop(g[0], g[2]), g[2], g[3], g[4], g[5], g[6], g[7]]);
  group.add(scenery);

  // flags (one mesh, waved in the vertex shader)
  { const items = [];
    for (const [x, y, z, w, h] of flags) {
      const g = new THREE.PlaneGeometry(w, h, 10, 3); g.translate(w / 2, 0, 0);
      const wave = new Float32Array(g.attributes.position.count); for (let i = 0; i < wave.length; i++) wave[i] = g.attributes.position.getX(i);
      const R = TEX.region.flag, uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, R[0] + uv.getX(i) * (R[2] - R[0]), R[1] + uv.getY(i) * (R[3] - R[1]));
      g.setAttribute('aWave', new THREE.BufferAttribute(wave, 1)); g.translate(x, y + drop(x, z), z); items.push(g);
    }
    if (items.length) {
      const n = items.reduce((s, g) => s + g.index.count, 0), pos = [], nor = [], uv = [], wv = [], idx = new Uint32Array(n); let o = 0, vo = 0;
      for (const g of items) { pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array); uv.push(...g.attributes.uv.array); wv.push(...g.attributes.aWave.array); for (let i = 0; i < g.index.count; i++) idx[o++] = g.index.array[i] + vo; vo += g.attributes.position.count; g.dispose(); }
      const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); fg.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); fg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); fg.setAttribute('aWave', new THREE.Float32BufferAttribute(wv, 1)); fg.setIndex(new THREE.BufferAttribute(idx, 1));
      const mesh = new THREE.Mesh(fg, M.flag); mesh.name = 'flags'; mesh.castShadow = true; group.add(mesh);
    } }

  // glow sprites (lamps, beacons, runway lights): one draw call
  { const n = glows.length, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), fx = new Float32Array(n * 3), c = new THREE.Color();
    glows.forEach((g, i) => { pos.set([g[0], g[1], g[2]], i * 3); c.set(g[3]); col.set([c.r * 2.2, c.g * 2.2, c.b * 2.2], i * 3); size[i] = g[4]; fx.set([g[5], g[6], g[7]], i * 3); });
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1)); geo.setAttribute('aFx', new THREE.BufferAttribute(fx, 3));
    geo.computeBoundingSphere();
    const pts = new THREE.Points(geo, M.glow); pts.name = 'glows'; pts.renderOrder = 6; pts.frustumCulled = false;
    const _sz = new THREE.Vector2();
    pts.onBeforeRender = (renderer, scene, camera) => { const rt = renderer.getRenderTarget(); M.glow.uniforms.uScale.value = (rt ? rt.height : renderer.getDrawingBufferSize(_sz).y) * camera.projectionMatrix.elements[5] * 0.5; };   // pixels of the surface being drawn into (a scene target may be smaller than the canvas)
    group.add(pts); }

  // ---- vegetation (js/render/flora.js): trees with levels of detail and impostors, grass round the camera
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  let flora = null, grass = null, paved = null, vegNow = vegLevel(vegetation, quality);
  try {
    const rnd = rng(4242), noise = makeNoise(88), list = [];
    const want = low ? 1400 : 4200;
    for (let tries = 0, placed = 0; tries < want * 14 && placed < want; tries++) {
      const far = rnd() < 0.45, x = far ? -2900 + rnd() * 5100 : L.bounds[0] - 150 + rnd() * (L.bounds[2] - L.bounds[0] + 300), z = far ? -2600 + rnd() * 5000 : L.bounds[1] - 150 + rnd() * (L.bounds[3] - L.bounds[1] + 300);
      if (x > 2260 || Math.hypot(x, z) > 3000 || !clearGround(x, z)) continue;
      const grove = fbm(noise, (x + 4000) / 1500, (z + 4000) / 1500, 4, 3);
      // groves and tree lines with clearings between them: a second, finer pattern cuts the woods into stands, and
      // only a few lone trees stand in the open
      const stands = fbm(noise, (x + 1300) / 330, (z + 7700) / 330, 3, 2);
      const wood = grove * 0.55 + stands * 0.45;
      if (wood < (far ? 0.535 : 0.52) && rnd() > (far ? 0.012 : 0.025)) continue;
      // which wood this is: conifers keep to their own stands, palms to the shore, the broadleaf species drift into each other
      const stand = fbm(noise, (x + 9000) / 1900, (z + 2000) / 1900, 3, 2), mix = fbm(noise, (x + 700) / 420, (z + 5200) / 420, 4, 2), pick = rnd();
      let species;
      if (x > 1750) species = 'palm';
      else if (stand > 0.52) species = mix + (pick - 0.5) * 0.5 > 0.52 ? 'pine' : 'spruce';
      else if (pick < 0.03) species = 'palm';
      else species = mix + (pick - 0.5) * 0.36 > 0.56 ? 'birch' : (mix + (pick - 0.5) * 0.36 > 0.44 ? 'maple' : 'oak');
      const v = 0.82 + rnd() * 0.3, hue = (rnd() - 0.5) * 0.16, big = rnd(), young = rnd() < 0.14;
      // understory at the edge of the stands: shrubs round the feet of the trees (not at low quality)
      if (!low && wood < 0.62) for (let b = rnd() < 0.75 ? 1 + Math.floor(rnd() * 4) : 0; b > 0; b--) {
        const ba = rnd() * TAU, bd = 3 + rnd() * 9, bx = x + Math.cos(ba) * bd, bz = z + Math.sin(ba) * bd;
        if (clearGround(bx, bz)) list.push({ x: bx, y: drop(bx, bz), z: bz, species: 'bush', scale: 0.7 + 0.9 * rnd(), tall: 0.8 + 0.4 * rnd(), yaw: rnd() * TAU, leanX: 0, leanZ: 0, tint: [v * (1 + hue), v, v * (1 - hue) * 0.95] });
      }
      list.push({ x, y: drop(x, z), z, species, scale: young ? 0.4 + 0.2 * rnd() : (species === 'palm' ? 0.95 : 0.78) + 0.4 * big * big + 0.25 * rnd(), tall: 0.9 + 0.22 * rnd(), yaw: rnd() * TAU, leanX: (rnd() - 0.5) * 0.09, leanZ: (rnd() - 0.5) * 0.09,
        tint: [v * (1 + hue), v * (1 + Math.abs(hue) * 0.2), v * (1 - hue) * 0.95] });
      placed++;
    }
    // tall grass and weeds gone to seed, in patches in the open and thicker toward the stands (not at low quality)
    if (!low) for (let i = 0, placed = 0; i < 30000 && placed < 2600; i++) {
      const x = L.bounds[0] - 300 + rnd() * (L.bounds[2] - L.bounds[0] + 600), z = L.bounds[1] - 300 + rnd() * (L.bounds[3] - L.bounds[1] + 600);
      if (x > 2260 || !clearGround(x, z)) continue;
      if (fbm(noise, (x + 300) / 95, (z + 900) / 95, 3, 2) < 0.56) continue;
      const v = 0.9 + 0.3 * rnd();
      list.push({ x, y: drop(x, z), z, species: 'bush', scale: 0.3 + 0.4 * rnd(), tall: 0.9 + 0.7 * rnd(), yaw: rnd() * TAU, leanX: 0, leanZ: 0, tint: [v * 1.18, v * 1.06, v * 0.7] });
      placed++;
    }
    for (let i = list.length - 1; i >= 0; i--) if (onReturnPad(list[i].x, list[i].z) || onTowerSite(list[i].x, list[i].z)) list.splice(i, 1);      // (taken out afterwards, so that every other tree stands where it did)
    flora = createTreeSystem({ trees: list, detail: vegNow, planetRadius, shadows: !low });
    group.add(flora.group);
    // field stones: lumpy boulders in the open and at the edges of the stands (one instanced mesh; not at low quality)
    if (!low) {
      const rg = new THREE.IcosahedronGeometry(1, 1), rp = rg.attributes.position;
      for (let i = 0; i < rp.count; i++) { const x = rp.getX(i), y = rp.getY(i), z = rp.getZ(i), k = 0.78 + 0.34 * noise(x * 1.7 + 5, z * 1.7 + y * 2.3) + 0.12 * noise(x * 4.1, y * 4.1 + z * 3.3); rp.setXYZ(i, x * k, Math.max(y * k * 0.62, -0.3), z * k); }
      rg.computeVertexNormals();
      const N = 900, rocks = new THREE.InstancedMesh(rg, new THREE.MeshLambertMaterial({ color: 0xffffff }), N), m4 = new THREE.Matrix4(), col = new THREE.Color();
      let n = 0;
      for (let i = 0; i < 20000 && n < N; i++) {
        const x = L.bounds[0] - 300 + rnd() * (L.bounds[2] - L.bounds[0] + 600), z = L.bounds[1] - 300 + rnd() * (L.bounds[3] - L.bounds[1] + 600);
        if (x > 2260 || !clearGround(x, z) || onReturnPad(x, z) || fbm(noise, (x + 5100) / 210, (z + 100) / 210, 3, 2) < 0.55) continue;
        const sc = 0.25 + 1.3 * rnd() * rnd(), g = 0.36 + 0.2 * rnd();
        m4.compose(V3(x, drop(x, z) - 0.05 * sc, z), _q.setFromEuler(_e.set((rnd() - 0.5) * 0.5, rnd() * TAU, (rnd() - 0.5) * 0.5)), V3(sc * (0.8 + 0.5 * rnd()), sc * (0.6 + 0.4 * rnd()), sc * (0.8 + 0.5 * rnd())));
        if (onTowerSite(x, z)) continue;                                                 // (after the draws, so that every other stone lies where it did)
        rocks.setMatrixAt(n, m4); rocks.setColorAt(n, col.setRGB(g * 1.04, g, g * 0.92)); n++;
      }
      rocks.count = n; rocks.name = 'rocks'; rocks.castShadow = true; rocks.receiveShadow = true; rocks.instanceMatrix.needsUpdate = true; if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
      rocks.frustumCulled = false; group.add(rocks);
    }
  } catch (err) { console.warn('[base] the trees could not be built:', err && err.message); flora = null; }
  // where grass must not grow: everything paved or built on, drawn from above into a mask (1 px per metre)
  if (!low) try {
    const R = [-1840, -688, 4096, 1920], c = cv(R[2], R[3]), g = c.getContext('2d');      // (north far enough to take in the Return Pad)
    g.fillStyle = '#000'; g.fillRect(0, 0, R[2], R[3]); g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineWidth = 1.6; g.lineJoin = 'round';
    const BUCKETS = { slab: 1, asphalt: 1, concrete: 1, paint: 1 };
    group.updateMatrixWorld(true);
    group.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || !BUCKETS[o.name] || !o.geometry.attributes.position) return;
      const P = o.geometry.attributes.position.array, ox = o.parent.position.x - R[0], oz = o.parent.position.z - R[1];
      g.beginPath();
      for (let i = 0; i < P.length; i += 9) { g.moveTo(P[i] + ox, P[i + 2] + oz); g.lineTo(P[i + 3] + ox, P[i + 5] + oz); g.lineTo(P[i + 6] + ox, P[i + 8] + oz); g.closePath(); }
      g.fill(); g.stroke();
    });
    const src = g.getImageData(0, 0, R[2], R[3]).data, red = new Uint8Array(R[2] * R[3]);
    for (let i = 0; i < red.length; i++) red[i] = src[i * 4];
    const mt = new THREE.DataTexture(red, R[2], R[3], THREE.RedFormat); mt.magFilter = THREE.LinearFilter; mt.minFilter = THREE.LinearMipmapLinearFilter; mt.generateMipmaps = true; mt.needsUpdate = true; mt.name = 'paved';     // (its blurred mip levels tell the ground shader how near pavement is)
    grass = createGrass({ mask: { texture: mt, rect: R }, planetRadius, detail: vegNow });
    grass.maskTexture = mt; paved = { texture: mt, rect: R };
    group.add(grass.group);
  } catch (err) { console.warn('[base] the grass could not be built:', err && err.message); grass = null; }
  // instanced parked cars + moving service vehicles
  let traffic = null;
  { const cg = carGeometry(); owned.push(cg);
    const im = new THREE.InstancedMesh(cg, M.car, cars.length); im.name = 'cars';
    cars.forEach(([x, z, ry, color, s], i) => { dummy.position.set(x, drop(x, z), z); dummy.rotation.set(0, ry, 0); dummy.scale.set(s, s, s); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix); im.setColorAt(i, tint.set(color)); });
    im.castShadow = !low; im.receiveShadow = true; group.add(im);
    const tgeo = truckGeometry(); owned.push(tgeo);
    const routes = [
      { pts: [[-900, 643], [820, 643]], speed: 14, color: 0xe8eaec }, { pts: [[820, 637], [-900, 637]], speed: 12, color: 0x1e9c90 },
      { pts: [[-400, 643], [147, 643], [147, 218], [540, 218]], speed: 10, color: 0xe59a2f, bounce: true },
      { pts: [[153, 640], [153, 333], [45, 333], [45, 160]], speed: 8, color: 0xe8eaec, bounce: true },
      { pts: [[-980, 771], [300, 771]], speed: 6, color: 0xd8b23a, bounce: true },
      { pts: [[42, 326], [42, 160]], speed: 5, color: 0xc5382b, bounce: true },
      { pts: [[-540, 636], [-540, 420]], speed: 7, color: 0xf4f4f0, bounce: true },
      { pts: [[820, 643], [1180, 613], [1560, 423], [2100, 336]], speed: 16, color: 0x6f757c, bounce: true },
    ];
    const tm = new THREE.InstancedMesh(tgeo, M.car, routes.length); tm.name = 'traffic'; tm.castShadow = true; tm.receiveShadow = true; tm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    routes.forEach((r, i) => { r.len = []; r.total = 0; for (let j = 0; j < r.pts.length - 1; j++) { const d = Math.hypot(r.pts[j + 1][0] - r.pts[j][0], r.pts[j + 1][1] - r.pts[j][1]); r.len.push(d); r.total += d; } r.s = (i * 0.37 % 1) * r.total; r.dir = 1; tm.setColorAt(i, tint.set(r.color)); });
    group.add(tm); traffic = { mesh: tm, routes };
  }

  // ---- moving parts: assembly doors, the crawler, the show rocket, Pips on foot
  const doors = {};
  { const hb = buildings.find(b => b.id === 'hangar').object3d, n = -48;
    const g = mergeGeometries([{ geo: boxGeo(32, 26, 0.5, TILE.paint), color: 0xd0d5da }, ...[5, 11, 17, 23].map(y => ({ geo: boxGeo(32.1, 0.5, 0.7, 8), color: C.steelDark, m: Mx(0, y, 0) })), { geo: boxGeo(32.1, 1.6, 0.72, 8), color: C.amber, m: Mx(0, 0, 0) }]);
    const m = new THREE.Mesh(g, M.paint); m.name = 'door'; m.castShadow = true; m.receiveShadow = true; m.position.set(0, 0.1, n - 1.0); hb.add(m); owned.push(g);
    doors.hangar = { cur: 0, goal: 0, apply(t) { m.position.y = 0.1 + t * 25.4; } };
    const sb = buildings.find(b => b.id === 'spaceplane').object3d, zf = 40, leaves = [];
    for (const sx of [-1, 1]) { const lg = mergeGeometries([...[0, 1, 2, 3].map(i => ({ geo: boxGeo(5, 19, 0.2 + (i % 2) * 0.12, TILE.paint), color: i % 2 ? 0xc6ccd2 : 0xd6dade, m: Mx(-sx * (2.5 + i * 5), 0, 0) })), { geo: boxGeo(20.05, 1.2, 0.36, 8), color: C.tealDeep, m: Mx(-sx * 10, 9, 0) }]); const lm = new THREE.Mesh(lg, M.paint); lm.name = 'door'; lm.castShadow = true; lm.receiveShadow = true; sb.add(lm); owned.push(lg); leaves.push([lm, sx]); }
    doors.spaceplane = { cur: 0, goal: 0, apply(t) { for (const [lm, sx] of leaves) { lm.position.set(-6 + sx * 20, 0.1, zf + 0.62); lm.scale.set(1 - 0.86 * t, 1, 1 + t * 3); } } };   // the leaves fold back to the jambs
    for (const d of Object.values(doors)) d.apply(0); }

  const crawler = new THREE.Group(); crawler.name = 'crawler';
  { const kc = new Kit(31); buildCrawler(kc); kc.build(crawler, M, {}); }
  const CRAWL = { park: 392, door: 436, pad: 60, speed: 3.2 };
  crawler.position.set(0, drop(0, CRAWL.park), CRAWL.park); group.add(crawler);
  const rocket = new THREE.Group(); rocket.name = 'showRocket'; rocket.visible = false;
  let rocketBuilt = false;
  const buildRocket = () => { if (rocketBuilt) return; rocketBuilt = true; const kr = new Kit(57); buildShowRocket(kr); kr.build(rocket, M, {}); };
  group.add(rocket);
  const show = { mode: 'none', riding: false };

  // ---- the pad fitted to the rocket on it (js/render/padfit.js): the mount (fixed), its clamps and the tower's arms (they move)
  const padFit = new THREE.Group(); padFit.name = 'padFit'; padFit.position.set(0, 0.085, 0); group.add(padFit);     // the deck the rocket rests on, as drawn under it
  const fit = { jaws: [], arms: [], arm: 0, armGoal: 0, jaw: 0, jawGoal: 0 };
  const poseFit = () => {
    const ka = fit.arm * fit.arm * (3 - 2 * fit.arm), slide = Math.min(1, fit.jaw * 3) * 0.3, tip = Math.max(0, (fit.jaw - 0.25) / 0.75) * 1.3;
    for (const g of fit.arms) g.rotation.y = ka * PAD_TOWER.swing;
    for (const g of fit.jaws) { const u = g.userData; g.position.set(u.x + Math.cos(u.a) * slide, u.y, u.z + Math.sin(u.a) * slide); g.rotation.set(0, Math.PI - u.a, tip); }
  };
  function fitPad(plan, { open = false } = {}) {
    for (const o of [...padFit.children]) { o.traverse(m => { if (m.geometry) m.geometry.dispose(); }); padFit.remove(o); }
    fit.jaws.length = 0; fit.arms.length = 0;
    plan = plan || { columns: [], arms: DEFAULT_ARMS };
    const piece = (name, draw) => { const g = new THREE.Group(); g.name = name; const kp = new Kit(71); draw(kp); kp.build(g, M, {}); padFit.add(g); return g; };
    piece('padMount', kp => drawMount(kp, plan));
    for (const c of plan.columns || []) for (const a of c.legs) { const g = piece('padClamp', kp => drawJaw(kp, c)); g.userData = { x: c.x + Math.cos(a) * c.Rp, y: c.hingeY, z: c.z + Math.sin(a) * c.Rp, a }; fit.jaws.push(g); }
    for (const arm of plan.arms || []) { const g = piece('padArm', kp => drawArm(kp, arm)); g.position.set(PAD_TOWER.hinge, arm.y, 0); fit.arms.push(g); }
    fit.arm = fit.armGoal = fit.jaw = fit.jawGoal = open ? 1 : 0;
    poseFit();
  }
  function setPadState({ arms, clamps } = {}) { if (arms !== undefined) fit.armGoal = arms ? 1 : 0; if (clamps !== undefined) fit.jawGoal = clamps ? 1 : 0; }
  // the show rocket (buildShowRocket) stands on a mount of its own; the arms go to its core, its upper stage and its fairing
  const SHOW_FIT = { columns: [], arms: [{ y: 14.6, tip: 2.27, hull: 2.23 }, { y: 29.2, tip: 1.74, hull: 1.7 }, { y: 39.2, tip: 2.14, hull: 2.1, crew: true }] };
  fitPad(null);

  let walkers = null;
  if (!low) {
    const pg = pipGeometry(); owned.push(pg);
    // paths: from each car park to the door of the nearest building (stopping at its wall), plus a few forecourts
    const paths = [], boxes = [];
    buildings.forEach(b => { const o = b.object3d.position; for (const pk of footprints[b.id] || []) boxes.push([o.x + pk[0] - pk[3] / 2 - 2, o.z + pk[2] - pk[5] / 2 - 2, o.x + pk[0] + pk[3] / 2 + 2, o.z + pk[2] + pk[5] / 2 + 2]); });
    const blocked = (x, z) => boxes.some(r => inRect(x, z, r));
    const walk = (ax, az, bx, bz) => { const L = Math.hypot(bx - ax, bz - az), n = Math.floor(L / 1.5); let j = 0; while (j < n && !blocked(ax + ((bx - ax) * (j + 1)) / n, az + ((bz - az) * (j + 1)) / n)) j++; if (j > 8) paths.push([ax, az, ax + ((bx - ax) * j) / n, az + ((bz - az) * j) / n]); };
    for (const [x, z, w, d, rows] of LOTS) {
      if (!rows) continue;
      let best = null, bd = 1e9; for (const b of buildings) { if (b.id === 'pad' || b.id === 'runway') continue; const o = b.object3d.position, dd = Math.hypot(o.x - x, o.z - z); if (dd < bd) { bd = dd; best = o; } }
      if (best) { const ux = (best.x - x) / bd, uz = (best.z - z) / bd, e = Math.min(w / 2 / Math.max(1e-3, Math.abs(ux)), d / 2 / Math.max(1e-3, Math.abs(uz))) + 2.5; walk(x + ux * e, z + uz * e, best.x, best.z); }
    }
    walk(-84, 460, -26, 460); walk(26, 460, 84, 460); walk(-110, 650, 130, 650); walk(159, 600, 159, 360); walk(-520, 650, -250, 650); walk(310, 650, 500, 650);
    const list = [];
    paths.forEach((pth, i) => { const L = Math.hypot(pth[2] - pth[0], pth[3] - pth[1]), n = L > 60 ? 3 : 2; for (let j = 0; j < n; j++) list.push({ p: pth, L, off: (j - (n - 1) / 2) * 1.3 + ((i * 7 + j * 3) % 5) * 0.15, phase: ((i * 0.37 + j * 0.53) % 1) * 2, speed: 1.5 + ((i + j * 2) % 4) * 0.22, s: 1.15 + ((i * 3 + j) % 5) * 0.07 }); });
    const wm = new THREE.InstancedMesh(pg, M.smooth, list.length); wm.name = 'pips'; wm.castShadow = true; wm.receiveShadow = true; wm.instanceMatrix.setUsage(THREE.DynamicDrawUsage); wm.frustumCulled = false;
    group.add(wm); walkers = { mesh: wm, list };
  }

  const padAnchor = new THREE.Object3D(); padAnchor.name = 'padAnchor'; padAnchor.position.set(0, 0, 0); group.add(padAnchor);
  const runwayAnchor = new THREE.Object3D(); runwayAnchor.name = 'runwayAnchor'; runwayAnchor.position.set(-850, drop(-850, L.runwayZ), L.runwayZ); runwayAnchor.userData.heading = 90; group.add(runwayAnchor);

  // three real lights for the night scene: the pad, and the two faces of the assembly building
  const nightLights = [];
  if (!low) for (const [x, y, z, power, color, dist] of [[0, 46, 26, 1500, 0xfff0d0, 420], [0, 34, 420, 5200, 0xffe2b8, 380], [0, 40, 640, 4200, 0xffe2b8, 360]]) {
    const l = new THREE.PointLight(color, 0, dist, 2); l.position.set(x, y + drop(x, z), z); l.userData.power = power; l.visible = false; nightLights.push(l); group.add(l);
  }
  let t = 0, night = 0;
  const lampBase = new THREE.Color(1, 1, 1);
  function update(dt, env = {}) {
    t += dt || 0;
    if (env.sunDir) night = 1 - THREE.MathUtils.smoothstep(env.sunDir.y, -0.1, 0.13);
    else if (typeof env.timeOfDay === 'number') night = 1 - THREE.MathUtils.smoothstep(Math.sin((env.timeOfDay - 0.25) * TAU), -0.1, 0.13);
    M.glass.emissiveIntensity = night * 1.9;
    M.lamp.color.copy(lampBase).multiplyScalar(0.5 + night * 2.6);
    M.pool.color.setScalar(night * 0.6); M.pool.visible = night > 0.02;
    for (const l of nightLights) { l.intensity = l.userData.power * night; l.visible = night > 0.02; }
    M.beam.opacity = night * 0.05; M.beam.visible = night > 0.02;
    M.glow.uniforms.uTime.value = t; M.glow.uniforms.uNight.value = night;
    M.flagTime.value = t;
    for (const m of movers) {
      if (m.spin) { m.spin.rotation.y = t * m.speed; continue; }
      m.az.rotation.y = m.phase + Math.sin(t * 0.021 * m.speed + m.phase) * 1.1 + t * 0.004;
      m.el.rotation.x = 0.55 + Math.sin(t * 0.033 * m.speed + m.phase * 2) * 0.32;
    }
    if (traffic) {
      traffic.routes.forEach((r, i) => {
        r.s += r.speed * (dt || 0) * r.dir;
        if (r.bounce) { if (r.s > r.total) { r.s = r.total; r.dir = -1; } else if (r.s < 0) { r.s = 0; r.dir = 1; } } else if (r.s > r.total) r.s -= r.total;
        let s = r.s, j = 0; while (j < r.len.length - 1 && s > r.len[j]) { s -= r.len[j]; j++; }
        const a = r.pts[j], b = r.pts[j + 1], f = r.len[j] ? s / r.len[j] : 0, x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
        dummy.position.set(x, drop(x, z) + 0.06, z); dummy.rotation.set(0, Math.atan2((b[0] - a[0]) * r.dir, (b[1] - a[1]) * r.dir), 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); traffic.mesh.setMatrixAt(i, dummy.matrix);
      });
      traffic.mesh.instanceMatrix.needsUpdate = true;
    }
    const d = dt || 0;
    for (const dr of Object.values(doors)) if (dr.cur !== dr.goal) { const step = d * 0.45; dr.cur = Math.abs(dr.goal - dr.cur) <= step ? dr.goal : dr.cur + Math.sign(dr.goal - dr.cur) * step; dr.apply(dr.cur * dr.cur * (3 - 2 * dr.cur)); }
    // the crawler: carries the show rocket to the pad, then goes home
    { const want = show.riding ? CRAWL.pad : CRAWL.park, z = crawler.position.z;
      if (z !== want) { const step = CRAWL.speed * d, nz = Math.abs(want - z) <= step ? want : z + Math.sign(want - z) * step; crawler.position.set(0, drop(0, nz), nz); }
      if (show.riding && crawler.position.z === CRAWL.pad && d > 0) { show.riding = false; setPadState({ arms: 0 }); }              // arrived: the rocket is handed to the pad, and the arms come in to it
      if (rocket.visible) { if (show.riding) rocket.position.set(0, crawler.position.y + 8.2, crawler.position.z); else rocket.position.set(0, 0.05, 0); } }
    // the pad's arms swing clear in a second and a half and come back slowly; the clamps let go in a third of a second
    if (fit.arm !== fit.armGoal || fit.jaw !== fit.jawGoal) {
      const sa = d / (fit.armGoal > fit.arm ? 1.5 : 5), sj = d / 0.35;
      fit.arm = Math.abs(fit.armGoal - fit.arm) <= sa ? fit.armGoal : fit.arm + Math.sign(fit.armGoal - fit.arm) * sa;
      fit.jaw = Math.abs(fit.jawGoal - fit.jaw) <= sj ? fit.jawGoal : fit.jaw + Math.sign(fit.jawGoal - fit.jaw) * sj;
      poseFit();
    }
    if (perf.on && flora) { const fs = flora.stats; perf.count('treesFull', fs.full); perf.count('treesReduced', fs.reduced); perf.count('treeImpostors', fs.impostors); perf.count('vegTriangles', fs.triangles + (grass ? grass.stats.triangles : 0)); }     // per frame, for ?perf=1
    if (flora) { flora.update(d, env); if (grass) grass.update(d, flora.cameraKnown ? flora.cameraLocal.y - drop(flora.cameraLocal.x, flora.cameraLocal.z) : undefined); }
    if (walkers) {
      const wl = walkers.list;
      for (let i = 0; i < wl.length; i++) {
        const w = wl[i], p = w.p, u = ((t * w.speed) / (w.L + 9) + w.phase) % 2, back = u > 1, tri = back ? 2 - u : u, f = Math.max(0, Math.min(1, (tri - 0.06) / 0.88)), moving = f > 0 && f < 1;
        const dx = (p[2] - p[0]) / w.L, dz = (p[3] - p[1]) / w.L, side = back ? -1 : 1, x = p[0] + dx * w.L * f - dz * w.off * side, z = p[1] + dz * w.L * f + dx * w.off * side, step = moving ? t * w.speed * 4.4 + i : 0;
        dummy.position.set(x, drop(x, z) + 0.07 + (moving ? Math.abs(Math.sin(step)) * 0.09 : 0), z);
        dummy.rotation.set(moving ? 0.07 : 0, Math.atan2(dx * side, dz * side) + (moving ? 0 : Math.sin(t * 0.4 + i) * 0.9), moving ? Math.sin(step) * 0.07 : 0, 'YXZ');
        dummy.scale.setScalar(w.s); dummy.updateMatrix(); walkers.mesh.setMatrixAt(i, dummy.matrix);
      }
      dummy.rotation.order = 'XYZ';
      walkers.mesh.instanceMatrix.needsUpdate = true;
    }
  }
  update(0, {});

  function setDoor(id, open) { const dr = doors[id]; if (dr) dr.goal = Math.max(0, Math.min(1, +open || 0)); }
  function setDisplay(mode) {
    if (mode !== 'rollout' && mode !== 'pad') mode = 'none';
    if (mode === show.mode) return;
    show.mode = mode;
    if (mode === 'none') { rocket.visible = false; show.riding = false; fitPad(null); return; }
    buildRocket(); rocket.visible = true;
    show.riding = mode === 'rollout';
    fitPad(SHOW_FIT, { open: show.riding });
    if (show.riding) crawler.position.set(0, drop(0, CRAWL.door), CRAWL.door);
    update(0, {});
  }

  function dispose() {
    group.traverse(o => { if (o.geometry && !owned.includes(o.geometry)) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
    for (const g of owned) g.dispose();
    if (flora) flora.dispose(); if (grass) { grass.dispose(); if (grass.maskTexture) grass.maskTexture.dispose(); }
    if (group.parent) group.parent.remove(group);
  }

  /** Vegetation detail: 'low' | 'medium' | 'high' | 'ultra' (js/render/flora.js VEG_LEVELS). Cheap: changes distances and counts only. */
  function setDetail(level) { if (level === vegNow) return; vegNow = level; if (flora) flora.setDetail(level); if (grass) grass.setDetail(level); }
  /** The same from the three things that decide it: the player's setting ('auto' or a level), the quality level's name and how many levels the automatic governor takes away. */
  function setVegetation(setting, qualityName = quality, drop = 0) { setDetail(vegLevel(setting, qualityName, drop)); }
  return { group, buildings, padAnchor, runwayAnchor, update, dispose, setDoor, setDisplay, fitPad, setPadState, setDetail, setVegetation, get display() { return show.mode; }, get night() { return night; },
    /** vegetation: { trees: { trees, full, reduced, impostors, triangles, level }, grass: { tufts, triangles } } for overlays and tests; prepare(renderer) bakes the impostors ahead of the first frame */
    get vegetation() { return { level: vegNow, trees: flora ? flora.stats : null, grass: grass ? grass.stats : null }; },
    prepare(renderer) { if (flora) flora.prepare(renderer); },
    /** { texture (red > 0 where the ground is paved or built on), rect: [x0, z0, width, depth] } or null */
    get pavedMask() { return paved; } };
}

/** The shared materials (after the first createBase): lets a host scene set envMap intensities, etc. */
export function baseMaterials() { return MAT || (MAT = buildMaterials()); }

// ---------------------------------------------------------------------------------------------
// The solid space centre: what a vessel can hit (js/core/sitesolids.js is written from this)
// ---------------------------------------------------------------------------------------------
/** Runs every builder of the fixed space centre (the buildings, the pad, the scenery, the parked crawler) through a kit
 *  that keeps no geometry, only the solid shapes it is asked for, in the pad's frame (+X east, +Y up, +Z south):
 *    ['box', cx, cy, cz, hx, hy, hz, m]   a box: centre, half sizes along its own axes, m = its 3 axes (9 numbers,
 *                                         columns x, y, z; omitted when it is square to the frame)
 *    ['cap', ax, ay, az, bx, by, bz, r]   a rod between two points (pipes, posts, beams)
 *    ['cyl', x, y0, z, r, h]              an upright drum
 *    ['sph', x, y, z, r, sy]              a ball, squashed sy upright (domes are taken as whole balls: their lower half is
 *                                         inside what they sit on)
 *  A lattice mast is one box (its bracing is too close-knit to fly through) cut into four lengths as it tapers. What
 *  lies flat (paving, markings, decals), window panes, lamps, light pools, fences and lamp heads are not solid; nor is
 *  anything whose top is less than 12 cm off the ground (the ground has that). js/core/structures.js does the rest. */
export function recordSiteSolids() {
  const out = [], SKIP = { lamp: 1, pool: 1, beam: 1, ao: 1, mark: 1, decal: 1, fence: 1 }, r2 = v => Math.round(v * 100) / 100 || 0;
  const m4 = new THREE.Matrix4(), v = V3(0, 0, 0), ax = V3(0, 0, 0), ay = V3(0, 0, 0), az = V3(0, 0, 0);
  class Rec extends Kit {
    constructor(seed, ox = 0, oz = 0) { super(seed); this.ox = ox; this.oz = oz; this.inLattice = false; }
    push() { return this; }
    keep(s) { if (s[0] === 'box' && s[2] + s[5] < 0.12) return; if (s[0] === 'cap' && Math.max(s[2], s[5]) + s[7] < 0.12) return; if (s[0] === 'cyl' && s[2] + s[5] < 0.12) return; out.push(s.map(x => (typeof x === 'number' ? r2(x) : Array.isArray(x) ? x.map(y => Math.round(y * 1e4) / 1e4 || 0) : x))); }
    box(bucket, x, y0, z, w, h, d, color, ry = 0) {
      if (SKIP[bucket] || this.inLattice) return this;
      const s = ['box', x + this.ox, y0 + h / 2, z + this.oz, w / 2, h / 2, d / 2];
      if (ry) { const c = Math.cos(ry), sn = Math.sin(ry); s.push([c, 0, -sn, 0, 1, 0, sn, 0, c]); }
      this.keep(s); return this;
    }
    boxM(bucket, w, h, d, color, m) {
      if (SKIP[bucket]) return this;
      v.set(0, h / 2, 0).applyMatrix4(m); m.extractBasis(ax, ay, az);
      const sx = ax.length(), sy = ay.length(), sz = az.length(); ax.normalize(); ay.normalize(); az.normalize();
      this.keep(['box', v.x + this.ox, v.y, v.z + this.oz, w * sx / 2, h * sy / 2, d * sz / 2, [ax.x, ax.y, ax.z, ay.x, ay.y, ay.z, az.x, az.y, az.z]]); return this;
    }
    cyl(bucket, x, y0, z, r1, r2_, h) { if (bucket === 'glass') this.win(); if (!SKIP[bucket]) this.keep(['cyl', x + this.ox, y0, z + this.oz, Math.max(r1, r2_), h]); return this; }
    tube(bucket, a, b, r, color, seg, rb = r) { if (!SKIP[bucket]) this.keep(['cap', a[0] + this.ox, a[1], a[2] + this.oz, b[0] + this.ox, b[1], b[2] + this.oz, Math.max(r, rb)]); return this; }
    beam(bucket, a, b, th) { if (!SKIP[bucket] && !this.inLattice) this.keep(['cap', a[0] + this.ox, a[1], a[2] + this.oz, b[0] + this.ox, b[1], b[2] + this.oz, th * 0.6]); return this; }
    sphere(bucket, x, y, z, r, color, sy = 1) { if (!SKIP[bucket]) this.keep(['sph', x + this.ox, y, z + this.oz, r, sy]); return this; }
    dome(bucket, x, y0, z, r, color, sy = 1) { if (!SKIP[bucket]) this.keep(['sph', x + this.ox, y0, z + this.oz, r, sy]); return this; }
    lattice(cx, cz, w0, w1, y0, y1, n, colA, colB, th = 0.3) {
      for (let i = 0; i < 4; i++) {
        const ya = y0 + (y1 - y0) * i / 4, yb = y0 + (y1 - y0) * (i + 1) / 4, w = Math.max(w0 + (w1 - w0) * i / 4, w0 + (w1 - w0) * (i + 1) / 4) + th * 1.25;
        this.keep(['box', cx + this.ox, (ya + yb) / 2, cz + this.oz, w / 2, (yb - ya) / 2, w / 2]);
      }
      return this;
    }
    solid(...s) { s[1] += this.ox; s[3] += this.oz; this.keep(s); return this; }
    win() { (this.b.glass ||= []).push({}); return this; }            // (one builder turns its last window after)
    flat() { return this; } poly() { return this; } disc() { return this; } bands() { return this; }
    decalWall() { return this; } decalFlat() { return this; } glow() { return this; } pool() { return this; }
  }
  const keepMat = MAT; MAT = MAT || new Proxy({}, { get: () => undefined });       // moving parts (the dishes) build meshes of their own
  const L = BASE_LAYOUT, builders = { hangar: buildHangar, pad: buildPad, runway: buildRunway, spaceplane: buildSpaceplaneHangar, tracking: buildTracking, research: buildResearch, missions: buildMissions, crew: buildCrew, school: buildSchool, admin: buildAdmin };
  const groups = {};
  BASE_BUILDINGS.forEach((def, i) => { const n0 = out.length; builders[def.id](new Rec(100 + i * 17, L[def.id][0], L[def.id][1]), []); groups[def.id] = [n0, out.length]; });
  { const n0 = out.length; buildScenery(new Rec(7), 'high'); groups.scenery = [n0, out.length]; }
  // the crawler, parked on its way (as createBase parks it when no show rocket rides it)
  { const n0 = out.length; const k = new Rec(31, 0, 392); buildCrawler(k); groups.crawler = [n0, out.length]; }
  return { solids: out, groups };
}
