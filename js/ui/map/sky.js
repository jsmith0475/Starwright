// Starwright — map backdrop: a procedural night sky (dust band, faint nebulae, thousands of stars) on the inside of
// a sphere. Baked once into an equirectangular canvas texture and cached for the session.
//
//   createSky() → { mesh, dispose() }      unit sphere; the caller scales it and keeps it centred on the camera
import * as THREE from '../../lib/three.module.min.js';

let cached = null;

function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647 - 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v), w);
}
function fbm(x, y, z, oct) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f, z * f); a *= 0.5; f *= 2.03; }
  return s;
}

function bake() {
  const W = 1024, H = 512;
  const low = document.createElement('canvas'); low.width = W; low.height = H;
  const g = low.getContext('2d');
  const img = g.createImageData(W, H), d = img.data;
  // galactic plane: a tilted great circle
  const nx = 0.36, ny = 0.82, nz = 0.44, nl = Math.hypot(nx, ny, nz);
  const cxp = 0.71, cyp = -0.52, czp = 0.47;         // direction of the bright core (roughly in the plane)
  for (let j = 0; j < H; j++) {
    const lat = (0.5 - (j + 0.5) / H) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < W; i++) {
      const lon = ((i + 0.5) / W) * Math.PI * 2;
      const x = cl * Math.cos(lon), y = sl, z = cl * Math.sin(lon);
      const h = (x * nx + y * ny + z * nz) / nl;       // height above the galactic plane (−1..1)
      const core = Math.max(0, x * cxp + y * cyp + z * czp);
      const n1 = fbm(x * 3.1 + 7, y * 3.1 + 3, z * 3.1 + 11, 5);
      const n2 = fbm(x * 7.3 + 21, y * 7.3 + 5, z * 7.3 + 1, 4);
      const width = 0.16 + 0.1 * core * core;
      let band = Math.exp(-(h * h) / (2 * width * width));
      band *= 0.35 + 0.9 * n1;
      const dust = Math.max(0, 1 - Math.abs(h + (n2 - 0.5) * 0.22) / 0.055) * (0.5 + 0.5 * n2);   // dark lane
      band *= 1 - 0.62 * Math.min(1, dust);
      band *= 0.55 + 0.75 * core * core;
      // far-off nebula patches away from the band
      const neb = Math.pow(Math.max(0, fbm(x * 1.7 + 40, y * 1.7 + 9, z * 1.7 + 2, 4) - 0.52) * 3.2, 2) * (1 - Math.min(1, band));
      const warm = core * core;
      const r = 3 + band * (50 + 64 * warm) + neb * 22;
      const gg = 5 + band * (54 + 36 * warm) + neb * 9;
      const b = 9 + band * (82 - 6 * warm) + neb * 30;
      const grain = (hash3(i, j, 9) - 0.5) * 3;
      const o = (j * W + i) * 4;
      d[o] = Math.max(0, Math.min(255, r + grain)); d[o + 1] = Math.max(0, Math.min(255, gg + grain)); d[o + 2] = Math.max(0, Math.min(255, b + grain)); d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  const c = document.createElement('canvas'); c.width = 2048; c.height = 1024;
  const k = c.getContext('2d');
  k.imageSmoothingEnabled = true; k.imageSmoothingQuality = 'high';
  k.drawImage(low, 0, 0, c.width, c.height);
  // a dusting of very faint, soft specks: at map zoom one texel covers several pixels, so anything brighter would
  // turn into blobs. The crisp stars are real points (planetgfx.createStarfield) drawn over this.
  let seed = 90210;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  k.globalCompositeOperation = 'lighter';
  for (let s = 0; s < 5000; s++) {
    let x, y, z, tries = 0;
    do {
      y = rnd() * 2 - 1; const a = rnd() * Math.PI * 2, q = Math.sqrt(1 - y * y);
      x = q * Math.cos(a); z = q * Math.sin(a);
      const h = (x * nx + y * ny + z * nz) / nl;
      if (rnd() < 0.15 + 0.85 * Math.exp(-(h * h) / 0.04)) break;
    } while (++tries < 5);
    const lat = Math.asin(y), lon = (Math.atan2(z, x) + Math.PI * 2) % (Math.PI * 2);
    const px = lon / (Math.PI * 2) * c.width, py = (0.5 - lat / Math.PI) * c.height;
    const sx = Math.min(5, 1 / Math.max(0.15, Math.cos(lat)));
    k.fillStyle = `rgba(200,215,255,${(0.05 + rnd() * 0.1).toFixed(3)})`;
    k.fillRect(px, py, 0.7 * sx, 0.7);
  }
  k.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  return tex;
}

export function createSky() {
  if (!cached) cached = bake();
  const geo = new THREE.SphereGeometry(1, 48, 24);
  const mat = new THREE.MeshBasicMaterial({ map: cached, side: THREE.BackSide, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'map_sky'; mesh.frustumCulled = false; mesh.renderOrder = -30;
  return { mesh, dispose() { geo.dispose(); mat.dispose(); } };
}
