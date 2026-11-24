// Starwright part meshes. Everything is generated in code: geometry in js/render/parts/shapes_*.js, canvas
// textures (colour / normal / roughness-metalness, plus a decal atlas of original markings) in parts/textures.js,
// shared PBR materials in parts/materials.js.
//
// Conventions (see docs/ARCHITECTURE.md): group origin = part centre, axis +Y. Radial parts occupy
// x in [-rw/2, +rw/2] with the mount face at x = -rw/2 ("outward" = +X), vertical extent h, tangential
// thickness t along Z. Engine nozzle exits sit at y = -h/2.
//   Wings / fins / tails: span along +X, leading edge toward +Y, thickness along Z.
//   Wheels and landing gear: +X (outward) is "down" toward the ground, the axle runs along Z, they roll along Y.
//   Plane parts (cockpit, capsule windows, rover deck): the roof / canopy side faces +Z (PLANE_DORSAL_ANGLE).
//
// Each part def is built once per quality into a prototype (merged geometry in a few material buckets, so a
// part is a handful of draw calls) and cloned per instance; geometries, textures and materials are shared.
//
// ---- API (first pass, unchanged) --------------------------------------------------------------------------
//   buildPartMesh(def, { ghost })            → THREE.Group (userData.def, .refs, .canopy for parachutes)
//   setPartState(group, { deployed, throttle, ignited, flameout, temp, instant })
//   highlightPart(group, color | null), disposePartMesh(group), renderPartThumbnail(renderer, def, size)
//   buildPipMesh(), animatePip(group, { walk, t }), nozzleExitRadius(def), mergeGeometries(items), PALETTE
// ---- Additions (second pass) ------------------------------------------------------------------------------
//   buildPartMesh(def, { quality })          quality: 'high' (default) | 'medium' | 'low'. 'low' is one flat
//                                            material and one draw call per rigid piece: use it for debris.
//   createPartLOD(def, { distances })        → THREE.LOD (high / medium / low); setPartState, highlightPart
//                                            and disposePartMesh accept it like a plain part group.
//   setPartState additional keys:
//     deployed   also drives: retractable gear (true = down; gear is DOWN until told otherwise), air brakes,
//                folding ladders, the deep-space dish, fan / wing / grand solar arrays
//     gimbal     { x, z } radians, or a number of radians about Z: swivels the engine bell(s)
//     control    -1..1 control-surface deflection (elevons, rudders, steering vanes, canards, grid fins)
//     steer      radians, wheel steering angle;  spin: radians, absolute wheel roll angle
//     compress   suspension compression in units of wheelGeometry().travel (0..1 nominal, up to 3 under load)
//                for a landing leg: metres the strut has closed (the foot comes up the craft's axis by that much)
//     light      true/false (or 0..1) switches spotlight lenses on
//     throttle   also lights ion grids, jet afterburners and aerospikes
//   nozzleExits(def)                         → [{ x, y, z, r }] every nozzle of a (multi-bell) engine; a ring cluster
//                                            (engine.rings) adds `ring` and `fixed` to each, ring 0's bells first
//   setEngineRings(group, lit)               lit: the ring indices burning in the engine's mode (null: all). The
//                                            nozzle interiors of the other rings stay dark whatever the throttle.
//   Handed parts (flaps: one face steel, one tiled) carry both hands as 'sideA' / 'sideB' and show the one whose
//   tiles face −Z of the frame the part group sits in (the craft's belly), picked whenever the group's matrix updates.
//   ensurePartEnvironment(renderer)          builds the small procedural environment map that part metals
//                                            reflect. It also installs itself the first time a part is drawn,
//                                            so calling it is optional. setPartEnvironment(texture, intensity)
//                                            swaps in your own PMREM texture or dims it (e.g. in eclipse).
//   partDrawCalls(group)                     → number of meshes (for budgeting)
//   buildInterstageMesh({ h, r0, r1 }, { quality })   the open lattice ring that joins a stage to the engine above
//                                            it (core/craft.js interstages()): ONE merged mesh, origin at its middle,
//                                            the rim that stands on the carrying part at y = −h/2 (radius r0), the
//                                            rim under the engine's mount ring at y = +h/2 (radius r1).
//   setPartInterstages(group, trusses, { quality })   hang the trusses a part carries on its mesh group. trusses:
//                                            [{ side, h, r0, r1 }], side = ±1 along the part's own +Y (vessel part
//                                            `truss`); pass null / [] to take them off. One draw call each.
//   PLANE_DORSAL_ANGLE, DECAL names via parts/textures.js
import * as THREE from '../lib/three.module.min.js';
import { chuteSpec, chuteShape, chuteDragArea, chuteStageSpec, chuteLaw } from '../core/parachute.js';
import { canopyLayout, canopyIndex, canopyColors, writeCanopy, canopyPlacement } from './canopy.js';
import { PALETTE, mat, hasPartEnvironment, setPartEnvironment as setEnv, buildEnvironment, partEnvIntensity } from './parts/materials.js';
import { PB, P, M, Mdir, sub, mergeGeometries, TAU } from './parts/geo.js';
import * as stackShapes from './parts/shapes_stack.js';
import * as engineShapes from './parts/shapes_engine.js';
import * as aeroShapes from './parts/shapes_aero.js';
import * as radialShapes from './parts/shapes_radial.js';
import { cargobay, hotring, catchpin, flap, sideport } from './parts/shapes_shearwater.js';
import { buildPipInto, buildPipMesh, animatePip } from './parts/pip.js';

export { PALETTE, mergeGeometries, buildPipMesh, animatePip };
export const nozzleExitRadius = engineShapes.nozzleExitRadius;
export const nozzleExits = engineShapes.nozzleExits;
export const PLANE_DORSAL_ANGLE = stackShapes.DORSAL;
export const setPartEnvironment = setEnv;

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = x => x * x * (3 - 2 * x);
function approach(cur, target, maxStep) { return cur < target ? Math.min(target, cur + maxStep) : Math.max(target, cur - maxStep); }

// ---------------------------------------------------------------------------------------------
// Shape table
// ---------------------------------------------------------------------------------------------
const { clamp_: clampShape, solarLayout, ...radialRest } = radialShapes;
const { legGeometry, foldLegGeometry, wheelGeometry, ...aeroRest } = aeroShapes;
const { DORSAL: _d, ...stackRest } = stackShapes;
const shapes = {
  ...stackRest, engine: engineShapes.engine, srb: engineShapes.srb, radialengine: engineShapes.radialengine, ...aeroRest, ...radialRest, clamp: clampShape,
  cargobay, hotring, catchpin, flap, sideport,
  pip(def, g) { buildPipInto(g); },
  generic(def, g, pb) {
    if (def.r) pb.cyl(def.rTop ?? def.r, def.rBottom ?? def.r, def.h, 0, P.shade, 'paint');
    else pb.rbox(def.rw || 0.3, def.h || 0.3, def.t || 0.3, 0.02, P.shade, null, 'paint');
  },
};

// --- parachute canopy -----------------------------------------------------------------------
// The cloth and the lines come from ./canopy.js, written each frame from the shape the flight physics flies
// (core/parachute.js chuteShape): the drawn canopy is as wide and stands as far above the craft as the one that makes
// the drag, and every line ends on the skirt vertex of its seam. Each part instance owns its buffers.
const canopyShared = {};
function canopyStatics(kind, q) {
  const key = kind + q;
  if (canopyShared[key]) return canopyShared[key];
  const lay = canopyLayout(kind, q), c = new THREE.Color(), rgb = h => { c.set(h); return [c.r, c.g, c.b]; };
  const drogue = kind === 'drogue';
  const col = canopyColors(lay, rgb(drogue ? P.redPaint : P.teal), rgb(P.hull), rgb(drogue ? P.hull : P.amber), !drogue);
  return (canopyShared[key] = { lay, color: new THREE.Float32BufferAttribute(col, 3), index: new THREE.BufferAttribute(canopyIndex(lay), 1) });
}
function addCanopy(def, g, y) {
  const canopy = new THREE.Group(); canopy.name = 'canopy'; canopy.position.set(0, y, 0); canopy.visible = false;
  g.add(canopy);
}
function rigCanopy(def, u, q) {
  const n = def.chute.count || 1, kind = def.variant === 'drogue' ? 'drogue' : n > 1 ? 'cluster' : 'main';
  const { lay, color, index } = canopyStatics(kind, q), units = [];
  const dyn = (len, size) => { const a = new THREE.BufferAttribute(new Float32Array(len * size), size); a.setUsage(THREE.DynamicDrawUsage); return a; };
  const riserGeo = new THREE.BufferGeometry(); riserGeo.setAttribute('position', dyn(2, 3));
  const riser = new THREE.LineSegments(riserGeo, mat('lines')); riser.frustumCulled = false; riser.name = 'canopyRiser';
  u.canopy.add(riser);
  for (let k = 0; k < n; k++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', dyn(lay.verts, 3)); geo.setAttribute('normal', dyn(lay.verts, 3)); geo.setAttribute('uv', dyn(lay.verts, 2));
    geo.setAttribute('color', color); geo.setIndex(index);
    const cloth = new THREE.Mesh(geo, mat('canopy')); cloth.frustumCulled = false; cloth.castShadow = true; cloth.name = 'canopyCloth';
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', dyn(lay.lines * 2, 3));
    const lines = new THREE.LineSegments(lg, mat('lines')); lines.frustumCulled = false; lines.name = 'canopyLine';
    const unit = new THREE.Group(); unit.name = 'canopyUnit'; unit.add(cloth, lines);
    u.canopy.add(unit);
    units.push({ unit, geo, lg });
  }
  u.rig = { lay, units, riserGeo, own: [riserGeo, ...units.flatMap(x => [x.geo, x.lg])] };
}
const _lean = new THREE.Vector3(), _fallQ = new THREE.Quaternion(), _fallAxis = new THREE.Vector3();
const CANOPY_FALL = 3.2, CANOPY_LIE = 1.62;      // s to topple; rad from upright when it lies (a little past level: the craft sits above the ground)
function drawCanopy(u, shape, breath) {
  const rig = u.rig, place = canopyPlacement(shape);
  const rp = rig.riserGeo.attributes.position.array; rp[0] = rp[1] = rp[2] = 0; rp[3] = 0; rp[4] = shape.riser; rp[5] = 0;
  rig.riserGeo.attributes.position.needsUpdate = true;
  for (let k = 0; k < rig.units.length; k++) {
    const x = rig.units[k], pl = place[k] || place[0], a = x.geo.attributes;
    writeCanopy(shape, rig.lay, a.position.array, a.normal.array, a.uv.array, x.lg.attributes.position.array, breath, k * 0.4);
    a.position.needsUpdate = a.normal.needsUpdate = a.uv.needsUpdate = true; x.lg.attributes.position.needsUpdate = true;
    x.unit.visible = k < (shape.count || 1);
    x.unit.position.set(0, shape.riser, 0);
    x.unit.quaternion.setFromAxisAngle(_lean.set(pl.dz, 0, -pl.dx), pl.tilt);
  }
  u.canopyTop = shape.top;
}
/** The shape a parachute part is drawn in when nobody supplies the flying one: fully filled in its stage. */
function restShape(def, st, out) {
  const spec = chuteStageSpec(chuteSpec(def), st);
  return chuteShape(spec, chuteDragArea(spec, chuteLaw(st), 1), out);
}

// ---------------------------------------------------------------------------------------------
// Prototypes
// ---------------------------------------------------------------------------------------------
const Q = { low: 0, medium: 1, high: 2 };
const protoCache = new Map();
function prototypeFor(def, q) {
  const key = def.id + ':' + q;
  let p = protoCache.get(key);
  if (!p) {
    p = new THREE.Group();
    const fn = shapes[def.shape] || shapes.generic, pb = new PB(q);
    try { fn(def, p, pb); } catch (err) { console.warn('[partmesh] ' + def.id + ' fell back to a plain shape:', err); p.clear(); const fb = new PB(q); shapes.generic(def, p, fb); fb.build(p); protoCache.set(key, p); return p; }
    pb.build(p);
    if (def.chute) addCanopy(def, p, def.shape === 'chute' ? def.h / 2 : def.h / 2);
    protoCache.set(key, p);
  }
  return p;
}

let envPending = false;
/** Build (once) and install the procedural environment map that part materials reflect. */
export function ensurePartEnvironment(renderer) {
  if (hasPartEnvironment() || !renderer) return;
  setEnv(buildEnvironment(renderer), partEnvIntensity());
}
function hookEnvironment(mesh) {
  mesh.onBeforeRender = function (renderer) {
    mesh.onBeforeRender = THREE.Object3D.prototype.onBeforeRender;
    if (hasPartEnvironment() || envPending) return;
    envPending = true;
    setTimeout(() => { try { ensurePartEnvironment(renderer); } catch (err) { console.warn('[partmesh] environment map failed:', err); } envPending = false; }, 0);
  };
}

function deployInfo(def) {
  const s = def.shape;
  if (s === 'leg') return { time: def.variant === 'fold' ? 2.4 : 1.4, initial: 0 };
  if (s === 'solar') return def.solar && def.solar.fixed ? null : { time: def.variant === 'grand' ? 4.5 : 2.6, initial: 0 };
  if (s === 'wheel') return def.wheel && def.wheel.retract ? { time: 1.8, initial: 1 } : null;
  if (s === 'airbrake') return { time: 0.6, initial: 0 };
  if (s === 'ladder') return def.variant === 'telescopic' ? { time: 1.2, initial: 0 } : null;
  if (s === 'antenna') return def.variant === 'bigdish' ? { time: 3, initial: 0 } : null;
  return null;
}

/**
 * Build the mesh group for a part definition. Origin = part centre, axis +Y (see file header).
 * @param {object} def  part def from parts.js
 * @param {{ghost?: boolean, quality?: 'high'|'medium'|'low'}} [opts]  ghost = translucent teal placement preview
 * @returns {THREE.Group} with userData.def = def (and userData.canopy for parachutes, userData.parts for the Pip)
 */
export function buildPartMesh(def, { ghost = false, quality = 'high' } = {}) {
  const q = Q[quality] ?? 2;
  const g = prototypeFor(def, q).clone(true);
  g.name = 'part_' + def.id;
  g.userData = { def, ghost, quality };
  const refs = {}, glow = [], beam = [], heatGlow = [];
  let first = null;
  g.traverse(o => {
    if (o.name && o !== g && !(o.name in refs)) refs[o.name] = o;
    if (o.isMesh) {
      if (!first) first = o;
      if (o.userData.own) { o.material = o.material.clone(); (o.material.name === 'glow' ? glow : o.material.name === 'heat' ? heatGlow : beam).push(o); }
    }
  });
  const u = g.userData;
  u.refs = refs; u.glow = glow; u.beam = beam; u.heatGlow = heatGlow;
  if (refs.canopy) { u.canopy = refs.canopy; if (!ghost) rigCanopy(def, u, q); }
  if (def.shape === 'pip') {
    const parts = {}; for (const k of Object.keys(refs)) if (k.startsWith('pip_')) parts[k.slice(4)] = refs[k];
    u.parts = parts;
  }
  const dep = deployInfo(def);
  if (dep) { u.deployK = dep.initial; u.deployTarget = dep.initial; }
  if (ghost) {
    g.traverse(o => {
      if (o.isMesh) { o.material = mat('ghost'); o.renderOrder = 5; o.castShadow = o.receiveShadow = false; if (o.name === 'b_lamp' || o.name === 'b_decal' || o.name === 'b_jar' || o.name === 'b_heat') o.visible = false; }
      else if (o.isLineSegments) o.material = mat('ghostLine');
    });
  } else if (first && !hasPartEnvironment()) hookEnvironment(first);
  if (refs.sideA && refs.sideB) hookHanded(g, [g]);
  applyAnim(g, def, true);
  return g;
}
// Which hand of a handed part shows: 'sideA' while the part's own +Z points to the +Z half of its parent's frame.
// A stock flap pair sits at rot 0 and π, so one takes each hand and both tiled faces look at the belly (−Z).
function hookHanded(holder, groups) {
  let cur = null;
  holder.updateMatrix = function () {
    const q = this.quaternion, a = 1 - 2 * (q.x * q.x + q.y * q.y) >= -1e-6;
    if (a !== cur) { cur = a; for (const g of groups) { const r = g.userData.refs; r.sideA.visible = a; r.sideB.visible = !a; } }
    THREE.Object3D.prototype.updateMatrix.call(this);
  };
}

/** High / medium / low versions of a part in a THREE.LOD. distances = [medium from, low from] in metres. */
export function createPartLOD(def, { distances = [60, 400] } = {}) {
  const lod = new THREE.LOD(); lod.name = 'partlod_' + def.id;
  const levels = [buildPartMesh(def, { quality: 'high' }), buildPartMesh(def, { quality: 'medium' }), buildPartMesh(def, { quality: 'low' })];
  lod.addLevel(levels[0], 0); lod.addLevel(levels[1], distances[0]); lod.addLevel(levels[2], distances[1]);
  lod.userData = { def, lodLevels: levels };
  if (levels[0].userData.canopy) lod.userData.canopy = levels[0].userData.canopy;
  if (levels[0].userData.refs.sideA) { for (const l of levels) delete l.updateMatrix; hookHanded(lod, levels); }
  return lod;
}
export function partDrawCalls(group) { let n = 0; group.traverse(o => { if ((o.isMesh || o.isLineSegments) && o.visible) n++; }); return n; }

// ---------------------------------------------------------------------------------------------
// Interstage truss: two rims, hoops between them, and a lattice of crossed struts you can see the engine through.
// Everything goes in one bucket, so a truss is a single draw call (and a few hundred to ~3000 triangles).
// ---------------------------------------------------------------------------------------------
const trussCache = new Map();
function trussPrototype(h, r0, r1, q) {
  const key = [h, r0, r1, q].map(x => (+x).toFixed(3)).join('|');
  let g = trussCache.get(key);
  if (g) return g;
  g = new THREE.Group();
  const pb = new PB(q), rM = (r0 + r1) / 2, y0 = -h / 2, y1 = h / 2;
  const band = clamp(h * 0.07, 0.03, 0.12);                      // height of each solid rim
  const rodR = clamp(rM * 0.024, 0.011, 0.04), sides = q >= 2 ? 6 : q === 1 ? 5 : 4;
  const rAt = y => r0 + (r1 - r0) * (y - y0) / h;
  // rims: thick machined rings that sit on the stage below and under the engine's mount flange
  pb.ring(r0 - 0.035, r0 + 0.012, y0, y0 + band, P.gun, 'metal');
  pb.ring(r1 - 0.035, r1 + 0.012, y1 - band, y1, P.gun, 'metal');
  const a = y0 + band, b = y1 - band, span = b - a;
  if (span > 0.02) {
    const n = Math.max(8, Math.round(rM * 12)), bay = TAU * rM / n;
    const tiers = Math.max(1, Math.min(8, Math.round(span / (bay * 1.15)) || 1)) >> (q === 0 ? 1 : 0) || 1;
    const rL = r => r - rodR * 0.6;                              // lattice centre line, just inside the skin line
    const pt = (i, y) => { const an = i * TAU / n, r = rL(rAt(y)); return [Math.cos(an) * r, y, Math.sin(an) * r]; };
    const rod = (A, B, r, color) => {
      const va = new THREE.Vector3(...A), vb = new THREE.Vector3(...B), d = vb.clone().sub(va);
      pb.add(new THREE.CylinderGeometry(r, r, d.length(), sides, 1, true), color, Mdir(va.add(vb).multiplyScalar(0.5), d), 'metal');
    };
    for (let i = 0; i < n; i++) {
      rod(pt(i, a - band * 0.5), pt(i, b + band * 0.5), rodR * 1.25, P.steel);           // longerons carry the push
      for (let t = 0; t < tiers; t++) {
        const ya = a + span * t / tiers, yb = a + span * (t + 1) / tiers;
        rod(pt(i, ya), pt(i + 1, yb), rodR, P.silver);                                    // crossed diagonals take the twist
        rod(pt(i + 1, ya), pt(i, yb), rodR, P.silver);
      }
    }
    for (let t = 1; t < tiers; t++) { const y = a + span * t / tiers; pb.torus(rL(rAt(y)), rodR * 1.1, P.steel, M(0, y, 0, Math.PI / 2), 'metal', n * 2, 5); }
  }
  pb.build(g);
  g.traverse(o => { if (o.isMesh) { o.name = 'interstage'; o.castShadow = o.receiveShadow = true; } });
  trussCache.set(key, g);
  return g;
}
/** The lattice ring between a stage and the engine above it: one mesh in a group (see the header). */
export function buildInterstageMesh({ h, r0, r1 }, { quality = 'high' } = {}) {
  const g = trussPrototype(h, r0, r1, Q[quality] ?? 2).clone(true);
  g.name = 'interstage';
  g.userData = { interstage: true };
  return g;
}
/** Hang (or take off) the interstage trusses a part carries: children of its mesh group, so they move, tint and
 *  leave with it. `side` is along the part's own axis (+1: the truss stands on its top node end). */
export function setPartInterstages(group, trusses, { quality } = {}) {
  if (group.isLOD && group.userData.lodLevels) { for (const l of group.userData.lodLevels) setPartInterstages(l, trusses, { quality: l.userData.quality }); return; }
  const u = group.userData, def = u.def;
  const key = trusses && trusses.length ? trusses.map(t => [t.side, t.h, t.r0, t.r1].join(',')).join(';') : '';
  if ((u.trussKey || '') === key) return;
  u.trussKey = key;
  for (const c of group.children.slice()) {
    if (!c.userData || !c.userData.interstage) continue;
    c.traverse(o => { if (o.isMesh && o.userData.tintMat) { o.userData.tintMat.dispose(); o.userData.tintMat = null; } });
    group.remove(c);
  }
  if (!key || !def) return;
  for (const t of trusses) {
    // a hot-stage ring is the interstage: the skirted cluster standing on it rim to rim needs no lattice round it
    if (def.shape === 'hotring' && Math.abs(t.r0 - t.r1) < 0.01) continue;
    const m = buildInterstageMesh(t, { quality: quality || u.quality || 'high' });
    const side = t.side < 0 ? -1 : 1;
    m.position.set(0, side * (def.h + t.h) / 2, 0);
    if (side < 0) m.rotation.x = Math.PI;
    if (u.ghost) m.traverse(o => { if (o.isMesh) { o.material = mat('ghost'); o.renderOrder = 5; o.castShadow = o.receiveShadow = false; } });
    group.add(m);
  }
  u.tintKey = null; applyTint(group);
}

// ---------------------------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------------------------
function applyAnim(g, def, initial = false) {
  const u = g.userData, r = u.refs, s = def.shape;
  if (s === 'leg' && def.variant === 'fold' && r.legPivot) {
    // one rigid swing about the hinge: straight up against the hull when stowed, out and down when deployed; a
    // loaded strut closes by lifting the pad, which opens the leg a little further
    const k = smooth(u.deployK || 0), L = def.legs, { px, py, len, ax, ay, drop } = foldLegGeometry(def);
    const comp = k * Math.min(u.compress || 0, L.stroke || 0.4);
    const down = Math.acos(clamp((L.reach - drop - comp + py) / len, -1, 1));
    const ang = Math.PI + (down - Math.PI) * k;
    r.legPivot.rotation.z = ang; r.legFoot.rotation.z = -ang;
    const f = 0.55, bx = px + Math.sin(ang) * len * f - 0.06 * Math.cos(ang), by = py - Math.cos(ang) * len * f - 0.06 * Math.sin(ang);
    const ex = bx - ax, ey = by - ay, bl = Math.hypot(ex, ey);
    r.legBrace.rotation.z = Math.atan2(-ex, ey); r.legBrace.scale.set(1, Math.max(bl, 0.01), 1);
  } else if (s === 'leg' && r.legPivot) {
    const k = smooth(u.deployK || 0), { h, rw } = def, L = def.legs, { px, py, s: sc } = legGeometry(def);
    // stowed: foot tucked at the bottom of the housing; deployed: foot at (spread, -reach)
    const sx = px + 0.07 * sc, sy = -h / 2 + 0.04 * sc, dx = L.spread, dy = -L.reach + 0.07 * sc + k * Math.min(u.compress || 0, L.stroke || 0.3 * L.reach);   // the pad's sole, 7 cm under its hinge, is what stands at `reach`
    const fx = sx + (dx - sx) * k, fy = sy + (dy - sy) * k;
    const vx = fx - px, vy = fy - py, len = Math.hypot(vx, vy), ang = Math.atan2(vx, -vy);
    r.legPivot.rotation.z = ang;
    r.legPiston.position.y = -len;
    if (r.legRod) r.legRod.scale.y = Math.max(len * 0.92, 0.01);
    r.legFoot.rotation.z = -ang;
    // brace from the bottom of the housing to a point part-way down the strut
    const ax = -rw / 2 + 0.1 * sc, ay = -h / 2 + 0.12 * sc, f = Math.min(0.62, 0.56 * h / len);
    const bx = px + vx * f, by = py + vy * f, ex = bx - ax, ey = by - ay, bl = Math.hypot(ex, ey);
    r.legBrace.position.set(ax, ay, 0); r.legBrace.rotation.z = Math.atan2(-ex, ey); r.legBrace.scale.set(1, Math.max(bl, 0.01), 1);
  } else if (s === 'solar' && r.solarSeg0) {
    const { n, segW } = solarLayout(def), k = smooth(u.deployK || 0), th = (1 - k) * 1.52;
    r.solarSeg0.rotation.y = th; r.solarSeg0.position.z = Math.sin(th) * segW * 0.5;
    for (let i = 1; i < n; i++) r['solarSeg' + i].rotation.y = (i % 2 ? -2 : 2) * th;
  } else if (s === 'solar' && r.fanArm) {
    const { gores } = solarLayout(def), k = u.deployK || 0, ka = smooth(clamp(k * 2, 0, 1)), kf = smooth(clamp(k * 2 - 1, 0, 1));
    r.fanArm.rotation.z = (1 - ka) * Math.PI / 2;
    for (let i = 0; i < gores; i++) r['fan' + i].rotation.z = Math.PI + kf * i * TAU / gores;
  } else if (s === 'wheel') {
    if (r.wheelRetract && def.wheel.retract) r.wheelRetract.rotation.z = (1 - smooth(u.deployK ?? 1)) * 1.5;
    if (r.wheelSpin) r.wheelSpin.rotation.z = -(u.spin || 0);
    if (r.wheelSteer) r.wheelSteer.rotation.x = u.steer || 0;
    if (r.wheelSusp) r.wheelSusp.position.x = -(u.compress || 0) * wheelGeometry(def).travel;
  } else if (s === 'airbrake' && r.brake) {
    const th = smooth(u.deployK || 0) * 1.15, { h, rw } = def, hx = -rw / 2 + 0.05, hy = h / 2 - 0.03, d = h * 0.5;
    r.brake.rotation.z = th;
    const tx = hx + Math.sin(th) * d + Math.cos(th) * 0.03, ty = hy - Math.cos(th) * d + Math.sin(th) * 0.03, ax = -rw / 2 + 0.04, ay = -h * 0.34, ex = tx - ax, ey = ty - ay;
    r.brakePiston.rotation.z = Math.atan2(-ex, ey); r.brakePiston.scale.y = Math.max(Math.hypot(ex, ey), 0.01);
  } else if (s === 'ladder' && r.ladderExt0) {
    const k = smooth(u.deployK || 0); r.ladderExt0.position.y = -k * def.h * 0.92; r.ladderExt1.position.y = -k * def.h * 0.92;
  } else if (s === 'antenna' && r.petal0) {
    const k = smooth(u.deployK || 0), ang = -lerp(1.5, 0.3, k);
    for (let i = 0; r['petal' + i]; i++) r['petal' + i].rotation.z = ang;
  }
  if (u.canopy) {
    const open = !!u.chuteVisible && !!u.rig;
    u.canopy.visible = open;
    if (open) {
      // the cloth is never quite still: a fully open canopy breathes a little, a reefed one flutters
      const full = u.chuteState === 'full' && !(u.chuteFill < 1), t = performance.now() * 0.001;
      let breath = initial ? 1 : 1 + (full ? 0.012 * Math.sin(t * 2.2 + g.id) : 0.04 * Math.sin(t * 11 + g.id) * Math.sin(t * 2.7));
      if (u.chuteDown !== undefined) {
        // Down, and the lines have gone slack: the canopy does not vanish. It topples to one side over about three
        // seconds, loses its air as it goes, and lies flat beside the craft, the cloth stirring a little.
        const k = clamp((t - u.chuteDown) / CANOPY_FALL, 0, 1), fall = k * k * (3 - 2 * k), flat = clamp((t - u.chuteDown) / (CANOPY_FALL * 1.6), 0, 1);
        breath = (1 - 0.3 * flat) * (1 + 0.015 * Math.sin(t * 1.3 + g.id));
        _fallQ.setFromAxisAngle(_fallAxis.set(g.id % 2 ? 1 : -1, 0, 0), fall * CANOPY_LIE);
        u.canopy.quaternion.copy(u.chuteDownQ).multiply(_fallQ);
        drawCanopy(u, u.chuteShape, breath);
        for (const x of u.rig.units) x.unit.scale.set(1, 1, 1 - 0.78 * flat);      // it falls about its own x, so its z is up: the cloth sinks flat
      } else {
        drawCanopy(u, u.chuteShape, breath);
        if (u.chuteWasDown) { u.chuteWasDown = false; for (const x of u.rig.units) x.unit.scale.set(1, 1, 1); }
      }
    }
  }
  if (r.gimbal && u.gimbal) { r.gimbal.rotation.x = u.gimbal.x; r.gimbal.rotation.z = u.gimbal.z; }
  if (r.ctrl && u.control !== undefined) r.ctrl.rotation.x = u.control * 0.44;
}

const HEAT = new THREE.Color();
function applyTint(g) {
  // a heat shield glows on its face (the 'heat' overlay); the rest of it only warms a little
  const u = g.userData, shield = u.heatGlow && u.heatGlow.length > 0, heat = (u.heat || 0) * (shield ? 0.18 : 1), hl = u.highlight ?? null;
  if (shield && !u.ghost) for (const m of u.heatGlow) { m.visible = (u.heat || 0) > 0.01; m.material.opacity = Math.min(1, (u.heat || 0) * 1.25); }
  const key = (hl === null ? 'n' : hl) + ':' + heat.toFixed(2);
  if (u.tintKey === key) return; u.tintKey = key;
  const active = hl !== null || heat > 0.005;
  g.traverse(o => {
    if (!o.isMesh || o.userData.noTint) return;
    if (!active) { if (o.userData.baseMat) o.material = o.userData.baseMat; return; }
    if (!o.userData.tintMat) {
      o.userData.baseMat = o.material;
      if (!o.material.emissive) return;
      o.userData.tintMat = o.material.clone();
    }
    const m = o.userData.tintMat; if (!m) return;
    o.material = m;
    m.emissive.setRGB(1.0 * heat, 0.2 * heat * heat, 0.03 * heat);
    if (hl !== null) m.emissive.add(HEAT.set(hl).multiplyScalar(u.ghost ? 1 : 0.4));
    m.emissiveIntensity = 1 + heat * 1.5;
    if (u.ghost && hl !== null) m.color.set(hl); else if (u.ghost) m.color.set(P.teal);
  });
}

/**
 * Update the visual state of a part. Call it every frame for parts that animate (legs, gear, solar panels,
 * air brakes and parachutes ease toward their target using wall-clock time between calls; the first call snaps).
 * @param {THREE.Group} group  from buildPartMesh (or a THREE.LOD from createPartLOD)
 * @param {object} state
 *   deployed: legs/solar/gear/brakes/ladders/dish → truthy/falsy (or 0..1); chutes → 'stowed'|'armed'|'drogue'|'semi'|'full'|'cut'
 *   chute: for an open parachute, Vessel.chuteView(part): the canopy as the physics has it ({ shape, fill, ... })
 *   throttle: 0..1, ignited: bool, flameout: bool → engine inner glow
 *   temp: skin temperature in K; above 800 K the part ramps to a red-hot emissive tint
 *   gimbal: {x, z} radians | number; control: -1..1; steer: radians; spin: radians; compress: 0..1; light: bool | 0..1
 *   instant: true to skip the easing
 */
export function setPartState(group, state = {}) {
  if (group.isLOD && group.userData.lodLevels) { for (const l of group.userData.lodLevels) setPartState(l, state); return; }
  const u = group.userData, def = u.def; if (!def) return;
  const now = performance.now() / 1000, dt = u.animT === undefined ? 0 : Math.min(Math.max(now - u.animT, 0), 0.1);
  const snap = state.instant || u.animT === undefined; u.animT = now;
  let dirty = snap;

  const dep = u.canopy ? null : deployInfo(def);
  if (dep) {
    if (state.deployed !== undefined) u.deployTarget = typeof state.deployed === 'number' ? clamp(state.deployed, 0, 1) : state.deployed ? 1 : 0;
    const tgt = u.deployTarget ?? dep.initial, prev = u.deployK;
    u.deployK = snap ? tgt : approach(u.deployK ?? dep.initial, tgt, dt / dep.time);
    if (prev !== u.deployK) dirty = true;
  } else if (u.canopy) {
    if (state.deployed !== undefined) u.chuteState = state.deployed === true ? 'full' : state.deployed || 'stowed';
    const st = u.chuteState || 'stowed', open = st === 'drogue' || st === 'semi' || st === 'full';
    // state.chute: the flying canopy (Vessel.chuteView). Without one the part is drawn fully filled in its stage.
    if (state.chute !== undefined) u.chuteLive = state.chute || null;
    const live = open ? u.chuteLive : null;
    // state.chuteDown: the craft is on the ground or the sea. A canopy that was flying when its lines were let go
    // there stays on screen and collapses (applyAnim); one torn away in flight is simply gone.
    if (open) { if (u.chuteDown !== undefined) { u.chuteDown = undefined; u.chuteWasDown = true; } }
    else if (st === 'cut' && u.chuteVisible && u.chuteDown === undefined && state.chuteDown && u.chuteShape && u.canopy) { u.chuteDown = performance.now() * 0.001; u.chuteDownQ = (u.chuteDownQ || new THREE.Quaternion()).copy(u.canopy.quaternion); }
    else if (st !== 'cut') u.chuteDown = undefined;
    const lying = u.chuteDown !== undefined;
    if (lying) { u.chuteVisible = true; dirty = true; }
    else
    u.chuteVisible = open;
    if (open) { u.chuteShape = live && live.shape ? live.shape : restShape(def, st, u.chuteRest || (u.chuteRest = {})); u.chuteFill = live ? live.fill : 1; }
    dirty = true;
  }
  if (state.gimbal !== undefined) { const gm = state.gimbal; u.gimbal = typeof gm === 'number' ? { x: 0, z: gm } : { x: gm.x || 0, z: gm.z || 0 }; dirty = true; }
  if (state.control !== undefined && state.control !== u.control) { u.control = clamp(state.control, -1, 1); dirty = true; }
  if (state.steer !== undefined && state.steer !== u.steer) { u.steer = state.steer; dirty = true; }
  if (state.spin !== undefined && state.spin !== u.spin) { u.spin = state.spin; dirty = true; }
  if (state.compress !== undefined && state.compress !== u.compress) { u.compress = clamp(state.compress, 0, 3); dirty = true; }     // in units of the nominal travel (0.3 R); a loaded strut goes past 1
  if (dirty) applyAnim(group, def);

  if (def.engine && u.glow && u.glow.length && !u.ghost) {
    let lvl = state.throttle !== undefined ? state.throttle : (u.glowLvl || 0);
    if (def.engine.type === 'solid' && state.ignited) lvl = 1;
    if (state.ignited === false || state.flameout) lvl = 0;
    lvl = clamp(lvl, 0, 1);
    if (lvl !== u.glowLvl) {
      u.glowLvl = lvl;
      const k0 = Math.pow(lvl, 0.6), ion = def.engine.type === 'ion', mask = u.ringMask ?? -1;
      for (const m of u.glow) {
        const ring = m.userData.ring, k = ring !== undefined && !(mask >> ring & 1) ? 0 : k0;
        if (ion) m.material.emissive.setRGB(0.25 * k, 0.75 * k, 1.0 * k); else m.material.emissive.setRGB(k, k * (0.55 + 0.35 * k), k * (0.3 + 0.4 * k * k));
        m.material.emissiveIntensity = lvl > 0 && k > 0 ? 0.6 + 3.4 * k : 0;
      }
    }
  }
  if (state.light !== undefined && u.beam && u.beam.length && !u.ghost) {
    const lv = state.light === true ? 1 : clamp(+state.light || 0, 0, 1);
    if (lv !== u.lightLvl) { u.lightLvl = lv; for (const m of u.beam) m.material.emissiveIntensity = lv * 6; }
  }
  if (state.temp !== undefined) {
    const heat = clamp((state.temp - 800) / 1100, 0, 1);
    u.heat = Math.round(heat * 50) / 50;
    applyTint(group);
  }
}

/** A ring cluster burning only some of its rings: `lit` lists the ring indices that are alight (null = all). The
 *  change shows at the next setPartState. */
export function setEngineRings(group, lit) {
  if (group.isLOD && group.userData.lodLevels) { for (const l of group.userData.lodLevels) setEngineRings(l, lit); return; }
  let mask = -1; if (lit) { mask = 0; for (const i of lit) mask |= 1 << i; }
  const u = group.userData; if ((u.ringMask ?? -1) === mask) return;
  u.ringMask = mask; u.glowLvl = undefined;
}

/** Tint a part for hover/selection (emissive). Pass null to remove. Works on ghosts too (recolours them). */
export function highlightPart(group, color = null) {
  if (group.isLOD && group.userData.lodLevels) { for (const l of group.userData.lodLevels) highlightPart(l, color); return; }
  group.userData.highlight = color === null || color === undefined ? null : new THREE.Color(color).getHex();
  applyTint(group);
}

/** Free per-instance materials created for glow / tinting. Shared geometries and materials are kept. */
export function disposePartMesh(group) {
  group.traverse(o => {
    if (!o.isMesh) return;
    if (o.userData.tintMat) { o.userData.tintMat.dispose(); o.userData.tintMat = null; }
    if (o.userData.own) o.material.dispose();
  });
  const rig = group.userData && group.userData.rig;
  if (rig) { for (const geo of rig.own) geo.dispose(); group.userData.rig = null; }
}

// ---------------------------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------------------------
let thumb = null;
/**
 * Render a part to a PNG data URL with a transparent background (2x supersampled, auto-framed).
 * Renderer state (render target, clear colour, viewport, autoClear) is restored afterwards.
 */
export function renderPartThumbnail(renderer, def, size = 96) {
  const S = size * 2;
  ensurePartEnvironment(renderer);
  if (!thumb) {
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 0.9));
    const key = new THREE.DirectionalLight(0xfff4e0, 2.2); key.position.set(2.5, 4, 3.5); scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fe8ff, 1.0); rim.position.set(-3, 1, -3); scene.add(rim);
    thumb = { scene, cam: new THREE.PerspectiveCamera(22, 1, 0.01, 400), rt: null, canvas: document.createElement('canvas'), big: document.createElement('canvas') };
  }
  if (!thumb.rt || thumb.rt.width !== S) {
    if (thumb.rt) thumb.rt.dispose();
    thumb.rt = new THREE.WebGLRenderTarget(S, S, { depthBuffer: true });
    thumb.rt.texture.colorSpace = THREE.SRGBColorSpace;
  }
  const { scene, cam, rt } = thumb;
  const g = buildPartMesh(def, { quality: size <= 96 ? 'medium' : 'high' });   // small icons do not need the full mesh
  if (g.userData.canopy) g.userData.canopy.removeFromParent();
  const sh = def.shape;
  if (sh === 'solar' && !(def.solar && def.solar.fixed)) setPartState(g, { deployed: def.variant === 'fan' ? 1 : 0.55, instant: true });
  else if (sh === 'leg') setPartState(g, { deployed: 0.6, instant: true });
  else if (sh === 'airbrake') setPartState(g, { deployed: 0.7, instant: true });
  else if (sh === 'antenna' && def.variant === 'bigdish') setPartState(g, { deployed: 1, instant: true });
  else if (sh === 'ladder' && def.variant === 'telescopic') setPartState(g, { deployed: 0.5, instant: true });
  if (def.engine) setPartState(g, { throttle: 0.35 });
  if (def.light) setPartState(g, { light: 1 });
  scene.add(g); g.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(g), sph = box.getBoundingSphere(new THREE.Sphere());
  const radial = def.attach && def.attach.radial && !def.attach.stack;
  const flat = sh === 'wing' || sh === 'elevon' || sh === 'tailfin' || sh === 'fin' || sh === 'flap' || (sh === 'solar');
  const elev = def.engine ? -0.36 : def.heatshield ? -0.24 : sh === 'dock' || sh === 'chute' ? 0.6 : 0.36;
  const az = flat ? 0.34 : radial ? 0.95 : sh === 'cockpit' || sh === 'capsule' || sh === 'rover_body' ? 0.5 : 0.62;
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev));
  const dist = (sph.radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.02;
  cam.position.copy(sph.center).addScaledVector(dir, dist); cam.near = dist * 0.05; cam.far = dist * 4; cam.lookAt(sph.center); cam.updateProjectionMatrix();

  const prevRT = renderer.getRenderTarget(), prevColor = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha(), prevAuto = renderer.autoClear;
  const prevXr = renderer.xr.enabled, prevShadow = renderer.shadowMap.autoUpdate; renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = false;
  renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.autoClear = true;
  renderer.clear(); renderer.render(scene, cam);
  const buf = new Uint8Array(S * S * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, S, S, buf);
  renderer.setRenderTarget(prevRT); renderer.setClearColor(prevColor, prevAlpha); renderer.autoClear = prevAuto; renderer.xr.enabled = prevXr; renderer.shadowMap.autoUpdate = prevShadow;
  scene.remove(g); disposePartMesh(g);

  const big = thumb.big; big.width = big.height = S;
  const bctx = big.getContext('2d'), img = bctx.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) {
    const src = (S - 1 - y) * S * 4, dst = y * S * 4;
    for (let x = 0; x < S * 4; x += 4) {
      const a = buf[src + x + 3];
      if (a === 0) continue;
      const k = a < 255 ? 255 / a : 1;
      d[dst + x] = Math.min(255, buf[src + x] * k); d[dst + x + 1] = Math.min(255, buf[src + x + 1] * k); d[dst + x + 2] = Math.min(255, buf[src + x + 2] * k); d[dst + x + 3] = a;
    }
  }
  bctx.putImageData(img, 0, 0);
  const cv = thumb.canvas; cv.width = cv.height = size;
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, size, size); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(big, 0, 0, size, size);
  return cv.toDataURL('image/png');
}
void M; void sub;
