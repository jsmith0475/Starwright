// The Twin-Plane Interstage: fires at both ends, so a staging leaves three pieces and the ring belongs to neither stage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { Vessel } from '../../js/core/vessel.js';
import { Craft } from '../../js/core/craft.js';
import { partDef } from '../../js/core/parts.js';
import { SYSTEM } from '../../js/core/bodies.js';

const home = SYSTEM.home;
function rocket(sep) {
  const c = new Craft('Three Piece');
  const [pod] = c.setRoot('probe_wisp');
  let cur = pod; const ids = {};
  for (const t of ['tank_m400', 'eng_sparrow', sep, 'probe_wisp', 'tank_m800', 'eng_goshawk']) { const [p] = c.attachStack(t, cur.id, 'bottom'); assert.ok(p, 'attach ' + t); ids[t] = p.id; cur = p; }
  c.autoStage();
  return { c, ids };
}
function inSpace(craft) {
  const v = Vessel.fromCraft(craft, { crew: [] });
  v.body = home; v.pos.set(home.radius + 300000, 0, 0); v.vel.set(0, 0, 2000); v.launched = true; v.situation = 'flying';
  v._updateMass && v._updateMass(false);
  return v;
}
/** Fire stages until a separator has fired; returns the pieces dropped. */
function separate(v) {
  const pieces = [];
  for (let i = 0; i < 4 && !pieces.length; i++) for (const e of v.activateNextStage([])) if (e.type === 'decouple') pieces.push(e);
  return pieces;
}
const momentum = vs => vs.reduce((P, x) => P.addScaledVector(x.vel, x.mass), new Vector3());

test('the part exists in two sizes and fires at both ends', () => {
  for (const id of ['inter_m', 'inter_l']) { const d = partDef(id); assert.ok(d && d.decoupler && d.decoupler.both === true, id); }
  assert.ok(!partDef('dec_m').decoupler.both, 'the plain separator still fires at one end');
});

test('staging leaves three pieces: upper stage, first stage, and the ring on its own', () => {
  const { c, ids } = rocket('inter_m'), v = inSpace(c);
  const ev = separate(v);
  assert.equal(ev.length, 2, 'two separations from one staging');
  const [stage, ring] = ev.map(e => e.debris);
  assert.equal(stage.type, 'ship'); assert.ok(stage.parts.has(ids.tank_m800) && stage.parts.has(ids.eng_goshawk));
  assert.ok(!stage.parts.has(ids.inter_m), 'the ring is not on the first stage');
  assert.ok(!v.parts.has(ids.inter_m), 'the ring is not on the upper stage');
  assert.equal(ring.type, 'debris'); assert.equal(ring.parts.size, 1); assert.ok(ring.parts.has(ids.inter_m));
  for (const x of [v, stage]) for (const p of x.parts.values()) assert.ok(!p.links.includes(ids.inter_m), 'no joint to the ring is left');
  assert.equal(ev[1].vessel, stage, 'the second plane is reported from the first stage');
});

test('the plain separator still leaves two pieces, with the ring on the first stage', () => {
  const { c, ids } = rocket('dec_m'), v = inSpace(c);
  const ev = separate(v);
  assert.equal(ev.length, 1);
  assert.ok(ev[0].debris.parts.has(ids.dec_m));
});

test('mass and momentum are shared out exactly, and the ring ends up between the two stages', () => {
  const { c } = rocket('inter_m'), v = inSpace(c);
  const m0 = v.mass, P0 = v.vel.clone().multiplyScalar(m0);
  const [stage, ring] = separate(v).map(e => e.debris);
  assert.ok(Math.abs(v.mass + stage.mass + ring.mass - m0) < 1e-6 * m0, 'mass');
  const P1 = momentum([v, stage, ring]);
  assert.ok(P1.distanceTo(P0) < 1e-9 * P0.length(), `momentum: off by ${P1.distanceTo(P0)}`);
  // along the stack axis (vessel +Y, which is world +Y here) the order is upper stage, ring, first stage
  const ax = new Vector3(0, 1, 0).applyQuaternion(v.q), along = x => x.vel.dot(ax);
  assert.ok(along(v) > along(ring) && along(ring) > along(stage), `speeds along the stack: ${along(v)}, ${along(ring)}, ${along(stage)}`);
  assert.ok(along(v) - along(stage) > 0.3, 'the stages part at a real speed');
});
