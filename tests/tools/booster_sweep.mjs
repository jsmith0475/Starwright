// Flies the recovery program from many separation states and prints one line per flight (development and the
// dispersion check of docs/BOOSTERS.md).   node tests/tools/booster_sweep.mjs [n] [seed]
import { dropped, home } from './booster_dev.mjs';
import { boosterRecovery } from '../../js/core/booster.js';
import { Vector3 } from '../../js/lib/three.module.min.js';

export function flyReturn(start, opts = {}) {
  const { w, v } = dropped(start);
  const target = opts.target || home.dirFromLatLon(600 / home.radius, 0);
  const c = boosterRecovery(w, v, { target, ...opts });
  const t0 = w.ut, m0 = v.mass, ax = new Vector3(), up = new Vector3();
  let maxQ = 0, maxT = 0, vsTouch = 0, hsTouch = 0, tilt = 0;
  while (!c.done && w.ut - t0 < 1200) {
    c.update(0.02);
    if (!v.landed && v.radarAlt > 0.12) { vsTouch = v.verticalSpeed; hsTouch = v.horizontalSpeed; tilt = ax.set(0, 1, 0).applyQuaternion(v.q).angleTo(up.copy(v.pos).normalize()) * 180 / Math.PI; }
    w.step(0.02);
    if (v.dead) { c.update(0.02); break; }
    maxQ = Math.max(maxQ, v.dynamicPressure || 0);
    for (const p of v.partList) maxT = Math.max(maxT, p.temp / p.def.maxTemp);
  }
  const endTilt = v.dead ? 90 : ax.set(0, 1, 0).applyQuaternion(v.q).angleTo(up.copy(v.pos).normalize()) * 180 / Math.PI;
  return { ok: !!(c.done && !c.failed && v.landed && endTilt < 5), phase: c.phase, t: w.ut - t0, miss: c.miss, vs: vsTouch, hs: hsTouch, tilt, endTilt, used: m0 - v.mass, dvLeft: v.dead ? 0 : v.estimateDeltaV(), maxQ, maxT, parts: v.partList.length, log: c.log.map(l => `${(l.t - t0).toFixed(0)} ${l.msg}`) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const n = +(process.argv[2] || 12); let seed = +(process.argv[3] || 1);
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let good = 0;
  for (let i = 0; i < n; i++) {
    const start = { alt: 22000 + rnd() * 18000, speed: 850 + rnd() * 500, pitch: 35 + rnd() * 25, east: 12000 + rnd() * 28000, fuel: 0.42 + rnd() * 0.14 };
    const r = flyReturn(start);
    const inside = r.ok && r.miss < 10 && Math.abs(r.vs) < 2 && r.hs < 1 && r.tilt < 3;
    if (inside) good++;
    console.log(`${inside ? 'OK  ' : r.ok ? 'out ' : 'FAIL'} alt ${(start.alt / 1000).toFixed(0)} km  ${start.speed.toFixed(0)} m/s  pitch ${start.pitch.toFixed(0)}  east ${(start.east / 1000).toFixed(0)} km | ${r.phase} ${r.t.toFixed(0)} s  miss ${r.miss.toFixed(2)} m  vs ${r.vs.toFixed(2)}  hs ${r.hs.toFixed(2)}  tilt ${r.tilt.toFixed(1)}  used ${r.used.toFixed(0)} kg  dv left ${r.dvLeft.toFixed(0)}  maxT ${r.maxT.toFixed(2)}`);
    if (!r.ok) console.log('      ' + r.log.join(' / '));
  }
  console.log(`${good} of ${n} inside the touchdown targets`);
}
