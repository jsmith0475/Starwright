// Craft are solid to each other (js/core/contact.js): a gentle touch pushes them apart with momentum kept, a hard
// one breaks them, docking still latches, and pieces that start out together are left alone while they part.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Quaternion } from '../../js/lib/three.module.min.js';
import { World } from '../../js/core/world.js';
import { Craft } from '../../js/core/craft.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { CONTACT } from '../../js/core/contact.js';

const home = SYSTEM.home;
/** Two capsules in a circular orbit 300 km up, `gap` m apart along the orbit, closing at `speed` m/s. */
function pair(gap, speed, { tank = false } = {}) {
  const w = new World(), r = home.radius + 300e3, vc = Math.sqrt(home.gm / r);
  const make = name => { const c = new Craft(name); const [pod] = c.setRoot('pod_acorn'); if (tank) c.attachStack('tank_m400', pod.id, 'bottom'); c.autoStage(); return c; };
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);     // lying along the orbit
  const a = w.spawn(make('Ash'), { crew: ['Ada'], body: home, pos: new Vector3(r, 0, -gap / 2), vel: new Vector3(0, 0, -vc + speed / 2), q });
  const b = w.spawn(make('Birch'), { crew: ['Bo'], body: home, pos: new Vector3(r, 0, gap / 2), vel: new Vector3(0, 0, -vc - speed / 2), q });
  const log = [];
  w.on('*', (d, type) => log.push({ type, ...d }));
  return { w, a, b, log };
}
const run = (w, s) => { for (let t = 0; t < s; t += 0.02) w.step(0.02); };

test('two capsules that meet at 2 m/s bounce apart, keep their momentum and are not hurt', () => {
  const { w, a, b, log } = pair(8, 2);
  run(w, 8);
  // the same two, passing through each other: gravity turns their momentum alike, the touch must not change it
  CONTACT.solid = false;
  const ref = pair(8, 2);
  try { run(ref.w, 8); } finally { CONTACT.solid = true; }
  const p0 = ref.a.vel.clone().multiplyScalar(ref.a.mass).add(ref.b.vel.clone().multiplyScalar(ref.b.mass));
  assert.ok(!a.dead && !b.dead);
  assert.ok(log.some(e => e.type === 'vesselStrike' && !e.lost && e.broken === 0), 'the touch is felt');
  const closing = b.vel.clone().sub(a.vel).dot(new Vector3(0, 0, 1));
  assert.ok(closing > 0.1 && closing < 1, 'they part at a little of the speed they met at: ' + closing.toFixed(2));
  const p1 = a.vel.clone().multiplyScalar(a.mass).add(b.vel.clone().multiplyScalar(b.mass));
  assert.ok(p1.distanceTo(p0) / p0.length() < 1e-6, 'momentum kept: ' + (p1.distanceTo(p0) / p0.length()).toExponential(2));
  assert.ok(a.pos.distanceTo(b.pos) > 2.5, 'apart, not through each other');
});

test('at 60 m/s they are both lost, and switched off they pass through each other', () => {
  const hard = pair(20, 60);
  run(hard.w, 2);
  assert.ok(hard.a.dead && hard.b.dead);
  assert.ok(hard.log.some(e => e.type === 'destroyed' && e.reason === 'collision'));
  CONTACT.solid = false;
  try {
    const ghost = pair(20, 60);
    run(ghost.w, 2);
    assert.ok(!ghost.a.dead && !ghost.b.dead);
  } finally { CONTACT.solid = true; }
});

test('two craft placed touching are left alone until they have parted', () => {
  const { w, a, b, log } = pair(1.0, -0.5, { tank: true });       // overlapping at the start, drifting apart
  run(w, 6);
  assert.ok(!log.some(e => e.type === 'vesselStrike'));
  assert.ok(!a.dead && !b.dead);
});
