// Dev tool: fly the landing autopilot down from low orbit at many points round a world and report what ground it
// came down on and whether the lander is still standing.
//   node tests/tools/landing_sweep.mjs [bodies=dray,pell] [n=8] [craft="Wayfarer (lander)"] [key=value autopilot opts]
import { Vector3 } from '../../js/lib/three.module.min.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { World } from '../../js/core/world.js';
import * as AP from '../../js/core/autopilot.js';
import { SCENARIO_CRAFT, orbitState } from '../../js/core/scenarios.js';
import { assessSite, slopeLimit, footprint } from '../../js/core/landingsite.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const bodies = args.bodies === 'airless' ? SYSTEM.bodies.filter(b => b._solid && !b.atmo && b.type !== 'star').map(b => b.id) : (args.bodies || 'dray,pell').split(',');
const n = +(args.n || 8);
const only = args.i !== undefined ? +args.i : -1;
const craftName = args.craft || 'Wayfarer (lander)';
const opts = {};
for (const k of Object.keys(args)) if (!['bodies', 'n', 'craft', 'v', 'i', 'brake'].includes(k)) opts[k] = args[k] === 'true' ? true : args[k] === 'false' ? false : +args[k];
const DEG = 180 / Math.PI;

export function landOnce(bodyId, phase, craftName, opts = {}, verbose = false) {
  const b = SYSTEM.byId[bodyId];
  const w = new World();
  const alt = Math.max(8000, 0.12 * b.radius);
  const st = orbitState(b, { pe: alt, phase }, w.ut);
  const v = w.spawn(SCENARIO_CRAFT[craftName](), { body: b, pos: st.pos, vel: st.vel, crew: ['Ada'], makeActive: true });
  v.q.copy(st.q);
  v.updateTelemetry(w.ut);
  const dv0 = v.estimateDeltaV();
  let broke = 0;
  w.on('explosion', () => broke++);
  const t0 = Date.now();
  const c = AP.hoverslamLanding(w, v, { useWarp: true, ...opts });
  let touch = null;
  const tiltNow = () => new Vector3(0, 1, 0).applyQuaternion(v.q).angleTo(v.pos.clone().normalize()) * DEG;
  const brake = { t0: NaN, t1: NaN, alt: NaN, clear: Infinity, thr: 0 };
  AP.fly(w, c, { dt: 0.05, maxSim: +(opts.maxSim || 8000), until: () => touch && tiltNow() > 60, onStep: () => {
    if (c.phase === 'brake') { if (!(brake.t0 >= 0)) { brake.t0 = w.ut; brake.alt = v.radarAlt; } brake.t1 = w.ut; brake.thr = Math.max(brake.thr, v.ctrl.throttle); if (v.airspeed > 10) brake.clear = Math.min(brake.clear, v.radarAlt); }
    if (!touch && v.grounded) { const d = b.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut, new Vector3()); const s = assessSite(b, d, footprint(v)); touch = { slope: s.slope * DEG, rough: s.rough, limit: slopeLimit(v) * DEG, miss: c.site ? Math.acos(Math.min(1, d.dot(c.site.dir))) * b.radius : NaN, speed: v.groundSpeed, vs: v.verticalSpeed }; }
  } });
  for (let i = 0; i < 300 && !v.dead && tiltNow() < 60; i++) w.step(0.1);
  const up = v.pos.clone().normalize();
  const tilt = new Vector3(0, 1, 0).applyQuaternion(v.q).angleTo(up) * DEG;
  const slope = touch ? touch.slope : NaN;
  const r = { body: bodyId, phase, ok: c.done && !c.failed && !v.dead, dead: v.dead, tilt, slope, standing: !v.dead && v.landed && tilt < 25, limit: touch ? touch.limit : NaN, warning: c.warning || null, miss: touch ? touch.miss : NaN, want: c.site ? c.site.slope * DEG : NaN, tdSpeed: touch ? touch.speed : NaN,
    dv: dv0 - v.estimateDeltaV(), broke, brake: { alt: brake.alt, secs: brake.t1 - brake.t0, clear: brake.clear, thr: brake.thr }, ms: Date.now() - t0, log: c.log.map(l => l.msg), site: c.site || null };
  if (verbose) console.log(r.log.join('\n  '));
  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let stood = 0, total = 0;
  for (const id of bodies) {
    for (let i = 0; i < n; i++) {
      if (only >= 0 && i !== only) continue;
      const r = landOnce(id, i / n * Math.PI * 2 + 0.1, craftName, opts, !!args.v);
      total++; if (r.standing) stood++;
      if (args.brake) console.log(`${id.padEnd(6)} ${String(i).padStart(2)}  BRAKE from ${r.brake.alt.toFixed(0)} m for ${r.brake.secs.toFixed(0)} s, most throttle ${r.brake.thr.toFixed(2)}, least height while over 10 m/s ${r.brake.clear.toFixed(0)} m`);
      console.log(`${id.padEnd(6)} ${String(i).padStart(2)}  ${r.standing ? 'STANDS' : r.dead ? 'LOST  ' : 'FELL  '} slope ${r.slope.toFixed(1).padStart(5)}°  tilt ${r.tilt.toFixed(1).padStart(5)}°  site ${r.want.toFixed(1).padStart(4)}° miss ${r.miss.toFixed(1).padStart(5)} m at ${r.tdSpeed.toFixed(2)} m/s  dv ${r.dv.toFixed(0).padStart(5)}  ${r.ok ? '' : 'NOT DONE '}broke ${r.broke}  ${r.log.some(l => /pulling up/.test(l)) ? 'PULLUP ' : ''}${r.warning ? 'WARNED ' : ''}${r.log.some(l => /staying in orbit/.test(l)) ? 'WAITED ' : ''}${r.ms} ms  ${r.log[r.log.length - 1] || ''}`);
    }
  }
  console.log(`${stood} of ${total} standing`);
}
