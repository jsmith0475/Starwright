// Wings and fins above the speed of sound (docs/WINGS.md; part D of docs/REENTRY_SPEC.md). The numbers are checked
// against a second statement of the model in tests/verify/checks_wings.mjs (chapter 15); these tests cover how it
// behaves in the game.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../js/core/world.js';
import { Craft } from '../../js/core/craft.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { PARTS } from '../../js/core/parts.js';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { TUNING, wingCoefficients, machSlope, machInduced, gridChoke } from '../../js/core/vessel.js';
import { runAll } from '../verify/run.mjs';

const home = SYSTEM.home, DEG = Math.PI / 180;

test('physics verification, wings and fins: the slope cap, drag due to lift, forces in the game, shadow and steering', async () => {
  const S = await runAll({ fast: true, only: ['15'] });
  assert.ok(S.passed.length > 50, `only ${S.passed.length} checks ran`);
  assert.equal(S.failed.length, 0, '\n' + S.failed.map(r => `${r.group} :: ${r.name}: expected ${r.expected}, got ${r.actual}`).join('\n'));
});

test('D1, D2: below Mach 1 nothing moves; above it the slope falls and the drag due to lift rises, with no jump', () => {
  for (const m of [0, 0.5, 1]) { assert.equal(machSlope(TUNING.WING_SLOPE, m), TUNING.WING_SLOPE); assert.equal(machInduced(m), TUNING.WING_K); }
  let prevS = TUNING.WING_SLOPE, prevK = TUNING.WING_K;
  for (let m = 1; m <= 12; m += 0.01) {
    const s = machSlope(TUNING.WING_SLOPE, m), k = machInduced(m);
    assert.ok(s <= prevS + 1e-12 && prevS - s < 0.12, `slope at Mach ${m.toFixed(2)}: ${prevS} then ${s}`);
    assert.ok(k >= prevK - 1e-12 && k - prevK < 0.01, `K at Mach ${m.toFixed(2)}`);
    prevS = s; prevK = k;
  }
  // a wing at a small angle: less lift for more drag as the Mach number rises
  const a = 4 * DEG, sub = wingCoefficients(a), m3 = wingCoefficients(a, TUNING.WING_SLOPE, TUNING.WING_STALL, [0, 0], 3, 1);
  assert.ok(m3[0] < 0.45 * sub[0] && m3[0] > 0.3 * sub[0], `lift ${sub[0]} then ${m3[0]}`);
  assert.ok((m3[1] - TUNING.WING_CD0) / (m3[0] * m3[0]) > 5 * TUNING.WING_K, 'drag for the lift it keeps');
});

test('D6: the Lattice Vane chokes only between Mach 0.8 and 1.3', () => {
  assert.equal(gridChoke(0.8), 0); assert.equal(gridChoke(1.3), 0); assert.equal(gridChoke(3), 0); assert.equal(gridChoke(1), 1);
  assert.ok(gridChoke(0.9) > 0.4 && gridChoke(1.2) > 0.2 && gridChoke(1.2) < 0.5);
});

/** A finned dart held in Verda's air at a speed and an angle to the flow. */
function dart(speed, alpha, alt = 20000, fin = 'fin') {
  const c = new Craft('dart');
  const tank = c.setRoot('tank_m400')[0];
  c.attachStack('nose_m', tank.id, 'top');
  c.attachRadial(fin, tank.id, tank.pos.y - PARTS.tank_m400.h / 2 + 0.35, 0, 4);      // at the foot, well behind the centre of mass
  c.autoStage();
  const w = new World(), r = home.radius + alt, wy = 2 * Math.PI / home.rotPeriod;
  const v = w.spawn(c, { body: home, pos: new Vector3(r, 0, 0), vel: new Vector3(0, 0, speed - wy * r) });
  v.q.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2 - alpha);
  v.w.set(0, 0, 0); v.ctrl.sas = false; v.ctrl.throttle = 0;
  return { w, v };
}
const angle = v => { const y = new Vector3(0, 1, 0).applyQuaternion(v.q), u = v.airDirection(new Vector3()); return y.angleTo(u); };

test('a finned dart still points into the flow at Mach 0.6 and Mach 3, though the fins grip no harder', () => {
  const pull = {};
  for (const mach of [0.6, 3]) {
    const { w, v } = dart(mach * home.soundSpeed(20000), 6 * DEG);
    const a0 = angle(v);
    w.step(0.01);
    const q = v.dynamicPressure;
    pull[mach] = v.w.length() / 0.01 / q;      // turning acceleration per unit of dynamic pressure
    for (let i = 0; i < 40; i++) w.step(0.01);
    assert.ok(angle(v) < a0, `Mach ${mach}: ${(a0 / DEG).toFixed(2)} deg then ${(angle(v) / DEG).toFixed(2)}`);
  }
  assert.ok(pull[3] <= pull[0.6] * 1.05, JSON.stringify(pull));
});

test('the same dart turns away from the flow at Mach 5: the fins lose their grip, the nose cone does not', () => {
  // (stated in docs/WINGS.md: small fins far aft stop stabilizing a rocket at high Mach)
  const { w, v } = dart(5 * home.soundSpeed(20000), 6 * DEG);
  const a0 = angle(v);
  for (let i = 0; i < 41; i++) w.step(0.01);
  assert.ok(angle(v) > a0, `Mach 5: ${(a0 / DEG).toFixed(2)} deg then ${(angle(v) / DEG).toFixed(2)}`);
});

test('the attitude hold knows the fins have weakened: its authority at Mach 5 is about half that at Mach 2', () => {
  const auth = mach => {
    const { w, v } = dart(mach * home.soundSpeed(20000), 0, 20000, 'fin_grid');
    const { w: w0, v: v0 } = dart(mach * home.soundSpeed(20000), 0, 20000, 'fin');
    v.ctrl.sas = true; v0.ctrl.sas = true; w.step(1e-3); w0.step(1e-3);
    return (v.ctrlAccel.x * v.inertia.x - v0.ctrlAccel.x * v0.inertia.x) / v.dynamicPressure;
  };
  const a2 = auth(2), a5 = auth(5);
  assert.ok(a2 > 0 && a5 / a2 > 0.48 && a5 / a2 < 0.54, `${a2} then ${a5}`);
});
