// Development bench for the Wayfarer stack (docs/WAYFARER.md): build it, fly it to orbit headless, print the numbers.
//   node tests/tools/wayfarer_dev.mjs [--alt=80000]
import { World } from '../../js/core/world.js';
import { stockCrafts } from '../../js/core/craft.js';
import { SYSTEM } from '../../js/core/bodies.js';
import * as AP from '../../js/core/autopilot.js';
import { propIn } from '../../js/core/vessel.js';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
export function wayfarer() { const craft = stockCrafts().find(c => c.name === 'Wayfarer'); return { craft }; }
if (import.meta.url === 'file://' + process.argv[1]) {
  const { craft } = wayfarer();
  const st = craft.stats(SYSTEM.home);
  console.log('stages', craft.stages.map(s => s.map(id => craft.parts.find(p => p.id === id).type)));
  for (const s of st) console.log(`stage ${s.stage}: dvVac ${s.dvVac.toFixed(0)} dvAtm ${s.dvAtm.toFixed(0)} twr ${s.twr.toFixed(2)} burn ${s.burnTime.toFixed(0)} s, ${(s.startMass / 1000).toFixed(1)} -> ${(s.endMass / 1000).toFixed(1)} t`);
  console.log('validate', JSON.stringify(craft.validate()));
  const w = new World();
  const v = w.launch(craft, { crew: ['Ada', 'Bo'] });
  const alt = +arg('alt', 80000);
  const ctl = AP.ascentProgram(w, { targetAlt: alt, useWarp: false, recover: arg('recover', '1') === '1' ? { target: SYSTEM.sites.landing.dir } : null });
  let lastStage = v.stageIndex, sep = null;
  const res = AP.fly(w, ctl, { maxSim: 3000, onStep: () => {
    if (v.stageIndex !== lastStage) { lastStage = v.stageIndex; if (!sep && w.vessels.length > 1) sep = { t: w.ut, alt: v.altitude, speed: v.surfaceSpeed ?? v.speed ?? v.vel.length(), q: v.dynamicPressure }; }
  } });
  const prop = v.partList.reduce((a, p) => a + propIn(p.res, 'methalox'), 0), cap = v.partList.reduce((a, p) => a + propIn(p.def.res, 'methalox'), 0);
  console.log('ascent', ctl.done ? (ctl.failed ? 'FAILED' : 'orbit') : 'timeout', (ctl.log || []).slice(-4).map(l => l.msg));
  console.log('sep', sep && { t: sep.t.toFixed(0), alt: (sep.alt / 1000).toFixed(1), speed: sep.speed.toFixed(0), q: (sep.q||0).toFixed(0) });
  console.log(`orbit ${(v.apoapsis / 1000).toFixed(1)} x ${(v.periapsis / 1000).toFixed(1)} km, dvUsed ${ctl.dvUsed && ctl.dvUsed.toFixed(0)}, left ${v.deltaV.toFixed(0)} m/s, prop ${(prop / 1000).toFixed(1)} of ${(cap / 1000).toFixed(1)} t (${(100 * prop / cap).toFixed(0)}%), mass ${(v.mass / 1000).toFixed(1)} t`);
  for (const o of w.vessels) if (o !== v) console.log('other:', o.name, o.type, 'alt', (o.altitude / 1000).toFixed(1), 'parts', o.parts.size, 'prop', (o.partList.reduce((a, p) => a + propIn(p.res, 'methalox'), 0) / 1000).toFixed(1));
}
