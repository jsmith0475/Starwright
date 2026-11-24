// The catch tower (js/core/tower.js, docs/SHEARWATER.md): where it stands, what its arms will and will not take,
// what a held stage is, and the whole flight: launch from the mount, stage, fly back, be caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Quaternion } from '../../js/lib/three.module.min.js';
import { Vessel, surfaceAt, propIn } from '../../js/core/vessel.js';
import { World } from '../../js/core/world.js';
import { Craft, stockCrafts } from '../../js/core/craft.js';
import { SYSTEM, TOWER } from '../../js/core/bodies.js';
import { catchState, catchFault, catchPins, armsClosed, armPose, strikeTower, ARM, COLUMN } from '../../js/core/tower.js';
import { flyReturn } from '../tools/tower_dev.mjs';

const home = SYSTEM.home, site = SYSTEM.sites.tower, Y = new Vector3(0, 1, 0), TAU = Math.PI * 2;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''}: ${a} vs ${b}`);
/** The Stalwart booster on its own: ring, two tanks, 33 engines, three fins and two pins (or four legs). */
function booster({ legs = false, pins = 2 } = {}) {
  const c = new Craft('Stalwart');
  let [cur] = c.setRoot('ring_hotstage'); const ring = cur;
  let top = null, last = null;
  for (const t of ['tank_xxl_long', 'tank_xxl_long', 'eng_peregrine33']) { [cur] = c.attachStack(t, cur.id, 'bottom'); if (!top) top = cur; if (t !== 'eng_peregrine33') last = cur; }
  const y = top.pos.y + 18.75 / 2;
  if (pins) c.attachRadial('pin_catch', top.id, y - 3.4, Math.PI / 4, pins === 2 ? 2 : 1);
  if (legs) c.attachRadial('leg_heron', last.id, last.pos.y - 18.75 / 2 + 1.9, Math.PI / 4, 4);
  c.autoStage();
  void ring;
  return c;
}
/** A booster in the air over the mount: base `clearance` m above it, `east` m off its axis, sinking at `sink`, sliding at `drift`, leaning `tilt` rad. */
function over({ clearance = 6, east = 0, sink = 1.2, drift = 0, tilt = 0, craft = booster(), fuel = 0.05 } = {}) {
  const w = new World(), ut = w.ut;
  const dir = site.dir.clone().normalize(), R = home.radius + surfaceAt(home, dir) + 60;
  const up = home.surfaceDirToInertial(dir, ut, new Vector3()).normalize();
  const eastV = new Vector3().crossVectors(Y, up).normalize();
  const q = new Quaternion().setFromAxisAngle(Y, home.rotationAngle(ut)).multiply(World.padFrame(dir));
  if (tilt) q.premultiply(new Quaternion().setFromAxisAngle(eastV, tilt));
  const pos = up.clone().multiplyScalar(R).addScaledVector(eastV, east), wy = TAU / home.rotPeriod;
  const vel = new Vector3(wy * pos.z, 0, -wy * pos.x).addScaledVector(up, -sink).addScaledVector(eastV, drift);
  const v = w.spawn(craft, { crew: [], pos, vel, q });
  for (const p of v.partList) for (const k of ['lox', 'ch4']) if (p.res[k]) p.res[k] *= fuel;
  v._updateMass(false);
  const s = catchState(w, v, {});
  if (s) v.pos.addScaledVector(up, clearance - s.clearance);
  const events = [];
  w.on('*', (d, type) => { if (['caught', 'catchMissed', 'destroyed', 'landed', 'liftoff', 'towerStrike'].includes(type)) events.push({ type, ...d }); });
  return { w, v, events };
}
/** Hold the sink rate with the centre three while the test watches. */
function descend(w, v, sink, seconds, until = () => false, mode = 2) {
  for (const en of v.engines) { en.part.ignited = true; v.setEngineMode(en.part.id, mode); }
  v.ctrl.sas = true;
  for (let t = 0; t < seconds && !until(); t += 0.02) {
    const up = v.pos.clone().normalize(), wy = TAU / home.rotPeriod;
    const vs = new Vector3(v.vel.x - wy * v.pos.z, v.vel.y, v.vel.z + wy * v.pos.x).dot(up);
    const g = home.gm / v.pos.lengthSq(), a = v.enginePower().thrust / v.mass;
    if (!v.landed) v.ctrl.throttle = Math.min(1, Math.max(0, (g + (-sink - vs) * 2.5) / a));
    w.step(0.02);
  }
}

test('the tower site: on the home world, inside the space centre, clear of the launch pad and the Return Pad', () => {
  assert.equal(site.name, 'Catch Tower');
  const d = to => Math.acos(Math.min(1, site.dir.dot(to.dir))) * home.radius;
  near(d(SYSTEM.sites.pad), Math.hypot(TOWER.east, TOWER.north), 1, 'distance from the pad');
  assert.ok(d(SYSTEM.sites.pad) > 300 && d(SYSTEM.sites.landing) > 300, 'a returning stage at one site is not over another');
  assert.ok(Math.abs(surfaceAt(home, site.dir) - surfaceAt(home, SYSTEM.sites.pad.dir)) < 3, 'level with the pad');
  near(TOWER.height, 146 * 5 / 8, 0.5, 'five-eighths of 146 m');
  assert.ok(TOWER.hang > 1 && TOWER.reach > 2 && TOWER.maxSink > 2);
});

test('a stack launched from the tower stands on its mount, and going up through the arms is not a catch', () => {
  const c = stockCrafts().find(x => x.name === 'Shearwater');
  const w = new World(), v = w.launch(c, { crew: ['Ada', 'Bo'], site: 'tower' });
  assert.equal(v.launchSite, 'tower'); assert.equal(v.situation, 'prelaunch');
  near(Math.acos(Math.min(1, v.surface.dir.dot(site.dir))) * home.radius, 0, 0.01, 'on the mount');
  const seen = []; w.on('*', (d, type) => { if (type === 'caught' || type === 'catchMissed') seen.push(type); });
  v.ctrl.throttle = 1; w.stage(v);
  for (let i = 0; i < 600; i++) w.step(0.02);
  assert.ok(v.altitude > 50 && !v.landed, 'it has left: ' + v.altitude);
  assert.deepEqual(seen, []);
});

test('the arms take a stage that comes down slowly over the mount, and hold it', () => {
  const { w, v, events } = over({ clearance: 8, sink: 1.2, east: 1.5, tilt: 0.03 });
  assert.equal(catchPins(v), 2);
  assert.ok(armsClosed(w) === 0, 'open until it has been seen coming down');
  descend(w, v, 1.2, 12, () => v.landed);
  const e = events.find(x => x.type === 'caught');
  assert.ok(e, 'caught: ' + JSON.stringify(events.map(x => [x.type, x.reason])));
  assert.ok(v.landed && v.surface.held === 'tower' && !v.dead);
  near(e.clearance, TOWER.hang, TOWER.window + 0.1, 'taken at the hang height');
  assert.ok(e.speed < 2 && e.offset > 1 && e.offset < TOWER.reach, `at ${e.speed} m/s, ${e.offset} m off the axis: the arms came to it`);
  assert.equal(armsClosed(w), 1);
  assert.equal(v.ctrl.throttle, 0);
  // it hangs there: upright after a moment, not sinking, whatever is asked of it short of its engines
  const R0 = v.pos.length();
  v.wake(); v.ctrl.pitch = 1;
  for (let i = 0; i < 500; i++) w.step(0.02);
  v.ctrl.pitch = 0;
  assert.ok(v.landed && v.surface.held === 'tower');
  near(v.pos.length(), R0, 1e-6, 'height');
  const tilt = new Vector3(0, 1, 0).applyQuaternion(v.q).angleTo(v.pos.clone().normalize());
  assert.ok(tilt < 1e-3, 'stood upright: ' + tilt);
  assert.equal(events.filter(x => x.type === 'landed' || x.type === 'destroyed').length, 0);
  // a save keeps it in the arms
  const back = Vessel.fromJSON(JSON.parse(JSON.stringify(v.toJSON())));
  assert.ok(back.landed && back.surface.held === 'tower' && back.surface.fixed);
  // and its own engines take it out again
  for (const en of v.engines) v.setEngineMode(en.part.id, 1);
  v.ctrl.throttle = 1;
  for (let i = 0; i < 100; i++) w.step(0.02);
  assert.ok(!v.landed && v.pos.length() > R0 + 1, 'lifted out of the arms');
});

test('what the arms will not take: too fast, too far off, sliding, leaning', () => {
  for (const [what, o, re] of [
    ['too fast', { sink: 9 }, /coming down at/],
    ['too far off', { east: TOWER.reach + 2.5 }, /from the mount/],
    ['sliding', { east: -2, drift: 3 }, /sliding sideways/],
    ['leaning', { tilt: 0.3 }, /leaning/],
  ]) {
    const { w, v, events } = over({ clearance: TOWER.hang + TOWER.window + 0.2, sink: 1.5, ...o });      // (in free fall: started just above the arms)
    for (let i = 0; i < 100 && !events.length; i++) w.step(0.02);
    const e = events.find(x => x.type === 'catchMissed');
    assert.ok(e && e.type === 'catchMissed', what + ': ' + JSON.stringify(events.map(x => x.type)));
    assert.match(e.reason, re, what);
    assert.ok(!v.landed || !v.surface.held, what + ': not held');
    assert.equal(events.filter(x => x.type === 'catchMissed').length, 1, what + ': said once');
  }
  for (const s of [{ offset: 0, vs: -1, drift: 0, tilt: 0, rate: 0 }, { offset: TOWER.reach, vs: -TOWER.maxSink, drift: TOWER.maxDrift, tilt: TOWER.maxTilt, rate: TOWER.maxRate }]) assert.equal(catchFault(s), '');
});

test('the tower leaves alone a stage with legs, a stage with one pin, and anything far away', () => {
  for (const craft of [booster({ legs: true }), booster({ pins: 1 })]) {
    const { w, v, events } = over({ clearance: 5, sink: 1.2, craft });
    descend(w, v, 1.2, 4);
    assert.ok(!events.some(e => e.type === 'caught' || e.type === 'catchMissed'), craft.parts.length + ' parts');
    assert.ok(!(v.surface && v.surface.held));
  }
  const { w, v } = over({ clearance: 5, east: 900 });
  assert.equal(catchState(w, v, {}), null);
});

test('the whole return: launched from the mount, staged by the assist, flown back and caught, with the ship in orbit', () => {
  const r = flyReturn();
  const log = r.rec.log.map(l => l.msg);
  assert.ok(r.rec.done && !r.rec.failed, log.join(' | '));
  assert.match(log[log.length - 1], /caught by the tower/);
  const e = r.events.find(x => x.type === 'caught');
  assert.ok(e && e.speed < TOWER.maxSink && e.offset < TOWER.reach, JSON.stringify(e));
  assert.ok(r.booster.landed && r.booster.surface.held === 'tower' && !r.booster.dead);
  assert.equal(r.events.filter(x => x.type === 'destroyed' || x.type === 'catchMissed').length, 0);
  assert.equal(r.events.filter(x => x.type === 'towerStrike').length, 0, 'it never touched the steel, going up or coming back');
  assert.ok(r.left > 1500, `propellant to spare in the booster: ${r.left.toFixed(0)} kg`);
  assert.ok(log.some(m => /boostback burn/.test(m)) && log.some(m => /landing burn/.test(m)));
  // it flew the burns on the inner thirteen and the last metres on the centre three
  assert.equal(r.booster.partList.find(p => p.type === 'eng_peregrine33').mode, 2);
  assert.ok(r.asc.done && !r.asc.failed && r.v.periapsis > 70000, 'the ship is in orbit');
  const full = r.v.partList.reduce((m, p) => m + propIn(p.res, 'methalox'), 0) / r.v.partList.reduce((m, p) => m + propIn(p.def.res, 'methalox'), 0);
  assert.ok(full > 0.3 && full < 0.6 && r.v.deltaV < 1800, `the ship still needs the depot: ${(full * 100).toFixed(0)} % full`);
});

test('tower: a caught stage is turned so its two pins lie north and south, one over each rail', () => {
  const r = flyReturn({ alt: 80e3 });
  const b = r.booster, s = b.surface;
  assert.equal(s.held, 'tower');
  for (let i = 0; i < 200 && s.qTarget; i++) r.w.step(0.05);
  const pins = b.partList.filter(p => p.def.catchPin);
  assert.equal(pins.length, 2);
  const q = s.qTarget || s.qRel, up = s.dir.clone().normalize();
  const d = pins[0].pos.clone().sub(pins[1].pos).applyQuaternion(q);
  const north = new Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
  assert.ok(Math.abs(d.dot(up)) < 0.05, 'the pins are level');
  assert.ok(Math.abs(Math.abs(d.normalize().dot(north)) - 1) < 1e-3, 'and in line north to south: ' + d.dot(north).toFixed(4));
  assert.ok(d.length() > 0.99);
});

/** The booster's east (m) off the mount's axis, and its speed that way. */
function eastOf(w, v) {
  const up = home.surfaceDirToInertial(site.dir, w.ut, new Vector3()).normalize(), ev = new Vector3().crossVectors(Y, up).normalize();
  const o = up.clone().multiplyScalar(home.radius + surfaceAt(home, site.dir)), wy = TAU / home.rotPeriod;
  return { east: v.pos.clone().sub(o).dot(ev), ve: new Vector3(v.vel.x - wy * v.pos.z, v.vel.y, v.vel.z + wy * v.pos.x).dot(ev) };
}

test('solid steel: a booster swinging into the column at speed is destroyed', () => {
    // 30 m up beside the mount, carried west into the column at 20 m/s (a tank gives way at 7 and the whole stage at 2.2
  // times that), holding its height on its engines
  const { w, v, events } = over({ clearance: 30, east: -1, drift: -20, sink: 0, fuel: 0.3 });
  descend(w, v, 0, 2, () => v.dead, 1);
  const hit = events.find(e => e.type === 'towerStrike');
  assert.ok(hit && hit.lost, 'struck and lost: ' + JSON.stringify(events.map(e => [e.type, e.part, e.lost])));
  assert.ok(v.dead, 'nothing left');
  assert.equal(events.find(e => e.type === 'destroyed').reason, 'tower');
});

test('solid steel: a slow touch stops the stage against the column instead of passing through it', () => {
  const { w, v, events } = over({ clearance: 30, east: -2, drift: -1.5, sink: 0, fuel: 0.3 });
  const face = COLUMN.x1 - 2.8125;          // the booster's axis when its side meets the column's east face
  let west = 0;
  descend(w, v, 0, 5, () => { west = Math.min(west, eastOf(w, v).east); return v.dead; }, 1);      // (holding its height on the inner thirteen)
  const hit = events.find(e => e.type === 'towerStrike');
  assert.ok(hit && !hit.lost && hit.broken === 0, 'scraped, nothing broken: ' + JSON.stringify(events.map(e => [e.type, e.lost])));
  assert.ok(!v.dead && v.partList.length === booster().parts.length, 'whole');
  assert.ok(west > face - 0.3, `stopped at the steel: ${west.toFixed(2)} m, the face is at ${face.toFixed(2)}`);
  assert.ok(eastOf(w, v).ve > -0.1, 'no longer moving into it');
});

test('solid steel: a closing arm is steel too, and the arms wait open for a stage hovering out of line', () => {
  // the arms do not close on a stage low down and more than its reach off the axis
  const { w, v } = over({ clearance: 10, east: TOWER.reach + 3, sink: 1 });
  descend(w, v, 1, 2);
  assert.ok(catchState(w, v, {}).offset > TOWER.reach + 2.5);
  assert.ok(armsClosed(w) < 0.05, 'open: ' + armsClosed(w));
  // a stage dropped onto a closed arm, off its pins, is stopped by it
  const pose = armPose(1, 30, 0, 0);
  for (const a of pose.arms) {
    assert.ok(Math.abs(a.hx - (COLUMN.x1 + 0.95)) < 1e-9, 'hinged on the column');
    const tipZ = a.hz + a.uz * ARM.length;
    assert.ok(Math.sign(tipZ) === a.s && Math.abs(tipZ) - ARM.half > 2.8 && Math.abs(tipZ) - ARM.half < 3.3, 'closed, each passes beside the stage: ' + tipZ.toFixed(2));
  }
  const open = armPose(0, 30, 0, 0);
  for (const a of open.arms) near(Math.atan2(Math.abs(a.uz), a.ux), ARM.open, 1e-9, 'open at 50 degrees');
  // a stage the arms are not catching (legs, no pins), 3 m south of the axis and sinking, runs into a shut arm
  const b = over({ clearance: 20, sink: 6, craft: booster({ legs: true, pins: 0 }) });
  const up = b.v.pos.clone().normalize(), south = new Vector3().crossVectors(new Vector3().crossVectors(Y, up).normalize(), up);
  b.v.pos.addScaledVector(south, 3);
  const ev = [];
  assert.ok(strikeTower(b.w, b.v, ev, armPose(1, 40, 0, 0)), 'it touched');
  assert.ok(ev.some(e => e.type === 'towerStrike'), 'and said so');
  assert.equal(strikeTower(b.w, b.v, [], armPose(0, 40, 0, 0)), false, 'with the arms open it passes');
});
