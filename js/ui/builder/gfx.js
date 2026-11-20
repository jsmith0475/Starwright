// Starwright assembly building — 3D helpers: part objects, attachment-node markers, gizmo handles,
// balance markers and thumbnail rendering. Everything here lives in craft space (children of the craft group).
import * as THREE from '../../lib/three.module.min.js';
import { partDef } from '../../core/parts.js';
import { layout, asmBounds } from './asm.js';

export const COL = { teal: 0x39d0c0, amber: 0xffb347, red: 0xff5a5a, green: 0x74dd92, blue: 0x6cb6ff, neutral: 0x9fb4c8, white: 0xf2f6f9, violet: 0xe879f9 };
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------- part objects
const FB = { tank: 0xf2f4f5, engine: 0x333a44, srb: 0xf2f4f5, capsule: 0xf3e6c8, decoupler: 0xffb347, fin: 0x39d0c0, wing: 0xdfe5ea };
function fallbackMesh(def, ghost) {
  const g = new THREE.Group();
  const m = ghost ? new THREE.MeshBasicMaterial({ color: COL.teal, transparent: true, opacity: 0.4, depthWrite: false })
    : new THREE.MeshStandardMaterial({ color: FB[def.shape] ?? 0xc9d2da, roughness: 0.6, metalness: 0.15 });
  if (def.attach.stack) g.add(new THREE.Mesh(new THREE.CylinderGeometry(def.rTop ?? def.r, def.rBottom ?? def.r, def.h, 24), m));
  else { const b = new THREE.Mesh(new THREE.BoxGeometry(def.rw || 0.3, def.h, def.t || 0.1), m); g.add(b); }
  g.userData = { def, fallback: true, ghost };
  return g;
}
export function makePartObject(meshApi, def, { ghost = false } = {}) {
  let g = null;
  if (meshApi) { try { g = meshApi.buildPartMesh(def, { ghost }); } catch (err) { console.warn('[builder] buildPartMesh failed for ' + def.id + ':', err && err.message); } }
  if (!g) g = fallbackMesh(def, ghost);
  g.traverse(o => { if (o.isMesh) { o.castShadow = !ghost; o.receiveShadow = !ghost; } });
  if (!ghost && meshApi && typeof meshApi.setPartState === 'function') {
    try { if (def.shape === 'leg' || def.legs) meshApi.setPartState(g, { deployed: 1, instant: true }); } catch { /* optional */ }
  }
  return g;
}
export function tintPartObject(meshApi, g, color) {
  if (g.userData.swTint === color) return;
  g.userData.swTint = color;
  if (!g.userData.fallback && meshApi && typeof meshApi.highlightPart === 'function') { try { meshApi.highlightPart(g, color); return; } catch { /* local tint below */ } }
  g.traverse(o => {
    if (!o.isMesh || !o.material) return;
    if (g.userData.ghost) { o.material.color.set(color ?? COL.teal); return; }
    if (!o.material.emissive) return;
    if (!o.userData.swMat) { o.userData.swBase = o.material; o.userData.swMat = o.material.clone(); }
    if (color == null) o.material = o.userData.swBase; else { o.material = o.userData.swMat; o.material.emissive.set(color).multiplyScalar(0.4); }
  });
}
export function freePartObject(meshApi, g) {
  if (!g) return;
  g.removeFromParent();
  if (g.userData.fallback) g.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); if (o.userData.swMat) o.userData.swMat.dispose(); } });
  else if (meshApi && typeof meshApi.disposePartMesh === 'function') { try { meshApi.disposePartMesh(g); } catch { /* ignore */ } }
}
const qYaw = new THREE.Quaternion(), qT = new THREE.Quaternion(), qFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI), X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
/** Position a part object: craft coords + yaw, then the optional end-for-end flip, pitch and roll (see craft.js partQuat). */
export function posePart(g, x, y, z, rot, flip = false, pitch = 0, roll = 0) {
  g.position.set(x, y, z);
  qYaw.setFromAxisAngle(Y, rot || 0);
  g.quaternion.copy(qYaw); if (flip) g.quaternion.multiply(qFlip);
  if (pitch) g.quaternion.multiply(qT.setFromAxisAngle(Z, pitch));
  if (roll) g.quaternion.multiply(qT.setFromAxisAngle(X, roll));
}

/** A group showing one copy of an assembly (root at the group origin, yaw / mirror applied by setAssemblyPose). */
export function makeAssemblyObject(meshApi, asm, { ghost = false } = {}) {
  const g = new THREE.Group();
  g.userData = { parts: asm.parts.map(p => { const o = makePartObject(meshApi, partDef(p.type), { ghost }); g.add(o); return o; }), ghost };
  setAssemblyPose(g, asm, { x: 0, y: 0, z: 0, yaw: 0, mirror: false });
  return g;
}
export function setAssemblyPose(g, asm, spec) {
  const where = layout(asm, spec);
  g.userData.parts.forEach((o, i) => posePart(o, where[i].x, where[i].y, where[i].z, where[i].rot, !!asm.parts[i].flip, asm.parts[i].pitch || 0, where[i].roll || 0));
}
export function tintAssembly(meshApi, g, color) { for (const o of g.userData.parts) tintPartObject(meshApi, o, color); }
export function freeAssemblyObject(meshApi, g) { if (!g) return; for (const o of g.userData.parts) freePartObject(meshApi, o); g.removeFromParent(); }

// ---------------------------------------------------------------------------------------------- node markers
/**
 * Attachment-node markers. set(list) with { x, y, z, dir: {x,y,z}, r, state } where state is
 *   'idle' (open node, nothing held), 'ok' (the held part can go here), 'snap' (it WILL go here), 'held' (a node of the held part).
 */
export function createNodeMarkers(parent) {
  const group = new THREE.Group(); group.name = 'node_markers'; group.renderOrder = 900; parent.add(group);
  const ball = new THREE.SphereGeometry(1, 20, 14), ring = new THREE.TorusGeometry(1, 0.045, 8, 48), disc = new THREE.CircleGeometry(1, 40);
  const pool = [];
  const STY = {
    idle: { c: COL.teal, o: 0.42, s: 0.11, ring: 0.0 },
    ok: { c: COL.teal, o: 0.95, s: 0.16, ring: 0.5 },
    snap: { c: COL.amber, o: 1, s: 0.18, ring: 1 },
    held: { c: COL.white, o: 0.95, s: 0.12, ring: 0 },
  };
  const up = new THREE.Vector3(0, 0, 1), d = new THREE.Vector3();
  function make() {
    const m = (geo, o) => new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COL.teal, transparent: true, opacity: o, depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false }));
    const n = { g: new THREE.Group(), ball: m(ball, 0.9), ring: m(ring, 0.9), disc: m(disc, 0.2), halo: m(ring, 0.5) };
    n.g.add(n.ball, n.ring, n.disc, n.halo);
    for (const k of ['ball', 'ring', 'disc', 'halo']) n[k].renderOrder = 900;
    group.add(n.g); pool.push(n);
    return n;
  }
  let shown = [];
  return {
    group,
    set(list) {
      while (pool.length < list.length) make();
      pool.forEach((n, i) => { n.g.visible = i < list.length; });
      shown = list;
      list.forEach((it, i) => {
        const n = pool[i], st = STY[it.state] || STY.idle;
        n.g.position.set(it.x, it.y, it.z);
        d.set(it.dir.x, it.dir.y, it.dir.z).normalize();
        n.g.quaternion.setFromUnitVectors(up, d);
        n.state = it.state; n.r = Math.max(0.2, it.r || 0.3); n.sty = st;
        for (const k of ['ball', 'ring', 'disc', 'halo']) n[k].material.color.set(st.c);
        n.ball.material.opacity = st.o;
        n.ring.visible = n.disc.visible = st.ring > 0; n.halo.visible = it.state === 'snap';
      });
    },
    /** Pulse and keep markers a readable size on screen. `scale` = world units per pixel at the craft. */
    update(t, scale) {
      pool.forEach((n, i) => {
        if (i >= shown.length) return;
        const st = n.sty, pulse = n.state === 'snap' ? 1 + 0.22 * Math.sin(t * 9) : n.state === 'ok' ? 1 + 0.06 * Math.sin(t * 4 + i) : 1;
        // a steady size on screen (st.s × 60 px radius), within sane world limits
        n.ball.scale.setScalar(Math.min(0.4, Math.max(0.035, scale * st.s * 60)) * pulse);
        const rr = n.r * (n.state === 'snap' ? 1.02 : 0.98);
        n.ring.scale.setScalar(rr); n.disc.scale.setScalar(rr);
        n.ring.material.opacity = n.state === 'snap' ? 0.95 : 0.4; n.disc.material.opacity = n.state === 'snap' ? 0.16 : 0.06;
        if (n.halo.visible) { const k = (t * 1.6) % 1; n.halo.scale.setScalar(rr * (1 + k * 0.9)); n.halo.material.opacity = 0.7 * (1 - k); }
      });
    },
    dispose() { ball.dispose(); ring.dispose(); disc.dispose(); for (const n of pool) for (const k of ['ball', 'ring', 'disc', 'halo']) n[k].material.dispose(); group.removeFromParent(); },
  };
}

/** Ring that sits on a surface under the pointer while a surface part is held, and the "snap" flash. */
export function createCursorFx(parent) {
  const group = new THREE.Group(); parent.add(group);
  const mat = (o) => new THREE.MeshBasicMaterial({ color: COL.teal, transparent: true, opacity: o, depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
  const ringGeo = new THREE.TorusGeometry(1, 0.07, 8, 36);
  const surf = new THREE.Mesh(ringGeo, mat(0.9)); surf.renderOrder = 901; surf.visible = false; group.add(surf);
  const flashes = [];
  const z = new THREE.Vector3(0, 0, 1), d = new THREE.Vector3();
  return {
    surface(p, normal, r = 0.25, color = COL.teal) {
      if (!p) { surf.visible = false; return; }
      surf.visible = true; surf.position.set(p.x, p.y, p.z); surf.scale.setScalar(r); surf.material.color.set(color);
      surf.quaternion.setFromUnitVectors(z, d.set(normal.x, normal.y, normal.z).normalize());
    },
    flash(p, dir, r = 0.5, color = COL.amber) {
      const m = new THREE.Mesh(ringGeo, mat(1)); m.material.color.set(color); m.renderOrder = 902;
      m.position.set(p.x, p.y, p.z); m.quaternion.setFromUnitVectors(z, d.set(dir.x, dir.y, dir.z).normalize());
      group.add(m); flashes.push({ m, t: 0, r });
    },
    update(dt) {
      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i]; f.t += dt / 0.45;
        if (f.t >= 1) { f.m.material.dispose(); f.m.removeFromParent(); flashes.splice(i, 1); continue; }
        const e = 1 - Math.pow(1 - f.t, 3);
        f.m.scale.setScalar(f.r * (0.6 + e * 1.9)); f.m.material.opacity = 1 - f.t;
      }
    },
    get flashing() { return flashes.length; },
    dispose() { ringGeo.dispose(); surf.material.dispose(); for (const f of flashes) f.m.material.dispose(); group.removeFromParent(); },
  };
}

// ---------------------------------------------------------------------------------------------- gizmos
/** Move (three arrows) and rotate (a ring about the part's axis) handles. Hit-testing is done in screen space by the caller. */
export function createGizmo(parent) {
  const group = new THREE.Group(); group.name = 'gizmo'; group.visible = false; parent.add(group);
  const mat = c => new THREE.MeshBasicMaterial({ color: c, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95, fog: false, toneMapped: false });
  const shaft = new THREE.CylinderGeometry(0.035, 0.035, 1, 10), head = new THREE.ConeGeometry(0.11, 0.3, 14), knob = new THREE.SphereGeometry(0.1, 14, 10);
  const AX = { x: { c: COL.red, v: new THREE.Vector3(1, 0, 0) }, y: { c: COL.green, v: new THREE.Vector3(0, 1, 0) }, z: { c: COL.blue, v: new THREE.Vector3(0, 0, 1) } };
  const move = new THREE.Group(), arrows = {};
  for (const k of ['x', 'y', 'z']) {
    const a = new THREE.Group(), m = mat(AX[k].c);
    const s = new THREE.Mesh(shaft, m); s.position.y = 0.55;
    const h = new THREE.Mesh(head, m); h.position.y = 1.15;
    a.add(s, h); a.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), AX[k].v);
    a.traverse(o => { o.renderOrder = 950; });
    arrows[k] = { g: a, m }; move.add(a);
  }
  const centre = new THREE.Mesh(knob, mat(COL.white)); centre.renderOrder = 951; move.add(centre);
  const rot = new THREE.Group();
  const ringM = mat(COL.amber);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 8, 72), ringM); ring.rotation.x = Math.PI / 2; ring.renderOrder = 950; rot.add(ring);
  const tickG = new THREE.BoxGeometry(0.02, 0.02, 0.12), tickM = mat(COL.white);
  for (let k = 0; k < 24; k++) { const t = new THREE.Mesh(tickG, tickM); const a = k * Math.PI / 12; t.position.set(Math.cos(a) * 1, 0, -Math.sin(a) * 1); t.rotation.y = a + Math.PI / 2; t.scale.z = k % 6 === 0 ? 2 : 1; t.renderOrder = 950; rot.add(t); }
  const grip = new THREE.Mesh(knob, mat(COL.amber)); grip.position.set(1, 0, 0); grip.scale.setScalar(1.3); grip.renderOrder = 951; rot.add(grip);
  group.add(move, rot);
  return {
    group, axes: AX,
    show(mode, p, yaw = 0) {
      group.visible = !!mode;
      if (!mode) return;
      group.position.set(p.x, p.y, p.z);
      move.visible = mode === 'move'; rot.visible = mode === 'rotate';
      rot.rotation.y = yaw;
    },
    /** Keep a constant size on screen: `scale` world units per pixel at the gizmo. */
    setScale(scale) { group.scale.setScalar(Math.max(0.35, scale * 95)); },
    highlight(axis) {
      for (const k of ['x', 'y', 'z']) arrows[k].m.color.set(axis === k ? COL.amber : AX[k].c);
      ringM.color.set(axis === 'ring' ? COL.white : COL.amber);
    },
    get size() { return group.scale.x; },
    dispose() { shaft.dispose(); head.dispose(); knob.dispose(); tickG.dispose(); ring.geometry.dispose(); group.traverse(o => { if (o.isMesh) o.material.dispose(); }); group.removeFromParent(); },
  };
}

// ---------------------------------------------------------------------------------------------- balance markers
function ballTexture(a, b) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const x = c.getContext('2d');
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) { x.fillStyle = (i + j) % 2 ? a : b; x.fillRect(i * 32, j * 32, 32, 32); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
/** Centre of mass (amber/black ball), thrust (violet ball + arrow) and lift (blue ball + arrow) markers. */
export function createBalanceMarkers(parent) {
  const group = new THREE.Group(); group.name = 'balance'; parent.add(group);
  const geo = new THREE.SphereGeometry(1, 24, 16), shaft = new THREE.CylinderGeometry(0.16, 0.16, 1, 10), head = new THREE.ConeGeometry(0.42, 0.9, 14);
  const texs = [];
  const mk = (a, b, arrowCol) => {
    const tex = ballTexture(a, b); texs.push(tex);
    const g = new THREE.Group();
    const ball = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, opacity: 0.96, fog: false, toneMapped: false }));
    ball.renderOrder = 920; g.add(ball);
    if (arrowCol != null) {
      const m = new THREE.MeshBasicMaterial({ color: arrowCol, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95, fog: false, toneMapped: false });
      const arrow = new THREE.Group();
      const s = new THREE.Mesh(shaft, m); s.scale.y = 2.6; s.position.y = 2.2;
      const h = new THREE.Mesh(head, m); h.position.y = 3.9;
      s.renderOrder = h.renderOrder = 919; arrow.add(s, h); g.add(arrow); g.userData.arrow = arrow;
    }
    g.visible = false; group.add(g); return g;
  };
  const com = mk('#ffb347', '#14181d', null), cot = mk('#e879f9', '#2a1030', COL.violet), col = mk('#6cb6ff', '#10243a', COL.blue);
  const up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3();
  return {
    group, com, cot, col,
    /** bal from asm.balance(); show = { com, cot, col } booleans; liftDir = craft-space direction lift acts along. */
    set(bal, show, liftDir, scale) {
      const s = Math.max(0.16, scale * 16);
      const put = (g, p, on, k = 1) => { g.visible = !!(on && p); if (g.visible) { g.position.set(p.x, p.y, p.z); g.scale.setScalar(s * k); } };
      put(com, bal.com, show.com, 1.15); put(cot, bal.cot, show.cot, 0.95); put(col, bal.col, show.col, 0.95);
      const td = bal.thrustDir || { x: 0, y: 1, z: 0 };
      cot.userData.arrow.quaternion.setFromUnitVectors(up, v.set(-td.x, -td.y, -td.z).normalize());
      col.userData.arrow.quaternion.setFromUnitVectors(up, v.set(liftDir.x, liftDir.y, liftDir.z).normalize());
    },
    dispose() { geo.dispose(); shaft.dispose(); head.dispose(); for (const t of texs) t.dispose(); group.traverse(o => { if (o.isMesh) o.material.dispose(); }); group.removeFromParent(); },
  };
}

// ---------------------------------------------------------------------------------------------- thumbnails
/**
 * Off-screen renderer for part cards and craft previews (real part meshes, same lighting language as the hall).
 *   thumbs.part(def, canvas, angle)        draws the part into a 2D canvas (transparent background)
 *   thumbs.craft(craftLike, w, h)          → JPEG data URL of a whole design ({ parts: [{type,pos,rot,flip}] })
 */
export function createThumbs(renderer, meshApi, envMap) {
  const scene = new THREE.Scene();
  if (envMap) { scene.environment = envMap; scene.environmentIntensity = 0.7; }
  scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x39424e, 1.5));
  const key = new THREE.DirectionalLight(0xfff2de, 2.6); key.position.set(2.5, 4, 3.5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x7fe3d8, 1.2); rim.position.set(-3, 1.5, -3); scene.add(rim);
  const cam = new THREE.PerspectiveCamera(24, 1, 0.01, 500);
  const holder = new THREE.Group(); scene.add(holder);
  const rts = new Map(), scratch = document.createElement('canvas');
  const cache = new Map();           // def id → { g, sph } (small LRU of part objects for live spinning)
  const prev = { color: new THREE.Color() };
  function rtFor(w, h) {
    const k = w + 'x' + h;
    if (!rts.has(k)) { const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true }); rt.texture.colorSpace = THREE.SRGBColorSpace; rts.set(k, rt); }
    return rts.get(k);
  }
  function renderTo(w, h, clear, alpha) {
    const rt = rtFor(w, h);
    const pRT = renderer.getRenderTarget(), pA = renderer.getClearAlpha(), pAuto = renderer.autoClear, pShadow = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(prev.color);
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(rt); renderer.setClearColor(clear, alpha); renderer.autoClear = true; renderer.clear(); renderer.render(scene, cam);
    const buf = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    renderer.setRenderTarget(pRT); renderer.setClearColor(prev.color, pA); renderer.autoClear = pAuto; renderer.shadowMap.autoUpdate = pShadow;
    scratch.width = w; scratch.height = h;
    const ctx = scratch.getContext('2d'), img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    ctx.putImageData(img, 0, 0);
    return scratch;
  }
  function partObject(def) {
    let e = cache.get(def.id);
    if (e) { cache.delete(def.id); cache.set(def.id, e); return e; }
    const g = makePartObject(meshApi, def);
    if (g.userData.canopy) g.userData.canopy.visible = false;
    g.updateMatrixWorld(true);
    const sph = new THREE.Box3().setFromObject(g).getBoundingSphere(new THREE.Sphere());
    e = { g, sph }; cache.set(def.id, e);
    if (cache.size > 24) { const [id, old] = cache.entries().next().value; cache.delete(id); freePartObject(meshApi, old.g); }
    return e;
  }
  return {
    part(def, canvas, angle = 0.6) {
      const S = canvas.width * 2;
      const { g, sph } = partObject(def);
      holder.add(g);
      const elev = def.engine ? -0.25 : 0.36;
      const dir = new THREE.Vector3(Math.sin(angle) * Math.cos(elev), Math.sin(elev), Math.cos(angle) * Math.cos(elev));
      const dist = sph.radius / Math.sin(cam.fov * DEG / 2) * 1.04;
      cam.aspect = 1; cam.position.copy(sph.center).addScaledVector(dir, dist); cam.near = dist * 0.05; cam.far = dist * 4; cam.lookAt(sph.center); cam.updateProjectionMatrix();
      let img;
      try { img = renderTo(S, S, 0x000000, 0); } finally { holder.remove(g); }
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    },
    craft(craftLike, w = 240, h = 180, { horizontal = false } = {}) {
      const parts = craftLike.parts || [];
      if (!parts.length) return '';
      const grp = new THREE.Group(), objs = [];
      for (const p of parts) {
        let d; try { d = partDef(p.type); } catch { continue; }
        const o = makePartObject(meshApi, d); posePart(o, p.pos.x, p.pos.y, p.pos.z, p.rot, !!p.flip, p.pitch || 0, p.roll || 0); grp.add(o); objs.push(o);
      }
      if (horizontal) grp.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)));
      holder.add(grp); grp.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(grp), sph = box.getBoundingSphere(new THREE.Sphere());
      const size = box.getSize(new THREE.Vector3());
      const az = horizontal ? 0.75 : 0.55, el = horizontal ? 0.42 : 0.12;
      const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
      cam.aspect = w / h;
      const fitV = (Math.max(size.y, size.x * 0.4) / 2 + 0.3) / Math.tan(cam.fov * DEG / 2), fitH = (Math.hypot(size.x, size.z) / 2 + 0.3) / (Math.tan(cam.fov * DEG / 2) * cam.aspect);
      const dist = Math.max(fitV, fitH) * 1.08 + sph.radius * 0.25;
      cam.position.copy(sph.center).addScaledVector(dir, dist); cam.near = Math.max(0.05, dist * 0.02); cam.far = dist * 6; cam.lookAt(sph.center); cam.updateProjectionMatrix();
      let url = '';
      try {
        const img = renderTo(w * 2, h * 2, 0x000000, 0);
        const out = document.createElement('canvas'); out.width = w; out.height = h;
        const ctx = out.getContext('2d');
        const bg = ctx.createRadialGradient(w / 2, h * 0.45, 4, w / 2, h / 2, w * 0.75); bg.addColorStop(0, '#2a3848'); bg.addColorStop(1, '#10161d');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, w, h);
        url = out.toDataURL('image/jpeg', 0.8);
      } catch (err) { console.warn('[builder] craft thumbnail failed:', err && err.message); }
      holder.remove(grp);
      for (const o of objs) freePartObject(meshApi, o);
      return url;
    },
    dispose() { for (const rt of rts.values()) rt.dispose(); for (const e of cache.values()) freePartObject(meshApi, e.g); cache.clear(); },
  };
}

export { asmBounds };
