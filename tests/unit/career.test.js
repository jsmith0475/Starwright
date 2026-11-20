import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Career, START_FUNDS, TECH_TREE, MILESTONES, EXPERIMENTS, SITUATIONS, SAVE_KEY, NAME_POOL, STARTING_CREW, DEFAULT_SETTINGS,
  BODY_SCI_MULT, situationOf, recoveryValue, recoveryFraction, launchCost, crewOf, bodySciMult, techNode, milestoneDef,
} from '../../js/core/career.js';
import { PARTS, PART_LIST } from '../../js/core/parts.js';
import { SYSTEM } from '../../js/core/bodies.js';

function memStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    _map: m,
  };
}

const verda = { id: 'verda', radius: 6.4e5, atmo: { height: 72000 }, spaceBorder: 250000, sciMult: 1, parent: { id: 'helion' } };
const pell = { id: 'pell', radius: 2.1e5, atmo: null, spaceBorder: 60000, sciMult: 4, parent: verda };
const helion = { id: 'helion', radius: 2.2e8, atmo: null, parent: null };
const rusk = { id: 'rusk', radius: 3.6e5, atmo: { height: START_FUNDS }, sciMult: 6, parent: helion };

function fakeVessel(over = {}) {
  return { id: 1, name: 'Test', type: 'ship', body: verda, altitude: 0, landed: true, splashed: false,
    situation: 'prelaunch', parts: new Map([[1, { crew: ['Juno'] }]]), ...over };
}
const ids = list => list.map(m => m.milestoneId);

// ---------------------------------------------------------------- new game
test('new career game defaults', () => {
  const c = Career.newGame('career');
  assert.equal(c.mode, 'career');
  assert.equal(c.funds, START_FUNDS);
  assert.equal(START_FUNDS, 25000);
  assert.equal(c.science, 0);
  assert.equal(c.reputation, 0);
  assert.deepEqual([...c.tech], ['start']);
  assert.equal(c.milestones.size, 0);
  assert.equal(c.roster.length, 4);
  assert.deepEqual(c.roster.map(r => r.name), STARTING_CREW.map(r => r.name));
  assert.ok(c.roster.every(r => r.status === 'available' && r.flights === 0));
  assert.deepEqual(c.settings, { ...DEFAULT_SETTINGS });
  assert.equal(c.settings.invertPitch, false);
  assert.equal(c.settings.showHints, true);
  assert.equal(c.flightState, null);
  assert.ok(c.isPartUnlocked('pod_acorn'));
  assert.ok(!c.isPartUnlocked('eng_condor'));
  assert.ok(!c.isPartUnlocked('no_such_part'));
});

test('science mode ignores funds, sandbox unlocks everything', () => {
  const s = Career.newGame('science');
  assert.ok(s.canAfford(1e12));
  assert.ok(s.spend(1e12));
  assert.equal(s.funds, 0);
  assert.ok(!s.isPartUnlocked('eng_condor'));
  assert.equal(s.unlockTech('basic_rocketry').reason, 'science');

  const b = Career.newGame('sandbox');
  assert.ok(b.canAfford(1e12));
  assert.ok(b.spend(1e12));
  for (const p of PART_LIST) assert.ok(b.isPartUnlocked(p.id), p.id);
  assert.equal(b.tech.size, TECH_TREE.length);
  assert.throws(() => Career.newGame('bogus'));
});

test('career funds: canAfford / spend / earn', () => {
  const c = Career.newGame('career');
  assert.ok(c.canAfford(START_FUNDS));
  assert.ok(!c.canAfford(START_FUNDS + 1));
  assert.equal(c.spend(START_FUNDS + 5000), false);
  assert.equal(c.funds, START_FUNDS);
  assert.equal(c.spend(5000), true);
  assert.equal(c.funds, START_FUNDS - 5000);
  c.earn(1000, 5, 2);
  assert.equal(c.funds, START_FUNDS - 4000);
  assert.equal(c.science, 5);
  assert.equal(c.reputation, 2);
});

// ---------------------------------------------------------------- save / load
test('save/load round trip', () => {
  const st = memStorage();
  assert.equal(Career.hasSave(st), false);
  assert.equal(Career.load(st), null);

  const c = Career.newGame('career');
  c.earn(1234, 50, 3);
  c.unlockTech('basic_rocketry');
  c.creditScience('temperature', 'verda', 'flyingLow');
  c.completeMilestone('first_launch');
  c.assignCrew(['Juno']);
  c.saveCraft({ name: 'Hopper I', parts: [{ id: 1, type: 'pod_acorn' }], stages: [] });
  c.flightState = { ut: 12, vessels: [] };
  c.flightLog['7'] = { reachedSpace: true, landedOn: ['pell'], visited: ['verda', 'pell'] };
  c.settings.invertPitch = true;
  c.ut = 999;
  assert.equal(c.save(st), true);
  assert.ok(st._map.has('starwright.save.v1'));
  assert.equal(SAVE_KEY, 'starwright.save.v1');
  assert.equal(Career.hasSave(st), true);

  const d = Career.load(st);
  assert.ok(d instanceof Career);
  assert.deepEqual(d.toJSON(), c.toJSON());
  assert.ok(d.tech instanceof Set && d.tech.has('basic_rocketry'));
  assert.ok(d.milestones instanceof Set && d.milestones.has('first_launch'));
  assert.equal(d.roster.find(r => r.name === 'Juno').status, 'assigned');
  assert.equal(d.settings.invertPitch, true);
  assert.equal(d.listCrafts()[0].name, 'Hopper I');
  assert.deepEqual(d.flightLog['7'].landedOn, ['pell']);

  // JSON round trip without storage
  const e = Career.fromJSON(JSON.parse(JSON.stringify(c)));
  assert.deepEqual(e.toJSON(), c.toJSON());

  assert.equal(Career.deleteSave(st), true);
  assert.equal(Career.hasSave(st), false);
});

test('load tolerates corrupt or missing storage', () => {
  const st = memStorage();
  st.setItem(SAVE_KEY, '{not json');
  assert.equal(Career.load(st), null);
  assert.equal(Career.load(null), null);
  assert.equal(Career.hasSave(null), false);
  assert.equal(Career.newGame().save(null), false);
  const old = Career.fromJSON({ mode: 'career', settings: { sfxVolume: 0.1 } });
  assert.equal(old.settings.sfxVolume, 0.1);
  assert.equal(old.settings.showHints, true);
  assert.ok(old.tech.has('start'));
});

// ---------------------------------------------------------------- tech
test('tech tree shape', () => {
  const expected = ['start', 'basic_rocketry', 'general_construction', 'survivability', 'stability', 'propulsion',
    'electrics', 'heavy', 'landing', 'command2', 'miniature', 'advanced_propulsion',
    // second pass (docs/PARTS_TECH.md)
    'aviation', 'fuel_systems', 'aerodynamics', 'field_science', 'advanced_construction', 'advanced_electrics', 'deep_comms',
    'ground_ops', 'orbital_assembly', 'supersonic_flight', 'advanced_science', 'very_heavy', 'ion_propulsion', 'high_power',
    'nuclear_propulsion'];
  assert.deepEqual(TECH_TREE.map(n => n.id).sort(), [...expected].sort());
  const byId = Object.fromEntries(TECH_TREE.map(n => [n.id, n]));
  const names = new Set(), cells = new Set();
  for (const n of TECH_TREE) {
    assert.ok(n.name && !names.has(n.name)); names.add(n.name);
    assert.ok(Number.isInteger(n.x) && Number.isInteger(n.y));
    assert.ok(!cells.has(`${n.x},${n.y}`), 'grid cell reused'); cells.add(`${n.x},${n.y}`);
    for (const r of n.requires) {
      assert.ok(byId[r], `unknown prereq ${r}`);
      assert.ok(byId[r].x < n.x, 'prerequisites sit to the left');
      assert.ok(byId[r].cost <= n.cost, 'costs rise along the tree');
    }
    if (n.id !== 'start') { assert.ok(n.requires.length > 0); assert.ok(n.cost >= 5 && n.cost <= 800); }
    assert.ok(n.parts.length > 0, `${n.id} unlocks nothing`);
  }
  assert.equal(byId.start.cost, 0);
  assert.equal(Math.min(...TECH_TREE.filter(n => n.id !== 'start').map(n => n.cost)), 5);
  assert.equal(Math.max(...TECH_TREE.map(n => n.cost)), 800);
  assert.ok(TECH_TREE.every(n => !n.auto), 'every tech id in the catalog has a hand-written node');
  assert.equal(techNode('heavy').id, 'heavy');
  assert.equal(techNode('nope'), null);
});

test('every non-hidden part is unlocked by exactly one tech node', () => {
  const seen = new Map();
  for (const n of TECH_TREE) for (const p of n.parts) { assert.ok(!seen.has(p)); seen.set(p, n.id); }
  for (const p of PART_LIST) assert.equal(seen.get(p.id), p.tech, p.id);
  assert.equal(seen.size, PART_LIST.length);
  assert.ok(!seen.has('pip'));
  // and buying every node unlocks every part
  const c = Career.newGame('science');
  c.science = 1e6;
  let progress = true;
  while (progress) { progress = false; for (const n of TECH_TREE) if (c.unlockTech(n.id).ok) progress = true; }
  for (const p of PART_LIST) assert.ok(c.isPartUnlocked(p.id), p.id);
  assert.deepEqual(c.unlockedParts().sort(), PART_LIST.map(p => p.id).sort());
});

test('tech unlock rules', () => {
  const c = Career.newGame('career');
  assert.deepEqual(c.unlockTech('nope'), { ok: false, reason: 'unknown' });
  assert.deepEqual(c.unlockTech('start'), { ok: false, reason: 'owned' });
  assert.deepEqual(c.unlockTech('basic_rocketry'), { ok: false, reason: 'science' });
  c.science = 1000;
  assert.deepEqual(c.unlockTech('heavy'), { ok: false, reason: 'prereq' });
  assert.equal(c.techState('heavy'), 'locked');
  assert.equal(c.techState('basic_rocketry'), 'available');
  assert.equal(c.science, 1000);
  assert.ok(!c.isPartUnlocked('eng_goshawk'));
  assert.equal(c.unlockTech('basic_rocketry').ok, true);
  assert.equal(c.science, 995);
  assert.equal(c.techState('basic_rocketry'), 'owned');
  assert.ok(c.isPartUnlocked('eng_goshawk'));
  assert.equal(c.unlockTech('basic_rocketry').reason, 'owned');
  assert.equal(c.science, 995);
  // heavy needs both propulsion and general_construction
  c.unlockTech('propulsion');
  assert.equal(c.unlockTech('heavy').reason, 'prereq');
  c.unlockTech('general_construction');
  assert.equal(c.unlockTech('heavy').ok, true);
  assert.ok(c.isPartUnlocked('eng_condor'));

  const sb = Career.newGame('sandbox');
  assert.equal(sb.unlockTech('heavy').reason, 'owned');
  assert.equal(sb.science, 0);
});

// ---------------------------------------------------------------- science
test('experiments table', () => {
  for (const id of ['crew_report', 'temperature', 'pressure', 'microbe', 'eva_report', 'surface_sample']) {
    const e = EXPERIMENTS[id];
    assert.ok(e && e.name && e.base > 0);
    assert.ok(e.situations.length && e.situations.every(s => SITUATIONS.includes(s)));
  }
  assert.ok(EXPERIMENTS.crew_report.needsCrew);
  assert.ok(EXPERIMENTS.eva_report.eva && EXPERIMENTS.surface_sample.eva);
  assert.deepEqual([...EXPERIMENTS.surface_sample.situations].sort(), ['landed', 'splashed']);
  for (const p of Object.values(PARTS)) if (p.experiment) assert.ok(EXPERIMENTS[p.experiment], p.id);
  // the first seven worlds keep their values; every other body of the system has one too
  const first7 = { verda: 1, pell: 4, ost: 5, rusk: 6, cindra: 7, thal: 9, tiv: 9 };
  for (const id in first7) assert.equal(BODY_SCI_MULT[id], first7[id], id);
  for (const b of SYSTEM.bodies) assert.ok(BODY_SCI_MULT[b.id] >= 1, b.id);
});

test('science value scales with body and situation', () => {
  const c = Career.newGame('career');
  const a = c.scienceValue('temperature', 'verda', 'spaceLow');
  const b = c.scienceValue('temperature', 'pell', 'spaceLow');
  assert.equal(a.key, 'temperature@verda:spaceLow');
  assert.equal(a.full, EXPERIMENTS.temperature.base);
  assert.equal(b.full, a.full * 4);
  assert.equal(a.remaining, a.full);
  // body object's sciMult wins over the table
  assert.equal(c.scienceValue('temperature', { id: 'pell', sciMult: 10 }, 'spaceLow').full, a.full * 10);
  assert.equal(c.scienceValue('temperature', pell, 'spaceLow').key, 'temperature@pell:spaceLow');
  assert.equal(bodySciMult('tiv'), 9);
  assert.equal(bodySciMult('mystery'), 1);
  assert.ok(c.scienceValue('temperature', 'pell', 'landed').full > b.full);
  // not allowed
  const bad = c.scienceValue('surface_sample', 'verda', 'spaceLow');
  assert.equal(bad.valid, false);
  assert.equal(bad.full, 0);
  assert.equal(c.creditScience('surface_sample', 'verda', 'spaceLow'), 0);
  assert.equal(c.creditScience('nonsense', 'verda', 'landed'), 0);
  assert.equal(c.science, 0);
});

test('science diminishing returns', () => {
  const c = Career.newGame('career');
  const full = c.scienceValue('microbe', 'pell', 'landed').full;
  const first = c.creditScience('microbe', 'pell', 'landed');
  assert.ok(Math.abs(first - full * 0.4) < 0.011);
  const second = c.creditScience('microbe', 'pell', 'landed');
  assert.ok(Math.abs(second - (full - first) * 0.4) < 0.011);
  assert.ok(second < first);
  assert.ok(Math.abs(c.science - (first + second)) < 1e-9);
  assert.ok(Math.abs(c.scienceLog['microbe@pell:landed'] - (first + second)) < 1e-9);
  const v = c.scienceValue('microbe', 'pell', 'landed');
  assert.ok(Math.abs(v.remaining - (full - first - second)) < 0.011);

  // other keys are independent
  assert.equal(c.scienceValue('microbe', 'pell', 'spaceLow').earned, 0);

  // run to exhaustion: strictly decreasing, total never exceeds the pool, ends at zero
  let last = second, total = first + second, n = 0;
  for (; n < 200; n++) {
    const p = c.creditScience('microbe', 'pell', 'landed');
    if (p === 0) break;
    assert.ok(p < last);
    last = p; total += p;
  }
  assert.ok(n < 200, 'must exhaust');
  assert.ok(total <= full + 1e-6);
  assert.ok(full - total < 0.3);
  const end = c.scienceValue('microbe', 'pell', 'landed');
  assert.equal(end.next, 0);
  assert.equal(c.creditScience('microbe', 'pell', 'landed'), 0);

  // transmit fraction
  const d = Career.newGame('science');
  const half = d.creditScience('microbe', 'pell', 'landed', 0.5);
  assert.ok(Math.abs(half - first / 2) < 0.011);
  assert.ok(Math.abs(d.scienceValue('microbe', 'pell', 'landed').remaining - (full - half)) < 0.011);
});

test('situationOf thresholds', () => {
  const v = o => ({ body: verda, landed: false, splashed: false, ...o });
  assert.equal(situationOf(v({ landed: true, altitude: 0 })), 'landed');
  assert.equal(situationOf(v({ splashed: true, altitude: 0 })), 'splashed');
  assert.equal(situationOf(v({ situation: 'prelaunch', altitude: 0 })), 'landed');
  assert.equal(situationOf(v({ altitude: 100 })), 'flyingLow');
  assert.equal(situationOf(v({ altitude: 17999 })), 'flyingLow');
  assert.equal(situationOf(v({ altitude: 18000 })), 'flyingHigh');
  assert.equal(situationOf(v({ altitude: 71999 })), 'flyingHigh');
  assert.equal(situationOf(v({ altitude: 72000 })), 'spaceLow');
  assert.equal(situationOf(v({ altitude: 249999 })), 'spaceLow');
  assert.equal(situationOf(v({ altitude: 250000 })), 'spaceHigh');
  // airless body: no flying situations
  assert.equal(situationOf({ body: pell, altitude: 10 }), 'spaceLow');
  assert.equal(situationOf({ body: pell, altitude: 60000 }), 'spaceHigh');
  // spaceBorder fallback = radius * 0.4
  const bare = { id: 'x', radius: 100000 };
  assert.equal(situationOf({ body: bare, altitude: 39999 }), 'spaceLow');
  assert.equal(situationOf({ body: bare, altitude: 40000 }), 'spaceHigh');
  // altitude derived from pos when absent
  assert.equal(situationOf({ body: bare, pos: { length: () => 150000 } }), 'spaceHigh');
});

// ---------------------------------------------------------------- milestones
test('milestone table', () => {
  const want = ['first_launch', 'alt_10km', 'reach_space', 'orbit_verda', 'crew_return', 'eva_space', 'flag_verda',
    'pell_flyby', 'pell_orbit', 'pell_landing', 'pell_return', 'ost_flyby', 'ost_landing', 'escape_verda',
    'rusk_flyby', 'rusk_orbit', 'rusk_landing', 'cindra_flyby', 'thal_flyby', 'tiv_landing'];
  // the original twenty are all still there, first and unchanged; the rest are generated from SYSTEM
  assert.deepEqual(MILESTONES.slice(0, want.length).map(m => m.id), want);
  assert.equal(new Set(MILESTONES.map(m => m.id)).size, MILESTONES.length);
  for (const m of MILESTONES.slice(want.length)) assert.ok(m.generated && SYSTEM.byId[m.bodyId] && m.id === `${m.bodyId}_${m.kind}`, m.id);
  for (const m of MILESTONES) {
    assert.ok(m.title && m.desc);
    assert.ok(m.funds > 0 && m.science > 0 && m.rep > 0);
  }
  assert.ok(milestoneDef('tiv_landing').funds > milestoneDef('pell_landing').funds);
  assert.ok(milestoneDef('pell_landing').funds > milestoneDef('first_launch').funds);
});

test('milestone flow: launch → 10 km → space → orbit → crewed return, paid once', () => {
  const c = Career.newGame('career');
  const world = { ut: 0, flags: [], vessels: [] };
  const v = fakeVessel();
  world.active = v;
  const reward = id => milestoneDef(id);

  assert.deepEqual(c.onEvent('tick', { vessel: v }, world), []);          // sitting on the pad
  assert.equal(c.funds, START_FUNDS);

  Object.assign(v, { landed: false, situation: 'flying', altitude: 5 });
  let got = c.onEvent('liftoff', { vessel: v }, world);
  assert.deepEqual(ids(got), ['first_launch']);
  assert.equal(got[0].title, reward('first_launch').title);
  assert.equal(got[0].funds, reward('first_launch').funds);
  assert.equal(c.funds, START_FUNDS + reward('first_launch').funds);
  assert.deepEqual(c.onEvent('liftoff', { vessel: v }, world), []);

  v.altitude = 9999;
  assert.deepEqual(c.onEvent('tick', { vessel: v }, world), []);
  v.altitude = 10000;
  assert.deepEqual(ids(c.onEvent('tick', { vessel: v }, world)), ['alt_10km']);
  assert.deepEqual(c.onEvent('tick', { vessel: v }, world), []);

  v.altitude = 71000;
  assert.deepEqual(c.onEvent('tick', { vessel: v }, world), []);
  v.altitude = 73000; v.situation = 'suborbital';
  world.ut = 300;
  assert.deepEqual(ids(c.onEvent('tick', { vessel: v }, world)), ['reach_space']);
  assert.equal(c.flightLog['1'].reachedSpace, true);
  assert.equal(c.ut, 300);

  v.altitude = 90000; v.situation = 'orbit';
  assert.deepEqual(ids(c.onEvent('situation', { vessel: v, from: 'suborbital', to: 'orbit' }, world)), ['orbit_verda']);
  assert.deepEqual(c.onEvent('tick', { vessel: v }, world), []);

  // deorbit and land
  Object.assign(v, { altitude: 0, situation: 'landed', landed: true });
  const before = { funds: c.funds, science: c.science, rep: c.reputation };
  got = c.onEvent('landed', { vessel: v, speed: 5 }, world);
  assert.deepEqual(ids(got), ['crew_return']);
  assert.equal(c.funds, before.funds + reward('crew_return').funds);
  assert.equal(c.science, before.science + reward('crew_return').science);
  assert.equal(c.reputation, before.rep + reward('crew_return').rep);

  // nothing pays twice
  const snap = { funds: c.funds, science: c.science, rep: c.reputation };
  assert.deepEqual(c.onEvent('landed', { vessel: v, speed: 5 }, world), []);
  assert.deepEqual(c.onEvent('tick', { vessel: v }, world), []);
  assert.deepEqual({ funds: c.funds, science: c.science, rep: c.reputation }, snap);
  assert.deepEqual([...c.milestones].sort(), ['alt_10km', 'crew_return', 'first_launch', 'orbit_verda', 'reach_space']);
  const total = [...c.milestones].reduce((s, id) => s + reward(id).funds, 0);
  assert.equal(c.funds, START_FUNDS + total);

  // a second vessel repeating the flight earns nothing new
  const v2 = fakeVessel({ id: 2, landed: false, situation: 'orbit', altitude: 90000 });
  assert.deepEqual(c.onEvent('tick', { vessel: v2 }, world), []);
  assert.equal(c.completeMilestone('orbit_verda'), null);
});

test('an uncrewed vessel returning from space does not earn the crewed return', () => {
  const c = Career.newGame('career');
  const v = fakeVessel({ parts: new Map([[1, { crew: [] }]]), landed: false, situation: 'suborbital', altitude: 80000 });
  assert.ok(ids(c.onEvent('tick', { vessel: v }, null)).includes('reach_space'));
  Object.assign(v, { landed: false, splashed: true, situation: 'splashed', altitude: 0 });
  assert.deepEqual(c.onEvent('splashed', { vessel: v }, null), []);
  // crew list on parts Map, array or vessel.crew are all understood
  assert.deepEqual(crewOf(fakeVessel()), ['Juno']);
  assert.deepEqual(crewOf({ parts: [{ crew: ['Bram'] }, { crew: [] }] }), ['Bram']);
  assert.deepEqual(crewOf({ crew: ['Tilly'] }), ['Tilly']);
  assert.deepEqual(crewOf({ type: 'eva', name: 'Oskar' }), ['Oskar']);
});

test('Pell flyby, orbit, landing and return', () => {
  const c = Career.newGame('career');
  const world = { ut: 0, flags: [] };
  const v = fakeVessel({ landed: false, situation: 'escape', altitude: 5e6, body: verda });
  c.onEvent('tick', { vessel: v }, world);
  v.body = pell; v.altitude = 4e5;
  assert.deepEqual(ids(c.onEvent('soi', { vessel: v, from: verda, to: pell }, world)), ['pell_flyby']);
  assert.ok(!c.milestones.has('escape_verda'));
  v.situation = 'orbit'; v.altitude = 30000;
  assert.deepEqual(ids(c.onEvent('tick', { vessel: v }, world)), ['pell_orbit']);
  Object.assign(v, { landed: true, situation: 'landed', altitude: 0 });
  assert.deepEqual(ids(c.onEvent('landed', { vessel: v, speed: 2 }, world)), ['pell_landing']);
  assert.deepEqual(c.flightLog['1'].landedOn, ['pell']);
  // debris hitting Verda does nothing, and a different vessel landing does not count as the return
  assert.deepEqual(c.onEvent('landed', { vessel: { id: 9, type: 'debris', body: verda, landed: true } }, world), []);
  assert.deepEqual(c.onEvent('landed', { vessel: fakeVessel({ id: 5, situation: 'landed' }) }, world), []);
  // home again (state survives a save/load in between)
  const d = Career.fromJSON(JSON.parse(JSON.stringify(c)));
  Object.assign(v, { body: verda, landed: false, splashed: true, situation: 'splashed', altitude: 0 });
  assert.deepEqual(ids(d.onEvent('splashed', { vessel: v }, world)).sort(), ['crew_return', 'pell_return']);
  assert.deepEqual(d.onEvent('splashed', { vessel: v }, world), []);
});

test('leaving Verda, other worlds, EVA, flags and crew loss', () => {
  const c = Career.newGame('career');
  const world = { ut: 0, flags: [] };
  const v = fakeVessel({ landed: false, situation: 'escape', altitude: 9e7, body: helion });
  assert.deepEqual(ids(c.onEvent('soi', { vessel: v, from: verda, to: helion }, world)).sort(), ['escape_verda', 'reach_space']);
  v.body = rusk; v.altitude = 1e6;
  assert.deepEqual(ids(c.onEvent('soi', { vessel: v, from: helion, to: rusk }, world)), ['rusk_flyby']);
  v.situation = 'orbit';
  assert.deepEqual(ids(c.onEvent('situation', { vessel: v, from: 'escape', to: 'orbit' }, world)), ['rusk_orbit']);
  Object.assign(v, { landed: true, situation: 'landed', altitude: 0 });
  assert.deepEqual(ids(c.onEvent('landed', { vessel: v }, world)), ['rusk_landing']);

  // body ids as plain strings work too (every world has a flyby milestone now, and a landing implies the flyby;
  // landing also implies leaving Verda - already done)
  const t = fakeVessel({ id: 3, body: { id: 'tiv', radius: 4e5 }, landed: true, situation: 'landed' });
  assert.deepEqual(ids(c.onEvent('landed', { vessel: t }, world)), ['tiv_flyby', 'tiv_landing']);
  assert.deepEqual(ids(c.onEvent('soi', { vessel: fakeVessel({ id: 4, landed: false, situation: 'escape', body: { id: 'thal', radius: 5.2e6, atmo: { height: 4e5 } }, altitude: 1e8 }), from: 'helion', to: 'thal' }, world)), ['thal_flyby']);
  assert.deepEqual(ids(c.onEvent('soi', { vessel: null, from: 'helion', to: 'cindra' }, world)), ['cindra_flyby']);
  assert.deepEqual(ids(c.onEvent('soi', { from: 'verda', to: 'ost' }, world)), ['ost_flyby']);

  // EVA in space: polled from the EVA vessel
  const pip = { id: 20, type: 'eva', name: 'Juno', body: verda, altitude: 100000, landed: false, situation: 'orbit', parts: new Map() };
  const got = ids(c.onEvent('tick', { vessel: pip }, world));
  assert.ok(got.includes('eva_space'));
  // EVA on the ground is not a spacewalk
  const c2 = Career.newGame('career');
  assert.deepEqual(c2.onEvent('tick', { vessel: { ...pip, altitude: 0, landed: true, situation: 'landed' } }, world), []);
  assert.deepEqual(ids(c2.onEvent('eva', { vessel: fakeVessel(), eva: pip }, world)).includes('eva_space'), true);

  // flag: by event, or noticed in world.flags on any tick
  assert.deepEqual(ids(c.onEvent('flag', { vessel: { ...pip, landed: true }, body: verda }, world)), ['flag_verda']);
  const c3 = Career.newGame('career');
  assert.deepEqual(ids(c3.onEvent('flag', { body: pell }, world)), ['pell_flag'], 'every solid world has a flag milestone now');
  assert.deepEqual(ids(c3.onEvent('tick', { vessel: fakeVessel() }, { flags: [{ name: 'Here', body: 'verda' }] })), ['flag_verda']);

  // crew loss through the event stream
  c.assignCrew(['Bram']);
  c.onEvent('crewLost', { name: 'Bram' }, world);
  assert.equal(c.roster.find(r => r.name === 'Bram').status, 'lost');
  // destroyed vessels drop their flight log
  assert.ok(c.flightLog['1']);
  c.onEvent('destroyed', { vessel: v, reason: 'crash' }, world);
  assert.equal(c.flightLog['1'], undefined);
  // unknown events are harmless
  assert.deepEqual(c.onEvent('warp', { index: 3 }, world), []);
  assert.deepEqual(c.onEvent('message', undefined, undefined), []);
});

// ---------------------------------------------------------------- crew
test('crew status transitions', () => {
  const c = Career.newGame('career');
  assert.equal(c.availableCrew().length, 4);
  assert.deepEqual(c.assignCrew(['Juno', 'Bram', 'Nobody']), ['Juno', 'Bram']);
  assert.deepEqual(c.availableCrew().map(r => r.name), ['Tilly', 'Oskar']);
  assert.deepEqual(c.assignCrew(['Juno']), []);                       // already flying
  assert.deepEqual(c.returnCrew(['Juno', 'Tilly']), ['Juno']);        // Tilly never left
  const juno = c.roster.find(r => r.name === 'Juno');
  assert.equal(juno.status, 'available');
  assert.equal(juno.flights, 1);
  assert.equal(c.loseCrew('Bram'), true);
  assert.equal(c.loseCrew('Bram'), false);
  assert.equal(c.loseCrew('Nobody'), false);
  assert.equal(c.roster.find(r => r.name === 'Bram').status, 'lost');
  assert.deepEqual(c.returnCrew(['Bram']), []);
  assert.deepEqual(c.assignCrew(['Bram']), []);
  assert.equal(c.availableCrew().length, 3);
  assert.ok(c.reputation < 0);
  c.assignCrew(['Oskar']);
  assert.deepEqual(c.releaseCrew(['Oskar']), ['Oskar']);
  assert.equal(c.roster.find(r => r.name === 'Oskar').flights, 0);
});

test('hiring', () => {
  assert.ok(NAME_POOL.length >= 28);
  assert.equal(new Set(NAME_POOL).size, NAME_POOL.length);
  for (const s of STARTING_CREW) assert.ok(!NAME_POOL.includes(s.name));

  const c = Career.newGame('career');
  const cost1 = c.hireCost();
  const r = c.hire(() => 0);
  assert.equal(r.ok, true);
  assert.equal(r.cost, cost1);
  assert.equal(c.funds, START_FUNDS - cost1);
  assert.equal(c.roster.length, 5);
  assert.equal(r.pip.name, NAME_POOL[0]);
  assert.equal(r.pip.status, 'available');
  assert.ok(['pilot', 'engineer', 'scientist'].includes(r.pip.trait));
  assert.ok(c.hireCost() > cost1, 'cost rises with roster size');
  const r2 = c.hire(() => 0);
  assert.notEqual(r2.pip.name, r.pip.name);
  assert.ok(r2.cost > r.cost);

  c.funds = 10;
  const poor = c.hire();
  assert.equal(poor.ok, false);
  assert.equal(c.roster.length, 6);
  assert.equal(c.funds, 10);

  // names stay unique even past the pool, in a mode without funds
  const s = Career.newGame('sandbox');
  for (let i = 0; i < 60; i++) assert.equal(s.hire().ok, true);
  assert.equal(new Set(s.roster.map(p => p.name)).size, 64);
});

// ---------------------------------------------------------------- money helpers
test('recovery value bounds', () => {
  assert.equal(recoveryValue(10000, 0), 9800);
  assert.equal(recoveryValue(10000, 1e9), 1000);
  assert.equal(recoveryValue(10000, -50), 9800);
  assert.equal(recoveryValue(0, 0), 0);
  let last = Infinity;
  for (let d = 0; d <= 4e6; d += 1e5) {
    const f = recoveryFraction(d);
    assert.ok(f <= 0.98 + 1e-12 && f >= 0.10 - 1e-12);
    assert.ok(f <= last);
    last = f;
  }
  const mid = recoveryValue(10000, 5e5);
  assert.ok(mid < 9800 && mid > 1000);

  const c = Career.newGame('career');
  assert.equal(c.recoveryValue(10000, 0), 9800);
  assert.equal(c.creditRecovery(10000, 0), 9800);
  assert.equal(c.funds, START_FUNDS + 9800);
  const sb = Career.newGame('sandbox');
  sb.creditRecovery(10000, 0);
  assert.equal(sb.funds, 0);
});

test('launch cost and paying for a launch', () => {
  const craft = { cost: () => 12345 };
  assert.equal(launchCost(craft), 12345);
  assert.equal(launchCost({ parts: [{ type: 'pod_acorn' }, { type: 'srb_ember' }] }), PARTS.pod_acorn.cost + PARTS.srb_ember.cost);
  assert.equal(launchCost(null), 0);
  const c = Career.newGame('career');
  assert.equal(c.launchCost(craft), 12345);
  assert.deepEqual(c.payLaunch(craft), { ok: true, cost: 12345 });
  assert.equal(c.funds, START_FUNDS - 12345);
  assert.deepEqual(c.payLaunch({ cost: () => 1e6 }), { ok: false, cost: 1e6 });
  assert.equal(c.funds, START_FUNDS - 12345);
  assert.equal(Career.newGame('sandbox').payLaunch({ cost: () => 1e9 }).ok, true);
});

// ---------------------------------------------------------------- crafts
test('craft storage', () => {
  const c = Career.newGame('career');
  assert.deepEqual(c.listCrafts(), []);
  const design = { name: 'Skylark II', parts: [{ id: 1, type: 'pod_acorn' }], stages: [[1]] };
  assert.equal(c.saveCraft(design), true);
  design.parts.push({ id: 2, type: 'chute' });                       // stored copy is independent
  assert.equal(c.getCraft('Skylark II').parts.length, 1);
  assert.equal(c.saveCraft({ toJSON: () => ({ name: 'Hopper I', parts: [], stages: [] }) }), true);
  assert.equal(c.saveCraft({ parts: [] }), false);
  assert.deepEqual(c.listCrafts().map(x => x.name), ['Hopper I', 'Skylark II']);
  c.saveCraft({ name: 'Hopper I', parts: [{ id: 1, type: 'srb_ember' }], stages: [] });   // overwrite
  assert.equal(c.listCrafts().length, 2);
  assert.equal(c.getCraft('Hopper I').parts.length, 1);
  assert.equal(c.deleteCraft('Hopper I'), true);
  assert.equal(c.deleteCraft('Hopper I'), false);
  assert.deepEqual(c.listCrafts().map(x => x.name), ['Skylark II']);
});

// ---------------------------------------------------------------- early-game balance
// What a flight is worth: one run of each listed experiment/situation (40 % of the remaining pool) plus milestones.
function flightScience(c, runs, milestones = []) {
  let total = 0;
  for (const [exp, body, sit] of runs) total += c.creditScience(exp, body, sit);
  for (const m of milestones) { const r = c.completeMilestone(m); if (r) total += r.science; }
  return Math.round(total * 100) / 100;
}
const cost = id => techNode(id).cost;

test('balance: tech costs', () => {
  assert.deepEqual(TECH_TREE.slice(0, 12).map(n => [n.id, n.cost]), [
    ['start', 0], ['basic_rocketry', 5], ['survivability', 15], ['general_construction', 15], ['propulsion', 30], ['electrics', 35],
    ['stability', 45], ['landing', 90], ['miniature', 90], ['heavy', 160], ['command2', 160], ['advanced_propulsion', 300]]);
  // second pass: the wider tree, tier by tier (tier = column)
  assert.deepEqual(TECH_TREE.slice(12).map(n => [n.id, n.tier, n.cost]), [
    ['aviation', 2, 30], ['fuel_systems', 3, 60], ['aerodynamics', 3, 60], ['field_science', 3, 70],
    ['advanced_construction', 4, 120], ['advanced_electrics', 4, 120], ['deep_comms', 4, 140], ['ground_ops', 4, 140],
    ['orbital_assembly', 5, 220], ['supersonic_flight', 5, 260], ['advanced_science', 5, 280],
    ['very_heavy', 6, 450], ['ion_propulsion', 6, 500], ['high_power', 6, 450], ['nuclear_propulsion', 7, 800]]);
});

test('balance: the launch pad is not a science mine', () => {
  const c = Career.newGame('science');
  // home ground and seas are worth 40 % of the usual landed / splashed value
  assert.equal(c.scienceValue('crew_report', 'verda', 'landed').full, 3);
  assert.equal(c.scienceValue('surface_sample', 'verda', 'landed').full, 9);
  assert.equal(c.scienceValue('surface_sample', 'verda', 'splashed').full, 7.2);
  assert.equal(c.scienceValue('crew_report', 'verda', 'flyingLow').full, 3.5, 'flying is unaffected');
  assert.equal(c.scienceValue('surface_sample', 'pell', 'landed').full, 90, 'other worlds are unaffected');
  const pad = flightScience(c, [['crew_report', 'verda', 'landed'], ['temperature', 'verda', 'landed'], ['eva_report', 'verda', 'landed'], ['surface_sample', 'verda', 'landed']]);
  assert.ok(pad < 8, 'everything a starting crew can do without leaving the pad: ' + pad);
  assert.ok(pad < cost('survivability'));
});

test('balance: flights 1-4 on the way to orbit, then Pell', () => {
  // Flight 1: Hopper I (one Ember booster, apex ~55 km): milestones + crew reports on the way, the casual way...
  const casual = Career.newGame('science');
  const hop1 = flightScience(casual, [['crew_report', 'verda', 'landed'], ['crew_report', 'verda', 'flyingLow'], ['crew_report', 'verda', 'flyingHigh']], ['first_launch', 'alt_10km']);
  assert.ok(hop1 >= cost('basic_rocketry') && hop1 < 15, 'a casual first hop buys the first 5-point node: ' + hop1);
  // ...and the thorough way (thermometer, EVA report and surface sample on the pad as well)
  const c = Career.newGame('science');
  const f1 = flightScience(c, [
    ['crew_report', 'verda', 'landed'], ['temperature', 'verda', 'landed'], ['eva_report', 'verda', 'landed'], ['surface_sample', 'verda', 'landed'],
    ['crew_report', 'verda', 'flyingLow'], ['temperature', 'verda', 'flyingLow'], ['crew_report', 'verda', 'flyingHigh'], ['temperature', 'verda', 'flyingHigh'],
  ], ['first_launch', 'alt_10km']);
  assert.ok(f1 >= 15 && f1 < 5 + 15 + 15, 'a thorough first hop: one 5 and at most one 15: ' + f1);

  // Flight 2: two stacked Embers reach space (and high space) on starting parts
  const f2 = flightScience(c, [
    ['crew_report', 'verda', 'flyingLow'], ['temperature', 'verda', 'flyingLow'], ['crew_report', 'verda', 'flyingHigh'], ['temperature', 'verda', 'flyingHigh'],
    ['crew_report', 'verda', 'spaceLow'], ['temperature', 'verda', 'spaceLow'], ['crew_report', 'verda', 'spaceHigh'], ['temperature', 'verda', 'spaceHigh'],
  ], ['reach_space']);
  assert.ok(f2 >= 15 && f2 <= 30, 'reaching space is worth one or two 15-point nodes: ' + f2);
  const f2eva = flightScience(c, [['eva_report', 'verda', 'spaceLow'], ['eva_report', 'verda', 'spaceHigh']], ['eva_space']);
  assert.ok(f2 + f2eva <= 36, 'even with a spacewalk: ' + (f2 + f2eva));

  // Flights 3-4: orbit and return with the pressure gauge from Coming Home
  const f3 = flightScience(c, [
    ['pressure', 'verda', 'flyingLow'], ['pressure', 'verda', 'flyingHigh'], ['pressure', 'verda', 'spaceLow'], ['pressure', 'verda', 'spaceHigh'],
    ['crew_report', 'verda', 'spaceLow'], ['temperature', 'verda', 'spaceLow'], ['crew_report', 'verda', 'spaceHigh'], ['temperature', 'verda', 'spaceHigh'],
    ['crew_report', 'verda', 'splashed'], ['temperature', 'verda', 'splashed'],
  ], ['orbit_verda', 'crew_return']);
  assert.ok(f3 >= 30 && f3 <= 45, 'orbit and return unlocks 30-45 more: ' + f3);
  const toOrbit = hop1 + f2 + f3;
  assert.ok(toOrbit >= cost('basic_rocketry') + cost('survivability') + cost('propulsion'), 'enough for the orbital rocket along the way');

  // Pell: a flyby pays for a 90-point node, a landing and return for the 160s
  const flyby = flightScience(c, [['crew_report', 'pell', 'spaceHigh'], ['temperature', 'pell', 'spaceHigh'], ['pressure', 'pell', 'spaceHigh'],
    ['crew_report', 'pell', 'spaceLow'], ['temperature', 'pell', 'spaceLow'], ['pressure', 'pell', 'spaceLow'], ['eva_report', 'pell', 'spaceLow']], ['pell_flyby']);
  assert.ok(flyby >= 60 && flyby <= 110, 'Pell flyby: ' + flyby);
  const landing = flightScience(c, [['crew_report', 'pell', 'landed'], ['temperature', 'pell', 'landed'], ['pressure', 'pell', 'landed'],
    ['eva_report', 'pell', 'landed'], ['surface_sample', 'pell', 'landed']], ['pell_orbit', 'pell_landing', 'pell_return']);
  assert.ok(landing >= 160 && landing <= 240, 'Pell landing and return: ' + landing);
});

test('balance: funds - early launches, milestone income and recovery', () => {
  const c = Career.newGame('career');
  const hopper = 1510, twin = 2130, skylark = 4955, pellRunner = 18080;       // stock / first-rocket costs (tests/unit/craft.test.js keeps them honest)
  // total losses all the way: a hop, a space shot and then orbital attempts
  let launches = 0, funds = c.funds;
  for (const price of [hopper, twin, skylark, skylark, skylark, skylark, skylark, skylark, skylark]) { if (funds < price) break; funds -= price; launches++; }
  assert.ok(launches >= 6 && launches <= 8, 'starting funds cover 6-8 early launches with nothing recovered: ' + launches);
  // milestones up to a crewed orbital return pay for the next steps
  const early = ['first_launch', 'alt_10km', 'reach_space', 'orbit_verda', 'crew_return'].reduce((s, id) => s + milestoneDef(id).funds, 0);
  assert.ok(early >= 4 * skylark && early < 2 * pellRunner, 'milestones to orbit: ' + early);
  // recovery matters: a capsule brought down near the pad returns nearly everything, a lost one nothing
  assert.ok(c.recoveryValue(skylark, 20e3) > 0.95 * skylark);
  assert.ok(c.recoveryValue(skylark, 800e3) < 0.6 * skylark);
  // milestone rewards never go down along the list of destinations
  assert.ok(milestoneDef('pell_landing').funds > pellRunner);
});

// ---------------------------------------------------------------- safety net
test('program grant: offered only when the cheapest rocket is out of reach and nothing is flying', () => {
  const c = Career.newGame('career');
  const need = c.cheapestRocketCost();
  assert.equal(need, PARTS.pod_acorn.cost + PARTS.chute.cost + PARTS.srb_ember.cost);
  assert.equal(c.grantOffer(), null);
  c.funds = need;
  assert.equal(c.grantOffer(), null, 'exactly enough is enough');
  c.funds = need - 1;
  c.flightState = { vessels: [{ type: 'debris' }, { type: 'ship' }] };
  assert.equal(c.flightsInProgress(), 1);
  assert.equal(c.grantOffer(), null, 'a vessel in flight may still be recovered');
  c.flightState = { vessels: [{ type: 'debris' }, { type: 'flag' }] };
  const g = c.grantOffer();
  assert.ok(g && g.amount >= 3 * need && g.need === need);
  const rep = c.reputation;
  const r = c.acceptGrant();
  assert.equal(r.ok, true);
  assert.equal(c.funds, need - 1 + g.amount);
  assert.equal(c.reputation, rep - g.repCost);
  assert.equal(c.grants, 1);
  assert.equal(c.grantOffer(), null, 'one grant per occurrence');
  assert.equal(c.acceptGrant().ok, false);
  c.funds = 0; c.flightState = null;
  assert.ok(c.grantOffer(), 'offered again the next time the program runs dry');
  assert.equal(Career.newGame('science').grantOffer(), null);
  assert.equal(Career.fromJSON(JSON.parse(JSON.stringify(c))).grants, 1);
});

// ---------------------------------------------------------------- crew depth
test('Pips gain experience and stars from recovered flights', async () => {
  const { pipStars, flightExperience, XP_STARS } = await import('../../js/core/career.js');
  assert.equal(pipStars(0), 0);
  assert.equal(pipStars(XP_STARS[0]), 1);
  assert.equal(pipStars(1e6), XP_STARS.length);
  assert.deepEqual(flightExperience(null), { xp: 1, deeds: [] });
  assert.deepEqual(flightExperience({ reachedSpace: true, orbited: ['verda'], visited: ['verda', 'pell'], landedOn: ['pell', 'verda'] }),
    { xp: 1 + 1 + 2 + 3 + 5, deeds: ['space', 'orbit:verda', 'visit:pell', 'land:pell'] });

  const c = Career.newGame('career');
  const world = { ut: 10, flags: [], vessels: [] };
  const v = fakeVessel({ landed: false, situation: 'orbit', altitude: 90000 });
  c.assignCrew(['Juno']);
  c.onEvent('tick', { vessel: v }, world);
  Object.assign(v, { landed: true, situation: 'landed', altitude: 0 });
  c.onEvent('landed', { vessel: v, speed: 4 }, world);
  c.onEvent('recovered', { vessel: v, summary: { crew: ['Juno'], science: [] } }, world);
  c.returnCrew(['Juno']);
  const juno = c.roster.find(p => p.name === 'Juno');
  assert.equal(juno.xp, 4, 'flight + space + first orbit of Verda');
  assert.deepEqual(juno.deeds, ['space', 'orbit:verda']);
  assert.equal(c.stars('Juno'), 1);
  assert.equal(juno.flights, 1);
  // a repeat of the same trip teaches less
  const again = c.awardExperience(['Juno'], { reachedSpace: true, orbited: ['verda'], visited: ['verda'], landedOn: [] });
  assert.equal(again[0].gained, 2);
  const far = c.awardExperience(['Juno', 'Nobody'], { reachedSpace: true, orbited: ['pell'], visited: ['verda', 'pell'], landedOn: ['pell'] });
  assert.equal(far.length, 1);
  assert.equal(far[0].gained, 1 + 2 + 3 + 5);
  assert.ok(far[0].promoted && far[0].stars >= 3);
  // xp and deeds are saved
  const d = Career.fromJSON(JSON.parse(JSON.stringify(c)));
  assert.deepEqual(d.roster.find(p => p.name === 'Juno'), juno);
});

test('star bonuses: scientists add science, engineers and pilots help recovery', () => {
  const c = Career.newGame('career');
  const tilly = c.roster.find(p => p.trait === 'scientist'), juno = c.roster.find(p => p.trait === 'pilot'), bram = c.roster.find(p => p.trait === 'engineer');
  tilly.xp = 6;                                              // two stars
  assert.equal(c.bestStars(['Juno', tilly.name], 'scientist'), 2);
  assert.equal(c.bestStars(['Juno'], 'scientist'), 0);
  const plain = Career.newGame('career').creditScience('crew_report', 'pell', 'spaceLow');
  const boosted = c.creditScience('crew_report', 'pell', 'spaceLow', 1, [tilly.name]);
  assert.equal(plain, 8);
  assert.equal(boosted, 9.6, '+10 % per star');
  assert.equal(c.scienceLog['crew_report@pell:spaceLow'], 8, 'the bonus does not use up the pool');
  assert.equal(c.creditScience('temperature', 'pell', 'spaceLow', 1, ['Juno']), 6.4, 'a pilot is no scientist');
  assert.equal(c.creditScience('pressure', 'pell', 'spaceLow'), 9.6, 'existing callers (no crew argument) are unchanged');

  // the crew of a vessel being recovered counts without the caller passing it
  const world = { ut: 77, flags: [], vessels: [] };
  const v = fakeVessel({ situation: 'landed', parts: new Map([[1, { crew: [tilly.name] }]]) });
  c.onEvent('recovered', { vessel: v, summary: { crew: [tilly.name], science: [] } }, world);
  assert.equal(c.creditScience('microbe', 'pell', 'spaceLow'), 19.2, '16 × 1.2 during the recovery');
  c.ut = 78;
  assert.equal(c.creditScience('microbe', 'pell', 'spaceHigh'), 22.4, 'and not afterwards');

  bram.xp = 12; juno.xp = 20;                                // three and four stars
  const base = recoveryValue(10000, 6e5);
  assert.equal(c.creditRecovery(10000, 6e5, []), base);
  assert.equal(c.creditRecovery(10000, 6e5, [bram.name]), Math.round(base * 1.06));
  assert.equal(c.creditRecovery(10000, 6e5, [juno.name]), recoveryValue(10000, 6e5 * 0.6));
  assert.equal(c.creditRecovery(10000, 0, [bram.name, juno.name]), 10000, 'never more than the parts are worth');
});

test('memorial, rename and dismiss', () => {
  const c = Career.newGame('career');
  const world = { ut: 500, flags: [], vessels: [] };
  const v = fakeVessel({ name: 'Hopper I', body: pell });
  c.onEvent('crewLost', { name: 'Oskar', vessel: v }, world);
  const wall = c.memorial();
  assert.equal(wall.length, 1);
  assert.deepEqual([wall[0].name, wall[0].lostAt, wall[0].lostWhere, wall[0].lostVessel], ['Oskar', 500, 'pell', 'Hopper I']);
  assert.deepEqual(Career.fromJSON(JSON.parse(JSON.stringify(c))).memorial(), wall);

  assert.deepEqual(c.renamePip('Juno', '  Captain   Juno '), { ok: true, name: 'Captain Juno' });
  assert.ok(c.roster.some(p => p.name === 'Captain Juno'));
  assert.equal(c.renamePip('Bram', 'tilly').reason, 'taken');
  assert.equal(c.renamePip('Bram', '   ').reason, 'empty');
  assert.equal(c.renamePip('Bram', 'x'.repeat(40)).reason, 'long');
  assert.equal(c.renamePip('Nobody', 'x').reason, 'unknown');
  assert.equal(c.renamePip('Oskar', 'Ghost').reason, 'busy', 'the lost keep their names');
  c.assignCrew(['Bram']);
  assert.equal(c.renamePip('Bram', 'Bramble').reason, 'busy', 'a Pip in flight keeps the name the vessel knows');
  assert.equal(c.dismissPip('Bram').reason, 'busy');
  assert.equal(c.dismissPip('Oskar').reason, 'unknown');
  assert.equal(c.dismissPip('Tilly').ok, true);
  assert.equal(c.dismissPip('Captain Juno').ok, true);
  c.releaseCrew(['Bram']);
  assert.equal(c.dismissPip('Bram').reason, 'last', 'somebody has to stay');
  assert.equal(c.memorial().length, 1, 'the memorial is not touched by dismissals');
});

// ---------------------------------------------------------------- save hardening
test('old saves without contracts load and are migrated', async () => {
  const { SAVE_VERSION } = await import('../../js/core/career.js');
  const v1 = { version: 1, mode: 'career', funds: 31000, science: 12.5, reputation: 4, ut: 5000, tech: ['start', 'basic_rocketry'],
    milestones: ['first_launch', 'alt_10km'], roster: [{ name: 'Juno', status: 'available', flights: 3, trait: 'pilot' }, { name: 'Bram', status: 'lost', flights: 1, trait: 'engineer' }],
    scienceLog: { 'crew_report@verda:landed': 3 }, crafts: {}, flightState: null, flightLog: { 4: { reachedSpace: true, landedOn: [], visited: ['verda'] } }, settings: {} };
  const st = memStorage();
  st.setItem(SAVE_KEY, JSON.stringify(v1));
  const c = Career.load(st);
  assert.ok(c instanceof Career);
  assert.equal(c.funds, 31000);
  assert.equal(c.roster[0].xp, 0);
  assert.deepEqual(c.roster[0].deeds, []);
  assert.equal(c.roster[1].lostAt, null);
  assert.equal(c.contracts.offered.length, 3, 'a board is generated for the old save');
  assert.equal(c.grants, 0);
  assert.equal(c.toJSON().version, SAVE_VERSION);
  assert.equal(Career.migrate(v1).migratedFrom, 1);
  assert.equal(Career.migrate({ mode: 'sandbox' }).version, SAVE_VERSION, 'a save with no version at all counts as v1');
  assert.equal(v1.version, 1, 'migrate does not modify its input');
  // an old flight-log entry gains the orbit list on first use
  const v = fakeVessel({ id: 4, landed: false, situation: 'orbit', altitude: 90000 });
  c.onEvent('tick', { vessel: v }, { ut: 5001, flags: [], vessels: [] });
  assert.deepEqual(c.flightLog['4'].orbited, ['verda']);
  // saving again writes the new format, which loads identically
  c.save(st);
  assert.deepEqual(Career.load(st).toJSON(), c.toJSON());
});

test('load never throws: corrupt data returns null and is parked under a backup key', async () => {
  const { BACKUP_KEY } = await import('../../js/core/career.js');
  for (const bad of ['{not json', '"just a string"', '[1,2,3]', 'null', '42', '{"mode":"career","roster":"x","tech":7,"contracts":{"offered":[{"id":"c1"}]},"flightLog":5}']) {
    const st = memStorage();
    st.setItem(SAVE_KEY, bad);
    let c;
    assert.doesNotThrow(() => { c = Career.load(st); });
    if (c === null) {
      assert.equal(st.getItem(BACKUP_KEY), bad, 'the unreadable save is kept');
      assert.equal(Career.corruptBackup(st), bad);
      assert.equal(Career.hasSave(st), false, 'and no longer blocks the title screen');
    } else {
      assert.ok(c instanceof Career, 'wrong-typed fields are repaired instead');
      assert.equal(c.roster.length, 4);
      assert.equal(c.contracts.offered.length, 3);
    }
  }
  // storage that throws on every call
  const hostile = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.doesNotThrow(() => assert.equal(Career.load(hostile), null));
  assert.equal(Career.corruptBackup(hostile), null);
  // readable but the backup cannot be written: still null, still no throw
  const readOnly = { getItem: () => '{broken', setItem() { throw new Error('full'); }, removeItem() {} };
  assert.doesNotThrow(() => assert.equal(Career.load(readOnly), null));
});

test('export and import a save file', () => {
  const c = Career.newGame('career', { seed: 12 });
  c.earn(500, 20, 3);
  c.unlockTech('basic_rocketry');
  c.contracts.accept(c.contracts.offered[0].id);
  const text = c.exportSave();
  const doc = JSON.parse(text);
  assert.equal(doc.game, 'starwright');
  const r = Career.importSave(text);
  assert.equal(r.ok, true);
  assert.deepEqual(r.career.toJSON(), c.toJSON());
  assert.equal(Career.importSave(JSON.stringify(c.toJSON())).ok, true, 'a bare save object is accepted too');
  for (const bad of ['', 'not json', '[]', '{"game":"other"}', '{"mode":"career"}', JSON.stringify({ ...c.toJSON(), version: 999 })]) {
    let res;
    assert.doesNotThrow(() => { res = Career.importSave(bad); });
    assert.equal(res.ok, false, bad.slice(0, 30));
    assert.ok(res.error.length > 10);
  }
});
