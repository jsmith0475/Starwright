// Round 2: public accessors, targeting, closest approach, docking / undocking, resource transfer, rendezvous guidance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Quaternion } from '../../js/lib/three.module.min.js';
import { World, DOCKING, LOAD_RANGE } from '../../js/core/world.js';
import { Vessel, SAS_MODES } from '../../js/core/vessel.js';
import { Craft, stockCrafts } from '../../js/core/craft.js';
import { Orbit } from '../../js/core/orbit.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { PARTS, partDef } from '../../js/core/parts.js';
import { closestApproach } from '../../js/core/trajectory.js';
import * as AP from '../../js/core/autopilot.js';

const home = SYSTEM.home, pell = SYSTEM.byId.pell;
const stock = name => stockCrafts().find(c => c.name === name);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || 'value'}: ${a} vs ${b} (tol ${tol})`);
const FLIP_X = new Quaternion(1, 0, 0, 0);
const noseOf = v => new Vector3(0, 1, 0).applyQuaternion(v.q);

/** Crewed ship: Latch Ring on the nose, RCS, one engine stage. */
function ship(name = 'Ship', port = 'dock_s') {
  const c = new Craft(name);
  const [pod] = c.setRoot('pod_acorn');
  c.attachStack(port, pod.id, 'top');
  let cur = pod;
  for (const t of ['tank_mono', 'tank_m400', 'eng_sparrow']) cur = c.attachStack(t, cur.id, 'bottom')[0];
  const tank = c.parts.find(p => p.type === 'tank_m400');
  c.attachRadial('rcs', tank.id, tank.pos.y, Math.PI / 4, 4);
  c.autoStage();
  return c;
}
/** Uncrewed module: probe core, battery, tank, port on top (and optionally one on the bottom). */
function module_(name = 'Module', port = 'dock_s', { bottomPort = false, engine = false } = {}) {
  const c = new Craft(name);
  const [core] = c.setRoot('probe_wisp');
  const [ad] = port === 'dock_s' ? c.attachStack('adapter_ms', core.id, 'top') : [core];
  c.attachStack(port, ad.id, 'top');
  let cur = core;
  for (const t of ['battery', 'tank_m200']) cur = c.attachStack(t, cur.id, 'bottom')[0];
  if (engine) cur = c.attachStack('eng_sparrow', cur.id, 'bottom')[0];
  if (bottomPort) c.attachStack('dock_m', cur.id, 'bottom');
  c.autoStage();
  return c;
}
function orbitState(alt, nu = 0, body = home) {
  const o = Orbit.fromElements({ a: body.radius + alt, e: 0 }, body.gm, 0);
  return o.stateAt(o.timeAtTrueAnomaly(nu, 0));
}
/** Two vessels in orbit, B placed so that its port face is `dist` metres in front of A's port, nose to nose. */
function pair({ dist = 5, closing = 0, tilt = 0, side = 0, portA = 'dock_s', portB = 'dock_s', bCraft = null, active = 'a' } = {}) {
  const w = new World();
  const s = orbitState(90000);
  const a = w.spawn(ship('Chaser', portA), { crew: ['Ada'], pos: s.r, vel: s.v });
  const b = w.spawn(bCraft || module_('Station', portB), { crew: [], pos: s.r.clone().addScaledVector(noseOf(a), 20), vel: s.v, makeActive: false });
  b.q.copy(a.q).multiply(FLIP_X);
  if (tilt) b.q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), tilt));
  const pa = a.dockPorts[0], pb = b.dockPorts[0];
  const PA = new Vector3(), NA = new Vector3(), PB = new Vector3();
  a.portWorld(pa, PA, NA); b.portWorld(pb, PB);
  const want = PA.clone().addScaledVector(NA, dist).addScaledVector(new Vector3(1, 0, 0).applyQuaternion(a.q), side);
  b.pos.add(want.sub(PB));
  b.vel.copy(a.vel).addScaledVector(NA, -closing);
  a.ctrl.sas = false; b.ctrl.sas = false;
  if (active === 'b') w.switchTo(b);
  const log = [];
  w.on('*', (d, type) => log.push({ type, ...d }));
  return { w, a, b, pa, pb, log, of: t => log.filter(e => e.type === t) };
}
const run = (w, seconds, dt = 0.02) => { for (let t = 0; t < seconds - 1e-9; t += dt) w.step(dt); };
function portGap(a, pa, b, pb) { return a.portWorld(pa).distanceTo(b.portWorld(pb)); }
function momentum(...vs) { const p = new Vector3(); for (const v of vs) p.addScaledVector(v.vel, v.mass); return p; }

// ---------------------------------------------------------------------------------------------------------
test('docking parts: Latch Rings are in the catalogue and the stock docking crafts are sound', () => {
  assert.equal(PARTS.dock_m.name, 'Latch Ring M');
  assert.equal(PARTS.dock_s.name, 'Latch Ring S');
  assert.deepEqual([PARTS.dock_m.tech, PARTS.dock_s.tech, PARTS.dock_m.shape, PARTS.dock_s.shape], ['command2', 'miniature', 'dock', 'dock']);
  assert.deepEqual([PARTS.dock_m.dock.size, PARTS.dock_s.dock.size], ['M', 'S']);
  for (const n of ['Latch Target', 'Latch Chaser']) {
    const c = stock(n);
    assert.ok(c, n);
    assert.deepEqual(c.validate(), { ok: true, errors: [], warnings: [] }, n);
    const v = Vessel.fromCraft(c, { crew: ['Ada'] });
    assert.equal(v.dockPorts.length, 1, n + ' has one free port');
    assert.equal(v.dockPorts[0]._face, 1, 'on the nose');
  }
  const chaser = stock('Latch Chaser');
  assert.ok(chaser.parts.some(p => p.type === 'tank_mono') && chaser.parts.filter(p => p.type === 'rcs').length === 4);
  assert.ok(chaser.deltaV().vac > 4300, 'chaser dv ' + chaser.deltaV().vac);
  // a port buried inside a stack does not work; one hanging at the bottom faces down
  const c = new Craft('x');
  const [core] = c.setRoot('probe_wisp');
  const [mid] = c.attachStack('dock_m', core.id, 'bottom');
  const [tank] = c.attachStack('tank_m100', mid.id, 'bottom');
  c.attachStack('dock_m', tank.id, 'bottom');
  const v = Vessel.fromCraft(c);
  assert.equal(v.dockPorts.length, 1);
  assert.equal(v.dockPorts[0]._face, -1);
  assert.equal(v.parts.get(mid.id)._face, 0);
});

test('public accessors mirror the private caches', () => {
  const w = new World();
  const v = w.launch(stock('Pell Runner'), { crew: ['Ada'] });
  assert.equal(v.engines, v._engines);
  assert.equal(v.engines.length, 3);
  assert.ok(v.engines[0].part.def.engine && Array.isArray(v.engines[0].tanks));
  assert.equal(v.legParts, v._legs); assert.equal(v.legParts.length, 4);
  assert.equal(v.solarParts, v._solar); assert.equal(v.solarParts.length, 2);
  assert.equal(v.rcsParts, v._rcs);
  assert.equal(v.commandParts, v._commands); assert.equal(v.commandParts[0].def.id, 'pod_acorn');
  assert.equal(v.chuteParts.length, 1);
  assert.equal(v.partList.length, v.parts.size);
  assert.equal(v.boundRadius, v._bound); assert.equal(v.baseRadius, v._baseR); assert.equal(v.baseHeight, v._baseH);
  assert.equal(v.isHot, false);
  assert.equal(v.motionStamp, v._stamp);
  // the structure stamp only changes when the part set changes
  const s0 = v.structureStamp;
  v.ctrl.throttle = 1;
  for (let i = 0; i < 20; i++) w.step(0.05);
  assert.equal(v.structureStamp, s0, 'no change while nothing separates');
  w.stage();
  for (let i = 0; i < 20; i++) w.step(0.05);
  assert.equal(v.structureStamp, s0, 'igniting an engine does not change the structure');
  v.ctrl.throttle = 0;
  w.stage();                                             // drops the lifter
  assert.ok(v.structureStamp > s0, 'decoupling changes it');
  // removeVessel
  const debris = w.vessels.find(x => x !== v);
  assert.ok(debris);
  assert.equal(w.removeVessel(debris), true);
  assert.ok(!w.vessels.includes(debris));
  assert.equal(w.removeVessel(debris), false);
  assert.equal(w.active, v);
  assert.equal(w.removeVessel(v), true);
  assert.equal(w.active, null);
});

// ---------------------------------------------------------------------------------------------------------
test('closestApproach: analytic circular cases', () => {
  const gm = home.gm;
  const r1 = home.radius + 100000, r2 = home.radius + 250000;
  const n1 = Math.sqrt(gm / r1 ** 3), n2 = Math.sqrt(gm / r2 ** 3);
  const phase = 0.4;                                      // B starts 0.4 rad ahead of A; A is lower and faster
  const A = Orbit.fromElements({ a: r1, e: 0, M0: 0 }, gm, 0);
  const B = Orbit.fromElements({ a: r2, e: 0, M0: phase }, gm, 0);
  assert.ok(Math.abs(A.posAt(0).angleTo(B.posAt(0)) - phase) < 1e-9);
  const tExpected = phase / (n1 - n2);
  const ca = closestApproach(A, B, 0, 2 * tExpected);
  near(ca.t, tExpected, 0.05, 'time of closest approach');
  near(ca.distance, r2 - r1, 0.5, 'distance = difference of radii');
  near(ca.relSpeed, Math.sqrt(gm / r1) - Math.sqrt(gm / r2), 1e-3, 'relative speed = difference of circular speeds');
  // the window matters: before the pass, the end of the window is the closest point
  const early = closestApproach(A, B, 0, 0.5 * tExpected);
  near(early.t, 0.5 * tExpected, 1e-6, 'clamped to the window');
  assert.ok(early.distance > ca.distance);
  // same orbit, fixed phase: the separation never changes
  const C = Orbit.fromElements({ a: r1, e: 0, M0: 0.01 }, gm, 0);
  const same = closestApproach(A, C, 0, A.period);
  near(same.distance, 2 * r1 * Math.sin(0.005), 0.5, 'chord');
  near(same.relSpeed, 2 * Math.sqrt(gm / r1) * Math.sin(0.005), 1e-3, 'relative speed on the same orbit');
  // several passes in a long window: still the global minimum, and a degenerate window works
  const long = closestApproach(A, B, 0, 6 * tExpected);
  near(long.distance, r2 - r1, 0.5, 'long window');
  assert.equal(closestApproach(A, B, 100, 100).t, 100);
  // crossing orbits with a timed collision: an inclined copy of A meets it at the node
  const D = Orbit.fromElements({ a: r1, e: 0, i: 30, M0: 0 }, gm, 0);
  const hit = closestApproach(A, D, 100, A.period + 100);
  assert.ok(hit.distance < 1, 'meet at the node: ' + hit.distance);
  near(hit.relSpeed, 2 * Math.sqrt(gm / r1) * Math.sin(15 * Math.PI / 180), 0.01, 'crossing speed');
});

// ---------------------------------------------------------------------------------------------------------
test('targeting: setTarget / getTarget / targetInfo for vessels and bodies', () => {
  const w = new World();
  const s = orbitState(90000), s2 = orbitState(90000, 0.002);
  const a = w.spawn(ship('A'), { crew: ['Ada'], pos: s.r, vel: s.v });
  const b = w.spawn(module_('B'), { pos: s2.r, vel: s2.v.clone().add(new Vector3(0, 3, 0)), makeActive: false });
  const events = [];
  w.on('target', d => events.push(d));
  assert.equal(a.targetInfo, null);
  assert.equal(w.getTarget(a), null);
  assert.equal(w.setTarget(a, a), false, 'cannot target itself');
  assert.equal(w.setTarget(a, 999), false);
  assert.equal(w.setTarget(a, 'nowhere'), false);
  assert.equal(w.setTarget(a, b), true);
  assert.equal(a.targetId, b.id);
  assert.equal(w.getTarget(a), b);
  assert.equal(events.at(-1).target, b);
  let ti = a.targetInfo;
  assert.equal(ti.name, 'B'); assert.equal(ti.kind, 'vessel');
  near(ti.distance, s.r.distanceTo(s2.r), 1e-6, 'distance');
  assert.ok(ti.dir.distanceTo(s2.r.clone().sub(s.r).normalize()) < 1e-9, 'unit direction to the target');
  assert.ok(ti.relVel.distanceTo(a.vel.clone().sub(b.vel)) < 1e-9, 'relVel = own velocity − target velocity');
  near(ti.relSpeed, ti.relVel.length(), 1e-12);
  near(ti.closing, ti.relVel.dot(ti.dir), 1e-12);
  // refreshed every step
  const d0 = ti.distance;
  b.vel.addScaledVector(ti.dir, 4);                      // target receding at 4 m/s
  run(w, 2);
  assert.equal(a.targetInfo, ti, 'same object, updated in place');
  assert.ok(ti.distance - d0 > 6, 'distance changed');
  near(ti.distance, a.pos.distanceTo(b.pos), 1e-6);
  near(ti.closing, -4, 0.2, 'closing speed is negative while the target recedes');
  near(ti.relSpeed, a.vel.distanceTo(b.vel), 1e-9, 'relative speed');
  // by id, bodies
  assert.equal(w.setTarget(a, b.id), true);
  assert.equal(w.setTarget(a, pell), true);
  assert.equal(a.targetId, 'pell');
  assert.equal(w.getTarget(a), pell);
  ti = a.targetInfo;
  assert.equal(ti.kind, 'body'); assert.equal(ti.name, 'Pell');
  near(ti.distance, pell.posAt(w.ut).sub(a.pos).length(), 1e-3, 'distance to the moon centre');
  assert.ok(ti.relVel.distanceTo(a.vel.clone().sub(pell.velAt(w.ut))) < 1e-6);
  assert.equal(w.setTarget(a, 'helion'), true);
  near(a.targetInfo.distance, home.globalPosAt(w.ut).add(a.pos).length(), 1, 'distance to the star');
  assert.equal(w.setTarget(a, home), true);
  near(a.targetInfo.distance, a.pos.length(), 1e-6, 'own body');
  // survives save / load
  w.setTarget(a, b);
  const w2 = World.fromJSON(JSON.parse(JSON.stringify(w.toJSON())));
  const a2 = w2.getVessel(a.id);
  assert.equal(w2.getTarget(a2), w2.getVessel(b.id));
  w2.step(0.02);
  assert.equal(a2.targetInfo.name, 'B');
  // clearing, and losing the target
  assert.equal(w.setTarget(a, null), true);
  assert.equal(a.targetId, null); assert.equal(a.targetInfo, null);
  assert.equal(events.at(-1).target, null);
  w.setTarget(a, b);
  const msgs = [];
  w.on('message', d => msgs.push(d.text));
  w.removeVessel(b);
  w.step(0.02);
  assert.equal(a.targetId, null); assert.equal(a.targetInfo, null);
  assert.deepEqual(msgs, ['Target lost']);
});

test('SAS target modes: target, antiTarget, relPrograde, relRetrograde', () => {
  for (const m of ['target', 'antiTarget', 'relPrograde', 'relRetrograde']) assert.ok(SAS_MODES.includes(m), m);
  const w = new World();
  const s = orbitState(90000);
  const a = w.spawn(ship('A'), { crew: ['Ada'], pos: s.r, vel: s.v });
  // 400 m away, off to the side and above; drifting at 2 m/s across
  const off = new Vector3(120, 300, -230);
  const b = w.spawn(module_('B'), { pos: s.r.clone().add(off), vel: s.v.clone().add(new Vector3(0, -2, 0)), makeActive: false });
  w.setTarget(a, b);
  a.ctrl.sas = true;
  const settle = mode => { a.ctrl.sasMode = mode; run(w, 30, 0.05); return noseOf(a); };
  assert.ok(settle('target').angleTo(a.targetInfo.dir) < 0.03, 'nose on the target');
  assert.ok(settle('antiTarget').angleTo(a.targetInfo.dir.clone().negate()) < 0.03, 'tail on the target');
  const rel = () => a.vel.clone().sub(b.vel).normalize();
  assert.ok(settle('relPrograde').angleTo(rel()) < 0.03, 'nose along the relative velocity');
  assert.ok(Math.abs(rel().y - 1) < 0.05, 'which here is mostly +Y');
  assert.ok(settle('relRetrograde').angleTo(rel().negate()) < 0.03, 'nose against the relative velocity');
  // far away (unloaded, on rails, other side of the planet): direction still works
  const far = orbitState(300000, 2.5);
  const c = w.spawn(module_('Far'), { pos: far.r, vel: far.v, makeActive: false });
  w.setTarget(a, c);
  a.ctrl.sasMode = 'target';
  run(w, 30, 0.05);
  assert.ok(c.onRails, 'the far target rides on rails');
  assert.ok(a.targetInfo.distance > LOAD_RANGE * 100);
  assert.ok(noseOf(a).angleTo(c.pos.clone().sub(a.pos).normalize()) < 0.03, 'pointing at a far target');
  assert.ok(noseOf(a).angleTo(a.targetInfo.dir) < 0.03);
  // a body target: point at the moon
  w.setTarget(a, pell);
  run(w, 30, 0.05);
  assert.ok(noseOf(a).angleTo(pell.posAt(w.ut).sub(a.pos).normalize()) < 0.03, 'pointing at Pell');
  // without a target the mode degrades to attitude hold (no NaN, no spin-up)
  w.setTarget(a, null);
  run(w, 5, 0.05);
  assert.ok(a.w.length() < 0.01);
});

// ---------------------------------------------------------------------------------------------------------
test('docking capture conditions', () => {
  // inside the capture distance, slow, aligned → latches on the next step
  let p = pair({ dist: 0.2 });
  p.w.step(0.02);
  assert.equal(p.of('dock').length, 1, 'docked');
  assert.equal(p.w.vessels.length, 1);
  // too fast
  p = pair({ dist: 0.2, closing: DOCKING.MAX_SPEED + 0.5 });
  p.w.step(0.02);
  assert.equal(p.of('dock').length, 0, 'closing at 2 m/s does not latch');
  assert.equal(p.w.vessels.length, 2);
  // just slow enough
  p = pair({ dist: 0.2, closing: DOCKING.MAX_SPEED - 0.3 });
  p.w.step(0.02);
  assert.equal(p.of('dock').length, 1, '1.2 m/s latches');
  // misaligned by 25°
  p = pair({ dist: 0.2, tilt: 25 * Math.PI / 180 });
  run(p.w, 1);
  assert.equal(p.of('dock').length, 0, '25° off axis does not latch');
  // 10° is fine
  p = pair({ dist: 0.2, tilt: 10 * Math.PI / 180 });
  p.w.step(0.02);
  assert.equal(p.of('dock').length, 1, '10° off axis latches');
  // different sizes never latch
  p = pair({ dist: 0.1, portB: 'dock_m' });
  run(p.w, 1);
  assert.equal(p.of('dock').length, 0, 'S does not fit M');
  // outside the capture distance but inside the assist range: pulled in gently, then latched
  p = pair({ dist: 0.5, side: 0.1 });
  const g0 = portGap(p.a, p.pa, p.b, p.pb);
  assert.ok(g0 > DOCKING.CAPTURE && g0 < DOCKING.ASSIST);
  const ref = pair({ dist: 0.9, side: 0.1 });               // same pair, out of reach of the assist
  run(p.w, 0.5); run(ref.w, 0.5);
  assert.equal(p.of('dock').length, 0, 'not instantly');
  assert.ok(portGap(p.a, p.pa, p.b, p.pb) < g0, 'the gap is closing');
  assert.ok(p.a.vel.distanceTo(p.b.vel) > 0.01 && p.a.vel.distanceTo(p.b.vel) < 0.4, 'gently');
  const before = momentum(ref.a, ref.b);
  assert.ok(momentum(p.a, p.b).distanceTo(before) / before.length() < 1e-7, 'the assist conserves momentum');
  run(p.w, 15);
  assert.equal(p.of('dock').length, 1, 'capture assist completes the docking');
  // outside the assist range nothing pulls
  p = pair({ dist: 0.9 });
  run(p.w, 5);
  assert.equal(p.of('dock').length, 0);
  near(portGap(p.a, p.pa, p.b, p.pb), 0.9, 0.02, 'gap unchanged');
  // a port that is not exposed cannot dock: put the station's port against a ship without one
  const noPort = new Craft('Plain'); noPort.setRoot('probe_wisp');
  const w = new World();
  const s = orbitState(90000);
  const a = w.spawn(ship('A'), { crew: ['Ada'], pos: s.r, vel: s.v });
  w.spawn(noPort, { pos: a.portWorld(a.dockPorts[0]).clone(), vel: s.v, makeActive: false });
  let docked = 0; w.on('dock', () => docked++);
  run(w, 1);
  assert.equal(docked, 0);
});

test('docking merge invariants: mass, momentum, parts, crew, resources, stages, control', () => {
  const p = pair({ dist: 0.2, closing: 0.6, bCraft: module_('Station', 'dock_s', { engine: true }) });
  const { w, a, b } = p;
  w.stage();                                              // the chaser's engine stage has fired (throttle 0)
  a.ctrl.throttle = 0;
  a.w.set(0.01, 0.02, -0.01);
  const massBefore = a.mass + b.mass, mom = momentum(a, b);
  const com = a.pos.clone().multiplyScalar(a.mass).addScaledVector(b.pos, b.mass).multiplyScalar(1 / massBefore);
  const nA = a.parts.size, nB = b.parts.size;
  const fuel = a.resources.fuel.amount + b.resources.fuel.amount, mono = a.resources.mono.amount + (b.resources.mono ? b.resources.mono.amount : 0);
  const elec = a.resources.elec.amount + b.resources.elec.amount;
  const bWorld = new Map([...b.parts.values()].map(q => [q.id, b.partWorldPos(q)]));
  const bTypes = [...b.parts.values()].map(q => q.type).sort();
  const aControl = a.controlId, aStages = a.stages.map(s => s.slice()), aStageIndex = a.stageIndex;
  const bStages = b.stages.map(s => s.slice());
  assert.equal(b.stageIndex, 0);
  const cost = a.cost + b.cost;
  w.step(0.02);
  const e = p.of('dock')[0];
  assert.ok(e, 'docked');
  assert.equal(e.vessel, a, 'the active vessel absorbs the other');
  assert.equal(e.absorbed, b);
  assert.equal(e.parts.length, 2);
  assert.deepEqual(w.vessels, [a]);
  assert.equal(w.active, a);
  assert.ok(b.dead && b.absorbedInto === a && b.parts.size === 0);
  // mass, momentum, centre of mass
  near(a.mass, massBefore, 1e-6, 'mass');
  const momAfter = momentum(a);
  assert.ok(momAfter.distanceTo(mom) / mom.length() < 2e-4, 'linear momentum conserved (within one step of gravity)');
  const shift = a.pos.clone().sub(com);                   // one step along the orbit
  near(shift.length(), mom.length() / massBefore * 0.02, 0.01, 'the centre of mass carried on along the orbit');
  assert.ok(a.w.length() < 0.2, 'no spin-up: ' + a.w.length());
  // parts
  assert.equal(a.parts.size, nA + nB);
  assert.equal(new Set(a.parts.keys()).size, nA + nB, 'ids unique');
  for (const q of a.parts.values()) {
    assert.equal(a.parts.get(q.id), q);
    for (const id of q.links) assert.ok(a.parts.get(id).links.includes(q.id), 'links are symmetric');
  }
  assert.equal(a._component(a.controlId, null).size, nA + nB, 'one connected part graph');
  const [idA, idB] = e.parts;
  const portA = a.parts.get(idA), portB = a.parts.get(idB);
  assert.ok(portA.def.dock && portB.def.dock);
  assert.equal(portA.dockedTo, idB); assert.equal(portB.dockedTo, idA);
  assert.ok(portA.links.includes(idB));
  assert.deepEqual(a.dockedPairs, [[idA, idB]]);
  assert.equal(a.dockPorts.length, 0, 'no free ports left');
  // geometry: port faces coincide, absorbed parts are upside down, and nothing jumped far in the world
  near(Math.abs(portA.pos.y - portB.pos.y), (portA.def.h + portB.def.h) / 2, 1e-9, 'faces touch');
  near(Math.hypot(portA.pos.x - portB.pos.x, portA.pos.z - portB.pos.z), 0, 1e-9, 'coaxial');
  assert.equal(portB.flip, true); assert.equal(portA.flip, false);
  for (const [oldId, was] of bWorld) {
    const q = a.parts.get(e.idMap.get(oldId));
    assert.ok(q, 'absorbed part ' + oldId);
    assert.ok(a.partWorldPos(q).distanceTo(was.add(shift)) < 0.5, 'part stays where it was (within the capture snap)');
  }
  assert.deepEqual([...e.idMap.values()].map(id => a.parts.get(id).type).sort(), bTypes);
  // crew, resources, cost, control
  assert.deepEqual(a.crew, ['Ada']);
  assert.equal(a.crewCount, 1);
  near(a.resources.fuel.amount, fuel, 1e-6, 'fuel');
  near(a.resources.mono.amount, mono, 1e-6, 'mono');
  near(a.resources.elec.amount, elec, 0.01, 'charge');
  assert.equal(a.cost, cost);
  assert.equal(a.controlId, aControl, 'control stays with the active vessel');
  assert.equal(a.name, 'Chaser');
  // stages: own stages untouched, the absorbed vessel's unfired stages appended with remapped ids
  assert.deepEqual(a.stages.slice(0, aStages.length), aStages);
  assert.equal(a.stageIndex, aStageIndex);
  assert.deepEqual(a.stages.slice(aStages.length), bStages.map(s => s.map(id => e.idMap.get(id))));
  assert.ok(a.stages.at(-1).every(id => a.parts.get(id).def.engine));
  // the merged vessel flies on as one rigid body
  run(w, 5);
  assert.ok(!a.dead);
  assert.equal(a.situation, 'orbit');
  // when the station is the active vessel it is the one that stays
  const p2 = pair({ dist: 0.2, active: 'b' });
  p2.w.step(0.02);
  assert.equal(p2.of('dock')[0].vessel, p2.b);
  assert.equal(p2.b.name, 'Station');
  assert.equal(p2.b.controlPart.def.id, 'probe_wisp');
  assert.deepEqual(p2.b.crew, ['Ada']);
  assert.equal(p2.w.active, p2.b);
  // other vessels that targeted the absorbed vessel now target the merged one
  const p3 = pair({ dist: 2 });
  const s = orbitState(90000, 0.0005);
  const third = p3.w.spawn(module_('Third'), { pos: s.r, vel: s.v, makeActive: false });
  p3.w.setTarget(third, p3.b);
  p3.w.setTarget(p3.a, p3.b);
  p3.b.pos.addScaledVector(noseOf(p3.a), -1.8);
  p3.w.step(0.02);
  assert.equal(p3.of('dock').length, 1);
  assert.equal(third.targetId, p3.a.id);
  assert.equal(p3.a.targetId, null, 'the chaser no longer has a target');
});

test('Vessel.absorb conserves linear and angular momentum exactly', () => {
  const p = pair({ dist: 0.15, closing: 0.4, side: 0.05, tilt: 0.08 });
  const { a, b, pa, pb } = p;
  a.w.set(0.02, -0.03, 0.01); b.w.set(-0.01, 0.02, 0.03);
  const M = a.mass + b.mass;
  const P = momentum(a, b);
  const C = a.pos.clone().multiplyScalar(a.mass / M).addScaledVector(b.pos, b.mass / M);
  const Vc = P.clone().multiplyScalar(1 / M);
  const L = new Vector3();
  for (const v of [a, b]) {
    L.add(new Vector3(v.inertia.x * v.w.x, v.inertia.y * v.w.y, v.inertia.z * v.w.z).applyQuaternion(v.q));
    L.addScaledVector(v.pos.clone().sub(C).cross(v.vel.clone().sub(Vc)), v.mass);
  }
  const res = a.absorb(b, pa, pb);
  assert.ok(res);
  near(a.mass, M, 1e-9, 'mass');
  assert.ok(momentum(a).distanceTo(P) / P.length() < 1e-12, 'linear momentum');
  assert.ok(a.pos.distanceTo(C) < 1e-6, 'centre of mass');
  const L2 = new Vector3(a.inertia.x * a.w.x, a.inertia.y * a.w.y, a.inertia.z * a.w.z).applyQuaternion(a.q);
  assert.ok(L2.distanceTo(L) / L.length() < 1e-9, 'angular momentum');
  // the merged centre of mass in craft coordinates matches the parts
  let m = 0; const c = new Vector3();
  for (const q of a.parts.values()) { m += q.mass; c.addScaledVector(q.pos, q.mass); if (q.def.comY) c.y += q.mass * q.def.comY * (q.flip ? -1 : 1); }   // capsules carry their mass low
  assert.ok(c.multiplyScalar(1 / m).distanceTo(a.com) < 1e-9);
  // landed vessels and bad ports are refused
  const p2 = pair({ dist: 0.15 });
  assert.equal(p2.a.absorb(p2.a, p2.pa, p2.pa), null);
  assert.equal(p2.a.absorb(p2.b, p2.pa, null), null);
});

test('undock: splits at the port link, pushes apart, re-arms the ports, keeps crews and names', () => {
  const p = pair({ dist: 0.2 });
  const { w, a, b } = p;
  const nA = a.parts.size, nB = b.parts.size, mA = a.mass, mB = b.mass;
  w.step(0.02);
  const dock = p.of('dock')[0];
  run(w, 2);
  const mom = momentum(a);
  assert.equal(w.undock(a, 9999), null, 'not a port');
  assert.equal(w.undock(a, a.controlId), null, 'not a docked port');
  const other = w.undock(a, dock.parts[1]);              // either port of the pair works
  assert.ok(other);
  const ev = p.of('undock')[0];
  assert.equal(ev.vessel, a); assert.equal(ev.other, other);
  assert.deepEqual(w.vessels, [a, other]);
  assert.ok(other.id > 0 && other.id !== a.id);
  assert.equal(other.name, 'Station');
  assert.equal(other.type, 'ship');
  assert.equal(a.name, 'Chaser');
  assert.equal(a.parts.size, nA); assert.equal(other.parts.size, nB);
  near(a.mass, mA, 1e-6); near(other.mass, mB, 1e-6);
  assert.deepEqual(a.crew, ['Ada']); assert.deepEqual(other.crew, []);
  assert.equal(a.controlPart.def.id, 'pod_acorn');
  assert.equal(other.controlPart.def.id, 'probe_wisp');
  assert.equal(other.controlPart.flip, false, 'the new vessel has its nose along +Y again');
  for (const q of other.parts.values()) assert.equal(q.flip, false);
  assert.equal(a.dockedPairs.length, 0);
  assert.equal(a.dockPorts.length, 1); assert.equal(other.dockPorts.length, 1);
  assert.equal(other.dockPorts[0]._face, 1);
  // separation impulse: opposite, momentum conserved, relative speed = UNDOCK_SPEED
  assert.ok(momentum(a, other).distanceTo(mom) / mom.length() < 1e-9, 'momentum conserved');
  near(a.vel.distanceTo(other.vel), DOCKING.UNDOCK_SPEED, 0.01, 'separation speed');
  const gap0 = portGap(a, a.dockPorts[0], other, other.dockPorts[0]);
  assert.ok(gap0 < 0.05, 'ports start face to face');
  run(w, 1);
  assert.equal(p.of('dock').length, 1, 'does not latch again straight away');
  assert.ok(portGap(a, a.dockPorts[0], other, other.dockPorts[0]) > 0.2, 'drifting apart');
  run(w, 5);
  assert.ok(portGap(a, a.dockPorts[0], other, other.dockPorts[0]) > 1.2);
  assert.equal(w.vessels.length, 2);
  // ... and they can dock again later
  other.vel.copy(a.vel);
  other.pos.add(a.portWorld(a.dockPorts[0]).addScaledVector(noseOf(a), 0.1).sub(other.portWorld(other.dockPorts[0])));
  w.step(0.02);
  assert.equal(p.of('dock').length, 2, 'docked a second time');
  assert.equal(a.parts.size, nA + nB);
  assert.equal(new Set(a.parts.keys()).size, nA + nB, 'no id collisions on re-docking');
  // undock while on rails warp drops the warp
  w.setWarp(5);
  assert.ok(w.warpIndex > 3);
  const again = w.undock(a, a.dockedPairs[0][0]);
  assert.ok(again);
  assert.equal(w.warpIndex, 0);
  // the undocked station keeps flying under its own control (SAS hold, in orbit)
  run(w, 3);
  assert.equal(again.situation, 'orbit');
  assert.ok(again.controllable);
});

test('serialisation round-trips a docked vessel, and it still undocks afterwards', () => {
  const p = pair({ dist: 0.2, tilt: 0.1 });
  const { w, a } = p;
  w.step(0.02);
  assert.equal(p.of('dock').length, 1);
  w.setTarget(a, pell);
  run(w, 1);
  const json = JSON.parse(JSON.stringify(w.toJSON()));
  const w2 = World.fromJSON(json);
  assert.deepEqual(JSON.parse(JSON.stringify(w2.toJSON())), json, 'world JSON is stable');
  const a2 = w2.active;
  assert.equal(a2.parts.size, a.parts.size);
  assert.deepEqual(a2.dockedPairs, a.dockedPairs);
  near(a2.mass, a.mass, 1e-6);
  assert.ok(a2.com.distanceTo(a.com) < 1e-9);
  assert.ok(a2.inertia.distanceTo(a.inertia) < 1e-6 * a.inertia.length());
  for (const q of a.parts.values()) {
    const r = a2.parts.get(q.id);
    assert.equal(r.flip, q.flip); assert.equal(r.dockedTo, q.dockedTo); near(r.rot, q.rot, 1e-15);
    assert.ok(r.pos.distanceTo(q.pos) < 1e-12);
    assert.equal(r._face, q._face);
  }
  assert.ok([...a2.parts.values()].some(q => q.flip), 'the flip flag is saved');
  assert.deepEqual(a2.crew, ['Ada']);
  // both copies fly identically
  run(w, 2); run(w2, 2);
  assert.ok(a.pos.distanceTo(a2.pos) < 1e-6);
  // undock in the loaded world
  const other = w2.undock(a2, a2.dockedPairs[0][0]);
  assert.ok(other);
  assert.equal(other.name, 'Station');
  assert.equal(other.controlPart.flip, false);
  // a freshly undocked pair saved and loaded does not snap back together
  const w3 = World.fromJSON(JSON.parse(JSON.stringify(w2.toJSON())));
  let docks = 0; w3.on('dock', () => docks++);
  w3.step(0.02); w3.step(0.02);
  assert.equal(docks, 0);
  assert.equal(w3.vessels.length, 2);
});

test('crossfeed through docking ports, and transferResource', () => {
  // a tanker (probe + tank + port) docked to the nose of a ship: the ship's engine can draw from the tanker
  const p = pair({ dist: 0.2 });
  const { w, a } = p;
  const own = a.engines[0].tanks.slice();
  assert.equal(own.length, 1);
  w.step(0.02);
  assert.equal(p.of('dock').length, 1);
  const eng = a.engines.find(e => e.part.def.id === 'eng_sparrow');
  assert.equal(eng.tanks.length, 2, 'the docked tank joined the engine\'s fuel section');
  const [mine, theirs] = [eng.tanks.find(t => t.def.id === 'tank_m400'), eng.tanks.find(t => t.def.id === 'tank_m200')];
  assert.ok(mine && theirs);
  // burn: both tanks drain evenly
  w.stage(); a.ctrl.throttle = 1; a.ctrl.sas = true;
  const f0 = [mine.res.fuel, theirs.res.fuel];
  run(w, 4);
  a.ctrl.throttle = 0;
  run(w, 0.1);
  assert.ok(f0[0] - mine.res.fuel > 20 && f0[1] - theirs.res.fuel > 20, 'both drained');
  near(f0[0] - mine.res.fuel, f0[1] - theirs.res.fuel, 0.5, 'evenly');
  // transferResource: limited by the request, the source and the free room
  const m0 = a.mass, com0 = a.com.clone();
  const total = mine.res.fuel + theirs.res.fuel;
  assert.equal(a.transferResource(mine.id, theirs.id, 'fuel', 30), 30);
  near(mine.res.fuel + theirs.res.fuel, total, 1e-9, 'nothing lost');
  near(a.mass, m0, 1e-6, 'mass unchanged');
  assert.ok(a.com.distanceTo(com0) > 1e-4, 'the centre of mass moved');
  const room = theirs.def.res.fuel - theirs.res.fuel;
  near(a.transferResource(mine.id, theirs.id, 'fuel', 1e9), Math.min(room, mine.res.fuel + room), 1e-9, 'capped by the free room');
  near(theirs.res.fuel, theirs.def.res.fuel, 1e-9, 'full');
  const all = theirs.res.fuel;
  near(a.transferResource(theirs.id, mine.id, 'fuel'), Math.min(all, mine.def.res.fuel - (total - all)), 1e-9, 'default amount = as much as fits');
  near(a.resources.fuel.amount, total, 1e-6);
  // bad requests move nothing
  assert.equal(a.transferResource(mine.id, mine.id, 'fuel', 10), 0);
  assert.equal(a.transferResource(mine.id, 9999, 'fuel', 10), 0);
  assert.equal(a.transferResource(mine.id, theirs.id, 'mono', 10), 0, 'tanks hold no mono');
  assert.equal(a.transferResource(mine.id, theirs.id, 'fuel', -5), 0);
  // other resources: charge from the station battery to the capsule, mono between mono tanks
  const pod = a.commandParts.find(q => q.def.id === 'pod_acorn'), battery = a.partList.find(q => q.def.id === 'battery');
  pod.res.elec = 10;
  assert.equal(a.transferResource(battery.id, pod.id, 'elec', 25), 25);
  near(pod.res.elec, 35, 1e-9);
  const monoTank = a.partList.find(q => q.def.id === 'tank_mono');
  pod.res.mono = 2;
  near(a.transferResource(monoTank.id, pod.id, 'mono', 100), 8, 1e-9, 'the capsule only holds 10');
  // refuelling a flamed-out engine clears the flameout
  for (const t of eng.tanks) t.res.fuel = 0;
  a.ctrl.throttle = 1; run(w, 0.1); a.ctrl.throttle = 0;
  assert.equal(eng.part.flameout, true);
  // after undocking, each side keeps what its own tanks hold
  theirs.res.fuel = 400; mine.res.fuel = 0;
  const other = w.undock(a, a.dockedPairs[0][0]);
  near(other.resources.fuel.amount, 400, 1e-9);
  near(a.resources.fuel.amount, 0, 1e-9);
  assert.equal(a.engines[0].tanks.length, 1);
});

// ---------------------------------------------------------------------------------------------------------
test('rendezvous guidance: from a lower co-planar orbit to within 150 m at < 1 m/s', () => {
  const w = new World();
  const st = orbitState(90000, 0.35);                     // the target leads by 20°
  const tgt = w.spawn(module_('Station'), { pos: st.r, vel: st.v, makeActive: false });
  const sc = orbitState(76000, 0);
  const v = w.spawn(ship('Chaser'), { crew: ['Ada'], pos: sc.r, vel: sc.v });
  w.stage();
  const dv0 = v.deltaV;
  const ctl = AP.fly(w, AP.rendezvous(w, v, tgt), { maxSim: 2e5 });
  assert.ok(ctl.done && !ctl.failed, ctl.log.map(l => l.msg).join(' | '));
  const ti = v.targetInfo;
  assert.equal(w.getTarget(v), tgt);
  assert.ok(ti.distance < 150, 'distance ' + ti.distance);
  assert.ok(ti.relSpeed < 1, 'relative speed ' + ti.relSpeed);
  assert.ok(dv0 - v.deltaV < 120, 'a cheap transfer: ' + (dv0 - v.deltaV));
  assert.equal(v.nodes.length, 0);
  assert.equal(v.ctrl.throttle, 0);
  // and it stays there: a minute later still close and slow
  AP.fly(w, null, { maxSim: 60, physWarp: 0 });
  assert.ok(v.targetInfo.distance < 200 && v.targetInfo.relSpeed < 1);
});

test('rendezvous guidance: same orbit, 25 km behind (steps the orbit down to phase, then catches up)', () => {
  const w = new World();
  const st = orbitState(120000, 25000 / (home.radius + 120000));
  const tgt = w.spawn(module_('Station'), { pos: st.r, vel: st.v, makeActive: false });
  const sc = orbitState(120000, 0);
  const v = w.spawn(ship('Chaser'), { crew: ['Ada'], pos: sc.r, vel: sc.v });
  w.stage();
  assert.equal(AP.planRendezvous(w, v, tgt), null, 'identical orbits cannot be phased directly');
  const ctl = AP.fly(w, AP.rendezvous(w, v, tgt), { maxSim: 4e5 });
  assert.ok(ctl.done && !ctl.failed, ctl.log.map(l => l.msg).join(' | '));
  assert.ok(ctl.log.some(l => /too alike/.test(l.msg)));
  assert.ok(v.targetInfo.distance < 150 && v.targetInfo.relSpeed < 1, `${v.targetInfo.distance} m, ${v.targetInfo.relSpeed} m/s`);
});

test('docking approach under RCS from 30 m: in front of the port, and from behind the target', () => {
  for (const where of ['front', 'behind']) {
    const w = new World();
    const s = orbitState(90000);
    const tgt = w.spawn(module_('Station'), { pos: s.r, vel: s.v, makeActive: false });
    tgt.ctrl.sas = true; tgt.ctrl.sasMode = 'hold';
    const n = noseOf(tgt);
    const side = new Vector3(1, 0, 0).applyQuaternion(tgt.q);
    const off = where === 'front' ? n.clone().multiplyScalar(30).addScaledVector(side, 6) : n.clone().multiplyScalar(-30).addScaledVector(side, 2);
    const v = w.spawn(ship('Chaser'), { crew: ['Ada'], pos: s.r.clone().add(off), vel: s.v });
    v.q.setFromAxisAngle(new Vector3(0, 0, 1), 1.0);       // pointing somewhere else entirely
    const log = [];
    w.on('dock', d => log.push(d));
    let maxClosing = 0, minHull = Infinity;
    const mono0 = v.resources.mono.amount;
    const ctl = AP.fly(w, AP.dockingApproach(w, v, tgt), {
      maxSim: 1500, physWarp: 1,
      onStep: () => {
        if (tgt.dead) return;
        const d = v.pos.distanceTo(tgt.pos);
        if (d < 4) maxClosing = Math.max(maxClosing, v.vel.distanceTo(tgt.vel));
        // the chaser's centre never passes through the target's hull
        minHull = Math.min(minHull, d);
      },
    });
    assert.ok(ctl.done && !ctl.failed, where + ': ' + ctl.log.map(l => l.msg).join(' | '));
    assert.equal(log.length, 1, where + ': dock event');
    assert.equal(log[0].vessel, v);
    assert.equal(w.vessels.length, 1);
    assert.ok(maxClosing < 0.8, where + ': contact speed ' + maxClosing);
    assert.ok(minHull > 2.0, where + ': kept clear of the hull, closest ' + minHull);
    assert.equal(v.partList.find(q => q.def.id === 'tank_m400').res.fuel, 2000, 'RCS only: no main-engine fuel used');
    assert.ok(mono0 - v.resources.mono.amount < 60, where + ': mono used ' + (mono0 - v.resources.mono.amount));
    assert.deepEqual(v.crew, ['Ada']);
    assert.ok(v.w.length() < 0.05, 'docked without a spin');
    assert.equal(v.ctrl.tx, 0); assert.equal(v.ctrl.ty, 0); assert.equal(v.ctrl.tz, 0);
    if (where === 'behind') assert.ok(ctl.log.some(l => /^clear/.test(l.msg)) || ctl.log.some(l => /^forward/.test(l.msg)), 'went around');
  }
  // without RCS the controller refuses instead of ramming
  const w = new World();
  const s = orbitState(90000);
  const tgt = w.spawn(module_('Station'), { pos: s.r, vel: s.v, makeActive: false });
  const v = w.spawn(module_('NoRcs'), { pos: s.r.clone().addScaledVector(noseOf(tgt), 30), vel: s.v });
  const ctl = AP.fly(w, AP.dockingApproach(w, v, tgt), { maxSim: 60 });
  assert.ok(ctl.failed);
  assert.match(ctl.log.at(-1).msg, /RCS/);
});

// ---------------------------------------------------------------------------------------------------------
test('launching a second vessel while another is in orbit', () => {
  const w = new World();
  const s = orbitState(85000, 1.0);
  const first = w.spawn(module_('First'), { pos: s.r, vel: s.v });
  run(w, 1);
  const second = w.launch(stock('Latch Chaser'), { crew: ['Ada'] });
  assert.equal(w.active, second);
  assert.equal(w.vessels.length, 2);
  assert.notEqual(first.id, second.id);
  assert.equal(second.situation, 'prelaunch');
  assert.equal(w.warpIndex, 0);
  run(w, 2);
  assert.ok(first.onRails, 'the orbiting vessel rides on rails while the new one sits on the pad');
  assert.equal(first.situation, 'orbit');
  const o = first.getOrbit(w.ut);
  second.ctrl.throttle = 1;
  w.stage();
  run(w, 20, 0.05);
  assert.ok(second.altitude > 300 && !second.dead);
  assert.ok(!first.dead);
  near(first.getOrbit(w.ut).a, o.a, 1e-3, 'the first vessel\'s orbit is untouched');
  near(first.pos.length() - home.radius, 85000, 5);
  // a third launch with the second still flying works too, and ids stay unique
  const third = w.launch(stock('Hopper I'), { crew: ['Bo'] });
  assert.equal(new Set(w.vessels.map(v => v.id)).size, w.vessels.length);
  assert.equal(w.active, third);
  w.switchTo(second);
  assert.equal(w.active, second);
});

test('Mote Sounder: a small sounding rocket that comes back in one piece under its parachute', () => {
  const craft = stock('Mote Sounder');
  assert.deepEqual(craft.stages.map(s => s.map(id => craft.getPart(id).type)), [['eng_moth'], ['chute']]);
  const w = new World();
  const v = w.launch(craft);
  const ev = [];
  w.on('*', (d, type) => ev.push(type));
  v.ctrl.throttle = 1;
  w.stage();
  let apex = 0;
  AP.fly(w, null, { maxSim: 600, until: () => { apex = Math.max(apex, v.altitude); return v.verticalSpeed < -1; } });
  assert.ok(apex > 3500, 'apex ' + apex);
  const rec = w.runExperiment(v, v.partList.find(p => p.def.id === 'sci_thermo').id);
  assert.ok(rec, 'took a temperature reading up high');
  w.stage();                                              // arm the parachute
  AP.fly(w, null, { maxSim: 3000, until: () => v.landed || v.dead });
  assert.ok(v.landed && !v.dead, 'landed');
  assert.ok(!ev.includes('explosion'), 'in one piece');
  assert.equal(v.parts.size, craft.parts.length);
  assert.ok(w.recover(v));
});

test('an unloaded vessel that falls into the atmosphere announces its removal', () => {
  const w = new World();
  const s = orbitState(300000, 2.0);
  const v = w.spawn(ship('Keeper'), { crew: ['Ada'], pos: s.r, vel: s.v });
  // a derelict on the far side with its periapsis deep in the atmosphere
  const o = Orbit.fromElements({ a: home.radius + 150000, e: 0.16 }, home.gm, 0);
  assert.ok(o.periapsis < home.radius + 30000);
  const d = o.stateAt(o.timeAtTrueAnomaly(Math.PI, 0));
  const junk = w.spawn(module_('Old Probe'), { pos: d.r, vel: d.v, makeActive: false });
  const msgs = [], gone = [];
  w.on('message', m => msgs.push(m));
  w.on('destroyed', e => gone.push(e));
  w.setWarp(6);
  AP.fly(w, null, { physWarp: 0, dt: 0.5, maxSim: o.period, until: () => gone.length > 0, onStep: () => { if (w.warpIndex < 4) w.setWarp(6); } });
  assert.equal(gone.length, 1);
  assert.equal(gone[0].vessel, junk);
  assert.equal(gone[0].reason, 'atmosphere');
  const m = msgs.find(x => x.kind === 'removed');
  assert.ok(m, 'a message event was emitted');
  assert.match(m.text, /Old Probe/);
  assert.match(m.text, /burned up in the atmosphere of Verda/);
  assert.equal(m.vessel, junk);
  assert.ok(!w.vessels.includes(junk));
  assert.ok(!v.dead);
  void partDef;
});
