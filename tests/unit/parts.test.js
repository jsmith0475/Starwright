// Catalog schema checks: every part definition is complete and internally consistent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PARTS, PART_LIST, CATEGORIES, SIZES, partDef, engineThrust, engineIsp } from '../../js/core/parts.js';

const num = (x, lo = 0) => typeof x === 'number' && Number.isFinite(x) && x >= lo;
const pos = x => num(x) && x > 0;
const CAT_IDS = new Set(CATEGORIES.map(c => c.id));
const SHAPES = new Set(['hotring', 'flap', 'catchpin', 'cargobay', 'pylon', 'capsule', 'probe', 'tank', 'monotank', 'engine', 'srb', 'decoupler', 'radialdec', 'adapter', 'leg', 'nose',
  'fin', 'heatshield', 'chute', 'chute_radial', 'battery', 'solar', 'gyro', 'rcs', 'antenna', 'sci_small', 'sci_jar', 'pip', 'dock',
  'cockpit', 'rover_body', 'fuselage', 'xenontank', 'radialtank', 'radialengine', 'multicoupler', 'girder', 'panel', 'strut',
  'fuelline', 'clamp', 'fairing', 'intake', 'airbrake', 'wing', 'elevon', 'tailfin', 'wheel', 'battery_radial', 'rtg', 'fuelcell',
  'light', 'ladder', 'lab']);
const RESOURCES = new Set(['fuel', 'solid', 'mono', 'elec', 'ablator', 'xenon', 'evafuel', 'lox', 'ch4']);
const ENGINE_TYPES = new Set(['liquid', 'solid', 'ion', 'nuclear', 'jet']);
const WING_CONTROL = new Set([false, 'pitch', 'roll', 'yaw', 'auto']);

// The first-pass catalog: ids and headline numbers must never change (saves and flight tests depend on them).
const LEGACY = {
  pod_acorn: [600, 0.8], pod_hearth: [3800, 4.0], probe_wisp: [450, 0.1], probe_mote: [300, 0.04],
  tank_s50: [70, 0.025], tank_m100: [150, 0.0625], tank_m200: [275, 0.125], tank_m400: [500, 0.25], tank_m800: [800, 0.5],
  tank_l1600: [1550, 1.0], tank_l3200: [3000, 2.0], tank_mono: [330, 0.08],
  eng_moth: [240, 0.08], eng_sparrow: [420, 0.5], eng_goshawk: [880, 1.3], eng_condor: [4200, 5.0], eng_lantern: [9000, 3.0],
  srb_ember: [220, 0.45], srb_maul: [480, 0.75],
  dec_m: [200, 0.05], dec_l: [420, 0.2], dec_radial: [300, 0.04], adapter_lm: [300, 0.2], adapter_ms: [120, 0.05], legs: [340, 0.05],
  nose_m: [180, 0.04], nose_l: [420, 0.15], fin: [90, 0.03], fin_ctrl: [260, 0.05], heatshield_m: [300, 0.1], heatshield_l: [600, 0.4],
  chute: [420, 0.1], chute_radial: [500, 0.1], battery: [180, 0.02], solar: [380, 0.02], gyro: [600, 0.1], rcs: [280, 0.03],
  antenna: [300, 0.005], sci_thermo: [180, 0.005], sci_baro: [220, 0.005], sci_jar: [520, 0.05], dock_m: [520, 0.08], dock_s: [340, 0.03],
};

test('catalog size and lookup', () => {
  assert.ok(PART_LIST.length >= 120, `only ${PART_LIST.length} parts`);
  assert.equal(new Set(PART_LIST.map(p => p.id)).size, PART_LIST.length, 'ids are unique');
  assert.equal(new Set(PART_LIST.map(p => p.name)).size, PART_LIST.length, 'names are unique');
  for (const p of PART_LIST) { assert.equal(partDef(p.id), p); assert.equal(PARTS[p.id], p); assert.ok(Object.isFrozen(p)); }
  assert.throws(() => partDef('no_such_part'));
  assert.ok(PARTS.pip && PARTS.pip.hidden && !PART_LIST.includes(PARTS.pip));
  assert.deepEqual(SIZES, { S: 0.3125, M: 0.625, L: 1.25, XL: 1.875, XXL: 2.8125 });
});

test('legacy parts keep their ids and numbers', () => {
  for (const [id, [cost, mass]] of Object.entries(LEGACY)) {
    const d = PARTS[id]; assert.ok(d, id);
    assert.equal(d.cost, cost, id + ' cost'); assert.equal(d.mass, mass, id + ' mass');
  }
  assert.deepEqual(PARTS.eng_goshawk.engine, { type: 'liquid', thrust: 220, ispVac: 305, ispAtm: 265, gimbal: 3.5 });
  assert.deepEqual(PARTS.tank_m200.res, { fuel: 1000 });
  assert.deepEqual(PARTS.legs.legs, { reach: 1.1, spread: 0.9, stroke: 0.32 });      // stroke: the suspension's travel (landing-leg suspension)
  assert.deepEqual(PARTS.chute.chute, { area: 420, semiArea: 12, fullAlt: 900, maxSpeed: 420 });
  assert.deepEqual(PARTS.solar.solar, { rate: 1.6, span: 2.4 });
});

test('every part has a valid base schema', () => {
  for (const d of Object.values(PARTS)) {
    const id = d.id;
    assert.match(id, /^[a-z][a-z0-9_]*$/, id);
    assert.ok(typeof d.name === 'string' && d.name.length >= 3 && d.name.length <= 34, id + ' name');
    assert.ok(typeof d.desc === 'string' && d.desc.length >= 10, id + ' desc');
    assert.ok(d.hidden ? d.cat === 'internal' : CAT_IDS.has(d.cat), id + ' cat ' + d.cat);
    assert.ok(typeof d.tech === 'string' && /^[a-z][a-z0-9_]*$/.test(d.tech), id + ' tech');
    assert.ok(num(d.cost), id + ' cost'); assert.ok(pos(d.mass) && d.mass < 50, id + ' mass');
    assert.ok(SHAPES.has(d.shape), id + ' shape ' + d.shape);
    assert.ok(pos(d.tolerance), id + ' tolerance'); assert.ok(d.maxTemp >= 800 && d.maxTemp <= 4000, id + ' maxTemp');
    assert.ok(d.variant === undefined || typeof d.variant === 'string', id + ' variant');
    const a = d.attach;
    assert.ok(a && ['stack', 'radial', 'surface', 'outer'].every(k => typeof a[k] === 'boolean'), id + ' attach');
    assert.ok(a.stack !== a.radial, id + ' is either a stack part or a radial part');
    assert.ok(pos(d.h), id + ' h');
    if (a.stack) {
      assert.ok(pos(d.r), id + ' r'); assert.ok(pos(d.rTop) && pos(d.rBottom), id + ' rTop/rBottom');
      assert.ok(d.hidden || d.size in SIZES, id + ' size');
      if (d.hidden) continue;
      assert.ok(d.shape === 'multicoupler' || Math.max(d.rTop, d.rBottom, d.r) <= SIZES[d.size] * 1.55 + 1e-9, id + ' radius fits its size class');
      if (!d.topOnly && d.shape !== 'heatshield') assert.ok(Object.values(SIZES).some(s => Math.abs(s - d.rBottom) < 0.03), id + ' bottom matches a size class');
    } else {
      assert.ok(pos(d.rw) && pos(d.t), id + ' rw/t');
      assert.equal(d.size, undefined, id + ' radial parts have no size class');
    }
    if (d.topOnly) assert.ok(a.stack && !a.surface, id + ' topOnly');
    // round 2: fixed hardpoints (shape 'pylon') carry a stack part on their outer face without ever releasing it
    if (a.outer) assert.ok(a.radial && (d.decoupler || d.shape === 'pylon'), id + ' outer mounts are radial decouplers or pylons');
    if (d.shape === 'pylon') assert.ok(a.outer && !d.decoupler, id + ' a pylon is a fixed outer mount');
    assert.ok(d.res && typeof d.res === 'object', id + ' res');
    for (const [k, v] of Object.entries(d.res)) { assert.ok(RESOURCES.has(k), id + ' resource ' + k); assert.ok(pos(v), id + ' ' + k); }
    for (const k of ['top', 'bottom', 'side']) assert.ok(num(d.drag[k]) && d.drag[k] <= 1.5, id + ' drag.' + k);
    if (d.command) { assert.ok(['crew', 'probe', 'eva'].includes(d.command), id); assert.ok(num(d.torque), id + ' torque'); assert.ok(pos(d.res.elec) || d.command === 'eva', id + ' has charge'); }
    if (d.command === 'crew') assert.ok(Number.isInteger(d.crew) && d.crew >= 1, id + ' crew');
    if (d.command === 'probe') assert.ok(d.crew === 0 && pos(d.elecDrain), id + ' probe');
    if (d.experiment) assert.match(d.experiment, /^[a-z_]+$/, id);
  }
});

test('engines', () => {
  const engines = Object.values(PARTS).filter(d => d.engine);
  assert.ok(engines.length >= 25);
  for (const d of engines) {
    const e = d.engine, id = d.id;
    assert.ok(ENGINE_TYPES.has(e.type), id + ' type');
    assert.ok(pos(e.thrust) && pos(e.ispVac) && pos(e.ispAtm) && num(e.gimbal) && e.gimbal <= 8, id);
    assert.ok(e.ispAtm <= e.ispVac, id + ' isp ordering');
    assert.ok(['engine', 'srb', 'radialengine'].includes(d.shape), id + ' shape');
    assert.ok(Math.abs(engineThrust(d, 0) - e.thrust * 1000) < 1e-6 && engineThrust(d, 1) <= engineThrust(d, 0) + 1e-6, id);
    assert.ok(engineIsp(d, 1) >= 1, id);
    if (e.type === 'solid') assert.ok(pos(d.res.solid) && e.gimbal === 0, id + ' solid');
    else assert.equal(d.res.solid, undefined, id);
    if (e.type === 'ion') assert.ok(pos(e.elecUse) && e.ispVac > 2000, id + ' ion'); else assert.equal(e.elecUse, undefined, id);
    if (e.type === 'jet') { assert.ok(e.jet && pos(e.jet.maxAlt) && pos(e.jet.maxMach), id + ' jet'); assert.equal(e.ispVac, e.ispAtm, id); }
    else assert.equal(e.jet, undefined, id);
    if (e.type === 'nuclear') assert.ok(e.ispVac >= 700 && d.mass >= 2, id + ' nuclear');
    // nothing absurd: thrust-to-weight of the bare engine in a sane band
    const twr = e.thrust / (d.mass * 9.81 + (d.res.solid || 0) * 9.81e-3);
    assert.ok(twr > 0.5 && twr < 400, `${id} bare TWR ${twr.toFixed(1)}`);
  }
  for (const t of ENGINE_TYPES) assert.ok(engines.some(d => d.engine.type === t), 'has a ' + t + ' engine');
  for (const s of Object.keys(SIZES)) assert.ok(engines.some(d => d.size === s && d.engine.type === 'liquid'), 'liquid engine in ' + s);
  assert.ok(Object.values(PARTS).some(d => d.res.xenon), 'xenon tanks exist');
});

test('wings, wheels and other second-pass fields', () => {
  for (const d of Object.values(PARTS)) {
    const id = d.id;
    if (['wing', 'elevon', 'tailfin'].includes(d.shape)) {
      assert.ok(d.attach.radial && d.wing, id);
      assert.ok(pos(d.wing.area) && WING_CONTROL.has(d.wing.control), id + ' wing');
      assert.ok(d.wing.sweep === undefined || (num(d.wing.sweep) && d.wing.sweep < 80), id + ' sweep');
      assert.ok(d.wing.area <= d.h * d.rw * 1.05, id + ' area fits its planform');
      assert.ok(d.t < 0.3 * Math.min(d.h, d.rw), id + ' is thin');
      if (d.shape === 'elevon') assert.ok(d.wing.control, id + ' elevons move');
    } else assert.equal(d.wing, undefined, id);
    if (d.fin) { assert.equal(d.shape, 'fin', id); assert.ok(pos(d.fin.area) && typeof d.fin.control === 'boolean', id); }
    if (d.shape === 'wheel') {
      const w = d.wheel; assert.ok(w && d.attach.radial, id);
      assert.ok(pos(w.radius) && num(w.drive) && pos(w.brake) && typeof w.steer === 'boolean' && pos(w.maxSpeed) && num(w.elecUse), id + ' wheel');
      assert.ok(w.retract === undefined || w.retract === true, id);
      if (w.drive === 0) assert.equal(w.elecUse, 0, id); else assert.ok(w.elecUse > 0, id);
      assert.ok(w.radius * 2 <= d.h + 1e-9, id + ' wheel fits its box');
    } else assert.equal(d.wheel, undefined, id);
    if (d.shape === 'light') assert.ok(d.light && pos(d.light.range), id); else assert.equal(d.light, undefined, id);
    if (d.legs) assert.ok(d.shape === 'leg' && pos(d.legs.reach) && pos(d.legs.spread), id);
    if (d.chute) assert.ok(pos(d.chute.area) && pos(d.chute.semiArea) && d.chute.semiArea < d.chute.area && pos(d.chute.fullAlt) && pos(d.chute.maxSpeed), id);
    if (d.solar) assert.ok(pos(d.solar.rate) && num(d.solar.span) && (d.solar.fixed ? d.solar.span === 0 : d.solar.span > 0), id);
    if (d.decoupler) assert.ok(num(d.decoupler.force), id);
    if (d.dock) assert.ok(d.dock.size === d.size && d.shape === 'dock', id);
    if (d.rcs) assert.ok(pos(d.rcs.thrust) && pos(d.rcs.isp), id);
    if (d.antenna) assert.ok(pos(d.antenna.rate), id);
    if (d.generator) assert.ok(pos(d.generator.rate), id);
    if (d.heatshield) assert.ok(pos(d.res.ablator) && d.maxTemp >= 3000, id);
    if (d.multi) assert.ok(d.shape === 'multicoupler' && d.multi.count >= 2 && pos(d.multi.radius), id);
  }
});

test('coverage: the catalog offers every family in every size', () => {
  const has = f => PART_LIST.some(f);
  for (const s of Object.keys(SIZES)) {
    if (s === 'XXL') continue;      // the Wayfarer stack's own size: a rocket, not a family of parts (see the test below)
    assert.ok(has(d => d.shape === 'tank' && d.size === s), 'tank ' + s);
    assert.ok(has(d => d.shape === 'decoupler' && d.size === s), 'decoupler ' + s);
    assert.ok(has(d => d.shape === 'heatshield' && d.size === s), 'heat shield ' + s);
    assert.ok(has(d => d.shape === 'nose' && d.size === s), 'nose ' + s);
    assert.ok(has(d => d.command && d.size === s), 'command ' + s);
  }
  for (const s of ['S', 'M', 'L']) {
    assert.ok(has(d => d.dock && d.size === s), 'dock ' + s); assert.ok(has(d => d.shape === 'gyro' && d.size === s), 'gyro ' + s);
    assert.ok(has(d => d.shape === 'battery' && d.size === s), 'battery ' + s);
  }
  for (const [a, b] of [['M', 'S'], ['L', 'M'], ['XL', 'L']])
    assert.ok(has(d => d.shape === 'adapter' && d.rBottom === SIZES[a] && d.rTop === SIZES[b]), `adapter ${a}-${b}`);
  assert.equal(PART_LIST.filter(d => d.shape === 'leg').length, 4);      // (three fixed-housing legs and the folding booster leg)
  assert.ok(PART_LIST.filter(d => d.shape === 'wheel' && d.wheel.drive > 0).length >= 2);
  assert.ok(has(d => d.shape === 'wheel' && d.wheel.retract));
  assert.ok(PART_LIST.filter(d => d.shape === 'wing').length >= 6);
  assert.ok(PART_LIST.filter(d => d.antenna).length >= 3);
  assert.ok(PART_LIST.filter(d => d.shape === 'srb').length >= 4);
  for (const sh of ['cockpit', 'rover_body', 'fuselage', 'intake', 'ladder', 'light', 'elevon', 'tailfin', 'radialengine', 'radialtank',
    'xenontank', 'multicoupler', 'girder', 'clamp', 'fairing', 'airbrake', 'rtg', 'lab']) assert.ok(has(d => d.shape === sh), sh);
  for (const c of CATEGORIES) assert.ok(PART_LIST.filter(d => d.cat === c.id).length >= 6, c.id + ' has parts');
});

test('round 2 data: lab field, wings take surface parts, capsules carry ballast, hardpoints exist', () => {
  assert.ok(PARTS.sci_lab.lab && PARTS.sci_lab.lab.rate > 0, 'the lab module has a lab field');
  for (const d of PART_LIST.filter(p => p.shape === 'wing' || p.shape === 'tailfin')) assert.ok(d.attach.surface && d.attach.radial, d.id + ' accepts surface parts');
  for (const d of PART_LIST.filter(p => p.shape === 'elevon')) assert.equal(d.attach.surface, false, d.id);
  assert.ok(PARTS.pod_acorn.comY < 0 && Math.abs(PARTS.pod_acorn.comY) < PARTS.pod_acorn.h / 2, 'the Acorn is ballasted toward its heat shield');
  assert.ok(PARTS.pod_hearth.comY < 0);
  assert.ok(PART_LIST.filter(p => p.shape === 'pylon').length >= 2);
  for (const d of PART_LIST.filter(p => p.wheel && p.wheel.retract)) assert.ok(d.shape === 'wheel', d.id);
});

test('renamed parts: old ids in saved designs and flights load as the new part', async () => {
  const { RENAMED_PARTS, currentPartId, PARTS } = await import('../../js/core/parts.js');
  const { Craft } = await import('../../js/core/craft.js');
  for (const [old, now] of Object.entries(RENAMED_PARTS)) {
    assert.ok(!PARTS[old], old + ' is gone');
    assert.ok(PARTS[now], now + ' exists');
    assert.equal(currentPartId(old), now);
  }
  assert.equal(currentPartId('pod_acorn'), 'pod_acorn');
  const c = new Craft('old');
  const [pod] = c.setRoot('pod_acorn');
  c.attachStack('srb_maul', pod.id, 'bottom');
  const saved = JSON.parse(JSON.stringify(c.toJSON()));
  saved.parts.find(p => p.type === 'srb_maul').type = 'srb_hammer';
  const back = Craft.fromJSON(saved);
  assert.deepEqual(back.parts.map(p => p.type), ['pod_acorn', 'srb_maul']);
  // no part name coincides with the names the pre-publication sweep flagged
  for (const d of Object.values(PARTS)) assert.doesNotMatch(d.name + ' ' + (d.desc || ''), /\b(Hammer|Puff|Spark|Kestrel)\b/, d.id);
});
