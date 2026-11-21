// The flight screen's plain-words describer and colour scale for structural loads (js/ui/stress.js), plus a
// live check that the words agree with what the core says about a real overloaded craft.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stressLevel, stressColor, stressPercent, stressCause, jointLabel, describeJoint, breakMessage, STRESS_COLORS } from '../../js/ui/stress.js';
import { STRUCT, jointUtilisation } from '../../js/core/structure.js';
import { World } from '../../js/core/world.js';
import { stockCrafts } from '../../js/core/craft.js';

const ring = (over = {}) => ({ r: 0.625, capT: STRUCT.LINE_T, capC: STRUCT.LINE_C, capS: STRUCT.LINE_S, relB: 1, relF: 1, axial: 0, shear: 0, bending: 0, torsion: 0, util: 0, mode: 'tension', ...over });

test('colour scale: teal below 50 %, amber from 50 %, red from 90 %', () => {
  assert.equal(stressLevel(0), 'ok');
  assert.equal(stressLevel(0.499), 'ok');
  assert.equal(stressLevel(0.5), 'warn');
  assert.equal(stressLevel(0.899), 'warn');
  assert.equal(stressLevel(0.9), 'bad');
  assert.equal(stressLevel(3), 'bad');
  assert.equal(stressColor(0.2), 0x39d0c0);
  assert.equal(stressColor(0.7), 0xffb347);
  assert.equal(stressColor(1.2), STRESS_COLORS.bad);
});

test('percent is a whole, bounded number', () => {
  assert.equal(stressPercent(0.824), 82);
  assert.equal(stressPercent(-0.1), 0);
  assert.equal(stressPercent(NaN), 0);
  assert.equal(stressPercent(50), 999);
});

test('cause comes from the numbers, not from the mode', () => {
  // a big bending moment with a little thrust through the joint: the core calls it "compression" or "tension"
  assert.equal(stressCause(ring({ bending: 4e5, axial: -5e4, mode: 'compression' })), 'bending');
  assert.equal(stressCause(ring({ bending: 4e5, axial: 5e4, mode: 'tension' })), 'bending');
  // a straight pull, a straight push
  assert.equal(stressCause(ring({ axial: 1e6, bending: 1e3, mode: 'tension' })), 'pull');
  assert.equal(stressCause(ring({ axial: -3e6, bending: 1e3, mode: 'compression' })), 'push');
  // side force and twist
  assert.equal(stressCause(ring({ shear: 4e5, axial: -1e4, mode: 'shear' })), 'shear');
  assert.equal(stressCause(ring({ torsion: 3e5, shear: 1e3, mode: 'shear' })), 'twist');
});

test('cause agrees with the governing check of the core', () => {
  const cases = [[-2e5, 0, 0, 0, 3e5, 0], [8e5, 0, 0, 0, 1e4, 0], [-4e6, 1e4, 0, 0, 2e4, 0], [0, 5e5, 0, 0, 1e3, 0], [0, 1e3, 0, 2e5, 0, 0]];
  for (const [fn, fs, , mt, mb] of cases) {
    // n = +Y; F_J · n = −axial, so the axial force on the joint is −Fy
    const u = jointUtilisation([fs, -fn, 0], [0, mt, mb], [0, 1, 0], 0.625, STRUCT.LINE_T, STRUCT.LINE_C, STRUCT.LINE_S);
    const cause = stressCause(ring({ axial: u.axial, shear: u.shear, bending: u.bending, torsion: u.torsion, mode: u.mode, util: u.util }));
    if (u.mode === 'shear') assert.ok(cause === 'shear' || cause === 'twist', `${u.mode} → ${cause}`);
    else assert.ok(cause === 'bending' || cause === (u.mode === 'tension' ? 'pull' : 'push'), `${u.mode} → ${cause}`);
  }
});

test('without strengths the mode decides', () => {
  assert.equal(stressCause({ mode: 'shear' }), 'shear');
  assert.equal(stressCause({ mode: 'compression' }), 'push');
  assert.equal(stressCause(null), 'bending');
});

test('plain words for a joint', () => {
  const j = ring({ a: { def: { name: 'Stack Separator M' } }, b: { def: { name: 'Taper Adapter L-M' } }, bending: 4e5, axial: -5e4, util: 0.824 });
  assert.equal(jointLabel(j), 'Stack Separator M / Taper Adapter L-M');
  assert.equal(describeJoint(j), 'Stack Separator M / Taper Adapter L-M: bending, 82 %');
  assert.equal(describeJoint(j, 1.204), 'Stack Separator M / Taper Adapter L-M: bending, 120 %');      // a held figure
  assert.equal(describeJoint(null), '');
});

test('failure messages', () => {
  const joint = { a: 1, b: 2, kind: 'stack', aName: 'Tank A', bName: 'Tank B' };
  assert.equal(breakMessage({ joint, mode: 'tension' }, 'bending'), 'The stack broke between the Tank A and the Tank B: bent too far');
  assert.equal(breakMessage({ joint, mode: 'tension' }), 'The stack broke between the Tank A and the Tank B: pulled apart');
  assert.equal(breakMessage({ joint, mode: 'compression' }), 'The stack broke between the Tank A and the Tank B: crushed');
  assert.equal(breakMessage({ joint, mode: 'shear' }), 'The stack broke between the Tank A and the Tank B: sheared off');
  assert.match(breakMessage({ joint: { ...joint, kind: 'radial' }, mode: 'shear' }), /^The Tank B broke away from the Tank A: sheared off$/);
  assert.match(breakMessage({}), /overloaded$/);
});

test('live: a hard turn at high dynamic pressure reads as bending, and the stack breaks', () => {
  const craft = stockCrafts().find(c => c.name === 'Trundle Lander');
  assert.ok(craft, 'stock craft "Trundle Lander"');
  const w = new World({ ut: 0 });
  const v = w.launch(craft, { crew: [] });
  const broke = [];
  w.on('structure', e => broke.push(e));
  v.ctrl.throttle = 1; v.ctrl.sas = true;
  w.stage();
  let turnT = -1, sawBending = false, seen = 0;
  for (let i = 0; i < 60 * 60 && !broke.length; i++) {
    if (turnT < 0 && v.dynamicPressure > 30000) { turnT = w.ut; v.ctrl.sas = false; }
    if (turnT >= 0) v.ctrl.pitch = w.ut - turnT < 4 ? 1 : 0;
    w.step(1 / 60);
    const st = v.structure;
    if (st && st.valid && st.worst) { seen++; if (st.maxUtil > 0.75 && stressCause(st.worst) === 'bending') sawBending = true; assert.match(describeJoint(st.worst), /^.+ \/ .+: [a-z ]+, \d+ %$/); }
  }
  assert.ok(seen > 100, 'the structure was solved in flight');
  assert.ok(turnT > 0, 'reached 30 kPa');
  assert.ok(broke.length >= 1, 'a joint broke');
  assert.ok(sawBending, 'the overloaded joint was named as bending');
  assert.match(breakMessage(broke[0]), /^The stack broke between the .+ and the .+: /);
});
