// Starwright — the 3D flight scene.
//
// FLOATING ORIGIN: the followed vessel's centre of mass is the scene origin. Every other object is placed at
// (its position − the vessel's position), computed in double precision before it is handed to three.js.
//
// Two THREE.Scenes share one camera and one depth buffer:
//   far   stars, sky, the star, planets and moons, terrain                      (sun light + a whisper of ambient)
//   near  vessels, debris, Pips, flags, the space centre, plumes/smoke/explosions (sun with shadows + sky fill + IBL)
// so the night side of a craft is never pitch black while planets keep a proper dark side.
// Both are drawn into a linear HDR target and finished by the post chain (js/render/post.js: bloom, lens, ACES);
// with post-processing switched off (or unsupported) they go straight to the canvas with the renderer's own tone mapping.
//
//   const fs = createFlightScene(app)
//   fs.far, fs.near, fs.camera, fs.anchor {body, pos, vel, q, valid, ground}
//   fs.update(world, dt, simDt, cam)     sync everything to the world (cam = flight camera controller)
//   fs.render(renderer)
//   fs.onWorldEvent(type, payload, world)   explosion, dock, undock, decouple, landed, splashed, chute, stage
//   fs.views                             Map(Vessel → {group, parts: Map(id → {part, mesh}), stamp, builds})
//   fs.info                              { sunElevation, daylight, skyLum, heatGlow, rumble, buffet, mach, groundDist }
//   fs.fx                                { smoke (particle pool), post, quality }      fs.applySettings()
//   fs.dispose()
// A vessel's meshes are re-synchronised whenever vessel.structureStamp changes (stage, break, dock, undock) and
// rebuilt from scratch after a `dock` / `undock` event. Parts honour `part.flip` (yaw(rot) · rotX(π)).
//
// Optional work of other modules is used when present and skipped when not (the scene always runs):
//   js/render/basegfx.js  createBase()          the space centre at the launch site (else planetgfx.createLaunchPad)
//   planetgfx createWorldRenderer()             terrain + oceans + clouds + sky + bodies (else the body visuals / terrain patch / haze here)
//   partmesh animation hooks (updatePartMesh)   per-frame part animation
import * as THREE from '../lib/three.module.min.js';
import { SYSTEM } from '../core/bodies.js';
import { World } from '../core/world.js';
import * as PM from '../render/partmesh.js';
import * as GFX from '../render/planetgfx.js';
import { createPlume, SmokeTrail, createExplosion, createReentryGlow, createVaporCone, createGroundGlow } from '../render/fx.js';
import { createPostChain } from '../render/post.js';
import { createGovernor } from './governor.js';

const { buildPartMesh, setPartState, disposePartMesh, animatePip, nozzleExits } = PM;
const { createBodyVisual, createTerrainPatch, createStarfield, createLaunchPad, skyColor, createFlagMesh } = GFX;

const FAR_LIMIT = 5e7;            // bodies farther than this are drawn closer and proportionally smaller
const VESSEL_RANGE = 120000;      // other vessels are drawn within this distance
const TERRAIN_ALT = 120000;       // terrain patch is shown below this altitude
const TERRAIN_RECENTER = 15000;   // m of ground track before the patch is rebuilt around the vessel
const TAU = Math.PI * 2;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const FLIP_X = new THREE.Quaternion(1, 0, 0, 0);     // half a turn about +X
const LAMP_COL = [1, 0.93, 0.8];
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const QUALITY = {
  // software rasterisers (no GPU; also the headless test browser): the 3D view is drawn at a third of the
  // resolution and upscaled by the final pass, with no bloom and no shadows. Fill rate is all that matters there.
  soft: { post: true, samples: 0, shadow: 0, particles: 0.4, scale: 0.34, noBloom: true, mesh: 'low' },
  low: { post: false, samples: 0, shadow: 0, particles: 0.5, mesh: 'medium' },
  medium: { post: true, samples: 0, shadow: 1024, particles: 0.75, mesh: 'medium' },
  high: { post: true, samples: 4, shadow: 2048, particles: 1, mesh: 'high' },
};

const HAZE_VS = `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main(){ vDir = normalize(mat3(modelMatrix) * position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
#include <logdepthbuf_vertex>
}`;
const HAZE_FS = `#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uUp, uSun, uHorizon, uZenith, uSunTint; uniform float uAlpha, uDip, uSunGlow;
varying vec3 vDir;
void main(){
#include <logdepthbuf_fragment>
  vec3 d = normalize(vDir);
  float h = dot(d, uUp) + uDip;
  float t = pow(clamp(h, 0.0, 1.0), 0.5);
  vec3 col = mix(uHorizon, uZenith, t);
  float s = max(dot(d, uSun), 0.0);
  // forward scattering: a wide warm veil and a tight glare around the sun
  col += uSunTint * (pow(s, 64.0) * 0.9 + pow(s, 8.0) * 0.22 + pow(s, 2.0) * 0.06) * uSunGlow;
  // a brighter band hugging the horizon
  col += uHorizon * 0.35 * exp(-abs(h) * 9.0);
  gl_FragColor = vec4(col, uAlpha);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`;

/** A tiny procedural environment (sky dome over ground, a sun patch) for image-based reflections on metal. */
function makeEnvironment(renderer) {
  if (!renderer) return null;
  try {
    const s = new THREE.Scene();
    const geo = new THREE.SphereGeometry(10, 32, 16);
    const col = new Float32Array(geo.attributes.position.count * 3), p = geo.attributes.position, c = new THREE.Color();
    const zen = new THREE.Color(0.16, 0.34, 0.75), hor = new THREE.Color(0.75, 0.85, 0.98), gnd = new THREE.Color(0.2, 0.19, 0.16), sun = new THREE.Vector3(0.5, 0.62, 0.6).normalize(), d = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      d.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
      if (d.y >= 0) c.copy(hor).lerp(zen, Math.pow(d.y, 0.5)); else c.copy(hor).multiplyScalar(0.6).lerp(gnd, Math.min(1, -d.y * 5));
      const k = Math.pow(Math.max(0, d.dot(sun)), 24) * 9;
      col[i * 3] = c.r + k; col[i * 3 + 1] = c.g + k * 0.94; col[i * 3 + 2] = c.b + k * 0.82;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, toneMapped: false }));
    s.add(m);
    const gen = new THREE.PMREMGenerator(renderer);
    const rt = gen.fromScene(s, 0.03, 0.1, 100);
    gen.dispose(); geo.dispose(); m.material.dispose();
    return rt;
  } catch (err) { console.warn('[flight] environment map unavailable:', err && err.message); return null; }
}

/**
 * The space-centre model bends its vertices down to the globe (d²/2R), but a long flat piece (the 2 km runway is
 * one quad) then spans the curve as a chord and sinks up to 0.8 m under the terrain. Split every long, level
 * triangle until its edges are short and put the new vertices on the curve. No-op for a model without long flats.
 */
function drapeFlats(group, R, limit = 90) {
  if (!(R > 0)) return 0;
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert(), m = new THREE.Matrix4();
  const drop = (x, z) => -(x * x + z * z) / (2 * R);
  let added = 0;
  group.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !o.geometry || !o.geometry.attributes.position || added > 60000) return;
    const e = m.multiplyMatrices(inv, o.matrixWorld).elements;
    if (Math.abs(e[0] - 1) > 1e-6 || Math.abs(e[5] - 1) > 1e-6 || Math.abs(e[10] - 1) > 1e-6) return;      // translation only
    const tx = e[12], ty = e[13], tz = e[14];
    const src = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    const names = Object.keys(src.attributes).filter(n => n !== 'position');
    const attrs = [src.attributes.position, ...names.map(n => src.attributes[n])];
    if (attrs.some(a => a.isInterleavedBufferAttribute)) return;
    const sizes = attrs.map(a => a.itemSize), stride = sizes.reduce((a, b) => a + b, 0), P = attrs[0];
    const flatY = v => v[1] + ty - drop(v[0] + tx, v[2] + tz);
    const long = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
    // quick reject: nothing long and level in this mesh
    let any = false;
    for (let i = 0; i < P.count && !any; i += 3) {
      const ax = P.getX(i), az = P.getZ(i), bx = P.getX(i + 1), bz = P.getZ(i + 1), cx = P.getX(i + 2), cz = P.getZ(i + 2);
      if (Math.max(Math.hypot(ax - bx, az - bz), Math.hypot(bx - cx, bz - cz), Math.hypot(cx - ax, cz - az)) > limit) any = true;
    }
    if (!any) return;
    const read = i => { const v = new Array(stride); let k = 0; for (let a = 0; a < attrs.length; a++) for (let c = 0; c < sizes[a]; c++) v[k++] = attrs[a].array[i * sizes[a] + c]; return v; };
    const out = [], stack = [];
    let split = 0;
    for (let i = 0; i < P.count; i += 3) {
      stack.push([read(i), read(i + 1), read(i + 2)]);
      while (stack.length) {
        const t = stack.pop();
        const f0 = flatY(t[0]), f1 = flatY(t[1]), f2 = flatY(t[2]);
        const l = [long(t[0], t[1]), long(t[1], t[2]), long(t[2], t[0])], k = l[0] >= l[1] && l[0] >= l[2] ? 0 : l[1] >= l[2] ? 1 : 2;
        if (l[k] <= limit || Math.max(f0, f1, f2) - Math.min(f0, f1, f2) > 0.5 || split > 40000) { out.push(t[0], t[1], t[2]); continue; }
        const a = t[k], b = t[(k + 1) % 3], c = t[(k + 2) % 3], mid = new Array(stride);
        for (let q = 0; q < stride; q++) mid[q] = (a[q] + b[q]) / 2;
        mid[1] = (flatY(a) + flatY(b)) / 2 + drop(mid[0] + tx, mid[2] + tz) - ty;
        stack.push([a, mid, c], [mid, b, c]); split++;
      }
    }
    if (!split) return;
    const g = o.geometry; let off = 0;
    g.setIndex(null);
    ['position', ...names].forEach((n, ai) => {
      const size = sizes[ai], arr = new Float32Array(out.length * size);
      for (let i = 0; i < out.length; i++) for (let c = 0; c < size; c++) arr[i * size + c] = out[i][off + c];
      const at = new THREE.BufferAttribute(arr, size, attrs[ai].normalized); g.setAttribute(n, at); off += size;
    });
    g.clearGroups(); g.computeBoundingBox(); g.computeBoundingSphere();
    added += split;
  });
  return added;
}

export function createFlightScene(app) {
  const far = new THREE.Scene(), near = new THREE.Scene();
  far.name = 'flight-far'; near.name = 'flight-near';
  far.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(55, (app.size.w || 16) / (app.size.h || 9), 0.1, 2e9);
  const settings = () => app.settings || {};
  let quality = QUALITY.high, qualityName = '';
  // automatic quality (js/ui/governor.js): trades render scale, then shadows, then post, for frame rate
  const gov = createGovernor();
  let govLast = 0;

  // ---- lights
  const sunFar = new THREE.DirectionalLight(0xfff4e2, 3.0); far.add(sunFar, sunFar.target);
  const ambFar = new THREE.AmbientLight(0x8fa8c8, 0.08); far.add(ambFar);
  const sunNear = new THREE.DirectionalLight(0xfff4e2, 3.0); near.add(sunNear, sunNear.target);
  sunNear.shadow.mapSize.set(2048, 2048); sunNear.shadow.bias = -0.0004; sunNear.shadow.normalBias = 0.06;
  const hemi = new THREE.HemisphereLight(0xbcd8ff, 0x5a5348, 0.8); near.add(hemi);
  const bounce = new THREE.DirectionalLight(0xbfd4ee, 0.25); near.add(bounce, bounce.target);
  const head = new THREE.DirectionalLight(0xffffff, 0.2); near.add(head, head.target);      // faint "camera" fill so shapes always read
  const engineLight = new THREE.PointLight(0xffb070, 0, 0, 2); near.add(engineLight);
  const env = makeEnvironment(app.renderer);
  if (env) { near.environment = env.texture; near.environmentIntensity = 0.6; }
  const sunTint = new THREE.Color(1, 1, 1), ambTint = new THREE.Color();

  // ---- ground shadow catcher (the vessel's shadow on whatever terrain is drawn under it) + engine light pool
  const catcher = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.5, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  catcher.receiveShadow = true; catcher.visible = false; catcher.renderOrder = 2; catcher.name = 'shadowCatcher'; near.add(catcher);
  const pool = createGroundGlow(); near.add(pool.object);
  // headlamps of the vessel being flown: one spot light for nearby objects and a pool of light on the ground ahead
  // (the terrain shader lights itself from the sun only, so the pool decal is what shows the beam on the ground)
  const lamp = new THREE.SpotLight(0xfff1d6, 0, 90, 0.5, 0.6, 1.6); lamp.castShadow = false; near.add(lamp, lamp.target);
  const lampPool = createGroundGlow(); near.add(lampPool.object);

  // a software rasteriser (no GPU: remote desktops, CI) gets the light path unless the player insists
  let softGL = false;
  try { const gl = app.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); softGL = /swiftshader|llvmpipe|software/i.test(String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))); } catch { softGL = false; }
  const startQuality = softGL && !settings().gfxForce ? 'low' : QUALITY[settings().gfxQuality] ? settings().gfxQuality : 'high';

  // ---- the world outside the vessel: the worlds renderer (terrain, oceans, clouds, sky, every body) when
  //      planetgfx provides it, else the first release's body visuals + terrain patch + haze dome below
  let worldsR = null, settleMs = 0;      // settleMs: build terrain on this thread for that long on the next frame (settleTerrain)
  if (typeof GFX.createWorldRenderer === 'function') {
    try { worldsR = GFX.createWorldRenderer({ renderer: app.renderer, scene: far, camera, system: SYSTEM, quality: startQuality, farLimit: FAR_LIMIT }); }
    catch (err) { console.warn('[flight] world renderer failed to start, using the simple planets:', err && err.message); worldsR = null; }
  }
  const legacy = !worldsR;

  // ---- sky (legacy path)
  const stars = legacy ? createStarfield(4500) : new THREE.Group(); far.add(stars);
  const hazeU = { uUp: { value: new THREE.Vector3(0, 1, 0) }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uHorizon: { value: new THREE.Color() }, uZenith: { value: new THREE.Color() }, uSunTint: { value: new THREE.Color(1, 0.86, 0.62) }, uAlpha: { value: 0 }, uDip: { value: 0 }, uSunGlow: { value: 1 } };
  const haze = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({
    uniforms: hazeU, vertexShader: HAZE_VS, fragmentShader: HAZE_FS, side: THREE.BackSide, depthTest: false, depthWrite: false,
    transparent: false, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  }));
  haze.frustumCulled = false; haze.renderOrder = -9; haze.name = 'skyHaze'; far.add(haze);

  // ---- bodies
  const bodies = new Map();       // Body → {vis, hi:boolean}
  if (legacy) for (const body of SYSTEM.bodies) {
    const vis = createBodyVisual(body, { quality: body === SYSTEM.home ? 'high' : 'low' });
    far.add(vis.group);
    bodies.set(body, { vis, hi: body === SYSTEM.home });
  }
  const terrains = new Map();     // Body → patch
  let terrain = null, terrainBody = null, terrainFresh = false;

  // ---- launch site: the shared space-centre model when it exists, else the simple pad
  let base = null, pad = null, padOffset = new THREE.Vector3();
  const padQ = World.padFrame(SYSTEM.launchSite.dir);
  const padQLegacy = padQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.PI));   // old pad: tower to the west
  function useLegacyPad() { if (pad) return; pad = createLaunchPad(); pad.visible = false; shadowFlags(pad, false, true); near.add(pad); }
  function adoptBase(b) {
    if (!b || !b.group || disposed) { if (b && b.dispose) b.dispose(); return; }
    if (pad) { near.remove(pad); pad.traverse(o => { if (o.geometry) o.geometry.dispose(); }); pad = null; }
    base = b; base.group.visible = false;
    // the pad is where the player's vessel stands: no show rocket, the crawler stays parked (SECOND_PASS / basegfx)
    if (typeof b.setDisplay === 'function') { try { b.setDisplay('none'); } catch { /* older model */ } }
    try { drapeFlats(base.group, SYSTEM.home.radius); } catch (err) { console.warn('[flight] could not drape the space centre on the globe:', err && err.message); }
    shadowFlags(base.group, true, true);
    if (typeof b.setVegetation === 'function') b.setVegetation(settings().gfxVegetation, qualityName, gov.state.detail);   // [realism pass]
    near.add(base.group);
    // the vessel stands on the simulation's ground point: put the model's pad anchor exactly there
    padOffset.set(0, 0, 0);
    if (b.padAnchor) { base.group.updateMatrixWorld(true); b.padAnchor.getWorldPosition(padOffset); base.group.worldToLocal(padOffset); }
    deckMeshes.length = 0;
    base.group.traverse(o => { if (o.isMesh && !o.isInstancedMesh && DECK_NAMES[o.name]) deckMeshes.push(o); });
  }
  // The space centre's paving as drawn. Polygon offset cannot be relied on to order these layers (the logarithmic depth
  // buffer writes depth in the fragment shader), so the model stacks them: terrain 0, slabs +3 to +7 cm, pad deck and
  // markings up to +9 cm. A vessel standing there is lifted onto the top layer; decals are put above it.
  const DECK_NAMES = { slab: 1, asphalt: 1, concrete: 1, mark: 1 }, DECK_MAX = 0.3;
  const deckMeshes = [], deckRay = new THREE.Raycaster(), deckHits = [], dk1 = new THREE.Vector3(), dk2 = new THREE.Vector3();
  /** Does nothing of the space centre stand between an orbit-camera view (yaw, pitch, dist about the vessel) and the craft? */
  let sightFor = null;
  const sightRay = new THREE.Raycaster(), sg1 = new THREE.Vector3(), sg2 = new THREE.Vector3(), sg3 = new THREE.Vector3(), sg4 = new THREE.Vector3(), sgHits = [];
  function sightClear(yaw, pitch, dist, v, cam0) {
    // the camera's frame (ui/flightcam.js, orbit mode): up, "east", "north"
    const up = sg1.copy(anchor.pos); if (up.lengthSq() < 1e-9) return true; up.normalize();
    const east = sg2.set(0, 1, 0).cross(up); if (east.lengthSq() < 1e-9) east.set(0, 0, -1); east.normalize();
    const north = sg3.crossVectors(up, east).normalize();
    const cp = Math.cos(pitch), from = sg4.set(0, 0, 0).addScaledVector(north, cp * Math.cos(yaw) * dist).addScaledVector(east, cp * Math.sin(yaw) * dist).addScaledVector(up, Math.sin(pitch) * dist);
    // … and the camera rides below that line, so that the craft stands above the instruments (cam.bias)
    { const k = -(cam0.bias || 0) * dist / Math.max(cp, 0.05), sp = Math.sin(pitch); from.multiplyScalar(1 - k * sp / dist).addScaledVector(up, k); }
    const bound = Math.max(2, v.boundRadius || 4), side = new THREE.Vector3().crossVectors(up, from).normalize();
    base.group.updateMatrixWorld(true);
    for (const [u, sd] of [[0, 0], [0.55, 0], [0.25, 0.2], [0.25, -0.2], [-0.15, 0]]) {
      const to = new THREE.Vector3().addScaledVector(up, u * bound).addScaledVector(side, sd * bound).sub(from), len = to.length();
      sightRay.set(from, to.multiplyScalar(1 / len)); sightRay.near = 0.2; sightRay.far = len - Math.min(bound * 0.5, 3) - 0.75;
      sgHits.length = 0;
      sightRay.intersectObject(base.group, true, sgHits);
      for (const h of sgHits) {
        const o = h.object, m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (!o.isMesh || !m || m.depthWrite === false || (m.transparent && m.opacity < 0.5) || o.name === 'slab' || o.name === 'asphalt' || o.name === 'mark') continue;
        let seen = true; for (let q = o; q; q = q.parent) if (!q.visible) { seen = false; break; }
        if (seen) return false;
      }
    }
    return true;
  }
  /**
   * Height (m) of the topmost paving above the space centre's ground under a scene-space point `p` (`up`: local
   * vertical, `reach`: how far below p the ground is). 0 where there is none. Cached per view while it stands still.
   */
  function deckUnder(view, p, up, reach) {
    if (!base || !deckMeshes.length) return 0;
    const g = base.group;
    g.updateWorldMatrix(true, false);
    dk1.copy(p).addScaledVector(up, -reach); g.worldToLocal(dk1);              // the ground point, in the model's frame
    const c = view.deckAt || (view.deckAt = { x: 1e9, y: 1e9, z: 1e9, h: 0 });
    if (Math.abs(dk1.x - c.x) < 0.03 && Math.abs(dk1.z - c.z) < 0.03 && Math.abs(dk1.y - c.y) < 0.03) return c.h;
    c.x = dk1.x; c.y = dk1.y; c.z = dk1.z; c.h = 0;
    g.updateMatrixWorld(true);
    deckRay.set(dk2.copy(p).addScaledVector(up, -reach + DECK_MAX + 1), dk1.copy(up).negate()); deckRay.near = 0; deckRay.far = DECK_MAX + 2;
    deckHits.length = 0;
    deckRay.intersectObjects(deckMeshes, false, deckHits);
    const R = SYSTEM.home.radius;
    for (const hit of deckHits) {
      g.worldToLocal(dk2.copy(hit.point));
      const h = dk2.y - padOffset.y + ((dk2.x - padOffset.x) ** 2 + (dk2.z - padOffset.z) ** 2) / (2 * R);     // above the model's (curved) ground
      if (h > 0.002 && h <= DECK_MAX) { c.h = h; break; }                                                          // hits come nearest first: the top layer
    }
    return c.h;
  }
  useLegacyPad();
  let disposed = false;
  if (app.flightBaseFactory) { try { adoptBase(app.flightBaseFactory({ quality: startQuality, interactive: false })); } catch (err) { console.warn('[flight] space centre model failed, using the simple pad:', err && err.message); useLegacyPad(); } }

  // ---- effects
  const gRef = { body: null, ok: false, dir: new THREE.Vector3(), prev: new THREE.Vector3() };
  const smoke = new SmokeTrail({ max: 3600 }); near.add(smoke.object);
  const explosions = [];          // {fx, pos, vel, body}
  const views = new Map();        // Vessel → view
  const flagViews = new Map();    // flag object → mesh
  let glow = null, vapor = null;
  let post = null;
  if (app.renderer) { try { post = createPostChain(app.renderer); if (!post.supported) { post.dispose(); post = null; } } catch (err) { console.warn('[flight] post-processing unavailable:', err && err.message); post = null; } }

  const anchor = { body: SYSTEM.home, pos: new THREE.Vector3(SYSTEM.home.radius, 0, 0), vel: new THREE.Vector3(), q: new THREE.Quaternion(), valid: false, vessel: null, ground: SYSTEM.home.radius, ut: 0 };
  const info = { sunElevation: 1, daylight: 1, skyLum: 0, sunDir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), heatGlow: 0, rumble: 0, buffet: 0, mach: 0, groundDist: 0, sunUv: new THREE.Vector2(0.5, 0.5), sunVisible: 0 };

  const g1 = new THREE.Vector3(), g2 = new THREE.Vector3(), g3 = new THREE.Vector3(), rel = new THREE.Vector3();
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3(), v5 = new THREE.Vector3(), v6 = new THREE.Vector3();
  const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), e1 = new THREE.Euler();
  const sky = new THREE.Color(), col2 = new THREE.Color(), col3 = new THREE.Color(), dustCol = new THREE.Color();
  const t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), t3 = new THREE.Vector3();
  const shift = new THREE.Vector3(), elAcc = new THREE.Vector3(), lampAcc = new THREE.Vector3(), lampDir = new THREE.Vector3();
  const pstate = { deployed: false, throttle: 0, ignited: false, flameout: false, temp: 0, gimbal: undefined, control: undefined, steer: undefined, spin: undefined, compress: undefined, light: undefined };
  let clock = 0, lastDt = 1 / 60, sunElevNow = 1, canopyZoom = null;
  const hv = new THREE.Vector3(), hOut = { spacing: Infinity, level: -1 };

  function shadowFlags(root, cast, receive) { root.traverse(o => { if (o.isMesh && !o.isSprite && o.material && !o.material.transparent) { o.castShadow = cast; o.receiveShadow = receive; } }); }
  /** Radius of the solid ground along a body-fixed direction (terrain when the worlds module models it). */
  function surfaceRadius(body, dirFixed) {
    if (typeof body.terrainHeight === 'function') { try { const h = body.terrainHeight(dirFixed); if (Number.isFinite(h)) return body.radius + Math.max(h, body.ocean ? 0 : -1e9); } catch { /* fall through */ } }
    return body.radius;
  }
  anchor.groundAt = posRel => { const b = anchor.body; if (typeof b.terrainHeight !== 'function') return anchor.ground; b.inertialToSurfaceDir(v6.copy(posRel).normalize(), anchor.ut, v6); return surfaceRadius(b, v6); };

  function applySettings() {
    const s = settings();
    const name = softGL && !s.gfxForce ? (post ? 'soft' : 'low') : QUALITY[s.gfxQuality] && s.gfxQuality !== 'soft' ? s.gfxQuality : 'high';
    quality = QUALITY[name];
    if (name !== qualityName) {
      const before = QUALITY[qualityName];
      qualityName = name;
      if (before && before.mesh !== quality.mesh && typeof views !== 'undefined') for (const view of views.values()) view.dirty = true;
    }
    // the governor never runs on a software rasteriser (its reduced mode is fixed) or when the player turned it off
    gov.enabled = !softGL && s.gfxAuto !== false;
    const gs = gov.state;
    // On a retina display every CSS pixel already has four device pixels: 2 samples each there look like 4 at 1x,
    // for half the multisample memory (a 3456 x 2234 half-float target is 250 MB at 4 samples).
    const dense = app.renderer && app.renderer.getPixelRatio() * gs.scale >= 1.5;
    if (post) post.setSamples(gs.msaa ? (dense ? Math.min(2, quality.samples) : quality.samples) : 0);
    const shadowSize = Math.round(quality.shadow * gs.shadow);
    const shadows = shadowSize > 0 && s.gfxShadows !== false;
    if (sunNear.castShadow !== shadows) sunNear.castShadow = shadows;
    if (shadows && sunNear.shadow.mapSize.x !== shadowSize) { sunNear.shadow.mapSize.set(shadowSize, shadowSize); if (sunNear.shadow.map) { sunNear.shadow.map.dispose(); sunNear.shadow.map = null; } }
    // [realism pass] vegetation detail follows the setting, the quality level and the governor (js/render/basegfx.js)
    if (base && typeof base.setVegetation === 'function') base.setVegetation(s.gfxVegetation, name, gs.detail);
    if (post) { post.params.bloom = quality.noBloom || !gs.bloom ? 0 : Number.isFinite(s.gfxBloom) ? s.gfxBloom : 0.7; post.params.lens = quality.noBloom || s.gfxLens === false ? 0 : 1; }
  }
  applySettings();

  // ------------------------------------------------------------------ vessel views
  function makeView(v) {
    const group = new THREE.Group(); group.name = 'vessel_' + v.id;
    near.add(group);
    return { vessel: v, group, parts: new Map(), stamp: -1, builds: 0, dirty: false, ext: 2 };
  }
  function freeEntry(e) {
    if (e.plumes) for (const pl of e.plumes) { pl.object.removeFromParent(); try { pl.dispose(); } catch { /* shared */ } }
    e.mesh.removeFromParent();
    disposePartMesh(e.mesh);
  }
  function freeView(view) {
    for (const e of view.parts.values()) freeEntry(e);
    view.parts.clear();
    view.group.removeFromParent();
  }
  const _tq = new THREE.Quaternion(), Z_AXIS_T = new THREE.Vector3(0, 0, 1), X_AXIS_T = new THREE.Vector3(1, 0, 0);
  /** Orientation of a part in the craft frame: yaw(rot), then upside down when `flip` is set. */
  function orient(e) {
    const p = e.part;
    // wheels always stand upright under the craft (axle along X, rolling along +Y, tyre toward −Z) whatever
    // radial angle they were attached at: that is where the core's contact point is (see ARCHITECTURE, wheels)
    e.mesh.quaternion.setFromAxisAngle(Y_AXIS, p.def.wheel ? Math.PI / 2 : (p.rot || 0));
    if (!p.def.wheel) {   // same order as craft.js partQuat: Ry(rot) · Rx(flip) · Rz(pitch) · Rx(roll)
      if (p.flip) e.mesh.quaternion.multiply(FLIP_X);
      if (p.pitch) e.mesh.quaternion.multiply(_tq.setFromAxisAngle(Z_AXIS_T, p.pitch));
      if (p.roll) e.mesh.quaternion.multiply(_tq.setFromAxisAngle(X_AXIS_T, p.roll));
    }
    e.rot = p.rot || 0; e.flip = !!p.flip; e.tilt = (p.pitch || 0) + 7 * (p.roll || 0);
  }
  function syncParts(view, fresh = false) {
    const v = view.vessel;
    if (fresh) { for (const e of view.parts.values()) freeEntry(e); view.parts.clear(); }
    // drop meshes of parts that are gone, add meshes for new ones
    for (const [id, e] of view.parts) if (v.parts.get(id) !== e.part) { freeEntry(e); view.parts.delete(id); }
    for (const p of v.parts.values()) {
      if (view.parts.has(p.id)) continue;
      // debris is drawn with the cheapest meshes (one flat material per rigid piece)
      const mesh = buildPartMesh(p.def, { quality: v.type === 'debris' ? 'low' : (quality.mesh || 'high') });
      if (p.truss && PM.setPartInterstages) PM.setPartInterstages(mesh, p.truss);   // the lattice ring it carries up to the engine above
      shadowFlags(mesh, true, true);
      const e = { part: p, mesh, plume: null, plumes: null, rE: 0, canopyQ: null, rot: 0, flip: false, smoke: 0, ground: 0, rcs: 0, spin: 0, comp: 0, gx: 0, gz: 0 };
      if (p.def.engine) {
        // one plume per bell; they ride on the gimballed bell group when the mesh has one
        const exits = nozzleExits ? nozzleExits(p.def) : [null];
        const gim = mesh.userData.refs && mesh.userData.refs.gimbal && mesh.userData.refs.gimbal.parent === mesh ? mesh.userData.refs.gimbal : null;
        e.plumes = exits.map(ex => { const pl = createPlume(p.def, exits.length > 1 ? ex : null); if (gim) { pl.object.position.sub(gim.position); gim.add(pl.object); } else mesh.add(pl.object); return pl; });
        e.plume = e.plumes[0];
        e.rE = PM.nozzleExitRadius ? PM.nozzleExitRadius(p.def) : e.plume.info.radius;
      }
      setPartState(mesh, { deployed: p.deployed, throttle: 0, ignited: p.ignited, flameout: p.flameout, temp: p.temp, light: p.def.light ? (p.deployed ? 1 : 0) : undefined, instant: true });
      view.group.add(mesh);
      view.parts.set(p.id, e);
    }
    // docking re-expresses parts in a new craft frame (and undocking may turn the frame over): refresh them all
    for (const e of view.parts.values()) orient(e);
    view.stamp = v.structureStamp;
    view.dirty = false;
    view.kind = v.type;
    view.builds++;
  }

  const rnd = () => Math.random() - 0.5;
  /** A random unit-ish vector perpendicular to `n` (into v5). */
  function radial(n) { v5.set(rnd(), rnd(), rnd()); v5.addScaledVector(n, -v5.dot(n)); if (v5.lengthSq() < 1e-6) v5.set(n.y, n.z, n.x).addScaledVector(n, -(n.y * n.x + n.z * n.y + n.x * n.z)); return v5.normalize(); }

  function updateView(view, dt, simDt, isActive, world) {
    const v = view.vessel, body = v.body;
    if (view.dirty || (view.kind !== v.type && (view.kind === 'debris' || v.type === 'debris'))) syncParts(view, true);
    else if (view.stamp !== v.structureStamp || view.parts.size !== v.parts.size) syncParts(view);
    else for (const [id, e] of view.parts) { if (v.parts.get(id) !== e.part) { syncParts(view); break; } }
    view.group.quaternion.copy(v.q);
    const com = v.com;
    const alt = v.pos.length() - body.radius;
    const pAtm = body.pressureAtm(alt), rho = body.density(alt);
    const loaded = !v.onRails;
    const speed = v.surfaceVel ? v.surfaceVel.length() : 0;
    const up = v3.copy(v.pos).normalize();                      // world vertical at this vessel (kept in v3 for the loop)
    // direction the air streams past the vessel, in vessel-local axes
    q1.copy(v.q).invert();
    if (speed > 1.5) v1.copy(v.surfaceVel).multiplyScalar(-1 / speed).applyQuaternion(q1);
    else v1.copy(v.pos).normalize().applyQuaternion(q1);
    const upL = v6.copy(up).applyQuaternion(q1);                // vertical in craft axes
    // how far the ground is below the centre of mass
    let ext = 0;
    for (const e of view.parts.values()) { const p = e.part, d = p.def; const below = -((p.pos.x - com.x) * upL.x + (p.pos.y - com.y) * upL.y + (p.pos.z - com.z) * upL.z) + Math.abs(upL.y) * (d.h || 1) * 0.5 + Math.sqrt(Math.max(0, 1 - upL.y * upL.y)) * (d.r || d.rw || 0.5); if (below > ext) ext = below; }
    view.ext = ext;
    const groundDist = Math.max(0, v.radarAlt || 0) + ext;
    const near1 = view.dist < 6000 && simDt > 0;
    const pq = quality.particles;
    let lightK = 0;
    view.canopyOpen = 0;
    const act = v.actuation, live = loaded && v.controllable !== false && v.type !== 'eva';
    const rolling = !!v.grounded && !v.landed;
    let lampN = 0; lampAcc.set(0, 0, 0); lampDir.set(0, 0, 0);
    for (const e of view.parts.values()) {
      const p = e.part, def = p.def, mesh = e.mesh;
      if (def.wheel) {
        // tyre bottom (suspension unloaded) at the core's contact point: (pos.x, pos.y, pos.z − ext)
        const wz = Number.isFinite(p._wz) ? p._wz : p.pos.z - (def.rw || 0) / 2;
        mesh.position.set(p.pos.x - com.x, p.pos.y - com.y, wz + (def.rw || 0) / 2 - com.z);
      } else mesh.position.set(p.pos.x - com.x, p.pos.y - com.y, p.pos.z - com.z);
      if (e.rot !== (p.rot || 0) || e.flip !== !!p.flip || e.tilt !== (p.pitch || 0) + 7 * (p.roll || 0)) orient(e);
      const level = loaded && p.ignited && !p.flameout ? (Number.isFinite(p.level) ? p.level : 0) : 0;
      const st = pstate;
      st.deployed = p.deployed; st.throttle = level; st.ignited = p.ignited && level > 0; st.flameout = p.flameout; st.temp = p.temp;
      st.gimbal = st.control = st.steer = st.spin = st.compress = st.light = undefined;
      if (def.engine && def.engine.gimbal > 0 && act) {
        // the bell swings so the exhaust pushes the tail the way the torque command asks (pitch, roll, −yaw)
        const g = def.engine.gimbal * Math.PI / 180 * (live && level > 0.01 ? 1 : 0) * (p.pos.y < com.y ? 1 : -1);
        const dx = -act.z * g, dz = act.x * g, c = Math.cos(p.rot || 0), sn = Math.sin(p.rot || 0);
        const lx = dx * c - dz * sn, lz = (dx * sn + dz * c) * (p.flip ? -1 : 1), k = Math.min(1, dt * 10);
        e.gz += (lx - e.gz) * k; e.gx += (-lz - e.gx) * k;
        if (Math.abs(e.gx) + Math.abs(e.gz) > 1e-5 || e.gim) { e.gim = e.gim || { x: 0, z: 0 }; e.gim.x = e.gx; e.gim.z = e.gz; st.gimbal = e.gim; }
      }
      if ((def.wing || def.fin) && p._defl !== undefined) st.control = live ? p._defl || 0 : 0;
      if (def.wheel) {
        const R = def.wheel.radius || 0.3;
        if (rolling && simDt > 0 && Number.isFinite(p._spin)) e.spin = (e.spin + p._spin * simDt) % TAU;
        // how far the core's spring is closed. A vessel pinned at rest ('landed') is no longer `grounded`, but it still
        // sits low on its springs (round 3: its wheels were then drawn at full stretch, 8 cm inside the ground). One
        // placed on a launch site has not settled at all (no contact yet: _hp undefined); one restored from a save has.
        const comp = (v.grounded || v.landed) && p.deployed ? (Number.isFinite(p._hp) ? Math.max(0, -p._hp) : v.landed && v.situation !== 'prelaunch' ? (body.surfaceG || 1) / 121 : 0) : 0;
        // the drawn strut closes by what the core's spring has closed (round 3: it stopped at 0.3 R, and a small
        // wheel under load, the nose gear's, stood up to 7 cm inside the runway), up to the core's own travel
        e.comp += (clamp(comp / (R * 0.3), 0, Math.min(3, 1.2 * (p._travel || R * 0.3) / (R * 0.3))) - e.comp) * Math.min(1, dt * 12);
        st.steer = live && v.grounded ? p._steer || 0 : 0; st.spin = e.spin; st.compress = e.comp;
      }
      if (def.light) {
        st.light = p.deployed ? 1 : 0;
        if (p.deployed && isActive) { lampN++; lampAcc.x += p.pos.x - com.x; lampAcc.y += p.pos.y - com.y; lampAcc.z += p.pos.z - com.z; lampDir.x += Math.cos(p.rot || 0); lampDir.z -= Math.sin(p.rot || 0); }
      }
      setPartState(mesh, st);
      const canopy = mesh.userData.canopy;
      if (canopy && (p.deployed === 'semi' || p.deployed === 'full')) {
        { const cd = mesh.userData.chuteDim; view.canopyOpen = Math.max(view.canopyOpen || 0, cd ? cd.hgt + cd.dome * 0.8 : 12); }
        // the canopy trails downstream: align its +Y with the airflow, in the part's own frame (with a slow sway)
        v2.copy(v1).applyQuaternion(q2.copy(mesh.quaternion).invert());
        v2.x += Math.sin(clock * 1.3 + p.id) * 0.05; v2.z += Math.cos(clock * 1.1 + p.id * 2) * 0.05;
        q2.setFromUnitVectors(Y_AXIS, v2.normalize());
        if (!e.canopyQ) { e.canopyQ = true; canopy.quaternion.copy(q2); } else canopy.quaternion.slerp(q2, Math.min(1, dt * 3));
      } else if (canopy && e.canopyQ) { e.canopyQ = null; canopy.quaternion.identity(); }

      // ---- engines: plume, smoke, ground wash, light
      if (e.plume) {
        for (const pl of e.plumes) pl.update(level, pAtm, dt);
        const kind = e.plume.info.kind, rE = e.rE || e.plume.info.radius;
        if (level > 0.03) {
          const sgn = p.flip ? -1 : 1;
          // nozzle exit and exhaust direction in scene space
          v2.set(p.pos.x - com.x, p.pos.y - com.y - sgn * (def.h / 2), p.pos.z - com.z).applyQuaternion(v.q).add(view.group.position);
          v4.set(0, -sgn, 0).applyQuaternion(v.q);
          if (isActive) { const w = level * rE * rE; elAcc.addScaledVector(v2, w).addScaledVector(v4, w * rE * 5); lightK += w; view.lightCol = e.plume.info.light; }
          if (near1 && (kind === 'solid' || kind === 'liquid' || kind === 'jet')) {
            const solid = kind === 'solid', jet = kind === 'jet';
            // exhaust trail in air: thick and long-lived for solids, thin for liquid engines, a dark wisp for jets
            // (close to the ground the jet splashes into the ground wash below instead of trailing)
            const hNoz = groundDist + t3.copy(v2).sub(view.group.position).dot(up);
            if (rho > 0.008 && (hNoz > 30 || v4.dot(up) > -0.25)) {
              const dens = Math.min(1, rho * 1.5 + 0.2);
              // enough puffs to keep the trail unbroken at speed (one every few metres of path), laid along the path
              // flown this frame rather than all at the nozzle: at a low frame rate the trail would come out as dots
              const sv = v.surfaceVel || null, spd = sv ? sv.length() : 0;
              const rate = Math.min(170, Math.max(solid ? 34 : jet ? 8 : 22, spd / (solid ? 3.5 : jet ? 16 : 4.5)));
              e.smoke += rate * simDt * dens * (0.4 + 0.6 * level) * pq;
              const cnt = Math.min(30, Math.floor(e.smoke));
              if (e.smoke > 60) e.smoke = 0;                 // a long hitch: drop the backlog
              for (let k = 0; k < cnt; k++) {
                e.smoke -= 1;
                const back = rE * (solid ? 9 : 6) * (0.5 + level) * (0.7 + Math.random() * 0.6);
                t3.copy(v2).addScaledVector(v4, back);
                if (sv) t3.addScaledVector(sv, -simDt * (k + Math.random()) / cnt);
                const jetV = (solid ? 30 : 24) * (0.5 + 0.5 * level);
                t2.copy(v4).multiplyScalar(jetV).add(v5.set(rnd(), rnd(), rnd()).multiplyScalar(6));
                const tone = solid ? 0.9 + Math.random() * 0.1 : jet ? 0.2 + Math.random() * 0.1 : 0.86 + Math.random() * 0.14;      // sunlit vapour is white: grey smoke vanishes against a hazy sky
                smoke.emit(t3, {
                  size: rE * (solid ? 6 : jet ? 3.4 : 6.5) * (0.8 + Math.random() * 0.5), growth: solid ? 4.8 : 4.6, life: (solid ? 16 : jet ? 3 : 9) * (0.7 + Math.random() * 0.6),
                  alpha: (solid ? 0.74 : jet ? 0.2 : 0.6) * dens, vel: t2, drag: 1.7, rise: solid ? 0.5 : 0.25,
                  color: col2.setRGB(tone, tone * 0.985, tone * 0.96), fadeIn: 0.12,
                });
              }
            }
            // exhaust hitting the ground: billowing smoke / steam in air, a flat spray of dust in vacuum
            t3.copy(v2).sub(view.group.position);                               // nozzle relative to the CoM
            const hGround = groundDist + t3.dot(up);                             // nozzle height above the ground
            const reach = rE * (solid ? 46 : 38) * (0.4 + 0.6 * level) * (pAtm > 0.02 ? 1 : 1.6);
            const down = -v4.dot(up);
            if (hGround < reach && hGround > -2 && down > 0.25 && !jet) {
              const k = (1 - hGround / reach) * level * down;
              e.ground += (rho > 0.008 ? 80 : 60) * dt * k * pq;
              let guard = 0;
              // where the jet meets the ground
              t2.copy(v2).addScaledVector(v4, hGround / Math.max(down, 0.2));
              const padHere = body === SYSTEM.home && view.padDist < 60;
              while (e.ground >= 1 && guard++ < 10) {
                e.ground -= 1;
                radial(up);
                const out = (rho > 0.008 ? 14 + Math.random() * 26 : 30 + Math.random() * 60) * (0.5 + 0.5 * k);
                t3.copy(t2).addScaledVector(v5, rE * 2 + Math.random() * 2).addScaledVector(up, 0.3 + Math.random() * 0.6);
                t1.copy(v5).multiplyScalar(out).addScaledVector(up, rho > 0.008 ? 1 + Math.random() * 4 : 3 + Math.random() * 12);
                if (rho > 0.008) {
                  const tone = padHere ? 0.86 + Math.random() * 0.12 : 0.6 + Math.random() * 0.22;
                  if (padHere) col2.setRGB(tone, tone, tone); else col2.copy(dustCol).lerp(col3.setRGB(tone, tone, tone), 0.55);
                  smoke.emit(t3, { size: 1.6 + Math.random() * 2.2, growth: 2.4 + Math.random() * 2.2, life: 9 + Math.random() * 9, alpha: 0.46 * Math.min(1, rho * 1.4 + 0.25), vel: t1, drag: 0.8, rise: 0.5 + Math.random() * 0.9, color: col2, fadeIn: 0.2 });
                } else {
                  smoke.emit(t3, { size: 0.8 + Math.random() * 1.2, growth: 2.2, life: 1.2 + Math.random() * 1.6, alpha: 0.34, vel: t1, drag: 0.05, gravity: body.surfaceG || 1.6, color: dustCol, fadeIn: 0.05 });
                }
              }
            }
          }
        }
      }
      // ---- RCS puffs
      if (def.rcs !== undefined && near1 && v.ctrl && v.ctrl.rcs && (v.resources.mono ? v.resources.mono.amount > 0 : true)) {
        const c = v.ctrl, act = Math.min(1, Math.abs(c.tx || 0) + Math.abs(c.ty || 0) + Math.abs(c.tz || 0) + 0.5 * (Math.abs(c.pitch || 0) + Math.abs(c.yaw || 0) + Math.abs(c.roll || 0)));
        if (act > 0.08) {
          e.rcs += 26 * dt * act * pq;
          let guard = 0;
          while (e.rcs >= 1 && guard++ < 3) {
            e.rcs -= 1;
            // puff away from the direction of push (translation), else outward from the hull
            v2.set(-(c.tx || 0), -(c.ty || 0), -(c.tz || 0));
            if (v2.lengthSq() < 0.02) v2.set(Math.cos(p.rot || 0), rnd() * 1.5, -Math.sin(p.rot || 0));
            v2.normalize().applyQuaternion(v.q);
            t3.set(p.pos.x - com.x, p.pos.y - com.y, p.pos.z - com.z).applyQuaternion(v.q).add(view.group.position).addScaledVector(v2, 0.25);
            t1.copy(v2).multiplyScalar(7 + Math.random() * 4).add(v5.set(rnd(), rnd(), rnd()).multiplyScalar(1.5));
            smoke.emit(t3, { size: 0.16, growth: 2.4, life: 0.28 + Math.random() * 0.2, alpha: 0.55, vel: t1, drag: 3.5, color: col2.setRGB(1.6, 1.65, 1.75), fadeIn: 0.02, add: 0.55 });
          }
        }
      }
    }
    if (v.type === 'eva') {
      const e = view.parts.values().next().value;
      if (e) {
        const moving = v.landed ? Math.min(1, Math.hypot(v.ctrl.tx || 0, v.ctrl.tz || 0)) : 0;
        view.walk = (view.walk || 0) + (moving - (view.walk || 0)) * Math.min(1, dt * 8);
        animatePip(e.mesh, { walk: view.walk, t: clock });
        // jetpack puffs
        if (!v.landed && near1) {
          const c = v.ctrl, act = Math.min(1, Math.abs(c.tx || 0) + Math.abs(c.ty || 0) + Math.abs(c.tz || 0));
          if (act > 0.1 && Math.random() < dt * 30) {
            v2.set(-(c.tx || 0), -(c.ty || 0), -(c.tz || 0)).normalize().applyQuaternion(v.q);
            t3.copy(view.group.position).addScaledVector(v2, 0.3);
            smoke.emit(t3, { size: 0.1, growth: 1.4, life: 0.3, alpha: 0.5, vel: t1.copy(v2).multiplyScalar(4), drag: 3, color: col2.setRGB(1.5, 1.55, 1.65), fadeIn: 0.02, add: 0.5 });
          }
        }
      }
    }
    // ---- dust from wheels / skidding along the ground
    if (near1 && v.landed && speed > 2.5 && !v.splashed && v.type !== 'eva') {
      view.roll = (view.roll || 0) + Math.min(30, speed * 1.2) * dt * pq;
      while (view.roll >= 1) {
        view.roll -= 1;
        radial(up);
        t3.copy(view.group.position).addScaledVector(up, -ext + 0.2).addScaledVector(v5, 1 + Math.random() * 1.5);
        t1.copy(v5).multiplyScalar(1.5).addScaledVector(up, 0.8 + Math.random());
        smoke.emit(t3, { size: 0.9, growth: 2.6, life: 1.6 + Math.random() * 1.4, alpha: rho > 0.008 ? 0.3 : 0.22, vel: t1, drag: rho > 0.008 ? 1.2 : 0.1, gravity: rho > 0.008 ? 0 : body.surfaceG || 1.6, color: dustCol, fadeIn: 0.1 });
      }
    }
    if (isActive) {
      info.groundDist = groundDist;
      // ---- headlamps
      if (lampN > 0 && loaded) {
        const vehicle = (v.wheelParts || []).length >= 2;
        lampAcc.multiplyScalar(1 / lampN);
        if (vehicle) lampDir.set(0, 1, -0.16); else if (lampDir.lengthSq() < 0.01) lampDir.set(0, 1, 0);
        lampDir.normalize();
        v2.copy(lampAcc).applyQuaternion(v.q).add(view.group.position);
        v4.copy(lampDir).applyQuaternion(v.q);
        lamp.position.copy(v2); lamp.target.position.copy(v2).addScaledVector(v4, 20);
        const dark = 1 - 0.8 * clamp(info.daylight * (sunElevNow > 0 ? Math.min(1, sunElevNow * 4) : 0), 0, 1);
        lamp.intensity = 900 * Math.min(2, lampN) * dark;
        // where the beam meets the ground
        const hLamp = groundDist + t1.copy(v2).sub(view.group.position).dot(up), down = -v4.dot(up);
        const reach = down > 0.04 ? Math.min(28, hLamp / down) : 28;
        if (hLamp < 12 && hLamp > -1 && v4.dot(up) < 0.5) {
          t2.copy(v4).addScaledVector(up, -v4.dot(up)); if (t2.lengthSq() > 1e-6) t2.normalize();
          lampPool.object.position.copy(v2).addScaledVector(up, -hLamp + 0.07 + (view.deck || 0) - (view.lift || 0)).addScaledVector(t2, Math.max(2, reach * 0.8));
          lampPool.object.quaternion.setFromUnitVectors(Y_AXIS, up);
          lampPool.set(LAMP_COL, 0.55 * Math.min(2, lampN) * dark * dark, 5 + reach * 0.35);
        } else lampPool.set(null, 0, 1);
      } else { lamp.intensity = 0; lampPool.set(null, 0, 1); }
      // ---- engine light on the craft, the pad and the ground
      const s = settings();
      if (lightK > 1e-4) {
        elAcc.multiplyScalar(1 / lightK);
        engineLight.position.copy(elAcc);
        const lc = view.lightCol || [1, 0.72, 0.45];
        engineLight.color.setRGB(lc[0], lc[1], lc[2]);
        const flick = 0.9 + 0.1 * Math.sin(clock * 47) + 0.05 * Math.sin(clock * 31.7);
        engineLight.intensity = Math.min(9000, 1600 * lightK) * flick;
        const hLight = groundDist + t1.copy(elAcc).sub(view.group.position).dot(up);
        const reach = 30 + 60 * Math.sqrt(lightK);
        if (hLight < reach && hLight > -3) {
          const k = (1 - Math.max(0, hLight) / reach);
          pool.object.position.copy(view.group.position).addScaledVector(up, -groundDist + 0.06 + (view.deck || 0) - (view.lift || 0));
          pool.object.quaternion.setFromUnitVectors(Y_AXIS, up);
          pool.set(lc, Math.min(2.2, 0.9 * Math.sqrt(lightK) * k * k * flick) * (1.15 - 0.75 * info.daylight * (body.atmo ? 1 : 0.6)), 14 + reach * 0.5 + hLight * 0.8);
        } else pool.set(null, 0, 1);
      } else { engineLight.intensity = 0; pool.set(null, 0, 1); }
      // ---- re-entry sheath
      if (!glow) glow = createReentryGlow({ radius: 2, tail: 9 });
      if (glow.object.parent !== view.group) view.group.add(glow.object);
      const r = Math.max(1.2, (v.baseRadius || 1) * 1.5 + 0.4);
      glow.setSize(r, Math.max(8, (v.boundRadius || 3) * 2.6));
      const flux = loaded ? (v.heatFlux || 0) : 0;
      const I = clamp((flux - 28000) / 150000, 0, 1.7);
      view.glowI = (view.glowI || 0) + (I - (view.glowI || 0)) * Math.min(1, dt * 4);
      glow.update(view.glowI, v1, dt);
      info.heatGlow = view.glowI;
      // sparks torn off into the wake
      if (view.glowI > 0.25 && near1) {
        view.spark = (view.spark || 0) + 40 * view.glowI * dt * pq;
        v2.copy(v1).applyQuaternion(v.q);                                   // downstream, scene axes
        while (view.spark >= 1) {
          view.spark -= 1;
          radial(v2);
          t3.copy(view.group.position).addScaledVector(v5, r * (0.5 + Math.random() * 0.6)).addScaledVector(v2, r * Math.random());
          t1.copy(v2).multiplyScalar(-speed * 0.02).add(v4.set(rnd(), rnd(), rnd()).multiplyScalar(6));
          smoke.emit(t3, { size: 0.25 + Math.random() * 0.3, growth: 0, life: 0.5 + Math.random() * 0.7, alpha: 1, vel: t1, drag: 0.4, color: col2.setRGB(5, 2.0 + Math.random() * 1.5, 0.5), fadeIn: 0.01, add: 1, shrink: true });
        }
      }
      // ---- transonic vapour
      if (!vapor) vapor = createVaporCone();
      if (vapor.object.parent !== view.group) view.group.add(vapor.object);
      const mach = v.mach || 0;
      const vi = loaded && speed > 50 ? Math.exp(-Math.pow((mach - 1.02) / 0.09, 2)) * clamp(rho / 0.5, 0, 1) * clamp((v.dynamicPressure || 0) / 14000, 0, 1) : 0;
      view.vaporI = (view.vaporI || 0) + (vi - (view.vaporI || 0)) * Math.min(1, dt * 3);
      vapor.setSize(Math.max(1, (v.baseRadius || 1) * 1.25));
      vapor.update(view.vaporI * 0.75, v1, dt);
      vapor.object.position.set(0, 0, 0).addScaledVector(v1, -(v.boundRadius || 3) * 0.25);
      info.mach = mach;
      // ---- what the camera and the sound should feel
      const accel = v.mass > 0 ? (v.thrust || 0) / v.mass : 0;
      const groundBoost = groundDist < 60 && rho > 0.01 ? 1.6 : 1;
      info.rumble = loaded ? clamp(accel / 45, 0, 1) * (0.35 + 0.65 * Math.min(1, pAtm + 0.3)) * groundBoost * (v.thrust > 0 ? 1 : 0) : 0;
      info.buffet = loaded ? clamp((v.dynamicPressure || 0) / 38000, 0, 1) + view.glowI * 0.5 : 0;
    }
    void world;
  }

  // ------------------------------------------------------------------ main update
  function update(world, dt, simDt, cam) {
    clock += dt; lastDt = dt;
    // (real time between drawn frames, not the game's dt: that is clamped, and fixed while a tour is being filmed)
    if (gov.enabled) { const nowMs = performance.now(), real = nowMs - govLast; govLast = nowMs; if (gov.tick(real, { cpuMs: app.frameCpuMs || 0, busy: !!(worldsR && worldsR.info.busy), hidden: typeof document !== 'undefined' && document.hidden })) applySettings(); }
    const ut = world.ut;
    anchor.ut = ut;
    const a = world.active && !world.active.dead ? world.active : null;
    // ---- anchor: the point the scene is centred on
    const prevBody = anchor.body;
    if (a) {
      anchor.body = a.body; anchor.pos.copy(a.pos); anchor.vel.copy(a.vel); anchor.q.copy(a.q); anchor.valid = true; anchor.vessel = a;
      anchor.surfaceVel = a.surfaceVel;
    } else if (anchor.valid && simDt > 0) {
      // nothing to follow (vessel destroyed): stay with the wreck site / keep coasting
      anchor.vessel = null;
      const body = anchor.body, alt = anchor.pos.length() - body.radius;
      if (alt < 3000) {
        const ang = TAU / body.rotPeriod * simDt;
        anchor.pos.applyAxisAngle(Y_AXIS, ang);
        anchor.vel.set(TAU / body.rotPeriod * anchor.pos.z, 0, -TAU / body.rotPeriod * anchor.pos.x);
      } else anchor.pos.addScaledVector(anchor.vel, simDt);
    }
    const body = anchor.body;
    const R = anchor.pos.length(), alt = R - body.radius;
    const up = info.up.copy(anchor.pos).multiplyScalar(1 / (R || 1));
    // ground radius under the anchor (for the camera floor and the shadow catcher)
    if (a) { const view = views.get(a); anchor.ground = R - Math.max(0, a.radarAlt || 0) - (view ? view.ext : (a.baseHeight || 2)); }
    else anchor.ground = Math.min(anchor.ground, R - 1.5);
    body.inertialToSurfaceDir(up, ut, v1);
    try { const c = body.surfaceColorAt(v1); dustCol.setRGB(c[0], c[1], c[2]).convertSRGBToLinear().lerp(col2.setRGB(0.6, 0.57, 0.52), 0.35); } catch { dustCol.setRGB(0.5, 0.47, 0.42); }

    // ---- sun
    body.globalPosAt(ut, g1);                         // SOI body relative to the star
    g2.copy(g1).add(anchor.pos);                      // anchor relative to the star
    const sunDir = info.sunDir.copy(g2).multiplyScalar(-1 / (g2.length() || 1));
    const sinElev = clamp(sunDir.dot(up), -1, 1);
    info.sunElevation = Math.asin(sinElev); sunElevNow = info.sunElevation;
    // eclipse: is the anchor in the body's shadow?
    let lit = 1;
    if (body.parent) {
      const along = -anchor.pos.dot(sunDir);          // distance behind the terminator plane
      if (along > 0) {
        const perp = Math.sqrt(Math.max(0, R * R - along * along));
        lit = sstep(body.radius * 0.985, body.radius * 1.02 + (body.atmo ? body.atmo.height * 0.5 : 0), perp);
      }
    }
    info.daylight = lit;
    // low sun through air turns warm
    const airK = body.atmo ? clamp(1 - alt / (body.atmo.height * 0.6), 0, 1) : 0;
    const lowSun = airK * (1 - sstep(0.0, 0.42, sinElev));
    sunTint.setRGB(1, 0.955 - 0.42 * lowSun, 0.885 - 0.66 * lowSun);
    const sunPow = lit * (1 - 0.55 * lowSun * airK);
    sunFar.position.copy(sunDir).multiplyScalar(1000); sunFar.target.position.set(0, 0, 0);
    sunFar.color.copy(sunTint);
    sunNear.color.copy(sunTint);
    sunNear.intensity = 3.1 * sunPow;
    hemi.position.copy(up);

    // ---- vessels first (the camera, the shadow box and the lights need this frame's positions)
    if (simDt > 0) {
      // Smoke stays with the air and the ground, not with the ship: follow a ground-fixed point exactly (the
      // integrator's own velocity × dt drifts by metres over a launch). High in vacuum, puffs coast with the ship.
      shift.set(0, 0, 0);
      const groundFixed = body.type !== 'star' && (body.density(Math.max(0, alt)) > 1e-5 || (a ? (a.radarAlt || alt) : alt) < 4000);
      if (groundFixed) {
        if (gRef.body !== body || !gRef.ok || gRef.prev.lengthSq() > 2.5e9) { body.inertialToSurfaceDir(up, ut, gRef.dir); gRef.body = body; gRef.ok = false; }
        body.surfaceDirToInertial(gRef.dir, ut, v2).multiplyScalar(body.radius).sub(anchor.pos);
        if (gRef.ok) shift.copy(v2).sub(gRef.prev);
        else if (anchor.vessel && anchor.vessel.surfaceVel && !anchor.vessel.landed) shift.copy(anchor.vessel.surfaceVel).multiplyScalar(-simDt);
        if (shift.lengthSq() > 4e8) shift.set(0, 0, 0);                    // a teleport or a vessel switch, not motion
        gRef.prev.copy(v2); gRef.ok = true;
      } else gRef.ok = false;
      smoke.update(simDt, shift, up);
    }
    let padDistNow = Infinity;
    if (body === SYSTEM.home) { body.surfaceDirToInertial(SYSTEM.launchSite.dir, ut, v2).multiplyScalar(surfaceRadius(body, SYSTEM.launchSite.dir)).sub(anchor.pos); padDistNow = v2.length(); }
    // ---- launch site (placed before the vessels: what stands on its slabs is put on them as drawn this frame)
    const site = base ? base.group : pad;
    if (site) {
      if (body === SYSTEM.home) {
        body.surfaceDirToInertial(SYSTEM.launchSite.dir, ut, v2).multiplyScalar(surfaceRadius(body, SYSTEM.launchSite.dir)).sub(anchor.pos);
        site.visible = v2.lengthSq() < (base ? 6.4e9 : 9e10);
        if (site.visible) {
          site.quaternion.setFromAxisAngle(Y_AXIS, body.rotationAngle(ut)).multiply(base ? padQ : padQLegacy);
          site.position.copy(v2);
          if (base) {
            site.position.sub(v4.copy(padOffset).applyQuaternion(site.quaternion));
            // sun direction in the centre's own frame (+X east, +Y up, +Z south), local solar time 0..1 (0.5 = noon)
            v4.copy(sunDir).applyQuaternion(q1.copy(site.quaternion).invert());
            const tod = (Math.atan2(v4.x, v4.y) / TAU + 0.5 + 1) % 1;
            try { base.update(dt, { sunDir: v4, timeOfDay: 1 - tod }); } catch (err) { if (!base._warned) { base._warned = true; console.warn('[flight] space centre update failed:', err && err.message); } }
          }
        }
      } else site.visible = false;
    }

    elAcc.set(0, 0, 0);
    for (const v of world.vessels) {
      if (v.dead || v.body !== body) { const old = views.get(v); if (old) { freeView(old); views.delete(v); } continue; }
      rel.copy(v.pos).sub(anchor.pos);
      const d = rel.length();
      let view = views.get(v);
      if (d > VESSEL_RANGE) { if (view) { freeView(view); views.delete(v); } continue; }
      if (!view) { view = makeView(v); views.set(v, view); }
      view.dist = d; view.padDist = padDistNow;
      view.group.position.copy(rel);
      // feet on the ground as drawn: close to the surface, move the vessel by the gap between what is on screen under
      // it and the physics ground. Away from the space centre that is the terrain triangles (centimetres once the fine
      // chunks are in); on the space centre it is the paving (slabs, pad deck and runway lie 3 to 9 cm above the ground)
      view.deck = 0; view.lift = 0;
      if (v.radarAlt < 25 && !v.splashed) {
        let off = 0;
        if (base && base.group.visible && body === SYSTEM.home && padDistNow <= 3000) off = deckUnder(view, rel, hv.copy(v.pos).normalize(), v.pos.length() - body.radius);   // the space centre's ground is the datum (terrain exactly 0 within 3 km), so this is the height of the vessel's origin above it whichever way the vessel lies (round 3: `radarAlt + view.ext` put the ray under the runway for an aeroplane, which lies flat, and it was never lifted onto the asphalt)
        else if (worldsR && typeof worldsR.heightAt === 'function' && padDistNow > 3000) {
          try {
            body.inertialToSurfaceDir(hv.copy(v.pos), ut, hv);
            const phys = body.terrainHeight(hv), drawn = worldsR.heightAt(body, hv, hOut);
            if (Number.isFinite(drawn) && Number.isFinite(phys) && Number.isFinite(hOut.spacing) && !(body.ocean && phys <= 0)) off = clamp(drawn - phys, -2, 2);
          } catch { off = 0; }
        }
        if (Math.abs(off) > 0.004) {
          view.deck = off; view.lift = off * (1 - Math.max(0, v.radarAlt) / 25);
          view.group.position.addScaledVector(hv.copy(v.pos).normalize(), view.lift);
        }
      }
      updateView(view, dt, simDt, v === a, world);
    }
    for (const [v, view] of views) if (v.dead || !world.vessels.includes(v)) { freeView(view); views.delete(v); }
    if (!a || !views.has(a)) {
      if (glow) { glow.object.removeFromParent(); glow.update(0, null, dt); }
      if (vapor) { vapor.object.removeFromParent(); vapor.update(0, null, dt); }
      engineLight.intensity = 0; pool.set(null, 0, 1); lamp.intensity = 0; lampPool.set(null, 0, 1); info.rumble = 0; info.buffet = 0; info.heatGlow = 0;
    }

    // ---- camera
    cam.shake = clamp(info.rumble * 0.55 + info.buffet * 0.5, 0, 1);
    cam.accel = a && !a.onRails ? (a.gForce || 1) : 1;
    { // an open parachute stands tens of metres above the capsule: pull back far enough to hold both in frame and
      // aim between them; the pilot's own zoom is put back when the canopy is gone (unless they changed it meanwhile)
      const av = a ? views.get(a) : null, open = av && av.canopyOpen ? av.canopyOpen : 0;
      if (open > 0 && typeof cam.setDist === 'function') {
        const need = open * 1.75 + 6;
        if (!canopyZoom) { canopyZoom = { prev: cam.goal, set: Math.max(cam.goal, need) }; cam.setDist(canopyZoom.set); }
        else if (need > canopyZoom.set + 0.5 && Math.abs(cam.goal - canopyZoom.set) < 0.5) { canopyZoom.set = need; cam.setDist(need); }
      } else if (canopyZoom) { if (Math.abs(cam.goal - canopyZoom.set) < 0.5 && typeof cam.setDist === 'function') cam.setDist(canopyZoom.prev); canopyZoom = null; }
      const want = open ? Math.min(cam.dist * 0.4, open * 0.5) : 0; cam.lift = (cam.lift || 0) + (want - (cam.lift || 0)) * Math.min(1, dt * 1.5); }
    cam.update(dt, anchor);
    // A clear first look. The opening view of a craft on the pad or the runway is a fixed bearing at a distance set by
    // its size; for the biggest stock rocket that put the camera 5 m behind a lightning mast. Once for each vessel
    // that waits to launch, while the view is still the one it was given: if a structure of the space centre
    // stands between camera and craft, turn to the nearest bearing where none does.
    if (a && a !== sightFor && a.situation === 'prelaunch' && base && base.group.visible && cam.mode === 'orbit' && typeof cam.snap === 'function') {
      sightFor = a;
      if (Math.abs(cam.yaw - 2.2) < 1e-6 && Math.abs(cam.pitch - 0.16) < 1e-6 && !sightClear(cam.yaw, cam.pitch, cam.dist, a, cam)) {
        for (const d of [0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.25, -1.25, 1.6, -1.6, 2.1, -2.1, 2.6, -2.6, Math.PI]) {
          if (!sightClear(2.2 + d, cam.pitch, cam.dist, a, cam)) continue;
          cam.yaw = 2.2 + d; cam.snap(); cam.update(0, anchor); break;
        }
      }
    }
    let wi = null;
    if (worldsR) {
      try { wi = settleMs > 0 ? worldsR.update({ ut, dt, body, origin: anchor.pos, sync: settleMs }) : worldsR.update({ ut, dt, body, origin: anchor.pos }); settleMs = 0; }
      catch (err) { if (!worldsR._warned) { worldsR._warned = true; console.warn('[flight] world renderer update failed:', err && err.message); } wi = null; }
      if (wi) {
        // sunlight after the air, straight from the atmosphere model
        const m = Math.max(wi.sunColor.r, wi.sunColor.g, wi.sunColor.b, 1e-4);
        sunTint.copy(wi.sunColor).multiplyScalar(1 / Math.max(m, 0.35));
        sunFar.color.copy(sunTint); sunNear.color.copy(sunTint);
        sunNear.intensity = 3.1 * lit * Math.min(1, m / 0.35 + 0.02);
      }
    }

    // ---- light rig around the vessel
    const bound = a ? Math.max(4, a.boundRadius || 4) : 8;
    const half = clamp(bound * 1.7 + Math.min(cam.dist, 220) * 0.42, 14, 170);
    sunNear.position.copy(sunDir).multiplyScalar(half * 4); sunNear.target.position.set(0, 0, 0);
    if (sunNear.castShadow) {
      const sc = sunNear.shadow.camera;
      if (Math.abs(sc.right - half) > half * 0.04) { sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.near = half * 0.5; sc.far = half * 8; sc.updateProjectionMatrix(); }
      sunNear.shadow.normalBias = half * 0.0022;
    }
    // sky fill follows the sky: bright blue by day, nearly gone at night and in space (where the planet below glows a little)
    if (wi) { sky.copy(wi.skyZenith).lerp(wi.skyHorizon, 0.35); const k = Math.max(sky.r, sky.g, sky.b); if (k > 0.85) sky.multiplyScalar(0.85 / k); }
    else skyColor(body, Math.max(0, alt), info.sunElevation, sky);
    const lum = Math.max(sky.r, sky.g, sky.b);
    info.skyLum = lum;
    const planetShine = clamp(1 - alt / (body.radius * 3), 0, 1) * lit * (body.type === 'star' ? 0 : 1);
    hemi.color.copy(sky).lerp(col2.setRGB(0.75, 0.86, 1), 0.5); hemi.groundColor.copy(dustCol).multiplyScalar(0.7);
    hemi.intensity = 0.2 + 0.08 * (1 - lit) + 1.25 * Math.min(1, lum * 1.4) * (0.4 + 0.6 * lit) + 0.45 * planetShine * (1 - Math.min(1, lum * 1.4));
    bounce.position.copy(up).multiplyScalar(-600).addScaledVector(sunDir, -200); bounce.color.copy(dustCol).lerp(col2.setRGB(0.7, 0.8, 1), 0.5); bounce.intensity = 0.5 * planetShine;
    head.position.copy(camera.position).normalize().multiplyScalar(500).addScaledVector(cam.right, 260).addScaledVector(cam.up, 220);
    head.intensity = 0.12 + 0.14 * lit + 0.22 * (1 - lit);          // in a planet's shadow the ship must still read
    if (near.environment) {
      near.environmentIntensity = 0.1 + 0.75 * Math.min(1, lum * 1.5) * (0.3 + 0.7 * lit) + 0.25 * planetShine;
      q1.setFromUnitVectors(Y_AXIS, up); near.environmentRotation.copy(e1.setFromQuaternion(q1));
    }
    ambTint.copy(sky).multiplyScalar(0.55).addScalar(0.1 + 0.12 * lit);
    col2.copy(sunTint).multiplyScalar(1.15 * sunPow);
    smoke.setLight(sunDir, col2, ambTint);
    for (const ex of explosions) if (ex.fx.setLight) ex.fx.setLight(sunDir, col2, ambTint);
    if (vapor && vapor.setLight) vapor.setLight(col2.copy(sunTint).multiplyScalar(0.9 * sunPow).addScalar(0.25));

    // ---- ground shadow catcher
    const gd = a ? info.groundDist : 1e9;
    // (on the space centre's paving the model itself receives the shadow; the flat catcher would lie inside its layers)
    const aView = a ? views.get(a) : null, onDeck = !!(aView && base && base.group.visible && padDistNow <= 3000 && aView.deck > 0);
    const showCatch = !!a && sunNear.castShadow && lit > 0.05 && sinElev > 0.04 && gd < half * 2.2 && !(a.splashed) && !onDeck;
    catcher.visible = showCatch;
    if (showCatch) {
      catcher.position.copy(up).multiplyScalar(-gd + 0.04 + (aView ? aView.deck || 0 : 0));
      catcher.quaternion.setFromUnitVectors(Y_AXIS, up);
      catcher.scale.setScalar(half * 1.6);
      catcher.material.opacity = 0.52 * lit * sstep(0.03, 0.2, sinElev) * (1 - sstep(half * 1.2, half * 2.2, gd)) * (0.55 + 0.45 * Math.min(1, lum * 2 + (body.atmo ? 0 : 1)));
    }

    // ---- bodies (double precision relative positions)
    if (legacy) for (const [b, e] of bodies) {
      b.globalPosAt(ut, g3);
      rel.copy(g3).sub(g1).sub(anchor.pos);
      if (b === body) rel.copy(anchor.pos).negate();
      const d = rel.length();
      const k = d > FAR_LIMIT && !(b === body && alt < FAR_LIMIT) ? FAR_LIMIT / d : 1;
      e.vis.group.position.copy(rel).multiplyScalar(k);
      e.vis.group.scale.setScalar(b.radius * k);
      v1.copy(g3).multiplyScalar(-1); if (v1.lengthSq() < 1) v1.set(1, 0, 0);
      e.vis.update(ut, v1.normalize());
      if (b !== body && b.type !== 'star' && e.vis.mesh && e.vis.mesh.material) {
        // in a daylight sky only the sunlit part of a distant world shows; its night side is just more sky
        const blend = info.skyLum > 0.03 ? THREE.AdditiveBlending : THREE.NormalBlending;
        if (e.vis.mesh.material.blending !== blend) { e.vis.mesh.material.blending = blend; e.vis.mesh.material.needsUpdate = true; }
        if (e.vis.atmosphere) e.vis.atmosphere.visible = info.skyLum < 0.03;
      }
      if (b === body && e.vis.mesh && e.vis.mesh.material.blending !== THREE.NormalBlending) { e.vis.mesh.material.blending = THREE.NormalBlending; e.vis.mesh.material.needsUpdate = true; if (e.vis.atmosphere) e.vis.atmosphere.visible = true; }
      if (b === body && !e.hi && b.type !== 'star') { e.hi = true; try { if (e.vis.setTextureSize) e.vis.setTextureSize(2048, 1024); } catch { /* keep the small one */ } }
    }

    // ---- terrain patch
    if (legacy && terrainBody !== body) {
      if (terrain) terrain.group.visible = false;
      terrainBody = body; terrain = null;
      if (!body.gas && body.type !== 'star') {
        terrain = terrains.get(body);
        if (!terrain) { terrain = createTerrainPatch(body); terrains.set(body, terrain); far.add(terrain.group); }
        terrainFresh = false;
      }
    }
    if (terrain) {
      const show = alt < TERRAIN_ALT;
      terrain.group.visible = show;
      if (show) {
        body.inertialToSurfaceDir(up, ut, v1);
        if (!terrainFresh || Math.acos(clamp(v1.dot(terrain.centerDir), -1, 1)) * body.radius > TERRAIN_RECENTER) { terrain.recenter(v1); terrainFresh = true; }
        body.surfaceDirToInertial(terrain.centerDir, ut, v2).multiplyScalar(body.radius).sub(anchor.pos);
        terrain.group.position.copy(v2);
        terrain.group.quaternion.setFromAxisAngle(Y_AXIS, body.rotationAngle(ut));
      }
    }

    // ---- flags
    for (const f of world.flags || []) {
      let m = flagViews.get(f);
      if (!m) { m = createFlagMesh(); shadowFlags(m, true, false); near.add(m); flagViews.set(f, m); m.userData.dir = new THREE.Vector3(f.dir.x, f.dir.y, f.dir.z).normalize(); }
      const fb = SYSTEM.byId[f.bodyId];
      if (fb !== body) { m.visible = false; continue; }
      fb.surfaceDirToInertial(m.userData.dir, ut, v2).multiplyScalar(surfaceRadius(fb, m.userData.dir)).sub(anchor.pos);
      m.visible = v2.lengthSq() < 4e8;
      if (!m.visible) continue;
      m.position.copy(v2);
      if (worldsR && typeof worldsR.heightAt === 'function' && !(fb === SYSTEM.home && padDistNow <= 3000)) {      // the pole stands on the ground as drawn
        try { const drawn = worldsR.heightAt(fb, m.userData.dir, hOut), phys = fb.terrainHeight(m.userData.dir); if (Number.isFinite(drawn) && Number.isFinite(phys) && Number.isFinite(hOut.spacing) && !(fb.ocean && phys <= fb.seaLevel)) m.position.addScaledVector(v4.copy(v2).add(anchor.pos).normalize(), clamp(drawn - phys, -3, 3)); } catch { /* keep the physics height */ }
      }
      m.quaternion.setFromAxisAngle(Y_AXIS, fb.rotationAngle(ut)).multiply(World.padFrame(m.userData.dir, q1));
      if (m.userData.update) m.userData.update(clock);
    }
    for (const [f, m] of flagViews) if (!(world.flags || []).includes(f)) { m.removeFromParent(); flagViews.delete(f); }

    // ---- explosions
    const grav = v5.copy(up).multiplyScalar(-(body.gm / Math.max(1, R * R)));
    for (let i = explosions.length - 1; i >= 0; i--) {
      const ex = explosions[i];
      if (ex.body === body) {
        ex.pos.addScaledVector(ex.vel, simDt);
        ex.fx.object.position.copy(ex.pos).sub(anchor.pos);
        ex.fx.object.visible = true;
      } else ex.fx.object.visible = false;
      if (!ex.fx.update(simDt > 0 ? dt : 0, grav)) { ex.fx.object.removeFromParent(); try { ex.fx.dispose(); } catch { /* ignore */ } explosions.splice(i, 1); }
    }

    // ---- sky
    if (legacy) {
      far.background.copy(sky);
      stars.position.copy(camera.position);
      stars.scale.setScalar(1e5);
      stars.userData.setOpacity(clamp(1 - lum * 3.2, 0, 1));
    } else far.background.setRGB(0, 0, 0);
    haze.position.copy(camera.position); haze.scale.setScalar(9e4);
    const hazeA = clamp(lum * 2.4, 0, 1);
    haze.visible = legacy && hazeA > 0.01 && !!body.atmo;
    if (haze.visible) {
      hazeU.uUp.value.copy(up); hazeU.uSun.value.copy(sunDir);
      hazeU.uZenith.value.copy(sky);
      hazeU.uHorizon.value.copy(sky).lerp(col2.setRGB(lum * 1.05, lum * 1.05, lum * 1.04), 0.6).lerp(col2.setRGB(lum * 1.2, lum * 0.72, lum * 0.42), 0.75 * lowSun);
      hazeU.uSunTint.value.copy(sunTint).multiplyScalar(1.4);
      hazeU.uAlpha.value = hazeA;
      // the horizon sinks below eye level as you climb
      hazeU.uDip.value = Math.min(0.5, Math.sqrt(Math.max(0, 2 * Math.max(alt, 0) / body.radius)));
      hazeU.uSunGlow.value = clamp(lum * 2, 0, 1);
    }
    if (prevBody !== body) terrainFresh = false;

    // ---- where the sun is on screen (lens effects)
    v1.copy(sunDir).multiplyScalar(1e6).add(camera.position).project(camera);
    const inFront = sunDir.dot(cam.forward) > 0.05;
    info.sunUv.set(v1.x * 0.5 + 0.5, v1.y * 0.5 + 0.5);
    let vis = inFront && Math.abs(v1.x) < 1.1 && Math.abs(v1.y) < 1.1 ? lit : 0;
    if (vis > 0) {
      // hidden behind the world we are flying over?
      g3.copy(anchor.pos).add(camera.position);
      const b = g3.dot(sunDir), c = g3.lengthSq() - body.radius * body.radius;
      if (b < 0 && b * b - c > 0) vis = 0;
    }
    info.sunVisible = vis;
  }

  function burst(pos, n, make) { for (let i = 0; i < n; i++) make(i, pos); }

  function onWorldEvent(type, p) {
    if (!p) return;
    if (type === 'dock' || type === 'undock') {
      // the part set and the craft frame changed: build these vessels' meshes again
      for (const v of [p.vessel, p.other, p.absorbed]) {
        const view = v && views.get(v);
        if (!view) continue;
        if (v.dead) { if (glow && glow.object.parent === view.group) glow.object.removeFromParent(); if (vapor && vapor.object.parent === view.group) vapor.object.removeFromParent(); freeView(view); views.delete(v); } else view.dirty = true;
      }
      return;
    }
    const body = anchor.body, pq = quality.particles;
    if (type === 'decouple' && p.vessel && p.debris && p.vessel.body === body && p.debris.pos) {
      // a ring of white puffs where the two halves part
      const mid = v1.copy(p.vessel.pos).add(p.debris.pos).multiplyScalar(0.5).sub(anchor.pos);
      if (mid.lengthSq() > 4e6) return;
      const axis = v2.copy(p.debris.pos).sub(p.vessel.pos); if (axis.lengthSq() < 1e-6) axis.copy(info.up); axis.normalize();
      const rr = Math.max(0.6, (p.debris.baseRadius || p.vessel.baseRadius || 1) * 0.9);
      const dens = body.density(Math.max(0, anchor.pos.length() - body.radius));
      burst(mid, Math.round(22 * pq), () => {
        radial(axis);
        t3.copy(mid).addScaledVector(v5, rr);
        t1.copy(v5).multiplyScalar(5 + Math.random() * 7).addScaledVector(axis, rnd() * 3);
        smoke.emit(t3, { size: 0.5, growth: 3.2, life: 0.7 + Math.random() * 0.8, alpha: 0.5, vel: t1, drag: dens > 0.01 ? 2.2 : 0.4, color: col2.setRGB(0.95, 0.95, 0.97), fadeIn: 0.03, add: 0.15 });
      });
      for (let i = 0; i < 8; i++) { radial(axis); t3.copy(mid).addScaledVector(v5, rr); smoke.emit(t3, { size: 0.2, growth: 0, life: 0.5 + Math.random() * 0.5, alpha: 1, vel: t1.copy(v5).multiplyScalar(8 + Math.random() * 10), drag: 0.5, color: col2.setRGB(4, 2.6, 0.9), add: 1, fadeIn: 0.01, shrink: true }); }
      return;
    }
    if ((type === 'landed' || type === 'splashed') && p.vessel && p.vessel.body === body) {
      const view = views.get(p.vessel);
      const at = v1.copy(p.vessel.pos).sub(anchor.pos).addScaledVector(info.up, -(view ? view.ext : 1) + 0.2);
      if (at.lengthSq() > 4e6) return;
      const sp = clamp((p.speed || 2) / 6, 0.3, 2.5), air = body.density(0) > 0.01;
      const water = type === 'splashed';
      burst(at, Math.round((water ? 40 : 26) * sp * pq), () => {
        radial(info.up);
        t3.copy(at).addScaledVector(v5, 0.5 + Math.random() * 2);
        t1.copy(v5).multiplyScalar((water ? 5 : 3) + Math.random() * 6 * sp).addScaledVector(info.up, (water ? 6 : 1) + Math.random() * (water ? 8 : 2.5) * sp);
        if (water) smoke.emit(t3, { size: 0.5, growth: 1.8, life: 1.1 + Math.random() * 0.9, alpha: 0.7, vel: t1, drag: 0.6, gravity: 9, color: col2.setRGB(0.92, 0.96, 1), fadeIn: 0.03 });
        else smoke.emit(t3, { size: 0.8, growth: 2.6, life: 1.8 + Math.random() * 2.2, alpha: 0.36, vel: t1, drag: air ? 1.6 : 0.1, gravity: air ? 0 : body.surfaceG || 1.6, rise: air ? 0.3 : 0, color: dustCol, fadeIn: 0.08 });
      });
      return;
    }
    if (type === 'chute' && p.vessel && p.part && (p.state === 'semi' || p.state === 'full') && p.vessel.body === body) {
      const view = views.get(p.vessel); if (!view) return;
      const e = view.parts.get(p.part.id); if (!e) return;
      e.mesh.getWorldPosition(v1);
      burst(v1, Math.round(10 * pq), () => { t1.set(rnd(), rnd(), rnd()).multiplyScalar(6); smoke.emit(v1, { size: 0.4, growth: 3, life: 0.5 + Math.random() * 0.4, alpha: 0.4, vel: t1, drag: 2.5, color: col2.setRGB(0.95, 0.95, 0.95), fadeIn: 0.03 }); });
      return;
    }
    if (type !== 'explosion' || !p.pos) return;
    if (explosions.length > 24) return;
    const ebody = p.body || anchor.body;
    const pos = new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z);
    const vel = new THREE.Vector3();
    const alt = pos.length() - ebody.radius;
    const dens = ebody.density(Math.max(0, alt));
    const fx = createExplosion(clamp(p.size || 2, 0.8, 6), { smoke: clamp(dens * 2.5, 0, 1), dust: alt < 30 ? dustCol.getHex() : null });
    if (alt < (ebody.atmo ? ebody.atmo.height * 0.6 : 2000)) { const wy = TAU / ebody.rotPeriod; vel.set(wy * pos.z, 0, -wy * pos.x); }
    else vel.copy(anchor.vel);
    near.add(fx.object);
    fx.object.position.copy(pos).sub(anchor.pos);
    explosions.push({ fx, pos, vel, body: ebody });
    info.jolt = clamp(1.6 - fx.object.position.length() / 400, 0, 1.6) * clamp((p.size || 2) / 3, 0.4, 1.5);
  }

  const dbSize = new THREE.Vector2();
  function render(renderer) {
    if (!renderer) return;
    const prevAuto = renderer.autoClear;
    renderer.setScissorTest(false);
    const usePost = !!post && quality.post;
    if (usePost) {
      renderer.getDrawingBufferSize(dbSize);
      post.setSize(dbSize.x, dbSize.y, (quality.scale || 1) * gov.state.scale);
      const rt = post.begin();
      // no renderer.setViewport() here: it takes CSS pixels and multiplies by the pixel ratio, so on a dpr-2 display it
      // set a viewport twice the size of the target and the far scene was drawn zoomed about the bottom-left corner
      // (the near scene was only right because its shadow pass re-bound the target). The target carries its own viewport.
      rt.viewport.set(0, 0, rt.width, rt.height);
      renderer.setRenderTarget(rt);
    } else { renderer.setRenderTarget(null); renderer.setViewport(0, 0, app.size.w, app.size.h); }
    renderer.autoClear = true;
    renderer.render(far, camera);
    renderer.autoClear = false;
    renderer.render(near, camera);
    if (usePost) {
      renderer.setRenderTarget(null);
      renderer.setViewport(0, 0, app.size.w, app.size.h);
      post.end({ sunUv: info.sunUv, sunVisible: info.sunVisible, dt: lastDt });
    }
    renderer.setRenderTarget(null);
    renderer.autoClear = prevAuto;
  }

  /**
   * Compile the shader programs of everything that exists in the two scenes now (visible or not: plumes, glows and
   * chutes included), without blocking: resolves when they are linked. Call it once after the first update(), before
   * the first render. Without it every program is compiled and linked inside the first frame that draws it, and the
   * frame waits: a long first frame, and a hitch at ignition, staging and every other first appearance.
   */
  function prewarm(renderer, maxMs = 8000) {
    if (!renderer || typeof renderer.compileAsync !== 'function' || disposed) return Promise.resolve(0);
    const before = renderer.info.programs ? renderer.info.programs.length : 0;
    let work;
    try {
      // programs depend on where they draw to (the HDR target is linear and not tone-mapped; the canvas is neither)
      const usePost = !!post && quality.post;
      if (usePost) { renderer.getDrawingBufferSize(dbSize); post.setSize(dbSize.x, dbSize.y, (quality.scale || 1) * gov.state.scale); post.begin(); }
      else renderer.setRenderTarget(null);
      work = Promise.all([renderer.compileAsync(far, camera), renderer.compileAsync(near, camera)]);
    } catch (err) { console.warn('[flight] shader pre-compile failed:', err && err.message); work = Promise.resolve(); }
    finally { renderer.setRenderTarget(null); }
    const count = () => (renderer.info.programs ? renderer.info.programs.length : 0) - before;
    return Promise.race([work.then(count, count), new Promise(r => setTimeout(() => r(count()), maxMs))]);
  }

  function resize(w, h) { camera.aspect = Math.max(0.1, w / Math.max(1, h)); camera.updateProjectionMatrix(); }

  function dispose() {
    disposed = true;
    for (const view of views.values()) freeView(view);
    views.clear();
    for (const ex of explosions) { ex.fx.object.removeFromParent(); try { ex.fx.dispose(); } catch { /* ignore */ } }
    explosions.length = 0;
    for (const m of flagViews.values()) m.removeFromParent();
    flagViews.clear();
    if (worldsR) { try { worldsR.dispose(); } catch { /* ignore */ } worldsR = null; }
    for (const { vis } of bodies.values()) { far.remove(vis.group); try { vis.dispose(); } catch { /* ignore */ } }
    bodies.clear();
    for (const t of terrains.values()) { far.remove(t.group); try { t.mesh.geometry.dispose(); t.mesh.material.dispose(); } catch { /* other shape */ } }
    terrains.clear();
    if (glow) { glow.object.removeFromParent(); glow.dispose(); glow = null; }
    if (vapor) { vapor.object.removeFromParent(); vapor.dispose(); vapor = null; }
    far.remove(stars); stars.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
    haze.geometry.dispose(); haze.material.dispose();
    smoke.dispose(); pool.dispose(); lampPool.dispose(); lamp.dispose();
    catcher.geometry.dispose(); catcher.material.dispose();
    if (pad) pad.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.dispose) o.material.dispose(); });
    if (base) { near.remove(base.group); try { base.dispose(); } catch { /* ignore */ } base = null; }
    if (sunNear.shadow.map) sunNear.shadow.map.dispose();
    if (env) env.dispose();
    if (post) post.dispose();
  }

  return {
    far, near, camera, anchor, info, views, update, render, resize, onWorldEvent, dispose, applySettings, adoptBase, prewarm,
    get smoke() { return smoke; }, get terrain() { return terrain; }, get pad() { return base ? base.group : pad; }, get base() { return base; },
    get fx() { return { smoke, post, quality: qualityName, explosions }; },
    /** true when a software rasteriser was detected (the scene then runs in the reduced 'soft' mode unless settings.gfxForce). */
    get softGL() { return softGL; }, get qualityName() { return qualityName; },
    /** The automatic quality governor (js/ui/governor.js): level, state { scale, shadow, msaa, bloom }, lock(n | null). */
    get governor() { return gov; },
    /** The world renderer (planetgfx.createWorldRenderer) or null: `worlds.info.busy` tells previews when the terrain is in. */
    get worlds() { return worldsR; },
    /** Ask the next frame to build missing terrain chunks on this thread for up to `ms` (captures, loading screens). */
    settleTerrain(ms = 2000) { settleMs = Math.max(0, +ms || 0); },
  };
}
