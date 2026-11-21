// Structural dynamics (js/core/structure.js, js/core/loadcases.js): joint loads, strength, failure, struts, flex.
// The independent verification of the load solver is in tests/verify/checks_structure.mjs; these are the unit tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { World } from '../../js/core/world.js';
import { Craft, stockCrafts } from '../../js/core/craft.js';
import { TUNING } from '../../js/core/vessel.js';
import { STRUCT, solveJointLoads, jointUtilisation } from '../../js/core/structure.js';
import { analyzeCraft } from '../../js/core/loadcases.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a} (tol ${tol})`);
const stock = name => stockCrafts().find(c => c.name === name);

function stack(types, name = 'Test') {
  const c = new Craft(name);
  let [p] = c.setRoot(types[0]);
  const out = [p];
  for (const t of types.slice(1)) {      // '!type': upside down
    const [n] = c.attachStack(t.replace('!', ''), p.id, 'bottom', t[0] === '!' ? { flip: true } : null);
    assert.ok(n, `could not attach ${t}`); out.push(n); p = n;
  }
  c.autoStage();
  return [c, out];
}
/** Tall and thin: a capsule on a long run of the smallest tanks, with a strong engine underneath. */
function noodle() {
  return stack(['pod_acorn', '!adapter_ms', 'tank_s200', 'tank_s200', 'tank_s200', 'tank_s200', 'adapter_ms', 'tank_m800', 'eng_goshawk'], 'Noodle');
}
function fly(world, v, seconds, each) {
  for (let i = 0; i < seconds * 50 && !v.dead; i++) { world.step(0.02); if (each && each(i) === false) break; }
}

test('solveJointLoads: a rod pushed from one end carries thrust × (mass ahead) / (total mass) at every joint', () => {
  const n = 6, T = 1200, bodies = [], joints = [];
  for (let i = 0; i < n; i++) bodies.push({ m: 10, r: [0, i - (n - 1) / 2, 0], I: [1, 0.2, 1], F: [0, i === 0 ? T : 0, 0], T: [0, 0, 0] });
  for (let i = 1; i < n; i++) joints.push({ parent: i - 1, child: i, p: [0, i - 0.5 - (n - 1) / 2, 0], n: [0, 1, 0] });
  const loads = solveJointLoads(bodies, joints, { w: [0, 0, 0], alpha: [0, 0, 0], f: [0, T / (10 * n), 0] });
  for (let i = 1; i < n; i++) {
    near(loads[i - 1].F[1], T * (n - i) / n, 1e-9, `joint ${i}`);
    const u = jointUtilisation(loads[i - 1].F, loads[i - 1].M, [0, 1, 0], 0.5, 1e3, 2e3, 1e3);
    near(u.axial, -T * (n - i) / n, 1e-9); assert.equal(u.mode, 'compression');
    near(u.util, T * (n - i) / n / (2 * Math.PI * 0.5) / 2e3, 1e-12);
  }
});

test('solveJointLoads: a rod spinning end over end is pulled apart by m w² r of what lies beyond the joint', () => {
  const n = 5, w = 2, bodies = [], joints = [];
  for (let i = 0; i < n; i++) bodies.push({ m: 4, r: [0, i - 2, 0], I: [0, 0, 0], F: [0, 0, 0], T: [0, 0, 0] });
  for (let i = 1; i < n; i++) joints.push({ parent: i - 1, child: i, p: [0, i - 2.5, 0], n: [0, 1, 0] });
  const loads = solveJointLoads(bodies, joints, { w: [w, 0, 0], alpha: [0, 0, 0], f: [0, 0, 0] });
  for (let i = 1; i < n; i++) {
    let want = 0;
    for (let k = i; k < n; k++) want += 4 * w * w * (k - 2);
    near(jointUtilisation(loads[i - 1].F, loads[i - 1].M, [0, 1, 0], 0.5, 1, 1, 1).axial, want, 1e-9, `joint ${i}`);
  }
});

test('jointUtilisation: thin-ring line loads', () => {
  const r = 0.625, u = jointUtilisation([300, -1000, 400], [50, 20, 0], [0, 1, 0], r, 1e3, 2e3, 5e2);
  near(u.axial, 1000, 1e-9); near(u.shear, 500, 1e-9); near(u.bending, 50, 1e-9); near(u.torsion, 20, 1e-9);
  near(u.nT, 1000 / (2 * Math.PI * r) + 50 / (Math.PI * r * r), 1e-9);
  near(u.nC, 0, 1e-9);
  near(u.q, 500 / (Math.PI * r) + 20 / (2 * Math.PI * r * r), 1e-9);
  near(u.util, Math.max(u.nT / 1e3, u.q / 5e2), 1e-12);
});

test('a rocket on its engine: every stack joint carries thrust × (mass above it) / (total mass)', () => {
  const w = new World({});
  const v = w.launch(stock('Skylark II'), { crew: ['Ada'] });
  v.ctrl.throttle = 1; v.ctrl.sas = true;
  w.stage();
  fly(w, v, 3);
  const st = v.structure;
  assert.ok(st && st.valid, 'structure is solved in flight');
  let checked = 0;
  for (const j of st.joints) {
    if (j.kind !== 'stack') continue;
    // everything on the far side from the control part
    const far = v._component(j.b.id, new Set([j.a.id]));
    let m = 0;
    for (const id of far) m += v.parts.get(id).mass;
    const below = j.b.pos.y < j.a.pos.y;
    if (!below) continue;                       // the parachute on the nose: no thrust comes through it
    // the far side holds the engine: it pushes the near side with thrust × (near mass) / (total)   (drag is ~0 at 30 m/s)
    const want = v.thrust * (v.mass - m) / v.mass;
    near(-j.axial, want, 0.01 * v.thrust, `${j.a.def.id} > ${j.b.def.id}`);
    checked++;
  }
  assert.ok(checked >= 5);
  assert.ok(st.resF < 1e-6 * v.thrust, `forces close: residual ${st.resF} N`);
});

test('nothing is loaded in free fall, and the loads vanish with the forces', () => {
  const w = new World({});
  const v = w.launch(stock('Skylark II'), { crew: ['Ada'] });
  v.landed = false; v.surface = null; v.launched = true;
  v.pos.set(v.body.radius + 200000, 0, 0); v.vel.set(0, 0, -1900); v.w.set(0, 0, 0);
  w.step(0.02); w.step(0.02);
  assert.ok(v.structure.valid);
  assert.ok(v.structure.maxUtil < 1e-9, `coasting: ${v.structure.maxUtil}`);
});

test('stock designs fly to burn-out at full throttle without breaking, with margin', () => {
  for (const name of ['Skylark II', 'Pell Runner', 'Ember Twin', 'Colossus', 'Farwind', 'Hearthstone Core']) {
    const c = stock(name);
    if (!c) continue;
    const w = new World({});
    const v = w.launch(c, { crew: ['Ada', 'Bo', 'Cy'] });
    let breaks = 0, peak = 0;
    w.on('structure', () => breaks++);
    v.ctrl.throttle = 1; v.ctrl.sas = true;
    w.stage();
    fly(w, v, 70, () => { if (v.structure && v.structure.maxUtil > peak) peak = v.structure.maxUtil; if (v.thrust === 0 && v.launched && v.stageIndex < v.stages.length) w.stage(); });
    assert.equal(breaks, 0, `${name} broke`);
    assert.ok(peak > 0.02 && peak < 0.75, `${name}: peak utilisation ${peak.toFixed(2)}`);
  }
});

test('a long thin stack under a heavy nose snaps when it is turned hard in thick air; with failures off it only reports', () => {
  const run = fail => {
    TUNING.STRUCT_FAIL = fail;
    try {
      const [c] = noodle();
      const w = new World({});
      const v = w.launch(c, { crew: ['Ada', 'Bo', 'Cy'] });
      const ev = [];
      w.on('structure', e => ev.push(e));
      v.ctrl.throttle = 1; v.ctrl.sas = true;
      w.stage();
      const n0 = w.vessels.length;
      let peak = 0;
      fly(w, v, 40, () => {
        if (v.dynamicPressure > 25000) { v.ctrl.sas = false; v.ctrl.pitch = 1; }
        if (v.structure && v.structure.maxUtil > peak) peak = v.structure.maxUtil;
        return !ev.length;
      });
      return { ev, v, w, n0, peak };
    } finally { TUNING.STRUCT_FAIL = true; }
  };
  const a = run(true);
  assert.ok(a.ev.length >= 1, `nothing broke (peak ${a.peak.toFixed(2)})`);
  const e = a.ev[0];
  assert.ok(e.util > 1 && e.debris && e.debris.parts.size > 0 && a.v.parts.size > 0);
  assert.equal(a.w.vessels.length, a.n0 + a.ev.filter(x => x.debris).length, 'the piece that left is a vessel of its own');
  assert.ok(/Flask S-200|Taper Adapter M-S/.test(e.joint.aName) && /Flask S-200|Taper Adapter M-S/.test(e.joint.bName), `it broke in the thin part: ${e.joint.aName} / ${e.joint.bName}`);
  for (const p of a.v.parts.values()) assert.ok(!e.debris.parts.has(p.id));
  assert.ok(a.v.parts.has(a.v.controlId), 'the crew keep their capsule');
  const b = run(false);
  assert.equal(b.ev.length, 0);
  assert.ok(b.peak > 1, `overload is still reported: ${b.peak.toFixed(2)}`);
});

test('a brief overload does not break a joint; a sustained one does', () => {
  const w = new World({});
  const v = w.launch(stock('Skylark II'), { crew: ['Ada'] });
  const st = v.structure, j = st.joints.find(x => x.kind === 'stack');
  // drive the joint directly: 30 % over for 0.1 s is survived (it needs FAIL_TIME / 0.3 = 0.4 s)
  const over = (u, steps) => { for (let i = 0; i < steps; i++) { if (u > 1) j.damage += (u - 1) * 0.02 / STRUCT.FAIL_TIME; else j.damage = Math.max(0, j.damage - 0.02 / STRUCT.HEAL_TIME); } };
  over(1.3, 5); assert.ok(j.damage < 1);
  over(0.5, 40); assert.equal(j.damage, 0);
  over(1.3, 25); assert.ok(j.damage >= 1);
});

test('brace struts from the core to a side booster take load off its clamp', () => {
  const peak = braced => {
    const c = stock('Ember Twin');
    if (braced) {
      for (const clamp of c.parts.filter(p => p.type === 'dec_radial')) {
        const made = c.attachRadial('strut', clamp.parent, clamp.pos.y + 1.2, clamp.rot, 1);
        assert.ok(made.length, 'strut attached');
      }
    }
    const w = new World({});
    const v = w.launch(c, { crew: ['Ada'] });
    v.ctrl.throttle = 1; v.ctrl.sas = true;
    w.stage();
    let u = 0;
    fly(w, v, 20, () => { for (const j of v.structure.joints) if (j.b.def.id === 'dec_radial' || j.a.def.id === 'dec_radial') u = Math.max(u, j.util); });
    return { u, v };
  };
  const plain = peak(false), braced = peak(true);
  assert.ok(braced.v.structure.joints.some(j => j.braces > 0), 'the strut reaches the booster');
  assert.ok(braced.u < 0.8 * plain.u, `clamp load ${plain.u.toFixed(3)} → ${braced.u.toFixed(3)}`);
});

test('flex: a bent stack bends about its own middle (mass centre and mean attitude stay put)', () => {
  const w = new World({});
  const v = w.launch(stock('Pell Runner'), { crew: ['Ada'] });
  v.ctrl.throttle = 1; v.ctrl.sas = true;
  w.stage();
  let bent = 0;
  fly(w, v, 45, () => { if (v.dynamicPressure > 15000) { v.ctrl.sas = false; v.ctrl.pitch = 1; } });
  const st = v.structure;
  for (const j of st.joints) bent = Math.max(bent, Math.hypot(j.bx, j.by, j.bz));
  assert.ok(bent > 1e-4 && bent < 0.2, `largest bend ${bent} rad`);
  assert.equal(st.updateFlex(), true);
  const u = new Vector3(), r = new Vector3(), sum = new Vector3();
  let m = 0, any = 0;
  for (const p of v.partList) { st.partFlex(p, u, r); sum.addScaledVector(u, p.mass); m += p.mass; any = Math.max(any, u.length()); assert.ok(Number.isFinite(u.x + r.x)); }
  assert.ok(any > 1e-4, 'parts are displaced');
  assert.ok(sum.length() / m < 1e-2 * any, `no net displacement of the mass centre: ${sum.length() / m} of ${any}`);
});

test('analyzeCraft: stock designs pass with margin; a tall thin design is flagged at its thin joints', () => {
  for (const c of stockCrafts()) {
    const r = analyzeCraft(c);
    assert.ok(r.joints.length === c.parts.length - 1, `${c.name}: one joint per link`);
    assert.ok(r.worst.util < STRUCT.WARN, `${c.name}: ${r.worst.util.toFixed(2)} in ${r.worst.case}`);
    assert.equal(r.warnings.length, 0);
    for (const j of r.joints) assert.ok(Number.isFinite(j.util) && j.pos && Number.isFinite(j.pos.y));
  }
  // the same thin run, now holding up a three-seat capsule and a big tank
  const [c] = stack(['pod_hearth', 'tank_l3200', 'adapter_lm', '!adapter_ms', 'tank_s200', 'tank_s200', 'tank_s200', 'tank_s200', 'adapter_ms', 'tank_m800', 'tank_m800', 'eng_goshawk']);
  const r = analyzeCraft(c);
  assert.ok(r.worst.util > 1, `top-heavy noodle: ${r.worst.util.toFixed(2)}`);
  const slim = analyzeCraft(noodle()[0]);
  assert.ok(slim.worst.util > 0.3 && /max Q/.test(slim.worst.case), `the light noodle is worst in the hard turn: ${slim.worst.util.toFixed(2)} ${slim.worst.case}`);
  assert.ok(r.warnings.length >= 1 && /will break/.test(r.warnings[0]));
  const types = [c.getPart(r.worst.a).type, c.getPart(r.worst.b).type];
  assert.ok(types.some(t => t === 'tank_s200' || t === 'adapter_ms'), `worst joint is in the thin section: ${types}`);
  assert.deepEqual(analyzeCraft(new Craft('empty')).joints, []);
});

test('a vessel pinned to the ground reports no loads, and one part has no structure', () => {
  const w = new World({});
  const v = w.launch(stock('Skylark II'), { crew: ['Ada'] });
  w.step(0.02); w.step(0.02);
  assert.equal(v.structure.valid, false);
  assert.equal(v.structure.maxUtil, 0);
  const [c] = stack(['pod_acorn']);
  assert.equal(w.launch(c, { crew: ['Bo'] }).structure, null);
});

test('on rails nothing is loaded, and the read-out does not keep a stale number', () => {
  const w = new World({});
  const v = w.launch(stock('Skylark II'), { crew: ['Ada'] });
  v.landed = false; v.surface = null; v.launched = true;
  v.pos.set(v.body.radius + 200000, 0, 0); v.vel.set(0, 0, -1900);
  v.ctrl.throttle = 1; v.stageIndex = 0; w.stage();
  for (let i = 0; i < 20; i++) w.step(0.02);
  assert.ok(v.structure.valid && v.structure.maxUtil > 0.01, 'loaded while burning');
  v.ctrl.throttle = 0;
  w.step(0.02);
  w.setWarp(5);
  for (let i = 0; i < 5; i++) w.step(0.02);
  assert.ok(v.onRails, 'on rails');
  assert.equal(v.structure.valid, false);
  assert.equal(v.structure.maxUtil, 0);
});
