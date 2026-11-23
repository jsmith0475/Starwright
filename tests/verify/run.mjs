// Starwright physics verification report.
//
//   node tests/verify/run.mjs              full report (a few minutes)
//   node tests/verify/run.mjs --fast       the quick subset (what tests/unit/physics_verify.test.js runs)
//   node tests/verify/run.mjs --only 3     only the groups whose name starts with "3"
//   node tests/verify/run.mjs --json FILE  also write the rows as JSON
//
// Every row compares the real game core (js/core) with tests/verify/ref.mjs, an independent reference that
// shares no maths with the game. Exit code 1 if any check fails.
import { writeFileSync } from 'node:fs';
import { Suite, printTable } from './harness.mjs';

export const MODULES = ['./checks_twobody.mjs', './checks_burns.mjs', './checks_multibody.mjs', './checks_planner.mjs', './checks_surface.mjs', './checks_nbody.mjs', './checks_structure.mjs', './checks_breakup.mjs', './checks_booster.mjs', './checks_aero.mjs'];

export async function runAll({ fast = false, only = null, skip = null, log = null } = {}) {
  const S = new Suite();
  for (const m of MODULES) {
    let mod;
    try { mod = await import(m); } catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(m.slice(2))) continue; throw e; }
    for (const g of mod.groups) {
      if (fast && !g.fast) continue;
      if (only && !only.some(p => g.name.startsWith(p))) continue;
      if (skip && skip.some(p => g.name.startsWith(p))) continue;
      S.group = g.name;
      const t0 = Date.now();
      try { await g.run(S, !fast); } catch (e) { S.ok('group ran without throwing', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
      if (log) log(`  [${((Date.now() - t0) / 1000).toFixed(1)} s] ${g.name}`);
    }
  }
  return S;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  const fast = args.includes('--fast');
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
  const t0 = Date.now();
  console.log(`Starwright physics verification (${fast ? 'fast subset' : 'full'})`);
  const S = await runAll({ fast, only, log: m => console.error(m) });
  printTable(S.rows);
  const info = S.rows.filter(r => r.status === 'INFO').length;
  console.log(`\n${S.passed.length} passed, ${S.failed.length} failed, ${info} informational rows; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (S.failed.length) { console.log('\nFAILED:'); printTable(S.failed); }
  if (args.includes('--json')) writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify(S.rows, null, 1));
  process.exit(S.failed.length ? 1 : 0);
}
