// Starwright — vegetation for scenes lit by three.js lights (the Flight Center in the hub, on the title page and in
// flight): trees with three levels of detail, their shadows, and grass round the camera.
//
//   createTreeSystem({ trees, detail, groundLift })  → { group, update(dt, env), setDetail(level), prepare(renderer), stats, dispose() }
//       trees: [{ x, y, z, species, scale, yaw, leanX, leanZ, tint: [r, g, b] }] in the group's own frame (y up)
//       env:   { camera?, sunDir (group frame), night }
//   createGrass({ mask, planetRadius, detail })      → { group, update(dt, env), setDetail(level), stats, dispose() }
//   VEG_LEVELS, vegLevel(setting, quality, governorDetail)
//
// Trees. Each species has a full mesh (near), a reduced mesh of the same skeleton (mid) and a camera-facing impostor
// (far) whose 8 × 3 views are rendered once from the full mesh into an atlas (albedo + normals, so impostors are lit
// by the real sun). Which level draws a tree is decided per instance in the vertex shader from its distance in units
// of its own size; the hand-over is a screen-door cross-fade (two levels draw complementary pixels), so nothing
// pops. The CPU only sorts instances into the buffers of the levels that can draw them (with a margin), when the
// camera has moved. Distances come from the size of the picture in pixels, so a smaller render scale (the automatic
// governor) or a lower detail level draws fewer full trees without any other bookkeeping.
// Leaves are alpha-tested cards with crown-wide normals (a crown shades as one soft volume), darker toward the
// inside (vertex ambient occlusion), lit from behind when the sun is seen through them, and they move in the wind.
// Shadows: the two mesh levels cast into the scene's shadow map (cut-out, moving with the wind); impostors, and any
// tree outside the shadow map's reach, lay a soft blot on the ground instead, stretched away from the sun.
import * as THREE from '../lib/three.module.min.js';
import { SPECIES, SPECIES_IDS, buildTree, lodDistances } from './treegen.js';
import { leafAtlas, barkTextures, blobTexture, loadFloraAssets, floraAssets } from './floratex.js';
export { loadFloraAssets, floraAssets };

/** Vegetation detail levels, lowest first. `off` keeps impostors only where a level says so. */
export const VEG_LEVELS = ['low', 'medium', 'high', 'ultra'];
/**
 * The level in force: the player's setting (or 'auto' = follow the Detail setting), lowered by `drop` steps
 * (the automatic governor's `detail` field: 0 = as set).
 */
export function vegLevel(setting, quality = 'high', drop = 0) {
  let i = VEG_LEVELS.indexOf(setting);
  if (i < 0) i = quality === 'low' || quality === 'soft' ? 0 : quality === 'medium' ? 1 : 2;
  return VEG_LEVELS[Math.max(0, Math.min(VEG_LEVELS.length - 1, i - Math.max(0, drop | 0)))];
}

const LEAF_GAIN = 1.65;        // the painted leaves are dark (they are painted with their own shading); this brings a sunlit crown to the brightness of sunlit turf
const BARK_GAIN_PHOTO = 0.9;
// Scanned leaves are photographed lit from the front on a white bed: far brighter and yellower than a leaf's own
// colour in a crown. These bring each species to its colour in the field (pine and palm cells are still painted).
const PHOTO_TINT = { oak: [0.52, 0.54, 0.46], maple: [0.74, 0.62, 0.6], birch: [0.6, 0.63, 0.46], spruce: [0.72, 0.8, 0.74], bush: [0.66, 0.62, 0.5], pine: [1.85, 1.8, 1.55], palm: [1.5, 1.5, 1.1] };
const leafTint = (sp, id, atlas) => (atlas.userData.photo && PHOTO_TINT[id] ? new THREE.Vector3(...PHOTO_TINT[id]) : new THREE.Vector3(...sp.leafTint).multiplyScalar(LEAF_GAIN));
const barkTint = (sp, bark) => (bark.photo ? new THREE.Vector3(BARK_GAIN_PHOTO, BARK_GAIN_PHOTO, BARK_GAIN_PHOTO) : new THREE.Vector3(...sp.barkTint));
const IMP = { yaws: 8, rows: 3, els: [0.14, 0.62, 1.13] };       // impostor views: 8 round, at 8°, 35° and 65° above the horizon
const DITHER = 'fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))';

const WIND_GLSL = /* glsl */`
  vec3 iOrigin = vec3(instanceMatrix[3]);
  float iScale = length(vec3(instanceMatrix[1]));
  {
    float ph = iOrigin.x * 0.11 + iOrigin.z * 0.13;
    float gust = 0.55 + 0.45 * sin(uTime * 0.31 + ph * 0.21);
    vec2 sw = vec2(sin(uTime * 1.1 + ph) + 0.5 * sin(uTime * 2.3 + ph * 1.7), cos(uTime * 0.9 + ph * 1.3));
    transformed.xz += sw * leaf.y * uWind * gust * 0.3;
    float fl = leaf.z * uWind * (0.5 + 0.5 * gust);
    transformed += vec3(sin(uTime * 3.7 + position.x * 1.9 + position.y * 2.3 + ph), sin(uTime * 4.3 + position.z * 2.1 + ph) * 0.6, cos(uTime * 3.1 + position.y * 1.7 + ph)) * fl * 0.06;
  }
  {
    float dC = distance((modelMatrix * vec4(iOrigin, 1.0)).xyz, uCamPos) / iScale;
    vFadeK = vec2(uFade.y > 0.0 ? smoothstep(uFade.x, uFade.x + uFade.y, dC) : 1.0, uFade.w > 0.0 ? smoothstep(uFade.z, uFade.z + uFade.w, dC) : 0.0);
  }`;
// Foliage is never fully in shadow: light leaks through a crown. three's own light loop, with the sun's shadow softened.
const SHADOW_RE = /directLight\.color\s*\*=\s*\(\s*directLight\.visible\s*&&\s*receiveShadow\s*\)\s*\?\s*(getShadow\(\s*directionalShadowMap[^;]*?\))\s*:\s*1\.0\s*;/;
let LIGHTS_SOFT = null;
function softLights(k) {
  if (LIGHTS_SOFT === null) {
    const src = THREE.ShaderChunk.lights_fragment_begin;
    LIGHTS_SOFT = SHADOW_RE.test(src) ? src.replace(SHADOW_RE, 'directLight.color *= ( directLight.visible && receiveShadow ) ? mix( 1.0 - SW_SHADOW, 1.0, $1 ) : 1.0;') : '';
    if (!LIGHTS_SOFT) console.warn('[flora] three.js light chunk changed: foliage takes full shadows');
  }
  return LIGHTS_SOFT ? `#define SW_SHADOW ${k.toFixed(2)}\n` + LIGHTS_SOFT : '#include <lights_fragment_begin>';
}
const TRANSLUCENT_GLSL = /* glsl */`
  #if NUM_DIR_LIGHTS > 0
  {
    // leaves let light through: a crown seen against the sun glows, and its shaded side is never dead
    vec3 Ls = directionalLights[0].direction, Vv = normalize(vViewPosition);
    float back = pow(clamp(dot(-Vv, Ls), 0.0, 1.0), 3.0), wrap = clamp(dot(normal, Ls) * 0.5 + 0.5, 0.0, 1.0);
    reflectedLight.directDiffuse += directionalLights[0].color * diffuseColor.rgb * RECIPROCAL_PI * thin * (back * 0.8 + 0.1 * wrap) * vec3(1.12, 1.08, 0.5);
    // the waxy upper side of a leaf glints where it mirrors the sun
    vec3 Hh = normalize(Ls + Vv); float nl = clamp(dot(normal, Ls), 0.0, 1.0);
    reflectedLight.directDiffuse += directionalLights[0].color * (sheen * nl * pow(clamp(dot(normal, Hh), 0.0, 1.0), 48.0) * 0.045);
  }
  #endif
  // sunlit leaves are warm and bright, the shaded side takes the cool light of the sky (and never goes dead at dusk)
  reflectedLight.directDiffuse *= mix(vec3(1.0), vec3(1.3, 1.16, 0.84), thin);
  reflectedLight.indirectDiffuse *= mix(vec3(1.0), vec3(1.45, 1.6, 1.85), thin);`;

function treeGeometry(id, lod, seed) {
  const t = buildTree(id, { lod, seed }), g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(t.position, 3)); g.setAttribute('normal', new THREE.BufferAttribute(t.normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(t.uv, 2)); g.setAttribute('bark', new THREE.BufferAttribute(t.bark, 3)); g.setAttribute('leaf', new THREE.BufferAttribute(t.leaf, 3));
  g.setIndex(new THREE.BufferAttribute(t.index, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, t.height / 2, 0), Math.hypot(t.radius, t.height / 2) + 1);
  g.userData.tree = t;
  return g;
}

/** Materials of one species' mesh levels (colour pass + shadow pass). `fade` is that level's own uniform. */
function meshMaterials(sp, U, fade, atlas, bark, id) {
  const mat = new THREE.MeshLambertMaterial({ map: atlas, side: THREE.DoubleSide, alphaToCoverage: true });
  const un = { uTime: U.uTime, uWind: U.uWind, uCamPos: U.uCamPos, uFade: fade, uBark: { value: bark.map }, uBarkN: { value: bark.normalMap }, uLeafTint: { value: leafTint(sp, id, atlas) }, uBarkTint: { value: barkTint(sp, bark) }, uLeafN: { value: atlas.userData.tilt } };
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, un);
    sh.vertexShader = 'attribute vec3 bark; attribute vec3 leaf; uniform float uTime, uWind; uniform vec4 uFade; uniform vec3 uCamPos; varying vec3 vBark, vLeaf; varying vec2 vFadeK;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_GLSL + '\n vBark = bark; vLeaf = leaf;');
    sh.fragmentShader = 'uniform sampler2D uBark, uBarkN, uLeafN; uniform vec3 uLeafTint, uBarkTint; varying vec3 vBark, vLeaf; varying vec2 vFadeK;\n' + sh.fragmentShader
      .replace('#include <map_fragment>', /* glsl */`
        float isBark = step(0.5, vBark.z), thin = (1.0 - isBark) * vLeaf.x;
        vec4 lt = texture2D(map, vMapUv), bt = texture2D(uBark, vBark.xy);
        vec3 tl = texture2D(uLeafN, vMapUv).xyz;
        float sheen = (1.0 - isBark) * tl.z * vLeaf.x;
        float la = mix(lt.a, 1.0, isBark);
        la = (la - 0.4) / max(fwidth(la), 0.0001) + 0.5;
        float dn = ${DITHER};
        if (dn >= vFadeK.x || dn < vFadeK.y || la <= 0.0) discard;
        diffuseColor.rgb *= mix(lt.rgb * uLeafTint, bt.rgb * uBarkTint, isBark) * mix(1.0, vLeaf.x, 0.9);
        diffuseColor.a = clamp(la, 0.0, 1.0);`)
      .replace('#include <normal_fragment_begin>', /* glsl */`#include <normal_fragment_begin>
        if (isBark < 0.5) {
          // the crown's own rounded normal, turned a little the way this leaf leans: leaves side by side take the sun differently
          vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition), gN = normalize(cross(q0, q1)); vec2 st0 = dFdx(vMapUv), st1 = dFdy(vMapUv);
          vec3 q1p = cross(q1, gN), q0p = cross(gN, q0), Tt = q1p * st0.x + q0p * st1.x, Bt = q1p * st0.y + q0p * st1.y;
          float det = max(dot(Tt, Tt), dot(Bt, Bt)), sc = det == 0.0 ? 0.0 : inversesqrt(det);
          vec2 lean = tl.xy * 2.0 - 1.0;
          normal = normalize(normalize(vNormal) + (Tt * lean.x + Bt * lean.y) * (sc * 0.9));
        } else {
          vec3 nt = texture2D(uBarkN, vBark.xy).xyz * 2.0 - 1.0; nt.xy *= 1.4;
          vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition); vec2 st0 = dFdx(vBark.xy), st1 = dFdy(vBark.xy);
          vec3 q1p = cross(q1, normal), q0p = cross(normal, q0), Tt = q1p * st0.x + q0p * st1.x, Bt = q1p * st0.y + q0p * st1.y;
          float det = max(dot(Tt, Tt), dot(Bt, Bt)), sc = det == 0.0 ? 0.0 : inversesqrt(det);
          normal = normalize(Tt * (nt.x * sc) + Bt * (nt.y * sc) + normal * nt.z);
        }`)
      .replace('#include <lights_fragment_begin>', softLights(0.62)).replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + TRANSLUCENT_GLSL);
  };
  mat.customProgramCacheKey = () => 'sw-tree-mesh';
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.4, side: THREE.DoubleSide });
  depth.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { uTime: U.uTime, uWind: U.uWind, uCamPos: U.uCamPos, uFade: fade });
    sh.vertexShader = 'attribute vec3 leaf; uniform float uTime, uWind; uniform vec4 uFade; uniform vec3 uCamPos; varying vec2 vFadeK;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_GLSL);
    sh.fragmentShader = 'varying vec2 vFadeK;\n' + sh.fragmentShader.replace('#include <map_fragment>', `float dn = ${DITHER}; if (dn >= vFadeK.x || dn < vFadeK.y) discard;\n#include <map_fragment>`);
  };
  depth.customProgramCacheKey = () => 'sw-tree-depth';
  return { mat, depth };
}

const IMP_VS_HEAD = /* glsl */`attribute vec4 aImp; uniform vec4 uFade; uniform vec3 uCamPos; varying vec4 vImp; varying vec2 vUvQ, vFadeK; varying mat3 vRot;\n`;
const IMP_VS = /* glsl */`
  vec3 transformed = vec3(0.0);
  mat3 iR = mat3(instanceMatrix), mR = mat3(modelMatrix);
  float iScale = length(iR[1]);
  vec3 cW = (modelMatrix * vec4(vec3(instanceMatrix[3]) + iR[1] * aImp.z, 1.0)).xyz;
  vec3 toCam = uCamPos - cW; float dCam = max(length(toCam), 0.001); vec3 vdir = toCam / dCam;
  mat3 wR = mR * iR;                                                   // tree axes in the world (scaled)
  vec3 vl = vec3(dot(vdir, wR[0]), dot(vdir, wR[1]), dot(vdir, wR[2])) / iScale;
  float el = asin(clamp(vl.y, -1.0, 1.0));
  float row = el < 0.38 ? 0.0 : (el < 0.87 ? 1.0 : 2.0);
  float yawF = atan(vl.x, vl.z) * (${IMP.yaws}.0 / 6.2831853), f0 = floor(yawF);
  vImp = vec4(mod(f0 + ${IMP.yaws * 4}.0, ${IMP.yaws}.0), mod(f0 + ${IMP.yaws * 4 + 1}.0, ${IMP.yaws}.0), aImp.x * ${IMP.rows}.0 + row, yawF - f0);
  vec3 upW = wR[1] / iScale;
  vec3 rightW = normalize(cross(upW, vdir) + vec3(1e-4, 0.0, 2e-4)), topW = cross(vdir, rightW);
  vec3 bw = cW + (rightW * position.x + topW * position.y) * (aImp.y * iScale);
  vUvQ = uv;
  vRot = mat3(viewMatrix) * (wR / iScale);
  { float dC = distance((modelMatrix * vec4(vec3(instanceMatrix[3]), 1.0)).xyz, uCamPos) / iScale; vFadeK = vec2(uFade.y > 0.0 ? smoothstep(uFade.x, uFade.x + uFade.y, dC) : 1.0, 0.0); }`;

function impostorMaterial(U, fade, rtA, rtN, nSpecies) {
  const mat = new THREE.MeshLambertMaterial({ alphaToCoverage: true });
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { uFade: fade, uCamPos: U.uCamPos, uImpA: { value: rtA.texture }, uImpN: { value: rtN.texture } });
    sh.vertexShader = IMP_VS_HEAD + sh.vertexShader.replace('#include <begin_vertex>', IMP_VS)
      .replace('#include <project_vertex>', 'vec4 mvPosition = viewMatrix * vec4(bw, 1.0);\n gl_Position = projectionMatrix * mvPosition;')
      .replace('#include <worldpos_vertex>', 'vec4 worldPosition = vec4(bw, 1.0);');
    sh.fragmentShader = 'uniform sampler2D uImpA, uImpN; varying vec4 vImp; varying vec2 vUvQ, vFadeK; varying mat3 vRot;\n' + sh.fragmentShader
      .replace('#include <map_fragment>', /* glsl */`
        vec2 cs = vec2(1.0 / ${IMP.yaws}.0, 1.0 / ${nSpecies * IMP.rows}.0), q = clamp(vUvQ, 0.008, 0.992);
        vec2 uvA = (vec2(vImp.x, vImp.z) + q) * cs, uvB = (vec2(vImp.y, vImp.z) + q) * cs;
        vec4 ia = mix(texture2D(uImpA, uvA), texture2D(uImpA, uvB), vImp.w), inr = mix(texture2D(uImpN, uvA), texture2D(uImpN, uvB), vImp.w);
        float ial = min(ia.a * 1.25, 1.0), la = (ial - 0.3) / max(fwidth(ial), 0.0001) + 0.5;
        float dn = ${DITHER};
        if (dn >= vFadeK.x || la <= 0.0) discard;
        float thin = inr.a, sheen = 0.0;
        diffuseColor.rgb *= ia.rgb * ia.rgb;
        diffuseColor.a = clamp(la, 0.0, 1.0);`)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize(vRot * (inr.xyz * 2.0 - 1.0));')
      .replace('#include <lights_fragment_begin>', softLights(0.62)).replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + TRANSLUCENT_GLSL);
  };
  mat.customProgramCacheKey = () => 'sw-tree-impostor-' + nSpecies;
  return mat;
}

const BAKE_VS = /* glsl */`attribute vec3 bark; attribute vec3 leaf; varying vec2 vUv; varying vec3 vBark, vLeaf, vN;
void main(){ vUv = uv; vBark = bark; vLeaf = leaf; vN = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BAKE_FS = /* glsl */`uniform sampler2D map, uBark; uniform vec3 uLeafTint, uBarkTint; uniform float uMode; uniform vec3 uView; varying vec2 vUv; varying vec3 vBark, vLeaf, vN;
void main(){
  float isBark = step(0.5, vBark.z);
  vec4 lt = texture2D(map, vUv), bt = texture2D(uBark, vBark.xy);
  if (mix(lt.a, 1.0, isBark) < 0.4) discard;
  if (uMode < 0.5) { vec3 c = mix(lt.rgb * uLeafTint, bt.rgb * uBarkTint, isBark) * mix(1.0, vLeaf.x, 0.9); gl_FragColor = vec4(sqrt(max(c, 0.0)), 1.0); }
  else { vec3 n = normalize(vN); if (dot(n, uView) < 0.0 && isBark < 0.5) n = -n; n = normalize(n + uView * 0.35 * (1.0 - isBark)); gl_FragColor = vec4(n * 0.5 + 0.5, (1.0 - isBark) * vLeaf.x); }
}`;

const BLOB_VS = /* glsl */`#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec2 aBlob; uniform vec3 uSunL, uCamPos; uniform vec4 uFade, uCover; uniform float uLift, uPR;
varying vec2 vUvB; varying float vK, vDist;
void main(){
  vec3 o = vec3(instanceMatrix[3]); float s = length(vec3(instanceMatrix[1]));
  vec2 hs = uSunL.xz; float hl = max(length(hs), 1e-4); vec2 away = -hs / hl;
  float cot = min(hl / max(uSunL.y, 0.03), 2.4);
  float r = aBlob.x * s, h = aBlob.y * s, len = h * cot;
  vec2 q = position.x * vec2(-away.y, away.x) * r * 1.25 + away * (position.y * (r * 1.15 + len * 0.5) + len * 0.56);
  vec3 pl = vec3(o.x + q.x, o.y + uLift, o.z + q.y);
  if (uPR > 0.0) pl.y += (dot(o.xz, o.xz) - dot(pl.xz, pl.xz)) / (2.0 * uPR);          // follow the curve of the ground
  vec4 wp = modelMatrix * vec4(pl, 1.0);
  vec3 ow = (modelMatrix * vec4(o, 1.0)).xyz;
  float dC = distance(ow, uCamPos) / s;
  float far = uFade.y > 0.0 ? smoothstep(uFade.x, uFade.x + uFade.y, dC) : 1.0;
  float uncovered = uCover.w > 0.0 ? smoothstep(uCover.w * 0.82, uCover.w, max(abs(ow.x - uCover.x), max(abs(ow.y - uCover.y), abs(ow.z - uCover.z)))) : 1.0;
  vK = max(far, uncovered);
  vUvB = uv; vDist = distance(wp.xyz, cameraPosition);
  gl_Position = vK > 0.003 ? projectionMatrix * viewMatrix * wp : vec4(2.0, 2.0, 2.0, 1.0);
  #include <logdepthbuf_vertex>
}`;
const BLOB_FS = /* glsl */`#include <logdepthbuf_pars_fragment>
uniform sampler2D uBlob; uniform float uK, uFogD; uniform vec3 uShade; varying vec2 vUvB; varying float vK, vDist;
void main(){
  #include <logdepthbuf_fragment>
  float t = 1.0 - texture2D(uBlob, vUvB).r;
  float k = t * uK * vK * exp(-uFogD * uFogD * vDist * vDist) * (1.0 - smoothstep(2500.0, 5000.0, vDist));
  gl_FragColor = vec4(mix(vec3(1.0), uShade, clamp(k * 1.9, 0.0, 1.0)), 1.0);
}`;

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _sz = new THREE.Vector2();
function noCast(mesh) { Object.defineProperty(mesh, 'castShadow', { get: () => false, set: () => {}, configurable: true }); return mesh; }

export function createTreeSystem({ trees = [], detail = 'high', groundLift = 0.11, planetRadius = 0, shadows = true } = {}) {
  const group = new THREE.Group(); group.name = 'trees';
  const high = detail !== 'low';
  const atlas = leafAtlas(high ? 2048 : 1024), barks = barkTextures();
  const U = { uTime: { value: 0 }, uWind: { value: 1 }, uCamPos: { value: new THREE.Vector3(0, 1e6, 0) } };
  const fades = [{ value: new THREE.Vector4(0, 0, 60, 12) }, { value: new THREE.Vector4(60, 12, 200, 40) }, { value: new THREE.Vector4(200, 40, 0, 0) }];
  const used = SPECIES_IDS.filter(id => trees.some(t => t.species === id));
  const bySpecies = used.map((id, si) => {
    const list = trees.filter(t => t.species === id), sp = SPECIES[id], n = list.length;
    const mats = new Float32Array(n * 16), cols = new Float32Array(n * 3);
    list.forEach((t, i) => {
      _q.setFromEuler(_e.set(t.leanX || 0, t.yaw || 0, t.leanZ || 0, 'YXZ'));
      _m.compose(_v.set(t.x, t.y || 0, t.z), _q, _s.set(t.scale, t.scale * (t.tall || 1), t.scale)); _m.toArray(mats, i * 16);
      const c = t.tint || [1, 1, 1]; cols[i * 3] = c[0]; cols[i * 3 + 1] = c[1]; cols[i * 3 + 2] = c[2];
    });
    const geos = [treeGeometry(id, id === 'bush' ? 1 : 0, 3 + si), treeGeometry(id, 1, 3 + si)]      /* shrubs and tall grass: always the light mesh */, T = geos[0].userData.tree;
    // the impostor frames the whole tree: a sphere round the middle of its bounding box
    const cy = T.height / 2, rad = Math.hypot(T.radius, T.height / 2) * 1.02;
    const lods = geos.map((g, k) => {
      const { mat, depth } = meshMaterials(sp, U, fades[k], atlas, barks[sp.bark], id);
      const im = new THREE.InstancedMesh(g, mat, Math.max(1, n)); im.name = `trees:${id}:lod${k}`;
      im.customDepthMaterial = depth; im.castShadow = shadows && id !== 'bush'; if (id === 'bush') noCast(im); im.receiveShadow = true; im.frustumCulled = false; im.count = 0;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3), 3); im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      group.add(im);
      return im;
    });
    return { id, sp, si, n, mats, cols, geos, lods, cy, rad, T };
  });
  const total = trees.length, nSp = Math.max(1, bySpecies.length);

  // ---- impostors: one instanced quad for every species, an atlas of views baked from the full meshes
  const cell = detail === 'low' ? 64 : detail === 'medium' ? 96 : 128;
  const rtOpts = { depthBuffer: true, samples: 4, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, type: THREE.UnsignedByteType, colorSpace: THREE.NoColorSpace };
  const rtA = new THREE.WebGLRenderTarget(cell * IMP.yaws, cell * IMP.rows * nSp, rtOpts), rtN = new THREE.WebGLRenderTarget(cell * IMP.yaws, cell * IMP.rows * nSp, rtOpts);
  rtA.texture.name = 'treeImpostorAlbedo'; rtN.texture.name = 'treeImpostorNormal';
  const impGeo = new THREE.PlaneGeometry(2, 2);
  const impAttr = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, total) * 4), 4); impAttr.setUsage(THREE.DynamicDrawUsage);
  impGeo.setAttribute('aImp', impAttr);
  const impMat = impostorMaterial(U, fades[2], rtA, rtN, nSp);
  const imp = noCast(new THREE.InstancedMesh(impGeo, impMat, Math.max(1, total))); imp.name = 'trees:impostors';
  imp.receiveShadow = false; imp.frustumCulled = false; imp.count = 0; imp.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  imp.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, total) * 3), 3); imp.instanceColor.setUsage(THREE.DynamicDrawUsage);
  group.add(imp);

  // ---- ground blots (static: one quad per tree; the shader decides where they show)
  const blobGeo = new THREE.PlaneGeometry(2, 2);
  const blobAttr = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, total) * 2), 2); blobGeo.setAttribute('aBlob', blobAttr);
  const BU = { uSunL: { value: new THREE.Vector3(0.3, 0.8, 0.2) }, uCamPos: U.uCamPos, uFade: fades[2], uCover: { value: new THREE.Vector4(0, 0, 0, 0) }, uLift: { value: groundLift }, uPR: { value: planetRadius },
    uBlob: { value: blobTexture() }, uK: { value: 0.5 }, uFogD: { value: 0 }, uShade: { value: new THREE.Color(0.5, 0.56, 0.68) } };
  const blobMat = new THREE.ShaderMaterial({ uniforms: BU, vertexShader: BLOB_VS, fragmentShader: BLOB_FS, blending: THREE.MultiplyBlending, transparent: true, depthWrite: false, toneMapped: false });
  const blobs = new THREE.InstancedMesh(blobGeo, blobMat, Math.max(1, total)); blobs.name = 'trees:blots'; blobs.frustumCulled = false; blobs.renderOrder = 3; blobs.count = total;
  { let o = 0; for (const S of bySpecies) for (let i = 0; i < S.n; i++, o++) { blobs.instanceMatrix.array.set(S.mats.subarray(i * 16, i * 16 + 16), o * 16); blobAttr.array[o * 2] = S.sp.kind === 'bush' ? 0 : S.T.crownRadius * 0.92; blobAttr.array[o * 2 + 1] = S.T.center[1]; } }
  blobs.instanceMatrix.needsUpdate = true;
  group.add(blobs);

  // ---- a driver that is drawn first: learns the camera, the picture size and the shadow light; bakes on first use
  const cam = { pos: new THREE.Vector3(0, 1e6, 0), local: new THREE.Vector3(0, 1e6, 0), fov: 40, h: 800, known: false };
  let baked = false, level = detail, lod = lodDistances(800, 40, level), lodKey = '', binAt = new THREE.Vector3(1e9, 0, 0), light = null, lightScan = 0;
  const driver = noCast(new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false })));
  driver.frustumCulled = false; driver.renderOrder = -1000; driver.name = 'trees:driver';
  driver.onBeforeRender = (renderer, scene, camera) => {
    if (!baked) bake(renderer);
    const rt = renderer.getRenderTarget();
    see(camera, rt ? rt.height : renderer.getDrawingBufferSize(_sz).y);
    if (!light || lightScan-- <= 0) { light = null; lightScan = 240; scene.traverse(o => { if (!light && o.isDirectionalLight && o.shadow && o.shadow.camera && o.castShadow !== undefined && (o.castShadow || o.name === 'sun')) light = o; }); }
    if (light && light.castShadow && renderer.shadowMap.enabled && shadows) { light.target.getWorldPosition(_v); const sc = light.shadow.camera; BU.uCover.value.set(_v.x, _v.y, _v.z, Math.min(sc.right, sc.top)); } else BU.uCover.value.w = 0;
    BU.uFogD.value = scene.fog && scene.fog.isFogExp2 ? scene.fog.density : 0;
  };
  group.add(driver);

  function see(camera, pixelHeight) {
    camera.getWorldPosition(cam.pos); U.uCamPos.value.copy(cam.pos);
    group.updateWorldMatrix(true, false); cam.local.copy(cam.pos); group.worldToLocal(cam.local);
    cam.fov = camera.fov || 40; cam.h = pixelHeight || cam.h; cam.known = true;
  }

  function bake(renderer) {
    baked = true;
    const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevShadow = renderer.shadowMap.autoUpdate, prevColor = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha(), prevXR = renderer.xr.enabled, prevScissor = renderer.getScissorTest();
    renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = false; renderer.autoClear = false;
    const scene = new THREE.Scene(), oc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    const avg = (atlas.userData.average && atlas.userData.average[0]) || [60, 90, 40];
    for (const [rt, mode] of [[rtA, 0], [rtN, 1]]) {
      rt.scissorTest = false; rt.viewport.set(0, 0, rt.width, rt.height);
      renderer.setRenderTarget(rt);
      // three premultiplies the clear colour by its alpha, which would leave black behind the leaves and darken every
      // mip level and edge; clear through GL so the transparent texels keep the leaf colour (and a neutral normal)
      const gl = renderer.getContext(), lin = k => Math.sqrt(Math.pow(avg[k] / 255, 2.2) * 0.85);
      if (mode === 0) gl.clearColor(lin(0), lin(1), lin(2), 0); else gl.clearColor(0.5, 0.85, 0.5, 0);
      gl.clearDepth(1); gl.depthMask(true); gl.colorMask(true, true, true, true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      renderer.setClearColor(0x010203, 0.5); renderer.state.buffers.depth.setMask(true); renderer.state.buffers.color.setMask(true);
      rt.scissorTest = true;
      for (const S of bySpecies) {
        const mat = new THREE.ShaderMaterial({ uniforms: { map: { value: atlas }, uBark: { value: barks[S.sp.bark].map }, uLeafTint: { value: leafTint(S.sp, S.id, atlas) }, uBarkTint: { value: barkTint(S.sp, barks[S.sp.bark]) }, uMode: { value: mode }, uView: { value: new THREE.Vector3() } }, vertexShader: BAKE_VS, fragmentShader: BAKE_FS, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(S.geos[0], mat); mesh.frustumCulled = false; scene.add(mesh);
        oc.left = oc.bottom = -S.rad; oc.right = oc.top = S.rad; oc.near = 0.1; oc.far = S.rad * 4; oc.updateProjectionMatrix();
        for (let r = 0; r < IMP.rows; r++) for (let y = 0; y < IMP.yaws; y++) {
          const a = (y / IMP.yaws) * Math.PI * 2, el = IMP.els[r];
          oc.position.set(Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el)).multiplyScalar(S.rad * 2).add(_v.set(0, S.cy, 0));
          mat.uniforms.uView.value.set(Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el));
          oc.up.set(0, 1, 0); oc.lookAt(0, S.cy, 0); oc.updateMatrixWorld(true);
          rt.viewport.set(y * cell, (S.si * IMP.rows + r) * cell, cell, cell); rt.scissor.copy(rt.viewport);
          renderer.setRenderTarget(rt);
          renderer.render(scene, oc);
        }
        scene.remove(mesh); mat.dispose();
      }
      rt.scissorTest = false; rt.viewport.set(0, 0, rt.width, rt.height); rt.scissor.set(0, 0, rt.width, rt.height);
    }
    renderer.setRenderTarget(prevRT); renderer.setClearColor(prevColor, prevAlpha); renderer.autoClear = prevAuto; renderer.shadowMap.autoUpdate = prevShadow; renderer.xr.enabled = prevXR; renderer.setScissorTest(prevScissor);
  }

  const stats = { trees: total, full: 0, reduced: 0, impostors: 0, triangles: 0, level };
  function bin() {
    const c = cam.local, slack = 14;
    let io = 0; stats.full = stats.reduced = stats.triangles = 0;
    const IM = imp.instanceMatrix.array, IC = imp.instanceColor.array, IA = impAttr.array;
    for (const S of bySpecies) {
      const A = S.lods[0], B = S.lods[1], AM = A.instanceMatrix.array, AC = A.instanceColor.array, BM = B.instanceMatrix.array, BC = B.instanceColor.array;
      let a = 0, b = 0;
      for (let i = 0; i < S.n; i++) {
        const o = i * 16, m = S.mats, dx = m[o + 12] - c.x, dy = m[o + 13] - c.y, dz = m[o + 14] - c.z, sc = Math.hypot(m[o + 4], m[o + 5], m[o + 6]);
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz), ds = d / sc, sl = slack / sc;
        if (ds < lod.d0 + lod.w0 + sl) { AM.set(m.subarray(o, o + 16), a * 16); AC.set(S.cols.subarray(i * 3, i * 3 + 3), a * 3); a++; }
        if (ds > lod.d0 - sl && ds < lod.d1 + lod.w1 + sl) { BM.set(m.subarray(o, o + 16), b * 16); BC.set(S.cols.subarray(i * 3, i * 3 + 3), b * 3); b++; }
        if (ds > lod.d1 - sl) { IM.set(m.subarray(o, o + 16), io * 16); IC.set(S.cols.subarray(i * 3, i * 3 + 3), io * 3); IA[io * 4] = S.si; IA[io * 4 + 1] = S.rad; IA[io * 4 + 2] = S.cy; io++; }
      }
      A.count = a; B.count = b; A.visible = a > 0; B.visible = b > 0;
      A.instanceMatrix.needsUpdate = A.instanceColor.needsUpdate = B.instanceMatrix.needsUpdate = B.instanceColor.needsUpdate = true;
      stats.full += a; stats.reduced += b; stats.triangles += a * S.geos[0].userData.tree.tris + b * S.geos[1].userData.tree.tris;
    }
    imp.count = io; imp.visible = io > 0; imp.instanceMatrix.needsUpdate = imp.instanceColor.needsUpdate = impAttr.needsUpdate = true;
    stats.impostors = io; stats.triangles += io * 2;
    binAt.copy(c);
  }

  function update(dt, env = {}) {
    U.uTime.value += dt || 0;
    if (env.camera) see(env.camera, env.pixelHeight);
    if (env.sunDir) {
      BU.uSunL.value.copy(env.sunDir);
      if (BU.uSunL.value.y < 0.03) { BU.uSunL.value.y = 0.03; BU.uSunL.value.normalize(); }
      BU.uK.value = 0.5 * THREE.MathUtils.smoothstep(env.sunDir.y, 0.0, 0.16);
    }
    blobs.visible = BU.uK.value > 0.01 && total > 0;
    if (!cam.known) return;
    const L = lodDistances(cam.h, cam.fov, level), key = [L.d0, L.d1].map(x => Math.round(x)).join(':');
    if (key !== lodKey) {
      lodKey = key; lod = L;
      fades[0].value.set(0, 0, L.d0, L.w0); fades[1].value.set(L.d0, L.w0, L.d1, L.w1); fades[2].value.set(L.d1, L.w1, 0, 0);
      binAt.set(1e9, 0, 0);
    }
    if (binAt.distanceToSquared(cam.local) > 25) bin();
  }

  return {
    group, update, stats,
    /** the camera in the group's frame, as last seen (y = height above the ground) */
    get cameraLocal() { return cam.local; }, get cameraKnown() { return cam.known; },
    get detail() { return level; },
    setDetail(l) { if (VEG_LEVELS.includes(l) && l !== level) { level = l; stats.level = l; lodKey = ''; } },
    /** bake the impostor atlas now (otherwise it happens inside the first frame that draws the trees) */
    prepare(renderer) { if (!baked && renderer) bake(renderer); },
    get impostorAtlas() { return rtA.texture; }, get impostorNormals() { return rtN.texture; },
    dispose() {
      for (const S of bySpecies) { for (const g of S.geos) g.dispose(); for (const m of S.lods) { m.material.dispose(); m.customDepthMaterial.dispose(); m.dispose(); } }
      impGeo.dispose(); impMat.dispose(); imp.dispose(); blobGeo.dispose(); blobMat.dispose(); blobs.dispose(); rtA.dispose(); rtN.dispose(); driver.geometry.dispose(); driver.material.dispose();
      if (group.parent) group.parent.remove(group);
    },
  };
}

// ------------------------------------------------------------------------------------------------------------
// Grass: tufts of blades on a square of ground that follows the camera. Every tuft has a fixed place in the world
// (its offset wraps round the square), shrinks to nothing at the square's edge and wherever the mask says the
// ground is paved or built on. No per-frame buffer work: the camera only moves two uniforms.
// ------------------------------------------------------------------------------------------------------------
function tuftGeometry(blades, hMin, hMax, wMin, wMax, spread, seed) {
  const pos = [], nor = [], uv = [];
  let a0 = seed >>> 0; const r = () => { a0 = (a0 + 0x6d2b79f5) >>> 0; let t = a0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + r() * 1.3, lean = 0.12 + 0.36 * r(), h = hMin + (hMax - hMin) * r(), w = wMin + (wMax - wMin) * r();
    const rad = spread * (0.15 + 0.85 * r()), cx = Math.cos(a), cz = Math.sin(a), ox = cx * rad, oz = cz * rad;
    const tw = a + 1.2 + r() * 0.7, px = Math.cos(tw) * w, pz = Math.sin(tw) * w;
    const mid = [ox + cx * lean * 0.3 * h, h * 0.56, oz + cz * lean * 0.3 * h], tip = [ox + cx * lean * h * 1.2, h, oz + cz * lean * h * 1.2];
    const q = [[ox - px, 0, oz - pz], [ox + px, 0, oz + pz], [mid[0] + px * 0.72, mid[1], mid[2] + pz * 0.72], [mid[0] - px * 0.72, mid[1], mid[2] - pz * 0.72]];
    for (const v of [q[0], q[1], q[2], q[0], q[2], q[3], q[3], q[2], tip]) { pos.push(v[0], v[1], v[2]); nor.push(cx * 0.3, 0.9, cz * 0.3); uv.push(b / blades, v[1] / hMax); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

const GRASS_VS_HEAD = /* glsl */`attribute vec4 aOff; uniform vec4 uGrass, uMaskRect; uniform float uTime, uPR, uLift; uniform sampler2D uMask; varying vec3 vG;\n`;
const GRASS_VS = /* glsl */`
  vec2 gCell = mod(aOff.xy - uGrass.xy, uGrass.z) - 0.5 * uGrass.z;
  vec2 gP = uGrass.xy + gCell;
  float gK = 1.0 - smoothstep(uGrass.w * 0.55, uGrass.w, length(gCell));
  gK *= 1.0 - smoothstep(0.02, 0.22, texture2D(uMask, (gP - uMaskRect.xy) * uMaskRect.zw).r);
  float gPatch = sin(gP.x * 0.21 + 2.0 * sin(gP.y * 0.13)) * sin(gP.y * 0.17 + 2.0 * sin(gP.x * 0.11));
  gK *= 0.8 + 0.3 * gPatch + 0.35 * aOff.w;
  float gA = aOff.z * 6.2831853, gc = cos(gA), gs = sin(gA);
  vec3 gp = vec3(gc * position.x - gs * position.z, position.y, gs * position.x + gc * position.z) * gK;
  float gph = gP.x * 0.7 + gP.y * 0.9, y2 = uv.y * uv.y;
  gp.xz += 0.07 * y2 * vec2(sin(uTime * 1.7 + gph) + 0.4 * sin(uTime * 4.3 + gph * 2.1), cos(uTime * 1.3 + gph * 1.3));
  vec3 transformed = vec3(gP.x + gp.x, gp.y + uLift - (uPR > 0.0 ? dot(gP, gP) / (2.0 * uPR) : 0.0), gP.y + gp.z);
  vG = vec3(uv.y, aOff.w, gPatch);
  if (gK < 0.02) transformed.y = -1.0e4;`;

/**
 * @param mask { texture, rect: [x0, z0, width, depth] } red > 0 where grass must not grow (group frame, metres)
 */
export function createGrass({ mask = null, planetRadius = 0, detail = 'high', lift = 0.0, colors = {} } = {}) {
  const group = new THREE.Group(); group.name = 'grass';
  const white = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); white.needsUpdate = true;
  const rect = mask ? mask.rect : [0, 0, 1, 1];
  const shared = { uTime: { value: 0 }, uPR: { value: planetRadius }, uLift: { value: lift }, uMask: { value: mask ? mask.texture : white }, uMaskRect: { value: new THREE.Vector4(rect[0], rect[1], 1 / rect[2], 1 / rect[3]) },
    uRoot: { value: new THREE.Color().fromArray(colors.root || [0.05, 0.095, 0.028]) }, uTip: { value: new THREE.Color().fromArray(colors.tip || [0.13, 0.2, 0.06]) }, uDry: { value: new THREE.Color().fromArray(colors.dry || [0.3, 0.27, 0.11]) } };
  const rings = [];
  const ring = (name, G, count, geo, seed, gain = 1) => {
    const ig = new THREE.InstancedBufferGeometry(); ig.index = geo.index; for (const k of Object.keys(geo.attributes)) ig.setAttribute(k, geo.attributes[k]);
    const off = new Float32Array(count * 4); let a = seed >>> 0; const r = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
    for (let i = 0; i < count; i++) { off[i * 4] = r() * G; off[i * 4 + 1] = r() * G; off[i * 4 + 2] = r(); off[i * 4 + 3] = r(); }
    ig.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4)); ig.instanceCount = count;
    const un = { ...shared, uGrass: { value: new THREE.Vector4(0, 0, G, G / 2) }, uGain: { value: gain } };
    const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    mat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, un);
      sh.vertexShader = GRASS_VS_HEAD + sh.vertexShader.replace('#include <begin_vertex>', GRASS_VS);
      sh.fragmentShader = 'uniform vec3 uRoot, uTip, uDry; uniform float uGain; varying vec3 vG;\n' + sh.fragmentShader
        .replace('#include <map_fragment>', /* glsl */`
          float thin = vG.x, sheen = vG.x * 0.5;
          vec3 gcol = mix(uRoot, mix(uTip, uDry, smoothstep(0.55, 0.98, vG.y - 0.25 * vG.z)), vG.x * (0.75 + 0.25 * vG.x));
          // no two tufts the same green: some bluer, some gone yellow, and whole patches lighter or darker
          gcol *= mix(vec3(0.86, 0.98, 1.06), vec3(1.14, 1.04, 0.8), fract(vG.y * 7.31)) * (0.9 + 0.22 * vG.z);
          diffuseColor.rgb *= gcol * (0.8 + 0.4 * vG.y) * uGain;`)
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize(vNormal);')
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + TRANSLUCENT_GLSL);
    };
    mat.customProgramCacheKey = () => 'sw-grass2';
    const mesh = noCast(new THREE.Mesh(ig, mat)); mesh.name = 'grass:' + name; mesh.frustumCulled = false; mesh.receiveShadow = true;
    mesh.onBeforeRender = (renderer, scene, camera) => {
      camera.getWorldPosition(_v); group.updateWorldMatrix(true, false); group.worldToLocal(_v);
      camera.getWorldDirection(_v2).transformDirection(_m.copy(group.matrixWorld).invert());
      const fwd = Math.min(G * 0.36, Math.max(0, _v.y) * 1.5 + G * 0.12), hl = Math.hypot(_v2.x, _v2.z) || 1;
      un.uGrass.value.set(_v.x + (_v2.x / hl) * fwd, _v.z + (_v2.z / hl) * fwd, G, G / 2);
      camY = _v.y;
    };
    group.add(mesh);
    rings.push({ mesh, ig, count, G, tris: geo.attributes.position.count / 3 });
  };
  let camY = 0, level = '';
  ring('near', 36, 32000, tuftGeometry(6, 0.12, 0.42, 0.007, 0.015, 0.36, 5), 11);
  ring('far', 150, 25600, tuftGeometry(5, 0.22, 0.5, 0.024, 0.042, 0.75, 8), 29, 1.3);
  const stats = { tufts: 0, triangles: 0 };
  function setDetail(l) {
    if (l === level) return; level = l;
    const k = { low: 0, medium: 0.31, high: 0.7, ultra: 1 }[l] ?? 0.7;
    for (const R of rings) R.ig.instanceCount = Math.min(R.count, Math.round(R.count * Math.min(1, k)));
  }
  setDetail(detail);
  return {
    group, stats, setDetail, shared,
    /** camLocalY: the camera's height above the ground in the group's frame (the rings rest while it is high) */
    update(dt, camLocalY) {
      shared.uTime.value += dt || 0;
      if (Number.isFinite(camLocalY)) camY = camLocalY;
      stats.tufts = 0; stats.triangles = 0;
      for (const R of rings) { R.mesh.visible = R.ig.instanceCount > 0 && camY < R.G * 2.2; if (R.mesh.visible) { stats.tufts += R.ig.instanceCount; stats.triangles += R.ig.instanceCount * R.tris; } }
    },
    dispose() { for (const R of rings) { R.ig.dispose(); R.mesh.material.dispose(); } white.dispose(); if (group.parent) group.parent.remove(group); },
  };
}
