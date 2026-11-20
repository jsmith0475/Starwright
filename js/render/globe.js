// Starwright — a whole body drawn on a unit sphere: baked colour, relief, glow and cloud maps, ocean glint,
// night side with a little fill, atmosphere limb (a scattering shell that also works from inside), rings with the
// planet's shadow on them and their shadow on the planet, and the star with its glare.
import * as THREE from '../lib/three.module.min.js';
import { atmoUniforms, atmoParams, ambientSky, skyAt, SUN_SURFACE, fillTint } from './atmosphere.js';
import { GLOBE_VS, GLOBE_FS, SHELL_VS, SHELL_FS } from './worldshaders.js';
import { getBodyMaps, requestBodyMaps, MAP_SIZES } from './bodytex.js';
import { styleOf, cloudAngle } from './worldstyle.js';

const SEG = { low: 48, medium: 64, high: 96 };
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

function glowTexture(kind) {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  if (kind === 'core') { gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.3, 'rgba(255,255,255,0.35)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.07)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); }
  else { gr.addColorStop(0, 'rgba(255,255,255,0.5)'); gr.addColorStop(0.2, 'rgba(255,255,255,0.14)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.03)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); }
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
  if (kind === 'rays') {
    g.globalCompositeOperation = 'lighter'; g.translate(s / 2, s / 2);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 34; i++) {
      const a = rnd() * Math.PI * 2, len = s * (0.22 + rnd() * 0.27), w = 0.012 + rnd() * 0.05;
      const lg = g.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
      lg.addColorStop(0, 'rgba(255,255,255,0.10)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = lg; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a - w) * len, Math.sin(a - w) * len); g.lineTo(Math.cos(a + w) * len, Math.sin(a + w) * len); g.closePath(); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const glowTex = {};

const RING_VS = `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vPosO;
void main(){ vPosO = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
#include <logdepthbuf_vertex>
}`;
const RING_FS = `#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uRingTex; uniform vec2 uRingR; uniform vec3 uSun, uCamO; uniform float uSunSurf;
varying vec3 vPosO;
void main(){
#include <logdepthbuf_fragment>
  float r = length(vPosO.xz);
  float k = (r - uRingR.x) / (uRingR.y - uRingR.x);
  if (k < 0.0 || k > 1.0) discard;
  vec4 t = texture2D(uRingTex, vec2(k, 0.5));
  // shadow of the planet (unit sphere at the origin) along the ray toward the sun
  float b = dot(vPosO, uSun), c = dot(vPosO, vPosO) - 1.0, d = b * b - c;
  float shadow = (d > 0.0 && b < 0.0) ? smoothstep(0.0, 0.004, -d) + 0.0 : 1.0;
  if (d > 0.0 && b < 0.0) shadow = 1.0 - smoothstep(0.0, 0.02, d);
  vec3 V = normalize(uCamO - vPosO);
  // lit side bright; seen from the far side the ring glows by light passing through the thin parts
  float sameSide = step(0.0, uSun.y * V.y);
  float through = t.a * (1.0 - t.a) * 2.2;
  float lit = mix(through * 0.7, 0.55 + 0.45 * abs(uSun.y), sameSide) + 0.25 * pow(max(dot(-V, uSun), 0.0), 6.0) * (1.0 - t.a);
  vec3 col = pow(t.rgb, vec3(2.2)) * uSunSurf * lit * shadow + pow(t.rgb, vec3(2.2)) * 0.012;
  float a = t.a * mix(1.0, 0.92, sameSide);
  gl_FragColor = vec4(col * a, a);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`;

const TAIL_VS = `#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uLen;
varying float vT; varying vec3 vN, vV;
void main(){
  vT = position.y / uLen;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
#include <logdepthbuf_vertex>
}`;
const TAIL_FS = `#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor; uniform float uK;
varying float vT; varying vec3 vN, vV;
void main(){
#include <logdepthbuf_fragment>
  // a hollow cone drawn as if it were a glowing volume: bright where the line of sight runs deep through it
  float f = pow(abs(dot(normalize(vN), normalize(vV))), 1.7);
  float a = pow(1.0 - vT, 2.4) * smoothstep(0.0, 0.015, vT) * f * uK;
  gl_FragColor = vec4(uColor * a, 1.0);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`;
const Y_UP = new THREE.Vector3(0, 1, 0), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();

/**
 * A comet's coma and its two tails (blue ion tail straight down-sun, pale dust tail lagging behind the orbit), in
 * units of the nucleus radius. They wake as the comet nears the star and fade far out.
 */
function makeComet(body, group, disposables) {
  const tail = (len, wid, color) => {
    const geo = new THREE.CylinderGeometry(wid, 0.5, len, 20, 10, true); geo.translate(0, len / 2, 0);
    const mat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Vector3(...color) }, uK: { value: 0 }, uLen: { value: len } }, vertexShader: TAIL_VS, fragmentShader: TAIL_FS,
      side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const m = new THREE.Mesh(geo, mat); m.renderOrder = 4; m.name = 'tail'; m.userData.len = len;
    group.add(m); disposables.push(geo, mat);
    return m;
  };
  const ion = tail(2600, 70, [0.35, 0.62, 1.0]), dust = tail(1500, 260, [1.0, 0.9, 0.7]);
  glowTex.core = glowTex.core || glowTexture('core');
  const coma = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex.core, color: 0x9fe6d8, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  coma.name = 'coma'; coma.renderOrder = 4; group.add(coma); disposables.push(coma.material);
  const api = {
    ion, dust, coma, activity: 0, extent: 1,
    update(ut, sunWorld, orient) {
      // activity: nothing beyond about 5e10 m from the star, full inside 1.6e10 m
      body.globalPosAt(ut, _t1);
      const r = _t1.length(), k = Math.pow(Math.min(1, Math.max(0, (5.2e10 - r) / 3.6e10)), 1.5);
      api.activity = k;
      ion.visible = dust.visible = coma.visible = k > 0.003;
      if (!ion.visible) { api.extent = 1; return; }
      const grow = 0.25 + 0.75 * k;
      ion.quaternion.setFromUnitVectors(Y_UP, _t2.copy(sunWorld).multiplyScalar(-1));
      ion.scale.set(grow, grow, grow); ion.material.uniforms.uK.value = 0.55 * k;
      // dust lags: it is pushed away from the sun but also falls behind along the orbit
      body.globalPosAt(ut + 60, _t2).sub(_t1).normalize();
      if (orient) _t2.applyQuaternion(orient);
      _t2.multiplyScalar(-0.42).addScaledVector(sunWorld, -1).normalize();
      dust.quaternion.setFromUnitVectors(Y_UP, _t2);
      dust.scale.set(grow, grow, grow); dust.material.uniforms.uK.value = 0.4 * k;
      coma.scale.setScalar(18 + 60 * k); coma.material.color.setRGB(0.5 * k, 0.85 * k, 0.8 * k);
      api.extent = 2600 * grow * 0.35;           // how far the visible part reaches, in radii (for "is it worth drawing")
    },
  };
  return api;
}

const _pp = new THREE.Vector3();
/**
 * Planet-shine: the light a moon's night side gets from its planet. Writes out.color (linear, the planet's colour ×
 * how big it looms × how much of its lit face the moon sees) and out.dir (unit, toward the planet, inertial axes).
 * Returns false for bodies that orbit the star.
 */
export function planetShine(body, ut, out) {
  const parent = body.parent;
  if (!parent || parent.type === 'star' || !body.posAt) return false;
  body.posAt(ut, _pp);                                   // moon relative to its planet
  const d = _pp.length() || 1;
  out.dir.copy(_pp).multiplyScalar(-1 / d);
  parent.globalPosAt(ut, _pp);                           // planet relative to the star: sunlight travels along +_pp
  const lit = 0.5 * (1 + out.dir.dot(_pp.normalize()));  // 1 when the planet stands opposite the sun (full), 0 when new
  const size = Math.min(0.16, 45 * (parent.radius / d) ** 2);
  const c = parent.color ?? 0xffffff, st = styleOf(parent.id);
  let r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  if (st.clouds) { r = 0.5 * r + 0.5; g = 0.5 * g + 0.5; b = 0.5 * b + 0.5; }      // a cloudy planet shines whiter
  const m = Math.max(r, g, b, 1e-3), k = size * (0.08 + 0.92 * lit) * SUN_SURFACE / m;
  out.color.set(r * r * k, g * g * k, b * b * k);
  return true;
}

/**
 * Visual for a body: a unit sphere (radius 1). THE CALLER sets group.scale (the body radius in scene units) and
 * group.position. `update(ut, sunDirWorld)` spins the globe to body.rotationAngle(ut) and aims the light;
 * sunDirWorld = unit vector from the body toward the sun, in the scene's axes. The shaders light themselves
 * (no scene lights needed) and include the air seen from outside and from inside.
 * A small map is shown at once; sharper ones are baked by workers and swapped in.
 * @returns {{group, mesh, spin, atmosphere, rings, update(ut, sunDirWorld), setTextureSize(w,h):Promise, ready:Promise, setOpacity(o), setSunTint(color), dispose()}}
 */
export function createBodyVisual(body, { quality = 'high', nightFill = null } = {}) {
  const star = body.type === 'star', style = styleOf(body.id), maps = getBodyMaps(body);
  const group = new THREE.Group(); group.name = 'body_' + body.id;
  const spin = new THREE.Group(); group.add(spin);
  const seg = SEG[quality] || 96;
  const geo = new THREE.SphereGeometry(1, seg, seg / 2);
  const amb = ambientSky(body), sky = skyAt(body, 0, 0.9, {});
  const defines = {};
  if (style.clouds) defines.CLOUDS = 1;
  if (body.ocean && style.water) defines.OCEAN = 1;
  if (maps.ring) defines.RING = 1;
  const sunU = { value: new THREE.Vector3(1, 0, 0) };
  const uniforms = {
    ...atmoUniforms(body),
    uAlbedoTex: { value: maps.color }, uNormalTex: { value: maps.normal },
    uCamO: { value: new THREE.Vector3(0, 0, 5) }, uSun: sunU,
    uAmbSky: { value: V3(amb) }, uSunSurf: { value: SUN_SURFACE }, uFill: { value: nightFill != null ? Math.max(style.fill, nightFill) : style.fill },
    uFillTint: { value: V3(fillTint(body)) }, uShine: { value: new THREE.Vector3() }, uShineDir: { value: new THREE.Vector3(0, 1, 0) },
    uBump: { value: body.gas || star ? 0 : style.bump }, uEmissive: { value: style.emissive * 1.2 }, uGloss: { value: style.gloss },
    uTime: { value: 0 }, uGas: { value: body.gas ? 1 : 0 }, uStar: { value: star ? 1 : 0 }, uOpacity: { value: 1 },
    uCloudTex: { value: maps.clouds }, uCloudRot: { value: 0 },
    uCloudShadow: { value: style.clouds ? Math.min(0.62, 0.35 + 0.4 * style.clouds.cover) : 0 },
    uCloudAlt: { value: style.clouds ? style.clouds.alt / body.radius : 0 }, uCloudColor: { value: V3(style.clouds ? style.clouds.color : [1, 1, 1]) },
    uShallow: { value: V3(style.water ? style.water.shallow : [0, 0, 0]) }, uDeep: { value: V3(style.water ? style.water.deep : [0, 0, 0]) },
    uSkyZen: { value: V3(sky.zenith) }, uSkyHor: { value: V3(sky.horizon) },
    uRingTex: { value: maps.ring }, uRingR: { value: new THREE.Vector2(body.ring ? body.ring.inner / body.radius : 1, body.ring ? body.ring.outer / body.radius : 2) },
  };
  const material = new THREE.ShaderMaterial({ uniforms, defines, vertexShader: GLOBE_VS, fragmentShader: GLOBE_FS });
  const mesh = new THREE.Mesh(geo, material); mesh.name = 'globe'; mesh.renderOrder = -5; spin.add(mesh);
  const sunWorld = new THREE.Vector3(1, 0, 0), shineWorld = new THREE.Vector3(0, 1, 0), shine = { color: new THREE.Vector3(), dir: new THREE.Vector3() };
  // camera and sun in the object space of whatever is being drawn (double precision on the CPU)
  const toObject = (obj, camera, camU, sunUn) => {
    _m.copy(obj.matrixWorld).invert();
    camU.value.copy(_v.setFromMatrixPosition(camera.matrixWorld)).applyMatrix4(_m);
    obj.matrixWorld.decompose(_v, _q, _s);
    sunUn.value.copy(sunWorld).applyQuaternion(_q.invert()).normalize();
  };
  mesh.onBeforeRender = (r, s, camera) => {
    toObject(mesh, camera, uniforms.uCamO, sunU);
    uniforms.uShineDir.value.copy(shineWorld).applyQuaternion(_q).normalize();      // _q: world → object, left by toObject
    material.uniformsNeedUpdate = true;
  };

  const disposables = [geo, material];
  let atmosphere = null, shellU = null;
  const ap = atmoParams(body);
  if (ap && !star) {
    shellU = { ...atmoUniforms(body), uCamO: { value: new THREE.Vector3(0, 0, 5) }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uGround: { value: style.clouds && style.clouds.cover > 0.8 ? 1 + style.clouds.alt / body.radius : 0.994 } };   // under an unbroken deck the cloud tops are the visible surface
    const sg = new THREE.SphereGeometry(ap.top, 96, 48);
    const sm = new THREE.ShaderMaterial({
      uniforms: shellU, vertexShader: SHELL_VS, fragmentShader: SHELL_FS, side: THREE.BackSide, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
    });
    atmosphere = new THREE.Mesh(sg, sm); atmosphere.name = 'atmosphere'; atmosphere.renderOrder = 3;
    atmosphere.onBeforeRender = (r, s, camera) => { toObject(atmosphere, camera, shellU.uCamO, shellU.uSun); sm.uniformsNeedUpdate = true; };
    group.add(atmosphere);
    disposables.push(sg, sm);
  }

  let rings = null, ringU = null;
  if (maps.ring) {
    const ri = body.ring.inner / body.radius, ro = body.ring.outer / body.radius;
    const rg = new THREE.RingGeometry(ri, ro, 160, 1); rg.rotateX(-Math.PI / 2);
    ringU = { uRingTex: { value: maps.ring }, uRingR: uniforms.uRingR, uSun: { value: new THREE.Vector3(1, 0, 0) }, uCamO: { value: new THREE.Vector3() }, uSunSurf: { value: SUN_SURFACE } };
    const rm = new THREE.ShaderMaterial({
      uniforms: ringU, vertexShader: RING_VS, fragmentShader: RING_FS, side: THREE.DoubleSide, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
    });
    rings = new THREE.Mesh(rg, rm); rings.name = 'rings'; rings.renderOrder = 4;   // after the atmosphere shell, so it does not haze the near side of the rings
    rings.onBeforeRender = (r, s, camera) => { toObject(rings, camera, ringU.uCamO, ringU.uSun); rm.uniformsNeedUpdate = true; };
    group.add(rings);
    disposables.push(rg, rm);
  }

  const comet = body.comet ? makeComet(body, group, disposables) : null;

  const sprites = [];
  if (star) {
    glowTex.core = glowTex.core || glowTexture('core'); glowTex.rays = glowTex.rays || glowTexture('rays');
    const tint = new THREE.Color(body.color ?? 0xffd76a).lerp(new THREE.Color(0xffffff), 0.45);
    const mk = (map, scale, k, name) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map, color: tint.clone().multiplyScalar(k), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      sp.scale.setScalar(scale); sp.name = name; sp.renderOrder = 1; sp.userData.k = k; sp.userData.size = scale;
      group.add(sp); sprites.push(sp); disposables.push(sp.material);
      return sp;
    };
    mk(glowTex.core, 7, 3.2, 'glow'); mk(glowTex.rays, 22, 1.1, 'corona');
    group.userData.baseTint = tint;
  }

  const level = quality === 'low' ? 'low' : quality === 'medium' ? 'medium' : 'high';
  const ready = requestBodyMaps(body, level);

  return {
    group, mesh, spin, atmosphere, rings, ready, body, comet,
    /** how many body radii the drawn thing reaches from its centre (1 for a plain globe; a comet's tail is long) */
    get extent() { return comet ? comet.extent : rings ? body.ring.outer / body.radius : 1; },
    /** kept for callers of the first release: ask for maps of at least w × h */
    setTextureSize(w, h) {
      const lvl = w > MAP_SIZES.medium[0] ? 'high' : w > MAP_SIZES.low[0] ? 'medium' : 'low';
      return requestBodyMaps(body, lvl, true).then(() => maps.color);
    },
    /**
     * @param ut            universal time: spin, clouds, and where the parent planet stands (planet-shine on a moon)
     * @param sunDirWorld   unit vector from the body toward the star, scene axes
     * @param orient        optional Quaternion, inertial axes → scene axes, when the scene is not inertial
     */
    update(ut, sunDirWorld, orient = null) {
      spin.rotation.y = body.rotationAngle ? body.rotationAngle(ut) : 0;
      if (sunDirWorld) sunWorld.copy(sunDirWorld).normalize();
      if (!star && planetShine(body, ut, shine)) {
        shineWorld.copy(shine.dir); if (orient) shineWorld.applyQuaternion(orient);
        uniforms.uShine.value.copy(shine.color);
      }
      if (comet) comet.update(ut, sunWorld, orient);
      uniforms.uTime.value = ut;
      uniforms.uCloudRot.value = cloudAngle(style, ut);
    },
    /** the floor of light on the night side (0 = black, 0.3 = clearly readable, for maps); never below the body's own */
    setNightFill(f) { uniforms.uFill.value = Math.max(style.fill, f); },
    /** fade the globe (the caller must also set mesh.material.transparent when using values below 1) */
    setOpacity(o) { uniforms.uOpacity.value = o; },
    /**
     * tint the star's glare (sunset reddening): THREE.Color multiplier. `glare` 1 = the full flare of open space,
     * 0 = the sun seen through a bright daytime sky, where the eye is stopped down and the flare shrinks to a
     * tight bloom (the air's own scattering already draws the halo).
     */
    setSunTint(c, glare = 1) {
      const base = group.userData.baseTint; if (!base) return;
      const k = 0.16 + 0.84 * glare, sz = 0.42 + 0.58 * glare;
      for (const sp of sprites) {
        sp.material.color.setRGB(base.r * c.r * sp.userData.k * k, base.g * c.g * sp.userData.k * k, base.b * c.b * sp.userData.k * k);
        sp.scale.setScalar(sp.userData.size * sz);
      }
    },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}
