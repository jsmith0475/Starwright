// The flight program (fixed chain of milestone missions) and the live read-outs the in-flight mission tracker shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Career, MILESTONES, PROGRAM, programStep, programProgress, milestoneDef } from '../../js/core/career.js';
import { objectiveProgress } from '../../js/core/contracts.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { PARTS } from '../../js/core/parts.js';

const verda = { id: 'verda', radius: 6.4e5, atmo: { height: 72000 }, spaceBorder: 250000, sciMult: 1, parent: { id: 'helion' } };
const ship = (over = {}) => ({ id: 7, name: 'T', type: 'ship', body: verda, altitude: 0, airspeed: 0, landed: false, splashed: false, situation: 'flying',
  parts: new Map([[1, { def: PARTS.pod_acorn, crew: ['Juno'] }]]), stages: [], ...over });

test('the program is built from milestones, in a fixed order, with no step twice', () => {
  assert.ok(PROGRAM.length >= 40, 'covers the whole system (' + PROGRAM.length + ' steps)');
  const ids = PROGRAM.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of PROGRAM) {
    const m = milestoneDef(s.id);
    assert.ok(m, s.id + ' is a milestone');
    assert.equal(s.title, m.title); assert.equal(s.funds, m.funds); assert.equal(s.science, m.science); assert.equal(s.rep, m.rep);
    assert.ok(s.chapter && s.desc && s.how, s.id + ' has a chapter, a description and a how-to line');
    assert.equal(PROGRAM[s.index], s);
    assert.equal(programStep(s.id), s);
  }
  assert.deepEqual(ids.slice(0, 6), ['first_launch', 'alt_10km', 'reach_space', 'orbit_verda', 'crew_return', 'eva_space']);
  assert.deepEqual(ids.slice(6, 10), ['pell_flyby', 'pell_orbit', 'pell_landing', 'pell_return']);
  assert.deepEqual(ids.slice(10, 14), ['ost_flyby', 'ost_orbit', 'ost_landing', 'ost_return']);
  assert.equal(ids[14], 'escape_verda');
  assert.ok(MILESTONES.length > PROGRAM.length, 'flags and the like stay plain milestones');
});

test('every other world gets flyby, orbit, landing and return (no landing on a gas giant), moons after their planet', () => {
  const ids = PROGRAM.map(s => s.id);
  for (const b of SYSTEM.bodies) {
    if (b.type === 'star' || b.id === 'verda') continue;
    const kinds = PROGRAM.filter(s => s.bodyId === b.id && s.id !== 'escape_verda').map(s => s.kind);
    assert.deepEqual(kinds, b.gas ? ['flyby', 'orbit'] : ['flyby', 'orbit', 'landing', 'return'], b.id);
    if (b.type === 'moon' && b.parent.id !== 'verda') assert.ok(ids.indexOf(b.id + '_flyby') > ids.indexOf(b.parent.id + '_flyby'), b.id + ' follows ' + b.parent.id);
  }
});

test('the next step follows what has been flown, in every mode; rewards depend on the mode', () => {
  for (const mode of ['career', 'science', 'sandbox']) {
    const c = Career.newGame(mode, { seed: 3 });
    let st = c.programStatus();
    assert.equal(st.total, PROGRAM.length); assert.equal(st.done, 0); assert.equal(st.next.id, 'first_launch'); assert.equal(st.chapter, 'First flights');
    const funds0 = c.funds;
    c.onEvent('liftoff', { vessel: ship({ situation: 'flying', altitude: 5 }) }, { ut: 10, flags: [], vessels: [] });
    st = c.programStatus();
    assert.equal(st.done, 1, mode + ': lifting off flies the first mission');
    assert.equal(c.nextProgramStep().id, 'alt_10km');
    c.onEvent('tick', { vessel: ship({ altitude: 12000 }) }, { ut: 60, flags: [], vessels: [] });
    assert.equal(c.nextProgramStep().id, 'reach_space');
    const r = c.programRewards('reach_space'), m = milestoneDef('reach_space');
    assert.deepEqual(r, { funds: mode === 'career' ? m.funds : 0, science: mode === 'sandbox' ? 0 : m.science, rep: mode === 'career' ? m.rep : 0 });
    if (mode === 'career') assert.ok(c.funds > funds0, 'career: the missions paid');
    // a later step flown early does not move "next" backwards or forwards
    c.completeMilestone('pell_flyby');
    assert.equal(c.nextProgramStep().id, 'reach_space');
    // and the chain survives a save
    const again = Career.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
    assert.equal(again.programStatus().done, c.programStatus().done);
    assert.equal(again.nextProgramStep().id, 'reach_space');
  }
});

test('finishing every step leaves no next mission', () => {
  const c = Career.newGame('sandbox', { seed: 1 });
  for (const s of PROGRAM) c.completeMilestone(s.id);
  const st = c.programStatus();
  assert.equal(st.next, null); assert.equal(st.done, st.total); assert.equal(c.nextProgramStep(), null);
});

test('live progress of program steps', () => {
  assert.deepEqual(programProgress('alt_10km', ship({ altitude: 4200 })), { frac: 0.42, text: '4.2 km of 10 km' });
  assert.equal(programProgress('alt_10km', ship({ altitude: 25000 })).frac, 1);
  const sp = programProgress('reach_space', ship({ altitude: 36000 }));
  assert.equal(sp.frac, 0.5); assert.match(sp.text, /36 km of 72 km/);
  assert.equal(programProgress('first_launch', ship()), null, 'a step without a gauge');
  assert.equal(programProgress('alt_10km', null), null);
  const orb = programProgress('orbit_verda', ship({ situation: 'suborbital', orbit: { periapsis: verda.radius + 36000, apoapsis: verda.radius + 90000 } }));
  assert.equal(orb.frac, 0.5); assert.match(orb.text, /low point 36 km, needs above 72 km/);
  assert.equal(programProgress('orbit_verda', ship()).text, 'no orbit yet');
  assert.match(programProgress('orbit_verda', ship({ getOrbit: () => ({ periapsis: verda.radius - 400000, apoapsis: verda.radius + 20000 }) })).text, /below ground/);
});

test('live progress of contract objectives never changes them', () => {
  const reach = { kind: 'reach', bodyId: 'verda', altMin: 12000, crew: 1, done: false, label: 'x' };
  const before = JSON.stringify(reach);
  assert.deepEqual(objectiveProgress(reach, ship({ altitude: 3000 })), { frac: 0.25, text: '3 km of 12 km' });
  assert.equal(objectiveProgress(reach, ship({ altitude: 3000, parts: new Map([[1, { def: PARTS.pod_acorn, crew: [] }]]) })).text, 'needs a Pip aboard');
  assert.match(objectiveProgress(reach, ship({ body: { id: 'pell', radius: 2e5 } })).text, /not at Verda/);
  assert.equal(JSON.stringify(reach), before);
  assert.deepEqual(objectiveProgress({ ...reach, done: true }, ship()), { frac: 1, text: 'done' });
  const orbit = { kind: 'orbit', bodyId: 'verda', apMin: 80000, apMax: 120000, peMin: 75000, peMax: null, hold: 2, done: false };
  assert.equal(objectiveProgress(orbit, ship({ situation: 'suborbital' })).text, 'not in orbit yet');
  const o = { apoapsis: verda.radius + 200000, periapsis: verda.radius + 60000, inclination: 0 };
  const t = objectiveProgress(orbit, ship({ situation: 'orbit', orbit: o }), { ut: 0 }).text;
  assert.match(t, /high point 200 km \(too high\)/); assert.match(t, /low point 60 km \(too low\)/);
  assert.equal(objectiveProgress({ ...orbit, held: 1 }, ship({ situation: 'orbit', orbit: o }), { ut: 0 }).text, 'holding: 1 of 2 s');
  assert.deepEqual(objectiveProgress({ kind: 'drive', bodyId: 'verda', distance: 2000, driven: 500 }, ship()), { frac: 0.25, text: '0.5 km of 2 km' });
  assert.deepEqual(objectiveProgress({ kind: 'recover', been: 'space' }, ship()), { frac: null, text: '' });
  assert.deepEqual(objectiveProgress(null, null), { frac: null, text: '' });
});

// ---------------------------------------------------------------------- starting parts and the first missions
import { World } from '../../js/core/world.js';
import { Craft, stockCrafts } from '../../js/core/craft.js';
import { TECH_TREE } from '../../js/core/career.js';

const START = Object.values(PARTS).filter(p => p.tech === 'start' && !p.hidden && p.cat !== 'internal');
const startIds = new Set(START.map(p => p.id));
/** Fly a craft straight up at full throttle, staging when the engines stop. → highest altitude (m) and whether it left the pad. */
function ascend(craft) {
  const w = new World(), v = w.launch(craft, { crew: ['Juno'] });
  v.ctrl.throttle = 1; v.ctrl.sas = true; w.stage();
  let max = 0, staged = 1, lifted = false;
  for (let t = 0; t < 1200; t += 0.05) {
    w.step(0.05);
    const a = w.active; if (!a) break;
    if (a.situation !== 'prelaunch' && a.altitude > 5) lifted = true;
    max = Math.max(max, a.altitude);
    if (t > 2 && a.thrust === 0 && staged < craft.stages.length - 1) { w.stage(); staged++; }      // keep the parachute stage for the way down
    if (a.altitude < max - 3000) break;
  }
  return { max, lifted };
}

test('a new career starts with parts that all have a use', () => {
  assert.deepEqual([...Career.newGame('career').tech], ['start']);
  assert.ok(START.some(p => p.cat === 'command'), 'something to sit in');
  assert.ok(START.some(p => p.engine), 'something to push with');
  assert.ok(START.some(p => /chute/.test(p.id)), 'something to come down under');
  // no dead weight: a tank needs an engine that drinks from it
  const burns = new Set();
  for (const p of START) if (p.engine) burns.add(p.engine.type === 'solid' ? 'solid' : 'fuel');
  for (const p of START) {
    for (const r of Object.keys(p.res || {})) {
      if (r === 'fuel' || r === 'solid') assert.ok(burns.has(r), `${p.name} carries ${r} and no starting engine burns it`);
    }
    if (p.cat === 'tanks') assert.ok(START.some(q => q.engine && q.engine.type !== 'solid'), `${p.name} is a liquid tank with no liquid engine to feed`);
    if (p.cat === 'aero' && /^nose/.test(p.id)) assert.fail(`${p.name}: the capsule's top carries the parachute, so a nose cone has nowhere to go yet`);
  }
  // the tanks arrive with the first liquid engine, in the cheapest node
  const first = TECH_TREE.find(n => n.id === 'basic_rocketry');
  assert.equal(first.cost, 5);
  for (const id of ['tank_m100', 'tank_m200']) assert.equal(PARTS[id].tech, 'basic_rocketry');
  assert.ok(Object.values(PARTS).some(p => p.tech === 'basic_rocketry' && p.engine && p.engine.type !== 'solid'));
});

test('the first three program missions can be flown with starting parts', () => {
  assert.deepEqual(PROGRAM.slice(0, 3).map(s => s.id), ['first_launch', 'alt_10km', 'reach_space']);
  // 1 and 2: the stock Hopper I (capsule, one booster, parachute, fins) is all starting parts
  const hopper = stockCrafts().find(c => c.name === 'Hopper I');
  for (const p of hopper.parts) assert.ok(startIds.has(p.type), p.type + ' is a starting part');
  const a = ascend(hopper);
  assert.ok(a.lifted, 'Hopper I leaves the pad');
  assert.ok(a.max > 10000, `Hopper I climbs past 10 km (${Math.round(a.max / 1000)} km)`);
  // 3: two boosters, one above the other, reach space
  const c = new Craft('Two Embers'); const [pod] = c.setRoot('pod_acorn'); c.attachStack('chute', pod.id, 'top');
  let cur = pod, last = null;
  for (const t of ['dec_m', 'srb_ember', 'dec_m', 'srb_ember']) { assert.ok(startIds.has(t), t + ' is a starting part'); const [p] = c.attachStack(t, cur.id, 'bottom'); assert.ok(p, 'attached ' + t); cur = last = p; }
  c.attachRadial('fin', last.id, last.pos.y - 0.8, Math.PI / 4, 3);
  c.autoStage();
  const b = ascend(c);
  const edge = SYSTEM.byId.verda.atmo.height;
  assert.ok(b.max > edge, `two stacked Embers leave the atmosphere (${Math.round(b.max / 1000)} km of ${edge / 1000} km)`);
  // and the science the first two missions pay opens the node with the liquid engine
  const sci = PROGRAM[0].science + PROGRAM[1].science;
  assert.ok(sci >= TECH_TREE.find(n => n.id === 'basic_rocketry').cost, `first launch + 10 km pay ${sci} science`);
  // the how-to lines only name parts the player has
  assert.match(programStep('reach_space').how, /Ember/);
});

test('no two contracts on the board or in the book share a title', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const c = Career.newGame('career');
    c.contracts.seed = seed * 7919;
    c.contracts.offered = []; c.contracts.refresh();
    for (let round = 0; round < 60; round++) {
      const all = [...c.contracts.offered, ...c.contracts.active];
      const titles = all.map(k => k.title);
      assert.equal(new Set(titles).size, titles.length, `seed ${seed}, round ${round}: ${titles.join(' | ')}`);
      // churn: accept one when there is room, decline another, move the clock, earn a little standing
      const o = c.contracts.offered;
      if (o.length && c.contracts.active.length < c.contracts.maxActive && round % 3 === 0) c.contracts.accept(o[0].id);
      else if (o.length) c.contracts.decline(o[o.length - 1].id);
      if (round % 10 === 9) { c.reputation += 12; for (const id of ['first_launch', 'alt_10km', 'reach_space', 'orbit_verda']) c.milestones.add(id); }
      c.ut += 19800 * 2; c.contracts.refresh();
    }
  }
});
