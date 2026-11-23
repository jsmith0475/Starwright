// Reusable boosters, phase 1 (docs/BOOSTERS.md): a dropped stage that can still be flown keeps full physics at any
// distance from the vessel being watched, holds fast warp off while it is in flight, and can be let go.
// The requirement numbers (A1 …) are those of the specification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, LOAD_RANGE, MAX_TRACKED, PHYSICS_WARP_MAX } from '../../js/core/world.js';
import { Craft, stockCrafts } from '../../js/core/craft.js';
import { SYSTEM } from '../../js/core/bodies.js';
import * as AP from '../../js/core/autopilot.js';

const home = SYSTEM.home;

/** A Skylark-class two-stage rocket whose first stage carries a guidance ring (`ring: false` leaves it off). */
export function boosterRocket({ ring = true } = {}) {
  const c = new Craft('Test Returner');
  const [pod] = c.setRoot('pod_acorn');
  c.attachStack('chute', pod.id, 'top');
  let cur = pod, lowTank = null;
  const types = ['heatshield_m', 'dec_m', 'tank_m400', 'eng_sparrow', 'dec_m', ...(ring ? ['probe_wisp'] : []), 'tank_m800', 'tank_m200', 'eng_goshawk'];
  for (const t of types) { const [p] = c.attachStack(t, cur.id, 'bottom'); assert.ok(p, 'attach ' + t); cur = p; if (t === 'tank_m200') lowTank = p; }
  c.attachRadial('fin', lowTank.id, lowTank.pos.y, Math.PI / 4, 4);
  c.autoStage();
  return c;
}

/** Launch, burn the first stage dry at full throttle straight up and a little east, and separate. → { w, upper, booster, log } */
function toSeparation({ ring = true } = {}) {
  const w = new World();
  const upper = w.launch(boosterRocket({ ring }), { crew: ['Ada'] });
  const log = [];
  w.on('*', (d, type) => log.push({ type, ...d }));
  upper.ctrl.throttle = 1;
  w.stage();
  const first = upper.engines.find(e => e.part.ignited).part;
  for (let i = 0; i < 20000 && !first.flameout; i++) w.step(0.02);
  assert.ok(first.flameout, 'first stage burned out');
  w.stage();
  const booster = log.find(e => e.type === 'decouple').debris;
  return { w, upper, booster, log };
}
const state = v => [v.pos.x, v.pos.y, v.pos.z, v.vel.x, v.vel.y, v.vel.z, v.q.x, v.q.y, v.q.z, v.q.w, v.mass];

test('A1/E2: a dropped stage with a guidance ring is a ship called "booster" and keeps full physics far from the upper stage', () => {
  const { w, upper, booster, log } = toSeparation();
  assert.equal(booster.type, 'ship');
  assert.match(booster.name, / booster$/);
  let far = 0, lowest = Infinity;
  for (let i = 0; i < 3000 && !booster.dead && !booster.landed; i++) {
    w.step(0.02);
    if (booster.dead) break;
    const d = booster.pos.distanceTo(upper.pos);
    if (d > LOAD_RANGE + 200) { far++; assert.equal(booster.onRails, false, 'never put on rails'); assert.ok(w.tracked.includes(booster)); }
    lowest = Math.min(lowest, booster.altitude);
  }
  assert.ok(far > 500, 'the booster was followed well beyond the load range: ' + far + ' steps');
  assert.ok(!log.some(e => e.type === 'message' && e.kind === 'removed'), 'nothing was removed for falling behind');
  assert.ok(Number.isFinite(lowest) && booster.altitude < home.atmo.height);
});

test('A3: the same stage without a guidance ring is debris and is removed as before', () => {
  const { w, booster, log } = toSeparation({ ring: false });
  assert.equal(booster.type, 'debris');
  for (let i = 0; i < 4000 && w.vessels.includes(booster); i++) w.step(0.05);
  assert.ok(booster.dead);
  assert.equal(log.find(e => e.type === 'destroyed').reason, 'atmosphere');
  assert.equal(w.tracked.length, 0);
});

test('A4: the flight does not depend on which vessel is being watched', () => {
  const run = watch => {
    const { w, upper, booster } = toSeparation();
    const out = [];
    for (let i = 1; i <= 2500; i++) {
      if (watch === 'booster' && i === 1) w.switchTo(booster);
      if (watch === 'both' && i % 250 === 0) w.switchTo(w.active === upper ? booster : upper);
      w.step(0.02);
      assert.equal(w.warpIndex, 0);
      if (i % 500 === 0) out.push([...state(upper), ...state(booster)]);
    }
    assert.ok(!upper.dead && !booster.dead);
    return out;
  };
  const a = run('upper'), b = run('booster'), c = run('both');
  for (const [name, other] of [['watching the booster', b], ['switching back and forth', c]]) {
    for (let k = 0; k < a.length; k++) for (let j = 0; j < a[k].length; j++) {
      const x = a[k][j], y = other[k][j];
      assert.ok(Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x)), `${name}: sample ${k} value ${j}: ${x} vs ${y}`);
    }
  }
});

test('A5: fast warp waits for a booster in flight; letting it go frees the warp and the booster meets the usual fate', () => {
  const { w, upper, booster, log } = toSeparation();
  for (let i = 0; i < 6000 && booster.pos.distanceTo(upper.pos) < LOAD_RANGE + 200; i++) w.step(0.02);
  assert.ok(booster.pos.distanceTo(upper.pos) > LOAD_RANGE);
  assert.equal(w.trackedInFlight(), booster);
  upper.ctrl.throttle = 0;
  assert.ok(w.maxWarpIndex() <= PHYSICS_WARP_MAX);
  assert.match(w._limitReason, /booster in flight/);
  assert.equal(w.setWarp(6), PHYSICS_WARP_MAX);
  assert.ok(w.release(booster));
  w.setWarp(0);
  for (let i = 0; i < 50 && !booster.dead; i++) w.step(0.02);
  assert.ok(booster.dead, 'a released booster inside the atmosphere is removed like debris');
  assert.equal(log.filter(e => e.type === 'destroyed').at(-1).reason, 'atmosphere');
  assert.equal(w.trackedInFlight(), null);
});

test('A6: a save taken with a booster in flight restores both vessels, and the booster goes on being flown', () => {
  const { w, upper, booster } = toSeparation();
  for (let i = 0; i < 6000 && booster.pos.distanceTo(upper.pos) < LOAD_RANGE + 200; i++) w.step(0.02);
  assert.ok(w.tracked.includes(booster));
  const w2 = World.fromJSON(JSON.parse(JSON.stringify(w.toJSON())));
  const u2 = w2.getVessel(upper.id), b2 = w2.getVessel(booster.id);
  assert.ok(u2 && b2 && w2.active === u2);
  for (let i = 0; i < 500; i++) { w.step(0.02); w2.step(0.02); }
  assert.ok(!b2.dead && !b2.onRails && w2.tracked.includes(b2));
  assert.ok(b2.pos.distanceTo(booster.pos) < 1, 'same place within a metre: ' + b2.pos.distanceTo(booster.pos));
  assert.ok(u2.pos.distanceTo(upper.pos) < 1);
});

test('A7: a booster that reaches the ground in one piece is not removed; one that crashes is destroyed by the crash, not by distance', () => {
  const { w, upper, booster, log } = toSeparation();
  upper.ctrl.throttle = 0;
  for (let i = 0; i < 40000 && !booster.dead && !booster.landed; i++) w.step(0.02);
  const end = log.filter(e => e.type === 'destroyed' && e.vessel === booster).at(-1);
  if (booster.dead) assert.notEqual(end.reason, 'atmosphere', 'an unguided booster ends on the ground: ' + end.reason);
  else assert.ok(booster.landed && w.vessels.includes(booster));
  assert.ok(booster.pos.length() - home.radius < 3000, 'it came all the way down');
});

test('A2: no more than MAX_TRACKED vessels are flown far from the active one', () => {
  const w = new World();
  const list = [];
  for (let k = 0; k < MAX_TRACKED + 2; k++) {
    const v = w.launch(boosterRocket(), { crew: [] });
    list.push(v);
  }
  const anchor = w.launch(stockCrafts().find(c => c.name === 'Hopper I'), { crew: ['Ada'] });
  // lift every rocket off under full physics next to the pad, then leave them behind by flying the anchor away
  for (const v of list) { v.ctrl.throttle = 1; w.stage(v); }
  w.switchTo(list[0]);
  for (let i = 0; i < 1500; i++) w.step(0.02);
  assert.ok(list.every(v => !v.dead && !v.landed), 'all in flight');
  w.switchTo(anchor);
  w.step(0.02); w.step(0.02);
  assert.ok(w.tracked.length <= MAX_TRACKED, 'tracked ' + w.tracked.length);
  assert.ok(w.tracked.length >= 1);
});

test('B4: a guidance program flies and stages a vessel that is not the one being watched', () => {
  const w = new World();
  const upper = w.launch(boosterRocket(), { crew: ['Ada'] });
  let booster = null;
  w.on('decouple', d => { if (d.debris.type === 'ship') booster = d.debris; });
  const ctl = AP.ascentProgram(w, { vessel: upper, targetAlt: 80000, useWarp: false });
  upper.program = 'ascent';
  for (let i = 0; i < 60000 && !ctl.done; i++) {
    ctl.update(0.02);
    w.step(0.02);
    if (booster && w.active === upper && !booster.dead) w.switchTo(booster);      // watch the booster from separation on
    if (booster && (booster.dead || booster.landed) && w.active !== upper) w.switchTo(upper);
  }
  assert.ok(booster, 'the program staged the stack');
  assert.ok(ctl.done, 'the program ran to its end: ' + ctl.phase);
  assert.ok(!upper.dead, 'the upper stage was flown the whole time');
  if (!ctl.failed) assert.ok(upper.periapsis > home.atmo.height, 'in orbit: ' + upper.periapsis);
});
