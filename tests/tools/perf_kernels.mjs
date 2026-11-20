// Node timings of the pure-JavaScript kernels a Rust/WASM port could replace (docs/RUST_ASSESSMENT.md).
//   node tests/tools/perf_kernels.mjs
// Uses process.cpuUsage (CPU time, not wall time), best of several rounds, so other load on the machine matters little.
import { SYSTEM } from '../../js/core/bodies.js';
import { World } from '../../js/core/world.js';
import { stockCrafts } from '../../js/core/craft.js';
import { buildChunk } from '../../js/render/terrainmesh.js';
import { bakeRows, bakeCloudRows } from '../../js/render/bodybake.js';
import { predictPatches, closestApproach } from '../../js/core/trajectory.js';
import * as AP from '../../js/core/autopilot.js';
import * as K from '../../js/ui/demo/kit.js';
import { SCENES } from '../../js/ui/demo/scenes.js';

function cpuMs(fn, rounds = 5) {
  let best = Infinity, out;
  for (let r = 0; r < rounds; r++) { const c0 = process.cpuUsage(); out = fn(); const c = process.cpuUsage(c0); best = Math.min(best, (c.user + c.system) / 1000); }
  return [best, out];
}
const row = (name, ms, per, unit, note = '') => console.log(`${name.padEnd(46)} ${ms.toFixed(1).padStart(9)} ms   ${per.toFixed(3).padStart(9)} ms/${unit}  ${note}`);
const home = SYSTEM.home, pell = SYSTEM.byId.pell;

console.log('Kernel timings in Node ' + process.version + ' (V8 ' + process.versions.v8 + '), CPU time, best of 5\n');

// ---- terrain chunks (what the worker pool runs)
for (const [body, label] of [[home, 'Verda'], [pell, 'Pell']]) {
  const dirToCell = (level) => { const cells = 2 ** level; return [Math.floor(cells * 0.62), Math.floor(cells * 0.41)]; };
  for (const level of [2, 8, 14]) {
    const [ix, iy] = dirToCell(level), n = 30;
    for (let i = 0; i < 5; i++) buildChunk(body, 0, level, ix + i, iy, 40);          // warm up the JIT
    const [ms] = cpuMs(() => { for (let i = 0; i < n; i++) buildChunk(body, 0, level, ix + (i % 7), iy + (i % 5), 40); });
    row(`terrain chunk 40x40, ${label} level ${level}`, ms, ms / n, 'chunk', `(${Math.round((41 * 41 + 164) * n / ms)} k vertices/s)`);
  }
}
// ---- texture bakes (worker pool)
for (const [body, label] of [[home, 'Verda'], [pell, 'Pell']]) {
  const [ms] = cpuMs(() => bakeRows(body, 2048, 1024, 500, 524), 3);
  row(`body map bake 2048x1024, ${label} (24 rows timed)`, ms, ms / 24 * 1024, 'whole map', '(spread over the worker pool)');
}
{ const [ms] = cpuMs(() => bakeCloudRows(home, 2048, 1024, 500, 524), 3); row('cloud map bake 2048x1024, Verda', ms, ms / 24 * 1024, 'whole map'); }

// ---- physics step
{
  const { world, vessel } = SCENES.padLaunch();
  const ctl = AP.ascentProgram(world, {});
  for (let i = 0; i < 400; i++) { ctl.update(0.02); world.step(0.02); }          // off the pad, engines burning, in the air
  const n = 3000;
  const [ms] = cpuMs(() => { for (let i = 0; i < n; i++) world.step(1 / 60); }, 3);
  row(`world.step, Ember Twin ascent (${vessel.parts.size} parts)`, ms, ms / n, 'step', '(one per frame)');
}
{
  const { world } = SCENES.fleetWorld();
  const n = 3000;
  const [ms] = cpuMs(() => { for (let i = 0; i < n; i++) world.step(1 / 60); }, 3);
  row(`world.step, fleet of ${world.vessels.length} vessels on rails`, ms, ms / n, 'step');
}
{
  const { world, vessel } = SCENES.pellDescent();
  vessel.ctrl.throttle = 0.3;
  const n = 1500;
  const [ms] = cpuMs(() => { for (let i = 0; i < n; i++) world.step(1 / 60); }, 3);
  row(`world.step, Moonstep descent on Pell (${vessel.parts.size} parts)`, ms, ms / n, 'step');
}
// ---- trajectory prediction (map view; redone when the orbit changes)
{
  const { world, vessel } = SCENES.orbitScene();
  const orbit = vessel.orbit || vessel.getOrbit?.(world.ut);
  if (orbit) {
    const n = 200;
    const [ms] = cpuMs(() => { for (let i = 0; i < n; i++) predictPatches(orbit, vessel.body, world.ut + i, 4); });
    row('predictPatches, 85 km orbit, 4 patches', ms, ms / n, 'prediction', '(on orbit change, not per frame)');
  } else console.log('predictPatches: vessel has no .orbit accessor');
}
// ---- planners (run once, on a button)
{
  const { world, vessel } = SCENES.orbitScene();
  let plan = null;
  const [ms] = cpuMs(() => { try { plan = AP.planHohmannToMoon(world, vessel, pell, {}); } catch (e) { plan = 'threw: ' + e.message; } }, 3);
  row('planHohmannToMoon (Verda orbit → Pell)', ms, ms, 'plan', typeof plan === 'string' ? plan : '(one button press)');
  const rusk = SYSTEM.byId.rusk;
  const [ms2] = cpuMs(() => { try { AP.transferWindow(home, rusk, world.ut, {}); } catch { /* shape differs */ } }, 3);
  row('transferWindow (Verda → Rusk)', ms2, ms2, 'search');
  let ip = null;
  const [ms3] = cpuMs(() => { try { ip = AP.planInterplanetary(world, vessel, rusk, {}); } catch (e) { ip = 'threw: ' + e.message; } }, 3);
  row('planInterplanetary (Verda orbit → Rusk)', ms3, ms3, 'plan', typeof ip === 'string' ? ip : '(one button press)');
}
