import test from 'node:test';
import assert from 'node:assert/strict';
import { Craft, stockCrafts, outward } from '../../js/core/craft.js';
import { partDef, G0, engineThrust } from '../../js/core/parts.js';

const near = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `expected ${a} ≈ ${b}`);
const types = (c, stage) => stage.map(id => c.getPart(id).type).sort();
const wet = t => { const d = partDef(t); let m = d.mass * 1000; for (const k in d.res) if (k !== 'elec') m += d.res[k]; return m; };

function simpleRocket() {
  const c = new Craft('Simple');
  const [pod] = c.setRoot('pod_acorn');
  const [tank] = c.attachStack('tank_m400', pod.id, 'bottom');
  const [eng] = c.attachStack('eng_goshawk', tank.id, 'bottom');
  return { c, pod, tank, eng };
}

test('setRoot places the root at the origin and resets the craft', () => {
  const c = new Craft('x');
  const [pod] = c.setRoot('pod_acorn');
  assert.deepEqual(pod, { id: 1, type: 'pod_acorn', pos: { x: 0, y: 0, z: 0 }, rot: 0, parent: null, node: 'root', sym: 0 });
  assert.equal(c.root, pod);
  c.attachStack('tank_m100', pod.id, 'bottom');
  const [probe] = c.setRoot('probe_wisp');
  assert.equal(c.parts.length, 1);
  assert.equal(c.root, probe);
  assert.deepEqual(c.setRoot('fin'), []);        // radial part cannot be a root
  assert.deepEqual(c.setRoot('chute'), []);      // topOnly part cannot be a root
  assert.deepEqual(c.setRoot('nonsense'), []);
  assert.equal(c.root, probe);
});

test('stacking geometry follows the node rule exactly', () => {
  const { c, pod, tank, eng } = simpleRocket();
  near(tank.pos.y, -(1.1 / 2 + 3.75 / 2));
  near(eng.pos.y, tank.pos.y - 3.75 / 2 - 1.4 / 2);
  assert.equal(tank.pos.x, 0); assert.equal(tank.pos.z, 0);
  assert.equal(tank.parent, pod.id); assert.equal(tank.node, 'bottom'); assert.equal(tank.sym, 0);
  const [chute] = c.attachStack('chute', pod.id, 'top');
  near(chute.pos.y, 1.1 / 2 + 0.3 / 2);
  assert.equal(chute.node, 'top');
  // top of one part meets bottom of the next
  near(pod.pos.y - 1.1 / 2, tank.pos.y + 3.75 / 2);
  assert.deepEqual(c.children(pod).map(p => p.id).sort(), [tank.id, chute.id].sort());
  assert.deepEqual(c.subtree(tank).map(p => p.id), [tank.id, eng.id]);
  const b = c.bounds();
  near(b.maxY, 0.55 + 0.3); near(b.minY, eng.pos.y - 0.7); near(b.maxR, 0.625);
});

test('node occupancy', () => {
  const { c, pod, tank, eng } = simpleRocket();
  assert.equal(c.nodeFree(pod, 'top'), true);
  assert.equal(c.nodeFree(pod, 'bottom'), false);     // tank hangs from it
  assert.equal(c.nodeFree(tank, 'top'), false);       // it hangs from the pod via its own top node
  assert.equal(c.nodeFree(tank, 'bottom'), false);
  assert.equal(c.nodeFree(eng, 'bottom'), true);
  assert.equal(c.nodeFree(eng.id, 'bottom'), true);   // ids are accepted too
  assert.deepEqual(c.attachStack('tank_m100', tank.id, 'bottom'), []);
  assert.deepEqual(c.attachStack('tank_m100', tank.id, 'top'), []);
  assert.deepEqual(c.attachStack('tank_m100', 999, 'top'), []);
  assert.deepEqual(c.attachStack('tank_m100', pod.id, 'sideways'), []);
  const [t2] = c.attachStack('tank_m100', pod.id, 'top');
  assert.equal(c.nodeFree(pod, 'top'), false);
  assert.equal(c.nodeFree(t2, 'bottom'), false);      // sits on the pod via its own bottom node
  assert.equal(c.nodeFree(t2, 'top'), true);
  const [fin] = c.attachRadial('fin', tank.id, tank.pos.y, 0);
  assert.equal(c.nodeFree(fin, 'top'), false);        // radial parts have no stack nodes
  assert.deepEqual(c.attachStack('tank_m100', fin.id, 'top'), []);
  assert.deepEqual(c.attachStack('fin', eng.id, 'bottom'), []);   // radial-only part cannot stack
});

test('topOnly parts only go on top, and nothing stacks on them', () => {
  const { c, pod, eng } = simpleRocket();
  assert.deepEqual(c.attachStack('chute', eng.id, 'bottom'), []);
  assert.deepEqual(c.attachStack('nose_m', eng.id, 'bottom'), []);
  const [chute] = c.attachStack('chute', pod.id, 'top');
  assert.ok(chute);
  assert.deepEqual(c.attachStack('tank_m100', chute.id, 'top'), []);
  assert.deepEqual(c.attachStack('nose_m', chute.id, 'top'), []);
  assert.deepEqual(c.attachRadial('chute', pod.id, 0, 0), []);    // stack chute is not a radial part
  assert.deepEqual(c.attachRadial('fin', chute.id, chute.pos.y, 0), []);  // chute has no attach surface
});

test('radiusAt interpolates tapered parts; radial attach uses it', () => {
  const c = new Craft();
  const [pod] = c.setRoot('pod_acorn');                 // h 1.1, rBottom .625, rTop .32
  near(c.radiusAt(pod, -0.55), 0.625);
  near(c.radiusAt(pod, 0.55), 0.32);
  near(c.radiusAt(pod, 0), (0.625 + 0.32) / 2);
  near(c.radiusAt(pod, 5), 0.32);                       // clamped
  near(c.radiusAt(pod, -5), 0.625);
  const y = 0.275, a = 0.7;                             // three quarters of the way up
  const r = 0.625 + (0.32 - 0.625) * 0.75;
  const [th] = c.attachRadial('sci_thermo', pod.id, y, a);
  const d = r + 0.12 / 2;
  near(th.pos.x, Math.cos(a) * d); near(th.pos.z, -Math.sin(a) * d); near(th.pos.y, y);
  assert.equal(th.rot, a); assert.equal(th.node, 'radial'); assert.equal(th.parent, pod.id); assert.equal(th.sym, 0);
  // straight tank
  const [tank] = c.attachStack('tank_m200', pod.id, 'bottom');
  near(c.radiusAt(tank, tank.pos.y + 0.3), 0.625);
  const [fin] = c.attachRadial('fin', tank.id, tank.pos.y, Math.PI / 2);
  near(fin.pos.x, 0, 1e-12); near(fin.pos.z, -(0.625 + 0.4)); near(fin.pos.y, tank.pos.y);
  // y is clamped onto the target
  const [fin2] = c.attachRadial('fin', tank.id, 100, 0);
  near(fin2.pos.y, tank.pos.y + 1.875 / 2);
  // stack parts cannot be attached radially, and bad targets are refused
  assert.deepEqual(c.attachRadial('tank_m100', tank.id, tank.pos.y, 0), []);
  assert.deepEqual(c.attachRadial('fin', 999, 0, 0), []);
  assert.deepEqual(outward(0), { x: 1, y: 0, z: -0 });
});

test('symmetry: counts, angles and a shared new group id', () => {
  const { c, tank } = simpleRocket();
  const a0 = 0.3;
  const fins = c.attachRadial('fin', tank.id, tank.pos.y, a0, 4);
  assert.equal(fins.length, 4);
  const sym = fins[0].sym;
  assert.ok(sym > 0);
  fins.forEach((f, k) => {
    assert.equal(f.sym, sym);
    const a = a0 + k * Math.PI / 2;
    near(f.rot, a);
    near(f.pos.x, Math.cos(a) * 1.025); near(f.pos.z, -Math.sin(a) * 1.025);
    near(Math.hypot(f.pos.x, f.pos.z), 1.025);
  });
  const three = c.attachRadial('fin', tank.id, tank.pos.y - 1, 0, 3);
  assert.equal(three.length, 3);
  assert.notEqual(three[0].sym, sym);
  near(three[1].rot, 2 * Math.PI / 3); near(three[2].rot, 4 * Math.PI / 3);
  assert.equal(c.symmetryGroup(fins[2]).length, 4);
  assert.equal(c.attachRadial('fin', tank.id, tank.pos.y, 1, 1)[0].sym, 0);
});

test('attachOuter geometry on a radial decoupler', () => {
  const { c, tank } = simpleRocket();
  const a = Math.PI / 3;
  const [dec] = c.attachRadial('dec_radial', tank.id, tank.pos.y - 0.4, a);
  near(Math.hypot(dec.pos.x, dec.pos.z), 0.625 + 0.11);
  assert.equal(c.outerFree(dec), true);
  assert.deepEqual(c.attachOuter('fin', dec.id), []);         // not a stack part
  assert.deepEqual(c.attachOuter('nose_m', dec.id), []);      // topOnly
  assert.deepEqual(c.attachOuter('srb_ember', tank.id), []);  // target is not a radial decoupler
  const [srb] = c.attachOuter('srb_ember', dec.id);
  const dist = 0.625 + 0.22 + 0.625;                          // tank r + decoupler rw + booster r
  near(srb.pos.x, Math.cos(a) * dist); near(srb.pos.z, -Math.sin(a) * dist); near(srb.pos.y, dec.pos.y);
  near(srb.pos.x, dec.pos.x + Math.cos(a) * (0.11 + 0.625));
  assert.equal(srb.rot, a); assert.equal(srb.node, 'outer'); assert.equal(srb.parent, dec.id);
  assert.equal(c.outerFree(dec), false);
  assert.deepEqual(c.attachOuter('srb_ember', dec.id), []);   // outer face taken
  assert.equal(c.nodeFree(srb, 'top'), true); assert.equal(c.nodeFree(srb, 'bottom'), true);
  const [nose] = c.attachStack('nose_m', srb.id, 'top');
  near(nose.pos.x, srb.pos.x); near(nose.pos.z, srb.pos.z); near(nose.pos.y, srb.pos.y + 1.3 + 0.5);
  near(c.bounds().maxR, dist + 0.625);
});

test('attachments onto a symmetry group are mirrored onto every member', () => {
  const { c, tank } = simpleRocket();
  const decs = c.attachRadial('dec_radial', tank.id, tank.pos.y, 0, 3);
  const srbs = c.attachOuter('srb_ember', decs[1].id);        // target any member
  assert.equal(srbs.length, 3);
  assert.ok(srbs[0].sym > 0 && srbs[0].sym !== decs[0].sym);
  srbs.forEach((s, k) => {
    assert.equal(s.sym, srbs[0].sym); assert.equal(s.parent, decs[k].id);
    near(s.rot, k * 2 * Math.PI / 3);
    near(Math.hypot(s.pos.x, s.pos.z), 0.625 + 0.22 + 0.625);
  });
  const noses = c.attachStack('nose_m', srbs[2].id, 'top');
  assert.equal(noses.length, 3);
  noses.forEach((n, k) => { assert.equal(n.parent, srbs[k].id); near(n.pos.x, srbs[k].pos.x); near(n.pos.z, srbs[k].pos.z); });
  assert.deepEqual(c.attachStack('nose_m', srbs[0].id, 'top'), []);   // all tops now taken
  // radial symmetry on a mirrored target multiplies out, about each member's own axis
  const fins = c.attachRadial('fin', srbs[0].id, srbs[0].pos.y - 1, 0, 2);
  assert.equal(fins.length, 6);
  assert.equal(new Set(fins.map(f => f.sym)).size, 1);
  for (const f of fins) {
    const s = c.getPart(f.parent);
    near(Math.hypot(f.pos.x - s.pos.x, f.pos.z - s.pos.z), 0.625 + 0.4);
    near(f.pos.y, s.pos.y - 1);
  }
  // the copy on each booster keeps the same angle RELATIVE to that booster's yaw
  for (const s of srbs) {
    const mine = fins.filter(f => f.parent === s.id).map(f => f.rot - s.rot).sort((a, b) => a - b);
    near(mine[0], 0); near(mine[1], Math.PI);
  }
});

test('removePart removes the subtree and symmetric counterparts', () => {
  const { c, tank, eng } = simpleRocket();
  const decs = c.attachRadial('dec_radial', tank.id, tank.pos.y, 0, 2);
  const srbs = c.attachOuter('srb_ember', decs[0].id);
  const noses = c.attachStack('nose_m', srbs[0].id, 'top');
  assert.equal(c.parts.length, 9);
  const gone = c.removePart(noses[1].id);                  // one nose → both noses
  assert.deepEqual(gone.map(p => p.id).sort(), noses.map(p => p.id).sort());
  assert.equal(c.nodeFree(srbs[0], 'top'), true);
  c.attachStack('nose_m', srbs[0].id, 'top');
  const removed = c.removePart(decs[0].id);                // one clamp → both clamps, boosters and noses
  assert.equal(removed.length, 6);
  assert.deepEqual(c.parts.map(p => p.type), ['pod_acorn', 'tank_m400', 'eng_goshawk']);
  assert.deepEqual(c.stages, [[eng.id]]);                  // staging follows
  assert.deepEqual(c.removePart(12345), []);
  assert.equal(c.removePart(tank.id).length, 2);           // subtree: tank + engine
  assert.deepEqual(c.stages, []);
  assert.equal(c.removePart(c.root.id).length, 1);
  assert.equal(c.root, null);
  assert.deepEqual(c.bounds(), { minY: 0, maxY: 0, maxR: 0 });
});

test('JSON round trip and clone', () => {
  const c = stockCrafts().find(s => s.name === 'Ember Twin');
  const json = JSON.parse(JSON.stringify(c));
  const d = Craft.fromJSON(json);
  assert.deepEqual(d.toJSON(), c.toJSON());
  assert.equal(d.name, c.name);
  assert.deepEqual(d.stages, c.stages);
  assert.deepEqual(d.stats(), c.stats());
  assert.deepEqual(Craft.fromJSON(JSON.stringify(c)).toJSON(), c.toJSON());   // string input too
  // new ids / symmetry groups continue after the loaded ones
  const tank = d.parts.find(p => p.type === 'tank_m800');
  const [fin] = d.attachRadial('fin', tank.id, tank.pos.y, 1, 2);
  assert.ok(fin.id > Math.max(...c.parts.map(p => p.id)));
  assert.ok(fin.sym > Math.max(...c.parts.map(p => p.sym)));
  // clone is independent
  const e = c.clone();
  e.removePart(e.parts.find(p => p.type === 'eng_goshawk').id);
  e.parts[0].pos.y = 99;
  assert.equal(c.parts[0].pos.y, 0);
  assert.ok(c.parts.some(p => p.type === 'eng_goshawk'));
  assert.throws(() => Craft.fromJSON({ name: 'bad', parts: [{ id: 1, type: 'warp_drive', pos: { x: 0, y: 0, z: 0 }, rot: 0, parent: null, node: 'root', sym: 0 }], stages: [] }));
});

test('auto-staging (a): single stage', () => {
  const { c, pod, eng } = simpleRocket();
  assert.deepEqual(c.stages, [[eng.id]]);                  // edits restage automatically
  const [chute] = c.attachStack('chute', pod.id, 'top');
  assert.deepEqual(c.autoStage(), [[eng.id], [chute.id]]);
  assert.deepEqual(c.stages, [[eng.id], [chute.id]]);
});

test('auto-staging (b): two stages with a separator', () => {
  const c = new Craft();
  const [pod] = c.setRoot('pod_acorn');
  const [chute] = c.attachStack('chute', pod.id, 'top');
  const [t1] = c.attachStack('tank_m200', pod.id, 'bottom');
  const [e1] = c.attachStack('eng_sparrow', t1.id, 'bottom');
  const [dec] = c.attachStack('dec_m', e1.id, 'bottom');
  const [t2] = c.attachStack('tank_m400', dec.id, 'bottom');
  const [e2] = c.attachStack('eng_goshawk', t2.id, 'bottom');
  c.autoStage();
  assert.deepEqual(c.stages, [[e2.id], [e1.id, dec.id], [chute.id]]);
  const depth = c.depths();
  assert.equal(depth.get(pod.id), 0); assert.equal(depth.get(e1.id), 0);
  assert.equal(depth.get(dec.id), 1); assert.equal(depth.get(e2.id), 1);
  // sections do not cross the separator
  const sec = c.sections();
  assert.equal(sec.get(t1.id), sec.get(e1.id));
  assert.notEqual(sec.get(t1.id), sec.get(t2.id));
  assert.equal(sec.get(dec.id), -1);
});

test('auto-staging (c): core + radial boosters', () => {
  const c = new Craft();
  const [pod] = c.setRoot('pod_acorn');
  const [chute] = c.attachStack('chute', pod.id, 'top');
  const [tank] = c.attachStack('tank_m800', pod.id, 'bottom');
  const [core] = c.attachStack('eng_goshawk', tank.id, 'bottom');
  const clamps = c.attachRadial('dec_radial', tank.id, tank.pos.y, 0, 2);
  const srbs = c.attachOuter('srb_ember', clamps[0].id);
  c.autoStage();
  // documented exception: the liquid core lights with the boosters hanging off its own section
  assert.deepEqual(c.stages, [[core.id, ...srbs.map(s => s.id)], clamps.map(k => k.id), [chute.id]]);

  // with a separator above the core: core + boosters, clamps, separator + upper engine, chute
  const c2 = new Craft();
  const [pod2] = c2.setRoot('pod_acorn');
  const [ch2] = c2.attachStack('chute', pod2.id, 'top');
  const [ut] = c2.attachStack('tank_m200', pod2.id, 'bottom');
  const [ue] = c2.attachStack('eng_sparrow', ut.id, 'bottom');
  const [sep] = c2.attachStack('dec_m', ue.id, 'bottom');
  const [lt] = c2.attachStack('tank_m800', sep.id, 'bottom');
  const [le] = c2.attachStack('eng_goshawk', lt.id, 'bottom');
  const k2 = c2.attachRadial('dec_radial', lt.id, lt.pos.y, 0, 3);
  const b2 = c2.attachOuter('srb_ember', k2[0].id);
  c2.autoStage();
  assert.deepEqual(c2.stages, [[le.id, ...b2.map(s => s.id)], k2.map(k => k.id), [ue.id, sep.id], [ch2.id]]);
  assert.equal(c2.depths().get(b2[0].id), 2);

  // a SOLID core does not get the exception: plain rule [boosters] [clamps + core]
  const c3 = new Craft();
  const [p3] = c3.setRoot('probe_wisp');
  const [s3] = c3.attachStack('srb_maul', p3.id, 'bottom');
  const k3 = c3.attachRadial('dec_radial', s3.id, s3.pos.y, 0, 2);
  const b3 = c3.attachOuter('srb_ember', k3[0].id);
  c3.autoStage();
  assert.deepEqual(c3.stages, [b3.map(s => s.id), [s3.id, ...k3.map(k => k.id)]]);
});

test('manual staging: moveToStage, insertStage, removeEmptyStages', () => {
  const { c, pod, tank, eng } = simpleRocket();
  const [chute] = c.attachStack('chute', pod.id, 'top');
  assert.equal(c.stageOf(eng.id), 0); assert.equal(c.stageOf(chute.id), 1); assert.equal(c.stageOf(tank.id), -1);
  assert.equal(c.moveToStage(tank.id, 0), false);          // tanks are not stageable
  assert.equal(c.moveToStage(999, 0), false);
  assert.equal(c.autoStaging, true);
  assert.equal(c.insertStage(1), 1);
  assert.deepEqual(c.stages, [[eng.id], [], [chute.id]]);
  assert.equal(c.autoStaging, false);
  assert.ok(c.validate().warnings.some(w => /empty/i.test(w)));
  assert.equal(c.moveToStage(chute.id, 0), true);
  assert.deepEqual(c.stages, [[eng.id, chute.id], [], []]);
  assert.equal(c.moveToStage(chute.id, 3), true);          // index == length appends a stage
  assert.deepEqual(c.stages, [[eng.id], [], [], [chute.id]]);
  c.removeEmptyStages();
  assert.deepEqual(c.stages, [[eng.id], [chute.id]]);
  // while manual, edits keep the hand-made layout and slot new parts in
  c.moveToStage(chute.id, 0);
  const [dec] = c.attachStack('dec_m', eng.id, 'bottom');
  assert.equal(c.stageOf(eng.id), 0); assert.equal(c.stageOf(chute.id), 0);
  assert.ok(c.stageOf(dec.id) >= 0);
  c.removePart(dec.id);
  assert.equal(c.stageOf(dec.id), -1);
  c.autoStage();                                           // back to automatic
  assert.equal(c.autoStaging, true);
  assert.deepEqual(c.stages, [[eng.id], [chute.id]]);
});

test('cost and mass sums', () => {
  const { c } = simpleRocket();
  assert.equal(c.cost(), 600 + 500 + 880);
  near(c.mass(), 800 + 10 + 250 + 2000 + 1300, 1e-6);      // capsule + its mono, tank + fuel, engine
  near(c.dryMass(), 800 + 10 + 250 + 1300, 1e-6);
  for (const s of stockCrafts()) {
    // plus the interstage trusses under its upper-stage engines (tests/unit/interstage.test.js checks those sums)
    near(s.mass(), s.parts.reduce((m, p) => m + wet(p.type), 0) + s.interstageMass(), 1e-6);
    assert.equal(s.cost(), s.parts.reduce((m, p) => m + partDef(p.type).cost, 0));
    if (s.stages.length) near(s.stats()[0].startMass, s.mass(), 1e-6);        // a rover has no stages at all
  }
  assert.equal(new Craft().mass(), 0); assert.equal(new Craft().cost(), 0);
});

test('stats: single-stage dv matches Tsiolkovsky', () => {
  const { c } = simpleRocket();
  const m0 = 4360, m1 = 2360;
  const st = c.stats();
  assert.equal(st.length, 1);
  const s = st[0];
  const dvVac = 305 * G0 * Math.log(m0 / m1), dvAtm = 265 * G0 * Math.log(m0 / m1);
  near(s.dvVac, dvVac, dvVac * 0.01); near(s.dvVac, dvVac, 1e-6);
  near(s.dvAtm, dvAtm, dvAtm * 0.01);
  near(s.startMass, m0, 1e-6); near(s.endMass, m1, 1e-6);
  near(s.thrust, 220000, 1e-6); near(s.thrustAtm, 220000 * 265 / 305, 1e-6);
  near(s.burnTime, 2000 / (220000 / (305 * G0)), 1e-6);
  near(s.twr, engineThrust(partDef('eng_goshawk'), 1) / (m0 * 9.6), 1e-9);   // liftoff stage → sea level
  near(s.twrVac, 220000 / (m0 * 9.6), 1e-9);
  assert.equal(s.stage, 0);
  near(c.deltaV().vac, dvVac, 1e-6);
  // another body: TWR scales with surface gravity, dv does not
  const pell = c.stats({ surfaceG: 1.6 })[0];
  near(pell.twrVac, s.twrVac * 6, 1e-9); near(pell.dvVac, s.dvVac, 1e-9);
  // airless body object with pressureAtm → liftoff TWR uses that pressure
  near(c.stats({ surfaceG: 1.6, pressureAtm: () => 0 })[0].twr, pell.twrVac, 1e-9);
});

test('stats: two stages, solid boosters and fuel sections', () => {
  // two-stage: each stage is its own Tsiolkovsky burn
  const c = new Craft();
  const [pod] = c.setRoot('pod_acorn');
  const [t1] = c.attachStack('tank_m200', pod.id, 'bottom');
  const [e1] = c.attachStack('eng_sparrow', t1.id, 'bottom');
  const [dec] = c.attachStack('dec_m', e1.id, 'bottom');
  const [t2] = c.attachStack('tank_m400', dec.id, 'bottom');
  c.attachStack('eng_goshawk', t2.id, 'bottom');
  const st = c.stats();
  assert.equal(st.length, 2);
  // the separator carries a lattice interstage around the Sparrow: 2π · 0.625 m · 0.9 m of wall at 12 kg/m² = 42.4 kg
  const truss = 42.4;
  assert.equal(c.interstageMass(), truss);
  const upper = 810 + 1125 + 500, total = upper + 50 + truss + 2250 + 1300;
  near(st[0].startMass, total, 1e-6); near(st[0].endMass, total - 2000, 1e-6);
  near(st[0].dvVac, 305 * G0 * Math.log(total / (total - 2000)), 1e-6);
  near(st[1].startMass, upper, 1e-6);                        // separator and lower stage dropped
  near(st[1].dvVac, 340 * G0 * Math.log(upper / (upper - 1000)), 1e-6);
  near(st[1].twr, 65000 / (upper * 9.6), 1e-9);              // upper stage → vacuum TWR
  near(st[0].twr, 220000 * 265 / 305 / (total * 9.6), 1e-9);
  // the lower engine cannot reach the upper tank (different section): upper fuel untouched in stage 0

  // core + boosters lit together: stage 0 ends at booster burnout, the core keeps burning into stage 1
  const b = new Craft();
  const [p] = b.setRoot('probe_wisp');
  const [tank] = b.attachStack('tank_m800', p.id, 'bottom');
  b.attachStack('eng_goshawk', tank.id, 'bottom');
  const clamps = b.attachRadial('dec_radial', tank.id, tank.pos.y, 0, 2);
  b.attachOuter('srb_ember', clamps[0].id);
  b.autoStage();
  const s = b.stats();
  assert.equal(s.length, 2);
  const mdotSrb = 190000 / (185 * G0), mdotCore = 220000 / (305 * G0), tSrb = 3400 / mdotSrb;
  near(s[0].burnTime, tSrb, 1e-6);
  const m0 = 100 + 4500 + 1300 + 2 * (40 + 3850);
  near(s[0].startMass, m0, 1e-6);
  near(s[0].endMass, m0 - 6800 - mdotCore * tSrb, 1e-6);
  near(s[0].thrust, 600000, 1e-6);
  const ve = 600000 / (2 * mdotSrb + mdotCore);
  near(s[0].dvVac, ve * Math.log(m0 / s[0].endMass), 1e-6);
  near(s[1].startMass, 5900 - mdotCore * tSrb, 1e-6);        // boosters + clamps gone, core fuel partly used
  near(s[1].endMass, 1900, 1e-6);
  near(s[1].thrust, 220000, 1e-6);
  near(s[1].burnTime, 4000 / mdotCore - tSrb, 1e-6);
  near(s[1].dvVac, 305 * G0 * Math.log(s[1].startMass / 1900), 1e-6);

  // an engine drains every tank in its section, and nothing without propellant produces dv
  const d = new Craft();
  const [pr] = d.setRoot('probe_wisp');
  const [a] = d.attachStack('tank_m100', pr.id, 'bottom');
  const [bb] = d.attachStack('tank_m400', a.id, 'bottom');
  const [eng] = d.attachStack('eng_sparrow', bb.id, 'bottom');
  const ds = d.stats()[0];
  near(ds.endMass, ds.startMass - 2500, 1e-6);
  near(ds.dvVac, 340 * G0 * Math.log(ds.startMass / ds.endMass), 1e-6);
  near(ds.burnTime, 2500 / (65000 / (340 * G0)), 1e-6);
  d.removePart(eng.id);
  d.attachStack('dec_m', bb.id, 'bottom');
  assert.equal(d.deltaV().vac, 0);
});

test('validate', () => {
  const empty = new Craft().validate();
  assert.equal(empty.ok, false); assert.equal(empty.errors.length, 1);
  const c = new Craft();
  const [tank] = c.setRoot('tank_m400');
  let v = c.validate();
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /command/i.test(e)));
  assert.ok(v.warnings.some(w => /engine/i.test(w)));
  const [pod] = c.attachStack('pod_acorn', tank.id, 'top');
  v = c.validate();
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some(w => /parachute/i.test(w)));
  assert.ok(v.warnings.some(w => /engine/i.test(w)));
  c.attachStack('chute', pod.id, 'top');
  const [eng] = c.attachStack('eng_sparrow', tank.id, 'bottom');   // 65 kN·90/340 at sea level: far too weak
  v = c.validate();
  assert.ok(!v.warnings.some(w => /parachute/i.test(w)));
  assert.ok(v.warnings.some(w => /thrust-to-weight/i.test(w)));
  c.removePart(eng.id);
  c.attachStack('eng_goshawk', tank.id, 'bottom');
  v = c.validate();
  assert.deepEqual(v, { ok: true, errors: [], warnings: [] });
  // probes do not need parachutes
  const p = new Craft(); p.setRoot('probe_wisp');
  assert.ok(!p.validate().warnings.some(w => /parachute/i.test(w)));
});

test('stock crafts meet their requirements', () => {
  const crafts = stockCrafts();
  const byName = Object.fromEntries(crafts.map(c => [c.name, c]));
  for (const n of ['Hopper I', 'Skylark II', 'Pell Runner']) assert.ok(byName[n], `missing ${n}`);
  assert.equal(new Set(crafts.map(c => c.name)).size, crafts.length);
  // the seven rockets of the first pass follow rocket rules to the letter; the second-pass designs (aeroplanes,
  // rovers, landers that never come home, ion and atomic stages) are valid but may carry honest warnings
  const classic = new Set(['Hopper I', 'Skylark II', 'Pell Runner', 'Ember Twin', 'Mote Sounder', 'Latch Target', 'Latch Chaser']);
  assert.ok(crafts.length >= 15, 'the second-pass designs are there: ' + crafts.map(c => c.name).join(', '));
  for (const c of crafts) {
    const v = c.validate();
    if (classic.has(c.name)) assert.deepEqual(v, { ok: true, errors: [], warnings: [] }, c.name);
    else {
      assert.ok(v.ok && v.errors.length === 0, `${c.name}: ${v.errors.join('; ')}`);
      for (const wng of v.warnings) assert.match(wng, /parachute|No engines|wing|ion|electric|lift/i, `${c.name}: ${wng}`);
    }
    const has = t => c.parts.some(p => p.type === t);
    const crewed = classic.has(c.name) && c.parts.some(p => partDef(p.type).command === 'crew');
    if (crewed) {
      assert.ok(has('chute') || has('chute_radial'), `${c.name} chute`);
      // parachutes fire in the last stage, after everything else (a nose docking port means side parachutes)
      assert.ok(c.stages.at(-1).length > 0 && c.stages.at(-1).every(id => partDef(c.getPart(id).type).chute), c.name);
      if (has('chute')) assert.deepEqual(types(c, c.stages.at(-1)), ['chute'], c.name);
    }
    // every stageable part is staged exactly once
    const staged = c.stages.flat();
    assert.equal(new Set(staged).size, staged.length);
    const stageable = c.parts.filter(p => { const d = partDef(p.type); return d.engine || d.decoupler || d.chute; });
    assert.deepEqual(staged.slice().sort((a, b) => a - b), stageable.map(p => p.id));
    // tree integrity and no two stack parts in the same place
    for (const p of c.parts) if (p.parent !== null) assert.ok(c.getPart(p.parent), 'parent exists');
    const seen = new Set();
    for (const p of c.parts) { const k = [p.pos.x, p.pos.y, p.pos.z].map(v => v.toFixed(3)).join(); assert.ok(!seen.has(k), `${c.name} overlap`); seen.add(k); }
    // every burning stage has a sensible TWR; stock crafts are independent instances
    for (const s of c.stats()) if (s.thrust > 0) assert.ok(classic.has(c.name) ? s.twr > 0.5 && s.twr < 4.5 : s.twr > 0.1 && s.twr < 6, `${c.name} stage ${s.stage} twr ${s.twr}`);
  }
  assert.notEqual(stockCrafts()[0], crafts[0]);

  const hopper = byName['Hopper I'];
  assert.deepEqual(hopper.parts.slice(0, 3).map(p => p.type), ['pod_acorn', 'chute', 'srb_ember']);
  assert.deepEqual(hopper.stages.map(s => types(hopper, s)), [['srb_ember'], ['chute']]);

  const sky = byName['Skylark II'];
  const ss = sky.stats();
  assert.ok(sky.deltaV().vac >= 3600, `Skylark dv ${sky.deltaV().vac}`);
  assert.ok(ss[0].twr >= 1.3 && ss[0].twr <= 1.9, `Skylark liftoff TWR ${ss[0].twr}`);
  assert.ok(ss[1].twr >= 0.8);
  assert.deepEqual(sky.stages.map(s => types(sky, s)), [['eng_goshawk'], ['dec_m', 'eng_sparrow'], ['dec_m'], ['chute']]);
  assert.ok(sky.parts.filter(p => p.type === 'fin').length >= 3);

  const pell = byName['Pell Runner'];
  const ps = pell.stats();
  assert.ok(pell.deltaV().vac >= 5600, `Pell Runner dv ${pell.deltaV().vac}`);
  assert.ok(ps[0].twr >= 1.25, `Pell Runner liftoff TWR ${ps[0].twr}`);
  assert.equal(ps.filter(s => s.dvVac > 0).length, 3);          // three propulsive stages
  // legs sit on the last propulsive stage: same decoupler depth as the last engine to fire
  const depth = pell.depths();
  const legs = pell.parts.filter(p => p.type === 'legs');
  assert.ok(legs.length >= 3);
  const lastEngine = pell.getPart(pell.stages[2].find(id => partDef(pell.getPart(id).type).engine));
  for (const l of legs) assert.equal(depth.get(l.id), depth.get(lastEngine.id));
  assert.equal(depth.get(lastEngine.id), Math.min(...pell.parts.filter(p => partDef(p.type).engine).map(p => depth.get(p.id))));
  // deployed feet reach below the lander engine bell
  const legDef = partDef('legs');
  assert.ok(legs[0].pos.y - legDef.legs.reach < lastEngine.pos.y - partDef(lastEngine.type).h / 2);
  // lander can lift off from Pell and has dv for landing there
  assert.ok(pell.stats({ surfaceG: 1.6 })[2].twrVac > 2);
  assert.ok(ps[2].dvVac > 1200);

  // crewed designs: heat shield directly under the capsule, chute directly on top
  for (const c of [sky, pell, byName['Ember Twin']]) {
    const pod = c.parts.find(p => p.type === 'pod_acorn');
    const kids = c.children(pod);
    assert.ok(kids.some(k => k.type === 'heatshield_m' && k.node === 'bottom'), `${c.name} heat shield`);
    assert.ok(kids.some(k => k.type === 'chute' && k.node === 'top'), `${c.name} chute`);
    // the capsule separates from everything but shield + chute before the chute stage
    const shield = kids.find(k => k.type === 'heatshield_m');
    assert.equal(c.children(shield)[0].type, 'dec_m');
    near(c.stats().at(-1).startMass, wet('pod_acorn') + wet('heatshield_m') + wet('chute'), 1e-6);
  }

  // Ember Twin: hand-tuned order equals what a player wants — core and boosters together
  const twin = byName['Ember Twin'];
  assert.deepEqual(twin.stages.map(s => types(twin, s)),
    [['eng_goshawk', 'srb_ember', 'srb_ember'], ['dec_radial', 'dec_radial'], ['dec_m', 'eng_sparrow'], ['dec_m'], ['chute']]);
  assert.ok(twin.deltaV().vac > 4500);
});

// ------------------------------------------------------------------ round 2: orientation, assemblies, design metadata
import { partQuat, partAxis, isTilted, flipAssembly, assemblyLayout, closedNode } from '../../js/core/craft.js';
import { partActions } from '../../js/core/vessel.js';

test('parts without flip / pitch / roll keep their old JSON shape and point straight up', () => {
  const { c, eng } = simpleRocket();
  const json = c.toJSON();
  for (const p of json.parts) assert.deepEqual(Object.keys(p).sort(), ['id', 'node', 'parent', 'pos', 'rot', 'sym', 'type']);
  assert.equal(isTilted(eng), false);
  const ax = partAxis(eng);
  near(ax.x, 0); near(ax.y, 1); near(ax.z, 0);
  assert.ok(!('desc' in json) || json.desc === '');
  assert.ok(!('subassemblies' in json));
});

test('flip, pitch and roll survive a JSON round trip and turn the part axis', () => {
  const { c, tank } = simpleRocket();
  const [fin] = c.attachRadial('fin', tank.id, 0, 0, 1, { pitch: 0.3, roll: -0.2 });
  near(fin.pitch, 0.3); near(fin.roll, -0.2);
  const [nose] = c.attachStack('eng_sparrow', c.root.id, 'top', { flip: true });
  assert.equal(nose.flip, true);
  const back = Craft.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
  const f2 = back.getPart(fin.id), n2 = back.getPart(nose.id);
  near(f2.pitch, 0.3); near(f2.roll, -0.2); assert.equal(n2.flip, true);
  const ax = partAxis(n2);
  near(ax.y, -1, 1e-9);
  const q = partQuat(n2);
  near(Math.hypot(...q), 1, 1e-9);
  assert.equal(q.length, 4);
  assert.equal(isTilted(f2), true);
});

test('a flipped engine pushes against the stack in the stage statistics', () => {
  const plain = simpleRocket();
  const base = Math.max(...plain.c.stats().map(st => st.thrust || 0));
  const { c } = simpleRocket();
  c.attachStack('eng_sparrow', c.root.id, 'top', { flip: true });
  assert.ok(base > 0);
  // both engines light in the same stage: the one pointing the wrong way pushes back, so the net thrust drops
  const back = engineThrust(partDef('eng_sparrow'), 0);
  near(Math.max(...c.stats().map(st => st.thrust || 0)), base - back, 1e-6);
  // the same engine the right way up does count
  const { c: c3, eng } = simpleRocket();
  const d = c3.detachSubtree(eng.id);
  c3.attachAssembly(d.asm, [{ parentId: d.from.parentId, node: 'bottom', x: d.from.x, y: d.from.y, z: d.from.z, yaw: 0, mirror: false }]);
  near(Math.max(...c3.stats().map(st => st.thrust || 0)), base, 1e-6);
});

test('topOnly parts flip their closed node and may hang below a part when flipped', () => {
  const { c, eng } = simpleRocket();
  const c2 = new Craft('y'); const [pod] = c2.setRoot('probe_wisp');
  assert.equal(c2.canAttachStack('chute', pod.id, 'bottom'), false);
  assert.equal(c2.canAttachStack('chute', pod.id, 'bottom', { flip: true }), true);
  const [ch] = c2.attachStack('chute', pod.id, 'bottom', { flip: true });
  assert.equal(closedNode(ch), 'bottom');
  assert.ok(ch.pos.y < pod.pos.y);
  assert.ok(eng && c);
});

test('description, launch site and saved sub-assemblies are part of the design', () => {
  const { c, tank } = simpleRocket();
  c.desc = 'A small test rocket.'; c.site = 'runway';
  const side = new Craft('s'); const [r] = side.setRoot('tank_m100'); side.attachStack('eng_sparrow', r.id, 'bottom');
  c.subassemblies = [{ asm: side.assemblyOf(r.id), x: 4, y: 1, z: 0, yaw: 0 }];
  const back = Craft.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
  assert.equal(back.desc, 'A small test rocket.');
  assert.equal(back.site, 'runway');
  assert.equal(back.subassemblies.length, 1);
  assert.deepEqual(back.subassemblies[0].asm.parts.map(p => p.type), ['tank_m100', 'eng_sparrow']);
  assert.equal(back.parts.length, c.parts.length, 'loose pieces are not parts of the craft');
  near(back.stats()[0].startMass, c.stats()[0].startMass, 1e-9);
  assert.ok(tank);
  const bad = Craft.fromJSON({ ...c.toJSON(), subassemblies: [{ asm: { parts: [{ type: 'nope' }] } }, 7], site: 'moon' });
  assert.equal(bad.subassemblies.length, 0);
  assert.equal(bad.site, null);
});

test('stock designs carry a description', () => {
  for (const c of stockCrafts()) assert.ok(typeof c.desc === 'string' && c.desc.length > 10, `${c.name} has a description`);
});

test('pulling a section off and putting it back keeps staging and action groups', () => {
  const c = new Craft('g');
  const [pod] = c.setRoot('pod_acorn');
  const [dec] = c.attachStack('dec_m', pod.id, 'bottom');
  const [tank] = c.attachStack('tank_m400', dec.id, 'bottom');
  const [eng] = c.attachStack('eng_goshawk', tank.id, 'bottom');
  const panels = c.attachRadial('solar', tank.id, 0, 0, 2);
  const engAct = partActions(partDef('eng_goshawk'))[0].id, solAct = partActions(partDef('solar'))[0].id;
  assert.ok(c.setAction('1', eng.id, engAct));
  assert.ok(c.setAction('lights', panels[0].id, solAct));
  assert.equal(c.actionGroups.lights.length, 2, 'symmetric twins are bound together');
  c.autoStaging = false;
  c.stages = [[eng.id], [dec.id]];
  const before = c.parts.length;

  const peek = c.assemblyOf(tank.id);
  assert.equal(c.parts.length, before, 'assemblyOf does not touch the craft');
  assert.equal(peek.parts[0].parent, null);

  const d = c.detachSubtree(tank.id);
  assert.equal(c.parts.length, 2);
  assert.equal(d.asm.parts.length, 4);
  assert.deepEqual(d.from.parentId, dec.id);
  assert.equal(c.actionGroups['1'], undefined, 'bindings of removed parts are pruned from the craft');
  assert.equal(c.actionGroups.lights, undefined);

  const made = c.attachAssembly(d.asm, [{ parentId: d.from.parentId, node: d.from.node, x: d.from.x, y: d.from.y, z: d.from.z, yaw: d.from.yaw, mirror: false }]);
  assert.equal(made.length, 4);
  const eng2 = made.find(p => p.type === 'eng_goshawk'), sol2 = made.filter(p => p.type === 'solar');
  assert.deepEqual(c.actionGroups['1'], [{ part: eng2.id, action: engAct }]);
  assert.deepEqual(c.actionGroups.lights.map(a => a.part).sort(), sol2.map(p => p.id).sort());
  assert.equal(c.stageOf(eng2.id), 0, 'the engine is back in its stage');
  assert.equal(c.stageOf(dec.id), 1);
  assert.ok(sol2[0].sym && sol2[0].sym === sol2[1].sym, 'the panels are still one symmetry group');
  near(eng2.pos.y, eng.pos.y, 1e-9);
  assert.deepEqual(c.validate().errors || [], c.validate().errors || []);
});

test('reroot turns the stack over without moving anything', () => {
  const { c, pod, tank, eng } = simpleRocket();
  const pos = c.parts.map(p => [p.id, p.pos.y]);
  assert.deepEqual(c.reroot(tank.id), { ok: true });
  assert.equal(c.root.id, tank.id);
  assert.equal(c.getPart(pod.id).parent, tank.id);
  assert.equal(c.getPart(pod.id).node, 'top');
  assert.equal(c.getPart(eng.id).parent, tank.id);
  for (const [id, y] of pos) near(c.getPart(id).pos.y, y);
  const [fin] = c.attachRadial('fin', tank.id, 0, 0, 1);
  assert.equal(c.reroot(fin.id).ok, false);
  assert.equal(c.reroot(tank.id).ok, false);
});

test('tiltPart pivots a surface part about its mount; twins follow, mirrored twins roll the other way', () => {
  const { c, tank } = simpleRocket();
  const fins = c.attachRadial('fin', tank.id, 0, 0, 2);
  const d = partDef('fin'), o = outward(fins[0].rot);
  const mount = { x: fins[0].pos.x - o.x * d.rw / 2, y: fins[0].pos.y, z: fins[0].pos.z - o.z * d.rw / 2 };
  assert.equal(c.tiltPart(fins[0].id, 0.4, 0.25), true);
  near(fins[0].pitch, 0.4); near(fins[1].pitch, 0.4);
  near(fins[0].pos.x - o.x * d.rw / 2 * Math.cos(0.4), mount.x, 1e-9);
  near(fins[0].pos.y - d.rw / 2 * Math.sin(0.4), mount.y, 1e-9);
  near(Math.abs(fins[1].roll), 0.25);
  assert.equal(c.tiltPart(fins[0].id, -0.4, -0.25), true);
  assert.equal(isTilted(fins[0]), false);
  near(fins[0].pos.y, mount.y, 1e-9);
  assert.equal(c.tiltPart(tank.id, 0.1, 0), false, 'stack parts do not tilt');
});

test('mirror symmetry is relative to the parent: a lone side pod gets both copies', () => {
  const { c, tank } = simpleRocket();
  // on the centre stack: across x = 0
  const a = c.symmetryCopies({ parentId: tank.id, node: 'radial', x: 0.9, y: 0, z: 0.2, yaw: 0, mirror: false }, { mode: 'mirror', n: 2 });
  assert.equal(a.length, 2);
  near(a[1].x, -0.9); near(a[1].z, 0.2); assert.equal(a[1].parentId, tank.id); assert.equal(a[1].mirror, true);
  // a single booster out on the +x side: copies go on both sides of THAT booster
  const [boost] = c.attachOuter('tank_m200', c.attachRadial('dec_radial', tank.id, tank.pos.y, 0, 1)[0].id);
  assert.ok(boost.pos.x > 1);
  const s = { parentId: boost.id, node: 'radial', x: boost.pos.x + 0.7, y: boost.pos.y, z: 0.1, yaw: 0, mirror: false };
  const b2 = c.symmetryCopies(s, { mode: 'mirror', n: 2 });
  assert.equal(b2.length, 2);
  assert.equal(b2[1].parentId, boost.id);
  near(b2[1].x, boost.pos.x - 0.7);
  assert.equal(c.mirrorPartner(boost), null);
  assert.equal(c.mirrorPartner(tank).id, tank.id);
});

test('flipAssembly turns an assembly end for end and twice is the identity', () => {
  const side = new Craft('s'); const [r] = side.setRoot('tank_m100');
  side.attachStack('eng_sparrow', r.id, 'bottom'); side.attachRadial('fin', r.id, -0.2, 0.3, 1, { pitch: 0.2, roll: 0.1 });
  const asm = side.assemblyOf(r.id), orig = JSON.parse(JSON.stringify(asm));
  flipAssembly(asm);
  const eng = asm.parts.find(p => p.type === 'eng_sparrow');
  assert.equal(eng.flip, true); assert.equal(eng.node, 'top'); assert.ok(eng.pos.y > 0);
  assert.equal(asm.parts[0].flip, true);
  flipAssembly(asm);
  for (let i = 0; i < asm.parts.length; i++) {
    const p = asm.parts[i], q = orig.parts[i];
    near(p.pos.x, q.pos.x, 1e-9); near(p.pos.y, q.pos.y, 1e-9); near(p.pos.z, q.pos.z, 1e-9); near(p.rot, q.rot, 1e-9);
    assert.equal(!!p.flip, !!q.flip); assert.equal(p.node, q.node); near(p.roll || 0, q.roll || 0, 1e-9); near(p.pitch || 0, q.pitch || 0, 1e-9);
  }
  const lay = assemblyLayout(orig, { x: 1, y: 2, z: 3, yaw: 0, mirror: true });
  near(lay[0].x, 1); near(lay[0].y, 2);
  const fin = orig.parts.findIndex(p => p.type === 'fin');
  near(lay[fin].roll, -0.1); near(lay[fin].z, 3 - orig.parts[fin].pos.z);
});
