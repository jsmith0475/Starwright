// The Heron folding leg (docs/BOOSTERS.md, "Legs that fold"): it lies inside its own box against the tank until the
// booster's own landing swings it out, just before touchdown. Every flight here is the game's own physics at 0.02 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../js/core/world.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { Craft } from '../../js/core/craft.js';
import * as AP from '../../js/core/autopilot.js';
import { partDef } from '../../js/core/parts.js';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { boosterRecovery } from '../../js/core/booster.js';
import { dropped, heronBooster, boosterCraft } from '../tools/booster_dev.mjs';

const home = SYSTEM.home;
test('the part: a long leg whose pad, once down, stands well below the engine and wide of the tank', () => {
  const d = partDef('leg_heron'), L = d.legs;
  assert.equal(d.shape, 'leg'); assert.equal(d.variant, 'fold');
  // stowed, the leg from its hinge (10 cm above the foot of the box) to its pad fits inside the box
  const hingeY = -d.h / 2 + 0.1, len = Math.hypot(L.spread - (-d.rw / 2 + 0.1), -L.reach + 0.3 * L.foot - hingeY);
  assert.ok(hingeY + len < d.h / 2, `the folded leg (${len.toFixed(2)} m) fits its ${d.h} m box`);
  const w = new World(), v = w.launch(heronBooster(), { crew: [] });
  const eng = v.partList.find(p => p.type === 'eng_goshawk'), leg = v.legParts[0];
  const nozzle = eng.pos.y - eng.def.h / 2, foot = leg.pos.y - L.reach;
  assert.ok(foot < nozzle - L.stroke, `pad ${(nozzle - foot).toFixed(2)} m below the nozzle, more than the ${L.stroke} m the strut can close`);
  assert.ok(L.spread > 4 * partDef('tank_m400').r, 'a stance much wider than the tank');
});

test('stowed, the legs add nothing below or beside their boxes; down, the craft stands on their four pads', () => {
  const w = new World(), v = w.launch(heronBooster(), { crew: [] });
  const low = () => Math.min(...v._pts.map(p => p.y)), wide = () => Math.max(...v._pts.map(p => Math.hypot(p.x, p.z)));
  assert.equal(v.legsDown, false, 'legs are folded on the pad');
  const y0 = low(), r0 = wide();
  const eng = v.partList.find(p => p.type === 'eng_goshawk');
  assert.ok(Math.abs(y0 - (eng.pos.y - eng.def.h / 2)) < 0.05, 'folded, the lowest point is the engine');
  assert.ok(r0 < 1.6, 'folded, nothing reaches further out than the grid fins: ' + r0.toFixed(2));
  v.setLegs(true);
  assert.ok(low() < y0 - 0.4 && wide() > 3, `down: ${(y0 - low()).toFixed(2)} m below the engine, ${wide().toFixed(2)} m out`);
});

test('folded flat, the legs barely change what the stage shows the air', () => {
  const area = craft => { const w = new World(), v = w.launch(craft, { crew: [] }); return v.axialDragArea(true); };
  const bare = boosterCraft(), withLegs = heronBooster();
  const a0 = area(bare), a1 = area(withLegs);
  assert.ok(a1 < a0 * 1.6, `drag area ${a0.toFixed(2)} m² on small legs, ${a1.toFixed(2)} m² on folding legs`);
  assert.equal(partDef('leg_heron').aRad, 0.2);
});

test('a return: legs folded all the way down, out below 60 m, and the stage lands and stands on them', () => {
  const { w, v } = dropped({ alt: 30000, speed: 1000, pitch: 45, east: 20000, fuel: 0.3, craft: heronBooster() });
  const target = home.dirFromLatLon(600 / home.radius, 0);
  const c = boosterRecovery(w, v, { target });
  const t0 = w.ut, ax = new Vector3(), up = new Vector3();
  let downAt = null, minFolded = Infinity, vs = 0;
  while (!c.done && w.ut - t0 < 1200) {
    c.update(0.02);
    if (!v.legsDown) minFolded = Math.min(minFolded, v.radarAlt); else if (downAt === null) downAt = { alt: v.radarAlt, t: w.ut };
    if (!v.landed && v.radarAlt > 0.12) vs = v.verticalSpeed;
    w.step(0.02);
    if (v.dead) break;
  }
  const log = c.log.map(l => l.msg).join('\n');
  assert.ok(c.done && !c.failed && v.landed && !v.dead, log);
  assert.ok(/landing legs down at \d+ m/.test(log), log);
  assert.ok(downAt && minFolded > 40 && minFolded < 62, `folded down to ${minFolded.toFixed(0)} m`);
  assert.ok(Math.abs(vs) < 2 && c.miss < 10, `touchdown ${vs.toFixed(2)} m/s, ${c.miss.toFixed(1)} m from the target`);
  const tilt = ax.set(0, 1, 0).applyQuaternion(v.q).angleTo(up.copy(v.pos).normalize()) * 180 / Math.PI;
  assert.ok(tilt < 3, 'upright: ' + tilt.toFixed(2) + '°');
  // it stands on the pads, the engine clear of the ground
  for (let i = 0; i < 500; i++) w.step(0.02);
  const eng = v.partList.find(p => p.type === 'eng_goshawk');
  const pad = v.legParts[0], gap = (pad.def.legs.reach - (pad._comp || 0)) - (pad.pos.y - (eng.pos.y - eng.def.h / 2));
  assert.ok(v.landed && gap > 0.1, `engine ${gap.toFixed(2)} m clear of the ground with the struts loaded`);
  assert.ok(v.legParts.every(p => p._comp > 0.005 && p._comp < p.def.legs.stroke), 'every strut carries load and none is bottomed: ' + v.legParts.map(p => p._comp.toFixed(3)));
});

test('a whole flight on folding legs: it stages where a stage can turn round, lands by the pad, and is at rest within seconds', () => {
  const c = new Craft('Homecoming');
  const [pod] = c.setRoot('probe_wisp');
  let cur = pod, first = null, last = null;
  const lower = ['tank_m800', 'tank_m800', 'tank_m400'];
  for (const t of ['tank_m400', 'eng_sparrow', 'dec_m', 'probe_wisp', ...lower, 'eng_goshawk']) {
    const [p] = c.attachStack(t, cur.id, 'bottom'); assert.ok(p, 'attach ' + t);
    if (lower.includes(t)) { if (cur.type === 'probe_wisp') first = p; last = p; }
    cur = p;
  }
  c.attachRadial('fin_grid', first.id, first.pos.y + 0.6, Math.PI / 4, 4);
  c.attachRadial('leg_heron', last.id, last.pos.y - partDef('tank_m400').h / 2 + 1.9, Math.PI / 4, 4);
  c.autoStage();
  const w = new World(), v = w.launch(c, { crew: [] }), target = home.sites.landing.dir;
  let b = null, rec = null, sep = null, touched = null, rest = null;
  w.on('decouple', d => { if (d.debris.type !== 'ship' || !d.debris.engines.length) return; b = d.debris; rec = boosterRecovery(w, b, { target }); b.updateTelemetry(w.ut); sep = { alt: b.altitude, speed: b.airspeed }; });
  w.on('landed', d => { if (d.vessel === b && touched === null) touched = w.ut; });
  const asc = AP.ascentProgram(w, { vessel: v, targetAlt: 80000, useWarp: false, recover: { target } });
  for (let i = 0; i < 60000 && !(rec && rec.done && rest !== null); i++) {
    if (!asc.done) asc.update(0.02);
    if (rec && !rec.done) rec.update(0.02);
    w.step(0.02);
    if (touched !== null && rest === null && b.landed) rest = w.ut;
    if (touched !== null && w.ut - touched > 30) break;
  }
  // (with the legs counted at the size of their boxes the climb was so draggy that it staged at 15 km and 380 m/s)
  assert.ok(sep && sep.alt > 17000 && sep.speed > 600, 'separation: ' + JSON.stringify(sep));
  assert.ok(rec.done && !rec.failed && b.landed && rec.miss < 10, rec.log.map(l => l.msg).join('\n'));
  assert.ok(rest !== null && rest - touched < 8, `at rest ${(rest - touched).toFixed(1)} s after the pads touched`);
});
