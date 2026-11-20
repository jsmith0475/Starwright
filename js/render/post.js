// Starwright — small post-processing chain for the flight screen.
//
// The scene is drawn into a linear HDR target (multisampled), a soft bloom is built from a down/up-sample
// pyramid, and one composite pass adds bloom, gentle lens effects (sun ghosts, vignette, grain) and then applies
// the renderer's tone mapping and output colour space with three's own shader chunks, so the result follows the
// renderer contract (ACES filmic, sRGB) exactly.
//
//   const post = createPostChain(renderer)
//   post.supported                       false → HDR targets are unavailable; draw straight to the canvas instead
//   post.setSize(w, h, pixelRatio)
//   post.begin()                         → the scene target (render the scenes into it)
//   post.end({ sunUv, sunVisible })      bloom + composite to the canvas
//   post.params = { bloom 0..1.5, lens 0..1, vignette 0..1, grain 0..1, exposure }
//   post.dispose()
import * as THREE from '../lib/three.module.min.js';

const VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const DOWN_FS = `uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold; varying vec2 vUv;
vec3 pre(vec3 c){ if (uThreshold <= 0.0) return c; float l = max(c.r, max(c.g, c.b)); float k = max(l - uThreshold, 0.0); k = k * k / (k + 0.6); return min(c * (k / max(l, 1e-4)), vec3(24.0)); }
void main(){
  vec3 a = pre(texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb), b = pre(texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb);
  vec3 c = pre(texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb), d = pre(texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb);
  vec3 e = pre(texture2D(tSrc, vUv).rgb);
  gl_FragColor = vec4((a + b + c + d) * 0.2 + e * 0.2, 1.0);
}`;
const UP_FS = `uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uGain; varying vec2 vUv;
void main(){
  vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
  s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb * 2.0 + texture2D(tSrc, vUv + uTexel * vec2(1.0, 0.0)).rgb * 2.0;
  s += texture2D(tSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb * 2.0 + texture2D(tSrc, vUv + uTexel * vec2(0.0, 1.0)).rgb * 2.0;
  s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(s * (uGain / 16.0), 1.0);
}`;
const FINAL_FS = `#include <common>
uniform sampler2D tScene, tBloom; uniform float uBloom, uLens, uVignette, uGrain, uTime, uExposure, uAspect, uSunVis; uniform vec2 uSun;
varying vec2 vUv;
float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
vec3 ghost(vec2 uv, vec2 c, float r, vec3 tint){ vec2 d = (uv - c) * vec2(uAspect, 1.0); float l = length(d) / r; return tint * smoothstep(1.0, 0.82, l) * (0.35 + 0.65 * smoothstep(0.3, 1.0, l)); }
void main(){
  vec3 col = texture2D(tScene, vUv).rgb;
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  col += bloom * uBloom;
  if (uLens > 0.0 && uSunVis > 0.0) {
    // is the sun's disc actually on screen and uncovered? (the disc is by far the brightest thing there)
    vec3 s = texture2D(tScene, uSun).rgb + texture2D(tScene, uSun + vec2(0.004, 0.0)).rgb + texture2D(tScene, uSun - vec2(0.004, 0.0)).rgb + texture2D(tScene, uSun + vec2(0.0, 0.006)).rgb + texture2D(tScene, uSun - vec2(0.0, 0.006)).rgb;
    float vis = smoothstep(2.0, 9.0, max(s.r, max(s.g, s.b)) ) * uSunVis * uLens;
    vec2 axis = vec2(0.5) - uSun;
    vec3 f = ghost(vUv, uSun + axis * 0.6, 0.035, vec3(0.5, 0.8, 1.0)) * 0.05;
    f += ghost(vUv, uSun + axis * 1.35, 0.075, vec3(1.0, 0.75, 0.45)) * 0.035;
    f += ghost(vUv, uSun + axis * 1.75, 0.03, vec3(0.6, 1.0, 0.8)) * 0.05;
    f += ghost(vUv, uSun + axis * 2.3, 0.14, vec3(0.7, 0.6, 1.0)) * 0.022;
    // a thin horizontal streak through the sun
    vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);
    f += vec3(1.0, 0.85, 0.7) * exp(-abs(d.y) * 260.0) * exp(-abs(d.x) * 3.2) * 0.22;
    col += f * vis;
  }
  col *= uExposure;
  vec2 q = vUv - 0.5;
  col *= 1.0 - uVignette * smoothstep(0.35, 0.95, length(q * vec2(1.0, 0.9)) * 1.25);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb += (hash(vUv * 917.0 + uTime) - 0.5) * 0.022 * uGrain;
}`;

export function createPostChain(renderer) {
  const gl = renderer.getContext();
  const supported = !!(renderer.capabilities.isWebGL2 !== false && (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')));
  const params = { bloom: 0.7, lens: 1, vignette: 0.28, grain: 0.6, exposure: 1 };
  const LEVELS = 5;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const qscene = new THREE.Scene(); qscene.add(quad);
  const opts = { depthTest: false, depthWrite: false, toneMapped: false };
  const down = new THREE.ShaderMaterial({ ...opts, uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0 } }, vertexShader: VS, fragmentShader: DOWN_FS });
  const up = new THREE.ShaderMaterial({ ...opts, uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uGain: { value: 1 } }, vertexShader: VS, fragmentShader: UP_FS, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor });
  const fin = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, toneMapped: true, vertexShader: VS, fragmentShader: FINAL_FS,
    uniforms: { tScene: { value: null }, tBloom: { value: null }, uBloom: { value: 0.7 }, uLens: { value: 1 }, uVignette: { value: 0.28 }, uGrain: { value: 0.6 }, uTime: { value: 0 }, uExposure: { value: 1 }, uAspect: { value: 1.6 }, uSunVis: { value: 0 }, uSun: { value: new THREE.Vector2(0.5, 0.5) } },
  });
  let sceneRT = null, mips = [], W = 0, H = 0, samples = 4, clock = 0;
  const size = new THREE.Vector2();

  function build(w, h) {
    dispose(false);
    W = w; H = h;
    sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, samples, depthBuffer: true, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    sceneRT.texture.name = 'flight.scene'; sceneRT.texture.generateMipmaps = false;
    let mw = w, mh = h;
    for (let i = 0; i < LEVELS; i++) {
      mw = Math.max(2, Math.round(mw / 2)); mh = Math.max(2, Math.round(mh / 2));
      const rt = new THREE.WebGLRenderTarget(mw, mh, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      rt.texture.generateMipmaps = false;
      mips.push(rt);
    }
  }
  function pass(mat, target) { quad.material = mat; renderer.setRenderTarget(target); renderer.render(qscene, cam); }
  function dispose(all = true) {
    if (sceneRT) sceneRT.dispose();
    for (const m of mips) m.dispose();
    sceneRT = null; mips = [];
    if (all) { down.dispose(); up.dispose(); fin.dispose(); quad.geometry.dispose(); }
  }

  return {
    supported, params,
    get target() { return sceneRT; },
    /** MSAA sample count of the scene target (0 turns it off). */
    setSamples(n) { if (n !== samples) { samples = n; if (W) build(W, H); } },
    setSize(w, h, pr = 1) {
      const pw = Math.max(2, Math.round(w * pr)), ph = Math.max(2, Math.round(h * pr));
      if (pw !== W || ph !== H || !sceneRT) build(pw, ph);
    },
    begin() {
      if (!sceneRT) { renderer.getDrawingBufferSize(size); build(size.x, size.y); }
      renderer.setRenderTarget(sceneRT);
      return sceneRT;
    },
    end({ sunUv = null, sunVisible = 0, dt = 1 / 60 } = {}) {
      clock = (clock + dt) % 100;
      const prevAuto = renderer.autoClear;
      renderer.autoClear = false;
      const bloomOn = params.bloom > 0.01;
      if (bloomOn) {
        // bright-pass + downsample pyramid
        let src = sceneRT;
        for (let i = 0; i < mips.length; i++) {
          down.uniforms.tSrc.value = src.texture;
          down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
          down.uniforms.uThreshold.value = i === 0 ? 1.0 : 0;
          pass(down, mips[i]);
          src = mips[i];
        }
        // upsample, accumulating into the larger levels
        for (let i = mips.length - 1; i > 0; i--) {
          up.uniforms.tSrc.value = mips[i].texture;
          up.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
          up.uniforms.uGain.value = 0.85;
          pass(up, mips[i - 1]);
        }
      }
      const u = fin.uniforms;
      u.tScene.value = sceneRT.texture; u.tBloom.value = mips[0].texture;
      u.uBloom.value = bloomOn ? params.bloom * 0.55 : 0; u.uLens.value = params.lens; u.uVignette.value = params.vignette * (params.lens > 0 ? 1 : 0.4); u.uGrain.value = params.lens > 0 ? params.grain : 0;
      u.uTime.value = clock; u.uExposure.value = params.exposure; u.uAspect.value = W / Math.max(1, H);
      u.uSunVis.value = sunUv ? sunVisible : 0; if (sunUv) u.uSun.value.copy(sunUv);
      pass(fin, null);
      renderer.autoClear = prevAuto;
    },
    dispose,
  };
}
