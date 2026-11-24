// Landing-site assessment and the landing programs that use it (js/core/landingsite.js, docs/LANDING_SITES.md):
// the autopilot looks at the ground before it stands a lander on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { World } from '../../js/core/world.js';
import * as AP from '../../js/core/autopilot.js';
import { assessSite, findSite, slopeLimit, footprint } from '../../js/core/landingsite.js';
import { SCENARIO_CRAFT, orbitState } from '../../js/core/scenarios.js';

const DEG = 180 / Math.PI;
const Y = new Vector3(0, 1, 0);

/** A world whose ground is a formula: h(x east, y north) in metres about `base`, on a sphere of radius R. */
function formulaWorld(h, R = 2e5, base = new Vector3(1, 0, 0)) {
  const east = new Vector3().crossVectors(Y, base).normalize(), north = new Vector3().crossVectors(base, east);
  return { radius: R, base, east, north, terrainHeight(d) { const k = R / d.dot(base); return h(d.dot(east) * k, d.dot(north) * k); } };
}
const at = (w, x, y) => w.base.clone().addScaledVector(w.east, x / w.radius).addScaledVector(w.north, y / w.radius).normalize();

/** A lander in a low orbit of `bodyId`, `phase` radians round from the sub-solar point. */
function inOrbit(bodyId, phase, craft = 'Wayfarer (lander)') {
  const b = SYSTEM.byId[bodyId], w = new World();
  const st = orbitState(b, { pe: Math.max(8000, 0.12 * b.radius), phase }, w.ut);
  const v = w.spawn(SCENARIO_CRAFT[craft](), { body: b, pos: st.pos, vel: st.vel, crew: ['Ada'], makeActive: true });
  v.q.copy(st.q); v.updateTelemetry(w.ut);
  return { w, v, b };
}
const tiltOf = v => new Vector3(0, 1, 0).applyQuaternion(v.q).angleTo(v.pos) * DEG;
/** Flies a landing program to the end. → what the ground was where the feet first touched, and how it ended. */
function land(w, v, b, opts = {}) {
  const c = AP.hoverslamLanding(w, v, opts);
  let touch = null, minClear = Infinity;
  AP.fly(w, c, { dt: 0.05, maxSim: 12000, until: () => touch && tiltOf(v) > 60, onStep: () => {
    if (c.phase === 'brake' && v.groundSpeed > 10) minClear = Math.min(minClear, v.radarAlt);
    if (!touch && v.grounded) {
      const d = b.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut, new Vector3());
      touch = { slope: assessSite(b, d, footprint(v)).slope, miss: c.site ? Math.acos(Math.min(1, d.dot(c.site.dir))) * b.radius : NaN };
    }
  } });
  for (let i = 0; i < 200 && !v.dead && tiltOf(v) < 60; i++) w.step(0.1);
  return { c, touch, minClear, tilt: tiltOf(v), standing: !v.dead && v.landed && tiltOf(v) < 25, log: c.log.map(l => l.msg).join(' | ') };
}

test('assessSite: a tilted plane reads its own slope, and a bump on it reads as roughness', () => {
  const plane = formulaWorld((x, y) => 100 + 0.12 * x - 0.05 * y);
  const s = assessSite(plane, plane.base, 4);
  assert.ok(Math.abs(s.slope - Math.atan(Math.hypot(0.12, 0.05))) < 1e-4, 'slope ' + s.slope);
  assert.ok(Math.abs(s.gx - 0.12) < 1e-4 && Math.abs(s.gy + 0.05) < 1e-4, 'which way it tilts');
  assert.ok(Math.abs(s.h - 100) < 1e-6 && s.rough < 1e-3 && !s.water && !s.deck, 'and a plane is not rough: ' + s.rough);
  // a 0.5 m boulder in the middle of level ground: no slope to speak of, half a metre of roughness
  const bump = formulaWorld((x, y) => (Math.hypot(x, y) < 0.5 ? 0.5 : 0));
  const r = assessSite(bump, bump.base, 4);
  assert.ok(r.slope < 0.01 && r.rough > 0.4 && r.rough < 0.55, JSON.stringify(r));
});

test('assessSite: the sea is water, the barge is a deck', () => {
  const home = SYSTEM.home, barge = SYSTEM.sites.barge.dir;
  const deck = assessSite(home, barge, 4);
  assert.ok(deck.deck && !deck.water, 'a deck stands on the sea and is not the sea');
  const sea = at({ base: barge.clone().normalize(), east: new Vector3().crossVectors(Y, barge).normalize(), north: Y.clone(), radius: home.radius }, 3000, 0);
  assert.ok(assessSite(home, sea, 4).water, '3 km off the barge is open water');
});

test('findSite: picks the level shelf beside a slope, the same one every time, and says when there is none', () => {
  // a 20 degree hillside with a level shelf 60 m across, 120 m to the east
  const hill = formulaWorld((x, y) => (Math.hypot(x - 120, y) < 30 ? 0.364 * 120 : 0.364 * x));
  const a = findSite(hill, hill.base, { radius: 4, reach: 300, limit: 0.1 });
  const b = findSite(hill, hill.base, { radius: 4, reach: 300, limit: 0.1 });
  assert.ok(a.ok && a.slope < 0.01, 'found level ground: ' + JSON.stringify({ ...a, dir: undefined }));
  const x = a.dir.dot(hill.east) * hill.radius / a.dir.dot(hill.base), y = a.dir.dot(hill.north) * hill.radius / a.dir.dot(hill.base);
  assert.ok(Math.hypot(x - 120, y) < 30 - 12, `on the shelf and clear of its edge: ${x.toFixed(0)}, ${y.toFixed(0)}`);
  assert.ok(a.dir.distanceTo(b.dir) === 0, 'the same question gets the same answer');
  assert.ok(Math.abs(a.here.slope - Math.atan(0.364)) < 0.01, 'and it reports what the ground was at the start');
  // out of reach of the shelf: nothing fit, and the answer says so
  const none = findSite(hill, hill.base, { radius: 4, reach: 60, limit: 0.1 });
  assert.ok(!none.ok && none.fitCount === 0 && none.dir && none.slope > 0.3, JSON.stringify({ ...none, dir: undefined }));
  // already on fit ground: stays
  const stay = findSite(hill, at(hill, 120, 0), { radius: 4, reach: 300, limit: 0.1 });
  assert.ok(stay.ok && stay.dist === 0);
});

test('slopeLimit: well inside the angle at which the lander tips over its own feet', () => {
  for (const name of ['Wayfarer (lander)', 'Pellfarer (lander)']) {
    const { w, v } = inOrbit('pell', 0, name);
    v.setLegs(true); w.step(0.05);
    const tip = Math.atan2(v.baseRadius, v.baseHeight), lim = slopeLimit(v);
    assert.ok(lim <= 0.4 * tip + 1e-9 && lim >= 0.026 && lim <= 0.105, `${name}: limit ${(lim * DEG).toFixed(1)}°, tips at ${(tip * DEG).toFixed(1)}°`);
    assert.ok(footprint(v) >= v.baseRadius + 2 - 1e-9);
  }
});

test('landing autopilot: from a point of Pell orbit where the old program fell over, it moves to fit ground and stands', () => {
  // the old program, kept behind terrain: false, comes down on whatever is below: here a 16 degree slope
  const a = inOrbit('pell', 2 * Math.PI / 6 + 0.1);
  const old = land(a.w, a.v, a.b, { terrain: false });
  assert.ok(!old.standing && old.touch.slope * DEG > 10, `the old program fell here: tilt ${old.tilt.toFixed(0)}° on ${(old.touch.slope * DEG).toFixed(0)}°`);
  const n = inOrbit('pell', 2 * Math.PI / 6 + 0.1);
  const r = land(n.w, n.v, n.b);
  assert.ok(r.c.done && !r.c.failed && r.standing, r.log);
  assert.ok(r.c.site && r.c.site.ok && !r.c.warning, 'it chose ground fit to stand on: ' + r.log);
  assert.ok(r.touch.slope <= slopeLimit(n.v) * 1.3, `and came down on it: ${(r.touch.slope * DEG).toFixed(1)}° under the feet`);
  assert.ok(r.touch.miss < 3, `within ${r.touch.miss.toFixed(1)} m of the chosen spot`);
  assert.ok(r.tilt < 10, 'upright: ' + r.tilt.toFixed(1) + '°');
});

test('landing autopilot: what it found on the ground is called out to the pilot', () => {
  const n = inOrbit('pell', 2 * Math.PI / 6 + 0.1);
  const r = land(n.w, n.v, n.b);
  const calls = r.c.log.filter(l => l.call);
  assert.ok(calls.some(l => /moving \d+ m to ground that slopes \d+°/.test(l.msg) || /fit to stand on/.test(l.msg)), r.log);
  assert.ok(calls.every(l => l.call === 'info' || l.call === 'warn'));
});

test('landing autopilot: with no fit ground in reach it says so, goes to the least steep, and sets a warning', () => {
  // (a limit no real ground meets stands in for a lander too top-heavy for this world)
  const n = inOrbit('dray', 0.1);
  const r = land(n.w, n.v, n.b, { slopeLimit: 0.0005, survey: false });
  assert.ok(r.c.warning && /no ground fit to stand on within \d+ m/.test(r.c.warning), r.log);
  assert.ok(r.c.log.some(l => l.call === 'warn'), 'and the pilot is warned');
  assert.ok(r.c.site && !r.c.site.ok && r.c.site.slope <= r.c.site.here + 1e-9, 'it still takes the best there is');
  assert.ok(r.c.done, r.log);
});

test('landing autopilot: the crossing is paid for out of a budget, and given up when the propellant will not cover it', () => {
  const n = inOrbit('pell', 2 * Math.PI / 6 + 0.1);
  // leave little more than the descent needs
  const c = AP.hoverslamLanding(n.w, n.v, { survey: false });
  AP.fly(n.w, c, { dt: 0.05, maxSim: 12000, until: () => c.phase === 'final' });
  for (const p of n.v.partList) { if (p.res.fuel) p.res.fuel *= 0.012; if (p.res.ox) p.res.ox *= 0.012; }
  n.v.estimateDeltaV();
  AP.fly(n.w, c, { dt: 0.05, maxSim: 3000, until: () => n.v.grounded });
  assert.ok(c.site === null || c.site.dist < 60, 'no long crossing on fumes: ' + c.log.map(l => l.msg).join(' | '));
  assert.ok(!n.v.dead, 'and it is still in one piece');
});

test('landing autopilot: the braking burn keeps clear of rising ground on the way down', () => {
  // Sear, from this point of the orbit: without the watch the burn aims at a spot beyond rising ground and meets it
  const a = inOrbit('sear', 0.1);
  const old = land(a.w, a.v, a.b, { terrain: false });
  assert.ok(old.minClear < 20 && !old.standing, `without the watch: ${old.minClear.toFixed(0)} m over the ground at speed, ${old.log}`);
  const n = inOrbit('sear', 0.1);
  const r = land(n.w, n.v, n.b);
  assert.ok(r.minClear > 20, `clearance in the burn ${r.minClear.toFixed(0)} m`);
  assert.ok(r.standing && r.c.done && !r.c.failed, r.log);
});

test('landing autopilot: from orbit it waits for better ground, and the hover point is where it said it would be', () => {
  // somewhere on Slate's orbit the ground ahead is too rough: it must wait there, and land well after the wait
  let waited = 0, flown = 0;
  for (let i = 0; i < 12 && !waited; i++) {
    const n = inOrbit('slate', i / 12 * 2 * Math.PI + 0.1);
    const c = AP.hoverslamLanding(n.w, n.v);
    const t0 = n.w.ut;
    AP.fly(n.w, c, { dt: 0.05, maxSim: 20000, until: () => c.phase !== 'init' && c.phase !== 'survey' });
    flown++;
    if (!c.log.some(l => /staying in orbit/.test(l.msg))) continue;
    waited = n.w.ut - t0;
    assert.ok(c.aim, 'it knows where it is going');
    let hover = null;
    AP.fly(n.w, c, { dt: 0.05, maxSim: 20000, onStep: () => { if (!hover && c.phase === 'final') hover = n.b.inertialToSurfaceDir(n.v.pos.clone().normalize(), n.w.ut, new Vector3()); } });
    const err = Math.acos(Math.min(1, hover.dot(c.aim))) * n.b.radius;
    assert.ok(err < 800, `hover point ${err.toFixed(0)} m from the prediction`);
    for (let k = 0; k < 100; k++) n.w.step(0.1);
    assert.ok(c.done && !c.failed && n.v.landed && tiltOf(n.v) < 25 && c.site && c.site.ok, c.log.map(l => l.msg).join(' | '));
  }
  assert.ok(waited > 30, `one of ${flown} starts waited in orbit (${waited.toFixed(0)} s)`);
});

test('landing autopilot: with no time warp it does not wait in orbit (the demo tour and a pilot in a hurry)', () => {
  const n = inOrbit('pell', 0.1);
  const c = AP.hoverslamLanding(n.w, n.v, { useWarp: false });
  for (let i = 0; i < 400; i++) { c.update(0.05); n.w.step(0.05); }
  assert.ok(c.phase === 'deorbit' || c.phase === 'coast', 'straight to the burn: ' + c.phase);
});

test('booster return: a stage that cannot reach its pad looks at the ground it comes down on and moves to flatter ground', async () => {
  const { dropped, heronBooster } = await import('../tools/booster_dev.mjs');
  const { boosterRecovery } = await import('../../js/core/booster.js');
  const home = SYSTEM.home;
  // 768 km west of the pad, on a 4 degree hillside 640 m up; the target is 20 km off, far out of reach from 6 km up.
  // (Verda's land is gentle, so the limit is set to 2.6 degrees here to give the stage something to avoid.)
  const fly = terrain => {
    const { w, v } = dropped({ alt: 6640, speed: 200, pitch: -89, east: -767944, fuel: 0.2, craft: heronBooster() });
    const c = boosterRecovery(w, v, { target: home.dirFromLatLon(0, (-767944 + 20000) / home.radius), terrain, slopeLimit: 0.045 });
    let touch = null;
    for (let i = 0; i < 40000 && !c.done; i++) {
      c.update(0.02); w.step(0.02);
      if (!touch && v.grounded) touch = assessSite(home, home.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut, new Vector3()), 5).slope;
    }
    return { c, v, touch, log: c.log.map(l => l.msg).join(' | ') };
  };
  const old = fly(false), r = fly(true);
  assert.ok(old.touch > 0.06 && !old.c.site, `without the look it stands where it falls: ${(old.touch * DEG).toFixed(1)}°`);
  assert.ok(/moving \d+ m to ground that slopes/.test(r.log), r.log);
  assert.ok(r.c.site && r.c.site.ok && r.touch < 0.045 && r.touch < old.touch, `with it: ${(r.touch * DEG).toFixed(1)}° under the feet`);
  assert.ok(r.c.done && r.v.landed && tiltOf(r.v) < 4, r.log);
});
