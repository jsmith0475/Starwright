// Starwright structural load cases for the assembly building: what will each joint of a design have to carry?
// PURE SIMULATION - runs under Node. See docs/STRUCTURE.md.
//
// There is no second model here. The design is turned into a real Vessel, put in the conditions of each case
// (on the engines at lift-off, steering hard, turning hard at maximum dynamic pressure, at burn-out,
// then the same again after every staging) and the REAL flight model takes one tiny step. The joint loads are
// whatever js/core/structure.js makes of the forces that step applied.
import { Vector3, Quaternion } from '../lib/three.module.min.js';
import { Vessel, TUNING } from './vessel.js';
import { STRUCT } from './structure.js';
import { SYSTEM } from './bodies.js';
import { G0, PARTS } from './parts.js';

/** Reference conditions of the cases. */
export const LOADCASE = {
  Q_REF: 30000,            // Pa: dynamic pressure of the max-Q case (stock rockets peak between 20 and 65 kPa)
  Q_SPEED: 350,            // m/s: airspeed of the max-Q case
  Q_AOA: 15 * Math.PI / 180,  // rad: angle to the airflow in the max-Q case (a hard turn)
  BURNOUT_LEFT: 0.02,      // share of the propellant still aboard in the burn-out case
};

const TAU = Math.PI * 2;
const _d = new Vector3(), _up = new Vector3(1, 0, 0);

function place(v, body, alt, airspeed, tilt, axis) {
  const R = body.radius + alt, wy = TAU / body.rotPeriod;
  v.body = body; v.landed = false; v.splashed = false; v.surface = null; v.onRails = false; v.launched = true;
  v.pos.set(R, 0, 0);
  v.vel.set(airspeed, 0, -wy * R);            // straight up through air that turns with the body
  // nose up, leaned by `tilt` about a body axis (0: about local x, 1: about local z)
  _d.set(0, 1, 0);
  v.q.setFromUnitVectors(_d, _up);
  if (tilt) v.q.multiply(new Quaternion().setFromAxisAngle(axis ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0), tilt));
  v.w.set(0, 0, 0);
  v._gndSkip = 0; v._nearGround = false; v.grounded = false;
}

function probe(v, ctrl) {
  const c = v.ctrl;
  c.throttle = 1; c.sas = false; c.rcs = false; c.pitch = ctrl.pitch || 0; c.yaw = ctrl.yaw || 0; c.roll = 0; c.tx = c.ty = c.tz = 0;
  const st = v.structure;
  if (!st) return false;
  st.valid = false;
  const fail = TUNING.STRUCT_FAIL;
  TUNING.STRUCT_FAIL = false;
  try { v._stepFlight(1e-4, 0, []); } finally { TUNING.STRUCT_FAIL = fail; }
  if (v._massDirty) v._updateMass(false);
  return st.valid;
}

/** Burn the ignited engines until the first of them runs dry (less LOADCASE.BURNOUT_LEFT). → seconds burnt. */
function burnDown(v) {
  const draw = new Map();      // tank part → kg/s drawn from it
  for (const e of v.engines) {
    const p = e.part, en = p.def.engine;
    if (!p.ignited || p.flameout) continue;
    const mdot = en.thrust * 1000 / (en.ispVac * G0);
    if (en.type === 'solid') { if (p.res.solid > 0) draw.set(p, { k: 'solid', rate: mdot }); continue; }
    const live = e.tanks.filter(t => t.res[e.prop] > 0);
    for (const t of live) { const d = draw.get(t) || { k: e.prop, rate: 0 }; d.rate += mdot / live.length; draw.set(t, d); }
  }
  let T = Infinity;
  for (const [t, d] of draw) T = Math.min(T, t.res[d.k] / d.rate);
  if (!Number.isFinite(T) || !(T > 0)) return 0;
  T *= 1 - LOADCASE.BURNOUT_LEFT;
  for (const [t, d] of draw) t.res[d.k] = Math.max(0, t.res[d.k] - d.rate * T);
  v._updateMass(false);
  return T;
}

/**
 * Structural analysis of a design.
 * → { joints: [{ a, b (craft part ids), kind, pos: {x, y, z} (craft coords), r, util, mode, case, cases: { name: util },
 *                axial, shear, bending (N, N, N·m in the worst case) }],
 *     worst (the joint with the highest utilisation, or null), cases: [names], warnings: [text] }
 * `util` is the highest utilisation over the cases (1 = at its limit; it breaks above that).
 */
export function analyzeCraft(craft, { body = SYSTEM.home } = {}) {
  const out = { joints: [], worst: null, cases: [], warnings: [] };
  if (!craft || !craft.parts || craft.parts.length < 2) return out;
  const seats = [];
  for (let i = 0; i < 16; i++) seats.push('crew' + i);
  let v;
  try { v = Vessel.fromCraft(craft, { crew: seats }); } catch (e) { return out; }
  if (!v.structure) return out;
  const byKey = new Map();
  const record = name => {
    if (!out.cases.includes(name)) out.cases.push(name);
    for (const j of v.structure.joints) {
      const key = Math.min(j.a.id, j.b.id) + ':' + Math.max(j.a.id, j.b.id);
      let r = byKey.get(key);
      if (!r) { r = { a: j.a.id, b: j.b.id, kind: j.kind, pos: null, r: j.r, util: -1, mode: j.mode, case: name, cases: {}, axial: 0, shear: 0, bending: 0, braced: j.braces > 0 }; byKey.set(key, r); out.joints.push(r); }
      if (!r.pos) r.pos = { x: j.px, y: j.py, z: j.pz };
      r.cases[name] = j.util;
      if (j.util > r.util) { r.util = j.util; r.mode = j.mode; r.case = name; r.axial = j.axial; r.shear = j.shear; r.bending = j.bending; }
    }
  };
  const atmo = body.atmo;
  const low = (body.maxElevation || 0) + 2000;
  const high = atmo ? atmo.height + 20000 : 50000;
  const thrusting = () => v.engines.some(e => e.part.ignited && !e.part.flameout);
  let phase = 0, launch = true;
  for (let guard = 0; guard < 40 && !v.dead; guard++) {
    // fire stages until something is burning
    let fired = 0;
    while (!thrusting() && v.stageIndex < v.stages.length && fired < 12) { v.activateNextStage([]); fired++; }
    if (!v.structure) break;
    if (!thrusting()) { if (!launch) break; }
    phase++;
    const tag = `stage ${phase}`;
    const alt = launch ? low : high;
    place(v, body, alt, 0, 0, 0);
    if (probe(v, {})) record(`${tag} ignition`);
    for (const ctrl of [{ pitch: 1 }, { yaw: 1 }]) {
      place(v, body, alt, 0, 0, 0);
      if (probe(v, ctrl)) record(`${tag} steering`);
    }
    if (launch && atmo) {
      // the altitude where LOADCASE.Q_SPEED gives LOADCASE.Q_REF
      const rho = 2 * LOADCASE.Q_REF / (LOADCASE.Q_SPEED * LOADCASE.Q_SPEED);
      const qAlt = rho < atmo.rho0 ? Math.max(low, -atmo.scale * Math.log(rho / atmo.rho0)) : low;
      // leaning into the airflow with the controls hard over, either way (the worst moment of a hard turn)
      for (const axis of [0, 1]) for (const s of [1, -1]) for (const c of [1, -1]) {
        place(v, body, qAlt, LOADCASE.Q_SPEED, s * LOADCASE.Q_AOA, axis);
        if (probe(v, axis ? { yaw: c } : { pitch: c })) record(`${tag} max Q`);
      }
    }
    if (thrusting() && burnDown(v) > 0) {
      place(v, body, high, 0, 0, 0);
      if (probe(v, {})) record(`${tag} burn-out`);
      for (const ctrl of [{ pitch: 1 }, { yaw: 1 }]) { place(v, body, high, 0, 0, 0); if (probe(v, ctrl)) record(`${tag} burn-out`); }
    }
    launch = false;
    // next: let the spent engines go
    if (v.stageIndex >= v.stages.length) break;
    const before = v.partList.length, lit = v.engines.filter(e => e.part.ignited).length;
    let n = 0;
    do { v.activateNextStage([]); v.finishHotStage(); n++; } while (v.partList.length === before && v.stageIndex < v.stages.length && n < 12);
    for (const e of v.engines) { const p = e.part; if (p.ignited && p.def.engine.type !== 'solid') p.flameout = false; }
    // nothing left and nothing new lit: the remaining stages are parachutes and the like
    if (v.partList.length === before && v.engines.filter(e => e.part.ignited).length === lit) break;
    if (!v.structure) break;
  }
  for (const r of out.joints) if (r.util < 0) r.util = 0;
  out.joints.sort((p, q) => q.util - p.util);
  out.worst = out.joints[0] || null;
  const name = id => { const p = craft.getPart ? craft.getPart(id) : craft.parts.find(x => x.id === id); return p ? (p.def ? p.def.name : (PARTS[p.type] ? PARTS[p.type].name : p.type)) : '#' + id; };
  for (const r of out.joints) {
    if (r.util >= 1) out.warnings.push(`The joint between ${name(r.a)} and ${name(r.b)} will break (${Math.round(r.util * 100)} % of its strength, ${r.case}, ${r.mode}).`);
    else if (r.util >= STRUCT.WARN) out.warnings.push(`The joint between ${name(r.a)} and ${name(r.b)} is close to its limit (${Math.round(r.util * 100)} %, ${r.case}, ${r.mode}).`);
  }
  return out;
}
