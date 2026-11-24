// Every stock design that carries a parachute, dropped under it. For each: the part of the craft that comes home (all
// stages fired, tanks as full as they are after staging), from two starts: a re-entry (40 km, 900 m/s down) and a low
// fall (5 km, 160 m/s). Prints the order the parachute stages opened in, peak g and line load, and how it ended.
//   node tests/tools/chute_fleet.mjs [--full]     (--full keeps the propellant aboard: the heaviest it can be)
import { World, SYSTEM, Vector3 } from '../verify/harness.mjs';
import { stockCrafts } from '../../js/core/craft.js';
import { partDef } from '../../js/core/parts.js';
const full = process.argv.includes('--full'), body = SYSTEM.byId.verda;
export const rows = [];
for (const make of stockCrafts().filter(c => [...c.parts.values()].some(p => partDef(p.type).chute)).map(c => c.name)) {
  for (const [alt, vy] of [[40000, -900], [5000, -160]]) {
    const craft = stockCrafts().find(c => c.name === make);
    const w = new World(), r = body.radius + alt, wy = 2 * Math.PI / body.rotPeriod;
    let v = w.spawn(craft, { crew: ['Ada'], body, pos: new Vector3(r, 0, 0), vel: new Vector3(vy, 0, -wy * r) });
    v.q.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(1, 0, 0));
    if (!full) for (const p of v.parts.values()) if (p.res) for (const k of ['lf', 'ox', 'solid']) if (p.res[k] !== undefined) p.res[k] = 0;
    v.ctrl.throttle = 0; v.ctrl.sas = true;
    for (let i = 0; i < 12 && v.chuteParts.some(p => p.deployed === 'stowed'); i++) { v.activateNextStage(); w.step(0.02); v = w.active; }
    const ev = [], lost = []; let peakG = 0, peakT = 0, t = 0, strength = Math.min(...v.chuteParts.map(p => partDef(p.type).chute.strength));
    w.on('*', (d, type) => { if (type === 'chute' && d.state !== 'armed') ev.push(d.state + '@' + Math.round(v.radarAlt)); else if (type === 'explosion' || type === 'breakup' || type === 'torn') lost.push(type + (d.partName ? ':' + d.partName : '')); });
    const m0 = v.mass;
    for (; t < 1500 && !v.landed && !v.splashed && !v.dead; t += 0.02) { w.step(0.02); peakG = Math.max(peakG, v.gForce); peakT = Math.max(peakT, v.chuteTension || 0); }
    const row = { name: make, alt, mass: Math.round(m0), stages: ev.join(' '), peakG: +peakG.toFixed(1), load: Math.round(peakT / 10 / strength), end: v.dead ? 'DESTROYED' : v.landed || v.splashed ? 'down' : 'flying', vs: +(-v.verticalSpeed).toFixed(1), t: Math.round(t), lost: lost.join(' ') };
    rows.push(row);
    console.log(`${make.padEnd(18)} ${String(alt / 1000).padStart(2)} km  ${String(row.mass).padStart(6)} kg  ${row.end.padEnd(9)} ${String(row.t).padStart(4)} s  peak ${String(row.peakG).padStart(5)} g  line ${String(row.load).padStart(3)} %  ${row.stages}  ${row.lost}`);
  }
}
