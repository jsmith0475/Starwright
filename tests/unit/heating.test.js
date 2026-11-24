// Heating by shape (docs/HEATING.md; part E of docs/REENTRY_SPEC.md). The numbers are checked against an independent
// heat balance in tests/verify/checks_heat.mjs (chapter 14); these tests cover how the model behaves as part of the
// game: what burns and what does not, the setting, the record of an entry, saving, and the stock rockets' climb.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../js/core/world.js';
import { Craft } from '../../js/core/craft.js';
import { SYSTEM, GASES } from '../../js/core/bodies.js';
import { PARTS } from '../../js/core/parts.js';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { Vessel, TUNING, HEAT_SCALE_GAME } from '../../js/core/vessel.js';
import { predictEntry } from '../../js/core/entry.js';
import { runAll } from '../verify/run.mjs';

const home = SYSTEM.home, DEG = Math.PI / 180;
/** A capsule at the top of the air, base first. `build(craft, pod)` may add to it. */
function entry({ speed = 2300, fpa = 1.5, shield = true, build = null } = {}) {
  const c = new Craft('capsule');
  let pod;
  if (shield) { const s = c.setRoot('heatshield_m')[0]; pod = c.attachStack('pod_acorn', s.id, 'top')[0]; } else pod = c.setRoot('pod_acorn')[0];
  if (build) build(c, pod);
  c.autoStage();
  const w = new World(), r = home.radius + home.atmo.height - 1, a = fpa * DEG;
  const v = w.spawn(c, { crew: ['Ada'], body: home, pos: new Vector3(r, 0, 0), vel: new Vector3(-speed * Math.sin(a), 0, speed * Math.cos(a)) });
  v.q.setFromUnitVectors(new Vector3(0, 1, 0), v.airDirection(new Vector3()).negate());
  v.w.set(0, 0, 0); v.ctrl.throttle = 0; v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde';
  return { w, v };
}
/** Fly it down to 5 km (or until it is gone, or back out of the air). Returns the peak temperature of each part type and what was lost. */
function fly({ w, v }, tMax = 900) {
  const peak = {}, names = new Map([...v.parts.values()].map(p => [p.id, p.def.id])), lost = [];
  for (let t = 0; t < tMax && !v.dead && !v.landed && v.altitude > 5000; t += 0.02) {
    w.step(0.02);
    for (const p of v.parts.values()) peak[p.def.id] = Math.max(peak[p.def.id] || 0, p.temp);
    for (const [id, name] of names) if (!v.parts.has(id)) { lost.push(name); names.delete(id); }
    if (v.altitude > home.atmo.height + 500) break;
  }
  return { peak, lost, dead: v.dead || v.parts.size === 0 };
}

test('physics verification, heating: constants, flux by attitude and size, the heat balance and ablation against a second integration', async () => {
  const S = await runAll({ fast: true, only: ['14'] });
  assert.ok(S.passed.length > 50, `only ${S.passed.length} checks ran`);
  assert.equal(S.failed.length, 0, '\n' + S.failed.map(r => `${r.group} :: ${r.name}: expected ${r.expected}, got ${r.actual}`).join('\n'));
});

test('E5: the scale is declared, and the gases carry their own constants', () => {
  assert.equal(TUNING.HEAT_SCALE, HEAT_SCALE_GAME);
  assert.equal(HEAT_SCALE_GAME, 20);
  assert.equal(GASES.air.heatK, 1.7415e-4);
  assert.equal(GASES.co2.heatK, 1.9027e-4);
  assert.ok(GASES.h2he.heatK > 6e-5 && GASES.h2he.heatK < 8e-5);
  for (const b of SYSTEM.bodies) if (b.atmo) assert.ok(b.atmo.heatK > 0 && b.atmo.cp > 500, b.name);
});

test('a bare capsule comes home from low orbit and burns up coming home from Pell; with a shield it does both', () => {
  const low = fly(entry({ shield: false }));
  assert.ok(!low.dead && low.peak.pod_acorn > 1500 && low.peak.pod_acorn < 1900, 'low orbit, no shield: ' + JSON.stringify(low));
  const pell = fly(entry({ shield: false, speed: 3300, fpa: 14 }));
  assert.ok(pell.dead, 'from Pell, no shield: ' + JSON.stringify(pell));
  for (const [speed, fpa] of [[2300, 1.5], [3300, 14]]) {
    const r = fly(entry({ speed, fpa }));
    assert.ok(!r.dead && r.lost.length === 0, `shielded, ${speed} m/s: ` + JSON.stringify(r));
    assert.ok(r.peak.heatshield_m <= TUNING.ABLATE_TEMP + 1e-6, 'the face is held at the ablation temperature: ' + r.peak.heatshield_m);
    assert.ok(r.peak.pod_acorn < 400, 'the capsule in the shield\'s shadow stays cold: ' + r.peak.pod_acorn);
  }
});

test('E2, E4: a small part out in the stream burns off first; the same part inside the shield\'s shadow comes home', () => {
  // the Whip Antenna stands 1.2 m out from the capsule's side, past the shield's edge; a solar tile lies flat inside it
  const r = fly(entry({ build: (c, pod) => { c.attachRadial('antenna', pod.id, pod.pos.y, 0, 1); c.attachRadial('solar_tile', pod.id, pod.pos.y, 1.5, 1); } }));
  assert.deepEqual(r.lost, ['antenna'], JSON.stringify(r));
  assert.ok(!r.dead && r.peak.solar_tile < 1200, 'the tile in the shadow: ' + r.peak.solar_tile);
});

test('E7: ablator leaves in proportion to heat and area, the record keeps it, and the prediction counts on it', () => {
  const e = entry();
  const shield = [...e.v.parts.values()].find(p => p.def.heatshield), a0 = shield.res.ablator, m0 = e.v.mass;
  const model = e.v.entryModel();
  assert.ok(model.ablate && model.ablate.left === a0 && model.ablate.area > 1, JSON.stringify(model.ablate));
  const withLoss = predictEntry(home, e.v.pos, e.v.vel, e.w.ut, { ...model, floor: 5000 }), without = predictEntry(home, e.v.pos, e.v.vel, e.w.ut, { ...model, ablate: null, floor: 5000 });
  fly(e);
  const used = a0 - shield.res.ablator;
  assert.ok(used > 60 && used < 110, 'ablator used from low orbit: ' + used.toFixed(1) + ' kg of ' + a0);
  assert.ok(Math.abs(e.v.ablated - used) < 1e-3, 'the record agrees with the shield: ' + e.v.ablated + ' vs ' + used);
  assert.ok(m0 - e.v.mass >= used - 1e-6, 'and the vessel is that much lighter');
  assert.ok(e.v.peakTempRatio > 0.4 && e.v.peakTempRatio < 0.62 && e.v.heatLoad > 1e6 && e.v.peakHeatFlux > 5e4, JSON.stringify([e.v.peakTempRatio, e.v.heatLoad, e.v.peakHeatFlux]));
  // a lighter capsule slows sooner and higher up: the prediction with the loss in it takes longer to come down
  assert.ok(withLoss.end === 'land' && without.end === 'land' && withLoss.t > without.t, `${withLoss.t} vs ${without.t}`);
});

test('the heating record and each part\'s temperature survive a save, part way down', () => {
  const e = entry();
  for (let i = 0; i < 9000 && e.v.maxTempRatio < 0.45; i++) e.w.step(0.02);
  assert.ok(e.v.isHot && e.v.hotPart && e.v.hotPart.def.heatshield, 'the shield is the hottest part');
  const v2 = Vessel.fromJSON(JSON.parse(JSON.stringify(e.v.toJSON())));
  assert.ok(Math.abs(v2.peakTempRatio - e.v.peakTempRatio) < 1e-3 && Math.abs(v2.heatLoad - e.v.heatLoad) <= 1 && Math.abs(v2.ablated - e.v.ablated) < 0.01 && Math.abs(v2.peakHeatFlux - e.v.peakHeatFlux) <= 1);
  const t1 = [...e.v.parts.values()].map(p => p.temp), t2 = [...v2.parts.values()].map(p => p.temp);
  assert.deepEqual(t2, t1);
});

test('E5: at physical strength (S = 1) the bare capsule comes home from Pell, far below its limit', () => {
  TUNING.HEAT_SCALE = 1;
  try {
    const r = fly(entry({ shield: false, speed: 3300, fpa: 14 }));
    assert.ok(!r.dead && r.peak.pod_acorn < 1300, JSON.stringify(r));
  } finally { TUNING.HEAT_SCALE = HEAT_SCALE_GAME; }
});

test('the air cannot heat a skin past its own total temperature: a tank falling at 1,000 m/s stays under it', () => {
  const c = new Craft('tank'); c.setRoot('tank_m400'); c.autoStage();
  const w = new World(), r = home.radius + home.atmo.height - 1;
  const v = w.spawn(c, { body: home, pos: new Vector3(r, 0, 0), vel: new Vector3(-600, 0, 800) });
  let peak = 0, rec = 0;
  for (let i = 0; i < 20000 && !v.dead && !v.landed && v.altitude > 3000; i++) { w.step(0.02); for (const p of v.parts.values()) peak = Math.max(peak, p.temp); rec = Math.max(rec, v.recoveryTemp || 0); }
  assert.ok(!v.dead && peak < rec && rec < 1300, `peak ${peak.toFixed(0)} K, total temperature ${rec.toFixed(0)} K`);
});

test('E9: a tiled side takes the heat its bare side cannot', () => {
  const tiled = Object.values(PARTS).find(p => p.tiles && p.attach && p.attach.stack);
  assert.ok(tiled, 'a tiled part exists');
  const fate = roll => {
    const c = new Craft('ship'); c.setRoot(tiled.id); c.autoStage();
    const w = new World(), r = home.radius + 40000, wy = 2 * Math.PI / home.rotPeriod;
    const v = w.spawn(c, { body: home, pos: new Vector3(r, 0, 0), vel: new Vector3(0, 0, 2400 - wy * r) });
    // side on to the air: roll 0 puts its own +z to the wind, roll pi its -z (the tiled belly)
    v.q.setFromAxisAngle(new Vector3(0, 1, 0), roll);
    v.w.set(0, 0, 0); v.ctrl.sas = false;
    const p = [...v.parts.values()][0];
    p.temp = tiled.maxTemp + 250; v._hot = true;
    w.step(0.02);
    return !v.dead && v.parts.size === 1;
  };
  assert.ok(fate(Math.PI), 'belly to the wind it holds');
  assert.ok(!fate(0), 'back to the wind it does not');
});
