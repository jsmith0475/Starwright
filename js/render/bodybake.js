// Starwright — baking equirectangular maps of a body (pure maths: runs on the main thread and in workers).
//
//   colour map   rgb = surface colour (sRGB), a = 255 where the surface is liquid water
//   normal map   r, g = terrain slope toward east / north (±1.5 mapped to 0..255), b = height (min..max elevation),
//                a = glow (lava) strength
//   cloud map    r = coverage
// Layout matches THREE.SphereGeometry: u → dir = (−cos 2πu · sin θ, cos θ, sin 2πu · sin θ), row 0 at the north pole.
import { makeNoise } from '../core/noise.js';
import { styleOf, lavaMask } from './worldstyle.js';

const _d = { x: 0, y: 0, z: 0 };
const _rgb = [0, 0, 0];

export function bakeRows(body, w, h, row0, row1) {
  const rows = row1 - row0;
  const color = new Uint8ClampedArray(w * rows * 4), normal = new Uint8ClampedArray(w * rows * 4);
  const R = body.radius, solid = !body.gas && body.type !== 'star';
  const texel = (Math.PI * R) / h, lod = texel * 1.2;
  const lo = body.minElevation, span = (body.maxElevation - lo) || 1;
  const glow = styleOf(body.id).emissive > 0;
  const sea = body.ocean ? body.seaLevel : -Infinity;
  const cosA = new Float64Array(w), sinA = new Float64Array(w);
  for (let x = 0; x < w; x++) { const a = (2 * Math.PI * (x + 0.5)) / w; cosA[x] = Math.cos(a); sinA[x] = Math.sin(a); }
  // heights one row above (north of) each row give the north slope; the next texel east gives the east slope
  let prev = null, cur = new Float32Array(w);
  const heightRow = (row, out) => {
    const th = (Math.PI * (row + 0.5)) / h, st = Math.sin(th), ct = Math.cos(th);
    for (let x = 0; x < w; x++) {
      _d.x = -cosA[x] * st; _d.y = ct; _d.z = sinA[x] * st;
      const hh = body.terrainHeight(_d, lod);
      out[x] = hh < sea ? sea : hh;
    }
    return out;
  };
  if (solid && row0 > 0) prev = heightRow(row0 - 1, new Float32Array(w));
  for (let row = row0; row < row1; row++) {
    const th = (Math.PI * (row + 0.5)) / h, st = Math.sin(th), ct = Math.cos(th);
    if (solid) heightRow(row, cur);
    const ew = texel * Math.max(st, 0.02);              // east–west size of a texel at this latitude
    let o = (row - row0) * w * 4;
    for (let x = 0; x < w; x++, o += 4) {
      _d.x = -cosA[x] * st; _d.y = ct; _d.z = sinA[x] * st;
      const c = body.surfaceColorAt(_d, _rgb);
      const r = c[0], g = c[1], b = c[2];
      color[o] = r * 255; color[o + 1] = g * 255; color[o + 2] = b * 255;
      let water = 0, sx = 0, sy = 0, hh = 0;
      if (solid) {
        hh = cur[x];
        if (hh <= sea) water = 255;
        else {
          // in this layout the next texel (x + 1) lies to the east
          const xe = x === w - 1 ? 0 : x + 1, xw = x === 0 ? w - 1 : x - 1;
          sx = (cur[xe] - cur[xw]) / (2 * ew);
          sy = prev ? (prev[x] - hh) / texel : 0;
        }
      }
      color[o + 3] = water;
      normal[o] = 127.5 + 85 * sx; normal[o + 1] = 127.5 + 85 * sy;
      normal[o + 2] = 255 * (hh - lo) / span;
      normal[o + 3] = glow ? 255 * lavaMask(r, g, b) : 0;
    }
    if (solid) { const t = prev || new Float32Array(w); prev = cur; cur = t; }
  }
  return { color, normal, row0, row1 };
}

/** Cloud coverage rows for a body with a cloud style: Uint8ClampedArray (w × rows), 0 clear … 255 overcast. */
function cloudField(n, st, dx, dy, dz) {
  // weather belts: a wet equator, dry subtropics, stormy mid latitudes
  const belt = 0.1 * Math.cos(dy * 9.5) - 0.06 * dy * dy;
  let px = dx, py = dy, pz = dz;
  if (st.streak) { py *= 1 + 2.2 * st.streak; }     // stretch along latitude circles: banded, wind-drawn decks
  const wx = n.fbm(px * 1.9 + 4, py * 1.9, pz * 1.9, 3), wz = n.fbm(px * 1.9, py * 1.9 + 9, pz * 1.9 + 2, 3);
  px += 0.34 * wx; pz += 0.34 * wz; py += 0.2 * wx;
  const big = n.fbm(px * 2.6, py * 2.6 + 3, pz * 2.6, 4);
  const fine = n.fbm(px * 11, py * 11, pz * 11 + 5, 4);
  return big + 0.42 * fine + belt;
}

const cloudCal = new Map();
/** Threshold and ramp width that give a body the cloud cover its style asks for (measured, not guessed). */
function calibrate(body, st, n) {
  let c = cloudCal.get(body.id);
  if (c) return c;
  const N = 2500, v = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), a = i * 2.399963229728653;
    v[i] = cloudField(n, st, r * Math.cos(a), y, r * Math.sin(a));
  }
  v.sort();
  const q = (f) => v[Math.max(0, Math.min(N - 1, Math.round(f * (N - 1))))];
  const width = Math.max(0.05, 0.75 * (q(0.9) - q(0.1)));
  // the shaders put the cloud edge near a stored density of 0.42
  c = { width, thr: q(1 - Math.min(0.97, st.cover)) - 0.3 * width };
  cloudCal.set(body.id, c);
  return c;
}

export function bakeCloudRows(body, w, h, row0, row1) {
  const st = styleOf(body.id).clouds;
  const out = new Uint8ClampedArray(w * (row1 - row0));
  if (!st) return out;
  const n = bakeCloudRows._n && bakeCloudRows._seed === st.seed ? bakeCloudRows._n : makeNoise(st.seed * 7919 + 13);
  bakeCloudRows._n = n; bakeCloudRows._seed = st.seed;
  const { thr, width } = calibrate(body, st, n);
  for (let row = row0; row < row1; row++) {
    const th = (Math.PI * (row + 0.5)) / h, s = Math.sin(th), y = Math.cos(th);
    let o = (row - row0) * w;
    for (let x = 0; x < w; x++, o++) {
      const a = (2 * Math.PI * (x + 0.5)) / w;
      // stored as a soft density (linear): the shaders shape the edge and add finer structure
      let t = (cloudField(n, st, -Math.cos(a) * s, y, Math.sin(a) * s) - thr) / width + 0.12;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      out[o] = 255 * t;
    }
  }
  return out;
}
