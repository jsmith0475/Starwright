// Reusable boosters, part 3 (docs/BOOSTERS.md): the landing barge is a level deck that is solid to the physics, and
// the Return Pad is where the return program is sent by default.
//   D1  the Return Pad is on level ground clear of the launch pad and every building
//   D2  the barge deck: where it is, how big, how high; a stage lands on it, tips off its edge, or splashes beside it
//   D4  it does not move
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { SYSTEM, BARGE } from '../../js/core/bodies.js';
import { terrainAt, surfaceAt, waterAt, deckUnder } from '../../js/core/vessel.js';
import { boosterRecovery, groundDistance } from '../../js/core/booster.js';
import { dropped } from '../tools/booster_dev.mjs';
import { flyReturn } from '../tools/booster_sweep.mjs';

const home = SYSTEM.home, R = home.radius, barge = home.sites.barge;
/** A point `e` m east and `n` m north of the middle of the deck. */
const onDeck = (e, n) => home.dirFromLatLon(n / R, (BARGE.east + e) / R);

test('D1: the Return Pad is level ground 600 m north of the launch pad, clear of the buildings', async () => {
  const { BASE_LAYOUT, RETURN_PAD } = await import('../../js/render/basegfx.js');
  const s = home.sites.landing;
  assert.equal(s.name, 'Return Pad');
  assert.ok(Math.abs(groundDistance(home, s.dir, home.sites.pad.dir) - 600) < 0.01);
  const ll = home.latLon(s.dir);
  assert.ok(ll.lat > 0 && Math.abs(ll.lon) < 1e-9, 'due north');
  // the drawn pad (model frame: +X east, +Z south) is where the site is
  assert.ok(Math.abs(RETURN_PAD.x - ll.lon * R) < 0.01 && Math.abs(-RETURN_PAD.z - ll.lat * R) < 0.01, 'the model draws it where the physics aims');
  for (let a = 0; a < 16; a++) {
    const d = home.dirFromLatLon((600 + Math.cos(a) * RETURN_PAD.r) / R, Math.sin(a) * RETURN_PAD.r / R);
    assert.ok(Math.abs(terrainAt(home, d)) < 0.01 && !waterAt(home, d), 'level and dry across the whole pad');
  }
  for (const id of ['hangar', 'missions', 'admin', 'research', 'tracking', 'crew', 'school', 'spaceplane']) {
    const [x, z] = BASE_LAYOUT[id];
    assert.ok(Math.hypot(x - RETURN_PAD.x, z - RETURN_PAD.z) > 600, id + ' is more than 600 m away');
  }
});

test('D2: the deck is 80 by 50 m, 4 m above the sea, 40 km east of the pad, and nowhere else', () => {
  assert.ok(Math.abs(groundDistance(home, barge.dir, home.sites.pad.dir) - 40000) < 0.01);
  assert.equal(barge.top, home.seaLevel + 4);
  assert.ok(home.terrainHeight(barge.dir) < -300, 'deep water under it: ' + home.terrainHeight(barge.dir).toFixed(0) + ' m');
  for (const [e, n, on] of [[0, 0, true], [39.9, 24.9, true], [-39.9, -24.9, true], [40.1, 0, false], [0, 25.1, false], [-40.1, 0, false], [0, -25.1, false], [300, 0, false], [0, 5000, false]]) {
    const d = onDeck(e, n);
    assert.equal(home.deckAt(d) > -Infinity, on, `${e} m east, ${n} m north`);
    assert.equal(deckUnder(home, d), on);
    assert.equal(terrainAt(home, d) === barge.top, on);
    assert.equal(surfaceAt(home, d), on ? barge.top : home.seaLevel);
    assert.equal(waterAt(home, d), !on);
    assert.equal(home.isWater(d), !on);
    assert.equal(home.surfaceHeight(d), on ? barge.top : home.seaLevel);
  }
  // a direction that is not a unit vector gives the same answer (the height field allows it, so the deck does too)
  assert.equal(home.deckAt(onDeck(10, 10).multiplyScalar(R + 5000)), barge.top);
  assert.equal(home.deckAt(home.sites.pad.dir), -Infinity);
  assert.equal(home.deckAt(barge.dir.clone().negate()), -Infinity, 'not on the far side of the planet either');
  assert.equal(SYSTEM.byId.pell.deckAt(new Vector3(1, 0, 0)), -Infinity, 'other worlds have none');
});

test('D4: the deck turns with the planet and does not otherwise move', () => {
  const a = home.surfaceDirToInertial(barge.dir, 0).clone(), b = home.surfaceDirToInertial(barge.dir, home.rotPeriod / 4).clone();
  assert.ok(Math.abs(a.angleTo(b) - Math.PI / 2) < 1e-9, 'a quarter turn in a quarter day');
  assert.equal(home.deckAt(home.inertialToSurfaceDir(b.clone(), home.rotPeriod / 4)), barge.top);
});

/** Fly the last 16 km down onto a point of the deck, then leave the stage alone for 30 s. */
function setDown(e, n) {
  const { w, v } = dropped({ alt: 16000, speed: 320, pitch: -80, east: BARGE.east + e - 1500, fuel: 0.14 });
  const c = boosterRecovery(w, v, { target: onDeck(e, n) });
  let done = -1;
  for (let i = 0; i < 12000; i++) {
    if (!c.done) c.update(0.02);
    w.step(0.02);
    if (v.dead) break;
    if (c.done && done < 0) done = i;
    if (done >= 0 && i - done > 1500) break;
  }
  const ll = home.latLon(home.inertialToSurfaceDir(v.pos.clone(), w.ut));
  return { c, v, east: ll.lon * R - BARGE.east, north: ll.lat * R, tilt: new Vector3(0, 1, 0).applyQuaternion(v.q).angleTo(v.pos.clone().normalize()) * 180 / Math.PI };
}

test('D2: a stage lands on the deck and stands there', () => {
  const r = setDown(12, -8);
  assert.ok(r.c.done && !r.c.failed, r.c.log.map(l => l.msg).join('\n'));
  assert.ok(r.v.landed && !r.v.splashed && r.v.situation === 'landed', 'on the deck, not in the water: ' + r.v.situation);
  assert.ok(r.tilt < 2, 'upright: ' + r.tilt.toFixed(1) + '°');
  assert.ok(Math.abs(r.east - 12) < 2 && Math.abs(r.north + 8) < 2, `where it was sent (${r.east.toFixed(1)} m east, ${r.north.toFixed(1)} m north)`);
  assert.ok(r.v.radarAlt < 0.3 && r.v.altitude > barge.top && r.v.altitude < barge.top + 12, 'its feet are on the deck plates: centre of mass ' + (r.v.altitude - barge.top).toFixed(1) + ' m above them');
});

test('D2: with its feet over the edge it tips off into the sea, and the program says it fell', () => {
  const r = setDown(40.4, 0);               // the middle of the stage a few centimetres inside the edge, two feet past it
  assert.ok(r.c.done && r.c.failed, 'not reported as a landing: ' + r.c.log.at(-1).msg);
  assert.ok(r.v.splashed, 'it ends in the water (' + r.v.situation + ')');
  assert.ok(r.east > 40, 'off the east edge: ' + r.east.toFixed(1) + ' m from the middle');
  assert.ok(r.v.altitude < barge.top, 'below the deck');
});

test('D2: beside the barge it comes down in the sea, and the program says so', () => {
  const r = setDown(70, 0);
  assert.ok(r.c.done && r.c.failed && /in the sea/.test(r.c.log.at(-1).msg), r.c.log.at(-1).msg);
  assert.ok(r.v.splashed);
});

test('a return from separation reaches the barge and lands on it; one that cannot reach it says so and ditches', () => {
  const good = flyReturn({ alt: 30000, speed: 1100, pitch: 40, east: 20000, fuel: 0.3 }, { target: barge.dir });
  assert.ok(good.ok && good.miss < 10 && Math.abs(good.vs) < 2 && good.tilt < 3, good.log.join('\n'));
  const far = flyReturn({ alt: 40000, speed: 1500, pitch: 30, east: 30000, fuel: 0.35 }, { target: barge.dir });
  assert.ok(!far.ok && far.log.some(l => /cannot reach the target/.test(l)) && /in the sea/.test(far.log.at(-1)), far.log.join('\n'));
});

test('a booster standing on the deck is still there after a save and a reload, and after a day at high warp', async () => {
  const { World } = await import('../../js/core/world.js');
  const { w, v } = dropped({ alt: 16000, speed: 320, pitch: -80, east: BARGE.east - 1500, fuel: 0.14 });
  const c = boosterRecovery(w, v, { target: barge.dir });
  for (let i = 0; i < 12000 && !c.done; i++) { c.update(0.02); w.step(0.02); }
  for (let i = 0; i < 300; i++) w.step(0.02);
  assert.ok(v.landed && !v.splashed);
  const where = () => { const b = w2.vessels.find(x => x.id === v.id) || v; b.updateTelemetry(w2.ut); return { alt: b.altitude, off: groundDistance(home, home.inertialToSurfaceDir(b.pos.clone(), w2.ut), barge.dir), landed: b.landed, splashed: b.splashed, dead: !!b.dead }; };
  let w2 = w;
  const before = where();
  w2 = World.fromJSON(JSON.parse(JSON.stringify(w.toJSON())));
  for (let i = 0; i < 200; i++) w2.step(0.02);
  const loaded = where();
  assert.ok(loaded.landed && !loaded.splashed && !loaded.dead && Math.abs(loaded.alt - before.alt) < 0.02 && Math.abs(loaded.off - before.off) < 0.05, 'after the reload: ' + JSON.stringify(loaded) + ' was ' + JSON.stringify(before));
  w2.setWarp(7);
  for (let i = 0; i < 2000 && w2.ut < w.ut + home.rotPeriod; i++) w2.step(0.05);
  w2.setWarp(0);
  for (let i = 0; i < 100; i++) w2.step(0.02);
  const later = where();
  assert.ok(later.landed && !later.splashed && !later.dead && Math.abs(later.alt - before.alt) < 0.02 && Math.abs(later.off - before.off) < 0.05, 'a day later: ' + JSON.stringify(later));
});
