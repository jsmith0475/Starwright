// Starwright — structural loads in plain words and colours (shared by the flight HUD, the flight scene's stress
// overlay and the failure messages). PURE: no DOM, no three.js; runs under Node (tests/unit/stress.test.js).
//
//   stressLevel(util)      → 'ok' | 'warn' | 'bad'              teal below 50 %, amber from 50 %, red from 90 %
//   stressColor(util)      → 0xRRGGBB of that level
//   stressPercent(util)    → whole percent, never negative, capped at 999
//   stressCause(joint)     → 'bending' | 'pull' | 'push' | 'shear' | 'twist'   what loads the joint most, from its numbers
//   jointLabel(joint)      → "Stack Separator M / Taper Adapter L-M"
//   describeJoint(joint, util = joint.util) → "Stack Separator M / Taper Adapter L-M: bending, 82 %"
//   breakMessage(event, cause?) → "The stack broke between X and Y: bent too far"
//
// `joint` is a joint of vessel.structure (docs/STRUCTURE.md): { a, b, kind, r, axial, shear, bending, torsion, util,
// mode, capT, capC, capS, relB, relF }. Only the numbers are read; missing ones fall back to `mode`.

export const STRESS_AMBER = 0.5, STRESS_RED = 0.9;
export const STRESS_COLORS = { ok: 0x39d0c0, warn: 0xffb347, bad: 0xff6b6b, idle: 0x5d6b7a };

export function stressLevel(util) { return util >= STRESS_RED ? 'bad' : util >= STRESS_AMBER ? 'warn' : 'ok'; }
export function stressColor(util) { return STRESS_COLORS[stressLevel(util)]; }
export function stressPercent(util) { return Number.isFinite(util) ? Math.min(999, Math.max(0, Math.round(util * 100))) : 0; }

const MODE_CAUSE = { tension: 'pull', compression: 'push', shear: 'shear' };

/**
 * What loads this joint most. The joint is a thin ring: bending and the axial force both end up as a line load on
 * its rim, shear and twist as a shear flow (docs/STRUCTURE.md, "Joint strength"). The governing check is found the
 * way the core finds it, and then the larger contribution to that check names the cause.
 */
export function stressCause(j) {
  if (!j) return 'bending';
  const r = j.r, capT = j.capT, capC = j.capC, capS = j.capS;
  if (!(r > 0) || !(capT > 0) || !(capC > 0) || !(capS > 0)) return MODE_CAUSE[j.mode] || 'bending';
  const relB = j.relB > 0 ? j.relB : 1, relF = j.relF > 0 ? j.relF : 1;
  const nb = Math.abs(j.bending || 0) * relB / (Math.PI * r * r);            // rim line load from bending
  const na = (j.axial || 0) * relF / (2 * Math.PI * r);                      // ... from the axial force (+ pull)
  const qs = Math.abs(j.shear || 0) * relF / (Math.PI * r);                  // shear flow from the side force
  const qt = Math.abs(j.torsion || 0) * relB / (2 * Math.PI * r * r);        // ... from twist
  const uT = (na + nb) / capT, uC = (nb - na) / capC, uS = (qs + qt) / capS;
  if (uS > uT && uS > uC) return qt > qs ? 'twist' : 'shear';
  if (uC > uT) return nb > -na ? 'bending' : 'push';
  return nb > na ? 'bending' : 'pull';
}

const partName = p => (p && p.def && p.def.name) || (p && p.name) || 'part';

export function jointLabel(j) {
  if (!j) return '';
  return (j.aName || partName(j.a)) + ' / ' + (j.bName || partName(j.b));
}

// (the same words the Assembly Hangar's load panel uses: js/ui/builder/loads.js)
const CAUSE_WORD = { bending: 'bending', pull: 'pulled apart', push: 'pushed together', shear: 'shear', twist: 'twisting' };

/** "Stack Separator M / Taper Adapter L-M: bending, 82 %" (`util`: the figure to print, when the caller shows a held one) */
export function describeJoint(j, util = j ? j.util : 0) {
  if (!j) return '';
  return jointLabel(j) + ': ' + CAUSE_WORD[stressCause(j)] + ', ' + stressPercent(util) + ' %';
}

const BREAK_WORD = { bending: 'bent too far', pull: 'pulled apart', push: 'crushed', shear: 'sheared off', twist: 'twisted off' };

/**
 * The message for a `structure` world event ({ joint: { kind, aName, bName }, mode }). `cause` is what stressCause()
 * said about that joint while it was still whole, when the caller knows it; otherwise the event's mode decides.
 */
export function breakMessage(ev, cause) {
  const j = (ev && ev.joint) || {};
  const a = j.aName || 'one part', b = j.bName || 'the next';
  const why = BREAK_WORD[cause] || BREAK_WORD[MODE_CAUSE[ev && ev.mode]] || 'overloaded';
  if (j.kind === 'radial' || j.kind === 'outer') return 'The ' + b + ' broke away from the ' + a + ': ' + why;
  if (j.kind === 'dock') return 'The docking joint between the ' + a + ' and the ' + b + ' broke: ' + why;
  return 'The stack broke between the ' + a + ' and the ' + b + ': ' + why;
}
