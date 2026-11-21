// Landing-leg suspension (roadmap item 1). Each deployed leg is its own spring and damper with a stroke, a hard stop
// at the end of it and a speed at that stop it does not survive (core/vessel.js _contact, docs/LANDING_LEGS.md).
//
// What is checked here, and against what:
//   - on EVERY world with ground a lander comes to rest upright on its feet, the feet on the terrain under them
//     (not in it, not above it), and the legs carry the craft's weight: the springs' sag adds up to g / LEG_W² a leg;
//   - the depth a leg closes to on touchdown agrees with a separate solution of the textbook equation for one mass
//     on a spring and damper (integrated here with a fourth-order Runge-Kutta, sharing no code with the game);
//   - the envelope: slow landings use part of the stroke, faster ones run out of it, faster still break the legs;
//   - a lander set down tilted stands up again below the tipping angle atan(half-stance / height of the centre of
//     mass) and goes over above it; a fast sideways arrival trips it;
//   - what the old contact model got wrong on small moons: a lander frozen in mid-rock or held on one foot by its
//     reaction wheels, feet 10 to 30 cm in the air;
//   - no spring is ever released that nothing compressed (legs unfolded under a standing craft), and the state of
//     the struts survives a save.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Quaternion } from '../../js/lib/three.module.min.js';
import { World } from '../../js/core/world.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { Craft } from '../../js/core/craft.js';
import { Vessel, TUNING } from '../../js/core/vessel.js';

const DEG = 180 / Math.PI;
/** Pod, tank and four struts hung low enough to use their whole stroke before the hull reaches the ground
 *  (`engine`: with an engine under it, and the legs as low as they go: 20 cm under the bell). */
function lander(leg = 'legs', n = 4, { engine = false } = {}) {
  const c = new Craft('Dustfoot');
  const pod = c.setRoot('pod_acorn')[0];
  const tank = c.attachStack('tank_m400', pod.id, 'bottom')[0];
  if (engine) c.attachStack('eng_sparrow', tank.id, 'bottom');
  c.attachRadial(leg, tank.id, tank.pos.y - (engine ? 2.4 : 1.25), Math.PI / 4, n);
  c.autoStage();
  return c;
}
/** The most level few metres of a world (deterministic search), away from water and from the space centre. */
const _flat = new Map();
function flatSite(b) {
  if (_flat.has(b.id)) return _flat.get(b.id);
  let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const d = new Vector3(), e1 = new Vector3(), e2 = new Vector3(), t = new Vector3();
  let dir = null, best = Infinity;
  for (let i = 0; i < 4000; i++) {
    const z = rnd() * 1.2 - 0.6, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    d.set(r * Math.cos(a), z, r * Math.sin(a));
    if (b.ocean && b.terrainHeight(d) < b.seaLevel + 2) continue;
    if (b === SYSTEM.home && d.x > 0.9999) continue;
    e1.set(0, 1, 0).cross(d).normalize(); e2.crossVectors(d, e1);
    const h0 = b.surfaceHeight(d);
    let dev = 0;
    for (let k = 0; k < 8; k++) {
      const an = k * Math.PI / 4, rr = (k % 2 ? 1.4 : 2.5) / b.radius;
      t.copy(d).addScaledVector(e1, Math.cos(an) * rr).addScaledVector(e2, Math.sin(an) * rr).normalize();
      dev = Math.max(dev, Math.abs(b.surfaceHeight(t) - h0));
    }
    if (dev < best) { best = dev; dir = d.clone(); }
  }
  const s = { dir, dev: best };
  _flat.set(b.id, s);
  return s;
}
/** Height of a craft-frame point above the terrain under it, now. */
function clearance(w, v, b, x, y, z) {
  const p = new Vector3(x - v.com.x, y - v.com.y, z - v.com.z).applyQuaternion(v.q).add(v.pos);
  return p.length() - b.radius - b.surfaceHeight(b.inertialToSurfaceDir(p.clone(), w.ut, new Vector3()));
}
/** Where a leg's foot is now: the middle of its sole, the strut closed by what the core says. */
function footClearance(w, v, b, p) {
  const L = p.def.legs, sg = p.flip ? -1 : 1;
  return clearance(w, v, b, p.pos.x + p._ox * L.spread, p.pos.y - (L.reach - (p._comp || 0)) * sg, p.pos.z + p._oz * L.spread);
}
const leanOf = v => new Vector3(0, 1, 0).applyQuaternion(v.q).angleTo(v.pos) * DEG;
/**
 * Put a craft just above the ground (its lowest point `gap` up), legs down, moving at `speed` down and `side` along
 * the ground, leaning by `tilt` (rad, about its X axis: over the line through two of four feet), and let it go.
 */
function drop(b, dir, craft, { speed = 1, tilt = 0, side = 0, gap = 0.03, sas = true, legs = true, maxT = 200, settle = 0, step = 0.02, hud = true } = {}) {
  const w = new World();
  const v = w.launch(craft, { crew: ['Ada'] });
  const up = b.surfaceDirToInertial(dir, w.ut, new Vector3()).normalize();
  v.body = b; v.landed = false; v.splashed = false; v.surface = null; v.onRails = false; v._patch = null; v.launched = true; v.launchUt = w.ut;
  v.setLegs(legs);
  v.q.setFromAxisAngle(new Vector3(0, 1, 0), b.rotationAngle(w.ut)).multiply(World.padFrame(dir));
  if (tilt) v.q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), tilt));
  v.pos.copy(up).multiplyScalar(b.radius + b.surfaceHeight(dir) + 30);
  const low = () => Math.min(...v._pts.map(c => clearance(w, v, b, c.x, c.y, c.z)));
  v.pos.addScaledVector(up, gap - low());
  const wy = 2 * Math.PI / b.rotPeriod;
  v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x).addScaledVector(up, -speed);
  if (side) v.vel.addScaledVector(new Vector3(0, 1, 0).cross(up).normalize(), side);
  v.w.set(0, 0, 0); v.ctrl.throttle = 0; v.ctrl.sas = sas; v.sasTarget = null; v._stamp++; v.updateTelemetry(w.ut);
  const events = [];
  w.on('*', (e, type) => { if (type === 'explosion' || type === 'legBroke' || type === 'legBottom' || type === 'landed' || type === 'destroyed' || type === 'crewLost') events.push(type); });
  const parts = v.parts.size, mass = v.mass;
  let maxComp = 0, meanComp = 0, touched = false, hop = 0, t = 0, maxLean = 0, maxG = 0;
  for (; t < maxT && !v.landed && !v.dead; t += step) {
    w.step(step);
    if (hud) w.maxWarpIndex();      // the flight screen asks this every frame (it used to pin a lander the moment it was slow)
    const c = Math.max(0, ...v.legParts.map(p => p._comp || 0));
    if (c > maxComp) maxComp = c;
    if (v.legParts.length) meanComp = Math.max(meanComp, v.legParts.reduce((a, p) => a + (p._comp || 0), 0) / v.legParts.length);
    if (c > 0 || v.groundContacts > 0) touched = true;
    if (touched && v.groundContacts === 0) hop = Math.max(hop, low());
    if (touched) maxG = Math.max(maxG, v.gForce);
    maxLean = Math.max(maxLean, leanOf(v));
  }
  for (let i = 0; i < settle / 0.05; i++) w.step(0.05);
  return { w, v, b, t, maxComp, meanComp, hop, maxLean, maxG, lean: leanOf(v), broke: parts - v.parts.size, events, mass, has: type => events.includes(type) };
}

const WORLDS = SYSTEM.bodies.filter(b => !b.gas && !b.star && b !== SYSTEM.star && typeof b.surfaceHeight === 'function' && typeof b.terrainHeight === 'function');

test('there are worlds to land on, and every one of them is covered below', () => {
  assert.ok(WORLDS.length >= 12, 'worlds with ground: ' + WORLDS.map(b => b.id).join(', '));
  for (const id of ['verda', 'pell', 'ost', 'rusk', 'cindra', 'tiv', 'dray']) assert.ok(WORLDS.some(b => b.id === id), id + ' is among them');
});

// ---------------------------------------------------------------------------------------------------- at rest, everywhere
for (const b of WORLDS) {
  // 1.5 m/s, less on the smallest moons (0.5 m/s on Wend, where 1.5 m/s is a tenth of the way to orbit)
  const speed = Math.min(1.5, 3 * Math.sqrt(b.surfaceG));
  test(`${b.id} (g ${b.surfaceG.toFixed(2)}): a lander set down at ${speed.toFixed(1)} m/s stands on its feet, feet on the ground, legs carrying its weight`, () => {
    const s = flatSite(b);
    const r = drop(b, s.dir, lander(), { speed, settle: 2, maxT: 400 });
    const { w, v } = r, where = `${b.id} (ground level within ${(s.dev * 100).toFixed(0)} cm)`;
    assert.ok(v.landed && !v.dead, `${where}: it came to rest (${r.t.toFixed(0)} s)`);
    assert.equal(r.broke, 0, `${where}: nothing broke`);
    assert.ok(r.lean < 6 + Math.atan(s.dev / 1.3) * DEG, `${where}: upright (lean ${r.lean.toFixed(1)}°)`);
    const legs = v.legParts, feet = legs.map(p => footClearance(w, v, b, p));
    // no foot in the ground; at least three of four on it (a rigid craft on rough ground may hold the fourth up)
    for (let i = 0; i < legs.length; i++) assert.ok(feet[i] > -0.015, `${where}: foot ${i} is ${(-feet[i] * 100).toFixed(1)} cm inside the ground`);
    const down = feet.filter(h => h < 0.02).length;
    assert.ok(down >= 3, `${where}: ${down} of ${legs.length} feet on the ground (clearances ${feet.map(h => (h * 100).toFixed(1)).join(', ')} cm)`);
    // the springs carry the weight: sum of k x = m g, with k = m LEG_W² / legs  →  sum of x = legs × g / LEG_W²
    const g = b.gm / v.pos.lengthSq(), want = legs.length * g / (TUNING.LEG_W * TUNING.LEG_W), got = legs.reduce((a, p) => a + (p._comp || 0), 0);
    assert.ok(Math.abs(got - want) < 0.08 * want + 0.004, `${where}: the struts are closed by ${(got * 100).toFixed(2)} cm in all, the weight asks for ${(want * 100).toFixed(2)} cm`);
    // nothing but the feet touches
    const hull = Math.min(...v._pts.filter(c => !c.leg).map(c => clearance(w, v, b, c.x, c.y, c.z)));
    assert.ok(hull > 0.1, `${where}: the hull is clear of the ground (${(hull * 100).toFixed(0)} cm)`);
  });
}

// ---------------------------------------------------------------------------------------------------- against the textbook
/** Peak closure of one mass on a spring and damper that meets the ground at `v0`: x'' = g − W² x − 2 ζ W x'. RK4, 0.1 ms. */
function textbookPeak(v0, g, W, zIn) {
  let x = 0, v = v0, peak = 0;
  const acc = (x, v) => g - W * W * x - 2 * zIn * W * v;
  const h = 1e-4;
  for (let i = 0; i < 100000 && v > 0; i++) {
    const k1x = v, k1v = acc(x, v);
    const k2x = v + 0.5 * h * k1v, k2v = acc(x + 0.5 * h * k1x, v + 0.5 * h * k1v);
    const k3x = v + 0.5 * h * k2v, k3v = acc(x + 0.5 * h * k2x, v + 0.5 * h * k2v);
    const k4x = v + h * k3v, k4v = acc(x + h * k3x, v + h * k3v);
    x += h / 6 * (k1x + 2 * k2x + 2 * k3x + k4x); v += h / 6 * (k1v + 2 * k2v + 2 * k3v + k4v);
    if (x > peak) peak = x;
  }
  return peak;
}
test('the depth a leg closes to on touchdown matches a separate solution of the spring-and-damper equation', () => {
  const rows = [];
  for (const id of ['verda', 'rusk', 'pell']) {
    const b = SYSTEM.byId[id], s = flatSite(b);
    for (const speed of [1, 2, 3]) {
      const r = drop(b, s.dir, lander(), { speed, gap: 0.002, step: 0.01 });
      const g = b.gm / r.v.pos.lengthSq();
      // falling the last 2 mm adds a little speed
      const v0 = Math.sqrt(speed * speed + 2 * g * 0.002);
      const want = textbookPeak(v0, g, TUNING.LEG_W, TUNING.LEG_ZETA);
      // the four legs together are the one spring of the equation: their mean closure (the ground is not quite level)
      rows.push(`${id} ${speed} m/s: game ${(r.meanComp * 100).toFixed(2)} cm, textbook ${(want * 100).toFixed(2)} cm`);
      assert.ok(want < 0.31, 'inside the stroke, where the equation holds');
      assert.ok(Math.abs(r.meanComp - want) < 0.03 * want + 0.002, `${id}, ${speed} m/s: the legs closed ${(r.meanComp * 100).toFixed(2)} cm, the textbook says ${(want * 100).toFixed(2)} cm`);
    }
  }
  for (const row of rows) console.log('#   ' + row);
});

// ---------------------------------------------------------------------------------------------------- the envelope
test('the landing envelope at home: gentle uses part of the stroke, hard runs out of it, too hard breaks the legs', () => {
  const b = SYSTEM.home, s = flatSite(b), stroke = 0.32;
  const at = speed => drop(b, s.dir, lander(), { speed });
  const log = [];
  for (const speed of [1, 2, 3]) {
    const r = at(speed);
    log.push(`${speed} m/s: closed ${(r.maxComp * 100).toFixed(0)} of ${stroke * 100} cm, ${r.maxG.toFixed(1)} g`);
    assert.ok(r.v.landed && r.broke === 0 && !r.has('legBottom'), `${speed} m/s: a clean landing`);
    assert.ok(r.maxComp < stroke - 0.03, `${speed} m/s: travel to spare (${(r.maxComp * 100).toFixed(1)} cm)`);
    assert.ok(r.maxG < 5, `${speed} m/s: the crew feel ${r.maxG.toFixed(1)} g`);
  }
  let last = 0;
  for (const speed of [1, 2, 3]) { const c = at(speed).maxComp; assert.ok(c > last + 0.02, 'faster closes the legs further'); last = c; }
  {
    const r = at(5.5);
    log.push(`5.5 m/s: bottomed out, ${r.maxG.toFixed(1)} g, nothing broke`);
    assert.ok(r.has('legBottom'), '5.5 m/s: the legs run out of travel');
    assert.ok(r.v.landed && r.broke === 0, '5.5 m/s: and hold');
    assert.ok(Math.abs(r.maxComp - stroke) < 0.005, 'the strut stops at the end of its stroke');
    assert.ok(r.maxG > 6, `5.5 m/s: the hard stop is felt (${r.maxG.toFixed(1)} g)`);
  }
  {
    const r = at(8);
    log.push(`8 m/s: ${r.v.legParts.length} legs left, ${r.events.filter(e => e === 'legBroke').length} collapsed`);
    assert.ok(r.has('legBroke'), '8 m/s: legs collapse');
    assert.equal(r.v.legParts.length, 0, '8 m/s: all four');
    assert.ok(!r.has('crewLost') && !r.v.dead, '8 m/s: the crew walk away from it');
  }
  {
    const r = at(13);
    assert.ok(r.has('legBroke') && r.broke > 4 && r.v.legParts.length === 0, '13 m/s: the legs, and the tank that comes down on the ground after them');
  }
  {
    // past what a strut takes on first touch (14 m/s) it is gone at once, and takes little of the speed with it:
    // arriving faster is never the safer way down
    const r = at(16);
    assert.ok(r.has('explosion') && r.broke > 4, '16 m/s: worse than 13, not better');
  }
  for (const row of log) console.log('#   ' + row);
});

test('a bigger leg has more travel: the heavy strut takes a landing the standard one bottoms out on, the small one less', () => {
  const b = SYSTEM.home, s = flatSite(b);
  const std = drop(b, s.dir, lander('legs', 4, { engine: false }), { speed: 5.5 });
  const heavy = drop(b, s.dir, lander('leg_stilt', 4, { engine: false }), { speed: 5.5 });
  assert.ok(std.has('legBottom') && !heavy.has('legBottom'), 'at 5.5 m/s the standard strut bottoms out and the heavy one does not');
  assert.ok(heavy.maxComp > 0.33 && heavy.maxComp < 0.55, `the heavy strut used ${(heavy.maxComp * 100).toFixed(0)} of its 55 cm`);
  // same spring rule, so the same sag at rest
  const a = drop(b, s.dir, lander('legs', 4, { engine: false }), { speed: 0.5, settle: 2 }), c = drop(b, s.dir, lander('leg_stilt', 4, { engine: false }), { speed: 0.5, settle: 2 });
  const sag = r => r.v.legParts.reduce((x, p) => x + p._comp, 0) / 4;
  assert.ok(Math.abs(sag(a) - sag(c)) < 0.006, `both sag the same at rest: ${(sag(a) * 100).toFixed(1)} and ${(sag(c) * 100).toFixed(1)} cm`);
  // three legs carry what four did: each closes by a third more
  const three = drop(b, s.dir, lander('leg_stilt', 3, { engine: false }), { speed: 0.5, settle: 2 });
  assert.ok(three.v.landed && three.lean < 3, 'a tripod stands');
  assert.ok(Math.abs(sag(three) * 4 / 3 - sag(c)) < 0.006, 'and sags the same: the springs are sized to the mass over the legs that are down');
});

// ---------------------------------------------------------------------------------------------------- weak gravity
test('where gravity is weak a firm landing does not turn into a flight: Pell, Ost and Dray at 3 m/s', () => {
  for (const id of ['pell', 'ost', 'dray']) {
    const b = SYSTEM.byId[id], s = flatSite(b);
    const r = drop(b, s.dir, lander(), { speed: 3, settle: 2 });
    console.log(`#   ${id}: closed ${(r.maxComp * 100).toFixed(0)} cm, hopped ${(r.hop * 100).toFixed(0)} cm, at rest after ${r.t.toFixed(0)} s, lean ${r.lean.toFixed(1)}°`);
    assert.ok(r.v.landed && r.broke === 0, `${id}: down in one piece`);
    assert.ok(r.hop < 0.25, `${id}: the rebound lifts the feet ${(r.hop * 100).toFixed(0)} cm`);
    assert.ok(r.maxLean < 12 && r.lean < 6 + Math.atan(s.dev / 1.3) * DEG, `${id}: it stays on its feet (most lean ${r.maxLean.toFixed(1)}°)`);
    assert.ok(r.t < 60, `${id}: and is at rest in ${r.t.toFixed(0)} s`);
  }
});

test('a lander is not left frozen on one or two feet: with the attitude hold on, on rough ground, on the smallest moons', () => {
  // the old model pinned these with feet 10 to 30 cm in the air (the reaction wheels held the craft up on one foot)
  for (const id of ['dray', 'nym', 'nock', 'wend', 'slate', 'pell']) {
    const b = SYSTEM.byId[id];
    if (!b) continue;
    // the rough spot the old fault was found on: the first site with about 3° of slope
    let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const d = new Vector3(), n = new Vector3(); let dir = null, best = 99;
    for (let i = 0; i < 2000; i++) {
      const z = rnd() * 1.2 - 0.6, a = rnd() * 6.283, r = Math.sqrt(1 - z * z); d.set(r * Math.cos(a), z, r * Math.sin(a));
      b.terrainNormal(d, n); const sl = Math.acos(Math.min(1, n.dot(d))) * DEG;
      if (Math.abs(sl - 3) < best) { best = Math.abs(sl - 3); dir = d.clone(); }
    }
    const r = drop(b, dir, lander(), { speed: 0.3, gap: 0.5, sas: true, maxT: 400, settle: 2 });
    const feet = r.v.legParts.map(p => footClearance(r.w, r.v, b, p));
    const down = feet.filter(h => h < 0.02).length;
    assert.ok(r.v.landed && r.broke === 0, `${id}: at rest`);
    assert.ok(down >= 3, `${id}: ${down} of 4 feet on the ground when it is pinned (clearances ${feet.map(h => (h * 100).toFixed(1)).join(', ')} cm)`);
    assert.ok(Math.min(...feet) > -0.015, `${id}: no foot in the ground`);
  }
});

test('the flight screen does not freeze a lander at the bottom of its touchdown', () => {
  // World.maxWarpIndex() is asked every frame by the HUD, and pinned the active vessel as soon as it moved slower
  // than 0.3 m/s over the ground: a lander coming straight down was frozen where it first touched, struts closed
  // (or, with the old stiff contact, feet in the ground). Every drop in this file asks it each step, as the game does.
  const b = SYSTEM.byId.pell, s = flatSite(b);
  const g = b.surfaceG, sag = g / (TUNING.LEG_W * TUNING.LEG_W);
  const r = drop(b, s.dir, lander(), { speed: 3, hud: true, settle: 2 });
  assert.ok(r.meanComp > 0.15, `it closed its legs ${(r.meanComp * 100).toFixed(0)} cm on the way in`);
  const rest = r.v.legParts.reduce((a, p) => a + p._comp, 0) / 4;
  assert.ok(r.v.landed && Math.abs(rest - sag) < 0.004, `and is pinned once it has come back up to its sag: ${(rest * 100).toFixed(1)} cm (the weight asks ${(sag * 100).toFixed(1)} cm)`);
  assert.ok(r.t > 2, `not in the first instant (${r.t.toFixed(1)} s)`);
});

// ---------------------------------------------------------------------------------------------------- tipping
test('the tipping point is where the centre of mass passes over the feet: atan(half-stance / height)', () => {
  const b = SYSTEM.home, s = flatSite(b);
  const probe = new World().launch(lander(), { crew: ['Ada'] });
  probe.setLegs(true);
  const p = probe.legParts[0], L = p.def.legs;
  const rFoot = Math.hypot(p.pos.x + p._ox * L.spread - probe.com.x, p.pos.z + p._oz * L.spread - probe.com.z);
  const half = rFoot * Math.SQRT1_2;                    // from the axis to the line through two neighbouring feet
  const h = probe.com.y - (p.pos.y - L.reach);          // centre of mass above the soles
  const crit = Math.atan(half / h) * DEG;
  console.log(`#   stance ${(2 * half).toFixed(2)} m between the lines of feet, centre of mass ${h.toFixed(2)} m up: tips at ${crit.toFixed(1)}°`);
  assert.ok(crit > 15 && crit < 50, 'a sensible lander');
  const under = drop(b, s.dir, lander(), { speed: 0, tilt: (crit - 4) / DEG, sas: false, gap: 0.01, settle: 1 });
  const over = drop(b, s.dir, lander(), { speed: 0, tilt: (crit + 4) / DEG, sas: false, gap: 0.01, settle: 1 });
  assert.ok(under.v.landed && under.lean < 4, `let go ${(crit - 4).toFixed(1)}° over, it rocks back onto its feet (lean ${under.lean.toFixed(1)}°)`);
  assert.ok(over.lean > 60, `let go ${(crit + 4).toFixed(1)}° over, it goes over (lean ${over.lean.toFixed(1)}°)`);
  // a wider stance stands steeper: the heavy struts reach further out
  const wide = new World().launch(lander('leg_stilt'), { crew: ['Ada'] });
  wide.setLegs(true);
  const q = wide.legParts[0], Lw = q.def.legs;
  const critW = Math.atan(Math.hypot(q.pos.x + q._ox * Lw.spread - wide.com.x, q.pos.z + q._oz * Lw.spread - wide.com.z) * Math.SQRT1_2 / (wide.com.y - (q.pos.y - Lw.reach))) * DEG;
  const held = drop(b, s.dir, lander('leg_stilt'), { speed: 0, tilt: (crit + 4) / DEG, sas: false, gap: 0.01, settle: 1 });
  assert.ok(critW > crit + 4 && held.lean < 4, `on the wide struts (tipping at ${critW.toFixed(1)}°) the same lean stands up again`);
});

test('coming in sideways trips a lander: a metre a second it rides out, fast enough it goes over', () => {
  const b = SYSTEM.byId.pell, s = flatSite(b);
  const slow = drop(b, s.dir, lander(), { speed: 1, side: 1, sas: false, settle: 1 });
  assert.ok(slow.v.landed && slow.lean < 5 && slow.broke === 0, `1 m/s across the ground: it slides, rocks and stands (most lean ${slow.maxLean.toFixed(1)}°)`);
  let fell = null;
  for (const side of [3, 5, 7, 9]) {
    const r = drop(b, s.dir, lander(), { speed: 1, side, sas: false, settle: 1 });
    if (r.lean > 60 || r.broke > 0) { fell = side; break; }
  }
  console.log(`#   Pell, 1 m/s down: over (or broken) from ${fell} m/s sideways`);
  assert.ok(fell !== null, 'fast enough sideways, it does not stay on its feet');
});

// ---------------------------------------------------------------------------------------------------- no free energy
test('legs unfolded under a standing craft lift it gently: no spring is released that nothing compressed', () => {
  for (const id of ['pell', 'dray']) {
    const b = SYSTEM.byId[id], s = flatSite(b);
    // set down on the engine bell, legs stowed
    const r = drop(b, s.dir, lander(), { speed: 0.2, legs: false, sas: false, maxT: 120 });
    const { w, v } = r;
    assert.ok(v.landed && r.broke === 0, `${id}: standing on its engine`);
    const h0 = v.pos.length();
    v.setLegs(true);
    let top = 0, fastest = 0;
    for (let i = 0; i < 1500; i++) { w.step(0.02); top = Math.max(top, v.pos.length() - h0); fastest = Math.max(fastest, v.verticalSpeed); if (v.landed && i > 100) break; }
    // the feet reach 0.6 m below the bell on this craft: it is raised by that much, at walking pace, and no further
    const feet = v.legParts.map(p => footClearance(w, v, b, p));
    console.log(`#   ${id}: raised ${(top * 100).toFixed(0)} cm, fastest ${fastest.toFixed(2)} m/s`);
    assert.ok(fastest < 0.6, `${id}: fastest ${fastest.toFixed(2)} m/s on the way up`);
    assert.ok(top < 0.75, `${id}: lifted ${(top * 100).toFixed(0)} cm, onto its legs and no further`);
    assert.ok(v.landed && r.v.parts.size === r.v.parts.size && Math.min(...feet) > -0.015 && feet.filter(x => x < 0.02).length >= 3, `${id}: and stands on them (${feet.map(x => (x * 100).toFixed(1)).join(', ')} cm)`);
  }
});

test('the struts open again on the way up, and how far they are closed survives a save', () => {
  const b = SYSTEM.byId.rusk, s = flatSite(b);
  const r = drop(b, s.dir, lander('legs', 4, { engine: true }), { speed: 1, settle: 1 });
  const { w, v } = r;
  const comp = v.legParts.map(p => p._comp);
  assert.ok(comp.every(c => c > 0.015), 'closed at rest: ' + comp.map(c => (c * 100).toFixed(1)).join(', ') + ' cm');
  const v2 = Vessel.fromJSON(JSON.parse(JSON.stringify(v.toJSON())));
  assert.deepEqual(v2.legParts.map(p => +p._comp.toFixed(3)), comp.map(c => +c.toFixed(3)), 'a loaded lander is drawn as it was saved');
  // lift off: full throttle
  v.ctrl.throttle = 1;
  v.activateNextStage();
  for (let i = 0; i < 400 && v.radarAlt < 5; i++) w.step(0.02);
  assert.ok(v.radarAlt >= 5, 'it lifts off (radar altitude ' + v.radarAlt.toFixed(1) + ' m)');
  assert.ok(v.legParts.every(p => p._comp === 0), 'in the air the struts hang at full length');
});

// ---------------------------------------------------------------------------------------------------- lying on its side
/** The contact-suite lander: pod, separator, tank, engine, four struts (tests/e2e/contact.mjs LANDER). */
function fallenLander() {
  const c = new Craft('Dustfoot');
  const pod = c.setRoot('pod_acorn')[0];
  const dec = c.attachStack('dec_m', pod.id, 'bottom')[0];
  const tank = c.attachStack('tank_m400', dec.id, 'bottom')[0];
  c.attachStack('eng_sparrow', tank.id, 'bottom');
  c.attachRadial('legs', tank.id, tank.pos.y - 1.85, Math.PI / 4, 4);
  c.autoStage();
  return c;
}
/**
 * Lowest point of the craft's round outline above the ground, sampled 96 to a circle (the contact model has 16):
 * both rims of every stack part, the collar of a separator (drawn 4 cm proud) and the rim of every foot pad.
 */
function outlineClearance(w, v, b) {
  let low = Infinity, at = '';
  const circle = (p, cx, cy, cz, r, name) => {
    for (let i = 0; i < 96; i++) {
      const a = i * Math.PI / 48, h = clearance(w, v, b, cx + r * Math.cos(a), cy, cz + r * Math.sin(a));
      if (h < low) { low = h; at = name; }
    }
  };
  for (const p of v.parts.values()) {
    const d = p.def;
    if (p._stack) {
      circle(p, p.pos.x, p.pos.y - d.h / 2, p.pos.z, p._rB ?? d.rBottom, d.id + ' bottom rim');
      circle(p, p.pos.x, p.pos.y + d.h / 2, p.pos.z, p._rT ?? d.rTop, d.id + ' top rim');
      if (d.shape === 'decoupler') circle(p, p.pos.x, p.pos.y, p.pos.z, d.rBottom + 0.04, d.id + ' collar');
    } else if (d.legs && p.deployed) {
      const L = d.legs, sg = p.flip ? -1 : 1, ls = d.h / 1.2, fr = (d.variant === 'heavy' ? 0.26 : 0.2) * ls;
      circle(p, p.pos.x + p._ox * L.spread, p.pos.y - (L.reach - (p._comp || 0) - 0.025 * ls) * sg, p.pos.z + p._oz * L.spread, fr, d.id + ' pad rim');
    }
  }
  return { low, at };
}
for (const id of ['verda', 'pell', 'rusk']) {
  test(`${id}: a lander that has gone over lies on the ground, not in it (round hull, separator collar and foot pads within 2.5 cm)`, () => {
    const b = SYSTEM.byId[id], s = flatSite(b);
    for (const tilt of [75, 100]) {
      const r = drop(b, s.dir, fallenLander(), { speed: 0.5, tilt: tilt / DEG, sas: false, settle: 2, maxT: 600 });
      const { w, v } = r;
      assert.ok(v.landed && !v.dead, `${id}, let go at ${tilt}°: it came to rest (${r.t.toFixed(0)} s)`);
      assert.ok(r.lean > 50, `${id}, let go at ${tilt}°: it lies on its side (lean ${r.lean.toFixed(0)}°)`);
      const o = outlineClearance(w, v, b);
      assert.ok(o.low > -(0.025 + s.dev), `${id}, let go at ${tilt}°, lean ${r.lean.toFixed(0)}°: the ${o.at} is ${(-o.low * 100).toFixed(1)} cm inside the ground`);
      assert.ok(o.low < 0.06 + s.dev, `${id}, let go at ${tilt}°: and it is not floating (${(o.low * 100).toFixed(1)} cm up at the ${o.at})`);
    }
  });
}
