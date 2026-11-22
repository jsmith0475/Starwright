// Starwright — GLSL shared by the terrain chunks and the globes, and the tiling detail texture they use.
import * as THREE from '../lib/three.module.min.js';
import { ATMO_GLSL } from './atmosphere.js';
import { FEATURE_PARS, FEATURE_NORMAL, FEATURE_ALBEDO, FEATURE_EMIT } from './surfacefeatures.js';

// ------------------------------------------------------------------------------------------------------------
// Detail texture: tileable fractal relief. rg = height gradient, b = height, a = a second, coarser pattern.
// ------------------------------------------------------------------------------------------------------------
let detailTex = null;
export function detailTexture() {
  if (detailTex) return detailTex;
  const S = 512;
  let seed = 90210;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const field = (octs, ridge) => {
    const f = new Float32Array(S * S);
    let amp = 1, norm = 0;
    for (const n of octs) {
      const L = new Float32Array(n * n);
      for (let i = 0; i < L.length; i++) L[i] = rnd();
      const k = n / S, ox = rnd() * n, oy = rnd() * n;     // each octave's lattice is shifted, or they would all line up at the tile edges
      for (let y = 0; y < S; y++) {
        const fy = y * k + oy, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty), ya = (y0 % n) * n, yb = ((y0 + 1) % n) * n;
        for (let x = 0; x < S; x++) {
          const fx = x * k + ox, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx), xa = x0 % n, xb = (x0 + 1) % n;
          let v = (L[ya + xa] * (1 - sx) + L[ya + xb] * sx) * (1 - sy) + (L[yb + xa] * (1 - sx) + L[yb + xb] * sx) * sy;
          if (ridge) v = 1 - Math.abs(2 * v - 1);
          f[y * S + x] += v * amp;
        }
      }
      norm += amp; amp *= 0.55;
    }
    for (let i = 0; i < f.length; i++) f[i] /= norm;
    return f;
  };
  // value noise sits on a square lattice, and at a grazing angle its rows read as straight furrows across the
  // ground. Bend every field through a smooth, tileable warp so no straight line survives.
  const wx = field([3, 5, 9], false), wy = field([3, 5, 9], false);
  const warp = (f, amt) => {
    const o = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const fx = x + (wx[i] - 0.5) * amt + S * 4, fy = y + (wy[i] - 0.5) * amt + S * 4;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const xa = x0 % S, xb = (x0 + 1) % S, ya = (y0 % S) * S, yb = ((y0 + 1) % S) * S;
      o[i] = (f[ya + xa] * (1 - tx) + f[ya + xb] * tx) * (1 - ty) + (f[yb + xa] * (1 - tx) + f[yb + xb] * tx) * ty;
    }
    return o;
  };
  const h1 = warp(field([4, 8, 16, 32, 64, 128, 256], false), 150), h2 = warp(field([6, 12, 24, 48, 96], true), 110), a = warp(field([3, 6, 12, 24, 48], false), 170);
  const data = new Uint8Array(S * S * 4);
  const H = new Float32Array(S * S);
  for (let i = 0; i < H.length; i++) H[i] = 0.62 * h1[i] + 0.38 * h2[i];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x, xm = y * S + ((x + S - 1) % S), xp = y * S + ((x + 1) % S), ym = ((y + S - 1) % S) * S + x, yp = ((y + 1) % S) * S + x;
      const gx = (H[xp] - H[xm]) * 22, gy = (H[yp] - H[ym]) * 22;
      data[i * 4] = Math.max(0, Math.min(255, 127.5 + 127.5 * gx));
      data[i * 4 + 1] = Math.max(0, Math.min(255, 127.5 + 127.5 * gy));
      data[i * 4 + 2] = Math.max(0, Math.min(255, 255 * (H[i] - 0.5) * 2.2 + 127.5));
      data[i * 4 + 3] = Math.max(0, Math.min(255, 255 * (a[i] - 0.5) * 2.4 + 127.5));
    }
  }
  detailTex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  detailTex.wrapS = detailTex.wrapT = THREE.RepeatWrapping;
  detailTex.magFilter = THREE.LinearFilter; detailTex.minFilter = THREE.LinearMipmapLinearFilter;
  detailTex.generateMipmaps = true; detailTex.anisotropy = 8; detailTex.colorSpace = THREE.NoColorSpace;
  detailTex.needsUpdate = true;
  return detailTex;
}

// ------------------------------------------------------------------------------------------------------------
// Shared GLSL
// ------------------------------------------------------------------------------------------------------------
export const COMMON_GLSL = /* glsl */`
vec3 wSrgb(vec3 c) { return pow(c, vec3(2.2)); }
// equirectangular lookup that matches bodybake.js; derivatives are taken from a seam-free coordinate
vec4 wEquirect(sampler2D tex, vec3 d) {
  float u = atan(d.z, -d.x) * 0.15915494, v = acos(clamp(d.y, -1.0, 1.0)) * 0.31830989;
  float u2 = fract(u);               // same place in the texture, seam moved to the opposite meridian
  vec2 dx = vec2(dFdx(u), dFdx(v)), dy = vec2(dFdy(u), dFdy(v));
  vec2 dx2 = vec2(dFdx(u2), dx.y), dy2 = vec2(dFdy(u2), dy.y);
  if (dot(dx2, dx2) + dot(dy2, dy2) < dot(dx, dx) + dot(dy, dy)) { dx = dx2; dy = dy2; }
  return textureGrad(tex, vec2(u, v), dx, dy);
}
vec3 wRotY(vec3 d, float a) { float c = cos(a), s = sin(a); return vec3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z); }
`;

const LIGHT_GLSL = /* glsl */`
uniform vec3 uSun, uAmbSky, uFillTint, uShine, uShineDir;
uniform float uSunSurf, uFill;
// direct sunlight colour at a surface point p (unit-sphere space) whose local vertical is up
vec3 wSunLight(vec3 p, vec3 up) {
  return uSunSurf * aSunTransmit(p, uSun) * smoothstep(-0.04, 0.05, dot(up, uSun));
}
vec3 wAmbient(vec3 up, vec3 N, vec3 V) {
  float mu = dot(up, uSun);
  float rim = 1.0 - max(dot(N, V), 0.0);
  // the night is never black: starlight and sky-glow (uFill), and on a moon the light of its planet (uShine)
  vec3 shine = uShine * smoothstep(-0.12, 0.25, dot(up, uShineDir)) * (0.25 + 0.75 * max(dot(N, uShineDir), 0.0));
  // (sky light is warm while the sun is low)
  vec3 skyC = uAmbSky * mix(vec3(1.12, 0.84, 0.62), vec3(1.0), smoothstep(0.0, 0.32, mu));
  return skyC * smoothstep(-0.22, 0.3, mu) * (0.55 + 0.45 * dot(N, up)) + uFillTint * uFill * (0.75 + 0.6 * rim * rim) + shine;
}
`;

// ------------------------------------------------------------------------------------------------------------
// Terrain chunk shader
// ------------------------------------------------------------------------------------------------------------
export const TERRAIN_VS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aNrm;
attribute vec4 aCol;
attribute vec2 aHs;
uniform vec3 uCenterBF;
uniform float uSea;
varying vec3 vView, vNo, vPo;
varying vec4 vCol;
varying float vH;
void main() {
  vec3 p = position;
  vec3 upO = normalize(uCenterBF + p);
  float lift = -aHs.y;
  #ifdef OCEAN
    lift += max(uSea - aHs.x, 0.0);
  #endif
  p += upO * lift;
  vPo = p;
  vNo = aNrm.xyz;
  vCol = aCol;
  vH = aHs.x;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vView = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

export const TERRAIN_FS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMO_GLSL}
${COMMON_GLSL}
${LIGHT_GLSL}
uniform sampler2D uDetail;
uniform mat3 uRot;                 // body-fixed → scene axes
uniform vec3 uCamU, uRock, uSkyZen, uSkyHor;
uniform float uRadius, uSea, uTime, uStrata, uEmissive, uGloss, uDetailK;
uniform vec3 uTintA, uTintB, uDirt;
uniform vec4 uSite;                // xyz: body-fixed direction of a built-up site (the space centre), w: its radius in metres (0 = none)
uniform float uVary, uDirtT, uDirtK, uVeg, uGrain;
uniform vec2 uRockSlope;
uniform vec3 uCenterBF, uPh0, uPh1, uPh2, uPh3;
uniform float uTexMix;
#ifdef USE_MAPS
  uniform sampler2D uAlbedoTex, uNormalTex;
  uniform float uMapsReady, uBump;
#endif
#ifdef CLOUDS
  uniform sampler2D uCloudTex;
  uniform float uCloudRot, uCloudShadow;
#endif
#ifdef OCEAN
  uniform vec3 uShallow, uDeep;
  uniform float uClarity;
#endif
#ifdef SNOW
  uniform vec3 uSnow;
  uniform float uSnowLine, uSnowLat;
#endif
varying vec3 vView, vNo, vPo;
varying vec4 vCol;
varying float vH;

float tHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float tNoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(tHash(i), tHash(i + vec3(1,0,0)), f.x), mix(tHash(i + vec3(0,1,0)), tHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(tHash(i + vec3(0,0,1)), tHash(i + vec3(1,0,1)), f.x), mix(tHash(i + vec3(0,1,1)), tHash(i + vec3(1,1,1)), f.x), f.y), f.z); }
vec3 triGrad(vec3 p, vec3 w, out float h, out float a) {
  vec4 tx = texture2D(uDetail, p.yz), ty = texture2D(uDetail, p.zx), tz = texture2D(uDetail, p.xy);
  h = tx.b * w.x + ty.b * w.y + tz.b * w.z;
  a = tx.a * w.x + ty.a * w.y + tz.a * w.z;
  vec2 gx = tx.rg * 2.0 - 1.0, gy = ty.rg * 2.0 - 1.0, gz = tz.rg * 2.0 - 1.0;
  return vec3(0.0, gx.x, gx.y) * w.x + vec3(gy.y, 0.0, gy.x) * w.y + vec3(gz.x, gz.y, 0.0) * w.z;
}

${FEATURE_PARS}
// the same, keeping only what is finer than an eighth of the tile: a tile half a metre wide repeats in plain sight,
// and it is its big shapes that give the repeat away
vec3 triFine(vec3 p, vec3 w, out float h, out float a) {
  vec4 tx = texture2D(uDetail, p.yz) - textureLod(uDetail, p.yz, 5.5), ty = texture2D(uDetail, p.zx) - textureLod(uDetail, p.zx, 5.5), tz = texture2D(uDetail, p.xy) - textureLod(uDetail, p.xy, 5.5);
  h = 0.5 + (tx.b * w.x + ty.b * w.y + tz.b * w.z) * 1.6;
  a = 0.5 + (tx.a * w.x + ty.a * w.y + tz.a * w.z) * 1.6;
  vec2 gx = tx.rg * 2.0, gy = ty.rg * 2.0, gz = tz.rg * 2.0;
  return vec3(0.0, gx.x, gx.y) * w.x + vec3(gy.y, 0.0, gy.x) * w.y + vec3(gz.x, gz.y, 0.0) * w.z;
}

// the same relief with its repeat broken up: two copies of the tile, each shifted by an amount that changes from one
// patch of ground to the next (k: slow hashed noise over the globe, 0..1), cross-faded where the patches meet. A tile
// laid once repeats every period in straight rows, which shows from a few hundred metres up.
vec3 triGradV(vec3 p, vec3 w, float k, out float h, out float a) {
  float l = k * 8.0, i = floor(l), f = l - i, ha, aa, hb, ab;
  vec3 ga = triGrad(p + sin(vec3(3.0, 7.0, 5.0) * i), w, ha, aa), gb = triGrad(p + sin(vec3(3.0, 7.0, 5.0) * (i + 1.0)), w, hb, ab);
  float m = smoothstep(0.2, 0.8, f - 0.1 * (ha - hb));
  h = mix(ha, hb, m); a = mix(aa, ab, m);
  return mix(ga, gb, m);
}

void main() {
  #include <logdepthbuf_fragment>
  float dist = length(vView);
  vec3 V = -vView / dist;                       // toward the camera, scene axes
  vec3 pU = uCamU + vView / uRadius;            // fragment in unit-sphere space, scene axes
  vec3 up = normalize(pU);
  vec3 dirO = normalize(uCenterBF + vPo);       // body-fixed direction of the fragment
  vec3 nO = normalize(vNo);
  vec3 albedo = wSrgb(vCol.rgb);
  float ao = vCol.a;

  #ifdef USE_MAPS
    // coarse chunks take colour and relief from the baked globe maps (sharper than their vertices)
    float tm = uTexMix * uMapsReady;
    if (tm > 0.0) {
      vec4 ta = wEquirect(uAlbedoTex, dirO);
      vec4 tn = wEquirect(uNormalTex, dirO);
      albedo = mix(albedo, ta.rgb, tm);
      vec3 east = normalize(vec3(dirO.z, 0.0, -dirO.x) + vec3(1e-6, 0.0, 0.0)), north = cross(dirO, east);
      vec2 sl = (tn.rg - 0.498) * 3.0 * uBump;
      vec3 nT = normalize(dirO - east * sl.x - north * sl.y);
      nO = normalize(mix(nO, nT, tm));
      ao = mix(ao, 1.0, tm);
    }
  #endif

  // ---- detail relief at four scales, each fading out with distance
  vec3 w = pow(abs(nO), vec3(4.0)); w /= (w.x + w.y + w.z);
  float f0 = 1.0 - smoothstep(30.0, 140.0, dist);
  float f1 = 1.0 - smoothstep(500.0, 2200.0, dist);
  float f2 = 1.0 - smoothstep(7000.0, 30000.0, dist);
  float f3 = 1.0 - smoothstep(90000.0, 400000.0, dist);
  float h0 = 0.5, h1 = 0.5, h2 = 0.5, h3 = 0.5, a0 = 0.5, a1 = 0.5, a2 = 0.5, a3 = 0.5;
  vec3 g = vec3(0.0);
  // a fifth, finest scale: the grain of the ground you stand on (blades, grit, gravel)
  float ff = 1.0 - smoothstep(5.0, 18.0, dist), hm = 0.5, am = 0.5;
  vec3 Pm = dirO * uRadius;                     // the fragment on the globe, metres
  if (ff > 0.0) g += triFine(fract(uPh0 * 5.0) + vPo / 0.54, w, hm, am) * ff * 0.6 * uGrain;
  if (f0 > 0.0) g += triGradV(uPh0 + vPo / 2.7, w, tNoise(Pm / 9.0 + 31.0), h0, a0) * f0;
  if (f1 > 0.0) g += triGradV(uPh1 + vPo / 37.0, w, tNoise(Pm / 120.0 + 17.0), h1, a1) * f1 * 0.9;
  if (f2 > 0.0) g += triGradV(uPh2 + vPo / 530.0, w, tNoise(Pm / 1700.0 + 23.0), h2, a2) * f2 * 0.8;
  if (f3 > 0.0) g += triGrad(uPh3 + vPo / 7900.0, w, h3, a3) * f3 * 0.6;
  float hd = mix(0.5, h0, f0) * 0.3 + mix(0.5, h1, f1) * 0.3 + mix(0.5, h2, f2) * 0.25 + mix(0.5, h3, f3) * 0.15;
  float ad = mix(0.5, a0, f0) * 0.25 + mix(0.5, a1, f1) * 0.3 + mix(0.5, a2, f2) * 0.25 + mix(0.5, a3, f3) * 0.2;
  ${FEATURE_NORMAL}
  g -= nO * dot(g, nO);
  vec3 nD = normalize(nO - g * (0.55 * uDetailK));

  vec3 N = normalize(uRot * nD);
  float slope = 1.0 - max(dot(normalize(uRot * nO), up), 0.0);

  float water = 0.0;
  #ifdef OCEAN
    float depth = uSea - vH;
    // (the water's edge is drawn wider with distance: far off, the shore is a line between coarse vertices and a hard
    // edge shows every one of them as a tooth)
    water = smoothstep(0.0, 0.25 + dist * 0.0003, depth);
  #endif

  // ---- material: biome colour, then what actually covers the ground: lush and dry growth (or pale dust and dark
  // regolith), bare earth, grit; rock on slopes, snow, strata
  float veg = 1.0, forest = 0.0, calm = 0.0;
  if (uSite.w > 0.0) calm = 1.0 - smoothstep(uSite.w * 0.9, uSite.w * 1.12, length(dirO - uSite.xyz) * uRadius);     // kept ground: mown, no bare patches
  if (uVeg > 0.5) {
    veg = smoothstep(1.0, 1.5, albedo.g / max(albedo.r, 0.004));                 // how green the biome colour is
    forest = veg * (1.0 - smoothstep(0.12, 0.19, albedo.g));                    // the dark green of woodland
  }
  // patches at tens of metres to kilometres come from hashed noise laid on the globe in metres: the tiling detail
  // map would repeat them in rows toward the horizon
  float q1 = 1.0 - smoothstep(2500.0, 9000.0, dist), q2 = 1.0 - smoothstep(12000.0, 40000.0, dist), q3 = 1.0 - smoothstep(50000.0, 160000.0, dist);
  float m1 = q1 > 0.0 ? (tNoise(Pm / 70.0) - 0.5) * q1 : 0.0, m2 = q2 > 0.0 ? (tNoise(Pm / 310.0 + 3.0) - 0.5) * q2 : 0.0, m3 = q3 > 0.0 ? (tNoise(Pm / 1500.0 + 9.0) - 0.5) * q3 : 0.0;
  float m4 = q1 > 0.0 ? (tNoise(Pm / 23.0 + 5.0) - 0.5) * q1 : 0.0, m5 = q2 > 0.0 ? (tNoise(Pm / 140.0 + 11.0) - 0.5) * q2 : 0.0;
  float pA = (a1 - 0.5) * f1 * 0.5 + m1 * 0.9 + m2 * 1.1 + m3 * 0.8;
  float pB = (h1 - 0.5) * f1 * 0.5 + m4 * 0.8 + m5 * 1.0 - m3 * 0.5;
  float tA = clamp(pA * 2.2, -1.0, 1.0);
  vec3 tint = tA > 0.0 ? mix(vec3(1.0), uTintA, tA) : mix(vec3(1.0), uTintB, -tA);
  albedo *= mix(vec3(1.0), tint, uVary * veg * (1.0 - 0.35 * calm));
  albedo *= 1.0 + 0.2 * uVary * clamp(pB * 2.6, -1.0, 1.0) * (1.0 - 0.5 * calm);
  if (uVeg > 0.5) albedo *= mix(1.0, 0.8, veg * (1.0 - calm));       // turf is darker than a field seen from the air: the blades shade their roots
  // [realism pass] the kept ground round the space centre is turf, not paint: less saturated and darker, so it matches
  // the grass tufts and trees standing on it (js/render/flora.js) and the ground of the space-centre view (baseenv.js)
  if (uVeg > 0.5 && calm > 0.0) { float tl = dot(albedo, vec3(0.3, 0.5, 0.2)); albedo = mix(albedo, mix(vec3(tl), albedo, 0.7) * vec3(0.74, 0.7, 0.74), calm * veg);
    // the same lie of the land as the space-centre view (baseenv.js): meadow gone to seed, damp hollows, worn tracks
    float cM = tNoise(Pm / 900.0 + 2.0), cT = tNoise(Pm / 170.0 + 6.0), cD = tNoise(Pm / 420.0 + 13.0), ck = calm * veg;
    float meadow = smoothstep(0.48, 0.64, cM * 0.6 + cT * 0.4), damp = smoothstep(0.5, 0.66, cD * 0.6 + (1.0 - cM) * 0.4);
    albedo *= mix(vec3(1.0), vec3(1.3, 1.22, 0.78), meadow * 0.75 * ck) * mix(vec3(1.0), vec3(0.6, 0.73, 0.64), damp * 0.8 * ck);
    float track = 1.0 - smoothstep(0.0, 0.028, abs(cT * 0.6 + cD * 0.4 - 0.5));
    albedo = mix(albedo, wSrgb(uDirt) * 0.85, track * 0.55 * ck * (1.0 - smoothstep(1500.0, 5000.0, dist))); }
  albedo *= 0.84 + 0.32 * hd;
  albedo *= 0.93 + 0.14 * ad;
  albedo *= 1.0 + (mix(0.5, hm, ff) - 0.5) * 0.7 * uGrain + (mix(0.5, am, ff) - 0.5) * 0.25 * uGrain;
  // woodland seen from beyond the reach of the trees: a broken canopy of crowns and the dark between them
  if (forest > 0.0) {
    // (hashed noise again: a wood must not repeat)
    float c1 = 1.0 - smoothstep(1500.0, 5000.0, dist), c2 = 1.0 - smoothstep(5000.0, 16000.0, dist);
    float canopy = mix(0.5, tNoise(Pm / 6.5), c1) * 0.55 + mix(0.5, tNoise(Pm / 17.0 + 7.0), c2) * 0.45;
    float fk = forest * smoothstep(150.0, 650.0, dist);
    albedo *= mix(1.0, 0.56 + 0.85 * smoothstep(0.28, 0.72, canopy), fk);
  }
  // bare earth showing through in patches
  float dn = (a0 - 0.5) * f0 * 0.8 + (h1 - 0.5) * f1 * 0.9 - m4 * 1.3 - m5 * 0.9 + (hm - 0.5) * ff * 0.4;
  float dirt = smoothstep(uDirtT, uDirtT + 0.2 + 0.3 * (1.0 - uDirtK), dn) * veg * (1.0 - forest) * (1.0 - calm) * uDirtK * (1.0 - water);      // (no bare patches on the sea bed: through water they read as stains)
  albedo = mix(albedo, wSrgb(uDirt) * (0.72 + 0.56 * ad) * (0.8 + 0.4 * mix(0.5, hm, ff)), dirt);
  float rockK = smoothstep(uRockSlope.x, uRockSlope.y, slope + (hd - 0.5) * 0.22);
  vec3 rock = wSrgb(uRock) * (0.7 + 0.6 * ad);
  if (uStrata > 0.0) {
    float band = sin(vH * 0.085 + 5.0 * ad) * 0.5 + 0.5 * sin(vH * 0.31 + 9.0 * hd);
    rock *= 1.0 + uStrata * 0.28 * band;
  }
  float lum = dot(albedo, vec3(0.3, 0.5, 0.2));
  albedo = mix(albedo, mix(rock, albedo * (dot(rock, vec3(0.333)) / max(lum, 0.02)), 0.35), rockK);
  #ifdef SNOW
    float snowK = smoothstep(0.0, 350.0, vH - (uSnowLine - uSnowLat * abs(dirO.y)) + 500.0 * (hd - 0.5)) * (1.0 - smoothstep(0.35, 0.6, slope));
    // (snow is bright, not white-out: keep its shading and the blue of its shadows)
    albedo = mix(albedo, wSrgb(uSnow) * (0.62 + 0.16 * hd + 0.06 * mix(0.5, hm, ff)), snowK);
  #endif

  ${FEATURE_ALBEDO}
  // ---- light
  vec3 sunC = wSunLight(pU, up);
  #ifdef CLOUDS
    // shadow of the cloud deck: look up the coverage where the sun ray pierces it
    vec3 cd = wRotY(normalize(dirO + (transpose(uRot) * uSun) * 0.012), -uCloudRot);
    float cov = wEquirect(uCloudTex, cd).r;
    sunC *= 1.0 - uCloudShadow * smoothstep(0.26, 0.7, cov);
  #endif
  float ndl = max(dot(N, uSun), 0.0);
  vec3 amb = wAmbient(up, N, V);
  vec3 col = albedo * (sunC * ndl * (0.55 + 0.45 * ao) + amb * ao);
  if (uGloss > 0.0) {
    vec3 Hh = normalize(uSun + V);
    float sp = pow(max(dot(N, Hh), 0.0), 60.0) * uGloss * 0.5 + pow(1.0 - max(dot(N, V), 0.0), 4.0) * uGloss * 0.12;
    col += sunC * sp * step(0.0, dot(N, uSun));
  }
  if (uEmissive > 0.0) {
    vec3 c = vCol.rgb;
    float lava = smoothstep(0.7, 0.85, c.r) * smoothstep(0.0, 0.25 * c.r, 0.5 * c.r - c.b);
    vec3 em = wSrgb(c) * lava * uEmissive * (0.6 + 0.8 * hd);
    ${FEATURE_EMIT}
    col += em;
  }

  #ifdef OCEAN
    if (water > 0.0) {
      // waves: three scrolling scales of the detail gradients, flattened with distance
      vec3 wu = pow(abs(dirO), vec3(6.0)); wu /= (wu.x + wu.y + wu.z);
      float t = uTime;
      float dh, da;
      vec3 gw = triGrad(uPh0 + vPo / 2.7 + vec3(0.021, 0.013, -0.017) * t * 6.0, wu, dh, da) * f0 * 0.5;
      float wf1 = 1.0 - smoothstep(800.0, 6000.0, dist), foamN;
      gw += triGrad(uPh1 + vPo / 37.0 + vec3(-0.011, 0.007, 0.012) * t, wu, foamN, da) * wf1 * 0.55;
      gw += triGrad(uPh1 * 1.7 + vPo / 21.0 + vec3(0.016, -0.009, 0.006) * t, wu, dh, da) * wf1 * 0.4;
      gw += triGrad(uPh2 + vPo / 530.0 + vec3(0.002, 0.003, -0.002) * t, wu, dh, da) * f2 * 0.35;
      gw -= dirO * dot(gw, dirO);
      vec3 Nw = normalize(uRot * normalize(dirO - gw * 0.33));
      float nv = max(dot(Nw, V), 0.0);
      float fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
      vec3 R = reflect(-V, Nw);
      float ru = max(dot(R, up), 0.0);
      vec3 sky = mix(uSkyHor, uSkyZen, pow(ru, 0.45));
      // body of the water: sea bed showing through the shallows, then the deep colour
      float turb = 1.0 - exp(-max(depth, 0.0) / uClarity);
      vec3 body = mix(wSrgb(uShallow), wSrgb(uDeep), turb) * (sunC * max(dot(up, uSun), 0.0) * 0.55 + amb);
      // wave faces turned to the sun and the bright sky are lighter than those turned away
      vec3 lightDir = normalize(uSun + up);
      body *= clamp(1.0 + 1.8 * (dot(Nw, lightDir) - dot(up, lightDir)), 0.6, 1.5);
      // the sea bed seen through the water: red light is lost in the first metres, green and blue carry on, so sand
      // and bare patches on the bed turn green and then fade into the water's own colour
      vec3 tr = exp(-max(depth, 0.0) * vec3(4.5, 1.3, 0.9) / uClarity);
      float sct = 1.0 - exp(-max(depth, 0.0) * 3.0 / uClarity);
      body = col * tr * (1.0 - 0.5 * sct) + body * sct;
      vec3 wcol = mix(body, sky, fres);
      // sun glint: tight up close, a broad sheen from orbit where the waves are below a pixel
      vec3 Hh = normalize(uSun + V);
      float rough = mix(900.0, 28.0, smoothstep(1500.0, 250000.0, dist));
      float spec = pow(max(dot(Nw, Hh), 0.0), rough) * (rough + 8.0) * 0.012;
      wcol += sunC * spec * (0.3 + 0.7 * fres) * step(0.0, dot(up, uSun));
      // foam where the water is centimetres to a metre deep, and a little on wave crests
      float foam = (1.0 - smoothstep(0.05, 0.45 + 0.6 * foamN, depth)) * smoothstep(0.35, 0.6, foamN + 0.25 * sin(t * 0.7 + depth * 3.0));
      foam *= 1.0 - smoothstep(1500.0, 6000.0, dist);
      wcol = mix(wcol, vec3(0.9) * (sunC * max(dot(up, uSun), 0.0) + amb), foam * 0.85);
      col = mix(col, wcol, water);
    }
  #endif

  // ---- air between the camera and the ground
  vec3 trans;
  vec3 insc = aScatter(uCamU, -V, dist / uRadius, uSun, 5, trans);
  col = col * trans + insc;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ------------------------------------------------------------------------------------------------------------
// Globe shader: a whole body on a unit sphere, lit in the sphere's own (body-fixed) space
// ------------------------------------------------------------------------------------------------------------
export const GLOBE_VS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vPosO;
void main() {
  vPosO = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

export const GLOBE_FS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMO_GLSL}
${COMMON_GLSL}
${LIGHT_GLSL}
uniform sampler2D uAlbedoTex, uNormalTex;
uniform vec3 uCamO;                 // camera in the sphere's object space (radius 1)
uniform float uBump, uEmissive, uGloss, uTime, uGas, uStar, uOpacity;
#ifdef CLOUDS
  uniform sampler2D uCloudTex;
  uniform float uCloudRot, uCloudShadow, uCloudAlt;
  uniform vec3 uCloudColor;
#endif
#ifdef OCEAN
  uniform vec3 uShallow, uDeep, uSkyZen, uSkyHor;
#endif
#ifdef RING
  uniform sampler2D uRingTex;
  uniform vec2 uRingR;              // inner, outer radius in body radii
#endif
varying vec3 vPosO;
void main() {
  #include <logdepthbuf_fragment>
  vec3 dirO = normalize(vPosO);
  vec3 toCam = uCamO - dirO;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec4 ta = wEquirect(uAlbedoTex, dirO);
  vec4 tn = wEquirect(uNormalTex, dirO);
  vec3 albedo = wSrgb(ta.rgb);
  if (uStar > 0.5) {
    // the star: self-luminous, limb-darkened
    float mu = max(dot(dirO, V), 0.0);
    albedo = mix(vec3(1.0, 0.82, 0.5), albedo, 0.4);      // spots and faculae stay subtle against the glare
    vec3 c = albedo * (0.45 + 0.55 * pow(mu, 0.5)) * 6.0 * vec3(1.0, 0.92, 0.8);
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }
  vec3 east = normalize(vec3(dirO.z, 0.0, -dirO.x) + vec3(1e-6, 0.0, 0.0)), north = cross(dirO, east);
  vec2 sl = (tn.rg - 0.498) * 3.0 * uBump;
  vec3 N = normalize(dirO - east * sl.x - north * sl.y);
  vec3 up = dirO;
  vec3 sunC = wSunLight(dirO, up);
  float cov = 0.0;
  #ifdef CLOUDS
    float covS = wEquirect(uCloudTex, wRotY(normalize(dirO + uSun * 0.012), -uCloudRot)).r;
    sunC *= 1.0 - uCloudShadow * smoothstep(0.26, 0.7, covS);
    // the deck itself, seen with a little parallax
    vec3 cdir = wRotY(normalize(dirO - V * (uCloudAlt / max(dot(V, dirO), 0.25))), -uCloudRot);
    cov = wEquirect(uCloudTex, cdir).r;
    // finer structure from the same map read at a smaller scale, so edges break up into cells and wisps
    vec2 cuv = vec2(atan(cdir.z, -cdir.x) * 0.15915494 + 0.5, acos(clamp(cdir.y, -1.0, 1.0)) * 0.31830989);
    vec2 cu2 = cuv * vec2(10.0, 5.0) + 0.37; cu2.y = abs(fract(cu2.y * 0.5) * 2.0 - 1.0);
    vec2 cu3 = cuv * vec2(34.0, 17.0) + 0.11; cu3.y = abs(fract(cu3.y * 0.5) * 2.0 - 1.0);
    float cdet = texture2D(uCloudTex, cu2).r * 0.65 + texture2D(uCloudTex, cu3).r * 0.35;
    float cpole = smoothstep(0.9, 0.99, abs(cdir.y));               // not near the poles' pinch
    cov = clamp(cov + (cdet - 0.3) * 0.55 * (1.0 - cpole) * smoothstep(0.02, 0.3, cov), 0.0, 1.0);
  #endif
  #ifdef RING
    // shadow of the rings on the globe: follow the sun ray to the ring plane (y = 0)
    if (abs(uSun.y) > 1e-4) {
      float tr = -dirO.y / uSun.y;
      if (tr > 0.0) {
        float rr = length(dirO.xz + uSun.xz * tr);
        float k = (rr - uRingR.x) / (uRingR.y - uRingR.x);
        if (k > 0.0 && k < 1.0) sunC *= 1.0 - 0.8 * texture2D(uRingTex, vec2(k, 0.5)).a;
      }
    }
  #endif
  float ndl = max(dot(N, uSun), 0.0);
  if (uGas > 0.5) ndl = pow(max(dot(dirO, uSun) * 0.92 + 0.08, 0.0), 0.8);   // deep cloud tops: soft terminator
  vec3 amb = wAmbient(up, N, V);
  vec3 col = albedo * (sunC * ndl + amb);
  if (uGloss > 0.0) {
    vec3 Hh = normalize(uSun + V);
    col += sunC * pow(max(dot(N, Hh), 0.0), 40.0) * uGloss * 0.35 * step(0.0, dot(dirO, uSun));
  }
  col += wSrgb(ta.rgb) * tn.a * uEmissive;
  #ifdef OCEAN
    float water = ta.a;
    if (water > 0.01) {
      float nv = max(dot(dirO, V), 0.0);
      float fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
      vec3 body = albedo * (sunC * max(dot(dirO, uSun), 0.0) + amb);
      vec3 sky = mix(uSkyHor, uSkyZen, 0.5) * smoothstep(-0.1, 0.3, dot(dirO, uSun));
      vec3 wcol = mix(body, sky, fres * 0.6);
      vec3 Hh = normalize(uSun + V);
      float nh = max(dot(dirO, Hh), 0.0);
      wcol += sunC * (pow(nh, 420.0) * 2.2 + pow(nh, 70.0) * 0.16) * step(0.0, dot(dirO, uSun));
      col = mix(col, wcol, water);
    }
  #endif
  #ifdef CLOUDS
    if (cov > 0.003) {
      float lit = max(dot(dirO, uSun), 0.0);
      float relief = clamp(1.0 + (cov - covS) * 1.1, 0.62, 1.06) * (0.6 + 0.4 * smoothstep(0.25, 1.0, cov)) * (0.8 + 0.4 * cdet);     // sunward edges bright, far sides in shade
      vec3 cl = wSrgb(uCloudColor) * (wSunLight(dirO, up) * (0.22 + 0.78 * lit) * relief * (1.0 - 0.22 * smoothstep(0.55, 1.0, cov)) + amb * 1.5);
      col = mix(col, cl, smoothstep(0.24, 0.74, cov) * 0.95);
    }
  #endif
  vec3 trans;
  vec3 insc = aScatter(uCamO, -V, dist, uSun, 5, trans);
  col = col * trans + insc;
  gl_FragColor = vec4(col, uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ------------------------------------------------------------------------------------------------------------
// Atmosphere shell: the limb glow seen from outside and the sky seen from inside, on one back-face sphere
// ------------------------------------------------------------------------------------------------------------
export const SHELL_VS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vPosO;
void main() {
  vPosO = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

export const SHELL_FS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMO_GLSL}
uniform vec3 uCamO, uSun;
uniform float uGround;             // radius of the opaque surface under the shell (1 for globes)
varying vec3 vPosO;
void main() {
  #include <logdepthbuf_fragment>
  vec3 rd = normalize(vPosO - uCamO);
  float rc = length(uCamO);
  float rg = min(uGround, rc - 1e-5);
  vec2 tg = aRaySphere(uCamO, rd, rg);
  float tMax = (tg.x > 0.0 && tg.y > tg.x) ? tg.x : 1e9;
  vec3 trans;
  vec3 col = aScatter(uCamO, rd, tMax, uSun, 12, trans);
  float a = 1.0 - dot(trans, vec3(0.3333));
  if (tMax < 1e8) a = 0.0;          // over the ground the surface shader has already added the air; add nothing twice
  gl_FragColor = vec4(tMax < 1e8 ? vec3(0.0) : col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
