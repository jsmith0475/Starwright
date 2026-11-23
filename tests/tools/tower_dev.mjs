// Development bench for the catch tower (docs/SHEARWATER.md): launch the Shearwater from the tower mount, let the
// ascent assist stage it, fly the booster back and have the arms take it. Prints the log.
//   node tests/tools/tower_dev.mjs
import { World } from '../../js/core/world.js';
import { stockCrafts } from '../../js/core/craft.js';
import { SYSTEM } from '../../js/core/bodies.js';
import * as AP from '../../js/core/autopilot.js';
import { TOWER, catchState } from '../../js/core/tower.js';
import { propIn } from '../../js/core/vessel.js';

export function flyReturn({ alt = 80000, opts = {} } = {}) {
  const craft = stockCrafts().find(c => c.name === 'Shearwater');
  const w = new World(), site = SYSTEM.sites.tower;
  const v = w.launch(craft, { crew: ['Ada', 'Bo'], site: 'tower' });
  const events = [];
  w.on('*', (d, type) => { if (['caught', 'catchMissed', 'destroyed', 'landed', 'splashed', 'structure'].includes(type)) events.push({ type, name: d.vessel && d.vessel.name, reason: d.reason, speed: d.speed, offset: d.offset, tilt: d.tilt, ut: w.ut }); });
  const asc = AP.ascentProgram(w, { targetAlt: alt, useWarp: false, recover: { target: site.dir } });
  let booster = null, rec = null, sep = null;
  w.on('decouple', d => { if (!booster && d.debris && d.debris.type === 'ship') booster = d.debris; });
  let t = 0;
  while (t < 1500) {
    asc.update && !asc.done && asc.update();
    if (booster && !rec) { sep = { ut: w.ut, alt: booster.altitude, prop: booster.partList.reduce((m, p) => m + propIn(p.res, 'methalox'), 0) }; rec = AP.boosterRecovery(w, booster, { target: site.dir, floor: TOWER.hang - 0.5, sets: { burn: 1, final: 2 }, aimBurn: true, ...opts }); }
    if (rec && !rec.done) rec.update();
    w.step(0.02); t += 0.02;
    if (rec && rec.done && (asc.done || t > 1200)) break;
    if (booster && booster.dead && asc.done) break;
  }
  const left = booster ? booster.partList.reduce((m, p) => m + propIn(p.res, 'methalox'), 0) : 0;
  return { w, v, booster, asc, rec, sep, events, left };
}
if (import.meta.url === 'file://' + process.argv[1]) {
  const r = flyReturn();
  console.log('sep', r.sep && { ut: r.sep.ut.toFixed(0), alt: (r.sep.alt / 1000).toFixed(1), prop: (r.sep.prop / 1000).toFixed(1) });
  for (const l of r.rec ? r.rec.log : []) console.log(' ', l.t.toFixed(0), l.msg);
  console.log('events', JSON.stringify(r.events.map(e => ({ ...e, ut: +e.ut.toFixed(1), speed: e.speed && +e.speed.toFixed(2), offset: e.offset && +e.offset.toFixed(2) }))));
  console.log('booster', r.booster && { dead: r.booster.dead, landed: r.booster.landed, held: r.booster.surface && r.booster.surface.held, left: (r.left / 1000).toFixed(1) });
  console.log('ship', r.asc.done ? (r.asc.failed ? 'FAILED' : 'orbit') : 'flying', (r.v.apoapsis / 1000).toFixed(1), (r.v.periapsis / 1000).toFixed(1), 'dv', r.v.deltaV.toFixed(0));
}
