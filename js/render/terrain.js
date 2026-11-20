// Starwright — level-of-detail terrain for a whole body: a chunked quadtree on a cube-sphere.
//
// Each of the six cube faces is a quadtree. A node is split while the camera is closer than SPLIT × its size, down
// to roughly metre-sized grid cells. Chunk meshes are built by the worker pool from body.terrainHeight (the function
// the physics uses), positioned by their double-precision centres, and drawn with skirts so neighbours of different
// levels never show a crack. A parent stays on screen until all four children are ready, so nothing ever flickers.
//
//   const terrain = createTerrain(body, { quality });
//   scene.add(terrain.group);        // the caller places group at the body centre and gives it the body's rotation
//   terrain.update(camBodyFixed, { sync });      // camera position in body-fixed metres (double precision)
//   terrain.uniforms                  shared uniforms (see worlds.js for what must be set each frame)
//   terrain.stats = { chunks, drawn, triangles, pending, built }
import * as THREE from '../lib/three.module.min.js';
import { faceDir, dirToFace, buildChunk, chunkIndices, chunkHeightAt } from './terrainmesh.js';
import { getPool } from './workpool.js';
import { atmoUniforms, SUN_SURFACE, fillTint } from './atmosphere.js';
import { TERRAIN_VS, TERRAIN_FS, detailTexture } from './worldshaders.js';
import { getBodyMaps, MAP_SIZES } from './bodytex.js';
import { styleOf } from './worldstyle.js';
import { perf } from '../perf.js';

const SPLIT = { low: 1.6, medium: 1.75, high: 1.85 };
const GRID = { low: 32, medium: 32, high: 40 };
const PERIODS = [2.7, 37, 530, 7900];
const indexCache = new Map();
const _v = new THREE.Vector3();
const _d = { x: 0, y: 0, z: 0 };

export function createTerrain(body, { quality = 'high' } = {}) {
  const R = body.radius, N = GRID[quality] || 48, K = SPLIT[quality] || 2.5;
  const style = styleOf(body.id);
  const maps = getBodyMaps(body);
  const faceSize = (Math.PI / 2) * R;
  const maxLevel = Math.max(1, Math.min(18, Math.ceil(Math.log2(faceSize / (N * 1.5)))));
  // one level finer than the camera ever asks for, but only round the focus (the vessel): cells of 0.4 to 0.75 m,
  // so what stands on the ground stands on the drawn ground to within centimetres
  const fineLevel = maxLevel + 1, FOCUS_K = 1.3, FOCUS_REACH = 0.5;
  const pool = getPool();
  if (!indexCache.has(N)) indexCache.set(N, new THREE.BufferAttribute(chunkIndices(N), 1));
  const index = indexCache.get(N);
  const group = new THREE.Group(); group.name = 'terrain_' + body.id;

  const defines = { USE_MAPS: 1 };
  if (body.ocean && style.water) defines.OCEAN = 1;
  if (style.clouds) defines.CLOUDS = 1;
  if (style.snow) defines.SNOW = 1;
  const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const uniforms = {
    ...atmoUniforms(body),
    uDetail: { value: detailTexture() },
    uRot: { value: new THREE.Matrix3() },
    uCamU: { value: new THREE.Vector3(0, 2, 0) },
    uSun: { value: new THREE.Vector3(1, 0, 0) },
    uAmbSky: { value: new THREE.Vector3() },
    uSkyZen: { value: new THREE.Vector3() }, uSkyHor: { value: new THREE.Vector3() },
    uSunSurf: { value: SUN_SURFACE }, uFill: { value: style.fill }, uFillTint: { value: V3(fillTint(body)) },
    uShine: { value: new THREE.Vector3() }, uShineDir: { value: new THREE.Vector3(0, 1, 0) },
    uTintA: { value: V3(style.ground.tintA) }, uTintB: { value: V3(style.ground.tintB) }, uDirt: { value: V3(style.ground.dirt) },
    uSite: { value: body.sites ? new THREE.Vector4(body.sites.pad.dir.x, body.sites.pad.dir.y, body.sites.pad.dir.z, 3050) : new THREE.Vector4(0, 1, 0, 0) },
    uVary: { value: style.ground.vary }, uDirtT: { value: style.ground.dirtT }, uDirtK: { value: style.ground.dirtK }, uVeg: { value: style.ground.veg }, uGrain: { value: style.ground.grain },
    uRadius: { value: R }, uSea: { value: body.seaLevel || 0 }, uTime: { value: 0 },
    uRock: { value: V3(style.rock) }, uRockSlope: { value: new THREE.Vector2(style.rockSlope[0], style.rockSlope[1]) },
    uStrata: { value: style.strata }, uEmissive: { value: style.emissive }, uGloss: { value: style.gloss }, uDetailK: { value: style.detail },
    uCenterBF: { value: new THREE.Vector3() },
    uPh0: { value: new THREE.Vector3() }, uPh1: { value: new THREE.Vector3() }, uPh2: { value: new THREE.Vector3() }, uPh3: { value: new THREE.Vector3() },
    uTexMix: { value: 0 },
    uAlbedoTex: { value: maps.color }, uNormalTex: { value: maps.normal }, uMapsReady: { value: 0 }, uBump: { value: style.bump },
    uCloudTex: { value: maps.clouds }, uCloudRot: { value: 0 }, uCloudShadow: { value: style.clouds ? Math.min(0.62, 0.35 + 0.4 * style.clouds.cover) : 0 },
    uShallow: { value: V3(style.water ? style.water.shallow : [0, 0, 0]) }, uDeep: { value: V3(style.water ? style.water.deep : [0, 0, 0]) },
    uClarity: { value: style.water ? style.water.clarity : 10 },
    uSnow: { value: V3(style.snow ? style.snow.color : [1, 1, 1]) }, uSnowLine: { value: style.snow ? style.snow.line : 1e9 }, uSnowLat: { value: style.snow ? style.snow.latDrop : 0 },
  };
  const material = new THREE.ShaderMaterial({ uniforms, defines, vertexShader: TERRAIN_VS, fragmentShader: TERRAIN_FS });
  material.name = 'terrain_' + body.id;

  const stats = { chunks: 0, drawn: 0, triangles: 0, pending: 0, built: 0, maxLevel, fineLevel };
  let frame = 0, texel = Math.PI * R / MAP_SIZES.tiny[1];

  function makeNode(face, level, ix, iy, parent) {
    const cells = 2 ** level, size = faceSize / cells;
    faceDir(face, -1 + (2 * ix + 1) / cells, -1 + (2 * iy + 1) / cells, _d);
    return {
      face, level, ix, iy, parent, size, spacing: size / N,
      center: new THREE.Vector3(_d.x * R, _d.y * R, _d.z * R), dir: new THREE.Vector3(_d.x, _d.y, _d.z),
      radius: size * 0.75, mesh: null, state: 0 /* 0 none, 1 pending, 2 ready */, job: null, children: null, used: 0, shown: false,
      phases: null,
    };
  }
  const roots = [];
  for (let f = 0; f < 6; f++) roots.push(makeNode(f, 0, 0, 0, null));

  function onBeforeRender() {
    const n = this.userData.node, u = uniforms;
    u.uCenterBF.value.copy(n.center);
    const ph = n.phases;
    u.uPh0.value.set(ph[0], ph[1], ph[2]); u.uPh1.value.set(ph[3], ph[4], ph[5]);
    u.uPh2.value.set(ph[6], ph[7], ph[8]); u.uPh3.value.set(ph[9], ph[10], ph[11]);
    const t = (n.spacing / texel - 0.5) / 1.0;
    u.uTexMix.value = t < 0 ? 0 : t > 1 ? 1 : t;
    material.uniformsNeedUpdate = true;
  }

  function adopt(n, c) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(c.pos, 3));
    geo.setAttribute('aNrm', new THREE.BufferAttribute(c.nrm, 4, true));
    geo.setAttribute('aCol', new THREE.BufferAttribute(c.col, 4, true));
    geo.setAttribute('aHs', new THREE.BufferAttribute(c.hs, 2));
    geo.setIndex(index);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), c.radius);
    n.center.set(c.center[0], c.center[1], c.center[2]);
    n.radius = c.radius; n.minH = c.minH; n.maxH = c.maxH; n.hs = c.hs;
    n.phases = new Float32Array(12);
    for (let s = 0; s < 4; s++) for (let k = 0; k < 3; k++) { const q = c.center[k] / PERIODS[s]; n.phases[s * 3 + k] = q - Math.floor(q); }
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.copy(n.center); mesh.visible = false; mesh.userData.node = n;
    mesh.onBeforeRender = onBeforeRender;
    mesh.name = `chunk_${n.face}_${n.level}_${n.ix}_${n.iy}`;
    group.add(mesh);
    n.mesh = mesh; n.state = 2; n.job = null;
    stats.chunks++; stats.built++;
  }

  function buildNow(n) {
    if (n.job) { n.job.cancel(); n.job = null; }
    perf.count('chunksBuiltOnMain');
    adopt(n, buildChunk(body, n.face, n.level, n.ix, n.iy, N));
  }

  function request(n, priority) {
    if (n.state === 2) return;
    if (n.state === 1) { n.job.setPriority(priority); return; }
    n.state = 1;
    const job = pool.run({ kind: 'chunk', body: body.id, face: n.face, level: n.level, ix: n.ix, iy: n.iy, N }, priority);
    n.job = job;
    job.promise.then((res) => {
      if (n.job !== job) return;
      if (!res || disposed) { n.state = 0; n.job = null; return; }
      perf.begin('terrain'); perf.count('chunksFromWorkers'); adopt(n, res.chunk); perf.end();
    }, () => { if (n.job === job) { n.state = 0; n.job = null; } });
  }

  function hide(n) { if (n.shown) { n.shown = false; n.mesh.visible = false; } }
  function hideTree(n) {
    hide(n);
    if (n.children) for (const c of n.children) hideTree(c);
  }
  function dropNode(n) {
    if (n.children) { for (const c of n.children) dropNode(c); n.children = null; }
    if (n.job) { n.job.cancel(); n.job = null; }
    if (n.mesh) { group.remove(n.mesh); n.mesh.geometry.dispose(); n.mesh = null; stats.chunks--; }
    n.state = 0; n.shown = false;
  }

  let cam = new THREE.Vector3(), camDir = new THREE.Vector3(), horizon = Math.PI, syncBudget = 0, syncStart = 0;
  const focus = new THREE.Vector3(); let hasFocus = false;
  const sea = body.ocean && style.water ? body.seaLevel : -Infinity;
  const _f = { face: 0, u: 0, v: 0 };

  /** should this node be replaced by its four children? */
  function wantsSplit(n, dist, fd) {
    if (n.level < maxLevel) return (dist < fd ? dist : fd) < K * n.size;
    return n.level < fineLevel && fd < FOCUS_K * n.size;
  }
  function makeChildren(n) {
    n.children = [];
    for (let k = 0; k < 4; k++) n.children.push(makeNode(n.face, n.level + 1, n.ix * 2 + (k & 1), n.iy * 2 + (k >> 1), n));
  }
  /**
   * Is the focus inside this node's square, or within `k` of the node's own size of it? (Same face: measured in face
   * coordinates, which are close to equal-angle; across a cube edge: from the node's centre, generously.)
   */
  const _ff = { face: 0, u: 0, v: 0 };
  function nearFocus(n, k) {
    if (n.face !== _ff.face) return focus.distanceTo(n.center) - n.size * 0.71 <= k * n.size;
    const cells = 2 ** n.level, w = 2 / cells, u0 = -1 + n.ix * w, v0 = -1 + n.iy * w;
    const du = Math.max(0, u0 - _ff.u, _ff.u - u0 - w), dv = Math.max(0, v0 - _ff.v, _ff.v - v0 - w);
    return du * du + dv * dv <= k * k * w * w;
  }
  /**
   * Build, on this thread, every chunk the view wants in the neighbourhood of the focus: at each level the nodes the
   * focus stands in or within half their size of. Afterwards no chunk drawn within a distance r of the focus is
   * wider than 2r, whatever the workers are doing.
   *
   * This used to follow ONE chain of nodes down to the focus. A focus on a node boundary then had fine ground on
   * one side and a stand-in of any level on the other until the workers delivered, level by level; and the launch
   * pad sits at the exact centre of a cube face, the corner of four nodes at every level. Three quarters of the
   * space centre were drawn from 12 km grid cells on arrival: metres above or below the slabs and the rocket.
   * The work is bounded (at most four nodes a level), so it is not cut short by a time budget.
   */
  function refineFocus() {
    dirToFace(focus.x, focus.y, focus.z, _ff);
    const go = (n) => {
      if (n.state !== 2 || !nearFocus(n, FOCUS_REACH)) return;
      if (!wantsSplit(n, cam.distanceTo(n.center), focus.distanceTo(n.center))) return;
      if (!n.children) makeChildren(n);
      for (const c of n.children) if (c.state !== 2) buildNow(c);
      for (const c of n.children) go(c);
    };
    for (const r of roots) go(r);
  }

  function visit(n) {
    n.used = frame;
    // beyond the horizon: nothing to draw, nothing to refine
    const ang = Math.acos(Math.max(-1, Math.min(1, camDir.dot(n.dir))));
    if (ang - n.size * 0.75 / R > horizon) { hideTree(n); return; }
    const dist = cam.distanceTo(n.center), fd = hasFocus ? focus.distanceTo(n.center) : Infinity;
    if (wantsSplit(n, dist, fd)) {
      if (!n.children) makeChildren(n);
      let ready = true;
      for (const c of n.children) {
        if (c.state === 2) continue;
        if (syncBudget > 0 && performance.now() - syncStart < syncBudget) buildNow(c);
        // the ground under the vessel comes first; then coarse before fine, near before far
        else { ready = false; request(c, (fd < 2.5 * n.size ? -1e6 : 0) + c.level * 100 + Math.min(dist, fd) / c.size); }
      }
      if (ready) {
        hide(n);
        for (const c of n.children) visit(c);
        return;
      }
    }
    if (n.children) for (const c of n.children) hideTree(c);
    if (!n.shown) { n.shown = true; n.mesh.visible = true; }
    stats.drawn++;
  }

  function prune(n) {
    // drop subtrees nobody has looked at for a while
    if (!n.children) return;
    let idle = true;
    for (const c of n.children) { prune(c); if (c.used > frame - 240 || c.children) idle = false; }
    if (idle) { for (const c of n.children) dropNode(c); n.children = null; }
  }

  let disposed = false;
  const api = {
    group, material, uniforms, stats, body, maxLevel, fineLevel, grid: N,
    /**
     * Choose and show the chunks for a camera at body-fixed position `camBF` (metres from the body centre).
     * `sync` (ms): build missing chunks on the calling thread for up to that long (first frame, teleports).
     * `focus`: body-fixed position of what must stand on the drawn ground (the vessel). `focusSync`: the focus has
     * jumped (a new scene, a switch to another vessel): its neighbourhood is built before this call returns, as
     * it is whenever `sync` > 0 (see refineFocus).
     */
    update(camBF, { sync = 0, focus: focusBF = null, focusSync = false } = {}) {
      frame++;
      cam.copy(camBF);
      hasFocus = !!focusBF;
      if (hasFocus) focus.copy(focusBF);
      const cr = cam.length();
      camDir.copy(cam).divideScalar(cr || 1);
      const rLo = R + Math.min(body.minElevation, body.ocean ? body.seaLevel : 0), rHi = R + body.maxElevation;
      horizon = cr > rLo ? Math.acos(rLo / cr) + Math.acos(rLo / rHi) + 0.02 : Math.PI;
      for (const r of roots) if (r.state !== 2) buildNow(r);
      syncBudget = sync; syncStart = performance.now();          // (the time refineFocus takes comes out of the budget)
      if (hasFocus && (sync > 0 || focusSync)) refineFocus();
      stats.drawn = 0;
      for (const r of roots) visit(r);
      if (sync > 0) {
        // children built just now may themselves want splitting: keep refining inside the budget
        for (let pass = 0; pass < maxLevel && performance.now() - syncStart < syncBudget; pass++) {
          const before = stats.built; stats.drawn = 0;
          for (const r of roots) visit(r);
          if (stats.built === before) break;
        }
      }
      syncBudget = 0;
      if (frame % 120 === 0 && stats.chunks > 260) for (const r of roots) prune(r);
      stats.triangles = stats.drawn * (index.count / 3);
      let pending = 0; for (const j of pool.jobs.values()) if (j.msg.kind === 'chunk' && j.msg.body === body.id && !j.cancelled) pending++;
      stats.pending = pending;
      const lvl = maps.level;
      texel = Math.PI * R / MAP_SIZES[lvl][1];
      uniforms.uMapsReady.value = lvl === 'tiny' ? 0 : 1;
    },
    /**
     * Height (m above the datum radius) of the ground AS DRAWN at a body-fixed direction: the triangles of the chunk
     * that is on screen there right now (sea-bed vertices lifted to the sea surface, as drawn). Physics stands on
     * body.terrainHeight(dir); the two agree to centimetres round the focus once its chunks are in, and differ by
     * more while coarse chunks are still standing in or far from the focus. `out.spacing` gets the grid spacing (m)
     * of the chunk used (Infinity when nothing is drawn there and the height function was used instead).
     */
    heightAt(dir, out = null) {
      dirToFace(dir.x, dir.y, dir.z, _f);
      let n = roots[_f.face];
      while (n && !n.shown && n.children) {
        const cells = 2 ** (n.level + 1);
        const cx = Math.min(cells - 1, Math.max(0, Math.floor((_f.u + 1) * 0.5 * cells))), cy = Math.min(cells - 1, Math.max(0, Math.floor((_f.v + 1) * 0.5 * cells)));
        n = n.children[(cx & 1) | ((cy & 1) << 1)];
      }
      if (!n || !n.shown || !n.hs) {
        if (out) { out.spacing = Infinity; out.level = -1; }
        const h = body.terrainHeight(dir, 0);
        return h < sea ? sea : h;
      }
      const cells = 2 ** n.level;
      const fu = ((_f.u + 1) * 0.5 * cells - n.ix) * N, fv = ((_f.v + 1) * 0.5 * cells - n.iy) * N;
      if (out) { out.spacing = n.spacing; out.level = n.level; }
      // flat triangles cut the corner of the sphere: a chord sags s²/8R below the arc (millimetres on fine chunks)
      const fx = fu - Math.floor(fu), fy = fv - Math.floor(fv);
      return chunkHeightAt(n.hs, N, fu, fv, sea) - (n.spacing * n.spacing / (2 * R)) * (fx * (1 - fx) + fy * (1 - fy));
    },
    /** True while chunks the current view wants are still being built. */
    get busy() { return stats.pending > 0; },
    dispose() {
      disposed = true;
      for (const r of roots) dropNode(r);
      material.dispose();
    },
  };
  return api;
}
