// Starwright career layer: progression, save data, tech tree, milestones, science and the Pip roster.
// PURE LOGIC - no DOM. Runs under Node. Depends on the part catalog and the contract board (js/core/contracts.js).
//
// Economy at a glance (see the balance notes in tests/unit/career.test.js):
//   - a first hop on starting parts earns ~9-18 science (enough for the 5-point node), reaching space ~13-34,
//     orbit-and-return ~35-50, a Pell flyby ~50-90 and a Pell landing with return ~250;
//   - starting funds cover 6-8 early launches with total losses; milestones and contracts keep the program going,
//     recovery returns up to 98 % of the hardware, and a program grant stops a career from ever dead-ending.
import { PARTS, PART_LIST } from './parts.js';
import { ContractBoard } from './contracts.js';
import { SYSTEM } from './bodies.js';

export const SAVE_KEY = 'starwright.save.v1';
export const SCENARIO_SAVE_KEY = 'starwright.scenario.v1';   // a scenario game (js/core/scenarios.js) has a slot of its own
export const BACKUP_KEY = 'starwright.save.corrupt';   // a save that could not be read is parked here, never deleted
export const SAVE_VERSION = 3;                          // 1: original · 2: contracts, Pip experience, grants · 3: facilities, biomes, lab bonus
export const HOME_BODY = 'verda';
export const START_FUNDS = 25000;
export const GRANT_FUNDS = 6000;                        // the program grant (safety net)
export const GRANT_REP_COST = 2;
export const MODES = ['career', 'science', 'sandbox'];

// ---------------------------------------------------------------------------------------------
// Tech tree
// ---------------------------------------------------------------------------------------------
const techDefs = [
  { id: 'start', name: 'Shed Rocketry', cost: 0, requires: [], x: 0, y: 2,
    desc: 'A capsule, a booster and a parachute. What could go wrong?' },
  { id: 'basic_rocketry', name: 'Bigger Bells', cost: 5, requires: ['start'], x: 1, y: 1,
    desc: 'Liquid engines that steer, and tanks tall enough to feed them.' },
  { id: 'survivability', name: 'Coming Home', cost: 15, requires: ['start'], x: 1, y: 3,
    desc: 'Shields, cells and gauges for crews who would like to be reused.' },
  { id: 'general_construction', name: 'Bolts and Brackets', cost: 15, requires: ['basic_rocketry'], x: 2, y: 0,
    desc: 'Side clamps and fins: build outward as well as upward.' },
  { id: 'propulsion', name: 'Second Wind', cost: 30, requires: ['basic_rocketry'], x: 2, y: 2,
    desc: 'Vacuum engines and longer boosters for the climb to orbit.' },
  { id: 'electrics', name: 'Bright Sparks', cost: 35, requires: ['survivability'], x: 2, y: 4,
    desc: 'Sunlight power, antennas and probes that fly themselves.' },
  { id: 'stability', name: 'Pointing True', cost: 45, requires: ['general_construction'], x: 3, y: 0,
    desc: 'Gyro rings and steering vanes keep the nose where you want it.' },
  { id: 'landing', name: 'Soft Touch', cost: 90, requires: ['survivability', 'propulsion'], x: 3, y: 3,
    desc: 'Legs, side parachutes and sample jars for arriving gently.' },
  { id: 'miniature', name: 'Small Wonders', cost: 90, requires: ['electrics'], x: 3, y: 4,
    desc: 'Everything again, but tiny.' },
  { id: 'heavy', name: 'Heavy Lifting', cost: 160, requires: ['propulsion', 'general_construction'], x: 4, y: 1,
    desc: 'Wide drums and the engine to shove them skyward.' },
  { id: 'command2', name: 'Room for Three', cost: 160, requires: ['landing'], x: 4, y: 3,
    desc: 'A bigger command module, with thrusters for delicate work.' },
  { id: 'advanced_propulsion', name: 'Long Burn', cost: 300, requires: ['heavy'], x: 5, y: 2,
    desc: 'A patient, glowing engine for the far worlds.' },
  // ---- second pass: the wider catalog (ids and layout from docs/PARTS_TECH.md) ----
  { id: 'aviation', name: 'Wings and Wheels', cost: 30, requires: ['basic_rocketry'], x: 2, y: -1,
    desc: 'Cockpits, wings, air-breathing engines and wheels that fold away: flying without leaving.' },
  { id: 'fuel_systems', name: 'Plumbing', cost: 60, requires: ['propulsion'], x: 3, y: 2,
    desc: 'Side tanks, fuel lines and little thrusters that bolt on wherever there is room.' },
  { id: 'aerodynamics', name: 'Slippery Shapes', cost: 60, requires: ['general_construction'], x: 3, y: 1,
    desc: 'Swept fins, air brakes and nose caps that persuade the air to step aside.' },
  { id: 'field_science', name: 'Field Kit', cost: 70, requires: ['electrics'], x: 3, y: 5,
    desc: 'Instruments that weigh the ground, listen to it and sniff the air above it.' },
  { id: 'advanced_construction', name: 'Girders and Manifolds', cost: 120, requires: ['general_construction', 'stability'], x: 4, y: 0,
    desc: 'Trusses, hull plates and couplers that turn one stack into several.' },
  { id: 'advanced_electrics', name: 'Bigger Sparks', cost: 120, requires: ['electrics'], x: 4, y: 4,
    desc: 'Wide solar wings, deep cells and a fuel cell for the long night.' },
  { id: 'deep_comms', name: 'Long Ears', cost: 140, requires: ['electrics'], x: 4, y: 5,
    desc: 'Dishes that can still hear home from the far side of the sun.' },
  { id: 'ground_ops', name: 'Tyre Tracks', cost: 140, requires: ['landing', 'electrics'], x: 4, y: 6,
    desc: 'A rover chassis, powered wheels and a ladder long enough to reach them.' },
  { id: 'orbital_assembly', name: 'Meeting in Orbit', cost: 220, requires: ['command2'], x: 5, y: 3,
    desc: 'Big latch rings, strong thrusters and the tanks to feed them: build it up there.' },
  { id: 'supersonic_flight', name: 'Faster Than Sound', cost: 260, requires: ['aviation', 'heavy'], x: 5, y: -1,
    desc: 'Delta wings, a ramjet and a flight deck for four. The boom arrives later.' },
  { id: 'advanced_science', name: 'Orbital Workshop', cost: 280, requires: ['field_science', 'command2'], x: 5, y: 5,
    desc: 'A crewed laboratory and instruments that study a world without touching it.' },
  { id: 'very_heavy', name: 'Colossal Lifting', cost: 450, requires: ['heavy', 'advanced_construction'], x: 6, y: 1,
    desc: 'The widest drums, the loudest engines and a pod with room for five.' },
  { id: 'ion_propulsion', name: 'Quiet Push', cost: 500, requires: ['advanced_electrics', 'miniature'], x: 6, y: 4,
    desc: 'Thrust you can barely feel, for as long as the sun shines.' },
  { id: 'high_power', name: 'Power to Spare', cost: 450, requires: ['advanced_electrics'], x: 6, y: 5,
    desc: 'Grand arrays and a warm little cell that never runs down.' },
  { id: 'nuclear_propulsion', name: 'Atomic Age', cost: 800, requires: ['advanced_propulsion'], x: 7, y: 2,
    desc: 'A furnace on the end of a rocket. Stand well back, then go a very long way.' },
];
// Any tech id the catalog uses that has no hand-written node still gets one (so a new part can never be orphaned):
// it hangs off the most expensive node and is flagged `auto` for the tree screen.
for (const def of Object.values(PARTS)) {
  if (def.hidden || !def.tech || techDefs.some(n => n.id === def.tech)) continue;
  const last = techDefs.reduce((a, b) => (b.cost > a.cost ? b : a));
  techDefs.push({ id: def.tech, name: def.tech.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), cost: Math.round(last.cost * 1.25 / 10) * 10,
    requires: [last.id], x: last.x + 1, y: last.y, desc: 'Newly catalogued hardware.', auto: true });
}
/** Tier of a node = its column in the tree (0 = start). The tree screen lays nodes out at (x, y); y runs −1..6. */
export const TECH_BOUNDS = Object.freeze({
  xMin: Math.min(...techDefs.map(n => n.x)), xMax: Math.max(...techDefs.map(n => n.x)),
  yMin: Math.min(...techDefs.map(n => n.y)), yMax: Math.max(...techDefs.map(n => n.y)),
});
export const TECH_TREE = techDefs.map(n => Object.freeze({
  ...n, tier: n.x,
  requires: Object.freeze([...n.requires]),
  parts: Object.freeze(Object.values(PARTS).filter(p => p.tech === n.id && !p.hidden).map(p => p.id)),
}));
const TECH_BY_ID = Object.fromEntries(TECH_TREE.map(n => [n.id, n]));
export function techNode(id) { return TECH_BY_ID[id] || null; }

// ---------------------------------------------------------------------------------------------
// Science
// ---------------------------------------------------------------------------------------------
export const SITUATIONS = ['landed', 'splashed', 'flyingLow', 'flyingHigh', 'spaceLow', 'spaceHigh'];
export const SITUATION_NAMES = {
  landed: 'landed on', splashed: 'splashed down on', flyingLow: 'flying low over', flyingHigh: 'flying high over',
  spaceLow: 'in space near', spaceHigh: 'in space high above',
};
export const SITUATION_MULT = { landed: 1.5, splashed: 1.2, flyingLow: 0.7, flyingHigh: 0.9, spaceLow: 1.0, spaceHigh: 1.4 };
export const BODY_SCI_MULT = { verda: 1, pell: 4, ost: 5, rusk: 6, cindra: 7, thal: 9, tiv: 9 };
for (const b of SYSTEM.bodies) if (!(b.id in BODY_SCI_MULT) && Number.isFinite(b.sciMult)) BODY_SCI_MULT[b.id] = b.sciMult;
// Results taken on or near the ground belong to the biome they were taken in: each biome of a body has its own pool.
export const BIOME_SITUATIONS = ['landed', 'splashed', 'flyingLow'];
export const BIOME_STEP = 0.12;               // each later biome in a body's list is worth this much more
/** Science multiplier of a biome (id or {id}) of a body: 1 for the first (commonest), rising by BIOME_STEP; a biome's own `sciMult` wins. */
export function biomeSciMult(body, biome) {
  const b = typeof body === 'string' ? SYSTEM.byId[body] : body;
  const id = idOf(biome);
  if (!b || !Array.isArray(b.biomes) || id == null) return 1;
  const i = b.biomes.findIndex(x => x.id === id);
  if (i < 0) return 1;
  if (Number.isFinite(b.biomes[i].sciMult)) return b.biomes[i].sciMult;
  return Math.round((1 + BIOME_STEP * i) * 100) / 100;
}
// Verda's own ground and seas are old news: results taken landed or splashed on the home world are worth this
// share of the usual value, so the launch pad is a place to practise, not a science mine.
export const HOME_SURFACE_MULT = 0.4;
export const SCIENCE_REPEAT_FRACTION = 0.4;   // each run earns this share of what is still left for its key
export const SCIENCE_MIN_REMAINING = 0.1;     // below this a key counts as exhausted

export const EXPERIMENTS = Object.freeze({
  crew_report: { name: 'Crew Report', base: 5, situations: [...SITUATIONS], needsCrew: true,
    desc: 'The crew describe what they see out of the window.' },
  temperature: { name: 'Temperature Reading', base: 4, situations: [...SITUATIONS],
    desc: 'How hot or cold it is, to one decimal place.' },
  pressure: { name: 'Pressure Reading', base: 6, situations: [...SITUATIONS],
    desc: 'How much air there is. Often: none.' },
  microbe: { name: 'Microbe Study', base: 10, situations: ['landed', 'splashed', 'spaceLow', 'spaceHigh'],
    desc: 'Pond life observed somewhere it never expected to be.' },
  eva_report: { name: 'Spacewalk Report', base: 8, situations: ['landed', 'splashed', 'flyingLow', 'spaceLow', 'spaceHigh'],
    eva: true, needsCrew: true, desc: 'A Pip steps outside and reports back.' },
  surface_sample: { name: 'Surface Sample', base: 15, situations: ['landed', 'splashed'], eva: true, needsCrew: true,
    desc: 'A scoop of whatever is underfoot.' },
  // ---- second pass ----
  gravity: { name: 'Gravity Survey', base: 12, situations: ['landed', 'spaceLow', 'spaceHigh'],
    desc: 'A weight on a spring, read very carefully.' },
  seismic: { name: 'Seismic Reading', base: 14, situations: ['landed'],
    desc: 'The ground is asked to hold still while it is listened to.' },
  atmosphere: { name: 'Atmosphere Analysis', base: 12, situations: ['flyingLow', 'flyingHigh', 'landed'], needsAtmo: true,
    desc: 'A sip of the local air, itemised.' },
  magnetic: { name: 'Magnetic Survey', base: 10, situations: ['spaceLow', 'spaceHigh'],
    desc: 'A needle on a long boom, far from anything that might confuse it.' },
  survey: { name: 'Orbital Survey', base: 16, situations: ['spaceLow', 'spaceHigh'],
    desc: 'A patient look at the ground from where the ground cannot object.' },
  lab_study: { name: 'Laboratory Study', base: 25, situations: ['landed', 'splashed', 'spaceLow', 'spaceHigh'], needsCrew: true,
    desc: 'Two Pips, a bench, and a week of arguing about the results.' },
});
/** May this experiment be run at this body at all? (the atmosphere analyser needs air) */
export function experimentAllowed(experimentId, body) {
  const exp = EXPERIMENTS[experimentId];
  if (!exp) return false;
  if (!exp.needsAtmo) return true;
  const b = typeof body === 'string' ? SYSTEM.byId[body] : body;
  return !!(b && b.atmo);
}

const round2 = x => Math.round(x * 100) / 100;
function idOf(b) { return b == null ? null : (typeof b === 'string' ? b : (b.id ?? null)); }

// Science multiplier of a body: its own `sciMult` when a Body object is given, else the fallback table.
export function bodySciMult(body) {
  if (body && typeof body === 'object' && Number.isFinite(body.sciMult)) return body.sciMult;
  return BODY_SCI_MULT[idOf(body)] ?? 1;
}
export function scienceKey(experimentId, body, situation, biome = null) {
  const b = idOf(biome);
  return `${experimentId}@${idOf(body)}:${situation}` + (b && BIOME_SITUATIONS.includes(situation) ? ':' + b : '');
}

function vesselAltitude(v) {
  if (Number.isFinite(v.altitude)) return v.altitude;
  if (v.pos && typeof v.pos.length === 'function' && v.body) return v.pos.length() - (v.body.radius || 0);
  return 0;
}

// 'landed' | 'splashed' | 'flyingLow' | 'flyingHigh' | 'spaceLow' | 'spaceHigh'
export function situationOf(vessel) {
  if (!vessel) return 'landed';
  if (vessel.splashed || vessel.situation === 'splashed') return 'splashed';
  if (vessel.landed || vessel.situation === 'landed' || vessel.situation === 'prelaunch') return 'landed';
  const body = vessel.body || {};
  const alt = vesselAltitude(vessel);
  const atmoH = body.atmo && body.atmo.height > 0 ? body.atmo.height : 0;
  if (atmoH && alt < atmoH) return alt < atmoH * 0.25 ? 'flyingLow' : 'flyingHigh';
  const border = Number.isFinite(body.spaceBorder) ? body.spaceBorder : (body.radius || 0) * 0.4;
  return alt < border ? 'spaceLow' : 'spaceHigh';
}

// ---------------------------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------------------------
const HAND_MILESTONES = [
  { id: 'first_launch', title: 'Light the Fuse', desc: 'Lift a vessel off the pad.', funds: 1500, science: 2, rep: 1 },
  { id: 'alt_10km', title: 'Above the Weather', desc: 'Climb past 10 km over Verda.', funds: 2000, science: 3, rep: 1 },
  { id: 'reach_space', title: 'The Sky Goes Dark', desc: 'Leave Verda\'s atmosphere and reach space.', funds: 4000, science: 6, rep: 3 },
  { id: 'orbit_verda', title: 'Falling Without Landing', desc: 'Settle into a stable orbit of Verda.', funds: 8000, science: 12, rep: 5 },
  { id: 'crew_return', title: 'Home in One Piece', desc: 'Bring a crewed vessel back from space and set it down safely on Verda.', funds: 6000, science: 10, rep: 6 },
  { id: 'eva_space', title: 'Stepping Out', desc: 'Send a Pip outside the hatch while in space.', funds: 3000, science: 8, rep: 4 },
  { id: 'flag_verda', title: 'Practice Flag', desc: 'Plant a flag on Verda.', funds: 1000, science: 2, rep: 1 },
  { id: 'pell_flyby', title: 'Hello, Pell', desc: 'Enter Pell\'s sphere of influence.', funds: 12000, science: 15, rep: 6 },
  { id: 'pell_orbit', title: 'Circling the Grey', desc: 'Achieve orbit around Pell.', funds: 15000, science: 20, rep: 8 },
  { id: 'pell_landing', title: 'Dust on the Boots', desc: 'Touch down on Pell.', funds: 25000, science: 30, rep: 12 },
  { id: 'pell_return', title: 'There and Back', desc: 'Land on Verda in a vessel that has stood on Pell.', funds: 35000, science: 40, rep: 15 },
  { id: 'ost_flyby', title: 'The Little Ice Moon', desc: 'Enter Ost\'s sphere of influence.', funds: 15000, science: 20, rep: 8 },
  { id: 'ost_landing', title: 'Skating Rink', desc: 'Touch down on Ost.', funds: 30000, science: 35, rep: 12 },
  { id: 'escape_verda', title: 'Cutting the String', desc: 'Leave Verda\'s sphere of influence for open sunlight.', funds: 20000, science: 25, rep: 10 },
  { id: 'rusk_flyby', title: 'Red Neighbour', desc: 'Enter Rusk\'s sphere of influence.', funds: 40000, science: 50, rep: 15 },
  { id: 'rusk_orbit', title: 'Rust Belt', desc: 'Achieve orbit around Rusk.', funds: 50000, science: 60, rep: 18 },
  { id: 'rusk_landing', title: 'Red Dust Rising', desc: 'Touch down on Rusk.', funds: 80000, science: 90, rep: 25 },
  { id: 'cindra_flyby', title: 'Close to the Fire', desc: 'Enter Cindra\'s sphere of influence.', funds: 55000, science: 70, rep: 20 },
  { id: 'thal_flyby', title: 'The Banded Giant', desc: 'Enter Thal\'s sphere of influence.', funds: 80000, science: 100, rep: 28 },
  { id: 'tiv_landing', title: 'Sulfur Shores', desc: 'Touch down on Tiv, moon of Thal.', funds: 120000, science: 150, rep: 40 },
];
// Every world in SYSTEM gets the full set (flyby, orbit, landing, return, flag); the hand-written ones above keep
// their ids, titles and rewards, the rest are generated here with rewards that grow with the body's science value.
export const MILESTONE_KINDS = ['flyby', 'orbit', 'landing', 'return', 'flag'];
const FLYBY_MS = {}, ORBIT_MS = {}, LAND_MS = {}, RETURN_MS = {}, FLAG_MS = {};
const MS_MAPS = { flyby: FLYBY_MS, orbit: ORBIT_MS, landing: LAND_MS, return: RETURN_MS, flag: FLAG_MS };
const MS_SPECIAL = { 'orbit:verda': 'orbit_verda', 'flag:verda': 'flag_verda' };
const MS_TEXT = {
  flyby: [n => `First Look at ${n}`, (n, w) => `Enter the sphere of influence of ${n}${w}.`, 1],
  orbit: [n => `Rings Around ${n}`, (n, w) => `Achieve orbit around ${n}${w}.`, 1.25],
  landing: [n => `Footprints on ${n}`, (n, w) => `Touch down on ${n}${w}.`, 2],
  return: [n => `Home From ${n}`, n => `Land on Verda in a vessel that has stood on ${n}.`, 2.8],
  flag: [n => `Colours Over ${n}`, (n, w) => `Plant a flag on ${n}${w}.`, 0.6],
};
function buildMilestones() {
  const list = HAND_MILESTONES.map(m => ({ ...m }));
  const byId = new Map(list.map(m => [m.id, m]));
  for (const b of SYSTEM.bodies) {
    if (b.type === 'star') continue;
    const home = b.id === HOME_BODY;
    const where = b.parent && b.parent.type !== 'star' ? `, moon of ${b.parent.name}` : '';
    const m = bodySciMult(b);
    for (const kind of MILESTONE_KINDS) {
      if (home && kind !== 'orbit' && kind !== 'flag') continue;            // the home world has its own early milestones
      if (b.gas && kind !== 'flyby' && kind !== 'orbit') continue;          // nothing to stand on
      const id = MS_SPECIAL[kind + ':' + b.id] || `${b.id}_${kind}`;
      MS_MAPS[kind][b.id] = id;
      const old = byId.get(id);
      if (old) { old.bodyId = b.id; old.kind = kind; continue; }
      const [title, desc, k] = MS_TEXT[kind];
      const ms = { id, title: title(b.name), desc: desc(b.name, where), funds: Math.round(1000 * m * m * k / 500) * 500,
        science: Math.round(1.25 * m * m * k), rep: Math.max(1, Math.round(3 * m * Math.sqrt(k))), bodyId: b.id, kind, generated: true };
      list.push(ms); byId.set(id, ms);
    }
  }
  return list;
}
export const MILESTONES = Object.freeze(buildMilestones().map(m => Object.freeze(m)));
const MILESTONE_BY_ID = Object.fromEntries(MILESTONES.map(m => [m.id, m]));
export function milestoneDef(id) { return MILESTONE_BY_ID[id] || null; }
/** Milestone id for a kind ('flyby' | 'orbit' | 'landing' | 'return' | 'flag') at a body, or null. */
export function milestoneFor(kind, body) { return (MS_MAPS[kind] && MS_MAPS[kind][idOf(body)]) || null; }
/** The milestones of one body, in MILESTONE_KINDS order. */
export function milestonesOf(body) { return MILESTONES.filter(m => m.bodyId === idOf(body)); }
// ---------------------------------------------------------------------------------------------
// The flight program: one fixed chain of milestone missions, so there is always a next goal
// ---------------------------------------------------------------------------------------------
// Built on MILESTONES (no parallel reward system): a step is a milestone id with a chapter and a "how" line.
// The chain is tracked in every game mode; what a step pays depends on the mode (see Career.programRewards).
const PROGRAM_HOW = {
  first_launch: 'Any rocket will do: a capsule on a solid booster, full throttle, then Space.',
  alt_10km: 'Fly straight up. One Ember booster under an Acorn capsule gets there with room to spare.',
  reach_space: `Space starts where the air ends, ${Math.round(((SYSTEM.byId[HOME_BODY] || {}).atmo || { height: 72000 }).height / 1000)} km up. Two Ember boosters, one above the other with a Stack Separator between, coast up to it; a liquid engine gets there with control.`,
  orbit_verda: 'Height is not enough: tip east early and build about 2,300 m/s of sideways speed, then raise the low point above the air.',
  crew_return: 'Burn backwards to drop the low point into the air, keep the heat shield forward, parachute below 5 km.',
  eva_space: 'In orbit, open Crew and send a Pip outside. F boards again.',
  escape_verda: 'Keep burning forward until the path leaves Verda\'s sphere of influence.',
};
const PROGRAM_HOW_KIND = {
  flyby: n => `Plan a transfer in the map so your path enters the sphere of influence of ${n}.`,
  orbit: n => `At the closest point to ${n}, burn backwards until the path closes into an orbit.`,
  landing: n => `Come down slowly on ${n}: legs out, kill the sideways speed first, then the fall.`,
  return: n => `Lift off from ${n}, come home to Verda and land the same vessel.`,
};
function buildProgram() {
  const steps = [];
  const add = (id, chapter) => { const m = MILESTONE_BY_ID[id]; if (m && !steps.some(s => s.id === id)) steps.push({ id, chapter }); };
  for (const id of ['first_launch', 'alt_10km', 'reach_space', 'orbit_verda', 'crew_return', 'eva_space']) add(id, 'First flights');
  const world = (b, chapter) => { for (const kind of ['flyby', 'orbit', 'landing', 'return']) add(MS_MAPS[kind][b.id], chapter); };
  const home = SYSTEM.byId[HOME_BODY];
  for (const moon of (home ? home.children : [])) world(moon, `The moon ${moon.name}`);
  add('escape_verda', 'Leaving home');
  // the other worlds, nearest in effort first (science value grows with how hard a world is to reach); moons follow their planet
  const planets = SYSTEM.bodies.filter(b => b.type === 'planet' && b.id !== HOME_BODY).sort((a, b) => bodySciMult(a) - bodySciMult(b));
  for (const pl of planets) {
    world(pl, pl.name);
    for (const moon of [...pl.children].sort((a, b) => bodySciMult(a) - bodySciMult(b))) world(moon, `${moon.name}, moon of ${pl.name}`);
  }
  return steps.map((s, index) => {
    const m = MILESTONE_BY_ID[s.id], body = m.bodyId ? SYSTEM.byId[m.bodyId] : null;
    const how = PROGRAM_HOW[s.id] || (body && PROGRAM_HOW_KIND[m.kind] ? PROGRAM_HOW_KIND[m.kind](body.name) : '');
    return Object.freeze({ index, id: s.id, chapter: s.chapter, how, title: m.title, desc: m.desc, funds: m.funds, science: m.science, rep: m.rep, bodyId: m.bodyId || null, kind: m.kind || null });
  });
}
/** The flight program: ordered milestone missions [{index, id, chapter, how, title, desc, funds, science, rep, bodyId, kind}]. */
export const PROGRAM = Object.freeze(buildProgram());
const PROGRAM_BY_ID = Object.fromEntries(PROGRAM.map(s => [s.id, s]));
export function programStep(id) { return PROGRAM_BY_ID[id] || null; }
/**
 * Live progress of a program step for the vessel being flown: { frac: 0..1, text } or null when the step has no
 * gauge (it is simply done or not). Pure: reads altitude / orbit numbers the vessel already carries.
 */
export function programProgress(id, vessel, ut = 0) {
  if (!vessel || !PROGRAM_BY_ID[id]) return null;
  const body = vessel.body || null, bodyId = idOf(body);
  const alt = vesselAltitude(vessel);
  const kmText = m => (m >= 100000 ? Math.round(m / 1000).toLocaleString('en-US') : (Math.round(m / 100) / 10).toLocaleString('en-US')) + ' km';
  const clamp01 = x => Math.max(0, Math.min(1, x));
  if (id === 'alt_10km') return bodyId === HOME_BODY ? { frac: clamp01(alt / 10000), text: `${kmText(Math.max(0, alt))} of 10 km` } : null;
  if (id === 'reach_space') {
    const top = body && body.atmo && Number.isFinite(body.atmo.height) ? body.atmo.height : 72000;
    return bodyId === HOME_BODY ? { frac: clamp01(alt / top), text: `${kmText(Math.max(0, alt))} of ${kmText(top)}` } : null;
  }
  const step = PROGRAM_BY_ID[id];
  if (step.kind === 'orbit' && step.bodyId === bodyId) {
    const top = body && body.atmo && Number.isFinite(body.atmo.height) ? body.atmo.height : 0;
    let o = null;
    try { o = typeof vessel.getOrbit === 'function' ? vessel.getOrbit(Number.isFinite(ut) ? ut : 0) : null; } catch { o = null; }
    if (!o) o = vessel.orbit || null;
    const pe = o && Number.isFinite(o.periapsis) && body ? o.periapsis - (body.radius || 0) : null;
    if (pe == null) return { frac: 0, text: 'no orbit yet' };
    const need = top > 0 ? top : 1000;
    return { frac: clamp01(pe / need), text: `low point ${pe < 0 ? 'below ground' : kmText(pe)}, needs ${top > 0 ? 'above ' + kmText(top) : 'to clear the ground'}` };
  }
  return null;
}
const HOME_MOONS = SYSTEM.byId[HOME_BODY] ? SYSTEM.byId[HOME_BODY].children.map(c => c.id) : ['pell', 'ost'];

// ---------------------------------------------------------------------------------------------
// Facilities (career mode): each has levels 1..3; upgrades cost funds and lift a limit. Science and sandbox games
// run with everything at the top level. The limits are checked by Career.checkLaunch(); nothing in the simulation
// depends on them.
// ---------------------------------------------------------------------------------------------
export const FACILITY_MAX = 3;
export const FACILITIES = Object.freeze({
  // Balance (round 2): level 1 launches every stock design up to the moon landers (Pell Runner: 51 t, 26 parts);
  // one pad upgrade carries the heavy interplanetary stacks (Farwind: 244 t); the top level has no limit.
  pad: { name: 'Launch Pad', desc: 'How heavy a vessel the pad will bear.', costs: [0, 30000, 150000],
    limit: 'maxMass', values: [60, 250, Infinity], unit: 't' },
  hangar: { name: 'Assembly Hangar', desc: 'How many parts a design may have.', costs: [0, 25000, 120000],
    limit: 'maxParts', values: [45, 120, Infinity], unit: 'parts' },
  runway: { name: 'Runway', desc: 'How heavy an aircraft the runway will bear.', costs: [0, 25000, 90000],
    limit: 'maxRunwayMass', values: [12, 45, Infinity], unit: 't' },
  tracking: { name: 'Tracking Station', desc: 'How far away a vessel can still be heard without its own dish.', costs: [0, 30000, 120000],
    limit: 'commRange', values: [6e7, 3e10, 2e11], unit: 'm' },
  lab: { name: 'Research Wing', desc: 'A bonus on all science banked.', costs: [0, 45000, 160000],
    limit: 'scienceBonus', values: [0, 0.05, 0.12], unit: '' },
  crew: { name: 'Crew Quarters', desc: 'How many Pips the program can employ.', costs: [0, 20000, 80000],
    limit: 'maxCrew', values: [6, 12, 24], unit: 'Pips' },
});
export const FACILITY_IDS = Object.keys(FACILITIES);

// Is this body outside the home planet's sphere of influence (i.e. not home and not one of its moons)?
function outsideHomeSystem(body) {
  const id = idOf(body);
  if (!id || id === HOME_BODY) return false;
  if (body && typeof body === 'object' && body.parent !== undefined) return idOf(body.parent) !== HOME_BODY;
  return !HOME_MOONS.includes(id);
}

// ---------------------------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------------------------
export const TRAITS = ['pilot', 'engineer', 'scientist'];
export const STARTING_CREW = [
  { name: 'Juno', trait: 'pilot' }, { name: 'Bram', trait: 'engineer' },
  { name: 'Tilly', trait: 'scientist' }, { name: 'Oskar', trait: 'pilot' },
];
export const NAME_POOL = [
  'Wren', 'Fenn', 'Mabel', 'Odo', 'Pim', 'Zadie', 'Corin', 'Lumi', 'Tavish', 'Nell',
  'Ravi', 'Suki', 'Brisa', 'Dov', 'Hattie', 'Ignas', 'Kiko', 'Lark', 'Milo', 'Noor',
  'Orla', 'Pax', 'Quill', 'Rosa', 'Soren', 'Thea', 'Ulli', 'Vesper', 'Wim', 'Yara', 'Zeb',
];
const SUFFIXES = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

// Experience. A Pip earns XP when a flight is recovered: 1 for flying at all, +1 for space, +2 for the first orbit of
// each world, +3 for each other world visited, +5 for each landing away from Verda. Stars come from total XP.
export const XP_STARS = [2, 6, 12, 20, 32];           // XP needed for 1..5 stars
export const MAX_STARS = XP_STARS.length;
export function pipStars(pipOrXp) {
  const xp = typeof pipOrXp === 'number' ? pipOrXp : ((pipOrXp && pipOrXp.xp) || 0);
  let n = 0;
  while (n < XP_STARS.length && xp >= XP_STARS[n]) n++;
  return n;
}
// What each star is worth (all applied inside Career, see creditScience / creditRecovery).
export const SCIENTIST_BONUS = 0.10;   // +10 % science per star of the best scientist aboard
export const ENGINEER_BONUS = 0.02;    // +2 % recovered parts value per star of the best engineer aboard (never above 100 %)
export const PILOT_BONUS = 0.10;       // the best pilot's stars shrink the recovery distance by 10 % each (a tidier landing)
export const PIP_NAME_MAX = 16;

/** XP and deeds a flight is worth, from its flight-log entry. → {xp, deeds: ['space', 'orbit:verda', 'visit:pell', 'land:pell']} */
export function flightExperience(log) {
  const deeds = [];
  let xp = 1;
  if (!log) return { xp, deeds };
  if (log.reachedSpace) { xp += 1; deeds.push('space'); }
  for (const b of log.orbited || []) { xp += 2; deeds.push('orbit:' + b); }
  for (const b of log.visited || []) if (b !== HOME_BODY) { xp += 3; deeds.push('visit:' + b); }
  for (const b of log.landedOn || []) if (b !== HOME_BODY) { xp += 5; deeds.push('land:' + b); }
  return { xp, deeds };
}
const newPip = (name, trait) => ({ name, status: 'available', flights: 0, trait, xp: 0, deeds: [] });

// Crew names aboard a vessel (works with the Vessel parts Map, a plain array, or a `crew` list).
export function crewOf(vessel) {
  if (!vessel) return [];
  if (Array.isArray(vessel.crew)) return [...vessel.crew];
  const out = [];
  const parts = vessel.parts instanceof Map ? vessel.parts.values() : (Array.isArray(vessel.parts) ? vessel.parts : []);
  for (const p of parts) if (p && !p.destroyed && Array.isArray(p.crew)) out.push(...p.crew);
  if (!out.length && vessel.type === 'eva') out.push(vessel.name || 'Pip');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------------------------
export const RECOVERY_MAX = 0.98, RECOVERY_MIN = 0.10, RECOVERY_FAR = 1.5e6;   // metres to reach the minimum
export function recoveryFraction(distanceFromPadMeters = 0) {
  const d = Number.isFinite(distanceFromPadMeters) ? Math.max(distanceFromPadMeters, 0) : RECOVERY_FAR;
  const k = Math.min(d / RECOVERY_FAR, 1);
  return RECOVERY_MAX + (RECOVERY_MIN - RECOVERY_MAX) * k;
}
export function recoveryValue(partsCost, distanceFromPadMeters = 0) {
  return Math.round(Math.max(Number(partsCost) || 0, 0) * recoveryFraction(distanceFromPadMeters));
}
export function launchCost(craft) {
  if (!craft) return 0;
  if (typeof craft.cost === 'function') return craft.cost();
  if (Number.isFinite(craft.cost)) return craft.cost;
  if (Array.isArray(craft.parts)) return craft.parts.reduce((s, p) => s + (PARTS[p.type]?.cost || 0), 0);
  return 0;
}

export const DEFAULT_SETTINGS = Object.freeze({ musicVolume: 0.5, sfxVolume: 0.8, invertPitch: false, showHints: true });

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Career
// ---------------------------------------------------------------------------------------------
export class Career {
  constructor(mode = 'career') {
    if (!MODES.includes(mode)) throw new Error('Unknown game mode ' + mode);
    this.mode = mode;
    this.funds = mode === 'career' ? START_FUNDS : 0;
    this.science = 0;
    this.reputation = 0;
    this.ut = 0;
    this.tech = new Set(mode === 'sandbox' ? TECH_TREE.map(n => n.id) : ['start']);
    this.milestones = new Set();
    this.roster = STARTING_CREW.map(c => newPip(c.name, c.trait));
    this.scienceLog = {};
    this.crafts = {};
    this.flightState = null;
    this.flightLog = {};            // per vessel id: { reachedSpace, landedOn: [bodyIds], visited: [bodyIds], orbited: [bodyIds] }
    this.settings = { ...DEFAULT_SETTINGS };
    this.grants = 0;                // program grants taken so far
    this.scenario = null;           // set for a scenario game: { id, name, done: [objective ids], ... } (js/core/scenarios.js)
    this.facilities = Object.fromEntries(FACILITY_IDS.map(id => [id, mode === 'career' ? 1 : FACILITY_MAX]));
    this.contracts = new ContractBoard(this);
    this._bonusCrew = null;         // crew of the vessel being recovered right now (see the 'recovered' event)
  }

  // `seed` fixes the contract generator (tests); a real new game draws one so every program gets its own board.
  static newGame(mode = 'career', { seed } = {}) {
    const c = new Career(mode);
    c.contracts.seed = (Number.isFinite(seed) ? seed : Math.floor(Math.random() * 4294967296)) >>> 0;
    c.contracts.refresh();
    return c;
  }

  // ---- persistence ----
  toJSON() {
    return {
      version: SAVE_VERSION, mode: this.mode, funds: this.funds, science: this.science, reputation: this.reputation,
      ut: this.ut, tech: [...this.tech], milestones: [...this.milestones],
      roster: this.roster.map(c => ({ ...c })), scienceLog: { ...this.scienceLog }, crafts: this.crafts,
      flightState: this.flightState, flightLog: this.flightLog, settings: { ...this.settings },
      grants: this.grants, facilities: { ...this.facilities }, contracts: this.contracts.toJSON(),
      ...(this.scenario ? { scenario: JSON.parse(JSON.stringify(this.scenario)) } : {}),
    };
  }

  /**
   * Bring save data from any older version up to SAVE_VERSION. Pure: returns a new object, never throws on a
   * plain object. v1 → v2: adds the contract board (generated fresh on load), Pip experience and the grant counter.
   * v2 → v3: adds facility levels. A program that predates facilities never had their limits, so it keeps every
   * building at the top level (nothing it could do before is taken away); tech, science, milestones, roster,
   * saved designs, the flight in progress and the contract board are carried over untouched.
   */
  static migrate(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Bad save data');
    const out = { ...o };
    const from = Number.isFinite(out.version) ? out.version : 1;
    if (from < 2) {
      out.contracts = out.contracts ?? null;
      out.grants = out.grants | 0;
      if (Array.isArray(out.roster)) out.roster = out.roster.map(r => (r && typeof r === 'object' ? { xp: 0, deeds: [], ...r } : r));
    }
    if (from < 3) {
      if (!out.facilities || typeof out.facilities !== 'object') out.facilities = Object.fromEntries(FACILITY_IDS.map(id => [id, FACILITY_MAX]));
    }
    out.version = SAVE_VERSION;
    out.migratedFrom = from < SAVE_VERSION ? from : undefined;
    return out;
  }

  static fromJSON(data) {
    const o = Career.migrate(data);
    const c = new Career(MODES.includes(o.mode) ? o.mode : 'career');
    if (Number.isFinite(o.funds)) c.funds = o.funds;
    if (Number.isFinite(o.science)) c.science = o.science;
    if (Number.isFinite(o.reputation)) c.reputation = o.reputation;
    if (Number.isFinite(o.ut)) c.ut = o.ut;
    if (Array.isArray(o.tech)) for (const id of o.tech) if (TECH_BY_ID[id]) c.tech.add(id);
    if (Array.isArray(o.milestones)) c.milestones = new Set(o.milestones.filter(id => MILESTONE_BY_ID[id]));
    if (Array.isArray(o.roster) && o.roster.length) {
      c.roster = o.roster.filter(r => r && r.name).map(r => ({
        name: String(r.name), status: ['available', 'assigned', 'away', 'lost'].includes(r.status) ? r.status : 'available',
        flights: r.flights | 0, trait: TRAITS.includes(r.trait) ? r.trait : 'pilot',
        xp: Number.isFinite(r.xp) && r.xp > 0 ? r.xp : 0,
        deeds: Array.isArray(r.deeds) ? r.deeds.filter(d => typeof d === 'string') : [],
        ...(r.status === 'lost' ? { lostAt: Number.isFinite(r.lostAt) ? r.lostAt : null, lostWhere: typeof r.lostWhere === 'string' ? r.lostWhere : null,
          lostVessel: typeof r.lostVessel === 'string' ? r.lostVessel : null } : {}),
      }));
    }
    if (o.scienceLog && typeof o.scienceLog === 'object') c.scienceLog = { ...o.scienceLog };
    if (o.crafts && typeof o.crafts === 'object') c.crafts = { ...o.crafts };
    c.flightState = o.flightState ?? null;
    if (o.flightLog && typeof o.flightLog === 'object') c.flightLog = JSON.parse(JSON.stringify(o.flightLog));
    c.settings = { ...DEFAULT_SETTINGS, ...(o.settings && typeof o.settings === 'object' ? o.settings : {}) };
    c.grants = o.grants | 0;
    if (o.scenario && typeof o.scenario === 'object' && typeof o.scenario.id === 'string') c.scenario = JSON.parse(JSON.stringify(o.scenario));
    if (o.facilities && typeof o.facilities === 'object') {
      for (const id of FACILITY_IDS) {
        const lv = o.facilities[id];
        if (Number.isFinite(lv)) c.facilities[id] = Math.min(FACILITY_MAX, Math.max(c.facilities[id], Math.floor(lv)));
      }
    }
    c.contracts = ContractBoard.fromJSON(o.contracts, c);
    if (!o.contracts || typeof o.contracts !== 'object') c.contracts.seed = (c.contracts.seed ^ Math.imul((c.ut | 0) + 1, 2654435761) ^ c.roster.length) >>> 0;
    c.contracts.refresh();
    return c;
  }

  // Returns true if written. Never throws (quota / missing storage → false).
  save(storage = defaultStorage()) {
    if (!storage) return false;
    // a scenario game never writes over the player's own program
    try { storage.setItem(this.scenario ? SCENARIO_SAVE_KEY : SAVE_KEY, JSON.stringify(this.toJSON())); return true; } catch { return false; }
  }

  // Returns a Career, or null when there is no readable save. NEVER throws. A save that exists but cannot be read
  // is copied to BACKUP_KEY (so it can be rescued or exported by hand) and removed from SAVE_KEY.
  static load(storage = defaultStorage()) {
    if (!storage) return null;
    let raw = null;
    try { raw = storage.getItem(SAVE_KEY); } catch { return null; }
    if (!raw) return null;
    try {
      return Career.fromJSON(JSON.parse(raw));
    } catch {
      try { storage.setItem(BACKUP_KEY, String(raw)); storage.removeItem(SAVE_KEY); } catch { /* storage is read-only or full */ }
      return null;
    }
  }

  /** The unreadable save parked by load(), as raw text, or null. */
  static corruptBackup(storage = defaultStorage()) {
    if (!storage) return null;
    try { return storage.getItem(BACKUP_KEY) || null; } catch { return null; }
  }

  /** The whole program as a JSON document for a save file. */
  exportSave() {
    return JSON.stringify({ game: 'starwright', format: 'save', exportedVersion: SAVE_VERSION, save: this.toJSON() }, null, 1);
  }

  /** Read a save file's text (an export, or a bare save object). → {ok: true, career} | {ok: false, error}. Never throws. */
  static importSave(text) {
    let data;
    try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch { return { ok: false, error: 'This file is not valid JSON.' }; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'This file does not contain a Starwright save.' };
    const save = data.game === 'starwright' && data.save && typeof data.save === 'object' ? data.save : data;
    if (!MODES.includes(save.mode) || !Array.isArray(save.tech) || !Array.isArray(save.roster)) return { ok: false, error: 'This file does not contain a Starwright save.' };
    if (Number.isFinite(save.version) && save.version > SAVE_VERSION) return { ok: false, error: 'This save comes from a newer version of Starwright.' };
    try { return { ok: true, career: Career.fromJSON(save) }; } catch (err) { return { ok: false, error: 'The save could not be read (' + (err && err.message) + ').' }; }
  }

  static hasSave(storage = defaultStorage()) {
    if (!storage) return false;
    try { return !!storage.getItem(SAVE_KEY); } catch { return false; }
  }

  static deleteSave(storage = defaultStorage()) {
    if (!storage) return false;
    try { storage.removeItem(SAVE_KEY); return true; } catch { return false; }
  }

  // ---- money ----
  get usesFunds() { return this.mode === 'career'; }
  get usesScience() { return this.mode !== 'sandbox'; }

  canAfford(cost) { return !this.usesFunds || this.funds >= (Number(cost) || 0); }

  // Deducts funds (career mode only). Returns false, changing nothing, if it cannot be afforded.
  spend(cost) {
    if (!this.usesFunds) return true;
    const c = Number(cost) || 0;
    if (this.funds < c) return false;
    this.funds -= c;
    return true;
  }

  earn(funds = 0, science = 0, rep = 0) {
    if (this.usesFunds) this.funds += Number(funds) || 0;
    this.science = round2(this.science + (Number(science) || 0));
    this.reputation += Number(rep) || 0;
  }

  launchCost(craft) { return launchCost(craft); }
  recoveryValue(partsCost, distanceFromPadMeters = 0) { return recoveryValue(partsCost, distanceFromPadMeters); }

  // Charge for a launch. → {ok, cost}
  payLaunch(craft) {
    const cost = launchCost(craft);
    return { ok: this.spend(cost), cost };
  }

  // Pay out a recovery. → funds credited (the value is returned in every mode, but only career banks it).
  // `crew` (names aboard) is optional; when omitted, the crew of the vessel whose `recovered` event was just seen is
  // used. A starred pilot counts as a landing nearer the pad, a starred engineer saves a little more of the hardware.
  creditRecovery(partsCost, distanceFromPadMeters = 0, crew) {
    const names = this._crewFor(crew);
    const pilot = this.bestStars(names, 'pilot'), engineer = this.bestStars(names, 'engineer');
    const d = Number.isFinite(distanceFromPadMeters) ? distanceFromPadMeters * Math.max(0, 1 - PILOT_BONUS * pilot) : distanceFromPadMeters;
    const cost = Math.max(Number(partsCost) || 0, 0);
    const v = Math.min(Math.round(recoveryValue(cost, d) * (1 + ENGINEER_BONUS * engineer)), Math.round(cost));
    if (this.usesFunds) this.funds += v;
    return v;
  }

  // ---- safety net ----
  /** Cost of the cheapest thing that can fly with the unlocked parts: a command part, something to push it, and a parachute for crews. */
  cheapestRocketCost() {
    const parts = PART_LIST.filter(p => this.isPartUnlocked(p.id));
    const min = list => list.reduce((m, p) => Math.min(m, p.cost), Infinity);
    const solid = min(parts.filter(p => p.engine && p.engine.type === 'solid'));
    const liquid = min(parts.filter(p => p.engine && p.engine.type === 'liquid')) + min(parts.filter(p => p.res && p.res.fuel > 0));
    const push = Math.min(solid, liquid);
    const chute = min(parts.filter(p => p.chute));
    const crewed = min(parts.filter(p => p.command === 'crew')) + (Number.isFinite(chute) ? chute : 0);
    const probe = min(parts.filter(p => p.command === 'probe'));
    const total = Math.min(crewed, probe) + push;
    return Number.isFinite(total) ? total : 0;
  }

  /** Vessels the player could still fly or recover in the saved flight (ships and Pips on EVA, not debris or flags). */
  flightsInProgress() {
    const vs = this.flightState && Array.isArray(this.flightState.vessels) ? this.flightState.vessels : [];
    return vs.filter(v => v && (v.type === 'ship' || v.type === 'eva' || v.type == null)).length;
  }

  /**
   * The program grant: offered whenever a career cannot pay for even the cheapest rocket and has nothing in flight.
   * Taking it lifts the funds back over the line, so it is offered once per occurrence. → {amount, repCost, need} | null
   */
  grantOffer() {
    if (!this.usesFunds) return null;
    const need = this.cheapestRocketCost();
    if (this.funds >= need || this.flightsInProgress() > 0) return null;
    return { amount: Math.max(GRANT_FUNDS, Math.ceil(need * 3 / 500) * 500), repCost: GRANT_REP_COST, need };
  }

  /** → {ok, amount, repCost} | {ok: false} */
  acceptGrant() {
    const g = this.grantOffer();
    if (!g) return { ok: false };
    this.funds += g.amount;
    this.reputation -= g.repCost;
    this.grants++;
    return { ok: true, ...g };
  }

  // ---- facilities ----
  facilityLevel(id) { return FACILITIES[id] ? (this.facilities[id] || 1) : 0; }
  /** Current value of a facility's limit (e.g. limitOf('pad') → tonnes the pad bears). */
  // Outside career mode there are no limits at all (and no research bonus).
  limitOf(id) {
    const f = FACILITIES[id];
    if (!f) return undefined;
    if (!this.usesFunds) return id === 'lab' ? 0 : id === 'tracking' ? f.values[FACILITY_MAX - 1] : Infinity;
    return f.values[this.facilityLevel(id) - 1];
  }
  /** All limits by name: {maxMass, maxParts, maxRunwayMass, commRange, scienceBonus, maxCrew}. */
  facilityLimits() { const out = {}; for (const id of FACILITY_IDS) out[FACILITIES[id].limit] = this.limitOf(id); return out; }
  /** → {level, max, cost (of the next level, or null at the top), value, next (value after upgrading, or null)} */
  facilityInfo(id) {
    const f = FACILITIES[id];
    if (!f) return null;
    const level = this.facilityLevel(id), top = level >= FACILITY_MAX;
    return { id, name: f.name, desc: f.desc, level, max: FACILITY_MAX, cost: top ? null : f.costs[level], value: f.values[level - 1],
      next: top ? null : f.values[level], unit: f.unit, limit: f.limit };
  }
  /** → {ok, reason?: 'unknown' | 'max' | 'funds', cost?, level?} */
  upgradeFacility(id) {
    const info = this.facilityInfo(id);
    if (!info) return { ok: false, reason: 'unknown' };
    if (info.cost === null) return { ok: false, reason: 'max' };
    if (!this.spend(info.cost)) return { ok: false, reason: 'funds', cost: info.cost };
    this.facilities[id] = info.level + 1;
    return { ok: true, cost: info.cost, level: this.facilities[id] };
  }
  /**
   * May this craft be launched from `site` ('pad' | 'runway')? Checks the facility limits only (not funds).
   * → {ok, reason?: 'mass' | 'parts', limit?, value?}
   */
  checkLaunch(craft, site = 'pad') {
    if (!craft) return { ok: false, reason: 'craft' };
    let mass = null, parts = null;
    try {
      const st = typeof craft.stats === 'function' ? craft.stats() : null;
      // tonnes: a Craft reports mass() in kg, a plain summary may carry {mass} in kg too
      const kg = typeof craft.mass === 'function' ? craft.mass() : (st && Number.isFinite(st.mass) ? st.mass : craft.mass);
      mass = Number.isFinite(kg) ? kg / 1000 : null;
      parts = craft.parts instanceof Map ? craft.parts.size : (Array.isArray(craft.parts) ? craft.parts.length : null);
    } catch { /* an unreadable design is the builder's problem, not the pad's */ }
    const maxParts = this.limitOf('hangar'), maxMass = this.limitOf(site === 'runway' ? 'runway' : 'pad');
    if (parts !== null && parts > maxParts) return { ok: false, reason: 'parts', limit: maxParts, value: parts };
    if (mass !== null && mass > maxMass) return { ok: false, reason: 'mass', limit: maxMass, value: mass };
    return { ok: true };
  }

  // ---- tech ----
  isPartUnlocked(partId) {
    const def = PARTS[partId];
    if (!def) return false;
    return this.mode === 'sandbox' || this.tech.has(def.tech);
  }

  unlockedParts() { return PART_LIST.filter(p => this.isPartUnlocked(p.id)).map(p => p.id); }

  // → {ok, reason}: reason is 'unknown' | 'owned' | 'prereq' | 'science' when not ok.
  canUnlockTech(nodeId) {
    const node = TECH_BY_ID[nodeId];
    if (!node) return { ok: false, reason: 'unknown' };
    if (this.tech.has(nodeId)) return { ok: false, reason: 'owned' };
    if (!node.requires.every(r => this.tech.has(r))) return { ok: false, reason: 'prereq' };
    if (this.usesScience && this.science < node.cost) return { ok: false, reason: 'science' };
    return { ok: true, reason: null };
  }

  unlockTech(nodeId) {
    const res = this.canUnlockTech(nodeId);
    if (!res.ok) return res;
    if (this.usesScience) this.science = round2(this.science - TECH_BY_ID[nodeId].cost);
    this.tech.add(nodeId);
    return res;
  }

  // 'owned' | 'available' (prerequisites met) | 'locked'
  techState(nodeId) {
    const node = TECH_BY_ID[nodeId];
    if (!node) return 'locked';
    if (this.tech.has(nodeId)) return 'owned';
    return node.requires.every(r => this.tech.has(r)) ? 'available' : 'locked';
  }

  // ---- crew ----
  _pip(name) { return this.roster.find(c => c.name === name) || null; }
  availableCrew() { return this.roster.filter(c => c.status === 'available'); }
  activeRoster() { return this.roster.filter(c => c.status !== 'lost'); }
  hireCost() { return 1500 + 500 * this.activeRoster().length; }

  // → {ok, cost, pip?, reason?}. `rng` is injectable for deterministic tests.
  hire(rng = Math.random) {
    const cost = this.hireCost();
    if (this.activeRoster().length >= this.limitOf('crew')) return { ok: false, cost, reason: 'quarters' };
    if (!this.canAfford(cost)) return { ok: false, cost, reason: 'funds' };
    const used = new Set(this.roster.map(c => c.name));
    let free = NAME_POOL.filter(n => !used.has(n));
    for (let i = 0; !free.length && i < SUFFIXES.length; i++) {
      free = NAME_POOL.map(n => `${n} ${SUFFIXES[i]}`).filter(n => !used.has(n));
    }
    if (!free.length) return { ok: false, cost, reason: 'full' };
    const pick = arr => arr[Math.min(Math.floor(rng() * arr.length), arr.length - 1)];
    const pip = newPip(pick(free), pick(TRAITS));
    this.spend(cost);
    this.roster.push(pip);
    return { ok: true, cost, pip };
  }

  setCrewStatus(name, status) {
    const p = this._pip(name);
    if (!p || p.status === 'lost') return false;
    p.status = status;
    return true;
  }

  // Put available Pips on a flight. → names actually assigned.
  assignCrew(names = []) {
    const out = [];
    for (const n of names) {
      const p = this._pip(n);
      if (p && p.status === 'available') { p.status = 'assigned'; out.push(n); }
    }
    return out;
  }

  // Bring Pips home (recovery): status back to 'available', flight count +1. → names returned.
  returnCrew(names = []) {
    const out = [];
    for (const n of names) {
      const p = this._pip(n);
      if (p && (p.status === 'assigned' || p.status === 'away')) { p.status = 'available'; p.flights++; out.push(n); }
    }
    return out;
  }

  // Stand a flight down without it counting (e.g. revert to builder). → names released.
  releaseCrew(names = []) {
    const out = [];
    for (const n of names) {
      const p = this._pip(n);
      if (p && (p.status === 'assigned' || p.status === 'away')) { p.status = 'available'; out.push(n); }
    }
    return out;
  }

  // `info` = {where: bodyId, vessel: vessel name} is kept for the memorial wall.
  loseCrew(name, info = {}) {
    const p = this._pip(name);
    if (!p || p.status === 'lost') return false;
    p.status = 'lost';
    p.lostAt = this.ut;
    p.lostWhere = info.where ?? null;
    p.lostVessel = info.vessel ?? null;
    this.reputation -= 5;
    return true;
  }

  /** The memorial wall: lost Pips, most recent first. */
  memorial() { return this.roster.filter(c => c.status === 'lost').sort((a, b) => (b.lostAt || 0) - (a.lostAt || 0)); }

  stars(name) { return pipStars(this._pip(name)); }

  /** Highest star count among the named Pips (optionally only those with a given trait). */
  bestStars(names = [], trait = null) {
    let best = 0;
    for (const n of names || []) {
      const p = this._pip(n);
      if (p && p.status !== 'lost' && (!trait || p.trait === trait)) best = Math.max(best, pipStars(p));
    }
    return best;
  }

  _crewFor(crew) {
    if (Array.isArray(crew)) return crew;
    return this._bonusCrew && this._bonusCrew.ut === this.ut ? this._bonusCrew.names : [];
  }

  /** Give Pips experience for a flight (from its flight-log entry). → [{name, xp, stars, gained, promoted}] */
  awardExperience(names = [], log = null) {
    const { xp, deeds } = flightExperience(log);
    const out = [];
    for (const n of names || []) {
      const p = this._pip(n);
      if (!p || p.status === 'lost') continue;
      const before = pipStars(p);
      // repeat visits teach less: a deed already on the Pip's record is worth a single point
      let gained = 1;
      if (log && log.reachedSpace) gained += p.deeds.includes('space') ? 0 : 1;
      for (const d of deeds) if (d !== 'space') gained += p.deeds.includes(d) ? 1 : (d.startsWith('orbit:') ? 2 : d.startsWith('visit:') ? 3 : 5);
      gained = Math.min(gained, xp);
      p.xp = (p.xp || 0) + gained;
      for (const d of deeds) if (!p.deeds.includes(d)) p.deeds.push(d);
      out.push({ name: n, xp: p.xp, stars: pipStars(p), gained, promoted: pipStars(p) > before });
    }
    return out;
  }

  /** Rename a Pip who is on the ground. → {ok, reason?: 'unknown'|'busy'|'empty'|'long'|'taken'} */
  renamePip(name, newName) {
    const p = this._pip(name);
    if (!p) return { ok: false, reason: 'unknown' };
    if (p.status !== 'available') return { ok: false, reason: 'busy' };
    const clean = String(newName ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return { ok: false, reason: 'empty' };
    if (clean.length > PIP_NAME_MAX) return { ok: false, reason: 'long' };
    if (clean === p.name) return { ok: true, name: clean };
    if (this.roster.some(c => c !== p && c.name.toLowerCase() === clean.toLowerCase())) return { ok: false, reason: 'taken' };
    p.name = clean;
    return { ok: true, name: clean };
  }

  /** Let a Pip go (only one who is on the ground, and never the last one). → {ok, reason?: 'unknown'|'busy'|'last'} */
  dismissPip(name) {
    const p = this._pip(name);
    if (!p || p.status === 'lost') return { ok: false, reason: 'unknown' };
    if (p.status !== 'available') return { ok: false, reason: 'busy' };
    if (this.activeRoster().length <= 1) return { ok: false, reason: 'last' };
    this.roster.splice(this.roster.indexOf(p), 1);
    return { ok: true };
  }

  // ---- science ----
  // `body` may be a body id or a Body object (its sciMult is used when present).
  // → {key, full, earned, remaining, next, valid}: `full` is the total pool for this key, `remaining` what is
  //   left of it (0 once exhausted) and `next` what one more run would earn at fraction 1.
  // `biome` (id, optional) selects the biome's own pool for results taken landed, splashed or flying low.
  scienceValue(experimentId, body, situation, biome = null) {
    const key = scienceKey(experimentId, body, situation, biome);
    const exp = EXPERIMENTS[experimentId];
    if (!exp || !exp.situations.includes(situation) || idOf(body) == null || !experimentAllowed(experimentId, SYSTEM.byId[idOf(body)] || body)) {
      return { key, full: 0, earned: 0, remaining: 0, next: 0, valid: false };
    }
    const homeGround = idOf(body) === HOME_BODY && (situation === 'landed' || situation === 'splashed');
    const bm = biome && BIOME_SITUATIONS.includes(situation) ? biomeSciMult(SYSTEM.byId[idOf(body)] || body, biome) : 1;
    const full = round2(exp.base * bodySciMult(body) * (SITUATION_MULT[situation] ?? 1) * (homeGround ? HOME_SURFACE_MULT : 1) * bm);
    const earned = this.scienceLog[key] || 0;
    let remaining = round2(Math.max(full - earned, 0));
    if (remaining < SCIENCE_MIN_REMAINING) remaining = 0;
    return { key, full, earned, remaining, next: round2(remaining * SCIENCE_REPEAT_FRACTION), valid: true };
  }

  // Bank an experiment result. `fraction` scales the payout (e.g. 0.5 when transmitted by antenna). → points earned.
  // `crew` (names aboard) is optional: the best scientist among them adds +10 % per star on top (the bonus does not
  // use up the result's pool). When omitted, the crew of the vessel whose `recovered` event was just seen is used.
  // `biome` and `bonus` are optional: the biome picks the pool (see scienceValue); `bonus` is an extra share on top
  // (a record processed in a lab carries bonus 0.5), which like the scientist bonus does not use up the pool.
  // The Research Wing facility adds its own share the same way.
  creditScience(experimentId, body, situation, fraction = 1, crew, biome = null, bonus = 0) {
    const v = this.scienceValue(experimentId, body, situation, biome);
    if (v.valid) this.contracts.noteScience(experimentId, idOf(body), situation);
    const f = Math.min(Math.max(Number(fraction) || 0, 0), 1);
    const points = round2(v.next * f);
    if (points <= 0) return 0;
    const extra = Math.max(Number(bonus) || 0, 0) + (this.usesFunds ? this.limitOf('lab') || 0 : 0);
    const total = round2(points * (1 + SCIENTIST_BONUS * this.bestStars(this._crewFor(crew), 'scientist') + extra));
    this.scienceLog[v.key] = round2(v.earned + points);
    this.science = round2(this.science + total);
    return total;
  }

  /** Value of a stored experiment record {experiment, bodyId, situation, biome?} (see scienceValue). */
  recordValue(rec) { return this.scienceValue(rec.experiment, rec.bodyId, rec.situation, rec.biome ?? null); }
  /** Bank a stored experiment record, with its biome and any lab bonus. → points earned. */
  creditRecord(rec, fraction = 1, crew) {
    if (!rec) return 0;
    return this.creditScience(rec.experiment, rec.bodyId, rec.situation, fraction, crew, rec.biome ?? null, rec.bonus || 0);
  }

  // ---- saved designs ----
  saveCraft(craftJSON) {
    const json = craftJSON && typeof craftJSON.toJSON === 'function' ? craftJSON.toJSON() : craftJSON;
    if (!json || !json.name) return false;
    this.crafts[json.name] = JSON.parse(JSON.stringify(json));
    return true;
  }
  deleteCraft(name) {
    if (!(name in this.crafts)) return false;
    delete this.crafts[name];
    return true;
  }
  getCraft(name) { return this.crafts[name] ?? null; }
  listCrafts() { return Object.keys(this.crafts).sort((a, b) => a.localeCompare(b)).map(n => this.crafts[n]); }

  // ---- milestones ----
  isMilestoneDone(id) { return this.milestones.has(id); }

  // ---- the flight program (the fixed chain of milestone missions; tracked in every mode) ----
  /** What a program step pays in this game mode: { funds, science, rep } (zero where the mode has no use for it). */
  programRewards(step) {
    const s = typeof step === 'string' ? PROGRAM_BY_ID[step] : step;
    if (!s) return { funds: 0, science: 0, rep: 0 };
    return { funds: this.mode === 'career' ? s.funds : 0, science: this.mode !== 'sandbox' ? s.science : 0, rep: this.mode === 'career' ? s.rep : 0 };
  }
  /** → { steps: [{...step, done}], next: step | null, done: n, total: n, chapter: name of the next step's chapter } */
  programStatus() {
    const steps = PROGRAM.map(s => ({ ...s, done: this.milestones.has(s.id) }));
    const next = steps.find(s => !s.done) || null;
    return { steps, next, done: steps.filter(s => s.done).length, total: steps.length, chapter: next ? next.chapter : null };
  }
  /** The next unfinished program step, or null when the whole chain is flown. */
  nextProgramStep() { return PROGRAM.find(s => !this.milestones.has(s.id)) || null; }

  // Complete a milestone by id and apply its rewards. → the award record, or null if unknown / already done.
  completeMilestone(id) {
    const m = MILESTONE_BY_ID[id];
    if (!m || this.milestones.has(id)) return null;
    this.milestones.add(id);
    this.earn(m.funds, m.science, m.rep);
    return { milestoneId: m.id, id: m.id, title: m.title, desc: m.desc, funds: m.funds, science: m.science, rep: m.rep };
  }

  _log(vessel) {
    const id = String(vessel.id ?? vessel.name ?? '?');
    const log = this.flightLog[id] || (this.flightLog[id] = { reachedSpace: false, landedOn: [], visited: [], orbited: [] });
    if (!Array.isArray(log.orbited)) log.orbited = [];
    return log;
  }

  // Feed a World event (or the flight screen's periodic `tick {vessel}`).
  // → newly completed milestones [{milestoneId, title, funds, science, rep}] followed by contract notices in the same
  //   shape with kind:'contract' and outcome 'completed' | 'failed' | 'objective' (see js/core/contracts.js).
  onEvent(type, payload, world) {
    const p = payload || {};
    const vessel = p.vessel || (type === 'tick' || type === 'liftoff' ? world?.active : null) || null;
    if (world && Number.isFinite(world.ut)) this.ut = world.ut;
    if (type === 'recovered' || type === 'destroyed') {
      // contracts and experience read the flight log, so they go first; then the log entry is dropped
      let notices = [];
      const key = vessel ? String(vessel.id ?? vessel.name ?? '?') : null;
      if (type === 'recovered' && vessel) {
        const names = (p.summary && Array.isArray(p.summary.crew)) ? p.summary.crew : crewOf(vessel);
        this._bonusCrew = { names: [...names], ut: this.ut };
        this.awardExperience(names, this.flightLog[key] || null);
      }
      try { notices = this.contracts.onEvent(type, p, world, vessel); } catch { notices = []; }
      if (key) delete this.flightLog[key];
      return notices;
    }
    const done = this._milestoneEvent(type, p, world, vessel);
    let notices = [];
    try { notices = this.contracts.onEvent(type, p, world, vessel); } catch { notices = []; }
    return notices.length ? done.concat(notices) : done;
  }

  _milestoneEvent(type, p, world, vessel) {
    const done = [];
    const give = id => { const r = id && this.completeMilestone(id); if (r) done.push(r); };

    switch (type) {
      case 'liftoff':
        give('first_launch');
        break;
      case 'soi': {
        if (vessel && !this._tracked(vessel)) break;
        const to = p.to;
        give(FLYBY_MS[idOf(to)]);
        if (outsideHomeSystem(to)) give('escape_verda');
        if (vessel && idOf(to)) { const log = this._log(vessel); if (!log.visited.includes(idOf(to))) log.visited.push(idOf(to)); }
        break;
      }
      case 'situation':
        if (vessel && this._tracked(vessel) && p.to === 'orbit') { give(ORBIT_MS[idOf(vessel.body)]); this._noteOrbit(vessel); }
        break;
      case 'landed':
      case 'splashed':
        if (vessel && this._tracked(vessel)) this._noteLanding(vessel, give, true);
        break;
      case 'eva': {
        const ev = p.eva || p.pip || vessel;
        if (ev && situationOf(ev).startsWith('space')) give('eva_space');
        break;
      }
      case 'flag':
      case 'flagPlanted':
      case 'plantFlag': {
        const body = p.body ?? p.flag?.body ?? p.flag?.bodyId ?? vessel?.body;
        give(FLAG_MS[idOf(body)]);
        break;
      }
      case 'crewLost':
        if (p.name) this.loseCrew(p.name, { where: idOf(vessel && vessel.body), vessel: vessel && vessel.type !== 'eva' ? vessel.name : null });
        break;
      default: break;
    }

    if (vessel && this._tracked(vessel) && type !== 'landed' && type !== 'splashed') this._poll(vessel, give);
    if (world) this._checkFlags(world, give);
    return done;
  }

  _tracked(vessel) { return vessel.type !== 'debris' && vessel.type !== 'flag'; }

  _noteOrbit(vessel) {
    const bodyId = idOf(vessel.body);
    if (!bodyId || vessel.type === 'eva') return;
    const log = this._log(vessel);
    if (!log.orbited.includes(bodyId)) log.orbited.push(bodyId);
  }

  // Condition polling shared by `tick` and the other vessel events.
  _poll(vessel, give) {
    const log = this._log(vessel);
    const bodyId = idOf(vessel.body);
    const grounded = !!(vessel.landed || vessel.splashed) || ['prelaunch', 'landed', 'splashed'].includes(vessel.situation);
    if (grounded) {
      if (vessel.situation !== 'prelaunch') this._noteLanding(vessel, give, false);
      return;
    }
    if (!bodyId) return;
    const sit = situationOf(vessel);
    if (bodyId === HOME_BODY && vessel.type !== 'eva') give('first_launch');
    if (bodyId === HOME_BODY && vesselAltitude(vessel) >= 10000) give('alt_10km');
    if (sit === 'spaceLow' || sit === 'spaceHigh') {
      log.reachedSpace = true;
      give('reach_space');
      if (vessel.type === 'eva') give('eva_space');
    }
    if (vessel.situation === 'orbit') { give(ORBIT_MS[bodyId]); this._noteOrbit(vessel); }
    if (!log.visited.includes(bodyId)) log.visited.push(bodyId);
    give(FLYBY_MS[bodyId]);
    if (outsideHomeSystem(vessel.body)) give('escape_verda');
  }

  // `fromEvent` is true for a real touchdown event; polled landings only count once the vessel has left the pad
  // area in some way (reached space or stood on another body), so sitting on the launch pad never pays out.
  _noteLanding(vessel, give, fromEvent) {
    const bodyId = idOf(vessel.body);
    if (!bodyId || vessel.situation === 'prelaunch') return;
    const log = this._log(vessel);
    if (bodyId !== HOME_BODY) {
      if (!log.landedOn.includes(bodyId)) log.landedOn.push(bodyId);
      if (!log.visited.includes(bodyId)) log.visited.push(bodyId);
      log.reachedSpace = true;
      give(FLYBY_MS[bodyId]);
      if (outsideHomeSystem(vessel.body)) give('escape_verda');
      give(LAND_MS[bodyId]);
      return;
    }
    if (vessel.type === 'eva') return;          // a Pip on foot is not a returning vessel
    if (log.reachedSpace && crewOf(vessel).length > 0) give('crew_return');
    for (const b of log.landedOn) if (b !== HOME_BODY) give(RETURN_MS[b]);
    if (fromEvent && !log.landedOn.includes(bodyId)) log.landedOn.push(bodyId);
  }

  _checkFlags(world, give) {
    const flags = Array.isArray(world.flags) ? world.flags : [];
    if (flags.length === this._flagsSeen) return;
    this._flagsSeen = flags.length;
    for (const f of flags) if (f) give(FLAG_MS[idOf(f.body ?? f.bodyId)]);
    const vs = Array.isArray(world.vessels) ? world.vessels : [];
    for (const v of vs) if (v && v.type === 'flag') give(FLAG_MS[idOf(v.body)]);
  }
}
