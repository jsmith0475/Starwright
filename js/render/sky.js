// Starwright — the night sky: a few thousand point stars with a believable spread of brightness and colour, on top
// of a procedural backdrop (galactic band with dust lanes, faint nebulae, unresolved star dust) drawn on one
// camera-centred sphere. Cheap: two draw calls, no textures.
import * as THREE from '../lib/three.module.min.js';

function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// colour of a star by "temperature class" 0 (cool red) … 1 (hot blue), roughly a black-body ramp
function starTint(t, out) {
  const stops = [[1.0, 0.62, 0.42], [1.0, 0.80, 0.62], [1.0, 0.94, 0.86], [0.96, 0.97, 1.0], [0.78, 0.86, 1.0], [0.64, 0.76, 1.0]];
  const f = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1), i = Math.floor(f), k = f - i;
  for (let c = 0; c < 3; c++) out[c] = stops[i][c] * (1 - k) + stops[i + 1][c] * k;
  return out;
}

const GALAXY_TILT = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.05, 0.4, 0.3));

const BACK_VS = `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
#include <logdepthbuf_vertex>
}`;
const BACK_FS = `#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uOpacity; uniform mat3 uGal;
varying vec3 vDir;
float h3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z); }
const mat3 ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
float fbm(vec3 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * n3(p); p = ROT * p * 2.03 + 11.7; a *= 0.5; } return s; }
void main(){
#include <logdepthbuf_fragment>
  vec3 d = normalize(vDir);
  vec3 g = uGal * d;                               // galactic frame: the band lies around g.y = 0
  float lat = g.y;
  float lon = atan(g.z, g.x);
  // the band: brightest toward the galactic centre (lon = 0), broken by dust lanes
  float core = exp(-(lon * lon) / 0.81);
  float width = 0.11 + 0.10 * core;
  float band = exp(-(lat * lat) / (width * width)) * (0.35 + 0.65 * core) + 0.12 * exp(-(lat * lat) / 0.1225);
  float clouds = fbm(g * 3.2 + 2.0);
  float lanes = smoothstep(0.42, 0.62, fbm(g * vec3(5.0, 14.0, 5.0) + 7.0)) * exp(-(lat * lat) / 0.0081);
  band *= (0.45 + 1.1 * clouds) * (1.0 - 0.8 * lanes);
  vec3 col = mix(vec3(0.55, 0.62, 0.85), vec3(1.0, 0.86, 0.68), core * 0.8) * band * 0.085;
  // unresolved stars: fine sparkle that thickens in the band
  // (kept fine and faint: at a coarser grain it reads as smudges on the lens, not as stars)
  float sp = n3(d * 560.0) * n3(d * 233.0 + 5.0);
  col += vec3(0.8, 0.86, 1.0) * smoothstep(0.55, 0.92, sp) * (0.005 + 0.2 * band);
  // nebulae: three faint patches of colour
  float n1 = smoothstep(0.80, 1.0, dot(d, normalize(vec3(0.35, 0.5, -0.79)))) * fbm(d * 7.0 + 3.0);
  float n2 = smoothstep(0.88, 1.0, dot(d, normalize(vec3(-0.7, -0.25, 0.66)))) * fbm(d * 9.0 + 9.0);
  float n4 = smoothstep(0.92, 1.0, dot(d, normalize(vec3(0.1, -0.85, -0.5)))) * fbm(d * 11.0 + 1.0);
  col += vec3(0.75, 0.16, 0.32) * n1 * n1 * 0.22 + vec3(0.12, 0.45, 0.60) * n2 * n2 * 0.30 + vec3(0.45, 0.25, 0.75) * n4 * n4 * 0.28;
  col *= uOpacity;
  gl_FragColor = vec4(col, 1.0);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`;

/**
 * Stars on a unit sphere (THE CALLER scales it and keeps it centred on the camera). Deterministic.
 * Returns a THREE.Points whose child mesh paints the galactic band and nebulae.
 * points.userData.setOpacity(0..1) fades the whole sky (daylight).
 */
export function createStarfield(count = 4000) {
  const rnd = mulberry(20240611), bandN = Math.floor(count * 0.6), total = count + bandN;
  const pos = new Float32Array(total * 3), col = new Float32Array(total * 3), size = new Float32Array(total);
  const v = new THREE.Vector3(), tint = [0, 0, 0];
  for (let i = 0; i < total; i++) {
    if (i < count) { const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z); v.set(s * Math.cos(a), z, s * Math.sin(a)); }
    else {
      // extra stars crowd toward the galactic plane and its centre
      const a = (rnd() + rnd() + rnd() - 1.5) * 2.2, lat = (rnd() + rnd() + rnd() - 1.5) * 0.2;
      v.set(Math.cos(a) * Math.cos(lat), Math.sin(lat), Math.sin(a) * Math.cos(lat)).applyQuaternion(GALAXY_TILT);
    }
    pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
    // magnitudes: a steep power law, so a handful of brilliant stars and a host of faint ones
    const m = Math.pow(rnd(), i < count ? 7 : 11);
    const bright = 0.10 + 1.5 * m;
    // most stars are warm; the brightest are often hot blue-white, a few are red giants
    let t = 0.2 + 0.5 * rnd() + 0.3 * m;
    if (rnd() < 0.08) t = 0.02 + 0.1 * rnd();
    starTint(t, tint);
    col[i * 3] = tint[0] * bright; col[i * 3 + 1] = tint[1] * bright; col[i * 3 + 2] = tint[2] * bright;
    size[i] = 1.1 + 2.3 * Math.sqrt(m);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3)); geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: 1 }, uOpacity: { value: 1 } },
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float aSize; attribute vec3 aColor; uniform float uPixelRatio; varying vec3 vC;
      void main(){
        vC = aColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uPixelRatio;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uOpacity; varying vec3 vC;
      void main(){
        #include <logdepthbuf_fragment>
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = (exp(-d * d * 5.0) - 0.0067) * uOpacity;
        gl_FragColor = vec4(vC * max(a, 0.0), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    // kept in the OPAQUE pass and drawn first, so everything else paints over the stars
    transparent: false, depthWrite: false, depthTest: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const points = new THREE.Points(geo, mat); points.name = 'starfield'; points.frustumCulled = false; points.renderOrder = -10;
  points.onBeforeRender = (renderer) => { mat.uniforms.uPixelRatio.value = renderer.getPixelRatio(); };

  const gal = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(GALAXY_TILT.clone().invert()));
  const backMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 1 }, uGal: { value: gal } }, vertexShader: BACK_VS, fragmentShader: BACK_FS,
    side: THREE.BackSide, transparent: false, depthWrite: false, depthTest: false,
  });
  const back = new THREE.Mesh(new THREE.SphereGeometry(0.98, 32, 16), backMat);
  back.renderOrder = -11; back.frustumCulled = false; back.name = 'galacticBand';
  points.add(back);

  // The backdrop is procedural noise: fine for one frame, wasteful for every frame. Bake it once into a cube map
  // (1024² per face) and draw that instead. Without a bake the procedural shader simply keeps running.
  let cubeRT = null, cubeMat = null, baked = false, scheduled = false;
  function bake(renderer) {
    if (baked || !renderer) return;
    baked = true;
    try {
      const half = renderer.extensions.has('EXT_color_buffer_half_float') || renderer.extensions.has('EXT_color_buffer_float');
      cubeRT = new THREE.WebGLCubeRenderTarget(1024, { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      const sc = new THREE.Scene(), cc = new THREE.CubeCamera(0.1, 10, cubeRT);
      const src = new THREE.Mesh(back.geometry, backMat);
      const keep = backMat.uniforms.uOpacity.value; backMat.uniforms.uOpacity.value = 1;
      sc.add(src);
      const prevRT = renderer.getRenderTarget(), prevXr = renderer.xr.enabled;
      renderer.xr.enabled = false;
      cc.update(renderer, sc);
      renderer.xr.enabled = prevXr; renderer.setRenderTarget(prevRT);
      backMat.uniforms.uOpacity.value = keep;
      cubeMat = new THREE.ShaderMaterial({
        uniforms: { uOpacity: backMat.uniforms.uOpacity, uCube: { value: cubeRT.texture } },
        vertexShader: BACK_VS,
        fragmentShader: `#include <common>
          #include <logdepthbuf_pars_fragment>
          uniform samplerCube uCube; uniform float uOpacity; varying vec3 vDir;
          void main(){
            #include <logdepthbuf_fragment>
            gl_FragColor = vec4(textureCube(uCube, normalize(vDir)).rgb * uOpacity, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
        side: THREE.BackSide, transparent: false, depthWrite: false, depthTest: false,
      });
      back.material = cubeMat;
    } catch (err) { console.warn('[sky] backdrop bake unavailable:', err && err.message); }
  }
  // callers that never hand over a renderer still get the bake, one tick after the first draw
  back.onBeforeRender = (renderer) => { if (!baked && !scheduled) { scheduled = true; setTimeout(() => bake(renderer), 0); } };
  points.userData.bake = bake;
  points.userData.setOpacity = (o) => { mat.uniforms.uOpacity.value = o; backMat.uniforms.uOpacity.value = o; points.visible = o > 0.003; };
  points.userData.dispose = () => { geo.dispose(); mat.dispose(); back.geometry.dispose(); backMat.dispose(); if (cubeMat) cubeMat.dispose(); if (cubeRT) cubeRT.dispose(); };
  return points;
}
