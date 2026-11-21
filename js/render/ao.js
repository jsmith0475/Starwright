// Starwright — screen-space ambient occlusion for the post chain (js/render/post.js).
//
// Reads the scene target's depth texture and writes how open each pixel is (1 = open sky above it, lower = in a
// crease or beside something) into a half-resolution target, in two passes: the occlusion estimate, then a
// depth-aware blur that removes its per-pixel noise. The post chain multiplies the result into the picture.
// No second scene render, no normal buffer: the surface normal is rebuilt from neighbouring depths.
//
// The renderer uses a logarithmic depth buffer (docs/SECOND_PASS.md, renderer contract), so the distance of a
// depth sample d along the view axis is  exp2(d * log2(far + 1)) - 1  (three's logdepthbuf chunks, inverted).
//
//   const ao = createAO(pass)            pass(material, target): the post chain's full-screen draw
//   ao.setSize(w, h)                     size of the scene target; the occlusion target is half of it
//   ao.render(depthTexture, camera)      → ao.texture (red channel)
//   ao.params = { radius (m), intensity (m: the estimate is height over distance squared), maxDist (m), grow, growMax }
//   ao.dispose()
import * as THREE from '../lib/three.module.min.js';

const VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
export const AO_DEPTH_GLSL = `
uniform sampler2D tDepth; uniform float uLogK; uniform vec2 uP, uDepthSize;
// the depth texel that contains uv, fetched by index: a half-resolution pass sits exactly on the border between two
// depth texels, where a nearest-filter lookup picks either side by rounding and draws lines across the screen
float aoDepth(vec2 uv){ return texelFetch(tDepth, clamp(ivec2(uv * uDepthSize), ivec2(0), ivec2(uDepthSize) - 1), 0).x; }
// the centre of the depth texel that contains uv: positions are rebuilt from the same point the depth was read at
vec2 aoSnap(vec2 uv){ return (floor(uv * uDepthSize) + 0.5) / uDepthSize; }
float aoViewZ(vec2 uv){ return exp2(aoDepth(uv) * uLogK) - 1.0; }
vec3 aoViewPos(vec2 uv, float z){ return vec3((uv * 2.0 - 1.0) * z / uP, -z); }
`;
const AO_FS = `${AO_DEPTH_GLSL}
uniform vec2 uTexel, uGrow; uniform float uRadius, uIntensity, uMaxDist;
varying vec2 vUv;
// interleaved gradient noise: a different rotation of the sample pattern at every pixel, which the blur averages out
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main(){
  // (a quarter texel back from the border this half-resolution pixel sits on, so the choice of side is never a rounding matter)
  vec2 c = aoSnap(vUv - 0.25 / uDepthSize);
  float d = aoDepth(c);
  gl_FragColor = vec4(1.0);
  if (d >= 0.99999) return;                           // nothing drawn here: sky, stars
  float z = exp2(d * uLogK) - 1.0;
  if (z > uMaxDist) return;
  vec3 p = aoViewPos(c, z);
  // normal from the nearer neighbour on each axis, so an edge does not bend it
  vec2 ex = vec2(uTexel.x, 0.0), ey = vec2(0.0, uTexel.y);
  vec3 pr = aoViewPos(c + ex, aoViewZ(c + ex)), pl = aoViewPos(c - ex, aoViewZ(c - ex));
  vec3 pu = aoViewPos(c + ey, aoViewZ(c + ey)), pd = aoViewPos(c - ey, aoViewZ(c - ey));
  // a one-pixel pit (a hairline gap between two terrain chunks, seen through to their skirts) has no usable normal
  float pit = 0.02 * z + 0.02;
  if (z - max(-pl.z, -pr.z) > pit || z - max(-pu.z, -pd.z) > pit) return;
  vec3 dx = abs(pr.z - p.z) < abs(p.z - pl.z) ? pr - p : p - pl;
  vec3 dy = abs(pu.z - p.z) < abs(p.z - pd.z) ? pu - p : p - pd;
  vec3 n = normalize(cross(dx, dy));
  // the radius grows gently with distance: creases near the camera, the shade under structures farther off
  float radius = uRadius * (1.0 + min(z * uGrow.x, uGrow.y));
  vec2 rUv = radius * uP * 0.5 / z;
  rUv *= min(1.0, 0.1 / max(rUv.x, rUv.y));           // never sample across more than a tenth of the screen
  if (rUv.y < uTexel.y * 1.5) return;                 // the whole radius is inside one pixel
  float a0 = ign(gl_FragCoord.xy) * 6.2831853, occ = 0.0, hBias = 0.03 + 0.002 * z;
  for (int i = 0; i < 12; i++) {
    float t = (float(i) + 0.5) / 12.0, a = a0 + float(i) * 2.3999632;
    vec2 uv = aoSnap(c + vec2(cos(a), sin(a)) * sqrt(t) * rUv);
    vec3 v = aoViewPos(uv, aoViewZ(uv)) - p;
    float l = length(v);
    // how far the neighbour stands above the surface's own plane, over its distance squared: something close shades
    // more than something far (a pebble shades the ground it sits on, a wall shades a metre of floor). The height
    // has a floor of a few centimetres, growing with distance, so that depth rounding, the rebuilt normal's error
    // and the centimetre steps between terrain detail levels never count as occluders.
    occ += max(0.0, dot(v, n) - hBias) / (l * l + 0.02) * (1.0 - smoothstep(radius * 0.5, radius, l));
  }
  float ao = clamp(1.0 - uIntensity * occ / 12.0, 0.0, 1.0);
  ao = mix(ao, 1.0, smoothstep(uMaxDist * 0.6, uMaxDist, z));
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}`;
const BLUR_FS = `${AO_DEPTH_GLSL}
uniform sampler2D tSrc; uniform vec2 uSrcTexel;
varying vec2 vUv;
void main(){
  vec2 q = 0.25 / uDepthSize;
  float z = aoViewZ(vUv - q), sum = 0.0, wsum = 0.0, tol = 0.04 * z + 0.05;
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    vec2 uv = vUv + (vec2(float(x), float(y)) - 1.5) * uSrcTexel;
    float w = max(0.0, 1.0 - abs(aoViewZ(uv - q) - z) / tol) + 1e-3;
    sum += texture2D(tSrc, uv).r * w; wsum += w;
  }
  float ao = sum / wsum;
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}`;

export function createAO(pass) {
  // grow, growMax: the radius grows by `grow` of itself per metre of distance, up to (1 + growMax) times: 3 keeps it to
  // creases and contact (flight); a view that looks at buildings from a kilometre away wants far more
  const params = { radius: 1.0, intensity: 2.5, maxDist: 400, grow: 0.03, growMax: 3 };
  const opts = { depthTest: false, depthWrite: false, toneMapped: false, vertexShader: VS };
  const depthU = () => ({ tDepth: { value: null }, uLogK: { value: 31 }, uP: { value: new THREE.Vector2(1, 1) }, uDepthSize: { value: new THREE.Vector2(1, 1) } });
  const aoMat = new THREE.ShaderMaterial({ ...opts, fragmentShader: AO_FS, uniforms: { ...depthU(), uTexel: { value: new THREE.Vector2() }, uGrow: { value: new THREE.Vector2(0.03, 3) }, uRadius: { value: 1.0 }, uIntensity: { value: 2.5 }, uMaxDist: { value: 400 } } });
  const blurMat = new THREE.ShaderMaterial({ ...opts, fragmentShader: BLUR_FS, uniforms: { ...depthU(), tSrc: { value: null }, uSrcTexel: { value: new THREE.Vector2() } } });
  let raw = null, out = null, W = 0, H = 0;
  function free() { if (raw) raw.dispose(); if (out) out.dispose(); raw = out = null; }
  const mk = (w, h, name) => { const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }); rt.texture.name = name; rt.texture.generateMipmaps = false; return rt; };
  return {
    params,
    get texture() { return out ? out.texture : null; },    setSize(w, h) {
      const hw = Math.max(2, Math.ceil(w / 2)), hh = Math.max(2, Math.ceil(h / 2));
      if (raw && raw.width === hw && raw.height === hh) return;
      free(); W = w; H = h;
      raw = mk(hw, hh, 'flight.ao.raw'); out = mk(hw, hh, 'flight.ao');
    },
    render(depthTexture, camera) {
      if (!raw || !depthTexture) return;
      const e = camera.projectionMatrix.elements, logK = Math.log2(camera.far + 1);
      for (const m of [aoMat, blurMat]) { const u = m.uniforms; u.tDepth.value = depthTexture; u.uLogK.value = logK; u.uP.value.set(e[0], e[5]); u.uDepthSize.value.set(W, H); }
      const u = aoMat.uniforms;
      u.uTexel.value.set(1 / W, 1 / H); u.uGrow.value.set(params.grow, params.growMax); u.uRadius.value = params.radius; u.uIntensity.value = params.intensity; u.uMaxDist.value = params.maxDist;
      pass(aoMat, raw);
      blurMat.uniforms.tSrc.value = raw.texture; blurMat.uniforms.uSrcTexel.value.set(1 / raw.width, 1 / raw.height);
      pass(blurMat, out);
    },
    dispose() { free(); aoMat.dispose(); blurMat.dispose(); },
  };
}
