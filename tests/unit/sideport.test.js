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
  c.attachRadial('rcs', cur.id, cur.pos.y, Math.PI / 4, 4);
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
  near(Math.abs(sep.clone().normalize().dot(new Vector3(0, 1, 0).applyQuaternion(v.q))), 0, 0.1, 'sideways, not along the stacks');
  assert.equal(v.dockPorts.length + other.dockPorts.length, 2, 'both ports free again');
});

test('side port: crossed stacks do not latch, and a side port does not take a nose ring', () => {
  const { w } = pair({ yaw: 0.6 });
  let n = 0; w.on('dock', () => n++);
  run(w, 12);
  assert.equal(n, 0, '34° between the stacks: no');
  assert.notEqual(partDef('port_side').dock.size, partDef('dock_l').dock.size);
});

// ---- pumping across the line
import { TUNING, propIn } from '../../js/core/vessel.js';
const sumRes = (v, ids, r) => v.partList.filter(p => ids.has(p.id)).reduce((m, p) => m + (p.res[r] || 0), 0);
/** A docked pair; the ship that is not `full` has its two liquids emptied. → { w, v, ports: {full, empty}, sides } */
function docked({ anti = false, fullIs = 'A' } = {}) {
  const { w, a, b } = pair({ anti });
  const ev = []; w.on('dock', d => ev.push(d));
  const empty = fullIs === 'A' ? b : a;
  for (const p of empty.partList) for (const r of ['lox', 'ch4']) if (r in p.res) p.res[r] = 0;
  for (let i = 0; i < 600 && !ev.length; i++) w.step(0.02);
  assert.equal(ev.length, 1);
  const v = ev[0].vessel, ports = v.partList.filter(p => p.type === 'port_side');
  const sideOf = p => v.lineSide(p.id), has = s => sumRes(v, s, 'lox') > 0;
  const pf = has(sideOf(ports[0])) ? ports[0] : ports[1], pe = pf === ports[0] ? ports[1] : ports[0];
  v.w.set(0, 0, 0);
  return { w, v, pf, pe, sf: sideOf(pf), se: sideOf(pe) };
}

test('pump: a docked pair has one propellant line, and the cold liquids cross only through it', () => {
  const { v, pf, sf, se } = docked();
  assert.equal(v.propellantLines.length, 1);
  assert.equal(v.propellantLines[0][2], partDef('port_side').pipe);
  assert.ok(!sf.has([...se][0]) && sf.size > 2 && se.size > 2, 'the two sides are the two ships');
  const tanks = v.partList.filter(p => p.type === 'tank_xxl_ship');
  assert.equal(v.transferResource(tanks[0].id, tanks[1].id, 'lox', 100) + v.transferResource(tanks[1].id, tanks[0].id, 'lox', 100), 0, 'not by the old instant transfer');
  assert.equal(v.startPump(-1).ok, false);
  assert.equal(v.startPump(pf.id).ok, true);
});

test('pump: in free fall with nothing pushing, nothing flows, and the pump gives up', () => {
  const { w, v, pf, se } = docked();
  const ev = []; w.on('pump', d => ev.push(d));
  assert.ok(v.startPump(pf.id, { settle: false }).ok);
  run(w, 5);
  assert.equal(v.pump.state, 'settling'); assert.equal(sumRes(v, se, 'lox'), 0);
  run(w, TUNING.SETTLE_PATIENCE);
  assert.equal(v.pump, null);
  assert.match(v.lastPump.why, /not settled/); assert.equal(v.lastPump.moved, 0);
  assert.equal(ev.length, 1);
});

for (const [anti, fullIs] of [[false, 'A'], [true, 'A'], [true, 'B']]) test(`pump: settled by its own thrusters, the liquids cross at the line's rate (${anti ? 'nose to tail' : 'nose by nose'}, from ${fullIs})`, () => {
  const { w, v, pf, sf, se } = docked({ anti, fullIs });
  const lox0 = sumRes(v, sf, 'lox'), ch40 = sumRes(v, sf, 'ch4'), mono0 = v.partList.reduce((m, p) => m + (p.res.mono || 0), 0), m0 = v.mass;
  assert.ok(v.startPump(pf.id, { amount: 6000 }).ok);
  const flipped = v.partList.find(p => sf.has(p.id) && p.type === 'tank_xxl_ship').flip;
  assert.equal(v.pump.sign, flipped ? -1 : 1, 'the push is toward the source tank\'s own aft end');
  run(w, 3);
  assert.equal(v.pump.state, 'pumping');
  assert.ok(v.pump.sign * v.axialAccel >= TUNING.SETTLE_ACCEL && Math.abs(v.axialAccel) < 3 * TUNING.SETTLE_ACCEL, 'a gentle push: ' + v.axialAccel);
  const t0 = w.ut, at0 = v.pump.moved;
  run(w, 10);
  near((v.pump.moved - at0) / (w.ut - t0), partDef('port_side').pipe, 1, 'kg/s');
  run(w, 12);
  assert.equal(v.pump, null); assert.equal(v.lastPump.why, 'done');
  near(sumRes(v, se, 'lox') + sumRes(v, se, 'ch4'), 6000, 1e-3, 'what was asked for');
  near(sumRes(v, se, 'lox') / sumRes(v, se, 'ch4'), lox0 / ch40, 1e-6, 'in the proportion the source held them');
  near(sumRes(v, sf, 'lox') + sumRes(v, se, 'lox'), lox0, 1e-6, 'none lost');
  const mono = mono0 - v.partList.reduce((m, p) => m + (p.res.mono || 0), 0);
  assert.ok(mono > 0 && mono < 20, 'settling cost a little monopropellant: ' + mono.toFixed(2) + ' kg');
  near(v.mass, m0 - mono, 1e-3, 'mass');
});

test('pump: undocking cuts the line', () => {
  const { w, v, pf } = docked();
  assert.ok(v.startPump(pf.id).ok);
  run(w, 4);
  assert.ok(w.undock(v, pf.id));
  run(w, 0.1);
  assert.equal(v.pump, null);
});
