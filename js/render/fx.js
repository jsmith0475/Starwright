// Starwright effects: engine plumes, particles (smoke, fire, sparks, dust, vapour), explosions, re-entry plasma,
// transonic vapour cones, ground light pools. Procedural shaders only, no image files.
//
// Renderer contract: every shader here includes three's log-depth, tone-mapping and colour-space chunks, so the
// effects are correct both when drawn straight to the canvas (ACES + sRGB applied by the chunks) and when drawn
// into the flight screen's linear HDR target (the chunks are no-ops there and the post chain tone-maps).
// Colours are therefore LINEAR and may exceed 1.0 (that is what feeds the bloom).
//
//   createPlume(def, exit?)          → { object, update(throttle, pressureAtm, dt), dispose(), info, level }   exit: one nozzle of partmesh.nozzleExits(def),
//                                      or an array of them (same radius and exit plane): one instanced plume for all, three draw calls
//   createClusterPlume(def, y?)      → { object, update(thrustKN, radius, pressureAtm, dt), dispose(), thrust, length }   the merged flame of a ring cluster
//   new SmokeTrail({max, additive})  → instanced billboard pool (alias: ParticleField); emit(), update(dt, shift, up)
//   createExplosion(size, opts)      → { object, update(dt, gravity?) → alive, dispose() }
//   createReentryGlow({radius,tail}) → { object, update(intensity, flowDirLocal, dt), setSize(r, tail), dispose() }
//   createVaporCone()                → { object, update(intensity, flowDirLocal, dt), setSize(r), dispose() }
//   createGroundGlow()               → { object, set(color, intensity, radius), dispose() }   additive light pool decal
//   engineKind(def)                  → 'solid' | 'liquid' | 'nuclear' | 'ion' | 'jet'
import * as THREE from '../lib/three.module.min.js';
import { nozzleExitRadius } from './partmesh.js';

const LV0 = '#include <common>\n#include <logdepthbuf_pars_vertex>\n', LV1 = '#include <logdepthbuf_vertex>\n';
const LF0 = '#include <common>\n#include <logdepthbuf_pars_fragment>\n', LF1 = '#include <logdepthbuf_fragment>\n';
const OUT = '#include <tonemapping_fragment>\n#include <colorspace_fragment>\n';
const NOISE = `
float fxHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float fxNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fxHash(i), fxHash(i + vec2(1.0, 0.0)), f.x), mix(fxHash(i + vec2(0.0, 1.0)), fxHash(i + vec2(1.0, 1.0)), f.x), f.y); }
`;
const clamp01 = x => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
const _c = new THREE.Color(), _v = new THREE.Vector3(), _p = new THREE.Vector3();

/** Which exhaust look an engine part gets. */
export function engineKind(def) {
  const e = (def && def.engine) || {};
  if (e.type === 'solid' || e.type === 'ion' || e.type === 'nuclear' || e.type === 'jet') return e.type;
  if (e.ispVac > 500) return 'nuclear';
  return 'liquid';
}

// ---------------------------------------------------------------------------------------------
// Exhaust plume
// ---------------------------------------------------------------------------------------------
const PLUME_VS = `${LV0}
uniform float uLen, uR0, uTail, uShape, uTime, uSeed, uPinch, uDiaN;
varying float vV; varying float vAng; varying vec3 vNv; varying vec3 vPv; varying float vSeed;
void main(){
  float v = -position.y; vV = v;
  vAng = atan(position.z, position.x);
  float sd = uSeed;
  #ifdef USE_INSTANCING
    sd += dot(instanceMatrix[3].xz, vec2(3.1, 5.3));   // every bell of a cluster flickers on its own
  #endif
  vSeed = sd;
  float flick = 1.0 + 0.04 * sin(uTime * 47.0 + sd) + 0.03 * sin(uTime * 31.0 + sd * 2.0);
  float len = uLen * flick;
  float prof = mix(1.0, uTail, pow(v, uShape));
  // over-expanded flow at sea level necks in and out between the shock diamonds
  prof *= 1.0 - uPinch * 0.16 * (0.5 - 0.5 * cos(v * uDiaN * 6.2832)) * (1.0 - v);
  float rad = uR0 * prof * (1.0 + 0.035 * sin(uTime * 60.0 + v * 9.0 + sd));
  vec3 p = vec3(position.x * rad, -v * len, position.z * rad);
  vec3 n = normalize(vec3(position.x, (uTail - 1.0) * uR0 / max(len, 0.001), position.z));
  #ifdef USE_INSTANCING
    p = (instanceMatrix * vec4(p, 1.0)).xyz;           // instances are only moved, never turned
  #endif
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vNv = normalize(normalMatrix * n); vPv = mv.xyz;
  gl_Position = projectionMatrix * mv;
  ${LV1}
}`;
const PLUME_FS = `${LF0}${NOISE}
uniform vec3 uCore, uEdge; uniform float uAlpha, uFall, uEdgePow, uDiamond, uDiaN, uTime, uStreak, uSpeed, uHead;
varying float vV; varying float vAng; varying vec3 vNv; varying vec3 vPv; varying float vSeed;
void main(){
  ${LF1}
  float facing = abs(dot(normalize(vNv), normalize(-vPv)));
  float body = pow(facing, uEdgePow);
  float along = pow(max(1.0 - vV, 0.0), uFall);
  // streaks racing down the flame, a little turbulence toward the tail
  float st = fxNoise(vec2(vAng * 3.3 + vSeed, vV * 7.0 - uTime * uSpeed));
  float tb = fxNoise(vec2(vAng * 7.0 - vSeed, vV * 16.0 - uTime * uSpeed * 1.7));
  float streak = 1.0 + uStreak * ((st - 0.5) * 1.3 + (tb - 0.5) * 0.9 * vV);
  // shock diamonds: bright knots at regular spacing, strongest near the nozzle
  float ph = fract(vV * uDiaN - 0.22) - 0.5;
  float dia = exp(-ph * ph * 30.0) * pow(facing, 2.6) * (1.0 - vV) * (1.0 - vV);
  float t = clamp(pow(facing, 2.0) * (1.0 - vV * 0.85) * 1.25, 0.0, 1.0);
  vec3 col = mix(uEdge, uCore, t) * streak + uCore * dia * uDiamond * 2.2;
  float a = body * along * uAlpha * (1.0 + dia * uDiamond);
  // a cluster's merged flame (uHead > 0) fades in over its first stretch, where the bells' own flames still show
  a *= mix(1.0, smoothstep(0.0, 1.0, vV / max(uHead, 0.0001)), step(0.0001, uHead));
  gl_FragColor = vec4(col * a, a);
  ${OUT}
}`;
let plumeGeo = null, glowTex = null;
let plumeGeoLite = null;
function plumeLayer(u, spots = null) {
  if (!plumeGeo) { plumeGeo = new THREE.CylinderGeometry(1, 1, 1, 28, 20, true); plumeGeo.translate(0, -0.5, 0); }
  // a cluster's flames are a third of a metre across and there may be twenty of them: a coarser tube is plenty
  if (spots && !plumeGeoLite) { plumeGeoLite = new THREE.CylinderGeometry(1, 1, 1, 14, 16, true); plumeGeoLite.translate(0, -0.5, 0); }
  const material = new THREE.ShaderMaterial({
    uniforms: u, vertexShader: PLUME_VS, fragmentShader: PLUME_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    forceSinglePass: true,            // additive: both faces in one draw give the same picture as three's two passes
  });
  let m;
  if (spots) {
    m = new THREE.InstancedMesh(spots.length > 6 ? plumeGeoLite : plumeGeo, material, spots.length);
    const mx = new THREE.Matrix4(); spots.forEach((s, i) => m.setMatrixAt(i, mx.makeTranslation(s.x, 0, s.z)));
    m.instanceMatrix.needsUpdate = true;
  } else m = new THREE.Mesh(plumeGeo, material);
  m.frustumCulled = false; m.renderOrder = 6; m.castShadow = false; m.receiveShadow = false;
  return m;
}
function softDotTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

// Per-kind look. Colours are linear HDR; `sl` = sea level, `vac` = vacuum.
const KINDS = {
  liquid: { len: 28, lenVac: 0.85, tailSl: 0.42, tailVac: 4.6, coreSl: [3.4, 2.5, 1.25], edgeSl: [1.9, 0.6, 0.1], coreVac: [1.5, 1.9, 2.6], edgeVac: [0.35, 0.55, 1.2], aSl: 0.62, aVac: 0.26, dia: 1.0, streak: 0.5, speed: 9, light: [1.0, 0.72, 0.42] },
  solid: { len: 22, lenVac: 1.3, tailSl: 1.0, tailVac: 3.4, coreSl: [5.0, 3.8, 1.8], edgeSl: [3.2, 1.3, 0.25], coreVac: [5.0, 4.2, 2.6], edgeVac: [2.4, 1.1, 0.3], aSl: 1.0, aVac: 0.55, dia: 0.0, streak: 0.8, speed: 12, light: [1.0, 0.78, 0.46] },
  nuclear: { len: 13, lenVac: 1.5, tailSl: 0.45, tailVac: 2.6, coreSl: [2.6, 1.7, 2.0], edgeSl: [1.4, 0.35, 0.6], coreVac: [1.9, 1.5, 2.4], edgeVac: [0.9, 0.3, 0.9], aSl: 0.55, aVac: 0.3, dia: 0.35, streak: 0.35, speed: 14, light: [1.0, 0.6, 0.7] },
  ion: { len: 26, lenVac: 1.0, tailSl: 0.75, tailVac: 0.75, coreSl: [1.6, 3.8, 5.0], edgeSl: [0.15, 0.9, 2.2], coreVac: [1.6, 3.8, 5.0], edgeVac: [0.15, 0.9, 2.2], aSl: 0.75, aVac: 0.75, dia: 0.0, streak: 0.15, speed: 20, light: [0.4, 0.8, 1.0] },
  // methane and oxygen (engine.prop 'methalox'): a blue-violet core with strong shock diamonds at sea level; in
  // vacuum it opens wider than a kerosene flame and nearly fades out. It is still a 'liquid' plume to the scene.
  methalox: { len: 30, lenVac: 0.8, tailSl: 0.46, tailVac: 5.6, coreSl: [0.5, 0.58, 3.3], edgeSl: [0.8, 0.22, 1.7], coreVac: [0.45, 0.7, 2.6], edgeVac: [0.26, 0.28, 0.95], aSl: 0.56, aVac: 0.17, dia: 1.6, streak: 0.4, speed: 11, light: [0.74, 0.7, 1.0] },
  jet: { len: 5.5, lenVac: 1.2, tailSl: 0.55, tailVac: 1.4, coreSl: [2.2, 2.8, 4.2], edgeSl: [2.2, 0.8, 0.2], coreVac: [1.6, 2.0, 3.0], edgeVac: [1.2, 0.5, 0.2], aSl: 0.55, aVac: 0.3, dia: 1.3, streak: 0.4, speed: 16, light: [1.0, 0.7, 0.5] },
};

/**
 * Exhaust plume for an engine part def. `object` is a Group whose origin is the nozzle exit and which points along
 * −Y; it is pre-positioned at (0, −def.h/2, 0), so it can simply be added to the group returned by
 * buildPartMesh(def). update(throttle 0..1, pressureAtm, dt): a tight bright flame with shock diamonds at sea
 * level, a wide faint bell in vacuum. `info` = { kind, radius, light:[r,g,b] } and `level` (smoothed throttle)
 * let the scene drive smoke and ground light.
 */
export function createPlume(def, exit = null) {
  const kind = engineKind(def), look = kind === 'liquid' && def.engine && def.engine.prop === 'methalox' ? 'methalox' : kind, K = KINDS[look];
  // `exit` ({x, y, z, r} from partmesh.nozzleExits) gives one plume per bell of a multi-nozzle engine; an array of
  // exits gives one instanced plume that draws a flame at each of them (the bells of one ring of a cluster)
  const spots = Array.isArray(exit) ? exit : null; if (spots) exit = { x: 0, y: spots[0].y, z: 0, r: spots[0].r };
  const rE = exit && exit.r > 0 ? exit.r : nozzleExitRadius(def), seed = Math.random() * 100;
  const mk = () => ({
    uLen: { value: 1 }, uR0: { value: rE }, uTail: { value: 1 }, uShape: { value: 0.75 }, uTime: { value: 0 }, uSeed: { value: seed },
    uCore: { value: new THREE.Vector3() }, uEdge: { value: new THREE.Vector3() }, uAlpha: { value: 0 }, uFall: { value: 1.5 }, uEdgePow: { value: 1.5 },
    uDiamond: { value: 0 }, uDiaN: { value: 5 }, uPinch: { value: 0 }, uStreak: { value: K.streak }, uSpeed: { value: K.speed }, uHead: { value: 0 },
  });
  const uo = mk(), ui = mk();
  const object = new THREE.Group(); object.name = 'plume'; if (exit) object.position.set(exit.x || 0, Number.isFinite(exit.y) ? exit.y : -def.h / 2, exit.z || 0); else object.position.set(0, -def.h / 2, 0); object.visible = false;
  const outer = plumeLayer(uo, spots), inner = plumeLayer(ui, spots); object.add(outer, inner);
  const flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDotTexture(), color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 1 }));
  flare.renderOrder = 7; flare.position.y = -rE * 0.6; object.add(flare);
  // one soft glow for a whole ring of flames: as wide as the ring, and dimmer, since it is spread thin
  let spread = 0; if (spots) for (const s of spots) spread = Math.max(spread, Math.hypot(s.x, s.z));
  // flames standing shoulder to shoulder add up on screen: thin each one so a full ring keeps its colour
  const aK = spots ? 1 / (1 + 0.05 * (spots.length - 1)) : 1;
  const fK = spots ? (spread + rE) / rE * 0.72 : 1, fA = spots ? Math.min(1, 0.3 + 1.6 * spots.length * rE * rE / ((spread + rE) * (spread + rE))) : 1;
  const cs = new THREE.Vector3(), es = new THREE.Vector3(), cv = new THREE.Vector3(), ev = new THREE.Vector3();
  cs.fromArray(K.coreSl); es.fromArray(K.edgeSl); cv.fromArray(K.coreVac); ev.fromArray(K.edgeVac);
  let time = 0;
  const api = {
    object, light: null, level: 0, info: { kind, look, radius: rE, light: K.light },
    update(throttle, pressureAtm = 0, dt = 1 / 60) {
      time += dt;
      const target = clamp01(throttle);
      api.level += (target - api.level) * Math.min(1, dt * (kind === 'jet' ? 5 : 14));
      const level = api.level;
      if (level < 0.004) { object.visible = false; return; }
      object.visible = true;
      const p = Math.sqrt(clamp01(pressureAtm)), vac = 1 - p, pw = 0.28 + 0.72 * level;
      const L = rE * K.len * pw * lerp(1, K.lenVac, vac);
      const tail = lerp(K.tailSl, K.tailVac, Math.pow(vac, 1.5));
      const alpha = lerp(K.aSl, K.aVac, vac) * (0.35 + 0.65 * level) * aK;
      uo.uLen.value = L; uo.uR0.value = rE * 0.98; uo.uTail.value = tail;
      uo.uAlpha.value = alpha; uo.uFall.value = 0.95 + 1.3 * vac; uo.uEdgePow.value = 1.25 + 1.1 * vac;
      uo.uDiamond.value = K.dia * p * level; uo.uPinch.value = K.dia > 0 ? p : 0; uo.uDiaN.value = ui.uDiaN.value = 4.2 + 2.0 * (1 - level);
      uo.uCore.value.copy(cs).lerp(cv, vac); uo.uEdge.value.copy(es).lerp(ev, vac);
      ui.uLen.value = L * (0.5 + 0.12 * vac); ui.uR0.value = rE * 0.6; ui.uTail.value = 0.12 + (tail - 0.4) * 0.38;
      ui.uAlpha.value = alpha * 1.15; ui.uFall.value = 1.1; ui.uEdgePow.value = 0.9;
      ui.uDiamond.value = K.dia * 0.7 * p * level; ui.uPinch.value = K.dia > 0 ? p * 0.6 : 0;
      ui.uCore.value.copy(uo.uCore.value).multiplyScalar(1.35); ui.uEdge.value.copy(uo.uCore.value).lerp(uo.uEdge.value, 0.4);
      uo.uTime.value = ui.uTime.value = time;
      const fs = rE * (kind === 'ion' ? 3.2 : 3.4) * (0.5 + 0.5 * level) * (1 + 0.08 * Math.sin(time * 53 + seed));
      flare.scale.set(fs * fK, fs * fK, 1);
      const fc = uo.uCore.value;
      flare.material.color.setRGB(fc.x * 0.32, fc.y * 0.32, fc.z * 0.32);
      flare.material.opacity = (0.35 + 0.65 * level) * lerp(1, 0.55, vac) * fA;
    },
    dispose() { outer.material.dispose(); inner.material.dispose(); flare.material.dispose(); },
  };
  return api;
}

/** Metres of merged flame per square root of a kilonewton of thrust: 33 Peregrines at sea level (10,600 kN) give 39 m. */
export const CLUSTER_FLAME = 0.38;
/**
 * The one flame a ring cluster's many small ones merge into (engines with `engine.rings` only: every other engine
 * keeps createPlume alone). `object` is a Group at the cluster's exit plane (0, y, 0) pointing along −Y; add it to the
 * part's mesh beside the per-bell plumes. update(thrustKN, radius, pressureAtm, dt): the thrust being made now, and
 * the radius round the bells that are burning. The flame is CLUSTER_FLAME · √thrust long (half as long again in
 * vacuum), starts as wide as the burning bells and opens with altitude as a single engine's does. It fades in over
 * its first fifth, so the bells' own flames show inside its top.
 */
export function createClusterPlume(def, y = -def.h / 2) {
  const kind = engineKind(def), look = kind === 'liquid' && def.engine && def.engine.prop === 'methalox' ? 'methalox' : kind, K = KINDS[look];
  const seed = Math.random() * 100;
  const mk = () => ({
    uLen: { value: 1 }, uR0: { value: 1 }, uTail: { value: 1 }, uShape: { value: 0.9 }, uTime: { value: 0 }, uSeed: { value: seed },
    uCore: { value: new THREE.Vector3() }, uEdge: { value: new THREE.Vector3() }, uAlpha: { value: 0 }, uFall: { value: 1.5 }, uEdgePow: { value: 1.5 },
    uDiamond: { value: 0 }, uDiaN: { value: 3 }, uPinch: { value: 0 }, uStreak: { value: K.streak * 1.3 }, uSpeed: { value: K.speed * 0.5 }, uHead: { value: 0.2 },
  });
  const uo = mk(), ui = mk();
  const object = new THREE.Group(); object.name = 'clusterPlume'; object.position.set(0, y, 0); object.visible = false;
  const outer = plumeLayer(uo), inner = plumeLayer(ui); object.add(outer, inner);
  const cs = new THREE.Vector3().fromArray(K.coreSl), es = new THREE.Vector3().fromArray(K.edgeSl), cv = new THREE.Vector3().fromArray(K.coreVac), ev = new THREE.Vector3().fromArray(K.edgeVac);
  let time = 0, radius = 0;
  const api = {
    object, thrust: 0, length: 0, radius: 0,
    update(thrustKN, r, pressureAtm = 0, dt = 1 / 60) {
      time += dt;
      const k = Math.min(1, dt * 14), target = Math.max(0, +thrustKN || 0);
      api.thrust += (target - api.thrust) * k;
      if (r > 0) radius = radius > 0 ? radius + (r - radius) * k : r;
      if (api.thrust < 1 || !(radius > 0)) { object.visible = false; api.length = 0; return; }
      object.visible = true;
      const p = Math.sqrt(clamp01(pressureAtm)), vac = 1 - p;
      const L = api.length = CLUSTER_FLAME * Math.sqrt(api.thrust) * lerp(1, 1.5, vac);
      api.radius = radius;
      const tail = lerp(K.tailSl * 1.35, K.tailVac * 0.55, Math.pow(vac, 1.5));
      const alpha = lerp(K.aSl, K.aVac, vac) * 0.8;
      uo.uLen.value = L; uo.uR0.value = radius; uo.uTail.value = tail;
      uo.uAlpha.value = alpha; uo.uFall.value = 0.7 + 1.3 * vac; uo.uEdgePow.value = 1.25 + 1.1 * vac;
      uo.uDiamond.value = K.dia * 0.3 * p; uo.uPinch.value = K.dia > 0 ? p * 0.5 : 0;
      uo.uCore.value.copy(cs).lerp(cv, vac); uo.uEdge.value.copy(es).lerp(ev, vac);
      ui.uLen.value = L * (0.62 + 0.1 * vac); ui.uR0.value = radius * 0.6; ui.uTail.value = 0.12 + (tail - 0.4) * 0.38;
      ui.uAlpha.value = alpha * 0.9; ui.uFall.value = 1.1; ui.uEdgePow.value = 0.9;
      ui.uDiamond.value = K.dia * 0.3 * p; ui.uPinch.value = K.dia > 0 ? p * 0.3 : 0;
      ui.uCore.value.copy(uo.uCore.value).multiplyScalar(1.35); ui.uEdge.value.copy(uo.uCore.value).lerp(uo.uEdge.value, 0.4);
      uo.uTime.value = ui.uTime.value = time;
    },
    dispose() { outer.material.dispose(); inner.material.dispose(); },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------
// Particle pool: instanced camera-facing quads, one draw call. Smoke is lit by the sun; fire and sparks are
// additive. Both kinds live in the same pool (premultiplied "over" blending with a per-particle additive mix).
// ---------------------------------------------------------------------------------------------
const PUFF_VS = `${LV0}
attribute vec3 iPos; attribute vec4 iData;   // size (m), alpha, seed, rotation
attribute vec4 iColor;                        // rgb, additive mix
varying vec2 vUv; varying float vA; varying vec4 vC; varying float vSeed; varying vec2 vQ;
void main(){
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iData.w), s = sin(iData.w);
  vec2 q = position.xy;
  vec2 r = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  vQ = r * 2.0;
  mv.xy += r * iData.x;
  vUv = q + 0.5; vA = iData.y; vC = iColor; vSeed = iData.z;
  // fade out puffs the camera is flying through
  vA *= smoothstep(0.15, 0.9, -mv.z / max(iData.x, 0.01));
  gl_Position = projectionMatrix * mv;
  ${LV1}
}`;
const PUFF_FS = `${LF0}
uniform sampler2D uTex; uniform vec3 uSunV, uSunCol, uAmb;
varying vec2 vUv; varying float vA; varying vec4 vC; varying float vSeed; varying vec2 vQ;
void main(){
  ${LF1}
  if (vA <= 0.002) discard;
  // 2 × 2 atlas of puff shapes
  float cell = floor(vSeed * 3.999);
  vec2 uv = (clamp(vUv, 0.004, 0.996) + vec2(mod(cell, 2.0), floor(cell * 0.5))) * 0.5;
  vec2 tx = texture2D(uTex, uv).rg;
  float tex = tx.r, det = tx.g;
  float a = tex * vA;
  if (a <= 0.003) discard;
  // fake a rounded puff normal from the quad coordinates, light it from the sun (view space)
  float z = sqrt(max(0.0, 1.0 - min(dot(vQ, vQ), 1.0)));
  vec3 n = normalize(vec3(vQ, z * 0.9 + 0.25));
  float wrap = clamp(dot(n, uSunV) * 0.6 + 0.4, 0.0, 1.0);
  // thick middles shadow themselves a little; lobes catch the light, creases stay dark
  vec3 lit = vC.rgb * (uAmb * (0.7 + 0.3 * det) + uSunCol * wrap * (0.35 + 0.65 * det)) * (0.8 + 0.2 * tex);
  vec3 col = mix(lit, vC.rgb, vC.a);
  gl_FragColor = vec4(col * a, a * (1.0 - vC.a));
  ${OUT}
}`;
let puffTex = null;
function puffTexture() {
  if (puffTex) return puffTex;
  // 2 × 2 atlas. R: coverage (a lumpy, wispy-edged puff), G: self-shading detail (bright lobes, dark creases).
  const S = 128, W = S * 2, data = new Uint8Array(W * W * 4);
  const hash = (x, y, s) => { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const vnoise = (x, y, s) => { const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s); return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy; };
  const fbm = (x, y, s) => vnoise(x, y, s) * 0.5 + vnoise(x * 2.03, y * 2.03, s + 7) * 0.27 + vnoise(x * 4.1, y * 4.1, s + 13) * 0.15 + vnoise(x * 8.3, y * 8.3, s + 29) * 0.08;
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * S, oy = Math.floor(cell / 2) * S;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S * 2 - 1, v = (y + 0.5) / S * 2 - 1, r = Math.hypot(u, v);
      const n = fbm(u * 2.6 + 9, v * 2.6 + 9, cell * 31 + 1);
      // billowy lobes: ridged noise makes rounded bumps with creases between them
      const lob = 1 - Math.abs(fbm(u * 3.4 + 40, v * 3.4 + 40, cell * 17 + 5) * 2 - 1);
      let cov = 1.25 - r * 1.45 + (n - 0.5) * 1.1 + (lob - 0.6) * 0.35;
      cov = Math.max(0, Math.min(1, cov)); cov = cov * cov * (3 - 2 * cov);
      cov *= Math.max(0, Math.min(1, (1 - r) * 5));                         // never touch the quad's edge
      const det = Math.max(0, Math.min(1, 0.25 + lob * 0.75 + (n - 0.5) * 0.3));
      const o = ((oy + y) * W + ox + x) * 4;
      data[o] = Math.round(cov * 255); data[o + 1] = Math.round(det * 255); data[o + 2] = 0; data[o + 3] = 255;
    }
  }
  puffTex = new THREE.DataTexture(data, W, W, THREE.RGBAFormat);
  puffTex.colorSpace = THREE.NoColorSpace; puffTex.generateMipmaps = true; puffTex.minFilter = THREE.LinearMipmapLinearFilter; puffTex.magFilter = THREE.LinearFilter;
  puffTex.needsUpdate = true;
  return puffTex;
}
let quadGeo = null;
const STRIDE = 16;   // age, life, size0, growth, alpha0, drag, fadeIn, rise, vx, vy, vz, spin, rot, seed, gravity, shrink

export class SmokeTrail {
  /**
   * @param max       pool size (oldest particles are recycled when full)
   * @param additive  default blend of new particles (true: glowing sparks / fire)
   * @param color     default colour
   */
  constructor({ max = 400, additive = false, color = 0xd8d6d0 } = {}) {
    this.max = max; this.next = 0; this.additive = additive; this.liveCount = 0;
    this.defaultColor = new THREE.Color(color);
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.p = new Float32Array(max * STRIDE);
    this.live = new Uint8Array(max);
    this.gPos = new Float32Array(max * 3); this.gData = new Float32Array(max * 4); this.gCol = new Float32Array(max * 4);
    if (!quadGeo) quadGeo = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quadGeo.index; geo.setAttribute('position', quadGeo.attributes.position);
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.gPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iData', new THREE.InstancedBufferAttribute(this.gData, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.gCol, 4).setUsage(THREE.DynamicDrawUsage));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.uniforms = { uTex: { value: puffTexture() }, uSunV: { value: new THREE.Vector3(0.3, 0.8, 0.5) }, uSunCol: { value: new THREE.Vector3(1.1, 1.05, 0.95) }, uAmb: { value: new THREE.Vector3(0.38, 0.42, 0.5) } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: PUFF_VS, fragmentShader: PUFF_FS, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.object = new THREE.Mesh(geo, mat); this.object.name = additive ? 'sparks' : 'smoke';
    this.object.frustumCulled = false; this.object.renderOrder = additive ? 7 : 4; this.object.visible = false;
    this.object.castShadow = false; this.object.receiveShadow = false;
    this.sunDir = new THREE.Vector3(0.3, 0.8, 0.5);
    this.object.onBeforeRender = (renderer, scene, camera) => { this.uniforms.uSunV.value.copy(this.sunDir).transformDirection(camera.matrixWorldInverse); };
  }
  /** World-space direction to the sun and the light colours (linear) used to shade smoke. */
  setLight(sunDir, sunCol, ambCol) {
    if (sunDir) this.sunDir.copy(sunDir);
    if (sunCol) this.uniforms.uSunCol.value.set(sunCol.r !== undefined ? sunCol.r : sunCol.x, sunCol.g !== undefined ? sunCol.g : sunCol.y, sunCol.b !== undefined ? sunCol.b : sunCol.z);
    if (ambCol) this.uniforms.uAmb.value.set(ambCol.r !== undefined ? ambCol.r : ambCol.x, ambCol.g !== undefined ? ambCol.g : ambCol.y, ambCol.b !== undefined ? ambCol.b : ambCol.z);
  }
  /**
   * @param pos   Vector3 (relative to the floating origin / object's parent space)
   * @param opts  size (start diameter m), growth (m/s), life (s), alpha (peak), vel (Vector3 m/s), drag (1/s),
   *              color (hex / THREE.Color), fadeIn (s), add (0 lit smoke … 1 additive glow), rise (m/s² along `up`),
   *              gravity (m/s² against `up`), spin (rad/s), shrink (true: size falls to zero with age)
   */
  emit(pos, { size = 2, growth = 3, life = 3, alpha = 0.5, vel = null, drag = 0.6, color = null, fadeIn = 0.12, add = null, rise = 0, gravity = 0, spin = null, shrink = false } = {}) {
    const i = this.next; this.next = (this.next + 1) % this.max;
    this.live[i] = 1;
    this.pos[i * 3] = pos.x; this.pos[i * 3 + 1] = pos.y; this.pos[i * 3 + 2] = pos.z;
    const c = color === null ? this.defaultColor : (color.isColor ? color : _c.set(color));
    this.col[i * 4] = c.r; this.col[i * 4 + 1] = c.g; this.col[i * 4 + 2] = c.b; this.col[i * 4 + 3] = add === null ? (this.additive ? 1 : 0) : add;
    const p = this.p, o = i * STRIDE;
    p[o] = 0; p[o + 1] = life; p[o + 2] = size; p[o + 3] = growth; p[o + 4] = alpha; p[o + 5] = drag; p[o + 6] = fadeIn; p[o + 7] = rise;
    p[o + 8] = vel ? vel.x : 0; p[o + 9] = vel ? vel.y : 0; p[o + 10] = vel ? vel.z : 0;
    p[o + 11] = spin === null ? (Math.random() - 0.5) * 0.8 : spin; p[o + 12] = Math.random() * 6.283; p[o + 13] = Math.random(); p[o + 14] = gravity; p[o + 15] = shrink ? 1 : 0;
    return i;
  }
  /** Ages the pool. `shift` is added to every live particle (floating origin); `up` is the local vertical for rise / gravity. */
  update(dt, shift = null, up = null) {
    const { pos, p, live, max, gPos, gData, gCol, col } = this; let n = 0;
    const sx = shift ? shift.x : 0, sy = shift ? shift.y : 0, sz = shift ? shift.z : 0;
    const ux = up ? up.x : 0, uy = up ? up.y : 1, uz = up ? up.z : 0;
    for (let i = 0; i < max; i++) {
      if (!live[i]) continue;
      const o = i * STRIDE; p[o] += dt;
      const age = p[o], life = p[o + 1];
      if (age >= life) { live[i] = 0; continue; }
      const k = Math.max(0, 1 - p[o + 5] * dt), lift = (p[o + 7] - p[o + 14]) * dt;
      p[o + 8] = p[o + 8] * k + ux * lift; p[o + 9] = p[o + 9] * k + uy * lift; p[o + 10] = p[o + 10] * k + uz * lift;
      const i3 = i * 3;
      pos[i3] += p[o + 8] * dt + sx; pos[i3 + 1] += p[o + 9] * dt + sy; pos[i3 + 2] += p[o + 10] * dt + sz;
      p[o + 12] += p[o + 11] * dt;
      const f = age / life;
      const n3 = n * 3, n4 = n * 4, i4 = i * 4;
      gPos[n3] = pos[i3]; gPos[n3 + 1] = pos[i3 + 1]; gPos[n3 + 2] = pos[i3 + 2];
      gData[n4] = p[o + 15] ? p[o + 2] * (1 - f * f) : Math.max(0.01, p[o + 2] + p[o + 3] * age * (1 - 0.35 * f));
      gData[n4 + 1] = p[o + 4] * Math.min(1, age / Math.max(p[o + 6], 1e-4)) * (1 - f * f * (3 - 2 * f));
      gData[n4 + 2] = p[o + 13]; gData[n4 + 3] = p[o + 12];
      gCol[n4] = col[i4]; gCol[n4 + 1] = col[i4 + 1]; gCol[n4 + 2] = col[i4 + 2]; gCol[n4 + 3] = col[i4 + 3];
      n++;
    }
    this.liveCount = n;
    const g = this.object.geometry;
    g.instanceCount = n;
    if (n) {
      for (const name of ['iPos', 'iData', 'iColor']) { const a = g.attributes[name]; a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; }
    }
    this.object.visible = n > 0;
    return n;
  }
  clear() { this.live.fill(0); this.liveCount = 0; this.object.geometry.instanceCount = 0; this.object.visible = false; }
  dispose() { this.object.geometry.dispose(); this.object.material.dispose(); }
}
export { SmokeTrail as ParticleField };

// ---------------------------------------------------------------------------------------------
// Explosion
// ---------------------------------------------------------------------------------------------
let chunkGeo = null, chunkMat = null;
/**
 * One-shot explosion: flash + fireball + sparks + tumbling debris + smoke that lingers.
 * `size` ≈ radius in metres of the thing that blew up (1–6). Place `object` at the blast point.
 * update(dt, gravity?) → true while alive (gravity: Vector3 in the object's parent space, m/s²).
 * opts: { smoke: 0..1 (air density factor: none in vacuum), dust: hex | null (ground colour for a dirt burst) }
 */
export function createExplosion(size = 2, { smoke: smokeAmt = 1, dust = null } = {}) {
  const object = new THREE.Group(); object.name = 'explosion';
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDotTexture(), color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  flash.renderOrder = 8; object.add(flash);
  const field = new SmokeTrail({ max: 150 }); object.add(field.object);
  const rv = (mag) => { const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - z * z); return _v.set(s * Math.cos(a), z, s * Math.sin(a)).multiplyScalar(mag); };
  // fireball
  for (let i = 0; i < 16; i++) field.emit(_p.copy(rv(size * 0.5)), { size: size * (1 + Math.random()), growth: size * 3.6, life: 0.5 + Math.random() * 0.55, alpha: 0.9, vel: rv(size * (2 + Math.random() * 4)).clone(), drag: 2.6, color: _c.setRGB(...(i % 3 ? [5.0, 1.7, 0.35] : [6.0, 3.6, 1.2])), fadeIn: 0.03, add: 1 });
  // sparks
  for (let i = 0; i < 60; i++) field.emit(_p.set(0, 0, 0), { size: size * (0.1 + Math.random() * 0.14), growth: 0, life: 0.8 + Math.random() * 1.4, alpha: 1, vel: rv(size * (6 + Math.random() * 18)).clone(), drag: 0.7, gravity: 6, color: _c.setRGB(...(Math.random() < 0.5 ? [6.0, 3.4, 0.9] : [5.0, 1.6, 0.3])), fadeIn: 0.01, add: 1, shrink: true });
  // smoke that hangs around (only where there is air)
  const ns = Math.round(26 * clamp01(smokeAmt));
  for (let i = 0; i < ns; i++) { const dark = 0.05 + Math.random() * 0.12; field.emit(_p.copy(rv(size * 0.8)), { size: size * (1.3 + Math.random()), growth: size * (0.9 + Math.random()), life: 5 + Math.random() * 6, alpha: 0.62, vel: rv(size * (1 + Math.random() * 2.5)).clone(), drag: 1.4, rise: 1.2 + Math.random(), color: _c.setRGB(dark, dark * 0.96, dark * 0.92), fadeIn: 0.3 }); }
  if (dust !== null) { const d = new THREE.Color(dust); for (let i = 0; i < 18; i++) field.emit(_p.copy(rv(size * 0.6)), { size: size * (0.8 + Math.random()), growth: size * 1.6, life: 2.5 + Math.random() * 3, alpha: 0.5, vel: rv(size * (2 + Math.random() * 5)).clone(), drag: 1.8, gravity: smokeAmt > 0.2 ? 0 : 1.5, color: d, fadeIn: 0.15 }); }
  // debris chunks
  if (!chunkGeo) { chunkGeo = new THREE.BoxGeometry(1, 0.6, 0.25); chunkMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.7, metalness: 0.5 }); }
  const N = 14, chunks = new THREE.InstancedMesh(chunkGeo, chunkMat, N);
  chunks.frustumCulled = false; chunks.castShadow = true; object.add(chunks);
  const cs = [];
  for (let i = 0; i < N; i++) cs.push({ p: new THREE.Vector3(), v: rv(size * (4 + Math.random() * 12)).clone(), q: new THREE.Quaternion().random(), ax: rv(1).clone().normalize(), w: 3 + Math.random() * 9, s: size * (0.12 + Math.random() * 0.22) });
  const m4 = new THREE.Matrix4(), dq = new THREE.Quaternion(), sc = new THREE.Vector3();
  let t = 0; const life = smokeAmt > 0.2 ? 9 : 4;
  return {
    object,
    update(dt, gravity = null) {
      t += dt;
      const f = t / 0.45;
      if (f < 1) { flash.visible = true; const s = size * (3 + 16 * Math.pow(f, 0.5)); flash.scale.set(s, s, 1); const k = (1 - f) * (1 - f) * 6; flash.material.color.setRGB(k, k * 0.82, k * 0.5); } else flash.visible = false;
      field.update(dt, null, gravity ? _v.copy(gravity).multiplyScalar(-1 / (gravity.length() || 1)) : null);
      const fade = clamp01(1 - (t - 2.2) / 1.2);
      chunks.visible = fade > 0;
      if (chunks.visible) {
        for (let i = 0; i < N; i++) {
          const c = cs[i];
          if (gravity) c.v.addScaledVector(gravity, dt);
          c.p.addScaledVector(c.v, dt);
          c.q.premultiply(dq.setFromAxisAngle(c.ax, c.w * dt));
          m4.compose(c.p, c.q, sc.setScalar(c.s * fade));
          chunks.setMatrixAt(i, m4);
        }
        chunks.instanceMatrix.needsUpdate = true;
      }
      return t < life;
    },
    setLight(sunDir, sunCol, ambCol) { field.setLight(sunDir, sunCol, ambCol); },
    dispose() { flash.material.dispose(); field.dispose(); chunks.dispose(); },
  };
}

// ---------------------------------------------------------------------------------------------
// Re-entry plasma sheath
// ---------------------------------------------------------------------------------------------
// One surface in two parts, joined without a seam. Ahead of the vessel a shallow cap: the shock layer, brightest at
// the stagnation point and thinning to the shoulder. Behind it the sheath: gas streaming back off the shoulder,
// narrowing, breaking into streaks and tearing away raggedly. Nothing is drawn where the surface turns edge-on to
// the eye, so it has no outline: the old one showed its widest ring as a hard-rimmed disc.
const GLOW_RIM = '0.74';      // radius of the shoulder, as a share of uRadius
const GLOW_CAP = '0.55';      // depth of the cap ahead of the vessel, as a share of its radius
const GLOW_VS = `${LV0}
uniform float uRadius, uTail, uTime;
varying vec3 vNv; varying vec3 vPv; varying float vT; varying float vAng;
void main(){
  vec3 p = position; float t = position.y;      // -1 at the nose of the cap, 0 at the shoulder, 1 at the end of the tail
  vAng = atan(p.z, p.x);
  vec3 n;
  if (t > 0.0) {
    float wob = 1.0 + 0.10 * sin(vAng * 4.0 + uTime * 19.0 + t * 7.0) * t + 0.06 * sin(vAng * 9.0 - uTime * 31.0) * t * t;
    float rad = ${GLOW_RIM} * (1.0 - 0.78 * pow(t, 1.25)) * wob;
    vec2 d = normalize(position.xz + vec2(1e-5, 0.0));
    p = vec3(d.x * rad, t * uTail, d.y * rad);
    n = normalize(vec3(d.x, 0.78 * ${GLOW_RIM} / uTail, d.y));
  } else {
    p = vec3(position.x * ${GLOW_RIM}, t * ${GLOW_RIM} * ${GLOW_CAP}, position.z * ${GLOW_RIM});
    n = normalize(vec3(position.x * ${GLOW_CAP}, t, position.z * ${GLOW_CAP}));
  }
  vT = t;
  p *= uRadius;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vNv = normalize(normalMatrix * n);
  vPv = mv.xyz;
  gl_Position = projectionMatrix * mv;
  ${LV1}
}`;
const GLOW_FS = `${LF0}${NOISE}
uniform float uI, uTime;
varying vec3 vNv; varying vec3 vPv; varying float vT; varying float vAng;
void main(){
  ${LF1}
  float facing = abs(dot(normalize(vNv), normalize(-vPv)));
  // a shell of glowing gas is brightest where the eye looks along it, and this one fades out before its own edge
  float shell = smoothstep(0.0, 0.5, facing) * (0.4 + 1.1 * pow(1.0 - facing, 1.4));
  float n1 = fxNoise(vec2(vAng * 5.0, vT * 5.0 - uTime * 9.0));
  float n2 = fxNoise(vec2(vAng * 14.0 + 3.0, vT * 12.0 - uTime * 17.0));
  float n3 = fxNoise(vec2(vAng * 3.0 + 7.0, uTime * 6.0));
  float streak = smoothstep(0.25, 0.85, n1 * 0.65 + n2 * 0.35);
  float I = uI * (0.4 + 0.6 * min(uI, 1.0));
  float a, heat;
  if (vT < 0.0) {
    // the shock layer ahead of the vessel
    float c = -vT;
    a = (0.2 + 0.8 * pow(c, 1.3)) * (0.82 + 0.18 * n3);
    heat = I * (0.5 + 0.5 * c);
  } else {
    // the sheath: it starts as the shock layer ends, then streaks, thins and tears off
    float along = pow(max(1.0 - vT, 0.0), 1.5);
    float torn = smoothstep(0.0, 0.3, 1.0 - vT - 0.5 * n1 * vT);
    a = (0.2 + 0.75 * streak * smoothstep(0.0, 0.18, vT)) * along * torn;
    heat = I * (0.5 - 0.65 * vT) * (0.6 + 0.4 * streak);
  }
  a *= shell * I * 0.85;
  heat = clamp(heat, 0.0, 1.0);
  vec3 hot = mix(vec3(2.2, 0.42, 0.06), vec3(5.0, 2.0, 0.55), smoothstep(0.0, 0.6, heat));
  hot = mix(hot, vec3(7.0, 5.2, 3.2), smoothstep(0.6, 1.0, heat));
  hot = mix(hot, vec3(3.4, 1.6, 2.6), clamp(uI - 1.0, 0.0, 0.5) * (1.0 - facing));
  a *= 0.92 + 0.08 * sin(uTime * 41.0);
  a = min(a, 1.0);
  gl_FragColor = vec4(hot * a, a * 0.1);
  ${OUT}
}`;
/**
 * Re-entry / compression heating: a streaky plasma sheath. Parent `object` to the vessel's scene group.
 * update(intensity, flowDirLocal, dt): intensity 0 hides it, ~1 is a strong glow (up to 2); flowDirLocal = unit
 * vector in the parent's frame pointing DOWNSTREAM (the way the air moves past the vessel).
 */
export function createReentryGlow({ radius = 2, tail = 9 } = {}) {
  const u = { uRadius: { value: radius }, uTail: { value: tail / radius }, uTime: { value: 0 }, uI: { value: 0 } };
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 40), new THREE.ShaderMaterial({
    uniforms: u, vertexShader: GLOW_VS, fragmentShader: GLOW_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  }));
  mesh.frustumCulled = false; mesh.renderOrder = 6;
  const object = new THREE.Group(); object.name = 'reentryGlow'; object.add(mesh); object.visible = false;
  const up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(); let time = 0;
  return {
    object,
    update(intensity, flowDirLocal = null, dt = 1 / 60) {
      time += dt; u.uTime.value = time;
      const I = Math.max(0, Math.min(intensity, 2));
      u.uI.value = I; object.visible = I > 0.01;
      if (flowDirLocal && object.visible) { d.copy(flowDirLocal); if (d.lengthSq() > 1e-12) object.quaternion.setFromUnitVectors(up, d.normalize()); }
    },
    setSize(r, tailLen = r * 4.5) { u.uRadius.value = r; u.uTail.value = tailLen / r; },
    dispose() { mesh.geometry.dispose(); mesh.material.dispose(); },
  };
}

// ---------------------------------------------------------------------------------------------
// Transonic vapour cone
// ---------------------------------------------------------------------------------------------
const VAPOR_VS = `${LV0}
uniform float uR, uTime;
varying float vT; varying float vAng; varying vec3 vNv; varying vec3 vPv;
void main(){
  float t = position.y;                  // 0 at the shoulder … 1 downstream
  vT = t; vAng = atan(position.z, position.x);
  float rad = uR * (1.0 + 2.1 * pow(t, 0.8));
  vec3 p = vec3(position.x * rad, t * uR * 2.6, position.z * rad);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vNv = normalize(normalMatrix * normalize(vec3(position.x, -0.7, position.z))); vPv = mv.xyz;
  gl_Position = projectionMatrix * mv;
  ${LV1}
}`;
const VAPOR_FS = `${LF0}${NOISE}
uniform float uI, uTime; uniform vec3 uCol;
varying float vT; varying float vAng; varying vec3 vNv; varying vec3 vPv;
void main(){
  ${LF1}
  float facing = abs(dot(normalize(vNv), normalize(-vPv)));
  float n = fxNoise(vec2(vAng * 5.0, vT * 6.0 - uTime * 3.0)) * 0.6 + fxNoise(vec2(vAng * 13.0, vT * 15.0 - uTime * 5.0)) * 0.4;
  float band = smoothstep(0.0, 0.18, vT) * (1.0 - smoothstep(0.35, 1.0, vT));
  float a = band * (0.35 + 0.65 * n) * (0.35 + 0.65 * pow(1.0 - facing, 0.8)) * uI;
  gl_FragColor = vec4(uCol * a, a);
  ${OUT}
}`;
/** A skirt of condensation around the vessel near Mach 1 in dense air. Same conventions as createReentryGlow. */
export function createVaporCone() {
  const u = { uR: { value: 1.5 }, uTime: { value: 0 }, uI: { value: 0 }, uCol: { value: new THREE.Vector3(1.6, 1.65, 1.7) } };
  const geo = new THREE.CylinderGeometry(1, 1, 1, 32, 10, true); geo.translate(0, 0.5, 0);
  const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms: u, vertexShader: VAPOR_VS, fragmentShader: VAPOR_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  }));
  mesh.frustumCulled = false; mesh.renderOrder = 5;
  const object = new THREE.Group(); object.name = 'vaporCone'; object.add(mesh); object.visible = false;
  const up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(); let time = 0;
  return {
    object,
    update(intensity, flowDirLocal = null, dt = 1 / 60) {
      time += dt; u.uTime.value = time; u.uI.value = clamp01(intensity); object.visible = intensity > 0.01;
      if (flowDirLocal && object.visible) { d.copy(flowDirLocal); if (d.lengthSq() > 1e-12) object.quaternion.setFromUnitVectors(up, d.normalize()); }
    },
    setSize(r) { u.uR.value = r; },
    setLight(col) { u.uCol.value.set(col.r, col.g, col.b); },
    dispose() { geo.dispose(); mesh.material.dispose(); },
  };
}

// ---------------------------------------------------------------------------------------------
// Ground light pool (engine glow on the pad / regolith)
// ---------------------------------------------------------------------------------------------
const POOL_VS = `${LV0}
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${LV1}
}`;
const POOL_FS = `${LF0}
uniform vec3 uCol; uniform float uI;
varying vec2 vUv;
void main(){
  ${LF1}
  float d = length(vUv - 0.5) * 2.0;
  float a = pow(max(0.0, 1.0 - d), 2.2) * uI;
  gl_FragColor = vec4(uCol * a, 0.0);
  ${OUT}
}`;
/** A disc lying in the XZ plane (normal +Y) that adds light to whatever is under it. set(color [r,g,b], intensity, radius). */
export function createGroundGlow() {
  const u = { uCol: { value: new THREE.Vector3(1, 0.7, 0.4) }, uI: { value: 0 } };
  const geo = new THREE.PlaneGeometry(2, 2); geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms: u, vertexShader: POOL_VS, fragmentShader: POOL_FS, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }));
  mesh.frustumCulled = false; mesh.renderOrder = 3; mesh.visible = false; mesh.name = 'groundGlow';
  return {
    object: mesh,
    set(color, intensity, radius) { mesh.visible = intensity > 0.004; u.uI.value = intensity; if (color) u.uCol.value.set(color[0], color[1], color[2]); mesh.scale.set(radius, 1, radius); },
    dispose() { geo.dispose(); mesh.material.dispose(); },
  };
}
