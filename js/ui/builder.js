// Starwright — the assembly buildings: a 3D part-based vehicle editor that edits a `Craft`.
//
//   createBuilderScreen(app) → { enter(params), exit(), update(dt), render(), resize(w, h) }
//   enter({ craft, site })
//     site   'pad' (default)  → the Vehicle Assembly Building: craft built upright
//            'runway'         → the Spaceplane Hangar: craft built horizontally, nose forward, mirror symmetry
//     quality 'high' | 'low' overrides the automatic choice (low = no GPU: diffuse hall materials, hard shadows)
//     craft  Craft JSON (or a Craft) to edit; otherwise the last design of that building, the career's
//            '__autosave' slot (when it was built for the same site), or an empty hall.
//
// Launch hands over with  app.goto('flight', { craft: craftJSON, crew: [names], paid: true, site })
// (the launch cost is charged and the crew marked 'assigned' here first, mirroring app.launch in main.js).
//
// Files: builder/asm.js (pure assembly maths: nodes, detach / attach, symmetry, re-root, balance),
//        builder/hall.js (the two interiors), builder/gfx.js (markers, gizmos, thumbnails), builder/panels.js (HUD).
//
// How building works
//   · The first part is the ROOT. It hangs where you put it (the crane holds it); nothing is grounded.
//   · While a part is held every open, compatible attachment node glows; near one the held part snaps node to
//     node (amber pulse, snap sound, ring flash on release). Surface parts stick anywhere on a side, facing outward.
//   · Clicking a placed part pulls it off with its whole subtree. Drop it on another node, or in mid-air, where it
//     stays as a translucent loose piece (not part of the craft) until picked up again.
//   Keys: 1 place · 2 move · 3 rotate · 4 re-root · 5 action groups · X / Shift+X symmetry · R radial ↔ mirror ·
//         C angle snap · Alt = nodes only (no surface attach) · F frame · Delete · Esc · ⌘Z / ⇧⌘Z.
//         Turning what you hold: stack parts  Q/E (also A/D) turn about the axis (90° steps, Shift = 5°), W/S flip
//         end for end; surface parts  W/S pitch away from the mount, Q/E (also A/D) roll about the outward axis
//         (15° steps, Shift = 5°).
//         The same keys tilt a selected, placed surface part in the rotate tool.
//   Mouse: right-drag orbit · wheel scrolls along the craft · Shift+wheel zoom · middle-drag pan · double-click focus.
//
// Test hooks: app.builder (see `api` at the bottom).
import * as THREE from '../lib/three.module.min.js';
import { createPostChain } from '../render/post.js';
import { isModalOpen } from './dom.js';
import { PARTS, PART_LIST, partDef } from '../core/parts.js';
import { Craft } from '../core/craft.js';
import { techNode } from '../core/career.js';
import { SYSTEM } from '../core/bodies.js';
import * as A from './builder/asm.js';
import { buildHall } from './builder/hall.js';
import * as G from './builder/gfx.js';
import { createPanels } from './builder/panels.js';

const { COL } = G;
const SYM_STEPS = [1, 2, 3, 4, 6, 8];
const AUTOSAVE = '__autosave';               // the most recent work in progress (either building); per-building copies live in career.settings.builderAutosave
const FOV = 38;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// craft axes → world axes in the spaceplane hangar: nose (+Y) forward along +Z, pilot's head (+Z) up, +X to world −X
const Q_PLANE = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)));

// Does the Craft model keep `flip` (a part mounted upside down) through save / load? Only then is flipping offered.
const SUPPORTS_FLIP = (() => {
  try {
    const d = PART_LIST.find(p => p.attach.stack && !p.topOnly);
    const c = Craft.fromJSON({ name: 't', parts: [{ id: 1, type: d.id, pos: { x: 0, y: 0, z: 0 }, rot: 0, parent: null, node: 'root', sym: 0, flip: true }], stages: [] });
    return c.toJSON().parts[0].flip === true;
  } catch { return false; }
})();

// ---------------------------------------------------------------------------------------------
// Part meshes: js/render/partmesh.js when available, otherwise plain stand-ins.
// ---------------------------------------------------------------------------------------------
let meshApi = null, meshApiPromise = null;
function loadMeshApi() {
  if (meshApi) return Promise.resolve(meshApi);
  if (meshApiPromise) return meshApiPromise;
  const url = new URL('../render/partmesh.js', import.meta.url).href;
  meshApiPromise = (async () => {
    try {
      const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (!head.ok) return null;
      const mod = await import(url);
      if (typeof mod.buildPartMesh === 'function') meshApi = mod;
    } catch (err) { console.warn('[builder] part meshes unavailable, using stand-ins:', err && err.message); }
    return meshApi;
  })();
  meshApiPromise.then(api => { if (!api) meshApiPromise = null; });   // retry on the next visit
  return meshApiPromise;
}
function ensureCss() {
  let link = document.getElementById('sw-builder-css');
  if (link) return link.sheet ? Promise.resolve() : new Promise(r => { link.addEventListener('load', r); link.addEventListener('error', r); setTimeout(r, 1500); });
  link = document.createElement('link');
  link.id = 'sw-builder-css'; link.rel = 'stylesheet';
  link.href = new URL('../../css/builder.css', import.meta.url).href;
  const done = new Promise(r => { link.addEventListener('load', r); link.addEventListener('error', r); setTimeout(r, 1500); });
  document.head.appendChild(link);
  return done;
}

// A short two-tone "clack" for node snaps (procedural; the shared audio module has no such sound).
let snapCtx = null;
function snapSound(app, strong = true) {
  try { app.audio && app.audio.play('click', { volume: strong ? 1 : 0.5 }); } catch { /* no audio */ }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || (app.audio && app.audio.unlocked === false)) return;
    snapCtx = snapCtx || new AC();
    if (snapCtx.state === 'suspended') { snapCtx.resume().catch(() => {}); return; }
    const vol = (app.audio && app.audio.volume ? app.audio.volume.sfx : 0.7) * (strong ? 0.16 : 0.07), t = snapCtx.currentTime;
    for (const [f0, f1, dur, type, at] of [[1400, 520, 0.05, 'square', 0], [660, 990, 0.11, 'triangle', 0.035]]) {
      const o = snapCtx.createOscillator(), g = snapCtx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t + at); o.frequency.exponentialRampToValueAtTime(f1, t + at + dur);
      g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(vol, t + at + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      o.connect(g).connect(snapCtx.destination); o.start(t + at); o.stop(t + at + dur + 0.02);
    }
  } catch { /* audio is optional */ }
}

/** True when WebGL is drawn by the CPU (headless test machines, blocklisted drivers): the hall then uses cheap materials. */
function softwareGL(renderer) {
  try {
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return /swiftshader|llvmpipe|software|basic render/i.test(String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ''));
  } catch { return false; }
}

// The design being worked on in each building survives leaving it.
const last = { pad: null, runway: null };       // { json, loose, origin, desc, career }
let hintDismissed = false;
const snapStats = { count: 0 };

export function createBuilderScreen(app) {
  let career = null, site = 'pad';
  let craft = new Craft('Untitled Craft');
  let loose = [];                      // [{ asm, x, y, z, yaw }] unattached pieces, craft coords
  const meta = { desc: '' };
  let panels = null;
  let scene = null, camera = null, hall = null, craftGroup = null, heldLayer = null, looseLayer = null;
  let nodeFx = null, cursorFx = null, gizmo = null, balanceFx = null, thumbs = null;
  const raycaster = new THREE.Raycaster();
  const partObjs = new Map();          // part id → THREE.Group
  let looseObjs = [];                  // THREE.Group per loose piece
  let offs = [];
  let size = { w: 1, h: 1 };
  let entered = false, enterToken = 0;
  const origin = new THREE.Vector3(), originT = new THREE.Vector3();
  let viewShift = 0;                   // px: the free view between the panels is not centred on the canvas
  let renderState = null;
  let quality = 'high';                // 'low' when there is no GPU (see softwareGL)
  let post = null;                     // ambient occlusion (js/render/post.js with everything else in it turned off); null at 'low'
  const _db = new THREE.Vector2();

  // editor state
  const state = { tool: 'place', symmetry: 1, symMode: 'radial', snap: true, show: { com: false, cot: false, col: false }, body: 'verda', atmo: false, category: 'command', search: '', sort: '' };
  let held = null;                     // { asm, turn, source: 'bin'|'craft'|'loose', obj, ghosts: [], undoAtPickup }
  let hoverId = null, hoverLoose = -1, placement = null;
  let selected = null, gizmoDrag = null, gizmoHover = null;
  let highlightIds = null;
  let undoStack = [], redoStack = [];
  let lastPickup = null;               // { t, x, y, focus } for the double-click guard
  const cam = { yaw: 0.55, pitch: 0.16, dist: 14, ty: 0, fx: 0, fz: 0, tyaw: 0.55, tpitch: 0.16, tdist: 14, tty: 0, tfx: 0, tfz: 0 };
  let drag = null, leftDown = null, boundsKey = '';
  let snappedKey = '', clock = 0, flipWarned = false;
  const settle = new Map();            // part id → { t, dx, dy, dz }: the little push-home after a snap
  let actionGroup = '1';               // the group being edited in the action-groups tool
  let clash = null;                    // ids the move gizmo is currently pushing into each other
  let lastMarkers = [];

  const isCareer = () => !!(career && career.usesFunds);
  const unlocked = id => !career || career.isPartUnlocked(id);
  const toast = (t, k) => app.toast && app.toast(t, k);
  const sfx = name => { try { app.audio && app.audio.play(name); } catch { /* no audio */ } };
  const techName = id => { const n = techNode(id); return n ? n.name : id; };
  const horizontal = () => site === 'runway';

  // ------------------------------------------------------------------ bookkeeping
  const deep = o => JSON.parse(JSON.stringify(o));
  function snapshot() { craft.subassemblies = []; return JSON.stringify({ c: craft.toJSON(), l: loose, o: [originT.x, originT.y, originT.z], d: meta.desc }); }
  function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 120) undoStack.shift(); redoStack = []; }
  function restore(text) {
    const s = JSON.parse(text);
    craft = Craft.fromJSON(s.c); craft.subassemblies = []; loose = s.l || []; meta.desc = s.d || '';
    originT.set(s.o[0], s.o[1], s.o[2]); origin.copy(originT);
    dropHeld(); hoverId = null; placement = null; selected = null;
    changed({ name: true });
  }
  function undo() { cancelHeld(); if (!undoStack.length) return false; redoStack.push(snapshot()); restore(undoStack.pop()); return true; }
  function redo() { cancelHeld(); if (!redoStack.length) return false; undoStack.push(snapshot()); restore(redoStack.pop()); return true; }

  /** The design as saved: the craft plus its notes, its building and the loose pieces parked beside it. */
  function designJSON() {
    craft.desc = meta.desc || ''; craft.site = site; craft.subassemblies = loose;
    const j = craft.toJSON();
    craft.subassemblies = [];
    return j;
  }
  /** Loose pieces carried by a design file → the editor's list (and off the Craft, which only stores them). */
  function takeLoose(c) { const l = deep(c.subassemblies || []); c.subassemblies = []; return l; }
  function remember() { last[site] = { json: designJSON(), loose: deep(loose), origin: [originT.x, originT.y, originT.z], desc: meta.desc, career }; }

  function changed({ name = false, frame = false } = {}) {
    remember();
    if (selected != null && !craft.getPart(selected)) selected = null;
    syncMeshes(); syncLoose(); syncBalance();
    if (panels) { if (name) panels.setName(craft.name); panels.refreshAll(); }
    clampFocus();
    if (frame) frameCraft(); else keepInView();
  }

  /** Where a craft loaded from a file hangs: centred on the bay, clear of the floor. */
  function defaultOrigin() {
    if (craft.isEmpty) return new THREE.Vector3(0, horizontal() ? 5 : 9, 0);
    const b = craft.bounds();
    if (horizontal()) { const e = A.extentAlong(craft.parts, 'z'); return new THREE.Vector3(0, 1.6 - e.lo, -(b.minY + b.maxY) / 2); }
    return new THREE.Vector3(0, 2.6 - b.minY, 0);
  }
  function setCraft(json, { undoable = true, frame = true } = {}) {
    let next;
    try { next = json ? Craft.fromJSON(typeof json.toJSON === 'function' ? json.toJSON() : json) : new Craft('Untitled Craft'); }
    catch (err) { toast('That design could not be opened (' + (err && err.message) + ').', 'bad'); return false; }
    if (undoable) pushUndo();
    dropHeld();
    craft = next; loose = takeLoose(next); meta.desc = next.desc || '';
    settle.clear();
    hoverId = null; placement = null; selected = null;
    originT.copy(defaultOrigin()); origin.copy(originT);
    changed({ name: true, frame });
    return true;
  }

  // ------------------------------------------------------------------ camera
  const freeAspect = () => Math.max(300, size.w - 2 * Math.abs(viewShift) - 560) / Math.max(1, size.h);
  function frameCraft() {
    const b = craft.bounds(), len = b.maxY - b.minY, t = Math.tan(FOV * DEG / 2);
    cam.tty = craft.isEmpty ? 0 : (b.minY + b.maxY) / 2; cam.tfx = 0; cam.tfz = 0;
    if (craft.isEmpty) { cam.tdist = horizontal() ? 22 : 15; cam.tpitch = horizontal() ? 0.3 : 0.16; boundsKey = ''; return; }
    if (horizontal()) {
      cam.tpitch = 0.3;
      const fitH = (len / 2 * 0.86 + b.maxR * 0.7 + 1.5) / (t * freeAspect()), fitV = (b.maxR + 2) / t;
      cam.tdist = clamp(Math.max(fitV, fitH) * 1.15, 7, 90);
    } else {
      cam.tpitch = 0.16;
      const fitV = (len / 2 + 1.4) / t, fitH = (b.maxR + 1.5) / (t * freeAspect());
      cam.tdist = clamp(Math.max(fitV, fitH) * 1.2, 6.5, 90);
      cam.tty -= 0.07 * cam.tdist * t;                        // the bottom bar hides more than the top bar
    }
    boundsKey = [b.minY, b.maxY, b.maxR].map(v => v.toFixed(3)).join('|');
  }
  /** After an edit: if the craft has outgrown the view, pull back / recentre just enough to see all of it. */
  function keepInView() {
    if (craft.isEmpty || !camera) return;
    const b = craft.bounds(), key = [b.minY, b.maxY, b.maxR].map(v => v.toFixed(3)).join('|');
    if (key === boundsKey) return;
    boundsKey = key;
    const t = Math.tan(FOV * DEG / 2);
    if (horizontal()) {
      const need = ((b.maxY - b.minY) / 2 * 0.86 + b.maxR * 0.7 + 1.5) / (t * freeAspect()) * 1.1;
      if (need > cam.tdist) { cam.tdist = clamp(need, 7, 90); cam.tty = (b.minY + b.maxY) / 2; }
      return;
    }
    const half = cam.tdist * t;
    const top = cam.tty + half * 0.80, bottom = cam.tty - half * 0.62;
    if (b.maxY <= top && b.minY >= bottom) return;
    const need = ((b.maxY - b.minY) / 2 + 1.6) / t * 1.2;
    if (need > cam.tdist) { cam.tdist = clamp(need, 6.5, 90); cam.tty = (b.minY + b.maxY) / 2 - 0.07 * cam.tdist * t; }
    else if (b.minY < bottom) cam.tty -= bottom - b.minY;
    else cam.tty += b.maxY - top;
  }
  function clampFocus() {
    const b = craft.bounds();
    let lo = b.minY - 3, hi = b.maxY + 3;
    for (const l of loose) { lo = Math.min(lo, l.y - 3); hi = Math.max(hi, l.y + 3); }
    cam.tty = craft.isEmpty && !loose.length ? clamp(cam.tty, -6, 6) : clamp(cam.tty, lo, hi);
    const m = Math.max(6, b.maxR + 4);
    cam.tfx = clamp(cam.tfx, -m, m); cam.tfz = clamp(cam.tfz, -m, m);
  }
  const focusW = new THREE.Vector3();
  function updateCamera(k) {
    for (const key of ['yaw', 'pitch', 'dist', 'ty', 'fx', 'fz']) cam[key] += (cam['t' + key] - cam[key]) * k;
    origin.lerp(originT, k);
    craftGroup.position.copy(origin);
    craftGroup.updateMatrixWorld(true);
    focusW.set(cam.fx, cam.ty, cam.fz).applyMatrix4(craftGroup.matrixWorld);
    const cp = Math.cos(cam.pitch), s = hall.size;
    camera.position.set(focusW.x + Math.sin(cam.yaw) * cp * cam.dist, focusW.y + Math.sin(cam.pitch) * cam.dist, focusW.z + Math.cos(cam.yaw) * cp * cam.dist);
    camera.position.x = clamp(camera.position.x, -s.w / 2 + 2.5, s.w / 2 - 2.5);
    camera.position.z = clamp(camera.position.z, -s.d / 2 + 2.5, s.d / 2 - 2.5);
    camera.position.y = clamp(camera.position.y, 0.6, s.h - 1.5);
    camera.lookAt(focusW);
    camera.updateMatrixWorld(true);
  }
  const worldPerPixel = () => 2 * cam.dist * Math.tan(FOV * DEG / 2) / Math.max(1, size.h);
  function layoutView() {
    if (!panels || !camera) return;
    const r = panels.root.getBoundingClientRect();
    const tools = panels.dom.tools.getBoundingClientRect(), right = panels.root.querySelector('.bld-right').getBoundingClientRect();
    const centre = ((tools.right - r.left) + (right.left - r.left)) / 2;
    viewShift = Math.round(centre - size.w / 2);
    camera.aspect = size.w / size.h;
    camera.setViewOffset(size.w, size.h, -viewShift, 0, size.w, size.h);
    camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ 3D craft
  function syncMeshes() {
    if (!craftGroup) return;
    const seen = new Set();
    for (const p of craft.parts) {
      seen.add(p.id);
      let g = partObjs.get(p.id);
      if (g && g.userData.bldType !== p.type) { G.freePartObject(meshApi, g); g = null; }
      if (!g) {
        g = G.makePartObject(meshApi, partDef(p.type));
        g.userData.bldType = p.type; g.userData.partId = p.id;
        craftGroup.add(g); partObjs.set(p.id, g);
      }
      G.posePart(g, p.pos.x, p.pos.y, p.pos.z, p.rot, !!p.flip, p.pitch || 0, p.roll || 0);
      g.scale.setScalar(1);
    }
    for (const [id, g] of partObjs) if (!seen.has(id)) { G.freePartObject(meshApi, g); partObjs.delete(id); }
    for (const id of settle.keys()) if (!seen.has(id)) settle.delete(id);
    syncInterstages();
  }
  /** The lattice rings between stages (craft.interstages()): drawn on the part that carries each one, so they move
   *  with it. They come and go by themselves as parts are stacked under an engine or taken away. */
  let trussCount = 0;
  function syncInterstages() {
    if (!meshApi || typeof meshApi.setPartInterstages !== 'function' || typeof craft.interstages !== 'function') return;
    const by = new Map();
    let list = [];
    try { list = craft.interstages(); } catch { list = []; }
    for (const t of list) {
      const owner = craft.getPart(t.owner);
      if (!owner) continue;
      if (!by.has(t.owner)) by.set(t.owner, []);
      by.get(t.owner).push({ side: t.dir * (owner.flip ? -1 : 1), h: t.h, r0: t.r0, r1: t.r1 });
    }
    for (const [id, g] of partObjs) { if (g.userData.fallback) continue; try { meshApi.setPartInterstages(g, by.get(id) || null); } catch { /* cosmetic */ } }
    trussCount = list.length;
  }
  let interstageSaid = false;
  /** Parts that were just attached slide the last few centimetres home and "clunk" (a quick overshoot). */
  function startSettle(parts, specs, node) {
    for (const p of parts) {
      let dx = 0, dy = 0, dz = 0;
      if (p.node === 'top') dy = 1; else if (p.node === 'bottom') dy = -1;
      else if (p.node === 'radial' || p.node === 'outer') { const o = A.outward(p.rot); dx = o.x; dz = o.z; }
      else { const q = p.parent != null ? craft.getPart(p.parent) : null; if (q) { dx = p.pos.x - q.pos.x; dy = p.pos.y - q.pos.y; dz = p.pos.z - q.pos.z; const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l; } else dy = 1; }
      // children ride along with the part they hang from
      let r = p; while (r.parent != null && settle.has(r.parent)) r = craft.getPart(r.parent);
      const base = r !== p ? settle.get(r.id) : null;
      settle.set(p.id, base ? { ...base } : { t: 0, dx, dy, dz });
    }
  }
  function updateSettle(dt) {
    if (!settle.size) return;
    for (const [id, s] of settle) {
      s.t += dt / 0.28;
      const p = craft.getPart(id), g = partObjs.get(id);
      if (!p || !g || s.t >= 1) { settle.delete(id); if (p && g) { G.posePart(g, p.pos.x, p.pos.y, p.pos.z, p.rot, !!p.flip, p.pitch || 0, p.roll || 0); g.scale.setScalar(1); } continue; }
      // a damped spring: starts 16 cm out, overshoots a hair into the joint, rings once
      const k = 0.16 * Math.exp(-5.5 * s.t) * Math.cos(s.t * 9.5);
      g.position.set(p.pos.x + s.dx * k, p.pos.y + s.dy * k, p.pos.z + s.dz * k);
      g.scale.setScalar(1 + 0.035 * Math.exp(-7 * s.t) * Math.sin(s.t * 14));
    }
  }
  function syncLoose() {
    if (!looseLayer) return;
    for (const g of looseObjs) G.freeAssemblyObject(meshApi, g);
    looseObjs = loose.map((l, i) => {
      const g = G.makeAssemblyObject(meshApi, l.asm, { ghost: true });
      G.setAssemblyPose(g, l.asm, { x: l.x, y: l.y, z: l.z, yaw: l.yaw || 0, mirror: false });
      G.tintAssembly(meshApi, g, COL.neutral);
      g.userData.looseIndex = i; looseLayer.add(g);
      return g;
    });
  }
  function syncBalance() {
    if (!balanceFx) return;
    balanceFx.bal = A.balance(craft);
  }
  function buildHeldObjects() {
    if (!held) return;
    held.obj = G.makeAssemblyObject(meshApi, held.asm); heldLayer.add(held.obj);
    held.obj.traverse(o => { if (o.isMesh) o.castShadow = false; });
    held.ghosts = [];
  }
  function freeHeldObjects() {
    if (!held) return;
    if (held.obj) G.freeAssemblyObject(meshApi, held.obj);
    for (const g of held.ghosts || []) G.freeAssemblyObject(meshApi, g);
    held.obj = null; held.ghosts = [];
  }
  function dropHeld() { if (held) { freeHeldObjects(); held = null; } placement = null; snappedKey = ''; }

  function applyHighlights() {
    const lit = new Map();
    if (highlightIds) for (const id of highlightIds) lit.set(id, COL.amber);
    if (selected != null && (state.tool === 'move' || state.tool === 'rotate')) for (const q of craft.subtree(selected)) lit.set(q.id, COL.amber);
    if (state.tool === 'action') {
      for (const a of craft.groupActions(actionGroup)) lit.set(a.part, COL.violet);
      if (selected != null) for (const m of craft.symmetryGroup(selected)) lit.set(m.id, COL.amber);
    }
    if (clash) for (const id of clash.ids) lit.set(id, COL.red);
    if (!held && hoverId != null) {
      const p = craft.getPart(hoverId);
      if (p) {
        if (state.tool === 'place') for (const m of craft.symmetryGroup(p)) for (const q of craft.subtree(m)) lit.set(q.id, COL.amber);
        lit.set(p.id, COL.teal);
      }
    }
    if (held && placement && placement.action && placement.action.target != null) lit.set(placement.action.target, COL.teal);
    for (const [id, g] of partObjs) G.tintPartObject(meshApi, g, lit.has(id) ? lit.get(id) : null);
    looseObjs.forEach((g, i) => G.tintAssembly(meshApi, g, !held && i === hoverLoose ? COL.amber : COL.neutral));
  }

  // ------------------------------------------------------------------ picking
  const ndc = new THREE.Vector2(), v3 = new THREE.Vector3(), v3b = new THREE.Vector3(), plane = new THREE.Plane(), qInv = new THREE.Quaternion();
  function setRay(x, y) { ndc.set(x / size.w * 2 - 1, -(y / size.h * 2 - 1)); raycaster.setFromCamera(ndc, camera); }
  function hitsAt(x, y) {
    setRay(x, y);
    const raw = raycaster.intersectObjects([...partObjs.values()], true);
    const out = [], seen = new Set();
    qInv.copy(craftGroup.quaternion).invert();
    for (const h of raw) {
      let o = h.object, id = null, vis = true;
      while (o && o !== craftGroup) { if (!o.visible) vis = false; if (o.userData && o.userData.partId != null) id = o.userData.partId; o = o.parent; }
      if (!vis || id == null || seen.has(id)) continue;
      const part = craft.getPart(id);
      if (!part) continue;
      seen.add(id);
      const p = craftGroup.worldToLocal(h.point.clone());
      const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld).applyQuaternion(qInv) : new THREE.Vector3(1, 0, 0);
      out.push({ part, point: { x: p.x, y: p.y, z: p.z }, normal: { x: n.x, y: n.y, z: n.z } });
    }
    return out;
  }
  function looseAt(x, y) {
    if (!looseObjs.length) return -1;
    setRay(x, y);
    const raw = raycaster.intersectObjects(looseObjs, true);
    for (const h of raw) { let o = h.object; while (o && o.userData.looseIndex == null) o = o.parent; if (o) return o.userData.looseIndex; }
    return -1;
  }
  /** The pointer on a camera-facing plane through the view focus → craft coords. */
  function freePoint(x, y) {
    setRay(x, y);
    camera.getWorldDirection(v3);
    if (cam.pitch < 0.9) v3.y = 0;
    if (v3.lengthSq() < 1e-6) v3.set(0, 0, -1);
    plane.setFromNormalAndCoplanarPoint(v3.normalize(), focusW);
    const p = raycaster.ray.intersectPlane(plane, v3b);
    if (!p) return { x: cam.fx, y: cam.ty, z: cam.fz };
    // keep it inside the hall and off the floor
    p.x = clamp(p.x, -hall.size.w / 2 + 6, hall.size.w / 2 - 6); p.z = clamp(p.z, -hall.size.d / 2 + 6, hall.size.d / 2 - 6); p.y = clamp(p.y, 0.6, hall.size.h - 6);
    craftGroup.worldToLocal(p);
    return { x: p.x, y: p.y, z: p.z };
  }
  function toScreen(cx, cy, cz) {
    v3.set(cx, cy, cz).applyMatrix4(craftGroup.matrixWorld).project(camera);
    return { x: (v3.x + 1) / 2 * size.w, y: (1 - v3.y) / 2 * size.h };
  }
  /** The pointer ray in craft coordinates. */
  function localRay(x, y) {
    setRay(x, y);
    const inv = new THREE.Matrix4().copy(craftGroup.matrixWorld).invert();
    return raycaster.ray.clone().applyMatrix4(inv);
  }

  // ------------------------------------------------------------------ placement solving
  function heldSpecFree(free) { return { parentId: null, node: 'free', x: free.x, y: free.y, z: free.z, yaw: held.turn, mirror: false }; }

  function surfaceAction(h, d) {
    const t = h.part, td = partDef(t.type);
    if (td.attach.stack) {
      let angle = Math.atan2(-(h.point.z - t.pos.z), h.point.x - t.pos.x);
      let py = clamp(h.point.y, t.pos.y - td.h / 2, t.pos.y + td.h / 2);
      if (state.snap) {
        angle = Math.round(angle / (15 * DEG)) * 15 * DEG;
        const snapD = Math.max(0.06, worldPerPixel() * 9), edge = td.h / 2 - d.h / 2;
        const stops = edge > 0.05 ? [t.pos.y, t.pos.y + edge, t.pos.y - edge] : [t.pos.y];
        let best = null;
        for (const s of stops) if (Math.abs(s - py) < snapD && (best === null || Math.abs(s - py) < Math.abs(best - py))) best = s;
        if (best !== null) py = best;
      }
      return { action: { kind: 'radial', target: t.id, y: py, angle, symmetry: state.symmetry }, spec: A.surfaceSpec(craft, held.asm, t.id, py, angle) };
    }
    // a surface on a non-stack part (a wing, a pylon): sit on the face that was hit
    // (a wing lying flat offers its broad faces: the part then stands on the face, pitched to point along the normal)
    const n = h.normal, flat = Math.hypot(n.x, n.z), half = A.radialW(d) / 2, root = held.asm.parts[0];
    let spec;
    if (flat > 0.3) {
      const yaw = Math.atan2(-n.z, n.x), pt = root.pitch || 0;
      spec = { parentId: t.id, node: 'radial', x: h.point.x + n.x / flat * half * Math.cos(pt), y: h.point.y + half * Math.sin(pt), z: h.point.z + n.z / flat * half * Math.cos(pt), yaw, mirror: false };
    } else {
      // an edge that looks along the stack axis (a wing's trailing edge): the part keeps the parent's heading and
      // sits fore or aft of the edge, which is where an elevon belongs
      spec = { parentId: t.id, node: 'radial', x: h.point.x, y: h.point.y + Math.sign(n.y || 1) * d.h / 2, z: h.point.z, yaw: t.rot, mirror: false };
    }
    const yaw = spec.yaw;
    return { action: { kind: 'radial', target: t.id, y: spec.y, angle: yaw, symmetry: state.symmetry, free: true }, spec };
  }

  /** Where would the held assembly go for the mouse at (x, y)? → { state, action, specs, node, why } */
  function solvePlacement(x, y, alt) {
    const asm = held.asm, d = A.asmDef(asm);
    const free = freePoint(x, y);
    const floating = { action: null, specs: [heldSpecFree(free)], state: 'free' };
    if (craft.isEmpty) {
      if (A.canBeRoot(asm)) return { action: { kind: 'root' }, specs: [heldSpecFree(free)], state: 'valid' };
      return { ...floating, why: 'Start with a stack part such as a capsule, probe core or tank.' };
    }
    const hits = hitsAt(x, y);
    let action = null, spec = null, node = null;
    if (d.attach.radial && !alt) {
      for (const h of hits) {
        if (!A.canSurface(craft, asm, h.part.id)) continue;
        ({ action, spec } = surfaceAction(h, d));
        break;
      }
    }
    if (!action && d.attach.stack) {
      const open = A.openNodes(craft);
      const pickNode = (partId, n) => open.find(o => o.partId === partId && o.node === n);
      for (const h of hits) {
        const t = h.part, td = partDef(t.type);
        if (td.attach.outer) { if (A.canOuter(craft, asm, t.id)) { action = { kind: 'outer', target: t.id }; node = pickNode(t.id, 'outer'); } break; }
        if (!td.attach.stack) continue;                 // fins and the like: look at what is behind them
        const f = (h.point.y - t.pos.y) / (td.h / 2);
        const order = f > 1 / 3 ? ['top'] : f < -1 / 3 ? ['bottom'] : f >= 0 ? ['top', 'bottom'] : ['bottom', 'top'];
        for (const n of order) if (A.canStack(craft, asm, t.id, n)) { action = { kind: 'stack', target: t.id, node: n }; node = pickNode(t.id, n); break; }
        break;
      }
      if (!action) {
        // Nothing under the pointer attaches: snap node to node when a held node comes near an open craft node.
        const hn = A.asmNodes(asm);
        const thr = clamp(d.h / worldPerPixel() * 0.3 + 26, 44, 120);
        let best = thr;
        for (const o of open) {
          let dist = Infinity;
          if (o.node === 'outer') {
            if (!A.canOuter(craft, asm, o.partId)) continue;
            const s = toScreen(o.x + o.dir.x * (d.r || 0), o.y, o.z + o.dir.z * (d.r || 0));
            dist = Math.hypot(s.x - x, s.y - y);
          } else {
            if (!A.canStack(craft, asm, o.partId, o.node)) continue;
            const mine = hn.find(n => n.node === (o.node === 'top' ? 'bottom' : 'top'));
            const a = toScreen(o.x, o.y, o.z), b = toScreen(free.x, free.y + mine.y, free.z);
            const c = toScreen(o.x, o.y + (o.node === 'top' ? 1 : -1) * d.h / 2, o.z);
            dist = Math.min(Math.hypot(a.x - x, a.y - y), Math.hypot(a.x - b.x, a.y - b.y), Math.hypot(c.x - x, c.y - y));
          }
          if (dist < best) { best = dist; node = o; action = o.node === 'outer' ? { kind: 'outer', target: o.partId } : { kind: 'stack', target: o.partId, node: o.node }; }
        }
      }
      if (action) spec = action.kind === 'outer' ? A.outerSpec(craft, asm, action.target) : A.stackSpec(craft, asm, action.target, action.node, held.turn);
    }
    if (action && spec) {
      const specs = A.symmetryCopies(craft, spec, { mode: state.symMode, n: state.symmetry });
      return { action, specs, state: 'valid', node };
    }
    if (hits.length) {
      const why = d.attach.radial ? (alt ? 'Alt held: snapping to nodes only.' : `${d.name} needs a surface it can mount on.`) : 'No open attachment node there.';
      return { ...floating, state: 'invalid', why };
    }
    return floating;
  }

  /** Spec list for an explicit action (test hook and Shift-repeat). */
  function specsFor(a) {
    const asm = held.asm;
    if (a.kind === 'root') return A.canBeRoot(asm) && craft.isEmpty ? [{ parentId: null, node: 'root', x: 0, y: 0, z: 0, yaw: held.turn, mirror: false }] : [];
    let spec = null;
    if (a.kind === 'stack') { if (!A.canStack(craft, asm, a.target, a.node)) return []; spec = A.stackSpec(craft, asm, a.target, a.node, held.turn); }
    else if (a.kind === 'outer') { if (!A.canOuter(craft, asm, a.target)) return []; spec = A.outerSpec(craft, asm, a.target); }
    else if (a.kind === 'radial') { if (!A.canSurface(craft, asm, a.target)) return []; spec = A.surfaceSpec(craft, asm, a.target, a.y, a.angle); }
    if (!spec) return [];
    return A.symmetryCopies(craft, spec, { mode: a.mode || state.symMode, n: a.symmetry ?? state.symmetry });
  }

  function applyPlacement(pl, { keep = false } = {}) {
    const asm = held.asm, a = pl.action;
    if (!held.undoAtPickup) pushUndo();
    let made = [];
    if (a && a.kind === 'root') {
      // the first part hangs where it was dropped: the craft origin moves there, loose pieces stay put in the hall
      const s = pl.specs[0];
      const w = new THREE.Vector3(s.x, s.y, s.z).applyMatrix4(craftGroup.matrixWorld);
      const shift = craftGroup.worldToLocal(w.clone());
      for (const l of loose) { l.x -= shift.x; l.y -= shift.y; l.z -= shift.z; }
      origin.copy(w); originT.copy(w); craftGroup.position.copy(origin); craftGroup.updateMatrixWorld(true);
      // the view does not jump: the focus stays on the same point of the hall
      cam.fx -= shift.x; cam.tfx -= shift.x; cam.ty -= shift.y; cam.tty -= shift.y; cam.fz -= shift.z; cam.tfz -= shift.z;
      made = A.attach(craft, asm, [{ parentId: null, node: 'root', x: 0, y: 0, z: 0, yaw: held.turn, mirror: false }]);
      if (panels && panels.name) craft.name = panels.name;
    } else if (a) {
      const before = trussCount;
      made = A.attach(craft, asm, pl.specs);
      if (made.length) startSettle(made);
      // the first time a stage goes under an engine, say what the lattice ring that appeared is
      if (made.length && !interstageSaid) {
        let now = 0, kg = 0;
        try { const l = craft.interstages(); now = l.length; kg = l.reduce((m, t) => m + t.mass, 0) / now; } catch { now = 0; }
        if (now > before) {
          interstageSaid = true;
          toast(`Interstage truss added (about ${Math.round(kg)} kg): an open lattice ring joins this stage to the rim above the engine, so nothing rests on the nozzle. It drops away with the lower stage.`, 'info');
        }
      }
    } else {
      const s = pl.specs[0];
      loose.push({ asm: A.cloneAssembly(asm), x: s.x, y: s.y, z: s.z, yaw: s.yaw });
    }
    if (a && !made.length) { if (!held.undoAtPickup) undoStack.pop(); return made; }
    // feedback: the snap
    if (a) {
      const n = pl.node, s0 = pl.specs[0];
      if (a.kind === 'root') cursorFx.flash({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.8, COL.teal);
      else for (const s of pl.specs) cursorFx.flash(n && s === s0 ? n : s, n && s === s0 ? n.dir : A.outward(s.yaw), n ? Math.max(0.35, n.r) : 0.35, COL.amber);
      snapSound(app, true); snapStats.count++;
    } else sfx('click');
    const again = keep ? { asm: A.cloneAssembly(asm), turn: held.turn } : null;
    dropHeld();
    if (again) { held = { ...again, source: 'bin', undoAtPickup: false }; buildHeldObjects(); }
    changed({});
    if (panels) panels.refreshCatalogueSelection();
    return a ? made : [true];
  }

  // ------------------------------------------------------------------ holding, picking up, deleting
  function pick(type) {
    if (!PARTS[type] || PARTS[type].hidden) return false;
    if (!unlocked(type)) { toast(`${PARTS[type].name} is locked: research ${techName(PARTS[type].tech)} first.`, 'warn'); return false; }
    cancelHeld();
    setTool('place');
    held = { asm: A.newAssembly(type), turn: 0, source: 'bin', undoAtPickup: false };
    buildHeldObjects();
    hoverId = null; placement = null; selected = null;
    if (panels) { panels.refreshCatalogueSelection(); panels.dismissHint(false); }
    return true;
  }
  /** Put the held part back: a part pulled off the craft returns to where it was; one from the bin is discarded. */
  function cancelHeld() {
    if (!held) return false;
    const back = held.undoAtPickup;
    dropHeld();
    if (back && undoStack.length) { const s = undoStack.pop(); restore(s); }
    if (panels) panels.refreshCatalogueSelection();
    return true;
  }
  function pickUpPart(id, mouse, { copy = false } = {}) {
    const p = craft.getPart(id);
    if (!p) return false;
    const focus = { y: p.pos.y, x: p.pos.x, z: p.pos.z };
    if (copy) {
      const asm = A.assemblyOf(craft, id);
      held = { asm, turn: 0, source: 'bin', undoAtPickup: false };
    } else {
      pushUndo();
      lastPickup = { t: performance.now(), x: mouse ? mouse.x : 0, y: mouse ? mouse.y : 0, focus };
      const parent = p.parent !== null ? craft.getPart(p.parent) : null;
      const d = A.detach(craft, id);
      if (p.node === 'radial' && SYM_STEPS.includes(d.count)) { state.symmetry = d.count; state.symMode = d.mirror ? 'mirror' : (horizontal() && d.count === 2 ? state.symMode : 'radial'); }
      held = { asm: d.asm, turn: A.wrapPi(d.from.yaw - (parent ? parent.rot : 0)), source: 'craft', undoAtPickup: true };
    }
    buildHeldObjects();
    hoverId = null; selected = null;
    changed({});
    if (panels) panels.refreshCatalogueSelection();
    return true;
  }
  function pickUpLoose(i, mouse) {
    const l = loose[i];
    if (!l) return false;
    pushUndo();
    lastPickup = { t: performance.now(), x: mouse ? mouse.x : 0, y: mouse ? mouse.y : 0, focus: null };
    loose.splice(i, 1);
    held = { asm: l.asm, turn: l.yaw || 0, source: 'loose', undoAtPickup: true };
    buildHeldObjects(); hoverLoose = -1;
    changed({});
    return true;
  }
  function deletePart(id) {
    const p = craft.getPart(id);
    if (!p) return false;
    pushUndo(); A.remove(craft, p.id); hoverId = null; selected = null; changed({});
    return true;
  }
  function deleteHeld() {
    if (!held) return false;
    dropHeld();                                  // a part pulled off the craft stays deleted; ⌘Z brings it back
    changed({});
    if (panels) panels.refreshCatalogueSelection();
    return true;
  }

  function setSymmetry(n) { state.symmetry = SYM_STEPS.includes(n) ? n : 1; if (state.symMode === 'mirror' && state.symmetry > 2) state.symMode = 'radial'; if (panels) panels.refreshToolbar(); }
  function cycleSymmetry(dir) {
    if (state.symMode === 'mirror') { setSymmetry(state.symmetry > 1 ? 1 : 2); return; }
    const i = SYM_STEPS.indexOf(state.symmetry);
    setSymmetry(SYM_STEPS[(i + dir + SYM_STEPS.length) % SYM_STEPS.length]);
  }
  function setSymMode(mode) {
    state.symMode = mode === 'mirror' ? 'mirror' : 'radial';
    if (state.symMode === 'mirror' && state.symmetry !== 1) state.symmetry = 2;
    if (panels) panels.refreshToolbar();
  }
  function setTool(t) {
    if (!['place', 'move', 'rotate', 'root', 'action'].includes(t)) return;
    if (t !== 'place' && held) cancelHeld();
    const was = state.tool;
    state.tool = t; gizmoDrag = null; clash = null;
    if (t === 'place' || t === 'root' || (t === 'action') !== (was === 'action')) selected = null;
    if (panels) { panels.refreshToolbar(); panels.refreshActions(); }
  }
  const heldIsSurface = () => !!held && !partDef(held.asm.parts[0].type).attach.stack;
  /** Q / E: stack parts turn about their axis; surface parts roll about the outward axis. */
  function turnHeld(dir, fine) {
    const step = (fine ? 5 : 90) * DEG * dir, lean = (fine ? 5 : 15) * DEG * dir;    // surface parts lean in smaller steps
    if (held) {
      if (heldIsSurface()) return tiltHeld(0, lean);
      held.turn = A.wrapPi(held.turn + step); return true;
    }
    if (selected != null && (state.tool === 'rotate' || state.tool === 'move')) {
      const p = craft.getPart(selected);
      if (p && state.tool === 'rotate' && p.node === 'radial' && !partDef(p.type).attach.stack && !craft.children(p).length) return tiltSelected(0, lean);
      pushUndo(); A.rotateSubtree(craft, selected, step); changed({}); return true;
    }
    return false;
  }
  /** Pitch / roll of the held surface part (a single part: what hangs off it would not follow). */
  function tiltHeld(dPitch, dRoll) {
    if (!held || !heldIsSurface()) return false;
    if (held.asm.parts.length > 1) { toast('Only a single surface part can be tilted. Pull the attached parts off first.', 'info'); return false; }
    const r = held.asm.parts[0];
    const pt = A.wrapPi((r.pitch || 0) + dPitch), rl = A.wrapPi((r.roll || 0) + dRoll);
    if (Math.abs(pt) > 1e-9) r.pitch = pt; else delete r.pitch;
    if (Math.abs(rl) > 1e-9) r.roll = rl; else delete r.roll;
    return true;
  }
  function tiltSelected(dPitch, dRoll) {
    if (selected == null) return false;
    const snap = snapshot();
    if (!A.tiltPart(craft, selected, dPitch, dRoll)) { toast('Only a surface part with nothing attached to it can be tilted.', 'info'); return false; }
    undoStack.push(snap); redoStack = [];
    changed({});
    return true;
  }
  /** W / S: stack parts (with everything attached) flip end for end; surface parts pitch away from their mount. */
  function flipHeld(dir = 1, fine = false) {
    if (!held) {
      if (selected != null && state.tool === 'rotate') return tiltSelected((fine ? 5 : 15) * DEG * dir, 0);
      return false;
    }
    if (heldIsSurface()) return tiltHeld((fine ? 5 : 15) * DEG * dir, 0);
    if (!SUPPORTS_FLIP) { if (!flipWarned) { toast('Parts turn about their own axis here (Q / E). Tipping a part over is not part of the craft model yet.', 'info'); flipWarned = true; } return false; }
    A.flipAssembly(held.asm);
    held.turn = A.wrapPi(-held.turn);
    freeHeldObjects(); buildHeldObjects();
    return true;
  }

  // ------------------------------------------------------------------ gizmos (move / rotate placed parts)
  function gizmoHit(x, y) {
    if (selected == null || !gizmo.group.visible) return null;
    const p = craft.getPart(selected); if (!p) return null;
    const s = gizmo.size;
    const segDist = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1; const t = clamp(((x - a.x) * dx + (y - a.y) * dy) / l2, 0, 1); return Math.hypot(a.x + dx * t - x, a.y + dy * t - y); };
    if (state.tool === 'move') {
      let best = null, bd = 13;
      for (const k of ['x', 'y', 'z']) {
        const v = gizmo.axes[k].v, a = toScreen(p.pos.x + v.x * s * 0.15, p.pos.y + v.y * s * 0.15, p.pos.z + v.z * s * 0.15), b = toScreen(p.pos.x + v.x * s * 1.3, p.pos.y + v.y * s * 1.3, p.pos.z + v.z * s * 1.3);
        const dd = segDist(a, b); if (dd < bd) { bd = dd; best = k; }
      }
      return best;
    }
    if (state.tool === 'rotate') {
      let bd = 12, prev = null;
      for (let i = 0; i <= 48; i++) {
        const a = i / 48 * Math.PI * 2, q = toScreen(p.pos.x + Math.cos(a) * s, p.pos.y, p.pos.z - Math.sin(a) * s);
        if (prev) bd = Math.min(bd, segDist(prev, q));
        prev = q;
      }
      return bd < 12 ? 'ring' : null;
    }
    return null;
  }
  function axisParam(ray, o, v) {
    // parameter along the line o + t·v closest to the ray
    const w = new THREE.Vector3().subVectors(ray.origin, o), b = ray.direction.dot(v), d0 = ray.direction.dot(w), e = v.dot(w), den = 1 - b * b;
    return Math.abs(den) < 1e-5 ? 0 : (e - b * d0) / den;
  }
  function ringAngle(ray, p) {
    const t = (p.pos.y - ray.origin.y) / (Math.abs(ray.direction.y) < 1e-5 ? 1e-5 : ray.direction.y);
    const hx = ray.origin.x + ray.direction.x * t, hz = ray.origin.z + ray.direction.z * t;
    const c = pivotOf(p);
    return Math.atan2(-(hz - c.z), hx - c.x);
  }
  function pivotOf(p) { const parent = p.node === 'radial' && p.parent !== null ? craft.getPart(p.parent) : null; return parent ? { x: parent.pos.x, z: parent.pos.z } : { x: p.pos.x, z: p.pos.z }; }
  function beginGizmoDrag(handle, x, y) {
    const p = craft.getPart(selected); if (!p) return;
    const ray = localRay(x, y);
    pushUndo();
    gizmoDrag = { handle, applied: 0, changed: false };
    if (handle === 'ring') gizmoDrag.start = ringAngle(ray, p);
    else { gizmoDrag.o = new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z); gizmoDrag.v = gizmo.axes[handle].v.clone(); gizmoDrag.start = axisParam(ray, gizmoDrag.o, gizmoDrag.v); gizmoDrag.free = 0; }
    clash = null;
  }
  function moveGizmoDrag(x, y) {
    const p = craft.getPart(selected); if (!p || !gizmoDrag) return;
    const ray = localRay(x, y);
    if (gizmoDrag.handle === 'ring') {
      const total = A.wrapPi(ringAngle(ray, p) - gizmoDrag.start);        // swept since the last applied step
      const want = state.snap ? Math.round((gizmoDrag.applied + total) / (15 * DEG)) * 15 * DEG : gizmoDrag.applied + total;
      const step = want - gizmoDrag.applied;
      gizmoDrag.start = A.wrapPi(gizmoDrag.start + (state.snap ? step : total));
      if (Math.abs(step) > 1e-6) { A.rotateSubtree(craft, selected, step); gizmoDrag.applied = want; gizmoDrag.changed = true; syncMeshes(); syncBalance(); }
    } else {
      let total = axisParam(ray, gizmoDrag.o, gizmoDrag.v) - gizmoDrag.start;
      if (state.snap) total = Math.round(total / 0.1) * 0.1;
      total = clamp(total, -30, 30);
      const step = total - gizmoDrag.applied;
      if (Math.abs(step) > 1e-6) {
        const v = gizmoDrag.v; A.moveSubtree(craft, selected, v.x * step, v.y * step, v.z * step); gizmoDrag.applied = total; gizmoDrag.changed = true;
        // collision check: remember the last offset that was clear of every other part
        const hits = A.collisions(craft, selected);
        if (hits.length) clash = { ids: new Set(hits.flatMap(h => [h.a, h.b])), with: hits[0].b };
        else { clash = null; gizmoDrag.free = total; }
        syncMeshes(); syncBalance();
      }
    }
  }
  function endGizmoDrag() {
    if (!gizmoDrag) return;
    const d = gizmoDrag; gizmoDrag = null;
    if (!d.changed) { undoStack.pop(); return; }
    if (clash && d.handle !== 'ring') {
      // dropped inside another part: slide back to the last clear spot
      const back = (d.free ?? 0) - d.applied, v = d.v, other = craft.getPart(clash.with);
      A.moveSubtree(craft, selected, v.x * back, v.y * back, v.z * back);
      toast(`That would push it into ${other ? partDef(other.type).name : 'another part'}: moved back to the last clear spot.`, 'warn');
      clash = null;
      if (Math.abs(d.free ?? 0) < 1e-6) { undoStack.pop(); syncMeshes(); syncBalance(); return; }
    }
    clash = null;
    changed({});
  }
  /** Test / keyboard access to the same edits the gizmos make. */
  function nudge(id, dx, dy, dz, { check = false } = {}) {
    if (!craft.getPart(id)) return false;
    pushUndo(); A.moveSubtree(craft, id, dx, dy, dz);
    if (check && A.collisions(craft, id).length) { A.moveSubtree(craft, id, -dx, -dy, -dz); undoStack.pop(); return false; }
    changed({}); return true;
  }
  function spin(id, ang) { if (!craft.getPart(id)) return false; pushUndo(); A.rotateSubtree(craft, id, ang); changed({}); return true; }
  function reroot(id) {
    const snap = snapshot(), r = A.reroot(craft, id);
    if (!r.ok) { toast(r.why, 'warn'); return false; }
    undoStack.push(snap); redoStack = [];
    changed({}); sfx('click');
    toast(`${partDef(craft.root.type).name} is now the root part.`, 'good');
    return true;
  }

  // ------------------------------------------------------------------ input
  function onMouseDown(e) {
    if (isModalOpen()) return;
    if (e.button === 2) drag = { mode: 'orbit', moved: 0, button: 2 };
    else if (e.button === 1) drag = { mode: 'pan', moved: 0, button: 1 };
    else if (e.button === 0) {
      leftDown = { x: e.x, y: e.y };
      if (!held && (state.tool === 'move' || state.tool === 'rotate')) {
        const h = gizmoHit(e.x, e.y);
        if (h) { beginGizmoDrag(h, e.x, e.y); drag = { mode: 'gizmo', moved: 0, button: 0 }; return; }
      }
      if (!held && hoverId == null && hoverLoose < 0) drag = { mode: 'orbit', moved: 0, button: 0 };
    }
  }
  function onMouseMove(e) {
    if (!drag) return;
    drag.moved += Math.abs(e.dx) + Math.abs(e.dy);
    if (drag.mode === 'gizmo') moveGizmoDrag(e.x, e.y);
    else if (drag.mode === 'orbit') {
      cam.tyaw -= e.dx * 0.0065;
      cam.tpitch = clamp(cam.tpitch + e.dy * 0.005, -0.45, 1.45);
    } else panBy(e.dx, e.dy);
  }
  function onMouseUp(e) {
    if (drag && (e.button === drag.button || e.released)) {
      const d = drag; drag = null;
      if (d.mode === 'gizmo') endGizmoDrag();
      if (d.button === 2 && d.moved < 6 && held && !isModalOpen()) cancelHeld();
    }
  }
  /** Slide the view focus in the screen plane by (dx, dy) pixels. */
  function panBy(dx, dy) {
    const k = worldPerPixel();
    qInv.copy(craftGroup.quaternion).invert();
    const right = v3.setFromMatrixColumn(camera.matrixWorld, 0).applyQuaternion(qInv).clone();
    const up = v3b.setFromMatrixColumn(camera.matrixWorld, 1).applyQuaternion(qInv);
    cam.tfx += (-right.x * dx + up.x * dy) * k; cam.tty += (-right.y * dx + up.y * dy) * k; cam.tfz += (-right.z * dx + up.z * dy) * k;
    clampFocus();
  }
  function onWheel(e) {
    if (isModalOpen()) return;
    if (e.shift || e.pinch) { cam.tdist = clamp(cam.tdist / e.zoom, 2.6, 90); return; }
    // Scroll along the craft. Free-spinning wheels send floods of events: clamp each one and never let the target
    // run more than a quarter of a screen ahead of the view, so a flick glides (about three screens a second at
    // most) instead of flinging the view; clampFocus keeps it on the craft whatever happens.
    const k = worldPerPixel(), viewH = size.h * k;
    const step = clamp(e.dy, -110, 110) * k * 0.9;
    const dir = horizontal() ? 1 : -1;
    let next = cam.tty + dir * step;
    next = clamp(next, cam.ty - viewH * 0.28, cam.ty + viewH * 0.28);
    cam.tty = next;
    clampFocus();
  }
  function onClick(e) {
    if (isModalOpen() || e.button !== 0) return;
    if (leftDown && Math.hypot(e.x - leftDown.x, e.y - leftDown.y) > 6) return;     // that was a drag
    if (lastPickup && performance.now() - lastPickup.t < 420 && Math.hypot(e.x - lastPickup.x, e.y - lastPickup.y) < 6) return;  // 2nd click of a double-click
    if (held) {
      placement = solvePlacement(e.x, e.y, e.alt);
      if (placement.state === 'invalid') { toast(placement.why || 'That part cannot attach there.', 'warn'); return; }
      if (placement.state === 'free' && craft.isEmpty && !A.canBeRoot(held.asm) && held.source === 'bin') { toast(placement.why, 'warn'); return; }
      applyPlacement(placement, { keep: e.shift && placement.state === 'valid' });
      return;
    }
    const hits = hitsAt(e.x, e.y);
    if (state.tool === 'place') {
      const li = looseAt(e.x, e.y);
      if (hits.length) pickUpPart(hits[0].part.id, e, { copy: e.alt });
      else if (li >= 0) pickUpLoose(li, e);
    } else if (state.tool === 'root') { if (hits.length) reroot(hits[0].part.id); }
    else { selected = hits.length ? hits[0].part.id : null; if (state.tool === 'action' && panels) panels.refreshActions(); }
  }
  function focusOn(f) { cam.tty = f.y; cam.tfx = f.x || 0; cam.tfz = f.z || 0; clampFocus(); }
  function onDblClick(e) {
    if (isModalOpen()) return;
    if (lastPickup && performance.now() - lastPickup.t < 700) {
      // The first click of this double-click picked the part up: put it back and focus on it instead.
      const f = lastPickup.focus; lastPickup = null;
      cancelHeld();
      if (f) focusOn(f);
      return;
    }
    if (held) return;
    const hits = hitsAt(e.x, e.y);
    if (hits.length) focusOn(hits[0].part.pos);
  }
  function onKeyDown(e) {
    if (isModalOpen() || e.repeat) return;
    const cmd = e.meta || e.ctrl;
    if (e.code === 'Escape') { if (!cancelHeld()) { if (selected != null) { selected = null; if (panels) panels.refreshActions(); } else if (state.tool !== 'place') setTool('place'); else if (panels.reportOpen) panels.toggleReport(false); } }
    else if (e.code === 'KeyZ' && cmd) { if (!(e.shift ? redo() : undo())) sfx('click'); if (e.original) e.original.preventDefault(); }
    else if (e.code === 'KeyY' && cmd) { redo(); if (e.original) e.original.preventDefault(); }
    else if (cmd) return;
    else if (e.code === 'KeyX') cycleSymmetry(e.shift ? -1 : 1);
    else if (e.code === 'KeyR') setSymMode(state.symMode === 'mirror' ? 'radial' : 'mirror');
    else if (e.code === 'KeyC') { state.snap = !state.snap; panels.refreshToolbar(); }
    else if (e.code === 'Digit1') setTool('place');
    else if (e.code === 'Digit2') setTool('move');
    else if (e.code === 'Digit3') setTool('rotate');
    else if (e.code === 'Digit4') setTool('root');
    else if (e.code === 'Digit5') setTool('action');
    else if (e.code === 'KeyQ' || e.code === 'KeyA') turnHeld(1, e.shift);
    else if (e.code === 'KeyE' || e.code === 'KeyD') turnHeld(-1, e.shift);
    else if (e.code === 'KeyW') flipHeld(1, e.shift);
    else if (e.code === 'KeyS') flipHeld(-1, e.shift);
    else if (e.code === 'Delete' || e.code === 'Backspace') { if (held) deleteHeld(); else if (selected != null) deletePart(selected); else if (hoverId != null) deletePart(hoverId); else if (hoverLoose >= 0) { pushUndo(); loose.splice(hoverLoose, 1); hoverLoose = -1; changed({}); } }
    else if (e.code === 'KeyF') frameCraft();
  }

  // ------------------------------------------------------------------ staging actions (used by the panel)
  function stageMove(ids, index, { insert = false } = {}) {
    pushUndo();
    if (insert) index = craft.insertStage(index);
    for (const id of ids) craft.moveToStage(id, index);
    craft.removeEmptyStages();
    changed({}); sfx('click');
  }
  /** Move a whole stage: `to` is an insert position (0…n) when asInsert, else the index of the stage to swap places with. */
  function stageReorder(from, to, asInsert) {
    const n = craft.stages.length;
    if (from < 0 || from >= n) return false;
    pushUndo();
    const st = craft.stages.map(s => s.slice());
    const [moving] = st.splice(from, 1);
    let at = asInsert ? (to > from ? to - 1 : to) : to;
    at = clamp(at, 0, st.length);
    st.splice(at, 0, moving);
    craft.autoStaging = false; craft.stages = st;
    changed({}); sfx('click');
    return true;
  }
  function stageAdd(index) { pushUndo(); craft.insertStage(index); changed({}); }
  function stageRemove(i) {
    pushUndo();
    if (i < 0) craft.removeEmptyStages();
    else if (craft.stages[i] && !craft.stages[i].length) { craft.autoStaging = false; craft.stages.splice(i, 1); }
    changed({});
  }
  function stageReset() { pushUndo(); craft.autoStage(); changed({}); }

  // ------------------------------------------------------------------ action groups
  function bindAction(group, partId, action) {
    const snap = snapshot();
    if (!craft.setAction(group, partId, action, true)) return false;
    undoStack.push(snap); redoStack = []; changed({}); sfx('click');
    return true;
  }
  function unbindAction(group, partId, action) {
    const snap = snapshot();
    if (!craft.clearAction(group, partId, action, true)) return false;
    undoStack.push(snap); redoStack = []; changed({}); sfx('click');
    return true;
  }
  function clearActionGroup(group) {
    const snap = snapshot();
    if (!craft.clearGroup(group)) return false;
    undoStack.push(snap); redoStack = []; changed({});
    return true;
  }

  // ------------------------------------------------------------------ checks, save, launch
  function lockedParts() { return [...new Set(craft.parts.filter(p => !unlocked(p.type)).map(p => partDef(p.type).name))]; }
  function checkCraft() {
    let v; try { v = craft.validate(SYSTEM.home); } catch { v = { errors: [], warnings: [] }; }
    const n = craft.stages.length;
    const fix = t => t.replace(/^Stage (\d+) is empty\.$/, (_, k) => `Stage ${n - Number(k)} is empty.`);
    const errors = v.errors.map(fix), warnings = v.warnings.map(fix);
    const locked = lockedParts();
    if (locked.length) errors.push('Uses parts that are not researched yet: ' + locked.join(', ') + '.');
    if (loose.length) warnings.push(`${loose.length} loose piece${loose.length > 1 ? 's are' : ' is'} not attached and will stay in the hall.`);
    return { ok: errors.length === 0, errors, warnings };
  }
  function craftSize() { const b = craft.bounds(); return { len: b.maxY - b.minY, wide: b.maxR * 2 }; }
  function saveCraft() {
    const name = panels.name;
    if (craft.isEmpty) { toast('There is nothing to save yet.', 'warn'); return false; }
    if (!name || name === AUTOSAVE) { toast('Give the craft a name first.', 'warn'); panels.focusName(); return false; }
    craft.name = name;
    const existed = !!career.getCraft(name);
    const json = designJSON();
    try { json.thumb = thumbs.craft(json, 200, 150, { horizontal: horizontal() }); } catch { /* optional */ }
    if (!career.saveCraft(json)) { toast('Could not save the design.', 'bad'); return false; }
    app.save();
    toast(existed ? `Updated “${name}”.` : `Saved “${name}”.`, 'good');
    return true;
  }
  function launch(names, where = site) {
    const json = designJSON(); json.site = where; delete json.subassemblies;
    {   // facility limits (hangar part count, pad / runway mass)
      const lim = typeof career.checkLaunch === 'function' ? career.checkLaunch(craft, where) : { ok: true };
      if (lim && !lim.ok) {
        toast((lim.reason === 'parts' ? `Too many parts for the hangar: ${lim.value}, the limit is ${lim.limit}.`
          : lim.reason === 'mass' ? `Too heavy for the ${where === 'runway' ? 'runway' : 'launch pad'}: ${lim.value.toFixed(1)} t, the limit is ${lim.limit} t.`
          : 'This craft cannot be launched.') + ' Upgrade the facility at Administration or lighten the design.', 'bad');
        return false;
      }
    }
    remember();
    if (isCareer()) {
      const paid = career.payLaunch ? career.payLaunch(craft) : { ok: career.spend(craft.cost()) };
      if (!paid.ok) { toast('Not enough funds to launch ' + craft.name + '.', 'bad'); return false; }
    }
    const crew = typeof career.assignCrew === 'function' ? career.assignCrew(names) : names;
    app.save();
    app.goto('flight', { craft: json, crew, paid: true, site: where });
    return true;
  }

  // ------------------------------------------------------------------ the editor object handed to the panels
  const ed = {
    app, state, meta,
    get career() { return career; }, get craft() { return craft; }, get site() { return site; },
    get isCareer() { return isCareer(); }, get thumbs() { return thumbs; },
    get heldType() { return held && held.source === 'bin' && held.asm.parts.length === 1 ? held.asm.parts[0].type : null; },
    get canUndo() { return undoStack.length > 0; }, get canRedo() { return redoStack.length > 0; },
    get showHint() { return !hintDismissed && !(career && career.settings && (career.settings.showHints === false || career.settings.seenBuilderHint)); },
    hintDismissed() { hintDismissed = true; },
    unlocked, techName, toast, sfx, pick, cancelHeld, undo, redo, setTool, cycleSymmetry, checkCraft, craftSize, saveCraft, launch,
    toggleMirror: () => setSymMode(state.symMode === 'mirror' ? 'radial' : 'mirror'),
    toggleSnap: () => { state.snap = !state.snap; panels.refreshToolbar(); },
    toggleMarker: k => { state.show[k] = !state.show[k]; panels.refreshToolbar(); },
    setHighlight: ids => { highlightIds = ids; },
    stageMove, stageReorder, stageAdd, stageRemove, stageReset,
    loadCraft: json => setCraft(json),
    newCraft: () => { cancelHeld(); if (!craft.isEmpty || loose.length) { setCraft(null); toast('Cleared the hall. Undo (⌘Z) brings the old design back.', 'info'); } },
    rename: n => { craft.name = n; remember(); },
    // action groups (the '5' tool)
    get selected() { return selected; }, get actionGroup() { return actionGroup; },
    setActionGroup: g => { actionGroup = String(g); if (panels) panels.refreshActions(); },
    selectPart: id => { selected = craft.getPart(id) ? id : null; if (panels) panels.refreshActions(); },
    bindAction, unbindAction, clearActionGroup,
    setDesc: t => { meta.desc = t; remember(); },
  };

  // ------------------------------------------------------------------ scene
  function buildScene() {
    const r = app.renderer;
    renderState = { shadow: r.shadowMap.enabled, shadowType: r.shadowMap.type, tone: r.toneMapping, exposure: r.toneMappingExposure };
    const wantShadow = quality === 'low' ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    r.shadowMap.enabled = true; if (r.shadowMap.type !== wantShadow) { r.shadowMap.type = wantShadow; r.shadowMap.needsUpdate = true; }
    if (r.toneMapping === THREE.NoToneMapping) { r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0; }
    // ambient occlusion: the hall is drawn into the post chain's target exactly as it would be to the canvas, and the
    // chain adds the shade in the corners, under the craft and between its parts (js/render/post.js, display mode)
    post = null;
    if (quality !== 'low' && !(app.settings && app.settings.gfxAO === false)) {
      try {
        post = createPostChain(r, { display: true });
        if (!post.supported) { post.dispose(); post = null; }
        else { post.params.ao = 1; post.setAO(true); }
      } catch (err) { console.warn('[builder] ambient occlusion unavailable:', err && err.message); post = null; }
    }
    scene = new THREE.Scene();
    const fogCol = horizontal() ? 0x8a97a2 : 0x56636f;
    scene.background = new THREE.Color(0x1a2029);
    scene.fog = new THREE.FogExp2(fogCol, horizontal() ? 0.0042 : 0.0048);
    camera = new THREE.PerspectiveCamera(FOV, size.w / Math.max(1, size.h), 0.25, 900);
    hall = buildHall(r, { site, meshApi, quality });
    scene.add(hall.group);
    if (hall.envMap) { scene.environment = hall.envMap; scene.environmentIntensity = quality === 'low' ? 0.75 : 0.55; }
    craftGroup = new THREE.Group(); craftGroup.name = 'craft';
    if (horizontal()) craftGroup.quaternion.copy(Q_PLANE);
    heldLayer = new THREE.Group(); looseLayer = new THREE.Group();
    craftGroup.add(heldLayer, looseLayer);
    scene.add(craftGroup);
    nodeFx = G.createNodeMarkers(craftGroup);
    cursorFx = G.createCursorFx(craftGroup);
    gizmo = G.createGizmo(craftGroup);
    balanceFx = G.createBalanceMarkers(craftGroup);
    thumbs = G.createThumbs(r, meshApi, hall.envMap);
  }

  // per-frame: hover, placement preview, markers
  function updateEditing(dt) {
    const m = app.input.mouse, modal = isModalOpen();
    const active = m.over && !modal && !(drag && drag.moved > 5);
    const markers = [];
    let surfaceRing = null;
    const wpp = worldPerPixel();
    if (held) {
      hoverId = null; hoverLoose = -1; gizmo.show(null);
      const d = A.asmDef(held.asm), n = held.asm.parts.length;
      const label = n > 1 ? `${d.name} +${n - 1}` : d.name;
      if (active) placement = solvePlacement(m.x, m.y, app.input.mods.alt);
      else if (!m.over) placement = null;
      held.obj.visible = !!placement;
      if (placement) {
        const specs = placement.specs;
        G.setAssemblyPose(held.obj, held.asm, specs[0]);
        held.spec = specs[0];
        G.tintAssembly(meshApi, held.obj, placement.state === 'valid' ? COL.teal : placement.state === 'invalid' ? COL.red : null);
        while (held.ghosts.length < specs.length - 1) { const g = G.makeAssemblyObject(meshApi, held.asm, { ghost: true }); heldLayer.add(g); held.ghosts.push(g); }
        held.ghosts.forEach((g, i) => { g.visible = i < specs.length - 1; if (g.visible) { G.setAssemblyPose(g, held.asm, specs[i + 1]); G.tintAssembly(meshApi, g, COL.teal); } });
      } else for (const g of held.ghosts) g.visible = false;
      // every open node the held part could use, the one it will snap to, and the held part's own nodes
      if (d.attach.stack && !craft.isEmpty) {
        for (const o of A.openNodes(craft)) {
          const ok = o.node === 'outer' ? A.canOuter(craft, held.asm, o.partId) : A.canStack(craft, held.asm, o.partId, o.node);
          if (!ok) continue;
          const snap = placement && placement.node && placement.node.partId === o.partId && placement.node.node === o.node;
          markers.push({ ...o, state: snap ? 'snap' : 'ok' });
        }
      }
      if (placement && d.attach.stack) {
        const s = placement.specs[0], used = placement.action && placement.action.kind === 'stack' ? (placement.action.node === 'top' ? 'bottom' : 'top') : null;
        for (const hn of A.asmNodes(held.asm)) if (hn.node !== used) markers.push({ x: s.x, y: s.y + hn.y, z: s.z, r: hn.r, dir: { x: 0, y: hn.node === 'top' ? 1 : -1, z: 0 }, state: 'held' });
      }
      if (placement && placement.action && placement.action.kind === 'radial') {
        for (const s of placement.specs) { const o = A.outward(s.yaw), k = A.radialW(d) / 2; markers.push({ x: s.x - o.x * k, y: s.y, z: s.z - o.z * k, r: 0.2, dir: o, state: 'snap' }); }
        const s = placement.specs[0], o = A.outward(s.yaw), k = A.radialW(d) / 2;
        surfaceRing = { p: { x: s.x - o.x * k, y: s.y, z: s.z - o.z * k }, n: o, r: Math.max(0.22, Math.min(0.6, d.h * 0.45)) };
      }
      // the snap: a sound the moment the part locks onto a new node or surface target
      const key = placement && placement.state === 'valid' && placement.action.kind !== 'root' ? placement.action.kind + ':' + placement.action.target + ':' + (placement.action.node || '') : '';
      if (key && key !== snappedKey) snapSound(app, false);
      snappedKey = key;
      if (!active || !placement) panels.setStatus(`Holding ${label} · move into the hall · Esc puts it back`, '');
      else if (placement.state === 'valid') {
        const c = placement.specs.length;
        panels.setStatus(craft.isEmpty ? `Click to hang ${label} here as the root part` : `Click to attach ${label}${c > 1 ? ' ×' + c : ''} · Shift-click keeps holding · ${d.attach.stack ? 'Q/E turn · W/S flip' : 'W/S pitch · Q/E roll'} · Esc cancels`, 'ok');
      } else if (placement.state === 'invalid') panels.setStatus(placement.why || `${label} cannot attach there`, 'bad');
      else panels.setStatus(placement.why || (d.attach.radial ? `Move ${label} onto a surface` + (state.symmetry > 1 ? ` · ${state.symMode === 'mirror' ? 'mirror' : '×' + state.symmetry} symmetry` : ' · X sets symmetry') + ' · click in mid-air to park it'
        : `Bring ${label} to a glowing node · click in mid-air to park it`), '');
    } else {
      placement = null; snappedKey = '';
      if (active && !drag) {
        const hits = hitsAt(m.x, m.y);
        hoverId = hits.length ? hits[0].part.id : null;
        hoverLoose = hoverId == null ? looseAt(m.x, m.y) : -1;
        gizmoHover = gizmoHit(m.x, m.y);
      } else if (!m.over || modal) { hoverId = null; hoverLoose = -1; }
      if (state.tool === 'place' || state.tool === 'root') for (const o of A.openNodes(craft)) markers.push({ ...o, state: 'idle' });
      const sel = selected != null ? craft.getPart(selected) : null;
      if (sel && (state.tool === 'move' || state.tool === 'rotate')) {
        gizmo.show(state.tool, sel.pos, sel.rot); gizmo.setScale(wpp); gizmo.highlight(gizmoDrag ? gizmoDrag.handle : gizmoHover);
      } else gizmo.show(null);
      const p = hoverId != null ? craft.getPart(hoverId) : null;
      if (gizmoDrag && clash) { const o = craft.getPart(clash.with); panels.setStatus(`Overlapping ${o ? partDef(o.type).name : 'another part'} · release to slide back to the last clear spot`, 'bad'); }
      else if (gizmoDrag) panels.setStatus(gizmoDrag.handle === 'ring' ? `Rotating · ${(gizmoDrag.applied / DEG).toFixed(0)}°${state.snap ? ' (15° steps, C for free)' : ''}` : `Offset ${gizmoDrag.handle.toUpperCase()} ${gizmoDrag.applied >= 0 ? '+' : ''}${gizmoDrag.applied.toFixed(2)} m${state.snap ? ' (0.1 m steps, C for free)' : ''}`, 'ok');
      else if (state.tool === 'move') panels.setStatus(sel ? `Drag an arrow to offset ${partDef(sel.type).name} and what hangs off it` : 'Move tool · click a part to show its offset arrows', '');
      else if (state.tool === 'rotate') panels.setStatus(sel ? (sel.node === 'radial' && !partDef(sel.type).attach.stack ? `Drag the ring to slide ${partDef(sel.type).name} round · W/S pitch · Q/E roll (15°, Shift 5°)` : `Drag the ring to turn ${partDef(sel.type).name} · Q/E turn 90° (Shift 5°)`) : 'Rotate tool · click a part to show its ring', '');
      else if (state.tool === 'root') panels.setStatus(p ? `Click to make ${partDef(p.type).name} the root part` : 'Re-root tool · click the part that should become the root', '');
      else if (state.tool === 'action') panels.setStatus(sel ? `${partDef(sel.type).name} selected · pick what it does in the Action groups panel` : p ? `Click ${partDef(p.type).name} to give it an action in group “${actionGroup}”` : 'Action groups · click a part, then choose what the group does with it', '');
      else if (p) {
        const d = partDef(p.type), n = craft.symmetryGroup(p).length, sub = craft.subtree(p).length - 1;
        panels.setStatus(`${d.name}${n > 1 ? ' ×' + n : ''}${p.parent === null ? ' · root' : ''} · click to pull it off${sub ? ` with ${sub} attached part${sub > 1 ? 's' : ''}` : ''} · Alt-click copies · ⌫ deletes`, '');
      } else if (hoverLoose >= 0) panels.setStatus('Loose piece · not part of the craft · click to pick it up · ⌫ deletes', '');
      else panels.setStatus('', '');
    }
    lastMarkers = markers;
    nodeFx.set(markers); nodeFx.update(clock, wpp);
    if (surfaceRing) cursorFx.surface(surfaceRing.p, surfaceRing.n, surfaceRing.r, COL.amber); else cursorFx.surface(null);
    cursorFx.update(dt);
    if (balanceFx.bal) balanceFx.set(balanceFx.bal, state.show, { x: 0, y: 0, z: 1 }, wpp);
    applyHighlights();
    if (app.canvas) app.canvas.style.cursor = drag && drag.moved > 5 ? 'grabbing' : held ? (placement && placement.state === 'valid' ? 'copy' : 'default') : (gizmoHover && selected != null) ? 'grab' : (hoverId != null || hoverLoose >= 0) ? 'pointer' : '';
  }

  /** Keep the craft clear of the floor (it hangs from the crane: it never rests on the ground). */
  function updateOrigin() {
    if (craft.isEmpty) return;
    const e = horizontal() ? A.extentAlong(craft.parts, 'z') : A.extentAlong(craft.parts, 'y');
    const low = originT.y + e.lo;
    if (low < hall.floorClear) originT.y += hall.floorClear - low;
  }

  // ------------------------------------------------------------------ screen contract
  const screen = {
    is3D: true, capturesKeys: true,

    async enter(params = {}) {
      const token = ++enterToken;
      career = app.career;
      size = { w: (app.size && app.size.w) || window.innerWidth, h: (app.size && app.size.h) || window.innerHeight };
      await Promise.all([ensureCss(), loadMeshApi()]);
      if (token !== enterToken) return;

      let json = params && params.craft ? params.craft : null;
      if (json && typeof json.toJSON === 'function') json = json.toJSON();
      quality = params && (params.quality === 'high' || params.quality === 'low') ? params.quality : (softwareGL(app.renderer) ? 'low' : 'high');
      site = params && (params.site === 'runway' || params.site === 'pad') ? params.site : (json && json.site === 'runway' ? 'runway' : 'pad');
      let mem = null;
      if (!json && last[site] && last[site].career === career) { mem = last[site]; json = mem.json; }
      // each building keeps its own work in progress; the shared '__autosave' slot is the fallback for older saves
      const autos = career && career.settings && career.settings.builderAutosave;
      if (!json && autos && autos[site]) json = autos[site];
      if (!json && career && career.crafts && career.crafts[AUTOSAVE] && (career.crafts[AUTOSAVE].site || 'pad') === site) json = career.crafts[AUTOSAVE];
      craft = new Craft('Untitled Craft'); loose = []; meta.desc = ''; settle.clear(); clash = null;
      if (json) { try { craft = Craft.fromJSON(json); meta.desc = craft.desc || ''; loose = takeLoose(craft); } catch (err) { console.warn('[builder] could not open the craft:', err && err.message); } }
      if (mem) loose = deep(mem.loose || []);
      held = null; hoverId = null; hoverLoose = -1; placement = null; highlightIds = null; selected = null; gizmoDrag = null; undoStack = []; redoStack = []; drag = null;
      Object.assign(state, { tool: 'place', symmetry: horizontal() ? 2 : 1, symMode: horizontal() ? 'mirror' : 'radial', search: '', atmo: false });
      if (!SYSTEM.byId[state.body]) state.body = SYSTEM.home.id;

      buildScene();
      originT.copy(mem && mem.origin ? new THREE.Vector3(...mem.origin) : defaultOrigin()); origin.copy(originT);
      panels = createPanels(ed);
      syncMeshes(); syncLoose(); syncBalance();
      Object.assign(cam, horizontal() ? { tyaw: 0.72, tpitch: 0.3 } : { tyaw: 0.55, tpitch: 0.16 });
      layoutView();
      frameCraft();
      Object.assign(cam, { yaw: cam.tyaw, pitch: cam.tpitch, dist: cam.tdist, ty: cam.tty, fx: cam.tfx, fz: cam.tfz });
      remember();

      const input = app.input;
      offs = [input.on('mousedown', onMouseDown), input.on('mousemove', onMouseMove), input.on('mouseup', onMouseUp),
        input.on('click', onClick), input.on('dblclick', onDblClick), input.on('wheel', onWheel), input.on('keydown', onKeyDown)];

      // [realism pass] link the hall's and the craft's shader programs in the background before the first frame
      // (as flightscene.prewarm does): without this the first frame of the building compiled them all at once
      try {
        const r = app.renderer;
        if (r && typeof r.compileAsync === 'function' && scene && camera) { updateCamera(1); await Promise.race([r.compileAsync(scene, camera), new Promise(res => setTimeout(res, 4000))]); }
      } catch { /* the first frame compiles them instead */ }
      if (token !== enterToken) return;
      app.builder = api;
      entered = true;
      updateCamera(1);
    },

    exit() {
      enterToken++;
      entered = false;
      for (const off of offs) { try { off(); } catch { /* ignore */ } }
      offs = [];
      if (held && held.undoAtPickup) cancelHeld(); else dropHeld();
      if (career) {
        remember();
        if (career.crafts) {
          // Work in progress goes to the '__autosave' slot, unless it is identical to a saved design of that name.
          const mine = designJSON(), saved = career.crafts[craft.name];
          const strip = j => { const o = { ...j }; delete o.thumb; return JSON.stringify(o); };
          const same = saved && strip(saved) === strip(mine);
          const autos = career.settings ? (career.settings.builderAutosave = { ...(career.settings.builderAutosave || {}) }) : null;
          if ((craft.isEmpty && !loose.length) || same) {
            if (career.crafts[AUTOSAVE] && (career.crafts[AUTOSAVE].site || 'pad') === site) delete career.crafts[AUTOSAVE];
            if (autos) delete autos[site];
          } else {
            career.crafts[AUTOSAVE] = deep(mine);          // the most recent one, for anything that reads the old slot
            if (autos) autos[site] = deep(mine);           // and one per building, so the hangar never eats the VAB's work
          }
        }
      }
      for (const g of partObjs.values()) G.freePartObject(meshApi, g);
      partObjs.clear();
      for (const g of looseObjs) G.freeAssemblyObject(meshApi, g);
      looseObjs = [];
      for (const fx of [nodeFx, cursorFx, gizmo, balanceFx, thumbs]) { try { fx && fx.dispose(); } catch { /* ignore */ } }
      if (hall) hall.dispose();
      if (post) { post.dispose(); post = null; }
      if (renderState && app.renderer) { const r = app.renderer; r.shadowMap.enabled = renderState.shadow; r.shadowMap.type = renderState.shadowType; r.toneMapping = renderState.tone; r.toneMappingExposure = renderState.exposure; }
      scene = camera = hall = craftGroup = heldLayer = looseLayer = nodeFx = cursorFx = gizmo = balanceFx = thumbs = null;
      if (panels) panels.dispose();
      panels = null;
      if (app.canvas) app.canvas.style.cursor = '';
    },

    update(dt) {
      if (!entered || !scene) return;
      clock += dt;
      panels.tick(dt);
      updateOrigin();
      updateCamera(Math.min(1, dt * 12));
      updateEditing(dt);
      updateSettle(dt);
      // the crane hook waits above the craft; the key light follows it
      const b = craft.bounds();
      const top = craft.isEmpty ? null : (horizontal() ? v3.set(0, 0, 0).applyMatrix4(craftGroup.matrixWorld).setY(origin.y + A.extentAlong(craft.parts, 'z').hi + 3) : v3.set(0, b.maxY, 0).applyMatrix4(craftGroup.matrixWorld));
      hall.update(dt, { top, focus: v3b.set(0, (b.minY + b.maxY) / 2, 0).applyMatrix4(craftGroup.matrixWorld) });
    },

    render() {
      const r = app.renderer;
      if (!r || !scene) return;
      if (post) {
        // (renderer.info counts the whole frame, not only the last pass)
        const autoReset = r.info.autoReset; r.info.autoReset = false; r.info.reset();
        r.getDrawingBufferSize(_db); post.setSize(_db.x, _db.y, 1);
        const rt = post.begin(); rt.viewport.set(0, 0, rt.width, rt.height);      // (never renderer.setViewport() on a target: it takes CSS pixels)
        if (post.ao) Object.assign(post.ao.params, { radius: 0.7, intensity: 2.0, maxDist: 300 });
        r.render(scene, camera);
        r.setRenderTarget(null);
        post.end({ camera });
        r.setRenderTarget(null);
        r.info.autoReset = autoReset;
        return;
      }
      r.setRenderTarget(null);
      r.render(scene, camera);
    },

    resize(w, h) {
      size = { w: Math.max(1, w), h: Math.max(1, h) };
      layoutView();
    },
  };

  // ------------------------------------------------------------------ test / integration hooks
  const rectOff = p => { const rect = app.canvas ? app.canvas.getBoundingClientRect() : { left: 0, top: 0 }; return { x: p.x + rect.left, y: p.y + rect.top }; };
  const api = {
    get craft() { return craft; },
    getCraft: () => craft,
    loadCraft: json => setCraft(json),
    newCraft: () => setCraft(null),
    pick, cancel: cancelHeld,
    /** Type of the held (root) part, or null. `heldParts` = how many parts are in the hand. */
    get held() { return held ? held.asm.parts[0].type : null; },
    get heldParts() { return held ? held.asm.parts.length : 0; },
    get heldTurn() { return held ? held.turn : 0; },
    get site() { return site; },
    get symmetry() { return state.symmetry; }, get symMode() { return state.symMode; },
    setSymmetry, setSymMode,
    get snap() { return state.snap; }, setSnap(on) { state.snap = !!on; panels.refreshToolbar(); },
    get tool() { return state.tool; }, setTool,
    get selected() { return selected; }, select(id) { selected = craft.getPart(id) ? id : null; if (panels && state.tool === 'action') panels.refreshActions(); },
    undo, redo,
    get placement() { return placement ? { state: placement.state, action: placement.action, count: placement.specs.length, node: placement.node ? { partId: placement.node.partId, node: placement.node.node } : null, why: placement.why || null } : null; },
    /** Apply an explicit action with the held part: {kind:'root'|'stack'|'radial'|'outer', target, node, y, angle, symmetry, mode}. */
    place(action) {
      if (!held) return [];
      const specs = specsFor(action);
      if (!specs.length) return [];
      return applyPlacement({ action, specs, state: 'valid', node: null });
    },
    /** Client coordinates of a point on a part: fy = −1…1 along its height, side = −1…1 across its visible width. */
    partScreenPos(id, fy = 0, side = 0) {
      const p = craft.getPart(id); if (!p || !camera) return null;
      const d = partDef(p.type), y = p.pos.y + fy * d.h / 2;
      const r = d.attach.stack ? craft.radiusAt(p, y) : Math.min(A.radialW(d), d.t || 0.1) / 2;
      qInv.copy(craftGroup.quaternion).invert();
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).applyQuaternion(qInv); right.y = 0;
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0); right.normalize();
      return rectOff(toScreen(p.pos.x + right.x * r * side, y, p.pos.z + right.z * r * side));
    },
    /** Client coordinates of any craft-space point. */
    screenPos(x, y, z) { return camera ? rectOff(toScreen(x, y, z)) : null; },
    /** Open attachment nodes with their client coordinates. */
    get nodes() { return A.openNodes(craft).map(o => ({ partId: o.partId, node: o.node, ...rectOff(toScreen(o.x, o.y, o.z)) })); },
    /** What the 3D node markers currently show: [{ partId, node, state: 'idle'|'ok'|'snap'|'held' }] and how many are drawn. */
    get markers() { return lastMarkers.map(m => ({ partId: m.partId ?? null, node: m.node ?? null, state: m.state })); },
    get markersDrawn() { return nodeFx ? nodeFx.group.children.filter(g => g.visible).length : 0; },
    /** The held assembly as drawn: is its preview visible, how many symmetry ghosts, and where its root is on screen. */
    get heldView() {
      if (!held || !held.obj) return null;
      const p = held.spec || { x: 0, y: 0, z: 0 };
      return { visible: held.obj.visible, ghosts: held.ghosts.filter(g => g.visible).length, ...rectOff(toScreen(p.x, p.y, p.z)), pos: { x: p.x, y: p.y, z: p.z } };
    },
    /** Loose pieces as drawn (translucent, in the hall but not in the craft). */
    get looseView() { return looseObjs.map(g => { let translucent = false; g.traverse(o => { if (o.isMesh && o.material && o.material.transparent && o.material.opacity < 1) translucent = true; }); return { visible: g.visible, translucent }; }); },
    /** The free 3D view between the panels, in client coordinates. */
    get viewRect() {
      const r = panels.root.getBoundingClientRect(), t = panels.dom.tools.getBoundingClientRect(), rr = panels.root.querySelector('.bld-right').getBoundingClientRect(), info = panels.dom.info.getBoundingClientRect(), top = panels.root.querySelector('.bld-top').getBoundingClientRect();
      return { left: t.right, right: rr.left, top: top.bottom, bottom: info.top, cx: (t.right + rr.left) / 2, cy: (top.bottom + info.top) / 2, width: r.width };
    },
    get loose() { return loose.map((l, i) => ({ index: i, parts: l.asm.parts.length, type: l.asm.parts[0].type, ...rectOff(toScreen(l.x, l.y, l.z)) })); },
    /** Client coordinates of a gizmo handle ('x' | 'y' | 'z' | 'ring') of the selected part. */
    gizmoScreenPos(handle, angle = 0) {
      const p = selected != null ? craft.getPart(selected) : null; if (!p || !gizmo) return null;
      const s = gizmo.size;
      if (handle === 'ring') return rectOff(toScreen(p.pos.x + Math.cos(angle) * s, p.pos.y, p.pos.z - Math.sin(angle) * s));
      const v = gizmo.axes[handle].v;
      return rectOff(toScreen(p.pos.x + v.x * s * 0.9, p.pos.y + v.y * s * 0.9, p.pos.z + v.z * s * 0.9));
    },
    nudge, spin, reroot,
    /** Orientation of the held root part / tilting from tests: turn(dir, fine) = Q/E, tilt(dir, fine) = W/S. */
    turn: turnHeld, tilt: flipHeld,
    get heldPose() { if (!held) return null; const r = held.asm.parts[0]; return { turn: held.turn, flip: !!r.flip, pitch: r.pitch || 0, roll: r.roll || 0 }; },
    tiltPart(id, dPitch, dRoll) { const was = selected; selected = id; const r = tiltSelected(dPitch, dRoll); selected = was; return r; },
    collisions: id => A.collisions(craft, id),
    get clash() { return clash ? [...clash.ids] : null; },
    get settling() { return settle.size; },
    get actionGroup() { return actionGroup; }, setActionGroup: g => ed.setActionGroup(g),
    bindAction, unbindAction, clearActionGroup,
    get actionGroups() { return deep(craft.actionGroups); },
    designJSON: () => designJSON(),
    get balance() { return A.balance(craft); },
    get markersShown() { return balanceFx ? { com: balanceFx.com.visible, cot: balanceFx.cot.visible, col: balanceFx.col.visible } : null; },
    get origin() { return { x: originT.x, y: originT.y, z: originT.z }; },
    /** World-space height of the lowest point of the craft above the hall floor. */
    get clearance() { const e = horizontal() ? A.extentAlong(craft.parts, 'z') : A.extentAlong(craft.parts, 'y'); return originT.y + e.lo; },
    get camera() { return { ...cam }; },
    setCamera(o) { for (const k of ['yaw', 'pitch', 'dist', 'ty', 'fx', 'fz']) if (Number.isFinite(o[k])) { cam[k] = o[k]; cam['t' + k] = o[k]; } if (entered) updateCamera(1); },
    frame: frameCraft,
    get hover() { return hoverId; },
    get ready() { return entered && !!panels && panels.thumbsPending === 0; },
    get usingPartMeshes() { return !!meshApi; },
    get snapCount() { return snapStats.count; },
    get supportsFlip() { return SUPPORTS_FLIP; },
    get scene() { return scene; }, get three() { return THREE; }, get quality() { return quality; },
    get info() { const r = app.renderer; return r ? { calls: r.info.render.calls, triangles: r.info.render.triangles } : null; },
    checkCraft,
    openLoadDialog: () => panels.openLoadDialog(), openLaunchDialog: () => panels.openLaunchDialog(), saveCraft, toggleReport: on => panels.toggleReport(on),
  };

  return screen;
}
