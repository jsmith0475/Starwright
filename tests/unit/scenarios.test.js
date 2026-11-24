// Scenarios (js/core/scenarios.js): every ready-made game is built headlessly and held to what its card promises:
// the right vessels in the right place, real parts, sensible staging, crew aboard, landed craft standing ON the
// ground, enough delta-v for the goal, a save that round-trips, and a save slot that never touches the player's
// own program. The second half flies each scenario's goal with the game's own autopilot, so "enough fuel" and
// "this can be done from here" are measured, not estimated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { PARTS } from '../../js/core/parts.js';
import { World } from '../../js/core/world.js';
import { Craft } from '../../js/core/craft.js';
import { surfaceAt } from '../../js/core/vessel.js';
import { Career, SAVE_KEY, SCENARIO_SAVE_KEY } from '../../js/core/career.js';
import * as AP from '../../js/core/autopilot.js';
import * as S from '../../js/core/scenarios.js';

const B = SYSTEM.byId;
const km = m => (m / 1000).toFixed(1) + ' km';
const altPe = (v, ut) => v.getOrbit(ut).periapsis - v.body.radius;
const altAp = (v, ut) => v.getOrbit(ut).apoapsis - v.body.radius;
function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, keys: () => [...m.keys()] };
}

// What each card promises. vessels: [name, body, kind]; kind 'orbit' carries [peMin, peMax, apMin, apMax] in km.
const EXPECT = {
  'first-orbit': { start: 'builder', craft: 'Larkspur', crew: 1 },
  'pell-expedition': { start: 'builder', craft: 'Pellfarer', crew: 1 },
  'long-haul': { start: 'builder', craft: 'Wayfarer', crew: 3 },
  'pad-hop': { start: 'launch', active: 'Pipsqueak', crew: 1, vessels: [['Pipsqueak', 'verda', 'pad']] },
  'station-run': { start: 'launch', active: 'Tern', crew: 1, vessels: [['Hollin Station', 'verda', 'orbit', [145, 155, 145, 155]], ['Tern', 'verda', 'pad']] },
  'morning-orbit': { start: 'flight', active: 'Larkspur', crew: 1, vessels: [['Larkspur', 'verda', 'orbit', [90, 100, 90, 100]]] },
  'hollin-approach': { start: 'flight', active: 'Tern', crew: 1, vessels: [['Hollin Station', 'verda', 'orbit', [145, 155, 145, 155]], ['Tern', 'verda', 'orbit', [145, 155, 145, 155]]] },
  'topping-up': { start: 'flight', active: 'Shearwater', crew: 2, vessels: [['Deepwell', 'verda', 'orbit', [95, 105, 95, 105]], ['Shearwater', 'verda', 'orbit', [95, 105, 95, 105]]] },
  'belly-first': { start: 'flight', active: 'Shearwater', crew: 2, vessels: [['Shearwater', 'verda', 'orbit', [95, 105, 95, 105]]] },
  'pell-descent': { start: 'flight', active: 'Pellfarer', crew: 1, vessels: [['Pellfarer', 'pell', 'orbit', [25, 35, 25, 35]]] },
  'pell-homecoming': { start: 'flight', active: 'Pellfarer', crew: 1, vessels: [['Pellfarer', 'pell', 'landed']] },
  'ost-outpost': { start: 'flight', active: 'Ostrider', crew: 2, vessels: [['Ostrider', 'ost', 'landed']] },
  'murk-tracks': { start: 'flight', active: 'Pebble', crew: 0, vessels: [['Pebble', 'murk', 'landed']] },
  'pell-overland': { start: 'flight', active: 'Pebble', crew: 0, vessels: [['Pebble', 'pell', 'landed']] },
  'rusk-arrival': { start: 'flight', active: 'Wayfarer', crew: 3, vessels: [['Wayfarer', 'rusk', 'arrival']] },
  'tiv-survey': { start: 'flight', active: 'Wayfarer', crew: 3, vessels: [['Wayfarer', 'tiv', 'orbit', [55, 65, 55, 65]]] },
  'fire-and-silk': { start: 'flight', active: 'Larkspur Capsule', crew: 1, vessels: [['Larkspur Capsule', 'verda', 'suborbital']] },
};

// ---------------------------------------------------------------------------------------------- the catalog

test('the catalog: at least ten scenarios, each with a name, a world, a situation, a difficulty, a goal and objectives', () => {
  assert.ok(S.SCENARIOS.length >= 10, 'only ' + S.SCENARIOS.length);
  assert.deepEqual(S.SCENARIOS.map(s => s.id).sort(), Object.keys(EXPECT).sort(), 'every scenario has an entry in this test');
  const ids = new Set(), names = new Set();
  for (const s of S.SCENARIOS) {
    assert.ok(/^[a-z][a-z0-9-]+$/.test(s.id) && !ids.has(s.id), 'id ' + s.id); ids.add(s.id);
    assert.ok(s.name && !names.has(s.name), 'name ' + s.name); names.add(s.name);
    assert.ok(B[s.world], s.id + ': world ' + s.world);
    assert.equal(s.worldName, B[s.world].name);
    assert.ok(s.situation.length > 5 && s.goal.length > 15 && s.brief.length > 30, s.id + ': texts');
    assert.ok(s.goal.length <= 110, s.id + ': the goal is one line (' + s.goal.length + ')');
    assert.ok(['Easy', 'Medium', 'Hard'].includes(s.difficulty), s.id + ': difficulty');
    assert.ok(['builder', 'launch', 'flight'].includes(s.start));
    assert.ok(s.objectives.length >= 2 && s.objectives.every(o => o.id && o.text), s.id + ': objectives');
    assert.equal(new Set(s.objectives.map(o => o.id)).size, s.objectives.length);
    assert.ok(s.tips.length >= 2, s.id + ': tips');
    assert.equal(S.scenarioDef(s.id), s);
  }
  assert.equal(S.scenarioDef('nope'), null);
  assert.throws(() => S.buildScenario('nope'), /Unknown scenario/);
});

test('the catalog covers the range: assembly building, pad, low orbit, a station to dock with, a moon orbit, landed, a far world, an arrival, a re-entry', () => {
  const by = k => S.SCENARIOS.filter(k);
  assert.ok(by(s => s.start === 'builder').length >= 2, 'finished rockets in the assembly building');
  assert.ok(by(s => s.start === 'launch').length >= 1, 'on the pad');
  const built = Object.fromEntries(S.SCENARIOS.filter(s => s.start !== 'builder').map(s => [s.id, S.buildScenario(s.id)]));
  const some = fn => Object.values(built).some(fn);
  assert.ok(some(g => g.vessel.body === SYSTEM.home && g.vessel.situation === 'orbit' && g.vessels.length === 1), 'alone in low Verda orbit');
  assert.ok(some(g => g.vessels.length === 2 && g.vessels.every(v => v.situation === 'orbit' && v.dockPorts.length)), 'two ships in orbit that can dock');
  assert.ok(some(g => g.vessel.body.id === 'pell' && g.vessel.situation === 'orbit' && g.vessel.legParts.length), 'a lander in orbit of Pell');
  assert.ok(some(g => g.vessel.body.id === 'pell' && g.vessel.landed), 'landed on Pell');
  assert.ok(some(g => g.vessel.landed && !['verda', 'pell'].includes(g.vessel.body.id) && g.vessel.crew.length >= 1), 'a crew landed on another world');
  assert.ok(some(g => g.vessel.landed && g.vessel.wheelParts.length >= 4 && g.vessel.body !== SYSTEM.home), 'a rover on another world');
  assert.ok(some(g => g.vessel.body.type === 'planet' && g.vessel.body !== SYSTEM.home && g.vessel.getOrbit(g.world.ut).hyper), 'arriving at another planet');
  assert.ok(some(g => g.vessel.body.parent && g.vessel.body.parent.id === 'thal' && g.vessel.situation === 'orbit'), 'in orbit of a far world');
  assert.ok(some(g => g.vessel.body === SYSTEM.home && g.vessel.situation === 'suborbital' && g.vessel.chuteParts.length && g.vessel.partList.some(p => p.def.shield || p.def.res.ablator)), 'a capsule on its way back into the air');
});

// ---------------------------------------------------------------------------------------------- the craft

test('every scenario craft is built from real parts, in one piece, with a command part and sensible staging', () => {
  for (const [label, make] of Object.entries(S.SCENARIO_CRAFT)) {
    const c = make();
    assert.ok(c instanceof Craft && c.parts.length >= 3, label);
    const ids = new Set(c.parts.map(p => p.id));
    assert.equal(ids.size, c.parts.length, label + ': part ids unique');
    for (const p of c.parts) {
      assert.ok(PARTS[p.type] && !PARTS[p.type].hidden, `${label}: "${p.type}" is in the part catalog`);
      if (p.parent !== null) assert.ok(ids.has(p.parent), `${label}: part ${p.id} hangs on an existing part`);
    }
    assert.equal(c.parts.filter(p => p.parent === null).length, 1, label + ': one root');
    assert.equal(c.subtree(c.root).length, c.parts.length, label + ': every part is connected to the root');
    const val = c.validate();
    assert.ok(val.ok, label + ': ' + val.errors.join('; '));
    const full = /^(Larkspur|Pipsqueak|Pellfarer|Wayfarer|Tern)$/.test(label);       // the ones that leave the pad
    assert.ok(!val.warnings.some(w => (full ? /empty|not in any stage|too heavy|no propellant|flip/i : /empty|not in any stage|no propellant|flip/i).test(w)), label + ': ' + val.warnings.join('; '));
    const engines = c.parts.filter(p => PARTS[p.type].engine);
    if (engines.length) {
      assert.ok(c.stages.length >= 1 && c.stages.every(s => s.length), label + ': stages non-empty');
      const staged = new Set(c.stages.flat());
      for (const e of engines) assert.ok(staged.has(e.id), label + ': engine staged');
      for (const p of c.parts) if (PARTS[p.type].decoupler || PARTS[p.type].chute) assert.ok(staged.has(p.id), `${label}: ${p.type} staged`);
      // engines fire before the separators below the parts they need, and the parachute is last
      const chutes = c.parts.filter(p => PARTS[p.type].chute);
      if (chutes.length) assert.ok(c.stages[c.stages.length - 1].every(id => PARTS[c.getPart(id).type].chute), label + ': the parachute is the last stage');
      assert.ok(c.stages[0].some(id => PARTS[c.getPart(id).type].engine), label + ': the first stage lights an engine');
      assert.ok(c.stats()[0].twr > 1.15 || !full, label + ': lifts off (TWR ' + c.stats()[0].twr.toFixed(2) + ')');
    }
    // a copy through JSON is the same craft
    const again = Craft.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
    assert.equal(again.parts.length, c.parts.length);
    assert.deepEqual(again.stages, c.stages);
  }
});

// ---------------------------------------------------------------------------------------------- the built games

test('every scenario builds: sandbox career, all parts unlocked, the right vessels in the stated place, crew aboard, staging ready', () => {
  for (const s of S.SCENARIOS) {
    const exp = EXPECT[s.id], g = S.buildScenario(s.id), c = g.career;
    assert.equal(g.scenario, s);
    assert.equal(c.mode, 'sandbox', s.id);
    assert.equal(c.usesFunds, false, s.id + ': no funds pressure');
    for (const def of Object.values(PARTS)) if (!def.hidden) assert.ok(c.isPartUnlocked(def.id), `${s.id}: ${def.id} unlocked`);
    assert.equal(c.scenario.id, s.id);
    assert.deepEqual(c.scenario.done, []);
    assert.equal(c.ut, S.SCENARIO_UT);
    assert.equal(s.start, exp.start);
    assert.equal(g.crew.length, exp.crew, s.id + ': crew ' + g.crew);
    for (const n of g.crew) assert.ok(c.roster.some(p => p.name === n), `${s.id}: ${n} is on the roster`);

    if (exp.start === 'builder') {
      assert.equal(g.world, null);
      assert.equal(g.craft.name, exp.craft);
      assert.deepEqual(g.start, { screen: 'builder', params: { craft: g.craft.toJSON(), site: 'pad' } });
      assert.ok(c.crafts[exp.craft], s.id + ': the design is saved in the program');
      assert.equal(c.flightState, null);
      const seats = g.craft.parts.reduce((n, p) => n + (PARTS[p.type].command === 'crew' ? PARTS[p.type].crew : 0), 0);
      assert.ok(seats >= exp.crew, s.id + ': seats for the crew');
      assert.ok(c.availableCrew().length >= exp.crew, s.id + ': a crew is free to fly it');
      assert.ok(c.checkLaunch(g.craft, 'pad').ok, s.id + ': the pad and the hall take it');
      continue;
    }

    const w = g.world;
    assert.equal(g.vessels.length, exp.vessels.length, s.id + ': vessel count');
    assert.equal(w.vessels.length, exp.vessels.length);
    assert.equal(w.active, g.vessel);
    assert.equal(g.vessel.name, exp.active, s.id + ': the active vessel');
    assert.equal(g.vessel.crew.length, exp.crew, s.id + ': crew aboard ' + g.vessel.crew);
    for (const n of g.vessel.crew) assert.equal(c.roster.find(p => p.name === n).status, 'assigned', `${s.id}: ${n} is marked as flying`);
    if (exp.crew === 0) assert.ok(g.vessel.commandParts.some(p => p.def.command === 'probe'), s.id + ': an uncrewed vessel has a probe core');

    for (const [name, bodyId, kind, range] of exp.vessels) {
      const v = w.vessels.find(x => x.name === name);
      assert.ok(v, `${s.id}: ${name} exists`);
      assert.equal(v.type, 'ship');
      assert.equal(v.body.id, bodyId, `${s.id}: ${name} is at ${bodyId}`);
      const b = v.body, o = v.landed ? null : v.getOrbit(w.ut);
      for (const k of ['x', 'y', 'z']) assert.ok(Number.isFinite(v.pos[k]) && Number.isFinite(v.vel[k]), `${s.id}: ${name} state is finite`);
      if (kind === 'orbit') {
        assert.equal(v.situation, 'orbit', `${s.id}: ${name}`);
        const pe = (o.periapsis - b.radius) / 1000, ap = (o.apoapsis - b.radius) / 1000;
        assert.ok(pe >= range[0] && pe <= range[1] && ap >= range[2] && ap <= range[3], `${s.id}: ${name} orbit ${pe.toFixed(1)} × ${ap.toFixed(1)} km`);
        assert.ok(o.e < 0.01, `${s.id}: near circular`);
        const floor = b.atmo ? b.atmo.height : (b.maxElevation || 0);
        assert.ok(o.periapsis - b.radius > floor + 5000, `${s.id}: ${name} periapsis ${km(o.periapsis - b.radius)} clears the ${b.atmo ? 'air' : 'mountains'} (${km(floor)})`);
        assert.ok(o.apoapsis < b.soi, 'inside the sphere of influence');
        assert.ok(S.inStableOrbit(v, bodyId, 0, w.ut));
      } else if (kind === 'landed' || kind === 'pad') {
        assert.ok(v.landed && !v.splashed, `${s.id}: ${name} landed`);
        assert.equal(v.situation, kind === 'pad' ? 'prelaunch' : 'landed');
        // the lowest point of the vessel is on the terrain (measured two ways: the surface anchor, and the pose)
        const clear = S.groundClearance(v);
        assert.ok(Math.abs(clear) < 0.5, `${s.id}: ${name} stands ${clear.toFixed(3)} m above the ground`);
        const dir = b.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut, new Vector3());
        const up = v.pos.clone().normalize().applyQuaternion(v.q.clone().invert());
        const low = v.pos.length() - b.radius + v._lowest(up).h;
        assert.ok(Math.abs(low - b.terrainHeight(dir)) < 0.5, `${s.id}: ${name} lowest point at ${low.toFixed(2)} m, terrain at ${b.terrainHeight(dir).toFixed(2)} m`);
        assert.ok(Math.abs(v.radarAlt) < 0.5, `${s.id}: radar altitude ${v.radarAlt}`);
        assert.ok(!(b.ocean && b.isWater(dir)), s.id + ': on dry land');
        if (kind === 'landed') {
          assert.ok(S.slopeAt(b, v.surface.dir) < 0.08, `${s.id}: on flat ground (slope ${S.slopeAt(b, v.surface.dir).toFixed(3)})`);
          // daylight: the sun is up at the landing site
          const sun = b.globalPosAt(w.ut, new Vector3()).negate().normalize();
          assert.ok(v.pos.clone().normalize().dot(sun) > 0.2, s.id + ': the site is in daylight');
          if (v.legParts.length) assert.ok(v.legsDown, s.id + ': legs down');
          // upright (or on its wheels): the craft axis that should point up does
          const axis = (v.surface.vehicle ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0)).applyQuaternion(v.q);
          assert.ok(axis.dot(v.pos.clone().normalize()) > 0.99, s.id + ': standing upright');
        }
      } else if (kind === 'arrival') {
        assert.ok(o.hyper && o.e > 1, `${s.id}: on an open (hyperbolic) path, e = ${o.e.toFixed(2)}`);
        assert.ok(v.pos.dot(v.vel) < 0, s.id + ': inbound');
        assert.ok(v.pos.length() < b.soi * 0.5, s.id + ': well inside the sphere of influence');
        const pe = o.periapsis - b.radius;
        assert.ok(pe > (b.atmo ? b.atmo.height : 0) + 20000 && pe < 300000, `${s.id}: closest approach ${km(pe)} is above the air and close enough to capture`);
        const tPe = o.timeAtRadius(o.periapsis * 1.0001, true, w.ut) - w.ut;
        assert.ok(tPe > 1800 && tPe < 6 * 3600, `${s.id}: ${(tPe / 60).toFixed(0)} min to plan the burn`);
      } else if (kind === 'suborbital') {
        assert.equal(v.situation, 'suborbital');
        assert.ok(o.periapsis - b.radius < b.atmo.height * 0.5, s.id + ': the path dips deep into the air');
        assert.ok(v.altitude > b.atmo.height, s.id + ': starts above the air');
        assert.ok(v.orbitalSpeed > 2000, s.id + ': fast enough to need the shield (' + v.orbitalSpeed.toFixed(0) + ' m/s)');
        assert.ok(v.chuteParts.length >= 1 && v.resources.ablator.amount > 0, s.id + ': parachute and ablator aboard');
        assert.ok(v.chuteParts.every(p => p.deployed === 'stowed' || !p.deployed), s.id + ': parachute still packed');
      }
      // staging: something is left to do with Space wherever the vessel has engines, separators or parachutes
      if (v.engines.length || v.chuteParts.length) {
        assert.ok(v.stages.length >= 1 && v.stages.every(st => st.length), `${s.id}: ${name} stages non-empty`);
        if (kind === 'pad' || kind === 'suborbital') assert.equal(v.stageIndex, 0);
        else if (v.engines.length) {
          assert.ok(v.engines.some(e => e.part.ignited && !e.part.flameout), `${s.id}: ${name} has a live engine`);
          assert.equal(v.ctrl.throttle, 0, s.id + ': throttle closed');
          assert.equal(v.thrust || 0, 0);
        }
      }
      assert.ok(v.ctrl.sas, `${s.id}: ${name} SAS on`);
      assert.ok(v.resources.elec.amount > 0, `${s.id}: ${name} has charge`);
    }
    if (exp.start === 'launch') {
      assert.equal(g.start.screen, 'flight');
      assert.deepEqual(Object.keys(g.start.params).sort(), ['craft', 'crew', 'paid', 'site']);
      assert.equal(g.start.params.craft.name, exp.active);
      // what is already flying is the saved flight the launch joins; the craft on the pad is not in it yet
      const saved = c.flightState ? c.flightState.vessels.map(v => v.name) : [];
      assert.deepEqual(saved, exp.vessels.filter(v => v[2] !== 'pad').map(v => v[0]));
    } else {
      assert.deepEqual(g.start, { screen: 'flight', params: { resume: true } });
      assert.ok(c.flightState && c.flightState.vessels.length === exp.vessels.length);
    }
  }
});

test('landed craft stay put: ten seconds of physics later they still stand on the ground in one piece', () => {
  for (const s of S.SCENARIOS) {
    const g = S.buildScenario(s.id);
    if (!g.world) continue;
    const landed = g.vessels.filter(v => v.landed);
    if (!landed.length) continue;
    const w = g.world, before = landed.map(v => ({ n: v.parts.size, dir: v.surface.dir.clone() }));
    let boom = 0; w.on('explosion', () => { boom++; });
    for (let i = 0; i < 200; i++) w.step(0.05);
    landed.forEach((v, i) => {
      assert.ok(!v.dead && v.parts.size === before[i].n && boom === 0, `${s.id}: ${v.name} intact`);
      assert.ok(v.landed || v.grounded, `${s.id}: ${v.name} still on the ground`);
      const b = v.body, dir = b.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut, new Vector3());
      const up = v.pos.clone().normalize().applyQuaternion(v.q.clone().invert());
      const low = v.pos.length() - b.radius + v._lowest(up).h - surfaceAt(b, dir);
      assert.ok(Math.abs(low) < 0.5, `${s.id}: ${v.name} lowest point ${low.toFixed(3)} m above the terrain after 10 s`);
      assert.ok(Math.acos(Math.min(1, dir.dot(before[i].dir))) * b.radius < 0.5, `${s.id}: ${v.name} has not slid`);
    });
  }
});

test('every scenario serialises and reloads: career, scenario progress, world, vessels, crew and the active vessel', () => {
  for (const s of S.SCENARIOS) {
    const g = S.buildScenario(s.id);
    const text = JSON.stringify(g.career.toJSON());
    const c2 = Career.fromJSON(JSON.parse(text));
    assert.equal(c2.mode, 'sandbox');
    assert.deepEqual(c2.scenario, g.career.scenario, s.id + ': scenario record');
    assert.equal(JSON.stringify(c2.toJSON()), text, s.id + ': a second save is identical');
    assert.equal(S.scenarioStatus(c2).id, s.id);
    if (!g.world) { assert.deepEqual(Craft.fromJSON(Object.values(c2.crafts)[0]).toJSON(), g.craft.toJSON()); continue; }
    const w2 = World.fromJSON(JSON.parse(JSON.stringify(g.world.toJSON())));
    assert.equal(w2.vessels.length, g.vessels.length, s.id);
    assert.equal(w2.active.name, g.vessel.name);
    assert.equal(w2.ut, g.world.ut);
    for (const v of g.vessels) {
      const u = w2.vessels.find(x => x.id === v.id);
      assert.ok(u && u.name === v.name && u.body === v.body, s.id + ': ' + v.name);
      assert.ok(u.pos.distanceTo(v.pos) < 0.01 && u.vel.distanceTo(v.vel) < 0.001, `${s.id}: ${v.name} is where it was`);
      assert.deepEqual(u.crew, v.crew);
      assert.equal(u.parts.size, v.parts.size);
      assert.equal(u.landed, v.landed);
      assert.equal(u.stageIndex, v.stageIndex);
      assert.ok(Math.abs(u.deltaV - v.deltaV) < 1, `${s.id}: ${v.name} delta-v survives the save`);
      if (v.landed) assert.ok(Math.abs(S.groundClearance(u)) < 0.5, s.id + ': still on the ground after loading');
    }
    // and it flies on after loading
    for (let i = 0; i < 20; i++) w2.step(0.05);
    assert.ok(w2.active && !w2.active.dead, s.id + ': runs after loading');
    // building twice gives the same game
    assert.equal(JSON.stringify(S.buildScenario(s.id).career.toJSON()), text, s.id + ': deterministic');
  }
});

// ---------------------------------------------------------------------------------------------- the save slot

test('a scenario game saves to its own slot and never touches the player\'s program', () => {
  const store = memoryStorage();
  const mine = Career.newGame('career', { seed: 7 });
  mine.funds = 12345; mine.ut = 999;
  assert.ok(mine.save(store));
  const mineText = store.getItem(SAVE_KEY);
  assert.ok(mineText && !('scenario' in JSON.parse(mineText)), 'an ordinary save carries no scenario field');
  assert.equal(S.hasScenarioGame(store), false);
  assert.equal(S.loadScenarioGame(store), null);
  assert.equal(S.scenarioSlotInfo(store), null);

  const g = S.buildScenario('morning-orbit');
  assert.ok(g.career.save(store));
  assert.equal(store.getItem(SAVE_KEY), mineText, 'the player\'s save is byte for byte what it was');
  assert.ok(store.getItem(SCENARIO_SAVE_KEY));
  assert.notEqual(SCENARIO_SAVE_KEY, SAVE_KEY);
  assert.deepEqual(S.scenarioSlotInfo(store), { id: 'morning-orbit', name: 'Morning Orbit', done: 0, total: 2, complete: false, ut: S.SCENARIO_UT });

  // the scenario comes back from its slot; the program comes back from its own
  const back = S.loadScenarioGame(store);
  assert.equal(back.scenario.id, 'morning-orbit');
  assert.equal(back.flightState.vessels[0].name, 'Larkspur');
  const prog = Career.load(store);
  assert.equal(prog.funds, 12345); assert.equal(prog.scenario, null); assert.equal(prog.mode, 'career');

  // a career restored from a snapshot of a scenario game (quickload, revert) is still a scenario game
  const snap = Career.fromJSON(JSON.parse(JSON.stringify(back.toJSON())));
  snap.scenario.done.push('ap');
  assert.ok(snap.save(store));
  assert.equal(store.getItem(SAVE_KEY), mineText);
  assert.equal(S.scenarioSlotInfo(store).done, 1);

  // starting another scenario replaces only the scenario slot
  S.deleteScenarioGame(store);
  assert.equal(S.hasScenarioGame(store), false);
  S.buildScenario('fire-and-silk').career.save(store);
  assert.equal(S.scenarioSlotInfo(store).id, 'fire-and-silk');
  assert.equal(store.getItem(SAVE_KEY), mineText);
  // deleting the player's save leaves the scenario alone, and the other way round
  Career.deleteSave(store);
  assert.ok(S.hasScenarioGame(store));
  // rubbish in the slot is not a game
  store.setItem(SCENARIO_SAVE_KEY, '{not json');
  assert.equal(S.loadScenarioGame(store), null);
  assert.equal(S.scenarioSlotInfo(store), null);
});

test('objectives: status lists them, they are met in order, stay met, and completion is recorded', () => {
  const g = S.buildScenario('fire-and-silk'), c = g.career, w = g.world, v = g.vessel;
  let st = S.scenarioStatus(c);
  assert.deepEqual(st.objectives.map(o => [o.id, o.done]), [['air', false], ['home', false]]);
  assert.equal(st.goal, S.scenarioDef('fire-and-silk').goal);
  assert.equal(st.complete, false);
  assert.deepEqual(S.checkScenario(c, w), [], 'nothing is met at the start');
  assert.equal(S.scenarioStatus(Career.newGame('sandbox')), null, 'an ordinary game has no scenario');
  assert.deepEqual(S.checkScenario(Career.newGame('sandbox'), w), []);
  assert.deepEqual(S.checkScenario(c, null), []);
  // every scenario starts with nothing ticked (no goal is satisfied by the starting state)
  for (const s of S.SCENARIOS) { const x = S.buildScenario(s.id); if (x.world) assert.deepEqual(S.checkScenario(x.career, x.world), [], s.id + ': starts with no objective met'); }
  // checking never disturbs the vessel (the orbit cache keeps its epoch)
  assert.ok(Number.isFinite(v.getOrbit(w.ut).periapsis));
  // a state that satisfies the second objective but not the first ticks nothing
  const save = { landed: v.landed, situation: v.situation };
  v.landed = true; v.situation = 'landed';
  assert.deepEqual(S.checkScenario(c, w), []);
  v.landed = save.landed; v.situation = save.situation;
  c.scenario.done.push('air');
  st = S.scenarioStatus(c);
  assert.equal(st.done, 1); assert.equal(st.objectives[0].done, true);
});

// ---------------------------------------------------------------------------------------------- delta-v and flights

/** Step the world under an autopilot program (or none), checking the scenario's objectives as the game does. */
function fly(g, w, ctl, opts = {}) {
  const c = AP.fly(w, ctl, { ...opts, onStep: () => { S.checkScenario(g.career, w); if (opts.onStep) opts.onStep(); } });
  S.checkScenario(g.career, w);
  return c;
}
const logOf = c => c.log.map(l => l.msg).join('; ');
/** Coast on rails with the game's own warp until `until()`. */
function coast(g, w, until, maxSim = 4e5) {
  AP.fly(w, null, { physWarp: 0, dt: 0.1, maxSim, until: () => { if (w.warpIndex < w.maxWarpIndex()) w.setWarp(99); return until(); } });
  w.setWarp(0);
  S.checkScenario(g.career, w);
}
/** Ride a capsule down: hold the shield into the wind, open the parachute low and slow. → { maxTemp, ablator } */
function comeHome(g, w, v) {
  v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde'; v.ctrl.throttle = 0;
  let maxTemp = 0, armed = false, lost = 0, touch = null;
  w.on('crewLost', () => { lost++; });
  const onLand = d => { if (d.vessel === v) touch = d.speed; };
  w.on('landed', onLand); w.on('splashed', onLand);
  fly(g, w, null, { maxSim: 9000, until: () => {
    maxTemp = Math.max(maxTemp, v.maxTempRatio || 0);
    if (!armed && v.altitude < 5000 && v.airspeed < 260) { while (v.stageIndex < v.stages.length) w.stage(); armed = true; }
    return v.landed || v.dead;
  } });
  return { maxTemp, ablator: v.resources.ablator ? v.resources.ablator.amount : 0, lost, touch };
}
const doneOf = g => g.career.scenario.done.join(',');

test('delta-v: every craft carries what its goal costs (with a margin)', () => {
  const verda = B.verda, pell = B.pell, rusk = B.rusk, tiv = B.tiv, ost = B.ost;
  const dv = c => c.deltaV().vac;
  const hohmannOut = (b, alt, rFar) => { const r = b.radius + alt, a = (r + rFar) / 2; return Math.sqrt(b.gm * (2 / r - 1 / a)) - Math.sqrt(b.gm / r); };
  // to a moon of the same planet: burn out to its orbit, arrive at the difference of the two speeds
  const moonVInf = (b, alt, moon) => { const r = b.radius + alt, a = (r + moon.orbit.a) / 2; return Math.sqrt(b.gm / moon.orbit.a) - Math.sqrt(b.gm * (2 / moon.orbit.a - 1 / a)); };
  const captureCirc = (b, vInf, alt) => { const r = b.radius + alt; return Math.sqrt(vInf * vInf + 2 * b.gm / r) - Math.sqrt(b.gm / r); };
  const need = {};
  // in the assembly building
  need['first-orbit'] = S.ascentDv(verda) + 150;                                             // orbit, then a deorbit burn
  const pellLeg = hohmannOut(verda, 80000, pell.orbit.a) + captureCirc(pell, moonVInf(verda, 80000, pell), 30000);
  const pellHome = S.ascentDv(pell) + captureCirc(pell, moonVInf(verda, 80000, pell), 15000) * 1.1;   // up, then leave Pell the way it was reached
  need['pell-expedition'] = S.ascentDv(verda) + pellLeg + S.landingDv(pell, 30000) + pellHome;
  need['long-haul'] = S.ascentDv(verda) + S.ejectionDv(verda, S.departureVInf(verda, rusk), 90000) + 150 + S.captureDv(rusk, S.arrivalVInf(verda, rusk), 90000);
  for (const id of ['first-orbit', 'pell-expedition', 'long-haul']) {
    const g = S.buildScenario(id), have = dv(g.craft);
    assert.ok(have >= need[id] * 1.05, `${id}: ${have.toFixed(0)} m/s aboard, the goal costs about ${need[id].toFixed(0)} m/s`);
  }
  // already under way: what the vessel has left against what is still to do
  need['morning-orbit'] = 2 * hohmannOut(verda, 95000, verda.radius + 200000) + 20 + 120;      // raise, circularise, and a deorbit burn to spare
  need['hollin-approach'] = 30;                                                                // main engine not needed; RCS is checked below
  need['pell-descent'] = S.landingDv(pell, 30000);
  need['pell-homecoming'] = pellHome;
  need['ost-outpost'] = S.ascentDv(ost);
  need['rusk-arrival'] = S.captureDv(rusk, S.arrivalVInf(verda, rusk), 90000, rusk.radius + 90000);   // all the way to a circular orbit
  need['tiv-survey'] = S.landingDv(tiv, 60000);
  for (const [id, cost] of Object.entries(need)) {
    if (EXPECT[id].start === 'builder') continue;
    const g = S.buildScenario(id), v = g.vessel;
    assert.ok(v.deltaV >= cost * 1.15, `${id}: ${v.deltaV.toFixed(0)} m/s aboard, the goal costs about ${cost.toFixed(0)} m/s`);
    assert.ok(v.deltaV < cost * 6 + 2500, `${id}: not a flying fuel dump (${v.deltaV.toFixed(0)} m/s for ${cost.toFixed(0)})`);
  }
  // thrust: landers can hover and lift off where they are
  for (const id of ['pell-descent', 'pell-homecoming', 'ost-outpost', 'tiv-survey']) {
    const v = S.buildScenario(id).vessel, g0 = v.body.gm / (v.body.radius * v.body.radius);
    const thrust = v.engines.filter(e => e.part.ignited).reduce((n, e) => n + e.part.def.engine.thrust * 1000, 0);
    assert.ok(thrust / (v.mass * g0) > 1.5, `${id}: thrust-to-weight ${(thrust / (v.mass * g0)).toFixed(2)} on ${v.body.name}`);
  }
  // docking: thrusters, monopropellant, matching rings, the station set as target
  for (const id of ['hollin-approach', 'station-run']) {
    const g = S.buildScenario(id), ship = g.vessels.find(v => v.name === 'Tern'), station = g.vessels.find(v => v.name === 'Hollin Station');
    assert.ok(ship.rcsParts.length >= 4 && ship.resources.mono.amount >= 200, id + ': thrusters and monopropellant');
    assert.equal(ship.dockPorts[0].def.dock.size, station.dockPorts[0].def.dock.size, id + ': the rings match');
    assert.ok(station.solarParts.length && station.resources.elec.amount > 0);
  }
  const ha = S.buildScenario('hollin-approach');
  assert.equal(ha.world.getTarget(ha.vessel).name, 'Hollin Station');
  const d = ha.vessel.pos.distanceTo(ha.vessels[0].pos);
  assert.ok(d > 100 && d < 140 && ha.vessel.vel.distanceTo(ha.vessels[0].vel) < 0.2, `hollin-approach: ${d.toFixed(0)} m apart, at rest`);
  assert.ok(ha.vessel.ctrl.rcs, 'RCS on');
  // the rover has power to drive for a long time
  const rover = S.buildScenario('murk-tracks').vessel;
  assert.ok(rover.wheelParts.filter(p => p.def.wheel.drive > 0).length >= 4 && rover.resources.elec.max >= 300);
});

test('flight: First Orbit - the Larkspur reaches orbit from the pad, deorbits and lands with Juno alive', () => {
  const g = S.buildScenario('first-orbit'), w = new World({ ut: S.SCENARIO_UT });
  const v = w.launch(g.craft, { crew: g.crew });
  const asc = fly(g, w, AP.ascentProgram(w, { targetAlt: 80000 }), { maxSim: 3000 });
  assert.ok(asc.done && !asc.failed, logOf(asc));
  assert.ok(altPe(v, w.ut) > 72000, 'periapsis ' + km(altPe(v, w.ut)));
  assert.equal(doneOf(g), 'space,orbit');
  assert.ok(v.deltaV > 300, 'fuel left in orbit: ' + v.deltaV.toFixed(0) + ' m/s');
  const de = fly(g, w, AP.deorbit(w, v, { periapsis: 30000 }), { maxSim: 900 });
  assert.ok(de.done && !de.failed);
  w.stage();                                                    // drop the service stage
  const r = comeHome(g, w, v);
  assert.ok(v.landed && !v.dead && r.lost === 0 && r.touch < 9, JSON.stringify(r));
  assert.deepEqual(v.crew, ['Juno']);
  assert.ok(r.ablator < 195, 'the shield did some work');
  assert.ok(g.career.scenario.complete, 'all objectives: ' + doneOf(g));
});

test('flight: Light the Candle - the Pipsqueak passes the edge of space and lands under its parachute', () => {
  const g = S.buildScenario('pad-hop'), w = g.world, v = g.vessel;
  w.stage();
  let apex = 0;
  fly(g, w, null, { maxSim: 600, until: () => { apex = Math.max(apex, v.altitude); return v.verticalSpeed < 0 && apex > 1000 && v.altitude < 100000; } });
  assert.ok(apex > 80000 && apex < 400000, 'apex ' + km(apex));
  w.stage();                                                    // drop the spent booster
  const r = comeHome(g, w, v);
  assert.ok(v.landed && !v.dead && r.lost === 0 && r.touch < 9, JSON.stringify(r));
  assert.ok(r.maxTemp < 0.95, 'hottest part at ' + (r.maxTemp * 100).toFixed(0) + ' % of its limit');
  assert.ok(g.career.scenario.complete, doneOf(g));
});

test('flight: Pell Expedition and The Long Haul - the launchers reach orbit with the fuel for the rest of the trip', () => {
  const verda = B.verda, pell = B.pell, rusk = B.rusk;
  {
    const g = S.buildScenario('pell-expedition'), w = new World({ ut: S.SCENARIO_UT }), v = w.launch(g.craft, { crew: g.crew });
    const asc = fly(g, w, AP.ascentProgram(w, { targetAlt: 80000 }), { maxSim: 3000 });
    assert.ok(asc.done && !asc.failed && altPe(v, w.ut) > 72000, logOf(asc));
    assert.equal(doneOf(g), 'orbit');
    // what flight 3 of flights.test.js measures for the same trip in a Pell Runner: transfer about 690, capture about 250, landing about 700
    const rest = 690 + 250 + S.landingDv(pell, 30000) + S.ascentDv(pell) + 330;
    assert.ok(v.deltaV > rest * 1.1, `in orbit with ${v.deltaV.toFixed(0)} m/s; Pell and back costs about ${rest.toFixed(0)} m/s`);
    const plan = AP.planHohmannToMoon(w, v, pell);
    assert.ok(plan && plan.dv < 900, 'a transfer to Pell can be planned from here: ' + (plan && plan.dv.toFixed(0)));
  }
  {
    const g = S.buildScenario('long-haul'), w = new World({ ut: S.SCENARIO_UT }), v = w.launch(g.craft, { crew: g.crew });
    const asc = fly(g, w, AP.ascentProgram(w, { targetAlt: 90000 }), { maxSim: 3000 });
    assert.ok(asc.done && !asc.failed && altPe(v, w.ut) > 72000, logOf(asc));
    assert.deepEqual(v.crew, ['Oskar', 'Bram', 'Tilly']);
    const rest = S.ejectionDv(verda, S.departureVInf(verda, rusk), 90000) + 200 + S.captureDv(rusk, S.arrivalVInf(verda, rusk), 90000, rusk.radius + 400000);
    assert.ok(v.deltaV > rest * 1.5, `in orbit with ${v.deltaV.toFixed(0)} m/s; Rusk orbit costs about ${rest.toFixed(0)} m/s`);
    assert.ok(v.partList.some(p => p.type === 'eng_furnace') && v.partList.some(p => p.type === 'eng_osprey'), 'the atomic stage and the lander are still aboard');
  }
});

test('flight: Station Run - the Tern launches, meets Hollin Station and docks', () => {
  const g = S.buildScenario('station-run'), w = g.world, v = g.vessel;
  const station = w.vessels.find(x => x.name === 'Hollin Station');
  const asc = fly(g, w, AP.ascentProgram(w, { targetAlt: 100000 }), { maxSim: 3000 });
  assert.ok(asc.done && !asc.failed, logOf(asc));
  assert.ok(v.deltaV > 600, 'in orbit with ' + v.deltaV.toFixed(0) + ' m/s for the chase');
  const rdv = fly(g, w, AP.rendezvous(w, v, station), { maxSim: 1e5 });
  assert.ok(rdv.done && !rdv.failed, logOf(rdv));
  const dock = fly(g, w, AP.dockingApproach(w, v, station), { maxSim: 2400, physWarp: 1 });
  assert.ok(dock.done && !dock.failed, logOf(dock));
  assert.ok(v.dockedPairs.length === 1 && station.dead, 'docked');
  assert.ok(g.career.scenario.complete, doneOf(g));
});

test('flight: Morning Orbit - two burns raise the Larkspur above 200 km with fuel left to come home', () => {
  const g = S.buildScenario('morning-orbit'), w = g.world, v = g.vessel, b = v.body;
  const r1 = b.radius + 95000, r2 = b.radius + 210000, a = (r1 + r2) / 2;
  v.addNode(w.ut + 120, { prograde: Math.sqrt(b.gm * (2 / r1 - 1 / a)) - Math.sqrt(b.gm / r1) });
  const b1 = fly(g, w, AP.executeNode(w, v), { maxSim: 5000 });
  assert.ok(b1.done && !b1.failed, logOf(b1));
  assert.equal(doneOf(g), 'ap');
  AP.planCircularize(w, v, 'apoapsis');
  const b2 = fly(g, w, AP.executeNode(w, v), { maxSim: 9000 });
  assert.ok(b2.done && !b2.failed, logOf(b2));
  assert.ok(altPe(v, w.ut) > 200000 && altAp(v, w.ut) < 240000, `${km(altPe(v, w.ut))} × ${km(altAp(v, w.ut))}`);
  assert.ok(g.career.scenario.complete, doneOf(g));
  assert.ok(v.deltaV > 500, 'left: ' + v.deltaV.toFixed(0) + ' m/s');
});

test('flight: Hollin Approach - the Tern closes 120 m and docks', () => {
  const g = S.buildScenario('hollin-approach'), w = g.world, v = g.vessel;
  const station = w.vessels.find(x => x.name === 'Hollin Station');
  const mine = v.parts.size, theirs = station.parts.size;
  let docked = 0; w.on('dock', () => { docked++; });
  const dock = fly(g, w, AP.dockingApproach(w, v, station), { maxSim: 2400, physWarp: 1 });
  assert.ok(dock.done && !dock.failed && docked === 1, logOf(dock));
  assert.equal(v.parts.size, mine + theirs, 'one vessel now');
  assert.equal(w.vessels.filter(x => !x.dead && x.type === 'ship').length, 1);
  assert.ok(v.resources.mono.amount > 100, 'monopropellant left: ' + v.resources.mono.amount.toFixed(0));
  assert.ok(g.career.scenario.complete, doneOf(g));
});

test('flight: Above Pell and Under the Giant - the landers come down from orbit and stand on the ground', () => {
  for (const id of ['pell-descent', 'tiv-survey']) {
    const g = S.buildScenario(id), w = g.world, v = g.vessel, dv0 = v.deltaV;
    let touch = null, boom = 0; w.on('landed', d => { if (d.vessel === v) touch = d.speed; }); w.on('explosion', () => { boom++; });
    const land = fly(g, w, AP.hoverslamLanding(w, v), { maxSim: 1e5 });
    assert.ok(land.done && !land.failed && v.landed, id + ': ' + logOf(land));
    assert.ok(touch !== null && touch < 5 && boom === 0, `${id}: touchdown at ${touch} m/s`);
    assert.ok(v.deltaV > 600, `${id}: ${dv0.toFixed(0)} → ${v.deltaV.toFixed(0)} m/s`);
    assert.equal(v.crew.length, EXPECT[id].crew);
    if (id === 'tiv-survey') {
      const pip = w.evaStart(v);
      AP.fly(w, null, { maxSim: 2, physWarp: 0 });
      assert.ok(w.plantFlag(pip, 'First on Tiv'));
      S.checkScenario(g.career, w);
    }
    assert.ok(g.career.scenario.complete, id + ': ' + doneOf(g));
  }
});

test('flight: Pell Homecoming - lift-off with the Autopilot ascent, the return burn, re-entry at Verda and a safe landing', () => {
  const g = S.buildScenario('pell-homecoming'), w = g.world, v = g.vessel, parts = v.parts.size;
  assert.ok(v.landed && v.engines.some(e => e.part.ignited), 'standing on a live engine');
  // the ascent program must use the engine that is already lit, not fire the next stage (which would drop it)
  const asc = fly(g, w, AP.ascentProgram(w, { targetAlt: 20000 }), { maxSim: 3000 });
  assert.ok(asc.done && !asc.failed, logOf(asc));
  assert.equal(v.parts.size, parts, 'nothing was staged away on the ground');
  assert.equal(v.stageIndex, 1);
  assert.ok(altPe(v, w.ut) > 8000, 'Pell orbit, periapsis ' + km(altPe(v, w.ut)));
  assert.equal(doneOf(g), 'up');
  const plan = AP.planReturnFromMoon(w, v, { periapsis: 35000 });
  assert.ok(plan && plan.dv < 500, 'return burn ' + (plan && plan.dv.toFixed(0)) + ' m/s');
  const burn = fly(g, w, AP.executeNode(w, v), { maxSim: 1e5 });
  assert.ok(burn.done && !burn.failed, logOf(burn));
  coast(g, w, () => v.body === SYSTEM.home);
  assert.equal(doneOf(g), 'up,verda');
  const pe = altPe(v, w.ut);
  assert.ok(pe > 15000 && pe < 60000, 'Verda periapsis ' + km(pe));
  assert.ok(v.deltaV > 250, 'spare after the return burn: ' + v.deltaV.toFixed(0) + ' m/s');
  coast(g, w, () => v.altitude < 90000);
  w.stage();                                                    // drop the lander stage before the air
  const r = comeHome(g, w, v);
  assert.ok(v.landed && !v.dead && r.lost === 0 && r.touch < 9, JSON.stringify(r));
  assert.deepEqual(v.crew, ['Juno']);
  assert.ok(r.maxTemp < 0.95 && r.ablator < 190, 'a real re-entry: ' + JSON.stringify(r));
  assert.ok(g.career.scenario.complete, doneOf(g));
});

test('flight: Ost Outpost - a Pip plants a flag, boards again, and the Ostrider reaches orbit', () => {
  const g = S.buildScenario('ost-outpost'), w = g.world, v = g.vessel;
  const pip = w.evaStart(v);
  assert.ok(pip && pip.landed, 'the Pip stands on the ground');
  S.checkScenario(g.career, w);
  AP.fly(w, null, { maxSim: 3, physWarp: 0 });
  assert.ok(Math.abs(S.groundClearance(pip)) < 0.5, 'the Pip is on the surface');
  assert.ok(w.plantFlag(pip, 'Ost Outpost'));
  S.checkScenario(g.career, w);
  assert.equal(doneOf(g), 'eva,flag');
  assert.ok(w.evaBoard(pip, v), 'boards again');
  w.switchTo(v);
  const asc = fly(g, w, AP.ascentProgram(w, { targetAlt: 7000 }), { maxSim: 3000 });
  assert.ok(asc.done && !asc.failed, logOf(asc));
  assert.ok(S.inStableOrbit(v, 'ost', 0, w.ut), 'orbit ' + km(altPe(v, w.ut)) + ' × ' + km(altAp(v, w.ut)));
  assert.deepEqual(v.crew.slice().sort(), ['Bram', 'Tilly']);
  assert.ok(g.career.scenario.complete, doneOf(g));
  assert.ok(v.deltaV > 500, 'left: ' + v.deltaV.toFixed(0));
});

test('flight: Tracks on Murk - the Pebble drives a kilometre in any direction without breaking or running flat', () => {
  for (const [heading, speed] of [[90, 9], [0, 12], [225, 9]]) {
    const g = S.buildScenario('murk-tracks'), w = g.world, v = g.vessel, parts = v.parts.size;
    AP.fly(w, null, { maxSim: 3, physWarp: 0 });
    assert.ok(Math.abs(S.groundClearance(v)) < 0.5 || v.wheelsOnGround >= 4, 'on its wheels');
    const d = fly(g, w, AP.roverDrive(w, v, { distance: 1020, speed, heading }), { dt: 1 / 30, physWarp: 0, maxSim: 900 });
    assert.ok(d.done && !d.failed, `heading ${heading}: ${logOf(d)}`);
    assert.equal(v.parts.size, parts, 'nothing broke');
    assert.ok(v.resources.elec.amount > 0.5 * v.resources.elec.max, 'charge left: ' + v.resources.elec.amount.toFixed(0));
    assert.ok(g.career.scenario.done.includes('far'), `heading ${heading}: ${doneOf(g)}`);
    if (heading === 90) assert.ok(g.career.scenario.complete, doneOf(g));
  }
});

test('flight: Pell Overland - the Pebble drives its kilometre in one sixth of home gravity, by cruise control and with the stick held forward', () => {
  const upright = v => new Vector3(0, 0, 1).applyQuaternion(v.q).dot(v.pos.clone().normalize());
  {
    const g = S.buildScenario('pell-overland'), w = g.world, v = g.vessel, parts = v.parts.size;
    assert.equal(v.body.id, 'pell');
    AP.fly(w, null, { maxSim: 3, physWarp: 0 });
    let low = 1;
    const d = fly(g, w, AP.roverDrive(w, v, { distance: 1020, speed: 8 }), { dt: 1 / 30, physWarp: 0, maxSim: 1500, onStep: () => { if (!v.landed) low = Math.min(low, upright(v)); } });
    assert.ok(d.done && !d.failed, logOf(d));
    assert.equal(v.parts.size, parts, 'nothing broke');
    assert.ok(low > 0.6, 'never near going over: ' + low.toFixed(2));
    assert.ok(v.resources.elec.amount > 0.3 * v.resources.elec.max, 'charge left: ' + v.resources.elec.amount.toFixed(0));
    assert.ok(g.career.scenario.complete, doneOf(g));
    console.log(`#   cruise control: 1 km in ${(w.ut - S.SCENARIO_UT).toFixed(0)} s, least uprightness ${low.toFixed(2)}`);
  }
  {
    // the way a player starts: brake off, W held, SAS as the scenario leaves it
    const g = S.buildScenario('pell-overland'), w = g.world, v = g.vessel, parts = v.parts.size;
    assert.ok(v.ctrl.sas, 'SAS is on at the start');
    v.ctrl.brake = false;
    let low = 1, top = 0;
    fly(g, w, null, { dt: 1 / 30, physWarp: 0, maxSim: 400, until: () => g.career.scenario.done.includes('far'), onStep: () => { v.ctrl.drive = 1; low = Math.min(low, upright(v)); top = Math.max(top, v.groundSpeed); } });
    assert.ok(g.career.scenario.done.includes('far'), 'reached 300 m: ' + doneOf(g));
    assert.ok(low > 0.5 && v.parts.size === parts, `flat out to 300 m: least uprightness ${low.toFixed(2)}, top ${top.toFixed(1)} m/s`);
    console.log(`#   stick forward: 300 m in ${(w.ut - S.SCENARIO_UT).toFixed(0)} s, top ${top.toFixed(1)} m/s, least uprightness ${low.toFixed(2)}`);
  }
});

test('vessel.getOrbit() without a time is safe: it uses the vessel\'s own clock and never poisons the cached orbit', () => {
  const g = S.buildScenario('morning-orbit'), w = g.world, v = g.vessel;
  const o0 = v.getOrbit();
  assert.ok(Number.isFinite(o0.periapsis) && Math.abs(o0.periapsis - v.body.radius - 95000) < 3000, 'a sane orbit: ' + km(o0.periapsis - v.body.radius));
  assert.ok(Number.isFinite(o0.epoch ?? o0.t0 ?? 0), 'with a finite epoch');
  AP.fly(w, null, { maxSim: 120, physWarp: 0 });
  for (const o of [v.getOrbit(), v.getOrbit(w.ut), v.getOrbit(undefined), v.getOrbit(NaN)]) {
    const s = o.stateAt(w.ut);
    assert.ok(s.r.distanceTo(v.pos) < 50, 'the orbit passes through the vessel now: ' + s.r.distanceTo(v.pos).toFixed(1) + ' m off');
    const later = o.stateAt(w.ut + 600);
    assert.ok(Number.isFinite(later.r.x) && Math.abs(later.r.length() - v.pos.length()) < 5000, 'and stays a 95 km circle ten minutes on');
  }
  // on rails (time warp) and back
  w.setWarp(99); for (let i = 0; i < 50; i++) w.step(0.1); w.setWarp(0); for (let i = 0; i < 5; i++) w.step(0.05);
  assert.ok(v.getOrbit().stateAt(w.ut).r.distanceTo(v.pos) < 50, 'still true after a time warp');
  // a landed vessel is not moved by it
  const h = S.buildScenario('pell-homecoming'), lv = h.vessel, p0 = lv.pos.clone();
  lv.getOrbit(); lv.getOrbit(undefined);
  assert.ok(lv.pos.distanceTo(p0) < 1e-6 && Math.abs(S.groundClearance(lv)) < 0.01, 'a landed vessel stays where it stands');
  AP.fly(h.world, null, { maxSim: 2, physWarp: 0 });
  lv.getOrbit();
  assert.ok(Math.abs(S.groundClearance(lv)) < 0.5 && !lv.dead, 'and is still on the ground after stepping');
});

test('flight: Rusk Arrival - a burn planned at the closest point captures the Wayfarer into orbit', () => {
  const g = S.buildScenario('rusk-arrival'), w = g.world, v = g.vessel, dv0 = v.deltaV;
  AP.planCircularize(w, v, 'periapsis');
  S.checkScenario(g.career, w);
  assert.equal(doneOf(g), 'node');
  const need = -v.nodes[0].dv.prograde;
  assert.ok(need > 300 && need < dv0 * 0.5, `capture burn ${need.toFixed(0)} m/s of ${dv0.toFixed(0)} aboard`);
  const burn = fly(g, w, AP.executeNode(w, v), { maxSim: 1e6 });
  assert.ok(burn.done && !burn.failed, logOf(burn));
  const o = v.getOrbit(w.ut);
  assert.ok(!o.hyper && o.e < 0.1 && S.inStableOrbit(v, 'rusk', 0, w.ut), `orbit ${km(altPe(v, w.ut))} × ${km(altAp(v, w.ut))}`);
  assert.ok(g.career.scenario.complete, doneOf(g));
  assert.ok(v.deltaV > 2500, 'left for Dray and the way home: ' + v.deltaV.toFixed(0));
});

test('flight: Fire and Silk - the capsule survives re-entry on its shield and lands under its parachute; without the parachute it does not', () => {
  const g = S.buildScenario('fire-and-silk'), w = g.world, v = g.vessel;
  const r = comeHome(g, w, v);
  assert.ok(v.landed && !v.dead && r.lost === 0, JSON.stringify(r));
  assert.ok(r.touch < 9, 'touchdown ' + r.touch);
  assert.ok(r.ablator < 185, 'the shield burned away ' + (200 - r.ablator).toFixed(0) + ' kg of ablator');
  assert.deepEqual(v.crew, ['Juno']);
  assert.ok(g.career.scenario.complete, doneOf(g));
  const t = w.ut - S.SCENARIO_UT;
  assert.ok(t > 120 && t < 1500, 'the whole descent takes ' + (t / 60).toFixed(1) + ' min');
  // the parachute is needed: left packed, the capsule is lost
  const g2 = S.buildScenario('fire-and-silk'), w2 = g2.world, v2 = g2.vessel;
  v2.ctrl.sasMode = 'srfRetrograde';
  let lost = 0; w2.on('crewLost', () => { lost++; });
  AP.fly(w2, null, { maxSim: 3000, until: () => v2.landed || v2.dead });
  assert.ok(v2.dead || lost > 0, 'no parachute, no landing');
  assert.ok(!g2.career.scenario.done.includes('home'));
});
