// Aerodynamic breakup (docs/AERO_BREAKUP.md): air ratings in the catalog, thin roots, what a flip at max Q does
// to a stock rocket, what a clean climb does not do, the debris limit and the words the player reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PARTS, AIR_RATING, airRating } from '../../js/core/parts.js';
import { STRUCT, jointUtilisation, rootSection } from '../../js/core/structure.js';
import { TUNING } from '../../js/core/vessel.js';
import { World, MAX_DEBRIS, SCRAP_MASS } from '../../js/core/world.js';
import { Craft, stockCrafts } from '../../js/core/craft.js';
import { breakMessage, airRatingText, stressCause } from '../../js/ui/stress.js';

const DT = TUNING.DT_MAX;
const stock = name => stockCrafts().find(c => c.name === name);

/** Launch, climb on SAS at full throttle; with `flip`, pitch hard over once past 20 kPa and hold for 25 s. */
function fly(name, { flip = false, maxT = 120 } = {}) {
  const w = new World();
  const v = w.launch(stock(name), { crew: ['Ada'] });
  const lost = [], shed = [], messages = [];
  w.on('structure', d => { (d.vessel === v ? lost : shed).push(d); messages.push(breakMessage(d)); });
  v.ctrl.throttle = 1; v.ctrl.sas = true; w.stage();
  let t = 0, maxQ = 0, tFlip = -1, peakAir = 0;
  while (t < maxT && !v.dead) {
    w.step(DT); t += DT;
    maxQ = Math.max(maxQ, v.dynamicPressure);
    if (!flip && v.thrust === 0 && v.stageIndex < v.stages.length) w.stage();
    if (flip && tFlip < 0 && v.dynamicPressure > 20000) tFlip = t;
    if (tFlip >= 0) { v.ctrl.sas = false; v.ctrl.pitch = 1; if (t - tFlip > 25) break; }
    peakAir = Math.max(peakAir, v.airUtil || 0);
  }
  return { w, v, lost, shed, messages, maxQ, peakAir, flipped: tFlip >= 0 };
}

test('catalog: which parts carry an air rating, and which do not', () => {
  assert.deepEqual(airRating(PARTS.solar), { q: 3000, flow: 'open' });
  assert.equal(airRating(PARTS.solar_tile), null, 'a fixed tile has nothing to snap off');
  assert.equal(airRating(PARTS.tank_m400), null, 'a tank is judged by its joints');
  assert.equal(airRating(null), null);
  for (const d of Object.values(PARTS)) {
    const r = airRating(d);
    if (!r) continue;
    assert.ok(r.q >= 1000 && r.q <= 50000, `${d.id}: rating ${r.q} Pa`);
    assert.ok(r.flow === 'open' || r.flow === 'cross', `${d.id}: flow ${r.flow}`);
    assert.ok(!d.fin && !d.wing, `${d.id}: lifting surfaces fail at their roots, not on a rating`);
  }
  // every antenna, nose cone, radial clamp and folding panel is rated
  for (const d of Object.values(PARTS)) {
    if (d.antenna || d.shape === 'nose' || d.shape === 'radialdec' || (d.solar && !d.solar.fixed && d.solar.span > 0)) assert.ok(airRating(d), `${d.id} (${d.name}) has an air rating`);
  }
  assert.ok(Object.keys(AIR_RATING).length >= 9);
});

test('a part can opt out of, or override, its class rating', () => {
  assert.equal(airRating({ shape: 'nose', air: null }), null);
  assert.deepEqual(airRating({ shape: 'nose', air: { q: 9000, flow: 'cross' } }), { q: 9000, flow: 'cross' });
  assert.deepEqual(airRating({ shape: 'antenna', variant: 'dish' }), AIR_RATING.antenna_dish);
});

test('thin root: far weaker flat-wise than edge-wise, and weaker than the ring it replaces', () => {
  const cap = STRUCT.LINE_T, n = [1, 0, 0], root = { h: 1.2, t: 0.08, c: [0, 1, 0] };
  const flat = jointUtilisation([0, 0, 0], [0, 5000, 0], n, 0.3, cap, cap, cap, root);
  const edge = jointUtilisation([0, 0, 0], [0, 0, 5000], n, 0.3, cap, cap, cap, root);
  const ring = jointUtilisation([0, 0, 0], [0, 5000, 0], n, 0.3, cap, cap, cap);
  const sec = rootSection(1.2, 0.08);
  assert.ok(Math.abs(flat.util - 5000 / sec.zFlap / cap) < 1e-12);
  assert.ok(flat.util > 3 * edge.util, `flat ${flat.util} vs edge ${edge.util}`);
  assert.ok(flat.util > ring.util, 'the thin root is weaker in flat-wise bending than a 0.3 m ring');
  assert.equal(stressCause({ r: 0.3, rh: 1.2, rt: 0.08, capT: cap, capC: cap, capS: cap, bending: 5000, axial: 0, shear: 0, torsion: 0 }), 'bending');
});

test('fins and wings sit on thin roots in a live vessel; nothing else does', () => {
  const w = new World();
  const v = w.launch(stock('Skylark II'), { crew: ['Ada'] });
  w.step(DT);
  let thin = 0;
  for (const j of v.structure.joints) {
    const lifting = !!(j.b.def.fin || j.b.def.wing);
    assert.equal(j.rh > 0, lifting, `${j.b.def.name}: thin root ${j.rh}`);
    if (lifting) { thin++; assert.ok(j.rt > 0 && j.rt < j.rh, `${j.b.def.name}: ${j.rh} x ${j.rt} m`); }
  }
  assert.ok(thin >= 3, `${thin} fins`);
});

test('a clean climb through max Q tears nothing off (Ember Twin, Colossus)', () => {
  for (const name of ['Ember Twin', 'Colossus']) {
    const r = fly(name);
    assert.ok(r.maxQ > 20000, `${name}: max Q ${r.maxQ}`);
    assert.equal(r.lost.length, 0, `${name} lost: ${r.messages.join('; ')}`);
    assert.ok(r.peakAir < 0.5, `${name}: air utilisation ${r.peakAir}`);
  }
});

test('pitched hard over at max Q, Colossus loses its side boosters and they fly on as debris', () => {
  const r = fly('Colossus', { flip: true });
  assert.ok(r.flipped);
  const air = r.lost.filter(d => d.mode === 'airflow');
  assert.ok(air.length >= 2, `torn off: ${r.messages.join('; ')}`);
  assert.equal([...r.v.parts.values()].filter(p => p.def.shape === 'radialdec').length, 0, 'no clamp is left on the ship');
  for (const d of air) {
    assert.ok(d.air && d.air.q > d.air.rated, `${d.air.name}: ${d.air.q} over ${d.air.rated}`);
    assert.ok(d.debris && d.debris.type === 'debris', 'the piece is a debris vessel');
    assert.match(breakMessage(d), /torn off by the airflow: \d+(\.\d)? kPa across it, rated for \d+(\.\d)? kPa$/);
  }
  assert.ok(r.w.vessels.filter(x => x.type === 'debris').length >= 2);
});

test('with TUNING.AERO_FAIL off the same flip tears nothing off by the airflow', () => {
  TUNING.AERO_FAIL = false;
  try {
    const r = fly('Colossus', { flip: true });
    assert.equal(r.lost.filter(d => d.mode === 'airflow').length + r.shed.filter(d => d.mode === 'airflow').length, 0);
    assert.ok(r.peakAir > 1, 'the rating is still read');
  } finally { TUNING.AERO_FAIL = true; }
});

test('opening a solar panel in fast, thick air snaps it off; stowed, it rides through', () => {
  const run = open => {
    const w = new World();
    const v = w.launch(stock('Latch Target'), {});
    const torn = [];
    w.on('structure', d => { if (d.vessel === v && d.mode === 'airflow') torn.push(d); });
    v.ctrl.throttle = 1; v.ctrl.sas = true; w.stage();
    let t = 0;
    while (t < 60 && !v.dead) {
      w.step(DT); t += DT;
      if (open && v.dynamicPressure > 8000 && !v.solarOut) v.setSolar(true);
      if (torn.length) break;
    }
    return { v, torn };
  };
  const a = run(true), b = run(false);
  assert.ok(a.torn.length >= 1, 'an open panel is torn off');
  assert.ok(a.torn[0].air.open && /while open/.test(breakMessage(a.torn[0])), breakMessage(a.torn[0]));
  assert.equal(b.torn.length, 0, 'stowed panels stay on');
});

test('the world never keeps more than MAX_DEBRIS loose pieces, and drops the lightest', () => {
  const c = new Craft('Hedgehog');
  const [core] = c.setRoot('probe_keystone');
  let last = core;
  for (let k = 0; k < 5; k++) { const [tank] = c.attachStack('tank_m800', last.id, 'bottom'); c.attachRadial('antenna', tank.id, tank.pos.y, 0, 8); last = tank; }
  c.autoStage();
  const w = new World();
  const v = w.launch(c, {});
  // (no engine: lift it into fast air by hand, broadside)
  const up = v.pos.clone().normalize();
  v.pos.addScaledVector(up, 5000); v.landed = false;
  const east = v.surfaceVel.clone();
  v.vel.addScaledVector(up, 320);
  v.q.setFromUnitVectors(up.clone().set(0, 1, 0), up.clone().cross(east.lengthSq() > 0 ? east.normalize() : up.clone().set(0, 1, 0)).normalize());
  v.ctrl.sas = false;
  let most = 0, removed = 0;
  w.on('destroyed', d => { if (d.reason === 'breakup') removed++; });
  for (let i = 0; i < 200; i++) {
    w.step(DT);
    most = Math.max(most, w.vessels.filter(x => x.type === 'debris' && !x.dead).length);
  }
  assert.ok(most > 0 && most <= MAX_DEBRIS, `most loose pieces at once: ${most}`);
  assert.ok(removed === 0 || most === MAX_DEBRIS);
  assert.ok(SCRAP_MASS > 0);
  assert.ok(!v.dead, 'the ship is still there');
});

test('words: the break message and the part card', () => {
  assert.equal(breakMessage({ mode: 'airflow', joint: { bName: 'Whip Antenna' }, air: { name: 'Whip Antenna', q: 18200, rated: 12000 } }), 'The Whip Antenna was torn off by the airflow: 18 kPa across it, rated for 12 kPa');
  assert.equal(breakMessage({ mode: 'airflow', joint: { bName: 'Sunfoil Panel' }, air: { name: 'Sunfoil Panel', q: 4460, rated: 3000, open: true } }), 'The Sunfoil Panel was torn off by the airflow: 4.5 kPa on it while open, rated for 3 kPa');
  assert.equal(breakMessage({ mode: 'airflow', joint: { bName: 'Aero Nose' } }), 'The Aero Nose was torn off by the airflow');
  assert.equal(airRatingText({ q: 12000, flow: 'cross' }), '12 kPa of cross-flow');
  assert.equal(airRatingText({ q: 2500, flow: 'open' }), '2.5 kPa of airflow while open');
  assert.equal(airRatingText(null), '');
});
