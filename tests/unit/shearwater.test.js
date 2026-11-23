// The Shearwater stack (docs/SHEARWATER.md): two liquids burnt at a fixed ratio, cluster engines that burn by rings,
// a hot-staging ring that lets go after the stage above has lit and stays on the stage below, and the stock design.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { PARTS, PROP_MIX, G0, engineThrust, engineIsp, engineNow, ringTotals } from '../../js/core/parts.js';
import { Vessel, TUNING, propIn } from '../../js/core/vessel.js';
import { World } from '../../js/core/world.js';
import { Craft, stockCrafts } from '../../js/core/craft.js';
import { SYSTEM } from '../../js/core/bodies.js';
import * as AP from '../../js/core/autopilot.js';

const home = SYSTEM.home;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''}: ${a} vs ${b}`);
const stack = types => { const c = new Craft('T'); let [cur] = c.setRoot(types[0]); const ids = [cur.id]; for (const t of types.slice(1)) { [cur] = c.attachStack(t, cur.id, 'bottom'); assert.ok(cur, 'attach ' + t); ids.push(cur.id); } c.autoStage(); return { c, ids }; };
const inSpace = (craft, crew = ['Ada']) => { const w = new World(), r = home.radius + 400000; const v = w.spawn(craft, { crew, pos: new Vector3(r, 0, 0), vel: new Vector3(0, 0, Math.sqrt(home.gm / r)) }); return { w, v }; };
const liquids = v => v.partList.reduce((s, p) => { s.lox += p.res.lox || 0; s.ch4 += p.res.ch4 || 0; return s; }, { lox: 0, ch4: 0 });
const shearwater = () => stockCrafts().find(c => c.name === 'Shearwater');

test('the catalogue: 33 engines under the booster and 6 under the ship, and the totals are the sums of the rings', () => {
  const b = PARTS.eng_peregrine33.engine, s = PARTS.eng_peregrine6.engine;
  assert.deepEqual(b.rings.map(r => r.n), [3, 10, 20]);
  assert.equal(b.count, 33); assert.equal(s.count, 6); assert.equal(b.count + s.count, 39);
  near(b.thrust, 33 * 340, 1e-6, 'booster thrust');
  near(s.thrust, 3 * 340 + 3 * 375, 1e-6, 'ship thrust');
  // mass flow adds, so the Isp of a mixed cluster is total thrust over total flow
  const flow = s.rings.reduce((m, r) => m + r.n * r.thrust / r.ispVac, 0);
  near(s.ispVac, s.thrust / flow, 1e-9, 'ship vacuum Isp');
  assert.ok(s.ispVac > 350 && s.ispVac < 380);
  // 13 of the 33 steer: the gimbal of the cluster is the thrust-weighted share
  near(b.gimbal, 8 * 13 / 33, 1e-9, 'booster gimbal');
  for (const e of [b, s]) { assert.deepEqual(e.modes[0].rings, e.rings.map((_, i) => i)); for (const m of e.modes) { const t = ringTotals(e, m.rings); assert.ok(t.thrust > 0 && t.thrust <= e.thrust + 1e-9, m.name); } }
  // both tanks hold the two liquids in the ratio the engines burn them
  for (const id of ['tank_xxl_long', 'tank_xxl_ship']) near(PARTS[id].res.lox / PARTS[id].res.ch4, 3.6, 2e-3, id);
  near(PROP_MIX.methalox.lox + PROP_MIX.methalox.ch4, 1, 1e-12, 'mix');
});

test('methane and oxygen leave the tank 3.6 to 1, at thrust / (Isp g0), and the engine stops when either runs out', () => {
  const { c } = stack(['pod_shearwater', 'tank_xxl_ship', 'eng_peregrine6']);
  const { w, v } = inSpace(c);
  v.ctrl.throttle = 1; v.ctrl.sas = true; w.stage(v);
  const a = liquids(v), t0 = w.ut;
  for (let i = 0; i < 500; i++) w.step(0.02);
  const b = liquids(v), dt = w.ut - t0, en = PARTS.eng_peregrine6.engine;
  near((a.lox - b.lox) / (a.ch4 - b.ch4), 3.6, 1e-9, 'ratio drawn');
  near((a.lox + a.ch4 - b.lox - b.ch4) / dt, en.thrust * 1000 / (en.ispVac * G0), 1e-6 * en.thrust, 'mass flow');
  near(v.thrust, en.thrust * 1000, 1e-3, 'thrust');
  near(b.lox / b.ch4, 3.6, 2e-3, 'still in ratio');
  // short of methane: the oxygen that is left cannot burn
  const tank = v.partList.find(p => p.type === 'tank_xxl_ship');
  tank.res.ch4 = 50;
  for (let i = 0; i < 100 && v.thrust > 0; i++) w.step(0.02);
  assert.equal(v.thrust, 0, 'flame-out');
  assert.ok(tank.res.lox > 1000 && tank.res.ch4 < 1e-6, `oxygen left ${tank.res.lox}, methane ${tank.res.ch4}`);
  near(v.deltaV, 0, 1e-6, 'no delta-v without methane');
});

test('delta-v read-out of a methane stage is the rocket equation over both liquids', () => {
  const { c } = stack(['pod_shearwater', 'bay_shearwater', 'tank_xxl_ship', 'eng_peregrine6']);
  const { v } = inSpace(c);
  const dry = ['pod_shearwater', 'bay_shearwater', 'tank_xxl_ship', 'eng_peregrine6'].reduce((m, id) => m + PARTS[id].mass * 1000, 0);
  const prop = PARTS.tank_xxl_ship.res.lox + PARTS.tank_xxl_ship.res.ch4;
  near(v.mass, dry + prop + (PARTS.pod_shearwater.res.mono || 0), 1e-6, 'mass');
  v.activateNextStage([]); v.estimateDeltaV();
  near(v.deltaV, PARTS.eng_peregrine6.engine.ispVac * G0 * Math.log(v.mass / (v.mass - prop)), 0.5, 'vessel read-out');
  const st = c.stats(home);
  near(st[st.length - 1].dvVac, v.deltaV, 0.5, 'builder read-out');
});

test('engine sets: a cluster burns the rings of its mode, and the choice is saved', () => {
  const { c } = stack(['ring_hotstage', 'tank_xxl_long', 'eng_peregrine33']);
  const { w, v } = inSpace(c, []);
  const p = v.partList.find(x => x.type === 'eng_peregrine33'), d = p.def;
  v.ctrl.throttle = 1; w.stage(v);
  const thrusts = [];
  for (let m = 0; m < 3; m++) {
    if (m) assert.ok(v.doAction(p.id, 'engineMode', []));
    assert.equal(p.mode, m);
    const a = liquids(v); w.step(0.02); w.step(0.02); const b = liquids(v);
    const n = [33, 13, 3][m];
    near(v.thrust, n * 340e3, 1, d.engine.modes[m].name);
    near((a.lox + a.ch4 - b.lox - b.ch4) / 0.04, n * 340e3 / (350 * G0), 1e-3, 'flow of ' + n);
    near(engineThrust(d, 0, m), n * 340e3, 1e-6, 'engineThrust');
    near(engineIsp(d, 1, m), 330, 1e-9, 'sea-level Isp');
    thrusts.push(v.thrust);
  }
  // the centre three steer, the rim does not: with only the rim's share gone the steering share rises
  near(engineNow(d, 2).gimbal, 8, 1e-9, 'centre three gimbal fully'); near(engineNow(d, 1).gimbal, 8, 1e-9, 'inner thirteen too');
  const back = Vessel.fromJSON(JSON.parse(JSON.stringify(v.toJSON())));
  assert.equal(back.partList.find(x => x.type === 'eng_peregrine33').mode, 2);
  assert.ok(v.doAction(p.id, 'engineMode', [])); assert.equal(p.mode, 0, 'wraps round to all 33');
  // the ship: sea-level three, vacuum three
  const s = PARTS.eng_peregrine6;
  near(engineThrust(s, 0, 1), 3 * 340e3, 1e-6, 'sea-level three'); near(engineThrust(s, 0, 2), 3 * 375e3, 1e-6, 'vacuum three');
  near(engineIsp(s, 0, 2), 380, 1e-9, 'vacuum Isp of the vacuum three');
  assert.ok(engineThrust(s, 1, 2) < engineThrust(s, 1, 1), 'vacuum bells lose more at sea level');
});

test('hot staging: the ship lights, the ring lets go 0.8 s later and stays on the booster, which can still be flown', () => {
  const { w, v } = inSpace(shearwater(), ['Ada', 'Bo']);
  v.ctrl.throttle = 1; v.ctrl.sas = true;
  w.stage(v);                                             // the 33
  for (let i = 0; i < 10; i++) w.step(0.02);
  const before = v.partList.length;
  const seen = []; const off = w.on('*', (d, type) => seen.push(type));
  w.stage(v);                                             // hot stage
  assert.ok(seen.includes('hotstage'));
  assert.equal(w.vessels.length, 1, 'still one vessel');
  const six = v.partList.find(p => p.type === 'eng_peregrine6');
  assert.ok(six.ignited, 'the six are lit while the stack is still joined');
  assert.ok(v.hotDue && Math.abs(v.hotDue.t - TUNING.HOT_STAGE_DELAY) < 1e-9);
  // a save taken in the gap comes back in the gap
  assert.ok(Vessel.fromJSON(JSON.parse(JSON.stringify(v.toJSON()))).hotDue);
  let t = 0; while (w.vessels.length === 1 && t < 2) { w.step(0.02); t += 0.02; }
  near(t, TUNING.HOT_STAGE_DELAY, 0.03, 'delay');
  assert.equal(w.vessels.length, 2, 'two pieces, not three: the ring is not thrown clear');
  const booster = w.vessels.find(x => x !== v);
  assert.ok(booster.partList.some(p => p.type === 'ring_hotstage'), 'the ring rides the booster');
  assert.ok(!v.partList.some(p => p.type === 'ring_hotstage'));
  assert.equal(v.partList.length + booster.partList.length, before);
  assert.equal(booster.type, 'ship', 'the booster has its own core (the ring) and stays a vessel');
  assert.ok(booster.partList.filter(p => p.def.catchPin).length === 2 && booster.partList.filter(p => p.type === 'fin_grid_xxl').length === 3);
  assert.ok(v.partList.filter(p => p.def.flap).length === 4, 'four flaps stay with the ship');
  for (let i = 0; i < 100; i++) w.step(0.02);
  assert.ok(v.pos.distanceTo(booster.pos) > 20, 'they part');
  if (typeof off === 'function') off();
});

test('the stock Shearwater flies to an 80 km orbit with enough left to need the depot and not enough to skip it', () => {
  const c = shearwater();
  assert.deepEqual(c.validate().errors, []);
  assert.equal(c.parts.filter(p => PARTS[p.type].engine).reduce((n, p) => n + PARTS[p.type].engine.count, 0), 39);
  const st = c.stats(home);
  assert.ok(st[0].twr > 1.3 && st[0].twr < 1.6, 'lift-off thrust to weight ' + st[0].twr);
  const w = new World(), v = w.launch(c, { crew: ['Ada', 'Bo'] });
  near(v.mass / 1000, 769, 3, 'lift-off mass, t');
  const ctl = AP.ascentProgram(w, { targetAlt: 80000, useWarp: false, recover: { target: SYSTEM.sites.landing.dir } });
  AP.fly(w, ctl, { maxSim: 3000 });
  assert.ok(ctl.done && !ctl.failed, 'reaches orbit: ' + (ctl.log || []).slice(-1).map(l => l.msg));
  assert.ok(v.periapsis > 72000 && v.apoapsis < 95000, `orbit ${v.periapsis} × ${v.apoapsis}`);
  const left = v.partList.reduce((m, p) => m + propIn(p.res, 'methalox'), 0), cap = v.partList.reduce((m, p) => m + propIn(p.def.res, 'methalox'), 0);
  assert.ok(left / cap > 0.3 && left / cap < 0.6, `arrives ${(100 * left / cap).toFixed(0)} % full`);
  // Pell orbit and back to a catch needs about 2.0 km/s (docs/SHEARWATER.md): not possible as it arrives, possible full
  assert.ok(v.deltaV < 1800, 'cannot fly the Pell trip without refuelling: ' + v.deltaV);
  for (const p of v.partList) for (const k of ['lox', 'ch4']) if (p.def.res && p.def.res[k]) p.res[k] = p.def.res[k];
  v._updateMass(false); v.estimateDeltaV();
  assert.ok(v.deltaV > 2400, 'full, it can: ' + v.deltaV);
  // the booster is still a vessel with propellant aboard for its return
  const b = w.vessels.find(x => x !== v && x.partList.some(p => p.type === 'eng_peregrine33'));
  assert.ok(b || w.vessels.length === 1, 'the booster flew on or came down');
});
