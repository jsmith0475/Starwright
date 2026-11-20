// Starwright — the outdoor setting of the Flight Center: local ground, ocean, sky, clouds, moons and the
// sun / sky light rig. Self-contained (no dependency on the planet terrain), used by the hub and title views.
//
//   skyAt(ut)                    → { sunDir, moons: [{ id, body, dir, angular }], timeOfDay }   local frame, from game time
//   localGroundHeight(x, z)      → metres; 0 on the plain around the base, negative under the sea
//   createLocalGround({quality}) → { group, update(dt, env), dispose() }
//   createSkyRig({quality})      → { group, sun, hemi, update(camera, dt, sky, focus, extent), bakeEnvironment(renderer) → texture | null,
//                                    state: { fog: Color, night, day, sunColor }, dispose() }
//
// Local frame = the base frame of js/render/basegfx.js: +X east, +Y up, +Z south, origin at the pad.
// Imports only three.js, basegfx and the core body data, so the game shell never depends on the planet renderer.
import * as THREE from '../lib/three.module.min.js';
import { SYSTEM } from '../core/bodies.js';
import { makeNoise, normalFromHeight, BASE_LAYOUT } from './basegfx.js';

const TAU = Math.PI * 2;
const SEA_LEVEL = -3;      // = SYSTEM.home.seaLevel in js/core/bodies.js: the same shoreline as the flight scene's terrain
/** The hub draws its sky as if the base sat at this latitude (rad, north): the noon sun then stands off the
 *  zenith and buildings throw readable shadows. Day and night still follow the game clock exactly. */
export const SKY_TILT = 0.5;

const smooth = THREE.MathUtils.smoothstep, lerp = THREE.MathUtils.lerp, clamp = THREE.MathUtils.clamp;

// ---------------------------------------------------------------------------------------------
// Sun and moons from game time
// ---------------------------------------------------------------------------------------------
const _up = new THREE.Vector3(), _east = new THREE.Vector3(), _north = new THREE.Vector3(), _v = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0);
export function skyAt(ut = 0) {
  const home = SYSTEM.home, site = SYSTEM.launchSite;
  home.surfaceDirToInertial(site.dir, ut, _up).normalize();
  _east.crossVectors(_Y, _up).normalize(); _north.crossVectors(_up, _east);
  const cs = Math.cos(SKY_TILT), sn = Math.sin(SKY_TILT);
  const toLocal = v => { const x = v.dot(_east), y = v.dot(_up), z = -v.dot(_north); return new THREE.Vector3(x, y * cs - z * sn, y * sn + z * cs).normalize(); };
  const sunInertial = home.globalPosAt(ut, new THREE.Vector3()).multiplyScalar(-1).normalize();
  const raw = { x: sunInertial.dot(_east), y: sunInertial.dot(_up) };
  const sunDir = toLocal(sunInertial);
  const moons = home.children.map(body => {
    const rel = body.posAt(ut, new THREE.Vector3()).addScaledVector(_up, -home.radius), dist = rel.length();
    return { id: body.id, body, dir: toLocal(_v.copy(rel).normalize()), angular: body.radius / dist };
  });
  // 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset
  const timeOfDay = ((0.5 - Math.atan2(raw.x, raw.y) / TAU) % 1 + 1) % 1;
  return { sunDir, moons, timeOfDay };
}

// ---------------------------------------------------------------------------------------------
// Local ground
// ---------------------------------------------------------------------------------------------
const gn = makeNoise(5), gn2 = makeNoise(61);
function fbm(n, x, y, oct) { let s = 0, a = 0.5, f = 1, t = 0; for (let i = 0; i < oct; i++) { s += a * n(x * f, y * f, 64); t += a; a *= 0.5; f *= 2; } return s / t; }
function coastX(z) { return 2440 + 250 * Math.sin(z / 1700 + 0.6) + 420 * (fbm(gn, z / 6000 + 9, 0.37, 3) - 0.5) - Math.max(0, -z - 5200) * 0.42 - Math.max(0, z - 6800) * 0.3 + 520 * Math.exp(-((z - 3900) ** 2) / 1.4e6); }
export function localGroundHeight(x, z) {
  const s = x - coastX(z);                                    // > 0: out to sea
  const d = Math.hypot(x, z), flat = smooth(d, 3050, 5800), inland = smooth(-x, -1500, 15000), shore = smooth(-s, 0, 900);
  const ridge = 1 - Math.abs(fbm(gn2, x / 7000 + 5, z / 7000 + 2, 4) * 2 - 1);
  let h = flat * shore * (60 + 1250 * inland) * Math.pow(fbm(gn, x / 9000 + 7, z / 9000 + 3, 5), 1.7) * (0.55 + 0.9 * ridge * ridge);
  // an island offshore
  h += 150 * Math.exp(-(((x - 6200) ** 2) + ((z + 2600) ** 2)) / 9e5) * (0.6 + 0.8 * fbm(gn, x / 900, z / 900, 3));
  if (s > -90) h -= Math.min(46, (s + 90) * 0.042 + Math.max(0, s - 200) * 0.02);
  return h;
}

let GTEX = null;
function groundTextures() {
  if (GTEX) return GTEX;
  const n1 = makeNoise(17), n2 = makeNoise(43), n3 = makeNoise(71), n4 = makeNoise(97);
  const mk = (S, fn) => { const c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d'), img = g.createImageData(S, S), d = img.data; for (let y = 0, o = 0; y < S; y++) for (let x = 0; x < S; x++, o += 4) { const v = fn(x / S, y / S); d[o] = v[0]; d[o + 1] = v[1]; d[o + 2] = v[2]; d[o + 3] = v.length > 3 ? v[3] : 255; } g.putImageData(img, 0, 0); return c; };
  const f = (n, u, v, base, oct) => { let s = 0, a = 0.5, fr = base, t = 0; for (let i = 0; i < oct; i++) { s += a * n(u * fr, v * fr, fr); t += a; a *= 0.5; fr *= 2; } return s / t; };
  let seed = 9; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // turf seen from standing height: thousands of blades of many greens over a darker thatch (tiles; ~4 m across)
  const S = 512, grassC = mk(S, (u, v) => { const a = f(n1, u, v, 8, 4), k = 0.62 + 0.3 * a; return [70 * k, 92 * k, 44 * k]; });
  { const g = grassC.getContext('2d'); g.lineCap = 'round';
    for (let i = 0; i < 15000; i++) {
      const x = rnd() * S, y = rnd() * S, a = -Math.PI / 2 + (rnd() - 0.5) * 2.2, l = 4 + rnd() * 11, k = 0.6 + 0.75 * rnd(), dry = rnd() < 0.1 ? 1 : 0;
      g.strokeStyle = `rgba(${(76 + 44 * dry + 16 * rnd()) * k | 0},${(104 + 6 * dry) * k | 0},${(46 - 6 * dry + 10 * rnd()) * k | 0},0.9)`; g.lineWidth = 0.8 + rnd() * 1.3;
      for (const ox of x < 16 ? [0, S] : x > S - 16 ? [0, -S] : [0]) for (const oy of y < 16 ? [0, S] : y > S - 16 ? [0, -S] : [0]) { g.beginPath(); g.moveTo(x + ox, y + oy); g.lineTo(x + ox + Math.cos(a) * l, y + oy + Math.sin(a) * l); g.stroke(); }
    } }
  // bare earth with grit and small stones
  const dirtC = mk(256, (u, v) => { const a = f(n2, u, v, 4, 5), b = n3(u * 64, v * 64, 64), st = Math.max(0, f(n4, u, v, 32, 2) - 0.62) * 5, k = 0.62 + 0.5 * a + (b - 0.5) * 0.22; return [(128 + 60 * st) * k, (104 + 62 * st) * k, (78 + 66 * st) * k]; });
  // four independent smooth fields for blending (r, g, b, a)
  const noiseC = mk(256, (u, v) => [255 * f(n1, u, v, 4, 5), 255 * f(n2, u, v, 4, 5), 255 * f(n3, u, v, 4, 5), 255 * f(n4, u, v, 4, 5)]);
  const grassH = mk(256, (u, v) => { const a = f(n1, u, v, 8, 4) * 255; return [a, a, a]; });
  const waterH = mk(256, (u, v) => { const a = (f(n1, u, v, 4, 5) * 0.6 + (1 - Math.abs(f(n2, u, v, 8, 3) * 2 - 1)) * 0.4) * 255; return [a, a, a]; });
  const T = t => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; return t; };
  const grass = T(new THREE.CanvasTexture(grassC)); grass.colorSpace = THREE.SRGBColorSpace;
  const dirt = T(new THREE.CanvasTexture(dirtC)); dirt.colorSpace = THREE.SRGBColorSpace;
  // (the noise must keep its alpha channel as data: build it from raw pixels, not through the canvas' premultiplied store)
  const nd = noiseC.getContext('2d').getImageData(0, 0, 256, 256).data, noise = T(new THREE.DataTexture(new Uint8Array(nd), 256, 256, THREE.RGBAFormat)); noise.minFilter = THREE.LinearMipmapLinearFilter; noise.magFilter = THREE.LinearFilter; noise.generateMipmaps = true; noise.needsUpdate = true;
  GTEX = { grass, dirt, noise, grassN: T(new THREE.CanvasTexture(normalFromHeight(grassH, 1.6))), waterN: T(new THREE.CanvasTexture(normalFromHeight(waterH, 2.4))) };
  return GTEX;
}

// The ground's surface: the vertex colour says what grows where at the scale of the map; the shader lays the
// turf on it. Three scales of smooth noise, turned against each other so they never line up, drift the grass
// between lush, plain and dry, and open patches of bare earth; the turf texture is sampled finely near the camera
// and coarsely far away, so no repeat is ever in view. Where the paved mask says "edge of a road or slab" the
// grass wears away to grit.
const GROUND_FS_HEAD = /* glsl */`uniform sampler2D uDirt, uNoise, uPaved; uniform vec4 uPavedRect; uniform float uPavedOn; varying vec2 vGW;\n`;
const GROUND_FS = /* glsl */`
  {
    float gd = length(vViewPosition), nearK = 1.0 - smoothstep(40.0, 240.0, gd), fineK = 1.0 - smoothstep(8.0, 60.0, gd);
    const mat2 R1 = mat2(0.8, -0.6, 0.6, 0.8), R2 = mat2(0.6, 0.8, -0.8, 0.6);
    vec4 nA = texture2D(uNoise, vGW / 520.0), nB = texture2D(uNoise, R1 * vGW / 83.0 + 0.37), nC = texture2D(uNoise, R2 * vGW / 13.7 + 0.11);
    float macro = nA.r * 0.5 + nB.g * 0.33 + nC.b * 0.17;
    vec3 tFine = texture2D(map, vGW / 3.7).rgb, tMid = texture2D(map, R1 * vGW / 14.3).rgb, tFar = texture2D(map, R2 * vGW / 61.0).rgb;
    vec3 turf = mix(tFar, mix(tMid, tFine, fineK), nearK) / vec3(0.052, 0.094, 0.021);      // ÷ the texture's mean: a multiplier round 1
    turf = mix(vec3(1.0), turf, 0.7 + 0.3 * nearK);       // the blades' light and dark stay visible from far off (coarser samples there)
    float veg = smoothstep(1.02, 1.3, vColor.g / max(vColor.r, 0.004)) * smoothstep(0.0, 0.03, vColor.g - vColor.b);
    // lush where the ground holds water, straw-coloured where it does not
    float dryK = smoothstep(0.47, 0.6, macro), lushK = 1.0 - smoothstep(0.36, 0.48, macro);
    vec3 tone = mix(vec3(1.0), vec3(1.42, 1.22, 0.84), dryK * 0.8) * mix(vec3(1.0), vec3(0.68, 0.82, 0.7), lushK * 0.85);
    // the lie of the land at the scale of the whole centre: meadow gone to seed, damp hollows, worn tracks
    vec4 nM = texture2D(uNoise, R2 * vGW / 1700.0 + 0.61), nT = texture2D(uNoise, R1 * vGW / 240.0 + 0.23);
    float meadow = smoothstep(0.5, 0.62, nM.r * 0.6 + nT.g * 0.4), damp = smoothstep(0.52, 0.66, nM.g * 0.55 + nA.a * 0.45);
    tone *= mix(vec3(1.0), vec3(1.26, 1.2, 0.8), meadow * 0.7) * mix(vec3(1.0), vec3(0.62, 0.74, 0.66), damp * 0.75);
    float track = 1.0 - smoothstep(0.004, 0.014, abs(nT.b * 0.6 + nM.a * 0.4 - 0.5));
    tone *= 0.9 + 0.2 * nC.a;
    float mown = 0.0, verge = 0.0;
    if (uPavedOn > 0.5) {
      vec2 puv = (vGW - uPavedRect.xy) * uPavedRect.zw;
      if (puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0) {
        // kept grass beside the runway and the roads: shorter, even, in mowing stripes; then a worn verge at the kerb
        mown = smoothstep(0.02, 0.16, textureLod(uPaved, puv, 5.0).r);
        verge = smoothstep(0.2, 0.62, textureLod(uPaved, puv, 2.2).r);
      }
    }
    float stripe = step(0.5, fract(dot(vGW, vec2(0.6, 0.8)) / 11.0));
    tone = mix(tone, vec3(1.06, 1.08, 0.94) * (0.95 + 0.1 * stripe), mown * 0.8);
    diffuseColor.rgb *= mix(vec3(1.0), turf * tone, veg);
    float bare = smoothstep(0.585, 0.66, nB.a * 0.55 + nC.r * 0.3 + nA.b * 0.15) * veg * (0.35 + 0.65 * nearK) * (1.0 - mown);
    bare = max(bare, max(track * 0.95 * (1.0 - mown), verge * (0.35 + 0.5 * nC.g)) * veg);
    if (uPavedOn > 0.5) {
      float pv = texture2D(uPaved, (vGW - uPavedRect.xy) * uPavedRect.zw).r;
      bare = max(bare, smoothstep(0.02, 0.3, pv) * (0.55 + 0.45 * nC.g));
    }
    vec3 earth = mix(texture2D(uDirt, R1 * vGW / 19.0).rgb, texture2D(uDirt, vGW / 4.3).rgb, nearK) * (0.8 + 0.4 * nB.r);
    diffuseColor.rgb = mix(diffuseColor.rgb, earth, bare);
  }`;

export function createLocalGround({ quality = 'high' } = {}) {
  const T = groundTextures(), group = new THREE.Group(); group.name = 'localGround';
  // polar grid: 40 m rings near the base, growing geometrically to the horizon
  const radii = [0]; let r = 0;
  while (r < 2200) { r += 40; radii.push(r); }
  while (r < 46000) { r *= 1.085; radii.push(r); }
  const SEG = quality === 'low' ? 96 : 160, NR = radii.length, cx0 = 40, cz0 = 380;
  const pos = new Float32Array(NR * (SEG + 1) * 3), col = new Float32Array(NR * (SEG + 1) * 3), uv = new Float32Array(NR * (SEG + 1) * 2);
  const c = new THREE.Color(), c2 = new THREE.Color();
  // (display colours of each cover; the turf shader multiplies the grassy ones by a value round 1)
  const LUSH = new THREE.Color(0x486636), DRY = new THREE.Color(0x6f7248), MOWN = new THREE.Color(0x52703c), FOREST = new THREE.Color(0x3a5530), ROCK = new THREE.Color(0x8a8272), SAND = new THREE.Color(0xd9cba0), DEEP = new THREE.Color(0x0c3340), SNOW = new THREE.Color(0xe8ecee);
  const B = BASE_LAYOUT.bounds;
  let o = 0;
  for (let i = 0; i < NR; i++) for (let j = 0; j <= SEG; j++, o++) {
    const a = (j / SEG) * TAU, x = cx0 + Math.cos(a) * radii[i], z = cz0 + Math.sin(a) * radii[i];
    let h = localGroundHeight(x, z);
    if (i === NR - 1) h = Math.min(h, -300);                    // skirt
    pos[o * 3] = x; pos[o * 3 + 1] = h; pos[o * 3 + 2] = z; uv[o * 2] = x / 9.7; uv[o * 2 + 1] = z / 9.7;
    const s = x - coastX(z), n = fbm(gn, x / 700 + 3, z / 700 + 8, 4), nb = fbm(gn2, x / 190, z / 190, 3);
    c.copy(LUSH).lerp(DRY, smooth(n, 0.42, 0.7) * 0.6).lerp(FOREST, smooth(nb, 0.55, 0.75) * 0.35);
    const campus = smooth(x, B[0] - 200, B[0] + 100) * smooth(-x, -B[2] - 200, -B[2] + 100) * smooth(z, B[1] - 200, B[1] + 100) * smooth(-z, -B[3] - 250, -B[3] + 50);
    c.lerp(c2.copy(MOWN).multiplyScalar(0.94 + nb * 0.12), campus * 0.75);
    if (h > 40) c.lerp(FOREST, smooth(h, 40, 260) * 0.8);
    if (h > 320) c.lerp(ROCK, smooth(h, 320, 700));
    if (h > 900) c.lerp(SNOW, smooth(h, 900, 1250) * 0.9);
    c.lerp(SAND, smooth(s, -170, -55) * (h < 30 ? 1 : 0));
    if (h < SEA_LEVEL) c.lerp(DEEP, smooth(SEA_LEVEL - h, 0, 9));
    col[o * 3] = c.r; col[o * 3 + 1] = c.g; col[o * 3 + 2] = c.b;
  }
  const idx = new Uint32Array((NR - 1) * SEG * 6); let q = 0;
  for (let i = 0; i < NR - 1; i++) for (let j = 0; j < SEG; j++) { const a = i * (SEG + 1) + j, b = a + SEG + 1; idx[q++] = a; idx[q++] = a + 1; idx[q++] = b; idx[q++] = a + 1; idx[q++] = b + 1; idx[q++] = b; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals(); geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: T.grass, normalMap: T.grassN, normalScale: new THREE.Vector2(0.45, 0.45), roughness: 0.95, metalness: 0 });
  const GU = { uDirt: { value: T.dirt }, uNoise: { value: T.noise }, uPaved: { value: T.noise }, uPavedRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uPavedOn: { value: 0 } };
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, GU);
    sh.vertexShader = 'varying vec2 vGW;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vGW = position.xz;');
    sh.fragmentShader = GROUND_FS_HEAD + sh.fragmentShader.replace('#include <map_fragment>', '').replace('#include <color_fragment>', '#include <color_fragment>\n' + GROUND_FS);
  };
  const land = new THREE.Mesh(geo, mat); land.name = 'land'; land.receiveShadow = true; group.add(land);

  const sea = new THREE.Mesh(new THREE.PlaneGeometry(110000, 110000, 1, 1), new THREE.MeshStandardMaterial({ color: 0x16587c, roughness: 0.2, metalness: 0.02, normalMap: T.waterN.clone(), normalScale: new THREE.Vector2(0.55, 0.55), transparent: true, opacity: 0.84, envMapIntensity: 1.4 }));
  sea.material.normalMap.repeat.set(110000 / 90, 110000 / 90); sea.material.normalMap.needsUpdate = true;
  // [realism pass] the sea mirrors the sky toward the horizon (Fresnel) and carries a second, larger swell over the
  // ripples so the normal map does not read as a tiled pattern from the air
  sea.material.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        #ifdef USE_NORMALMAP_TANGENTSPACE
        { vec3 n2 = texture2D(normalMap, vNormalMapUv * 0.19 + vec2(0.37, 0.11)).xyz * 2.0 - 1.0; normal = normalize(normal + tbn * vec3(n2.xy * normalScale * 0.9, 0.0)); }
        #endif`)
      .replace('#include <opaque_fragment>', `
        #ifdef USE_FOG
        { float swF = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 5.0); outgoingLight = mix(outgoingLight, fogColor, (0.02 + 0.98 * swF) * 0.8); }
        #endif
        #include <opaque_fragment>`);
  };
  sea.material.customProgramCacheKey = () => 'sw-sea';
  sea.rotation.x = -Math.PI / 2; sea.position.set(cx0, SEA_LEVEL, cz0); sea.name = 'sea'; sea.receiveShadow = true; sea.renderOrder = 1; group.add(sea);
  // a line of surf where the sea meets the sand
  { const P = [], U = [];
    for (let z = -9000; z < 12000; z += 60) { const x0 = coastX(z) - 62, x1 = coastX(z + 60) - 62; P.push(x0 - 5, SEA_LEVEL + 0.12, z, x0 + 26, SEA_LEVEL + 0.12, z, x1 + 26, SEA_LEVEL + 0.12, z + 60, x0 - 5, SEA_LEVEL + 0.12, z, x1 + 26, SEA_LEVEL + 0.12, z + 60, x1 - 5, SEA_LEVEL + 0.12, z + 60); U.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); g.computeVertexNormals();
    const cvs = document.createElement('canvas'); cvs.width = 64; cvs.height = 8; const cg = cvs.getContext('2d'), gr = cg.createLinearGradient(0, 0, 64, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.75)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.2)'); gr.addColorStop(0.7, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); cg.fillStyle = gr; cg.fillRect(0, 0, 64, 8);
    const surf = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(cvs), transparent: true, depthWrite: false, roughness: 0.9, side: THREE.DoubleSide }));
    surf.material.map.colorSpace = THREE.SRGBColorSpace; surf.name = 'surf'; surf.renderOrder = 2; group.add(surf); }

  let t = 0;
  return {
    group, glossy: [sea.material],
    /** the space centre's paved mask ({ texture, rect: [x0, z0, w, d] }, from createBase().pavedMask): the turf wears away along roads and slabs */
    setPaved(mask) { if (mask && mask.texture) { GU.uPaved.value = mask.texture; GU.uPavedRect.value.set(mask.rect[0], mask.rect[1], 1 / mask.rect[2], 1 / mask.rect[3]); GU.uPavedOn.value = 1; } },
    update(dt) { t += dt || 0; const nm = sea.material.normalMap; nm.offset.set(t * 0.011, t * 0.007); },
    dispose() { group.traverse(o2 => { if (o2.geometry) o2.geometry.dispose(); if (o2.material) o2.material.dispose(); }); if (group.parent) group.parent.remove(group); },
  };
}

// ---------------------------------------------------------------------------------------------
// Sky, clouds, moons, lights
// ---------------------------------------------------------------------------------------------
const SKY_VS = `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const SKY_FS = `#include <logdepthbuf_pars_fragment>
uniform vec3 uZenith, uHorizon, uGround, uSunDir, uSunCol; uniform float uGlow, uDisc;
varying vec3 vDir;
void main(){
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vDir); float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.42));
  col = mix(col, uGround, smoothstep(0.0, -0.16, h));
  float sd = max(dot(d, uSunDir), 0.0), hz = pow(1.0 - clamp(abs(h), 0.0, 1.0), 4.0);
  col += uSunCol * uGlow * (pow(sd, 5.0) * 0.30 * hz + pow(sd, 40.0) * 0.28 + pow(sd, 400.0) * 1.2);
  col += uSunCol * uDisc * smoothstep(0.99962, 0.99982, sd) * 40.0 * smoothstep(-0.03, 0.0, h);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const CLOUD_VS = `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;
const CLOUD_FS = `#include <logdepthbuf_pars_fragment>
uniform vec3 uLit, uShade, uFog, uSunDir; uniform float uTime, uCover;
varying vec3 vW;
float hash(vec2 p){ p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < OCT; i++) { s += a * noise(p); p = p * 2.03 + vec2(17.0, 9.0); a *= 0.5; } return s; }
void main(){
  #include <logdepthbuf_fragment>
  vec2 p = vW.xz * 0.00021 + vec2(uTime * 0.004, uTime * 0.0017);
  float n = fbm(p + fbm(p * 2.3 + 4.0) * 0.4);
  float d = smoothstep(uCover, uCover + 0.22, n);
  float n2 = fbm(p + uSunDir.xz * 0.07 + fbm(p * 2.3 + 4.0) * 0.4);
  float lit = clamp(0.62 + (n - n2) * 3.4, 0.0, 1.0) * (1.0 - 0.45 * smoothstep(uCover + 0.1, uCover + 0.5, n));
  vec3 col = mix(uShade, uLit, lit);
  float r = length(vW.xz - cameraPosition.xz);
  col = mix(col, uFog, smoothstep(7000.0, 32000.0, r) * 0.62);
  float a = d * (1.0 - smoothstep(16000.0, 34000.0, r)) * 0.93;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const MOON_VS = `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN; varying vec2 vUv;
void main(){ vN = normalize(mat3(modelMatrix) * normal); vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const MOON_FS = `#include <logdepthbuf_pars_fragment>
uniform sampler2D map; uniform vec3 uSunDir; uniform float uOcclude, uGain;
varying vec3 vN; varying vec2 vUv;
void main(){
  #include <logdepthbuf_fragment>
  vec3 albedo = texture2D(map, vUv).rgb; float l = smoothstep(-0.02, 0.22, dot(normalize(vN), uSunDir));
  gl_FragColor = vec4(albedo * (l * uGain + 0.012 * uOcclude), uOcclude);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const STAR_VS = `#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aSize; attribute vec3 aColor; uniform float uPixelRatio; varying vec3 vC;
void main(){ vC = aColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uPixelRatio;
  #include <logdepthbuf_vertex>
}`;
const STAR_FS = `#include <logdepthbuf_pars_fragment>
uniform float uOpacity; varying vec3 vC;
void main(){
  #include <logdepthbuf_fragment>
  float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.2, d) * uOpacity; gl_FragColor = vec4(vC * a, 1.0);
}`;
/** Stars on a unit sphere with a denser tilted band. Additive, drawn right after the sky dome. */
function createStars(count) {
  let seed = 20240611; const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const band = Math.floor(count * 0.5), total = count + band, pos = new Float32Array(total * 3), col = new Float32Array(total * 3), size = new Float32Array(total);
  const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.05, 0.4, 0.3)), v = new THREE.Vector3(), tints = [[1, 1, 1], [0.8, 0.88, 1], [1, 0.93, 0.78], [1, 0.8, 0.66], [0.72, 0.95, 0.92]];
  for (let i = 0; i < total; i++) {
    if (i < count) { const z = rnd() * 2 - 1, a = rnd() * TAU, s = Math.sqrt(1 - z * z); v.set(s * Math.cos(a), z, s * Math.sin(a)); }
    else { const a = rnd() * TAU, lat = (rnd() + rnd() + rnd() - 1.5) * 0.2; v.set(Math.cos(a) * Math.cos(lat), Math.sin(lat), Math.sin(a) * Math.cos(lat)).applyQuaternion(tilt); }
    pos.set([v.x, v.y, v.z], i * 3);
    const m = Math.pow(rnd(), i < count ? 5 : 9), b = (i < count ? 0.32 : 0.2) + m * 0.9, t = tints[Math.floor(rnd() * tints.length)];
    col.set([t[0] * b, t[1] * b, t[2] * b], i * 3); size[i] = (i < count ? 1.2 : 0.9) + m * 2.8;
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3)); geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  const mat = new THREE.ShaderMaterial({ uniforms: { uPixelRatio: { value: 1 }, uOpacity: { value: 0 } }, vertexShader: STAR_VS, fragmentShader: STAR_FS, depthTest: false, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, toneMapped: false });
  const pts = new THREE.Points(geo, mat); pts.name = 'stars'; pts.frustumCulled = false; pts.renderOrder = -10;
  pts.onBeforeRender = r => { mat.uniforms.uPixelRatio.value = r.getPixelRatio(); };
  pts.userData.setOpacity = o => { mat.uniforms.uOpacity.value = o; pts.visible = o > 0.004; };
  return pts;
}
/** A small equirectangular colour map of a moon from the core's surface colours (plain grey if that fails). */
function moonTexture(body) {
  const w = 256, h = 128, c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data, dir = new THREE.Vector3(), rgb = [0, 0, 0];
  try {
    for (let y = 0, o = 0; y < h; y++) { const th = (Math.PI * (y + 0.5)) / h, st = Math.sin(th), ct = Math.cos(th);
      for (let x = 0; x < w; x++, o += 4) { const a = (TAU * (x + 0.5)) / w; dir.set(-Math.cos(a) * st, ct, Math.sin(a) * st); const col = body.surfaceColorAt(dir, rgb) || rgb; d[o] = col[0] * 255; d[o + 1] = col[1] * 255; d[o + 2] = col[2] * 255; d[o + 3] = 255; } }
    g.putImageData(img, 0, 0);
  } catch (err) { g.fillStyle = '#' + new THREE.Color(body.color ?? 0x9a9a98).getHexString(); g.fillRect(0, 0, w, h); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; return t;
}

// colour keys over the sine of the sun's elevation
const KEYS = [
  // s      zenith     horizon    ground     sun colour  sunI  hemiSky    hemiGnd   hemiI  fog
  [-0.30, 0x050814, 0x0d1426, 0x05070c, 0x9fb4e0, 0.0, 0x5a70a8, 0x202838, 1.25, 0x0d1426],
  [-0.10, 0x0a1230, 0x35304f, 0x0b0d16, 0xff9060, 0.0, 0x5c6ca4, 0x26262f, 1.25, 0x1f2136],
  [-0.02, 0x1c2f66, 0xd9805a, 0x2a2430, 0xff8048, 0.3, 0x7a82b0, 0x3c3230, 1.30, 0x9a6a5c],
  [0.06, 0x2a55a0, 0xf2b27a, 0x4a4038, 0xffa868, 1.9, 0x98a8cc, 0x5a4a38, 1.70, 0xd9a47c],
  [0.20, 0x2b62b8, 0xcdd3d6, 0x5e6258, 0xffd9ae, 2.7, 0xa9c2e6, 0x6c6850, 2.10, 0xc3ccd2],
  [0.45, 0x2560b8, 0xa9cdea, 0x66706a, 0xfff2de, 3.1, 0xb6d2f2, 0x7c7a5c, 2.40, 0xa9c8e2],
  [1.00, 0x1d55b0, 0x9cc6ea, 0x66706a, 0xfff6e8, 3.2, 0xb6d2f2, 0x7c7a5c, 2.50, 0xa3c5e4],
];
const _ca = new THREE.Color(), _cb = new THREE.Color();
function keyColor(i0, i1, f, col, out) { return out.copy(_ca.set(KEYS[i0][col])).lerp(_cb.set(KEYS[i1][col]), f); }

export function createSkyRig({ quality = 'high' } = {}) {
  const group = new THREE.Group(); group.name = 'skyRig';
  const U = { uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() }, uGlow: { value: 1 }, uDisc: { value: 1 } };
  const skyMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthTest: false, depthWrite: false });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), skyMat); dome.scale.setScalar(30000); dome.renderOrder = -20; dome.frustumCulled = false; dome.name = 'skyDome'; group.add(dome);
  const stars = createStars(quality === 'low' ? 1800 : 3600); stars.scale.setScalar(29000); stars.rotation.set(SKY_TILT, 0.6, 0); group.add(stars);

  const CU = { uLit: { value: new THREE.Color() }, uShade: { value: new THREE.Color() }, uFog: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uTime: { value: 0 }, uCover: { value: 0.43 } };
  const cloudMat = new THREE.ShaderMaterial({ uniforms: CU, vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS, defines: { OCT: quality === 'low' ? 3 : 5 }, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const clouds = new THREE.Mesh(new THREE.PlaneGeometry(70000, 70000), cloudMat); clouds.rotation.x = -Math.PI / 2; clouds.position.y = 2400; clouds.renderOrder = -6; clouds.frustumCulled = false; clouds.name = 'clouds'; group.add(clouds);

  const moonGeo = new THREE.SphereGeometry(1, 40, 20), moons = {};
  for (const body of SYSTEM.home.children) {
    const mat = new THREE.ShaderMaterial({ uniforms: { map: { value: moonTexture(body) }, uSunDir: U.uSunDir, uOcclude: { value: 0 }, uGain: { value: 1 } }, vertexShader: MOON_VS, fragmentShader: MOON_FS,
      depthTest: false, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor });
    const m = new THREE.Mesh(moonGeo, mat); m.renderOrder = -8; m.frustumCulled = false; m.name = 'moon:' + body.id; group.add(m); moons[body.id] = m;
  }

  const sun = new THREE.DirectionalLight(0xffffff, 3); sun.name = 'sun'; sun.castShadow = true;
  sun.shadow.mapSize.set(quality === 'low' ? 1024 : 2048, quality === 'low' ? 1024 : 2048); sun.shadow.bias = -0.0005;
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1); hemi.name = 'skyFill';
  group.add(sun, sun.target, hemi);

  const state = { fog: new THREE.Color(), night: 0, day: 1, sunColor: new THREE.Color(), sunElevation: 1, envKey: null };
  const lightDir = new THREE.Vector3(0, 1, 0), tmp = new THREE.Color();
  let t = 0, envRT = null, pmrem = null;

  function update(camera, dt, sky, focus, extent = 1200) {
    t += dt || 0;
    const s = clamp(sky.sunDir.y, -1, 1);
    let i = 0; while (i < KEYS.length - 2 && s > KEYS[i + 1][0]) i++;
    const f = clamp((s - KEYS[i][0]) / (KEYS[i + 1][0] - KEYS[i][0]), 0, 1), j = i + 1;
    keyColor(i, j, f, 1, U.uZenith.value); keyColor(i, j, f, 2, U.uHorizon.value); keyColor(i, j, f, 3, U.uGround.value); keyColor(i, j, f, 4, U.uSunCol.value);
    keyColor(i, j, f, 9, state.fog); keyColor(i, j, f, 6, hemi.color); keyColor(i, j, f, 7, hemi.groundColor);
    hemi.intensity = lerp(KEYS[i][8], KEYS[j][8], f);
    const sunI = lerp(KEYS[i][5], KEYS[j][5], f), night = 1 - smooth(s, -0.2, 0.02), day = smooth(s, -0.05, 0.25);
    state.night = night; state.day = day; state.sunElevation = Math.asin(s); state.sunColor.copy(U.uSunCol.value);
    U.uSunDir.value.copy(sky.sunDir); U.uGlow.value = smooth(s, -0.22, 0.05) * (1.2 - 0.5 * day); U.uDisc.value = smooth(s, -0.04, 0.0);
    stars.userData.setOpacity(Math.pow(night, 1.5));
    // the one shadow-casting light: the sun by day, the brightest moon (or plain skylight) at night
    const best = sky.moons.reduce((b, m) => (m.dir.y > 0.12 && (!b || m.angular > b.angular) ? m : b), null);
    if (s > -0.035) { lightDir.copy(sky.sunDir); if (lightDir.y < 0.035) { lightDir.y = 0.035; lightDir.normalize(); } sun.color.copy(U.uSunCol.value); sun.intensity = sunI * smooth(s, -0.035, 0.03); }
    else { lightDir.copy(best ? best.dir : _v.set(0.35, 0.8, 0.45).normalize()); sun.color.set(0x9db4e6); sun.intensity = (best ? 0.75 : 0.3) * smooth(-s, 0.035, 0.16); }
    const c = focus || camera.position, texel = (extent * 2) / sun.shadow.mapSize.x;
    sun.target.position.set(Math.round(c.x / texel) * texel, 0, Math.round(c.z / texel) * texel);
    sun.position.copy(sun.target.position).addScaledVector(lightDir, 4000);
    const sc = sun.shadow.camera;
    if (sc.right !== extent) { sc.left = -extent; sc.right = extent; sc.top = extent; sc.bottom = -extent; sc.near = 200; sc.far = 9000; sc.updateProjectionMatrix(); sun.shadow.normalBias = texel * 1.1; }
    // clouds
    CU.uTime.value = t; CU.uSunDir.value.copy(lightDir); CU.uFog.value.copy(state.fog);
    CU.uLit.value.copy(U.uSunCol.value).multiplyScalar(0.25 + 0.95 * day).lerp(tmp.set(0x8fa0c8).multiplyScalar(0.12), night);
    CU.uShade.value.copy(U.uZenith.value).lerp(U.uHorizon.value, 0.55).multiplyScalar(0.55 + 0.25 * day).lerp(tmp.set(0x0a0e18), night * 0.8);
    dome.position.copy(camera.position); stars.position.copy(camera.position);
    clouds.position.x = camera.position.x; clouds.position.z = camera.position.z;
    for (const m of sky.moons) {
      const mesh = moons[m.id]; if (!mesh) continue;
      const boost = m.angular < 0.006 ? 5 : 2.2, dist = 24000;
      mesh.visible = m.dir.y > -0.08;
      mesh.position.copy(camera.position).addScaledVector(m.dir, dist); mesh.scale.setScalar(dist * m.angular * boost);
      mesh.material.uniforms.uOcclude.value = night; mesh.material.uniforms.uGain.value = lerp(0.9, 1.5, night);
      mesh.rotation.y = t * 0.002;
    }
  }

  /** Bake a small image-based-lighting map from the current sky. Returns the new texture when the sun has moved
   *  noticeably since the last bake, else null. The caller puts it on the few glossy materials that want it (not on
   *  scene.environment: sampling it for every ground and wall pixel costs far more than it shows). */
  function bakeEnvironment(renderer) {
    const key = Math.round(state.sunElevation * 40) + ':' + Math.round(U.uSunDir.value.x * 12);
    if (key === state.envKey && envRT) return null;
    state.envKey = key;
    pmrem = pmrem || new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene(), m = new THREE.Mesh(dome.geometry, skyMat); m.scale.setScalar(100);
    envScene.add(m);
    const disc = U.uDisc.value, glow = U.uGlow.value; U.uDisc.value = 0; U.uGlow.value = glow * 0.5;
    const rt = pmrem.fromScene(envScene, 0.02, 1, 1000);
    U.uDisc.value = disc; U.uGlow.value = glow;
    if (envRT) envRT.dispose();
    envRT = rt;
    return rt.texture;
  }

  function dispose() {
    dome.geometry.dispose(); skyMat.dispose(); cloudMat.dispose(); clouds.geometry.dispose(); moonGeo.dispose();
    for (const id of Object.keys(moons)) { moons[id].material.uniforms.map.value.dispose(); moons[id].material.dispose(); }
    stars.geometry.dispose(); stars.material.dispose();
    if (envRT) envRT.dispose(); if (pmrem) pmrem.dispose();
    sun.shadow.map && sun.shadow.map.dispose();
    if (group.parent) group.parent.remove(group);
  }
  return { group, sun, hemi, update, bakeEnvironment, state, dispose };
}
