// Reusable boosters, phase 2 (docs/BOOSTERS.md): the fall predictor and the program that flies a stage back.
// Requirement numbers (C2 …) are those of the specification. Every flight here is the game's own physics at 0.02 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../js/core/world.js';
import { Craft } from '../../js/core/craft.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { Vector3 } from '../../js/lib/three.module.min.js';
import * as AP from '../../js/core/autopilot.js';
import { predictFall, groundDistance, boosterRecovery, recoverableStage, returnReserve } from '../../js/core/booster.js';
import { dropped, boosterCraft } from '../tools/booster_dev.mjs';
import { flyReturn } from '../tools/booster_sweep.mjs';

const home = SYSTEM.home;
const tiltOf = v => new Vector3(0, 1, 0).applyQuaternion(v.q).angleTo(v.pos.clone().normalize()) * 180 / Math.PI;
const inside = r => r.ok && r.miss < 10 && Math.abs(r.vs) < 2 && r.hs < 1 && r.tilt < 3;

test('C3: the predictor agrees with the flight: impact point, time, speed and peak dynamic pressure', () => {
  const { w, v } = dropped({ alt: 60000, speed: 620, pitch: 0, east: 40000, fuel: 0.2 });
  v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde';
  for (let i = 0; i < 1500; i++) w.step(0.02);                     // let it settle engine first
  const t0 = w.ut, start = home.inertialToSurfaceDir(v.pos.clone(), w.ut);
  const first = predictFall(home, v.pos, v.vel, v.mass, w.ut, { drag: v.axialDragTable(true), floor: v.baseHeight });
  let low = null, maxQ = 0, worstAngle = 0;
  const nose = new Vector3(), wind = new Vector3();
  while (!v.dead && !v.landed && w.ut - t0 < 900) {
    w.step(0.02);
    if (v.dead) break;
    maxQ = Math.max(maxQ, v.dynamicPressure || 0);
    if ((v.dynamicPressure || 0) > 2000) worstAngle = Math.max(worstAngle, nose.set(0, 1, 0).applyQuaternion(v.q).angleTo(wind.copy(v.surfaceVel).negate()));
    if (!low && v.altitude < 5000) low = { ut: w.ut, pr: predictFall(home, v.pos, v.vel, v.mass, w.ut, { drag: v.axialDragTable(true), floor: v.baseHeight }) };
  }
  const end = home.inertialToSurfaceDir(v.pos.clone(), w.ut), flown = groundDistance(home, start, end);
  const miss = groundDistance(home, first.dir, end);
  assert.ok(flown > 20000, 'a long fall: ' + flown.toFixed(0) + ' m over the ground');
  assert.ok(miss < 0.01 * flown, `impact point within 1 % of the distance flown: ${miss.toFixed(0)} m of ${flown.toFixed(0)} m`);
  assert.ok(groundDistance(home, low.pr.dir, end) < 20, 'within 20 m from 5 km up: ' + groundDistance(home, low.pr.dir, end).toFixed(1) + ' m');
  assert.ok(Math.abs(first.t - (w.ut - t0)) < 1.5, 'time of fall within 1.5 s: ' + (first.t - (w.ut - t0)).toFixed(2));
  assert.ok(Math.abs(first.speed - v.airspeed) < 0.02 * v.airspeed, `impact speed within 2 %: ${first.speed.toFixed(1)} vs ${v.airspeed.toFixed(1)}`);
  assert.ok(Math.abs(first.maxQ - maxQ) < 0.03 * maxQ, `peak dynamic pressure within 3 %: ${first.maxQ.toFixed(0)} vs ${maxQ.toFixed(0)}`);
  // (the control fix that made this possible: fins steer the right way with the air coming from behind)
  assert.ok(worstAngle < 0.05, 'the stage held its engine into the wind through the thick air: worst ' + (worstAngle * 57.3).toFixed(2) + '°');
});

test('C3: a stage brought back from a typical separation lands inside the touchdown targets', () => {
  const r = flyReturn({ alt: 30000, speed: 1000, pitch: 45, east: 20000, fuel: 0.45 });
  assert.ok(inside(r), JSON.stringify({ ...r, log: undefined }) + '\n' + r.log.join('\n'));
  assert.ok(r.log.some(l => /boostback burn/.test(l)) && r.log.some(l => /landing burn/.test(l)) && r.log.some(l => /touchdown/.test(l)));
  assert.ok(r.parts === 12, 'nothing broke off');
});

test('the entry burn: planned from the prediction, flown, and it keeps the skin cooler', () => {
  // (2,000 m/s: below about 1,450 m/s the air's own total temperature is under what any part here can take, so a
  // slower fall needs no burn at all)
  const start = { alt: 80000, speed: 2000, pitch: -5, east: 200000, fuel: 0.4 }, target = home.dirFromLatLon(0, 500000 / home.radius);
  const r = flyReturn(start, { target });
  assert.ok(r.log.some(l => /entry burn needed/.test(l)) && r.log.some(l => /entry burn complete/.test(l)), r.log.join('\n'));
  // (the aim point is open sea 500 km out: it comes down on it as gently as on a pad, and says that it is in the water)
  assert.ok(r.miss < 10 && Math.abs(r.vs) < 2 && r.hs < 1 && r.tilt < 3 && /down in the sea, 0 m from the target/.test(r.log.at(-1)), JSON.stringify({ ...r, log: undefined }) + '\n' + r.log.join('\n'));
  assert.ok(r.maxT < 0.8, 'no part passed 80 % of its temperature limit: ' + r.maxT.toFixed(2));
  // the same fall with nobody burning: the unpowered prediction said it would pass the limit, and it does
  const { w, v } = dropped(start);
  v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde';
  let maxT = 0;
  for (let i = 0; i < 40000 && !v.dead && !v.landed; i++) { w.step(0.02); if (v.dead) break; for (const p of v.partList) maxT = Math.max(maxT, p.temp / p.def.maxTemp); }
  assert.ok(maxT > 0.8 || v.partList.length < 12, 'without the burn the stage overheats: ' + maxT.toFixed(2));
});

test('C7: with too little propellant it says so, keeps the landing burn, and comes down short and gently, in the sea, instead of crashing', () => {
  const r = flyReturn({ alt: 30000, speed: 1000, pitch: 45, east: 20000, fuel: 0.15 });
  assert.ok(r.log.some(l => /cannot reach the target/.test(l)), r.log.join('\n'));
  assert.ok(!r.ok && r.parts === 12 && Math.abs(r.vs) < 2.5 && r.endTilt < 5, 'it still came down upright and in one piece: ' + JSON.stringify({ ...r, log: undefined }));
  assert.ok(/down in the sea, \d+\.\d km from the target/.test(r.log.at(-1)), 'and it does not call a ditching a landing: ' + r.log.at(-1));
  assert.ok(r.miss > 10000, 'and reports how far from the target: ' + r.miss.toFixed(0) + ' m');
});

test('C6: handed the controls part of the way down, the program picks the flight up from there', () => {
  const { w, v } = dropped({ alt: 12000, speed: 260, pitch: -80, east: 300, fuel: 0.2 });
  // a target 150 m from where it would come down by itself: inside what the fins can still do from here
  const free = predictFall(home, v.pos, v.vel, v.mass, w.ut, { drag: v.axialDragTable(true), floor: v.baseHeight });
  const target = free.dir.clone().addScaledVector(new Vector3(0, 1, 0), 150 / home.radius).normalize();
  const c = boosterRecovery(w, v, { target });
  for (let i = 0; i < 20000 && !c.done; i++) { c.update(0.02); w.step(0.02); if (v.dead) { c.update(0.02); break; } }
  assert.ok(c.log[0] && /taking over/.test(c.log[0].msg), c.log.map(l => l.msg).join('\n'));
  assert.ok(c.done && !c.failed && v.landed && tiltOf(v) < 3, c.log.map(l => l.msg).join('\n'));
  assert.ok(c.miss < 10, 'on the target: ' + c.miss.toFixed(1) + ' m');
});

/** Two stages: probe + tank + Sparrow, then a first stage with guidance ring, grid fins and legs. */
export function returner({ legs = true } = {}) {
  const c = new Craft('Test Returner');
  const [pod] = c.setRoot('probe_wisp');
  let cur = pod, first = null, last = null;
  const lower = ['tank_m800', 'tank_m800', 'tank_m400'];
  for (const t of ['tank_m400', 'eng_sparrow', 'dec_m', 'probe_wisp', ...lower, 'eng_goshawk']) {
    const [p] = c.attachStack(t, cur.id, 'bottom'); assert.ok(p, 'attach ' + t);
    if (lower.includes(t)) { if (cur.type === 'probe_wisp') first = p; last = p; }      // (the last ring is the booster's)
    cur = p;
  }
  c.attachRadial('fin_grid', first.id, first.pos.y + 0.6, Math.PI / 4, 4);
  if (legs) c.attachRadial('leg_sprig', last.id, last.pos.y - 0.3, Math.PI / 4, 4);
  c.autoStage();
  return c;
}

test('C2: only a stage with guidance, a burning engine and legs counts as built to come back', () => {
  const w = new World();
  const v = w.launch(returner(), { crew: [] });
  assert.equal(recoverableStage(v), null, 'on the pad the next staging event lights the engine and drops nothing');
  v.ctrl.throttle = 1; w.stage();
  for (let i = 0; i < 100; i++) w.step(0.02);
  const st = recoverableStage(v);
  assert.ok(st && st.dry > 2000 && st.prop > 8000, JSON.stringify(st && { dry: st.dry, prop: st.prop }));
  const need = returnReserve(w, v, home.sites.landing.dir);
  assert.ok(need.kg > 400 && need.kg < need.have, 'just off the pad the return costs little: ' + need.kg.toFixed(0) + ' kg');
  const w2 = new World();
  const v2 = w2.launch(returner({ legs: false }), { crew: [] });
  v2.ctrl.throttle = 1; w2.stage();
  for (let i = 0; i < 100; i++) w2.step(0.02);
  assert.equal(recoverableStage(v2), null, 'without legs it is an ordinary stage');
  assert.equal(returnReserve(w2, v2, home.sites.landing.dir), null);
});

test('C2, B4: a whole flight. The ascent lets the booster go with enough to return, it lands by the pad, the upper stage reaches orbit', () => {
  const w = new World();
  const v = w.launch(returner(), { crew: [] });
  const target = home.sites.landing.dir;
  let booster = null, rec = null, sep = null;
  w.on('decouple', d => {
    if (d.debris.type !== 'ship' || !d.debris.engines.length) return;
    booster = d.debris; rec = boosterRecovery(w, booster, { target }); booster.program = 'recovery';
    booster.updateTelemetry(w.ut); sep = { alt: booster.altitude, speed: booster.airspeed, prop: booster.mass };
  });
  const asc = AP.ascentProgram(w, { vessel: v, targetAlt: 80000, useWarp: false, recover: { target } });
  let tracked = 0, far = 0;
  for (let i = 0; i < 60000 && !(asc.done && rec && rec.done); i++) {
    if (!asc.done) asc.update(0.02);
    if (rec && !rec.done) rec.update(0.02);
    w.step(0.02);
    if (booster && !booster.dead && !booster.landed && booster.pos.distanceTo(v.pos) > 5000) { far++; if (w.tracked.includes(booster)) tracked++; }
  }
  assert.ok(asc.log.some(l => /left in the booster to fly back/.test(l.msg)), asc.log.map(l => l.msg).join('\n'));
  assert.ok(sep && sep.alt > 15000 && sep.alt < 45000 && sep.speed > 600 && sep.speed < 1400, 'separation where a stage can turn round: ' + JSON.stringify(sep));
  assert.ok(far > 1000 && tracked === far, 'the booster kept full physics all the way down, far from the vessel being flown');
  assert.ok(rec.done && !rec.failed && booster.landed, rec.log.map(l => l.msg).join('\n'));
  assert.ok(rec.miss < 10 && tiltOf(booster) < 3, `landed ${rec.miss.toFixed(1)} m from the landing zone, tilt ${tiltOf(booster).toFixed(1)}°`);
  assert.ok(booster.estimateDeltaV() > 50, 'with propellant to spare: ' + booster.estimateDeltaV().toFixed(0) + ' m/s');
  assert.ok(asc.done && !asc.failed && v.periapsis > 70000, `upper stage in orbit: ${(v.apoapsis / 1000).toFixed(1)} × ${(v.periapsis / 1000).toFixed(1)} km`);
  // the landing zone is clear of the pad and of every building (they stand south of the pad)
  assert.ok(groundDistance(home, target, home.sites.pad.dir) > 500);
});

void boosterCraft;
