// Starwright — the live 3D view of the Flight Center shared by the hub and the title screen.
//
//   const view = getBaseView(app)            one instance per app (built on first use, then kept)
//   view.buildings                           [{ id, name, blurb, object3d, focus, radius, pick }] from createBase
//   view.setTime(ut) / view.setTimeOfDay(f)  game time drives the sun; setTimeOfDay(0..1 | null) overrides it (0.5 = noon)
//   view.orbit(dx, dy) / pan(dx, dy) / zoom(factor) / move(right, forward, dt) / turn(d)     camera input, in pixels / factors
//   view.flyTo(id | { target, az, el, dist }, { dist, snap })   glide the camera to a building or a pose
//   view.home(snap)                          the default overview
//   view.pick(x, y) → building id | null     x, y in CSS pixels of the canvas
//   view.project(vec3, out) → { x, y, visible }   CSS pixels
//   view.update(dt, { drift })               advance the camera, sky and base animation
//   view.render(highlightId)                 draw (with an outline + glow on one building, if given)
//   view.resize(w, h)
//   view.begin() / view.release()            a screen starts / stops showing the view (render resolution is adaptive)
//   view.lockQuality(0..3 | null), view.freeze(bool)   for previews and tests
//   view.pose                                { target: Vector3, az, el, dist } (current, read-only)
import * as THREE from '../lib/three.module.min.js';
import { createBase, baseMaterials, BASE_LAYOUT } from '../render/basegfx.js';
import { createLocalGround, createSkyRig, skyAt } from '../render/baseenv.js';
import { VERDA_DAY } from './dom.js';
import { createPostChain } from '../render/post.js';

const clamp = THREE.MathUtils.clamp;
const HOME = { target: new THREE.Vector3(10, 0, 430), az: -0.74, el: 0.235, dist: 1650 };
const LIMITS = { elMin: 0.06, elMax: 1.44, distMin: 80, distMax: 3200, heightMax: 1800 };

const OUT_VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const OUT_FS = `uniform sampler2D tMask; uniform vec2 uTexel; uniform vec3 uColor; uniform float uTime;
varying vec2 vUv;
void main(){
  float c = texture2D(tMask, vUv).r, mx = 0.0, sum = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5236; vec2 d = vec2(cos(a), sin(a)) * uTexel;
    float t1 = texture2D(tMask, vUv + d * 1.6).r, t2 = texture2D(tMask, vUv + d * 5.5).r;
    mx = max(mx, t1); sum += t1 + t2;
  }
  float edge = clamp(mx - c, 0.0, 1.0), halo = (sum / 24.0) * (1.0 - c), fill = c * (0.085 + 0.045 * sin(uTime * 3.2));
  float k = edge * 1.0 + halo * 0.7 + fill;
  if (k < 0.004) discard;
  gl_FragColor = vec4(uColor * k, 1.0);
}`;

let instance = null;
const SKIP_LIT = { slab: 1, pool: 1, beam: 1 };     // paving and light effects are not part of a building's outline

export function getBaseView(app) {
  if (instance) return instance;
  const renderer = app.renderer;
  if (!renderer) return null;
  const low = !!app.lowGraphics;
  const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0xa9c8e2, 0.00015);
  const camera = new THREE.PerspectiveCamera(38, app.size.w / Math.max(1, app.size.h), 2, 90000);
  const base = createBase({ quality: low ? 'low' : 'high', interactive: true });
  const ground = createLocalGround({ quality: low ? 'low' : 'high' });
  const rig = createSkyRig({ quality: low ? 'low' : 'high' });
  scene.add(ground.group, base.group, rig.group);
  if (base.pavedMask && ground.setPaved) ground.setPaved(base.pavedMask);
  const byId = Object.fromEntries(base.buildings.map(b => [b.id, b]));
  const pickRoots = base.buildings.map(b => b.pick);
  const BM = baseMaterials(), glossy = [BM.glass, BM.metal, BM.smooth, BM.car, ...ground.glossy];

  // camera pose: current values glide toward the goal
  const cur = { target: HOME.target.clone(), az: HOME.az, el: HOME.el, dist: HOME.dist };
  const goal = { target: HOME.target.clone(), az: HOME.az, el: HOME.el, dist: HOME.dist };
  let rate = 9, idle = 0, clock = 0, ut = 0, todOverride = null, sky = skyAt(0);
  const B = BASE_LAYOUT.bounds;
  function limit() {
    goal.el = clamp(goal.el, LIMITS.elMin, LIMITS.elMax);
    goal.dist = clamp(goal.dist, LIMITS.distMin, Math.min(LIMITS.distMax, LIMITS.heightMax / Math.sin(goal.el)));
    goal.target.x = clamp(goal.target.x, B[0], B[2]); goal.target.z = clamp(goal.target.z, B[1], B[3]); goal.target.y = clamp(goal.target.y, 0, 60);
  }
  function place() {
    const ce = Math.cos(cur.el);
    camera.position.set(cur.target.x + cur.dist * ce * Math.sin(cur.az), cur.target.y + cur.dist * Math.sin(cur.el), cur.target.z + cur.dist * ce * Math.cos(cur.az));
    if (camera.position.y < 4) camera.position.y = 4;
    camera.lookAt(cur.target);
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();   // project() must not lag a frame behind the camera
  }
  const touch = () => { idle = 0; rate = 12; };

  // highlight: silhouette mask → outline + glow composite
  const maskRT = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: true });
  const maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, side: THREE.DoubleSide });
  const outMat = new THREE.ShaderMaterial({ uniforms: { tMask: { value: maskRT.texture }, uTexel: { value: new THREE.Vector2() }, uColor: { value: new THREE.Color(0.32, 1.0, 0.92) }, uTime: { value: 0 } },
    vertexShader: OUT_VS, fragmentShader: OUT_FS, depthTest: false, depthWrite: false, transparent: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, toneMapped: false });
  const outScene = new THREE.Scene(), outCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), outMat); quad.frustumCulled = false; outScene.add(quad);
  let litId = null;
  function setLit(id) {
    if (id === litId) return;
    if (litId && byId[litId]) byId[litId].object3d.traverse(o => o.layers.disable(1));
    litId = id && byId[id] ? id : null;
    if (litId) byId[litId].object3d.traverse(o => { if (!SKIP_LIT[o.name]) o.layers.enable(1); });
  }
  const _size = new THREE.Vector2(), _clear = new THREE.Color();
  // ambient occlusion at this view's two best quality steps: the scene is drawn through the flight screen's post chain
  // (js/render/post.js, display mode: the picture is otherwise unchanged). Made on first use; null when it cannot be had.
  let post = null, postTried = false;
  function postChain() {
    if (!postTried) {
      postTried = true;
      try {
        post = createPostChain(renderer, { display: true });
        if (!post.supported) { post.dispose(); post = null; }
        else { post.params.ao = 1; post.setAO(true); }
      } catch (err) { console.warn('[base] ambient occlusion unavailable:', err && err.message); post = null; }
    }
    return post;
  }

  // Quality governor: the view holds 60 fps on a laptop GPU at full quality. If frames come slowly (a weak GPU, or
  // the software rasteriser the automated tests run on) it lowers the render resolution and drops the shadow pass;
  // it climbs back when frames are fast again. lockQuality(n) pins a level (the preview script pins 0).
  const LEVELS = [{ pr: 1, shadows: true, detail: 0 }, { pr: 0.7, shadows: true, detail: 0 }, { pr: 0.5, shadows: false, detail: 1 }, { pr: 0.34, shadows: false, detail: 2 }];     // detail: vegetation levels dropped (js/render/flora.js)
  const nativeRatio = () => (typeof app.pixelRatio === 'function' ? app.pixelRatio(app.size.w, app.size.h) : Math.min(window.devicePixelRatio || 1, 2));
  let level = 0, locked = false, lastFrame = 0, slow = 0, fast = 0, warm = 0, frozen = false, frameCount = 0, active = false, software = false, pending = false, holdUntil = 0;
  try {
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext && /swiftshader|llvmpipe|software|basic render/i.test(String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)))) { level = LEVELS.length - 1; software = true; }
  } catch { /* stay at full quality */ }
  // (software rendering only) objects still waiting to be shown; see render()
  const reveal = [];
  if (software) for (const g of [ground.group, base.group]) g.traverse(o => { if ((o.isMesh || o.isPoints) && o.visible && !o.userData.building) { o.visible = false; reveal.unshift(o); } });
  function applyLevel() {
    const L = LEVELS[level];
    renderer.setPixelRatio(nativeRatio() * L.pr); renderer.setSize(app.size.w, app.size.h, false);
    rig.sun.castShadow = L.shadows;
  }
  // The cost of a frame is measured from one render() to the next animation frame: a slow GPU (or a software
  // rasteriser) holds the next frame back. When a frame costs more than ~90 ms the view also rests between frames
  // (holdUntil), so the game loop, the keyboard and the DOM stay responsive while the picture updates more slowly.
  function govern(now) {
    if (!pending) return;
    const dt = now - lastFrame; pending = false;
    if (document.hidden || dt > 6000) return;
    holdUntil = dt > 90 ? now + Math.min(1200, dt * 1.6) : 0;
    if (locked || ++warm < 4) return;
    if (dt > 55) { fast = 0; slow += dt > 400 ? 4 : dt > 140 ? 2 : 1; if (slow >= 4 && level < LEVELS.length - 1) { level = Math.min(LEVELS.length - 1, level + (dt > 400 ? 2 : 1)); slow = 0; warm = 0; applyLevel(); } }
    else { slow = Math.max(0, slow - 0.25); if (dt < 21) { if (++fast > 150 && level > 0 && !software) { level--; fast = 0; warm = 0; applyLevel(); } } else fast = 0; }
  }

  const shownVP = new THREE.Matrix4(); let shown = false;
  const raycaster = new THREE.Raycaster(), _ndc = new THREE.Vector2(), _p = new THREE.Vector3();
  const view = {
    scene, camera, base, rig, ground, buildings: base.buildings, byId,
    get pose() { return cur; },
    get goal() { return goal; },
    get sky() { return sky; },
    get litId() { return litId; },
    setTime(t) { ut = Number.isFinite(t) ? t : 0; },
    setTimeOfDay(f) { todOverride = f == null ? null : ((f % 1) + 1) % 1; },
    orbit(dx, dy) { goal.az -= dx * 0.0052; goal.el += dy * 0.0042; touch(); limit(); },
    pan(dx, dy) {
      const k = (cur.dist * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(1, app.size.h);
      const rx = Math.cos(cur.az), rz = -Math.sin(cur.az), fx = -Math.sin(cur.az), fz = -Math.cos(cur.az), s = 1 / Math.max(0.35, Math.sin(cur.el));
      goal.target.x += (-rx * dx + fx * dy * s) * k; goal.target.z += (-rz * dx + fz * dy * s) * k; touch(); limit();
    },
    move(right, forward, dt) {
      const sp = cur.dist * 0.85 * dt, rx = Math.cos(cur.az), rz = -Math.sin(cur.az), fx = -Math.sin(cur.az), fz = -Math.cos(cur.az);
      goal.target.x += (rx * right + fx * forward) * sp; goal.target.z += (rz * right + fz * forward) * sp; touch(); limit();
    },
    turn(d) { goal.az += d; touch(); limit(); },
    zoom(factor) { goal.dist /= factor; touch(); limit(); },
    flyTo(to, { dist, snap = false, speed = 5.5 } = {}) {
      const b = typeof to === 'string' ? byId[to] : null;
      if (b) { goal.target.copy(b.focus); goal.target.y = Math.min(b.focus.y, 40); goal.dist = dist || clamp(b.radius * 3.1, 190, 1100); goal.el = clamp(goal.el, 0.2, 0.62); }
      else if (to) { if (to.target) goal.target.copy(to.target); for (const k of ['az', 'el', 'dist']) if (Number.isFinite(to[k])) goal[k] = to[k]; }
      limit(); idle = 0; rate = speed;
      // take the short way round
      while (goal.az - cur.az > Math.PI) cur.az += Math.PI * 2; while (goal.az - cur.az < -Math.PI) cur.az -= Math.PI * 2;
      if (snap) { cur.target.copy(goal.target); cur.az = goal.az; cur.el = goal.el; cur.dist = goal.dist; place(); }
    },
    home(snap = false) { view.flyTo({ target: HOME.target, az: HOME.az, el: HOME.el, dist: HOME.dist }, { snap, speed: 4 }); },
    pick(x, y) {
      _ndc.set((x / app.size.w) * 2 - 1, -(y / app.size.h) * 2 + 1);
      raycaster.setFromCamera(_ndc, camera);
      const hit = raycaster.intersectObjects(pickRoots, true)[0];
      return hit ? hit.object.userData.building : null;
    },
    /** Screen position of a world point in the picture now on screen (live = true: for the camera as it is this instant). */
    project(v, out = {}, live = false) {
      if (live || !shown) _p.copy(v).project(camera); else _p.copy(v).applyMatrix4(shownVP);
      out.x = (_p.x * 0.5 + 0.5) * app.size.w; out.y = (-_p.y * 0.5 + 0.5) * app.size.h; out.visible = _p.z > -1 && _p.z < 1 && Math.abs(_p.x) < 1.15 && Math.abs(_p.y) < 1.15;
      return out;
    },
    update(dt, { drift = true } = {}) {
      clock += dt; idle += dt;
      if (drift && idle > 5) goal.az += dt * 0.011 * Math.min(1, (idle - 5) / 3);
      const k = 1 - Math.exp(-rate * dt);
      cur.target.lerp(goal.target, k); cur.az += (goal.az - cur.az) * k; cur.el += (goal.el - cur.el) * k;
      cur.dist *= Math.pow(goal.dist / cur.dist, k);
      place();
      sky = skyAt(todOverride == null ? ut : (todOverride - 0.5) * VERDA_DAY);
      const extent = clamp(cur.dist * 0.95, 260, 1500);
      rig.update(camera, dt, sky, cur.target, extent);
      scene.fog.color.copy(rig.state.fog); scene.fog.density = 0.00015 * (1 - 0.35 * rig.state.night);
      { const st = app.settings || {}; base.setVegetation(st.gfxVegetation, low ? 'low' : (st.gfxQuality || 'high'), LEVELS[level].detail); }     // follows the Settings page and this view's own quality steps
      base.update(dt, { sunDir: sky.sunDir, timeOfDay: sky.timeOfDay, camera, pixelHeight: renderer.getDrawingBufferSize(_size).y });      // camera: the vegetation sorts its levels of detail for this frame's view
      ground.update(dt);
    },
    /** Call when a screen starts / stops showing the view (applies and restores the render resolution). */
    begin() { active = true; warm = 0; slow = fast = 0; pending = false; holdUntil = 0; applyLevel(); },
    release() { active = false; renderer.setPixelRatio(nativeRatio()); renderer.setSize(app.size.w, app.size.h, false); },
    get quality() { return level; },
    lockQuality(n) { locked = n != null; if (locked) while (reveal.length) reveal.pop().visible = true; if (locked) level = clamp(n | 0, 0, LEVELS.length - 1); if (active) applyLevel(); },
    /** freeze(true): render() draws nothing until told to (used by the preview script to take exact screenshots). */
    freeze(on) { frozen = !!on; },
    /** True once every object is on screen (always, except while a software rasteriser is still warming up). */
    get ready() { return reveal.length === 0; },
    get frameCount() { return frameCount; },
    render(highlightId = null, force = false) {
      if (frozen && !force) return;
      const now = performance.now();
      govern(now);
      if (!force && now < holdUntil) return;
      lastFrame = now; pending = true; frameCount++;
      if (!software || locked) {
        const env = rig.bakeEnvironment(renderer);
        if (env) for (const m of glossy) { m.envMap = env; m.needsUpdate = true; }
      }
      // on a software rasteriser the scene appears a few objects per frame, so compiling its shaders never blocks for long
      for (let i = 0; i < 3 && reveal.length; i++) reveal.pop().visible = true;
      const p = !low && (!software || locked) && level <= 1 && !(app.settings && app.settings.gfxAO === false) ? postChain() : null;
      renderer.autoClear = true;
      if (p) {
        renderer.getDrawingBufferSize(_size); p.setSize(_size.x, _size.y, 1);
        const rt = p.begin(); rt.viewport.set(0, 0, rt.width, rt.height);
        // (buildings seen from hundreds of metres: the radius keeps growing with distance, to the scale of a building)
        if (p.ao) Object.assign(p.ao.params, { radius: 1.5, intensity: 2.5, maxDist: 5000, grow: 0.03, growMax: 20 });
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        p.end({ camera });
        renderer.setRenderTarget(null); renderer.autoClear = true;
      } else { renderer.setRenderTarget(null); renderer.render(scene, camera); }
      shownVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); shown = true;
      setLit(highlightId);
      if (!litId) return;
      renderer.getDrawingBufferSize(_size);
      const w = Math.max(2, Math.round(_size.x / 2)), h = Math.max(2, Math.round(_size.y / 2));
      if (maskRT.width !== w || maskRT.height !== h) maskRT.setSize(w, h);
      const autoShadow = renderer.shadowMap.autoUpdate, bg = scene.background, fog = scene.fog, alpha = renderer.getClearAlpha();
      renderer.getClearColor(_clear);
      renderer.shadowMap.autoUpdate = false; scene.overrideMaterial = maskMat; scene.fog = null; camera.layers.set(1);
      renderer.setRenderTarget(maskRT); renderer.setClearColor(0x000000, 1); renderer.clear();
      renderer.render(scene, camera);
      camera.layers.set(0); scene.overrideMaterial = null; scene.fog = fog; scene.background = bg; renderer.shadowMap.autoUpdate = autoShadow;
      renderer.setRenderTarget(null); renderer.setClearColor(_clear, alpha);
      outMat.uniforms.uTexel.value.set(1 / w, 1 / h); outMat.uniforms.uTime.value = clock;
      renderer.autoClear = false; renderer.render(outScene, outCam); renderer.autoClear = true;
    },
    resize(w, h) { camera.aspect = w / Math.max(1, h); camera.fov = w / h < 1.5 ? 42 : 38; camera.updateProjectionMatrix(); if (active) applyLevel(); },
  };
  view.resize(app.size.w, app.size.h);
  place();
  instance = view;
  return view;
}
