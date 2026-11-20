// Starwright planet / environment graphics. Everything is procedural (no external assets).
// This file is the public face of the world graphics; the work is done in its neighbours:
//   worlds.js       createWorldRenderer   terrain + ocean + clouds + sky + every body, for the flight scene and hub
//   globe.js        createBodyVisual      a whole body on a unit sphere (map view, tracking station, distant bodies)
//   terrain.js      createTerrain         chunked level-of-detail terrain from Body.terrainHeight
//   sky.js          createStarfield       stars, galactic band, nebulae
//   atmosphere.js   skyColor, skyAt, …    the scattering model (GLSL + the same maths on the CPU)
//   bodytex.js      getBodyMaps, …        baked colour / relief / cloud / ring maps (worker pool)
// Kept from the first release: bakeBodyTexture(Async) (plain colour canvases), createTerrainPatch (the old flat
// ground cap, superseded by createTerrain), createLaunchPad, createFlagMesh.
// All custom shaders include the logarithmic-depth, tone-mapping and colour-space chunks.
import * as THREE from '../lib/three.module.min.js';
import { mergeGeometries, PALETTE as P } from './partmesh.js';

export { createWorldRenderer, createWorldRenderer as createWorldView } from './worlds.js';
export { createBodyVisual } from './globe.js';
export { createTerrain } from './terrain.js';
export { createStarfield } from './sky.js';
export { skyColor, skyAt, sunTransmit, atmoParams, ambientSky } from './atmosphere.js';
export { getBodyMaps, requestBodyMaps } from './bodytex.js';
export { styleOf } from './worldstyle.js';


const _dir = new THREE.Vector3();
const _rgb = [0, 0, 0];

// ---------------------------------------------------------------------------------------------
// Texture baking
// ---------------------------------------------------------------------------------------------
const bakeCache = new Map();      // key → {color: CanvasTexture, rough: CanvasTexture|null}
const bakePending = new Map();    // key → Promise
const keyOf = (body, w, h) => `${body.id}:${w}x${h}`;

function bakeRows(body, w, h, data, rough, row0, row1, cosU, sinU) {
  for (let row = row0; row < row1; row++) {
    const th = (Math.PI * (row + 0.5)) / h, st = Math.sin(th), ct = Math.cos(th);
    let o = row * w * 4;
    for (let x = 0; x < w; x++, o += 4) {
      // matches THREE.SphereGeometry: dir = (−cos(2πu)·sinθ, cosθ, sin(2πu)·sinθ)
      _dir.set(-cosU[x] * st, ct, sinU[x] * st);
      const c = body.surfaceColorAt(_dir, _rgb);
      const r = c[0], g = c[1], b = c[2];
      data[o] = r * 255; data[o + 1] = g * 255; data[o + 2] = b * 255; data[o + 3] = 255;
      if (rough) { // water (blue-dominant) a little glossier; ice a bit too
        const water = b > r * 1.35 && b > g * 1.02;
        rough[o] = 0; rough[o + 1] = water ? 105 : 240; rough[o + 2] = 0; rough[o + 3] = 255;
      }
    }
  }
}
function bakeSetup(body, w, h) {
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d'), img = ctx.createImageData(w, h);
  let rCanvas = null, rCtx = null, rImg = null;
  if (body.ocean) { rCanvas = document.createElement('canvas'); rCanvas.width = w; rCanvas.height = h; rCtx = rCanvas.getContext('2d'); rImg = rCtx.createImageData(w, h); }
  const cosU = new Float64Array(w), sinU = new Float64Array(w);
  for (let x = 0; x < w; x++) { const a = (2 * Math.PI * (x + 0.5)) / w; cosU[x] = Math.cos(a); sinU[x] = Math.sin(a); }
  const finish = () => {
    ctx.putImageData(img, 0, 0);
    const color = new THREE.CanvasTexture(canvas);
    color.colorSpace = THREE.SRGBColorSpace; color.wrapS = THREE.RepeatWrapping; color.anisotropy = 8; color.generateMipmaps = true;
    let rough = null;
    if (rCanvas) { rCtx.putImageData(rImg, 0, 0); rough = new THREE.CanvasTexture(rCanvas); rough.wrapS = THREE.RepeatWrapping; }
    color.userData.roughnessMap = rough;
    return color;
  };
  return { img, rImg, cosU, sinU, finish };
}

/** Synchronous bake (use small sizes; ~1–2 µs per pixel). Result is cached per body+size.
 *  The returned texture's userData.roughnessMap holds a matching roughness map for ocean worlds (else null). */
export function bakeBodyTexture(body, width = 512, height = 256) {
  const key = keyOf(body, width, height);
  if (bakeCache.has(key)) return bakeCache.get(key);
  const s = bakeSetup(body, width, height);
  bakeRows(body, width, height, s.img.data, s.rImg && s.rImg.data, 0, height, s.cosU, s.sinU);
  const tex = s.finish(); bakeCache.set(key, tex);
  return tex;
}

/** Time-sliced bake (8 ms slices, longer only when frames are already slow) so the page stays responsive. onProgress(fraction 0..1). Cached. */
export function bakeBodyTextureAsync(body, width = 2048, height = 1024, onProgress = null) {
  const key = keyOf(body, width, height);
  if (bakeCache.has(key)) { if (onProgress) onProgress(1); return Promise.resolve(bakeCache.get(key)); }
  if (bakePending.has(key)) return bakePending.get(key);
  const p = new Promise(resolve => {
    const s = bakeSetup(body, width, height);
    let row = 0, lastEnd = 0, budget = 8;
    const step = () => {
      const t0 = performance.now();
      // when frames are slow (software GL, heavy scenes) the gaps between slices are long; take bigger
      // slices then, so the bake never costs more than ~30 % extra but still finishes in reasonable time
      if (lastEnd) budget = Math.min(80, Math.max(8, (t0 - lastEnd) * 0.3));
      while (row < height && performance.now() - t0 < budget) { const r1 = Math.min(height, row + 4); bakeRows(body, width, height, s.img.data, s.rImg && s.rImg.data, row, r1, s.cosU, s.sinU); row = r1; }
      lastEnd = performance.now();
      if (onProgress) onProgress(row / height);
      if (row < height) setTimeout(step, 0);
      else { const tex = s.finish(); bakeCache.set(key, tex); bakePending.delete(key); resolve(tex); }
    };
    step();
  });
  bakePending.set(key, p);
  return p;
}
export function clearBakeCache() { for (const t of bakeCache.values()) { if (t.userData.roughnessMap) t.userData.roughnessMap.dispose(); t.dispose(); } bakeCache.clear(); }

// ---------------------------------------------------------------------------------------------
// Terrain patch
// ---------------------------------------------------------------------------------------------
let detailTex = null;
function terrainDetailTexture() {
  if (detailTex) return detailTex;
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
  const img = g.createImageData(s, s), d = img.data;
  let seed = 1234567; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // tileable value noise at two scales + fine grain, mean ≈ 0.5
  const lattice = n => { const a = new Float32Array(n * n); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; };
  const L1 = lattice(8), L2 = lattice(32);
  const samp = (L, n, x, y) => {
    const fx = x * n, fy = y * n, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), i = (a, b) => L[((b % n) + n) % n * n + ((a % n) + n) % n];
    return (i(x0, y0) * (1 - sx) + i(x0 + 1, y0) * sx) * (1 - sy) + (i(x0, y0 + 1) * (1 - sx) + i(x0 + 1, y0 + 1) * sx) * sy;
  };
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    let v = 0.42 * samp(L1, 8, x / s, y / s) + 0.33 * samp(L2, 32, x / s, y / s) + 0.25 * rnd();
    if (rnd() < 0.012) v -= 0.3; else if (rnd() < 0.008) v += 0.3; // pebbles / glints
    const b = Math.max(0, Math.min(255, v * 255)), o = (y * s + x) * 4;
    d[o] = d[o + 1] = d[o + 2] = b; d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  detailTex = new THREE.CanvasTexture(c); detailTex.wrapS = detailTex.wrapT = THREE.RepeatWrapping; detailTex.anisotropy = 8; detailTex.colorSpace = THREE.NoColorSpace;
  return detailTex;
}

/**
 * High-detail ground cap around a point on the surface: a polar grid of ~80 km arc radius whose rings get
 * denser toward the centre. Vertices are in BODY-FIXED axes, relative to the patch centre point on the
 * surface:  vertex = R·dir − R·centerDir  (so the numbers stay small). THE CALLER positions the group at
 * the centre point (bodyCentre + R·centerDir, rotated into its scene frame) and gives it the body's rotation
 * (rotation about +Y by body.rotationAngle(t)) every frame. Call recenter(dir) when the vessel has moved
 * away from the centre (e.g. > 2 km); it rebuilds positions/colours in a few ms.
 * Vertex colours come from body.surfaceColorAt; a tiling grain texture is mapped in local tangent metres.
 * The outermost ring is a skirt dropped below the surface to hide the seam with the coarse globe mesh.
 * DRAW ORDER: the globe from createBodyVisual is coplanar with the patch (z-fighting), so the patch is drawn
 * with depthFunc = Always and renderOrder −4, right after the globe (renderOrder −5) and before everything
 * else (renderOrder ≥ 0): it simply paints over the globe and then writes its own depth. Keep other opaque
 * scene objects at renderOrder > −4, and hide the patch (group.visible = false) when the camera is so far
 * away that the globe alone will do (e.g. altitude > 300 km) or the vessel is in another SOI.
 * @returns {{group, mesh, recenter(dirBodyFixed), centerDir: THREE.Vector3, radius: number}}
 */
export function createTerrainPatch(body, { arcRadius = 80000, rings = 64, segments = 112, innerRadius = 1.5, tile = 6 } = {}) {
  const R = body.radius;
  arcRadius = Math.min(arcRadius, R * 0.6);
  const nV = 1 + (rings + 1) * (segments + 1);
  const pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3), col = new Float32Array(nV * 3), uv = new Float32Array(nV * 2);
  const ringS = new Float64Array(rings + 1);
  const grow = Math.pow(arcRadius / innerRadius, 1 / (rings - 1));
  for (let i = 0; i < rings; i++) ringS[i] = innerRadius * Math.pow(grow, i);
  ringS[rings] = arcRadius; // skirt
  const cosA = new Float64Array(segments + 1), sinA = new Float64Array(segments + 1);
  for (let j = 0; j <= segments; j++) { const a = (j / segments) * Math.PI * 2; cosA[j] = Math.cos(a); sinA[j] = Math.sin(a); }
  // uv = local tangent metres / tile (constant topology → fill once)
  for (let i = 0; i <= rings; i++) for (let j = 0; j <= segments; j++) { const k = 1 + i * (segments + 1) + j; uv[k * 2] = (ringS[i] * cosA[j]) / tile; uv[k * 2 + 1] = (ringS[i] * sinA[j]) / tile; }
  const idx = [];
  for (let j = 0; j < segments; j++) idx.push(0, 1 + j, 1 + j + 1);
  for (let i = 0; i < rings; i++) for (let j = 0; j < segments; j++) {
    const a = 1 + i * (segments + 1) + j, b = a + 1, c = a + (segments + 1), d = c + 1;
    idx.push(a, c, d, a, d, b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, map: terrainDetailTexture(), roughness: 0.96, metalness: 0, depthFunc: THREE.AlwaysDepth });
  material.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        float d1 = texture2D(map, vMapUv).g, d2 = texture2D(map, mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.0613).g, d3 = texture2D(map, mat2(0.28, 0.96, -0.96, 0.28) * vMapUv * 0.00371).g;
        diffuseColor.rgb *= (0.62 + 0.76 * d1) * (0.7 + 0.6 * d2) * (0.78 + 0.44 * d3);
      #endif`);
  };
  material.customProgramCacheKey = () => 'sw-terrain';
  const mesh = new THREE.Mesh(geo, material); mesh.name = 'terrainPatch'; mesh.frustumCulled = false; mesh.renderOrder = -4; mesh.receiveShadow = true;
  const group = new THREE.Group(); group.name = 'terrain_' + body.id; group.add(mesh);

  const centerDir = new THREE.Vector3(1, 0, 0), E = new THREE.Vector3(), N = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const c3 = new THREE.Color();
  const skirt = Math.max(R * 0.0012, 150);
  function recenter(dirBodyFixed) {
    centerDir.copy(dirBodyFixed).normalize();
    const C = centerDir;
    E.crossVectors(Y, C); if (E.lengthSq() < 1e-10) E.set(1, 0, 0); E.normalize();   // east
    N.crossVectors(C, E).normalize();                                                // north
    const put = (k, dx, dy, dz, px, py, pz) => {
      pos[k * 3] = px; pos[k * 3 + 1] = py; pos[k * 3 + 2] = pz; nor[k * 3] = dx; nor[k * 3 + 1] = dy; nor[k * 3 + 2] = dz;
      const c = body.surfaceColorAt(_dir.set(dx, dy, dz), _rgb);
      c3.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
      col[k * 3] = c3.r; col[k * 3 + 1] = c3.g; col[k * 3 + 2] = c3.b;
    };
    put(0, C.x, C.y, C.z, 0, 0, 0);
    for (let i = 0; i <= rings; i++) {
      const ang = ringS[Math.min(i, rings)] / R, sn = Math.sin(ang), hv = Math.sin(ang / 2), cm1 = -2 * hv * hv; // cos−1, precise
      const drop = i === rings ? skirt : 0;
      for (let j = 0; j <= segments; j++) {
        const tx = E.x * cosA[j] + N.x * sinA[j], ty = E.y * cosA[j] + N.y * sinA[j], tz = E.z * cosA[j] + N.z * sinA[j];
        const dx = C.x * (1 + cm1) + tx * sn, dy = C.y * (1 + cm1) + ty * sn, dz = C.z * (1 + cm1) + tz * sn;
        put(1 + i * (segments + 1) + j, dx, dy, dz, R * (C.x * cm1 + tx * sn) - dx * drop, R * (C.y * cm1 + ty * sn) - dy * drop, R * (C.z * cm1 + tz * sn) - dz * drop);
      }
    }
    geo.attributes.position.needsUpdate = true; geo.attributes.normal.needsUpdate = true; geo.attributes.color.needsUpdate = true;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), arcRadius * 1.1);
  }
  recenter(centerDir);
  return { group, mesh, recenter, centerDir, radius: arcRadius, east: E, north: N };
}

// ---------------------------------------------------------------------------------------------
// Launch pad
// ---------------------------------------------------------------------------------------------
const Mx = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

/**
 * The Starwright Flight Center launch complex. Origin at ground level directly under the rocket, +Y up.
 * Layout (metres): service tower at +X 12 (nearest steel at x ≈ 6.4 for the two swing-arm tips, tower
 * face at x ≈ 10.2), flame channel runs toward −Z, crawler road and assembly hall toward +Z.
 * The pad deck top is at y = +0.04 (painted markings up to +0.07) so it does not z-fight with the ground.
 * Two draw calls (lit vertex-coloured geometry + unlit lamps). Caller orients it to the local surface frame.
 */
export function createLaunchPad() {
  const lit = [], lamp = [];
  const add = (geo, color, m, list = lit) => list.push({ geo, color, m });
  const box = (w, h, d, color, x, y, z, ry = 0, list = lit) => add(new THREE.BoxGeometry(w, h, d), color, Mx(x, y, z, 0, ry), list);
  const beam = (a, b, th, color) => { // box beam between two points
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), len = d.length();
    lit.push({ geo: new THREE.BoxGeometry(th, len, th), color, m: new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()), new THREE.Vector3(1, 1, 1)) });
  };
  const concrete = 0xbdb9ae, concreteDark = 0x9a968c, scorch = 0x3a3632, white = P.white, teal = P.teal, amber = P.amber;

  // --- pad deck: octagon, 40 m across flats
  const Rpad = 20 / Math.cos(Math.PI / 8);
  add(new THREE.CylinderGeometry(Rpad, Rpad + 1.2, 0.6, 8), concrete, Mx(0, -0.26, 0, 0, Math.PI / 8));
  add(new THREE.RingGeometry(Rpad - 1.6, Rpad - 0.9, 8), amber, Mx(0, 0.055, 0, -Math.PI / 2, 0, Math.PI / 8));
  add(new THREE.RingGeometry(8.2, 8.9, 48), teal, Mx(0, 0.055, 0, -Math.PI / 2));
  add(new THREE.RingGeometry(12.6, 12.85, 48), white, Mx(0, 0.055, 0, -Math.PI / 2));
  add(new THREE.CircleGeometry(4.6, 8), scorch, Mx(0, 0.06, 0, -Math.PI / 2, 0, Math.PI / 8)); // blast grate
  for (let i = -3; i <= 3; i++) box(8.4, 0.03, 0.14, 0x5b5852, 0, 0.075, i * 1.15);
  for (let i = 0; i < 8; i++) { // amber approach chevrons pointing at the centre
    const a = i * Math.PI / 4 + Math.PI / 8; if (Math.abs(Math.sin(a)) > 0.9 && Math.cos(a) < 0.5 && Math.sin(a) < 0) continue;
    const sh = new THREE.Shape(); sh.moveTo(0, -1.4); sh.lineTo(1.1, 0.6); sh.lineTo(0.45, 0.6); sh.lineTo(0, -0.3); sh.lineTo(-0.45, 0.6); sh.lineTo(-1.1, 0.6); sh.closePath();
    add(new THREE.ShapeGeometry(sh), amber, Mx(Math.cos(a) * 15.3, 0.057, Math.sin(a) * 15.3, -Math.PI / 2, 0, -a + Math.PI / 2));
  }
  // --- flame channel toward −Z with low walls and a deflector ramp
  add(new THREE.PlaneGeometry(6.4, 19), scorch, Mx(0, 0.058, -13.6, -Math.PI / 2));
  for (const s of [-1, 1]) { box(0.7, 1.0, 17.5, concreteDark, s * 3.6, 0.5, -13.2); for (let i = 0; i < 4; i++) box(0.74, 0.25, 1.2, i % 2 ? amber : 0x26282c, s * 3.6, 1.0, -6.4 - i * 4.4); }
  add(new THREE.BoxGeometry(8.4, 0.5, 9), 0x4a4640, Mx(0, 1.55, -25.5, 0.36));
  box(0.7, 3.2, 8.5, concreteDark, -4.2, 1.2, -25.6); box(0.7, 3.2, 8.5, concreteDark, 4.2, 1.2, -25.6); box(9.1, 3.6, 0.7, concreteDark, 0, 1.4, -30);
  // --- lattice service tower, 35 m, centred 12 m to +X
  const tx = 12, hw = 1.75, H = 35, lv = 7;
  box(5.4, 0.5, 5.4, concreteDark, tx, 0.25, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) beam([tx + sx * hw, 0.3, sz * hw], [tx + sx * hw, H, sz * hw], 0.3, white);
  for (let i = 0; i <= lv; i++) {
    const y = 0.5 + (i * (H - 0.5)) / lv, c = i % 2 ? amber : white;
    for (const s of [-1, 1]) { beam([tx - hw, y, s * hw], [tx + hw, y, s * hw], 0.2, c); beam([tx + s * hw, y, -hw], [tx + s * hw, y, hw], 0.2, c); }
    if (i < lv) {
      const y2 = 0.5 + ((i + 1) * (H - 0.5)) / lv, f = i % 2 ? 1 : -1;
      for (const s of [-1, 1]) { beam([tx - f * hw, y, s * hw], [tx + f * hw, y2, s * hw], 0.13, 0xd9dee2); beam([tx + s * hw, y, -f * hw], [tx + s * hw, y2, f * hw], 0.13, 0xd9dee2); }
    }
  }
  box(1.5, H - 1, 1.5, 0x55606c, tx + 0.2, H / 2, 0); // lift shaft
  box(1.2, 2.2, 1.2, teal, tx + 0.2, 9, 0.2);         // lift car peeking out
  box(4.6, 0.25, 4.6, concreteDark, tx, H + 0.12, 0);
  box(3.0, 2.6, 3.0, teal, tx, H + 1.55, 0); box(3.3, 0.3, 3.3, white, tx, H + 3.0, 0); box(2.6, 0.9, 0.08, 0x18303a, tx - 1.52, H + 1.8, 0, 0);
  beam([tx, H + 3, 0], [tx, H + 9.5, 0], 0.14, 0xd9dee2);
  add(new THREE.SphereGeometry(0.34, 10, 8), 0xffa028, Mx(tx, H + 9.7, 0), lamp);
  for (const [y, len] of [[11.5, 4.6], [23.5, 4.6]]) { // swing arms toward the rocket (tips at x ≈ 6.4)
    const x0 = tx - hw, x1 = x0 - len;
    for (const s of [-1, 1]) { beam([x0, y, s * 0.5], [x1, y, s * 0.5], 0.16, white); beam([x0, y + 1, s * 0.5], [x1, y + 1, s * 0.5], 0.16, white); }
    for (let k = 0; k <= 4; k++) { const x = x0 - (len * k) / 4; beam([x, y, -0.5], [x, y + 1, -0.5], 0.1, white); beam([x, y, 0.5], [x, y + 1, 0.5], 0.1, white); beam([x, y, -0.5], [x, y, 0.5], 0.1, white); if (k < 4) beam([x, y, 0.5], [x - len / 4, y + 1, 0.5], 0.08, 0xd9dee2); }
    box(0.5, 1.5, 1.5, amber, x1 - 0.1, y + 0.5, 0); box(0.52, 0.3, 1.52, 0x26282c, x1 - 0.1, y + 0.5, 0);
    beam([x0, y + 1, 0], [x0 + 0.1, y + 5, 0], 0.09, 0xd9dee2); beam([x0 + 0.1, y + 5, 0], [x1 + 0.6, y + 1, 0], 0.07, 0xd9dee2);
  }
  // --- crawler road toward +Z and the assembly hall at its end
  for (const s of [-1, 1]) add(new THREE.PlaneGeometry(4.2, 96), 0x8f8674, Mx(s * 4.4, 0.03, 20.5 + 48, -Math.PI / 2));
  add(new THREE.PlaneGeometry(4.2, 96), 0x6f7a55, Mx(0, 0.02, 68.5, -Math.PI / 2));
  for (let i = 0; i < 12; i++) for (const s of [-1, 1]) box(0.4, 0.05, 2.4, white, s * 7, 0.04, 26 + i * 8);
  const hz = 140;
  box(30, 34, 28, white, 0, 17, hz); box(30.3, 3, 28.3, teal, 0, 30, hz); box(31, 1, 29, 0xd3d9de, 0, 34.5, hz);
  box(11, 27, 0.5, 0x3d4652, 0, 13.5, hz - 14.1); for (let i = 1; i < 6; i++) box(11, 0.25, 0.6, 0x566170, 0, i * 4.5, hz - 14.15);
  box(14, 8, 16, P.cream, 23, 4, hz + 2); box(14.3, 0.8, 16.3, amber, 23, 8.2, hz + 2);
  { // emblem on the hall: amber disc with a teal four-point star
    add(new THREE.CircleGeometry(3.2, 32), amber, Mx(-9.5, 26, hz - 14.06, 0, Math.PI));
    add(new THREE.ShapeGeometry(starShape(2.6, 0.9)), teal, Mx(-9.5, 26, hz - 14.12, 0, Math.PI));
  }
  // --- control bunker, tank farm, water tower
  box(16, 4, 9, P.cream, -46, 2, 34, 0.5); box(16.4, 0.6, 9.4, teal, -46, 4.2, 34, 0.5); box(12, 1.2, 9.1, 0x1d2a33, -46, 2.6, 34, 0.5);
  add(new THREE.CylinderGeometry(0.1, 0.1, 7, 6), 0xd9dee2, Mx(-50, 7.5, 38));
  add(new THREE.SphereGeometry(2.2, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), white, Mx(-43, 4.3, 31, 0.5, 0, 0.35));
  for (const [x, z] of [[-40, -24], [-51, -27]]) {
    add(new THREE.SphereGeometry(4.2, 20, 14), white, Mx(x, 6.4, z));
    add(new THREE.CylinderGeometry(4.25, 4.25, 0.9, 20, 1, true), teal, Mx(x, 6.4, z));
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.4; beam([x + Math.cos(a) * 3.2, 0, z + Math.sin(a) * 3.2], [x + Math.cos(a) * 3.6, 6, z + Math.sin(a) * 3.6], 0.3, 0x8a929c); }
  }
  for (let i = 0; i < 3; i++) { add(new THREE.CylinderGeometry(1.6, 1.6, 9, 14), P.cream, Mx(-34 - i * 0.2, 4.5, -40 - i * 4.2)); add(new THREE.SphereGeometry(1.6, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), amber, Mx(-34 - i * 0.2, 9, -40 - i * 4.2, 0, 0, 0, 1, 0.6, 1)); }
  beam([-36, 1.2, -24], [-22, 1.2, -19], 0.35, 0x8a929c); beam([-22, 1.2, -19], [-22, 0, -19], 0.35, 0x8a929c); // feed pipe
  { const x = 40, z = -38; add(new THREE.CylinderGeometry(3.4, 2.4, 4, 14), white, Mx(x, 17, z)); add(new THREE.SphereGeometry(3.4, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), amber, Mx(x, 19, z, 0, 0, 0, 1, 0.55, 1)); add(new THREE.CylinderGeometry(3.45, 3.45, 0.7, 14, 1, true), teal, Mx(x, 18.2, z));
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.78; beam([x + Math.cos(a) * 3.4, 0, z + Math.sin(a) * 3.4], [x + Math.cos(a) * 2.0, 15.2, z + Math.sin(a) * 2.0], 0.3, 0x8a929c); } beam([x, 0, z], [x, 15, z], 0.5, 0x8a929c); }
  // --- floodlight masts
  for (const [x, z] of [[27, 27], [-27, 27], [27, -27], [-27, -27]]) {
    beam([x, 0, z], [x, 24, z], 0.35, 0x8a929c); box(1.2, 0.4, 1.2, concreteDark, x, 0.2, z);
    const head = Mx(x, 24.6, z, 0, Math.atan2(-x, -z)).multiply(Mx(0, 0, 0, 0.45));
    add(new THREE.BoxGeometry(3.4, 1.5, 0.5), 0x2b3038, head);
    for (let i = -1; i <= 1; i++) for (let j = 0; j < 2; j++) add(new THREE.CircleGeometry(0.36, 10), 0xfff3c4, head.clone().multiply(Mx(i * 1.05, -0.33 + j * 0.66, 0.27)), lamp);
  }
  const g = new THREE.Group(); g.name = 'launchPad';
  const m1 = new THREE.Mesh(mergeGeometries(lit), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.02, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  const m2 = new THREE.Mesh(mergeGeometries(lamp), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  m1.name = 'padStructures'; m2.name = 'padLamps'; m1.receiveShadow = true; m1.castShadow = true;
  g.add(m1, m2);
  return g;
}

function starShape(R, r) {
  const s = new THREE.Shape();
  for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4 + Math.PI / 2, rad = i % 2 ? r * 0.55 : R; if (i === 0) s.moveTo(Math.cos(a) * rad, Math.sin(a) * rad); else s.lineTo(Math.cos(a) * rad, Math.sin(a) * rad); }
  s.closePath(); return s;
}

// ---------------------------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------------------------
let flagTex = null;
/** A small planted flag (pole 1.7 m, cloth 0.75 × 0.5 m): amber field with a teal four-point star.
 *  Origin at the base of the pole on the ground, +Y up, cloth flies toward +X.
 *  userData.update(t) gives the cloth a gentle ripple (optional). */
export function createFlagMesh() {
  if (!flagTex) {
    const c = document.createElement('canvas'); c.width = 192; c.height = 128; const g = c.getContext('2d');
    g.fillStyle = '#ffb347'; g.fillRect(0, 0, 192, 128);
    g.fillStyle = '#f09a2a'; g.fillRect(0, 104, 192, 24); g.fillStyle = '#fff1d6'; g.fillRect(0, 100, 192, 5);
    g.translate(96, 54);
    const star = (R, r, fill) => { g.fillStyle = fill; g.beginPath(); for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4 - Math.PI / 2, rad = i % 2 ? r : R; g.lineTo(Math.cos(a) * rad, Math.sin(a) * rad); } g.closePath(); g.fill(); };
    star(46, 13, '#14756d'); star(40, 10, '#39d0c0'); star(16, 5, '#eafffb');
    flagTex = new THREE.CanvasTexture(c); flagTex.colorSpace = THREE.SRGBColorSpace;
  }
  const g = new THREE.Group(); g.name = 'flag';
  const pole = new THREE.Mesh(mergeGeometries([
    { geo: new THREE.CylinderGeometry(0.018, 0.022, 1.7, 8), color: 0xd9dee2, m: Mx(0, 0.85, 0) },
    { geo: new THREE.SphereGeometry(0.04, 10, 8), color: P.teal, m: Mx(0, 1.72, 0) },
    { geo: new THREE.CylinderGeometry(0.06, 0.09, 0.05, 10), color: 0x8a929c, m: Mx(0, 0.025, 0) },
  ]), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 }));
  const W = 0.75, Hh = 0.5, geo = new THREE.PlaneGeometry(W, Hh, 12, 4); geo.translate(W / 2 + 0.02, 1.7 - Hh / 2 - 0.03, 0);
  const base = geo.attributes.position.array.slice();
  const cloth = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: flagTex, side: THREE.DoubleSide, roughness: 0.85 }));
  cloth.name = 'cloth';
  const ripple = t => {
    const p = geo.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) { const x = base[i]; p[i + 2] = Math.sin(x * 9 - t * 5) * 0.035 * (x / W) + Math.sin(x * 4 + base[i + 1] * 3 - t * 3) * 0.02 * (x / W); }
    geo.attributes.position.needsUpdate = true; geo.computeVertexNormals();
  };
  ripple(0);
  g.add(pole, cloth); g.userData.update = ripple;
  return g;
}
