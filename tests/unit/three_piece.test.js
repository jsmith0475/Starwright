// A stack separator fires at both ends, so a staging leaves three pieces and the ring belongs to neither stage.
// The second plane fires half a second after the first and throws the ring off sideways. A radial clamp fires at one
// end and stays on what it drops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { Vessel, TUNING } from '../../js/core/vessel.js';
import { World } from '../../js/core/world.js';
import { Craft } from '../../js/core/craft.js';
import { SYSTEM } from '../../js/core/bodies.js';

const home = SYSTEM.home;
function rocket(sep = 'dec_m', lower = ['probe_wisp', 'tank_m800', 'eng_goshawk']) {
  const c = new Craft('Three Piece');
  const [pod] = c.setRoot('probe_wisp');
  let cur = pod; const ids = {};
  for (const t of ['tank_m400', 'eng_sparrow', sep, ...lower]) { const [p] = c.attachStack(t, cur.id, 'bottom'); assert.ok(p, 'attach ' + t); ids[t] = p.id; cur = p; }
  c.autoStage();
  return { c, ids };
}
/** In a high orbit (no air), staged until a separator has fired. */
function staged(craft) {
  const w = new World(), r = home.radius + 300000;
  const v = w.spawn(craft, { crew: [], pos: new Vector3(r, 0, 0), vel: new Vector3(0, 0, Math.sqrt(home.gm / r)) });
  const m0 = v.mass;
  for (let i = 0; i < 4 && w.vessels.length === 1; i++) w.stage(v);
  v.ctrl.throttle = 0;
  return { w, v, m0 };
}
const momentum = vs => vs.reduce((P, x) => P.addScaledVector(x.vel, x.mass), new Vector3());

test('staging leaves two pieces at first, and the ring leaves the dropped stage half a second later', () => {
  const { c, ids } = rocket(), { w, v } = staged(c);
  assert.equal(w.vessels.length, 2);
  const stage = w.vessels[1];
  assert.ok(stage.parts.has(ids.dec_m), 'the ring rides on the dropped stage until its second plane fires');
  assert.ok(!v.parts.has(ids.dec_m), 'and is already off the upper stage');
  let t = 0; while (w.vessels.length === 2 && t < 2) { w.step(0.02); t += 0.02; }
  assert.ok(Math.abs(t - TUNING.RING_DELAY) < 0.03, `second plane after ${t.toFixed(2)} s`);
  assert.equal(w.vessels.length, 3);
  const ring = w.vessels[2];
  assert.equal(stage.type, 'ship'); assert.ok(stage.parts.has(ids.tank_m800) && stage.parts.has(ids.eng_goshawk));
  assert.ok(!stage.parts.has(ids.dec_m), 'the ring is not on the first stage');
  assert.equal(ring.type, 'debris'); assert.equal(ring.parts.size, 1); assert.ok(ring.parts.has(ids.dec_m));
  assert.equal(ring.name, 'Three Piece interstage');
  assert.ok(ring.parts.get(ids.dec_m).truss, 'the lattice round the upper engine goes with the ring');
  for (const x of [v, stage]) for (const p of x.parts.values()) assert.ok(!p.links.includes(ids.dec_m), 'no joint to the ring is left');
  assert.equal(stage.ringDue, null);
});

test('mass and momentum are shared out exactly among the three, and the ring leaves sideways', () => {
  const { c } = rocket(), { w, v, m0 } = staged(c);
  const stage = w.vessels[1];
  for (let i = 0; i < 24; i++) w.step(0.02);                  // up to the step before the second plane
  assert.equal(w.vessels.length, 2);
  const P0 = momentum([v, stage]), vs = stage.vel.clone(), ms = stage.mass;
  w.step(0.02);
  assert.equal(w.vessels.length, 3);
  const ring = w.vessels[2];
  assert.ok(Math.abs(v.mass + stage.mass + ring.mass - m0) < 1e-6 * m0, 'mass');
  assert.ok(Math.abs(stage.mass + ring.mass - ms) < 1e-9 * ms, 'the stage lost exactly the ring');
  // one 0.02 s step of gravity acts on all three alike; take it out by comparing the momentum the second plane added
  const g = home.gm / v.pos.lengthSq() * 0.02, P1 = momentum([v, stage, ring]);
  assert.ok(P1.distanceTo(P0) < 1.5 * g * m0, 'momentum: only gravity changed it');
  const ax = new Vector3(0, 1, 0).applyQuaternion(stage.q), rel = ring.vel.clone().sub(stage.vel);
  const along = rel.dot(ax), side = rel.clone().addScaledVector(ax, -along).length();
  // (the dropped stage tumbles slightly, and its top moves with it: a few cm/s either way)
  assert.ok(Math.abs(side - TUNING.RING_KICK) < 0.3, `sideways at ${side.toFixed(2)} m/s`);
  assert.ok(Math.abs(along - TUNING.RING_LIFT) < 0.3, `off the top of the stage at ${along.toFixed(2)} m/s`);
  assert.ok(stage.vel.distanceTo(vs) < 1, 'the stage is barely moved by it');
});

test('every size of stack separator does it; a ring with nothing below it is simply dropped; a pending ring survives a save', () => {
  for (const [sep, lower] of [['sep_m', ['tank_m200']], ['dec_s', ['tank_s100']], ['sep_s', ['tank_s100']]]) {
    const c = new Craft('T'); const [pod] = c.setRoot('probe_wisp'); let cur = pod, id = null;
    for (const t of [...(sep.endsWith('_s') ? ['adapter_ms'] : []), sep, ...lower]) { const [p] = c.attachStack(t, cur.id, 'bottom'); assert.ok(p, 'attach ' + t); if (t === sep) id = p.id; cur = p; }
    c.autoStage();
    const { w } = staged(c);
    for (let i = 0; i < 40; i++) w.step(0.02);
    assert.equal(w.vessels.length, 3, sep); assert.ok(w.vessels[2].parts.has(id) && w.vessels[2].parts.size === 1, sep);
  }
  { const c = new Craft('T'); const [pod] = c.setRoot('probe_wisp'); c.attachStack('dec_m', pod.id, 'bottom'); c.autoStage();
    const { w } = staged(c);
    for (let i = 0; i < 40; i++) w.step(0.02);
    assert.equal(w.vessels.length, 2, 'a bare ring is one piece'); assert.equal(w.vessels[1].ringDue, null); }
  { const { c, ids } = rocket(), { w } = staged(c);
    for (let i = 0; i < 10; i++) w.step(0.02);
    const back = Vessel.fromJSON(JSON.parse(JSON.stringify(w.vessels[1].toJSON())));
    assert.equal(back.ringDue.id, ids.dec_m); assert.ok(Math.abs(back.ringDue.t - 0.3) < 0.03); }
});

test('a lone ring is hollow to the air: it shows its rim, not a disc', () => {
  const { c, ids } = rocket(), { w } = staged(c);
  for (let i = 0; i < 40; i++) w.step(0.02);
  const p = w.vessels[2].parts.get(ids.dec_m), r = 0.625, rim = Math.PI * r * r * (1 - TUNING.RING_BORE ** 2);
  assert.ok(p._aUp > 0 && p._aUp <= rim + 1e-9 && p._aDown <= rim + 1e-9, `${p._aUp} and ${p._aDown} m² against a rim of ${rim.toFixed(3)} m²`);
});
