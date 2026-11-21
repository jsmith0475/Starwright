// Starwright assembly building — structural loads, the pure part: turning the result of analyzeCraft()
// (js/core/loadcases.js, docs/STRUCTURE.md) into what the building shows. No DOM and no three.js here, so it
// runs under Node (tests/unit/builder_loads.test.js).
//
//   loadLevel(util)             → 'ok' | 'warn' | 'bad'       teal below 50 %, amber from 50 %, red from 90 %
//   loadColor(util)             → 0xRRGGBB of that level (the overlay rings use the same scale as the panel)
//   loadPercent(util)           → '42 %' ('--' when there is no number)
//   loadWords(joint)            → 'bending' | 'pushed together' | 'pulled apart' | 'shear'
//   caseWords(name, phases)     → 'at max Q', 'at lift-off', 'at burn-out of the second burn', …
//   jointWhere(craft, joint)    → 'Stack Separator S under Hearth Command Module'
//   jointNormal(craft, joint, out) → unit normal of the joint plane in craft coordinates
//   loadReport(craft, result, { top = 5 }) → what the panel, the pre-launch check and the 3D overlay read
import { partDef } from '../../core/parts.js';
import { STRUCT } from '../../core/structure.js';

export const LOAD = {
  AMBER: 0.5,                 // from here the bar and the ring are amber
  RED: 0.9,                   // ... and from here red
  BREAK: 1,                   // at or above its strength: the joint will break in flight
  NEAR: Number.isFinite(STRUCT && STRUCT.WARN) ? STRUCT.WARN : 0.75,    // "close to its limit" (the flight warning threshold)
  COLORS: { ok: 0x39d0c0, warn: 0xffb347, bad: 0xff5a5a },
};

export function loadLevel(util) { return !(util >= LOAD.AMBER) ? 'ok' : util >= LOAD.RED ? 'bad' : 'warn'; }
export function loadColor(util) { return LOAD.COLORS[loadLevel(util)]; }
export function loadPercent(util) { return Number.isFinite(util) ? Math.round(Math.max(0, util) * 100) + ' %' : '--'; }
/** Bar fill, 0…1: full at the joint's strength. */
export function loadFill(util) { return Number.isFinite(util) ? Math.min(1, Math.max(0, util)) : 0; }

/**
 * What kind of load decides this joint, in plain words. `mode` says which limit of the bolted ring is closest
 * (tension, compression, shear); the numbers say why: the ring's peak line load is axial / (2 pi r) plus
 * bending / (pi r²) (docs/STRUCTURE.md), so whichever of the two is larger names the load.
 */
export function loadWords(j) {
  if (!j) return '';
  if (j.mode === 'shear') return 'shear';
  const r = j.r > 0 ? j.r : 0.3, pull = j.mode === 'tension';
  const axial = Math.max(0, pull ? j.axial || 0 : -(j.axial || 0)) / (2 * Math.PI * r);
  const bend = Math.abs(j.bending || 0) / (Math.PI * r * r);
  if (bend > axial) return 'bending';
  return pull ? 'pulled apart' : 'pushed together';
}

const nth = k => k + (k % 100 >= 11 && k % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][k % 10] || 'th');
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const CASE_WORDS = { 'ignition': 'at ignition', 'steering': 'under full steering', 'max Q': 'at max Q', 'burn-out': 'at burn-out' };
/**
 * A case name of analyzeCraft ('stage 2 burn-out') in plain words. Its "stage 1" is the first burn of the flight,
 * which the staging panel of this building numbers the other way round (stage 0 fires last), so burns are counted
 * in words instead, and only when the design has more than one (`phases`).
 */
export function caseWords(name, phases = 1) {
  const m = /^stage (\d+) (.+)$/.exec(String(name || ''));
  if (!m) return name ? 'in the case “' + name + '”' : '';
  const k = Number(m[1]), what = CASE_WORDS[m[2]] || 'at ' + m[2];
  if (m[2] === 'max Q') return what;                       // only the climb off the pad meets it
  if (k === 1 && m[2] === 'ignition') return 'at lift-off';
  if (!(phases > 1)) return what;
  return `${what} of the ${ORDINAL[k - 1] || k + 'th'} burn`;
}
/** How many burns the cases of a result cover. */
export function casePhases(cases) {
  let n = 0;
  for (const c of cases || []) { const m = /^stage (\d+) /.exec(c); if (m) n = Math.max(n, Number(m[1])); }
  return n;
}

const partOf = (craft, id) => (craft && typeof craft.getPart === 'function' ? craft.getPart(id) : craft && craft.parts ? craft.parts.find(p => p.id === id) : null) || null;
function nameOf(craft, id) {
  const p = partOf(craft, id);
  if (!p) return 'part #' + id;
  try { return partDef(p.type).name; } catch { return p.type; }
}
/** For a side mount: [mounted part, host part] (the mounted one is the craft child); null when neither is. */
function mountPair(craft, j) {
  const a = partOf(craft, j.a), b = partOf(craft, j.b);
  if (!a || !b) return null;
  if (b.parent === a.id) return [b, a];
  if (a.parent === b.id) return [a, b];
  return null;
}

/** Which joint this is, by the names of the two parts: 'Stack Separator S under Hearth Command Module'. */
export function jointWhere(craft, j) {
  const na = nameOf(craft, j.a), nb = nameOf(craft, j.b);
  const a = partOf(craft, j.a), b = partOf(craft, j.b);
  if (j.kind === 'radial' || j.kind === 'outer') {
    const pair = mountPair(craft, j);
    return pair ? `${nameOf(craft, pair[0].id)} on ${nameOf(craft, pair[1].id)}` : `${nb} on ${na}`;
  }
  if (j.kind === 'dock') return `${nb} docked to ${na}`;
  if (na === nb) return `${na} to ${nb}`;
  // a stack joint: the lower part hangs under the upper one (+Y is the nose)
  const aLow = a && b ? a.pos.y < b.pos.y : false;
  return aLow ? `${na} under ${nb}` : `${nb} under ${na}`;
}

/**
 * Unit normal of the joint plane, craft coordinates → out {x, y, z}. Stack and docking joints lie across the
 * stack axis; a side mount faces outward from its host.
 */
export function jointNormal(craft, j, out = { x: 0, y: 1, z: 0 }) {
  out.x = 0; out.y = 1; out.z = 0;
  if (j.kind !== 'radial' && j.kind !== 'outer') return out;
  const pair = mountPair(craft, j), pos = j.pos || { x: 0, y: 0, z: 0 };
  let dx = 0, dy = 0, dz = 0;
  if (pair) {
    const [mounted, host] = pair;
    let stackHost = false;
    try { stackHost = !!partDef(host.type).attach.stack; } catch { stackHost = false; }
    if (stackHost) { dx = pos.x - host.pos.x; dz = pos.z - host.pos.z; }                 // straight out from the host's axis
    if (Math.hypot(dx, dz) < 1e-4) { dx = mounted.pos.x - pos.x; dy = mounted.pos.y - pos.y; dz = mounted.pos.z - pos.z; }   // from the mount point into the part
    if (Math.hypot(dx, dy, dz) < 1e-4) { dx = Math.cos(mounted.rot || 0); dy = 0; dz = -Math.sin(mounted.rot || 0); }
  }
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-6) { out.x = 1; out.y = 0; out.z = 0; return out; }
  out.x = dx / l; out.y = dy / l; out.z = dz / l;
  return out;
}

function verdict(util) { return util >= LOAD.BREAK ? 'will break' : util >= LOAD.NEAR ? 'close to its limit' : ''; }

/**
 * Everything the building shows about the loads of a design.
 * → { empty, count (joints), phases, worst (a row or null), rows: [the `top` most loaded, worst first],
 *     warnings: [text, worst first], breaking (how many of those are joints that will break), marks: [{ x, y, z, nx, ny, nz, r, util }] one per joint for the 3D overlay }
 * row: { util, percent, fill, level, where, words, when, verdict, braced, text, n (identical joints folded into
 *        this row: the copies of a symmetry group), ids: [part ids], marks: [indices into marks], pos: {x, y, z} }
 * Symmetric copies carry the same load to within rounding, so they share one row: the list of five then names
 * five different places instead of the same booster clamp four times.
 */
export function loadReport(craft, result, { top = 5, maxWarnings = 3, nose = 'top' } = {}) {
  const rep = { empty: true, count: 0, phases: 0, worst: null, rows: [], warnings: [], breaking: 0, marks: [] };
  const joints = result && Array.isArray(result.joints) ? result.joints.filter(j => j && j.pos && Number.isFinite(j.util)) : [];
  if (!joints.length) return rep;
  rep.empty = false; rep.count = joints.length;
  rep.phases = casePhases(result.cases);
  const sorted = joints.slice().sort((p, q) => q.util - p.util);
  const groups = new Map(), all = [];
  const n = { x: 0, y: 1, z: 0 };
  sorted.forEach((j, i) => {
    jointNormal(craft, j, n);
    rep.marks.push({ x: j.pos.x, y: j.pos.y, z: j.pos.z, nx: n.x, ny: n.y, nz: n.z, r: j.r > 0 ? j.r : 0.3, util: j.util });
    const where = jointWhere(craft, j);
    const key = [where, j.kind, j.case, j.mode, Math.round(j.util * 100), j.braced ? 1 : 0].join('|');
    let row = groups.get(key);
    if (!row) {
      const words = loadWords(j), when = caseWords(j.case, rep.phases), v = verdict(j.util);
      row = {
        util: j.util, percent: loadPercent(j.util), fill: loadFill(j.util), level: loadLevel(j.util),
        where, words, when, verdict: v, braced: !!j.braced, kind: j.kind, n: 0, ids: [], marks: [], pos: { x: j.pos.x, y: j.pos.y, z: j.pos.z }, text: '',
      };
      groups.set(key, row); all.push(row);
    }
    row.n++; row.marks.push(i);
    for (const id of [j.a, j.b]) if (!row.ids.includes(id)) row.ids.push(id);
  });
  // stack joints that read the same (a run of identical tanks) are told apart by counting from the nose
  const same = new Map();
  for (const row of all) { if (row.kind !== 'stack') continue; if (!same.has(row.where)) same.set(row.where, []); same.get(row.where).push(row); }
  for (const list of same.values()) {
    if (list.length < 2) continue;
    list.slice().sort((p, q) => q.pos.y - p.pos.y).forEach((row, i) => { row.where += `, ${nth(i + 1)} from the ${nose}`; });
  }
  for (const row of all) {
    row.text = `${row.where}${row.n > 1 ? ' ×' + row.n : ''}: ${row.words} ${row.when}, ${row.percent}` + (row.braced ? ', braced' : '') + (row.verdict ? ' – ' + row.verdict : '');
  }
  rep.rows = all.slice(0, Math.max(1, top));
  rep.worst = all[0];
  // the pre-launch check: one line per place at or near its limit
  const hot = all.filter(r => r.util >= LOAD.NEAR);
  for (const r of hot.slice(0, maxWarnings)) {
    const what = `${r.where}${r.n > 1 ? ' (×' + r.n + ')' : ''}`;
    rep.warnings.push(r.util >= LOAD.BREAK
      ? `${what} will break in flight: ${r.words} ${r.when}, ${r.percent} of its strength.`
      : `${what} is close to its limit: ${r.words} ${r.when}, ${r.percent} of its strength.`);
    if (r.util >= LOAD.BREAK) rep.breaking++;
  }
  if (hot.length > maxWarnings) { const k = hot.length - maxWarnings; rep.warnings.push(`${k} more joint${k > 1 ? 's are' : ' is'} at or near the limit (see Structure).`); }
  return rep;
}

/** A short text of everything that decides whether the loads must be worked out again (parts, where they sit, staging). */
export function loadSignature(craft) {
  if (!craft || !craft.parts) return '';
  let s = '';
  for (const p of craft.parts) s += `${p.id}:${p.type}:${p.parent}:${p.node}:${p.pos.x.toFixed(3)},${p.pos.y.toFixed(3)},${p.pos.z.toFixed(3)}:${(p.rot || 0).toFixed(4)}:${p.flip ? 1 : 0}:${(p.pitch || 0).toFixed(3)}:${(p.roll || 0).toFixed(3)};`;
  s += '|';
  for (const st of craft.stages || []) s += st.join(',') + '/';
  return s;
}
