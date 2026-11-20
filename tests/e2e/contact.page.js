// In-page half of tests/e2e/contact.mjs (loaded with page.addScriptTag): measures the scene the way a player sees it.
// Everything here reads the live THREE scenes: the triangles that are drawn, where they are drawn. Nothing is taken
// from the physics except to label a row (landed, radar altitude) and to say where "up" is.
//
//   await __ct.init()
//   __ct.stall(true|false)          hold / release the terrain worker pool (true = the slowest machine imaginable)
//   __ct.vessel(v?)                 lowest drawn point of a vessel against the topmost drawn surface under it
//   __ct.all()                      the same for every vessel on screen, plus flags, camera, decals
//   __ct.slabs()                    drawn terrain against every ground-level slab of the space centre
//   __ct.camera()                   camera height above the drawn ground
//   __ct.materials()                depth audit of every material in the far and near scenes
//   __ct.sample(on)                 per-frame sampler (requestAnimationFrame, after the game's own frame)
(() => {
  let THREE = null, SYSTEM = null, POOL = null, TM = null;
  const C = {};
  const app = () => window.__sw.app;
  const fl = () => app().flight;
  const SC = () => fl() && fl().view;

  C.init = async () => {
    THREE = await import('/js/lib/three.module.min.js');
    ({ SYSTEM } = await import('/js/core/bodies.js'));
    POOL = (await import('/js/render/workpool.js')).getPool();
    TM = await import('/js/render/terrainmesh.js');
    C.THREE = THREE; C.SYSTEM = SYSTEM;
    return true;
  };
  /** Hold the worker pool: jobs queue up and never start, as on a machine whose workers have not answered yet. */
  C.stall = on => {
    if (on && !POOL.__pump) { POOL.__pump = POOL._pump; POOL._pump = function () {}; }
    else if (!on && POOL.__pump) { POOL._pump = POOL.__pump; delete POOL.__pump; POOL._pump(); }
    return POOL.queue.length;
  };
  C.stalled = () => !!POOL.__pump;

  const shown = o => { for (let q = o; q; q = q.parent) if (!q.visible) return false; return true; };
  const mats = o => (Array.isArray(o.material) ? o.material : o.material ? [o.material] : []);
  /** Something the player sees as a solid surface: an opaque (or alpha-tested) mesh that writes depth. */
  const solid = o => o.isMesh && !o.isSprite && !o.isSkinnedMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position &&
    mats(o).length > 0 && mats(o).every(m => m.visible !== false && m.depthWrite !== false && !(m.transparent && m.opacity < 0.5)) &&
    o.name !== 'shadowCatcher' && o.name !== 'groundGlow';

  /** Height above the datum radius of a scene-space point (the scene origin floats on the anchor). */
  function heightOf(sc, p) { const a = sc.anchor.pos; return Math.hypot(a.x + p.x, a.y + p.y, a.z + p.z) - sc.anchor.body.radius; }
  const _d = () => new THREE.Vector3();
  /** Body-fixed direction of a scene-space point. */
  function dirOf(sc, p, ut, out) { const b = sc.anchor.body; out.copy(sc.anchor.pos).add(p); return b.inertialToSurfaceDir(out, ut, out); }

  /** Lowest and highest drawn vertex of an object tree (height above the datum), with where the lowest one is. */
  function extremes(sc, root, skip = null) {
    const p = _d(), m4 = new THREE.Matrix4();
    let low = Infinity, high = -Infinity, at = null, name = '';
    root.updateMatrixWorld(true);
    root.traverse(o => {
      if (!solid(o) || !shown(o) || (skip && skip(o))) return;
      const pos = o.geometry.attributes.position, n = o.isInstancedMesh ? o.count : 1;
      for (let k = 0; k < n; k++) {
        if (o.isInstancedMesh) { o.getMatrixAt(k, m4); m4.premultiply(o.matrixWorld); } else m4.copy(o.matrixWorld);
        for (let i = 0; i < pos.count; i++) {
          p.fromBufferAttribute(pos, i).applyMatrix4(m4);
          const h = heightOf(sc, p);
          if (h < low) { low = h; at = p.clone(); name = o.name || o.type; }
          if (h > high) high = h;
        }
      }
    });
    return { low, high, at, name };
  }

  const rc = () => { const r = new THREE.Raycaster(); r.camera = SC().camera; r.params.Line = { threshold: 0 }; r.params.Points = { threshold: 0 }; return r; };
  /**
   * What is drawn under a scene-space point: the terrain triangles on screen there (sea surface over water) and the
   * topmost solid near-scene surface that is not a vessel (the space centre's slabs), looking down from `reach`
   * above `ceil` (a height above the datum: surfaces above it are overhead structure, not ground).
   */
  function groundUnder(sc, p, ut, ceil, world) {
    const b = sc.anchor.body, dir = dirOf(sc, p, ut, _d()), out = { spacing: Infinity, level: -1 };
    const terr = sc.worlds ? sc.worlds.heightAt(b, dir, out) : b.surfaceHeight(dir);
    const phys = b.surfaceHeight(dir);
    let deck = null, deckName = '';
    const base = sc.base && sc.base.group && sc.base.group.visible ? sc.base.group : null;
    if (base && b === SYSTEM.home) {
      const up = _d().copy(sc.anchor.pos).add(p).normalize(), h0 = heightOf(sc, p);
      const o = p.clone().addScaledVector(up, ceil - h0 + 0.0005);
      const r = rc(); r.set(o, up.clone().negate()); r.far = Math.max(1, ceil + 30);
      for (const hit of r.intersectObject(base, true)) {
        if (!solid(hit.object) || !shown(hit.object)) continue;
        deck = ceil + 0.0005 - hit.distance; deckName = hit.object.name || hit.object.type; break;
      }
    }
    void world;
    return { terr, phys, deck, deckName, top: deck !== null && deck > terr ? deck : terr, level: out.level, spacing: out.spacing };
  }

  /**
   * One vessel as drawn: per part, the lowest drawn vertex and the gap to the topmost drawn surface under it.
   *   gap   lowest of those gaps: < 0 the vessel is IN the ground by that much, > 0 nothing touches (it floats)
   */
  C.vessel = (v = null, dense = false) => {
    const sc = SC(), w = app().world;
    v = v || w.active;
    const view = sc.views.get(v);
    if (!view) return { id: v.id, name: v.name, drawn: false };
    sc.near.updateMatrixWorld(true); sc.far.updateMatrixWorld(true);
    let gap = Infinity, at = '', low = Infinity, high = -Infinity, g0 = null, lowAt = null, lowName = '';
    for (const e of view.parts.values()) {
      const canopy = e.mesh.userData.canopy || null;       // an open parachute hangs above the craft: not a contact point
      const x = extremes(sc, e.mesh, canopy ? o => { for (let q = o; q && q !== e.mesh; q = q.parent) if (q === canopy) return true; return false; } : null);
      if (!x.at) continue;
      if (x.high > high) high = x.high;
      const g = groundUnder(sc, x.at, w.ut, x.low + 0.6);
      if (x.low < low) { low = x.low; lowAt = x.at; lowName = e.part.def.id + '/' + x.name; }
      if (x.low - g.top < gap) { gap = x.low - g.top; at = e.part.def.id + '/' + x.name; g0 = g; }
      if (dense) {
        // on uneven ground the lowest vertex is not the one that touches: test every drawn vertex within 0.8 m of the
        // part's lowest against the terrain drawn under that vertex (a sample of at most ~400 a part)
        const b0 = sc.anchor.body, dir = _d(), p = _d(), m4 = new THREE.Matrix4();
        e.mesh.traverse(o => {
          if (!solid(o) || !shown(o) || o.isInstancedMesh) return;
          if (canopy) for (let q = o; q && q !== e.mesh; q = q.parent) if (q === canopy) return;
          const pos = o.geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / 400));
          m4.copy(o.matrixWorld);
          for (let i = 0; i < pos.count; i += step) {
            p.fromBufferAttribute(pos, i).applyMatrix4(m4);
            const h = heightOf(sc, p); if (h > x.low + 0.8) continue;
            const t = sc.worlds.heightAt(b0, dirOf(sc, p, w.ut, dir));
            if (h - t < gap) { gap = h - t; at = e.part.def.id + '/' + (o.name || o.type); g0 = { ...g, terr: t }; }
          }
        });
      }
    }
    const b = v.body, up = _d().copy(v.pos).normalize();
    const row = {
      id: v.id, name: v.name, type: v.type, drawn: true, body: b.id, landed: !!v.landed, splashed: !!v.splashed, grounded: !!v.grounded, sit: v.situation, radar: v.radarAlt,
      gap, at, low, high, lowName, terr: g0 && g0.terr, phys: g0 && g0.phys, deck: g0 && g0.deck, deckName: g0 && g0.deckName, level: g0 && g0.level, spacing: g0 && g0.spacing,
      sea: b.ocean ? b.seaLevel : null, lifted: view.deck || 0,
    };
    // lean of the craft's long axis from the local vertical, and the slope of the ground under it
    // fallen: the craft's design "up" (craft +Y for a rocket or a Pip, craft +Z for one that stands on wheels) is more than 50° from the local vertical
    { const veh = !!(v.surface && v.surface.vehicle) || ((v.wheelParts || []).length >= 3 && !(v.legParts || []).length); const ax = veh ? _d().set(0, 0, 1) : _d().set(0, 1, 0); row.fallen = Math.acos(Math.max(-1, Math.min(1, ax.applyQuaternion(v.q).dot(up)))) * 180 / Math.PI > 50; }
    row.tilt = Math.acos(Math.min(1, Math.abs(_d().set(0, 1, 0).applyQuaternion(v.q).dot(up)))) * 180 / Math.PI;
    try { const d = b.inertialToSurfaceDir(_d().copy(v.pos), w.ut, _d()); const n = b.terrainNormal(d, _d()); row.slope = Math.acos(Math.min(1, n.dot(d.normalize()))) * 180 / Math.PI; } catch { row.slope = null; }
    // where it stands on the pad: horizontal distance from the model's pad anchor
    if (sc.base && sc.base.group.visible && sc.base.padAnchor && v.launchSite === 'pad' && v.landed) {
      const pa = sc.base.padAnchor.getWorldPosition(_d()).sub(view.group.position);
      pa.addScaledVector(up, -pa.dot(up)); row.padOff = pa.length();
    }
    void lowAt;
    return row;
  };

  /**
   * The line of sight from the camera to a vessel: rays to its centre and to (up to eight of) its parts, tested
   * against everything solid that is drawn and is not the vessel itself (the space centre, other vessels, terrain).
   * → { rays, blocked: [{ to, by, at (m from the camera), of (m to the target) }], centre: name of what hides the centre | null }
   */
  C.sight = (v = null) => {
    const sc = SC(), w = app().world, cam = sc.camera;
    v = v || w.active;
    const view = sc.views.get(v);
    if (!view) return { rays: 0, blocked: [], centre: null };
    sc.near.updateMatrixWorld(true); sc.far.updateMatrixWorld(true); cam.updateMatrixWorld(true);
    const own = o => { for (let q = o; q; q = q.parent) if (q === view.group) return true; return false; };
    const roots = sc.near.children.filter(o => o !== view.group && o.visible);
    const t = sc.worlds && sc.worlds.get(sc.anchor.body) && sc.worlds.get(sc.anchor.body).terrain;
    const terrain = t ? t.group.children.filter(m => m.visible) : [];
    const targets = [['centre', view.group.getWorldPosition(_d())]];
    const parts = [...view.parts.values()], step = Math.max(1, Math.ceil(parts.length / 8));
    for (let i = 0; i < parts.length; i += step) targets.push([parts[i].part.def.id, parts[i].mesh.getWorldPosition(_d())]);
    const from = cam.getWorldPosition(_d()), dir = _d(), blocked = [];
    let centre = null;
    for (const [name, p] of targets) {
      const dist = dir.subVectors(p, from).length(); if (dist < 0.5) continue;
      dir.multiplyScalar(1 / dist);
      const r = rc(); r.set(from, dir); r.near = cam.near; r.far = dist - 0.75;      // stop short of the vessel's own hull
      let hit = null;
      for (const h of r.intersectObjects(roots, true)) { if (!solid(h.object) || !shown(h.object) || own(h.object)) continue; hit = h; break; }
      const th = r.intersectObjects(terrain, false)[0];
      if (th && (!hit || th.distance < hit.distance)) hit = { distance: th.distance, object: { name: 'terrain L' + th.object.userData.node.level } };
      if (hit) { const b = { to: name, by: hit.object.name || hit.object.type, at: +hit.distance.toFixed(1), of: +dist.toFixed(1) }; blocked.push(b); if (name === 'centre') centre = b.by; }
    }
    return { rays: targets.length, blocked, centre };
  };
  /** Is this vessel standing or rolling on its wheels / legs / bell right now? (drawn contact is only expected then) */
  C.onGround = v => !!(v.landed || (v.grounded && v.radarAlt < 0.6) || (v.wheelsOnGround || 0) >= 2);

  /** Camera height above the drawn ground (and above the physics ground, for comparison). */
  C.camera = () => {
    const sc = SC(), w = app().world, cam = sc.camera;
    const g = groundUnder(sc, cam.position, w.ut, heightOf(sc, cam.position) + 0.6);
    const h = heightOf(sc, cam.position);
    return { clear: h - g.terr, clearPhys: h - g.phys, clearTop: h - g.top, near: cam.near, level: g.level };
  };

  /** Flags as drawn: the foot of each flag against the drawn ground under it. */
  C.flags = () => {
    const sc = SC(), w = app().world, out = [];
    sc.near.traverse(o => {
      if (!o.userData || !o.userData.dir || !o.visible || o.parent !== sc.near) return;
      const x = extremes(sc, o);
      if (!x.at) return;
      const g = groundUnder(sc, x.at, w.ut, x.low + 0.6);
      out.push({ gap: x.low - g.top, level: g.level, spacing: g.spacing });
    });
    return out;
  };

  /** Ground decals that only show when they lie above what is drawn under them (polygon offset does nothing with a logarithmic depth buffer). */
  C.decals = () => {
    const sc = SC(), w = app().world, out = [];
    sc.near.traverse(o => {
      if ((o.name !== 'shadowCatcher' && o.name !== 'groundGlow') || !shown(o)) return;
      const p = o.getWorldPosition(_d()), h = heightOf(sc, p);
      const g = groundUnder(sc, p, w.ut, h + 0.6);
      out.push({ name: o.name, above: h - g.top, deck: g.deckName });
    });
    return out;
  };

  /**
   * Every upward-facing, ground-hugging triangle of the space centre (slabs, aprons, the runway, road and pad
   * markings) against the terrain that is DRAWN under it. over > 0: terrain is drawn above the slab (it pokes
   * through); under: how far the drawn terrain lies below the real ground there (the slab then stands on a plinth).
   */
  C.slabs = () => {
    const sc = SC(), w = app().world, b = sc.anchor.body;
    const base = sc.base && sc.base.group;
    if (!base || !base.visible || b !== SYSTEM.home || !sc.worlds) return { n: 0 };
    base.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(base.matrixWorld).invert();
    const A = _d(), B = _d(), Cc = _d(), M = _d(), n = _d(), e1 = _d(), e2 = _d(), dir = _d(), loc = _d(), out = { spacing: Infinity, level: -1 };
    let count = 0, over = -Infinity, under = -Infinity, poke = 0, tight = 0, overAt = null, underAt = null;
    const levels = {};
    const where = (p, name, h, t) => { loc.copy(p).applyMatrix4(inv); return { mesh: name, x: +loc.x.toFixed(1), z: +loc.z.toFixed(1), h: +h.toFixed(3), terr: +t.toFixed(3), level: out.level, spacing: +out.spacing.toFixed(1) }; };
    const test = (p, name) => {
      const h = heightOf(sc, p);
      dirOf(sc, p, w.ut, dir);
      const t = sc.worlds.heightAt(b, dir, out), d = t - h, sag = b.surfaceHeight(dir) - t;
      count++;
      levels[out.level] = (levels[out.level] || 0) + 1;
      if (d > 0) poke++;
      if (d > -0.008) tight++;
      if (d > over) { over = d; overAt = where(p, name, h, t); }
      if (sag > under) { under = sag; underAt = where(p, name, h, t); }
    };
    base.traverse(o => {
      if (!solid(o) || !shown(o) || o.isInstancedMesh) return;
      const pos = o.geometry.attributes.position, idx = o.geometry.index, nT = (idx ? idx.count : pos.count) / 3;
      const flip = o.matrixWorld.determinant() < 0 ? -1 : 1, back = mats(o)[0].side === THREE.BackSide ? -1 : 1, two = mats(o)[0].side === THREE.DoubleSide;
      for (let t = 0; t < nT; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        A.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
        const hA = heightOf(sc, A);
        if (hA > 0.2 || hA < 0.004) continue;                           // a paving slab, not a plinth, a roof or a buried footing
        B.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld); Cc.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
        n.crossVectors(e1.subVectors(B, A), e2.subVectors(Cc, A));
        const area = n.length(); if (area < 1e-6) continue;
        M.copy(sc.anchor.pos).add(A).normalize();
        const facing = n.dot(M) / area * flip * back;
        if (two ? Math.abs(facing) < 0.98 : facing < 0.98) continue;    // not a floor seen from above
        const hB = heightOf(sc, B), hC = heightOf(sc, Cc);
        if (Math.max(hB, hC) > 0.2 || Math.min(hB, hC) < 0.004) continue;
        test(A, o.name); test(B, o.name); test(Cc, o.name);
        M.copy(A).add(B).add(Cc).multiplyScalar(1 / 3); test(M, o.name);
      }
    });
    return { n: count, over, under, poke, tight, overAt, underAt, levels };
  };

  /** Drawn terrain against the physics ground on a ring of points round the active vessel (m; + = drawn higher). */
  C.terrain = (radii = [0, 2, 5, 10, 25, 60, 150, 400, 1000, 2500]) => {
    const sc = SC(), w = app().world, b = sc.anchor.body, a = sc.anchor.pos;
    const up = _d().copy(a).normalize(), e1 = _d().set(0, 1, 0).cross(up).normalize(), e2 = _d().crossVectors(up, e1), p = _d(), dir = _d(), out = {};
    const rows = [];
    for (const r of radii) {
      let mn = Infinity, mx = -Infinity, lmin = 99, lmax = -1;
      for (let k = 0; k < (r ? 24 : 1); k++) {
        const ang = (k + 0.37) * Math.PI / 12;
        p.copy(a).addScaledVector(e1, Math.cos(ang) * r).addScaledVector(e2, Math.sin(ang) * r);
        b.inertialToSurfaceDir(p, w.ut, dir);
        const d = sc.worlds.heightAt(b, dir, out) - b.surfaceHeight(dir);
        if (d < mn) mn = d; if (d > mx) mx = d;
        if (out.level < lmin) lmin = out.level; if (out.level > lmax) lmax = out.level;
      }
      rows.push({ r, min: +mn.toFixed(3), max: +mx.toFixed(3), lmin, lmax });
    }
    return rows;
  };
  /** The drawn terrain compared with the mesh itself: heightAt() must describe the triangles on screen. */
  C.heightAtCheck = () => {
    const sc = SC(), w = app().world, b = sc.anchor.body, a = sc.anchor.pos, t = sc.worlds.get(b).terrain;
    if (!t) return null;
    t.group.updateMatrixWorld(true);
    const up = _d().copy(a).normalize(), e1 = _d().set(0, 1, 0).cross(up).normalize(), e2 = _d().crossVectors(up, e1), p = _d(), dir = _d(), o = _d(), out = {};
    const meshes = t.group.children.filter(m => m.visible);
    let worst = 0, n = 0, miss = 0;
    for (const r of [1.3, 4.1, 9.7, 33, 87, 240]) for (let k = 0; k < 8; k++) {
      const ang = (k + 0.21) * Math.PI / 4;
      p.set(0, 0, 0).addScaledVector(e1, Math.cos(ang) * r).addScaledVector(e2, Math.sin(ang) * r);
      b.inertialToSurfaceDir(dir.copy(a).add(p), w.ut, dir);
      const hA = sc.worlds.heightAt(b, dir, out);
      if (b.ocean && hA <= b.seaLevel + 1e-6) continue;       // water: the shader lifts the sea bed, the mesh does not
      const upP = dir.copy(a).add(p).normalize();
      o.copy(a).add(p).normalize().multiplyScalar(b.radius + hA + 300).sub(a);
      const r0 = rc(); r0.set(o, upP.clone().negate()); r0.far = 600;
      const hit = r0.intersectObjects(meshes, false)[0];
      if (!hit) { miss++; continue; }
      n++; worst = Math.max(worst, Math.abs((300 - hit.distance)));
    }
    return { n, miss, worst };
  };
  /** Which chunk levels are on screen (a histogram), to compare LOD between window sizes. */
  C.lod = () => {
    const sc = SC(), t = sc.worlds.get(sc.anchor.body).terrain, h = {};
    if (!t) return null;
    const names = [];
    for (const m of t.group.children) if (m.visible) { const l = m.userData.node.level; h[l] = (h[l] || 0) + 1; names.push(m.name); }
    return { hist: h, key: names.sort().join(','), pending: sc.worlds.info.pending, max: t.maxLevel, fine: t.fineLevel };
  };

  /** Depth audit: every material that takes part in the depth test in the flight scenes. */
  C.materials = () => {
    const sc = SC(), seen = new Map(), rows = [];
    for (const [sceneName, root] of [['far', sc.far], ['near', sc.near]]) root.traverse(o => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      for (const m of mats(o)) {
        if (seen.has(m)) continue; seen.set(m, 1);
        const shader = m.isShaderMaterial || m.isRawShaderMaterial;
        const logV = !shader || /logdepthbuf_vertex/.test(m.vertexShader), logF = !shader || /logdepthbuf_fragment/.test(m.fragmentShader);
        rows.push({ scene: sceneName, obj: o.name || o.type, type: m.type, name: m.name || '', depthTest: m.depthTest !== false, depthWrite: m.depthWrite !== false, transparent: !!m.transparent, logDepth: logV && logF, polygonOffset: !!m.polygonOffset, renderOrder: o.renderOrder });
      }
    });
    const r = app().renderer;
    return { rows, logBuffer: !!(r.capabilities && r.capabilities.logarithmicDepthBuffer), reverse: !!(r.capabilities && r.capabilities.reverseDepthBuffer), depthBits: r.getContext().getParameter(r.getContext().DEPTH_BITS), far: sc.camera.far, near: sc.camera.near };
  };

  C.all = (dense = false) => {
    const sc = SC(), w = app().world;
    const vessels = [];
    for (const v of w.vessels) if (sc.views.has(v) && !v.dead) vessels.push(C.vessel(v, dense));
    return { ut: w.ut, vessels, flags: C.flags(), camera: C.camera(), decals: C.decals(), pending: sc.worlds ? sc.worlds.info.pending : 0, quality: sc.qualityName, stalled: C.stalled() };
  };

  // ---- per-frame sampler: runs in requestAnimationFrame after the game's own callback, so it sees each drawn frame
  const S = { on: false, rows: [], frames: 0, scene: null, ut0: 0, last: -1, worst: null, raf: 0 };
  function tick() {
    if (!S.on) return;
    S.raf = requestAnimationFrame(tick);
    try {
      const a = app(), sc = SC(), w = a.world;
      if (a.currentName !== 'flight' || !sc || !w || !w.active || w.active.dead || !sc.views.has(w.active)) return;
      if (S.filter && !S.filter(a)) return;
      if (S.scene !== sc) { S.scene = sc; S.ut0 = w.ut; S.last = -1; }
      const v = w.active, m = C.vessel(v), c = C.camera(), t = w.ut - S.ut0;
      const sec0 = Math.floor(t + 1e-6), sg = sec0 !== S.last || S.everyFrameSight ? C.sight(v) : null;
      const row = { t: +t.toFixed(3), f: S.frames, ground: C.onGround(v), site: v.launchSite, speed: v.groundSpeed, sight: sg, landed: m.landed, radar: m.radar, gap: m.gap, at: m.at, deck: m.deckName, level: m.level, padOff: m.padOff, cam: c.clear, camTop: c.clearTop, warp: w.warpIndex, lapse: w.__demoSim ? w.__demoSim.scale : 1, pending: sc.worlds ? sc.worlds.info.pending : 0, alt: v.altitude };
      S.frames++;
      const W = S.worst;
      if (m.gap < W.gap) { W.gap = m.gap; W.gapRow = row; }
      if (m.landed && m.gap > W.float) { W.float = m.gap; W.floatRow = row; }
      if (c.clear < W.cam) { W.cam = c.clear; W.camRow = row; }
      if (m.padOff !== undefined && m.padOff > W.padOff) { W.padOff = m.padOff; W.padRow = row; }
      if (sg && sg.blocked.length) { W.blockedFrames++; if (!W.blockedRow) W.blockedRow = row; }
      if (row.ground && v.launchSite === 'runway' && !(m.deck !== null && m.deck >= m.terr && /^(asphalt|mark)$/.test(m.deckName || ''))) { W.offRunway++; if (!W.offRunwayRow) W.offRunwayRow = row; }
      if (row.ground) { if (m.gap > W.rollFloat) W.rollFloat = m.gap; if (m.gap < W.rollSink) W.rollSink = m.gap; }
      const sec = Math.floor(t + 1e-6);
      if (sec !== S.last) { S.last = sec; if (S.rows.length < 4000) S.rows.push(row); }
    } catch (err) { S.error = String(err && err.stack || err); }
  }
  C.sample = (on, filter = null) => {
    cancelAnimationFrame(S.raf);
    S.on = !!on;
    if (on) { S.rows = []; S.frames = 0; S.scene = null; S.last = -1; S.error = null; S.filter = filter; S.worst = { gap: Infinity, float: -Infinity, cam: Infinity, padOff: -Infinity, blockedFrames: 0, blockedRow: null, offRunway: 0, offRunwayRow: null, rollFloat: -Infinity, rollSink: Infinity }; S.raf = requestAnimationFrame(tick); }
    return { rows: S.rows, frames: S.frames, worst: S.worst, error: S.error };
  };
  C.sampled = () => ({ rows: S.rows, frames: S.frames, worst: S.worst, error: S.error });

  /** Stand-in error by level: the drawn height of a chunk of each level against the physics ground near a point. */
  C.levelError = (bodyId, dirArr, radii = [10, 80, 400, 1400]) => {
    const b = SYSTEM.byId[bodyId], R = b.radius, N = 40, f = {}, cache = new Map(), rows = [];
    const c0 = new THREE.Vector3(dirArr[0], dirArr[1], dirArr[2]).normalize();
    const e1 = new THREE.Vector3(0, 1, 0).cross(c0).normalize(), e2 = new THREE.Vector3().crossVectors(c0, e1), d = new THREE.Vector3();
    const maxLevel = Math.max(1, Math.min(18, Math.ceil(Math.log2((Math.PI / 2) * R / (N * 1.5)))));
    for (let level = 0; level <= maxLevel + 1; level++) {
      const row = { level, spacing: (Math.PI / 2) * R / 2 ** level / N, err: [] };
      for (const r of radii) {
        let mx = -Infinity, mn = Infinity;
        for (let k = 0; k < 16; k++) {
          const a = (k + 0.37) * Math.PI / 8;
          d.copy(c0).multiplyScalar(R).addScaledVector(e1, r * Math.cos(a)).addScaledVector(e2, r * Math.sin(a)).normalize();
          TM.dirToFace(d.x, d.y, d.z, f);
          const cells = 2 ** level, ix = Math.min(cells - 1, Math.floor((f.u + 1) * 0.5 * cells)), iy = Math.min(cells - 1, Math.floor((f.v + 1) * 0.5 * cells));
          const key = level + ':' + f.face + ':' + ix + ':' + iy;
          let c = cache.get(key); if (!c) { c = TM.buildChunk(b, f.face, level, ix, iy, N); cache.set(key, c); }
          const fu = ((f.u + 1) * 0.5 * cells - ix) * N, fv = ((f.v + 1) * 0.5 * cells - iy) * N, fx = fu - Math.floor(fu), fy = fv - Math.floor(fv);
          const e = TM.chunkHeightAt(c.hs, N, fu, fv, b.ocean ? b.seaLevel : -Infinity) - (c.spacing * c.spacing / (2 * R)) * (fx * (1 - fx) + fy * (1 - fy)) - b.surfaceHeight(d);
          if (e > mx) mx = e; if (e < mn) mn = e;
        }
        row.err.push([+mn.toFixed(3), +mx.toFixed(3)]);
      }
      rows.push(row);
    }
    return rows;
  };

  window.__ct = C;
})();
