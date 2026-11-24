// Entry trim, Bank hold and the entry predictor (docs/ENTRY.md; part C of docs/REENTRY_SPEC.md). The numbers are
// checked against independent references in tests/verify/checks_entry.mjs (chapter 11); these tests cover how the
// feature behaves as part of the game: which parts offer it, saving, action groups, and that nothing changes when off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../js/core/world.js';
import { Craft } from '../../js/core/craft.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { PARTS } from '../../js/core/parts.js';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { partActions, hasEntryTrim, SAS_MODES, TUNING } from '../../js/core/vessel.js';
import { predictEntry } from '../../js/core/entry.js';
import { runAll } from '../verify/run.mjs';

const home = SYSTEM.home, DEG = Math.PI / 180;
function capsule({ speed = 2300, fpa = 1.5, alt = home.atmo.height - 1 } = {}) {
  const c = new Craft('capsule');
  const s = c.setRoot('heatshield_m')[0];
  c.attachStack('pod_acorn', s.id, 'top'); c.autoStage();
  const w = new World(), r = home.radius + alt, a = fpa * DEG;
  const v = w.spawn(c, { crew: ['Ada'], body: home, pos: new Vector3(r, 0, 0), vel: new Vector3(-speed * Math.sin(a), 0, speed * Math.cos(a)) });
  v.q.setFromUnitVectors(new Vector3(0, 1, 0), v.airDirection(new Vector3()).negate());
  v.w.set(0, 0, 0); v.ctrl.throttle = 0; v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde';
  return { w, v };
}
const angleToAir = v => 180 - new Vector3(0, 1, 0).applyQuaternion(v.q).angleTo(v.airDirection(new Vector3())) / DEG;

test('physics verification, entry: trim against the meshes, Bank hold, the predictor against a second integrator and against flown entries', async () => {
  const S = await runAll({ fast: true, only: ['11'] });
  assert.ok(S.passed.length > 80, `only ${S.passed.length} checks ran`);
  assert.equal(S.failed.length, 0, '\n' + S.failed.map(r => `${r.group} :: ${r.name}: expected ${r.expected}, got ${r.actual}`).join('\n'));
});

test('C2: capsules with a wide base offer Entry trim; other parts do not', () => {
  for (const id of ['pod_acorn', 'pod_hearth']) {
    assert.ok(hasEntryTrim(PARTS[id]), id);
    assert.ok(partActions(PARTS[id]).some(a => a.id === 'entryTrim' && a.label === 'Entry trim'), id + ' lists the action');
  }
  for (const id of ['tank_m400', 'heatshield_m', 'eng_sparrow', 'probe_facet']) assert.ok(!hasEntryTrim(PARTS[id]), id);
  assert.ok(SAS_MODES.includes('bankHold'));
});

test('C6: with Entry trim off nothing is different, and switching it on and off again leaves the vessel as it was', () => {
  const { v } = capsule();
  assert.equal(v.entryTrimOn, false);
  assert.equal(v.com.x, 0); assert.equal(v.com.z, 0);
  const com = v.com.clone(), I = v.inertia.clone(), pos = v.pos.clone();
  assert.equal(v.toggleEntryTrim(), true);
  assert.ok(v.entryTrimOn && Math.abs(v.com.x) > 0.01 && Math.abs(v.com.x) < 0.1, 'the centre of mass moves a few centimetres: ' + v.com.x);
  assert.ok(v.pos.distanceTo(pos) > 0.01, 'the reference point follows the centre of mass, so no part jumps');
  assert.equal(v.toggleEntryTrim(), false);
  assert.ok(v.com.distanceTo(com) === 0 && v.inertia.distanceTo(I) === 0, 'centre of mass and inertia restored exactly');
  assert.ok(v.pos.distanceTo(pos) < 1e-9, 'and the vessel is where it was');
  // a vessel with no capsule has nothing to switch
  const c = new Craft('tank'); c.setRoot('tank_m400'); c.autoStage();
  const t = new World().spawn(c, { body: home, pos: new Vector3(home.radius + 80000, 0, 0), vel: new Vector3(0, 0, 2300) });
  assert.equal(t.toggleEntryTrim(), null);
});

test('C2: the action group action, and trim and bank survive a save', () => {
  const { w, v } = capsule();
  const pod = [...v.parts.values()].find(p => p.def.id === 'pod_acorn');
  assert.equal(v.doAction(pod.id, 'entryTrim', []), true);
  assert.ok(v.entryTrimOn);
  v.ctrl.sasMode = 'bankHold'; v.bank = 40 * DEG;
  const w2 = World.fromJSON(JSON.stringify(w.toJSON())), v2 = w2.getVessel(v.id);
  assert.ok(v2.entryTrimOn, 'trim is on after loading');
  assert.ok(Math.abs(v2.com.x - v.com.x) < 1e-12, 'with the same centre of mass');
  assert.equal(v2.ctrl.sasMode, 'bankHold');
  assert.ok(Math.abs(v2.bank - 40 * DEG) < 1e-12, 'and the commanded bank');
  // an old save has neither field
  const j = w.toJSON(); for (const vs of j.vessels) { delete vs.bank; for (const p of vs.parts) delete p.trim; }
  const v3 = World.fromJSON(JSON.stringify(j)).getVessel(v.id);
  assert.equal(v3.entryTrimOn, false); assert.equal(v3.bank, 0);
});

test('C2, C3: a trimmed capsule under Bank hold rests at the trim angle, and the roll keys turn the commanded bank', () => {
  const { w, v } = capsule({ speed: 2000, fpa: 0, alt: 42000 });
  v.setEntryTrim(true); v.ctrl.sasMode = 'bankHold';
  for (let i = 0; i < 300; i++) w.step(0.05);
  assert.ok(Math.abs(angleToAir(v) - TUNING.TRIM_ANGLE / DEG) < 0.5, 'angle to the air ' + angleToAir(v).toFixed(2));
  const ld = v.liftDrag();
  assert.ok(ld && ld.ld > 0.25 && ld.ld < 0.3, 'lift over drag ' + (ld && ld.ld.toFixed(3)));
  assert.ok(Math.abs(v.bankNow()) < 1 * DEG, 'lift up: bank ' + (v.bankNow() / DEG).toFixed(2));
  v.ctrl.roll = 1;
  for (let i = 0; i < 40; i++) w.step(0.05);                       // two seconds of the roll-right key
  v.ctrl.roll = 0;
  assert.ok(Math.abs(v.bank - 2 * TUNING.BANK_RATE) < 0.02, 'commanded bank ' + (v.bank / DEG).toFixed(1) + ' deg');
  for (let i = 0; i < 200; i++) w.step(0.05);
  assert.ok(Math.abs(v.bankNow() - v.bank) < 1.5 * DEG, 'the lift follows: ' + (v.bankNow() / DEG).toFixed(1) + ' deg');
  // without trim the hold still works: it keeps the present end to the air and holds the roll
  const b = capsule({ speed: 2000, fpa: 0, alt: 42000 });
  b.v.ctrl.sasMode = 'bankHold';
  for (let i = 0; i < 200; i++) b.w.step(0.05);
  assert.ok(angleToAir(b.v) < 0.5 && b.v.w.length() < 0.01, 'untrimmed: shield to the air, at rest');
});

test('C4, C5: the predictor sees a landing, a skip and an orbit, and lift up lowers the peak', () => {
  const { w, v } = capsule();
  const m0 = v.entryModel();
  assert.equal(m0.ld, 0); assert.equal(m0.dragScale, 1);
  const ballistic = predictEntry(home, v.pos, v.vel, w.ut, { ...m0, path: true });
  assert.equal(ballistic.end, 'land');
  assert.ok(ballistic.n > 50 && ballistic.path.length === ballistic.n * 4, 'the path is recorded');
  assert.ok(Math.abs(new Vector3(ballistic.path[0], ballistic.path[1], ballistic.path[2]).length() - home.radius - home.atmo.height) < 50, 'from the top of the air');
  v.setEntryTrim(true); v.ctrl.sasMode = 'bankHold';
  const m1 = v.entryModel();
  assert.ok(m1.ld > 0.25 && m1.ld < 0.3 && m1.dragScale > 0.85 && m1.dragScale < 0.95, JSON.stringify({ ld: m1.ld, k: m1.dragScale }));
  const up = predictEntry(home, v.pos, v.vel, w.ut, m1);
  v.bank = Math.PI;
  const down = predictEntry(home, v.pos, v.vel, w.ut, v.entryModel());
  assert.ok(up.maxG < 0.65 * ballistic.maxG && down.maxG > 1.5 * ballistic.maxG, `peak g up ${up.maxG.toFixed(1)}, ballistic ${ballistic.maxG.toFixed(1)}, down ${down.maxG.toFixed(1)} m/s2`);
  assert.ok(up.t > ballistic.t && down.t < ballistic.t, 'lift up flies longer, lift down shorter');
  // a fast shallow arrival with the lift up skips back out; a path that never meets the air is an orbit
  const fast = capsule({ speed: 3300, fpa: 12 });
  fast.v.setEntryTrim(true); fast.v.ctrl.sasMode = 'bankHold';
  const skip = predictEntry(home, fast.v.pos, fast.v.vel, fast.w.ut, fast.v.entryModel());
  assert.equal(skip.end, 'skip');
  assert.ok(skip.vel.length() > 2000 && skip.pos.length() > home.radius + home.atmo.height - 100, 'it leaves through the top with speed left');
  const high = capsule({ speed: 2250, fpa: 0, alt: 120000 });
  assert.equal(predictEntry(home, high.v.pos, high.v.vel, high.w.ut, high.v.entryModel()).end, 'orbit');
});
