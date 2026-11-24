// Development bench for the ship's return (docs/SHEARWATER.md, step 4): Shearwater in a 100 km orbit with a little
// propellant, a braking burn, then held belly to the wind all the way down. Prints what the air does to it.
//   node tests/tools/ship_return_dev.mjs [fuelFraction] [periapsisKm] [aoaDeg]
import { Vector3, Quaternion, Matrix4 } from '../../js/lib/three.module.min.js';
import { World } from '../../js/core/world.js';
import { shearwaterShip } from '../../js/core/craft.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { orbitState } from '../../js/core/scenarios.js';

const body = SYSTEM.get ? SYSTEM.get('verda') : SYSTEM.byId.verda;
export function bellyAttitude(v, aoa = Math.PI / 2, out = new Quaternion()) {
  // air-relative velocity u; belly (vessel −z) into the wind, nose (vessel +y) pitched `aoa` from u toward the horizon ahead
  const u = v.surfaceVel.clone(); if (u.lengthSq() < 1) u.copy(v.vel); u.normalize();
  const up = v.pos.clone().normalize();
  let lift = up.clone().addScaledVector(u, -up.dot(u)); if (lift.lengthSq() < 1e-6) lift.set(1, 0, 0).addScaledVector(u, -u.x); lift.normalize();
  // nose = u cos(aoa) + lift sin(aoa); belly normal −z faces the wind: z = −(u sin(aoa) − lift cos(aoa))
  const y = u.clone().multiplyScalar(Math.cos(aoa)).addScaledVector(lift, Math.sin(aoa)).normalize();
  const z = u.clone().multiplyScalar(-Math.sin(aoa)).addScaledVector(lift, Math.cos(aoa)).normalize();
  const x = y.clone().cross(z);
  return out.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}
import { shipReturn } from '../../js/core/shipreturn.js';
import { TOWER } from '../../js/core/tower.js';
export function flyHome({ frac = 0.14, cargo = false, phase = 0, opts = {}, quiet = true } = {}) {
  const w = new World(), st = orbitState(body, { pe: 100000, phase }, w.ut), site = SYSTEM.sites.tower;
  const pro = st.vel.clone().normalize(), out = st.pos.clone().normalize();
  const x = pro.clone().cross(out).normalize();
  const v = w.spawn(shearwaterShip({ cargo }), { crew: ['Juno', 'Bram'], body, pos: st.pos, vel: st.vel, q: new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, pro, x.clone().cross(pro))) });
  for (const p of v.partList) for (const k of ['lox', 'ch4']) if (p.res && p.res[k] != null) p.res[k] = p.def.res[k] * frac;
  v._updateMass(false); v.updateResources();
  if (v.stages.length && v.stageIndex === 0) v.activateNextStage();
  v.ctrl.throttle = 0; v.ctrl.rcs = true;
  w.switchTo(v);
  const events = [];
  w.on('*', (d, type) => { if (['caught', 'catchMissed', 'destroyed', 'landed', 'splashed', 'structure', 'overheat', 'towerStrike'].includes(type)) events.push({ type, reason: d.reason, speed: d.speed, offset: d.offset, ut: +w.ut.toFixed(1) }); });
  const ret = shipReturn(w, v, { target: site.dir, floor: TOWER.hang - 0.5, sets: { deorbit: 2, burn: 0, final: 0 }, ...opts });
  let t = 0, next = 0, gmax = 0, tmax = 0; const prop0 = v.partList.reduce((m, p) => m + (p.res.lox || 0) + (p.res.ch4 || 0), 0);
  while (t < 9000 && !ret.done && !v.dead) {
    ret.update(); w.step(0.02); t += 0.02;
    gmax = Math.max(gmax, v.gForce); tmax = Math.max(tmax, v.maxTempRatio || 0);
    if (!quiet && t >= next && (v.altitude < 72000)) { next = t + (v.altitude > 15000 ? 20 : 2); console.log(t.toFixed(0).padStart(5), ret.landing ? 'L:' + ret.landing.phase : ret.phase, 'alt', (v.altitude / 1000).toFixed(2), 'spd', v.surfaceVel.length().toFixed(0), 'M', v.mach.toFixed(2), 'g', v.gForce.toFixed(2), 'miss', (ret.miss / 1000).toFixed(2), 'thr', v.ctrl.throttle.toFixed(2), 'folds', v._flaps.map(p => (p.fold * 57.3).toFixed(0)).join(','), 'lvl', (() => { const u = v.pos.clone().normalize(); const h = v.surfaceVel.clone().addScaledVector(u, -v.surfaceVel.dot(u)); return h.length().toFixed(0); })(), 'aoa', (Math.acos(new Vector3(0, 1, 0).applyQuaternion(v.q).dot(v.surfaceVel.clone().normalize())) * 57.3).toFixed(0), 'L.v', v.bellyLift ? v.bellyLift.clone().normalize().dot(v.surfaceVel.clone().addScaledVector(v.pos.clone().normalize(), -v.surfaceVel.dot(v.pos.clone().normalize())).normalize()).toFixed(2) : '-', 'attErr', (() => { const q = v.bellyAttitude(new Quaternion()); return q ? (v.q.angleTo(q) * 57.3).toFixed(1) : '-'; })(), 'lift', v.bellyLift ? v.bellyLift.length().toFixed(2) : '-', 'act', v.actuation ? [v.actuation.x.toFixed(1), v.actuation.y.toFixed(1), v.actuation.z.toFixed(1)].join('/') : ''); }
  }
  for (let i = 0; i < 250; i++) w.step(0.02);
  const prop = v.partList.reduce((m, p) => m + (p.res.lox || 0) + (p.res.ch4 || 0), 0);
  return { w, v, ret, events, gmax, tmax, used: prop0 - prop, left: prop, t };
}
if (import.meta.url === 'file://' + process.argv[1] && process.argv[2] === 'home') {
  const r = flyHome({ frac: +(process.argv[3] || 0.14), cargo: process.argv[4] === 'cargo', quiet: !!process.env.Q, opts: { debug: !process.env.Q, ...(process.env.OPTS ? JSON.parse(process.env.OPTS) : {}) } });
  for (const l of r.ret.log) console.log(' ', l.t.toFixed(0), l.msg);
  if (r.ret.landing) for (const l of r.ret.landing.log) console.log('   L', l.t.toFixed(0), l.msg);
  console.log('events', JSON.stringify(r.events));
  console.log('ship', { dead: r.v.dead, landed: r.v.landed, held: r.v.surface && r.v.surface.held, gmax: r.gmax.toFixed(2), tmax: r.tmax.toFixed(2), used: (r.used / 1000).toFixed(1), left: (r.left / 1000).toFixed(1), mono: r.v._total('mono').toFixed(0) });
} else if (import.meta.url === 'file://' + process.argv[1]) {
  const frac = +(process.argv[2] || 0.1), peKm = +(process.argv[3] || 30), aoa = +(process.argv[4] || 70) * Math.PI / 180;
  const w = new World(), st = orbitState(body, { pe: 100000 }, w.ut);
  const pro = st.vel.clone().normalize();
  const v = w.spawn(shearwaterShip(), { crew: ['Juno', 'Bram'], body, pos: st.pos, vel: st.vel, q: new Quaternion() });
  for (const p of v.partList) for (const k of ['lox', 'ch4']) if (p.res && p.res[k] != null) p.res[k] = p.def.res[k] * frac;
  v._updateMass(false);
  w.switchTo(v);
  // braking burn done as an impulse: the question here is the air, not the burn
  const mu = body.gm, r1 = st.pos.length(), r2 = body.radius + peKm * 1000, a = (r1 + r2) / 2;
  const dv = st.vel.length() - Math.sqrt(mu * (2 / r1 - 1 / a));
  v.vel.addScaledVector(pro, -dv);
  console.log('mass t', (v.mass / 1000).toFixed(1), 'deorbit dv', dv.toFixed(0));
  const ev = []; w.on('*', (d, type) => { if (['destroyed', 'landed', 'splashed', 'structure', 'partDestroyed', 'overheat', 'breakup'].includes(type)) ev.push(type + '@' + w.ut.toFixed(0) + (d.reason ? ':' + d.reason : '') + (d.part ? ':' + (d.part.type || d.part) : '')); });
  v.ctrl.sas = true; v.ctrl.sasMode = 'belly'; v.ctrl.rcs = true; v.bellyAoa = aoa;
  let t = 0, next = 0, gmax = 0, qmax = 0, hmax = 0;
  const q = new Quaternion();
  while (t < 4000 && !v.dead && !v.landed) {
    w.step(0.02); t += 0.02;
    gmax = Math.max(gmax, v.gForce); qmax = Math.max(qmax, v.dynamicPressure); hmax = Math.max(hmax, v.maxTempRatio || 0);
    if (v.altitude < 72000 && t >= next) {
      next = t + (v.altitude > 20000 ? 10 : 5);
      const u = v.surfaceVel.clone().normalize(), nose = new Vector3(0, 1, 0).applyQuaternion(v.q), belly = new Vector3(0, 0, -1).applyQuaternion(v.q);
      const vv = v.vel.dot(v.pos.clone().normalize());
      console.log(t.toFixed(0).padStart(5), 'alt', (v.altitude / 1000).toFixed(1).padStart(5), 'spd', v.surfaceVel.length().toFixed(0).padStart(5), 'vv', vv.toFixed(0).padStart(5), 'M', v.mach.toFixed(2), 'g', v.gForce.toFixed(2), 'q kPa', (v.dynamicPressure / 1000).toFixed(1), 'T', (v.maxTempRatio || 0).toFixed(2), 'aoa', (Math.acos(nose.dot(u)) * 57.3).toFixed(0), 'belly', (Math.acos(belly.dot(u)) * 57.3).toFixed(0), 'folds', v._flaps.map(p => (p.fold * 57.3).toFixed(0)).join(','), 'mono', v._total('mono').toFixed(0));
    }
  }
  console.log('end', { dead: v.dead, landed: v.landed, alt: v.altitude.toFixed(0), gmax: gmax.toFixed(2), qmax: (qmax / 1000).toFixed(1), tmax: hmax.toFixed(2), parts: v.partList.length }, ev.slice(0, 12).join(' '));
}
