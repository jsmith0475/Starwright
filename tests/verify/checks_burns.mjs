// 2. Burns: thrust, mass flow, the rocket equation, staging bookkeeping, the delta-v readout and maneuver nodes.
import { PARTS, INTERSTAGE } from '../../js/core/parts.js';   // part table, read as data (masses, thrust, Isp)
import * as AP from '../../js/core/autopilot.js';
import { applyManeuver } from '../../js/core/trajectory.js';
import { World, SYSTEM, V, A, simpleShip, twoStage, spawn, run } from './harness.mjs';
import { Craft } from '../../js/core/craft.js';
import * as R from './ref.mjs';

const sys = R.readSystem();
const verda = sys.byId.verda;
const DEEP = [2e11, 0, 0];             // far from Helion: gravity 3e-5 m/s^2, negligible over a burn

/** Wet mass (kg) of a list of part ids from the part table: dry mass + every resource except electric charge. */
function tableMass(ids) {
  let m = 0;
  for (const id of ids) { const d = PARTS[id]; m += d.mass * 1000; for (const k in d.res || {}) if (k !== 'elec') m += d.res[k]; }
  return m;
}
const fuelOf = v => { let f = 0; for (const p of v.partList) f += p.res.fuel || 0; return f; };

function rocketEquation(S) {
  for (const throttle of [1, 0.5]) {
    const w = new World();
    const v = spawn(w, simpleShip(), 'helion', DEEP, [0, 0, 0]);
    const en = PARTS.eng_sparrow.engine;
    const m0 = tableMass(['pod_acorn', 'tank_m400', 'eng_sparrow']);
    S.check(`throttle ${throttle}: vessel mass = sum of the part table`, m0, v.mass, 1e-6, { unit: 'kg' });
    v.ctrl.sas = true; v.ctrl.throttle = throttle;
    w.stage();
    const dir = A(V([0, 1, 0]).applyQuaternion(v.q));
    const v0 = A(v.vel), f0 = fuelOf(v), t0 = w.ut;
    run(w, 20, 1);
    const mdot = (f0 - fuelOf(v)) / (w.ut - t0);
    S.check(`throttle ${throttle}: mass flow = throttle x F / (Isp g0)`, throttle * en.thrust * 1000 / (en.ispVac * R.G0), mdot, 1e-9, { unit: 'kg/s', rel: true });
    S.check(`throttle ${throttle}: vacuum thrust reading`, throttle * en.thrust * 1000, v.thrust, 1e-6, { unit: 'N', rel: true });
    S.check(`throttle ${throttle}: delta-v after 20 s vs rocket equation`, R.rocketDv(en.ispVac, m0, m0 - mdot * (w.ut - t0)), R.dot(R.sub(A(v.vel), v0), dir), 0.02, { unit: 'm/s' });
    // burn to depletion
    const readout = v.deltaV;
    const vNow = A(v.vel), mNow = v.mass;
    run(w, 2000 / mdot, 1);
    S.check(`throttle ${throttle}: tank runs dry`, 0, fuelOf(v), 1e-9, { unit: 'kg' });
    const m1 = tableMass(['pod_acorn', 'tank_m400', 'eng_sparrow']) - PARTS.tank_m400.res.fuel;
    S.check(`throttle ${throttle}: dry mass after the burn = part table`, m1, v.mass, 1e-6, { unit: 'kg' });
    const total = R.dot(R.sub(A(v.vel), v0), dir);
    S.check(`throttle ${throttle}: total delta-v to depletion vs Isp g0 ln(m0/m1)`, R.rocketDv(en.ispVac, m0, m1), total, 0.05, { unit: 'm/s' });
    S.check(`throttle ${throttle}: delta-v readout mid-burn vs what the burn then delivered`, R.dot(R.sub(A(v.vel), vNow), dir), readout, 0.5, { unit: 'm/s', note: `readout refreshes every 0.25 s; mass then ${mNow.toFixed(0)} kg` });
    S.check(`throttle ${throttle}: sideways velocity picked up (attitude hold)`, 0, R.norm(R.sub(R.sub(A(v.vel), v0), R.scale(dir, total))), 0.05, { unit: 'm/s' });
  }
}

function seaLevel(S) {
  // the same engine on the pad: thrust falls with ambient pressure at constant mass flow, F = mdot g0 Isp(p)
  for (const [eng, tank] of [['eng_goshawk', 'tank_m400'], ['eng_sparrow', 'tank_m200']]) {
    const w = new World();
    const v = w.launch(simpleShip({ engine: eng, tank }), { crew: ['Ada'] });
    const en = PARTS[eng].engine;
    v.ctrl.throttle = 1;
    w.stage();
    const f0 = fuelOf(v), t0 = w.ut;
    w.step(0.1); w.step(0.1);
    const p = (verda.atmo.rho0 * Math.exp(-Math.max(0, v.altitude) / verda.atmo.scale)) / verda.atmo.rho0;
    const isp = en.ispVac + (en.ispAtm - en.ispVac) * p;
    const mdot = (f0 - fuelOf(v)) / (w.ut - t0);
    S.check(`${PARTS[eng].name} at sea level: mass flow unchanged, F_vac / (Isp_vac g0)`, en.thrust * 1000 / (en.ispVac * R.G0), mdot, 1e-6, { unit: 'kg/s', rel: true });
    S.check(`${PARTS[eng].name} at sea level: thrust = mdot g0 Isp(p)`, mdot * R.G0 * isp, v.thrust, 1e-4, { unit: 'N', rel: true });
    S.check(`${PARTS[eng].name} at sea level: effective Isp reading`, isp, v.isp, 1e-4, { unit: 's', rel: true });
  }
}

function staging(S) {
  const w = new World();
  const v = spawn(w, twoStage(), 'helion', DEEP, [0, 0, 0]);
  const all = ['pod_acorn', 'tank_m200', 'eng_sparrow', 'dec_m', 'tank_m800', 'eng_goshawk'];
  const upper = ['pod_acorn', 'tank_m200', 'eng_sparrow'];
  const k = PARTS.eng_goshawk.engine, s = PARTS.eng_sparrow.engine;
  // The separator under the upper engine carries an interstage truss: a lattice ring as tall as the engine it
  // surrounds, between two rims of the stack's radius, at INTERSTAGE.kgPerM2 of wall (kept to 0.1 kg). It is dropped
  // with the separator.
  const truss = Math.round(2 * Math.PI * PARTS.dec_m.r * PARTS.eng_sparrow.h * INTERSTAGE.kgPerM2 * 10) / 10;
  const mA0 = tableMass(all) + truss, mA1 = mA0 - PARTS.tank_m800.res.fuel, mB0 = tableMass(upper), mB1 = mB0 - PARTS.tank_m200.res.fuel;
  const dvA = R.rocketDv(k.ispVac, mA0, mA1), dvB = R.rocketDv(s.ispVac, mB0, mB1);
  S.check('two-stage: lift-off mass = part table', mA0, v.mass, 1e-6, { unit: 'kg' });
  S.check('two-stage: delta-v readout before the burn = sum of rocket equations per stage', dvA + dvB, v.deltaV, 0.01, { unit: 'm/s' });
  v.ctrl.sas = true; v.ctrl.throttle = 1;
  w.stage();
  const dir = A(V([0, 1, 0]).applyQuaternion(v.q));
  const v0 = A(v.vel);
  run(w, PARTS.tank_m800.res.fuel / (k.thrust * 1000 / (k.ispVac * R.G0)) + 1, 1);
  S.check('two-stage: first stage delta-v delivered', dvA, R.dot(R.sub(A(v.vel), v0), dir), 0.05, { unit: 'm/s' });
  S.check('two-stage: mass at first-stage burnout', mA1, v.mass, 1e-6, { unit: 'kg' });
  // separation: momentum is conserved between the two halves
  v.ctrl.throttle = 0;
  const vBefore = A(v.vel), mBefore = v.mass;
  let debris = null;
  w.on('decouple', d => { debris = d.debris; });
  w.stage();
  S.ok('two-stage: staging made a debris vessel', !!debris);
  S.check('two-stage: mass kept after separation = part table (upper stage)', mB0, v.mass, 1e-6, { unit: 'kg' });
  S.check('two-stage: mass dropped = part table (separator + its interstage truss + tank + engine, empty)', mA1 - mB0, debris ? debris.mass : NaN, 1e-6, { unit: 'kg' });
  const pAfter = R.add(R.scale(A(v.vel), v.mass), R.scale(debris ? A(debris.vel) : [0, 0, 0], debris ? debris.mass : 0));
  S.check('two-stage: momentum conserved across separation', 0, R.norm(R.sub(pAfter, R.scale(vBefore, mBefore))) / mBefore, 1e-9, { unit: 'm/s' });
  const kick = R.dot(R.sub(A(v.vel), vBefore), dir);
  S.info('two-stage: speed gained by the upper stage from the separator spring', kick, 'm/s', 'not part of the delta-v readout');
  S.check('two-stage: delta-v readout after separation = upper-stage rocket equation', dvB, v.deltaV, 0.01, { unit: 'm/s' });
  v.ctrl.throttle = 1;
  const v1 = A(v.vel);
  run(w, PARTS.tank_m200.res.fuel / (s.thrust * 1000 / (s.ispVac * R.G0)) + 1, 1);
  S.check('two-stage: second stage delta-v delivered', dvB, R.dot(R.sub(A(v.vel), v1), dir), 0.05, { unit: 'm/s' });
  S.check('two-stage: readout at lift-off vs total delivered by the engines', R.dot(R.sub(A(v.vel), v0), dir) - kick, dvA + dvB, 0.1, { unit: 'm/s' });
  S.check('two-stage: final mass', mB1, v.mass, 1e-6, { unit: 'kg' });
  S.check('two-stage: readout when empty', 0, v.estimateDeltaV(), 1e-6, { unit: 'm/s' });
}

/** Reference impulsive burn: add dv = (prograde, normal, radial) in the textbook basis, return the new elements. */
function impulsive(r, v, dv, mu) {
  const pro = R.unit(v), nrm = R.unit(R.cross(r, v)), rad = R.unit(R.cross(pro, nrm));
  const v2 = R.add(v, R.add(R.scale(pro, dv.prograde || 0), R.add(R.scale(nrm, dv.normal || 0), R.scale(rad, dv.radial || 0))));
  return { v: v2, el: R.stateToElements(r, v2, mu) };
}

function maneuverNodes(S, long) {
  const r0 = verda.radius + 120e3;
  const cases = [
    { name: 'prograde +150 m/s', dv: { prograde: 150 } },
    { name: 'retrograde -60 m/s', dv: { prograde: -60 } },
    { name: 'normal +120 m/s (plane change)', dv: { normal: 120 } },
    { name: 'radial +80, prograde +40 m/s', dv: { radial: 80, prograde: 40 } },
    { name: 'prograde +800 m/s (long burn, like a transfer injection)', dv: { prograde: 800 } },
  ];
  for (const c of (long ? cases : cases.slice(0, 1).concat(cases.slice(4)))) {
    const w = new World();
    const v = spawn(w, simpleShip(), 'verda', [r0, 0, 0], [0, 0, -R.circularSpeed(verda.gm, r0)]);
    v.ctrl.sas = true;
    w.stage();
    const tNode = w.ut + 600;
    const node = v.addNode(tNode, c.dv);
    // reference prediction: exact Kepler to the node, impulsive burn, elements
    const at = R.keplerUV([r0, 0, 0], [0, 0, -R.circularSpeed(verda.gm, r0)], verda.gm, 600);
    const want = impulsive(at.r, at.v, c.dv, verda.gm);
    // the game's own prediction (what the map draws)
    const pred = applyManeuver(v.getOrbit(w.ut), tNode, node.dv);
    S.check(`${c.name}: map prediction apoapsis vs reference impulsive burn`, want.el.ra, pred.apoapsis, 0.01, { unit: 'm' });
    S.check(`${c.name}: map prediction periapsis vs reference`, want.el.rp, pred.periapsis, 0.01, { unit: 'm' });
    S.check(`${c.name}: map prediction inclination vs reference`, want.el.inc * 180 / Math.PI, pred.inclination * 180 / Math.PI, 1e-9, { unit: 'deg' });
    const ctl = AP.executeNode(w, v, { useWarp: true });
    AP.fly(w, ctl, { maxSim: 3000 });
    S.ok(`${c.name}: the burn completed`, ctl.done && !ctl.failed, ctl.log.map(l => l.msg).join('; '));
    const got = R.stateToElements(A(v.pos), A(v.vel), verda.gm);
    const dvMag = Math.hypot(c.dv.prograde || 0, c.dv.normal || 0, c.dv.radial || 0);
    const burn = v.mass && dvMag / (PARTS.eng_sparrow.engine.thrust * 1000 / tableMass(['pod_acorn', 'tank_m400', 'eng_sparrow']));
    // Error budget, as an equivalent delta-v: the autopilot stops within 0.15 m/s of the node, and a burn spread
    // over an arc of the orbit instead of an instant loses about dv * arc^2 / 12 (finite-burn / steering loss).
    const arc = burn * Math.sqrt(verda.gm / r0 ** 3);
    const budget = 0.2 + dvMag * arc * arc / 12;
    const k = 1 + 0.5 / dvMag;
    const more = impulsive(at.r, at.v, { prograde: (c.dv.prograde || 0) * k, normal: (c.dv.normal || 0) * k, radial: (c.dv.radial || 0) * k }, verda.gm);
    // d(quantity) / d(dv): the larger of an error along the burn and an error along the velocity
    const pro = impulsive(at.r, at.v, { prograde: (c.dv.prograde || 0) + 0.5, normal: c.dv.normal || 0, radial: c.dv.radial || 0 }, verda.gm);
    const sens = q => Math.max(Math.abs(more.el[q] - want.el[q]) / 0.5, Math.abs(pro.el[q] - want.el[q]) / 0.5, 1e-9);
    S.info(`${c.name}: finite burn ${burn.toFixed(1)} s over ${(arc * 180 / Math.PI).toFixed(1)} deg of orbit; error budget`, budget, 'm/s');
    S.check(`${c.name}: achieved apoapsis vs prediction`, want.el.ra, got.ra, Math.max(30, budget * sens('ra')), { unit: 'm', note: `= ${(Math.abs(got.ra - want.el.ra) / sens('ra')).toFixed(2)} m/s equivalent` });
    S.check(`${c.name}: achieved periapsis vs prediction`, want.el.rp, got.rp, Math.max(30, budget * sens('rp')), { unit: 'm' });
    S.check(`${c.name}: achieved inclination vs prediction`, want.el.inc * 180 / Math.PI, got.inc * 180 / Math.PI, Math.max(1e-6, budget * sens('inc') * 180 / Math.PI), { unit: 'deg' });
    S.check(`${c.name}: achieved period vs prediction`, want.el.period, got.period, Math.max(0.05, budget * sens('period')), { unit: 's' });
    S.check(`${c.name}: delta-v spent (readout change) vs node size`, dvMag, ctl.dvUsed, Math.max(0.5, 0.01 * dvMag), { unit: 'm/s' });
  }
}

function methalox(S) {
  // two liquids burnt at a fixed mass ratio, in a cluster whose rings can be switched: the same laws, ring by ring
  const mk = () => { const c = new Craft('Verifier M'); const [p] = c.setRoot('pod_shearwater'); const t = c.attachStack('tank_xxl_ship', p.id, 'bottom')[0]; c.attachStack('eng_peregrine6', t.id, 'bottom'); c.autoStage(); return c; };
  const liquid = v => { let lox = 0, ch4 = 0; for (const p of v.partList) { lox += p.res.lox || 0; ch4 += p.res.ch4 || 0; } return { lox, ch4, all: lox + ch4 }; };
  const en = PARTS.eng_peregrine6.engine;
  const sets = [['all six', en.rings], ['sea-level three', [en.rings[0]]], ['vacuum three', [en.rings[1]]]];
  for (let mode = 0; mode < sets.length; mode++) {
    const [name, rings] = sets[mode];
    const F = rings.reduce((s, r) => s + r.n * r.thrust * 1000, 0), flow = rings.reduce((s, r) => s + r.n * r.thrust * 1000 / (r.ispVac * R.G0), 0), isp = F / (flow * R.G0);
    const w = new World();
    const v = spawn(w, mk(), 'helion', DEEP, [0, 0, 0]);
    const m0 = tableMass(['pod_shearwater', 'tank_xxl_ship', 'eng_peregrine6']);
    S.check(`${name}: vessel mass = sum of the part table`, m0, v.mass, 1e-6, { unit: 'kg' });
    v.ctrl.sas = true; v.ctrl.throttle = 1;
    w.stage();
    const eng = v.partList.find(p => p.type === 'eng_peregrine6');
    if (mode) v.setEngineMode(eng.id, mode);
    const dir = A(V([0, 1, 0]).applyQuaternion(v.q));
    const v0 = A(v.vel), a = liquid(v), t0 = w.ut;
    run(w, 30, 1);
    const b = liquid(v), mdot = (a.all - b.all) / (w.ut - t0);
    S.check(`${name}: mass flow = sum over lit engines of F / (Isp g0)`, flow, mdot, 1e-9, { unit: 'kg/s', rel: true });
    S.check(`${name}: vacuum thrust reading`, F, v.thrust, 1e-6, { unit: 'N', rel: true });
    S.check(`${name}: oxygen drawn / methane drawn`, 3.6, (a.lox - b.lox) / (a.ch4 - b.ch4), 1e-9, { rel: true });
    S.check(`${name}: delta-v after 30 s vs rocket equation`, R.rocketDv(isp, m0, m0 - mdot * (w.ut - t0)), R.dot(R.sub(A(v.vel), v0), dir), 0.05, { unit: 'm/s' });
    const readout = v.deltaV, vNow = A(v.vel);
    run(w, b.all / mdot + 20, 1);
    const c = liquid(v), prop = PARTS.tank_xxl_ship.res.lox + PARTS.tank_xxl_ship.res.ch4;
    const T = PARTS.tank_xxl_ship.res, spare = T.lox - 3.6 * T.ch4;      // the tank is filled 3.6 to 1 to the nearest 10 kg
    S.check(`${name}: oxygen left when the methane is gone = the table's surplus`, Math.max(spare, 0), c.lox, 1e-3, { unit: 'kg' });
    S.check(`${name}: methane left`, Math.max(-spare / 3.6, 0), c.ch4, 1e-3, { unit: 'kg' });
    S.check(`${name}: total delta-v to depletion vs Isp g0 ln(m0/m1)`, R.rocketDv(isp, m0, m0 - prop + c.all), R.dot(R.sub(A(v.vel), v0), dir), 0.2, { unit: 'm/s' });
    S.check(`${name}: delta-v readout mid-burn vs what the burn then delivered`, R.dot(R.sub(A(v.vel), vNow), dir), readout, 1.5, { unit: 'm/s' });
  }
}

export const groups = [
  { name: '2a. Rocket equation, mass flow, throttle (vacuum)', fast: true, run: S => rocketEquation(S) },
  { name: '2b. Thrust and Isp at sea level', fast: true, run: S => seaLevel(S) },
  { name: '2c. Staging: mass bookkeeping, momentum, delta-v readout', fast: true, run: S => staging(S) },
  { name: '2e. Methane and oxygen: mixture ratio, cluster engine sets, rocket equation', fast: true, run: S => methalox(S) },
  { name: '2d. Maneuver nodes: prediction vs the orbit achieved by flying the burn', fast: true, run: (S, long) => maneuverNodes(S, long) },
];
