// Starwright — atmospheric scattering shared by the sky, the terrain, the globes and the oceans.
//
// One small single-scattering model (Rayleigh + Mie, exponential density, Chapman-function sun path) written twice:
// as a GLSL chunk (ATMO_GLSL) and as plain JS (atmoScatter), so the CPU can ask the same questions the shaders
// answer (sun colour at the camera, sky luminance for star fading, ambient light colour).
//
// Everything works in "unit-sphere space": the planet has radius 1 and sits at the origin, so the same code
// serves a body at any scale in any scene (flight, map, hub).
import * as THREE from '../lib/three.module.min.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** Sun irradiance scale used by every world shader (linear, before tone mapping). */
export const SUN_E = 9;
/** Irradiance used for lit surfaces (colours in bodies.js are display colours, not measured albedos). */
export const SUN_SURFACE = 2.6;
/** Strength of the faint glow of the night-side air (airglow): what lets you see the limb of a dark planet. */
export const NIGHT_GLOW = 0.013;
/** How much of the forward (Mie) glare round the sun is kept: lower keeps a low sun orange instead of burnt white. */
const MIE_GLARE = 0.5;
/** Extra haze glow when the sun is low: the warm band along a dusk horizon. */
const MIE_DUSK = 1.6;

/**
 * Scattering parameters for a body, or null when it has no atmosphere.
 * { top, hs, betaR: [r,g,b], betaE: [r,g,b], betaM, g, ms, tint: [r,g,b], tau }   lengths in body radii, betas per body radius.
 */
export function atmoParams(body) {
  const at = body && body.atmo;
  if (!at) return null;
  if (body._atmoParams) return body._atmoParams;
  const R = body.radius, dens = at.rho0 / 1.22;
  const hs = at.scale / R;
  const top = 1 + Math.min(at.height, at.scale * 10) / R;
  // scattering colour: the square of the display colour gives Earth-like ratios for a blue sky
  const c = at.color.map((v) => v * v), m = Math.max(c[0], c[1], c[2]);
  const tint = c.map((v) => v / m);
  const tau = clamp(0.30 * Math.pow(dens, 0.5), 0.07, 1.6);          // zenith optical depth, strongest channel
  const tauM = clamp(0.035 * Math.pow(dens, 0.6), 0.012, 0.5);
  const p = {
    top, hs, tau, tint,
    betaR: tint.map((v) => (v * tau) / hs),
    // extinction: thin air removes what it scatters (blue sky, red sunsets); a dense, coloured atmosphere mostly
    // ABSORBS the other colours, so its light keeps the tint all the way to the ground instead of turning to the complement
    betaE: tint.map((v) => { const thick = clamp((tau - 0.5) / 0.7, 0, 1); return ((v * (1 - thick) + (1.15 - v) * 0.6 * thick) * tau) / hs; }),
    betaM: tauM / hs,
    g: 0.76,
    ms: clamp(0.25 + 0.45 * tau, 0.25, 1.0),     // crude multiple scattering: keeps thick skies bright
  };
  Object.defineProperty(body, '_atmoParams', { value: p, enumerable: false });
  return p;
}

/** Uniforms block for a material that includes ATMO_GLSL. */
export function atmoUniforms(body) {
  const p = atmoParams(body);
  return {
    uAtmoOn: { value: p ? 1 : 0 },
    uBetaR: { value: new THREE.Vector3(...(p ? p.betaR : [0, 0, 0])) },
    uBetaE: { value: new THREE.Vector3(...(p ? p.betaE : [0, 0, 0])) },
    uBetaM: { value: p ? p.betaM : 0 },
    uHs: { value: p ? p.hs : 0.01 },
    uAtmoTop: { value: p ? p.top : 1 },
    uMieG: { value: p ? p.g : 0.76 },
    uMs: { value: p ? p.ms : 0 },
    uSunE: { value: SUN_E },
    uNightGlow: { value: new THREE.Vector3(...(p ? p.tint.map((v) => NIGHT_GLOW * (0.45 + 0.55 * v) * Math.min(1, p.tau / 0.3)) : [0, 0, 0])) },
  };
}

/** Colour of the night-side fill light: starlight is neutral, the glow of a night sky takes the colour of the air. */
export function fillTint(body, out = [1, 1, 1]) {
  const p = atmoParams(body);
  if (!p) { out[0] = out[1] = out[2] = 1; return out; }
  const m = (p.tint[0] + p.tint[1] + p.tint[2]) / 3;
  for (let k = 0; k < 3; k++) out[k] = 0.55 + 0.45 * p.tint[k] / m;
  return out;
}

export const ATMO_GLSL = /* glsl */`
uniform float uAtmoOn;
uniform vec3 uBetaR, uBetaE;
uniform float uBetaM, uHs, uAtmoTop, uMieG, uMs, uSunE;
uniform vec3 uNightGlow;

vec2 aRaySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, d = b * b - c;
  if (d < 0.0) return vec2(1e9, -1e9);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
// optical depth (in units of density-at-surface × body radius) from radius r toward a direction with cos zenith mu
float aSunDepth(float r, float mu) {
  float X = 1.0 / uHs, h = max(r - 1.0, 0.0) / uHs;
  float c = sqrt(X + h);
  if (mu >= 0.0) return uHs * c / (c * mu + 1.0) * exp(-h);
  float x0 = sqrt(max(1.0 - mu * mu, 0.0)) * (X + h), c0 = sqrt(x0);
  return uHs * (2.0 * c0 * exp(min(X - x0, 40.0)) - c / (1.0 - c * mu) * exp(-h));
}
// colour of direct sunlight reaching a point (unit-sphere space), 1.0 with no atmosphere
vec3 aSunTransmit(vec3 p, vec3 sun) {
  if (uAtmoOn < 0.5) return vec3(1.0);
  float r = length(p);
  return exp(-(uBetaE * 1.25 + vec3(uBetaM * 1.1)) * aSunDepth(r, dot(p, sun) / r));   // 1.25: ozone-like absorption, for redder sunsets
}
// in-scattered light along ro + rd·[0, tMax] and the transmittance of that path. steps: 4 (surfaces) to 12 (sky)
vec3 aScatter(vec3 ro, vec3 rd, float tMax, vec3 sun, const int steps, out vec3 trans) {
  trans = vec3(1.0);
  if (uAtmoOn < 0.5) return vec3(0.0);
  vec2 ta = aRaySphere(ro, rd, uAtmoTop);
  float t0 = max(ta.x, 0.0), t1 = min(ta.y, tMax);
  if (t1 <= t0) return vec3(0.0);
  float dt = (t1 - t0) / float(steps);
  float mu = dot(rd, sun);
  float phR = 0.0596831 * (1.0 + mu * mu);
  float g = uMieG;
  // haze: a tight forward lobe (the glare round the sun) and a broad one (the glow that spreads along a dusk horizon)
  float phM = 0.0795775 * (0.7 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) + 0.3 * 0.84 / pow(1.16 - 0.8 * mu, 1.5));
  vec3 bExt = uBetaE + vec3(uBetaM * 1.1);
  vec3 bSun = uBetaE * 1.25 + vec3(uBetaM * 1.1);         // the sun's own path, as in aSunTransmit
  float od = 0.0, sumN = 0.0;
  vec3 sum = vec3(0.0), sumMs = vec3(0.0), sumM = vec3(0.0);
  for (int i = 0; i < steps; i++) {
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * dt);
    float r = length(p);
    float d = exp(-max(r - 1.0, 0.0) / uHs) * dt;
    float ms = dot(p, sun) / r;
    vec3 view = exp(-bExt * (od + 0.5 * d));
    vec3 sunT = exp(-bSun * aSunDepth(r, ms));
    sum += view * sunT * d;
    // haze carries the sun's own colour: little of it by day (the sun must not burn the sky white), much at dusk,
    // when it is what turns the horizon orange
    sumM += view * sunT * d * (${MIE_GLARE.toFixed(2)} + ${MIE_DUSK.toFixed(2)} * (1.0 - smoothstep(0.0, 0.3, ms)));
    // light scattered more than once takes some of the colour of the low sun with it: dusk skies glow warm
    sumMs += view * d * smoothstep(-0.22, 0.2, ms) * mix(vec3(1.0), sqrt(sunT) * 1.3, 0.85);
    sumN += view.g * d * (1.0 - smoothstep(-0.3, 0.02, ms));
    od += d;
  }
  trans = exp(-bExt * od);
  return uSunE * (sum * uBetaR * phR + sumM * (uBetaM * phM) + sumMs * uBetaR * (0.0796 * uMs)) + uNightGlow * (sumN / uHs);
}
`;

// ------------------------------------------------------------------------------------------------------------
// The same model on the CPU
// ------------------------------------------------------------------------------------------------------------

function sunDepth(p, r, mu) {
  const X = 1 / p.hs, h = Math.max(r - 1, 0) / p.hs;
  const c = Math.sqrt(X + h);
  if (mu >= 0) return p.hs * c / (c * mu + 1) * Math.exp(-h);
  const x0 = Math.sqrt(Math.max(1 - mu * mu, 0)) * (X + h), c0 = Math.sqrt(x0);
  return p.hs * (2 * c0 * Math.exp(Math.min(X - x0, 40)) - c / (1 - c * mu) * Math.exp(-h));
}

/** Colour of direct sunlight at a point (unit-sphere space, Vector3-like) for sun direction `sun`: writes [r,g,b] 0..1. */
export function sunTransmit(body, pos, sun, out = [1, 1, 1]) {
  const p = atmoParams(body);
  if (!p) { out[0] = out[1] = out[2] = 1; return out; }
  const r = Math.hypot(pos.x, pos.y, pos.z) || 1;
  const mu = (pos.x * sun.x + pos.y * sun.y + pos.z * sun.z) / r;
  const od = sunDepth(p, r, mu);
  for (let k = 0; k < 3; k++) out[k] = Math.exp(-(p.betaE[k] * 1.25 + p.betaM * 1.1) * od);
  return out;
}

/**
 * In-scattered radiance (linear, same units as the shaders) looking from `ro` along unit `rd` (unit-sphere space).
 * tMax: distance to the surface or Infinity. Returns out = [r, g, b]; out.trans = [r, g, b] path transmittance.
 */
export function atmoScatter(body, ro, rd, tMax, sun, steps = 10, out = [0, 0, 0]) {
  const p = atmoParams(body);
  out[0] = out[1] = out[2] = 0;
  const tr = out.trans || (out.trans = [1, 1, 1]);
  tr[0] = tr[1] = tr[2] = 1;
  if (!p) return out;
  const b = ro.x * rd.x + ro.y * rd.y + ro.z * rd.z, c = ro.x * ro.x + ro.y * ro.y + ro.z * ro.z - p.top * p.top;
  let disc = b * b - c;
  if (disc < 0) return out;
  disc = Math.sqrt(disc);
  const t0 = Math.max(-b - disc, 0), t1 = Math.min(-b + disc, tMax);
  if (t1 <= t0) return out;
  const dt = (t1 - t0) / steps;
  const mu = rd.x * sun.x + rd.y * sun.y + rd.z * sun.z;
  const phR = 0.0596831 * (1 + mu * mu), g = p.g;
  const phM = 0.0795775 * (0.7 * (1 - g * g) / Math.pow(1 + g * g - 2 * g * mu, 1.5) + 0.3 * 0.84 / Math.pow(1.16 - 0.8 * mu, 1.5));
  let od = 0;
  const sum = [0, 0, 0], sumMs = [0, 0, 0], sumM = [0, 0, 0];
  let sumN = 0;
  for (let i = 0; i < steps; i++) {
    const t = t0 + (i + 0.5) * dt;
    const x = ro.x + rd.x * t, y = ro.y + rd.y * t, z = ro.z + rd.z * t;
    const r = Math.hypot(x, y, z);
    const d = Math.exp(-Math.max(r - 1, 0) / p.hs) * dt;
    const ms = (x * sun.x + y * sun.y + z * sun.z) / r;
    const sd = sunDepth(p, r, ms);
    const soft = clamp((ms + 0.22) / 0.42, 0, 1), day = soft * soft * (3 - 2 * soft);
    const lo = clamp(ms / 0.3, 0, 1), mieK = MIE_GLARE + MIE_DUSK * (1 - lo * lo * (3 - 2 * lo));
    for (let k = 0; k < 3; k++) {
      const be = p.betaE[k] + p.betaM * 1.1;
      const view = Math.exp(-be * (od + 0.5 * d));
      const sunT = Math.exp(-(p.betaE[k] * 1.25 + p.betaM * 1.1) * sd);
      sum[k] += view * sunT * d;
      sumM[k] += view * sunT * d * mieK;
      sumMs[k] += view * d * day * (0.15 + 0.85 * 1.3 * Math.sqrt(sunT));
      if (k === 1) { const nt = clamp((ms + 0.3) / 0.32, 0, 1); sumN += view * d * (1 - nt * nt * (3 - 2 * nt)); }
    }
    od += d;
  }
  for (let k = 0; k < 3; k++) {
    tr[k] = Math.exp(-(p.betaE[k] + p.betaM * 1.1) * od);
    out[k] = SUN_E * (sum[k] * p.betaR[k] * phR + sumM[k] * p.betaM * phM + sumMs[k] * p.betaR[k] * 0.0796 * p.ms)
      + NIGHT_GLOW * (0.45 + 0.55 * p.tint[k]) * Math.min(1, p.tau / 0.3) * (sumN / p.hs);
  }
  return out;
}

const _ro = { x: 0, y: 0, z: 0 }, _rd = { x: 0, y: 0, z: 0 }, _sun = { x: 0, y: 0, z: 0 }, _acc = [0, 0, 0];

/**
 * Sky seen by an observer at `altitude` metres with the sun `sunElevation` radians above the horizon.
 * Returns { zenith: [r,g,b], horizon: [r,g,b], sun: [r,g,b] (direct sunlight colour), lum } in linear scene units.
 */
export function skyAt(body, altitude, sunElevation, out = {}) {
  const zen = out.zenith || (out.zenith = [0, 0, 0]), hor = out.horizon || (out.horizon = [0, 0, 0]), sun = out.sun || (out.sun = [1, 1, 1]);
  const p = atmoParams(body);
  if (!p) { zen.fill(0); hor.fill(0); sun.fill(1); out.lum = 0; return out; }
  const r = 1 + Math.max(altitude, 0) / body.radius;
  _ro.x = 0; _ro.y = r; _ro.z = 0;
  _sun.x = Math.cos(sunElevation); _sun.y = Math.sin(sunElevation); _sun.z = 0;
  _rd.x = 0; _rd.y = 1; _rd.z = 0;
  atmoScatter(body, _ro, _rd, Infinity, _sun, 8, _acc); zen[0] = _acc[0]; zen[1] = _acc[1]; zen[2] = _acc[2];
  // horizon: look sideways, 90° away from the sun's azimuth, a touch above level
  _rd.x = 0; _rd.y = 0.06; _rd.z = Math.sqrt(1 - 0.0036);
  atmoScatter(body, _ro, _rd, Infinity, _sun, 10, _acc); hor[0] = _acc[0]; hor[1] = _acc[1]; hor[2] = _acc[2];
  sunTransmit(body, _ro, _sun, sun);
  out.lum = 0.2126 * zen[0] + 0.7152 * zen[1] + 0.0722 * zen[2];
  return out;
}

const _sky = {};
const _col = new THREE.Color();
/** ACES-ish display mapping of a linear scene value, for CPU-side colours that never pass through the renderer. */
function tone(x) { x *= 0.6; return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1); }

/**
 * Background sky colour seen from inside an atmosphere (kept from the first release; now driven by the
 * scattering model). Returns a THREE.Color in the working colour space; black with no atmosphere or in space.
 */
export function skyColor(body, altitude, sunElevation, out = new THREE.Color()) {
  const at = body && body.atmo;
  if (!at || altitude >= at.height) return out.setRGB(0, 0, 0);
  skyAt(body, altitude, sunElevation, _sky);
  const z = _sky.zenith, h = _sky.horizon;
  _col.setRGB(tone(0.6 * z[0] + 0.4 * h[0]), tone(0.6 * z[1] + 0.4 * h[1]), tone(0.6 * z[2] + 0.4 * h[2]), THREE.SRGBColorSpace);
  return out.copy(_col);
}

const _amb = {};
/** Ambient sky light on the ground at midday (linear rgb, same scale as SUN_SURFACE), [0,0,0] without air. */
export function ambientSky(body, out = [0, 0, 0]) {
  if (!atmoParams(body)) { out[0] = out[1] = out[2] = 0; return out; }
  skyAt(body, 0, 0.9, _amb);
  const z = _amb.zenith, h = _amb.horizon;
  // normalise: the colour of the sky, at a strength that grows with how much air there is
  const p = atmoParams(body), k = 0.16 + 0.34 * Math.min(1, p.tau / 0.3);
  const m = Math.max(1e-6, Math.max(z[0] + h[0], z[1] + h[1], z[2] + h[2]));
  for (let i = 0; i < 3; i++) out[i] = k * (0.35 + 0.65 * (z[i] + h[i]) / m);
  return out;
}
