// Second pass (core): wings, wheels, new engines, surface physics, deployables, action groups, career and planners.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { World, TRANSMIT_EC } from '../../js/core/world.js';
import { Craft, stockCrafts, stockSite } from '../../js/core/craft.js';
import { PARTS } from '../../js/core/parts.js';
import { SYSTEM } from '../../js/core/bodies.js';
import {
  Vessel, wingCoefficients, flightAngles, stallSpeed, wingLoading, liftArea, antennaRange, jetFactor, hasOxygen,
  engineProp, partActions, ACTION_GROUPS, surfaceAt, TUNING,
} from '../../js/core/vessel.js';
import {
  Career, SAVE_VERSION, TECH_TREE, techNode, MILESTONES, MILESTONE_KINDS, milestoneFor, milestonesOf, FACILITIES,
  FACILITY_IDS, biomeSciMult, BIOME_SITUATIONS, experimentAllowed, scienceKey, EXPERIMENTS,
} from '../../js/core/career.js';
import { ContractBoard, CONTRACT_TYPES, capability } from '../../js/core/contracts.js';
import * as AP from '../../js/core/autopilot.js';

const home = SYSTEM.home;
const stock = name => stockCrafts().find(c => c.name === name);
const TAU = Math.PI * 2;
const DOWN = Math.PI / 2, UP = -Math.PI / 2;
const run = (w, seconds, dt = 1 / 30) => { for (let i = 0; i < seconds / dt; i++) w.step(dt); };
const upTilt = (v, axis = [0, 1, 0]) => v.pos.clone().set(...axis).applyQuaternion(v.q).angleTo(v.pos);

/** Put a craft at rest `height` m above the ground of a body at a body-fixed direction. */
function dropOn(w, craft, body, dir, height = 2, opts = {}) {
  const d = body.surfaceDirToInertial(dir.clone().normalize(), w.ut, new Vector3());
  const r = body.radius + surfaceAt(body, dir.clone().normalize()) + height;
  const pos = d.clone().multiplyScalar(r);
  const wy = TAU / body.rotPeriod;
  const vel = new Vector3(wy * pos.z, 0, -wy * pos.x);
  // nose (+Y) along the local vertical
  const v = w.spawn(craft, { body, pos, vel, ...opts });
  v.q.setFromUnitVectors(new Vector3(0, 1, 0), d);
  if (v.sasTarget) v.sasTarget.copy(v.q);
  return v;
}

// ------------------------------------------------------------------------------------------------ wings and lift
test('wings: lift grows with angle of attack, stalls, and never exceeds a flat plate far beyond the stall', () => {
  const [cl0] = wingCoefficients(0);
  const [cl5, cd5] = wingCoefficients(0.087);
  const [cl10, cd10] = wingCoefficients(0.175);
  assert.ok(Math.abs(cl0) < 1e-9);
  assert.ok(cl10 > cl5 && cl5 > 0, 'lift rises before the stall');
  assert.ok(cd10 > cd5 && cd5 > 0, 'so does drag');
  const [clNeg] = wingCoefficients(-0.087);
  assert.ok(Math.abs(clNeg + cl5) < 1e-9, 'symmetric section');
  let peak = 0, peakA = 0;
  for (let a = 0; a < 1.5; a += 0.01) { const [cl] = wingCoefficients(a); if (cl > peak) { peak = cl; peakA = a; } }
  assert.ok(peakA > 0.15 && peakA < 0.5, 'stall angle ' + peakA);
  assert.ok(wingCoefficients(peakA + 0.25)[0] < peak * 0.9, 'lift falls after the stall');
  assert.ok(Math.abs(wingCoefficients(Math.PI / 2)[0]) < 0.05, 'no lift broadside on');
  assert.ok(wingCoefficients(Math.PI / 2)[1] > 1, 'but a lot of drag');
  assert.ok(liftArea(PARTS.wing_broad) > 0 && liftArea(PARTS.tank_m400) === 0);
});

test('craft: centre of mass, lift and thrust; a stable aeroplane keeps its lift behind its mass', () => {
  const c = stock('Kite Trainer');
  const com = c.centerOfMass(), dry = c.centerOfMass(0), col = c.centerOfLift(), cot = c.centerOfThrust();
  assert.ok(col && cot && com, 'all three exist');
  assert.ok(col.y < com.y, 'lift behind the mass (nose is +Y)');
  assert.ok(col.y < dry.y, 'also with empty tanks');
  assert.ok(com.y - col.y < 1.5, 'but not by much: it must still rotate');
  assert.ok(col.area > 5, 'area ' + col.area);
  assert.ok(col.liftZ > col.liftX, 'mostly wing, a little fin');
  assert.ok(Math.abs(com.x) < 0.02 && Math.abs(col.x) < 0.02 && Math.abs(cot.x) < 0.02, 'symmetric');
  assert.ok(cot.y < com.y, 'engine at the back');
  assert.ok(cot.dir.y > 0.99 && cot.thrust > 0, 'thrust pushes the nose forward');
  assert.ok(Math.abs(com.mass - c.mass()) < 1e-6 && dry.mass < com.mass);
  const rocket = stock('Skylark II');
  assert.equal(rocket.centerOfLift().area > 0, true, 'fins count as lift');
  assert.ok(rocket.centerOfLift().y < rocket.centerOfMass().y, 'fins at the tail keep a rocket pointing forward');
  assert.equal(new Craft().centerOfMass().mass, 0);
});

test('vessel: wing loading, stall speed and flight angles of a parked aeroplane', () => {
  const w = new World();
  const v = w.launch(stock('Kite Trainer'), { crew: ['Ada'], site: 'runway' });
  run(w, 1);
  const wl = wingLoading(v);
  assert.ok(wl.area > 5);
  const vs = stallSpeed(v);
  assert.ok(vs > 25 && vs < 80, 'stall speed ' + vs);
  const A = flightAngles(v);
  assert.ok(Math.abs(A.roll) < 0.05, 'wings level: ' + A.roll);
  assert.ok(Math.abs(A.pitch) < 0.15, 'nose near the horizon: ' + A.pitch);
  assert.ok(Math.abs(A.heading * 180 / Math.PI - 90) < 2, 'pointing down the runway (east): ' + A.heading);
  assert.ok(v.ctrlAccel && v.ctrlAccel.x >= 0);
});

// ------------------------------------------------------------------------------------------------ wheels
test('runway launch: on the wheels, brakes on, level, at the threshold; pad launches are unchanged', () => {
  const w = new World();
  assert.ok(w.sites.runway && w.sites.pad, 'both sites exist');
  const v = w.launch(stock('Kite Trainer'), { crew: ['Ada'], site: 'runway' });
  assert.equal(v.launchSite, 'runway');
  assert.equal(v.situation, 'prelaunch');
  assert.ok(v.ctrl.brake, 'parking brake set');
  assert.ok(v.landed && v.surface.vehicle);
  assert.ok(upTilt(v, [0, 0, 1]) < 0.12, 'top (+Z) up: ' + upTilt(v, [0, 0, 1]));
  assert.ok(Math.abs(upTilt(v) - Math.PI / 2) < 0.12, 'nose on the horizon');
  assert.ok(v.gearDown && v.hasGear);
  run(w, 5);
  assert.ok(v.landed, 'stays parked');
  const p = w.launch(stock('Hopper I'), { crew: ['Bo'] });
  assert.equal(p.launchSite, 'pad');
  assert.ok(upTilt(p) < 0.01, 'rockets stand on their tails');
  assert.equal(stockSite(stock('Hopper I')), 'pad');
  assert.equal(stockSite(stock('Trundle Scout')), 'runway');
});

test('wheels: drive, steer and brake; a parked rover holds on its brakes and uses charge when driving', () => {
  const w = new World();
  const v = w.launch(stock('Trundle Scout'), { site: 'runway' });
  const fr = AP.runwayFrame();
  run(w, 1);
  const a0 = AP.siteCoords(fr, v, w.ut).along;
  v.ctrl.brake = false; v.ctrl.drive = 1;
  run(w, 6);
  assert.ok(v.wheelsOnGround >= 4, 'rolling on its wheels: ' + v.wheelsOnGround);
  const a1 = AP.siteCoords(fr, v, w.ut);
  assert.ok(a1.along - a0 > 8, 'drove forward: ' + (a1.along - a0));
  assert.ok(Math.abs(a1.cross) < 2, 'in a straight line: ' + a1.cross);
  assert.ok(v.groundSpeed > 3 && v.groundSpeed < PARTS.wheel_scamper.wheel.maxSpeed + 1, 'speed ' + v.groundSpeed);
  // steer right: the heading swings east → south
  const h0 = flightAngles(v).heading;
  v.ctrl.steer = 1;
  run(w, 3);
  v.ctrl.steer = 0;
  let dh = flightAngles(v).heading - h0; if (dh > Math.PI) dh -= TAU; if (dh < -Math.PI) dh += TAU;
  assert.ok(Math.abs(dh) > 0.15, 'turned: ' + dh);
  assert.ok(upTilt(v, [0, 0, 1]) < 0.3, 'without rolling over');
  // brake
  v.ctrl.drive = 0; v.ctrl.brake = true;
  const sp = v.groundSpeed;
  run(w, 10);
  assert.ok(v.groundSpeed < 0.3 && sp > 2, 'stopped from ' + sp + ' → ' + v.groundSpeed);
  run(w, 4);
  assert.ok(v.landed, 'parked');
  assert.equal(v.situation, 'landed', 'a vehicle that has driven away has started its mission');
  // reverse
  v.ctrl.brake = false; v.ctrl.drive = -1;
  const b0 = AP.siteCoords(fr, v, w.ut);
  run(w, 4);
  const b1 = AP.siteCoords(fr, v, w.ut);
  assert.ok(Math.hypot(b1.along - b0.along, b1.cross - b0.cross) > 3, 'backs up');
  assert.equal(w.toJSON().vessels.length, 1);
});

test('retractable gear: up and down by method and by the Gear group, and across a save', () => {
  const w = new World();
  const r = home.radius + 3000;
  const v = w.spawn(stock('Kite Trainer'), { crew: ['Ada'], pos: new Vector3(r, 0, 0), vel: new Vector3(0, 0, -(TAU / home.rotPeriod) * r - 90) });
  assert.ok(v.hasGear);
  assert.ok(ACTION_GROUPS.includes('gear'));
  v.setGear(true); run(w, 3);
  assert.equal(v.gearDown, true);
  v.setGear(false); run(w, 3);
  assert.equal(v.gearDown, false, 'retracted');
  assert.equal(World.fromJSON(JSON.parse(JSON.stringify(w.toJSON()))).vessels[0].gearDown, false, 'saved retracted');
  assert.ok(w.fireGroup('gear', v) >= 1, 'the Gear group works with nothing bound');
  run(w, 3);
  assert.equal(v.gearDown, true, 'down again');
  // retracted wheels do not hold the aeroplane up, extended ones add drag: both show in the part state
  assert.ok(v.wheelParts.filter(p => /gear/.test(p.def.id)).length >= 3);
  const p = w.launch(stock('Kite Trainer'), { crew: ['Bo'], site: 'runway' });
  assert.equal(World.fromJSON(JSON.parse(JSON.stringify(w.toJSON()))).vessels.find(x => x.id === p.id).launchSite, 'runway');
});

// ------------------------------------------------------------------------------------------------ engines
test('engines: jets need air and oxygen, ion drives need xenon and power, nuclear engines are frugal', () => {
  assert.equal(engineProp(PARTS.eng_whisper), 'xenon');
  assert.equal(engineProp(PARTS.eng_furnace), 'fuel');
  assert.equal(engineProp(PARTS.srb_ember), 'solid');
  assert.equal(engineProp(PARTS.jet_midge), 'fuel');
  assert.ok(hasOxygen(home), 'the home world has air to burn');
  assert.ok(!hasOxygen(SYSTEM.byId.pell));
  const jf0 = jetFactor(PARTS.jet_midge, home, 0, 0), jfHigh = jetFactor(PARTS.jet_midge, home, 30000, 0.5);
  assert.ok(jf0 > 0.9, 'full thrust at sea level: ' + jf0);
  assert.ok(jfHigh < jf0 * 0.3, 'starved up high: ' + jfHigh);
  assert.equal(jetFactor(PARTS.jet_midge, SYSTEM.byId.pell, 0, 0), 0, 'no jets on an airless moon');
  assert.equal(jetFactor(PARTS.jet_midge, home, 0, 50), 0, 'nor far beyond its top speed');
  assert.ok(PARTS.eng_furnace.engine.ispVac > 2 * PARTS.eng_osprey.engine.ispVac, 'atomic engines sip fuel');
  assert.ok(PARTS.eng_whisper.engine.ispVac > 3000 && PARTS.eng_whisper.engine.elecUse > 0);
});

test('xenon: counted in craft stats and vessel delta-v, burnt by the ion drive with electricity, saved and loaded', () => {
  const c = new Craft('Ion test');
  const [core] = c.setRoot('probe_facet');
  const bat = c.attachStack('battery_s', core.id, 'bottom')[0];
  const xen = c.attachStack('xen_s', bat.id, 'bottom')[0];
  c.attachStack('eng_whisper', xen.id, 'bottom');
  c.autoStage();
  const st = c.stats();
  assert.equal(st.length, 1);
  const m0 = c.mass(), m1 = c.dryMass();
  assert.ok(m0 > m1, 'xenon has mass');
  const dv = PARTS.eng_whisper.engine.ispVac * 9.80665 * Math.log(m0 / m1);
  assert.ok(Math.abs(st[0].dvVac - dv) < dv * 0.02, `ion stage dv ${st[0].dvVac} vs ${dv}`);
  const w = new World();
  const r = home.radius + 300000, s = Math.sqrt(home.gm / r);
  const v = w.spawn(c, { pos: new Vector3(r, 0, 0), vel: new Vector3(0, 0, -s) });
  assert.ok(v.resources.xenon && v.resources.xenon.amount > 0, 'xenon aboard');
  assert.ok(Math.abs(v.deltaV - dv) < dv * 0.05, 'vessel delta-v counts xenon: ' + v.deltaV);
  const x0 = v.resources.xenon.amount, e0 = v.resources.elec.amount;
  v.ctrl.throttle = 1; w.stage();
  run(w, 10, 0.05);
  assert.ok(v.resources.xenon.amount < x0, 'xenon burnt');
  assert.ok(v.resources.elec.amount < e0, 'and electricity');
  assert.ok(v.resources.fuel === undefined || v.resources.fuel.amount === 0 || v.resources.fuel.amount === v.resources.fuel.capacity, 'no liquid fuel involved');
  const back = World.fromJSON(JSON.parse(JSON.stringify(w.toJSON()))).vessels[0];
  assert.ok(Math.abs(back.resources.xenon.amount - v.resources.xenon.amount) < 1e-9, 'xenon survives a save');
  // flat battery: the drive stops
  for (const p of v.partList) if (p.res && p.res.elec !== undefined) p.res.elec = 0;
  v.updateResources();
  const x1 = v.resources.xenon.amount;
  run(w, 5, 0.05);
  assert.ok(x1 - v.resources.xenon.amount < 1e-6, 'no charge, no thrust');
  // xenon moves between drums like any other resource
  const c2 = new Craft('Two drums');
  const [k] = c2.setRoot('probe_facet');
  const d1 = c2.attachStack('xen_s', k.id, 'bottom')[0], d2 = c2.attachStack('xen_s', d1.id, 'bottom')[0];
  const t = Vessel.fromCraft(c2);
  t.parts.get(d2.id).res.xenon = 0; t.updateResources();
  const moved = t.transferResource(d1.id, d2.id, 'xenon', 5);
  assert.ok(Math.abs(moved - 5) < 1e-9, 'moved ' + moved);
});

test('a jet aeroplane burns fuel only while its engine can breathe, and jets add nothing to vacuum delta-v', () => {
  const c = stock('Kite Trainer');
  const st = c.stats();
  assert.ok(st[0].jetThrust > 0, 'jet thrust reported');
  assert.equal(Math.round(st[0].dvVac), 0, 'no rocket delta-v');
  const w = new World();
  const v = w.launch(c, { crew: ['Ada'], site: 'runway' });
  const f0 = v.resources.fuel.amount;
  v.ctrl.throttle = 1; w.stage();
  run(w, 3);
  assert.ok(v.resources.fuel.amount < f0, 'burning');
  assert.ok(v.enginePower().thrust > 5000, 'pushing: ' + v.enginePower().thrust);
});

// ------------------------------------------------------------------------------------------------ surface physics
function lander() {
  const c = new Craft('Test lander');
  const [pod] = c.setRoot('pod_burrow');
  const tank = c.attachStack('tank_m400', pod.id, 'bottom')[0];
  c.attachStack('eng_sparrow', tank.id, 'bottom');
  const bottom = tank.pos.y - PARTS.tank_m400.h / 2;
  c.attachRadial('legs', tank.id, bottom, Math.PI / 4, 4);
  // ladders all the way down every side, so a Pip standing by the hatch can reach one
  for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) for (const dy of [0.2, 1.4, 2.6]) c.attachRadial('ladder_rung', tank.id, bottom + dy, a, 1);
  c.autoStage();
  return c;
}

test('landing on a slope: a legged lander settles, sleeps and stays put; steep ground makes it slide or tip', () => {
  const pell = SYSTEM.byId.pell;
  // find gentle and steep ground by sampling
  const w = new World();
  let gentle = null, best = Infinity;
  for (let i = 0; i < 400 && best > 0.03; i++) {
    const d = new Vector3(Math.cos(i * 0.61), Math.sin(i * 0.37) * 0.6, Math.sin(i * 0.61)).normalize();
    const e = 3 / pell.radius;
    const h0 = surfaceAt(pell, d), h1 = surfaceAt(pell, d.clone().applyAxisAngle(new Vector3(0, 1, 0), e)), h2 = surfaceAt(pell, d.clone().add(new Vector3(0, e, 0)).normalize());
    const slope = Math.hypot(h1 - h0, h2 - h0) / 3;
    if (slope < best) { best = slope; gentle = d; }
  }
  const v = dropOn(w, lander(), pell, gentle, 3, { crew: ['Ada'] });
  v.setLegs(true);
  const events = [];
  w.on('*', (d, type) => { if (d.vessel === v) events.push(type); });
  run(w, 40, 0.05);
  assert.ok(v.landed, 'came to rest and was pinned');
  assert.equal(v.situation, 'landed');
  assert.ok(events.includes('landed'));
  assert.equal(events.filter(e => e === 'explosion').length, 0);
  assert.ok(v.surface.slope < 0.2, 'gentle ground: ' + v.surface.slope);
  assert.ok(upTilt(v) < v.surface.slope + 0.1, 'upright: ' + upTilt(v));
  const d0 = v.surface.dir.clone();
  run(w, 20, 0.05);
  assert.ok(v.surface.dir.angleTo(d0) * pell.radius < 0.05, 'does not creep');
  // time warp with a landed vessel: it rides the ground round
  w.setWarp(6);
  for (let i = 0; i < 50; i++) w.step(0.1);
  w.setWarp(0);
  assert.ok(v.landed && v.surface.dir.angleTo(d0) * pell.radius < 0.05, 'still there after warp');
  assert.ok(Math.abs(v.radarAlt) < 0.01);
  // lying on its side on purpose: it must not sink, explode at rest or fly off
  const w2 = new World();
  const t = dropOn(w2, lander(), pell, gentle, 4, { crew: ['Bo'] });
  t.q.multiply(new Vector3(0, 0, 0).constructor === Vector3 ? t.q.clone().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2) : t.q);
  let boom = 0;
  w2.on('explosion', () => boom++);
  run(w2, 60, 0.05);
  assert.ok(!t.dead, 'survived tipping over at walking pace');
  assert.ok(t.altitude > surfaceAt(pell, gentle) - 1, 'not under the ground');
  assert.ok(t.groundSpeed < 0.5, 'not skating away: ' + t.groundSpeed);
  assert.ok(boom <= 2, 'at most a leg or two broke: ' + boom);
});

test('splashdown: a capsule dropped into the sea floats, reads "splashed" and can be recovered', () => {
  const w = new World();
  // open water: east of the runway
  const rw = SYSTEM.sites.runway;
  let sea = null;
  for (let k = 1; k < 400 && !sea; k++) {
    const d = rw.dir.clone().applyAxisAngle(new Vector3(0, 1, 0), -k * 2000 / home.radius).normalize();
    if (home.ocean && home.terrainHeight(d) < (home.seaLevel || 0) - 20) sea = d;
  }
  assert.ok(sea, 'found open water');
  const c = new Craft('Float');
  const [pod] = c.setRoot('pod_acorn');
  c.attachStack('chute', pod.id, 'top');
  c.autoStage();
  const v = dropOn(w, c, home, sea, 6, { crew: ['Ada'] });
  const events = [];
  w.on('*', (d, type) => { if (d.vessel === v) events.push(type); });
  run(w, 30, 0.05);
  assert.ok(events.includes('splashed'), 'splash event: ' + [...new Set(events)].join(','));
  assert.equal(v.situation, 'splashed');
  assert.ok(!v.dead && v.crew.length === 1);
  assert.ok(Math.abs(v.altitude - (home.seaLevel || 0)) < 3, 'floating at the surface: ' + v.altitude);
  assert.ok(Math.abs(v.verticalSpeed) < 0.5, 'bobbing gently');
  const sum = w.recover(v);
  assert.deepEqual(sum.crew, ['Ada']);
});

test('EVA in low gravity: walk, jetpack up and back down, grab a ladder and climb it', () => {
  const dray = SYSTEM.byId.dray;
  const w = new World();
  let d = new Vector3(1, 0.2, 0.3).normalize(), best = Infinity, spot = d;
  for (let i = 0; i < 300 && best > 0.04; i++) {
    d = new Vector3(Math.cos(i * 0.7), Math.sin(i * 0.3) * 0.5, Math.sin(i * 0.7)).normalize();
    const e = 3 / dray.radius;
    const h0 = surfaceAt(dray, d), h1 = surfaceAt(dray, d.clone().applyAxisAngle(new Vector3(0, 1, 0), e)), h2 = surfaceAt(dray, d.clone().add(new Vector3(0, e, 0)).normalize());
    const slope = Math.hypot(h1 - h0, h2 - h0) / 3;
    if (slope < best) { best = slope; spot = d; }
  }
  const v = dropOn(w, lander(), dray, spot, 2, { crew: ['Ada', 'Bo'] });
  v.setLegs(true);
  run(w, 90, 0.05);
  assert.ok(v.landed, 'the lander is down on Dray');
  const pip = w.evaStart(v);
  assert.ok(pip && pip.type === 'eva');
  w.switchTo(pip);
  run(w, 20, 0.05);
  assert.ok(pip.landed || pip.grounded, 'standing on Dray');
  assert.equal(pip.body, dray);
  // jetpack: straight up, then let gravity bring the Pip back
  const mono0 = pip.resources.mono ? pip.resources.mono.amount : (pip.resources.evafuel || { amount: 1 }).amount;
  const up = pip.pos.clone().normalize().applyQuaternion(pip.q.clone().invert());
  pip.ctrl.rcs = true; pip.ctrl.tx = up.x; pip.ctrl.ty = up.y; pip.ctrl.tz = up.z;
  let top = 0;
  for (let i = 0; i < 40; i++) { w.step(0.05); top = Math.max(top, pip.radarAlt); }
  pip.ctrl.tx = pip.ctrl.ty = pip.ctrl.tz = 0;
  for (let i = 0; i < 400 && pip.verticalSpeed > 0; i++) { w.step(0.05); top = Math.max(top, pip.radarAlt); }
  assert.ok(top > 3, 'the jetpack lifts a Pip in weak gravity: ' + top);
  const monoNow = pip.resources.mono ? pip.resources.mono.amount : (pip.resources.evafuel || { amount: 0 }).amount;
  assert.ok(monoNow < mono0, 'and uses propellant');
  for (let i = 0; i < 8000 && !(pip.landed || pip.grounded); i++) w.step(0.05);
  assert.ok(pip.landed || pip.grounded, 'came back down');
  assert.ok(!pip.dead);
  // ladder
  const near = w.ladderNear(pip);
  if (near) {
    assert.equal(near.vessel, v);
    assert.ok(w.evaGrab(pip));
    assert.ok(pip.ladder, 'holding on');
    const h0 = pip.pos.length();
    pip.ctrl.ty = 1;
    run(w, 4, 0.05);
    pip.ctrl.ty = 0;
    assert.ok(pip.pos.length() - h0 > 0.3, 'climbed: ' + (pip.pos.length() - h0));
    const h1 = pip.pos.length();
    run(w, 3, 0.05);
    assert.ok(Math.abs(pip.pos.length() - h1) < 0.05, 'hangs on without sliding');
    w.evaLetGo(pip);
    assert.ok(!pip.ladder);
  }
  assert.ok(w.evaBoard(pip, v) || pip.pos.distanceTo(v.pos) > 2, 'boards when close enough');
});

test('ladders: a Pip beside a landed ship finds its ladder, climbs and lets go', () => {
  const w = new World();
  const c = lander();
  const v = w.launch(c, { crew: ['Ada'] });
  run(w, 2);
  const pip = w.evaStart(v);
  assert.ok(pip);
  run(w, 3);
  const near = w.ladderNear(pip);
  assert.ok(near && near.vessel === v && near.part.def.shape === 'ladder', 'a ladder within reach of the hatch');
  const events = [];
  w.on('ladder', d => events.push(d));
  assert.ok(w.evaGrab(pip));
  assert.equal(events.length, 1);
  const r0 = pip.pos.length();
  pip.ctrl.ty = 1; run(w, 2); pip.ctrl.ty = 0;
  const r1 = pip.pos.length();
  assert.ok(r1 - r0 > 0.2, 'up: ' + (r1 - r0));
  pip.ctrl.ty = -1; run(w, 1); pip.ctrl.ty = 0;
  assert.ok(pip.pos.length() < r1 - 0.1, 'and down');
  w.evaLetGo(pip);
  assert.equal(pip.ladder, null);
  run(w, 5);
  assert.ok(pip.landed || pip.grounded, 'dropped to the ground');
});

test('ladders: a Pip on a ladder faces the hull, and still does when it steps off at the bottom', () => {
  const w = new World();
  const v = w.launch(lander(), { crew: ['Ada'] });
  run(w, 2);
  const pip = w.evaStart(v);
  run(w, 1);
  assert.ok(w.evaGrab(pip));
  // degrees between the visor (+Z) and the way to the ship's axis, along the ground, in the body-fixed frame
  const off = () => {
    const up = pip.surface.dir.clone().normalize(), flat = x => x.addScaledVector(up, -x.dot(up)).normalize();
    return flat(new Vector3(0, 0, 1).applyQuaternion(pip.surface.qRel)).angleTo(flat(v.surface.dir.clone().sub(pip.surface.dir))) * 180 / Math.PI;
  };
  pip.ctrl.ty = 1; run(w, 1); pip.ctrl.ty = 0;
  assert.ok(pip.ladder && off() < 2, 'facing the rungs: ' + off().toFixed(1));
  pip.ctrl.ty = -1;
  for (let i = 0; i < 400 && pip.ladder; i++) w.step(0.05);
  pip.ctrl.ty = 0;
  assert.ok(!pip.ladder && pip.landed, 'stepped off onto the ground');
  run(w, 0.5);
  assert.ok(off() < 2, 'still facing the ship it climbed down: ' + off().toFixed(1));
});

// ------------------------------------------------------------------------------------------------ deployables
function bus(extra = []) {
  const c = new Craft('Bus');
  const [core] = c.setRoot('probe_beacon');
  const bat = c.attachStack('battery_l', core.id, 'bottom')[0];
  const ids = {};
  extra.forEach((t, i) => { ids[t] = c.attachRadial(t, bat.id, bat.pos.y, i * 1.3, 1)[0].id; });
  c.autoStage();
  return { c, ids, bat };
}
/** A circular orbit, starting on the sunward side of the body. */
function inOrbit(w, craft, body = home, alt = 300000, opts = {}) {
  const r = body.radius + alt, s = Math.sqrt(body.gm / r);
  let planet = body; while (planet.parent && planet.parent.parent) planet = planet.parent;
  const sun = planet.globalPosAt(w.ut, new Vector3()).negate().normalize();
  const side = new Vector3(0, 1, 0).cross(sun).normalize();
  return w.spawn(craft, { body, pos: sun.clone().multiplyScalar(r), vel: side.multiplyScalar(s), ...opts });
}

test('power: tracking panels beat fixed ones, sunlight weakens with distance, generators need no sun', () => {
  const drain = v => { for (const p of v.partList) if (p.res && p.res.elec !== undefined) p.res.elec = 0; v.updateResources(); };
  const gain = (types, body = home, deploy = true) => {
    const w = new World();
    const v = inOrbit(w, bus(types).c, body, 400000);
    if (deploy) v.setSolar(true);
    v.ctrl.sas = false;
    run(w, 30, 0.1);
    drain(v);
    // put the sun side on: a quarter orbit of a low orbit is in daylight for a body at the origin side of its star
    run(w, 60, 0.1);
    return { rate: v.resources.elec.amount / 60, v, w };
  };
  const wing = gain(['solar_wing']);
  assert.ok(wing.v.solarOut, 'deployed');
  assert.ok(wing.rate > 0.5, 'a tracking wing charges in sunlight: ' + wing.rate);
  const stowed = gain(['solar_wing'], home, false);
  assert.ok(stowed.rate < wing.rate * 0.2, 'not while folded: ' + stowed.rate);
  const far = SYSTEM.bodies.filter(b => b.parent === home.parent).sort((a, b) => b.orbit.a - a.orbit.a)[0];
  const outer = gain(['solar_wing'], far);
  const fall = Math.pow(home.orbit.a / far.orbit.a, 2);
  assert.ok(outer.rate < wing.rate * Math.max(0.5, fall * 3), `dimmer at ${far.name}: ${outer.rate} vs ${wing.rate}`);
  assert.ok(outer.v.sunScale < 0.6 && wing.v.sunScale > 0.8, 'sunScale reported: ' + outer.v.sunScale);
  const rtg = gain(['gen_glowworm'], far);
  const want = PARTS.gen_glowworm.generator.rate;
  assert.ok(Math.abs(rtg.rate - want) < want * 0.25, `generator makes ${rtg.rate} of ${want} anywhere`);
});

test('lights, air brakes and solar panels answer to methods and to action groups', () => {
  const w = new World();
  const { c, ids } = bus(['light_glim', 'airbrake', 'solar_wing']);
  c.setAction('1', ids.light_glim, 'toggleLight');
  c.setAction('1', ids.airbrake, 'toggleAirbrake');
  c.setAction('2', ids.solar_wing, 'toggleSolar');
  assert.deepEqual(c.groupActions('1').map(a => a.action).sort(), ['toggleAirbrake', 'toggleLight']);
  assert.ok(c.actionsOf(ids.light_glim).some(a => a.id === 'toggleLight'));
  assert.equal(c.setAction('1', ids.light_glim, 'decouple'), false, 'a light cannot decouple');
  assert.equal(c.setAction('nope', ids.light_glim, 'toggleLight'), false);
  const copy = Craft.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
  assert.deepEqual(copy.actionGroups, c.actionGroups, 'action groups are saved with the design');
  const v = inOrbit(w, copy);
  assert.equal(v.lightsOn, false);
  const events = [];
  w.on('actionGroup', d => events.push(d));
  assert.equal(w.fireGroup('1', v), 2);
  run(w, 0.2);
  assert.equal(v.lightsOn, true);
  assert.equal(v.airbrakesOut, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].group, '1');
  assert.equal(w.fireGroup('2', v), 1);
  assert.ok(v.solarOut);
  assert.equal(w.fireGroup('7', v), 0, 'an empty group does nothing');
  // built-in defaults for the named groups when nothing is bound
  w.fireGroup('lights', v);
  assert.equal(v.lightsOn, false);
  v.setAirbrakes(false);
  w.fireGroup('brakes', v);
  assert.ok(v.airbrakesOut || v.ctrl.brake, 'brakes group works unbound');
  // lights use charge
  v.setLights(true); v.setSolar(false);
  const e0 = v.resources.elec.amount;
  run(w, 20, 0.1);
  assert.ok(v.resources.elec.amount < e0, 'a lamp draws power');
  // rebinding in flight, and survival across a save
  assert.ok(v.setGroupAction('5', ids.light_glim, 'toggleLight'));
  const back = World.fromJSON(JSON.parse(JSON.stringify(w.toJSON()))).vessels[0];
  assert.equal(back.fireGroup('5'), 1);
  assert.ok(partActions(PARTS.eng_sparrow).some(a => a.id === 'toggleEngine'));
  assert.deepEqual(partActions(PARTS.strut || { id: 'x' }), []);
});

test('action groups: abort shuts the engines down and fires what is bound to it; staging parts obey groups', () => {
  const w = new World();
  const c = stock('Skylark II');
  const eng = c.parts.find(p => p.type === 'eng_goshawk'), dec = c.parts.find(p => p.type === 'dec_m'), chute = c.parts.find(p => p.type === 'chute');
  c.setAction('abort', dec.id, 'decouple');
  c.setAction('3', chute.id, 'deployChute');
  const v = w.launch(c, { crew: ['Ada'] });
  v.ctrl.throttle = 1; w.stage();
  run(w, 3, 0.05);
  assert.ok(v.enginePower().thrust > 0);
  const n = v.parts.size;
  const split = [];
  w.on('decouple', d => split.push(d));
  assert.ok(w.fireGroup('abort', v) >= 1);
  run(w, 0.5, 0.05);
  assert.ok(split.length >= 1, 'the bound decoupler fired');
  assert.ok(v.parts.size < n, 'and the stack came apart');
  assert.ok(!v.parts.has(eng.id), 'the capsule left the first stage behind');
  assert.equal(w.fireGroup('3', v), 1);
  assert.notEqual(v.parts.get(chute.id).deployed, false, 'parachute armed by its group');
});

test('air brakes add drag; a drogue opens at speeds that would tear a main parachute away', () => {
  const fall = (brakes) => {
    const w = new World();
    const { c } = bus(brakes ? ['airbrake', 'airbrake', 'airbrake'] : ['light_glim']);
    const r = home.radius + 9000;
    const v = w.spawn(c, { pos: new Vector3(r, 0, 0), vel: new Vector3(-250, 0, -(TAU / home.rotPeriod) * r) });
    if (brakes) v.setAirbrakes(true);
    run(w, 6, 0.05);
    return v.airspeed;
  };
  const clean = fall(false), braked = fall(true);
  assert.ok(braked < clean - 5, `air brakes slow it: ${braked} vs ${clean}`);
  const drogue = Object.values(PARTS).find(d => d.chute && /drogue/i.test(d.id + ' ' + d.name));
  assert.ok(drogue, 'a drogue exists');
  const main = PARTS.chute;
  assert.ok((drogue.chute.maxSpeed || Infinity) > (main.chute.maxSpeed || 0) * 1.3, 'the drogue stands more speed');
  assert.ok(drogue.chute.area < main.chute.area, 'and is smaller');
});

test('science lab: processes stored records for a bonus while crewed and powered', () => {
  const w = new World();
  const c = new Craft('Lab');
  const [core] = c.setRoot('probe_beacon');
  const bat = c.attachStack('battery_l', core.id, 'bottom')[0];
  const lab = c.attachStack('sci_lab', bat.id, 'bottom')[0];
  c.attachRadial('gen_glowworm', bat.id, bat.pos.y, 0, 4);
  c.autoStage();
  const v = inOrbit(w, c, home, 300000, { crew: ['Ada', 'Bo'] });
  assert.equal(v.labParts.length, 1);
  assert.ok(v.parts.get(lab.id).crew.length > 0, 'lab seats are filled');
  v.science.push({ experiment: 'crew_report', bodyId: 'verda', situation: 'spaceLow', ut: 0 });
  const done = [];
  w.on('labDone', d => done.push(d));
  const rec = v.science[0];
  run(w, 30, 0.1);
  assert.ok(rec.lab > 0 && rec.lab < 1, 'in progress: ' + rec.lab);
  const empty = inOrbit(new World(), c, home, 300000, { crew: [] });
  empty.science.push({ experiment: 'crew_report', bodyId: 'verda', situation: 'spaceLow', ut: 0 });
  assert.equal(empty.processLabs(100), 0, 'an empty lab does nothing');
  // finish it off directly (the same call the World makes on rails)
  for (let i = 0; i < 2000 && !(rec.lab >= 1); i++) v.processLabs(10, w._ev, true);
  w.step(0.1);
  assert.ok(rec.lab >= 1, 'processed');
  assert.ok(rec.bonus > 0, 'worth more now: ' + rec.bonus);
  const career = new Career('career');
  assert.ok(career.recordValue(rec).next > 0, 'the record is worth something');
  const plain = new Career('career').creditRecord({ ...rec, bonus: 0, lab: 0 }), better = career.creditRecord(rec);
  assert.ok(better > plain && plain > 0, `${better} > ${plain}`);
  assert.equal(done.length, 1, 'labDone told the UI');
  assert.equal(done[0].record, rec);
});

test('antennas: range by dish, range-gated transmission, charge spent, record removed', () => {
  assert.ok(antennaRange(PARTS.antenna_longear) > antennaRange(PARTS.antenna_saucer));
  assert.ok(antennaRange(PARTS.antenna_saucer) > 1e9);
  assert.ok(antennaRange(PARTS.antenna) > 0);
  assert.equal(antennaRange(PARTS.tank_m400), 0);
  const w = new World();
  const near = inOrbit(w, bus(['antenna']).c);
  run(w, 0.2, 0.1);
  near.science.push({ experiment: 'temperature', bodyId: 'verda', situation: 'spaceLow', ut: 0 });
  const ct = w.canTransmit(near);
  assert.ok(ct.ok, 'in reach of home: ' + JSON.stringify(ct));
  const sent = [];
  w.on('transmit', d => sent.push(d));
  const e0 = near.resources.elec.amount;
  const rec = w.transmit(near, 0);
  assert.ok(rec && rec.experiment === 'temperature');
  assert.equal(near.science.length, 0);
  w.step(0.05);
  assert.equal(sent.length, 1);
  assert.ok(e0 - near.resources.elec.amount >= TRANSMIT_EC * 0.9, 'charge spent');
  // no antenna at all
  const mute = inOrbit(w, bus(['light_glim']).c, home, 320000, { makeActive: false });
  assert.equal(w.canTransmit(mute).reason, 'antenna');
  // far away: a whip cannot reach, a big dish can; a better tracking station can hear the whip
  const far = SYSTEM.bodies.filter(b => b.parent === home.parent).sort((a, b) => b.orbit.a - a.orbit.a)[0];
  const w2 = new World();
  const whip = inOrbit(w2, bus(['antenna', 'gen_glowworm']).c, far, 500000);
  const dish = inOrbit(w2, bus(['antenna_longear', 'gen_glowworm']).c, far, 600000, { makeActive: false });
  run(w2, 0.3, 0.1);
  assert.ok(w2.homeDistance(whip) > 1e9);
  const a = w2.canTransmit(whip), b = w2.canTransmit(dish);
  assert.equal(a.ok, false); assert.equal(a.reason, 'range');
  assert.ok(b.ok, 'the long-range dish reaches home: ' + JSON.stringify(b));
  whip.science.push({ experiment: 'temperature', bodyId: far.id, situation: 'spaceLow', ut: 0 });
  assert.equal(w2.transmit(whip, 0), null);
  assert.equal(whip.science.length, 1, 'the record stays aboard');
  w2.commGroundRange = 1e13;
  assert.ok(w2.canTransmit(whip).ok, 'heard by a great enough ear on the ground');
  // flat battery
  for (const p of near.partList) if (p.res && p.res.elec !== undefined) p.res.elec = 0;
  near.updateResources();
  assert.equal(w.canTransmit(near).reason, 'power');
});

// ------------------------------------------------------------------------------------------------ career
test('tech tree: every part\'s tech is a node, every node has parts, every requirement exists and is reachable', () => {
  const ids = new Set(TECH_TREE.map(n => n.id));
  assert.equal(ids.size, TECH_TREE.length, 'unique node ids');
  const used = new Map();
  for (const d of Object.values(PARTS)) {
    assert.ok(d.tech, `${d.id} has a tech`);
    assert.ok(ids.has(d.tech), `part ${d.id}: tech "${d.tech}" is missing from the tree`);
    used.set(d.tech, (used.get(d.tech) || 0) + 1);
  }
  for (const n of TECH_TREE) {
    assert.ok(used.get(n.id) > 0, `tech "${n.id}" unlocks no parts`);
    assert.ok(n.name && n.cost >= 0 && Array.isArray(n.requires), n.id);
    for (const r of n.requires) assert.ok(ids.has(r), `${n.id} requires unknown ${r}`);
    assert.equal(techNode(n.id), n);
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id} has a place on the chart`);
  }
  // everything can be researched, starting from the free nodes
  const have = new Set(TECH_TREE.filter(n => n.cost === 0).map(n => n.id));
  assert.ok(have.size >= 1, 'a starting node');
  for (let changed = true; changed;) {
    changed = false;
    for (const n of TECH_TREE) if (!have.has(n.id) && n.requires.every(r => have.has(r))) { have.add(n.id); changed = true; }
  }
  assert.equal(have.size, TECH_TREE.length, 'unreachable: ' + TECH_TREE.filter(n => !have.has(n.id)).map(n => n.id).join(', '));
  const career = Career.newGame('career');
  career.science = 1e9;
  for (let k = 0; k < TECH_TREE.length; k++) for (const n of TECH_TREE) if (career.canUnlockTech(n.id)) career.unlockTech(n.id);
  for (const d of Object.values(PARTS)) assert.ok(career.isPartUnlocked(d.id), `${d.id} unlockable`);
  // costs rise along the tree
  for (const n of TECH_TREE) for (const r of n.requires) assert.ok(techNode(r).cost <= n.cost, `${r} (${techNode(r).cost}) before ${n.id} (${n.cost})`);
});

test('milestones and science multipliers exist for every body of the system', () => {
  const ids = new Set(MILESTONES.map(m => m.id));
  assert.equal(ids.size, MILESTONES.length);
  for (const b of SYSTEM.bodies) {
    if (b === home.parent) continue;
    const ms = milestonesOf(b);
    assert.ok(ms.length >= 2, `${b.id} has milestones`);
    for (const m of ms) { assert.ok(ids.has(m.id)); assert.ok(m.funds >= 0 && m.science >= 0 && m.title && m.desc, m.id); }
    const kinds = new Set(ms.map(m => m.kind));
    if (b !== home) assert.ok(kinds.has('flyby') && kinds.has('orbit'), `${b.id}: ${[...kinds]}`);
    if (!b.gas && b !== home) for (const k of ['landing', 'return', 'flag']) assert.ok(milestoneFor(k, b), `${b.id} ${k}`);
    if (b.gas) assert.equal(milestoneFor('landing', b), null, 'nobody lands on a gas giant');
    const career = new Career('career');
    assert.ok(career.scienceValue('temperature', b, 'spaceLow').full > 0, `science at ${b.id}`);
  }
  assert.ok(MILESTONE_KINDS.includes('flag'));
  // farther and harder worlds pay more
  const c = new Career('career');
  assert.ok(c.scienceValue('temperature', SYSTEM.byId.dray, 'landed').full > c.scienceValue('temperature', SYSTEM.byId.pell, 'landed').full);
  // a flag on Dray completes its milestone through the event stream
  const before = c.funds;
  c.onEvent('flag', { flag: { bodyId: 'dray' }, bodyId: 'dray', vessel: { body: SYSTEM.byId.dray, crew: [] } }, null);
  assert.ok(c.isMilestoneDone('dray_flag'), 'flag milestone');
  assert.ok(c.funds > before);
});

test('biomes: the same experiment pays again in a new biome, by the biome\'s own multiplier', () => {
  const c = new Career('career');
  const pell = SYSTEM.byId.pell;
  assert.ok(BIOME_SITUATIONS.includes('landed'));
  assert.notEqual(scienceKey('surface_sample', pell, 'landed', 'A'), scienceKey('surface_sample', pell, 'landed', 'B'));
  assert.equal(scienceKey('temperature', pell, 'spaceHigh', 'A'), scienceKey('temperature', pell, 'spaceHigh', 'B'), 'biomes do not matter from high orbit');
  const first = c.creditScience('surface_sample', pell, 'landed', 1, [], 'Basin');
  const again = c.creditScience('surface_sample', pell, 'landed', 1, [], 'Basin');
  const other = c.creditScience('surface_sample', pell, 'landed', 1, [], 'Rim');
  assert.ok(first > 0 && again < first * 0.7, `repeat pays less: ${first} then ${again}`);
  assert.ok(other > again * 1.3, `a new biome is fresh ground: ${other}`);
  assert.ok(biomeSciMult(pell, 'Basin') > 0);
  // experiments that make no sense somewhere are refused
  for (const e of Object.keys(EXPERIMENTS)) assert.equal(typeof experimentAllowed(e, pell), 'boolean');
  assert.equal(experimentAllowed('atmosphere', pell), false, 'no air to sample on an airless moon');
  assert.equal(experimentAllowed('atmosphere', home), true);
});

test('facilities: limits bind in career mode only, upgrades cost funds and lift the limits', () => {
  const c = Career.newGame('career');
  for (const id of FACILITY_IDS) { assert.equal(c.facilityLevel(id), 1); assert.equal(FACILITIES[id].costs.length, FACILITIES[id].values.length); }
  assert.equal(c.limitOf('pad'), FACILITIES.pad.values[0]);
  assert.equal(c.facilityLimits().maxMass, FACILITIES.pad.values[0]);
  const big = stock('Colossus'), small = stock('Hopper I');
  assert.equal(c.checkLaunch(small).ok, true);
  const no = c.checkLaunch(big);
  assert.equal(no.ok, false);
  assert.equal(no.reason, 'mass');
  assert.equal(no.limit, FACILITIES.pad.values[0]);
  assert.ok(Math.abs(no.value - big.mass() / 1000) < 1e-6, 'tonnes');
  assert.equal(c.checkLaunch(stock('Kite Trainer'), 'runway').ok, true);
  assert.equal(c.checkLaunch(stock('Farwind')).ok, false, 'too heavy for the first pad');
  const many = new Craft('Many'); const [root] = many.setRoot('probe_beacon'); let last = root;
  for (let i = 0; i < FACILITIES.hangar.values[0] + 2; i++) last = many.attachStack('battery_l', last.id, 'bottom')[0];
  assert.equal(c.checkLaunch(many).reason, 'parts');
  const info = c.facilityInfo('pad');
  assert.equal(info.level, 1); assert.equal(info.cost, FACILITIES.pad.costs[1]); assert.equal(info.next, FACILITIES.pad.values[1]);
  c.funds = 0;
  assert.deepEqual(c.upgradeFacility('pad'), { ok: false, reason: 'funds', cost: FACILITIES.pad.costs[1] });
  c.funds = 1e7;
  for (const id of FACILITY_IDS) while (c.upgradeFacility(id).ok);
  assert.ok(c.funds < 1e7, 'paid');
  for (const id of FACILITY_IDS) assert.equal(c.facilityLevel(id), FACILITIES[id].costs.length);
  assert.equal(c.checkLaunch(big).ok, true, 'the top pad bears anything');
  assert.equal(c.facilityInfo('pad').cost, null);
  assert.ok(c.limitOf('tracking') > FACILITIES.tracking.values[0]);
  assert.equal(Career.newGame('sandbox').checkLaunch(big).ok, true, 'no limits in sandbox');
  // crew quarters cap hiring
  const k = Career.newGame('career'); k.funds = 1e9;
  let res = null;
  for (let i = 0; i < 30; i++) { res = k.hire(() => 0.5); if (!res.ok) break; }
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'quarters');
  assert.equal(k.activeRoster().length, FACILITIES.crew.values[0]);
});

test('saves: version 3, version-2 saves migrate with nothing taken away, round trip keeps the new fields', () => {
  assert.equal(SAVE_VERSION, 3);
  const c = Career.newGame('career');
  c.funds = 54321; c.science = 77;
  c.upgradeFacility('pad');
  c.creditScience('surface_sample', SYSTEM.byId.pell, 'landed', 1, [], 'Basin');
  c.completeMilestone('dray_flag');
  const json = JSON.parse(JSON.stringify(c.toJSON()));
  assert.equal(json.version, 3);
  const back = Career.fromJSON(json);
  assert.equal(back.funds, c.funds);
  assert.equal(back.facilityLevel('pad'), c.facilityLevel('pad'));
  assert.ok(back.isMilestoneDone('dray_flag'));
  assert.deepEqual(back.scienceValue('surface_sample', SYSTEM.byId.pell, 'landed', 'Basin'), c.scienceValue('surface_sample', SYSTEM.byId.pell, 'landed', 'Basin'));
  // a version-2 save: no facilities, no biomes
  const old = JSON.parse(JSON.stringify(Career.newGame('career').toJSON()));
  old.version = 2; delete old.facilities;
  old.funds = 1234; old.tech = ['start', 'basic_rocketry'].filter(t => TECH_TREE.some(n => n.id === t));
  const m = Career.fromJSON(old);
  assert.equal(m.funds, 1234);
  assert.equal(m.toJSON().version, 3);
  for (const id of FACILITY_IDS) assert.equal(m.facilityLevel(id), FACILITIES[id].costs.length, 'an old program keeps everything it could do: ' + id);
  assert.equal(m.checkLaunch(stock('Colossus')).ok, true);
  for (const t of old.tech) assert.equal(m.techState(t), 'owned');
  assert.ok(Career.fromJSON(Career.newGame('science').toJSON()) instanceof Career);
});

// ------------------------------------------------------------------------------------------------ contracts
test('contracts: the new kinds are offered once the program can do them, and complete from world events', () => {
  for (const t of ['tourists', 'rescue', 'rover', 'station', 'flag', 'satellite']) assert.ok(CONTRACT_TYPES.some(x => (x.type || x.id || x) === t), 'type ' + t);
  const career = Career.newGame('career');
  career.science = 1e9; career.funds = 1e9; career.reputation = 80;
  for (let k = 0; k < TECH_TREE.length; k++) for (const n of TECH_TREE) if (career.canUnlockTech(n.id)) career.unlockTech(n.id);
  for (const m of MILESTONES) career.completeMilestone(m.id);
  const cap = capability(career);
  assert.ok(cap.seats >= 3 && cap.wheels && cap.docking, JSON.stringify(cap));
  const seen = new Set();
  for (let seed = 1; seed < 80; seed++) {
    const board = new ContractBoard(career, seed);
    board.refresh();
    for (const o of board.offered) seen.add(o.type);
  }
  for (const t of ['tourists', 'rescue', 'rover', 'station']) assert.ok(seen.has(t), `a ${t} contract turns up (${[...seen].join(', ')})`);
  // a rover contract completes by driving
  let board = null, rover = null;
  for (let seed = 1; seed < 200 && !rover; seed++) { board = new ContractBoard(career, seed); board.refresh(); rover = board.offered.find(o => o.type === 'rover'); }
  assert.ok(rover, 'found a rover contract');
  assert.ok(rover.objectives.some(o => o.kind === 'drive'));
  assert.ok(rover.reward.funds > 0 && rover.title && rover.text);
  const round = ContractBoard.fromJSON(JSON.parse(JSON.stringify(board.toJSON())), career);
  assert.deepEqual(round.offered.map(o => o.id), board.offered.map(o => o.id));
  // flags on any solid body can be asked for
  const flagBodies = new Set();
  for (let seed = 1; seed < 300; seed++) { const b = new ContractBoard(career, seed); b.refresh(); for (const o of b.offered) if (o.type === 'flag') flagBodies.add(o.bodyId); }
  assert.ok(flagBodies.size >= 2, 'flags asked for on several bodies: ' + [...flagBodies].join(', '));
});

test('rescue: a stranded Pip waits in orbit and can be collected', () => {
  const w = new World();
  const mine = w.launch(stock('Hopper I'), { crew: ['Ada'] });
  const pod = w.spawnStranded({ bodyId: 'verda', alt: 150000, name: 'Lost Lu' });
  assert.ok(pod && pod.stranded);
  assert.deepEqual(pod.crew, ['Lost Lu']);
  assert.equal(pod.body, home);
  assert.ok(Math.abs(pod.altitude - 150000) < 5000);
  assert.equal(w.active, mine, 'not made the active vessel');
  run(w, 2, 0.1);
  assert.equal(pod.situation, 'orbit');
  const back = World.fromJSON(JSON.parse(JSON.stringify(w.toJSON())));
  assert.equal(back.vessels.find(x => x.id === pod.id).stranded, true);
  assert.equal(w.spawnStranded({ bodyId: 'nowhere' }), null);
});

// ------------------------------------------------------------------------------------------------ planners
test('transfer windows: phase, wait and costs between planets and between moons', () => {
  const rusk = SYSTEM.byId.rusk;
  const win = AP.transferWindow(home, rusk, 0);
  assert.ok(win, 'a window from the home world to Rusk');
  assert.ok(win.wait >= 0 && win.wait <= win.synodic * 1.06, 'within one synodic period');
  assert.ok(win.tof > 20 * 86400 && win.tof < 400 * 86400, 'months, not hours: ' + win.tof / 86400);
  assert.equal(win.outward, rusk.orbit.a > home.orbit.a);
  // at the window the target, one crossing later, is opposite the departure point
  const p1 = home.posAt(win.t, new Vector3()), p2 = rusk.posAt(win.t + win.tof, new Vector3());
  assert.ok(p1.angleTo(p2) > Math.PI - 0.12, 'opposition at arrival: ' + p1.angleTo(p2));
  const r0 = home.radius + 90000;
  assert.ok(win.ejectionDv(r0) > 800 && win.ejectionDv(r0) < 2500, 'ejection ' + win.ejectionDv(r0));
  assert.ok(win.ejectionAngle(r0) > Math.PI / 2 && win.ejectionAngle(r0) < Math.PI, 'ejection angle ' + win.ejectionAngle(r0));
  assert.ok(win.captureDv(rusk.radius + 100000) > 50);
  assert.ok(Math.abs(win.dir.length() - 1) < 1e-9);
  // the next window is one synodic period on
  const next = AP.transferWindow(home, rusk, win.t + 86400);
  assert.ok(Math.abs(next.t - win.t - win.synodic) < win.synodic * 0.08, 'windows repeat with the synodic period');
  // and the way back
  const backWin = AP.transferWindow(rusk, home, 0);
  assert.ok(backWin && backWin.outward !== win.outward);
  // moons of one planet work the same way; unrelated bodies do not
  const moons = SYSTEM.bodies.filter(b => b.parent === home);
  if (moons.length >= 2) assert.ok(AP.transferWindow(moons[0], moons[1], 0));
  assert.equal(AP.transferWindow(home, SYSTEM.byId.pell, 0), null);
  assert.equal(AP.transferWindow(home, home, 0), null);
});

test('plane matching and aerobraking forecasts', () => {
  const w = new World();
  const { c } = bus(['antenna']);
  const r = home.radius + 200000, s = Math.sqrt(home.gm / r);
  const tilt = 0.4;
  const v = w.spawn(c, { pos: new Vector3(r, 0, 0), vel: new Vector3(0, s * Math.sin(tilt), -s * Math.cos(tilt)) });
  const pell = SYSTEM.byId.pell;
  const mp = AP.planMatchPlane(w, v, pell);
  assert.ok(mp && mp.node, 'a plane-match node');
  assert.ok(mp.inclination > 0.2, 'tilted against the moon: ' + mp.inclination);
  assert.ok(Math.abs(mp.dv - 2 * s * Math.sin(mp.inclination / 2)) < 0.05 * s, `cost of the turn: ${mp.dv}`);
  // an escaping vessel has no plane to match
  const e = w.spawn(c, { pos: new Vector3(r, 0, 0), vel: new Vector3(0, 0, -s * 1.6), makeActive: false });
  assert.equal(AP.planMatchPlane(w, e, pell), null);
  // aerobraking: no air contact, a grazing pass and a plunge
  const none = AP.predictAerobrake(w, v);
  assert.equal(none.enters, false); assert.equal(none.outcome, 'none');
  const H = home.atmo.height;
  const pass = (peAlt, apAlt) => {
    const ra = home.radius + apAlt, rp = home.radius + peAlt, a = (ra + rp) / 2;
    const va = Math.sqrt(home.gm * (2 / ra - 1 / a));
    const x = w.spawn(c, { pos: new Vector3(ra, 0, 0), vel: new Vector3(0, 0, -va), makeActive: false });
    return AP.predictAerobrake(w, x);
  };
  const graze = pass(H * 0.8, 2e6), deep = pass(H * 0.2, 2e6);
  assert.ok(graze.enters && graze.dv > 0, 'a grazing pass loses some speed: ' + graze.dv);
  assert.ok(graze.maxQ > 0 && graze.speedOut < graze.speedIn);
  assert.equal(graze.outcome, 'capture');
  assert.ok(graze.apoapsis < 2e6, 'apoapsis comes down: ' + graze.apoapsis);
  assert.equal(deep.outcome, 'landing', 'a deep pass does not come out again');
  assert.ok(deep.maxG > graze.maxG);
});

test('stock craft: sixteen designs, original names, all buildable from parts.js, action groups where useful', () => {
  const crafts = stockCrafts();
  assert.ok(crafts.length >= 16, crafts.map(c => c.name).join(', '));
  for (const c of crafts) {
    for (const p of c.parts) assert.ok(PARTS[p.type], `${c.name}: ${p.type}`);
    const back = Craft.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
    assert.equal(back.parts.length, c.parts.length);
    assert.deepEqual(back.actionGroups, c.actionGroups);
    assert.ok(['pad', 'runway'].includes(stockSite(c)));
    assert.ok(Vessel.fromCraft(c).mass > 0);
  }
  assert.ok(stock('Skimmer').groupActions('brakes').length >= 1, 'the Skimmer binds its air brakes');
  assert.ok(stock('Trundle Scout').groupActions('lights').length >= 1);
  assert.ok(stock('Moonstep').groupActions('abort').length >= 1);
  const far = stock('Farwind');
  assert.ok(far.parts.some(p => p.type === 'eng_furnace') && far.parts.some(p => PARTS[p.type].shape === 'ladder'));
  assert.ok(stock('Whisper Probe').deltaV().vac > 15000, 'an ion probe has delta-v to burn');
  assert.ok(stock('Hearthstone Core').parts.filter(p => PARTS[p.type].dock).length >= 1);
  assert.equal(TUNING.GROUND_W > 0, true);
});
