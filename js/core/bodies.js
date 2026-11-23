// The Helion system: celestial bodies, their orbits, rotation, atmospheres and procedural surfaces.
// Pure simulation (no DOM). Frame: right-handed, Y-up; bodies spin counter-clockwise seen from +Y.
//
// Every solid body has a height field: Body.terrainHeight(dir, lod) in metres above body.radius. The same
// function drives the physics (what wheels and legs touch) and the terrain renderer (what you see).
import { Vector3 } from '../lib/three.module.min.js';
import { Orbit } from './orbit.js';
import { makeNoise, makeRandom } from './noise.js';

const TAU = Math.PI * 2;
const HOME_RHO0 = 1.22;

// ---------------------------------------------------------------------------------------------
// Surface helpers (all allocation-free: they are called millions of times to bake textures)
// ---------------------------------------------------------------------------------------------

function sstep(a, b, x) {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

function setMix(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

function setRgb(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; }

function shade(out, k) {
  out[0] = Math.min(1, Math.max(0, out[0] * k));
  out[1] = Math.min(1, Math.max(0, out[1] * k));
  out[2] = Math.min(1, Math.max(0, out[2] * k));
}

/** Seeded crater list packed as [x, y, z, angularRadius] × count. */
function makeCraters(seed, count, minR, maxR) {
  const rnd = makeRandom(seed);
  const c = new Float64Array(count * 4);
  for (let i = 0; i < count; i++) {
    const y = 2 * rnd() - 1, a = TAU * rnd(), s = Math.sqrt(1 - y * y);
    c[i * 4] = s * Math.cos(a); c[i * 4 + 1] = y; c[i * 4 + 2] = s * Math.sin(a);
    const u = rnd();
    c[i * 4 + 3] = minR + (maxR - minR) * u * u;   // many small, few large
  }
  return c;
}

/** Crater profile at a direction: −1 on a crater floor, up to +1 on a rim, 0 on open ground. */
function craterValue(c, x, y, z) {
  let best = 0;
  for (let i = 0; i < c.length; i += 4) {
    const d = c[i] * x + c[i + 1] * y + c[i + 2] * z;
    const R = c[i + 3];
    const lim = 1 - 0.845 * R * R;           // cos(1.3·R) ≈ 1 − (1.3R)²/2
    if (d < lim) continue;
    const u = Math.sqrt(2 * (1 - d)) / R;    // angular distance / radius
    let v;
    if (u < 0.75) v = -1;
    else if (u < 1) v = -1 + 2 * (u - 0.75) / 0.25;
    else v = 1 - (u - 1) / 0.3;
    if (v < 0) v = Math.min(best, v);
    else if (best < 0) v = best;
    else v = Math.max(best, v);
    best = v;
  }
  return best;
}

/**
 * Height in metres from the big listed craters: flat floor, central peak, raised rim, ejecta blanket.
 * `k` scales depth (old, filled-in craters use a small k).
 */
function craterHeight(c, x, y, z, R, k) {
  let sum = 0;
  for (let i = 0; i < c.length; i += 4) {
    const d = c[i] * x + c[i + 1] * y + c[i + 2] * z;
    const A = c[i + 3];
    if (d < 1 - 1.62 * A * A) continue;       // beyond 1.8 radii
    const u = Math.sqrt(2 * (1 - d > 0 ? 1 - d : 0)) / A;
    let p;
    if (u < 1) {
      const t = sstep(0.5, 1, u);
      p = -0.085 + 0.125 * t * t;             // floor −0.085 → rim crest +0.04
      if (u < 0.16) p += 0.035 * (1 - sstep(0, 0.16, u));   // central peak
    } else {
      const t = 1 - (u - 1) / 0.8;
      p = t > 0 ? 0.04 * t * t : 0;
    }
    sum += p * A;
  }
  return sum * R * k;
}

/** Bright ray systems around the first `count` craters of a list: 0..1. */
function craterRays(c, count, n, x, y, z) {
  let best = 0;
  for (let i = 0; i < count * 4 && i < c.length; i += 4) {
    const cx = c[i], cy = c[i + 1], cz = c[i + 2];
    const d = cx * x + cy * y + cz * z;
    const A = c[i + 3] * 0.45;
    if (d < 1 - 32 * A * A) continue;         // within 8 radii
    const u = Math.sqrt(2 * (1 - d > 0 ? 1 - d : 0)) / A;
    if (u < 0.9) continue;
    // direction from the crater centre, as a point on a small circle: noise over it gives the rays
    const k = 1 / (Math.sqrt(1 - d * d) + 1e-9);
    const rx = (x - cx * d) * k, ry = (y - cy * d) * k, rz = (z - cz * d) * k;
    const ray = n.noise3(rx * 7 + i, ry * 7, rz * 7) + 0.5 * n.noise3(rx * 19, ry * 19 + i, rz * 19);
    const v = sstep(0.25, 0.7, ray) * (1 - sstep(1, 8, u)) + (1 - sstep(0.9, 1.9, u)) * 0.7;
    if (v > best) best = v;
  }
  return best > 1 ? 1 : best;
}

function hash3(ix, iy, iz, seed) {
  let h = Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^ Math.imul(iz, 0xcb1ab31f) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return (h ^ (h >>> 12)) >>> 0;
}

/**
 * One octave of small procedural craters: two candidates per lattice cell of size R/cells metres, bowls with
 * raised rims. Returns metres (scaled by the crater radius). Skipped when smaller than `lod`.
 */
function cellCraters(x, y, z, cells, seed, R, lod, dens) {
  const L = R / cells;
  if (L < lod * 2.5) return 0;
  const px = x * cells, py = y * cells, pz = z * cells;
  const fx = Math.floor(px - 0.5), fy = Math.floor(py - 0.5), fz = Math.floor(pz - 0.5);
  const thr = dens * 256;
  let sum = 0;
  for (let n = 0; n < 8; n++) {
    const ix = fx + (n & 1), iy = fy + ((n >> 1) & 1), iz = fz + (n >> 2);
    let h = hash3(ix, iy, iz, seed);
    for (let k = 0; k < 2; k++) {
      if ((h & 255) < thr) {
        const cx = ix + 0.2 + 0.6 * ((h >>> 8) & 255) / 255;
        const cy = iy + 0.2 + 0.6 * ((h >>> 16) & 255) / 255;
        const cz = iz + 0.2 + 0.6 * (h >>> 24) / 255;
        const h2 = Math.imul(h, 0x9e3779b1) >>> 0;
        const q = (h2 & 1023) / 1023;
        const r = 0.09 + 0.3 * q * q;
        const dx = px - cx, dy = py - cy, dz = pz - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        const lim = 1.7 * r;
        if (d2 < lim * lim) {
          // only craters whose centre lies near the surface count (others would read as mounds)
          const off = Math.abs(Math.sqrt(cx * cx + cy * cy + cz * cz) - cells) / r;
          if (off < 0.9) {
            const u = Math.sqrt(d2) / r;
            let p;
            if (u < 1) p = -0.3 + 0.38 * u * u;
            else { const t = 1 - (u - 1) / 0.7; p = 0.08 * t * t; }
            const age = 0.35 + 0.65 * ((h2 >>> 10) & 255) / 255;
            sum += p * r * age * (off < 0.3 ? 1 : 1 - sstep(0.3, 0.9, off));
          }
        }
      }
      h = (Math.imul(h ^ (h >>> 15), 0x85ebca6b) ^ 0x632be5ab) >>> 0;
    }
  }
  return sum * L;
}

/** Unnormalised fbm (about ±2) starting at frequency f; octaves finer than `lod` metres are skipped. */
function fbmL(n, x, y, z, f, oct, R, lod) {
  let sum = 0, amp = 1;
  for (let i = 0; i < oct; i++) {
    if (R < lod * f) break;
    sum += amp * n.noise3(x * f + i * 17.13, y * f + i * 5.71, z * f + i * 9.37);
    amp *= 0.5; f *= 2.03;
  }
  return sum;
}

/** Ridged multifractal, 0..~1: sharp crests, smooth valleys. */
function ridged(n, x, y, z, f, oct, R, lod) {
  let sum = 0, amp = 0.5, w = 1;
  for (let i = 0; i < oct; i++) {
    if (R < lod * f) break;
    let v = 1 - Math.abs(n.noise3(x * f + i * 7.31, y * f + i * 3.17, z * f + i * 11.9));
    v *= v * w;
    w = v > 1 ? 1 : v;
    sum += v * amp;
    amp *= 0.5; f *= 2.07;
  }
  return sum;
}

/** Small-scale relief shared by the rocky bodies: procedural crater octaves plus fine fbm. */
function rough(c, T, x, y, z, lod) {
  const R = c.R;
  let H = 0;
  const cells = T.cells;
  if (cells) {
    for (let i = 0; i < cells.length; i++) H += cellCraters(x, y, z, cells[i], c.seed + i * 131, R, lod, T.cdens);
    H *= T.cdepth;
  }
  if (T.det) H += T.det[1] * fbmL(c.noise, x + 1.3, y + 2.1, z + 0.7, T.det[0], 14, R, lod);
  return H;
}

const B = (id, name, water = false) => Object.freeze({ id, name, water });

// Verda's sea surface sits 3 m below the datum (the pad altitude), so the base is a low coastal plain.
const VERDA_SEA = -3;

/** Verda's shared macro fields: continental value c.h (< 0 is sea), moisture c.m, base-site weight c.ws, coast offset c.cst. */
function verdaMacro(c, x, y, z) {
  const n = c.noise;
  // launch site is at body-fixed +X: blend towards guaranteed gentle green lowland around it
  const w = sstep(0.975, 0.9992, x);
  let h = n.fbm(x * 1.7 + 3.1, y * 1.7, z * 1.7, 5) - 0.035;
  let m = n.fbm(x * 2.3 + 11.5, y * 2.3 + 5.2, z * 2.3, 3);
  if (w > 0) { h += (0.1 - h) * w; m += (0.25 - m) * w; }
  c.ws = 0; c.cst = -1e9;
  if (x > 0.96) {
    // local metres at the base: east = −Z, north = +Y. The sea lies east of a wavy north–south coast.
    const R = c.R, e = -z * R, nn = y * R, d = Math.sqrt(e * e + nn * nn);
    const an = Math.abs(nn);
    const cst = e - (3300 + 160 * Math.sin(nn / 800) + 70 * Math.sin(nn / 277 + 1.3)
      + sstep(3500, 15000, an) * (6000 * Math.sin(nn / 21000 + 0.6) + 1800 * Math.sin(nn / 7300)));
    const bay = sstep(1500, 6000, cst) * (1 - sstep(60e3, 160e3, d));
    h += (-0.12 - h) * bay;
    // site weight: 1 within 3 km of the pad; the sea side of the shore keeps the explicit beach profile further out
    const wl = 1 - sstep(3000, 9000, d), wsea = 1 - sstep(8000, 30000, d);
    c.ws = wl + (wsea - wl) * sstep(-400, 0, cst);
    c.cst = cst;
  }
  c.h = h; c.m = m;
}

/** Verda's height from the macro fields already in c. */
function verdaH(c, x, y, z, lod) {
  const n = c.noise, R = c.R, h = c.h;
  let H;
  if (h < 0) {
    H = VERDA_SEA - 1 - 5200 * Math.pow(-h, 1.15) + 30 * sstep(0, -0.03, h) * fbmL(n, x, y, z, 45, 4, R, lod);
  } else {
    const coast = 1 - Math.exp(-h / 0.004);
    let base = 0.6 + 55 * coast + 3600 * Math.pow(h, 1.4);
    const mt = sstep(0.13, 0.3, h);
    if (mt > 0) base += mt * 2800 * ridged(n, x, y, z, 11, 9, R, lod);
    base *= 1 + 0.3 * fbmL(n, x + 5, y, z, 30, 5, R, lod);
    const dA = Math.min(0.35 * base, 6 + 0.02 * base);
    H = VERDA_SEA + base + 0.5 * dA * fbmL(n, x, y + 3, z, 520, 12, R, lod);
  }
  const lat = y < 0 ? -y : y;
  if (lat > 0.8) {
    // polar ice shelves: the frost caps float a few metres above the sea
    const cap = lat + 0.07 * n.noise3(x * 6, y * 6, z * 6) + 0.06 * (h > 0 ? h : 0);
    if (cap > 0.915 && H < VERDA_SEA + 4) H += (VERDA_SEA + 4 - H) * sstep(0.915, 0.921, cap);
  }
  if (c.ws > 0) {
    const cst = c.cst;
    let Hs = 0;
    if (cst > 0) Hs = VERDA_SEA * Math.min(1, cst / 60) - 30 * sstep(60, 700, cst) - 70 * sstep(500, 4000, cst);
    H += (Hs - H) * c.ws;
  }
  return H;
}

// Each surface: biomes[], sample(ctx, x, y, z, rgb) → biome index (writing the colour into rgb), and
// height(ctx, x, y, z, lod) → metres above the body radius. Colour and height share their macro noise.
const SURFACES = {
  helion: {
    biomes: [B('photosphere', 'Photosphere'), B('darkspots', 'Dim Shoals'), B('flarefields', 'Flare Fields')],
    sample(c, x, y, z, rgb) {
      const g = c.noise.fbm(x * 9, y * 9, z * 9, 3);
      const s = c.noise.noise3(x * 2.5 + 7, y * 2.5, z * 2.5);
      let biome = 0;
      rgb[0] = 1.0; rgb[1] = 0.84 + 0.12 * g; rgb[2] = 0.42 + 0.25 * g;
      if (s < -0.42) { biome = 1; rgb[1] -= 0.22; rgb[2] -= 0.25; shade(rgb, 0.85); }
      else if (s > 0.45) { biome = 2; rgb[1] += 0.1; rgb[2] += 0.3; shade(rgb, 1); }
      return biome;
    },
  },

  // Tidally locked lava world: body-fixed +X always faces Helion.
  sear: {
    biomes: [B('moltensea', 'Molten Sea'), B('glassplains', 'Glass Plains'), B('twilightrim', 'Twilight Rim'), B('nightslag', 'Nightside Slag')],
    init(c) { c.craters = makeCraters(c.seed + 2, 18, 0.05, 0.2); },
    T: { cells: [9, 34, 130, 500, 2000, 8000, 30000], cdens: 0.55, cdepth: 0.7, det: [40, 110] },
    lava: [1.0, 0.52, 0.10], hot: [1.0, 0.86, 0.38], crust: [0.20, 0.07, 0.04], glass: [0.26, 0.20, 0.19],
    rim: [0.40, 0.31, 0.27], slag: [0.15, 0.14, 0.17], frost: [0.36, 0.38, 0.45],
    sea(c, x, y, z) { return x + 0.16 * c.noise.fbm(x * 2.6, y * 2.6 + 4, z * 2.6, 3); },
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      const s = this.sea(c, x, y, z);
      let biome;
      if (s > 0.52) {
        biome = 0;
        const pl = n.noise3(x * 13, y * 13, z * 13) + 0.5 * n.noise3(x * 31, y * 31, z * 31);
        setMix(rgb, this.crust, this.lava, sstep(-0.25, 0.25, pl + 1.4 * (s - 0.75)));
        setMix(rgb, rgb, this.hot, sstep(0.5, 1.0, pl + 1.4 * (s - 0.75)));
      } else if (s > 0.12) {
        biome = 1;
        setMix(rgb, this.glass, this.crust, sstep(0.4, 0.52, s));
        const crack = 1 - Math.abs(n.noise3(x * 9 + 2, y * 9, z * 9));
        if (crack > 0.95) setMix(rgb, rgb, this.lava, sstep(0.95, 0.99, crack) * sstep(0.12, 0.45, s));
      } else if (s > -0.14) {
        biome = 2;
        setMix(rgb, this.slag, this.rim, 0.5 + 0.5 * n.fbm(x * 5, y * 5, z * 5, 3));
      } else {
        biome = 3;
        setMix(rgb, this.slag, this.frost, sstep(-0.5, -0.95, s) * (0.5 + 0.5 * n.noise3(x * 6, y * 6, z * 6)));
        const cr = craterValue(c.craters, x, y, z);
        if (cr < 0) shade(rgb, 1 + 0.2 * cr); else if (cr > 0) shade(rgb, 1 + 0.3 * cr);
      }
      shade(rgb, 0.92 + 0.16 * n.noise3(x * 22, y * 22, z * 22));
      return biome;
    },
    height(c, x, y, z, lod) {
      const n = c.noise, R = c.R;
      const s = this.sea(c, x, y, z);
      const land = 1 - sstep(0.44, 0.54, s);          // 0 on the lava sea
      const twi = 1 - sstep(0.0, 0.3, Math.abs(s));   // cracked mountains along the terminator
      let H = 1500 * n.fbm(x * 2.2, y * 2.2, z * 2.2 + 6, 4) + twi * 3200 * ridged(n, x, y, z, 6, 9, R, lod);
      H += sstep(-0.1, -0.3, s) * craterHeight(c.craters, x, y, z, R, 1) + rough(c, this.T, x, y, z, lod);
      const plates = 6 * sstep(-0.2, 0.2, n.noise3(x * 13, y * 13, z * 13) + 0.5 * n.noise3(x * 31, y * 31, z * 31));
      return -900 + plates + (H + 1300) * land;
    },
  },

  cindra: {
    biomes: [B('char', 'Char Plains'), B('ridges', 'Cinder Ridges'), B('slag', 'Slag Basins'), B('scars', 'Ember Scars')],
    init(c) { c.craters = makeCraters(c.seed + 5, 26, 0.05, 0.22); },
    T: { cells: [10, 38, 150, 600, 2400, 9600, 38000], cdens: 0.7, cdepth: 0.8, det: [36, 150] },
    dark: [0.17, 0.12, 0.10], mid: [0.33, 0.22, 0.15], ridge: [0.46, 0.33, 0.24], glow: [0.85, 0.32, 0.08],
    sample(c, x, y, z, rgb) {
      const h = c.noise.fbm(x * 2.4, y * 2.4, z * 2.4, 4);
      const cr = craterValue(c.craters, x, y, z);
      const scar = 1 - Math.abs(c.noise.noise3(x * 3.3 + 4, y * 3.3, z * 3.3));   // thin ridged lines
      let biome = 0;
      setMix(rgb, this.dark, this.mid, sstep(-0.3, 0.3, h));
      if (cr < -0.3) { biome = 2; shade(rgb, 0.7); }
      else if (scar > 0.965 && h < 0.1) { biome = 3; setMix(rgb, rgb, this.glow, sstep(0.965, 0.995, scar)); }
      else if (h > 0.18) { biome = 1; setMix(rgb, rgb, this.ridge, sstep(0.18, 0.4, h)); }
      if (cr > 0) shade(rgb, 1 + 0.35 * cr);
      shade(rgb, 0.92 + 0.16 * c.noise.noise3(x * 21, y * 21, z * 21));
      return biome;
    },
    height(c, x, y, z, lod) {
      const n = c.noise, R = c.R;
      const h = n.fbm(x * 2.4, y * 2.4, z * 2.4, 4);
      const scar = 1 - Math.abs(n.noise3(x * 3.3 + 4, y * 3.3, z * 3.3));
      let H = 2600 * h + sstep(0.12, 0.4, h) * 2600 * ridged(n, x, y, z, 8, 9, R, lod);
      if (h < 0.1) H -= 700 * sstep(0.94, 0.995, scar);
      return H + craterHeight(c.craters, x, y, z, R, 1) + rough(c, this.T, x, y, z, lod);
    },
  },

  // Crushing ochre atmosphere over basalt: shield volcanoes, wrinkled highlands, lava channels.
  murk: {
    biomes: [B('pressureflats', 'Pressure Flats'), B('tessera', 'Tessera Highlands'), B('shields', 'Shield Volcanoes'), B('channels', 'Lava Channels'), B('polarvortex', 'Vortex Lowlands')],
    init(c) { c.craters = makeCraters(c.seed + 4, 14, 0.07, 0.2); },   // used as volcano sites
    T: { det: [70, 95] },
    flat: [0.44, 0.33, 0.22], dark: [0.26, 0.20, 0.16], tess: [0.60, 0.47, 0.30], shield: [0.36, 0.22, 0.15],
    chan: [0.78, 0.36, 0.12], pole: [0.50, 0.42, 0.34],
    volcano(c, x, y, z) {   // 0..1 cone profile of the nearest volcano
      const v = c.craters;
      let best = 0;
      for (let i = 0; i < v.length; i += 4) {
        const d = v[i] * x + v[i + 1] * y + v[i + 2] * z, A = v[i + 3];
        if (d < 1 - 0.5 * A * A) continue;
        const p = 1 - Math.sqrt(2 * (1 - d > 0 ? 1 - d : 0)) / A;
        if (p > best) best = p;
      }
      return best;
    },
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      const h = n.fbm(x * 1.8 + 9, y * 1.8, z * 1.8, 4);
      const vol = this.volcano(c, x, y, z);
      const ch = 1 - Math.abs(n.noise3(x * 4.1, y * 4.1 + 6, z * 4.1));
      let biome;
      if (vol > 0.08) { biome = 2; setMix(rgb, this.flat, this.shield, sstep(0.08, 0.5, vol)); if (vol > 0.9) setMix(rgb, rgb, this.chan, 0.6); }
      else if (Math.abs(y) > 0.88) { biome = 4; setMix(rgb, this.pole, this.dark, 0.5 + 0.5 * n.noise3(x * 7, y * 7, z * 7)); }
      else if (h > 0.13) { biome = 1; setMix(rgb, this.flat, this.tess, sstep(0.13, 0.3, h)); shade(rgb, 0.85 + 0.3 * Math.abs(n.noise3(x * 40, y * 40, z * 40))); }
      else if (ch > 0.962 && h < 0.05) { biome = 3; setMix(rgb, this.dark, this.chan, sstep(0.962, 0.99, ch)); }
      else { biome = 0; setMix(rgb, this.dark, this.flat, sstep(-0.35, 0.13, h)); }
      shade(rgb, 0.92 + 0.16 * n.noise3(x * 19, y * 19, z * 19));
      return biome;
    },
    height(c, x, y, z, lod) {
      const n = c.noise, R = c.R;
      const h = n.fbm(x * 1.8 + 9, y * 1.8, z * 1.8, 4);
      const vol = this.volcano(c, x, y, z);
      const ch = 1 - Math.abs(n.noise3(x * 4.1, y * 4.1 + 6, z * 4.1));
      let H = 1800 * h + sstep(0.1, 0.3, h) * (1500 + 1900 * ridged(n, x, y, z, 14, 9, R, lod));
      if (h < 0.05) H -= 260 * sstep(0.95, 0.99, ch);
      if (vol > 0) H += 7500 * vol * vol * (3 - 2 * vol) - 1600 * sstep(0.9, 0.97, vol);
      return H + rough(c, this.T, x, y, z, lod);
    },
  },

  verda: {
    biomes: [
      B('deepwater', 'Deepwater', true), B('shoals', 'Sunlit Shoals', true), B('greenbelt', 'Greenbelt'),
      B('tanlands', 'Tanlands'), B('highcrags', 'Highcrags'), B('frostcaps', 'Frostcaps'),
    ],
    deep: [0.03, 0.11, 0.32], sea: [0.06, 0.27, 0.52], shoal: [0.13, 0.45, 0.62],
    grass: [0.42, 0.51, 0.27], forest: [0.24, 0.37, 0.20], tan: [0.76, 0.67, 0.43],
    rock: [0.47, 0.43, 0.38], snow: [0.94, 0.96, 0.98],
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      verdaMacro(c, x, y, z);
      const h = c.h, m = c.m;
      if (c.ws > 0 && !this._nest) {
        // near the base the explicit coast profile decides what is water; its colours fade into the planet's own
        // over the outer part of the site, so there is no line on the ground where the site ends
        const ws = c.ws, H = verdaH(c, x, y, z, 15);
        let sb = -1;
        if (H < VERDA_SEA) {
          const depth = VERDA_SEA - H;
          setMix(rgb, this.shoal, this.sea, sstep(2, 45, depth));
          if (depth > 45) setMix(rgb, rgb, this.deep, sstep(45, 400, depth));
          sb = depth < 45 ? 1 : 0;
        } else if (h > 0) {
          setMix(rgb, this.grass, this.forest, sstep(0.2, 0.6, m));
          if (c.cst > -140) setMix(rgb, rgb, this.tan, sstep(-140, -25, c.cst));   // beach
          shade(rgb, 0.93 + 0.14 * n.noise3(x * 19, y * 19, z * 19));
          sb = 2;
        }
        if (sb >= 0) {
          if (ws >= 0.35) return sb;
          const sr = rgb[0], sg = rgb[1], sbl = rgb[2];
          this._nest = true;
          this.sample(c, x, y, z, rgb);
          this._nest = false;
          const k = sstep(0, 0.35, ws);
          rgb[0] += (sr - rgb[0]) * k; rgb[1] += (sg - rgb[1]) * k; rgb[2] += (sbl - rgb[2]) * k;
          return sb;
        }
      }
      const lat = Math.abs(y);
      if (lat + 0.07 * n.noise3(x * 6, y * 6, z * 6) + 0.06 * (h > 0 ? h : 0) > 0.92) {
        rgb[0] = this.snow[0]; rgb[1] = this.snow[1]; rgb[2] = this.snow[2];
        shade(rgb, 0.96 + 0.04 * m);
        return 5;
      }
      if (h < -0.045) {
        setMix(rgb, this.sea, this.deep, sstep(-0.045, -0.3, h));
        return 0;
      }
      if (h < 0) {
        setMix(rgb, this.shoal, this.sea, sstep(0, -0.045, h));
        return 1;
      }
      let biome;
      const dry = m - 0.25 * (1 - lat) * (1 - lat) + 0.12;   // drier near the equator belt
      if (h > 0.23) {
        biome = 4;
        setMix(rgb, this.rock, this.snow, sstep(0.36, 0.46, h));
      } else if (dry < -0.1) {
        biome = 3;
        setMix(rgb, this.tan, this.grass, sstep(-0.16, -0.1, dry));
      } else {
        biome = 2;
        setMix(rgb, this.grass, this.forest, sstep(0.0, 0.3, m));
        if (h < 0.012) setMix(rgb, this.tan, rgb, h / 0.012);   // beaches
      }
      if (biome !== 4 && h > 0.17) setMix(rgb, rgb, this.rock, sstep(0.17, 0.23, h));
      // woods, clearings and dry patches at smaller scales, so the land is not one flat tint from orbit
      const p1 = n.noise3(x * 47 + 3, y * 47, z * 47), p2 = n.noise3(x * 131, y * 131 + 5, z * 131);
      if (biome === 2) setMix(rgb, rgb, this.forest, 0.55 * sstep(0.5, 0.75, 0.6 * p1 + 0.4 * p2));
      else if (biome === 3) setMix(rgb, rgb, this.rock, 0.3 * sstep(0.55, 0.8, p1));
      shade(rgb, 0.84 + 0.14 * n.noise3(x * 19, y * 19, z * 19) + 0.1 * p1 + 0.08 * p2);
      return biome;
    },
    height(c, x, y, z, lod) {
      verdaMacro(c, x, y, z);
      return verdaH(c, x, y, z, lod);
    },
  },

  pell: {
    biomes: [B('ashseas', 'Ashen Seas'), B('uplands', 'Pale Uplands'), B('pockmarks', 'Pockmark Fields'), B('hollows', 'Polar Hollows')],
    init(c) { c.craters = makeCraters(c.seed + 9, 40, 0.035, 0.2); },
    T: { cells: [9, 34, 130, 500, 2000, 8000, 32000], cdens: 0.85, cdepth: 0.85, det: [32, 120] },
    mare: [0.30, 0.30, 0.33], up: [0.62, 0.61, 0.59], polar: [0.52, 0.53, 0.57],
    sample(c, x, y, z, rgb) {
      const h = c.noise.fbm(x * 1.9 + 2, y * 1.9, z * 1.9, 4);
      const cr = craterValue(c.craters, x, y, z);
      let biome;
      const t = sstep(-0.1, 0.02, h);
      setMix(rgb, this.mare, this.up, t);
      if (Math.abs(y) > 0.9) { biome = 3; setMix(rgb, rgb, this.polar, 0.6); }
      else if (cr < -0.3) biome = 2;
      else biome = t < 0.5 ? 0 : 1;
      if (cr < 0) shade(rgb, 1 + 0.22 * cr);
      else if (cr > 0) shade(rgb, 1 + 0.25 * cr);
      const ray = craterRays(c.craters, 5, c.noise, x, y, z);
      if (ray > 0) shade(rgb, 1 + 0.2 * ray);
      shade(rgb, 0.92 + 0.16 * c.noise.noise3(x * 23, y * 23, z * 23));
      return biome;
    },
    height(c, x, y, z, lod) {
      const n = c.noise, R = c.R;
      const h = n.fbm(x * 1.9 + 2, y * 1.9, z * 1.9, 4);
      const t = sstep(-0.1, 0.02, h);                 // 0 on the maria (smooth, low), 1 on the uplands
      let H = -1100 + t * (1100 + 2600 * h + 900 * ridged(n, x, y, z, 7, 8, R, lod));
      H += craterHeight(c.craters, x, y, z, R, 1);
      return H + rough(c, this.T, x, y, z, lod) * (0.45 + 0.55 * t);
    },
  },

  ost: {
    biomes: [B('glassflats', 'Glass Flats'), B('bluerifts', 'Blue Rifts'), B('frostpits', 'Frost Pits'), B('hoarcrowns', 'Hoar Crowns')],
    init(c) { c.craters = makeCraters(c.seed + 3, 16, 0.06, 0.25); },
    T: { cells: [7, 26, 100, 400, 1600, 6400], cdens: 0.35, cdepth: 0.6, det: [24, 60] },
    ice: [0.78, 0.88, 0.95], pale: [0.90, 0.95, 0.98], rift: [0.33, 0.55, 0.80], crown: [0.97, 0.98, 1.0],
    sample(c, x, y, z, rgb) {
      const h = c.noise.fbm(x * 2.1, y * 2.1 + 8, z * 2.1, 3);
      const rift = 1 - Math.abs(c.noise.noise3(x * 2.6 + 1.5, y * 2.6, z * 2.6));
      const cr = craterValue(c.craters, x, y, z);
      let biome = 0;
      setMix(rgb, this.ice, this.pale, sstep(-0.25, 0.25, h));
      if (Math.abs(y) > 0.86) { biome = 3; setMix(rgb, rgb, this.crown, 0.8); }
      else if (rift > 0.95) { biome = 1; setMix(rgb, rgb, this.rift, sstep(0.95, 0.99, rift)); }
      else if (cr < -0.3) { biome = 2; shade(rgb, 0.88); }
      if (cr > 0) shade(rgb, 1 + 0.08 * cr);
      shade(rgb, 0.95 + 0.1 * c.noise.noise3(x * 17, y * 17, z * 17));
      return biome;
    },
    height(c, x, y, z, lod) {
      const n = c.noise, R = c.R;
      const h = n.fbm(x * 2.1, y * 2.1 + 8, z * 2.1, 3);
      const rift = 1 - Math.abs(n.noise3(x * 2.6 + 1.5, y * 2.6, z * 2.6));
      let H = 700 * h - 650 * sstep(0.93, 0.99, rift);
      H += sstep(0.82, 0.9, Math.abs(y)) * 900 * ridged(n, x, y, z, 12, 8, R, lod);
      return H + craterHeight(c.craters, x, y, z, R, 0.8) + rough(c, this.T, x, y, z, lod);
    },
  },

  rusk: {
    biomes: [B('ochredunes', 'Ochre Dunes'), B('riftmaze', 'Rift Maze'), B('tablelands', 'Iron Tablelands'), B('dustbasins', 'Dust Basins'), B('dryice', 'Dry-Ice Caps')],
    init(c) { c.craters = makeCraters(c.seed + 1, 12, 0.05, 0.16); },
    T: { cells: [40, 160, 640, 2600, 10000], cdens: 0.3, cdepth: 0.6, det: [44, 100] },
    dune: [0.72, 0.36, 0.20], dark: [0.46, 0.20, 0.13], table: [0.58, 0.27, 0.17], dust: [0.82, 0.52, 0.33], cap: [0.95, 0.92, 0.90],
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      const h = n.fbm(x * 2.0 + 6, y * 2.0, z * 2.0, 4);
      const rift = 1 - Math.abs(n.noise3(x * 2.2, y * 3.5 + 3, z * 2.2));
      const cr = craterValue(c.craters, x, y, z);
      let biome;
      if (Math.abs(y) + 0.05 * n.noise3(x * 5, y * 5, z * 5) > 0.93) {
        rgb[0] = this.cap[0]; rgb[1] = this.cap[1]; rgb[2] = this.cap[2];
        return 4;
      }
      if (rift > 0.955 && Math.abs(y) < 0.6) { biome = 1; setMix(rgb, this.table, this.dark, sstep(0.955, 0.985, rift)); }
      else if (h > 0.14) { biome = 2; setMix(rgb, this.dune, this.table, sstep(0.14, 0.3, h)); }
      else if (h < -0.16 || cr < -0.3) { biome = 3; setMix(rgb, this.dune, this.dust, sstep(-0.1, -0.3, h)); }
      else { biome = 0; setMix(rgb, this.dust, this.dune, sstep(-0.16, 0.14, h)); }
      if (cr > 0) shade(rgb, 1 + 0.15 * cr);
      else if (cr < 0) shade(rgb, 1 + 0.1 * cr);
      shade(rgb, 0.92 + 0.16 * n.noise3(x * 20, y * 20, z * 20));
      return biome;
    },
    height(c, x, y, z, lod) {
      const n = c.noise, R = c.R;
      const h = n.fbm(x * 2.0 + 6, y * 2.0, z * 2.0, 4);
      const rift = 1 - Math.abs(n.noise3(x * 2.2, y * 3.5 + 3, z * 2.2));
      // mesas: the tablelands rise in terraces with steep edges
      const mesa = sstep(0.13, 0.17, h) * 900 + sstep(0.24, 0.27, h) * 800 + sstep(0.36, 0.38, h) * 700;
      let H = 2400 * h + mesa + craterHeight(c.craters, x, y, z, R, 0.8);
      if (Math.abs(y) < 0.62) H -= 4200 * sstep(0.93, 0.985, rift) * (1 - sstep(0.55, 0.62, Math.abs(y)));
      // dune fields on the mid plains: long crests with a finer set riding on them
      const dn = sstep(-0.2, -0.05, h) * (1 - sstep(0.08, 0.15, h));
      if (dn > 0 && lod < 600) {
        const wv = n.noise3(x * 900, y * 900, z * 900);
        const d1 = 1 - Math.abs(n.noise3(x * 2600 + 0.6 * wv, y * 700, z * 2600));
        H += dn * (38 * d1 * d1 + (lod < 60 ? 5 * (1 - Math.abs(n.noise3(x * 21000, y * 6000, z * 21000 + wv))) : 0));
      }
      H += sstep(0.9, 0.95, Math.abs(y)) * 350;       // ice caps stand proud
      return H + rough(c, this.T, x, y, z, lod);
    },
  },

  // Rusk's lumpy captured moon.
  dray: {
    biomes: [B('dustlobes', 'Dust Lobes'), B('grooves', 'Groove Country'), B('bigdent', 'The Big Dent'), B('mauveknobs', 'Mauve Knobs')],
    init(c) { c.craters = makeCraters(c.seed + 6, 9, 0.12, 0.5); },
    T: { cells: [5, 18, 70, 280, 1100, 4400], cdens: 0.8, cdepth: 0.8, det: [14, 130] },
    dust: [0.47, 0.40, 0.38], dark: [0.30, 0.26, 0.27], mauve: [0.52, 0.40, 0.46], pale: [0.60, 0.55, 0.52],
    groove(c, x, y, z) { return Math.sin(34 * (y + 0.35 * x) + 3 * c.noise.noise3(x * 2, y * 2, z * 2)); },
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      const h = n.fbm(x * 1.3 + 1, y * 1.3, z * 1.3, 3);
      const cr = craterValue(c.craters, x, y, z);
      const g = this.groove(c, x, y, z);
      let biome;
      if (cr < -0.3) { biome = 2; setMix(rgb, this.dark, this.dust, 0.4); }
      else if (h > 0.12) { biome = 3; setMix(rgb, this.dust, this.mauve, sstep(0.12, 0.3, h)); }
      else if (z > 0.1 && g > 0.2) { biome = 1; setMix(rgb, this.dust, this.dark, sstep(0.2, 0.9, g) * 0.6); }
      else { biome = 0; setMix(rgb, this.dark, this.pale, sstep(-0.4, 0.2, h)); }
      if (cr > 0) shade(rgb, 1 + 0.2 * cr);
      shade(rgb, 0.9 + 0.2 * n.noise3(x * 15, y * 15, z * 15));
      return biome;
    },
    height(c, x, y, z, lod) {
      const n = c.noise, R = c.R;
      const h = n.fbm(x * 1.3 + 1, y * 1.3, z * 1.3, 3);
      let H = 4200 * h + craterHeight(c.craters, x, y, z, R, 0.8);
      if (z > 0.1) H -= 160 * sstep(0.2, 0.9, this.groove(c, x, y, z)) * sstep(0.1, 0.25, z);
      return H + rough(c, this.T, x, y, z, lod);
    },
  },

  thal: {
    biomes: [B('tealbelt', 'Teal Belt'), B('violetbands', 'Violet Bands'), B('stormovals', 'Storm Ovals'), B('polarhaze', 'Polar Haze')],
    teal: [0.16, 0.58, 0.58], pale: [0.50, 0.78, 0.74], violet: [0.46, 0.31, 0.66], haze: [0.30, 0.36, 0.60], storm: [0.88, 0.82, 0.92],
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      const warp = 0.045 * n.noise3(x * 3, y * 3, z * 3) + 0.012 * n.noise3(x * 11, y * 4, z * 11);
      const v = y + warp;
      const band = Math.sin(v * 15);
      const st = n.noise3(x * 3.2 + 9, y * 8, z * 3.2);
      let biome;
      if (Math.abs(v) > 0.86) { biome = 3; setMix(rgb, this.haze, this.violet, 0.5 + 0.5 * band); }
      else if (band > 0.1 && Math.abs(v) < 0.32) { biome = 0; setMix(rgb, this.teal, this.pale, sstep(0.1, 1, band)); }
      else if (band > 0.1) { biome = 0; setMix(rgb, this.teal, this.pale, sstep(0.1, 1, band) * 0.6); }
      else { biome = 1; setMix(rgb, this.teal, this.violet, sstep(0.1, -0.5, band)); }
      if (st > 0.5 && Math.abs(v) < 0.8) { biome = 2; setMix(rgb, rgb, this.storm, sstep(0.5, 0.66, st)); }
      shade(rgb, 0.95 + 0.08 * n.noise3(x * 6, y * 30, z * 6));
      return biome;
    },
  },

  tiv: {
    biomes: [B('sulfurflats', 'Sulfur Flats'), B('ventfields', 'Vent Fields'), B('brimlakes', 'Brimstone Lakes'), B('greenridges', 'Green Ridges')],
    init(c) { c.craters = makeCraters(c.seed + 7, 10, 0.05, 0.14); },
    T: { cells: [60, 240, 1000, 4000, 16000], cdens: 0.25, cdepth: -0.5, det: [40, 110] },   // negative depth: vent cones
    flat: [0.84, 0.80, 0.30], green: [0.52, 0.66, 0.24], vent: [0.36, 0.30, 0.14], lake: [0.90, 0.52, 0.12], pale: [0.93, 0.90, 0.58],
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      const h = n.fbm(x * 2.2, y * 2.2, z * 2.2 + 4, 4);
      const vnt = n.noise3(x * 4.5 + 2, y * 4.5, z * 4.5);
      const cr = craterValue(c.craters, x, y, z);
      let biome;
      if (h < -0.2) { biome = 2; setMix(rgb, this.flat, this.lake, sstep(-0.2, -0.27, h)); }
      else if (vnt > 0.42 || cr < -0.3) { biome = 1; setMix(rgb, this.flat, this.vent, cr < -0.3 ? 0.8 : sstep(0.42, 0.6, vnt)); }
      else if (h > 0.12) { biome = 3; setMix(rgb, this.flat, this.green, sstep(0.12, 0.28, h)); }
      else { biome = 0; setMix(rgb, this.pale, this.flat, sstep(-0.2, 0.12, h)); }
      if (cr > 0) shade(rgb, 1 + 0.12 * cr);
      shade(rgb, 0.93 + 0.14 * n.noise3(x * 18, y * 18, z * 18));
      return biome;
    },
    height(c, x, y, z, lod) {
      const n = c.noise, R = c.R;
      const h = n.fbm(x * 2.2, y * 2.2, z * 2.2 + 4, 4);
      const vnt = n.noise3(x * 4.5 + 2, y * 4.5, z * 4.5);
      const land = sstep(-0.27, -0.2, h);             // brimstone lakes are dead flat
      let H = 2000 * (h + 0.2) + sstep(0.1, 0.3, h) * 2400 * ridged(n, x, y, z, 9, 9, R, lod);
      H += sstep(0.35, 0.6, vnt) * 500 + craterHeight(c.craters, x, y, z, R, 1) + rough(c, this.T, x, y, z, lod);
      return -150 + H * land;
    },
  },

  // Thal's cold moon with a thin oxygen-bearing atmosphere: lichen steppe, frozen mirror lakes.
  marn: {
    biomes: [B('lichensteppe', 'Lichen Steppe'), B('russetbarrens', 'Russet Barrens'), B('mirrorlakes', 'Mirror Lakes'), B('stormheights', 'Storm Heights'), B('rimefields', 'Rime Fields')],
    init(c) { c.craters = makeCraters(c.seed + 8, 8, 0.05, 0.13); },
    T: { cells: [300, 1200, 5000], cdens: 0.15, cdepth: 0.5, det: [46, 90] },
    moss: [0.34, 0.42, 0.36], violet: [0.42, 0.36, 0.50], russet: [0.55, 0.34, 0.24], lake: [0.70, 0.84, 0.90],
    crag: [0.36, 0.35, 0.40], rime: [0.90, 0.93, 0.97],
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      const h = n.fbm(x * 2.0 + 13, y * 2.0, z * 2.0 + 2, 4);
      const m = n.fbm(x * 2.8, y * 2.8 + 7, z * 2.8, 3);
      let biome;
      if (Math.abs(y) + 0.08 * n.noise3(x * 5, y * 5, z * 5) + 0.1 * (h > 0 ? h : 0) > 0.86) { setRgb(rgb, this.rime); shade(rgb, 0.95 + 0.05 * m); return 4; }
      if (h < -0.2) { biome = 2; setMix(rgb, this.moss, this.lake, sstep(-0.2, -0.23, h)); }
      else if (h > 0.2) { biome = 3; setMix(rgb, this.crag, this.rime, sstep(0.36, 0.48, h)); }
      else if (m < -0.08) { biome = 1; setMix(rgb, this.moss, this.russet, sstep(-0.08, -0.2, m)); }
      else { biome = 0; setMix(rgb, this.moss, this.violet, sstep(0.0, 0.3, m)); }
      if (biome < 2 && h > 0.13) setMix(rgb, rgb, this.crag, sstep(0.13, 0.2, h));
      shade(rgb, 0.92 + 0.16 * n.noise3(x * 20, y * 20, z * 20));
      return biome;
    },
    height(c, x, y, z, lod) {
      const n = c.noise, R = c.R;
      const h = n.fbm(x * 2.0 + 13, y * 2.0, z * 2.0 + 2, 4);
      const land = sstep(-0.23, -0.19, h);            // frozen lakes are flat
      let H = 1900 * (h + 0.2) + sstep(0.14, 0.32, h) * 3000 * ridged(n, x, y, z, 10, 9, R, lod);
      H += craterHeight(c.craters, x, y, z, R, 0.6) + rough(c, this.T, x, y, z, lod);
      return -40 + H * land;
    },
  },

  // Tiny captured rock far out in Thal's system.
  nock: {
    biomes: [B('sootlobes', 'Soot Lobes'), B('rustsaddle', 'Rust Saddle'), B('chipscarps', 'Chip Scarps')],
    init(c) { c.craters = makeCraters(c.seed + 2, 7, 0.15, 0.55); },
    T: { cells: [4, 14, 52, 200, 800], cdens: 0.8, cdepth: 0.7, det: [8, 60] },
    soot: [0.20, 0.19, 0.20], rust: [0.42, 0.25, 0.19], chip: [0.44, 0.42, 0.42],
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      const h = n.fbm(x * 1.1 + 4, y * 1.1, z * 1.1, 3);
      const s = n.noise3(x * 1.6, y * 1.6 + 5, z * 1.6);
      let biome;
      if (s > 0.18) { biome = 1; setMix(rgb, this.soot, this.rust, sstep(0.18, 0.4, s)); }
      else if (h < -0.12) { biome = 2; setMix(rgb, this.soot, this.chip, sstep(-0.12, -0.3, h)); }
      else { biome = 0; setRgb(rgb, this.soot); }
      const cr = craterValue(c.craters, x, y, z);
      if (cr > 0) shade(rgb, 1 + 0.3 * cr); else shade(rgb, 1 + 0.15 * cr);
      shade(rgb, 0.85 + 0.3 * n.noise3(x * 11, y * 11, z * 11));
      return biome;
    },
    height(c, x, y, z, lod) {
      const R = c.R;
      const h = c.noise.fbm(x * 1.1 + 4, y * 1.1, z * 1.1, 3);
      return 0.16 * R * h + craterHeight(c.craters, x, y, z, R, 0.7) + rough(c, this.T, x, y, z, lod);
    },
  },

  // Ringed amber giant.
  orrin: {
    biomes: [B('amberbelt', 'Amber Belt'), B('creamzones', 'Cream Zones'), B('umberstorms', 'Umber Storms'), B('polarhex', 'Polar Hexlands')],
    amber: [0.80, 0.58, 0.30], cream: [0.93, 0.85, 0.66], umber: [0.50, 0.30, 0.17], hex: [0.56, 0.52, 0.42], white: [0.97, 0.94, 0.86],
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      const warp = 0.03 * n.noise3(x * 4, y * 4, z * 4) + 0.01 * n.noise3(x * 14, y * 5, z * 14);
      const v = y + warp;
      const band = Math.sin(v * 21) + 0.35 * Math.sin(v * 53 + 1);
      const st = n.noise3(x * 2.6 + 3, y * 9, z * 2.6);
      let biome;
      if (Math.abs(v) > 0.84) { biome = 3; setMix(rgb, this.hex, this.amber, 0.3 + 0.3 * band); }
      else if (band > 0.15) { biome = 1; setMix(rgb, this.amber, this.cream, sstep(0.15, 1, band)); }
      else { biome = 0; setMix(rgb, this.amber, this.umber, sstep(0.15, -1.0, band) * 0.7); }
      if (st > 0.52 && Math.abs(v) < 0.8) { biome = 2; setMix(rgb, rgb, st > 0.62 ? this.white : this.umber, sstep(0.52, 0.64, st)); }
      shade(rgb, 0.95 + 0.08 * n.noise3(x * 5, y * 34, z * 5));
      return biome;
    },
  },

  // Orrin's ice-shell ocean moon: bright ice, brown lineae, jumbled chaos, a few open leads of dark water.
  brim: {
    biomes: [B('shellice', 'Shell Ice'), B('lineae', 'Rust Lineae'), B('chaosrafts', 'Chaos Rafts'), B('openleads', 'Open Leads', true), B('polardrifts', 'Polar Drifts')],
    T: { cells: [200, 900, 4000], cdens: 0.12, cdepth: 0.4, det: [60, 22] },
    ice: [0.86, 0.90, 0.93], blue: [0.66, 0.80, 0.92], line: [0.58, 0.40, 0.30], water: [0.03, 0.09, 0.17], drift: [0.97, 0.98, 1.0],
    lines(c, x, y, z) {
      const n = c.noise;
      const a = 1 - Math.abs(n.noise3(x * 3.1 + 5, y * 3.1, z * 3.1));
      const b = 1 - Math.abs(n.noise3(x * 5.3, y * 5.3 + 2, z * 5.3 + 8));
      return a > b ? a : b;
    },
    lead(c, x, y, z) { return 1 - Math.abs(c.noise.noise3(x * 1.7 + 9, y * 1.7 + 3, z * 1.7)); },
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      const ch = n.fbm(x * 2.2 + 3, y * 2.2, z * 2.2, 3);
      const ln = this.lines(c, x, y, z), ld = this.lead(c, x, y, z);
      let biome;
      if (ld > 0.958 && Math.abs(y) < 0.82 && this.height(c, x, y, z, 0) < 0) { setRgb(rgb, this.water); return 3; }
      if (Math.abs(y) > 0.87) { biome = 4; setMix(rgb, this.ice, this.drift, 0.8); }
      else if (ln > 0.955) { biome = 1; setMix(rgb, this.ice, this.line, sstep(0.955, 0.985, ln)); }
      else if (ch > 0.2) { biome = 2; setMix(rgb, this.blue, this.ice, 0.5 + 0.5 * Math.sign(n.noise3(x * 40, y * 40, z * 40))); setMix(rgb, rgb, this.line, 0.18); }
      else { biome = 0; setMix(rgb, this.blue, this.ice, sstep(-0.3, 0.2, ch)); }
      if (ld > 0.955) setMix(rgb, rgb, this.blue, 0.6);
      shade(rgb, 0.95 + 0.1 * n.noise3(x * 18, y * 18, z * 18));
      return biome;
    },
    height(c, x, y, z, lod) {
      const n = c.noise, R = c.R;
      const ch = n.fbm(x * 2.2 + 3, y * 2.2, z * 2.2, 3);
      const ln = this.lines(c, x, y, z), ld = this.lead(c, x, y, z);
      let H = 160 * ch + 240 * sstep(0.93, 0.975, ln) * (1 - 0.6 * sstep(0.985, 1, ln));   // double ridges
      if (ch > 0.18) {
        // chaos: tilted rafts of ice at different levels
        const raft = n.noise3(x * 40, y * 40, z * 40);
        H += sstep(0.18, 0.24, ch) * (120 * Math.sign(raft) * sstep(0.02, 0.1, Math.abs(raft)) + 90 * n.noise3(x * 170, y * 170, z * 170));
      }
      H += sstep(0.84, 0.9, Math.abs(y)) * 300 * ridged(n, x, y, z, 30, 8, R, lod) + rough(c, this.T, x, y, z, lod);
      if (Math.abs(y) < 0.82) {
        const open = sstep(0.958, 0.972, ld) * (1 - sstep(0.78, 0.82, Math.abs(y)));
        H += (-460 - H) * open;                       // leads cut 200 m below the sea surface
      }
      return H + 260;
    },
  },

  // Orrin's dark outer moon: old basins, canyon chains, bright fault scarps.
  slate: {
    biomes: [B('slateplains', 'Slate Plains'), B('brightscarps', 'Bright Scarps'), B('oldbasins', 'Old Basins'), B('canyonchains', 'Canyon Chains')],
    init(c) { c.craters = makeCraters(c.seed + 11, 30, 0.05, 0.26); },
    T: { cells: [12, 46, 180, 700, 2800, 11000, 44000], cdens: 0.8, cdepth: 0.75, det: [34, 150] },
    plain: [0.25, 0.28, 0.34], dark: [0.15, 0.17, 0.22], scarp: [0.74, 0.80, 0.86], basin: [0.20, 0.21, 0.27],
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      const h = n.fbm(x * 1.7 + 8, y * 1.7 + 1, z * 1.7, 4);
      const f = n.noise3(x * 2.4, y * 2.4 + 9, z * 2.4);
      const can = 1 - Math.abs(n.noise3(x * 1.9 + 3, y * 3.6, z * 1.9));
      const cr = craterValue(c.craters, x, y, z);
      let biome;
      if (can > 0.96 && Math.abs(y) < 0.7) { biome = 3; setMix(rgb, this.plain, this.dark, sstep(0.96, 0.99, can)); }
      else if (Math.abs(f) < 0.035) { biome = 1; setMix(rgb, this.scarp, this.plain, sstep(0.012, 0.035, Math.abs(f))); }
      else if (cr < -0.3) { biome = 2; setRgb(rgb, this.basin); }
      else { biome = 0; setMix(rgb, this.dark, this.plain, sstep(-0.3, 0.3, h)); }
      if (cr > 0) shade(rgb, 1 + 0.35 * cr);
      const ray = craterRays(c.craters, 3, n, x, y, z);
      if (ray > 0) shade(rgb, 1 + 0.5 * ray);
      shade(rgb, 0.9 + 0.2 * n.noise3(x * 21, y * 21, z * 21));
      return biome;
    },
    height(c, x, y, z, lod) {
      const n = c.noise, R = c.R;
      const h = n.fbm(x * 1.7 + 8, y * 1.7 + 1, z * 1.7, 4);
      const f = n.noise3(x * 2.4, y * 2.4 + 9, z * 2.4);
      const can = 1 - Math.abs(n.noise3(x * 1.9 + 3, y * 3.6, z * 1.9));
      let H = 2200 * h + 1400 * sstep(-0.02, 0.02, f);     // fault blocks: a 1.4 km step along the scarps
      if (Math.abs(y) < 0.72) H -= 3000 * sstep(0.94, 0.985, can) * (1 - sstep(0.66, 0.72, Math.abs(y)));
      return H + craterHeight(c.craters, x, y, z, R, 1) + rough(c, this.T, x, y, z, lod);
    },
  },

  // Distant dwarf: a pale nitrogen glacier, dark red uplands, water-ice ranges.
  quell: {
    biomes: [B('blushglacier', 'Blush Glacier'), B('tholinreds', 'Tholin Reds'), B('coldranges', 'Cold Ranges'), B('pittedplain', 'Pitted Plain')],
    init(c) { c.craters = makeCraters(c.seed + 13, 20, 0.05, 0.2); },
    T: { cells: [8, 30, 120, 480, 1900, 7600], cdens: 0.6, cdepth: 0.7, det: [26, 120] },
    glacier: [0.93, 0.86, 0.80], cell: [0.84, 0.74, 0.68], red: [0.45, 0.20, 0.14], range: [0.72, 0.74, 0.80], pit: [0.80, 0.70, 0.60],
    glac(c, x, y, z) { return 0.8 * x + 0.35 * y + 0.22 * c.noise.fbm(x * 2.4, y * 2.4, z * 2.4 + 3, 3); },
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      const g = this.glac(c, x, y, z);
      const h = n.fbm(x * 2.0 + 2, y * 2.0 + 6, z * 2.0, 4);
      let biome;
      if (g > 0.45) {
        biome = 0;
        const poly = 1 - Math.abs(n.noise3(x * 16, y * 16, z * 16));
        setMix(rgb, this.glacier, this.cell, sstep(0.9, 0.98, poly));
      } else if (g > 0.3) {
        biome = 3; setMix(rgb, this.pit, this.glacier, sstep(0.3, 0.45, g));
        shade(rgb, 0.9 + 0.1 * n.noise3(x * 60, y * 60, z * 60));
      } else if (h > 0.12) { biome = 2; setMix(rgb, this.red, this.range, sstep(0.12, 0.26, h)); }
      else {
        biome = 1; setMix(rgb, this.red, this.pit, sstep(-0.1, -0.45, h) * 0.5);
        const cr = craterValue(c.craters, x, y, z);
        if (cr > 0) shade(rgb, 1 + 0.35 * cr); else shade(rgb, 1 + 0.2 * cr);
      }
      shade(rgb, 0.93 + 0.14 * n.noise3(x * 19, y * 19, z * 19));
      return biome;
    },
    height(c, x, y, z, lod) {
      const n = c.noise, R = c.R;
      const g = this.glac(c, x, y, z);
      const h = n.fbm(x * 2.0 + 2, y * 2.0 + 6, z * 2.0, 4);
      const land = 1 - sstep(0.36, 0.47, g);          // 0 on the glacier
      const poly = 1 - Math.abs(n.noise3(x * 16, y * 16, z * 16));
      let H = 1500 * h + sstep(0.1, 0.28, h) * 3200 * ridged(n, x, y, z, 9, 9, R, lod);
      H += craterHeight(c.craters, x, y, z, R, 1) + rough(c, this.T, x, y, z, lod);
      // pitted plain: fields of sublimation pits at the glacier's edge
      const pits = sstep(0.28, 0.34, g) * (1 - sstep(0.44, 0.5, g));
      const pit = pits > 0 && lod < 400 ? -pits * 60 * sstep(0.2, 0.7, n.noise3(x * 2300, y * 2300, z * 2300)) : 0;
      return -700 - 25 * sstep(0.9, 0.98, poly) * (1 - land) + pit + (H + 900) * land;
    },
  },

  // Quell's companion.
  nym: {
    biomes: [B('greywastes', 'Grey Wastes'), B('redcrown', 'Red Crown'), B('chasmbelt', 'Chasm Belt')],
    init(c) { c.craters = makeCraters(c.seed + 5, 18, 0.07, 0.3); },
    T: { cells: [6, 22, 85, 340, 1350, 5400], cdens: 0.75, cdepth: 0.8, det: [18, 110] },
    grey: [0.50, 0.50, 0.52], dark: [0.36, 0.36, 0.40], red: [0.50, 0.26, 0.20],
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      const h = n.fbm(x * 1.6, y * 1.6 + 4, z * 1.6 + 1, 4);
      const ch = Math.abs(y + 0.12 * n.noise3(x * 2, y * 2, z * 2) + 0.05);
      let biome;
      if (y + 0.1 * n.noise3(x * 4, y * 4, z * 4) > 0.72) { biome = 1; setMix(rgb, this.grey, this.red, sstep(0.72, 0.84, y) * 0.8 + 0.2); }
      else if (ch < 0.06) { biome = 2; setMix(rgb, this.dark, this.grey, sstep(0.02, 0.06, ch)); }
      else { biome = 0; setMix(rgb, this.dark, this.grey, sstep(-0.3, 0.3, h)); }
      const cr = craterValue(c.craters, x, y, z);
      if (cr > 0) shade(rgb, 1 + 0.25 * cr); else shade(rgb, 1 + 0.15 * cr);
      shade(rgb, 0.9 + 0.2 * n.noise3(x * 17, y * 17, z * 17));
      return biome;
    },
    height(c, x, y, z, lod) {
      const n = c.noise, R = c.R;
      const h = n.fbm(x * 1.6, y * 1.6 + 4, z * 1.6 + 1, 4);
      const ch = Math.abs(y + 0.12 * n.noise3(x * 2, y * 2, z * 2) + 0.05);
      return 1700 * h - 3800 * (1 - sstep(0.015, 0.07, ch)) + craterHeight(c.craters, x, y, z, R, 1) + rough(c, this.T, x, y, z, lod);
    },
  },

  // The wanderer: a dark, eccentric comet nucleus.
  wend: {
    biomes: [B('darkcrust', 'Dark Crust'), B('jetvents', 'Jet Vents'), B('iceoutcrops', 'Ice Outcrops')],
    T: { cells: [5, 18, 70, 280, 1100], cdens: 0.5, cdepth: 0.8, det: [8, 50] },
    crust: [0.14, 0.13, 0.13], vent: [0.30, 0.34, 0.38], ice: [0.80, 0.88, 0.93],
    sample(c, x, y, z, rgb) {
      const n = c.noise;
      const v = n.noise3(x * 2.3 + 6, y * 2.3, z * 2.3);
      const s = n.fbm(x * 3.1, y * 3.1 + 3, z * 3.1, 3);
      let biome;
      if (v > 0.36) { biome = 1; setMix(rgb, this.crust, this.vent, sstep(0.36, 0.55, v)); }
      else if (s > 0.22) { biome = 2; setMix(rgb, this.crust, this.ice, sstep(0.22, 0.32, s)); }
      else { biome = 0; setRgb(rgb, this.crust); }
      shade(rgb, 0.8 + 0.4 * n.noise3(x * 10, y * 10, z * 10));
      return biome;
    },
    height(c, x, y, z, lod) {
      const n = c.noise, R = c.R;
      // two lobes joined by a neck
      const lobes = 0.22 * R * (Math.abs(x) - 0.45) + 0.1 * R * n.fbm(x * 1.2 + 2, y * 1.2, z * 1.2, 3);
      const v = n.noise3(x * 2.3 + 6, y * 2.3, z * 2.3);
      return lobes - 120 * sstep(0.36, 0.6, v) + rough(c, this.T, x, y, z, lod);
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------------------------

const _rgb = [0, 0, 0];
const _v = new Vector3();

export class Body {
  constructor(def, parent) {
    this.id = def.id;
    this.name = def.name;
    this.type = def.type;
    this.parent = parent || null;
    this.children = [];
    this.radius = def.radius;
    this.gm = def.gm !== undefined ? def.gm : def.surfaceG * def.radius * def.radius;
    this.surfaceG = this.gm / (this.radius * this.radius);
    this.atmo = def.atmo
      ? { height: def.atmo[0], scale: def.atmo[1], rho0: def.atmo[2], color: def.atmoColor, oxygen: !!def.oxygen }
      : null;
    this.ocean = !!def.ocean;
    /** Height of the liquid surface relative to `radius` (only meaningful when `ocean`). */
    this.seaLevel = def.seaLevel || 0;
    /** Ring system in the equatorial plane: { inner, outer } radii in metres from the centre, or null. */
    this.ring = def.ring ? { inner: def.ring[0] * def.radius, outer: def.ring[1] * def.radius } : null;
    /** Bounds of terrainHeight over the whole body, metres ([0, 0] for stars and gas giants). */
    this.minElevation = def.relief ? def.relief[0] : 0;
    this.maxElevation = def.relief ? def.relief[1] : 0;
    this.blurb = def.blurb || '';
    this.sites = null;
    this.launchSite = null;
    this.gas = !!def.gas;
    this.color = def.color;
    this.seed = def.seed;
    this.sciMult = def.sciMult;
    this.spaceBorder = def.spaceBorder;
    this.orbit = null;
    this.soi = Infinity;
    if (parent) {
      parent.children.push(this);
      const [a, e, i, lan, argp, M0] = def.orbit;
      this.orbit = Orbit.fromElements({ a, e, i, lan, argp, M0 }, parent.gm, 0);
      this.soi = a * Math.pow(this.gm / parent.gm, 0.4);
    }
    this.tidal = def.rotPeriod === 'tidal';
    this.rotPeriod = this.tidal ? this.orbit.period : (def.rotPeriod || 1);
    if (this.tidal) {
      // body-fixed +X (lon 0) faces the parent at t = 0
      const p = this.orbit.posAt(0, _v);
      this.rot0 = Math.atan2(p.z, -p.x);
    } else {
      this.rot0 = def.rot0 || 0;
    }
    this._w = TAU / this.rotPeriod;
    const surf = SURFACES[this.id];
    this._surf = surf;
    this.biomes = surf.biomes;
    this._ctx = { noise: makeNoise(this.seed), seed: this.seed, craters: null, R: this.radius, h: 0, m: 0, ws: 0, cst: 0 };
    this._solid = !!surf.height;
    if (surf.init) surf.init(this._ctx);
  }

  /** Position relative to the parent body (zero for the star). */
  posAt(t, out = new Vector3()) {
    return this.orbit ? this.orbit.posAt(t, out) : out.set(0, 0, 0);
  }

  velAt(t, out = new Vector3()) {
    return this.orbit ? this.orbit.velAt(t, out) : out.set(0, 0, 0);
  }

  /** Position relative to the star. */
  globalPosAt(t, out = new Vector3()) {
    let x = 0, y = 0, z = 0;
    for (let b = this; b && b.orbit; b = b.parent) {
      b.orbit.posAt(t, out);
      x += out.x; y += out.y; z += out.z;
    }
    return out.set(x, y, z);
  }

  globalVelAt(t, out = new Vector3()) {
    let x = 0, y = 0, z = 0;
    for (let b = this; b && b.orbit; b = b.parent) {
      b.orbit.velAt(t, out);
      x += out.x; y += out.y; z += out.z;
    }
    return out.set(x, y, z);
  }

  /** Rotation angle about +Y at time t, radians in [0, 2π). */
  rotationAngle(t) {
    const a = (this.rot0 + this._w * t) % TAU;
    return a < 0 ? a + TAU : a;
  }

  angVel(out = new Vector3()) {
    return out.set(0, this._w, 0);
  }

  /** Air density in kg/m³ at an altitude above the surface (0 outside the atmosphere). */
  density(alt) {
    const at = this.atmo;
    if (!at || !(alt < at.height)) return 0;
    return at.rho0 * Math.exp(-(alt > 0 ? alt : 0) / at.scale);
  }

  /** Pressure in home-sea-level atmospheres. */
  pressureAtm(alt) {
    const at = this.atmo;
    if (!at || !(alt < at.height)) return 0;
    return (at.rho0 / HOME_RHO0) * Math.exp(-(alt > 0 ? alt : 0) / at.scale);
  }

  /** Rotate a body-fixed direction (or position) into the inertial frame at time t. */
  surfaceDirToInertial(d, t, out = new Vector3()) {
    const a = this.rotationAngle(t), c = Math.cos(a), s = Math.sin(a);
    const x = d.x, z = d.z;
    return out.set(x * c + z * s, d.y, -x * s + z * c);
  }

  /** Rotate an inertial direction (or position) into the body-fixed frame at time t. */
  inertialToSurfaceDir(d, t, out = new Vector3()) {
    const a = this.rotationAngle(t), c = Math.cos(a), s = Math.sin(a);
    const x = d.x, z = d.z;
    return out.set(x * c - z * s, d.y, x * s + z * c);
  }

  /** {lat, lon} in radians for a body-fixed direction (need not be normalised). */
  latLon(d) {
    const l = Math.hypot(d.x, d.y, d.z) || 1;
    const y = d.y / l;
    return { lat: Math.asin(y > 1 ? 1 : y < -1 ? -1 : y), lon: Math.atan2(-d.z, d.x) };
  }

  /** Body-fixed unit direction for latitude/longitude in radians. */
  dirFromLatLon(lat, lon, out = new Vector3()) {
    const c = Math.cos(lat);
    return out.set(c * Math.cos(lon), Math.sin(lat), -c * Math.sin(lon));
  }

  /**
   * Terrain height in metres above `radius` at a body-fixed direction (need not be normalised).
   * Deterministic. `lod` (metres) drops relief finer than that size, for coarse meshes; physics uses 0.
   * Always 0 for stars and gas giants. On ocean worlds the sea bed is below `seaLevel`.
   */
  terrainHeight(d, lod = 0) {
    if (!this._solid) return 0;
    const x = d.x, y = d.y, z = d.z;
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    return this._surf.height(this._ctx, x / l, y / l, z / l, lod);
  }

  /**
   * Height (m above `radius`) of the top of a built deck at body-fixed direction d (a landing barge: `this.decks`),
   * or -Infinity where there is none. A deck is a flat rectangle, solid to the physics, that is not part of the
   * terrain: the height field and everything drawn from it do not know about it.
   */
  deckAt(d) {
    const decks = this.decks;
    if (!decks) return -Infinity;
    const l = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z) || 1;
    for (let i = 0; i < decks.length; i++) {
      const k = decks[i], c = k.dir;
      const dot = (d.x * c.x + d.y * c.y + d.z * c.z) / l;
      if (dot < k.cosReach) continue;
      const s = this.radius / (l * dot);                                // (onto the plane touching the globe at the deck)
      const x = (d.x * k.east.x + d.y * k.east.y + d.z * k.east.z) * s, z = (d.x * k.north.x + d.y * k.north.y + d.z * k.north.z) * s;
      const a = x * k.cosH + z * k.sinH, b = -x * k.sinH + z * k.cosH;   // along and across the deck
      if (Math.abs(a) <= k.length / 2 && Math.abs(b) <= k.width / 2) return k.top;
    }
    return -Infinity;
  }

  /** Height of whatever a vessel meets first: a deck, terrain, or the sea surface where the terrain is under water. */
  surfaceHeight(d) {
    const h = Math.max(this.terrainHeight(d, 0), this.deckAt(d));
    return this.ocean && h < this.seaLevel ? this.seaLevel : h;
  }

  /** True where the terrain lies below the sea surface of an ocean world (and no deck stands there). */
  isWater(d) {
    return this.ocean && this.terrainHeight(d, 0) < this.seaLevel && this.deckAt(d) === -Infinity;
  }

  /**
   * Outward unit normal of the terrain in the body-fixed frame at direction d, by central differences over
   * `eps` metres (default 2 m: use the footprint of whatever is standing there).
   */
  terrainNormal(d, out = new Vector3(), eps = 2) {
    const l = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z) || 1;
    const ux = d.x / l, uy = d.y / l, uz = d.z / l;
    if (!this._solid) return out.set(ux, uy, uz);
    // tangent basis: east = Y × up (or X × up at the poles), north = up × east
    let ex = uz, ey = 0, ez = -ux;
    let el = Math.sqrt(ex * ex + ez * ez);
    if (el < 1e-6) { ex = 0; ey = -uz; ez = uy; el = Math.sqrt(ey * ey + ez * ez); }
    ex /= el; ey /= el; ez /= el;
    const nx = uy * ez - uz * ey, ny = uz * ex - ux * ez, nz = ux * ey - uy * ex;
    const a = eps / this.radius, s = this._surf, c = this._ctx;
    const n = (px, py, pz) => { const k = 1 / Math.sqrt(px * px + py * py + pz * pz); return s.height(c, px * k, py * k, pz * k, 0); };
    const dE = (n(ux + ex * a, uy + ey * a, uz + ez * a) - n(ux - ex * a, uy - ey * a, uz - ez * a)) / (2 * eps);
    const dN = (n(ux + nx * a, uy + ny * a, uz + nz * a) - n(ux - nx * a, uy - ny * a, uz - nz * a)) / (2 * eps);
    return out.set(ux - dE * ex - dN * nx, uy - dE * ey - dN * ny, uz - dE * ez - dN * nz).normalize();
  }

  /** Biome at a body-fixed unit direction: a shared frozen {id, name, water}. */
  biomeAt(d) {
    return this.biomes[this._surf.sample(this._ctx, d.x, d.y, d.z, _rgb)];
  }

  /** Surface colour [r, g, b] in 0..1 at a body-fixed unit direction. */
  surfaceColorAt(d, out = [0, 0, 0]) {
    this._surf.sample(this._ctx, d.x, d.y, d.z, out);
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// System data
// ---------------------------------------------------------------------------------------------

// orbit: [a, e, i°, lan°, argp°, M0]; atmo: [height, scale, rho0]; relief: [min, max] terrain height (m);
// ring: [inner, outer] in body radii. The eight bodies of the first release keep their numbers exactly.
const DEFS = [
  { id: 'helion', name: 'Helion', type: 'star', parent: null, radius: 2.2e8, gm: 1.2e18, rotPeriod: 432000,
    color: 0xffd76a, seed: 101, sciMult: 11, spaceBorder: 1e9,
    blurb: 'The system\'s star. Everything else is in orbit around it.' },
  { id: 'sear', name: 'Sear', type: 'planet', parent: 'helion', radius: 1.5e5, surfaceG: 2.0, rotPeriod: 'tidal',
    orbit: [3.4e9, 0.06, 3.5, 20, 40, 0.7], color: 0xd9541a, seed: 111, sciMult: 8, spaceBorder: 4e4, relief: [-6000, 6500],
    blurb: 'Tidally locked and half molten: a lava sea under permanent noon, frozen slag on the far side.' },
  { id: 'cindra', name: 'Cindra', type: 'planet', parent: 'helion', radius: 2.5e5, surfaceG: 2.8, rotPeriod: 1.2e6,
    orbit: [6.2e9, 0.18, 6, 70, 15, 2.1], color: 0x5a3a28, seed: 202, sciMult: 7, spaceBorder: 6e4, relief: [-6000, 8000],
    blurb: 'A scorched, cratered cinder on an eccentric orbit.' },
  { id: 'murk', name: 'Murk', type: 'planet', parent: 'helion', radius: 5.4e5, surfaceG: 8.4, rotPeriod: 7.5e5,
    orbit: [9.9e9, 0.015, 2.2, 250, 0, 4.0], atmo: [110000, 6500, 60], atmoColor: [0.95, 0.74, 0.42],
    color: 0xd8a55a, seed: 252, sciMult: 8, spaceBorder: 2.6e5, relief: [-2500, 12000],
    blurb: 'Fifty atmospheres of ochre cloud over shield volcanoes. Easy to land on, very hard to leave.' },
  { id: 'verda', name: 'Verda', type: 'planet', parent: 'helion', radius: 6.4e5, surfaceG: 9.6, rotPeriod: 19800,
    rot0: Math.PI,   // the launch site faces Helion (local noon) at t = 0
    orbit: [1.36e10, 0, 0, 0, 0, 0], atmo: [72000, 5800, 1.22], atmoColor: [0.42, 0.66, 1.0], oxygen: true, ocean: true,
    seaLevel: VERDA_SEA, color: 0x3f8fd0, seed: 303, sciMult: 1, spaceBorder: 2.5e5, relief: [-6000, 9000],
    blurb: 'Home. Oceans, green lowlands and the Starwright Flight Center.' },
  { id: 'pell', name: 'Pell', type: 'moon', parent: 'verda', radius: 2.1e5, surfaceG: 1.6, rotPeriod: 'tidal',
    orbit: [1.25e7, 0, 0, 0, 0, 1.7], color: 0x9a9a98, seed: 404, sciMult: 4, spaceBorder: 6e4, relief: [-7000, 7000],
    blurb: 'Verda\'s grey, cratered near moon: ashen seas and pale uplands.' },
  { id: 'ost', name: 'Ost', type: 'moon', parent: 'verda', radius: 7.0e4, surfaceG: 0.5, rotPeriod: 40000,
    orbit: [4.4e7, 0.08, 5.5, 40, 30, 0.5], color: 0xcfe6f5, seed: 505, sciMult: 5, spaceBorder: 3e4, relief: [-3500, 3500],
    blurb: 'A small, bright ice moon on an inclined orbit, split by blue rifts.' },
  { id: 'rusk', name: 'Rusk', type: 'planet', parent: 'helion', radius: 3.6e5, surfaceG: 3.2, rotPeriod: 24000,
    orbit: [2.05e10, 0.05, 1.5, 130, 60, 3.6], atmo: [45000, 6500, 0.25], atmoColor: [0.86, 0.60, 0.42],
    color: 0xb5562f, seed: 606, sciMult: 6, spaceBorder: 1.4e5, relief: [-8000, 6500],
    blurb: 'A rust-red desert world: dunes, mesas, a maze of canyons and thin air.' },
  { id: 'dray', name: 'Dray', type: 'moon', parent: 'rusk', radius: 3.2e4, surfaceG: 0.22, rotPeriod: 'tidal',
    orbit: [5.5e6, 0.02, 1.0, 10, 0, 1.1], color: 0x7a686a, seed: 616, sciMult: 6.5, spaceBorder: 1.2e4, relief: [-5000, 4500],
    blurb: 'Rusk\'s lumpy, grooved moon. Gravity is so weak that a hard jump is a suborbital flight.' },
  { id: 'thal', name: 'Thal', type: 'planet', parent: 'helion', radius: 5.2e6, surfaceG: 8.5, rotPeriod: 36000,
    orbit: [6.8e10, 0.04, 1.2, 200, 10, 5.1], atmo: [400000, 40000, 3.0], atmoColor: [0.45, 0.75, 0.80], gas: true,
    color: 0x3fa3a0, seed: 707, sciMult: 9, spaceBorder: 2e6,
    blurb: 'A teal and violet gas giant with four very different moons.' },
  { id: 'tiv', name: 'Tiv', type: 'moon', parent: 'thal', radius: 4.0e5, surfaceG: 2.2, rotPeriod: 'tidal',
    orbit: [3.2e7, 0.01, 0.5, 0, 0, 2.4], color: 0xc9c84a, seed: 808, sciMult: 9, spaceBorder: 8e4, relief: [-5000, 7000],
    blurb: 'Sulfur plains, vent cones and brimstone lakes, kneaded by Thal\'s tides.' },
  { id: 'marn', name: 'Marn', type: 'moon', parent: 'thal', radius: 3.1e5, surfaceG: 2.9, rotPeriod: 'tidal',
    orbit: [9.0e7, 0.02, 1.8, 60, 0, 0.3], atmo: [38000, 5200, 0.85], atmoColor: [0.62, 0.70, 0.98], oxygen: true,
    color: 0x5d6a66, seed: 818, sciMult: 10, spaceBorder: 1.2e5, relief: [-4500, 8000],
    blurb: 'A cold moon with real air: lichen steppe, frozen mirror lakes, and enough oxygen for jet engines.' },
  { id: 'slate', name: 'Slate', type: 'moon', parent: 'thal', radius: 2.6e5, surfaceG: 1.5, rotPeriod: 'tidal',
    orbit: [2.3e8, 0.03, 3.0, 110, 0, 4.4], color: 0x3c424d, seed: 828, sciMult: 10, spaceBorder: 7e4, relief: [-9000, 8500],
    blurb: 'Dark and ancient: canyon chains and kilometre-high bright fault scarps.' },
  { id: 'nock', name: 'Nock', type: 'moon', parent: 'thal', radius: 8.5e3, surfaceG: 0.05, rotPeriod: 21000,
    orbit: [6.5e8, 0.28, 31, 280, 70, 2.0], color: 0x3a3536, seed: 838, sciMult: 10.5, spaceBorder: 6e3, relief: [-1500, 1500],
    blurb: 'A captured rock on a tilted, lopsided orbit. Docking is a better word than landing.' },
  { id: 'orrin', name: 'Orrin', type: 'planet', parent: 'helion', radius: 4.3e6, surfaceG: 7.2, rotPeriod: 41000,
    orbit: [1.3e11, 0.05, 2.4, 320, 80, 1.2], atmo: [350000, 36000, 2.2], atmoColor: [0.95, 0.84, 0.60], gas: true,
    ring: [1.45, 2.35], color: 0xd9b06a, seed: 909, sciMult: 11, spaceBorder: 1.8e6,
    blurb: 'An amber giant with bright rings, and an ocean moon hidden inside them.' },
  { id: 'brim', name: 'Brim', type: 'moon', parent: 'orrin', radius: 2.4e5, surfaceG: 1.35, rotPeriod: 'tidal',
    orbit: [2.6e7, 0.01, 0.3, 0, 0, 5.0], ocean: true, color: 0xd7e3ea, seed: 919, sciMult: 12, spaceBorder: 6e4, relief: [-600, 1500],
    blurb: 'A cracked shell of ice over a deep ocean. Dark water shows through the open leads.' },
  { id: 'quell', name: 'Quell', type: 'planet', parent: 'helion', radius: 1.4e5, surfaceG: 0.75, rotSync: 'nym',
    orbit: [2.3e11, 0.21, 12, 95, 110, 2.9], color: 0xd8b8a6, seed: 1010, sciMult: 14, spaceBorder: 5e4, relief: [-5000, 7000],
    blurb: 'A far, tilted dwarf world with a pale glacier the size of a continent.' },
  { id: 'nym', name: 'Nym', type: 'moon', parent: 'quell', radius: 5.5e4, surfaceG: 0.2, rotPeriod: 'tidal',
    orbit: [3.2e6, 0, 0, 0, 0, 0.9], color: 0x808086, seed: 1020, sciMult: 14, spaceBorder: 2e4, relief: [-7500, 5000],
    blurb: 'Quell\'s companion. The two keep the same faces turned to each other forever.' },
  { id: 'wend', name: 'Wend', type: 'planet', parent: 'helion', radius: 6.5e3, surfaceG: 0.03, rotPeriod: 14000, comet: true,
    orbit: [4.4e10, 0.70, 24, 300, 40, 0.4], color: 0x2a2928, seed: 1111, sciMult: 13, spaceBorder: 5e3, relief: [-1500, 1500],
    blurb: 'The wanderer: a two-lobed comet that dives past Verda\'s orbit and swings out beyond Thal.' },
];

/** The landing barge: metres east of the pad, deck size, compass heading of its long side, deck height above the sea. */
export const BARGE = { east: 40000, length: 80, width: 50, heading: 90, freeboard: 4 };
function buildSystem() {
  const bodies = [];
  const byId = {};
  for (const def of DEFS) {
    const body = new Body(def, def.parent ? byId[def.parent] : null);
    body.comet = !!def.comet;
    bodies.push(body);
    byId[body.id] = body;
  }
  // mutually locked pairs: the primary turns once per orbit of its companion
  for (const def of DEFS) {
    if (!def.rotSync) continue;
    const b = byId[def.id], m = byId[def.rotSync];
    b.rotPeriod = m.orbit.period;
    b._w = TAU / b.rotPeriod;
    const p = m.orbit.posAt(0, _v);
    b.rot0 = Math.atan2(-p.z, p.x);   // body-fixed +X faces the companion at t = 0
  }
  const home = byId.verda;
  const R = home.radius;
  const site = (east, north, extra) => {
    const lat = north / R, lon = east / R;
    return { lat, lon, dir: home.dirFromLatLon(lat, lon), ...extra };
  };
  // Local frame at the pad: +X east, +Z south. The runway's `lat/lon/dir` is its west threshold; it runs `length`
  // metres due east from there. `start` is where a vessel stands to begin its roll, 100 m in.
  // THESE NUMBERS ARE THE SPACE-CENTRE MODEL'S (js/render/basegfx.js: LAYOUT.runwayX = [−950, 1050], runwayZ = 850,
  // runwayAnchor at x = −850): the strip is drawn there and nowhere else. Round 3: this record said −1500 / 1600 m,
  // so anything placed from it (the demo's runway scene) stood on grass 650 m west of the drawn runway.
  // tests/unit/runway_site.test.js holds the two together.
  const pad = { lat: 0, lon: 0, dir: new Vector3(1, 0, 0), name: 'Starwright Flight Center' };
  const runway = site(-950, -850, { heading: 90, length: 2000, width: 56, name: 'Flight Center Runway' });
  runway.start = site(-850, -850, { heading: 90, name: runway.name });
  runway.center = site(50, -850, {});
  // Where a returning booster is told to land: open level ground 600 m north of the pad, clear of every building
  // (BASE_LAYOUT puts them all south of it). A marked pad and a barge are the next part of docs/BOOSTERS.md.
  const landing = site(0, 600, { name: 'Return Pad', radius: 45 });
  // The landing barge: a steel deck anchored in the ocean east of the pad, under the launch path. It does not move.
  // The deck is solid to the physics (Body.deckAt); the sea bed there is about 470 m down.
  const barge = site(BARGE.east, 0, { name: 'Patient Tide', deck: true });
  {
    const up = barge.dir, east = new Vector3().crossVectors(new Vector3(0, 1, 0), up).normalize(), north = new Vector3().crossVectors(up, east).normalize();
    const hd = (90 - BARGE.heading) * Math.PI / 180;                    // the long side runs along `heading` (90 = east)
    home.decks = [{ site: barge, dir: up, east, north, cosH: Math.cos(hd), sinH: Math.sin(hd), length: BARGE.length, width: BARGE.width,
      top: home.seaLevel + BARGE.freeboard, cosReach: Math.cos(Math.hypot(BARGE.length, BARGE.width) / R) }];
    barge.top = home.decks[0].top; barge.length = BARGE.length; barge.width = BARGE.width; barge.heading = BARGE.heading;
  }
  home.sites = { pad, runway, landing, barge };
  home.launchSite = pad;
  return { bodies, byId, star: byId.helion, home, launchSite: pad, sites: home.sites };
}

export const SYSTEM = buildSystem();
