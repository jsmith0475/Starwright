// Side docking (docs/SHEARWATER.md, step 3): two ships that each carry a Flank Port dock side by side, stacks parallel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Quaternion } from '../../js/lib/three.module.min.js';
import { World, DOCKING } from '../../js/core/world.js';
import { Craft } from '../../js/core/craft.js';
import { Orbit } from '../../js/core/orbit.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { partDef } from '../../js/core/parts.js';

const home = SYSTEM.home;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || 'value'}: ${a} vs ${b} (tol ${tol})`);
const R = 2.8125, RW = partDef('port_side').rw;
/** A ship's upper half: nose, bay, tank, and a Flank Port on the tank at `angle`. */
function ship(name, angle = Math.PI * 3 / 2) {
  const c = new Craft(name);
  const [pod] = c.setRoot('pod_shearwater');
  let cur = pod;
  for (const t of ['bay_shearwater', 'tank_xxl_ship']) cur = c.attachStack(t, cur.id, 'bottom')[0];
  assert.equal(c.attachRadial('port_side', cur.id, cur.pos.y + 2, angle, 1).length, 1);
  c.autoStage();
  return c;
}
function orbitState(alt) { const o = Orbit.fromElements({ a: home.radius + alt, e: 0 }, home.gm, 0); return o.stateAt(0); }
/** A and B in orbit, port faces `dist` apart and looking at each other; `anti` turns B nose to tail. */
function pair({ dist = 0.5, closing = 0.1, anti = false, yaw = 0, angleB = Math.PI * 3 / 2 } = {}) {
  const w = new World(), s = orbitState(90000);
  const a = w.spawn(ship('A'), { crew: ['Ada'], pos: s.r, vel: s.v });
  const b = w.spawn(ship('B', angleB), { crew: [], pos: s.r.clone().add(new Vector3(0, 0, 40)), vel: s.v, makeActive: false });
  a.w.set(0, 0, 0); b.w.set(0, 0, 0);
  const pa = a.dockPorts[0], pb = b.dockPorts[0];
  assert.ok(pa && pb, 'each has a free side port');
  // turn B so that its port looks back along A's: about the stack axis, and end over end for nose to tail
  const na = a.portAxisLocal(pa, new Vector3()), nb = b.portAxisLocal(pb, new Vector3());
  let qb = new Quaternion();
  if (anti) qb.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
  const nbT = nb.clone().applyQuaternion(qb);
  const spin = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.atan2(-(-na.z), -na.x) - Math.atan2(-nbT.z, nbT.x));
  qb = spin.multiply(qb);
  if (yaw) qb.premultiply(new Quaternion().setFromAxisAngle(na, yaw));
  b.q.copy(a.q).multiply(qb);
  const PA = new Vector3(), NA = new Vector3(), PB = new Vector3(), NB = new Vector3();
  a.portWorld(pa, PA, NA); b.portWorld(pb, PB, NB);
  b.pos.add(PA.clone().addScaledVector(NA, dist).sub(PB));
  b.vel.copy(a.vel).addScaledVector(NA, -closing);
  b.portWorld(pb, PB, NB);
  return { w, a, b, pa, pb, cos: -NA.dot(NB), gap: PA.distanceTo(PB) };
}
const run = (w, t) => { for (let i = 0; i < t / 0.02; i++) w.step(0.02); };

test('side port: the face looks straight out of the hull, a port width proud of it', () => {
  const { a, pa, cos, gap } = pair();
  const f = a.portLocal(pa, new Vector3()), n = a.portAxisLocal(pa, new Vector3());
  near(Math.hypot(f.x, f.z), R + RW, 1e-6, 'face radius');
  near(n.y, 0, 1e-9); near(n.length(), 1, 1e-9);
  near(f.clone().setY(0).normalize().dot(n), 1, 1e-9, 'outward');
  near(cos, 1, 1e-6, 'the test pair starts face to face'); near(gap, 0.5, 1e-6);
});

for (const anti of [false, true]) test(`side port: two ships dock side by side, ${anti ? 'nose to tail' : 'nose by nose'}`, () => {
  const { w, a, b } = pair({ anti });
  const m = a.mass + b.mass, p0 = new Vector3();
  const ev = []; w.on('dock', d => ev.push(d));
  for (let i = 0; i < 600 && !ev.length; i++) { p0.copy(a.vel).multiplyScalar(a.mass).addScaledVector(b.vel, b.mass); w.step(0.02); }
  assert.equal(ev.length, 1, 'they latch');
  const v = ev[0].vessel;
  assert.ok(b.dead || a.dead);
  near(v.mass, m, 1e-6, 'mass');
  near(v.vel.clone().multiplyScalar(v.mass).sub(p0).length() / m, 0, 0.2, 'momentum (one step of gravity aside)');
  const pods = v.partList.filter(p => p.type === 'pod_shearwater');
  assert.equal(pods.length, 2);
  near(Math.hypot(pods[0].pos.x - pods[1].pos.x, pods[0].pos.z - pods[1].pos.z), 2 * (R + RW), 1e-6, 'the two axes stand two hull radii and two ports apart');
  assert.equal(pods[0].flip !== pods[1].flip, anti, anti ? 'one is upside down' : 'both the same way up');
  const ports = v.partList.filter(p => p.type === 'port_side');
  near(ports[0].pos.distanceTo(ports[1].pos), RW, 1e-6, 'the ports meet face to face');
  assert.equal(v.dockPorts.length, 0, 'and neither is free');
  // and apart again
  const other = w.undock(v, ports[0].id);
  assert.ok(other, 'undock gives two vessels');
  near(v.mass + other.mass, m, 1e-6);
  const sep = other.vel.clone().sub(v.vel);
  near(sep.length(), DOCKING.UNDOCK_SPEED, 0.01, 'pushed apart');
  near(Math.abs(sep.clone().normalize().dot(new Vector3(0, 1, 0).applyQuaternion(v.q))), 0, 0.02, 'sideways, not along the stacks');
  assert.equal(v.dockPorts.length + other.dockPorts.length, 2, 'both ports free again');
});

test('side port: crossed stacks do not latch, and a side port does not take a nose ring', () => {
  const { w } = pair({ yaw: 0.6 });
  let n = 0; w.on('dock', () => n++);
  run(w, 12);
  assert.equal(n, 0, '34° between the stacks: no');
  assert.notEqual(partDef('port_side').dock.size, partDef('dock_l').dock.size);
});
