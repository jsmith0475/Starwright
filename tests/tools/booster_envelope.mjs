// Phase 0 of the reusable-booster work (docs/BOOSTERS.md): measures, with the game's own physics, where today's
// stock rockets drop their stages and what an unguided dropped stage then goes through. Changes nothing in the game.
//   node tests/tools/booster_envelope.mjs            → a table on stdout
//   node tests/tools/booster_envelope.mjs --json     → the raw records
import { World } from '../../js/core/world.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { Vessel } from '../../js/core/vessel.js';
import { stockCrafts } from '../../js/core/craft.js';
import * as AP from '../../js/core/autopilot.js';
import { Vector3 } from '../../js/lib/three.module.min.js';

const home = SYSTEM.home, R = home.radius;
const padDir = new Vector3().copy(SYSTEM.launchSite.dir).normalize();
const _d = new Vector3();
/** Ground distance (m) from the pad, positive to the east. */
function downrange(v, ut) {
  home.inertialToSurfaceDir(_d.copy(v.pos).normalize(), ut, _d);
  const ang = Math.acos(Math.max(-1, Math.min(1, _d.dot(padDir))));
  return ang * R * (_d.z < 0 ? 1 : -1);          // pad at +X; east is −Z (see World.padFrame)
}
function snapshot(v, ut) {
  v.updateTelemetry(ut);
  return { ut, alt: v.altitude, speed: v.airspeed, vs: v.verticalSpeed, range: downrange(v, ut), mass: v.mass, q: v.dynamicPressure || 0 };
}

/** Let a copy of a dropped stage fall on its own, as the vessel being flown, and record the fall. */
function fall(json, ut0) {
  const w = new World({ ut: ut0 });
  const v = Vessel.fromJSON(json);
  w.spawn(v, { body: home, pos: v.pos.clone(), vel: v.vel.clone(), q: v.q.clone() });
  v.ctrl.throttle = 0; v.ctrl.sas = false;
  const parts0 = v.partList.length;
  const out = { apogee: 0, maxQ: 0, maxQAlt: 0, maxTemp: 0, maxG: 0, parts0, partsEnd: parts0, end: 'timeout', t: 0, impactSpeed: 0, impactRange: 0, pieces: 0 };
  w.on('decouple', () => { out.pieces++; });
  w.on('landed', d => { if (d.vessel === v) out.end = 'landed'; });
  w.on('splashed', d => { if (d.vessel === v) out.end = 'splashed'; });
  let last = snapshot(v, w.ut);
  for (let i = 0; i < 60000 && !v.dead && !v.landed; i++) {
    w.step(0.02);
    if (v.dead) break;
    const s = snapshot(v, w.ut);
    out.apogee = Math.max(out.apogee, s.alt);
    if (s.q > out.maxQ) { out.maxQ = s.q; out.maxQAlt = s.alt; }
    out.maxG = Math.max(out.maxG, v.gForce || 0);
    for (const p of v.partList) out.maxTemp = Math.max(out.maxTemp, p.temp || 0);
    last = s;
  }
  out.t = w.ut - ut0; out.impactSpeed = last.speed; out.impactRange = last.range; out.lastAlt = last.alt;
  out.partsEnd = v.dead ? 0 : v.partList.length;
  if (v.dead) out.end = 'destroyed';
  return out;
}

const records = [];
for (const craft of stockCrafts()) {
  const w = new World();
  const v = w.launch(craft, { crew: ['Ada', 'Bo', 'Cy', 'Di'] });     // a crewed capsule with nobody in it cannot steer
  if (v.launchSite !== 'pad' || v.stages.length < 3 || v.wheelParts.length >= 2) continue;
  const drops = [];
  w.on('decouple', d => {
    if (d.vessel !== v || d.debris.mass < 1500) return;
    const s = snapshot(d.debris, w.ut);
    let fuel = 0, fuelMax = 0;
    for (const p of d.debris.partList) for (const k of ['fuel', 'ox']) { fuel += p.res[k] || 0; fuelMax += (p.def.res && p.def.res[k]) || 0; }
    drops.push({ ...s, name: d.debris.name, type: d.debris.type, parts: d.debris.partList.length, engines: d.debris.engines.length,
      fuelLeft: fuelMax ? fuel / fuelMax : 0, json: JSON.parse(JSON.stringify(d.debris.toJSON())) });
  });
  const ctl = AP.ascentProgram(w, { targetAlt: 80000, useWarp: false });
  AP.fly(w, ctl, { physWarp: 0, dt: 0.02, maxSim: 900 });
  const end = v.dead ? null : snapshot(v, w.ut);
  const rec = { craft: craft.name, ascent: ctl.done ? (ctl.failed ? 'failed: ' + ((ctl.log.at(-1) || {}).msg || '') : 'orbit') : 'timeout', apo: v.dead ? 0 : v.apoapsis, peri: v.dead ? 0 : v.periapsis, end, drops: [] };
  for (const d of drops) { const f = fall(d.json, d.ut); delete d.json; rec.drops.push({ ...d, fall: f }); }
  records.push(rec);
}

if (process.argv.includes('--json')) { console.log(JSON.stringify(records, null, 1)); process.exit(0); }
const km = x => (x / 1000).toFixed(1);
for (const r of records) {
  console.log(`\n${r.craft}: ascent ${r.ascent}` + (r.end ? `, orbit ${km(r.apo)} × ${km(r.peri)} km` : ''));
  for (const d of r.drops) {
    const f = d.fall;
    console.log(`  drop at T+${d.ut.toFixed(0)} s  ${d.name} (${d.type}, ${d.parts} parts, ${(d.mass / 1000).toFixed(1)} t, ${d.engines} engines, ${(d.fuelLeft * 100).toFixed(0)} % propellant)`);
    console.log(`    alt ${km(d.alt)} km, speed ${d.speed.toFixed(0)} m/s, climb ${d.vs.toFixed(0)} m/s, ${km(d.range)} km downrange`);
    console.log(`    unguided fall: apogee ${km(f.apogee)} km, ${f.t.toFixed(0)} s, peak q ${(f.maxQ / 1000).toFixed(1)} kPa at ${km(f.maxQAlt)} km, peak ${f.maxG.toFixed(1)} g, hottest part ${f.maxTemp.toFixed(0)}, ends ${f.end} at ${f.impactSpeed.toFixed(0)} m/s, ${km(f.impactRange)} km downrange, parts ${f.partsEnd}/${f.parts0}, broke off ${f.pieces}`);
  }
}
