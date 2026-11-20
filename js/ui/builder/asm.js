// Starwright assembly building — pure assembly maths on top of the Craft data model (no DOM, no three.js).
//
// The Craft model (js/core/craft.js) stores every part with a vertical axis: { id, type, pos, rot (yaw), parent,
// node, sym }. Everything here works directly on that documented data, so it keeps working while craft.js grows:
// unknown extra fields on parts are carried along untouched.
//
//   Assembly ("asm")  { parts: [...] }  a detached part with its whole subtree. parts[0] is the assembly root
//                     (parent null, pos 0,0,0, rot 0); every other part is relative to it; parents come before children.
//   Copy spec         { parentId, node, x, y, z, yaw, mirror }  where one copy of an assembly goes in craft coords.
//
// Yaw convention (same as craft.js): outward(a) = (cos a, 0, −sin a); a yaw of +a is three.js rotation.y = a.
import { partDef } from '../../core/parts.js';
import { isMirrorPair, groupIsMirror, flipAssembly, assemblyLayout, partQuat, partAxis, closedNode } from '../../core/craft.js';

export const TAU = Math.PI * 2;
const EPS = 1e-3;
export const outward = a => ({ x: Math.cos(a), y: 0, z: -Math.sin(a) });
export function yawXZ(x, z, a) { const c = Math.cos(a), s = Math.sin(a); return { x: x * c + z * s, z: -x * s + z * c }; }
export const wrapPi = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const copyPart = p => ({ ...p, pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z } });
export const radialW = d => (Number.isFinite(d.rw) ? d.rw : (d.r || 0.15) * 2);
/** Rough half-extent of a part sideways from its axis / centre. */
export const sideExtent = d => (d.attach.stack ? Math.max(d.r || 0, d.rTop || 0, d.rBottom || 0) : Math.max(radialW(d), d.t || 0) / 2);

function resMass(d) { let m = 0; for (const k in d.res) if (k !== 'elec') m += d.res[k]; return m; }
export const wetMass = d => d.mass * 1000 + resMass(d);

// ---------------------------------------------------------------------------------------------- assemblies
export function newAssembly(type) {
  return { parts: [{ id: 1, type, pos: { x: 0, y: 0, z: 0 }, rot: 0, parent: null, node: 'root', sym: 0 }] };
}
export function cloneAssembly(asm) { return { parts: asm.parts.map(copyPart) }; }
export const asmRoot = asm => asm.parts[0];
export const asmDef = asm => partDef(asm.parts[0].type);
export function asmMass(asm) { let m = 0; for (const p of asm.parts) m += wetMass(partDef(p.type)); return m; }
export function asmCost(asm) { let c = 0; for (const p of asm.parts) c += partDef(p.type).cost; return c; }
/** Bounds of an assembly relative to its root: { minY, maxY, maxR }. */
export function asmBounds(asm) {
  let minY = Infinity, maxY = -Infinity, maxR = 0;
  for (const p of asm.parts) {
    const d = partDef(p.type);
    minY = Math.min(minY, p.pos.y - d.h / 2); maxY = Math.max(maxY, p.pos.y + d.h / 2);
    maxR = Math.max(maxR, Math.hypot(p.pos.x, p.pos.z) + sideExtent(d));
  }
  return { minY, maxY, maxR };
}

/** Builds an assembly from a part and its subtree WITHOUT touching the craft. */
export const assemblyOf = (craft, partId) => craft.assemblyOf(partId);
export { isMirrorPair, groupIsMirror, flipAssembly, partQuat, partAxis };

/**
 * Detaches a part with its subtree from the craft (symmetric counterparts and their subtrees are removed too).
 * → { asm, count, mirror, from: { parentId, node, x, y, z, yaw } } or null.
 */
export const detach = (craft, partId) => craft.detachSubtree(partId);

/** Deletes a part, its subtree and its symmetric counterparts. Returns the number of parts removed. */
export function remove(craft, partId) {
  const n = craft.parts.length;
  if (!detach(craft, partId)) return 0;
  return n - craft.parts.length;
}

// ---------------------------------------------------------------------------------------------- nodes
/** Open attachment nodes of the craft in craft coordinates: [{ partId, node: 'top'|'bottom'|'outer', x, y, z, r, dir }]. */
export function openNodes(craft) {
  const out = [];
  for (const p of craft.parts) {
    const d = partDef(p.type);
    if (d.attach.stack) {
      const up = p.flip ? -1 : 1, closed = closedNode(p);
      if (closed !== 'top' && craft.nodeFree(p, 'top')) out.push({ partId: p.id, node: 'top', x: p.pos.x, y: p.pos.y + d.h / 2, z: p.pos.z, r: up > 0 ? d.rTop : d.rBottom, dir: { x: 0, y: 1, z: 0 } });
      if (closed !== 'bottom' && craft.nodeFree(p, 'bottom')) out.push({ partId: p.id, node: 'bottom', x: p.pos.x, y: p.pos.y - d.h / 2, z: p.pos.z, r: up > 0 ? d.rBottom : d.rTop, dir: { x: 0, y: -1, z: 0 } });
    } else if (d.attach.outer && craft.outerFree(p)) {
      const o = outward(p.rot), k = radialW(d) / 2;
      out.push({ partId: p.id, node: 'outer', x: p.pos.x + o.x * k, y: p.pos.y, z: p.pos.z + o.z * k, r: 0.3, dir: o });
    }
  }
  return out;
}
/** Free stack nodes on the root of an assembly, relative to the root centre: [{ node: 'top'|'bottom', y, r }]. */
export function asmNodes(asm) {
  const r = asm.parts[0], d = partDef(r.type), out = [];
  if (!d.attach.stack) return out;
  const kids = asm.parts.filter(p => p.parent === r.id);
  const closed = closedNode(r);
  if (closed !== 'bottom' && !kids.some(k => k.node === 'bottom')) out.push({ node: 'bottom', y: -d.h / 2, r: r.flip ? d.rTop : d.rBottom });
  if (closed !== 'top' && !kids.some(k => k.node === 'top')) out.push({ node: 'top', y: d.h / 2, r: r.flip ? d.rBottom : d.rTop });
  return out;
}

/** Can the assembly's root go on `node` ('top' = sits on top of the target, 'bottom' = hangs below it)? */
export function canStack(craft, asm, targetId, node) {
  const r = asm.parts[0];
  const need = node === 'top' ? 'bottom' : 'top';
  if (!asmNodes(asm).some(n => n.node === need)) return false;
  return craft.canAttachStack(r.type, targetId, node, { flip: !!r.flip });
}
export const canOuter = (craft, asm, targetId) => craft.canAttachOuter(asm.parts[0].type, targetId);
export const canSurface = (craft, asm, targetId) => craft.canAttachRadial(asm.parts[0].type, targetId);
/** Can this assembly start a design (become the root of an empty craft)? */
export function canBeRoot(asm) { const d = asmDef(asm); return !!d.attach.stack && !d.topOnly; }

/** Root position of the assembly for a node / outer / surface attachment → { x, y, z, yaw } (yaw before the held turn). */
export function stackSpec(craft, asm, targetId, node, turn = 0) {
  const t = craft.getPart(targetId), td = partDef(t.type), d = asmDef(asm), dir = node === 'top' ? 1 : -1;
  return { parentId: t.id, node, x: t.pos.x, y: t.pos.y + dir * (td.h / 2 + d.h / 2), z: t.pos.z, yaw: wrapPi(t.rot + turn), mirror: false };
}
export function outerSpec(craft, asm, targetId) {
  const t = craft.getPart(targetId), td = partDef(t.type), d = asmDef(asm);
  const o = outward(t.rot), dist = radialW(td) / 2 + (d.r || 0);
  return { parentId: t.id, node: 'outer', x: t.pos.x + o.x * dist, y: t.pos.y, z: t.pos.z + o.z * dist, yaw: t.rot, mirror: false };
}
export function surfaceSpec(craft, asm, targetId, y, angle) {
  const t = craft.getPart(targetId), td = partDef(t.type), d = asmDef(asm);
  const py = Math.min(t.pos.y + td.h / 2, Math.max(t.pos.y - td.h / 2, y));
  const pitch = asm.parts[0].pitch || 0, half = radialW(d) / 2;
  const o = outward(angle), dist = craft.radiusAt(t, py) + half * Math.cos(pitch);
  return { parentId: t.id, node: 'radial', x: t.pos.x + o.x * dist, y: py + half * Math.sin(pitch), z: t.pos.z + o.z * dist, yaw: wrapPi(angle), mirror: false };
}

// ---------------------------------------------------------------------------------------------- symmetry
/** The part mirrored across the craft's left/right plane (x = 0): itself when it sits on the plane, else its twin. */
export const mirrorPartner = (craft, part) => craft.mirrorPartner(part);
/** All copies that placing `primary` produces (see Craft.symmetryCopies: mirror is parent-relative). */
export const symmetryCopies = (craft, primary, opts) => craft.symmetryCopies(primary, opts);
/** Craft-space layout of one copy: [{ x, y, z, rot, roll }] per assembly part, in assembly order. */
export const layout = assemblyLayout;

// ---------------------------------------------------------------------------------------------- attaching
/** Adds the assembly to the craft once per copy spec. Returns the created craft parts (copy by copy). */
export const attach = (craft, asm, specs) => craft.attachAssembly(asm, specs);

// ---------------------------------------------------------------------------------------------- editing placed parts
/** Makes `partId` the root of the craft. Only parts joined to the root through stack nodes qualify. → { ok, why } */
export const reroot = (craft, partId) => craft.reroot(partId);
/** Slides a part and its subtree by (dx, dy, dz) in craft coords; symmetric counterparts follow in their own frames. */
export const moveSubtree = (craft, partId, dx, dy, dz) => craft.moveSubtree(partId, dx, dy, dz);
/** Turns a part and its subtree about its own axis (surface parts: about the parent's axis) by `ang` radians. */
export const rotateSubtree = (craft, partId, ang) => craft.rotateSubtree(partId, ang);
/** Tilts a childless surface part about its mount (pitch = dihedral, roll = incidence). */
export const tiltPart = (craft, partId, dPitch, dRoll) => craft.tiltPart(partId, dPitch, dRoll);

// ---------------------------------------------------------------------------------------------- collisions
/** Rough solid of a part for overlap tests: a vertical cylinder { x, y, z, r, h2 } (surface parts: a small one). */
function solidOf(p) {
  const d = partDef(p.type);
  if (d.attach.stack) return { x: p.pos.x, y: p.pos.y, z: p.pos.z, r: Math.max(d.r || 0, d.rTop || 0, d.rBottom || 0), h2: d.h / 2 };
  const r = Math.max(0.05, Math.min(radialW(d), d.t || radialW(d)) / 2);
  return { x: p.pos.x, y: p.pos.y, z: p.pos.z, r, h2: Math.max(0.05, Math.min(d.h, radialW(d)) / 2) };
}
/**
 * Parts of the subtree of `partId` (and of its symmetric twins) that sink into a part outside it by more than `slack`
 * metres. The part each one is mounted on is not counted (touching your parent is the point).
 * → [{ a: id in the subtree, b: id it overlaps, depth }]
 */
export function collisions(craft, partId, slack = 0.06) {
  const p = craft.getPart(partId);
  if (!p) return [];
  const moved = new Map();
  for (const m of craft.symmetryGroup(p)) for (const q of craft.subtree(m)) moved.set(q.id, q);
  const out = [];
  for (const q of moved.values()) {
    const a = solidOf(q);
    for (const o of craft.parts) {
      if (moved.has(o.id) || o.id === q.parent) continue;
      const b = solidOf(o);
      const dv = a.h2 + b.h2 - Math.abs(a.y - b.y), dh = a.r + b.r - Math.hypot(a.x - b.x, a.z - b.z);
      const depth = Math.min(dv, dh);
      if (depth > slack) out.push({ a: q.id, b: o.id, depth });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- balance markers
/** Centre of mass, thrust and lift in craft coords: { com, mass, cot, thrust, thrustDir, col, area } (cot / col null if none). */
export function balance(craft) {
  const m = craft.centerOfMass(1), t = craft.centerOfThrust('all'), l = craft.centerOfLift();
  return {
    mass: m.mass, com: m.mass ? { x: m.x, y: m.y, z: m.z } : null,
    thrust: t ? t.thrust / 1000 : 0, cot: t ? { x: t.x, y: t.y, z: t.z } : null, thrustDir: t ? t.dir : null,
    area: l ? l.area : 0, col: l ? { x: l.x, y: l.y, z: l.z } : null,
  };
}

/** Lowest / highest extents of the craft along a craft-space direction ('y' upright, 'z' horizontal builds). */
export function extentAlong(parts, axis = 'y') {
  let lo = Infinity, hi = -Infinity;
  for (const p of parts) {
    const d = partDef(p.type);
    let e;
    if (axis === 'y') e = d.h / 2 + (d.legs ? 0 : 0);
    else e = d.attach.stack ? Math.max(d.r || 0, d.rTop || 0, d.rBottom || 0) : Math.max(radialW(d), d.t || 0, d.wheel ? (d.wheel.radius || 0) * 2 : 0) / 2;
    lo = Math.min(lo, p.pos[axis] - e); hi = Math.max(hi, p.pos[axis] + e);
  }
  return parts.length ? { lo, hi } : { lo: 0, hi: 0 };
}
