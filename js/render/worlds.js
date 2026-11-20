// Starwright — the world renderer: everything outside the vessel. Stars and galaxy, the star with its glare, every
// planet and moon at its true position (globes near, lit points far away), and for the body you are at: level-of-
// detail terrain you can land on, ocean, cloud deck, ground clutter, and the atmosphere from space and from within.
//
//   const worlds = createWorldRenderer({ renderer, scene, camera, system: SYSTEM, quality: 'high' });
//   every frame, after the camera has been placed:
//     worlds.update({ ut, dt, body, origin });      // origin = position of the scene origin relative to `body`'s centre
//   worlds.info      what the rest of the game may want to know (sun direction and colour, sky brightness, …)
//   worlds.dispose()
// See docs/ARCHITECTURE.md, "Additions (second pass: worlds)".
import * as THREE from '../lib/three.module.min.js';
import { SYSTEM } from '../core/bodies.js';
import { createTerrain } from './terrain.js';
import { createBodyVisual, planetShine } from './globe.js';
import { createStarfield } from './sky.js';
import { createScatter } from './scatter.js';
import { atmoUniforms, atmoParams, ambientSky, skyAt, sunTransmit, SUN_SURFACE, ATMO_GLSL } from './atmosphere.js';
import { COMMON_GLSL } from './worldshaders.js';
import { getBodyMaps, requestBodyMaps, bakesPending } from './bodytex.js';
import { getPool } from './workpool.js';
import { styleOf, cloudAngle } from './worldstyle.js';
import { perf } from '../perf.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

const CLOUD_VS = `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vPosO;
void main(){ vPosO = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
#include <logdepthbuf_vertex>
}`;
const CLOUD_FS = `#include <common>
#include <logdepthbuf_pars_fragment>
${ATMO_GLSL}
${COMMON_GLSL}
uniform sampler2D uCloudTex;
uniform vec3 uCamO, uSun, uCloudColor, uAmbSky, uAmbNow;
uniform float uSunSurf, uShell, uSoft, uFade;
varying vec3 vPosO;
float h3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z); }
void main(){
#include <logdepthbuf_fragment>
  vec3 dirO = normalize(vPosO);
  vec3 toCam = uCamO - vPosO;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float cov = wEquirect(uCloudTex, dirO).r;
  // break the smooth baked coverage into puffs: three octaves of noise, strongest at the cloud edges
  float px = dist * 1.4 / 900.0;                        // rough footprint of a pixel, in body radii
  float d1 = n3(dirO * 310.0), d2 = n3(dirO * 1150.0 + 3.0), d3 = n3(dirO * 4300.0 + 7.0);
  float k1 = 1.0 - smoothstep(0.0008, 0.004, px), k2 = 1.0 - smoothstep(0.0002, 0.001, px), k3 = 1.0 - smoothstep(0.00006, 0.0003, px);
  float dn = mix(0.42, d1, k1) * 0.5 + mix(0.42, d2, k2) * 0.3 + mix(0.42, d3, k3) * 0.2;
  // finer structure from the same map read at smaller scales, so the big shapes break into cells and wisps
  vec2 cuv = vec2(atan(dirO.z, -dirO.x) * 0.15915494 + 0.5, acos(clamp(dirO.y, -1.0, 1.0)) * 0.31830989);
  vec2 cu2 = cuv * vec2(10.0, 5.0) + 0.37; cu2.y = abs(fract(cu2.y * 0.5) * 2.0 - 1.0);
  vec2 cu3 = cuv * vec2(34.0, 17.0) + 0.11; cu3.y = abs(fract(cu3.y * 0.5) * 2.0 - 1.0);
  float cdet = texture2D(uCloudTex, cu2).r * 0.65 + texture2D(uCloudTex, cu3).r * 0.35;
  float body = smoothstep(0.02, 0.3, cov) * (1.0 - smoothstep(0.9, 0.99, abs(dirO.y)));
  float edge = 4.0 * cov * (1.0 - cov);
  float dens = cov + (cdet - 0.3) * 0.5 * body * (1.0 - 0.7 * uSoft) + (dn - 0.42) * (0.2 + 0.5 * edge) * (1.0 - 0.6 * uSoft);
  float below = step(length(uCamO), uShell);            // 1 when the camera is under the deck
  // from above the deck feathers out into thin veils; from underneath a cloud has an edge
  float c = smoothstep(mix(0.24, 0.5, below) - 0.14 * uSoft, mix(0.74, 0.74, below) + 0.1 * uSoft, dens);
  float covS = wEquirect(uCloudTex, normalize(dirO + uSun * 0.008)).r;
  // the same finer structure a step toward the sun: banks seen from orbit get lit and shaded flanks too
  vec3 dSc = normalize(dirO + uSun * 0.003);
  vec2 cuvS = vec2(atan(dSc.z, -dSc.x) * 0.15915494 + 0.5, acos(clamp(dSc.y, -1.0, 1.0)) * 0.31830989);
  vec2 cs2 = cuvS * vec2(10.0, 5.0) + 0.37; cs2.y = abs(fract(cs2.y * 0.5) * 2.0 - 1.0);
  float cdetS = texture2D(uCloudTex, cs2).r;
  float relief = clamp(1.0 + (cov - covS) * 2.2 + (texture2D(uCloudTex, cu2).r - cdetS) * 1.6 * body, 0.42, 1.12) * (0.6 + 0.4 * smoothstep(0.25, 1.0, dens)) * (0.78 + 0.44 * cdet);
  // the puffs shade themselves: the same noise a little way toward the sun says whether this spot looks up at a
  // higher neighbour (in its shade) or stands proud (lit)
  vec3 dS = normalize(dirO + uSun * 0.0011), dS2 = normalize(dirO + uSun * 0.00035);
  float dnS = mix(0.42, n3(dS * 310.0), k1) * 0.62 + mix(0.42, n3(dS2 * 1150.0 + 3.0), k2) * 0.38;
  float dnH = mix(0.42, d1, k1) * 0.62 + mix(0.42, d2, k2) * 0.38;
  float self = clamp(0.72 + (dnH - dnS) * 3.4, 0.0, 1.0);
  float thick = smoothstep(0.3, 1.0, dens);
  float mu = dot(dirO, uSun);
  vec3 sunC = uSunSurf * aSunTransmit(dirO * uShell, uSun) * smoothstep(-0.06, 0.08, mu);
  // tops: lit shoulders, shaded hollows, a thin bright fringe; bases: pale where thin, soft grey where the deck is thick
  float top = (0.3 + 0.7 * self) * relief * (0.86 + 0.5 * (dn - 0.42)) * (0.84 + 0.16 * (1.0 - thick));
  float deep = smoothstep(0.55, 1.15, dens);            // how much cloud is overhead
  float base = mix(1.25, mix(0.62, 0.3, deep), smoothstep(0.3, 1.0, c)) * (0.72 + 0.56 * dn) * (0.85 + 0.3 * cdet);
  float shade = mix(top, base, below);
  float fwd = pow(max(dot(-V, uSun), 0.0), 10.0) * (1.0 - c) * below;          // silver lining toward the sun
  // from above: the daylight sky over that part of the world; from below: the sky the camera stands under right now
  vec3 amb = mix(uAmbSky * smoothstep(-0.2, 0.3, mu) * (0.75 + 0.5 * self), uAmbNow * mix(1.5, 0.8, deep), below) + vec3(0.012) + uNightGlow * 0.6;
  vec3 col = pow(uCloudColor, vec3(2.2)) * (sunC * (0.3 + 0.7 * max(mu, 0.0)) * shade * mix(0.42, 0.34, below) + sunC * fwd * 0.3 + amb * mix(0.72, 0.7, below));
  float a = c * 0.97 * uFade;
  if (below < 0.5) {
    // seen from above: the air between the camera and the deck
    vec3 trans;
    vec3 insc = aScatter(uCamO, -V, dist, uSun, 5, trans);
    col = col * trans + insc;
  } else {
    // from below, thin out toward the horizon where the deck dissolves into haze
    a *= smoothstep(0.0, 0.12, dot(V, -dirO) + 0.02);
  }
  gl_FragColor = vec4(col * a, a);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`;

function dotTexture() {
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,255,255,0.8)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.15)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/**
 * @param renderer  the game's WebGLRenderer (used for capability checks only)
 * @param scene     THREE.Scene (or Group) to add to. Its origin floats: see update().
 * @param camera    the camera that draws it
 * @param system    SYSTEM from js/core/bodies.js
 * @param quality   'low' | 'medium' | 'high'
 * @param farLimit  bodies farther than this from the camera are drawn at this distance, proportionally smaller
 */
export function createWorldRenderer({ renderer = null, scene, camera, system = SYSTEM, quality = 'high', farLimit = 5e7, scatter = true } = {}) {
  const group = new THREE.Group(); group.name = 'worlds';
  scene.add(group);
  const stars = createStarfield(quality === 'low' ? 3500 : 7000);
  group.add(stars);
  if (renderer && stars.userData.bake) stars.userData.bake(renderer);
  const dotTex = dotTexture();

  const entries = new Map();
  for (const body of system.bodies) {
    const vis = createBodyVisual(body, { quality: 'low' });
    group.add(vis.group);
    const e = { body, vis, terrain: null, clouds: null, scatter: null, dot: null, amb: ambientSky(body), hi: false };
    if (body.type !== 'star') {
      const c = new THREE.Color(body.color).lerp(new THREE.Color(0xffffff), 0.35);
      e.dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: c, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true, sizeAttenuation: true }));
      e.dot.renderOrder = 1; e.dot.name = 'dot_' + body.id; e.dot.userData.color = c;
      group.add(e.dot);
    }
    entries.set(body, e);
  }

  const g0 = new THREE.Vector3(), g1 = new THREE.Vector3(), rel = new THREE.Vector3(), cp = new THREE.Vector3(), camRel = new THREE.Vector3(), camBF = new THREE.Vector3(), originBF = new THREE.Vector3();
  const sunDir = new THREE.Vector3(1, 0, 0), up = new THREE.Vector3(), v1 = new THREE.Vector3(), q1 = new THREE.Quaternion(), m4 = new THREE.Matrix4(), m4b = new THREE.Matrix4();
  const lastCam = new THREE.Vector3(), lastFocus = new THREE.Vector3(), sunScene = new THREE.Vector3(1, 0, 0), orientQ = new THREE.Quaternion(), orientInv = new THREE.Quaternion(), qRot = new THREE.Quaternion();
  const sky = {}, tint = [1, 1, 1], tintC = new THREE.Color(), shine = { color: new THREE.Vector3(), dir: new THREE.Vector3() };
  let focus = null, time = 0, frame = 0, disposed = false;

  const info = {
    body: null, altitude: 0,
    sunDir: new THREE.Vector3(1, 0, 0),         // unit vector from the focus body toward the star (scene axes)
    sunElevation: 0,                            // radians above the camera's local horizon
    sunColor: new THREE.Color(1, 1, 1),         // direct sunlight at the camera after the air (multiply your sun light by it)
    skyZenith: new THREE.Color(), skyHorizon: new THREE.Color(),   // linear scene radiance of the sky
    skyLum: 0, starOpacity: 1,
    ambient: new THREE.Color(),                 // suggested ambient/hemisphere colour for vessels (linear)
    chunks: 0, drawn: 0, triangles: 0, pending: 0, drawCalls: 0,
    clutter: 0, clutterTriangles: 0,           // instances and triangles of ground clutter (rocks, grass, trees) this frame
    busy: false,
  };

  function ensureSurface(e) {
    const body = e.body;
    if (e.terrain || body.gas || body.type === 'star') return;
    e.terrain = createTerrain(body, { quality });
    group.add(e.terrain.group);
    const u = e.terrain.uniforms;
    u.uAmbSky.value.set(e.amb[0], e.amb[1], e.amb[2]);
    const st = styleOf(body.id);
    if (st.clouds) {
      const maps = getBodyMaps(body), shell = 1 + st.clouds.alt / body.radius;
      const cu = {
        ...atmoUniforms(body), uCloudTex: { value: maps.clouds }, uCamO: { value: new THREE.Vector3() }, uSun: { value: new THREE.Vector3(1, 0, 0) },
        uCloudColor: { value: new THREE.Vector3(...st.clouds.color) }, uAmbSky: { value: new THREE.Vector3(...e.amb) }, uAmbNow: { value: new THREE.Vector3() }, uSunSurf: { value: SUN_SURFACE },
        uShell: { value: shell }, uSoft: { value: st.clouds.soft || 0 }, uFade: { value: 1 },
      };
      const mat = new THREE.ShaderMaterial({
        uniforms: cu, vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS, side: THREE.DoubleSide, transparent: true, depthWrite: false,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(shell, 128, 64), mat);
      mesh.name = 'clouds_' + body.id; mesh.renderOrder = 2; mesh.frustumCulled = false;
      mesh.onBeforeRender = (r, s, cam) => {
        m4.copy(mesh.matrixWorld).invert();
        cu.uCamO.value.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(m4);
        mesh.matrixWorld.decompose(v1, q1, g1);
        cu.uSun.value.copy(sunScene).applyQuaternion(q1.invert()).normalize();
        mat.uniformsNeedUpdate = true;
      };
      group.add(mesh);
      e.clouds = { mesh, mat, speed: st.clouds.speed, style: st, shell, thick: st.clouds.cover > 0.8 };
    }
    if (scatter && st.scatter && quality !== 'low') { e.scatter = createScatter(body, st, { quality }); group.add(e.scatter.group); }
  }

  /**
   * Bring everything up to date.
   * @param ut      universal time, seconds (bodies' positions and rotations)
   * @param dt      real seconds since the last frame (animates water; independent of time warp)
   * @param body    the Body the camera is at (its SOI): gets terrain, ocean, clouds and sky
   * @param origin  Vector3: position of the scene origin relative to `body`'s centre, inertial axes, metres
   *                (double precision; with a floating origin this is the followed vessel's position)
   * @param orient  optional Quaternion turning inertial axes into the scene's axes (default: the scene IS inertial,
   *                as in flight). The space centre uses frameAt() to get a scene with +Y up, +X east, +Z south.
   * @param sync    optional ms the terrain may spend building chunks on this thread (used automatically on the
   *                first frame at a body and after a jump)
   */
  function update({ ut = 0, dt = 0, body, origin, orient = null, sync = -1 } = {}) {
    if (disposed) return info;
    frame++; time += dt;
    body = body || system.home;
    const fe = entries.get(body);
    camera.updateMatrixWorld();
    if (orient) orientQ.copy(orient); else orientQ.identity();
    orientInv.copy(orientQ).invert();
    group.quaternion.copy(orientQ);
    cp.setFromMatrixPosition(camera.matrixWorld).applyQuaternion(orientInv);   // camera in inertial axes, from the scene origin
    camRel.copy(origin).add(cp);                              // camera relative to the body centre
    const cr = camRel.length();
    up.copy(camRel).divideScalar(cr || 1);
    body.globalPosAt(ut, g0);
    if (body.type === 'star') sunDir.copy(up); else sunDir.copy(g0).multiplyScalar(-1).normalize();
    const R = body.radius, alt = cr - R;
    // (compared in body-fixed axes: standing still on a spinning world at high warp is not a jump)
    body.inertialToSurfaceDir(camRel, ut, camBF);
    const jumped = focus !== body || lastCam.distanceTo(camBF) > 3000 + 2 * Math.max(alt, 0);
    lastCam.copy(camBF);
    // the followed vessel changed place without the camera travelling far (a switch to a craft a kilometre off):
    // the ground round it is built before this frame is drawn, so it never stands on a coarse stand-in
    body.inertialToSurfaceDir(origin, ut, originBF);
    const focusJumped = jumped || lastFocus.distanceTo(originBF) > 40 + 0.1 * Math.max(alt, 0);
    lastFocus.copy(originBF);
    if (focus !== body) {
      if (focus) { const old = entries.get(focus); if (old.terrain) old.terrain.group.visible = false; if (old.clouds) old.clouds.mesh.visible = false; if (old.scatter) old.scatter.group.visible = false; }
      focus = body;
      ensureSurface(fe);
      requestBodyMaps(body, quality === 'low' ? 'medium' : 'high', true);
    }

    // ---- sky state at the camera
    const sinEl = clamp(up.dot(sunDir), -1, 1), elev = Math.asin(sinEl);
    skyAt(body, Math.max(alt, 0), elev, sky);
    sunTransmit(body, { x: 0, y: Math.max(cr / R, 1), z: 0 }, { x: Math.cos(elev), y: sinEl, z: 0 }, tint);
    info.body = body; info.altitude = alt;
    sunScene.copy(sunDir).applyQuaternion(orientQ);
    info.sunDir.copy(sunScene); info.sunElevation = elev;
    info.sunColor.setRGB(tint[0], tint[1], tint[2]);
    info.skyZenith.setRGB(sky.zenith[0], sky.zenith[1], sky.zenith[2]); info.skyHorizon.setRGB(sky.horizon[0], sky.horizon[1], sky.horizon[2]);
    info.skyLum = sky.lum;
    info.ambient.setRGB(0.5 * (sky.zenith[0] + sky.horizon[0]), 0.5 * (sky.zenith[1] + sky.horizon[1]), 0.5 * (sky.zenith[2] + sky.horizon[2]));
    info.starOpacity = 1 - sstep(0.0015, 0.03, Math.max(sky.lum, (sky.horizon[0] + sky.horizon[1] + sky.horizon[2]) / 3));
    stars.position.copy(cp);
    stars.scale.setScalar(Math.min(camera.far * 0.4, 5e5));
    stars.userData.setOpacity(info.starOpacity);

    // ---- bodies: globes (drawn nearer and smaller beyond farLimit) and points of light
    const fovK = Math.tan((camera.fov * Math.PI) / 360);
    for (const e of entries.values()) {
      const b = e.body;
      if (b === body) rel.copy(origin).multiplyScalar(-1);
      else rel.copy(b.globalPosAt(ut, g1)).sub(g0).sub(origin);
      const d = rel.distanceTo(cp);
      const k = d > farLimit ? farLimit / d : 1;
      e.vis.group.position.copy(rel).sub(cp).multiplyScalar(k).add(cp);
      e.vis.group.scale.setScalar(b.radius * k);
      if (b.type === 'star') { v1.copy(rel).sub(cp).normalize(); e.vis.update(ut, v1); e.vis.setSunTint(tintC.setRGB(tint[0], tint[1], tint[2]), 1 - sstep(0.004, 0.06, sky.lum)); }
      else { b.globalPosAt(ut, g1); e.vis.update(ut, v1.copy(g1).multiplyScalar(-1).normalize().applyQuaternion(orientQ), orientQ); }
      const solidFocus = b === body && !!e.terrain;
      e.vis.mesh.visible = !solidFocus;
      // apparent radius in pixels (for a 900 px tall view): tiny discs become points of light
      const px = (b.radius / d) / fovK * 450;
      e.vis.group.visible = px * (b.comet ? e.vis.extent : 1) > 0.7 || b === body;
      if (!e.hi && px > 40 && b.type !== 'star') { e.hi = true; requestBodyMaps(b, px > 160 && quality !== 'low' ? 'high' : 'medium'); }
      if (e.dot) {
        const show = px < 2.2 && b !== body;
        e.dot.visible = show;
        if (show) {
          // brightness from size, distance to the star and phase
          b.globalPosAt(ut, g1);
          const toSun = v1.copy(g1).multiplyScalar(-1).normalize();
          const toCam = rel.clone().sub(cp).multiplyScalar(-1).normalize();
          const phase = 0.5 + 0.5 * toSun.dot(toCam);
          const flux = (b.radius * b.radius) / (d * d) * 1.2e13 / Math.max(g1.lengthSq(), 1e18);
          const bright = clamp(Math.pow(flux * 2e7 * (0.15 + 0.85 * phase), 0.3), 0.12, 2.4) * (1 - 0.92 * (1 - info.starOpacity));
          const dd = farLimit * 0.98, size = dd * fovK * (2 / 900) * (2.4 + 1.6 * Math.min(1, bright));
          e.dot.position.copy(rel).sub(cp).normalize().multiplyScalar(dd).add(cp);
          e.dot.scale.setScalar(size * 2.2);
          const c = e.dot.userData.color; e.dot.material.color.setRGB(c.r * bright, c.g * bright, c.b * bright);
        }
      }
    }

    // ---- the focus body's surface
    let st = null;
    if (fe.terrain) {
      const t = fe.terrain, ang = body.rotationAngle(ut);
      t.group.visible = true;
      t.group.position.copy(origin).multiplyScalar(-1);
      t.group.quaternion.setFromAxisAngle(Y_AXIS, ang);
      body.inertialToSurfaceDir(origin, ut, originBF);
      const u = t.uniforms;
      u.uRot.value.setFromMatrix4(m4b.makeRotationFromQuaternion(qRot.copy(orientQ).multiply(t.group.quaternion)));
      u.uCamU.value.copy(camRel).divideScalar(R).applyQuaternion(orientQ);
      u.uSun.value.copy(sunScene);
      u.uSkyZen.value.set(sky.zenith[0], sky.zenith[1], sky.zenith[2]); u.uSkyHor.value.set(sky.horizon[0], sky.horizon[1], sky.horizon[2]);
      u.uTime.value = time;
      if (planetShine(body, ut, shine)) { u.uShine.value.copy(shine.color); u.uShineDir.value.copy(shine.dir).applyQuaternion(orientQ); }
      const cloudRot = fe.clouds ? cloudAngle(fe.clouds.style, ut) : 0;
      u.uCloudRot.value = cloudRot;
      perf.begin('terrain'); t.update(camBF, { sync: sync >= 0 ? sync : jumped ? 350 : 0, focus: originBF, focusSync: focusJumped }); perf.end();
      st = t.stats;
      if (fe.clouds && fe.clouds.thick && fe.vis.atmosphere) fe.vis.atmosphere.material.uniforms.uGround.value = cr > fe.clouds.shell * R ? fe.clouds.shell : 0.994;
      if (fe.clouds) {
        const cm = fe.clouds.mesh;
        cm.visible = true;
        cm.position.copy(t.group.position); cm.scale.setScalar(R);
        cm.rotation.set(0, ang + cloudRot, 0);
        fe.clouds.mat.uniforms.uAmbNow.value.set(info.ambient.r, info.ambient.g, info.ambient.b);
      }
      if (fe.scatter) {
        fe.scatter.group.position.copy(t.group.position); fe.scatter.group.quaternion.copy(t.group.quaternion);
        perf.begin('terrain');
        fe.scatter.update(camBF, { sunDir: sunScene, rot: u.uRot.value, camU: u.uCamU.value, sunColor: tint, amb: fe.amb, alt: alt - body.terrainHeight(camBF, 30), time, day: sstep(-0.04, 0.06, sinEl) });
        perf.end();
      }
    }
    info.chunks = st ? st.chunks : 0; info.drawn = st ? st.drawn : 0; info.triangles = st ? st.triangles : 0; info.pending = st ? st.pending : 0;
    info.drawCalls = (st ? st.drawn : 1) + 2 + (fe.clouds ? 1 : 0) + (fe.scatter ? fe.scatter.drawCalls : 0) + (atmoParams(body) ? 1 : 0);
    info.clutter = fe.scatter && fe.scatter.group.visible ? fe.scatter.instances : 0; info.clutterTriangles = fe.scatter && fe.scatter.group.visible ? fe.scatter.triangles : 0;
    info.busy = (st ? st.pending > 0 : false) || getBodyMaps(body).pending > 0;
    return info;
  }

  return {
    group, info, update, stars, entries,
    /**
     * A ground-fixed frame for scenes built in local coordinates (the space centre): the scene origin sits on the
     * surface point `dirBodyFixed` (+ `height` metres above the datum) with +Y up, +X east, +Z south.
     * Pass the result straight on: worlds.update({ ut, body, ...worlds.frameAt(body, dir, ut) }).
     */
    frameAt(body, dirBodyFixed, ut, height = 0, out = { origin: new THREE.Vector3(), orient: new THREE.Quaternion() }) {
      const upI = body.surfaceDirToInertial(dirBodyFixed, ut, new THREE.Vector3()).normalize();
      const east = new THREE.Vector3().crossVectors(Y_AXIS, upI);
      if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
      east.normalize();
      const south = new THREE.Vector3().crossVectors(east, upI);
      // rows of the inertial → scene rotation are the scene axes written in inertial coordinates
      m4.set(east.x, east.y, east.z, 0, upI.x, upI.y, upI.z, 0, south.x, south.y, south.z, 0, 0, 0, 0, 1);
      out.orient.setFromRotationMatrix(m4);
      out.origin.copy(upI).multiplyScalar(body.radius + height);
      return out;
    },
    /**
     * Height (m above body.radius) of the ground AS DRAWN at a body-fixed direction (need not be normalised): the
     * triangles of the terrain chunk on screen there, with the sea surface where there is sea. Physics stands on
     * body.terrainHeight(dir); round the scene origin (the vessel) the two agree to a few centimetres once the
     * chunks are in (worlds.info.busy false). Use the difference to nudge what must visibly touch the ground.
     * `out` (optional) gets { spacing, level } of the chunk used; spacing is Infinity when the body has no terrain
     * on screen (not the focus body, gas giant) and the height function answered instead.
     */
    heightAt(body, dirBodyFixed, out = null) {
      const e = entries.get(body);
      if (e && e.terrain && e.terrain.group.visible) return e.terrain.heightAt(dirBodyFixed, out);
      if (out) { out.spacing = Infinity; out.level = -1; }
      return body.surfaceHeight ? body.surfaceHeight(dirBodyFixed) : 0;
    },
    /** the globe/terrain objects of a body: { vis, terrain, clouds, scatter } */
    get(body) { return entries.get(body); },
    /** Resolves when no chunk or texture work is outstanding (screenshots, loading screens). */
    async settle(maxMs = 20000) {
      const t0 = performance.now();
      while (performance.now() - t0 < maxMs) {
        await new Promise((r) => setTimeout(r, 30));
        if (!(getPool().pending > 0)) break;
      }
    },
    dispose() {
      disposed = true;
      scene.remove(group);
      for (const e of entries.values()) {
        e.vis.dispose();
        if (e.terrain) e.terrain.dispose();
        if (e.clouds) { e.clouds.mesh.geometry.dispose(); e.clouds.mat.dispose(); }
        if (e.scatter) e.scatter.dispose();
        if (e.dot) e.dot.material.dispose();
      }
      if (stars.userData.dispose) stars.userData.dispose();
      dotTex.dispose();
    },
  };
}
