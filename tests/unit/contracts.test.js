import test from 'node:test';
import assert from 'node:assert/strict';
import { Career, TECH_TREE, MILESTONES } from '../../js/core/career.js';
import {
  ContractBoard, CONTRACT_TYPES, capability, repFundsFactor, maxActiveFor, offerCountFor, orbitInfo, VERDA_DAY, ADVANCE_SHARE,
} from '../../js/core/contracts.js';
import { PARTS } from '../../js/core/parts.js';

const verda = { id: 'verda', radius: 6.4e5, atmo: { height: 72000 }, spaceBorder: 250000, sciMult: 1, parent: { id: 'helion' } };
const pell = { id: 'pell', radius: 2.1e5, atmo: null, spaceBorder: 60000, sciMult: 4, parent: verda };

let nextVesselId = 100;
function vessel(over = {}) {
  return { id: nextVesselId++, name: 'Test', type: 'ship', body: verda, altitude: 0, airspeed: 0, landed: true, splashed: false,
    situation: 'prelaunch', parts: new Map([[1, { def: PARTS.pod_acorn, crew: ['Juno'] }]]), stages: [], ...over };
}
const orbit = (apAlt, peAlt, incDeg = 0, body = verda) => ({ apoapsis: body.radius + apAlt, periapsis: body.radius + peAlt, inclination: incDeg * Math.PI / 180 });
const world = (ut = 0) => ({ ut, flags: [], vessels: [] });

// A career whose board holds exactly the given hand-made contract, already accepted.
function withContract(objectives, { career = Career.newGame('career', { seed: 7 }), days = 10, funds = 4000 } = {}) {
  const b = career.contracts;
  b.offered = [{ id: 'cX', type: 'test', key: 'x', title: 'Hand Made', text: 'A test contract.', agency: 'Tests', bodyId: 'verda', difficulty: 1,
    objectives: objectives.map(o => ({ label: o.kind, ...o, done: false })), advance: funds * ADVANCE_SHARE,
    reward: { funds: funds * (1 - ADVANCE_SHARE), science: 3, rep: 2 }, penalty: { funds: funds * ADVANCE_SHARE, rep: 1 },
    days, offeredAt: 0, expiresAt: 1e9, acceptedAt: null, deadlineAt: null, state: 'offered' }];
  const f0 = career.funds;
  const r = b.accept('cX');
  assert.equal(r.ok, true);
  assert.equal(career.funds, f0 + funds * ADVANCE_SHARE, 'advance paid on signing');
  return { career, board: b, contract: r.contract };
}
const outcomes = list => list.filter(n => n.kind === 'contract').map(n => n.outcome);

// ---------------------------------------------------------------- reputation
test('reputation scales fees, active slots and offers', () => {
  assert.equal(repFundsFactor(0), 1);
  assert.ok(repFundsFactor(50) > 1.15 && repFundsFactor(50) <= 1.3);
  assert.equal(repFundsFactor(1000), 1.3);
  assert.ok(repFundsFactor(-100) >= 0.9 && repFundsFactor(-100) < 1);
  assert.equal(maxActiveFor(0), 3);
  assert.equal(maxActiveFor(30), 4);
  assert.equal(maxActiveFor(500), 5);
  assert.equal(offerCountFor(0), 3);
  assert.equal(offerCountFor(100), 5);
});

// ---------------------------------------------------------------- generation
test('a new career has a board of 3 offers, deterministic from the seed', () => {
  const a = Career.newGame('career', { seed: 42 }), b = Career.newGame('career', { seed: 42 }), c = Career.newGame('career', { seed: 43 });
  assert.equal(a.contracts.offered.length, 3);
  assert.deepEqual(a.contracts.toJSON(), b.contracts.toJSON());
  assert.notDeepEqual(a.contracts.offered.map(x => x.title + x.advance), c.contracts.offered.map(x => x.title + x.advance));
  assert.equal(a.contracts.active.length + a.contracts.completed.length + a.contracts.failed.length, 0);
  for (const k of a.contracts.offered) {
    assert.ok(k.id && k.title && k.text.length > 40 && k.agency, 'has a title, flavour text and a client');
    assert.ok(k.objectives.length >= 1 && k.objectives.every(o => o.label && o.done === false));
    assert.ok(k.advance > 0 && k.reward.funds > k.advance, 'advance is the smaller part of the fee');
    assert.ok(k.penalty.funds === k.advance && k.penalty.rep >= 1);
    assert.equal(k.state, 'offered');
    assert.ok(k.expiresAt > 0);
  }
  assert.equal(new Set(a.contracts.offered.map(k => k.key)).size, 3, 'no duplicate jobs on the board');
  // sandbox and science modes have no contract economy
  assert.equal(Career.newGame('sandbox').contracts.offered.length, 0);
  assert.equal(Career.newGame('science').contracts.accept('c1').ok, false);
});

test('nothing impossible is offered: offers follow unlocked parts and completed milestones', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const c = Career.newGame('career', { seed });
    // churn through many offers at the very start of a career
    for (let i = 0; i < 12; i++) {
      for (const k of [...c.contracts.offered]) {
        assert.equal(k.bodyId, 'verda', `start of career stays at Verda (${k.title})`);
        assert.ok(!['satellite', 'orbit', 'explore', 'recover', 'tour'].includes(k.type), `no ${k.type} contract before space (${k.title})`);
        for (const o of k.objectives) {
          if (o.kind === 'stageTest') assert.ok(c.isPartUnlocked(o.part), 'test part is unlocked: ' + o.part);
          if (o.kind === 'reach') assert.ok(o.altMin <= 50000);
          if (o.kind === 'science') assert.ok(['flyingLow', 'flyingHigh', 'splashed'].includes(o.situation));
        }
        c.contracts.decline(k.id);
      }
    }
  }
  // satellites need probe cores, antennas and solar panels (the electrics node) and a program that can reach orbit
  const c = Career.newGame('career', { seed: 5 });
  for (const m of ['first_launch', 'alt_10km', 'reach_space', 'orbit_verda']) c.completeMilestone(m);
  c.tech.add('basic_rocketry'); c.tech.add('propulsion');
  const seen = new Set();
  for (let i = 0; i < 60; i++) for (const k of [...c.contracts.offered]) { seen.add(k.type); c.contracts.decline(k.id); }
  assert.ok(!seen.has('satellite'), 'no satellite contracts without electrics');
  assert.ok(seen.has('orbit') && seen.has('tour') && seen.has('recover') && seen.has('explore'), [...seen].join());
  c.tech.add('electrics');
  for (let i = 0; i < 60; i++) for (const k of [...c.contracts.offered]) { seen.add(k.type); c.contracts.decline(k.id); }
  assert.ok(seen.has('satellite'));
  // landings away from home only once the body has been reached and legs exist
  assert.equal(capability(c).land.size, 0);
  c.completeMilestone('pell_flyby'); c.tech.add('survivability'); c.tech.add('landing');
  assert.ok(capability(c).land.has('pell') && !capability(c).land.has('rusk'));
  assert.ok(!capability(c).reach.has('rusk'));
  // every template can be produced by a late-game program
  const late = Career.newGame('career', { seed: 9 });
  for (const n of TECH_TREE) late.tech.add(n.id);
  for (const m of MILESTONES) late.completeMilestone(m.id);
  const types = new Set(), bodies = new Set();
  for (let i = 0; i < 150; i++) for (const k of [...late.contracts.offered]) { types.add(k.type); bodies.add(k.bodyId); late.contracts.decline(k.id); }
  assert.deepEqual([...types].sort(), [...CONTRACT_TYPES].sort());
  assert.ok(bodies.has('pell') && bodies.has('rusk') && bodies.has('tiv'), [...bodies].join());
  assert.equal(late.contracts.offered.length, offerCountFor(late.reputation));
  assert.equal(late.contracts.offered.length, 5);
});

test('fees scale with destination and reputation', () => {
  const avg = rep => {
    let sum = 0, n = 0;
    const c = Career.newGame('career', { seed: 11 });
    c.reputation = rep;
    for (let i = 0; i < 40; i++) for (const k of [...c.contracts.offered]) { if (k.type === 'test') { sum += k.advance + k.reward.funds; n++; } c.contracts.decline(k.id); }
    return sum / n;
  };
  assert.ok(avg(60) > avg(0) * 1.1, 'a respected program is paid more for the same work');
});

// ---------------------------------------------------------------- accept / decline / cancel
test('accept, decline, cancel and the active limit', () => {
  const c = Career.newGame('career', { seed: 3 });
  const b = c.contracts;
  const f0 = c.funds;
  const first = b.offered[0];
  const r = b.accept(first.id);
  assert.equal(r.ok, true);
  assert.equal(c.funds, f0 + first.advance);
  assert.equal(first.state, 'active');
  assert.equal(first.deadlineAt, first.days * VERDA_DAY);
  assert.equal(b.offered.length, 3, 'the board is topped up');
  assert.ok(!b.offered.some(k => k.key === first.key), 'an accepted job is not offered again');
  assert.equal(b.accept(first.id).ok, false);
  assert.equal(b.accept('nope').reason, 'unknown');

  const declined = b.offered[1];
  const d = b.decline(declined.id);
  assert.equal(d.ok, true);
  assert.equal(b.offered.length, 3);
  assert.ok(!b.offered.some(k => k.id === declined.id));
  assert.notEqual(d.replacement.key, declined.key, 'the replacement is a different job');

  b.accept(b.offered[0].id); b.accept(b.offered[0].id);
  assert.equal(b.active.length, 3);
  assert.equal(b.maxActive, 3);
  assert.equal(b.accept(b.offered[0].id).reason, 'full');
  c.reputation = 35;
  assert.equal(b.maxActive, 4);
  assert.equal(b.accept(b.offered[0].id).ok, true);

  // cancelling repays the advance and costs reputation
  const funds = c.funds, rep = c.reputation;
  const x = b.cancel(first.id);
  assert.equal(x.ok, true);
  assert.equal(c.funds, funds - first.advance);
  assert.equal(c.reputation, rep - first.penalty.rep);
  assert.equal(first.state, 'failed');
  assert.equal(b.failed[0], first);
  assert.equal(x.notice.kind, 'contract');
  assert.equal(x.notice.outcome, 'failed');
  assert.equal(b.cancel(first.id).ok, false);
  assert.equal(b.find(first.id), first);
});

test('a missed deadline fails the contract; stale offers are replaced', () => {
  const { career, board, contract } = withContract([{ kind: 'flyby', bodyId: 'pell' }], { days: 2 });
  const v = vessel({ landed: false, situation: 'flying', altitude: 500 });
  assert.deepEqual(outcomes(career.onEvent('tick', { vessel: v }, world(2 * VERDA_DAY - 1))), []);
  const rep = career.reputation, funds = career.funds;
  const got = career.onEvent('tick', { vessel: v }, world(2 * VERDA_DAY + 1));
  const fail = got.find(n => n.kind === 'contract');
  assert.equal(fail.outcome, 'failed');
  assert.match(fail.title, /deadline/);
  assert.equal(fail.funds, -contract.penalty.funds);
  assert.equal(career.funds, funds - contract.penalty.funds);
  assert.equal(career.reputation, rep - 1);
  assert.equal(board.active.length, 0);
  assert.equal(board.failed[0].reason, 'deadline');

  const c = Career.newGame('career', { seed: 8 });
  const old = c.contracts.offered.map(k => k.id);
  c.ut = 40 * VERDA_DAY;
  c.contracts.refresh();
  assert.equal(c.contracts.offered.length, 3);
  assert.ok(c.contracts.offered.every(k => !old.includes(k.id)), 'offers expire after a couple of weeks');
});

// ---------------------------------------------------------------- objective tracking
test('test flight: staging the right part inside the altitude and speed window', () => {
  const { career, board } = withContract([{ kind: 'stageTest', part: 'srb_ember', bodyId: 'verda', altMin: 8000, altMax: 13000, spdMin: 200, spdMax: 400 }]);
  const v = vessel({ landed: false, situation: 'flying', altitude: 9000, airspeed: 300,
    parts: new Map([[1, { def: PARTS.pod_acorn, crew: ['Juno'] }], [2, { def: PARTS.chute, crew: [] }], [3, { def: PARTS.srb_ember, crew: [] }], [4, { def: PARTS.dec_m, crew: [] }]]),
    stages: [[3], [4], [2]] });
  const w = world(10);
  assert.deepEqual(outcomes(career.onEvent('tick', { vessel: v }, w)), []);
  assert.deepEqual(outcomes(career.onEvent('stage', { vessel: v, stage: 2 }, w)), [], 'wrong part');
  v.altitude = 7000;
  assert.deepEqual(outcomes(career.onEvent('stage', { vessel: v, stage: 0 }, w)), [], 'too low');
  v.altitude = 9000; v.airspeed = 450;
  assert.deepEqual(outcomes(career.onEvent('stage', { vessel: v, stage: 0 }, w)), [], 'too fast');
  v.airspeed = 300;
  const f0 = career.funds, s0 = career.science, r0 = career.reputation;
  const got = career.onEvent('stage', { vessel: v, stage: 0 }, w);
  assert.deepEqual(outcomes(got), ['completed']);
  const n = got.find(x => x.kind === 'contract');
  // the notice has the milestone-award shape the flight screen already toasts
  assert.ok(typeof n.milestoneId === 'string' && n.title.includes('Hand Made') && n.funds === 3000 && n.science === 3 && n.rep === 2);
  assert.equal(career.funds, f0 + 3000);
  assert.equal(career.science, s0 + 3);
  assert.equal(career.reputation, r0 + 2);
  assert.equal(board.active.length, 0);
  assert.equal(board.completed[0].id, 'cX');
  assert.equal(board.offered.length, 3);
});

test('test flight: a decoupler that has already left the vessel is still recognised', () => {
  const { career } = withContract([{ kind: 'stageTest', part: 'dec_m', bodyId: 'verda', altMin: 20000, altMax: 30000, spdMin: 300, spdMax: 700 }]);
  const v = vessel({ landed: false, situation: 'flying', altitude: 25000, airspeed: 500,
    parts: new Map([[1, { def: PARTS.pod_acorn, crew: ['Juno'] }], [4, { def: PARTS.dec_m, crew: [] }]]), stages: [[4]] });
  const w = world(10);
  career.onEvent('tick', { vessel: v }, w);          // the board notes what the vessel is made of
  v.parts.delete(4);                                 // staging: the separator goes with the debris before the event is emitted
  assert.deepEqual(outcomes(career.onEvent('stage', { vessel: v, stage: 0 }, w)), ['completed']);
});

test('reach an altitude with crew aboard', () => {
  const { career } = withContract([{ kind: 'reach', bodyId: 'verda', altMin: 22000, crew: 1 }]);
  const empty = vessel({ landed: false, situation: 'flying', altitude: 30000, parts: new Map([[1, { def: PARTS.probe_wisp, crew: [] }]]) });
  assert.deepEqual(outcomes(career.onEvent('tick', { vessel: empty }, world(5))), [], 'needs a Pip');
  const v = vessel({ landed: false, situation: 'flying', altitude: 21000 });
  assert.deepEqual(outcomes(career.onEvent('tick', { vessel: v }, world(6))), []);
  v.altitude = 22500;
  assert.deepEqual(outcomes(career.onEvent('tick', { vessel: v }, world(7))), ['completed']);
});

test('orbit with apoapsis / periapsis limits must hold for a couple of ticks', () => {
  const { career } = withContract([{ kind: 'orbit', bodyId: 'verda', apMin: 90e3, apMax: 130e3, peMin: 90e3, peMax: null, hold: 2 }]);
  const v = vessel({ landed: false, situation: 'orbit', altitude: 100e3, orbit: orbit(180e3, 95e3) });
  const w = world(100);
  assert.deepEqual(orbitInfo(v, w), { ap: 180e3, pe: 95e3, inc: 0 });
  assert.deepEqual(outcomes(career.onEvent('tick', { vessel: v }, w)), [], 'apoapsis too high');
  v.orbit = orbit(120e3, 80e3);
  assert.deepEqual(outcomes(career.onEvent('tick', { vessel: v }, w)), [], 'periapsis too low');
  v.orbit = orbit(120e3, 95e3);
  assert.deepEqual(outcomes(career.onEvent('tick', { vessel: v }, w)), [], 'first good tick');
  v.situation = 'suborbital';
  assert.deepEqual(outcomes(career.onEvent('tick', { vessel: v }, w)), [], 'hold was broken');
  v.situation = 'orbit';
  assert.deepEqual(outcomes(career.onEvent('tick', { vessel: v }, w)), []);
  assert.deepEqual(outcomes(career.onEvent('tick', { vessel: v }, w)), ['completed']);
  // getOrbit(t) is preferred when the vessel has it (the real Vessel does)
  const real = vessel({ landed: false, situation: 'orbit', getOrbit: () => orbit(100e3, 99e3, 3) });
  assert.equal(Math.round(orbitInfo(real, w).inc), 3);
});

test('satellite deployment: uncrewed, antenna, solar power, Ap/Pe and inclination tolerance, engines off', () => {
  const obj = { kind: 'orbit', bodyId: 'verda', apMin: 270e3, apMax: 330e3, peMin: 270e3, peMax: 330e3, incMin: 0, incMax: 10,
    uncrewed: true, needs: ['antenna', 'solar'], hold: 3 };
  const { career } = withContract([obj]);
  const w = world(500);
  const sat = (over = {}) => vessel({ landed: false, situation: 'orbit', altitude: 300e3, thrust: 0, orbit: orbit(310e3, 290e3, 2),
    parts: new Map([[1, { def: PARTS.probe_wisp, crew: [] }], [2, { def: PARTS.antenna, crew: [] }], [3, { def: PARTS.solar, crew: [] }]]), ...over });
  const run = (v, n = 4) => { let out = []; for (let i = 0; i < n; i++) out = out.concat(outcomes(career.onEvent('tick', { vessel: v }, w))); return out; };
  assert.deepEqual(run(sat({ parts: new Map([[1, { def: PARTS.pod_acorn, crew: ['Juno'] }], [2, { def: PARTS.antenna, crew: [] }], [3, { def: PARTS.solar, crew: [] }]]) })), [], 'crewed');
  assert.deepEqual(run(sat({ parts: new Map([[1, { def: PARTS.probe_wisp, crew: [] }], [3, { def: PARTS.solar, crew: [] }]]) })), [], 'no antenna');
  assert.deepEqual(run(sat({ parts: new Map([[1, { def: PARTS.probe_wisp, crew: [] }], [2, { def: PARTS.antenna, crew: [] }]]) })), [], 'no solar panel');
  assert.deepEqual(run(sat({ orbit: orbit(310e3, 290e3, 25) })), [], 'inclination out of tolerance');
  assert.deepEqual(run(sat({ orbit: orbit(400e3, 290e3, 2) })), [], 'apoapsis out of tolerance');
  assert.deepEqual(run(sat({ thrust: 5000 })), [], 'still burning');
  assert.deepEqual(run(sat({ body: pell })), [], 'wrong body');
  assert.deepEqual(run(sat(), 2), [], 'not held long enough yet');
  assert.deepEqual(run(sat(), 3), ['completed']);
});

test('flyby, landing and flag objectives', () => {
  let t = withContract([{ kind: 'flyby', bodyId: 'pell' }]);
  const v = vessel({ landed: false, situation: 'escape', altitude: 5e6 });
  assert.deepEqual(outcomes(t.career.onEvent('soi', { vessel: v, from: verda, to: verda }, world(1))), []);
  v.body = pell;
  assert.deepEqual(outcomes(t.career.onEvent('soi', { vessel: v, from: verda, to: pell }, world(2))), ['completed']);

  t = withContract([{ kind: 'land', bodyId: 'pell' }]);
  const l = vessel({ body: pell, landed: false, situation: 'suborbital', altitude: 900 });
  assert.deepEqual(outcomes(t.career.onEvent('tick', { vessel: l }, world(1))), []);
  assert.deepEqual(outcomes(t.career.onEvent('landed', { vessel: vessel({ situation: 'landed' }), speed: 3 }, world(2))), [], 'landing on Verda does not count');
  Object.assign(l, { landed: true, situation: 'landed', altitude: 0 });
  assert.deepEqual(outcomes(t.career.onEvent('landed', { vessel: l, speed: 3 }, world(3))), ['completed']);

  t = withContract([{ kind: 'flag', bodyId: 'verda' }]);
  const pip = vessel({ type: 'eva', name: 'Juno', body: pell, landed: true, situation: 'landed' });
  assert.deepEqual(outcomes(t.career.onEvent('flag', { vessel: pip, flag: { name: 'x' }, body: pell }, world(1))), [], 'wrong world');
  assert.deepEqual(outcomes(t.career.onEvent('flag', { vessel: pip, flag: { name: 'x' }, body: verda }, world(2))), ['completed']);
});

test('science delivery: by recovery (summary records) or by transmission (creditScience)', () => {
  let t = withContract([{ kind: 'science', bodyId: 'verda', situation: 'flyingHigh' }]);
  const v = vessel({ situation: 'landed' });
  const summary = { crew: ['Juno'], science: [{ experiment: 'crew_report', bodyId: 'verda', situation: 'flyingLow' }] };
  assert.deepEqual(outcomes(t.career.onEvent('recovered', { vessel: v, summary }, world(1))), [], 'wrong situation');
  summary.science.push({ experiment: 'temperature', bodyId: 'verda', situation: 'flyingHigh' });
  assert.deepEqual(outcomes(t.career.onEvent('recovered', { vessel: v, summary }, world(2))), ['completed']);

  // transmitted: the flight screen calls creditScience directly; the notice arrives with the next event
  t = withContract([{ kind: 'science', bodyId: 'pell', situation: 'spaceHigh' }]);
  t.career.creditScience('temperature', 'pell', 'spaceLow', 0.5);
  assert.equal(t.board.active.length, 1);
  const f0 = t.career.funds;
  t.career.creditScience('temperature', 'pell', 'spaceHigh', 0.5);
  assert.equal(t.board.active.length, 0, 'completed at once');
  assert.equal(t.career.funds, f0 + 3000, 'paid at once');
  const flying = vessel({ landed: false, situation: 'orbit', body: pell, altitude: 9e4, orbit: orbit(1e5, 9e4, 0, pell) });
  assert.deepEqual(outcomes(t.career.onEvent('tick', { vessel: flying }, world(3))), ['completed'], 'the notice is delivered on the next tick');
  assert.deepEqual(outcomes(t.career.onEvent('tick', { vessel: flying }, world(4))), []);
});

test('rescue-style recovery and the crew tour use the flight log', () => {
  // "recover a vessel that has been to Pell"
  let t = withContract([{ kind: 'recover', been: { visit: 'pell' } }]);
  const stay = vessel({ situation: 'landed' });
  assert.deepEqual(outcomes(t.career.onEvent('recovered', { vessel: stay, summary: { crew: [], science: [] } }, world(1))), [], 'never left home');
  const v = vessel({ landed: false, situation: 'escape', body: pell, altitude: 4e5 });
  t.career.onEvent('soi', { vessel: v, from: verda, to: pell }, world(2));
  Object.assign(v, { body: verda, landed: true, splashed: true, situation: 'splashed', altitude: 0 });
  t.career.onEvent('splashed', { vessel: v, speed: 5 }, world(3));
  assert.deepEqual(outcomes(t.career.onEvent('recovered', { vessel: v, summary: { crew: ['Juno'], science: [] } }, world(4))), ['completed']);
  assert.equal(t.career.flightLog[String(v.id)], undefined, 'the log entry is dropped after the contract has seen it');

  // "carry a Pip to orbit and bring them home": two objectives, the first one is announced on its own
  t = withContract([{ kind: 'achieve', been: { orbit: 'verda' }, crew: 1 }, { kind: 'recover', been: { orbit: 'verda' }, crew: 1 }]);
  const ship = vessel({ landed: false, situation: 'suborbital', altitude: 80e3 });
  assert.deepEqual(outcomes(t.career.onEvent('tick', { vessel: ship }, world(1))), []);
  ship.situation = 'orbit'; ship.orbit = orbit(90e3, 85e3);
  const got = t.career.onEvent('situation', { vessel: ship, from: 'suborbital', to: 'orbit' }, world(2));
  assert.deepEqual(outcomes(got), ['objective']);
  assert.equal(t.contract.objectives[0].done, true);
  assert.equal(t.contract.objectives[1].done, false);
  assert.deepEqual(t.career.flightLog[String(ship.id)].orbited, ['verda']);
  // an empty capsule coming home does not finish the tour
  Object.assign(ship, { landed: true, situation: 'landed', altitude: 0 });
  assert.deepEqual(outcomes(t.career.onEvent('recovered', { vessel: ship, summary: { crew: [], science: [] } }, world(3))), []);
  // (the log was dropped with that recovery; fly it again properly)
  const ship2 = vessel({ landed: false, situation: 'orbit', altitude: 90e3, orbit: orbit(95e3, 90e3) });
  t.career.onEvent('tick', { vessel: ship2 }, world(4));
  Object.assign(ship2, { landed: true, situation: 'landed', altitude: 0 });
  assert.deepEqual(outcomes(t.career.onEvent('recovered', { vessel: ship2, summary: { crew: ['Juno'], science: [] } }, world(5))), ['completed']);
});

test('debris and flags never satisfy objectives; a broken objective never throws', () => {
  const t = withContract([{ kind: 'flyby', bodyId: 'pell' }, { kind: 'no_such_kind' }]);
  const junk = vessel({ type: 'debris', body: pell, landed: false, situation: 'orbit' });
  assert.deepEqual(outcomes(t.career.onEvent('tick', { vessel: junk }, world(1))), []);
  assert.deepEqual(outcomes(t.career.onEvent('tick', {}, null)), []);
  assert.deepEqual(outcomes(t.career.onEvent('explosion', { pos: null }, world(2))), []);
});

// ---------------------------------------------------------------- persistence
test('contracts survive the save, including progress and the generator state', () => {
  const c = Career.newGame('career', { seed: 77 });
  const b = c.contracts;
  b.accept(b.offered[0].id);
  const t = withContract([{ kind: 'achieve', been: { space: true }, crew: 1 }, { kind: 'recover', been: { space: true }, crew: 1 }], { career: c });
  const v = vessel({ landed: false, situation: 'suborbital', altitude: 80e3 });
  c.onEvent('tick', { vessel: v }, world(50));
  assert.equal(t.contract.objectives[0].done, true);
  b.cancel(b.active[0].id);

  const d = Career.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
  assert.ok(d.contracts instanceof ContractBoard);
  assert.deepEqual(d.contracts.toJSON(), c.contracts.toJSON());
  assert.equal(d.contracts.active.find(k => k.id === 'cX').objectives[0].done, true);
  assert.equal(d.contracts.failed.length, 1);
  // both copies now draw the same next offer
  const k1 = c.contracts.decline(c.contracts.offered[0].id).replacement, k2 = d.contracts.decline(d.contracts.offered[0].id).replacement;
  assert.deepEqual(k1, k2);
  // junk in the save is dropped, not fatal
  const e = ContractBoard.fromJSON({ seed: 'x', offered: [null, { id: 3 }, 'no'], active: 'nope' }, c);
  assert.equal(e.offered.length + e.active.length, 0);
});

// ---------------------------------------------------------------- round 2: tourists and stations, flown for real
import { World } from '../../js/core/world.js';
import { Craft, stockCrafts } from '../../js/core/craft.js';
import { Orbit } from '../../js/core/orbit.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { Vector3, Quaternion } from '../../js/lib/three.module.min.js';
import { FACILITIES, FACILITY_IDS } from '../../js/core/career.js';

function offerOf(career, type, pred = () => true) {
  for (let seed = 1; seed < 400; seed++) {
    const b = new ContractBoard(career, seed);
    b.refresh();
    const k = b.offered.find(o => o.type === type && pred(o));
    if (k) { career.contracts = b; return k; }
  }
  return null;
}
function seasoned() {
  const c = Career.newGame('career', { seed: 11 });
  for (const n of TECH_TREE) c.tech.add(n.id);
  for (const id of ['first_launch', 'reach_space', 'orbit_verda']) c.milestones.add(id);
  return c;
}

test('tourists: a group booking completes only when the whole party flew and came home', () => {
  const career = seasoned();
  career.milestones.delete('orbit_verda');                    // a program that has reached space but not orbit is offered trips to space
  const k = offerOf(career, 'tourists', o => o.objectives[0].been && o.objectives[0].been.space && o.objectives[0].crew >= 2);
  assert.ok(k, 'a tourists-to-space contract is on some board');
  const need = k.objectives[0].crew, board = career.contracts;
  assert.equal(k.objectives.length, 2);
  assert.equal(k.objectives[1].kind, 'recover');
  assert.equal(k.objectives[1].crew, need, 'everyone who went up must come back');
  assert.ok(k.guests === need - 1, 'the contract says how many guests are in the party');
  const funds0 = career.funds, rep0 = career.reputation;
  assert.equal(board.accept(k.id).ok, true);
  const party = ['Juno', 'Bram', 'Tilly', 'Oskar'].slice(0, need);
  const pods = new Map([[1, { def: PARTS.pod_hearth, crew: party.slice(0, 3) }], [2, { def: PARTS.pod_acorn, crew: party.slice(3) }]]);

  // a short-handed flight does not count, however high it goes
  const solo = vessel({ landed: false, situation: 'suborbital', altitude: 80e3, parts: new Map([[1, { def: PARTS.pod_acorn, crew: ['Juno'] }]]) });
  assert.deepEqual(outcomes(career.onEvent('tick', { vessel: solo }, world(10))), []);
  // the full party in space: first objective
  const bus = vessel({ landed: false, situation: 'suborbital', altitude: 80e3, parts: pods });
  assert.deepEqual(outcomes(career.onEvent('tick', { vessel: bus }, world(20))), ['objective']);
  assert.equal(k.objectives[0].done, true);
  // coming home one Pip short does not finish it
  Object.assign(bus, { landed: true, situation: 'landed', altitude: 0 });
  assert.deepEqual(outcomes(career.onEvent('recovered', { vessel: bus, summary: { crew: party.slice(1), science: [] } }, world(30))), []);
  assert.equal(board.active.length, 1);
  // fly them again and bring everyone back
  const bus2 = vessel({ landed: false, situation: 'suborbital', altitude: 80e3, parts: pods });
  career.onEvent('tick', { vessel: bus2 }, world(40));
  Object.assign(bus2, { landed: true, situation: 'landed', altitude: 0 });
  assert.deepEqual(outcomes(career.onEvent('recovered', { vessel: bus2, summary: { crew: party, science: [] } }, world(50))), ['completed']);
  assert.equal(board.active.length, 0);
  assert.equal(board.completed[0].id, k.id);
  assert.ok(career.funds >= funds0 + k.advance + k.reward.funds, 'advance and fee are paid (milestones may add more)');
  assert.ok(career.reputation >= rep0 + k.reward.rep);
});

test('station: two vessels docked in orbit with seats, power and an antenna complete the contract; one alone does not', () => {
  const career = seasoned();
  const k = offerOf(career, 'station', o => o.bodyId === 'verda');
  assert.ok(k, 'a Verda station contract is on some board');
  const o = k.objectives[0];
  assert.equal(o.kind, 'station');
  assert.ok(o.seats >= 2 && o.ports >= 2 && o.hold >= 1);
  assert.equal(career.contracts.accept(k.id).ok, true);

  // the core: crew cabin(s), solar, antenna, a port on the nose; the visiting ship: a pod and a port
  const core = new Craft('Porch Core');
  let [cur] = core.setRoot('pod_hearth');
  core.attachStack('dock_m', cur.id, 'top');
  for (let seats = 3; seats < o.seats; seats += 3) cur = core.attachStack('pod_hearth', cur.id, 'bottom')[0];
  cur = core.attachStack('tank_m400', cur.id, 'bottom')[0];
  core.attachRadial('solar', cur.id, cur.pos.y, 0, 2);
  core.attachRadial('antenna', cur.id, cur.pos.y, Math.PI / 2, 1);
  core.autoStage();
  const visitor = new Craft('Porch Visitor');
  const [pod] = visitor.setRoot('pod_hearth');
  visitor.attachStack('dock_m', pod.id, 'top');
  visitor.attachStack('tank_mono', pod.id, 'bottom');
  visitor.autoStage();

  const home = SYSTEM.home, w = new World();
  const orb = Orbit.fromElements({ a: home.radius + 120e3, e: 0 }, home.gm, 0), s = orb.stateAt(0);
  const a = w.spawn(core, { crew: [], pos: s.r, vel: s.v });
  // before docking: the core alone, however well equipped, is not a station
  w.step(0.02);
  assert.equal(a.situation, 'orbit');
  for (let i = 0; i < o.hold + 2; i++) assert.deepEqual(outcomes(career.onEvent('tick', { vessel: a }, w)), [], 'not docked yet');
  const nose = new Vector3(0, 1, 0).applyQuaternion(a.q);
  const b = w.spawn(visitor, { crew: ['Juno'], pos: s.r.clone().addScaledVector(nose, 30), vel: s.v, makeActive: false });
  b.q.copy(a.q).multiply(new Quaternion(1, 0, 0, 0));
  const PA = new Vector3(), NA = new Vector3(), PB = new Vector3();
  a.portWorld(a.dockPorts[0], PA, NA); b.portWorld(b.dockPorts[0], PB);
  b.pos.add(PA.clone().addScaledVector(NA, 0.2).sub(PB));
  b.vel.copy(a.vel).addScaledVector(NA, -0.5);
  a.ctrl.sas = false; b.ctrl.sas = false;

  let docked = false;
  w.on('dock', () => { docked = true; });
  for (let t = 0; t < 20 && !docked; t += 0.02) w.step(0.02);
  assert.ok(docked, 'the two vessels latched');
  const st = w.active && !w.active.dead ? w.active : w.vessels.find(v => !v.dead && v.type === 'ship');
  assert.equal(st.situation, 'orbit');
  let got = [];
  for (let i = 0; i < o.hold + 1 && !got.length; i++) got = outcomes(career.onEvent('tick', { vessel: st }, w));
  assert.deepEqual(got, ['completed'], 'the docked pair holds its orbit and the contract pays');
  assert.equal(career.contracts.completed[0].id, k.id);
});

test('balance: facility levels fit the stock designs and the early game can pay its way', () => {
  const c = Career.newGame('career', { seed: 5 });
  const crafts = stockCrafts(), tierOf = cr => Math.max(...cr.parts.map(p => TECH_TREE.find(n => n.id === PARTS[p.type].tech).x));
  // level 1 buildings launch everything a program can research up to the moon landers (tier ≤ 4)
  for (const cr of crafts.filter(x => tierOf(x) <= 4)) assert.deepEqual(c.checkLaunch(cr, cr.site === 'runway' ? 'runway' : 'pad'), { ok: true }, cr.name + ' launches from level 1 buildings');
  // the heavy interplanetary stacks need the pad upgraded once; at the top level nothing is refused
  const heavy = crafts.filter(x => x.mass() / 1000 > FACILITIES.pad.values[0]);
  assert.ok(heavy.length >= 2, 'some stock rockets are too heavy for the first pad');
  for (const cr of heavy) assert.equal(c.checkLaunch(cr, 'pad').reason, 'mass');
  c.facilities.pad = 2; c.facilities.hangar = 2;
  // (the very heavy stack, Shearwater, is the one design that needs the pad at its top level)
  const giant = crafts.filter(x => x.mass() / 1000 > FACILITIES.pad.values[1]);
  assert.deepEqual(giant.map(x => x.name), ['Shearwater']);
  for (const cr of crafts.filter(x => !giant.includes(x))) assert.deepEqual(c.checkLaunch(cr, cr.site === 'runway' ? 'runway' : 'pad'), { ok: true }, cr.name + ' launches after one upgrade');
  c.facilities.pad = 3; c.facilities.hangar = 3;
  for (const cr of crafts) assert.deepEqual(c.checkLaunch(cr, cr.site === 'runway' ? 'runway' : 'pad'), { ok: true }, cr.name + ' launches from the top buildings');
  c.facilities.pad = 2; c.facilities.hangar = 2;
  for (const id of FACILITY_IDS) { const f = FACILITIES[id]; assert.ok(f.costs[1] > 0 && f.costs[2] > f.costs[1] * 2, id + ': the second upgrade is the big one'); }
  // funds: the milestones on the way to orbit pay for the first pad upgrade and a moon rocket between them
  const ms = id => MILESTONES.find(m => m.id === id);
  const toOrbit = ['first_launch', 'alt_10km', 'reach_space', 'orbit_verda', 'crew_return'].reduce((s, id) => s + ms(id).funds, 0);
  assert.ok(toOrbit + 25000 >= FACILITIES.pad.costs[1], 'reaching orbit plus the starting grant covers the first pad upgrade');
  // science: the milestones up to a Pell landing alone buy the path to the Pell lander's parts
  const path = ['basic_rocketry', 'survivability', 'general_construction', 'propulsion', 'landing', 'heavy'].reduce((s, id) => s + TECH_TREE.find(n => n.id === id).cost, 0);
  const sciToPell = ['first_launch', 'alt_10km', 'reach_space', 'orbit_verda', 'crew_return', 'eva_space', 'flag_verda', 'pell_flyby', 'pell_orbit'].reduce((s, id) => s + ms(id).science, 0);
  assert.ok(path <= 360, `the tech path to a moon lander costs ${path} science`);
  assert.ok(sciToPell >= path * 0.2, 'milestones carry a real share of it; experiments carry the rest');
  // tech costs never fall as the tree goes deeper
  for (const n of TECH_TREE) for (const r of n.requires) assert.ok(TECH_TREE.find(x => x.id === r).cost <= n.cost, `${n.id} costs at least as much as ${r}`);
  // every first offer on a fresh board can be flown with starting technology and pays more than the cheapest rocket costs to try
  for (let seed = 1; seed <= 12; seed++) {
    const g = Career.newGame('career', { seed });
    for (const k of g.contracts.offered) assert.ok(k.advance + k.reward.funds >= 800, `seed ${seed}: "${k.title}" pays ${k.advance + k.reward.funds}`);
  }
});
