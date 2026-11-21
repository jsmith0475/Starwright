// Starwright — ground clutter near the camera: stones and boulders everywhere, grass and trees where a world has them.
// Instanced (one draw call per kind). Objects are placed deterministically per ground cell from the same
// body.terrainHeight the physics uses, so a rock is always in the same spot and sits exactly on the ground.
// Nothing is placed inside the space-centre circle on the home world (the space-centre model owns that ground).
//
// Kinds: boulders (smooth lumps, out to 150 m), pebbles (a dense field round the camera), grass in two layers (a thick
// sward within 25 m, tufts out to 80 m), conifers and broadleaf trees in groves (out to 760 m) with a soft shadow
// under each. Only the instances that exist are drawn: tiles pack their objects to the front of the buffer.
import * as THREE from '../lib/three.module.min.js';
import { faceDir, dirToFace } from './terrainmesh.js';
import { buildTree, growSkeleton } from './treegen.js';
import { SUN_SURFACE, ATMO_GLSL, atmoUniforms } from './atmosphere.js';

const _d = { x: 0, y: 0, z: 0 }, _rgb = [0, 0, 0];
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _up = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);

function hash(a, b, c, d) {
  let h = Math.imul(a, 0x8da6b343) ^ Math.imul(b, 0xd8163841) ^ Math.imul(c, 0xcb1ab31f) ^ Math.imul(d, 0x165667b1);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); h ^= h >>> 15;
  return h >>> 0;
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// smooth lumps for displacing geometry: a few sines, continuous over the sphere
function lump(x, y, z, s) {
  return Math.sin(x * 2.1 + s) * Math.sin(y * 2.7 + s * 1.7) * Math.sin(z * 2.3 + s * 0.6) + 0.5 * Math.sin(x * 4.7 + y * 3.9 + s * 2.2) * Math.sin(z * 5.3 - y * 2.9 + s);
}

/** Geometry from loose triangles → welded, with smooth normals; uv filled by `uvOf(x, y, z)`. */
function weld(pos, uvOf) {
  const map = new Map(), P = [], idx = [];
  for (let i = 0; i < pos.length; i += 3) {
    const key = `${Math.round(pos[i] * 2000)},${Math.round(pos[i + 1] * 2000)},${Math.round(pos[i + 2] * 2000)}`;
    let k = map.get(key);
    if (k === undefined) { k = P.length / 3; map.set(key, k); P.push(pos[i], pos[i + 1], pos[i + 2]); }
    idx.push(k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const uv = new Float32Array((P.length / 3) * 2);
  for (let i = 0; i < P.length / 3; i++) { const t = uvOf(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); uv[i * 2] = t[0]; uv[i * 2 + 1] = t[1]; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

function rockGeometry(detail, seed) {
  // an icosphere knocked into a lump by smooth noise, squashed, its underside flattened into the ground; welded, so
  // the normals are smooth and it reads as a worn stone, not a faceted prop
  const src = new THREE.IcosahedronGeometry(1, detail).attributes.position.array, pos = new Float32Array(src.length);
  // a few planes shear lumps off, as fractures do: flat faces and edges that the smooth normals then round over
  const r = rng(seed * 101 + 7), cuts = [];
  for (let c = 0; c < 6; c++) {
    const a = r() * 6.283, cy = -0.15 + 1.0 * r(), s = Math.sqrt(Math.max(0, 1 - cy * cy));
    cuts.push([Math.cos(a) * s, cy, Math.sin(a) * s, 0.6 + 0.26 * r()]);
  }
  for (let i = 0; i < src.length; i += 3) {
    let x = src[i], y = src[i + 1], z = src[i + 2];
    const k = 0.9 + 0.26 * lump(x, y, z, seed) + 0.08 * lump(x * 2.6, y * 2.6, z * 2.6, seed + 4);
    x *= k; y *= k; z *= k;
    for (const [nx, ny, nz, d] of cuts) { const over = x * nx + y * ny + z * nz - d; if (over > 0) { x -= nx * over * 0.92; y -= ny * over * 0.92; z -= nz * over * 0.92; } }
    pos[i] = x * 1.08; pos[i + 1] = Math.max(-0.26, y * 0.74); pos[i + 2] = z * 0.9;
  }
  return weld(pos, (x, y) => [0, (y + 0.26) / 0.9]);
}

function grassGeometry(blades, hMin, hMax, wMin, wMax, spread, seed) {
  // a tuft: tapered blades leaning outward, each bent once; uv.y = height fraction (0 at the root)
  const pos = [], nor = [], uv = [];
  const r = rng(seed);
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + r() * 1.3, lean = 0.1 + 0.34 * r(), h = hMin + (hMax - hMin) * r(), w = wMin + (wMax - wMin) * r();
    const rad = spread * (0.15 + 0.85 * r()), cx = Math.cos(a), cz = Math.sin(a), ox = cx * rad, oz = cz * rad;
    const tw = a + 1.2 + r() * 0.7, px = Math.cos(tw) * w, pz = Math.sin(tw) * w;     // the blade's width runs across its lean, a little twisted
    const mid = [ox + cx * lean * 0.3 * h, h * 0.56, oz + cz * lean * 0.3 * h], tip = [ox + cx * lean * h * 1.2, h, oz + cz * lean * h * 1.2];
    const quad = [[ox - px, 0, oz - pz], [ox + px, 0, oz + pz], [mid[0] + px * 0.72, mid[1], mid[2] + pz * 0.72], [mid[0] - px * 0.72, mid[1], mid[2] - pz * 0.72]];
    const tris = [quad[0], quad[1], quad[2], quad[0], quad[2], quad[3], quad[3], quad[2], tip];
    for (const v of tris) { pos.push(v[0], v[1], v[2]); nor.push(cx * 0.35, 0.86, cz * 0.35); uv.push(0, v[1] / hMax); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** Join geometries that have position / normal / uv into one non-indexed geometry. */
function join(parts) {
  const P = [], N = [], U = [];
  for (const src of parts) {
    const p = src.index ? src.toNonIndexed() : src;
    P.push(...p.attributes.position.array); N.push(...p.attributes.normal.array); U.push(...p.attributes.uv.array);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  return g;
}
function trunk(r0, r1, h, total, seg = 7) {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1, true); g.translate(0, h / 2 - 0.2, 0);
  const n = g.attributes.position.count, uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { uv[i * 2] = 2; uv[i * 2 + 1] = g.attributes.position.getY(i) / total; }      // uv.x = 2 marks wood
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

function coniferGeometry(tiers = 9, seg = 14, tseg = 7) {
  // a spruce: trunk and whorls of drooping boughs. Each whorl is a ragged star (long boughs with gaps between), not
  // a cone, and the whorls overlap, so the outline is broken the way a real tree's is. uv.x = how far out a point
  // is on its whorl (1 at the tips, 0 under the whorl above: used for shading), uv.y = height fraction. Normals
  // lean outward and up, so the light models the whole crown softly instead of faceting every tier.
  const H = 11, parts = [trunk(0.3, 0.1, 4.2, H, tseg)];
  const r = rng(31);
  for (let t = 0; t < tiers; t++) {
    const k = t / (tiers - 1), y0 = 1.3 + k * 7.4, hgt = 2.5 - 1.1 * k, rad = 2.7 * Math.pow(1 - 0.86 * k, 0.9) * (0.9 + 0.2 * r());
    const pos = [], nor = [], uv = [];
    const rim = [], tw = r() * 6.283;
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2 + tw, tip = s % 2 === 0;
      const rr = rad * (tip ? 0.82 + 0.36 * r() : 0.38 + 0.2 * r());
      rim.push([Math.cos(a) * rr, y0 - (tip ? 0.22 * rad + 0.3 * r() : -0.1 * rad), Math.sin(a) * rr, tip ? 1 : 0.45]);
    }
    const apex = [0, y0 + hgt, 0, 0];
    for (let s = 0; s < seg; s++) {
      const a = rim[s], b = rim[(s + 1) % seg];
      for (const v of [apex, b, a]) {
        pos.push(v[0], v[1], v[2]);
        const l = Math.hypot(v[0], v[2]) || 1, out = v[3] > 0 ? 1 : 0;
        const nx = out ? v[0] / l : 0, nz = out ? v[2] / l : 0, ny = out ? 0.6 : 1, nl = Math.hypot(nx, ny, nz);
        nor.push(nx / nl, ny / nl, nz / nl); uv.push(v[3], v[1] / H);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    parts.push(g);
  }
  return join(parts);
}

function broadleafGeometry(far = false) {
  // a spreading tree: trunk, and a crown of three merged lumpy masses with normals that point away from the crown's
  // middle (so the crown shades as one soft volume). uv.x = 1 on top / outside, lower underneath.
  const H = 9, parts = [trunk(0.36, 0.2, 4.2, H, far ? 4 : 7)];
  const blobs = [[0, 6.0, 0, 2.9, 2.3], [1.5, 5.0, 0.7, 1.9, 1.5], [-1.3, 5.2, -0.9, 2.0, 1.5], [0.2, 4.9, -1.6, 1.6, 1.3]];
  blobs.forEach(([bx, by, bz, rw, rh], bi) => {
    if (far && bi >= 2) return;
    const s = far ? new THREE.SphereGeometry(1, bi === 0 ? 6 : 5, bi === 0 ? 5 : 4) : new THREE.SphereGeometry(1, bi === 0 ? 10 : 8, bi === 0 ? 7 : 5);
    const p = s.attributes.position, n = s.attributes.normal, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + 0.2 * lump(x * 1.6, y * 1.6, z * 1.6, bi * 3.1 + 1) + 0.1 * lump(x * 3.4, y * 3.4, z * 3.4, bi + 7);
      const px = bx + x * rw * k, py = by + Math.max(y, -0.55) * rh * k, pz = bz + z * rw * k;
      p.setXYZ(i, px, py, pz);
      const nx = px, ny = (py - 5.0) * 1.2, nz = pz, l = Math.hypot(nx, ny, nz) || 1;
      n.setXYZ(i, nx / l, ny / l, nz / l);
      uv[i * 2] = Math.min(1, Math.max(0, 0.55 + 0.6 * (ny / l) + 0.25 * (Math.hypot(px, pz) / 3)));
      uv[i * 2 + 1] = py / H;
    }
    s.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    parts.push(s);
  });
  return join(parts);
}

// [realism pass] The home world's broadleaf woods use the same trees as the space centre (js/render/treegen.js): the
// real trunk and limbs of an oak, and its crown as one small lumpy mass per leaf clump, so a wood seen from a few
// hundred metres has the layered, clustered outline of the trees with leaf cards and there is no change of style
// where the centre's own trees end. Same conventions as broadleafGeometry (uv.x: 2 = wood, else light on the crown).
function groveGeometry(far = false, seed = 5) {
  const K = 0.85, t = buildTree('oak', { lod: 1, seed }), sk = growSkeleton('oak', seed), H = t.height * K;
  // wood: the triangles of the reduced mesh that are bark
  const map = new Map(), P = [], N = [], U = [], I = [];
  for (let i = 0; i < t.index.length; i += 3) {
    const tri = [t.index[i], t.index[i + 1], t.index[i + 2]];
    if (t.bark[tri[0] * 3 + 2] < 0.5) continue;
    if (far && t.position[tri[0] * 3 + 1] > t.height * 0.55) continue;                      // far: the trunk only
    for (const v of tri) {
      if (!map.has(v)) { map.set(v, P.length / 3); P.push(t.position[v * 3] * K, t.position[v * 3 + 1] * K, t.position[v * 3 + 2] * K); N.push(t.normal[v * 3], t.normal[v * 3 + 1], t.normal[v * 3 + 2]); U.push(2, (t.position[v * 3 + 1] * K) / H); }
      I.push(map.get(v));
    }
  }
  const wood = new THREE.BufferGeometry();
  wood.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); wood.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); wood.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); wood.setIndex(I);
  const parts = [wood], c = t.center, cr = t.crownRadius || t.radius;
  const big = sk.cards.filter(k => k.big);
  big.forEach((k, bi) => {
    if (far && bi % 4) return;
    const rad = k.len * (far ? 1.05 : 0.6) * K, cx = (k.base[0] + k.u[0] * k.len * 0.5) * K, cy = (k.base[1] + k.u[1] * k.len * 0.5) * K, cz = (k.base[2] + k.u[2] * k.len * 0.5) * K;
    const sph = far ? new THREE.SphereGeometry(1, 5, 3) : new THREE.SphereGeometry(1, 6, 4);
    const p = sph.attributes.position, n = sph.attributes.normal, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), q = 1 + 0.28 * lump(x * 1.9, y * 1.9, z * 1.9, bi * 3.1 + 1);
      const px = cx + x * rad * q, py = cy + y * rad * 0.8 * q, pz = cz + z * rad * q;
      p.setXYZ(i, px, py, pz);
      const nx = px - c[0] * K, ny = (py - c[1] * K) * 0.9 + cr * K * 0.25, nz = pz - c[2] * K, l = Math.hypot(nx, ny, nz) || 1;
      n.setXYZ(i, nx / l, ny / l, nz / l);
      uv[i * 2] = Math.min(1, Math.max(0, 0.3 + 0.45 * (ny / l) + 0.4 * (l / (cr * K)) + 0.2 * y));
      uv[i * 2 + 1] = Math.min(1, py / H);
    }
    sph.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    parts.push(sph);
  });
  return join(parts);
}

function shadowGeometry() {
  // a unit disc in the ground plane (y = 0): stretched away from the sun into each tree's shadow by the vertex shader
  const g = new THREE.CircleGeometry(1, 12); g.rotateX(-Math.PI / 2);
  return g;
}

const NOISE = `
float h3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z); }`;

const VS = `#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uRange, uTime, uSway;
uniform vec4 uShadowDims;        // of the thing that casts it, per unit of its height scale: radius, height; then lift off the ground (m), depth pull
uniform vec3 uSun;
varying vec3 vN, vC, vL, vView; varying float vY, vT, vFade;
void main(){
  vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec4 wc = modelMatrix * ip;
  float d = distance(wc.xyz, cameraPosition);
  float k = 1.0 - smoothstep(uRange * 0.7, uRange, d);          // shrink into the ground at the edge of the range
  vec3 p = position * k;
  #ifdef SHADOW
    // the disc becomes the tree's shadow: laid on the ground, drawn out away from the sun
    vec3 upW = normalize(mat3(modelMatrix) * (mat3(instanceMatrix) * vec3(0.0, 1.0, 0.0)));
    float sz = length(mat3(instanceMatrix) * vec3(0.0, 1.0, 0.0));
    float mu = dot(upW, uSun);
    vec3 flt = uSun - upW * mu;
    vec3 away = -flt / max(length(flt), 1e-4);
    vec3 side = cross(upW, away);
    float len = min(uShadowDims.y * sz * sqrt(max(1.0 - mu * mu, 0.0)) / max(mu, 0.13), 60.0);
    float rad = uShadowDims.x * sz * k;
    vec3 wpos = wc.xyz + upW * (uShadowDims.z + 0.02 * rad) + side * (position.x * rad) + away * (position.z * (rad + 0.5 * len) + 0.5 * len + 0.3 * rad) * k;
    vN = upW; vC = vec3(0.0); vL = position; vY = length(position.xz); vT = smoothstep(-0.02, 0.1, mu); vFade = k;
    vView = wpos - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * vec4(wpos, 1.0);
  #else
    if (uSway > 0.0) { float ph = ip.x * 0.7 + ip.z * 0.9; float y2 = uv.y * uv.y; p.xz += uSway * y2 * vec2(sin(uTime * 1.7 + ph) + 0.4 * sin(uTime * 4.3 + ph * 2.1), cos(uTime * 1.3 + ph * 1.3)); }
    vec4 wp = modelMatrix * (instanceMatrix * vec4(p, 1.0));
    vN = normalize(mat3(modelMatrix) * (mat3(instanceMatrix) * normal));
    vC = instanceColor; vY = uv.y; vT = uv.x; vFade = k;
    vL = position + fract(ip.xyz * 0.173) * 9.0;                // each object gets its own piece of the noise
    vView = wp.xyz - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * wp;
  #endif
  #include <logdepthbuf_vertex>
}`;
const FS = `#include <common>
#include <logdepthbuf_pars_fragment>
${ATMO_GLSL}
${NOISE}
uniform vec3 uSun, uSunColor, uAmb, uUp, uCamU; uniform float uRadius, uShadowK, uShadowGain; uniform vec4 uShadowDims;
varying vec3 vN, vC, vL, vView; varying float vY, vT, vFade;
void main(){
  #include <logdepthbuf_fragment>
  if (vFade < 0.02) discard;
  float dist = length(vView);
  vec3 V = -vView / dist;
  #ifdef SHADOW
    // soft-edged and not black: the sky still lights the shade
    float a = min((1.0 - smoothstep(0.35, 1.0, vY)) * uShadowK * uShadowGain * vT * vFade, 0.92);
    gl_FragColor = vec4(vec3(0.0), a);
    #ifdef USE_LOGDEPTHBUF
      gl_FragDepth = log2(vFragDepth * uShadowDims.w) * logDepthBufFC * 0.5;      // lie on the ground even where it rolls a little
    #endif
  #else
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 alb = pow(vC, vec3(2.2));
  float ndl = max(dot(N, uSun), 0.0), ao = 1.0;
  vec3 extra = vec3(0.0);
  #ifdef GRASS
    // blades: lit from above whatever way they face, dark at the root, pale at the tip, glowing when back-lit
    float top = max(dot(uUp, uSun), 0.0);
    ndl = 0.3 + 0.7 * top;
    ao = 0.34 + 0.66 * vY;
    alb *= mix(vec3(0.7, 0.76, 0.66), vec3(1.3, 1.25, 0.95), vY);
    float back = pow(max(dot(-V, uSun), 0.0), 3.0);
    extra = alb * uSunColor * back * vY * 0.5 * vec3(1.0, 1.0, 0.55);
  #endif
  #ifdef TREE
    if (vT > 1.5) {
      // bark
      float bn = n3(vL * vec3(9.0, 1.6, 9.0));
      alb = vec3(0.058, 0.04, 0.028) * (0.65 + 0.8 * bn);
      ndl = 0.2 + 0.8 * ndl; ao = 0.5 + 0.5 * smoothstep(0.0, 0.35, vY);
    } else {
      // foliage: clumps of lighter and darker leaves, shaded as a soft volume, darker inside and underneath
      float f1 = n3(vL * 1.3), f2 = n3(vL * 4.6 + 3.0), f3 = n3(vL * 15.0 + 8.0);
      float clump = f1 * 0.5 + f2 * 0.32 + f3 * 0.18;
      alb *= 0.45 + 0.95 * clump;
      alb = mix(alb, alb * vec3(1.22, 1.15, 0.75), smoothstep(0.55, 0.8, clump) * 0.5);     // sunlit sprays are yellower
      float wrap = dot(N, uSun) * 0.6 + 0.4;
      ndl = max(wrap, 0.0) * (0.55 + 0.45 * smoothstep(0.3, 0.7, clump));
      ao = (0.42 + 0.58 * vT) * (0.62 + 0.38 * smoothstep(0.1, 0.9, vY)) * (0.7 + 0.3 * f2);
      float back = pow(max(dot(-V, uSun), 0.0), 2.5);
      extra = alb * uSunColor * back * vT * 0.22 * vec3(1.0, 1.0, 0.5);
    }
  #endif
  #ifdef ROCK
    // stone: mottled, pitted, a little bumpy; dusted on top, dark where it meets the ground
    float r1 = n3(vL * 2.4), r2 = n3(vL * 7.5 + 2.0), r3 = n3(vL * 23.0 + 5.0);
    vec3 bump = vec3(n3(vL * 6.1 + 11.0), n3(vL * 6.1 + 23.0), n3(vL * 6.1 + 37.0)) - 0.5 + 0.5 * (vec3(n3(vL * 19.0 + 3.0), n3(vL * 19.0 + 13.0), r3) - 0.5);
    N = normalize(N + bump * 0.55);
    ndl = max(dot(N, uSun), 0.0);
    alb *= (0.66 + 0.5 * r1) * (0.8 + 0.3 * r2) * (0.88 + 0.24 * r3);
    alb *= 1.0 + 0.22 * smoothstep(0.35, 0.9, dot(N, uUp));
    ao = (0.42 + 0.58 * smoothstep(0.04, 0.6, vY)) * (0.75 + 0.25 * smoothstep(0.25, 0.6, r2));
  #endif
  vec3 col = alb * (uSunColor * ndl * ao + uAmb * ao * (0.6 + 0.4 * max(dot(N, uUp), 0.0))) + extra;
  // the same air the terrain is seen through
  vec3 trans;
  vec3 insc = aScatter(uCamU, -V, dist / uRadius, uSun, 3, trans);
  col = col * trans + insc;
  gl_FragColor = vec4(col, 1.0);
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * @returns {{ group, update(camBodyFixed, ctx), drawCalls, instances, triangles, pending, dispose() }}
 * ctx = { sunDir (scene axes), rot (Matrix3 body-fixed → scene), camU (camera, unit-sphere space, scene axes),
 *         sunColor [r,g,b], amb [r,g,b], alt, time, day }
 */
export function createScatter(body, style, { quality = 'high' } = {}) {
  const sc = style.scatter, R = body.radius, faceSize = (Math.PI / 2) * R;
  const group = new THREE.Group(); group.name = 'scatter_' + body.id;
  const dens = quality === 'high' ? 1 : 0.6;
  const home = !!body.sites;
  const layers = [];
  const cellLevel = (size) => Math.max(0, Math.round(Math.log2(faceSize / size)));
  const atmoU = atmoUniforms(body);

  function makeLayer(name, define, geo, cellSize, radius, perTile, range, place, { sway = 0, side = THREE.FrontSide, shadowOf = null, farGeo = null, farDist = 0, stretch = 0, shadowDims = [2.6, 6.5, 0.12, 0.985], shadowGain = 1 } = {}) {
    const level = cellLevel(cellSize), span = 2 * radius + 1, slots = span * span + 2 * span;
    perTile = Math.max(1, Math.round(perTile));
    const uniforms = {
      ...atmoU,
      uSun: { value: new THREE.Vector3(1, 0, 0) }, uSunColor: { value: new THREE.Vector3(1, 1, 1) }, uAmb: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3(0, 1, 0) },
      uCamU: { value: new THREE.Vector3(0, 2, 0) }, uRadius: { value: R }, uRange: { value: range }, uTime: { value: 0 }, uSway: { value: sway }, uShadowK: { value: 0.5 }, uShadowGain: { value: shadowGain }, uShadowDims: { value: new THREE.Vector4(...shadowDims) },
    };
    const opts = { uniforms, defines: { [define]: 1 }, vertexShader: VS, fragmentShader: FS, side };
    if (shadowOf) Object.assign(opts, { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const mat = new THREE.ShaderMaterial(opts);
    const cap = shadowOf ? shadowOf.cap : slots * perTile;
    const mk = (geom, nm) => {
      const mesh = new THREE.InstancedMesh(geom, mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (shadowOf) mesh.renderOrder = 1;
      else { mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); mesh.instanceColor.setUsage(THREE.DynamicDrawUsage); }
      mesh.frustumCulled = false; mesh.count = 0; mesh.name = nm;
      group.add(mesh);
      return mesh;
    };
    const mesh = mk(geo, name);
    // a second, simpler model for the same objects beyond farDist (trees: most of a wood is far away)
    const farMesh = farGeo ? mk(farGeo, name + '_far') : null;
    if (shadowOf) shadowOf.shadow = mesh;
    const trisOf = (gm) => (gm.index ? gm.index.count : gm.attributes.position.count) / 3;
    const L = { name, mesh, farMesh, farDist, farTris: farGeo ? trisOf(farGeo) : 0, shadow: null, lastPack: new THREE.Vector3(), mat, uniforms, level, cells: 2 ** level, radius, perTile, range, place, cap, shadowOf, stretch, tris: trisOf(geo),
      slots: [], tiles: new Map(), anchor: new THREE.Vector3(), anchored: false, data: [], mats: [], cols: [], counts: [], dirty: false, face: -1, seed: layers.length * 7919 + 13 };
    if (!shadowOf) for (let i = 0; i < slots; i++) { L.slots.push(null); L.data.push(new Float64Array(perTile * 7)); L.mats.push(new Float32Array(perTile * 16)); L.cols.push(new Float32Array(perTile * 3)); L.counts.push(0); }
    layers.push(L);
    return L;
  }

  // world-space placement of one object: returns false to leave the slot empty
  const rockColor = sc.rockColor, grassColor = sc.grassColor || [0.3, 0.5, 0.2], dryColor = sc.dryColor || [0.6, 0.56, 0.3];
  const pad = home ? body.sites.pad.dir : null;
  const padCos = Math.cos(3080 / R);
  function ground(u, v, face, out) {
    faceDir(face, u, v, _d);
    if (pad && (_d.x * pad.x + _d.y * pad.y + _d.z * pad.z) > padCos) return false;
    const h = body.terrainHeight(_d, 0);
    if (body.ocean && h < body.seaLevel + 0.4) return false;
    out.x = _d.x; out.y = _d.y; out.z = _d.z; out.h = h;
    return true;
  }
  const g = { x: 0, y: 0, z: 0, h: 0 };
  const isGreen = (c) => c[1] > c[0] * 1.02;

  let boulders = null;
  if (sc.rocks) {
    const stone = (r, o, size, sink) => {
      body.surfaceColorAt(g, _rgb);
      const t = 0.72 + 0.45 * r(), w = 0.35 + 0.3 * r();           // some stones take the ground's colour, some keep their own
      o.set(g, size, r() * 6.283, (r() - 0.5) * 0.5, 0.6 + 0.6 * r(),
        (w * rockColor[0] + (1 - w) * _rgb[0]) * t, (w * rockColor[1] + (1 - w) * _rgb[1]) * t, (w * rockColor[2] + (1 - w) * _rgb[2]) * t, sink * size);
      return true;
    };
    // (boulders lie part-buried, a different depth each, and no two have the same proportions: see stretch in writeTile)
    boulders = makeLayer('boulders', 'ROCK', rockGeometry(2, 3), 64, 2, Math.max(3, sc.rocks * 1.5 * dens), 150, (r, face, u, v, o) => {
      if (!ground(u, v, face, g)) return false;
      const q = r();
      return stone(r, o, 0.4 + 1.1 * q * q * q + (r() < 0.04 ? 0.8 + 1.6 * r() : 0), -(0.04 + 0.13 * r()));
    }, { stretch: 0.3 });
    makeLayer('pebbles', 'ROCK', rockGeometry(1, 9), 20, 2, Math.max(4, sc.rocks * 4.5 * dens), 46, (r, face, u, v, o) => {
      if (!ground(u, v, face, g)) return false;
      const q = r();
      return stone(r, o, 0.06 + 0.34 * q * q, -0.03);
    }, { stretch: 0.3 });
  }
  if (sc.grass) {
    const tuft = (r, o, s, dryK) => {
      body.surfaceColorAt(g, _rgb);
      if (body.id === 'verda' ? !isGreen(_rgb) : Math.max(_rgb[0], _rgb[1], _rgb[2]) > 0.8) return false;      // on green ground only; not on ice
      // patches of thick and thin growth, and of dry straw among the green
      const k = 5200 * (R / 6.4e5);
      const patch = Math.sin(g.x * k + 3 * Math.sin(g.z * k * 0.43)) * Math.sin(g.y * k * 1.3 + 2 * Math.sin(g.x * k * 0.57)) + 0.5 * Math.sin(g.z * k * 2.9 + g.y * k * 2.2);
      if (r() < 0.25 - 0.3 * patch) return false;
      const t = 0.74 + 0.5 * r(), dry = r() < dryK + 0.18 * Math.max(0, -patch) ? 0.75 : 0.12 * r();
      const cr = grassColor[0] + (dryColor[0] - grassColor[0]) * dry, cg = grassColor[1] + (dryColor[1] - grassColor[1]) * dry, cb = grassColor[2] + (dryColor[2] - grassColor[2]) * dry;
      o.set(g, s * (1 + 0.25 * patch), r() * 6.283, 0, 0.75 + 0.6 * r(), (0.5 * cr + 0.5 * _rgb[0]) * t, (0.5 * cg + 0.5 * _rgb[1]) * t, (0.5 * cb + 0.5 * _rgb[2]) * t, -0.02);
      return true;
    };
    // a thick sward round the camera, then sparser, bigger tufts farther out where single blades cannot be seen
    makeLayer('sward', 'GRASS', grassGeometry(9, 0.14, 0.4, 0.012, 0.024, 0.24, 5), 9, 2, sc.grass * 7.5 * dens, 23, (r, face, u, v, o) => ground(u, v, face, g) && tuft(r, o, 0.6 + 0.8 * r(), 0.1), { sway: 0.05, side: THREE.DoubleSide });
    makeLayer('grass', 'GRASS', grassGeometry(5, 0.24, 0.55, 0.022, 0.04, 0.3, 8), 32, 2, sc.grass * 9 * dens, 80, (r, face, u, v, o) => ground(u, v, face, g) && tuft(r, o, 0.6 + 0.7 * r(), 0.14), { sway: 0.07, side: THREE.DoubleSide });
  }
  if (sc.trees) {
    const noise = (x, y, z) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); };
    const tree = (kind) => (r, face, u, v, o) => {
      if (!ground(u, v, face, g)) return false;
      if (g.h > 1500 || g.h < body.seaLevel + 3) return false;
      body.surfaceColorAt(g, _rgb);
      if (!(_rgb[1] > _rgb[0] * 1.25 && _rgb[1] > _rgb[2] * 1.2)) return false;                       // forests grow on the green
      // clumps: groves a few hundred metres across with clearings between
      const k = 2100;
      const grove = Math.sin(g.x * k * 1.3 + 4 * Math.sin(g.z * k * 0.7)) + Math.sin(g.y * k * 1.7 + 3 * Math.sin(g.x * k * 0.9)) + Math.sin(g.z * k * 2.3);
      if (grove < 0.25 - 1.2 * (_rgb[1] < 0.42 ? 1 : 0) + noise(g.x * 9e4, g.y * 9e4, g.z * 9e4) * 0.4) return false;
      // conifers keep to the higher, cooler ground; broadleaf trees to the low country; they mix in between
      const high = (g.h - 180) / 260 + (noise(g.z * 4e4, g.x * 4e4, g.y * 4e4) - 0.5) * 1.6;
      if ((high > 0) !== (kind === 0)) return false;
      const s = 0.65 + 0.85 * r(), t = 0.75 + 0.5 * r();
      if (kind === 0) o.set(g, s, r() * 6.283, (r() - 0.5) * 0.07, 0.9 + 0.35 * r(), (0.12 + 0.04 * r()) * t, (0.2 + 0.07 * r()) * t, 0.11 * t, -0.15);
      else o.set(g, s * 1.05, r() * 6.283, (r() - 0.5) * 0.1, 0.8 + 0.35 * r(), (0.13 + 0.06 * r()) * t, (0.24 + 0.07 * r()) * t, 0.08 * t, -0.15);
      return true;
    };
    const per = sc.trees * 270 * dens;
    const con = makeLayer('conifers', 'TREE', coniferGeometry(), 320, 2, per, 760, tree(0), { sway: 0.04, side: THREE.DoubleSide, farGeo: coniferGeometry(4, 6, 4), farDist: 150 });
    const bro = makeLayer('broadleaf', 'TREE', groveGeometry(), 320, 2, per, 760, tree(1), { sway: 0.05, farGeo: groveGeometry(true), farDist: 150 });
    makeLayer('shade_conifers', 'SHADOW', shadowGeometry(), 320, 2, per, 760, null, { shadowOf: con });
    makeLayer('shade_broadleaf', 'SHADOW', shadowGeometry(), 320, 2, per, 760, null, { shadowOf: bro });
  }

  // the shade a boulder throws: without it a stone on sunlit ground looks pasted on. (Made last, so the layers before
  // it keep the seeds they always had and every tree and tuft stays where it was.) Darker where there is no air to
  // light the shade.
  if (boulders) makeLayer('shade_boulders', 'SHADOW', shadowGeometry(), 64, 2, boulders.perTile, 150, null, { shadowOf: boulders, shadowDims: [1.15, 0.7, 0.03, 0.997], shadowGain: body.atmo ? 1.15 : 1.6 });

  // an object record: position (3 doubles), size, yaw, tilt, squash; colour kept beside it
  const rec = {
    f: null, i: 0, c: null, ci: 0,
    set(g, size, yaw, tilt, squash, cr, cg, cb, sink) {
      const f = this.f, i = this.i, rr = R + g.h + sink;
      f[i] = g.x * rr; f[i + 1] = g.y * rr; f[i + 2] = g.z * rr; f[i + 3] = size; f[i + 4] = yaw; f[i + 5] = tilt; f[i + 6] = squash;
      this.c[this.ci] = cr; this.c[this.ci + 1] = cg; this.c[this.ci + 2] = cb;
    },
  };

  /** matrices of one tile, relative to the layer's anchor */
  function writeTile(L, slot) {
    const f = L.data[slot], out = L.mats[slot], n = L.counts[slot];
    for (let k = 0; k < n; k++) {
      const i = k * 7;
      _p.set(f[i] - L.anchor.x, f[i + 1] - L.anchor.y, f[i + 2] - L.anchor.z);
      _up.set(f[i], f[i + 1], f[i + 2]).normalize();
      _q.setFromUnitVectors(Y, _up);
      _q2.setFromAxisAngle(Y, f[i + 4]); _q.multiply(_q2);
      if (f[i + 5]) { _q2.setFromAxisAngle(X, f[i + 5]); _q.multiply(_q2); }
      // (stones: longer one way than the other, by an amount taken from the yaw so it never changes)
      const st = L.stretch ? L.stretch * Math.sin(f[i + 4] * 7.3) : 0;
      _s.set(f[i + 3] * (1 + st), f[i + 3] * f[i + 6], f[i + 3] * (1 - st));
      _m.compose(_p, _q, _s);
      out.set(_m.elements, k * 16);
    }
  }

  function fillTile(L, slot, face, ix, iy) {
    const r = rng(hash(face, ix, iy, body.seed + L.seed));
    const f = L.data[slot], cols = L.cols[slot];
    const u0 = -1 + (2 * ix) / L.cells, du = 2 / L.cells, v0 = -1 + (2 * iy) / L.cells;
    let n = 0;
    for (let k = 0; k < L.perTile; k++) {
      rec.f = f; rec.i = n * 7; rec.c = cols; rec.ci = n * 3;
      if (L.place(r, face, u0 + r() * du, v0 + r() * du, rec)) n++;
    }
    L.counts[slot] = n;
    writeTile(L, slot);
  }

  /** pack every live tile's objects to the front of the instance buffers */
  function pack(L, camBF) {
    const mesh = L.mesh, M = mesh.instanceMatrix.array, C = mesh.instanceColor.array;
    const far = L.farMesh, FM = far && far.instanceMatrix.array, FC = far && far.instanceColor.array;
    const SM = L.shadow && L.shadow.instanceMatrix.array;
    const cx = camBF.x - L.anchor.x, cy = camBF.y - L.anchor.y, cz = camBF.z - L.anchor.z, d2 = L.farDist * L.farDist;
    let o = 0, of = 0, os = 0;
    for (let s = 0; s < L.slots.length; s++) {
      if (L.slots[s] === null) continue;
      const n = L.counts[s];
      if (!n) continue;
      const ms = L.mats[s], cs = L.cols[s];
      if (SM) { SM.set(ms.subarray(0, n * 16), os * 16); os += n; }
      if (!far) { M.set(ms.subarray(0, n * 16), o * 16); C.set(cs.subarray(0, n * 3), o * 3); o += n; continue; }
      for (let k = 0; k < n; k++) {
        const i = k * 16, dx = ms[i + 12] - cx, dy = ms[i + 13] - cy, dz = ms[i + 14] - cz;
        if (dx * dx + dy * dy + dz * dz < d2) { M.set(ms.subarray(i, i + 16), o * 16); C.set(cs.subarray(k * 3, k * 3 + 3), o * 3); o++; }
        else { FM.set(ms.subarray(i, i + 16), of * 16); FC.set(cs.subarray(k * 3, k * 3 + 3), of * 3); of++; }
      }
    }
    mesh.count = o;
    mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
    if (far) { far.count = of; far.instanceMatrix.needsUpdate = true; far.instanceColor.needsUpdate = true; far.position.copy(mesh.position); far.visible = of > 0; }
    if (L.shadow) { L.shadow.count = os; L.shadow.instanceMatrix.needsUpdate = true; }
    L.lastPack.copy(camBF);
    L.dirty = false;
  }

  function faceUV(dir) { const f = dirToFace(dir.x, dir.y, dir.z); return [f.face, f.u, f.v]; }

  const api = {
    group, drawCalls: layers.length, instances: 0, triangles: 0,
    update(camBF, ctx) {
      const cr = camBF.length(), alt = ctx.alt;
      const show = alt < 2500;
      group.visible = show;
      api.instances = 0; api.triangles = 0; api.drawCalls = 0;
      if (!show) return;
      _up.copy(camBF).divideScalar(cr);
      const [face, u, v] = faceUV(_up);
      const day = ctx.day;
      for (const L of layers) {
        const un = L.uniforms;
        un.uSun.value.copy(ctx.sunDir);
        un.uSunColor.value.set(ctx.sunColor[0], ctx.sunColor[1], ctx.sunColor[2]).multiplyScalar(SUN_SURFACE * day);
        un.uAmb.value.set(ctx.amb[0], ctx.amb[1], ctx.amb[2]).multiplyScalar(Math.max(0.15, day)).addScalar(style.fill != null ? style.fill : 0.05);
        un.uUp.value.copy(_up).applyMatrix3(ctx.rot);
        if (ctx.camU) un.uCamU.value.copy(ctx.camU);
        un.uTime.value = ctx.time;
        un.uShadowK.value = 0.52 * day * Math.min(1, (ctx.sunColor[0] + ctx.sunColor[1] + ctx.sunColor[2]) / 1.5);
        L.mesh.visible = alt < L.range * 2.5;
        if (!L.mesh.visible) { if (L.farMesh) L.farMesh.visible = false; continue; }
        if (L.shadowOf) {
          const T = L.shadowOf;
          L.mesh.position.copy(T.mesh.position); L.mesh.visible = T.mesh.visible && L.mesh.count > 0 && un.uShadowK.value > 0.01;
          if (L.mesh.visible) { api.drawCalls++; api.triangles += L.mesh.count * L.tris; }
          continue;
        }
        // keep instance coordinates small: re-anchor when the camera has moved far from the anchor
        if (!L.anchored || L.anchor.distanceTo(camBF) > 1500) {
          L.anchor.copy(camBF).setLength(R); L.anchored = true;
          L.mesh.position.copy(L.anchor);
          for (let s = 0; s < L.slots.length; s++) if (L.slots[s] !== null) writeTile(L, s);
          L.dirty = true;
        }
        if (L.face !== face) { L.face = face; L.tiles.clear(); L.slots.fill(null); L.dirty = true; }
        const ci = Math.floor((u + 1) / 2 * L.cells), cj = Math.floor((v + 1) / 2 * L.cells);
        const want = new Set();
        for (let dj = -L.radius; dj <= L.radius; dj++) for (let di = -L.radius; di <= L.radius; di++) {
          const ix = ci + di, iy = cj + dj;
          if (ix < 0 || iy < 0 || ix >= L.cells || iy >= L.cells) continue;       // (cube-face edges: clutter stops at the seam)
          want.add(ix * 4194304 + iy);
        }
        for (const [key, slot] of L.tiles) if (!want.has(key)) { L.tiles.delete(key); L.slots[slot] = null; L.dirty = true; }
        let budget = 2;
        for (const key of want) {
          if (L.tiles.has(key) || budget <= 0) continue;
          const slot = L.slots.indexOf(null);
          if (slot < 0) break;
          L.slots[slot] = key; L.tiles.set(key, slot);
          fillTile(L, slot, face, Math.floor(key / 4194304), key % 4194304);
          L.dirty = true;
          budget--;
        }
        L.wantCount = want.size;
        if (L.dirty || (L.farMesh && L.lastPack.distanceTo(camBF) > 10)) pack(L, camBF);
        if (L.mesh.count > 0) { api.drawCalls++; api.instances += L.mesh.count; api.triangles += L.mesh.count * L.tris; }
        if (L.farMesh && L.farMesh.count > 0) { api.drawCalls++; api.instances += L.farMesh.count; api.triangles += L.farMesh.count * L.farTris; }
      }
    },
    /** tiles still to be filled (first frame / screenshots) */
    get pending() { let n = 0; for (const L of layers) if (!L.shadowOf && L.mesh.visible) n += (L.wantCount ?? (2 * L.radius + 1) ** 2) - L.tiles.size; return n; },
    dispose() { for (const L of layers) { L.mesh.geometry.dispose(); L.mat.dispose(); L.mesh.dispose(); if (L.farMesh) { L.farMesh.geometry.dispose(); L.farMesh.dispose(); } } },
  };
  return api;
}
