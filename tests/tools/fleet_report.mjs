// Flies every stock design on the ascent autopilot and reports what the flight did: orbit or not, delta-v used, where each
// stage fired, max Q, peak g, peak loads, anything lost. Used to show WHAT MOVED when the flight model changes: run it on
// two checkouts and compare.
//   node tests/tools/fleet_report.mjs [path to a checkout, default this one] [--json FILE]
// A change to drag is acceptable when these numbers move for a reason that can be stated, not merely when tests are green.
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json'), jsonFile = jsonAt >= 0 ? args[jsonAt + 1] : null;
const pathArg = args.find((a, i) => !a.startsWith('--') && i !== jsonAt + 1 || (jsonAt < 0 && !a.startsWith('--')));
const root = pathArg || new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const { World } = await import(root + '/js/core/world.js');
const { stockCrafts, stockSite } = await import(root + '/js/core/craft.js');
const AP = await import(root + '/js/core/autopilot.js');

export const rows = [];
for (const craft of stockCrafts()) {
  const site = stockSite ? stockSite(craft) : 'pad';
  const w = new World();
  let v;
  try { v = w.launch(craft, { crew: ['Ada'], site }); } catch (e) { rows.push({ name: craft.name, error: String(e.message || e) }); continue; }
  const body = v.body, top = body.atmo ? body.atmo.height : 0;
  const r = { name: craft.name, site, dv0: v.deltaV, stages: [], lost: [], maxQ: 0, maxQAlt: 0, maxQMach: 0, maxQSpeed: 0, maxG: 0, maxTemp: 0, maxJoint: 0, maxAir: 0, mach1Alt: null, dragLoss: 0 };
  w.on('*', (d, t) => {
    if (t === 'stage' && (!d.vessel || d.vessel === w.active)) r.stages.push({ t: +w.ut.toFixed(1), alt: Math.round(w.active.altitude), speed: Math.round(w.active.airspeed ?? w.active.vel.length()) });
    else if (t === 'explosion' || t === 'breakup' || t === 'torn') r.lost.push(t + (d.partName ? ':' + d.partName : '') + '@' + w.ut.toFixed(0));
  });
  let ctl = null;
  if (site === 'pad') { try { ctl = AP.ascentProgram(w, { targetAlt: 80000, useWarp: false }); } catch { ctl = null; } }
  if (!ctl) { rows.push({ ...r, note: 'not a rocket on the pad: no ascent flown' }); continue; }
  const dt = 0.02;
  for (let i = 0; i < 60000; i++) {
    if (!ctl.done) ctl.update(dt);
    w.step(dt);
    const a = w.active;
    if (!a || a.dead) { r.note = 'vessel lost'; break; }
    const q = a.dynamicPressure || 0;
    if (q > r.maxQ) { r.maxQ = q; r.maxQAlt = a.altitude; r.maxQMach = a.mach; r.maxQSpeed = a.airspeed; }
    if (r.mach1Alt === null && a.mach >= 1) r.mach1Alt = Math.round(a.altitude);
    if (a.gForce > r.maxG) r.maxG = a.gForce;
    if (a.maxTempRatio > r.maxTemp) r.maxTemp = a.maxTempRatio;
    if (a.structure && a.structure.maxUtil > r.maxJoint) r.maxJoint = a.structure.maxUtil;
    if (a.airUtil > r.maxAir) r.maxAir = a.airUtil;
    if (ctl.done && a.altitude > top) break;
  }
  const a = w.active;
  if (a && !a.dead) {
    r.ut = +w.ut.toFixed(1); r.periapsis = Math.round(a.periapsis); r.apoapsis = Math.round(a.apoapsis);
    r.orbit = a.periapsis > top; r.dvLeft = Math.round(a.deltaV); r.dvUsed = Math.round(ctl.dvUsed || 0); r.failed = !!ctl.failed;
  }
  r.dv0 = Math.round(r.dv0); r.maxQ = Math.round(r.maxQ); r.maxQAlt = Math.round(r.maxQAlt); r.maxQMach = +(+r.maxQMach).toFixed(2); r.maxQSpeed = Math.round(r.maxQSpeed);
  r.maxG = +r.maxG.toFixed(2); r.maxTemp = +r.maxTemp.toFixed(3); r.maxJoint = +r.maxJoint.toFixed(3); r.maxAir = +r.maxAir.toFixed(3);
  rows.push(r);
  console.error('  flown', craft.name);
}
const pad = (s, n) => String(s ?? '').padEnd(n);
console.log(pad('design', 18) + pad('orbit', 7) + pad('dv used', 9) + pad('dv left', 9) + pad('max Q Pa', 10) + pad('at m', 8) + pad('Mach', 6) + pad('M1 at m', 9) + pad('g', 6) + pad('joint', 7) + pad('air', 7) + 'stages (alt m)');
for (const r of rows) {
  if (r.note && r.orbit === undefined) { console.log(pad(r.name, 18) + (r.error || r.note)); continue; }
  console.log(pad(r.name, 18) + pad(r.orbit ? 'yes' : 'NO', 7) + pad(r.dvUsed, 9) + pad(r.dvLeft, 9) + pad(r.maxQ, 10) + pad(r.maxQAlt, 8) + pad(r.maxQMach, 6) + pad(r.mach1Alt, 9) + pad(r.maxG, 6) + pad(r.maxJoint, 7) + pad(r.maxAir, 7) + r.stages.map(s => s.alt).join(', ') + (r.lost.length ? '  LOST ' + r.lost.join(' ') : ''));
}
if (jsonFile) writeFileSync(jsonFile, JSON.stringify(rows, null, 1));
