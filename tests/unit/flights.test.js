// Scripted end-to-end flights: the same public API the player uses (ctrl, stage, warp), flown by js/core/autopilot.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../js/core/world.js';
import { stockCrafts, stockSite } from '../../js/core/craft.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { Career } from '../../js/core/career.js';
import * as AP from '../../js/core/autopilot.js';

const home = SYSTEM.home, pell = SYSTEM.byId.pell;
const stock = name => stockCrafts().find(c => c.name === name);
const km = m => (m / 1000).toFixed(1) + ' km';
const clock = t => { const s = Math.round(t); return `T+${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

function mission(name, crew = ['Ada']) {
  const w = new World();
  const v = w.launch(stock(name), { crew });
  const m = { w, v, lines: [], events: [], maxG: 0, maxTemp: 0, maxQ: 0, wall: Date.now(), dv0: v.deltaV };
  m.log = msg => m.lines.push(`  ${clock(w.ut)}  ${msg}`);
  w.on('*', (d, type) => {
    m.events.push({ type, ut: w.ut, ...d });
    if (d.vessel && d.vessel !== m.v && type !== 'decouple' && type !== 'dock' && type !== 'undock') return;
    if (type === 'stage') m.log(`stage ${d.stage + 1} fired`);
    else if (type === 'liftoff') m.log('liftoff');
    else if (type === 'chute') m.log(`parachute ${d.state}`);
    else if (type === 'soi') m.log(`entered the sphere of influence of ${d.to.name}`);
    else if (type === 'situation') m.log(`situation: ${d.from} → ${d.to} (${d.vessel.body.name})`);
    else if (type === 'landed' || type === 'splashed') m.log(`${type} at ${d.speed.toFixed(1)} m/s`);
    else if (type === 'explosion') m.log(`EXPLOSION: ${d.partName}`);
    else if (type === 'crewLost') m.log(`CREW LOST: ${d.name}`);
    else if (type === 'dock') m.log(`DOCKED: ${d.vessel.name} + ${d.absorbed.name} (${d.vessel.parts.size} parts, ${(d.vessel.mass / 1000).toFixed(2)} t)`);
    else if (type === 'undock') m.log(`undocked: ${d.vessel.name} / ${d.other.name}`);
  });
  m.track = () => { const a = m.v; m.maxG = Math.max(m.maxG, a.gForce); m.maxTemp = Math.max(m.maxTemp, a.maxTempRatio); m.maxQ = Math.max(m.maxQ, a.dynamicPressure); };
  m.fly = (ctl, opts = {}) => {
    const c = AP.fly(w, ctl, { onStep: m.track, ...opts });
    if (c) for (const l of c.log) m.lines.push(`  ${clock(l.t)}  [${c.name}] ${l.msg}`);
    m.lines.sort();
    return c;
  };
  m.count = type => m.events.filter(e => e.type === type && (!e.vessel || e.vessel === m.v)).length;
  m.print = title => {
    console.log(`\n=== Flight log: ${title} ===`);
    for (const l of m.lines) console.log(l);
    console.log(`  --- peak ${m.maxG.toFixed(1)} g, max dynamic pressure ${(m.maxQ / 1000).toFixed(1)} kPa, hottest part at ${(m.maxTemp * 100).toFixed(0)} % of its limit; wall time ${((Date.now() - m.wall) / 1000).toFixed(1)} s`);
  };
  return m;
}

test('flight 1: Hopper I - launch, coast, parachute, safe landing', () => {
  const m = mission('Hopper I');
  const { w, v } = m;
  assert.equal(v.situation, 'prelaunch');
  v.ctrl.throttle = 1;
  w.stage();                                           // light the booster
  let apex = 0, maxSpeed = 0;
  m.fly(null, { maxSim: 400, until: () => { apex = Math.max(apex, v.altitude); maxSpeed = Math.max(maxSpeed, v.airspeed); return v.verticalSpeed < -1; } });
  m.log(`apex ${km(apex)}, top speed ${maxSpeed.toFixed(0)} m/s`);
  assert.ok(apex > 30000, 'a proper hop: ' + apex);
  assert.ok(v.parts.get(3).flameout, 'booster burned out');
  assert.equal(m.count('explosion'), 0, 'nothing burned off on the way up');
  w.stage();                                           // arm the parachute
  assert.equal(v.parts.get(2).deployed, 'armed');
  m.fly(null, { maxSim: 3000, until: () => v.landed });
  m.log(`down ${km(v.surface.dir.angleTo(SYSTEM.launchSite.dir) * home.radius)} from the pad`);
  m.print('Hopper I suborbital hop');
  assert.ok(v.landed && !v.dead);
  assert.ok(['landed', 'splashed'].includes(v.situation));
  assert.deepEqual(v.crew, ['Ada']);
  assert.equal(m.count('crewLost'), 0);
  assert.equal(m.count('explosion'), 0, 'landed in one piece');
  const touchdown = m.events.find(e => e.type === 'landed' || e.type === 'splashed');
  assert.ok(touchdown.speed < 6, 'touchdown speed ' + touchdown.speed);
  assert.deepEqual(m.events.filter(e => e.type === 'chute').map(e => e.state), ['armed', 'semi', 'full']);
  const sum = w.recover(v);
  assert.deepEqual(sum.crew, ['Ada']);
  assert.equal(sum.partsCost, stock('Hopper I').cost());
});

test('flight 2: Skylark II - ascent to orbit, deorbit, re-entry and landing with the crew alive', () => {
  const m = mission('Skylark II');
  const { w, v } = m;
  const career = Career.newGame('career');
  const earned = [];
  w.on('*', (d, type) => { for (const r of career.onEvent(type, d, w)) earned.push(r.milestoneId); });
  const asc = m.fly(AP.ascentProgram(w, { targetAlt: 80000, heading: 90 }), { maxSim: 2500 });
  assert.ok(asc.done && !asc.failed, 'ascent: ' + asc.log.map(l => l.msg).join('; '));
  assert.equal(v.situation, 'orbit');
  assert.equal(v.body, home);
  assert.ok(v.periapsis > 72000, 'periapsis above the atmosphere: ' + v.periapsis);
  assert.ok(v.apoapsis < 95000, 'apoapsis ' + v.apoapsis);
  const orbit = v.getOrbit(w.ut);
  assert.ok(orbit.inclination < 0.02, 'equatorial, prograde');
  m.log(`ORBIT ${km(v.apoapsis)} × ${km(v.periapsis)}, period ${(v.period / 60).toFixed(1)} min, ascent used ${asc.dvUsed.toFixed(0)} m/s, ${v.deltaV.toFixed(0)} m/s left`);
  assert.equal(m.count('explosion'), 0);
  assert.equal(w.vessels.length, 1, 'spent first stage fell back and was removed');
  // one and a bit orbits on rails: the orbit is stable
  const ap = v.apoapsis, pe = v.periapsis;
  w.warpTo(w.ut + 1.3 * v.period);
  m.fly(null, { physWarp: 0, dt: 0.1, until: () => w.warpTarget === null });
  assert.ok(Math.abs(v.apoapsis - ap) < 50 && Math.abs(v.periapsis - pe) < 50, 'orbit unchanged after coasting');
  assert.equal(v.situation, 'orbit');
  const report = w.runExperiment(v, 1);
  assert.equal(report.situation, 'spaceLow');
  // deorbit
  const de = m.fly(AP.deorbit(w, v, { periapsis: 30000 }), { maxSim: 600 });
  assert.ok(de.done && !de.failed);
  assert.ok(v.periapsis < 31000 && v.periapsis > 20000);
  m.log(`deorbit burn ${de.dvUsed.toFixed(0)} m/s → periapsis ${km(v.periapsis)}`);
  w.stage();                                           // drop the upper stage
  w.stage();                                           // arm the parachute
  assert.equal(v.stageIndex, v.stages.length);
  assert.deepEqual([...v.parts.values()].map(p => p.def.id).sort(), ['chute', 'heatshield_m', 'pod_acorn']);
  v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde';
  w.setWarp(6);
  m.fly(null, { physWarp: 0, dt: 0.1, maxSim: 4000, until: () => w.warpIndex === 0 });   // rails warp to the edge of the air
  assert.ok(v.altitude > 72000 && v.altitude < 80000);
  let entrySpeed = 0;
  m.fly(null, { maxSim: 3000, until: () => { if (v.altitude > 70000) entrySpeed = v.orbitalSpeed; return v.landed; } });
  m.log(`entry interface at ${entrySpeed.toFixed(0)} m/s; ablator left ${v.resources.ablator.amount.toFixed(0)} / 200 kg`);
  m.print('Skylark II orbital flight');
  assert.ok(v.landed && !v.dead);
  assert.ok(['landed', 'splashed'].includes(v.situation));
  assert.deepEqual(v.crew, ['Ada'], 'crew alive');
  assert.equal(m.count('crewLost'), 0);
  assert.equal(m.count('explosion'), 0);
  assert.ok(m.maxG < 12, 'peak g ' + m.maxG);
  assert.ok(v.resources.ablator.amount < 190, 'the shield did some work');
  assert.ok(m.events.find(e => (e.type === 'landed' || e.type === 'splashed') && e.vessel === v).speed < 8);
  const sum = w.recover(v);
  assert.deepEqual(sum.crew, ['Ada']);
  assert.deepEqual(sum.science.map(r => r.experiment), ['crew_report']);
  // the career layer saw it all through the event stream
  for (const id of ['first_launch', 'reach_space', 'orbit_verda', 'crew_return']) assert.ok(earned.includes(id), 'milestone ' + id + ' (got ' + earned.join(', ') + ')');
});

test('flight 3: Pell Runner - orbit, transfer, Pell encounter, capture and powered landing on Pell', () => {
  const m = mission('Pell Runner');
  const { w, v } = m;
  const asc = m.fly(AP.ascentProgram(w, { targetAlt: 80000 }), { maxSim: 2500 });
  assert.ok(asc.done && !asc.failed, 'ascent: ' + asc.log.map(l => l.msg).join('; '));
  assert.equal(v.situation, 'orbit');
  assert.ok(v.periapsis > 72000);
  m.log(`PARKING ORBIT ${km(v.apoapsis)} × ${km(v.periapsis)}, ascent used ${asc.dvUsed.toFixed(0)} m/s, ${v.deltaV.toFixed(0)} m/s left`);
  // transfer
  const plan = AP.planHohmannToMoon(w, v, pell);
  assert.ok(plan, 'transfer planned');
  assert.equal(v.nodes.length, 1);
  assert.ok(plan.dv > 800 && plan.dv < 950, 'Hohmann dv ' + plan.dv);
  assert.ok(plan.patches.some(p => p.body === pell), 'predicted encounter');
  m.log(`transfer node in ${((plan.node.t - w.ut) / 60).toFixed(1)} min: ${plan.dv.toFixed(1)} m/s prograde, predicted Pell periapsis ${km(plan.periapsis)}`);
  const tmi = m.fly(AP.executeNode(w, v), { maxSim: 20000 });
  assert.ok(tmi.done && !tmi.failed, 'TMI: ' + tmi.log.map(l => l.msg).join('; '));
  assert.equal(v.nodes.length, 0);
  assert.ok(v.apoapsis > 1.0e7, 'apoapsis out at Pell: ' + v.apoapsis);
  m.log(`transfer burn done (${tmi.dvUsed.toFixed(0)} m/s): apoapsis ${km(v.apoapsis)}`);
  const fix = AP.planCorrection(w, v, pell, { periapsis: 30000 });
  assert.ok(fix, 'still on an encounter course after the burn');
  if (fix.node) {
    const c = m.fly(AP.executeNode(w, v), { maxSim: 5000 });
    assert.ok(c.done && !c.failed);
    m.log(`mid-course correction ${fix.dv.toFixed(1)} m/s → Pell periapsis ${km(fix.periapsis)}`);
  }
  // coast to Pell on rails: warp drops by itself at the SOI change
  w.setWarp(8);
  m.fly(null, { physWarp: 0, dt: 0.1, maxSim: 1e5, until: () => v.body === pell, onStep: () => { if (w.warpIndex < 4 && v.body !== pell) w.setWarp(8); } });
  assert.equal(v.body, pell, 'reached Pell\'s SOI');
  assert.equal(w.warpIndex, 0, 'warp dropped at the SOI change');
  const soi = m.events.find(e => e.type === 'soi' && e.vessel === v);
  assert.equal(soi.to, pell);
  assert.ok(Math.abs(soi.ut - (fix.encounterUt)) < 120, 'encounter when predicted');
  assert.equal(v.situation, 'escape');
  assert.ok(v.periapsis > 5000 && v.periapsis < 150000, 'flyby periapsis ' + v.periapsis);
  m.log(`Pell flyby periapsis ${km(v.periapsis)}, arriving at ${v.orbitalSpeed.toFixed(0)} m/s`);
  // capture
  const cap = AP.planCircularize(w, v, 'periapsis');
  assert.ok(cap.dv.prograde < -100, 'retrograde capture burn');
  const cb = m.fly(AP.executeNode(w, v), { maxSim: 1e5 });
  assert.ok(cb.done && !cb.failed, 'capture: ' + cb.log.map(l => l.msg).join('; '));
  assert.equal(v.situation, 'orbit');
  assert.equal(v.body, pell);
  assert.ok(v.apoapsis < 200000, 'closed orbit: ' + v.apoapsis);
  m.log(`PELL ORBIT ${km(v.apoapsis)} × ${km(v.periapsis)} after a ${cb.dvUsed.toFixed(0)} m/s capture burn; ${v.deltaV.toFixed(0)} m/s left`);
  // landing
  const explosionsBefore = m.count('explosion');
  const land = m.fly(AP.hoverslamLanding(w, v), { maxSim: 1e5 });
  assert.ok(land.done && !land.failed, 'landing: ' + land.log.map(l => l.msg).join('; '));
  for (let i = 0; i < 100; i++) w.step(0.1);                // let it settle
  m.log(`LANDED on Pell; landing used ${land.dvUsed.toFixed(0)} m/s, ${v.deltaV.toFixed(0)} m/s left of ${m.dv0.toFixed(0)}`);
  m.print('Pell Runner: Verda → Pell surface');
  assert.equal(v.situation, 'landed');
  assert.equal(v.body.id, 'pell');
  assert.ok(v.landed && !v.dead);
  assert.ok(v.legsDown, 'legs deployed');
  assert.deepEqual(v.crew, ['Ada']);
  assert.equal(m.count('explosion'), explosionsBefore, 'nothing broke on touchdown');
  assert.equal(m.count('crewLost'), 0);
  const td = m.events.filter(e => e.type === 'landed' && e.vessel === v).pop();
  assert.ok(td.speed < 4, 'touchdown speed ' + td.speed);
  // the ground is real terrain now: "upright" means square to the local slope, which must itself be gentle
  const tilt = v.pos.clone().set(0, 1, 0).applyQuaternion(v.q).angleTo(v.pos);
  // the script does not choose its site: it comes down wherever the timing of the whole flight puts it, so the
  // lander is judged against the ground it found (the next line), and the ground only has to be standable
  assert.ok(v.surface.slope < 0.2, 'landed on standable ground: ' + v.surface.slope);
  assert.ok(tilt < v.surface.slope + 0.03, 'standing upright on its legs: tilt ' + tilt + ' on a slope of ' + v.surface.slope);
  assert.ok(Math.abs(v.radarAlt) < 1e-6);
  assert.ok(v.parts.has(7), 'the lander engine survived');
  assert.ok(v.deltaV > 600, 'fuel to come home on: ' + v.deltaV);
  // plant a flag while we are here
  const pip = w.evaStart(v);
  assert.ok(pip.landed);
  assert.ok(w.plantFlag(pip, 'Pell Base'));
  assert.equal(w.flags[0].bodyId, 'pell');
  assert.equal(w.runExperiment(pip, 1, 'surface_sample').bodyId, 'pell');
  assert.ok(w.evaBoard(pip, v));
});

test('flight 4: Latch Target + Latch Chaser - two launches, rendezvous, docking, fuel transfer, undocking, crew return', () => {
  // --- launch 1: the station module flies itself to an 85 km orbit
  const m = mission('Latch Target', []);
  const { w } = m;
  const station = m.v;
  const asc1 = m.fly(AP.ascentProgram(w, { targetAlt: 85000 }), { maxSim: 2500 });
  assert.ok(asc1.done && !asc1.failed, 'station ascent: ' + asc1.log.map(l => l.msg).join('; '));
  assert.equal(station.situation, 'orbit');
  assert.ok(station.periapsis > 78000 && station.apoapsis < 95000, `${station.apoapsis} × ${station.periapsis}`);
  station.setSolar(true);
  station.ctrl.sasMode = 'normal';                       // port axis along the orbit normal: it stays put
  m.log(`STATION ORBIT ${km(station.apoapsis)} × ${km(station.periapsis)}; ${station.resources.fuel.amount.toFixed(0)} kg of fuel left aboard`);
  assert.equal(w.vessels.length, 1, 'only the station is left (its booster fell back)');
  // --- wait on rails for the launch window: the station about 30° short of passing over the pad
  const phase = () => {
    const pad = home.surfaceDirToInertial(SYSTEM.launchSite.dir, w.ut);
    return Math.atan2(pad.clone().cross(station.pos).y, pad.dot(station.pos));
  };
  const rate = 2 * Math.PI / station.period - 2 * Math.PI / home.rotPeriod;
  const wait = ((-30 * Math.PI / 180 - phase()) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) / rate;
  w.warpTo(w.ut + wait);
  m.fly(null, { physWarp: 0, dt: 0.1, until: () => w.warpTarget === null });
  assert.ok(Math.abs(phase() + 30 * Math.PI / 180) < 0.02, 'launch window: ' + phase());
  // --- launch 2: the crewed chaser, with the station still in flight
  const stationOrbit = station.getOrbit(w.ut);
  const v = w.launch(stock('Latch Chaser'), { crew: ['Ada'] });
  m.v = v;
  m.log(`second launch: ${v.name} lifts off with ${station.name} ${km(station.pos.distanceTo(v.pos))} away`);
  assert.equal(w.active, v);
  assert.equal(w.vessels.length, 2);
  assert.equal(v.situation, 'prelaunch');
  const asc2 = m.fly(AP.ascentProgram(w, { targetAlt: 100000 }), { maxSim: 2500 });
  assert.ok(asc2.done && !asc2.failed, 'chaser ascent: ' + asc2.log.map(l => l.msg).join('; '));
  assert.equal(v.situation, 'orbit');
  assert.ok(!station.dead && station.situation === 'orbit');
  assert.ok(station.onRails, 'the station rode on rails while the chaser climbed');
  assert.ok(Math.abs(station.getOrbit(w.ut).a - stationOrbit.a) < 1, 'the station\'s orbit was not disturbed by the second launch');
  assert.deepEqual(w.vessels.map(x => x.name).sort(), ['Latch Chaser', 'Latch Target'], 'spent stages are gone');
  m.log(`CHASER ORBIT ${km(v.apoapsis)} × ${km(v.periapsis)}, ${v.deltaV.toFixed(0)} m/s left; station ${km(station.pos.distanceTo(v.pos))} away`);
  // --- rendezvous
  assert.ok(w.setTarget(v, station));
  assert.equal(v.targetInfo.name, 'Latch Target');
  const dvBefore = v.deltaV;
  const rdv = m.fly(AP.rendezvous(w, v, station), { maxSim: 1e5 });
  assert.ok(rdv.done && !rdv.failed, 'rendezvous: ' + rdv.log.map(l => l.msg).join('; '));
  assert.ok(v.targetInfo.distance < 150, 'within 150 m: ' + v.targetInfo.distance);
  assert.ok(v.targetInfo.relSpeed < 1, 'relative speed ' + v.targetInfo.relSpeed);
  assert.ok(dvBefore - v.deltaV < 150, 'rendezvous cost ' + (dvBefore - v.deltaV));
  m.log(`RENDEZVOUS: ${v.targetInfo.distance.toFixed(0)} m from the station at ${v.targetInfo.relSpeed.toFixed(2)} m/s, used ${(dvBefore - v.deltaV).toFixed(0)} m/s`);
  // --- docking under RCS
  const mono0 = v.resources.mono.amount;
  const partsBefore = v.parts.size + station.parts.size, massBefore = v.mass + station.mass;
  const dock = m.fly(AP.dockingApproach(w, v, station), { maxSim: 2400, physWarp: 1 });
  assert.ok(dock.done && !dock.failed, 'docking: ' + dock.log.map(l => l.msg).join('; '));
  const dockEv = m.events.find(e => e.type === 'dock');
  assert.ok(dockEv, 'dock event');
  assert.equal(dockEv.vessel, v);
  assert.equal(dockEv.absorbed, station);
  assert.deepEqual(w.vessels, [v]);
  assert.equal(v.parts.size, partsBefore);
  assert.ok(Math.abs(v.mass - (massBefore - (mono0 - v.resources.mono.amount))) < 1, 'mass adds up (less the monopropellant spent)');
  assert.deepEqual(v.crew, ['Ada']);
  assert.equal(v.controlPart.def.id, 'pod_acorn', 'the chaser\'s capsule stays in control');
  assert.equal(v.situation, 'orbit');
  assert.equal(v.dockedPairs.length, 1);
  m.log(`docking used ${(mono0 - v.resources.mono.amount).toFixed(1)} kg of monopropellant`);
  // --- docked: save / load round trip, then pump fuel across to the station
  assert.equal(World.fromJSON(JSON.parse(JSON.stringify(w.toJSON()))).active.parts.size, partsBefore);
  const tanks = v.partList.filter(p => p.def.id === 'tank_m400');
  assert.equal(tanks.length, 2);
  const stationTank = tanks.find(p => dockEv.idMap && [...dockEv.idMap.values()].includes(p.id)), myTank = tanks.find(p => p !== stationTank);
  assert.ok(stationTank && myTank);
  const stationFuel0 = stationTank.res.fuel;
  const moved = v.transferResource(myTank.id, stationTank.id, 'fuel', 300);
  assert.equal(moved, 300);
  m.log(`transferred ${moved} kg of fuel to the station (${stationFuel0.toFixed(0)} → ${stationTank.res.fuel.toFixed(0)} kg)`);
  m.fly(null, { maxSim: 20, physWarp: 0 });
  // --- undock and leave
  const other = w.undock(v, dockEv.parts[0]);
  assert.ok(other, 'undocked');
  assert.equal(other.name, 'Latch Target');
  assert.equal(other.type, 'ship');
  assert.ok(Math.abs(other.resources.fuel.amount - (stationFuel0 + 300)) < 1e-6, 'the station keeps the fuel');
  assert.deepEqual(v.crew, ['Ada']);
  assert.equal(w.vessels.length, 2);
  m.fly(null, { maxSim: 40, physWarp: 0 });
  assert.equal(m.events.filter(e => e.type === 'dock').length, 1, 'no accidental re-docking');
  assert.ok(v.pos.distanceTo(other.pos) > 12, 'drifted apart: ' + v.pos.distanceTo(other.pos));
  // --- deorbit, re-entry and landing of the crew
  const de = m.fly(AP.deorbit(w, v, { periapsis: 30000 }), { maxSim: 900 });
  assert.ok(de.done && !de.failed, 'deorbit');
  m.log(`deorbit burn ${de.dvUsed.toFixed(0)} m/s → periapsis ${km(v.periapsis)}`);
  w.stage();                                             // drop the service module
  w.stage();                                             // arm the side parachutes
  assert.equal(v.stageIndex, v.stages.length);
  assert.deepEqual(v.partList.map(p => p.def.id).sort(), ['chute_radial', 'chute_radial', 'dock_s', 'heatshield_m', 'pod_acorn']);
  v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde';
  w.setWarp(6);
  m.fly(null, { physWarp: 0, dt: 0.1, maxSim: 4000, until: () => w.warpIndex === 0 });
  m.fly(null, { maxSim: 3000, until: () => v.landed || v.dead });
  m.print('Latch Target + Latch Chaser: rendezvous and docking');
  assert.ok(v.landed && !v.dead, 'landed');
  assert.deepEqual(v.crew, ['Ada'], 'crew alive');
  assert.equal(m.events.filter(e => e.type === 'crewLost').length, 0);
  assert.equal(m.events.filter(e => e.type === 'explosion' && e.vessel === v).length, 0, 'nothing burned or broke');
  assert.ok(m.events.find(e => (e.type === 'landed' || e.type === 'splashed') && e.vessel === v).speed < 8);
  assert.equal(v.parts.size, 5);
  // the station is still up there, refuelled, and the capsule can be recovered
  const st = w.vessels.find(x => x.name === 'Latch Target');
  assert.ok(st && !st.dead && st.situation === 'orbit');
  assert.ok(w.recover(v));
});

test('flight 5: Kite Trainer - runway take-off, a circuit, and a landing back on the runway', () => {
  const w = new World();
  const craft = stock('Kite Trainer');
  assert.equal(stockSite(craft), 'runway');
  const v = w.launch(craft, { crew: ['Ada'], site: 'runway' });
  const events = [];
  w.on('*', (d, type) => { if (!d.vessel || d.vessel === v) events.push({ type, ...d }); });
  const fr = AP.runwayFrame();
  for (let i = 0; i < 60; i++) w.step(1 / 60);
  assert.equal(v.situation, 'prelaunch');
  assert.ok(v.landed && v.surface.vehicle, 'parked on its wheels (pinned until it moves)');
  const start = AP.siteCoords(fr, v, w.ut);
  assert.ok(Math.abs(start.cross) < 3 && Math.abs(start.along) < 200, 'at the threshold: ' + JSON.stringify(start));
  const run = (ctl, maxSim) => AP.fly(w, ctl, { dt: 1 / 30, physWarp: 0, maxSim });
  let maxAlt = 0;
  const to = run(AP.planeTakeoff(w, v, { altitude: 500 }), 300);
  assert.ok(to.done && !to.failed, 'take-off: ' + to.log.map(l => l.msg).join('; '));
  assert.equal(v.situation, 'flying');
  assert.ok(v.radarAlt > 400, 'climbed out: ' + v.radarAlt);
  assert.ok(!v.gearDown, 'gear up');
  const cr = AP.fly(w, AP.planeCruise(w, v, { altitude: v.altitude + 100, heading: 90, speed: 110, duration: 40 }), { dt: 1 / 30, physWarp: 0, maxSim: 300, onStep: () => { maxAlt = Math.max(maxAlt, v.radarAlt); } });
  assert.ok(cr.done && !cr.failed);
  const away = AP.siteCoords(fr, v, w.ut).along;
  assert.ok(away > 4000, 'flew away from the field: ' + away);
  const ld = run(AP.planeLand(w, v, {}), 1500);
  assert.ok(ld.done && !ld.failed, 'landing: ' + ld.log.map(l => l.msg).join('; '));
  for (let i = 0; i < 300; i++) w.step(1 / 30);
  const end = AP.siteCoords(fr, v, w.ut);
  console.log(`\n=== Flight log: Kite Trainer circuit ===\n  ${to.log.concat(cr.log, ld.log).map(l => `${clock(l.t)}  ${l.msg}`).join('\n  ')}\n  --- peak ${maxAlt.toFixed(0)} m above the ground, ${km(away)} out, stopped ${end.along.toFixed(0)} m down the runway, ${end.cross.toFixed(1)} m off the centreline`);
  assert.ok(v.landed && !v.dead, 'down and stopped');
  assert.equal(v.situation, 'landed');
  assert.deepEqual(v.crew, ['Ada']);
  assert.equal(events.filter(e => e.type === 'explosion' || e.type === 'crewLost').length, 0, 'nothing broke');
  assert.equal(v.parts.size, craft.parts.length, 'the whole aeroplane came back');
  assert.ok(end.along > 0 && end.along < fr.length, 'stopped on the runway: ' + end.along);
  assert.ok(Math.abs(end.cross) < 20, 'near the centreline: ' + end.cross);
  assert.ok(ld.touchdown && ld.touchdown.speed < 90 && ld.touchdown.sink < 4, 'a gentle touchdown: ' + JSON.stringify(ld.touchdown));
  assert.ok(v.gearDown);
  const sum = w.recover(v);
  assert.equal(sum.site, 'runway');
  assert.ok(sum.distance < 2000, 'recovered at the runway');
});

test('flight 6: Trundle Scout - a rover drives 500 m and stops', () => {
  const w = new World();
  const craft = stock('Trundle Scout');
  const v = w.launch(craft, { site: 'runway' });
  const events = [];
  w.on('*', (d, type) => events.push({ type, ...d }));
  for (let i = 0; i < 60; i++) w.step(1 / 60);
  assert.ok(v.landed && v.surface.vehicle, 'parked on its wheels (pinned until it moves)');
  const p0 = v.body.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut, v.pos.clone());
  const ec0 = v.resources.elec.amount;
  let top = 0;
  const d = AP.fly(w, AP.roverDrive(w, v, { distance: 500, speed: 8 }), { dt: 1 / 30, physWarp: 0, maxSim: 400, onStep: () => { top = Math.max(top, v.groundSpeed); } });
  assert.ok(d.done && !d.failed, 'drive: ' + d.log.map(l => l.msg).join('; '));
  const p1 = v.body.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut, v.pos.clone());
  const moved = p0.angleTo(p1) * v.body.radius;
  console.log(`\n=== Flight log: Trundle Scout ===\n  drove ${d.driven.toFixed(0)} m (${moved.toFixed(0)} m in a straight line) in ${w.ut.toFixed(0)} s, top speed ${top.toFixed(1)} m/s, ${(ec0 - v.resources.elec.amount).toFixed(1)} charge used`);
  assert.ok(d.driven >= 500, 'driven ' + d.driven);
  assert.ok(moved > 480 && moved < 560, 'in a straight line: ' + moved);
  assert.ok(top > 5 && top < 12, 'at a sensible speed: ' + top);
  assert.ok(v.groundSpeed < 0.3, 'stopped');
  assert.ok((v.landed || v.wheelsOnGround >= 4) && !v.dead, 'still on its wheels');
  assert.ok(v.pos.clone().set(0, 0, 1).applyQuaternion(v.q).angleTo(v.pos) < 0.2, 'right way up');
  assert.equal(events.filter(e => e.type === 'explosion').length, 0);
  assert.equal(v.parts.size, craft.parts.length);
  for (let i = 0; i < 200; i++) w.step(1 / 30);
  assert.equal(v.situation, 'landed');
});

test('flight 7: Farwind - from the pad to Rusk, and a crewed landing on its moon Dray', () => {
  const rusk = SYSTEM.byId.rusk, dray = SYSTEM.byId.dray;
  // the mission clock starts three days before the transfer window (the first one opens after 220 days)
  const first = AP.transferWindow(home, rusk, 0);
  assert.ok(first && first.wait > 0 && first.tof > 30 * 86400, 'a window exists');
  const w = new World({ ut: first.t - 3 * 86400 });
  const v = w.launch(stock('Farwind'), { crew: ['Ada', 'Bo', 'Cy'] });
  const m = { lines: [], events: [] };
  const day = () => `day ${(w.ut / 86400).toFixed(2)}`;
  const log = msg => m.lines.push(`  ${day()}  ${msg}`);
  w.on('*', (d, type) => {
    if (d.vessel && d.vessel !== v) return;
    m.events.push({ type, ut: w.ut, ...d });
    if (type === 'soi') log(`entered the sphere of influence of ${d.to.name}`);
    else if (type === 'stage') log(`stage ${d.stage + 1} fired`);
    else if (type === 'explosion') log(`EXPLOSION: ${d.partName}`);
  });
  const fly = (ctl, what, maxSim = 1e6) => {
    const c = AP.fly(w, ctl, { maxSim });
    assert.ok(c.done && !c.failed, `${what}: ${c.log.map(l => l.msg).join('; ')}`);
    return c;
  };
  const coast = (until, maxSim) => {
    w.setWarp(99);
    AP.fly(w, null, { physWarp: 0, dt: 0.1, maxSim, until, onStep: () => { if (w.warpIndex < w.maxWarpIndex()) w.setWarp(99); } });
    w.setWarp(0);
  };
  const dv0 = v.deltaV;
  // 1. to a parking orbit
  const asc = fly(AP.ascentProgram(w, { targetAlt: 90000 }), 'ascent', 3000);
  assert.equal(v.situation, 'orbit');
  log(`PARKING ORBIT ${km(v.apoapsis)} × ${km(v.periapsis)}; ascent used ${asc.dvUsed.toFixed(0)} m/s, ${v.deltaV.toFixed(0)} left`);
  // 2. the ejection burn: in Verda's orbital plane, leaving the tilt of Rusk's orbit to a cheaper mid-course burn
  const plan = AP.planInterplanetary(w, v, rusk, { periapsis: 400000, planar: true });
  assert.ok(plan && plan.node, 'ejection planned');
  assert.ok(plan.dv > 900 && plan.dv < 1400, 'near the Hohmann cost: ' + plan.dv);
  assert.ok(plan.node.t - w.ut < 5 * 86400, 'within days of the window');
  log(`ejection node in ${((plan.node.t - w.ut) / 3600).toFixed(1)} h: ${plan.dv.toFixed(0)} m/s (window ${(plan.window.wait / 86400).toFixed(1)} days out, ${(plan.window.tof / 86400).toFixed(0)}-day crossing)`);
  const ej = fly(AP.executeNode(w, v), 'ejection');
  assert.equal(v.situation, 'escape');
  coast(() => v.body !== home, 4e6);
  assert.equal(v.body, home.parent, 'in solar orbit');
  const tEj = w.ut;
  log(`ejected (${ej.dvUsed.toFixed(0)} m/s), now in orbit around ${v.body.name}`);
  // 3. mid-course: close the miss and set the periapsis at Rusk
  coast(() => w.ut > tEj + plan.window.tof * 0.4, 1e8);
  const fix = AP.planCorrection(w, v, rusk, { periapsis: 400000, seek: true, horizon: plan.window.tof * 1.3 });
  assert.ok(fix && fix.periapsis !== null, 'the correction finds Rusk');
  assert.ok(fix.dv < 600, 'correction ' + fix.dv);
  if (fix.node) fly(AP.executeNode(w, v), 'mid-course correction');
  log(`mid-course correction ${fix.dv.toFixed(0)} m/s → Rusk periapsis ${km(fix.periapsis)}`);
  coast(() => v.body === rusk, 1e8);
  assert.equal(v.body, rusk, 'reached Rusk');
  assert.ok(v.periapsis > 100000 && v.periapsis < 3e6, 'a safe periapsis above the air: ' + v.periapsis);
  log(`RUSK flyby periapsis ${km(v.periapsis)} at ${v.orbitalSpeed.toFixed(0)} m/s; ${v.deltaV.toFixed(0)} m/s left`);
  // 4. capture into an ellipse that reaches out to Dray's orbit, then turn into Dray's plane out there where it is cheap
  {
    const o = v.getOrbit(w.ut), rp = rusk.radius + v.periapsis, ra = dray.orbit.a;
    const vNow = Math.sqrt(rusk.gm * (2 / rp - 1 / o.a)), vWant = Math.sqrt(rusk.gm * (2 / rp - 2 / (rp + ra)));
    v.addNode(w.ut + o.timeToPeriapsis(w.ut), { prograde: vWant - vNow });
    const cb = fly(AP.executeNode(w, v), 'capture');
    assert.equal(v.situation, 'orbit');
    log(`captured (${cb.dvUsed.toFixed(0)} m/s): ${km(v.apoapsis)} × ${km(v.periapsis)} around Rusk`);
  }
  const mp = AP.planMatchPlane(w, v, dray);
  assert.ok(mp, 'plane match planned');
  if (mp.node) fly(AP.executeNode(w, v), 'plane match');
  assert.ok(AP.planMatchPlane(w, v, dray).inclination < 0.01, 'in Dray\'s plane');
  v.nodes.length = 0;
  log(`plane match: ${(mp.inclination * 180 / Math.PI).toFixed(1)}° for ${mp.dv.toFixed(0)} m/s`);
  AP.planCircularize(w, v, 'periapsis');
  fly(AP.executeNode(w, v), 'circularise');
  log(`LOW RUSK ORBIT ${km(v.apoapsis)} × ${km(v.periapsis)}; ${v.deltaV.toFixed(0)} m/s left`);
  // 5. to Dray, as to any moon
  const hop = AP.planHohmannToMoon(w, v, dray);
  assert.ok(hop, 'transfer to Dray planned');
  fly(AP.executeNode(w, v), 'transfer to Dray');
  const fix2 = AP.planCorrection(w, v, dray, { periapsis: 12000 });
  assert.ok(fix2, 'on an encounter course');
  if (fix2.node) fly(AP.executeNode(w, v), 'Dray correction');
  coast(() => v.body === dray, 3e6);
  assert.equal(v.body, dray, 'reached Dray');
  AP.planCircularize(w, v, 'periapsis');
  fly(AP.executeNode(w, v), 'Dray capture');
  assert.equal(v.situation, 'orbit');
  log(`DRAY ORBIT ${km(v.apoapsis)} × ${km(v.periapsis)}; ${v.deltaV.toFixed(0)} m/s left`);
  // 6. down
  // The landing autopilot does not choose its site: it comes down on whatever ground is under the ship, and Dray is
  // rugged. Tried from five points of this orbit (0, 2, 5, 10 and 15 minutes on), it stood on three and came down
  // on slopes of 25 and 40 degrees on the other two. So this flight does what a pilot would and waits ten minutes
  // for gentler ground. (Until the climb from Verda changed by a few seconds this test passed with no wait, by luck.)
  { const t0 = w.ut; AP.fly(w, null, { dt: 0.1, maxSim: 601, until: () => w.ut - t0 >= 600 }); }
  const before = m.events.filter(e => e.type === 'explosion').length;
  const land = fly(AP.hoverslamLanding(w, v), 'landing');
  for (let i = 0; i < 200; i++) w.step(0.1);
  log(`LANDED on Dray, ${((w.ut - (first.t - 3 * 86400)) / 86400).toFixed(1)} days after launch; landing used ${land.dvUsed.toFixed(0)} m/s, ${v.deltaV.toFixed(0)} m/s left of ${dv0.toFixed(0)}`);
  console.log('\n=== Flight log: Farwind: Verda → Rusk → Dray surface ===\n' + m.lines.join('\n'));
  assert.equal(v.body.id, 'dray');
  assert.equal(v.situation, 'landed');
  assert.ok(v.landed && !v.dead);
  assert.deepEqual(v.crew, ['Ada', 'Bo', 'Cy']);
  assert.equal(m.events.filter(e => e.type === 'explosion').length, before, 'nothing broke on touchdown');
  assert.equal(m.events.filter(e => e.type === 'crewLost').length, 0);
  const tilt = v.pos.clone().set(0, 1, 0).applyQuaternion(v.q).angleTo(v.pos);
  assert.ok(tilt < 0.5, 'standing on its legs: tilt ' + tilt + ' on a slope of ' + v.surface.slope);
  assert.ok(v.legsDown);
  assert.ok(m.events.filter(e => e.type === 'landed').length < 20, 'no endless skipping in the weak gravity');
  assert.ok(v.deltaV > 1200, 'fuel to get back up and out: ' + v.deltaV);
  // a walk on another planet's moon
  const pip = w.evaStart(v);
  assert.ok(pip && pip.landed);
  const flag = w.plantFlag(pip, 'Dray Base');
  assert.equal(flag.bodyId, 'dray');
  assert.ok(w.evaBoard(pip, v));
});

test('every stock craft works from its own site: rockets leave the pad straight, aeroplanes fly, rovers roll', () => {
  const names = stockCrafts().map(c => c.name);
  for (const n of ['Hopper I', 'Skylark II', 'Pell Runner', 'Ember Twin', 'Mote Sounder', 'Latch Target', 'Latch Chaser',
    'Kite Trainer', 'Skimmer', 'Trundle Scout', 'Trundle Lander', 'Colossus', 'Farwind', 'Whisper Probe', 'Hearthstone Core', 'Moonstep']) assert.ok(names.includes(n), 'stock craft: ' + n);
  for (const craft of stockCrafts()) {
    const w = new World();
    const site = stockSite(craft);
    const v = w.launch(craft, { crew: ['Ada'], site });
    assert.equal(craft.validate().errors.length, 0, `${craft.name} is a valid design`);
    if (site === 'runway' && !craft.parts.some(p => /^(jet_|eng_)/.test(p.type))) {                    // a rover
      const d = AP.fly(w, AP.roverDrive(w, v, { distance: 40 }), { dt: 1 / 30, physWarp: 0, maxSim: 120 });
      assert.ok(d.done && !d.failed && d.driven >= 40, `${craft.name} drives`);
      continue;
    }
    if (site === 'runway') {                                      // an aeroplane
      const t = AP.fly(w, AP.planeTakeoff(w, v, { altitude: 300 }), { dt: 1 / 30, physWarp: 0, maxSim: 300 });
      assert.ok(t.done && !t.failed, `${craft.name} takes off: ${t.log.map(l => l.msg).join('; ')}`);
      assert.ok(v.radarAlt > 250 && !v.dead && v.parts.size === craft.parts.length, `${craft.name} climbs out in one piece`);
      continue;
    }
    v.ctrl.throttle = 1;
    w.stage();
    let maxTilt = 0;
    for (let i = 0; i < 400; i++) {
      w.step(0.05);
      maxTilt = Math.max(maxTilt, v.pos.clone().set(0, 1, 0).applyQuaternion(v.q).angleTo(v.pos));
    }
    assert.ok(v.altitude > 300, `${craft.name} climbed: ${v.altitude.toFixed(0)} m after 20 s`);
    assert.ok(maxTilt < 0.1, `${craft.name} flies straight under SAS: ${maxTilt}`);
    assert.ok(!v.dead);
  }
});

test('the launchers of the new stock craft reach orbit with their payloads', () => {
  for (const [name, left] of [['Trundle Lander', 3000], ['Colossus', 500], ['Whisper Probe', 15000], ['Hearthstone Core', 1500]]) {
    const w = new World();
    const v = w.launch(stock(name), { crew: ['Ada'] });
    let lost = 0;
    w.on('explosion', d => { if (d.vessel === v) lost++; });
    const c = AP.fly(w, AP.ascentProgram(w, { targetAlt: 80000 }), { maxSim: 3000 });
    assert.ok(c.done && !c.failed, `${name}: ${c.log.map(l => l.msg).join('; ')}`);
    assert.equal(v.situation, 'orbit', name);
    assert.ok(v.periapsis > 70000, `${name} periapsis ${v.periapsis}`);
    assert.ok(v.deltaV > left, `${name} has ${v.deltaV.toFixed(0)} m/s left in orbit`);
    assert.equal(lost, 0, `${name} lost nothing on the way`);
  }
});

test('flight: Skimmer - take-off and an automatic landing without a tail strike', () => {
  const w = new World();
  const craft = stock('Skimmer');
  const v = w.launch(craft, { crew: ['Ada'], site: 'runway' });
  const broke = [];
  w.on('explosion', d => broke.push(d.partName));
  assert.ok(v.tailStrikeMargin() < 0.2, 'it sits low: ' + v.tailStrikeMargin());
  const run = (ctl, maxSim) => AP.fly(w, ctl, { dt: 1 / 30, physWarp: 0, maxSim });
  const to = run(AP.planeTakeoff(w, v, { altitude: 400 }), 300);
  assert.ok(to.done && !to.failed, 'take-off: ' + to.log.map(l => l.msg).join('; '));
  const ld = run(AP.planeLand(w, v, {}), 2500);
  assert.ok(ld.done && !ld.failed, 'landing: ' + ld.log.map(l => l.msg).join('; '));
  for (let i = 0; i < 300; i++) w.step(1 / 30);
  assert.deepEqual(broke, [], 'nothing broke');
  assert.equal(v.parts.size, craft.parts.length, 'the whole aeroplane came back');
  assert.ok(v.landed && !v.dead);
  const end = AP.siteCoords(AP.runwayFrame(), v, w.ut);
  assert.ok(end.along > 0 && end.along < AP.runwayFrame().length && Math.abs(end.cross) < 20, 'stopped on the runway: ' + JSON.stringify(end));
});

test('a ham-fisted rotation: full back stick held on the take-off roll costs the tail at most, never the whole aeroplane', () => {
  const w = new World();
  const craft = stock('Kite Trainer');
  const v = w.launch(craft, { crew: ['Ada'], site: 'runway' });
  w.stage(); v.ctrl.throttle = 1; v.setBrakes(false);
  for (let t = 0; t < 14 && !v.dead; t += 0.02) { v.ctrl.pitch = v.airspeed > 64 ? 1 : 0; w.step(0.02); }
  assert.ok(!v.dead, 'the aeroplane is still there');
  assert.ok(v.parts.size >= craft.parts.length - 2, `only what scraped is gone (${v.parts.size} of ${craft.parts.length} parts)`);
  assert.deepEqual(v.crew, ['Ada']);
});
