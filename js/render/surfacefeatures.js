// Starwright — what is on the ground at walking scale, world by world (roadmap item 4, docs/WORLDS.md).
//
// Three kinds of feature, drawn by the terrain shader as relief (they tilt the shading normal) and colour. NONE of
// them moves the ground: body.terrainHeight, the function the physics stands on, is not touched, and the mesh is
// the mesh it was. A crater drawn here is a centimetre-to-metre dimple the wheels do not feel, in the same way
// the existing detail relief is.
//
//   craters   bowls with raised rims, 0.4 m to 150 m across, one to a hashed cell, at five sizes
//   cracks    a net of cracks between plates (ice floes, frost polygons, cooled lava crust, dried mud); each plate
//             has its own tilt and tone; cracks can hold a colour (dark water under ice) or glow (lava)
//   ripples   wind ripples a hand wide and dunes tens of metres apart, on flat ground only
//
// Everything is laid out in "wrapped metres": a chunk gives its own position modulo 64 m and modulo 2048 m
// (uPh4, uPh5 in terrain.js), so the shader works with small numbers and keeps millimetre precision anywhere on a
// world 640 km in radius, where single-precision metres from the centre would be 6 cm steps. Every cell size
// divides its period, so the pattern is continuous across chunks. Patterns are laid on the plane of the cube face
// the fragment is on (the same six faces the terrain quadtree uses); they do not line up across the twelve cube
// edges, which lie far from every site in the game.

/** Periods (m) of the two wrapped coordinate systems. Cell sizes below must divide them. */
export const FEATURE_PERIODS = [64, 2048];

const OFF = { craters: null, cracks: null, ripples: null };

/**
 * Per-world surface features. All strengths are slopes (rise over run) or 0..1 mixes.
 *   craters: { small, large, depth, rim }      small / large: chance 0..1 that a cell holds a crater (cells under /
 *                                               over 8 m); depth: slope scale; rim: brightening of rims (fresh dust)
 *   cracks:  { size, mid, big, width, depth, tilt, tone, color, colorK, glow, on }
 *                                               size: plate size near the camera (m; 0.5, 1, 2 or 4), big: plate size
 *                                               seen from the air (m; 32, 128 or 512); width: crack width in plate
 *                                               sizes; depth: slope of the crack walls; tilt: slope each plate is
 *                                               tipped by; tone: plate-to-plate brightness spread; color/colorK: what
 *                                               shows in the crack and how strongly; glow: emission in the crack;
 *                                               on: 'all' | 'flat' (level ground only) | 'lava' (glowing ground only)
 *   ripples: { small, dunes, patch }            slopes of hand-scale ripples and of dunes; patch 0..1: how patchy
 */
const SURFACE = {
  sear: { cracks: { size: 2, mid: 32, big: 512, width: 0.07, depth: 0.5, tilt: 0.1, tone: 0.5, color: [1.0, 0.62, 0.2], colorK: 1, glow: 2.2, on: 'lava', crust: 0.98 },
    craters: { small: 0.25, large: 0.3, depth: 0.8, rim: 0.1 } },
  cindra: { craters: { small: 0.55, large: 0.6, depth: 1, rim: 0.16 },
    cracks: { size: 4, big: 128, width: 0.05, depth: 0.5, tilt: 0.06, tone: 0.3, color: [0.08, 0.05, 0.04], colorK: 0.7, glow: 0, on: 'flat' } },
  murk: { ripples: { small: 0.2, dunes: 0.3, patch: 0.5 },
    cracks: { size: 2, big: 128, width: 0.06, depth: 0.45, tilt: 0.05, tone: 0.3, color: [0.1, 0.07, 0.05], colorK: 0.7, glow: 0, on: 'flat' } },
  pell: { craters: { small: 0.7, large: 0.75, depth: 1, rim: 0.22 } },
  ost: { cracks: { size: 2, big: 128, width: 0.05, depth: 0.6, tilt: 0.09, tone: 0.3, color: [0.2, 0.42, 0.7], colorK: 0.8, glow: 0, on: 'all' },
    craters: { small: 0.2, large: 0.3, depth: 0.7, rim: 0.2 } },
  rusk: { ripples: { small: 0.24, dunes: 0.34, patch: 0.6 },
    craters: { small: 0.12, large: 0.25, depth: 0.7, rim: 0.1 },
    cracks: { size: 0.5, big: 32, width: 0.07, depth: 0.4, tilt: 0.03, tone: 0.22, color: [0.2, 0.09, 0.06], colorK: 0.6, glow: 0, on: 'flat' } },
  dray: { craters: { small: 0.7, large: 0.7, depth: 1, rim: 0.14 }, ripples: { small: 0, dunes: 0.22, patch: 0.2 } },
  tiv: { cracks: { size: 1, mid: 16, big: 128, width: 0.07, depth: 0.5, tilt: 0.05, tone: 0.35, color: [0.95, 0.5, 0.12], colorK: 0.8, glow: 1.2, on: 'lava', crust: 0.95 },
    craters: { small: 0.15, large: 0.2, depth: 0.7, rim: 0.1 } },
  marn: { cracks: { size: 2, big: 32, width: 0.05, depth: 0.3, tilt: 0.02, tone: 0.18, color: [0.16, 0.16, 0.2], colorK: 0.5, glow: 0, on: 'flat' },
    ripples: { small: 0.1, dunes: 0.12, patch: 0.7 } },
  slate: { craters: { small: 0.6, large: 0.6, depth: 1, rim: 0.3 },
    cracks: { size: 4, big: 512, width: 0.04, depth: 0.6, tilt: 0.05, tone: 0.2, color: [0.7, 0.76, 0.84], colorK: 0.6, glow: 0, on: 'all' } },
  nock: { craters: { small: 0.85, large: 0.8, depth: 1.1, rim: 0.12 } },
  brim: { cracks: { size: 2, big: 128, width: 0.08, depth: 0.7, tilt: 0.1, tone: 0.3, color: [0.03, 0.1, 0.18], colorK: 0.9, glow: 0, on: 'all' } },
  quell: { cracks: { size: 4, big: 128, width: 0.04, depth: 0.5, tilt: 0.06, tone: 0.22, color: [0.5, 0.6, 0.78], colorK: 0.6, glow: 0, on: 'all' },
    craters: { small: 0.35, large: 0.45, depth: 0.9, rim: 0.2 } },
  nym: { craters: { small: 0.75, large: 0.75, depth: 1, rim: 0.2 } },
  wend: { craters: { small: 0.6, large: 0.5, depth: 1.2, rim: 0.05 },
    cracks: { size: 2, big: 32, width: 0.08, depth: 0.7, tilt: 0.12, tone: 0.3, color: [0.03, 0.03, 0.03], colorK: 0.8, glow: 0, on: 'all' } },
  // Verda's ground is grass, soil, forest and sea, drawn by the vegetation and water code: no features here
  verda: {},
};

/** Surface features of a body (by id): { craters, cracks, ripples }, each an object or null. */
export function surfaceOf(id) { return { ...OFF, ...(SURFACE[id] || {}) }; }

/** Shader defines and uniforms for a body's surface features ({} and {} when it has none). */
export function featureSetup(id, V3, V4) {
  const s = surfaceOf(id), defines = {}, uniforms = {};
  if (!s.craters && !s.cracks && !s.ripples) return { defines, uniforms, any: false };
  defines.FEATURES = 1;
  uniforms.uPh4 = { value: V3([0, 0, 0]) }; uniforms.uPh5 = { value: V3([0, 0, 0]) };
  if (s.craters) {
    defines.F_CRATERS = 1;
    uniforms.uFCr = { value: V4([s.craters.small, s.craters.large, s.craters.depth, s.craters.rim]) };
  }
  if (s.cracks) {
    const c = s.cracks;
    if (64 % c.size || 2048 % c.big) throw new Error(`surface features of ${id}: plate sizes must divide 64 m and 2048 m`);
    defines.F_CRACKS = 1;
    if (c.on === 'lava') defines.F_CRACKS_LAVA = 1;
    if (c.on === 'flat') defines.F_CRACKS_FLAT = 1;
    uniforms.uFCk = { value: V4([c.size, c.big, c.width, c.depth]) };
    uniforms.uFCk2 = { value: V4([c.tilt, c.tone, c.glow, c.crust || 0]) };
    const mid = c.mid || (Math.sqrt(c.size * c.big) > 12 ? 16 : 8);
    if (2048 % mid) throw new Error(`surface features of ${id}: mid plate size must divide 2048 m`);
    uniforms.uFCkM = { value: mid };
    uniforms.uFCkCol = { value: V4([c.color[0], c.color[1], c.color[2], c.colorK]) };
  }
  if (s.ripples) {
    defines.F_RIPPLES = 1;
    uniforms.uFRp = { value: V4([s.ripples.small, s.ripples.dunes, s.ripples.patch, 0]) };
  }
  return { defines, uniforms, any: true };
}

// ------------------------------------------------------------------------------------------------------------
// GLSL
// ------------------------------------------------------------------------------------------------------------
export const FEATURE_PARS = /* glsl */`
#ifdef FEATURES
uniform vec3 uPh4, uPh5;
#ifdef F_CRATERS
  uniform vec4 uFCr;
#endif
#ifdef F_CRACKS
  uniform vec4 uFCk, uFCk2, uFCkCol;
  uniform float uFCkM;
#endif
#ifdef F_RIPPLES
  uniform vec4 uFRp;
#endif
vec3 fHash3(vec2 c) {
  vec3 p = fract(vec3(c.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
// the two coordinates of p that lie in the plane of the cube face direction d is on, and the way back
vec2 fPlane(vec3 p, vec3 a) { return a.x >= a.y && a.x >= a.z ? p.zy : (a.y >= a.z ? p.xz : p.xy); }
vec3 fLift(vec2 g, vec3 a) { return a.x >= a.y && a.x >= a.z ? vec3(0.0, g.y, g.x) : (a.y >= a.z ? vec3(g.x, 0.0, g.y) : vec3(g.x, g.y, 0.0)); }

#ifdef F_CRATERS
// One crater to a cell of 'size' metres (wrapping every 'per' cells), present with chance 'dens'. Returns the height
// gradient (slope); rim: 1 on the raised rim; bowl: 1 at the middle of the floor.
vec2 fCrater(vec2 p, float size, float per, float dens, out float rim, out float bowl) {
  vec2 q = p / size, c = floor(q);
  vec3 h = fHash3(mod(c, per) + per * 0.37 + size);
  rim = 0.0; bowl = 0.0;
  if (h.z > dens) return vec2(0.0);
  float r = 0.1 + 0.26 * fract(h.z * 57.3 / max(dens, 0.01));
  vec2 d = q - c - mix(vec2(r * 1.35), vec2(1.0 - r * 1.35), h.xy);
  float l = length(d), t = l / r;
  if (t > 1.35) return vec2(0.0);
  float e = exp(-(t - 1.0) * (t - 1.0) / 0.03);
  rim = e; bowl = max(1.0 - t * t, 0.0);
  // a bowl (height -(1 - t^2)^2, so its wall meets the rim without a kink) and a low rim; old craters are softer (h.x)
  float soft = 0.55 + 0.45 * h.x;
  float s = (t < 1.0 ? t * (1.0 - t * t) : 0.0) - 2.5 * (t - 1.0) * e;
  return d / max(l, 1e-4) * s * soft;
}
#endif

#ifdef F_CRACKS
// Plates and the cracks between them. Returns the distance to the nearest crack in plate sizes; id: a random
// vec3 for the plate; toward: unit vector pointing away from that crack, into the plate.
float fPlates(vec2 p, float size, float per, out vec3 id, out vec2 toward) {
  vec2 q = p / size, c = floor(q), f = q - c;
  float d1 = 9.0, d2 = 9.0; vec2 p1 = vec2(0.0), p2 = vec2(0.0); id = vec3(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j));
    vec3 h = fHash3(mod(c + o, per) + per * 0.61 + size);
    vec2 r = o + 0.06 + 0.88 * h.xy - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; p2 = p1; d1 = d; p1 = r; id = h; }
    else if (d < d2) { d2 = d; p2 = r; }
  }
  vec2 ab = p1 - p2; float l = max(length(ab), 1e-4);
  toward = ab / l;                       // from the second nearest point toward the nearest: into our plate
  return (d2 - d1) / (2.0 * l);          // exact distance to the line that separates the two plates
}
// One size of plates laid into the running totals. warp (two detail samples, about 0.3..0.7) bends the straight
// edges a plain cell pattern has; wmod (0..1) opens some cracks and closes others; k is the level's strength.
void fCrackLevel(vec2 p, float size, float per, vec2 warp, float wmod, float k, float dist, inout vec2 fg, inout float ck, inout float tone, inout float heat) {
  vec3 id; vec2 tw;
  // bend the straight edges a plain cell pattern has: smooth waves a few plates long (whole numbers of them per
  // period, so nothing breaks at a chunk border), plus a little of the detail relief so edges are not clean curves
  vec2 q = p / size; float n1 = floor(per * 0.31 + 0.5), n2 = floor(per * 0.13 + 0.5), tau = 6.2831853 / per;
  vec2 bend = vec2(sin(q.y * n1 * tau + 1.3) + 0.6 * sin(q.x * n2 * tau + q.y * n2 * tau), sin(q.x * n1 * tau + 4.1) + 0.6 * sin(q.y * n2 * tau - q.x * n2 * tau + 2.0));
  float e = fPlates(p + (bend * 0.2 + (warp - 0.5) * 0.25) * size, size, per, id, tw);
  float w = max(uFCk.z * (0.3 + 1.9 * smoothstep(0.25, 0.75, wmod)), dist * 0.0016 / size);     // never thinner than a pixel and a half
  float m = 1.0 - smoothstep(w * 0.45, w, e);
  fg += (tw * uFCk.w * m * (1.0 - m) * 4.0 + (id.xy - 0.5) * 2.0 * uFCk2.x * (1.0 - m)) * k;
  ck = max(ck, m * k); tone += (id.z - 0.5) * (1.0 - m) * k; heat += id.y * id.y * id.y * (1.0 - m) * k;
}
#endif
#endif
`;

/**
 * Inserted in the terrain fragment shader after the detail gradient g is accumulated and before the normal is
 * formed. Reads: vPo, dirO, nO, dist, uRadius, vCol, h1, a0, a1 (detail samples), tNoise. Adds to g; leaves
 * fRim, fCk, fCkGlow, fTone, fRip for the colour stage.
 */
export const FEATURE_NORMAL = /* glsl */`
  float fRim = 0.0, fBowl = 0.0, fCk = 0.0, fTone = 0.0, fRip = 0.0, fLava = 0.0, fCov = 0.0, fHeat = 0.0;
  #ifdef FEATURES
  {
    vec3 fa = abs(dirO);
    vec2 pS = fPlane(uPh4 * 64.0 + vPo, fa), pL = fPlane(uPh5 * 2048.0 + vPo, fa);
    float fUp = max(dot(nO, dirO), 0.0);               // 1 on level ground
    float fFlat = smoothstep(0.90, 0.985, fUp);
    vec2 fg = vec2(0.0);
    #ifdef F_CRACKS_LAVA
      fLava = smoothstep(0.7, 0.85, vCol.r) * smoothstep(0.0, 0.25 * vCol.r, 0.5 * vCol.r - vCol.b);
    #endif
    #ifdef F_CRATERS
    {
      // five sizes of cell; each fades out where its craters would be a few pixels wide
      float r1, b1; vec2 cg = vec2(0.0);
      float k0 = 1.0 - smoothstep(60.0, 220.0, dist), k1 = 1.0 - smoothstep(250.0, 900.0, dist), k2 = 1.0 - smoothstep(1000.0, 3600.0, dist);
      float k3 = 1.0 - smoothstep(4000.0, 14000.0, dist), k4 = 1.0 - smoothstep(16000.0, 60000.0, dist);
      if (k0 > 0.0) { cg += fCrater(pS, 1.0, 64.0, uFCr.x, r1, b1) * k0; fRim += r1 * k0; fBowl += b1 * k0; }
      if (k1 > 0.0) { cg += fCrater(pS + 17.3, 4.0, 16.0, uFCr.x * 0.8, r1, b1) * k1; fRim += r1 * k1; fBowl += b1 * k1; }
      if (k2 > 0.0) { cg += fCrater(pL, 16.0, 128.0, uFCr.y, r1, b1) * k2; fRim += r1 * k2; fBowl += b1 * k2; }
      if (k3 > 0.0) { cg += fCrater(pL + 211.0, 64.0, 32.0, uFCr.y * 0.8, r1, b1) * k3; fRim += r1 * k3; fBowl += b1 * k3; }
      if (k4 > 0.0) { cg += fCrater(pL + 97.0, 256.0, 8.0, uFCr.y * 0.6, r1, b1) * k4; fRim += r1 * k4; fBowl += b1 * k4; }
      float ck = uFCr.z * smoothstep(0.55, 0.9, fUp) * (1.0 - fLava);     // no bowls on cliffs or in molten ground
      fg += cg * ck; fRim *= ck; fBowl *= ck;
    }
    #endif
    #ifdef F_CRACKS
    {
      float where = 1.0;
      #ifdef F_CRACKS_FLAT
        where = fFlat * smoothstep(0.42, 0.6, tNoise(dirO * uRadius / 260.0 + 41.0));     // pans and flats, in patches
      #endif
      #ifdef F_CRACKS_LAVA
        where = fLava;
      #endif
      if (where > 0.0) {
        float kS = 1.0 - smoothstep(uFCk.x * 90.0, uFCk.x * 320.0, dist), kB = (1.0 - smoothstep(uFCk.y * 90.0, uFCk.y * 320.0, dist)) * smoothstep(uFCk.x * 20.0, uFCk.x * 120.0, dist);
        float mid = uFCkM;
        // an in-between size carries the pattern from the ground to the air
        float kM = (1.0 - smoothstep(mid * 90.0, mid * 320.0, dist)) * smoothstep(uFCk.x * 20.0, uFCk.x * 120.0, dist);
        vec2 cg = vec2(0.0);
        if (kS > 0.0) fCrackLevel(pS, uFCk.x, 64.0 / uFCk.x, vec2(h0, a0), a1, kS, dist, cg, fCk, fTone, fHeat);
        if (kM > 0.0) fCrackLevel(pL + 53.0, mid, 2048.0 / mid, vec2(h1, a1), a2, kM, dist, cg, fCk, fTone, fHeat);
        if (kB > 0.0) fCrackLevel(pL, uFCk.y, 2048.0 / uFCk.y, vec2(h2, a2), a3, kB, dist, cg, fCk, fTone, fHeat);
        fg += cg * where; fCk *= where; fTone *= where; fHeat *= where;
        fCk = min(fCk, 1.0); fCov = min(kS + kB + kM, 1.0) * where;
      }
    }
    #endif
    #ifdef F_RIPPLES
    {
      // sand moves where the ground is level and the wind can reach it: patches, not a carpet
      float patchN = tNoise(dirO * uRadius / 420.0 + 77.0);
      float sand = fFlat * smoothstep(uFRp.z * 0.62, uFRp.z * 0.62 + 0.22, patchN);
      if (sand > 0.0) {
        float kR = (1.0 - smoothstep(9.0, 36.0, dist)) * uFRp.x, kD = (1.0 - smoothstep(1500.0, 6000.0, dist)) * uFRp.y, kE = (1.0 - smoothstep(7000.0, 26000.0, dist)) * uFRp.y;
        // whole numbers of waves per period in each direction, so crests run on unbroken from chunk to chunk
        if (kR > 0.0) { vec2 kv = vec2(232.0, 106.0) * (6.2831853 / 64.0); float ph = dot(pS, kv) + (a0 - 0.5) * 9.0;
          float cs = cos(ph) + 0.45 * cos(2.0 * ph + 1.1); fg += normalize(kv) * cs * kR * sand; fRip += (sin(ph) * 0.5 + 0.5) * kR * sand; }
        if (kD > 0.0) { vec2 kv = vec2(118.0, 61.0) * (6.2831853 / 2048.0); float ph = dot(pL, kv) + (a1 - 0.5) * 7.0 + (h1 - 0.5) * 4.0;
          float cs = cos(ph) + 0.5 * cos(2.0 * ph + 1.1); fg += normalize(kv) * cs * kD * sand; fRip += (sin(ph) * 0.5 + 0.5) * kD * sand * 0.8; }
        if (kE > 0.0) { vec2 kv = vec2(23.0, 9.0) * (6.2831853 / 2048.0); float ph = dot(pL, kv) + (a2 - 0.5) * 6.0;
          float cs = cos(ph) + 0.5 * cos(2.0 * ph + 1.1); fg += normalize(kv) * cs * kE * sand * 0.8; fRip += (sin(ph) * 0.5 + 0.5) * kE * sand * 0.6; }
      }
    }
    #endif
    g += fLift(fg, fa) / max(0.55 * uDetailK, 0.05);       // (features are slopes in their own right, not scaled by the detail strength)
  }
  #endif
`;

/** Inserted after the ground material is chosen (albedo), before lighting. */
export const FEATURE_ALBEDO = /* glsl */`
  #ifdef FEATURES
    #ifdef F_CRATERS
      albedo *= 1.0 + uFCr.w * fRim - 0.5 * uFCr.w * fBowl;         // bright dust thrown onto rims, darker floors
    #endif
    #ifdef F_CRACKS
      #ifdef F_CRACKS_LAVA
        // glowing ground close up is not a flat sheet of light: a dark crust rides on it in plates
        albedo = mix(albedo, vec3(0.03, 0.025, 0.022) * (1.0 + fTone), fCov * uFCk2.w * (1.0 - fCk));
      #endif
      albedo *= 1.0 + 2.0 * uFCk2.y * fTone;
      albedo = mix(albedo, wSrgb(uFCkCol.rgb), fCk * uFCkCol.a);
    #endif
    #ifdef F_RIPPLES
      albedo *= 1.0 + 0.16 * (fRip - 0.3 * min(uFRp.x + uFRp.y, 1.0));
    #endif
  #endif
`;

/** Inserted where glowing ground adds its light: `em` is the emission about to be added. */
export const FEATURE_EMIT = /* glsl */`
  #if defined(FEATURES) && defined(F_CRACKS_LAVA)
    // under the crust the glow is hidden; it comes out through the cracks, brighter than the open surface
    em *= mix(1.0, mix(0.012 + 0.3 * fHeat, uFCk2.z, fCk), fCov * uFCk2.w);     // (some plates are thin and still dull red)
  #endif
`;
