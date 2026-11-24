// Starwright water effects for a craft that comes down in the sea: the foam it leaves on the surface.
// Procedural shader only, no image files. (The spray itself is thrown by the flight scene into its particle pool.)
//
//   createSeaFoam({ rings, collars })  → { object, ring(), beginCollars(), collar(), endCollars(), update(), setLight(), clear(), dispose() }
//
// Two kinds of flat patch lie on the sea, a few centimetres above it:
//   ring     where a craft struck the water: a churned white patch under it and a ring of foam that runs outward,
//            slows, breaks into streaks and dissolves over some seconds. It stays where it was made on the sea.
//   collar   the foam that washes round a floating hull at its waterline, for as long as it floats. One ellipse for
//            each part that sits in the surface, so a stage lying on its side gets a long patch and a capsule a round one.
//
// Renderer contract as in fx.js: log-depth, tone-mapping and colour-space chunks; colours are linear.
import * as THREE from '../lib/three.module.min.js';

const VS = `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vP;
void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const FS = `#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uLight;
uniform vec2 uMeters;      // the patch's half-size in metres along its two axes
uniform float uFront, uWidth, uCore, uCoreR, uAlpha, uBreak, uSeed, uTime, uCollar;
varying vec2 vP;
float sfHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float sfNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sfHash(i), sfHash(i + vec2(1.0, 0.0)), f.x), mix(sfHash(i + vec2(0.0, 1.0)), sfHash(i + vec2(1.0, 1.0)), f.x), f.y); }
float sfFbm(vec2 p){ return sfNoise(p) * 0.5 + sfNoise(p * 2.07 + 3.1) * 0.28 + sfNoise(p * 4.3 + 7.7) * 0.15 + sfNoise(p * 8.9 + 1.3) * 0.07; }
void main(){
  #include <logdepthbuf_fragment>
  float rho = length(vP);
  if (rho >= 1.0) discard;
  vec2 m = vP * uMeters;                              // metres from the middle
  vec2 dirv = rho > 1e-4 ? vP / rho : vec2(1.0, 0.0);
  // foam is made of cells: the same pattern in metres whatever the size of the patch. It stays on the water where
  // it was made (a ring does not carry its foam along, it leaves it behind)
  float n = sfFbm(m * 1.25 + uSeed * 17.0);
  float fine = sfFbm(m * 3.6 + uSeed * 5.0 + 11.0);
  float a;
  if (uCollar > 0.5) {
    // the hull's edge is at rho = 2/3: thickest against it, thinning raggedly to nothing before the rim
    float lap = 0.5 + 0.5 * sin(uTime * 1.7 + atan(vP.y, vP.x) * 3.0 + uSeed * 6.0);      // it laps unevenly round the hull
    float e = rho + (n - 0.5) * 0.16 - lap * 0.05;
    float band = smoothstep(0.40, 0.62, rho) * (1.0 - smoothstep(0.70, 0.90, e));
    a = band * (0.18 + 0.82 * smoothstep(0.36, 0.6, fine * 0.6 + n * 0.4));
  } else {
    float e = rho + (n - 0.5) * (0.05 + 0.10 * uBreak);                 // a ragged front, more so as it ages
    float inside = 1.0 - smoothstep(uFront - 0.015, uFront + 0.02, e);
    float rim = smoothstep(uFront - uWidth, uFront, e);                 // 0 well inside the ring, 1 at its front
    float core = uCore * (1.0 - smoothstep(uCoreR * 0.5, uCoreR, e));
    float dens = max(mix(0.46, 1.0, rim * rim), core);
    // dense foam is solid white; thin foam shows only its strongest cells, as lace. Age thins all of it.
    float th = mix(0.78, 0.10, dens) + 0.45 * uBreak;
    a = inside * smoothstep(th, th + 0.16, n * 0.68 + fine * 0.32) * (0.5 + 0.5 * dens);
  }
  a *= uAlpha * (1.0 - smoothstep(0.93, 1.0, rho));
  if (a <= 0.004) discard;
  vec3 col = vec3(0.90, 0.94, 0.96) * uLight * (0.86 + 0.14 * fine);
  gl_FragColor = vec4(col * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const Y = new THREE.Vector3(0, 1, 0);
const _x = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4();

/** How far the foam ring of an impact has run after `age` seconds (m from the middle). */
export function ringRadius(age, r0, reach, tau = 1.5) { return r0 + (reach - r0) * (1 - Math.exp(-Math.max(0, age) / tau)); }
/** Where a ring thrown by an impact at `speed` (m/s) on a hull of radius r0 comes to rest (m). */
export function ringReach(r0, speed) { return r0 + Math.min(10, Math.max(2, 0.85 * speed)); }
export const RING_LIFE = 11;     // s

export function createSeaFoam({ rings: nRings = 6, collars: nCollars = 10 } = {}) {
  const group = new THREE.Group(); group.name = 'seaFoam';
  const geo = new THREE.CircleGeometry(1, 56).rotateX(-Math.PI / 2);
  const light = new THREE.Vector3(1, 1, 1);
  function patch(collar) {
    const u = {
      uLight: { value: light }, uMeters: { value: new THREE.Vector2(1, 1) }, uFront: { value: 0.5 }, uWidth: { value: 0.1 }, uCore: { value: 0 }, uCoreR: { value: 0.2 },
      uAlpha: { value: 0 }, uBreak: { value: 0 }, uSeed: { value: Math.random() }, uTime: { value: 0 }, uCollar: { value: collar ? 1 : 0 },
    };
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: u, vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    }));
    mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = collar ? 3 : 2; mesh.castShadow = false; mesh.receiveShadow = false;
    group.add(mesh);
    return { mesh, u };
  }
  const rings = [], collars = [];
  for (let i = 0; i < nRings; i++) rings.push({ ...patch(false), live: false, age: 0, r0: 1, reach: 6, body: null, dir: new THREE.Vector3(), strength: 1 });
  for (let i = 0; i < nCollars; i++) collars.push(patch(true));
  let nextRing = 0, usedCollars = 0, clock = 0;

  /** Lay `mesh` flat on the sea at `pos` (scene coordinates), `up` the local vertical, `along` its long axis (level), half-sizes a and b in metres. */
  function lay(mesh, pos, up, along, a, b) {
    _x.copy(along).addScaledVector(up, -along.dot(up));
    if (_x.lengthSq() < 1e-8) { _x.set(up.y, up.z, up.x); _x.addScaledVector(up, -_x.dot(up)); }
    _x.normalize(); _z.crossVectors(_x, up).normalize();
    _m.makeBasis(_x, up, _z);
    mesh.quaternion.setFromRotationMatrix(_m);
    mesh.position.copy(pos);
    mesh.scale.set(a, 1, b);
  }

  return {
    object: group,
    rings, collars,
    /**
     * Start an impact ring.
     * @param body   the world it lies on
     * @param dir    unit vector to the place, in the world's own turning frame (it stays there as the world turns)
     * @param r0     m, radius of the hull where it met the water
     * @param speed  m/s, how fast it came down
     */
    ring(body, dir, r0, speed) {
      const r = rings[nextRing]; nextRing = (nextRing + 1) % rings.length;
      r.live = true; r.age = 0; r.body = body; r.dir.copy(dir); r.r0 = r0; r.reach = ringReach(r0, speed);
      r.strength = 0.85 * Math.min(1, Math.max(0.35, speed / 5));
      r.u.uSeed.value = Math.random();
      return r;
    },
    beginCollars() { usedCollars = 0; },
    /** One hull section in the surface this frame. Returns false when the pool is used up. */
    collar(pos, up, along, a, b, strength, seed) {
      if (usedCollars >= collars.length || !(strength > 0.01)) return false;
      const c = collars[usedCollars++];
      lay(c.mesh, pos, up, along, a * 1.5, b * 1.5);
      c.u.uMeters.value.set(a * 1.5, b * 1.5);
      c.u.uAlpha.value = 0.8 * Math.min(1, strength); c.u.uSeed.value = seed; c.u.uTime.value = clock;
      c.mesh.visible = true;
      return true;
    },
    endCollars() { for (let i = usedCollars; i < collars.length; i++) collars[i].mesh.visible = false; },
    /**
     * Age the rings and put them where their piece of sea is now.
     * @param dt       s of game time since the last call (0 while paused)
     * @param place    (body, dir, out) → out: scene position of the sea surface at that place, or null when it is not in this scene
     * @param upOf     (pos, out) → out: local vertical at a scene position
     */
    update(dt, place, upOf) {
      clock += Math.min(dt, 0.25);
      for (const r of rings) {
        if (!r.live) continue;
        r.age += dt;
        const pos = r.age < RING_LIFE ? place(r.body, r.dir, _x) : null;
        if (!pos) { r.live = false; r.mesh.visible = false; continue; }
        const size = r.reach * 1.06, f = r.age / RING_LIFE;
        const up = upOf(pos, _z);
        r.mesh.position.copy(pos); r.mesh.quaternion.setFromUnitVectors(Y, up); r.mesh.scale.set(size, 1, size);
        const R = ringRadius(r.age, r.r0, r.reach);
        r.u.uMeters.value.set(size, size);
        r.u.uFront.value = R / size;
        r.u.uWidth.value = Math.min(R, 0.7 + 0.25 * r.age) / size;                 // the band spreads as it slows
        r.u.uCoreR.value = Math.min(R, r.r0 * 2.2) / size;
        r.u.uCore.value = Math.max(0, 1 - r.age / 5.5);
        r.u.uBreak.value = Math.min(1, Math.pow(f, 0.7) * 1.15);
        r.u.uAlpha.value = r.strength * Math.min(1, r.age / 0.12) * (1 - f * f * (3 - 2 * f));
        r.u.uTime.value = clock;
        r.mesh.visible = true;
      }
    },
    /** Light falling on a level white surface (linear rgb; a THREE.Color or Vector3). */
    setLight(c) { light.set(c.r !== undefined ? c.r : c.x, c.g !== undefined ? c.g : c.y, c.b !== undefined ? c.b : c.z); },
    clear() { for (const r of rings) { r.live = false; r.mesh.visible = false; } for (const c of collars) c.mesh.visible = false; },
    dispose() { geo.dispose(); for (const p of [...rings, ...collars]) p.mesh.material.dispose(); },
  };
}
