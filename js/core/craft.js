// Starwright craft design model: the part tree the builder edits, plus staging and delta-v maths.
// PURE SIMULATION: no DOM, no three.js. Positions are plain {x,y,z} objects in craft coordinates (+Y = nose).
//
// Conventions (see docs/ARCHITECTURE.md):
//  - part.node says how the part hangs off its parent:
//      'root'   the first part
//      'top'    sits ON TOP of the parent   (uses its own bottom node and the parent's top node)
//      'bottom' hangs BELOW the parent      (uses its own top node and the parent's bottom node)
//      'radial' stuck on the parent's side surface
//      'outer'  stack part mounted on a radial decoupler's outer face (both of its stack nodes stay free)
//  - outward(a) = (cos a, 0, -sin a)
//  - stats(): `twr` is thrust / (startMass * body.surfaceG). For the FIRST stage that produces thrust it uses
//    sea-level thrust (liftoff); for every later stage it uses vacuum thrust. `twrVac` / `twrAtm` give both.
import { partDef, currentPartId, engineThrust, engineIsp, G0, PARTS, wantsInterstage, interstageMass } from './parts.js';
import { partActions, ACTION_GROUPS, liftArea, liftSlope } from './vessel.js';

const TAU = Math.PI * 2;
const EPS = 1e-9;
const DEFAULT_BODY = { surfaceG: 9.6 };   // Verda, the home planet
const MAX_SYMMETRY = 12;

export function outward(a) { return { x: Math.cos(a), y: 0, z: -Math.sin(a) }; }

// ---------------------------------------------------------------------- part orientation
// A part's attitude in craft coordinates is  Ry(rot) · Rx(flip ? π : 0) · Rz(pitch) · Rx(roll)  (three.js axis
// conventions, right-handed). `rot` is the yaw every part has always had; the other three are optional and default
// to "none", so designs saved before they existed load and fly exactly as before.
//   flip   stack parts: mounted end for end (its top node points down). Same meaning as `part.flip` in vessel.js.
//   pitch  surface parts: tilt away from the mount about the tangent axis (a wing's dihedral), radians.
//   roll   surface parts: turn about the outward axis (a wing's angle of incidence; π = upside down), radians.
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
/** Orientation quaternion [x, y, z, w] of a craft part (see above). */
export function partQuat(p) {
  const h = (p.rot || 0) / 2;
  let q = [0, Math.sin(h), 0, Math.cos(h)];
  if (p.flip) q = qmul(q, [1, 0, 0, 0]);
  if (p.pitch) q = qmul(q, [0, 0, Math.sin(p.pitch / 2), Math.cos(p.pitch / 2)]);
  if (p.roll) q = qmul(q, [Math.sin(p.roll / 2), 0, 0, Math.cos(p.roll / 2)]);
  return q;
}
/** The part's own +Y axis (nose / top node direction) in craft coordinates. (0, 1, 0) for an untilted part. */
export function partAxis(p) {
  const pt = p.pitch || 0, rl = p.roll || 0;
  if (!p.flip && !pt && !rl) return { x: 0, y: 1, z: 0 };
  let x = -Math.sin(pt) * Math.cos(rl), y = Math.cos(pt) * Math.cos(rl), z = Math.sin(rl);
  if (p.flip) { y = -y; z = -z; }
  const c = Math.cos(p.rot || 0), s = Math.sin(p.rot || 0);
  return { x: x * c + z * s, y, z: -x * s + z * c };
}
function qrot(q, x, y, z) {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  return { x: x + qw * tx + (qy * tz - qz * ty), y: y + qw * ty + (qz * tx - qx * tz), z: z + qw * tz + (qx * ty - qy * tx) };
}
/** Has the part any orientation beyond plain yaw? */
export const isTilted = p => !!(p.flip || p.pitch || p.roll);
const wrapPi = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const yawXZ = (x, z, a) => { const c = Math.cos(a), s = Math.sin(a); return { x: x * c + z * s, z: -x * s + z * c }; };
const ASM_EPS = 1e-3;
const copyPart = p => ({ ...p, pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z } });
const maxOf = (list, key) => list.reduce((m, p) => Math.max(m, p[key] || 0), 0);
/** The stack node a `topOnly` part cannot offer ('top', or 'bottom' when it is flipped); null for other parts. */
export function closedNode(p) { return partDef(p.type).topOnly ? (p.flip ? 'bottom' : 'top') : null; }

const isStageable = d => !!(d.engine || d.decoupler || d.chute);
// Mass (kg) carried as resources: everything except electric charge.
function resMass(def) { let m = 0; for (const k in def.res) if (k !== 'elec') m += def.res[k]; return m; }

export class Craft {
  constructor(name = 'Untitled Craft') {
    this.name = name;
    this.parts = [];
    this.stages = [];
    this.autoStaging = true;   // while true, every edit re-runs autoStage(); moveToStage/insertStage switch it off
    this.actionGroups = {};    // group ('1'..'9' | 'gear' | 'lights' | 'brakes' | 'abort') → [{part: id, action}]
    this.desc = '';            // the designer's notes (kept by toJSON)
    this.site = null;          // 'pad' | 'runway' | null: where the design is meant to start
    this.subassemblies = [];   // loose pieces parked beside the craft in the builder: [{ asm: {parts}, x, y, z, yaw }]
    this._nextId = 1;
    this._nextSym = 1;
  }

  // ------------------------------------------------------------------ lookups
  get root() { return this.parts.find(p => p.parent === null) || null; }
  get isEmpty() { return this.parts.length === 0; }
  getPart(id) {
    if (id && typeof id === 'object') id = id.id;
    return this.parts.find(p => p.id === id) || null;
  }
  def(part) { const p = this.getPart(part); return p ? partDef(p.type) : null; }
  children(part) { const p = this.getPart(part); return p ? this.parts.filter(c => c.parent === p.id) : []; }
  subtree(part) {
    const p = this.getPart(part);
    if (!p) return [];
    const out = [p];
    for (let i = 0; i < out.length; i++) for (const c of this.parts) if (c.parent === out[i].id) out.push(c);
    return out;
  }
  /** All members of the part's symmetry group (just the part itself if it has none). */
  symmetryGroup(part) {
    const p = this.getPart(part);
    if (!p) return [];
    return p.sym ? this.parts.filter(q => q.sym === p.sym) : [p];
  }
  /** The part that steers the craft: first command part, else the root. */
  get controlPart() { return this.parts.find(p => partDef(p.type).command) || this.root; }

  /** Is the stack node ('top'|'bottom') of this part unoccupied? Radial parts have no stack nodes → false. */
  nodeFree(part, node) {
    const p = this.getPart(part);
    if (!p || (node !== 'top' && node !== 'bottom')) return false;
    if (!partDef(p.type).attach.stack) return false;
    if (node === 'top') {
      if (p.node === 'bottom') return false;
      return !this.parts.some(c => c.parent === p.id && c.node === 'top');
    }
    if (p.node === 'top') return false;
    return !this.parts.some(c => c.parent === p.id && c.node === 'bottom');
  }
  /** Is the outer face of a radial decoupler unoccupied? */
  outerFree(part) {
    const p = this.getPart(part);
    if (!p || !partDef(p.type).attach.outer) return false;
    return !this.parts.some(c => c.parent === p.id && c.node === 'outer');
  }

  // ------------------------------------------------------------------ geometry
  /** Surface radius of a stack part at craft-space height y (clamped to the part's extent). */
  radiusAt(part, y) {
    const p = this.getPart(part);
    if (!p) return 0;
    const d = partDef(p.type);
    if (!d.attach.stack) return (d.rw || 0) / 2;
    let f = Math.min(1, Math.max(0, (y - (p.pos.y - d.h / 2)) / d.h));
    if (p.flip) f = 1 - f;
    return d.rBottom + (d.rTop - d.rBottom) * f;
  }
  bounds() {
    let minY = Infinity, maxY = -Infinity, maxR = 0;
    for (const p of this.parts) {
      const d = partDef(p.type);
      minY = Math.min(minY, p.pos.y - d.h / 2);
      maxY = Math.max(maxY, p.pos.y + d.h / 2);
      const ext = d.attach.stack ? Math.max(d.r, d.rTop, d.rBottom) : d.rw / 2;
      maxR = Math.max(maxR, Math.hypot(p.pos.x, p.pos.z) + ext);
    }
    if (!this.parts.length) return { minY: 0, maxY: 0, maxR: 0 };
    return { minY, maxY, maxR };
  }

  // ------------------------------------------------------------------ interstage trusses
  /**
   * The lattice rings that join a stage to the engine above it. Wherever a stack part sits on the nozzle end of a
   * rocket engine, the load must run from rim to rim around the engine, not through its bell: this lists one truss
   * per such joint. It is derived from the part tree (nothing to place, nothing to save) and belongs to the part
   * under the engine, so it leaves with that part when the stack splits there.
   *   [{ owner, engine, dir, h, r0, r1, mass, x, z, y0, y1 }]
   *   owner / engine: part ids. dir: +1 when the truss stands up from the owner (engine above it), −1 when it hangs.
   *   h: its height = the engine's. r0: radius at the owner's rim, r1: at the engine's mount ring. mass in kg.
   *   y0 → y1: craft-space heights of the owner's face and of the mount ring.
   */
  interstages() {
    const out = [];
    for (const e of this.parts) {
      const d = partDef(e.type);
      if (!wantsInterstage(d) || e.pitch || e.roll) continue;
      const side = e.flip ? 'top' : 'bottom';          // the craft-space end the nozzle points at
      let n = this.parts.find(c => c.parent === e.id && c.node === side) || null;
      if (!n && e.parent !== null && e.node === (side === 'bottom' ? 'top' : 'bottom')) n = this.getPart(e.parent);
      if (!n) continue;
      const nd = partDef(n.type);
      if (!nd.attach.stack || n.pitch || n.roll) continue;
      if (Math.abs(n.pos.x - e.pos.x) > ASM_EPS || Math.abs(n.pos.z - e.pos.z) > ASM_EPS) continue;
      const dir = side === 'bottom' ? 1 : -1;
      const y0 = n.pos.y + dir * nd.h / 2, y1 = e.pos.y + dir * d.h / 2;
      const r0 = this.radiusAt(n, y0), r1 = this.radiusAt(e, y1);
      if (!(r0 > 0.05) || !(r1 > 0.05)) continue;      // a point (a nose cone turned over) has no rim to stand a ring on
      out.push({ owner: n.id, engine: e.id, dir, h: d.h, r0, r1, mass: interstageMass(d.h, r0, r1), x: n.pos.x, z: n.pos.z, y0, y1 });
    }
    return out;
  }
  /** Map part id → kg of interstage truss that part carries. */
  _trussKg() {
    const m = new Map();
    for (const t of this.interstages()) m.set(t.owner, (m.get(t.owner) || 0) + t.mass);
    return m;
  }

  // ------------------------------------------------------------------ placement
  _add(type, pos, rot, parent, node, sym, extra = null) {
    const part = { id: this._nextId++, type, pos: { x: pos.x, y: pos.y, z: pos.z }, rot, parent, node, sym };
    if (extra) {
      if (extra.flip) part.flip = true;
      if (Number.isFinite(extra.pitch) && extra.pitch) part.pitch = extra.pitch;
      if (Number.isFinite(extra.roll) && extra.roll) part.roll = extra.roll;
    }
    this.parts.push(part);
    return part;
  }
  _afterAdd(created) {
    if (!created.length) return created;
    if (this.autoStaging) { this._autoStage(); return created; }
    // Manual staging: slot new stageable parts somewhere reasonable without disturbing the player's layout.
    for (const p of created) {
      const d = partDef(p.type);
      if (!isStageable(d)) continue;
      if (!this.stages.length) this.stages.push([]);
      if (d.chute) this.stages[this.stages.length - 1].push(p.id);
      else if (d.engine) this.stages[0].push(p.id);
    }
    const decs = created.filter(p => partDef(p.type).decoupler).map(p => p.id);
    if (decs.length) this.stages.splice(Math.min(1, this.stages.length), 0, decs);
    return created;
  }

  /** Start a design: clears the craft and places `type` as the root at the origin. */
  setRoot(type) {
    let d;
    try { d = partDef(type); } catch { return []; }
    if (!d.attach.stack || d.topOnly) return [];
    this.parts = [];
    this.stages = [];
    this._nextId = 1;
    this._nextSym = 1;
    this.autoStaging = true;
    return this._afterAdd([this._add(type, { x: 0, y: 0, z: 0 }, 0, null, 'root', 0)]);
  }

  /** Would attachStack(type, targetId, node, opts) succeed? `opts.flip`: the new part goes on end for end. */
  canAttachStack(type, targetId, node, opts = null) {
    let d;
    try { d = partDef(type); } catch { return false; }
    const t = this.getPart(targetId);
    if (!t || !d.attach.stack || (node !== 'top' && node !== 'bottom')) return false;
    const td = partDef(t.type);
    if (!td.attach.stack) return false;
    const flip = !!(opts && opts.flip);
    if (d.topOnly && node !== (flip ? 'bottom' : 'top')) return false;   // topOnly parts only sit on top of things (flipped: hang below)
    if (td.topOnly && node === closedNode(t)) return false;              // nothing stacks on a nose cone / parachute
    return this.symmetryGroup(t).every(m => this.nodeFree(m, node));
  }
  attachStack(type, targetId, node, opts = null) {
    if (!this.canAttachStack(type, targetId, node, opts)) return [];
    const d = partDef(type);
    const group = this.symmetryGroup(targetId);
    const sym = group.length > 1 || group[0].sym ? this._nextSym++ : 0;
    const dir = node === 'top' ? 1 : -1;
    const created = group.map(t => {
      const td = partDef(t.type);
      return this._add(type, { x: t.pos.x, y: t.pos.y + dir * (td.h / 2 + d.h / 2), z: t.pos.z }, t.rot, t.id, node, sym, opts);
    });
    return this._afterAdd(created);
  }

  canAttachRadial(type, targetId) {
    let d;
    try { d = partDef(type); } catch { return false; }
    const t = this.getPart(targetId);
    return !!(t && d.attach.radial && partDef(t.type).attach.surface);
  }
  /** y in craft coords (clamped to the target's extent), angle = yaw about the target's axis.
   *  `opts.pitch` / `opts.roll` (radians) tilt the part about its mount: see "part orientation" at the top. */
  attachRadial(type, targetId, y, angle, symmetry = 1, opts = null) {
    if (!this.canAttachRadial(type, targetId)) return [];
    if (!Number.isFinite(y) || !Number.isFinite(angle)) return [];
    const d = partDef(type);
    const target = this.getPart(targetId);
    const n = Math.min(MAX_SYMMETRY, Math.max(1, Math.round(symmetry) || 1));
    const group = this.symmetryGroup(target);
    const sym = n > 1 || group.length > 1 || target.sym ? this._nextSym++ : 0;
    const td = partDef(target.type);
    const dy = Math.min(td.h / 2, Math.max(-td.h / 2, y - target.pos.y));   // height relative to the target centre
    const rel = angle - target.rot;                                          // angle relative to the target's yaw
    const created = [];
    const pitch = opts && Number.isFinite(opts.pitch) ? opts.pitch : 0, half = d.rw / 2;
    for (const t of group) {
      const py = t.pos.y + dy;
      const surf = this.radiusAt(t, py);
      for (let k = 0; k < n; k++) {
        const a = t.rot + rel + k * TAU / n;
        const o = outward(a), dist = surf + half * Math.cos(pitch);
        created.push(this._add(type, { x: t.pos.x + o.x * dist, y: py + half * Math.sin(pitch), z: t.pos.z + o.z * dist }, a, t.id, 'radial', sym, opts));
      }
    }
    return this._afterAdd(created);
  }

  canAttachOuter(type, targetId) {
    let d;
    try { d = partDef(type); } catch { return false; }
    const t = this.getPart(targetId);
    if (!t || !d.attach.stack || d.topOnly) return false;
    if (!partDef(t.type).attach.outer) return false;
    return this.symmetryGroup(t).every(m => this.outerFree(m));
  }
  attachOuter(type, targetId) {
    if (!this.canAttachOuter(type, targetId)) return [];
    const d = partDef(type);
    const group = this.symmetryGroup(targetId);
    const sym = group.length > 1 || group[0].sym ? this._nextSym++ : 0;
    const created = group.map(t => {
      const td = partDef(t.type);
      const o = outward(t.rot), dist = td.rw / 2 + d.r;
      return this._add(type, { x: t.pos.x + o.x * dist, y: t.pos.y, z: t.pos.z + o.z * dist }, t.rot, t.id, 'outer', sym);
    });
    return this._afterAdd(created);
  }

  /** Removes the part's subtree and every symmetric counterpart (with their subtrees). Returns removed parts. */
  removePart(id) {
    const p = this.getPart(id);
    if (!p) return [];
    const gone = new Set();
    for (const m of this.symmetryGroup(p)) for (const q of this.subtree(m)) gone.add(q.id);
    const removed = this.parts.filter(q => gone.has(q.id));
    this.parts = this.parts.filter(q => !gone.has(q.id));
    this.stages = this.stages.map(s => s.filter(pid => !gone.has(pid)));
    this._pruneGroups();
    if (this.autoStaging) this._autoStage();
    return removed;
  }

  // ------------------------------------------------------------------ assemblies (what the builder's hand holds)
  //   Assembly  { parts: [...] }  a part with its whole subtree, detached. parts[0] is the assembly root (parent null,
  //             pos 0,0,0, rot 0); every other part is relative to it; parents come before children. Parts keep
  //             `flip / pitch / roll`, their staging slot (`_stage`) and their action-group bindings (`_actions`:
  //             [[group, action], …]) so a section that is pulled off and put back loses nothing.
  //   Copy spec { parentId, node, x, y, z, yaw, mirror }  where one copy of an assembly goes in craft coordinates.
  /** Builds an assembly from a part and its subtree WITHOUT touching the craft. */
  assemblyOf(partId) {
    const p = this.getPart(partId);
    if (!p) return null;
    const sub = this.subtree(p);
    const ids = new Map(); sub.forEach((q, i) => ids.set(q.id, i + 1));
    const symCount = new Map();
    for (const q of sub) if (q.sym) symCount.set(q.sym, (symCount.get(q.sym) || 0) + 1);
    const acts = new Map();
    for (const g of Object.keys(this.actionGroups)) for (const a of this.actionGroups[g]) {
      if (!ids.has(a.part)) continue;
      if (!acts.has(a.part)) acts.set(a.part, []);
      acts.get(a.part).push([g, a.action]);
    }
    const parts = sub.map((q, i) => {
      const rel = yawXZ(q.pos.x - p.pos.x, q.pos.z - p.pos.z, -p.rot);
      const o = { ...q, id: i + 1, pos: { x: rel.x, y: q.pos.y - p.pos.y, z: rel.z }, rot: wrapPi(q.rot - p.rot),
        parent: i === 0 ? null : ids.get(q.parent), node: i === 0 ? 'root' : q.node, sym: q.sym && symCount.get(q.sym) > 1 && i > 0 ? q.sym : 0 };
      const st = this.stageOf(q.id);
      if (st >= 0) o._stage = st; else delete o._stage;
      if (acts.has(q.id)) o._actions = acts.get(q.id); else delete o._actions;
      return o;
    });
    return { parts };
  }
  /**
   * Detaches a part with its subtree (symmetric counterparts and their subtrees are removed too).
   * → { asm, count, mirror, from: { parentId, node, x, y, z, yaw } } or null. Re-attach with attachAssembly().
   */
  detachSubtree(partId) {
    const p = this.getPart(partId);
    if (!p) return null;
    const group = this.symmetryGroup(p);
    const asm = this.assemblyOf(p.id);
    const count = group.filter(q => q.parent === p.parent).length;
    const mirror = groupIsMirror(group);
    const from = { parentId: p.parent, node: p.node, x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.rot };
    const gone = new Set();
    for (const m of group) for (const q of this.subtree(m)) gone.add(q.id);
    this.parts = this.parts.filter(q => !gone.has(q.id));
    this.stages = this.stages.map(s => s.filter(id => !gone.has(id)));
    if (!this.parts.length) { this.stages = []; this.autoStaging = true; }
    else if (this.autoStaging) this._autoStage();
    this._pruneGroups();
    return { asm, count, mirror, from };
  }
  /**
   * Adds the assembly once per copy spec; returns the created parts (copy by copy). A spec with parentId null /
   * node 'root' makes the assembly the root of an (empty) craft. Staging slots and action-group bindings carried by
   * the assembly are restored on every copy.
   */
  attachAssembly(asm, specs) {
    let nextId = Math.max(this._nextId, maxOf(this.parts, 'id') + 1);
    let nextSym = Math.max(this._nextSym, maxOf(this.parts, 'sym') + 1);
    const multi = specs.length > 1, symIds = new Map();
    const symFor = (p, i) => {
      const key = p.sym ? 's' + p.sym : multi ? 'i' + i : null;
      if (!key) return 0;
      if (!symIds.has(key)) symIds.set(key, nextSym++);
      return symIds.get(key);
    };
    const created = [], staged = [];
    for (const spec of specs) {
      const ids = new Map(), where = assemblyLayout(asm, spec);
      asm.parts.forEach((p, i) => {
        const id = nextId++; ids.set(p.id, id);
        const part = { ...p, id, pos: { x: where[i].x, y: where[i].y, z: where[i].z }, rot: where[i].rot,
          parent: i === 0 ? (spec.parentId ?? null) : ids.get(p.parent), node: i === 0 ? (spec.node || 'root') : p.node, sym: symFor(p, i) };
        delete part._stage; delete part._actions; delete part.flip; delete part.pitch; delete part.roll;
        if (p.flip) part.flip = true;
        if (p.pitch) part.pitch = p.pitch;
        if (where[i].roll) part.roll = where[i].roll;
        this.parts.push(part); created.push(part);
        staged.push(p._stage);
        for (const [g, action] of p._actions || []) {
          if (!ACTION_GROUPS.includes(g) || !partActions(partDef(part.type)).some(a => a.id === action)) continue;
          const list = this.actionGroups[g] || (this.actionGroups[g] = []);
          list.push({ part: id, action });
        }
      });
    }
    this._nextId = nextId; this._nextSym = nextSym;
    if (this.autoStaging !== false) this._autoStage();
    else {
      // Manual staging: put stageable parts back where they were, or somewhere sensible, without disturbing the layout.
      const decs = [];
      created.forEach((p, i) => {
        const d = partDef(p.type);
        if (!isStageable(d)) return;
        if (!this.stages.length) this.stages.push([]);
        const was = staged[i];
        if (Number.isInteger(was) && was >= 0 && was < this.stages.length) this.stages[was].push(p.id);
        else if (d.decoupler) decs.push(p.id);
        else if (d.chute) this.stages[this.stages.length - 1].push(p.id);
        else this.stages[0].push(p.id);
      });
      if (decs.length) this.stages.splice(Math.min(1, this.stages.length), 0, decs);
    }
    return created;
  }
  /** Makes `partId` the root of the craft. Only parts joined to the root through stack nodes qualify. → { ok, why } */
  reroot(partId) {
    const p = this.getPart(partId);
    if (!p) return { ok: false, why: 'No such part.' };
    if (p.parent === null) return { ok: false, why: 'That part is already the root.' };
    const d = partDef(p.type);
    if (!d.attach.stack || d.topOnly) return { ok: false, why: `${d.name} cannot be the root: pick a part with both stack nodes.` };
    const path = [p];
    while (path[path.length - 1].parent !== null) path.push(this.getPart(path[path.length - 1].parent));
    for (let i = 0; i < path.length - 1; i++) {
      if (path[i].node !== 'top' && path[i].node !== 'bottom') return { ok: false, why: 'Only parts in the main stack can become the root.' };
      if (path[i].sym) return { ok: false, why: 'A part in a symmetry group cannot become the root.' };
    }
    const nodes = path.map(q => q.node);
    for (let i = path.length - 1; i >= 1; i--) { path[i].parent = path[i - 1].id; path[i].node = nodes[i - 1] === 'top' ? 'bottom' : 'top'; }
    p.parent = null; p.node = 'root';
    this.parts = [p, ...this.parts.filter(q => q !== p)];
    if (this.autoStaging !== false) this._autoStage();
    return { ok: true };
  }
  _eachMember(partId, fn) {
    const p = this.getPart(partId);
    if (!p) return false;
    const group = this.symmetryGroup(p), mirror = groupIsMirror(group);
    const done = new Set();
    for (const m of group) {
      const sub = this.subtree(m).filter(q => !done.has(q.id));
      for (const q of sub) done.add(q.id);
      fn(m, sub, m === p ? 0 : wrapPi(m.rot - p.rot), mirror && m !== p);
    }
    return true;
  }
  /** Slides a part and its subtree by (dx, dy, dz) in craft coords; symmetric counterparts follow in their own frames. */
  moveSubtree(partId, dx, dy, dz) {
    return this._eachMember(partId, (m, sub, turn, mirrored) => {
      const v = mirrored ? { x: -dx, z: dz } : yawXZ(dx, dz, turn);
      for (const q of sub) { q.pos.x += v.x; q.pos.y += dy; q.pos.z += v.z; }
    });
  }
  /** Turns a part and its subtree about its own axis (surface parts: about the parent's axis) by `ang` radians. */
  rotateSubtree(partId, ang) {
    return this._eachMember(partId, (m, sub, turn, mirrored) => {
      const a = mirrored ? -ang : ang;
      const parent = m.node === 'radial' && m.parent !== null ? this.getPart(m.parent) : null;
      const cx = parent ? parent.pos.x : m.pos.x, cz = parent ? parent.pos.z : m.pos.z;
      for (const q of sub) { const v = yawXZ(q.pos.x - cx, q.pos.z - cz, a); q.pos.x = cx + v.x; q.pos.z = cz + v.z; q.rot = wrapPi(q.rot + a); }
    });
  }
  /**
   * Tilts a surface-attached part about its mount point: `dPitch` away from the surface (dihedral), `dRoll` about
   * its outward axis (incidence). Symmetric counterparts follow (mirrored twins roll the other way). Only parts
   * with nothing hanging off them can be tilted. → true if anything changed.
   */
  tiltPart(partId, dPitch = 0, dRoll = 0) {
    const p = this.getPart(partId);
    if (!p || p.node !== 'radial' || partDef(p.type).attach.stack) return false;
    const group = this.symmetryGroup(p);
    if (group.some(m => this.children(m).length)) return false;
    const mirror = groupIsMirror(group);
    for (const m of group) {
      const d = partDef(m.type), half = (d.rw || 0) / 2, o = outward(m.rot), p0 = m.pitch || 0;
      const mx = m.pos.x - o.x * half * Math.cos(p0), my = m.pos.y - half * Math.sin(p0), mz = m.pos.z - o.z * half * Math.cos(p0);
      const p1 = wrapPi(p0 + dPitch), r1 = wrapPi((m.roll || 0) + (mirror && m !== p ? -dRoll : dRoll));
      m.pos.x = mx + o.x * half * Math.cos(p1); m.pos.y = my + half * Math.sin(p1); m.pos.z = mz + o.z * half * Math.cos(p1);
      if (Math.abs(p1) > 1e-9) m.pitch = p1; else delete m.pitch;
      if (Math.abs(r1) > 1e-9) m.roll = r1; else delete m.roll;
    }
    return true;
  }
  /**
   * All copies that placing `primary` (a copy spec) produces: the builder's own symmetry (`mode` 'radial' ×n about
   * the target's axis, or 'mirror'; only for surface attachments) combined with the symmetry group of the target
   * (a part put on one of four boosters appears on all four).
   * Mirror is parent-relative: across the craft's x = 0 plane when the target sits on it or has a twin on the other
   * side (the copy goes on the twin); otherwise across the target's own fore-aft plane (x = target x), so a part
   * on the left of a lone side pod gets its partner on the right of the same pod.
   */
  symmetryCopies(primary, { mode = 'radial', n = 1 } = {}) {
    const t = this.getPart(primary.parentId);
    if (!t) return [primary];
    let specs = [primary];
    if (primary.node === 'radial') {
      if (mode === 'mirror' && n > 1) {
        const partner = this.mirrorPartner(t);
        if (partner) specs.push({ ...xfMirror(0)(primary), parentId: partner.id });
        else specs.push({ ...xfMirror(t.pos.x)(primary), parentId: t.id });
      } else if (n > 1) {
        for (let k = 1; k < n; k++) specs.push(xfRot(t.pos.x, t.pos.z, k * TAU / n)(primary));
      }
    }
    const group = this.symmetryGroup(t);
    if (group.length > 1) {
      const base = specs.slice();
      for (const m of group) {
        if (m === t) continue;
        const xf = memberTransform(t, m);
        for (const s of base) {
          const src = this.getPart(s.parentId);
          const img = xf({ x: src.pos.x, y: src.pos.y, z: src.pos.z, yaw: src.rot, mirror: false });
          const parent = group.find(q => Math.abs(q.pos.x - img.x) < ASM_EPS && Math.abs(q.pos.y - img.y) < ASM_EPS && Math.abs(q.pos.z - img.z) < ASM_EPS) || m;
          specs.push({ ...xf(s), parentId: parent.id });
        }
      }
    }
    const seen = new Set(), out = [];
    for (const s of specs) {
      const key = s.parentId + '|' + Math.round(s.x * 500) + '|' + Math.round(s.y * 500) + '|' + Math.round(s.z * 500);
      if (seen.has(key)) continue;
      seen.add(key); out.push(s);
    }
    return out;
  }
  /** The part mirrored across the craft's left/right plane (x = 0): itself when it sits on the plane, else its twin (or null). */
  mirrorPartner(part) {
    part = this.getPart(part);
    if (!part) return null;
    if (Math.abs(part.pos.x) < ASM_EPS) return part;
    for (const m of this.symmetryGroup(part)) if (m !== part && isMirrorPair(part, m)) return m;
    // any part of the same type sitting at the mirrored spot will do (hand-built twins)
    return this.parts.find(q => q !== part && q.type === part.type && Math.abs(q.pos.x + part.pos.x) < ASM_EPS && Math.abs(q.pos.y - part.pos.y) < ASM_EPS && Math.abs(q.pos.z - part.pos.z) < ASM_EPS) || null;
  }

  // ------------------------------------------------------------------ staging
  _adjacency(ids) {
    const adj = new Map();
    for (const p of this.parts) if (!ids || ids.has(p.id)) adj.set(p.id, []);
    for (const p of this.parts) {
      if (p.parent === null || !adj.has(p.id) || !adj.has(p.parent)) continue;
      adj.get(p.id).push(p.parent);
      adj.get(p.parent).push(p.id);
    }
    return adj;
  }
  /** Map partId → number of decouplers between the control part and the part (counting the part itself). */
  depths() {
    const depth = new Map();
    const start = this.controlPart;
    if (!start) return depth;
    const adj = this._adjacency();
    depth.set(start.id, partDef(start.type).decoupler ? 1 : 0);
    const queue = [start.id];
    for (let i = 0; i < queue.length; i++) {
      for (const n of adj.get(queue[i])) {
        if (depth.has(n)) continue;
        depth.set(n, depth.get(queue[i]) + (partDef(this.getPart(n).type).decoupler ? 1 : 0));
        queue.push(n);
      }
    }
    return depth;
  }
  /** Map partId → section id. A section is a set of parts connected without crossing a decoupler part.
   *  Decoupler parts themselves get section id -1. `alive` (Set of ids) restricts the graph. */
  sections(alive = null) {
    const adj = this._adjacency(alive);
    const sec = new Map();
    let next = 0;
    for (const p of this.parts) {
      if (!adj.has(p.id) || sec.has(p.id)) continue;
      if (partDef(p.type).decoupler) { sec.set(p.id, -1); continue; }
      const id = next++;
      sec.set(p.id, id);
      const queue = [p.id];
      for (let i = 0; i < queue.length; i++) {
        for (const n of adj.get(queue[i])) {
          if (sec.has(n) || partDef(this.getPart(n).type).decoupler) continue;
          sec.set(n, id);
          queue.push(n);
        }
      }
    }
    return sec;
  }

  /** Rebuilds this.stages from the part tree and switches automatic restaging back on.
   *  Order: [engines of max depth D], then for k = D…1 [decouplers of depth k + engines of depth k−1], then [parachutes].
   *  Exception: a liquid engine of depth k−1 whose section carries depth-k radial decouplers holding boosters
   *  ignites TOGETHER with those boosters (one group earlier), so a core engine lights on the pad with its side boosters. */
  autoStage() {
    this.autoStaging = true;
    this._autoStage();
    return this.stages;
  }
  _autoStage() {
    const depth = this.depths();
    const sec = this.sections();
    const engines = [], decs = [], chutes = [];
    for (const p of this.parts) {
      const d = partDef(p.type);
      if (d.engine) engines.push(p); else if (d.decoupler) decs.push(p); else if (d.chute) chutes.push(p);
    }
    let D = 0;
    for (const p of engines) D = Math.max(D, depth.get(p.id));
    for (const p of decs) D = Math.max(D, depth.get(p.id));
    const groups = [];
    for (let i = 0; i <= D; i++) groups.push([]);
    for (const p of decs) groups[D - depth.get(p.id) + 1].push(p.id);
    // Sections that carry radial decouplers with engines hanging off them, keyed "section:depthOfDecoupler".
    const boosted = new Set();
    for (const dec of decs) {
      if (!partDef(dec.type).attach.outer) continue;
      if (!this.subtree(dec).some(q => partDef(q.type).engine && depth.get(q.id) === depth.get(dec.id))) continue;
      boosted.add(sec.get(dec.parent) + ':' + depth.get(dec.id));
    }
    for (const p of engines) {
      const k = depth.get(p.id);
      let g = D - k;
      if (g > 0 && partDef(p.type).engine.type === 'liquid' && boosted.has(sec.get(p.id) + ':' + (k + 1))) g--;
      groups[g].push(p.id);
    }
    groups.push(chutes.map(p => p.id));
    this.stages = groups.filter(g => g.length).map(g => g.sort((a, b) => a - b));
  }

  stageOf(partId) {
    const id = typeof partId === 'object' ? partId.id : partId;
    return this.stages.findIndex(s => s.includes(id));
  }
  /** Moves a stageable part (engine / decoupler / parachute) to stages[stageIndex]; index == stages.length appends
   *  a new stage. Leaves empty stages in place (call removeEmptyStages()). Turns automatic restaging off. */
  moveToStage(partId, stageIndex) {
    const p = this.getPart(partId);
    if (!p || !isStageable(partDef(p.type)) || !Number.isInteger(stageIndex)) return false;
    const idx = Math.min(Math.max(stageIndex, 0), this.stages.length);
    this.autoStaging = false;
    this.stages = this.stages.map(s => s.filter(id => id !== p.id));
    if (idx === this.stages.length) this.stages.push([]);
    this.stages[idx].push(p.id);
    return true;
  }
  insertStage(index) {
    const idx = Math.min(Math.max(index | 0, 0), this.stages.length);
    this.autoStaging = false;
    this.stages.splice(idx, 0, []);
    return idx;
  }
  removeEmptyStages() { this.stages = this.stages.filter(s => s.length); return this.stages; }

  // ------------------------------------------------------------------ totals
  // ------------------------------------------------------------------ action groups
  /** Actions the part offers (see partActions in vessel.js): [{id, label}]. */
  actionsOf(partId) { const p = this.getPart(partId); return p ? partActions(partDef(p.type)) : []; }
  /** The saved actions of a group: [{part, action}] (a copy). */
  groupActions(group) { return (this.actionGroups[String(group).toLowerCase()] || []).map(a => ({ ...a })); }
  /**
   * Bind a part action to a group. With `symmetry` (default true) the part's symmetric twins are bound too.
   * → true if the part offers the action and the group exists.
   */
  setAction(group, partId, action, symmetry = true) {
    const g = String(group).toLowerCase();
    const part = this.getPart(partId);
    if (!ACTION_GROUPS.includes(g) || !part) return false;
    if (!partActions(partDef(part.type)).some(a => a.id === action)) return false;
    const list = this.actionGroups[g] || (this.actionGroups[g] = []);
    for (const p of symmetry ? this.symmetryGroup(part) : [part]) {
      if (!list.some(a => a.part === p.id && a.action === action)) list.push({ part: p.id, action });
    }
    return true;
  }
  /** Remove one binding (or, with action omitted, every binding of the part in that group). */
  clearAction(group, partId, action = null, symmetry = true) {
    const g = String(group).toLowerCase();
    const list = this.actionGroups[g];
    const part = this.getPart(partId);
    if (!list || !part) return false;
    const ids = new Set((symmetry ? this.symmetryGroup(part) : [part]).map(p => p.id));
    const keep = list.filter(a => !(ids.has(a.part) && (action === null || a.action === action)));
    if (keep.length === list.length) return false;
    if (keep.length) this.actionGroups[g] = keep; else delete this.actionGroups[g];
    return true;
  }
  clearGroup(group) { const g = String(group).toLowerCase(); const had = !!this.actionGroups[g]; delete this.actionGroups[g]; return had; }
  _pruneGroups() {
    const ids = new Set(this.parts.map(p => p.id));
    for (const g of Object.keys(this.actionGroups)) {
      const keep = this.actionGroups[g].filter(a => ids.has(a.part));
      if (keep.length) this.actionGroups[g] = keep; else delete this.actionGroups[g];
    }
  }

  // ------------------------------------------------------------------ balance markers (builder)
  /**
   * Centre of mass in craft coordinates: {x, y, z, mass (kg)}. `fuel` scales the propellant load (1 = full, 0 = dry),
   * so the builder can show how the balance shifts as the tanks empty.
   */
  centerOfMass(fuel = 1) {
    let m = 0, x = 0, y = 0, z = 0;
    for (const p of this.parts) {
      const d = partDef(p.type);
      const pm = d.mass * 1000 + resMass(d) * fuel;
      let px = p.pos.x, py = p.pos.y, pz = p.pos.z;
      if (d.comY) { const ax = partAxis(p); px += ax.x * d.comY; py += ax.y * d.comY; pz += ax.z * d.comY; }   // ballast low in a capsule
      m += pm; x += px * pm; y += py * pm; z += pz * pm;
    }
    for (const t of this.interstages()) { m += t.mass; x += t.x * t.mass; y += (t.y0 + t.y1) / 2 * t.mass; z += t.z * t.mass; }
    return m > 0 ? { x: x / m, y: y / m, z: z / m, mass: m } : { x: 0, y: 0, z: 0, mass: 0 };
  }
  /**
   * Centre of thrust: {x, y, z, thrust (N, vacuum), dir: {x, y, z}} for the engines of `stage` (default: the first
   * stage that has engines; pass 'all' for every engine). `dir` is the direction of the push: (0, 1, 0) unless
   * engines are flipped or tilted; the point is where that push acts (at the nozzles). null when there are no engines.
   */
  centerOfThrust(stage = null) {
    let ids = null;
    if (stage !== 'all') {
      const si = stage === null ? this.stages.findIndex(s => s.some(id => { const p = this.getPart(id); return p && partDef(p.type).engine; })) : stage;
      ids = new Set(si >= 0 && this.stages[si] ? this.stages[si] : []);
      if (!ids.size && stage === null) ids = null;
    }
    let F = 0, x = 0, y = 0, z = 0, dx = 0, dy = 0, dz = 0;
    for (const p of this.parts) {
      const d = partDef(p.type);
      if (!d.engine || (ids && !ids.has(p.id))) continue;
      const f = d.engine.thrust * 1000, ax = partAxis(p), h2 = d.h / 2;
      F += f; x += (p.pos.x - ax.x * h2) * f; y += (p.pos.y - ax.y * h2) * f; z += (p.pos.z - ax.z * h2) * f;
      dx += ax.x * f; dy += ax.y * f; dz += ax.z * f;
    }
    if (!(F > 0)) return null;
    const dl = Math.hypot(dx, dy, dz);
    return { x: x / F, y: y / F, z: z / F, thrust: F, dir: dl > 1e-9 ? { x: dx / dl, y: dy / dl, z: dz / dl } : { x: 0, y: 1, z: 0 }, net: dl };
  }
  /**
   * Centre of lift: the area-and-slope weighted centre of every lifting surface (`wing` parts and fins), with the
   * share of that lift acting along craft Z (`liftZ`, the "wings" of an aeroplane) and along craft X (`liftX`, the
   * vertical tail). A plane flies stably when this point sits a little behind (below in Y) the centre of mass.
   * → {x, y, z, area (m²), liftZ, liftX} or null when nothing lifts.
   */
  centerOfLift() {
    let w = 0, x = 0, y = 0, z = 0, area = 0, lz = 0, lx = 0;
    for (const p of this.parts) {
      const d = partDef(p.type);
      const a = liftArea(d);
      if (!(a > 0)) continue;
      const k = a * liftSlope(d);
      const o = outward(p.rot);
      w += k; area += a;
      x += p.pos.x * k; y += p.pos.y * k; z += p.pos.z * k;
      if (isTilted(p)) { const n = qrot(partQuat(p), 0, 0, 1); lz += k * Math.abs(n.z); lx += k * Math.abs(n.x); }
      else { lz += k * Math.abs(o.x); lx += k * Math.abs(o.z); }       // a surface lifts across its span: normal = (o.z, 0, −o.x)
    }
    return w > 0 ? { x: x / w, y: y / w, z: z / w, area, liftZ: lz / w, liftX: lx / w } : null;
  }

  cost() { let c = 0; for (const p of this.parts) c += partDef(p.type).cost; return c; }
  /** Wet mass in kg. */
  mass() { let m = this.interstageMass(); for (const p of this.parts) { const d = partDef(p.type); m += d.mass * 1000 + resMass(d); } return m; }
  dryMass() { let m = this.interstageMass(); for (const p of this.parts) { const d = partDef(p.type); m += d.mass * 1000 + resMass(d) - (d.res.fuel || 0) - (d.res.solid || 0) - (d.res.xenon || 0); } return m; }
  /** kg of interstage trusses on the craft (counted in mass(), dryMass(), centerOfMass() and stats()). */
  interstageMass() { let m = 0; for (const t of this.interstages()) m += t.mass; return m; }

  /** Per-stage performance, in firing order, with every engine at full throttle.
   *  A stage's burn ends when every burning engine that the NEXT stage would drop has flamed out, or when all
   *  burning engines are out. Engines left burning carry over into the following stage (e.g. a core engine).
   *  Ion engines burn xenon from their own section; jets are left out of delta-v (they have range, not delta-v)
   *  and reported as `jetThrust` (N, static at sea level; counted in `twrAtm`).
   *  Returns [{stage, dvVac, dvAtm, twr, twrVac, twrAtm, burnTime, startMass, endMass, thrust, thrustAtm, jetThrust}]
   *  (m/s, s, kg, N). `thrust` is vacuum thrust at the start of the stage. `twr` = sea level for the first
   *  stage that produces thrust (liftoff), vacuum for the rest, both against body.surfaceG. */
  stats(body = DEFAULT_BODY) {
    const g = body && body.surfaceG > 0 ? body.surfaceG : DEFAULT_BODY.surfaceG;
    const pSea = body && typeof body.pressureAtm === 'function' ? body.pressureAtm(0) : 1;
    const control = this.controlPart;
    const out = [];
    if (!control) return out;
    // `fuel` holds every liquid propellant tank: keyed by part id for fuel, by −id for xenon (ion engines)
    const defs = new Map(), fuel = new Map(), solid = new Map();
    // share of each engine's thrust that pushes along the craft's +Y: 1 unless it is flipped (−1) or tilted (cosine)
    const along = new Map();
    let alive = new Set();
    for (const p of this.parts) {
      const d = partDef(p.type);
      defs.set(p.id, d); alive.add(p.id);
      if (d.engine) along.set(p.id, isTilted(p) ? partAxis(p).y : 1);
      if (d.res.fuel) fuel.set(p.id, d.res.fuel);
      if (d.res.xenon) fuel.set(-p.id, d.res.xenon);
      if (d.res.solid) solid.set(p.id, d.res.solid);
    }
    const ignited = new Set();
    const truss = this._trussKg();   // a truss goes where the part that carries it goes
    const massOf = () => {
      let m = 0;
      for (const id of alive) {
        const d = defs.get(id);
        m += (truss.get(id) || 0) + d.mass * 1000 + resMass(d) - (d.res.fuel || 0) - (d.res.solid || 0) - (d.res.xenon || 0) + (fuel.get(id) || 0) + (fuel.get(-id) || 0) + (solid.get(id) || 0);
      }
      return m;
    };
    // What survives if the decouplers in `stage` fire: the piece still connected to the control part.
    const afterDecouple = (set, stage) => {
      const firing = stage.filter(id => set.has(id) && defs.get(id).decoupler);
      if (!firing.length) return set;
      const rest = new Set(set);
      for (const id of firing) rest.delete(id);
      const adj = this._adjacency(rest);
      const keep = new Set([control.id]);
      const queue = [control.id];
      for (let i = 0; i < queue.length; i++) for (const n of adj.get(queue[i]) || []) if (!keep.has(n)) { keep.add(n); queue.push(n); }
      return keep;
    };
    // Burning engines → [{id, def, mdot, tanks}] given the current propellant state.
    const burning = () => {
      const sec = this.sections(alive);
      const tanksBySec = new Map(), xenonBySec = new Map();
      for (const id of alive) {
        const s = sec.get(id);
        if ((fuel.get(id) || 0) > EPS) { if (!tanksBySec.has(s)) tanksBySec.set(s, []); tanksBySec.get(s).push(id); }
        if ((fuel.get(-id) || 0) > EPS) { if (!xenonBySec.has(s)) xenonBySec.set(s, []); xenonBySec.get(s).push(-id); }
      }
      const list = [];
      for (const id of ignited) {
        if (!alive.has(id)) continue;
        const d = defs.get(id);
        const mdot = d.engine.thrust * 1000 / (d.engine.ispVac * G0);
        if (d.engine.type === 'jet') continue;           // air-breathers have range, not delta-v: see `jetThrust`
        if (d.engine.type === 'solid') { if ((solid.get(id) || 0) > EPS) list.push({ id, def: d, mdot, tanks: null }); }
        else { const tanks = (d.engine.type === 'ion' ? xenonBySec : tanksBySec).get(sec.get(id)); if (tanks) list.push({ id, def: d, mdot, tanks }); }
      }
      return list;
    };
    let lifted = false;
    for (let si = 0; si < this.stages.length; si++) {
      const stage = this.stages[si];
      alive = afterDecouple(alive, stage);
      for (const id of stage) if (alive.has(id) && defs.get(id).engine) ignited.add(id);
      const next = this.stages[si + 1];
      const survivors = next ? afterDecouple(alive, next) : alive;
      const startMass = massOf();
      let mass = startMass, dvVac = 0, dvAtm = 0, burnTime = 0, thrust = 0, thrustAtm = 0, first = true, jetThrust = 0;
      for (const id of ignited) if (alive.has(id) && defs.get(id).engine.type === 'jet') jetThrust += defs.get(id).engine.thrust * 1000 * Math.max(0, along.get(id));
      for (let guard = 0; guard < 10000; guard++) {
        const eng = burning();
        if (first) {
          for (const e of eng) { const k = along.get(e.id); thrust += engineThrust(e.def, 0) * k; thrustAtm += engineThrust(e.def, pSea) * k; }
          thrust = Math.max(0, thrust); thrustAtm = Math.max(0, thrustAtm);
          first = false;
        }
        if (!eng.length) break;
        const doomed = eng.filter(e => !survivors.has(e.id));
        const everDoomed = [...ignited].some(id => alive.has(id) && !survivors.has(id));
        if (everDoomed && !doomed.length) break;   // everything the next stage drops is spent: time to stage
        // Constant-flow segment up to the next tank / booster running dry.
        const drain = new Map();
        let fVac = 0, fAtm = 0, mdot = 0, dt = Infinity;
        for (const e of eng) {
          const k = along.get(e.id);
          fVac += engineThrust(e.def, 0) * k; fAtm += engineThrust(e.def, pSea) * k; mdot += e.mdot;
          if (!e.tanks) { drain.set('s' + e.id, e.mdot); dt = Math.min(dt, solid.get(e.id) / e.mdot); }
          else for (const t of e.tanks) drain.set(t, (drain.get(t) || 0) + e.mdot / e.tanks.length);
        }
        for (const [key, rate] of drain) if (typeof key === 'number') dt = Math.min(dt, fuel.get(key) / rate);
        for (const [key, rate] of drain) {
          const map = typeof key === 'number' ? fuel : solid, id = typeof key === 'number' ? key : +key.slice(1);
          const left = map.get(id) - rate * dt;
          map.set(id, left < 1e-6 ? 0 : left);
        }
        const m1 = massOf();
        const ln = Math.log(mass / m1);
        dvVac += Math.max(0, fVac) / mdot * ln; dvAtm += Math.max(0, fAtm) / mdot * ln;
        burnTime += dt; mass = m1;
      }
      const twrVac = thrust / (startMass * g), twrAtm = (thrustAtm + jetThrust) / (startMass * g);
      const liftoff = !lifted && (thrust > 0 || jetThrust > 0);
      if (liftoff) lifted = true;
      out.push({ stage: si, dvVac, dvAtm, twr: liftoff ? twrAtm : twrVac, twrVac, twrAtm, burnTime, startMass, endMass: mass, thrust, thrustAtm, jetThrust });
    }
    return out;
  }
  /** Totals over stats(): {vac, atm} in m/s. */
  deltaV(body = DEFAULT_BODY) {
    let vac = 0, atm = 0;
    for (const s of this.stats(body)) { vac += s.dvVac; atm += s.dvAtm; }
    return { vac, atm };
  }

  validate(body = DEFAULT_BODY) {
    const errors = [], warnings = [];
    if (!this.parts.length) { errors.push('The craft has no parts.'); return { ok: false, errors, warnings }; }
    const defs = this.parts.map(p => partDef(p.type));
    if (!defs.some(d => d.command)) errors.push('No command part: add a capsule or probe core.');
    const stats = this.stats(body);
    if (!defs.some(d => d.engine)) warnings.push('No engines: this craft is going nowhere.');
    else {
      const staged = new Set(this.stages.flat());
      if (this.parts.some(p => partDef(p.type).engine && !staged.has(p.id))) warnings.push('Some engines are not in any stage.');
      const firstBurn = stats.find(s => s.thrust > 0 || s.jetThrust > 0);
      const winged = defs.some(d => d.wing) && defs.some(d => d.wheel);
      if (!firstBurn) warnings.push('The engines have no propellant.');
      else if (firstBurn.twr < 1 && !winged) warnings.push(`Liftoff thrust-to-weight is ${firstBurn.twr.toFixed(2)}: too heavy to leave the pad.`);
      if (winged) {
        const com = this.centerOfMass(), col = this.centerOfLift();
        if (col && col.y > com.y + 0.05) warnings.push('The centre of lift is ahead of the centre of mass: this aircraft will want to flip.');
      }
      if (defs.some(d => d.engine && d.engine.type === 'ion') && !defs.some(d => d.res && d.res.xenon > 0)) warnings.push('Ion engines need xenon.');
    }
    if (defs.some(d => d.command === 'crew') && !defs.some(d => d.chute)) warnings.push('Crewed craft has no parachute.');
    this.stages.forEach((s, i) => { if (!s.length) warnings.push(`Stage ${i + 1} is empty.`); });
    return { ok: errors.length === 0, errors, warnings };
  }

  // ------------------------------------------------------------------ persistence
  toJSON() {
    return {
      version: 1, name: this.name,
      parts: this.parts.map(partJSON),
      stages: this.stages.map(s => s.slice()),
      autoStaging: this.autoStaging,
      ...(Object.keys(this.actionGroups).length ? { actionGroups: JSON.parse(JSON.stringify(this.actionGroups)) } : {}),
      ...(this.desc ? { desc: this.desc } : {}),
      ...(this.site ? { site: this.site } : {}),
      ...(this.subassemblies.length ? { subassemblies: this.subassemblies.map(l => ({ asm: { parts: l.asm.parts.map(q => ({ ...partJSON(q), ...(Number.isInteger(q._stage) ? { _stage: q._stage } : {}), ...(q._actions ? { _actions: q._actions.map(a => a.slice()) } : {}) })) }, x: l.x, y: l.y, z: l.z, yaw: l.yaw || 0 })) } : {}),
    };
  }
  static fromJSON(o) {
    if (typeof o === 'string') o = JSON.parse(o);
    const c = new Craft(o.name || 'Untitled Craft');
    for (const p of o.parts || []) {
      if (p && p.type !== currentPartId(p.type)) p.type = currentPartId(p.type);   // a design saved before a part was renamed
      partDef(p.type);   // throws on unknown part types
      c.parts.push(partFromJSON(p));
    }
    if (typeof o.desc === 'string') c.desc = o.desc;
    if (o.site === 'pad' || o.site === 'runway') c.site = o.site;
    for (const l of Array.isArray(o.subassemblies) ? o.subassemblies : []) {
      try {
        if (!l || !l.asm || !Array.isArray(l.asm.parts) || !l.asm.parts.length) continue;
        const parts = l.asm.parts.map(q => {
          if (q && q.type !== currentPartId(q.type)) q.type = currentPartId(q.type);
          partDef(q.type);
          const out = partFromJSON(q);
          if (Number.isInteger(q._stage)) out._stage = q._stage;
          if (Array.isArray(q._actions)) out._actions = q._actions.filter(a => Array.isArray(a) && ACTION_GROUPS.includes(a[0]) && typeof a[1] === 'string').map(a => [a[0], a[1]]);
          return out;
        });
        c.subassemblies.push({ asm: { parts }, x: +l.x || 0, y: +l.y || 0, z: +l.z || 0, yaw: +l.yaw || 0 });
      } catch { /* a piece made of parts this build does not know: leave it out */ }
    }
    const ids = new Set(c.parts.map(p => p.id));
    c.stages = (o.stages || []).map(s => s.filter(id => ids.has(id)));
    c.autoStaging = o.autoStaging !== false;
    if (o.actionGroups && typeof o.actionGroups === 'object') {
      for (const g of ACTION_GROUPS) {
        const list = Array.isArray(o.actionGroups[g]) ? o.actionGroups[g].filter(a => a && ids.has(a.part) && typeof a.action === 'string') : [];
        if (list.length) c.actionGroups[g] = list.map(a => ({ part: a.part, action: a.action }));
      }
    }
    c._nextId = c.parts.reduce((m, p) => Math.max(m, p.id), 0) + 1;
    c._nextSym = c.parts.reduce((m, p) => Math.max(m, p.sym), 0) + 1;
    return c;
  }
  clone() { return Craft.fromJSON(JSON.parse(JSON.stringify(this.toJSON()))); }
}

// ---------------------------------------------------------------------- assembly helpers
export function isMirrorPair(a, b) {
  return Math.abs(a.pos.x + b.pos.x) < ASM_EPS && Math.abs(a.pos.y - b.pos.y) < ASM_EPS && Math.abs(a.pos.z - b.pos.z) < ASM_EPS &&
    Math.abs(a.pos.x) > ASM_EPS && Math.abs(wrapPi(b.rot - (Math.PI - a.rot))) < 1e-3;
}
/** Is this symmetry group a left/right mirror pair (as opposed to copies turned about an axis)? */
export function groupIsMirror(group) {
  return group.length === 2 && isMirrorPair(group[0], group[1]) && Math.abs(group[0].pos.z) > ASM_EPS;
}
const xfRot = (cx, cz, ang, dy = 0) => s => { const v = yawXZ(s.x - cx, s.z - cz, ang); return { ...s, x: cx + v.x, y: s.y + dy, z: cz + v.z, yaw: wrapPi(s.yaw + ang) }; };
const xfMove = (dx, dy, dz) => s => ({ ...s, x: s.x + dx, y: s.y + dy, z: s.z + dz });
const xfMirror = (px = 0) => s => ({ ...s, x: 2 * px - s.x, yaw: wrapPi(Math.PI - s.yaw), mirror: !s.mirror });
/** The transform that carries symmetry-group member `a` onto member `b`. */
function memberTransform(a, b) {
  if (isMirrorPair(a, b)) return xfMirror(0);
  const d = wrapPi(b.rot - a.rot);
  if (Math.abs(d) < 1e-6) return xfMove(b.pos.x - a.pos.x, b.pos.y - a.pos.y, b.pos.z - a.pos.z);
  // solve c + R(d)(a − c) = b for the axis c:  (I − R) c = b − R a
  const ra = yawXZ(a.pos.x, a.pos.z, d), c = Math.cos(d), s = Math.sin(d);
  const bx = b.pos.x - ra.x, bz = b.pos.z - ra.z, det = (1 - c) * (1 - c) + s * s;
  const cx = ((1 - c) * bx + s * bz) / det, cz = (-s * bx + (1 - c) * bz) / det;
  return xfRot(cx, cz, d, b.pos.y - a.pos.y);
}
/** Craft-space layout of one copy of an assembly: [{ x, y, z, rot, roll }] per assembly part, in assembly order.
 *  A mirrored copy keeps each part's pitch and reverses its roll. */
export function assemblyLayout(asm, spec) {
  return asm.parts.map(p => {
    const v = yawXZ(p.pos.x, spec.mirror ? -p.pos.z : p.pos.z, spec.yaw);
    return { x: spec.x + v.x, y: spec.y + p.pos.y, z: spec.z + v.z, rot: wrapPi(spec.yaw + (spec.mirror ? -p.rot : p.rot)), roll: spec.mirror ? -(p.roll || 0) : (p.roll || 0) };
  });
}
/** Turns a whole assembly end for end about its root (rotation by π about the root's X axis): every part's
 *  `flip` toggles and stack children swap nodes. Returns the same assembly. */
export function flipAssembly(asm) {
  for (const p of asm.parts) {
    p.pos.y = -p.pos.y; p.pos.z = -p.pos.z; p.rot = wrapPi(-p.rot);
    if (partDef(p.type).attach.stack) { if (p.flip) delete p.flip; else p.flip = true; }
    else { const r = wrapPi((p.roll || 0) + Math.PI); if (Math.abs(r) > 1e-9) p.roll = r; else delete p.roll; if (p.pitch) p.pitch = -p.pitch; }
    if (p.node === 'top') p.node = 'bottom'; else if (p.node === 'bottom') p.node = 'top';
  }
  return asm;
}

function partJSON(p) {
  const o = { id: p.id, type: p.type, pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z }, rot: p.rot, parent: p.parent, node: p.node, sym: p.sym };
  if (p.flip) o.flip = true;
  if (p.pitch) o.pitch = p.pitch;
  if (p.roll) o.roll = p.roll;
  return o;
}
function partFromJSON(p) {
  const o = { id: p.id, type: p.type, pos: { x: +p.pos.x, y: +p.pos.y, z: +p.pos.z }, rot: +p.rot || 0, parent: p.parent ?? null, node: p.node, sym: p.sym || 0 };
  if (p.flip) o.flip = true;
  if (Number.isFinite(+p.pitch) && +p.pitch) o.pitch = +p.pitch;
  if (Number.isFinite(+p.roll) && +p.roll) o.roll = +p.roll;
  return o;
}

// ---------------------------------------------------------------------- stock designs
// Stacks `types` downward from `from` (each hangs below the previous); returns the created parts.
function stackDown(craft, from, types) {
  const made = [];
  let cur = from;
  for (const t of types) {
    const [p] = craft.attachStack(t, cur.id, 'bottom');
    if (!p) throw new Error(`stock craft: cannot attach ${t}`);
    made.push(p); cur = p;
  }
  return made;
}
const bottomY = (craft, p) => p.pos.y - partDef(p.type).h / 2;

function hopper() {
  const c = new Craft('Hopper I');
  const [pod] = c.setRoot('pod_acorn');
  c.attachStack('chute', pod.id, 'top');
  const [srb] = stackDown(c, pod, ['srb_ember']);
  c.attachRadial('fin', srb.id, bottomY(c, srb) + 0.5, Math.PI / 4, 3);
  c.autoStage();                                   // [booster] [parachute]
  return c;
}

function skylark() {
  const c = new Craft('Skylark II');
  const [pod] = c.setRoot('pod_acorn');
  c.attachStack('chute', pod.id, 'top');
  const s = stackDown(c, pod, ['heatshield_m', 'dec_m', 'tank_m400', 'eng_sparrow', 'dec_m', 'tank_m800', 'tank_m200', 'eng_goshawk']);
  const lowTank = s[6];
  c.attachRadial('fin', lowTank.id, bottomY(c, lowTank) + 0.5, Math.PI / 4, 4);
  c.autoStage();                                   // [Goshawk] [separator + Sparrow] [capsule separator] [parachute]
  return c;
}

function pellRunner() {
  const c = new Craft('Pell Runner');
  const [pod] = c.setRoot('pod_acorn');
  c.attachStack('chute', pod.id, 'top');
  const s = stackDown(c, pod, [
    'heatshield_m', 'dec_m',
    'battery', 'tank_m400', 'eng_sparrow',                       // lander / return stage
    'dec_m', 'tank_m800', 'eng_sparrow',                         // transfer stage
    'dec_m', 'adapter_lm', 'tank_l3200', 'tank_l3200', 'eng_condor', // lifter
  ]);
  const landerTank = s[3], lifterTank = s[11];
  c.attachRadial('legs', landerTank.id, bottomY(c, landerTank), Math.PI / 4, 4);
  c.attachRadial('solar', landerTank.id, landerTank.pos.y + 1.2, 0, 2);
  c.attachRadial('sci_thermo', landerTank.id, landerTank.pos.y + 1.2, Math.PI / 2, 1);
  c.attachRadial('fin_ctrl', lifterTank.id, bottomY(c, lifterTank) + 0.5, Math.PI / 4, 4);
  c.autoStage();   // [Condor] [sep + transfer Sparrow] [sep + lander Sparrow] [capsule separator] [parachute]
  return c;
}

function emberTwin() {
  // Skylark-class core with two strap-on solid boosters: shows radial decouplers and hand-tuned staging.
  const c = new Craft('Ember Twin');
  const [pod] = c.setRoot('pod_acorn');
  c.attachStack('chute', pod.id, 'top');
  const s = stackDown(c, pod, ['heatshield_m', 'dec_m', 'tank_m400', 'eng_sparrow', 'dec_m', 'tank_m800', 'tank_m800', 'eng_goshawk']);
  const lowTank = s[6], core = s[7];
  const clamps = c.attachRadial('dec_radial', lowTank.id, lowTank.pos.y - 1.5, 0, 2);
  const boosters = c.attachOuter('srb_ember', clamps[0].id);
  c.attachStack('nose_m', boosters[0].id, 'top');
  c.attachRadial('fin', lowTank.id, bottomY(c, lowTank) + 0.5, Math.PI / 2, 2);
  c.autoStage();
  // Hand-tuned: boosters and the core Goshawk light together on the pad; the clamps get a stage of their own.
  c.moveToStage(core.id, 0);
  for (const b of boosters) c.moveToStage(b.id, 0);
  for (const k of clamps) c.moveToStage(k.id, 1);
  c.removeEmptyStages();
  return c;
}

function moteSounder() {
  // A little low-altitude sounding rocket that comes home: one flask, a Moth, a thermometer and a pressure gauge,
  // and a parachute on the nose. Fly it straight up (stage 1), stage again near the top to arm the parachute.
  const c = new Craft('Mote Sounder');
  const [core] = c.setRoot('probe_mote');
  c.attachStack('chute', core.id, 'top');
  const s = stackDown(c, core, ['tank_s50', 'eng_moth']);
  c.attachRadial('sci_thermo', s[0].id, s[0].pos.y, 0, 1);
  c.attachRadial('sci_baro', s[0].id, s[0].pos.y, Math.PI, 1);   // same size and drag as the thermometer: it flies straight
  c.autoStage();                                   // [Moth] [parachute]
  return c;
}

function latchTarget() {
  // A small uncrewed station module that flies itself to orbit: its upper stage IS the station.
  // Latch Ring S on the nose, probe core, battery, solar panels; the tank keeps what the ascent leaves over.
  const c = new Craft('Latch Target');
  const [core] = c.setRoot('probe_wisp');
  const [ad] = c.attachStack('adapter_ms', core.id, 'top');
  c.attachStack('dock_s', ad.id, 'top');
  const s = stackDown(c, core, ['battery', 'gyro', 'tank_m400', 'eng_sparrow', 'dec_m', 'tank_m800', 'tank_m200', 'eng_goshawk']);
  const tank = s[2], lowTank = s[6];
  c.attachRadial('solar', tank.id, tank.pos.y + 0.8, 0, 2);
  c.attachRadial('antenna', tank.id, tank.pos.y + 1.2, Math.PI / 2, 1);
  c.attachRadial('fin', lowTank.id, bottomY(c, lowTank) + 0.5, Math.PI / 4, 4);
  c.autoStage();                                   // [Goshawk] [separator + Sparrow]
  return c;
}

function latchChaser() {
  // Crewed two-stage ship built to dock: Latch Ring S on the capsule nose (so the parachutes ride on the
  // capsule's flanks), a service module with monopropellant and four Huff thruster blocks for translation.
  const c = new Craft('Latch Chaser');
  const [pod] = c.setRoot('pod_acorn');
  c.attachStack('dock_s', pod.id, 'top');
  c.attachRadial('chute_radial', pod.id, pod.pos.y + 0.1, 0, 2);
  const s = stackDown(c, pod, ['heatshield_m', 'dec_m', 'tank_mono', 'tank_m400', 'eng_sparrow', 'dec_m', 'tank_m800', 'tank_m800', 'eng_goshawk']);
  const svc = s[3], lowTank = s[7], core = s[8];
  c.attachRadial('rcs', svc.id, svc.pos.y + 1.0, Math.PI / 4, 4);
  c.attachRadial('solar', svc.id, svc.pos.y - 0.9, Math.PI / 2, 2);
  const clamps = c.attachRadial('dec_radial', lowTank.id, lowTank.pos.y - 1.5, 0, 2);
  const boosters = c.attachOuter('srb_ember', clamps[0].id);
  c.attachStack('nose_m', boosters[0].id, 'top');
  c.attachRadial('fin', lowTank.id, bottomY(c, lowTank) + 0.5, Math.PI / 2, 2);
  c.autoStage();
  // Boosters and the core Goshawk light together; then [clamps] [separator + Sparrow] [capsule separator] [parachutes].
  c.moveToStage(core.id, 0);
  for (const b of boosters) c.moveToStage(b.id, 0);
  for (const k of clamps) c.moveToStage(k.id, 1);
  c.removeEmptyStages();
  return c;
}

// ---------------------------------------------------------------------- second-pass stock designs
// Aircraft and rovers are built nose-forward along +Y with their wheels on the −Z side (radial angle π/2 points
// down, −π/2 up, 0 and π are the right and left wing roots). Launch them from the runway.
const DOWN = Math.PI / 2, UP = -Math.PI / 2;
const has = (...ids) => ids.every(id => !!PARTS[id]);
/** The stack part of `craft` on the centreline that spans height y (or the nearest one). */
function partAtY(craft, y) {
  let best = null, bd = Infinity;
  for (const p of craft.parts) {
    const d = partDef(p.type);
    if (!d.attach.stack || !d.attach.surface || Math.abs(p.pos.x) > 1e-6 || Math.abs(p.pos.z) > 1e-6) continue;
    const dist = Math.max(0, Math.abs(y - p.pos.y) - d.h / 2);
    if (dist < bd) { bd = dist; best = p; }
  }
  return best;
}
/** Main wheels a little behind the centre of mass (so the tail can lift the nose), splayed for track width. */
function addMainGear(c, type, behind = 0.45, splay = 0.75) {
  const y = c.centerOfMass().y - behind;
  return c.attachRadial(type, partAtY(c, y).id, y, DOWN - splay, 1).concat(c.attachRadial(type, partAtY(c, y).id, y, DOWN + splay, 1));
}

/** Slide a symmetric pair of wings along the fuselage until the centre of lift sits `margin` m behind the centre of mass. */
function balanceWings(c, wings, margin = 0.3) {
  for (let k = 0; k < 12; k++) {
    // measured against the aft-most centre of mass the craft will ever have (full or empty)
    const col = c.centerOfLift(), comY = Math.min(c.centerOfMass(1).y, c.centerOfMass(0).y);
    const err = (comY - margin) - col.y;
    if (Math.abs(err) < 0.02) break;
    for (const w of wings) w.pos.y += err * 1.4;
  }
}

function kiteTrainer() {
  // A small jet: one seat, straight wings, a tail you can see from the cockpit. Runway take-off at about 65 m/s.
  if (!has('cockpit_swift', 'fus_m_hollow', 'fus_tail', 'jet_midge', 'wing_broad', 'tail_swallow', 'tail_rudder', 'elevon_m', 'gear_tuck_s', 'gear_tuck_m', 'intake_gill')) return null;
  const c = new Craft('Kite Trainer');
  const [cock] = c.setRoot('cockpit_swift');
  const [fus, tail] = stackDown(c, cock, ['fus_m_hollow', 'fus_tail', 'jet_midge']);
  c.attachRadial('intake_gill', fus.id, fus.pos.y + 0.55, 0, 2);
  const wings = c.attachRadial('wing_broad', fus.id, fus.pos.y, 0, 2);
  c.attachRadial('elevon_m', tail.id, tail.pos.y - 0.2, 0, 2);
  c.attachRadial('tail_swallow', tail.id, tail.pos.y - 0.75, 0, 2);
  c.attachRadial('tail_rudder', tail.id, tail.pos.y - 0.35, UP, 1);
  c.attachRadial('gear_tuck_s', cock.id, cock.pos.y - 0.2, DOWN, 1);
  if (has('light_glim')) c.attachRadial('light_glim', cock.id, cock.pos.y - 0.6, DOWN, 1);
  balanceWings(c, wings, 0.35);
  addMainGear(c, 'gear_tuck_m');
  c.autoStage();
  return c;
}

function skimmer() {
  // A rocket plane: off the runway on its own engine, a zoom climb to the edge of space, and a glide home.
  if (!has('cockpit_swift', 'fus_m_long', 'fus_m', 'eng_harrier', 'wing_glide', 'elevon_m', 'tail_swallow', 'tail_rudder', 'gear_tuck_s', 'gear_tuck_m', 'airbrake')) return null;
  const c = new Craft('Skimmer');
  const [cock] = c.setRoot('cockpit_swift');
  const [f1, f2] = stackDown(c, cock, ['fus_m_long', 'fus_m', 'eng_harrier']);
  const wings = c.attachRadial('wing_glide', f1.id, f1.pos.y, 0, 2);
  const wings2 = c.attachRadial('wing_broad', f2.id, f2.pos.y, 0, 2);
  c.attachRadial('elevon_m', f2.id, f2.pos.y - 0.6, 0, 2);
  c.attachRadial('tail_swallow', f2.id, f2.pos.y - 0.85, 0.5, 1);
  c.attachRadial('tail_swallow', f2.id, f2.pos.y - 0.85, Math.PI - 0.5, 1);
  c.attachRadial('tail_rudder', f2.id, f2.pos.y - 0.4, UP, 1);
  const brakes = c.attachRadial('airbrake', f1.id, f1.pos.y + 1.2, UP + 0.6, 1).concat(c.attachRadial('airbrake', f1.id, f1.pos.y + 1.2, UP - 0.6, 1));
  c.attachRadial('gear_tuck_s', cock.id, cock.pos.y - 0.2, DOWN, 1);
  if (has('battery_brick')) c.attachRadial('battery_brick', f1.id, f1.pos.y + 1.5, UP, 1);
  balanceWings(c, wings.concat(wings2), 0.4);
  addMainGear(c, 'gear_tuck_m', 0.5);
  c.autoStage();
  for (const b of brakes) c.setAction('brakes', b.id, 'toggleAirbrake', false);
  return c;
}

function trundleScout() {
  // A six-wheeled rover: drive it straight off the runway apron. W/S drive, A/D steer, B brakes.
  if (!has('rover_trundle', 'wheel_scamper', 'solar_tile', 'battery_brick', 'antenna', 'light_glim', 'sci_seis', 'sci_grav')) return null;
  const c = new Craft('Trundle Scout');
  const [body] = c.setRoot('rover_trundle');
  for (const dy of [0.62, 0, -0.62]) {
    c.attachRadial('wheel_scamper', body.id, body.pos.y + dy, DOWN - 1.0, 1);
    c.attachRadial('wheel_scamper', body.id, body.pos.y + dy, DOWN + 1.0, 1);
  }
  c.attachRadial('solar_tile', body.id, body.pos.y + 0.4, UP - 0.35, 1);
  c.attachRadial('solar_tile', body.id, body.pos.y + 0.4, UP + 0.35, 1);
  c.attachRadial('solar_tile', body.id, body.pos.y - 0.4, UP - 0.35, 1);
  c.attachRadial('solar_tile', body.id, body.pos.y - 0.4, UP + 0.35, 1);
  c.attachRadial('battery_brick', body.id, body.pos.y, UP, 1);
  c.attachRadial('antenna', body.id, body.pos.y - 0.6, UP, 1);
  const lamps = c.attachRadial('light_glim', body.id, body.pos.y + 0.75, UP - 0.9, 1).concat(c.attachRadial('light_glim', body.id, body.pos.y + 0.75, UP + 0.9, 1));
  c.attachRadial('sci_seis', body.id, body.pos.y - 0.1, 0, 1);
  c.attachRadial('sci_grav', body.id, body.pos.y - 0.1, Math.PI, 1);
  c.autoStage();
  for (const l of lamps) c.setAction('lights', l.id, 'toggleLight', false);
  return c;
}

function trundleLander() {
  // The Trundle rover riding nose-up on a small descent stage, on top of a launcher that can reach Pell or Ost.
  // Land on the legs, then fire the top separator: the rover tips over onto its wheels (pitch down helps it along).
  if (!has('rover_trundle', 'wheel_scamper', 'solar_tile', 'antenna', 'leg_sprig', 'eng_wren', 'tank_s200', 'adapter_ms', 'dec_s')) return null;
  const c = new Craft('Trundle Lander');
  const [body] = c.setRoot('rover_trundle');
  c.attachStack('nose_m', body.id, 'top');
  for (const dy of [0.55, -0.55]) {
    c.attachRadial('wheel_scamper', body.id, body.pos.y + dy, DOWN - 1.0, 1);
    c.attachRadial('wheel_scamper', body.id, body.pos.y + dy, DOWN + 1.0, 1);
  }
  c.attachRadial('solar_tile', body.id, body.pos.y + 0.3, UP - 0.35, 1);
  c.attachRadial('solar_tile', body.id, body.pos.y + 0.3, UP + 0.35, 1);
  c.attachRadial('antenna', body.id, body.pos.y - 0.5, UP, 1);
  c.attachRadial('sci_seis', body.id, body.pos.y, 0, 1);
  const s = stackDown(c, body, [
    'dec_m', 'tank_m200', 'eng_sparrow',                           // descent stage
    'dec_m', 'tank_m800', 'eng_sparrow',                           // transfer stage
    'dec_m', 'adapter_lm', 'tank_l3200', 'tank_l1600', 'eng_condor', // lifter
  ]);
  const descTank = s[1], lifterTank = s[9];
  c.attachRadial('legs', descTank.id, bottomY(c, descTank), Math.PI / 4, 4);
  c.attachRadial('fin_ctrl', lifterTank.id, bottomY(c, lifterTank) + 0.5, Math.PI / 4, 4);
  c.autoStage();
  return c;
}

function colossus() {
  // The heavy lifter: an XL core under a Roc, two Anvil boosters, and an upper stage that carries a 20-tonne
  // tanker module with a Latch Ring L to a low orbit.
  if (!has('probe_beacon', 'dock_l', 'tank_l3200', 'tank_l1600', 'eng_osprey', 'dec_l', 'adapter_xll', 'tank_xl7200', 'tank_xl3600', 'eng_roc', 'srb_anvil', 'dec_radial_l', 'nose_l', 'battery_l', 'fin_broad')) return null;
  const c = new Craft('Colossus');
  const [core] = c.setRoot('probe_beacon');
  c.attachStack('dock_l', core.id, 'top');
  const s = stackDown(c, core, [
    'battery_l', 'tank_l3200',                                     // payload: a tanker module
    'dec_l', 'tank_l1600', 'eng_osprey',                           // upper stage
    'dec_l', 'adapter_xll', 'tank_xl7200', 'tank_xl7200', 'eng_roc', // core
  ]);
  const payload = s[1], low = s[8], roc = s[9];
  if (has('solar_wing')) c.attachRadial('solar_wing', payload.id, payload.pos.y + 2, 0, 2);
  if (has('antenna')) c.attachRadial('antenna', payload.id, payload.pos.y + 3, Math.PI / 2, 1);
  const clamps = c.attachRadial('dec_radial_l', low.id, low.pos.y - 0.5, 0, 2);
  const boosters = c.attachOuter('srb_anvil', clamps[0].id);
  c.attachStack('nose_l', boosters[0].id, 'top');
  c.attachRadial('fin_broad', low.id, bottomY(c, low) + 0.9, Math.PI / 2, 2);
  c.autoStage();
  c.moveToStage(roc.id, 0);
  for (const b of boosters) c.moveToStage(b.id, 0);
  for (const k of clamps) c.moveToStage(k.id, 1);
  c.removeEmptyStages();
  return c;
}

function farwind() {
  // Three stages for another planet's moons: a Roc core with Anvil boosters to orbit, a Furnace atomic stage for
  // the crossing and the capture, and a crewed lander (three seats, wide legs, a ladder) for the last step.
  if (!has('tank_xl3600', 'pod_hearth', 'tank_l1600', 'tank_l800', 'eng_osprey', 'leg_stilt', 'dec_l', 'tank_l3200', 'eng_furnace', 'adapter_xll', 'tank_xl7200', 'eng_roc', 'srb_anvil', 'dec_radial_l', 'nose_l', 'solar_wing', 'battery_l', 'antenna_saucer', 'ladder_rung', 'fin_broad')) return null;
  const c = new Craft('Farwind');
  const [pod] = c.setRoot('pod_hearth');
  if (has('dock_m')) c.attachStack('dock_m', pod.id, 'top');
  const s = stackDown(c, pod, [
    'battery_l', 'tank_l1600', 'tank_l800', 'eng_osprey',          // lander
    'dec_l', 'tank_l3200', 'eng_furnace',                          // atomic transfer stage
    'dec_l', 'adapter_xll', 'tank_xl7200', 'tank_xl7200', 'tank_xl3600', 'eng_roc', // core
  ]);
  const t1 = s[1], t2 = s[2], low = s[11], roc = s[12];
  c.attachRadial('leg_stilt', t2.id, bottomY(c, t2) + 0.3, Math.PI / 4, 4);
  c.attachRadial('solar_wing', t1.id, t1.pos.y + 1.2, Math.PI / 2, 2);
  c.attachRadial('antenna_saucer', t1.id, t1.pos.y + 1.2, Math.PI, 1);
  // the hatch side is +X (angle 0): rungs from the pod down to below the tank, within a hop of the ground
  for (let y = bottomY(c, t2) - 0.5; y < t1.pos.y + 1.9; y += 1.2) c.attachRadial('ladder_rung', y < bottomY(c, t1) ? t2.id : t1.id, y, 0, 1);
  if (has('light_glare')) c.attachRadial('light_glare', t2.id, t2.pos.y + 0.5, Math.PI, 1);
  if (has('sci_grav')) c.attachRadial('sci_grav', t1.id, t1.pos.y - 1, Math.PI, 1);
  if (has('sci_seis')) c.attachRadial('sci_seis', t1.id, t1.pos.y - 1.4, Math.PI, 1);
  const clamps = c.attachRadial('dec_radial_l', low.id, low.pos.y - 0.5, 0, 2);
  const boosters = c.attachOuter('srb_anvil', clamps[0].id);
  c.attachStack('nose_l', boosters[0].id, 'top');
  c.attachRadial('fin_broad', low.id, bottomY(c, low) + 0.9, Math.PI / 2, 2);
  c.autoStage();
  c.moveToStage(roc.id, 0);
  for (const b of boosters) c.moveToStage(b.id, 0);
  for (const k of clamps) c.moveToStage(k.id, 1);
  c.removeEmptyStages();
  return c;
}

function whisperProbe() {
  // An ion probe: a little xenon, a patient engine and wide solar wings on a two-stage launcher. Unfold the wings
  // in orbit; the Whisper drive only runs while they keep the cells charged.
  if (!has('probe_facet', 'xen_m', 'eng_whisper', 'solar_wing', 'battery', 'antenna_saucer', 'adapter_lm', 'tank_l3200', 'eng_condor', 'fin_ctrl')) return null;
  const c = new Craft('Whisper Probe');
  const [core] = c.setRoot('probe_facet');
  if (has('nose_s')) c.attachStack('nose_s', core.id, 'top');
  const s = stackDown(c, core, ['adapter_ms_flat', 'battery', 'xen_m', 'eng_whisper',
    'dec_m', 'tank_m800', 'eng_sparrow', 'dec_m', 'adapter_lm', 'tank_l3200', 'eng_condor'].filter(t => has(t)));
  const xen = s.find(p => p.type === 'xen_m'), bat = s.find(p => p.type === 'battery'), low = s[s.length - 2];
  c.attachRadial('solar_wing', xen.id, xen.pos.y, 0, 2);
  c.attachRadial('antenna_saucer', bat.id, bat.pos.y, Math.PI / 2, 1);
  if (has('sci_compass')) c.attachRadial('sci_compass', bat.id, bat.pos.y, -Math.PI / 2, 1);
  c.attachRadial('fin_ctrl', low.id, bottomY(c, low) + 0.5, Math.PI / 4, 4);
  c.autoStage();
  return c;
}

function hearthstone() {
  // A station core that flies itself up: a two-seat lab, Latch Rings fore and aft, power, a dish and thrusters.
  // Its upper stage stays attached as a fuel store.
  if (!has('probe_beacon', 'sci_lab', 'dock_l', 'gyro_l', 'mono_l', 'rcs_gust', 'solar_wing', 'battery_l', 'antenna_saucer', 'tank_l1600', 'eng_osprey', 'dec_l', 'tank_l3200', 'eng_buzzard', 'srb_mallet', 'dec_radial')) return null;
  const c = new Craft('Hearthstone Core');
  const [core] = c.setRoot('probe_beacon');
  c.attachStack('dock_l', core.id, 'top');
  const s = stackDown(c, core, ['battery_l', 'sci_lab', 'gyro_l', 'mono_l', 'tank_l1600', 'eng_osprey',
    'dec_l', 'tank_l3200', 'tank_l3200', 'eng_buzzard']);
  const lab = s[1], mono = s[3], low = s[8], buz = s[9];
  c.attachRadial('solar_wing', lab.id, lab.pos.y + 0.8, 0, 2);
  c.attachRadial('antenna_saucer', lab.id, lab.pos.y + 0.8, Math.PI / 2, 1);
  c.attachRadial('rcs_gust', mono.id, mono.pos.y, Math.PI / 4, 4);
  if (has('light_glare')) c.attachRadial('light_glare', lab.id, lab.pos.y - 1, Math.PI / 2, 1);
  const clamps = c.attachRadial('dec_radial', low.id, low.pos.y - 1.5, 0, 4);
  const boosters = c.attachOuter('srb_mallet', clamps[0].id);
  c.attachStack('nose_m', boosters[0].id, 'top');
  c.autoStage();
  c.moveToStage(buz.id, 0);
  for (const b of boosters) c.moveToStage(b.id, 0);
  for (const k of clamps) c.moveToStage(k.id, 1);
  c.removeEmptyStages();
  return c;
}

function moonstep() {
  // A two-seat lander for small far moons: side-mounted Hornet engines keep it squat, a ladder reaches the ground,
  // and a Latch Ring on top lets a mothership carry it. No launcher: dock it to a transfer stage, or fly it from orbit.
  if (!has('pod_burrow', 'dock_m', 'tank_m400', 'eng_hornet', 'legs', 'ladder_rung', 'solar_tile', 'battery', 'light_glim', 'antenna', 'tank_mono', 'rcs')) return null;
  const c = new Craft('Moonstep');
  const [pod] = c.setRoot('pod_burrow');
  c.attachStack('dock_m', pod.id, 'top');
  const [bat, mono, tank] = stackDown(c, pod, ['battery', 'tank_mono', 'tank_m400']);
  void bat;
  const engines = c.attachRadial('eng_hornet', tank.id, bottomY(c, tank) + 0.55, Math.PI / 2, 2);
  c.attachRadial('legs', tank.id, bottomY(c, tank) + 0.1, Math.PI / 4, 4);
  // the hatch side is +X (angle 0): rungs from the ground to the pod
  for (let y = bottomY(c, tank) + 0.5; y < tank.pos.y + 1.9; y += 1.2) c.attachRadial('ladder_rung', tank.id, y, 0, 1);
  c.attachRadial('rcs', mono.id, mono.pos.y, Math.PI / 4, 4);
  c.attachRadial('solar_tile', pod.id, pod.pos.y, Math.PI / 2, 2);
  c.attachRadial('antenna', pod.id, pod.pos.y, Math.PI, 1);
  const lamps = c.attachRadial('light_glim', tank.id, tank.pos.y + 1.5, Math.PI, 1);
  if (has('sci_seis')) c.attachRadial('sci_seis', tank.id, tank.pos.y + 0.6, Math.PI, 1);
  if (has('sci_grav')) c.attachRadial('sci_grav', tank.id, tank.pos.y + 0.2, Math.PI, 1);
  c.autoStage();
  for (const e of engines) c.setAction('abort', e.id, 'shutdownEngine', false);
  for (const l of lamps) c.setAction('lights', l.id, 'toggleLight', false);
  return c;
}

/**
 * Ready-made designs. The first seven (Hopper I, Skylark II, Pell Runner, Ember Twin, Mote Sounder, Latch Target,
 * Latch Chaser) use the original catalog; the rest need the second-pass parts and are left out if any is missing.
 * `site` on a design ('runway') says where it is meant to start.
 */
export function stockCrafts() {
  const list = [hopper(), skylark(), pellRunner(), emberTwin(), moteSounder(), latchTarget(), latchChaser()];
  for (const make of SECOND_PASS) {
    let c = null;
    try { c = make(); } catch { c = null; }       // a catalog change must never take the classic designs down with it
    if (c) list.push(c);
  }
  for (const c of list) {
    if (STOCK_NOTES[c.name]) c.desc = STOCK_NOTES[c.name];
    if (stockSite(c) === 'runway') c.site = 'runway';
  }
  return list;
}
const STOCK_NOTES = {
  'Hopper I': 'A capsule on a solid booster. Straight up, straight down, parachute at the top.',
  'Skylark II': 'Two-stage crewed rocket for a first orbit of Verda. Start the turn east at 1 km.',
  'Pell Runner': 'Three stages: lifter, transfer stage and a lander with legs. Built for a Pell landing and return.',
  'Ember Twin': 'A Skylark-class core with two strap-on solid boosters. Shows radial clamps and hand-set staging.',
  'Mote Sounder': 'A tiny sounding rocket with a thermometer and a pressure gauge. Comes home under its parachute.',
  'Latch Target': 'An uncrewed station module that flies itself up and waits in orbit with a Latch Ring on its nose.',
  'Latch Chaser': 'A crewed ship with thrusters and a Latch Ring, made to meet and dock with the Latch Target.',
  'Kite Trainer': 'A small single-seat jet. Rotate at about 65 m/s; G raises the gear.',
  'Skimmer': 'A rocket plane: runway take-off, a zoom climb to the edge of space and a long glide home. B opens the air brakes.',
  'Trundle Scout': 'A six-wheeled rover. W/S drive, A/D steer, B brakes, U lights.',
  'Trundle Lander': 'The Trundle rover on a descent stage and launcher. Land on the legs, then release the rover.',
  'Colossus': 'Heavy lifter: an extra-large core with two Anvil boosters carries a 20-tonne tanker module to orbit.',
  'Farwind': 'Three-stage interplanetary ship with an atomic transfer stage and a three-seat lander.',
  'Whisper Probe': 'An ion probe on a two-stage launcher. Unfold the solar wings before lighting the Whisper drive.',
  'Hearthstone Core': 'A station core with a two-seat lab, Latch Rings fore and aft and its own power.',
  'Moonstep': 'A squat two-seat lander for small moons. No launcher: carry it on a Latch Ring.',
};
const SECOND_PASS = [kiteTrainer, skimmer, trundleScout, trundleLander, colossus, farwind, whisperProbe, hearthstone, moonstep];
/** Where a stock design is meant to start: 'runway' for aircraft and rovers, else 'pad'. */
export function stockSite(craft) {
  const defs = craft.parts.map(p => partDef(p.type));
  return defs.filter(d => d.wheel).length >= 3 && !defs.some(d => d.legs) ? 'runway' : 'pad';
}
