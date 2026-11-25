// The space centre is solid (js/core/structures.js): its shapes come from the drawing, rockets lift off clear of them,
// a rocket falling back meets the launch mount, and a craft flown into a building is stopped or broken by the
// ground's rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Vector3, Quaternion } from '../../js/lib/three.module.min.js';
import { World } from '../../js/core/world.js';
import { Craft, stockCrafts, stockSite } from '../../js/core/craft.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { STRUCTURES, structureDistance } from '../../js/core/structures.js';
import { SITE_SOLIDS } from '../../js/core/sitesolids.js';
import { siteSolids } from '../tools/site_solids.mjs';
import * as AP from '../../js/core/autopilot.js';

const home = SYSTEM.home, Y = new Vector3(0, 1, 0);
const stock = name => stockCrafts().find(c => c.name === name);

test('the solid shapes are the ones the space centre is drawn with (run tests/tools/site_solids.mjs after changing the drawing)', () => {
  const now = siteSolids().solids;
  assert.equal(SITE_SOLIDS.length, now.length, 'shape count');
  assert.deepEqual(SITE_SOLIDS, now);
  assert.ok(readFileSync(new URL('../../js/core/sitesolids.js', import.meta.url), 'utf8').startsWith('// GENERATED'));
});

test('nothing solid within 10 m of the pad axis up to 90 m, and the runway and the Return Pad are clear', () => {
  for (let y = 0.5; y <= 90; y += 1) for (let a = 0; a < 360; a += 15) {
    const x = 10 * Math.cos(a * Math.PI / 180), z = 10 * Math.sin(a * Math.PI / 180);
    // (the flame trench's walls stand 6.3 m off the axis, 3.4 m high, toward the north: a rocket's flame, not its body, goes there)
    if (z < -10.5 + 0.1 && y < 3.5) continue;
    assert.ok(structureDistance(x, y, z).d > 0, `solid at ${x.toFixed(1)}, ${y}, ${z.toFixed(1)}`);
  }
  for (let x = -950; x <= 1050; x += 10) for (const z of [825, 850, 875]) assert.ok(structureDistance(x, 2, z).d > 1, `runway ${x}, ${z}: ${structureDistance(x, 2, z).name}`);
  for (let a = 0; a < 360; a += 10) assert.ok(structureDistance(45 * Math.cos(a), 5, -600 + 45 * Math.sin(a)).d > 1, 'return pad');
});

test('every stock craft leaves its site without touching anything', () => {
  for (const c of stockCrafts()) {
    const w = new World(), v = w.launch(c, { crew: ['Ada'], site: stockSite(c) }), hits = [];
    w.on('structureStrike', d => hits.push(`${d.part} on ${d.what}`));
    AP.fly(w, AP.ascentProgram(w, { targetAlt: 80000, heading: 90 }), { maxSim: 30 });
    assert.deepEqual(hits, [], c.name);
  }
});

/** Throttle up, cut at `alt` metres, and let it fall back onto the pad. */
function fallBack(name, alt) {
  const w = new World(), v = w.launch(stock(name), { crew: ['Ada'] }), log = [];
  w.on('*', (d, type) => log.push({ type, ...d }));
  for (let i = 0; i < 5; i++) w.step(0.02);
  v.ctrl.throttle = 1; v.ctrl.sas = true; w.stage();
  for (let t = 0; v.altitude < alt && t < 60; t += 0.02) w.step(0.02);
  v.ctrl.throttle = 0;
  for (let i = 0; i < 3000 && !v.dead && !v.landed; i++) w.step(0.02);
  return { w, v, log };
}

test('a rocket falling back onto the pad meets the launch mount it stood in', () => {
  const soft = fallBack('Skylark II', 15);
  assert.ok(soft.w._padMount && soft.w._padMount.solids.length > 20, 'the mount was planned for it');
  const hit = soft.log.filter(e => e.type === 'structureStrike');
  assert.ok(hit.length && hit[0].what === 'the launch mount', 'struck the mount: ' + JSON.stringify(hit.map(h => h.what)));
  assert.ok(!soft.v.dead, 'from 15 m the fins and the engine break off, the rest is left standing');
  assert.ok(soft.log.some(e => e.type === 'destroyed' && e.reason === 'structure') || soft.log.some(e => e.type === 'explosion'), 'something broke');
  const hard = fallBack('Skylark II', 30);
  assert.ok(hard.v.dead, 'from 30 m it is lost, as it is on bare ground');
});

/** A capsule `x, y, z` metres from the pad (east, up, south), moving east at `speed` over the ground. */
function capsuleAt(x, y, z, speed) {
  const w = new World(), dir = SYSTEM.launchSite.dir;
  const up = home.surfaceDirToInertial(dir, w.ut).normalize();
  const east = new Vector3().crossVectors(Y, up).normalize(), south = new Vector3().crossVectors(east, up);
  const pos = up.clone().multiplyScalar(home.radius + y + (x * x + z * z) / (2 * home.radius)).addScaledVector(east, x).addScaledVector(south, z);
  const wy = 2 * Math.PI / home.rotPeriod;
  const vel = new Vector3(wy * pos.z, 0, -wy * pos.x).addScaledVector(east, speed);
  const c = new Craft('Test Capsule'); c.setRoot('pod_acorn'); c.autoStage();
  const q = new Quaternion().setFromAxisAngle(Y, home.rotationAngle(w.ut)).multiply(World.padFrame(dir));
  const v = w.spawn(c, { crew: ['Ada'], body: home, pos, vel, q }), log = [];
  w.on('*', (d, type) => log.push({ type, ...d }));
  return { w, v, log };
}

test('a capsule flown into the assembly building: lost fast, stopped slow, and passes through only when switched off', () => {
  // the building's west wall is at x = -60 between its pilasters (525 m south), 108 m tall; the office
  // wing below it is 27.6 m tall, so these start high enough not to land on its roof in two seconds
  const fast = capsuleAt(-66, 60, 525, 40);
  for (let i = 0; i < 100 && !fast.v.dead; i++) fast.w.step(0.02);
  assert.ok(fast.v.dead, 'lost at 40 m/s');
  const s = fast.log.find(e => e.type === 'structureStrike');
  assert.equal(s.what, 'the Vehicle Assembly Building'); assert.ok(s.lost);
  assert.equal(fast.log.find(e => e.type === 'destroyed').reason, 'structure');

  const slow = capsuleAt(-62, 60, 525, 3);
  for (let i = 0; i < 100; i++) slow.w.step(0.02);
  assert.ok(!slow.v.dead, 'a 3 m/s bump is survived');
  assert.ok(slow.log.some(e => e.type === 'structureStrike' && !e.lost), 'and it is felt');
  const east = new Vector3().crossVectors(Y, home.surfaceDirToInertial(SYSTEM.launchSite.dir, slow.w.ut).normalize()).normalize();
  const x = slow.v.pos.clone().sub(home.surfaceDirToInertial(SYSTEM.launchSite.dir, slow.w.ut).normalize().multiplyScalar(home.radius)).dot(east);
  assert.ok(x < -60.3, 'it stays outside the wall: ' + x.toFixed(2));

  STRUCTURES.solid = false;
  try {
    const ghost = capsuleAt(-66, 60, 525, 40);
    for (let i = 0; i < 100; i++) ghost.w.step(0.02);
    assert.ok(!ghost.v.dead && !ghost.log.some(e => e.type === 'structureStrike'));
  } finally { STRUCTURES.solid = true; }
});
